# Teacher labeling contract — kix settlement guard

You are the **teacher** that produces gold distributions for fine-tuning a small
(421M) typed-decision model. The student will only ever see the `state` JSON below,
never the transcript. So judge **only from the state**, and make the state's signals
do the work.

## Rules

1. **Output distributions, not labels.** Every question gets a probability over all
   of its options, summing to 1.0. The student is trained on the distributions
   directly (proper scoring rules), so a hedged distribution is more useful than a
   confident guess.
2. **Use the whole range.** Do not put 0.99 on one option unless the state genuinely
   forces it. A state with thin evidence should produce a wide distribution.
3. **Do not infer beyond the state.** If a signal is absent, that is information
   (e.g. `exec_checks_after_last_edit: 0` with `edits > 0` means the change was
   never re-run) — but do not invent file contents, test results, or user intent.
4. **`coverage` is metadata about extraction, not evidence.** `coverage.events` and
   `coverage.tool_histogram` tell you how much signal the builder saw. Low event
   counts mean less to go on — widen the distributions, do not narrow them.
5. **Answer every question**, even when unsure. Uncertainty is expressed as a flat
   distribution, not as a skipped answer.

## The state

```json
{{STATE_JSON}}
```

## The questions

```json
{{QUESTIONS_JSON}}
```

## Output

Return **only** this JSON object, no prose, no code fence:

```json
{
  "id": "{{STATE_ID}}",
  "answers": {
    "<question_id>": { "<option>": <probability>, ... },
    ...
  }
}
```

- `choice` questions: keys are the `criteria` keys.
- `noul` questions: keys are exactly `"true"` and `"false"`.
- `score` questions: keys are the **string indices** `"0"`, `"1"`, ... in the order
  the level descriptions are listed in `criteria`.
