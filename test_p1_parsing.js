const ExcelJS = require('exceljs');
const file = 'data/Hazard p1 -.xlsx';

async function testParsing() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  let ws = wb.worksheets[0];
  let headerRowNumber = 1;
  let headersFound = false;

  for (const sheet of wb.worksheets) {
    sheet.eachRow((row, rowNum) => {
      if (headersFound || rowNum > 10) return;
      const vals = row.values;
      const hasCode = vals.some(v => v && (String(v).toLowerCase().includes('code') || String(v).includes('كود')));
      const hasName = vals.some(v => v && (String(v).toLowerCase().includes('name') || String(v).includes('اسم')));
      
      if (hasCode && hasName) {
        ws = sheet;
        headerRowNumber = rowNum;
        headersFound = true;
        console.log(`Headers found at row ${rowNum} in sheet ${sheet.name}:`, vals);
      }
    });
    if (headersFound) break;
  }
  
  if (!headersFound) {
    console.log("No headers found matching criteria.");
  }
}
testParsing().catch(console.error);
