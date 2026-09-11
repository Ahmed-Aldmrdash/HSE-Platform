// ============================================================
// Work Permits App — Production-Ready Server
// OWASP-Compliant Security: bcrypt + JWT + RBAC + Write Queue
// ============================================================
'use strict';

require('dotenv').config();

const express    = require('express');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const ExcelJS    = require('exceljs');
const { Document: DocxDocument, Packer: DocxPacker, Paragraph: DocxParagraph, TextRun: DocxTextRun, AlignmentType: DocxAlign } = require('docx');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const webpush    = require('web-push');
const compression = require('compression');
const { parsePermitsWorkbook } = require('./lib/permits-excel-parser');
const { db: sqliteDb, makeStore, exportAll: dbExportAll, importAll: dbImportAll, DB_PATH } = require('./lib/db');
const { migrateJsonToDb, sweepOrphanJsonFiles } = require('./lib/migrate-json-to-db');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { prepareBidiText } = require('./lib/pdf-arabic');

const app  = express();

// ============================================================
// 🛑 CRASH SAFETY NET — منع سقوط السيرفر بالكامل بسبب خطأ في طلب واحد
// ============================================================
// THIS IS THE FIX FOR THE SERVER "CUTTING OFF" (بيقطع).
//
// Root cause found: ~40 of the async route handlers in this file run
// their logic inside enqueueWrite(async () => { ... result = {...}; }).
// enqueueWrite() deliberately swallows any error thrown inside that
// callback (so one bad write can't permanently jam the write queue for
// everyone) — but if the error happens *before* `result` gets assigned,
// the route handler still runs `res.status(result.status)...` right
// after, and `result` is `undefined`. That throws a brand-new error
// (`Cannot read properties of undefined`) — this time with nothing
// catching it. In Node 22 (installed on this machine), an uncaught
// exception or unhandled promise rejection kills the ENTIRE process by
// default. That's why one weird/malformed request could take the whole
// site down for every user at once, and why it needed a manual
// `npm start` to come back up each time.
//
// Two layers now defend against this:
//  1) Every `res.status(result.status)...` call site was made defensive
//     (falls back to a normal 500 JSON error instead of crashing if
//     `result` is missing) — this fixes the specific pattern above.
//  2) This process-level safety net below is the general backstop: if
//     ANYTHING anywhere (a route we didn't think of, a third-party
//     library, a future bug) throws unexpectedly outside of Express's
//     own error handling, we log it and keep the server running instead
//     of letting Node kill the whole process. The one request that
//     triggered it may fail, but every other user stays connected.
//
// This is a pragmatic safety net, not a substitute for fixing bugs —
// every logged error here is a real bug worth investigating in
// server-error.log. A proper long-term fix is wrapping each async
// route handler in its own try/catch with a specific error response;
// this net just stops a single such bug from being a full outage in
// the meantime.
function logFatalError(kind, err) {
  const msg = `[${new Date().toISOString()}] ${kind}: ${err && err.stack ? err.stack : err}\n`;
  console.error(msg);
  try {
    fs.appendFileSync(path.join(__dirname, 'server-error.log'), msg);
  } catch (e) { /* best-effort logging only */ }
}
process.on('unhandledRejection', (err) => {
  logFatalError('UNHANDLED REJECTION', err);
});
process.on('uncaughtException', (err) => {
  logFatalError('UNCAUGHT EXCEPTION', err);
});

app.use(compression());
const PORT = process.env.PORT || 3000;

// ── Security Constants ────────────────────────────────────────
const JWT_SECRET    = process.env.JWT_SECRET;
const JWT_EXPIRES   = process.env.JWT_EXPIRES_IN || '30m';
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS, 10) || 12;

// Fail fast if JWT_SECRET is missing
if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET is not defined in .env — server refused to start.');
  process.exit(1);
}

// ── Paths ─────────────────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads', 'hazards');
const DATA_FILE = path.join(DATA_DIR, 'storage.json');
const HAZARDS_FILE = path.join(DATA_DIR, 'hazard-reports.json');
const EXCEL_FILE = path.join(DATA_DIR, 'permits_log.xlsx');
const HAZARDS_EXCEL_FILE = path.join(DATA_DIR, 'hazards_log.xlsx');
const EMPLOYEES_FILE = path.join(DATA_DIR, 'employees.json');
const EMPLOYEES_XLSX_INPUT = path.join(DATA_DIR, 'employees.xlsx');
const EMPLOYEES_EXCEL_EXPORT = path.join(DATA_DIR, 'employees_export.xlsx');

// ── Legacy department name aliases ───────────────────────────────
// Some department admin accounts were split off from a single older
// department after old hazard reports were already logged under the old
// name (e.g. "Maintenance" was later split into Electrical/Mechanical/
// Preventive Maintenance, and "IT" into IT Operations/IT Applications).
// Without this map, those old reports match no current admin's exact
// department string and silently disappear from that admin's hazard log.
// Every admin that descends from a legacy name sees that legacy name's
// old reports (we can't tell which specific sub-department they belong to).
const LEGACY_DEPARTMENT_ALIASES = {
  'Electrical Maintenance': ['Maintenance'],
  'Mechanical Maintenance': ['Maintenance'],
  'Preventive Maintenance': ['Maintenance'],
  'IT Operations': ['IT'],
  'IT Applications': ['IT'],
};

// ── Safe department comparison ───────────────────────────────────
// Department strings come from several sources (manual entry, Excel
// imports, employee directory) and can carry stray leading/trailing
// whitespace that a plain `===` will never match. A single invisible
// space on either side silently breaks permit routing to the department
// head with no visible error, so every routing/authorization check
// that compares two department strings MUST go through this helper
// instead of comparing the raw values directly.
function deptMatches(a, b) {
  const na = String(a || '').trim();
  const nb = String(b || '').trim();
  return na !== '' && na === nb;
}

const TRAINING_TOPICS_FILE = path.join(DATA_DIR, 'training-topics.json');
const TRAININGS_FILE = path.join(DATA_DIR, 'trainings.json');
const DRILLS_FILE = path.join(DATA_DIR, 'drills.json');
const PENALTIES_FILE = path.join(DATA_DIR, 'penalties.json');
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
const VAPID_KEYS_FILE = path.join(DATA_DIR, 'vapid.json');
// سجل تدقيق تاريخي (Append-only Audit Log) — كل عملية اعتماد/رفض/إغلاق على
// تصريح أو بلاغ تُضاف كسجل جديد هنا ولا تُحذف ولا تُعدَّل أبدًا (بعكس حقول
// rejectedBy/approvedBy التي تُكتب فوق نفسها على السجل الأصلي). هذا يوفّر أثرًا
// كاملاً غير قابل للمحو لمن وافق/رفض، متى، وماذا كانت الحالة السابقة — وهو
// أساسي لأي تدقيق امتثال حقيقي (ISO 45001 وما شابه). 11 سبتمبر 2026.
const AUDIT_LOG_FILE = path.join(DATA_DIR, 'audit-log.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ── Initial Training Topics (seeded into DB on first boot only) ──
const INITIAL_TOPICS = [
  "فصل وعزل الطاقة LOTO",
  "القيادة الامنة للفوركليفت",
  "مخاطر المواد الكيماوية",
  "المخاطر الكهربية",
  "مخاطر القطع واللحام",
  "سلامة الماكينات وحواجز الحماية",
  "مخاطر العمل علي ارتفاع",
  "الاسعافات الاولية",
  "مهمات الوقاية الشخصية PPE",
  "خطة الطوارئ والاخلاء",
  "مخاطر الاماكن المغلقة",
  "مكافحة الحرائق واستخدام الطفايات"
];

// ── Web Push Initialization ────────────────────────────────────
let vapidKeys = { publicKey: '', privateKey: '' };
if (fs.existsSync(VAPID_KEYS_FILE)) {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_KEYS_FILE, 'utf8'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_KEYS_FILE, JSON.stringify(vapidKeys, null, 2), 'utf8');
}
webpush.setVapidDetails(
  'mailto:admin@elsewedy.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// ============================================================
// 🗄️ DATABASE MIGRATION — من ملفات JSON إلى SQLite (مرة واحدة فقط)
// ============================================================
// كل بيانات التطبيق أصبحت مخزَّنة في data/app.db بدل ملفات JSON منفصلة.
// هذا الترحيل يعمل تلقائيًا عند أول إقلاع بعد هذا التحديث: يقرأ كل ملف
// JSON قديم موجود، ينسخ محتواه إلى القاعدة، وينقل الملف الأصلي (لا يحذفه)
// إلى data/_legacy_json_backup/ كنسخة أمان. في أي إقلاع لاحق لا يحدث شيء
// (كل مجموعة أصبح لها بيانات في القاعدة فتُتجاهَل ملفاتها). 11 سبتمبر 2026.
const DB_COLLECTIONS = [
  { file: 'storage.json',           name: 'storage',             isObject: true },
  { file: 'hazard-reports.json',    name: 'hazards' },
  { file: 'audit-log.json',         name: 'audit-log' },
  { file: 'penalties.json',         name: 'penalties' },
  { file: 'employees.json',         name: 'employees' },
  { file: 'training-topics.json',   name: 'training-topics' },
  { file: 'trainings.json',         name: 'trainings' },
  { file: 'drills.json',            name: 'drills' },
  { file: 'notifications.json',     name: 'notifications' },
  { file: 'push-subscriptions.json', name: 'subscriptions' },
  { file: 'inspection-sections.json', name: 'inspection-sections' },
  { file: 'inspection-items.json',    name: 'inspection-items' },
  { file: 'inspection-records.json',  name: 'inspection-records' },
];
migrateJsonToDb({ dataDir: DATA_DIR, db: sqliteDb, collections: DB_COLLECTIONS });
sweepOrphanJsonFiles({ dataDir: DATA_DIR, db: sqliteDb, excludeFiles: ['vapid.json'] });

// ── DB-backed collection stores ─────────────────────────────────
const storageStore           = makeStore('storage', {});
const hazardsStore           = makeStore('hazards', []);
const auditLogStore          = makeStore('audit-log', []);
const penaltiesStore         = makeStore('penalties', []);
const employeesStore         = makeStore('employees', []);
const trainingTopicsStore    = makeStore('training-topics', []);
const trainingsStore         = makeStore('trainings', []);
const drillsStore            = makeStore('drills', []);
const notificationsStore     = makeStore('notifications', []);
const subscriptionsStore     = makeStore('subscriptions', []);
const inspectionSectionsStore = makeStore('inspection-sections', []);
const inspectionItemsStore    = makeStore('inspection-items', []);
const inspectionRecordsStore  = makeStore('inspection-records', []);

// ── First-boot-only defaults (نفس منطق "أنشئ الملف لو مش موجود" القديم) ──
if (!trainingTopicsStore.exists()) trainingTopicsStore.write(INITIAL_TOPICS);

// ── Security Headers Middleware ───────────────────────────────
// Applied before all other routes. No external dependency needed.
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://cdn.jsdelivr.net; media-src 'self' data: blob:;"
  );
  next();
});

// ── SEO & AI Bots Endpoints ────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send("User-agent: *\nAllow: /\nDisallow: /api/\n");
});

app.get('/llms.txt', (req, res) => {
  res.type('text/plain');
  res.send("# Elsewedy Polymers Work Permits Platform\nAn enterprise HSE work permits management system.\n");
});

// ── Middleware ────────────────────────────────────────────────
// Tighter payload limit — workers submit text only; 2 MB is generous
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Rate Limiters ─────────────────────────────────────────────
/** Auth: max 10 login attempts per 15 min per IP */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تجاوزت عدد محاولات تسجيل الدخول. حاول مجدداً بعد 15 دقيقة.' }
});

/** Permit submission: max 30 new permits per 15 min per IP */
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تجاوزت الحد المسموح لتقديم الطلبات. حاول مجدداً بعد 15 دقيقة.' }
});

/** Employee registration: max 20 per 15 min per IP */
const employeeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تجاوزت عدد محاولات التسجيل. حاول مجدداً بعد 15 دقيقة.' }
});

/** Training Attendance: max 15 attempts per 15 min per IP */
const attendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تجاوزت عدد محاولات تسجيل الحضور. حاول مجدداً بعد 15 دقيقة.' }
});

// ── HTML Cache-Busting ─────────────────────────────────────────
// Ensure index.html is never cached so new JS/CSS versions are always fetched.
app.use((req, res, next) => {
  const p = req.path;
  if (p === '/' || p.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma',  'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

// ── PERF: conditional-GET support for polled JSON endpoints ────
// The frontend polls these endpoints every 3–10 seconds per open tab
// (work-permits, hazards, trainings, drills) but the underlying data
// usually hasn't changed between polls. We deliberately do NOT set
// no-store here (unlike the HTML rule above) — Express already sends
// a weak ETag on every res.json() response by default, so setting
// "no-cache" (which still forces revalidation, it just allows it to
// be conditional) lets the browser send If-None-Match automatically
// and get back a tiny 304 with no body instead of re-downloading and
// re-parsing the full payload, with zero frontend changes required.
const POLLED_GET_PREFIXES = [
  '/api/storage/',
  '/api/hazards',
  '/api/my-hazards/',
  '/api/trainings',
  '/api/drills',
];
app.use((req, res, next) => {
  if (req.method === 'GET' && POLLED_GET_PREFIXES.some(p => req.path.startsWith(p))) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
  next();
});

// Fallback routes for work-permits to prevent 404
app.get('/work-permits', (req, res) => {
  res.redirect('/api/storage/work-permits');
});
app.get('/api/work-permits', (req, res) => {
  res.redirect('/api/storage/work-permits');
});

// Serve frontend static files.
// PERF FIX: this used to force `no-store` on every static asset — including
// app.js (372KB) and style.css (88KB) — despite the comment above saying
// "long Max-Age". `no-store` means the browser can't cache these AT ALL, so
// every single page load (and every reload during normal use) re-downloaded
// both files in full, on top of everything else going on. That's a direct,
// user-visible slowdown that had nothing to do with the JSON-file issues.
// Fix: allow the browser to cache and conditionally revalidate JS/CSS (fast
// 304s when unchanged, since express.static already sends ETag/Last-Modified),
// and give rarely-changing assets (icons/manifest) a real cache lifetime.
// index.html itself is already forced to no-store by the middleware above,
// so a deploy is still picked up immediately — only the linked JS/CSS assets
// benefit from caching, and even those revalidate every time rather than
// being used blindly for a long period.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(?:js|css)$/i.test(filePath)) {
      res.set('Cache-Control', 'no-cache');
    } else if (/\.(?:png|jpg|jpeg|svg|webp|ico)$/i.test(filePath)) {
      res.set('Cache-Control', 'public, max-age=86400');
    } else {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    }
  }
}));


// ── SSE Client Registry ──────────────────────────────────────
// Must be declared before createNotification() which references it.
const sseClients = [];

// ============================================================
// 🔒 WRITE QUEUE — منع Race Conditions عند الكتابة المتزامنة
// ============================================================
let _writeQueue = Promise.resolve();

/**
 * يُضيف عملية كتابة لآخر القائمة ويضمن التسلسل.
 * جميع عمليات الكتابة على storage.json تمر عبر هذه الدالة.
 */
function enqueueWrite(fn) {
  _writeQueue = _writeQueue.then(fn).catch((err) => {
    console.error('[WriteQueue] Error:', err);
  });
  return _writeQueue;
}

function safeJsonParse(data, fallback = []) {
  try {
    if (!data) return fallback;
    const clean = data.toString().replace(/^\uFEFF/, '').trim();
    return clean ? JSON.parse(clean) : fallback;
  } catch (e) {
    return fallback;
  }
}

// ── PERF: mtime-based in-memory read cache ─────────────────────
// The frontend polls several endpoints every 3–10 seconds PER OPEN
// TAB (permits, hazards, trainings, drills...). Each poll used to
// re-read + re-parse the corresponding multi-MB JSON file from disk
// from scratch, every time, for every connected user. That disk I/O
// runs synchronously and blocks Node's single event loop, so it
// was stalling every other request on the server while it happened.
// This cache keeps the parsed data in memory and only touches disk
// again when the file's mtime actually changes (i.e. after a real
// write), so repeated polls between writes are essentially free.
const _readCache = new Map(); // filePath -> { mtimeMs, data }

function getCached(filePath) {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    const entry = _readCache.get(filePath);
    if (entry && entry.mtimeMs === mtimeMs) return entry.data;
  } catch (e) { /* fall through and let caller re-read from disk */ }
  return undefined;
}

function setCached(filePath, data) {
  try {
    const mtimeMs = fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : Date.now();
    _readCache.set(filePath, { mtimeMs, data });
  } catch (e) { /* non-fatal, cache is best-effort */ }
}

// ── PERF: debounced/decoupled Excel regeneration ────────────────
// permits_log.xlsx / hazards_log.xlsx are human-facing exports, not
// part of the live app data. The old code fully rebuilt the entire
// workbook (read whole file, clear all rows, re-add every single
// record, write whole file back to disk) INSIDE every single
// create/approve/reject/close/delete request, and made the HTTP
// response wait for it (`await syncExcelFromPermits(...)`). With
// thousands of records this could take a long time and froze the
// whole server (single-threaded event loop) for every user during
// that window — the "غريب" slowness that got worse as data grew.
// We now schedule the regen off the request path and coalesce any
// writes that happen within the debounce window into a single pass.
const EXCEL_SYNC_DEBOUNCE_MS = 8000;
let _permitsExcelPending = null;
let _permitsExcelTimer = null;
let _hazardsExcelPending = null;
let _hazardsExcelTimer = null;

function schedulePermitsExcelSync(permitsJsonString) {
  _permitsExcelPending = permitsJsonString;
  if (_permitsExcelTimer) return;
  _permitsExcelTimer = setTimeout(() => {
    const data = _permitsExcelPending;
    _permitsExcelPending = null;
    _permitsExcelTimer = null;
    syncExcelFromPermits(data).catch(e => console.error('Deferred permits excel sync failed:', e));
  }, EXCEL_SYNC_DEBOUNCE_MS);
  if (_permitsExcelTimer.unref) _permitsExcelTimer.unref();
}

function scheduleHazardsExcelSync(hazardsArray) {
  _hazardsExcelPending = hazardsArray;
  if (_hazardsExcelTimer) return;
  _hazardsExcelTimer = setTimeout(() => {
    const data = _hazardsExcelPending;
    _hazardsExcelPending = null;
    _hazardsExcelTimer = null;
    syncHazardsExcelFromData(data).catch(e => console.error('Deferred hazards excel sync failed:', e));
  }, EXCEL_SYNC_DEBOUNCE_MS);
  if (_hazardsExcelTimer.unref) _hazardsExcelTimer.unref();
}

// ── Storage Helpers (DB-backed — انظر lib/db.js) ─────────────────
function readStorage() {
  try {
    const data = storageStore.read();
    if (data['work-permits']) {
      if (typeof data['work-permits'] === 'string') {
        try {
          let permits = JSON.parse(data['work-permits']);
          if (Array.isArray(permits)) {
            permits.forEach(p => normalizePermitDeletedBy(p));
            data['work-permits'] = JSON.stringify(permits);
          }
        } catch (e) {
          console.error('Error migrating permits on load', e);
        }
      } else if (Array.isArray(data['work-permits'])) {
        data['work-permits'].forEach(p => normalizePermitDeletedBy(p));
        data['work-permits'] = JSON.stringify(data['work-permits']);
      }
    }
    return data;
  } catch (err) {
    console.error('Error reading storage:', err);
    return {};
  }
}

function getRoleKey(role) {
  if (role === 'dept_admin' || role === 'area_admin' || role === 'maint_admin') return 'areaAdmin';
  if (role === 'hse_admin' || role === 'safety_admin') return 'safetyAdmin';
  if (role === 'super_admin') return 'superAdmin';
  return 'worker';
}

function normalizePermitDeletedBy(permit) {
  const db = permit.deletedBy;
  permit.deletedBy = {
    areaAdmin: Boolean(db?.areaAdmin),
    safetyAdmin: Boolean(db?.safetyAdmin),
    superAdmin: Boolean(db?.superAdmin),
    worker: Boolean(db?.worker)
  };
  // Prevent legacy username strings from sticking around
  if (typeof db === 'string') {
    permit.lastDeletedByUsername = db;
  }
  // Fully delete the legacy top-level deleted boolean to prevent accidental matching
  delete permit.deleted;
}

function writeStorage(data) {
  return storageStore.write(data);
}

function readHazards() {
  return hazardsStore.read();
}

function writeHazards(data) {
  return hazardsStore.write(data);
}

// ── Audit Log Storage Helpers (Append-Only) ───────────────
function readAuditLog() {
  return auditLogStore.read();
}

function writeAuditLog(data) {
  return auditLogStore.write(data);
}

/**
 * logAuditEvent — يُضيف سجلاً جديدًا (لا يُعدَّل ولا يُحذف أبدًا) لعملية
 * اعتماد/رفض/إغلاق. يجب استدعاؤها من *داخل* enqueueWrite الخاص بالعملية نفسها
 * (وليس بشكل منفصل) حتى تبقى ضمن نفس طابور الكتابة التسلسلي وتُحافظ على
 * الترتيب الصحيح للأحداث. لا تُلقي أي استثناء أبدًا — فشل تسجيل التدقيق يجب
 * ألا يمنع تنفيذ العملية الأساسية نفسها.
 *
 * @param {object} p
 * @param {'permit'|'hazard'|'training'|'drill'} p.entityType
 * @param {string} p.entityId
 * @param {'approve'|'reject'|'close'|'force_close'|'restore'|'delete'} p.action
 * @param {object} p.actor  — عادة req.user (id, username, role, name, department)
 * @param {string} [p.previousStatus]
 * @param {string} [p.newStatus]
 * @param {string} [p.note]
 */
function logAuditEvent({ entityType, entityId, action, actor, previousStatus, newStatus, note }) {
  try {
    const log = readAuditLog();
    log.push({
      id: 'AUD-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
      entityType,
      entityId: String(entityId),
      action,
      actorId: actor && (actor.id || actor.username) || 'unknown',
      actorUsername: actor && actor.username || '',
      actorRole: actor && actor.role || '',
      actorName: actor && (actor.name || actor.fullName) || '',
      department: actor && actor.department || '',
      previousStatus: previousStatus || null,
      newStatus: newStatus || null,
      note: note || '',
      timestamp: new Date().toISOString()
    });
    writeAuditLog(log);
  } catch (err) {
    // لا نُفشل العملية الأساسية أبدًا بسبب خطأ في تسجيل التدقيق — نسجّله فقط.
    console.error('[AuditLog] Failed to record event:', err);
  }
}

// ── Penalties Storage Helpers ─────────────────────────────
function readPenalties() {
  return penaltiesStore.read();
}

function writePenalties(data) {
  return penaltiesStore.write(data);
}

// ── Employee Storage Helpers ──────────────────────────────

function normalizeEmpCode(code) {
  if (!code && code !== 0) return '';
  const str = String(code).trim();
  const stripped = str.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

function readEmployees() {
  return employeesStore.read();
}

function writeEmployees(data) {
  return employeesStore.write(data);
}

// ── Training Storage Helpers ──────────────────────────────

function readTrainingTopics() {
  return trainingTopicsStore.read();
}

function readTrainings() {
  return trainingsStore.read();
}

function readDrills() {
  return drillsStore.read();
}

function writeTrainings(data) {
  return trainingsStore.write(data);
}

function writeDrills(data) {
  return drillsStore.write(data);
}


// ── Notifications Storage Helpers ─────────────────────────────

function readNotifications() {
  return notificationsStore.read();
}

function writeNotifications(data) {
  return notificationsStore.write(data);
}

function readSubscriptions() {
  return subscriptionsStore.read();
}

function writeSubscriptions(data) {
  return subscriptionsStore.write(data);
}

// ── Monthly Inspection Storage Helpers (🦺 الفحص الشهري) ───────
function readInspectionSections() { return inspectionSectionsStore.read(); }
function writeInspectionSections(data) { return inspectionSectionsStore.write(data); }
function readInspectionItems() { return inspectionItemsStore.read(); }
function writeInspectionItems(data) { return inspectionItemsStore.write(data); }
function readInspectionRecords() { return inspectionRecordsStore.read(); }
function writeInspectionRecords(data) { return inspectionRecordsStore.write(data); }

/**
 * Creates a notification and appends it to the storage safely using enqueueWrite.
 * @param {Object} options - { targetRole, targetEmpCode, targetGroup, type, title, message, link }
 */
function createNotification({ targetRole, targetEmpCode, targetGroup, type, title, message, link, targetId }) {
  enqueueWrite(async () => {
    const notifications = readNotifications();
    const newNotif = {
      id: `NT-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      targetRole: targetRole || null,
      targetEmpCode: targetEmpCode ? normalizeEmpCode(targetEmpCode) : null,
      targetGroup: targetGroup || null,
      type: type || 'system',
      title: sanitizeStr(title, 200),
      message: sanitizeStr(message, 1000),
      link: link || '',
      targetId: targetId || null,
      readBy: [],
      createdAt: new Date().toISOString()
    };
    notifications.push(newNotif);
    
    // Keep only the last 1000 notifications to prevent file bloat
    if (notifications.length > 1000) {
      notifications.splice(0, notifications.length - 1000);
    }
    
    writeNotifications(notifications);
    
    // Trigger Web Push Notification
    const subscriptions = readSubscriptions();
    const payload = JSON.stringify({
      title: newNotif.title,
      body: newNotif.message,
      link: newNotif.link,
      targetId: newNotif.targetId,
      type: newNotif.type
    });
    
    let validSubscriptions = [];
    let subscriptionsChanged = false;
    
    const sendPromises = subscriptions.map(sub => {
      let shouldSend = false;
      if (newNotif.targetRole === 'all') shouldSend = true;
      if (newNotif.targetEmpCode && sub.empCode && normalizeEmpCode(newNotif.targetEmpCode) === normalizeEmpCode(sub.empCode)) shouldSend = true;
      if (newNotif.targetRole && sub.role) {
        if (newNotif.targetRole === 'admin' && ['superadmin', 'admin', 'supervisor', 'area_head'].includes(sub.role)) shouldSend = true;
        if (newNotif.targetRole === sub.role) shouldSend = true;
        if (newNotif.targetRole === 'dept_admin' && sub.role === 'maint_admin') shouldSend = true;
        if (newNotif.targetRole === 'maint_admin' && sub.role === 'dept_admin') shouldSend = true;
      }
      
      if (shouldSend) {
        return webpush.sendNotification(sub.subscription, payload).then(() => {
          validSubscriptions.push(sub);
        }).catch(err => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            // Subscription expired
            console.log('Subscription expired, removing', sub.endpoint);
            subscriptionsChanged = true;
          } else {
            console.error('Error sending web push:', err);
            validSubscriptions.push(sub);
          }
        });
      } else {
        validSubscriptions.push(sub);
        return Promise.resolve();
      }
    });
    
    Promise.all(sendPromises).then(() => {
      if (subscriptionsChanged) {
        writeSubscriptions(validSubscriptions);
      }
    });
    
    // Broadcast via Server-Sent Events
    sseClients.forEach(client => {
      let shouldSend = false;
      if (newNotif.targetRole === 'all') shouldSend = true;
      if (newNotif.targetEmpCode && client.empCode && normalizeEmpCode(newNotif.targetEmpCode) === normalizeEmpCode(client.empCode)) shouldSend = true;
      if (newNotif.targetRole && client.role) {
        if (newNotif.targetRole === 'admin' && ['superadmin', 'admin', 'supervisor', 'area_head'].includes(client.role)) shouldSend = true;
        if (newNotif.targetRole === client.role) shouldSend = true;
      }
      
      if (shouldSend) {
        try {
          client.res.write(`data: ${JSON.stringify(newNotif)}\n\n`);
        } catch (e) {
           // Client disconnected
        }
      }
    });

  });
}

/**
 * Maps a raw Excel row object (keyed by column header) to the employee schema.
 * Supports Arabic and English column names.
 */
function normalizeEmployeeRow(row) {
  // Extract cell value as clean string (handles rich-text objects from ExcelJS)
  const clean = (val) => {
    if (val === undefined || val === null) return '';
    // ExcelJS rich-text: { richText: [{text:'...'},...] }
    if (typeof val === 'object' && val.richText) {
      return val.richText.map(r => r.text || '').join('').trim();
    }
    return String(val).trim();
  };

  // Helper: try a list of keys in order (exact, then case-insensitive)
  const pick = (...keys) => {
    for (const k of keys) {
      const v = clean(row[k]);
      if (v) return v;
    }
    // case-insensitive fallback
    for (const k of keys) {
      const kl = k.toLowerCase();
      for (const rk of Object.keys(row)) {
        if (rk.trim().toLowerCase() === kl) {
          const v = clean(row[rk]);
          if (v) return v;
        }
      }
    }
    return '';
  };

  // ── Exact headers from the factory Excel file ──────────────
  const code = pick(
    'Employee Number', 'EmployeeNumber', 'employee number', 'employee_number',
    'الكود الوظيفي', 'الكود', 'كود', 'كود الموظف', 'الرقم الوظيفي', 'رقم القيد',
    'code', 'Code', 'empCode', 'id', 'ID', 'emp_id', 'EMP_CODE'
  );

  if (!code) return null;

  const name = pick(
    'Arabic Name', 'ArabicName', 'arabic name', 'arabic_name',
    'الاسم الكامل', 'الاسم', 'اسم الموظف', 'اسم العامل', 'الاسم ثلاثي',
    'name', 'Name', 'full name', 'Full Name', 'employee name'
  );

  const department = pick(
    'Organization Description', 'OrganizationDescription', 'organization description', 'organization_description',
    'القسم', 'الإدارة', 'الادارة', 'القطاع', 'مكان العمل',
    'department', 'Department', 'dept', 'sector'
  );

  const jobTitle = pick(
    'Position', 'position', 'job title', 'Job Title', 'jobtitle',
    'المسمى الوظيفي', 'الوظيفة', 'المهنة', 'مسمى الوظيفة',
    'title', 'Title'
  );

  const rawRole = pick('الصلاحية', 'الدور', 'role', 'Role').toLowerCase();
  const validRoles = ['worker', 'supervisor', 'area_head', 'contractor'];

  return {
    empCode:    normalizeEmpCode(code),
    name:       name   || 'موظف',
    department: department || 'عام',
    jobTitle:   jobTitle   || '',
    role:       validRoles.includes(rawRole) ? rawRole : 'worker',
    phone:      pick(
      'رقم الهاتف', 'الهاتف', 'الموبايل', 'رقم التليفون',
      'phone', 'Phone', 'mobile', 'Mobile', 'tel'
    ),
  };
}

/** Parse an xlsx buffer using ExcelJS, returns array of normalized employee objects. */
async function parseEmployeesXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  // Helper: extract string from any ExcelJS cell value type
  const cellStr = (cell) => {
    if (!cell) return '';
    const v = cell.value;
    if (v === null || v === undefined) return '';
    if (typeof v === 'object' && v.richText) {
      return v.richText.map(r => r.text || '').join('').trim();
    }
    if (typeof v === 'object' && v.result !== undefined) return String(v.result).trim(); // formula
    if (v instanceof Date) return v.toISOString().split('T')[0];
    return String(v).trim();
  };

  // Read headers from row 1 (all columns, including empty gaps)
  const headers = {}; // colNum → header string
  const headerRow = ws.getRow(1);
  headerRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    const h = cellStr(cell);
    if (h) headers[colNum] = h;
  });

  console.log('[Employees] Detected headers:', Object.values(headers));

  const employees = [];
  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) return; // skip header row
    const rowObj = {};
    row.eachCell({ includeEmpty: false }, (cell, colNum) => {
      const hdr = headers[colNum];
      if (hdr) rowObj[hdr] = cell.value;
    });
    const emp = normalizeEmployeeRow(rowObj);
    if (emp && emp.empCode) employees.push(emp);
  });
  return employees;
}

/**
 * On startup: if employees.json does not exist but employees.xlsx does,
 * parse the xlsx and save employees.json automatically.
 */
async function loadEmployeesFromXlsxIfNeeded() {
  // Check if the DB already has at least one employee record
  const currentData  = readEmployees();
  const hasData      = currentData.length > 0;

  if (hasData) {
    console.log(`✅ Employees already in DB (${currentData.length} records) — skipping xlsx import.`);
    return;
  }

  if (!fs.existsSync(EMPLOYEES_XLSX_INPUT)) {
    console.log('ℹ️  No employees.xlsx found — employee directory starts empty.');
    return;
  }

  try {
    const buffer    = fs.readFileSync(EMPLOYEES_XLSX_INPUT);
    const employees = await parseEmployeesXlsx(buffer);
    if (employees.length === 0) {
      console.log('⚠️  employees.xlsx parsed 0 rows — check column headers.');
      return;
    }
    writeEmployees(employees);
    console.log(`✅ Auto-imported ${employees.length} employees from employees.xlsx → employees.json`);
  } catch (err) {
    console.error('❌ Failed to auto-import employees.xlsx:', err.message);
  }
}

// ── Input Sanitization Helpers ────────────────────────────────
/**
 * Strips HTML/script meta-characters and trims whitespace.
 * Use on every string field before persisting to storage.
 * Does NOT double-encode — avoids the &amp; double-encoding problem.
 */
function sanitizeStr(val, maxLen = 500) {
  if (val === undefined || val === null) return '';
  return String(val)
    .replace(/[<>"'`\\]/g, '') // strip HTML meta-chars + backslash
    .trim()
    .slice(0, maxLen);
}

/**
 * Clamps a numeric value to [min, max]; returns fallback on NaN.
 */
function clampInt(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ── User Helpers ──────────────────────────────────────────────
function getUsers() {
  const storage = readStorage();
  if (!storage['app-users']) return [];
  try { return JSON.parse(storage['app-users']); } catch { return []; }
}

function saveUsers(users, storage) {
  storage['app-users'] = JSON.stringify(users);
  return writeStorage(storage);
}

// ── Password Migration (plain-text → bcrypt) ─────────────────
/**
 * يفحص كل مستخدم، وأي كلمة مرور غير مشفرة بـ bcrypt يُشفرها تلقائياً.
 * يُشغَّل مرة واحدة عند بدء السيرفر.
 */
async function migratePasswordsIfNeeded() {
  const storage = readStorage();
  let users = [];
  if (storage['app-users']) {
    try { users = JSON.parse(storage['app-users']); } catch { users = []; }
  }

  let changed = false;
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    // كلمات المرور المشفرة ببcrypt تبدأ دائماً بـ $2a$ أو $2b$
    if (u.password && !u.password.startsWith('$2')) {
      console.log(`🔐 Migrating password for user: ${u.username}`);
      users[i].password = await bcrypt.hash(u.password, BCRYPT_ROUNDS);
      changed = true;
    }
  }

  if (changed) {
    storage['app-users'] = JSON.stringify(users);
    writeStorage(storage);
    console.log('✅ Password migration complete.');
  }
}

// ── Role Migration (Legacy -> New HSE Hierarchical Roles) ─────
async function migrateRolesIfNeeded() {
  const storage = readStorage();
  let users = [];
  if (storage['app-users']) {
    try { users = JSON.parse(storage['app-users']); } catch { users = []; }
  }

  let changed = false;
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    if (u.role === 'superadmin') {
      u.role = 'super_admin';
      changed = true;
    } else if (u.role === 'area_head') {
      u.role = 'dept_admin';
      changed = true;
    } else if (u.role === 'admin' || u.role === 'supervisor') {
      u.role = 'hse_admin';
      changed = true;
    }
  }

  if (changed) {
    storage['app-users'] = JSON.stringify(users);
    writeStorage(storage);
    console.log('✅ Role migration complete.');
  }
}

// ── Flag Existing Accounts Still On a Known Default Password ──
// يفحص كل الحسابات الموجودة فعليًا (وليس فقط الجديدة) ويضع علامة
// mustChangePassword=true على أي حساب لا يزال يستخدم كلمة مرور افتراضية
// معروفة (admin123 لحساب المدير العام الافتراضي، 123456 لحسابات الأقسام/الصيانة
// المولَّدة تلقائيًا) — هذا يغطي الحسابات التي أُنشئت قبل إضافة هذه الميزة.
async function flagKnownDefaultPasswordsIfNeeded() {
  const storage = readStorage();
  let users = [];
  if (storage['app-users']) {
    try { users = JSON.parse(storage['app-users']); } catch { users = []; }
  }

  let changed = false;
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    if (u.mustChangePassword === true || !u.password || !u.password.startsWith('$2')) continue;

    const isAutoGenerated =
      u.id === 'superadmin-default' ||
      (typeof u.id === 'string' && (u.id.startsWith('auto-dept-') || u.id.startsWith('auto-maint-')));
    if (!isAutoGenerated) continue;

    const knownDefault = u.id === 'superadmin-default' ? 'admin123' : '123456';
    const stillDefault = await bcrypt.compare(knownDefault, u.password);
    if (stillDefault) {
      users[i].mustChangePassword = true;
      changed = true;
    }
  }

  if (changed) {
    storage['app-users'] = JSON.stringify(users);
    writeStorage(storage);
    console.log('⚠️  Flagged accounts still using a known default password — they will be forced to change it on next login.');
  }
}

// ── Ensure Default Super Admin ────────────────────────────────
async function ensureDefaultSuperAdmin() {
  const storage = readStorage();
  let users = [];
  if (storage['app-users']) {
    try { users = JSON.parse(storage['app-users']); } catch { users = []; }
  }

  const hasSuperAdmin = users.some(u => u.role === 'super_admin');
  if (!hasSuperAdmin) {
    const hashedPassword = await bcrypt.hash('admin123', BCRYPT_ROUNDS);
    users.unshift({
      id: 'superadmin-default',
      username: 'superadmin',
      password: hashedPassword,
      role: 'super_admin',
      name: 'المدير العام',
      createdAt: new Date().toISOString(),
      mustChangePassword: true
    });
    storage['app-users'] = JSON.stringify(users);
    writeStorage(storage);
    console.log('✅ Default super_admin account created.');
  }
}

// ── Backfill Hazard Timestamps ───────────────────────────────
function backfillHazardTimestamps(hazard) {
  const baseTime = hazard.submittedAt || hazard.createdAt || new Date().toISOString();
  const updater = hazard.updatedBy || 'المدير العام';

  // If report has been seen or touched, but seenAt is null:
  if ((hazard.status !== 'open' || hazard.actionTaken) && !hazard.seenAt) {
    hazard.seenAt = baseTime;
    hazard.seenBy = hazard.seenBy || updater;
  }

  // If status is in_progress or resolved/closed:
  if (['in_progress', 'resolved', 'closed'].includes(hazard.status)) {
    if (!hazard.seenAt) {
      hazard.seenAt = baseTime;
      hazard.seenBy = hazard.seenBy || updater;
    }
    if (!hazard.inProgressAt) {
      hazard.inProgressAt = hazard.seenAt || baseTime;
      hazard.inProgressBy = hazard.inProgressBy || updater;
    }
  }

  // If status is resolved/closed:
  if (['resolved', 'closed'].includes(hazard.status)) {
    if (!hazard.seenAt) {
      hazard.seenAt = baseTime;
      hazard.seenBy = hazard.seenBy || updater;
    }
    if (!hazard.inProgressAt) {
      hazard.inProgressAt = hazard.seenAt || baseTime;
      hazard.inProgressBy = hazard.inProgressBy || updater;
    }
    if (!hazard.resolvedAt) {
      hazard.resolvedAt = hazard.inProgressAt || baseTime;
      hazard.resolvedBy = hazard.resolvedBy || updater;
    }
  }

  return hazard;
}

function runHazardBackfillOnStartup() {
  let hazards = readHazards();
  if (!hazards || hazards.length === 0) return;
  const originalStr = JSON.stringify(hazards);
  hazards = hazards.map(backfillHazardTimestamps);
  if (JSON.stringify(hazards) !== originalStr) {
    writeHazards(hazards);
    console.log('✅ Backfilled missing timestamps for existing hazard records.');
  }
}

// ── Auto-seed Department Admins ─────────────────────────────────
async function autoSeedDeptAdmins() {
  const employees = readEmployees();
  if (!employees || employees.length === 0) return;

  const depts = new Set();
  employees.forEach(e => {
    if (e.department && e.department.trim()) depts.add(e.department.trim());
  });

  const storage = readStorage();
  let users = [];
  if (storage['app-users']) {
    try { users = JSON.parse(storage['app-users']); } catch { users = []; }
  }

  let changed = false;
  const hashedPassword = await bcrypt.hash('123456', BCRYPT_ROUNDS);

  // Hotfix: Force HSE admin to have correct role
  for (let i = 0; i < users.length; i++) {
    if ((users[i].department === 'HSE' || users[i].username === 'hse_admin') && users[i].role === 'dept_admin') {
      users[i].role = 'hse_admin';
      users[i].department = '';
      users[i].name = 'مشرف سلامة (HSE Admin)';
      changed = true;
    }
  }

  const maintDepts = ['Electrical Maintenance', 'Mechanical Maintenance', 'Preventive Maintenance'];
  for (const dept of maintDepts) {
    const hasMaintAdmin = users.some(u => u.role === 'maint_admin' && u.department === dept);
    if (!hasMaintAdmin) {
      const username = dept.split(' ')[0].toLowerCase() + '_maintenance_admin';
      if (!users.some(u => u.username === username)) {
        users.push({
          id: 'auto-maint-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
          username: username,
          password: hashedPassword,
          role: 'maint_admin',
          name: 'مشرف الصيانة - ' + dept,
          department: dept,
          createdAt: new Date().toISOString(),
          mustChangePassword: true
        });
        changed = true;
      }
    }
  }

  for (const dept of depts) {
    const hasDeptAdmin = users.some(u => u.role === 'dept_admin' && u.department === dept);
    if (!hasDeptAdmin) {
      const username = dept.toLowerCase().replace(/\s+/g, '_') + '_admin';
      
      // Ensure username is unique just in case
      if (!users.some(u => u.username === username)) {
        users.push({
          id: 'auto-dept-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
          username: username,
          password: hashedPassword,
          role: 'dept_admin',
          name: 'مشرف قسم ' + dept,
          department: dept,
          createdAt: new Date().toISOString(),
          mustChangePassword: true
        });
        changed = true;
      }
    }
  }

  if (changed) {
    storage['app-users'] = JSON.stringify(users);
    writeStorage(storage);
    console.log('✅ Auto-seeded missing department admin accounts.');
  }
}

// ── Startup Sequence ──────────────────────────────────────────
(async () => {
  await migrateRolesIfNeeded();
  await ensureDefaultSuperAdmin();
  await autoSeedDeptAdmins();
  await migratePasswordsIfNeeded();
  await flagKnownDefaultPasswordsIfNeeded();
  runHazardBackfillOnStartup();
  await loadEmployeesFromXlsxIfNeeded();
  console.log('🔒 Security initialization complete.');
})();

// ============================================================
// 🔑 JWT AUTHENTICATION MIDDLEWARES
// ============================================================

/**
 * يتحقق من Bearer Token في Authorization header.
 * يُضيف req.user = { id, username, role } عند النجاح.
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ error: 'غير مصرح: يجب تسجيل الدخول أولاً' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, username, role, iat, exp }
    
    // Dynamic role patches for legacy compatibility
    if (req.user.role === 'dept_admin') {
      if (req.user.department && req.user.department.toUpperCase() === 'HSE') {
        req.user.role = 'hse_admin';
        req.user.department = '';
      } else if (req.user.department && ['Electrical Maintenance', 'Mechanical Maintenance', 'Preventive Maintenance'].includes(req.user.department)) {
        req.user.role = 'maint_admin';
      }
    }
    if (req.user.username === 'hse_admin') req.user.role = 'hse_admin';
    
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً', expired: true });
    }
    return res.status(403).json({ error: 'Token غير صالح' });
  }
}

/**
 * مصنع Middleware للتحقق من الدور (Role-Based Access Control).
 * الاستخدام: requireRole('super_admin') أو requireRole('hse_admin', 'dept_admin')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'غير مصرح: لم يتم التحقق من الهوية' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `ليس لديك صلاحية لهذه العملية. المطلوب: ${roles.join(' أو ')}`
      });
    }
    next();
  };
}

/**
 * مثل authenticateToken تمامًا، لكن يقبل التوكن أيضًا عبر query string (?dt=...)
 * بالإضافة إلى Authorization header. يُستخدم حصريًا لروابط تنزيل مباشرة (<a href>)
 * لا يمكنها إرسال Authorization header، مع الحفاظ الكامل على التحقق من JWT والدور.
 * لا تُستخدم هذه النسخة في أي مسار آخر غير مسارات التنزيل المباشر.
 */
function authenticateTokenFlexible(req, res, next) {
  const authHeader = req.headers['authorization'];
  const headerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const queryToken = typeof req.query.dt === 'string' ? req.query.dt : null;
  const token = headerToken || queryToken;

  if (!token) {
    return res.status(401).json({ error: 'غير مصرح: يجب تسجيل الدخول أولاً' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    if (req.user.role === 'dept_admin') {
      if (req.user.department && req.user.department.toUpperCase() === 'HSE') {
        req.user.role = 'hse_admin';
        req.user.department = '';
      } else if (req.user.department && ['Electrical Maintenance', 'Mechanical Maintenance', 'Preventive Maintenance'].includes(req.user.department)) {
        req.user.role = 'maint_admin';
      }
    }
    if (req.user.username === 'hse_admin') req.user.role = 'hse_admin';
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً', expired: true });
    }
    return res.status(403).json({ error: 'Token غير صالح' });
  }
}

// ============================================================
// 🔄 EXCEL SYNC
// ============================================================
async function syncExcelFromPermits(permitsJsonString) {
  try {
    let permits;
    try {
      permits = JSON.parse(permitsJsonString);
    } catch (parseErr) {
      console.error('Excel sync: invalid JSON received, skipping sync.', parseErr.message);
      return;
    }
    if (!Array.isArray(permits)) return;

    let workbook = new ExcelJS.Workbook();
    let worksheet;

    if (fs.existsSync(EXCEL_FILE)) {
      try {
        await workbook.xlsx.readFile(EXCEL_FILE);
        worksheet = workbook.getWorksheet('سجل الطلبات');
      } catch (readErr) {
        console.warn('Excel sync: could not read existing file (may be open), creating fresh.', readErr.message);
        workbook = new ExcelJS.Workbook();
        worksheet = null;
      }
    }

    if (!worksheet) {
      worksheet = workbook.addWorksheet('سجل الطلبات');
      worksheet.columns = [
        { header: 'رقم الطلب',   key: 'id',                width: 18 },
        { header: 'نوع الطلب',   key: 'typeLabel',         width: 20 },
        { header: 'القسم',         key: 'department',        width: 15 },
        { header: 'الوردية',       key: 'shift',             width: 12 },
        { header: 'تاريخ التنفيذ', key: 'date',              width: 15 },
        { header: 'اسم العامل',    key: 'workerName',        width: 22 },
        { header: 'رقم التليفون',  key: 'requesterPhone',    width: 16 },
        { header: 'مكان العمل',    key: 'location',          width: 20 },
        { header: 'الحالة',        key: 'status',            width: 15 },
        { header: 'مشرف السلامة',  key: 'safetyOfficerName', width: 20 },
        { header: 'مدير المنطقة',  key: 'areaManagerName',   width: 20 },
        { header: 'ملاحظة الرفض',  key: 'reviewNote',        width: 25 },
        { header: 'تاريخ الإرسال', key: 'submittedAt',       width: 22 }
      ];
    } else {
      worksheet.spliceRows(2, worksheet.rowCount);
    }

    permits.forEach(p => {
      worksheet.addRow({
        id:                p.id || '',
        typeLabel:         p.typeLabel || '',
        department:        p.department || '',
        shift:             p.shift || '',
        date:              p.date || '',
        workerName:        p.workerName || '',
        requesterPhone:    p.requesterPhone || '',
        location:          p.location || '',
        status:            p.status || '',
        safetyOfficerName: p.safetyOfficerName || '-',
        areaManagerName:   p.areaManagerName || '-',
        reviewNote:        p.reviewNote || '-',
        submittedAt:       p.submittedAt ? new Date(p.submittedAt).toLocaleString('ar-EG') : ''
      });
    });

    await workbook.xlsx.writeFile(EXCEL_FILE);
  } catch (err) {
    console.error('Excel sync error:', err);
  }
}

async function syncHazardsExcelFromData(hazards) {
  try {
    if (!Array.isArray(hazards)) return;

    let workbook = new ExcelJS.Workbook();
    let worksheet;

    if (fs.existsSync(HAZARDS_EXCEL_FILE)) {
      try {
        await workbook.xlsx.readFile(HAZARDS_EXCEL_FILE);
        worksheet = workbook.getWorksheet('بلاغات الخطورة');
      } catch (readErr) {
        console.warn('Excel sync: could not read existing hazards file, creating fresh.', readErr.message);
        workbook = new ExcelJS.Workbook();
        worksheet = null;
      }
    }

    if (!worksheet) {
      worksheet = workbook.addWorksheet('بلاغات الخطورة');
      worksheet.columns = [
        { header: 'كود البلاغ',       key: 'id',               width: 18 },
        { header: 'التاريخ',          key: 'date',             width: 15 },
        { header: 'اسم المبلغ',       key: 'reporterName',     width: 20 },
        { header: 'القسم',            key: 'department',       width: 15 },
        { header: 'المنطقة',          key: 'area',             width: 20 },
        { header: 'وصف الخطورة',      key: 'description',      width: 40 },
        { header: 'الإصابة المحتملة', key: 'potentialInjury',  width: 30 },
        { header: 'الحل المقترح',     key: 'proposedSolution', width: 30 },
        { header: 'مستوى الخطورة',    key: 'riskLevel',        width: 15 },
        { header: 'الحالة',           key: 'status',           width: 20 },
        { header: 'الإجراء المتخذ وملاحظات المشرف',   key: 'actionTaken',      width: 40 }
      ];
    } else {
      worksheet.spliceRows(2, worksheet.rowCount);
    }

    hazards.forEach(h => {
      let riskStr = h.riskLevel === 'H' ? 'High 🔴' : h.riskLevel === 'M' ? 'Medium 🟡' : 'Low 🟢';
      let statusStr = 'مفتوح 🔴';
      if (h.status === 'notified') statusStr = 'تم الإبلاغ 📢';
      if (h.status === 'in_progress') statusStr = 'قيد الإصلاح 🟡';
      if (h.status === 'resolved' || h.status === 'closed') statusStr = 'تم الحل والإغلاق 🟢';
      
      let finalAction = h.actionTaken || '-';
      if (h.updatedBy) finalAction += ` (بواسطة: ${h.updatedBy})`;

      worksheet.addRow({
        id:               h.id || '',
        date:             h.date || '',
        reporterName:     h.reporterName || '',
        department:       h.department || '',
        area:             h.area || '',
        description:      h.description || '',
        potentialInjury:  h.potentialInjury || '',
        proposedSolution: h.proposedSolution || '',
        riskLevel:        riskStr,
        status:           statusStr,
        actionTaken:      finalAction
      });
    });

    await workbook.xlsx.writeFile(HAZARDS_EXCEL_FILE);
  } catch (err) {
    console.error('Hazards Excel sync error:', err);
  }
}

// ============================================================
// 📦 API ROUTES — STORAGE (Generic Key/Value)
// ============================================================



// ── Storage key security (يشمل القراءة والكتابة معًا):
//   • مفتاح 'work-permits' فقط مقروء/مكتوب بدون مصادقة (مطلوب لتدفق دخول العمال بدون كلمة مرور).
//   • كل المفاتيح الأخرى — وعلى رأسها 'app-users' و'users' التي تحتوي حسابات
//     المشرفين وكلمات مرورهم المشفّرة — تتطلب JWT + دور super_admin لكل من
//     القراءة (GET) والكتابة (POST) على حد سواء.
//   • الحماية السابقة كانت تُطبَّق على الكتابة فقط، تاركةً القراءة مفتوحة بالكامل —
//     هذه هي الثغرة الحرجة التي تم إغلاقها هنا (11 سبتمبر 2026).
const READ_PROTECTED_KEYS = ['app-users', 'users'];
const KEY_PATTERN = /^[a-zA-Z0-9_\-]+$/;

// ── GET /api/storage/:key
app.get('/api/storage/:key', (req, res, next) => {
  const key = req.params.key;
  if (!KEY_PATTERN.test(key) || key.length > 64) {
    return res.status(400).json({ error: 'Invalid storage key format' });
  }
  if (READ_PROTECTED_KEYS.includes(key)) {
    return authenticateToken(req, res, () => requireRole('super_admin')(req, res, next));
  }
  next();
}, (req, res) => {
  const data = readStorage();
  const key = req.params.key;
  res.json({ key, value: data[key] || '[]' });
});

// ── POST /api/storage/:key — حفظ قيمة (rate-limited on work-permits key)
const WRITABLE_KEYS_UNAUTH = ['work-permits'];

app.post('/api/storage/:key', (req, res, next) => {
  const key = req.params.key;
  // Path traversal / injection guard
  if (!KEY_PATTERN.test(key) || key.length > 64) {
    return res.status(400).json({ error: 'Invalid storage key format' });
  }
  // Apply submit rate limit only for work-permits writes
  if (key === 'work-permits') {
    return submitLimiter(req, res, next);
  }
  next();
}, (req, res, next) => {
  const key = req.params.key;

  if (READ_PROTECTED_KEYS.includes(key)) {
    return authenticateToken(req, res, () => {
      requireRole('super_admin')(req, res, next);
    });
  }
  // Block any key not in the unauth-writable allowlist
  if (!WRITABLE_KEYS_UNAUTH.includes(key)) {
    return res.status(403).json({ error: 'كتابة هذا المفتاح غير مسموح به' });
  }
  next();
}, async (req, res) => {
  let { value } = req.body;
  const key = req.params.key;

  if (value === undefined || value === null) {
    return res.status(400).json({ error: 'القيمة (value) مطلوبة في جسم الطلب' });
  }

  // ── Security: strip status forgery + sanitize all string fields on new permits ─
  if (key === 'work-permits') {
    try {
      let permits = JSON.parse(value);
      // Prototype pollution guard
      if (typeof permits !== 'object' || permits === null) throw new Error('invalid permits payload');
      if (Array.isArray(permits)) {
        // Load existing permits to compare and preserve authenticated statuses
        const existing = readStorage();
        let existingPermits = [];
        if (existing['work-permits']) {
          try { existingPermits = JSON.parse(existing['work-permits']); } catch { existingPermits = []; }
        }
        const existingMap = new Map(existingPermits.map(p => [p.id, p]));

        permits = permits.map(p => {
          const prev = existingMap.get(p.id);
          if (prev) {
            // Existing permit: preserve authenticated status and review fields
            return {
              ...p,
              status:            prev.status,
              reviewedBy:        prev.reviewedBy,
              reviewedAt:        prev.reviewedAt,
              safetyOfficerName: prev.safetyOfficerName,
              areaManagerName:   prev.areaManagerName,
              reviewNote:        prev.reviewNote,
              closure:           prev.closure
            };
          }
          // New permit: sanitize free-text fields, force status to pending_area_head
          
          createNotification({
            targetRole: 'dept_admin',
            targetDept: p.department,
            type: 'permit',
            title: 'طلب جديد 📋',
            message: `مقدم من ${p.workerName || 'موظف'} نوع ${p.typeLabel || 'غير محدد'} في ${p.location || 'غير محدد'}`,
            link: 'tabPermits'
          });
          
          if (p.employeeId) {
            createNotification({
              targetEmpCode: p.employeeId,
              type: 'permit',
              title: 'استلام طلب طلب ✅',
              message: 'تم استلام طلب طلبك بنجاح وهو قيد المراجعة',
              link: 'tabMyHistory'
            });
          }

          const safeTools = Array.isArray(p.tools)
            ? p.tools.map(t => sanitizeStr(String(t), 100)).slice(0, 10)
            : sanitizeStr(String(p.tools || ''), 300);
          const safeChecklist = Array.isArray(p.checklist)
            ? p.checklist.map(c => ({
                section:  sanitizeStr(String(c.section  || ''), 100),
                question: sanitizeStr(String(c.question || ''), 300),
                answer:   ['\u0646\u0639\u0645', '\u0644\u0627', '\u0644\u0627 \u064a\u0646\u0637\u0628\u0642'].includes(c.answer) ? c.answer : '\u0644\u0627 \u064a\u0646\u0637\u0628\u0642'
              }))
            : [];
          const safeRisks = Array.isArray(p.risks)
            ? p.risks.slice(0, 10).map(r => ({
                source:  sanitizeStr(String(r.source  || ''), 200),
                l:       Math.min(5, Math.max(1, parseInt(r.l, 10) || 1)),
                s:       Math.min(5, Math.max(1, parseInt(r.s, 10) || 1)),
                score:   Math.min(25, Math.max(1, parseInt(r.score, 10) || 1)),
                control: sanitizeStr(String(r.control || ''), 300)
              }))
            : [];
          return {
            id:               sanitizeStr(String(p.id || ''), 30),
            typeKey:          sanitizeStr(String(p.typeKey || 'general'), 30),
            typeLabel:        sanitizeStr(String(p.typeLabel || ''), 30),
            typeFullLabel:    sanitizeStr(String(p.typeFullLabel || ''), 60),
            department:       sanitizeStr(String(p.department || ''), 100),
            shift:            sanitizeStr(String(p.shift || ''), 30),
            date:             sanitizeStr(String(p.date || ''), 15),
            previousPermitNo: sanitizeStr(String(p.previousPermitNo || ''), 50),
            timeFrom:         sanitizeStr(String(p.timeFrom || ''), 50),
            timeTo:           sanitizeStr(String(p.timeTo || ''), 50),
            workerName:       sanitizeStr(String(p.workerName || ''), 100),
            requesterKind:    ['\u0645\u0648\u0638\u0641', '\u0645\u0642\u0627\u0648\u0644'].includes(p.requesterKind) ? p.requesterKind : '\u0645\u0648\u0638\u0641',
            requesterPhone:   sanitizeStr(String(p.requesterPhone || ''), 20),
            employeeId:       sanitizeStr(String(p.employeeId || ''), 50),
            description:      sanitizeStr(String(p.description || ''), 1000),
            location:         sanitizeStr(String(p.location || ''), 150),
            equipment:        sanitizeStr(String(p.equipment || ''), 200),
            tools:            safeTools,
            workersNames:     sanitizeStr(String(p.workersNames || ''), 500),
            checklist:        safeChecklist,
            checklistNote:    sanitizeStr(String(p.checklistNote || ''), 500),
            risks:            safeRisks,
            status:           'pending_dept',
            reviewedBy:       '',
            reviewedAt:       '',
            reviewNote:       '',
            closure:          null,
            areaHeadReviewedBy:  '',
            areaHeadReviewedAt:  '',
            safetyOfficerName:   '',
            areaManagerName:     '',
            deletedBy: { areaAdmin: false, safetyAdmin: false, superAdmin: false, worker: false },
            submittedAt:      p.submittedAt || new Date().toISOString()
          };
        });
        value = JSON.stringify(permits);
      }
    } catch (e) {
      console.error('work-permits sanitize error:', e.message);
      return res.status(400).json({ error: 'Invalid permit payload' });
    }
  }

  await enqueueWrite(async () => {
    const data = readStorage();
    data[key]  = value;
    if (writeStorage(data)) {
      if (key === 'work-permits') {
        schedulePermitsExcelSync(value);
      }
    } else {
      throw new Error('Failed to write storage');
    }
  });

  res.json({ success: true, key });
});

// ── GET /api/export-excel — تصدير ملف الإكسيل (supervisors only)
app.get('/api/export-excel',
  authenticateToken,
  requireRole('super_admin', 'hse_admin', 'dept_admin', 'maint_admin'),
  async (req, res) => {
    // Excel regen is debounced (see schedulePermitsExcelSync); flush any
    // pending change now so a download right after an edit is never stale.
    if (_permitsExcelTimer) {
      clearTimeout(_permitsExcelTimer);
      _permitsExcelTimer = null;
      const pending = _permitsExcelPending;
      _permitsExcelPending = null;
      if (pending !== null) {
        try { await syncExcelFromPermits(pending); } catch (e) { console.error('Flush permits excel sync failed:', e); }
      }
    }
    if (fs.existsSync(EXCEL_FILE)) {
      res.download(EXCEL_FILE, 'سجل_طلبات_العمل.xlsx');
    } else {
      res.status(404).send('لا يوجد سجل حالياً');
    }
  }
);

// ============================================================
// 🛡️ API ROUTES — PERMIT STATUS (Supervisor / Admin / SuperAdmin only)
// ============================================================

/**
 * PATCH /api/permits/:id
 * الإجراءات المدعومة: approve | reject | close
 * محمي بـ JWT + RBAC (supervisor / admin / superadmin)
 *
 * Body (approve):
 *   { action: 'approve', safetyOfficerName?, areaManagerName? }
 * Body (reject):
 *   { action: 'reject', reviewNote? }
 * Body (close):
 *   { action: 'close', closureType: 'safe'|'incomplete'|'forced', closureReason? }
 */
app.patch(
  '/api/permits/:id',
  authenticateToken,
  requireRole('super_admin', 'hse_admin', 'dept_admin', 'maint_admin'),
  async (req, res) => {
    const permitId = req.params.id;
    const { action, reviewNote, closureType, closureReason } = req.body;

    const VALID_ACTIONS = ['dept_approve', 'hse_approve', 'reject', 'close'];
    if (!action || !VALID_ACTIONS.includes(action)) {
      return res.status(400).json({ error: `الإجراء غير صالح. المتاح: ${VALID_ACTIONS.join(' | ')}` });
    }
    if (action === 'dept_approve' && req.user.role !== 'dept_admin' && req.user.role !== 'maint_admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'هذا الإجراء مخصص لرئيس القسم فقط' });
    }
    if (action === 'hse_approve' && req.user.role !== 'hse_admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'هذا الإجراء مخصص لمشرف السلامة فقط' });
    }
    if (action === 'close') {
      const VALID_CLOSURE = ['safe', 'incomplete', 'forced'];
      if (!closureType || !VALID_CLOSURE.includes(closureType)) {
        return res.status(400).json({ error: `نوع الإغلاق غير صالح. المتاح: ${VALID_CLOSURE.join(' | ')}` });
      }
    }

    let result;
    await enqueueWrite(async () => {
      const storage = readStorage();
      let permits = [];
      if (storage['work-permits']) {
        try { permits = JSON.parse(storage['work-permits']); } catch { permits = []; }
      }

      const idx = permits.findIndex(p => p.id === permitId);
      if (idx === -1) {
        result = { status: 404, body: { error: 'الطلب غير موجود' } };
        return;
      }

      const now = new Date().toISOString();
      const reviewerName = req.user.name || req.user.username;
      const previousStatus = permits[idx].status;

      if (action === 'dept_approve') {
        if (permits[idx].status !== 'pending_dept' && permits[idx].status !== 'pending_area_head' && permits[idx].status !== 'pending') {
          result = { status: 409, body: { error: 'لا يمكن موافقة رئيس القسم إلا على طلبات قيد انتظار القسم' } };
          return;
        }
        if ((req.user.role === 'dept_admin' || req.user.role === 'maint_admin') && req.user.department &&
            permits[idx].department && !deptMatches(req.user.department, permits[idx].department)) {
          result = { status: 403, body: { error: 'رئيس القسم لا يملك صلاحية الموافقة على طلبات قسم آخر' } };
          return;
        }
        permits[idx].status              = 'pending_hse';
        permits[idx].areaHeadReviewedAt  = now;
        permits[idx].areaHeadReviewedBy  = sanitizeStr(reviewerName, 100);
        permits[idx].areaManagerName     = sanitizeStr(reviewerName, 100);
        console.log("Updated permit status to:", permits[idx].status);
      } else if (action === 'hse_approve') {
        if (permits[idx].status !== 'pending_hse') {
          result = { status: 409, body: { error: 'الموافقة النهائية تتطلب حالة pending_hse' } };
          return;
        }
        permits[idx].status            = 'approved';
        permits[idx].reviewedAt        = now;
        permits[idx].reviewedBy        = sanitizeStr(reviewerName, 100);
        permits[idx].safetyOfficerName = sanitizeStr(reviewerName, 100);
      } else if (action === 'reject') {
        if (permits[idx].status !== 'pending_dept' && permits[idx].status !== 'pending_hse') {
          result = { status: 409, body: { error: 'لا يمكن الرفض إلا على الطلبات قيد الانتظار' } };
          return;
        }
        permits[idx].status     = 'rejected';
        permits[idx].reviewedAt = now;
        permits[idx].reviewedBy = sanitizeStr(reviewerName, 100);
        permits[idx].reviewNote = sanitizeStr(reviewNote, 500);
        permits[idx].rejectedByRole = req.user.role;
      } else if (action === 'close') {
        if (!permits[idx].status || !permits[idx].status.startsWith('approved')) {
          if (req.user.role !== 'super_admin' && permits[idx].status !== 'approved') {
            result = { status: 409, body: { error: 'لا يمكن إغلاق إلا الطلبات الموافق عليها' } };
            return;
          }
        }
        permits[idx].status  = 'closed_' + closureType;
        permits[idx].closure = {
          type:     closureType,
          reason:   sanitizeStr(closureReason, 300),
          time:     now,
          closedBy: sanitizeStr(reviewerName, 100)
        };
      }

      // ── سجل تدقيق تاريخي: هذا السطر يُضيف الحدث للسجل الدائم غير القابل
      // للتعديل — بالتوازي مع تحديث الحالة الحالية على السجل نفسه أعلاه —
      // بحيث لا يُفقد أي أثر لمن وافق/رفض وماذا كانت الحالة السابقة، حتى لو
      // تغيّرت حالة نفس الطلب عدة مرات لاحقًا.
      logAuditEvent({
        entityType: 'permit',
        entityId: permitId,
        action: action,
        actor: req.user,
        previousStatus,
        newStatus: permits[idx].status,
        note: action === 'reject' ? reviewNote : (action === 'close' ? closureReason : '')
      });

      const newValue = JSON.stringify(permits);
      storage['work-permits'] = newValue;
      if (writeStorage(storage)) {
        schedulePermitsExcelSync(newValue);
        
        if (permits[idx].employeeId) {
          if (action === 'hse_approve') {
            createNotification({
              targetEmpCode: permits[idx].employeeId,
              type: 'permit',
              title: 'تم اعتماد الطلب النهائي 🎉',
              message: `تم اعتماد طلبك النهائي برقم ${permits[idx].id} من إدارة السلامة، يمكنك بدء العمل`,
              link: 'tabMyHistory'
            });
            createNotification({
              targetRole: 'dept_admin',
              targetDept: permits[idx].department,
              type: 'permit',
              title: 'تم اعتماد الطلب النهائي 🎉',
              message: `تم اعتماد طلب قسمك النهائي برقم ${permits[idx].id} من إدارة السلامة`,
              link: 'tabPermits'
            });
          } else if (action === 'dept_approve') {
            createNotification({
              targetRole: 'hse_admin',
              type: 'permit',
              title: 'طلب بانتظار مراجعة السلامة 🛡️',
              message: `تم موافقة رئيس القسم على الطلب رقم ${permits[idx].id} وبانتظار اعتماد HSE`,
              link: 'tabPermits'
            });
            createNotification({
              targetRole: 'super_admin',
              type: 'permit',
              title: 'طلب بانتظار مراجعة السلامة 🛡️',
              message: `تم موافقة رئيس القسم على الطلب رقم ${permits[idx].id} وبانتظار اعتماد HSE`,
              link: 'tabPermits'
            });
          } else if (action === 'reject') {
            createNotification({
              targetEmpCode: permits[idx].employeeId,
              type: 'permit',
              title: 'رفض الطلب ❌',
              message: `تم رفض طلبك رقم ${permits[idx].id} - السبب: ${reviewNote || 'غير محدد'}`,
              link: 'tabMyHistory'
            });
            createNotification({
              targetRole: 'dept_admin',
              targetDept: permits[idx].department,
              type: 'permit',
              title: 'رفض الطلب ❌',
              message: `تم رفض طلب قسمك رقم ${permits[idx].id} - السبب: ${reviewNote || 'غير محدد'}`,
              link: 'tabPermits'
            });
          } else if (action === 'close') {
            createNotification({
              targetEmpCode: permits[idx].employeeId,
              type: 'permit',
              title: 'إغلاق الطلب 🔒',
              message: `تم إنهاء وإغلاق الطلب رقم ${permits[idx].id}`,
              link: 'tabMyHistory'
            });
          }
        }
        
        result = { status: 200, body: { success: true, permit: permits[idx] } };
      } else {
        result = { status: 500, body: { error: 'فشل حفظ التغييرات' } };
      }
    });

    res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
  }
);

// ============================================================
// ⚠️ API ROUTES — HAZARD REPORTS
// ============================================================

// ── NEW ROUTE: Upload Hazards Excel ──────────────────────────────
app.post('/api/hazards/upload-excel', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  try {
    const { base64Data } = req.body;
    if (!base64Data) {
      return res.status(400).json({ success: false, message: 'No file data provided' });
    }

    const buffer = Buffer.from(base64Data, 'base64');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    let ws = workbook.worksheets[0];
    let headerRowNumber = 1;
    let colMap = { code: 1, name: 2, dept: 3, pos: 4, hazard: 5, action: 6, area: 7, date: 8, sup: 9, status: 10, location: 11, severity: 12 };
    let headersFound = false;

    for (const sheet of workbook.worksheets) {
      sheet.eachRow((row, rowNum) => {
        if (headersFound || rowNum > 5) return;
        const vals = row.values;
        const hasCode = vals.some(v => v && (String(v).toLowerCase().includes('code') || String(v).includes('كود')));
        const hasName = vals.some(v => v && (String(v).toLowerCase().includes('name') || String(v).includes('اسم')));
        
        if (hasCode && hasName) {
          ws = sheet;
          headerRowNumber = rowNum;
          headersFound = true;
          
          vals.forEach((v, idx) => {
            if (!v) return;
            const val = String(v).toLowerCase().trim();
            if (val.includes('code') || val.includes('كود')) colMap.code = idx;
            else if (val.includes('name') || val.includes('اسم')) colMap.name = idx;
            else if (val.includes('department') || val.includes('قسم')) {
              if (colMap.deptFound) colMap.area = idx; 
              else { colMap.dept = idx; colMap.deptFound = true; }
            }
            else if (val.includes('position') || val.includes('وظيفة') || val.includes('مسمى')) colMap.pos = idx;
            else if (val === 'الخطورة' || val === 'خطورة' || val.includes('severity')) colMap.severity = idx;
            else if (val.includes('supervisor') || val.includes('مشرف')) colMap.sup = idx;
            else if (val.includes('hazard') || val.includes('خطورة') || val.includes('بلاغ') || val.includes('وصف') || val.includes('نوع')) colMap.hazard = idx;
            else if (val.includes('action') || val.includes('إجراء') || val.includes('متخذ')) colMap.action = idx;
            else if (val.includes('location') || val.includes('منطقة')) colMap.location = idx;
            else if (val.includes('date') || val.includes('تاريخ')) colMap.date = idx;
            else if (val.includes('status') || val.includes('حالة')) colMap.status = idx;
          });
        }
      });
      if (headersFound) break;
    }

    const importedHazards = [];

    ws.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRowNumber) return;
      
      const vals = row.values;
      const code = String(vals[colMap.code] || '').trim();
      if (!code || code === 'undefined') return;

      const name = String(vals[colMap.name] || '').trim();
      const reporterDept = String(vals[colMap.dept] || '').trim();
      const desc = String(vals[colMap.hazard] || '').trim();
      const action = String(vals[colMap.action] || '').trim();
      const location = String(vals[colMap.location] || vals[colMap.area] || '').trim();
      const statusText = String(vals[colMap.status] || '').trim();
      const supervisorName = String(vals[colMap.sup] || '').trim();
      
      let d = null;
      let dateVal = vals[colMap.date];
      if (dateVal instanceof Date) {
        d = dateVal;
      } else if (typeof dateVal === 'string') {
        const parsed = new Date(dateVal.trim());
        if (!isNaN(parsed.getTime())) d = parsed;
      } else if (typeof dateVal === 'number') {
        // Excel serial date to JS Date
        d = new Date(Math.round((dateVal - 25569) * 86400 * 1000));
      }

      if (d) {
        const y = d.getFullYear();
        if (y < 2000 || y > 2100) d = null;
      }
      if (!d || isNaN(d.getTime())) d = new Date(); // Fallback to now
      const dateStr = d.toISOString();

      // ملحوظة: لازم نتأكد إن العمود مكتوب فيه "لم يتم" الأول، لأن كلمة "لم يتم" نفسها
      // بتحتوي على "تم" جوّاها (لم + يتم)، فلو دورنا على "تم" بس هيقفل كل البلاغات غلط.
      const normalizedStatus = statusText.replace(/\s+/g, '');
      const isNotDone = normalizedStatus.includes('لميتم') || normalizedStatus.includes('لمتتم') || normalizedStatus.includes('لميحدث') || normalizedStatus.includes('open') || normalizedStatus.includes('مفتوح');
      const isDone = !isNotDone && (normalizedStatus.includes('تم') || normalizedStatus.includes('closed') || normalizedStatus.includes('مغلق'));
      const isClosed = isDone;

      // حساب مستوى الخطورة
      const severityText = String(vals[colMap.severity] || '').trim();
      let calculatedRiskLevel = 'L';
      let calculatedSeverityCode = 'A';
      if (severityText.includes('عالي') || severityText.includes('high')) {
        calculatedRiskLevel = 'H';
        calculatedSeverityCode = 'D';
      } else if (severityText.includes('متوسط') || severityText.includes('medium')) {
        calculatedRiskLevel = 'M';
        calculatedSeverityCode = 'C';
      } else if (severityText.includes('منخفض') || severityText.includes('low')) {
        calculatedRiskLevel = 'L';
        calculatedSeverityCode = 'A';
      }

      importedHazards.push({
        id: 'HAZ-' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '-' + rowNumber,
        reporterName: name,
        empCode: code,
        date: dateStr.split('T')[0],
        department: reporterDept,
        area: location,
        description: desc,
        potentialInjury: '',
        proposedSolution: '',
        likelihood: 1,
        severity: calculatedSeverityCode,
        riskLevel: calculatedRiskLevel,
        status: isClosed ? 'closed' : 'open',
        actionTaken: action,
        hseName: supervisorName,
        photoUrl: '',
        deletedBy: { areaAdmin: false, safetyAdmin: false, superAdmin: false, worker: false },
        permanentlyDeletedBy: { areaAdmin: false, safetyAdmin: false, superAdmin: false, worker: false },
        submittedAt: dateStr,
        treatmentStartedAt: isClosed ? dateStr : null,
        startedByName: isClosed ? 'الصيانة' : '',
        resolvedAt: isClosed ? dateStr : null,
        assignedToMaintenance: isClosed ? '' : 'الصيانة'
      });
    });

    const hazards = readHazards();
    const merged = [...hazards, ...importedHazards];
    const closedCount = importedHazards.filter(h => h.status === 'closed').length;
    const openCount = importedHazards.filter(h => h.status === 'open').length;
    console.log(`[hazards/upload-excel] استيراد ${importedHazards.length} بلاغ — مغلق: ${closedCount} / مفتوح: ${openCount}`);

    if (writeHazards(merged)) {
      res.json({ success: true, count: importedHazards.length, closed: closedCount, open: openCount });
    } else {
      res.status(500).json({ success: false, message: 'Failed to save hazard data' });
    }
  } catch (error) {
    console.error('Error parsing Hazards Excel:', error);
    res.status(500).json({ success: false, message: 'Invalid Excel file or parsing error' });
  }
});

// ── POST /api/permits/upload-excel — استيراد تصاريح عمل قديمة بالجملة من ملف إكسل
// (super_admin & hse_admin فقط). يقبل نفس الأعمدة المستخدمة في سجلات PTW القديمة:
// النوع / القسم / الوردية / رقم التصريح / الوصف / التاريخ / مسئول التنفيذ / مسئول السلامة /
// مدير المنطقة / الموقع — بأي ترتيب وبأسماء أعمدة عربي أو إنجليزي.
app.post('/api/permits/upload-excel', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  try {
    const { base64Data } = req.body;
    if (!base64Data) {
      return res.status(400).json({ success: false, message: 'No file data provided' });
    }

    const buffer = Buffer.from(base64Data, 'base64');
    const employees = readEmployees();
    const { importedPermits, skippedRows } = await parsePermitsWorkbook(buffer, employees);

    if (importedPermits.length === 0) {
      return res.status(400).json({ success: false, message: 'لم يتم العثور على تصاريح صالحة في الملف — تأكد من وجود أعمدة رقم التصريح والتاريخ' });
    }

    const storage = readStorage();
    let existingPermits = [];
    if (storage['work-permits']) {
      try { existingPermits = JSON.parse(storage['work-permits']); } catch { existingPermits = []; }
    }
    const merged = [...existingPermits, ...importedPermits];
    storage['work-permits'] = JSON.stringify(merged);

    const matchedCount = importedPermits.filter(p => p.employeeId).length;
    console.log(`[permits/upload-excel] استيراد ${importedPermits.length} تصريح قديم — اتربطوا بموظفين: ${matchedCount} — صفوف اتجاهلت: ${skippedRows}`);

    if (writeStorage(storage)) {
      res.json({ success: true, count: importedPermits.length, matched: matchedCount, skipped: skippedRows });
    } else {
      res.status(500).json({ success: false, message: 'Failed to save permit data' });
    }
  } catch (error) {
    console.error('Error parsing Permits Excel:', error);
    res.status(500).json({ success: false, message: 'Invalid Excel file or parsing error' });
  }
});

app.post('/api/hazards', submitLimiter, async (req, res) => {
  const payload = req.body;
  console.log('[POST /api/hazards] Received hazard report from:', payload.reporterName || 'Unknown');
  if (!payload || !payload.reporterName || !payload.department || !payload.description) {
    return res.status(400).json({ error: 'البيانات غير مكتملة' });
  }

  let result;
  await enqueueWrite(async () => {
    let hazards = readHazards();
    
    // Auto-generate ID: HZ-YYYY-XXXX
    const year = new Date().getFullYear();
    const maxN = hazards.reduce((mx, p) => {
      if(!p.id) return mx;
      const parts = p.id.split('-');
      const num = parseInt(parts[parts.length - 1]) || 0;
      return Math.max(mx, num);
    }, 0);
    const newId = `HZ-${year}-${String(maxN + 1).padStart(4,'0')}`;

    let photoUrl = '';
    if (payload.photo) {
      try {
        const base64Data = String(payload.photo).replace(/^data:image\/\w+;base64,/, '');
        
        // Validate Magic Numbers (Base64 headers)
        const isJPEG = base64Data.startsWith('/9j/');
        const isPNG = base64Data.startsWith('iVBORw0KGgo');
        const isWebP = base64Data.startsWith('UklGR');
        
        if (isJPEG || isPNG || isWebP) {
          const buffer = Buffer.from(base64Data, 'base64');
          // Strict filename without user input to prevent Path Traversal
          const filename = `HZ-${Date.now()}-${Math.floor(Math.random()*1000)}.jpg`;
          const filepath = path.join(UPLOADS_DIR, filename);
          fs.writeFileSync(filepath, buffer);
          photoUrl = `/uploads/hazards/${filename}`;
        } else {
          console.warn('[Security] Invalid image magic number detected. Upload rejected.');
        }
      } catch (err) {
        console.error('Error saving hazard photo:', err);
      }
    }

    const newHazard = {
      id:               newId,
      reporterName:     sanitizeStr(payload.reporterName, 100),
      empCode:          normalizeEmpCode(payload.empCode),
      date:             sanitizeStr(payload.date, 20) || new Date().toISOString().split('T')[0],
      department:       sanitizeStr(payload.department, 100),
      area:             sanitizeStr(payload.area, 150),
      description:      sanitizeStr(payload.description, 1000),
      potentialInjury:  sanitizeStr(payload.potentialInjury, 300),
      proposedSolution: sanitizeStr(payload.proposedSolution, 500),
      likelihood:       clampInt(payload.likelihood, 1, 5, 1),
      severity:         ['A','B','C','D','E'].includes(payload.severity) ? payload.severity : 'A',
      riskLevel:        ['L', 'M', 'H'].includes(payload.riskLevel) ? payload.riskLevel : 'L',
      status:           'open',
      actionTaken:      '',
      photoUrl:         photoUrl,
      deletedBy: { areaAdmin: false, safetyAdmin: false, superAdmin: false, worker: false },
      permanentlyDeletedBy: { areaAdmin: false, safetyAdmin: false, superAdmin: false, worker: false },
      submittedAt:      new Date().toISOString()
    };

    hazards.push(newHazard);
    if (writeHazards(hazards)) {
      scheduleHazardsExcelSync(hazards);
      
      createNotification({
        targetRole: 'admin',
        type: 'hazard',
        title: 'بلاغ خطورة جديد 🚨',
        message: `بلاغ خطورة جديد في ${newHazard.location || newHazard.area} - ${newHazard.description}`,
        link: 'tabSupHazard'
      });
      
      if (newHazard.empCode) {
        createNotification({
          targetEmpCode: newHazard.empCode,
          type: 'hazard',
          title: 'استلام البلاغ 📥',
          message: 'تم تسجيل بلاغك بنجاح وجارٍ مراجعته من قِبل السلامة',
          link: 'tabHazardWorker'
        });
      }
      
      result = { status: 201, body: { success: true, hazard: newHazard } };
    } else {
      result = { status: 500, body: { error: 'فشل حفظ البلاغ' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.get('/api/hazards/employee-stats', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin', 'maint_admin'), async (req, res) => {
  let hazards = readHazards();
  
  const fs = require('fs');
  const path = require('path');
  let employees = [];
  try {
    const empData = fs.readFileSync(path.join(__dirname, 'data', 'employees.json'), 'utf8');
    employees = JSON.parse(empData);
  } catch(e) {}

  if ((req.user.role === 'dept_admin' || req.user.role === 'maint_admin') && req.user.department) {
    employees = employees.filter(e => e.department === req.user.department);
  }
  
  const stats = employees.map(emp => {
    // Only count non-deleted hazards
    // FIX (2026-09): hazard reports store the employee code under `empCode`, never
    // under `reporterId` (that field is never set anywhere in the codebase — this
    // comparison always evaluated to false, so every employee's count was stuck at 0).
    const empCodeNorm = normalizeEmpCode(emp.code || emp.empCode || '');
    const empHazards = hazards.filter(h => normalizeEmpCode(h.empCode) === empCodeNorm && h.deleted !== true);
    return {
      code: emp.code,
      name: emp.name,
      department: emp.department,
      count: empHazards.length,
      target: 2
    };
  });
  
  res.json({ stats });
});

app.get('/api/hazards', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin', 'maint_admin'), async (req, res) => {
  let hazards = readHazards();
  let changed = false;
  const now = new Date().toISOString();
  const readerName = sanitizeStr(req.user.name || req.user.username || 'المشرف', 100);

  hazards.forEach(h => {
    if (!h.seenAt && req.user.role !== 'maint_admin') {
      h.seenAt = now;
      h.seenBy = readerName;
      changed = true;
    }
  });

  if (changed) {
    writeHazards(hazards);
  }
  
  if (req.user.role === 'dept_admin' && req.user.department) {
    const legacyNames = LEGACY_DEPARTMENT_ALIASES[req.user.department] || [];
    hazards = hazards.filter(h => h.department === req.user.department || legacyNames.includes(h.department));
  } else if (req.user.role === 'maint_admin' && req.user.department) {
    // maint_admin gets full department-head visibility (like dept_admin, scoped
    // to their own department) PLUS their extra maintenance work-order queue —
    // hazards routed to them for repair from other departments.
    const legacyNames = LEGACY_DEPARTMENT_ALIASES[req.user.department] || [];
    hazards = hazards.filter(h =>
      h.department === req.user.department || legacyNames.includes(h.department) || h.assignedToMaintenance === req.user.department
    );
  }

  res.json({ hazards });
});

app.get('/api/my-hazards/:name', (req, res) => {
  const reporterName = (req.params.name || '').trim();
  const empCodeQ = req.query.empCode ? normalizeEmpCode(req.query.empCode) : '';
  if (!reporterName && !empCodeQ) {
    return res.status(400).json({ error: 'الاسم أو الكود الوظيفي مطلوب' });
  }
  let hazards = readHazards();
  const myHazards = hazards.filter(h => {
    // Match by employee code first (works for both live reports and old bulk-imported
    // Excel records, which store the reporter under empName/empCode instead of reporterName)
    if (empCodeQ) {
      const hCode = normalizeEmpCode(h.empCode || h.code || h.employeeCode || '');
      if (hCode && hCode === empCodeQ) return true;
    }
    const hName = (h.reporterName || h.empName || h.reportedBy || '').trim();
    return !!(hName && reporterName && hName === reporterName);
  });
  res.json({ hazards: myHazards });
});

app.patch('/api/hazards/:id', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin', 'maint_admin'), async (req, res) => {
  const hazardId = req.params.id;
  const { action, targetMaintenance, assignNotes, maintenanceAction, maintenanceTeamNames, status, actionTaken } = req.body;

  let result;
  await enqueueWrite(async () => {
    let hazards = readHazards();
    const idx = hazards.findIndex(h => h.id === hazardId);
    if (idx === -1) {
      result = { status: 404, body: { error: 'البلاغ غير موجود' } };
      return;
    }

    const h = hazards[idx];
    const updater = sanitizeStr(req.user.name || req.user.username || 'المشرف', 100);
    const now = new Date().toISOString();
    const previousStatus = h.status;

    if (action === 'assign_maintenance') {
      const assignAllowedRoles = ['super_admin', 'hse_admin', 'hse_manager', 'hse'];
      if (!assignAllowedRoles.includes(req.user.role)) {
        result = { status: 403, body: { error: 'فقط مشرف السلامة يمكنه التوجيه للصيانة' } };
        return;
      }
      if (!targetMaintenance) {
        result = { status: 400, body: { error: 'قسم الصيانة المستهدف مطلوب' } };
        return;
      }
      h.assignedToMaintenance = sanitizeStr(targetMaintenance, 100);
      if (assignNotes) h.assignNotes = sanitizeStr(assignNotes, 500);
      h.forwardedByHseName = updater;
      h.forwardedByHseAt = now;
      h.treatmentStartedAt = h.treatmentStartedAt || now;
      h.assignedAt = h.assignedAt || now;
      h.status = 'assigned_to_maintenance';
      h.updatedBy = updater;
      delete h.maintRejectReason;
      delete h.hseRejectReason;

      const maintUsername = targetMaintenance.split(' ')[0].toLowerCase() + '_maintenance_admin';
      createNotification({
        targetUsername: maintUsername,
        type: 'hazard',
        title: 'بلاغ خطورة جديد',
        message: `تم توجيه بلاغ خطورة (${h.id}) إلى قسمكم من قبل ${updater}.`,
        link: 'tabSupHazard'
      });

    } else if (action === 'start_maintenance') {
      const startAllowedRoles = ['maint_admin', 'super_admin', 'hse_admin', 'hse_manager', 'hse'];
      if (!startAllowedRoles.includes(req.user.role)) {
        result = { status: 403, body: { error: 'غير مصرح ببدء الإصلاح' } };
        return;
      }
      if (req.user.role === 'maint_admin' && h.assignedToMaintenance !== req.user.department) {
        result = { status: 403, body: { error: 'هذا البلاغ غير موجه لقسمكم' } };
        return;
      }
      h.status = 'in_progress';
      h.startedAt = now;
      if (!h.treatmentStartedAt) h.treatmentStartedAt = now;
      h.startedByName = updater;
      h.startedBy = req.user ? (req.user.name || req.user.fullName || req.user.empCode) : 'فريق الصيانة';
      h.assignedTechName = h.startedBy;
      h.assignedTechCode = req.user ? req.user.empCode : '';
      h.updatedBy = updater;

    } else if (action === 'reject_maintenance' || action === 'reject_maint') {
      if (req.user.role !== 'maint_admin') {
        result = { status: 403, body: { error: 'فقط فريق الصيانة يمكنه رفض الإصلاح' } };
        return;
      }
      if (req.user.role === 'maint_admin' && h.assignedToMaintenance !== req.user.department) {
        result = { status: 403, body: { error: 'هذا البلاغ غير موجه لقسمكم' } };
        return;
      }
      const rejectReason = req.body.reason || req.body.rejectReason || req.body.rejectionReason;
      if (!rejectReason) {
        result = { status: 400, body: { error: 'سبب الرفض مطلوب' } };
        return;
      }
      h.status = 'rejected_by_maintenance';
      h.maintRejectReason = sanitizeStr(rejectReason, 500);
      h.maintRejectedBy = updater;
      h.maintRejectedAt = now;
      h.rejectedByMaintName = updater; // Legacy support
      h.rejectedByMaintAt = now; // Legacy support
      
      // Global reject fields for timeline sync
      h.rejectedAt = now;
      h.rejectedBy = updater;
      h.rejectionReason = h.maintRejectReason;
      
      h.updatedBy = updater;

      createNotification({
        targetRole: 'hse_admin',
        type: 'hazard',
        title: 'رفض بلاغ من الصيانة',
        message: `تم رفض البلاغ (${h.id}) من قسم ${h.assignedToMaintenance} بحجة عدم الاختصاص.`,
        link: 'tabSupHazard'
      });

    } else if (action === 'reject_hse' || action === 'reject') {
      if (req.user.role !== 'hse_admin' && req.user.role !== 'super_admin') {
        result = { status: 403, body: { error: 'غير مصرح' } };
        return;
      }
      const rejectReason = req.body.reason || req.body.rejectReason || req.body.rejectionReason;
      if (!rejectReason) {
        result = { status: 400, body: { error: 'سبب الرفض مطلوب' } };
        return;
      }
      h.status = 'rejected_by_hse';
      h.hseRejectReason = sanitizeStr(rejectReason, 500);
      h.hseRejectedBy = updater;
      h.hseRejectedAt = now;
      h.rejectedByHseName = updater; // Legacy support
      h.rejectedByHseAt = now; // Legacy support
      
      // Global reject fields for timeline sync
      h.rejectedAt = now;
      h.rejectedBy = updater;
      h.rejectionReason = h.hseRejectReason;
      
      h.updatedBy = updater;

      if (h.reporterId) {
        createNotification({
          targetEmpCode: h.reporterId,
          type: 'hazard',
          title: 'تم رفض بلاغ الخطورة',
          message: `تم رفض البلاغ (${h.id}) من قبل المشرف: ${h.hseRejectReason}`,
          link: 'tabMyHazards'
        });
      }

    } else if (action === 'resolve_maintenance') {
      const resolveAllowedRoles = ['maint_admin', 'super_admin', 'hse_admin', 'hse_manager', 'hse'];
      if (!resolveAllowedRoles.includes(req.user.role)) {
        result = { status: 403, body: { error: 'غير مصرح بإغلاق البلاغ' } };
        return;
      }
      if (req.user.role === 'maint_admin' && h.assignedToMaintenance !== req.user.department) {
        result = { status: 403, body: { error: 'هذا البلاغ غير موجه لقسمكم' } };
        return;
      }
      h.completedAt = now;
      if (!h.treatmentStartedAt) {
        h.treatmentStartedAt = now;
      }
      if (!h.startedAt) {
        h.startedAt = now;
        h.startedByName = updater;
      }
      h.status = 'resolved';
      h.resolvedBy = req.user ? (req.user.name || req.user.fullName || req.user.empCode) : 'فريق الصيانة';
      h.assignedTechName = h.resolvedBy;
      h.assignedTechCode = req.user ? req.user.empCode : '';
      h.maintenanceAction = sanitizeStr(maintenanceAction || '', 1000);
      h.maintenanceTeamNames = sanitizeStr(maintenanceTeamNames || '', 300);
      h.resolvedByMaintenanceName = updater;
      h.resolvedAt = now;
      h.status = 'resolved';
      h.updatedBy = updater;

      if (!h.inProgressAt) {
        h.inProgressAt = h.startedAt || h.resolvedAt;
        h.inProgressBy = h.startedByName || h.resolvedByMaintenanceName;
      }

      if (h.reporterId) {
        createNotification({
          targetEmpCode: h.reporterId,
          type: 'hazard',
          title: 'تم إصلاح الخطورة',
          message: `تم الانتهاء من إصلاح بلاغ الخطورة (${h.id}) الخاص بك بواسطة قسم الصيانة.`,
          link: 'tabMyHazards'
        });
      }
      createNotification({
        targetRole: 'hse_admin',
        type: 'hazard',
        title: 'إصلاح خطورة من الصيانة',
        message: `تم إصلاح بلاغ الخطورة (${h.id}) من قبل الصيانة.`,
        link: 'tabSupHazard'
      });
      if (h.department) {
        createNotification({
          targetDept: h.department,
          targetRole: 'dept_admin',
          type: 'hazard',
          title: 'إصلاح خطورة في قسمك',
          message: `تم إصلاح بلاغ الخطورة (${h.id}) في قسمك.`,
          link: 'tabSupHazard'
        });
      }
    } else if (status) {
      // Legacy status update
      if (req.user.role === 'dept_admin' && req.user.department && h.department !== req.user.department) {
         result = { status: 403, body: { error: 'ليس لديك صلاحية لتعديل هذا البلاغ' } };
         return;
      }
      h.status = status;
      if (actionTaken !== undefined) h.actionTaken = sanitizeStr(actionTaken, 1000);
      h.updatedBy = updater;
      
      if (status === 'resolved' || status === 'closed' || status === 'completed') {
        h.resolvedAt = h.resolvedAt || now;
        h.resolvedBy = h.resolvedBy || updater;
        if (!h.inProgressAt) {
          h.inProgressAt = h.resolvedAt;
          h.inProgressBy = h.resolvedBy;
        }
      }
    } else {
      result = { status: 400, body: { error: 'إجراء غير معروف' } };
      return;
    }

    // ── سجل تدقيق تاريخي دائم — نفس منطق تصاريح العمل أعلاه: يُضاف كحدث
    // جديد لا يُحذف ولا يُعدَّل أبدًا، بالتوازي مع تحديث حالة البلاغ نفسه.
    logAuditEvent({
      entityType: 'hazard',
      entityId: hazardId,
      action: action || `status:${status}`,
      actor: req.user,
      previousStatus,
      newStatus: h.status,
      note: req.body.reason || req.body.rejectReason || req.body.rejectionReason || assignNotes || ''
    });

    if (writeHazards(hazards)) {
      scheduleHazardsExcelSync(hazards);
      result = { status: 200, body: { success: true, hazard: h } };
    } else {
      result = { status: 500, body: { error: 'فشل التحديث' } };
    }
  });

  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ── GET /api/audit-log — عرض سجل التدقيق التاريخي (للإدارة والامتثال فقط)
// query params اختيارية: entityType (permit|hazard)، entityId (رقم طلب/بلاغ
// بعينه لعرض الـ Timeline الكامل له)، limit (افتراضي 200، أقصى 1000)
app.get('/api/audit-log', authenticateToken, requireRole('super_admin', 'hse_admin'), (req, res) => {
  try {
    let log = readAuditLog();
    const { entityType, entityId } = req.query;
    if (entityType) log = log.filter(e => e.entityType === entityType);
    if (entityId) log = log.filter(e => e.entityId === String(entityId));
    // الأحدث أولًا
    log = log.slice().reverse();
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    res.json({ total: log.length, entries: log.slice(0, limit) });
  } catch (err) {
    console.error('Audit log read error:', err);
    res.status(500).json({ error: 'فشل قراءة سجل التدقيق' });
  }
});

app.delete('/api/hazards/:id', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin', 'maint_admin'), async (req, res) => {
  const hazardId = req.params.id;
  const { reason } = req.body;
  let result;
  await enqueueWrite(async () => {
    let hazards = readHazards();
    const idx = hazards.findIndex(h => h.id === hazardId);
    if (idx === -1) {
      result = { status: 404, body: { error: 'البلاغ غير موجود' } };
      return;
    }
    const h = hazards[idx];
    if (req.user.role === 'dept_admin' && req.user.department && h.department !== req.user.department) {
       result = { status: 403, body: { error: 'لا تملك صلاحية حذف هذا البلاغ' } };
       return;
    }
    
    if (req.user.role === 'maint_admin') {
       const userDept = String(req.user.department || '').trim().toLowerCase();
       const hazardDept = String(h.department || '').trim().toLowerCase();
       const assignedDept = String(h.assignedToMaintenance || '').trim().toLowerCase();

       // Case 1: a hazard reported against Maintenance's own department —
       // behave exactly like a regular dept_admin deleting their own report.
       if (hazardDept && hazardDept === userDept) {
          const roleKey = getRoleKey(req.user.role);
          h.deletedBy = h.deletedBy && typeof h.deletedBy === 'object'
            ? h.deletedBy
            : { areaAdmin: false, safetyAdmin: false, superAdmin: false, worker: false };
          h.deletedBy[roleKey] = true;
          h.lastDeletedByUsername = req.user?.username || 'Admin';
          writeHazards(hazards);
          result = { status: 200, body: { success: true } };
          return;
       }

       // Case 2: a repair ticket routed to Maintenance from another department —
       // existing "reject from maintenance queue" workflow.
       if (assignedDept !== userDept && h.status !== 'rejected_by_maintenance') {
           result = { status: 403, body: { error: 'لا تملك صلاحية حذف بلاغ غير موجه لقسمك' } };
           return;
       }
       // Smart Maintenance Delete Isolation
       h.deletedByMaintenance = true;
       h.maintenanceDeletedBy = sanitizeStr(req.user.name || req.user.username, 100);
       h.maintenanceDeletedDept = req.user.department;
       h.status = 'rejected_by_maintenance';
       h.maintRejectReason = sanitizeStr(reason || 'تم حذف/رفض البلاغ من قسم الصيانة ' + req.user.department, 1000);
       h.maintRejectedBy = h.maintenanceDeletedBy;
       h.maintRejectedAt = new Date().toISOString();
       
       writeHazards(hazards);
       result = { status: 200, body: { success: true } };
       return;
    }

    const role = req.user?.role;
    const roleKey = getRoleKey(role);
    h.deletedBy = h.deletedBy && typeof h.deletedBy === 'object'
      ? h.deletedBy
      : { areaAdmin: false, safetyAdmin: false, superAdmin: false, worker: false };
    h.deletedBy[roleKey] = true;
    h.lastDeletedByUsername = req.user?.username || 'Admin';

    writeHazards(hazards);
    result = { status: 200, body: { success: true } };
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.post('/api/hazards/:id/restore', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin', 'maint_admin'), async (req, res) => {
  const hazardId = req.params.id;
  let result;
  await enqueueWrite(async () => {
    let hazards = readHazards();
    const idx = hazards.findIndex(h => h.id === hazardId);
    if (idx === -1) {
      result = { status: 404, body: { error: 'البلاغ غير موجود' } };
      return;
    }
    const h = hazards[idx];
    if (req.user.role === 'dept_admin' && req.user.department && h.department !== req.user.department) {
       result = { status: 403, body: { error: 'لا تملك صلاحية استعادة هذا البلاغ' } };
       return;
    }
    
    if (req.user.role === 'maint_admin') {
       const userDept = String(req.user.department || '').trim().toLowerCase();
       const hazardDept = String(h.department || '').trim().toLowerCase();
       const assignedDept = String(h.assignedToMaintenance || '').trim().toLowerCase();

       // Case 1: their own department's report, deleted via the normal
       // dept_admin-style deletedBy flag — restore it the same way.
       if (hazardDept && hazardDept === userDept && !h.deletedByMaintenance) {
          const roleKey = getRoleKey(req.user.role);
          if (h.deletedBy && typeof h.deletedBy === 'object') {
            h.deletedBy[roleKey] = false;
          }
          h.permanentlyDeletedBy = h.permanentlyDeletedBy || { areaAdmin: false, safetyAdmin: false, superAdmin: false, worker: false };
          h.permanentlyDeletedBy[roleKey] = false;
          h.deleted = false;
          writeHazards(hazards);
          result = { status: 200, body: { success: true } };
          return;
       }

       if (assignedDept !== userDept && h.maintenanceDeletedDept !== req.user.department) {
           result = { status: 403, body: { error: 'لا تملك صلاحية استعادة هذا البلاغ' } };
           return;
       }
       h.deletedByMaintenance = false;
       delete h.maintenanceDeletedBy;
       delete h.maintenanceDeletedDept;
       h.status = 'assigned_to_maintenance';
       delete h.maintRejectReason;
       delete h.maintRejectedBy;
       delete h.maintRejectedAt;
       writeHazards(hazards);
       result = { status: 200, body: { success: true } };
       return;
    }

    const role = req.user?.role;
    const roleKey = getRoleKey(role);
    if (h.deletedBy && typeof h.deletedBy === 'object') {
      h.deletedBy[roleKey] = false;
    }
    h.permanentlyDeletedBy = h.permanentlyDeletedBy || { areaAdmin: false, safetyAdmin: false, superAdmin: false, worker: false };
    h.permanentlyDeletedBy[roleKey] = false;

    // clean legacy
    h.deleted = false;

    writeHazards(hazards);
    result = { status: 200, body: { success: true } };
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.delete('/api/hazards/:id/permanent', authenticateToken, requireRole('super_admin', 'hse_admin', 'maint_admin'), async (req, res) => {
  const hazardId = req.params.id;
  let result;
  await enqueueWrite(async () => {
    let hazards = readHazards();
    const idx = hazards.findIndex(h => h.id === hazardId);
    if (idx === -1) {
      result = { status: 404, body: { error: 'البلاغ غير موجود' } };
      return;
    }
    const h = hazards[idx];
    if (req.user.role === 'maint_admin') {
       const userDept = String(req.user.department || '').trim().toLowerCase();
       if (h.maintenanceDeletedDept !== req.user.department) {
           result = { status: 403, body: { error: 'لا تملك صلاحية حذف هذا البلاغ نهائياً' } };
           return;
       }
       h.deletedByMaintenance = false;
       delete h.maintenanceDeletedBy;
       delete h.maintenanceDeletedDept;
       writeHazards(hazards);
       result = { status: 200, body: { success: true } };
       return;
    }

    const role = req.user?.role;
    const roleKey = getRoleKey(role);

    if (h.deletedBy && typeof h.deletedBy === 'object' && !h.deletedBy[roleKey] && !h.deleted) {
      result = { status: 400, body: { error: 'البلاغ ليس في سلة المحذوفات الخاصة بك' } };
      return;
    }

    h.permanentlyDeletedBy = h.permanentlyDeletedBy || { areaAdmin: false, safetyAdmin: false, superAdmin: false, worker: false };
    h.permanentlyDeletedBy[roleKey] = true;

    // Only completely remove if ALL roles have permanently deleted it
    const perm = h.permanentlyDeletedBy;
    if (perm.areaAdmin && perm.safetyAdmin && perm.superAdmin && perm.worker) {
      hazards.splice(idx, 1);
    }

    writeHazards(hazards);
    result = { status: 200, body: { success: true } };
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.get('/api/export-hazards', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin', 'maint_admin'), async (req, res) => {
  try {
    let hazards = readHazards();
    
    if (req.user && req.user.role === 'dept_admin' && req.user.department) {
      hazards = hazards.filter(h => h.department === req.user.department);
    } else if (req.user && req.user.role === 'maint_admin' && req.user.department) {
      hazards = hazards.filter(h =>
        h.department === req.user.department || h.assignedToMaintenance === req.user.department
      );
    }

    if (!hazards || hazards.length === 0) {
      return res.status(404).json({ error: 'لا توجد بيانات بلاغات حالياً للتصدير' });
    }

    // Ensure all historical records are backfilled before exporting
    hazards = hazards.map(backfillHazardTimestamps);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('بلاغات الخطورة');

    const formatDateTime = (isoStr) => {
      if (!isoStr) return '';
      const d = new Date(isoStr);
      return d.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });
    };

    worksheet.columns = [
      { header: 'كود البلاغ',       key: 'id',               width: 18 },
      { header: 'تاريخ البلاغ',     key: 'date',             width: 15 },
      { header: 'وقت الإرسال الدقيق', key: 'submittedAt',      width: 20 },
      { header: 'مقدم البلاغ',      key: 'reporterName',     width: 20 },
      { header: 'القسم',            key: 'department',       width: 15 },
      { header: 'المنطقة',          key: 'area',             width: 20 },
      { header: 'وصف الخطورة',      key: 'description',      width: 40 },
      { header: 'الإصابة المحتملة', key: 'potentialInjury',  width: 30 },
      { header: 'الحل المقترح',     key: 'proposedSolution', width: 30 },
      { header: 'مستوى الخطورة',    key: 'riskLevel',        width: 15 },
      { header: 'الحالة الحالية',   key: 'status',           width: 20 },
      { header: 'وقت مشاهدة المشرف للبلاغ', key: 'seenAt',    width: 30 },
      { header: 'وقت بدء الإصلاح والمعالجة', key: 'inProgressAt', width: 30 },
      { header: 'وقت الإغلاق والانتهاء', key: 'resolvedAt',     width: 30 },
      { header: 'الإجراء المتخذ وملاحظات المشرف', key: 'actionTaken', width: 40 }
    ];

    hazards.forEach(h => {
      let riskStr = h.riskLevel === 'H' ? 'High 🔴' : h.riskLevel === 'M' ? 'Medium 🟡' : 'Low 🟢';
      let statusStr = 'مفتوح 🔴';
      if (h.status === 'notified') statusStr = 'تم الإبلاغ 📢';
      if (h.status === 'in_progress') statusStr = 'قيد الإصلاح 🟡';
      if (h.status === 'resolved' || h.status === 'closed') statusStr = 'تم الحل والإغلاق 🟢';
      
      let finalAction = h.actionTaken ? `${h.actionTaken} (${h.updatedBy || 'المشرف'})` : 'لا يوجد';

      worksheet.addRow({
        id:               h.id || '',
        date:             h.date || '',
        submittedAt:      formatDateTime(h.submittedAt || h.createdAt),
        reporterName:     h.reporterName || '',
        department:       h.department || '',
        area:             h.area || '',
        description:      h.description || '',
        potentialInjury:  h.potentialInjury || '',
        proposedSolution: h.proposedSolution || '',
        riskLevel:        riskStr,
        status:           statusStr,
        seenAt:           h.seenAt ? `${formatDateTime(h.seenAt)} (${h.seenBy || 'المشرف'})` : 'لم يُشاهد بعد',
        inProgressAt:     h.inProgressAt ? `${formatDateTime(h.inProgressAt)} (${h.inProgressBy || 'الصيانة'})` : 'لم يبدأ بعد',
        resolvedAt:       h.resolvedAt ? `${formatDateTime(h.resolvedAt)} (${h.resolvedBy || 'المشرف'})` : 'لم ينتهِ بعد',
        actionTaken:      finalAction
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Hazard_Reports_${Date.now()}.xlsx"`);

    await workbook.xlsx.write(res);
    return res.end();
  } catch (error) {
    console.error('Error exporting hazards:', error);
    return res.status(500).json({ error: 'فشل تصدير البيانات' });
  }
});
// ── DELETE /api/permits/:id — Soft Delete الطلب
app.delete('/api/permits/:id', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin', 'maint_admin'), async (req, res) => {
  const permitId = req.params.id;
  const { reason } = req.body;
  if (!reason) {
    return res.status(400).json({ error: 'سبب الحذف مطلوب' });
  }

  let result;
  await enqueueWrite(async () => {
    const storage = readStorage();
    let permits = [];
    if (storage['work-permits']) {
      try { permits = JSON.parse(storage['work-permits']); } catch { permits = []; }
    }

    const idx = permits.findIndex(p => String(p.id) === String(permitId));
    if (idx === -1) {
      result = { status: 404, body: { error: 'Permit not found' } };
      return;
    }

    const permit = permits[idx];
    const role = req.user?.role || req.body?.role;
    const roleKey = getRoleKey(role);

    // Normalize deletedBy
    permit.deletedBy = permit.deletedBy && typeof permit.deletedBy === 'object' 
      ? permit.deletedBy 
      : { areaAdmin: false, safetyAdmin: false, superAdmin: false, worker: false };

    // Set soft-delete ONLY for the calling role
    permit.deletedBy[roleKey] = true;
    permit.lastDeletedByUsername = req.user?.username || req.body?.username || 'Admin';

    // State transitions when deleted before approval
    if (roleKey === 'areaAdmin') {
      if (['pending', 'pending_dept', 'pending_area_head'].includes(permit.status)) {
        permit.status = 'rejected_area';
        permit.rejectionReason = 'مرفوض من رئيس القسم';
      }
    } else if (roleKey === 'safetyAdmin' || roleKey === 'superAdmin') {
      if (['pending', 'pending_dept', 'pending_hse', 'approved_area'].includes(permit.status)) {
        permit.status = 'rejected_high_management';
        permit.rejectionReason = 'مرفوض من الإدارة العليا';
      }
    }

    storage['work-permits'] = JSON.stringify(permits);
    if (writeStorage(storage)) {
      result = { status: 200, body: { success: true } };
    } else {
      result = { status: 500, body: { error: 'فشل عملية الحذف' } };
    }
  });

  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ── PATCH /api/permits/:id/employee-code — إضافة/تعديل الكود الوظيفي على تصريح
// (خصوصًا التصاريح القديمة المستوردة من Excel والتي لا يوجد لها كود وظيفي،
// عشان لو حصل بلاغ يتقدر يتعرف على الكود بتاع الموظف صاحب التصريح).
app.patch('/api/permits/:id/employee-code', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin', 'maint_admin'), async (req, res) => {
  const permitId = req.params.id;
  const { employeeId } = req.body;
  const trimmedCode = String(employeeId || '').trim();

  if (!trimmedCode) {
    return res.status(400).json({ error: 'الكود الوظيفي مطلوب' });
  }

  // الكود لازم يكون مسجل فعليًا في قاعدة بيانات الموظفين
  const employees = readEmployees();
  const searchCode = normalizeEmpCode(trimmedCode);
  const employee = employees.find(e => {
    const code = normalizeEmpCode(String(e.empCode || e.code || e.id || '').trim());
    return code === searchCode;
  });
  if (!employee) {
    return res.status(404).json({ error: `الكود الوظيفي (${trimmedCode}) غير مسجل في قاعدة بيانات الموظفين` });
  }

  let result;
  await enqueueWrite(async () => {
    const storage = readStorage();
    let permits = [];
    if (storage['work-permits']) {
      try { permits = JSON.parse(storage['work-permits']); } catch { permits = []; }
    }

    const idx = permits.findIndex(p => String(p.id) === String(permitId));
    if (idx === -1) {
      result = { status: 404, body: { error: 'Permit not found' } };
      return;
    }

    // dept_admin (رئيس قسم) و maint_admin (مشرف صيانة) يقدروا يعدلوا بس التصاريح الخاصة بقسمهم
    if ((req.user.role === 'dept_admin' || req.user.role === 'maint_admin') && req.user.department && !deptMatches(permits[idx].department, req.user.department)) {
      result = { status: 403, body: { error: 'غير مصرح لك بتعديل تصاريح قسم آخر' } };
      return;
    }

    permits[idx].employeeId = employee.empCode || employee.code || trimmedCode;
    // نحدّث اسم الموظف كمان لو ماكنش موجود أو كان مختلف — يفيد في تصاريح استيراد Excel القديمة
    if (!permits[idx].workerName) permits[idx].workerName = employee.name || permits[idx].workerName;
    permits[idx].employeeCodeAddedBy = req.user.username || 'admin';
    permits[idx].employeeCodeAddedAt = new Date().toISOString();

    storage['work-permits'] = JSON.stringify(permits);
    if (writeStorage(storage)) {
      result = { status: 200, body: { success: true, permit: permits[idx] } };
    } else {
      result = { status: 500, body: { error: 'فشل حفظ الكود الوظيفي' } };
    }
  });

  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ── POST /api/permits/:id/restore — استعادة الطلب المحذوف
app.post('/api/permits/:id/restore', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin', 'maint_admin'), async (req, res) => {
  const permitId = req.params.id;
  
  let result;
  await enqueueWrite(async () => {
    const storage = readStorage();
    let permits = [];
    if (storage['work-permits']) {
      try { permits = JSON.parse(storage['work-permits']); } catch { permits = []; }
    }

    const idx = permits.findIndex(p => p.id === permitId);
    if (idx === -1) {
      result = { status: 404, body: { error: 'الطلب غير موجود' } };
      return;
    }

    const role = req.user?.role;
    const roleKey = getRoleKey(role);
    
    if (permits[idx].deletedBy) {
      permits[idx].deletedBy[roleKey] = false;
    }
    permits[idx].permanentlyDeletedBy = permits[idx].permanentlyDeletedBy || { areaAdmin: false, safetyAdmin: false, superAdmin: false, worker: false };
    permits[idx].permanentlyDeletedBy[roleKey] = false;

    delete permits[idx].deletedAt;
    delete permits[idx].deleteReason;
    
    if (permits[idx].status === 'rejected_area' || permits[idx].status === 'rejected_high_management') {
       permits[idx].status = 'pending_dept';
    }

    storage['work-permits'] = JSON.stringify(permits);
    if (writeStorage(storage)) {
      result = { status: 200, body: { success: true } };
    } else {
      result = { status: 500, body: { error: 'فشل استعادة الطلب' } };
    }
  });

  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ── DELETE /api/permits/:id/permanent — الحذف النهائي للطلب
app.delete('/api/permits/:id/permanent', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin', 'maint_admin'), async (req, res) => {
  const permitId = req.params.id;
  
  let result;
  await enqueueWrite(async () => {
    const storage = readStorage();
    let permits = [];
    if (storage['work-permits']) {
      try { permits = JSON.parse(storage['work-permits']); } catch { permits = []; }
    }

    const idx = permits.findIndex(p => p.id === permitId);
    if (idx === -1) {
      result = { status: 404, body: { error: 'الطلب غير موجود' } };
      return;
    }

    const role = req.user?.role;
    const roleKey = getRoleKey(role);

    if (permits[idx].deletedBy && !permits[idx].deletedBy[roleKey]) {
      result = { status: 400, body: { error: 'الطلب ليس في سلة المحذوفات الخاصة بك' } };
      return;
    }

    permits[idx].permanentlyDeletedBy = permits[idx].permanentlyDeletedBy || { areaAdmin: false, safetyAdmin: false, superAdmin: false, worker: false };
    permits[idx].permanentlyDeletedBy[roleKey] = true;

    // Only completely remove if ALL roles have permanently deleted it
    const perm = permits[idx].permanentlyDeletedBy;
    if (perm.areaAdmin && perm.safetyAdmin && perm.superAdmin && perm.worker) {
      permits.splice(idx, 1);
    }

    storage['work-permits'] = JSON.stringify(permits);
    if (writeStorage(storage)) {
      result = { status: 200, body: { success: true } };
    } else {
      result = { status: 500, body: { error: 'فشل الحذف النهائي' } };
    }
  });

  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ============================================================
// 🔑 API ROUTES — AUTH
// ============================================================

// ── PATCH /api/permits/:id/worker-close — إغلاق الطلب من قِبل الموظف
// لا يتطلب JWT — التحقق من الملكية يتم عبر employeeId
app.patch('/api/permits/:id/worker-close', async (req, res) => {
  const permitId = req.params.id;
  const { employeeId, closureType, closureReason } = req.body;

  const VALID_CLOSURE = ['safe', 'incomplete', 'forced'];
  if (!employeeId) {
    return res.status(400).json({ error: 'الكود الوظيفي مطلوب للإغلاق' });
  }
  if (!closureType || !VALID_CLOSURE.includes(closureType)) {
    return res.status(400).json({ error: 'نوع الإغلاق غير صالح. المتاح: safe | incomplete | forced' });
  }

  let result;
  await enqueueWrite(async () => {
    const storage = readStorage();
    let permits = [];
    if (storage['work-permits']) {
      try { permits = JSON.parse(storage['work-permits']); } catch { permits = []; }
    }

    const idx = permits.findIndex(p => p.id === permitId);
    if (idx === -1) {
      result = { status: 404, body: { error: 'الطلب غير موجود' } };
      return;
    }

    // Ownership check: only the worker who submitted can close it
    if (!permits[idx].employeeId ||
        permits[idx].employeeId.toLowerCase() !== String(employeeId).toLowerCase()) {
      result = { status: 403, body: { error: 'غير مصرح لك بإغلاق هذا الطلب' } };
      return;
    }

    // Only approved permits can be closed by workers
    if (permits[idx].status !== 'approved') {
      result = { status: 409, body: { error: 'يمكن إغلاق الطلبات الموافق عليها فقط' } };
      return;
    }

    const now = new Date().toISOString();
    permits[idx].status  = 'closed_' + closureType;
    permits[idx].closure = {
      type:     closureType,
      reason:   sanitizeStr(closureReason, 300),
      time:     now,
      closedBy: sanitizeStr(String(employeeId), 50) + ' (worker)'
    };

    const newValue = JSON.stringify(permits);
    storage['work-permits'] = newValue;
    if (writeStorage(storage)) {
      schedulePermitsExcelSync(newValue);
      
      createNotification({
        targetRole: 'admin',
        type: 'permit',
        title: 'إغلاق طلب من العامل 🔒',
        message: `تم إنهاء وإغلاق الطلب رقم ${permits[idx].id} من قِبل ${permits[idx].workerName || employeeId}`,
        link: 'tabPermits'
      });
      
      createNotification({
        targetEmpCode: permits[idx].employeeId,
        type: 'permit',
        title: 'تأكيد إغلاق الطلب ✅',
        message: 'تم إغلاق الطلب بسلامة',
        link: 'tabMyHistory'
      });
      
      result = { status: 200, body: { success: true, permit: permits[idx] } };
    } else {
      result = { status: 500, body: { error: 'فشل حفظ الإغلاق' } };
    }
  });

  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ============================================================

// ── POST /api/auth/login — تسجيل الدخول (rate-limited)
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password, empCode } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'يجب إدخال اسم المستخدم وكلمة المرور' });
  }

  const storage = readStorage();
  let users = [];
  if (storage['app-users']) {
    try { users = JSON.parse(storage['app-users']); } catch { users = []; }
  }

  // Normalize and trim inputs
  const usernameStr = String(username || '').trim().toLowerCase();
  const empCodeStr = String(empCode || '').trim();

  // Find user ignoring case
  const user = users.find(u => String(u.username || '').trim().toLowerCase() === usernameStr);
  if (!user) {
    console.log(`[LOGIN ERROR] Username not found: ${usernameStr}`);
    // Fake bcrypt to prevent timing attacks
    await bcrypt.compare(password, '$2b$12$invalidhashtopreventtimingattack000000000000');
    return res.status(401).json({ error: `اسم المستخدم غير موجود: ${usernameStr}` });
  }

  // Check password (support both plaintext and bcrypt)
  let isMatch = false;
  if (user.password.startsWith('$2')) {
    isMatch = await bcrypt.compare(password, user.password);
  } else {
    isMatch = (password === user.password); // Fallback for plaintext
  }

  if (!isMatch) {
    console.log(`[LOGIN ERROR] Invalid password for username: ${usernameStr}`);
    return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
  }

  // Check empCode in employees sheet — يجب إن الكود الوظيفي يبقى موظف
  // متسجل فعليًا عندنا، للجميع (سوبر أدمن أو أدمن قسم)، من غير أي استثناء.
  const employees = readEmployees();
  const searchCode = normalizeEmpCode(empCodeStr);
  let employee = employees.find(e => {
    const code = normalizeEmpCode(String(e.empCode || e.code || e.id || '').trim());
    return code === searchCode;
  });

  if (!employee) {
    console.log(`[LOGIN ERROR] EmpCode not found in employees DB: ${empCodeStr}`);
    return res.status(401).json({ error: `الكود الوظيفي (${empCodeStr}) غير مسجل في قاعدة بيانات الموظفين` });
  }

  // Check department authorization for ALL department-scoped admin roles.
  // dept_admin و maint_admin (كهرباء/ميكانيكا/وقائية) لازم الكود الوظيفي يبقى
  // مسجل فعليًا تحت نفس قسم الأدمن. hse_admin لازم الكود يبقى مسجل تحت قسم HSE.
  // super_admin فقط هو المسموح له بأي كود موظف مسجل (بدون تقييد بقسم).
  const DEPT_SCOPED_ROLES = ['dept_admin', 'maint_admin', 'hse_admin'];
  if (DEPT_SCOPED_ROLES.includes(user.role)) {
    const empDept = String(employee.department || '').trim().toLowerCase();
    // hse_admin ليس له قسم مخزن في جدول المستخدمين (department: '')، لكن
    // المطلوب أن يكون الكود الوظيفي مسجل تحت قسم "HSE" بالتحديد.
    const requiredDept = (user.role === 'hse_admin') ? 'HSE' : (user.department || '');
    const adminDept = String(requiredDept).trim().toLowerCase();
    if (!adminDept || empDept !== adminDept) {
      console.log(`[LOGIN ERROR] Dept mismatch for role ${user.role}. Emp Dept: ${empDept}, Required Dept: ${adminDept}`);
      return res.status(403).json({ error: `الموظف مسجل بقسم (${employee.department || 'غير محدد'}) وغير مصرح له بتسجيل الدخول على هذا الحساب (${requiredDept})` });
    }
  }

  // إدراج القسم الفعلي واسم المشرف الفعلي في الـ Token
  const tokenPayload = {
    id:         user.id || employee.id || employee.empCode,
    username:   user.username,
    role:       user.role || employee.role || 'worker',
    name:       employee.name,
    fullName:   employee.name,
    empCode:    employee.empCode || searchCode || empCodeStr,
    department: user.department || employee.department || ''
  };

  // Dynamic role patches for legacy compatibility
  if (tokenPayload.role === 'dept_admin') {
    if (tokenPayload.department && tokenPayload.department.toUpperCase() === 'HSE') {
      tokenPayload.role = 'hse_admin';
      tokenPayload.department = '';
    } else if (tokenPayload.department && ['Electrical Maintenance', 'Mechanical Maintenance', 'Preventive Maintenance'].includes(tokenPayload.department)) {
      tokenPayload.role = 'maint_admin';
    }
  }
  if (tokenPayload.username === 'hse_admin') tokenPayload.role = 'hse_admin';

  const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES });

  res.json({
    success: true,
    token,
    mustChangePassword: user.mustChangePassword === true,
    user: { id: user.id, username: user.username, role: tokenPayload.role, name: employee.name, department: tokenPayload.department }
  });
});

// ── POST /api/auth/change-password — تغيير المستخدم لكلمة مروره الخاصة
// يتطلب توكن صالح + كلمة المرور الحالية الصحيحة. يُستخدم خصوصًا لإجبار
// أصحاب الحسابات الافتراضية/المولَّدة تلقائيًا (كلمة مرور معروفة مثل
// admin123 / 123456) على تعيين كلمة مرور خاصة بهم قبل الاستمرار.
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'كلمة المرور الحالية والجديدة مطلوبتان' });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: 'كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف' });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تختلف عن الحالية' });
  }

  let result;
  await enqueueWrite(async () => {
    const storage = readStorage();
    let users = [];
    if (storage['app-users']) {
      try { users = JSON.parse(storage['app-users']); } catch { users = []; }
    }
    const idx = users.findIndex(u => u.id === req.user.id || String(u.username || '').toLowerCase() === String(req.user.username || '').toLowerCase());
    if (idx === -1) {
      result = { status: 404, body: { error: 'المستخدم غير موجود' } };
      return;
    }

    const stored = users[idx];
    const isMatch = stored.password && stored.password.startsWith('$2')
      ? await bcrypt.compare(currentPassword, stored.password)
      : currentPassword === stored.password;
    if (!isMatch) {
      result = { status: 401, body: { error: 'كلمة المرور الحالية غير صحيحة' } };
      return;
    }

    users[idx].password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    users[idx].mustChangePassword = false;
    storage['app-users'] = JSON.stringify(users);
    writeStorage(storage);
    result = { status: 200, body: { success: true, message: 'تم تغيير كلمة المرور بنجاح' } };
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ── POST /api/auth/refresh — تجديد الـ Token (للجلسات الطويلة)
app.post('/api/auth/refresh', authenticateToken, (req, res) => {
  const tokenPayload = {
    id:       req.user.id,
    username: req.user.username,
    role:     req.user.role,
    name:     req.user.name
  };
  const newToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  res.json({ success: true, token: newToken });
});

// ============================================================
// 👥 API ROUTES — USER MANAGEMENT (superadmin only)
// ============================================================

// ── GET /api/users — قائمة المستخدمين
app.get('/api/users',
  authenticateToken,
  requireRole('super_admin'),
  (req, res) => {
    const storage = readStorage();
    let users = [];
    if (storage['app-users']) {
      try { users = JSON.parse(storage['app-users']); } catch { users = []; }
    }
    // Return data without passwords — include department for area_head users
    const safeUsers = users.map(u => ({
      id:         u.id,
      username:   u.username,
      role:       u.role,
      name:       u.name,
      department: u.department || '',
      createdAt:  u.createdAt
    }));
    res.json({ users: safeUsers });
  }
);

// ── POST /api/users — إضافة مستخدم جديد
app.post('/api/users',
  authenticateToken,
  requireRole('super_admin'),
  async (req, res) => {
    const { username, password, role, name } = req.body;

    if (!username || !password || !role || !name) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    }
    const VALID_ROLES = ['super_admin', 'hse_admin', 'dept_admin'];
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `الدور غير صالح. الأدوار المتاحة: ${VALID_ROLES.join(', ')}` });
    }
    if (role === 'dept_admin' && !req.body.department) {
      return res.status(400).json({ error: 'يجب تحديد القسم لرئيس القسم' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    }

    let result;
    await enqueueWrite(async () => {
      const storage = readStorage();
      let users = [];
      if (storage['app-users']) {
        try { users = JSON.parse(storage['app-users']); } catch { users = []; }
      }

      if (users.find(u => u.username === username)) {
        result = { status: 409, body: { error: 'اسم المستخدم موجود بالفعل' } };
        return;
      }

      const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const newUser = {
        id:         'user-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
        username:   username.trim(),
        password:   hashedPassword,
        role:       role,
        name:       name.trim(),
        department: role === 'dept_admin' ? (req.body.department || '').trim() : '',
        createdAt:  new Date().toISOString()
      };
      users.push(newUser);
      storage['app-users'] = JSON.stringify(users);

      if (writeStorage(storage)) {
        result = {
          status: 200,
          body: { success: true, user: { id: newUser.id, username: newUser.username, role: newUser.role, name: newUser.name } }
        };
      } else {
        result = { status: 500, body: { error: 'فشل حفظ المستخدم' } };
      }
    });

    res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
  }
);

// ── DELETE /api/users/:id — حذف مستخدم
app.delete('/api/users/:id',
  authenticateToken,
  requireRole('super_admin'),
  async (req, res) => {
    const userId = req.params.id;

    let result;
    await enqueueWrite(async () => {
      const storage = readStorage();
      let users = [];
      if (storage['app-users']) {
        try { users = JSON.parse(storage['app-users']); } catch { users = []; }
      }

      const userToDelete = users.find(u => u.id === userId);
      if (!userToDelete) {
        result = { status: 404, body: { error: 'المستخدم غير موجود' } };
        return;
      }
      if (userToDelete.role === 'super_admin') {
        result = { status: 403, body: { error: 'لا يمكن حذف حساب المدير العام' } };
        return;
      }

      const newUsers = users.filter(u => u.id !== userId);
      storage['app-users'] = JSON.stringify(newUsers);

      if (writeStorage(storage)) {
        result = { status: 200, body: { success: true } };
      } else {
        result = { status: 500, body: { error: 'فشل حذف المستخدم' } };
      }
    });

    res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
  }
);

// ── PUT /api/users/:id — تعديل بيانات المستخدم كاملة
app.put('/api/users/:id',
  authenticateToken,
  requireRole('super_admin'),
  async (req, res) => {
    const userId = req.params.id;
    const { name, username, role, department, newPassword } = req.body;

    if (!name || !username || !role) {
      return res.status(400).json({ error: 'الاسم واسم المستخدم والدور مطلوبة' });
    }

    if (newPassword && newPassword.length < 6) {
      return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    }

    let result;
    await enqueueWrite(async () => {
      const storage = readStorage();
      let users = [];
      if (storage['app-users']) {
        try { users = JSON.parse(storage['app-users']); } catch { users = []; }
      }

      const idx = users.findIndex(u => u.id === userId);
      if (idx === -1) {
        result = { status: 404, body: { error: 'المستخدم غير موجود' } };
        return;
      }

      // Check username uniqueness if changed
      if (username !== users[idx].username && users.some(u => u.username === username)) {
        result = { status: 400, body: { error: 'اسم المستخدم مسجل مسبقاً' } };
        return;
      }

      users[idx].name = name;
      users[idx].username = username;
      users[idx].role = role;
      users[idx].department = role === 'dept_admin' ? department : '';

      if (newPassword) {
        users[idx].password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      }

      storage['app-users'] = JSON.stringify(users);

      if (writeStorage(storage)) {
        result = { status: 200, body: { success: true } };
      } else {
        result = { status: 500, body: { error: 'فشل التحديث' } };
      }
    });

    res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
  }
);

// ============================================================
// 👷 API ROUTES — EMPLOYEES
// ============================================================

// ── GET /api/employees/lookup/:code — بحث عام بالكود (Public)
// NOTE: Must be declared BEFORE /api/employees/:code to prevent route conflict
app.get('/api/employees/lookup/:code', (req, res) => {
  const searchCode = normalizeEmpCode(req.params.code);
  const employees = readEmployees();
  const emp = employees.find(e => normalizeEmpCode(e.code || e.empCode) === searchCode);
  if (!emp) return res.json({ found: false });

  const payload = {
    found: true,
    employee: {
      code:       emp.empCode,
      name:       emp.name       || '',
      department: emp.department  || '',
      jobTitle:   emp.jobTitle   || '',
      role:       emp.role       || 'worker',
      phone:      emp.phone      || ''
    }
  };

  // حساب "Executive View" الخاص بالمدير التنفيذي: نفس تسجيل الدخول بالكود
  // الوظيفي العادي، لكن الدور 'ceo' يستحق توكن JWT حقيقي لأنه يحتاج قراءة
  // مؤشرات الشركة كلها من endpoint محمي (read-only بالكامل — بدون أي صلاحية
  // كتابة أو تعديل مهما كان الدور المُرسَل في التوكن). 11 سبتمبر 2026.
  if (emp.role === 'ceo') {
    payload.token = jwt.sign(
      { id: emp.empCode, empCode: emp.empCode, username: emp.empCode, role: 'ceo', name: emp.name },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );
  }

  res.json(payload);
});

// ── GET /api/employees/export-excel — تصدير قاعدة الموظفين كـ xlsx
// Supports ?codes=EMP001,EMP002,... to export a filtered subset
app.get('/api/employees/export-excel',
  authenticateToken,
  requireRole('super_admin', 'hse_admin', 'dept_admin', 'maint_admin', 'issuer'),
  async (req, res) => {
    try {
      let employees = readEmployees();

      // Filter by specific codes if provided
      if (req.query.codes) {
        const requestedCodes = String(req.query.codes)
          .split(',')
          .map(c => normalizeEmpCode(c.trim()))
          .filter(Boolean);
        if (requestedCodes.length > 0) {
          employees = employees.filter(e => requestedCodes.includes(normalizeEmpCode(e.empCode || e.code || '')));
        }
      }

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('قاعدة الموظفين');
      ws.columns = [
        { header: 'الكود الوظيفي',  key: 'empCode',    width: 18 },
        { header: 'الاسم الكامل',   key: 'name',       width: 26 },
        { header: 'القسم',          key: 'department', width: 22 },
        { header: 'المسمى الوظيفي', key: 'jobTitle',   width: 22 },
        { header: 'الصلاحية',       key: 'role',       width: 15 },
        { header: 'رقم التليفون',   key: 'phone',      width: 18 },
      ];
      employees.forEach(e => ws.addRow({
        empCode:    e.empCode    || '',
        name:       e.name       || '',
        department: e.department || '',
        jobTitle:   e.jobTitle   || '',
        role:       e.role       || 'worker',
        phone:      e.phone      || ''
      }));
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD51E27' } };
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="employees_${Date.now()}.xlsx"`);
      await wb.xlsx.write(res);
      return res.end();
    } catch (err) {
      console.error('Export employees error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'فشل تصدير بيانات الموظفين' });
    }
  }
);

// ── POST /api/employees/import-excel — استيراد/دمج xlsx (base64)
app.post('/api/employees/import-excel',
  authenticateToken,
  requireRole('super_admin', 'hse_admin', 'dept_admin', 'maint_admin', 'issuer'),
  async (req, res) => {
    const { fileData } = req.body;
    if (!fileData) return res.status(400).json({ error: 'fileData (base64) مطلوب' });
    try {
      const buffer = Buffer.from(fileData, 'base64');
      const incoming = await parseEmployeesXlsx(buffer);
      if (incoming.length === 0) {
        return res.status(400).json({ error: 'الملف لا يحتوي على بيانات صالحة أو الأعمدة غير متوافقة' });
      }
      let addedCount = 0, updatedCount = 0;
      await enqueueWrite(async () => {
        const existing = readEmployees();
        const map = new Map(existing.map(e => [normalizeEmpCode(e.empCode).toLowerCase(), e]));
        incoming.forEach(emp => {
          const key = normalizeEmpCode(emp.empCode).toLowerCase();
          if (map.has(key)) {
            const old = map.get(key);
            map.set(key, {
              ...old,
              name:       emp.name       || old.name,
              department: emp.department || old.department,
              jobTitle:   emp.jobTitle   || old.jobTitle,
              role:       emp.role       !== 'worker' ? emp.role : (old.role || 'worker'),
              phone:      emp.phone      || old.phone,
              updatedAt:  new Date().toISOString()
            });
            updatedCount++;
          } else {
            map.set(key, { ...emp, registeredAt: new Date().toISOString() });
            addedCount++;
          }
        });
        writeEmployees(Array.from(map.values()));
      });
      res.json({ success: true, added: addedCount, updated: updatedCount, total: readEmployees().length });
    } catch (err) {
      console.error('Import employees error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'فشل قراءة ملف الإكسيل: ' + err.message });
    }
  }
);

// ── GET /api/employees — جلب كل الموظفين (محمي)
app.get('/api/employees',
  authenticateToken,
  requireRole('super_admin', 'hse_admin', 'dept_admin', 'maint_admin', 'issuer'),
  (req, res) => {
    let employees = readEmployees();
    
    // Department Isolation for Dept Admins and Maint Admins
    if (req.user.role === 'dept_admin' || req.user.role === 'maint_admin') {
      if (req.user.department) {
        employees = employees.filter(e => e.department === req.user.department);
      }
    }
    
    // Compute Hazards and Training Metrics
    const hazards = readHazards();
    const trainings = readTrainings();
    
    const hazardsMap = new Map();
    hazards.forEach(h => {
      if (h.deleted || h.status === 'rejected' || h.status === 'rejected_by_maintenance') return;
      const code = normalizeEmpCode(h.empCode);
      if (code) {
        if (!hazardsMap.has(code)) hazardsMap.set(code, []);
        hazardsMap.get(code).push(h.createdAt || h.date || new Date().toISOString());
      }
    });

    const trainingsMap = new Map();
    trainings.filter(t => !t.isDeleted).forEach(trn => {
      trn.attendees.forEach(att => {
        if (att.verified) {
          const code = normalizeEmpCode(att.empCode || att.code);
          if (code) {
            if (!trainingsMap.has(code)) trainingsMap.set(code, []);
            trainingsMap.get(code).push(trn.date || trn.createdAt || new Date().toISOString());
          }
        }
      });
    });

    const enrichedEmployees = employees.map(emp => {
      const code = normalizeEmpCode(emp.code || emp.empCode);
      const empTrainings = trainingsMap.get(code) || [];
      const empHazards = hazardsMap.get(code) || [];
      return {
        ...emp,
        hazardDates: empHazards,
        hazardCount: empHazards.length,
        trainingDates: empTrainings,
        trainingHours: empTrainings.length * 0.5
      };
    });

    res.json({ employees: enrichedEmployees });
  }
);

// ── POST /api/employees — إضافة موظف (محمي) أو تسجيل ذاتي (عام)
app.post('/api/employees', async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authenticateToken(req, res, () =>
      requireRole('super_admin', 'hse_admin', 'dept_admin', 'issuer')(req, res, next)
    );
  }
  return employeeLimiter(req, res, next);
}, async (req, res) => {
  const rawCode = (req.body.empCode || req.body.code || '').trim();
  const { name, phone, department, jobTitle, role } = req.body;
  if (!rawCode || !name) {
    return res.status(400).json({ error: 'الكود الوظيفي والاسم مطلوبان' });
  }
  let result;
  await enqueueWrite(async () => {
    const employees = readEmployees();
    const normalizedCode = normalizeEmpCode(rawCode);
    const idx = employees.findIndex(e => normalizeEmpCode(e.code || e.empCode) === normalizedCode);
    const validRoles = ['worker','supervisor','area_head','contractor'];
    if (idx !== -1) {
      employees[idx] = {
        ...employees[idx],
        name:       sanitizeStr(name, 100),
        phone:      sanitizeStr(phone || '', 20),
        department: sanitizeStr(department || '', 100),
        jobTitle:   sanitizeStr(jobTitle || employees[idx].jobTitle || '', 100),
        role:       validRoles.includes(role) ? role : (employees[idx].role || 'worker'),
        updatedAt:  new Date().toISOString()
      };
      writeEmployees(employees);
      result = { status: 200, body: { success: true, employee: employees[idx] } };
    } else {
      const newEmp = {
        empCode:      normalizedCode,
        name:         sanitizeStr(name, 100),
        phone:        sanitizeStr(phone || '', 20),
        department:   sanitizeStr(department || '', 100),
        jobTitle:     sanitizeStr(jobTitle || '', 100),
        role:         validRoles.includes(role) ? role : 'worker',
        registeredAt: new Date().toISOString()
      };
      employees.push(newEmp);
      if (writeEmployees(employees)) {
        result = { status: 201, body: { success: true, employee: newEmp } };
      } else {
        result = { status: 500, body: { error: 'فشل حفظ بيانات الموظف' } };
      }
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ── PUT /api/employees/:code — تعديل بيانات موظف (محمي)
app.put('/api/employees/:code',
  authenticateToken,
  requireRole('superadmin', 'admin', 'supervisor', 'area_head', 'hse', 'issuer'),
  async (req, res) => {
    const targetCode = normalizeEmpCode(req.params.code);
    const { name, phone, department, jobTitle, role } = req.body;
    let result;
    await enqueueWrite(async () => {
      const employees = readEmployees();
      const idx = employees.findIndex(e => normalizeEmpCode(e.code || e.empCode) === targetCode);
      if (idx === -1) {
        result = { status: 404, body: { error: 'الموظف غير موجود' } };
        return;
      }
      const validRoles = ['worker','supervisor','area_head','contractor'];
      employees[idx] = {
        ...employees[idx],
        name:       sanitizeStr(name       || employees[idx].name,       100),
        phone:      sanitizeStr(phone      !== undefined ? phone      : (employees[idx].phone      || ''), 20),
        department: sanitizeStr(department || employees[idx].department, 100),
        jobTitle:   sanitizeStr(jobTitle   !== undefined ? jobTitle   : (employees[idx].jobTitle   || ''), 100),
        role:       validRoles.includes(role) ? role : (employees[idx].role || 'worker'),
        updatedAt:  new Date().toISOString()
      };
      if (writeEmployees(employees)) {
        result = { status: 200, body: { success: true, employee: employees[idx] } };
      } else {
        result = { status: 500, body: { error: 'فشل تحديث بيانات الموظف' } };
      }
    });
    res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
  }
);

// ── DELETE /api/employees/:code — حذف موظف (محمي)
app.delete('/api/employees/:code',
  authenticateToken,
  requireRole('superadmin', 'admin', 'supervisor'),
  async (req, res) => {
    const targetCode = normalizeEmpCode(req.params.code);
    let result;
    await enqueueWrite(async () => {
      const employees = readEmployees();
      const idx = employees.findIndex(e => normalizeEmpCode(e.code || e.empCode) === targetCode);
      if (idx === -1) {
        result = { status: 404, body: { error: 'الموظف غير موجود' } };
        return;
      }
      employees.splice(idx, 1);
      if (writeEmployees(employees)) {
        result = { status: 200, body: { success: true } };
      } else {
        result = { status: 500, body: { error: 'فشل حذف الموظف' } };
      }
    });
    res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
  }
);

// ============================================================
// 🎓 API ROUTES — HSE TRAINING MODULE

// ============================================================
// 🚨 API ROUTES — HSE DRILLS MODULE
// ============================================================

app.get('/api/trainings/topics', (req, res) => {
  res.json({ topics: readTrainingTopics() });
});

app.get('/api/trainings', authenticateToken, (req, res) => {
  res.json({ trainings: readTrainings() });
});

// Worker Dashboard Endpoint (No JWT required)
app.get('/api/trainings/worker/:empCode', (req, res) => {
  const code = normalizeEmpCode(req.params.empCode);
  const trainings = readTrainings();
  const attCode = (a) => normalizeEmpCode(a.empCode || a.code || a.employeeCode || a.id || '');
  
  const activeSession = trainings.find(t => t.status === 'active');
  const myHistory = [];
  let totalClosed = 0;
  let myAttended = 0;
  
  trainings.forEach(trn => {
    const isClosed = trn.status === 'closed' || trn.isClosed;
    if (isClosed) totalClosed++;
    const me = (trn.attendees || []).find(a => attCode(a) === code);
    
    if (me) {
      if (isClosed && me.verified !== false) myAttended++;
      myHistory.push({
        date: trn.date || trn.createdAt,
        title: trn.title || trn.topic,
        status: me.verified === false ? '⏳ قيد المراجعة' : '✅ مؤكد',
        verified: me.verified !== false,
        attended: true
      });
    }
  });
  
  // Sort history newest to oldest
  myHistory.sort((a, b) => new Date(b.date) - new Date(a.date));
  
  // Filter out attendees list from activeSession to protect privacy before sending to worker
  let safeActiveSession = null;
  if (activeSession) {
    safeActiveSession = { ...activeSession };
    // Only send if the worker themselves attended
    const meAttended = (activeSession.attendees || []).find(a => attCode(a) === code);
    safeActiveSession.attendees = meAttended ? [meAttended] : [];
  }

  res.json({ 
    activeSession: safeActiveSession, 
    myHistory, 
    totalClosed, 
    myAttended 
  });
});

// ── NEW ROUTE: Upload Trainings Excel ──────────────────────────────
app.post('/api/trainings/upload-excel', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  try {
    const { base64Data } = req.body;
    if (!base64Data) {
      return res.status(400).json({ success: false, message: 'No file data provided' });
    }

    const buffer = Buffer.from(base64Data, 'base64');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    let ws = workbook.worksheets[0];
    let headerRowNumber = 1;
    let colMap = { code: 1, name: 2, dept: 3, pos: 4, location: 5, topic: 6, date: 7, trainer: 8, duration: 9 };
    let headersFound = false;

    for (const sheet of workbook.worksheets) {
      sheet.eachRow((row, rowNum) => {
        if (headersFound || rowNum > 5) return;
        const vals = row.values;
        const hasCode = vals.some(v => v && (String(v).toLowerCase().includes('code') || String(v).includes('كود')));
        const hasTopic = vals.some(v => v && (String(v).toLowerCase().includes('topic') || String(v).includes('موضوع')));
        
        if (hasCode && hasTopic) {
          ws = sheet;
          headerRowNumber = rowNum;
          headersFound = true;
          
          vals.forEach((v, idx) => {
            if (!v) return;
            const val = String(v).toLowerCase();
            if (val.includes('code') || val.includes('كود')) colMap.code = idx;
            else if (val.includes('name') || val.includes('اسم')) colMap.name = idx;
            else if (val.includes('department') || val.includes('قسم')) colMap.dept = idx;
            else if (val.includes('position') || val.includes('وظيفة')) colMap.pos = idx;
            else if (val.includes('location') || val.includes('مكان') || val.includes('منطقة')) colMap.location = idx;
            else if (val.includes('topic') || val.includes('موضوع') || val.includes('محاضرة')) colMap.topic = idx;
            else if (val.includes('date') || val.includes('تاريخ')) colMap.date = idx;
            else if (val.includes('supervisor') || val.includes('محاضر') || val.includes('مدرب')) colMap.trainer = idx;
            else if (val.includes('duration') || val.includes('مدة') || val.includes('وقت')) colMap.duration = idx;
          });
        }
      });
      if (headersFound) break;
    }

    const sessions = {}; 

    ws.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRowNumber) return;
      const vals = row.values;
      
      const code = String(vals[colMap.code] || '').trim();
      if (!code || code === 'undefined') return; 

      const name = String(vals[colMap.name] || '').trim();
      const dept = String(vals[colMap.dept] || '').trim();
      const topic = String(vals[colMap.topic] || '').trim();
      
      let dateObj = vals[colMap.date];
      if (!dateObj) return;
      
      let d = null;
      if (dateObj instanceof Date) {
        d = dateObj;
      } else if (typeof dateObj === 'string') {
        const parsed = new Date(dateObj.trim());
        if (!isNaN(parsed.getTime())) d = parsed;
      } else if (typeof dateObj === 'number') {
        d = new Date(Math.round((dateObj - 25569) * 86400 * 1000));
      }

      if (d) {
        const y = d.getFullYear();
        if (y < 2000 || y > 2100) d = null;
      }
      if (!d || isNaN(d.getTime())) return;
      const dateStr = d.toISOString().split('T')[0];

      const trainer = String(vals[colMap.trainer] || '').trim();
      const duration = parseFloat(vals[colMap.duration]) || 0;

      const sessionKey = `${topic}_${dateStr}_${trainer}`;

      if (!sessions[sessionKey]) {
        sessions[sessionKey] = {
          id: 'TRN-' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '-' + Object.keys(sessions).length,
          title: topic,
          topic: topic,
          type: 'مخطط', 
          targetGroup: dept,
          trainer: trainer,
          date: dateStr,
          duration: duration,
          description: 'تم الاستيراد من ملف Excel',
          status: 'closed',
          isClosed: true,
          createdAt: dateStr,
          closedAt: dateStr,
          attendees: []
        };
      }

      const s = sessions[sessionKey];
      if (!s.attendees.find(a => a.code === code)) {
        s.attendees.push({ code, name, department: dept, verified: true, attendanceTime: dateStr });
      }
      
      if (s.targetGroup !== 'متعدد' && s.targetGroup !== dept) {
        s.targetGroup = 'متعدد'; 
      }
    });

    const importedList = Object.values(sessions);
    const trainings = readTrainings();
    
    // Merge new trainings
    const merged = [...trainings, ...importedList];
    
    if (writeTrainings(merged)) {
      res.json({ success: true, count: importedList.length });
    } else {
      res.status(500).json({ success: false, message: 'Failed to save data' });
    }
  } catch (error) {
    console.error('Error parsing Excel:', error);
    res.status(500).json({ success: false, message: 'Invalid Excel file or parsing error' });
  }
});


app.post('/api/trainings', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  const { title, targetGroup, location, date, startTime, endTime, sessionPin, trainer, trainerCode } = req.body;
  if (!title || !date || !startTime || !endTime || !sessionPin) {
    return res.status(400).json({ error: 'البيانات الأساسية مطلوبة' });
  }

  let result;
  await enqueueWrite(async () => {
    const trainings = readTrainings();
    const newId = `TRN-${Date.now()}`;
    const newTraining = {
      id: newId,
      title: sanitizeStr(title, 200),
      topic: sanitizeStr(title, 200),
      trainer: sanitizeStr(trainer || '', 150),
      trainerCode: sanitizeStr(trainerCode || '', 50),
      targetGroup: sanitizeStr(targetGroup || '', 200),
      location: sanitizeStr(location || '', 200),
      date: sanitizeStr(date, 20),
      startTime: sanitizeStr(startTime, 10),
      endTime: sanitizeStr(endTime, 10),
      sessionPin: sanitizeStr(sessionPin, 10),
      status: 'active',
      attendees: [],
      createdAt: new Date().toISOString()
    };
    trainings.push(newTraining);
    if (writeTrainings(trainings)) {
      
      createNotification({
        targetRole: 'worker',
        targetGroup: newTraining.targetGroup,
        type: 'training',
        title: 'محاضرة تدريبية جديدة 🎓',
        message: `محاضرة جديدة: ${newTraining.title} في ${newTraining.location || 'غير محدد'} - الساعة ${newTraining.startTime}`,
        link: 'tabTrainingWorker'
      });

      result = { status: 201, body: { success: true, training: newTraining } };
    } else {
      result = { status: 500, body: { error: 'فشل حفظ المحاضرة' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.put('/api/trainings/:id/close', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  let result;
  await enqueueWrite(async () => {
    const trainings = readTrainings();
    const idx = trainings.findIndex(t => t.id === req.params.id);
    if (idx === -1) return result = { status: 404, body: { error: 'المحاضرة غير موجودة' } };
    
    trainings[idx].status = 'closed';
    if (writeTrainings(trainings)) {
      
      createNotification({
        targetRole: 'admin',
        type: 'training',
        title: 'إغلاق محاضرة 🔒',
        message: `تم إغلاق محاضرة ${trainings[idx].title} بإجمالي حضور ${trainings[idx].attendees.length}`,
        link: 'tabTrainingAdmin'
      });

      result = { status: 200, body: { success: true, training: trainings[idx] } };
    } else {
      result = { status: 500, body: { error: 'فشل إغلاق المحاضرة' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.delete('/api/trainings/:id', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  let result;
  await enqueueWrite(async () => {
    const trainings = readTrainings();
    const idx = trainings.findIndex(t => t.id === req.params.id);
    if (idx === -1) return result = { status: 404, body: { error: 'المحاضرة غير موجودة' } };
    
    trainings[idx].isDeleted = true;
    trainings[idx].deletedAt = new Date().toISOString();
    
    if (writeTrainings(trainings)) {
      result = { status: 200, body: { success: true } };
    } else {
      result = { status: 500, body: { error: 'فشل عملية الحذف المؤقت' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.put('/api/trainings/:id/restore', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  let result;
  await enqueueWrite(async () => {
    const trainings = readTrainings();
    const idx = trainings.findIndex(t => t.id === req.params.id);
    if (idx === -1) return result = { status: 404, body: { error: 'المحاضرة غير موجودة' } };
    
    trainings[idx].isDeleted = false;
    trainings[idx].deletedAt = null;
    
    if (writeTrainings(trainings)) {
      result = { status: 200, body: { success: true } };
    } else {
      result = { status: 500, body: { error: 'فشل عملية الاستعادة' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.delete('/api/trainings/:id/permanent', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  let result;
  await enqueueWrite(async () => {
    let trainings = readTrainings();
    const initialLength = trainings.length;
    trainings = trainings.filter(t => t.id !== req.params.id);
    
    if (trainings.length < initialLength) {
      if (writeTrainings(trainings)) {
        result = { status: 200, body: { success: true } };
      } else {
        result = { status: 500, body: { error: 'فشل عملية الحذف النهائي' } };
      }
    } else {
      result = { status: 404, body: { error: 'المحاضرة غير موجودة' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.post('/api/trainings/:id/attend', attendLimiter, async (req, res) => {
  let { empCode, pin } = req.body;
  if (!empCode || !pin) return res.status(400).json({ error: 'الكود ورمز الجلسة مطلوبان' });
  
  // Strict Type Casting to prevent NoSQL injection / Prototype pollution
  empCode = String(empCode).trim();
  pin = String(pin).trim();

  let result;
  await enqueueWrite(async () => {
    const trainings = readTrainings();
    const idx = trainings.findIndex(t => t.id === req.params.id);
    if (idx === -1) return result = { status: 404, body: { error: 'المحاضرة غير موجودة' } };
    
    const trn = trainings[idx];
    if (trn.status !== 'active') {
      return result = { status: 400, body: { error: 'المحاضرة مغلقة حالياً' } };
    }
    
    // Half-hour check-in rule
    const createdAt = new Date(trn.createdAt || trn.date).getTime();
    const now = new Date().getTime();
    if (now - createdAt > 30 * 60 * 1000) {
      return result = { status: 400, body: { error: 'لقد انتهى الوقت المسموح للتسجيل (30 دقيقة من بدء المحاضرة)' } };
    }
    if (trn.sessionPin !== String(pin).trim()) {
      return result = { status: 400, body: { error: 'رمز الجلسة غير صحيح' } };
    }

    const nCode = normalizeEmpCode(empCode);
    if (trn.attendees.find(a => a.empCode === nCode)) {
      return result = { status: 400, body: { error: 'تم تسجيل حضورك بالفعل في هذه المحاضرة' } };
    }

    const employees = readEmployees();
    const emp = employees.find(e => normalizeEmpCode(e.code || e.empCode) === nCode);
    if (!emp) {
      return result = { status: 404, body: { error: 'الكود الوظيفي غير مسجل في النظام' } };
    }

    trn.attendees.push({
      empCode: nCode,
      name: emp.name,
      department: emp.department,
      attendedAt: new Date().toISOString(),
      verified: true
    });

    if (writeTrainings(trainings)) {
      
      createNotification({
        targetRole: 'admin',
        type: 'training',
        title: 'تسجيل حضور تدريب 👤',
        message: `سجّل ${emp.name} حضوره في الجلسة`,
        link: 'tabTrainingAdmin'
      });
      
      createNotification({
        targetEmpCode: nCode,
        type: 'training',
        title: 'تأكيد الحضور ✅',
        message: `تم تسجيل وتأكيد حضورك في محاضرة ${trn.title}`,
        link: 'tabTrainingWorker'
      });

      result = { status: 200, body: { success: true, message: 'تم تسجيل الحضور بنجاح' } };
    } else {
      result = { status: 500, body: { error: 'حدث خطأ أثناء التسجيل' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ── POST /api/trainings/:id/add-attendee — إضافة حضور يدويًا من الأدمن ─────
// يستخدمها مشرف السلامة/الأدمن أثناء المحاضرة الحية لتسجيل حضور موظف
// ليس معه موبايل (أو تعطّل عنده) بإدخال كوده الوظيفي فقط؛ بيانات الاسم
// والقسم بتتسحب تلقائيًا من قاعدة الموظفين، بدون الحاجة لرمز الجلسة (PIN).
app.post('/api/trainings/:id/add-attendee', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  let { empCode } = req.body;
  if (!empCode || !String(empCode).trim()) {
    return res.status(400).json({ error: 'الكود الوظيفي مطلوب' });
  }
  empCode = String(empCode).trim();

  let result;
  await enqueueWrite(async () => {
    const trainings = readTrainings();
    const idx = trainings.findIndex(t => t.id === req.params.id);
    if (idx === -1) return result = { status: 404, body: { error: 'المحاضرة غير موجودة' } };

    const trn = trainings[idx];
    if (trn.status !== 'active') {
      return result = { status: 400, body: { error: 'لا يمكن إضافة حضور لمحاضرة مغلقة' } };
    }

    const nCode = normalizeEmpCode(empCode);
    if (trn.attendees.find(a => a.empCode === nCode)) {
      return result = { status: 400, body: { error: 'الموظف مسجل حضوره بالفعل في هذه المحاضرة' } };
    }

    const employees = readEmployees();
    const emp = employees.find(e => normalizeEmpCode(e.code || e.empCode) === nCode);
    if (!emp) {
      return result = { status: 404, body: { error: 'الكود الوظيفي غير مسجل في النظام' } };
    }

    trn.attendees.push({
      empCode: nCode,
      name: emp.name,
      department: emp.department,
      attendedAt: new Date().toISOString(),
      verified: true,
      addedManuallyBy: sanitizeStr(req.user.name || req.user.username, 100)
    });

    if (writeTrainings(trainings)) {
      createNotification({
        targetEmpCode: nCode,
        type: 'training',
        title: 'تأكيد الحضور ✅',
        message: `تم تسجيل حضورك في محاضرة ${trn.title} بمعرفة مشرف السلامة`,
        link: 'tabTrainingWorker'
      });
      result = { status: 200, body: { success: true, attendees: trn.attendees } };
    } else {
      result = { status: 500, body: { error: 'حدث خطأ أثناء التسجيل' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.put('/api/trainings/:id/verify-attendee', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  const { empCode, verified } = req.body;
  let result;
  await enqueueWrite(async () => {
    const trainings = readTrainings();
    const idx = trainings.findIndex(t => t.id === req.params.id);
    if (idx === -1) return result = { status: 404, body: { error: 'المحاضرة غير موجودة' } };
    
    const trn = trainings[idx];
    const nCode = normalizeEmpCode(empCode);
    
    if (verified === false) {
      trn.attendees = trn.attendees.filter(a => a.empCode !== nCode);
    } else {
      const att = trn.attendees.find(a => a.empCode === nCode);
      if (att) att.verified = true;
    }

    if (writeTrainings(trainings)) {
      result = { status: 200, body: { success: true, attendees: trn.attendees } };
    } else {
      result = { status: 500, body: { error: 'فشل تحديث الحضور' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.post('/api/trainings/export-bulk', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No training IDs provided' });
    }

    const allTrainings = readTrainings();
    const targetTrainings = allTrainings.filter(t => ids.includes(t.id));

    if (targetTrainings.length === 0) {
      return res.status(404).json({ error: 'No matching trainings found' });
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('سجل المحاضرات المجمع');
    sheet.views = [{ rightToLeft: true }];

    sheet.columns = [
      { header: 'موضوع المحاضرة', key: 'topic', width: 30 },
      { header: 'اسم المحاضر', key: 'trainer', width: 25 },
      { header: 'تاريخ المحاضرة', key: 'date', width: 15 },
      { header: 'كود الموظف', key: 'empCode', width: 15 },
      { header: 'اسم الموظف', key: 'empName', width: 30 },
      { header: 'القسم', key: 'department', width: 25 },
      { header: 'حالة الحضور', key: 'status', width: 15 }
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD51E27' } };
    sheet.getRow(1).alignment = { horizontal: 'center' };

    targetTrainings.forEach(trn => {
      trn.attendees.forEach(att => {
        sheet.addRow({
          topic: trn.topic || trn.title || '',
          trainer: trn.trainer || '',
          date: trn.date || trn.createdAt || '',
          empCode: att.code || att.empCode || '',
          empName: att.name || att.empName || '',
          department: att.department || '',
          status: att.verified ? 'مؤكد' : 'غير مؤكد'
        });
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Bulk_Trainings.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error generating bulk Excel:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/trainings/:id/export-excel', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin'), async (req, res) => {
  try {
    const trainings = readTrainings();
    const trn = trainings.find(t => t.id === req.params.id);
    if (!trn) return res.status(404).json({ error: 'المحاضرة غير موجودة' });

    // Load employees for position lookup
    const employees = readEmployees();
    const empMap = new Map();
    employees.forEach(e => {
      const code = normalizeEmpCode(e.code || e.empCode);
      if (code) empMap.set(code, e);
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('سجل الحضور');

    // ── 4-Line Meta Header ─────────────────────────────────────
    const topicName = trn.topic || trn.title || 'غير محدد';
    const trainerName = trn.trainer || 'غير محدد';
    const trainerCode = trn.trainerCode || trn.trainer_code || 'غير مسجل';
    const trainingDate = trn.date || '';
    const trainingLoc = trn.location || 'غير محدد';

    const metaStyle = { font: { bold: true, size: 12 }, alignment: { horizontal: 'right', vertical: 'middle' } };
    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD51E27' } };

    // Row 1: Topic
    ws.addRow([`الموضوع / اسم المحاضرة: ${topicName}`]);
    ws.getRow(1).getCell(1).style = { font: { bold: true, size: 13, color: { argb: 'FFD51E27' } }, alignment: { horizontal: 'right' } };
    ws.mergeCells('A1:F1');

    // Row 2: Trainer name
    ws.addRow([`اسم المحاضر: ${trainerName}`]);
    ws.getRow(2).getCell(1).style = { font: { bold: true, size: 11 }, alignment: { horizontal: 'right' } };
    ws.mergeCells('A2:F2');

    // Row 3: Trainer code
    ws.addRow([`كود المحاضر: ${trainerCode}`]);
    ws.getRow(3).getCell(1).style = { font: { bold: true, size: 11 }, alignment: { horizontal: 'right' } };
    ws.mergeCells('A3:F3');

    // Row 4: Date + Location
    ws.addRow([`تاريخ المحاضرة: ${trainingDate}   |   الموقع: ${trainingLoc}`]);
    ws.getRow(4).getCell(1).style = { font: { bold: true, size: 11 }, alignment: { horizontal: 'right' } };
    ws.mergeCells('A4:F4');

    // Row 5: Spacer
    ws.addRow([]);

    // Row 6: Table headers
    const headerRow = ws.addRow(['الكود الوظيفي', 'الاسم', 'القسم', 'المسمى الوظيفي', 'وقت الحضور', 'حالة التأكيد']);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = headerFill;
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };

    // Set column widths
    ws.columns = [
      { key: 'A', width: 16 },
      { key: 'B', width: 30 },
      { key: 'C', width: 25 },
      { key: 'D', width: 25 },
      { key: 'E', width: 25 },
      { key: 'F', width: 15 },
    ];

    // Data rows
    trn.attendees.forEach(a => {
      const code = normalizeEmpCode(a.empCode);
      const empRec = empMap.get(code) || {};
      const position = empRec.jobTitle || a.jobTitle || 'غير محدد';
      ws.addRow([
        a.empCode,
        a.name,
        a.department || 'غير محدد',
        position,
        new Date(a.attendedAt).toLocaleString('ar-EG'),
        a.verified ? 'مؤكد' : 'غير مؤكد'
      ]);
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Training_${trn.id}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Export training error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'فشل تصدير الكشف' });
  }
});

app.get('/api/trainings/stats/employees', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin'), (req, res) => {
  let employees = readEmployees();
  
  // Department Admin Isolation
  if (req.user.role === 'dept_admin' && req.user.department) {
    employees = employees.filter(e => e.department === req.user.department);
  }

  const trainings = readTrainings();

  const statsMap = new Map();
  employees.forEach(e => {
    const code = normalizeEmpCode(e.code || e.empCode);
    if (!statsMap.has(code)) {
      statsMap.set(code, {
        empCode: code,
        name: e.name || 'غير معروف',
        department: e.department || 'غير محدد',
        attendedCount: 0,
        attendanceHours: 0,
        percentage: 0
      });
    }
  });

  trainings.filter(t => !t.isDeleted).forEach(trn => {
    trn.attendees.forEach(att => {
      if (att.verified) {
        const code = normalizeEmpCode(att.empCode);
        if (statsMap.has(code)) {
          statsMap.get(code).attendedCount++;
        }
      }
    });
  });

  const statsList = Array.from(statsMap.values()).map(stat => {
    stat.attendanceHours = stat.attendedCount * 0.5;
    // Calculate percentage based on 8 hours target
    stat.percentage = Math.min(100, Math.round((stat.attendanceHours / 8) * 100));
    return stat;
  });

  res.json({ stats: statsList });
});


// ============================================================
// 🚨 API ROUTES — HSE DRILLS MODULE
// ============================================================

app.get('/api/drills/titles', (req, res) => {
  res.json({ titles: readDrillTopics() });
});

// ── Public export alias (no JWT — token checked inside via query) ────────────
// /api/drills/export/:id  →  ينشئ ملف Excel. كان بدون أي مصادقة سابقًا (لأن
// الرابط يُفتح مباشرة عبر <a href> بدون JS يقدر يرسل Authorization header).
// الآن يقبل authenticateTokenFlexible التوكن عبر ?dt=<token> في الرابط نفسه،
// فيبقى الرابط يعمل بنقرة واحدة لكن بدون فتحه لأي زائر مجهول (11 سبتمبر 2026).
app.get('/api/drills/export/:id', authenticateTokenFlexible, async (req, res) => {
  try {
    const drills = readDrills();
    const drl = drills.find(d => d.id === req.params.id);
    if (!drl) return res.status(404).send('Drill not found');

    const employees = readEmployees();
    const empMap = new Map();
    employees.forEach(e => {
      const code = normalizeEmpCode(e.code || e.empCode);
      if (code) empMap.set(code, e);
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('سجل حضور التجربة');
    const redFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD32F2F' } };
    const whiteBold = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };

    // ── Meta rows ──────────────────────────────────────────────
    ws.addRow([`عنوان التجربة: ${drl.title || 'غير محدد'}`]);
    ws.getRow(1).getCell(1).style = { font: { bold: true, size: 13, color: { argb: 'FFD32F2F' } }, alignment: { horizontal: 'right' } };
    ws.mergeCells('A1:E1');

    ws.addRow([`اسم المشرف: ${drl.trainer || 'غير محدد'}`]);
    ws.getRow(2).getCell(1).style = { font: { bold: true, size: 11 }, alignment: { horizontal: 'right' } };
    ws.mergeCells('A2:E2');

    ws.addRow([`كود المشرف: ${drl.trainerCode || 'غير مسجل'}`]);
    ws.getRow(3).getCell(1).style = { font: { bold: true, size: 11 }, alignment: { horizontal: 'right' } };
    ws.mergeCells('A3:E3');

    ws.addRow([`المكان: ${drl.location || 'غير محدد'}   |   التاريخ: ${drl.date || ''}`]);
    ws.getRow(4).getCell(1).style = { font: { bold: true, size: 11 }, alignment: { horizontal: 'right' } };
    ws.mergeCells('A4:E4');

    ws.addRow([]); // spacer

    // ── Table headers ──────────────────────────────────────────
    const headerRow = ws.addRow(['الكود الوظيفي', 'الاسم', 'القسم / المسمى', 'وقت الحضور', 'حالة التأكيد']);
    headerRow.font = whiteBold;
    headerRow.fill = redFill;
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };

    ws.columns = [
      { key: 'A', width: 16 },
      { key: 'B', width: 30 },
      { key: 'C', width: 28 },
      { key: 'D', width: 25 },
      { key: 'E', width: 15 },
    ];

    // ── Attendee data rows ─────────────────────────────────────
    if (drl.attendees && drl.attendees.length > 0) {
      drl.attendees.forEach(a => {
        const code = normalizeEmpCode(a.empCode);
        const empRec = empMap.get(code) || {};
        ws.addRow([
          a.empCode,
          a.name || empRec.name || 'غير محدد',
          a.department || empRec.department || 'غير محدد',
          a.attendedAt ? new Date(a.attendedAt).toLocaleString('ar-EG') : '',
          a.verified ? 'مؤكد' : 'غير مؤكد'
        ]);
      });
    } else {
      ws.addRow(['لا يوجد حضور مسجل في هذه التجربة']);
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="drill_attendance_${drl.id}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Export drill error:', err);
    if (!res.headersSent) res.status(500).send('Error generating Excel file');
  }
});

app.get('/api/drills', authenticateToken, (req, res) => {
  res.json({ drills: readDrills() });
});


// Worker Dashboard Endpoint (No JWT required)
app.get('/api/drills/worker/:empCode', (req, res) => {
  const code = normalizeEmpCode(req.params.empCode);
  const drills = readDrills();
  const attCode = (a) => normalizeEmpCode(a.empCode || a.code || a.employeeCode || a.id || '');
  
  const activeSession = drills.find(t => t.status === 'active');
  const myHistory = [];
  let totalClosed = 0;
  let myAttended = 0;
  
  drills.forEach(drl => {
    const isClosed = drl.status === 'closed' || drl.isClosed;
    if (isClosed) totalClosed++;
    const me = (drl.attendees || []).find(a => attCode(a) === code);
    
    if (me) {
      if (isClosed && me.verified !== false) myAttended++;
      myHistory.push({
        date: drl.date || drl.createdAt,
        title: drl.title || drl.title,
        status: me.verified === false ? '⏳ قيد المراجعة' : '✅ مؤكد',
        verified: me.verified !== false,
        attended: true
      });
    }
  });
  
  // Sort history newest to oldest
  myHistory.sort((a, b) => new Date(b.date) - new Date(a.date));
  
  // Filter out attendees list from activeSession to protect privacy before sending to worker
  let safeActiveSession = null;
  if (activeSession) {
    safeActiveSession = { ...activeSession };
    // Only send if the worker themselves attended
    const meAttended = (activeSession.attendees || []).find(a => attCode(a) === code);
    safeActiveSession.attendees = meAttended ? [meAttended] : [];
  }

  res.json({ 
    activeSession: safeActiveSession, 
    myHistory, 
    totalClosed, 
    myAttended 
  });
});

app.post('/api/drills', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  const { title, targetGroup, location, date, startTime, endTime, sessionPin, trainer, trainerCode } = req.body;
  if (!title || !date || !startTime || !endTime || !sessionPin) {
    return res.status(400).json({ error: 'البيانات الأساسية مطلوبة' });
  }

  let result;
  await enqueueWrite(async () => {
    const drills = readDrills();
    const newId = `DRL-${Date.now()}`;
    const newDrill = {
      id: newId,
      title: sanitizeStr(title, 200),
      title: sanitizeStr(title, 200),
      trainer: sanitizeStr(trainer || '', 150),
      trainerCode: sanitizeStr(trainerCode || '', 50),
      targetGroup: sanitizeStr(targetGroup || '', 200),
      location: sanitizeStr(location || '', 200),
      date: sanitizeStr(date, 20),
      startTime: sanitizeStr(startTime, 10),
      endTime: sanitizeStr(endTime, 10),
      sessionPin: sanitizeStr(sessionPin, 10),
      status: 'active',
      attendees: [],
      createdAt: new Date().toISOString()
    };
    drills.push(newDrill);
    if (writeDrills(drills)) {
      
      createNotification({
        targetRole: 'worker',
        targetGroup: newDrill.targetGroup,
        type: 'drill',
        title: 'تجربة تدريبية جديدة 🚨',
        message: `تجربة جديدة: ${newDrill.title} في ${newDrill.location || 'غير محدد'} - الساعة ${newDrill.startTime}`,
        link: 'tabDrillWorker'
      });

      result = { status: 201, body: { success: true, drill: newDrill } };
    } else {
      result = { status: 500, body: { error: 'فشل حفظ التجربة' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.put('/api/drills/:id/close', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  let result;
  await enqueueWrite(async () => {
    const drills = readDrills();
    const idx = drills.findIndex(t => t.id === req.params.id);
    if (idx === -1) return result = { status: 404, body: { error: 'التجربة غير موجودة' } };
    
    drills[idx].status = 'closed';
    if (writeDrills(drills)) {
      
      createNotification({
        targetRole: 'admin',
        type: 'drill',
        title: 'إغلاق تجربة 🔒',
        message: `تم إغلاق تجربة ${drills[idx].title} بإجمالي حضور ${drills[idx].attendees.length}`,
        link: 'tabDrillAdmin'
      });

      result = { status: 200, body: { success: true, drill: drills[idx] } };
    } else {
      result = { status: 500, body: { error: 'فشل إغلاق التجربة' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.delete('/api/drills/:id', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  let result;
  await enqueueWrite(async () => {
    const drills = readDrills();
    const idx = drills.findIndex(t => t.id === req.params.id);
    if (idx === -1) return result = { status: 404, body: { error: 'التجربة غير موجودة' } };
    
    drills[idx].isDeleted = true;
    drills[idx].deletedAt = new Date().toISOString();
    
    if (writeDrills(drills)) {
      result = { status: 200, body: { success: true } };
    } else {
      result = { status: 500, body: { error: 'فشل عملية الحذف المؤقت' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.put('/api/drills/:id/restore', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  let result;
  await enqueueWrite(async () => {
    const drills = readDrills();
    const idx = drills.findIndex(t => t.id === req.params.id);
    if (idx === -1) return result = { status: 404, body: { error: 'التجربة غير موجودة' } };
    
    drills[idx].isDeleted = false;
    drills[idx].deletedAt = null;
    
    if (writeDrills(drills)) {
      result = { status: 200, body: { success: true } };
    } else {
      result = { status: 500, body: { error: 'فشل عملية الاستعادة' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.delete('/api/drills/:id/permanent', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  let result;
  await enqueueWrite(async () => {
    let drills = readDrills();
    const initialLength = drills.length;
    drills = drills.filter(t => t.id !== req.params.id);
    
    if (drills.length < initialLength) {
      if (writeDrills(drills)) {
        result = { status: 200, body: { success: true } };
      } else {
        result = { status: 500, body: { error: 'فشل عملية الحذف النهائي' } };
      }
    } else {
      result = { status: 404, body: { error: 'التجربة غير موجودة' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.post('/api/drills/:id/attend', attendLimiter, async (req, res) => {
  let { empCode, pin } = req.body;
  if (!empCode || !pin) return res.status(400).json({ error: 'الكود ورمز الجلسة مطلوبان' });
  
  // Strict Type Casting to prevent NoSQL injection / Prototype pollution
  empCode = String(empCode).trim();
  pin = String(pin).trim();

  let result;
  await enqueueWrite(async () => {
    const drills = readDrills();
    const idx = drills.findIndex(t => t.id === req.params.id);
    if (idx === -1) return result = { status: 404, body: { error: 'التجربة غير موجودة' } };
    
    const drl = drills[idx];
    if (drl.status !== 'active') {
      return result = { status: 400, body: { error: 'التجربة مغلقة حالياً' } };
    }
    
    // PIN check
    if (drl.sessionPin !== String(pin).trim()) {
      return result = { status: 400, body: { error: 'رمز الجلسة غير صحيح' } };
    }

    const nCode = normalizeEmpCode(empCode);
    if (drl.attendees.find(a => a.empCode === nCode)) {
      return result = { status: 400, body: { error: 'تم تسجيل حضورك بالفعل في هذه التجربة' } };
    }

    const employees = readEmployees();
    const emp = employees.find(e => normalizeEmpCode(e.code || e.empCode) === nCode);
    if (!emp) {
      return result = { status: 404, body: { error: 'الكود الوظيفي غير مسجل في النظام' } };
    }

    drl.attendees.push({
      empCode: nCode,
      name: emp.name,
      department: emp.department,
      attendedAt: new Date().toISOString(),
      verified: true
    });

    if (writeDrills(drills)) {
      
      createNotification({
        targetRole: 'admin',
        type: 'drill',
        title: 'تسجيل حضور تدريب 👤',
        message: `سجّل ${emp.name} حضوره في الجلسة`,
        link: 'tabDrillAdmin'
      });
      
      createNotification({
        targetEmpCode: nCode,
        type: 'drill',
        title: 'تأكيد الحضور ✅',
        message: `تم تسجيل وتأكيد حضورك في تجربة ${drl.title}`,
        link: 'tabDrillWorker'
      });

      result = { status: 200, body: { success: true, message: 'تم تسجيل الحضور بنجاح' } };
    } else {
      result = { status: 500, body: { error: 'حدث خطأ أثناء التسجيل' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ── POST /api/drills/:id/add-attendee — إضافة حضور يدويًا من الأدمن ────────
// نفس فكرة نظيرتها في المحاضرات: تسجيل حضور موظف ليس معه موبايل في تجربة
// الطوارئ الحية بإدخال كوده الوظيفي فقط، بدون رمز الجلسة (PIN).
app.post('/api/drills/:id/add-attendee', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  let { empCode } = req.body;
  if (!empCode || !String(empCode).trim()) {
    return res.status(400).json({ error: 'الكود الوظيفي مطلوب' });
  }
  empCode = String(empCode).trim();

  let result;
  await enqueueWrite(async () => {
    const drills = readDrills();
    const idx = drills.findIndex(t => t.id === req.params.id);
    if (idx === -1) return result = { status: 404, body: { error: 'التجربة غير موجودة' } };

    const drl = drills[idx];
    if (drl.status !== 'active') {
      return result = { status: 400, body: { error: 'لا يمكن إضافة حضور لتجربة مغلقة' } };
    }

    const nCode = normalizeEmpCode(empCode);
    if (drl.attendees.find(a => a.empCode === nCode)) {
      return result = { status: 400, body: { error: 'الموظف مسجل حضوره بالفعل في هذه التجربة' } };
    }

    const employees = readEmployees();
    const emp = employees.find(e => normalizeEmpCode(e.code || e.empCode) === nCode);
    if (!emp) {
      return result = { status: 404, body: { error: 'الكود الوظيفي غير مسجل في النظام' } };
    }

    drl.attendees.push({
      empCode: nCode,
      name: emp.name,
      department: emp.department,
      attendedAt: new Date().toISOString(),
      verified: true,
      addedManuallyBy: sanitizeStr(req.user.name || req.user.username, 100)
    });

    if (writeDrills(drills)) {
      createNotification({
        targetEmpCode: nCode,
        type: 'drill',
        title: 'تأكيد الحضور ✅',
        message: `تم تسجيل حضورك في تجربة ${drl.title} بمعرفة مشرف السلامة`,
        link: 'tabDrillWorker'
      });
      result = { status: 200, body: { success: true, attendees: drl.attendees } };
    } else {
      result = { status: 500, body: { error: 'حدث خطأ أثناء التسجيل' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.put('/api/drills/:id/verify-attendee', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  const { empCode, verified } = req.body;
  let result;
  await enqueueWrite(async () => {
    const drills = readDrills();
    const idx = drills.findIndex(t => t.id === req.params.id);
    if (idx === -1) return result = { status: 404, body: { error: 'التجربة غير موجودة' } };
    
    const drl = drills[idx];
    const nCode = normalizeEmpCode(empCode);
    
    if (verified === false) {
      drl.attendees = drl.attendees.filter(a => a.empCode !== nCode);
    } else {
      const att = drl.attendees.find(a => a.empCode === nCode);
      if (att) att.verified = true;
    }

    if (writeDrills(drills)) {
      result = { status: 200, body: { success: true, attendees: drl.attendees } };
    } else {
      result = { status: 500, body: { error: 'فشل تحديث الحضور' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

app.get('/api/drills/:id/export-excel', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin'), async (req, res) => {
  try {
    const drills = readDrills();
    const drl = drills.find(t => t.id === req.params.id);
    if (!drl) return res.status(404).json({ error: 'التجربة غير موجودة' });

    // Load employees for position lookup
    const employees = readEmployees();
    const empMap = new Map();
    employees.forEach(e => {
      const code = normalizeEmpCode(e.code || e.empCode);
      if (code) empMap.set(code, e);
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('سجل الحضور');

    // ── 4-Line Meta Header ─────────────────────────────────────
    const titleName = drl.title || drl.title || 'غير محدد';
    const trainerName = drl.trainer || 'غير محدد';
    const trainerCode = drl.trainerCode || drl.trainer_code || 'غير مسجل';
    const drillDate = drl.date || '';
    const drillLoc = drl.location || 'غير محدد';

    const metaStyle = { font: { bold: true, size: 12 }, alignment: { horizontal: 'right', vertical: 'middle' } };
    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD51E27' } };

    // Row 1: Topic
    ws.addRow([`الموضوع / اسم التجربة: ${titleName}`]);
    ws.getRow(1).getCell(1).style = { font: { bold: true, size: 13, color: { argb: 'FFD51E27' } }, alignment: { horizontal: 'right' } };
    ws.mergeCells('A1:F1');

    // Row 2: Trainer name
    ws.addRow([`اسم المحاضر: ${trainerName}`]);
    ws.getRow(2).getCell(1).style = { font: { bold: true, size: 11 }, alignment: { horizontal: 'right' } };
    ws.mergeCells('A2:F2');

    // Row 3: Trainer code
    ws.addRow([`كود المحاضر: ${trainerCode}`]);
    ws.getRow(3).getCell(1).style = { font: { bold: true, size: 11 }, alignment: { horizontal: 'right' } };
    ws.mergeCells('A3:F3');

    // Row 4: Date + Location
    ws.addRow([`تاريخ التجربة: ${drillDate}   |   الموقع: ${drillLoc}`]);
    ws.getRow(4).getCell(1).style = { font: { bold: true, size: 11 }, alignment: { horizontal: 'right' } };
    ws.mergeCells('A4:F4');

    // Row 5: Spacer
    ws.addRow([]);

    // Row 6: Table headers
    const headerRow = ws.addRow(['الكود الوظيفي', 'الاسم', 'القسم', 'المسمى الوظيفي', 'وقت الحضور', 'حالة التأكيد']);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = headerFill;
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };

    // Set column widths
    ws.columns = [
      { key: 'A', width: 16 },
      { key: 'B', width: 30 },
      { key: 'C', width: 25 },
      { key: 'D', width: 25 },
      { key: 'E', width: 25 },
      { key: 'F', width: 15 },
    ];

    // Data rows
    drl.attendees.forEach(a => {
      const code = normalizeEmpCode(a.empCode);
      const empRec = empMap.get(code) || {};
      const position = empRec.jobTitle || a.jobTitle || 'غير محدد';
      ws.addRow([
        a.empCode,
        a.name,
        a.department || 'غير محدد',
        position,
        new Date(a.attendedAt).toLocaleString('ar-EG'),
        a.verified ? 'مؤكد' : 'غير مؤكد'
      ]);
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Drill_${drl.id}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Export drill error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'فشل تصدير الكشف' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 📝 DRILL REPORT — نفس تصميم تقارير السلامة الورقية (بدون صور)
// ─────────────────────────────────────────────────────────────────────────
const DEFAULT_DRILL_REPORT_PURPOSE =
  'تطبيقاً لخطط السلامة وفى سياق جهود الشركة الهادفة الى الحفاظ على سلامة كافة العاملين، تم اجراء هذه ' +
  'التجربة للتأكد من مدى فاعلية خطط الطوارئ المتبعة فى الشركة، اضافة الى قياس مدى جاهزية العاملين بالشركة ' +
  'للتعامل فى مثل هذه الظروف الطارئة، مع تدريب كافة العاملين فى الشركة على التصرف الصحيح والاستجابة السريعة ' +
  'خلال الطوارئ، فيما يضمن الامن والسلامة لكافة العاملين.';

function defaultDrillReport() {
  return {
    scenario: '',
    purpose: DEFAULT_DRILL_REPORT_PURPOSE,
    narrativeSteps: [],
    resultIntro: '',
    resultPoints: [
      'جاهزية العاملين للتعامل مع الحالات الطارئة.',
      'الاستجابة السريعة للعاملين بدون اى تهاون.',
      'قيام كل مسئول بمهامه جيداً حسب تخصصه.',
      'قيام اعضاء قسم السلامة بمهامهم بصورة جيدة.',
      'التزام العاملين بتعليمات وتوجيهات السيفتى بسرعة وبدون استعلاء.'
    ],
    positives: [],
    negatives: [],
    improvements: [],
    thanksNote: 'هذا ونتقدم بخالص الشكر والامتنان للسادة الزملاء لحسن تعاونهم وسرعة الاستجابة للحالات الطارئة.',
    responsibleTitle: 'مسئول البيئة والسلامة',
    responsibleName: '',
    signatureDate: '',
    formCode: 'SE-03-F1',
    formVersion: 'VER.NO.:3',
    formDate: 'VER. DATE :1/5/2015',
    updatedAt: null,
    updatedBy: null
  };
}

// يبني ملف Word بنفس ديزاين نماذج تقارير التجارب الورقية (بدون صور)
async function buildDrillReportDocx(drill, report) {
  const FONT = 'Arial';
  const children = [];

  const plain = (text, opts = {}) => new DocxParagraph({
    alignment: DocxAlign.JUSTIFIED,
    bidirectional: true,
    spacing: { after: 120 },
    children: [ new DocxTextRun({ text: text || '', font: FONT, size: 24, bold: true, rightToLeft: true, ...opts }) ]
  });
  const bullet = (text) => new DocxParagraph({
    alignment: DocxAlign.JUSTIFIED,
    bidirectional: true,
    spacing: { after: 80 },
    children: [ new DocxTextRun({ text: `-   ${text}`, font: FONT, size: 22, rightToLeft: true }) ]
  });
  const header = (text) => new DocxParagraph({
    alignment: DocxAlign.RIGHT,
    bidirectional: true,
    spacing: { before: 200, after: 100 },
    children: [ new DocxTextRun({ text, font: FONT, size: 26, bold: true, underline: {}, rightToLeft: true }) ]
  });
  const blank = () => new DocxParagraph({ text: '' });

  children.push(new DocxParagraph({
    alignment: DocxAlign.CENTER,
    bidirectional: true,
    spacing: { after: 200 },
    children: [ new DocxTextRun({ text: 'تقرير تجربة طوارئ', font: FONT, size: 32, bold: true, rightToLeft: true }) ]
  }));
  if (drill.title) children.push(plain(drill.title, { bold: false, size: 22 }));
  children.push(blank());

  children.push(header('الغرض من التجربة:'));
  children.push(plain(report.purpose));
  if (report.scenario) {
    children.push(plain(`-  تم اجراء التجربة تجربة طوارئ وهمية ( ${report.scenario} )`));
  }
  children.push(plain('لقياس مدى وعى العاملين فى التعامل مع حالات الطوارئ'));
  children.push(blank());

  const dateLine = `تاريخ التجربة: ${drill.date || ''}        وقت التجربة: ${drill.startTime || ''}${drill.endTime ? (' - ' + drill.endTime) : ''}`;
  children.push(plain(dateLine));
  if (drill.location) children.push(plain(`مكان التجربة: ${drill.location}`));
  children.push(blank());

  children.push(plain('- تم إجراء التجربة كالأتى:'));
  (report.narrativeSteps || []).forEach(step => { if (step) children.push(bullet(step)); });
  children.push(blank());

  children.push(header('نتيجة التجربة'));
  if (report.resultIntro) children.push(plain(report.resultIntro, { bold: false }));
  (report.resultPoints || []).forEach(pt => { if (pt) children.push(bullet(pt)); });
  children.push(blank());

  children.push(header('الإيجابيات'));
  if ((report.positives || []).filter(Boolean).length) {
    report.positives.forEach(pt => { if (pt) children.push(bullet(pt)); });
  } else {
    children.push(plain('ـــــــــــــــــــــــــــــــــــــــــــــــ', { bold: false }));
  }
  children.push(blank());

  children.push(header('السلبيات'));
  if ((report.negatives || []).filter(Boolean).length) {
    report.negatives.forEach(pt => { if (pt) children.push(bullet(pt)); });
  } else {
    children.push(plain('ـــــــــــــــــــــــــــــــــــــــــــــــ', { bold: false }));
  }
  children.push(blank());

  children.push(header('نقاط للتحسين:-'));
  (report.improvements || []).forEach(pt => { if (pt) children.push(bullet(pt)); });
  children.push(blank());

  if (report.thanksNote) {
    children.push(plain(report.thanksNote, { bold: false }));
    children.push(blank());
  }

  children.push(plain(report.responsibleTitle || 'مسئول البيئة والسلامة'));
  children.push(plain(`الاسم: ${report.responsibleName || ''}`));
  children.push(plain(`التاريخ / التوقيع: ${report.signatureDate || drill.date || ''}`));
  children.push(blank());

  children.push(new DocxParagraph({
    alignment: DocxAlign.CENTER,
    children: [ new DocxTextRun({
      text: `${report.formCode || 'SE-03-F1'}     ${report.formVersion || 'VER.NO.:3'}     ${report.formDate || 'VER. DATE :1/5/2015'}`,
      size: 18, font: FONT
    }) ]
  }));

  const doc = new DocxDocument({ sections: [ { properties: {}, children } ] });
  return DocxPacker.toBuffer(doc);
}

// جلب بيانات الريبورت الخاص بتجربة معينة (أو نموذج فارغ بالتصميم الافتراضي لو لسه ملهاش ريبورت)
app.get('/api/drills/:id/report', authenticateToken, (req, res) => {
  const drills = readDrills();
  const drl = drills.find(d => d.id === req.params.id);
  if (!drl) return res.status(404).json({ error: 'التجربة غير موجودة' });
  res.json({
    report: drl.report || defaultDrillReport(),
    drill: { id: drl.id, title: drl.title, date: drl.date, location: drl.location, startTime: drl.startTime, endTime: drl.endTime, trainer: drl.trainer }
  });
});

// حفظ / تعديل الريبورت
app.put('/api/drills/:id/report', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  let result;
  await enqueueWrite(async () => {
    const drills = readDrills();
    const idx = drills.findIndex(d => d.id === req.params.id);
    if (idx === -1) { result = { status: 404, body: { error: 'التجربة غير موجودة' } }; return; }
    const incoming = (req.body && req.body.report) || {};
    const merged = Object.assign(defaultDrillReport(), drills[idx].report || {}, incoming, {
      updatedAt: new Date().toISOString(),
      updatedBy: (req.user && (req.user.name || req.user.username)) || 'admin'
    });
    drills[idx].report = merged;
    if (writeDrills(drills)) {
      result = { status: 200, body: { success: true, report: merged } };
    } else {
      result = { status: 500, body: { error: 'فشل حفظ الريبورت' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع' });
});

// تنزيل الريبورت بصيغة Word — نفس منطق حماية تصدير الحضور Excel أعلاه:
// authenticateTokenFlexible يقبل التوكن عبر ?dt=<token> ليبقى الرابط المباشر يعمل
// (11 سبتمبر 2026: تمت إضافة الحماية بعد أن كان هذا المسار مفتوحًا للجميع)
app.get('/api/drills/:id/report/export', authenticateTokenFlexible, async (req, res) => {
  try {
    const drills = readDrills();
    const drl = drills.find(d => d.id === req.params.id);
    if (!drl) return res.status(404).send('Drill not found');
    const report = drl.report || defaultDrillReport();
    const buffer = await buildDrillReportDocx(drl, report);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="Drill_Report_${drl.id}.docx"`);
    res.send(buffer);
  } catch (err) {
    console.error('Export drill report error:', err);
    if (!res.headersSent) res.status(500).send('Export failed');
  }
});

app.get('/api/drills/stats/employees', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin'), (req, res) => {
  let employees = readEmployees();
  
  // Department Admin Isolation
  if (req.user.role === 'dept_admin' && req.user.department) {
    employees = employees.filter(e => e.department === req.user.department);
  }

  const drills = readDrills();

  const statsMap = new Map();
  employees.forEach(e => {
    const code = normalizeEmpCode(e.code || e.empCode);
    if (!statsMap.has(code)) {
      statsMap.set(code, {
        empCode: code,
        name: e.name || 'غير معروف',
        department: e.department || 'غير محدد',
        attendedCount: 0,
        attendanceHours: 0,
        percentage: 0
      });
    }
  });

  drills.filter(t => !t.isDeleted).forEach(drl => {
    drl.attendees.forEach(att => {
      if (att.verified) {
        const code = normalizeEmpCode(att.empCode);
        if (statsMap.has(code)) {
          statsMap.get(code).attendedCount++;
        }
      }
    });
  });

  const statsList = Array.from(statsMap.values()).map(stat => {
    stat.attendanceHours = stat.attendedCount * 0.5;
    // Calculate percentage based on 8 hours target
    stat.percentage = Math.min(100, Math.round((stat.attendanceHours / 8) * 100));
    return stat;
  });

  res.json({ stats: statsList });
});

// ============================================================
// ⚖️ API ROUTES — PENALTIES (الجزاءات)
// ============================================================

function findEmployeeByCodeOrName(code, name) {
  const employees = readEmployees();
  if (code) {
    const nCode = normalizeEmpCode(code);
    const found = employees.find(e => normalizeEmpCode(e.empCode) === nCode);
    if (found) return found;
  }
  if (name) {
    const nName = String(name).trim();
    const found = employees.find(e => String(e.name || '').trim() === nName);
    if (found) return found;
  }
  return null;
}

// يحدّث الوظيفة (jobTitle) والقسم لكل جزاء بأحدث بيانات من شيت العمال الرئيسي (employees)
// بدل ما نعتمد على القيمة اللي اتخزنت وقت إنشاء الجزاء ولو اتغيرت بعدين في شيت الموظفين
// بيدور بالكود الوظيفي الأول، ولو مفيش كود أو مالقاش تطابق بيدور بالاسم كـ fallback
function enrichPenaltiesWithLiveEmployeeData(penalties) {
  const employees = readEmployees();
  const byCode = new Map();
  const byName = new Map();
  employees.forEach(e => {
    const nCode = normalizeEmpCode(e.empCode);
    if (nCode) byCode.set(nCode, e);
    const nName = String(e.name || '').trim();
    if (nName) byName.set(nName, e);
  });

  return penalties.map(p => {
    let emp = byCode.get(normalizeEmpCode(p.empCode));
    if (!emp) emp = byName.get(String(p.empName || '').trim());
    if (!emp) return p;
    return {
      ...p,
      jobTitle: emp.jobTitle || p.jobTitle || '',
      department: emp.department || p.department || ''
    };
  });
}

// GET /api/penalties — list active + deleted penalties (scoped by department for dept/maint admins)
app.get('/api/penalties', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin', 'maint_admin'), (req, res) => {
  let penalties = readPenalties();

  if ((req.user.role === 'dept_admin' || req.user.role === 'maint_admin') && req.user.department) {
    penalties = penalties.filter(p => p.department === req.user.department);
  }

  penalties = penalties.slice().sort((a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0));
  penalties = enrichPenaltiesWithLiveEmployeeData(penalties);
  res.json({ penalties });
});

// GET /api/my-penalties/:empCode — a worker's own ACTIVE penalties (public, matches /api/my-hazards convention)
app.get('/api/my-penalties/:empCode', (req, res) => {
  const code = normalizeEmpCode(req.params.empCode || '');
  if (!code) return res.status(400).json({ error: 'الكود الوظيفي مطلوب' });

  let penalties = readPenalties()
    .filter(p => normalizeEmpCode(p.empCode) === code && p.status !== 'deleted')
    .sort((a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0));
  penalties = enrichPenaltiesWithLiveEmployeeData(penalties);

  res.json({ penalties });
});

// POST /api/penalties — add a new penalty (super_admin & hse_admin only)
app.post('/api/penalties', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  const { empCode, date, reason, issuedBy } = req.body;

  if (!empCode || !reason) {
    return res.status(400).json({ error: 'الكود الوظيفي وسبب الجزاء مطلوبان' });
  }

  const employee = findEmployeeByCodeOrName(empCode, null);
  if (!employee) {
    return res.status(404).json({ error: 'الموظف غير موجود بكود ' + empCode });
  }

  const newPenalty = {
    id: 'PEN-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    empCode: normalizeEmpCode(employee.empCode),
    empName: employee.name || '',
    department: employee.department || '',
    jobTitle: employee.jobTitle || '',
    date: sanitizeStr(date || new Date().toISOString().slice(0, 10), 30),
    reason: sanitizeStr(reason, 1000),
    issuedBy: sanitizeStr(issuedBy || req.user.name || req.user.username || 'المشرف', 150),
    status: 'active',
    createdAt: new Date().toISOString(),
    createdBy: sanitizeStr(req.user.name || req.user.username || 'المشرف', 150)
  };

  await enqueueWrite(async () => {
    const penalties = readPenalties();
    penalties.push(newPenalty);
    writePenalties(penalties);
  });

  createNotification({
    targetEmpCode: newPenalty.empCode,
    type: 'penalty',
    title: 'جزاء جديد',
    message: `تم تسجيل جزاء عليك بتاريخ ${newPenalty.date}: ${newPenalty.reason}`,
    link: 'penaltiesWorker'
  });

  res.json({ success: true, penalty: newPenalty });
});

// DELETE /api/penalties/:id — soft-delete a penalty with a mandatory reason (super_admin & hse_admin only)
app.delete('/api/penalties/:id', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  const { reason } = req.body;
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'سبب حذف الجزاء مطلوب' });
  }

  let result;
  await enqueueWrite(async () => {
    const penalties = readPenalties();
    const idx = penalties.findIndex(p => p.id === req.params.id);
    if (idx === -1) {
      result = { status: 404, body: { error: 'الجزاء غير موجود' } };
      return;
    }
    penalties[idx].status = 'deleted';
    penalties[idx].deleteReason = sanitizeStr(reason, 1000);
    penalties[idx].deletedBy = sanitizeStr(req.user.name || req.user.username || 'المشرف', 150);
    penalties[idx].deletedAt = new Date().toISOString();
    writePenalties(penalties);
    result = { status: 200, body: { success: true } };
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ============================================================
// 🗑️ POST /api/admin/clear-module — مسح كامل لكل بيانات موديول معيّن
// (بلاغات الخطورة / تصاريح العمل / الجزاءات / التدريبات / تجارب الطوارئ).
// إجراء خطير وغير قابل للتراجع من داخل الابليكيشن — بياخد باك أب تلقائي
// بملف منفصل بتاريخ ووقت العملية قبل ما يمسح أي حاجة، عشان لو احتجنا نرجعها.
// مقصور على super_admin و hse_admin فقط، ولازم يبعت { confirm: 'تأكيد' }.
// بما إن العمال والأدمن بيقروا من نفس الملف، أي مسح هنا بيختفي فورًا من كل الشاشات.
// ============================================================
const CLEARABLE_MODULES = {
  hazards:   { read: readHazards,   write: writeHazards,   label: 'بلاغات الخطورة' },
  penalties: { read: readPenalties, write: writePenalties, label: 'الجزاءات' },
  trainings: { read: readTrainings, write: writeTrainings, label: 'التدريبات' },
  drills:    { read: readDrills,    write: writeDrills,    label: 'تجارب الطوارئ' },
  employees: { read: readEmployees, write: writeEmployees, label: 'الموظفين' }
};

app.post('/api/admin/clear-module', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  const { module: moduleName, confirm } = req.body || {};

  if (confirm !== 'تأكيد') {
    return res.status(400).json({ success: false, message: 'لازم تبعت تأكيد صريح لتنفيذ عملية المسح' });
  }

  const BACKUP_DIR = path.join(DATA_DIR, 'clear-backups');
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const actor = req.user.name || req.user.username || 'أدمن';

  let result;

  // التصاريح متخزنة جوه storage.json تحت مفتاح work-permits (مش ملف مستقل زي الباقي)
  if (moduleName === 'permits') {
    await enqueueWrite(async () => {
      const storage = readStorage();
      const current = storage['work-permits'] || '[]';
      let count = 0;
      try { count = JSON.parse(current).length; } catch { /* noop */ }
      try {
        fs.writeFileSync(path.join(BACKUP_DIR, `permits-${stamp}.json`), current, 'utf8');
      } catch (e) {
        console.error('[admin/clear-module] فشل حفظ الباك أب:', e.message);
      }
      storage['work-permits'] = JSON.stringify([]);
      if (writeStorage(storage)) {
        console.log(`[admin/clear-module] ${actor} مسح كل تصاريح العمل (${count} تصريح) — باك أب: permits-${stamp}.json`);
        result = { status: 200, body: { success: true, cleared: count, module: 'permits' } };
      } else {
        result = { status: 500, body: { success: false, message: 'فشل حفظ التغييرات' } };
      }
    });
    return res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
  }

  const mod = CLEARABLE_MODULES[moduleName];
  if (!mod) {
    return res.status(400).json({ success: false, message: 'موديول غير معروف' });
  }

  await enqueueWrite(async () => {
    const current = mod.read();
    const count = Array.isArray(current) ? current.length : 0;
    try {
      fs.writeFileSync(path.join(BACKUP_DIR, `${moduleName}-${stamp}.json`), JSON.stringify(current, null, 2), 'utf8');
    } catch (e) {
      console.error('[admin/clear-module] فشل حفظ الباك أب:', e.message);
    }
    if (mod.write([])) {
      console.log(`[admin/clear-module] ${actor} مسح كل ${mod.label} (${count} سجل) — باك أب: ${moduleName}-${stamp}.json`);
      result = { status: 200, body: { success: true, cleared: count, module: moduleName } };
    } else {
      result = { status: 500, body: { success: false, message: 'فشل حفظ التغييرات' } };
    }
  });

  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ============================================================
// 👔 EXECUTIVE VIEW — حساب "Executive View" الخاص بالمدير التنفيذي
// ============================================================
// Endpoint واحد فقط مسموح لدور 'ceo' الوصول له في كل السيرفر (requireRole
// أعلاه يمنع أي دور آخر، وهذا الـ endpoint نفسه GET بحت بدون أي كتابة) —
// يرجّع مؤشرات الشركة الكلية المجمّعة فقط، بدون أي تفاصيل تشغيلية فردية
// (أسماء عمال، أرقام تصاريح، إلخ) وبدون أي إمكانية اتخاذ إجراء. هذا يضمن
// أن حساب المدير التنفيذي "عرض فقط" فعليًا على مستوى السيرفر، مش بس
// إخفاء أزرار في الواجهة. 11 سبتمبر 2026.
function isSoftDeletedRecord(rec) {
  const db = rec && rec.deletedBy;
  return !!(db && (db.areaAdmin || db.safetyAdmin || db.superAdmin || db.worker));
}
function daysBetween(a, b) {
  const d1 = new Date(a), d2 = new Date(b);
  if (isNaN(d1) || isNaN(d2)) return null;
  const diff = (d2 - d1) / 86400000;
  return diff >= 0 ? diff : null;
}

app.get('/api/executive/overview', authenticateToken, requireRole('ceo'), (req, res) => {
  try {
    const storage = readStorage();
    let permits = storage['work-permits'];
    permits = typeof permits === 'string' ? JSON.parse(permits || '[]') : (Array.isArray(permits) ? permits : []);
    permits = permits.filter(p => !isSoftDeletedRecord(p));

    const hazards   = readHazards().filter(h => !isSoftDeletedRecord(h) && !(h.permanentlyDeletedBy && Object.values(h.permanentlyDeletedBy).some(Boolean)));
    const employees = readEmployees();
    const trainings = readTrainings();
    const drills     = readDrills();
    const penalties  = readPenalties().filter(p => p.status !== 'deleted');

    // ── Permits ──────────────────────────────────────────────
    const permitsByStatus = {};
    const approvalDurations = [];
    permits.forEach(p => {
      const st = p.status || 'pending';
      permitsByStatus[st] = (permitsByStatus[st] || 0) + 1;
      if (p.createdAt && p.reviewedAt && (st === 'approved' || st === 'rejected')) {
        const d = daysBetween(p.createdAt, p.reviewedAt);
        if (d !== null) approvalDurations.push(d);
      }
    });
    const avgApprovalDays = approvalDurations.length
      ? Math.round((approvalDurations.reduce((a, b) => a + b, 0) / approvalDurations.length) * 10) / 10
      : null;

    // ── Hazards ──────────────────────────────────────────────
    const hazardsByStatus = {};
    const hazardsByRisk = {};
    const closureDurations = [];
    hazards.forEach(h => {
      const st = h.status || 'open';
      hazardsByStatus[st] = (hazardsByStatus[st] || 0) + 1;
      const risk = h.riskLevel || 'غير محدد';
      hazardsByRisk[risk] = (hazardsByRisk[risk] || 0) + 1;
      if (h.submittedAt && h.resolvedAt) {
        const d = daysBetween(h.submittedAt, h.resolvedAt);
        if (d !== null) closureDurations.push(d);
      }
    });
    const avgClosureDays = closureDurations.length
      ? Math.round((closureDurations.reduce((a, b) => a + b, 0) / closureDurations.length) * 10) / 10
      : null;

    // ── Department leaderboard (مؤشر السلامة لكل قسم) ─────────
    const deptMap = new Map();
    function deptBucket(name) {
      const key = String(name || '').trim();
      if (!key) return null;
      if (!deptMap.has(key)) {
        deptMap.set(key, { department: key, hazardsTotal: 0, hazardsClosed: 0, permitsTotal: 0, permitsApproved: 0, employeeCount: 0 });
      }
      return deptMap.get(key);
    }
    hazards.forEach(h => {
      const b = deptBucket(h.department);
      if (!b) return;
      b.hazardsTotal++;
      if (h.status === 'closed') b.hazardsClosed++;
    });
    permits.forEach(p => {
      const b = deptBucket(p.department);
      if (!b) return;
      b.permitsTotal++;
      if (p.status === 'approved') b.permitsApproved++;
    });
    employees.forEach(e => {
      const b = deptBucket(e.department);
      if (b) b.employeeCount++;
    });
    // بعض تصاريح العمل المستوردة من الإكسيل القديم كتبت كود منطقة/موقع في
    // حقل "department" (مثال: "M.B", "P2", "القطعة 38") بدل اسم القسم
    // التنظيمي الحقيقي — هذه القيم تُنشئ عشرات "الأقسام" الوهمية بنتيجة
    // 100% كاذبة لو دخلت الليدربورد. نقصر الليدربورد على أسماء الأقسام
    // المعروفة فعليًا في قاعدة الموظفين فقط.
    const knownDepartments = new Set(employees.map(e => String(e.department || '').trim()).filter(Boolean));
    const departmentLeaderboard = Array.from(deptMap.values())
      .filter(b => knownDepartments.has(b.department))
      .filter(b => (b.hazardsTotal + b.permitsTotal) >= 3)
      .map(b => {
        const closureRate = b.hazardsTotal ? b.hazardsClosed / b.hazardsTotal : 1;
        const approvalRate = b.permitsTotal ? b.permitsApproved / b.permitsTotal : 1;
        const score = Math.round((closureRate * 70 + approvalRate * 30) * 10) / 10;
        return {
          department: b.department,
          employeeCount: b.employeeCount,
          hazardsTotal: b.hazardsTotal,
          hazardsClosed: b.hazardsClosed,
          hazardsOpen: b.hazardsTotal - b.hazardsClosed,
          permitsTotal: b.permitsTotal,
          score
        };
      })
      .sort((a, b) => b.score - a.score);

    const companySafetyScore = departmentLeaderboard.length
      ? Math.round((departmentLeaderboard.reduce((s, d) => s + d.score, 0) / departmentLeaderboard.length) * 10) / 10
      : null;

    // ── Training / Drills (آخر 12 شهر) ──────────────────────
    const oneYearAgo = new Date(); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const recentTrainings = trainings.filter(t => t.date && new Date(t.date) >= oneYearAgo);
    const trainingAttendeeSet = new Set();
    let trainingAttendances = 0;
    recentTrainings.forEach(t => (t.attendees || []).forEach(a => {
      trainingAttendances++;
      if (a.code || a.empCode) trainingAttendeeSet.add(normalizeEmpCode(a.code || a.empCode));
    }));

    const recentDrills = drills.filter(d => d.date && new Date(d.date) >= oneYearAgo);
    let drillAttendances = 0;
    recentDrills.forEach(d => { drillAttendances += (d.attendees || []).length; });

    // ── System activity (بدون تفاصيل فردية) ─────────────────
    const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const auditLog = readAuditLog();
    const recentActivityCount = auditLog.filter(e => e.timestamp && new Date(e.timestamp) >= sevenDaysAgo).length;

    res.json({
      generatedAt: new Date().toISOString(),
      totals: {
        employees: employees.length,
        permits: permits.length,
        hazards: hazards.length,
        openHazards: hazardsByStatus.open || 0,
        activePenalties: penalties.length,
      },
      permits: { byStatus: permitsByStatus, avgApprovalDays },
      hazards: { byStatus: hazardsByStatus, byRiskLevel: hazardsByRisk, avgClosureDays },
      training: {
        sessionsLast12Months: recentTrainings.length,
        attendancesLast12Months: trainingAttendances,
        uniqueEmployeesTrainedLast12Months: trainingAttendeeSet.size
      },
      drills: {
        sessionsLast12Months: recentDrills.length,
        attendancesLast12Months: drillAttendances
      },
      companySafetyScore,
      departmentLeaderboard,
      recentActivityCount7d: recentActivityCount
    });
  } catch (err) {
    console.error('[Executive] Overview failed:', err);
    res.status(500).json({ error: 'فشل تحميل المؤشرات التنفيذية' });
  }
});

// ============================================================
// 💾 DATABASE BACKUP / RESTORE (super_admin only)
// ============================================================
// نسخة احتياطية كاملة لقاعدة البيانات (كل التصاريح، البلاغات، الموظفين،
// التدريب، الجزاءات، الفحص الشهري...) كملف JSON واحد قابل للتنزيل، مع
// إمكانية الاسترجاع من نفس الملف من واجهة الإدارة مباشرة — بدون الحاجة
// للتواصل مع أي مطور لاسترجاع البيانات بعد أي حادثة. 11 سبتمبر 2026.
app.get('/api/admin/backup/export', authenticateTokenFlexible, requireRole('super_admin'), (req, res) => {
  try {
    const backup = dbExportAll();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="hse-platform-backup-${stamp}.json"`);
    res.send(JSON.stringify(backup));
  } catch (err) {
    console.error('[Backup] Export failed:', err);
    res.status(500).json({ error: 'فشل إنشاء النسخة الاحتياطية' });
  }
});

app.post('/api/admin/backup/import', authenticateToken, requireRole('super_admin'), async (req, res) => {
  const { backup, confirm } = req.body || {};
  if (confirm !== 'تأكيد') {
    return res.status(400).json({ error: 'لازم تبعت تأكيد صريح لاسترجاع نسخة احتياطية — هذه العملية تستبدل البيانات الحالية' });
  }
  if (!backup || typeof backup !== 'object') {
    return res.status(400).json({ error: 'ملف النسخة الاحتياطية غير صالح' });
  }
  let result;
  await enqueueWrite(async () => {
    try {
      const summary = dbImportAll(backup);
      logAuditEvent({ entityType: 'database', entityId: 'full-backup', action: 'restore', actor: req.user, note: `استرجاع ${summary.restored} مجموعة بيانات` });
      result = { status: 200, body: { success: true, ...summary } };
    } catch (err) {
      console.error('[Backup] Import failed:', err);
      result = { status: 500, body: { error: err.message || 'فشل استرجاع النسخة الاحتياطية' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// POST /api/penalties/upload-excel — bulk import from the old penalties sheet (super_admin & hse_admin only)
app.post('/api/penalties/upload-excel', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  try {
    const { base64Data } = req.body;
    if (!base64Data) {
      return res.status(400).json({ success: false, message: 'لا توجد بيانات ملف' });
    }

    const buffer = Buffer.from(base64Data, 'base64');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    let ws = workbook.worksheets[0];
    let headerRowNumber = 1;
    let colMap = { code: 1, name: 2, dept: 3, pos: 4, date: 5, reason: 6, issuedBy: 7 };
    let headersFound = false;

    for (const sheet of workbook.worksheets) {
      sheet.eachRow((row, rowNum) => {
        if (headersFound || rowNum > 5) return;
        const vals = row.values;
        const hasReason = vals.some(v => v && String(v).includes('جزاء') && String(v).includes('سبب'));
        const hasName   = vals.some(v => v && String(v).includes('اسم'));
        if (hasReason && hasName) {
          ws = sheet;
          headerRowNumber = rowNum;
          headersFound = true;
          vals.forEach((v, idx) => {
            if (!v) return;
            const val = String(v).toLowerCase();
            if (val.includes('كود') || val.includes('code')) colMap.code = idx;
            else if (val.includes('اسم')) colMap.name = idx;
            else if (val.includes('قسم')) colMap.dept = idx;
            else if (val.includes('وظيفة')) colMap.pos = idx;
            else if (val.includes('تاريخ')) colMap.date = idx;
            else if (val.includes('سبب')) colMap.reason = idx;
            else if (val.includes('مشرف') || val.includes('سيفتي')) colMap.issuedBy = idx;
          });
        }
      });
      if (headersFound) break;
    }

    const employees = readEmployees();
    const penalties = readPenalties();
    let importedCount = 0;
    let skippedCount = 0;

    ws.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRowNumber) return;
      const vals = row.values;

      const rawCode = String(vals[colMap.code] || '').trim();
      const name    = String(vals[colMap.name] || '').trim();
      const reason  = String(vals[colMap.reason] || '').trim();
      if (!name && !rawCode) return; // fully empty row
      if (!reason) { skippedCount++; return; }

      // Try to resolve the employee by code first, then fall back to matching by name
      let emp = null;
      if (rawCode) {
        const nCode = normalizeEmpCode(rawCode);
        emp = employees.find(e => normalizeEmpCode(e.empCode) === nCode);
      }
      if (!emp && name) {
        emp = employees.find(e => String(e.name || '').trim() === name);
      }

      let dateObj = vals[colMap.date];
      let dateStr = new Date().toISOString().slice(0, 10);
      if (dateObj instanceof Date) {
        dateStr = dateObj.toISOString().slice(0, 10);
      } else if (typeof dateObj === 'string' && dateObj.trim()) {
        const parsed = new Date(dateObj.trim());
        if (!isNaN(parsed.getTime())) dateStr = parsed.toISOString().slice(0, 10);
      } else if (typeof dateObj === 'number') {
        dateStr = new Date(Math.round((dateObj - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
      }

      penalties.push({
        id: 'PEN-' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '-' + rowNumber,
        empCode: emp ? normalizeEmpCode(emp.empCode) : normalizeEmpCode(rawCode),
        empName: emp ? emp.name : name,
        department: emp ? (emp.department || '') : String(vals[colMap.dept] || '').trim(),
        jobTitle: emp ? (emp.jobTitle || '') : String(vals[colMap.pos] || '').trim(),
        date: dateStr,
        reason: sanitizeStr(reason, 1000),
        issuedBy: sanitizeStr(String(vals[colMap.issuedBy] || 'غير محدد').trim(), 150),
        status: 'active',
        createdAt: new Date().toISOString(),
        createdBy: sanitizeStr(req.user.name || req.user.username || 'استيراد ملف', 150),
        imported: true
      });
      importedCount++;
    });

    writePenalties(penalties);
    res.json({ success: true, count: importedCount, skipped: skippedCount });
  } catch (err) {
    console.error('Penalties import error:', err);
    res.status(500).json({ success: false, message: 'فشل استيراد الملف' });
  }
});

// ============================================================
// 🔔 API ROUTES — NOTIFICATION CENTER
// ============================================================

app.get('/api/notifications', (req, res) => {
  const { role, empCode, department } = req.query;
  const notifications = readNotifications();
  
  // Filter notifications based on role or empCode
  let userNotifs = notifications.filter(n => {
    if (n.targetRole === 'all') return true;
    if (role === 'super_admin') return true;
    if (n.targetEmpCode && empCode && normalizeEmpCode(n.targetEmpCode) === normalizeEmpCode(empCode)) return true;
    // maint_admin is a department-scoped variant of dept_admin (see getRoleKey) —
    // treat the two interchangeably so maintenance admins get the same
    // department notifications a regular department head would.
    const roleMatches = n.targetRole && role && (
      n.targetRole === role ||
      (n.targetRole === 'dept_admin' && role === 'maint_admin') ||
      (n.targetRole === 'maint_admin' && role === 'dept_admin')
    );
    if (roleMatches) {
      if (n.targetDept) return n.targetDept === department;
      return true;
    }
    return false;
  });

  // Sort newest first
  userNotifs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  res.json({ notifications: userNotifs });
});

app.post('/api/notifications/mark-read', (req, res) => {
  const { id, empCode, role } = req.body;
  const identifier = empCode || role || 'unknown';
  
  enqueueWrite(async () => {
    const notifications = readNotifications();
    let changed = false;
    
    notifications.forEach(n => {
      if ((id === 'all' || n.id === id) && !n.readBy.includes(identifier)) {
        // Simple permission check logic matches the get route
        let canRead = false;
        if (n.targetRole === 'all') canRead = true;
        if (n.targetEmpCode && empCode && normalizeEmpCode(n.targetEmpCode) === normalizeEmpCode(empCode)) canRead = true;
        if (n.targetRole && role) {
          if (n.targetRole === 'admin' && ['superadmin', 'admin', 'supervisor', 'area_head'].includes(role)) canRead = true;
          if (n.targetRole === role) canRead = true;
          if (n.targetRole === 'dept_admin' && role === 'maint_admin') canRead = true;
          if (n.targetRole === 'maint_admin' && role === 'dept_admin') canRead = true;
        }
        
        if (canRead) {
          n.readBy.push(identifier);
          changed = true;
        }
      }
    });
    
    if (changed) writeNotifications(notifications);
  });
  
  res.json({ success: true });
});

app.delete('/api/notifications/:id', authenticateToken, requireRole('superadmin', 'admin'), (req, res) => {
  enqueueWrite(async () => {
    const notifications = readNotifications();
    const filtered = notifications.filter(n => n.id !== req.params.id);
    if (filtered.length !== notifications.length) {
      writeNotifications(filtered);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Not found' });
    }
  });
});

// ── ⏰ BACKGROUND SCHEDULER: 10-Min Pre-Training Alerts ──────
let preTrainingNotifiedSessions = new Set(); // Keep track in memory

function checkPreTrainingAlerts() {
  try {
    const trainings = readTrainings();
    const now = new Date();
    
    trainings.forEach(trn => {
      if (trn.status === 'active' || trn.status === 'scheduled' || !trn.status) { // if status is missing assume scheduled
        // Attempt to construct session start Date
        const [hours, minutes] = (trn.startTime || '00:00').split(':');
        const sessionStart = new Date(trn.date);
        sessionStart.setHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);
        
        const diffMs = sessionStart - now;
        const diffMins = Math.floor(diffMs / 60000);
        
        // Between 0 and 10 minutes from now, and haven't notified yet
        if (diffMins > 0 && diffMins <= 10 && !preTrainingNotifiedSessions.has(trn.id)) {
          preTrainingNotifiedSessions.add(trn.id);
          createNotification({
            targetRole: 'worker',
            targetGroup: trn.targetGroup,
            type: 'training',
            title: '⏰ تذكير: بدء محاضرة التدريب',
            message: `محاضرة ${trn.title} ستبدأ خلال 10 دقائق في ${trn.location || 'الموقع المحدد'}. يرجى التوجه وتجهيز الـ PIN.`,
            link: 'tabTrainingWorker'
          });
          console.log(`[Scheduler] 10-min alert triggered for training: ${trn.id}`);
        }
      }
    });
  } catch(e) {
    console.error('Error in checkPreTrainingAlerts:', e);
  }
}
setInterval(checkPreTrainingAlerts, 60000); // Check every 60 seconds

// ── Web Push API Routes ──────────────────────────────────────────
// Legacy camelCase endpoint
app.get('/api/vapid-publicKey', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey || '' });
});
// Standard kebab-case endpoint (used by frontend fetch)
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey || '' });
});


app.post('/api/notifications/subscribe', (req, res) => {
  const { subscription, role, empCode } = req.body;
  if (!subscription) {
    return res.status(400).json({ error: 'Subscription object missing' });
  }
  
  enqueueWrite(async () => {
    let subscriptions = readSubscriptions();
    const existingIdx = subscriptions.findIndex(sub => sub.subscription.endpoint === subscription.endpoint);
    
    const subData = {
      subscription,
      role: role || null,
      empCode: empCode ? normalizeEmpCode(empCode) : null,
      updatedAt: new Date().toISOString()
    };
    
    if (existingIdx !== -1) {
      subscriptions[existingIdx] = subData;
    } else {
      subscriptions.push(subData);
    }
    
    writeSubscriptions(subscriptions);
  });
  
  res.status(201).json({ success: true });
});

// ملاحظة: كان هنا تعريف ثانٍ مكرر لنفس المسار GET /api/drills/export/:id
// (كود قديم غير مستخدم يقرأ من drills.json في جذر المشروع بدل data/drills.json
// الصحيح) — تمت إزالته لأنه كان أصلاً كودًا ميتًا لا يُنفَّذ أبدًا (Express
// يستخدم أول تعريف مطابق فقط، الموجود أعلاه بالسطر ~4407)، ووجوده كان يسبب
// التباسًا لأي تعديل مستقبلي. 11 سبتمبر 2026.

// ── GET /api/departments — قائمة الأقسام الموجودة فعليًا في قاعدة الموظفين
// تستخدمها لوحة التحكم (Dashboard) لعرض فلتر "اختر القسم" لمدير النظام
// ومشرف السلامة فقط، بحيث يقدروا يشوفوا داشبورد أي قسم بعينه.
app.get('/api/departments', authenticateToken, requireRole('super_admin', 'hse_admin'), (req, res) => {
  try {
    const employees = readEmployees();
    const depts = [...new Set(
      employees
        .map(e => String(e.department || '').trim())
        .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b, 'ar'));
    res.json({ departments: depts });
  } catch (err) {
    res.status(500).json({ error: 'فشل تحميل قائمة الأقسام' });
  }
});

// ── Analytics / Dashboard API ─────────────────────────────────
// GET /api/analytics — consolidated stats for the dashboard
// Scoped by role: super_admin/hse_admin = global, dept_admin = their dept
app.get('/api/analytics', async (req, res) => {
  try {
    let role = 'worker';
    let department = null;
    let tokenEmpCode = null;

    // Check JWT manually
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        role = decoded.role;
        department = decoded.department;
        // Dynamic role patches for legacy compatibility
        if (role === 'dept_admin') {
          if (department && department.toUpperCase() === 'HSE') {
            role = 'hse_admin';
            department = '';
          } else if (department && ['Electrical Maintenance', 'Mechanical Maintenance', 'Preventive Maintenance'].includes(department)) {
            role = 'maint_admin';
          }
        }
        if (decoded.username === 'hse_admin') role = 'hse_admin';
      } catch (err) {
        return res.status(401).json({ error: 'Token غير صالح', expired: err.name === 'TokenExpiredError' });
      }
    } else {
      // Worker login fallback (no JWT)
      tokenEmpCode = req.headers['x-worker-code'];
      if (!tokenEmpCode) {
        return res.status(401).json({ error: 'غير مصرح: يجب تسجيل الدخول أولاً' });
      }
    }

    let { dateFrom, dateTo, dept, empCode } = req.query;
    
    // Force empCode for workers to restrict access to their personal data only
    if (role === 'worker') {
      empCode = tokenEmpCode;
    }

    // ── Parse date range ─────────────────────────────────────────
    const from = dateFrom ? new Date(dateFrom) : null;
    const to   = dateTo   ? new Date(dateTo + 'T23:59:59') : null;

    function inRange(dateStr) {
      if (!dateStr) return true;
      const d = new Date(dateStr);
      if (from && d < from) return false;
      if (to   && d > to)   return false;
      return true;
    }

    // ── RBAC dept scope ──────────────────────────────────────────
    // dept_admin (department head) and maint_admin are both department-scoped
    // roles and must always be locked to their own department, regardless of
    // any ?dept= query param. Only super_admin/hse_admin may pass ?dept= to
    // voluntarily narrow the company-wide view.
    const scopeDept = (role === 'dept_admin' || role === 'maint_admin') ? department : (dept || null);

    // ── Load all data ────────────────────────────────────────────
    let permits  = [];
    let hazards  = [];
    let trainings = [];
    let drills   = [];
    let penalties = readPenalties().filter(p => p.status !== 'deleted');

    // Permits from the DB-backed storage collection
    const rawStorage = readStorage();
    const storedPermits = rawStorage['work-permits'];
    if (storedPermits) {
      permits = JSON.parse(typeof storedPermits === 'string' ? storedPermits : JSON.stringify(storedPermits));
      if (!Array.isArray(permits)) permits = [];
    }

    hazards   = readHazards();
    trainings = readTrainings();
    drills    = readDrills();
    if (!Array.isArray(hazards))   hazards = [];
    if (!Array.isArray(trainings)) trainings = [];
    if (!Array.isArray(drills))    drills = [];

    // ── Filter by dept scope ────────────────────────────────
    // Normalize codes the same way employee login does (trim + strip leading
    // zeros) so old bulk-imported Excel records (which sometimes store
    // "0271" or use a plain "code" field instead of "empCode") still match.
    function normEmp(v) {
      if (v === null || v === undefined) return '';
      const s = String(v).trim();
      const stripped = s.replace(/^0+/, '');
      return (stripped === '' ? '0' : stripped).toUpperCase();
    }
    function attendeeCode(a) {
      return normEmp(a.empCode || a.code || a.employeeCode || a.id || '');
    }

    if (scopeDept) {
      permits   = permits.filter(p  => (p.department || p.dept || '').toLowerCase().includes(scopeDept.toLowerCase()));
      hazards   = hazards.filter(h  => (h.department || h.dept || '').toLowerCase().includes(scopeDept.toLowerCase()));
      penalties = penalties.filter(p => (p.department || '').toLowerCase().includes(scopeDept.toLowerCase()));

      // Trainings/drills don't carry a reliable per-record department field —
      // the old code matched on the session's own `targetGroup` text (or let
      // sessions with no targetGroup through for every department), which
      // has nothing to do with who actually attended. That let a department
      // see every attendee of a shared/company-wide session (over-counting)
      // while dropping real attendances from sessions tagged for a different
      // group (under-counting) — exactly backwards. The correct scope is:
      // only count attendees who are themselves registered employees of this
      // department, session tagging aside.
      const scopeDeptNorm = String(scopeDept).trim().toLowerCase();
      const deptEmpCodes = new Set(
        readEmployees()
          .filter(e => String(e.department || '').trim().toLowerCase() === scopeDeptNorm)
          .map(e => normEmp(e.empCode || e.code || e.id))
          .filter(Boolean)
      );
      trainings = trainings
        .map(t => ({ ...t, attendees: (t.attendees || []).filter(a => deptEmpCodes.has(attendeeCode(a))) }))
        .filter(t => t.attendees.length > 0);
      drills = drills
        .map(d => ({ ...d, attendees: (d.attendees || []).filter(a => deptEmpCodes.has(attendeeCode(a))) }))
        .filter(d => d.attendees.length > 0);
    }

    // ── Resolve the employee being viewed (for the personal-dashboard header) ──
    // Populated whenever an empCode filter is applied — whether it's a worker
    // viewing their own data, or an admin filtering the company-wide dashboard
    // down to one employee. The frontend uses this to know it should switch to
    // the personal dashboard layout instead of the admin one.
    let viewingEmployee = null;
    if (empCode) {
      const wantCodeForLookup = normEmp(empCode);
      const allEmployees = readEmployees();
      let empRecord = allEmployees.find(e => normEmp(e.empCode || e.code || e.id) === wantCodeForLookup);

      // Department-scoped admins (dept_admin/maint_admin) must never learn
      // anything about an employee outside their own department — not even
      // that the code belongs to someone. Treat an out-of-scope employee
      // exactly like "not found" so the response is indistinguishable.
      if (empRecord && scopeDept && (role === 'dept_admin' || role === 'maint_admin')) {
        const empDeptNorm  = String(empRecord.department || '').trim().toLowerCase();
        const scopeDeptNorm = String(scopeDept || '').trim().toLowerCase();
        if (empDeptNorm !== scopeDeptNorm) {
          empRecord = null;
        }
      }

      if (empRecord) {
        viewingEmployee = {
          empCode:    empRecord.empCode || empRecord.code || empCode,
          name:       empRecord.name || '',
          jobTitle:   empRecord.jobTitle || '',
          department: empRecord.department || '',
        };
      } else {
        // Employee not found in the master list — still show something rather
        // than silently falling back to the full admin dashboard.
        viewingEmployee = { empCode, name: '', jobTitle: '', department: '' };
      }
    }

    if (empCode) {
      const wantCode = normEmp(empCode);
      permits   = permits.filter(p => normEmp(p.empCode || p.code) === wantCode);
      hazards   = hazards.filter(h => normEmp(h.empCode || h.code) === wantCode);
      trainings = trainings
        .map(t => ({ ...t, attendees: (t.attendees || []).filter(a => attendeeCode(a) === wantCode) }))
        .filter(t => t.attendees.length > 0); // keep only sessions this employee actually attended
      drills    = drills
        .map(d => ({ ...d, attendees: (d.attendees || []).filter(a => attendeeCode(a) === wantCode) }))
        .filter(d => d.attendees.length > 0); // keep only drills this employee actually attended
      penalties = penalties.filter(p => normEmp(p.empCode) === wantCode);
    }

    // ── Filter by date range (permit createdAt / hazard date) ──
    permits   = permits.filter(p => inRange(p.createdAt || p.date || p.submittedAt));
    hazards   = hazards.filter(h => inRange(h.date || h.createdAt));
    trainings = trainings.filter(t => inRange(t.date || t.createdAt));
    drills    = drills.filter(d => inRange(d.date || d.createdAt));
    penalties = penalties.filter(p => inRange(p.date || p.createdAt));

    // ── Permit stats ─────────────────────────────────────────────
    const permitTotal  = permits.length;
    const permitByStatus = {
      approved: permits.filter(p => p.status === 'approved').length,
      pending:  permits.filter(p => p.status === 'pending').length,
      rejected: permits.filter(p => p.status === 'rejected').length,
    };
    const permitByType = {};
    permits.forEach(p => {
      const t = p.typeKey || p.type || p.permitType || 'general';
      permitByType[t] = (permitByType[t] || 0) + 1;
    });

    // ── Monthly time series (last 12 months) ─────────────────────
    function buildMonthly(items, dateField) {
      const months = {};
      const now = new Date();
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        months[key] = 0;
      }
      items.forEach(item => {
        const raw = item[dateField] || item.date || item.createdAt || item.submittedAt;
        if (!raw) return;
        const d = new Date(raw);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (key in months) months[key]++;
      });
      return months;
    }

    const permitsMonthly  = buildMonthly(permits,  'createdAt');
    const hazardsMonthly  = buildMonthly(hazards,  'date');
    const trainingsMonthly = buildMonthly(trainings, 'date');
    const drillsMonthly   = buildMonthly(drills,   'date');

    // ── Hazard stats ─────────────────────────────────────────────
    const hazardTotal = hazards.length;
    const hazardByStatus = {
      open:     hazards.filter(h => !h.status || h.status === 'open' || h.status === 'in_progress' || h.status === 'pending').length,
      resolved: hazards.filter(h => h.status === 'resolved' || h.status === 'closed').length,
      rejected: hazards.filter(h => h.status === 'rejected').length,
    };
    const hazardBySeverity = { low: 0, medium: 0, high: 0, critical: 0 };
    hazards.forEach(h => {
      const risk = parseInt(h.riskScore || h.risk || 0);
      if (risk >= 16) hazardBySeverity.critical++;
      else if (risk >= 9 || h.riskLevel === 'H') hazardBySeverity.high++;
      else if (risk >= 4 || h.riskLevel === 'M') hazardBySeverity.medium++;
      else hazardBySeverity.low++;
    });

    // ── Training stats ───────────────────────────────────────────
    const trainingTotal    = trainings.length;
    const trainingAttendees = trainings.reduce((s, t) => s + (t.attendees || []).length, 0);
    const topicCounts = {};
    trainings.forEach(t => {
      const topic = t.topic || t.title || 'غير محدد';
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    });
    const topTopics = Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, count]) => ({ label, count }));

    // Session duration helper (mirrors frontend logic — default session = 0.5h)
    function getTrainingDuration(t) {
      if (t && t.durationHours !== undefined && t.durationHours !== null && t.durationHours !== '') return Number(t.durationHours);
      if (t && t.hours !== undefined && t.hours !== null && t.hours !== '') return Number(t.hours);
      if (t && t.duration !== undefined && t.duration !== null && t.duration !== '') return Number(t.duration);
      if (t && t.durationMinutes) return Number(t.durationMinutes) / 60;
      return 0.5;
    }
    // Company-wide total training hours delivered = half an hour per attendance
    // (each employee attending a session = 0.5 training hour), NOT per training
    // session/lecture. A lecture attended by 20 people delivers 10 training-hours,
    // not 0.5.
    const trainingTotalHours = trainingAttendees / 2;
    // Compact list, most recent first — used for personal (worker) & department views
    const trainingsList = trainings
      .slice()
      .sort((a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0))
      .slice(0, 100)
      .map(t => ({
        title: t.topic || t.title || 'محاضرة تدريبية',
        date: t.date || t.createdAt || null,
        hours: getTrainingDuration(t),
        trainer: t.trainer || t.instructor || '',
      }));

    // ── Drill stats ──────────────────────────────────────────────
    const activeDrills = drills.filter(d => d.status === 'active').length;
    const closedDrills = drills.filter(d => d.status === 'closed').length;
    const drillTotal   = drills.length;
    const drillAttendees = drills.reduce((s, d) => s + (d.attendees || []).length, 0);
    const drillsList = drills
      .slice()
      .sort((a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0))
      .slice(0, 100)
      .map(d => ({
        title: d.title || d.name || 'تجربة إخلاء',
        date: d.date || d.createdAt || null,
        status: d.status || 'active',
        location: d.location || '',
      }));

    // ── Compact lists for hazards & permits (personal / department views) ──
    const hazardsList = hazards
      .slice()
      .sort((a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0))
      .slice(0, 100)
      .map(h => ({
        title: h.description || h.title || h.hazardType || 'بلاغ خطورة',
        date: h.date || h.createdAt || null,
        status: (h.status === 'resolved' || h.status === 'closed') ? 'resolved' : (h.status === 'rejected' ? 'rejected' : 'open'),
        department: h.department || h.dept || '',
      }));

    const permitsList = permits
      .slice()
      .sort((a, b) => new Date(b.createdAt || b.date || 0) - new Date(a.createdAt || a.date || 0))
      .slice(0, 100)
      .map(p => ({
        title: p.typeLabel || p.type || p.permitType || 'تصريح عمل',
        date: p.createdAt || p.date || null,
        status: p.status || 'pending',
      }));

    // ── Penalties stats & compact list ───────────────────────────
    const penaltyTotal = penalties.length;
    const penaltiesList = penalties
      .slice()
      .sort((a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0))
      .slice(0, 100)
      .map(p => ({
        title: p.reason || 'جزاء',
        date: p.date || p.createdAt || null,
        issuedBy: p.issuedBy || '',
        empName: p.empName || '',
      }));

    res.json({
      permits: { total: permitTotal, byStatus: permitByStatus, byType: permitByType, monthly: permitsMonthly, list: permitsList },
      hazards: { total: hazardTotal, byStatus: hazardByStatus, bySeverity: hazardBySeverity, monthly: hazardsMonthly, list: hazardsList },
      trainings: { total: trainingTotal, totalAttendees: trainingAttendees, totalHours: trainingTotalHours, topTopics, monthly: trainingsMonthly, list: trainingsList },
      drills: { total: drillTotal, active: activeDrills, closed: closedDrills, totalAttendees: drillAttendees, monthly: drillsMonthly, list: drillsList },
      penalties: { total: penaltyTotal, list: penaltiesList },
      meta: { role, scopeDept, dateFrom, dateTo, empCode: empCode || null, viewingEmployee, generatedAt: new Date().toISOString() }
    });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Analytics error' });
  }
});

// ============================================================
// 🦺 API ROUTES — الفحص الشهري (MONTHLY INSPECTION)
// وحدة كاملة: مقصورة حصريًا على hse_admin و super_admin. برنامجا فحص
// مستقلان تمامًا P1 (33 قسمًا) و P2 (27 قسمًا)، كل قسم له سجل أصناف
// خاص به وسجلات فحص شهرية منفصلة لكل صنف×شهر×سنة. 11 سبتمبر 2026.
// ============================================================

const INSPECTION_ADMIN_ROLES = ['hse_admin', 'super_admin'];

function computeInspectionStats(sectionItems, allRecords, year, month) {
  let compliant = 0, nonCompliant = 0;
  const recMap = new Map();
  allRecords.forEach(r => {
    if (r.year === year && r.month === month) recMap.set(r.itemId, r);
  });
  sectionItems.forEach(it => {
    const r = recMap.get(it.id);
    if (!r) return;
    if (r.status === 'مطابق') compliant++;
    else if (r.status === 'غير مطابق') nonCompliant++;
  });
  const total = sectionItems.length;
  const pending = total - compliant - nonCompliant;
  const compliancePct = total > 0 ? Math.round((compliant / total) * 1000) / 10 : null;
  return { itemCount: total, compliant, nonCompliant, pending, compliancePct };
}

// ── GET /api/inspections/sections — قائمة أقسام برنامج P1 أو P2 مع مؤشرات
// أداء شهر/سنة محددين (افتراضيًا الشهر والسنة الحاليين)
app.get('/api/inspections/sections', authenticateToken, requireRole(...INSPECTION_ADMIN_ROLES), (req, res) => {
  try {
    const category = (req.query.category || '').toUpperCase();
    if (category !== 'P1' && category !== 'P2') {
      return res.status(400).json({ error: 'يجب تحديد category=P1 أو category=P2' });
    }
    const now = new Date();
    const year = parseInt(req.query.year, 10) || now.getFullYear();
    const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);

    const sections = readInspectionSections().filter(s => s.category === category);
    const items = readInspectionItems();
    const records = readInspectionRecords();

    const result = sections
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map(s => {
        const sectionItems = items.filter(it => it.sectionId === s.id);
        const stats = computeInspectionStats(sectionItems, records, year, month);
        return Object.assign({}, s, stats);
      });

    res.json({ category, year, month, sections: result });
  } catch (err) {
    console.error('Inspection sections list error:', err);
    res.status(500).json({ error: 'فشل تحميل الأقسام' });
  }
});

// ── POST /api/inspections/sections — إضافة قسم فحص جديد يدويًا
app.post('/api/inspections/sections', authenticateToken, requireRole(...INSPECTION_ADMIN_ROLES), async (req, res) => {
  const { category, name } = req.body || {};
  const cat = (category || '').toUpperCase();
  if (cat !== 'P1' && cat !== 'P2') {
    return res.status(400).json({ error: 'يجب تحديد category=P1 أو category=P2' });
  }
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'اسم القسم مطلوب' });
  }
  let result;
  await enqueueWrite(async () => {
    const sections = readInspectionSections();
    const maxOrder = sections.filter(s => s.category === cat).reduce((m, s) => Math.max(m, s.order || 0), 0);
    const section = {
      id: 'INSEC-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
      category: cat,
      order: maxOrder + 1,
      name: String(name).trim(),
      createdAt: new Date().toISOString(),
      createdBy: req.user.username || req.user.id
    };
    const sections2 = sections.concat([section]);
    if (writeInspectionSections(sections2)) {
      logAuditEvent({ entityType: 'inspection-section', entityId: section.id, action: 'create', actor: req.user, note: `${cat}: ${section.name}` });
      result = { status: 201, body: { success: true, section } };
    } else {
      result = { status: 500, body: { error: 'فشل حفظ القسم' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ── DELETE /api/inspections/sections/:id — حذف قسم (مع كل أصنافه وسجلاته
// إذا مرّرت ?cascade=true؛ وإلا يُرفض الحذف إذا كان القسم يحتوي أصنافًا)
app.delete('/api/inspections/sections/:id', authenticateToken, requireRole(...INSPECTION_ADMIN_ROLES), async (req, res) => {
  const sectionId = req.params.id;
  const cascade = req.query.cascade === 'true';
  let result;
  await enqueueWrite(async () => {
    const sections = readInspectionSections();
    const idx = sections.findIndex(s => s.id === sectionId);
    if (idx === -1) {
      result = { status: 404, body: { error: 'القسم غير موجود' } };
      return;
    }
    const items = readInspectionItems();
    const sectionItemIds = items.filter(it => it.sectionId === sectionId).map(it => it.id);

    if (sectionItemIds.length > 0 && !cascade) {
      result = { status: 409, body: { error: `القسم يحتوي ${sectionItemIds.length} صنف. أضف ?cascade=true لحذف القسم وكل أصنافه وسجلاته نهائيًا.`, itemCount: sectionItemIds.length } };
      return;
    }

    const removedSection = sections[idx];
    const remainingSections = sections.slice(0, idx).concat(sections.slice(idx + 1));

    let remainingItems = items;
    let removedRecordsCount = 0;
    if (sectionItemIds.length > 0) {
      remainingItems = items.filter(it => it.sectionId !== sectionId);
      const records = readInspectionRecords();
      const remainingRecords = records.filter(r => {
        const belongs = sectionItemIds.includes(r.itemId);
        if (belongs) removedRecordsCount++;
        return !belongs;
      });
      writeInspectionRecords(remainingRecords);
    }

    if (writeInspectionSections(remainingSections) && writeInspectionItems(remainingItems)) {
      logAuditEvent({ entityType: 'inspection-section', entityId: sectionId, action: 'delete', actor: req.user, note: `${removedSection.category}: ${removedSection.name} (${sectionItemIds.length} صنف، ${removedRecordsCount} سجل فحص)` });
      result = { status: 200, body: { success: true } };
    } else {
      result = { status: 500, body: { error: 'فشل حذف القسم' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ── GET /api/inspections/sections/:id/items — أصناف القسم مع حالة فحص
// الشهر المحدد (year/month)، بدعم فلاتر department / status / q (بحث)
app.get('/api/inspections/sections/:id/items', authenticateToken, requireRole(...INSPECTION_ADMIN_ROLES), (req, res) => {
  try {
    const sectionId = req.params.id;
    const sections = readInspectionSections();
    const section = sections.find(s => s.id === sectionId);
    if (!section) return res.status(404).json({ error: 'القسم غير موجود' });

    const now = new Date();
    const year = parseInt(req.query.year, 10) || now.getFullYear();
    const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);

    const allItems = readInspectionItems().filter(it => it.sectionId === sectionId);
    const records = readInspectionRecords();
    const recMap = new Map();
    records.forEach(r => {
      if (r.sectionId === sectionId && r.year === year && r.month === month) recMap.set(r.itemId, r);
    });

    let merged = allItems.map(it => {
      const rec = recMap.get(it.id) || null;
      return Object.assign({}, it, {
        record: rec ? {
          id: rec.id, status: rec.status, notes: rec.notes || '',
          inspectionDate: rec.inspectionDate || null, inspector: rec.inspector || '',
          updatedAt: rec.updatedAt || rec.createdAt
        } : null,
        status: rec ? rec.status : 'لم يتم الفحص'
      });
    });

    const { department, status, q } = req.query;
    if (department) {
      merged = merged.filter(it => String(it.department || '').trim() === String(department).trim());
    }
    if (status) {
      merged = merged.filter(it => it.status === status);
    }
    if (q) {
      const qq = String(q).trim().toLowerCase();
      merged = merged.filter(it =>
        String(it.itemNumber || '').toLowerCase().includes(qq) ||
        String(it.name || '').toLowerCase().includes(qq) ||
        String(it.department || '').toLowerCase().includes(qq) ||
        String(it.location || '').toLowerCase().includes(qq)
      );
    }

    const stats = computeInspectionStats(allItems, records, year, month);
    res.json({ section, year, month, stats, items: merged });
  } catch (err) {
    console.error('Inspection items list error:', err);
    res.status(500).json({ error: 'فشل تحميل الأصناف' });
  }
});

// ── POST /api/inspections/sections/:id/items — إضافة صنف جديد لقسم
app.post('/api/inspections/sections/:id/items', authenticateToken, requireRole(...INSPECTION_ADMIN_ROLES), async (req, res) => {
  const sectionId = req.params.id;
  const { itemNumber, name, department, location } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'اسم/نوع الصنف مطلوب' });
  }
  let result;
  await enqueueWrite(async () => {
    const sections = readInspectionSections();
    const section = sections.find(s => s.id === sectionId);
    if (!section) { result = { status: 404, body: { error: 'القسم غير موجود' } }; return; }

    const items = readInspectionItems();
    const item = {
      id: 'INSITM-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
      sectionId,
      itemNumber: itemNumber != null ? String(itemNumber).trim() : '',
      name: String(name).trim(),
      department: department ? String(department).trim() : '',
      location: location ? String(location).trim() : '',
      createdAt: new Date().toISOString(),
      createdBy: req.user.username || req.user.id,
      updatedAt: null,
      updatedBy: null
    };
    const items2 = items.concat([item]);
    if (writeInspectionItems(items2)) {
      logAuditEvent({ entityType: 'inspection-item', entityId: item.id, action: 'create', actor: req.user, note: `${section.name}: ${item.name}` });
      result = { status: 201, body: { success: true, item } };
    } else {
      result = { status: 500, body: { error: 'فشل حفظ الصنف' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ── PUT /api/inspections/items/:id — تعديل بيانات صنف
app.put('/api/inspections/items/:id', authenticateToken, requireRole(...INSPECTION_ADMIN_ROLES), async (req, res) => {
  const itemId = req.params.id;
  const { itemNumber, name, department, location } = req.body || {};
  let result;
  await enqueueWrite(async () => {
    const items = readInspectionItems();
    const idx = items.findIndex(it => it.id === itemId);
    if (idx === -1) { result = { status: 404, body: { error: 'الصنف غير موجود' } }; return; }
    const it = items[idx];
    if (name != null && String(name).trim()) it.name = String(name).trim();
    if (itemNumber != null) it.itemNumber = String(itemNumber).trim();
    if (department != null) it.department = String(department).trim();
    if (location != null) it.location = String(location).trim();
    it.updatedAt = new Date().toISOString();
    it.updatedBy = req.user.username || req.user.id;
    if (writeInspectionItems(items)) {
      logAuditEvent({ entityType: 'inspection-item', entityId: itemId, action: 'update', actor: req.user, note: it.name });
      result = { status: 200, body: { success: true, item: it } };
    } else {
      result = { status: 500, body: { error: 'فشل حفظ التعديل' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ── DELETE /api/inspections/items/:id — حذف صنف وكل سجلات فحصه الشهرية
app.delete('/api/inspections/items/:id', authenticateToken, requireRole(...INSPECTION_ADMIN_ROLES), async (req, res) => {
  const itemId = req.params.id;
  let result;
  await enqueueWrite(async () => {
    const items = readInspectionItems();
    const idx = items.findIndex(it => it.id === itemId);
    if (idx === -1) { result = { status: 404, body: { error: 'الصنف غير موجود' } }; return; }
    const removed = items[idx];
    const remainingItems = items.slice(0, idx).concat(items.slice(idx + 1));

    const records = readInspectionRecords();
    let removedRecordsCount = 0;
    const remainingRecords = records.filter(r => {
      const belongs = r.itemId === itemId;
      if (belongs) removedRecordsCount++;
      return !belongs;
    });

    if (writeInspectionItems(remainingItems) && writeInspectionRecords(remainingRecords)) {
      logAuditEvent({ entityType: 'inspection-item', entityId: itemId, action: 'delete', actor: req.user, note: `${removed.name} (${removedRecordsCount} سجل فحص)` });
      result = { status: 200, body: { success: true } };
    } else {
      result = { status: 500, body: { error: 'فشل الحذف' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ── PUT /api/inspections/items/:id/records — تسجيل/تعديل نتيجة فحص صنف
// لشهر وسنة محددين (مطابق / غير مطابق). سجل واحد فقط لكل صنف×شهر×سنة —
// إعادة الإرسال لنفس الشهر تُحدِّث السجل الموجود (upsert) بدلاً من تكراره.
app.put('/api/inspections/items/:id/records', authenticateToken, requireRole(...INSPECTION_ADMIN_ROLES), async (req, res) => {
  const itemId = req.params.id;
  const { year, month, status, notes, inspectionDate, inspector } = req.body || {};
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  if (!y || !m || m < 1 || m > 12) {
    return res.status(400).json({ error: 'سنة/شهر غير صالحين' });
  }
  if (status !== 'مطابق' && status !== 'غير مطابق') {
    return res.status(400).json({ error: "نتيجة الفحص يجب أن تكون 'مطابق' أو 'غير مطابق'" });
  }
  let result;
  await enqueueWrite(async () => {
    const items = readInspectionItems();
    const item = items.find(it => it.id === itemId);
    if (!item) { result = { status: 404, body: { error: 'الصنف غير موجود' } }; return; }

    const records = readInspectionRecords();
    const existingIdx = records.findIndex(r => r.itemId === itemId && r.year === y && r.month === m);
    const now = new Date().toISOString();
    let record, previousStatus = null, isUpdate = false;

    if (existingIdx !== -1) {
      isUpdate = true;
      record = records[existingIdx];
      previousStatus = record.status;
      record.status = status;
      record.notes = notes != null ? String(notes) : '';
      record.inspectionDate = inspectionDate || record.inspectionDate || null;
      record.inspector = inspector != null ? String(inspector).trim() : (record.inspector || '');
      record.updatedAt = now;
      record.updatedBy = req.user.username || req.user.id;
    } else {
      record = {
        id: 'INSREC-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
        sectionId: item.sectionId,
        itemId,
        year: y,
        month: m,
        status,
        notes: notes != null ? String(notes) : '',
        inspectionDate: inspectionDate || null,
        inspector: inspector != null ? String(inspector).trim() : (req.user.name || ''),
        createdAt: now,
        createdBy: req.user.username || req.user.id,
        updatedAt: null,
        updatedBy: null
      };
      records.push(record);
    }

    if (writeInspectionRecords(records)) {
      logAuditEvent({
        entityType: 'inspection-record', entityId: record.id, action: isUpdate ? 'update' : 'create',
        actor: req.user, previousStatus, newStatus: status,
        note: `${item.name} — ${y}/${m}${notes ? ' — ' + notes : ''}`
      });
      result = { status: 200, body: { success: true, record } };
    } else {
      result = { status: 500, body: { error: 'فشل حفظ نتيجة الفحص' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ── DELETE /api/inspections/records/:id — حذف سجل فحص شهري واحد
app.delete('/api/inspections/records/:id', authenticateToken, requireRole(...INSPECTION_ADMIN_ROLES), async (req, res) => {
  const recordId = req.params.id;
  let result;
  await enqueueWrite(async () => {
    const records = readInspectionRecords();
    const idx = records.findIndex(r => r.id === recordId);
    if (idx === -1) { result = { status: 404, body: { error: 'السجل غير موجود' } }; return; }
    const removed = records[idx];
    const remaining = records.slice(0, idx).concat(records.slice(idx + 1));
    if (writeInspectionRecords(remaining)) {
      logAuditEvent({ entityType: 'inspection-record', entityId: recordId, action: 'delete', actor: req.user, previousStatus: removed.status, note: `${removed.year}/${removed.month}` });
      result = { status: 200, body: { success: true } };
    } else {
      result = { status: 500, body: { error: 'فشل الحذف' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ── GET /api/inspections/sections/:id/export — تصدير إكسيل (سجل أصناف عبر
// type=items أو فحص شهر محدد عبر type=monthly&year=&month=، الافتراضي
// monthly). يقبل التوكن عبر ?dt= لأنه رابط تنزيل مباشر <a href> لا يمكنه
// إرسال Authorization header (نفس نمط GET /api/drills/export/:id).
app.get('/api/inspections/sections/:id/export', authenticateTokenFlexible, requireRole(...INSPECTION_ADMIN_ROLES), async (req, res) => {
  try {
    const sectionId = req.params.id;
    const sections = readInspectionSections();
    const section = sections.find(s => s.id === sectionId);
    if (!section) return res.status(404).send('Section not found');

    const type = req.query.type === 'items' ? 'items' : 'monthly';
    const items = readInspectionItems().filter(it => it.sectionId === sectionId)
      .sort((a, b) => String(a.itemNumber || '').localeCompare(String(b.itemNumber || ''), 'ar', { numeric: true }));

    const wb = new ExcelJS.Workbook();
    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    const whiteBold = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
    const safeSlug = `${section.category}_${String(section.order || 0).padStart(2, '0')}`;

    if (type === 'items') {
      const ws = wb.addWorksheet('Items');
      const headerRow = ws.addRow(['م', 'رقم/كود الصنف', 'الاسم/النوع', 'القسم', 'المكان']);
      headerRow.font = whiteBold; headerRow.fill = headerFill;
      headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
      ws.columns = [{ width: 6 }, { width: 18 }, { width: 32 }, { width: 22 }, { width: 28 }];
      items.forEach((it, i) => {
        ws.addRow([i + 1, it.itemNumber || '', it.name || '', it.department || '', it.location || '']);
      });
      res.setHeader('Content-Disposition', `attachment; filename="inspection_${safeSlug}_items.xlsx"`);
    } else {
      const year = parseInt(req.query.year, 10) || new Date().getFullYear();
      const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);
      const records = readInspectionRecords();
      const recMap = new Map();
      records.forEach(r => { if (r.sectionId === sectionId && r.year === year && r.month === month) recMap.set(r.itemId, r); });

      const ws = wb.addWorksheet(`${month}-${year}`);
      ws.addRow([`قسم الفحص: ${section.name} (${section.category})   |   الشهر: ${month}/${year}`]);
      ws.getRow(1).getCell(1).style = { font: { bold: true, size: 13, color: { argb: 'FF1E3A5F' } }, alignment: { horizontal: 'right' } };
      ws.mergeCells('A1:I1');
      ws.addRow([]);
      const headerRow = ws.addRow(['م', 'رقم/كود الصنف', 'الاسم/النوع', 'القسم', 'المكان', 'نتيجة الفحص', 'الملاحظات', 'تاريخ الفحص', 'القائم بالفحص']);
      headerRow.font = whiteBold; headerRow.fill = headerFill;
      headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
      ws.columns = [{ width: 6 }, { width: 16 }, { width: 30 }, { width: 20 }, { width: 26 }, { width: 14 }, { width: 30 }, { width: 14 }, { width: 20 }];
      items.forEach((it, i) => {
        const r = recMap.get(it.id);
        ws.addRow([
          i + 1, it.itemNumber || '', it.name || '', it.department || '', it.location || '',
          r ? r.status : 'لم يتم الفحص', r ? (r.notes || '') : '',
          r && r.inspectionDate ? r.inspectionDate : '', r ? (r.inspector || '') : ''
        ]);
      });
      res.setHeader('Content-Disposition', `attachment; filename="inspection_${safeSlug}_${year}_${month}.xlsx"`);
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Inspection export error:', err);
    if (!res.headersSent) res.status(500).send('Error generating Excel file');
  }
});

// ============================================================
// 📥 استيراد سجلات الفحص القديمة من ملفات إكسيل تاريخية (b1/b2)
// ============================================================
// الملفات القديمة (60 ملف إكسيل، ورقة لكل شهر تقريبًا) لها نفس النمط
// تقريبًا: عمود رقم/كود الصنف، أعمدة وصفية (نوع/وزن)، القسم، المكان،
// عمودا "مطابق"/"غير مطابق" (علامة ✓ في أحدهما)، الملاحظات، تاريخ الفحص،
// القائم بالفحص. هذا المحلل يكتشف الأعمدة من نص الهيدر نفسه (لا يفترض
// ترتيبًا ثابتًا) حتى يعمل عبر أكثر من تنسيق ملف بدون كتابة parser مخصص
// لكل قسم على حدة. 11 سبتمبر 2026.
function findLegacyInspectionHeaderRow(ws) {
  for (let r = 1; r <= Math.min(6, ws.rowCount); r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= ws.columnCount; c++) {
      if (String(row.getCell(c).value || '').trim() === 'مطابق') return r;
    }
  }
  return null;
}

function parseLegacyInspectionSheet(ws) {
  const headerRowIdx = findLegacyInspectionHeaderRow(ws);
  if (!headerRowIdx) return null;
  const headerRow = ws.getRow(headerRowIdx);
  const cols = { compliantCol: null, nonCompliantCol: null, notesCol: null, dateCol: null, inspectorCol: null, deptCol: null, locationCol: null };
  let itemNumberCol = null;
  const typeCols = [];

  for (let c = 1; c <= ws.columnCount; c++) {
    const raw = String(headerRow.getCell(c).value || '').replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    if (raw === 'مطابق' && cols.compliantCol == null) cols.compliantCol = c;
    else if (raw === 'غير مطابق' && cols.nonCompliantCol == null) cols.nonCompliantCol = c;
    else if (raw.includes('الملاحظات') && !raw.includes('تعديل') && cols.notesCol == null) cols.notesCol = c;
    else if (raw.includes('تاريخ الفحص') && cols.dateCol == null) cols.dateCol = c;
    else if (raw.includes('القائم بالفحص') && cols.inspectorCol == null) cols.inspectorCol = c;
    else if (raw.includes('القسم') && cols.deptCol == null) cols.deptCol = c;
    else if ((raw.includes('المكان') || raw.includes('الموقع')) && cols.locationCol == null) cols.locationCol = c;
    else if (raw.includes('رقم') && itemNumberCol == null) itemNumberCol = c;
    else if (itemNumberCol != null && cols.compliantCol == null) typeCols.push(c);
  }
  if (itemNumberCol == null) itemNumberCol = 1;
  return { headerRowIdx, itemNumberCol, typeCols, ...cols };
}

// ── POST /api/inspections/sections/:id/import-legacy-excel — رفع سجل قديم
// (Excel) لقسم فحص محدد: ينشئ الأصناف غير الموجودة + سجلات الفحص الشهرية
// من كل الأوراق (شهور) الموجودة في الملف دفعة واحدة.
app.post('/api/inspections/sections/:id/import-legacy-excel', authenticateToken, requireRole(...INSPECTION_ADMIN_ROLES), async (req, res) => {
  const sectionId = req.params.id;
  const { base64Data } = req.body || {};
  if (!base64Data) return res.status(400).json({ error: 'لا يوجد ملف' });

  let result;
  await enqueueWrite(async () => {
    const sections = readInspectionSections();
    const section = sections.find(s => s.id === sectionId);
    if (!section) { result = { status: 404, body: { error: 'القسم غير موجود' } }; return; }

    let wb;
    try {
      const buffer = Buffer.from(base64Data, 'base64');
      wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer);
    } catch (err) {
      result = { status: 400, body: { error: 'تعذّر قراءة ملف الإكسيل — تأكد إنه بصيغة xlsx صحيحة' } };
      return;
    }

    const allItems = readInspectionItems();
    const allRecords = readInspectionRecords();
    const itemByKey = new Map();
    allItems.filter(it => it.sectionId === sectionId).forEach(it => {
      itemByKey.set(`${it.itemNumber}|${it.department}|${it.location}`, it);
    });
    const recordByKey = new Map();
    allRecords.forEach(r => recordByKey.set(`${r.itemId}|${r.year}|${r.month}`, r));

    const now = new Date().toISOString();
    const newItems = [];
    const newRecords = [];
    let itemsCreated = 0, recordsCreated = 0, recordsUpdated = 0, rowsSkippedNoDate = 0, sheetsParsed = 0, sheetsSkipped = 0;

    wb.eachSheet(ws => {
      const parsed = parseLegacyInspectionSheet(ws);
      if (!parsed) { sheetsSkipped++; return; }
      sheetsParsed++;

      for (let r = parsed.headerRowIdx + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const itemNumberRaw = row.getCell(parsed.itemNumberCol).value;
        if (itemNumberRaw === null || itemNumberRaw === undefined || String(itemNumberRaw).trim() === '') continue;
        const itemNumber = String(itemNumberRaw).trim();
        const department = parsed.deptCol ? String(row.getCell(parsed.deptCol).value || '').trim() : '';
        const location = parsed.locationCol ? String(row.getCell(parsed.locationCol).value || '').trim() : '';
        const typeParts = parsed.typeCols.map(c => String(row.getCell(c).value || '').trim()).filter(Boolean);
        const key = `${itemNumber}|${department}|${location}`;

        let item = itemByKey.get(key);
        if (!item) {
          item = {
            id: 'INSITM-' + Date.now() + '-' + newItems.length + '-' + crypto.randomBytes(3).toString('hex'),
            sectionId,
            itemNumber,
            name: typeParts.length ? typeParts.join(' - ') : `${section.name} #${itemNumber}`,
            department, location,
            createdAt: now, createdBy: `legacy-import:${req.user.username || req.user.id}`,
            updatedAt: null, updatedBy: null
          };
          itemByKey.set(key, item);
          newItems.push(item);
          itemsCreated++;
        }

        const compliantVal = parsed.compliantCol ? row.getCell(parsed.compliantCol).value : null;
        const nonCompliantVal = parsed.nonCompliantCol ? row.getCell(parsed.nonCompliantCol).value : null;
        let status = null;
        if (compliantVal !== null && compliantVal !== undefined && String(compliantVal).trim() !== '') status = 'مطابق';
        else if (nonCompliantVal !== null && nonCompliantVal !== undefined && String(nonCompliantVal).trim() !== '') status = 'غير مطابق';
        if (!status) continue; // صف لم يُفحص بعد في هذه الورقة — تجاهله

        const dateVal = parsed.dateCol ? row.getCell(parsed.dateCol).value : null;
        let dateObj = null;
        if (dateVal instanceof Date) dateObj = dateVal;
        else if (dateVal) { const d = new Date(dateVal); if (!isNaN(d)) dateObj = d; }
        if (!dateObj) { rowsSkippedNoDate++; continue; } // بدون تاريخ لا يمكن تحديد الشهر/السنة بثقة

        const y = dateObj.getFullYear(), m = dateObj.getMonth() + 1;
        const notes = parsed.notesCol ? String(row.getCell(parsed.notesCol).value || '').trim() : '';
        const inspector = parsed.inspectorCol ? String(row.getCell(parsed.inspectorCol).value || '').trim() : '';
        const recKey = `${item.id}|${y}|${m}`;
        const existingRec = recordByKey.get(recKey);

        if (existingRec) {
          existingRec.status = status;
          if (notes) existingRec.notes = notes;
          existingRec.inspectionDate = dateObj.toISOString().slice(0, 10);
          if (inspector) existingRec.inspector = inspector;
          recordsUpdated++;
        } else {
          const rec = {
            id: 'INSREC-' + Date.now() + '-' + newRecords.length + '-' + crypto.randomBytes(3).toString('hex'),
            sectionId, itemId: item.id, year: y, month: m, status, notes,
            inspectionDate: dateObj.toISOString().slice(0, 10), inspector,
            createdAt: now, createdBy: `legacy-import:${req.user.username || req.user.id}`,
            updatedAt: null, updatedBy: null
          };
          recordByKey.set(recKey, rec);
          newRecords.push(rec);
          recordsCreated++;
        }
      }
    });

    if (sheetsParsed === 0) {
      result = { status: 400, body: { error: 'لم يتم التعرف على تنسيق الملف — يجب أن يحتوي عمود "مطابق" في أول 6 صفوف من كل ورقة' } };
      return;
    }

    const okItems = writeInspectionItems(allItems.concat(newItems));
    const okRecords = writeInspectionRecords(allRecords.concat(newRecords));
    if (okItems && okRecords) {
      logAuditEvent({
        entityType: 'inspection-section', entityId: sectionId, action: 'import-legacy-excel', actor: req.user,
        note: `${section.name}: ${itemsCreated} صنف جديد، ${recordsCreated} سجل جديد، ${recordsUpdated} سجل مُحدَّث (من ${sheetsParsed} ورقة)`
      });
      result = {
        status: 200,
        body: {
          success: true,
          itemsCreated, recordsCreated, recordsUpdated,
          sheetsParsed, sheetsSkipped, rowsSkippedNoDate
        }
      };
    } else {
      result = { status: 500, body: { error: 'فشل حفظ البيانات المستوردة' } };
    }
  });
  res.status(result ? result.status : 500).json(result ? result.body : { error: 'حدث خطأ غير متوقع أثناء المعالجة، حاول مرة أخرى' });
});

// ============================================================
// 📄 PDF EXPORT — تصدير PDF احترافي لتصريح العمل / بلاغ الخطورة
// ============================================================
// مستند رسمي بشعار الشركة، جاهز للطباعة، مع QR Code يفتح صفحة تحقق
// عامة (بدون تسجيل دخول) تُظهر حالة التصريح/البلاغ لحظيًا — أي حد يمسح
// الكود بموبايله يتأكد إن المستند شرعي ومطابق للنظام الفعلي، لا نسخة
// معدَّلة أو منتهية الصلاحية. النصوص العربية تُجهَّز عبر lib/pdf-arabic.js
// (PDFKit وحده لا يشكّل الحروف العربية ولا يرتبها bidi تلقائيًا) بخط
// Amiri (assets/fonts/) — خط Cairo المستخدم في الواجهة لا يعمل بشكل
// صحيح مع PDFKit (اختُبر). 11 سبتمبر 2026.
const PDF_FONT_REGULAR = path.join(__dirname, 'assets', 'fonts', 'Amiri-Regular.ttf');
const PDF_FONT_BOLD = path.join(__dirname, 'assets', 'fonts', 'Amiri-Bold.ttf');
const PDF_LOGO_PATH = path.join(__dirname, 'public', 'icons', 'icon-512.png');
const PDF_PAGE_MARGIN = 46;

function pdfBaseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

/** يرسم رأس المستند: الشعار + اسم المنصة + عنوان المستند */
function drawPdfHeader(doc, titleAr, titleEn) {
  const pageW = doc.page.width;
  try { doc.image(PDF_LOGO_PATH, PDF_PAGE_MARGIN, PDF_PAGE_MARGIN, { width: 44 }); } catch (e) { /* logo optional */ }
  doc.font(PDF_FONT_BOLD).fontSize(11).fillColor('#0F172A')
    .text(prepareBidiText('Elsewedy Polymers — HSE Platform'), 0, PDF_PAGE_MARGIN + 2, { width: pageW - PDF_PAGE_MARGIN, align: 'right' });
  doc.font(PDF_FONT_REGULAR).fontSize(9).fillColor('#64748B')
    .text(prepareBidiText('السويدي للبوليمرات — منصة السلامة والصحة المهنية'), 0, PDF_PAGE_MARGIN + 18, { width: pageW - PDF_PAGE_MARGIN, align: 'right' });
  doc.moveTo(PDF_PAGE_MARGIN, PDF_PAGE_MARGIN + 46).lineTo(pageW - PDF_PAGE_MARGIN, PDF_PAGE_MARGIN + 46)
    .strokeColor('#E2E8F0').lineWidth(1).stroke();
  doc.y = PDF_PAGE_MARGIN + 62;
  doc.font(PDF_FONT_BOLD).fontSize(18).fillColor('#7C1D1D')
    .text(prepareBidiText(titleAr), { align: 'right' });
  if (titleEn) {
    doc.font(PDF_FONT_REGULAR).fontSize(10).fillColor('#64748B')
      .text(titleEn, { align: 'right' });
  }
  doc.moveDown(0.6);
}

/** شارة الحالة الملوّنة (معتمد / مرفوض / قيد المراجعة) */
function drawPdfStatusStamp(doc, status) {
  const map = {
    approved: { label: 'معتمد — APPROVED', color: '#16A34A' },
    rejected: { label: 'مرفوض — REJECTED', color: '#DC2626' },
    closed:   { label: 'مغلق — CLOSED', color: '#334155' },
    open:     { label: 'مفتوح — OPEN', color: '#D97706' },
  };
  const s = map[status] || { label: 'قيد المراجعة — PENDING', color: '#D97706' };
  const boxW = 180, boxH = 26;
  const x = doc.page.width - PDF_PAGE_MARGIN - boxW;
  const y = doc.y;
  doc.roundedRect(x, y, boxW, boxH, 6).lineWidth(1.4).strokeColor(s.color).stroke();
  doc.font(PDF_FONT_BOLD).fontSize(11).fillColor(s.color)
    .text(prepareBidiText(s.label), x, y + 7, { width: boxW, align: 'center' });
  doc.y = y + boxH + 14;
}

/** صف "تسمية: قيمة" — يدعم عرض عدة أعمدة في نفس السطر */
function drawPdfLabelValue(doc, label, value) {
  const pageW = doc.page.width;
  const usableW = pageW - PDF_PAGE_MARGIN * 2;
  const y = doc.y;
  doc.font(PDF_FONT_BOLD).fontSize(9.5).fillColor('#64748B')
    .text(prepareBidiText(label), PDF_PAGE_MARGIN, y, { width: usableW, align: 'right' });
  doc.font(PDF_FONT_REGULAR).fontSize(12).fillColor('#0F172A')
    .text(prepareBidiText(value === 0 ? '0' : (value || '—')), PDF_PAGE_MARGIN, doc.y + 1, { width: usableW, align: 'right' });
  doc.moveDown(0.55);
}

function drawPdfSectionTitle(doc, text) {
  doc.moveDown(0.3);
  doc.font(PDF_FONT_BOLD).fontSize(12).fillColor('#7C1D1D')
    .text(prepareBidiText(text), PDF_PAGE_MARGIN, doc.y, { width: doc.page.width - PDF_PAGE_MARGIN * 2, align: 'right' });
  doc.moveTo(PDF_PAGE_MARGIN, doc.y + 2).lineTo(doc.page.width - PDF_PAGE_MARGIN, doc.y + 2)
    .strokeColor('#E2E8F0').lineWidth(0.7).dash(2, { space: 2 }).stroke();
  doc.undash();
  doc.moveDown(0.5);
}

/** يرسم QR Code التحقق + التذييل في أسفل آخر صفحة */
async function drawPdfFooterWithQr(doc, verifyUrl, docId) {
  try {
    const qrBuffer = await QRCode.toBuffer(verifyUrl, { margin: 1, width: 200 });
    const qrSize = 78;
    const x = doc.page.width - PDF_PAGE_MARGIN - qrSize;
    const y = doc.page.height - PDF_PAGE_MARGIN - qrSize - 26;
    doc.image(qrBuffer, x, y, { width: qrSize, height: qrSize });
    doc.font(PDF_FONT_REGULAR).fontSize(7.5).fillColor('#64748B')
      .text(prepareBidiText('امسح للتحقق من صلاحية المستند وحالته لحظيًا'), x - 140, y + qrSize + 4, { width: qrSize + 140, align: 'center' });
  } catch (e) {
    console.error('[PDF] QR generation failed:', e);
  }
  doc.font(PDF_FONT_REGULAR).fontSize(7.5).fillColor('#94A3B8')
    .text(
      prepareBidiText(`تم إنشاء هذا المستند آليًا بواسطة HSE Platform — ${new Date().toLocaleString('ar-EG')} — ${docId}`),
      PDF_PAGE_MARGIN, doc.page.height - PDF_PAGE_MARGIN - 14, { width: doc.page.width - PDF_PAGE_MARGIN * 2 - 140, align: 'right' }
    );
}

function findPermitById(permitId) {
  const storage = readStorage();
  let permits = storage['work-permits'];
  permits = typeof permits === 'string' ? JSON.parse(permits || '[]') : (Array.isArray(permits) ? permits : []);
  return permits.find(p => p.id === permitId);
}

const PDF_EXPORT_ROLES = ['super_admin', 'hse_admin', 'dept_admin', 'maint_admin'];

// ── GET /api/permits/:id/pdf — تصدير تصريح عمل كـ PDF رسمي ──────
app.get('/api/permits/:id/pdf', authenticateTokenFlexible, requireRole(...PDF_EXPORT_ROLES), async (req, res) => {
  try {
    const permit = findPermitById(req.params.id);
    if (!permit) return res.status(404).json({ error: 'التصريح غير موجود' });

    const doc = new PDFDocument({ size: 'A4', margin: PDF_PAGE_MARGIN, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Permit_${permit.id}.pdf"`);
    doc.pipe(res);

    drawPdfHeader(doc, 'تصريح عمل', `Work Permit — ${permit.id}`);
    drawPdfStatusStamp(doc, permit.status);

    drawPdfSectionTitle(doc, 'بيانات التصريح');
    drawPdfLabelValue(doc, 'رقم التصريح', permit.id);
    drawPdfLabelValue(doc, 'نوع التصريح', permit.typeFullLabel || permit.typeLabel);
    drawPdfLabelValue(doc, 'القسم', permit.department);
    drawPdfLabelValue(doc, 'التاريخ', permit.date);
    drawPdfLabelValue(doc, 'الوردية', permit.shift);
    if (permit.timeFrom || permit.timeTo) drawPdfLabelValue(doc, 'من — إلى', `${permit.timeFrom || '—'} — ${permit.timeTo || '—'}`);
    drawPdfLabelValue(doc, 'الموقع', permit.location);
    drawPdfLabelValue(doc, 'المعدة/الآلة', permit.equipment);

    drawPdfSectionTitle(doc, 'بيانات العامل');
    drawPdfLabelValue(doc, 'اسم العامل', permit.workerName);
    drawPdfLabelValue(doc, 'وصف العمل', permit.description);

    if (Array.isArray(permit.checklist) && permit.checklist.length) {
      drawPdfSectionTitle(doc, 'قائمة الفحص الأمنية');
      permit.checklist.forEach(c => drawPdfLabelValue(doc, c.question, c.answer));
    }

    if (Array.isArray(permit.risks) && permit.risks.length) {
      drawPdfSectionTitle(doc, 'تقييم المخاطر');
      permit.risks.forEach((r, i) => drawPdfLabelValue(doc, `مصدر الخطر ${i + 1}`, `${r.source} — احتمالية×شدة=${r.score} — الإجراء: ${r.control || '—'}`));
    }

    drawPdfSectionTitle(doc, 'الاعتمادات');
    drawPdfLabelValue(doc, 'مراجعة رئيس المنطقة', permit.areaHeadReviewedBy ? `${permit.areaHeadReviewedBy} — ${permit.areaHeadReviewedAt || ''}` : null);
    drawPdfLabelValue(doc, 'مراجعة مسؤول السلامة', permit.safetyOfficerName ? `${permit.safetyOfficerName} — ${permit.reviewedAt || ''}` : (permit.reviewedBy ? `${permit.reviewedBy} — ${permit.reviewedAt || ''}` : null));
    if (permit.reviewNote) drawPdfLabelValue(doc, 'ملاحظات المراجعة', permit.reviewNote);

    const verifyUrl = `${pdfBaseUrl(req)}/verify/permit/${encodeURIComponent(permit.id)}`;
    await drawPdfFooterWithQr(doc, verifyUrl, permit.id);
    doc.end();
  } catch (err) {
    console.error('[PDF] Permit export failed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'فشل إنشاء ملف PDF' });
  }
});

// ── GET /api/hazards/:id/pdf — تصدير بلاغ خطورة كـ PDF رسمي ──────
app.get('/api/hazards/:id/pdf', authenticateTokenFlexible, requireRole(...PDF_EXPORT_ROLES), async (req, res) => {
  try {
    const hazard = readHazards().find(h => h.id === req.params.id);
    if (!hazard) return res.status(404).json({ error: 'البلاغ غير موجود' });

    const doc = new PDFDocument({ size: 'A4', margin: PDF_PAGE_MARGIN, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Hazard_${hazard.id}.pdf"`);
    doc.pipe(res);

    drawPdfHeader(doc, 'بلاغ خطورة', `Hazard Report — ${hazard.id}`);
    drawPdfStatusStamp(doc, hazard.status);

    drawPdfSectionTitle(doc, 'بيانات البلاغ');
    drawPdfLabelValue(doc, 'رقم البلاغ', hazard.id);
    drawPdfLabelValue(doc, 'اسم المُبلِّغ', hazard.reporterName);
    drawPdfLabelValue(doc, 'القسم', hazard.department);
    drawPdfLabelValue(doc, 'المنطقة', hazard.area);
    drawPdfLabelValue(doc, 'التاريخ', hazard.date);
    drawPdfLabelValue(doc, 'مستوى الخطورة', hazard.riskLevel === 'H' ? 'مرتفع (H)' : hazard.riskLevel === 'M' ? 'متوسط (M)' : hazard.riskLevel === 'L' ? 'منخفض (L)' : hazard.riskLevel);

    drawPdfSectionTitle(doc, 'الوصف والمعالجة');
    drawPdfLabelValue(doc, 'وصف الخطورة', hazard.description);
    drawPdfLabelValue(doc, 'الإصابة المحتملة', hazard.potentialInjury);
    drawPdfLabelValue(doc, 'الحل المقترح', hazard.proposedSolution);
    drawPdfLabelValue(doc, 'الإجراء المتخذ', hazard.actionTaken);

    drawPdfSectionTitle(doc, 'المتابعة');
    drawPdfLabelValue(doc, 'مسؤول السلامة', hazard.hseName);
    drawPdfLabelValue(doc, 'أُسندت للصيانة', hazard.assignedToMaintenance);
    if (hazard.resolvedAt) drawPdfLabelValue(doc, 'تاريخ الإغلاق', new Date(hazard.resolvedAt).toLocaleDateString('ar-EG'));

    const verifyUrl = `${pdfBaseUrl(req)}/verify/hazard/${encodeURIComponent(hazard.id)}`;
    await drawPdfFooterWithQr(doc, verifyUrl, hazard.id);
    doc.end();
  } catch (err) {
    console.error('[PDF] Hazard export failed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'فشل إنشاء ملف PDF' });
  }
});

// ============================================================
// ✅ صفحات التحقق العامة (QR Code) — بدون تسجيل دخول
// ============================================================
// تُظهر فقط الحد الأدنى من المعلومات (لا أرقام هواتف، لا تفاصيل حساسة)
// حتى لو صُوِّرت الصفحة الورقية ومُسِح الكود من أي شخص — تمامًا مثل
// التحقق من تذكرة أو شهادة، هذا هو الغرض المقصود من QR Code أصلاً.
function verifyPageHtml({ title, rows, statusLabel, statusColor }) {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — HSE Platform</title>
<style>
  body{font-family:'Cairo',Tahoma,sans-serif;background:#0F172A;color:#fff;margin:0;padding:24px;min-height:100vh;box-sizing:border-box;display:flex;align-items:center;justify-content:center;}
  .card{background:#fff;color:#0F172A;border-radius:16px;padding:28px 24px;max-width:420px;width:100%;box-shadow:0 20px 60px -10px rgba(0,0,0,.5);}
  .brand{font-size:12px;color:#64748B;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;}
  h1{font-size:19px;margin:0 0 16px;}
  .status{display:inline-block;padding:8px 18px;border-radius:8px;font-weight:800;font-size:14px;border:2px solid ${statusColor};color:${statusColor};margin-bottom:18px;}
  .row{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid #E2E8F0;font-size:13.5px;}
  .row span:first-child{color:#64748B;font-weight:700;}
  .row span:last-child{font-weight:700;text-align:left;}
  .foot{margin-top:16px;font-size:11px;color:#94A3B8;text-align:center;}
</style></head>
<body>
  <div class="card">
    <div class="brand">Elsewedy Polymers — HSE Platform</div>
    <h1>${title}</h1>
    <div class="status">${statusLabel}</div>
    ${rows.map(r => `<div class="row"><span>${r[0]}</span><span>${r[1] || '—'}</span></div>`).join('')}
    <div class="foot">تحقق آلي لحظي من النظام الرسمي — ${new Date().toLocaleString('ar-EG')}</div>
  </div>
</body></html>`;
}

app.get('/verify/permit/:id', (req, res) => {
  const permit = findPermitById(req.params.id);
  if (!permit) return res.status(404).send(verifyPageHtml({ title: 'تصريح غير موجود', rows: [], statusLabel: 'غير صالح', statusColor: '#DC2626' }));
  const statusMap = { approved: ['معتمد', '#16A34A'], rejected: ['مرفوض', '#DC2626'], closed: ['مغلق', '#334155'] };
  const [label, color] = statusMap[permit.status] || ['قيد المراجعة', '#D97706'];
  res.send(verifyPageHtml({
    title: `تصريح عمل ${permit.id}`,
    statusLabel: label, statusColor: color,
    rows: [
      ['النوع', permit.typeFullLabel || permit.typeLabel],
      ['القسم', permit.department],
      ['التاريخ', permit.date],
      ['العامل', permit.workerName],
    ]
  }));
});

app.get('/verify/hazard/:id', (req, res) => {
  const hazard = readHazards().find(h => h.id === req.params.id);
  if (!hazard) return res.status(404).send(verifyPageHtml({ title: 'بلاغ غير موجود', rows: [], statusLabel: 'غير صالح', statusColor: '#DC2626' }));
  const statusMap = { open: ['مفتوح', '#D97706'], closed: ['مغلق', '#16A34A'] };
  const [label, color] = statusMap[hazard.status] || ['—', '#64748B'];
  res.send(verifyPageHtml({
    title: `بلاغ خطورة ${hazard.id}`,
    statusLabel: label, statusColor: color,
    rows: [
      ['القسم', hazard.department],
      ['المنطقة', hazard.area],
      ['التاريخ', hazard.date],
      ['مستوى الخطورة', hazard.riskLevel],
    ]
  }));
});

// ── 404 fallback ──────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start Server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Work Permits Server running on http://localhost:${PORT}`);
  console.log(`🔒 JWT auth: ENABLED | bcrypt rounds: ${BCRYPT_ROUNDS}`);
});

module.exports = app;