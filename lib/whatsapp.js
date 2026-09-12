// ============================================================
// lib/whatsapp.js — تكامل واتساب (WhatsApp Cloud API by Meta)
// ============================================================
// بُني 12 سبتمبر 2026 بناءً على طلب بشمهندس أحمد. الكود هنا **كامل وجاهز
// للعمل فورًا**، لكنه يحتاج 3 قيم من حساب WhatsApp Business API حقيقي —
// دي حاجة محتاجة حساب Meta Business (أو مزوّد وسيط زي Twilio/360dialog)
// ما كنش متاح إنشاؤه من هنا الليلة، فمحتاجة منك تحديدًا:
//
//   1) WHATSAPP_TOKEN            — Access Token من Meta for Developers
//   2) WHATSAPP_PHONE_NUMBER_ID  — رقم هاتف الواتساب المسجّل على المنصة
//   3) WHATSAPP_VERIFY_TOKEN     — أي نص تختاره إنت (مش من ميتا) يُستخدم
//                                   مرة واحدة بس وقت ربط الـ Webhook
//
// طريقة الحصول عليهم (بالترتيب):
//   - سجّل دخول developers.facebook.com → أنشئ App جديد نوعه "Business"
//   - أضف منتج "WhatsApp" للـ App
//   - من صفحة WhatsApp > API Setup هتلاقي رقم تجريبي مجاني + Temporary
//     Access Token (صالح 24 ساعة، كويس للتجربة بس محتاج Token دائم
//     للإنتاج الحقيقي — الخطوة دي فيها تفاصيل إضافية وقت التفعيل الفعلي)
//   - حط القيم التلاتة في ملف .env (أسماء المتغيرات فوق بالظبط)
//   - شغّل السيرفر، وبعدين من نفس صفحة API Setup في ميتا حط رابط الـ
//     Webhook بتاعك: https://<عنوان-السيرفر>/api/whatsapp/webhook
//
// من غير القيم دي، كل دوال الإرسال هنا بترجع {sent:false, reason:'not_configured'}
// بهدوء من غير ما تكسر أي حاجة تانية في السيرفر — الميزة كلها "معطّلة
// بأمان" (safely disabled) لحد ما تحطهم.
'use strict';

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v20.0';
// App Secret من إعدادات تطبيق ميتا (App settings > Basic) — للتحقق إن رسائل
// الـ webhook جاية من ميتا فعلًا. من غيره السيرفر بيرفض أي رسالة واردة.
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';
const crypto = require('crypto');

function isConfigured() {
  return Boolean(WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID);
}

// تطبيع رقم الهاتف لصيغة دولية بدون + أو مسافات (اللي واتساب Cloud API
// محتاجها) — يفترض مصر (20) لو الرقم بدأ بـ 0 (صيغة محلية شائعة).
function normalizePhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/[^0-9+]/g, '');
  p = p.replace(/^\+/, '');
  if (p.startsWith('0')) p = '20' + p.slice(1); // 01xxxxxxxxx -> 201xxxxxxxxx
  if (!p.startsWith('20') && p.length === 10) p = '20' + p; // 1xxxxxxxxx بدون صفر
  return p;
}

async function callGraphAPI(payload) {
  if (!isConfigured()) {
    console.warn('[whatsapp] غير مُفعّل بعد (WHATSAPP_TOKEN/WHATSAPP_PHONE_NUMBER_ID مش موجودين في .env) — تم تجاهل الإرسال بأمان.');
    return { sent: false, reason: 'not_configured' };
  }
  if (typeof fetch !== 'function') {
    console.error('[whatsapp] Node.js هنا قديم وملوش fetch مدمج — محتاج Node 18+.');
    return { sent: false, reason: 'no_fetch_support' };
  }
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[whatsapp] فشل الإرسال:', res.status, JSON.stringify(body));
      return { sent: false, reason: 'api_error', status: res.status, body };
    }
    return { sent: true, body };
  } catch (err) {
    console.error('[whatsapp] خطأ شبكة أثناء الإرسال:', err.message);
    return { sent: false, reason: 'network_error', error: err.message };
  }
}

/** رسالة نصية بسيطة (تحديث تصريح، تذكير تدريب، إلخ) */
async function sendText(toPhoneRaw, text) {
  const to = normalizePhone(toPhoneRaw);
  if (!to) return { sent: false, reason: 'invalid_phone' };
  return callGraphAPI({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
}

/**
 * رسالة بأزرار تفاعلية (للأدمن — "قبول/رفض/توجيه" مباشرة من واتساب).
 * buttons: [{ id: 'hz_approve_HZ-2026-0012', title: 'قبول ✅' }, ...] — أقصى 3 أزرار
 * (حد واتساب الرسمي)، وكل id هو نفسه اللي هيرجع في الـ webhook لما حد يضغط عليه.
 */
async function sendInteractiveButtons(toPhoneRaw, bodyText, buttons) {
  const to = normalizePhone(toPhoneRaw);
  if (!to) return { sent: false, reason: 'invalid_phone' };
  if (!Array.isArray(buttons) || buttons.length === 0 || buttons.length > 3) {
    return { sent: false, reason: 'invalid_buttons (1-3 required)' };
  }
  return callGraphAPI({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })),
      },
    },
  });
}

/** يتحقق من توقيع ميتا على جسم الـ webhook (X-Hub-Signature-256: sha256=...) */
function verifySignature(rawBody, signatureHeader) {
  if (!WHATSAPP_APP_SECRET || !rawBody || typeof signatureHeader !== 'string') return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', WHATSAPP_APP_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** التحقق الأولي من الـ Webhook (Meta بتبعت GET مرة واحدة وقت الربط) */
function verifyWebhook(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN && WHATSAPP_VERIFY_TOKEN) {
    return { ok: true, challenge };
  }
  return { ok: false };
}

/**
 * يحلل جسم POST الوارد من واتساب لرسالة نصية عادية أو رد على زر تفاعلي.
 * يرجع null لو الحدث مش رسالة (زي إشعارات "تم التسليم/تمت القراءة" اللي
 * واتساب بيبعتها كتير وميهمناش نرد عليها).
 */
function parseIncoming(body) {
  try {
    const entry = body.entry && body.entry[0];
    const change = entry && entry.changes && entry.changes[0];
    const value = change && change.value;
    const message = value && value.messages && value.messages[0];
    if (!message) return null;
    const from = message.from; // رقم المرسل بصيغة دولية بدون +
    if (message.type === 'text') {
      return { from, kind: 'text', text: message.text.body };
    }
    if (message.type === 'interactive' && message.interactive.type === 'button_reply') {
      return { from, kind: 'button', buttonId: message.interactive.button_reply.id, buttonTitle: message.interactive.button_reply.title };
    }
    return { from, kind: 'unsupported' };
  } catch (err) {
    console.error('[whatsapp] تعذّر تحليل رسالة واردة:', err.message);
    return null;
  }
}

module.exports = {
  isConfigured,
  normalizePhone,
  sendText,
  sendInteractiveButtons,
  verifySignature,
  verifyWebhook,
  parseIncoming,
};
