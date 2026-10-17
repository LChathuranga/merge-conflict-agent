// Asking a model provider "which models can I use?". It doubles as a credentials check: a
// rejected key fails here, before any conflict is involved. Pure network code, no editor:
// `fetch` is injectable so tests never go online.
//
// The key is only ever sent in a request header to the address it was typed for, and never
// appears in an error message.

export class ModelListError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ModelListError';
    this.code = code; // 'unreachable' | 'unauthorized' | 'http' | 'bad-response' | 'timeout' | 'bad-url'
    Object.assign(this, details);
  }
}

const DEFAULT_TIMEOUT_MS = 8000;
const OLLAMA_DEFAULT = 'http://localhost:11434';
const OPENAI_DEFAULT = 'https://api.openai.com/v1';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/models?limit=100';
const MAX_MODELS = 200;

const asUrl = (value) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http');
    return url;
  } catch {
    throw new ModelListError('bad-url', `"${value}" is not a valid http or https address.`);
  }
};

// "http://localhost:11434/v1" and "http://localhost:11434/" both mean the same Ollama server.
export const ollamaOrigin = (baseUrl) => {
  if (!baseUrl) return OLLAMA_DEFAULT;
  return asUrl(baseUrl).origin;
};

const request = async (fetchImpl, url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (response.status === 401 || response.status === 403) {
      throw new ModelListError('unauthorized', 'The server rejected the credentials.', { status: response.status });
    }
    if (!response.ok) {
      throw new ModelListError('http', `The server answered ${response.status}.`, { status: response.status });
    }
    try {
      return await response.json();
    } catch {
      throw new ModelListError('bad-response', 'The server did not answer with the expected data. Is this the right address?');
    }
  } catch (error) {
    if (error instanceof ModelListError) throw error;
    if (signal?.aborted) throw error;
    if (controller.signal.aborted) throw new ModelListError('timeout', `No answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    throw new ModelListError('unreachable', 'Could not connect.', { cause: error?.cause?.code ?? error?.code });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
};

const names = (items, pick) => (Array.isArray(items) ? items.map(pick).filter((n) => typeof n === 'string' && n).slice(0, MAX_MODELS) : null);

// [{ name, sizeBytes? }] of the models installed in a local Ollama server.
export const listOllamaModels = async ({ baseUrl, fetch: fetchImpl = fetch, timeoutMs, signal } = {}) => {
  const data = await request(fetchImpl, `${ollamaOrigin(baseUrl)}/api/tags`, { timeoutMs, signal });
  const models = Array.isArray(data?.models) ? data.models : null;
  if (!models) throw new ModelListError('bad-response', 'That server does not look like Ollama.');
  return models
    .filter((m) => typeof m?.name === 'string')
    .map((m) => ({ name: m.name, sizeBytes: typeof m.size === 'number' ? m.size : undefined }))
    .slice(0, MAX_MODELS);
};

// Model ids from an OpenAI-style `/models` endpoint (OpenAI itself, LM Studio, Groq, gateways).
export const listOpenAIModels = async ({ baseUrl = OPENAI_DEFAULT, apiKey, fetch: fetchImpl = fetch, timeoutMs, signal } = {}) => {
  const url = `${asUrl(baseUrl).href.replace(/\/+$/, '')}/models`;
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const data = await request(fetchImpl, url, { headers, timeoutMs, signal });
  const ids = names(data?.data, (m) => m?.id);
  if (!ids) throw new ModelListError('bad-response', 'That server did not return a list of models.');
  return ids.sort();
};

export const listAnthropicModels = async ({ apiKey, fetch: fetchImpl = fetch, timeoutMs, signal } = {}) => {
  const data = await request(fetchImpl, ANTHROPIC_URL, {
    headers: { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' },
    timeoutMs,
    signal,
  });
  const ids = names(data?.data, (m) => m?.id);
  if (!ids) throw new ModelListError('bad-response', 'Anthropic did not return a list of models.');
  return ids;
};
