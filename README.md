# notlm-training

Offline **authoring, saturation, feedback, and model training** for [NotLM](https://github.com/tycheung/notlm) packs.

The browser/runtime packages live in the sibling **`notlm`** repo. This repo never ships with the SPA bundle. Quality gates (`validate`, `intents check`, `ranker check`) stay on `notlmCLI` in `notlm`.

| Package area | Role |
|--------------|------|
| `@notlm-training/author` | Saturation, soft-label, capability stress (`auto`), pack drafts |
| `@notlm-training/llm` | Server-side LLM providers for authoring (env-configured) |
| `@notlm-training/mapper` | Static extract, inventory crawl, control map drafts |
| `@notlm-training/recalibrate` | MissExchange / conversation fold drafts; **miss clustering** → alias/ranker candidates |
| Semantic index | `pack embed-index` writes **base** `pack/semantic-index.json` only; optional `semantic-index.custom.json` overlay is never overwritten |
| `@notlm-training/ranker-train` | Train `ranker.json` (+ optional ONNX) |
| `@notlm-training/laya-train` | Convert pack → Laya JSONL; local fine-tune bridge |
| `@notlm-training/codegen` | Checklist / jobs helpers |
| CLI `notlm-training` | All of the above |

## Install

Clone beside `notlm`, then:

```bash
cd notlm && npm install && npm run build
cd ../notlm-training
npm install
npm run build   # required before npx (dist/ is gitignored)
```

Root deps link `file:../notlm/packages/{core,schema,ranker}`.

Initialize a host app once with the runtime CLI:

```bash
npx notlmCLI init ./my-app
```

## Two entry points

Most decisions (ranker retrain, semantic-index rebuild) are **heuristic / drift-gated**.
Laya is optional and only runs when you pass `--laya=1`.

| Entry | Command | Pipeline |
|-------|---------|----------|
| **Grow** | `train` | `auto` (13-lane stress) → `e2eauto` → post |
| **Promote** | `feedback` | pull misses → cluster → draft-aliases (+ custom semantic); post on **accept** |

**Post** (shared): rebuild `pack/semantic-index.json` only if FAQ/query source digest drifted; retrain `ranker.json` if alias/corpus digest drifted (or `--force-ranker`); run Laya convert/train only if `--laya=1`. Digests stamp only on success. Miss clustering **appends** paraphrase docs to `semantic-index.custom.json` (never overwrites base). State: `.notlm/pipeline-state.json`.

```bash
# Grow System One coverage (fixture = no live LLM)
npx notlm-training train ../react-frontend --fixture --per-lane=5 --pass-rate=0.5
npx notlm-training train ../react-frontend --fixture --laya=1 --laya-dry-run
# Failed phases stop the run; pass --continue-on-error to proceed anyway.

# Promote from production misses (drafts stay accept-gated; post runs on accept)
npx notlm-training feedback ../react-frontend --url "$NOTLM_MISSES_URL" --token "$NOTLM_MISSES_TOKEN"
npx notlm-training feedback ../react-frontend --from misses.json
# after review:
npx notlm-training feedback accept <draftId> ../react-frontend
# optional: feedback … --post  # run embed/ranker on current pack without accepting
```

Legacy phase commands still work (`auto`, `e2eauto`, `misses …`, `pack embed-index`, …) and print a hint to prefer `train` / `feedback`.

### Semantic index: base vs custom

| File under `.notlm/pack/` | Role |
|---------------------------|------|
| `semantic-index.json` | **Base** — hashed n-grams from FAQ + queries. Rebuilt on **drift** (or `pack embed-index`). |
| `semantic-index.custom.json` | **Custom** — miss/training overlay. **Never** overwritten by train/feedback/embed-index. |

Runtime combines both layers at live retrieve.

### Legacy phase details

**`auto`** — 13-lane capability stress (default 5000×13). Lanes: `faq`, `goto`, `query`, `mutation`, `mutation_high_risk`, `context`, `tour`, `search`, `compare`, `handoff`, `audit`, `ood`, `disambiguation`.

**`e2eauto`** — browser-free audit/learn on host scenario banks; F1 stop; checkpoints under `.notlm/train-e2eauto/`. Prefer via `train` (defaults to `--once` for the e2e phase).

**`feedback` subcommands** — `pull` / `draft` / `fold` / `accept` / `run` / `conversations` / `misses` / `embed-index` remain for surgical use. Unchecked drafts refuse accept unless `NOTLM_FORCE_ACCEPT=1`.

## Authoring

```bash
npx notlm-training map|tune|prepare ./my-app
npx notlm-training scenarios saturate ./my-app --fixture
npx notlm-training pack author|accept …
npx notlm-training extract static <srcDir>
npx notlm-training extract host <hostAppRoot>
npx notlm-training inventory …
npx notlm-training annotate checklist …
```

Product packs are **host-owned**: write into `<host>/.notlm/pack/*.json`, then ship with the host frontend. Demo packs in `notlm` are examples only.

## LLM providers

Set `NOTLM_LLM_*`. See [`packages/llm/README.md`](packages/llm/README.md).

Soft-label / auto labeler: `NOTLM_LABELER=llm|laya|mock`.

## Laya (local)

```bash
npx notlm-training laya convert ./my-app --mode=full
npx notlm-training laya train ./my-app --mode=light --dry-run
```

Produces `.notlm/laya/train.jsonl` and (with GPU + deps) a checkpoint. Nightly host promote paths update pack aliases / `ranker.json` only; they do not run `laya train` on the API box.

## CI

```bash
npm run ci   # build + coverage (expects sibling notlm built)
```

## License

See [LICENSE](LICENSE) (same family as the runtime repo unless noted otherwise).
