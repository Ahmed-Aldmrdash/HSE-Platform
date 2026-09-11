import sys

with open('public/app.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

start_idx = -1
end_idx = -1

for i, line in enumerate(lines):
    if 'function renderEmployeesTable(list) {' in line:
        start_idx = i
    if 'function openEmpModal(code = null) {' in line:
        end_idx = i
        break

if start_idx != -1 and end_idx != -1:
    new_code = """function renderEmployeesTable(list) {
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
    
    if (/^\d+$/.test(query)) {
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
