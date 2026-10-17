import { createLLMClient } from './index.js';

const DEFAULT_TIMEOUT_MS = 90_000; // a local model may need a while to load the first time

// Sends one tiny real request through the same client a resolve run would use. No repository
// code is involved. Resolves { ok: true, ms, reply } or rejects with the provider's own error,
// which `explainModelError` turns into advice.
export const testModel = async ({ env, createClient = createLLMClient, timeoutMs = DEFAULT_TIMEOUT_MS, signal }) => {
  const client = createClient(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('timeout'), { code: 'TEST_TIMEOUT' })), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  const started = Date.now();
  try {
    const reply = await client.complete({
      system: 'You are a connection test. Reply with the single word OK.',
      messages: [{ role: 'user', content: 'ping' }],
      signal: controller.signal,
    });
    return { ok: true, ms: Date.now() - started, reply: String(reply ?? '').trim().slice(0, 60) };
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw Object.assign(new Error(`No answer within ${Math.round(timeoutMs / 1000)} seconds.`), { code: 'TEST_TIMEOUT' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
};
