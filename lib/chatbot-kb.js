// ============================================================
// lib/chatbot-kb.js — محرك إجابة الشات بوت من ملفين فقط
// ============================================================
// المصادر (lib/kb): تعليمات السلامة SE-W01 + فرق الطوارئ. البوت مبيألفش
// إجابة: كل رد هو نص من الملفين نفسهم + مصدره (رقم القسم والصفحة).
//
// إزاي بيفهم الأسئلة المكتوبة غلط أو "الملفوفة":
//   1) تطبيع عربي (أ/إ/آ → ا، ة → ه، ى → ي، شيل التشكيل والهمزة، أرقام عربية).
//   2) تجريد بسيط (ال التعريف + لواحق الجمع) + تجربة الكلمة من غير حرف
//      الجر الملزوق (و/ب/ل/ف/ك) أو "لا".
//   3) تسامح مع الأخطاء الإملائية: حرف ناقص/زيادة/غلط/حرفين متبدلين
//      (Damerau-Levenshtein): مسافة 1 للكلمات 4-5 حروف، و2 للأطول.
//   4) مرادفات عامية ↔ فصحى ("ألبس إيه" ↔ مهمات الوقاية، "جزمة" ↔ حذاء سيفتي).
//   5) ترتيب النتائج بـ BM25 + تقوية لو السؤال ذكر مكان/قسم بعينه.
'use strict';

const { SAFETY_SOURCE, TEAMS_SOURCE, safetySections, emergencyTeams } = require('./kb');

// ── التطبيع والتقسيم ─────────────────────────────────────────────
function normalizeArabic(str) {
  return String(str == null ? '' : str)
    .replace(/[ً-ٰٟـ]/g, '') // تشكيل + تطويل
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ء/g, '')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .toLowerCase();
}

function rawTokens(str) {
  return normalizeArabic(str).split(/[^a-z0-9ء-ي]+/).filter(Boolean);
}

const STOP = new Set([
  'في', 'من', 'الي', 'علي', 'عن', 'مع', 'او', 'و', 'ف', 'ب', 'ل', 'ك', 'ما', 'ماذا', 'هل', 'هو', 'هي', 'هم',
  'انا', 'انت', 'انتي', 'احنا', 'ده', 'دي', 'دا', 'دول', 'هذا', 'هذه', 'ذلك', 'تلك', 'كان', 'كانت', 'يكون',
  'تكون', 'لا', 'لم', 'لن', 'مش', 'ايه', 'اي', 'ايش', 'شو', 'ازاي', 'كيف', 'امتي', 'متي', 'فين', 'اين', 'وين',
  'ليه', 'لماذا', 'ليش', 'كام', 'كم', 'لو', 'اذا', 'ان', 'انه', 'انها', 'اللي', 'الذي', 'التي', 'يعني', 'بس',
  'عايز', 'عاوز', 'عايزه', 'عاوزه', 'محتاج', 'محتاجه', 'ممكن', 'يمكن', 'لازم', 'يجب', 'عشان', 'علشان', 'لان',
  'حد', 'واحد', 'حاجه', 'حاجات', 'كده', 'كدا', 'بقي', 'طيب', 'تمام', 'برضو', 'كمان', 'ايضا', 'مثلا', 'جدا',
  'اعمل', 'نعمل', 'بعمل', 'هعمل', 'اعملها', 'يتعمل', 'اتعمل', 'السلام', 'عليكم', 'اهلا', 'مرحبا', 'شكرا',
  'سمحت', 'فضلك', 'الو', 'يا', 'اقدر', 'نقدر', 'يقدر', 'قولي', 'قلي', 'عرفني', 'اعرف', 'فهمني', 'اشرحلي',
  'اشرح', 'بالظبط', 'لقيت', 'شفت', 'لاحظت', 'وجدت', 'لقينا', 'شايف', 'عليه', 'عليها', 'عليهم', 'بيه', 'فيه',
  'فيها', 'منه', 'منها', 'عنه', 'له', 'لها', 'معاه', 'معاها', 'ينفع', 'مينفعش', 'قد', 'جوه', 'بره', 'امبارح',
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'what', 'how', 'where',
]);

const AL_PREFIXES = ['وال', 'بال', 'كال', 'فال', 'لل', 'ال'];
const SUFFIXES = ['ات', 'ون', 'ين', 'يه', 'ها', 'هم', 'كم', 'نا', 'ه', 'ي'];

function stripAl(t) {
  for (const p of AL_PREFIXES) if (t.startsWith(p) && t.length - p.length >= 3) return t.slice(p.length);
  return t;
}

function canon(t) {
  if (!/[ء-ي]/.test(t)) return t;
  let s = stripAl(t);
  if (s.length >= 5) {
    for (const suf of SUFFIXES) {
      if (s.endsWith(suf) && s.length - suf.length >= 3) { s = s.slice(0, -suf.length); break; }
    }
  }
  return s;
}

function contentTokens(str) {
  return rawTokens(str).filter(t => t.length >= 2 && !STOP.has(t));
}

// Damerau-Levenshtein (OSA) مع خروج مبكر لو المسافة عدّت الحد
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    prev = cur;
    if (rowMin > max) return max + 1;
  }
  return prev[b.length];
}

function allowedDistance(len) {
  if (len <= 3) return 0;
  if (len <= 5) return 1;
  return 2;
}

// ── مرادفات عامية/فصحى (كل مجموعة كلمات بتدل على نفس المعنى) ──────
const SYNONYM_GROUPS = [
  ['خوذه', 'كاب', 'هلمت', 'helmet', 'دماغ'],
  ['حذا', 'جزمه', 'بوت', 'بياده', 'shoes', 'رجلي', 'قدم', 'قدمين'],
  ['جوانتي', 'جونتي', 'قفاز', 'قفازات', 'جلوفز', 'gloves', 'ايدي', 'ايد'],
  ['نظاره', 'نضاره', 'نظارات', 'جوجل', 'عيني', 'عنيا'],
  ['كمامه', 'ماسك', 'قناع', 'mask', 'غبار', 'تراب', 'اتربه', 'بودره'],
  ['سداده', 'سدادات', 'سماعه', 'اذن', 'ودن', 'ودني', 'ضوضا', 'دوشه'],
  ['فيست', 'صديري', 'سديري', 'عاكس'],
  ['ارتدي', 'البس', 'لبس', 'يلبس', 'نلبس', 'بلبس', 'ارتدا', 'مهمات', 'وقايه', 'ppe', 'هدوم'],
  ['اطفا', 'طفايه', 'طفايات', 'اطفي', 'حريق', 'حرايق', 'نار', 'ولعت', 'ولعه', 'اشتعال'],
  ['كهربا', 'كهربه', 'كهربايي', 'كهربيه', 'كهرباييه', 'اتكهرب', 'صدمات', 'صدمه', 'صعق'],
  ['سلك', 'اسلاك', 'كابل', 'كابلات', 'توصيلات', 'وصلات'],
  ['ونش', 'اوناش', 'كرين', 'crane', 'رافعه'],
  ['كلارك', 'كلاركات', 'فورك', 'ليفت', 'فوركليفت', 'forklift'],
  ['سولار', 'ديزل', 'جاز', 'وقود', 'تفويل', 'بنزين', 'بنزينه'],
  ['ارتفاع', 'ارتفاعات', 'سقاله', 'سقالات', 'عالي', 'سقوط', 'وقوع', 'اقع'],
  ['اسعاف', 'اسعافات', 'مصاب', 'اغما', 'اغمي', 'مغمي', 'اصابه', 'عيان'],
  ['فصل', 'عزل', 'loto', 'لوتو', 'قفل', 'تاج', 'tag', 'lock'],
  ['تصريح', 'تصاريح', 'permit'],
  ['نشره', 'sds', 'msds', 'داتاشيت'],
  ['غسول', 'غسيل', 'ايوش'],
  ['مخلفات', 'زباله', 'نفايات', 'اسكراب', 'خرده', 'سكراب', 'scrap'],
  ['اخلا', 'اهرب', 'خروج'],
  ['انقاذ', 'انقذ', 'محاصر', 'محاصرين'],
  ['ضهر', 'ظهر', 'ضهري', 'وسط', 'غضروف', 'فقري', 'فقرات', 'شيل', 'اشيل', 'رفع', 'شكاير', 'شكاره', 'شيكاره'],
  ['جونيه', 'جونيات', 'جامبو', 'bigbag'],
  ['بالته', 'بالتات', 'طبالي', 'طبليه', 'بلتات', 'باليت', 'pallet'],
  ['حيطه', 'حيطان', 'حوايط', 'حوائط', 'جدران', 'جدار'],
  ['تدخين', 'سجاير', 'سيجاره', 'سجاره', 'شيشه', 'دخان', 'ادخن'],
  ['موبايل', 'تليفون', 'هاتف', 'تلفون'],
  ['سواقه', 'قياده', 'سايق', 'سايقين', 'عربيه', 'عربيات', 'سياره', 'سيارات'],
  ['سرعه', 'سريع', 'كيلو'],
  ['اكل', 'شرب', 'اطعمه', 'مشروبات', 'باكل'],
  ['حروق', 'حرق', 'اتحرق', 'ساخن', 'ساخنه', 'سخن', 'حراره', 'سخانات'],
  ['جرح', 'جروح', 'اتعور', 'حاد', 'حاده'],
  ['هوا', 'كومبروسر', 'خرطوم', 'خراطيم', 'قفيز'],
  ['برميل', 'براميل', 'جراكن'],
  ['حوض', 'احواض', 'انسكاب', 'تسريب', 'دلق', 'اندلق'],
  ['ماكينه', 'ماكينات', 'مكنه', 'مكن', 'الات', 'معده'],
  ['عده', 'عدد', 'ادوات'],
  ['صاروخ', 'شنيور', 'جلخ', 'مخرطه', 'مثقاب', 'منشار', 'لحام'],
  ['بوفيه', 'مطبخ', 'كافيتريا', 'غاز', 'انبوبه'],
  ['نظافه', 'نضافه', 'تنضيف', 'تنظيف'],
  ['اضاءه', 'نور', 'لمبه', 'انوار'],
  ['مقاول', 'مقاولين', 'انشايي', 'انشاييه'],
  ['حزام', 'harness'],
  ['اخضر', 'خضرا'],
  ['عطل', 'عطلان', 'عطلانه', 'بايظ', 'بايظه', 'خربان', 'خربانه', 'عطلت', 'اعطال'],
  ['وجه', 'وش', 'وشي'],
  ['فتح', 'افتح', 'استخراج', 'اطلع'],
];

// ── بناء الفهارس ─────────────────────────────────────────────────
const GENERIC_PLACE = new Set(['قسم', 'مرحل', 'مرحله', 'تعليم', 'سلام', 'صح', 'مهني', 'بيي', 'عمل', 'عملي', 'عمليه', 'منطق', 'منطقه', 'داخل', 'خاص', 'خاصه']);

const items = []; // { section, text, terms:Set, len }
safetySections.forEach(section => {
  const main = section.place.replace(/\(.*?\)/g, ' ');
  const alt = (section.place.match(/\((.*?)\)/g) || []).join(' ');
  section.placeTerms = [...new Set(contentTokens(main).map(canon))].filter(t => !GENERIC_PLACE.has(t));
  section.altTerms = [...new Set(contentTokens(alt).map(canon))].filter(t => !GENERIC_PLACE.has(t));
  section.items.forEach(text => {
    const toks = contentTokens(text);
    const terms = new Set(toks.map(canon));
    // الكلمة الملزوق فيها حرف جر ("وفتح"، "لفتح"، "لاتخزن") بتتفهرس بالشكلين
    toks.forEach(t => {
      if (/^[وبلفك]/.test(t) && t.length >= 4) terms.add(canon(t.slice(1)));
      if (t.startsWith('لا') && t.length >= 5) terms.add(canon(t.slice(2)));
    });
    items.push({ section, text, terms, len: toks.length || 1 });
  });
});

const vocab = new Map(); // canon term -> number of items containing it
items.forEach(it => it.terms.forEach(t => vocab.set(t, (vocab.get(t) || 0) + 1)));
safetySections.forEach(s => [...s.placeTerms, ...s.altTerms].forEach(t => { if (!vocab.has(t)) vocab.set(t, 0); }));
const N_ITEMS = items.length;
const AVG_LEN = items.reduce((a, it) => a + it.len, 0) / N_ITEMS;
const idf = t => Math.log(1 + (N_ITEMS - (vocab.get(t) || 0) + 0.5) / ((vocab.get(t) || 0) + 0.5));
const vocabList = [...vocab.keys()];

const safetyRawVocab = new Set();
safetySections.forEach(s => [s.title, s.place, ...s.items].forEach(txt => rawTokens(txt).forEach(t => {
  safetyRawVocab.add(t); safetyRawVocab.add(stripAl(t));
})));
const isSafetyWord = t => safetyRawVocab.has(t) || safetyRawVocab.has(stripAl(t)) || vocab.has(canon(t));

const placeDocFreq = new Map();
safetySections.forEach(s => s.placeTerms.forEach(t => placeDocFreq.set(t, (placeDocFreq.get(t) || 0) + 1)));
const placeIdf = t => Math.log(1 + safetySections.length / (placeDocFreq.get(t) || 1));

const synonymMap = new Map(); // canon -> Set(canon)
SYNONYM_GROUPS.forEach(group => {
  const canons = [...new Set(group.map(w => canon(normalizeArabic(w))))];
  canons.forEach(c => {
    if (!synonymMap.has(c)) synonymMap.set(c, new Set());
    canons.forEach(o => { if (o !== c) synonymMap.get(c).add(o); });
  });
});

function fuzzyVocab(term) {
  const max = allowedDistance(term.length);
  if (max === 0) return [];
  const out = [];
  for (const v of vocabList) {
    if (Math.abs(v.length - term.length) > max) continue;
    const d = editDistance(term, v, max);
    if (d <= max) out.push({ term: v, d });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, 4);
}

// كل كلمة في السؤال → مصطلحات من الفهرس بأوزان: مطابقة 1، مرادف 0.8، تقريب إملائي 0.7/0.5
function expandQueryToken(tok) {
  const cands = new Map();
  const add = (t, w) => { if (vocab.has(t) && (!cands.has(t) || cands.get(t) < w)) cands.set(t, w); };
  const variants = [tok];
  if (/^[وبلفك]/.test(tok) && tok.length >= 4) variants.push(tok.slice(1));
  if (tok.startsWith('لا') && tok.length >= 5) variants.push(tok.slice(2));
  const canons = [...new Set(variants.map(canon))];
  canons.forEach((c, i) => add(c, i === 0 ? 1 : 0.95));
  canons.forEach(c => (synonymMap.get(c) || []).forEach(s => add(s, 0.8)));
  if (cands.size === 0) {
    canons.forEach(c => fuzzyVocab(c).forEach(f => add(f.term, f.d === 1 ? 0.7 : 0.5)));
    // المرادف ممكن يكون مكتوب غلط هو كمان ("جزمة" → "جزمه")
    const base = canons[0];
    const max = allowedDistance(base.length);
    if (max > 0) {
      for (const [key, syns] of synonymMap) {
        if (Math.abs(key.length - base.length) <= max && editDistance(base, key, max) <= max) {
          syns.forEach(s => add(s, 0.6));
          add(key, 0.6);
        }
      }
    }
  }
  return cands;
}

// ── إجابات السلامة ───────────────────────────────────────────────
const GENERAL_WORDS = /تعليمات|اجراءات|خطوات|قواعد|ارشادات|نصايح|نصائح|اشتراطات|شروط|التزامات|كل حاجه|ايه اللي/;

function scoreSections(qTerms) {
  return safetySections.map(s => {
    let num = 0, den = 0;
    const matched = new Set();
    s.placeTerms.forEach(pt => {
      const w = placeIdf(pt);
      den += w;
      let best = 0;
      qTerms.forEach(q => { const v = q.cands.get(pt) || 0; if (v > best) best = v; });
      if (best > 0) { num += w * best; matched.add(pt); }
    });
    let score = den ? num / den : 0;
    // اسم بديل بين قوسين في المكان (زي LOTO) — لو اتذكر يكفي لوحده
    s.altTerms.forEach(at => { if (qTerms.some(q => (q.cands.get(at) || 0) >= 0.8)) { score = Math.max(score, 0.85); matched.add(at); } });
    return { s, score, matched };
  }).sort((a, b) => b.score - a.score);
}

function formatSection(s) {
  const list = s.items.map((t, i) => `${i + 1}. ${t}`).join('\n');
  return `📘 ${s.title} (قسم ${String(s.no).padStart(2, '0')} — صفحة ${s.page}):\n${list}`;
}

function sameContentAs(s) {
  return safetySections.filter(o => o !== s && o.items.length === s.items.length && o.items.every((t, i) => t === s.items[i]));
}

function sectionReply(s) {
  const dup = sameContentAs(s);
  return {
    reply: formatSection(s) + (dup.length ? `\n\n(نفس التعليمات مكررة في قسم ${dup.map(d => d.no).join('، ')} من الملف.)` : ''),
    source: `${SAFETY_SOURCE} — قسم ${s.no}، صفحة ${s.page}`,
  };
}

function disambiguation(cands) {
  return {
    reply: `سؤالك ممكن يقصد أكتر من مكان — اسألني تاني باسم المكان بالظبط:\n${cands.slice(0, 5).map(x => `• ${x.s.title}`).join('\n')}`,
    source: SAFETY_SOURCE,
  };
}

function safetyAnswer(question) {
  const toks = contentTokens(question);
  const qTerms = toks.map(tok => ({ tok, cands: expandQueryToken(tok) })).filter(q => q.cands.size > 0);
  if (qTerms.length === 0) return null;
  const normQ = normalizeArabic(question);
  const generalAsk = GENERAL_WORDS.test(normQ);

  const sections = scoreSections(qTerms);
  const top = sections[0];
  const dupsOfTop = sameContentAs(top.s);
  const ties = sections.filter(x => x.score >= top.score - 0.06 && x.score > 0 && x.s !== top.s && !dupsOfTop.includes(x.s));
  const strong = top.score >= 0.5 ? top : null;
  const placeOf = x => [...x.s.placeTerms, ...x.s.altTerms];
  const nonPlace = strong ? qTerms.filter(q => ![...q.cands.keys()].some(c => placeOf(strong).includes(c))) : qTerms;

  // سؤال عام عن مكان ("تعليمات مخزن الصبغات" / "البوفيه" / "خطوات اللوتو")
  if ((strong && (generalAsk || nonPlace.length === 0)) || (!strong && generalAsk && top.score >= 0.4)) {
    if (ties.length && ties[0].score >= 0.4) return disambiguation([top, ...ties]);
    return sectionReply(top.s);
  }

  // سؤال محدد → أفضل تعليمات مطابقة (BM25 + تقوية المكان المذكور)
  const scoringTerms = strong ? nonPlace : qTerms;
  if (!scoringTerms.length) return sectionReply(top.s);
  const k1 = 1.2, b = 0.4;
  const scored = items.map(it => {
    let score = 0, matched = 0, strongMatched = 0;
    scoringTerms.forEach(q => {
      let best = 0, bestW = 0;
      q.cands.forEach((w, term) => {
        if (it.terms.has(term)) {
          const tfPart = (k1 + 1) / (1 + k1 * (1 - b + b * it.len / AVG_LEN));
          const v = w * idf(term) * tfPart;
          if (v > best) { best = v; bestW = w; }
        }
      });
      if (best > 0) { score += best; matched++; if (bestW >= 0.8) strongMatched++; }
    });
    const coverage = matched / scoringTerms.length;
    score *= 0.4 + 0.6 * coverage;
    if (strong) score *= it.section === strong.s || dupsOfTop.includes(it.section) ? 2 : 0.5;
    else {
      const sec = sections.find(x => x.s === it.section);
      score *= 1 + (sec ? sec.score : 0);
    }
    return { it, score, coverage, matched, strongMatched };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

  if (!scored.length) return strong ? sectionReply(strong.s) : null;
  const best = scored[0];
  // كلمة واحدة نادرة من سؤال طويل مش كفاية ("... طارت فوق الجبل" ≠ "فوق بعض")
  const confident = best.strongMatched >= 1 && (best.coverage >= 0.5 || (best.score >= 3 && best.coverage >= 0.34))
    || (best.matched >= 2 && best.coverage >= 0.6);
  if (!confident) return strong ? sectionReply(strong.s) : null;

  // دمج التعليمات المتطابقة نصًا (زي "كن على دراية بأماكن أجهزة الإطفاء" المتكررة في كل قسم)
  const groups = new Map();
  for (const x of scored) {
    if (x.score < best.score * 0.6) break;
    const key = normalizeArabic(x.it.text);
    if (!groups.has(key)) {
      if (groups.size >= 3) continue;
      groups.set(key, { text: x.it.text, sections: [] });
    }
    const g = groups.get(key);
    if (!g.sections.includes(x.it.section)) g.sections.push(x.it.section);
  }
  const lines = [...groups.values()].map(g => {
    const where = g.sections.length <= 2
      ? g.sections.map(s => s.place).join(' و ')
      : `${g.sections.slice(0, 2).map(s => s.place).join('، ')} + ${g.sections.length - 2} أماكن تانية`;
    return `• ${g.text}\n   ↳ (${where})`;
  });
  const secNos = [...new Set([...groups.values()].flatMap(g => g.sections.map(s => s.no)))].slice(0, 4);
  return {
    reply: `حسب تعليمات السلامة:\n${lines.join('\n')}`,
    source: `${SAFETY_SOURCE} — قسم ${secNos.join('، ')}`,
  };
}

// ── فرق الطوارئ ──────────────────────────────────────────────────
const TEAM_WORD = /(^|\s)(ال|و|ل)?(فريق|فرق|تيم|team)/;
const MEMBER_WORD = /مين|اعضا|اسما|افراد|مكون|ناس|الموجودين|فيه كام|عدد/;
const DUTY_WORD = /مهام|مهمه|مهمت|دور|بيعمل|وظيف|مسيول|مسوول|مسؤول|شغلت|واجب|اختصاص|بتعمل/;
const PHONE_WORD = /رقم|تليفون|تلفون|موبايل|نمره|نمر|هاتف|اتصل|اكلم|كلم/;
const TEAM_IGNORE = new Set(['فريق', 'فرق', 'طواري', 'طوار', 'تيم', 'team']);

emergencyTeams.forEach(team => {
  team.keys = [...new Set([team.name, ...team.aliases].flatMap(a => contentTokens(a).map(canon)))]
    .filter(k => !TEAM_IGNORE.has(k));
});

function detectTeam(toks) {
  const tokCanons = toks.map(canon).filter(c => !TEAM_IGNORE.has(c));
  let best = null;
  emergencyTeams.forEach(team => {
    let hit = 0;
    team.keys.forEach(k => {
      if (tokCanons.some(c => c === k || (k.length >= 5 && editDistance(c, k, allowedDistance(k.length)) <= allowedDistance(k.length)))) hit++;
    });
    if (hit && (!best || hit > best.hit)) best = { team, hit };
  });
  return best ? best.team : null;
}

function memberLine(m) {
  return `• ${m[0]} — ${m[2]} (${m[1]}) — 📞 ${m[3]}`;
}

function teamAnswer(team, normQ) {
  const wantsMembers = MEMBER_WORD.test(normQ) || PHONE_WORD.test(normQ);
  const wantsDuties = DUTY_WORD.test(normQ);
  const parts = [];
  if (wantsDuties || !wantsMembers) {
    parts.push(`🛡️ مهام ${team.name}:\n${team.duties.map(d => `• ${d}`).join('\n')}`);
    if (team.notes.length) parts.push(team.notes.map(n => `* ${n}`).join('\n'));
  }
  if (wantsMembers || !wantsDuties) {
    if (!parts.length) parts.push(`🛡️ ${team.name}: ${team.duties[0]}`);
    parts.push(`👥 أعضاء ${team.name} (${team.members.length}):\n${team.members.map(memberLine).join('\n')}`);
  }
  return { reply: parts.join('\n\n'), source: `${TEAMS_SOURCE} — ${team.name}` };
}

function allTeamsAnswer() {
  const lines = emergencyTeams.map(t => `${t.no}) ${t.name} — ${arCount(t.members.length, 'عضو')}\n   ${t.duties[0]}`);
  return {
    reply: `فرق الطوارئ (${arCount(emergencyTeams.length, 'فريق')}):\n${lines.join('\n')}\n\nاسألني عن أي فريق بالاسم (مثلاً: "مين في فريق الإطفاء؟" أو "مهام فريق الإخلاء").`,
    source: TEAMS_SOURCE,
  };
}

// الأسماء: من غير تجريد (عشان "حسنين" متبقاش "حسن")
const NAME_TITLES = new Set(['م', 'ا']);
const memberEntries = [];
emergencyTeams.forEach(team => team.members.forEach(m => {
  const tokens = rawTokens(m[0]).filter(t => !NAME_TITLES.has(t) && t.length >= 2);
  memberEntries.push({ m, team, tokens });
}));
const nameFreq = new Map();
memberEntries.forEach(e => new Set(e.tokens).forEach(t => nameFreq.set(t, (nameFreq.get(t) || 0) + 1)));

// 2 = مطابق بالظبط، 1 = قريب (حرف واحد) — التقريب بس لأسماء نادرة ولكلمات مش من مصطلحات السلامة
function nameMatchQuality(q, t) {
  if (q === t || stripAl(q) === stripAl(t)) return 2;
  if (q.length < 4 || t.length < 4) return 0;
  if ((nameFreq.get(t) || 0) > 2 || isSafetyWord(q)) return 0;
  return editDistance(stripAl(q), stripAl(t), 1) <= 1 ? 1 : 0;
}

function personAnswer(toks) {
  const qNames = [...new Set(toks.filter(t => t.length >= 2))];
  const hits = memberEntries.map(e => {
    let exact = 0, fuzzy = 0, distinctive = 0;
    qNames.forEach(q => {
      let best = 0, bestTok = null;
      e.tokens.forEach(t => { const v = nameMatchQuality(q, t); if (v > best) { best = v; bestTok = t; } });
      if (best === 2) exact++; else if (best === 1) fuzzy++;
      if (best && !isSafetyWord(bestTok)) distinctive++;
    });
    return { e, exact, fuzzy, total: exact + fuzzy, distinctive };
  }).filter(h => {
    if (h.total >= 2) return h.distinctive >= 1;
    if (h.total === 1 && h.exact === 1) {
      const t = h.e.tokens.find(tok => qNames.includes(tok) || qNames.some(q => stripAl(q) === stripAl(tok)));
      return !!t && t.length >= 4 && (nameFreq.get(t) || 0) <= 2 && !isSafetyWord(t);
    }
    return false;
  });
  if (!hits.length) return null;
  const maxTotal = Math.max(...hits.map(h => h.total));
  const maxExact = Math.max(...hits.filter(h => h.total === maxTotal).map(h => h.exact));
  const top = hits.filter(h => h.total === maxTotal && h.exact === maxExact);
  const people = new Map(); // الشخص ممكن يكون في أكتر من فريق
  top.forEach(h => {
    const key = `${normalizeArabic(h.e.m[0])}|${h.e.m[3]}`;
    if (!people.has(key)) people.set(key, { m: h.e.m, teams: [] });
    people.get(key).teams.push(h.e.team.name);
  });
  if (people.size > 6) return null; // اسم عام جدًا
  const lines = [...people.values()].map(p => `• ${p.m[0]} — ${p.m[2]} (${p.m[1]})\n   📞 ${p.m[3]}\n   عضو في: ${p.teams.join('، ')}`);
  return { reply: lines.join('\n'), source: TEAMS_SOURCE };
}

// ── نقطة الدخول ──────────────────────────────────────────────────
const HELP_REPLY = [
  'أهلاً! أنا مساعد السلامة، وبجاوب من ملفين بس:',
  '1) تعليمات السلامة والصحة المهنية والبيئة SE-W01 (38 قسم: تندة PVC، غرفة الكربون، التوزين، الخلاطات، المخازن، البنزينة، الأوناش، العمل على ارتفاعات، الإسعافات الأولية، الفصل والعزل، وغيرهم).',
  '2) فرق الطوارئ (الأزمات، الإخلاء، الإطفاء، الإنقاذ، الصيانة، استعادة الأوضاع) بأعضائها وأرقامهم ومهامهم.',
  '',
  'أمثلة: "ألبس إيه في مخزن الصبغات؟" — "أعمل إيه لو لقيت سلك مكشوف؟" — "مين في فريق الإطفاء؟" — "رقم درويش حسنين" — "منطقة التجمع فين؟"',
  'اكتب "المواضيع" عشان تشوف كل أقسام التعليمات.',
].join('\n');

function topicsAnswer() {
  return {
    reply: `أقسام تعليمات السلامة SE-W01:\n${safetySections.map(s => `${String(s.no).padStart(2, '0')}. ${s.place}`).join('\n')}\n\nاسألني عن أي قسم بالاسم.`,
    source: SAFETY_SOURCE,
  };
}

function notFound() {
  const examples = ['مخزن المنتج التام', 'البنزينة', 'الأوناش', 'الإسعافات الأولية', 'العمل على ارتفاعات', 'غرفة الكربون'];
  return {
    reply: `مش لاقي إجابة للسؤال ده في الملفين اللي عندي (تعليمات السلامة SE-W01 وفرق الطوارئ).\nجرّب تسأل بكلمات تانية أو اذكر المكان، مثلاً: ${examples.join(' / ')}.\nأو اكتب "المواضيع" تشوف كل الأقسام.`,
    source: null,
  };
}

function answer(question) {
  const q = String(question || '').trim();
  const normQ = normalizeArabic(q);
  const toks = contentTokens(q);

  if (!toks.length || (/^(السلام|اهلا|مرحبا|هاي|hi|hello|ازيك|صباح|مساء)/.test(normQ) && toks.length <= 2)) {
    return { reply: HELP_REPLY, source: null };
  }
  if (/مساعده|help|بتعرف ايه|تقدر تساعد|بتجاوب علي ايه/.test(normQ) && toks.length <= 4) return { reply: HELP_REPLY, source: null };
  if (/المواضيع|الفهرس|الاقسام كلها|كل الاقسام|اقسام التعليمات/.test(normQ)) return topicsAnswer();

  if (/تجمع/.test(normQ)) {
    const evac = emergencyTeams.find(t => t.no === 2);
    return { reply: `📍 مناطق التجمع الآمنة (من مهام فريق الإخلاء):\n• ${evac.duties.join('\n• ')}`, source: `${TEAMS_SOURCE} — ${evac.name}` };
  }

  const team = detectTeam(toks);
  const mentionsTeamWord = TEAM_WORD.test(normQ);
  const teamIntent = mentionsTeamWord || MEMBER_WORD.test(normQ) || PHONE_WORD.test(normQ) || DUTY_WORD.test(normQ);
  if (mentionsTeamWord && !team) return allTeamsAnswer();
  if (team && teamIntent) return teamAnswer(team, normQ);

  const person = personAnswer(toks);
  if (person) return person;

  const safe = safetyAnswer(q);
  if (safe) {
    if (team) safe.reply += `\n\n🛡️ ومن مهام ${team.name}: ${team.duties[0]}`;
    return safe;
  }
  if (team) return teamAnswer(team, normQ);
  return notFound();
}

// عدد + المعدود بقواعد العربي: 1 → "بلاغ واحد"، 2 → "بلاغين"، 3–10 → "5 بلاغات"، غير كده "12 بلاغ"
const AR_COUNT_FORMS = {
  'محاضرة': ['محاضرة واحدة', 'محاضرتين', 'محاضرات'],
  'ساعة': ['ساعة واحدة', 'ساعتين', 'ساعات'],
  'بلاغ': ['بلاغ واحد', 'بلاغين', 'بلاغات'],
  'طلب': ['طلب واحد', 'طلبين', 'طلبات'],
  'جزاء': ['جزاء واحد', 'جزاءين', 'جزاءات'],
  'تجربة طوارئ': ['تجربة طوارئ واحدة', 'تجربتين طوارئ', 'تجارب طوارئ'],
  'تصريح': ['تصريح واحد', 'تصريحين', 'تصاريح'],
  'عضو': ['عضو واحد', 'عضوين', 'أعضاء'],
  'مادة': ['مادة واحدة', 'مادتين', 'مواد'],
  'فريق': ['فريق واحد', 'فريقين', 'فرق'],
  'موظف': ['موظف واحد', 'موظفين', 'موظفين'],
  'حاضر': ['حاضر واحد', 'حاضرين', 'حاضرين'],
  'يوم': ['يوم واحد', 'يومين', 'أيام'],
  'شهر': ['شهر واحد', 'شهرين', 'شهور'],
  'سنة': ['سنة واحدة', 'سنتين', 'سنين'],
  'قسم': ['قسم واحد', 'قسمين', 'أقسام'],
};
function arCount(n, word) {
  const v = Math.round(Number(n) * 10) / 10;
  const forms = AR_COUNT_FORMS[word];
  if (!forms || !Number.isInteger(v)) return `${v.toLocaleString('en-US')} ${word}`;
  if (v === 1) return forms[0];
  if (v === 2) return forms[1];
  if (v >= 3 && v <= 10) return `${v} ${forms[2]}`;
  return `${v} ${word}`;
}

function stats() {
  return { sections: safetySections.length, items: items.length, vocab: vocab.size, teams: emergencyTeams.length, members: memberEntries.length };
}

module.exports = {
  arCount, HELP_REPLY, isSafetyWord,
  answer, normalizeArabic, stats,
  // أدوات النص مشتركة مع باقي طبقات الشات بوت (SDS / الهيكل الإداري / بياناتي)
  rawTokens, contentTokens, canon, stripAl, editDistance, allowedDistance, STOP,
};
