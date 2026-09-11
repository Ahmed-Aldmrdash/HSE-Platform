const fs = require('fs');
const ExcelJS = require('exceljs');

const TRAININGS_FILE = 'data/trainings.json';
const EXCEL_FILE = 'data/Training p2-.xlsx';

async function importTrainings() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(EXCEL_FILE);
  const ws = wb.worksheets[0];

  const sessions = {}; // Keyed by: Topic_Date

  // Start from row 2 (assuming row 1 is headers)
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const vals = row.values;
    // exceljs row.values is 1-indexed
    const code = String(vals[1] || '').trim();
    if (!code || code === 'undefined') return; // Skip empty rows

    const name = String(vals[2] || '').trim();
    const dept = String(vals[3] || '').trim();
    const topic = String(vals[6] || '').trim();
    
    // Parse Date
    let dateObj = vals[7];
    if (!dateObj) return;
    
    // Format YYYY-MM-DD
    let d = new Date(dateObj);
    if (isNaN(d.getTime())) {
      // Try to parse if it's a string like '2026-01-01' or similar
      const str = String(dateObj).trim();
      d = new Date(str);
      if (isNaN(d.getTime())) {
        console.warn(`Invalid date at row ${rowNumber}:`, dateObj);
        return; // skip if we can't parse date
      }
    }
    const dateStr = d.toISOString().split('T')[0];

    const trainer = String(vals[8] || '').trim();
    const duration = parseFloat(vals[9]) || 0;

    const sessionKey = `${topic}_${dateStr}_${trainer}`;

    if (!sessions[sessionKey]) {
      sessions[sessionKey] = {
        id: 'TRN-' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '-' + Object.keys(sessions).length,
        title: topic,
        topic: topic,
        type: 'مخطط', // default
        targetGroup: dept,
        trainer: trainer,
        date: dateStr,
        duration: duration,
        description: 'تم الاستيراد من ملف Excel',
        attendees: []
      };
    }

    // Add attendee if not already present
    const s = sessions[sessionKey];
    if (!s.attendees.find(a => a.code === code)) {
      s.attendees.push({
        code: code,
        name: name,
        department: dept
      });
    }
    
    // Update targetGroup if multiple departments are present
    if (s.targetGroup !== 'متعدد' && s.targetGroup !== dept) {
      s.targetGroup = 'متعدد'; // multiple departments
    }
  });

  const importedList = Object.values(sessions);
  
  // Read existing
  let existing = [];
  if (fs.existsSync(TRAININGS_FILE)) {
    const stripBom = (str) => typeof str === 'string' && str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;
    existing = JSON.parse(stripBom(fs.readFileSync(TRAININGS_FILE, 'utf8') || '[]'));
  }
  
  const merged = [...existing, ...importedList];
  fs.writeFileSync(TRAININGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
  
  console.log(`✅ Imported ${importedList.length} unique training sessions.`);
  console.log(`Total sessions in database: ${merged.length}`);
}

importTrainings().catch(console.error);
