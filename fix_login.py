import sys
import re

# Patch app.js
with open('public/app.js', 'r', encoding='utf-8') as f:
    app_js = f.read()

# In attemptLogin(), wrap startNotificationPolling in try-catch, and remove subscribeUserToPush
old_attempt_login_snippet = """    sessionRole = 'supervisor';
    showUserBadge();
    applyRbacUI();
    startNotificationPolling();
    subscribeUserToPush();
    // Switch to supervisor view"""

new_attempt_login_snippet = """    sessionRole = 'supervisor';
    showUserBadge();
    applyRbacUI();
    
    try {
      startNotificationPolling();
    } catch (err) {
      console.warn('Non-critical notification setup error:', err);
    }
    
    // Switch to supervisor view"""

if old_attempt_login_snippet in app_js:
    app_js = app_js.replace(old_attempt_login_snippet, new_attempt_login_snippet)
else:
    print("Could not find attemptLogin snippet.")

with open('public/app.js', 'w', encoding='utf-8') as f:
    f.write(app_js)


# Patch server.js
with open('server.js', 'r', encoding='utf-8') as f:
    server_js = f.read()

old_auth_check = """  if (!username || !password || !empCode) {
    return res.status(400).json({ error: 'يجب إدخال اسم المستخدم وكلمة المرور والكود الوظيفي' });
  }"""

new_auth_check = """  if (!username || !password) {
    return res.status(400).json({ error: 'يجب إدخال اسم المستخدم وكلمة المرور' });
  }"""

if old_auth_check in server_js:
    server_js = server_js.replace(old_auth_check, new_auth_check)
else:
    print("Could not find auth check in server.js")

with open('server.js', 'w', encoding='utf-8') as f:
    f.write(server_js)

# Patch public/index.html cache versions
with open('public/index.html', 'r', encoding='utf-8') as f:
    index_html = f.read()

index_html = index_html.replace('v=2.29.0', 'v=2.30.0')

with open('public/index.html', 'w', encoding='utf-8') as f:
    f.write(index_html)

print("All patched!")
