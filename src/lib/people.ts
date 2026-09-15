import { get, update, createStore } from "idb-keyval";

/**
 * The people you have named before.
 *
 * Speaker names live inside each report and nowhere else, so without this you
 * retype the same colleague in every meeting, forever. This is the address
 * book that falls out of that work: a plain list of the names you have
 * actually typed, kept on this device. No new Firestore path, so no rules
 * change; nothing here is authoritative, it only feeds suggestions.
 */
const store = createStore("cheatmeet", "workspace");
const key = (uid: string) => `${uid}:people`;
const LIMIT = 200;

/** Auto-generated labels are not people and must never become suggestions. */
const PLACEHOLDER = /^(Sprecher|Neue Person) \d+$/;
export const isRealName = (name: string) => {
  const trimmed = name.trim();
  return !!trimmed && !PLACEHOLDER.test(trimmed) && trimmed !== "Unbekannt";
};

const listeners = new Set<() => void>();
export function subscribePeople(onChange: () => void) {
  listeners.add(onChange);
  return () => void listeners.delete(onChange);
}

export const listPeople = async (uid: string): Promise<string[]> =>
  (await get<string[]>(key(uid), store)) || [];

/** Most recently used first, so the names you actually work with stay on top. */
export async function rememberPeople(uid: string, names: string[]) {
  const fresh = [...new Set(names.map((n) => n.trim()))].filter(isRealName);
  if (!fresh.length) return;
  // One transaction: the dashboard, a report save and a calendar match can all
  // be writing at the same moment, and a read-modify-write would lose names.
  await update<string[]>(
    key(uid),
    (existing = []) =>
      [...fresh, ...existing.filter((n) => !fresh.includes(n))].slice(0, LIMIT),
    store,
  );
  for (const listener of listeners) listener();
}
