const fs = require('fs');

const path = 'c:/Users/ahmed/OneDrive/Desktop/work-permits-app-main/work-permits-app-main/data/trainings.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));

let updated = 0;
data.forEach(t => {
  if (t.description === 'تم الاستيراد من ملف Excel') {
    if (!t.status) {
      t.status = 'closed';
      t.isClosed = true;
      updated++;
    }
    if (!t.createdAt) {
      t.createdAt = t.date;
      updated++;
    }
    if (!t.closedAt) {
      t.closedAt = t.date;
    }
    // ensure attendees have verified: true and attendanceTime
    if (t.attendees && Array.isArray(t.attendees)) {
      t.attendees.forEach(a => {
        if (a.verified === undefined) a.verified = true;
        if (!a.attendanceTime) a.attendanceTime = t.date;
      });
    }
  }
});

fs.writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
console.log(`Updated ${updated} fields in trainings.`);
