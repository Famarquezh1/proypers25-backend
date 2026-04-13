function createAbortError(message = 'Operation aborted', code = 'OPERATION_ABORTED') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = code;
  return error;
}

function resolveAbortError(signal, fallbackMessage = 'Operation aborted', fallbackCode = 'OPERATION_ABORTED') {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = createAbortError(typeof reason === 'string' ? reason : fallbackMessage, fallbackCode);
  if (reason !== undefined && reason !== null && !(reason instanceof Error)) {
    error.abort_reason = reason;
  }
  return error;
}

function throwIfAborted(signal, fallbackMessage = 'Operation aborted', fallbackCode = 'OPERATION_ABORTED') {
  if (signal?.aborted) {
    throw resolveAbortError(signal, fallbackMessage, fallbackCode);
  }
}

function addAbortListener(signal, listener) {
  if (!signal || typeof listener !== 'function') {
    return () => {};
  }
  if (signal.aborted) {
    queueMicrotask(() => listener(signal.reason));
    return () => {};
  }
  const handler = () => listener(signal.reason);
  signal.addEventListener('abort', handler, { once: true });
  return () => signal.removeEventListener('abort', handler);
}

function raceWithSignal(
  promiseOrFactory,
  signal,
  fallbackMessage = 'Operation aborted',
  fallbackCode = 'OPERATION_ABORTED'
) {
  const taskPromise =
    typeof promiseOrFactory === 'function'
      ? Promise.resolve().then(() => {
          throwIfAborted(signal, fallbackMessage, fallbackCode);
          return promiseOrFactory();
        })
      : Promise.resolve(promiseOrFactory);

  if (!signal) {
    return taskPromise;
  }

  let removeAbortListener = () => {};
  const abortPromise = new Promise((_, reject) => {
    removeAbortListener = addAbortListener(signal, () => {
      removeAbortListener();
      reject(resolveAbortError(signal, fallbackMessage, fallbackCode));
    });
  });

  return Promise.race([taskPromise, abortPromise]).finally(() => {
    removeAbortListener();
  });
}

function registerTaskCancellation(taskContext, details = {}) {
  if (!taskContext || typeof taskContext !== 'object') {
    return;
  }
  taskContext.cancelled_tasks_count = Number(taskContext.cancelled_tasks_count || 0) + 1;
  const stage = details.stage === 'queued' ? 'queued' : 'running';
  if (taskContext.stage !== 'running') {
    taskContext.stage = stage;
  }
  if (!Array.isArray(taskContext.cancelled_tasks)) {
    taskContext.cancelled_tasks = [];
  }
  if (taskContext.cancelled_tasks.length < 20) {
    taskContext.cancelled_tasks.push({
      stage,
      scope: details.scope || 'external',
      call_type: details.call_type || null,
      at: new Date().toISOString()
    });
  }
}

module.exports = {
  addAbortListener,
  createAbortError,
  raceWithSignal,
  registerTaskCancellation,
  resolveAbortError,
  throwIfAborted
};
