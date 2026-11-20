// Heavy geometry off the main thread: full repair (with wrap), the self-intersection check, and the
// booleans (Fusionner, Définir une intersection, Soustraire) and Creux, so the interface keeps
// responding on large models.
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { booleanPair, hollow, loadManifold } from '../geometry/csg';
import type { BooleanOp } from '../repair/wrap';
import { repairSolid } from '../repair/solid';
import { countSelfIntersections } from '../repair/wrap';
import type { MeshData } from '../core/mesh-data';

void loadManifold(wasmUrl);

export type WorkerRequest =
  | { id: number; op: 'repair'; mesh: MeshData }
  | { id: number; op: 'selfIntersections'; mesh: MeshData }
  | { id: number; op: 'boolean'; mesh: MeshData; other: MeshData; kind: BooleanOp }
  | { id: number; op: 'hollow'; mesh: MeshData; thickness: number };

const reply = (msg: Record<string, unknown>, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
const meshReply = (id: number, mesh: MeshData, extra: Record<string, unknown> = {}) => reply({ id, ok: true, mesh, ...extra }, [mesh.positions.buffer, mesh.indices.buffer]);

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.op === 'repair') {
      const { mesh, log } = await repairSolid(req.mesh);
      meshReply(req.id, mesh, { log });
    } else if (req.op === 'selfIntersections') {
      reply({ id: req.id, ok: true, count: await countSelfIntersections(req.mesh) });
    } else if (req.op === 'boolean') {
      meshReply(req.id, await booleanPair(req.mesh, req.other, req.kind));
    } else {
      meshReply(req.id, await hollow(req.mesh, req.thickness));
    }
  } catch (e) {
    reply({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
