// Polyfills for older browsers (e.g. Safari < 16 / 17.4). Loaded before
// anything else, because tor-js uses AbortSignal.timeout internally.

const AS = AbortSignal as unknown as {
  timeout?: (ms: number) => AbortSignal;
  any?: (signals: AbortSignal[]) => AbortSignal;
};

if (typeof AS.timeout !== 'function') {
  AS.timeout = (ms: number) => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
    return ac.signal;
  };
}

if (typeof AS.any !== 'function') {
  AS.any = (signals: AbortSignal[]) => {
    const ac = new AbortController();
    for (const s of signals) {
      if (s.aborted) {
        ac.abort(s.reason);
        break;
      }
      s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
    }
    return ac.signal;
  };
}

export {};
