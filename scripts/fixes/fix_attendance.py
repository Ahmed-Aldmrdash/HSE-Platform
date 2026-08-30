import sys

with open('public/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add isEmployeeInAttendees helper
new_helper = """
function normalizeName(val) {
  if (!val) return '';
  return String(val).trim().toLowerCase().replace(/\\s+/g, ' ');
}

function isEmployeeInAttendees(emp, attendees) {
  const empCodeNorm = normalizeCode(emp.code || emp.empCode || emp.id);
  const empNameNorm = normalizeName(emp.name);

  return toArray(attendees).some(att => {
    if (!att) return false;
    if (typeof att === 'string' || typeof att === 'number') {
      const attStr = normalizeCode(att);
      return (attStr && empCodeNorm && attStr === empCodeNorm) || normalizeName(att) === empNameNorm;
    }
    const attCode = normalizeCode(att.code || att.empCode || att.id || att.employeeId);
    const attName = normalizeName(att.name || att.empName || att.employeeName);
    return (attCode && empCodeNorm && attCode === empCodeNorm) || (attName && empNameNorm && attName === empNameNorm);
  });
}
"""

content = content.replace("""
function normalizeName(val) {
  if (!val) return '';
  return String(val).trim().toLowerCase().replace(/\\s+/g, ' ');
}
""", new_helper)

# 2. Update computeEmployeeLiveStats
trainings_old = """  // 2. Calculate Training Hours from Trainings Cache
  let matchedTrainingHours = Number(emp.trainingHours || emp.hours || 0);
  let attendedTrainingsCount = Array.isArray(emp.trainings) ? emp.trainings.length : 0;

  trainingsList.forEach(t => {
    if (cutoffDate) {
      const tDate = new Date(t.date || t.createdAt);
      if (tDate < cutoffDate) return;
    }
    
    const attendees = toArray(t.attendees || t.attendedEmployees);
    const isAttended = attendees.some(att => {
      const attCode = normalizeCode(typeof att === 'object' ? (att.code || att.empCode || att.id) : att);
      const attName = normalizeName(typeof att === 'object' ? (att.name || att.empName) : '');
      return (attCode && empCodeNorm && attCode === empCodeNorm) || (attName && empNameNorm && attName === empNameNorm);
    });
    if (isAttended) {
      attendedTrainingsCount++;
      matchedTrainingHours += Number(t.durationHours || t.hours || 1);
    }
  });"""

trainings_new = """  // 2. Calculate Training Hours from Trainings Cache
  let matchedTrainingHours = Number(emp.trainingHours || emp.hours || 0);
  let attendedTrainingsCount = Array.isArray(emp.trainings) ? emp.trainings.length : 0;

  trainingsList.forEach(t => {
    if (cutoffDate) {
      const tDate = new Date(t.date || t.createdAt);
      if (tDate < cutoffDate) return;
    }
    
    if (isEmployeeInAttendees(emp, t.attendees || t.attendedEmployees)) {
      attendedTrainingsCount++;
      matchedTrainingHours += Number(t.durationHours || t.hours || 1);
    }
  });"""

content = content.replace(trainings_old, trainings_new)

# 3. Update UI badge
badge_old = """<div class="lb-item-score">${lbFilter === 'hazards' ? eStats.hazardsCount + ' بلاغ' : lbFilter === 'training' ? eStats.trainingHours + ' ساعة' : eStats.totalScore + ' نقطة'}</div>"""
badge_new = """<div class="lb-item-score">${lbFilter === 'hazards' ? eStats.hazardsCount + ' بلاغ' : lbFilter === 'training' ? eStats.trainingHours + ' ساعة' : `<span class="points-badge">${Number(eStats.totalScore || 0).toFixed(eStats.totalScore % 1 !== 0 ? 1 : 0)} نقطة</span>`}</div>"""

content = content.replace(badge_old, badge_new)

with open('public/app.js', 'w', encoding='utf-8') as f:
    f.write(content)
print('Replacement complete.')
