// Cancellation helpers shared by the orchestrator, agents, tool loop and validation runner.
// An abort must travel up as an abort: never be turned into a "model error", a silent
// fallback, or a disabled feature.

export const createAbortError = (message = 'Cancelled', results = []) =>
  Object.assign(new Error(message), { name: 'AbortError', results });

export const isAbort = (error) =>
  error?.name === 'AbortError' || error?.name === 'APIUserAbortError' || error?.code === 'ABORT_ERR';

export const throwIfAborted = (signal) => {
  if (signal?.aborted) throw createAbortError();
};

// For catch blocks that swallow ordinary failures: let cancellation through, always as an
// AbortError (SDKs use their own abort error classes) so callers handle a single type.
export const rethrowIfAborted = (error, signal) => {
  if (!signal?.aborted && !isAbort(error)) return;
  throw error?.name === 'AbortError' ? error : createAbortError();
};

// Settles with `promise`, or rejects as soon as the signal aborts (for waits that no one else
// would end, such as a user prompt).
export const raceAbort = (promise, signal) => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
};
