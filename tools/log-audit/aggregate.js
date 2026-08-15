// Extra aggregates over inventory.json
const fs = require('node:fs');
const inv = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const mains = inv.filter((s) => s.depth === 0 && !s.error);
const children = inv.filter((s) => s.depth > 0 && !s.error);
const sum = (arr, f) => arr.reduce((a, s) => a + f(s), 0);
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));

console.log('mains:', mains.length, 'children:', children.length);
console.log('main steps:', sum(mains, (s) => s.steps), 'child steps:', sum(children, (s) => s.steps));
console.log('main user msgs:', sum(mains, (s) => s.userMessages));
console.log('main tools:', sum(mains, (s) => Object.values(s.toolCalls).reduce((a, b) => a + b, 0)));
console.log('main R:', fmt(sum(mains, (s) => s.reasoningTokens)), 'main T:', fmt(sum(mains, (s) => s.textTokens)));
console.log('child R:', fmt(sum(children, (s) => s.reasoningTokens)), 'child T:', fmt(sum(children, (s) => s.textTokens)));
console.log('TOTAL completion R+T:', fmt(sum([...mains, ...children], (s) => s.reasoningTokens + s.textTokens)));

const spawned = mains.filter((s) => s.subagentCalls.length > 0);
console.log('mains with subagent spawns:', spawned.length, 'of', mains.length, '| total spawns:', sum(spawned, (s) => s.subagentCalls.length));
const spawnNames = {};
for (const s of spawned) for (const c of s.subagentCalls) spawnNames[c.name] = (spawnNames[c.name] || 0) + 1;
console.log('spawn breakdown:', JSON.stringify(spawnNames));

const heavy = mains.filter((s) => s.reasoningTokens > 50000);
console.log('mains with R>50k:', heavy.length, '| their R:', fmt(sum(heavy, (s) => s.reasoningTokens)), '=', (100 * sum(heavy, (s) => s.reasoningTokens) / sum(mains, (s) => s.reasoningTokens)).toFixed(0) + '% of main R');

// per project
const byProj = {};
for (const s of mains) {
  const p = (s.cwd || '?').replace(/\\/g, '/');
  (byProj[p] = byProj[p] || []).push(s);
}
for (const [p, ss] of Object.entries(byProj)) {
  console.log('PROJ', p, '| sessions', ss.length, '| R', fmt(sum(ss, (s) => s.reasoningTokens)), 'T', fmt(sum(ss, (s) => s.textTokens)), '| spawns', sum(ss, (s) => s.subagentCalls.length));
}

// ratio thinking share
const totR = sum([...mains, ...children], (s) => s.reasoningTokens);
const totT = sum([...mains, ...children], (s) => s.textTokens);
console.log('thinking share of completion:', (100 * totR / (totR + totT)).toFixed(1) + '%');

// models used by children
const childModels = {};
for (const c of children) for (const m of c.models) childModels[m] = (childModels[m] || 0) + 1;
console.log('child model mix:', JSON.stringify(childModels));
