# kixparadigm-en

> **English edition of the kix paradigm for DeepSeek Harness** — AI self-orchestrated minimal paradigm (resident cognition layer) + kixpower multi-agent orchestration, in one npm command.

```
npm i -g kixparadigm-en
```

Installs automatically (v1.3.4+; v1.3.0 tarball shipped classic sources but the installer copied only a single variant):

1. **Preset** → `~/.dsh/.agent-presets/kixparadigm-classic-en/` — English classic resident cognition layer (Three-Channel Cross-Validation, Phase Duality, Rules Are Liabilities, Triple Requirement Check, Pre-Code Decision Chain, AI Blind-Spot Map, Process Routing Signals, CEO Team Orchestration) + full coding-agent toolset + mechanical guards (`kix-guards`) + discipline gates (`kix-discipline`: requirement-contract gate + verification gate, 2026-08-16 pluginization P0) + orchestration handoff gates (`kix-orchestration`) + minimal/progressive-disclosure tool surface (`kix-focus`: resident trimming + capability search/call) + native `/kixpower-*` commands (`kix-commands`) + vision bridge
2. **vision-bridge** → `~/.dsh/profiles/web/plugins/dsh-vision-bridge/` (junction + `cordis.patch.yml` entry)
3. **Settings checklist** → warns if `zai-vision` / `zai-coding-cn` providers are missing from `settings.yaml` (preferred candidates for `subagent_vision` / `subagent_cross`; since v5.9 kix-route auto-resolves from whatever is registered)

Then restart `dsh web` and pick the **kixparadigm-classic-en** mode in the new-session picker. The old install id `kixparadigm-en` is still recognized as an owner of the shared vision-bridge.

```
kixparadigm-en doctor        # self-check (tests included)
kixparadigm-en uninstall     # remove the EN preset (shared vision-bridge kept while the CN preset remains)
```

**Translation status**: the resident cognition layer is fully English; deep-mechanism docs (skills / prompts / memories / team roles) are still the Chinese originals while translation progresses — see `preset-classic-en/TRANSLATION-STATUS.md` and the canonical terminology table `preset-classic-en/instructions/glossary.md`.

Source: https://github.com/olicesx/kixparadigm · MIT License
