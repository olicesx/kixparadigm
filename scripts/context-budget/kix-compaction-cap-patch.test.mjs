/**
 * Real-code tests for the kix compaction cap patch.
 * Runs against the live patched bundle via a probe copy (only an added export).
 *
 * Invariant under test: T = min(maxThresholdTokens, floor(W * thresholdRatio))
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PKG = process.env.DSH_COMPACTION_PKG
  ?? '/usr/local/lib/dsh-0.1.5-rc.1/node_modules/@deepseek-ai/dsh-compaction-basic';
const LIB = path.join(PKG, 'lib');
const INDEX = path.join(LIB, 'index.js');
const PROBE = path.join(LIB, '__probe_exports.mjs');

if (!fs.existsSync(INDEX)) {
  console.log(`SKIP: no DSH compaction bundle at ${PKG} (set DSH_COMPACTION_PKG to test one)`);
  process.exit(0);
}
if (!fs.readFileSync(INDEX, 'utf8').includes('kix-cap-patch')) {
  console.log('SKIP: the installed bundle is not patched (run kix-compaction-cap-patch.mjs --apply)');
  process.exit(0);
}
fs.copyFileSync(INDEX, PROBE);
fs.appendFileSync(PROBE, '\nexport { resolveConfig, resolveTargetPolicy, resolveCompactSpec };\n');
process.on('exit', () => { try { fs.rmSync(PROBE, { force: true }); } catch {} });

const { resolveConfig, resolveTargetPolicy, resolveCompactSpec, BasicCompactionEngine } = await import(PROBE);

const spec = (cfg, provider, model, W) =>
  resolveCompactSpec(resolveTargetPolicy(resolveConfig(cfg), { provider, model }), W);

// 1. cap binds on a 1M window
const capped = { thresholdRatio: 0.8, maxThresholdTokens: 200_000 };
assert.equal(spec(capped, 'zai-coding-cn', 'glm-5.3', 1_000_000).thresholdTokens, 200_000);
console.log('OK 1M  cap binds: 0.8*1M=800000 -> min(cap) =', spec(capped, 'zai-coding-cn', 'glm-5.3', 1_000_000).thresholdTokens);

// 2. cap binds just above the ratio on a 262K window (0.8*262144=209715)
assert.equal(spec(capped, 'grok', 'grok-4.6', 262_144).thresholdTokens, 200_000);
console.log('OK 262K cap binds: 0.8*262144=209715 -> min(cap) = 200000');

// 3. ratio binds below the cap on a 131K window
assert.equal(spec(capped, 'zai-vision', 'glm-4.6v', 131_072).thresholdTokens, 104_857);
console.log('OK 131K ratio binds: 0.8*131072=104857 < cap = 104857');

// 4. per-model override can raise the cap for a proven long-context route
const perModel = {
  thresholdRatio: 0.8,
  maxThresholdTokens: 200_000,
  modelPolicies: [{ provider: 'openai', model: 'gpt-5.5', maxThresholdTokens: 400_000 }],
};
assert.equal(spec(perModel, 'openai', 'gpt-5.5', 1_000_000).thresholdTokens, 400_000);
assert.equal(spec(perModel, 'zai-coding-cn', 'glm-5.3', 1_000_000).thresholdTokens, 200_000);
console.log('OK per-model override: gpt-5.5 -> 400000, others stay at 200000');

// 5. backward compatibility: without the field nothing changes
const legacy = { thresholdRatio: 0.45 };
assert.equal(spec(legacy, 'deepseek-official', 'deepseek-flash', 1_000_000).thresholdTokens, 450_000);
assert.equal(spec(legacy, 'zai-coding-cn', 'glm-5.3', 1_000_000).thresholdTokens, 450_000);
console.log('OK backward compat: unchanged 0.45 ratio path = 450000');

// 6. a cap equal to/below retain is rejected (the livelock guard)
assert.throws(
  () => spec({ thresholdRatio: 0.8, maxThresholdTokens: 200_000, retainTokens: 200_000 }, 'zai-coding-cn', 'glm-5.3', 1_000_000),
  /must be less than threshold/,
);
console.log('OK guard: retainTokens >= capped threshold is rejected');

// 7. malformed cap values are rejected at load
for (const bad of [0, -1, 1.5]) {
  assert.throws(() => resolveConfig({ maxThresholdTokens: bad }), /maxThresholdTokens/);
}
assert.throws(() => resolveConfig({ maxThresholdToken: 200000 }), /unknown key/);
console.log('OK validation: 0 / -1 / 1.5 rejected, typo key rejected');

// 8. the cordis loader schema preserves the new field (top level and per model)
const normalized = BasicCompactionEngine.Config({
  thresholdRatio: 0.8,
  maxThresholdTokens: 200_000,
  modelPolicies: [{ provider: 'openai', model: 'gpt-5.5', maxThresholdTokens: 400_000 }],
});
assert.equal(normalized.maxThresholdTokens, 200_000);
assert.equal(normalized.modelPolicies[0].maxThresholdTokens, 400_000);
console.log('OK loader schema: top-level and per-model cap preserved');

// 9. the shipped default (no cap, no ratio) still resolves to 0.8 of the window
assert.equal(spec({}, 'zai-coding-cn', 'glm-5.3', 1_000_000).thresholdTokens, 800_000);
console.log('OK shipped default untouched: 0.8*1M = 800000');

console.log('\nALL CAP TESTS PASSED');
