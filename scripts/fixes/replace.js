const fs = require('fs');
const path = require('path');

const replaceInFile = (filePath) => {
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Custom manual replacements for specific phrasing first
  content = content.replace(/تصاريح العمل/g, "الطلبات");
  
  // Broad text replacement
  content = content.replace(/تصاريح/g, "طلبات");
  content = content.replace(/تصريح/g, "طلب");
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Replaced in ${filePath}`);
};

const appJsPath = path.join(__dirname, 'public', 'app.js');
const serverJsPath = path.join(__dirname, 'server.js');

replaceInFile(appJsPath);
replaceInFile(serverJsPath);

console.log('Done replacing.');
