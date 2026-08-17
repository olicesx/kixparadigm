# kix Pluginization Roadmap — EN Edition

> Status: P0-P2 complete (2026-08-16). This is the **EN condensed edition** of the pluginization
> roadmap; the full CN edition with per-asset judgment matrices lives in the CN preset
> (`dsh/preset/PLUGINIZATION-ROADMAP.md`). Same decisions, same philosophy.

## Why

kix's core belief: **the model's reasoning is the primary engine; tools only fill known blind
spots; fewer constraints, better output; rules are liabilities.** The CN preset's implementation
was ~755KB of prompt engineering — discipline rules (requirement grill, verification gates,
delivery proof) existed as "model self-discipline" prose instead of enforced mechanisms.
Ecosystem plugins (dsh-doublecheck etc.) proved these can be **hooks + tools + durable state**.

## Judgment criteria (kix philosophy, not "mechanize everything")

| Criterion | Mechanize (plugin) | Keep prompt | Delete/archive |
|---|---|---|---|
| Rules are liabilities | Mechanical, enumerable, deterministic, high failure cost | Cognitive heuristics, directional, needs judgment | Duplicate, stale, Copilot-context residue |
| Compensate, don't restrict | Compensate **actions** (force reads, block dangerous ops) | Compensate **thinking** (perspectives, blind-spot hints) | Rules that restrict "how to think" |
| Phase duality | Verification-phase mechanical gates | Creation-phase freedom | Verification rules leaking into creation |
| Fewer constraints | Only known high-cost failures | Only necessary cognitive anchors | Everything unnecessary |

## What was done (EN preset in sync with CN)

### P0 — Discipline mechanization ✅
- `plugins/kix-discipline.js` (43 assertions): `tools/pre-execute` checks the requirement
  contract (spec) before implementation edits — no spec + first edit → `remind` (default,
  allow + one-shot reminder) / `ask` (in-chat) / `block` (deny); test files always pass.
  `kix_discipline_spec` tool records goal/xy/assumptions/path/acceptance into workspace
  `kix-discipline/spec.md`. `agent/turn-stopping`: turn ends with edits but no test run →
  green reminder. `/kix-discipline status|report|on|off`.

### P1 — Persona/instructions slimming ✅
- CN persona 7,268 → 3,272 chars (↓55%); EN persona 16,432 → 14,418 (↓12%, EN keeps the full
  English cognition layer). **v1.2.10 second debt pass**: CN 3,211 chars / ~1.8K o200k tokens and EN 7,624 chars /
  ~1.7K tokens after compressing the arranger model — below the P1 minimum for CN, with the
  persona budget now enforced by `scripts/check-dsh-consistency.cjs` / `scripts/check-consistency.cjs`. Mechanized discipline compressed to "mechanism index + trigger
  phrase"; cognition layer (three-channel / duality / blind spots / routing) retained, slimmed.
- `instructions/kixparadigm-core.instructions.md` rewritten as "authoritative full edition +
  persona is the runtime authority" (kills dual-source drift).

### P2 — Copilot residue removal + gap fill ✅
- `prompts/kixpower-review.prompt.md`: hardcoded model strings (`GLM-5.2 (CodingPlan)
  (gcmp.zhipu)` / `DeepSeek-V4-Flash (gcmp.deepseek)` — nonexistent routes in DSH) →
  `subagent_cross`/`subagent` tool rows (kix-route auto-inverts vendor).
- All 6 agent notes: frontmatter hooks blocks declared "not auto-triggered; enforced by
  kix-guards plugin"; `runSubagent→subagent/subagent_cross`; cross-vendor no hardcoded models.
- orchestrator Guardrails table annotated with DSH carrier column (blast_radius_* → kix-guards).
- **`plugins/kix-orchestration.js` (25 assertions, gap fill)**: subagent dispatch carrying
  `current_sprint` validates workspace `docs/.kixpower-current-sprint` marker, `plan.md` +
  `progress.md` existence, no blocker, QA handoff requires completed==total. Bounded port of
  Copilot's `validate-handoff.ps1` core; deep worktree/SHA/manifest checks not ported (bound to
  Copilot's runSubagent+agentName dispatch format; over-porting = liability).

### Migration completeness audit (DSH-ADAPTATION.md §6.1)
Compared `~/.copilot/`, `%APPDATA%\Code\User\prompts\`, `~/.claude/` vs `dsh/preset/`:
agents ✅ superset, skills ✅ (6 domain-specific excluded deliberately, git-guardrails replaced
by kix-guards), kixparadigm SKILL.md ✅ superset, scripts/tests/templates ✅ identical,
prompts ✅ superset, instructions ✅ identical. **The only real loss was hook automation** —
9 Copilot hooks auto-fired; 8 became prompt-only after migration. Fixed: blast-radius →
kix-guards, validate-handoff core → kix-orchestration; rest deliberately not ported (see §2).

## Deliberately NOT done (rules-are-liabilities decisions)

1. **No orchestrator 44KB→15KB blind slimming** — its 49 sections are real execution
   mechanisms (L2 flow / advance conditions / topology / Observe / L4), loaded on demand
   (not resident); slimming risk > token benefit.
2. **No kix-guards YAML rule layer** — kix-guards is the global enforced baseline (5 gates /
   218 assertions); hardcoding guarantees consistency and resists project tampering.
   permission-rules-style YAML targets "project-custom rules", which kix has no real need for.
3. **No "how to think" mechanization** — three-channel / duality / blind-spot map / routing
   are cognitive heuristics; writing them as gates degrades understanding into checkboxing
   (kix v5.5 explicitly forbids).

## P4 — Minimal + Progressive Disclosure + PTC (implemented 2026-08-16, `kix-focus`, 34 asserts)

**Motivation (measured)**: a kix session sends ~85 tool schemas (~108KB JSON) to the model
every turn. Minimal-mode evidence (dsh-mcp-lens: input tokens -89%, cost -89%, completion 3/3)
shows trimming the surface cuts cost without losing capability.

**Three layers (DSH-native mechanisms)**:
- **Phase 1 — Resident trimming**: `tools.restrict` trims the per-turn tool surface from 85
  to ~18 resident core tools (three-channel execute edit/write/pwsh/read/grep/glob; observe
  subagent×5; interact ask_user_question/todo_write/skill/web_search; discovery
  kix_capability_*). MCP (GitHub/Playwright/Context7/Semgrep), workflow/goal/ralph/job_*/
  cordis_* stay on demand. `tools/change` retry (MCP may register after the plugin).
  restrict affects only the model-visible surface; scope tools and gate plugins are untouched.
- **Phase 2 — Progressive disclosure**: `kix_capability_search` (on-demand catalog; group
  metadata — category/use/example tool names, NO full schemas — nothing resident per turn;
  uses the GLOBAL view `schemas(undefined)` so trimmed tools are listed) + `kix_capability_call`
  (proxy execution via `ctx.tools.execute`; full pre-execute→guards→execute→post-execute
  pipeline, gates still fire; agent-carrying calls are not model-direct, so no UNKNOWN_TOOL;
  existence check via global `get(name, undefined)`). **Sensing design (revised 2026-08-16)**:
  NO pre-execute deny — restrict already makes trimmed tools invisible to the model (direct
  calls = UNKNOWN_TOOL before pre-execute), and capability_call's nested sub-calls must pass
  pre-execute (a deny would make the proxy always fail). Guidance rides the capability_call
  return and the persona trigger phrases.
- **Phase 3 — PTC synergy**: keeps `tool-presentation mode: both` (native direct calls for
  verification + run_code for mechanical steps); kix red line "verification/observation stay
  native (evidence replayable)" unchanged; capability_call is also callable from run_code SDK
  sub-dispatches (which pass through gates).

**Config**: `enableRestrict: false` disables trimming (search/call only); `extraResidentTools`
appends resident tools. Mounted in both editions; full assertion suite green (7 plugins, verify
exact count via `npm test`).

**Honest boundary**: restrict trims the model-visible surface, not the executable surface —
proxy calls can still execute trimmed tools (that is the disclosure semantics: capability
present, schema not resident).

**Scope-tool trimming decision (2026-08-15, 2nd measurement pass + 3rd on-demand
activation; revised 2026-08-17 per user decision A+B)**: restrict only trims GLOBAL
tools; preset-scope tools (workflow/goal/ralph/job_*/subagent-control) are auto-visible
and cannot be trimmed; scope tools cannot be proxied via capability_call (the global view
cannot see scope-local names). The plan evolved:
- 2026-08-16 progressive surface (plan A): **disabled by default + plugin on-demand
  activation** (kix-focus's `kix_tool_activate`: runtime `ctx.plugin` mounts the package —
  `createRequire(process.argv[1])` resolves dsh deps, portable within a deployment; callable
  directly next turn; `kix_tool_deactivate` unmounts; auto-cleaned at session end).
  Measured lesson: with tool-jobs disabled, even STARTING a background job failed —
  `run_in_background` answered "background jobs unavailable: no job controller serves
  this agent" — persona and composition contradicted each other.
- **2026-08-17 (current; user principle: simple mechanical tools without cognitive burden
  stay resident, tools with cognitive burden get mechanized auto-activation)**:
  - **Resident**: tool-jobs (job_* is a pure mechanical control surface — start/collect/
    stop running work, no decision burden) + tool-subagent-control + exit_plan_mode;
  - **Auto-activate on first use**: subagent tiers (lite/thinker/vision/fork/reviewer/qa/dev)
    and goal — `kix_capability_call { tool: subagent_qa, arguments: {…} }` mounts the
    package via `ctx.plugin` and continues executing; activation is done by the **mechanism**,
    the model never has to remember to pre-activate; directly callable from the next turn;
    `kix_tool_activate` remains as explicit pre-activation;
  - **Still disabled (dynamic activation unavailable; remove `disabled` + restart)**:
    tool-workflow (isolate-realm dependency; already mounted in the dsh edition),
    tool-ralph (en edition).
- kix-focus catalog marks the tiers group "auto-activate on first use".

**E2E verification (✅ done, 2026-08-15, fresh session after restart)**:

| Check | Result |
|---|---|
| Schema reduction | 85 tools / 107,939 B → ~19,893 B resident (-81.6%, `scripts/quantify-focus.cjs` rerunnable) |
| New session | ✅ works (no type:null mount/request errors after schema fix; console 0 errors) |
| capability_search | ✅ returns github group (26 tools) + resident/on-demand stats, model classifies correctly |
| capability_call read proxy | ✅ search_repositories executes (IN/OUT payload correct, rootCallId propagated, no UNKNOWN_TOOL) |
| capability_call write gate | ✅ create_issue → ASK dialog → reject → `ok:false`, no side effect; push_files w/o branch → static DENY, no dialog |
| run_code resident | ✅ visible in model surface (restrict keeps the reserved transport), minimal program 41+1=42 runs |
| run_code sub-dispatch | ✅ SDK `tools.read` works; `tools["mcp__github__push_files"]` blocked by gate, error identical to direct call — **no gate bypass** |
| Native parallel | ✅ edit/read/pwsh/kix_capability_* direct calls fine (per-agent presentation coexists with host default native) |

### P5 — Write-time consistency guard + plan contract gate (implemented 2026-08-17)

Two candidates survived the philosophy filter (of seven; the rest were correctly rejected by rules-are-liability: static file-type mapping = anti-overfit violation, compaction already mechanized = duplicate liability, direct-path schema = three layers already cover it).

**P5a — `kix-consistency` plugin (write-time consistency guard)**: `scripts/check-dsh-consistency.cjs` refactored into `plugins/consistency-lib.cjs` (pure functions, root-parameterized, returns `{failures, notes}`, no console side effects) — **CI scripts and the plugin share one implementation** (no CI-vs-runtime dual source). `tools/pre-execute` on writes under `dsh/preset/`, `en/preset/`, README*, package.json*, vision-bridge runs the relevant sub-checks (persona budget / plugin pair sync / memories count / README phrases / version pair / single-file syntax). Fires only in a source-repo-fingerprint workspace; everything else passes untouched. Default `remind` (docs are reversible, no deny); `ask`/`block` configurable; remindOnce per session per category. Plugin-name list is now dynamic (`pluginNames()` scans the dir) — new plugins join CI checks automatically.

**P5b — kix-orchestration v11 (plan.md contract write gate)**: writing `docs/sprint-N/plan.md` validates the budget-chain fields kix-guards actually consumes + task-list existence; only full `write` is validated (`edit` has no full new content — 0-false-positive discipline); dedicated reminder slot.

**Acceptance**: kix-consistency 36 asserts / kix-orchestration 77→89; zh/en `npm test` fully green; CI (test + pack dry-run) on 4 platform combos.

## Status

| Metric | Before | Now (P0-P4) | Target |
|---|---|---|---|
| Persona chars/tokens | CN 7,268 / ~4.4K | **v1.2.10 CN 3,211 / ~1.8K · EN 7,624 / ~1.7K（budget-guarded）** | ≤4K |
| Discipline rules carrier | prompt preaching | **mechanized (kix-discipline/kix-orchestration)** | mechanism |
| Plugins | 5 | **8** (guards/discipline/orchestration/focus/cost/route/commands/stalled) | ≥6 |
| Per-turn tool surface | ~85 tools / ~108KB schema | **~18 resident + search/call disclosure** | trimmed |
| Assertions | 164+24+57 | **v1.2.11: installer 12 + vision 6 + guards 210 + cost 28 + route 68 + commands 6 groups + discipline 68 + orchestration 69 + focus 73** | green + new |
| Cognition layer | kept | kept, slimmed | keep slimmed |
| Copilot residue | hardcoded models/hooks | **cleared (review prompt, 6 agents, Guardrails)** | cleared |

## Remaining

- **End-to-end runtime verification**: restart `dsh web`, open a new session, verify
  kix-discipline / kix-orchestration actually fire (spec reminder, `/kix-discipline status`,
  handoff gate). Current running session does not reload plugins.
- `kix-stalled` enhancement (evidence-freshness gate): optional, after E2E validation shows need.
