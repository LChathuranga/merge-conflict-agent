import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MAX_TOKENS = 4096;

// Anthropic wants tool results as blocks inside a user message, and all results for one
// assistant turn together, so consecutive neutral `tool` messages are merged into one.
export const toAnthropicMessages = (messages) => {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      const last = out.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} })),
        ],
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
};

export const toAnthropicTools = (tools) =>
  tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

export const fromAnthropicContent = (content = []) => ({
  text: content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
  toolCalls: content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
});

export const createAnthropicAdapter = (config) => {
  const client = new Anthropic({ apiKey: config.apiKey });

  const chat = async ({ system, messages, tools }) => {
    const response = await client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens || DEFAULT_MAX_TOKENS,
      system,
      messages: toAnthropicMessages(messages),
      ...(tools?.length ? { tools: toAnthropicTools(tools) } : {}),
    });
    return fromAnthropicContent(response.content);
  };

  return {
    chat,
    complete: async (request) => (await chat(request)).text,
  };
};
