#!/usr/bin/env node
'use strict'
// kixparadigm — 跨平台安装器（preset 同步 + vision-bridge 挂载 + 卸载/自检）
//
// 由 npm postinstall 自动调用（--quiet），也可手动执行：
//   kixparadigm install [--preset-only]   一键导入（preset + vision-bridge）
//   kixparadigm uninstall                 卸载本包安装的全部内容
//   kixparadigm doctor                    自检安装状态
//   kixparadigm copilot                   （可选）导入 VS Code Copilot 侧
//
// 目标目录遵循 DSH 约定：$DSH_HOME（默认 ~/.dsh）
//   preset        → $DSH_HOME/.agent-presets/kixparadigm/
//   vision-bridge → $DSH_HOME/profiles/web/plugins/dsh-vision-bridge/（junction 指向）

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const PKG_ROOT = path.join(__dirname, '..')
// 各语言包的安装目标由各自 package.json 的 "kixparadigm" 段声明：
//   { presetId, presetDir, bridgeDir } —— 缺省 = 中文主包行为
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'))
const CFG = PKG.kixparadigm || {}
const PRESET_ID = CFG.presetId || 'kixparadigm'
const PRESET_DIR = CFG.presetDir || 'dsh/preset'
const BRIDGE_DIR = CFG.bridgeDir || 'dsh/vision-bridge'
const BRIDGE_NAME = 'dsh-vision-bridge'
const PATCH_ID = 'dsh-vision-bridge'

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function makeLog(quiet) {
  return {
    info(msg) { if (!quiet) console.log(`  ${msg}`) },
    ok(msg) { if (!quiet) console.log(`  ✔ ${msg}`) },
    warn(msg) { console.log(`  ⚠ ${msg}`) },
    step(msg) { if (!quiet) console.log(`\n==> ${msg}`) },
  }
}

/** 镜像复制 src → dst：同名同尺寸同 mtime 跳过；目标独有文件只报告不删除。 */
function copyTree(src, dst, log) {
  const added = [], updated = [], same = [], targetOnly = []
  const walk = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, entry.name)
      const d = path.join(to, entry.name)
      if (entry.isDirectory()) {
        fs.mkdirSync(d, { recursive: true })
        walk(s, d)
      } else {
        if (!fs.existsSync(d)) {
          fs.copyFileSync(s, d)
          added.push(path.relative(src, s))
        } else {
          const a = fs.statSync(s), b = fs.statSync(d)
          if (a.size === b.size && a.mtimeMs === b.mtimeMs) same.push(path.relative(src, s))
          else { fs.copyFileSync(s, d); updated.push(path.relative(src, s)) }
        }
      }
    }
  }
  fs.mkdirSync(dst, { recursive: true })
  walk(src, dst)
  if (fs.existsSync(dst)) {
    const walk2 = (from, rel) => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const s = path.join(from, entry.name)
        const r = rel ? `${rel}/${entry.name}` : entry.name
        const srcP = path.join(src, r)
        if (entry.isDirectory()) {
          if (!fs.existsSync(srcP)) targetOnly.push(r + '/')
          else walk2(s, r)
        } else if (!fs.existsSync(srcP)) {
          targetOnly.push(r)
        }
      }
    }
    walk2(dst, '')
  }
  return { added, updated, same, targetOnly }
}

function installPreset(log) {
  const src = path.join(PKG_ROOT, PRESET_DIR)
  const dst = path.join(dshHome(), '.agent-presets', PRESET_ID)
  if (!fs.existsSync(src)) throw new Error(`preset 源目录缺失: ${src}`)
  log.step(`安装 preset → ${dst}`)
  const r = copyTree(src, dst, log)
  log.ok(`preset：新增 ${r.added.length} / 更新 ${r.updated.length} / 相同 ${r.same.length}`)
  if (r.targetOnly.length) {
    log.warn(`目标侧独有 ${r.targetOnly.length} 个文件（保留未删，如需清理请人工确认）`)
    if (!process.env.KIX_VERBOSE) log.warn(`  ${r.targetOnly.slice(0, 5).join(', ')}${r.targetOnly.length > 5 ? ' …' : ''}`)
  }
  return r
}

/** 建立/修复 node_modules 链接（Windows junction，POSIX symlink）。 */
function ensureLink(linkPath, targetPath, log) {
  const target = path.resolve(targetPath)
  const isLink = (p) => {
    try { return fs.lstatSync(p).isSymbolicLink() } catch { return false }
  }
  if (fs.existsSync(linkPath)) {
    if (isLink(linkPath)) {
      let cur = null
      try { cur = path.resolve(fs.readlinkSync(linkPath)) } catch { /* ignore */ }
      if (cur === target) { log.ok(`链接正确: ${linkPath}`); return true }
      log.warn(`链接指向错误（${cur}），重建`)
      fs.unlinkSync(linkPath)
    } else {
      // 真实目录：仅当它是本插件副本时才替换，否则跳过
      const pkg = path.join(linkPath, 'package.json')
      if (fs.existsSync(pkg)) {
        let name = null
        try { name = JSON.parse(fs.readFileSync(pkg, 'utf8')).name } catch { /* ignore */ }
        if (name === BRIDGE_NAME) { fs.rmSync(linkPath, { recursive: true, force: true }) }
        else { log.warn(`node_modules/${BRIDGE_NAME} 是非本插件的真实目录，跳过替换`); return false }
      } else {
        log.warn(`node_modules/${BRIDGE_NAME} 是未知目录，跳过替换`)
        return false
      }
    }
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  if (process.platform === 'win32') fs.symlinkSync(target, linkPath, 'junction')
  else fs.symlinkSync(target, linkPath, 'dir')
  log.ok(`已建立链接: ${linkPath} -> ${target}`)
  return true
}

/** vision-bridge 挂载：插件文件 + node_modules 链接 + cordis.patch.yml 条目。 */
function installVisionBridge(log) {
  const home = dshHome()
  const profile = path.join(home, 'profiles', 'web')
  const source = path.join(profile, 'plugins', 'dsh-vision-bridge')
  const junction = path.join(profile, 'node_modules', 'dsh-vision-bridge')

  if (!fs.existsSync(path.join(PKG_ROOT, BRIDGE_DIR))) {
    log.warn('本包不含 vision-bridge 源码，跳过')
    return
  }
  log.step(`安装 vision-bridge → ${source}`)
  copyTree(path.join(PKG_ROOT, BRIDGE_DIR), source, log)

  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
  if (!pkg.exports || !pkg.exports['./package.json']) {
    log.warn('package.json exports 缺 ./package.json（client 半将无法注册），请检查源码')
  }

  log.step('建立加载链接（loader require.resolve 路径）')
  ensureLink(junction, source, log)

  log.step('登记 cordis.patch.yml 挂载条目')
  const patch = path.join(profile, 'cordis.patch.yml')
  const block = [
    '',
    '# ── dsh-vision-bridge（无缝识图，由 kixparadigm npm 包安装）──────────────',
    '# 主模型无视觉时：输入框粘贴/拖入图片 → 自动调 GLM-4.6V 转文本描述后提交。',
    '# 依赖 zai-vision provider 配置（settings.yaml 的 llm-pi-ai.providers.zai-vision）。',
    '- insert:',
    '    - id: dsh-vision-bridge',
    '      name: dsh-vision-bridge',
    '',
  ].join('\n')
  if (!fs.existsSync(patch)) {
    fs.mkdirSync(path.dirname(patch), { recursive: true })
    fs.writeFileSync(patch, block, 'utf8')
    log.ok(`已创建 ${patch}`)
  } else {
    const text = fs.readFileSync(patch, 'utf8')
    if (new RegExp(`id:\\s*${PATCH_ID}\\s*$`, 'm').test(text)) {
      log.ok('挂载条目已存在')
    } else {
      fs.appendFileSync(patch, block, 'utf8')
      log.ok('已追加挂载条目')
    }
  }
}

function reportSettingsChecklist(log) {
  log.step('settings.yaml 检查（preset 装不进去，需人工确认）')
  const home = dshHome()
  const settings = path.join(home, 'settings.yaml')
  let ok = true
  if (fs.existsSync(settings)) {
    const text = fs.readFileSync(settings, 'utf8')
    for (const name of ['zai-vision', 'zai-coding-cn']) {
      if (new RegExp(`\\b${name}\\b`).test(text)) log.ok(`llm-pi-ai.providers.${name} 已配置`)
      else { log.warn(`缺少 provider: ${name}`); ok = false }
    }
  } else {
    log.warn(`settings.yaml 不存在（${settings}）`)
    ok = false
  }
  if (!ok) {
    log.warn('请按 dsh/preset/DSH-ADAPTATION.md 的 settings.yaml 段补配置（zai-vision 视觉 provider + zai-coding-cn 跨厂商观察者）')
  }
}

function uninstall(log) {
  const home = dshHome()
  const preset = path.join(home, '.agent-presets', PRESET_ID)
  const source = path.join(home, 'profiles', 'web', 'plugins', BRIDGE_NAME)
  const junction = path.join(home, 'profiles', 'web', 'node_modules', BRIDGE_NAME)
  const patch = path.join(home, 'profiles', 'web', 'cordis.patch.yml')

  log.step('卸载 kixparadigm 安装内容')
  if (fs.existsSync(preset)) { fs.rmSync(preset, { recursive: true, force: true }); log.ok(`已删除 preset: ${preset}`) }
  else log.info('preset 不存在，跳过')
  if (fs.existsSync(junction)) {
    try {
      const st = fs.lstatSync(junction)
      if (st.isSymbolicLink()) fs.unlinkSync(junction)
      else fs.rmSync(junction, { recursive: true, force: true })
      log.ok(`已删除链接: ${junction}`)
    } catch (e) { log.warn(`删除链接失败: ${e.message}`) }
  }
  if (fs.existsSync(source)) { fs.rmSync(source, { recursive: true, force: true }); log.ok(`已删除插件: ${source}`) }
  if (fs.existsSync(patch)) {
    const lines = fs.readFileSync(patch, 'utf8').split('\n')
    const idx = lines.findIndex((l) => l.trim() === `- id: ${PATCH_ID}`)
    if (idx >= 0) {
      // 块 = [注释头] + [- insert: 行] + [id 行] + [name 行]（+ 紧随的一个空行）
      let start = idx
      while (start > 0 && lines[start - 1].trim() === '- insert:') start--
      let c = start - 1
      while (c >= 0 && /^\s*#/.test(lines[c])) c-- // 注释头向上到空行/非注释为止（区块间有空行分隔）
      start = c + 1
      let end = idx + 2 // id + name 两行
      if (lines[end] !== undefined && lines[end].trim() === '') end++
      const rest = [...lines.slice(0, start), ...lines.slice(end)].join('\n')
        .replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
      fs.writeFileSync(patch, rest, 'utf8')
      log.ok(`已从 ${patch} 移除挂载条目`)
    } else log.info('挂载条目不存在，跳过')
  }
  log.ok('卸载完成。重启 dsh web 后生效。')
}

function doctor(log) {
  const home = dshHome()
  log.step(`doctor — DSH_HOME = ${home}`)
  let allOk = true
  const preset = path.join(home, '.agent-presets', PRESET_ID)
  if (fs.existsSync(path.join(preset, 'agent.cordis.yml'))) log.ok('preset 已安装（agent.cordis.yml 存在）')
  else { log.warn('preset 未安装或缺失 agent.cordis.yml'); allOk = false }

  const source = path.join(home, 'profiles', 'web', 'plugins', BRIDGE_NAME)
  const junction = path.join(home, 'profiles', 'web', 'node_modules', BRIDGE_NAME)
  if (fs.existsSync(path.join(source, 'package.json'))) {
    log.ok('vision-bridge 插件文件就位')
    ensureLink(junction, source, log)
    const patch = path.join(home, 'profiles', 'web', 'cordis.patch.yml')
    if (fs.existsSync(patch) && new RegExp(`id:\\s*${PATCH_ID}\\s*$`, 'm').test(fs.readFileSync(patch, 'utf8'))) {
      log.ok('cordis.patch.yml 挂载条目就位')
    } else { log.warn('cordis.patch.yml 缺挂载条目（可运行 kixparadigm install 修复）'); allOk = false }
  } else {
    log.warn('vision-bridge 未安装')
    allOk = false
  }

  log.step('运行插件单元回归（installed preset）')
  for (const t of ['kix-guards.test.js', 'kix-commands.test.js', 'kix-cost.test.js']) {
    const test = path.join(preset, 'plugins', t)
    if (!fs.existsSync(test)) { log.warn(`测试文件缺失: ${test}`); allOk = false; continue }
    const r = spawnSync(process.execPath, [test], { stdio: 'inherit' })
    if (r.status === 0) log.ok(`${t} 通过`)
    else { log.warn(`${t} 失败 (exit ${r.status})`); allOk = false }
  }

  reportSettingsChecklist(log)
  log.step(allOk ? 'doctor：全部就绪。重启 dsh web 后开新会话生效。' : 'doctor：存在缺口，见上方 ⚠ 项。')
  return allOk
}

function installCopilot(log) {
  const ps1 = path.join(PKG_ROOT, 'install.ps1')
  const sh = path.join(PKG_ROOT, 'install.sh')
  if (process.platform === 'win32' && fs.existsSync(ps1)) {
    log.step('运行 install.ps1（VS Code Copilot 侧导入）')
    const pwsh = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: 'inherit' })
    if (pwsh.status !== 0) { log.warn(`install.ps1 退出码 ${pwsh.status}`); process.exitCode = pwsh.status ?? 1 }
  } else if (fs.existsSync(sh)) {
    log.step('运行 install.sh（VS Code Copilot 侧导入）')
    const r = spawnSync('bash', [sh], { stdio: 'inherit' })
    if (r.status !== 0) { log.warn(`install.sh 退出码 ${r.status}`); process.exitCode = r.status ?? 1 }
  } else {
    log.warn('未找到 install.ps1 / install.sh')
    process.exitCode = 1
  }
}

function cli(argv) {
  const args = argv || []
  const quiet = args.includes('--quiet') || args.includes('-q')
  const log = makeLog(quiet)
  if (args.includes('--version') || args.includes('-v') || args.includes('version')) {
    console.log(require(path.join(PKG_ROOT, 'package.json')).version)
    return
  }
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    console.log(`kixparadigm — kix 范式全家桶一键导入（preset: ${PRESET_ID}）
用法:
  kixparadigm install [--preset-only]  安装 preset + vision-bridge（默认；npm 安装时自动执行）
  kixparadigm uninstall                卸载全部安装内容
  kixparadigm doctor                   自检安装状态
  kixparadigm copilot                  导入 VS Code Copilot 侧（可选）
  kixparadigm --version
目标目录: $DSH_HOME（默认 ~/.dsh）`)
    return
  }
  const cmd = args.find((a) => !a.startsWith('-')) || 'install'
  try {
    switch (cmd) {
      case 'install': {
        if (!args.includes('--preset-only')) installVisionBridge(log)
        installPreset(log)
        reportSettingsChecklist(log)
        log.step('完成。重启 dsh web（Ctrl+C → dsh web）后开新会话，preset 生效；' +
          'vision-bridge client 半刷新页面即生效。')
        break
      }
      case 'uninstall': uninstall(log); break
      case 'doctor': process.exitCode = doctor(log) ? 0 : 1; break
      case 'copilot': installCopilot(log); break
      default:
        log.warn(`未知命令: ${cmd}（见 kixparadigm --help）`)
        process.exitCode = 1
    }
  } catch (e) {
    log.warn(`安装失败: ${e.message}`)
    if (process.env.KIX_DEBUG) console.error(e)
    process.exitCode = 1
  }
}

if (require.main === module) cli(process.argv.slice(2))

module.exports = { cli, dshHome, installPreset, installVisionBridge, uninstall, doctor, copyTree }
