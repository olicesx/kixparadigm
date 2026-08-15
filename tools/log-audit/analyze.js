// decode + selective dump for the DSH JSONL zstd session logs
const fs = require('node:fs');
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
  const fsr = scanFrames(buf);
  let plain = '';
  for (const f of fsr) plain += zlib.zstdDecompressSync(buf.subarray(f.s, f.e)).toString('utf8');
  return plain;
}

function loadEvents(file) {
  const buf = fs.readFileSync(file);
  return decodeAll(buf).split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

const file = process.argv[2];
const mode = process.argv[3] || 'types';
const events = loadEvents(file);

if (mode === 'types') {
  const counts = {};
  for (const ev of events) counts[ev.type] = (counts[ev.type] || 0) + 1;
  console.log(JSON.stringify(counts, null, 0));
} else if (mode === 'shapes') {
  const want = new Set(process.argv.slice(4));
  const seen = {};
  for (const ev of events) {
    if (!seen[ev.type] && (want.size === 0 || want.has(ev.type))) {
      seen[ev.type] = 1;
      console.log('---' + ev.type + '---');
      console.log(JSON.stringify(ev).slice(0, 1200));
    }
  }
} else if (mode === 'headers') {
  for (const ev of events) {
    if (ev.type === 'request/header') {
      const h = ev.data.header || {};
      console.log('reason:', ev.data.reason, '| adapterDefaults:', JSON.stringify(h.adapterDefaults || {}), '| config:', JSON.stringify(h.config || {}).slice(0, 400));
    }
    if (ev.type === 'request/context') console.log('request/context:', ev.data.provider + '/' + ev.data.model);
  }
} else if (mode === 'summary') {
  // per-agent/tool/turn aggregate
  const toolCalls = {};
  const turns = new Set();
  const steps = new Set();
  let reasoning = 0, text = 0, toolChunks = 0, sys = 0;
  for (const ev of events) {
    switch (ev.type) {
      case 'tool/call':
        toolCalls[ev.data.name] = (toolCalls[ev.data.name] || 0) + 1;
        turns.add(ev.data.turn); steps.add(ev.data.step);
        break;
      case 'reasoning-chunks': reasoning++; break;
      case 'text-chunks': text++; break;
      case 'tool-call-chunks': toolChunks++; break;
      case 'assistant/message': break;
      default: break;
    }
  }
  console.log('TURNS', [...turns].length, 'STEPS', [...steps].length);
  console.log('TOOL_CALLS', JSON.stringify(toolCalls));
  console.log('CHUNK_ROWS', JSON.stringify({ reasoning, text, toolChunks }));
}
