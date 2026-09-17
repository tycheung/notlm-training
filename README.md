# uipilot-training

Offline **tune / train / recalibrate** for UiPilot packs. Not the browser runtime.

Operating **`uipilot` is sealed**: it does not name or advertise this repo. Training
is the only place that documents both sides.

| Concern | Repo |
|---------|------|
| Runtime (`@uipilot/core`, `@uipilot/react`, schema, ranker **infer**) | sibling [`uipilot`](../uipilot) |
| Pack quality gates (`validate`, `intents check`, `ranker check`, `init`) | `uipilot` thin `uipilotCLI` |
| Authoring, saturation, map/tune/prepare, LLM providers, MissExchange, ranker **train** + ONNX export | **this repo** |

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

## Learning Mode loop (1A)

```bash
npx uipilot-training exchanges pull --url …/uipilot/misses?exchanges_only=true --out ex.json
npx uipilot-training exchanges draft --from ex.json ./my-app
npx uipilot-training exchanges fold --from .uipilot/drafts/exchanges-…/draft.json ./my-app
# review drafts/exchanges-fold-*/ — set meta.checked=true
npx uipilot-training pack accept <draftId> ./my-app
uipilotCLI intents check ./my-app   # gates scenarios.json (+ pack intents)
npx uipilot-training metrics --from ex.json --misses misses.json
```

`exchanges fold` writes pack pieces **and** `scenarios.json` so operating
`intents check` can gate promoted utterances after accept.

## Authoring

```bash
npx uipilot-training map|tune|prepare ./my-app
npx uipilot-training scenarios saturate ./my-app --fixture
npx uipilot-training intents tune ./my-app
npx uipilot-training ranker train ./my-app   # pack/ranker.json + ranker.onnx
```

## Providers

Set `UIPILOT_LLM_*` (see `packages/llm/README.md`). Import from `@uipilot/llm` directly.

## CI

GitHub Actions checks out **both** repos, builds operating core/schema/ranker, then:

```bash
npm run ci
```
