import sys

with open('server.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add notificationClients array at the top level
if 'let sseClients = [];' not in content:
    content = content.replace("const express = require('express');", "const express = require('express');\nlet sseClients = [];")

# 2. Update createNotification to use SSE
old_create = """    Promise.all(sendPromises).then(() => {
      if (subscriptionsChanged) {
        writeSubscriptions(validSubscriptions);
      }
    });
  });
}"""

new_create = """    Promise.all(sendPromises).then(() => {
      if (subscriptionsChanged) {
        writeSubscriptions(validSubscriptions);
      }
    });
    
    // Broadcast via Server-Sent Events
    sseClients.forEach(client => {
      let shouldSend = false;
      if (newNotif.targetRole === 'all') shouldSend = true;
      if (newNotif.targetEmpCode && client.empCode && normalizeEmpCode(newNotif.targetEmpCode) === normalizeEmpCode(client.empCode)) shouldSend = true;
      if (newNotif.targetRole && client.role) {
        if (newNotif.targetRole === 'admin' && ['superadmin', 'admin', 'supervisor', 'area_head'].includes(client.role)) shouldSend = true;
        if (newNotif.targetRole === client.role) shouldSend = true;
      }
      
      if (shouldSend) {
        try {
          client.res.write(`data: ${JSON.stringify(newNotif)}\\n\\n`);
        } catch (e) {
           // Client disconnected
        }
      }
    });

  });
}"""

content = content.replace(old_create, new_create)

# 3. Add VAPID Public Key and SSE endpoints, and refactor read endpoints
old_api = """app.post('/api/notifications/mark-read', (req, res) => {
  const { id, empCode } = req.body;
  if (!id || !empCode) return res.status(400).json({ error: 'Missing required fields' });

  let result;
  enqueueWriteSync(() => {
    const notifications = readNotifications();
    const notif = notifications.find(n => n.id === id);
    if (!notif) {
      result = { status: 404, body: { error: 'Notification not found' } };
      return;
    }
    
    const eCode = normalizeEmpCode(empCode);
    if (!notif.readBy.includes(eCode)) {
      notif.readBy.push(eCode);
      writeNotifications(notifications);
    }
    result = { status: 200, body: { success: true } };
  });
  res.status(result.status).json(result.body);
});"""

new_api = """app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.get('/api/notifications/poll', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  // Extract user info from query since this might not use Bearer headers perfectly in EventSource
  const empCode = req.query.empCode ? normalizeEmpCode(req.query.empCode) : null;
  const role = req.query.role || null;
  
  const client = { id: Date.now(), res, empCode, role };
  sseClients.push(client);
  
  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== client.id);
  });
});

app.post('/api/notifications/read/:id', (req, res) => {
  const { empCode } = req.body;
  if (!empCode) return res.status(400).json({ error: 'Missing empCode' });

  let result;
  enqueueWriteSync(() => {
    const notifications = readNotifications();
    const notif = notifications.find(n => n.id === req.params.id);
    if (!notif) {
      result = { status: 404, body: { error: 'Notification not found' } };
      return;
    }
    
    const eCode = normalizeEmpCode(empCode);
    if (!notif.readBy.includes(eCode)) {
      notif.readBy.push(eCode);
      writeNotifications(notifications);
    }
    result = { status: 200, body: { success: true } };
  });
  res.status(result.status).json(result.body);
});

app.post('/api/notifications/read-all', (req, res) => {
  const { empCode } = req.body;
  if (!empCode) return res.status(400).json({ error: 'Missing empCode' });

  let result;
  enqueueWriteSync(() => {
    const notifications = readNotifications();
    let updated = false;
    const eCode = normalizeEmpCode(empCode);
    
    notifications.forEach(notif => {
      if (!notif.readBy.includes(eCode)) {
        notif.readBy.push(eCode);
        updated = true;
      }
    });
    
    if (updated) writeNotifications(notifications);
    result = { status: 200, body: { success: true } };
  });
  res.status(result.status).json(result.body);
});"""

content = content.replace(old_api, new_api)

with open('server.js', 'w', encoding='utf-8') as f:
    f.write(content)
print('server.js updated')
