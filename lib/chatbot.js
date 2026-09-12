// ============================================================
// lib/chatbot.js — الشات بوت (أسئلة وأجوبة من ملفين فقط)
// ============================================================
// تحديث 12 سبتمبر 2026 بطلب بشمهندس أحمد: البوت بقى بيجاوب من ملفين بس —
// تعليمات السلامة SE-W01 وفرق الطوارئ (lib/kb) — من غير أي API خارجي،
// ومع تسامح مع الأخطاء الإملائية. شلنا الأوامر القديمة (فتح تصريح، حالة
// تصريح، إحصائيات) لأنها برّه الملفين، وكانت كمان بتكشف حالة أي تصريح
// لأي حد يعرف رقمه من غير تسجيل دخول.
'use strict';

const kb = require('./chatbot-kb');

const ADMIN_TIER = ['super_admin', 'hse_admin', 'dept_admin', 'maint_admin', 'ceo'];
function isAdminRole(role) { return ADMIN_TIER.includes(role); }

/** handleMessage({ text }) => { reply, source } */
function handleMessage({ text }) {
  const q = String(text || '').trim().slice(0, 500);
  if (!q) return { reply: 'اكتب سؤالك عن تعليمات السلامة أو فرق الطوارئ.', source: null };
  return kb.answer(q);
}

module.exports = { handleMessage, isAdminRole, ADMIN_TIER };
