// Mesh health report: what 3D Builder flags as "invalidly defined" objects.
import { type MeshData, bounds, signedVolume, size, triArea } from '../core/mesh-data';
import { boundaryLoops, buildEdges, shells } from './topology';

export interface MeshReport {
  triangles: number;
  vertices: number;
  degenerateFaces: number;
  duplicateFaces: number;
  openEdges: number;
  holes: number;
  nonManifoldEdges: number;
  flippedEdges: number; // edges shared by two faces with the same direction
  shells: number;
  volume: number;
  /** Closed, consistently oriented, 2-manifold and outward facing. */
  ok: boolean;
}

export function areaEpsilon(m: MeshData): number {
  const s = size(bounds(m));
  const d = Math.hypot(s[0], s[1], s[2]) || 1;
  return d * d * 1e-12;
}

export function analyze(m: MeshData): MeshReport {
  const nv = m.positions.length / 3;
  const t = m.indices;
  const nt = t.length / 3;
  const eps = areaEpsilon(m);
  let degenerate = 0;
  const seen = new Set<string>();
  let duplicates = 0;
  for (let f = 0; f < nt; f++) {
    const a = t[f * 3], b = t[f * 3 + 1], c = t[f * 3 + 2];
    if (a === b || b === c || a === c || triArea(m.positions, a, b, c) <= eps) degenerate++;
    const key = [a, b, c].sort((x, y) => x - y).join(',');
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }
  const edges = buildEdges(t, nv);
  let open = 0, nonManifold = 0, flipped = 0;
  for (const e of edges.values()) {
    if (e.faces.length === 1) open++;
    else if (e.faces.length > 2) nonManifold++;
    else if (e.forward === 2 || e.backward === 2) flipped++;
  }
  const holes = open ? boundaryLoops(t, nv, edges).length : 0;
  const label = shells(t, nv, edges);
  let shellCount = 0;
  for (let f = 0; f < nt; f++) if (label[f] >= shellCount) shellCount = label[f] + 1;
  const volume = signedVolume(m);
  return {
    triangles: nt,
    vertices: nv,
    degenerateFaces: degenerate,
    duplicateFaces: duplicates,
    openEdges: open,
    holes,
    nonManifoldEdges: nonManifold,
    flippedEdges: flipped,
    shells: shellCount,
    volume,
    ok: nt > 0 && open === 0 && nonManifold === 0 && flipped === 0 && degenerate === 0 && duplicates === 0 && volume > 0,
  };
}
