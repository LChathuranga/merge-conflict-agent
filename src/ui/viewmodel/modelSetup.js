// Pure: what the "Set Up AI Model" wizard offers and says. Nothing here touches the editor or
// the network, so the wording, the ranking and the error explanations are all tested directly.

import { dataDestination, validateSettings } from './settings.js';
import { ollamaOrigin } from '../../llm/models.js';

export const PROVIDER_CHOICES = [
  {
    id: 'ollama',
    label: 'Ollama (runs on your computer)',
    description: 'free, and your code never leaves this machine',
  },
  {
    id: 'openai',
    label: 'OpenAI (GPT)',
    description: 'needs an API key; conflicting code is sent to OpenAI',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    description: 'needs an API key; conflicting code is sent to Anthropic',
  },
  {
    id: 'compatible',
    label: 'Another OpenAI-compatible server',
    description: 'LM Studio, Groq, a company gateway: you give its address',
  },
];

// Models people can type when the provider cannot list them. These are suggestions, not a promise
// that an account has access to them.
export const FALLBACK_MODELS = {
  openai: ['gpt-4o-mini', 'gpt-4o'],
  anthropic: ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-5-5'],
};

const NOT_CHAT = /(embed|tts|whisper|audio|realtime|transcribe|image|dall-e|moderation|search|instruct|davinci|babbage)/i;

// Chat-capable OpenAI ids, most useful first. Anything else is still reachable by typing it.
export const rankOpenAIModels = (ids) => {
  const chat = ids.filter((id) => /^(gpt-|o\d|chatgpt-)/i.test(id) && !NOT_CHAT.test(id));
  const preferred = (id) => (/^gpt-4o-mini$/.test(id) ? 0 : /^gpt-4o$/.test(id) ? 1 : 2);
  return [...new Set(chat)].sort((a, b) => preferred(a) - preferred(b) || b.localeCompare(a));
};

export const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
};

// Ollama lists "llama3.1:latest" for a model people call "llama3.1".
export const ollamaHasModel = (installed, wanted) => {
  const target = String(wanted ?? '').trim();
  if (!target) return false;
  return installed.some((m) => m.name === target || m.name === `${target}:latest` || (target.endsWith(':latest') && m.name === target.slice(0, -7)));
};

// What to store for a typed Ollama address. The default address is stored as "" (use the built-in
// default); any other is stored in the form the client needs, with /v1 on the end.
export const ollamaBaseUrl = (address) => {
  const origin = ollamaOrigin(String(address ?? '').trim() || undefined);
  return origin === ollamaOrigin('') ? '' : `${origin}/v1`;
};

const SAFE_MODEL = /^[A-Za-z0-9][\w.:/-]*$/;
export const isSafeModelName = (name) => typeof name === 'string' && name.length <= 120 && SAFE_MODEL.test(name);

// The command to copy; refuses names that could do anything but name a model.
export const pullCommand = (model) => (isSafeModelName(model) ? `ollama pull ${model}` : null);

const PROVIDER_NAME = { ollama: 'Ollama', openai: 'OpenAI', anthropic: 'Claude (Anthropic)' };

const hostOf = (baseUrl) => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
};

// "Ollama - llama3.1", "OpenAI - gpt-4o-mini", "LM Studio-style server localhost:1234 - my-model"
export const describeModel = (settings) => {
  const model = settings.model || 'no model chosen';
  if (settings.provider === 'openai' && settings.baseUrl) return `OpenAI-compatible server (${hostOf(settings.baseUrl)}) - ${model}`;
  return `${PROVIDER_NAME[settings.provider] ?? settings.provider} - ${model}`;
};

// Null when the settings are usable, else one plain sentence about what is missing.
export const modelProblem = (settings, apiKey) => {
  const { errors } = validateSettings(settings, apiKey);
  return errors[0] ?? null;
};

// What to tell the user, and what to offer, for a failed model list or test request.
// action: 'start-ollama' | 'pull-model' | 'check-key' | 'check-address' | 'check-model' | 'wait-and-retry' | 'billing' | null
export const explainModelError = (error, { provider, model, baseUrl } = {}) => {
  const status = error?.status ?? error?.cause?.status;
  const code = error?.code ?? error?.cause?.code;
  const name = error?.name ?? '';
  const text = String(error?.message ?? '');
  const where = provider === 'ollama' ? ollamaOrigin(baseUrl) : baseUrl ? hostOf(baseUrl) : PROVIDER_NAME[provider] ?? 'the server';
  const label = PROVIDER_NAME[provider] ?? 'The server';

  if (code === 'unauthorized' || status === 401 || status === 403) {
    return { action: 'check-key', title: `${label} rejected the key`, detail: 'Check that you copied the whole key, that it is for this provider, and that it has not been revoked or expired.' };
  }
  if (code === 'TEST_TIMEOUT' || code === 'timeout' || /Timeout/i.test(name)) {
    return { action: 'wait-and-retry', title: 'No answer yet', detail: `${provider === 'ollama' ? 'A local model can take a minute to load the first time.' : 'The server is slow or unreachable.'} Try again in a moment.` };
  }
  if (status === 404 || /model.*not found|not found.*model|does not exist|unknown model/i.test(text)) {
    return provider === 'ollama'
      ? { action: 'pull-model', title: `Ollama does not have "${model}"`, detail: `Download it first${pullCommand(model) ? ` by running: ${pullCommand(model)}` : ''}, or pick a model you already have.` }
      : { action: 'check-model', title: `${label} does not know a model called "${model}"`, detail: 'Check the spelling, or pick one from the list. Your account may not have access to it.' };
  }
  if (status === 429) {
    return { action: 'billing', title: `${label} is refusing requests`, detail: 'You have hit a rate limit or your account has no credit left. Check the usage and billing page of your account.' };
  }
  if (code === 'unreachable' || name === 'APIConnectionError' || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|connection error|could not connect/i.test(text)) {
    return provider === 'ollama'
      ? { action: 'start-ollama', title: `Ollama is not running at ${where}`, detail: 'Start the Ollama app, or run "ollama serve" in a terminal. If you have not installed it yet, get it from ollama.com. In a remote window (WSL, SSH, container) it must run on that remote machine.' }
      : { action: 'check-address', title: `Could not reach ${where}`, detail: 'Check the address and your network or proxy. A company gateway may need a VPN.' };
  }
  if (code === 'bad-response') {
    return { action: 'check-address', title: `${where} did not answer as expected`, detail: error.message };
  }
  if (code === 'bad-url') return { action: 'check-address', title: 'That address is not valid', detail: error.message };
  if (typeof status === 'number' && status >= 500) {
    return { action: 'wait-and-retry', title: `${label} had a problem (${status})`, detail: 'This is on their side. Try again in a moment.' };
  }
  return { action: null, title: 'The test did not work', detail: text || 'Unknown error.' };
};

// Shown next to the view title, and the one-line hint when something is missing.
export const modelStatus = (settings, apiKey) => {
  const problem = modelProblem(settings, apiKey);
  return {
    ready: problem === null,
    summary: describeModel(settings),
    problem,
    where: dataDestination(settings),
  };
};

// What the wizard tells the user once it has saved a working setup.
export const savedMessage = (settings, ms) => {
  const where = dataDestination(settings);
  const speed = Number.isFinite(ms) ? ` It answered in ${(ms / 1000).toFixed(1)} s.` : '';
  return `Connected to ${describeModel(settings)}.${speed} ${where
    ? `When you resolve conflicts, the conflicting code is sent to ${where}; you will be asked to confirm before the first run.`
    : 'It runs on your machine, so your code stays here.'}`;
};
