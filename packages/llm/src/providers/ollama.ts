import type { ChatMessage, CompleteChatRequest, LlmProvider } from '../types.js';

export type OllamaProviderOptions = {
  baseUrl: string;
  model: string;
  /** Native Ollama `/api/chat` or OpenAI-compat under `/v1/chat/completions`. */
  mode?: 'native' | 'openai-compat';
  fetchImpl?: typeof fetch;
};

function toOpenAiMessages(messages: ChatMessage[]): Array<{ role: string; content: string }> {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export function createOllamaProvider(opts: OllamaProviderOptions): LlmProvider {
  const base = opts.baseUrl.replace(/\/$/, '');
  const mode = opts.mode ?? 'native';
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async completeChat(request: CompleteChatRequest): Promise<string> {
      if (mode === 'openai-compat') {
        const url = `${base}/v1/chat/completions`;
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: opts.model,
            messages: toOpenAiMessages(request.messages),
          }),
        });
        if (!res.ok) {
          throw new Error(`Ollama openai-compat HTTP ${res.status}`);
        }
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new Error('Ollama openai-compat response missing choices[0].message.content');
        }
        return content;
      }

      const url = `${base}/api/chat`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: opts.model,
          messages: toOpenAiMessages(request.messages),
          stream: false,
        }),
      });
      if (!res.ok) {
        throw new Error(`Ollama HTTP ${res.status}`);
      }
      const data = (await res.json()) as { message?: { content?: string } };
      if (typeof data.message?.content !== 'string') {
        throw new Error('Ollama response missing message.content');
      }
      return data.message.content;
    },
  };
}
