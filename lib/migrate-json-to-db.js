// ============================================================
// lib/migrate-json-to-db.js — ترحيل تلقائي من ملفات JSON إلى SQLite
// ============================================================
// يعمل مرة واحدة فقط عند إقلاع السيرفر: لكل ملف JSON قديم موجود على القرص
// وليس له بيانات في قاعدة البيانات بعد، يقرأ محتواه ويكتبه في الجدول، ثم
// ينقل الملف الأصلي (لا يحذفه نهائيًا) إلى data/_legacy_json_backup/ كنسخة
// أمان. عملية آمنة للتكرار (idempotent) — إذا كانت المجموعة موجودة بالفعل
// في القاعدة، يتم تجاهل الملف تمامًا ولا يُلمَس. 11 سبتمبر 2026.
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {import('better-sqlite3').Database} opts.db
 * @param {{file:string, name:string, isObject?:boolean}[]} opts.collections
 */
function migrateJsonToDb({ dataDir, db, collections }) {
  const existsStmt = db.prepare('SELECT 1 FROM collections WHERE name = ?');
  const insertStmt = db.prepare(
    'INSERT INTO collections (name, data, updated_at) VALUES (?, ?, ?)'
  );
  const backupDir = path.join(dataDir, '_legacy_json_backup');
  const migrated = [];
  const skipped = [];

  for (const col of collections) {
    const filePath = path.join(dataDir, col.file);
    const alreadyInDb = !!existsStmt.get(col.name);
    if (alreadyInDb) { skipped.push(`${col.file} (موجود بالفعل في القاعدة)`); continue; }
    if (!fs.existsSync(filePath)) { skipped.push(`${col.file} (غير موجود)`); continue; }

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const fallback = col.isObject ? '{}' : '[]';
      const parsed = JSON.parse(raw && raw.trim() ? raw : fallback);
      insertStmt.run(col.name, JSON.stringify(parsed), new Date().toISOString());

      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      fs.renameSync(filePath, path.join(backupDir, col.file));

      const count = Array.isArray(parsed) ? `${parsed.length} صف` : 'كائن واحد';
      migrated.push(`${col.file} → "${col.name}" (${count})`);
    } catch (err) {
      console.error(`[Migrate] فشل ترحيل ${col.file}:`, err);
      skipped.push(`${col.file} (فشل: ${err.message})`);
    }
  }

  if (migrated.length) {
    console.log('============================================================');
    console.log('📦 ترحيل تلقائي من JSON إلى قاعدة البيانات (مرة واحدة فقط):');
    migrated.forEach(m => console.log('   ✅ ' + m));
    console.log(`   النسخ الأصلية محفوظة في: ${backupDir}`);
    console.log('============================================================');
  }
  return { migrated, skipped };
}

/**
 * sweepOrphanJsonFiles — أي ملف *.json متبقٍّ مباشرة داخل data/ ولم يكن
 * ضمن قائمة المجموعات المعروفة أعلاه (نسخ قديمة مكررة/غير مُستخدَمة فعليًا
 * من الكود، مثل hazards.json القديم بجانب hazard-reports.json الفعلي)
 * يُنقَل أيضًا إلى data/_legacy_json_backup/ بعد حفظ نسخة منه في القاعدة
 * تحت اسم "orphan:<filename>" حتى لا يُفقد أي شيء نهائيًا، مع إبقاء data/
 * خالية تمامًا من ملفات JSON الخام كما طلب المستخدم صراحة.
 */
function sweepOrphanJsonFiles({ dataDir, db, excludeFiles }) {
  const insertStmt = db.prepare(`
    INSERT INTO collections (name, data, updated_at) VALUES (@name, @data, @updated_at)
    ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `);
  const backupDir = path.join(dataDir, '_legacy_json_backup');
  const excludeSet = new Set(excludeFiles || []);
  const swept = [];

  let entries = [];
  try { entries = fs.readdirSync(dataDir); } catch (e) { return swept; }

  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.json')) continue;
    if (excludeSet.has(entry)) continue;
    const filePath = path.join(dataDir, entry);
    try {
      if (!fs.statSync(filePath).isFile()) continue;
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw && raw.trim() ? raw : 'null');
      const name = `orphan:${entry.replace(/\.json$/i, '')}`;
      insertStmt.run({ name, data: JSON.stringify(parsed), updated_at: new Date().toISOString() });
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      fs.renameSync(filePath, path.join(backupDir, entry));
      swept.push(entry);
    } catch (err) {
      console.error(`[Migrate] تعذّر نقل ملف JSON يتيم (${entry}):`, err.message);
    }
  }
  if (swept.length) {
    console.log(`   📦 ملفات JSON يتيمة إضافية تم أرشفتها: ${swept.join(', ')}`);
  }
  return swept;
}

module.exports = { migrateJsonToDb, sweepOrphanJsonFiles };
