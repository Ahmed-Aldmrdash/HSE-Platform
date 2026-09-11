import sys

with open('public/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Add getTrainingDuration helper
helper_code = """
function getTrainingDuration(t) {
  if (t && (t.durationHours !== undefined && t.durationHours !== null && t.durationHours !== '')) {
    return Number(t.durationHours);
  }
  if (t && (t.hours !== undefined && t.hours !== null && t.hours !== '')) {
    return Number(t.hours);
  }
  if (t && t.durationMinutes) {
    return Number(t.durationMinutes) / 60;
  }
  return 0.5; // Default standard session is strictly 0.5 hours (30 mins)
}

function computeEmployeeLiveStats(emp, cutoffDate = null) {"""

content = content.replace("function computeEmployeeLiveStats(emp, cutoffDate = null) {", helper_code)

# Update logic inside computeEmployeeLiveStats
old_logic = """  // 2. Calculate Training Hours from Trainings Cache
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
  });

  // 3. Compute Composite Score (Points)
  // E.g.: 10 points per hazard reported + 5 points per training hour
  const totalScore = (matchedHazards.length * 10) + (matchedTrainingHours * 5);"""

new_logic = """  // 2. Calculate Training Hours from Trainings Cache
  let matchedTrainingHours = 0;
  let attendedTrainingsCount = 0;
  const countedTrainingIds = new Set();

  trainingsList.forEach(t => {
    if (cutoffDate) {
      const tDate = new Date(t.date || t.createdAt);
      if (tDate < cutoffDate) return;
    }
    
    const tId = t._id || t.id || `${t.title}_${t.date}`;
    if (countedTrainingIds.has(tId)) return;

    if (isEmployeeInAttendees(emp, t.attendees || t.attendedEmployees)) {
      countedTrainingIds.add(tId);
      attendedTrainingsCount++;
      matchedTrainingHours += getTrainingDuration(t);
    }
  });

  // 3. Compute Composite Score (Points)
  // 10 points per hazard report + 10 points per training hour (0.5h = 5 points)
  const totalScore = (matchedHazards.length * 10) + (matchedTrainingHours * 10);"""

content = content.replace(old_logic, new_logic)

with open('public/app.js', 'w', encoding='utf-8') as f:
    f.write(content)
print('app.js updated')
