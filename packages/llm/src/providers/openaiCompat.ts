import type { ChatMessage, CompleteChatRequest, LlmProvider } from '../types.js';

export type OpenAiCompatProviderOptions = {
  baseUrl: string;
  model: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
};

function chatCompletionsUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/$/, '');
  if (b.endsWith('/v1')) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

function toOpenAiMessages(messages: ChatMessage[]): Array<{ role: string; content: string }> {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * OpenAI Chat Completions wire format — also works for Azure OpenAI (with
 * compatible base URL), Groq, Together, Fireworks, and many local gateways.
 */
export function createOpenAiCompatProvider(opts: OpenAiCompatProviderOptions): LlmProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async completeChat(request: CompleteChatRequest): Promise<string> {
      const url = chatCompletionsUrl(opts.baseUrl);
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model,
          messages: toOpenAiMessages(request.messages),
        }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI-compat HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('OpenAI-compat response missing choices[0].message.content');
      }
      return content;
    },
  };
}
