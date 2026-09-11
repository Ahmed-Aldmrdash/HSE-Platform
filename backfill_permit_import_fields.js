// ==========================================================================
// سكريبت تصحيح لمرة واحدة: بيصلّح التصاريح القديمة اللي اتستوردت قبل تصحيح
// باج قراءة الأعمدة في lib/permits-excel-parser.js (كان بيسيب "اعتمدته الإدارة"
// = "استيراد سجل قديم" وبيسيب الوقت فاضي لأن أعمدة زي "مشرف السلامه" /
// "مدير المنطقه" / "No. PTW" / عمود الوقت المدموج مكنتش بتتعرف صح).
//
// السكريبت ده بيعيد قراءة نفس ملفات الإكسل القديمة بالمنطق المصحح، وبيدور على
// كل تصريح isImportedLegacy=true وناقصه بيانات في data/storage.json، ويكمّلها
// من غير ما يضيف صفوف جديدة أو يلمس أي تصريح مش مستورد أو سليم أصلًا.
//
// إزاي يشتغل:
//   node backfill_permit_import_fields.js [مسار ملف اكسل 1] [مسار ملف اكسل 2] ...
// لو مفيش مسارات، بيدور تلقائيًا على ملفات .xlsx في data/ اسمها فيه "تصريح" أو "ptw".
// بيعمل نسخة احتياطية من data/storage.json قبل أي تعديل.
// ==========================================================================

const fs = require('fs');
const path = require('path');
const { parsePermitsWorkbook } = require('./lib/permits-excel-parser');

const DATA_DIR = path.join(__dirname, 'data');
const STORAGE_FILE = path.join(DATA_DIR, 'storage.json');

const EXCEL_FILES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(DATA_DIR)
      .filter(f => /\.xlsx$/i.test(f) && (/تصريح/i.test(f) || /ptw/i.test(f)))
      .map(f => path.join(DATA_DIR, f));

function normalize(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

// مفتاح مطابقة اعتمادًا على الحقول اللي كانت بتتقرا صح دايمًا حتى قبل التصحيح
// (التاريخ / القسم / الوصف) — عشان نلاقي نفس الصف حتى لو رقم التصريح أو
// الوقت أو اسم مشرف السلامة كانوا فاضيين بسبب الباج القديم.
function matchKey(p) {
  return [p.date, normalize(p.department), normalize(p.description)].join('||');
}

async function main() {
  if (EXCEL_FILES.length === 0) {
    console.error('❌ مفيش ملفات إكسل اتلاقت. مررها كـ argument للسكريبت، مثال:');
    console.error('   node backfill_permit_import_fields.js "data/PTW_P1.xlsx" "data/سجل متابعة تصاريح العمل.xlsx"');
    process.exit(1);
  }
  console.log('هيتقرا الملفات دي:', EXCEL_FILES);

  const freshMap = new Map(); // matchKey -> أحدث صف مقروء صح من الإكسل
  let dupCount = 0;
  for (const file of EXCEL_FILES) {
    const buf = fs.readFileSync(file);
    const { importedPermits } = await parsePermitsWorkbook(buf, []);
    importedPermits.forEach(p => {
      const key = matchKey(p);
      if (freshMap.has(key)) { dupCount++; return; } // أول تطابق بس لو فيه تكرار نفس المفتاح
      freshMap.set(key, p);
    });
    console.log(`  - ${path.basename(file)}: ${importedPermits.length} صف`);
  }
  if (dupCount) console.log(`  (${dupCount} صف اتجاهل لتكرار نفس التاريخ/القسم/الوصف)`);

  if (!fs.existsSync(STORAGE_FILE)) {
    console.error('❌ ملف data/storage.json مش موجود.');
    process.exit(1);
  }

  const stripBom = (str) => (typeof str === 'string' && str.charCodeAt(0) === 0xFEFF) ? str.slice(1) : str;
  const storage = JSON.parse(stripBom(fs.readFileSync(STORAGE_FILE, 'utf8')));
  let permits;
  try { permits = JSON.parse(storage['work-permits'] || '[]'); }
  catch (e) { console.error('❌ تعذر قراءة work-permits من storage.json:', e.message); process.exit(1); }

  let matched = 0, changed = 0, notFound = 0, alreadyOk = 0;
  const updated = permits.map(p => {
    if (!p.isImportedLegacy) return p; // منلمسش أي تصريح متسجل عادي من التطبيق
    const broken = (p.reviewedBy === 'استيراد سجل قديم') || !p.timeFrom || !p.timeTo || !p.previousPermitNo;
    if (!broken) { alreadyOk++; return p; }

    const fresh = freshMap.get(matchKey(p));
    if (!fresh) { notFound++; return p; }
    matched++;

    const next = { ...p };
    if (p.reviewedBy === 'استيراد سجل قديم' && fresh.reviewedBy && fresh.reviewedBy !== 'استيراد سجل قديم') {
      next.reviewedBy = fresh.reviewedBy;
      next.safetyOfficerName = fresh.safetyOfficerName;
    }
    if (!p.timeFrom && fresh.timeFrom) next.timeFrom = fresh.timeFrom;
    if (!p.timeTo && fresh.timeTo) next.timeTo = fresh.timeTo;
    if (!p.previousPermitNo && fresh.previousPermitNo) next.previousPermitNo = fresh.previousPermitNo;
    if (!p.areaHeadReviewedBy && fresh.areaHeadReviewedBy) next.areaHeadReviewedBy = fresh.areaHeadReviewedBy;
    if (!p.areaManagerName && fresh.areaManagerName) next.areaManagerName = fresh.areaManagerName;

    if (JSON.stringify(next) !== JSON.stringify(p)) changed++;
    return next;
  });

  console.log(`مطابقة: ${matched} | اتصحح فعليًا: ${changed} | مالوش مطابقة في الإكسل: ${notFound} | كان سليم أصلًا: ${alreadyOk}`);

  if (changed === 0) {
    console.log('مفيش حاجة اتغيرت — مش هيتكتب أي ملف.');
    return;
  }

  const backupFile = STORAGE_FILE + '.backup-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(STORAGE_FILE, backupFile);
  console.log('✅ اتعمل باك أب قبل التعديل في:', backupFile);

  storage['work-permits'] = JSON.stringify(updated);
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(storage, null, 2), 'utf8');
  console.log('✅ اتحفظ data/storage.json بالتعديلات.');
}

main().catch(err => { console.error('❌ خطأ:', err); process.exit(1); });
