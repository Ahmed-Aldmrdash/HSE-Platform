const fs = require('fs');
const path = require('path');

const hazardsFile = path.join(__dirname, 'data', 'hazards.json');
const trainingsFile = path.join(__dirname, 'data', 'trainings.json');

try {
  // Backup before wiping
  if (fs.existsSync(hazardsFile)) {
    fs.copyFileSync(hazardsFile, hazardsFile + '.bak');
    console.log('Backed up hazards.json');
  }
  if (fs.existsSync(trainingsFile)) {
    fs.copyFileSync(trainingsFile, trainingsFile + '.bak');
    console.log('Backed up trainings.json');
  }

  // Wipe data
  fs.writeFileSync(hazardsFile, JSON.stringify([], null, 2), 'utf8');
  fs.writeFileSync(trainingsFile, JSON.stringify([], null, 2), 'utf8');

  console.log('Successfully wiped all data from hazards.json and trainings.json');
} catch(err) {
  console.error('Error wiping data:', err);
}
