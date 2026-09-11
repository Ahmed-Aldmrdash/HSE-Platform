const fs = require('fs');

let appJs = fs.readFileSync('public/app.js', 'utf8');
const ps1Content = fs.readFileSync('inject_drills.ps1', 'utf8');

const regex = /\$drillsJs = @"\r?\n([\s\S]*?)"@/m;
const match = ps1Content.match(regex);

if (match) {
    let drillsJs = match[1];
    appJs = appJs.replace(/((\/\/ ============================================================\r?\n\/\/ 🎨 LIGHTBOX LOGIC))/, drillsJs + "\n\n$1");
    fs.writeFileSync('public/app.js', appJs, 'utf8');
    console.log("Injected into app.js using node.");
} else {
    console.log("Could not find drillsJs block in ps1.");
}
