import OpenAI from 'openai';

// Covers real OpenAI, and any OpenAI-compatible endpoint (Ollama, Groq, ...)
// by pointing baseURL at it. Ollama specifically ignores the API key value,
// so any non-empty string works when config.baseURL targets it.
export const createOpenAIAdapter = (config) => {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  return {
    complete: async ({ system, messages, json = false }) => {
      const response = await client.chat.completions.create({
        model: config.model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          ...messages,
        ],
        // JSON mode keeps small models from wrapping the reply in prose; temperature 0
        // makes local-model merges repeatable (some hosted models reject it, so ollama only).
        ...(json && config.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        ...(config.provider === 'ollama' ? { temperature: 0 } : {}),
      });

      return response.choices[0]?.message?.content ?? '';
    },
  };
};
