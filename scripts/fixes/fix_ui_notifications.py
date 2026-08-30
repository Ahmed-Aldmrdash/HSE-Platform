import sys
import re

# Patch public/style.css
with open('public/style.css', 'r', encoding='utf-8') as f:
    css_content = f.read()

new_css = """
/* ============================================================ */
/* 📱 MOBILE-FIRST NOTIFICATION DRAWER & TOASTS */
/* ============================================================ */
.notif-drawer {
  position: absolute;
  top: calc(100% + 12px);
  left: 0;
  width: 380px;
  max-width: 90vw;
  background: var(--surface);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.15);
  border: 1px solid var(--border);
  z-index: 9999;
  display: flex;
  flex-direction: column;
  max-height: 80vh;
  overflow: hidden;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-10px);
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.notif-drawer.show {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}

.notif-header {
  padding: 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--surface);
}

.notif-filters {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  display: flex;
  gap: 8px;
  overflow-x: auto;
  scrollbar-width: none;
}
.notif-filters::-webkit-scrollbar { display: none; }

.notif-list {
  flex: 1;
  overflow-y: auto;
  padding: 0;
  margin: 0;
  list-style: none;
}

.notif-item {
  padding: 16px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.2s ease;
  position: relative;
  display: flex;
  gap: 12px;
}
.notif-item:hover {
  background: #f8fafc;
}

.notif-item.unread {
  background: #f0f9ff;
  border-right: 4px solid var(--primary);
}
.notif-item.unread:hover {
  background: #e0f2fe;
}

.notif-icon-wrap {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  flex-shrink: 0;
}
.notif-item.unread .notif-icon-wrap {
  background: #bae6fd;
}

.notif-content {
  flex: 1;
}

.notif-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.notif-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  margin: 0;
}

.notif-time {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}

.notif-message {
  font-size: 13px;
  color: var(--muted);
  margin: 0;
  line-height: 1.4;
}

.pulse-dot {
  width: 8px;
  height: 8px;
  background-color: var(--primary);
  border-radius: 50%;
  display: inline-block;
  margin-right: 6px;
  box-shadow: 0 0 0 rgba(14, 165, 233, 0.4);
  animation: pulse-animation 2s infinite;
}

@keyframes pulse-animation {
  0% { box-shadow: 0 0 0 0 rgba(14, 165, 233, 0.7); }
  70% { box-shadow: 0 0 0 6px rgba(14, 165, 233, 0); }
  100% { box-shadow: 0 0 0 0 rgba(14, 165, 233, 0); }
}

/* Mobile Slide-up Sheet */
@media (max-width: 600px) {
  .notif-drawer {
    position: fixed;
    top: auto;
    bottom: 0;
    left: 0;
    width: 100%;
    max-width: 100%;
    height: 85vh;
    max-height: 85vh;
    border-radius: 20px 20px 0 0;
    transform: translateY(100%);
  }
  .notif-drawer.show {
    transform: translateY(0);
  }
}

/* App Toasts */
.app-toast {
  position: fixed;
  top: 20px;
  right: 20px;
  background: var(--surface);
  border-left: 4px solid var(--primary);
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  padding: 16px;
  border-radius: 8px;
  z-index: 10000;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  max-width: 320px;
  transform: translateX(120%);
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.app-toast.show {
  transform: translateX(0);
}
@media (max-width: 600px) {
  .app-toast {
    top: 10px;
    right: 10px;
    left: 10px;
    max-width: none;
  }
}
"""

# Replace existing notif-drawer css with the new one
if '.notif-drawer {' in css_content:
    # Use regex to remove old notif-drawer related stuff
    css_content = re.sub(r'\.notif-drawer\s*{[^}]*}', '', css_content)
    css_content = re.sub(r'\.notif-drawer\.show\s*{[^}]*}', '', css_content)
    css_content = re.sub(r'\.notif-header\s*{[^}]*}', '', css_content)
    css_content = re.sub(r'\.notif-filters\s*{[^}]*}', '', css_content)
    css_content = re.sub(r'\.notif-list\s*{[^}]*}', '', css_content)
    
css_content += new_css

with open('public/style.css', 'w', encoding='utf-8') as f:
    f.write(css_content)

# Patch public/index.html
with open('public/index.html', 'r', encoding='utf-8') as f:
    html_content = f.read()

# Add audio element just before </body>
if 'id="notifChime"' not in html_content:
    html_content = html_content.replace('</body>', '  <!-- Audio Alert -->\n  <audio id="notifChime" src="data:audio/mp3;base64,//NExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" preload="auto" style="display:none;"></audio>\n  <!-- Toast Container -->\n  <div id="toastContainer"></div>\n</body>')

# Replace cache versions
html_content = html_content.replace('v=2.28.0', 'v=2.29.0')

with open('public/index.html', 'w', encoding='utf-8') as f:
    f.write(html_content)

print('style.css and index.html updated')
