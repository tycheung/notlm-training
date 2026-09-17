import type { LlmEnv, LlmProviderKind } from './types.js';

/**
 * Load UIPILOT_LLM_* from `process.env` only.
 *
 * Never reads `.env` / secret files from disk — inject via shell, CI, or a
 * gitignored loader. Hardcoded API keys are forbidden.
 */
export function loadLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnv {
  const providerRaw = (env.UIPILOT_LLM_PROVIDER ?? '').trim().toLowerCase();
  const provider = normalizeProvider(providerRaw);
  if (!provider) {
    throw new Error(
      'UIPILOT_LLM_PROVIDER must be one of: ollama, openai, openai-compat, anthropic, huggingface'
    );
  }

  const defaultBase: Record<LlmProviderKind, string> = {
    ollama: 'http://127.0.0.1:11434',
    openai: 'https://api.openai.com',
    'openai-compat': '',
    anthropic: 'https://api.anthropic.com',
    huggingface: 'https://router.huggingface.co',
  };

  const baseUrl =
    (env.UIPILOT_LLM_BASE_URL ?? '').trim().replace(/\/$/, '') || defaultBase[provider];
  if (!baseUrl) {
    throw new Error('UIPILOT_LLM_BASE_URL is required for openai-compat');
  }

  const model = (env.UIPILOT_LLM_MODEL ?? '').trim();
  if (!model) {
    throw new Error('UIPILOT_LLM_MODEL is required');
  }

  const apiKey = (env.UIPILOT_LLM_API_KEY ?? '').trim() || undefined;

  if (provider !== 'ollama' && !apiKey) {
    throw new Error(`UIPILOT_LLM_API_KEY is required for ${provider}`);
  }

  return { provider, baseUrl, apiKey, model };
}

export function normalizeProvider(raw: string): LlmProviderKind | null {
  if (raw === 'ollama') return 'ollama';
  if (raw === 'openai') return 'openai';
  if (raw === 'openai-compat' || raw === 'openai_compatible') return 'openai-compat';
  if (raw === 'anthropic' || raw === 'claude') return 'anthropic';
  if (raw === 'huggingface' || raw === 'hf' || raw === 'hugging-face') return 'huggingface';
  return null;
}

/** Paths that look like committed secret files — callers must not read them. */
export const REFUSED_SECRET_PATHS = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'secrets.env',
  'credentials.json',
] as const;

export function isRefusedSecretPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  return (REFUSED_SECRET_PATHS as readonly string[]).includes(normalized);
}
