#!/usr/bin/env python3
"""
kix-context-audit — replay a DSH session log and report the two context signals
that decide whether a long task needs a handoff, plus the compaction efficiency.

Signals (see memories/context-budget-lessons.md):
  1. compaction efficiency — tokens freed per successful compaction. Two
     consecutive releases under 20K mean the retain budget is eating the
     threshold again (the 2026-09-12 livelock signature was a median of +50 tok).
  2. cumulative prompt tokens — input + cacheRead + cacheWrite summed over every
     routed request. The 2026-09-12 incident session burned 131M this way.

Usage:
  python3 kix-context-audit.py                 # newest session under $DSH_HOME
  python3 kix-context-audit.py <session-dir|log>
  python3 kix-context-audit.py <log> --ratio 0.2   # compaction threshold ratio
"""
import collections
import glob
import json
import os
import subprocess
import sys

DSH_HOME = os.environ.get("DSH_HOME", os.path.expanduser("~/.dsh"))
FREED_WARN = 20_000
FREED_WARN_STREAK = 2
CUMULATIVE_WARN = 30_000_000
CAP = 400_000
RATIO = 0.2


def locate(arg: str | None) -> str:
    if arg:
        p = arg
        if os.path.isdir(p):
            for name in ("session.v3.jsonl.zstd", "session.jsonl.zstd"):
                if os.path.exists(os.path.join(p, name)):
                    return os.path.join(p, name)
            hits = glob.glob(os.path.join(p, "*.jsonl.zstd"))
            if hits:
                return hits[0]
        return p
    sessions = glob.glob(os.path.join(DSH_HOME, "sessions", "*", "session-*"))
    sessions = [d for d in sessions if os.path.isdir(d)]
    if not sessions:
        sys.exit("no sessions found under $DSH_HOME/sessions")
    newest = max(sessions, key=lambda d: max(
        (os.path.getmtime(f) for f in glob.glob(os.path.join(d, "*.jsonl.zstd"))), default=0))
    return locate(newest)


def load(path: str):
    if path.endswith(".zstd"):
        raw = subprocess.run(["zstd", "-dc", path], capture_output=True, check=True).stdout
    else:
        raw = open(path, "rb").read()
    for line in raw.splitlines():
        try:
            yield json.loads(line)
        except Exception:
            continue


def main():
    global RATIO
    argv = sys.argv[1:]
    if "--ratio" in argv:
        RATIO = float(argv[argv.index("--ratio") + 1])
        argv = [a for i, a in enumerate(argv) if a != "--ratio" and (i == 0 or argv[i - 1] != "--ratio")]
    path = locate(argv[0] if argv else None)
    events = []
    per_turn = collections.Counter()
    steps = collections.Counter()
    comp_start = comp_summary = comp_error = 0
    prunes = 0
    prune_tokens = 0
    cumulative = 0
    peak = 0
    models = set()
    windows = {}
    last_ctx = None
    prompt = 0

    for o in load(path):
        t = o.get("type")
        d = o.get("data", {})
        if t == "session":
            print(f"session   {o.get('id')}  preset={o.get('agentPreset')}  cwd={o.get('cwd')}")
        elif t == "model/selection":
            models.add(f"{d.get('provider')}/{d.get('model')}")
        elif t == "request/context":
            key = f"{d.get('provider')}/{d.get('model')}"
            models.add(key)
            if d.get("contextWindow"):
                windows[key] = d["contextWindow"]
            last_ctx = key
        elif t == "step/start":
            steps[d.get("turn")] += 1
        elif t == "assistant/message":
            u = d.get("usage") or {}
            p = (u.get("inputTokens") or 0) + (u.get("cacheReadTokens") or 0) + (u.get("cacheWriteTokens") or 0)
            prompt = p
            cumulative += p
            peak = max(peak, p)
            per_turn[d.get("turn")] += p
            events.append((o.get("seq"), "req", p))
        elif t == "compaction/start":
            comp_start += 1
            events.append((o.get("seq"), "start", None))
        elif t == "compaction/summary":
            comp_summary += 1
        elif t == "compaction/end":
            if d.get("error"):
                comp_error += 1
        elif t == "compaction/prune":
            prunes += 1
            prune_tokens += d.get("shadowedTokenCount") or 0

    freed = []
    i = 0
    while i < len(events):
        if events[i][1] == "start":
            before = [e for e in events[:i] if e[1] == "req"]
            after = [e for e in events[i + 1:] if e[1] == "req"]
            if before and after:
                freed.append(before[-1][2] - after[0][2])
            i += 1
        else:
            i += 1

    print(f"models    {', '.join(sorted(models)) or 'unknown'}")
    print(f"steps     {sum(steps.values())} across {len(steps)} turn(s)")
    print(f"prompts   cumulative={cumulative:,}  peak={peak:,}  last={prompt:,}")
    print(f"compaction starts={comp_start} summaries={comp_summary} errors={comp_error}  prunes={prunes} (~{prune_tokens:,} tok trimmed)")

    if freed:
        ordered = sorted(freed)
        median = ordered[len(ordered) // 2]
        print(f"freed     n={len(freed)} min={min(freed):,} median={median:,} max={max(freed):,}  detail={[f'{x:,}' for x in freed[:12]]}")
    else:
        print("freed     no successful compaction observed")

    print()
    verdict = []
    streak = 0
    worst = 0
    for x in freed:
        if x < FREED_WARN:
            streak += 1
            worst = max(worst, streak)
        else:
            streak = 0
    if worst >= FREED_WARN_STREAK:
        verdict.append(f"WARN compaction efficiency: {worst} consecutive releases < {FREED_WARN:,} tok "
                       f"— retain budget is eating the threshold; check maxRetainTokens/retainRatio")
    if comp_error:
        verdict.append(f"WARN {comp_error} compaction attempt(s) failed the shrink check — the selected span is too small")
    if cumulative >= CUMULATIVE_WARN:
        verdict.append(f"WARN cumulative prompt {cumulative:,} >= {CUMULATIVE_WARN:,} — consider a handoff (goal/continue) instead of one long session")
    if peak >= CAP:
        verdict.append(f"NOTE peak prompt {peak:,} reached the {CAP:,} reference cap — compaction is the binding constraint here")
    # adaptation check for whatever model actually ran: did pressure cross the
    # implied threshold while NOTHING (neither prune nor summary) happened?
    if last_ctx and last_ctx in windows:
        threshold = int(windows[last_ctx] * RATIO)
        if peak >= 0.9 * threshold and prunes == 0 and comp_start == 0:
            verdict.append(
                f"WARN model {last_ctx} (window {windows[last_ctx]:,}) implies threshold ~{threshold:,}, "
                f"peak {peak:,} crossed it but neither pruner nor compaction fired — "
                f"the compactable band is likely negative; add an explicit modelPolicy or the absolute cap"
            )
    if per_turn:
        top = max(per_turn.items(), key=lambda kv: kv[1])
        print(f"heaviest  turn {top[0]}: {top[1]:,} prompt tokens over {steps.get(top[0], 0)} steps")
    print("\n".join(verdict) if verdict else "OK no context-budget warnings")


if __name__ == "__main__":
    main()
