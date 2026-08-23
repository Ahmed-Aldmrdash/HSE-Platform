// ============================================================
// Work Permits App — Production-Ready Server
// OWASP-Compliant Security: bcrypt + JWT + RBAC + Write Queue
// ============================================================
'use strict';

require('dotenv').config();

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const ExcelJS = require('exceljs');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');

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
const DATA_FILE = path.join(DATA_DIR, 'storage.json');
const EXCEL_FILE = path.join(DATA_DIR, 'permits_log.xlsx');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── Middleware ────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
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
    console.log('✅ Default superadmin account created: superadmin / admin123');
  }
}

// ── Startup sequence (async) ──────────────────────────────────
(async () => {
  await ensureDefaultSuperAdmin();
  await migratePasswordsIfNeeded();
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

// ── POST /api/storage/:key — حفظ قيمة
// حماية: لا يُسمح بالكتابة على app-users أو users إلا للـ superadmin
app.post('/api/storage/:key', (req, res, next) => {
  const key = req.params.key;
  const PROTECTED_KEYS = ['app-users', 'users'];

  if (PROTECTED_KEYS.includes(key)) {
    // هذا المفتاح محمي — يجب Token صالح + دور superadmin
    return authenticateToken(req, res, () => {
      requireRole('superadmin')(req, res, next);
    });
  }
  // المفاتيح الأخرى (work-permits, employees...) مسموح بها
  next();
}, async (req, res) => {
  const { value } = req.body;
  const key       = req.params.key;

  if (value === undefined || value === null) {
    return res.status(400).json({ error: 'القيمة (value) مطلوبة في جسم الطلب' });
  }

  // استخدام Write Queue لمنع Race Conditions
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

// ── GET /api/export-excel — تصدير ملف الإكسيل
app.get('/api/export-excel', (req, res) => {
  if (fs.existsSync(EXCEL_FILE)) {
    res.download(EXCEL_FILE, 'سجل_تصاريح_العمل.xlsx');
  } else {
    res.status(404).send('لا يوجد سجل حالياً');
  }
});

// ============================================================
// 🔑 API ROUTES — AUTH
// ============================================================

// ── POST /api/auth/login — تسجيل الدخول
app.post('/api/auth/login', async (req, res) => {
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

  // إنشاء JWT Token
  const tokenPayload = {
    id:       user.id,
    username: user.username,
    role:     user.role,
    name:     user.name
  };
  const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES });

  res.json({
    success: true,
    token,
    user: { id: user.id, username: user.username, role: user.role, name: user.name }
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
    // إرجاع البيانات بدون كلمات المرور
    const safeUsers = users.map(u => ({
      id:        u.id,
      username:  u.username,
      role:      u.role,
      name:      u.name,
      createdAt: u.createdAt
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
    if (!['admin', 'supervisor'].includes(role)) {
      return res.status(400).json({ error: 'الدور غير صالح. الأدوار المتاحة: admin, supervisor' });
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
        id:        'user-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
        username:  username.trim(),
        password:  hashedPassword,
        role:      role,
        name:      name.trim(),
        createdAt: new Date().toISOString()
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
// 👷 API ROUTES — EMPLOYEES (مفتوح — بدون تسجيل دخول)
// ============================================================

// ── GET /api/employees — جلب كل الموظفين
app.get('/api/employees', (req, res) => {
  const storage = readStorage();
  let employees = [];
  if (storage['employees']) {
    try { employees = JSON.parse(storage['employees']); } catch { employees = []; }
  }
  res.json({ employees });
});

// ── GET /api/employees/:empCode — البحث بالكود
app.get('/api/employees/:empCode', (req, res) => {
  const empCode = req.params.empCode.trim().toLowerCase();
  const storage = readStorage();
  let employees = [];
  if (storage['employees']) {
    try { employees = JSON.parse(storage['employees']); } catch { employees = []; }
  }
  const emp = employees.find(e => e.empCode && e.empCode.toLowerCase() === empCode);
  if (!emp) {
    return res.status(404).json({ error: 'الكود الوظيفي غير موجود' });
  }
  res.json({ employee: emp });
});

// ── POST /api/employees — إضافة/تحديث موظف
app.post('/api/employees', async (req, res) => {
  const { empCode, name, phone, department } = req.body;

  if (!empCode || !name) {
    return res.status(400).json({ error: 'الكود الوظيفي والاسم مطلوبان' });
  }

  let result;
  await enqueueWrite(async () => {
    const storage = readStorage();
    let employees = [];
    if (storage['employees']) {
      try { employees = JSON.parse(storage['employees']); } catch { employees = []; }
    }

    const codeNorm = empCode.trim();
    const existingIdx = employees.findIndex(e => e.empCode && e.empCode.toLowerCase() === codeNorm.toLowerCase());

    if (existingIdx !== -1) {
      employees[existingIdx] = {
        ...employees[existingIdx],
        name:       name.trim(),
        phone:      (phone || '').trim(),
        department: (department || '').trim()
      };
      storage['employees'] = JSON.stringify(employees);
      writeStorage(storage);
      result = { status: 200, body: { success: true, employee: employees[existingIdx] } };
      return;
    }

    const newEmp = {
      empCode:      codeNorm,
      name:         name.trim(),
      phone:        (phone || '').trim(),
      department:   (department || '').trim(),
      registeredAt: new Date().toISOString()
    };
    employees.push(newEmp);
    storage['employees'] = JSON.stringify(employees);

    if (writeStorage(storage)) {
      result = { status: 200, body: { success: true, employee: newEmp } };
    } else {
      result = { status: 500, body: { error: 'فشل حفظ بيانات الموظف' } };
    }
  });

  res.status(result.status).json(result.body);
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