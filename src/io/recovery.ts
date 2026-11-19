// Session recovery, as 3D Builder does it: while the scene has unsaved changes, a 3MF copy of it is
// kept per window (here: one IndexedDB entry per browser tab). At start-up, a copy whose tab is no
// longer open (its Web Lock is not held) is offered: Continuer reloads it, Ignorer throws it away.

export interface RecoveryEntry {
  session: string;
  name: string;
  date: number;
  data: Blob;
}

const DB = '3dbr-recovery';
const STORE = 'sessions';
const LOCK = '3dbr-session-';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains('scene')) db.deleteObjectStore('scene');
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'session' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest | void): Promise<unknown> {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = f(tx.objectStore(STORE));
    tx.oncomplete = () => { resolve(req ? req.result : undefined); db.close(); };
    tx.onerror = () => { reject(tx.error); db.close(); };
  }));
}

let session = '';

/**
 * This tab's session key (kept across reloads of the tab), held as a Web Lock for the tab's
 * lifetime so that other tabs know its copy is still in use.
 */
export function recoverySession(): string {
  if (session) return session;
  try { session = sessionStorage.getItem('3dbr.session') ?? ''; } catch { /* storage unavailable */ }
  if (!session) {
    session = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem('3dbr.session', session); } catch { /* storage unavailable */ }
  }
  try { void navigator.locks?.request(LOCK + session, () => new Promise<void>(() => {})); } catch { /* no Web Locks */ }
  return session;
}

/** Keeps `data` (a 3MF of the scene) as this tab's recovery copy. */
export async function saveRecovery(name: string, data: Blob): Promise<void> {
  try { await run('readwrite', (s) => s.put({ session: recoverySession(), name, date: Date.now(), data } satisfies RecoveryEntry)); } catch { /* storage unavailable */ }
}

/** Copies left by tabs that are no longer open, newest first. */
export async function orphanRecoveries(): Promise<RecoveryEntry[]> {
  try {
    const all = (await run('readonly', (s) => s.getAll())) as RecoveryEntry[];
    let held = new Set<string>();
    try { held = new Set(((await navigator.locks?.query())?.held ?? []).map((l) => l.name ?? '')); } catch { /* no Web Locks */ }
    const mine = recoverySession();
    return all.filter((e) => e.session === mine || !held.has(LOCK + e.session)).sort((a, b) => b.date - a.date);
  } catch {
    return [];
  }
}

export async function clearRecovery(sessionKey = recoverySession()): Promise<void> {
  try { await run('readwrite', (s) => s.delete(sessionKey)); } catch { /* storage unavailable */ }
}
