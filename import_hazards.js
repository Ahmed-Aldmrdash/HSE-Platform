const fs = require('fs');
const ExcelJS = require('exceljs');

const HAZARDS_FILE = 'data/hazard-reports.json';
const EXCEL_FILE = 'data/hazard p2 -.xlsx';

async function importHazards() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(EXCEL_FILE);
  const ws = wb.worksheets[0];

  const importedHazards = [];

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const vals = row.values;
    
    // exceljs row.values is 1-indexed
    const code = String(vals[2] || '').trim();
    if (!code || code === 'undefined') return;

    const name = String(vals[3] || '').trim();
    const reporterDept = String(vals[4] || '').trim();
    const desc = String(vals[6] || '').trim();
    const action = String(vals[7] || '').trim();
    const location = String(vals[12] || '').trim();
    const statusText = String(vals[11] || '').trim();
    
    // Find date (could be shifted in some rows)
    let d = null;
    for (let i = 8; i <= 10; i++) {
      if (vals[i] instanceof Date) {
        d = vals[i];
        break;
      }
      if (typeof vals[i] === 'string') {
        const parsed = new Date(vals[i].trim());
        if (!isNaN(parsed.getTime())) {
          d = parsed;
          break;
        }
      }
    }
    
    if (!d || isNaN(d.getTime())) {
      console.warn(`No valid date found at row ${rowNumber}. Using current date.`);
      d = new Date(); // fallback
    }
    const dateStr = d.toISOString();

    // ملحوظة: "لم يتم" نفسها بتحتوي على "تم" جواها (لم + يتم)، فلازم نتأكد من "لم يتم" الأول
    // قبل ما نفحص "تم"، وإلا كل الصفوف هتتقفل غلط
    const normalizedStatus = statusText.replace(/\s+/g, '');
    const isNotDone = normalizedStatus.includes('لميتم') || normalizedStatus.includes('لمتتم') || normalizedStatus.includes('open') || normalizedStatus.includes('مفتوح');
    const isClosed = !isNotDone && (normalizedStatus.includes('تم') || normalizedStatus.includes('closed') || normalizedStatus.includes('مغلق'));

    importedHazards.push({
      id: 'HAZ-' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '-' + rowNumber,
      empCode: code,
      empName: name,
      department: reporterDept,
      description: desc,
      location: location,
      type: 'unsafe_condition', // Default
      status: isClosed ? 'closed' : 'open',
      createdAt: dateStr,
      actionTaken: action,
      resolvedAt: isClosed ? dateStr : null, // If closed, use same date
      assignedTo: 'الصيانة', // Default
      priority: 'high',
      createdBy: code
    });
  });

  // Read existing
  let existing = [];
  if (fs.existsSync(HAZARDS_FILE)) {
    const stripBom = (str) => typeof str === 'string' && str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;
    existing = JSON.parse(stripBom(fs.readFileSync(HAZARDS_FILE, 'utf8') || '[]'));
  }
  
  const merged = [...existing, ...importedHazards];
  fs.writeFileSync(HAZARDS_FILE, JSON.stringify(merged, null, 2), 'utf8');
  
  console.log(`✅ Imported ${importedHazards.length} hazard reports.`);
  console.log(`Total hazards in database: ${merged.length}`);
}

importHazards().catch(console.error);
