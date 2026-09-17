# `@uipilot/llm`

Host-server and **training** chat adapters. Browser `@uipilot/react` runtime does **not**
call these providers — hosts (e.g. Victory Bowling) proxy via BYO `fallbackLlm`.

## Env

| Variable | Required | Notes |
|----------|----------|--------|
| `UIPILOT_LLM_PROVIDER` | yes | `ollama` \| `openai` \| `openai-compat` \| `anthropic` \| `huggingface` |
| `UIPILOT_LLM_MODEL` | yes | Model id |
| `UIPILOT_LLM_BASE_URL` | often | Defaults: Ollama `http://127.0.0.1:11434`, OpenAI `https://api.openai.com`, Anthropic `https://api.anthropic.com`, HF `https://router.huggingface.co`. **Required** for `openai-compat`. |
| `UIPILOT_LLM_API_KEY` | except Ollama | Never commit; inject via env / CI |

## Provider matrix

| Provider | Adapter | Typical base URL |
|----------|---------|------------------|
| Ollama | native `/api/chat` | `http://127.0.0.1:11434` |
| OpenAI | Chat Completions | `https://api.openai.com` |
| Azure OpenAI / Groq / Together / Fireworks / local gateways | `openai-compat` | vendor endpoint |
| Anthropic | Messages API | `https://api.anthropic.com` |
| Hugging Face | OpenAI-compat router | `https://router.huggingface.co` |

```ts
import { createProviderFromEnv } from '@uipilot/llm';

const llm = createProviderFromEnv();
const text = await llm.completeChat({
  messages: [{ role: 'user', content: 'hello' }],
});
```
