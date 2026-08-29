import sys

with open('server.js', 'r', encoding='utf-8') as f:
    content = f.read()

old_logic = """// Worker Dashboard Endpoint (No JWT required)
app.get('/api/trainings/worker/:empCode', (req, res) => {
  const code = normalizeEmpCode(req.params.empCode);
  const trainings = readTrainings();
  
  const activeSession = trainings.find(t => t.status === 'active');
  const myHistory = [];
  let totalClosed = 0;
  let myAttended = 0;
  
  trainings.forEach(trn => {
    if (trn.status === 'closed') totalClosed++;
    const me = trn.attendees.find(a => normalizeEmpCode(a.empCode) === code);
    if (me) {
      if (trn.status === 'closed' && me.verified) myAttended++;
      myHistory.push({
        date: trn.date,
        title: trn.title,
        status: me.verified ? '✅ مؤكد' : '⏳ قيد المراجعة',
        verified: me.verified
      });
    }
  });"""

new_logic = """// Worker Dashboard Endpoint (No JWT required)
app.get('/api/trainings/worker/:empCode', (req, res) => {
  const code = normalizeEmpCode(req.params.empCode);
  const trainings = readTrainings();
  
  const activeSession = trainings.find(t => t.status === 'active');
  const myHistory = [];
  let totalClosed = 0;
  let myAttended = 0;
  
  trainings.forEach(trn => {
    const isClosed = trn.status === 'closed' || trn.isClosed;
    if (isClosed) totalClosed++;
    const me = trn.attendees.find(a => normalizeEmpCode(a.empCode) === code);
    
    if (me) {
      if (isClosed && me.verified) myAttended++;
      myHistory.push({
        date: trn.date || trn.createdAt,
        title: trn.title || trn.topic,
        status: me.verified ? '✅ مؤكد' : '⏳ قيد المراجعة',
        verified: me.verified,
        attended: true
      });
    } else if (isClosed) {
      myHistory.push({
        date: trn.date || trn.createdAt,
        title: trn.title || trn.topic,
        status: '❌ غائب',
        verified: false,
        attended: false
      });
    }
  });
  
  // Sort history newest to oldest
  myHistory.sort((a, b) => new Date(b.date) - new Date(a.date));"""

content = content.replace(old_logic, new_logic)

with open('server.js', 'w', encoding='utf-8') as f:
    f.write(content)
print('server.js updated')
