// ============================================================
// lib/chatbot-sds.js — أسئلة نشرات بيانات السلامة الكيميائية (SDS)
// ============================================================
// المصدر: lib/kb/sds.json — 127 كارت SDS بتاعة المصنع (نفس اللي اتبعتت قبل
// كده من بشمهندس أحمد). البوت بيلاقي المادة حتى لو اسمها مكتوب غلط أو
// بالعربي بدل الإنجليزي ("كاربون بلاك" = carbon black)، وبيرد على الجزء
// اللي اتسأل عنه بس (إسعافات الجلد، الإطفاء، التخزين، الانسكاب...).
'use strict';

const { normalizeArabic, rawTokens, canon, stripAl, editDistance, allowedDistance, STOP } = require('./chatbot-kb');
const RAW = require('./kb/sds.json');

const SOURCE = 'نشرات بيانات السلامة الكيميائية (SDS) الخاصة بالمصنع';

const cleanName = s => String(s || '').replace(/^[\s:：\-–—.]+/, '').replace(/[\s\-–—:]+$/, '').replace(/\s+/g, ' ').trim();
const flat = s => normalizeArabic(s).replace(/\s/g, '');

// أسماء إنجليزية بيكتبها الناس بالعربي — بتتضاف لكلمات المادة وقت الفهرسة
const ALIASES = {
  carbon: ['كاربون', 'كربون'], black: ['بلاك'], titanium: ['تيتانيوم'], dioxide: ['ثاني'],
  calcium: ['كالسيوم'], caco3: ['كاكو', 'كربونات'], polyethylene: ['بولي', 'اثيلين', 'ايثيلين'],
  polypropylene: ['بروبلين', 'بروبيلين'], pvc: ['ريزن', 'فينيل'], styrene: ['ستايرين', 'ستيرين'],
  dop: ['دوب'], lead: ['رصاص'], stabilizer: ['ستابلايزر', 'مثبت'], zinc: ['زنك'], cobalt: ['كوبلت', 'كوبالت'],
  peroxide: ['بروكسيد', 'بيروكسيد'], wax: ['شمع', 'واكس'], pigment: ['صبغه', 'بيجمنت'], silica: ['سيليكا'],
  aluminium: ['الومنيوم', 'الومونيوم'], antimony: ['انتيمون'], magnesium: ['ماغنسيوم', 'مغنسيوم'],
  oil: ['زيت'], motor: ['موتور'], acetate: ['اسيتات'], acetone: ['اسيتون'], toluene: ['تولوين', 'طولوين'],
  methanol: ['ميثانول'], ethanol: ['ايثانول', 'كحول'], chloroform: ['كلوروفورم'], xlpe: ['اكس ال بي اي'],
  irganox: ['ارجانوكس', 'ايرجانوكس'], irgafos: ['ارجافوس', 'ايرجافوس'], iron: ['حديد'], oxide: ['اكسيد'],
  hydroxide: ['هيدروكسيد'], blue: ['ازرق'], red: ['احمر'], yellow: ['اصفر'], green: ['اخضر'], violet: ['بنفسجي'],
};

const ASPECTS = [
  { key: 'health', re: /اسعاف|جلد|عين|عيني|عينه|ابتلاع|بلع|بلعها|شربها|استنشاق|اتنفس|تنفس|خطر|خطوره|مخاطر|ضرر|اضرار|صحي|سام|سميه|تسمم|حروق|تهيج|اتلمس|لمس/ },
  { key: 'fire', re: /حريق|اشتعال|اطفا|طفايه|وميض|flash|ولع|نار|تولع/ },
  { key: 'storage', re: /تخزين|خزن|اخزن|يتخزن|تتخزن|تداول|نقل/ },
  { key: 'spill', re: /انسكاب|اندلق|دلق|تسريب|سربت|انسكب|اتدلق|وقعت ع الارض/ },
  { key: 'physical', re: /خواص|شكل|لون|ريحه|رايحه|رائحه/ },
  { key: 'stability', re: /ثبات|تفاعل|يتفاعل|موكسد|مؤكسد|يتعارض|تتعارض/ },
  { key: 'usage', re: /بيستخدم|تستخدم|بتستخدم|استخدام|مكان الاستخدام|فين بيت|فين تتخزن|مكانها/ },
  { key: 'ppe', re: /وقايه|مهمات|البس|ارتدي|جوانتي|كمامه|نظاره|قفاز/ },
];
const ORGANS = [
  { key: 'skin', re: /جلد/, label: 'الجلد' },
  { key: 'eye', re: /عين/, label: 'العين' },
  { key: 'ingestion', re: /ابتلاع|بلع|شرب|اكل/, label: 'الابتلاع' },
  { key: 'inhalation', re: /استنشاق|تنفس|نفس|شم/, label: 'الجهاز التنفسي' },
];
const SECTION_HEADERS = [
  { key: 'storage', re: /^التخزين والتداول/ },
  { key: 'spill', re: /^التحكم عند الانسكاب/ },
  { key: 'physical', re: /^الخواص الفيزياييه/ },
  { key: 'stability', re: /^الثبات والتفاعليه/ },
  { key: 'ppe', re: /^مهمات الوقايه/ },
];
const NOISE = /SE-10-F03|VER\.NO|SDS Number|قائمه بيان|قايمه بيان|^مخاطر صحيه$/;

function parseCard(entry) {
  const lines = String(entry.content || '').split('\n').map(l => l.trim()).filter(Boolean);
  const field = re => {
    const l = lines.find(x => re.test(flat(x)));
    return l ? cleanName(l.split(':').slice(1).join(':')) : '';
  };
  const card = {
    id: entry.id,
    name: cleanName(entry.name) || cleanName(entry.fileName),
    scientific: cleanName(entry.scientific),
    fileName: cleanName(entry.fileName),
    source: entry.source,
    code: field(/^كودالماده:/),
    usage: field(/^مكانالاستخدام:/),
    storagePlace: field(/^مكانالتخزين:/),
    health: [], fire: null, sections: {},
  };
  const hIdx = lines.findIndex(l => /الاخطار الصحي/.test(normalizeArabic(l)));
  const fIdx = lines.findIndex(l => /قابليه الاشتعال/.test(normalizeArabic(l)));
  if (hIdx !== -1) {
    for (let i = hIdx + 1; i < (fIdx === -1 ? lines.length : fIdx); i++) {
      const parts = lines[i].split('|').map(s => s.trim());
      if (parts.length >= 2 && !NOISE.test(lines[i])) {
        card.health.push({ organ: normalizeArabic(parts[0]).replace(/\s+/g, ' ').trim(), hazard: parts[1] || '', aid: parts[2] || '' });
      }
    }
  }
  if (fIdx !== -1 && lines[fIdx + 1]) {
    const p = lines[fIdx + 1].split('|').map(s => s.trim());
    card.fire = { flashPoint: p[0] || '', media: p[1] || '', unsuitable: p[2] || '' };
  }
  let current = null;
  for (let i = (fIdx === -1 ? 0 : fIdx + 2); i < lines.length; i++) {
    const line = lines[i];
    if (NOISE.test(line)) continue;
    const nl = normalizeArabic(line);
    const hdr = SECTION_HEADERS.find(h => h.re.test(nl));
    if (hdr) {
      current = hdr.key;
      const rest = line.split('|').slice(1).join('|').trim();
      card.sections[current] = rest ? [rest] : [];
    } else if (current) {
      card.sections[current].push(line);
    }
  }
  return card;
}

const CARDS = RAW.map(parseCard).filter(c => c.name);

// ── فهرس أسماء المواد ────────────────────────────────────────────
const NAME_STOP = new Set(['msds', 'sds', 'resin', 'ماده', 'حمض', 'the', 'of', 'in', 'for', 'and', 'class', 'ci', 'cas']);
CARDS.forEach(c => {
  const text = [c.name, c.scientific, c.fileName].join(' ');
  const toks = new Set();
  rawTokens(text).forEach(t => {
    if (t.length < 2 || NAME_STOP.has(t)) return;
    if (/^\d+$/.test(t) && t.length < 3) return;
    toks.add(t); toks.add(stripAl(t));
    (ALIASES[t] || []).forEach(a => toks.add(normalizeArabic(a)));
  });
  c.tokens = [...toks];
  // كلمات الاسم الأساسي بس — عشان "أسيتون" يجيب الأسيتون نفسه قبل "acetyl acetone peroxide"
  c.nameTokens = new Set();
  rawTokens(c.name).forEach(t => {
    if (t.length < 2 || NAME_STOP.has(t)) return;
    c.nameTokens.add(t); c.nameTokens.add(stripAl(t));
    (ALIASES[t] || []).forEach(a => c.nameTokens.add(normalizeArabic(a)));
  });
  c.display = c.scientific && flat(c.scientific) !== flat(c.name) ? `${c.name} (${c.scientific})` : c.name;
});
const tokDf = new Map();
CARDS.forEach(c => new Set(c.tokens).forEach(t => tokDf.set(t, (tokDf.get(t) || 0) + 1)));
const tokIdf = t => Math.log(1 + CARDS.length / (tokDf.get(t) || 1));

const QUERY_NOISE = new Set(['sds', 'msds', 'نشره', 'نشرة', 'داتا', 'شيت', 'ماده', 'الماده', 'كيماوي', 'كيميايي', 'كيميايه', 'بيانات', 'السلامه', 'سلامه']);

// أماكن تعليمات السلامة ("غرفة الكربون"، "غرفة توزين") — كلماتها مش اسم مادة
const { safetySections } = require('./kb');
const { isSafetyWord } = require('./chatbot-kb');
const pairKey = (a, b) => `${stripAl(a)} ${stripAl(b)}`;
const PLACE_PAIRS = new Set();
safetySections.forEach(s => {
  const t = rawTokens(s.place);
  for (let i = 0; i + 1 < t.length; i++) PLACE_PAIRS.add(pairKey(t[i], t[i + 1]));
});

function matchMaterials(question) {
  const all = rawTokens(question);
  const drop = new Set();
  for (let i = 0; i + 1 < all.length; i++) {
    if (PLACE_PAIRS.has(pairKey(all[i], all[i + 1]))) { drop.add(i); drop.add(i + 1); }
  }
  const qToks = all.filter((t, i) => !drop.has(i) && t.length >= 2 && !STOP.has(t) && !QUERY_NOISE.has(t));
  if (!qToks.length) return [];
  // كلمة معروفة من تعليمات السلامة ("التوزين") متتقربش لاسم مادة ("طولوين")
  const fuzzyOk = new Map(qToks.map(q => [q, !isSafetyWord(q)]));
  const scored = CARDS.map(c => {
    let score = 0, nameHits = 0;
    qToks.forEach(q => {
      let best = 0, bestInName = false;
      c.tokens.forEach(t => {
        let w = 0;
        if (q === t || stripAl(q) === t || canon(q) === canon(t)) w = 1;
        else if (fuzzyOk.get(q) && !/^\d+$/.test(t) && t.length >= 5 && q.length >= 4) {
          const max = allowedDistance(Math.min(t.length, q.length));
          const d = max ? editDistance(stripAl(q), t, max) : 1;
          // التقريب بحرفين لازم أول حرف يبقى صح ("مديرين" مش "ستيرين")
          if (max && d <= max && (d < 2 || stripAl(q)[0] === t[0])) w = 0.7;
        }
        const v = w * tokIdf(t);
        if (v > best) { best = v; bestInName = w === 1 && c.nameTokens.has(t); }
      });
      score += best;
      if (bestInName) nameHits++;
    });
    // تفضيل المادة اللي اسمها الأساسي اتذكر كامل (مش مجرد كلمة في اسمها العلمي)
    const coverage = c.nameTokens.size ? Math.min(1, nameHits / c.nameTokens.size) : 0;
    return { c, score: score > 0 ? score + coverage * 2 : 0 };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const top = scored[0];
  if (top.score < 2.2) return [];
  return scored.filter(x => x.score >= top.score * 0.9);
}

function detectAspects(question) {
  const nq = normalizeArabic(question);
  return ASPECTS.filter(a => a.re.test(nq)).map(a => a.key);
}

function healthLines(card, question) {
  const nq = normalizeArabic(question);
  const wanted = ORGANS.filter(o => o.re.test(nq));
  const rows = wanted.length
    ? card.health.filter(h => wanted.some(o => o.re.test(h.organ)))
    : card.health;
  return (rows.length ? rows : card.health).map(h => `• ${h.organ}: ${h.hazard}${h.aid ? `\n   ⛑️ الإسعاف: ${h.aid}` : ''}`);
}

function sectionText(card, key) {
  const lines = card.sections[key] || [];
  return lines.length ? lines.map(l => `• ${l}`).join('\n') : '';
}

function formatCard(card, aspects, question) {
  const out = [`🧪 ${card.display}`];
  if (card.code) out.push(`كود المادة: ${card.code}`);
  const all = !aspects.length;
  if (all || aspects.includes('usage')) {
    if (card.usage || card.storagePlace) out.push(`📍 مكان الاستخدام: ${card.usage || '—'} | مكان التخزين: ${card.storagePlace || '—'}`);
  }
  if (all || aspects.includes('health')) {
    if (card.health.length) out.push(`⚠️ المخاطر الصحية والإسعافات الأولية:\n${healthLines(card, question).join('\n')}`);
  }
  if (all || aspects.includes('fire')) {
    if (card.fire) out.push(`🔥 الاشتعال والإطفاء:\n• نقطة الوميض: ${card.fire.flashPoint || '—'}\n• وسائل الإطفاء المناسبة: ${card.fire.media || '—'}\n• ممنوع: ${card.fire.unsuitable || '—'}`);
  }
  const labels = { storage: '📦 التخزين والتداول', spill: '🧯 التحكم عند الانسكاب', physical: '🔬 الخواص الفيزيائية', stability: '⚗️ الثبات والتفاعلية', ppe: '🦺 مهمات الوقاية الشخصية' };
  ['storage', 'spill', 'stability', 'physical', 'ppe'].forEach(k => {
    if (!(all || aspects.includes(k))) return;
    const txt = sectionText(card, k);
    if (txt) out.push(`${labels[k]}:\n${txt}`);
    else if (k === 'ppe' && aspects.includes('ppe')) out.push(`${labels.ppe}: الكارت ده مفيهوش تفاصيل مكتوبة لمهمات الوقاية (غالبًا بتكون رموز مصوّرة في النسخة الورقية) — راجع مشرف السلامة أو الكارت المعلّق في مكان التخزين.`);
  });
  if (out.length === 1) out.push('الجزء اللي سألت عنه مش مكتوب في كارت المادة دي. جرّب تسأل عن: الإسعافات، الإطفاء، التخزين، أو الانسكاب.');
  return out.join('\n\n');
}

function listMaterials() {
  const names = [...new Set(CARDS.map(c => c.name))].sort((a, b) => a.localeCompare(b, 'ar'));
  return {
    reply: `عندي كروت SDS لـ ${names.length} مادة:\n${names.join('، ')}\n\nاسألني عن أي مادة بالاسم، مثلاً: "إسعافات الأسيتون لو وقع على الجلد" أو "إزاي أطفي حريق الطولوين".`,
    source: SOURCE,
  };
}

const SDS_WORD = /(^|\s)(sds|msds|ام اس دي اس|داتا شيت|داتاشيت|نشره السلامه|نشرات السلامه|كارت الماده|المواد الكيماويه|الماده الكيماويه|كيماويات)(\s|$)/;
const LIST_WORD = /(كل|قايمه|قائمه|ايه|انهي|اسما|اسماء).*(المواد|الكيماويات|sds)|المواد اللي عندك|المواد المتاحه/;

/** يرجع رد لو السؤال عن مادة كيميائية (أو قائمة المواد)، وإلا null */
function answerSds(question) {
  const nq = normalizeArabic(question);
  const mentionsSds = SDS_WORD.test(nq);
  if (mentionsSds && LIST_WORD.test(nq)) return listMaterials();
  const matches = matchMaterials(question);
  if (!matches.length) {
    if (mentionsSds) return listMaterials();
    return null;
  }
  const distinct = [];
  matches.forEach(m => { if (!distinct.some(d => flat(d.c.name) === flat(m.c.name))) distinct.push(m); });
  if (distinct.length > 1 && distinct.length <= 6) {
    return {
      reply: `لقيت أكتر من مادة قريبة من كلامك — تقصد أنهي؟\n${distinct.map(d => `• ${d.c.display}`).join('\n')}`,
      source: SOURCE,
      suggestions: distinct.slice(0, 4).map(d => `SDS ${d.c.name}`),
    };
  }
  if (distinct.length > 6 && !mentionsSds) return null;
  const card = distinct[0].c;
  const aspects = detectAspects(question);
  return {
    reply: formatCard(card, aspects, question),
    source: `${SOURCE} — ${card.source || card.fileName}`,
    suggestions: ['health', 'fire', 'storage', 'spill'].filter(a => !aspects.includes(a)).slice(0, 3).map(a => ({
      health: `إسعافات ${card.name}`, fire: `إطفاء حريق ${card.name}`, storage: `تخزين ${card.name}`, spill: `انسكاب ${card.name}`,
    })[a]),
  };
}

module.exports = { answerSds, listMaterials, count: CARDS.length };
