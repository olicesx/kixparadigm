#!/usr/bin/env python3
"""label.py — orchestrate teacher labeling of kix states.

Two-phase on purpose: emitting prompts and ingesting answers are separate commands,
so the labeling can be done by any teacher (a batch API, a workflow of subagents, or
a human) without this script needing credentials or network.

Typical flow
------------
    # 1. emit one prompt file per batch of states
    python label.py emit --states states.jsonl --out prompts/ --batch 10 --samples 3

    # 2. teacher answers -> labels/<batch>.s0.json ... s1.json ... s2.json
    #    (any process; see teacher_prompt.md)

    # 3. merge + average the samples into gold distributions
    python label.py ingest --labels labels/ --out labeled.jsonl

Samples follow the official recipe: N independent answers per state, averaged.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def load_states(path: str) -> list[dict]:
    with open(path) as fh:
        return [json.loads(line) for line in fh if line.strip()]


def load_questions(path: str) -> dict:
    with open(path) as fh:
        return json.load(fh)["questions"]


def render_prompt(state: dict, questions: dict) -> str:
    with open(os.path.join(HERE, "teacher_prompt.md")) as fh:
        tpl = fh.read()
    return (
        tpl.replace("{{STATE_JSON}}", json.dumps(_lean(state), indent=1, ensure_ascii=False))
        .replace("{{QUESTIONS_JSON}}", json.dumps(questions, indent=1, ensure_ascii=False))
        .replace("{{STATE_ID}}", str(state.get("id", "")))
    )


def _lean(state: dict) -> dict:
    """Strip builder bookkeeping that is not evidence for the decision."""
    return {k: v for k, v in state.items() if not k.startswith("_")}


# --- option keys ------------------------------------------------------------------


def option_keys(qid: str, q: dict) -> list[str]:
    if q["type"] == "choice":
        return list(q["criteria"].keys())
    if q["type"] == "noul":
        return ["true", "false"]
    crit = q.get("criteria") or []
    return [str(i) for i in range(len(crit))]


def normalize(answers: dict, questions: dict) -> dict | None:
    """Coerce a teacher answer into a valid distribution per question."""
    out = {}
    for qid, q in questions.items():
        a = (answers or {}).get(qid)
        if not isinstance(a, dict):
            return None
        keys = option_keys(qid, q)
        vals = {}
        for k in keys:
            try:
                v = float(a.get(k, 0.0))
            except Exception:
                v = 0.0
            vals[k] = max(0.0, v)
        s = sum(vals.values())
        if s <= 0:
            return None
        out[qid] = {k: v / s for k, v in vals.items()}
    return out


def cmd_emit(args) -> None:
    states = load_states(args.states)
    questions = load_questions(args.questions)
    os.makedirs(args.out, exist_ok=True)
    n = 0
    for bi in range(0, len(states), args.batch):
        chunk = states[bi : bi + args.batch]
        for s in range(args.samples):
            name = f"batch{bi // args.batch:04d}.s{s}.prompt.md"
            body = [render_prompt(st, questions) for st in chunk]
            with open(os.path.join(args.out, name), "w") as fh:
                fh.write("\n\n---\n\n".join(body))
            n += 1
    # Provenance manifest. Labels are only valid for the exact state version they were
    # produced against; a builder change silently invalidates all of them otherwise.
    with open(args.questions) as fh:
        qdoc = json.load(fh)
    manifest = {
        "state_versions": sorted({str(s.get("state_version", "unknown")) for s in states}),
        "questions_file": os.path.basename(args.questions),
        "questions_version": qdoc.get("version"),
        "n_states": len(states),
        "batch": args.batch,
        "samples": args.samples,
        "state_ids": [s.get("id") for s in states],
    }
    with open(os.path.join(args.out, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    print(
        f"emitted {n} prompt files for {len(states)} states "
        f"(batch={args.batch}, samples={args.samples}) -> {args.out}"
    )
    print(f"  state_version={manifest['state_versions']} questions={manifest['questions_version']}")


def cmd_ingest(args) -> None:
    questions = load_questions(args.questions)
    manifest = {}
    if args.manifest:
        if not os.path.exists(args.manifest):
            print(f"  ! manifest not found: {args.manifest}", file=sys.stderr)
        else:
            with open(args.manifest) as fh:
                manifest = json.load(fh)
    per_state: dict[str, list[dict]] = {}
    files = sorted(glob.glob(os.path.join(args.labels, "*.json")))
    bad = 0
    for f in files:
        try:
            with open(f) as fh:
                doc = json.load(fh)
        except Exception as e:
            print(f"  ! unreadable {f}: {e}", file=sys.stderr)
            bad += 1
            continue
        # accept either a single object or a list, and either {answers:{...}} or bare
        items = doc if isinstance(doc, list) else [doc]
        for it in items:
            sid = str(it.get("id", ""))
            ans = it.get("answers", it)
            norm = normalize(ans, questions)
            if sid and norm:
                per_state.setdefault(sid, []).append(norm)
            else:
                bad += 1
    kept = 0
    sver = ",".join(manifest.get("state_versions", [])) or "unknown"
    with open(args.out, "w") as fh:
        for sid, samples in per_state.items():
            gold = {}
            for qid in questions:
                keys = option_keys(qid, questions[qid])
                avg = {k: sum(s[qid][k] for s in samples) / len(samples) for k in keys}
                tot = sum(avg.values()) or 1.0
                gold[qid] = {k: round(v / tot, 6) for k, v in avg.items()}
            fh.write(
                json.dumps(
                    {
                        "id": sid,
                        "n_samples": len(samples),
                        "state_version": sver,
                        "questions_version": manifest.get("questions_version"),
                        "gold": gold,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            kept += 1
    print(
        f"ingested {len(files)} label files -> {kept} labeled states "
        f"({bad} unusable records) -> {args.out}"
    )
    print(f"  state_version={sver} questions_version={manifest.get('questions_version')}")
    want = set(manifest.get("state_ids") or [])
    if want:
        missing = want - set(per_state)
        if missing:
            print(
                f"  ! {len(missing)} states in the manifest have no label "
                f"(e.g. {sorted(missing)[:3]})",
                file=sys.stderr,
            )
        thin = [s for s, v in per_state.items() if len(v) < (manifest.get("samples") or 0)]
        if thin:
            print(
                f"  ! {len(thin)} states have fewer samples than requested "
                f"(<{manifest.get('samples')})",
                file=sys.stderr,
            )


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--questions", default=os.path.join(HERE, "questions", "kix_settlement.v1.json")
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("emit")
    e.add_argument("--states", required=True)
    e.add_argument("--out", required=True)
    e.add_argument("--batch", type=int, default=10)
    e.add_argument("--samples", type=int, default=3)
    e.set_defaults(func=cmd_emit)

    i = sub.add_parser("ingest")
    i.add_argument("--labels", required=True)
    i.add_argument("--out", required=True)
    i.add_argument(
        "--manifest",
        default=None,
        help="prompts/manifest.json from `emit`; records state/question version "
        "and reports missing or under-sampled states",
    )
    i.set_defaults(func=cmd_ingest)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
