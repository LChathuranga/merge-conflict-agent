// Pure: turns the extension's settings (and the API key from secret storage) into what the
// core expects. Nothing here touches VS Code, process.env or .env files.

export const PROVIDERS = ['ollama', 'openai', 'anthropic'];

export const DEFAULTS = {
  provider: 'ollama',
  model: 'llama3.1',
  baseUrl: '',
  jsonMode: true,
  useIntent: true,
  useReferences: true,
  useTools: false,
  maxAttempts: 5,
};

// `get(key, fallback)` reads one setting (for VS Code: configuration.get).
export const readSettings = (get) => {
  const text = (key) => String(get(key, DEFAULTS[key]) ?? '').trim();
  const flag = (key) => get(key, DEFAULTS[key]) !== false;
  const attempts = Number.parseInt(get('maxAttempts', DEFAULTS.maxAttempts), 10);

  return {
    provider: text('provider').toLowerCase(),
    model: text('model'),
    baseUrl: text('baseUrl'),
    jsonMode: flag('jsonMode'),
    useIntent: flag('useIntent'),
    useReferences: flag('useReferences'),
    useTools: get('useTools', DEFAULTS.useTools) === true,
    maxAttempts: Number.isFinite(attempts) ? Math.min(10, Math.max(1, attempts)) : DEFAULTS.maxAttempts,
  };
};

// The env-like object `createLLMClient(env)` takes.
export const buildEnv = (settings, apiKey) => ({
  PROVIDER: settings.provider,
  LLM_MODEL: settings.model,
  ...(apiKey ? { API_KEY: apiKey } : {}),
  ...(settings.baseUrl ? { BASE_URL: settings.baseUrl } : {}),
  JSON_MODE: String(settings.jsonMode),
});

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const parseUrl = (value) => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const isLocalHost = (hostname) => LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost');

// Where code from conflicts would be sent, or null when the model runs on this machine.
// An OpenAI-compatible server on localhost (Ollama, LM Studio) keeps everything local.
export const dataDestination = (settings) => {
  // Only the OpenAI-style clients use a custom address; the Anthropic one always talks to Anthropic.
  if (settings.baseUrl && settings.provider !== 'anthropic') {
    const url = parseUrl(settings.baseUrl);
    if (url) return isLocalHost(url.hostname) ? null : url.host;
  }
  if (settings.provider === 'openai') return 'OpenAI (api.openai.com)';
  if (settings.provider === 'anthropic') return 'Anthropic (api.anthropic.com)';
  return null;
};

// Which saved key belongs to these settings. A key is stored against the server it was given
// for and is only ever sent there: the real OpenAI key lives under "openai", while a key for
// another OpenAI-compatible address lives under "openai@<host>". So a project setting that points
// the extension at some other server can never make it send your OpenAI key there.
export const keySlot = (settings) => {
  if (settings.provider !== 'openai' || !settings.baseUrl) return settings.provider;
  const url = parseUrl(settings.baseUrl);
  if (!url) return 'openai@invalid-address';
  return url.host === 'api.openai.com' ? 'openai' : `openai@${url.host}`;
};

// { errors: [...], warnings: [...] }. Errors stop a run; warnings are shown but do not.
export const validateSettings = (settings, apiKey) => {
  const errors = [];
  const warnings = [];

  if (!PROVIDERS.includes(settings.provider)) {
    errors.push(`Provider must be one of: ${PROVIDERS.join(', ')} (got "${settings.provider}").`);
  }
  if (!settings.model) errors.push('Set a model name in the Merge Assistant settings.');
  if (settings.provider !== 'ollama' && !apiKey) {
    errors.push(`The ${settings.provider} provider needs an API key.`);
  }

  if (settings.baseUrl) {
    const url = parseUrl(settings.baseUrl);
    if (!url || !['http:', 'https:'].includes(url.protocol)) {
      errors.push(`The base URL "${settings.baseUrl}" is not a valid http(s) URL.`);
    } else if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
      warnings.push(`The base URL ${url.host} is not encrypted (http) and is not on this machine; code and your API key would be sent in clear text.`);
    }
  }

  if (settings.useTools) {
    warnings.push('Tool calling is on: the model may read other files in the repository, and what it reads is sent to the model provider.');
  }
  return { errors, warnings };
};
