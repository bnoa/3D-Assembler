// Recent files, as 3D Builder's "Récent" list (Ajouter panel and home screen): the last files
// opened or inserted, kept in the browser (IndexedDB) with a thumbnail, newest first.

export interface RecentEntry {
  id: string;
  name: string;
  type: string;
  date: number;
  thumb?: string; // data URL
}

interface Stored extends RecentEntry {
  data: Blob;
}

const DB = '3dbr-recent';
const STORE = 'files';
const MAX = 12;
const MAX_BYTES = 50 * 1024 * 1024;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function all(db: IDBDatabase): Promise<Stored[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as Stored[]).sort((a, b) => b.date - a.date));
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Adds (or refreshes) a file at the top of the list; the oldest entries beyond 12 are dropped. */
export async function addRecent(file: File, thumb?: string): Promise<void> {
  if (file.size > MAX_BYTES) return;
  try {
    const db = await open();
    const id = `${file.name}|${file.size}`;
    const old = await all(db);
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put({ id, name: file.name, type: file.type, date: Date.now(), thumb, data: file } satisfies Stored);
    for (const e of old.filter((e) => e.id !== id).slice(MAX - 1)) store.delete(e.id);
    await done(tx);
  } catch {
    // Storage unavailable (private window, blocked site data): no recent list.
  }
}

export async function listRecent(): Promise<RecentEntry[]> {
  try {
    return (await all(await open())).map(({ id, name, type, date, thumb }) => ({ id, name, type, date, thumb }));
  } catch {
    return [];
  }
}

export async function recentFile(id: string): Promise<File | null> {
  try {
    const db = await open();
    const e = await new Promise<Stored | undefined>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result as Stored | undefined);
      req.onerror = () => reject(req.error);
    });
    return e ? new File([e.data], e.name, { type: e.type }) : null;
  } catch {
    return null;
  }
}
