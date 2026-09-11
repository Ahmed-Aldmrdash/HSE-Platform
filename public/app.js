// ============================================================
// 🔧 Small generic debounce helper — used by all "live search" inputs
// (permits / hazards / etc.) so typing doesn't trigger a full
// re-render (or a server refetch) on every single keystroke.
// ============================================================
window.debounce = function(fn, wait) {
  let t;
  return function(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait || 250);
  };
};

// ============================================================
// ⚠️ GLOBAL ERROR BOUNDARY & FALLBACKS
// ============================================================
window.currentSessionType = window.currentSessionType || 'supervisor';
var currentSessionType = window.currentSessionType;
var notifEventSource = null;
var currentAdminToken = typeof getToken === 'function' ? getToken() : (sessionStorage.getItem('wp_auth_token') || '');

window.playNotificationChime = function() {
  try {
    if (typeof chimeAudio !== 'undefined' && chimeAudio) {
      chimeAudio.play().catch(() => {});
    }
  } catch (e) {}
};

window.pollMyHazards = function() {
  if (typeof silentRefreshHazards === 'function') silentRefreshHazards();
};

window.onerror = function(msg, url, lineNo, columnNo, error) {
  console.error('Unhandled error:', msg, url, lineNo, columnNo, error);
  // Prevent white screen lockup by catching it early
  return false;
};

// ============================================================
// 🔑 JWT Token Management & Auth Fetch Helper
// ============================================================

/** توحيد وتطبيع الأكواد الوظيفية (إزالة الأصفار البادئة) */
function normalizeEmpCode(code) {
  if (!code && code !== 0) return '';
  const str = String(code).trim();
  const stripped = str.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

function getRoleKey(role) {
  if (role === 'dept_admin' || role === 'area_admin' || role === 'maint_admin') return 'areaAdmin';
  if (role === 'hse_admin' || role === 'safety_admin') return 'safetyAdmin';
  if (role === 'super_admin') return 'superAdmin';
  return 'worker';
}


/** حفظ الـ JWT Token في sessionStorage (يُمسح عند إغلاق التبويب) */
function saveToken(token) {
  try { sessionStorage.setItem('wp_auth_token', token); } catch(e) {}
}

/** جلب الـ JWT Token المحفوظ */
function getToken() {
  try { return sessionStorage.getItem('wp_auth_token'); } catch(e) { return null; }
}

/** مسح الـ JWT Token عند تسجيل الخروج */
function clearToken() {
  try { sessionStorage.removeItem('wp_auth_token'); } catch(e) {}
}

/**
 * navigateWithAuth — مثل window.location.href لكن يُرفق التوكن كـ ?dt=
 * لروابط التنزيل المباشر (Excel/Word) التي تُفتح بنقرة زر <a>/onclick
 * ولا يمكنها إرسال Authorization header. السيرفر يقرأ هذا التوكن عبر
 * authenticateTokenFlexible لنفس مسارات التنزيل فقط.
 */
function navigateWithAuth(url) {
  const token = getToken();
  if (!token) { showToast('سجّل دخولك أولاً لتنزيل الملف', 'error'); return; }
  const sep = url.includes('?') ? '&' : '?';
  window.location.href = `${url}${sep}dt=${encodeURIComponent(token)}`;
}

/**
 * authFetch — مثل fetch() لكن يُرفق Authorization: Bearer <token> تلقائياً.
 * يُستخدم لجميع مسارات الـ Admin المحمية.
 * إذا انتهت صلاحية الجلسة (401 + expired)، يُسجّل خروج تلقائي.
 */
async function authFetch(url, options = {}) {
  const token = getToken();
  if (token) {
    options.headers = {
      ...options.headers,
      'Authorization': `Bearer ${token}`
    };
  }
  try {
    const res = await fetch(url, options);
    // انتهت صلاحية الجلسة — سجّل خروج تلقائي
    if (res.status === 401) {
      const data = await res.clone().json().catch(() => ({}));
      if (data.expired) {
        showToast('انتهت صلاحية جلستك. يرجى تسجيل الدخول مجدداً.', 'error');
        logout();
      }
    }
    return res;
  } catch(e) {
    console.error('authFetch error', e);
    throw e;
  }
}

// ────────────────────────────────────────────────────────────
// 📢 UI Utilities
// ────────────────────────────────────────────────────────────

/**
 * safeEl(id) — null-safe getElementById. Returns the element or null without throwing.
 */
function safeEl(id) {
  try { return document.getElementById(id) || null; } catch(e) { return null; }
}

/**
 * showToast(msg, type) — lightweight non-blocking notification.
 * type: 'error' | 'success' | 'info'
 * Falls back to console.warn if DOM not ready.
 */
let _toastTimer = null;
function showToast(msg, type = 'error') {
  try {
    let toast = document.getElementById('_appToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = '_appToast';
      toast.style.cssText = [
        'position:fixed;bottom:24px;inset-inline-start:50%;transform:translateX(-50%)',
        'max-width:min(92vw,420px);z-index:99999;padding:12px 20px;border-radius:12px',
        'font-family:Cairo,sans-serif;font-size:14px;font-weight:700',
        'box-shadow:0 8px 24px rgba(0,0,0,0.3);transition:opacity .3s;text-align:center',
        'pointer-events:none;'
      ].join(';');
      document.body.appendChild(toast);
    }
    const colors = {
      error:   { bg:'#C81421', color:'#fff' },
      success: { bg:'#1F7A3D', color:'#fff' },
      info:    { bg:'#1A1A1A', color:'#fff' }
    };
    const c = colors[type] || colors.info;
    toast.style.background = c.bg;
    toast.style.color = c.color;
    toast.textContent = msg;
    toast.style.opacity = '1';
    toast.style.display = 'block';
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => { toast.style.display = 'none'; }, 350);
    }, 4000);
  } catch(e) {
    console.warn('[Toast]', msg);
  }
}

// ────────────────────────────────────────────────────────────
// 🔌 Storage API (talks to server.js)
// ────────────────────────────────────────────────────────────
async function apiGet(key){
  try{
    const cleanKey = key.startsWith('/') ? key.substring(1) : key;
    const res = await fetch(`/api/storage/${cleanKey}`);
    if(!res.ok) return null;
    return await res.json();
  }catch(e){
    if (!navigator.onLine) showToast('لا يوجد اتصال بالإنترنت — تحقق من اتصالك وحاول مجدداً', 'error');
    console.error('apiGet error', e);
    return null;
  }
}
async function apiSet(key, value){
  try{
    const cleanKey = key.startsWith('/') ? key.substring(1) : key;
    const res = await fetch(`/api/storage/${cleanKey}`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ value })
    });
    return res.ok;
  }catch(e){
    if (!navigator.onLine) showToast('لا يوجد اتصال — تحقق من الشبكة', 'error');
    console.error('apiSet error', e);
    return false;
  }
}

// ---------- permit type definitions (from the real forms) ----------
const PERMIT_TYPES = {
  general: {
    label: "عام",
    fullLabel: "طلب عمل عام",
    checklist: [
      "هل الاضاءة والتهوية كافية",
      "هل التاكد من توصيل الكابل الارضى للسيارة قبل التفريغ",
      "هل العمالة مدربة ومؤهلة وعلي علم بجميع مخاطر العمل المطلوب",
      "هل يتواجد ممثل الامن الادارى ومشرف السلامة",
      "هل مهمات الوقاية المطلوبة متوفرة ومناسبة / مستخدمة",
      "هل تم فحص منطقة التفريغ والتاكد من خلو المكان من اي تسريبات او مخاطر بعد التفريغ",
      "هل يوجد وسائل عزل منطقة العمل (ستائر / شريط / اقماع) / مستخدمة",
      "هل مكان العمل نظيف ومرتب وتم التخلص الآمن من المخلفات",
      "هل تم اخلاء المنطقة من اي مواد قابلة او مسببة للاشتعال",
      "هل تم فحص السيارة ظاهريا قبل التفريغ ومراجعة المستندات اللازمة",
      "هل تم تحجير السيارة قبل عملية التفريغ"
    ]
  },
  height: {
    label: "ارتفاع",
    fullLabel: "طلب عمل على ارتفاع",
    checklist: [
      "هل العمالة مدربة ومؤهلة للعمل المطلوب",
      "هل المشابك (الخطافات) خالية من أى عيوب",
      "هل الأرضية تحت السقالة مستوية",
      "هل الحلقة الخلفية لحبل التثبيت (شكل حرف D) خالية من أى عيوب",
      "هل يوجد مكان لربط حزام الأمان للعاملين",
      "فحص حبال التثبيت والتأكد من مطابقتها للمقاييس والمعايير",
      "هل يوجد حواجز منع السقوط من اعلى السقالة",
      "هل مزلاج الأمان (القفل) الخاص بالمخطاف خالى من أى عيوب",
      "هل يوجد سلم آمن للصعود والنزول من السقالة",
      "هل ماص الصدمات خالٍ من أى عيوب أو تشوه",
      "هل مواسير السقالة لا توجد بها أتلاف أو اعوجاج",
      "هل توجد ركائز جانبية لتدعيم السقالة",
      "هل شرائط الحزام خالية من أى عيوب"
    ]
  },
  confined: {
    label: "اماكن مغلقة",
    fullLabel: "طلب عمل أماكن مغلقة",
    checklist: [
      "هل توجد نوافذ واسعة للتهوية",
      "هل تم فحص الأجهزة الكهربائية والعدد اليدوية",
      "هل توجد إجراءات للتعامل مع المواد الكيميائية والخطرة",
      "هل توجد إجراءات للحفاظ على النظافة والترتيب",
      "هل توجد إجراءات للتعامل مع حالات الطوارئ",
      "هل توجد إجراءات لفصل وعزل مصادر الطاقة",
      "هل تم قياس نسبة الغازات",
      "هل تم اتخاذ الإجراءات للتعامل مع المخاطر الفيزيائية ومخاطر الاجتياح"
    ]
  },
  excavation: {
    label: "حفر",
    fullLabel: "طلب عمل حفر",
    checklist: [
      "هل تمت مراجعة قسم الميكانيكا لوجود مواسير سباكة في منطقة الحفر",
      "هل تمت مراجعة قسم الكهرباء لوجود كابلات في منطقة الحفر",
      "هل تم وضع حواجز أو شرائط تحذيرية في مكان الحفر",
      "هل تم فحص معدات الحفر قبل العمل والتأكد من صلاحيتها",
      "هل تم فحص الأوراق الخاصة بسائق المعدة",
      "هل يوجد وسيلة لتدعيم جوانب الحفر",
      "هل تم وضع خطة للتخلص من ناتج الحفر"
    ]
  },
  lifting: {
    label: "رفع",
    fullLabel: "طلب عمل رفع",
    checklist: [
      "هل يوجد شهادة معايرة للونش",
      "هل جميع العاملين المشتركين ملتزمين بكاب السيفتي",
      "هل يوجد بديل احتياطي للوير في حالة التلف",
      "هل يوجد عامل توجيه لسائق الرافعة",
      "هل يتم تزييت الوير ولا يوجد عليه شحوم",
      "هل يتم حساب زاوية الرفع والتأكد من قدرة الوير على الرفع",
      "هل الفرامل تعمل بكفاءة",
      "هل تم تجربة لسان الهوك للتأكد من أنه يفتح للداخل فقط",
      "هل يوجد قواعد جانبية لتثبيت معدة الونش عند رفع الأحمال",
      "هل لدى السائق رخصة سارية لقيادة الروافع المستخدمة"
    ]
  },
  hot: {
    label: "ساخن",
    fullLabel: "طلب عمل ساخن",
    checklist: [
      "هل الاضاءة والتهوية كافية",
      "هل تم تعيين مراقب حريق",
      "هل العمالة مدربة ومؤهلة للعمل المطلوب",
      "هل تم فحص جميع المعدات اللازمة للعمل قبل البدء",
      "هل مهمات الوقاية المطلوبة متوفرة ومناسبة / مستخدمة",
      "هل يوجد وسائل عزل منطقة العمل / مستخدمة",
      "هل مكان العمل نظيف ومرتب وتم التخلص الآمن من المخلفات",
      "هل يوجد أجهزة إطفاء مناسبة (نوعاً وحجماً) وصالحة للخدمة",
      "هل تم استبعاد أي مادة قابلة للاشتعال في مسافة لا تقل عن 11 متر",
      "هل تم عزل واستبعاد الأوعية المضغوطة والأنابيب من مكان العمل"
    ]
  },
  loto: {
    label: "فصل وعزل",
    fullLabel: "طلب عمل فصل وعزل الطاقة (LOTO)",
    checklist: [
      "هل للمعدة تعليمات عزل محددة، خاصة تفريغ الطاقة الكامنة",
      "هل العزل الجماعي لمصادر الطاقة مطبق",
      "هل تم تسجيل المعدة في سجل حصر المعدات ومصادر الطاقة",
      "هل تم تعليق البطاقات التحذيرية مع كل أداة عزل مستخدمة",
      "هل مصدر الطاقة مغلق كليًا بالشكل الصحيح بأقفال ومعدات العزل",
      "هل كل بطاقات عزل مصادر الطاقة تم إغلاقها بالشكل الصحيح",
      "هل تم تحديد الأفراد المصرح لهم بالعزل والعاملين على المعدة",
      "هل تم التمييز ببطاقات فقط (بدون أقفال) للحالات غير المجهزة",
      "هل المعدة مجهزة ليتم عمل العزل الآمن لها",
      "هل تم تفريغ جميع أشكال الطاقة المختزنة الخطرة والمواد المتبقية",
      "هل الأقفال وأدوات العزل الموجودة كلها عليها الكود",
      "هل تمت إزالة كل الأقفال والأدوات بعد انتهاء الصيانة",
      "هل سجل حصر وفحص أدوات العزل مستوفٍ لجميع البيانات",
      "هل يوجد حالة لرفع عزل جبري باستخدام نموذج رفع العزل الجبري"
    ]
  }
};

const SHIFTS = ["الأولى","الثانية","الثالثة"];
const RISK_LEVELS = [1,2,3,4,5];
// ⚠️ Fallback list only — used if /api/departments fails to load.
// This used to be the ONLY source for the department filter chips
// (permits + hazards), which meant the filter only ever showed these
// 9 old names even though the employee/department-admin database now
// has 40+ real departments. See loadRealDepartments() below, which
// fetches the live list and is what the filters actually use now.
const DEPARTMENTS_FALLBACK = [
  "Administration", "all factory", "Maintenance", "outside",
  "Production - Master Batch", "Production - Special Compounds",
  "Quality Control", "R&D", "Warehouse"
];

const WORK_LOCATIONS = [
  "Administration",
  "all factory",
  "Maintenance",
  "outside",
  "Production - Master Batch",
  "Production - Special Compounds",
  "Quality Control",
  "R&D",
  "Warehouse"
];

const TOOLS_LIST = [
  "عدد يدوية بسيطة",
  "مكواة لحام بلاستيك",
  "صاروخ قطعية",
  "ماكينة لحام",
  "لمبة قطعية",
  "هيلتي",
  "شنيور",
  "أخرى"
];

// الأقسام الثلاثة الرسمية لقائمة التحقق
const HSE_CHECKLIST = {
  general: {
    sectionTitle: "أ) متطلبات عامة",
    items: [
      "هل الإضاءة والتهوية كافية؟",
      "هل العمالة مدربة ومؤهلة وعلى علم بجميع مخاطر العمل المطلوب؟",
      "هل مهمات الوقاية المطلوبة متوفرة ومناسبة / مستخدمة؟",
      "هل توجد وسائل عزل منطقة العمل (ستائر / شريط / أقماع) / مستخدمة؟",
      "هل مكان العمل نظيف ومرتب وتم التخلص الآمن من المخلفات؟"
    ]
  },
  oilDischarge: {
    sectionTitle: "ب) تفريغ زيت (إن وجد)",
    items: [
      "هل تم إخلاء المنطقة من أي مواد قابلة أو مسببة للاشتعال؟",
      "هل تم فحص السيارة ظاهرياً قبل التفريغ ومراجعة المستندات اللازمة؟",
      "هل تم تحجير السيارة قبل عملية التفريغ؟",
      "هل تم التأكد من توصيل الكابل الأرضي للسيارة قبل التفريغ؟",
      "هل يتواجد ممثل الأمن الإداري ومشرف السلامة؟",
      "هل تم فحص منطقة التفريغ والتأكد من خلو المكان من أي تسريبات أو مخاطر بعد التفريغ؟"
    ]
  },
  specialMaterial: {
    sectionTitle: "ج) تشغيل خامة خاصة (إن وجد)",
    items: [
      "هل مهمات الوقاية المطلوبة الخاصة بالعملية متوفرة وفي حالة سليمة؟",
      "هل يوجد مصدر مياه بالقرب من مكان العمل؟",
      "هل تم توعية العاملين من مخاطر المادة وكيفية التعامل معها قبل بدء العمل؟",
      "هل تم التأكد من توصيل الكابل الأرضي لحلة الخلاط أثناء عملية تفريغ مادة (الفضي / الذهبي)؟"
    ]
  }
};

let currentFilter = 'الكل';
let currentTypeFilter = 'الكل';
let currentPmDeptFilter = 'الكل';
let currentPmYearFilter = 'الكل';
let permitsCache = [];

// ── Real department list (from /api/departments) — used by both the
// permits and hazards department filter chips instead of the old
// hardcoded DEPARTMENTS_FALLBACK array. Cached after first successful
// fetch since the department list rarely changes within one session.
let _realDepartmentsCache = null;
async function loadRealDepartments() {
  if (_realDepartmentsCache) return _realDepartmentsCache;
  try {
    const res = await authFetch('/api/departments');
    if (!res.ok) return DEPARTMENTS_FALLBACK;
    const data = await res.json();
    if (Array.isArray(data.departments) && data.departments.length > 0) {
      _realDepartmentsCache = data.departments;
      return _realDepartmentsCache;
    }
    return DEPARTMENTS_FALLBACK;
  } catch (err) {
    return DEPARTMENTS_FALLBACK;
  }
}
// Fixed set of years for the pinned year filter (newest first) — used by both
// permits (تصاريح العمل) and hazards (البلاغات) toolbars.
const FILTER_YEARS = ['2026', '2025', '2024', '2023'];
let isLoggedIn = false;
let currentUsername = '';
let currentUserName = '';
let currentUserRole = ''; // 'super_admin' | 'hse_admin' | 'dept_admin'
let currentUserDept = '';
let selectedType = 'general';
let supervisorPollTimer = null;
let lastPermitsRaw = '';
let umPassTargetId = ''; // for password change modal

// ---- Employee session ----
let currentEmployee = null; // { empCode, name, phone, department }
let myHistoryFilter = 'الكل';
let myHistoryPollTimer = null;
let lastMyHistoryRaw = '';

// ================================================================
// === RBAC UI STATE MACHINE ===
// 'none' | 'worker' | 'supervisor'
// ================================================================
let sessionRole = 'none';

/**
 * setDisplay — tiny helper to show/hide an element by ID
 */
function setDisplay(id, visible) {
  const el = document.getElementById(id);
  if (el) el.style.display = visible ? '' : 'none';
}

/**
 * applyRbacUI — the SINGLE source of truth for tab/view visibility.
 * Call this after every login/logout transition.
 * Also writes body[data-session] for CSS safety-net rules.
 */
function applyRbacUI() {
  const isWorker = sessionRole === 'worker';
  const isSup    = sessionRole === 'supervisor';
  const isNone   = sessionRole === 'none';

  // Sync CSS safety-net attribute
  document.body.dataset.session = sessionRole;

  // ── Main app container visibility ──────────────────────────────────
  // Show mainApp only when a role is active.  When isNone the overlay
  // is in charge; goToAdminLogin handles the transition manually so we
  // do NOT touch mainApp here in that case — it is shown by
  // hideWorkerLoginOverlay() and hidden by showWorkerLoginOverlay().
  const mainApp = document.getElementById('mainApp');
  if (isWorker || isSup) {
    if (mainApp) mainApp.style.display = 'block';
    const overlay = document.getElementById('workerLoginOverlay');
    if (overlay) overlay.style.display = 'none';
  }
  if (isNone) {
    if (mainApp) mainApp.style.display = 'none';
  }

  // ── Tab navigation bar ───────────────────────────────────────────────
  // Show the tab bar only when a role is active. When 'none', the gate
  // screen (or overlay) needs no navigation bar.
  setDisplay('mainTabs', isWorker || isSup);

  // Individual tab visibility
  setDisplay('tabWorker',       isWorker);
  setDisplay('tabHazardWorker', isWorker);
  setDisplay('tabMyHistory',    isWorker);
  setDisplay('tabMyHazards',    isWorker);
  // Work permits: every supervisor-session role, incl. maint_admin — same
  // access as any department head (e.g. Quality Control's dept_admin).
  setDisplay('tabSup',          isSup);
  setDisplay('tabSupHazard',    isSup);
  // Users tab: super_admin only
  const tabUsers = document.getElementById('tabUsers');
  if (tabUsers) tabUsers.style.display = (isSup && currentUserRole === 'super_admin') ? '' : 'none';
  // Employees tab: all supervisor-session roles
  const tabEmployees = document.getElementById('tabEmployees');
  if (tabEmployees) tabEmployees.style.display = isSup ? '' : 'none';
  
  // Training Tabs
  setDisplay('tabTrainingWorker', isWorker);
  setDisplay('tabTrainingAdmin', isSup && (currentUserRole === 'super_admin' || currentUserRole === 'hse_admin'));

  // Drill Tabs
  setDisplay('tabDrillWorker', isWorker);
  setDisplay('tabDrillAdmin', isSup && (currentUserRole === 'super_admin' || currentUserRole === 'hse_admin'));

  // Penalties Tabs — workers see their own; every supervisor role (incl. dept/maint admin, view-only) sees the admin list
  setDisplay('tabPenaltiesWorker', isWorker);
  setDisplay('tabPenaltiesAdmin', isSup);

  // Dashboard Tab — first tab, visible for ALL authenticated roles
  setDisplay('tabDashboard', isWorker || isSup);

  // "Clear all" buttons (permits/hazards): Safety (hse_admin) and Super Admin only —
  // never for dept_admin/maint_admin, who should not be able to wipe module data.
  const isSafetyOrSuper = isSup && (currentUserRole === 'hse_admin' || currentUserRole === 'super_admin');
  setDisplay('clearPermitsBtn', isSafetyOrSuper);
  setDisplay('clearHazardsBtn', isSafetyOrSuper);
  setDisplay('clearEmployeesBtn', isSafetyOrSuper);

  // "رفع ملفات" (Excel import) buttons: super_admin/hse_admin only — same
  // roles already enforced server-side (requireRole('super_admin','hse_admin')
  // on /api/permits/upload-excel, /api/hazards/upload-excel,
  // /api/penalties/upload-excel). Regular department-level admins
  // (dept_admin/maint_admin) no longer see these buttons at all.
  setDisplay('uploadPermitsExcelBtn', isSafetyOrSuper);
  setDisplay('uploadHazardsExcelBtn', isSafetyOrSuper);
  setDisplay('uploadPenaltiesExcelBtn', isSafetyOrSuper);

  // Badge areas
  const empArea  = document.getElementById('empBadgeArea');
  if (empArea)  empArea.style.display  = isWorker ? 'block' : 'none';

  // Notification Bell
  const notifContainer = document.getElementById('notifContainer');
  if (notifContainer) notifContainer.style.display = (isWorker || isSup) ? 'inline-flex' : 'none';
}

// ---------- storage helpers ----------
async function loadPermits(){
  const res = await apiGet('work-permits');
  return res && res.value ? JSON.parse(res.value) : [];
}
async function savePermits(list){
  return await apiSet('work-permits', JSON.stringify(list));
}
function genId(list){
  const year = new Date().getFullYear();
  // [FIX-4] الاعتماد على أعلى رقم موجود + 1 بدلاً من list.length لتجنب التكرار عند الحذف
  const maxN = list.reduce((mx, p) => {
    if(!p.id) return mx;
    const parts = p.id.split('-');
    const num = parseInt(parts[parts.length - 1]) || 0;
    return Math.max(mx, num);
  }, 0);
  return `WP-${year}-${String(maxN + 1).padStart(4,'0')}`;
}

// ---------- tabs ----------
function switchTab(which){
  window.currentActiveTab = which;
  // ── RBAC Guard: block CROSS-ROLE navigation only ───────────────────
  // Workers cannot jump to supervisor tabs; supervisors cannot jump to
  // worker tabs.  Pre-auth state ('none') is allowed to reach the
  // supervisor login gate so goToAdminLogin() keeps working.
  const workerTabs = ['worker', 'hazardWorker', 'myhistory', 'myhazards', 'trainingWorker', 'drillWorker', 'penaltiesWorker'];
  const supTabs    = ['sup', 'supHazard', 'users', 'employees', 'trainingAdmin', 'drillAdmin', 'penaltiesAdmin'];
  if (workerTabs.includes(which) && sessionRole === 'supervisor') return;
  if (supTabs.includes(which)   && sessionRole === 'worker') return;
  // ─────────────────────────────────────────────────────────────────

  document.getElementById('tabWorker').classList.toggle('active', which==='worker');
  const tabDash = document.getElementById('tabDashboard');
  if(tabDash) tabDash.classList.toggle('active', which==='dashboard');
  const tabHazardW = document.getElementById('tabHazardWorker');
  if(tabHazardW) tabHazardW.classList.toggle('active', which==='hazardWorker');
  const tabMH = document.getElementById('tabMyHistory');
  if(tabMH) tabMH.classList.toggle('active', which==='myhistory');
  const tabMyHaz = document.getElementById('tabMyHazards');
  if(tabMyHaz) tabMyHaz.classList.toggle('active', which==='myhazards');
  document.getElementById('tabSup').classList.toggle('active', which==='sup');
  const tabSupHazard = document.getElementById('tabSupHazard');
  if(tabSupHazard) tabSupHazard.classList.toggle('active', which==='supHazard');
  const tabUsers = document.getElementById('tabUsers');
  if(tabUsers) tabUsers.classList.toggle('active', which==='users');
  const tabEmp = document.getElementById('tabEmployees');
  if(tabEmp) tabEmp.classList.toggle('active', which==='employees');
  const tabTrnW = document.getElementById('tabTrainingWorker');
  if(tabTrnW) tabTrnW.classList.toggle('active', which==='trainingWorker');
  const tabTrnA = document.getElementById('tabTrainingAdmin');
  if(tabTrnA) tabTrnA.classList.toggle('active', which==='trainingAdmin');
  const tabDrlW = document.getElementById('tabDrillWorker');
  if(tabDrlW) tabDrlW.classList.toggle('active', which==='drillWorker');
  const tabDrlA = document.getElementById('tabDrillAdmin');
  if(tabDrlA) tabDrlA.classList.toggle('active', which==='drillAdmin');
  const tabPenW = document.getElementById('tabPenaltiesWorker');
  if(tabPenW) tabPenW.classList.toggle('active', which==='penaltiesWorker');
  const tabPenA = document.getElementById('tabPenaltiesAdmin');
  if(tabPenA) tabPenA.classList.toggle('active', which==='penaltiesAdmin');

  document.getElementById('viewWorker').style.display = which==='worker' ? 'block':'none';
  const viewHazardW = document.getElementById('viewHazardWorker');
  if(viewHazardW) viewHazardW.style.display = which==='hazardWorker' ? 'block':'none';
  const viewMH = document.getElementById('viewMyHistory');
  if(viewMH) viewMH.style.display = which==='myhistory' ? 'block':'none';
  const viewMyHazards = document.getElementById('viewMyHazards');
  if(viewMyHazards) viewMyHazards.style.display = which==='myhazards' ? 'block':'none';
  document.getElementById('viewSup').style.display = which==='sup' ? 'block':'none';
  const viewSupHazard = document.getElementById('viewSupHazard');
  if(viewSupHazard) viewSupHazard.style.display = which==='supHazard' ? 'block':'none';
  const viewUsers = document.getElementById('viewUsers');
  if(viewUsers) viewUsers.style.display = which==='users' ? 'block':'none';
  const viewEmp = document.getElementById('viewEmployees');
  if(viewEmp) viewEmp.style.display = which==='employees' ? 'block':'none';
  const viewTrnW = document.getElementById('viewTrainingWorker');
  if(viewTrnW) viewTrnW.style.display = which==='trainingWorker' ? 'block':'none';
  const viewTrnA = document.getElementById('viewTrainingAdmin');
  if(viewTrnA) viewTrnA.style.display = which==='trainingAdmin' ? 'block':'none';
  const viewDrlW = document.getElementById('viewDrillWorker');
  if(viewDrlW) viewDrlW.style.display = which==='drillWorker' ? 'block':'none';
  const viewDrlA = document.getElementById('viewDrillAdmin');
  if(viewDrlA) viewDrlA.style.display = which==='drillAdmin' ? 'block':'none';
  const viewPenW = document.getElementById('viewPenaltiesWorker');
  if(viewPenW) viewPenW.style.display = which==='penaltiesWorker' ? 'block':'none';
  const viewPenA = document.getElementById('viewPenaltiesAdmin');
  if(viewPenA) viewPenA.style.display = which==='penaltiesAdmin' ? 'block':'none';
  // Dashboard view
  const viewDash = document.getElementById('viewDashboard');
  if(viewDash) viewDash.style.display = which==='dashboard' ? 'block':'none';

  // Stop polling when leaving the relevant view
  if(which !== 'sup' && supervisorPollTimer){
    clearInterval(supervisorPollTimer);
    supervisorPollTimer = null;
  }
  if(which !== 'myhistory' && myHistoryPollTimer){
    clearInterval(myHistoryPollTimer);
    myHistoryPollTimer = null;
  }
  if(which !== 'myhazards' && window.myHazardsPollTimer){
    clearInterval(window.myHazardsPollTimer);
    window.myHazardsPollTimer = null;
  }
  if(which !== 'trainingAdmin' && window.trnAdminPollTimer){
    clearInterval(window.trnAdminPollTimer);
    window.trnAdminPollTimer = null;
  }
  if(which !== 'trainingWorker' && window.trnWorkerPollTimer){
    clearInterval(window.trnWorkerPollTimer);
    window.trnWorkerPollTimer = null;
  }
  if(which !== 'drillAdmin' && window.drlAdminPollTimer){
    clearInterval(window.drlAdminPollTimer);
    window.drlAdminPollTimer = null;
  }
  if(which !== 'drillWorker' && window.drlWorkerPollTimer){
    clearInterval(window.drlWorkerPollTimer);
    window.drlWorkerPollTimer = null;
  }

  if(which==='sup'){
    if(isLoggedIn){ showDashboard(); } else { renderLoginGate(); }
  }
  if(which==='myhistory'){
    renderMyHistory();
    if(!myHistoryPollTimer){
      myHistoryPollTimer = setInterval(pollMyHistory, 4000);
    }
  }
  if(which==='myhazards'){
    renderMyHazards();
    if(!window.myHazardsPollTimer){
      window.myHazardsPollTimer = setInterval(pollMyHazards, 4000);
    }
  }
  if(which==='hazardWorker'){
    initHazardWorker();
  }
  if(which==='users'){
    if(isLoggedIn && currentUserRole==='super_admin'){ renderUsersPanel(); }
    else { switchTab('sup'); }
  }
  if(which==='supHazard'){
    if(isLoggedIn){ renderSupHazard(); } else { switchTab('sup'); }
  }
  if(which==='employees'){
    if(isLoggedIn){ renderEmployeesPanel(); } else { switchTab('sup'); }
  }
  if(which==='trainingWorker'){
    if(currentEmployee){
      if (typeof window.populateTrainerInfo === 'function') {
        window.populateTrainerInfo();
        setTimeout(window.populateTrainerInfo, 150);
      }
      loadWorkerTraining();
      if(!window.trnWorkerPollTimer){
        window.trnWorkerPollTimer = setInterval(() => loadWorkerTraining(true), 10000);
      }
    }
  }
  if(which==='trainingAdmin'){
    if(isLoggedIn){
      // Pre-fill trainer fields immediately (before async fetch resolves)
      if (typeof window.populateTrainerInfo === 'function') {
        window.populateTrainerInfo();
        setTimeout(window.populateTrainerInfo, 150);
      }
      loadAdminTraining();
    } else { switchTab('sup'); }
  }
  if(which==='drillWorker'){
    if(currentEmployee){
      if (typeof window.populateTrainerInfo === 'function') {
        window.populateTrainerInfo();
        setTimeout(window.populateTrainerInfo, 150);
      }
      loadWorkerDrill();
      if(!window.drlWorkerPollTimer){
        window.drlWorkerPollTimer = setInterval(() => loadWorkerDrill(true), 10000);
      }
    }
  }
  if(which==='drillAdmin'){
    if(isLoggedIn){
      if (typeof window.populateTrainerInfo === 'function') {
        window.populateTrainerInfo();
        setTimeout(window.populateTrainerInfo, 150);
      }
      loadAdminDrill();
    } else { switchTab('sup'); }
  }
  if(which==='penaltiesWorker'){
    renderMyPenalties();
  }
  if(which==='penaltiesAdmin'){
    if(isLoggedIn){ renderPenaltiesAdmin(); } else { switchTab('sup'); }
  }
  // Dashboard
  if(which==='dashboard'){
    loadDashboard();
  }
}

// ---------- credentials & login (RBAC) ----------
// Legacy helper kept for backward-compat (unused in new flow)
async function loadCredentials(){ return null; }
async function ensureCredentials(){ return null; }

function renderLoginGate(){
  document.getElementById('supDashboard').style.display = 'none';
  document.getElementById('loginGate').innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <img class="logo-img" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALwAAACiCAYAAAD7ladAAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAAEnQAABJ0Ad5mH3gAAEgOSURBVHhe7b15cFzXeeb9u7d3dKOx7wBBgCRAcKe4a6UkSrRELZYtS3IiK86Mk8mkLGeScuJ4RlP2Z6emKqnUlF2eypRnkplJYsuKFyWmJVEytVOkJO7iDhAbQew7et/uPd8ffc/V7YsGSMlyHAn9VB0S3X3vWd7znPe85z2b8sKBl8Ttu2+lgAI+iXjt9Tf58pN/bH5W4vG4yHmigAI+YfjxT37G//et/waAav+xgAI+aXjkc5/lcw8/BAUNX8BSQSQSYd/9nykQvoClgx//5GcFwhewtFCw4QtYUigQvoAlhQLhC1hSKBC+gCWFAuELWFIoEL6AJYUC4QtYUigQvoAlhQLhC1hSKBC+gCWFAuELWFIoEL6AJYUC4QtYUigQvoAlhQLhC1hSKBC+gCWFAuELWFIoEL6AJYUC4QtYUigQvoAlhQLhC1hSKBC+gCWFAuELWFIoEL6AJYUC4QtYUigQvoAlhQLhC1hSKBC+gCWFAuELWFIoEL6AJYUC4QtYUigQvoAlhQLhC1hSKBC+gCWFAuELWFIoEL6AJYUC4QtYUigQvoAlhQLhC1hSKBC+gCWFAuELWFIoEL6AJYUC4QtYUliShBdC2L/6SJAvXvmd/Tf7548C9jiFEHm/+1XxUcSRD/ny+0Fgf9f+GUCJx+PzvzVgfUFRlJzf8sH6vPxbUZS87woh8n5vhz3Tuq4DoKrqdb1vh6ZpYORLVee3d5meTGeh5+ywPi//lp/l+9ay6Lo+L15d13E4HDnfWWFNAwtBZBrybyFETh7kOzJvH1Z29rq43jhkfmR57e/puk4mk0EIgdPpNGVgT48872K8L5+VZZOyEULklHdBwstIpKCEEKRSKZMwdsgEvV4vDocjJ7OJRML8rCgKLpcLp9OZN/NW2AtsFZyiKKTTadLpdM4zi0Gmrapq3kq3E0USJJPJLFhuCUVRcioLyJs/t9uN2+02ZWuVi67rJJPJnHIrioLH4zEJLSsQC+E1TTPT0TQNVVVxu904nU4zHhmXNd10Ok0mk8l5Bku8Mh47AZPJJLquz5OfFbqum/VsJbpM3/qurutomoamaWZ5MNJTVRWXy4XD4chbZ7K+MpkM8XjcjFtRFBwOh/mufG9RwstIZmZmGBwcZGZmhmQyaX/ULEQgEGD79u0Eg0FTSMlkknfeeYfp6WlSqRQlJSWsWbOGhoaGeRVih50Uwmh04XCYyclJRkdHmZmZmafN7BCG5igvL2fjxo0EAoEcIUhYNUU6nWZqaoqxsTEmJiYIh8M5z0rouk5RURHNzc00Nzfj9/vNCh4aGqKzs5PR0VGcTie6rrNu3TrWr1+fUyZZsalUirfffpvp6Wk0TUNRFNxuNxs3bqSmpga32w024sRiMQYHB7lw4QK6rhOPx2lpaWHt2rWUlJTkyE/TNBKJBJOTk4yNjTE1NUUsFrOUJgthNPzy8nLWrFlDZWWlWVeapvHWW28xPj6+aP3puo7X66W4uJiKigoqKiooKyszG5BV9lIGmUyGUCjEuXPnmJqaIpVK4fF4qK6uZu3atRQXF+ekKd+Lx+MMDAxw8uRJnE4nmqZRWlrK8uXLWblyJS6X69qEz2QyTE9P09XVxaFDh3juuecYGhoikUjYH0XTNNxuN+vWreOv/uqvWLVqFT6fD0VRmJyc5A//8A959913mZ6eZt26dXz961/nrrvuwufz2aPKgawoqU1SqRSjo6McPXqUw4cPc+LECQYGBkilUvZXc6BpGsXFxdx44438l//yX2hubsbr9ZrElJACTCQS9Pb2cujQIY4cOcK5c+cYGRnJeVYimUyyatUqHn/8cR599FFqampMMr722mv87//9v/n5z39OcXEx6XSar371q3zta1/LW+EzMzP8wR/8AUePHiUej+NwOCgtLeXrX/86e/fupaamJud5VVXp7+/nX/7lX/jOd75DKpUilUrxxBNP8OSTT9LS0mKmoWkac3NzXL58mddee40333yT7u7uvA1Zynv79u08+eST7Nq1i+LiYoQQxGIxfvu3f5s33ngDj8djfzUHbreburo61qxZw/bt29m5cyctLS0UFxfn9ISycWcyGQYHB/nOd77DCy+8wNjYGKWlpWzYsIGnnnqKdevWUVxcbL4n5dDd3c0zzzzDX/7lX1JcXEwymWTHjh088cQTfPrTn86p65walxEADA4O8k//9E/81//6X/nud7/LuXPnmJycJBwOzwvRaNTsvq1dpOwl5ubmiMfjZDKZvN32YlCMrgmgt7eX733ve/zn//yfefrppzl79ixTU1Pz8mMP0WiUVCpFOp02iWLvOeTfkUiEo0eP8sQTT/Ctb32LF154gZ6ennlxypBMJkmn0zm9jOwpGhsbWb16NbquEw6HicfjzM7OMjMzk0N4mZdQKGSWKRqNEg6HmZ2d5cqVK0QikZxuX5ZhamqKvr4+pqamCIVCtLa20tbWRllZGYqlex8eHuZf/uVf+NM//VO+973v8fbbbzMyMjKvPPnklQ/JZHLee/YwNTXFxYsX2b9/P9/+9rd54okn2L9/P1NTU2BruAAOh4Pa2loeeughli1bBsD09DSnTp3i2WefzVE6wlAq4XCYt956i1/+8pemnMvKyrjjjju45557TMUrYRLeWvmhUIif/OQn/NM//RMXLlwgFouRTqfRNA2Px0NpaSklJSX4/X6CwSDBYBCv1zvPhpVktdteCwkxH+SzV69e5dVXXzUFFovFSKVSOJ1OSktLFw3BYBC/34/P5zPHDlLY1rxEo1HOnDnDD37wAwYGBpidnTXLDhAMBnPiLSkpyTGPZBllnNXV1SxfvhwsjWBiYoKrV6+aaUokEgmGh4eJx+Om3aqqKplMhoGBAaampkin0znmQCqVMs0uTdPQdZ22tjZWrFhBUVGRaQtHo1Feeukl/tf/+l9cvHiR2dlZkskkmqbllV9xcbFpf9vNDwlhmD1CCHw+H8FgkOLiYoLBILW1tZSVleF0Okmn0yQSCaLRKFeuXOGZZ57h5ZdfZnZ2NkdeUmF4PB42bNjAPffcQ0dHBwDxeJz9+/dz/vx5s+FLpXn58mWOHj1KV1cXGHLeu3cvt956K8FgMEcRAcwzwlKpFEeOHOHVV1+ls7OTRCKB2+1m+/btrF27lrq6OtMUyWQyqMZgyuFwUFZWRm1tLS6Xy4xPuU4vx2LIZDL09fVx/PhxhoaGTFt227Zt3HrrrVRXV8MiDUmaXE1NTVRUVJh5xsiffKa3t5fXXnuNN954g0wmg6IoLFu2jM2bN7Nu3Tr8fn/OOxh5Ky4uZsOGDRQVFSEMjSWEwO/309zczIYNG7h48SLpdJqhoSG6urrYsGFDTjyhUIjz58+TTqdz5KVpGidOnOC+++6jo6MjxwyMxWL09/fT19eHoij4/X5WrFhBfX29WQe6rnP69GneeOMNLl26ZMa9bds2NmzYQENDA0VFRWacGGlmMhkaGhpobW015Z0PPp+Pe++9l/b2djMej8dDJpMhGo1y7tw5Tp48yeDgIACnT5+moaGBxsZGdu3ahcPm4FBVlbKyMu655x6uXLlCb28vyWSSgYEBXnvtNRoaGti0aRMA4+PjPPfcc7z99tuEw2HcbjebN29m7969tLW1QR5OmIRXFMW081555RW6u7uJx+N4vV7q6+t5/PHHueOOO6irq5s3cLD+/auS2wqrJhseHmZgYACMSiwuLmbPnj185StfobS0dF7BrBAWTS7JKD/LPCcSCc6ePctrr73G0NAQTqeThoYG9uzZw6OPPsrNN98MFvvWrvVknMIy0FZVlfr6eu644w76+vpIp9OMjo7S1dVFLBajqKjIfHZ6epozZ86YhJeD3HQ6TWdnp2nWBINBM+2pqSm6u7vp7+/H4XBQVVXF8uXLqaysRFVVdF0nFApx6NAhLl68iK7r+Hw+GhoaePjhh9m3bx8tLS15y2Itp8xjPng8Hvbu3ctdd91FZWWlWX75zuHDh3n66af5xS9+QSQSYW5ujmPHjtHc3MzGjRtzbHKZD0VRWLduHbfccgunTp3i5MmTALz++ussX76cZcuWEQwGOXz4MAcOHKCrqwu3201jYyOPPPIIN9xwAyUlJXnznMPOZDJpaqBwOIymaQSDQW6//XY+/elP09TUlEN2q0AUQ5PbhferQGY4nU4Ti8WIx+MIw51WW1tLY2MjwWAQ8uTFni8Z5LMyrzKNaDTKhQsXOHv2rJnmbbfdxmOPPcaNN944r1z2NGSQXaj8XFFRwY4dO0xyT09P09/fz/j4uPmsNE36+vpMs7G2tpba2lrTju7u7mZ4eBgscrly5QpXrlwhHA7jcDhobGw0yYDR+/T393P27FlGRkbIGL7uz372s+zbt48VK1bMy781XE99KoYnScpWNnoM5bJ582YefvhhtmzZgmLIu7Ozk8OHDzM3N5fzrD2tXbt28bnPfY5AIICiKFy+fJl33nmHM2fOMDU1xQ9/+ENTCZaXl3PrrbfyqU99itraWjMue5w5hI/H4wwODjIyMmJ6PmpqatizZw8ej2eeQMhT8b8uOByOnMbW09NDV1eXOQC6HshBn33wh9E9TkxMEI/HTTeWNA/kuESxjEkWgzV+n89HS0sLK1euJBAIMD09TU9PDwMDA2iGd2Jubo6rV68yMTGBpmksW7aMm2++mZ07d5pxnjlzhr6+PrBU4unTp+np6QHA5XKxfv16Ghoa8Hg8Zh6GhoYYGBhgbm7OfG7r1q2Ul5fnxGWFLKesU5FnIisfVFWdN2bz+/20trZy44034vF4cDqdOJ1Okskk4+PjaMa8gZVPGA2ntraW3bt389hjj5nmZE9PDwcOHOBnP/sZR48eJRQKAdDY2MjnPvc506ReqK5ybPhEIsHIyIiZEYfDQSgU4vjx44RCIXRjgmAheL1ebrvtNioqKnLs+F8FmqZRVFREQ0MDDQ0NnDhxwvS1HjhwgKmpKVauXInH4zEH1g6HA6/Xi9/vp7S0lIaGBpqamkxbH0tDlRgfH2dmZsZsBC6Xi+7ubl544QUCgYD5XD54PB5WrVpFW1sbRUVFOT2J0+mkrKyMDRs20N/fTzgcJhQK0dvbyw033IDb7WZubs7U1plMhpqaGrZu3Uo8Hufpp58GoLOzk/7+flKpFG63G03TOHfunKnhXC4X69atM70z0hwaHx8nFouZhE2n0xw7dozp6WlzUJkPiqLg9XrZsmULjY2N13RBStgbkKIo+Hw+KisrUQyzWRi+85GREdauXTtvjCDz73Q6aW5u5v777+fy5cucPn2agYEBnnvuOYqKiohGowCsW7eOBx54gBtuuMFUzAvBJLw0FUKhEIlEwtQ+U1NTvPjiixw5csTUGvngcrmora1l7dq1lJaWfiSEl6R0Op20tbWxc+dOjhw5YnaFvb29TExMUF1djcvlMt2eqjFD6PF4CAQClJeXs379eu655x5WrVplmjdSc2PYw1JbYGir48eP09XVNU9L2FFdXc2+fftobm42G4cUusPhIBgM0tHRweuvv87Q0BChUIgLFy4QDofx+XzMzc0xOjpK2PCJNzQ00NbWxvT0NF6vl2QyaT4zNTVFdXU1w8PDjI6OEolEwEJ4q4mn6zozMzOkUimzzOl0mpdeesn0q1vdyFa4XC5aWlpoaGigrq4OZRE7/lpwOp0Eg0GKiooIh8PoFnf1Qj2HTCsQCLBx40buu+8+RkdHuXz5cs5cUF1dHbt37+buu++mpKTEEkN+5LgldV03MyCJHY/HOXPmDG+99RZvv/02R48ezRuOHTvG2bNnSSQSCxbiw0AKuqGhgVtuuYW77rqLtrY2gsEgwpis6ezs5Ny5c1y6dImuri4uXbrEmTNnOHbsGG+88QbPPvss/+///T9+9rOfMTo6atrFMmCMX6zaTtd1uru7OX78+Lyy2sOZM2cYGxszG5u1/FLDtbW1UV1djcfjYW5ujvfee4/JyUlisRhjY2MMDw+jKArFxcU0NTVRU1NDZWUlq1atMk25kZERent7SafTnD9/3jRTfD4fy5Yto7m52fQ7S7mlUikzXw6Hg0wmw9mzZzl8+DBHjhyZVxZrfV6+fJlIJPKhiS4hFZB1AkjybSFIhaEaXpu77rqLdevWUVpaajZej8fD1q1buf3221m9erU9irwwCa8Y60zsLiqn4aetqqqisrLSDPbPwWDQzIgU+EcFaWZ0dHTwZ3/2Z3zpS19i+/btJjFqamqora01/5Zk8fv95lT2lStX+Nu//VtOnDhhulpVi3vS5/OZXavUfEVFRVRUVMwrqz2UlJTkdKXyf1mpTqeTFStW0NbWRnl5OeFwmIsXLzIwMGAOYnt6eswuvLm5mZKSEmpra83JE4zJwIsXL5JMJjl//rzZI9XW1vKpT30Kr9drSCwLVVUJBAJmgxHGOpVgMEhFRcW8clhDeXn5NXu264U0r6wEdzgc8yaFrFAsg2aHw0F7ezt33HEHK1euNBux9KKtX78+Z3y3GJxYug+Xy2USF2OU39bWxr//9/+e9evXkzZmU10uFz6fj0gkklMIt9vN8uXLTeJcqxuUZhMWUsu/5WfdsojN6/XS2tpKQ0MD9913n2l6pYw1F2nDpSeEYGxsjB/84Ae88sorTE5OmnZ/b28vW7dupaKiAgxSAOYkEpbG/9u//dvcfvvtVFRUmPZiPkgPiXxfxikrTQhBdXU1bW1t1NTUMDIyQjqd5r333qO2tpahoSGT8FVVVTQ1NVFSUoLb7Wbr1q2meRgOhxkeHmZ4eNjUvgCVlZXcfPPN8xqdw+GgoqIix/4uLi7mqaeeorm5eZ7tbIVimJJr1qzB6/UuWo9WWJ+TedF1nUQiQTgcNk0oqaElR+zEt34vf2tpaTGXVzgNt3FHRwe1tbWmeXqtfKpYCObxeKisrKShocHUFk6nk4qKCtasWcPWrVvZuXMnW7duZcOGDeb6CBm2bNlC0LJwDCPj1orIZDKmHSdbsMyDNS/ye9lrSDidTvx+P7W1tTQ3N9PS0kJbW5vpCVmxYgUrVqxg8+bNfPGLX6S9vR2Hw2GOP6QNbbdda2trTX++nFaXi8I2bdqUU0572LZtG8uWLZs3sLOSz+VysXr1ahobG8EYPJ46dYqzZ88yNjZGJpMxxyqVlZXmGKSpqYm2tjYCgQDxeJyrV6/y7rvvcvXqVRKJBBUVFaxatYqGhoYcuWPIqqqqyuy1M8ZEYUlJCevWrZtXDmvYsWMHW7Zsoby8fF68C0HWoZWkGM6QiYkJMpkMDofDdCrU1NQsSlQZj4zLZax8lHDkmQW2f7Yjx6TxeDw0NjbmEH58fJzXXnuNeDxOUVERJSUlBI2p+pKSkpwQDAZNbSQLoKoqfr/f7HLkFLN1PY1im42VDcFKfntBHIab0uVy4TaWwrrdbvNzcXEx7e3tVFRU4DQmcYQQ5joRawMDqKiooK6uzpyO1nWdvr4+hoaGwOgBFgvSO5Ov4jDK2NbWRn19PRiE7+zs5LXXXjOnxZ1OJ+3t7aad6na7qaqqYtOmTZSUlBAOh7l06RIHDx6kr6+PRCJBfX09a9asoaqqKkeGWNam1NTUUFRUhK7rpFIp3nrrLaLRKMFgcF457MHlci1YJjvy1ZNcyfjuu++achdC4Ha7zVnvfO9dL2S9Xi8cTz311DfND0brkzZlKBQyffMNxnJeYdi3qVSKZDJJMpkkkUgQj8dNk0JCMVY4dnZ20tXVRSgUMgtWX19vElHGIUPKWHdvbc1S887NzZFMJonH44uGUChET08Pr7zyCoODg2jG8oItW7awbds2kyDWBjU5OcnVq1cZHBxEVVWSyaSplYLBIJqmEY/HzXLLEI/H0Yx1KbJ81sYs4fP5OH/+PMePHzffnZiYYGxsjGQySSAQ4D/8h/9gmoXWfJ05c8b05IyOjjIxMUEqlWLDhg3cfffdrF27dp4mVoye5cqVK1y9epXp6WmEEIyMjFBTU4PP5zPta3t9yrVKGLyQ9ZpOp3n22WdN/7/X6+WWW26htrYWVVXNCUJZB2fOnOGFF17gpZdeIhqNomkaJSUlbNmyhX379uUMsq+FgYEBjh07xqVLl3A6neZ8Rb7ebSHkEF4xZs1KSko4ffo0Y2NjplY8duwYs7OzhMNhZmZmGBkZYXBwkMHBQfr7+83FViWG7SkzIOM8deoU4+PjJJNJBgcHuXr1KnFj9eDg4KDph75y5Qqjo6NkMhkqjSlyxdjsMTQ0xDvvvMPVq1dznreH/v5+Ll68yE9/+lOOHTtGOBxGNWzGvXv3smnTJnNQphjuO4/Hg8fjIRaLcerUKVRVZWpqipMnT3Lx4kVKSkrMlYtXr17NKf/AwAC6ruft4awV6XA4GBgYoKuryzRjIpEIiUQCh8NBTU0Nf/Inf0J5ebmpCVVVJRqNmuWOx+NEo1GzIe7YsYM9e/aYPYcViuEhUlWVwcFBent7wVi3c+7cOXO599TUFCMjIwwNDZnl6e/vZ2pqynQnLkR4t9vNsmXLzIbU19dn1sO5c+f4+7//e37wgx8QjUbNXv6GG27gwQcfZNOmTTlmybVIf+XKFY4ePUpnZ+eHJrwTIyFZQS6Xi02bNnH//fczNzfH6dOnEUIwNTXFz372M/bv3z/PdhKG/b9ixQr+8i//kvb2drPiXS4XGzZsYNeuXYyMjHDlyhVUVeXYsWOcOXMmb0YbGxvZt28fjY2N5qL/TCbD6dOn+aM/+iP743khhCBp7MzB6Pp8Ph8rVqzIGZgrluXHy5YtY8+ePfT19fGLX/zCfLezs5OnnnoqJ6/W8jc0NPD4449TX19PkWUBWT6sWbOGm266ibNnz+IyZgQ1TaOmpoZ77713nsYTQrBs2TJWrFhBd3d3zoRRc3MzHR0d1NXVmT2VFbJOt2zZwp133snly5c5c+YMwli1+fzzz3Pw4MG89ekyZm7/03/6T+zcuXOe9w7D9EylUvyf//N/zN5NpokRT9yy+jNlbADasGEDW7ZsMb1P1wvpnflVkFMrstBut5s77riDxx9/nNtuuw0MwkSjUWZnZ5mammJyctIMU1NTTE9PMzc3R8ZYryGhqirFxcV85jOf4ZFHHqGjo4O0sWR0bm6O6enpeSFsrDOXxJH5SqVS855dKMzMzJjdsmZM13/xi1/khhtuIBAI5ORRwuv10tHRwe/+7u/ywAMPmB6BdDptllsGa/nnLOv9F4JMr6amhtbWVpyG1yhtzA6XGhsdpBaUcDgcVFdXU19fnzNZJBtCS0sLJYtMuOjGzqNbb72V3//932fPnj14vV40TSMWiy1an6FQiLRlTbxdZsIwM0OhENPT0+Z71jpIGNs7pSnz+OOP89BDD9HU1GTmj+vQ7hLWvNi5dj0wdzwJ22L8eDzO0NAQZ8+e5ciRI/T29jI3N0faMjmjGdPEGI2koaGBr33ta6xcuTKn9erG1rPu7m7eeecdjh49ak5552u19fX13HbbbXzhC1/A7/fjcDiIxWK89tprfOtb3zJ7j4WgWjw70t+8Zs0a9uzZw4oVK3BZ9rVaIQy/uTRr3n77bS5fvszExASzs7M55bWirq6O+++/n/vuu4+Kigr0BVZUSqXx7rvv8j/+x/9g2tjKp6oq69ev5/d///dZs2bNPHehruv86Ec/4sUXXzTNknQ6zd69e3nooYfYtGlT3vRknSqGSTg+Ps7p06d555136O3tZWpqyhx/2OEyZlp/7/d+j82bN5v2fjwe5xvf+AZvv/22/RXI41Xz+/2UlZVRWVlJU1MTt99+O6tWrTIXhMny2+siH9566y1++tOf8vbbb+Pz+Vi1ahX/8T/+x7yKYiGYhJekkwnLz5qmMTs7y6lTp5icnDQHMvYWphqTHLfddhuVlZU5pJQCVRSFSCRCf38/V65cMQegdoH7/X6WL1/Oli1bcBqbgJPJJD09Pbz66qs5bs58UI3ltRhkbGpqor6+npKSEnRjVJ9PyHYZzM7OMjAwwMDAgOlWy0d4v99PR0eHuSZcX+BkAN2YUh8fH+fkyZPmYjGHw0FDQwM33ngjgUBgXr6EEFy4cIGuri4mJiYQhrm2ceNGOjo6qKqqylFWVliViTQ5ZmZmuHTpEkNDQ0Qikbw9k2r0zDt27KCxsRGHsW49lUrx6quvmuvb7bDKHsO7VVtbS11dnemosMrFqhzs8rLj8uXLnD17luHhYbzGftmbbrqJ+vr6vGXPhxwNb4cUVj47+4PAGve1CmWH1LrKr7iRRMajGpNZdiHby/9h8ilDPrLLZ1gk7oV+l1rQ/j1GHcny2OtJltka70LxLAZr2expfFBoxmSjzINisfs/aL4kFntf2MY2ORpeVpb8WwqogAI+rpANymxg8XhcSE0uW55sMfK7Agr4uMHaK1l7NSUejwsrwcUiS0YLKODjBtVYJTqP8MI4j2V8fJzR0dF5tk8BBXycoKoqwWCQZcuW5SxLVuLxuJDutpGREQ4ePMiLL774kQxQCijgNwWfz8fGjRv5rd/6LSoqKkwu5wxa+/r6+MlPfsLf/M3fmEtPCyjg44j6+nruvfdevvrVry5O+GeeeYbvfe976MZhmAUU8HFDJpOhrq6OT33qU3zlK1/JWYZs2vC6rjM1NcWJEyc4cuQIirEBoIACPm7QjLNE29vbufXWW83ZekVR3ndLSu9MIpHIWT9RQAEfR6jGgjV5vId0Tc5zS9od9QXkYqnI5uNeTrvCnueWlA/JSSjVstbE/jKWhmGfpv+wgrLHtRjsv8s08+VTxnm9M8YyDmt8Is8Ehv1Z62c7rLKSebUuccB4V35nT0f+Lv+Xz1phf34hWPOYL658ZZF5l8iZyFlA7hL2+K63PqSc5N/29/KlaZWzYuORmV/70gLrg9cjRGvC1/P8YpBx5YvH2hAXQr73ZaVyjXcXQz5i5EvLDmueraSRhLHKTqYhDHewvQx2LJbu9eJ6y2AnkP3/D4LrSZM8z9k/Lwa7vKzv5Ew86caex5GRkXkrGBeCw+HA7/cTCARydsaI69T0whg7xGIxQqEQoVDIXCwlUVxcbMZvXXZsJ4xibCkMh8NMT0+bv5WUlJi3TywG+V4kEjFX9QUCAUqMPav5yqQoCjMzM8zNzZEy9mxmMhnKy8spKSkx9wYrBsHlmnO7Q8Dn81FdXW2uDrWmI8upaZp5coF11aFi7EeWqxEXgzA2ZcRiMSKRiLn6NR+cxgb+oqIisxEKY237zMwMs7Oz9lfyQjEcIB6Ph2AwiM/nu+Ycjyxz2jhXdHZ29rrHlslkkvLycqqrq98frEpZWdfSyKWrzz33HFNTU9e1xMDpdFJZWcny5ctpbW01NwzL5aQyMZlRmbAkxvT0NENDQ1y9epW+vj7Gx8fJGNvXJMrLy2lsbKSlpYWWlhbz7HEZr2K5rGtmZoazZ8/y+uuvm+/v2LGDm2+++ZpH5g0NDXHy5EneffddM/6mpiZuuOEGNm3aRMY4QtvaGNPpNC+++CKXLl0ibtwxJPd5rlmzxtwULkn8yiuv8Oqrr85rfM3Nzezbty/vKQGyjPIApxdffNHc84rRY5SVlfE7v/M7OafxYjEhMIgwNTVFT08PPT095lma+aCqKuXl5dx+++20traaJzLoxn6BY8eOcezYMRJ5boSxQzUGkIFAgJUrV5o8CRonIefjhq7rTBtn9vT29jIwMEDiOg/5ikaj3Hzzzdxxxx3mFkcZN/F4XMRiMRGLxcTk5KQ4fPiw2L17twgGgwIQiqIIYNFQVlYmbrzxRvHnf/7n4uDBg2JkZEREo1ERDodFJBIR0WjU/D8Wi4l4PC4ikYjo7e0V//AP/yC+8IUviA0bNgiXyzUvbhmam5vFI488Ir7//e+Lzs5OMTMzIyKRiIhEImb+4/G4uHTpkvj2t78tVFU13/3yl78sBgYGRDweXzR0d3eLv/7rvxbl5eXm+6tXrxbf/OY3RSgUEuFwWITDYbMc4XBYXL58Wdx+++0CQ1Yej0fcdtttYv/+/WJiYsKMW+bvqaeeMvNlle2uXbvEoUOHxNzc3Lx8yXDixAnxJ3/yJ+a78n1FUURDQ4Po7e2d947M89TUlDh9+rT47ne/K+6//35RWVk5T8bW4Ha7xZYtW8Q///M/i8nJyZwyDAwMiG9+85uioaFh3nsLBUVRhNvtFrt27RJ//ud/Ll566SUxPT09jxsyDA0NiR/96EfiscceE83NzcLpdM6Lc7HwR3/0R2J4eDgn3/F4XOQ1aj3GrXFO46TXa2Fubo4TJ07w/e9/n69//eucOnXK1NKyBauWU8kymQwTExP89Kc/5X/+z//Js88+y8WLFxftUYaGhnjuuef4i7/4C5555hnz6GirtpXweDzmERAfBPK02s9//vPmHs6enh4OHTpEd3c3wmZfR6NRXnjhBfPSMqdxZs7v/d7vsWnTJtMlRh7bU7HcKAgwMzPD8ePH85oYUgP29vZy5swZ81235XgS62yiHQ6HgwsXLvD973+fb3zjG7z88ss5Jt9CsI8lrHDYTnO+FoRxdunJkyf5m7/5G/77f//vXLp0Kac3l+PIeDzOL37xC77//e+zf/9+hoaGFuVGPth7Yol5OVYs9o6maVRUVLB+/Xpzf6e9S5mZmaGrq4urV68SjUa5ePEihw4doq6ujvb2djMu2a3rxiH9zz33HD//+c+5cOECSeNmwLa2Njo6Oli1ahUVFRXEYjF6eno4f/48fX19hI3b+/7xH/+R8vJy7rnnnry79bF5Eq4XDoeD5cuX88gjj3Dw4EHztN7u7m5++MMf8gd/8AfU1NTgdDqZm5vj6NGj/OAHP+Dq1atomkZjYyP3338/27dvp7S09JrpW38fGRnhwIEDPPzww/NML0VRzPPrT548aZqDknALVS5Gmfr7+3n++efZv3+/aXdXVFSwbNkyGvLcACLfq6mpMe3gfLDmf+3atbS2tlJcXDyPnMlkkrGxMc6ePYs85uTs2bP8wz/8A9/4xjdyzLu0cSLb888/z5kzZ0ilUijGBQnLly/Pm1c7kskk7e3t9q8hH+GtEEJQUVHB3r172bhxI07jHBkrwuEwP/rRj8yjKqLGPUnbtm1j5cqVprCEMTBOJpNcvXqVn//855w7d45wOGxu6fvMZz7D5s2baW5upti4jW10dJTjx49z8OBBjh07RjQapbu7mwMHDtDU1ERDQ4OpAT8K+P1+2tvb+cxnPsOzzz5Lb28v4+PjHDx4kF27dnHjjTfi9/sZGBjg4MGDXLp0iUgkQnl5OVu2bOHBBx+kqqrqA2k/VVWJx+NcunSJ4eFhAoGAebydJNXQ0BD9/f3MzMzkEH0xyIZx/Phx3nnnHYaGhlCMAe4dd9zBLbfcYt5oaIdiHK/S2NiI0ziPaLH0tmzZYh4XYnd4JBIJU3l0dXURiUSYmpri8OHDzM7OmtsaFcPpcPnyZXp7e817oPx+P5/97GdZv379vDFKPqTTaRqMc/Lt3LhmrQQCAdauXcvOnTvnCUZG1tXVxcsvv2yeZjs6OmqeQSO9GxKyFzh58iThcBghBGVlZdx55508/PDDNDU15RxZ19LSQmNjI7qum1pCVVXeffddbrrpJnbv3j1vAPhhIfNZVFTEY489xvj4OJFIhOHhYXp7e/nlL39pXilz7tw5Xn/9dRLGwayrV6/mjjvuYNOmTWZ+rkUS3TjLRjMOeIpEIly4cIG6ujpTBjKOnp4eRkZGUAyPR2lp6YL7USV0Y7nI0aNHzc3fLpeLtWvX8tBDD7F7927Kysrsr+XATt6FIPcgt7a25nwvDFNmZGSEU6dOMTw8TCQSIWlciBA2bppxOBzoxqFQExMT5qkVGB6sO++8k7Vr115Tw9sJbkf+fnABSC0tg9T21dXVNDc3m89pxi1r0h61mhczMzOcPHmStHEjnTztYO/evfPILtNoampi+/btbNy4EcWwX2dmZhgaGmJ6enpRUn0QyPScxhmP9957r0ngWCzGP//zP3P+/HnOnj3LoUOHOHfuHOl0mqqqKnbt2mXeHCfzs1i+JBHa29tpamoyP58+fZpp44QwjDgymQy9vb2Mjo6CMUbZuHEjfr9/UULK9+R5Nhjkeeyxx9i6dSslJSVoxu1/C4UPAztPpJaWx4VjMcMkNxRjrJdOp0ka5wlJfjiNI00047K1fEH+bg358v+BCC8zJoMc1MiTyKywFkZ+VhTFPKsykUiQyWSoqqpiw4YNtLS05NiKknwyraamJvMaQ4mxsTGuXLmS892vApmWFNS2bdvYs2cPHR0dprZ85pln+M53vsPzzz9vvnf33Xezb98+WltbcxTB9WDXrl3s3LmTqqoq0sa578PDw6a7T9M0xsbG6OzsZGxsLOcuIzmuWgiapjEyMsLo6ChR4/Rjh8NBXV0dqqoSNu6BnZmZWTDkG0RfC1aOqMbVm2NjYzknHruNczNLSkpME81hHKFdVVWV4wYNh8O89NJLXLhwwTw9WYahoSGGhoYYHR0lZNxS4zCOjJR1KTnI9Zg0unEWSSgUMgeX1t8GBga4cOECoVAIl3ELR2lpKRUVFfh8PjTbJFI0GqWvr4+MceSF1+s1zy2xEl4KSzdG7kHjTHOpBYRxK7Q0oz4KWDWSruuUlpZy0003MTAwYJ6SduzYMdLpNNFoFJfLRXt7O3fffTdr1qwxxzgLDSDzQZ7W3N3dzZEjR+jr66O/v5+Ojg6KiorIZDJ0d3fT1dXF9PQ0DQ0NrF27lvr6etN00o3jP2SvgKUHmZiYMA9DUlUVTdN4/vnnOX36NG63O+cdCSnziooK80x2uzkroRgmVl9fH0ePHmVwcJC07RqdcDjM+fPnOXHiBHHjhvHy8nJ27NiB3+/PUTJut5uWlhYqKiro7e0lY5xj+uMf/5izZ8/meN9kmd1ut3n+zYoVK1i/fj3Lli3D7/ebZZGkvybhp6enefPNN7ly5cq8gVgmk6Grq4t3332XtHFuPMCqVavMG/+s2k4xumepbTBsSr9xabC1JVrJhyEIOcsqKy6TyZjCzVdxHxQyLfm/PIzoxhtv5NVXX+Xy5cvMzs6apK6srOS+++5jw4YNBG23CV4vVFWltraWlpYWDh06xNjYGIODg8zOzlJTU0MymaSrq8u8d6uiooK2tjactoNbFzJtksa5P7LHTSQSHDp0KGfbmx3CcL+uXr3a7H0Xg2pcDzQyMmKey2NFwtg6OjExQTqdJhAIsG7dOu6+++55DcllHCu+e/dupqenzftte3t7mZyczDmTSJbZ6XTi9XopKiqiurqajo4O7r33Xm655ZZ547v8JbZAnkH4f//v/+Vv//Zvc8Lf/d3f8eMf/5jOzk4UY/S/cuVKtm/fTnNzc07FL0QCWRH5CGslvGI5U0UG2SjI4y79MMiXRnFxMevWrePBBx/M8SYEg0G2bNnC/fffP++ytA8CIQSVlZW0tLQQCASIRqOmZ0geY3fq1ClmZmYIBAI0NTWxcuVKFNsVmQu5Dq3lwfBgRIz7UmdmZnKOxpNhZmbG7NGvV66dnZ28/PLL7N+/n+eeey4nvPLKK5w/f55MJkNFRQU7d+7kvvvuY9euXSYhpewdxqFU9913H/fffz9btmyhpaWF5uZm87BapzHn4TEOwJUmk3SJP/300xw4cID+/v559XFNwicSCYaGhujr6zOnpGXo7+8nmUziMa6jb25u5oknnuDmm2+mqqoKLBpPklM1ppllRlKpFNFolFgslkN6WYmyS0qlUmbXnDEuLxMWe9lesF8V1jzLo/TkFZaaplFXV8d9991He3s7Pp/PbJwfNB9Op5Oamhra2tpobm7G6XRy7tw583jxgYEB3nzzTaampqiqqmL16tWsXLkyp7dVjUnCfGm7jat9ZI/odru54YYb2L17N3feeSe7d+/OG2699Vba2tooLi7OG68dPp/PXLNUWlpKWVkZJSUlFBcX4/V6cRj3S61du5bPf/7zPProo5SVleUoLQlFUdi4cSN/+Id/yLe+9S3+3b/7dzz66KN8+tOf5oEHHpgXbr75ZlPBulwuIpEIx48f5/Dhw/PivqZJU1xcTFtbG7XGJbmZPG6w6upqVq1axdq1a9mxYwdlZWUmIe2aJ2jcaCe7qkQiwezsLHNzc+YaHAnZQBRFIRQKMT4+bhYqk8mY3RgfcqLpWpCkl3+XGBcExONxPMblwXKA9GGRSqXw+XzU19dTVVVFd3c3nZ2ddHd3m4Py2dlZMpkMJSUl1NXV4fV6r1lWxbCtZZ4lfD4fv/Vbv8W6deuu6eJzWK7MkQ16Idx1111s27aN8vJyUqkUXq+XSCRCX18fx44d4+jRowghOH/+PAcOHKCoqIg777wTl8tlmojW+IUxhti1axdbt25FN65MtRMYww2+f/9+vv3tb5vfyXP05+bmKCkpMeO+poavr6/n85//PE8++SR/+qd/yte+9rV54ctf/jKPPPIIN910ExXGjRsSsgXLUFVVxe7du03bbWZmhp6eHgYHB/M2JpnR0dHReRfzlpaWUltbm/O87OqspEilUsRisZznPigUm/YWlrM1ZeP+MJBxVFRUcMMNN+ByuUin02YXff78eXMVZktLi+mavR44jBtASktLcwa409PT5hEWi4WGhoa8Z13mw8qVK7nlllu45557uP/++9m7dy8PPvggX/jCF/jd3/1d89TimZkZXn/9dZ5++mmOHj2KZrnnywrZwDzG1aOBQMDsOcrLy81QVlZG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" alt="Elsewedy Polymers">
        <h2>دخول المشرف</h2>
        <p>سجّل الدخول للاطلاع على الطلبات والموافقة عليها</p>
        <div class="field">
          <label>اسم المستخدم</label>
          <input id="loginUser" type="text" placeholder="اسم المستخدم" autocomplete="username">
        </div>
        <div class="field">
          <label>الكود الوظيفي (empCode)</label>
          <input id="loginEmpCode" type="text" placeholder="أدخل الكود الوظيفي (مثال: EMP001)" autocomplete="off" oninput="this.value=this.value.toUpperCase()">
        </div>
        <div class="field">
          <label>كلمة المرور</label>
          <input id="loginPass" type="password" placeholder="كلمة المرور" autocomplete="current-password">
        </div>
        <button class="submit-btn" onclick="attemptLogin()">دخول</button>
        <div class="login-error" id="loginErr">اسم المستخدم أو كلمة المرور غير صحيحة</div>
      </div>
    </div>
  `;
}

async function attemptLogin(){
  // Request permission explicitly on button click for mobile browsers
  if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
    Notification.requestPermission();
  }
  const user = document.getElementById('loginUser').value.trim();
  const pass = document.getElementById('loginPass').value;
  const empCode = document.getElementById('loginEmpCode') ? document.getElementById('loginEmpCode').value.trim() : '';
  if(!user || !pass || !empCode){
    document.getElementById('loginErr').classList.add('show');
    return;
  }
  try{
    const res = await fetch('/api/auth/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({username: user, password: pass, empCode: empCode})
    });
    if(!res.ok){
      document.getElementById('loginErr').classList.add('show');
      return;
    }
    const data = await res.json();
    if(data.token) saveToken(data.token);
    const mustChangePassword = data.mustChangePassword === true;
    isLoggedIn      = true;
    currentUsername = data.user.username;
    currentUserName = data.user.name || data.user.username;
    currentUserRole = data.user.role;
    currentUserDept = data.user.department || '';
    if ((currentUserRole === 'dept_admin' && currentUserDept.toUpperCase() === 'HSE') || currentUsername === 'hse_admin') {
      currentUserRole = 'hse_admin';
      currentUserDept = '';
    }
    // ── Set RBAC session role and rebuild UI ──────────────────
    sessionRole = 'supervisor';
    showUserBadge();
    applyRbacUI();
    
    try {
      startNotificationPolling();
    } catch (err) {
      console.warn('Non-critical notification setup error:', err);
    }
    
    // Switch to supervisor view — دايماً افتراضي على لوحة التحكم لكل أدمن بما فيهم الصيانة
    switchTab('dashboard'); // 📊 Default landing: Dashboard

    // ── إجبار تغيير كلمة المرور الافتراضية قبل السماح بأي استخدام فعلي ──
    // (11 سبتمبر 2026 — يظهر فقط لحسابات ما زالت تستخدم admin123/123456)
    if (mustChangePassword) {
      showForcePasswordChangeModal();
    }
  } catch(e){
    document.getElementById('loginErr').classList.add('show');
  }
}

/**
 * showForcePasswordChangeModal — نافذة إجبارية (لا يمكن إغلاقها بدون تغيير
 * كلمة المرور) تظهر فورًا بعد تسجيل دخول أي حساب ما زال يستخدم كلمة مرور
 * افتراضية معروفة (admin123 / 123456). تستدعي /api/auth/change-password
 * الذي أُضيف في السيرفر خصيصًا لهذا الغرض.
 */
function showForcePasswordChangeModal() {
  if (document.getElementById('forcePwOverlay')) return; // already shown
  const overlay = document.createElement('div');
  overlay.id = 'forcePwOverlay';
  overlay.className = 'force-pw-overlay';
  overlay.innerHTML = `
    <div class="force-pw-card">
      <h3>🔒 يجب تغيير كلمة المرور</h3>
      <p>حسابك ما زال يستخدم كلمة مرور افتراضية معروفة. لأسباب أمنية، يجب تعيين كلمة مرور خاصة بك قبل المتابعة.</p>
      <input type="password" id="forcePwCurrent" placeholder="كلمة المرور الحالية" autocomplete="current-password" />
      <input type="password" id="forcePwNew" placeholder="كلمة المرور الجديدة (8 أحرف على الأقل)" autocomplete="new-password" />
      <input type="password" id="forcePwConfirm" placeholder="تأكيد كلمة المرور الجديدة" autocomplete="new-password" />
      <div class="force-pw-error" id="forcePwError"></div>
      <button class="btn btn-primary btn-block" id="forcePwSubmit" type="button">تغيير كلمة المرور والمتابعة</button>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('forcePwSubmit').addEventListener('click', async () => {
    const btn = document.getElementById('forcePwSubmit');
    const errEl = document.getElementById('forcePwError');
    errEl.style.display = 'none';
    const currentPassword = document.getElementById('forcePwCurrent').value;
    const newPassword     = document.getElementById('forcePwNew').value;
    const confirmPassword = document.getElementById('forcePwConfirm').value;

    if (!currentPassword || !newPassword || !confirmPassword) {
      errEl.textContent = 'جميع الحقول مطلوبة'; errEl.style.display = 'block'; return;
    }
    if (newPassword.length < 8) {
      errEl.textContent = 'كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف'; errEl.style.display = 'block'; return;
    }
    if (newPassword !== confirmPassword) {
      errEl.textContent = 'كلمة المرور الجديدة وتأكيدها غير متطابقين'; errEl.style.display = 'block'; return;
    }

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spinner"></span>';
    try {
      const res = await authFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast('تم تغيير كلمة المرور بنجاح ✓', 'success');
        overlay.remove();
      } else {
        errEl.textContent = data.error || 'فشل تغيير كلمة المرور'; errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = originalText;
      }
    } catch (e) {
      errEl.textContent = 'خطأ في الاتصال بالسيرفر'; errEl.style.display = 'block';
      btn.disabled = false; btn.textContent = originalText;
    }
  });
}

function showUserBadge(){
  const supArea    = document.getElementById('supUserProfileChip');
  const umArea     = document.getElementById('umUserProfileChip');
  const emArea     = document.getElementById('emUserProfileChip');
  const globalBar  = document.getElementById('globalUserBar');
  const globalArea = document.getElementById('globalUserProfileChip');
  
  const roleLabels = { 
    super_admin: 'مدير النظام (Super Admin)', 
    hse_admin: 'مشرف سلامة (HSE Admin)', 
    dept_admin: 'أدمن قسم / منطقة (Dept Admin)',
    maint_admin: 'مشرف صيانة (Maint Admin)'
  };
  
  const initial = currentUserName ? currentUserName.charAt(0).toUpperCase() : 'U';
  
  let deptHtml = '';
  if ((currentUserRole === 'dept_admin' || currentUserRole === 'maint_admin') && currentUserDept) {
    deptHtml = `<span class="profile-dept-pill">القسم: ${escapeHtml(currentUserDept)}</span>`;
  }
  
  const chipHtml = `
    <div class="user-profile-chip">
      <div class="chip-avatar ${currentUserRole}">${initial}</div>
      <div class="chip-info">
        <span>${escapeHtml(currentUserName)}</span>
        <div class="chip-role">
          ${deptHtml}
          <span>${roleLabels[currentUserRole] || currentUserRole}</span>
        </div>
      </div>
    </div>
  `;

  if (supArea) supArea.innerHTML = chipHtml;
  if (umArea)  umArea.innerHTML  = chipHtml;
  const emAreaEl = document.getElementById('emUserProfileChip');
  if (emAreaEl)  emAreaEl.innerHTML  = chipHtml;

  // Always-visible copy in the sticky top bar (stays on screen regardless
  // of which tab is open or how far the page is scrolled).
  if (globalArea) globalArea.innerHTML = chipHtml;
  if (globalBar)  globalBar.style.display = 'flex';
}

function logout(){
  // ── Reset supervisor session state ────────────────────────
  isLoggedIn      = false;
  currentUsername = '';
  currentUserName = '';
  currentUserRole = '';
  currentUserDept = '';
  clearToken();
  const globalBar = document.getElementById('globalUserBar');
  if (globalBar) globalBar.style.display = 'none';
  if(supervisorPollTimer){ clearInterval(supervisorPollTimer); supervisorPollTimer = null; }
  if(myHistoryPollTimer){  clearInterval(myHistoryPollTimer);  myHistoryPollTimer  = null; }
  if(window.myHazardsPollTimer){ clearInterval(window.myHazardsPollTimer); window.myHazardsPollTimer = null; }
  if(window.trnAdminPollTimer){ clearInterval(window.trnAdminPollTimer); window.trnAdminPollTimer = null; }
  if(window.trnWorkerPollTimer){ clearInterval(window.trnWorkerPollTimer); window.trnWorkerPollTimer = null; }
  
  stopNotificationPolling();

  // ── Always return to unified worker login overlay (Option A) ──
  sessionRole = 'none';
  applyRbacUI();
  // Reset all view states
  document.getElementById('viewWorker').style.display    = 'none';
  document.getElementById('viewSup').style.display       = 'none';
  const viewMH    = document.getElementById('viewMyHistory');
  const viewUsers = document.getElementById('viewUsers');
  const viewHazW  = document.getElementById('viewHazardWorker');
  const viewHazS  = document.getElementById('viewSupHazard');
  const viewMyHaz = document.getElementById('viewMyHazards');
  const viewEmpDir = document.getElementById('viewEmployees');
  if(viewMH)     viewMH.style.display     = 'none';
  if(viewUsers)  viewUsers.style.display  = 'none';
  if(viewHazW)   viewHazW.style.display   = 'none';
  if(viewHazS)   viewHazS.style.display   = 'none';
  if(viewMyHaz)  viewMyHaz.style.display  = 'none';
  if(viewEmpDir) viewEmpDir.style.display = 'none';
  // Clear any active tab highlight
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  // If there was a worker session, clear it too
  currentEmployee = null;
  localStorage.removeItem('ep_currentEmployee');
  // Show the unified entry point
  showWorkerLoginOverlay();
  resetWorkerLogin();
}

// ================================================================
// === نظام دخول الموظف (Employee Quick Login System) ===
// ================================================================

/** يُظهر شاشة دخول الموظف */
function showWorkerLoginOverlay(){
  const overlay = document.getElementById('workerLoginOverlay');
  const mainApp = document.getElementById('mainApp');
  if(overlay) overlay.style.display = 'flex';
  if(mainApp) mainApp.style.display = 'none';
}

/** يخفي شاشة دخول الموظف ويُظهر التطبيق */
function hideWorkerLoginOverlay(){
  const overlay = document.getElementById('workerLoginOverlay');
  const mainApp = document.getElementById('mainApp');
  if(overlay) overlay.style.display = 'none';
  if(mainApp) mainApp.style.display = 'block';
}

/** إعادة ضبط شاشة تسجيل دخول الموظف للمرحلة الأولى */
function resetWorkerLogin(){
  document.getElementById('wl-step1').style.display = 'block';
  const step2 = document.getElementById('wl-step2');
  if (step2) step2.style.display = 'none';
  const welcome = document.getElementById('wl-welcome');
  if (welcome) welcome.style.display = 'none';
  const codeEl = document.getElementById('wl_empCode');
  if (codeEl) codeEl.value = '';
  const msgEl = document.getElementById('wl_checkMsg');
  if (msgEl) { msgEl.textContent = ''; msgEl.className = 'wl-msg'; }
  const btn = document.getElementById('wl_checkBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'تسجيل الدخول ←'; }
}


/** يذهب لتبويب المشرف من شاشة الموظف */
function goToAdminLogin(){
  hideWorkerLoginOverlay();
  // ── Hide the entire tab bar on the login gate ─────────────────────
  // sessionRole is still 'none' here, so no tab should be visible.
  // applyRbacUI() will restore the correct tabs once login succeeds.
  setDisplay('mainTabs', false);
  switchTab('sup');
  renderLoginGate();
}

/**
 * يُشغَّل عند تحميل الصفحة:
 * يفحص localStorage، إذا وُجدت جلسة موظف مخزّنة يُدخله مباشرةً.
 */
function initEmployeeSession(){
  try{
    const saved = localStorage.getItem('ep_currentEmployee');
    if(saved){
      currentEmployee = JSON.parse(saved);
      // Restore RBAC state before touching UI
      sessionRole = 'worker';
      applyRbacUI();
      hideWorkerLoginOverlay();
      showEmpBadge();
      renderForm();
      startNotificationPolling();
      subscribeUserToPush();
      switchTab('dashboard'); // 📊 Default landing: Dashboard
      return;
    }
  } catch(e){ /* ignore */ }
  // No saved session → show unified login overlay
  sessionRole = 'none';
  document.body.dataset.session = 'none';
  showWorkerLoginOverlay();
  renderForm(); // prepare form in background
}

/** يعرض بادج الموظف في الهيدر مع زر تسجيل خروج */
function showEmpBadge(){
  if(!currentEmployee) return;
  const area = document.getElementById('empBadgeArea');
  const pill = document.getElementById('empBadgePill');
  if(!area || !pill) return;
  pill.innerHTML = `
    <span class="emp-dot">👤</span>
    <span class="emp-name">${escapeHtml(currentEmployee.name)}</span>
    <span class="emp-code-label">${escapeHtml(currentEmployee.empCode)}</span>
    <button class="emp-logout-btn" onclick="workerLogout()">خروج</button>
  `;
  area.style.display = 'block';
}

/** تسجيل خروج الموظف: مسح الجلسة والعودة لشاشة الدخول */
function workerLogout(){
  currentEmployee = null;
  localStorage.removeItem('ep_currentEmployee');
  if(myHistoryPollTimer){ clearInterval(myHistoryPollTimer); myHistoryPollTimer = null; }
  if(window.myHazardsPollTimer){ clearInterval(window.myHazardsPollTimer); window.myHazardsPollTimer = null; }
  if(window.trnWorkerPollTimer){ clearInterval(window.trnWorkerPollTimer); window.trnWorkerPollTimer = null; }
  
  stopNotificationPolling();
  
  // Reset RBAC state and return to unified login
  sessionRole = 'none';
  applyRbacUI();
  document.getElementById('viewWorker').style.display = 'none';
  const viewMH = document.getElementById('viewMyHistory');
  if(viewMH) viewMH.style.display = 'none';
  const viewMyHaz = document.getElementById('viewMyHazards');
  if(viewMyHaz) viewMyHaz.style.display = 'none';
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  showWorkerLoginOverlay();
  resetWorkerLogin();
}

/**
 * 1-Step Worker Login: looks up code → shows welcome card or error.
 * No registration form. Workers not in the DB must contact HR.
 */
async function checkEmpCode(){
  // Request permission explicitly on button click for mobile browsers
  if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
    Notification.requestPermission();
  }
  const rawInput = document.getElementById('wl_empCode').value;
  const cleanCode = String(rawInput || '').trim().replace(/^0+/, '') || '0';
  if(!cleanCode || (cleanCode === '0' && rawInput.trim() === '')){
    showWlMsg('wl_checkMsg', 'من فضلك أدخل الكود الوظيفي', 'error');
    return;
  }
  const codeRaw = cleanCode;
  const btn = document.getElementById('wl_checkBtn');
  btn.disabled = true;
  btn.textContent = 'جارِ التحقق…';

  try{
    const res = await fetch(`/api/employees/lookup/${encodeURIComponent(codeRaw)}`);
    if(res.ok){
      const data = await res.json();
      if(data.found){
        const emp = data.employee;
        // Show brief welcome card
        document.getElementById('wl-step1').style.display = 'none';
        const welcomeDiv = document.getElementById('wl-welcome');
        const welcomeText = document.getElementById('wl-welcomeText');
        if(welcomeDiv && welcomeText){
          welcomeText.innerHTML =
            `👋 مرحباً: <strong>${escapeHtml(emp.name)}</strong><br>` +
            `🏢 القسم: ${escapeHtml(emp.department || '—')}<br>` +
            (emp.jobTitle ? `💼 المسمى: ${escapeHtml(emp.jobTitle)}<br>` : '');
          welcomeDiv.style.display = 'block';
        }
        // Finish login after a short delay so the user sees the welcome
        setTimeout(() => {
          finishEmployeeLogin({
            empCode:    emp.code,
            name:       emp.name,
            department: emp.department,
            jobTitle:   emp.jobTitle || '',
            role:       emp.role     || 'worker',
            phone:      emp.phone    || ''
          });
        }, 1200);
      } else {
        // Code not in directory → hard error, no registration form
        showWlMsg('wl_checkMsg',
          '❌ الكود الوظيفي غير مسجل بقاعدة البيانات، يرجى مراجعة إدارة الموارد البشرية أو المشرف',
          'error');
        btn.disabled = false;
        btn.textContent = 'تسجيل الدخول ←';
      }
    } else {
      showWlMsg('wl_checkMsg', 'حصل خطأ في التحقق، حاول تاني', 'error');
      btn.disabled = false;
      btn.textContent = 'تسجيل الدخول ←';
    }
  } catch(e){
    showWlMsg('wl_checkMsg', 'لا يوجد اتصال بالسيرفر', 'error');
    btn.disabled = false;
    btn.textContent = 'تسجيل الدخول ←';
  }
}


/**
 * يُنفَّذ عند الضغط على "حفظ وتسجيل الدخول" للكود الجديد.
 */
async function registerEmployee(){
  const codeRaw = document.getElementById('wl_empCode').value.trim();
  const name = document.getElementById('wl_name').value.trim();
  const phone = document.getElementById('wl_phone').value.trim();
  const dept = document.getElementById('wl_dept').value.trim();
  if(!codeRaw || !name || !phone || !dept){
    showWlMsg('wl_registerMsg', 'من فضلك املأ جميع الحقول المطلوبة', 'error');
    return;
  }
  const btn = document.getElementById('wl_registerBtn');
  btn.disabled = true;
  btn.textContent = 'جارِ الحفظ…';
  try{
    const res = await fetch('/api/employees', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ empCode: codeRaw, name, phone, department: dept })
    });
    const data = await res.json();
    if(res.ok){
      finishEmployeeLogin(data.employee);
    } else {
      showWlMsg('wl_registerMsg', data.error || 'فشل التسجيل، حاول تاني', 'error');
    }
  } catch(e){
    showWlMsg('wl_registerMsg', 'لا يوجد اتصال بالسيرفر', 'error');
  }
  btn.disabled = false;
  btn.textContent = 'حفظ وتسجيل الدخول ✓';
}

/** ينهي عملية دخول الموظف: يحفظ الجلسة ويدخل التطبيق */
function finishEmployeeLogin(emp){
  // Ensure correct employee code is attached to currentUser/emp
  if (window.allEmployees && window.allEmployees.length && emp.name) {
    const found = window.allEmployees.find(e => e.name && e.name.trim() === emp.name.trim());
    if (found && found.empCode) {
      emp.empCode = String(found.empCode);
    }
  }

  currentEmployee = emp;
  try{
    localStorage.setItem('ep_currentEmployee', JSON.stringify(emp));
    if (emp.empCode) {
      sessionStorage.setItem('last_logged_emp_code', String(emp.empCode));
    }
  } catch(e){ /* ignore */ }
  // ── Set RBAC session and rebuild UI before showing app ────
  sessionRole = 'worker';
  applyRbacUI();
  hideWorkerLoginOverlay();
  showEmpBadge();
  autoFillForm();
  startNotificationPolling();
  subscribeUserToPush();
  // switchTab guard now allows 'worker' since sessionRole === 'worker'
  switchTab('dashboard'); // 📊 Default landing: Dashboard
  if (typeof window.populateTrainerInfo === 'function') window.populateTrainerInfo();
}

/** تعبئة حقول نموذج الطلب تلقائياً من بيانات الموظف */
function autoFillForm(){
  if(!currentEmployee) return;
  // Helper: sets value. For input/textarea, also applies readonly. Selects do not support readonly.
  const set = (id, val, readonly=true) => {
    const el = safeEl(id);
    if(!el) return;
    el.value = val || '';
    const isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
    if(readonly && isInput) el.setAttribute('readonly', 'readonly');
    else if(isInput) el.removeAttribute('readonly');
    // For selects, just set value — readonly attribute has no effect on <select>
  };
  set('f_name', currentEmployee.name, true);
  set('f_emp',  currentEmployee.empCode, true);
  set('f_phone', currentEmployee.phone, false);
  set('f_dept',  currentEmployee.department, true);
  // jobTitle field in form (if it exists)
  const jobTitleEl = safeEl('f_jobTitle');
  if(jobTitleEl && currentEmployee.jobTitle){
    jobTitleEl.value = currentEmployee.jobTitle;
    jobTitleEl.setAttribute('readonly','readonly');
  }
}

/** Lookup employee code on the Work Permit form and auto-fill fields */
async function lookupPermitEmpCode() {
  const empEl  = safeEl('f_emp');
  const msgEl  = safeEl('f_empMsg');
  if (!empEl || !empEl.value.trim()) return;
  // If autofilled from session, skip
  if (empEl.hasAttribute('readonly')) return;
  const rawInput = empEl.value;
  const cleanCode = String(rawInput || '').trim().replace(/^0+/, '') || '0';
  try {
    const res  = await fetch(`/api/employees/lookup/${encodeURIComponent(cleanCode)}`);
    const data = await res.json();
    if (data.found) {
      const emp = data.employee;
      const set = (id, val) => { const el = safeEl(id); if(el){ el.value = val||''; el.setAttribute('readonly','readonly'); } };
      set('f_name',     emp.name);
      set('f_jobTitle', emp.jobTitle);
      const deptEl = safeEl('f_dept');
      if (deptEl) deptEl.value = emp.department || '';
      if (msgEl) { msgEl.textContent = `✅ ${emp.name} — ${emp.department||''}${emp.jobTitle?' | '+emp.jobTitle:''}`; msgEl.style.color='var(--success)'; }
    } else {
      if (msgEl) { msgEl.textContent = 'الكود غير مسجل، يرجى كتابة البيانات يدوياً'; msgEl.style.color='var(--muted)'; }
      ['f_name','f_jobTitle'].forEach(id => { const el=safeEl(id); if(el) el.removeAttribute('readonly'); });
    }
  } catch(e) {
    if (msgEl) { msgEl.textContent = 'خطأ في البحث'; msgEl.style.color='var(--danger)'; }
  }
}

/** helper: عرض رسالة في شاشة الدخول */
function showWlMsg(elId, msg, type){
  const el = document.getElementById(elId);
  if(!el) return;
  el.textContent = msg;
  el.className = 'wl-msg ' + type;
}

function showDashboard(){
  // Ensure the outer supervisor view container is visible (it starts
  // display:none in HTML and may not have been opened via switchTab).
  const viewSup = document.getElementById('viewSup');
  if (viewSup) viewSup.style.display = 'block';

  document.getElementById('loginGate').innerHTML = '';
  document.getElementById('supDashboard').style.display = 'block';
  renderSupervisor();

  if(!supervisorPollTimer){
    supervisorPollTimer = setInterval(pollPermitsForSupervisor, 4000);
  }
}

// ---------- worker form ----------
function typeChips(){
  return Object.keys(PERMIT_TYPES).map(key => {
    const t = PERMIT_TYPES[key];
    return `<div class="chip ${key===selectedType?'active':''}" onclick="selectType('${key}')">${t.label}</div>`;
  }).join('');
}

function selectType(key){
  selectedType = key;
  renderForm();
}

function renderForm(){
  const type = PERMIT_TYPES[selectedType];
  // بناء قائمة التحقق الثلاثية المقسّمة
  let chkGlobalIndex = 0;
  function buildSectionHtml(section) {
    let toggleHtml = '';
    let sectionId = '';
    let toggleId = '';
    if(section.sectionTitle.includes('ب)')) {
      sectionId = 'sec_oil'; toggleId = 'sec_oil_toggle';
    } else if(section.sectionTitle.includes('ج)')) {
      sectionId = 'sec_special'; toggleId = 'sec_special_toggle';
    }
    if (toggleId) {
      toggleHtml = `<label style="font-size:13px; font-weight:normal; margin-inline-start:auto; display:flex; align-items:center; gap:4px; cursor:pointer;"><input type="checkbox" id="${toggleId}" onchange="document.getElementById('${sectionId}_content').style.display = this.checked ? 'none' : 'block'"> لا يوجد</label>`;
    }

    const rows = section.items.map((q) => {
      const i = chkGlobalIndex++;
      return `
      <div class="check-row">
        <div class="check-q">${q}</div>
        <div class="check-opts">
          <label><input type="radio" name="chk_${i}" value="نعم" checked> نعم</label>
          <label><input type="radio" name="chk_${i}" value="لا"> لا</label>
          <label><input type="radio" name="chk_${i}" value="لا ينطبق"> لا ينطبق</label>
        </div>
      </div>`;
    }).join('');
    return `<div id="${sectionId}_wrap"><div class="chk-section-label" style="display:flex; align-items:center;"><span>${section.sectionTitle}</span>${toggleHtml}</div><div id="${sectionId}_content">${rows}</div></div>`;
  }
  const checklistHtml =
    buildSectionHtml(HSE_CHECKLIST.general) +
    buildSectionHtml(HSE_CHECKLIST.oilDischarge) +
    buildSectionHtml(HSE_CHECKLIST.specialMaterial);
  const totalChkItems = chkGlobalIndex;

  const formArea = document.getElementById('formArea');
  if (!formArea) return;

  formArea.innerHTML = `
    <div class="type-picker">
      <div class="type-picker-label">نوع الطلب <span class="req-star">*</span></div>
      <div class="filters">${typeChips()}</div>
    </div>

    <div class="ticket">
      <div class="ticket-head">
        <span class="ttype">${type.fullLabel}</span>
        <span class="tnum">NEW REQUEST</span>
      </div>
      <div class="perf"></div>
      <div class="ticket-body">

        <div class="section-title">بيانات الطلب</div>
        <div class="row2">
          <div class="field">
            <label>الإدارة الطالبة / القسم <span class="req-star">*</span></label>
            <input id="f_dept" type="text" readonly style="background-color: #f5f5f5;" placeholder="سيتم تعبئته تلقائياً">
          </div>
          <div class="field">
            <label>الوردية <span class="req-star">*</span></label>
            <select id="f_shift">${SHIFTS.map(s=>`<option>${s}</option>`).join('')}</select>
          </div>
        </div>
        <div class="row2">
          <div class="field">
            <label>تاريخ التنفيذ <span class="req-star">*</span></label>
            <input id="f_date" type="date">
          </div>
          <div class="field">
            <label>رقم طلب سابق لنفس العمل (إن وجد)</label>
            <input id="f_prev" type="text" placeholder="اختياري">
          </div>
        </div>
        <div class="row2">
          <div class="field">
            <label>من الساعة <span class="req-star">*</span></label>
            <input id="f_from" type="time" required>
          </div>
          <div class="field">
            <label>إلى الساعة <span class="req-star">*</span></label>
            <input id="f_to" type="time" required>
            <label class="custom-pill-check" style="display: inline-flex; align-items: center; gap: 8px; cursor: pointer; margin-top: 6px; user-select: none;">
              <span style="font-size: 0.85rem; color: #475569; font-weight: 500;">نهاية مفتوحة / حتى انتهاء العمل</span>
              <input type="checkbox" id="f_open_end" class="pill-checkbox-input" onchange="window.toggleOpenEnd(this)">
              <span class="pill-checkbox-box"></span>
            </label>
          </div>
        </div>

        <div class="section-title">بيانات مقدّم الطلب (مسئول التنفيذ)</div>
        <div class="field">
          <label>الكود الوظيفي <small style="font-weight:400;color:var(--muted);">(اكتب كودك لتعبئة بياناتك تلقائياً)</small></label>
          <div style="display:flex;gap:8px;align-items:center;">
            <input id="f_emp" type="text" placeholder="مثال: EMP001"
                   style="font-family:'Oswald',sans-serif;letter-spacing:1.5px;"
                   oninput="this.value=this.value.toUpperCase()" onblur="lookupPermitEmpCode()">
          </div>
          <div id="f_empMsg" style="font-size:12px;margin-top:3px;min-height:14px;"></div>
        </div>
        <div class="row2">
          <div class="field">
            <label>الاسم <span class="req-star">*</span></label>
            <input id="f_name" type="text" placeholder="الاسم بالكامل">
          </div>
          <div class="field">
            <label>الصفة</label>
            <select id="f_kind"><option>موظف</option><option>مقاول</option></select>
          </div>
        </div>
        <div class="row2">
          <div class="field">
            <label>رقم التليفون</label>
            <input id="f_phone" type="tel" placeholder="01xxxxxxxxx">
          </div>
          <div class="field">
            <label>المسمى الوظيفي</label>
            <input id="f_jobTitle" type="text" placeholder="اختياري">
          </div>
        </div>

        <div class="section-title">تفاصيل العمل</div>
        <div class="field">
          <label>وصف العملية <span class="req-star">*</span></label>
          <textarea id="f_desc" placeholder="اشرح طبيعة العمل المطلوب تنفيذه"></textarea>
        </div>
        <div class="field">
          <label>مكان العمل <span class="req-star">*</span></label>
          <select id="workLocationSelect" name="workLocation" required>
            <option value="">اختر مكان العمل...</option>
            ${WORK_LOCATIONS.map(loc => `<option value="${loc}">${loc}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>المعدة / الماكينة / العملية</label>
          <input id="f_equip" type="text" placeholder="اختياري">
        </div>
        <div class="field">
          <label>الأدوات والعدد <small style="font-weight:400;color:var(--muted);">(بعد فحصها وقبولها)</small></label>
          <div class="tools-checklist" id="toolsChecklist">
            ${TOOLS_LIST.map((tool, i) => `
            <label class="tool-check-label">
              <input type="checkbox" id="tool_${i}" value="${tool}" class="tool-checkbox">
              <span>${tool}</span>
            </label>`).join('')}
            <div class="tool-other-wrap" id="toolOtherWrap" style="display:none;">
              <input type="text" id="tool_other_text" placeholder="أدخل الأداة الأخرى..." class="tool-other-input">
            </div>
          </div>
        </div>
        <div class="field">
          <label>أسماء القائمين بالعمل (كل اسم في سطر) <span class="req-star">*</span></label>
          <textarea id="f_workers" placeholder="1- ...&#10;2- ..."></textarea>
        </div>

        <div class="section-title">قائمة التحقق (نعم / لا / لا ينطبق)</div>
        <div class="checklist" data-total-chk="${totalChkItems}">${checklistHtml}</div>
        <div class="field">
          <label>ملاحظات على قائمة التحقق</label>
          <textarea id="f_checknote" placeholder="اختياري"></textarea>
        </div>

        <div class="section-title">تقييم المخاطر</div>
        <div id="riskRows"></div>
        <button type="button" class="add-risk-btn" onclick="addRiskRow()">+ إضافة خطر</button>

        <button class="submit-btn" id="submitBtn" onclick="submitPermit()">إرسال الطلب للمشرف</button>
      </div>
    </div>
  `;
  document.getElementById('f_date').value = new Date().toISOString().split('T')[0];
  document.getElementById('riskRows').innerHTML = '';
  riskRowCount = 0; // [FIX-3] إعادة ضبط العداد في كل مرة تُعاد فيها رسم النموذج
  addRiskRow();
  addRiskRow();
  
  window.toggleOpenEnd = function(el) {
    const toInput = document.getElementById('f_to');
    if (el.checked) {
      toInput.value = '';
      toInput.disabled = true;
      toInput.style.backgroundColor = '#f0f0f0';
    } else {
      toInput.disabled = false;
      toInput.style.backgroundColor = '';
    }
  };

  // تعبئة تلقائية إذا كان الموظف مسجل دخول
  autoFillForm();
  // تفعيل خانة "أخرى" في قائمة الأدوات
  const toolCheckboxes = document.querySelectorAll('.tool-checkbox');
  toolCheckboxes.forEach(cb => {
    cb.addEventListener('change', function() {
      if (this.value === 'أخرى') {
        const wrap = document.getElementById('toolOtherWrap');
        if (wrap) wrap.style.display = this.checked ? 'block' : 'none';
      }
    });
  });
}

function addRiskRow(){
  if(riskRowCount >= 5) return;
  riskRowCount++;
  const id = 'risk_'+riskRowCount;
  const div = document.createElement('div');
  div.className = 'risk-row';
  div.id = id;
  div.innerHTML = `
    <div class="field"><label>مصدر الخطر</label><input class="risk-source" type="text" placeholder="مثال: سقوط من ارتفاع"></div>
    <div class="row2" style="align-items:flex-end;">
      <div class="field"><label>الاحتمالية L (1-5)</label><select class="risk-l" onchange="calcRisk(this)">${RISK_LEVELS.map(n=>`<option value="${n}">${n}</option>`).join('')}</select></div>
      <div class="field"><label>الشدة S (1-5)</label><select class="risk-s" onchange="calcRisk(this)">${RISK_LEVELS.map(n=>`<option value="${n}">${n}</option>`).join('')}</select></div>
      <div class="risk-badge" style="margin-bottom:12px;"></div>
    </div>
    <div class="field"><label>إجراءات التحكم والوقاية</label><textarea class="risk-control" placeholder="اختياري"></textarea></div>
  `;
  document.getElementById('riskRows').appendChild(div);
  calcRisk(div.querySelector('.risk-l')); // initial calc
}

function calcRisk(el) {
  const row = el.closest('.risk-row');
  const l = parseInt(row.querySelector('.risk-l').value) || 1;
  const s = parseInt(row.querySelector('.risk-s').value) || 1;
  const score = l * s;
  const badge = row.querySelector('.risk-badge');
  
  badge.className = 'risk-badge';
  if (score <= 4) {
    badge.textContent = 'خطورة ضعيفة 🟢';
    badge.classList.add('risk-low');
  } else if (score <= 12) {
    badge.textContent = 'خطورة متوسطة 🟡';
    badge.classList.add('risk-medium');
  } else {
    badge.textContent = 'خطورة عالية 🔴';
    badge.classList.add('risk-high');
  }
}

function collectChecklist(){
  const results = [];
  let idx = 0;
  for (const secKey of ['general','oilDischarge','specialMaterial']) {
    const section = HSE_CHECKLIST[secKey];
    for (const q of section.items) {
      const sel = document.querySelector(`input[name="chk_${idx}"]:checked`);
      results.push({
        section: section.sectionTitle,
        question: q,
        answer: sel ? sel.value : 'لا ينطبق'
      });
      idx++;
    }
  }
  return results;
}

function collectTools(){
  const checked = [];
  document.querySelectorAll('.tool-checkbox:checked').forEach(cb => {
    if (cb.value === 'أخرى') {
      const otherText = document.getElementById('tool_other_text');
      const val = otherText ? otherText.value.trim() : '';
      checked.push(val ? `أخرى: ${val}` : 'أخرى');
    } else {
      checked.push(cb.value);
    }
  });
  return checked;
}
function collectRisks(){
  const rows = document.querySelectorAll('#riskRows .risk-row');
  const risks = [];
  rows.forEach(r=>{
    const source = r.querySelector('.risk-source').value.trim();
    if(!source) return;
    const l = parseInt(r.querySelector('.risk-l').value);
    const s = parseInt(r.querySelector('.risk-s').value);
    const control = r.querySelector('.risk-control').value.trim();
    risks.push({ source, l, s, score: l*s, control });
  });
  return risks;
}

async function submitPermit(){
  const name = document.getElementById('f_name').value.trim();
  const dept = document.getElementById('f_dept').value;
  const date = document.getElementById('f_date').value;
  const timeFrom = document.getElementById('f_from').value;
  const timeTo = document.getElementById('f_to').value;
  const openEnd = document.getElementById('f_open_end') ? document.getElementById('f_open_end').checked : false;
  const desc = document.getElementById('f_desc').value.trim();
  const loc = document.getElementById('workLocationSelect').value;
  const workers = document.getElementById('f_workers').value.trim();

  const missingFields = [];

  if(!loc) missingFields.push('مكان العمل');
  if(!desc) missingFields.push('وصف العملية');
  if(!date) missingFields.push('تاريخ التنفيذ');
  if(!timeFrom) missingFields.push('وقت البدء');
  if(!timeTo && !openEnd) missingFields.push('وقت الانتهاء');
  if(!workers) missingFields.push('أسماء القائمين بالعمل');

  // Also include name/dept just in case they were cleared
  if(!name) missingFields.push('اسم مقدم الطلب');
  if(!dept) missingFields.push('الإدارة الطالبة / القسم');

  const risks = collectRisks();
  if (risks.length < 2 || !risks[0].source || !risks[0].control || !risks[1].source || !risks[1].control) {
    missingFields.push('تقييم المخاطر (الخطر 1 و 2 وإجراءات الوقاية)');
  }

  if (missingFields.length > 0) {
    showToast('برجاء استكمال الحقول المطلوبة التالية:\n• ' + missingFields.join('\n• '), 'error');
    return;
  }

  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = 'جارِ الإرسال…';

  const list = await loadPermits();
  const type = PERMIT_TYPES[selectedType];
  const permit = {
    id: genId(list),
    typeKey: selectedType,
    typeLabel: type.label,
    typeFullLabel: type.fullLabel,
    department: dept,
    shift: document.getElementById('f_shift').value,
    date: date,
    previousPermitNo: document.getElementById('f_prev').value.trim(),
    timeFrom: timeFrom,
    timeTo: openEnd ? 'نهاية مفتوحة' : timeTo,
    workerName: name,
    requesterKind: document.getElementById('f_kind').value,
    requesterPhone: document.getElementById('f_phone').value.trim(),
    employeeId: document.getElementById('f_emp').value.trim(),
    description: desc,
    location: loc,
    equipment: document.getElementById('f_equip').value.trim(),
    tools: collectTools(),
    workersNames: document.getElementById('f_workers').value.trim(),
    checklist: collectChecklist(),
    checklistNote: document.getElementById('f_checknote').value.trim(),
    risks: collectRisks(),
    status: 'pending_dept',
    reviewedBy: '',
    areaHeadReviewedBy: '',
    safetyOfficerName: '',
    areaManagerName: '',
    reviewNote: '',
    submittedAt: new Date().toISOString(),
    reviewedAt: '',
    closure: null
  };
  list.push(permit);
  const ok = await savePermits(list);

  if(!ok){
    btn.disabled = false;
    btn.textContent = 'إرسال الطلب للمشرف';
    showToast('حصل خطأ في الإرسال، حاول تاني', 'error');
    return;
  }

  document.getElementById('formArea').innerHTML = `
    <div class="ticket">
      <div class="confirm">
        <div style="font-size:30px;">✅</div>
        <h2>تم إرسال الطلب</h2>
        <div class="tnum-big">${permit.id}</div>
        <span class="stamp pending big-stamp">قيد الانتظار</span>
        <p>${type.fullLabel} — هيوصل الطلب للمشرف على طول عشان يوافق عليه</p>
        <p style="font-size:12.5px;color:var(--muted);margin-top:10px;">احتفظ برقم الطلب ده — اضغط زر "تتبع الطلب ده" أو افتح تاب "📁 سجل طلباتي" عشان تعرف حالته أول ما المشرف يرد</p>
        <button class="again-btn" onclick="renderForm()">+ طلب جديد</button>
        <button class="again-btn" style="margin-inline-start:8px;border-color:var(--amber);color:var(--amber);" onclick="goTrackWithId('${permit.id}')">📁 سجل طلباتي</button>
      </div>
    </div>
  `;
}

// [FIX-1] إصلاح goTrackWithId: التوجيه لتبويب "سجل طلباتي" بدلاً من تبويب track المحذوف
function goTrackWithId(permitId){
  switchTab('myhistory');
  // تمييز الطلب المحدد بعد تحميل القائمة
  setTimeout(() => {
    const el = document.querySelector(`.phc-id`);
    if(el && el.textContent.trim() === permitId) {
      el.closest('.permit-history-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, 600);
}

// [FIX-2] دوال trackPermits و pollTrackResults محذوفة — كانت تشير لعناصر HTML غير موجودة
// (viewTrack, track_id, track_phone, trackResults)
// منطق التتبع انتقل بالكامل لتبويب "سجل طلباتي" (myhistory)
// ---------- supervisor view ----------
function renderFilters(){
  const opts = ['الكل','بانتظار أدمن القسم','بانتظار السلامة والصحة المهنية','موافق عليه','مرفوض','مغلق','🗑️ المحذوفات'];
  document.getElementById('filters').innerHTML = opts.map(o=>
    `<div class="chip ${o===currentFilter?'active':''}" onclick="setFilter('${o}')">${o}</div>`
  ).join('');
}
function renderTypeFilters(){
  const opts = ['الكل', ...Object.keys(PERMIT_TYPES).map(k=>PERMIT_TYPES[k].label)];
  document.getElementById('typeFilters').innerHTML = opts.map(o=>
    `<div class="chip ${o===currentTypeFilter?'active':''}" onclick="setTypeFilter('${o}')">${o}</div>`
  ).join('');
}
function setFilter(f){ currentFilter = f; renderFilters(); renderList(); }
function setTypeFilter(f){ currentTypeFilter = f; renderTypeFilters(); renderList(); }

// ── Department filter (searchable dropdown — type or pick from the list) ──
async function renderPmDeptFilters(){
  const dArea = document.getElementById('pmDeptFilters');
  const dToolbar = document.getElementById('pmDeptToolbar');
  if (!dArea || !dToolbar) return;
  if (currentUserRole !== 'dept_admin' && currentUserRole !== 'maint_admin') {
    dToolbar.style.display = 'flex';
    // Skip rebuilding while the user is actively typing (avoids losing focus).
    if (!(dArea.dataset.built === '1' && document.activeElement && document.activeElement.id === 'pmDeptFilterInput')) {
      const realDepts = await loadRealDepartments();
      window._pmRealDepts = realDepts;
      const currentVal = currentPmDeptFilter === 'الكل' ? '' : currentPmDeptFilter;
      dArea.innerHTML = `
        <input type="text" id="pmDeptFilterInput" class="dept-filter-input" list="pmDeptDatalist"
          placeholder="🏢 اختر أو اكتب اسم القسم..." value="${escapeAttr(currentVal)}"
          oninput="onPmDeptFilterInput(this.value)" autocomplete="off"
          style="min-width:220px;flex:1;max-width:320px;">
        <datalist id="pmDeptDatalist">
          ${realDepts.map(d => `<option value="${escapeAttr(d)}"></option>`).join('')}
        </datalist>
        ${currentPmDeptFilter !== 'الكل' ? `<div class="chip active" onclick="setPmDeptFilterFromInput('')">✕ إلغاء فلتر القسم</div>` : ''}
      `;
      dArea.dataset.built = '1';
    }
  } else {
    dToolbar.style.display = 'none';
  }
}
function setPmDeptFilter(d){ currentPmDeptFilter = d; renderPmDeptFilters(); renderList(); }
// Sets the dept filter from the search box WITHOUT rebuilding pmDeptFilters
// (keeps the input focused while typing).
function setPmDeptFilterFromInput(v){
  currentPmDeptFilter = (v && v.trim()) ? v.trim() : 'الكل';
  renderList();
}
window.onPmDeptFilterInput = window.debounce(function(v) {
  setPmDeptFilterFromInput(v);
}, 300);

// ── Year filter (pinned pills, fixed list) ──
function renderPmYearFilters(){
  const yArea = document.getElementById('pmYearFilters');
  if (!yArea) return;
  const years = ['الكل', ...FILTER_YEARS];
  yArea.innerHTML = years.map(y =>
    `<div class="chip ${currentPmYearFilter===y?'active':''}" onclick="setPmYearFilter('${y}')">${y}</div>`
  ).join('');
}
function setPmYearFilter(y){ currentPmYearFilter = y; renderPmYearFilters(); renderList(); }

// ── Advanced search box: worker name / supervisor name / date range ──
// Applied entirely client-side against the already-cached permitsCache (see
// renderSupervisor()) — no network call is made while typing, so filtering
// stays fast even with years of imported historical data.
// (Department search lives in the pinned pills above — see renderPmDeptFilters.)
function applyPermitAdvancedFilters(list) {
  const fWorker = document.getElementById('filter_pm_worker')?.value?.trim().toLowerCase();
  const fSup    = document.getElementById('filter_pm_sup')?.value?.trim().toLowerCase();
  const fFrom   = document.getElementById('filter_pm_dateFrom')?.value;
  const fTo     = document.getElementById('filter_pm_dateTo')?.value;

  if (!fWorker && !fSup && !fFrom && !fTo) return list;

  return list.filter(p => {
    if (fWorker && !String(p.workerName || '').toLowerCase().includes(fWorker)) return false;
    if (fSup) {
      const supNames = [p.safetyOfficerName, p.areaManagerName, p.areaHeadReviewedBy, p.reviewedBy]
        .filter(Boolean).join(' ').toLowerCase();
      if (!supNames.includes(fSup)) return false;
    }
    if ((fFrom || fTo) && p.date) {
      // p.date is stored as YYYY-MM-DD, which sorts/compares correctly as a string
      if (fFrom && p.date < fFrom) return false;
      if (fTo && p.date > fTo) return false;
    } else if (fFrom || fTo) {
      return false; // date filter set but permit has no date — exclude
    }
    return true;
  });
}

window.applyPermitFilters = window.debounce(function() {
  renderList();
}, 250);

window.clearPermitFilters = function() {
  const ids = ['filter_pm_worker', 'filter_pm_sup', 'filter_pm_dateFrom', 'filter_pm_dateTo'];
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  renderList();
};

async function renderSupervisor(){
  renderFilters();
  renderTypeFilters();
  await renderPmDeptFilters();
  renderPmYearFilters();
  document.getElementById('supList').innerHTML = '<div class="loading">جارِ التحميل…</div>';
  const res = await apiGet('work-permits');
  lastPermitsRaw = res && res.value ? (typeof res.value === 'string' ? res.value : JSON.stringify(res.value)) : '[]';
  try {
    permitsCache = JSON.parse(lastPermitsRaw);
  } catch(e) {
    permitsCache = [];
  }
  renderList();
}

async function pollPermitsForSupervisor(){
  if(!isLoggedIn) return;
  const res = await apiGet('work-permits');
  const raw = res && res.value ? (typeof res.value === 'string' ? res.value : JSON.stringify(res.value)) : '[]';
  
  if(raw !== lastPermitsRaw){
    lastPermitsRaw = raw;
    try {
      permitsCache = JSON.parse(raw);
    } catch(e) {
      permitsCache = [];
    }
    renderList();
  }
}

const statusTranslations = {
  'pending': 'قيد الانتظار',
  'pending_dept': 'بانتظار أدمن القسم',
  'pending_hse': 'بانتظار السلامة والصحة المهنية',
  'approved_area': 'معتمد من مدير المنطقة',
  'approved': 'معتمد',
  'rejected': 'مرفوض',
  'rejected_area': 'مرفوض من رئيس القسم',
  'rejected_high_management': 'مرفوض من الإدارة العليا',
  'completed': 'مغلق / مكتمل'
};

function getStatusBadgeArabic(status) {
  const key = String(status || '').toLowerCase().trim();
  if (key.startsWith('closed')) return 'مغلق / مكتمل';
  return statusTranslations[key] || status;
}

function statusLabel(raw){
  return getStatusBadgeArabic(raw);
}
function closureLabel(c){
  if(!c) return '';
  if(c.type==='safe') return 'اكتمل العمل بأمان';
  if(c.type==='incomplete') return 'لم يكتمل العمل';
  if(c.type==='forced') return 'إغلاق جبري';
  return '';
}
function formatTime12(time24) {
  if (!time24 || !time24.includes(':')) return time24 || '—';
  const [hStr, mStr] = time24.split(':');
  let h = parseInt(hStr, 10);
  if (isNaN(h)) return time24;
  const ampm = h >= 12 ? 'م' : 'ص';
  h = h % 12;
  h = h ? h : 12;
  return `${h.toString().padStart(2, '0')}:${mStr} ${ampm}`;
}
function statusFilterMatch(s){
  if(currentFilter==='الكل') return true;
  if(currentFilter==='مرفوض' && s && s.startsWith('rejected')) return true;
  return statusLabel(s) === currentFilter;
}
function typeFilterMatch(p){
  if(currentTypeFilter==='الكل') return true;
  return p.typeLabel === currentTypeFilter;
}

function renderList(){
  const currentRoleKey = getRoleKey(currentUserRole);

  // 1. Separate all permits strictly into Active and Trashed
  const activePermits = [...permitsCache].reverse().filter(p => {
    const isPermanentlyDeletedForMe = p.permanentlyDeletedBy && p.permanentlyDeletedBy[currentRoleKey] === true;
    if (isPermanentlyDeletedForMe) return false;
    const deletedBy = (typeof p.deletedBy === 'object' && p.deletedBy !== null) ? p.deletedBy : {};
    const isDeletedForMe = deletedBy[currentRoleKey] === true;
    return !isDeletedForMe;
  });

  const trashedPermits = [...permitsCache].reverse().filter(p => {
    const isPermanentlyDeletedForMe = p.permanentlyDeletedBy && p.permanentlyDeletedBy[currentRoleKey] === true;
    if (isPermanentlyDeletedForMe) return false;
    const deletedBy = (typeof p.deletedBy === 'object' && p.deletedBy !== null) ? p.deletedBy : {};
    return deletedBy[currentRoleKey] === true;
  });

  // 2. Select base list according to current tab
  let baseList = currentFilter === '🗑️ المحذوفات' ? trashedPermits : activePermits;

  // 3. Apply role-specific visibility rules to active items only
  if (currentFilter !== '🗑️ المحذوفات') {
    baseList = baseList.filter(p => {
      if ((currentUserRole === 'dept_admin' || currentUserRole === 'maint_admin') && p.department !== currentUserDept) return false;
      if (currentUserRole === 'hse_admin') {
         if (p.status === 'rejected_area' || (p.status === 'rejected' && (p.rejectedByRole === 'dept_admin' || p.rejectedByRole === 'maint_admin'))) return false;
         if (p.status === 'pending_hse' || p.status === 'approved' || (p.status && p.status.startsWith('rejected')) || (p.status && p.status.startsWith('closed'))) return true;
         return false;
      }
      if (currentUserRole === 'super_admin') {
         if (p.status === 'rejected_area' || (p.status === 'rejected' && (p.rejectedByRole === 'dept_admin' || p.rejectedByRole === 'maint_admin'))) return false;
         const isApprovedOrClosed = p.status === 'pending_hse' || p.status === 'approved' || (p.status && p.status.startsWith('rejected')) || (p.status && p.status.startsWith('closed'));
         return isApprovedOrClosed;
      }
      return true;
    });
  } else {
      // In Trash bin, Dept Admin / Maint Admin can still only see their department
      baseList = baseList.filter(p => {
         if ((currentUserRole === 'dept_admin' || currentUserRole === 'maint_admin') && p.department !== currentUserDept) return false;
         return true;
      });
  }

  // 4. Apply pinned department / year filters
  if (currentPmDeptFilter !== 'الكل') {
    const deptQuery = currentPmDeptFilter.trim().toLowerCase();
    const isKnownDept = (window._pmRealDepts || []).includes(currentPmDeptFilter);
    baseList = baseList.filter(p => {
      const dep = String(p.department || '');
      return isKnownDept ? dep === currentPmDeptFilter : dep.toLowerCase().includes(deptQuery);
    });
  }
  if (currentPmYearFilter !== 'الكل') {
    baseList = baseList.filter(p => String(p.date || '').slice(0, 4) === currentPmYearFilter);
  }

  // 5. Apply status and type filters
  let list = baseList.filter(p => {
    if (currentFilter !== '🗑️ المحذوفات' && p.deletedBy?.[currentRoleKey] === true) return false;
    
    if (currentFilter === '🗑️ المحذوفات') return typeFilterMatch(p);
    return statusFilterMatch(p.status) && typeFilterMatch(p);
  });

  // 6. Apply the advanced search box (worker / supervisor / date range)
  list = applyPermitAdvancedFilters(list);

  const pmCountEl = document.getElementById('pmFilterCount');
  if (pmCountEl) pmCountEl.textContent = `عدد النتائج: ${list.length}`;

  const container = document.getElementById('supList');

  if(list.length === 0){
    container.innerHTML = `<div class="empty"><div class="icon">🗂️</div>لا توجد طلبات مطابقة حاليًا</div>`;
    return;
  }

  container.innerHTML = list.map(p => {
    const failedChecks = (p.checklist||[]).filter(c=>c.answer==='لا').length;
    // بناء قائمة التحقق مع قدوات الأقسام
    const checklistBySection = {};
    (p.checklist||[]).forEach(c => {
      const sec = c.section || 'بنود عامة';
      if (!checklistBySection[sec]) checklistBySection[sec] = [];
      checklistBySection[sec].push(c);
    });
    const checklistHtml = Object.entries(checklistBySection).map(([sec, items]) => `
      <div style="font-size:11.5px;font-weight:800;color:var(--steel);letter-spacing:0.5px;padding:6px 0 3px;border-bottom:1px solid var(--paper-line);margin-bottom:3px;">${escapeHtml(sec)}</div>
      ${items.map(c=>`
      <div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid var(--paper-line);font-size:12.5px;">
        <span>${escapeHtml(c.question)}</span>
        <span style="font-weight:700;color:${c.answer==='لا'?'var(--danger)':c.answer==='نعم'?'var(--success)':'var(--muted)'};white-space:nowrap;">${c.answer}</span>
      </div>`).join('')}
    `).join('');
    const risksHtml = (p.risks||[]).map(r=>`
      <div class="risk-summary">
        <b>${escapeHtml(r.source)}</b> — L${r.l}×S${r.s} = ${r.score}
        ${r.control ? `<br><span style="color:var(--muted);">${escapeHtml(r.control)}</span>` : ''}
      </div>
    `).join('') || `<div class="risk-summary" style="color:var(--muted);">لا توجد مخاطر مسجلة</div>`;

    const deletedBy = (typeof p.deletedBy === 'object' && p.deletedBy !== null) ? p.deletedBy : {};
    const isTrashedForMe = deletedBy[currentRoleKey] === true;
    
    const normalizedStatus = p.status ? String(p.status).toLowerCase() : '';
    // Status Badge Logic
    let statusBadge = '';
    if (normalizedStatus === 'rejected_area' || normalizedStatus === 'rejected_high_management' || normalizedStatus === 'rejected' || normalizedStatus.startsWith('reject')) {
       statusBadge = `<span class="stamp rejected">${getStatusBadgeArabic(p.status)}</span>`;
    } else if (normalizedStatus === 'approved' || normalizedStatus === 'approved_area' || normalizedStatus.startsWith('closed')) {
       statusBadge = `<span class="badge badge-approved">${getStatusBadgeArabic(p.status)}${normalizedStatus.startsWith('closed') ? ' — '+closureLabel(p.closure) : ''}</span>`;
    } else {
       statusBadge = `<span class="stamp ${p.status}">${getStatusBadgeArabic(p.status)}</span>`;
    }

    return `
    <div class="sup-card ${isTrashedForMe ? 'deleted' : ''}">
      <div class="sup-top">
        <div>
          <div class="worker"><span class="type-pill">${escapeHtml(p.typeLabel)}</span>${escapeHtml(p.workerName)}</div>
          <div class="tnum">${p.id} · ${p.date||''} · وردية ${escapeHtml(p.shift||'')}</div>
        </div>
        ${statusBadge}
      </div>
      <div class="meta-grid">
        <div><span>القسم</span>${escapeHtml(p.department)||'—'}</div>
        <div><span>مكان العمل</span>${escapeHtml(p.location)||'—'}</div>
        <div style="white-space: normal;"><span>الوقت</span>${escapeHtml(formatTime12(p.timeFrom))} → ${escapeHtml(formatTime12(p.timeTo))}</div>
        <div><span>الصفة</span>${escapeHtml(p.requesterKind)||'—'}</div>
        <div>
          <span>الكود الوظيفي</span>
          ${p.employeeId ? escapeHtml(p.employeeId) : '<span style="color:var(--danger);font-weight:700;">غير مسجل ⚠</span>'}
        </div>
      </div>
      ${!p.employeeId ? `
      <div class="row2 empcode-add-box" style="margin-top:8px;">
        <div class="field">
          <input id="empcode-${p.id}" type="text" placeholder="أدخل الكود الوظيفي (${escapeHtml(p.workerName || 'صاحب الطلب')})" style="direction:ltr;font-size:12px;padding:6px;">
        </div>
        <button class="act-btn approve" style="align-self:flex-end;" onclick="savePermitEmployeeCode('${p.id}')">💾 حفظ الكود</button>
      </div>
      ` : ''}
      <div class="desc"><strong>وصف العملية:</strong> ${escapeHtml(p.description)}</div>
      ${failedChecks>0 ? `<div class="checklist-summary"><b>⚠ ${failedChecks} بند غير مستوفٍ في قائمة التحقق</b></div>` : `<div class="checklist-summary">✓ كل بنود قائمة التحقق مستوفاة أو لا تنطبق</div>`}

      <span class="details-toggle" onclick="toggleDetails('${p.id}')">عرض كل التفاصيل (قائمة التحقق + المخاطر) ⌄</span>
      <div class="full-details" id="details-${p.id}">
        <div class="section-title" style="margin-top:14px;">قائمة التحقق</div>
        ${checklistHtml}
        ${p.checklistNote ? `<div class="review-note">ملاحظة: ${escapeHtml(p.checklistNote)}</div>` : ''}
        <div class="section-title">تقييم المخاطر</div>
        ${risksHtml}
        ${p.workersNames ? `<div class="section-title">القائمون بالعمل</div><div class="desc">${escapeHtml(p.workersNames)}</div>` : ''}
        ${p.equipment ? `<div class="meta-grid" style="margin-top:8px;"><div><span>المعدة/الماكينة</span>${escapeHtml(p.equipment)}</div></div>` : ''}
        ${(p.tools && (Array.isArray(p.tools) ? p.tools.length > 0 : p.tools)) ? `
          <div class="section-title" style="margin-top:10px;">الأدوات والعدد</div>
          <div class="tools-display">${Array.isArray(p.tools) ? p.tools.map(t=>`<span class="tool-tag">${escapeHtml(t)}</span>`).join('') : escapeHtml(p.tools)}</div>` : ''}
        ${p.previousPermitNo ? `<div class="reviewed-by">رقم طلب سابق: ${escapeHtml(p.previousPermitNo)}</div>`:''}
        ${p.requesterPhone ? `<div class="reviewed-by">تليفون: ${escapeHtml(p.requesterPhone)}</div>`:''}
        <div class="doc-control-footer">SE-07-F02 &nbsp;|&nbsp; VER.NO.: 01 &nbsp;|&nbsp; VER. DATE: 01/01/2025</div>
      </div>

      ${(p.status === 'pending' || p.status === 'pending_dept') ? `
        ${(((currentUserRole === 'dept_admin' || currentUserRole === 'maint_admin') && currentUserDept === p.department)) || currentUserRole === 'super_admin' ? `
          <div class="row2" style="margin-top:12px;">
            <div class="field"><label>اسم مدير المنطقة</label><input id="area-${p.id}" type="text" placeholder="اختياري"></div>
          </div>
          <div class="actions">
            <button class="act-btn approve" onclick="approvePermit('${p.id}')">✓ موافقة أدمن القسم</button>
            <button class="act-btn reject" onclick="toggleNote('${p.id}')">✗ رفض</button>
          </div>
          <div class="note-box" id="note-${p.id}">
            <textarea id="notetext-${p.id}" placeholder="سبب الرفض (اختياري)"></textarea>
            <button onclick="rejectPermit('${p.id}')">تأكيد الرفض</button>
          </div>
        ` : `
          <div class="review-note">⏳ الطلب بانتظار موافقة أدمن قسم ${escapeHtml(p.department)}</div>
        `}
      ` : ''}

      ${p.status === 'pending_hse' ? `
        <div class="reviewed-by">موافقة مبدئية من: ${escapeHtml(p.areaHeadReviewedBy)||'أدمن القسم'} — ${p.areaHeadReviewedAt ? new Date(p.areaHeadReviewedAt).toLocaleString('ar-EG') : ''}</div>
        ${(currentUserRole === 'hse_admin' || currentUserRole === 'super_admin') ? `
          <div class="row2" style="margin-top:12px;">
            <div class="field"><label>اسم مشرف السلامة</label><input id="safety-${p.id}" type="text" placeholder="اختياري"></div>
          </div>
          <div class="actions">
            <button class="act-btn approve" onclick="approvePermit('${p.id}')">✓ اعتماد السلامة والصحة المهنية (HSE)</button>
            <button class="act-btn reject" onclick="toggleNote('${p.id}')">✗ رفض</button>
          </div>
          <div class="note-box" id="note-${p.id}">
            <textarea id="notetext-${p.id}" placeholder="سبب الرفض (اختياري)"></textarea>
            <button onclick="rejectPermit('${p.id}')">تأكيد الرفض</button>
          </div>
        ` : `
          <div class="review-note">⏳ الطلب بانتظار اعتماد السلامة والصحة المهنية (HSE)</div>
        `}
      ` : ''}

      ${p.status === 'approved' ? `
        ${p.areaHeadReviewedBy ? `<div class="reviewed-by">موافقة رئيس منطقة: ${escapeHtml(p.areaHeadReviewedBy)} — ${p.areaHeadReviewedAt ? new Date(p.areaHeadReviewedAt).toLocaleString('ar-EG') : ''}</div>` : ''}
        <div class="reviewed-by">اعتمدته الإدارة: ${escapeHtml(p.reviewedBy)||'الإدارة'} — ${p.reviewedAt ? new Date(p.reviewedAt).toLocaleString('ar-EG') : ''}</div>
        <div class="review-note" style="background-color: var(--card-bg); border: 1px dashed var(--success);">
          🔒 الطلب معتمد ومفتوح. يمكن للموظف إغلاقه من حسابه.
        </div>
      ` : ''}

      ${p.status === 'rejected' ? `
        <div class="reviewed-by">رفضه: ${escapeHtml(p.reviewedBy)||'المشرف'} — ${p.reviewedAt ? new Date(p.reviewedAt).toLocaleString('ar-EG') : ''}</div>
        ${p.reviewNote ? `<div class="review-note">سبب الرفض: ${escapeHtml(p.reviewNote)}</div>` : ''}
      ` : ''}

      ${p.status.startsWith('closed') ? `
        <div class="reviewed-by">اعتمدته الإدارة: ${escapeHtml(p.reviewedBy)||'الإدارة'}</div>
        <div class="reviewed-by">حالة الإغلاق: ${closureLabel(p.closure)} — ${p.closure && p.closure.time ? new Date(p.closure.time).toLocaleString('ar-EG') : ''}</div>
        ${p.closure && p.closure.closedBy ? `<div class="reviewed-by">أغلقه: ${escapeHtml(p.closure.closedBy.includes('(worker)') ? (p.workerName || p.applicantName || p.employeeName || p.closure.closedBy) : p.closure.closedBy)}</div>` : ''}
        ${p.closure && p.closure.reason ? `<div class="review-note">السبب: ${escapeHtml(p.closure.reason)}</div>` : ''}
      ` : ''}
      ${currentFilter === '🗑️ المحذوفات' ? `
        <div style="margin-top:12px; border-top:1px solid var(--paper-line); padding-top:10px; display: flex; flex-direction: column; gap: 8px;">
          ${(currentUserRole === 'super_admin' || p.deletedByUsername === currentUsername || p.lastDeletedByUsername === currentUsername) ? `
          <div style="display: flex; gap: 8px;">
            <button class="act-btn" style="flex:1; background:var(--success); color:white; border:none; padding:8px; border-radius:4px; cursor:pointer;" onclick="restorePermit('${p.id}')">🔄 استرجاع</button>
            <button class="act-btn" style="flex:1; background:var(--danger); color:white; border:none; padding:8px; border-radius:4px; cursor:pointer;" onclick="hardDeletePermit('${p.id}')">❌ حذف نهائي</button>
          </div>
          ` : ''}
          ${(p.lastDeletedByUsername || p.deletedByUsername) ? `<div style="font-size:12px; color:var(--danger); margin-top:4px; font-weight:bold;">حُذف بواسطة: ${escapeHtml(p.lastDeletedByUsername || p.deletedByUsername || 'المشرف')} ${p.deleteReason ? `| السبب: ${escapeHtml(p.deleteReason)}` : ''}</div>` : ''}
        </div>
      ` : ''}
      ${currentFilter !== '🗑️ المحذوفات' && (currentUserRole === 'super_admin' || currentUserRole === 'hse_admin' || currentUserRole === 'dept_admin' || currentUserRole === 'maint_admin') ? `
        <div style="margin-top:12px; text-align:left;">
          <button class="um-btn del" onclick="openDeletePermitModal('${p.id}')">🗑️ حذف</button>
        </div>
      ` : ''}
    </div>
  `;}).join('');
}

function toggleDetails(id){
  document.getElementById('details-'+id).classList.toggle('show');
}
function toggleNote(id){
  document.getElementById('note-'+id).classList.toggle('show');
}

let permitToDelete = '';
function openDeletePermitModal(id) {
  permitToDelete = id;
  document.getElementById('deletePermitReason').value = '';
  const msg = document.getElementById('deletePermitMsg');
  if(msg) msg.className = 'um-msg';
  document.getElementById('deletePermitModal').style.display = 'flex';
}
function closeDeletePermitModal() {
  document.getElementById('deletePermitModal').style.display = 'none';
  permitToDelete = '';
}
async function confirmDeletePermit() {
  const reason = document.getElementById('deletePermitReason').value.trim();
  const msgEl = document.getElementById('deletePermitMsg');
  msgEl.className = 'um-msg';

  if(!reason) {
    msgEl.textContent = 'من فضلك أدخل سبب الحذف';
    msgEl.className = 'um-msg error show';
    return;
  }

  try {
    const res = await authFetch(`/api/permits/${encodeURIComponent(permitToDelete)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    const data = await res.json();
    if (res.ok) {
      msgEl.textContent = '✅ تم حذف الطلب ونقله للأرشيف';
      msgEl.className = 'um-msg success show';
      
      if (data.permit) {
         const idx = permitsCache.findIndex(p => String(p.id) === String(permitToDelete));
         if (idx !== -1) permitsCache[idx] = data.permit;
      }
      renderList();

      setTimeout(() => {
        closeDeletePermitModal();
        pollPermitsForSupervisor();
      }, 1000);
    } else {
      msgEl.textContent = data.error || 'فشل عملية الحذف';
      msgEl.className = 'um-msg error show';
    }
  } catch (e) {
    msgEl.textContent = 'خطأ في الاتصال بالسيرفر';
    msgEl.className = 'um-msg error show';
  }
}
async function restorePermit(id) {
  if(!confirm('هل أنت متأكد من استعادة هذا الطلب؟')) return;
  try {
    const res = await authFetch(`/api/permits/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    if(res.ok) {
      const idx = permitsCache.findIndex(p => p.id === id);
      if (idx !== -1) {
        if (permitsCache[idx].deletedBy) permitsCache[idx].deletedBy[getRoleKey(currentUserRole)] = false;
        if (permitsCache[idx].permanentlyDeletedBy) permitsCache[idx].permanentlyDeletedBy[getRoleKey(currentUserRole)] = false;
        renderList();
      }
      pollPermitsForSupervisor();
    } else {
      const data = await res.json();
      showToast(data.error || 'فشل استعادة الطلب', 'error');
    }
  } catch (e) {
    showToast('خطأ في الاتصال بالسيرفر', 'error');
  }
}

async function hardDeletePermit(id) {
  if(!confirm('هل أنت متأكد من حذف هذا الطلب نهائياً من سلة المحذوفات؟ لا يمكن التراجع عن هذا الإجراء')) return;
  try {
    const res = await authFetch(`/api/permits/${encodeURIComponent(id)}/permanent`, { method: 'DELETE' });
    if(res.ok) {
      const idx = permitsCache.findIndex(p => p.id === id);
      if (idx !== -1) {
        permitsCache[idx].permanentlyDeletedBy = permitsCache[idx].permanentlyDeletedBy || {};
        permitsCache[idx].permanentlyDeletedBy[getRoleKey(currentUserRole)] = true;
        renderList();
      }
      pollPermitsForSupervisor();
    } else {
      const data = await res.json();
      showToast(data.error || 'فشل الحذف النهائي', 'error');
    }
  } catch (e) {
    showToast('خطأ في الاتصال بالسيرفر', 'error');
  }
}

async function approvePermit(id){
  const safetyEl = document.getElementById('safety-'+id);
  const areaEl   = document.getElementById('area-'+id);
  try {
    const res = await authFetch(`/api/permits/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action:            (currentUserRole === 'dept_admin' || currentUserRole === 'maint_admin') ? 'dept_approve' : 'hse_approve',
        safetyOfficerName: safetyEl ? safetyEl.value.trim() : '',
        areaManagerName:   areaEl   ? areaEl.value.trim()   : ''
      })
    });
    const data = await res.json();
    if (res.ok) {
      // Update local cache from server response
      const idx = permitsCache.findIndex(p => p.id === id);
      if (idx !== -1 && data.permit) permitsCache[idx] = data.permit;
      currentFilter = 'الكل';
      renderFilters();
      renderList();
    } else {
      showToast(data.error || 'حصل خطأ في الموافقة، حاول تاني', 'error');
    }
  } catch(e) {
    showToast('حصل خطأ في الاتصال بالسيرفر', 'error');
  }
}

async function rejectPermit(id){
  const noteEl = document.getElementById('notetext-'+id);
  const note   = noteEl ? noteEl.value.trim() : '';
  try {
    const res = await authFetch(`/api/permits/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        action: 'reject', 
        reviewNote: note 
      })
    });
    const data = await res.json();
    if (res.ok) {
      const idx = permitsCache.findIndex(p => p.id === id);
      if (idx !== -1 && data.permit) permitsCache[idx] = data.permit;
      renderList();
    } else {
      showToast(data.error || 'حصل خطأ في الرفض، حاول تاني', 'error');
    }
  } catch(e) {
    showToast('حصل خطأ في الاتصال بالسيرفر', 'error');
  }
}

// ── إضافة/تصحيح الكود الوظيفي على تصريح قديم مستورد ما كان له كود ──────
async function savePermitEmployeeCode(id){
  const inputEl = document.getElementById('empcode-'+id);
  const code = inputEl ? inputEl.value.trim() : '';
  if(!code){
    showToast('من فضلك أدخل الكود الوظيفي أولاً', 'error');
    return;
  }
  try {
    const res = await authFetch(`/api/permits/${encodeURIComponent(id)}/employee-code`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: code })
    });
    const data = await res.json();
    if (res.ok) {
      const idx = permitsCache.findIndex(p => p.id === id);
      if (idx !== -1 && data.permit) permitsCache[idx] = data.permit;
      renderList();
    } else {
      showToast(data.error || 'حصل خطأ في حفظ الكود، حاول تاني', 'error');
    }
  } catch(e) {
    showToast('حصل خطأ في الاتصال بالسيرفر', 'error');
  }
}

async function closePermit(id, type){
  const reasonEl = document.getElementById('closereason-'+id);
  const reason   = reasonEl ? reasonEl.value.trim() : '';
  try {
    const res = await authFetch(`/api/permits/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'close', closureType: type, closureReason: reason })
    });
    const data = await res.json();
    if (res.ok) {
      const idx = permitsCache.findIndex(p => p.id === id);
      if (idx !== -1 && data.permit) permitsCache[idx] = data.permit;
      renderList();
    } else {
      showToast(data.error || 'حصل خطأ في الإغلاق، حاول تاني', 'error');
    }
  } catch(e) {
    showToast('حصل خطأ في الاتصال بالسيرفر', 'error');
  }
}

async function workerClosePermit(id, type) {
  if (!currentEmployee) return;
  const reasonEl = document.getElementById('myhistory-closereason-' + id);
  const reason = reasonEl ? reasonEl.value.trim() : '';

  try {
    const res = await fetch(`/api/permits/${encodeURIComponent(id)}/worker-close`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: currentEmployee.empCode, closureType: type, closureReason: reason })
    });
    const data = await res.json();
    if (res.ok) {
      renderMyHistory(true);
    } else {
      showToast(data.error || 'حصل خطأ في الإغلاق، حاول تاني', 'error');
    }
  } catch(e) {
    showToast('حصل خطأ في الاتصال بالسيرفر', 'error');
  }
}

function escapeHtml(str){
  if(!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
// Escapes a value for safe use inside a single-quoted inline onclick="fn('...')"
// attribute — needed now that department chips are built from live server data
// (which can contain characters like & or ') instead of a fixed hardcoded list.
function escapeAttr(str){
  if(!str) return '';
  return String(str).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;');
}

// ---------- excel export ----------
function exportExcel(){
  const isDeptAdmin = currentUserRole === 'dept_admin' || currentUserRole === 'maint_admin';
  const isHSEAdmin = currentUserRole === 'hse_admin';
  const isSuperAdmin = currentUserRole === 'super_admin';

  let roleKey = 'worker';
  if (isDeptAdmin) roleKey = 'areaAdmin';
  if (isHSEAdmin) roleKey = 'safetyAdmin';
  if (isSuperAdmin) roleKey = 'superAdmin';

  if (currentFilter === '🗑️ المحذوفات') {
    const list = [...permitsCache].reverse().filter(p => {
      const deletedBy = (typeof p.deletedBy === 'object' && p.deletedBy !== null) 
        ? p.deletedBy 
        : { areaAdmin: !!p.deleted, safetyAdmin: !!p.deleted, superAdmin: !!p.deleted, worker: !!p.deleted };
      if (isDeptAdmin && p.department !== currentUserDept) return false;
      if (!deletedBy[roleKey] || !typeFilterMatch(p)) return false;
      return true;
    });

    if(list.length === 0){
      showToast('لا توجد بيانات محذوفة لتصديرها بعد', 'error');
      return;
    }

    const rows = list.map(p => ({
      'كود الطلب': p.id,
      'اسم مقدم الطلب': p.workerName,
      'القسم': p.department,
      'تاريخ الحذف': p.deletedAt ? new Date(p.deletedAt).toLocaleString('ar-EG') : '',
      'اسم من قام بالحذف': p.deletedByUsername || '',
      'سبب الحذف': p.deleteReason || ''
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = Object.keys(rows[0]).map(()=>({wch:20}));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'المحذوفات');
    const dateStr = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `سجل_المحذوفات_${dateStr}.xlsx`);
    return;
  }

  const list = [...permitsCache].reverse().filter(p => {
    const deletedBy = (typeof p.deletedBy === 'object' && p.deletedBy !== null) 
      ? p.deletedBy 
      : { areaAdmin: !!p.deleted, safetyAdmin: !!p.deleted, superAdmin: !!p.deleted, worker: !!p.deleted };
    
    if (isDeptAdmin && p.department !== currentUserDept) return false;
    
    if (isHSEAdmin) {
      if (p.status === 'pending_hse' || p.status === 'approved' || (p.status && p.status.startsWith('rejected')) || (p.status && p.status.startsWith('closed'))) {
         return !deletedBy[roleKey] && statusFilterMatch(p.status) && typeFilterMatch(p);
      }
      return false;
    }
    
    if (isSuperAdmin) {
      const isApprovedOrClosed = p.status === 'pending_hse' || p.status === 'approved' || (p.status && p.status.startsWith('rejected')) || (p.status && p.status.startsWith('closed'));
      if (!isApprovedOrClosed) return false;
    }
    
    return !deletedBy[roleKey] && statusFilterMatch(p.status) && typeFilterMatch(p);
  });
  if(list.length === 0){
    showToast('لا توجد بيانات لتصديرها بعد', 'error');
    return;
  }
  // main sheet mirrors the official "سجل متابعة الطلبات" column layout
  const rows = list.map(p => ({
    'نوع الطلب': p.typeLabel,
    'القسم': p.department,
    'الوردية': p.shift,
    'رقم الطلب': p.id,
    'وصف العمل': p.description,
    'من': p.timeFrom,
    'الي': p.timeTo,
    'التاريخ': p.date,
    'مسئول التنفيذ': p.workerName,
    'مشرف السلامه': p.safetyOfficerName || '',
    'مدير المنطقه': p.areaManagerName || '',
    'الحالة': statusLabel(p.status),
    'حالة الإغلاق': closureLabel(p.closure),
    'راجعه': p.reviewedBy,
    'ملاحظة الرفض': p.reviewNote,
    'مكان العمل': p.location,
    'أسماء القائمين بالعمل': p.workersNames,
    'بنود قائمة تحقق = لا': (p.checklist||[]).filter(c=>c.answer==='لا').map(c=>c.question).join(' | '),
    'وقت الإرسال': p.submittedAt ? new Date(p.submittedAt).toLocaleString('ar-EG') : '',
    'وقت المراجعة': p.reviewedAt ? new Date(p.reviewedAt).toLocaleString('ar-EG') : ''
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = Object.keys(rows[0]).map(()=>({wch:20}));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'سجل متابعة الطلبات');
  const dateStr = new Date().toISOString().split('T')[0];
  XLSX.writeFile(wb, `سجل_طلبات_العمل_${dateStr}.xlsx`);
}

// ---------- PWA install prompt (Android/Chrome "أضف للشاشة الرئيسية") ----------
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('installBtn');
  if (btn) btn.style.display = 'inline-flex';
});
function triggerInstall(){
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.finally(() => {
    deferredInstallPrompt = null;
    const btn = document.getElementById('installBtn');
    if (btn) btn.style.display = 'none';
  });
}

// ── Register service worker + force update check on every load ───────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => {
        // Immediately check for a new SW version so stale clients update
        // without waiting for the next navigation event.
        reg.update();

        // When a new SW is waiting, reload all clients to activate it.
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // New SW installed and waiting — post message to skip waiting
              newWorker.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      })
      .catch((e) => console.error('SW register failed', e));

    // When the SW activates and claims this client, reload to get fresh assets
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) { refreshing = true; window.location.reload(); }
    });
  });
}


// ===================================================================
// إدارة المستخدمين - User Management (Super Admin only)
// ===================================================================
function roleLabel(r){
  if(r==='super_admin') return 'Super Admin';
  if(r==='hse_admin') return 'HSE Admin';
  if(r==='dept_admin') return 'Dept Admin';
  return r;
}

function toggleUmDept() {
  const role = document.getElementById('um_role').value;
  const deptRow = document.getElementById('um_deptRow');
  if (role === 'dept_admin') {
    deptRow.style.display = 'flex';
  } else {
    deptRow.style.display = 'none';
  }
}

async function renderUsersPanel(){
  const listEl = document.getElementById('um_usersList');
  if(!listEl) return;
  listEl.innerHTML = '<div class="loading">جارِ تحميل المستخدمين…</div>';
  try{
    const res = await authFetch('/api/users');
    if(!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    const users = data.users || [];
    window.umUsers = users; // Save globally for the edit modal
    if(users.length === 0){
      listEl.innerHTML = '<div class="empty"><div class="icon">👤</div>لا يوجد مستخدمون</div>';
      return;
    }
    listEl.innerHTML = `
      <div class="um-table-wrap">
        <table class="um-table">
          <thead>
            <tr>
              <th>#</th>
              <th>الاسم</th>
              <th>اسم المستخدم</th>
              <th>الدور</th>
              <th>تاريخ الإنشاء</th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            ${users.map((u,i) => `
              <tr>
                <td style="color:var(--muted);font-size:12px;">${i+1}</td>
                <td style="font-weight:700;">${escapeHtml(u.name)}</td>
                <td style="font-family:'Oswald',sans-serif;font-size:13px;">${escapeHtml(u.username)}</td>
                <td>
                  <span class="role-badge ${u.role}">${roleLabel(u.role)}</span>
                  ${u.role === 'dept_admin' && u.department ? `<div style="font-size:11px;color:var(--muted);margin-top:4px;">${escapeHtml(u.department)}</div>` : ''}
                </td>
                <td style="color:var(--muted);font-size:12px;">${u.createdAt ? new Date(u.createdAt).toLocaleDateString('ar-EG') : '—'}</td>
                <td>
                  <div class="um-action-btns">
                    <button class="um-btn pass" onclick="openEditUserModal('${u.id}')">✏️ تعديل</button>
                    <button class="um-btn del" onclick="deleteUser('${u.id}','${escapeHtml(u.name)}')"
                      ${u.role==='super_admin' ? 'disabled title="لا يمكن حذف Super Admin"' : ''}>🗑 حذف</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch(e){
    listEl.innerHTML = '<div class="empty" style="color:var(--danger);">فشل تحميل المستخدمين</div>';
  }
}

async function addUser(){
  const name = document.getElementById('um_name').value.trim();
  const username = document.getElementById('um_username').value.trim();
  const password = document.getElementById('um_password').value;
  const role = document.getElementById('um_role').value;
  const dept = document.getElementById('um_dept').value;
  const msgEl = document.getElementById('um_addMsg');
  const btn = document.getElementById('um_addBtn');

  msgEl.className = 'um-msg';
  msgEl.style.display = 'none';

  if(!name || !username || !password){
    msgEl.textContent = 'من فضلك املأ جميع الحقول المطلوبة';
    msgEl.className = 'um-msg error show';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'جارِ الإضافة…';
  try{
    // ─── استخدام authFetch لإرسال الـ Token ─────────────────
    const res = await authFetch('/api/users',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name, username, password, role, department: role === 'dept_admin' ? dept : ''})
    });
    const data = await res.json();
    if(res.ok){
      msgEl.textContent = `✅ تم إضافة المستخدم "${name}" بنجاح`;
      msgEl.className = 'um-msg success show';
      document.getElementById('um_name').value = '';
      document.getElementById('um_username').value = '';
      document.getElementById('um_password').value = '';
      document.getElementById('um_role').value = 'hse_admin';
      renderUsersPanel();
    } else {
      msgEl.textContent = data.error || 'حصل خطأ في الإضافة';
      msgEl.className = 'um-msg error show';
    }
  } catch(e){
    msgEl.textContent = 'حصل خطأ في الاتصال بالسيرفر';
    msgEl.className = 'um-msg error show';
  }
  btn.disabled = false;
  btn.textContent = '➕ إضافة المستخدم';
}

async function deleteUser(id, name){
  if(!confirm(`هل أنت متأكد من حذف المستخدم "${name}"؟\nهذه العملية لا يمكن التراجع عنها.`)) return;
  try{
    // ─── استخدام authFetch لإرسال الـ Token ─────────────────
    const res = await authFetch(`/api/users/${encodeURIComponent(id)}`, {method:'DELETE'});
    const data = await res.json();
    if(res.ok){
      renderUsersPanel();
    } else {
      showToast(data.error || 'فشل حذف المستخدم', 'error');
    }
  } catch(e){
    showToast('حصل خطأ في الاتصال بالسيرفر', 'error');
  }
}

let umEditTargetId = '';

function toggleEditUmDept() {
  const role = document.getElementById('um_editRole').value;
  const deptRow = document.getElementById('um_editDeptRow');
  if (role === 'dept_admin') {
    deptRow.style.display = 'block';
  } else {
    deptRow.style.display = 'none';
  }
}

function openEditUserModal(userId){
  const user = window.umUsers.find(u => u.id === userId);
  if(!user) return;
  
  umEditTargetId = userId;
  document.getElementById('um_editModalName').textContent = `تعديل المستخدم: ${user.name}`;
  document.getElementById('um_editName').value = user.name || '';
  document.getElementById('um_editUsername').value = user.username || '';
  document.getElementById('um_editRole').value = user.role || 'hse_admin';
  document.getElementById('um_editDept').value = user.department || 'Administration';
  document.getElementById('um_editNewPass').value = '';
  
  toggleEditUmDept();
  
  const msg = document.getElementById('um_editMsg');
  msg.className = 'um-msg';
  document.getElementById('um_editModal').style.display = 'flex';
}

function closeEditUserModal(){
  document.getElementById('um_editModal').style.display = 'none';
  umEditTargetId = '';
}

async function saveUserEdit(){
  const name = document.getElementById('um_editName').value.trim();
  const username = document.getElementById('um_editUsername').value.trim();
  const role = document.getElementById('um_editRole').value;
  const dept = document.getElementById('um_editDept').value;
  const newPass = document.getElementById('um_editNewPass').value;
  
  const msgEl = document.getElementById('um_editMsg');
  msgEl.className = 'um-msg';
  
  if(!name || !username || !role){
    msgEl.textContent = 'من فضلك أملأ جميع الحقول المطلوبة';
    msgEl.className = 'um-msg error show';
    return;
  }
  if(newPass && newPass.length < 6){
    msgEl.textContent = 'كلمة المرور يجب أن تكون 6 أحرف على الأقل';
    msgEl.className = 'um-msg error show';
    return;
  }

  const payload = { name, username, role, department: role === 'dept_admin' ? dept : '' };
  if(newPass) payload.newPassword = newPass;

  try{
    const res = await authFetch(`/api/users/${encodeURIComponent(umEditTargetId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if(res.ok){
      msgEl.textContent = '✅ تم تحديث بيانات المستخدم بنجاح';
      msgEl.className = 'um-msg success show';
      setTimeout(() => {
        closeEditUserModal();
        renderUsersPanel();
      }, 1000);
    } else {
      msgEl.textContent = data.error || 'حصل خطأ أثناء التحديث';
      msgEl.className = 'um-msg error show';
    }
  } catch(e){
    msgEl.textContent = 'حصل خطأ في الاتصال بالسيرفر';
    msgEl.className = 'um-msg error show';
  }
}

// ---------- init ----------
initEmployeeSession();

// =====================================================================
// 🗂️ EMPLOYEE DIRECTORY — إدارة دليل الموظفين
// =====================================================================

let _allEmployees   = [];   // full list fetched from server
let _empEditCode    = null; // code being edited (null = add mode)
let _allHazardsCache = [];

// 🎯 Fixed annual targets (per employee, per year — NOT multiplied by period).
// Previously these scaled with the selected timeframe (8×months), which made
// the "target" balloon the longer the period — that was a bug, since 8h
// training / 2 hazard reports is the actual whole-year target.
const EMP_TARGET_TRAIN_HOURS = 8;
const EMP_TARGET_HAZARDS     = 2;

// "قريب من التارجت" threshold for training — reached at least this many hours
// but not yet the full annual target. Kept separate from the target itself so
// "حقق التارجت" (achieved) and "قريب من التارجت" (near) never overlap.
const EMP_NEAR_TRAIN_HOURS   = 6;

// Dashboard-only quarterly training target (see _dashGetCurrentQuarterInfo /
// _dashLoadTargetCompliance below). This does NOT change the fixed annual
// target used everywhere else (leaderboard, personal target progress, etc.).
const QUARTER_MONTHLY_TRAIN_TARGET_HOURS = 2;


const EMP_ROLE_LABELS = {
  worker:     'عامل / فني',
  supervisor: 'مشرف',
  area_head:  'رئيس قسم',
  contractor: 'مقاول / خارجي'
};

function empRoleLabel(r){ return EMP_ROLE_LABELS[r] || r || 'عامل'; }


function toArray(val) {
  if (Array.isArray(val)) return val;
  if (val && typeof val === 'object') {
    if (Array.isArray(val.trainings)) return val.trainings;
    if (Array.isArray(val.data)) return val.data;
    if (Array.isArray(val.hazards)) return val.hazards;
    if (Array.isArray(val.employees)) return val.employees;
    if (Array.isArray(val.penalties)) return val.penalties;
  }
  return [];
}

/** Render the employees table panel (fetches from server) */
async function renderEmployeesPanel() {
  const tableWrap = document.getElementById('empTableWrap');
  if (tableWrap) tableWrap.style.display = 'block';
  
  const listEl = document.getElementById('empDirList');
  if (listEl) listEl.innerHTML = '<div class="loading">جارِ تحميل الموظفين…</div>';

  // Sync user badge
  const emArea = document.getElementById('emUserProfileChip');
  const supChip = document.getElementById('supUserProfileChip');
  if (emArea && supChip) emArea.innerHTML = supChip.innerHTML;

  try {
    const [empRes, hazRes, trainRes, penRes] = await Promise.allSettled([
      authFetch('/api/employees'),
      authFetch('/api/hazards'),
      authFetch('/api/trainings'),
      authFetch('/api/penalties')
    ]);

    let empData = [];
    if (empRes.status === 'fulfilled' && empRes.value.ok) {
      empData = await empRes.value.json();
    } else {
      throw new Error('Failed to load employees from API');
    }

    if (hazRes.status === 'fulfilled' && hazRes.value.ok) {
      window._allHazardsCache = toArray(await hazRes.value.json());
    } else {
      window._allHazardsCache = [];
    }

    if (trainRes.status === 'fulfilled' && trainRes.value.ok) {
      window._trainingsCache = toArray(await trainRes.value.json());
    } else {
      window._trainingsCache = [];
    }

    if (penRes.status === 'fulfilled' && penRes.value.ok) {
      window._penaltiesCache = toArray(await penRes.value.json());
    } else {
      window._penaltiesCache = [];
    }

    const rawList = toArray(empData);
    window._masterEmployeesList = Object.freeze([...rawList]);
    
    renderEmployeesPanelUI();
    renderEmployeesTable(window._masterEmployeesList);
    renderModelEmployeeSection();
  } catch (err) {
    console.error('Error in renderEmployeesPanel:', err);
    if (listEl) listEl.innerHTML = `<p style="color:var(--danger); text-align:center; padding:2rem;">فشل تحميل الموظفين: ${err.message}</p>`;
  }
}

function normalizeCode(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim().replace(/^0+/, '') || '0';
}

function normalizeName(val) {
  if (!val) return '';
  return String(val).trim().toLowerCase().replace(/\s+/g, ' ');
}

function isEmployeeInAttendees(emp, attendees) {
  const empCodeNorm = normalizeCode(emp.code || emp.empCode || emp.id);
  const empNameNorm = normalizeName(emp.name);

  return toArray(attendees).some(att => {
    if (!att) return false;
    if (typeof att === 'string' || typeof att === 'number') {
      const attStr = normalizeCode(att);
      return (attStr && empCodeNorm && attStr === empCodeNorm) || normalizeName(att) === empNameNorm;
    }
    const attCode = normalizeCode(att.code || att.empCode || att.id || att.employeeId);
    const attName = normalizeName(att.name || att.empName || att.employeeName);
    return (attCode && empCodeNorm && attCode === empCodeNorm) || (attName && empNameNorm && attName === empNameNorm);
  });
}


function getTrainingDuration(t) {
  if (t && (t.durationHours !== undefined && t.durationHours !== null && t.durationHours !== '')) {
    return Number(t.durationHours);
  }
  if (t && (t.hours !== undefined && t.hours !== null && t.hours !== '')) {
    return Number(t.hours);
  }
  if (t && t.durationMinutes) {
    return Number(t.durationMinutes) / 60;
  }
  return 0.5; // Default standard session is strictly 0.5 hours (30 mins)
}

function computeEmployeeLiveStats(emp, cutoffDate = null, targetMonths = 1) {
  const empCodeNorm = normalizeCode(emp.code || emp.empCode || emp.id);
  const empNameNorm = normalizeName(emp.name);

  const hazardsList = toArray(window._allHazardsCache);
  const trainingsList = toArray(window._trainingsCache);

  // 1. Calculate Hazards Count
  const matchedHazards = hazardsList.filter(h => {
    if (cutoffDate) {
      const hDate = new Date(h.createdAt || h.date);
      if (hDate < cutoffDate) return false;
    }
    const hCode = normalizeCode(h.reporterCode || h.empCode || h.employeeCode || h.userId || '');
    const hName = normalizeName(h.reporterName || h.reportedBy || h.userName || '');
    const codeMatch = hCode && empCodeNorm && hCode === empCodeNorm;
    const nameMatch = hName && empNameNorm && (hName === empNameNorm || hName.includes(empNameNorm) || empNameNorm.includes(hName));
    return codeMatch || nameMatch;
  });

  // 2. Calculate Training Hours from Trainings Cache
  let matchedTrainingHours = 0;
  let attendedTrainingsCount = 0;
  const countedTrainingIds = new Set();

  trainingsList.forEach(t => {
    if (cutoffDate) {
      const tDate = new Date(t.date || t.createdAt);
      if (tDate < cutoffDate) return;
    }
    
    const tId = t._id || t.id || `${t.title}_${t.date}`;
    if (countedTrainingIds.has(tId)) return;

    if (isEmployeeInAttendees(emp, t.attendees || t.attendedEmployees)) {
      countedTrainingIds.add(tId);
      attendedTrainingsCount++;
      matchedTrainingHours += getTrainingDuration(t);
    }
  });

  // 3. Compute Composite Score (Points)
  // 10 points per hazard report + 10 points per training hour (0.5h = 5 points)
  const totalScore = (matchedHazards.length * 10) + (matchedTrainingHours * 10);

  const hTarget = EMP_TARGET_HAZARDS;
  const tTarget = EMP_TARGET_TRAIN_HOURS;
  const hPerc = Math.min(100, Math.round((matchedHazards.length / hTarget) * 100));
  const tPerc = Math.min(100, Math.round((matchedTrainingHours / tTarget) * 100));

  return {
    ...emp,
    hazardsCount: matchedHazards.length,
    trainingHours: matchedTrainingHours,
    trainingsCount: attendedTrainingsCount,
    totalScore: totalScore,
    hCount: matchedHazards.length,
    tHours: matchedTrainingHours,
    hPerc: hPerc,
    tPerc: tPerc,
    score: totalScore
  };
}

function computeAllStats(fullList, cutoffDate, targetMonths) {
  // Pre-process hazards and trainings to drastically improve performance (avoid freezing)
  const hazardsList = toArray(window._allHazardsCache).filter(h => {
    if (!cutoffDate) return true;
    const hDate = new Date(h.createdAt || h.date || h.submittedAt);
    return hDate >= cutoffDate;
  });
  hazardsList.forEach(h => {
    h._nCode = normalizeCode(h.reporterCode || h.empCode || h.employeeCode || h.userId || '');
    h._nName = normalizeName(h.reporterName || h.reportedBy || h.userName || '');
  });

  const trainingsList = toArray(window._trainingsCache).filter(t => {
    if (!cutoffDate) return true;
    const tDate = new Date(t.date || t.createdAt);
    return tDate >= cutoffDate;
  });
  trainingsList.forEach(t => {
    t._dur = getTrainingDuration(t);
    t._idKey = t._id || t.id || `${t.title}_${t.date}`;
    // Pre-normalize attendees
    let att = [];
    if (Array.isArray(t.attendees)) att = t.attendees;
    else if (Array.isArray(t.attendedEmployees)) att = t.attendedEmployees;
    t._att = att.map(a => ({
      _nCode: normalizeCode(a.id || a.code || a.empCode || ''),
      _nName: normalizeName(a.name || a.workerName || '')
    }));
  });

  const targetTrainHours = EMP_TARGET_TRAIN_HOURS;
  const targetHazards = EMP_TARGET_HAZARDS;

  return fullList.map(emp => {
    const eCode = normalizeCode(emp.code || emp.empCode || emp.id);
    const eName = normalizeName(emp.name);
    
    let hCount = 0;
    for (let i = 0; i < hazardsList.length; i++) {
      const h = hazardsList[i];
      if ((h._nCode && eCode && h._nCode === eCode) || (h._nName && eName && (h._nName === eName || h._nName.includes(eName) || eName.includes(h._nName)))) {
        hCount++;
      }
    }

    let tHours = 0;
    const countedT = new Set();
    for (let i = 0; i < trainingsList.length; i++) {
      const t = trainingsList[i];
      if (countedT.has(t._idKey)) continue;
      
      let matched = false;
      for (let j = 0; j < t._att.length; j++) {
        const a = t._att[j];
        if ((a._nCode && eCode && a._nCode === eCode) || (a._nName && eName && (a._nName === eName || a._nName.includes(eName) || eName.includes(a._nName)))) {
          matched = true;
          break;
        }
      }
      if (matched) {
        countedT.add(t._idKey);
        tHours += t._dur;
      }
    }

    let tPerc = Math.min(100, Math.round((tHours / targetTrainHours) * 100));
    let hPerc = Math.min(100, Math.round((hCount / targetHazards) * 100));
    let tScore = Math.round((tPerc + hPerc) / 2);

    return {
      ...emp,
      _stats: {
        hazardsCount: hCount,
        trainingHours: tHours,
        tPerc: tPerc,
        hPerc: hPerc,
        totalScore: tScore
      }
    };
  });
}

/** Renders the Dashboard (Filters, KPIs, Leaderboard) independently of the main table */
function renderEmployeesPanelUI() {
  const dashEl = document.getElementById('empDashboardWrap');
  if (!dashEl) return;
  
  const fullList = window._masterEmployeesList ? [...window._masterEmployeesList] : [];
  if (fullList.length === 0) {
    dashEl.innerHTML = '';
    return;
  }
  
  const lbTimeframe = typeof window.currentTableTimeframe !== 'undefined' ? window.currentTableTimeframe : '12';
  
  let cutoffDate = null;
  let targetMonths = parseInt(lbTimeframe) || 1;
  
  if (lbTimeframe !== 'all') {
    cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - targetMonths);
  } else {
    targetMonths = 12; // Default to 1 year target if 'all' is selected
  }

  const scoredEmployees = computeAllStats(fullList, cutoffDate, targetMonths);
  
  let totalTHours = 0;
  let totalHCount = 0;
  let totalTPerc = 0;
  
  scoredEmployees.forEach(emp => {
    totalTHours += emp._stats.trainingHours;
    totalHCount += emp._stats.hazardsCount;
    totalTPerc += emp._stats.tPerc;
  });

  const avgTPerc = scoredEmployees.length > 0 ? Math.round(totalTPerc / scoredEmployees.length) : 0;
  


  // 3. Generate Analytics Strip HTML
  const analyticsHtml = `
    <div class="emp-analytics-grid">
      <div class="emp-kpi-card">
        <div class="emp-kpi-icon">👥</div>
        <div class="emp-kpi-value">${scoredEmployees.length}</div>
        <div class="emp-kpi-label">إجمالي الموظفين</div>
      </div>
      <div class="emp-kpi-card">
        <div class="emp-kpi-icon">🎓</div>
        <div class="emp-kpi-value">${totalTHours}</div>
        <div class="emp-kpi-label">ساعات التدريب المنجزة</div>
      </div>
      <div class="emp-kpi-card">
        <div class="emp-kpi-icon">⚠️</div>
        <div class="emp-kpi-value">${totalHCount}</div>
        <div class="emp-kpi-label">بلاغات الخطورة المقدمة</div>
      </div>
      <div class="emp-kpi-card">
        <div class="emp-kpi-icon">📈</div>
        <div class="emp-kpi-value">${avgTPerc}%</div>
        <div class="emp-kpi-label">متوسط نسبة الالتزام</div>
      </div>
    </div>
  `;

  // 4. Generate Leaderboard HTML (REMOVED AS PER REQUEST)
  const lbHtml = '';

  dashEl.innerHTML = analyticsHtml + lbHtml;
}

// ══════════════════════════════════════════════════════════════
// 🏆 قائمة "العامل المثالي" (Model Employee leaderboard)
// ──────────────────────────────────────────────────────────────
// Top 10 employees ranked by a safety-commitment score built from the
// platform's existing annual targets (hazard reports + training hours,
// see EMP_TARGET_HAZARDS / EMP_TARGET_TRAIN_HOURS), minus a deduction for
// any active penalties/violations on record. This is a separate score
// from computeAllStats()'s totalScore (used elsewhere for an employee's
// own progress card) so changing the ranking formula here never affects
// that display.
//
// Visibility rules (per Ahmed's request):
//  - super_admin & hse_admin  → see the whole company, plus a department
//    filter that re-scopes the top-10 list to one department.
//  - dept_admin & maint_admin → only ever see their own department. No
//    filter needed — /api/employees already returns just their
//    department's employees for these roles, so the list is naturally
//    scoped with zero risk of leaking other departments' data.
//
// Assumption (not yet confirmed with Ahmed): scoring weighs hazard
// reporting and training completion equally (50/50, same as the existing
// per-employee "نسبة الالتزام" percentage), then subtracts 15 points per
// active penalty. Easy to tune — see MODEL_EMP_PENALTY_DEDUCTION below.
const MODEL_EMP_PENALTY_DEDUCTION = 15;

function computeModelEmployeeScore(emp, penaltiesList) {
  const code = normalizeCode(emp.code || emp.empCode || emp.id);
  const stats = emp._stats || { hPerc: 0, tPerc: 0, hazardsCount: 0, trainingHours: 0 };
  const activePenalties = penaltiesList.filter(p =>
    normalizeCode(p.empCode) === code && p.status !== 'cancelled' && p.status !== 'deleted'
  ).length;
  const safetyScore = Math.round((stats.hPerc + stats.tPerc) / 2); // 0-100, same basis as elsewhere
  const modelScore = Math.max(0, safetyScore - (activePenalties * MODEL_EMP_PENALTY_DEDUCTION));
  return {
    modelScore,
    activePenalties,
    hazardsCount: stats.hazardsCount,
    trainingHours: stats.trainingHours
  };
}

let _modelEmpDeptFilter = 'الكل'; // only meaningful for super_admin / hse_admin

async function renderModelEmployeeSection() {
  const wrap = document.getElementById('modelEmployeeWrap');
  if (!wrap) return;

  const fullList = window._masterEmployeesList ? [...window._masterEmployeesList] : [];
  if (fullList.length === 0) { wrap.innerHTML = ''; return; }

  const canFilterByDept = (currentUserRole === 'super_admin' || currentUserRole === 'hse_admin');

  let deptFilterHtml = '';
  if (canFilterByDept) {
    const realDepts = await loadRealDepartments();
    deptFilterHtml = `
      <select id="modelEmpDeptSelect" class="lb-filter-btn" style="cursor:pointer;padding:6px 10px;"
        onchange="setModelEmpDeptFilter(this.value)">
        <option value="الكل">🏢 كل الأقسام</option>
        ${realDepts.map(d => `<option value="${escapeAttr(d)}" ${_modelEmpDeptFilter === d ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}
      </select>`;
  }

  // dept_admin / maint_admin already only have their own department's
  // employees in fullList (enforced server-side in /api/employees).
  let scopedList = fullList;
  if (canFilterByDept && _modelEmpDeptFilter !== 'الكل') {
    scopedList = scopedList.filter(e => (e.department || '') === _modelEmpDeptFilter);
  }

  // Annual window, matching the "سنويًا" targets used across the platform.
  const yearStart = new Date(new Date().getFullYear(), 0, 1);
  const scored = computeAllStats(scopedList, yearStart, 12);
  const penalties = window._penaltiesCache || [];

  const ranked = scored
    .map(emp => ({ emp, ...computeModelEmployeeScore(emp, penalties) }))
    .sort((a, b) => {
      if (b.modelScore !== a.modelScore) return b.modelScore - a.modelScore;
      if (a.activePenalties !== b.activePenalties) return a.activePenalties - b.activePenalties;
      if (b.hazardsCount !== a.hazardsCount) return b.hazardsCount - a.hazardsCount;
      return b.trainingHours - a.trainingHours;
    })
    .slice(0, 10);

  const headerHtml = `
    <div class="leaderboard-header">
      <div class="leaderboard-title">🏆 العامل المثالي${_modelEmpDeptFilter !== 'الكل' ? ' — ' + escapeHtml(_modelEmpDeptFilter) : ''}</div>
      ${canFilterByDept ? `<div class="leaderboard-filters">${deptFilterHtml}</div>` : ''}
    </div>`;

  if (ranked.length === 0) {
    wrap.innerHTML = `
      <div class="emp-leaderboard-wrap">
        ${headerHtml}
        <div style="padding:20px;text-align:center;color:var(--muted);">لا توجد بيانات كافية لعرض القائمة${_modelEmpDeptFilter !== 'الكل' ? ' لهذا القسم' : ''}</div>
      </div>`;
    // Re-apply the select's value after innerHTML rebuild (it's inside headerHtml, already set via `selected` above)
    return;
  }

  const champion = ranked[0];
  const rest = ranked.slice(1);
  const rankClass = (i) => i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';

  wrap.innerHTML = `
    <div class="emp-leaderboard-wrap">
      ${headerHtml}
      <div class="leaderboard-content">
        <div class="lb-champion-card">
          <div class="lb-champion-crown">👑</div>
          <div class="lb-champion-title">العامل المثالي</div>
          <div class="lb-champion-name">${escapeHtml(champion.emp.name || '')}</div>
          <div class="lb-champion-dept">${escapeHtml(champion.emp.department || '')}${champion.emp.jobTitle ? ' · ' + escapeHtml(champion.emp.jobTitle) : ''}</div>
          <div class="lb-champion-stats">
            <div class="lb-stat"><div class="lb-stat-val">${champion.modelScore}%</div><div class="lb-stat-lbl">الالتزام</div></div>
            <div class="lb-stat"><div class="lb-stat-val">${champion.hazardsCount}</div><div class="lb-stat-lbl">بلاغات</div></div>
            <div class="lb-stat"><div class="lb-stat-val">${champion.trainingHours}</div><div class="lb-stat-lbl">ساعات تدريب</div></div>
          </div>
        </div>
        <div class="lb-list">
          ${rest.map((r, idx) => `
            <div class="lb-item">
              <div class="lb-item-rank ${rankClass(idx + 1)}">${idx + 2}</div>
              <div class="lb-item-info">
                <div class="lb-item-name">${escapeHtml(r.emp.name || '')}</div>
                <div class="lb-item-dept">${escapeHtml(r.emp.department || '')}${r.activePenalties ? ' · ⚠️ ' + r.activePenalties + ' جزاء' : ''}</div>
              </div>
              <div class="lb-item-score">${r.modelScore}%</div>
            </div>`).join('')}
        </div>
      </div>
    </div>`;
}

function setModelEmpDeptFilter(v) {
  _modelEmpDeptFilter = v || 'الكل';
  renderModelEmployeeSection();
}

function renderEmployeesTable(list) {
  const listEl = document.getElementById('empDirList');
  if (!listEl) return;
  
  // Set up the static table shell ONCE if it doesn't exist
  if (!document.getElementById('empTableBody')) {
    listEl.innerHTML = `
      <div class="um-table-wrap">
        <table class="um-table emp-dir-table">
          <thead>
            <tr>
              <th>#</th>
              <th>الكود</th>
              <th>الاسم الكامل</th>
              <th>القسم / المسمى</th>
              <th>⚠️ البلاغات</th>
              <th>🎓 المحاضرات</th>
              <th>🚨 تجارب الطوارئ</th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody id="empTableBody">
          </tbody>
        </table>
      </div>
      <div id="empTableCount" style="font-size:12px;color:var(--muted);margin-top:8px;text-align:left;"></div>
    `;
  }
  
  renderEmployeesTableRows(list);
}

window.handleEmployeeSearch = function(query) {
  const q = (query || '').trim().toLowerCase();
  const all = window._masterEmployeesList || [];
  
  if (!q) {
    renderEmployeesTableRows(all);
    return;
  }

  const cleanCode = String(query || '').trim().replace(/^0+/, '') || '0';
  
  const filtered = all.filter(emp => {
    const eName = (emp.name || '').toLowerCase();
    const eCode = String(emp.code || emp.empCode || '').toLowerCase();
    const eDept = (emp.department || '').toLowerCase();
    const eJob = (emp.jobTitle || '').toLowerCase();
    
    if (/^\d+$/.test(query)) {
      const eCodeNoZero = eCode.replace(/^0+/, '');
      return eCodeNoZero === cleanCode || eCode.includes(q);
    }
    
    return eName.includes(q) || eCode.includes(q) || eDept.includes(q) || eJob.includes(q);
  });

  window._currentVisibleEmployees = filtered;
  renderEmployeesTableRows(filtered);
};

function renderEmployeesTableRows(list) {
  const tbody = document.getElementById('empTableBody');
  const countEl = document.getElementById('empTableCount');
  if (!tbody) return;
  
  if (!Array.isArray(list)) list = [];
  
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty" style="padding:20px;text-align:center;"><div class="icon">👤</div>لا توجد نتائج مطابقة للبحث</div></td></tr>';
    if (countEl) countEl.innerText = 'إجمالي: 0 موظف';
    return;
  }
  
  const lbTimeframe = typeof window.currentTableTimeframe !== 'undefined' ? window.currentTableTimeframe : '12';
  let cutoffDate = null;
  let targetMonths = parseInt(lbTimeframe) || 1;
  if (lbTimeframe !== 'all') {
    cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - targetMonths);
  } else {
    targetMonths = 12;
  }

  // Re-process just the raw stats for the table rendering using the live stats compute function
  const processedList = computeAllStats(list, cutoffDate, targetMonths);

  tbody.innerHTML = processedList.map((e, i) => {
    const hTarget = EMP_TARGET_HAZARDS; // Fixed annual target (not scaled by period)
    const tTarget = EMP_TARGET_TRAIN_HOURS;
    const hCount = e._stats ? e._stats.hazardsCount : 0;
    const tHours = e._stats ? e._stats.trainingHours : 0;
    const hPerc = e._stats ? e._stats.hPerc : 0;
    const tPerc = e._stats ? e._stats.tPerc : 0;
    const dCount = e._stats && e._stats.drillsCount ? e._stats.drillsCount : 0;
    const hBadgeClass = hPerc >= 100 ? 'badge-green' : (hPerc >= 50 ? 'badge-yellow' : 'badge-red');
    const tBadgeClass = tPerc >= 100 ? 'badge-green' : (tPerc >= 50 ? 'badge-yellow' : 'badge-red');

    return `
    <tr>
      <td style="color:var(--muted);font-size:12px;">${i + 1}</td>
      <td style="font-family:'Oswald',sans-serif;font-size:13px;font-weight:700;letter-spacing:1px;color:var(--amber);">
        ${escapeHtml(e.empCode || e.code)}
      </td>
      <td style="font-weight:700;">${escapeHtml(e.name || '—')}</td>
      <td>
        <div style="font-size:13px;">${escapeHtml(e.department || '—')}</div>
        <div style="font-size:11px;color:var(--muted);">${escapeHtml(e.jobTitle || '—')}</div>
      </td>
      <td>
        <div style="font-size:12px; font-weight:bold; margin-bottom:4px;">${hCount} / ${hTarget} بلاغ</div>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="flex:1;background:var(--paper-line);height:8px;border-radius:4px;overflow:hidden;min-width:40px;">
            <div style="height:100%;width:${hPerc}%;background:var(--amber);"></div>
          </div>
          <span class="emp-role-badge ${hBadgeClass}" style="min-width:35px;text-align:center;font-size:10px;">${hPerc}%</span>
        </div>
      </td>
      <td>
        <div style="font-size:12px; font-weight:bold; margin-bottom:4px;">${tHours} / ${tTarget} ساعات</div>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="flex:1;background:var(--paper-line);height:8px;border-radius:4px;overflow:hidden;min-width:40px;">
            <div style="height:100%;width:${tPerc}%;background:var(--amber);"></div>
          </div>
          <span class="emp-role-badge ${tBadgeClass}" style="min-width:35px;text-align:center;font-size:10px;">${tPerc}%</span>

        </div>
      </td>
      <td>
        <div style="font-size:12px; font-weight:bold; margin-bottom:4px; color:var(--danger);">${dCount} تجربة</div>
      </td>
      <td>
        <div class="um-action-btns">
          <button class="um-btn pass" onclick="openEmpModal('${escapeHtml(e.empCode || e.code)}')">✏️ تعديل</button>
          <button class="um-btn del"  onclick="deleteEmployee('${escapeHtml(e.empCode || e.code)}','${escapeHtml(e.name||'')}')">🗑 حذف</button>
        </div>
      </td>
    </tr>
    `;
  }).join('');
  
  if (countEl) countEl.innerText = `إجمالي: ${list.length} موظف`;
  
  // Track currently displayed employee objects for filtered export
  window._currentVisibleEmployees = list;
}
function openEmpModal(code = null) {
  _empEditCode = code;
  const titleEl = document.getElementById('empModalTitle');
  const codeEl  = document.getElementById('em_code');

  if (code) {
    // Edit mode
    const emp = _allEmployees.find(e => e.empCode === code);
    if (!emp) return;
    if (titleEl) titleEl.textContent = `✏️ تعديل: ${emp.empCode}`;
    if (codeEl) { codeEl.value = emp.empCode; codeEl.setAttribute('readonly','readonly'); }
    const set = (id, val) => { const el = document.getElementById(id); if(el) el.value = val || ''; };
    set('em_name',     emp.name);
    set('em_dept',     emp.department);
    set('em_jobTitle', emp.jobTitle);
    set('em_role',     emp.role || 'worker');
    set('em_phone',    emp.phone);
  } else {
    // Add mode
    if (titleEl) titleEl.textContent = '➕ إضافة موظف جديد';
    if (codeEl) { codeEl.value = ''; codeEl.removeAttribute('readonly'); }
    ['em_name','em_dept','em_jobTitle','em_phone'].forEach(id => {
      const el = document.getElementById(id); if(el) el.value = '';
    });
    const roleEl = document.getElementById('em_role');
    if (roleEl) roleEl.value = 'worker';
  }

  const msgEl = document.getElementById('em_msg');
  if (msgEl) { msgEl.className = 'um-msg'; msgEl.textContent = ''; }
  document.getElementById('empModal').style.display = 'flex';
}

function closeEmpModal() {
  document.getElementById('empModal').style.display = 'none';
  _empEditCode = null;
}

/** Save (add or update) an employee */
async function saveEmployee() {
  const code     = document.getElementById('em_code')?.value.trim();
  const name     = document.getElementById('em_name')?.value.trim();
  const dept     = document.getElementById('em_dept')?.value.trim();
  const jobTitle = document.getElementById('em_jobTitle')?.value.trim();
  const role     = document.getElementById('em_role')?.value;
  const phone    = document.getElementById('em_phone')?.value.trim();
  const msgEl    = document.getElementById('em_msg');

  if (!code || !name) {
    if (msgEl) { msgEl.textContent = 'الكود والاسم مطلوبان'; msgEl.className = 'um-msg error show'; }
    return;
  }

  try {
    let res;
    if (_empEditCode) {
      // Update
      res = await authFetch(`/api/employees/${encodeURIComponent(_empEditCode)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, department: dept, jobTitle, role, phone })
      });
    } else {
      // Add
      res = await authFetch('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empCode: code, name, department: dept, jobTitle, role, phone })
      });
    }
    const data = await res.json();
    if (res.ok) {
      if (msgEl) { msgEl.textContent = '✅ تم الحفظ بنجاح'; msgEl.className = 'um-msg success show'; }
      setTimeout(() => { closeEmpModal(); renderEmployeesPanel(); }, 900);
    } else {
      if (msgEl) { msgEl.textContent = data.error || 'فشل الحفظ'; msgEl.className = 'um-msg error show'; }
    }
  } catch(e) {
    if (msgEl) { msgEl.textContent = 'خطأ في الاتصال'; msgEl.className = 'um-msg error show'; }
  }
}

/** Delete an employee */
async function deleteEmployee(code, name) {
  if (!confirm(`هل تريد حذف الموظف "${name}" (${code})؟\nهذه العملية لا يمكن التراجع عنها.`)) return;
  try {
    const res  = await authFetch(`/api/employees/${encodeURIComponent(code)}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      showToast(`تم حذف الموظف ${name} بنجاح`, 'success');
      renderEmployeesPanel();
    } else {
      showToast(data.error || 'فشل الحذف', 'error');
    }
  } catch(e) {
    showToast('خطأ في الاتصال', 'error');
  }
}

/** Import employees from an Excel file (reads file → base64 → POST) */
async function importEmployeesExcel(input) {
  const file = input?.files?.[0];
  if (!file) return;
  // Reset input so the same file can be re-selected
  input.value = '';

  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64 = btoa(
      new Uint8Array(e.target.result).reduce((s, b) => s + String.fromCharCode(b), '')
    );
    showToast('جارِ رفع الملف وتحليله…', 'info');
    try {
      const res  = await authFetch('/api/employees/import-excel', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fileData: base64 })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`✅ تم الاستيراد: ${data.added} جديد، ${data.updated} محدّث (الإجمالي: ${data.total})`, 'success');
        renderEmployeesPanel();
      } else {
        showToast(data.error || 'فشل الاستيراد', 'error');
      }
    } catch(err) {
      showToast('خطأ في الاتصال أثناء الاستيراد', 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

/** Export employees as Excel — client-side using already-loaded data for instant filtered export */
window.exportEmployeesExcel = function() {
  const dataToExport = (window._currentVisibleEmployees && window._currentVisibleEmployees.length > 0)
    ? window._currentVisibleEmployees
    : (window._masterEmployeesList || []);

  if (!dataToExport || dataToExport.length === 0) {
    showToast('لا توجد بيانات لتصديرها', 'error');
    return;
  }

  try {
    const lbTimeframe = typeof window.currentTableTimeframe !== 'undefined' ? window.currentTableTimeframe : '12';
    let cutoffDate = null;
    let targetMonths = parseInt(lbTimeframe) || 1;
    if (lbTimeframe !== 'all') {
      cutoffDate = new Date();
      cutoffDate.setMonth(cutoffDate.getMonth() - targetMonths);
    } else {
      targetMonths = 12;
    }

    const hTarget = EMP_TARGET_HAZARDS;
    const tTarget = EMP_TARGET_TRAIN_HOURS;

    const scoredData = computeAllStats(dataToExport, cutoffDate, targetMonths);

    const rows = scoredData.map(emp => {
      const hCount = emp._stats ? emp._stats.hazardsCount : 0;
      const tHours = emp._stats ? emp._stats.trainingHours : 0;
      const hPerc = emp._stats ? emp._stats.hPerc : 0;
      const tPerc = emp._stats ? emp._stats.tPerc : 0;
      const tScore = emp._stats ? emp._stats.totalScore : 0;
      const dCount = emp._stats && emp._stats.drillsCount ? emp._stats.drillsCount : 0;

      return {
        'الكود الوظيفي': emp.empCode || emp.emp_code || emp.code || '',
        'الاسم الكامل': emp.name || '',
        'القسم': emp.department || '',
        'المسمى الوظيفي': emp.jobTitle || emp.position || emp.title || '',
        'ساعات التدريب': tHours,
        'تارجت التدريب (ساعات)': tTarget,
        'نسبة تحقيق التدريب': `${tPerc}%`,
        'بلاغات الخطورة': hCount,
        'تارجت البلاغات': hTarget,
        'نسبة تحقيق البلاغات': `${hPerc}%`,
        'تجارب الطوارئ': dCount,
        'نقاط التميز': tScore,
        'الصلاحية': emp.role || 'worker',
        'رقم التليفون': emp.phone || emp.mobile || ''
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'قاعدة الموظفين');
    
    const filterName = lbTimeframe === 'all' ? 'سنة_كاملة' : `${lbTimeframe}_أشهر`;
    XLSX.writeFile(wb, `employees_stats_${filterName}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    showToast(`تم تصدير ${scoredData.length} موظف مع الإحصائيات بنجاح 📊`, 'success');
  } catch(e) {
    console.error('Export error:', e);
    showToast('خطأ أثناء التصدير', 'error');
  }
};


// ================================================================
// === تبويب "سجل طلباتي" (My Permits History) ===
// ================================================================

const MY_HISTORY_FILTERS = ['الكل', 'بانتظار أدمن القسم', 'بانتظار السلامة والصحة المهنية', 'موافق عليه', 'مرفوض', 'مغلق'];

function myHistoryFilterMatch(p){
  if(myHistoryFilter === 'الكل') return true;
  if(myHistoryFilter === 'بانتظار أدمن القسم') return p.status === 'pending' || p.status === 'pending_dept' || p.status === 'pending_area_head';
  if(myHistoryFilter === 'بانتظار السلامة والصحة المهنية') return p.status === 'pending_hse';
  if(myHistoryFilter === 'موافق عليه') return p.status === 'approved';
  if(myHistoryFilter === 'مرفوض') return p.status === 'rejected' || p.status === 'rejected_area' || p.status === 'rejected_high_management';
  if(myHistoryFilter === 'مغلق') return p.status && p.status.startsWith('closed');
  return true;
}

function setMyHistoryFilter(f){
  myHistoryFilter = f;
  renderMyHistory(true);
}

async function renderMyHistory(isSilent = false){
  if(!currentEmployee){
    const list = document.getElementById('myHistoryList');
    if(list) list.innerHTML = `<div class="empty"><div class="icon">🔒</div>سجّل دخولك أولاً لعرض سجل طلباتك</div>`;
    return;
  }

  // عرض شريط الفلاتر
  const filtersEl = document.getElementById('myHistoryFilters');
  if(filtersEl){
    filtersEl.innerHTML = MY_HISTORY_FILTERS.map(f =>
      `<button class="mh-filter-btn ${f === myHistoryFilter ? 'active' : ''}" onclick="setMyHistoryFilter('${f}')">${f}</button>`
    ).join('');
  }

  // عرض بيانات الموظف
  const subEl = document.getElementById('myHistorySub');
  if(subEl) subEl.textContent = `${escapeHtml(currentEmployee.name)} · ${escapeHtml(currentEmployee.empCode)} · ${escapeHtml(currentEmployee.department || '')}`;

  const listEl = document.getElementById('myHistoryList');
  if(!isSilent && listEl) listEl.innerHTML = '<div class="loading">جارِ تحميل سجلك…</div>';

  const res = await apiGet('work-permits');
  const raw = res && res.value ? res.value : '[]';
  lastMyHistoryRaw = raw;
  const all = JSON.parse(raw);

  // فلترة بالكود الوظيفي لهذا الموظف فقط
  const myPermits = all
    .filter(p => p.employeeId && p.employeeId.toLowerCase() === currentEmployee.empCode.toLowerCase())
    .filter(p => {
      const deletedBy = (typeof p.deletedBy === 'object' && p.deletedBy !== null) ? p.deletedBy : {};
      const deletedByWorker = deletedBy.worker !== undefined ? deletedBy.worker : !!p.deleted;
      return !deletedByWorker;
    })
    .filter(p => myHistoryFilterMatch(p))
    .reverse();

  if(!listEl) return;

  if(myPermits.length === 0){
    listEl.innerHTML = `<div class="empty"><div class="icon">📂</div>لا توجد طلبات ${myHistoryFilter !== 'الكل' ? 'بهذا الفلتر' : 'بعد'}</div>`;
    return;
  }

  listEl.innerHTML = myPermits.map(p => {
    const st = p.status ? String(p.status).toLowerCase() : 'pending';
    let stampClass = st.startsWith('closed') ? 'approved' : st;
    if (st.startsWith('rejected')) stampClass = 'rejected';
    const stampText = getStatusBadgeArabic(st) + (st.startsWith('closed') ? ' — ' + closureLabel(p.closure) : '');
    return `
    <div class="permit-history-card">
      <div class="phc-top">
        <div>
          <div class="phc-type-pill">${escapeHtml(p.typeLabel || '')}</div>
          <div class="phc-id">${escapeHtml(p.id)}</div>
          <div class="phc-date">${escapeHtml(p.date || '')} · وردية ${escapeHtml(p.shift || '')}</div>
        </div>
        <span class="stamp ${stampClass}">${stampText}</span>
      </div>
      <div class="phc-meta">
        <div><span>مكان العمل</span>${escapeHtml(p.location || '—')}</div>
        <div><span>القسم</span>${escapeHtml(p.department || '—')}</div>
      </div>
      <div class="phc-desc">${escapeHtml(p.description || '')}</div>
      ${(st === 'pending' || st === 'pending_dept') ? `<div class="phc-msg pending">⏳ بانتظار موافقة أدمن القسم</div>` : ''}
      ${st === 'pending_hse' ? `<div class="phc-msg pending">✅ تمت موافقة القسم (بانتظار اعتماد السلامة والصحة المهنية)</div>` : ''}
      ${st === 'approved' ? `
        <div class="phc-msg approved">🟢 تم الاعتماد النهائي للطلب — يمكنك الإغلاق بعد الانتهاء</div>
        <div class="closure-box" style="margin-top:8px;">
          <div class="field"><input id="myhistory-closereason-${p.id}" type="text" placeholder="سبب عدم الاكتمال أو الإغلاق الجبري (إن وجد)" style="font-size:12px;padding:6px;"></div>
          <div class="closure-actions" style="margin-top:4px;">
            <button style="color:var(--success);" onclick="workerClosePermit('${p.id}','safe')">اكتمل بأمان</button>
            <button style="color:var(--amber);" onclick="workerClosePermit('${p.id}','incomplete')">لم يكتمل</button>
            <button style="color:var(--danger);" onclick="workerClosePermit('${p.id}','forced')">إغلاق جبري</button>
          </div>
        </div>
      ` : ''}
      ${st === 'rejected' ? `<div class="phc-msg rejected">❌ تم رفض الطلب${p.reviewNote ? ' — السبب: ' + escapeHtml(p.reviewNote) : ''}</div>` : ''}
      ${st.startsWith('closed') ? `<div class="phc-msg muted">🔒 مغلق: ${closureLabel(p.closure)}${p.closure && p.closure.reason ? ' — ' + escapeHtml(p.closure.reason) : ''}</div>` : ''}
      <div class="phc-submitted">أرسل ${p.submittedAt ? new Date(p.submittedAt).toLocaleString('ar-EG') : ''}</div>
    </div>
    `;
  }).join('');
}

async function pollMyHistory(){
  const view = document.getElementById('viewMyHistory');
  if(!view || view.style.display === 'none') return;
  if(!currentEmployee) return;
  const res = await apiGet('work-permits');
  const raw = res && res.value ? res.value : '[]';
  if(raw !== lastMyHistoryRaw){
    renderMyHistory(true);
  }
}

// ============================================================
// ⚠️ HAZARD REPORTING SYSTEM
// ============================================================

async function renderMyHazards(isSilent = false) {
  if (!currentEmployee) {
    const list = document.getElementById('myHazardsList');
    if (list) list.innerHTML = `<div class="empty"><div class="icon">🔒</div>سجّل دخولك أولاً لعرض سجل بلاغاتك</div>`;
    return;
  }

  const subEl = document.getElementById('myHazardsSub');
  if (subEl) subEl.textContent = `${escapeHtml(currentEmployee.name)} · ${escapeHtml(currentEmployee.empCode)}`;

  const listEl = document.getElementById('myHazardsList');
  if (!isSilent && listEl) listEl.innerHTML = '<div class="loading">جارِ تحميل بلاغاتك…</div>';

  try {
    const res = await fetch(`/api/my-hazards/${encodeURIComponent(currentEmployee.name)}?empCode=${encodeURIComponent(currentEmployee.empCode || currentEmployee.code || '')}`);
    if (!res.ok) throw new Error('Failed to fetch');
    const data = await res.json();
    const myHazards = data.hazards || [];
    window.lastMyHazardsData = JSON.stringify(myHazards);
    
    if (myHazards.length === 0) {
      if (listEl) listEl.innerHTML = `<div class="empty"><div class="icon">📂</div>لا توجد بلاغات مسجلة</div>`;
      return;
    }

    let html = '';
    myHazards.reverse().forEach(h => {
      let statusStr = 'مفتوح 🔴';
      let statusClass = 'hz-high';
      let pendingDesc = 'بانتظار مراجعة المشرف';
      
      if (h.status === 'notified') {
        statusStr = 'تم الإبلاغ 📢';
        statusClass = 'hz-medium';
        pendingDesc = 'تم إبلاغ القسم المعني والمتخصصين';
      } else if (h.status === 'in_progress') {
        statusStr = 'قيد المعالجة والإصلاح 🟡';
        statusClass = 'hz-medium';
        pendingDesc = 'جاري العمل على حل المشكلة';
      } else if (h.status === 'resolved' || h.status === 'closed') {
        statusStr = 'تم الحل وإغلاق البلاغ 🟢';
        statusClass = 'hz-low';
        pendingDesc = 'تمت المعالجة بنجاح';
      } else if (h.status && h.status.startsWith('rejected')) {
        statusStr = 'مرفوض ❌';
        statusClass = 'hz-high';
        pendingDesc = 'تم رفض البلاغ';
      }
      
      let riskStr = h.riskLevel === 'H' ? 'High 🔴' : h.riskLevel === 'M' ? 'Medium 🟡' : 'Low 🟢';
      let riskClass = h.riskLevel === 'H' ? 'hz-high' : h.riskLevel === 'M' ? 'hz-medium' : 'hz-low';

      html += `
        <div class="sup-card" style="margin-bottom:12px;">
          <div class="sup-top">
            <div>
              <div class="hz-status-badge ${statusClass}">${statusStr}</div>
            </div>
            <div class="tnum">${h.id}</div>
          </div>
          <div class="meta-grid">
            <div><span>التاريخ</span>${h.date}</div>
            <div><span>القسم</span>${escapeHtml(h.department)}</div>
            <div><span>المنطقة</span>${escapeHtml(h.area)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:12px;margin:12px 0;">
            <span style="font-size:12px; font-weight:bold;">مستوى الخطورة:</span>
            <div class="hz-risk-badge ${riskClass}" style="margin:0; padding:4px 8px; font-size:11.5px;">${riskStr}</div>
          </div>
          <div class="desc"><strong>وصف الخطورة:</strong><br>${escapeHtml(h.description)}</div>
          ${h.photoUrl ? `<div style="margin-top:8px;"><div class="hz-photo-badge" onclick="openLightbox('${h.photoUrl}')">🖼️ عرض الصورة</div></div>` : ''}
          <div class="phc-msg" style="margin-top:10px; font-size:12px; color:var(--muted);">${pendingDesc}</div>
          ${h.actionTaken ? `<div class="note-box show" style="margin-top:10px; background-color: #f8f9fa; border-left: 4px solid var(--primary); padding: 10px; border-radius: 4px;">
            <strong>🛠️ الإجراء المتخذ من المشرف (${escapeHtml(h.updatedBy || 'إدارة السلامة')}):</strong><br>
            ${escapeHtml(h.actionTaken)}
          </div>` : ''}
          <div class="hazard-timeline">
            <div class="timeline-step done">
              <span class="step-icon">📝</span>
              <div class="step-info">
                <strong>وقت الإرسال:</strong>
                <span>${formatDateTime(h.submittedAt || h.createdAt)}</span>
              </div>
            </div>
            <div class="timeline-step ${h.seenAt ? 'done' : 'pending'}">
              <span class="step-icon">👁️</span>
              <div class="step-info">
                <strong>وقت المشاهدة من المشرف:</strong>
                <span>${h.seenAt ? `${formatDateTime(h.seenAt)} (${escapeHtml(h.seenBy || 'المشرف')})` : 'لم تتم المشاهدة بعد'}</span>
              </div>
            </div>
            <div class="timeline-step ${h.inProgressAt ? 'done' : 'pending'}">
              <span class="step-icon">⚙️</span>
              <div class="step-info">
                <strong>وقت بدء المعالجة:</strong>
                <span>${h.inProgressAt ? `${formatDateTime(h.inProgressAt)} (${escapeHtml(h.inProgressBy || 'الصيانة')})` : 'بانتظار البدء'}</span>
              </div>
            </div>
            <div class="timeline-step ${h.resolvedAt ? 'done' : 'pending'}">
              <span class="step-icon">✅</span>
              <div class="step-info">
                <strong>وقت الانتهاء والإغلاق:</strong>
                <span>${h.resolvedAt ? `${formatDateTime(h.resolvedAt)} (${escapeHtml(h.resolvedBy || 'المشرف')})` : 'لم ينتهِ بعد'}</span>
              </div>
            </div>
            ${h.status && h.status.startsWith('rejected') ? `
            <div class="timeline-step done" style="border-left-color: var(--danger);">
              <span class="step-icon" style="background: var(--danger); color: white;">❌</span>
              <div class="step-info">
                <strong style="color: var(--danger);">تم رفض البلاغ:</strong>
                <span>${h.rejectedAt ? `${formatDateTime(h.rejectedAt)} (بواسطة: ${escapeHtml(h.rejectedBy || 'المشرف')})` : '—'}</span>
                <br><span style="color: var(--danger); font-size: 11px;">سبب الرفض: ${escapeHtml(h.rejectionReason || h.reason || 'لم يتم تحديد سبب')}</span>
              </div>
            </div>
            ` : ''}
          </div>
        </div>
      `;
    });
    if (listEl) listEl.innerHTML = html;
  } catch (e) {
    if (listEl) listEl.innerHTML = '<div class="empty">خطأ في جلب البيانات</div>';
  }
}

// pollMyHazards logic merged into silentRefreshHazards

function initHazardWorker() {
  const elDate = document.getElementById('hz_date');
  if (elDate && !elDate.value) {
    elDate.value = new Date().toISOString().split('T')[0];
  }
  calculateHazardRisk();

  const codeWrap = document.getElementById('hz_codeFieldWrap');
  if (currentEmployee) {
    // Session active: auto-fill and hide the code lookup field
    const elName = document.getElementById('hz_name');
    if (elName && !elName.value) elName.value = currentEmployee.name;
    const elDept = document.getElementById('hz_dept');
    if (elDept) elDept.value = currentEmployee.department || '';
    // Hide the code lookup field since we already have session data
    if (codeWrap) codeWrap.style.display = 'none';
  } else {
    // No session: show code lookup, clear previous auto-fills
    if (codeWrap) codeWrap.style.display = 'block';
    const empCodeEl = document.getElementById('hz_empCode');
    if (empCodeEl) empCodeEl.value = '';
    const msgEl = document.getElementById('hz_codeMsg');
    if (msgEl) msgEl.textContent = '';
  }
}

/** Employee code lookup for the Hazard form */
async function lookupHazardEmpCode() {
  const codeEl = document.getElementById('hz_empCode');
  const msgEl  = document.getElementById('hz_codeMsg');
  if (!codeEl || !codeEl.value.trim()) return;
  const rawInput = codeEl.value;
  const cleanCode = String(rawInput || '').trim().replace(/^0+/, '') || '0';
  try {
    const res  = await fetch(`/api/employees/lookup/${encodeURIComponent(cleanCode)}`);
    const data = await res.json();
    if (data.found) {
      const emp = data.employee;
      const nameEl = document.getElementById('hz_name');
      const deptEl = document.getElementById('hz_dept');
      if (nameEl) { nameEl.value = emp.name; nameEl.setAttribute('readonly','readonly'); }
      if (deptEl) deptEl.value = emp.department || '';
      if (msgEl) { msgEl.textContent = `✅ ${emp.name} — ${emp.department || ''}`; msgEl.style.color = 'var(--success)'; }
    } else {
      if (msgEl) { msgEl.textContent = 'الكود غير مسجل، يرجى كتابة البيانات يدوياً'; msgEl.style.color = 'var(--muted)'; }
      const nameEl = document.getElementById('hz_name');
      if (nameEl) nameEl.removeAttribute('readonly');
    }
  } catch(e) {
    if (msgEl) { msgEl.textContent = 'خطأ في البحث'; msgEl.style.color = 'var(--danger)'; }
  }
}

function calculateHazardRisk() {
  const likelihoodEl = document.getElementById('hz_likelihood');
  const severityEl = document.getElementById('hz_severity');
  if (!likelihoodEl || !severityEl) return;

  const l = parseInt(likelihoodEl.value, 10) || 1;
  const sMap = { 'A': 1, 'B': 2, 'C': 3, 'D': 4, 'E': 5 };
  const sVal = severityEl.value;
  const s = sMap[sVal] || 1;
  
  const score = l * s;
  let level = 'L';
  let badgeClass = 'hz-low';
  let text = 'Low (L) 🟢';

  if (score >= 10 && score <= 14) { 
      level = 'M';
      badgeClass = 'hz-medium';
      text = 'Medium (M) 🟡';
  } else if (score >= 15) {
      level = 'H';
      badgeClass = 'hz-high';
      text = 'High (H) 🔴';
  } else if (score >= 5 && score < 15) {
      level = 'M';
      badgeClass = 'hz-medium';
      text = 'Medium (M) 🟡';
  } else {
      level = 'L';
      badgeClass = 'hz-low';
      text = 'Low (L) 🟢';
  }

  const badge = document.getElementById('hz_riskBadge');
  if (badge) {
    badge.className = `hz-risk-badge ${badgeClass}`;
    badge.textContent = text;
    badge.dataset.level = level;
  }
}

let currentHazardPhotoBase64 = null;
function handleHazardPhotoSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const canvas = document.createElement('canvas');
      const MAX_WIDTH = 1200;
      let width = img.width;
      let height = img.height;
      if (width > MAX_WIDTH) {
        height = Math.round(height * MAX_WIDTH / width);
        width = MAX_WIDTH;
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.75);
      document.getElementById('hz_photoPreviewImg').src = compressedDataUrl;
      document.getElementById('hz_photoPreviewBox').style.display = 'block';
      currentHazardPhotoBase64 = compressedDataUrl;
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}
function confirmHazardPhoto() {
  showToast('تم اعتماد الصورة بنجاح ✅', 'success');
}
function removeHazardPhoto() {
  currentHazardPhotoBase64 = null;
  document.getElementById('hz_photoPreviewImg').src = '';
  document.getElementById('hz_photoPreviewBox').style.display = 'none';
  document.getElementById('hz_photoInput').value = '';
}

async function submitHazardReport() {
  const reporterName = document.getElementById('hz_name').value.trim();
  const date = document.getElementById('hz_date').value;
  const department = document.getElementById('hz_dept').value;
  const area = document.getElementById('hz_area').value.trim();
  const description = document.getElementById('hz_desc').value.trim();
  const potentialInjury = document.getElementById('hz_injury').value.trim();
  const proposedSolution = document.getElementById('hz_solution').value.trim();
  const likelihood = document.getElementById('hz_likelihood').value;
  const severity = document.getElementById('hz_severity').value;
  
  const empCodeInput = document.getElementById('hz_empCode');
  const empCode = empCodeInput ? empCodeInput.value.trim() : '';

  const riskBadge = document.getElementById('hz_riskBadge');
  const riskLevel = riskBadge ? riskBadge.dataset.level : 'L';

  if (!reporterName || !date || !department || !area || !description || !potentialInjury) {
    showToast('يرجى ملء جميع الحقول المطلوبة', 'error');
    return;
  }

  const btn = document.getElementById('hz_submitBtn');
  btn.disabled = true;
  btn.textContent = 'جارِ الإرسال...';

  try {
    const payload = {
      reporterName, empCode, date, department, area, description, potentialInjury, proposedSolution,
      likelihood, severity, riskLevel
    };
    if (currentHazardPhotoBase64) {
      payload.photo = currentHazardPhotoBase64;
    }
    
    console.log('[submitHazardReport] Sending payload:', payload);

    const res = await fetch('/api/hazards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (res.ok) {
      const result = await res.json();
      console.log('[submitHazardReport] Server response success:', result);
      
      const msgEl = document.getElementById('hz_msg');
      if (msgEl) {
        msgEl.className = 'wl-msg success';
        msgEl.textContent = 'تم إرسال البلاغ بنجاح! شكراً لتعاونك.';
        setTimeout(() => msgEl.textContent = '', 5000);
      }
      showToast('تم إرسال البلاغ بنجاح! شكراً لتعاونك.', 'success');
      // Reset form
      document.getElementById('hz_area').value = '';
      document.getElementById('hz_desc').value = '';
      document.getElementById('hz_injury').value = '';
      document.getElementById('hz_solution').value = '';
      document.getElementById('hz_likelihood').value = '1';
      document.getElementById('hz_severity').value = 'A';
      calculateHazardRisk();
      removeHazardPhoto();
    } else {
      const data = await res.json();
      showToast(data.error || 'حدث خطأ أثناء الإرسال', 'error');
    }
  } catch (err) {
    showToast('خطأ في الاتصال بالخادم', 'error');
  }

  btn.disabled = false;
  btn.textContent = 'إرسال البلاغ ←';
}

// Supervisor Hazard Functions
let currentHzStatusFilter = 'الكل';
let currentHzDeptFilter = 'الكل';
let currentHzSeverityFilter = 'الكل';
let currentHzYearFilter = 'الكل';

function formatDateTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });
}

function getHazardCardHtml(h) {
  let riskStr = h.riskLevel === 'H' ? 'High 🔴' : h.riskLevel === 'M' ? 'Medium 🟡' : 'Low 🟢';
  let riskClass = h.riskLevel === 'H' ? 'hz-high' : h.riskLevel === 'M' ? 'hz-medium' : 'hz-low';
  
  let statusStr = 'مفتوح 🔴';
  let statusClass = 'hz-status-open';
  if (h.status === 'assigned_to_maintenance') { statusStr = `تم التوجيه لـ: ${h.assignedToMaintenance || 'الصيانة'} 📢`; statusClass = 'hz-status-in_progress'; }
  if (h.status === 'in_progress') { statusStr = 'قيد الإصلاح 🟡'; statusClass = 'hz-status-in_progress'; }
  if (h.status === 'rejected_by_maintenance') { statusStr = 'مرفوض (صيانة) ❌'; statusClass = 'hz-status-rejected'; }
  if (h.status === 'rejected_by_hse') { statusStr = 'مرفوض 🚫'; statusClass = 'hz-status-rejected'; }
  if (h.status === 'resolved' || h.status === 'closed') { statusStr = 'تم الإصلاح والإغلاق 🟢'; statusClass = 'hz-status-resolved'; }
  if (h.deleted) { statusStr = 'محذوف 🗑️'; statusClass = 'hz-status-resolved'; }

  let actionHtml = '';
  if (!h.deleted) {
    if (h.status === 'rejected_by_maintenance') {
      actionHtml = `<div class="desc" style="margin-top:10px; background:rgba(220,38,38,0.08); padding:8px; border-radius:4px; border:1px solid rgba(220,38,38,0.25);">
        <strong>سبب رفض الصيانة (${escapeHtml(h.assignedToMaintenance || '')}):</strong><br>${escapeHtml(h.maintRejectReason || '')}
        <br><span style="font-size:11px;color:var(--danger);">بواسطة: ${escapeHtml(h.maintRejectedBy || '')}</span>
      </div>`;
      if (currentUserRole === 'hse_admin' || currentUserRole === 'super_admin') {
        actionHtml += `<div style="display:flex; gap:8px; margin-top:8px;">
          <button onclick="openHzAssignModal('${h.id}')" class="btn-cyan" style="flex:1;">📢 إعادة التوجيه لقسم آخر</button>
          <button onclick="openHzRejectHseModal('${h.id}')" class="act-btn approve" style="background:var(--danger); color:#fff;">🚫 رفض البلاغ نهائياً</button>
        </div>`;
      }
    } else if (h.status === 'rejected_by_hse') {
      actionHtml = `<div class="desc" style="margin-top:10px; background:rgba(220,38,38,0.08); padding:8px; border-radius:4px; border:1px solid rgba(220,38,38,0.25);">
        <strong>سبب رفض المشرف:</strong><br>${escapeHtml(h.hseRejectReason || '')}
        <br><span style="font-size:11px;color:var(--danger);">بواسطة: ${escapeHtml(h.hseRejectedBy || '')}</span>
      </div>`;
    } else if (h.status === 'resolved' || h.status === 'closed') {
      actionHtml = `<div class="desc" style="margin-top:10px;">
        <strong>تفاصيل الإصلاح (الصيانة):</strong><br>${escapeHtml(h.maintenanceAction || 'لا يوجد')}
        ${h.maintenanceTeamNames ? `<br><strong>فريق الصيانة:</strong> ${escapeHtml(h.maintenanceTeamNames)}` : ''}
        ${h.resolvedByMaintenanceName ? `<br><span style="font-size:11px;color:var(--muted);">بواسطة: ${escapeHtml(h.resolvedByMaintenanceName)}</span>` : ''}
      </div>`;
    } else {
      const curRole = currentUserRole || (window.currentUser && window.currentUser.role) || '';
      const hasFullControl = ['super_admin', 'hse_admin', 'hse', 'hse_manager'].includes(curRole);
      const isMaint = curRole === 'maint_admin' || curRole === 'maintenance';

      actionHtml = `<div class="note-box show" style="margin-top:12px;">`;
      if (h.status === 'open') {
        if (hasFullControl) {
          actionHtml += `
            <div style="display:flex; gap:8px; width:100%; margin-top:10px;">
              <button onclick="openHzAssignModal('${h.id}')" class="btn-cyan" style="flex:1;">📢 توجيه للصيانة</button>
              <button onclick="startHzMaintenance('${h.id}')" class="btn-amber" style="flex:1;">🛠️ بدء الإصلاح</button>
              <button onclick="updateHazardStatus('${h.id}', 'rejected')" class="btn-red" style="flex:1;">🚫 رفض البلاغ</button>
            </div>`;
        }
      } else if (h.status === 'assigned_to_maintenance' || h.status === 'assigned_maintenance') {
        if (hasFullControl || (isMaint && h.assignedToMaintenance === currentUserDept)) {
          actionHtml += `
            <div style="display:flex; gap:8px; width:100%; margin-top:10px;">
              <button onclick="startHzMaintenance('${h.id}')" class="btn-amber" style="flex:1;">🛠️ بدء الإصلاح</button>
              <button onclick="resolveHazardPrompt('${h.id}')" class="btn-emerald" style="flex:1;">✅ تم الحل والإغلاق</button>
            </div>`;
        }
      } else if (h.status === 'in_progress') {
        if (hasFullControl || (isMaint && h.assignedToMaintenance === currentUserDept)) {
          actionHtml += `
            <div style="display:flex; gap:8px; width:100%; margin-top:10px;">
              <button onclick="resolveHazardPrompt('${h.id}')" class="btn-emerald" style="flex:1;">✅ تأكيد الإصلاح والإغلاق</button>
            </div>`;
        }
      }
      actionHtml += `</div>`;
    }
    
    // Assignment details
    if (h.assignedToMaintenance && h.status !== 'rejected_by_maintenance' && h.status !== 'rejected_by_hse') {
      actionHtml += `<div class="desc" style="margin-top:10px; background:rgba(3,105,161,0.08); padding:8px; border-radius:4px; border:1px solid rgba(3,105,161,0.25);">
        <strong>جهة الصيانة:</strong> ${escapeHtml(h.assignedToMaintenance)}
        ${h.forwardedByHseName ? `<br><span style="font-size:11px;color:var(--muted);">توجيه بواسطة: ${escapeHtml(h.forwardedByHseName)}</span>` : ''}
      </div>`;
    }
  }

  let manageHtml = '';
  const currentRoleKey = getRoleKey(currentUserRole);
  const deletedBy = (typeof h.deletedBy === 'object' && h.deletedBy !== null) ? h.deletedBy : {};
  const isTrashedForMe = deletedBy[currentRoleKey] === true || h.deleted;
  const maintDeletedForMe = h.deletedByMaintenance && currentUserRole === 'maint_admin' && h.maintenanceDeletedDept === currentUserDept;

  if (isTrashedForMe || maintDeletedForMe) {
    if (currentUserRole === 'super_admin' || currentUserRole === 'hse_admin' || currentUserRole === 'dept_admin' || (currentUserRole === 'maint_admin' && h.maintenanceDeletedDept === currentUserDept)) {
      manageHtml = `<div style="display:flex; flex-direction:column; gap:8px; margin-top:12px; border-top:1px solid var(--paper-line); padding-top:12px;">
        <div style="display:flex; gap:8px;">
          <button onclick="restoreHazard('${h.id}')" class="act-btn" style="flex:1; background:var(--success); color:#fff;">🔄 استرجاع</button>
          <button onclick="permanentDeleteHazard('${h.id}')" class="act-btn" style="flex:1; background:var(--danger); color:#fff;">❌ حذف نهائي</button>
        </div>
        ${(h.lastDeletedByUsername || h.deletedByUsername) ? `<div style="font-size:12px; color:var(--danger); margin-top:4px; font-weight:bold;">حُذف بواسطة: ${escapeHtml(h.lastDeletedByUsername || h.deletedByUsername || 'المشرف')} ${h.deleteReason ? `| السبب: ${escapeHtml(h.deleteReason)}` : ''}</div>` : ''}
      </div>`;
    }
  } else {
    if (currentUserRole === 'super_admin' || currentUserRole === 'hse_admin' || currentUserRole === 'dept_admin' || (currentUserRole === 'maint_admin' && h.assignedToMaintenance === currentUserDept)) {
      manageHtml = `<div style="display:flex; justify-content:flex-end; margin-top:12px; border-top:1px solid var(--paper-line); padding-top:12px;">
        <button onclick="softDeleteHazard('${h.id}')" class="act-btn" style="background:var(--danger); color:#fff; padding:4px 8px; font-size:12px;">🗑️ حذف</button>
      </div>`;
    }
  }

  const rawStart = h.treatmentStartedAt || h.startedAt || (h.status === 'resolved' ? h.completedAt : null);
  const startDisplay = rawStart ? new Date(rawStart).toLocaleString('ar-EG', {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  }) : 'لم تبدأ بعد';

  const timelineHtml = `
    <div class="hazard-timeline">
      <div class="timeline-step done">
        <span class="step-icon">📝</span>
        <div class="step-info">
          <strong>وقت الإرسال:</strong>
          <span>${formatDateTime(h.submittedAt || h.createdAt)}</span>
        </div>
      </div>

      <div class="timeline-step ${h.seenAt ? 'done' : 'pending'}">
        <span class="step-icon">👁️</span>
        <div class="step-info">
          <strong>وقت المشاهدة من المشرف:</strong>
          <span>${h.seenAt ? `${formatDateTime(h.seenAt)} (${h.seenBy || 'المشرف'})` : 'لم تتم المشاهدة بعد'}</span>
        </div>
      </div>

      <div class="timeline-step ${rawStart ? 'done' : 'pending'}">
        <span class="step-icon">⚙️</span>
        <div class="step-info">
          <strong>وقت بدء المعالجة:</strong>
          <span>${startDisplay} ${rawStart && h.assignedTechName ? `(المنسوب: ${h.assignedTechName}${h.assignedTechCode ? ' - '+h.assignedTechCode : ''})` : (rawStart && h.startedByName ? `(${h.startedByName})` : (rawStart ? '(الصيانة)' : ''))}</span>
        </div>
      </div>

      <div class="timeline-step ${h.resolvedAt ? 'done' : 'pending'}">
        <span class="step-icon">✅</span>
        <div class="step-info">
          <strong>وقت الانتهاء والإغلاق:</strong>
          <span>${h.resolvedAt ? `${formatDateTime(h.resolvedAt)} (${h.resolvedBy || 'المشرف'})` : 'لم ينتهِ بعد'}</span>
        </div>
      </div>
    </div>
  `;

  return `
    <div class="sup-card" id="hz_card_${h.id}">
      <div class="sup-top">
        <div>
          <div class="hz-status-badge ${statusClass}">${statusStr}</div>
          <div class="worker">${escapeHtml(h.reporterName)}</div>
        </div>
        <div class="tnum">${h.id}</div>
      </div>
      <div class="meta-grid">
        <div><span>التاريخ</span>${h.date}</div>
        <div><span>القسم</span>${escapeHtml(h.department)}</div>
        <div><span>المنطقة</span>${escapeHtml(h.area)}</div>
        ${(h.hseName || h.hseReviewer) ? `<div><span>مشرف السلامة</span>${escapeHtml(h.hseName || h.hseReviewer)}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin:12px 0;">
        <span style="font-size:12px; font-weight:bold;">مستوى الخطورة:</span>
        <div class="hz-risk-badge ${riskClass}" style="margin:0; padding:4px 8px; font-size:11.5px;">${riskStr}</div>
      </div>
      <div class="desc"><strong>وصف الخطورة:</strong><br>${escapeHtml(h.description)}</div>
      ${h.potentialInjury ? `<div class="desc"><strong>الإصابة المحتملة:</strong><br>${escapeHtml(h.potentialInjury)}</div>` : ''}
      ${h.proposedSolution ? `<div class="desc"><strong>الحل المقترح:</strong><br>${escapeHtml(h.proposedSolution)}</div>` : ''}
      ${h.actionTaken ? `<div class="desc" style="background:#f8f9fa; border-right:4px solid var(--primary); padding:10px; margin-top:10px;"><strong>الإجراء المتخذ:</strong><br>${escapeHtml(h.actionTaken)}</div>` : ''}
      ${h.assignNotes ? `<div class="desc" style="background:#e0f7fa; padding:8px; border-radius:4px; border:1px solid #b2ebf2; margin-top:8px;"><strong>ملاحظات التوجيه للصيانة:</strong><br>${escapeHtml(h.assignNotes)}</div>` : ''}
      ${h.photoUrl ? `<div style="margin-top:8px;"><div class="hz-photo-badge" onclick="openLightbox('${h.photoUrl}')">🖼️ عرض الصورة</div></div>` : ''}
      ${actionHtml}
      ${timelineHtml}
      ${manageHtml}
    </div>
  `;
}

// [PERF] Raw hazards list from the server, cached client-side so that
// typing in the search boxes (reporter/hse/dept) only re-filters this
// in-memory array instead of hitting the network on every keystroke.
window._hazardsRawCache = null;

async function renderSupHazard(isSilent = false, forceRefetch = true, skipFilterBar = false) {
  if (!isSilent) document.getElementById('hzList').innerHTML = '<div class="loading">جارِ التحميل…</div>';

  const hzArea = document.getElementById('hzUserProfileChip');
  if (hzArea && document.getElementById('supUserProfileChip')) {
    hzArea.innerHTML = document.getElementById('supUserProfileChip').innerHTML;
  }

  if (!skipFilterBar) await renderHzFilters();

  try {
    let hazards;
    if (forceRefetch || !window._hazardsRawCache) {
      const res = await authFetch('/api/hazards');
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      hazards = data.hazards || [];
      window._hazardsRawCache = hazards;
    } else {
      hazards = window._hazardsRawCache;
    }

    const openCount = hazards.filter(h => h.status === 'open').length;
    const badgeEl = document.getElementById('hzSupBadge');
    if (badgeEl) {
      if (openCount > 0) {
        badgeEl.textContent = openCount;
        badgeEl.style.display = 'inline-block';
      } else {
        badgeEl.style.display = 'none';
      }
    }

    // Apply filters
    const currentRoleKey = getRoleKey(currentUserRole);
    if (currentHzStatusFilter === '🗑️ المحذوفات') {
       hazards = hazards.filter(h => {
         const isPermanentlyDeletedForMe = h.permanentlyDeletedBy && h.permanentlyDeletedBy[currentRoleKey] === true;
         if (isPermanentlyDeletedForMe) return false;
         if (currentUserRole === 'maint_admin') {
             return h.deletedByMaintenance && h.maintenanceDeletedDept === currentUserDept;
         }
         const deletedBy = (typeof h.deletedBy === 'object' && h.deletedBy !== null) ? h.deletedBy : {};
         return deletedBy[currentRoleKey] === true || h.deleted === true;
       });
    } else {
       hazards = hazards.filter(h => {
         const isPermanentlyDeletedForMe = h.permanentlyDeletedBy && h.permanentlyDeletedBy[currentRoleKey] === true;
         if (isPermanentlyDeletedForMe) return false;
         if (currentUserRole === 'maint_admin') {
             if (h.deletedByMaintenance || h.deleted) return false;
         } else {
             const deletedBy = (typeof h.deletedBy === 'object' && h.deletedBy !== null) ? h.deletedBy : {};
             if (deletedBy[currentRoleKey] === true || h.deleted === true) return false;
         }
         return true;
       });
       if (currentHzStatusFilter !== 'الكل') {
         if (currentHzStatusFilter === 'مفتوح 🔴') hazards = hazards.filter(h => h.status === 'open');
         else if (currentHzStatusFilter === 'موجه للصيانة 📢') hazards = hazards.filter(h => h.status === 'assigned_to_maintenance');
         else if (currentHzStatusFilter === 'قيد الإصلاح 🟡') hazards = hazards.filter(h => h.status === 'in_progress');
         else if (currentHzStatusFilter === 'مرفوض ❌') hazards = hazards.filter(h => h.status === 'rejected_by_maintenance' || h.status === 'rejected_by_hse');
         else if (currentHzStatusFilter === 'تم الحل والإغلاق 🟢') hazards = hazards.filter(h => h.status === 'resolved' || h.status === 'closed');
       }
    }
    if (currentHzDeptFilter !== 'الكل' && currentUserRole !== 'maint_admin') {
       const deptQuery = currentHzDeptFilter.trim().toLowerCase();
       const isKnownDept = (window._hzRealDepts || []).includes(currentHzDeptFilter);
       hazards = hazards.filter(h => {
         const dep = String(h.department || '');
         return isKnownDept ? dep === currentHzDeptFilter : dep.toLowerCase().includes(deptQuery);
       });
    }
    if (currentHzSeverityFilter !== 'الكل') {
       hazards = hazards.filter(h => h.riskLevel === currentHzSeverityFilter);
    }
    if (currentHzYearFilter !== 'الكل') {
       hazards = hazards.filter(h => {
         const d = new Date(h.submittedAt || h.createdAt || h.date);
         if (isNaN(d.getTime())) return false;
         return String(d.getFullYear()) === currentHzYearFilter;
       });
    }

    // Apply custom search/time/date-range filters
    // (Department search lives in the pinned pills above — see renderHzFilters.)
    const fTime = document.getElementById('filter_hz_timeframe')?.value || 'all';
    const fReporter = document.getElementById('filter_hz_reporter')?.value?.toLowerCase();
    const fHse = document.getElementById('filter_hz_hse')?.value?.toLowerCase();
    const fFrom = document.getElementById('filter_hz_dateFrom')?.value;
    const fTo   = document.getElementById('filter_hz_dateTo')?.value;

    hazards = hazards.filter(h => {
      let match = true;
      if (fTime !== 'all') {
        const days = parseInt(fTime);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        if (new Date(h.submittedAt || h.createdAt || h.date) < cutoff) match = false;
      }
      if (fReporter && !(h.reporterName || h.reportedBy || '').toLowerCase().includes(fReporter)) match = false;
      if (fHse && !(h.hseName || h.hseReviewer || '').toLowerCase().includes(fHse)) match = false;
      // من تاريخ / إلى تاريخ — نفس فكرة فلتر التصاريح (applyPermitAdvancedFilters)
      if (fFrom || fTo) {
        const raw = h.submittedAt || h.createdAt || h.date;
        const hDate = raw ? new Date(raw).toISOString().slice(0, 10) : '';
        if (!hDate) match = false;
        else {
          if (fFrom && hDate < fFrom) match = false;
          if (fTo && hDate > fTo) match = false;
        }
      }
      return match;
    });

    hazards.sort((a,b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    window._currentFilteredHazards = hazards;

    const hzCountEl = document.getElementById('hzFilterCount');
    if (hzCountEl) hzCountEl.textContent = `عدد النتائج: ${hazards.length}`;

    const listEl = document.getElementById('hzList');
    if (hazards.length === 0) {
      listEl.innerHTML = '<div class="empty"><div class="icon">⚠️</div>لا توجد بلاغات حالياً</div>';
      return;
    }
    let html = '';
    hazards.forEach(h => {
      html += getHazardCardHtml(h);
    });
    listEl.innerHTML = html;

  } catch(e) {
    document.getElementById('hzList').innerHTML = '<div class="empty">خطأ في جلب البيانات</div>';
  }
}

// [PERF] Typing in the search boxes re-filters the cached list only
// (forceRefetch=false) — no network round-trip per keystroke, and it's
// debounced so a fast typist doesn't re-render on every letter.
window.applyHazardFilters = window.debounce(function() {
  renderSupHazard(true, false);
}, 250);

window.clearHazardFilters = function() {
  const el1 = document.getElementById('filter_hz_timeframe');
  const el2 = document.getElementById('filter_hz_reporter');
  const el3 = document.getElementById('filter_hz_hse');
  const el4 = document.getElementById('filter_hz_dateFrom');
  const el5 = document.getElementById('filter_hz_dateTo');
  if (el1) el1.value = 'all';
  if (el2) el2.value = '';
  if (el3) el3.value = '';
  if (el4) el4.value = '';
  if (el5) el5.value = '';
  renderSupHazard(true, false);
};

async function renderHzFilters() {
  const fArea = document.getElementById('hzFilters');
  const dArea = document.getElementById('hzDeptFilters');
  const dToolbar = document.getElementById('hzDeptToolbar');

  const statuses = ['الكل', 'مفتوح 🔴', 'موجه للصيانة 📢', 'قيد الإصلاح 🟡', 'مرفوض ❌', 'تم الحل والإغلاق 🟢', '🗑️ المحذوفات'];
  fArea.innerHTML = statuses.map(s => 
    `<div class="chip ${currentHzStatusFilter===s?'active':''}" onclick="setHzFilter('${s}')">${s}</div>`
  ).join('');

  if (currentUserRole !== 'area_head' && currentUserRole !== 'maint_admin') {
    dToolbar.style.display = 'flex';
    // Skip rebuilding the combobox while the user is actively typing in it
    // (re-creating the <input> mid-keystroke would drop focus/cursor).
    if (!(dArea.dataset.built === '1' && document.activeElement && document.activeElement.id === 'hzDeptFilterInput')) {
      const realDepts = await loadRealDepartments();
      window._hzRealDepts = realDepts;
      const currentVal = currentHzDeptFilter === 'الكل' ? '' : currentHzDeptFilter;
      dArea.innerHTML = `
        <input type="text" id="hzDeptFilterInput" class="dept-filter-input" list="hzDeptDatalist"
          placeholder="🏢 اختر أو اكتب اسم القسم..." value="${escapeAttr(currentVal)}"
          oninput="onHzDeptFilterInput(this.value)" autocomplete="off"
          style="min-width:220px;flex:1;max-width:320px;">
        <datalist id="hzDeptDatalist">
          ${realDepts.map(d => `<option value="${escapeAttr(d)}"></option>`).join('')}
        </datalist>
        ${currentHzDeptFilter !== 'الكل' ? `<div class="chip active" onclick="setHzDeptFilterFromInput('')">✕ إلغاء فلتر القسم</div>` : ''}
      `;
      dArea.dataset.built = '1';
    }
  } else {
    dToolbar.style.display = 'none';
  }

  const sArea = document.getElementById('hzSeverityPillsFilters');
  if (sArea) {
    const severities = [
      { label: 'الكل', val: 'الكل' },
      { label: 'عالي 🔴', val: 'H' },
      { label: 'متوسط 🟡', val: 'M' },
      { label: 'منخفض 🟢', val: 'L' }
    ];
    sArea.innerHTML = severities.map(s => 
      `<div class="chip ${currentHzSeverityFilter===s.val?'active':''}" onclick="setHzSeverityFilter('${s.val}')">${s.label}</div>`
    ).join('');
  }

  const yArea = document.getElementById('hzYearFilters');
  if (yArea) {
    const years = ['الكل', ...FILTER_YEARS];
    yArea.innerHTML = years.map(y =>
      `<div class="chip ${currentHzYearFilter===y?'active':''}" onclick="setHzYearFilter('${y}')">${y}</div>`
    ).join('');
  }
}

function setHzFilter(f) {
  currentHzStatusFilter = f;
  renderSupHazard(true, false);
}
function setHzDeptFilter(d) {
  currentHzDeptFilter = d;
  renderSupHazard(true, false);
}
// Sets the dept filter from the search box WITHOUT rebuilding the filter
// bar (skipFilterBar=true) — keeps the input focused while typing.
function setHzDeptFilterFromInput(v) {
  currentHzDeptFilter = (v && v.trim()) ? v.trim() : 'الكل';
  renderSupHazard(true, false, true);
}
window.onHzDeptFilterInput = window.debounce(function(v) {
  setHzDeptFilterFromInput(v);
}, 300);
function setHzSeverityFilter(v) {
  currentHzSeverityFilter = v;
  renderSupHazard(true, false); // renderSupHazard calls renderHzFilters() itself, same as setHzFilter/setHzDeptFilter
}
function setHzYearFilter(y) {
  currentHzYearFilter = y;
  renderSupHazard(true, false); // renderSupHazard calls renderHzFilters() itself, same as setHzFilter/setHzDeptFilter
}

window.resolveHazardPrompt = async function(hazardId) {
  const correctiveAction = window.prompt("يرجى كتابة الإجراء التصحيحي المتخذ لإغلاق هذا البلاغ:");
  if (correctiveAction === null) return; // cancelled
  if (!correctiveAction.trim()) {
    showToast("⚠️ يجب كتابة الإجراء التصحيحي قبل إغلاق البلاغ", 'error');
    return;
  }

  // Send PATCH request with action/correctiveAction field:
  try {
    const res = await fetch(`/api/hazards/${hazardId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getToken()}`
      },
      body: JSON.stringify({
        status: 'resolved',
        corrective_action: correctiveAction.trim(),
        correctiveAction: correctiveAction.trim(),
        actionTaken: correctiveAction.trim(),
        action_taken: correctiveAction.trim(),
        action: correctiveAction.trim()
      })
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || errData.message || 'فشل تحديث حالة البلاغ');
    }
    // Refresh list
    if (typeof loadHazards === 'function') loadHazards();
    if (typeof renderSupHazard === 'function') renderSupHazard(); // Refresh supervisor/admin view too
    showToast('تم تحديث البلاغ بنجاح', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

async function updateHazardStatus(id, newStatus, actionOverride = null) {
  let actionTaken = actionOverride;
  if (actionTaken === null) {
    const actionArea = document.getElementById(`corrective_action_${id}`) || document.getElementById(`hz_action_${id}`);
    actionTaken = actionArea ? actionArea.value.trim() : '';
  }

  if (newStatus === 'resolved' && !actionTaken) {
    showToast('يجب كتابة الإجراء التصحيحي قبل إغلاق البلاغ', 'error');
    return;
  }

  try {
    const res = await authFetch(`/api/hazards/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus, actionTaken })
    });
    
    if (res.ok) {
      showToast('تم تحديث البلاغ بنجاح', 'success');
      const data = await res.json();
      if (data.hazard) {
        const card = document.getElementById(`hz_card_${id}`);
        if (card) {
          card.outerHTML = getHazardCardHtml(data.hazard);
        }
      }
    } else {
      const data = await res.json();
      showToast(data.error || 'فشل التحديث', 'error');
    }
  } catch(e) {
    showToast('خطأ في الاتصال بالخادم', 'error');
  }
}
let currentHzAssignId = null;
let currentHzResolveId = null;
let currentHzRejectMaintId = null;
let currentHzRejectHseId = null;

async function startHzMaintenance(id) {
  try {
    const res = await authFetch(`/api/hazards/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start_maintenance' })
    });
    if (res.ok) {
      showToast('تم البدء بالإصلاح بنجاح', 'success');
      renderSupHazard(true);
    } else {
      const d = await res.json();
      showToast(d.error || 'حدث خطأ', 'error');
    }
  } catch (e) {
    showToast('خطأ في الاتصال', 'error');
  }
}

function openHzRejectMaintModal(id) {
  currentHzRejectMaintId = id;
  document.getElementById('hz_maint_reject_reason').value = '';
  document.getElementById('hzRejectMaintModal').style.display = 'flex';
}
function closeHzRejectMaintModal() {
  document.getElementById('hzRejectMaintModal').style.display = 'none';
}
async function submitHzRejectMaint() {
  const reason = document.getElementById('hz_maint_reject_reason').value.trim();
  if (!reason) return showToast('يرجى كتابة سبب الرفض', 'error');
  try {
    const res = await authFetch(`/api/hazards/${currentHzRejectMaintId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject_maintenance', rejectReason: reason })
    });
    if (res.ok) {
      showToast('تم رفض البلاغ وتم إشعار مشرف السلامة', 'success');
      closeHzRejectMaintModal();
      renderSupHazard(true);
    } else {
      const d = await res.json();
      showToast(d.error || 'حدث خطأ', 'error');
    }
  } catch (e) { showToast('خطأ في الاتصال', 'error'); }
}

function openHzRejectHseModal(id) {
  currentHzRejectHseId = id;
  document.getElementById('hz_hse_reject_reason').value = '';
  document.getElementById('hzRejectHseModal').style.display = 'flex';
}
function closeHzRejectHseModal() {
  document.getElementById('hzRejectHseModal').style.display = 'none';
}
async function submitHzRejectHse() {
  const reason = document.getElementById('hz_hse_reject_reason').value.trim();
  if (!reason) return showToast('يرجى كتابة سبب الرفض', 'error');
  try {
    const res = await authFetch(`/api/hazards/${currentHzRejectHseId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject_hse', rejectReason: reason })
    });
    if (res.ok) {
      showToast('تم رفض البلاغ نهائياً', 'success');
      closeHzRejectHseModal();
      renderSupHazard(true);
    } else {
      const d = await res.json();
      showToast(d.error || 'حدث خطأ', 'error');
    }
  } catch(e) { showToast('خطأ في الاتصال', 'error'); }
}

window.populateTrainerInfo = function() {
  const nameInput = document.getElementById('trn_trainer');
  const codeInput = document.getElementById('trn_trainerCode');
  if (!nameInput || !codeInput) return;

  // 1. Try decoding wp_auth_token
  let currentUser = null;
  try {
    const rawToken = sessionStorage.getItem('wp_auth_token') || localStorage.getItem('wp_auth_token');
    if (rawToken && rawToken.includes('.')) {
      let b64 = rawToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const decodedChars = atob(b64);
      const bytes = new Uint8Array(decodedChars.length);
      for (let i = 0; i < decodedChars.length; i++) bytes[i] = decodedChars.charCodeAt(i);
      currentUser = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    }
  } catch (e) {}

  // 2. Fallbacks to other session keys
  if (!currentUser || !currentUser.name) {
    try {
      currentUser = JSON.parse(sessionStorage.getItem('employee_session') || localStorage.getItem('user') || '{}');
    } catch(e) {}
  }
  if (!currentUser || !currentUser.name) {
    currentUser = window.currentUser || {};
  }

  // 3. Resolve exact name and code
  const finalName = (currentUser.name || currentUser.fullName || '').trim();
  let finalCode = currentUser.empCode || currentUser.emp_code || currentUser.code || '';

  // If code is missing or default admin string, resolve from window.allEmployees
  if ((!finalCode || finalCode === 'superadmin-default') && Array.isArray(window.allEmployees) && finalName) {
    const matched = window.allEmployees.find(e => e && e.name && e.name.trim() === finalName);
    if (matched) {
      finalCode = matched.empCode || matched.emp_code || '';
    }
  }
  if (!finalCode && currentUser.id && !isNaN(currentUser.id)) {
    finalCode = currentUser.id;
  }

  // 4. Set values and lock inputs
  if (finalName) {
    nameInput.value = finalName;
    if (document.getElementById('drl_trainer')) document.getElementById('drl_trainer').value = finalName;
  }
  if (finalCode) {
    codeInput.value = String(finalCode);
    if (document.getElementById('drl_trainerCode')) document.getElementById('drl_trainerCode').value = String(finalCode);
  }

  nameInput.readOnly = true;
  nameInput.style.backgroundColor = '#f1f5f9';
  nameInput.style.cursor = 'not-allowed';

  codeInput.readOnly = true;
  codeInput.style.backgroundColor = '#f1f5f9';
  codeInput.style.cursor = 'not-allowed';
};


function openHzAssignModal(id) {
  currentHzAssignId = id;
  document.getElementById('hz_target_maint').value = '';
  if (document.getElementById('hz_assign_notes')) document.getElementById('hz_assign_notes').value = '';
  document.getElementById('hzAssignModal').style.display = 'flex';
}
function closeHzAssignModal() {
  document.getElementById('hzAssignModal').style.display = 'none';
}
async function submitHzAssign() {
  const target = document.getElementById('hz_target_maint').value;
  const notes = document.getElementById('hz_assign_notes') ? document.getElementById('hz_assign_notes').value.trim() : '';
  if (!target) return showToast('يرجى اختيار قسم الصيانة المستهدف', 'error');
  try {
    const res = await authFetch(`/api/hazards/${currentHzAssignId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'assign_maintenance', targetMaintenance: target, assignNotes: notes })
    });
    if (res.ok) {
      showToast('تم التوجيه للصيانة بنجاح', 'success');
      closeHzAssignModal();
      renderSupHazard(true);
    } else {
      const d = await res.json();
      showToast(d.error || 'حدث خطأ', 'error');
    }
  } catch(e) { showToast('خطأ في الاتصال', 'error'); }
}

function openHzResolveModal(id) {
  currentHzResolveId = id;
  document.getElementById('hz_resolve_action').value = '';
  document.getElementById('hz_resolve_team').value = '';
  document.getElementById('hzResolveModal').style.display = 'flex';
}
function closeHzResolveModal() {
  document.getElementById('hzResolveModal').style.display = 'none';
}
async function submitHzResolve() {
  const actionTaken = document.getElementById('hz_resolve_action').value.trim();
  const team = document.getElementById('hz_resolve_team').value.trim();
  if (!actionTaken || !team) return showToast('يرجى تعبئة كافة الحقول', 'error');
  try {
    const res = await authFetch(`/api/hazards/${currentHzResolveId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resolve_maintenance', maintenanceAction: actionTaken, maintenanceTeamNames: team })
    });
    if (res.ok) {
      showToast('تم الإصلاح والإغلاق بنجاح', 'success');
      closeHzResolveModal();
      renderSupHazard(true);
    } else {
      const d = await res.json();
      showToast(d.error || 'حدث خطأ', 'error');
    }
  } catch(e) { showToast('خطأ في الاتصال', 'error'); }
}

async function softDeleteHazard(id) {
  if (!confirm('هل أنت متأكد من حذف هذا البلاغ ونقله للمحذوفات؟')) return;
  try {
    const res = await authFetch(`/api/hazards/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'حذف من لوحة التحكم' }) });
    if (res.ok) {
      showToast('تم النقل للمحذوفات بنجاح', 'success');
      renderSupHazard(true);
    } else { showToast('فشل الحذف', 'error'); }
  } catch(e) { showToast('خطأ في الاتصال', 'error'); }
}

async function restoreHazard(id) {
  if (!confirm('هل تريد استعادة هذا البلاغ؟')) return;
  try {
    const res = await authFetch(`/api/hazards/${id}/restore`, { method: 'POST' });
    if (res.ok) {
      showToast('تم الاستعادة بنجاح', 'success');
      renderSupHazard(true);
    } else { showToast('فشل الاستعادة', 'error'); }
  } catch(e) { showToast('خطأ في الاتصال', 'error'); }
}

async function permanentDeleteHazard(id) {
  if (!confirm('تنبيه هام! هل أنت متأكد من الحذف النهائي؟ لا يمكن التراجع عن هذا الإجراء.')) return;
  try {
    const res = await authFetch(`/api/hazards/${id}/permanent`, { method: 'DELETE' });
    if (res.ok) {
      showToast('تم الحذف النهائي بنجاح', 'success');
      renderSupHazard(true);
    } else { showToast('فشل الحذف', 'error'); }
  } catch(e) { showToast('خطأ في الاتصال', 'error'); }
}

let isKpiVisible = false;

async function uploadHazardsExcel(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const dataUrl = e.target.result;
    const base64Data = dataUrl.split(',')[1];
    
    showToast('جاري رفع السجل واستيراد البيانات...', 'info');
    
    try {
      const res = await authFetch('/api/hazards/upload-excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64Data })
      });
      const json = await res.json();
      if (json.success) {
        showToast(`تم استيراد ${json.count} بلاغ بنجاح! (مغلق: ${json.closed ?? '?'} / مفتوح: ${json.open ?? '?'})`, 'success');
        renderSupHazard(true); // refresh the list
      } else {
        showToast(json.message || 'حدث خطأ أثناء الرفع', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('خطأ في الاتصال بالخادم', 'error');
    }
    
    // Reset file input
    event.target.value = '';
  };
  reader.readAsDataURL(file);
}

// ── 🗑️ مسح كامل لبيانات موديول معيّن (بلاغات/تصاريح/جزاءات/تدريبات/تجارب طوارئ) ──
// إجراء خطير وغير قابل للتراجع من واجهة المستخدم — بيطلب تأكيد صريح بكتابة "تأكيد"
// قبل ما يبعت الطلب للسيرفر. مقصور على super_admin و hse_admin (السيرفر بيتأكد برضه).
const CLEAR_MODULE_LABELS = {
  hazards:   'بلاغات الخطورة',
  permits:   'تصاريح العمل',
  penalties: 'الجزاءات',
  trainings: 'التدريبات',
  drills:    'تجارب الطوارئ',
  employees: 'الموظفين'
};

async function clearModuleData(moduleName, refreshFn) {
  const label = CLEAR_MODULE_LABELS[moduleName] || moduleName;

  const step1 = window.confirm(
    `⚠️ تحذير: هتمسح كل بيانات "${label}" نهائيًا — للعمال والأدمن كلهم.\n` +
    `هيتاخد باك أب على السيرفر، لكن العملية دي مش هترجع من الواجهة.\n\n` +
    `متأكد إنك عايز تكمل؟`
  );
  if (!step1) return;

  const typed = window.prompt(`لتأكيد المسح النهائي، اكتب كلمة "تأكيد" بالظبط:`);
  if (typed !== 'تأكيد') {
    showToast('اتلغت عملية المسح — لازم تكتب "تأكيد" بالظبط', 'info');
    return;
  }

  try {
    showToast(`جاري مسح ${label}...`, 'info');
    const res = await authFetch('/api/admin/clear-module', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ module: moduleName, confirm: 'تأكيد' })
    });
    const json = await res.json();
    if (json.success) {
      showToast(`✅ اتمسح ${label} بالكامل (${json.cleared ?? 0} سجل)`, 'success');
      if (typeof refreshFn === 'function') refreshFn();
    } else {
      showToast(json.message || 'حدث خطأ أثناء المسح', 'error');
    }
  } catch (err) {
    console.error(err);
    showToast('خطأ في الاتصال بالخادم', 'error');
  }
}

async function uploadPermitsExcel(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const dataUrl = e.target.result;
    const base64Data = dataUrl.split(',')[1];

    showToast('جاري رفع سجل التصاريح القديمة واستيراد البيانات...', 'info');

    try {
      const res = await authFetch('/api/permits/upload-excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64Data })
      });
      const json = await res.json();
      if (json.success) {
        showToast(`تم استيراد ${json.count} تصريح قديم بنجاح! (اترّبط بموظف: ${json.matched ?? '?'})`, 'success');
        renderSupervisor(); // refresh the permits list
      } else {
        showToast(json.message || 'حدث خطأ أثناء الرفع', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('خطأ في الاتصال بالخادم', 'error');
    }

    // Reset file input
    event.target.value = '';
  };
  reader.readAsDataURL(file);
}

window.exportHazardsExcel = function() {
  const dataToExport = window._currentFilteredHazards || [];
  if (dataToExport.length === 0) {
    showToast('لا توجد بلاغات للتصدير', 'error');
    return;
  }
  
  try {
    const rows = dataToExport.map(h => ({
      'كود العامل': String(h.empCode || ''),
      'اسم المُبلِّغ / العامل': h.reporterName || h.reportedBy || '',
      'القسم (Department)': h.department || '',
      'وصف الخطورة': h.description || '',
      'تاريخ البلاغ': h.date || '',
      'المنطقة': h.area || '',
      'اسم مشرف السلامة': h.hseName || h.hseReviewer || '',
      'حالة البلاغ': h.status === 'open' ? 'مفتوح 🔴' :
                    (h.status === 'in_progress' ? 'قيد الإصلاح 🟡' :
                    (h.status === 'assigned_to_maintenance' ? 'موجه للصيانة 📢' :
                    (h.status === 'rejected_by_maintenance' ? 'مرفوض من الصيانة ❌' :
                    (h.status === 'rejected_by_hse' ? 'مرفوض 🚫' :
                    (h.status === 'resolved' || h.status === 'closed' ? 'تم الإصلاح والإغلاق 🟢' : h.status))))),
      'الإجراء المتخذ': h.actionTaken || ''
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    
    // Add RTL support
    if(!ws['!cols']) ws['!cols'] = [];
    ws['!cols'] = [
      { wch: 15 },
      { wch: 30 },
      { wch: 25 },
      { wch: 50 },
      { wch: 15 },
      { wch: 15 },
      { wch: 30 },
      { wch: 20 },
      { wch: 40 }
    ];
    
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'البلاغات');
    const dateStr = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `سجل_بلاغات_الخطورة_${dateStr}.xlsx`);
    showToast('تم تحميل سجل الإكسيل بنجاح 📊', 'success');
  } catch (e) {
    console.error(e);
    showToast('خطأ أثناء التصدير', 'error');
  }
};

// ============================================================
// 🚀 INITIALIZATION
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  try {
    if (typeof initTabs === 'function') initTabs();
    if (typeof initHazardModule === 'function') initHazardModule();
    initEmployeeSession();
    startHazardPolling();
  } catch (e) {
    console.error("Initialization error:", e);
  }
});

function startHazardPolling() {
  if (window._hazardPollInterval) clearInterval(window._hazardPollInterval);
  window._hazardPollInterval = setInterval(async () => {
    if (sessionRole === 'supervisor') {
      await updateHazardBadgeCount();
    }
    
    const isEditing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
    if (!isEditing) {
      await silentRefreshHazards();
    }
  }, 5000);
}

async function updateHazardBadgeCount() {
  if (!currentAdminToken || sessionRole !== 'supervisor') return;
  try {
    const res = await fetch('/api/hazards', { headers: { 'Authorization': `Bearer ${currentAdminToken}` }});
    if (!res.ok) return;
    const data = await res.json();
    const hazards = data.hazards || [];
    
    const openCount = hazards.filter(h => h.status === 'open').length;
    const badgeEl = document.getElementById('hzSupBadge');
    if (badgeEl) {
      if (openCount > 0) {
        badgeEl.textContent = openCount;
        badgeEl.style.display = 'inline-block';
      } else {
        badgeEl.style.display = 'none';
      }
    }
  } catch(e) {}
}

async function silentRefreshHazards() {
  const viewSup = document.getElementById('viewSupHazard');
  const viewMy = document.getElementById('viewMyHazards');

  if (viewSup && viewSup.style.display !== 'none' && sessionRole === 'supervisor' && currentAdminToken) {
    try {
      const res = await fetch('/api/hazards', { headers: { 'Authorization': `Bearer ${currentAdminToken}` }});
      if (!res.ok) return;
      const data = await res.json();
      const raw = JSON.stringify(data.hazards || []);
      if (raw !== window.lastSupHazardsData) {
        window.lastSupHazardsData = raw;
        renderSupHazard(true);
      }
    } catch(e) {}
  } else if (viewMy && viewMy.style.display !== 'none' && currentEmployee) {
    try {
      const res = await fetch(`/api/my-hazards/${encodeURIComponent(currentEmployee.name)}?empCode=${encodeURIComponent(currentEmployee.empCode || currentEmployee.code || '')}`);
      if (!res.ok) return;
      const data = await res.json();
      const raw = JSON.stringify(data.hazards || []);
      if (raw !== window.lastMyHazardsData) {
        window.lastMyHazardsData = raw;
        renderMyHazards(true);
      }
    } catch(e) {}
  }
}

// ============================================================
// 🎓 TRAINING MODULE (WORKER & ADMIN)
// ============================================================

window.trnAdminPollTimer = null;
window.trnWorkerPollTimer = null;
let _allAdminTrainings = [];
let _allAdminDrills = [];
let _adminGlobalMatrix = [];

async function loadWorkerTraining(isSilent = false) {
  if (!currentEmployee) return;
  
  // Update UI headers
  const textEl = document.getElementById('trnWorkerStatText');
  const barEl = document.getElementById('trnWorkerProgressBar');
  const activeArea = document.getElementById('trnWorkerActiveSessionArea');
  const historyList = document.getElementById('trnWorkerHistoryList');

  try {
    const res = await fetch(`/api/trainings/worker/${encodeURIComponent(currentEmployee.empCode)}`);
    const data = await res.json();
    
    const activeSession = data.activeSession;
    const myHistory = data.myHistory || [];
    const totalClosed = data.totalClosed || 0;
    const myAttended = data.myAttended || 0;

    // Update KPIs — hours-based (1 lecture = 0.5 hours, target = 8 hours)
    const attendedHours = myAttended * 0.5;
    const progressPercentage = Math.min(100, (attendedHours / 8) * 100);
    textEl.textContent = `🎓 حضرت ${attendedHours} ساعة من إجمالي 8 ساعات`;
    barEl.style.width = `${progressPercentage}%`;
    barEl.style.background = progressPercentage >= 100 ? 'var(--success)' : '#3b82f6';

    // Active Session
    if (activeSession) {
      const alreadyAttended = activeSession.attendees.find(a => normalizeEmpCode(a.empCode) === normalizeEmpCode(currentEmployee.empCode));
      if (alreadyAttended) {
        activeArea.innerHTML = `
          <div class="ticket" style="border-left: 5px solid var(--success);">
            <div class="ticket-body" style="text-align:center;">
              <h3 style="color:var(--success); margin:0 0 8px 0;">✅ تم تسجيل حضورك بنجاح</h3>
              <p style="margin:0; font-size:14px;">محاضرة: <strong>${escapeHtml(activeSession.title)}</strong></p>
            </div>
          </div>`;
      } else {
        activeArea.innerHTML = `
          <div class="ticket" style="border-left: 5px solid var(--amber);">
            <div class="ticket-body">
              <h3 style="margin:0 0 4px 0; color:var(--amber);">📡 محاضرة جارية الآن</h3>
              <p style="margin:0 0 12px 0; font-size:14px; font-weight:700;">${escapeHtml(activeSession.title)} | ${escapeHtml(activeSession.location)}</p>
              <div style="display:flex; gap:8px;">
                <input type="text" id="trnWorkerPin" placeholder="أدخل رمز الجلسة (PIN)" style="flex:1; text-align:center; font-family:monospace; font-size:18px; font-weight:bold; letter-spacing:4px;" maxlength="4">
                <button class="submit-btn" style="flex:1;" onclick="submitAttendance('${activeSession.id}')">✅ تسجيل حضوري</button>
              </div>
              <div id="trnWorkerMsg" class="wl-msg" style="margin-top:8px;"></div>
            </div>
          </div>`;
      }
    } else {
      activeArea.innerHTML = `
        <div class="ticket">
          <div class="ticket-body" style="text-align:center; color:var(--muted); font-size:14px;">
            لا توجد محاضرات جارية في الوقت الحالي.
          </div>
        </div>`;
    }

    // History
    if (myHistory.length === 0) {
      historyList.innerHTML = '<div class="empty">لم تسجل حضور في أي محاضرة حتى الآن.</div>';
    } else {
      historyList.innerHTML = `
        <div class="um-table-wrap">
          <table class="um-table">
            <thead><tr><th>التاريخ</th><th>الموضوع</th><th>الحالة</th></tr></thead>
            <tbody>
              ${myHistory.map(h => {
                const stText = h.status || '';
                let stHtml = escapeHtml(stText);
                if (stText.includes('غائب')) {
                  stHtml = `<span class="badge badge-danger" style="background:#fee2e2; color:#b91c1c; border:1px solid #f87171; padding:4px 8px; border-radius:6px; font-weight:bold; font-size:11px; white-space:nowrap; display:inline-block;">${stText}</span>`;
                } else if (stText.includes('مؤكد')) {
                  stHtml = `<span class="badge badge-success" style="background:#dcfce7; color:#15803d; border:1px solid #86efac; padding:4px 8px; border-radius:6px; font-weight:bold; font-size:11px; white-space:nowrap; display:inline-block;">${stText}</span>`;
                } else {
                  stHtml = `<span class="badge badge-warning" style="background:#fef3c7; color:#b45309; border:1px solid #fde68a; padding:4px 8px; border-radius:6px; font-weight:bold; font-size:11px; white-space:nowrap; display:inline-block;">${stText}</span>`;
                }
                return `
                <tr>
                  <td style="font-size:12px; color:var(--muted);">${escapeHtml(h.date)}</td>
                  <td style="font-weight:700; font-size:13px;">${escapeHtml(h.title)}</td>
                  <td style="font-size:12px; font-weight:700;">${stHtml}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;
    }
  } catch (e) {
    console.error(e);
  }
}

async function submitAttendance(sessionId) {
  const pin = document.getElementById('trnWorkerPin').value;
  const msgEl = document.getElementById('trnWorkerMsg');
  if (!pin || pin.length !== 4) {
    msgEl.textContent = 'الرجاء إدخال الرمز المكون من 4 أرقام';
    msgEl.className = 'um-msg error show';
    return;
  }
  
  try {
    const res = await fetch(`/api/trainings/${sessionId}/attend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empCode: currentEmployee.empCode, pin: pin })
    });
    const data = await res.json();
    if (res.ok) {
      msgEl.textContent = '✅ تم تسجيل حضورك';
      msgEl.className = 'um-msg success show';
      setTimeout(loadWorkerTraining, 1500);
    } else {
      msgEl.textContent = data.error || 'رمز غير صحيح';
      msgEl.className = 'um-msg error show';
    }
  } catch (e) {
    msgEl.textContent = 'خطأ في الاتصال';
    msgEl.className = 'um-msg error show';
  }
}

async function loadAdminTraining(isSilent = false) {
  if (!isLoggedIn) return;
  
  if (!isSilent) {
    if (window.trnAdminPollTimer) {
      clearInterval(window.trnAdminPollTimer);
      window.trnAdminPollTimer = null;
    }
    
    // Hide create lecture card and live sessions if not hse_admin or super_admin
    const isSafetyOrSuper = (currentUserRole === 'hse_admin' || currentUserRole === 'super_admin');
    const createCard = document.getElementById('createLectureCard');
    const liveSection = document.getElementById('liveSessionsSection');
    
    if (createCard) createCard.style.display = isSafetyOrSuper ? 'block' : 'none';
    if (liveSection) liveSection.style.display = isSafetyOrSuper ? 'block' : 'none';

    // Auto-fill trainer fields from logged-in admin info
    window.populateTrainerInfo();
  }

  try {
    const res = await fetch('/api/trainings', {
      headers: { 'Authorization': `Bearer ${getToken()}` }
    });
    const data = await res.json().catch(() => ({}));
    const trainings = Array.isArray(data) ? data : (data.trainings || data.data || []);

    const topicDatalist = document.getElementById('topicsList') || document.getElementById('trainingTopicsList');
    if (topicDatalist && !isSilent) {
      const defaultTopics = [
        "السلامة والصحة المهنية العامة",
        "مكافحة الحرائق والإخلاء",
        "الإسعافات الأولية",
        "مهمات الوقاية الشخصية (PPE)",
        "العمل على ارتفاعات",
        "السلامة الكهربائية",
        "التعامل الآمن مع المواد الكيميائية"
      ];
      const existingTopics = trainings.map(t => t && t.topic).filter(Boolean);
      const allUnique = Array.from(new Set([...defaultTopics, ...existingTopics]));
      topicDatalist.innerHTML = allUnique.map(top => `<option value="${top}">`).join('');
    }

    // Set or clear polling interval based on active sessions
    const hasActive = trainings.some(t => t.status === 'active');
    if (hasActive) {
      if (!window.trnAdminPollTimer) {
        window.trnAdminPollTimer = setInterval(() => loadAdminTraining(true), 3000);
      }
    } else {
      if (window.trnAdminPollTimer) {
        clearInterval(window.trnAdminPollTimer);
        window.trnAdminPollTimer = null;
      }
    }

    if (typeof renderAdminLiveSessions === 'function') {
      const raw = JSON.stringify(trainings);
      if (raw !== JSON.stringify(_allAdminTrainings)) {
        _allAdminTrainings = trainings;
        renderAdminLiveSessions(trainings);
      }
    }

    // Re-apply trainer fields after data loads (allEmployees may now be available)
    window.populateTrainerInfo();
  } catch (err) {
    console.error('Handled loadAdminTraining error:', err);
  }
}


function renderAdminLiveSessions(trainings) {
  const liveEl = document.getElementById('trnAdminLiveSessions');
  const activeSessions = trainings.filter(t => t.status === 'active');
  let closedSessions = trainings.filter(t => t.status === 'closed' && !t.isDeleted).sort((a,b) => new Date(b.createdAt || b.date) - new Date(a.createdAt || a.date));
  
  // Apply Filters
  const fFrom = document.getElementById('filter_trn_fromDate')?.value;
  const fTo = document.getElementById('filter_trn_toDate')?.value;
  const fTopic = document.getElementById('filter_trn_topic')?.value?.toLowerCase();
  const fTrainer = document.getElementById('filter_trn_trainer')?.value?.toLowerCase();
  
  let hasFilters = false;
  if (fFrom || fTo || fTopic || fTrainer) {
    hasFilters = true;
    closedSessions = closedSessions.filter(t => {
      let match = true;
      if (fFrom && new Date(t.date || t.createdAt) < new Date(fFrom)) match = false;
      if (fTo && new Date(t.date || t.createdAt) > new Date(fTo)) match = false;
      if (fTopic && !((t.topic || t.title || '').toLowerCase().includes(fTopic))) match = false;
      if (fTrainer && !((t.trainer || '').toLowerCase().includes(fTrainer))) match = false;
      return match;
    });
  }

  const trashSessions = trainings.filter(t => t.isDeleted).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  let html = '';
  if (activeSessions.length > 0) {
    activeSessions.forEach(trn => {
      html += `
      <div class="ticket" style="border-left: 5px solid var(--amber); margin-bottom: 16px;">
        <div class="ticket-body">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div>
              <h3 style="margin:0 0 4px 0;">${escapeHtml(trn.title)}</h3>
              <p style="margin:0; font-size:13px; color:var(--muted);">${escapeHtml(trn.location)} | المستهدف: ${escapeHtml(trn.targetGroup)}</p>
            </div>
            <div style="background:var(--amber); color:#fff; padding:8px 16px; border-radius:8px; text-align:center;">
              <div style="font-size:12px; opacity:0.9;">رمز الجلسة (PIN)</div>
              <div style="font-size:24px; font-family:monospace; font-weight:900; letter-spacing:4px;">${escapeHtml(trn.sessionPin)}</div>
            </div>
          </div>
          
          <h4 style="margin:16px 0 8px 0; padding-top:16px; border-top:1px solid var(--paper-line);">📋 الحضور (${trn.attendees.length})</h4>
          <div class="um-table-wrap" style="margin-bottom:16px;">
            <table class="um-table">
              <thead><tr><th>الكود</th><th>الاسم</th><th>القسم</th><th>الوقت</th><th>التحقق</th></tr></thead>
              <tbody>
              ${trn.attendees.map(a => {
                // Check if employee attended this same topic in the last 90 days
                let duplicateWarning = '';
                if (_allAdminTrainings) {
                  const now = Date.now();
                  const ninetyDays = 90 * 24 * 60 * 60 * 1000;
                  const pastAttendedList = _allAdminTrainings.filter(t => 
                    t.id !== trn.id && 
                    t.title === trn.title && 
                    (now - new Date(t.createdAt).getTime()) <= ninetyDays &&
                    t.attendees.some(att => att.empCode === a.empCode && att.verified)
                  );
                  if (pastAttendedList.length > 0) {
                    const count = pastAttendedList.length;
                    const dates = pastAttendedList.map(t => new Date(t.createdAt).toISOString().split('T')[0]).join(' ، ');
                    const countText = count === 1 ? 'مرة واحدة' : `${count} مرات`;
                    const dateLabel = count === 1 ? 'بتاريخ:' : 'بتواريخ:';
                    duplicateWarning = `<div style="margin-top:4px;font-size:11px;color:#fff;background:var(--amber);padding:2px 6px;border-radius:4px;display:inline-block;">⚠️ تنبيه: حضر الموظف هذه المحاضرة مسبقاً (${countText}) ${dateLabel} [${dates}]</div>`;
                  }
                }
                
                return `
                <tr>
                  <td style="font-family:monospace; font-weight:bold;">${escapeHtml(a.empCode)}</td>
                  <td>
                    ${escapeHtml(a.name)}
                    ${duplicateWarning}
                  </td>
                  <td>${escapeHtml(a.department)}</td>
                  <td style="font-size:12px; color:var(--muted);">${new Date(a.attendedAt).toLocaleTimeString('ar-EG')}</td>
                  <td>
                    <button class="um-btn ${a.verified ? 'del' : 'pass'}" onclick="toggleTrnVerification('${trn.id}', '${a.empCode}', ${!a.verified})" style="padding:4px 8px; font-size:11px;">
                      ${a.verified ? '❌ إلغاء' : '✅ تأكيد'}
                    </button>
                  </td>
                </tr>
                `;
              }).join('')}
              ${trn.attendees.length === 0 ? '<tr><td colspan="5" style="text-align:center; color:var(--muted);">لا يوجد حضور حتى الآن. رمز الجلسة ظاهر للعمال.</td></tr>' : ''}
              </tbody>
            </table>
          </div>
          
          <div style="display:flex; gap:8px;">
            <button class="submit-btn" style="flex:1; background:var(--danger);" onclick="closeTrainingSession('${trn.id}')">🛑 إنهاء وإغلاق المحاضرة</button>
            <button class="um-btn" style="flex:1;" onclick="addManualTrnAttendee('${trn.id}')">➕ إضافة حضور يدوي</button>
            <button class="um-btn" style="flex:1;" onclick="exportTrainingExcel('${trn.id}')">📥 تصدير Excel</button>
          </div>
        </div>
      </div>`;
    });
  } else {
    html += '<div class="empty">لا توجد محاضرات جارية. يمكنك إنشاء محاضرة جديدة.</div>';
  }
  
  if (closedSessions.length > 0) {
    html += `<h4 style="margin-top:24px;">المحاضرات السابقة (${closedSessions.length})</h4>`;
    // If filtered, show all matches (or a generous limit like 100), otherwise top 5
    const displaySessions = hasFilters ? closedSessions.slice(0, 500) : closedSessions.slice(0, 10);
    
    displaySessions.forEach(trn => {
      html += `
      <div class="ticket" style="margin-bottom:8px;">
        <div class="ticket-body" style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:700;">${escapeHtml(trn.title)}</div>
            <div style="font-size:12px; color:var(--muted);">
              ${escapeHtml(trn.date)} | ${escapeHtml(trn.trainer || 'غير محدد')} | حضور: ${trn.attendees.filter(a=>a.verified).length}
            </div>
          </div>
          <div>
            <button class="um-btn" onclick="exportTrainingExcel('${trn.id}')" style="padding:6px 12px; font-size:12px;">📥 Excel</button>
            <button class="um-btn del" onclick="softDeleteTraining('${trn.id}')" style="padding:6px 12px; font-size:12px; margin-inline-start:4px;">🗑️ حذف</button>
          </div>
        </div>
      </div>`;
    });
    if (!hasFilters && closedSessions.length > 10) {
      html += `<div style="text-align:center; font-size:13px; color:var(--primary); margin-top:12px; padding:8px; border: 1px dashed var(--paper-line); border-radius: 8px;">
        تم عرض أحدث 10 محاضرات من إجمالي ${closedSessions.length} محاضرة. استخدم فلاتر البحث بالأعلى لعرض الباقي.
      </div>`;
    } else if (hasFilters) {
      html += `<div style="text-align:center; font-size:13px; color:var(--primary); margin-top:12px; padding:8px;">
        تم العثور على ${closedSessions.length} نتيجة مطابقة.
      </div>`;
    }
  }

  if (trashSessions.length > 0) {
    html += '<h4 style="margin-top:24px; color:var(--danger);">🗑️ سلة محذوفات المحاضرات</h4>';
    trashSessions.forEach(trn => {
      html += `
      <div class="ticket" style="margin-bottom:8px; border-color:var(--danger); opacity:0.8;">
        <div class="ticket-body" style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:700; text-decoration:line-through;">${escapeHtml(trn.title)}</div>
            <div style="font-size:12px; color:var(--muted);">${escapeHtml(trn.date)} | حُذفت في: ${trn.deletedAt ? new Date(trn.deletedAt).toLocaleDateString('ar-EG') : ''}</div>
          </div>
          <div>
            <button class="um-btn pass" onclick="restoreTraining('${trn.id}')" style="padding:6px 12px; font-size:12px;">🔄 استعادة</button>
            <button class="um-btn del" onclick="permanentDeleteTraining('${trn.id}')" style="padding:6px 12px; font-size:12px; margin-inline-start:4px;">❌ نهائي</button>
          </div>
        </div>
      </div>`;
    });
  }
  
  liveEl.innerHTML = html;
}

window.applyTrainingFilters = function() {
  if (_allAdminTrainings && _allAdminTrainings.length > 0) {
    renderAdminLiveSessions(_allAdminTrainings);
  }
};

function clearTrainingFilters() {
  document.getElementById('filter_trn_fromDate').value = '';
  document.getElementById('filter_trn_toDate').value = '';
  document.getElementById('filter_trn_topic').value = '';
  document.getElementById('filter_trn_trainer').value = '';
  if (_allAdminTrainings) renderAdminLiveSessions(_allAdminTrainings);
}

async function bulkExportTrainings() {
  if (!_allAdminTrainings) return;
  
  // Re-apply current filters to get the exact list of IDs
  const fFrom = document.getElementById('filter_trn_fromDate')?.value;
  const fTo = document.getElementById('filter_trn_toDate')?.value;
  const fTopic = document.getElementById('filter_trn_topic')?.value?.toLowerCase();
  const fTrainer = document.getElementById('filter_trn_trainer')?.value?.toLowerCase();
  
  const closedSessions = _allAdminTrainings.filter(t => t.status === 'closed' && !t.isDeleted);
  const filtered = closedSessions.filter(t => {
    let match = true;
    if (fFrom && new Date(t.date || t.createdAt) < new Date(fFrom)) match = false;
    if (fTo && new Date(t.date || t.createdAt) > new Date(fTo)) match = false;
    if (fTopic && !((t.topic || t.title || '').toLowerCase().includes(fTopic))) match = false;
    if (fTrainer && !((t.trainer || '').toLowerCase().includes(fTrainer))) match = false;
    return match;
  });

  if (filtered.length === 0) {
    showToast('لا توجد محاضرات مطابقة للفلاتر لتصديرها.', 'error');
    return;
  }

  showToast('جاري تحضير ملف الإكسيل...', 'info');
  const ids = filtered.map(t => t.id);

  try {
    const res = await fetch('/api/trainings/export-bulk', {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ids })
    });
    
    if (res.ok) {
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Filtered_Trainings_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('تم تحميل الملف المجمع بنجاح!', 'success');
    } else {
      showToast('فشل في تصدير البيانات المجمعة', 'error');
    }
  } catch (err) {
    console.error(err);
    showToast('حدث خطأ أثناء الاتصال بالخادم', 'error');
  }
}

async function uploadTrainingsExcel(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const dataUrl = e.target.result;
    const base64Data = dataUrl.split(',')[1];
    
    showToast('جاري رفع السجل واستيراد البيانات...', 'info');
    
    try {
      const res = await authFetch('/api/trainings/upload-excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64Data })
      });
      const json = await res.json();
      if (json.success) {
        showToast(`تم استيراد ${json.count} محاضرة بنجاح!`, 'success');
        loadAdminTraining(true);
      } else {
        showToast(json.message || 'حدث خطأ أثناء الرفع', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('خطأ في الاتصال بالخادم', 'error');
    }
    
    // Reset file input
    event.target.value = '';
  };
  reader.readAsDataURL(file);
}

async function createTrainingSession() {
  const title = document.getElementById('trn_topic').value.trim();
  const tgroup = document.getElementById('trn_targetGroup').value;
  const date = document.getElementById('trn_date').value;
  const loc = document.getElementById('trn_location').value;
  const stime = document.getElementById('trn_startTime').value;
  const etime = document.getElementById('trn_endTime').value;
  const trainer = (document.getElementById('trn_trainer')?.value || '').trim();
  const trainerCode = (document.getElementById('trn_trainerCode')?.value || '').trim();
  const msgEl = document.getElementById('trn_createMsg');
  
  if (!title || !date || !stime || !etime) {
    msgEl.textContent = 'الرجاء ملء جميع الحقول المطلوبة (*)';
    msgEl.className = 'wl-msg error show';
    return;
  }
  
  const pin = Math.floor(1000 + Math.random() * 9000).toString();
  
  try {
    const res = await authFetch('/api/trainings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title, targetGroup: tgroup, date, location: loc, startTime: stime, endTime: etime, sessionPin: pin, trainer, trainerCode
      })
    });
    const data = await res.json();
    if (res.ok) {
      msgEl.textContent = '✅ تم إنشاء المحاضرة بنجاح';
      msgEl.className = 'wl-msg success show';
      document.getElementById('trn_topic').value = '';
      document.getElementById('trn_targetGroup').value = '';
      document.getElementById('trn_location').value = '';
      if (document.getElementById('trn_trainer')) document.getElementById('trn_trainer').value = '';
      if (document.getElementById('trn_trainerCode')) document.getElementById('trn_trainerCode').value = '';
      window.populateTrainerInfo();
      setTimeout(() => {
        msgEl.className = 'wl-msg';
        loadAdminTraining(true);
      }, 1500);
    } else {
      msgEl.textContent = data.error || 'فشل الإنشاء';
      msgEl.className = 'wl-msg error show';
    }
  } catch(e) {
    msgEl.textContent = 'خطأ اتصال';
    msgEl.className = 'wl-msg error show';
  }
}

async function closeTrainingSession(id) {
  if (!confirm('هل أنت متأكد من إنهاء وإغلاق المحاضرة؟ (لن يتمكن العمال من تسجيل الحضور بعد ذلك)')) return;
  try {
    const res = await authFetch(`/api/trainings/${id}/close`, { method: 'PUT' });
    if (res.ok) loadAdminTraining(true);
  } catch(e) {}
}

async function toggleTrnVerification(id, empCode, verified) {
  try {
    const res = await authFetch(`/api/trainings/${id}/verify-attendee`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empCode, verified })
    });
    if (res.ok) loadAdminTraining(true);
  } catch(e) {}
}

// إضافة حضور يدويًا من الأدمن (لموظف ليس معه موبايل مثلاً) — بإدخال الكود
// الوظيفي فقط؛ الاسم والقسم بيتسحبوا تلقائيًا من قاعدة الموظفين.
async function addManualTrnAttendee(id) {
  const empCode = window.prompt('من فضلك أدخل الكود الوظيفي للموظف المطلوب تسجيل حضوره:');
  if (!empCode || !empCode.trim()) return;
  try {
    const res = await authFetch(`/api/trainings/${id}/add-attendee`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empCode: empCode.trim() })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      loadAdminTraining(true);
    } else {
      showToast(data.error || 'تعذّر تسجيل الحضور', 'error');
    }
  } catch(e) {
    showToast('لا يوجد اتصال بالسيرفر', 'error');
  }
}

async function exportTrainingExcel(sessionId) {
  try {
    const token = typeof getToken === 'function' ? getToken() : localStorage.getItem('ep_token');
    const res = await fetch(`/api/trainings/${sessionId}/export-excel`, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {}
    });
    if (!res.ok) throw new Error('فشل تصدير الملف');
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `كشف_حضور_${sessionId}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  } catch (err) {
    console.error(err);
    showToast('حدث خطأ أثناء تصدير ملف الإكسيل', 'error');
  }
}



// ============================================================
// 🚨 DRILLS MODULE (FRONTEND)
// ============================================================

async function loadWorkerDrill(isSilent = false) {
  if (!currentEmployee) return;
  
  const textEl = document.getElementById('drlWorkerStatText');
  const barEl = document.getElementById('drlWorkerProgressBar');
  const activeArea = document.getElementById('drlWorkerActiveSessionArea');
  const historyList = document.getElementById('drlWorkerHistoryList');

  try {
    const res = await fetch(`/api/drills/worker/` + encodeURIComponent(currentEmployee.empCode));
    const data = await res.json();
    
    const activeSession = data.activeSession;
    const myHistory = data.myHistory || [];
    const totalClosed = data.totalClosed || 0;
    const myAttended = data.myAttended || 0;

    textEl.textContent = `🎯 حضرت ${myAttended} تجربة طوارئ`;
    if(barEl && barEl.parentElement) barEl.parentElement.style.display = "none";

    if (activeSession) {
      const alreadyAttended = activeSession.attendees.find(a => normalizeEmpCode(a.empCode) === normalizeEmpCode(currentEmployee.empCode));
      if (alreadyAttended) {
        activeArea.innerHTML = `
          <div class="ticket" style="border-left: 5px solid var(--success);">
            <div class="ticket-body" style="text-align:center;">
              <h3 style="color:var(--success); margin:0 0 8px 0;">✅ تم تسجيل حضورك بنجاح</h3>
              <p style="margin:0; font-size:14px;">تجربة: <strong>${escapeHtml(activeSession.title)}</strong></p>
            </div>
          </div>`;
      } else {
        activeArea.innerHTML = `
          <div class="ticket" style="border-left: 5px solid var(--danger);">
            <div class="ticket-body">
              <h3 style="margin:0 0 4px 0; color:var(--danger);">🚨 تجربة أداء جارية الآن</h3>
              <p style="margin:0 0 12px 0; font-size:14px; font-weight:700;">${escapeHtml(activeSession.title)} | ${escapeHtml(activeSession.location)}</p>
              <div style="display:flex; gap:8px;">
                <input type="text" id="drlWorkerPin" placeholder="أدخل رمز الجلسة (PIN)" style="flex:1; text-align:center; font-family:monospace; font-size:18px; font-weight:bold; letter-spacing:4px;" maxlength="4">
                <button class="submit-btn" style="flex:1;" onclick="submitDrillAttendance('${activeSession.id}')">✅ تسجيل حضوري</button>
              </div>
              <div id="drlWorkerMsg" class="wl-msg" style="margin-top:8px;"></div>
            </div>
          </div>`;
      }
    } else {
      activeArea.innerHTML = `
        <div class="ticket">
          <div class="ticket-body" style="text-align:center; color:var(--muted); font-size:14px;">
            لا توجد تجارب أداء جارية في الوقت الحالي.
          </div>
        </div>`;
    }

    if (myHistory.length === 0) {
      historyList.innerHTML = '<div class="empty">لم تسجل حضور في أي تجربة حتى الآن.</div>';
    } else {
      historyList.innerHTML = `
        <div class="um-table-wrap">
          <table class="um-table">
            <thead><tr><th>التاريخ</th><th>الموضوع</th><th>الحالة</th></tr></thead>
            <tbody>
              ${myHistory.map(h => {
                const stText = h.status || '';
                let stHtml = escapeHtml(stText);
                if (stText.includes('غائب')) {
                  stHtml = `<span class="badge badge-danger" style="background:#fee2e2; color:#b91c1c; border:1px solid #f87171; padding:4px 8px; border-radius:6px; font-weight:bold; font-size:11px; white-space:nowrap; display:inline-block;">${stText}</span>`;
                } else if (stText.includes('مؤكد')) {
                  stHtml = `<span class="badge badge-success" style="background:#dcfce7; color:#15803d; border:1px solid #86efac; padding:4px 8px; border-radius:6px; font-weight:bold; font-size:11px; white-space:nowrap; display:inline-block;">${stText}</span>`;
                } else {
                  stHtml = `<span class="badge badge-warning" style="background:#fef3c7; color:#b45309; border:1px solid #fde68a; padding:4px 8px; border-radius:6px; font-weight:bold; font-size:11px; white-space:nowrap; display:inline-block;">${stText}</span>`;
                }
                return `
                <tr>
                  <td style="font-size:12px; color:var(--muted);">${escapeHtml(h.date)}</td>
                  <td style="font-weight:700; font-size:13px;">${escapeHtml(h.title)}</td>
                  <td style="font-size:12px; font-weight:700;">${stHtml}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;
    }
  } catch (e) { console.error(e); }
}

async function submitDrillAttendance(sessionId) {
  const pin = document.getElementById('drlWorkerPin').value;
  const msgEl = document.getElementById('drlWorkerMsg');
  if (!pin || pin.length !== 4) {
    msgEl.textContent = 'الرجاء إدخال الرمز المكون من 4 أرقام';
    msgEl.className = 'um-msg error show';
    return;
  }
  try {
    const res = await fetch(`/api/drills/${sessionId}/attend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empCode: currentEmployee.empCode, pin: pin })
    });
    const data = await res.json();
    if (res.ok) {
      msgEl.textContent = '✅ تم تسجيل حضورك';
      msgEl.className = 'um-msg success show';
      setTimeout(loadWorkerDrill, 1500);
    } else {
      msgEl.textContent = data.error || 'فشل التسجيل';
      msgEl.className = 'um-msg error show';
    }
  } catch(e) {
    msgEl.textContent = 'خطأ اتصال';
    msgEl.className = 'um-msg error show';
  }
}

async function loadAdminDrill(isSilent = false) {
  const container = document.getElementById('drlAdminLiveSessions');
  if (!container) return;
  try {
    const res = await authFetch('/api/drills');
    if (!res.ok) return;
    const data = await res.json();
    const allDrills = (data.drills || []).filter(d => !d.isDeleted);
    _allAdminDrills = allDrills;
    const activeDrills = allDrills.filter(d => d.status === 'active');
    const closedDrills = allDrills.filter(d => d.status === 'closed').sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    // Set or clear polling interval based on active sessions
    if (activeDrills.length > 0) {
      if (!window.drlAdminPollTimer) {
        window.drlAdminPollTimer = setInterval(() => loadAdminDrill(true), 3000);
      }
    } else {
      if (window.drlAdminPollTimer) {
        clearInterval(window.drlAdminPollTimer);
        window.drlAdminPollTimer = null;
      }
    }

    let html = '';

    if (activeDrills.length === 0) {
      html += '<div class="empty">لا توجد تجارب طوارئ جارية الآن. يمكنك إنشاء تجربة جديدة.</div>';
    } else {
      activeDrills.forEach(drl => {
        const attendees = (drl.attendees || []).map(a => {
          // Check if the employee attended this same drill title before
          // (same pattern as training's 90-day duplicate check).
          let dupWarningHtml = '';
          if (_allAdminDrills) {
            const now = Date.now();
            const ninetyDays = 90 * 24 * 60 * 60 * 1000;
            const pastAttendedList = _allAdminDrills.filter(d =>
              d.id !== drl.id &&
              d.title === drl.title &&
              (now - new Date(d.createdAt).getTime()) <= ninetyDays &&
              (d.attendees || []).some(att => att.empCode === a.empCode && att.verified)
            );
            if (pastAttendedList.length > 0) {
              const count = pastAttendedList.length;
              const dates = pastAttendedList.map(d => new Date(d.createdAt).toISOString().split('T')[0]).join(' ، ');
              const countText = count === 1 ? 'مرة واحدة' : `${count} مرات`;
              const dateLabel = count === 1 ? 'بتاريخ:' : 'بتواريخ:';
              dupWarningHtml = `<div style="margin-top:4px;font-size:11px;color:#fff;background:#f59e0b;padding:2px 6px;border-radius:4px;display:inline-block;">⚠️ تنبيه: حضر الموظف هذه التجربة مسبقاً (${countText}) ${dateLabel} [${dates}]</div>`;
            }
          }
          return {
            code: escapeHtml(a.empCode),
            rawCode: a.empCode,
            name: escapeHtml(a.name || ''),
            department: escapeHtml(a.department || ''),
            time: new Date(a.attendedAt).toLocaleTimeString('ar-EG'),
            verified: a.verified !== false,
            dupWarningHtml
          };
        });
        const drill = {
          id: drl.id,
          pin: drl.sessionPin || '',
          title: drl.title || '',
          location: drl.location || 'غير محدد',
          supervisorName: drl.trainer || '',
          attendees
        };
        html += `
<div style="border: 2px solid #DC2626; border-radius: 10px; overflow: hidden; margin-bottom: 20px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); background: white;">
    <div style="display: flex; background: white; padding: 20px; align-items: center; border-bottom: 2px solid #f0f0f0;">
        <div style="background: #DC2626; color: white; padding: 15px; border-radius: 10px; text-align: center; min-width: 120px;">
            <div style="font-size: 0.9rem; margin-bottom: 5px;">رمز الجلسة (PIN)</div>
            <div style="font-size: 2rem; font-weight: bold; letter-spacing: 5px;">${drill.pin}</div>
        </div>
        <div style="flex-grow: 1; text-align: left; padding-right: 20px;">
            <h3 style="margin: 0 0 10px 0; color: #0F172A; font-size: 1.5rem;">${escapeHtml(drill.title)}</h3>
            <p style="margin: 0; color: #64748B;">المكان: ${escapeHtml(drill.location)} | المشرف: ${escapeHtml(drill.supervisorName)}</p>
        </div>
    </div>
    
    <div style="padding: 20px;">
        <h4 style="margin-top: 0;">📋 الحضور (${drill.attendees ? drill.attendees.length : 0})</h4>
        <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; text-align: right;">
                <thead>
                    <tr style="background-color: #0F172A; color: white;">
                        <th style="padding: 12px;">الكود</th>
                        <th style="padding: 12px;">الاسم</th>
                        <th style="padding: 12px;">القسم</th>
                        <th style="padding: 12px;">الوقت</th>
                        <th style="padding: 12px;">التحقق</th>
                    </tr>
                </thead>
                <tbody>
                    ${drill.attendees && drill.attendees.length > 0 ? drill.attendees.map(att => `
                        <tr style="border-bottom: 1px solid #ddd;">
                            <td style="padding: 12px; font-weight: bold;">${att.code}</td>
                            <td style="padding: 12px;">
                                ${escapeHtml(att.name)}
                                ${att.dupWarningHtml}
                            </td>
                            <td style="padding: 12px;">${escapeHtml(att.department)}</td>
                            <td style="padding: 12px;">${att.time}</td>
                            <td style="padding: 12px;">
                                <button class="um-btn ${att.verified ? 'del' : 'pass'}" onclick="toggleDrlVerification('${drill.id}', '${escapeAttr(att.rawCode)}', ${!att.verified})" style="padding:5px 10px; font-size:0.85rem; border-radius:5px;">
                                  ${att.verified ? '❌ إلغاء' : '✅ تأكيد'}
                                </button>
                            </td>
                        </tr>
                    `).join('') : `<tr><td colspan="5" style="text-align: center; padding: 20px;">لا يوجد حضور حتى الآن.</td></tr>`}
                </tbody>
            </table>
        </div>
    </div>
    
    <div style="padding: 20px; background: #f8f9fa; border-top: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;">
        <button onclick="navigateWithAuth('/api/drills/export/${drill.id}')" style="background: #16A34A; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: bold;">📊 تصدير Excel</button>
        <button onclick="addManualDrlAttendee('${drill.id}')" style="background: #0F172A; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: bold;">➕ إضافة حضور يدوي</button>
        <button onclick="openDrillReportModal('${drill.id}')" style="background: #7C3AED; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: bold;">📝 إنشاء / تعديل الريبورت</button>
        <button onclick="closeDrillSession('${drill.id}')" style="background: #DC2626; color: white; border: none; padding: 12px 30px; border-radius: 8px; cursor: pointer; font-weight: bold;">🛑 إنهاء وإغلاق التجربة</button>
    </div>
</div>
`;
      });
    }

    // ── Past / Closed Drills History ─────────────────────────────
    if (closedDrills.length > 0) {
      html += '<h4 style="margin-top:24px;">سجل تجارب الطوارئ السابقة</h4>';
      closedDrills.slice(0, 15).forEach(drl => {
        const drill = { id: drl.id }; // to match the user's template variable
        const attCount = (drl.attendees || []).length;
        const attVerified = (drl.attendees || []).filter(a=>a.verified).length;
        const isLegacy = drl.source === 'legacy_import';
        html += `
        <div class="ticket" style="margin-bottom:8px;">
          <div class="ticket-body" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
            <div>
              <div style="font-weight:700;">${escapeHtml(drl.title)} ${isLegacy ? '<span style="font-size:11px; background:#e2e8f0; color:#334155; padding:2px 6px; border-radius:4px;">بيانات مستوردة</span>' : ''}</div>
              <div style="font-size:12px; color:var(--muted);">${escapeHtml(drl.date || '')} | 📍 ${escapeHtml(drl.location || '')} | حضور مؤكد: ${attVerified} / ${attCount}</div>
            </div>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button onclick="toggleDrlAttendeesView('${drl.id}')" style="background:#0F172A; color:#fff; border:none; padding:5px 15px; border-radius:5px; cursor:pointer; font-size:0.9rem;">👥 الحضور</button>
              <button onclick="navigateWithAuth('/api/drills/export/${drill.id}')" style="background: #16A34A; color: white; border: none; padding: 5px 15px; border-radius: 5px; cursor: pointer; font-size: 0.9rem;">📊 تصدير Excel</button>
              <button onclick="openDrillReportModal('${drl.id}')" style="background:#7C3AED; color:#fff; border:none; padding:5px 15px; border-radius:5px; cursor:pointer; font-size:0.9rem;">📝 الريبورت</button>
              <button class="um-btn del" onclick="deleteDrillSession('${drl.id}')" style="padding:6px 12px; font-size:12px;">🗑️ حذف</button>
            </div>
          </div>
          <div id="drlAttWrap_${drl.id}" style="display:none; padding:0 16px 16px;">
            ${isLegacy ? `<div style="font-size:12px; color:#b45309; background:#fffbeb; border:1px solid #fde68a; padding:8px; border-radius:6px; margin-bottom:8px;">⚠️ هذه تجربة قديمة مستوردة من تقارير ورقية سابقة، ولا يوجد لها سجل حضور رقمي (بأكواد الموظفين) — الأسماء المذكورة أدناه (إن وجدت) مأخوذة من نص التقرير الأصلي فقط.</div>` : ''}
            <div style="overflow-x:auto;">
              <table style="width:100%; border-collapse:collapse; text-align:right; font-size:13px;">
                <thead><tr style="background:#0F172A; color:#fff;">
                  <th style="padding:8px;">الكود</th><th style="padding:8px;">الاسم</th><th style="padding:8px;">القسم</th><th style="padding:8px;">الوقت</th><th style="padding:8px;">التحقق</th>
                </tr></thead>
                <tbody>
                  ${attCount > 0 ? (drl.attendees || []).map(a => `
                    <tr style="border-bottom:1px solid #eee;">
                      <td style="padding:8px;">${escapeHtml(a.empCode || '—')}</td>
                      <td style="padding:8px;">${escapeHtml(a.name || '')}</td>
                      <td style="padding:8px;">${escapeHtml(a.department || '')}</td>
                      <td style="padding:8px;">${a.attendedAt ? new Date(a.attendedAt).toLocaleString('ar-EG') : '—'}</td>
                      <td style="padding:8px;">${a.verified ? '✅' : '—'}</td>
                    </tr>`).join('') : `<tr><td colspan="5" style="text-align:center; padding:14px;">لا يوجد سجل حضور لهذه التجربة.</td></tr>`}
                </tbody>
              </table>
            </div>
          </div>
        </div>`;
      });
    }

    container.innerHTML = html;

  } catch(e) { console.error(e); }
}

async function createDrillSession() {
  const title = document.getElementById('drl_title').value;
  const targetGroup = document.getElementById('drl_targetGroup').value;
  const location = document.getElementById('drl_location').value;
  const date = document.getElementById('drl_date').value;
  const startTime = document.getElementById('drl_startTime').value;
  const endTime = document.getElementById('drl_endTime').value;
  const trainer = document.getElementById('drl_trainer').value;
  const trainerCode = document.getElementById('drl_trainerCode').value;
  const msgEl = document.getElementById('drl_createMsg');

  if (!title || !date || !startTime || !endTime || !location) {
    msgEl.textContent = 'البيانات الأساسية (العنوان، المكان، التاريخ، الوقت) مطلوبة';
    msgEl.className = 'wl-msg error show';
    return;
  }
  const sessionPin = Math.floor(1000 + Math.random() * 9000).toString();
  const payload = { title, targetGroup, location, date, startTime, endTime, sessionPin, trainer, trainerCode };

  try {
    const res = await authFetch('/api/drills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok) {
      msgEl.textContent = `تم الإنشاء! الرمز السري للجلسة: ${sessionPin}`;
      msgEl.className = 'wl-msg success show';
      document.getElementById('drl_title').value = '';
      loadAdminDrill(true);
    } else {
      msgEl.textContent = data.error || 'فشل الإنشاء';
      msgEl.className = 'wl-msg error show';
    }
  } catch(e) {
    msgEl.textContent = 'خطأ اتصال';
    msgEl.className = 'wl-msg error show';
  }
}

async function closeDrillSession(id) {
  if (!confirm('هل أنت متأكد من إنهاء وإغلاق التجربة؟ (لن يتمكن العمال من تسجيل الحضور بعد ذلك)')) return;
  try {
    const res = await authFetch(`/api/drills/${id}/close`, { method: 'PUT' });
    if (res.ok) loadAdminDrill(true);
  } catch(e) {}
}

async function deleteDrillSession(id) {
  if (!confirm('هل أنت متأكد من حذف التجربة نهائياً؟')) return;
  try {
    const res = await authFetch(`/api/drills/${id}`, { method: 'DELETE' });
    if (res.ok) loadAdminDrill(true);
  } catch(e) {}
}

window.exportDrillExcel = async function(id) {
  try {
    const token = typeof getToken === 'function' ? getToken() : '';
    const res = await fetch(`/api/drills/${id}/export-excel`, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {}
    });
    if (!res.ok) throw new Error('failed');
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `\u0643\u0634\u0641_\u062a\u062c\u0631\u0628\u0629_${id}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  } catch(e) {
    showToast('\u0641\u0634\u0644 \u062a\u0635\u062f\u064a\u0631 \u0627\u0644\u0645\u0644\u0641. \u062d\u0627\u0648\u0644 \u0645\u0631\u0629 \u0623\u062e\u0631\u0649.', 'error');
  }
};

async function toggleDrlVerification(id, empCode, verified) {
  try {
    const res = await authFetch(`/api/drills/${id}/verify-attendee`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empCode, verified })
    });
    if (res.ok) loadAdminDrill(true);
  } catch(e) {}
}

// إضافة حضور يدويًا من الأدمن أثناء تجربة الطوارئ الحية (لموظف ليس معه
// موبايل مثلاً) — بإدخال الكود الوظيفي فقط؛ الاسم والقسم بيتسحبوا تلقائيًا
// من قاعدة الموظفين.
async function addManualDrlAttendee(id) {
  const empCode = window.prompt('من فضلك أدخل الكود الوظيفي للموظف المطلوب تسجيل حضوره:');
  if (!empCode || !empCode.trim()) return;
  try {
    const res = await authFetch(`/api/drills/${id}/add-attendee`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empCode: empCode.trim() })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      loadAdminDrill(true);
    } else {
      showToast(data.error || 'تعذّر تسجيل الحضور', 'error');
    }
  } catch(e) {
    showToast('لا يوجد اتصال بالسيرفر', 'error');
  }
}


// عرض/إخفاء جدول الحضور تحت تجربة مقفولة في السجل
function toggleDrlAttendeesView(id) {
  const el = document.getElementById(`drlAttWrap_${id}`);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// ============================================================
// 📝 DRILL REPORT MODAL — إنشاء / تعديل ريبورت التجربة (نفس تصميم النموذج الورقي)
// ============================================================
const linesToArr = (val) => (val || '').split('\n').map(s => s.trim()).filter(Boolean);
const arrToLines = (arr) => (arr || []).join('\n');

async function openDrillReportModal(drillId) {
  let data;
  try {
    const res = await authFetch(`/api/drills/${drillId}/report`);
    if (!res.ok) throw new Error('failed');
    data = await res.json();
  } catch (e) {
    showToast('تعذر تحميل بيانات الريبورت', 'error');
    return;
  }
  const r = data.report || {};
  const drl = data.drill || {};

  document.getElementById('drlReportModalOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'drlReportModalOverlay';
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,42,0.6); z-index:9999; display:flex; align-items:flex-start; justify-content:center; overflow:auto; padding:20px 10px;';
  overlay.innerHTML = `
    <div style="background:#fff; width:100%; max-width:720px; border-radius:12px; overflow:hidden; box-shadow:0 10px 40px rgba(0,0,0,0.3);">
      <div style="background:#7C3AED; color:#fff; padding:16px 20px; display:flex; justify-content:space-between; align-items:center;">
        <div style="font-weight:700; font-size:1.1rem;">📝 ريبورت التجربة: ${escapeHtml(drl.title || '')}</div>
        <button onclick="document.getElementById('drlReportModalOverlay').remove()" style="background:transparent; border:none; color:#fff; font-size:1.4rem; cursor:pointer;">×</button>
      </div>
      <div style="padding:20px; max-height:75vh; overflow:auto;">
        <div class="field" style="margin-bottom:12px;">
          <label style="font-weight:700; display:block; margin-bottom:4px;">وصف الحادث/السيناريو (بين قوسين)</label>
          <input type="text" id="drf_scenario" value="${escapeAttr(r.scenario || '')}" placeholder="مثال: سقوط زيت اثناء النقل" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px;">
        </div>
        <div class="field" style="margin-bottom:12px;">
          <label style="font-weight:700; display:block; margin-bottom:4px;">الغرض من التجربة</label>
          <textarea id="drf_purpose" rows="4" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px;">${escapeHtml(r.purpose || '')}</textarea>
        </div>
        <div class="field" style="margin-bottom:12px;">
          <label style="font-weight:700; display:block; margin-bottom:4px;">تفاصيل تنفيذ التجربة (سطر لكل خطوة)</label>
          <textarea id="drf_steps" rows="6" placeholder="- تم إجراء التجربة ب...&#10;- قام العامل ... بـ ...&#10;- ..." style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px;">${escapeHtml(arrToLines(r.narrativeSteps))}</textarea>
        </div>
        <div class="field" style="margin-bottom:12px;">
          <label style="font-weight:700; display:block; margin-bottom:4px;">مقدمة نتيجة التجربة (اختياري)</label>
          <input type="text" id="drf_resultIntro" value="${escapeAttr(r.resultIntro || '')}" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px;">
        </div>
        <div class="field" style="margin-bottom:12px;">
          <label style="font-weight:700; display:block; margin-bottom:4px;">نقاط نتيجة التجربة (سطر لكل نقطة)</label>
          <textarea id="drf_results" rows="5" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px;">${escapeHtml(arrToLines(r.resultPoints))}</textarea>
        </div>
        <div class="field" style="margin-bottom:12px;">
          <label style="font-weight:700; display:block; margin-bottom:4px;">الإيجابيات (سطر لكل نقطة)</label>
          <textarea id="drf_positives" rows="4" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px;">${escapeHtml(arrToLines(r.positives))}</textarea>
        </div>
        <div class="field" style="margin-bottom:12px;">
          <label style="font-weight:700; display:block; margin-bottom:4px;">السلبيات (سطر لكل نقطة، اتركه فارغاً لو لا يوجد)</label>
          <textarea id="drf_negatives" rows="3" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px;">${escapeHtml(arrToLines(r.negatives))}</textarea>
        </div>
        <div class="field" style="margin-bottom:12px;">
          <label style="font-weight:700; display:block; margin-bottom:4px;">نقاط للتحسين (سطر لكل نقطة)</label>
          <textarea id="drf_improvements" rows="3" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px;">${escapeHtml(arrToLines(r.improvements))}</textarea>
        </div>
        <div class="field" style="margin-bottom:12px;">
          <label style="font-weight:700; display:block; margin-bottom:4px;">عبارة الشكر الختامية (اختياري)</label>
          <textarea id="drf_thanks" rows="2" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px;">${escapeHtml(r.thanksNote || '')}</textarea>
        </div>
        <div class="row2" style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
          <div class="field">
            <label style="font-weight:700; display:block; margin-bottom:4px;">صفة المسؤول الموقّع</label>
            <input type="text" id="drf_respTitle" value="${escapeAttr(r.responsibleTitle || 'مسئول البيئة والسلامة')}" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px;">
          </div>
          <div class="field">
            <label style="font-weight:700; display:block; margin-bottom:4px;">اسم المسؤول الموقّع</label>
            <input type="text" id="drf_respName" value="${escapeAttr(r.responsibleName || '')}" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px;">
          </div>
        </div>
        <div class="field" style="margin-bottom:4px;">
          <label style="font-weight:700; display:block; margin-bottom:4px;">تاريخ التوقيع</label>
          <input type="text" id="drf_sigDate" value="${escapeAttr(r.signatureDate || drl.date || '')}" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px;">
        </div>
        <div id="drf_msg" style="margin-top:10px; font-size:13px;"></div>
      </div>
      <div style="padding:14px 20px; background:#f8f9fa; border-top:1px solid #eee; display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end;">
        <button onclick="document.getElementById('drlReportModalOverlay').remove()" style="background:#e2e8f0; color:#0f172a; border:none; padding:10px 18px; border-radius:8px; cursor:pointer; font-weight:700;">إغلاق</button>
        <button onclick="saveDrillReport('${drillId}')" style="background:#0F172A; color:#fff; border:none; padding:10px 18px; border-radius:8px; cursor:pointer; font-weight:700;">💾 حفظ الريبورت</button>
        <button onclick="downloadDrillReport('${drillId}')" style="background:#16A34A; color:#fff; border:none; padding:10px 18px; border-radius:8px; cursor:pointer; font-weight:700;">⬇️ تحميل Word (بنفس التصميم)</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function collectDrillReportForm() {
  return {
    scenario: document.getElementById('drf_scenario').value.trim(),
    purpose: document.getElementById('drf_purpose').value.trim(),
    narrativeSteps: linesToArr(document.getElementById('drf_steps').value),
    resultIntro: document.getElementById('drf_resultIntro').value.trim(),
    resultPoints: linesToArr(document.getElementById('drf_results').value),
    positives: linesToArr(document.getElementById('drf_positives').value),
    negatives: linesToArr(document.getElementById('drf_negatives').value),
    improvements: linesToArr(document.getElementById('drf_improvements').value),
    thanksNote: document.getElementById('drf_thanks').value.trim(),
    responsibleTitle: document.getElementById('drf_respTitle').value.trim(),
    responsibleName: document.getElementById('drf_respName').value.trim(),
    signatureDate: document.getElementById('drf_sigDate').value.trim()
  };
}

async function saveDrillReport(drillId) {
  const msgEl = document.getElementById('drf_msg');
  try {
    const res = await authFetch(`/api/drills/${drillId}/report`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report: collectDrillReportForm() })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      msgEl.textContent = '✅ تم حفظ الريبورت بنجاح';
      msgEl.style.color = '#16A34A';
    } else {
      msgEl.textContent = data.error || 'فشل الحفظ';
      msgEl.style.color = '#DC2626';
    }
  } catch (e) {
    msgEl.textContent = 'لا يوجد اتصال بالسيرفر';
    msgEl.style.color = '#DC2626';
  }
}

async function downloadDrillReport(drillId) {
  // نحفظ أولاً بأحدث بيانات ثم ننزل الملف بنفس تصميم النموذج الورقي
  await saveDrillReport(drillId);
  navigateWithAuth(`/api/drills/${drillId}/report/export`);
}


// ============================================================
// 🖼️ LIGHTBOX LOGIC
// ============================================================
let currentLightboxZoom = 1;

function openLightbox(url) {
  const modal = document.getElementById('lightboxModal');
  const img = document.getElementById('lightboxImg');
  const dlBtn = document.getElementById('lightboxDownloadBtn');
  
  img.src = url;
  currentLightboxZoom = 1;
  img.style.transform = `scale(${currentLightboxZoom})`;
  
  dlBtn.onclick = () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = url.split('/').pop() || 'hazard_photo.jpg';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  
  modal.style.display = 'flex';
}

function closeLightbox() {
  document.getElementById('lightboxModal').style.display = 'none';
  document.getElementById('lightboxImg').src = '';
}

function zoomInLightbox() {
  currentLightboxZoom += 0.25;
  document.getElementById('lightboxImg').style.transform = `scale(${currentLightboxZoom})`;
}

function zoomOutLightbox() {
  currentLightboxZoom = Math.max(0.25, currentLightboxZoom - 0.25);
  document.getElementById('lightboxImg').style.transform = `scale(${currentLightboxZoom})`;
}

// ============================================================
// 🔔 SMART IN-APP NOTIFICATION CENTER
// ============================================================
// ============================================================
// 📡 NOTIFICATIONS & WEB PUSH MODULE
// ============================================================

let currentNotifications = [];
let currentNotifFilter = 'all';
let isNotifDrawerOpen = false;

function toggleNotifDrawer() {
  const drawer = document.getElementById('notifDropdown');
  isNotifDrawerOpen = !isNotifDrawerOpen;
  if (isNotifDrawerOpen) {
    drawer.classList.add('show');
    drawer.style.display = 'flex';
  } else {
    drawer.classList.remove('show');
    setTimeout(() => { if (!isNotifDrawerOpen) drawer.style.display = 'none'; }, 300);
  }
}

async function startNotificationPolling() {
  stopNotificationPolling();
  // fetchNotifications(); // Initial fetch
  
  // let params = new URLSearchParams();
  // const token = getToken();
  // if (token && sessionRole !== 'worker' && sessionRole !== 'none') {
  //   params.append('role', sessionRole);
  //   if (currentUserDept) params.append('department', currentUserDept);
  // } else if (currentEmployee && currentEmployee.empCode) {
  //   params.append('role', 'worker');
  //   params.append('empCode', currentEmployee.empCode);
  // } else {
  //   return;
  // }

  // Setup Server-Sent Events (SSE)
  // notifEventSource = new EventSource(`/api/notifications/poll?${params.toString()}`);
  // notifEventSource.onmessage = function(event) {
  //   try {
  //     const newNotif = JSON.parse(event.data);
  //     // Prepend to current list
  //     currentNotifications.unshift(newNotif);
  //     renderNotifications();
      
  //     // Play Chime
  //     const audio = document.getElementById('notifChime');
  //     if (audio) {
  //       audio.currentTime = 0;
  //       audio.play().catch(e => console.log('Audio blocked by browser:', e));
  //     }
      
  //     // Show Mobile/Desktop Toast
  //     showAppToast(newNotif.title, newNotif.message, () => handleNotificationClick(newNotif.id, newNotif.link, newNotif.targetId, newNotif.type));
  //   } catch(e) {}
  // };
  
  // Register Web Push Service Worker
  // subscribeToPushNotifications();
}

function stopNotificationPolling() {
  if (typeof notifEventSource !== 'undefined' && notifEventSource) {
    try { notifEventSource.close(); } catch(e) {}
    notifEventSource = null;
  }
  if (window._notifPollTimer) {
    clearInterval(window._notifPollTimer);
    window._notifPollTimer = null;
  }
}

async function subscribeToPushNotifications() {
  return;
  // if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  
  // try {
  //   const swReg = await navigator.serviceWorker.register('/sw.js');
    
  //   // Request Permission
  //   const permission = await Notification.requestPermission();
  //   if (permission !== 'granted') return;
    
  //   // Get VAPID Key
  //   const vapidRes = await fetch('/api/vapid-public-key');
  //   const vapidData = await vapidRes.json();
  //   if (!vapidData.publicKey) return;
    
  //   const applicationServerKey = urlB64ToUint8Array(vapidData.publicKey);
    
  //   const subscription = await swReg.pushManager.subscribe({
  //     userVisibleOnly: true,
  //     applicationServerKey: applicationServerKey
  //   });
    
  //   // Send to Backend
  //   const empCode = currentEmployee ? currentEmployee.empCode : (sessionRole !== 'none' ? 'admin' : '');
  //   await fetch('/api/notifications/subscribe', {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({ subscription, role: sessionRole, empCode: empCode })
  //   });
  // } catch (error) {
  //   console.error('Push Subscription Failed:', error);
  // }
}

// Alias — login flows call subscribeUserToPush; the real implementation is above.
// Exposed on window so it is always reachable regardless of parse order.
window.subscribeUserToPush = async function subscribeUserToPush() {
  try {
    await subscribeToPushNotifications();
  } catch (err) {
    console.warn('[Push] subscribeUserToPush bypassed:', err.message);
  }
};

function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function fetchNotifications() {
  let params = new URLSearchParams();
  const token = getToken();
  if (token && sessionRole !== 'worker' && sessionRole !== 'none') {
    params.append('role', sessionRole);
    if (currentUserDept) params.append('department', currentUserDept);
  } else if (currentEmployee && currentEmployee.empCode) {
    params.append('role', 'worker');
    params.append('empCode', currentEmployee.empCode);
  } else {
    return;
  }

  try {
    const res = await fetch(`/api/notifications?${params.toString()}`);
    if (res.ok) {
      const data = await res.json();
      currentNotifications = data.notifications || [];
      renderNotifications();
    }
  } catch(e) {}
}

function setNotifFilter(type) {
  currentNotifFilter = type;
  document.querySelectorAll('.notif-pill').forEach(btn => btn.classList.remove('active'));
  const targetBtn = Array.from(document.querySelectorAll('.notif-pill')).find(b => b.getAttribute('onclick').includes(`'${type}'`));
  if (targetBtn) targetBtn.classList.add('active');
  renderNotifications();
}

function timeAgo(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const seconds = Math.floor((new Date() - date) / 1000);
  let interval = seconds / 31536000;
  if (interval > 1) return Math.floor(interval) + " سنة";
  interval = seconds / 2592000;
  if (interval > 1) return Math.floor(interval) + " شهر";
  interval = seconds / 86400;
  if (interval > 1) return Math.floor(interval) + " يوم";
  interval = seconds / 3600;
  if (interval >= 1) return "منذ " + Math.floor(interval) + " ساعة";
  interval = seconds / 60;
  if (interval >= 1) return "منذ " + Math.floor(interval) + " دقيقة";
  return "الآن";
}

function getIdentifier() {
  const token = getToken();
  if (token && sessionRole !== 'worker' && sessionRole !== 'none') return sessionRole;
  if (currentEmployee && currentEmployee.empCode) return currentEmployee.empCode;
  return 'unknown';
}

function renderNotifications() {
  const listEl = document.getElementById('notifList');
  const badgeEl = document.getElementById('notifBadge');
  const container = document.getElementById('notifContainer');
  if (!listEl || !badgeEl || !container) return;

  container.style.display = 'inline-flex';
  const identifier = getIdentifier();
  let unreadCount = 0;

  const filteredNotifications = currentNotifications.filter(n => {
    const isUnread = !n.readBy.includes(identifier);
    if (isUnread) unreadCount++;
    if (currentNotifFilter === 'all') return true;
    if (currentNotifFilter === 'unread') return isUnread;
    return n.type === currentNotifFilter;
  });

  const html = filteredNotifications.map(n => {
    const isUnread = !n.readBy.includes(identifier);
    let iconEmoji = '🔔';
    if (n.type === 'hazard') iconEmoji = '⚠️';
    if (n.type === 'permit') iconEmoji = '📝';
    if (n.type === 'training') iconEmoji = '🎓';

    return `
      <li class="notif-item ${isUnread ? 'unread' : ''}" onclick="handleNotificationClick('${n.id}', '${n.link}', '${n.targetId || ''}', '${n.type || ''}')">
        <div class="notif-icon-wrap">${iconEmoji}</div>
        <div class="notif-content">
          <div class="notif-title-row">
            <h4 class="notif-title"><span class="pulse-dot" style="display:${isUnread ? 'inline-block' : 'none'};"></span>${escapeHtml(n.title)}</h4>
            <span class="notif-time">${timeAgo(n.createdAt)}</span>
          </div>
          <p class="notif-message">${escapeHtml(n.message)}</p>
        </div>
      </li>
    `;
  }).join('');

  listEl.innerHTML = filteredNotifications.length === 0 ? '<li style="padding:16px; text-align:center; color:var(--muted);">لا توجد إشعارات</li>' : html;
  
  if (unreadCount > 0) {
    badgeEl.textContent = unreadCount;
    badgeEl.style.display = 'inline-block';
  } else {
    badgeEl.style.display = 'none';
  }
}

async function handleNotificationClick(id, link, targetId, type) {
  // Mark read API
  const identifier = getIdentifier();
  await fetch(`/api/notifications/read/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empCode: identifier })
  });
  
  // Local Update
  const notif = currentNotifications.find(n => n.id === id);
  if (notif && !notif.readBy.includes(identifier)) {
    notif.readBy.push(identifier);
    renderNotifications();
  }
  
  if (isNotifDrawerOpen) toggleNotifDrawer();
  
  // Navigate
  if (link) {
    const tabMap = {
      'tabPermits': 'sup',
      'tabMyHistory': 'myhistory',
      'tabSupHazard': 'supHazard',
      'tabHazardWorker': 'hazardWorker',
      'tabMyHazards': 'myhazards',
      'tabTrainingWorker': 'trainingWorker',
      'tabTrainingAdmin': 'trainingAdmin'
    };
    const mappedLink = tabMap[link] || link;
    switchTab(mappedLink);
    
    if (targetId) {
      setTimeout(() => {
        if (type === 'permit') {
          const detailsEl = document.getElementById('details-' + targetId);
          if (detailsEl) detailsEl.classList.add('show');
        } else if (type === 'hazard') {
          if (typeof showHazardModal === 'function') showHazardModal(targetId);
        }
      }, 500);
    }
  }
}

async function markAllNotificationsAsRead() {
  const identifier = getIdentifier();
  await fetch('/api/notifications/read-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empCode: identifier })
  });
  
  currentNotifications.forEach(n => {
    if (!n.readBy.includes(identifier)) n.readBy.push(identifier);
  });
  renderNotifications();
}

function showAppToast(title, message, onClick) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'app-toast';
  toast.innerHTML = `
    <div style="font-size: 24px;">🔔</div>
    <div style="flex:1;">
      <div style="font-weight:700; margin-bottom:4px; font-size:14px;">${escapeHtml(title)}</div>
      <div style="font-size:12px; color:var(--muted);">${escapeHtml(message)}</div>
    </div>
  `;
  if (onClick) {
    toast.style.cursor = 'pointer';
    toast.onclick = () => { onClick(); toast.classList.remove('show'); };
  }
  container.appendChild(toast);
  
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });
  
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}
// ============================================================
// 🔄 GLOBAL SYNC BUTTON
// ============================================================
async function globalSyncData() {
  const btn = document.getElementById('btnGlobalSync');
  if (btn) btn.classList.add('spin');
  
  try {
    if (typeof fetchNotifications === 'function') {
      await fetchNotifications().catch(e => console.warn("Notifs sync bypassed:", e));
    }
    
    const tab = window.currentActiveTab;
    
    if (tab === 'worker' || tab === 'hazardWorker') {
      // Do nothing to avoid resetting inputs. Just refresh notifications.
    } else if (tab === 'sup') {
      if (typeof loadPermits === 'function') await loadPermits();
    } else if (tab === 'supHazard') {
      if (typeof loadAdminHazards === 'function') await loadAdminHazards();
    } else if (tab === 'users') {
      if (typeof loadUsers === 'function') await loadUsers();
    } else if (tab === 'employees') {
      if (typeof loadEmployees === 'function') await loadEmployees();
    } else if (tab === 'trainingAdmin') {
      if (typeof loadAdminTraining === 'function') await loadAdminTraining(false);
    } else if (tab === 'myhistory') {
      if (typeof loadMyHistory === 'function') await loadMyHistory();
    } else if (tab === 'myhazards') {
      if (typeof loadMyHazards === 'function') await loadMyHazards();
    } else if (tab === 'trainingWorker') {
      if (typeof loadWorkerTraining === 'function') await loadWorkerTraining();
    }
    
    showToast('تم تحديث البيانات بنجاح ✅', 'success');
  } catch (err) {
    console.error("Critical Sync Failure:", err);
    showToast('خطأ أثناء التحديث', 'error');
  } finally {
    if (btn) btn.classList.remove('spin');
  }
}

// ============================================================
// 🗑️ LECTURE TRASH SYSTEM
// ============================================================
async function softDeleteTraining(id) {
  if (!confirm('هل أنت متأكد من نقل المحاضرة إلى سلة المحذوفات؟')) return;
  try {
    const res = await authFetch('/api/trainings/' + id, { method: 'DELETE' });
    if (res.ok) {
      showToast('تم النقل إلى سلة المحذوفات', 'success');
      loadAdminTraining(true);
    } else {
      const data = await res.json();
      showToast(data.error || 'فشل الحذف', 'error');
    }
  } catch (e) {
    showToast('خطأ اتصال', 'error');
  }
}

async function restoreTraining(id) {
  if (!confirm('هل أنت متأكد من استعادة المحاضرة؟ سيعود رصيد الساعات للموظفين.')) return;
  try {
    const res = await authFetch('/api/trainings/' + id + '/restore', { method: 'PUT' });
    if (res.ok) {
      showToast('تمت استعادة المحاضرة', 'success');
      loadAdminTraining(true);
    } else {
      const data = await res.json();
      showToast(data.error || 'فشل الاستعادة', 'error');
    }
  } catch (e) {
    showToast('خطأ اتصال', 'error');
  }
}

async function permanentDeleteTraining(id) {
  try {  if (!confirm('تنبيه هام ⚠️: هل أنت متأكد من حذف المحاضرة نهائياً؟ لا يمكن التراجع عن هذا الإجراء!')) return;

    const res = await authFetch('/api/trainings/' + id + '/permanent', { method: 'DELETE' });
    if (res.ok) {
      showToast('تم الحذف نهائياً', 'success');
      loadAdminTraining(true);
    } else {
      const data = await res.json();
      showToast(data.error || 'فشل الحذف النهائي', 'error');
    }
  } catch (e) {
    showToast('خطأ اتصال', 'error');
  }
}

// ============================================================
// 📊 GLOBAL DASHBOARD & ANALYTICS ENGINE
// ============================================================

// ── Dashboard filter state ────────────────────────────────────
let _dashFromDate  = '';
let _dashToDate    = '';
let _dashEmpFilter = '';
let _dashDeptFilter = ''; // department name — only meaningful for super_admin/hse_admin
let _dashDeptOptions = null; // cached list of real departments (from /api/departments)
let _dashQuickDays = 30;  // default: last 30 days
let _dashCharts    = {};  // Chart.js instances keyed by canvas id

// ── Chart.js plugin: draw a total count + label in the center of a doughnut ──
// Hidden automatically while a tooltip is open over a slice, since the
// tooltip box can otherwise render on top of it and the two overlap.
const _dashCenterTextPlugin = {
  id: '_dashCenterText',
  afterDraw(chart) {
    const opts = chart.config.options.plugins && chart.config.options.plugins._dashCenterText;
    if (!opts || !opts.enabled) return;
    if (chart.tooltip && chart.tooltip.opacity > 0) return;
    const { ctx, chartArea: { left, right, top, bottom } } = chart;
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 26px Cairo, sans-serif';
    ctx.fillStyle = '#1f2937';
    ctx.fillText(opts.total.toLocaleString('en-US'), cx, cy - 10);
    ctx.font = '600 12px Cairo, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(opts.label, cx, cy + 14);
    ctx.restore();
  }
};

// Register the small custom chart plugin (center-total text) once.
let _dashPluginsRegistered = false;
function _dashRegisterChartPlugins() {
  if (_dashPluginsRegistered || typeof Chart === 'undefined') return;
  Chart.register(_dashCenterTextPlugin);
  _dashPluginsRegistered = true;
}
let _dashLastData  = null; // last analytics payload received

// Permit type Arabic labels
const PERMIT_TYPE_LABELS = {
  general:    'عام',
  height:     'ارتفاع',
  confined:   'أماكن مغلقة',
  excavation: 'حفر',
  lifting:    'رفع',
  hot:        'ساخن',
  loto:       'فصل وعزل',
  lockout:    'فصل وعزل', // alias — permits saved before the "loto" key rename
};

// Consistent color per permit type (used across charts so a type always
// gets the same color, instead of shifting when the set of types present
// changes).
const PERMIT_TYPE_COLORS = {
  general:    '#6366F1',
  height:     '#0EA5E9',
  confined:   '#8B5CF6',
  excavation: '#EC4899',
  lifting:    '#F59E0B',
  hot:        '#F97316',
  loto:       '#14B8A6',
  lockout:    '#14B8A6',
};

// ── Helper: destroy existing Chart.js instance ────────────────
function _destroyChart(id) {
  if (_dashCharts[id]) {
    try { _dashCharts[id].destroy(); } catch(e) {}
    delete _dashCharts[id];
  }
}

// ── Helper: animated counter ─────────────────────────────────
function _animateCounter(el, target, duration = 700) {
  if (!el) return;
  const start = 0;
  const step = (target / (duration / 16));
  let current = start;
  const tick = () => {
    current = Math.min(current + step, target);
    el.textContent = Math.round(current).toLocaleString('en-US');
    if (current < target) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ── Main loader ───────────────────────────────────────────────
async function loadDashboard() {
  const container = document.getElementById('dashboardContent');
  if (!container) return;

  container.innerHTML = `
    <div class="dash-loading">
      <div class="dash-loading-spinner"></div>
      <div>جارِ تحميل لوحة التحكم…</div>
    </div>`;

  try {
    // Build query params
    const params = new URLSearchParams();
    if (_dashFromDate) params.set('dateFrom', _dashFromDate);
    if (_dashToDate)   params.set('dateTo',   _dashToDate);

    // Only send the search filter if NOT a worker (backend enforces this anyway, but good for UI)
    if (_dashEmpFilter && sessionRole !== 'worker') {
        params.set('empCode', _dashEmpFilter.trim().toUpperCase());
    }
    // Department filter — only super_admin/hse_admin are allowed to voluntarily
    // narrow the company-wide dashboard down to one department (backend enforces
    // this too; dept_admin/maint_admin stay locked to their own department).
    if (_dashDeptFilter && (currentUserRole === 'super_admin' || currentUserRole === 'hse_admin')) {
        params.set('dept', _dashDeptFilter);
    }

    const fetchOptions = { headers: {} };
    if (sessionRole === 'worker' && typeof currentEmployee !== 'undefined' && currentEmployee) {
      fetchOptions.headers['X-Worker-Code'] = currentEmployee.empCode || currentEmployee.code;
    }

    const res = await authFetch('/api/analytics?' + params.toString(), fetchOptions);
    if (!res.ok) throw new Error('API error ' + res.status);
    const data = await res.json();

    const role = (data.meta && data.meta.role) || sessionRole;
    _dashLastData = data;

    // An admin/HSE user filtering the dashboard down to one employee (via the
    // "🔍 فلتر بالكود الوظيفي" box) should see that employee's OWN personal
    // dashboard — not the company-wide admin view filtered down. `viewingEmployee`
    // is only populated by the backend when an empCode filter is active.
    const isSingleEmployeeView = !!(data.meta && data.meta.viewingEmployee);

    // dept_admin (department head) now gets the exact same dashboard layout
    // as super_admin/hse_admin — same KPI cards, charts, and sections — the
    // only difference is the data itself, which the backend already scopes
    // to their own department. They only drop into the simpler personal-style
    // view when drilling into one specific employee via the search filter.
    if (role === 'worker' || isSingleEmployeeView) {
      renderPersonalDashboard(container, data, role, isSingleEmployeeView);
    } else {
      // Only super_admin/hse_admin get to pick a department to drill into —
      // fetch the real department list once (cached) before rendering the filter bar.
      if (role === 'super_admin' || role === 'hse_admin') {
        await _dashLoadDeptOptions();
      }
      renderDashboardHTML(container, data);
      // Slight delay so DOM is ready before Chart.js renders
      setTimeout(() => renderDashboardCharts(data), 80);
    }

  } catch (err) {
    console.error('Dashboard load error', err);
    container.innerHTML = `<div class="dash-empty">⚠️ تعذّر تحميل الإحصائيات. تحقق من الاتصال وأعد المحاولة.</div>`;
  }
}

// ── Apply quick date range and reload ────────────────────────
window.dashApplyQuick = function(days) {
  _dashQuickDays = days;
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - days);
  _dashFromDate = from.toISOString().slice(0, 10);
  _dashToDate   = now.toISOString().slice(0, 10);
  // Update input fields
  const fromEl = document.getElementById('dashFromDate');
  const toEl   = document.getElementById('dashToDate');
  if (fromEl) fromEl.value = _dashFromDate;
  if (toEl)   toEl.value   = _dashToDate;
  // Update active button
  document.querySelectorAll('.dash-quick-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.days) === days);
  });
  loadDashboard();
};

window.dashApplyFilters = function() {
  const fromEl = document.getElementById('dashFromDate');
  const toEl   = document.getElementById('dashToDate');
  const empEl  = document.getElementById('dashEmpFilter');
  const deptEl = document.getElementById('dashDeptFilter');
  _dashFromDate  = fromEl ? fromEl.value : '';
  _dashToDate    = toEl   ? toEl.value   : '';
  _dashEmpFilter = empEl  ? empEl.value  : '';
  _dashDeptFilter = deptEl ? deptEl.value : '';
  // Clear quick active
  document.querySelectorAll('.dash-quick-btn').forEach(b => b.classList.remove('active'));
  loadDashboard();
};

// ── Load the real department list (once) for the dashboard's "اختر القسم" filter ──
async function _dashLoadDeptOptions() {
  if (_dashDeptOptions) return _dashDeptOptions;
  try {
    const res = await authFetch('/api/departments');
    if (!res.ok) return (_dashDeptOptions = []);
    const data = await res.json();
    _dashDeptOptions = data.departments || [];
  } catch (err) {
    _dashDeptOptions = [];
  }
  return _dashDeptOptions;
}

// ── Clear the department filter and go back to the full company-wide view ──
window.dashClearDeptFilter = function() {
  _dashDeptFilter = '';
  loadDashboard();
};

window.dashRefresh = function() {
  loadDashboard();
};

// ── Clear the employee-code filter and go back to the normal admin dashboard ──
window.dashClearEmpFilter = function() {
  _dashEmpFilter = '';
  loadDashboard();
};

// ── Export the currently-loaded dashboard data to an Excel workbook ──
function _dashExportStatusText(status) {
  const map = {
    open: 'مفتوح', resolved: 'محلول', rejected: 'مرفوض',
    approved: 'موافق', pending: 'انتظار', active: 'نشطة', closed: 'مغلقة/منتهية'
  };
  return map[status] || (status || '—');
}

window.exportDashboardExcel = function() {
  if (typeof XLSX === 'undefined') {
    showToast('تعذّر تحميل مكتبة التصدير، حاول تحديث الصفحة', 'error');
    return;
  }
  const data = _dashLastData;
  if (!data) {
    showToast('لا توجد بيانات محمّلة للتصدير بعد', 'error');
    return;
  }
  const { permits, hazards, trainings, drills, meta } = data;
  const dateStr = new Date().toISOString().split('T')[0];
  const wb = XLSX.utils.book_new();

  // ── Summary sheet ──
  const roleLabel = {
    super_admin: 'مدير النظام — كل الأقسام',
    hse_admin:   'مشرف السلامة — كل الأقسام',
    dept_admin:  `مشرف قسم ${meta.scopeDept || ''}`,
    worker:      'إحصائيات شخصية',
  }[meta.role] || meta.role;
  const summaryRows = [
    { 'البند': 'نطاق التقرير', 'القيمة': roleLabel },
    { 'البند': 'من تاريخ', 'القيمة': meta.dateFrom || 'الكل' },
    { 'البند': 'إلى تاريخ', 'القيمة': meta.dateTo || 'الكل' },
    { 'البند': 'تاريخ إنشاء التقرير', 'القيمة': new Date(meta.generatedAt || Date.now()).toLocaleString('ar-EG') },
    { 'البند': '—', 'القيمة': '—' },
    { 'البند': 'إجمالي تصاريح العمل', 'القيمة': permits.total },
    { 'البند': '  ↳ موافق عليها', 'القيمة': permits.byStatus.approved },
    { 'البند': '  ↳ قيد الانتظار', 'القيمة': permits.byStatus.pending },
    { 'البند': '  ↳ مرفوضة', 'القيمة': permits.byStatus.rejected },
    { 'البند': 'إجمالي بلاغات الخطورة', 'القيمة': hazards.total },
    { 'البند': '  ↳ مفتوحة', 'القيمة': hazards.byStatus.open },
    { 'البند': '  ↳ محلولة', 'القيمة': hazards.byStatus.resolved },
    { 'البند': 'إجمالي المحاضرات التدريبية', 'القيمة': trainings.total },
    { 'البند': '  ↳ إجمالي الحضور', 'القيمة': trainings.totalAttendees },
    { 'البند': '  ↳ إجمالي الساعات', 'القيمة': trainings.totalHours },
    { 'البند': 'إجمالي تجارب الطوارئ', 'القيمة': drills.total },
    { 'البند': '  ↳ إجمالي الحضور', 'القيمة': drills.totalAttendees },
  ];
  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary['!cols'] = [{ wch: 30 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'ملخص');

  // ── Permits sheet ──
  const permitRows = (permits.list || []).map(p => ({
    'النوع': p.title, 'التاريخ': p.date ? new Date(p.date).toLocaleDateString('ar-EG') : '—',
    'الحالة': _dashExportStatusText(p.status)
  }));
  const wsPermits = XLSX.utils.json_to_sheet(permitRows.length ? permitRows : [{ 'لا توجد بيانات': '' }]);
  wsPermits['!cols'] = [{ wch: 25 }, { wch: 18 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, wsPermits, 'تصاريح العمل');

  // ── Hazards sheet ──
  const hazardRows = (hazards.list || []).map(h => ({
    'الوصف': h.title, 'التاريخ': h.date ? new Date(h.date).toLocaleDateString('ar-EG') : '—',
    'الحالة': _dashExportStatusText(h.status), 'القسم': h.department || ''
  }));
  const wsHazards = XLSX.utils.json_to_sheet(hazardRows.length ? hazardRows : [{ 'لا توجد بيانات': '' }]);
  wsHazards['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 15 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, wsHazards, 'بلاغات الخطورة');

  // ── Trainings sheet ──
  const trainingRows = (trainings.list || []).map(t => ({
    'العنوان': t.title, 'التاريخ': t.date ? new Date(t.date).toLocaleDateString('ar-EG') : '—',
    'عدد الساعات': t.hours, 'المدرب': t.trainer || ''
  }));
  const wsTrainings = XLSX.utils.json_to_sheet(trainingRows.length ? trainingRows : [{ 'لا توجد بيانات': '' }]);
  wsTrainings['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 14 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, wsTrainings, 'التدريب');

  // ── Drills sheet ──
  const drillRows = (drills.list || []).map(d => ({
    'العنوان': d.title, 'التاريخ': d.date ? new Date(d.date).toLocaleDateString('ar-EG') : '—',
    'الحالة': _dashExportStatusText(d.status), 'الموقع': d.location || ''
  }));
  const wsDrills = XLSX.utils.json_to_sheet(drillRows.length ? drillRows : [{ 'لا توجد بيانات': '' }]);
  wsDrills['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 15 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, wsDrills, 'تجارب الطوارئ');

  XLSX.writeFile(wb, `لوحة_التحكم_${dateStr}.xlsx`);
};

// ── Shared: hero header + filter bar (used by every role) ─────
// ── Executive opening snapshot ──────────────────────────────────────────────
// Three headline numbers shown INSIDE the dark hero band, above the filter
// bar and the regular KPI grid, so a CEO/exec sees the impact story first:
// how many permits are running through the system, how compliant the
// workforce is against its safety targets, and how much paper the digital
// process has replaced. Only rendered for the company/department-wide admin
// dashboard (super_admin / hse_admin / dept_admin) — not the worker's
// personal view.
function _dashExecSnapshotHTML(data) {
  const { permits, hazards, trainings, drills } = data;

  // Paper saved: every digitized permit, hazard report, drill report and
  // training attendance sheet replaces the ~2 paper sheets (form + copy)
  // that used to be filled and filed by hand for the same record.
  const PAPER_PER_RECORD = 2;
  const digitizedRecords = (permits.total || 0) + (hazards.total || 0) + (drills.total || 0) + (trainings.total || 0);
  const paperSaved = digitizedRecords * PAPER_PER_RECORD;

  return `
    <div class="dash-exec-snapshot">
      <div class="dash-exec-grid">
        <div class="dash-exec-card">
          <span class="dash-exec-icon">📝</span>
          <div class="dash-exec-value">${(permits.total || 0).toLocaleString('en-US')}</div>
          <div class="dash-exec-label">إجمالي تصاريح العمل</div>
        </div>
        <div class="dash-exec-card">
          <span class="dash-exec-icon">🎯</span>
          <div class="dash-exec-value" id="execCompliancePct">…</div>
          <div class="dash-exec-label">نسبة الالتزام بأهداف السلامة</div>
          <div class="dash-exec-sub" id="execComplianceSub"></div>
        </div>
        <div class="dash-exec-card">
          <span class="dash-exec-icon">🌱</span>
          <div class="dash-exec-value">${paperSaved.toLocaleString('en-US')}</div>
          <div class="dash-exec-label">ورقة تم توفيرها</div>
          <div class="dash-exec-sub">≈ ${PAPER_PER_RECORD} ورقة لكل تصريح / بلاغ / تجربة / محاضرة تم رقمنتها بدل الفورم الورقي</div>
        </div>
      </div>
    </div>`;
}

function _dashHeroAndFilters(meta, opts) {
  opts = opts || {};
  const roleLabel = meta.viewingEmployee
    ? `عرض بيانات موظف واحد: ${meta.viewingEmployee.name || meta.viewingEmployee.empCode || ''}`
    : ({
        super_admin: _dashDeptFilter ? `مدير النظام — قسم ${_dashDeptFilter}` : 'مدير النظام — كل الأقسام',
        hse_admin:   _dashDeptFilter ? `مشرف السلامة — قسم ${_dashDeptFilter}` : 'مشرف السلامة — كل الأقسام',
        dept_admin:  `مشرف قسم ${meta.scopeDept || ''} — بيانات القسم`,
        worker:      'إحصائياتك الشخصية',
      }[meta.role] || 'لوحة التحكم');

  const now = new Date().toLocaleDateString('ar-EG-u-nu-latn', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const quickBtns = [
    { label: 'آخر 7 أيام',  days: 7  },
    { label: 'آخر 30 يوم',  days: 30 },
    { label: 'آخر 3 أشهر',  days: 90 },
    { label: 'آخر 6 أشهر',  days: 180 },
    { label: 'آخر سنة',     days: 365 },
  ].map(b => `<button class="dash-quick-btn${_dashQuickDays === b.days ? ' active' : ''}" data-days="${b.days}" onclick="dashApplyQuick(${b.days})">${b.label}</button>`).join('');

  const showEmpFilter = opts.showEmpFilter !== false;
  // Department drill-down select — only super_admin/hse_admin can voluntarily
  // narrow the company-wide dashboard to one department (dept_admin/maint_admin
  // are already locked server-side to their own department, so no point showing it).
  const showDeptFilter = (meta.role === 'super_admin' || meta.role === 'hse_admin');
  const deptOptionsHtml = (_dashDeptOptions || []).map(d =>
    `<option value="${escapeHtml(d)}" ${_dashDeptFilter === d ? 'selected' : ''}>${escapeHtml(d)}</option>`
  ).join('');

  return `
    <div class="dash-hero">
      <div class="dash-hero-row">
        <div>
          <h1 class="dash-hero-title">📊 لوحة التحكم والإحصائيات</h1>
          <p class="dash-hero-sub">${escapeHtml(roleLabel)} &nbsp;·&nbsp; ${now}</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span class="dash-hero-badge">HSE Platform · Elsewedy Polymers</span>
          ${meta.role !== 'worker' ? `<button class="dash-refresh-btn" onclick="exportDashboardExcel()">📥 تصدير Excel</button>` : ''}
          <button class="dash-refresh-btn" onclick="dashRefresh()">🔄 تحديث</button>
        </div>
      </div>
      ${opts.execSnapshot || ''}
    </div>

    <div class="dash-filter-bar">
      <span class="dash-filter-label">الفترة الزمنية:</span>
      ${quickBtns}
      <div class="dash-filter-divider"></div>
      <input type="date" id="dashFromDate" class="dash-date-input" value="${_dashFromDate}" placeholder="من">
      <input type="date" id="dashToDate"   class="dash-date-input" value="${_dashToDate}"   placeholder="إلى">
      ${showEmpFilter ? `
      <div class="dash-filter-divider"></div>
      <input type="text" id="dashEmpFilter" class="dash-emp-input" placeholder="🔍 فلتر بالكود الوظيفي..." value="${_dashEmpFilter}" style="direction:ltr;">
      ` : ''}
      ${showDeptFilter ? `
      <div class="dash-filter-divider"></div>
      <select id="dashDeptFilter" class="dash-emp-input">
        <option value="">-- كل الأقسام --</option>
        ${deptOptionsHtml}
      </select>
      ${_dashDeptFilter ? `<button class="dash-refresh-btn" onclick="dashClearDeptFilter()" title="عرض كل الأقسام">✖ إلغاء فلتر القسم</button>` : ''}
      ` : ''}
      <button class="dash-apply-btn" onclick="dashApplyFilters()">تطبيق الفلتر</button>
    </div>
  `;
}

// ── Small helper: status badge pill ────────────────────────────
function _dashStatusPill(status) {
  const map = {
    open:      { cls: 'red',    label: '🔴 مفتوح' },
    resolved:  { cls: 'green',  label: '🟢 مغلق' },
    rejected:  { cls: 'red',    label: '⛔ مرفوض' },
    approved:  { cls: 'green',  label: '✔ موافق' },
    pending:   { cls: 'yellow', label: '⏳ انتظار' },
    active:    { cls: 'yellow', label: '🟡 نشطة' },
    closed:    { cls: 'green',  label: '🟢 منتهية' },
  };
  const s = map[status] || { cls: 'blue', label: status || '—' };
  return `<span class="dash-kpi-pill ${s.cls}">${s.label}</span>`;
}

function _dashFmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('ar-EG-u-nu-latn', { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch (e) { return '—'; }
}

// ── List card (reused for trainings / hazards / drills / permits) ──
function _dashListCard(opts) {
  const { icon, title, items, emptyMsg, renderRow } = opts;
  return `
    <div class="dash-chart-card">
      <div class="dash-chart-title">${icon} <span>${title}</span></div>
      <div class="dash-list-card-body">
        ${(!items || items.length === 0)
          ? `<div class="dash-empty">${emptyMsg || 'لا توجد بيانات في هذه الفترة'}</div>`
          : items.slice(0, 12).map(renderRow).join('')}
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════
// PERSONAL / DEPARTMENT DASHBOARD — worker & dept_admin
// ══════════════════════════════════════════════════════════════
function renderPersonalDashboard(container, data, role, isSingleEmployeeView) {
  const { permits, hazards, trainings, drills, penalties, meta } = data;
  const viewingEmp = meta && meta.viewingEmployee;
  // An admin/HSE/dept_admin user who drilled down via the employee-code filter
  // is looking at someone ELSE's data — use neutral third-person labels and a
  // "الموظف" banner instead of "-ك" (you) labels, which only make sense when
  // workers view their own dashboard.
  const isAdminViewingOne = !!isSingleEmployeeView && role !== 'worker';
  const isDept = role === 'dept_admin' && !isAdminViewingOne;

  const trainLabel   = isDept ? 'محاضرات القسم' : isAdminViewingOne ? 'محاضرات الموظف التدريبية' : 'محاضراتك التدريبية';
  const hoursLabel   = isDept ? 'إجمالي ساعات التدريب (القسم)' : isAdminViewingOne ? 'إجمالي ساعات تدريب الموظف' : 'إجمالي ساعات تدريبك';
  const hazLabel     = isDept ? 'بلاغات خطورة القسم' : isAdminViewingOne ? 'بلاغات الموظف عن مخاطر' : 'بلاغاتك عن مخاطر';
  const drillLabel   = isDept ? 'تجارب طوارئ القسم' : isAdminViewingOne ? 'تجارب الطوارئ التي حضرها الموظف' : 'تجارب الطوارئ التي حضرتها';
  const permitLabel  = isDept ? 'تصاريح عمل القسم' : isAdminViewingOne ? 'تصاريح عمل الموظف' : 'تصاريح عملك';
  const penaltyLabel = isDept ? 'جزاءات القسم' : isAdminViewingOne ? 'الجزاءات على الموظف' : 'الجزاءات عليك';

  // Identity banner — shown only when an admin/HSE/dept_admin drilled into one
  // employee, so it's clear whose data is on screen and gives a one-click way
  // back to the full dashboard.
  const employeeBanner = isAdminViewingOne ? `
    <div class="dash-emp-banner" style="max-width:1200px;margin:0 auto;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;background:var(--paper,#fff);border:1px solid var(--paper-line,#e2e8f0);border-radius:12px;margin-top:16px;">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <span style="font-size:26px;">👤</span>
        <div>
          <div style="font-weight:800;font-size:15px;">${escapeHtml(viewingEmp && viewingEmp.name || 'موظف غير معروف')}</div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:2px;">
            ${viewingEmp && viewingEmp.jobTitle ? `${escapeHtml(viewingEmp.jobTitle)} · ` : ''}${viewingEmp && viewingEmp.department ? `${escapeHtml(viewingEmp.department)} · ` : ''}كود: ${escapeHtml(viewingEmp && viewingEmp.empCode || '')}
          </div>
        </div>
      </div>
      <button class="dash-refresh-btn" onclick="dashClearEmpFilter()">⬅ رجوع للوحة التحكم العامة</button>
    </div>
  ` : '';

  // 🎯 Personal target progress (worker only) — remaining hours/reports to hit the fixed annual target
  const trainHoursSoFar = trainings.totalHours || 0;
  const hazSoFar         = hazards.total || 0;
  const trainPct = Math.min(100, Math.round((trainHoursSoFar / EMP_TARGET_TRAIN_HOURS) * 100));
  const hazPct   = Math.min(100, Math.round((hazSoFar / EMP_TARGET_HAZARDS) * 100));
  const trainRemaining = Math.max(0, EMP_TARGET_TRAIN_HOURS - trainHoursSoFar);
  const hazRemaining   = Math.max(0, EMP_TARGET_HAZARDS - hazSoFar);

  const myTargetSection = (!isDept) ? `
      <div class="dash-section-title">🎯 تارجتك (تدريب ${EMP_TARGET_TRAIN_HOURS} ساعات / ${EMP_TARGET_HAZARDS} بلاغ خطورة)</div>
      <div class="dash-chart-grid">
        <div class="dash-chart-card">
          <div class="dash-chart-title">🎓 <span>ساعات التدريب</span></div>
          <div style="padding:12px 4px;">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px;">
              <span>${trainHoursSoFar.toLocaleString('en-US')} من ${EMP_TARGET_TRAIN_HOURS} ساعة</span>
              <span style="font-weight:700;">${trainPct}%</span>
            </div>
            <div style="background:var(--paper-line);height:10px;border-radius:5px;overflow:hidden;">
              <div style="height:100%;width:${trainPct}%;background:${trainPct >= 100 ? '#16A34A' : '#4f46e5'};"></div>
            </div>
            <div style="margin-top:8px;font-size:12px;color:var(--muted);">
              ${trainRemaining > 0 ? `متبقّي <b>${trainRemaining}</b> ساعة تدريب علشان توصل للتارجت` : '🎉 وصلت لتارجت التدريب!'}
            </div>
          </div>
        </div>
        <div class="dash-chart-card">
          <div class="dash-chart-title">⚠️ <span>بلاغات الخطورة</span></div>
          <div style="padding:12px 4px;">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px;">
              <span>${hazSoFar} من ${EMP_TARGET_HAZARDS} بلاغ</span>
              <span style="font-weight:700;">${hazPct}%</span>
            </div>
            <div style="background:var(--paper-line);height:10px;border-radius:5px;overflow:hidden;">
              <div style="height:100%;width:${hazPct}%;background:${hazPct >= 100 ? '#16A34A' : '#D97706'};"></div>
            </div>
            <div style="margin-top:8px;font-size:12px;color:var(--muted);">
              ${hazRemaining > 0 ? `متبقّي <b>${hazRemaining}</b> بلاغ خطورة علشان توصل للتارجت` : '🎉 وصلت لتارجت البلاغات!'}
            </div>
          </div>
        </div>
      </div>
  ` : '';

  container.innerHTML = `
    ${_dashHeroAndFilters(meta, { showEmpFilter: isDept || isAdminViewingOne })}
    ${employeeBanner}

    <div id="dashboardContent" style="max-width:1200px;margin:0 auto;padding:0 16px;">

      <!-- KPI summary row -->
      <div class="dash-kpi-grid">
        <div class="dash-kpi-card accent-4">
          <span class="dash-kpi-icon">🎓</span>
          <div class="dash-kpi-value" id="kpiTrainingTotal">0</div>
          <div class="dash-kpi-label">${trainLabel}</div>
          <div class="dash-kpi-sub">
            <span class="dash-kpi-pill blue">⏱ ${(trainings.totalHours || 0).toLocaleString('en-US')} ساعة</span>
          </div>
        </div>
        <div class="dash-kpi-card accent-5">
          <span class="dash-kpi-icon">⚠️</span>
          <div class="dash-kpi-value" id="kpiHazardTotal">0</div>
          <div class="dash-kpi-label">${hazLabel}</div>
          <div class="dash-kpi-sub">
            <span class="dash-kpi-pill red">مفتوح: ${hazards.byStatus.open}</span>
            <span class="dash-kpi-pill green">مغلق: ${hazards.byStatus.resolved}</span>
          </div>
        </div>
        <div class="dash-kpi-card accent-3">
          <span class="dash-kpi-icon">🚨</span>
          <div class="dash-kpi-value" id="kpiDrillTotal">0</div>
          <div class="dash-kpi-label">${drillLabel}</div>
          <div class="dash-kpi-sub">
            <span class="dash-kpi-pill green">مغلقة: ${drills.closed}</span>
            <span class="dash-kpi-pill yellow">نشطة: ${drills.active}</span>
          </div>
        </div>
        <div class="dash-kpi-card accent-1">
          <span class="dash-kpi-icon">📝</span>
          <div class="dash-kpi-value" id="kpiPermitTotal">0</div>
          <div class="dash-kpi-label">${permitLabel}</div>
          <div class="dash-kpi-sub">
            <span class="dash-kpi-pill green">موافق: ${permits.byStatus.approved}</span>
            <span class="dash-kpi-pill yellow">انتظار: ${permits.byStatus.pending}</span>
          </div>
        </div>
        <div class="dash-kpi-card accent-2">
          <span class="dash-kpi-icon">⚖️</span>
          <div class="dash-kpi-value" id="kpiPenaltyTotal">0</div>
          <div class="dash-kpi-label">${penaltyLabel}</div>
          <div class="dash-kpi-sub">
            <span class="dash-kpi-pill ${penalties.total > 0 ? 'red' : 'green'}">${penalties.total > 0 ? penalties.total + ' جزاء' : 'لا يوجد'}</span>
          </div>
        </div>
      </div>

      ${myTargetSection}

      ${isDept ? `
      <!-- Department-wide target compliance -->
      <div class="dash-section-title">🎯 نسبة التزام القسم بالأهداف — ${_dashGetCurrentQuarterInfo().label} (تدريب ${EMP_TARGET_TRAIN_HOURS}س سنويًا / ${EMP_TARGET_HAZARDS} بلاغ خطورة سنويًا لكل موظف)</div>
      <div class="dash-kpi-grid">
        <div class="dash-kpi-card accent-3">
          <span class="dash-kpi-icon">🎓</span>
          <div class="dash-kpi-value" id="kpiDeptTrainAchievedPct">…</div>
          <div class="dash-kpi-label">حققوا تارجت التدريب للربع الحالي</div>
          <div class="dash-kpi-sub" id="kpiDeptTrainAchievedSub"></div>
        </div>
        <div class="dash-kpi-card accent-5">
          <span class="dash-kpi-icon">⚠️</span>
          <div class="dash-kpi-value" id="kpiDeptHazardTargetPct">…</div>
          <div class="dash-kpi-label">حققوا تارجت بلاغات الخطورة (${EMP_TARGET_HAZARDS} بلاغ)</div>
          <div class="dash-kpi-sub" id="kpiDeptHazardTargetSub"></div>
        </div>
      </div>
      ` : ''}

      <!-- Status donuts -->
      <div class="dash-section-title">📈 نظرة عامة على الحالة</div>
      <div class="dash-chart-grid">
        <div class="dash-chart-card">
          <div class="dash-chart-title">⚠️ <span>بلاغات الخطورة — الحالة</span></div>
          <div class="dash-chart-wrap">${hazards.total === 0 ? '<div class="dash-empty">لا توجد بلاغات في هذه الفترة</div>' : '<canvas id="chartPersonalHazard"></canvas>'}</div>
        </div>
        <div class="dash-chart-card">
          <div class="dash-chart-title">📝 <span>تصاريح العمل — الحالة</span></div>
          <div class="dash-chart-wrap">${permits.total === 0 ? '<div class="dash-empty">لا توجد تصاريح في هذه الفترة</div>' : '<canvas id="chartPersonalPermit"></canvas>'}</div>
        </div>
        <div class="dash-chart-card">
          <div class="dash-chart-title">🚨 <span>تجارب الطوارئ — الحالة</span></div>
          <div class="dash-chart-wrap">${drills.total === 0 ? '<div class="dash-empty">لا توجد تجارب طوارئ في هذه الفترة</div>' : '<canvas id="chartPersonalDrill"></canvas>'}</div>
        </div>
      </div>

      <!-- Detail lists -->
      <div class="dash-section-title">🗂️ التفاصيل</div>
      <div class="dash-chart-grid">
        ${_dashListCard({
          icon: '🎓', title: `${trainLabel} — الأسماء والمواعيد`,
          items: trainings.list, emptyMsg: 'لا توجد محاضرات مسجلة في هذه الفترة',
          renderRow: t => `
            <div class="dash-list-row">
              <div class="dash-list-main">
                <div class="dash-list-title">${escapeHtml(t.title)}</div>
                <div class="dash-list-meta">${_dashFmtDate(t.date)}${t.trainer ? ' · ' + escapeHtml(t.trainer) : ''}</div>
              </div>
              <span class="dash-kpi-pill blue">${t.hours} س</span>
            </div>`
        })}

        ${_dashListCard({
          icon: '⚠️', title: `${hazLabel} — الأسماء والحالة`,
          items: hazards.list, emptyMsg: 'لا توجد بلاغات مسجلة في هذه الفترة',
          renderRow: h => `
            <div class="dash-list-row">
              <div class="dash-list-main">
                <div class="dash-list-title" title="${escapeHtml(h.title)}">${escapeHtml(h.title)}</div>
                <div class="dash-list-meta">${_dashFmtDate(h.date)}</div>
              </div>
              ${_dashStatusPill(h.status)}
            </div>`
        })}

        ${_dashListCard({
          icon: '🚨', title: `${drillLabel} — الأسماء والحالة`,
          items: drills.list, emptyMsg: 'لا توجد تجارب طوارئ مسجلة في هذه الفترة',
          renderRow: d => `
            <div class="dash-list-row">
              <div class="dash-list-main">
                <div class="dash-list-title">${escapeHtml(d.title)}</div>
                <div class="dash-list-meta">${_dashFmtDate(d.date)}${d.location ? ' · ' + escapeHtml(d.location) : ''}</div>
              </div>
              ${_dashStatusPill(d.status)}
            </div>`
        })}

        ${_dashListCard({
          icon: '📝', title: `${permitLabel} — الأنواع والحالة`,
          items: permits.list, emptyMsg: 'لا توجد تصاريح عمل مسجلة في هذه الفترة',
          renderRow: p => `
            <div class="dash-list-row">
              <div class="dash-list-main">
                <div class="dash-list-title">${escapeHtml(p.title)}</div>
                <div class="dash-list-meta">${_dashFmtDate(p.date)}</div>
              </div>
              ${_dashStatusPill(p.status)}
            </div>`
        })}

        ${_dashListCard({
          icon: '⚖️', title: `${penaltyLabel} — الأسباب والتواريخ`,
          items: penalties.list, emptyMsg: 'لا توجد جزاءات مسجلة في هذه الفترة',
          renderRow: p => `
            <div class="dash-list-row">
              <div class="dash-list-main">
                <div class="dash-list-title" title="${escapeHtml(p.title)}">${isDept && p.empName ? `${escapeHtml(p.empName)} — ` : ''}${escapeHtml(p.title)}</div>
                <div class="dash-list-meta">${_dashFmtDate(p.date)}${p.issuedBy ? ' · ' + escapeHtml(p.issuedBy) : ''}</div>
              </div>
            </div>`
        })}
      </div>

    </div>
  `;

  _animateCounter(document.getElementById('kpiTrainingTotal'), trainings.total);
  _animateCounter(document.getElementById('kpiHazardTotal'),   hazards.total);
  _animateCounter(document.getElementById('kpiDrillTotal'),    drills.total);
  _animateCounter(document.getElementById('kpiPermitTotal'),   permits.total);
  _animateCounter(document.getElementById('kpiPenaltyTotal'),  penalties.total);

  setTimeout(() => renderPersonalCharts(data), 80);

  if (isDept) {
    _dashLoadTargetCompliance(meta.scopeDept, {
      pctTrainAchievedId: 'kpiDeptTrainAchievedPct', subTrainAchievedId: 'kpiDeptTrainAchievedSub',
      pctHazAchievedId:   'kpiDeptHazardTargetPct',  subHazAchievedId:   'kpiDeptHazardTargetSub'
    });
  }
}

function renderPersonalCharts(data) {
  const { permits, hazards, drills } = data;
  Chart.defaults.font.family = 'Cairo, sans-serif';
  Chart.defaults.font.size   = 12;

  _destroyChart('chartPersonalHazard');
  const ctxH = document.getElementById('chartPersonalHazard');
  if (ctxH) {
    _dashCharts['chartPersonalHazard'] = new Chart(ctxH, {
      type: 'doughnut',
      data: {
        labels: ['مفتوح', 'مغلق', 'مرفوض'],
        datasets: [{ data: [hazards.byStatus.open, hazards.byStatus.resolved, hazards.byStatus.rejected],
          backgroundColor: ['#DC2626','#16A34A','#94a3b8'], borderWidth: 2, borderColor: '#fff' }]
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: '65%',
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 14 } } } }
    });
  }

  _destroyChart('chartPersonalPermit');
  const ctxP = document.getElementById('chartPersonalPermit');
  if (ctxP) {
    _dashCharts['chartPersonalPermit'] = new Chart(ctxP, {
      type: 'doughnut',
      data: {
        labels: ['موافق', 'انتظار', 'مرفوض'],
        datasets: [{ data: [permits.byStatus.approved, permits.byStatus.pending, permits.byStatus.rejected],
          backgroundColor: ['#16A34A','#D97706','#DC2626'], borderWidth: 2, borderColor: '#fff' }]
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: '65%',
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 14 } } } }
    });
  }

  _destroyChart('chartPersonalDrill');
  const ctxD = document.getElementById('chartPersonalDrill');
  if (ctxD) {
    _dashCharts['chartPersonalDrill'] = new Chart(ctxD, {
      type: 'pie',
      data: {
        labels: ['نشط', 'مغلق'],
        datasets: [{ data: [drills.active, drills.closed], backgroundColor: ['#D97706','#16A34A'], borderWidth: 2, borderColor: '#fff' }]
      },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 14 } } } }
    });
  }
}

// ══════════════════════════════════════════════════════════════
// ⚖️ PENALTIES (الجزاءات)
// ══════════════════════════════════════════════════════════════
let penaltyToDelete = '';
let penaltiesAdminCache = [];

// ── Worker: my own penalties ──────────────────────────────────
async function renderMyPenalties() {
  const listEl = document.getElementById('myPenaltiesList');
  if (!listEl) return;
  if (!currentEmployee) {
    listEl.innerHTML = `<div class="empty"><div class="icon">🔒</div>سجّل دخولك أولاً لعرض الجزاءات</div>`;
    return;
  }
  listEl.innerHTML = '<div class="loading">جارِ تحميل الجزاءات…</div>';

  try {
    const code = encodeURIComponent(currentEmployee.empCode || currentEmployee.code || '');
    const res = await fetch(`/api/my-penalties/${code}`);
    if (!res.ok) throw new Error('Failed to fetch');
    const data = await res.json();
    const penalties = data.penalties || [];

    if (penalties.length === 0) {
      listEl.innerHTML = `<div class="empty"><div class="icon">✅</div>لا يوجد أي جزاءات مسجلة عليك</div>`;
      return;
    }

    listEl.innerHTML = penalties.map(p => `
      <div class="sup-card" style="margin-bottom:12px;border-right:4px solid var(--danger);">
        <div class="sup-top">
          <div><div class="hz-status-badge hz-high">⚖️ جزاء</div></div>
          <div class="tnum">${escapeHtml(p.date || '')}</div>
        </div>
        <div style="margin:10px 0;font-size:14px;line-height:1.6;">${escapeHtml(p.reason || '')}</div>
        <div class="meta-grid">
          <div><span>مشرف السيفتي</span>${escapeHtml(p.issuedBy || '—')}</div>
        </div>
      </div>
    `).join('');
  } catch (e) {
    console.error(e);
    listEl.innerHTML = `<div class="empty"><div class="icon">⚠️</div>تعذّر تحميل الجزاءات، حاول مجدداً</div>`;
  }
}

// ── Admin: manage penalties ───────────────────────────────────
function _canManagePenalties() {
  return currentUserRole === 'super_admin' || currentUserRole === 'hse_admin';
}

async function renderPenaltiesAdmin() {
  const listEl = document.getElementById('penaltiesAdminList');
  const btnsEl = document.getElementById('penaltiesAdminButtons');
  const noticeEl = document.getElementById('penaltiesReadOnlyNotice');
  if (!listEl) return;

  const canManage = _canManagePenalties();
  if (btnsEl) btnsEl.style.display = canManage ? 'flex' : 'none';
  if (noticeEl) noticeEl.style.display = canManage ? 'none' : 'block';

  listEl.innerHTML = '<div class="loading">جارِ تحميل الجزاءات…</div>';

  try {
    const res = await authFetch('/api/penalties');
    if (!res.ok) throw new Error('Failed to fetch');
    const data = await res.json();
    penaltiesAdminCache = (data.penalties || []).filter(p => p.status !== 'deleted');

    if (penaltiesAdminCache.length === 0) {
      listEl.innerHTML = `<div class="empty"><div class="icon">✅</div>لا توجد أي جزاءات مسجلة حالياً</div>`;
      return;
    }

    listEl.innerHTML = penaltiesAdminCache.map(p => `
      <div class="sup-card penalty-card" style="margin-bottom:12px;border-right:4px solid var(--danger);">
        <div class="sup-top">
          <div>
            <div class="hz-status-badge hz-high">⚖️ ${escapeHtml(p.empName || p.empCode || '')}</div>
          </div>
          <div class="tnum">${escapeHtml(p.date || '')}</div>
        </div>
        <div class="meta-grid">
          <div><span>الكود الوظيفي</span>${escapeHtml(p.empCode || '')}</div>
          <div><span>الوظيفة</span>${escapeHtml(p.jobTitle || '—')}</div>
          <div><span>القسم</span>${escapeHtml(p.department || '—')}</div>
          <div><span>مشرف السيفتي</span>${escapeHtml(p.issuedBy || '—')}</div>
        </div>
        <div style="margin:10px 0;font-size:14px;line-height:1.6;">${escapeHtml(p.reason || '')}</div>
        ${canManage ? `
        <div style="display:flex;gap:8px;">
          <button class="logout-btn" style="flex:1;color:var(--danger);border-color:var(--danger);" onclick="openDeletePenaltyModal('${p.id}')">🗑️ حذف الجزاء</button>
        </div>` : ''}
      </div>
    `).join('');
  } catch (e) {
    console.error(e);
    listEl.innerHTML = `<div class="empty"><div class="icon">⚠️</div>تعذّر تحميل الجزاءات، حاول مجدداً</div>`;
  }
}

// ── Add penalty modal ─────────────────────────────────────────
function openAddPenaltyModal() {
  if (!_canManagePenalties()) { showToast('لا تملك صلاحية إضافة جزاء', 'error'); return; }
  document.getElementById('pen_empCode').value = '';
  document.getElementById('pen_date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('pen_reason').value = '';
  document.getElementById('pen_issuedBy').value = (currentEmployee && currentEmployee.name) || '';
  const msg = document.getElementById('addPenaltyMsg');
  if (msg) msg.className = 'um-msg';
  document.getElementById('addPenaltyModal').style.display = 'flex';
}
function closeAddPenaltyModal() {
  document.getElementById('addPenaltyModal').style.display = 'none';
}
async function submitAddPenalty() {
  const empCode = document.getElementById('pen_empCode').value.trim();
  const date = document.getElementById('pen_date').value;
  const reason = document.getElementById('pen_reason').value.trim();
  const issuedBy = document.getElementById('pen_issuedBy').value.trim();
  const msgEl = document.getElementById('addPenaltyMsg');
  msgEl.className = 'um-msg';

  if (!empCode || !reason) {
    msgEl.textContent = 'من فضلك أدخل الكود الوظيفي وسبب الجزاء';
    msgEl.className = 'um-msg error show';
    return;
  }

  try {
    const res = await authFetch('/api/penalties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empCode, date, reason, issuedBy })
    });
    const data = await res.json();
    if (res.ok) {
      msgEl.textContent = '✅ تم إضافة الجزاء بنجاح';
      msgEl.className = 'um-msg success show';
      setTimeout(() => {
        closeAddPenaltyModal();
        renderPenaltiesAdmin();
      }, 800);
    } else {
      msgEl.textContent = data.error || 'فشل إضافة الجزاء';
      msgEl.className = 'um-msg error show';
    }
  } catch (e) {
    msgEl.textContent = 'خطأ في الاتصال بالسيرفر';
    msgEl.className = 'um-msg error show';
  }
}

// ── Delete penalty modal ──────────────────────────────────────
function openDeletePenaltyModal(id) {
  if (!_canManagePenalties()) { showToast('لا تملك صلاحية حذف الجزاء', 'error'); return; }
  penaltyToDelete = id;
  document.getElementById('deletePenaltyReason').value = '';
  const msg = document.getElementById('deletePenaltyMsg');
  if (msg) msg.className = 'um-msg';
  document.getElementById('deletePenaltyModal').style.display = 'flex';
}
function closeDeletePenaltyModal() {
  document.getElementById('deletePenaltyModal').style.display = 'none';
  penaltyToDelete = '';
}
async function confirmDeletePenalty() {
  const reason = document.getElementById('deletePenaltyReason').value.trim();
  const msgEl = document.getElementById('deletePenaltyMsg');
  msgEl.className = 'um-msg';

  if (!reason) {
    msgEl.textContent = 'من فضلك أدخل سبب الحذف';
    msgEl.className = 'um-msg error show';
    return;
  }

  try {
    const res = await authFetch(`/api/penalties/${encodeURIComponent(penaltyToDelete)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    const data = await res.json();
    if (res.ok) {
      msgEl.textContent = '✅ تم حذف الجزاء';
      msgEl.className = 'um-msg success show';
      setTimeout(() => {
        closeDeletePenaltyModal();
        renderPenaltiesAdmin();
      }, 800);
    } else {
      msgEl.textContent = data.error || 'فشل حذف الجزاء';
      msgEl.className = 'um-msg error show';
    }
  } catch (e) {
    msgEl.textContent = 'خطأ في الاتصال بالسيرفر';
    msgEl.className = 'um-msg error show';
  }
}

// ── Import old penalties sheet (.xlsx) ────────────────────────
async function uploadPenaltiesExcel(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const dataUrl = e.target.result;
    const base64Data = dataUrl.split(',')[1];

    showToast('جاري رفع الشيت واستيراد الجزاءات...', 'info');

    try {
      const res = await authFetch('/api/penalties/upload-excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64Data })
      });
      const json = await res.json();
      if (json.success) {
        showToast(`تم استيراد ${json.count} جزاء بنجاح!` + (json.skipped ? ` (تم تخطي ${json.skipped} صف بدون سبب)` : ''), 'success');
        renderPenaltiesAdmin();
      } else {
        showToast(json.message || 'حدث خطأ أثناء الرفع', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('خطأ في الاتصال بالخادم', 'error');
    }

    event.target.value = '';
  };
  reader.readAsDataURL(file);
}

// ── Export current penalties list to Excel (client-side, like exportHazardsExcel) ──
window.exportPenaltiesExcel = function () {
  const rows = penaltiesAdminCache.map(p => ({
    'الكود': String(p.empCode || ''),
    'الاسم': p.empName || '',
    'القسم': p.department || '',
    'الوظيفة': p.jobTitle || '',
    'التاريخ': p.date || '',
    'سبب الجزاء': p.reason || '',
    'مشرف السيفتي': p.issuedBy || ''
  }));

  if (rows.length === 0) {
    showToast('لا توجد جزاءات للتصدير', 'error');
    return;
  }

  try {
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 12 }, { wch: 28 }, { wch: 18 }, { wch: 22 }, { wch: 14 }, { wch: 45 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'الجزاءات');
    XLSX.writeFile(wb, `الجزاءات_${new Date().toISOString().split('T')[0]}.xlsx`);
  } catch (e) {
    console.error(e);
    showToast('تعذّر تصدير الملف', 'error');
  }
};

// ══════════════════════════════════════════════════════════════
// COMPANY-WIDE DASHBOARD — super_admin & hse_admin
// ══════════════════════════════════════════════════════════════
function renderDashboardHTML(container, data) {
  const { permits, hazards, trainings, drills, penalties, meta } = data;

  container.innerHTML = `
    ${_dashHeroAndFilters(meta, { showEmpFilter: true, execSnapshot: _dashExecSnapshotHTML(data) })}

    <!-- Content Wrapper -->
    <div id="dashboardContent" style="max-width:1200px;margin:0 auto;padding:0 16px;">

      <!-- KPI Cards -->
      <div class="dash-kpi-grid">
        <div class="dash-kpi-card accent-1">
          <span class="dash-kpi-icon">📝</span>
          <div class="dash-kpi-value" id="kpiPermitTotal">0</div>
          <div class="dash-kpi-label">تصاريح العمل</div>
          <div class="dash-kpi-sub">
            <span class="dash-kpi-pill green">✔ موافق: ${permits.byStatus.approved}</span>
            <span class="dash-kpi-pill yellow">⏳ انتظار: ${permits.byStatus.pending}</span>
            <span class="dash-kpi-pill red">✖ مرفوض: ${permits.byStatus.rejected}</span>
          </div>
        </div>
        <div class="dash-kpi-card accent-5">
          <span class="dash-kpi-icon">⚠️</span>
          <div class="dash-kpi-value" id="kpiHazardTotal">0</div>
          <div class="dash-kpi-label">بلاغات الخطورة</div>
          <div class="dash-kpi-sub">
            <span class="dash-kpi-pill red">مفتوح: ${hazards.byStatus.open}</span>
            <span class="dash-kpi-pill green">محلول: ${hazards.byStatus.resolved}</span>
          </div>
        </div>
        <div class="dash-kpi-card accent-4">
          <span class="dash-kpi-icon">🎓</span>
          <div class="dash-kpi-value" id="kpiTrainingTotal">0</div>
          <div class="dash-kpi-label">المحاضرات التدريبية</div>
          <div class="dash-kpi-sub">
            <span class="dash-kpi-pill blue">حضور: ${trainings.totalAttendees}</span>
            <span class="dash-kpi-pill blue">⏱ ${(trainings.totalHours || 0).toLocaleString('en-US')} ساعة</span>
          </div>
        </div>
        <div class="dash-kpi-card accent-3">
          <span class="dash-kpi-icon">🚨</span>
          <div class="dash-kpi-value" id="kpiDrillTotal">0</div>
          <div class="dash-kpi-label">تجارب الطوارئ</div>
          <div class="dash-kpi-sub">
            <span class="dash-kpi-pill blue">إجمالي الحضور: ${drills.totalAttendees}</span>
            <span class="dash-kpi-pill green">مغلقة: ${drills.closed}</span>
          </div>
        </div>
        <div class="dash-kpi-card accent-2">
          <span class="dash-kpi-icon">⚖️</span>
          <div class="dash-kpi-value" id="kpiPenaltyTotal">0</div>
          <div class="dash-kpi-label">الجزاءات</div>
          <div class="dash-kpi-sub">
            <span class="dash-kpi-pill ${penalties.total > 0 ? 'red' : 'green'}">${penalties.total} جزاء</span>
          </div>
        </div>
      </div>

      <!-- Company-wide target compliance -->
      <div class="dash-section-title">🎯 نسبة الالتزام بالأهداف — ${_dashGetCurrentQuarterInfo().label} (تدريب ${EMP_TARGET_TRAIN_HOURS}س سنويًا / ${EMP_TARGET_HAZARDS} بلاغ خطورة سنويًا لكل موظف)</div>
      <div class="dash-kpi-grid">
        <div class="dash-kpi-card accent-3">
          <span class="dash-kpi-icon">🎓</span>
          <div class="dash-kpi-value" id="kpiTrainAchievedPct">…</div>
          <div class="dash-kpi-label">حققوا تارجت التدريب للربع الحالي</div>
          <div class="dash-kpi-sub" id="kpiTrainAchievedSub"></div>
        </div>
        <div class="dash-kpi-card accent-5">
          <span class="dash-kpi-icon">⚠️</span>
          <div class="dash-kpi-value" id="kpiHazardTargetPct">…</div>
          <div class="dash-kpi-label">حققوا تارجت بلاغات الخطورة (${EMP_TARGET_HAZARDS} بلاغ)</div>
          <div class="dash-kpi-sub" id="kpiHazardTargetSub"></div>
        </div>
      </div>

      <!-- Charts Row 1: Status pies -->
      <div class="dash-section-title">📈 توزيع الإحصائيات</div>
      <div class="dash-chart-grid">
        <div class="dash-chart-card">
          <div class="dash-chart-title">🗂️ <span>تصاريح العمل — حسب الحالة</span></div>
          <div class="dash-chart-wrap"><canvas id="chartPermitStatus"></canvas></div>
        </div>
        <div class="dash-chart-card">
          <div class="dash-chart-title">🔧 <span>تصاريح العمل — حسب النوع</span></div>
          <div class="dash-chart-wrap"><canvas id="chartPermitType"></canvas></div>
        </div>
        <div class="dash-chart-card">
          <div class="dash-chart-title">⚠️ <span>بلاغات الخطورة — حسب الشدة</span></div>
          <div class="dash-chart-wrap"><canvas id="chartHazardSeverity"></canvas></div>
        </div>
      </div>

      <!-- Charts Row 2: Time series -->
      <div class="dash-section-title">📅 الاتجاهات الشهرية (آخر 12 شهر)</div>
      <div class="dash-chart-grid">
        <div class="dash-chart-card span-2">
          <div class="dash-chart-title">📉 <span>تصاريح وبلاغات — شهرياً</span></div>
          <div class="dash-chart-wrap tall"><canvas id="chartMonthly"></canvas></div>
        </div>
      </div>

      <!-- Charts Row 3: Training topics + Drills -->
      <div class="dash-section-title">🎓 التدريب وتجارب الطوارئ</div>
      <div class="dash-chart-grid">
        <div class="dash-chart-card">
          <div class="dash-chart-title">📚 <span>أكثر الموضوعات تدريباً</span></div>
          <div id="dashTopicsList" class="dash-topic-list" style="padding:8px 0;min-height:180px;">
            ${trainings.topTopics.length === 0 ? '<div class="dash-empty">لا توجد بيانات</div>' :
              trainings.topTopics.map((t, i) => {
                const max = trainings.topTopics[0].count || 1;
                const pct = Math.round((t.count / max) * 100);
                const colors = ['#4f46e5','#0ea5e9','#16A34A','#D97706','#DC2626','#8b5cf6'];
                return `<div class="dash-topic-row">
                  <div class="dash-topic-name" title="${escapeHtml(t.label)}">${escapeHtml(t.label)}</div>
                  <div class="dash-topic-bar-bg"><div class="dash-topic-bar" style="width:${pct}%;background:${colors[i%colors.length]};"></div></div>
                  <div class="dash-topic-count">${t.count}</div>
                </div>`;
              }).join('')}
          </div>
        </div>
        <div class="dash-chart-card">
          <div class="dash-chart-title">🚨 <span>تجارب الطوارئ — الحالة</span></div>
          <div class="dash-chart-wrap"><canvas id="chartDrillStatus"></canvas></div>
        </div>
        <div class="dash-chart-card">
          <div class="dash-chart-title">📊 <span>التدريبات والتجارب — شهرياً</span></div>
          <div class="dash-chart-wrap"><canvas id="chartTrainingsMonthly"></canvas></div>
        </div>
      </div>

      <!-- Penalties -->
      <div class="dash-section-title">⚖️ الجزاءات</div>
      <div class="dash-chart-grid">
        ${_dashListCard({
          icon: '⚖️', title: 'أحدث الجزاءات — الأسماء والأسباب',
          items: penalties.list, emptyMsg: 'لا توجد جزاءات مسجلة في هذه الفترة',
          renderRow: p => `
            <div class="dash-list-row">
              <div class="dash-list-main">
                <div class="dash-list-title" title="${escapeHtml(p.title)}">${p.empName ? `${escapeHtml(p.empName)} — ` : ''}${escapeHtml(p.title)}</div>
                <div class="dash-list-meta">${_dashFmtDate(p.date)}${p.issuedBy ? ' · ' + escapeHtml(p.issuedBy) : ''}</div>
              </div>
            </div>`
        })}
      </div>

    </div><!-- end inner content wrapper -->
  `;

  // Animate KPI counters
  _animateCounter(document.getElementById('kpiPermitTotal'),  permits.total);
  _animateCounter(document.getElementById('kpiHazardTotal'),  hazards.total);
  _animateCounter(document.getElementById('kpiTrainingTotal'), trainings.total);
  _animateCounter(document.getElementById('kpiDrillTotal'),   drills.total);
  _animateCounter(document.getElementById('kpiPenaltyTotal'), penalties.total);

  _dashLoadTargetCompliance(null, {
    pctTrainAchievedId: 'kpiTrainAchievedPct', subTrainAchievedId: 'kpiTrainAchievedSub',
    pctHazAchievedId:   'kpiHazardTargetPct',  subHazAchievedId:   'kpiHazardTargetSub',
    pctOverallId: 'execCompliancePct', subOverallId: 'execComplianceSub'
  });
}

// ── Quarterly target info ────────────────────────────────────────────────────
// The year is fixed at 4 calendar quarters. Both annual targets — training
// (EMP_TARGET_TRAIN_HOURS = 8h/year) and hazard reports (EMP_TARGET_HAZARDS =
// 2/year) — are divided by 4 and prorated to however many quarters have
// elapsed so far this year (Q1→¼, Q2→½, Q3→¾, Q4→full), and measured
// CUMULATIVELY SINCE THE START OF THE CALENDAR YEAR (not reset each quarter,
// not a rolling 12-month window). Example — by Q3: training target =
// 8/4×3 = 6h, hazard target = 2/4×3 = 1.5 reports, both counted since Jan 1.
// This applies ONLY to this one dashboard KPI section — nowhere else in the
// app (leaderboard, personal target progress, etc. keep using the fixed
// annual target with no window restriction).
function _dashGetCurrentQuarterInfo() {
  const now = new Date();
  const quarterIdx = Math.floor(now.getMonth() / 3); // 0..3
  const quartersElapsed = quarterIdx + 1;             // 1, 2, 3, or 4
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const quarterNames = ['الربع الأول (يناير–مارس)', 'الربع الثاني (أبريل–يونيو)', 'الربع الثالث (يوليو–سبتمبر)', 'الربع الرابع (أكتوبر–ديسمبر)'];
  return {
    yearStart,
    quartersElapsed,
    targetHours:    (EMP_TARGET_TRAIN_HOURS / 4) * quartersElapsed,
    targetHazards:  (EMP_TARGET_HAZARDS / 4) * quartersElapsed,
    label: `${quarterNames[quarterIdx]} ${now.getFullYear()}`,
  };
}

// ── Employees vs. year-to-date prorated training/hazard targets ────────────
// scopeDept: null = company-wide, or a department name to scope to (dept_admin view)
async function _dashLoadTargetCompliance(scopeDept, ids) {
  const pctTrainAchEl = document.getElementById(ids.pctTrainAchievedId);
  const subTrainAchEl = document.getElementById(ids.subTrainAchievedId);
  const pctHazEl   = document.getElementById(ids.pctHazAchievedId);
  const subHazEl   = document.getElementById(ids.subHazAchievedId);
  const pctOverallEl = ids.pctOverallId ? document.getElementById(ids.pctOverallId) : null;
  const subOverallEl = ids.subOverallId ? document.getElementById(ids.subOverallId) : null;
  if (!pctTrainAchEl || !pctHazEl) return;

  try {
    const [empRes, hazRes, trainRes] = await Promise.all([
      authFetch('/api/employees'),
      authFetch('/api/hazards'),
      authFetch('/api/trainings')
    ]);
    let employees = empRes.ok ? toArray(await empRes.json()) : [];
    window._allHazardsCache = hazRes.ok ? toArray(await hazRes.json()) : [];
    window._trainingsCache  = trainRes.ok ? toArray(await trainRes.json()) : [];

    if (scopeDept) {
      const scopeLower = scopeDept.toLowerCase();
      employees = employees.filter(e => (e.department || '').toLowerCase().includes(scopeLower));
    }

    const q = _dashGetCurrentQuarterInfo();
    // Both training hours and hazard reports are counted cumulatively since
    // the start of THIS YEAR (not reset per quarter, not a rolling window).
    const scored = computeAllStats(employees, q.yearStart, q.quartersElapsed * 3);
    const total = employees.length;

    const trainAchieved = scored.filter(e => e._stats.trainingHours >= q.targetHours).length;
    const hazAchieved   = scored.filter(e => e._stats.hazardsCount   >= q.targetHazards).length;

    const trainAchPct = total ? Math.round((trainAchieved / total) * 100) : 0;
    const hazPct       = total ? Math.round((hazAchieved / total) * 100) : 0;

    pctTrainAchEl.textContent = `${trainAchPct}%`;
    pctHazEl.textContent      = `${hazPct}%`;
    if (subTrainAchEl) subTrainAchEl.innerHTML = `<span class="dash-kpi-pill green">${trainAchieved} من ${total} موظف</span> <span class="dash-kpi-pill blue">تارجت ${q.label}: ${q.targetHours}س</span>`;
    if (subHazEl)       subHazEl.innerHTML     = `<span class="dash-kpi-pill green">${hazAchieved} من ${total} موظف</span> <span class="dash-kpi-pill blue">تارجت ${q.label}: ${q.targetHazards} بلاغ</span>`;

    // Executive hero headline: single overall compliance number = average of
    // the two target-achievement rates above (training targets + hazard
    // reporting targets), so the opening snapshot summarizes both in one figure.
    if (pctOverallEl) {
      const overallPct = total ? Math.round((trainAchPct + hazPct) / 2) : 0;
      pctOverallEl.textContent = `${overallPct}%`;
      if (subOverallEl) subOverallEl.innerHTML = `تدريب ${trainAchPct}% · بلاغات خطورة ${hazPct}%`;
    }
  } catch (err) {
    console.error('Target compliance load error', err);
    pctTrainAchEl.textContent = '—';
    pctHazEl.textContent      = '—';
    if (pctOverallEl) pctOverallEl.textContent = '—';
  }
}

// ── Render all Chart.js charts ────────────────────────────────
function renderDashboardCharts(data) {
  const { permits, hazards, trainings, drills } = data;

  _dashRegisterChartPlugins();

  // Shared chart defaults
  Chart.defaults.font.family = 'Cairo, sans-serif';
  Chart.defaults.font.size   = 12;
  Chart.defaults.color       = '#64748b';

  const PALETTE = ['#4f46e5','#0ea5e9','#16A34A','#D97706','#DC2626','#8b5cf6','#ec4899','#14b8a6'];

  // Shared tooltip look for every chart in this function
  const _tip = {
    backgroundColor: '#1f2937', titleColor: '#fff', bodyColor: '#e5e7eb',
    padding: 10, cornerRadius: 8, titleFont: { family: 'Cairo, sans-serif', weight: '700' },
    bodyFont: { family: 'Cairo, sans-serif' }, displayColors: true, boxPadding: 4,
  };

  // ── 1. Permit status — Doughnut ───────────────────────────
  _destroyChart('chartPermitStatus');
  const ctxPS = document.getElementById('chartPermitStatus');
  if (ctxPS) {
    const psData  = [permits.byStatus.approved, permits.byStatus.pending, permits.byStatus.rejected];
    const psTotal = psData.reduce((a, b) => a + b, 0);
    _dashCharts['chartPermitStatus'] = new Chart(ctxPS, {
      type: 'doughnut',
      data: {
        labels: ['موافق', 'انتظار', 'مرفوض'],
        datasets: [{ data: psData,
          backgroundColor: ['#16A34A','#D97706','#DC2626'],
          hoverBackgroundColor: ['#15803d','#b45309','#b91c1c'],
          borderWidth: 2, borderColor: '#fff', hoverBorderWidth: 0, hoverOffset: 4 }]
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: '72%',
        animation: { animateRotate: true, duration: 800, easing: 'easeOutQuart' },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, padding: 18, usePointStyle: true, pointStyle: 'circle', font: { size: 12, weight: '600' } } },
          tooltip: { ..._tip, callbacks: { label: (ctx) => {
            const pct = psTotal ? Math.round((ctx.parsed / psTotal) * 100) : 0;
            return ` ${ctx.label}: ${ctx.parsed.toLocaleString('en-US')} (${pct}%)`;
          } } },
          _dashCenterText: { enabled: true, total: psTotal, label: 'إجمالي التصاريح' },
        }
      }
    });
  }

  // ── 2. Permit type — Bar (horizontal) ────────────────────
  _destroyChart('chartPermitType');
  const ctxPT = document.getElementById('chartPermitType');
  if (ctxPT) {
    // Sort descending by count so the biggest category reads first (top),
    // and give each type a fixed, consistent color.
    const typeEntries = Object.entries(permits.byType).sort((a, b) => b[1] - a[1]);
    const typeKeys   = typeEntries.map(e => e[0]);
    const typeLabels = typeKeys.map(k => PERMIT_TYPE_LABELS[k] || k);
    const typeVals   = typeEntries.map(e => e[1]);
    const typeColors = typeKeys.map((k, i) => PERMIT_TYPE_COLORS[k] || PALETTE[i % PALETTE.length]);
    // Give the wrapper a bit more room when there are more bars to show.
    const wrapPT = ctxPT.parentElement;
    if (wrapPT) wrapPT.style.height = Math.max(240, typeVals.length * 40 + 30) + 'px';

    _dashCharts['chartPermitType'] = new Chart(ctxPT, {
      type: 'bar',
      data: {
        labels: typeLabels,
        datasets: [{ label: 'عدد التصاريح', data: typeVals,
          backgroundColor: typeColors, hoverBackgroundColor: typeColors,
          borderRadius: 6, borderSkipped: false,
          barPercentage: 0.6, categoryPercentage: 0.7 }]
      },
      options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y',
        animation: { duration: 700, easing: 'easeOutQuart' },
        layout: { padding: { left: 4, right: 12, top: 4, bottom: 4 } },
        plugins: {
          legend: { display: false },
          tooltip: { ..._tip, callbacks: { label: (ctx) => ` ${ctx.parsed.x.toLocaleString('en-US')} تصريح` } },
        },
        scales: {
          x: { grid: { color: '#f1f5f9', drawTicks: false }, border: { display: false },
            ticks: { precision: 0, maxTicksLimit: 6, font: { size: 11 },
              callback: (v) => Number(v).toLocaleString('en-US') } },
          y: { grid: { display: false }, border: { display: false },
            ticks: { font: { size: 12, weight: '600' }, color: '#334155' } }
        }
      }
    });
  }

  // ── 3. Hazard severity — Doughnut ────────────────────────
  _destroyChart('chartHazardSeverity');
  const ctxHS = document.getElementById('chartHazardSeverity');
  if (ctxHS) {
    const { low, medium, high, critical } = hazards.bySeverity;
    const hsData  = [low, medium, high, critical];
    const hsTotal = hsData.reduce((a, b) => a + b, 0);
    _dashCharts['chartHazardSeverity'] = new Chart(ctxHS, {
      type: 'doughnut',
      data: {
        labels: ['منخفض', 'متوسط', 'عالي', 'حرج'],
        datasets: [{ data: hsData,
          backgroundColor: ['#16A34A','#D97706','#DC2626','#7C1D1D'],
          hoverBackgroundColor: ['#15803d','#b45309','#b91c1c','#5c1414'],
          borderWidth: 2, borderColor: '#fff', hoverBorderWidth: 0, hoverOffset: 4 }]
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: '72%',
        animation: { animateRotate: true, duration: 800, easing: 'easeOutQuart' },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, padding: 14, usePointStyle: true, pointStyle: 'circle', font: { size: 12, weight: '600' } } },
          tooltip: { ..._tip, callbacks: { label: (ctx) => {
            const pct = hsTotal ? Math.round((ctx.parsed / hsTotal) * 100) : 0;
            return ` ${ctx.label}: ${ctx.parsed.toLocaleString('en-US')} (${pct}%)`;
          } } },
          _dashCenterText: { enabled: true, total: hsTotal, label: 'إجمالي البلاغات' },
        }
      }
    });
  }

  // ── 4. Monthly trends (permits + hazards) — Line ──────────
  _destroyChart('chartMonthly');
  const ctxM = document.getElementById('chartMonthly');
  if (ctxM) {
    const months = Object.keys(permits.monthly);
    const monthLabels = months.map(m => {
      const [y, mo] = m.split('-');
      return new Date(+y, +mo - 1).toLocaleDateString('ar-EG-u-nu-latn', { month: 'short', year: '2-digit' });
    });
    _dashCharts['chartMonthly'] = new Chart(ctxM, {
      type: 'line',
      data: {
        labels: monthLabels,
        datasets: [
          { label: 'تصاريح العمل', data: Object.values(permits.monthly),
            borderColor: '#4f46e5', backgroundColor: 'rgba(79,70,229,0.08)',
            fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: '#4f46e5' },
          { label: 'بلاغات الخطورة', data: Object.values(hazards.monthly),
            borderColor: '#DC2626', backgroundColor: 'rgba(239,68,68,0.06)',
            fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: '#DC2626' },
        ]
      },
      options: { responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top', labels: { boxWidth: 14, padding: 16 } } },
        scales: {
          x: { grid: { color: '#f0f4f8' } },
          y: { grid: { color: '#f0f4f8' }, beginAtZero: true, ticks: { stepSize: 1 } }
        }
      }
    });
  }

  // ── 5. Drill status — Pie ─────────────────────────────────
  _destroyChart('chartDrillStatus');
  const ctxDS = document.getElementById('chartDrillStatus');
  if (ctxDS) {
    _dashCharts['chartDrillStatus'] = new Chart(ctxDS, {
      type: 'pie',
      data: {
        labels: ['نشط', 'مغلق'],
        datasets: [{ data: [drills.active, drills.closed],
          backgroundColor: ['#D97706','#16A34A'],
          borderWidth: 2, borderColor: '#fff' }]
      },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 14 } } }
      }
    });
  }

  // ── 6. Training + Drills monthly — Bar ───────────────────
  _destroyChart('chartTrainingsMonthly');
  const ctxTM = document.getElementById('chartTrainingsMonthly');
  if (ctxTM) {
    const tMonths = Object.keys(trainings.monthly);
    const tLabels = tMonths.map(m => {
      const [y, mo] = m.split('-');
      return new Date(+y, +mo - 1).toLocaleDateString('ar-EG-u-nu-latn', { month: 'short' });
    });
    _dashCharts['chartTrainingsMonthly'] = new Chart(ctxTM, {
      type: 'bar',
      data: {
        labels: tLabels,
        datasets: [
          { label: 'التدريبات', data: Object.values(trainings.monthly),
            backgroundColor: 'rgba(245,158,11,0.8)', borderRadius: 4 },
          { label: 'تجارب الطوارئ', data: Object.values(drills.monthly),
            backgroundColor: 'rgba(239,68,68,0.75)', borderRadius: 4 },
        ]
      },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { boxWidth: 12, padding: 12 } } },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: '#f0f4f8' }, beginAtZero: true, ticks: { stepSize: 1 } }
        }
      }
    });
  }
}

// Initialize default date range (last 30 days) once
(function() {
  const now = new Date();
  const from = new Date(now); from.setDate(from.getDate() - 30);
  _dashFromDate = from.toISOString().slice(0, 10);
  _dashToDate   = now.toISOString().slice(0, 10);
})();