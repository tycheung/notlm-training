# `@notlm-training/llm`

LLM providers for **offline authoring and training** (Node). The browser runtime
never imports this package — hosts that need live fallback wire their own
`fallbackLlm` HTTP proxy.

## Env

| Variable | Required | Notes |
|----------|----------|--------|
| `NOTLM_LLM_PROVIDER` | yes | `ollama` \| `openai` \| `openai-compat` \| `anthropic` \| `huggingface` |
| `NOTLM_LLM_MODEL` | yes | Model id |
| `NOTLM_LLM_BASE_URL` | often | Defaults: Ollama `http://127.0.0.1:11434`, OpenAI `https://api.openai.com`, Anthropic `https://api.anthropic.com`, HF `https://router.huggingface.co`. **Required** for `openai-compat`. |
| `NOTLM_LLM_API_KEY` | except Ollama | Inject via env / CI — never commit |

## Providers

| Provider | Adapter | Typical base URL |
|----------|---------|------------------|
| Ollama | `/api/chat` | `http://127.0.0.1:11434` |
| OpenAI | Chat Completions | `https://api.openai.com` |
| Azure / Groq / Together / gateways | `openai-compat` | vendor endpoint |
| Anthropic | Messages API | `https://api.anthropic.com` |
| Hugging Face | OpenAI-compat router | `https://router.huggingface.co` |

```ts
import { createProviderFromEnv } from '@notlm-training/llm';

const llm = createProviderFromEnv();
const text = await llm.completeChat({
  messages: [{ role: 'user', content: 'hello' }],
});
```
