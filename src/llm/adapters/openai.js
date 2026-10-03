import OpenAI from 'openai';
import { jsonrepair } from 'jsonrepair';

// Tool arguments arrive as a JSON string; weak models sometimes send broken JSON.
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// jsonrepair will happily turn garbage into a bare string, so anything that is not an object
// is rejected instead of being passed to a tool as its arguments.
const parseArguments = (raw) => {
  if (raw === undefined || raw === null || raw === '') return { args: {} };
  if (isPlainObject(raw)) return { args: raw };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(raw));
    } catch (error) {
      return { args: {}, argsError: error.message };
    }
  }
  return isPlainObject(parsed) ? { args: parsed } : { args: {}, argsError: 'arguments must be a JSON object' };
};

export const toOpenAIMessages = (system, messages) => [
  ...(system ? [{ role: 'system', content: system }] : []),
  ...messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  }),
];

export const toOpenAITools = (tools) =>
  tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

export const fromOpenAIMessage = (message) => ({
  text: message?.content ?? '',
  toolCalls: (message?.tool_calls ?? [])
    .filter((c) => c.function)
    .map((c) => ({ id: c.id, name: c.function.name, ...parseArguments(c.function.arguments) })),
});

// Covers real OpenAI, and any OpenAI-compatible endpoint (Ollama, Groq, ...)
// by pointing baseURL at it. Ollama specifically ignores the API key value,
// so any non-empty string works when config.baseURL targets it.
export const createOpenAIAdapter = (config) => {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  // chat() returns { text, toolCalls } and accepts tools; complete() is the text-only shortcut.
  const chat = async ({ system, messages, json = false, tools }) => {
    const response = await client.chat.completions.create({
      model: config.model,
      messages: toOpenAIMessages(system, messages),
      ...(tools?.length ? { tools: toOpenAITools(tools) } : {}),
      // JSON mode keeps small models from wrapping the reply in prose; temperature 0
      // makes local-model merges repeatable (some hosted models reject it, so ollama only).
      // It is left off while tools are offered, since the reply may be a tool request.
      ...(json && config.jsonMode && !tools?.length ? { response_format: { type: 'json_object' } } : {}),
      ...(config.provider === 'ollama' ? { temperature: 0 } : {}),
    });
    return fromOpenAIMessage(response.choices[0]?.message);
  };

  return {
    chat,
    complete: async (request) => (await chat(request)).text,
  };
};
