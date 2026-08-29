import sys

with open('public/app.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

start_idx = -1
end_idx = -1

for i, line in enumerate(lines):
    if '/** Renders the Dashboard' in line:
        start_idx = i
    if 'function filterEmployeesTable()' in line or 'function openEmpModal(code = null) {' in line:
        if 'function openEmpModal' in line:
            end_idx = i
            break

if start_idx != -1 and end_idx != -1:
    new_code = """function normalizeCode(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim().replace(/^0+/, '') || '0';
}

function normalizeName(val) {
  if (!val) return '';
  return String(val).trim().toLowerCase().replace(/\\s+/g, ' ');
}

function computeEmployeeLiveStats(emp, cutoffDate = null) {
  const empCodeNorm = normalizeCode(emp.code || emp.empCode || emp.id);
  const empNameNorm = normalizeName(emp.name);

  // 1. Calculate Hazards Count
  const matchedHazards = (window._allHazardsCache || []).filter(h => {
    if (cutoffDate) {
      const hDate = new Date(h.createdAt || h.date);
      if (hDate < cutoffDate) return false;
    }
    const hCode = normalizeCode(h.reporterCode || h.empCode || h.employeeCode || h.userId || '');
    const hName = normalizeName(h.reporterName || h.reportedBy || h.userName || '');
    const codeMatch = hCode && empCodeNorm && hCode === empCodeNorm;
    const nameMatch = hName && empNameNorm && (hName === empNameNorm || hName.includes(empNameNorm) || empNameNorm.includes(hName));
    return codeMatch || nameMatch;
  });

  // 2. Calculate Training Hours from Trainings Cache
  let matchedTrainingHours = Number(emp.trainingHours || emp.hours || 0);
  let attendedTrainingsCount = Array.isArray(emp.trainings) ? emp.trainings.length : 0;

  (window._trainingsCache || []).forEach(t => {
    if (cutoffDate) {
      const tDate = new Date(t.date || t.createdAt);
      if (tDate < cutoffDate) return;
    }
    
    const attendees = t.attendees || t.attendedEmployees || [];
    const isAttended = attendees.some(att => {
      const attCode = normalizeCode(typeof att === 'object' ? (att.code || att.empCode || att.id) : att);
      const attName = normalizeName(typeof att === 'object' ? (att.name || att.empName) : '');
      return (attCode && empCodeNorm && attCode === empCodeNorm) || (attName && empNameNorm && attName === empNameNorm);
    });
    if (isAttended) {
      attendedTrainingsCount++;
      matchedTrainingHours += Number(t.durationHours || t.hours || 1);
    }
  });

  // 3. Compute Composite Score (Points)
  // E.g.: 10 points per hazard reported + 5 points per training hour
  const totalScore = (matchedHazards.length * 10) + (matchedTrainingHours * 5);

  const hTarget = 2;
  const tTarget = 8;
  const hPerc = Math.min(100, Math.round((matchedHazards.length / hTarget) * 100));
  const tPerc = Math.min(100, Math.round((matchedTrainingHours / tTarget) * 100));

  return {
    ...emp,
    hazardsCount: matchedHazards.length,
    trainingHours: matchedTrainingHours,
    trainingsCount: attendedTrainingsCount,
    totalScore: totalScore,
    hCount: matchedHazards.length,
    tHours: matchedTrainingHours,
    hPerc: hPerc,
    tPerc: tPerc,
    score: totalScore
  };
}

/** Renders the Dashboard (Filters, KPIs, Leaderboard) independently of the main table */
function renderEmployeesPanelUI() {
  const dashEl = document.getElementById('empDashboardWrap');
  if (!dashEl) return;
  
  const fullList = window._masterEmployeesList ? [...window._masterEmployeesList] : [];
  if (fullList.length === 0) {
    dashEl.innerHTML = '';
    return;
  }
  
  const lbFilter = typeof window.currentLeaderboardFilter !== 'undefined' ? window.currentLeaderboardFilter : 'overall';
  const lbTimeframe = typeof window.currentLeaderboardTimeframe !== 'undefined' ? window.currentLeaderboardTimeframe : 'all';
  
  let cutoffDate = null;
  if (lbTimeframe !== 'all') {
    cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - parseInt(lbTimeframe));
  }

  // 1. Process stats for all employees in scope
  let totalTHours = 0;
  let totalHCount = 0;
  let totalTPerc = 0;
  
  const processedList = fullList.map(e => {
    const stats = computeEmployeeLiveStats(e, cutoffDate);
    totalTHours += stats.tHours;
    totalHCount += stats.hCount;
    totalTPerc += stats.tPerc;
    return stats;
  });

  const avgTPerc = processedList.length > 0 ? Math.round(totalTPerc / processedList.length) : 0;
  
  window.setLeaderboardFilter = function(filterType) {
    window.currentLeaderboardFilter = filterType;
    renderEmployeesPanelUI();
  };
  
  window.setLeaderboardTimeframe = function(timeframe) {
    window.currentLeaderboardTimeframe = timeframe;
    renderEmployeesPanelUI();
  };

  // 2. Generate Filter Bar HTML
  const filtersHtml = `
    <div class="emp-leaderboard-wrap" style="margin-bottom:16px; padding:12px 16px;">
      <div class="leaderboard-filters" style="display:flex;flex-direction:column;gap:12px;">
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          <span style="font-size:12px;color:var(--muted);margin-left:auto;align-self:center;">الفترة الزمنية:</span>
          <button class="lb-filter-btn ${lbTimeframe === 'all' ? 'active' : ''}" onclick="window.setLeaderboardTimeframe('all')">الكل</button>
          <button class="lb-filter-btn ${lbTimeframe === '7' ? 'active' : ''}" onclick="window.setLeaderboardTimeframe('7')">خلال أسبوع</button>
          <button class="lb-filter-btn ${lbTimeframe === '14' ? 'active' : ''}" onclick="window.setLeaderboardTimeframe('14')">خلال أسبوعين</button>
          <button class="lb-filter-btn ${lbTimeframe === '30' ? 'active' : ''}" onclick="window.setLeaderboardTimeframe('30')">خلال شهر</button>
          <button class="lb-filter-btn ${lbTimeframe === '90' ? 'active' : ''}" onclick="window.setLeaderboardTimeframe('90')">خلال 3 أشهر</button>
          <button class="lb-filter-btn ${lbTimeframe === '365' ? 'active' : ''}" onclick="window.setLeaderboardTimeframe('365')">خلال سنة</button>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          <span style="font-size:12px;color:var(--muted);margin-left:auto;align-self:center;">الترتيب حسب:</span>
          <button class="lb-filter-btn ${lbFilter === 'overall' ? 'active' : ''}" onclick="window.setLeaderboardFilter('overall')">الترتيب العام</button>
          <button class="lb-filter-btn ${lbFilter === 'hazards' ? 'active' : ''}" onclick="window.setLeaderboardFilter('hazards')">الأكثر إبلاغاً</button>
          <button class="lb-filter-btn ${lbFilter === 'training' ? 'active' : ''}" onclick="window.setLeaderboardFilter('training')">التزاماً بالتدريب</button>
        </div>
      </div>
    </div>
  `;

  // 3. Generate Analytics Strip HTML
  const analyticsHtml = `
    <div class="emp-analytics-grid">
      <div class="emp-kpi-card">
        <div class="emp-kpi-icon">👥</div>
        <div class="emp-kpi-value">${processedList.length}</div>
        <div class="emp-kpi-label">إجمالي الموظفين</div>
      </div>
      <div class="emp-kpi-card">
        <div class="emp-kpi-icon">🎓</div>
        <div class="emp-kpi-value">${totalTHours}</div>
        <div class="emp-kpi-label">ساعات التدريب المنجزة</div>
      </div>
      <div class="emp-kpi-card">
        <div class="emp-kpi-icon">⚠️</div>
        <div class="emp-kpi-value">${totalHCount}</div>
        <div class="emp-kpi-label">بلاغات الخطورة المقدمة</div>
      </div>
      <div class="emp-kpi-card">
        <div class="emp-kpi-icon">📈</div>
        <div class="emp-kpi-value">${avgTPerc}%</div>
        <div class="emp-kpi-label">متوسط نسبة الالتزام</div>
      </div>
    </div>
  `;

  // 4. Generate Leaderboard HTML
  let sortedLb = [...processedList];
  if (lbFilter === 'hazards') {
    sortedLb.sort((a, b) => b.hCount - a.hCount);
  } else if (lbFilter === 'training') {
    sortedLb.sort((a, b) => b.tHours - a.tHours);
  } else {
    sortedLb.sort((a, b) => b.score - a.score);
  }
  
  const top10 = sortedLb.slice(0, 10);
  const champ = top10[0] || { name: '—', department: '—', empCode: '—', tHours: 0, hCount: 0, score: 0 };
  
  const lbHtml = `
    <div class="emp-leaderboard-wrap">
      <div class="leaderboard-header">
        <div class="leaderboard-title">🏆 لوحة الشرف والموظف المثالي</div>
      </div>
      <div class="leaderboard-content">
        <div class="lb-champion-card">
          <div class="lb-champion-crown">👑</div>
          <div class="lb-champion-title">الموظف المثالي</div>
          <div class="lb-champion-name">${escapeHtml(champ?.name || '—')}</div>
          <div class="lb-champion-dept">${escapeHtml(champ?.department || '—')} | ${escapeHtml(champ?.empCode || champ?.code || '—')}</div>
          <div class="lb-champion-stats">
            <div class="lb-stat"><span class="lb-stat-val">${champ?.tHours || 0}</span><span class="lb-stat-lbl">ساعة تدريب</span></div>
            <div class="lb-stat"><span class="lb-stat-val">${champ?.hCount || 0}</span><span class="lb-stat-lbl">بلاغ خطورة</span></div>
            <div class="lb-stat"><span class="lb-stat-val" style="color:#d97706">${champ?.score || 0}</span><span class="lb-stat-lbl">نقطة تميز</span></div>
          </div>
        </div>
        <div class="lb-list">
          ${top10.slice(1).map((emp, idx) => {
            const rank = idx + 2;
            let rankClass = '';
            if (rank === 2) rankClass = 'silver';
            else if (rank === 3) rankClass = 'bronze';
            const rankIcon = rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
            return `
              <div class="lb-item">
                <div class="lb-item-rank ${rankClass}">${rankIcon}</div>
                <div class="lb-item-info">
                  <div class="lb-item-name">${escapeHtml(emp.name || '—')}</div>
                  <div class="lb-item-dept">${escapeHtml(emp.department || '—')} | ${escapeHtml(emp.empCode || emp.code)}</div>
                </div>
                <div class="lb-item-score">${lbFilter === 'hazards' ? emp.hCount + ' بلاغ' : lbFilter === 'training' ? emp.tHours + ' ساعة' : emp.score + ' نقطة'}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;

  dashEl.innerHTML = filtersHtml + analyticsHtml + lbHtml;
}

function renderEmployeesTable(list) {
  const listEl = document.getElementById('empDirList');
  if (!listEl) return;
  
  // Set up the static table shell ONCE if it doesn't exist
  if (!document.getElementById('empTableBody')) {
    listEl.innerHTML = `
      <div class="um-table-wrap">
        <table class="um-table emp-dir-table">
          <thead>
            <tr>
              <th>#</th>
              <th>الكود</th>
              <th>الاسم الكامل</th>
              <th>القسم / المسمى</th>
              <th>⚠️ البلاغات</th>
              <th>🎓 المحاضرات</th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody id="empTableBody">
          </tbody>
        </table>
      </div>
      <div id="empTableCount" style="font-size:12px;color:var(--muted);margin-top:8px;text-align:left;"></div>
    `;
  }
  
  renderEmployeesTableRows(list);
}

window.handleEmployeeSearch = function(query) {
  const q = (query || '').trim().toLowerCase();
  const all = window._masterEmployeesList || [];
  
  if (!q) {
    renderEmployeesTableRows(all);
    return;
  }

  const cleanCode = String(query || '').trim().replace(/^0+/, '') || '0';
  
  const filtered = all.filter(emp => {
    const eName = (emp.name || '').toLowerCase();
    const eCode = String(emp.code || emp.empCode || '').toLowerCase();
    const eDept = (emp.department || '').toLowerCase();
    const eJob = (emp.jobTitle || '').toLowerCase();
    
    if (/^\\d+$/.test(query)) {
      const eCodeNoZero = eCode.replace(/^0+/, '');
      return eCodeNoZero === cleanCode || eCode.includes(q);
    }
    
    return eName.includes(q) || eCode.includes(q) || eDept.includes(q) || eJob.includes(q);
  });

  renderEmployeesTableRows(filtered);
};

function renderEmployeesTableRows(list) {
  const tbody = document.getElementById('empTableBody');
  const countEl = document.getElementById('empTableCount');
  if (!tbody) return;
  
  if (!Array.isArray(list)) list = [];
  
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty" style="padding:20px;text-align:center;"><div class="icon">👤</div>لا توجد نتائج مطابقة للبحث</div></td></tr>';
    if (countEl) countEl.innerText = 'إجمالي: 0 موظف';
    return;
  }
  
  // Re-process just the raw stats for the table rendering using the live stats compute function
  const processedList = list.map(e => computeEmployeeLiveStats(e, null));

  tbody.innerHTML = processedList.map((e, i) => {
    const hTarget = 2; // Target per month/period
    const tTarget = 8;
    const hCount = e.hCount;
    const tHours = e.tHours;
    const hPerc = e.hPerc;
    const tPerc = e.tPerc;
    const hBadgeClass = e.hPerc >= 100 ? 'badge-green' : (e.hPerc >= 50 ? 'badge-yellow' : 'badge-red');
    const tBadgeClass = e.tPerc >= 100 ? 'badge-green' : (e.tPerc >= 50 ? 'badge-yellow' : 'badge-red');

    return `
    <tr>
      <td style="color:var(--muted);font-size:12px;">${i + 1}</td>
      <td style="font-family:'Oswald',sans-serif;font-size:13px;font-weight:700;letter-spacing:1px;color:var(--amber);">
        ${escapeHtml(e.empCode || e.code)}
      </td>
      <td style="font-weight:700;">${escapeHtml(e.name || '—')}</td>
      <td>
        <div style="font-size:13px;">${escapeHtml(e.department || '—')}</div>
        <div style="font-size:11px;color:var(--muted);">${escapeHtml(e.jobTitle || '—')}</div>
      </td>
      <td>
        <div style="font-size:12px; font-weight:bold; margin-bottom:4px;">${hCount} / ${hTarget} بلاغ</div>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="flex:1;background:var(--paper-line);height:8px;border-radius:4px;overflow:hidden;min-width:40px;">
            <div style="height:100%;width:${hPerc}%;background:var(--amber);"></div>
          </div>
          <span class="emp-role-badge ${hBadgeClass}" style="min-width:35px;text-align:center;font-size:10px;">${hPerc}%</span>
        </div>
      </td>
      <td>
        <div style="font-size:12px; font-weight:bold; margin-bottom:4px;">${tHours} / ${tTarget} ساعات</div>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="flex:1;background:var(--paper-line);height:8px;border-radius:4px;overflow:hidden;min-width:40px;">
            <div style="height:100%;width:${tPerc}%;background:var(--amber);"></div>
          </div>
          <span class="emp-role-badge ${tBadgeClass}" style="min-width:35px;text-align:center;font-size:10px;">${tPerc}%</span>
        </div>
      </td>
      <td>
        <div class="um-action-btns">
          <button class="um-btn pass" onclick="openEmpModal('${escapeHtml(e.empCode || e.code)}')">✏️ تعديل</button>
          <button class="um-btn del"  onclick="deleteEmployee('${escapeHtml(e.empCode || e.code)}','${escapeHtml(e.name||'')}')">🗑 حذف</button>
        </div>
      </td>
    </tr>
    `;
  }).join('');
  
  if (countEl) countEl.innerText = `إجمالي: ${list.length} موظف`;
}
"""
    # Replace the chunk (start_idx to end_idx-1)
    lines = lines[:start_idx] + [new_code] + lines[end_idx:]
    with open('public/app.js', 'w', encoding='utf-8') as fw:
        fw.writelines(lines)
    print('Replacement complete.')
else:
    print('Failed to find region to replace.', start_idx, end_idx)
