import sys
import re

with open('public/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Replace the entire Notifications module from line 4484 onwards roughly
# We will use regex to find startNotificationPolling and replace it and everything after it 
# up to the handleNotificationClick and markAllNotificationsAsRead.

new_notif_module = """// ============================================================
// 📡 NOTIFICATIONS & WEB PUSH MODULE
// ============================================================

let notifEventSource = null;
let currentNotifications = [];
let currentNotifFilter = 'all';
let isNotifDrawerOpen = false;

function toggleNotifDrawer() {
  const drawer = document.getElementById('notifDropdown');
  isNotifDrawerOpen = !isNotifDrawerOpen;
  if (isNotifDrawerOpen) {
    drawer.classList.add('show');
    drawer.style.display = 'flex';
  } else {
    drawer.classList.remove('show');
    setTimeout(() => { if (!isNotifDrawerOpen) drawer.style.display = 'none'; }, 300);
  }
}

async function startNotificationPolling() {
  stopNotificationPolling();
  fetchNotifications(); // Initial fetch
  
  let params = new URLSearchParams();
  const token = getToken();
  if (token && sessionRole !== 'worker' && sessionRole !== 'none') {
    params.append('role', sessionRole);
    if (currentUserDept) params.append('department', currentUserDept);
  } else if (currentEmployee && currentEmployee.empCode) {
    params.append('role', 'worker');
    params.append('empCode', currentEmployee.empCode);
  } else {
    return;
  }

  // Setup Server-Sent Events (SSE)
  notifEventSource = new EventSource(`/api/notifications/poll?${params.toString()}`);
  notifEventSource.onmessage = function(event) {
    try {
      const newNotif = JSON.parse(event.data);
      // Prepend to current list
      currentNotifications.unshift(newNotif);
      renderNotifications();
      
      // Play Chime
      const audio = document.getElementById('notifChime');
      if (audio) {
        audio.currentTime = 0;
        audio.play().catch(e => console.log('Audio blocked by browser:', e));
      }
      
      // Show Mobile/Desktop Toast
      showAppToast(newNotif.title, newNotif.message, () => handleNotificationClick(newNotif.id, newNotif.link, newNotif.targetId, newNotif.type));
    } catch(e) {}
  };
  
  // Register Web Push Service Worker
  subscribeToPushNotifications();
}

function stopNotificationPolling() {
  if (notifEventSource) {
    notifEventSource.close();
    notifEventSource = null;
  }
}

async function subscribeToPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  
  try {
    const swReg = await navigator.serviceWorker.register('/sw.js');
    
    // Request Permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
    
    // Get VAPID Key
    const vapidRes = await fetch('/api/vapid-public-key');
    const vapidData = await vapidRes.json();
    if (!vapidData.publicKey) return;
    
    const applicationServerKey = urlB64ToUint8Array(vapidData.publicKey);
    
    const subscription = await swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey
    });
    
    // Send to Backend
    const empCode = currentEmployee ? currentEmployee.empCode : (sessionRole !== 'none' ? 'admin' : '');
    await fetch('/api/notifications/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription, role: sessionRole, empCode: empCode })
    });
  } catch (error) {
    console.error('Push Subscription Failed:', error);
  }
}

function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function fetchNotifications() {
  let params = new URLSearchParams();
  const token = getToken();
  if (token && sessionRole !== 'worker' && sessionRole !== 'none') {
    params.append('role', sessionRole);
    if (currentUserDept) params.append('department', currentUserDept);
  } else if (currentEmployee && currentEmployee.empCode) {
    params.append('role', 'worker');
    params.append('empCode', currentEmployee.empCode);
  } else {
    return;
  }

  try {
    const res = await fetch(`/api/notifications?${params.toString()}`);
    if (res.ok) {
      const data = await res.json();
      currentNotifications = data.notifications || [];
      renderNotifications();
    }
  } catch(e) {}
}

function setNotifFilter(type) {
  currentNotifFilter = type;
  document.querySelectorAll('.notif-pill').forEach(btn => btn.classList.remove('active'));
  const targetBtn = Array.from(document.querySelectorAll('.notif-pill')).find(b => b.getAttribute('onclick').includes(`'${type}'`));
  if (targetBtn) targetBtn.classList.add('active');
  renderNotifications();
}

function timeAgo(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const seconds = Math.floor((new Date() - date) / 1000);
  let interval = seconds / 31536000;
  if (interval > 1) return Math.floor(interval) + " سنة";
  interval = seconds / 2592000;
  if (interval > 1) return Math.floor(interval) + " شهر";
  interval = seconds / 86400;
  if (interval > 1) return Math.floor(interval) + " يوم";
  interval = seconds / 3600;
  if (interval >= 1) return "منذ " + Math.floor(interval) + " ساعة";
  interval = seconds / 60;
  if (interval >= 1) return "منذ " + Math.floor(interval) + " دقيقة";
  return "الآن";
}

function getIdentifier() {
  const token = getToken();
  if (token && sessionRole !== 'worker' && sessionRole !== 'none') return sessionRole;
  if (currentEmployee && currentEmployee.empCode) return currentEmployee.empCode;
  return 'unknown';
}

function renderNotifications() {
  const listEl = document.getElementById('notifList');
  const badgeEl = document.getElementById('notifBadge');
  const container = document.getElementById('notifContainer');
  if (!listEl || !badgeEl || !container) return;

  container.style.display = 'inline-flex';
  const identifier = getIdentifier();
  let unreadCount = 0;

  const filteredNotifications = currentNotifications.filter(n => {
    const isUnread = !n.readBy.includes(identifier);
    if (isUnread) unreadCount++;
    if (currentNotifFilter === 'all') return true;
    if (currentNotifFilter === 'unread') return isUnread;
    return n.type === currentNotifFilter;
  });

  const html = filteredNotifications.map(n => {
    const isUnread = !n.readBy.includes(identifier);
    let iconEmoji = '🔔';
    if (n.type === 'hazard') iconEmoji = '⚠️';
    if (n.type === 'permit') iconEmoji = '📝';
    if (n.type === 'training') iconEmoji = '🎓';

    return `
      <li class="notif-item ${isUnread ? 'unread' : ''}" onclick="handleNotificationClick('${n.id}', '${n.link}', '${n.targetId || ''}', '${n.type || ''}')">
        <div class="notif-icon-wrap">${iconEmoji}</div>
        <div class="notif-content">
          <div class="notif-title-row">
            <h4 class="notif-title"><span class="pulse-dot" style="display:${isUnread ? 'inline-block' : 'none'};"></span>${escapeHtml(n.title)}</h4>
            <span class="notif-time">${timeAgo(n.createdAt)}</span>
          </div>
          <p class="notif-message">${escapeHtml(n.message)}</p>
        </div>
      </li>
    `;
  }).join('');

  listEl.innerHTML = filteredNotifications.length === 0 ? '<li style="padding:16px; text-align:center; color:var(--muted);">لا توجد إشعارات</li>' : html;
  
  if (unreadCount > 0) {
    badgeEl.textContent = unreadCount;
    badgeEl.style.display = 'inline-block';
  } else {
    badgeEl.style.display = 'none';
  }
}

async function handleNotificationClick(id, link, targetId, type) {
  // Mark read API
  const identifier = getIdentifier();
  await fetch(`/api/notifications/read/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empCode: identifier })
  });
  
  // Local Update
  const notif = currentNotifications.find(n => n.id === id);
  if (notif && !notif.readBy.includes(identifier)) {
    notif.readBy.push(identifier);
    renderNotifications();
  }
  
  if (isNotifDrawerOpen) toggleNotifDrawer();
  
  // Navigate
  if (link) {
    const tabMap = {
      'tabPermits': 'sup',
      'tabMyHistory': 'myhistory',
      'tabSupHazard': 'supHazard',
      'tabHazardWorker': 'hazardWorker',
      'tabMyHazards': 'myhazards',
      'tabTrainingWorker': 'trainingWorker',
      'tabTrainingAdmin': 'trainingAdmin'
    };
    const mappedLink = tabMap[link] || link;
    switchTab(mappedLink);
    
    if (targetId) {
      setTimeout(() => {
        if (type === 'permit') {
          const detailsEl = document.getElementById('details-' + targetId);
          if (detailsEl) detailsEl.classList.add('show');
        } else if (type === 'hazard') {
          if (typeof showHazardModal === 'function') showHazardModal(targetId);
        }
      }, 500);
    }
  }
}

async function markAllNotificationsAsRead() {
  const identifier = getIdentifier();
  await fetch('/api/notifications/read-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empCode: identifier })
  });
  
  currentNotifications.forEach(n => {
    if (!n.readBy.includes(identifier)) n.readBy.push(identifier);
  });
  renderNotifications();
}

function showAppToast(title, message, onClick) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'app-toast';
  toast.innerHTML = `
    <div style="font-size: 24px;">🔔</div>
    <div style="flex:1;">
      <div style="font-weight:700; margin-bottom:4px; font-size:14px;">${escapeHtml(title)}</div>
      <div style="font-size:12px; color:var(--muted);">${escapeHtml(message)}</div>
    </div>
  `;
  if (onClick) {
    toast.style.cursor = 'pointer';
    toast.onclick = () => { onClick(); toast.classList.remove('show'); };
  }
  container.appendChild(toast);
  
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });
  
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}
"""

start_idx = content.find('let notifPollTimer = null;')
if start_idx == -1:
    start_idx = content.find('function startNotificationPolling()')

if start_idx != -1:
    # Find the end of markAllNotificationsAsRead
    end_str = "async function markAllNotificationsAsRead()"
    end_idx = content.find(end_str, start_idx)
    if end_idx != -1:
        # Find the end brace of this function
        end_brace = content.find('}', end_idx)
        end_brace2 = content.find('}', end_brace + 1)
        # Just use regex or slice manually
        slice_end = end_brace2 + 1 if end_brace2 != -1 else end_brace + 1
        
        # Replace
        content = content[:start_idx] + new_notif_module + content[slice_end:]
        
        with open('public/app.js', 'w', encoding='utf-8') as f:
            f.write(content)
        print('app.js updated')
    else:
        print('Could not find end')
else:
    print('Could not find start')
