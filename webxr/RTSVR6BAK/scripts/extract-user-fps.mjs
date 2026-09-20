import fs from 'fs';
const p =
  'C:/Users/michi/.cursor/projects/d-backup-2024-04-Documents-Backup-MBP-2021-12-Backup-Projects-Apps-WebXR/agent-transcripts/65642ba0-6fd3-4fa1-a1de-a2cf9c683f04/65642ba0-6fd3-4fa1-a1de-a2cf9c683f04.jsonl';
const lines = fs.readFileSync(p, 'utf8').split(/\n/);
let n = 0;
for (const line of lines) {
  if (!line.includes('"role":"user"')) continue;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    continue;
  }
  const c = o.message && o.message.content;
  const texts = [];
  if (Array.isArray(c)) {
    for (const x of c) if (x.type === 'text' && x.text) texts.push(x.text);
  } else if (typeof c === 'string') texts.push(c);
  const t = texts.join('\n');
  if (/FPS|fps|70|90|PCVR|leanrocks|frustum|Quest|performance|rocks/i.test(t)) {
    n++;
    console.log('---USER---');
    console.log(t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 900));
    console.log('');
  }
}
console.log('matched', n);
