#!/usr/bin/env bash
# WSL2 cross-repo verification for kix-consistency generalization (PR #12).
# Loads the INSTALLED plugin from ~/.dsh/.agent-presets and fires real
# pre/post-execute listeners against foreign fixture repos on disk.
set -euo pipefail
export HOME=/root
ZH=/root/.dsh/.agent-presets/kixparadigm
REPORT=/tmp/kix-verification/12-consistency-generalization.md
mkdir -p /tmp/kix-verification

echo '== 0) installed artifact =='
grep -n "80 断言" "$ZH/agent.cordis.yml" || true
grep -cn 'discoverPresetRoots' "$ZH/plugins/consistency-lib.cjs" || true

echo '== 1) installed plugin unit tests (Linux) =='
node "$ZH/plugins/kix-consistency.test.js" | tail -3

echo '== 2) foreign fixtures =='
mk() { mkdir -p "$(dirname "$1")"; printf '%s' "$2" > "$1"; }
for d in kix-foreign-multi kix-foreign-single kix-foreign-plain kix-foreign-vscode kix-foreign-marker; do
  rm -rf "/root/$d"; mkdir -p "/root/$d"
done
# multi: custom layout, zh-only plugin (drift target)
for r in pkgs/zh pkgs/en; do
  mk "/root/kix-foreign-multi/$r/agent.cordis.yml" $'text: |-\n  x\n'
  mk "/root/kix-foreign-multi/$r/preset.yml" $'id: x\n'
done
mk /root/kix-foreign-multi/pkgs/zh/plugins/m.js 'M'
# vscode: two preset roots + drifted root import-source copy
for r in pkgs/zh pkgs/en; do
  mk "/root/kix-foreign-vscode/$r/agent.cordis.yml" $'text: |-\n  x\n'
  mk "/root/kix-foreign-vscode/$r/preset.yml" $'id: x\n'
  mk "/root/kix-foreign-vscode/$r/plugins/g.js" 'G'
done
mk /root/kix-foreign-vscode/plugins/g.js 'IMPORT-SOURCE-DRIFTED'
# single: one preset root only
mk /root/kix-foreign-single/preset/agent.cordis.yml $'text: |-\n  x\n'
mk /root/kix-foreign-single/preset/preset.yml $'id: x\n'
mk /root/kix-foreign-single/preset/plugins/s.js 'S'
# marker: two dirs with agent.cordis.yml only (no preset.yml) — must NOT count
for r in alpha beta; do
  mk "/root/kix-foreign-marker/$r/agent.cordis.yml" $'text: |-\n  x\n'
done
mk /root/kix-foreign-marker/alpha/plugins/x.js 'X'
# plain: empty repo
mk /root/kix-foreign-plain/src/a.js 'A'
# kix regression fixture: ensure markers + contract entry exist
if [ -d /root/kix-p5-e2e ]; then
  for r in dsh/preset en/preset; do
    [ -f "/root/kix-p5-e2e/$r/agent.cordis.yml" ] || mk "/root/kix-p5-e2e/$r/agent.cordis.yml" $'text: |-\n  x\n'
    [ -f "/root/kix-p5-e2e/$r/preset.yml" ] || mk "/root/kix-p5-e2e/$r/preset.yml" $'id: x\n'
  done
  [ -f /root/kix-p5-e2e/scripts/check-dsh-consistency.cjs ] || mk /root/kix-p5-e2e/scripts/check-dsh-consistency.cjs '#!/usr/bin/env node\n'
fi

echo '== 3) live listener scenarios (installed plugin) =='
node - <<'EOF' 2>&1 | tee /tmp/kix-verification/12-driver-output.txt
const plugin = require('/root/.dsh/.agent-presets/kixparadigm/plugins/kix-consistency.js')
function makeHarness(wsRoot) {
  const listeners = {}
  const ctx = {
    config: {},
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'sandboxPolicy') {
        return {
          workspaceRoot: wsRoot,
          resolve(req) {
            const cwd = req && req.session && req.session.header && req.session.header.cwd
            return { workspaceRoot: cwd || wsRoot }
          },
        }
      }
      return undefined
    },
    on(ev, cb) { (listeners[ev] ||= []).push(cb) },
    effect() {},
    tools: { register() { return () => {} } },
    commands: { register() { return () => {} } },
  }
  plugin.apply(ctx, {})
  return { pre: listeners['tools/pre-execute'][0], post: listeners['tools/post-execute'][0] }
}
let pass = 0, fail = 0
async function check(label, cond) {
  if (cond) { pass++; console.log('PASS  ' + label) } else { fail++; console.log('FAIL  ' + label) }
}
async function run(name, wsRoot, files) {
  const h = makeHarness(wsRoot)
  const agent = { id: 'drv-' + name }
  const out = []
  for (let i = 0; i < files.length; i++) {
    const callId = name + '-' + i
    await h.pre({ name: 'write', callId, arguments: { file_path: files[i] }, agent }, () => 'NEXT')
    const post = await h.post({ name: 'write', callId, agent }, {}, () => 'NEXT')
    out.push(post && post.additionalContexts ? post.additionalContexts.map((m) => m.content[0].text).join(' | ') : null)
  }
  return out
}
async function runShell(name, wsRoot, cmd, tool) {
  const h = makeHarness(wsRoot)
  const agent = { id: 'drvsh-' + name }
  const callId = 'sh-' + name
  await h.pre({ name: tool || 'pwsh', callId, arguments: { command: cmd }, agent }, () => 'NEXT')
  const post = await h.post({ name: tool || 'pwsh', callId, agent }, {}, () => 'NEXT')
  return post && post.additionalContexts ? post.additionalContexts.map((m) => m.content[0].text).join(' | ') : null
}
(async () => {
  const r1 = await run('multi', '/root/kix-foreign-multi', ['pkgs/zh/plugins/m.js', 'pkgs/zh/agent.cordis.yml', 'pkgs/zh/skills/new.md'])
  await check('S1 外仓双根（pkgs/zh+pkgs/en）漂移写入 → remind 指向 pkgs/en 缺失份', r1[0] !== null && r1[0].includes('pkgs/en/plugins/m.js missing'))
  await check('S2 外仓 persona 写入（无契约脚本）→ parity hint（由你判断）', r1[1] !== null && r1[1].includes('由你判断'))
  await check('S2b 未描述形态（skills）→ hint 已给过，remindOnce 静默', r1[2] === null)
  const r3 = await run('vscode', '/root/kix-foreign-vscode', ['plugins/g.js', 'pkgs/zh/plugins/g.js'])
  await check('S3 根 plugins/（非 preset 根）写入 → 零开销放行（边界 = preset 根）', r3[0] === null)
  await check('S3b 同仓 preset 根内一致写入 → 不误报', r3[1] === null)
  const r4 = await run('single', '/root/kix-foreign-single', ['preset/plugins/s.js'])
  await check('S4 单 preset 根 → 零开销（≥2 才引导）', r4[0] === null)
  const r5 = await run('plain', '/root/kix-foreign-plain', ['src/a.js'])
  await check('S5 普通仓库 → 零开销', r5[0] === null)
  const r6 = await run('marker', '/root/kix-foreign-marker', ['alpha/plugins/x.js'])
  await check('S7 单标记（无 preset.yml）→ 不算 preset 根，零开销', r6[0] === null)
  const fs = require('node:fs')
  const s8 = await runShell('drift', '/root/kix-foreign-multi', 'cp /tmp/new.js pkgs/zh/plugins/shell.js')
  await check('S8 shell 写漂移插件（pwsh）→ post 复验注入 drift 提醒', s8 !== null && s8.includes('shell 写入后检测到身份组漂移'))
  const s9 = await runShell('skill', '/root/kix-foreign-multi', 'Set-Content pkgs/zh/skills/shell-skill.md hi')
  await check('S9 shell 写根内非 plugins（pwsh）→ parity hint', s9 !== null && s9.includes('由你判断'))
  const s10 = await runShell('unrel', '/root/kix-foreign-multi', 'npm install && npm test')
  await check('S10 shell 未提及 preset 根路径 → 零开销', s10 === null)
  const s11 = await runShell('bashdrift', '/root/kix-foreign-multi', 'sed -i s/a/b/ pkgs/zh/plugins/m.js', 'bash')
  await check('S11 bash 通道同样覆盖（漂移提醒）', s11 !== null && s11.includes('身份组漂移'))
  // S12：kix-guards v13 源豁免自感知（安装副本插件，跨仓库）
  {
    const guards = require('/root/.dsh/.agent-presets/kixparadigm/plugins/kix-guards.js')
    const gl = {}
    const gctx = {
      logger: { info() {}, warn() {}, error() {} },
      get() { return undefined },
      on(ev, cb) { (gl[ev] ||= []).push(cb) },
    }
    guards.apply(gctx, {})
    const foreignAgent = { id: 'g12', session: { header: { cwd: '/root/kix-foreign-multi' } } }
    const fe = { name: 'write', callId: 'g12-1', arguments: { file_path: 'pkgs/zh/agent.cordis.yml' }, agent: foreignAgent }
    const fpre = await gl['tools/pre-execute'][0](fe, () => ({ kind: 'allow' }))
    const fpost = await gl['tools/post-execute'][0](fe, { kind: 'success' }, () => ({ kind: 'accept' }))
    const fclean = fpre && fpre.kind !== 'deny' && !(fpost && fpost.additionalContexts)
    await check('S12 外仓 preset 写（guards v13 自感知）→ allow 且无控制平面 remind', fclean === true)
    const ie = { name: 'write', callId: 'g12-2', arguments: { file_path: '/root/.dsh/.agent-presets/kixparadigm/agent.cordis.yml' }, agent: foreignAgent }
    const ipre = await gl['tools/pre-execute'][0](ie, () => ({ kind: 'allow' }))
    const ipost = await gl['tools/post-execute'][0](ie, { kind: 'success' }, () => ({ kind: 'accept' }))
    const iwarn = ipre && ipre.kind !== 'deny' && !!(ipost && ipost.additionalContexts)
    await check('S12b 安装副本写（guards）→ 仍注入控制平面 remind', iwarn === true)
  }
  if (fs.existsSync('/root/kix-p5-e2e/scripts/check-dsh-consistency.cjs')) {
    const r7 = await run('kixreg', '/root/kix-p5-e2e', ['dsh/preset/plugins/regress.js', 'README.md'])
    await check('S6 kix 仓回归 → remind en 缺失份', r7[0] !== null && r7[0].includes('en/preset/plugins/regress.js missing'))
    await check('S6b kix 仓一致 README 写入 → 不误报（无假阳性）', r7[1] === null)
    const readme = '/root/kix-p5-e2e/README.md'
    const orig = fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8') : null
    fs.writeFileSync(readme, '# drifted readme without phrase\n', 'utf8')
    const r7c = await run('kixdrift', '/root/kix-p5-e2e', ['README.md'])
    if (orig !== null) fs.writeFileSync(readme, orig, 'utf8')
    await check('S6c kix 仓 README 漂移（契约自声明）→ 提醒', r7c[0] !== null && r7c[0].includes('README'))
  } else {
    console.log('SKIP  S6 kix 仓回归（/root/kix-p5-e2e 缺契约入口）')
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail > 0 ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
EOF

echo '== 4) report =='
{
  echo '# kix-consistency 泛化 WSL2 实测（PR #12）'
  echo
  echo "- date(UTC): $(date -u +%FT%TZ)"
  echo '- 安装副本: /root/.dsh/.agent-presets/kixparadigm（工作树 rsync 同步）'
  echo '- 方法: 直接加载安装副本插件，mock DSH pre/post-execute，对 /root 下外仓夹具真写时判定'
  echo
  echo '## 场景'
  echo '- S1 外仓双根漂移（kix-foreign-multi, pkgs/zh+pkgs/en 自感知）→ 注入 remind'
  echo '- S2 外仓 persona / skills 写入（无契约）→ parity hint（由你判断）+ remindOnce 静默'
  echo '- S3 VS Code 导入源根 plugins/ 写入 → 零开销（边界 = DSH preset 根）'
  echo '- S4 单 preset 根 → 零开销；S5 普通仓库 → 零开销'
  echo '- S7 单标记目录（仅 agent.cordis.yml）→ 不算 preset 根'
  echo '- S8/S9/S10/S11 shell 通道（pwsh 漂移/hint、无关零开销、bash 覆盖）'
  echo '- S12/S12b kix-guards v13 外仓源豁免自感知 + 安装副本仍提醒'
  echo '- S6 kix 仓回归（kix-p5-e2e, 契约自声明）→ remind + README 契约层'
  echo
  echo '```'
  cat /tmp/kix-verification/12-driver-output.txt
  echo '```'
} > "$REPORT"
echo "report: $REPORT"
cat "$REPORT"
