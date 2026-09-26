#!/usr/bin/env python3
"""Stub Laya fine-tune entrypoint used by `uipilot-training laya train`.

Real weight training requires the `laya` package + GPU. This script writes a
checkpoint sidecar and metrics so CI / dry-run can complete the pipeline.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--train", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--mode", default="full", choices=("full", "light"))
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    dry = args.dry_run or os.getenv("UIPILOT_LAYA_DRY_RUN") == "1"

    train_path = Path(args.train)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = 0
    if train_path.is_file():
        with train_path.open(encoding="utf-8") as f:
            rows = sum(1 for line in f if line.strip())

    metrics = {
        "status": "dry_run" if dry else "stub_complete",
        "rows": rows,
        "mode": args.mode,
        "note": "Replace with real laya.train when GPU + laya SDK available",
    }
    (out_dir / "metrics.json").write_text(json.dumps(metrics), encoding="utf-8")
    (out_dir / "FINETUNE_PENDING.json").write_text(
        json.dumps({"ok": True, "dry_run": dry, "rows": rows}),
        encoding="utf-8",
    )
    (out_dir / "train-run.json").write_text(
        json.dumps({"checkpoint": str(out_dir), "metrics": metrics}),
        encoding="utf-8",
    )
    print(json.dumps(metrics))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
