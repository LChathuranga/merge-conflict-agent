import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

// Load the .env that lives next to the tool, not the one in the caller's cwd,
// so the command works from inside any repository. Real env vars still win.
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const VALID_PROVIDERS = ['openai', 'anthropic', 'ollama'];
const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

export const loadConfig = (env = process.env) => {
  const provider = (env.PROVIDER || '').toLowerCase();

  if (!VALID_PROVIDERS.includes(provider)) {
    throw new Error(
      `PROVIDER must be one of: ${VALID_PROVIDERS.join(', ')} (got "${env.PROVIDER || ''}")`
    );
  }

  if (provider !== 'ollama' && !env.API_KEY) {
    throw new Error('API_KEY is required in the environment (.env)');
  }

  if (!env.LLM_MODEL) {
    throw new Error('LLM_MODEL is required in the environment (.env)');
  }

  return {
    provider,
    model: env.LLM_MODEL,
    // Ollama ignores the key, but the OpenAI SDK requires a non-empty value.
    apiKey: env.API_KEY || (provider === 'ollama' ? 'ollama' : undefined),
    // For provider=openai, lets the adapter target any OpenAI-compatible
    // endpoint (Groq, etc.). For provider=ollama, defaults to the local server.
    baseURL:
      env.BASE_URL || (provider === 'ollama' ? OLLAMA_DEFAULT_BASE_URL : undefined),
    // Set JSON_MODE=false for OpenAI-compatible servers that reject response_format.
    jsonMode: env.JSON_MODE !== 'false',
  };
};
