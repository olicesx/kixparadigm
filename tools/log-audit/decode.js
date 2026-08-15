// Multi-frame zstd JSONL session decoder + header inventory
// Usage: node decode.js <session-file> [--headers] [--types] [--dump-events N]
const fs = require('node:fs');
const zlib = require('node:zlib');

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528

function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return frames;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return frames;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error('reserved frame-header bit');
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return frames;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return frames;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('reserved block type');
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return frames;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

function decodeAll(buffer) {
  const frames = scanZstdFrames(buffer);
  let plain = '';
  for (const f of frames) {
    plain += zlib.zstdDecompressSync(buffer.subarray(f.start, f.end)).toString('utf8');
  }
  return plain;
}

function loadLines(file) {
  const buf = fs.readFileSync(file);
  const plain = decodeAll(buf);
  return plain.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

const file = process.argv[2];
const mode = process.argv[3] || '--types';
const lines = loadLines(file);
console.log('TOTAL_EVENTS', lines.length);

if (mode === '--headers') {
  // header-only mode handled elsewhere
}
const types = {};
for (const ev of lines) {
  const t = ev.type || ev.$type || '?';
  types[t] = (types[t] || 0) + 1;
}
console.log('TYPE_COUNTS', JSON.stringify(types));

if (mode === '--dump' || mode === '--types') {
  const seen = {};
  let dumped = 0;
  for (const ev of lines) {
    const t = ev.type || '?';
    if (!seen[t] && (mode === '--dump' || ['session', 'assistant/start', 'user/message', 'tool/call', 'subagent/start', 'subagent/end'].includes(t))) {
      seen[t] = true;
      dumped++;
      console.log('---', t, '---');
      console.log(JSON.stringify(ev).slice(0, 1200));
      if (dumped > 40) break;
    }
  }
}
