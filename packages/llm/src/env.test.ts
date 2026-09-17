import { describe, expect, it, vi } from 'vitest';
import { isRefusedSecretPath, loadLlmEnv } from './env.js';
import { createProvider } from './providers/createProvider.js';
import { createAnthropicProvider } from './providers/anthropic.js';

describe('loadLlmEnv', () => {
  it('loads ollama from process env', () => {
    const env = loadLlmEnv({
      UIPILOT_LLM_PROVIDER: 'ollama',
      UIPILOT_LLM_BASE_URL: 'http://127.0.0.1:11434',
      UIPILOT_LLM_MODEL: 'llama3.2',
    });
    expect(env).toEqual({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: undefined,
      model: 'llama3.2',
    });
  });

  it('aliases openai to openai provider with default base', () => {
    const env = loadLlmEnv({
      UIPILOT_LLM_PROVIDER: 'openai',
      UIPILOT_LLM_MODEL: 'gpt-4o-mini',
      UIPILOT_LLM_API_KEY: 'sk-test',
    });
    expect(env.provider).toBe('openai');
    expect(env.baseUrl).toBe('https://api.openai.com');
  });

  it('requires api key for openai-compat', () => {
    expect(() =>
      loadLlmEnv({
        UIPILOT_LLM_PROVIDER: 'openai-compat',
        UIPILOT_LLM_BASE_URL: 'https://api.example.com',
        UIPILOT_LLM_MODEL: 'gpt-test',
      })
    ).toThrow(/UIPILOT_LLM_API_KEY/);
  });

  it('loads anthropic and huggingface', () => {
    expect(
      loadLlmEnv({
        UIPILOT_LLM_PROVIDER: 'anthropic',
        UIPILOT_LLM_MODEL: 'claude-3-5-haiku-latest',
        UIPILOT_LLM_API_KEY: 'ak',
      }).provider
    ).toBe('anthropic');
    expect(
      loadLlmEnv({
        UIPILOT_LLM_PROVIDER: 'hf',
        UIPILOT_LLM_MODEL: 'meta-llama/Llama-3.1-8B-Instruct',
        UIPILOT_LLM_API_KEY: 'hf',
      }).provider
    ).toBe('huggingface');
  });

  it('refuses committed-looking secret filenames', () => {
    expect(isRefusedSecretPath('.env')).toBe(true);
    expect(isRefusedSecretPath('apps/demo/.env.local')).toBe(true);
    expect(isRefusedSecretPath('config.json')).toBe(false);
  });
});

describe('createAnthropicProvider', () => {
  it('posts Messages API and returns text', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }),
        { status: 200 }
      )
    );
    const p = createAnthropicProvider({
      model: 'claude-test',
      apiKey: 'ak',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const text = await p.completeChat({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(text).toBe('hi');
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as {
      system?: string;
      messages: unknown[];
    };
    expect(body.system).toBe('sys');
    expect(body.messages).toHaveLength(1);
  });
});

describe('createProvider', () => {
  it('routes openai-compat', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        { status: 200 }
      )
    );
    const p = createProvider(
      {
        provider: 'openai-compat',
        baseUrl: 'https://example.test',
        apiKey: 'k',
        model: 'm',
      },
      fetchMock as unknown as typeof fetch
    );
    expect(await p.completeChat({ messages: [{ role: 'user', content: 'x' }] })).toBe(
      'ok'
    );
  });
});
