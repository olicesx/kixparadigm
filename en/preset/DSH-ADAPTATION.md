# DSH Adaptation Layer — kixParadigm × DeepSeek Harness (EN edition, condensed)

> Authoritative mechanism mapping for this English preset. When the Chinese kix originals (skills/prompts/memories, pending translation) conflict with this file or with `agent.cordis.yml`, **this preset's `agent.cordis.yml` persona wins**; mechanism details below are the authority for tool usage.

## §1 Tool-name mapping (Copilot → DSH)

| kix docs (Copilot) | DSH equivalent | Notes |
|---|---|---|
| `runSubagent agentName: "kixpower-xxx"` | `subagent` (no agentName) + role body of `agents/kixpower-xxx.agent.md` injected into the prompt + [CONTEXT]/[TASK]/[CONSTRAINTS] block | `subagent_fork` when the child must inherit this session's context |
| `vscode_askQuestions` | `ask_user_question` | user-owned choices / material ambiguity |
| `read_file` / `grep_search` | `read` / `grep` | same semantics |
| `replace_string_in_file` | `edit` | literal old_string/new_string |
| `run_in_terminal` | `pwsh` (Windows) / `bash` (POSIX) | default `pwsh` 7.x |
| PreToolUse hooks | `plugins/kix-guards.js` (tools/pre-execute) + host sandbox/approval stack | kixpower `hooks/*.ps1` kept as reference + manual checks |
| slash commands `/kixpower-*` | native commands registered by `plugins/kix-commands.js` | type `/` in the UI; zero-token trigger; handler injects `prompts/*.prompt.md` body as a user message |

## §2 Mechanical guards (resident)

- `plugins/kix-guards.js` auto-mounts a `tools/pre-execute` listener (scope-filtered to this preset) that intercepts: destructive SQL (DROP/TRUNCATE/DELETE/UPDATE without WHERE, statement-level, comment-stripped), dangerous git (force push incl. `-f`/`+refs`/`--mirror`, main-branch pushes, commit-budget via reflog), control-plane file writes (`~/.dsh/**`), unknown execution tools, MCP GitHub remote writes without a feature branch.
- Human-confirmation (`ask`) points: `reset --hard`, `clean -f`, `branch -D`, `stash drop`, `checkout --`/`restore`, ordinary pushes, `merge_pull_request`, issue comments.
- The harness's sandbox + approval stack is the resident mechanical layer on top.

## §3 Delegation & vision

- **Cross-vendor observer**: three-channel observation / highest-confidence claims / platform-library semantics assertions → `subagent_zhipu` (GLM-5.3, cross-vendor contradiction). Ordinary dispatch → `subagent` (inherits the main model). `workflow`'s `agent(prompt, {provider, model})` overrides per call. The subagent route must be an exact (provider, model) pair — omitting `model` inherits the parent model (deepseek-v4-flash → UNKNOWN_MODEL); there is no "auto" model. The pinned value tracks the newest available model in the `zai-coding-cn.models` list of `settings.yaml` (glm-5.3 since 2026-08-15).
- **Vision**: the main model declares no image input, so `read_image` is rejected by the routing gate. To inspect images (screenshots / error images / charts / UI / OCR) → pass the image path + question to `subagent_vision` (GLM-4.6V).
- **UI image upload**: the profile plugin `dsh-vision-bridge` (installed by the npm package) converts pasted/dropped images to text descriptions at send time; messages arrive prefixed `📷 [图片自动识别]` — plugin output, not the user's words. If the description is insufficient, ask the user for the image path and use `subagent_vision`.
- Both `subagent_zhipu` and `subagent_vision` route through `llm-pi-ai.providers` in `settings.yaml` — see §Settings.

## §4 Settings.yaml (host plane — the preset cannot install it)

`~/.dsh/settings.yaml` must contain, under `llm-pi-ai.providers`:

- `zai-vision`: GLM-4.6V vision provider — `api: openai-completions`, `baseURL: https://open.bigmodel.cn/api/coding/paas/v4`, models `glm-4.6v` / `glm-4.6v-flash` / `glm-4.5v` each with `input: [text, image]`; API key via env `ZAI_CODING_CN_API_KEY` or `~/.dsh/.credentials.yaml`.
- `zai-coding-cn`: GLM-5.3 cross-vendor observer (text) — `models` list declares glm-5.3 / glm-5.2 / glm-5.1 / glm-5-turbo / glm-4.7 / glm-4.5-air.

Without these, `subagent_zhipu` / `subagent_vision` cannot route. The installer (`kixparadigm-en`) reports this checklist; `kixparadigm-en doctor` re-checks it.

## §5 Native orchestration

- Complex multi-stage orchestration → `workflow` (phases/pipeline/parallel); long-horizon goals → `goal`; planning first → plan mode; long tasks → `pwsh run_in_background` + `job_output`.
- Full-flow suggestions (new project / full PR review / continue sprint) → suggest the matching `/kixpower-*` command, wait for user confirmation, never auto-trigger.

## §6 PTC / Code Mode (both enabled — red lines)

- `run_code` is for mechanical multi-step / batch / concurrent read-only probes; **verification and observation stay native** (evidence must be replayable, gates visible one by one).
- Red lines: verification evidence must be re-run natively or handed to an independent observer; the program must print all context later steps need (including denied sub-dispatches and reasons); on denial, stop immediately — never silently swallow a denial; intermediate values do not flow back.

## §7 Known translation scope

`skills/`, `prompts/`, `memories/`, and team-role `agents/` are still the Chinese originals in this edition (fully functional; terminology bridge in `instructions/glossary.md`). See `TRANSLATION-STATUS.md`. The full Chinese adaptation history (incl. vision-bridge troubleshooting) lives in the `kixparadigm` (CN) preset's `DSH-ADAPTATION.md`.
