#!/usr/bin/env node
/**
 * kix-compaction-cap-patch (v2) — add two absolute caps to the installed
 * @deepseek-ai/dsh-compaction-basic so the two-constraint policy is expressible:
 *
 *   thresholdTokens = min(maxThresholdTokens, floor(contextWindow * thresholdRatio))
 *   retainTokens    = min(maxRetainTokens,    floor(contextWindow * retainRatio) or absolute retainTokens)
 *
 * Why a patch: the shipped policy schema has only ratios (assertRatio enforces
 * (0,1]), so "never exceed N tokens on ANY model" — and "never retain more than
 * M tokens on a huge window" — are not expressible in configuration.
 *
 * Idempotent. Re-run after every dsh upgrade (node_modules is replaced).
 * Usage: node kix-compaction-cap-patch.mjs [--check|--revert]
 * Env:   DSH_COMPACTION_PKG overrides the installed bundle location
 */
import fs from 'node:fs';
import path from 'node:path';

const PKG = process.env.DSH_COMPACTION_PKG
	?? '/usr/local/lib/dsh-0.1.5-rc.1/node_modules/@deepseek-ai/dsh-compaction-basic';
const FILE = path.join(PKG, 'lib/index.js');
const BACKUP = path.join(PKG, 'lib/index.js.orig-kix-cap');
const MARKER = '/* kix-cap-patch v2 */';

const EDITS = [
  {
    name: 'policy key set',
    from: `const POLICY_CONFIG_KEYS = [
	"thresholdRatio",
	"retainRatio",
	"retainTokens",`,
    to: `const POLICY_CONFIG_KEYS = [
	"thresholdRatio",
	"retainRatio",
	"retainTokens",
	"maxThresholdTokens",
	"maxRetainTokens",`,
  },
  {
    name: 'schemas for the new fields',
    from: `const retainTokensSchema = z.number().step(1).min(0);`,
    to: `const retainTokensSchema = z.number().step(1).min(0);
${MARKER}
// absolute caps in tokens; effective budgets are min(cap, ratio * contextWindow)
const maxThresholdTokensSchema = z.number().step(1).min(1);
const maxRetainTokensSchema = z.number().step(1).min(1);`,
  },
  {
    name: 'validation',
    from: `	if (retainTokens !== void 0) assertNonNegativeInteger(\`\${name}.retainTokens\`, retainTokens);`,
    to: `	if (retainTokens !== void 0) assertNonNegativeInteger(\`\${name}.retainTokens\`, retainTokens);
	if (config.maxThresholdTokens !== void 0) assertPositiveInteger(\`\${name}.maxThresholdTokens\`, config.maxThresholdTokens);
	if (config.maxRetainTokens !== void 0) assertPositiveInteger(\`\${name}.maxRetainTokens\`, config.maxRetainTokens);`,
  },
  {
    name: 'resolveConfig defaults',
    from: `	return deepFreeze({
		thresholdRatio,
		...retention,
		summarizationProvider: config.summarizationProvider ?? "",`,
    to: `	return deepFreeze({
		thresholdRatio,
		...retention,
		maxThresholdTokens: config.maxThresholdTokens,
		maxRetainTokens: config.maxRetainTokens,
		summarizationProvider: config.summarizationProvider ?? "",`,
  },
  {
    name: 'resolveTargetPolicy merge',
    from: `		thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
		...resolveRetention(override ?? {}, inheritedRetention),`,
    to: `		thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
		maxThresholdTokens: override?.maxThresholdTokens ?? config.maxThresholdTokens,
		maxRetainTokens: override?.maxRetainTokens ?? config.maxRetainTokens,
		...resolveRetention(override ?? {}, inheritedRetention),`,
  },
  {
    name: 'resolveCompactSpec thresholds',
    from: `	const thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio);
	const retainTokens = policy.retainTokens === void 0 ? Math.floor(contextWindow * policy.retainRatio) : policy.retainTokens;`,
    to: `	${MARKER}
	// absolute caps win over the ratios; the ratios still bound small windows
	const ratioThreshold = Math.floor(contextWindow * policy.thresholdRatio);
	const thresholdTokens = Math.min(policy.maxThresholdTokens ?? Number.POSITIVE_INFINITY, ratioThreshold);
	const ratioRetain = policy.retainTokens === void 0 ? Math.floor(contextWindow * policy.retainRatio) : policy.retainTokens;
	const retainTokens = Math.min(policy.maxRetainTokens ?? Number.POSITIVE_INFINITY, ratioRetain);`,
  },
  {
    name: 'resolved spec exposes the caps',
    from: `		contextWindow,
		thresholdRatio: policy.thresholdRatio,
		thresholdTokens,
		retainTokens,`,
    to: `		contextWindow,
		thresholdRatio: policy.thresholdRatio,
		maxThresholdTokens: policy.maxThresholdTokens,
		maxRetainTokens: policy.maxRetainTokens,
		thresholdTokens,
		retainTokens,`,
  },
  {
    name: 'plugin Config schema',
    from: `	static Config = z.object({
		thresholdRatio: thresholdRatioSchema,
		retainRatio: retainRatioSchema,
		retainTokens: retainTokensSchema,`,
    to: `	static Config = z.object({
		thresholdRatio: thresholdRatioSchema,
		retainRatio: retainRatioSchema,
		retainTokens: retainTokensSchema,
		maxThresholdTokens: maxThresholdTokensSchema,
		maxRetainTokens: maxRetainTokensSchema,`,
  },
  {
    name: 'modelPolicy schema',
    from: `const modelPolicy = z.object({
	provider: z.string().required(),
	model: z.string().required(),
	thresholdRatio: thresholdRatioSchema,
	retainRatio: retainRatioSchema,
	retainTokens: retainTokensSchema,`,
    to: `const modelPolicy = z.object({
	provider: z.string().required(),
	model: z.string().required(),
	thresholdRatio: thresholdRatioSchema,
	retainRatio: retainRatioSchema,
	retainTokens: retainTokensSchema,
	maxThresholdTokens: maxThresholdTokensSchema,
	maxRetainTokens: maxRetainTokensSchema,`,
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
