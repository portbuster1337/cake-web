// API keys of the swap providers: the official build has its own; here they are
// the user's (Settings → Connections → API keys), and a provider that needs one
// stays out of quoting until it is set.

import { settings } from '../app/settings.ts';

export function apiKey(id: string): string {
  return String(settings.value.apiKeys?.[id] ?? '').trim();
}
