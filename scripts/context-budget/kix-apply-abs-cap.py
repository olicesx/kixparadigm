#!/usr/bin/env python3
"""Rewrite one preset's compaction-basic config from the ratio encoding to the
patched absolute caps. In place, with hard assertions; the caller keeps backups.

usage: kix-apply-abs-cap.py <agent.cordis.yml> [block-file]
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BLOCK_FILE = os.path.join(HERE, "kix-apply-abs-cap.block")
BLOCK_FILE_EN = os.path.join(HERE, "kix-apply-abs-cap.en.block")
START_ANCHOR = "    - id: compaction-basic\n"
END_ANCHOR = "\n\n    - id:"


def pick_block(path: str) -> str:
    """English presets keep English comments (en/preset-classic-en, *-classic-en)."""
    return BLOCK_FILE_EN if ("-en/" in path or "/en/" in path) else BLOCK_FILE


def transform(path: str, block_file: str | None = None) -> None:
    block_file = block_file or pick_block(path)
    s = open(path).read()
    new = open(block_file).read().rstrip("\n")
    assert s.count(START_ANCHOR) == 1, f"{path}: expected exactly one compaction-basic entry, found {s.count(START_ANCHOR)}"
    start = s.index(START_ANCHOR)
    end = s.index(END_ANCHOR, start)
    out = s[:start] + new + s[end:]
    assert "maxThresholdTokens: 200000" in out and "maxRetainTokens: 64000" in out, f"{path}: caps missing after transform"
    assert "thresholdRatio: 0.8" in out, f"{path}: top-level ratio not set"
    open(path, "w").write(out)


if __name__ == "__main__":
    transform(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else BLOCK_FILE)
    print(f"transformed {sys.argv[1]}")
