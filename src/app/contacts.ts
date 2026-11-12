// Address book (lib/entities/contact.dart) — encrypted in the vault.

import { signal } from '@preact/signals';
import { vault } from '../core/vault.ts';

export interface Contact {
  id: string;
  name: string;
  address: string;
  /** CryptoCurrency key */
  currency: string;
  /** resolved alias / profile name */
  displayName?: string;
  lastChange: number;
}

export const contacts = signal<Contact[]>([]);

export async function loadContacts(): Promise<void> {
  contacts.value = (await vault.get<Contact[]>('contacts')) ?? [];
}

async function persist(): Promise<void> {
  await vault.put('contacts', contacts.value);
}

export async function saveContact(c: Omit<Contact, 'id' | 'lastChange'> & { id?: string }): Promise<void> {
  const dup = contacts.value.find((x) => x.name === c.name && x.id !== c.id);
  if (dup) throw new Error('contact_name_exists');
  const rec: Contact = { ...c, id: c.id ?? crypto.randomUUID(), lastChange: Date.now() };
  contacts.value = c.id ? contacts.value.map((x) => (x.id === c.id ? rec : x)) : [...contacts.value, rec];
  await persist();
}

export async function deleteContact(id: string): Promise<void> {
  contacts.value = contacts.value.filter((x) => x.id !== id);
  await persist();
}

export async function reorderContacts(ids: string[]): Promise<void> {
  const byId = new Map(contacts.value.map((c) => [c.id, c]));
  contacts.value = ids.map((id) => byId.get(id)!).filter(Boolean);
  await persist();
}
