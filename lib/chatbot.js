// ============================================================
// lib/chatbot.js — "مساعد السلامة": بيوزّع كل سؤال على الطبقة الصح
// ============================================================
// الطبقات (بالترتيب): تعريف ودردشة ← بياناتي ← ملخص الإدارة ← الهيكل
// الإداري ← SDS ← متطلبات التصاريح ← تعليمات السلامة وفرق الطوارئ.
// من غير أي API خارجي، وكل رد معاه مصدره. الهوية (ctx.user) دايمًا من
// جلسة المستخدم على السيرفر — عشان كده كل حساب بيشوف بياناته هو بس.
'use strict';

const kb = require('./chatbot-kb');
const sds = require('./chatbot-sds');
const org = require('./chatbot-org');
const personal = require('./chatbot-personal');
const procedures = require('./kb/permit-procedures.json');

const ADMIN_TIER = ['super_admin', 'hse_admin', 'dept_admin', 'maint_admin', 'ceo'];
function isAdminRole(role) { return ADMIN_TIER.includes(role); }

const firstName = user => String((user && user.name) || '').replace(/^\s*(م|ا|أ|د)\s*\/\s*/, '').trim().split(/\s+/)[0] || '';

function defaultSuggestions(user) {
  return isAdminRole(user && user.role)
    ? ['كام بلاغ مفتوح؟', 'مين مديرين الأقسام؟', 'التارجت بتاعي', 'SDS الأسيتون']
    : ['محاضراتي', 'التارجت بتاعي', 'بلاغاتي', 'مين مدير قسمي؟'];
}

function introReply(user) {
  const name = firstName(user);
  return {
    reply: [
      `${name ? `أهلاً يا ${name}! ` : ''}أنا "مساعد السلامة" 🦺 — المساعد الذكي لمنصة السلامة والصحة المهنية في السويدي بوليمرز.`,
      `شغلتي إني أرد على أسئلتك في ثانية من مصادر المصنع الرسمية ومن بياناتك انت على المنصة:`,
      `📘 تعليمات السلامة SE-W01 — 38 مكان وعملية (التندة، المخازن، البنزينة، الأوناش، الفصل والعزل...)`,
      `🚨 فرق الطوارئ — الأزمات، الإخلاء، الإطفاء، الإنقاذ، الصيانة، استعادة الأوضاع (أعضاؤها ومهامها وأرقامهم)`,
      `🧪 كروت SDS — ${sds.count} مادة كيميائية (المخاطر، الإسعافات، الإطفاء، التخزين، الانسكاب)`,
      `👔 الهيكل الإداري — المدير العام، قيادة الـ HSE، مديرين الأقسام والمناطق`,
      `👤 بياناتك — محاضراتك، التارجت بتاعك، بلاغاتك، تصاريحك، جزاءاتك`,
      ``,
      `بكتب وبفهم العامية، ومش مشكلة لو فيه غلطة إملائية. ومش بألّف إجابات: كل رد بقولك مصدره، ولو السؤال برّه اللي عندي هقولك بصراحة.`,
    ].join('\n'),
    source: null,
    suggestions: defaultSuggestions(user),
  };
}

function smallTalk(nq, toks, user) {
  if (/انت مين|انتا مين|مين انت|مين حضرتك|اسمك|عرفني بنفسك|عرف نفسك|انت ايه|انت بوت|انت روبوت|انت بني ادم|انت حقيقي|انت انسان/.test(nq)) return introReply(user);
  if (/بتعمل ايه|تقدر تعمل ايه|تقدر تساعدني|بتعرف ايه|وظيفتك|شغلتك|بتفهم في ايه|تعمل ايه|مساعده|help/.test(nq) && toks.length <= 5) return introReply(user);
  if (/مين عملك|مين صممك|مين برمجك|مين طورك|اتعملت ازاي/.test(nq)) {
    return { reply: 'اتعملت مخصوص لمنصة السلامة والصحة المهنية بتاعة السويدي بوليمرز، عشان أي حد في المصنع يلاقي تعليمات السلامة وبياناته بسرعة من غير ما يدوّر في الملفات. مصادري كلها من المصنع نفسه.', source: null };
  }
  if (/شكرا|متشكر|تسلم|ميرسي|thank|جزاك الله|الف شكر/.test(nq) && toks.length <= 4) {
    return { reply: 'العفو! 🙏 سلامتك أهم حاجة — لو عندك أي سؤال تاني أنا موجود.', source: null, suggestions: defaultSuggestions(user) };
  }
  if (/^(مع السلامه|باي|bye|سلام)$/.test(nq.trim())) return { reply: 'مع السلامة 👋 خلي بالك من نفسك وارتدي مهمات الوقاية دايمًا.', source: null };
  if (/ازيك|عامل ايه|اخبارك|انت كويس|ايه الاخبار/.test(nq) && toks.length <= 4) {
    return { reply: `الحمد لله تمام${firstName(user) ? ` يا ${firstName(user)}` : ''} 😊 جاهز أساعدك — اسألني عن أي حاجة في السلامة أو بياناتك.`, source: null, suggestions: defaultSuggestions(user) };
  }
  // "السلام" لوحدها تحية، بس "السلامه ..." سؤال عن السلامة — عشان كده بحدود الكلمة
  if ((/^(السلام عليكم|سلام عليكم|اهلا|اهلين|مرحبا|هاي|هالو|hi|hello|صباح الخير|مساء الخير|صباح النور|مساء النور)/.test(nq) || /^السلام(\s|$)/.test(nq)) && toks.length <= 4) {
    return { reply: `${/السلام/.test(nq) ? 'وعليكم السلام ورحمة الله' : 'أهلاً وسهلاً'}${firstName(user) ? ` يا ${firstName(user)}` : ''} 👋 أنا مساعد السلامة — تحب تسألني عن إيه؟`, source: null, suggestions: ['انت مين؟', ...defaultSuggestions(user).slice(0, 3)] };
  }
  return null;
}

const PROC_TYPES = [
  { re: /ساخن|لحام|قطع/, key: 'ساخن' }, { re: /ارتفاع|سقاله/, key: 'ارتفاع' }, { re: /مغلق|خزان/, key: 'مغلقة' },
  { re: /حفر/, key: 'حفر' }, { re: /رفع|ونش|رافعه/, key: 'رفع' }, { re: /loto|لوتو|فصل وعزل|عزل الطاقه/, key: 'LOTO' },
  { re: /تفريغ|زيت|خامات/, key: 'تفريغ' }, { re: /عام/, key: 'عام' },
];
function permitProcedures(nq) {
  if (!/(تصريح|تصاريح|طلب عمل|permit)/.test(nq)) return null;
  if (!/(متطلبات|مطلوب|المطلوب|شروط|checklist|قايمه التحقق|قايمه|اسيله|خطوات|اجراءات|ازاي|اطلع|استخرج|افتح|اقدم)/.test(nq)) return null;
  const type = PROC_TYPES.find(t => t.re.test(nq));
  const proc = type && procedures.find(p => p.title.includes(type.key) || normalizeTitle(p.title).includes(kb.normalizeArabic(type.key)));
  if (proc) return { reply: `📝 ${proc.title}:\n${proc.content.replace(/^.*?:\s*\n/, '')}`, source: 'قوائم التحقق الخاصة بتصاريح العمل على المنصة' };
  return {
    reply: `📝 خطوات تصريح العمل على المنصة:\n1. قدّم الطلب من تبويب "تصاريح العمل" واختار نوعه، واملأ قائمة التحقق وتقييم المخاطر.\n2. أدمن قسمك بيراجعه ويوافق عليه.\n3. قسم السلامة بيعتمده اعتماد نهائي.\n4. بعد ما تخلص الشغل اقفله من "سجل تصاريح العمل" (اكتمل بأمان / لم يكتمل / إغلاق جبري).\n\nأنواع التصاريح اللي عندي متطلباتها: ${procedures.map(p => p.title.replace('إجراءات ومتطلبات ', '')).join('، ')}.`,
    source: 'قوائم التحقق الخاصة بتصاريح العمل على المنصة',
    suggestions: ['متطلبات تصريح عمل ساخن', 'متطلبات تصريح العمل على ارتفاع'],
  };
}
const normalizeTitle = t => kb.normalizeArabic(t);

/**
 * handleMessage({ text, user, data }) → { reply, source, suggestions }
 * user: { role, name, empCode, department, username } من جلسة السيرفر.
 * data: دوال بترجع البيانات الحية (employees, trainings, hazards, permits, penalties, drills, appUsers).
 */
function handleMessage({ text, user, data }) {
  const q = String(text || '').trim().slice(0, 500);
  const ctx = { user: user || {}, data: data || {} };
  if (!q) return introReply(ctx.user);
  const nq = kb.normalizeArabic(q);
  const toks = kb.contentTokens(q);

  const layers = [
    () => smallTalk(nq, toks, ctx.user),
    () => personal.answerPersonal(q, ctx),
    () => personal.answerAdminStats(q, ctx),
    () => org.answerOrg(q, ctx),
    () => sds.answerSds(q),
    () => permitProcedures(nq),
  ];
  for (const layer of layers) {
    let r = null;
    try { r = layer(); } catch (err) { console.error('[chatbot] layer error:', err.message); }
    if (r) return { source: null, suggestions: r.suggestions || [], ...r };
  }
  const r = kb.answer(q);
  // رسالة المساعدة ورسالة "مش لاقي" بتوع طبقة التعليمات بيتكلموا عن ملفين بس — نرد بالمصادر كلها
  if (r.reply === kb.HELP_REPLY) return introReply(ctx.user);
  if (!r.source && /^مش لاقي/.test(r.reply || '')) {
    const mine = ctx.user.role && ctx.user.role !== 'guest' ? '، وبياناتك على المنصة' : '';
    return {
      reply: `مش لاقي إجابة للسؤال ده في المصادر اللي عندي (تعليمات السلامة SE-W01، فرق الطوارئ، كروت SDS، الهيكل الإداري${mine}).\nجرّب تكتبه بكلمات تانية أو اذكر المكان أو اسم المادة، مثلاً: "ألبس إيه في مخزن الصبغات؟" أو "إسعافات الأسيتون" أو "مين في فريق الإطفاء؟".\nأو اكتب "المواضيع" تشوف كل أقسام تعليمات السلامة.`,
      source: null,
      suggestions: ['انت مين؟', 'المواضيع', ...defaultSuggestions(ctx.user).slice(0, 2)],
    };
  }
  return { ...r, suggestions: [] };
}

module.exports = { handleMessage, isAdminRole, ADMIN_TIER };
