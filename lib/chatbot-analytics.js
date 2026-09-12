// ============================================================
// lib/chatbot-analytics.js — أسئلة الإدارة عن بيانات المنصة كلها
// ============================================================
// الطبقة دي بتجاوب على أي سؤال رقمي/تحليلي عن: بلاغات الخطورة، تصاريح
// العمل، المحاضرات التدريبية، تجارب الطوارئ، الجزاءات، الموظفين، ونسبة
// الالتزام بالأهداف — بأي صياغة (كام / عدد / مجموع / اعرضلي / آخر / أقدم /
// المتأخر / العالي الخطورة / لكل قسم / الشهر ده / السنة دي / لموظف معيّن).
//
// الصلاحيات: الطبقة دي للإدارة بس. العامل بياخد رد لطيف إن الأرقام دي
// للإدارة (chatbot.js هو اللي بيعمل ده) — وبياناته هو بترجع من
// chatbot-personal.js. أدمن القسم/الصيانة بيشوف قسمه بس.
'use strict';

const { normalizeArabic, arCount, STOP } = require('./chatbot-kb');
const { detectDepartments } = require('./chatbot-org');

const SOURCE = 'بيانات المنصة الحية';
const ADMIN_ROLES = ['super_admin', 'hse_admin', 'dept_admin', 'maint_admin', 'ceo', 'hse_director'];
const DEPT_SCOPED = ['dept_admin', 'maint_admin'];
const TRAIN_TARGET = 8;    // ساعة تدريب في السنة لكل موظف
const HAZARD_TARGET = 2;   // بلاغ خطورة في السنة لكل موظف
const PENALTY_DEDUCTION = 15; // نقطة بتتخصم عن كل جزاء نشط (نفس خصم "العامل المثالي")

// ── أدوات عامة ───────────────────────────────────────────────────
const n2 = v => Number(v || 0).toLocaleString('en-US');
const normCode = v => String(v == null ? '' : v).trim().replace(/^0+/, '').toUpperCase();
const normName = v => normalizeArabic(v).replace(/\s+/g, ' ').trim();
const short = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function arr(fn) { try { const v = typeof fn === 'function' ? fn() : fn; return Array.isArray(v) ? v : []; } catch { return []; } }
function fmtDate(d) {
  const x = new Date(d);
  return isNaN(x) ? String(d || '—') : x.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
}
const dateOf = x => new Date(x.date || x.submittedAt || x.createdAt || 0);
const isDeletedRec = r => Boolean(
  r.deleted || r.isDeleted || r.deletedAt ||
  (r.deletedBy && typeof r.deletedBy === 'object' && Object.values(r.deletedBy).some(Boolean)) ||
  (r.permanentlyDeletedBy && typeof r.permanentlyDeletedBy === 'object' && Object.values(r.permanentlyDeletedBy).some(Boolean))
);

const HAZ_OPEN = h => !/^(closed|resolved|rejected)/.test(String(h.status || 'open'));
const HAZ_DONE = h => /^(closed|resolved)/.test(String(h.status || ''));
const HAZ_REJECTED = h => /^rejected/.test(String(h.status || ''));
const RISK_LABEL = { H: 'عالية', M: 'متوسطة', L: 'منخفضة', C: 'حرجة' };
const riskOf = h => String(h.riskLevel || '').toUpperCase();
const HOURS_48 = 48 * 3600 * 1000;

const PERMIT_PENDING = p => /^pending/.test(String(p.status || ''));
const PERMIT_STATUS_LABEL = {
  approved: 'معتمد', pending: 'مستني أدمن القسم', pending_dept: 'مستني أدمن القسم',
  pending_area_head: 'مستني أدمن القسم', pending_hse: 'مستني اعتماد السلامة', rejected: 'مرفوض',
  closed_safe: 'اتقفل بأمان', closed_incomplete: 'اتقفل (لم يكتمل)', closed_forced: 'إغلاق جبري',
};
const PERMIT_TYPE_LABEL = {
  lockout: 'فصل وعزل (LOTO)', general: 'عام', hot: 'عمل ساخن', height: 'عمل على ارتفاعات',
  lifting: 'رفع', excavation: 'حفر', confined: 'أماكن مغلقة',
};

function trainingHours(t) {
  for (const k of ['durationHours', 'hours', 'duration']) {
    const v = t[k];
    if (v !== undefined && v !== null && v !== '' && !isNaN(Number(v))) return Number(v);
  }
  return t.durationMinutes ? Number(t.durationMinutes) / 60 : 0.5;
}
const attCode = a => normCode(a && (a.empCode || a.code || a.employeeCode || a.id));

// ── الفترة الزمنية ───────────────────────────────────────────────
const MONTHS = ['يناير', 'فبراير', 'مارس', 'ابريل', 'مايو', 'يونيو', 'يوليو', 'اغسطس', 'سبتمبر', 'اكتوبر', 'نوفمبر', 'ديسمبر'];
const AR_NUM = { 'واحد': 1, 'اتنين': 2, 'تلاته': 3, 'ثلاثه': 3, 'اربعه': 4, 'خمسه': 5, 'سته': 6, 'سبعه': 7, 'تمانيه': 8, 'تسعه': 9, 'عشره': 10 };

/** يرجع {from, to, label} أو null لو السؤال مش فيه فترة */
function detectPeriod(nq) {
  const now = new Date();
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const mk = (from, to, label) => ({ from, to, label });

  if (/النهارده|اليوم|النهاردة/.test(nq)) return mk(startOfDay(now), now, 'النهاردة');
  if (/امبارح|البارحه/.test(nq)) {
    const y = startOfDay(new Date(now.getTime() - 86400000));
    return mk(y, new Date(y.getTime() + 86399999), 'إمبارح');
  }
  if (/الاسبوع ده|الاسبوع الحالي|اخر اسبوع|خلال اسبوع|الاسبوع اللي فات/.test(nq)) {
    return mk(new Date(now.getTime() - 7 * 86400000), now, 'آخر 7 أيام');
  }
  if (/الشهر اللي فات|الشهر الماضي|الشهر السابق/.test(nq)) {
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const to = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    return mk(from, to, `شهر ${MONTHS[from.getMonth()]} ${from.getFullYear()}`);
  }
  // "الشهري" مش "الشهر" — بنقارن بحدود الكلمة عشان "الفحص الشهري" ماتتقريش شهر
  if (/الشهر ده|الشهر الحالي|شهر كام|خلال الشهر|(^|\s)الشهر(\s|$)/.test(nq) && !/شهور|اشهر/.test(nq)) {
    return mk(new Date(now.getFullYear(), now.getMonth(), 1), now, `شهر ${MONTHS[now.getMonth()]}`);
  }
  if (/السنه دي|السنه الحاليه|من اول السنه|هذا العام|(^|\s)السنه(\s|$)/.test(nq) && !/سنين|سنوات/.test(nq)) {
    return mk(new Date(now.getFullYear(), 0, 1), now, `سنة ${now.getFullYear()}`);
  }
  if (/السنه اللي فاتت|العام الماضي/.test(nq)) {
    const y = now.getFullYear() - 1;
    return mk(new Date(y, 0, 1), new Date(y, 11, 31, 23, 59, 59), `سنة ${y}`);
  }
  if (/الربع/.test(nq)) {
    const qIdx = /الاول/.test(nq) ? 0 : /التاني|الثاني/.test(nq) ? 1 : /التالت|الثالث/.test(nq) ? 2 : /الرابع/.test(nq) ? 3 : Math.floor(now.getMonth() / 3);
    const from = new Date(now.getFullYear(), qIdx * 3, 1);
    const to = new Date(now.getFullYear(), qIdx * 3 + 3, 0, 23, 59, 59);
    return mk(from, to > now ? now : to, `الربع ${['الأول', 'الثاني', 'الثالث', 'الرابع'][qIdx]} ${now.getFullYear()}`);
  }
  // "آخر 30 يوم" / "آخر 3 شهور" / "آخر سنتين"
  const rel = nq.match(/اخر\s+(\d+|واحد|اتنين|تلاته|ثلاثه|اربعه|خمسه|سته|سبعه|تمانيه|تسعه|عشره)?\s*(يوم|ايام|شهر|شهور|اشهر|سنه|سنين|سنوات)/);
  if (rel) {
    const num = rel[1] ? (AR_NUM[rel[1]] || parseInt(rel[1], 10) || 1) : (/شهرين|يومين|سنتين/.test(nq) ? 2 : 1);
    const unit = rel[2];
    if (/يوم|ايام/.test(unit)) return mk(new Date(now.getTime() - num * 86400000), now, `آخر ${arCount(num, 'يوم')}`);
    if (/شهر|شهور|اشهر/.test(unit)) return mk(new Date(now.getFullYear(), now.getMonth() - num, now.getDate()), now, `آخر ${arCount(num, 'شهر')}`);
    return mk(new Date(now.getFullYear() - num, now.getMonth(), now.getDate()), now, `آخر ${arCount(num, 'سنة')}`);
  }
  // اسم شهر صريح ("في مارس" / "شهر 3")
  for (let i = 0; i < MONTHS.length; i++) {
    if (new RegExp(`(^|\\s)${MONTHS[i]}(\\s|$)`).test(nq)) {
      const ym = nq.match(/20\d\d/);
      const year = ym ? Number(ym[0]) : now.getFullYear();
      return mk(new Date(year, i, 1), new Date(year, i + 1, 0, 23, 59, 59), `${MONTHS[i]} ${year}`);
    }
  }
  const ym = nq.match(/(^|\s)(20\d\d)(\s|$)/);
  if (ym) {
    const year = Number(ym[2]);
    return mk(new Date(year, 0, 1), new Date(year, 11, 31, 23, 59, 59), `سنة ${year}`);
  }
  return null;
}

const inPeriod = (rec, period) => {
  if (!period) return true;
  const d = dateOf(rec);
  if (isNaN(d)) return true;
  return d >= period.from && d <= period.to;
};

// ── تحديد الموضوع (entity) والمطلوب (aggregation) ────────────────
const ENTITY_RE = [
  ['hazards', /بلاغ|بلاغات|هازارد|هزارد|هاوارد|خطوره|خطورة|الخطور|hazard|haz-|مخاطر متسجل/],
  ['permits', /تصريح|تصاريح|بيرمت|permit|wp-|لوتو|loto/],
  ['trainings', /محاضر|تدريب|كورس|سيشن|training|ساعات تدريب/],
  ['drills', /تجربه|تجارب|درل|drill|اخلا|اخلاء/],
  ['penalties', /جزا|جزاء|عقوب|مخالف|انذار|خصم|penalt/],
  ['employees', /موظف|موظفين|عامل|عمال|العمال|افراد|الافراد|فرد|headcount/],
  ['compliance', /التزام|تارجت|target|اهداف|هدف|انجاز|تحقيق الهدف/],
  ['inspections', /فحص شهري|الفحص الشهري|inspection|تفتيش|اصناف الفحص|غير مطابق|غير المطابق|المطابقه|فحص p ?[12]|نتايج الفحص/],
];

function detectEntity(nq) {
  const hits = ENTITY_RE.filter(([, re]) => re.test(nq)).map(([k]) => k);
  if (!hits.length) return null;
  // "نسبة الالتزام بالتدريب" → compliance (الأولوية للالتزام لو اتذكر صريح)
  if (hits.includes('compliance') && /نسبه|نسبة|التزام|تارجت|target/.test(nq)) return 'compliance';
  return hits[0];
}

// الكلمات بتتقارن بحدود الكلمة (النص بيتنضف من علامات الترقيم قبل كده) عشان
// "متأخر" ماتتحسبش "آخر"، و"متقفلش" ماتتحسبش "متقفل".
const w = words => new RegExp(`(^|\\s)(ال|و|ب|ف)?(${words})(\\s|$)`);
const WANT = {
  count: w('كام|كم|عدد|اعداد|اجمالي|مجموع|احصاييه|احصاييات|total'),
  list: /(^|\s)(اعرض|اعرضلي|وريني|ورينى|هاتلي|جيبلي|اشوف|قايمه|قائمه|اسماء|اسامي|تفاصيل|list)(\s|$)|ايه هي|ايه اللي|عايز اشوف|عايز قايمه/,
  latest: /(^|\s)(اخر|احدث|اجدد|اخرهم|الاخير|الاخيره|الجديد)(\s|$)|latest/,
  oldest: /(^|\s)(اقدم|الاقدم|اول)(\s|$)/,
  breakdown: /لكل قسم|كل قسم|حسب القسم|بالاقسام|توزيع|حسب النوع|كل نوع|الانواع|انواع|حسب الحاله|حسب الخطوره|تفصيل|ترتيب الاقسام/,
  top: /(^|\s)(اكتر|اكثر|اعلي|اكبر|احسن|افضل|الاكتر|الاعلي)(\s|$)|top/,
  bottom: /(^|\s)(اقل|اسوا|اضعف|اقلهم|الاقل)(\s|$)/,
};

const STATE = {
  open: /(^|\s)(مفتوح|مفتوحه|المفتوحه|المفتوح|لسه|لسا|مستني|مستنيه|منتظر|معلق|معلقه|جاري|شغال|pending)(\s|$)|متقفلش|مقفلش|ماتقفلش|مش مقفول|مش متقفل|لم يغلق|لسه مفتوح/,
  closed: /(^|\s)(مقفول|مقفوله|المقفوله|مغلق|مغلقه|اتقفل|اتقفلت|اتحل|اتحلت|محلول|منتهي|منتهيه|closed|resolved)(\s|$)|تم الحل|تم الاغلاق/,
  overdue: /(^|\s)(متاخر|متاخره|المتاخره|متعطل)(\s|$)|48|فات عليه|بقاله|عدي عليه|عدت عليه/,
  rejected: /(^|\s)(مرفوض|مرفوضه|اترفض|rejected)(\s|$)/,
  high: /(^|\s)(خطير|خطيره|عالي|عاليه|العاليه|حرج|حرجه|شديد|كبير|high|critical)(\s|$)/,
  medium: /(^|\s)(متوسط|متوسطه|medium)(\s|$)/,
  low: /(^|\s)(منخفض|منخفضه|بسيط|low)(\s|$)/,
  approved: /(^|\s)(معتمد|معتمده|المعتمده|موافق|اتوافق|approved)(\s|$)|تم الاعتماد/,
};

// نوع تصريح العمل المذكور في السؤال
const PERMIT_TYPE_HINTS = [
  ['lockout', /فصل وعزل|لوتو|loto|lockout|عزل الطاقه|القفل/],
  ['hot', /ساخن|لحام|قطع|حراره|hot/],
  ['height', /ارتفاع|ارتفاعات|سقاله|height/],
  ['confined', /مغلق|مغلقه|خزان|confined/],
  ['excavation', /حفر|excavation/],
  ['lifting', /رفع|ونش|رافعه|lifting/],
];
const detectPermitType = nq => (PERMIT_TYPE_HINTS.find(([, re]) => re.test(nq)) || [null])[0];
// "مين ناقصه تدريب / مقصر في التارجت" → طبقة الالتزام
const MISSING_RE = /ناقص|ناقصه|ناقصين|مقصر|مقصرين|محققش|محققوش|مش محقق|تحت التارجت|اقل من التارجت|متاخر عن التارجت/;

// ── نطاق الأدمن ──────────────────────────────────────────────────
// scope.depts = الأقسام اللي السؤال مقصور عليها (فاضية = المصنع كله).
// "الصيانة" مثلاً بتطلع 3 أقسام (كهربا/ميكانيكا/وقائية) فبنجمعهم كلهم.
// "قسمي / القسم بتاعي / في القسم" = قسم صاحب الجلسة نفسه.
// لكن "لكل قسم / حسب القسم / ترتيب الأقسام" معناها كل الأقسام مش قسمه.
const MY_DEPT_STRONG = /(^|\s)(قسمي|قسمى|قسمنا|بقسمي|لقسمي)(\s|$)|القسم بتاعي|القسم بتاعنا|قسم بتاعي|في قسمي/;
const MY_DEPT_BARE = /(^|\s)(في |ب|ال)?القسم(\s|$)/;
const DEPT_BREAKDOWN_RE = /لكل قسم|كل قسم|حسب القسم|بالاقسام|الاقسام|ترتيب الاقسام|كل الاقسام|توزيع/;

function myDepartment(ctx) {
  const code = normCode(ctx.user && ctx.user.empCode);
  const emp = code ? arr(ctx.data.employees).find(e => normCode(e.empCode || e.code) === code) : null;
  return String((emp && emp.department) || (ctx.user && ctx.user.department) || '').trim();
}

function scopeOf(ctx, nq) {
  const role = ctx.user && ctx.user.role;
  const employees = arr(ctx.data.employees);
  const known = [...new Set(employees.map(e => String(e.department || '').trim()).filter(Boolean))];
  if (DEPT_SCOPED.includes(role)) {
    // أدمن القسم/الصيانة مقفول على قسمه مهما كان السؤال
    const d = String((ctx.user && ctx.user.department) || '') || myDepartment(ctx);
    // لو سأل عن قسم تاني بالاسم بنرد ببيانات قسمه + سطر يوضّح إن ده حد صلاحيته
    const asked = detectDepartments(nq, known).filter(x => !deptEq(x, d));
    return { depts: d ? [d] : [], dept: d, forced: true, deniedDept: asked[0] || '' };
  }
  const found = detectDepartments(nq, known);
  if (found.length) return { depts: found, dept: found.length === 1 ? found[0] : '', forced: false };
  // مفيش قسم مذكور بالاسم — لكن لو قال "قسمي/القسم" ناخد قسمه هو
  if (!DEPT_BREAKDOWN_RE.test(nq) && (MY_DEPT_STRONG.test(nq) || MY_DEPT_BARE.test(nq))) {
    const d = myDepartment(ctx);
    if (d) return { depts: [d], dept: d, forced: false, mine: true };
  }
  return { depts: [], dept: '', forced: false };
}
const deptEq = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const inScope = (recDept, scope) => !scope.depts.length || scope.depts.some(d => deptEq(d, recDept));

// أدمن القسم لما يسأل عن قسم مش بتاعه: بنرد ببيانات قسمه وبنقوله ليه، عشان
// ما يفتكرش إن الأرقام دي بتاعة القسم اللي سأل عنه.
function withScopeNote(answer, scope) {
  if (!answer || !answer.reply || !scope || !scope.forced || !scope.deniedDept) return answer;
  const note = `🔒 صلاحيتك على قسم ${scope.dept} بس — مش هينفع أعرض بيانات قسم ${scope.deniedDept}. دي أرقام قسمك:`;
  return { ...answer, reply: `${note}\n\n${answer.reply}` };
}

function scopeLabel(scope, period) {
  const where = !scope.depts.length ? 'المصنع كله'
    : scope.depts.length === 1 ? `قسم ${scope.depts[0]}${scope.mine ? ' (قسمك)' : ''}`
      : `أقسام ${scope.depts.join('، ')}`;
  return period ? `${where} — ${period.label}` : where;
}

// ── الموظف المذكور في السؤال (بالكود أو بالاسم) ──────────────────
function detectEmployee(question, ctx) {
  const employees = arr(ctx.data.employees);
  if (!employees.length) return null;
  const codeMatch = String(question).match(/(?:^|[^\d])(\d{3,6})(?:[^\d]|$)/);
  if (codeMatch) {
    const code = normCode(codeMatch[1]);
    const emp = employees.find(e => normCode(e.empCode || e.code) === code);
    if (emp) return emp;
  }
  const nq = normName(question);
  const words = nq.split(' ').filter(w => w.length >= 3);
  if (words.length < 2) return null;
  let best = null;
  employees.forEach(e => {
    const parts = normName(e.name).split(' ').filter(Boolean);
    if (parts.length < 2) return;
    const hits = parts.filter(p => words.includes(p)).length;
    if (hits >= 2 && (!best || hits > best.hits)) best = { emp: e, hits };
  });
  return best ? best.emp : null;
}

// ── جمع البيانات حسب النطاق ──────────────────────────────────────
function dataFor(ctx, scope, period) {
  const hazards = arr(ctx.data.hazards).filter(h => !isDeletedRec(h) && inScope(h.department || h.dept, scope) && inPeriod(h, period));
  const permits = arr(ctx.data.permits).filter(p => !isDeletedRec(p) && inScope(p.department, scope) && inPeriod(p, period));
  const penalties = arr(ctx.data.penalties).filter(p => p.status !== 'deleted' && inScope(p.department, scope) && inPeriod(p, period));
  const employees = arr(ctx.data.employees).filter(e => inScope(e.department, scope));
  const deptCodes = new Set(employees.map(e => normCode(e.empCode || e.code)).filter(Boolean));
  let trainings = arr(ctx.data.trainings).filter(t => !isDeletedRec(t) && inPeriod(t, period));
  let drills = arr(ctx.data.drills).filter(d => !isDeletedRec(d) && inPeriod(d, period));
  if (scope.depts.length) {
    trainings = trainings
      .map(t => ({ ...t, attendees: (t.attendees || []).filter(a => deptCodes.has(attCode(a))) }))
      .filter(t => t.attendees.length);
    drills = drills
      .map(d => ({ ...d, attendees: (d.attendees || []).filter(a => deptCodes.has(attCode(a))) }))
      .filter(d => d.attendees.length);
  }
  return { hazards, permits, penalties, employees, trainings, drills };
}

// ── ردود البلاغات ────────────────────────────────────────────────
const hazLine = h => `• ${h.id} — ${fmtDate(h.date || h.submittedAt)} — ${short(h.department || '—', 24)} (${h.area || '—'})\n   ${short(h.description, 90)}\n   الحالة: ${HAZ_OPEN(h) ? 'مفتوح ⏳' : HAZ_DONE(h) ? 'مقفول ✅' : 'مرفوض ❌'} · الخطورة: ${RISK_LABEL[riskOf(h)] || '—'}${h.reporterName ? ` · المُبلِّغ: ${short(h.reporterName, 26)}` : ''}`;

function hazardsAnswer(nq, ctx, scope, period, question) {
  const { hazards } = dataFor(ctx, scope, period);
  const idm = String(question).match(/(?:haz|hz)-[\w-]+/i);
  if (idm) {
    const id = idm[0].toUpperCase();
    const h = arr(ctx.data.hazards).find(x => String(x.id).toUpperCase() === id || String(x.id).toUpperCase().endsWith(id));
    if (!h) return { reply: `مش لاقي بلاغ بالرقم ${id}.`, source: SOURCE };
    if (scope.forced && !inScope(h.department, scope)) return { reply: `البلاغ ${id} مش في قسمك — مقدرش أعرضه.`, source: SOURCE };
    return {
      reply: [
        `🔎 بلاغ ${h.id}`,
        `• الحالة: ${HAZ_OPEN(h) ? 'مفتوح ⏳' : HAZ_DONE(h) ? 'مقفول ✅' : 'مرفوض ❌'}`,
        `• التاريخ: ${fmtDate(h.date || h.submittedAt)}${h.resolvedAt ? ` · اتقفل: ${fmtDate(h.resolvedAt)}` : ''}`,
        `• القسم: ${h.department || '—'} · المكان: ${h.area || '—'}`,
        `• الخطورة: ${RISK_LABEL[riskOf(h)] || '—'}`,
        `• المُبلِّغ: ${h.reporterName || '—'}${h.empCode ? ` (${h.empCode})` : ''}`,
        `• الوصف: ${short(h.description, 300)}`,
        h.actionTaken ? `• الإجراء: ${short(h.actionTaken, 300)}` : '',
        h.hseName ? `• متابعة: ${h.hseName}` : '',
      ].filter(Boolean).join('\n'),
      source: SOURCE,
      suggestions: ['البلاغات المفتوحة', 'بلاغات متأخرة', 'بلاغات عالية الخطورة'],
    };
  }

  const open = hazards.filter(HAZ_OPEN);
  const closed = hazards.filter(HAZ_DONE);
  const rejected = hazards.filter(HAZ_REJECTED);
  const overdue = open.filter(h => Date.now() - dateOf(h).getTime() > HOURS_48);
  const byRisk = { H: 0, M: 0, L: 0, C: 0 };
  hazards.forEach(h => { const r = riskOf(h); if (byRisk[r] !== undefined) byRisk[r]++; });

  const wantHigh = STATE.high.test(nq);
  const wantOpen = STATE.open.test(nq);
  const wantClosed = STATE.closed.test(nq) && !wantOpen;
  const wantOverdue = STATE.overdue.test(nq);

  let pool = hazards, poolLabel = 'البلاغات', oneLabel = 'بلاغ', bareLabel = 'بلاغات';
  if (wantOverdue) { pool = open.filter(h => Date.now() - dateOf(h).getTime() > HOURS_48); poolLabel = 'البلاغات المتأخرة (أكتر من 48 ساعة)'; oneLabel = 'بلاغ متأخر'; bareLabel = 'بلاغات متأخرة (أكتر من 48 ساعة)'; }
  else if (wantOpen) { pool = open; poolLabel = 'البلاغات المفتوحة'; oneLabel = 'بلاغ مفتوح'; bareLabel = 'بلاغات مفتوحة'; }
  else if (wantClosed) { pool = closed; poolLabel = 'البلاغات المقفولة'; oneLabel = 'بلاغ مقفول'; bareLabel = 'بلاغات مقفولة'; }
  if (wantHigh) {
    pool = pool.filter(h => riskOf(h) === 'H' || riskOf(h) === 'C');
    poolLabel = `${poolLabel} عالية الخطورة`;
    oneLabel = `${oneLabel} عالي الخطورة`;
    bareLabel = `${bareLabel} عالية الخطورة`;
  }
  const filtered = wantHigh || wantOpen || wantClosed || wantOverdue;

  // "مين أكتر قسم عنده بلاغات" → توزيع على الأقسام
  if ((WANT.top.test(nq) || WANT.bottom.test(nq)) && !scope.depts.length && /قسم|اقسام/.test(nq)) {
    const m = new Map();
    pool.forEach(h => { const d = String(h.department || 'غير محدد').trim(); m.set(d, (m.get(d) || 0) + 1); });
    let rows = [...m.entries()].sort((a, b) => b[1] - a[1]);
    if (WANT.bottom.test(nq)) rows = rows.reverse();
    return {
      reply: `📊 ${WANT.bottom.test(nq) ? 'أقل' : 'أكتر'} الأقسام في ${poolLabel} — ${scopeLabel(scope, period)} (الإجمالي ${n2(pool.length)}):\n${rows.slice(0, 10).map(([d, c], i) => `${i + 1}) ${d}: ${n2(c)}`).join('\n')}`,
      source: SOURCE,
      suggestions: ['البلاغات المفتوحة', 'نسبة الالتزام لكل قسم'],
    };
  }

  // توزيع على الأقسام
  if (WANT.breakdown.test(nq) && !scope.depts.length) {
    const m = new Map();
    pool.forEach(h => { const d = String(h.department || 'غير محدد').trim(); m.set(d, (m.get(d) || 0) + 1); });
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    return {
      reply: `📊 ${poolLabel} حسب القسم — ${scopeLabel(scope, period)} (الإجمالي ${n2(pool.length)}):\n${rows.map(([d, c], i) => `${i + 1}) ${d}: ${n2(c)}`).join('\n')}`,
      source: SOURCE,
      suggestions: ['البلاغات المفتوحة', 'بلاغات متأخرة', 'نسبة الالتزام لكل قسم'],
    };
  }

  // آخر / أقدم
  const sorted = pool.slice().sort((a, b) => dateOf(b) - dateOf(a));
  if (WANT.latest.test(nq) && !WANT.count.test(nq)) {
    if (!sorted.length) return { reply: `✅ مفيش ${bareLabel} في ${scopeLabel(scope, period)}.`, source: SOURCE };
    const take = /قايمه|قائمه|اعرض|اخر \d+/.test(nq) ? 5 : 1;
    return {
      reply: `🆕 ${take > 1 ? `آخر ${take} من ${poolLabel}` : `آخر ${oneLabel}`} — ${scopeLabel(scope, period)}:\n${sorted.slice(0, take).map(hazLine).join('\n')}`,
      source: SOURCE,
      suggestions: ['كل البلاغات المفتوحة', 'بلاغات متأخرة', 'البلاغات حسب القسم'],
    };
  }
  if (WANT.oldest.test(nq)) {
    const oldFirst = sorted.slice().reverse();
    if (!oldFirst.length) return { reply: `✅ مفيش ${bareLabel} في ${scopeLabel(scope, period)}.`, source: SOURCE };
    return {
      reply: `⏳ أقدم ${poolLabel} — ${scopeLabel(scope, period)}:\n${oldFirst.slice(0, 5).map(hazLine).join('\n')}`,
      source: SOURCE,
      suggestions: ['بلاغات متأخرة', 'البلاغات المفتوحة'],
    };
  }

  // قائمة صريحة أو فلتر (مفتوح/عالي/متأخر) من غير كلمة "كام"
  const isCount = WANT.count.test(nq);
  if (isCount && filtered) {
    return {
      reply: [
        `📋 ${poolLabel} — ${scopeLabel(scope, period)}: ${n2(pool.length)}`,
        ``,
        `للعلم كمان:`,
        `• إجمالي البلاغات في النطاق ده: ${n2(hazards.length)}`,
        `• مفتوح: ${n2(open.length)}${overdue.length ? ` (منهم ${n2(overdue.length)} عدّى عليهم 48 ساعة ⚠️)` : ''} · مقفول: ${n2(closed.length)}`,
        `• حسب الخطورة: عالية ${n2(byRisk.H + byRisk.C)} · متوسطة ${n2(byRisk.M)} · منخفضة ${n2(byRisk.L)}`,
      ].join('\n'),
      source: SOURCE,
      suggestions: [`اعرضلي ${poolLabel}`, 'البلاغات حسب القسم', 'آخر بلاغ مفتوح'],
    };
  }
  if (!isCount && (WANT.list.test(nq) || wantHigh || wantOverdue || wantOpen || wantClosed)) {
    if (!pool.length) {
      const alt = wantHigh && open.length ? `\nبس فيه ${arCount(open.length, 'بلاغ')} مفتوح بخطورة أقل — تحب أعرضهم؟` : '';
      return {
        reply: `✅ مفيش ${bareLabel} في ${scopeLabel(scope, period)}.${alt}`,
        source: SOURCE,
        suggestions: ['اعرضلي البلاغات المفتوحة', 'بلاغات متأخرة', 'البلاغات حسب القسم'],
      };
    }
    const head = `📋 ${poolLabel} — ${scopeLabel(scope, period)}: ${n2(pool.length)}`;
    const lines = sorted.slice(0, 8).map(hazLine).join('\n');
    const more = pool.length > 8 ? `\n… و${arCount(pool.length - 8, 'بلاغ')} كمان (افتح تبويب "سجل البلاغات" تشوفهم كلهم).` : '';
    return { reply: `${head}\n\n${lines}${more}`, source: SOURCE, suggestions: ['بلاغات متأخرة', 'بلاغات عالية الخطورة', 'البلاغات حسب القسم'] };
  }

  // العدّ (الافتراضي)
  return {
    reply: [
      `📋 بلاغات الخطورة — ${scopeLabel(scope, period)}`,
      `• الإجمالي: ${n2(hazards.length)}`,
      `• مفتوح: ${n2(open.length)}${overdue.length ? ` (منهم ${n2(overdue.length)} عدّى عليهم 48 ساعة ⚠️)` : ''}`,
      `• مقفول: ${n2(closed.length)}${rejected.length ? `\n• مرفوض: ${n2(rejected.length)}` : ''}`,
      `• حسب الخطورة: عالية ${n2(byRisk.H + byRisk.C)} · متوسطة ${n2(byRisk.M)} · منخفضة ${n2(byRisk.L)}`,
      hazards.length ? `• نسبة الإغلاق: ${pct(closed.length, hazards.length)}%` : '',
    ].filter(Boolean).join('\n'),
    source: SOURCE,
    suggestions: ['آخر بلاغ مفتوح', 'بلاغات متأخرة', 'بلاغات عالية الخطورة', 'البلاغات حسب القسم'],
  };
}

// ── ردود التصاريح ────────────────────────────────────────────────
const permitLine = p => `• ${p.id} — ${PERMIT_TYPE_LABEL[p.typeKey] || p.typeLabel || 'تصريح'} — ${fmtDate(p.date || p.createdAt)} — ${short(p.location || p.department, 28)}\n   الحالة: ${PERMIT_STATUS_LABEL[p.status] || p.status || '—'}${p.workerName ? ` · مقدّم الطلب: ${short(p.workerName, 26)}` : ''}`;

function permitsAnswer(nq, ctx, scope, period, question) {
  const allPermits = dataFor(ctx, scope, period).permits;
  const typeKey = detectPermitType(nq);
  const permits = typeKey ? allPermits.filter(p => String(p.typeKey || '').toLowerCase() === typeKey) : allPermits;
  const typeNote = typeKey ? ` — ${PERMIT_TYPE_LABEL[typeKey]}` : '';
  const idm = String(question).match(/(?:wp|old)-[\w-]+/i);
  if (idm) {
    const id = idm[0].toUpperCase();
    const p = arr(ctx.data.permits).find(x => String(x.id).toUpperCase() === id);
    if (!p) return { reply: `مش لاقي تصريح بالرقم ${id}.`, source: SOURCE };
    return {
      reply: [
        `🔎 تصريح ${p.id} — ${PERMIT_TYPE_LABEL[p.typeKey] || p.typeLabel || ''}`,
        `• الحالة: ${PERMIT_STATUS_LABEL[p.status] || p.status}`,
        `• التاريخ: ${p.date || fmtDate(p.createdAt)} (${p.timeFrom || '—'} → ${p.timeTo || '—'})`,
        `• القسم: ${p.department || '—'} · المكان: ${p.location || '—'}`,
        `• مقدّم الطلب: ${p.workerName || '—'}${p.employeeId ? ` (${p.employeeId})` : ''}`,
        p.description ? `• الوصف: ${short(p.description, 250)}` : '',
        p.areaManagerName ? `• مدير المنطقة: ${p.areaManagerName}` : '',
        p.safetyOfficerName ? `• مسؤول السلامة: ${p.safetyOfficerName}` : '',
      ].filter(Boolean).join('\n'),
      source: SOURCE,
    };
  }

  const pending = permits.filter(PERMIT_PENDING);
  const approved = permits.filter(p => p.status === 'approved');
  const rejected = permits.filter(p => p.status === 'rejected');
  const closed = permits.filter(p => /^closed/.test(String(p.status || '')));
  const byType = new Map();
  permits.forEach(p => {
    const label = PERMIT_TYPE_LABEL[p.typeKey] || p.typeLabel || 'غير محدد';
    byType.set(label, (byType.get(label) || 0) + 1);
  });

  const wantPending = STATE.open.test(nq) && !STATE.approved.test(nq);
  let pool = permits, poolLabel = 'تصاريح العمل';
  if (wantPending) { pool = pending; poolLabel = 'التصاريح المستنية اعتماد'; }
  else if (STATE.approved.test(nq)) { pool = approved; poolLabel = 'التصاريح المعتمدة'; }
  else if (STATE.rejected.test(nq)) { pool = rejected; poolLabel = 'التصاريح المرفوضة'; }

  if (WANT.breakdown.test(nq) && (/نوع|انواع/.test(nq) || scope.depts.length)) {
    const rows = [...byType.entries()].sort((a, b) => b[1] - a[1]);
    return {
      reply: `📊 تصاريح العمل حسب النوع — ${scopeLabel(scope, period)} (الإجمالي ${n2(permits.length)}):\n${rows.map(([t, c], i) => `${i + 1}) ${t}: ${n2(c)}`).join('\n')}`,
      source: SOURCE,
      suggestions: ['تصاريح مستنية اعتماد', 'آخر تصريح', 'التصاريح حسب القسم'],
    };
  }
  if (WANT.breakdown.test(nq) && !scope.depts.length) {
    const m = new Map();
    permits.forEach(p => { const d = String(p.department || 'غير محدد').trim(); m.set(d, (m.get(d) || 0) + 1); });
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    return {
      reply: `📊 تصاريح العمل حسب القسم — ${scopeLabel(scope, period)} (الإجمالي ${n2(permits.length)}):\n${rows.map(([d, c], i) => `${i + 1}) ${d}: ${n2(c)}`).join('\n')}`,
      source: SOURCE,
    };
  }

  const sorted = pool.slice().sort((a, b) => dateOf(b) - dateOf(a));
  if (WANT.latest.test(nq) && !WANT.count.test(nq)) {
    if (!sorted.length) return { reply: `مفيش ${poolLabel} في ${scopeLabel(scope, period)}.`, source: SOURCE };
    const take = /قايمه|قائمه|اعرض|اخر \d+/.test(nq) ? 5 : 1;
    return { reply: `🆕 آخر ${poolLabel} — ${scopeLabel(scope, period)}:\n${sorted.slice(0, take).map(permitLine).join('\n')}`, source: SOURCE };
  }
  if (WANT.oldest.test(nq) && sorted.length) {
    return { reply: `⏳ أقدم ${poolLabel} — ${scopeLabel(scope, period)}:\n${sorted.slice().reverse().slice(0, 5).map(permitLine).join('\n')}`, source: SOURCE };
  }
  if (!WANT.count.test(nq) && (WANT.list.test(nq) || wantPending)) {
    if (!pool.length) return { reply: `✅ مفيش ${poolLabel} في ${scopeLabel(scope, period)}.`, source: SOURCE, suggestions: ['كام تصريح عمل؟', 'التصاريح حسب النوع'] };
    const more = pool.length > 8 ? `\n… و${arCount(pool.length - 8, 'تصريح')} كمان.` : '';
    return { reply: `📝 ${poolLabel} — ${scopeLabel(scope, period)}: ${n2(pool.length)}\n\n${sorted.slice(0, 8).map(permitLine).join('\n')}${more}`, source: SOURCE };
  }

  const topTypes = [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, c]) => `${t} ${n2(c)}`).join(' · ');
  return {
    reply: [
      `📝 تصاريح العمل${typeNote} — ${scopeLabel(scope, period)}`,
      `• الإجمالي: ${n2(permits.length)}`,
      `• معتمد: ${n2(approved.length)} · مستني اعتماد: ${n2(pending.length)}${rejected.length ? ` · مرفوض: ${n2(rejected.length)}` : ''}${closed.length ? ` · مقفول: ${n2(closed.length)}` : ''}`,
      topTypes ? `• أكتر الأنواع: ${topTypes}` : '',
    ].filter(Boolean).join('\n'),
    source: SOURCE,
    suggestions: ['تصاريح مستنية اعتماد', 'التصاريح حسب النوع', 'آخر تصريح', 'التصاريح حسب القسم'],
  };
}

// ── ردود التدريب ─────────────────────────────────────────────────
function trainingsAnswer(nq, ctx, scope, period) {
  const { trainings, employees } = dataFor(ctx, scope, period);
  const attendances = trainings.reduce((s, t) => s + (t.attendees || []).length, 0);
  const hours = trainings.reduce((s, t) => s + (t.attendees || []).length * trainingHours(t), 0);
  const active = trainings.filter(t => t.status === 'active');
  const sorted = trainings.slice().sort((a, b) => dateOf(b) - dateOf(a));

  if (/شغاله|شغالة|دلوقتي|مفتوحه|جاريه|active/.test(nq) && /محاضر|تدريب/.test(nq)) {
    if (active.length) {
      return {
        reply: `🟢 فيه ${arCount(active.length, 'محاضرة')} شغالة دلوقتي:\n${active.map(t => `• ${t.title || t.topic} — ${t.trainer ? `المحاضر: ${t.trainer}` : ''} — حضر لحد دلوقتي: ${(t.attendees || []).length}`).join('\n')}`,
        source: SOURCE,
      };
    }
    return { reply: `مفيش محاضرة شغالة دلوقتي.${sorted[0] ? `\nآخر محاضرة: ${sorted[0].title || sorted[0].topic} يوم ${fmtDate(sorted[0].date)}.` : ''}`, source: SOURCE };
  }

  if (WANT.latest.test(nq) && !WANT.count.test(nq) && sorted.length) {
    const take = /قايمه|قائمه|اعرض|اخر \d+/.test(nq) ? 5 : 1;
    return {
      reply: `🎓 آخر المحاضرات — ${scopeLabel(scope, period)}:\n${sorted.slice(0, take).map(t => `• ${fmtDate(t.date)} — ${t.title || t.topic} — ${arCount((t.attendees || []).length, 'حاضر')}${t.trainer ? ` — المحاضر: ${t.trainer}` : ''}`).join('\n')}`,
      source: SOURCE,
    };
  }

  if (/موضوع|مواضيع|topics|اكتر محاضر/.test(nq)) {
    const m = new Map();
    trainings.forEach(t => { const k = t.topic || t.title || 'غير محدد'; m.set(k, (m.get(k) || 0) + 1); });
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    return {
      reply: `🎓 أكتر مواضيع التدريب — ${scopeLabel(scope, period)}:\n${rows.map(([t, c], i) => `${i + 1}) ${t}: ${arCount(c, 'محاضرة')}`).join('\n')}`,
      source: SOURCE,
    };
  }

  if (WANT.list.test(nq) && sorted.length) {
    const more = sorted.length > 8 ? `\n… و${arCount(sorted.length - 8, 'محاضرة')} كمان.` : '';
    return {
      reply: `🎓 المحاضرات — ${scopeLabel(scope, period)}: ${n2(trainings.length)}\n${sorted.slice(0, 8).map(t => `• ${fmtDate(t.date)} — ${t.title || t.topic} (${arCount((t.attendees || []).length, 'حاضر')})`).join('\n')}${more}`,
      source: SOURCE,
    };
  }

  const perEmp = employees.length ? Math.round((hours / employees.length) * 10) / 10 : 0;
  return {
    reply: [
      `🎓 التدريب — ${scopeLabel(scope, period)}`,
      `• عدد المحاضرات: ${n2(trainings.length)}`,
      `• إجمالي الحضور: ${n2(attendances)} حضور`,
      `• ساعات التدريب: ${n2(Math.round(hours * 10) / 10)} ساعة`,
      employees.length ? `• متوسط نصيب الموظف: ${perEmp} ساعة (التارجت ${TRAIN_TARGET} ساعات في السنة)` : '',
      active.length ? `• فيه ${arCount(active.length, 'محاضرة')} شغالة دلوقتي 🟢` : '',
    ].filter(Boolean).join('\n'),
    source: SOURCE,
    suggestions: ['آخر محاضرة', 'أكتر مواضيع التدريب', 'نسبة الالتزام بالتدريب', 'مين ناقصه تدريب؟'],
  };
}

// ── ردود تجارب الطوارئ ───────────────────────────────────────────
function drillsAnswer(nq, ctx, scope, period) {
  const { drills } = dataFor(ctx, scope, period);
  const sorted = drills.slice().sort((a, b) => dateOf(b) - dateOf(a));
  const attendances = drills.reduce((s, d) => s + (d.attendees || []).length, 0);
  const open = drills.filter(d => d.status === 'active');
  if ((WANT.latest.test(nq) || WANT.list.test(nq)) && sorted.length) {
    const take = WANT.latest.test(nq) && !WANT.list.test(nq) ? 1 : 8;
    return {
      reply: `🚨 تجارب الطوارئ — ${scopeLabel(scope, period)}:\n${sorted.slice(0, take).map(d => `• ${fmtDate(d.date)} — ${d.title || 'تجربة'} — ${d.location || '—'} — ${d.status === 'active' ? 'شغالة 🟢' : 'مقفولة ✅'} (${arCount((d.attendees || []).length, 'حاضر')})`).join('\n')}`,
      source: SOURCE,
    };
  }
  return {
    reply: [
      `🚨 تجارب الطوارئ — ${scopeLabel(scope, period)}`,
      `• العدد: ${n2(drills.length)}${open.length ? ` (منهم ${arCount(open.length, 'تجربة طوارئ')} شغالة دلوقتي)` : ''}`,
      `• إجمالي الحضور المسجّل: ${n2(attendances)}`,
      sorted[0] ? `• آخر تجربة: ${sorted[0].title || '—'} يوم ${fmtDate(sorted[0].date)}${sorted[0].location ? ` (${sorted[0].location})` : ''}` : '',
    ].filter(Boolean).join('\n'),
    source: SOURCE,
    suggestions: ['آخر تجربة طوارئ', 'كام بلاغ مفتوح؟'],
  };
}

// ── ردود الجزاءات ────────────────────────────────────────────────
function penaltiesAnswer(nq, ctx, scope, period) {
  const { penalties } = dataFor(ctx, scope, period);
  const sorted = penalties.slice().sort((a, b) => dateOf(b) - dateOf(a));
  if (WANT.breakdown.test(nq) && !scope.depts.length) {
    const m = new Map();
    penalties.forEach(p => { const d = String(p.department || 'غير محدد').trim(); m.set(d, (m.get(d) || 0) + 1); });
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    return { reply: `⚖️ الجزاءات حسب القسم — ${scopeLabel(scope, period)} (${n2(penalties.length)}):\n${rows.map(([d, c], i) => `${i + 1}) ${d}: ${n2(c)}`).join('\n')}`, source: SOURCE };
  }
  if (/سبب|اسباب|اكتر سبب/.test(nq)) {
    const m = new Map();
    penalties.forEach(p => { const r = short(p.reason || 'غير محدد', 40); m.set(r, (m.get(r) || 0) + 1); });
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    return { reply: `⚖️ أكتر أسباب الجزاءات — ${scopeLabel(scope, period)}:\n${rows.map(([r, c], i) => `${i + 1}) ${r}: ${n2(c)}`).join('\n')}`, source: SOURCE };
  }
  if ((WANT.list.test(nq) || WANT.latest.test(nq)) && sorted.length) {
    const take = WANT.latest.test(nq) && !WANT.list.test(nq) ? 3 : 8;
    return {
      reply: `⚖️ آخر الجزاءات — ${scopeLabel(scope, period)} (${n2(penalties.length)}):\n${sorted.slice(0, take).map(p => `• ${fmtDate(p.date)} — ${p.empName || '—'} (${p.department || '—'})\n   السبب: ${short(p.reason, 90)}${p.issuedBy ? ` · صادر من: ${p.issuedBy}` : ''}`).join('\n')}`,
      source: SOURCE,
    };
  }
  return {
    reply: `⚖️ الجزاءات — ${scopeLabel(scope, period)}\n• العدد: ${n2(penalties.length)}${sorted[0] ? `\n• آخر جزاء: ${sorted[0].empName || '—'} يوم ${fmtDate(sorted[0].date)} — ${short(sorted[0].reason, 60)}` : ''}`,
    source: SOURCE,
    suggestions: ['آخر الجزاءات', 'أكتر أسباب الجزاءات', 'الجزاءات حسب القسم'],
  };
}

// ── ردود الموظفين ────────────────────────────────────────────────
function employeeProfileAnswer(emp, ctx, scope) {
  if (scope.forced && !inScope(emp.department, scope)) {
    return { reply: `الموظف ده مش في قسمك — مقدرش أعرض بياناته.`, source: SOURCE };
  }
  const code = normCode(emp.empCode || emp.code);
  const hazards = arr(ctx.data.hazards).filter(h => !isDeletedRec(h) && (normCode(h.empCode) === code || normName(h.reporterName) === normName(emp.name)));
  const trainings = arr(ctx.data.trainings).filter(t => !isDeletedRec(t) && (t.attendees || []).some(a => attCode(a) === code));
  const hours = trainings.reduce((s, t) => s + trainingHours(t), 0);
  const permits = arr(ctx.data.permits).filter(p => !isDeletedRec(p) && normCode(p.employeeId) === code);
  const penalties = arr(ctx.data.penalties).filter(p => p.status !== 'deleted' && normCode(p.empCode) === code);
  const drills = arr(ctx.data.drills).filter(d => !isDeletedRec(d) && (d.attendees || []).some(a => attCode(a) === code));
  const year = new Date().getFullYear();
  const hoursYtd = trainings.filter(t => dateOf(t).getFullYear() === year).reduce((s, t) => s + trainingHours(t), 0);
  const hzYtd = hazards.filter(h => dateOf(h).getFullYear() === year).length;
  return {
    reply: [
      `👤 ${emp.name}`,
      `• الكود الوظيفي: ${emp.empCode || code} · القسم: ${emp.department || '—'}`,
      `• الوظيفة: ${emp.jobTitle || '—'}`,
      `• الموبايل: ${emp.phone || 'مش مسجّل'}${emp.email ? ` · الإيميل: ${emp.email}` : ''}`,
      ``,
      `📊 سجله:`,
      `• التدريب: ${arCount(trainings.length, 'محاضرة')} = ${arCount(Math.round(hours * 10) / 10, 'ساعة')} (السنة دي ${Math.round(hoursYtd * 10) / 10} من ${TRAIN_TARGET})`,
      `• بلاغات الخطورة: ${n2(hazards.length)} (السنة دي ${hzYtd} من ${HAZARD_TARGET}) — مفتوح منهم ${n2(hazards.filter(HAZ_OPEN).length)}`,
      `• تصاريح العمل: ${n2(permits.length)}`,
      `• تجارب الطوارئ: ${n2(drills.length)}`,
      `• الجزاءات: ${n2(penalties.length)}${penalties.length ? ` — آخرها: ${short(penalties.sort((a, b) => dateOf(b) - dateOf(a))[0].reason, 60)}` : ''}`,
    ].join('\n'),
    source: `${SOURCE} (بيانات الموظفين)`,
    suggestions: ['مين ناقصه تدريب؟', 'نسبة الالتزام لكل قسم'],
  };
}

function employeesAnswer(nq, ctx, scope) {
  const employees = arr(ctx.data.employees).filter(e => inScope(e.department, scope));
  if (WANT.breakdown.test(nq) && !scope.depts.length) {
    const m = new Map();
    employees.forEach(e => { const d = String(e.department || 'غير محدد').trim(); m.set(d, (m.get(d) || 0) + 1); });
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    return { reply: `👥 عدد الموظفين حسب القسم (الإجمالي ${n2(employees.length)}):\n${rows.map(([d, c], i) => `${i + 1}) ${d}: ${n2(c)}`).join('\n')}`, source: SOURCE };
  }
  if (/رقم|تليفون|موبايل|ايميل|بيانات الاتصال/.test(nq)) {
    const withPhone = employees.filter(e => e.phone);
    return {
      reply: `📞 بيانات الاتصال — ${scopeLabel(scope, null)}\n• عدد الموظفين: ${n2(employees.length)}\n• مسجّلين رقم موبايل: ${n2(withPhone.length)} (${pct(withPhone.length, employees.length)}%)\n\nاسألني عن موظف بالاسم أو بالكود (مثلاً "بيانات الموظف 5504") وهجيبلك رقمه وسجله، أو نزّل الملف كله من تبويب "الموظفين" → "تصدير Excel".`,
      source: SOURCE,
    };
  }
  const depts = new Set(employees.map(e => String(e.department || '').trim()).filter(Boolean));
  return {
    reply: `👥 الموظفين — ${scopeLabel(scope, null)}\n• العدد: ${n2(employees.length)}${scope.depts.length ? '' : `\n• عدد الأقسام: ${n2(depts.size)}`}\n\nاسألني عن أي موظف بالاسم أو الكود عشان أجيبلك بياناته وسجله كامل.`,
    source: SOURCE,
    suggestions: ['عدد الموظفين لكل قسم', 'مين ناقصه تدريب؟', 'نسبة الالتزام لكل قسم'],
  };
}

// ── الالتزام بالأهداف ────────────────────────────────────────────
/** نفس حساب الداشبورد: ساعات التدريب وبلاغات الخطورة من أول السنة مقابل تارجت الربع */
function complianceData(ctx, scope) {
  const now = new Date();
  const quartersElapsed = Math.floor(now.getMonth() / 3) + 1;
  const targetHours = (TRAIN_TARGET / 4) * quartersElapsed;
  const targetHazards = Math.ceil((HAZARD_TARGET / 4) * quartersElapsed);
  const yearStart = new Date(now.getFullYear(), 0, 1);

  const employees = arr(ctx.data.employees).filter(e => inScope(e.department, scope));
  const hoursByCode = new Map();
  arr(ctx.data.trainings).filter(t => !isDeletedRec(t) && dateOf(t) >= yearStart).forEach(t => {
    const h = trainingHours(t);
    (t.attendees || []).forEach(a => {
      if (a.verified === false) return;
      const c = attCode(a);
      if (c) hoursByCode.set(c, (hoursByCode.get(c) || 0) + h);
    });
  });
  const hazByCode = new Map();
  const hazByName = new Map();
  arr(ctx.data.hazards).filter(h => !isDeletedRec(h) && !HAZ_REJECTED(h) && dateOf(h) >= yearStart).forEach(h => {
    const c = normCode(h.empCode);
    if (c) hazByCode.set(c, (hazByCode.get(c) || 0) + 1);
    const n = normName(h.reporterName);
    if (n) hazByName.set(n, (hazByName.get(n) || 0) + 1);
  });

  // الجزاءات النشطة من أول السنة — كل جزاء بيخصم من درجة الموظف (ونتيجة قسمه)
  const penByCode = new Map();
  arr(ctx.data.penalties).filter(p => p.status !== 'deleted' && p.status !== 'cancelled' && dateOf(p) >= yearStart).forEach(p => {
    const c = normCode(p.empCode);
    if (c) penByCode.set(c, (penByCode.get(c) || 0) + 1);
  });

  const rows = employees.map(e => {
    const code = normCode(e.empCode || e.code);
    const hrs = hoursByCode.get(code) || 0;
    const hz = hazByCode.get(code) || hazByName.get(normName(e.name)) || 0;
    const pen = penByCode.get(code) || 0;
    // درجة الموظف: نسبة إنجازه في التدريب والبلاغات ناقص خصم الجزاءات —
    // نفس أساس ترتيب "العامل المثالي" بالظبط، عشان القسم اللي عليه جزاءات
    // مايطلعش 100%. (تصحيح بطلب بشمهندس أحمد 12 سبتمبر 2026.)
    const trainPct = Math.min(100, Math.round((hrs / targetHours) * 100));
    const hazPct = Math.min(100, Math.round((hz / targetHazards) * 100));
    const score = Math.max(0, Math.round((trainPct + hazPct) / 2) - pen * PENALTY_DEDUCTION);
    return {
      emp: e, hours: hrs, hazards: hz, penalties: pen,
      trainOk: hrs >= targetHours, hazOk: hz >= targetHazards,
      trainPct, hazPct, score,
    };
  });
  return { rows, targetHours, targetHazards, quartersElapsed, penaltyDeduction: PENALTY_DEDUCTION, label: `الربع ${['الأول', 'الثاني', 'الثالث', 'الرابع'][quartersElapsed - 1]} ${now.getFullYear()}` };
}

function complianceAnswer(nq, ctx, scope) {
  const c = complianceData(ctx, scope);
  const total = c.rows.length;
  if (!total) return { reply: 'مفيش موظفين مسجّلين في النطاق ده.', source: SOURCE };
  const trainOk = c.rows.filter(r => r.trainOk).length;
  const hazOk = c.rows.filter(r => r.hazOk).length;

  // مين ناقصه؟
  if (/ناقص|مقصر|محققش|لسه|تحت التارجت|مش محقق|متاخر عن التارجت/.test(nq)) {
    const wantTrain = /تدريب|محاضر|ساعات/.test(nq) || !/بلاغ/.test(nq);
    const missing = c.rows.filter(r => (wantTrain ? !r.trainOk : !r.hazOk))
      .sort((a, b) => (wantTrain ? a.hours - b.hours : a.hazards - b.hazards));
    const head = wantTrain
      ? `⚠️ موظفين لسه تحت تارجت التدريب (${c.targetHours} ساعة لحد ${c.label}) — ${scopeLabel(scope, null)}: ${n2(missing.length)} من ${n2(total)}`
      : `⚠️ موظفين لسه تحت تارجت بلاغات الخطورة (${c.targetHazards} بلاغ لحد ${c.label}) — ${scopeLabel(scope, null)}: ${n2(missing.length)} من ${n2(total)}`;
    const lines = missing.slice(0, 10).map(r => `• ${r.emp.name} (${r.emp.empCode}) — ${r.emp.department} — ${wantTrain ? `${Math.round(r.hours * 10) / 10} ساعة` : arCount(r.hazards, 'بلاغ')}`);
    return {
      reply: `${head}\n${lines.join('\n')}${missing.length > 10 ? `\n… و${n2(missing.length - 10)} كمان (التفاصيل في تبويب "التدريب والتوعية").` : ''}`,
      source: SOURCE,
      suggestions: ['نسبة الالتزام لكل قسم', 'أحسن الأقسام التزامًا'],
    };
  }

  // ترتيب الأقسام — متوسط درجات الموظفين (تدريب + بلاغات − خصم الجزاءات)
  if ((WANT.breakdown.test(nq) || WANT.top.test(nq) || WANT.bottom.test(nq)) && !scope.depts.length) {
    const byDept = new Map();
    c.rows.forEach(r => {
      const d = String(r.emp.department || 'غير محدد').trim();
      if (!byDept.has(d)) byDept.set(d, { d, n: 0, t: 0, h: 0, sum: 0, pen: 0 });
      const b = byDept.get(d);
      b.n++; b.sum += r.score; b.pen += r.penalties;
      if (r.trainOk) b.t++; if (r.hazOk) b.h++;
    });
    let rows = [...byDept.values()].filter(b => b.n >= 3).map(b => ({
      ...b, score: Math.round(b.sum / b.n),
    })).sort((a, b) => b.score - a.score);
    const worst = WANT.bottom.test(nq);
    if (worst) rows = rows.slice().reverse();
    return {
      reply: `🏆 ${worst ? 'أقل' : 'أحسن'} الأقسام التزامًا بالأهداف — ${c.label}\n(المعيار: تدريب ${c.targetHours}س + ${arCount(c.targetHazards, 'بلاغ')} لكل موظف، وكل جزاء بيخصم ${c.penaltyDeduction} نقطة)\n${rows.slice(0, 10).map((b, i) => `${i + 1}) ${b.d}: ${b.score}% — تدريب ${pct(b.t, b.n)}% · بلاغات ${pct(b.h, b.n)}%${b.pen ? ` · ${arCount(b.pen, 'جزاء')} ⚖️` : ''} (${arCount(b.n, 'موظف')})`).join('\n')}`,
      source: SOURCE,
      suggestions: ['مين ناقصه تدريب؟', 'نسبة الالتزام الكلية', 'الجزاءات حسب القسم'],
    };
  }

  const avgScore = Math.round(c.rows.reduce((s, r) => s + r.score, 0) / total);
  const withPen = c.rows.filter(r => r.penalties).length;
  const penTotal = c.rows.reduce((s, r) => s + r.penalties, 0);
  return {
    reply: [
      `🎯 نسبة الالتزام بالأهداف — ${scopeLabel(scope, null)} · ${c.label}`,
      `• التارجت لحد دلوقتي: ${c.targetHours} ساعة تدريب و${arCount(c.targetHazards, 'بلاغ')} خطورة لكل موظف (من أول السنة).`,
      `• حققوا تارجت التدريب: ${n2(trainOk)} من ${n2(total)} (${pct(trainOk, total)}%)`,
      `• حققوا تارجت البلاغات: ${n2(hazOk)} من ${n2(total)} (${pct(hazOk, total)}%)`,
      penTotal ? `• جزاءات السنة دي: ${arCount(penTotal, 'جزاء')} على ${arCount(withPen, 'موظف')} (كل جزاء بيخصم ${c.penaltyDeduction} نقطة)` : '',
      `• الدرجة الكلية للنطاق ده: ${avgScore}%`,
    ].filter(Boolean).join('\n'),
    source: SOURCE,
    suggestions: ['أحسن الأقسام التزامًا', 'أقل الأقسام التزامًا', 'مين ناقصه تدريب؟'],
  };
}

// ── الفحص الشهري (P1 / P2) ───────────────────────────────────────
const AR_MONTH_NAMES = MONTHS;
const INSP_STATUS_ICON = { 'مطابق': '✅', 'غير مطابق': '⛔' };
// كلمات عامة مش بتفرق في البحث عن صنف معيّن
const INSP_NOISE = new Set(['الفحص', 'فحص', 'الشهري', 'الشهريه', 'شهر', 'في', 'عن', 'اللي', 'الي', 'حاله', 'حالة', 'نتيجه', 'نتيجة', 'ايه', 'كام', 'عدد', 'كان', 'بقي', 'ازاي', 'وضع', 'وضعها', 'مكان', 'المكان', 'برنامج', 'p1', 'p2', 'b1', 'b2', 'الي', 'بتاع', 'بتاعه', 'بتاعت']);

/** البرنامج المذكور في السؤال: P1/P2 — والناس بتسميهم كمان B1/B2 */
function detectInspectionCategory(nq) {
  if (/(^|\s)(p\s*2|b\s*2|بي 2|بي2|برنامج 2|المبني 2|مبني 2)(\s|$)/.test(nq)) return 'P2';
  if (/(^|\s)(p\s*1|b\s*1|بي 1|بي1|برنامج 1|المبني 1|مبني 1)(\s|$)/.test(nq)) return 'P1';
  return null;
}

/** قسم الفحص المذكور في السؤال ("طفايات الحريق" / "الطفاية" / "الكليفت") */
function matchInspectionSection(nq, sections, cat) {
  const pool = cat ? sections.filter(s => s.category === cat) : sections;
  const scored = pool.map(s => {
    const words = normalizeArabic(s.name || '').split(' ').filter(w => w.length >= 3);
    if (!words.length) return { s, hits: 0 };
    let hits = 0;
    words.forEach(w => {
      const stem = w.slice(0, Math.max(4, w.length - 2)); // "طفايات" → "طفاي" عشان "الطفاية" تتلقط
      if (nq.includes(w) || nq.includes(stem)) hits++;
    });
    return { s, hits: hits / words.length };
  }).sort((a, b) => b.hits - a.hits);
  return scored[0] && scored[0].hits >= 0.5 ? scored[0].s : null;
}

/** يدوّر على صنف فحص بعينه بالاسم/المكان/الرقم */
function findInspectionItems(nq, items, sectionIds) {
  const words = nq.split(' ').map(w => w.trim()).filter(w => w.length >= 2 && !INSP_NOISE.has(w) && !STOP.has(w));
  if (!words.length) return [];
  const pool = sectionIds ? items.filter(i => sectionIds.has(i.sectionId)) : items;
  const scored = pool.map(it => {
    const hay = normalizeArabic(`${it.name || ''} ${it.location || ''} ${it.department || ''} ${it.itemNumber || ''}`);
    let hits = 0;
    words.forEach(w => { if (hay.includes(w)) hits++; });
    return { it, hits };
  }).filter(x => x.hits > 0).sort((a, b) => b.hits - a.hits);
  if (!scored.length) return [];
  const best = scored[0].hits;
  return scored.filter(x => x.hits === best).map(x => x.it).slice(0, 6);
}

function inspectionsAnswer(nq, ctx, period) {
  const sections = arr(ctx.data.inspectionSections);
  const items = arr(ctx.data.inspectionItems);
  const records = arr(ctx.data.inspectionRecords);
  if (!sections.length) return { reply: 'مفيش بيانات فحص شهري مسجّلة لحد دلوقتي.', source: SOURCE };

  const now = new Date();
  let year = now.getFullYear(), month = now.getMonth() + 1;
  if (period) { year = period.from.getFullYear(); month = period.from.getMonth() + 1; }
  const cat = detectInspectionCategory(nq);
  const secPool = cat ? sections.filter(s => s.category === cat) : sections;
  const matchedSection = matchInspectionSection(nq, sections, cat);

  // سؤال عن صنف بعينه ("الطفاية اللي في غرفة السيرفرات في أغسطس")
  const sectionIds = matchedSection ? new Set([matchedSection.id]) : (cat ? new Set(secPool.map(s => s.id)) : null);
  const hits = findInspectionItems(nq, items, sectionIds);
  const askingItem = hits.length && (matchedSection || cat || /غرفه|مكان|جنب|امام|داخل|رقم/.test(nq));
  if (askingItem) {
    const secById = new Map(sections.map(s => [s.id, s]));
    const lines = hits.map(it => {
      const recs = records.filter(r => r.itemId === it.id).sort((a, b) => (b.year * 12 + b.month) - (a.year * 12 + a.month));
      const wanted = period ? recs.find(r => r.year === year && r.month === month) : recs[0];
      const sec = secById.get(it.sectionId);
      const where = [it.location, it.department].filter(Boolean).join(' — ');
      const head = `• ${it.name || `${sec ? sec.name : ''} #${it.itemNumber}`}${it.itemNumber ? ` (رقم ${it.itemNumber})` : ''}${where ? ` — ${where}` : ''}`;
      if (!wanted) {
        return `${head}\n   ${period ? `مفيش فحص مسجّل لـ ${AR_MONTH_NAMES[month - 1]} ${year}` : 'لسه مفيش فحص مسجّل'}${recs.length ? ` (آخر فحص: ${AR_MONTH_NAMES[recs[0].month - 1]} ${recs[0].year} — ${recs[0].status})` : ''}`;
      }
      return `${head}\n   ${AR_MONTH_NAMES[wanted.month - 1]} ${wanted.year}: ${wanted.status} ${INSP_STATUS_ICON[wanted.status] || ''}${wanted.notes ? ` — ${short(wanted.notes, 80)}` : ''}${wanted.inspector ? ` · الفاحص: ${wanted.inspector}` : ''}${wanted.inspectionDate ? ` · ${fmtDate(wanted.inspectionDate)}` : ''}`;
    });
    const secName = matchedSection ? `${matchedSection.name} (${matchedSection.category})` : (cat ? `برنامج ${cat}` : 'الفحص الشهري');
    return {
      reply: `🔍 ${secName}:\n${lines.join('\n')}${hits.length >= 6 ? '\n… فيه أصناف تانية قريبة من وصفك، حدّد المكان أكتر.' : ''}`,
      source: SOURCE,
      suggestions: ['الأصناف غير المطابقة', 'نسبة المطابقة الشهر ده'],
    };
  }

  const secIn = matchedSection ? [matchedSection] : secPool;
  const secIds = new Set(secIn.map(s => s.id));
  const itemsIn = items.filter(i => secIds.has(i.sectionId));
  const scopedRecords = records.filter(r => secIds.has(r.sectionId));
  let recsIn = scopedRecords.filter(r => r.year === year && r.month === month);
  // لو الشهر الحالي لسه مفيهوش نتايج، نعرض آخر شهر اتفحص فعلاً
  if (!recsIn.length && !period) {
    const latest = scopedRecords.slice().sort((a, b) => (b.year * 12 + b.month) - (a.year * 12 + a.month))[0];
    if (latest) {
      year = latest.year; month = latest.month;
      recsIn = scopedRecords.filter(r => r.year === year && r.month === month);
    }
  }
  const okCount = recsIn.filter(r => r.status === 'مطابق').length;
  const badCount = recsIn.filter(r => r.status === 'غير مطابق').length;
  const done = okCount + badCount;
  const label = `${AR_MONTH_NAMES[month - 1]} ${year}`;
  const scopeName = matchedSection ? `${matchedSection.name} (${matchedSection.category})` : (cat ? `برنامج ${cat}` : '');

  if (badCount && /غير مطابق|غير المطابق|مشاكل|ملاحظات|مخالف/.test(nq)) {
    const itemById = new Map(itemsIn.map(i => [i.id, i]));
    const bad = recsIn.filter(r => r.status === 'غير مطابق').slice(0, 10);
    return {
      reply: `🔍 أصناف غير مطابقة في فحص ${label}${scopeName ? ` — ${scopeName}` : ''}: ${n2(badCount)}\n${bad.map(r => { const it = itemById.get(r.itemId) || {}; return `• ${it.name || r.itemId}${it.itemNumber ? ` (رقم ${it.itemNumber})` : ''} — ${it.location || it.department || '—'}${r.notes ? ` — ${short(r.notes, 70)}` : ''}`; }).join('\n')}${badCount > 10 ? `\n… و${n2(badCount - 10)} كمان.` : ''}`,
      source: SOURCE,
      suggestions: ['نسبة المطابقة', 'الفحص الشهري'],
    };
  }

  return {
    reply: [
      `🔍 الفحص الشهري${scopeName ? ` — ${scopeName}` : ''} · ${label}`,
      `• عدد الأقسام: ${n2(secIn.length)} · عدد الأصناف: ${n2(itemsIn.length)}`,
      `• اتفحص الشهر ده: ${n2(done)} صنف${itemsIn.length ? ` (${pct(done, itemsIn.length)}% من الأصناف)` : ''}`,
      `• مطابق: ${n2(okCount)} · غير مطابق: ${n2(badCount)}`,
      done ? `• نسبة المطابقة: ${pct(okCount, done)}%` : '• لسه مفيش نتايج مسجّلة للشهر ده',
    ].join('\n'),
    source: SOURCE,
    suggestions: ['الأصناف غير المطابقة', 'فحص P2', 'كام بلاغ مفتوح؟'],
  };
}

// ── الملخص العام ─────────────────────────────────────────────────
function summaryAnswer(ctx, scope, period) {
  const d = dataFor(ctx, scope, period);
  const open = d.hazards.filter(HAZ_OPEN);
  const overdue = open.filter(h => Date.now() - dateOf(h).getTime() > HOURS_48);
  const pending = d.permits.filter(PERMIT_PENDING);
  const month = new Date().getMonth(), year = new Date().getFullYear();
  const thisMonth = d.hazards.filter(h => { const x = dateOf(h); return x.getMonth() === month && x.getFullYear() === year; });
  const c = complianceData(ctx, scope);
  const trainOk = c.rows.filter(r => r.trainOk).length;
  return {
    reply: [
      `📊 ملخص ${scopeLabel(scope, period)}:`,
      `• بلاغات الخطورة: ${n2(d.hazards.length)} — مفتوح ${n2(open.length)}${overdue.length ? ` (منهم ${n2(overdue.length)} عدّى عليهم 48 ساعة ⚠️)` : ''}`,
      `• بلاغات الشهر ده: ${n2(thisMonth.length)}`,
      `• تصاريح العمل: ${n2(d.permits.length)} — مستني اعتماد ${n2(pending.length)}`,
      `• التدريب: ${n2(d.trainings.length)} محاضرة · ${n2(d.trainings.reduce((s, t) => s + (t.attendees || []).length, 0))} حضور`,
      `• تجارب الطوارئ: ${n2(d.drills.length)} · الجزاءات: ${n2(d.penalties.length)}`,
      c.rows.length ? `• الالتزام بتارجت التدريب: ${pct(trainOk, c.rows.length)}% من ${arCount(c.rows.length, 'موظف')}` : '',
      overdue.length ? `\nأقدم البلاغات المتأخرة:\n${overdue.sort((a, b) => dateOf(a) - dateOf(b)).slice(0, 5).map(h => `• ${h.id} — ${h.department || '—'} — ${fmtDate(h.date || h.submittedAt)}`).join('\n')}` : '',
    ].filter(Boolean).join('\n'),
    source: SOURCE,
    suggestions: ['آخر بلاغ مفتوح', 'بلاغات عالية الخطورة', 'تصاريح مستنية اعتماد', 'نسبة الالتزام لكل قسم'],
  };
}

// ── نقطة الدخول ──────────────────────────────────────────────────
const SUMMARY_RE = /ملخص|الوضع ايه|الوضع عامل ايه|احوال المصنع|نظره عامه|overview|dashboard|الداشبورد|تقرير سريع|كل حاجه/;

/** نص متطبّع بمسافات على الأطراف وبدون علامات ترقيم — عشان مقارنة الكلمات بحدودها */
function cleanQ(question) {
  return ' ' + normalizeArabic(question).replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim() + ' ';
}

function answerAnalytics(question, ctx) {
  const role = ctx.user && ctx.user.role;
  if (!ADMIN_ROLES.includes(role)) return null;
  const nq = cleanQ(question);
  const scope = scopeOf(ctx, nq);
  const period = detectPeriod(nq);

  if (SUMMARY_RE.test(nq)) return withScopeNote(summaryAnswer(ctx, scope, period), scope);

  // سؤال عن موظف بالاسم أو بالكود ("سجل مدحت يونس" / "بيانات الموظف 5504")
  if (/بيانات|ملف|سجل|مين هو|عايز اعرف|الموظف|العامل/.test(nq)) {
    const emp = detectEmployee(question, ctx);
    if (emp) return employeeProfileAnswer(emp, ctx, scope);
  }

  let entity = detectEntity(nq);
  // سؤال عن الفحص الشهري من غير ما يقول "فحص": ذكر البرنامج (B1/B2) أو اسم
  // قسم فحص + مكان/رقم صنف موجود فعلاً في سجلات الفحص.
  if (!entity) {
    const inspSections = arr(ctx.data.inspectionSections);
    if (inspSections.length) {
      const cat = detectInspectionCategory(nq);
      const sec = matchInspectionSection(nq, inspSections, cat);
      if (cat) entity = 'inspections';
      else if (sec) {
        const ids = new Set([sec.id]);
        const hit = findInspectionItems(nq, arr(ctx.data.inspectionItems), ids);
        if (hit.length || /فحص|مطابق|حاله|صالح|تالف|اخر فحص|رقم \d/.test(nq)) entity = 'inspections';
      }
    }
  }
  // متابعة للسؤال اللي قبله ("وفي القسم كله؟" / "والشهر اللي فات؟") — بناخد
  // نفس موضوع آخر إجابة لو السؤال الجديد مفيهوش موضوع بس فيه نطاق أو فترة.
  const prev = ctx.context && ctx.context.lastEntity;
  if (!entity && prev && (scope.depts.length || period || WANT.count.test(nq) || WANT.list.test(nq) || WANT.breakdown.test(nq))) {
    entity = prev;
  }
  if (!entity) return null;
  // "مين ناقصه تدريب / مين مقصر في البلاغات" → طبقة الالتزام بالأهداف
  if (MISSING_RE.test(nq) && (entity === 'trainings' || entity === 'hazards' || entity === 'employees')) entity = 'compliance';

  // سؤال عن موظف بعينه (بالاسم أو الكود) → ملف الموظف الكامل
  if (entity === 'employees' || /بيانات|ملف|سجل/.test(nq)) {
    const emp = detectEmployee(question, ctx);
    if (emp) return employeeProfileAnswer(emp, ctx, scope);
  }

  let answer = null;
  switch (entity) {
    case 'hazards': answer = hazardsAnswer(nq, ctx, scope, period, question); break;
    case 'permits': answer = permitsAnswer(nq, ctx, scope, period, question); break;
    case 'trainings': answer = trainingsAnswer(nq, ctx, scope, period); break;
    case 'drills': answer = drillsAnswer(nq, ctx, scope, period); break;
    case 'penalties': answer = penaltiesAnswer(nq, ctx, scope, period); break;
    case 'employees': answer = employeesAnswer(nq, ctx, scope); break;
    case 'compliance': answer = complianceAnswer(nq, ctx, scope); break;
    case 'inspections': answer = inspectionsAnswer(nq, ctx, period); break;
    default: answer = null;
  }
  // بنرجّع الموضوع مع الرد عشان السؤال اللي بعده يقدر يكمّل عليه
  return answer ? withScopeNote({ ...answer, topic: { entity, depts: scope.depts } }, scope) : null;
}

/** أسئلة الإدارة اللي العامل مش المفروض يشوفها (عشان نرد عليه رد لطيف) */
function isAdminDataQuestion(question) {
  const nq = cleanQ(question);
  if (SUMMARY_RE.test(nq)) return true;
  const entity = detectEntity(nq);
  if (!entity) return false;
  // العامل ليه أسئلته الشخصية — الممنوع هو الأرقام العامة
  const generalWord = WANT.count.test(nq) || WANT.list.test(nq) || WANT.breakdown.test(nq) || WANT.top.test(nq) || WANT.latest.test(nq);
  const mine = /بتاعي|بتاعتي|عندي|ليا|حضرتها|عملتها|سجلي|انا/.test(nq);
  return generalWord && !mine;
}

module.exports = { answerAnalytics, isAdminDataQuestion, complianceData, ADMIN_ROLES };
