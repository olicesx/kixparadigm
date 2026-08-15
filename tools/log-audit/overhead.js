// Measure per-step input overhead: system prompt + tool catalog sizes from request/header
const fs = require('node:fs');
const zlib = require('node:zlib');
const ZSTD = 4247762216;
function scan(buf) {
  const out = []; let o = 0;
  while (o < buf.length) {
    const s = o;
    if (buf.length - o < 4) return out;
    if (buf.readUInt32LE(o) !== ZSTD) throw new Error('magic');
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
const file = process.argv[2];
const buf = fs.readFileSync(file);
let plain = '';
for (const f of scan(buf)) plain += zlib.zstdDecompressSync(buf.subarray(f.s, f.e)).toString('utf8');
// approx tokens: CJK ~1 token per char, ascii ~4 chars per token
function approxTokens(s) {
  let cjk = 0, ascii = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) > 0x2e7f) cjk++;
    else ascii++;
  }
  return Math.round(cjk + ascii / 4);
}
for (const line of plain.split('\n').filter((l) => l.trim())) {
  const ev = JSON.parse(line);
  if (ev.type === 'request/header') {
    const h = ev.data.header || ev.data || {};
    const sysText = typeof h.system === 'string' ? h.system : JSON.stringify(h.system || '');
    const tools = h.tools;
    const toolNames = Array.isArray(tools) ? tools.map((t) => (typeof t === 'string' ? t : (t.name || '?'))) : [];
    const toolsJson = Array.isArray(tools) ? JSON.stringify(tools) : '';
    const config = h.config || {};
    console.log('=== request/header ===');
    console.log('provider/model:', config.provider + '/' + config.model, '| effort:', config.reasoningEffort || '(none)');
    console.log('system chars:', sysText.length, '| system ~tokens:', approxTokens(sysText));
    console.log('tools count:', toolNames.length, '| tool names:', toolNames.join(','));
    console.log('tools JSON chars:', toolsJson.length, '| tools ~tokens:', approxTokens(toolsJson));
    break;
  }
}
