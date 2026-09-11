#!/bin/bash
# reset_data.sh
# شغّله من داخل فولدر المشروع (نفس مكان server.js):
#   bash reset_data.sh
#
# بيعمل باك أب كامل لفولدر data الأول تلقائيًا، وبعدين يمسح كل البيانات
# التشغيلية (بلاغات / تصاريح / موظفين / تدريبات / تجارب طوارئ / جزاءات / إشعارات)
# ويسيب حسابات الدخول (app-users) ومفاتيح push notifications (vapid.json) زي ما هما.

set -e  # وقف فورًا لو أي أمر فشل

if [ ! -d "data" ]; then
  echo "❌ مفيش فولدر data هنا. تأكد إنك واقف في نفس فولدر server.js."
  exit 1
fi

STAMP=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP_DIR="data-backup-${STAMP}"

echo "📦 بعمل باك أب في: ${BACKUP_DIR}"
cp -r data "${BACKUP_DIR}"
echo "✅ الباك أب خلص. تأكد إنه موجود ونسخه لمكان تاني آمن قبل ما تكمل."

read -p "اكتب CONFIRM وادوس Enter عشان تكمل المسح: " CONFIRM
if [ "$CONFIRM" != "CONFIRM" ]; then
  echo "⛔ اتلغى. مفيش حاجة اتمسحت. الباك أب لسه موجود في ${BACKUP_DIR}"
  exit 1
fi

# البلاغات
echo "[]" > data/hazard-reports.json
echo "[]" > data/hazards.json
echo "✅ اتمسحت بلاغات الخطورة"

# الموظفين
echo "[]" > data/employees.json
echo "✅ اتمسحت بيانات الموظفين"

# التصاريح فقط جوه storage.json (مع الحفاظ على app-users)
python3 - <<'PYEOF'
import json
with open('data/storage.json', 'r', encoding='utf-8') as f:
    storage = json.load(f)
storage['work-permits'] = json.dumps([])
with open('data/storage.json', 'w', encoding='utf-8') as f:
    json.dump(storage, f, ensure_ascii=False, indent=2)
print("✅ اتمسحت التصاريح، الحسابات (app-users) اتحفظت")
PYEOF

# التدريبات وتجارب الطوارئ والجزاءات والإشعارات
echo "[]" > data/trainings.json
echo "✅ اتمسحت التدريبات"
echo "[]" > data/drills.json
echo "✅ اتمسحت تجارب الطوارئ"
echo "[]" > data/penalties.json
echo "✅ اتمسحت الجزاءات"
echo "[]" > data/notifications.json
echo "✅ اتمسحت الإشعارات"
echo "[]" > data/push-subscriptions.json
echo "✅ اتمسحت اشتراكات push"

echo ""
echo "🎉 خلصنا. الباك أب الكامل محفوظ في: ${BACKUP_DIR}"
echo "لازم تعمل Restart للسيرفر دلوقتي (pm2 restart / أو الطريقة اللي بتشغل بيها)."
