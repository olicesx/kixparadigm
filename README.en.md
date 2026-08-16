# kixparadigm

> **AI self-orchestrated minimal paradigm (resident cognition layer) × multi-agent orchestration × coding-agent preset** — the whole kix family in one repository: one-command `npm` import into DeepSeek Harness, script import into VS Code Copilot.

[![CI](https://github.com/olicesx/kixparadigm/actions/workflows/ci.yml/badge.svg)](https://github.com/olicesx/kixparadigm/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/kixparadigm)](https://www.npmjs.com/package/kixparadigm)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)]()

> **中文版:** [README.md](README.md) · **English:** this file

---

## 🧭 Why this repository exists: the kix × DSH fit

kix started as a **VS Code Copilot customization bundle**: resident cognition instructions, 17 skills, 6 team agents, 5 slash commands, mechanical-guard hooks, methodology memories — an AI self-orchestration system refined inside the Copilot ecosystem (in this repo: the DSH preset carries all 17 skills; the Copilot distribution ships 7 of them).

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

1. **Preset** → `~/.dsh/.agent-presets/kixparadigm/` (full preset: persona cognition layer + 17 skills + 6 roles + 5 commands + guard/command plugins + 4 memories)
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
| **Execution layer (how to execute)** | `kixpower` | **Arranger model (v1.2.9)**: the main model freely picks members + flow — dev/qa/reviewer activatable member tiers (names as contract handles) + kixpower sprint flow (heavy path), DAG topology, 4-level loop, verifiable gates; four floor invariants (observation independence / coordination in main thread / perspectives from prompts / gates unchanged) |
| **Ecosystem skills** | `handoff` / `write-a-skill` / `improve-codebase-architecture` and 17 more | Session handoff, skill authoring, architecture improvement, TDD/teaching/diagnosis methodology |
| **Mechanical guards** | `kix-guards` plugin | Commit budget, feature branch, force push, dangerous SQL, control-plane file protection (**219 assertions**; v9 demotes publish/comment/ordinary-push confirmation gates to soft constraints — no repeated questions; hard deny remains only for irreversible destruction: force push / main protection / destructive SQL / control-plane writes / remote deletion; **v10.1 (2026-08-17) fixes the commit-on-main full-chain dead code**: `commit` added to `DANGEROUS_GIT` — previously a plain `git commit` never entered the git-write gate, so the branch/budget check never ran and direct commits to main silently passed (proven by deployment E2E)) |
| **Discipline mechanism** | `kix-discipline` plugin | Triple-check contract gate + verification gate: spec contract checked before implementation edits, end-of-turn no-test reminder, `kix_discipline_spec` contract tool (v1.2.9 optional `mode` field = arranger trace: member composition + one-line reason), `/kix-discipline` command (68 assertions, 2026-08-16 pluginization P0; v2 reject/handoff ask; mode placeholder round-trip + header-regex escaping fix 2026-08-17) |
| **Orchestration handoff gate** | `kix-orchestration` plugin | Pre-dispatch checks (sprint marker / plan+progress / blocker / QA completeness); v2 QA return-side consistency (subagent/end); v3 producer_closeout evidence chain; v4 sleep-waiting-for-subagent one-shot reminder (**v4.1 platform-agnostic**: dual command shapes always tested, no tool-name gating; WSL2-verified positive+negative); v8 negative-semantics QA completion guard; **v10.1 (2026-08-17) Tri-Block tolerance**: when the contract line is absent, `Sprint N` is parsed from the `[CONTEXT]` segment as a fallback (handoff-gate mechanical backstop for direct-dispatch paths; 77 assertions) |
| **Minimal + progressive disclosure** | `kix-focus` plugin | Three tiers: tools.restrict trims the per-turn tool surface from 85 (~108KB schema) to ~18 resident core; `kix_capability_search` on-demand catalog (v4 param-name metadata + long-tail fallback groups) + `kix_capability_call` proxied execution (full guard pipeline); v1.2.12 jobs made resident (mechanical background-task control surface, fixes the "no job controller serves this agent" run_in_background error) + tiers/goal **auto-activate on first use** (capability_call mounts on demand, no pre-activation needed; kix_tool_activate stays as explicit pre-activation; v1.2.9 enumeration-sync regression guard + **cross-platform symlink-install resolution fix**: candidate-root chain argv[1]→realpath→plugin file, WSL2 E2E two-round closed loop); PTC/Code Mode interop (**102 assertions**; **v1.2.13 handoff-gate mechanical backstop**: orchestration members qa/dev/reviewer dispatched via capability_call get `current_sprint: N` auto-injected from the workspace `docs/.kixpower-current-sprint` (`sprintInjected` returned), and the lite tier `ACTIVATABLE_TOOLS` snapshot is now platform-conditional (v1.2.12 dual-source miss, proven by deployment E2E)) |
| **Cost discipline** | `kix-cost` plugin | Subagent reasoning-effort normalization (thinker→max, other deepseek→high) + lite-tier preferred-route probing with automatic fallback (28 assertions, v5.8; multi-round fallback-route cache fix 2026-08-17) |
| **Routing layer** | `kix-route` plugin | Sentinel model names (`kix-route:cross/vision/thinker`) → runtime route resolution: cross-vendor inversion / vision model / deep-thinking tier; configurable preference tables (`modelPreference`/`crossProviderOrder` via plugin config, 2026-08-17) (68 assertions, v5.9.1) |
| **Native commands** | `kix-commands` plugin | `/kixpower-*` five commands registered as DSH native commands (zero-token trigger, inject flows from `prompts/`) |
| **Stalled detection** | `kix-stalled` plugin (optional) | `/kixst-check` command + `kix_stalled_check` tool: read-only detection of stalled sprints (candidate, commented-out mount = opt-in, enable via `scripts/install-kix-stalled.ps1`) |
| **Vision compensation** | `dsh-vision-bridge` plugin | When the main model has no vision, pasted/dropped images are auto-converted to text descriptions before submit (GLM-4.6V, server HTTP + client dock) |

**In one sentence**: kixparadigm gives the AI the freedom of "how to think" plus blind-spot compensation; kixpower gives "how to execute" structured team orchestration; the guard and vision plugins make DSH a complete host for kix.

> **v1.2.13 (2026-08-17) deployment re-verification fixes**: ① handoff-gate mechanical injection — `kix-focus` auto-carries `current_sprint: N` on orchestration-member (qa/dev/reviewer) capability_call dispatch (workspace-marker driven, `sprintInjected` returned) + `kix-orchestration` v10.1 Tri-Block `[CONTEXT]` `Sprint N` tolerant parsing (double insurance, covers direct-dispatch paths); ② lite tier usable on Linux — `ACTIVATABLE_TOOLS` snapshot toolFilter made platform-conditional (v1.2.12 only fixed the agent.cordis.yml row, so the capability_call auto-activation path still failed with unknown global tool "pwsh"; proven by deployment E2E); ③ kix-guards v10.1 commit-on-main full-chain fix (`commit` added to `DANGEROUS_GIT`). Unit suites: kix-focus **102** / kix-orchestration **77** / kix-guards **219** all green; WSL2 deployment E2E re-verification passed (lite / commit interception / persona rule + mechanical-injection evidence).
>
> **v1.2.12 (2026-08-17) iterate-verify-release**: ① subagent-lite toolFilter.allow made platform-conditional (win32→pwsh, others→bash) — the hardcoded pwsh broke Linux deployments with an unknown-global-tool error from tools.restrict(), leaving the lite tier unusable (proven by WSL2 E2E); ② kix-guards v10: repoRootFromText now extracts the `cd <repo> && git commit` (no -C) command position — when the session cwd ≠ repo root the commit check silently skipped; unit suite grew 142→213; ③ persona: sprint dispatch contract lines now carry `current_sprint: N` so the kix-orchestration handoff gate actually fires; ④ jobs made resident + tier/goal auto-activate-on-first-use synced (see PR #6).
>
> **v1.2.11 soft-gate rectification (DSH editions)**: publish/comment/merge/destructive actions are off by default; an explicit user instruction ("comment on the PR") is the decision, so the model executes directly and kix-guards no longer re-asks per operation. Questions are reserved for genuinely missing decision information.
>
> **v1.2.10 rectification (DSH editions)**: fixes the KIX self-audit "0% false-positive" counterexamples — QA completion detection now excludes negated statements; control-plane guard only blocks write intent (`grep/cat/ls ~/.dsh` pass); terminal SQL uses command-position + SQL-payload statement analysis; GitHub MCP prefix is configurable; cross-vendor routing skips unregistered preference candidates; uninstalling one bilingual package no longer removes the shared vision-bridge; `engines` aligned with `process.getBuiltinModule`; resident persona second debt pass down to ~1.8K tokens (CN, was ~3.1K); persona-budget / doc-count / bilingual-parity guard and CI added; vision-bridge got regression tests and a complete-code-fence cleanup fix.

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
│   ├── check-dsh-consistency.cjs    ← persona budget / doc-count / bilingual-parity guard
│   ├── install-kix-stalled.ps1      ← enable the optional kix-stalled plugin (opt-in)
│   ├── list-plugin-tools.cjs / quantify-focus.cjs / wsl-restart-dsh.sh ← tool inventory / focus quantification / WSL helpers
│   └── verify-*.js / .cjs           ← guard and load-chain verification
│
├── dsh/                             ← DSH side (single source of truth)
│   ├── preset/                      ← the mirror of ~/.dsh/.agent-presets/kixparadigm/
│   │   ├── agent.cordis.yml         ← composition (resident cognition persona + all capability rows)
│   │   ├── preset.yml               ← roster display metadata
│   │   ├── DSH-ADAPTATION.md        ← authoritative mechanism mapping (tools/guards/orchestration/vision)
│   │   ├── DSH-FUSION-MATRIX.md     ← mechanism fusion matrix
│   │   ├── PLUGINIZATION-ROADMAP.md ← pluginization roadmap (2026-08-16)
│   │   ├── skills/  agents/  prompts/  instructions/  memories/
│   │   └── plugins/                 ← kix-guards + kix-discipline + kix-orchestration + kix-focus + kix-cost + kix-route + kix-commands + kix-stalled (opt-in) + tests
│   ├── vision-bridge/               ← dsh-vision-bridge plugin source (client + server + package.json)
│   └── README-DSH.md                ← DSH deployment notes
│
├── en/                              ← English edition (npm package root)
│   ├── package.json                 ← name: kixparadigm-en
│   ├── preset/                      ← EN preset source of truth (EN persona/instructions/glossary; CN skills/prompts/memories pending)
│   ├── bridge/  bin/  scripts/      ← vision-bridge copy, CLI, parameterized installer
│   └── README.md                    ← EN package readme
│
├── .github/workflows/ci.yml         ← CI: ubuntu+windows × node 20/22 dual-package tests + pack dry-run
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
npm test                                  # consistency guard + full regression: installer 12 + vision-bridge 6 + guards 219 + discipline 68 + orchestration 77 + focus 102 + cost 28 + route 68 assertions (+ commands 6 groups)
node scripts/check-dsh-consistency.cjs       # persona budget / doc counts / bilingual plugin parity guard
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
