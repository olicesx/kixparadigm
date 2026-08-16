# kixparadigm-en — English Agent Preset (kix paradigm import)

> English edition of the kixparadigm preset for DeepSeek Harness. The **resident cognition layer** (persona in `agent.cordis.yml`, core instructions, glossary, main-entry agent) is fully in English; deep-mechanism docs (skills / prompts / memories / team roles) are still the Chinese originals while translation progresses — see `TRANSLATION-STATUS.md`.

## Layout

```
preset/
├── agent.cordis.yml            ← composition: EN resident cognition layer + full toolset + 7 plugins
├── preset.yml                  ← mode-picker metadata (name: kixparadigm-en)
├── DSH-ADAPTATION.md           ← authoritative mechanism mapping (EN, condensed)
├── PLUGINIZATION-ROADMAP.md    ← pluginization roadmap (EN condensed; CN full edition in CN preset)
├── instructions/
│   ├── kixparadigm-core.instructions.md   ← resident cognition layer (EN)
│   └── glossary.md             ← canonical terminology table (EN)
├── agents/                     ← 6 role definitions (entry EN; team roles CN, pending)
├── skills/                     ← 17 skills (CN originals, pending translation)
├── prompts/                    ← 5 /kixpower-* flows (CN, pending)
├── memories/                   ← 4 methodology memories (CN, pending)
└── plugins/                    ← kix-guards + kix-discipline + kix-orchestration + kix-focus + kix-cost + kix-route + kix-commands + kix-stalled (opt-in) + tests (language-neutral)
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
node plugins/kix-guards.test.js        # 210 assertions (v9 soft constraints)
node plugins/kix-commands.test.js      # 6 assertion groups
node plugins/kix-cost.test.js          # 28 assertions
node plugins/kix-route.test.js         # 68 assertions (v8)
node plugins/kix-discipline.test.js    # 68 assertions
node plugins/kix-orchestration.test.js # 69 assertions (v8)
node plugins/kix-focus.test.js         # 73 assertions
```
