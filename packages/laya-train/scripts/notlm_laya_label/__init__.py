"""Heuristic Laya-style labeler for `python -m notlm_laya_label` (stdin JSON → stdout SoftLabelResult)."""

from __future__ import annotations

import json
import re
import sys
from typing import Any

OOD_RE = re.compile(
    r"\b(recipe|recipes|muffin|muffins|cookie|cookies|cake|weather|bitcoin|homework)\b",
    re.I,
)


def _aliases_map(intents: Any) -> dict[str, list[str]]:
    if not isinstance(intents, dict):
        return {}
    aliases = intents.get("aliases")
    if not isinstance(aliases, dict):
        return {}
    out: dict[str, list[str]] = {}
    for key, val in aliases.items():
        if isinstance(key, str) and isinstance(val, list):
            out[key] = [str(x) for x in val if isinstance(x, str)]
    return out


def _as_steps(flow_steps: Any) -> list[dict[str, Any]]:
    if not isinstance(flow_steps, list):
        return []
    return [s for s in flow_steps if isinstance(s, dict)]


def _faq_list(faq: Any) -> list[dict[str, Any]]:
    if not isinstance(faq, list):
        return []
    return [f for f in faq if isinstance(f, dict)]


def _token_set(text: str) -> set[str]:
    return {t for t in re.split(r"[^\w]+", text.lower()) if len(t) > 1}


def score_step(utterance: str, step_id: str, aliases: list[str], keywords: list[str]) -> float:
    u = utterance.lower()
    tokens = _token_set(u)
    best = 0.0
    if step_id.lower() in u:
        best = max(best, 0.85)
    for phrase in aliases + keywords:
        p = phrase.strip().lower()
        if not p:
            continue
        if p in u:
            best = max(best, 0.9)
        ptoks = _token_set(p)
        if ptoks and ptoks <= tokens:
            best = max(best, 0.78)
        overlap = len(ptoks & tokens)
        if overlap and ptoks:
            best = max(best, 0.5 + 0.25 * (overlap / len(ptoks)))
    return best


def label_payload(payload: dict[str, Any]) -> dict[str, Any]:
    candidates = payload.get("candidates") or []
    flow_steps = _as_steps(payload.get("flowSteps"))
    aliases = _aliases_map(payload.get("intents"))
    faqs = _faq_list(payload.get("faq"))

    scenarios: list[dict[str, Any]] = []
    for i, raw in enumerate(candidates):
        if not isinstance(raw, dict):
            continue
        utterance = str(raw.get("utterance") or "").strip()
        if not utterance:
            continue
        cid = raw.get("id") if isinstance(raw.get("id"), str) else f"laya-{i + 1}"

        if OOD_RE.search(utterance):
            scenarios.append(
                {
                    "id": cid,
                    "utterance": utterance,
                    "expect": {"stepId": None, "rawIntent": "refuse", "faqId": None},
                }
            )
            continue

        best_step: str | None = None
        best_score = 0.0
        for step in flow_steps:
            sid = step.get("id")
            if not isinstance(sid, str):
                continue
            kws = step.get("keywords") if isinstance(step.get("keywords"), list) else []
            kws = [str(k) for k in kws]
            s = score_step(utterance, sid, aliases.get(sid, []), kws)
            if s > best_score:
                best_score = s
                best_step = sid

        best_faq: str | None = None
        faq_score = 0.0
        for f in faqs:
            fid = f.get("id")
            if not isinstance(fid, str):
                continue
            for a in f.get("aliases") or []:
                if isinstance(a, str) and a.lower() in utterance.lower():
                    faq_score = max(faq_score, 0.8)
                    best_faq = fid

        if best_faq and faq_score >= best_score and faq_score >= 0.75:
            answer = f.get("text") if isinstance(f.get("text"), str) else None
            expect: dict[str, Any] = {
                "stepId": None,
                "rawIntent": "faq",
                "faqId": best_faq,
            }
            if answer:
                expect["answer"] = answer
            scenarios.append({"id": cid, "utterance": utterance, "expect": expect})
            continue

        if best_step and best_score >= 0.75:
            scenarios.append(
                {
                    "id": cid,
                    "utterance": utterance,
                    "expect": {"stepId": best_step, "rawIntent": f"goto:{best_step}"},
                }
            )
            continue

        scenarios.append(
            {
                "id": cid,
                "utterance": utterance,
                "expect": {"stepId": None, "rawIntent": "refuse"},
            }
        )

    if not scenarios:
        return {
            "ok": False,
            "errors": ["No labeled scenarios"],
            "checklist": ["Provide candidates"],
        }
    return {"ok": True, "scenarios": scenarios, "raw": {"provider": "notlm_laya_label"}}


def main() -> None:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        sys.stdout.write(
            json.dumps(
                {
                    "ok": False,
                    "errors": [f"Invalid stdin JSON: {e}"],
                    "checklist": ["Send SoftLabel input JSON on stdin"],
                }
            )
        )
        return
    if not isinstance(payload, dict):
        payload = {}
    sys.stdout.write(json.dumps(label_payload(payload)))


if __name__ == "__main__":
    main()
