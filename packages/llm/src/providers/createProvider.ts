import type { LlmEnv, LlmProvider } from '../types.js';
import { loadLlmEnv } from '../env.js';
import { createAnthropicProvider } from './anthropic.js';
import { createHuggingFaceProvider } from './huggingface.js';
import { createOllamaProvider } from './ollama.js';
import { createOpenAiCompatProvider } from './openaiCompat.js';

export function createProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch
): LlmProvider {
  return createProvider(loadLlmEnv(env), fetchImpl);
}

export function createProvider(llm: LlmEnv, fetchImpl?: typeof fetch): LlmProvider {
  if (llm.provider === 'ollama') {
    return createOllamaProvider({
      baseUrl: llm.baseUrl,
      model: llm.model,
      mode: 'native',
      fetchImpl,
    });
  }

  if (llm.provider === 'anthropic') {
    if (!llm.apiKey) throw new Error('apiKey required for anthropic');
    return createAnthropicProvider({
      baseUrl: llm.baseUrl,
      model: llm.model,
      apiKey: llm.apiKey,
      fetchImpl,
    });
  }

  if (llm.provider === 'huggingface') {
    if (!llm.apiKey) throw new Error('apiKey required for huggingface');
    return createHuggingFaceProvider({
      baseUrl: llm.baseUrl,
      model: llm.model,
      apiKey: llm.apiKey,
      fetchImpl,
    });
  }

  // openai + openai-compat
  if (!llm.apiKey) {
    throw new Error('apiKey required for openai / openai-compat');
  }
  return createOpenAiCompatProvider({
    baseUrl: llm.baseUrl,
    model: llm.model,
    apiKey: llm.apiKey,
    fetchImpl,
  });
}
