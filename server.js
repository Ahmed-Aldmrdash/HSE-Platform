// ============================================================
// Work Permits App — Production-Ready Server
// OWASP-Compliant Security: bcrypt + JWT + RBAC + Write Queue
// ============================================================
'use strict';

require('dotenv').config();

const express    = require('express');
const fs         = require('fs');
const path       = require('path');
const ExcelJS    = require('exceljs');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const webpush    = require('web-push');
const compression = require('compression');

const app  = express();
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

const TRAINING_TOPICS_FILE = path.join(DATA_DIR, 'training-topics.json');
const TRAININGS_FILE = path.join(DATA_DIR, 'trainings.json');
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
const VAPID_KEYS_FILE = path.join(DATA_DIR, 'vapid.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ── Initialize Training Topics ───────────────────────────────
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
if (!fs.existsSync(TRAINING_TOPICS_FILE)) {
  fs.writeFileSync(TRAINING_TOPICS_FILE, JSON.stringify(INITIAL_TOPICS, null, 2), 'utf8');
}
if (!fs.existsSync(TRAININGS_FILE)) {
  fs.writeFileSync(TRAININGS_FILE, JSON.stringify([], null, 2), 'utf8');
}
if (!fs.existsSync(SUBSCRIPTIONS_FILE)) {
  fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify([], null, 2), 'utf8');
}

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
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self';"
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

// Fallback routes for work-permits to prevent 404
app.get('/work-permits', (req, res) => {
  res.redirect('/api/storage/work-permits');
});
app.get('/api/work-permits', (req, res) => {
  res.redirect('/api/storage/work-permits');
});

// Serve frontend static files with long Max-Age for images/JS/CSS (HTML is bypassed above)
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '31536000' }));


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

// ── Storage Helpers ───────────────────────────────────────────
function readStorage() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = safeJsonParse(raw, {});
    if (data['work-permits'] && typeof data['work-permits'] === 'string') {
      try {
        let permits = JSON.parse(data['work-permits']);
        if (Array.isArray(permits)) {
          let modified = false;
          permits.forEach(p => {
             // Always normalize
             normalizePermitDeletedBy(p);
          });
          data['work-permits'] = JSON.stringify(permits);
        }
      } catch (e) {
        console.error('Error migrating permits on load', e);
      }
    }
    return data;
  } catch (err) {
    console.error('Error reading storage.json:', err);
    return {};
  }
}

function getRoleKey(role) {
  if (role === 'dept_admin' || role === 'area_admin') return 'areaAdmin';
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
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing storage.json:', err);
    return false;
  }
}

function readHazards() {
  if (!fs.existsSync(HAZARDS_FILE)) return [];
  try {
    const raw = fs.readFileSync(HAZARDS_FILE, 'utf8');
    return safeJsonParse(raw, []);
  } catch (err) {
    console.error('Error reading hazard-reports.json:', err);
    return [];
  }
}

function writeHazards(data) {
  try {
    fs.writeFileSync(HAZARDS_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing hazard-reports.json:', err);
    return false;
  }
}

// ── Employee Storage Helpers ──────────────────────────────

function normalizeEmpCode(code) {
  if (!code && code !== 0) return '';
  const str = String(code).trim();
  const stripped = str.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

function readEmployees() {
  if (!fs.existsSync(EMPLOYEES_FILE)) return [];
  try {
    const raw = fs.readFileSync(EMPLOYEES_FILE, 'utf8');
    return safeJsonParse(raw, []);
  } catch (err) {
    console.error('Error reading employees.json:', err);
    return [];
  }
}

function writeEmployees(data) {
  try {
    fs.writeFileSync(EMPLOYEES_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing employees.json:', err);
    return false;
  }
}

// ── Training Storage Helpers ──────────────────────────────

function readTrainingTopics() {
  if (!fs.existsSync(TRAINING_TOPICS_FILE)) return [];
  try {
    const raw = fs.readFileSync(TRAINING_TOPICS_FILE, 'utf8');
    return safeJsonParse(raw, []);
  } catch (err) {
    console.error('Error reading training-topics.json:', err);
    return [];
  }
}

function readTrainings() {
  if (!fs.existsSync(TRAININGS_FILE)) return [];
  try {
    const raw = fs.readFileSync(TRAININGS_FILE, 'utf8');
    return safeJsonParse(raw, []);
  } catch (err) {
    console.error('Error reading trainings.json:', err);
    return [];
  }
}

function writeTrainings(data) {
  try {
    fs.writeFileSync(TRAININGS_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing trainings.json:', err);
    return false;
  }
}

// ── Notifications Storage Helpers ─────────────────────────────

function readNotifications() {
  if (!fs.existsSync(NOTIFICATIONS_FILE)) return [];
  try {
    const raw = fs.readFileSync(NOTIFICATIONS_FILE, 'utf8');
    return safeJsonParse(raw, []);
  } catch (err) {
    console.error('Error reading notifications.json:', err);
    return [];
  }
}

function writeNotifications(data) {
  try {
    fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing notifications.json:', err);
    return false;
  }
}

function readSubscriptions() {
  try { 
    const raw = fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8');
    return safeJsonParse(raw, []); 
  } catch { return []; }
}

function writeSubscriptions(data) {
  try {
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing subscriptions:', err);
    return false;
  }
}

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
  // Check if employees.json exists AND has at least one record
  const jsonExists   = fs.existsSync(EMPLOYEES_FILE);
  const currentData  = jsonExists ? readEmployees() : [];
  const jsonHasData  = currentData.length > 0;

  if (jsonExists && jsonHasData) {
    console.log(`✅ employees.json found (${currentData.length} records) — skipping xlsx import.`);
    return;
  }

  if (!fs.existsSync(EMPLOYEES_XLSX_INPUT)) {
    if (!jsonExists) console.log('ℹ️  No employees.xlsx found — employee directory starts empty.');
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
      createdAt: new Date().toISOString()
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
          createdAt: new Date().toISOString()
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
          createdAt: new Date().toISOString()
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
 * الاستخدام: requireRole('superadmin') أو requireRole('admin', 'supervisor')
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



// ── GET /api/storage/:key — جلب قيمة (مفتوح للجميع)
app.get('/api/storage/:key', (req, res) => {
  const data = readStorage();
  const key = req.params.key;
  res.json({ key, value: data[key] || '[]' });
});

// ── POST /api/storage/:key — حفظ قيمة (rate-limited on work-permits key)
// Storage key security:
//   • Only the 'work-permits' key is writable without authentication.
//   • All other keys require superadmin JWT.
//   • Key must consist of safe characters only (no path traversal).
const WRITABLE_KEYS_UNAUTH = ['work-permits'];
const KEY_PATTERN = /^[a-zA-Z0-9_\-]+$/;

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
  const PROTECTED_KEYS = ['app-users', 'users'];

  if (PROTECTED_KEYS.includes(key)) {
    return authenticateToken(req, res, () => {
      requireRole('superadmin')(req, res, next);
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
        await syncExcelFromPermits(value);
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
  requireRole('super_admin', 'hse_admin', 'dept_admin'),
  (req, res) => {
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
  requireRole('super_admin', 'hse_admin', 'dept_admin'),
  async (req, res) => {
    const permitId = req.params.id;
    const { action, reviewNote, closureType, closureReason } = req.body;

    const VALID_ACTIONS = ['dept_approve', 'hse_approve', 'reject', 'close'];
    if (!action || !VALID_ACTIONS.includes(action)) {
      return res.status(400).json({ error: `الإجراء غير صالح. المتاح: ${VALID_ACTIONS.join(' | ')}` });
    }
    if (action === 'dept_approve' && req.user.role !== 'dept_admin' && req.user.role !== 'super_admin') {
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

      if (action === 'dept_approve') {
        if (permits[idx].status !== 'pending_dept' && permits[idx].status !== 'pending_area_head' && permits[idx].status !== 'pending') {
          result = { status: 409, body: { error: 'لا يمكن موافقة رئيس القسم إلا على طلبات قيد انتظار القسم' } };
          return;
        }
        if (req.user.role === 'dept_admin' && req.user.department &&
            permits[idx].department && req.user.department !== permits[idx].department) {
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

      const newValue = JSON.stringify(permits);
      storage['work-permits'] = newValue;
      if (writeStorage(storage)) {
        await syncExcelFromPermits(newValue);
        
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

    res.status(result.status).json(result.body);
  }
);

// ============================================================
// ⚠️ API ROUTES — HAZARD REPORTS
// ============================================================

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
      await syncHazardsExcelFromData(hazards);
      
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
  res.status(result.status).json(result.body);
});

app.get('/api/hazards/employee-stats', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin'), async (req, res) => {
  let hazards = readHazards();
  
  const fs = require('fs');
  const path = require('path');
  let employees = [];
  try {
    const empData = fs.readFileSync(path.join(__dirname, 'data', 'employees.json'), 'utf8');
    employees = JSON.parse(empData);
  } catch(e) {}

  if (req.user.role === 'dept_admin' && req.user.department) {
    employees = employees.filter(e => e.department === req.user.department);
  }
  
  const stats = employees.map(emp => {
    // Only count non-deleted hazards
    const empHazards = hazards.filter(h => h.reporterId === emp.code && h.deleted !== true);
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
    hazards = hazards.filter(h => h.department === req.user.department);
  } else if (req.user.role === 'maint_admin' && req.user.department) {
    hazards = hazards.filter(h => h.assignedToMaintenance === req.user.department);
  }

  res.json({ hazards });
});

app.get('/api/my-hazards/:name', (req, res) => {
  const reporterName = req.params.name;
  if (!reporterName) {
    return res.status(400).json({ error: 'الاسم مطلوب' });
  }
  let hazards = readHazards();
  const myHazards = hazards.filter(h => h.reporterName === reporterName);
  res.json({ hazards: myHazards });
});

app.patch('/api/hazards/:id', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin', 'maint_admin'), async (req, res) => {
  const hazardId = req.params.id;
  const { action, targetMaintenance, maintenanceAction, maintenanceTeamNames, status, actionTaken } = req.body;

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

    if (action === 'assign_maintenance') {
      if (req.user.role !== 'hse_admin' && req.user.role !== 'super_admin') {
        result = { status: 403, body: { error: 'فقط مشرف السلامة يمكنه التوجيه للصيانة' } };
        return;
      }
      if (!targetMaintenance) {
        result = { status: 400, body: { error: 'قسم الصيانة المستهدف مطلوب' } };
        return;
      }
      h.assignedToMaintenance = sanitizeStr(targetMaintenance, 100);
      h.forwardedByHseName = updater;
      h.forwardedByHseAt = now;
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
      if (req.user.role !== 'maint_admin') {
        result = { status: 403, body: { error: 'فقط فريق الصيانة يمكنه بدء الإصلاح' } };
        return;
      }
      if (req.user.role === 'maint_admin' && h.assignedToMaintenance !== req.user.department) {
        result = { status: 403, body: { error: 'هذا البلاغ غير موجه لقسمكم' } };
        return;
      }
      h.status = 'in_progress';
      h.startedAt = now;
      h.startedByName = updater;
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
      if (req.user.role !== 'maint_admin') {
        result = { status: 403, body: { error: 'فقط فريق الصيانة يمكنه إغلاق البلاغ' } };
        return;
      }
      if (req.user.role === 'maint_admin' && h.assignedToMaintenance !== req.user.department) {
        result = { status: 403, body: { error: 'هذا البلاغ غير موجه لقسمكم' } };
        return;
      }
      if (!h.startedAt) {
        h.startedAt = now;
        h.startedByName = updater;
      }
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

    if (writeHazards(hazards)) {
      await syncHazardsExcelFromData(hazards);
      result = { status: 200, body: { success: true, hazard: h } };
    } else {
      result = { status: 500, body: { error: 'فشل التحديث' } };
    }
  });

  res.status(result.status).json(result.body);
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
       const assignedDept = String(h.assignedToMaintenance || '').trim().toLowerCase();
       
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
  res.status(result.status).json(result.body);
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
       const assignedDept = String(h.assignedToMaintenance || '').trim().toLowerCase();
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
  res.status(result.status).json(result.body);
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
  res.status(result.status).json(result.body);
});

app.get('/api/export-hazards', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin'), async (req, res) => {
  try {
    let hazards = readHazards();
    
    if (req.user && req.user.role === 'dept_admin' && req.user.department) {
      hazards = hazards.filter(h => h.department === req.user.department);
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
app.delete('/api/permits/:id', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin'), async (req, res) => {
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

  res.status(result.status).json(result.body);
});

// ── POST /api/permits/:id/restore — استعادة الطلب المحذوف
app.post('/api/permits/:id/restore', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin'), async (req, res) => {
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

  res.status(result.status).json(result.body);
});

// ── DELETE /api/permits/:id/permanent — الحذف النهائي للطلب
app.delete('/api/permits/:id/permanent', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin'), async (req, res) => {
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

  res.status(result.status).json(result.body);
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
      await syncExcelFromPermits(newValue);
      
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

  res.status(result.status).json(result.body);
});

// ============================================================

// ── POST /api/auth/login — تسجيل الدخول (rate-limited)
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password, empCode } = req.body;

  if (!username || !password || !empCode) {
    return res.status(400).json({ error: 'يجب إدخال اسم المستخدم وكلمة المرور والكود الوظيفي' });
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

  // Check empCode in employees sheet
  const employees = readEmployees();
  const searchCode = normalizeEmpCode(empCodeStr);
  let employee = employees.find(e => {
    const code = normalizeEmpCode(String(e.empCode || e.code || e.id || '').trim());
    return code === searchCode;
  });

  if (!employee) {
    if (['super_admin', 'superadmin', 'hse_admin', 'dept_admin', 'maint_admin'].includes(user.role)) {
      console.log(`[LOGIN] Bypassed employee lookup for admin: ${usernameStr}`);
      employee = { name: user.name || 'Admin', department: user.department || '' };
    } else {
      console.log(`[LOGIN ERROR] EmpCode not found in employees DB: ${empCodeStr}`);
      return res.status(401).json({ error: `الكود الوظيفي (${empCodeStr}) غير مسجل في قاعدة بيانات الموظفين` });
    }
  }

  // Check department authorization for dept_admin
  if (user.role === 'dept_admin') {
    const empDept = String(employee.department || '').trim().toLowerCase();
    const adminDept = String(user.department || '').trim().toLowerCase();
    if (empDept !== adminDept) {
      console.log(`[LOGIN ERROR] Dept mismatch. Emp Dept: ${empDept}, Admin Dept: ${adminDept}`);
      return res.status(403).json({ error: `الموظف مسجل بقسم (${employee.department}) وغير مصرح له بإدارة قسم (${user.department})` });
    }
  }

  // إدراج القسم الفعلي واسم المشرف الفعلي في الـ Token
  const tokenPayload = {
    id:         user.id,
    username:   user.username,
    role:       user.role,
    name:       employee.name,
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
    user: { id: user.id, username: user.username, role: tokenPayload.role, name: employee.name, department: tokenPayload.department }
  });
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

    res.status(result.status).json(result.body);
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

    res.status(result.status).json(result.body);
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

    res.status(result.status).json(result.body);
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
  res.json({
    found: true,
    employee: {
      code:       emp.empCode,
      name:       emp.name       || '',
      department: emp.department  || '',
      jobTitle:   emp.jobTitle   || '',
      role:       emp.role       || 'worker',
      phone:      emp.phone      || ''
    }
  });
});

// ── GET /api/employees/export-excel — تصدير قاعدة الموظفين كـ xlsx
app.get('/api/employees/export-excel',
  authenticateToken,
  requireRole('super_admin', 'hse_admin', 'dept_admin', 'issuer'),
  async (req, res) => {
    try {
      const employees = readEmployees();
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
  requireRole('super_admin', 'hse_admin', 'dept_admin', 'issuer'),
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
        hazardsMap.set(code, (hazardsMap.get(code) || 0) + 1);
      }
    });

    const trainingsMap = new Map();
    trainings.filter(t => !t.isDeleted).forEach(trn => {
      trn.attendees.forEach(att => {
        if (att.verified) {
          const code = normalizeEmpCode(att.empCode);
          if (code) {
            trainingsMap.set(code, (trainingsMap.get(code) || 0) + 0.5); // 0.5 hours per session
          }
        }
      });
    });

    const enrichedEmployees = employees.map(emp => {
      const code = normalizeEmpCode(emp.code || emp.empCode);
      return {
        ...emp,
        hazardCount: hazardsMap.get(code) || 0,
        trainingHours: trainingsMap.get(code) || 0
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
  res.status(result.status).json(result.body);
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
    res.status(result.status).json(result.body);
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
    res.status(result.status).json(result.body);
  }
);

// ============================================================
// 🎓 API ROUTES — HSE TRAINING MODULE
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
  
  const activeSession = trainings.find(t => t.status === 'active');
  const myHistory = [];
  let totalClosed = 0;
  let myAttended = 0;
  
  trainings.forEach(trn => {
    if (trn.status === 'closed') totalClosed++;
    const me = trn.attendees.find(a => normalizeEmpCode(a.empCode) === code);
    if (me) {
      if (trn.status === 'closed' && me.verified) myAttended++;
      myHistory.push({
        date: trn.date,
        title: trn.title,
        status: me.verified ? '✅ مؤكد' : '⏳ قيد المراجعة',
        verified: me.verified
      });
    }
  });
  
  // Filter out attendees list from activeSession to protect privacy before sending to worker
  let safeActiveSession = null;
  if (activeSession) {
    safeActiveSession = { ...activeSession };
    // Only send if the worker themselves attended
    const meAttended = activeSession.attendees.find(a => normalizeEmpCode(a.empCode) === code);
    safeActiveSession.attendees = meAttended ? [meAttended] : [];
  }

  res.json({ 
    activeSession: safeActiveSession, 
    myHistory, 
    totalClosed, 
    myAttended 
  });
});

app.post('/api/trainings', authenticateToken, requireRole('super_admin', 'hse_admin'), async (req, res) => {
  const { title, targetGroup, location, date, startTime, endTime, sessionPin } = req.body;
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
  res.status(result.status).json(result.body);
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
  res.status(result.status).json(result.body);
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
  res.status(result.status).json(result.body);
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
  res.status(result.status).json(result.body);
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
  res.status(result.status).json(result.body);
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
  res.status(result.status).json(result.body);
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
  res.status(result.status).json(result.body);
});

app.get('/api/trainings/:id/export-excel', authenticateToken, requireRole('super_admin', 'hse_admin', 'dept_admin'), async (req, res) => {
  try {
    const trainings = readTrainings();
    const trn = trainings.find(t => t.id === req.params.id);
    if (!trn) return res.status(404).json({ error: 'المحاضرة غير موجودة' });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('سجل الحضور');
    ws.columns = [
      { header: 'الكود الوظيفي', key: 'empCode', width: 15 },
      { header: 'الاسم', key: 'name', width: 30 },
      { header: 'القسم', key: 'department', width: 25 },
      { header: 'وقت الحضور', key: 'attendedAt', width: 25 },
      { header: 'حالة التأكيد', key: 'verified', width: 15 },
    ];

    trn.attendees.forEach(a => {
      ws.addRow({
        empCode: a.empCode,
        name: a.name,
        department: a.department || 'غير محدد',
        attendedAt: new Date(a.attendedAt).toLocaleString('ar-EG'),
        verified: a.verified ? 'مؤكد' : 'غير مؤكد'
      });
    });

    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD51E27' } };

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
// 🔔 API ROUTES — NOTIFICATION CENTER
// ============================================================

app.get('/api/notifications', (req, res) => {
  const { role, empCode, department } = req.query;
  const notifications = readNotifications();
  
  // Filter notifications based on role or empCode
  let userNotifs = notifications.filter(n => {
    if (role === 'super_admin') return true;
    if (n.targetEmpCode && empCode && normalizeEmpCode(n.targetEmpCode) === normalizeEmpCode(empCode)) return true;
    if (n.targetRole && role && n.targetRole === role) {
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
app.get('/api/vapid-publicKey', (req, res) => {
  res.send(vapidKeys.publicKey);
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