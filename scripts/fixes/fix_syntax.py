import sys

with open('public/app.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find the start of the junk
start_idx = -1
for i, line in enumerate(lines):
    if line.strip() == ';' and 'const token = localStorage.getItem' in lines[i+1]:
        start_idx = i
        break

if start_idx != -1:
    # Find where the Global Sync Button section starts
    end_idx = -1
    for i in range(start_idx, len(lines)):
        if '// 🔄 GLOBAL SYNC BUTTON' in lines[i]:
            end_idx = i - 1 # Keep the line with '// ============================================================'
            break

    if end_idx != -1:
        del lines[start_idx:end_idx]
        with open('public/app.js', 'w', encoding='utf-8') as f:
            f.writelines(lines)
        print("Cleaned successfully.")
    else:
        print("Could not find end index.")
else:
    print("Could not find start index.")
