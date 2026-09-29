#!/usr/bin/env python3
"""validate.py — check a kix-guard labeling round before it is worth training on.

Four gates, cheapest first:

  1. STRUCTURAL   every question set tokenizes into a valid sequence (marker count ==
                  option count) and fits the model's context. Catches malformed
                  questions before they silently become training noise.
  2. DISTRIBUTION no NaN, no all-zero, no collapsed answers; report per-question
                  entropy and the spread of the teacher's argmax.
  3. AGREEMENT    if raw (pre-averaged) teacher samples are supplied, measure how much
                  the teacher agrees with itself. Low self-agreement means the question
                  is under-specified — fix the question, not the model.
  4. COVERAGE     the labeled set must actually contain the strata the guard is meant to
                  discriminate. A set of 300 easy sessions teaches nothing.

Also exports a human spot-check sheet: the state, the teacher's distribution, and the
kix signals it was derived from.
"""

from __future__ import annotations

import argparse
import collections
import glob
import json
import math
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def load_jsonl(p: str) -> list[dict]:
    with open(p) as fh:
        return [json.loads(line) for line in fh if line.strip()]


def load_json(path: str) -> dict:
    with open(path) as fh:
        return json.load(fh)


def ent(d: dict) -> float:
    return -sum(v * math.log(v) for v in d.values() if v > 0)


def gate_structural(states, questions, model_dir) -> bool:
    print("\n[1] STRUCTURAL")
    try:
        from laya.common import build_sequence, render_options
        from transformers import AutoTokenizer
    except Exception as e:
        print(f"  SKIP (laya/transformers unavailable: {e})")
        return True
    tok = AutoTokenizer.from_pretrained(os.path.join(model_dir, "tokenizer"))
    cfg = load_json(os.path.join(model_dir, "rl_agent_config.json"))
    bad = 0
    lens = []
    for s in states[:300]:
        for q in questions.values():
            crit = q.get("criteria")
            k = len(render_options({"t": q["type"], "crit": crit}))
            seq, markers = build_sequence(
                tok,
                {k: v for k, v in s.items() if not k.startswith("_")},
                {"t": q["type"], "ins": q["instructions"], "crit": crit},
                cfg.get("max_len", 1024),
                cfg.get("head_max_len", 256),
            )
            if len(markers) != k:
                bad += 1
            lens.append(len(seq))
    print(f"  questions that fail to tokenize: {bad}")
    print(
        f"  sequence length min/mean/max: {min(lens)}/"
        f"{round(statistics.fmean(lens))}/{max(lens)} (max_len={cfg.get('max_len')})"
    )
    return bad == 0


def gate_distribution(labeled, questions) -> bool:
    print("\n[2] DISTRIBUTION")
    ok = True
    for qid in questions:
        dists = [r["gold"][qid] for r in labeled if qid in r.get("gold", {})]
        if not dists:
            print(f"  {qid}: MISSING in every row")
            ok = False
            continue
        for d in dists:
            if any(math.isnan(v) or v < 0 for v in d.values()) or abs(sum(d.values()) - 1) > 1e-3:
                print(f"  {qid}: invalid distribution {d}")
                ok = False
                break
        ents = [ent(d) for d in dists]
        votes = collections.Counter(max(d, key=lambda k: d[k]) for d in dists)
        n = len(dists)
        top = votes.most_common(1)[0]
        print(
            f"  {qid:20s} n={n:4d} entropy min/mean/max "
            f"{min(ents):.2f}/{statistics.fmean(ents):.2f}/{max(ents):.2f} | "
            f"argmax {top[0]}={top[1] / n:.0%} | classes used {len(votes)}/{len(dists[0])}"
        )
        # collapse/diversity warnings are only meaningful on a real sample; a 12-state
        # demo will trip them by construction.
        if n >= 30:
            if top[1] / n > 0.90:
                print(f"    ! collapsed: >90% of labels are '{top[0]}'")
            if statistics.fmean(ents) < 0.15:
                print("    ! degenerate: near-zero entropy on average")
        elif top[1] / n > 0.90:
            print(f"    (n<30: '{top[0]}' at {top[1] / n:.0%} not treated as collapse)")
    return ok


def gate_agreement(label_dir, questions) -> bool:
    print("\n[3] AGREEMENT (teacher self-consistency)")
    files = sorted(glob.glob(os.path.join(label_dir, "*.json")))
    if not files:
        print("  SKIP (no raw label files)")
        return True
    by_state: dict[str, list[dict]] = {}
    for f in files:
        try:
            doc = load_json(f)
        except Exception:
            continue
        for it in doc if isinstance(doc, list) else [doc]:
            sid = str(it.get("id", ""))
            ans = it.get("answers", it)
            if sid and isinstance(ans, dict):
                by_state.setdefault(sid, []).append(ans)
    multi = {k: v for k, v in by_state.items() if len(v) > 1}
    if not multi:
        print("  SKIP (no state has >1 sample)")
        return True
    for qid in questions:
        agrs, tvs = [], []
        for samples in multi.values():
            keys = [list(s[qid].keys()) for s in samples if isinstance(s.get(qid), dict)]
            if len(keys) < 2:
                continue
            gold = sorted(keys[0])
            unan = [
                max(s[qid], key=lambda k: s[qid][k])
                for s in samples
                if isinstance(s.get(qid), dict)
            ]
            agrs.append(unanimity(unan))
            mean = {k: statistics.fmean(s[qid][k] for s in samples) for k in gold}
            tvs.append(
                statistics.fmean(tv(s[qid], mean) for s in samples if isinstance(s.get(qid), dict))
            )
        if agrs:
            print(
                f"  {qid:20s} argmax unanimity {statistics.fmean(agrs):.0%} "
                f"(n={len(agrs)})   mean TV to consensus {statistics.fmean(tvs):.3f}"
            )
    return True


def unanimity(vals: list[str]) -> float:
    """Fraction of samples that agree with the modal answer."""
    c = collections.Counter(vals)
    return c.most_common(1)[0][1] / len(vals)


def tv(a: dict, b: dict) -> float:
    """Total-variation distance between two distributions over the same support."""
    keys = set(a) | set(b)
    return 0.5 * sum(abs(a.get(k, 0.0) - b.get(k, 0.0)) for k in keys)


def gate_coverage(states, labeled) -> bool:
    print("\n[4] COVERAGE (does the set contain the strata the guard must separate?)")
    by_id = {s["id"]: s for s in states}
    lab = [by_id[r["id"]] for r in labeled if r["id"] in by_id]
    if not lab:
        print("  no overlap between states and labels")
        return False
    strata = {
        "edits>0": lambda s: s["changes"]["edits"] > 0,
        "edits>0 & unverified": lambda s: (
            s["changes"]["edits"] > 0 and s["evidence"]["exec_checks_after_last_edit"] == 0
        ),
        "edits>0 & verified": lambda s: (
            s["changes"]["edits"] > 0 and s["evidence"]["exec_checks_after_last_edit"] > 0
        ),
        "irreversible>0": lambda s: s["safety"]["irreversible_actions"] > 0,
        "no observer": lambda s: s["independence"]["observers"] == 0,
        "observer present": lambda s: s["independence"]["observers"] > 0,
        "root session": lambda s: s["session"]["origin"] == "root",
        "subagent": lambda s: s["session"]["origin"] == "subagent",
        "no exec checks at all": lambda s: s["evidence"]["exec_checks_total"] == 0,
    }
    n = len(lab)
    ok = True
    for name, fn in strata.items():
        c = sum(1 for s in lab if fn(s))
        print(f"  {name:24s} {c:4d} / {n}  ({c / n:.0%})")
        if c == 0:
            print("    ! empty stratum — the guard cannot learn to separate it")
            ok = False
    return ok


def export_spotcheck(states, labeled, questions, path, k=25):
    by_id = {s["id"]: s for s in states}
    lab = [r for r in labeled if r["id"] in by_id]
    lines = [
        "# kix-guard labeling spot-check",
        "",
        f"{len(lab)} labeled states. Audit the teacher's distributions against the state.",
        "",
    ]
    for r in lab[:k]:
        s = by_id[r["id"]]
        irr = (
            f", irreversible={s['safety']['irreversible_kinds']}"
            if s["safety"]["irreversible_actions"]
            else ""
        )
        lines.append(
            f"## `{r['id']}`  ({s['session']['origin']}, "
            f"{s['changes']['edits']} edits, "
            f"{s['evidence']['exec_checks_after_last_edit']} checks after last edit, "
            f"{s['independence']['observers']} observers{irr})"
        )
        lines.append("")
        lines.append("```json")
        lines.append(
            json.dumps(
                {k2: v for k2, v in s.items() if not k2.startswith("_")},
                ensure_ascii=False,
                indent=1,
            )
        )
        lines.append("```")
        lines.append("")
        lines.append(f"**task**: {s['task'][:200]}")
        lines.append("")
        lines.append("| question | distribution |")
        lines.append("|---|---|")
        for qid, d in r["gold"].items():
            ranked = sorted(d.items(), key=lambda kv: -kv[1])
            parts = " ".join(f"`{kk}`={vv:.2f}" for kk, vv in ranked)
            lines.append(f"| `{qid}` | {parts} |")
        lines.append("")
    with open(path, "w") as fh:
        fh.write("\n".join(lines))
    print(f"\nspot-check sheet -> {path}  ({min(k, len(lab))} of {len(lab)} states)")


def gate_trainer_load(parquet_path, model_dir) -> bool:
    """Replay the official RLCD trainer's data path against the built parquet.

    This is the load-bearing gate: everything upstream can be right and the parquet can
    still be unusable if the gold shape or the sequence construction drifts from what
    the trainer expects. It mirrors the trainer's own lines rather than re-implementing
    an interpretation of them.
    """
    print("\n[5] TRAINER LOAD (replays the official data path)")
    try:
        import pyarrow.parquet as pq
        from laya.common import QTYPES, build_sequence, render_options
        from transformers import AutoTokenizer
    except Exception as e:
        print(f"  SKIP (laya/transformers unavailable: {e})")
        return True

    tok = AutoTokenizer.from_pretrained(os.path.join(model_dir, "tokenizer"))
    cfg = load_json(os.path.join(model_dir, "rl_agent_config.json"))
    t = pq.read_table(parquet_path)
    rows = [{c: t.column(c)[i].as_py() for c in t.column_names} for i in range(t.num_rows)]

    cases, bad, nofit = [], 0, 0
    lens = []
    for row in rows:
        st = json.loads(row["state"])
        qs = json.loads(row["questions"])
        gold = json.loads(row["gold"])
        case = []
        for qid, q in qs.items():
            if qid not in gold:
                continue
            typ, crit = q["type"], q.get("criteria", {})
            if typ == "choice":
                target = [gold[qid]["probabilities"].get(k, 0.0) for k in crit]
            elif typ == "noul":
                target = [
                    gold[qid]["probabilities"].get("false", 0.5),
                    gold[qid]["probabilities"].get("true", 0.5),
                ]
            else:
                n = len(crit) if isinstance(crit, list) else 4
                target = [gold[qid]["probabilities"].get(str(i), 0.0) for i in range(n)]
            s = sum(target)
            if s <= 0:
                bad += 1
                continue
            target = [v / s for v in target]
            k = len(render_options({"t": typ, "crit": crit}))
            qq = {"t": typ, "ins": q["instructions"], "crit": crit}
            seq, markers = build_sequence(tok, st, qq, cfg["max_len"], cfg["head_max_len"])
            if len(markers) != k:
                nofit += 1
                continue
            lens.append(len(seq))
            case.append(
                {
                    "ids": seq,
                    "markers": markers,
                    "qtype": QTYPES[typ],
                    "target": target,
                    "label": target.index(max(target)),
                    "qid": qid,
                    "nopt": len(target),
                }
            )
        if case:
            cases.append(case)

    items = [it for c in cases for it in c]
    print(f"  cases {len(cases)} / rows {len(rows)} | trainable items {len(items)}")
    print(f"  zero-mass gold: {bad}   sequence too short for options: {nofit}")
    if lens:
        print(
            f"  sequence length min/mean/max: {min(lens)}/"
            f"{round(statistics.fmean(lens))}/{max(lens)}"
        )
    nq = collections.Counter(it["qid"] for it in items)
    print(f"  items per question: {dict(nq)}")
    ok = bool(items) and bad == 0 and nofit == 0 and len(cases) == len(rows)
    if not ok:
        print("  ! the trainer would silently drop rows — fix before training")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--states", required=True)
    ap.add_argument("--labeled", required=True)
    ap.add_argument("--label-dir", help="raw per-sample labels, for the agreement gate")
    ap.add_argument(
        "--questions", default=os.path.join(HERE, "questions", "kix_settlement.v1.json")
    )
    ap.add_argument("--model-dir", help="local laya typed-decisions dir (for the tokenizer gate)")
    ap.add_argument("--parquet", help="built dataset parquet, for the trainer-load gate")
    ap.add_argument("--spotcheck", default="spotcheck.md")
    args = ap.parse_args()

    states = load_jsonl(args.states)
    labeled = load_jsonl(args.labeled)
    questions = load_json(args.questions)["questions"]

    results = {}
    if args.model_dir:
        results["structural"] = gate_structural(states, questions, args.model_dir)
    results["distribution"] = gate_distribution(labeled, questions)
    if args.label_dir:
        results["agreement"] = gate_agreement(args.label_dir, questions)
    results["coverage"] = gate_coverage(states, labeled)
    if args.parquet and args.model_dir:
        results["trainer_load"] = gate_trainer_load(args.parquet, args.model_dir)
    export_spotcheck(states, labeled, questions, args.spotcheck)

    print("\n=== GATES ===")
    for k2, v in results.items():
        print(f"  {k2:14s} {'PASS' if v else 'FAIL'}")
    if not all(results.values()):
        sys.exit(1)


if __name__ == "__main__":
    main()
