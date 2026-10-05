#!/usr/bin/env python3
"""Fine-tune Laya (RLCD) on NotLM→Laya JSONL and emit a loadable checkpoint.

Requires: GPU + `pip install laya` + CUDA torch.
Dry-run / missing GPU → writes metrics sidecar only (CI-safe).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import shutil
import time
from pathlib import Path
from typing import Any


def _count_rows(path: Path) -> int:
    if not path.is_file():
        return 0
    with path.open(encoding="utf-8") as f:
        return sum(1 for line in f if line.strip())


def _write_stub(out_dir: Path, rows: int, mode: str, dry: bool, note: str) -> dict[str, Any]:
    metrics = {
        "status": "dry_run" if dry else "skipped",
        "rows": rows,
        "mode": mode,
        "note": note,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    (out_dir / "train-run.json").write_text(
        json.dumps({"checkpoint": str(out_dir), "metrics": metrics}),
        encoding="utf-8",
    )
    return metrics


def _gold_probs(q: dict[str, Any], ans: dict[str, Any]) -> dict[str, float] | None:
    t = q.get("type")
    if t == "choice":
        crit = q.get("criteria") or {}
        keys = list(crit.keys()) if isinstance(crit, dict) else []
        if not keys:
            return None
        choice = str((ans or {}).get("choice") or "")
        if choice not in keys:
            # Soft miss: refuse/none if present, else uniform
            fallback = "refuse" if "refuse" in keys else ("none" if "none" in keys else keys[0])
            choice = fallback
        return {k: (1.0 if k == choice else 0.0) for k in keys}
    if t == "noul":
        p = float((ans or {}).get("noul") if (ans or {}).get("noul") is not None else 0.5)
        p = max(0.0, min(1.0, p))
        return {"false": 1.0 - p, "true": p}
    if t == "score":
        crit = q.get("criteria") or []
        n = len(crit) if isinstance(crit, list) else 4
        level = int((ans or {}).get("score") or 0)
        level = max(0, min(n - 1, level))
        return {str(i): (1.0 if i == level else 0.0) for i in range(n)}
    return None


def _build_items(train_path: Path, model_dir: str) -> list[dict[str, Any]]:
    import torch
    from transformers import AutoTokenizer
    from laya.agent import _fix_tokenizer_config
    from laya.common import QTYPES, build_sequence, render_options

    _fix_tokenizer_config(model_dir)
    tok = AutoTokenizer.from_pretrained(os.path.join(model_dir, "tokenizer"))
    with open(os.path.join(model_dir, "rl_agent_config.json"), encoding="utf-8") as f:
        cfg = json.load(f)

    items: list[dict[str, Any]] = []
    skipped = 0
    with train_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            state = row.get("state")
            if isinstance(state, dict):
                state_s = json.dumps(state, ensure_ascii=False)
            else:
                state_s = str(state or "")
            questions = row.get("questions") or {}
            answers = row.get("answers") or row.get("gold") or {}
            for qid, q in questions.items():
                if not isinstance(q, dict):
                    continue
                ans = answers.get(qid) or {}
                probs = _gold_probs(q, ans if isinstance(ans, dict) else {})
                if probs is None:
                    skipped += 1
                    continue
                t = q["type"]
                crit = q.get("criteria", {})
                if t == "choice":
                    keys = list(crit.keys())
                    target = [probs.get(k, 0.0) for k in keys]
                elif t == "noul":
                    target = [probs.get("false", 0.5), probs.get("true", 0.5)]
                else:
                    n_levels = len(crit) if isinstance(crit, list) else 4
                    target = [probs.get(str(i), 0.0) for i in range(n_levels)]
                s = sum(target)
                target = [v / s for v in target] if s > 0 else [1.0 / len(target)] * len(target)
                label = target.index(max(target))
                try:
                    k = len(render_options({"t": t, "crit": crit}))
                    seq, markers = build_sequence(
                        tok,
                        state_s,
                        {"t": t, "ins": q.get("instructions", ""), "crit": crit},
                        cfg["max_len"],
                        cfg["head_max_len"],
                    )
                except Exception:
                    skipped += 1
                    continue
                if len(markers) != k:
                    skipped += 1
                    continue
                items.append(
                    {
                        "ids": seq,
                        "markers": markers,
                        "qtype": QTYPES[t],
                        "target": target,
                        "label": label,
                    }
                )
    print(f"Preprocessed {len(items)} training sequences (skipped {skipped})")
    return items


def _collate(items: list[dict[str, Any]], pad_id: int):
    import torch

    n, L = len(items), max(len(it["ids"]) for it in items)
    kmax = max(len(it["markers"]) for it in items)
    ids = torch.full((n, L), pad_id, dtype=torch.long)
    att = torch.zeros((n, L), dtype=torch.long)
    mpos = torch.zeros((n, kmax), dtype=torch.long)
    mmask = torch.zeros((n, kmax), dtype=torch.bool)
    target = torch.zeros((n, kmax), dtype=torch.float32)
    for i, it in enumerate(items):
        ids[i, : len(it["ids"])] = torch.tensor(it["ids"])
        att[i, : len(it["ids"])] = 1
        k = len(it["markers"])
        mpos[i, :k] = torch.tensor(it["markers"])
        mmask[i, :k] = True
        target[i, : len(it["target"])] = torch.tensor(it["target"], dtype=torch.float32)
    return {
        "input_ids": ids,
        "attention_mask": att,
        "marker_pos": mpos,
        "marker_mask": mmask,
        "target": target,
        "qtype": torch.tensor([it["qtype"] for it in items]),
        "label": torch.tensor([it["label"] for it in items]),
    }


def _fit_one_temp(sel: list[tuple[Any, Any]]) -> float:
    import torch

    if len(sel) < 10:
        return 1.0
    kmax = max(len(z) for z, _ in sel)
    Z = torch.full((len(sel), kmax), -1e4)
    T = torch.zeros((len(sel), kmax))
    for i, (z, t) in enumerate(sel):
        Z[i, : len(z)] = torch.tensor(z)
        T[i, : len(t)] = torch.tensor(t, dtype=torch.float32)
    log_t = torch.zeros(1, requires_grad=True)
    opt = torch.optim.LBFGS([log_t], lr=0.1, max_iter=100)

    def closure():
        opt.zero_grad()
        loss = -(T * torch.log_softmax(Z / log_t.exp(), -1)).sum(-1).mean()
        loss.backward()
        return loss

    opt.step(closure)
    return float(torch.clamp(log_t.exp(), 0.1, 10.0).item())


def _train_rlcd(
    items: list[dict[str, Any]],
    model_dir: str,
    output_dir: Path,
    epochs: int,
    micro_batch: int,
    *,
    plateau_patience: int = 0,
    plateau_min_delta: float = 0.05,
    epoch_offset: int = 0,
) -> dict[str, Any]:
    import torch
    from huggingface_hub import snapshot_download
    from safetensors.torch import load_file, save_file
    from transformers import AutoTokenizer
    from laya.common import build_model, proper_reward

    # model_dir may already be a local snapshot / fine-tune path
    if not os.path.isdir(os.path.join(model_dir, "encoder")):
        model_dir = snapshot_download(model_dir)

    device = torch.device("cuda")
    with open(os.path.join(model_dir, "rl_agent_config.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    cfg["gradient_checkpointing"] = True
    cfg["max_tokens_per_batch"] = 2048
    cfg["max_len"] = min(int(cfg.get("max_len", 1024)), 768)
    cfg["head_max_len"] = min(int(cfg.get("head_max_len", 256)), 192)

    tok = AutoTokenizer.from_pretrained(os.path.join(model_dir, "tokenizer"))
    model = build_model(cfg, encoder_dir=os.path.join(model_dir, "encoder"))
    weights = load_file(os.path.join(model_dir, "model.safetensors"))
    model.load_state_dict(weights, strict=True)
    model.encoder.gradient_checkpointing_enable(
        gradient_checkpointing_kwargs={"use_reentrant": False}
    )
    model.head_checkpointing = True
    model.to(device)
    model.train()

    CALIB_MAX = 200
    order = list(range(len(items)))
    random.Random(20260922).shuffle(order)
    n_calib = min(CALIB_MAX, max(1, len(items) // 10))
    calib_items = [items[i] for i in sorted(order[:n_calib])]
    train_items = [items[i] for i in sorted(order[n_calib:])]

    GRAD_ACCUM = 8
    GROUP_SIZE = 4
    LR_ENCODER = 2.5e-5
    LR_HEAD = 1.0e-4
    SIGMA_START = 0.4
    SIGMA_END = 0.1

    enc_params = [p for n, p in model.named_parameters() if "encoder." in n]
    head_params = [p for n, p in model.named_parameters() if "encoder." not in n]
    optimizer = torch.optim.AdamW(
        [
            {"params": enc_params, "lr": LR_ENCODER},
            {"params": head_params, "lr": LR_HEAD},
        ],
        weight_decay=0.01,
    )
    total_updates = max(1, (len(train_items) // (micro_batch * GRAD_ACCUM)) * epochs)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=total_updates, eta_min=1e-6
    )
    scaler = torch.amp.GradScaler("cuda", enabled=True)

    print(
        f"RLCD train: {len(train_items)} items, {n_calib} calib, "
        f"{epochs} epochs, micro_batch={micro_batch}, "
        f"init={model_dir}, plateau_patience={plateau_patience}, "
        f"plateau_min_delta={plateau_min_delta}"
    )
    t0 = time.time()
    last_avg = 0.0
    best_avg = float("inf")
    stale = 0
    epoch_history: list[float] = []
    stopped_early = False
    epochs_ran = 0

    for epoch in range(epochs):
        random.seed(42 + epoch + epoch_offset)
        random.shuffle(train_items)
        epoch_loss, n_batches = 0.0, 0
        optimizer.zero_grad(set_to_none=True)
        accum_step = 0
        progress = epoch / max(1, epochs - 1)
        sigma = SIGMA_START + (SIGMA_END - SIGMA_START) * progress
        display_epoch = epoch_offset + epoch + 1
        display_total = epoch_offset + epochs

        for b_idx in range(0, len(train_items), micro_batch):
            chunk = train_items[b_idx : b_idx + micro_batch]
            if not chunk:
                continue
            batch = _collate(chunk, tok.pad_token_id)
            with torch.autocast("cuda", dtype=torch.float16):
                logits, act = model(
                    batch["input_ids"].to(device),
                    batch["attention_mask"].to(device),
                    batch["marker_pos"].to(device),
                    batch["marker_mask"].to(device),
                    batch["qtype"].to(device),
                )
            logits = logits.float()
            mask = batch["marker_mask"].to(device)
            k = mask.sum(-1, keepdim=True).float().clamp_min(1.0)
            target = batch["target"].to(device)

            eps = torch.randn((GROUP_SIZE,) + logits.shape, device=device) * sigma * mask
            eps = (eps - eps.sum(-1, keepdim=True) / k) * mask
            z = logits.detach().unsqueeze(0) + eps
            q = torch.softmax(z.masked_fill(~mask, -1e4), -1)

            # Reward / RLCD loss
            with torch.no_grad():
                r = proper_reward(
                    q,
                    target.unsqueeze(0),
                    batch["qtype"].to(device),
                    mask,
                    w_sph=0.75,
                    w_rps=1.0,
                )
                adv = r - r.mean(0, keepdim=True)
                adv = adv / (adv.std() + 1e-6)

            logp = -(((z - logits.unsqueeze(0)) ** 2) * mask).sum(-1) / (2 * sigma**2)
            loss_rl = -(adv * logp).mean()
            loss_ce = -(
                target * torch.log_softmax(logits.masked_fill(~mask, -1e4), -1)
            ).sum(-1).mean()
            loss = (loss_rl + 1.0 * loss_ce) / GRAD_ACCUM + 0.0 * act.sum()

            scaler.scale(loss).backward()
            accum_step += 1

            if accum_step % GRAD_ACCUM == 0 or (b_idx + micro_batch) >= len(train_items):
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                scaler.step(optimizer)
                scaler.update()
                scheduler.step()
                optimizer.zero_grad(set_to_none=True)

            epoch_loss += loss.item() * GRAD_ACCUM
            n_batches += 1
            if n_batches % 25 == 0:
                print(
                    f" Epoch {display_epoch}/{display_total} | Step {n_batches} | "
                    f"Loss {loss.item()*GRAD_ACCUM:.4f} | Reward {r.mean().item():.3f}"
                )

        last_avg = epoch_loss / max(1, n_batches)
        epochs_ran = epoch + 1
        epoch_history.append(last_avg)
        print(
            f"=== Epoch {display_epoch}/{display_total} done in {time.time()-t0:.1f}s | "
            f"avg_loss={last_avg:.4f} ==="
        )

        ckpt_dir = output_dir / "checkpoint_latest"
        ckpt_dir.mkdir(parents=True, exist_ok=True)
        sd = {k: v.half().contiguous().cpu() for k, v in model.state_dict().items()}
        save_file(sd, str(ckpt_dir / "model.safetensors"))
        model.encoder.config.save_pretrained(str(ckpt_dir / "encoder"))
        tok.save_pretrained(str(ckpt_dir / "tokenizer"))
        (ckpt_dir / "checkpoint_meta.json").write_text(
            json.dumps(
                {
                    "epoch": display_epoch,
                    "total_epochs": display_total,
                    "avg_loss": last_avg,
                    "epoch_history": epoch_history,
                },
                indent=2,
            ),
            encoding="utf-8",
        )

        improved = last_avg < (best_avg - plateau_min_delta)
        if improved:
            best_avg = last_avg
            stale = 0
        else:
            stale += 1
            print(
                f"Plateau check: no improve ≥{plateau_min_delta} "
                f"(best={best_avg:.4f}, stale={stale}/{plateau_patience or 'off'})"
            )
            if plateau_patience > 0 and stale >= plateau_patience:
                print(
                    f"Early stop: plateau after {epochs_ran} continue-epochs "
                    f"(best_avg_loss={best_avg:.4f})"
                )
                stopped_early = True
                break

    # Calibration
    print("Fitting calibration temperatures...")
    del optimizer, scaler, scheduler
    torch.cuda.empty_cache()
    model.eval()
    calib_preds: list[tuple[int, Any, Any]] = []
    with torch.no_grad():
        for c_idx in range(0, len(calib_items), 8):
            c_chunk = calib_items[c_idx : c_idx + 8]
            cb = _collate(c_chunk, tok.pad_token_id)
            with torch.autocast("cuda", dtype=torch.float16):
                l_sub, _ = model(
                    cb["input_ids"].to(device),
                    cb["attention_mask"].to(device),
                    cb["marker_pos"].to(device),
                    cb["marker_mask"].to(device),
                    cb["qtype"].to(device),
                )
            l_np = l_sub.float().cpu().numpy()
            for ri, it in enumerate(c_chunk):
                kk = len(it["markers"])
                calib_preds.append((it["qtype"], l_np[ri, :kk], it["target"]))

    fitted_temps = [1.2, 1.2, 1.2]
    try:
        for qt in range(3):
            sel = [(z, t) for q_type, z, t in calib_preds if q_type == qt]
            if sel:
                fitted_temps[qt] = _fit_one_temp(sel)
        print("Fitted temps (choice, score, noul):", [round(t, 3) for t in fitted_temps])
    except Exception as e:  # noqa: BLE001
        print("Temperature fitting fallback:", e)

    output_dir.mkdir(parents=True, exist_ok=True)
    sd = {k: v.half().contiguous().cpu() for k, v in model.state_dict().items()}
    save_file(sd, str(output_dir / "model.safetensors"))
    model.encoder.config.save_pretrained(str(output_dir / "encoder"))
    tok.save_pretrained(str(output_dir / "tokenizer"))
    # Copy any other required agent files from base
    for name in ("README.md", "special_tokens_map.json"):
        src = Path(model_dir) / name
        if src.is_file():
            shutil.copy2(src, output_dir / name)

    cfg["fine_tuned"] = True
    cfg["model_name"] = "laya-vb-notlm"
    cfg["temperature"] = fitted_temps
    cfg.pop("temperature_by_options", None)
    (output_dir / "rl_agent_config.json").write_text(
        json.dumps(cfg, indent=2), encoding="utf-8"
    )

    # Ensure tokenizer config lives where laya.load expects it
    tok_src = Path(model_dir) / "tokenizer"
    if tok_src.is_dir() and not (output_dir / "tokenizer").exists():
        shutil.copytree(tok_src, output_dir / "tokenizer")

    elapsed = time.time() - t0
    return {
        "status": "trained",
        "rows_items": len(items),
        "train_items": len(train_items),
        "calib_items": n_calib,
        "epochs": epochs_ran,
        "epochs_requested": epochs,
        "epoch_offset": epoch_offset,
        "avg_loss": last_avg,
        "best_avg_loss": best_avg if best_avg < float("inf") else last_avg,
        "epoch_history": epoch_history,
        "stopped_early": stopped_early,
        "temperature": fitted_temps,
        "elapsed_sec": round(elapsed, 1),
        "device": str(device),
        "base_model": model_dir,
    }


def _resolve_model_dir(base: str, init_from: str | None) -> str:
    """Prefer a local fine-tune / snapshot directory; else Hub download."""
    from huggingface_hub import snapshot_download

    candidate = (init_from or base).strip()
    path = Path(candidate)
    if path.is_dir() and (path / "encoder").is_dir() and (path / "model.safetensors").is_file():
        print(f"Using local weights: {path.resolve()}")
        return str(path.resolve())
    print(f"Downloading base model {candidate}...")
    return snapshot_download(candidate)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--train", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--mode", default="full", choices=("full", "light"))
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--base", default=os.getenv("NOTLM_LAYA_BASE", "convaiinnovations/laya"))
    p.add_argument(
        "--init-from",
        default=os.getenv("NOTLM_LAYA_INIT_FROM", ""),
        help="Local fine-tune dir to continue from (model.safetensors + encoder).",
    )
    p.add_argument("--epochs", type=int, default=int(os.getenv("NOTLM_LAYA_EPOCHS", "3")))
    p.add_argument(
        "--epoch-offset",
        type=int,
        default=int(os.getenv("NOTLM_LAYA_EPOCH_OFFSET", "0")),
        help="Prior completed epochs (for logging only).",
    )
    p.add_argument(
        "--plateau-patience",
        type=int,
        default=int(os.getenv("NOTLM_LAYA_PLATEAU_PATIENCE", "0")),
        help="Stop after N epochs without avg_loss improve ≥ min-delta (0=disabled).",
    )
    p.add_argument(
        "--plateau-min-delta",
        type=float,
        default=float(os.getenv("NOTLM_LAYA_PLATEAU_MIN_DELTA", "0.05")),
    )
    p.add_argument(
        "--micro-batch",
        type=int,
        default=int(os.getenv("NOTLM_LAYA_MICRO_BATCH", "2")),
    )
    args = p.parse_args()
    dry = args.dry_run or os.getenv("NOTLM_LAYA_DRY_RUN") == "1"

    train_path = Path(args.train)
    out_dir = Path(args.out)
    rows = _count_rows(train_path)

    if dry:
        metrics = _write_stub(out_dir, rows, args.mode, True, "dry-run requested")
        print(json.dumps({"checkpoint": str(out_dir), "metrics": metrics}))
        return 0

    try:
        import torch
    except ImportError:
        metrics = _write_stub(out_dir, rows, args.mode, False, "torch not installed")
        print(json.dumps({"checkpoint": str(out_dir), "metrics": metrics}))
        return 1

    if not torch.cuda.is_available():
        metrics = _write_stub(
            out_dir, rows, args.mode, False, "CUDA unavailable — refusing CPU train"
        )
        print(json.dumps({"checkpoint": str(out_dir), "metrics": metrics}))
        return 1

    try:
        import laya  # noqa: F401
    except ImportError:
        metrics = _write_stub(out_dir, rows, args.mode, False, "laya package not installed")
        print(json.dumps({"checkpoint": str(out_dir), "metrics": metrics}))
        return 1

    os.environ.setdefault("USE_TF", "0")
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    init_from = (args.init_from or "").strip() or None
    model_dir = _resolve_model_dir(args.base, init_from)
    print(f"Building training items from {train_path}...")
    items = _build_items(train_path, model_dir)
    if not items:
        metrics = _write_stub(out_dir, rows, args.mode, False, "zero training items after preprocess")
        print(json.dumps({"checkpoint": str(out_dir), "metrics": metrics}))
        return 1

    out_dir.mkdir(parents=True, exist_ok=True)
    # If continuing into the same dir as init-from, copy weights to a temp init
    # so we don't read a half-written file mid-epoch.
    train_init = model_dir
    if init_from and Path(model_dir).resolve() == out_dir.resolve():
        staging = out_dir.parent / "_init_resume"
        if staging.exists():
            shutil.rmtree(staging)
        staging.mkdir(parents=True, exist_ok=True)
        for name in ("model.safetensors", "rl_agent_config.json", "README.md"):
            src = out_dir / name
            if src.is_file():
                shutil.copy2(src, staging / name)
        for sub in ("encoder", "tokenizer"):
            src = out_dir / sub
            if src.is_dir():
                shutil.copytree(src, staging / sub)
        train_init = str(staging.resolve())
        print(f"Staged resume weights at {train_init}")

    metrics = _train_rlcd(
        items,
        train_init,
        out_dir,
        args.epochs,
        args.micro_batch,
        plateau_patience=args.plateau_patience,
        plateau_min_delta=args.plateau_min_delta,
        epoch_offset=args.epoch_offset,
    )
    metrics["rows"] = rows
    metrics["mode"] = args.mode
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    summary = {"checkpoint": str(out_dir.resolve()), "metrics": metrics}
    (out_dir / "train-run.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
