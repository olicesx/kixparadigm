// Deep-dive one session: per-step tokens, polling pattern, subagent spawns
const fs = require('node:fs');
const zlib = require('node:zlib');
const ZSTD_MAGIC = 4247762216;

function scanFrames(buf) {
  const out = []; let o = 0;
  while (o < buf.length) {
    const s = o;
    if (buf.length - o < 4) return out;
    if (buf.readUInt32LE(o) !== ZSTD_MAGIC) throw new Error('bad magic');
    o += 4; if (o === buf.length) return out;
    const d = buf.readUInt8(o); o += 1;
    const csf = d >>> 6, ss = (d & 32) !== 0, chk = (d & 4) !== 0, df = d & 3;
    const db = df === 3 ? 4 : df, cb = csf === 0 ? (ss ? 1 : 0) : 1 << csf;
    const rhb = (ss ? 0 : 1) + db + cb;
    if (buf.length - o < rhb) return out; o += rhb;
    for (;;) {
      if (buf.length - o < 3) return out;
      const bh = buf.readUIntLE(o, 3); o += 3;
      const last = (bh & 1) !== 0, bt = (bh >>> 1) & 3, bs = bh >>> 3;
      if (bt === 3) throw new Error('bt');
      const pb = bt === 1 ? 1 : bs;
      if (buf.length - o < pb) return out; o += pb;
      if (last) break;
    }
    if (chk) { if (buf.length - o < 4) return out; o += 4; }
    out.push({ s, e: o });
  }
  return out;
}

const buf = fs.readFileSync(process.argv[2]);
let plain = '';
for (const f of scanFrames(buf)) plain += zlib.zstdDecompressSync(buf.subarray(f.s, f.e)).toString('utf8');
const events = plain.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const byStep = {}; // step -> {R, T, tools:[], time}
for (const ev of events) {
  if (!ev.data) continue;
  const step = ev.data.step;
  if (step == null) continue;
  const b = (byStep[step] = byStep[step] || { R: 0, T: 0, tools: [], first: null, last: null });
  if (ev.time != null) { if (b.first === null) b.first = ev.time; b.last = ev.time; }
  if (ev.type === 'reasoning-chunks' && Array.isArray(ev.data.texts)) b.R += ev.data.texts.length;
  if (ev.type === 'text-chunks' && Array.isArray(ev.data.texts)) b.T += ev.data.texts.length;
  if (ev.type === 'tool/call') b.tools.push(ev.data.name + (ev.data.name.startsWith('subagent') || ev.data.name === 'workflow' || ev.data.name === 'ralph' ? '(' + (JSON.parse(ev.data.arguments || '{}').description || '').slice(0, 40) + ')' : ''));
}
const steps = Object.keys(byStep).map((k) => ({ step: +k, ...byStep[k] })).sort((a, b) => a.step - b.step);
const totalR = steps.reduce((a, s) => a + s.R, 0);
const totalT = steps.reduce((a, s) => a + s.T, 0);
console.log('STEPS', steps.length, 'TOTAL R', totalR, 'T', totalT);

console.log('\n== TOP 15 STEPS BY REASONING TOKENS ==');
const top = [...steps].sort((a, b) => b.R - a.R).slice(0, 15);
for (const s of top) {
  console.log('step', s.step, 'R', s.R, 'T', s.T, 'tools:', s.tools.slice(0, 5).join(' | '));
}

console.log('\n== POLL / JOB TOOL CALLS (list_agents, job_output, job_list) ==');
for (const s of steps) {
  const poll = s.tools.filter((t) => /^list_agents|^job_/.test(t));
  if (poll.length) console.log('step', s.step, 'R', s.R, 'T', s.T, poll.join(','));
}
const pollSteps = steps.filter((s) => s.tools.some((t) => /^list_agents|^job_/.test(t)));
console.log('poll steps total:', pollSteps.length, 'poll reasoning tokens:', pollSteps.reduce((a, s) => a + s.R, 0), 'poll text tokens:', pollSteps.reduce((a, s) => a + s.T, 0));

console.log('\n== SUBAGENT/WORKFLOW SPAWNS (step, tools) ==');
for (const s of steps) {
  const sp = s.tools.filter((t) => /^subagent|^workflow|^ralph/.test(t));
  if (sp.length) console.log('step', s.step, 'R', s.R, 'T', s.T, sp.join(' | '));
}

console.log('\n== FIRST 5 / LAST 5 STEPS ==');
for (const s of [...steps.slice(0, 5), ...steps.slice(-5)]) {
  console.log('step', s.step, 'R', s.R, 'T', s.T, 'tools:', s.tools.slice(0, 8).join(' | '));
}
