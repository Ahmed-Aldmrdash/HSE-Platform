// ============================================================
// lib/pdf-arabic.js — دعم النصوص العربية داخل مستندات PDFKit
// ============================================================
// PDFKit لا يدعم تشكيل الحروف العربية (letter joining) ولا خوارزمية
// الاتجاه الثنائي (Bidi) بشكل تلقائي — كل سطر نص يُرسم بترتيب الحروف كما
// هو، من اليسار لليمين، بغض النظر عن محتواه. هذا الملف يجهّز أي نص عربي
// (أو عربي ممزوج بأرقام/إنجليزي) قبل تمريره لـ doc.text() عبر خطوتين:
//   1) إعادة تشكيل الحروف العربية لأشكالها الصحيحة حسب موضعها في الكلمة
//      (بداية/وسط/نهاية/منفردة) — مكتبة arabic-reshaper.
//   2) إعادة ترتيب النص للـ "ترتيب البصري" (Visual Order) المطلوب للرسم
//      من اليسار لليمين بحيث يظهر بصريًا بالاتجاه الصحيح، مع إبقاء أي
//      أرقام/نص إنجليزي مضمّن (مثال: "WP-2026-0001") بترتيبه الطبيعي —
//      خوارزمية Unicode BiDi الرسمية عبر مكتبة bidi-js.
// ملاحظة مهمة: هذا يعمل فقط مع خطوط تحتوي فعليًا على Glyphs متصلة لأشكال
// العرض (Presentation Forms, U+FE70–FEFF) في جدول cmap الخاص بها. خط
// Cairo المُستخدم في واجهة الويب لا يحتوي عليها بشكل صحيح (اختُبر ولم
// يعمل) — لذلك مستندات PDF تستخدم خط Amiri (خط عربي تقليدي احترافي
// بديل، assets/fonts/Amiri-*.ttf) بدلاً من Cairo. 11 سبتمبر 2026.
'use strict';

const bidiFactory = require('bidi-js');
const bidi = bidiFactory();
const arabicReshaper = require('arabic-reshaper');

/**
 * يجهّز نصًا (عربي أو مُمزوج) للرسم الصحيح في PDFKit.
 * @param {string} text
 * @returns {string}
 */
function prepareBidiText(text) {
  if (!text && text !== 0) return '';
  const str = String(text);
  try {
    const shaped = arabicReshaper.convertArabic(str);
    const levels = bidi.getEmbeddingLevels(shaped);
    return bidi.getReorderedString(shaped, levels);
  } catch (err) {
    return str; // fallback: أفضل من إسقاط توليد المستند بالكامل
  }
}

module.exports = { prepareBidiText };
