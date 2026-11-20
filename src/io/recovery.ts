// Session recovery, as 3D Builder does it: while the scene has unsaved changes, a copy of it is
// kept per window (here: one IndexedDB entry per browser tab). At start-up, a copy whose tab is no
// longer open (its Web Lock is not held) is offered: Continuer reloads it, Ignorer throws it away.
// 3D Builder writes a 3MF; here the copy is the scene's own arrays (stored by structured clone,
// no XML nor zip on the main thread). Copies written by older versions hold a 3MF blob (data).
import type { Material, ModelInfo, Vec3 } from '../core/model';
import type { ObjectTexture } from '../core/texture-data';

/** One object as the scene holds it: mesh in its own frame and its transform. */
export interface RecoveryObject {
  name: string;
  color: string;
  positions: Float32Array;
  indices: Uint32Array;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  faceColors?: Uint32Array;
  /** A Material (older copies: its name). */
  material?: Material | string;
  texture?: ObjectTexture;
  selfIntersections?: number;
}

export interface RecoveryScene {
  info: ModelInfo;
  objects: RecoveryObject[];
}

export interface RecoveryEntry {
  session: string;
  name: string;
  date: number;
  /** Current copies: the scene itself. */
  scene?: RecoveryScene;
  /** Copies from older versions: a 3MF of the scene. */
  data?: Blob;
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

/** Keeps `scene` as this tab's recovery copy (true when written). */
export async function saveRecovery(name: string, scene: RecoveryScene): Promise<boolean> {
  try {
    await run('readwrite', (s) => s.put({ session: recoverySession(), name, date: Date.now(), scene } satisfies RecoveryEntry));
    return true;
  } catch {
    return false; // storage unavailable or full
  }
}

/** Copies left by tabs that are no longer open, newest first. */
export async function orphanRecoveries(): Promise<RecoveryEntry[]> {
  try {
    // Entries neither format can read (damaged, or from an unknown version) are dropped.
    const all = ((await run('readonly', (s) => s.getAll())) as RecoveryEntry[]).filter((e) => {
      if (e && typeof e.session === 'string' && (e.scene?.objects || e.data instanceof Blob)) return true;
      if (e && typeof e.session === 'string') void clearRecovery(e.session);
      return false;
    });
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
