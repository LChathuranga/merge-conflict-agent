// Pure: validates an env-like object. It never reads .env or process.env on its own
// (callers pass the values), so it is safe to bundle into an editor extension.
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
