export interface LLMConfig {
  provider: 'openai' | 'anthropic';
  apiKey: string;
  model: string;
}

/**
 * Returns LLM configuration from environment variables, or null if no API key is set.
 */
export function getLLMConfig(): LLMConfig | null {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return null;

  return {
    provider: (process.env.LLM_PROVIDER as 'openai' | 'anthropic') || 'openai',
    apiKey,
    model: process.env.LLM_MODEL || 'gpt-4o',
  };
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

/**
 * Sends a chat-style messages array to the configured LLM provider and returns the response.
 * Supports OpenAI and Anthropic providers; throws for unknown providers.
 */
export async function callLLM(messages: LLMMessage[], config: LLMConfig): Promise<LLMResponse> {
  if (config.provider === 'openai') {
    return callOpenAI(messages, config);
  } else if (config.provider === 'anthropic') {
    return callAnthropic(messages, config);
  }
  throw new Error(`Unsupported LLM provider: ${config.provider}`);
}

/**
 * Calls the OpenAI Chat Completions API with the given messages.
 * Returns the assistant's reply and token usage if available.
 * Translates 429 (rate-limit) responses into a user-friendly error.
 */
async function callOpenAI(messages: LLMMessage[], config: LLMConfig): Promise<LLMResponse> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.3,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: { message: 'Unknown error' } })) as { error?: { message?: string } };
    if (response.status === 429) {
      throw new Error('AI temporarily unavailable. Try again later.');
    }
    throw new Error(`AI API error: ${errorData.error?.message || response.statusText}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    content: data.choices[0]?.message?.content || '',
    usage: data.usage ? {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
    } : undefined,
  };
}

/**
 * Calls the Anthropic Messages API with the given messages.
 * Pulls the system prompt from the first system message and passes only
 * user/assistant messages to the API. Translates 429 into a user-friendly error.
 */
async function callAnthropic(messages: LLMMessage[], config: LLMConfig): Promise<LLMResponse> {
  // Extract system message content; remaining messages are conversation turns
  const systemMessage = messages.find(m => m.role === 'system')?.content || '';
  const conversationMessages = messages.filter(m => m.role !== 'system');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      system: systemMessage,
      messages: conversationMessages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      temperature: 0.3,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: { message: 'Unknown error' } })) as { error?: { message?: string } };
    if (response.status === 429) {
      throw new Error('AI temporarily unavailable. Try again later.');
    }
    throw new Error(`AI API error: ${errorData.error?.message || response.statusText}`);
  }

  const data = await response.json() as {
    content: Array<{ type: 'text'; text: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };

  return {
    content: data.content[0]?.text || '',
    usage: data.usage ? {
      promptTokens: data.usage.input_tokens,
      completionTokens: data.usage.output_tokens,
    } : undefined,
  };
}
