import sys

with open('public/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Inject toArray before renderEmployeesPanel
import re
toArray_str = """
function toArray(val) {
  if (Array.isArray(val)) return val;
  if (val && typeof val === 'object') {
    if (Array.isArray(val.trainings)) return val.trainings;
    if (Array.isArray(val.data)) return val.data;
    if (Array.isArray(val.hazards)) return val.hazards;
    if (Array.isArray(val.employees)) return val.employees;
  }
  return [];
}
"""
content = content.replace('/** Render the employees table panel (fetches from server) */', toArray_str + '\n/** Render the employees table panel (fetches from server) */')

# 2. Update renderEmployeesPanel
panel_old = """    if (hazRes.status === 'fulfilled' && hazRes.value.ok) {
      const hzData = await hazRes.value.json();
      window._allHazardsCache = hzData.hazards || [];
    } else {
      window._allHazardsCache = [];
    }

    if (trainRes.status === 'fulfilled' && trainRes.value.ok) {
      window._trainingsCache = await trainRes.value.json();
    } else {
      window._trainingsCache = [];
    }

    const rawList = Array.isArray(empData) ? empData : (empData.employees || []);
    window._masterEmployeesList = Object.freeze([...rawList]);"""

panel_new = """    if (hazRes.status === 'fulfilled' && hazRes.value.ok) {
      window._allHazardsCache = toArray(await hazRes.value.json());
    } else {
      window._allHazardsCache = [];
    }

    if (trainRes.status === 'fulfilled' && trainRes.value.ok) {
      window._trainingsCache = toArray(await trainRes.value.json());
    } else {
      window._trainingsCache = [];
    }

    const rawList = toArray(empData);
    window._masterEmployeesList = Object.freeze([...rawList]);"""

content = content.replace(panel_old, panel_new)

# 3. Update computeEmployeeLiveStats
stats_old = """function computeEmployeeLiveStats(emp, cutoffDate = null) {
  const empCodeNorm = normalizeCode(emp.code || emp.empCode || emp.id);
  const empNameNorm = normalizeName(emp.name);

  // 1. Calculate Hazards Count
  const matchedHazards = (window._allHazardsCache || []).filter(h => {"""

stats_new = """function computeEmployeeLiveStats(emp, cutoffDate = null) {
  const empCodeNorm = normalizeCode(emp.code || emp.empCode || emp.id);
  const empNameNorm = normalizeName(emp.name);

  const hazardsList = toArray(window._allHazardsCache);
  const trainingsList = toArray(window._trainingsCache);

  // 1. Calculate Hazards Count
  const matchedHazards = hazardsList.filter(h => {"""

content = content.replace(stats_old, stats_new)


trainings_old = """  // 2. Calculate Training Hours from Trainings Cache
  let matchedTrainingHours = Number(emp.trainingHours || emp.hours || 0);
  let attendedTrainingsCount = Array.isArray(emp.trainings) ? emp.trainings.length : 0;

  (window._trainingsCache || []).forEach(t => {
    if (cutoffDate) {
      const tDate = new Date(t.date || t.createdAt);
      if (tDate < cutoffDate) return;
    }
    
    const attendees = t.attendees || t.attendedEmployees || [];
    const isAttended = attendees.some(att => {"""

trainings_new = """  // 2. Calculate Training Hours from Trainings Cache
  let matchedTrainingHours = Number(emp.trainingHours || emp.hours || 0);
  let attendedTrainingsCount = Array.isArray(emp.trainings) ? emp.trainings.length : 0;

  trainingsList.forEach(t => {
    if (cutoffDate) {
      const tDate = new Date(t.date || t.createdAt);
      if (tDate < cutoffDate) return;
    }
    
    const attendees = toArray(t.attendees || t.attendedEmployees);
    const isAttended = attendees.some(att => {"""

content = content.replace(trainings_old, trainings_new)


with open('public/app.js', 'w', encoding='utf-8') as f:
    f.write(content)
print('Replacement complete')
