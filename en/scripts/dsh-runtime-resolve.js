'use strict'

// Locate the packages a dsh process actually loads.
//
// npm installs put every @deepseek-ai package in one scope directory. A pnpm
// workspace does not: dsh-agent-preset-registry is resolved from dsh-web-app,
// and the session migrations are resolved from session-format-catalog. Walking
// only the install root misses those files, so a patch would land nowhere the
// process imports. This walks Node's node_modules algorithm from the dsh
// package, then from each package it finds, which is where that package's own
// imports start.

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const DSH_NAME = '@deepseek-ai/dsh'

const NEEDED = [
  'dsh-agent-preset-registry',
  'dsh-base',
  'dsh-compaction-basic',
  'dsh-session',
  'dsh-session-format-catalog',
  'dsh-session-format-v0-to-v1',
  'dsh-session-format-v1-to-v2',
  'dsh-session-format-v2-to-v3',
  'dsh-session-persistence',
  'dsh-session-persistence-jsonl',
  'dsh-tool-subagent',
  'dsh-web-app',
  'dsh-workflow-ptc',
]

function readName(pkgJson) {
  if (!fs.existsSync(pkgJson)) return null
  try {
    return JSON.parse(fs.readFileSync(pkgJson, 'utf8')).name
  } catch {
    return null
  }
}

function whichDsh() {
  try {
    const found = execFileSync('which', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return found.length > 0 ? found : null
  } catch {
    return null
  }
}

function packageRoot(startDir) {
  let dir = startDir
  for (let i = 0; i < 8; i++) {
    if (readName(path.join(dir, 'package.json')) === DSH_NAME) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** @returns the @deepseek-ai/dsh package directory, or null. */
function resolveDshPackage(explicit) {
  let target = explicit
  if (target === undefined || target === null || target === '') {
    target = process.env.KIX_DSH_PREFIX || whichDsh()
  }
  if (!target) return null
  target = path.resolve(target)
  let stat
  try {
    stat = fs.statSync(target)
  } catch {
    return null
  }
  if (stat.isFile()) {
    let real = target
    try { real = fs.realpathSync(target) } catch { /* keep the path */ }
    return packageRoot(path.dirname(real))
  }
  if (readName(path.join(target, 'package.json')) === DSH_NAME) return target
  const nested = path.join(target, 'node_modules', '@deepseek-ai', 'dsh')
  if (readName(path.join(nested, 'package.json')) === DSH_NAME) return nested
  const scopeChild = path.join(target, 'dsh')
  if (readName(path.join(scopeChild, 'package.json')) === DSH_NAME) return scopeChild
  return null
}

/** Node's node_modules walk for one package name. Returns the real package directory. */
function walk(start, name) {
  const rel = path.join('node_modules', ...name.split('/'), 'package.json')
  let dir = start
  for (let i = 0; i < 24; i++) {
    const candidate = path.join(dir, rel)
    if (fs.existsSync(candidate)) {
      try {
        return fs.realpathSync(path.dirname(candidate))
      } catch {
        return path.dirname(candidate)
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * @param {{ explicit?: string }} [options]
 * @returns {{ dshDir: string, packages: Record<string, string>, registry: string | null, compaction: string | null } | null}
 */
function resolveRuntime(options = {}) {
  const dshDir = resolveDshPackage(options.explicit)
  if (!dshDir) return null
  let start = dshDir
  try { start = fs.realpathSync(dshDir) } catch { /* the package path is already real */ }
  const packages = {}
  const seen = new Set([start])
  const queue = [start]
  while (queue.length > 0) {
    const dir = queue.shift()
    for (const short of NEEDED) {
      if (packages[short]) continue
      const hit = walk(dir, `@deepseek-ai/${short}`)
      if (!hit) continue
      packages[short] = hit
      if (!seen.has(hit)) {
        seen.add(hit)
        queue.push(hit)
      }
    }
  }
  return {
    dshDir,
    packages,
    registry: packages['dsh-agent-preset-registry'] || null,
    compaction: packages['dsh-compaction-basic'] || null,
  }
}

module.exports = { resolveDshPackage, resolveRuntime, walk }
