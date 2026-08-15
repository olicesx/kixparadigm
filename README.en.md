# kixparadigm

> **AI self-orchestrated minimal paradigm (resident cognition layer) × multi-agent orchestration × coding-agent preset** — the whole kix family in one repository: one-command `npm` import into DeepSeek Harness, script import into VS Code Copilot.

[![License](https://img.shields.io/badge/license-MIT-green)]()
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)]()

> **中文版:** [README.md](README.md) · **English:** this file

---

## 🧭 Why this repository exists: the kix × DSH fit

kix started as a **VS Code Copilot customization bundle**: resident cognition instructions, 17 skills, 6 team agents, 5 slash commands, mechanical-guard hooks, methodology memories — an AI self-orchestration system refined inside the Copilot ecosystem.

When we studied **DeepSeek Harness (DSH)**, we found the two are a **natural fit** — not a port, but "mechanism matching mechanism":

| kix mechanism | DSH native carrier | Verdict |
|---|---|---|
| Resident cognition instructions (how to think) | preset persona (active every session) | ✅ direct equivalent |
| PreToolUse mechanical-guard hooks (blast-radius / source protection / dangerous git) | **`kix-guards` plugin** (`tools/pre-execute` listener) + host sandbox/approval stack | ✅ a stronger guard host |
| `/kixpower-*` slash commands | **`kix-commands` plugin** (DSH native commands, zero-token trigger) | ✅ commands as entry points |
| Team agents (Producer/Dev/QA/Reviewer) | DSH subagent dispatch (role prompt templates) | ✅ orchestration lands directly |
| Skill system | DSH skills (customSkillDirs inside the preset) | ✅ mounted as-is |
| memory-tool methodology memories | DSH memories/ (read on demand per persona) | ✅ mounted as-is |
| Cross-vendor model validation (a kix core belief) | DSH llm-pi-ai providers + `subagent_vision` vision subagent | ✅ native support |
| Vision compensation for non-vision main models | **`dsh-vision-bridge` plugin** (GLM-4.6V auto-describe) | ✅ seamless in the UI |

The research conclusions live in [`dsh/preset/DSH-ADAPTATION.md`](dsh/preset/DSH-ADAPTATION.md) (the authoritative mechanism mapping). The practical payoff: **kix went from "one person's local Copilot customization" to "a public asset reproducible with one command"** — that is why this repository is open source: any DSH environment can get the complete kix cognition layer + execution layer + guards + vision compensation in one step.

---

## 🚀 Quick start (DSH, recommended)

### Option 1: npm one-command import (`npm i -g` completes the whole install)

```bash
npm i -g kixparadigm
```

The install does everything automatically:

1. **Preset** → `~/.dsh/.agent-presets/kixparadigm/` (full preset: persona cognition layer + 17 skills + 6 roles + 5 commands + guard/command plugins + 6 memories)
2. **vision-bridge** → `~/.dsh/profiles/web/plugins/dsh-vision-bridge/` (junction created automatically, `cordis.patch.yml` entry registered)
3. **Checklist**: warns when `settings.yaml` lacks the `zai-vision` / `zai-coding-cn` providers (fill them in per `DSH-ADAPTATION.md`)

Then **restart dsh web** (Ctrl+C → `dsh web`) and pick **kixparadigm** in the new-session mode list.

> Custom DSH directory: `DSH_HOME=/path/to/dsh npm i -g kixparadigm` (default `~/.dsh`)
> Skip vision-bridge: `kixparadigm install --preset-only`

### Option 2: npx (no global install)

```bash
npx kixparadigm install
```

### 🌍 English edition

The resident cognition layer (persona / core instructions / glossary / main-entry agent) is fully translated — see the canonical terminology table in [`en/preset/instructions/glossary.md`](en/preset/instructions/glossary.md):

```bash
npm i -g kixparadigm-en     # installs the kixparadigm-en preset (mode picker: kixparadigm-en)
kixparadigm-en doctor       # self-check
```

Deep-mechanism docs (skills / prompts / memories / team roles) are still the Chinese originals while translation progresses — status tracked in [`en/preset/TRANSLATION-STATUS.md`](en/preset/TRANSLATION-STATUS.md). Source of the EN edition: the `en/` directory (npm package root) + `en/preset/` (EN preset source of truth).

### Operations

```bash
kixparadigm doctor        # self-check: preset / links / mount entries / plugin unit regressions
kixparadigm uninstall     # remove everything installed
kixparadigm copilot       # (optional) also import the VS Code Copilot side
```

---

## 🚀 Quick start (VS Code Copilot)

```bash
# Windows
.\install.ps1
# macOS / Linux
chmod +x install.sh && ./install.sh
```

Details in [INSTALL.md](INSTALL.md). After installing, reload the window and type `/kixpower-new` / `/kixpower-import` / `/kixpower-continue` / `/kixpower-review` after `/`.

---

## 📦 What this is: two layers

kix is layered in two, and this repository ships both layers plus the ecosystem dependencies in one go:

| Layer | Component | Role |
|---|---|---|
| **Cognition layer (how to think)** | `kixparadigm` | Resident cognition paradigm: Three-Channel Cross-Validation, Phase Duality, Rules Are Liabilities, Triple Requirement Check (no sycophancy), Pre-Code Decision Chain, AI Blind-Spot Map. Active in every session |
| **Execution layer (how to execute)** | `kixpower` | Multi-agent orchestration: Producer plans → Dev implements → QA verifies; sprints, DAG topology, 4-level loop, verifiable gates |
| **Ecosystem skills** | `handoff` / `write-a-skill` / `improve-codebase-architecture` and 17 more | Session handoff, skill authoring, architecture improvement, TDD/teaching/diagnosis methodology |
| **Mechanical guards** | `kix-guards` plugin | Commit budget, feature branch, force push, dangerous SQL, control-plane file protection, human confirmation points (128 assertions) |
| **Native commands** | `kix-commands` plugin | `/kixpower-*` five commands registered as DSH native commands (zero-token trigger, inject flows from `prompts/`) |
| **Vision compensation** | `dsh-vision-bridge` plugin | When the main model has no vision, pasted/dropped images are auto-converted to text descriptions before submit (GLM-4.6V, server HTTP + client dock) |

**In one sentence**: kixparadigm gives the AI the freedom of "how to think" plus blind-spot compensation; kixpower gives "how to execute" structured team orchestration; the guard and vision plugins make DSH a complete host for kix.

---

## 📂 Repository layout

```
kixparadigm/
├── package.json                     ← npm packaging (postinstall auto-install, bin provides the CLI)
├── bin/kixparadigm.js               ← CLI: install / uninstall / doctor / copilot
├── scripts/
│   ├── install-lib.js               ← cross-platform installer (preset + vision-bridge mount)
│   ├── sync-dsh-preset.ps1          ← dev workflow: mirror dsh/preset → ~/.dsh (one-way)
│   ├── ensure-vision-bridge.ps1     ← vision-bridge self-check/self-heal
│   └── verify-*.js / .cjs           ← guard and load-chain verification
│
├── dsh/                             ← DSH side (single source of truth)
│   ├── preset/                      ← the mirror of ~/.dsh/.agent-presets/kixparadigm/
│   │   ├── agent.cordis.yml         ← composition (resident cognition persona + all capability rows)
│   │   ├── preset.yml               ← roster display metadata
│   │   ├── DSH-ADAPTATION.md        ← authoritative mechanism mapping (tools/guards/orchestration/vision)
│   │   ├── skills/  agents/  prompts/  instructions/  memories/
│   │   └── plugins/                 ← kix-guards.js + kix-commands.js + tests
│   ├── vision-bridge/               ← dsh-vision-bridge plugin source (client + server + package.json)
│   └── README-DSH.md                ← DSH deployment notes
│
├── en/                              ← English edition (npm package root)
│   ├── package.json                 ← name: kixparadigm-en
│   ├── preset/                      ← EN preset source of truth (EN persona/instructions/glossary; CN skills/prompts/memories pending)
│   ├── bridge/  bin/  scripts/      ← vision-bridge copy, CLI, parameterized installer
│   └── README.md                    ← EN package readme
│
├── skills/  agents/  prompts/  memories/  instructions/   ← VS Code Copilot distribution (kept as-is)
├── plugins/                         ← Copilot-side kix-guards original
├── install.ps1 / install.sh / INSTALL.md   ← Copilot install scripts
├── vision-bench/                    ← vision load-chain benchmark assets (A/B timing)
└── README.md  README.en.md  LICENSE  .gitignore
```

> **Single-source-of-truth convention**: `dsh/preset/` is the source of truth for the DSH preset; `~/.dsh/.agent-presets/kixparadigm/` is only the installed copy. Maintain the preset by editing `dsh/preset/` then running `scripts/sync-dsh-preset.ps1 -Force` (EN edition: `-PresetId kixparadigm-en -SourceDir en\preset`). The root `skills/` etc. are the Copilot distribution and deliberately differ from the DSH copies — don't overwrite one with the other.

---

## 🧪 Development & verification

```bash
npm test                                  # guards 128 assertions + commands 6 assertions
node scripts/verify-guards.js             # compare installed preset vs bundle guards
node scripts/verify-vision-bridge-resolution.cjs  # vision-bridge load-chain full path
pwsh -File .\scripts\sync-dsh-preset.ps1 -DryRun   # preview preset diffs
kixparadigm doctor                        # install state self-check
```

Preset mount validation (roster `standingKeyFor`) runs inside a DSH session using the cordis toolset.

## 📢 Publishing

```bash
npm login                      # first time
npm test && npm pack --dry-run # pre-publish self-check
npm publish                    # publish (CN edition)
npm publish ./en               # publish EN edition (kixparadigm-en)
```

## 📄 License

[MIT](LICENSE) © 2026 kixparadigm contributors
