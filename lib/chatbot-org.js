// ============================================================
// lib/chatbot-org.js — الهيكل الإداري: المدير العام، مدير الـ HSE،
// مديرين الأقسام، رؤساء الأقسام، ومديرين المناطق
// ============================================================
// المصدر: قاعدة الموظفين الحية (المسمى الوظيفي + القسم) وسجل تصاريح العمل
// (اسم "مدير المنطقة" اللي بيعتمد كل تصريح). من غير أرقام تليفونات —
// أرقام الموظفين الشخصية مش بتطلع من الشات بوت.
'use strict';

const { normalizeArabic, arCount } = require('./chatbot-kb');

const RANKS = [
  { re: /managing director|chief executive|\bceo\b|general manager/i, rank: 100 },
  { re: /director/i, rank: 80 },
  { re: /senior manager/i, rank: 70 },
  { re: /manager/i, rank: 60 },
  { re: /section head/i, rank: 50 },
  { re: /team leader/i, rank: 40 },
  { re: /supervisor/i, rank: 30 },
];
const rankOf = title => { const r = RANKS.find(x => x.re.test(String(title || ''))); return r ? r.rank : 0; };
const cleanTitle = t => String(t || '').replace(/\s+/g, ' ').trim();

// أسماء الأقسام بالعربي/العامية → اسم القسم في قاعدة الموظفين
const DEPT_ALIASES = [
  ['HSE', ['hse', 'السلامه والصحه المهنيه', 'السلامه', 'الصحه المهنيه', 'اتش اس اي']],
  ['Quality Control', ['مراقبه الجوده', 'الجوده', 'كواليتي', 'qc']],
  ['Quality Assurance', ['توكيد الجوده', 'ضمان الجوده', 'qa']],
  ['Total Quality Management', ['الجوده الشامله', 'tqm']],
  ['Warehouse', ['المخازن', 'المخزن', 'مخازن']],
  ['Logistics', ['اللوجستيات', 'لوجستيك', 'logistics']],
  ['Transportation', ['النقل', 'الحمله']],
  ['Electrical Maintenance', ['صيانه الكهربا', 'الصيانه الكهربايي', 'الكهربا']],
  ['Mechanical Maintenance', ['صيانه الميكانيكا', 'الصيانه الميكانيكي', 'الميكانيكا']],
  ['Preventive Maintenance', ['الصيانه الوقايي', 'الوقاييه']],
  ['Production - PVC', ['pvc', 'بي في سي']],
  ['Production - Master Batch', ['الماستر باتش', 'ماستر باتش', 'master batch']],
  ['Production - Poles', ['الاعمده', 'اعمده', 'poles']],
  ['Production - Special Compounds', ['المركبات الخاصه', 'المركبات', 'special compounds']],
  ['Production Planning', ['تخطيط الانتاج', 'التخطيط']],
  ['HR Operations', ['الموارد البشريه', 'شيون العاملين', 'شئون العاملين', 'اتش ار', 'hr']],
  ['Talent Management & Development', ['التدريب والتطوير', 'تنميه المواهب']],
  ['Finance', ['الماليه', 'finance']],
  ['General Accounting', ['الحسابات', 'المحاسبه']],
  ['Treasury Operations', ['الخزينه']],
  ['Budgeting & Reporting', ['الموازنه']],
  ['Local Sales', ['المبيعات المحليه', 'المبيعات', 'مبيعات']],
  ['Export - PVC', ['تصدير pvc', 'التصدير']],
  ['Export - Master Batch', ['تصدير الماستر باتش']],
  ['Customer Service', ['خدمه العملاء']],
  ['Supply Chain', ['سلسله الامداد', 'سلاسل الامداد', 'supply chain']],
  ['Local Procurement', ['المشتريات المحليه', 'المشتريات']],
  ['Foreign Procurement', ['المشتريات الخارجيه', 'الاستيراد']],
  ['Customs Clearance', ['التخليص الجمركي', 'الجمارك']],
  ['Operations', ['العمليات']],
  ['Administration', ['الشيون الاداريه', 'الشئون الاداريه', 'الشوون الاداريه']],
  ['Government Relations', ['العلاقات الحكوميه']],
  ['IT Operations', ['تكنولوجيا المعلومات', 'الاي تي', 'it']],
  ['IT Applications', ['البرمجيات', 'mis']],
  ['Systems & DBA', ['قواعد البيانات', 'dba']],
  ['R&D', ['البحوث والتطوير', 'البحث والتطوير', 'r&d']],
  ['Business Development', ['تطوير الاعمال']],
  ['Technical Support', ['الدعم الفني']],
  ['Technical Office', ['المكتب الفني']],
  ['Top Management', ['الاداره العليا']],
  ['Cafeteria', ['الكافيتريا']],
  ['Housekeeping', ['النظافه']],
  ['Omylene', ['اوميلين', 'omylene']],
  ['Process', ['البروسيس']],
].map(([dept, aliases]) => ({ dept, aliases: aliases.map(a => normalizeArabic(a)) }));
const MAINT_DEPTS = ['Electrical Maintenance', 'Mechanical Maintenance', 'Preventive Maintenance'];

function detectDepartments(nq, knownDepts) {
  const padded = ` ${nq.replace(/[^\p{L}\p{N}&]+/gu, ' ')} `;
  const hits = [];
  DEPT_ALIASES.forEach(({ dept, aliases }) => {
    const a = aliases.find(al => padded.includes(` ${al} `) || (al.length >= 5 && padded.includes(al)));
    if (a) hits.push({ dept, len: a.length });
  });
  knownDepts.forEach(d => { const nd = normalizeArabic(d); if (nd.length >= 3 && padded.includes(` ${nd} `)) hits.push({ dept: d, len: nd.length + 1 }); });
  if (/(^|\s)(ال)?صيانه(\s|$)/.test(nq) && !hits.some(h => MAINT_DEPTS.includes(h.dept))) MAINT_DEPTS.forEach(d => hits.push({ dept: d, len: 3 }));
  if (!hits.length) return [];
  const maxLen = Math.max(...hits.map(h => h.len));
  return [...new Set(hits.filter(h => h.len >= Math.min(maxLen, 6) || h.len === maxLen).map(h => h.dept))];
}

function leaders(employees, dept, minRank) {
  return employees
    .filter(e => String(e.department || '').trim() === dept && rankOf(e.jobTitle) >= minRank)
    .sort((a, b) => rankOf(b.jobTitle) - rankOf(a.jobTitle));
}

const personLine = e => `• ${e.name} — ${cleanTitle(e.jobTitle)}`;

function deptLeadershipReply(employees, dept) {
  const top = leaders(employees, dept, 50);
  const extra = top.length ? [] : leaders(employees, dept, 30).slice(0, 5);
  const list = (top.length ? top : extra).slice(0, 10);
  if (!list.length) return `مش لاقي مسمى إداري (مدير / رئيس قسم / مشرف) مسجّل لقسم ${dept} في بيانات الموظفين.`;
  return `👔 قيادة قسم ${dept}:\n${list.map(personLine).join('\n')}`;
}

const normPerson = s => normalizeArabic(String(s || '').replace(/^\s*(م|ا|أ|د)\s*\/\s*/, '')).replace(/[^\p{L}]+/gu, '');

/**
 * answerOrg(question, ctx) → رد أو null.
 * ctx.data.employees() / permits() / appUsers(); ctx.user (للأسئلة عن "مدير قسمي").
 */
function answerOrg(question, ctx) {
  const nq = normalizeArabic(question);
  const data = (ctx && ctx.data) || {};
  const employees = typeof data.employees === 'function' ? data.employees() : [];
  if (!employees.length) return null;
  const source = 'بيانات الموظفين (المسميات الوظيفية)';

  // المدير العام / الـ CEO
  if (/(^|\s)(ceo|سي اي او|سي اي اوه)(\s|$)|المدير العام|العضو المنتدب|managing director|رييس الشركه|مدير الشركه|المدير التنفيذي|صاحب الشركه/.test(nq)) {
    const md = employees.filter(e => rankOf(e.jobTitle) === 100);
    const users = typeof data.appUsers === 'function' ? data.appUsers() : [];
    const ceoUser = users.find(u => u.role === 'ceo');
    const list = md.length ? md : employees.filter(e => ceoUser && normPerson(e.name) === normPerson(ceoUser.name));
    if (list.length) {
      return {
        reply: `🏢 المدير العام (CEO):\n${list.map(e => `• ${e.name} — ${cleanTitle(e.jobTitle)} (${e.department})`).join('\n')}`,
        source,
        suggestions: ['مين مدير الـ HSE؟', 'مين مديرين الأقسام؟'],
      };
    }
  }

  // مدير / دايركتور الـ HSE
  const hseAsk = /(hse|اتش اس اي|السلامه)/.test(nq) && /(دايركتور|دايريكتور|director|مدير|رييس|مسيول|مسوول|مسؤول|هيد|head|manager|مين)/.test(nq);
  if (hseAsk && !/تعليمات|اجراءات|نشره|sds/.test(nq)) {
    const hse = leaders(employees, 'HSE', 40);
    if (hse.length) {
      return {
        reply: `🦺 قيادة إدارة السلامة والصحة المهنية (HSE):\n${hse.map(personLine).join('\n')}`,
        source,
        suggestions: ['مين المدير العام؟', 'مين في فريق استعادة الأوضاع؟'],
      };
    }
  }

  // مديرين المناطق
  if (/مديرين المناطق|مدرا المناطق|مديري المناطق|مدير المنطقه|مدير منطقه|مديرين مناطق|area manager/.test(nq)) {
    const sales = employees.filter(e => /area .*manager/i.test(e.jobTitle || ''));
    const permits = typeof data.permits === 'function' ? data.permits() : [];
    const counts = new Map();
    permits.forEach(p => {
      const raw = String(p.areaManagerName || '').trim();
      const key = normPerson(raw);
      if (!key || raw === '-') return;
      const cur = counts.get(key) || { name: raw.replace(/\s*\/\s*/, '/ '), n: 0 };
      cur.n++;
      counts.set(key, cur);
    });
    const top = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 15);
    const parts = [];
    if (top.length) parts.push(`📋 مديرين المناطق اللي بيعتمدوا تصاريح العمل (من سجل التصاريح):\n${top.map(t => `• ${t.name} — اعتمد ${arCount(t.n, 'تصريح')}`).join('\n')}`);
    if (sales.length) parts.push(`💼 مديرين مناطق المبيعات (Area Sales Manager):\n${sales.map(e => `• ${e.name} (${e.department})`).join('\n')}`);
    if (parts.length) return { reply: parts.join('\n\n'), source: 'سجل تصاريح العمل + بيانات الموظفين' };
  }

  const knownDepts = [...new Set(employees.map(e => String(e.department || '').trim()).filter(Boolean))];
  const depts = detectDepartments(nq, knownDepts);
  const managerWord = /(مدير|مديرين|مدرا|رييس|روسا|مسيول|مسوول|مسؤول|هيد|head|manager|director|دايركتور|قايد|مشرف|قياده|ماسك)/.test(nq);

  // "مين مدير قسمي / مديري"
  // بحدود الكلمة: "مديرين" متتقريش "مديري"
  if (/(^|\s)(مديري|رييسي|مشرفي|مديرنا)(\s|$)|مدير قسمي|رييس قسمي|المدير بتاعي|المسيول عني|المسوول عني/.test(nq)) {
    const me = ctx.user && ctx.user.empCode
      ? employees.find(e => String(e.empCode || '').replace(/^0+/, '') === String(ctx.user.empCode).replace(/^0+/, ''))
      : null;
    const dept = (me && me.department) || (ctx.user && ctx.user.department) || '';
    if (!dept) return { reply: 'مش عارف قسمك — سجّل دخول بحسابك الأول.', source: null };
    return { reply: deptLeadershipReply(employees, dept), source, suggestions: ['التارجت بتاعي', 'مين مدير الـ HSE؟'] };
  }

  // قسم بعينه: "مين مدير قسم الجودة" / "مين رئيس المخازن"
  if (depts.length && (managerWord || /(^|\s)مين(\s|$)/.test(nq))) {
    return { reply: depts.slice(0, 4).map(d => deptLeadershipReply(employees, d)).join('\n\n'), source };
  }

  // كل مديرين / رؤساء الأقسام
  if (/مديرين الاقسام|مدرا الاقسام|مديري الاقسام|روسا الاقسام|كل المديرين|المديرين كلهم|قيادات الشركه|مين المديرين/.test(nq)) {
    const sectionHeads = /روسا/.test(nq);
    const lines = knownDepts.sort((a, b) => a.localeCompare(b)).map(d => {
      const list = sectionHeads
        ? employees.filter(e => e.department === d && /section head/i.test(e.jobTitle || ''))
        : leaders(employees, d, 60).slice(0, 3);
      return list.length ? `▪️ ${d}: ${list.map(e => `${e.name} (${cleanTitle(e.jobTitle)})`).join('، ')}` : null;
    }).filter(Boolean);
    return {
      reply: `${sectionHeads ? '👔 رؤساء الأقسام (Section Heads)' : '👔 مديرين الأقسام'}:\n${lines.join('\n')}\n\nاسألني عن قسم بعينه (مثلاً: "مين مدير قسم الجودة؟") عشان أجيبلك كل القيادات فيه.`,
      source,
    };
  }
  return null;
}

module.exports = { answerOrg, rankOf };
