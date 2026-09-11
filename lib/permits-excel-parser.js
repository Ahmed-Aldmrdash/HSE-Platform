// ============================================================================
// Shared parser لملفات إكسل تصاريح العمل القديمة (PTW).
// اتفصلت في ملف مستقل عشان تتستخدم في مكانين من غير ما نكرر نفس المنطق:
//   1) POST /api/permits/upload-excel  (استيراد لايف من الأدمن بانل)
//   2) scripts/backfill_permit_import_fields.js  (تصحيح تصاريح اتستوردت غلط قبل كده)
//
// ليه الملف ده موجود أصلًا: الشيتات القديمة مش موحّدة في تسمية الأعمدة —
// "مشرف السلامه" في شيت و"مسئول السلامة" في تاني، "PTW No." في شيت و"No. PTW" في
// تاني، وعمود الوقت أحيانًا مدموج (Time -> Start/End في صف تحته) وأحيانًا عمودين
// منفصلين (بداية التصريح / نهاية التصريح). المطابقة هنا بتعتمد على "جذر" الكلمة
// (زي "سلام" أو "منطق") عشان تستحمل اختلاف التاء المربوطة/الهاء وأي بادئة
// (مسئول/مسؤول/مشرف) بدل ما تدور على عبارة ثابتة بالظبط.
// ============================================================================

const ExcelJS = require('exceljs');

const TYPE_MAP = [
  { key: 'hot',        words: ['ساخن', 'hot'] },
  { key: 'lockout',    words: ['فصل', 'عزل', 'lockout'] },
  { key: 'height',     words: ['ارتفاع', 'height'] },
  { key: 'excavation', words: ['حفر', 'excavation'] },
  { key: 'confined',   words: ['اماكن مغلقة', 'أماكن مغلقة', 'confined'] },
  { key: 'lifting',    words: ['رفع', 'lifting'] },
  { key: 'general',    words: ['عام', 'general'] }
];

function mapTypeKey(label) {
  const l = String(label || '').trim();
  for (const t of TYPE_MAP) {
    if (t.words.some(w => l.includes(w))) return t.key;
  }
  return 'general';
}

// بيحوّل أي قيمة وقت جاية من إكسل (خلية وقت/تاريخ، رقم تسلسلي، أو نص زي
// "9:00AM" / "٩:٠٠ص" / "14:30") لصيغة موحدة "HH:MM" بنظام 24 ساعة —
// نفس الصيغة اللي بيرجعها <input type="time"> في فورم الإضافة اليدوية،
// عشان formatTime12() في app.js تقدر تعرضها صح.
function parseExcelTimeTo24h(value) {
  if (value === null || value === undefined || value === '') return '';

  // خلية وقت/تاريخ حقيقية — ExcelJS بيرجعها Date بيتوقيت UTC
  if (value instanceof Date) {
    const h = value.getUTCHours();
    const m = value.getUTCMinutes();
    if (Number.isNaN(h) || Number.isNaN(m)) return '';
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // رقم تسلسلي إكسل (كسر من اليوم، مثلاً 0.375 = 9:00 ص)
  if (typeof value === 'number') {
    const totalMinutes = Math.round((value % 1) * 24 * 60);
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // نص: "9:00AM"، "3:00 PM"، "14:30"، أرقام عربية "٩:٠٠ص"...
  let str = String(value).trim();
  if (!str) return '';
  const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
  str = str.replace(/[٠-٩]/g, d => String(arabicDigits.indexOf(d)));
  str = str.replace(/\s+/g, '');
  const m = str.match(/^(\d{1,2}):(\d{2})(am|pm|ص|م)?$/i);
  if (!m) return '';
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const suffix = m[3] ? m[3].toLowerCase() : '';
  if (suffix) {
    const isPM = suffix === 'pm' || suffix === 'م';
    const isAM = suffix === 'am' || suffix === 'ص';
    if (isPM && h < 12) h += 12;
    if (isAM && h === 12) h = 0;
  }
  if (h > 23 || min > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// بيقرا الهيدر ويحدد فهرس كل عمود، معتمدًا على "جذر" الكلمة العربي أو
// الإنجليزية مش عبارة ثابتة، عشان يستحمل اختلافات زي:
//  - "مسئول السلامة" / "مشرف السلامه" / "safety supervisor"  → عمود واحد (سلام)
//  - "مدير المنطقة" / "مدير المنطقه" / "Area Manager"        → عمود واحد (منطق)
//  - "PTW No." / "No. PTW" / "رقم التصريح"                    → عمود واحد
function detectHeaderAndColumns(sheet) {
  let headerRowNumber = 0;
  const colMap = {};

  sheet.eachRow((row, rowNum) => {
    if (headerRowNumber || rowNum > 6) return;
    const vals = row.values.map(v => (v == null ? '' : String(v).trim()));
    const joinedLower = vals.join(' ').toLowerCase();
    const hasPtwNo = joinedLower.includes('ptw') || vals.some(v => v.includes('تصريح'));
    const hasDate  = joinedLower.includes('date') || vals.some(v => v.includes('تاريخ'));
    if (!hasPtwNo || !hasDate) return;

    headerRowNumber = rowNum;
    vals.forEach((v, idx) => {
      if (!v) return;
      const val = v.toLowerCase();
      if (!colMap.ptwNo && ((val.includes('رقم') && val.includes('تصريح')) || val.includes('ptw'))) colMap.ptwNo = idx;
      else if (!colMap.timeFrom && (val.includes('بداية') || val.includes('start'))) colMap.timeFrom = idx;
      else if (!colMap.timeTo && (val.includes('نهاية') || val.includes('end'))) colMap.timeTo = idx;
      else if (!colMap.type && (val.includes('نوع') || val.includes('type'))) colMap.type = idx;
      else if (!colMap.dept && (val.includes('قسم') || val.includes('department'))) colMap.dept = idx;
      else if (!colMap.shift && (val.includes('وردية') || val.includes('shift'))) colMap.shift = idx;
      else if (!colMap.desc && (val.includes('وصف') || val.includes('description') || val.includes('detail'))) colMap.desc = idx;
      else if (!colMap.date && (val.includes('تاريخ') || val.includes('date'))) colMap.date = idx;
      else if (!colMap.executive && (val.includes('تنفيذ') || val.includes('executive'))) colMap.executive = idx;
      else if (!colMap.safety && (val.includes('سلام') || val.includes('safety'))) colMap.safety = idx;
      else if (!colMap.areaManager && (val.includes('منطق') || val.includes('area manager') || (val.includes('area') && val.includes('manager')))) colMap.areaManager = idx;
      else if (!colMap.location && (val.includes('موقع') || val.includes('location'))) colMap.location = idx;
      else if (!colMap.timeMain && (val.includes('وقت') || val.includes('time'))) colMap.timeMain = idx;
    });
  });

  if (!headerRowNumber) return { headerRowNumber: 0, colMap };

  // لو لقينا عمود "الوقت/Time" مدموج من غير عمودين "بداية/نهاية" واضحين في
  // نفس صف الهيدر، ندوّر في الصفوف اللي بعده (لحد 3 صفوف) على تسميات فرعية
  // زي "من/الي" أو "Start/End". لو مالقيناش، نفترض إن العمودين اللي بعد
  // "الوقت" مباشرة هما من/إلى بنفس الترتيب (نمط ثابت في كل الملفات اللي شفناها).
  if (colMap.timeMain != null && colMap.timeFrom == null && colMap.timeTo == null) {
    for (let off = 1; off <= 3; off++) {
      const subRow = sheet.getRow(headerRowNumber + off);
      const c1 = String(subRow.getCell(colMap.timeMain).value || '').trim().toLowerCase();
      const c2 = String(subRow.getCell(colMap.timeMain + 1).value || '').trim().toLowerCase();
      if (colMap.timeFrom == null && (c1.includes('من') || c1.includes('start') || c1.includes('بداية'))) {
        colMap.timeFrom = colMap.timeMain;
      }
      if (colMap.timeTo == null && (c2.includes('الي') || c2.includes('الى') || c2.includes('إلى') || c2.includes('end') || c2.includes('نهاية'))) {
        colMap.timeTo = colMap.timeMain + 1;
      }
      if (colMap.timeFrom != null && colMap.timeTo != null) break;
    }
    if (colMap.timeFrom == null) colMap.timeFrom = colMap.timeMain;
    if (colMap.timeTo == null) colMap.timeTo = colMap.timeMain + 1;
  }

  return { headerRowNumber, colMap };
}

// بيرجع { importedPermits, skippedRows } لملف إكسل تصاريح قديم.
// employees: مصفوفة موظفين (من readEmployees()) عشان نربط كل تصريح بصاحبه لو الاسم متطابق.
async function parsePermitsWorkbook(buffer, employees) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const nameToEmp = new Map();
  (employees || []).forEach(e => {
    const n = String(e.name || '').trim();
    if (n) nameToEmp.set(n, e);
  });

  const importedPermits = [];
  let skippedRows = 0;

  for (const sheet of workbook.worksheets) {
    const { headerRowNumber, colMap } = detectHeaderAndColumns(sheet);
    if (!headerRowNumber) continue; // مفيش هيدر في الشيت ده، تخطاه

    sheet.eachRow((row, rowNum) => {
      if (rowNum <= headerRowNumber) return;
      const vals = row.values;
      const ptwNo = String(vals[colMap.ptwNo] || '').trim();
      const desc  = String(vals[colMap.desc]  || '').trim();
      if (!ptwNo && !desc) { skippedRows++; return; } // صف فاضي

      let d = null;
      const dateVal = vals[colMap.date];
      if (dateVal instanceof Date) {
        d = dateVal;
      } else if (typeof dateVal === 'number') {
        d = new Date(Math.round((dateVal - 25569) * 86400 * 1000));
      } else if (typeof dateVal === 'string') {
        const parsed = new Date(dateVal.trim());
        if (!isNaN(parsed.getTime())) d = parsed;
      }
      if (!d || isNaN(d.getTime())) d = new Date();
      const dateStr = d.toISOString().split('T')[0];

      const typeLabelRaw    = String(vals[colMap.type] || 'عام').trim();
      const executiveName   = String(vals[colMap.executive]   || '').trim();
      const safetyName      = String(vals[colMap.safety]      || '').trim();
      const areaManagerName = String(vals[colMap.areaManager] || '').trim();
      const workerName      = executiveName || safetyName || 'غير محدد';
      const matchedEmp      = nameToEmp.get(executiveName) || nameToEmp.get(safetyName) || null;
      const timeFrom = parseExcelTimeTo24h(vals[colMap.timeFrom]);
      const timeTo   = parseExcelTimeTo24h(vals[colMap.timeTo]);

      // ملاحظة: "مشرف السلامه"/"مسئول السلامة" (safetyName) هو اللي بيظهر في
      // الكارت كـ"اعتمدته الإدارة"، و"مدير المنطقة"/"مدير المنطقه" (areaManagerName)
      // هو اللي بيظهر كـ"موافقة رئيس منطقة" — لازم نسيبهم فاضيين لو الخانة
      // فاضية في الإكسل بدل ما نحط نص بديل أو نلخبط بعمود التنفيذ.
      importedPermits.push({
        id:               'OLD-' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '-' + rowNum,
        typeKey:          mapTypeKey(typeLabelRaw),
        typeLabel:        typeLabelRaw,
        typeFullLabel:    typeLabelRaw,
        department:       String(vals[colMap.dept] || '').trim(),
        shift:            String(vals[colMap.shift] || '').trim(),
        date:             dateStr,
        previousPermitNo: ptwNo,
        timeFrom:         timeFrom,
        timeTo:           timeTo,
        workerName:       workerName,
        requesterKind:    'موظف',
        requesterPhone:   '',
        employeeId:       matchedEmp ? String(matchedEmp.empCode || matchedEmp.code || '') : '',
        description:      desc,
        location:         String(vals[colMap.location] || '').trim(),
        equipment:        '',
        tools:            [],
        workersNames:     '',
        checklist:        [],
        checklistNote:    '',
        risks:            [],
        status:           'approved',
        reviewedBy:       safetyName,
        reviewedAt:       dateStr,
        reviewNote:       'مستورد من سجل تصاريح عمل قديم (Excel)',
        closure:          null,
        areaHeadReviewedBy:  areaManagerName,
        areaHeadReviewedAt:  dateStr,
        safetyOfficerName:   safetyName,
        areaManagerName:     areaManagerName,
        isImportedLegacy:    true,
        deletedBy: { areaAdmin: false, safetyAdmin: false, superAdmin: false, worker: false },
        createdAt: dateStr
      });
    });
  }

  return { importedPermits, skippedRows };
}

module.exports = { parsePermitsWorkbook, parseExcelTimeTo24h, mapTypeKey };
