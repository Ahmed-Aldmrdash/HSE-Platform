const fs = require('fs');
const readline = require('readline');

async function processTranscript() {
  const fileStream = fs.createReadStream('C:\\Users\\ahmed\\.gemini\\antigravity-ide\\brain\\b28d74e8-15cd-41b5-8bb3-26c71e8b72aa\\.system_generated\\logs\\transcript_full.jsonl', 'utf8');
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let out = "";
  for await (const line of rl) {
    if (!line.includes('drills') && !line.includes('Drill') && !line.includes('غائب') && !line.includes('ساعه')) continue;
    try {
      const data = JSON.parse(line);
      if (data.type === 'USER_INPUT' || (data.type === 'CODE_ACTION' && data.content.includes('diff'))) {
        out += `\n\n=== STEP ${data.step_index} (${data.type}) ===\n`;
        out += data.content + "\n";
      }
    } catch(e) {}
  }
  fs.writeFileSync('extract_history_direct.txt', out, 'utf8');
  console.log("Done");
}
processTranscript();
