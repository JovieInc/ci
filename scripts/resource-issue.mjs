import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync('report.json', 'utf8'));
if (process.argv[2] === 'count') console.log(r.findings.length);
else console.log(`Proposed actions only; destructive steps need Tim's yes.\n\nSkipped sources: ${r.skipped.join('; ') || 'none'}\n\n${r.findings.map((f) => `- ${f.kind} \`${f.name}\` ${f.type}: ${f.proposedAction}`).join('\n')}`);
