/** LLM chat types — host-server / training only (not browser coach runtime). */

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type CompleteChatRequest = {
  messages: ChatMessage[];
};

export interface LlmProvider {
  completeChat(request: CompleteChatRequest): Promise<string>;
}

/**
 * Provider ids for NOTLM_LLM_PROVIDER.
 * `openai` and `openai-compat` share the OpenAI Chat Completions wire format
 * (OpenAI, Azure OpenAI, Groq, Together, many local gateways).
 */
export type LlmProviderKind =
  | 'ollama'
  | 'openai'
  | 'openai-compat'
  | 'anthropic'
  | 'huggingface';

export type LlmEnv = {
  provider: LlmProviderKind;
  baseUrl: string;
  apiKey?: string;
  model: string;
};
