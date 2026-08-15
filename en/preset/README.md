# kixparadigm-en — English Agent Preset (kix paradigm import)

> English edition of the kixparadigm preset for DeepSeek Harness. The **resident cognition layer** (persona in `agent.cordis.yml`, core instructions, glossary, main-entry agent) is fully in English; deep-mechanism docs (skills / prompts / memories / team roles) are still the Chinese originals while translation progresses — see `TRANSLATION-STATUS.md`.

## Layout

```
preset/
├── agent.cordis.yml            ← composition: EN resident cognition layer + full toolset + guards + commands
├── preset.yml                  ← mode-picker metadata (name: kixparadigm-en)
├── DSH-ADAPTATION.md           ← authoritative mechanism mapping (EN, condensed)
├── instructions/
│   ├── kixparadigm-core.instructions.md   ← resident cognition layer (EN)
│   └── glossary.md             ← canonical terminology table (EN)
├── agents/                     ← 6 role definitions (entry EN; team roles CN, pending)
├── skills/                     ← 17 skills (CN originals, pending translation)
├── prompts/                    ← 5 /kixpower-* flows (CN, pending)
├── memories/                   ← 6 methodology memories (CN, pending)
└── plugins/                    ← kix-guards.js + kix-commands.js + tests (language-neutral)
```

## Install

```bash
npm i -g kixparadigm-en        # preset → ~/.dsh/.agent-presets/kixparadigm-en + vision-bridge
# restart dsh web, pick the kixparadigm-en mode in the new-session picker
```

After install: `kixparadigm-en doctor` self-checks, `kixparadigm-en uninstall` removes everything.

## Verify

```bash
node plugins/kix-guards.test.js      # 142 assertions
node plugins/kix-commands.test.js    # 6 assertion groups
node plugins/kix-cost.test.js        # 24 assertions
```
