/**
 * Verifier for kix-apply-abs-cap.sh — proves the absolute-cap config is loadable
 * by the PATCHED on-disk module, so a restart cannot break the mount.
 *
 *   node kix-apply-abs-cap.verify.mjs --block        # verify the target block text
 *   node kix-apply-abs-cap.verify.mjs                # verify the four written presets
 *
 * For every window from 32K to 4M it asserts T = min(200000, 0.8W) and
 * R = min(64000, 0.044W) on an UNLISTED route, i.e. the automatic-adaptation claim.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PKG = path.join(process.env.DSH_COMPACTION_PKG
  ?? '/usr/local/lib/dsh-0.1.5-rc.1/node_modules/@deepseek-ai/dsh-compaction-basic', 'lib');
const PROBE = path.join(PKG, '__probe_verify.mjs');
const PRESET_DIR = process.env.DSH_PRESET_ROOT ?? path.join(process.env.HOME ?? '/root', '.dsh/.agent-presets');
const BLOCK_FILE = new URL('./kix-apply-abs-cap.block', import.meta.url);
const PRESETS = ['kixparadigm', 'kixparadigm-classic', 'kixparadigm-classic-en', 'kixparadigm-null'];
const CAP_T = 200_000;
const CAP_R = 64_000;
const F = 23_000;

const yaml = (await import(path.resolve(PKG, '../../../js-yaml/index.js'))).default;
const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (d) => d })]);

const src = fs.readFileSync(path.join(PKG, 'index.js'), 'utf8');
assert.ok(src.includes('kix-cap-patch'), 'the on-disk module is NOT patched — run kix-compaction-cap-patch.mjs --apply first');
fs.copyFileSync(path.join(PKG, 'index.js'), PROBE);
fs.appendFileSync(PROBE, '\nexport { resolveConfig, resolveTargetPolicy, resolveCompactSpec };\n');

let ok = true;
try {
  const { resolveConfig, resolveTargetPolicy, resolveCompactSpec } = await import(PROBE);

  const check = (label, cfg) => {
    const resolved = resolveConfig(cfg); // throws on unknown keys — the mount-abort failure mode
    assert.equal(resolved.thresholdRatio, 0.8, `${label}: thresholdRatio`);
    assert.equal(resolved.maxThresholdTokens, CAP_T, `${label}: maxThresholdTokens`);
    assert.equal(resolved.maxRetainTokens, CAP_R, `${label}: maxRetainTokens`);
    for (const W of [32_768, 65_536, 131_072, 262_144, 1_000_000, 1_250_000, 2_000_000, 4_000_000]) {
      const spec = resolveCompactSpec(resolveTargetPolicy(resolved, { provider: 'future-vendor', model: 'future-model' }), W);
      assert.equal(spec.thresholdTokens, Math.min(CAP_T, Math.floor(0.8 * W)), `${label}: T at W=${W}`);
      assert.equal(spec.retainTokens, Math.min(CAP_R, Math.floor(0.044 * W)), `${label}: R at W=${W}`);
      if (W >= 200_000) {
        assert.ok(spec.thresholdTokens <= CAP_T, `${label}: T at W=${W} exceeds the sweet spot`);
        assert.ok(spec.thresholdTokens - F - spec.retainTokens >= 8_000, `${label}: band at W=${W} too narrow`);
      }
    }
    console.log(`   OK ${label}: T = min(200K, 0.8W), R = min(64K, 0.044W) for 32K..4M`);
  };

  if (process.argv.includes('--block')) {
    // the block file is a complete entry, so it parses as a one-item YAML list
    for (const name of ['kix-apply-abs-cap.block', 'kix-apply-abs-cap.en.block']) {
      const parsed = yaml.load(fs.readFileSync(new URL('./' + name, import.meta.url), 'utf8'), { schema });
      check(name, (Array.isArray(parsed) ? parsed[0] : parsed).config);
    }
  } else {
    for (const p of PRESETS) {
      const doc = yaml.load(fs.readFileSync(path.join(PRESET_DIR, p, 'agent.cordis.yml'), 'utf8'), { schema });
      const cfg = doc.find((e) => e.id === 'compaction').config.find((r) => r.id === 'compaction-basic').config;
      check(p, cfg);
    }
    const first = yaml.load(fs.readFileSync(path.join(PRESET_DIR, PRESETS[0], 'agent.cordis.yml'), 'utf8'), { schema });
    const c0 = JSON.stringify(first.find((e) => e.id === 'compaction').config.find((r) => r.id === 'compaction-basic').config);
    for (const p of PRESETS.slice(1)) {
      const doc = yaml.load(fs.readFileSync(path.join(PRESET_DIR, p, 'agent.cordis.yml'), 'utf8'), { schema });
      assert.equal(JSON.stringify(doc.find((e) => e.id === 'compaction').config.find((r) => r.id === 'compaction-basic').config), c0,
        `${p}: compaction config differs from ${PRESETS[0]}`);
    }
    console.log('   OK four presets carry an identical absolute-cap config');
  }
} catch (e) {
  ok = false;
  console.error(`   FAILED: ${e.message}`);
} finally {
  fs.rmSync(PROBE, { force: true });
}
process.exit(ok ? 0 : 1);
