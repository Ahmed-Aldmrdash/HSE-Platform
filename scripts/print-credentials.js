const fs = require('fs');
const path = require('path');

const storagePath = path.join(__dirname, '..', 'data', 'storage.json');

try {
  const rawData = fs.readFileSync(storagePath, 'utf8');
  const storage = JSON.parse(rawData);
  
  if (!storage['app-users']) {
    console.log('لا يوجد مستخدمين مسجلين في النظام.');
    process.exit(0);
  }

  const users = JSON.parse(storage['app-users']);
  
  console.log('========================================================================================');
  console.log('                              تقرير حسابات الدخول (الأقسام)                             ');
  console.log('========================================================================================');
  console.log(
    'اسم القسم'.padEnd(30, ' ') + ' | ' +
    'اسم المستخدم'.padEnd(35, ' ') + ' | ' +
    'كلمة المرور'.padEnd(15, ' ') + ' | ' +
    'الاسم الظاهر'
  );
  console.log('-'.repeat(110));

  users.forEach(u => {
    // Only display dept_admin and super_admin (or all users)
    const dept = u.department || 'الإدارة العامة';
    const username = u.username;
    // We know the auto-generated ones have '123456' and superadmin has 'admin123'
    let password = '*** مخصصة ***';
    if (u.role === 'dept_admin' && u.id.startsWith('auto-dept')) {
      password = '123456';
    } else if (u.role === 'super_admin' && u.id === 'superadmin-default') {
      password = 'admin123';
    }

    console.log(
      dept.padEnd(30, ' ') + ' | ' +
      username.padEnd(35, ' ') + ' | ' +
      password.padEnd(15, ' ') + ' | ' +
      u.name
    );
  });
  console.log('========================================================================================');

} catch (err) {
  console.error('حدث خطأ أثناء قراءة البيانات:', err.message);
}
