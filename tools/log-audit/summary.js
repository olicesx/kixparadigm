// Summarize inventory.json into readable tables
const fs = require('node:fs');
const inv = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

const mains = inv.filter((s) => s.depth === 0 && !s.error);
const children = inv.filter((s) => s.depth > 0 && !s.error);
const others = inv.filter((s) => s.error);

function fmtDate(ms) {
  if (!ms) return '-';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}
function fmtTok(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

console.log('===== MAIN SESSIONS (depth 0) =====');
for (const s of mains) {
  const proj = (s.cwd || '').replace(/\\/g, '/');
  const sub = s.subagentCalls.map((c) => c.name);
  const subCount = {};
  for (const n of sub) subCount[n] = (subCount[n] || 0) + 1;
  console.log([
    fmtDate(s.createdAt),
    '|', proj,
    '| turns', s.turns, 'steps', s.steps,
    '| user', s.userMessages,
    '| R', fmtTok(s.reasoningTokens), 'T', fmtTok(s.textTokens),
    '| tools', Object.keys(s.toolCalls).length,
    '| subagents', JSON.stringify(subCount),
  ].join(' '));
}

console.log('\n===== CHILDREN (subagents) =====');
const byParent = {};
for (const c of children) {
  const k = c.parentSession || '(orphan)';
  (byParent[k] = byParent[k] || []).push(c);
}
for (const [parent, kids] of Object.entries(byParent)) {
  const par = mains.find((m) => m.id === parent);
  const label = par ? (par.cwd || '').replace(/\\/g, '/') + ' / ' + parent.slice(0, 8) : parent;
  console.log('PARENT', label, '-> children', kids.length);
  for (const k of kids) {
    console.log('   ', fmtDate(k.createdAt), k.id.slice(0, 8), 'depth', k.depth,
      '| R', fmtTok(k.reasoningTokens), 'T', fmtTok(k.textTokens),
      '| steps', k.steps, 'turns', k.turns, 'tools', Object.keys(k.toolCalls).length,
      '| models', k.models.join(','));
  }
}

console.log('\n===== TOTALS =====');
const tot = (arr, f) => arr.reduce((a, s) => a + f(s), 0);
console.log('mains', mains.length, 'children', children.length, 'errors', others.length);
console.log('main reasoning tokens', fmtTok(tot(mains, (s) => s.reasoningTokens)),
  '| main text tokens', fmtTok(tot(mains, (s) => s.textTokens)));
console.log('child reasoning tokens', fmtTok(tot(children, (s) => s.reasoningTokens)),
  '| child text tokens', fmtTok(tot(children, (s) => s.textTokens)));
console.log('main tool calls total', tot(mains, (s) => Object.values(s.toolCalls).reduce((a, b) => a + b, 0)));

// biggest token sessions
console.log('\n===== TOP TOKEN SESSIONS =====');
const all = [...mains, ...children].sort((a, b) => (b.reasoningTokens + b.textTokens) - (a.reasoningTokens + a.textTokens));
for (const s of all.slice(0, 12)) {
  console.log(fmtDate(s.createdAt), (s.cwd || '').replace(/\\/g, '/'),
    'depth', s.depth, '| R', fmtTok(s.reasoningTokens), 'T', fmtTok(s.textTokens),
    '| steps', s.steps, '| id', s.id.slice(0, 8));
}

// subagent call previews of mains
console.log('\n===== SUBAGENT CALL PREVIEWS (main sessions) =====');
for (const s of mains) {
  if (s.subagentCalls.length === 0) continue;
  console.log('\n##', (s.cwd || '').replace(/\\/g, '/'), s.id.slice(0, 8), 'n=', s.subagentCalls.length);
  for (const c of s.subagentCalls.slice(0, 12)) {
    console.log('  -', c.name, '|', c.preview.slice(0, 200));
  }
  if (s.subagentCalls.length > 12) console.log('  ... +' + (s.subagentCalls.length - 12) + ' more');
}
