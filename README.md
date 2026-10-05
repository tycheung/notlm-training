# notlm-training

Offline **tune / train / recalibrate** for NotLM packs. Not the browser runtime.

Operating **`notlm` is sealed**: it does not name or advertise this repo. Training
is the only place that documents both sides.

| Concern | Repo |
|---------|------|
| Runtime (`@notlm/core`, `@notlm/react`, schema, ranker **infer**) | sibling [`notlm`](../notlm) |
| Pack quality gates (`validate`, `intents check`, `ranker check`, `init`) | `notlm` thin `notlmCLI` |
| Authoring, saturation, map/tune/prepare, LLM providers, MissExchange, conversation analyze, ranker **train** + ONNX export | **this repo** (`@notlm-training/author`, `llm`, `mapper`, `codegen`, …) |

**Sibling required:** root deps are `file:../notlm/packages/{core,schema,ranker}`
(operating packages at **0.1.0** public-ready). Clone beside `notlm`, build
operating packages first, then install/build here. Runtime chat **regenerate**
is a React chrome action; offline miss/exchange dumps still recalibrate via
`feedback` commands here.

## Install

```bash
cd notlm && npm install && npm run build
cd ../notlm-training
npm install
npm run build   # required before npx notlm-training (dist/ gitignored)
```

Bootstrap a host folder once with the operating CLI, then improve here:

```bash
notlmCLI init ./my-app
```

## Training modes (product surface)

There are **two** training interfaces. Everything else is authoring/bootstrap.

### 1) `auto` — System One capability stress (13 lanes)

Unattended pack growth via the VictoryBowling sharpen method: preset LLM
**pre-prompts per lane**, generate distinct domain utterances (default
**5000 × 13 lanes**), score with the local System One scorer, patch pack
language JSON, loop until `hardFails=0` **and** pass-rate ≥ **0.999**.

Also seeds `e2e-scenarios.json` and `drafts/glossary-from-controls.json` when
missing. Report: `.notlm/train-auto/report.json`.

```bash
# Full run (needs NOTLM_LLM_*)
npx notlm-training auto ./my-app --per-lane=5000 --pass-rate=0.999

# CI / offline morph from pack seeds (no LLM)
npx notlm-training auto ./my-app --fixture --per-lane=5 --pass-rate=0.5

# Subset of lanes
npx notlm-training auto ./my-app --lanes=faq,goto,ood --per-lane=100

# Explicit ranker retrain (also used by nightly promote; not part of the lane loop)
npx notlm-training auto ranker ./my-app
```

Lanes: `faq`, `goto`, `query`, `mutation`, `mutation_high_risk`, `context`,
`tour`, `search`, `compare`, `handoff`, `audit`, `ood`, `disambiguation`.

Runtime decisions stay **System One** (calibrated ranker/rules); LLM growth stays
offline in `auto` / `feedback` / soft-label authoring.

### 2) `feedback` — chat / miss logs → targeted fix

```bash
npx notlm-training feedback pull --url …/notlm/misses?exchanges_only=true --out ex.json
npx notlm-training feedback draft --from ex.json ./my-app
npx notlm-training feedback fold --from .notlm/drafts/exchanges-…/draft.json ./my-app
npx notlm-training feedback accept <draftId> ./my-app   # accept + ranker retrain

npx notlm-training feedback conversations pull --url … --out conv.json
npx notlm-training feedback conversations analyze --from conv.json ./my-app --mode=review
npx notlm-training feedback run --from conv.json ./my-app --mode=auto [--branch-out]

npx notlm-training feedback misses pull|export|draft-aliases …
npx notlm-training feedback metrics --from ex.json
```

`--mode=auto` on conversations analyze auto-accepts checked drafts. `--branch-out`
optionally saturates around log contexts after a run.

Prefer `feedback …` for miss/conversation/metrics flows. Top-level `misses *`
and `ranker train` remain as thin aliases. `auto pause|resume|stop` were removed
with the old growth loop — use `--max-rounds=N` instead.

## Authoring (not training modes)

```bash
npx notlm-training map|tune|prepare ./my-app
npx notlm-training scenarios saturate ./my-app --fixture
npx notlm-training intents tune ./my-app
npx notlm-training pack author|accept …
npx notlm-training extract static <srcDir> [packDir]
npx notlm-training extract host ../react-frontend   # product pack workshop → host .notlm/
```

### Product packs (host deploy SoT)

Sealed **`notlm`** only ships demo packs. Additional / brand packs live in the **host app**:

| Step | Where |
|------|--------|
| Extract / map / tune / accept | this repo against `./react-frontend` (or any host) |
| Deploy unit | `react-frontend/.notlm/pack/*.json` → FE green / CloudFront |
| Laya weights | backend promote path (not FE pack) |

```bash
npx notlm-training feedback pull --url … --out misses.json
npx notlm-training feedback draft --from misses.json ../react-frontend
npx notlm-training feedback fold --from .notlm/drafts/…/draft.json ../react-frontend
npx notlm-training feedback accept <draftId> ../react-frontend
# then commit FE pack + green deploy
```

## Providers

Set `NOTLM_LLM_*` (see `packages/llm/README.md`). Import from `@notlm-training/llm` directly.

Soft-label / auto label pool: `NOTLM_LABELER=llm|laya|mock` (`mock` is deterministic, no GPU).

## Laya decision model (local only)

Convert pack + scenarios to Laya typed-decision JSONL, then fine-tune on a **local** machine
(GPU optional). Nightly server **promote** (Celery) updates CPU pack aliases + `ranker.json` only —
it never runs `laya train` on the server.

**Runtime cold path (sealed `notlm`, not this repo):** NLU miss → host `fallbackLlm` (Laya) →
optional host `secondaryFallbackLlm` (LLM) when `features.llmFallbackOnLayaMiss` is true.
`feedback` MissExchanges may therefore carry `provider.chain=laya_then_llm` after a Laya refuse.

```bash
npx notlm-training laya convert ./my-app --mode=full
npx notlm-training laya train ./my-app --mode=light --dry-run   # CI-safe stub
NOTLM_LAYA_DRY_RUN=1 npx notlm-training laya train ./my-app
```

Output: `.notlm/laya/train.jsonl`, `manifest.json`, and (after train) checkpoint + metrics sidecar
via `scripts/laya_train.py`.

## CI

GitHub Actions checks out **both** repos, builds operating core/schema/ranker, then:

```bash
npm run ci
```
