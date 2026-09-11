const ExcelJS = require('exceljs');

async function test() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile('c:/Users/ahmed/OneDrive/Desktop/work-permits-app-main/work-permits-app-main/data/Hazard p1 -.xlsx');
  const ws = wb.worksheets[0];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= 3) {
      console.log(`Row ${rowNumber}:`, row.values);
    }
  });
}
test().catch(console.error);
