#!/usr/bin/env node
'use strict'

/**
 * kixparadigm — re-apply the DSH session-history availability patch to an
 * installed DSH runtime.
 *
 * Why this file exists
 * --------------------
 * DSH 0.1.5 reads legacy (format v0) session logs through
 * `@deepseek-ai/dsh-session-format-v0-to-v1`, whose migration refuses every
 * event type outside the frozen released-v0 inventory — explicitly "even when
 * ignorable". Plugin-authored audit events therefore make a whole session log
 * unreadable ("历史加载失败: ... migration refuses unknown historical events").
 *
 * The writer side is broken too: `Session.append` accepts an options object but
 * only reads its surface fields, so a plugin that passes `{ ignorable: true }`
 * gets an event persisted without the marker. Such an event then also fails the
 * current-generation read path (`validateStoredEvents`), which refuses unknown
 * types that are not marked ignorable.
 *
 * The hunks below restore the writer contract and admit the known plugin audit
 * events as opaque, log-only rows. They are applied to the *installed* runtime
 * because the alternative — editing node_modules by hand — is lost on the next
 * DSH upgrade. That is exactly how the 2026-09-10 hand patch disappeared under
 * 0.1.5: it lived only in `/usr/local/lib/dsh-0.1.2-rc.1/node_modules/...`.
 *
 * Run this after every DSH upgrade:
 *
 *   node scripts/patch-dsh-runtime.js --check   # non-zero when a hunk is missing
 *   node scripts/patch-dsh-runtime.js           # apply missing hunks (idempotent)
 *
 * In this deployment the runtime is only loaded after `systemctl restart
 * dsh-web`, because Node caches the already-imported modules.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

/**
 * Plugin-authored session events admitted as opaque, log-only rows.
 *
 * `web/glm-search-mcp-request` is written by the local GLM web-search provider
 * (`profiles/web/plugins/dsh-web-search-glm`). It is an audit record of the
 * outgoing search request; it drives no session surface, and its writer passes
 * `{ ignorable: true }`. Sessions recorded between the 0.1.5 upgrade and this
 * patch — and every session recorded by the 0.1.2 runtime, whose append API
 * predates the marker — carry it without the marker.
 *
 * Keep this set narrow: anything listed here bypasses payload validation.
 */
const LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES = ['web/glm-search-mcp-request']

const lines = (...parts) => parts.join('\n')

const PLUGIN_SET = lines(
  '/**',
  ' * Audit-only plugin events admitted without a released-format disposition.',
  ' * Their writer asked for `ignorable` through an append API that did not',
  ' * persist the marker, so the migration re-emits them with it. Keep this set',
  ' * narrow: a type listed here skips payload validation.',
  ' */',
  'const LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES = new Set([',
  '\t"web/glm-search-mcp-request"',
  ']);',
)

const HUNKS = [
  {
    id: 'session-append-ignorable',
    pkg: 'dsh-session',
    file: 'lib/index.js',
    summary: 'Session.append persists and forwards the `ignorable` envelope marker',
    marker: 'extraOpts?.ignorable === true ? { ignorable: true } : {}',
    edits: [
      {
        find: lines(
          '\tappend(type, data, ...opts) {',
          '\t\tconst surfaceOpts = opts[0];',
          '\t\tconst surfaceMetadata = {',
          '\t\t\t...surfaceOpts?.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: surfaceOpts.sourceEventSeqs },',
          '\t\t\t...surfaceOpts?.surfaceOp === void 0 ? {} : { surfaceOp: surfaceOpts.surfaceOp }',
          '\t\t};',
        ),
        replace: lines(
          '\tappend(type, data, ...opts) {',
          '\t\tconst extraOpts = opts[0];',
          '\t\tconst surfaceMetadata = {',
          '\t\t\t...extraOpts?.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: extraOpts.sourceEventSeqs },',
          '\t\t\t...extraOpts?.surfaceOp === void 0 ? {} : { surfaceOp: extraOpts.surfaceOp }',
          '\t\t};',
        ),
      },
      {
        find: lines('\t\t\tdata: dataSnapshot,', '\t\t\t...surfaceMetadataSnapshot', '\t\t});'),
        replace: lines(
          '\t\t\tdata: dataSnapshot,',
          '\t\t\t...surfaceMetadataSnapshot,',
          '\t\t\t...extraOpts?.ignorable === true ? { ignorable: true } : {}',
          '\t\t});',
        ),
      },
    ],
  },
  {
    id: 'persistence-admit-legacy-plugin-events',
    pkg: 'dsh-session-persistence',
    file: 'lib/index.js',
    summary: 'current-generation reads admit the known plugin audit events',
    marker: 'LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES.has(event.type)',
    edits: [
      {
        find: lines(
          'function validateStoredEvents(meta, events, location) {',
          '\tfor (const event of events) {',
          '\t\tif (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported(',
        ),
        replace: lines(
          PLUGIN_SET,
          'function validateStoredEvents(meta, events, location) {',
          '\tfor (const event of events) {',
          '\t\tif (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true && !LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES.has(event.type)) throw unsupported(',
        ),
      },
    ],
  },
  {
    id: 'v0-migration-admit-legacy-plugin-events',
    pkg: 'dsh-session-format-v0-to-v1',
    file: 'lib/index.js',
    summary: 'v0 -> v1 migration admits the known plugin audit events as opaque rows',
    marker: 'const pluginAudit = LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES.has(type);',
    edits: [
      {
        find: lines(
          'const LEGACY_SOURCE_TYPES = new Set([',
          '\t"steering/message",',
          '\t"request/header-delta",',
          '\t"mode/set",',
          '\t"compact/start",',
          '\t"compact/summary",',
          '\t"compact/end",',
          '\t"compact/prune"',
          ']);',
        ),
        replace: lines(
          'const LEGACY_SOURCE_TYPES = new Set([',
          '\t"steering/message",',
          '\t"request/header-delta",',
          '\t"mode/set",',
          '\t"compact/start",',
          '\t"compact/summary",',
          '\t"compact/end",',
          '\t"compact/prune"',
          ']);',
          PLUGIN_SET,
        ),
      },
      {
        find: lines(
          '\t\tconst legacy = allowLegacySteering && LEGACY_SOURCE_TYPES.has(type);',
          '\t\tconst currentKnown = knownEventTypes?.has(type) === true;',
          '\t\tconst ignorableCurrent = !allowLegacySteering && !currentKnown && record["ignorable"] === true;',
          '\t\tif (!currentKnown && !legacy && !ignorableCurrent && !vocabularyNeutral) {',
        ),
        replace: lines(
          '\t\tconst legacy = allowLegacySteering && LEGACY_SOURCE_TYPES.has(type);',
          '\t\tconst currentKnown = knownEventTypes?.has(type) === true;',
          '\t\tconst ignorableCurrent = !allowLegacySteering && !currentKnown && record["ignorable"] === true;',
          '\t\tconst pluginAudit = LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES.has(type);',
          '\t\tif (!currentKnown && !legacy && !ignorableCurrent && !pluginAudit && !vocabularyNeutral) {',
        ),
      },
      {
        find: lines(
          '\tconst disposition = RELEASED_V0_EVENT_DISPOSITIONS[event.type];',
          '\t/* v8 ignore next -- artifact coordinate validation admits only the frozen inventory before payload validation. */',
          '\tif (disposition === void 0) throw new SessionFormatUnsupportedMigrationError(`format v0 contains unknown historical event type ${JSON.stringify(event.type)} at seq ${event.seq}; migration refuses unknown historical events even when ignorable`);',
        ),
        replace: lines(
          '\tconst disposition = RELEASED_V0_EVENT_DISPOSITIONS[event.type];',
          '\t/* Admitted plugin audit events stay opaque: no released disposition interprets them. */',
          '\tif (disposition === void 0) {',
          '\t\tif (LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES.has(event.type)) return;',
          '\t\tthrow new SessionFormatUnsupportedMigrationError(`format v0 contains unknown historical event type ${JSON.stringify(event.type)} at seq ${event.seq}; migration refuses unknown historical events even when ignorable`);',
          '\t}',
        ),
      },
      {
        find: lines(
          '\tif (message.type !== "assistant/chunk") assertReleasedEventPayload(message, 0);',
          '\tconst messageId = eventMessageId(message);',
          '\tif (messageId !== void 0) state.messageIds.set(message.seq, messageId);',
          '\treturn message;',
          '}',
        ),
        replace: lines(
          '\tif (message.type !== "assistant/chunk") assertReleasedEventPayload(message, 0);',
          '\tconst admitted = LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES.has(message.type) && message.ignorable !== true',
          '\t\t? { ...message, ignorable: true }',
          '\t\t: message;',
          '\tconst messageId = eventMessageId(admitted);',
          '\tif (messageId !== void 0) state.messageIds.set(admitted.seq, messageId);',
          '\treturn admitted;',
          '}',
        ),
      },
      {
        find: 'export { RELEASED_V0_EVENT_DISPOSITIONS,',
        replace: 'export { LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES, RELEASED_V0_EVENT_DISPOSITIONS,',
      },
    ],
  },
  {
    id: 'v1-migration-admit-legacy-plugin-events',
    pkg: 'dsh-session-format-v1-to-v2',
    file: 'lib/index.js',
    summary: 'v1 -> v2 migration forwards the admitted plugin audit events unchanged',
    marker: '!LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES.has(event.type)) throw refusal(',
    edits: [
      {
        find: 'import { RELEASED_V0_EVENT_DISPOSITIONS,',
        replace: 'import { LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES, RELEASED_V0_EVENT_DISPOSITIONS,',
      },
      {
        find: '\tif (RELEASED_V0_EVENT_DISPOSITIONS[event.type] === void 0) throw refusal(`format v1 contains unknown event type ${JSON.stringify(event.type)} at seq ${event.seq}`);',
        replace: lines(
          '\t/* Admitted plugin audit events stay opaque rows: no released disposition interprets them. */',
          '\tif (RELEASED_V0_EVENT_DISPOSITIONS[event.type] === void 0 && !LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES.has(event.type)) throw refusal(`format v1 contains unknown event type ${JSON.stringify(event.type)} at seq ${event.seq}`);',
        ),
      },
    ],
  },
  {
    id: 'v2-migration-admit-legacy-plugin-events',
    pkg: 'dsh-session-format-v2-to-v3',
    file: 'lib/index.js',
    summary: 'v2 -> v3 migration carries the admitted plugin audit events through unclassified',
    marker: 'if (pluginAudit) return;',
    edits: [
      {
        find: 'import { assertReleasedPayloadSemantics, assertReleasedSurfaceMetadata } from "@deepseek-ai/dsh-session-format-v0-to-v1";',
        replace: 'import { LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES, assertReleasedPayloadSemantics, assertReleasedSurfaceMetadata } from "@deepseek-ai/dsh-session-format-v0-to-v1";',
      },
      {
        find: lines(
          '\tconst disposition = RELEASED_V2_EVENT_DISPOSITIONS[event.type];',
          '\tconst feedback = event.type === "feedback/message-put" || event.type === "feedback/message-delete";',
          '\tif (disposition === void 0 && !feedback) throw new SessionFormatUnsupportedMigrationError("format v2 to v3 cannot safely transform unclassified event " + event.type);',
        ),
        replace: lines(
          '\tconst disposition = RELEASED_V2_EVENT_DISPOSITIONS[event.type];',
          '\tconst feedback = event.type === "feedback/message-put" || event.type === "feedback/message-delete";',
          '\tconst pluginAudit = disposition === void 0 && LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES.has(event.type);',
          '\t/* Admitted plugin audit events keep their envelope and skip payload classification. */',
          '\tif (disposition === void 0 && !feedback && !pluginAudit) throw new SessionFormatUnsupportedMigrationError("format v2 to v3 cannot safely transform unclassified event " + event.type);',
        ),
      },
      {
        find: lines(
          '\tif (feedback) {',
          '\t\tassertFeedback(event.type, data);',
          '\t\treturn;',
          '\t}',
          '\tconst admitted = disposition;',
        ),
        replace: lines(
          '\tif (feedback) {',
          '\t\tassertFeedback(event.type, data);',
          '\t\treturn;',
          '\t}',
          '\tif (pluginAudit) return;',
          '\tconst admitted = disposition;',
        ),
      },
    ],
  },
  {
    id: 'v0-descriptor-v2-admission',
    pkg: 'dsh-session-format-v0-to-v1',
    file: 'lib/index.js',
    summary: 'descriptor v2 (retired, folded to undefined by every runtime) stops blocking the log',
    marker: 'descriptorVersion !== 2',
    edits: [
      {
        find: '\t\tif (version === 0) throw new SessionFormatUnsupportedMigrationError(`${event.type} ${event.seq} uses unsupported descriptor version ${descriptorVersion}`);',
        replace: lines(
          '\t\t/* Descriptor v2 is retired but well shaped: 0.1.2 and 0.1.5 both fold a non-v3',
          '\t\t   descriptor to undefined, so the row stays inert instead of making the log',
          '\t\t   unreadable. Unknown descriptor versions still refuse. */',
          '\t\tif (version === 0 && descriptorVersion !== 2) throw new SessionFormatUnsupportedMigrationError(`${event.type} ${event.seq} uses unsupported descriptor version ${descriptorVersion}`);',
        ),
      },
      {
        find: lines(
          'function subagentDescriptorValue(data, label) {',
          '\tliteralValue(data["version"], [3], `${label} version`);',
        ),
        replace: lines(
          'function subagentDescriptorValue(data, label) {',
          '\t/* Retired descriptor v2 payloads stay opaque: no consumer classifies them. */',
          '\tif (data["version"] === 2) return;',
          '\tliteralValue(data["version"], [3], `${label} version`);',
        ),
      },
    ],
  },
  {
    id: 'v0-retired-inbox-forms',
    pkg: 'dsh-session-format-v0-to-v1',
    file: 'lib/index.js',
    summary: 'retired kix inbox provenance labels (gate/debug) keep their notice-shaped payload',
    marker: 'const noticeLike = form === "notice" || form === "gate" || form === "debug";',
    edits: [
      {
        find: lines(
          '\tconst form = source["form"];',
          '\tif (form === void 0) return;',
          '\tliteralValue(form, [',
          '\t\t"instructions",',
          '\t\t"catalog",',
          '\t\t"snapshot",',
          '\t\t"notice",',
          '\t\t"relay",',
          '\t\t"recall"',
          '\t], `${label} form`);',
          '\tif (form === "snapshot") arrayValue(source["sections"], `${label} sections`, (member, memberLabel) => {',
          '\t\tconst section = exactRecord(member, memberLabel, ["name", "text"]);',
          '\t\tnonEmptyString(section["name"], `${memberLabel} name`);',
          '\t\tstringValue(section["text"], `${memberLabel} text`);',
          '\t});',
          '\telse if (source["sections"] !== void 0) throw new SessionFormatError(`${label} sections require snapshot form`);',
          '\tif (form === "notice") stringValue(source["summary"], `${label} summary`);',
          '\telse if (source["summary"] !== void 0) throw new SessionFormatError(`${label} summary requires notice form`);',
        ),
        replace: lines(
          '\tconst form = source["form"];',
          '\tif (form === void 0) return;',
          '\t/* `gate` / `debug` were written by early kix injection revisions and carry the same',
          '\t   `summary` provenance as `notice`. Nothing reads this label, so retired values keep',
          '\t   the notice rules; values we never shipped still refuse. */',
          '\tconst noticeLike = form === "notice" || form === "gate" || form === "debug";',
          '\tliteralValue(form, [',
          '\t\t"instructions",',
          '\t\t"catalog",',
          '\t\t"snapshot",',
          '\t\t"notice",',
          '\t\t"relay",',
          '\t\t"recall",',
          '\t\t"gate",',
          '\t\t"debug"',
          '\t], `${label} form`);',
          '\tif (form === "snapshot") arrayValue(source["sections"], `${label} sections`, (member, memberLabel) => {',
          '\t\tconst section = exactRecord(member, memberLabel, ["name", "text"]);',
          '\t\tnonEmptyString(section["name"], `${memberLabel} name`);',
          '\t\tstringValue(section["text"], `${memberLabel} text`);',
          '\t});',
          '\telse if (source["sections"] !== void 0) throw new SessionFormatError(`${label} sections require snapshot form`);',
          '\tif (noticeLike) stringValue(source["summary"], `${label} summary`);',
          '\telse if (source["summary"] !== void 0) throw new SessionFormatError(`${label} summary requires notice form`);',
        ),
      },
    ],
  },
]

/** Resolve `<runtime>/lib/bin.js` for the `dsh` executable on PATH, if any. */
function dshBinFromPath() {
  try {
    const found = execFileSync('which', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return found.length > 0 ? found : undefined
  } catch {
    return undefined
  }
}

/**
 * Locate the `@deepseek-ai` scope directory the `dsh` launcher actually loads.
 *
 * Node resolves `@deepseek-ai/dsh-session` upward from the `dsh` package, so the
 * packages live next to it; a hand-edited copy elsewhere would have no effect.
 *
 * @param explicit - `--runtime` override, a `@deepseek-ai` scope directory.
 * @returns absolute scope directory.
 */
function locateRuntime(explicit) {
  if (explicit !== undefined) {
    if (!fs.existsSync(path.join(explicit, 'dsh-session', 'package.json'))) {
      throw new Error(`--runtime ${explicit} does not contain dsh-session/package.json`)
    }
    return path.resolve(explicit)
  }
  if (process.env.DSH_RUNTIME !== undefined && process.env.DSH_RUNTIME.length > 0) return locateRuntime(process.env.DSH_RUNTIME)

  const candidates = []
  const bin = dshBinFromPath()
  if (bin !== undefined) {
    try {
      candidates.push(path.dirname(path.dirname(path.dirname(fs.realpathSync(bin)))))
    } catch {
      /* the launcher is not resolvable; fall through to the layout defaults */
    }
  }
  candidates.push('/usr/local/lib/node_modules/@deepseek-ai')
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (globalRoot.length > 0) candidates.push(path.join(globalRoot, '@deepseek-ai'))
  } catch {
    /* npm is optional; the layout defaults above cover the supported installs */
  }

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'dsh-session', 'package.json'))) return path.resolve(candidate)
  }
  throw new Error(`no DSH runtime found; tried:\n  ${candidates.join('\n  ')}\npass --runtime <@deepseek-ai dir>`)
}

/** Read one hunk's target file for a resolved runtime. */
function readHunk(scopeDir, hunk) {
  const file = path.join(scopeDir, hunk.pkg, hunk.file)
  if (!fs.existsSync(file)) throw new Error(`${hunk.id}: missing file ${file}`)
  return { file, source: fs.readFileSync(file, 'utf8') }
}

/** Classify one hunk as applied, missing, or blocked by a moved anchor. */
function inspectHunk(scopeDir, hunk) {
  const { file, source } = readHunk(scopeDir, hunk)
  let text = source
  const pending = []
  for (const [index, edit] of hunk.edits.entries()) {
    if (text.includes(edit.replace)) continue
    const occurrences = text.split(edit.find).length - 1
    if (occurrences !== 1) {
      return { state: 'anchor-mismatch', file, detail: `edit ${index + 1}: anchor occurs ${occurrences} times (expected 1)` }
    }
    pending.push(edit)
    text = text.replace(edit.find, edit.replace)
  }
  return { state: pending.length === 0 ? 'applied' : 'missing', file, pending }
}

/** Apply one hunk's pending edits, asserting every remaining anchor is unique. */
function patchHunk(scopeDir, hunk) {
  const { file, source } = readHunk(scopeDir, hunk)
  let text = source
  let changed = 0
  for (const [index, edit] of hunk.edits.entries()) {
    if (text.includes(edit.replace)) continue
    const occurrences = text.split(edit.find).length - 1
    if (occurrences !== 1) throw new Error(`${hunk.id}: edit ${index + 1} anchor occurs ${occurrences} times (expected 1)`)
    text = text.replace(edit.find, edit.replace)
    changed += 1
  }
  if (changed === 0) return { file, changed }
  if (!text.includes(hunk.marker)) throw new Error(`${hunk.id}: rewrite did not produce its marker`)
  const backup = `${file}.kix-orig`
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
  fs.writeFileSync(file, text)
  return { file, changed, backup }
}

/** CLI entry point. */
function main(argv) {
  const flags = new Set(argv.filter((value) => value.startsWith('--')))
  const runtimeIndex = argv.indexOf('--runtime')
  const explicit = runtimeIndex === -1 ? undefined : argv[runtimeIndex + 1]
  if (runtimeIndex !== -1 && explicit === undefined) {
    process.stderr.write('patch-dsh-runtime: --runtime needs a directory\n')
    return 2
  }

  const scopeDir = locateRuntime(explicit)
  const check = flags.has('--check')
  const dryRun = flags.has('--dry-run')
  process.stdout.write(`patch-dsh-runtime: runtime ${scopeDir}\n`)

  let missing = 0
  let mismatched = 0
  for (const hunk of HUNKS) {
    const status = inspectHunk(scopeDir, hunk)
    if (status.state === 'applied') {
      process.stdout.write(`  applied   ${hunk.id}\n`)
      continue
    }
    if (status.state === 'anchor-mismatch') {
      mismatched += 1
      process.stdout.write(`  MISMATCH  ${hunk.id}: ${status.detail}\n`)
      continue
    }
    missing += 1
    if (check) {
      process.stdout.write(`  missing   ${hunk.id} — ${hunk.summary}\n`)
      continue
    }
    if (dryRun) {
      process.stdout.write(`  would-apply ${hunk.id} — ${hunk.summary}\n`)
      continue
    }
    const { file, changed } = patchHunk(scopeDir, hunk)
    process.stdout.write(`  patched   ${hunk.id} (${changed} edit(s)) -> ${file}\n`)
  }

  if (mismatched > 0) {
    process.stderr.write('\npatch-dsh-runtime: anchors moved (DSH changed); review the hunks before patching.\n')
    return 1
  }
  if (check && missing > 0) {
    process.stderr.write(`\npatch-dsh-runtime: ${missing} hunk(s) missing — run without --check to apply, then restart dsh-web.\n`)
    return 1
  }
  if (!check && !dryRun && missing > 0) {
    process.stdout.write('\npatch-dsh-runtime: applied; restart dsh-web for the runtime to load the patched modules.\n')
  }
  return 0
}

if (require.main === module) process.exitCode = main(process.argv.slice(2))

module.exports = {
  HUNKS,
  LEGACY_IGNORABLE_PLUGIN_EVENT_TYPES,
  dshBinFromPath,
  inspectHunk,
  locateRuntime,
  main,
  patchHunk,
}
