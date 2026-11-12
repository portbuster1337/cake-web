// AbortSignal helpers that also work in browsers without AbortSignal.any /
// AbortSignal.timeout (older Safari/Firefox).

export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const ac = new AbortController();
  setTimeout(() => ac.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
  return ac.signal;
}

export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => !!s);
  if (list.length === 1) return list[0];
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn(list);
  const ac = new AbortController();
  for (const s of list) {
    if (s.aborted) {
      ac.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}
