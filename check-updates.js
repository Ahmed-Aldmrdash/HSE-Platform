require('dotenv').config();
const https = require('https');

async function checkForUpdates() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('❌ GITHUB_TOKEN is not set in .env');
    return;
  }

  const options = {
    hostname: 'api.github.com',
    path: '/repos/Ahmed-Aldmrdash/work-permits-app/commits/main',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'Work-Permits-App-Updater',
      'Accept': 'application/vnd.github.v3+json'
    }
  };

  console.log('🔄 Checking for updates from private repository...');
  
  const req = https.request(options, (res) => {
    let data = '';
    
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      if (res.statusCode === 200) {
        const commit = JSON.parse(data);
        console.log('✅ Successfully connected to GitHub API!');
        console.log(`📌 Latest Commit SHA: ${commit.sha}`);
        console.log(`📝 Message: ${commit.commit.message}`);
        console.log(`👨‍💻 Author: ${commit.commit.author.name}`);
        console.log(`🕒 Date: ${commit.commit.author.date}`);
        // Here you can add logic to compare this SHA with a local .version file
        // and trigger a git pull or download the zip if it's different.
      } else {
        console.error(`❌ Failed to fetch updates. Status Code: ${res.statusCode}`);
        console.error('Response:', data);
      }
    });
  });

  req.on('error', (e) => {
    console.error(`❌ Error connecting to GitHub API: ${e.message}`);
  });

  req.end();
}

// Run if called directly
if (require.main === module) {
  checkForUpdates();
}

module.exports = { checkForUpdates };
