import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MAX_TOKENS = 4096;

export const createAnthropicAdapter = (config) => {
  const client = new Anthropic({ apiKey: config.apiKey });

  return {
    complete: async ({ system, messages }) => {
      const response = await client.messages.create({
        model: config.model,
        max_tokens: config.maxTokens || DEFAULT_MAX_TOKENS,
        system,
        messages,
      });

      return response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
    },
  };
};
