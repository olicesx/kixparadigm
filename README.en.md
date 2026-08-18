# kixparadigm

> **Minimal self-orchestration paradigm (resident cognition) × multi-agent orchestration × coding agent presets** — the full kix stack in one repo: one-command import into DeepSeek Harness, scripted import into VS Code Copilot.

[![CI](https://github.com/olicesx/kixparadigm/actions/workflows/ci.yml/badge.svg)](https://github.com/olicesx/kixparadigm/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/kixparadigm-en)](https://www.npmjs.com/package/kixparadigm-en)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> **🌍 English:** this file · **中文:** [README.md](README.md)
>
> This document practices the repo's own paradigm: **resident minimum, progressive disclosure, no dual-sourced volatile numbers** — version history lives in [CHANGELOG.md](CHANGELOG.md), mechanism mapping in [dsh/preset/DSH-ADAPTATION.md](dsh/preset/DSH-ADAPTATION.md); details are not duplicated here.

## Why

The kix paradigm began as a VS Code Copilot customization pack. Studying DeepSeek Harness (DSH) revealed a **natural mechanism fit**: resident cognition = preset persona, guard hooks = `tools/pre-execute` plugins, team agents = subagent dispatch, slash commands = native DSH commands, vision top-up = vision-bridge. Full mapping: [DSH-ADAPTATION.md](dsh/preset/DSH-ADAPTATION.md) and [DSH-FUSION-MATRIX.md](dsh/preset/DSH-FUSION-MATRIX.md).

The fit turns the paradigm from "one person's local Copilot customization" into "a reproducible public asset installable in one command" — that is why this repo is open source.

## Quick start (DSH, recommended)

```bash
npm i -g kixparadigm     # preset + vision-bridge auto-install; restart dsh web and pick kixparadigm in the mode list
npx kixparadigm install  # no global install
npm i -g kixparadigm-en  # English edition (separate package; translation status: en/preset/TRANSLATION-STATUS.md)
```

Custom DSH dir (`DSH_HOME`), `--preset-only`, ops commands (`doctor` / `uninstall` / `copilot`): see [dsh/README-DSH.md](dsh/README-DSH.md).

## Quick start (VS Code Copilot)

```bash
# Windows
.\install.ps1
# macOS / Linux
chmod +x install.sh && ./install.sh
```

See [INSTALL.md](INSTALL.md). Start with `/kixpower-new`.

## What this is: two layers + plugin floor

| Layer | Component | One-liner |
|-------|-----------|-----------|
| **Cognition** (how to think) | kixparadigm persona | Three-channel cross-validation, phase duality, rules-are-debt, requirement triple-check (no user-pleasing), pre-code decision chain |
| **Execution** (how to execute) | kixpower | Orchestration model: lead model freely picks members (dev/qa/reviewer) + Sprint flow, DAG topology, 4-layer loop, four invariant floors |
| Mechanical guards | `kix-guards` · `kix-consistency` | Commit budget, feature branch, force push, dangerous SQL, control-plane protection (hard deny only for irreversible damage); preset consistency write-time guard (prevents zh/en drift) |
| Handoff discipline | `kix-orchestration` · `kix-discipline` | Subagent handoff evidence-chain checks; spec contract gate + verification gate |
| Focus | `kix-focus` | Tool surface 85→18 resident cut + on-demand catalog & proxied execution — progressive disclosure at runtime |
| Cost & routing | `kix-cost` · `kix-route` | Subagent thinking-effort normalization; sentinel model names → runtime-available routes |
| Top-up | `kix-commands` · `dsh-vision-bridge` · `kix-stalled` (opt-in) | `/kixpower-*` native commands; vision for blind lead models; stalled-Sprint detection |

Preset in full: persona + 18 skills + 6 roles + 5 commands + 4 memories. Per-plugin mechanics and evolution: [DSH-ADAPTATION.md](dsh/preset/DSH-ADAPTATION.md), [CHANGELOG.md](CHANGELOG.md).

## Repo layout

```
kixparadigm/
├── dsh/preset/        ← DSH preset source of truth: persona/skills/roles/plugin sources+tests/adaptation docs
├── en/                ← English edition (separate npm package kixparadigm-en, released in sync with CN)
├── skills/ agents/ prompts/ memories/ instructions/   ← VS Code Copilot distribution (7-skill subset)
├── bin/ scripts/      ← CLI and install/verify/consistency-guard scripts
└── install.ps1 / install.sh / INSTALL.md / CHANGELOG.md
```

> **Source-of-truth convention**: `dsh/preset/` is the source of truth; `~/.dsh/.agent-presets/kixparadigm/` is only an installed copy (maintain = edit preset, then run `scripts/sync-dsh-preset.ps1 -Force`); root `skills/` etc. are the Copilot distribution, deliberately different from the DSH edition — do not overwrite either way.

## Development & verification

```bash
npm test                                    # consistency guard + full plugin regression (counts self-reported by test output, not maintained in this doc)
node scripts/check-dsh-consistency.cjs      # persona budget/doc counts/bilingual consistency guard
kixparadigm doctor                          # install self-check
```

## License

[MIT](LICENSE) © 2026 kixparadigm contributors
