// ============================================================
// lib/db.js — SQLite-backed storage engine
// ============================================================
// كل بيانات التطبيق (تصاريح، بلاغات، موظفين، تدريب، جزاءات، فحص شهري...)
// كانت مخزّنة في ملفات JSON منفصلة تحت data/. هذا الملف يستبدل تلك الملفات
// بقاعدة بيانات SQLite حقيقية (ملف واحد: data/app.db) مع نفس واجهة
// read()/write() تمامًا، حتى لا يحتاج server.js لأي تغيير في منطق الأعمال —
// فقط استبدال طريقة التخزين. كل "مجموعة" (collection) تُخزَّن كصف واحد في
// جدول collections، بقيمتها الكاملة كنص JSON — تمامًا كما كانت الملفات، لكن
// الآن داخل معاملات ACID حقيقية بدل fs.writeFileSync الخام (الذي كان عرضة
// لفقد بيانات عند انقطاع الكتابة في منتصف الطريق). 11 سبتمبر 2026.
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'app.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS collections (
    name       TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const _upsertStmt = db.prepare(`
  INSERT INTO collections (name, data, updated_at) VALUES (@name, @data, @updated_at)
  ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);
const _selectStmt = db.prepare('SELECT data FROM collections WHERE name = ?');
const _existsStmt = db.prepare('SELECT 1 FROM collections WHERE name = ?');

/**
 * makeStore — يُنشئ زوج read()/write() لمجموعة بيانات واحدة، بنفس شكل
 * makeJsonListStore القديم القائم على الملفات، لكن بتخزين SQLite حقيقي.
 * @param {string} name — اسم فريد للمجموعة (مثال: 'hazards', 'employees')
 * @param {Array|Object} defaultValue — القيمة الافتراضية إذا لم توجد بعد
 */
function makeStore(name, defaultValue) {
  const defaultJson = JSON.stringify(defaultValue === undefined ? [] : defaultValue);
  return {
    read() {
      const row = _selectStmt.get(name);
      if (!row) return JSON.parse(defaultJson);
      try {
        return JSON.parse(row.data);
      } catch (err) {
        console.error(`[DB] Corrupt data for collection "${name}", returning default:`, err);
        return JSON.parse(defaultJson);
      }
    },
    write(value) {
      try {
        _upsertStmt.run({ name, data: JSON.stringify(value), updated_at: new Date().toISOString() });
        return true;
      } catch (err) {
        console.error(`[DB] Write failed for collection "${name}":`, err);
        return false;
      }
    },
    exists() {
      return !!_existsStmt.get(name);
    }
  };
}

/** نسخة احتياطية كاملة: يرجع كل الجداول كـ JSON واحد قابل لإعادة الاستيراد. */
function exportAll() {
  const rows = db.prepare('SELECT name, data, updated_at FROM collections').all();
  const out = {};
  rows.forEach(r => {
    try { out[r.name] = JSON.parse(r.data); } catch (e) { out[r.name] = null; }
  });
  return { exportedAt: new Date().toISOString(), collections: out };
}

/** استرجاع نسخة احتياطية كاملة — يستبدل كل مجموعة موجودة في النسخة بمحتواها. */
function importAll(backupObj) {
  if (!backupObj || typeof backupObj !== 'object' || !backupObj.collections) {
    throw new Error('صيغة ملف النسخة الاحتياطية غير صالحة');
  }
  const names = Object.keys(backupObj.collections);
  const tx = db.transaction((entries) => {
    entries.forEach(([name, value]) => {
      _upsertStmt.run({ name, data: JSON.stringify(value), updated_at: new Date().toISOString() });
    });
  });
  tx(names.map(n => [n, backupObj.collections[n]]));
  return { restored: names.length, names };
}

module.exports = { db, makeStore, exportAll, importAll, DB_PATH };
