// Full inventory of DSH session logs: per-session aggregates.
// Usage: node inventory.js <sessionsRoot> <outJson>
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const ZSTD_MAGIC = 4247762216;

function scanFrames(buf) {
  const out = [];
  let o = 0;
  while (o < buf.length) {
    const s = o;
    if (buf.length - o < 4) return out;
    if (buf.readUInt32LE(o) !== ZSTD_MAGIC) throw new Error('bad magic @' + o);
    o += 4;
    if (o === buf.length) return out;
    const d = buf.readUInt8(o); o += 1;
    const csf = d >>> 6, ss = (d & 32) !== 0, chk = (d & 4) !== 0, df = d & 3;
    const db = df === 3 ? 4 : df;
    const cb = csf === 0 ? (ss ? 1 : 0) : 1 << csf;
    const rhb = (ss ? 0 : 1) + db + cb;
    if (buf.length - o < rhb) return out;
    o += rhb;
    for (;;) {
      if (buf.length - o < 3) return out;
      const bh = buf.readUIntLE(o, 3); o += 3;
      const last = (bh & 1) !== 0, bt = (bh >>> 1) & 3, bs = bh >>> 3;
      if (bt === 3) throw new Error('reserved block type');
      const pb = bt === 1 ? 1 : bs;
      if (buf.length - o < pb) return out;
      o += pb;
      if (last) break;
    }
    if (chk) { if (buf.length - o < 4) return out; o += 4; }
    out.push({ s, e: o });
  }
  return out;
}

function decodeAll(buf) {
  let plain = '';
  for (const f of scanFrames(buf)) plain += zlib.zstdDecompressSync(buf.subarray(f.s, f.e)).toString('utf8');
  return plain;
}

function decodeHeader(buf) {
  // first frame = header line
  const fr = scanFrames(buf);
  if (fr.length === 0) return null;
  try {
    const line = zlib.zstdDecompressSync(buf.subarray(fr[0].s, fr[0].e)).toString('utf8').split('\n')[0];
    return JSON.parse(line);
  } catch { return null; }
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl.zstd') || e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const root = process.argv[2];
const outFile = process.argv[3];
const files = walk(root, []);
const results = [];

for (const f of files) {
  let buf;
  try { buf = fs.readFileSync(f); } catch { continue; }
  const header = decodeHeader(buf);
  if (!header) { results.push({ file: f, error: 'no-header' }); continue; }
  const agg = {
    file: f.replace(root + path.sep, ''),
    id: header.id,
    cwd: header.cwd,
    parentSession: header.parentSession || null,
    origin: header.origin || null,
    depth: header.delegationDepth,
    preset: header.agentPreset,
    createdAt: header.createdAt,
    bytes: buf.length,
    events: 0,
    turns: new Set(),
    steps: 0,
    userMessages: 0,
    toolCalls: {},
    subagentCalls: [], // {name, argsPreview}
    reasoningTokens: 0,
    textTokens: 0,
    toolChunkRows: 0,
    models: new Set(),
    firstTime: null,
    lastTime: null,
  };
  try {
    const plain = decodeAll(buf);
    for (const line of plain.split('\n')) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      agg.events++;
      if (ev.time != null) {
        if (agg.firstTime === null) agg.firstTime = ev.time;
        agg.lastTime = ev.time;
      }
      switch (ev.type) {
        case 'turn/start': agg.turns.add(ev.data.turn); break;
        case 'step/start': agg.steps++; break;
        case 'user/message':
          agg.userMessages++;
          break;
        case 'request/context':
          if (ev.data) { agg.models.add(ev.data.provider + '/' + ev.data.model); }
          break;
        case 'tool/call': {
          const n = ev.data.name;
          agg.toolCalls[n] = (agg.toolCalls[n] || 0) + 1;
          if (/^(subagent|workflow|ralph)/.test(n)) {
            let preview = '';
            try {
              const a = JSON.parse(ev.data.arguments || '{}');
              preview = (a.description || '').slice(0, 120) + ' || ' + (a.prompt || '').slice(0, 160);
            } catch { preview = (ev.data.arguments || '').slice(0, 160); }
            agg.subagentCalls.push({ name: n, step: ev.data.step, callId: ev.data.callId, preview });
          }
          break;
        }
        case 'reasoning-chunks':
          if (ev.data && Array.isArray(ev.data.texts)) agg.reasoningTokens += ev.data.texts.length;
          break;
        case 'text-chunks':
          if (ev.data && Array.isArray(ev.data.texts)) agg.textTokens += ev.data.texts.length;
          break;
        case 'tool-call-chunks': agg.toolChunkRows++; break;
        default: break;
      }
    }
  } catch (e) {
    agg.error = String(e).slice(0, 200);
  }
  results.push({
    ...agg,
    turns: agg.turns.size,
    models: [...agg.models],
    firstTime: agg.firstTime,
    lastTime: agg.lastTime,
  });
}

results.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
console.log('SESSIONS', results.length);
