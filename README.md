# uipilot-training

Offline **tune / train / recalibrate** for UiPilot packs. Not the browser runtime.

Operating **`uipilot` is sealed**: it does not name or advertise this repo. Training
is the only place that documents both sides.

| Concern | Repo |
|---------|------|
| Runtime (`@uipilot/core`, `@uipilot/react`, schema, ranker **infer**) | sibling [`uipilot`](../uipilot) |
| Pack quality gates (`validate`, `intents check`, `ranker check`, `init`) | `uipilot` thin `uipilotCLI` |
| Authoring, saturation, map/tune/prepare, LLM providers, MissExchange, conversation analyze, ranker **train** + ONNX export | **this repo** |

**Sibling required:** root deps are `file:../uipilot/packages/{core,schema,ranker}`.
Clone beside `uipilot`, build operating packages first, then install/build here.

## Install

```bash
cd uipilot && npm install && npm run build
cd ../uipilot-training
npm install
npm run build   # required before npx uipilot-training (dist/ gitignored)
```

Bootstrap a host folder once with the operating CLI, then improve here:

```bash
uipilotCLI init ./my-app
```

## Training modes (product surface)

There are **two** training interfaces. Everything else is authoring/bootstrap.

### 1) `auto` — unattended growth

Starts from target flow behavior, then branches to more nebulous utterances.
Auto-retrains `pack/ranker.json` after pack growth. Soft alias cap: **10 000** per step / FAQ entry.

```bash
npx uipilot-training auto ./my-app
npx uipilot-training auto ./my-app --pass-rate=0.99 --confidence=0.99 --unlimited
npx uipilot-training auto ./my-app --fixture --window=20 --pass-rate=0.9
npx uipilot-training auto pause ./my-app
npx uipilot-training auto resume ./my-app
npx uipilot-training auto stop ./my-app
npx uipilot-training auto ranker ./my-app   # explicit retrain (also runs after tune)
```

Defaults: pass-rate/confidence 0.99 → window 459; max CPU/RAM 80%. BYO model via
`UIPILOT_LLM_*`. State: `.uipilot/train-auto/`. Also seeds `e2e-scenarios.json` and
`drafts/glossary-from-controls.json` when missing.

Runtime decisions stay **System One** (calibrated ranker/rules); LLM growth stays
offline in `feedback` / soft-label authoring.

### 2) `sharpen` — System One capability stress (13 lanes)

Same method used to sharpen VictoryBowling: preset LLM **pre-prompts per lane**,
generate distinct domain utterances (default **5000 × 13 lanes**), score with the
local System One scorer, patch pack language JSON, loop until `hardFails=0` or
pass-rate ≥ **0.999**.

```bash
# Full run (needs UIPILOT_LLM_*)
npx uipilot-training sharpen ./my-app --per-lane=5000 --pass-rate=0.999

# CI / offline morph from pack seeds (no LLM)
npx uipilot-training sharpen ./my-app --fixture --per-lane=5 --pass-rate=0.5

# Subset of lanes
npx uipilot-training sharpen ./my-app --lanes=faq,goto,ood --per-lane=100
```

Writes growing pack pieces under `.uipilot/pack/` (unless `--no-write`) and a
report at `.uipilot/train-sharpen/report.json`.

Lanes: `faq`, `goto`, `query`, `mutation`, `mutation_high_risk`, `context`,
`tour`, `search`, `compare`, `handoff`, `audit`, `ood`, `disambiguation`.

### 3) `feedback` — chat / miss logs → targeted fix

```bash
npx uipilot-training feedback pull --url …/uipilot/misses?exchanges_only=true --out ex.json
npx uipilot-training feedback draft --from ex.json ./my-app
npx uipilot-training feedback fold --from .uipilot/drafts/exchanges-…/draft.json ./my-app
npx uipilot-training feedback accept <draftId> ./my-app   # accept + ranker retrain

npx uipilot-training feedback conversations pull --url … --out conv.json
npx uipilot-training feedback conversations analyze --from conv.json ./my-app --mode=review
npx uipilot-training feedback run --from conv.json ./my-app --mode=auto [--branch-out]

npx uipilot-training feedback misses pull|export|draft-aliases …
npx uipilot-training feedback metrics --from ex.json
```

`--mode=auto` on conversations analyze auto-accepts checked drafts. `--branch-out`
optionally saturates around log contexts after a run.

Legacy commands (`train auto`, `exchanges *`, `conversations *`, …) still work as
deprecated aliases.

## Authoring (not training modes)

```bash
npx uipilot-training map|tune|prepare ./my-app
npx uipilot-training scenarios saturate ./my-app --fixture
npx uipilot-training intents tune ./my-app
npx uipilot-training pack author|accept …
npx uipilot-training extract static <srcDir> [packDir]
npx uipilot-training extract host ../react-frontend   # product pack workshop → host .uipilot/
```

### Product packs (host deploy SoT)

Sealed **`uipilot`** only ships demo packs. Additional / brand packs live in the **host app**:

| Step | Where |
|------|--------|
| Extract / map / tune / accept | this repo against `./react-frontend` (or any host) |
| Deploy unit | `react-frontend/.uipilot/pack/*.json` → FE green / CloudFront |
| Laya weights | backend promote path (not FE pack) |

```bash
npx uipilot-training feedback pull --url … --out misses.json
npx uipilot-training feedback draft --from misses.json ../react-frontend
npx uipilot-training feedback fold --from .uipilot/drafts/…/draft.json ../react-frontend
npx uipilot-training feedback accept <draftId> ../react-frontend
# then commit FE pack + green deploy
```

## Providers

Set `UIPILOT_LLM_*` (see `packages/llm/README.md`). Import from `@uipilot/llm` directly.

Soft-label / auto label pool: `UIPILOT_LABELER=llm|laya|mock` (`mock` is deterministic, no GPU).

## Laya decision model (local only)

Convert pack + scenarios to Laya typed-decision JSONL, then fine-tune on a **local** machine
(GPU optional). Nightly server **promote** (Celery) updates CPU pack aliases + `ranker.json` only —
it never runs `laya train` on the server.

**Runtime cold path (sealed `uipilot`, not this repo):** NLU miss → host `fallbackLlm` (Laya) →
optional host `secondaryFallbackLlm` (LLM) when `features.llmFallbackOnLayaMiss` is true.
`feedback` MissExchanges may therefore carry `provider.chain=laya_then_llm` after a Laya refuse.

```bash
npx uipilot-training laya convert ./my-app --mode=full
npx uipilot-training laya train ./my-app --mode=light --dry-run   # CI-safe stub
UIPILOT_LAYA_DRY_RUN=1 npx uipilot-training laya train ./my-app
```

Output: `.uipilot/laya/train.jsonl`, `manifest.json`, and (after train) checkpoint + metrics sidecar
via `scripts/laya_train.py`.

## CI

GitHub Actions checks out **both** repos, builds operating core/schema/ranker, then:

```bash
npm run ci
```
