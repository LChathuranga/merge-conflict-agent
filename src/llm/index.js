import { loadConfig } from '../config/index.js';
import { createOpenAIAdapter } from './adapters/openai.js';
import { createAnthropicAdapter } from './adapters/anthropic.js';

const ADAPTERS = {
  openai: createOpenAIAdapter,
  anthropic: createAnthropicAdapter,
  ollama: createOpenAIAdapter,
};

// Unified interface: adapter.complete({ system, messages }) -> Promise<string>
// messages follow the { role: 'user' | 'assistant', content: string } shape
// used by both the OpenAI and Anthropic SDKs.
export const createLLMClient = (env = process.env) => {
  const config = loadConfig(env);
  const factory = ADAPTERS[config.provider];

  if (!factory) {
    throw new Error(`No adapter registered for provider "${config.provider}"`);
  }

  return factory(config);
};
