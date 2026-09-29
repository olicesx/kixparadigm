#!/usr/bin/env python3
"""kix-guard state builder — project a DSH session into the kix-native decision state.

The state is intentionally metadata-only: the model is a small encoder with a fixed
context window, and (measured) it ignores fields it was not trained to use. So the
builder computes a small number of *load-bearing* signals, each traceable to a session
event, rather than dumping the transcript.

Every derived field carries its provenance in `coverage`, so a missing signal is
distinguishable from a signal that is genuinely zero.
"""

from __future__ import annotations

import collections
import contextlib
import glob
import json
import os
import re
import subprocess
import sys

# --- signal detectors -------------------------------------------------------------

EDIT_TOOLS = {"edit", "write", "str_replace_editor", "str-replace-editor"}
SHELL_TOOLS = {"bash", "pwsh", "shell"}

# Bump on ANY change to what the builder emits. Labels are only valid for the version
# they were produced against — a changed state is a different question (kix: old
# observations do not vouch for a new version).
STATE_VERSION = "1.0.0"

EXEC_CHECK = re.compile(
    r"\b(npm\s+test|npm\s+run\s+\S+|pnpm\s+(test|run)|yarn\s+(test|run)|pytest|"
    r"node\s+--test|go\s+test|cargo\s+test|vitest|jest|tsc|eslint|ruff|mypy)\b"
)
IRREVERSIBLE = [
    (re.compile(r"git\s+push\b[^\n]*(--force\b|\s-f\b)"), "force_push"),
    (re.compile(r"\bgit\s+reset\s+--hard\b"), "reset_hard"),
    (re.compile(r"\brm\s+-rf?\s+(/|~|\$HOME)\s*$"), "rm_root"),
    (re.compile(r"\b(DROP|TRUNCATE)\s+TABLE\b", re.IGNORECASE), "destructive_sql"),
    (re.compile(r"\b(shutdown|reboot|mkfs|dd\s+if=)"), "system_destructive"),
]
# Only a *failed* tool result naming a guard/permission boundary counts.
# Plain keyword matching is useless: transcripts are full of source code and prose that
# legitimately contain "forbidden"/"blocked"/"refused" (measured: 59% of sessions
# matched on the naive pattern, almost all false positives — reading a file that
# contains `errors.New("forbidden resolver")` is not a guard denial).
DENIAL_HINT = re.compile(
    r"\[sandbox:[^\]]*denied[^\]]*\]"
    r"|\bpermission denied\b|\boperation not permitted\b"
    r"|\b(EACCES|EPERM)\b"
    r"|\bkix[- ]?guards?\b[^\n]{0,60}\b(deny|denied|blocked|rejected)\b",
    re.IGNORECASE,
)
OBSERVER_LABEL = re.compile(
    r"\b(review|verify|observer|audit|qa|fresh|independent)\b", re.IGNORECASE
)
VERDICT_LINE = re.compile(r"\b(LGTM|APPROVE[D]?|REQUEST[_-]CHANGES|BLOCK|PASS|FAIL)\b")
DEP_FILES = ("package.json", "requirements.txt", "pyproject.toml", "Cargo.toml", "go.mod")
PATH_LIKE = re.compile(r"[\w./-]+\.(?:js|cjs|mjs|ts|tsx|py|rs|go|java|rb|md|json|yml|yaml)")

SKIP_TASK_PREFIX = ("Current runtime", "<system-reminder>", "Independent observer", "kix-recall")


def _read_events(path: str) -> list[dict]:
    raw = subprocess.run(["zstd", "-dc", path], capture_output=True, check=False).stdout
    out = []
    for line in raw.splitlines():
        with contextlib.suppress(Exception):
            out.append(json.loads(line))
    return out


def _text_of(data: dict) -> str:
    return "\n".join(
        b.get("text") or ""
        for b in (data.get("content") or [])
        if isinstance(b, dict) and b.get("type") == "text"
    ).strip()


def _task_text(events: list[dict]) -> str:
    fallback = ""
    for e in events:
        if e.get("type") != "user/message":
            continue
        d = e.get("data") or {}
        src_raw = d.get("source")
        src = src_raw if isinstance(src_raw, dict) else {}
        text = _text_of(d)
        if not text:
            continue
        if any(text.startswith(p) for p in SKIP_TASK_PREFIX):
            continue
        if src.get("kind") == "plugin":
            fallback = fallback or text
            continue
        return text[:400]
    return fallback[:400]


def _tool_args(d: dict) -> dict:
    raw = d.get("arguments")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            v = json.loads(raw)
            return v if isinstance(v, dict) else {}
        except Exception:
            return {"command": raw}
    return {}


def _touched_paths(exec: dict, result_text: str) -> set[str]:
    paths = set()
    for key in ("file_path", "path", "filePath", "filename"):
        v = exec.get(key)
        if isinstance(v, str) and v:
            paths.add(v)
    if not paths:
        paths.update(m.group(0) for m in PATH_LIKE.finditer(result_text))
    return paths


def build_state(path: str) -> dict | None:
    events = _read_events(path)
    if not events:
        return None
    hdr = next((e for e in events if e.get("type") == "session"), {})

    times: list[float] = []
    for e in events:
        t = e.get("time")
        if isinstance(t, (int, float)):
            times.append(t)
    turns = sum(1 for e in events if e.get("type") == "turn/start")
    steps = sum(1 for e in events if e.get("type") == "step/start")

    tools: collections.Counter = collections.Counter()
    edits = 0
    last_edit_i = -1
    files: set[str] = set()
    dep_touch = 0
    checks_after_edit = 0
    checks_total = 0
    failed_commands = 0
    tool_errors = 0
    irreversible: list[str] = []
    denials = 0
    observers = 0
    observer_labels: list[str] = []
    model = None
    final_msg_chars = 0
    verdict_present = False

    for i, e in enumerate(events):
        ty = e.get("type")
        d = e.get("data") or {}

        if ty == "subagent/descriptor":
            model = d.get("agentModel") or model
            label = str(d.get("label") or "")
            if OBSERVER_LABEL.search(label):
                observers += 1
                observer_labels.append(label[:80])
        elif ty == "request/header":
            model = d.get("model") or model
        elif ty == "assistant/message":
            txt = _text_of(d.get("message") or {})
            if txt:
                final_msg_chars = len(txt)
                if VERDICT_LINE.search(txt):
                    verdict_present = True
        elif ty == "tool/call":
            name = str(d.get("name") or "")
            tools[name] += 1
            args = _tool_args(d)
            if name in EDIT_TOOLS:
                edits += 1
                last_edit_i = i
                files |= _touched_paths(args, "")
                if any(
                    str(args.get(k, "")).endswith(DEP_FILES)
                    for k in ("file_path", "path", "filePath")
                ):
                    dep_touch += 1
            elif name in SHELL_TOOLS:
                cmd = str(args.get("command") or "")
                for rx, label in IRREVERSIBLE:
                    if rx.search(cmd):
                        irreversible.append(label)
                        break
                if EXEC_CHECK.search(cmd):
                    checks_total += 1
                    if last_edit_i >= 0 and i > last_edit_i:
                        checks_after_edit += 1
        elif ty == "tool/result":
            msg = d.get("message") or {}
            blocks = msg.get("content") or []
            is_err = False
            rtext = ""
            for b in blocks:
                if isinstance(b, dict) and b.get("type") == "tool-result":
                    if b.get("isError"):
                        is_err = True
                    for c in b.get("content") or []:
                        if isinstance(c, dict) and c.get("type") == "text":
                            rtext += c.get("text") or ""
            if is_err:
                tool_errors += 1
                failed_commands += 1
                if DENIAL_HINT.search(rtext):
                    denials += 1

    duration_s = (max(times) - min(times)) / 1000.0 if len(times) >= 2 else 0.0
    origin = hdr.get("origin") or "root"

    state = {
        "state_version": STATE_VERSION,
        "task": _task_text(events),
        "constraints": [],
        "agent": {
            "autonomy": "checkpointed" if hdr.get("parentSession") else "unsupervised",
            "model": model or "dsh-agent",
        },
        "session": {
            "origin": origin,
            "depth": hdr.get("delegationDepth") or 0,
            "turns": turns,
            "steps": steps,
            "duration_s": round(min(duration_s, 86400.0), 1),
        },
        "changes": {
            "edits": edits,
            "files_touched": len(files),
            "dependency_manifests_touched": dep_touch,
        },
        "evidence": {
            "exec_checks_total": checks_total,
            "exec_checks_after_last_edit": checks_after_edit,
            "tool_errors": tool_errors,
            "failed_commands": failed_commands,
        },
        "independence": {
            "observers": observers,
            "observer_labels": observer_labels[:3],
        },
        "safety": {
            "irreversible_actions": min(len(irreversible), 3),
            "irreversible_kinds": sorted(set(irreversible))[:3],
            "guard_denials": denials,
        },
        "delivery": {
            "verdict_line_present": verdict_present,
            "final_message_chars": final_msg_chars,
        },
    }
    state["coverage"] = {
        "task": bool(state["task"]),
        "tool_histogram": dict(tools.most_common(8)),
        "events": len(events),
    }
    return state


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Build kix-guard states from DSH sessions.")
    ap.add_argument(
        "roots", nargs="+", help="session root dirs (each containing <sid>/session.jsonl.zstd)"
    )
    ap.add_argument("--out", required=True, help="output states.jsonl")
    ap.add_argument("--min-events", type=int, default=12, help="skip trivially short sessions")
    ap.add_argument("--preset", default="kixparadigm", help="keep only this agentPreset ('' = all)")
    args = ap.parse_args()

    files: list[str] = []
    for r in args.roots:
        files += glob.glob(os.path.join(r, "*", "session.jsonl.zstd"))

    out = []
    for i, f in enumerate(files):
        try:
            # cheap header read for preset filtering happens inside build_state anyway
            s = build_state(f)
            if not s:
                continue
            if (
                args.preset
                and s["coverage"]["events"]
                and s["coverage"]["events"] < args.min_events
            ):
                continue
            s["id"] = os.path.basename(os.path.dirname(f))
            s["_path"] = f
            out.append(s)
        except Exception:
            continue
        if i % 300 == 0:
            print(f"... {i}/{len(files)}", file=sys.stderr)

    with open(args.out, "w") as fh:
        for s in out:
            fh.write(json.dumps(s, ensure_ascii=False) + "\n")
    print(f"WROTE {len(out)} states -> {args.out} (from {len(files)} session files)")

    n = len(out)
    if not n:
        return
    print("origin      ", dict(collections.Counter(s["session"]["origin"] for s in out)))
    print("edits>0     ", sum(1 for s in out if s["changes"]["edits"] > 0))
    print(
        "  of which unverified-after-last-edit:",
        sum(
            1
            for s in out
            if s["changes"]["edits"] > 0 and s["evidence"]["exec_checks_after_last_edit"] == 0
        ),
    )
    print("irreversible", sum(1 for s in out if s["safety"]["irreversible_actions"] > 0))
    print("observers>0 ", sum(1 for s in out if s["independence"]["observers"] > 0))
    print("guard_denials>0", sum(1 for s in out if s["safety"]["guard_denials"] > 0))


if __name__ == "__main__":
    main()
