// Full repair: topological clean-up, then merging of overlapping shells into one solid
// (what 3D Builder's engine does with its boolean "TopBoolean" stage).
import type { MeshData } from '../core/mesh-data';
import { bounds, signedVolume } from '../core/mesh-data';
import { analyze } from './analyze';
import { cleanMesh, repairMesh, type RepairLog, type RepairOptions } from './repair';
import { shells } from './topology';
import { loadManifold, fromManifold } from '../geometry/csg';
import { wrapMesh } from './wrap';

export interface SolidRepairLog extends RepairLog {
  shellsMerged: number;
  /** Intersecting triangle pairs resolved by the wrap. */
  selfIntersections: number;
  /** Intersecting pairs the wrap could not resolve (model kept unwrapped). */
  selfIntersectionsLeft: number;
}

/** Splits a mesh into its connected shells (indices re-based per shell). */
export function splitShells(m: MeshData): MeshData[] {
  const nv = m.positions.length / 3;
  const label = shells(m.indices, nv);
  const groups = new Map<number, number[]>();
  for (let f = 0; f < label.length; f++) {
    const g = groups.get(label[f]);
    if (g) g.push(f);
    else groups.set(label[f], [f]);
  }
  return [...groups.values()].map((faces) => {
    const remap = new Map<number, number>();
    const pos: number[] = [];
    const idx = new Uint32Array(faces.length * 3);
    faces.forEach((f, i) => {
      for (let k = 0; k < 3; k++) {
        const v = m.indices[f * 3 + k];
        let n = remap.get(v);
        if (n === undefined) {
          n = pos.length / 3;
          remap.set(v, n);
          pos.push(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]);
        }
        idx[i * 3 + k] = n;
      }
    });
    return { positions: new Float32Array(pos), indices: idx };
  });
}

function boxesOverlap(a: MeshData, b: MeshData): boolean {
  const ba = bounds(a), bb = bounds(b);
  for (let k = 0; k < 3; k++) if (ba.max[k] < bb.min[k] || bb.max[k] < ba.min[k]) return false;
  return true;
}

export async function repairSolid(input: MeshData, opts: Partial<RepairOptions> = {}): Promise<{ mesh: MeshData; log: SolidRepairLog }> {
  let { mesh, log } = repairMesh(input, opts);
  let selfIntersections = 0;
  // Wrap: rebuild the outer surface when triangles cross each other (within or across shells).
  const wrapped = await wrapMesh(mesh);
  let unresolved = 0;
  if (wrapped && wrapped.mesh.indices.length) {
    const shellsBefore = analyze(mesh).shells;
    const again = repairMesh(wrapped.mesh, opts);
    // Plausibility: the envelope cannot enclose less than half of the largest original part.
    const largest = Math.max(...splitShells(mesh).map((s) => Math.abs(signedVolume(s))));
    const report = analyze(again.mesh);
    if (report.ok && report.volume >= largest * 0.5) {
      mesh = again.mesh;
      selfIntersections = wrapped.intersections;
      log = { ...log, holesClosed: log.holesClosed + again.log.holesClosed };
      // (3D Assembler) Near-coincident layers (folded fins) can come out of one pass still crossing
      // after rounding: wrap again while that helps and stays valid. 3D Builder does one pass.
      for (let pass = 0; pass < 2; pass++) {
        const more = await wrapMesh(mesh);
        if (!more || !more.mesh.indices.length) break;
        const next = repairMesh(more.mesh, opts);
        const r = analyze(next.mesh);
        if (!r.ok || r.volume < largest * 0.5) break;
        mesh = next.mesh;
        log = { ...log, holesClosed: log.holesClosed + next.log.holesClosed };
      }
      return { mesh, log: { ...log, shellsMerged: Math.max(0, shellsBefore - analyze(mesh).shells), selfIntersections, selfIntersectionsLeft: 0 } };
    }
    // The wrap failed (degenerate configuration): never make the model worse, keep it unwrapped.
    unresolved = wrapped.intersections;
  } else if (wrapped) {
    unresolved = wrapped.intersections;
  }
  const result = { mesh, log: { ...log, shellsMerged: 0, selfIntersections, selfIntersectionsLeft: unresolved } };
  const report = analyze(mesh);
  if (!report.ok || report.shells < 2) return result;

  const parts = splitShells(mesh);
  const positive = parts.filter((p) => signedVolume(p) > 0);
  const negative = parts.filter((p) => signedVolume(p) < 0);
  const overlapping = positive.some((p, i) => positive.some((q, j) => j > i && boxesOverlap(p, q)));
  if (!overlapping) return result;

  const wasm = await loadManifold();
  const made: { delete(): void }[] = [];
  const toSolid = (m: MeshData) => {
    const mm = new wasm.Mesh({ numProp: 3, vertProperties: m.positions, triVerts: m.indices });
    mm.merge();
    const s = new wasm.Manifold(mm);
    made.push(s);
    return s;
  };
  try {
    const pos = positive.map(toSolid);
    if (pos.some((s) => s.status() !== 'NoError')) return result;
    let solid = wasm.Manifold.union(pos);
    made.push(solid);
    if (negative.length) {
      // Cavities are stored inward; flip them to subtract them.
      const holes = negative.map((m) => {
        const flipped = new Uint32Array(m.indices);
        for (let i = 0; i < flipped.length; i += 3) [flipped[i + 1], flipped[i + 2]] = [flipped[i + 2], flipped[i + 1]];
        return toSolid({ positions: m.positions, indices: flipped });
      });
      if (holes.every((s) => s.status() === 'NoError')) {
        const cut = wasm.Manifold.union(holes);
        made.push(cut);
        solid = solid.subtract(cut);
        made.push(solid);
      }
    }
    const before = positive.reduce((a, p) => a + signedVolume(p), 0);
    // Shells that only touched (no real overlap) are left as they were.
    if (solid.volume() > before * (1 - 1e-6) && !negative.length) return result;
    result.mesh = cleanMesh(fromManifold(solid), opts);
    const pieces = solid.decompose();
    made.push(...pieces);
    result.log.shellsMerged = parts.length - pieces.length;
    return result;
  } finally {
    for (const s of made) s.delete();
  }
}
