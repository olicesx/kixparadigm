# kixparadigm-en — English Agent Preset (kix paradigm import)

> English edition of the kixparadigm preset for DeepSeek Harness. The **resident cognition layer** (persona in `agent.cordis.yml`, core instructions, glossary, main-entry agent) is fully in English; deep-mechanism docs (skills / prompts / memories / team roles) are still the Chinese originals while translation progresses — see `TRANSLATION-STATUS.md`.

## Layout

```
preset/
├── agent.cordis.yml            ← composition: EN resident cognition layer + full toolset + enabled plugins
├── preset.yml                  ← mode-picker metadata (name: kixparadigm-en)
├── DSH-ADAPTATION.md           ← authoritative mechanism mapping (EN, condensed)
├── PLUGINIZATION-ROADMAP.md    ← pluginization roadmap (EN condensed; CN full edition in CN preset)
├── instructions/
│   ├── kixparadigm-core.instructions.md   ← resident cognition layer (EN)
│   └── glossary.md             ← canonical terminology table (EN)
├── agents/                     ← role definitions (entry EN; team roles CN, pending)
├── skills/                     ← skills (CN originals pending translation; `pwsh-reliable` ships English-native)
├── prompts/                    ← /kixpower-* flows (CN, pending)
├── memories/                   ← methodology memories (CN, pending)
└── plugins/                    ← kix-guards + kix-discipline + kix-orchestration + kix-focus + kix-browser (17-action native browser automation, on-demand activation) + kix-cost + kix-route + kix-commands + kix-stalled (opt-in) + tests (language-neutral)
```

## Install

```bash
npm i -g kixparadigm-en        # preset → ~/.dsh/.agent-presets/kixparadigm-en + vision-bridge
# restart dsh web, pick the kixparadigm-en mode in the new-session picker
```

After install: `kixparadigm-en doctor` self-checks. `kixparadigm-en uninstall` removes the EN preset; the shared vision-bridge is kept when the CN preset is still installed (v1.2.11).

## Verify

```bash
node scripts/check-consistency.cjs    # persona budget / doc-link / syntax guard (v1.2.11)
(cd preset/plugins && node --test) # all plugin tests (Node 20+ auto-discovery;
                                  #   single files still run via `node preset/plugins/<name>.test.js`)
```
