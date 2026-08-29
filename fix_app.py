import sys

with open('public/app.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

start_idx = -1
end_idx = -1

for i, line in enumerate(lines):
    if '/** Renders the Dashboard' in line:
        start_idx = i
    if 'function filterEmployeesTable()' in line:
        end_idx = i
        break

if start_idx != -1 and end_idx != -1:
    new_code = """/** Renders the Dashboard (Filters, KPIs, Leaderboard) independently of the main table */
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
    const eCode = normalizeEmpCode(e.code || e.empCode || '');
    
    // Filter hazards by timeframe
    const hCount = (window._allHazardsCache || []).filter(h => {
      if (normalizeEmpCode(h.empCode || h.submittedByCode || '') !== eCode) return false;
      if (cutoffDate) {
        const hDate = new Date(h.createdAt || h.date);
        if (hDate < cutoffDate) return false;
      }
      return true;
    }).length;

    // Filter training hours by timeframe
    let tHours = e.trainingHours || 0;
    if (cutoffDate && Array.isArray(e.trainingDates)) {
      const recentTrainings = e.trainingDates.filter(d => new Date(d) >= cutoffDate);
      tHours = recentTrainings.length * 0.5;
    }

    const hTarget = 2;
    const tTarget = 8;
    const hPerc = Math.min(100, Math.round((hCount / hTarget) * 100));
    const tPerc = Math.min(100, Math.round((tHours / tTarget) * 100));
    const score = (tHours * 10) + (hCount * 15);
    
    totalTHours += tHours;
    totalHCount += hCount;
    totalTPerc += tPerc;
    
    return { ...e, hCount, hPerc, tHours, tPerc, score, eCode };
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
  const champ = top10[0] || { name: '—', department: '—', tHours: 0, hCount: 0, score: 0 };
  
  const lbHtml = `
    <div class="emp-leaderboard-wrap">
      <div class="leaderboard-header">
        <div class="leaderboard-title">🏆 لوحة الشرف والموظف المثالي</div>
      </div>
      <div class="leaderboard-content">
        <div class="lb-champion-card">
          <div class="lb-champion-crown">👑</div>
          <div class="lb-champion-title">الموظف المثالي</div>
          <div class="lb-champion-name">${escapeHtml(champ.name || '—')}</div>
          <div class="lb-champion-dept">${escapeHtml(champ.department || '—')}</div>
          <div class="lb-champion-stats">
            <div class="lb-stat"><span class="lb-stat-val">${champ.tHours || 0}</span><span class="lb-stat-lbl">ساعة تدريب</span></div>
            <div class="lb-stat"><span class="lb-stat-val">${champ.hCount || 0}</span><span class="lb-stat-lbl">بلاغ خطورة</span></div>
            <div class="lb-stat"><span class="lb-stat-val" style="color:#d97706">${champ.score || 0}</span><span class="lb-stat-lbl">نقطة تميز</span></div>
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
                  <div class="lb-item-dept">${escapeHtml(emp.department || '—')} | ${escapeHtml(emp.empCode)}</div>
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

/** Render (or re-render) the table from a given list */
function renderEmployeesTable(list) {
  const listEl = document.getElementById('empDirList');
  if (!listEl) return;
  
  if (!Array.isArray(list)) list = [];
  
  if (list.length === 0) {
    listEl.innerHTML = '<div class="empty"><div class="icon">👤</div>لا يوجد موظفون بعد — أضف موظفاً أو استورد ملف Excel</div>';
    return;
  }
  
  // Re-process just the raw stats for the table rendering
  const processedList = list.map(e => {
    const eCode = normalizeEmpCode(e.code || e.empCode || '');
    const hCount = (window._allHazardsCache || []).filter(h => normalizeEmpCode(h.empCode || h.submittedByCode || '') === eCode).length;
    const tHours = e.trainingHours || 0;
    const hTarget = 2;
    const tTarget = 8;
    const hPerc = Math.min(100, Math.round((hCount / hTarget) * 100));
    const tPerc = Math.min(100, Math.round((tHours / tTarget) * 100));
    return { ...e, hCount, hPerc, tHours, tPerc };
  });

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
        <tbody>
          ${processedList.map((e, i) => {
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
                ${escapeHtml(e.empCode)}
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
                  <button class="um-btn pass" onclick="openEmpModal('${escapeHtml(e.empCode)}')">✏️ تعديل</button>
                  <button class="um-btn del"  onclick="deleteEmployee('${escapeHtml(e.empCode)}','${escapeHtml(e.name||'')}')">🗑 حذف</button>
                </div>
              </td>
            </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style="font-size:12px;color:var(--muted);margin-top:8px;text-align:left;">
      إجمالي: ${list.length} موظف
    </div>
  `;
}
\n"""
    lines = lines[:start_idx] + [new_code] + lines[end_idx:]
    with open('public/app.js', 'w', encoding='utf-8') as fw:
        fw.writelines(lines)
    print('Replacement complete.')
else:
    print('Failed to find region to replace.')
