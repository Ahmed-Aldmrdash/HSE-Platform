// ==========================================================================
// سكريبت تصحيح لمرة واحدة: بيصلّح حالة (status) البلاغات اللي اتستوردت
// قبل كده بمنطق فيه باج (كل حاجة كانت بتتقفل)، من غير ما يلمس أي بلاغ
// اتضاف يدوي من العمال نفسهم عن طريق التطبيق.
//
// ازاي يشتغل:
// 1. حط ملفات الاكسل الأصلية في مجلد data/ (أو مرّر المسار كـ argument).
// 2. شغّل: node fix_hazard_statuses_from_excel.js
// 3. هيطلعلك تقرير بعدد البلاغات اللي اتصلحت، وبعدين هيحفظ التعديل.
//    الملف الأصلي بيتعمله نسخة احتياطية قبل أي تعديل (hazard-reports.backup-<وقت>.json)
// ==========================================================================

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const HAZARDS_FILE = path.join(__dirname, 'data', 'hazard-reports.json');

// عدّل المسارات دي لو أسماء الملفات مختلفة عندك
const EXCEL_FILES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      path.join(__dirname, 'data', 'hazard p2 -.xlsx'),
      path.join(__dirname, 'data', 'Hazard p1 -.xlsx')
    ].filter(f => fs.existsSync(f));

function normalizeCode(c) {
  return String(c || '').trim().replace(/^0+/, '');
}

function normalizeText(t) {
  return String(t || '').trim().replace(/\s+/g, ' ');
}

function computeIsClosed(statusText) {
  const normalizedStatus = String(statusText || '').replace(/\s+/g, '');
  const isNotDone = normalizedStatus.includes('لميتم') || normalizedStatus.includes('لمتتم') || normalizedStatus.includes('لميحدث') || normalizedStatus.includes('open') || normalizedStatus.includes('مفتوح');
  const isDone = !isNotDone && (normalizedStatus.includes('تم') || normalizedStatus.includes('closed') || normalizedStatus.includes('مغلق'));
  return isDone;
}

async function loadExcelStatusMap(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  let colMap = { code: 2, name: 3, dept: 4, pos: 5, hazard: 6, action: 7, area: 8, date: 9, sup: 10, status: 11, location: 12 };
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
          const val = String(v).toLowerCase();
          if (val.includes('code') || val.includes('كود')) colMap.code = idx;
          else if (val.includes('name') || val.includes('اسم')) colMap.name = idx;
          else if (val.includes('department') || val.includes('قسم')) {
            if (colMap.deptFound) colMap.area = idx;
            else { colMap.dept = idx; colMap.deptFound = true; }
          }
          else if (val.includes('position') || val.includes('وظيفة') || val.includes('مسمى')) colMap.pos = idx;
          else if (val.includes('hazard') || val.includes('خطورة') || val.includes('بلاغ')) colMap.hazard = idx;
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
    const statusText = String(vals[colMap.status] || '').trim();
    entries.push({
      key: normalizeCode(code) + '||' + desc,
      isClosed: computeIsClosed(statusText),
      statusText
    });
  });

  return entries;
}

async function main() {
  if (EXCEL_FILES.length === 0) {
    console.error('❌ مفيش ملفات اكسل اتلاقت. حط الملفات في مجلد data/ أو مررهم كـ argument للسكريبت.');
    process.exit(1);
  }

  console.log('هيتقرا الملفات دي:', EXCEL_FILES);

  const statusMap = new Map(); // key -> isClosed
  for (const file of EXCEL_FILES) {
    const entries = await loadExcelStatusMap(file);
    entries.forEach(e => statusMap.set(e.key, e.isClosed));
    console.log(`  - ${path.basename(file)}: ${entries.length} صف`);
  }

  if (!fs.existsSync(HAZARDS_FILE)) {
    console.error('❌ ملف data/hazard-reports.json مش موجود.');
    process.exit(1);
  }

  const hazards = JSON.parse(fs.readFileSync(HAZARDS_FILE, 'utf8'));

  let matched = 0, changed = 0, notFound = 0;
  const updated = hazards.map(h => {
    const key = normalizeCode(h.empCode) + '||' + normalizeText(h.description);
    if (!statusMap.has(key)) { notFound++; return h; }
    matched++;
    const isClosed = statusMap.get(key);
    const correctStatus = isClosed ? 'closed' : 'open';
    if (h.status === correctStatus) return h;
    changed++;
    return {
      ...h,
      status: correctStatus,
      treatmentStartedAt: isClosed ? (h.treatmentStartedAt || h.date) : null,
      startedByName: isClosed ? (h.startedByName || 'الصيانة') : '',
      resolvedAt: isClosed ? (h.resolvedAt || h.date) : null,
      assignedToMaintenance: isClosed ? '' : 'الصيانة'
    };
  });

  console.log('----------------------------------------');
  console.log(`إجمالي البلاغات في الملف: ${hazards.length}`);
  console.log(`اتلاقتلهم مطابقة في الاكسل: ${matched}`);
  console.log(`مش موجودين في الاكسل (اتسابوا زي ما هما - غالباً بلاغات اتضافت من التطبيق نفسه): ${notFound}`);
  console.log(`فعلاً اتصلحت حالتهم: ${changed}`);
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
