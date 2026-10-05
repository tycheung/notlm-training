# notlm-training

Offline **authoring, saturation, feedback, and model training** for [NotLM](../notlm) packs.

The browser/runtime packages live in the sibling **`notlm`** repo. This repo never
ships with the SPA bundle. Quality gates (`validate`, `intents check`, `ranker check`)
stay on `notlmCLI` in `notlm`.

| Package area | Role |
|--------------|------|
| `@notlm-training/author` | Saturation, soft-label, capability stress (`auto`), pack drafts |
| `@notlm-training/llm` | Server-side LLM providers for authoring (env-configured) |
| `@notlm-training/mapper` | Static extract, inventory crawl, control map drafts |
| `@notlm-training/recalibrate` | MissExchange / conversation fold drafts |
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

## Product modes

### `auto` — capability stress (13 lanes)

Grow pack language surfaces until hard fails are gone and pass-rate meets the target
(default **0.999**). Default generation size is **5000 utterances × 13 lanes**.

```bash
npx notlm-training auto ./my-app --per-lane=5000 --pass-rate=0.999
npx notlm-training auto ./my-app --fixture --per-lane=5 --pass-rate=0.5
npx notlm-training auto ./my-app --lanes=faq,goto,ood --per-lane=100
npx notlm-training auto ranker ./my-app   # retrain pack/ranker.json
```

Lanes: `faq`, `goto`, `query`, `mutation`, `mutation_high_risk`, `context`,
`tour`, `search`, `compare`, `handoff`, `audit`, `ood`, `disambiguation`.

### `feedback` — logs → pack drafts

```bash
npx notlm-training feedback pull --url …/notlm/misses?exchanges_only=true --out ex.json
npx notlm-training feedback draft --from ex.json ./my-app
npx notlm-training feedback fold --from .notlm/drafts/exchanges-…/draft.json ./my-app
npx notlm-training feedback accept <draftId> ./my-app

npx notlm-training feedback conversations pull --url … --out conv.json
npx notlm-training feedback conversations analyze --from conv.json ./my-app --mode=review
npx notlm-training feedback run --from conv.json ./my-app --mode=auto

npx notlm-training feedback misses pull|export|draft-aliases …
npx notlm-training feedback metrics --from ex.json
```

`feedback accept` copies a checked draft into `.notlm/pack/` and retrains the ranker.
Unchecked drafts are refused unless `NOTLM_FORCE_ACCEPT=1`.

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

Product packs are **host-owned**: write into `<host>/.notlm/pack/*.json`, then ship
with the host frontend. Demo packs in `notlm` are examples only.

## LLM providers

Set `NOTLM_LLM_*` — see [`packages/llm/README.md`](packages/llm/README.md).

Soft-label / auto labeler: `NOTLM_LABELER=llm|laya|mock`.

## Laya (local)

```bash
npx notlm-training laya convert ./my-app --mode=full
npx notlm-training laya train ./my-app --mode=light --dry-run
```

Produces `.notlm/laya/train.jsonl` and (with GPU + deps) a checkpoint. Nightly host
promote paths update pack aliases / `ranker.json` only — they do not run `laya train`
on the API box.

## CI

```bash
npm run ci   # build + coverage (expects sibling notlm built)
```
