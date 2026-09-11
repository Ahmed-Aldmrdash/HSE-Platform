// ─────────────────────────────────────────────────────────────────────────
// استيراد تجارب الطوارئ القديمة (من تقارير Word السابقة) إلى النظام
// ─────────────────────────────────────────────────────────────────────────
// طريقة التشغيل (مرة واحدة فقط، من مجلد المشروع):
//     node import_legacy_drill_reports.js
//
// - يقرأ بيانات مستخرجة تلقائياً من 19 تقرير Word قديم (data/legacy_drills_seed.json)
// - يضيفها كتجارب "مغلقة" فى data/drills.json بحالة source = "legacy_import"
// - آمن للتشغيل أكثر من مرة: لا يكرر نفس التجربة لو كانت متسجلة قبل كده (بيتعرف عليها بالـ id)
// - كل تجربة مستوردة هتلاقيها فى تبويب "تجارب الطوارئ" (أدمن) تحت سجل التجارب السابقة،
//   وهيكون جنبها زرار "📝 الريبورت" تقدر من خلاله تراجع/تكمل البيانات (لأن الاستخراج التلقائى
//   من ملفات Word مش هيكون دقيق 100% خصوصاً التاريخ/الوقت وبعض التفاصيل) ثم تنزل نسخة Word
//   منه بنفس تصميم التقارير القديمة.
// - مفيش صور اتنقلت (زي ما طلبت، الريبورت الجديد من غير صور).
// ─────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const DRILLS_FILE = path.join(__dirname, 'data', 'drills.json');
const SEED_FILE = path.join(__dirname, 'data', 'legacy_drills_seed.json');

function defaultDrillReport() {
  return {
    scenario: '',
    purpose:
      'تطبيقاً لخطط السلامة وفى سياق جهود الشركة الهادفة الى الحفاظ على سلامة كافة العاملين، تم اجراء هذه ' +
      'التجربة للتأكد من مدى فاعلية خطط الطوارئ المتبعة فى الشركة، اضافة الى قياس مدى جاهزية العاملين بالشركة ' +
      'للتعامل فى مثل هذه الظروف الطارئة، مع تدريب كافة العاملين فى الشركة على التصرف الصحيح والاستجابة السريعة ' +
      'خلال الطوارئ، فيما يضمن الامن والسلامة لكافة العاملين.',
    narrativeSteps: [],
    resultIntro: '',
    resultPoints: [],
    positives: [],
    negatives: [],
    improvements: [],
    thanksNote: 'هذا ونتقدم بخالص الشكر والامتنان للسادة الزملاء لحسن تعاونهم وسرعة الاستجابة للحالات الطارئة.',
    responsibleTitle: 'مسئول البيئة والسلامة',
    responsibleName: '',
    signatureDate: '',
    formCode: 'SE-03-F1',
    formVersion: 'VER.NO.:3',
    formDate: 'VER. DATE :1/5/2015',
    updatedAt: null,
    updatedBy: null
  };
}

function main() {
  if (!fs.existsSync(SEED_FILE)) {
    console.error('❌ ملف البيانات القديمة غير موجود:', SEED_FILE);
    process.exit(1);
  }
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  let drills = [];
  if (fs.existsSync(DRILLS_FILE)) {
    try { drills = JSON.parse(fs.readFileSync(DRILLS_FILE, 'utf8')); } catch (e) { drills = []; }
  }
  const existingIds = new Set(drills.map(d => d.id));

  let added = 0, skipped = 0;
  seed.forEach(s => {
    if (existingIds.has(s.id)) { skipped++; return; }
    const baseReport = defaultDrillReport();
    const drillEntry = {
      id: s.id,
      title: s.title,
      trainer: s.trainer || '',
      trainerCode: '',
      targetGroup: '',
      location: s.location || '',
      date: s.date || '',
      startTime: s.startTime || '',
      endTime: '',
      sessionPin: '',
      status: 'closed',
      attendees: [],           // لا يوجد سجل حضور رقمي لهذه التجارب القديمة (ملفات Word سردية وليست كشوف حضور)
      isDeleted: false,
      source: 'legacy_import',
      sourceFile: s.sourceFile,
      dateRaw: s.dateRaw,
      timeRaw: s.timeRaw,
      createdAt: (s.date ? new Date(s.date).toISOString() : new Date().toISOString()),
      report: Object.assign(baseReport, {
        scenario: s.report.scenario || '',
        narrativeSteps: s.report.narrativeSteps || [],
        resultIntro: s.report.resultIntro || '',
        resultPoints: s.report.resultPoints || [],
        positives: s.report.positives || [],
        negatives: s.report.negatives || [],
        improvements: s.report.improvements || [],
        responsibleName: s.report.responsibleName || '',
        responsibleTitle: s.report.responsibleTitle || baseReport.responsibleTitle,
        signatureDate: s.report.signatureDate || s.date || ''
      })
    };
    drills.push(drillEntry);
    added++;
  });

  fs.writeFileSync(DRILLS_FILE, JSON.stringify(drills, null, 2), 'utf8');
  console.log(`✅ تم الاستيراد: ${added} تجربة جديدة. تم تخطي ${skipped} (موجودة بالفعل).`);
  console.log('   افتح تبويب "تجارب الطوارئ" فى لوحة تحكم الأدمن → سجل التجارب السابقة، وراجع كل ريبورت وكمّله.');
}

main();
