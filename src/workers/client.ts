// Main-thread side of the geometry worker; falls back to running in place if workers fail.
import type { MeshData } from '../core/mesh-data';
import { repairSolid, type SolidRepairLog } from '../repair/solid';
import { countSelfIntersections } from '../repair/wrap';

let worker: Worker | null = null;
let failed = false;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (failed) return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (ev) => {
        const { id, ok, error, ...rest } = ev.data;
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        ok ? p.resolve(rest) : p.reject(new Error(error));
      };
      worker.onerror = () => {
        failed = true;
        for (const p of pending.values()) p.reject(new Error('worker'));
        pending.clear();
      };
    } catch {
      failed = true;
      return null;
    }
  }
  return worker;
}

function call<T>(op: string, mesh: MeshData): Promise<T> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error('worker'));
  const id = nextId++;
  // Copies: the caller keeps its mesh (it may be shown or undone).
  const copy = { positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices) };
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ id, op, mesh: copy }, [copy.positions.buffer, copy.indices.buffer]);
  });
}

export async function repairAsync(mesh: MeshData): Promise<{ mesh: MeshData; log: SolidRepairLog }> {
  try {
    return await call<{ mesh: MeshData; log: SolidRepairLog }>('repair', mesh);
  } catch (e) {
    if ((e as Error).message !== 'worker') throw e;
    return repairSolid(mesh);
  }
}

export async function selfIntersectionsAsync(mesh: MeshData): Promise<number> {
  try {
    return (await call<{ count: number }>('selfIntersections', mesh)).count;
  } catch (e) {
    if ((e as Error).message !== 'worker') throw e;
    return countSelfIntersections(mesh);
  }
}
