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

    // ⚠️ ملاحظة أمنية: هذا الملف لم يعد يُصدّر كلمات المرور بنص صريح إطلاقًا —
    // لا القيمة الحقيقية (غير ممكن، لأنها مشفّرة بـ bcrypt بلا رجعة) ولا حتى
    // القيم الافتراضية المفترَضة كما كان سابقًا. بدلاً من ذلك يُصدَّر عمود
    // "الحالة" يوضح فقط هل ما زال الحساب يستخدم كلمة مرور افتراضية معروفة
    // يجب تغييرها، بالاعتماد على علامة mustChangePassword المخزّنة فعليًا
    // في بيانات كل مستخدم — دون كشف أي قيمة حساسة في ملف يمكن أن يُشارك بالخطأ.
    sheet.columns = [
      { header: 'الاسم الظاهر (Name)', key: 'name', width: 40 },
      { header: 'اسم القسم (Department)', key: 'department', width: 35 },
      { header: 'اسم المستخدم (Username)', key: 'username', width: 35 },
      { header: 'حالة كلمة المرور (Password Status)', key: 'passwordStatus', width: 32 },
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

      const passwordStatus = u.mustChangePassword === true
        ? '⚠️ يستخدم كلمة مرور افتراضية — يجب تغييرها فورًا'
        : '✅ تم تعيين كلمة مرور خاصة';

      const row = sheet.addRow({
        name: u.name,
        department: dept,
        username: username,
        passwordStatus: passwordStatus,
        role: u.role
      });
      
      row.font = { name: 'Arial', size: 11, color: u.mustChangePassword === true ? { argb: 'FF9A1010' } : undefined, bold: u.mustChangePassword === true };
      row.alignment = { vertical: 'middle', horizontal: 'center' };
      row.eachCell(cell => {
        if (u.mustChangePassword === true) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE7E7' } };
        }
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
