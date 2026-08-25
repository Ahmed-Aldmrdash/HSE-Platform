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

const app  = express();
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

// ── Middleware ────────────────────────────────────────────────
// Tighter payload limit — workers submit text only; 2 MB is generous
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Rate Limiters ─────────────────────────────────────────────
/** Auth: max 10 login attempts per 15 min per IP */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
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
  message: { error: 'تجاوزت الحد المسموح لتقديم التصاريح. حاول مجدداً بعد 15 دقيقة.' }
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

// ── Cache-Busting: prevent browsers/CDNs caching app-shell files ──────────
// Must come BEFORE express.static so the headers are set on every response.
app.use((req, res, next) => {
  const p = req.path;
  if (
    p === '/' ||
    p.endsWith('.html') ||
    p.endsWith('.js')  ||
    p.endsWith('.css')
  ) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma',  'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));


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

// ── Storage Helpers ───────────────────────────────────────────
function readStorage() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Error reading storage.json:', err);
    return {};
  }
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
    return JSON.parse(fs.readFileSync(HAZARDS_FILE, 'utf8'));
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
    return JSON.parse(fs.readFileSync(EMPLOYEES_FILE, 'utf8'));
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
    return JSON.parse(fs.readFileSync(TRAINING_TOPICS_FILE, 'utf8'));
  } catch (err) {
    console.error('Error reading training-topics.json:', err);
    return [];
  }
}

function readTrainings() {
  if (!fs.existsSync(TRAININGS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(TRAININGS_FILE, 'utf8'));
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
    return JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf8'));
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

/**
 * Creates a notification and appends it to the storage safely using enqueueWrite.
 * @param {Object} options - { targetRole, targetEmpCode, targetGroup, type, title, message, link }
 */
function createNotification({ targetRole, targetEmpCode, targetGroup, type, title, message, link }) {
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
      readBy: [],
      createdAt: new Date().toISOString()
    };
    notifications.push(newNotif);
    
    // Keep only the last 1000 notifications to prevent file bloat
    if (notifications.length > 1000) {
      notifications.splice(0, notifications.length - 1000);
    }
    
    writeNotifications(notifications);
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

// ── Ensure Default Super Admin ────────────────────────────────
async function ensureDefaultSuperAdmin() {
  const storage = readStorage();
  let users = [];
  if (storage['app-users']) {
    try { users = JSON.parse(storage['app-users']); } catch { users = []; }
  }

  const hasSuperAdmin = users.some(u => u.role === 'superadmin');
  if (!hasSuperAdmin) {
    const hashedPassword = await bcrypt.hash('admin123', BCRYPT_ROUNDS);
    users.unshift({
      id: 'superadmin-default',
      username: 'superadmin',
      password: hashedPassword,
      role: 'superadmin',
      name: 'المدير العام',
      createdAt: new Date().toISOString()
    });
    storage['app-users'] = JSON.stringify(users);
    writeStorage(storage);
    console.log('✅ Default superadmin account created.');
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

// ── Startup Sequence ──────────────────────────────────────────
(async () => {
  await ensureDefaultSuperAdmin();
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
        worksheet = workbook.getWorksheet('سجل التصاريح');
      } catch (readErr) {
        console.warn('Excel sync: could not read existing file (may be open), creating fresh.', readErr.message);
        workbook = new ExcelJS.Workbook();
        worksheet = null;
      }
    }

    if (!worksheet) {
      worksheet = workbook.addWorksheet('سجل التصاريح');
      worksheet.columns = [
        { header: 'رقم التصريح',   key: 'id',                width: 18 },
        { header: 'نوع التصريح',   key: 'typeLabel',         width: 20 },
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
  const key  = req.params.key;
  if (Object.prototype.hasOwnProperty.call(data, key)) {
    res.json({ key, value: data[key] });
  } else {
    res.status(404).json({ error: 'Key not found' });
  }
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
            targetRole: 'admin',
            type: 'permit',
            title: 'تصريح جديد 📋',
            message: `مقدم من ${p.workerName || 'موظف'} نوع ${p.typeLabel || 'غير محدد'} في ${p.location || 'غير محدد'}`,
            link: 'tabPermits'
          });
          
          if (p.employeeId) {
            createNotification({
              targetEmpCode: p.employeeId,
              type: 'permit',
              title: 'استلام طلب تصريح ✅',
              message: 'تم استلام طلب تصريحك بنجاح وهو قيد المراجعة',
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
            timeFrom:         sanitizeStr(String(p.timeFrom || ''), 10),
            timeTo:           sanitizeStr(String(p.timeTo || ''), 10),
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
            status:           'pending_area_head',
            reviewedBy:       '',
            reviewedAt:       '',
            reviewNote:       '',
            closure:          null,
            areaHeadReviewedBy:  '',
            areaHeadReviewedAt:  '',
            safetyOfficerName:   '',
            areaManagerName:     '',
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
  requireRole('superadmin', 'admin', 'supervisor'),
  (req, res) => {
    if (fs.existsSync(EXCEL_FILE)) {
      res.download(EXCEL_FILE, 'سجل_تصاريح_العمل.xlsx');
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
  requireRole('superadmin', 'admin', 'supervisor', 'area_head'),
  async (req, res) => {
    const permitId = req.params.id;
    const { action, reviewNote, safetyOfficerName, areaManagerName, closureType, closureReason } = req.body;

    const VALID_ACTIONS = ['approve', 'reject', 'close', 'area_approve', 'area_reject'];
    if (!action || !VALID_ACTIONS.includes(action)) {
      return res.status(400).json({ error: `الإجراء غير صالح. المتاح: ${VALID_ACTIONS.join(' | ')}` });
    }
    // area_head actions must be from an area_head user
    if ((action === 'area_approve' || action === 'area_reject') && req.user.role !== 'area_head' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'هذا الإجراء مخصص لرئيس المنطقة فقط' });
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
        result = { status: 404, body: { error: 'التصريح غير موجود' } };
        return;
      }

      const now = new Date().toISOString();
      const reviewerName = req.user.name || req.user.username;

      if (action === 'area_approve') {
        // Area head first-tier approval: pending_area_head → pending_admin
        if (permits[idx].status !== 'pending_area_head') {
          result = { status: 409, body: { error: 'لا يمكن موافقة رئيس المنطقة إلا على تصاريح pending_area_head' } };
          return;
        }
        // Optionally validate department match (skipped for superadmin bypass)
        if (req.user.role === 'area_head' && req.user.department &&
            permits[idx].department && req.user.department !== permits[idx].department) {
          result = { status: 403, body: { error: 'رئيس المنطقة لا يملك صلاحية الموافقة على تصاريح قسم آخر' } };
          return;
        }
        permits[idx].status              = 'pending_admin';
        permits[idx].areaHeadReviewedAt  = now;
        permits[idx].areaHeadReviewedBy  = sanitizeStr(reviewerName, 100);
      } else if (action === 'area_reject') {
        // Area head rejection: pending_area_head → rejected
        if (permits[idx].status !== 'pending_area_head') {
          result = { status: 409, body: { error: 'لا يمكن رفض إلا تصاريح pending_area_head' } };
          return;
        }
        permits[idx].status     = 'rejected';
        permits[idx].reviewedAt = now;
        permits[idx].reviewedBy = sanitizeStr(reviewerName, 100);
        permits[idx].reviewNote = sanitizeStr(reviewNote, 500);
      } else if (action === 'approve') {
        // Admin final approval: pending_admin → approved
        if (permits[idx].status !== 'pending_admin') {
          result = { status: 409, body: { error: 'الموافقة النهائية تتطلب حالة pending_admin' } };
          return;
        }
        permits[idx].status            = 'approved';
        permits[idx].reviewedAt        = now;
        permits[idx].reviewedBy        = sanitizeStr(reviewerName, 100);
        permits[idx].safetyOfficerName = sanitizeStr(safetyOfficerName, 100);
        permits[idx].areaManagerName   = sanitizeStr(areaManagerName,   100);
      } else if (action === 'reject') {
        // Admin rejection on pending_admin
        if (permits[idx].status !== 'pending_admin' && permits[idx].status !== 'pending_area_head') {
          result = { status: 409, body: { error: 'لا يمكن الرفض إلا على التصاريح قيد الانتظار' } };
          return;
        }
        permits[idx].status     = 'rejected';
        permits[idx].reviewedAt = now;
        permits[idx].reviewedBy = sanitizeStr(reviewerName, 100);
        permits[idx].reviewNote = sanitizeStr(reviewNote, 500);
      } else if (action === 'close') {
        if (!permits[idx].status || !permits[idx].status.startsWith('approved')) {
          // Allow closing only approved permits
          // (reject closing of pending/rejected/already-closed unless superadmin)
          if (req.user.role !== 'superadmin' && permits[idx].status !== 'approved') {
            result = { status: 409, body: { error: 'لا يمكن إغلاق إلا التصاريح الموافق عليها' } };
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
          if (action === 'approve' || action === 'area_approve') {
            createNotification({
              targetEmpCode: permits[idx].employeeId,
              type: 'permit',
              title: 'موافقة على التصريح 🎉',
              message: `تمت الموافقة على تصريحك رقم ${permits[idx].id} ويمكنك بدء العمل`,
              link: 'tabMyHistory'
            });
          } else if (action === 'reject' || action === 'area_reject') {
            createNotification({
              targetEmpCode: permits[idx].employeeId,
              type: 'permit',
              title: 'رفض التصريح ❌',
              message: `تم رفض تصريحك رقم ${permits[idx].id} - السبب: ${reviewNote || 'غير محدد'}`,
              link: 'tabMyHistory'
            });
          } else if (action === 'close') {
            createNotification({
              targetEmpCode: permits[idx].employeeId,
              type: 'permit',
              title: 'إغلاق التصريح 🔒',
              message: `تم إنهاء وإغلاق التصريح رقم ${permits[idx].id}`,
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

app.get('/api/hazards', authenticateToken, requireRole('superadmin', 'admin', 'supervisor', 'area_head'), async (req, res) => {
  let hazards = readHazards();
  let changed = false;
  const now = new Date().toISOString();
  const readerName = sanitizeStr(req.user.name || req.user.username || 'المشرف', 100);

  hazards.forEach(h => {
    if (!h.seenAt) {
      h.seenAt = now;
      h.seenBy = readerName;
      changed = true;
    }
  });

  if (changed) {
    writeHazards(hazards);
  }
  
  if (req.user.role === 'area_head' && req.user.department) {
    hazards = hazards.filter(h => h.department === req.user.department);
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

app.patch('/api/hazards/:id', authenticateToken, requireRole('superadmin', 'admin', 'supervisor', 'area_head'), async (req, res) => {
  const hazardId = req.params.id;
  const { status, actionTaken } = req.body;

  const VALID_STATUSES = ['open', 'notified', 'in_progress', 'resolved', 'closed'];
  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'حالة غير صالحة' });
  }

  let result;
  await enqueueWrite(async () => {
    let hazards = readHazards();
    const idx = hazards.findIndex(h => h.id === hazardId);
    if (idx === -1) {
      result = { status: 404, body: { error: 'البلاغ غير موجود' } };
      return;
    }

    if (req.user.role === 'area_head' && req.user.department && hazards[idx].department !== req.user.department) {
       result = { status: 403, body: { error: 'ليس لديك صلاحية لتعديل هذا البلاغ' } };
       return;
    }

    hazards[idx].status = status;
    if (actionTaken !== undefined) {
      hazards[idx].actionTaken = sanitizeStr(actionTaken, 1000);
    }
    // Update who changed it
    const updater = sanitizeStr(req.user.name || req.user.username || 'المشرف', 100);
    hazards[idx].updatedBy = updater;
    
    const now = new Date().toISOString();
    
    if (status === 'resolved' || status === 'closed') {
      hazards[idx].resolvedAt = now;
      hazards[idx].resolvedBy = updater;
      if (!hazards[idx].inProgressAt) {
        hazards[idx].inProgressAt = now;
        hazards[idx].inProgressBy = updater;
      }
      if (!hazards[idx].seenAt) {
        hazards[idx].seenAt = now;
        hazards[idx].seenBy = updater;
      }
    } else if (status === 'in_progress') {
      if (!hazards[idx].inProgressAt) {
        hazards[idx].inProgressAt = now;
        hazards[idx].inProgressBy = updater;
      }
      if (!hazards[idx].seenAt) {
        hazards[idx].seenAt = now;
        hazards[idx].seenBy = updater;
      }
    } else if (status === 'notified') {
      if (!hazards[idx].seenAt) {
        hazards[idx].seenAt = now;
        hazards[idx].seenBy = updater;
      }
    }

    if (writeHazards(hazards)) {
      await syncHazardsExcelFromData(hazards);
      
      if (hazards[idx].empCode) {
        createNotification({
          targetEmpCode: hazards[idx].empCode,
          type: 'hazard',
          title: 'تحديث حالة البلاغ 🛠️',
          message: `تم تحديث حالة بلاغك في ${hazards[idx].location || hazards[idx].area} إلى: ${status}`,
          link: 'tabMyHazards'
        });
      }

      result = { status: 200, body: { success: true, hazard: hazards[idx] } };
    } else {
      result = { status: 500, body: { error: 'فشل التحديث' } };
    }
  });

  res.status(result.status).json(result.body);
});

app.get('/api/export-hazards', authenticateToken, requireRole('superadmin', 'admin', 'supervisor', 'area_head'), async (req, res) => {
  try {
    let hazards = readHazards();
    
    if (req.user && req.user.role === 'area_head' && req.user.department) {
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
// 🔑 API ROUTES — AUTH
// ============================================================
// 🔑 API ROUTES — AUTH
// ============================================================

// ── PATCH /api/permits/:id/worker-close — إغلاق التصريح من قِبل الموظف
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
      result = { status: 404, body: { error: 'التصريح غير موجود' } };
      return;
    }

    // Ownership check: only the worker who submitted can close it
    if (!permits[idx].employeeId ||
        permits[idx].employeeId.toLowerCase() !== String(employeeId).toLowerCase()) {
      result = { status: 403, body: { error: 'غير مصرح لك بإغلاق هذا التصريح' } };
      return;
    }

    // Only approved permits can be closed by workers
    if (permits[idx].status !== 'approved') {
      result = { status: 409, body: { error: 'يمكن إغلاق التصاريح الموافق عليها فقط' } };
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
        title: 'إغلاق تصريح من العامل 🔒',
        message: `تم إنهاء وإغلاق التصريح رقم ${permits[idx].id} من قِبل ${permits[idx].workerName || employeeId}`,
        link: 'tabPermits'
      });
      
      createNotification({
        targetEmpCode: permits[idx].employeeId,
        type: 'permit',
        title: 'تأكيد إغلاق التصريح ✅',
        message: 'تم إغلاق التصريح بسلامة',
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
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'يجب إدخال اسم المستخدم وكلمة المرور' });
  }

  const storage = readStorage();
  let users = [];
  if (storage['app-users']) {
    try { users = JSON.parse(storage['app-users']); } catch { users = []; }
  }

  // البحث عن المستخدم باسمه فقط (bcrypt.compare للكلمة)
  const user = users.find(u => u.username === username);
  if (!user) {
    // نفس وقت الاستجابة لمنع Username Enumeration
    await bcrypt.compare(password, '$2b$12$invalidhashtopreventtimingattack000000000000');
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  // Include department in token for area_head role-based permit filtering
  const tokenPayload = {
    id:         user.id,
    username:   user.username,
    role:       user.role,
    name:       user.name,
    department: user.department || ''
  };
  const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES });

  res.json({
    success: true,
    token,
    user: { id: user.id, username: user.username, role: user.role, name: user.name, department: user.department || '' }
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
  requireRole('superadmin'),
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
  requireRole('superadmin'),
  async (req, res) => {
    const { username, password, role, name } = req.body;

    if (!username || !password || !role || !name) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    }
    const VALID_ROLES = ['admin', 'supervisor', 'area_head'];
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `الدور غير صالح. الأدوار المتاحة: ${VALID_ROLES.join(', ')}` });
    }
    if (role === 'area_head' && !req.body.department) {
      return res.status(400).json({ error: 'يجب تحديد القسم لرئيس المنطقة' });
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
        department: role === 'area_head' ? (req.body.department || '').trim() : '',
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
  requireRole('superadmin'),
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
      if (userToDelete.role === 'superadmin') {
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

// ── PATCH /api/users/:id/password — تغيير كلمة مرور
app.patch('/api/users/:id/password',
  authenticateToken,
  requireRole('superadmin'),
  async (req, res) => {
    const userId     = req.params.id;
    const { newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({ error: 'كلمة المرور الجديدة مطلوبة' });
    }
    if (newPassword.length < 6) {
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

      users[idx].password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      storage['app-users'] = JSON.stringify(users);

      if (writeStorage(storage)) {
        result = { status: 200, body: { success: true } };
      } else {
        result = { status: 500, body: { error: 'فشل تحديث كلمة المرور' } };
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
  requireRole('superadmin', 'admin', 'supervisor', 'area_head', 'hse', 'issuer'),
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
  requireRole('superadmin', 'admin', 'supervisor', 'area_head', 'hse', 'issuer'),
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
  requireRole('superadmin', 'admin', 'supervisor', 'area_head', 'hse', 'issuer'),
  (req, res) => res.json({ employees: readEmployees() })
);

// ── POST /api/employees — إضافة موظف (محمي) أو تسجيل ذاتي (عام)
app.post('/api/employees', async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authenticateToken(req, res, () =>
      requireRole('superadmin', 'admin', 'supervisor', 'area_head', 'hse', 'issuer')(req, res, next)
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

app.post('/api/trainings', authenticateToken, requireRole('superadmin', 'admin', 'supervisor', 'area_head'), async (req, res) => {
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

app.put('/api/trainings/:id/close', authenticateToken, requireRole('superadmin', 'admin', 'supervisor', 'area_head'), async (req, res) => {
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

app.put('/api/trainings/:id/verify-attendee', authenticateToken, requireRole('superadmin', 'admin', 'supervisor', 'area_head'), async (req, res) => {
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

app.get('/api/trainings/:id/export-excel', authenticateToken, requireRole('superadmin', 'admin', 'supervisor', 'area_head'), async (req, res) => {
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

app.get('/api/trainings/stats/employees', authenticateToken, requireRole('superadmin', 'admin', 'supervisor', 'area_head'), (req, res) => {
  const employees = readEmployees();
  const trainings = readTrainings();
  const totalTrainings = trainings.length;

  const statsMap = new Map();
  employees.forEach(e => {
    const code = normalizeEmpCode(e.code || e.empCode);
    if (!statsMap.has(code)) {
      statsMap.set(code, {
        empCode: code,
        name: e.name || 'غير معروف',
        department: e.department || 'غير محدد',
        attendedCount: 0,
        totalTrainings: totalTrainings,
        percentage: 0
      });
    }
  });

  trainings.forEach(trn => {
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
    stat.percentage = totalTrainings > 0 ? Math.round((stat.attendedCount / totalTrainings) * 100) : 0;
    return stat;
  });

  res.json({ stats: statsList, totalTrainings });
});

// ============================================================
// 🔔 API ROUTES — NOTIFICATION CENTER
// ============================================================

app.get('/api/notifications', (req, res) => {
  const { role, empCode } = req.query;
  const notifications = readNotifications();
  
  // Filter notifications based on role or empCode
  let userNotifs = notifications.filter(n => {
    if (n.targetRole === 'all') return true;
    if (n.targetEmpCode && empCode && normalizeEmpCode(n.targetEmpCode) === normalizeEmpCode(empCode)) return true;
    if (n.targetRole && role && n.targetRole === role) return true;
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
        if (n.targetRole && role && n.targetRole === role) canRead = true;
        
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