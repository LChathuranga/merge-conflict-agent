// A stand-in for the network, so tests never reach a real Ollama or a real provider.

export const json = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });

export const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

// Answers by address prefix. A reply may be a response, an Error to throw, or a function that
// gets the number of calls so far to that prefix. Unknown addresses behave like a closed port.
export const network = (routes) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    for (const [prefix, reply] of Object.entries(routes)) {
      if (!String(url).startsWith(prefix)) continue;
      const answer = typeof reply === 'function' ? await reply(calls.filter((c) => c.url.startsWith(prefix)).length) : reply;
      if (answer instanceof Error) throw answer;
      return answer;
    }
    throw refused();
  };
  fetchImpl.calls = calls;
  return fetchImpl;
};

export const OLLAMA_TAGS = 'http://localhost:11434/api/tags';
export const ollamaWith = (...names) => json({ models: names.map((name) => ({ name, size: 4_900_000_000 })) });

// A local Ollama that is running and has the default model, for tests that are about something else.
export const ollamaRunning = () => network({ [OLLAMA_TAGS]: ollamaWith('llama3.1:latest') });
