// Cake Pay's session (lib/cake_pay/src/services/cake_pay_service.dart: the
// e-mail, user name and token, kept encrypted in the vault like Cake's secure
// storage) and the order records (lib/order/order.dart, Cake's `orders` box).

import { signal } from '@preact/signals';
import { vault } from '../core/vault.ts';
import * as api from './api.ts';
import { orderState, type CakePayOrder } from './models.ts';

const SESSION_KEY = 'cakepay:session';
const ORDERS_KEY = 'orders';

interface Session {
  email?: string;
  username?: string;
  token?: string;
}

const session = (): Promise<Session> => vault.get<Session>(SESSION_KEY).then((s) => s ?? {});
const saveSession = (s: Session) => vault.put(SESSION_KEY, s);

/** the signed-in e-mail, for the cards page's avatar (null when signed out) */
export const cakePayUser = signal<string | null>(null);

export async function refreshCakePayUser(): Promise<boolean> {
  const logged = await isLogged();
  cakePayUser.value = logged ? (await session()).email ?? null : null;
  return logged;
}

/** isLogged: a user name and a token */
export async function isLogged(): Promise<boolean> {
  const s = await session();
  return !!s.username && !!s.token;
}

export async function userEmail(): Promise<string | undefined> {
  return (await session()).email;
}

/** logIn: asks for a code by e-mail */
export async function logIn(email: string): Promise<void> {
  const name = await api.authenticateUser(email);
  await saveSession({ ...(await session()), email: name, username: name });
}

/** verifyEmail: the code from the e-mail → the token */
export async function verifyEmail(code: string): Promise<void> {
  const s = await session();
  const c = await api.verifyEmail(s.email ?? '', code);
  await saveSession({ ...s, token: c.token, username: c.email });
  await refreshCakePayUser();
}

/** logout: the user name and token go (the e-mail stays); with an e-mail Cake Pay is told too */
export async function logout(email?: string): Promise<void> {
  const s = await session();
  await saveSession({ email: s.email });
  cakePayUser.value = null;
  if (email) await api.logoutUser(email);
}

/** _withUserToken: no token or a 401 signs out */
async function withToken<T>(f: (token: string) => Promise<T>): Promise<T> {
  try {
    const token = (await session()).token ?? '';
    if (!token) throw new api.CakePayUnauthorizedError();
    return await f(token);
  } catch (e) {
    if (e instanceof api.CakePayUnauthorizedError) await logout();
    throw e;
  }
}

export async function createOrder(o: Omit<api.OrderRequest, 'token' | 'userEmail'>): Promise<CakePayOrder> {
  const email = (await session()).email ?? '';
  return withToken((token) => api.createOrder({ ...o, token, userEmail: email }));
}

export const findOrderById = (id: string) => withToken((token) => api.getOrderById(id, token));

// ----------------------------------------------------------------- orders --

/** Order (lib/order/order.dart) of a Cake Pay purchase */
export interface OrderRecord {
  id: string;
  /** TradeState raw */
  stateRaw: string;
  transferId: string;
  /** the coin paid with (BTC, XMR, LTC, ZEC) */
  from?: string;
  /** the card's fiat */
  to?: string;
  createdAt: number;
  amount: string;
  receiveAmount?: string;
  quantity?: string;
  receiveAddress?: string;
  walletId: string;
  /** OrderSourceDescription.order, OrderProviderDescription.cakePay */
  source: 'order';
  provider: 'cakePay';
}

export const orders = signal<OrderRecord[]>([]);
let loaded = false;

const byDate = (list: OrderRecord[]) => [...list].sort((a, b) => b.createdAt - a.createdAt);

export async function loadOrders(): Promise<void> {
  orders.value = byDate((await vault.get<OrderRecord[]>(ORDERS_KEY)) ?? []);
  loaded = true;
  void refreshCakePayUser().catch(() => {});
}

export function unloadOrders(): void {
  orders.value = [];
  cakePayUser.value = null;
  loaded = false;
}

export async function saveOrder(o: OrderRecord): Promise<void> {
  if (!loaded) await loadOrders();
  orders.value = byDate([o, ...orders.value.filter((x) => x.id !== o.id)]);
  await vault.put(ORDERS_KEY, orders.value);
}

/** from a backup: the orders this device does not have yet */
export async function importOrders(list: OrderRecord[]): Promise<void> {
  if (!loaded) await loadOrders();
  const have = new Set(orders.value.map((o) => o.id));
  orders.value = byDate([...orders.value, ...list.filter((o) => o?.id && !have.has(o.id))]);
  await vault.put(ORDERS_KEY, orders.value);
}

/** OrderDetailsViewModel._updateOrder: the order's status (and its cards) from Cake Pay */
export async function refreshOrder(id: string): Promise<{ order: OrderRecord; cards: CakePayOrder['cards'] } | null> {
  const o = orders.value.find((x) => x.id === id);
  if (!o) return null;
  const remote = await findOrderById(id);
  const next = { ...o, stateRaw: orderState(remote.status) };
  await saveOrder(next);
  return { order: next, cards: remote.cards };
}
