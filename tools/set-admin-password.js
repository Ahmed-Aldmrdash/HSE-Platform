#!/usr/bin/env node
// ============================================================
// tools/set-admin-password.js — تعيين كلمة سر أي حساب إدارة من على جهاز السيرفر
// ============================================================
// للطوارئ بس: لو محدش فاكر كلمة سر السوبر أدمن. بيحتاج وصول لملفات السيرفر
// نفسه (data/app.db)، فمحدش يقدر يستخدمه من برّه.
//
//   node tools/set-admin-password.js <username> <new-password>
//   node tools/set-admin-password.js --list
//
// ينفع والسيرفر شغال (SQLite بيقبل الكتابة من أكتر من عملية).
'use strict';

const path = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS, 10) || 12;
const db = new Database(path.join(__dirname, '..', 'data', 'app.db'));

function loadUsers() {
  const row = db.prepare("SELECT data FROM collections WHERE name = 'storage'").get();
  const storage = row ? JSON.parse(row.data) : {};
  return { storage, users: JSON.parse(storage['app-users'] || '[]') };
}

const [arg1, arg2] = process.argv.slice(2);
if (arg1 === '--list') {
  loadUsers().users.forEach(u => console.log(`${u.username.padEnd(40)} ${u.role.padEnd(12)} ${u.department || ''}`));
  process.exit(0);
}
if (!arg1 || !arg2) {
  console.log('الاستخدام: node tools/set-admin-password.js <username> <new-password>\n            node tools/set-admin-password.js --list');
  process.exit(1);
}
if (arg2.length < 8) {
  console.error('❌ كلمة السر لازم تكون 8 حروف/أرقام على الأقل');
  process.exit(1);
}

const { storage, users } = loadUsers();
const user = users.find(u => String(u.username).toLowerCase() === arg1.toLowerCase());
if (!user) {
  console.error(`❌ مفيش حساب اسمه "${arg1}" — شوف الأسماء بـ --list`);
  process.exit(1);
}
user.password = bcrypt.hashSync(arg2, ROUNDS);
user.mustChangePassword = false;
storage['app-users'] = JSON.stringify(users);
db.prepare("UPDATE collections SET data = ?, updated_at = ? WHERE name = 'storage'").run(JSON.stringify(storage), new Date().toISOString());
console.log(`✅ اتغيرت كلمة سر "${user.username}" (${user.role}). ادخل بيها دلوقتي من شاشة دخول المشرفين.`);
