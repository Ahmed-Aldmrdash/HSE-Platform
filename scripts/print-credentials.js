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
  // ⚠️ لم يعد هذا السكريبت يطبع كلمات المرور بنص صريح على الإطلاق (حتى القيم
  // الافتراضية المفترَضة) — بدلاً من ذلك يعرض فقط هل الحساب ما زال يستخدم
  // كلمة مرور افتراضية معروفة يجب تغييرها، بالاعتماد على mustChangePassword.
  console.log(
    'اسم القسم'.padEnd(30, ' ') + ' | ' +
    'اسم المستخدم'.padEnd(35, ' ') + ' | ' +
    'حالة كلمة المرور'.padEnd(45, ' ') + ' | ' +
    'الاسم الظاهر'
  );
  console.log('-'.repeat(140));

  users.forEach(u => {
    const dept = u.department || 'الإدارة العامة';
    const username = u.username;
    const passwordStatus = u.mustChangePassword === true
      ? '⚠️  يستخدم كلمة مرور افتراضية — غيّرها فورًا'
      : '✅ تم تعيين كلمة مرور خاصة';

    console.log(
      dept.padEnd(30, ' ') + ' | ' +
      username.padEnd(35, ' ') + ' | ' +
      passwordStatus.padEnd(45, ' ') + ' | ' +
      u.name
    );
  });
  console.log('========================================================================================');

} catch (err) {
  console.error('حدث خطأ أثناء قراءة البيانات:', err.message);
}
