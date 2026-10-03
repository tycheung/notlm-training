import type { CompleteChatRequest, LlmProvider } from '../types.js';
import { createOpenAiCompatProvider } from './openaiCompat.js';

export type HuggingFaceProviderOptions = {
  baseUrl?: string;
  model: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
};

/**
 * Hugging Face Inference / router OpenAI-compatible chat completions.
 * Default base: https://router.huggingface.co (OpenAI-compat under /v1).
 * For older HF Inference endpoints, set NOTLM_LLM_BASE_URL accordingly.
 */
export function createHuggingFaceProvider(opts: HuggingFaceProviderOptions): LlmProvider {
  const base = (opts.baseUrl ?? 'https://router.huggingface.co').replace(/\/$/, '');
  const compat = createOpenAiCompatProvider({
    baseUrl: base,
    model: opts.model,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });

  return {
    async completeChat(request: CompleteChatRequest): Promise<string> {
      try {
        return await compat.completeChat(request);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Hugging Face chat failed: ${msg}`);
      }
    },
  };
}
