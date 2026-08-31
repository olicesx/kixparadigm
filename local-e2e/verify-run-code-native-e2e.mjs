#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function resolveDshRoot() {
  if (process.env.DSH_PACKAGE_ROOT) return process.env.DSH_PACKAGE_ROOT
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const globalRoot = execFileSync(npm, ['root', '-g'], { encoding: 'utf8' }).trim()
  return join(globalRoot, '@deepseek-ai', 'dsh')
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

const dshRoot = resolveDshRoot()
const runtimeEntry = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-code-runtime-worker-thread', 'lib', 'index.js')
const cordisEntry = join(dshRoot, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')

for (const file of [runtimeEntry, cordisEntry]) {
  if (!existsSync(file)) throw new Error(`DSH runtime dependency not found: ${file}`)
}

const [{ default: WorkerThreadCodeRuntime }, { Context }] = await Promise.all([
  import(pathToFileURL(runtimeEntry).href),
  import(pathToFileURL(cordisEntry).href),
])

const tempDir = mkdtempSync(join(tmpdir(), 'kix-run-code-native-'))
const artifact = join(tempDir, 'artifact.txt')
const server = createServer((request, response) => {
  if (request.url !== '/probe') {
    response.writeHead(404).end('NOT_FOUND')
    return
  }
  response.writeHead(200, { 'content-type': 'text/plain' }).end('FETCH_OK')
})

let runtime
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  const probeUrl = `http://127.0.0.1:${address.port}/probe`

  const context = new Context()
  runtime = new WorkerThreadCodeRuntime(context, {
    computeMs: 5_000,
    maxWallMs: 15_000,
    maxOutputBytes: 1024 * 1024,
    maxOldGenerationSizeMb: 64,
  })

  const program = `
const assert = await import('node:assert/strict')
const childProcess = await import('node:child_process')
const fs = await import('node:fs')
const { URL } = await import('node:url')
const zlib = await import('node:zlib')

const parsed = new URL('https://example.com/path?value=7')
assert.equal(parsed.searchParams.get('value'), '7')
const zipped = zlib.gzipSync('KIX_NATIVE')
assert.equal(zlib.gunzipSync(zipped).toString('utf8'), 'KIX_NATIVE')
const generated = Function('value', 'return value + 1')(6)

fs.writeFileSync(${JSON.stringify(artifact)}, 'FS_OK', 'utf8')
const fsValue = fs.readFileSync(${JSON.stringify(artifact)}, 'utf8')
const childValue = childProcess.execFileSync(process.execPath, ['-e', 'process.stdout.write("CHILD_OK")'], { encoding: 'utf8' })
const fetchValue = await (await fetch(${JSON.stringify(probeUrl)})).text()

return {
  childValue,
  envKeys: Object.keys(process.env).length,
  fetchValue,
  fsValue,
  generated,
  gzipBytes: zipped.byteLength,
}
`

  const result = await runtime.run({ program, bindings: [] })
  assert.equal(result.error, undefined, JSON.stringify(result.error))
  assert.deepEqual(result.value, {
    childValue: 'CHILD_OK',
    envKeys: 0,
    fetchValue: 'FETCH_OK',
    fsValue: 'FS_OK',
    generated: 7,
    gzipBytes: 30,
  })
  assert.equal(readFileSync(artifact, 'utf8'), 'FS_OK')
  console.log('RUN-CODE-NATIVE-E2E-ACCEPT')
} finally {
  if (runtime) await runtime.teardown()
  await closeServer(server)
  rmSync(tempDir, { recursive: true, force: true })
}
