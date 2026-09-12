// ============================================================
// lib/mailer.js — إرسال الإيميلات عبر SMTP (nodemailer)
// ============================================================
// أُضيف 12 سبتمبر 2026 لإرسال النسخة الاحتياطية اليومية بالإيميل. بيانات
// حساب الإرسال (السيرفر/اليوزر/الباسورد) في .env فقط — مش في قاعدة البيانات
// ولا في الواجهة — لأنها أسرار. المستلمين والميعاد بيتحددوا من المنصة نفسها.
// من غير SMTP_HOST/SMTP_USER/SMTP_PASS، sendMail بترجع {sent:false} بهدوء.
'use strict';

const nodemailer = require('nodemailer');

const SMTP_HOST   = process.env.SMTP_HOST || '';
const SMTP_PORT   = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || SMTP_PORT === 465;
const SMTP_USER   = process.env.SMTP_USER || '';
const SMTP_PASS   = process.env.SMTP_PASS || '';
const SMTP_FROM   = process.env.SMTP_FROM || SMTP_USER;

let _transport = null;

function isConfigured() {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

function getTransport() {
  if (!_transport) {
    _transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return _transport;
}

/** @returns {Promise<{sent:boolean, reason?:string, error?:string, accepted?:string[], rejected?:string[]}>} */
async function sendMail({ to, subject, text, html, attachments }) {
  if (!isConfigured()) return { sent: false, reason: 'not_configured' };
  try {
    const info = await getTransport().sendMail({ from: SMTP_FROM, to, subject, text, html, attachments });
    return { sent: true, accepted: info.accepted || [], rejected: info.rejected || [] };
  } catch (err) {
    console.error('[mailer] فشل إرسال الإيميل:', err.message);
    return { sent: false, reason: 'smtp_error', error: err.message };
  }
}

module.exports = { isConfigured, sendMail, fromAddress: () => SMTP_FROM };
