#!/usr/bin/env node
/**
 * kix-compaction-cap-patch (v3) — absolute caps on DSH >= 0.1.7 compaction-basic.
 *
 * Upstream (0.1.7 / master) already subtracts reserved completion tokens and
 * headroomTokens before the ratio. It still has no "never exceed N on any
 * window" field, and unknown keys abort plugin load. This patch adds:
 *
 *   ratioThreshold = floor(min(contextWindow * thresholdRatio, pressureBudget))
 *   thresholdTokens = min(maxThresholdTokens, ratioThreshold)
 *   retainTokens    = min(maxRetainTokens, ratio-or-absolute retain)
 *
 * pressureBudget is the upstream message budget after headroom. The caps are
 * an extra min(), so a smaller headroom budget still wins.
 *
 * Anchors are the 0.1.7 source. The 0.1.5 engine will refuse to patch (anchor
 * miss) instead of writing a mismatched formula.
 *
 * Idempotent. Re-run after every dsh upgrade (node_modules is replaced).
 * Usage: node kix-compaction-cap-patch.mjs [--check|--apply|--revert]
 * Env:   DSH_COMPACTION_PKG overrides the installed bundle location.
 *        Else KIX_DSH_PREFIX (install root, dsh package, or lib/bin.js), else
 *        the dsh on PATH. Packages are resolved the way Node loads them, so a
 *        pnpm workspace does not need a flat scope directory.
 *        A runtime without dsh-agent-preset-registry is refused. There is no
 *        fallback onto a 0.1.5 tree.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { resolveRuntime } = require('../dsh-runtime-resolve.js');

function resolveCompactionPkg() {
  if (process.env.DSH_COMPACTION_PKG) return process.env.DSH_COMPACTION_PKG;
  const runtime = resolveRuntime();
  if (!runtime) {
    throw new Error('no DSH install found. Set DSH_COMPACTION_PKG or KIX_DSH_PREFIX. Refusing to guess a 0.1.5 path.');
  }
  if (!runtime.registry) {
    throw new Error(`refusing to patch ${runtime.dshDir}: no dsh-agent-preset-registry. This cap patch is for DSH >= 0.1.7 and will not fall back to a 0.1.5 tree.`);
  }
  if (!runtime.compaction) {
    throw new Error(`refusing to patch ${runtime.dshDir}: preset registry resolved but dsh-compaction-basic did not.`);
  }
  return runtime.compaction;
}

const PKG = resolveCompactionPkg();
const FILE = path.join(PKG, 'lib', 'index.js');
const BACKUP = `${FILE}.kix-cap-backup`;
const MARKER = 'kix-cap-patch';

const EDITS = [
  {
    name: 'policy key set',
    from: `\t"retainTokens",
\t"summarizationProvider",`,
    to: `\t"retainTokens",
\t"maxThresholdTokens",
\t"maxRetainTokens",
\t"summarizationProvider",`,
  },
  {
    name: 'schemas for the new fields',
    from: `const retainTokensSchema = z.number().step(1).min(0);
const summarizationProviderSchema = z.string();`,
    to: `const retainTokensSchema = z.number().step(1).min(0);
/* ${MARKER} */ const maxThresholdTokensSchema = z.number().step(1).min(1);
const maxRetainTokensSchema = z.number().step(1).min(1);
const summarizationProviderSchema = z.string();`,
  },
  {
    name: 'validation',
    from: `\tif (retainTokens !== void 0) assertNonNegativeInteger(\`\${name}.retainTokens\`, retainTokens);
\tif (retainRatio !== void 0 && retainTokens !== void 0) throw new Error(\`\${name}: retainRatio and retainTokens are mutually exclusive\`);`,
    to: `\tif (retainTokens !== void 0) assertNonNegativeInteger(\`\${name}.retainTokens\`, retainTokens);
\tif (config.maxThresholdTokens !== void 0) assertPositiveInteger(\`\${name}.maxThresholdTokens\`, config.maxThresholdTokens);
\tif (config.maxRetainTokens !== void 0) assertPositiveInteger(\`\${name}.maxRetainTokens\`, config.maxRetainTokens);
\tif (retainRatio !== void 0 && retainTokens !== void 0) throw new Error(\`\${name}: retainRatio and retainTokens are mutually exclusive\`);`,
  },
  {
    name: 'resolveConfig defaults',
    from: `\t\theadroomTokens,
\t\t...retention,`,
    to: `\t\theadroomTokens,
\t\t...config.maxThresholdTokens === void 0 ? {} : { maxThresholdTokens: config.maxThresholdTokens },
\t\t...config.maxRetainTokens === void 0 ? {} : { maxRetainTokens: config.maxRetainTokens },
\t\t...retention,`,
  },
  {
    name: 'resolveTargetPolicy merge',
    from: `\t\theadroomTokens: override?.headroomTokens ?? config.headroomTokens,
\t\t...resolveRetention(override ?? {}, inheritedRetention),`,
    to: `\t\theadroomTokens: override?.headroomTokens ?? config.headroomTokens,
\t\t...override?.maxThresholdTokens !== void 0 || config.maxThresholdTokens !== void 0 ? { maxThresholdTokens: override?.maxThresholdTokens ?? config.maxThresholdTokens } : {},
\t\t...override?.maxRetainTokens !== void 0 || config.maxRetainTokens !== void 0 ? { maxRetainTokens: override?.maxRetainTokens ?? config.maxRetainTokens } : {},
\t\t...resolveRetention(override ?? {}, inheritedRetention),`,
  },
  {
    name: 'resolveCompactSpec thresholds',
    from: `\tconst thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens));
\tconst retainTokens = policy.retainTokens === void 0 ? Math.floor(messageBudgetTokens * policy.retainRatio) : policy.retainTokens;`,
    to: `\tconst ratioThreshold = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens));
\tconst thresholdTokens = Math.min(policy.maxThresholdTokens ?? Number.POSITIVE_INFINITY, ratioThreshold);
\tconst uncappedRetain = policy.retainTokens === void 0 ? Math.floor(messageBudgetTokens * policy.retainRatio) : policy.retainTokens;
\tconst retainTokens = Math.min(policy.maxRetainTokens ?? Number.POSITIVE_INFINITY, uncappedRetain);`,
  },
  {
    name: 'plugin Config schema',
    from: `\t\tretainTokens: retainTokensSchema,
\t\tsummarizationProvider: summarizationProviderSchema,`,
    to: `\t\tretainTokens: retainTokensSchema,
\t\tmaxThresholdTokens: maxThresholdTokensSchema,
\t\tmaxRetainTokens: maxRetainTokensSchema,
\t\tsummarizationProvider: summarizationProviderSchema,`,
  },
  {
    name: 'modelPolicy schema',
    from: `\tretainTokens: retainTokensSchema,
\tsummarizationProvider: summarizationProviderSchema,`,
    to: `\tretainTokens: retainTokensSchema,
\tmaxThresholdTokens: maxThresholdTokensSchema,
\tmaxRetainTokens: maxRetainTokensSchema,
\tsummarizationProvider: summarizationProviderSchema,`,
  },
];

const mode = process.argv[2] ?? '--apply';
const current = fs.readFileSync(FILE, 'utf8');

if (mode === '--revert') {
  if (!fs.existsSync(BACKUP)) throw new Error(`no backup at ${BACKUP}; cannot revert`);
  fs.copyFileSync(BACKUP, FILE);
  console.log(`reverted ${FILE} from ${BACKUP}`);
  process.exit(0);
}

if (mode === '--check') {
  const patched = current.includes(MARKER);
  console.log(patched ? 'PATCHED' : 'UNPATCHED');
  process.exit(patched ? 0 : 1);
}

if (current.includes(MARKER)) {
  console.log('already patched; nothing to do');
  process.exit(0);
}

let next = current;
for (const edit of EDITS) {
  const hits = next.split(edit.from).length - 1;
  if (hits !== 1) throw new Error(`anchor "${edit.name}" matched ${hits} times (expected 1) — refusing to write`);
  next = next.replace(edit.from, edit.to);
}

if (!fs.existsSync(BACKUP)) fs.copyFileSync(FILE, BACKUP);
const tmp = `${FILE}.tmp-kix-cap`;
fs.writeFileSync(tmp, next);
fs.renameSync(tmp, FILE);
console.log(`patched ${FILE}\nbackup: ${BACKUP}\nedits: ${EDITS.length}`);
