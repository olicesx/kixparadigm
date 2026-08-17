#!/usr/bin/env bash
set -euo pipefail
export HOME=/root
mkdir -p /tmp/kix-verification
cat > /tmp/kix-verification/11-p5-mechanization.md <<'EOF'
# 测⑪ P5 机制化 WSL2 E2E（2026-08-17，PR #10 合并前）

环境：WSL2 Ubuntu root，dsh web @33236（setsid 从 /root 启动），kixparadigm preset
夹具：/root/kix-p5-e2e（源仓库指纹三件套 + 最小插件对）
方法：GUI 新会话逐步 write → 观察 additionalContexts 注入 → 刷新复验 session restore

## 部署
- 同步 `dsh/preset` → `~/.dsh/.agent-presets/kixparadigm`（含 kix-consistency + consistency-lib + v11 orchestration）
- 安装副本单测：kix-consistency 52/52（首轮）→ 54/54（cwd 修复后）；kix-orchestration 96/96
- 挂载确认：agent.cordis.yml:624 `- id: kix-consistency`

## 会话 1（修复前）
提示：写新 zh 插件 / 缺预算 plan.md / scratch.txt / 再写同插件
- PLAN-REMIND: yes — 「plan.md 缺少 commit 预算来源…」「plan.md 缺少任务清单」
- CONS-REMIND: no — 指纹条件成立仍未注入
- SCRATCH-CLEAN: yes
- 根因：kix-consistency 用 sandboxPolicy.workspaceRoot（= process.cwd()=/root）做指纹，isRepoRoot('/root') 失败，整插件静默放行。plan 门禁只看 file_path，不受影响。

## 会话 2（cwd 修复后，错误用例）
覆盖已同步的 kix-fixture.js 制造 drift：写前读盘时双侧仍一致 → 按设计不提醒（pre-write 读盘语义，审查已判定不修）

## 会话 3（cwd 修复后，正确用例）session-dcad7bca
覆盖已存在的 zh-only `dsh/preset/plugins/kix-e2e-new.js`
- CONS-REMIND: yes — 「kix-consistency: en/preset/plugins/kix-e2e-new.js missing」
- 会话日志 user/message 带非空 id
- 刷新页面：会话完整恢复，注入卡片仍在（无 lacks an identified message）

## 结论
✅ P5a 写时一致性守护：会话 cwd 解析修复后在真实 dsh web 触发
✅ P5b plan 契约门禁：首轮即触发
✅ session restore：带 id 的 consistency 提醒刷新后可恢复
❌ 修复前整插件在非启动目录工作区静默失效（已修并复验）
EOF
echo WROTE /tmp/kix-verification/11-p5-mechanization.md
cat /tmp/kix-verification/11-p5-mechanization.md
