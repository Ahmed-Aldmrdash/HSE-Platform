// ==========================================================================
// سكريبت تصحيح لمرة واحدة: بيصلّح اسم "مشرف السلامة" (hseName) للبلاغات اللي
// اتستوردت قبل كده من الاكسل بمنطق فيه باج (عمود "safety supervisor" كان
// بيتقرا صفر، فكان دايمًا فاضي)، من غير ما يلمس أي بلاغ اتضاف يدوي من
// العمال نفسهم عن طريق التطبيق.
//
// ازاي يشتغل:
// node backfill_hse_supervisor_names.js [مسار ملف اكسل 1] [مسار ملف اكسل 2] ...
// لو مفيش مسارات، بيدور تلقائيًا على أي ملفات .xlsx في data/ اسمها فيها "hazard".
// بيعمل نسخة احتياطية من data/hazard-reports.json قبل أي تعديل.
// ==========================================================================

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const HAZARDS_FILE = path.join(__dirname, 'data', 'hazard-reports.json');

const EXCEL_FILES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(path.join(__dirname, 'data'))
      .filter(f => /hazard/i.test(f) && /\.xlsx$/i.test(f))
      .map(f => path.join(__dirname, 'data', f));

function normalizeCode(c) {
  return String(c || '').trim().replace(/^0+/, '');
}
function normalizeText(t) {
  return String(t || '').trim().replace(/\s+/g, ' ');
}

async function loadSupervisorMap(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  let colMap = { code: 1, name: 2, dept: 3, pos: 4, hazard: 5, action: 6, area: 7, date: 8, sup: 9, status: 10, location: 11, severity: 12 };
  let headerRowNumber = 1;
  let headersFound = false;
  let ws = wb.worksheets[0];

  for (const sheet of wb.worksheets) {
    sheet.eachRow((row, rowNum) => {
      if (headersFound || rowNum > 5) return;
      const vals = row.values;
      const hasCode = vals.some(v => v && (String(v).toLowerCase().includes('code') || String(v).includes('كود')));
      const hasName = vals.some(v => v && (String(v).toLowerCase().includes('name') || String(v).includes('اسم')));
      if (hasCode && hasName) {
        ws = sheet;
        headerRowNumber = rowNum;
        headersFound = true;
        vals.forEach((v, idx) => {
          if (!v) return;
          const val = String(v).toLowerCase().trim();
          if (val.includes('code') || val.includes('كود')) colMap.code = idx;
          else if (val.includes('name') || val.includes('اسم')) colMap.name = idx;
          else if (val.includes('department') || val.includes('قسم')) {
            if (colMap.deptFound) colMap.area = idx;
            else { colMap.dept = idx; colMap.deptFound = true; }
          }
          else if (val.includes('position') || val.includes('وظيفة') || val.includes('مسمى')) colMap.pos = idx;
          else if (val === 'الخطورة' || val === 'خطورة' || val.includes('severity')) colMap.severity = idx;
          else if (val.includes('supervisor') || val.includes('مشرف')) colMap.sup = idx;
          else if (val.includes('hazard') || val.includes('خطورة') || val.includes('بلاغ') || val.includes('وصف') || val.includes('نوع')) colMap.hazard = idx;
          else if (val.includes('action') || val.includes('إجراء') || val.includes('متخذ')) colMap.action = idx;
          else if (val.includes('location') || val.includes('منطقة')) colMap.location = idx;
          else if (val.includes('date') || val.includes('تاريخ')) colMap.date = idx;
          else if (val.includes('status') || val.includes('حالة')) colMap.status = idx;
        });
      }
    });
    if (headersFound) break;
  }

  const entries = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    const vals = row.values;
    const code = String(vals[colMap.code] || '').trim();
    if (!code || code === 'undefined') return;
    const desc = normalizeText(vals[colMap.hazard]);
    const sup = normalizeText(vals[colMap.sup]);
    if (!sup) return;
    entries.push({ key: normalizeCode(code) + '||' + desc, sup });
  });

  return entries;
}

async function main() {
  if (EXCEL_FILES.length === 0) {
    console.error('❌ مفيش ملفات اكسل اتلاقت. مررهم كـ argument للسكريبت.');
    process.exit(1);
  }
  console.log('هيتقرا الملفات دي:', EXCEL_FILES);

  const supMap = new Map(); // key -> supervisor name
  for (const file of EXCEL_FILES) {
    const entries = await loadSupervisorMap(file);
    entries.forEach(e => supMap.set(e.key, e.sup));
    console.log(`  - ${path.basename(file)}: ${entries.length} صف فيه اسم مشرف`);
  }

  if (!fs.existsSync(HAZARDS_FILE)) {
    console.error('❌ ملف data/hazard-reports.json مش موجود.');
    process.exit(1);
  }

  const stripBom = (str) => typeof str === 'string' && str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;
  const hazards = JSON.parse(stripBom(fs.readFileSync(HAZARDS_FILE, 'utf8')));

  let matched = 0, changed = 0, notFound = 0;
  const updated = hazards.map(h => {
    const key = normalizeCode(h.empCode) + '||' + normalizeText(h.description);
    if (!supMap.has(key)) { notFound++; return h; }
    matched++;
    const sup = supMap.get(key);
    if (h.hseName === sup) return h;
    changed++;
    return { ...h, hseName: sup };
  });

  console.log('----------------------------------------');
  console.log(`إجمالي البلاغات في الملف: ${hazards.length}`);
  console.log(`اتلاقتلهم مطابقة في الاكسل: ${matched}`);
  console.log(`مش موجودين في الاكسل (اتسابوا زي ما هما): ${notFound}`);
  console.log(`فعلاً اتصلح اسم المشرف بتاعهم: ${changed}`);
  console.log('----------------------------------------');

  if (changed === 0) {
    console.log('مفيش حاجة اتغيرت. مش هيتعمل أي حفظ.');
    return;
  }

  const backupPath = HAZARDS_FILE.replace(/\.json$/, `.backup-${Date.now()}.json`);
  fs.copyFileSync(HAZARDS_FILE, backupPath);
  console.log('✅ اتعملت نسخة احتياطية في:', backupPath);

  fs.writeFileSync(HAZARDS_FILE, JSON.stringify(updated, null, 2), 'utf8');
  console.log('✅ تم حفظ التصحيح في data/hazard-reports.json');
}

main().catch(err => {
  console.error('حصل خطأ:', err);
  process.exit(1);
});
