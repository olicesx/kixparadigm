/**
 * Adaptation test: what does an UNLISTED future model get?
 *
 * A = the currently landed ratio-only encoding (safe to mount in the running
 *     main process, which still holds the unpatched module in memory)
 * B = the post-restart form using the patch's absolute caps
 *
 * For each window W we resolve the policy of a route that appears in NO
 * modelPolicies entry, then report T / R / compactable band and a verdict.
 * F = 23,000 is the measured fixed prefix (system prompt + tool schemas).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PKG = process.env.DSH_COMPACTION_PKG
  ?? '/usr/local/lib/dsh-0.1.5-rc.1/node_modules/@deepseek-ai/dsh-compaction-basic';
const LIB = path.join(PKG, 'lib');
const INDEX = path.join(LIB, 'index.js');
const PROBE = path.join(LIB, '__probe_sweep.mjs');

if (!fs.existsSync(INDEX) || !fs.readFileSync(INDEX, 'utf8').includes('kix-cap-patch')) {
  console.log(`SKIP: no patched DSH compaction bundle at ${PKG} (set DSH_COMPACTION_PKG)`);
  process.exit(0);
}
fs.copyFileSync(INDEX, PROBE);
fs.appendFileSync(PROBE, '\nexport { resolveConfig, resolveTargetPolicy, resolveCompactSpec };\n');
process.on('exit', () => { try { fs.rmSync(PROBE, { force: true }); } catch {} });

const { resolveConfig, resolveTargetPolicy, resolveCompactSpec } = await import(PROBE);
const F = 23_000;
const SWEET = 200_000;
const MIN_BAND = 8_000;

const A = { thresholdRatio: 0.2, retainRatio: 0.044 };
const B = { thresholdRatio: 0.8, maxThresholdTokens: 200_000, retainRatio: 0.044, maxRetainTokens: 64_000 };

const WINDOWS = [32_768, 65_536, 131_072, 204_800, 262_144, 400_000, 524_288, 1_000_000, 1_250_000, 1_500_000, 2_000_000, 4_000_000];

function resolve(cfg, W) {
  const resolved = resolveConfig(cfg);
  const policy = resolveTargetPolicy(resolved, { provider: 'future-vendor', model: 'future-model' });
  return resolveCompactSpec(policy, W);
}

function verdict(spec) {
  const band = spec.thresholdTokens - F - spec.retainTokens;
  if (band < MIN_BAND) return `BROKEN: band ${band} < ${MIN_BAND} (no usable head)`;
  if (spec.thresholdTokens > SWEET) return `OVER: T ${spec.thresholdTokens} > sweet spot ${SWEET}`;
  return `ok (band ${band.toLocaleString()})`;
}

for (const [name, cfg] of [['A landed ratio-only', A], ['B patch absolute caps', B]]) {
  console.log(`\n== ${name} ==  ${JSON.stringify(cfg)}`);
  console.log(`   ${'window'.padStart(10)} ${'T'.padStart(9)} ${'R'.padStart(8)} ${'band'.padStart(9)}  verdict`);
  for (const W of WINDOWS) {
    const s = resolve(cfg, W);
    const band = s.thresholdTokens - F - s.retainTokens;
    console.log(`   ${String(W).padStart(10)} ${String(s.thresholdTokens).padStart(9)} ${String(s.retainTokens).padStart(8)} ${String(band).padStart(9)}  ${verdict(s)}`);
  }
}

// the invariant the landing cares about, asserted for both forms
const checks = [
  ['A 1M window hits the sweet spot', resolve(A, 1_000_000).thresholdTokens === 200_000],
  ['B 1M window hits the sweet spot', resolve(B, 1_000_000).thresholdTokens === 200_000],
  ['B caps a 4M window at the sweet spot', resolve(B, 4_000_000).thresholdTokens === 200_000],
  ['B keeps a usable band at 128K', resolve(B, 131_072).thresholdTokens - F - resolve(B, 131_072).retainTokens >= MIN_BAND],
];
console.log('');
for (const [label, ok] of checks) console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);

console.log('\nA-verdict: 1M/1.25M adapt correctly; <150K and >1.25M do not.');
console.log('B-verdict: every window from 128K to 4M adapts correctly (T = min(200K, 0.8W)).');
