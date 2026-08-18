# Kix Bundle — 安装指南

## 前置条件

| 依赖 | 说明 |
|------|------|
| **VS Code + Copilot Chat** | 技能 / agent / 指令 / prompt / memory 的载体 |
| **git** | kixpower 的 blast-radius-check / fidelity-check hook 需要 |
| **PowerShell 7+**（Windows） | 运行 hook 脚本（`pwsh`） |
| **bash**（macOS/Linux） | 系统自带 |

---

## Windows

```powershell
cd C:\Users\<你>\Desktop\kix-bundle
.\install.ps1
```

确认安装计划后输入 `y`。

**自定义 copilot 主目录**：
```powershell
.\install.ps1 -Target D:\copilot
```

**预览（不写入）**：
```powershell
.\install.ps1 -DryRun
```

> 若提示 `无法加载脚本，因为在此系统上禁止运行脚本`，用绕过策略执行：
> `powershell -ExecutionPolicy Bypass -File .\install.ps1`

---

## macOS / Linux

```bash
cd ~/path/to/kix-bundle
chmod +x install.sh
./install.sh
```

**自定义 copilot 主目录**：
```bash
./install.sh /opt/copilot
```

---

## 安装目标路径

脚本会检测并写入以下位置：

| 资产 | Windows 路径 | macOS / Linux 路径 |
|------|-------------|--------------------|
| skills | `%USERPROFILE%\.copilot\skills\` | `~/.copilot/skills/` |
| agents | `%USERPROFILE%\.copilot\agents\` | `~/.copilot/agents/` |
| instructions | `%USERPROFILE%\.copilot\instructions\` | `~/.copilot/instructions/` |
| prompts | `%APPDATA%\Code\User\prompts\` | `~/.config/Code/User/prompts/`（macOS: `~/Library/Application Support/...`） |
| memories | `%APPDATA%\Code\User\globalStorage\github.copilot-chat\memory-tool\memories\` | 同结构，换 base |

Skills 按 `skills/*/SKILL.md` 自动发现并全部安装。Memories 是精选集合；DSH capability map 与 legacy notes 只作为仓库参考资料，不导入 user memory。

> **环境变量覆盖**：`COPILOT_HOME`、`VSCODE_PROMPTS_DIR`、`VSCODE_MEMORY_DIR` 可分别覆盖三个目标路径。

---

## 验证安装

1. **重载 VS Code**：命令面板（`Ctrl/Cmd+Shift+P`）→ `Developer: Reload Window`
2. **检查 skills**：打开 Copilot Chat，输入 `/`，应看到 `/kixpower-new` 等命令
3. **检查 agent**：在 agent 选择器（`@`）应看到 kixpower-* 系列
4. **检查范式**：新会话中 kixparadigm 核心指令自动生效；说 `/kixparadigm` 进入主入口
5. **检查记忆**：新会话左侧上下文应显示 user memory 已加载

---

## 跳过记忆导入

记忆会覆盖目标机器同名 user memory 文件。如不想导入：
```powershell
.\install.ps1 -SkipMemories      # Windows
./install.sh --skip-memories     # macOS/Linux
```

---

## 幂等性

重复运行安装脚本会**覆盖**已有文件，安全可重复。

---

## 卸载

```powershell
.\install.ps1 -Uninstall         # Windows
./install.sh --uninstall         # macOS/Linux
```

移除本 bundle 安装的全部资产。`-SkipMemories` / `--skip-memories` 可在卸载时跳过记忆删除。

---

## 故障排查

| 现象 | 原因 / 处理 |
|------|------------|
| `/kixpower-*` 命令不出现 | 未重载 VS Code；或 prompts 目录路径不对（检查 `%APPDATA%\Code\User\prompts`） |
| agent 在选择器重复显示 | 目标机器可能有同名的市场插件 agent，删除插件 agents 目录或本机重复文件 |
| hook 未触发 | agent.md 占位符未替换成功，检查 `{{COPILOT_HOME}}` 是否已变成实际路径 |
| 记忆未加载 | memory 目录路径随 VS Code 版本可能变化，确认 `globalStorage/github.copilot-chat/memory-tool/memories/` 存在 |
| `git not found` 警告 | 仅影响 kixpower 部分安全 hook，其余功能不受影响 |
