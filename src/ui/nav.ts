// Hash-based navigation with a page stack, mirroring Flutter's Navigator
// (push / pop / pushReplacement / pushAndRemoveUntil) so Cake Wallet's flows
// (Routes.*) map 1:1. Static hosting friendly: no server routes needed.

import { signal } from '@preact/signals';

export interface RouteEntry {
  name: string;
  args?: any;
  key: number;
  /** keep this page mounted while others are pushed over it (a modal with its own state, like the swap) */
  keepAlive?: boolean;
}

let seq = 0;
export const stack = signal<RouteEntry[]>([]);

function syncHash() {
  const top = stack.value[stack.value.length - 1];
  if (typeof location === 'undefined' || !top) return;
  const h = `#${top.name}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}

export const nav = {
  get top(): RouteEntry | undefined {
    return stack.value[stack.value.length - 1];
  },
  push(name: string, args?: any): void {
    stack.value = [...stack.value, { name, args, key: ++seq }];
    syncHash();
  },
  replace(name: string, args?: any): void {
    stack.value = [...stack.value.slice(0, -1), { name, args, key: ++seq }];
    syncHash();
  },
  /** Clear the stack and show only this route (pushNamedAndRemoveUntil(…, (_) => false)). */
  reset(name: string, args?: any): void {
    stack.value = [{ name, args, key: ++seq }];
    syncHash();
  },
  /** Pop routes until `name` is on top (popUntil(ModalRoute.withName(name))). */
  popUntil(name: string): void {
    const i = stack.value.map((r) => r.name).lastIndexOf(name);
    if (i >= 0) stack.value = stack.value.slice(0, i + 1);
    syncHash();
  },
  pushAndRemoveUntil(name: string, untilName: string, args?: any): void {
    const i = stack.value.map((r) => r.name).lastIndexOf(untilName);
    const base = i >= 0 ? stack.value.slice(0, i + 1) : [];
    stack.value = [...base, { name, args, key: ++seq }];
    syncHash();
  },
  pop<T = unknown>(result?: T): void {
    const top = stack.value[stack.value.length - 1];
    if (stack.value.length > 1) stack.value = stack.value.slice(0, -1);
    syncHash();
    const resolver = top?.args?.__resolve as ((v: unknown) => void) | undefined;
    resolver?.(result);
  },
  /** Push a route and wait for the value it pops with (Navigator.pushNamed(...).then). */
  pushForResult<T = unknown>(name: string, args: any = {}): Promise<T | undefined> {
    return new Promise((resolve) => {
      nav.push(name, { ...args, __resolve: resolve });
    });
  },
  canPop(): boolean {
    return stack.value.length > 1;
  },
};

if (typeof window !== 'undefined') {
  // browser back button pops the stack
  window.addEventListener('popstate', () => {
    if (nav.canPop()) nav.pop();
  });
}
