import type { ChatMessage, CompleteChatRequest, LlmProvider } from '../types.js';

export type AnthropicProviderOptions = {
  baseUrl?: string;
  model: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Anthropic API version header. */
  apiVersion?: string;
};

function splitSystem(messages: ChatMessage[]): {
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const systemParts: string[] = [];
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return {
    system: systemParts.length ? systemParts.join('\n\n') : undefined,
    messages: out,
  };
}

/** Anthropic Messages API (`/v1/messages`). */
export function createAnthropicProvider(opts: AnthropicProviderOptions): LlmProvider {
  const base = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiVersion = opts.apiVersion ?? '2023-06-01';

  return {
    async completeChat(request: CompleteChatRequest): Promise<string> {
      const { system, messages } = splitSystem(request.messages);
      if (!messages.length) {
        throw new Error('Anthropic requires at least one user/assistant message');
      }
      const body: Record<string, unknown> = {
        model: opts.model,
        max_tokens: 2048,
        messages,
      };
      if (system) body.system = system;

      const res = await fetchImpl(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': apiVersion,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`Anthropic HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const text = data.content?.find((c) => c.type === 'text')?.text;
      if (typeof text !== 'string') {
        throw new Error('Anthropic response missing content[].text');
      }
      return text;
    },
  };
}
