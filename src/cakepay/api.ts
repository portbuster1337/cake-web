// Cake Pay API (lib/cake_pay/src/services/cake_pay_api.dart) over Tor. Cake
// sends its app's API key; the marketplace and the e-mail login answer
// without one, so this build sends the user's key only if one is set.

import { exFetch, tryJson, type ExResponse } from '../exchange/net.ts';
import { apiKey } from '../exchange/keys.ts';
import { FIAT_CURRENCIES } from '../app/prices.ts';
import { parseOrder, parseVendor, type CakePayOrder, type CakePayVendor } from './models.ts';

const BASE = 'https://api-prod.cakepay.com';
const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

export class CakePayError extends Error {}
/** CakePayUnauthorizedException: a 401, or no user token */
export class CakePayUnauthorizedError extends CakePayError {
  constructor() {
    super('Unauthorized');
  }
}

function keyHeaders(extra: Record<string, string> = JSON_HEADERS): Record<string, string> {
  const k = apiKey('cakepay');
  return k ? { ...extra, Authorization: `Api-Key ${k}` } : { ...extra };
}

const post = (path: string, body: unknown, headers: Record<string, string>, purpose: string, retries = 1): Promise<ExResponse> => exFetch(`${BASE}${path}`, { body, headers, scope: 'cakepay', retries, purpose });

/** authenticateUser: an e-mail with a one-time code; the e-mail Cake Pay knows the user by */
export async function authenticateUser(email: string): Promise<string> {
  try {
    const r = await post('/api/accounts/auth', { email }, keyHeaders(), 'Cake Pay login', 0);
    if (r.status !== 200) throw new CakePayError(`Unexpected http status: ${r.status}`);
    const j = tryJson<any>(r) ?? {};
    if (j.user?.email != null) return String(j.user.email);
    throw new CakePayError(`Failed to authenticate user with error: ${r.text}`);
  } catch (e) {
    throw new CakePayError(`Failed to authenticate user with error: ${(e as Error).message}`);
  }
}

/** verifyEmail: the code → the user's token */
export async function verifyEmail(email: string, code: string): Promise<{ email: string; token: string }> {
  const r = await post('/api/accounts/auth/verify', { email, otp: code }, keyHeaders(), 'Cake Pay code', 0);
  if (r.status !== 200) throw new CakePayError(`Unexpected http status: ${r.status}`);
  const j = tryJson<any>(r) ?? {};
  if (j.error) throw new CakePayError(String(j.error));
  if (j.token) return { token: String(j.token), email: String(j.user?.email ?? email) };
  throw new CakePayError('E-mail verification failed.');
}

/** logoutUser: errors are swallowed */
export async function logoutUser(email: string): Promise<void> {
  try {
    await post('/api/accounts/logout', { email }, keyHeaders(), 'Cake Pay logout', 0);
  } catch { /* ignored */ }
}

export interface VendorQuery {
  page: number;
  countryCode: string;
  search?: string;
  vendorIds?: string[];
  giftCards?: boolean;
  prepaidCards?: boolean;
}

/** getVendors: the type flags are only sent when one of them is off */
export async function getVendors(q: VendorQuery): Promise<CakePayVendor[]> {
  const params: Record<string, string> = { page: String(q.page), country_code: q.countryCode };
  if (q.search) params.search = q.search;
  if (q.vendorIds?.length) params.vendor_ids = q.vendorIds.join(',');
  if (q.giftCards === false || q.prepaidCards === false) {
    params.gift_cards = String(q.giftCards ?? true);
    params.prepaid_cards = String(q.prepaidCards ?? true);
  }
  const r = await exFetch(`${BASE}/api/marketplace/vendors?${new URLSearchParams(params)}`, { headers: keyHeaders({ accept: 'application/json; charset=UTF-8', 'Content-Type': 'application/json; charset=UTF-8' }), scope: 'cakepay', timeoutMs: 45_000, purpose: 'Cake Pay vendors' });
  if (r.status !== 200) throw new CakePayError(`Failed to fetch vendors: statusCode - ${r.status}, queryParams -${JSON.stringify(params)}, response - ${r.text}`);
  const j = tryJson<any>(r);
  if (Array.isArray(j) && !j.length) return [];
  return (Array.isArray(j?.results) ? j.results : []).map((v: any) => parseVendor(v, FIAT_CURRENCIES));
}

function errorMessage(r: ExResponse): string {
  let message = `Server error ${r.status}`;
  const j = tryJson<any>(r);
  if (j !== null) {
    if (Array.isArray(j) && j.length) message = typeof j[0] === 'string' ? j[0] : JSON.stringify(j[0]);
    else if (j && typeof j === 'object' && j.detail != null) message = String(j.detail);
    else message = typeof j === 'string' ? j : JSON.stringify(j);
  }
  return message;
}

export interface OrderRequest {
  cardId: number;
  price: string;
  quantity: number;
  userEmail: string;
  token: string;
  confirmsNoVpn: boolean;
  confirmsVoidedRefund: boolean;
  confirmsTermsAgreed: boolean;
}

/** createOrder: 201 → the order with its payment data */
export async function createOrder(o: OrderRequest): Promise<CakePayOrder> {
  const r = await post('/api/orders/order', { card_id: o.cardId, price: o.price, quantity: o.quantity, user_email: o.userEmail, send_email: true, confirms_no_vpn: o.confirmsNoVpn, confirms_voided_refund: o.confirmsVoidedRefund, confirms_terms_agreed: o.confirmsTermsAgreed }, { ...JSON_HEADERS, Authorization: `Token ${o.token}` }, 'Cake Pay order', 0);
  if (r.status === 401) throw new CakePayUnauthorizedError();
  if (r.status === 201) return parseOrder(r.json());
  throw new CakePayError(errorMessage(r));
}

export async function getOrderById(orderId: string, token: string): Promise<CakePayOrder> {
  const r = await exFetch(`${BASE}/api/orders/order/${encodeURIComponent(orderId)}`, { headers: { ...JSON_HEADERS, Authorization: `Token ${token}` }, scope: 'cakepay', purpose: 'Cake Pay order status' });
  if (r.status === 401) throw new CakePayUnauthorizedError();
  if (r.status !== 200) throw new CakePayError(`Unexpected http status: ${r.status}`);
  return parseOrder(r.json());
}
