// ============================================================
// lib/chatbot-personal.js — "بياناتي": محاضراتي، التارجت، بلاغاتي، تصاريحي،
// جزاءاتي، تجارب الطوارئ اللي حضرتها + ملخص سريع للإدارة
// ============================================================
// الهوية دايمًا من جلسة المستخدم (ctx.user اللي السيرفر بيبنيه من التوكن)،
// عمره ما بياخد كود موظف من نص السؤال — فمحدش يقدر يسأل عن بيانات حد تاني.
'use strict';

const { normalizeArabic, arCount } = require('./chatbot-kb');

const TRAIN_TARGET = 8;   // ساعات تدريب في السنة (نفس تارجت لوحة التحكم)
const HAZARD_TARGET = 2;  // بلاغات خطورة في السنة
const ADMIN_ROLES = ['super_admin', 'hse_admin', 'dept_admin', 'maint_admin', 'ceo'];

const normCode = v => String(v == null ? '' : v).trim().replace(/^0+/, '').toUpperCase();
const normName = v => normalizeArabic(v).replace(/\s+/g, ' ').trim();
const num = n => (Math.round(n * 10) / 10).toLocaleString('en-US');
const short = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
function fmtDate(d) {
  const x = new Date(d);
  return isNaN(x) ? String(d || '—') : x.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
}
function trainingHours(t) {
  for (const k of ['durationHours', 'hours', 'duration']) {
    const v = t[k];
    if (v !== undefined && v !== null && v !== '' && !isNaN(Number(v))) return Number(v);
  }
  return t.durationMinutes ? Number(t.durationMinutes) / 60 : 0.5;
}
const attCode = a => normCode(a && (a.empCode || a.code || a.employeeCode || a.id));
const dateOf = x => new Date(x.date || x.submittedAt || x.createdAt || 0);

const HAZARD_STATUS = {
  open: 'مفتوح ⏳', in_progress: 'جاري التعامل معاه 🔧', resolved: 'اتحل ✅', closed: 'مغلق ✅',
  rejected: 'مرفوض ❌', rejected_by_maintenance: 'مرفوض من الصيانة ❌', pending_maintenance: 'محوّل للصيانة 🛠️',
};
const PERMIT_STATUS = {
  pending: 'بانتظار أدمن القسم ⏳', pending_dept: 'بانتظار أدمن القسم ⏳', pending_area_head: 'بانتظار أدمن القسم ⏳',
  pending_hse: 'بانتظار اعتماد السلامة ⏳', approved: 'معتمد ✅', rejected: 'مرفوض ❌',
  closed_safe: 'اتقفل بأمان 🔒', closed_incomplete: 'اتقفل (لم يكتمل) 🔒', closed_forced: 'إغلاق جبري 🔒',
};
const statusLabel = (map, s) => map[s] || s || '—';

function arr(fn) { try { const v = typeof fn === 'function' ? fn() : []; return Array.isArray(v) ? v : []; } catch { return []; } }

function meFrom(ctx) {
  const code = normCode(ctx.user && ctx.user.empCode);
  if (!code) return null;
  const emp = arr(ctx.data.employees).find(e => normCode(e.empCode || e.code) === code) || {};
  return { code, name: emp.name || (ctx.user && ctx.user.name) || '', department: emp.department || (ctx.user && ctx.user.department) || '', jobTitle: emp.jobTitle || '' };
}

function myHazardsList(ctx, me) {
  const n = normName(me.name);
  return arr(ctx.data.hazards)
    .filter(h => !h.deleted && !(h.deletedBy && h.deletedBy.worker))
    .filter(h => normCode(h.empCode) === me.code || (!h.empCode && n && normName(h.reporterName) === n))
    .sort((a, b) => dateOf(b) - dateOf(a));
}

function myTrainingsList(ctx, me) {
  return arr(ctx.data.trainings)
    .filter(t => !t.isDeleted && !t.deletedAt)
    .map(t => { const a = (t.attendees || []).find(x => attCode(x) === me.code); return a ? { t, a } : null; })
    .filter(Boolean)
    .sort((x, y) => dateOf(y.t) - dateOf(x.t));
}

// ── الردود ───────────────────────────────────────────────────────
function trainingsReply(ctx, me) {
  const list = myTrainingsList(ctx, me);
  if (!list.length) return { reply: '🎓 مفيش محاضرات مسجّل حضورك فيها لحد دلوقتي. لما تحضر محاضرة وتسجّل بالرمز (PIN) هتظهر هنا.', suggestions: ['التارجت بتاعي', 'فيه محاضرة شغالة؟'] };
  const year = new Date().getFullYear();
  const verified = list.filter(x => x.a.verified !== false);
  const ytd = verified.filter(x => dateOf(x.t).getFullYear() === year);
  const hAll = verified.reduce((s, x) => s + trainingHours(x.t), 0);
  const hYtd = ytd.reduce((s, x) => s + trainingHours(x.t), 0);
  const lines = list.slice(0, 12).map(x => `• ${fmtDate(x.t.date || x.t.createdAt)} — ${x.t.title || x.t.topic || 'محاضرة'} (${num(trainingHours(x.t))} س)${x.a.verified === false ? ' — ⏳ لسه متأكدتش' : ''}`);
  return {
    reply: `🎓 حضرت ${arCount(list.length, 'محاضرة')} (${arCount(hAll, 'ساعة')} مؤكدة).\nالسنة دي: ${arCount(ytd.length, 'محاضرة')} = ${arCount(hYtd, 'ساعة')} من تارجت ${arCount(TRAIN_TARGET, 'ساعة')}.\n\nآخر المحاضرات:\n${lines.join('\n')}${list.length > 12 ? `\n… و${arCount(list.length - 12, 'محاضرة')} أقدم.` : ''}`,
    suggestions: ['التارجت بتاعي', 'بلاغاتي'],
  };
}

function targetsReply(ctx, me) {
  const year = new Date().getFullYear();
  const hours = myTrainingsList(ctx, me).filter(x => x.a.verified !== false && dateOf(x.t).getFullYear() === year)
    .reduce((s, x) => s + trainingHours(x.t), 0);
  const hz = myHazardsList(ctx, me).filter(h => dateOf(h).getFullYear() === year && !/^rejected/.test(h.status || '')).length;
  const q = Math.floor(new Date().getMonth() / 3) + 1;
  const qHours = (TRAIN_TARGET / 4) * q;
  const qHz = Math.ceil((HAZARD_TARGET / 4) * q);
  const pct = (v, t) => Math.min(100, Math.round((v / t) * 100));
  const onTrack = hours >= qHours && hz >= qHz;
  return {
    reply: [
      `🎯 تارجتك السنة دي (من أول يناير):`,
      `• التدريب: ${num(hours)} من ${arCount(TRAIN_TARGET, 'ساعة')} (${pct(hours, TRAIN_TARGET)}%) — ${hours >= TRAIN_TARGET ? 'حققت التارجت 👏' : `فاضلك ${arCount(TRAIN_TARGET - hours, 'ساعة')}`}`,
      `• بلاغات الخطورة: ${hz} من ${HAZARD_TARGET} (${pct(hz, HAZARD_TARGET)}%) — ${hz >= HAZARD_TARGET ? 'حققت التارجت 👏' : `فاضلك ${arCount(HAZARD_TARGET - hz, 'بلاغ')}`}`,
      ``,
      `📅 المطلوب لحد الربع الـ${q}: ${arCount(qHours, 'ساعة')} تدريب و${arCount(qHz, 'بلاغ')} — ${onTrack ? 'إنت ماشي في المعاد ✅' : 'محتاج تلحق شوية ⏳'}`,
    ].join('\n'),
    source: 'بياناتك على المنصة (المحاضرات وبلاغات الخطورة)',
    suggestions: ['محاضراتي', 'بلاغاتي'],
  };
}

function hazardsReply(ctx, me, question) {
  const idm = String(question).match(/hz-?\s?(\d{4})-?\s?(\d{3,5})/i);
  const all = arr(ctx.data.hazards);
  if (idm) {
    const id = `HZ-${idm[1]}-${idm[2]}`.toUpperCase();
    const h = all.find(x => String(x.id).toUpperCase() === id);
    const isAdmin = ADMIN_ROLES.includes(ctx.user && ctx.user.role);
    if (!h || (!isAdmin && normCode(h.empCode) !== me.code)) return { reply: `مش لاقي بلاغ برقم ${id} في بلاغاتك.` };
    return {
      reply: `🔎 بلاغ ${h.id}\n• الحالة: ${statusLabel(HAZARD_STATUS, h.status)}\n• التاريخ: ${fmtDate(h.date || h.submittedAt)}\n• المكان: ${h.area || '—'} (${h.department || '—'})\n• الوصف: ${short(h.description, 300)}\n• مستوى الخطورة: ${h.riskLevel || '—'}${h.actionTaken ? `\n• الإجراء اللي اتعمل: ${short(h.actionTaken, 300)}` : ''}`,
    };
  }
  const mine = myHazardsList(ctx, me);
  if (!mine.length) return { reply: '📋 مفيش بلاغات خطورة باسمك لحد دلوقتي. لو شفت خطر في أي مكان بلّغ عنه من تبويب "الإبلاغ عن خطورة" — ده بيحسب في التارجت بتاعك.', suggestions: ['التارجت بتاعي'] };
  const counts = {};
  mine.forEach(h => { const l = statusLabel(HAZARD_STATUS, h.status); counts[l] = (counts[l] || 0) + 1; });
  const lines = mine.slice(0, 10).map(h => `• ${h.id} — ${fmtDate(h.date || h.submittedAt)} — ${short(h.area || h.department, 30)}: ${short(h.description, 60)} — ${statusLabel(HAZARD_STATUS, h.status)}`);
  return {
    reply: `📋 سجل بلاغاتك: ${arCount(mine.length, 'بلاغ')} (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join('، ')})\n\n${lines.join('\n')}${mine.length > 10 ? `\n… و${arCount(mine.length - 10, 'بلاغ')} أقدم.` : ''}`,
    suggestions: ['التارجت بتاعي', 'محاضراتي'],
  };
}

function permitsReply(ctx, me, question) {
  const mine = arr(ctx.data.permits).filter(p => normCode(p.employeeId) === me.code).sort((a, b) => dateOf(b) - dateOf(a));
  const idm = String(question).match(/wp-?\s?(\d{4})-?\s?(\d{3,5})/i);
  if (idm) {
    const id = `WP-${idm[1]}-${idm[2]}`.toUpperCase();
    const p = mine.find(x => String(x.id).toUpperCase() === id);
    if (!p) return { reply: `مش لاقي تصريح برقم ${id} في تصاريحك.` };
    return { reply: `🔎 تصريح ${p.id} — ${p.typeFullLabel || p.typeLabel || ''}\n• الحالة: ${statusLabel(PERMIT_STATUS, p.status)}\n• التاريخ: ${p.date || fmtDate(p.submittedAt)} (${p.timeFrom || ''} → ${p.timeTo || ''})\n• المكان: ${p.location || '—'}\n• الوصف: ${short(p.description, 250)}${p.reviewNote ? `\n• ملاحظة المراجع: ${p.reviewNote}` : ''}` };
  }
  if (!mine.length) return { reply: '📝 مفيش تصاريح عمل مقدّمة باسمك. تقدر تقدّم طلب من تبويب "تصاريح العمل".' };
  const lines = mine.slice(0, 10).map(p => `• ${p.id} — ${p.typeLabel || ''} — ${p.date || fmtDate(p.submittedAt)} — ${short(p.location, 30)} — ${statusLabel(PERMIT_STATUS, p.status)}`);
  return { reply: `📝 تصاريحك: ${arCount(mine.length, 'طلب')}\n\n${lines.join('\n')}${mine.length > 10 ? `\n… و${arCount(mine.length - 10, 'طلب')} أقدم.` : ''}` };
}

function penaltiesReply(ctx, me) {
  const mine = arr(ctx.data.penalties).filter(p => p.status !== 'deleted' && normCode(p.empCode) === me.code).sort((a, b) => dateOf(b) - dateOf(a));
  if (!mine.length) return { reply: '⚖️ مفيش جزاءات مسجّلة عليك — استمر كده 👏' };
  return { reply: `⚖️ الجزاءات المسجّلة عليك: ${arCount(mine.length, 'جزاء')}\n${mine.slice(0, 10).map(p => `• ${fmtDate(p.date || p.createdAt)} — ${short(p.reason, 120)}`).join('\n')}` };
}

function drillsReply(ctx, me) {
  const list = arr(ctx.data.drills).filter(d => !d.isDeleted && (d.attendees || []).some(a => attCode(a) === me.code)).sort((a, b) => dateOf(b) - dateOf(a));
  if (!list.length) return { reply: '🚨 مفيش تجارب طوارئ مسجّل حضورك فيها لحد دلوقتي.' };
  return { reply: `🚨 حضرت ${arCount(list.length, 'تجربة طوارئ')}:\n${list.slice(0, 10).map(d => `• ${fmtDate(d.date || d.createdAt)} — ${d.title || 'تجربة طوارئ'}${d.location ? ` (${d.location})` : ''}`).join('\n')}` };
}

function profileReply(ctx, me) {
  return {
    reply: `👤 بياناتك على المنصة:\n• الاسم: ${me.name || '—'}\n• الكود الوظيفي: ${me.code}\n• القسم: ${me.department || '—'}\n• الوظيفة: ${me.jobTitle || '—'}\n\nتقدر تسألني عن: محاضراتك، التارجت بتاعك، بلاغاتك، تصاريحك، أو جزاءاتك.`,
    suggestions: ['التارجت بتاعي', 'مين مدير قسمي؟'],
  };
}

function activeTrainingReply(ctx) {
  const all = arr(ctx.data.trainings).filter(t => !t.isDeleted && !t.deletedAt);
  const active = all.filter(t => t.status === 'active');
  if (active.length) {
    return { reply: `🟢 فيه محاضرة شغالة دلوقتي:\n${active.map(t => `• ${t.title || t.topic}${t.location ? ` — ${t.location}` : ''}${t.trainer ? ` — المحاضر: ${t.trainer}` : ''}`).join('\n')}\n\nسجّل حضورك من تبويب "التدريب والتوعية" بالرمز (PIN) اللي بيقوله المحاضر.` };
  }
  const last = all.sort((a, b) => dateOf(b) - dateOf(a))[0];
  return { reply: `مفيش محاضرة شغالة دلوقتي.${last ? `\nآخر محاضرة اتعملت: ${last.title || last.topic} (${fmtDate(last.date || last.createdAt)}).` : ''}\nأول ما محاضرة تبدأ هيوصلك إشعار على المنصة.` };
}

// ── اكتشاف النية ─────────────────────────────────────────────────
const FIRST = /(^|\s)(انا|ليا|عندي|عليا|بتاعي|بتاعتي|بتوعي|سجلي|حسابي)(\s|$)|حضرت|حضرتها|حضرته|حضوري|بلغت|عملته|عملتها|قدمته|قدمتها/;
const INTENTS = [
  { key: 'targets', re: /تارجت|تارجيت|target|هدفي|اهدافي|نسبتي|فاضلي|ناقصني|فاضل لي|باقي لي|المطلوب مني/ },
  { key: 'trainings', re: /محاضراتي|تدريباتي|كورساتي|ساعاتي/, needsFirst: /محاضر|تدريب|كورس|سيشن/ },
  { key: 'hazards', re: /بلاغاتي|سجل الهازارد|سجل البلاغات|hz-?\s?\d{4}/, needsFirst: /بلاغ|هازارد|hazard|هزارد|خطور/ },
  { key: 'permits', re: /تصاريحي|تصريحي|طلباتي|wp-?\s?\d{4}/, needsFirst: /تصريح|تصاريح|طلب عمل/ },
  // النص متطبّع (الهمزة بتتشال): "جزاءاتي" → "جزااتي"
  { key: 'penalties', re: /جزااتي|جزاياتي|جزاتي|عليا جزا|جزاات عليا|عندي جزا/, needsFirst: /جزا|عقوب|انذار|خصم/ },
  { key: 'drills', re: /تجاربي/, needsFirst: /تجربه|تجارب|درل|drill/ },
  { key: 'profile', re: /بياناتي|انا مين|الكود بتاعي|كودي|وظيفتي|انا في قسم ايه|قسمي ايه|معلوماتي/ },
  { key: 'active', re: /محاضره (شغاله|دلوقتي|النهارده|الجايه)|امتي المحاضره|فيه محاضره|في محاضره/ },
];

// سؤال بيتكلم عن القسم أو المصنع كله مش سؤال شخصي — حتى لو فيه "بتاعي"
// ("كام بلاغ في القسم بتاعي" لازم تروح لطبقة أرقام الإدارة مش لبلاغاتي).
const SCOPE_WORDS = /(^|\s)(قسمي|قسمى|قسمنا|القسم|قسم|المصنع|الشركه|الموظفين|العمال|الفرع|الاقسام)(\s|$)/;
const OWN_DEPT_QUESTION = /انا في قسم ايه|قسمي ايه|قسمى ايه|انا قسم ايه|قسمي فين/;

function detectPersonal(question) {
  const nq = normalizeArabic(question);
  if (SCOPE_WORDS.test(nq) && !OWN_DEPT_QUESTION.test(nq)) return null;
  for (const it of INTENTS) {
    if (it.re.test(nq)) return it.key;
    if (it.needsFirst && it.needsFirst.test(nq) && FIRST.test(nq)) return it.key;
  }
  return null;
}

/** رد على أسئلة "بياناتي" أو null لو السؤال مش شخصي */
function answerPersonal(question, ctx) {
  const intent = detectPersonal(question);
  if (!intent) return null;
  if (intent === 'active') return activeTrainingReply(ctx);
  const me = meFrom(ctx);
  if (!me) return { reply: 'عشان أشوف بياناتك لازم تكون داخل بحسابك على المنصة (كودك الوظيفي).', source: null };
  const handlers = { trainings: trainingsReply, targets: targetsReply, hazards: hazardsReply, permits: permitsReply, penalties: penaltiesReply, drills: drillsReply, profile: profileReply };
  const r = handlers[intent](ctx, me, question);
  return { source: 'بياناتك على المنصة', ...r };
}

// ── ملخص سريع للإدارة (نفس نطاق كل دور: أدمن القسم = قسمه بس) ──────
const STATS_WORD = /كام بلاغ|البلاغات المفتوحه|بلاغات مفتوحه|بلاغات متاخره|المتاخره|48|ملخص|احصاي|الوضع ايه|كام تصريح|تصاريح (مستنيه|مستني|منتظره|معلقه)|تصاريح محتاجه/;
function answerAdminStats(question, ctx) {
  const role = ctx.user && ctx.user.role;
  if (!ADMIN_ROLES.includes(role) || !STATS_WORD.test(normalizeArabic(question))) return null;
  const dept = (role === 'dept_admin' || role === 'maint_admin') ? String(ctx.user.department || '') : '';
  const inScope = x => !dept || x.department === dept;
  const hazards = arr(ctx.data.hazards).filter(h => !h.deleted && inScope(h));
  const open = hazards.filter(h => h.status === 'open');
  const inProgress = hazards.filter(h => h.status === 'in_progress');
  const overdue = open.filter(h => Date.now() - dateOf(h).getTime() > 48 * 3600 * 1000);
  const pending = arr(ctx.data.permits).filter(p => inScope(p) && /^pending/.test(p.status || ''));
  const month = new Date().getMonth(), year = new Date().getFullYear();
  const thisMonth = hazards.filter(h => { const d = dateOf(h); return d.getMonth() === month && d.getFullYear() === year; });
  return {
    reply: [
      `📊 ملخص ${dept ? `قسم ${dept}` : 'المصنع كله'} دلوقتي:`,
      `• بلاغات خطورة مفتوحة: ${open.length}${overdue.length ? ` (منهم ${overdue.length} مفتوح من أكتر من 48 ساعة ⚠️)` : ''}`,
      `• بلاغات جاري التعامل معاها: ${inProgress.length}`,
      `• بلاغات الشهر ده: ${thisMonth.length}`,
      `• تصاريح عمل مستنية اعتماد: ${pending.length}`,
      overdue.length ? `\nأقدم البلاغات المتأخرة:\n${overdue.sort((a, b) => dateOf(a) - dateOf(b)).slice(0, 5).map(h => `• ${h.id} — ${h.department || '—'} — ${fmtDate(h.date || h.submittedAt)}`).join('\n')}` : '',
    ].filter(Boolean).join('\n'),
    source: 'بيانات المنصة الحية',
  };
}

module.exports = { answerPersonal, answerAdminStats, detectPersonal };
