# uipilot-training

Offline **tune / train / recalibrate** for UiPilot packs. Not the browser runtime.

| Concern | Repo |
|---------|------|
| Runtime coach (`@uipilot/core`, `@uipilot/react`) | [`uipilot`](../uipilot) |
| LLM providers (`@uipilot/llm`) | `uipilot` (host BYO + this CLI) |
| Saturation, intents tune, map/tune/prepare, exchange→drafts | **this repo** |

## Install

```bash
cd uipilot-training
npm install
npm run build
```

Depends on sibling `../uipilot` packages via `file:` links.

## CLI

```bash
# Pull portable MissExchange[] from a host (e.g. VB admin GET ?exchanges_only=true)
npx uipilot-training exchanges pull --url https://api.example/uipilot/misses?exchanges_only=true --out exchanges.json

# Bucket into drafts/ for human accept (1A — never auto-merges pack/)
npx uipilot-training exchanges draft --from exchanges.json ./my-app

# Local vs fallback hit-rate report from a dump
npx uipilot-training metrics --from exchanges.json --misses misses.json

# Authoring façades (delegates to @uipilot/author via operating CLI helpers)
npx uipilot-training tune ./my-app
```

Promotion policy (**1A**): drafts only → human/`intents check` accept → local NLU owns the phrase.

## Providers

Set `UIPILOT_LLM_*` (see `@uipilot/llm` README): `ollama`, `openai`, `openai-compat`, `anthropic`, `huggingface`.
