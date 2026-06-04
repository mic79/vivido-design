const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const presetsDir = path.join(root, 'presets');
fs.mkdirSync(presetsDir, { recursive: true });

const jsonPath = process.argv[2] || path.join(presetsDir, 'habitrails.json');
if (!fs.existsSync(jsonPath)) {
    console.error('JSON not found:', jsonPath);
    process.exit(1);
}

const json = fs.readFileSync(jsonPath, 'utf8');
JSON.parse(json);
fs.writeFileSync(path.join(presetsDir, 'habitrails.json'), json);

const b64 = 'b64:' + Buffer.from(json, 'utf8').toString('base64');

const presetPath = path.join(root, 'table-presets.js');
let src = fs.readFileSync(presetPath, 'utf8');

const habitrailsBlock =
    "        {\n" +
    "            id: 'habitrails',\n" +
    "            name: 'Habitrails',\n" +
    "            description: 'Table with habitrail wire paths',\n" +
    "            layoutParam: " + JSON.stringify(b64) + "\n" +
    "        },\n";

const marker = '    presetTables: [\n';
if (!src.includes(marker)) {
    console.error('Could not find presetTables in table-presets.js');
    process.exit(1);
}

if (src.includes("id: 'habitrails'")) {
    src = src.replace(/\s*\{\s*id: 'habitrails'[\s\S]*?\n        \},\n/, habitrailsBlock);
} else {
    src = src.replace(marker, marker + habitrailsBlock);
}

fs.writeFileSync(presetPath, src);
console.log('Updated', presetPath, '(b64 length', b64.length + ')');
