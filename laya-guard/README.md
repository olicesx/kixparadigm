# laya-guard — kix settlement guard, labeling & training scaffold

Turns real DSH sessions into a labeled dataset for a **kix-native typed-decision guard**,
and then into a fine-tuned specialist that fits the kix settlement channel.

This directory is the *training* half. The *runtime* half (resident model process, JS SDK,
plugin mount points) is designed in [`../docs/laya-trajectory-guard-integration.md`](../docs/laya-trajectory-guard-integration.md),
whose appendices are the evidence base for every decision made here.

---

## Why this exists (and why the pretrained checkpoint is not enough)

Measured, not assumed:

| Evidence | Finding | Consequence |
|---|---|---|
| Appendix A | `convaiinnovations/laya` `typed-decisions` transfers to our state schema and is fast (65 ms) | it is a usable **general** trajectory-risk advisory |
| Appendix B | it uses only the fields it was trained to use (`steps` 6→1655 moved `needs_review` by −0.006) | **adding kix fields to the state does nothing without training** |
| Appendix B | the kix settlement concern (was the change re-run after the last edit?) **is not in the trained schema at all** | the pretrained model *cannot* judge it — this is a schema gap, not an accuracy gap |
| Appendix C | re-shaping kix signals into the other 3 trained workflows collapses the strong questions (`matches_order` .94 → 4 cases, 1 wrong; `true_positive` .87 → 0.607 vs 0.533) | **cross-workflow routing is not a shortcut**; the specialist is state-shape sensitive |

So the choice is binary: accept the pretrained question definitions and only calibrate,
**or** define kix-native questions and train. This scaffold does the second.

## Contract

**Must not change**
- The guard never enters a deterministic deny path, and never settles a claim
  (red lines ① and ② from the integration doc).
- Nothing here runs at DSH runtime. This is an offline pipeline; it cannot affect a
  live session.

**Must change**
- Labels are produced against a *versioned* state. Changing `state_builder.py` bumps
  `STATE_VERSION` and invalidates every existing label — old observations do not vouch
  for a new version.

**Must hold**
- A labeled row is only usable if the state it was built from is reproducible from the
  session file. The builder is deterministic and metadata-only (no transcript text
  beyond the first real user message).
- The output parquet is consumable by the official RLCD trainer unchanged:
  `state` / `questions` / `gold` as JSON strings, gold shaped
  `{qid: {probabilities, label, confidence}}`.

**Interpretation assumed** (stated explicitly because it was not specified)
- "Gold" is a *teacher distribution*, not a human label. The teacher is a ceiling, so
  fine-tuning buys **distillation, not superior judgment**. The validator therefore
  reports teacher self-agreement so an under-specified question is caught before it
  becomes training noise.

## Pipeline

```
session.jsonl.zstd ──state_builder.py──► states.jsonl
                                            │
                              label.py emit ─┴─► prompts/*.prompt.md  (+ manifest.json)
                                            │        │
                                            │        └─ teacher (any LLM / human)
                                            │                │
                                            │                ▼
                                            │        labels/*.json
                                            │                │
                              label.py ingest ───────────────┘─► labeled.jsonl
                                            │
                          build_dataset.py ─┴─► kix_settlement/kix_settlement.parquet
                                            │
                              validate.py ──┴─► 4 gates + spotcheck.md
```

### Run it

```bash
python state_builder.py <session-root>... --out states.jsonl

python label.py emit   --states sample.jsonl --out prompts/ --batch 10 --samples 3
#   ... a teacher answers prompts/batchNNNN.sK.prompt.md -> labels/batchNNNN.sK.json
python label.py ingest --labels labels/ --manifest prompts/manifest.json --out labeled.jsonl

python build_dataset.py --states states.jsonl --labeled labeled.jsonl --out kix_settlement/

python validate.py --states states.jsonl --labeled labeled.jsonl \
    --label-dir labels/ --spotcheck spotcheck.md --model-dir <typed-decisions dir>
```

`--samples 3` follows the official recipe: three independent answers per state, averaged
into the gold distribution.

## Files

| file | role |
|---|---|
| `questions/kix_settlement.v1.json` | the question set — single source of truth, versioned |
| `state_builder.py` | session → kix-native decision state (deterministic, metadata-only) |
| `teacher_prompt.md` | teacher contract: distributions, not labels |
| `label.py` | `emit` prompts / `ingest` + average samples, with provenance manifest |
| `build_dataset.py` | labeled → official-format parquet (train/test split) |
| `validate.py` | structural / distribution / agreement / coverage gates + spot-check sheet |

## Checks

Three gates — run all, they check different things and fail differently.

```bash
# 1. Python lint + format + types (config is local: ruff.toml, mypy.ini)
ruff check . && ruff format --check . && mypy *.py

# 2. Data pipeline gates (structural / distribution / agreement / coverage / trainer-load)
python validate.py --states ... --labeled ... --label-dir ... \
    --model-dir <typed-decisions dir> --parquet kix_settlement.parquet

# 3. Real-link smoke train — the only check that proves the parquet TRAINS rather
#    than merely loading. Needs a GPU; run it once per schema or label-format change.
HF_HUB_OFFLINE=1 EPOCHS=1 MICRO=4 ACCUM=4 GROUP=4 HOLDOUT=0.25 \
  python <laya trainer> kix_settlement.parquet ./out
```

Gate 5 replays the trainer's *data path* (sequence construction, gold reshaping, marker
count) — it is fast and needs no GPU, but a parquet that passes it can still fail inside
the training loop. Gate 3 is what actually closes that gap.

Measured on the first 12-state demo (60 decisions, 45 train items, 1 epoch):

```
CASES 12 (train 9 / holdout 3) | ITEMS train 45
EPOCH 1/1 loss 0.7676 sigma 0.40 elapsed 223s
TRAIN_SECONDS 223 | PEAK_VRAM_GB 8.13
exit 0
```

`python -m py_compile` is **not** a substitute for gate 1 — it only checks syntax.
And `npm test` says nothing about this directory: kix-bundle has no other Python, so the
repo suite is a regression check on the surrounding package, not a test of this code.

`ruff format .` reports *"6 files"* for this directory: ruff 0.16 also walks Markdown, so
it counts the 4 `.py` files plus `README.md` and `teacher_prompt.md`.

## The five data gates

`validate.py` runs these cheapest-first; any failure exits non-zero.

1. **structural** — every question tokenizes into a valid sequence (marker count ==
   option count) and fits the context window. Catches malformed questions before they
   become silent training noise.
2. **distribution** — no NaN, no all-zero, no collapsed answer; per-question entropy.
   Collapse warnings are suppressed below n=30, where a small demo trips them by
   construction.
3. **agreement** — teacher self-consistency across samples, as argmax unanimity *and*
   mean total-variation distance to consensus. *Low agreement means the question is
   under-specified — fix the question, not the model.*
4. **coverage** — the labeled set must contain the strata the guard has to separate.
   300 easy sessions teach nothing.
5. **trainer_load** — replays the official RLCD trainer's own data path against the
   built parquet (sequence construction, gold reshaping, option-marker count) and
   reports any row the trainer would silently drop. Everything upstream can be right
   and the parquet still unusable; this is the gate that proves otherwise. It is a
   *data-path* check, not a training check — see gate 3 under **Checks** above for the
   smoke train that actually exercises the optimization loop.

## Open question from the first demo run

A 12-state stratified demo ran the whole chain green (5/5 gates, 60 trainable items).
Two of the three signal-bearing questions behaved exactly as designed — `evidential_support`
tracked `exec_checks_after_last_edit` (0 → `no_evidence`, 15/26/45 → `replayable_validated`)
and `risk` separated on irreversible actions (2.41 vs 1.07).

But `needs_observer` did **not** separate on verification status:
P(true) = 0.715 unverified vs 0.721 verified, gap −0.005.

The demo sample confounds the two — the verified sessions are also the large ones
(43/46/32/34 edits, 0–3 irreversible actions) — so the teacher appears to read the
question as "is this consequential?" rather than "is the evidence insufficient?".
This may be correct behaviour (the guard *wants* a holistic judgement) or a mis-worded
question. **Gates 2 and 3 were fully green and could not see it; only the stratified
coverage comparison exposed it.**

Decide on the 300-state run: if the gap is still ≈ 0 there, split the question so the
evidence dimension is not dominated by consequence.

## Deliberately not here

- **No runtime plugin.** The mount points, the shadow-first promotion ladder and the kill
  clause live in the integration doc.
- **No calibration code.** Temperature fitting needs a labeled set first; it consumes
  `labeled.jsonl` and is a separate step.
- **No training loop.** The official RLCD recipe (4 epochs, `proper_reward(w_sph=.75, w_rps=1.0)`
  + weight-1.0 soft CE, LBFGS temperature per qtype, 4–6 min on 2×T4) applies unchanged —
  reproducing it is [documented separately](../docs/laya-trajectory-guard-integration.md).
