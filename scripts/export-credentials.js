const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const storagePath = path.join(__dirname, '..', 'data', 'storage.json');
const outputPath = path.join(__dirname, '..', 'Department_Admins_Credentials.xlsx');

async function exportCredentials() {
  try {
    const rawData = fs.readFileSync(storagePath, 'utf8');
    const storage = JSON.parse(rawData);
    
    if (!storage['app-users']) {
      console.log('لا يوجد مستخدمين مسجلين في النظام.');
      process.exit(0);
    }

    const users = JSON.parse(storage['app-users']);
    
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Elsewedy HSE System';
    workbook.created = new Date();
    
    const sheet = workbook.addWorksheet('حسابات الأقسام', {
      views: [{ rightToLeft: true }]
    });

    sheet.columns = [
      { header: 'الاسم الظاهر (Name)', key: 'name', width: 40 },
      { header: 'اسم القسم (Department)', key: 'department', width: 35 },
      { header: 'اسم المستخدم (Username)', key: 'username', width: 35 },
      { header: 'كلمة المرور (Password)', key: 'password', width: 20 },
      { header: 'الدور (Role)', key: 'role', width: 20 }
    ];

    // Style the header row
    const headerRow = sheet.getRow(1);
    headerRow.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.eachCell(cell => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1E293B' } // Dark Slate background
      };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });

    users.forEach(u => {
      const dept = u.department || 'الإدارة العامة';
      const username = u.username;
      
      let password = '*** مخصصة ***';
      if (u.role === 'dept_admin' && u.id.startsWith('auto-dept')) {
        password = '123456';
      } else if (u.role === 'super_admin' && u.id === 'superadmin-default') {
        password = 'admin123';
      }

      const row = sheet.addRow({
        name: u.name,
        department: dept,
        username: username,
        password: password,
        role: u.role
      });
      
      row.font = { name: 'Arial', size: 11 };
      row.alignment = { vertical: 'middle', horizontal: 'center' };
      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
      });
    });

    await workbook.xlsx.writeFile(outputPath);
    console.log(`✅ تم إنشاء ملف الإكسيل بنجاح: ${outputPath}`);

  } catch (err) {
    console.error('حدث خطأ أثناء تصدير البيانات:', err.message);
  }
}

exportCredentials();
