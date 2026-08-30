import sys

with open('public/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

old_loop = """            <tbody>
              ${myHistory.map(h => `
                <tr>
                  <td style="font-size:12px; color:var(--muted);">${escapeHtml(h.date)}</td>
                  <td style="font-weight:700; font-size:13px;">${escapeHtml(h.title)}</td>
                  <td style="font-size:12px; font-weight:700; color:${h.verified ? 'var(--success)' : 'var(--amber)'};">${h.status}</td>
                </tr>
              `).join('')}
            </tbody>"""

new_loop = """            <tbody>
              ${myHistory.map(h => {
                const stText = h.status || '';
                let stHtml = escapeHtml(stText);
                if (stText.includes('غائب')) {
                  stHtml = `<span class="badge badge-danger" style="background:#fee2e2; color:#b91c1c; border:1px solid #f87171; padding:4px 8px; border-radius:6px; font-weight:bold; font-size:11px; white-space:nowrap; display:inline-block;">${stText}</span>`;
                } else if (stText.includes('مؤكد')) {
                  stHtml = `<span class="badge badge-success" style="background:#dcfce7; color:#15803d; border:1px solid #86efac; padding:4px 8px; border-radius:6px; font-weight:bold; font-size:11px; white-space:nowrap; display:inline-block;">${stText}</span>`;
                } else {
                  stHtml = `<span class="badge badge-warning" style="background:#fef3c7; color:#b45309; border:1px solid #fde68a; padding:4px 8px; border-radius:6px; font-weight:bold; font-size:11px; white-space:nowrap; display:inline-block;">${stText}</span>`;
                }
                return `
                <tr>
                  <td style="font-size:12px; color:var(--muted);">${escapeHtml(h.date)}</td>
                  <td style="font-weight:700; font-size:13px;">${escapeHtml(h.title)}</td>
                  <td style="font-size:12px; font-weight:700;">${stHtml}</td>
                </tr>`;
              }).join('')}
            </tbody>"""

content = content.replace(old_loop, new_loop)

with open('public/app.js', 'w', encoding='utf-8') as f:
    f.write(content)
print('app.js updated')
