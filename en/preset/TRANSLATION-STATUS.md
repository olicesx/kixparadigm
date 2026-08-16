# Translation Status — kixparadigm-en

This edition is delivered in **phased translation**. The resident cognition layer (what the agent carries into every thought, every session) is fully in English; deep-mechanism documentation is still the Chinese original while translation progresses.

## ✅ Translated (resident core)

| File | Status |
|---|---|
| `preset.yml` (mode picker name/description) | English |
| `agent.cordis.yml` — persona (resident cognition layer) | English (terminology per `instructions/glossary.md`) |
| `instructions/kixparadigm-core.instructions.md` | English |
| `instructions/glossary.md` | English (canonical term table) |
| `agents/kixparadigm.agent.md` (main entry role) | English |
| `DSH-ADAPTATION.md` | English (condensed authoritative mapping) |
| `PLUGINIZATION-ROADMAP.md` | English (condensed edition; CN full edition in CN preset) |
| `README.md`, `TRANSLATION-STATUS.md` | English |
| `plugins/` (kix-guards.js, kix-cost.js, kix-commands.js, kix-route.js, kix-discipline.js, kix-orchestration.js, kix-focus.js + tests) | Code — language-neutral |

## ⏳ Pending (Chinese originals, still fully functional)

| Area | Files | Impact |
|---|---|---|
| `skills/kixparadigm/SKILL.md` (+ AUDIT.md) | 2 | Mechanism details; resident layer already carries the core gates |
| `skills/kixpower/*` (SKILL / USAGE_MANUAL / TEAM_CONVENTIONS / README / hooks / scripts / templates / tests) | ~20 | Team orchestration manual; the persona's orchestration rules are already English |
| `skills/` ecosystem (handoff, write-a-skill, tdd, teach, grill-me, …) | 12 | On-demand skill docs |
| `prompts/kixpower-*.prompt.md` | 5 | Slash-command flows (`/kixpower-*`) — commands work, injected flow text is Chinese |
| `memories/*.md` | 4 | Methodology memories; read on demand |
| `agents/kixpower-{producer,dev,qa,orchestrator,reviewer}.agent.md` | 5 | Team-role prompt templates for subagent dispatch |

## Contributing

Translation follows the canonical glossary (`instructions/glossary.md`) so coined terms stay consistent. PRs welcome — see the repository root README. Tracked in the repo as a rolling effort; the goal is full English coverage of `skills/`, `prompts/`, `memories/`, and `agents/`.
