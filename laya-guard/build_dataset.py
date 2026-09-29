#!/usr/bin/env python3
"""build_dataset.py — turn labeled kix states into a typed-decisions-format parquet.

The output is deliberately byte-compatible with the official
`LocalLLaMA/typed-decisions` layout (`state` / `questions` / `gold` as JSON strings),
so the same RLCD trainer consumes it with no changes.

    python build_dataset.py --states states.jsonl --labeled labeled.jsonl \
        --out kix_settlement/ --holdout 0.2
"""

from __future__ import annotations

import argparse
import json
import os
import random

import pyarrow as pa
import pyarrow.parquet as pq


def load_jsonl(p: str) -> list[dict]:
    with open(p) as fh:
        return [json.loads(line) for line in fh if line.strip()]


def lean(state: dict) -> dict:
    return {k: v for k, v in state.items() if not k.startswith("_")}


def argmax(d: dict) -> str:
    return max(d, key=lambda k: d[k])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--states", required=True)
    ap.add_argument("--labeled", required=True)
    ap.add_argument(
        "--questions",
        default=os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "questions", "kix_settlement.v1.json"
        ),
    )
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--holdout", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    states = {s["id"]: s for s in load_jsonl(args.states)}
    labeled = load_jsonl(args.labeled)
    with open(args.questions) as fh:
        questions = json.load(fh)["questions"]

    rows = []
    skipped = 0
    stale = 0
    for rec in labeled:
        sid = rec["id"]
        st = states.get(sid)
        if st is None:
            skipped += 1
            continue
        # a label is only valid for the state version it was produced against
        lv = str(rec.get("state_version") or "unknown")
        sv = str(st.get("state_version") or "unknown")
        if lv != "unknown" and sv != "unknown" and lv != sv:
            stale += 1
            continue
        gold = rec["gold"]
        # mirror the official gold shape: {qid: {probabilities, label, confidence}}
        g = {}
        for qid, dist in gold.items():
            g[qid] = {
                "probabilities": dist,
                "label": argmax(dist),
                "confidence": round(max(dist.values()), 6),
            }
        rows.append(
            {
                "id": sid,
                "workflow": "kix_settlement",
                "state": json.dumps(lean(st), ensure_ascii=False),
                "questions": json.dumps(questions, ensure_ascii=False),
                "gold": json.dumps(g, ensure_ascii=False),
                "n_questions": len(questions),
                "n_samples": rec.get("n_samples", 0),
            }
        )

    if not rows:
        raise SystemExit("no usable labeled rows — check that --states and --labeled share ids")

    random.Random(args.seed).shuffle(rows)
    n_hold = max(1, int(len(rows) * args.holdout))
    for i, r in enumerate(rows):
        r["split"] = "test" if i < n_hold else "train"

    os.makedirs(args.out, exist_ok=True)
    tbl = pa.Table.from_pylist(rows)
    path = os.path.join(args.out, "kix_settlement.parquet")
    pq.write_table(tbl, path)

    tr = sum(1 for r in rows if r["split"] == "train")
    te = len(rows) - tr
    print(f"WROTE {len(rows)} rows -> {path}")
    print(f"  train {tr} / test {te}   (skipped {skipped} labels without a matching state)")
    if stale:
        print(
            f"  ! dropped {stale} labels whose state_version != the current states — "
            f"relabel after any state_builder.py change"
        )
    print(f"  decisions: {len(rows) * len(questions)}")


if __name__ == "__main__":
    main()
