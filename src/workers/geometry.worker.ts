// Heavy geometry off the main thread: full repair (with wrap) and the self-intersection check.
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { loadManifold } from '../geometry/csg';
import { repairSolid } from '../repair/solid';
import { countSelfIntersections } from '../repair/wrap';
import type { MeshData } from '../core/mesh-data';

void loadManifold(wasmUrl);

export type WorkerRequest =
  | { id: number; op: 'repair'; mesh: MeshData }
  | { id: number; op: 'selfIntersections'; mesh: MeshData };

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.op === 'repair') {
      const { mesh, log } = await repairSolid(req.mesh);
      (self as unknown as Worker).postMessage({ id: req.id, ok: true, mesh, log }, [mesh.positions.buffer, mesh.indices.buffer]);
    } else {
      const n = await countSelfIntersections(req.mesh);
      (self as unknown as Worker).postMessage({ id: req.id, ok: true, count: n });
    }
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
