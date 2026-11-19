// Face painting as in 3D Builder: whole triangles, region grown from the clicked face by angles.
import type { MeshData } from '../core/mesh-data';
import { buildEdges, edgeKey } from '../repair/topology';

const adjacencyCache = new WeakMap<MeshData, Int32Array>();

/** Neighbour face across each edge of each face (-1 if none or non-manifold). */
function adjacency(m: MeshData): Int32Array {
  let adj = adjacencyCache.get(m);
  if (adj) return adj;
  const nv = m.positions.length / 3;
  const nt = m.indices.length / 3;
  const edges = buildEdges(m.indices, nv);
  adj = new Int32Array(nt * 3).fill(-1);
  for (let f = 0; f < nt; f++) {
    for (let k = 0; k < 3; k++) {
      const e = edges.get(edgeKey(m.indices[f * 3 + k], m.indices[f * 3 + ((k + 1) % 3)], nv));
      if (e && e.faces.length === 2) adj[f * 3 + k] = e.faces[0] === f ? e.faces[1] : e.faces[0];
    }
  }
  adjacencyCache.set(m, adj);
  return adj;
}

/** Unit normal, or null for a degenerate face. */
function faceNormal(m: MeshData, f: number): [number, number, number] | null {
  const p = m.positions, t = m.indices;
  const a = t[f * 3] * 3, b = t[f * 3 + 1] * 3, c = t[f * 3 + 2] * 3;
  const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  return l > 1e-12 ? [nx / l, ny / l, nz / l] : null;
}

/** Angle between two unit normals in whole milliradians, as 3D Builder compares them. */
const mrad = (a: number[], b: number[]) => Math.trunc(Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 1000);

/**
 * 3D Builder's paint region: coverage (0-100 %) gives T = coverage % × π, in milliradians; from the
 * clicked face the region grows across shared edges to every neighbour whose normal is within
 * T/2 of the face it is reached from and within T of the clicked face. Whole triangles only.
 * Two 3D Builder oversights are corrected: at 100 % it still stops at creases sharper than 90°
 * (3D Assembler: the whole connected part), and a degenerate triangle counts as 0° and lets the region
 * leak (3D Assembler: it takes the normal of the face it is reached from).
 */
export function paintRegion(m: MeshData, seed: number, coveragePct: number): number[] {
  const adj = adjacency(m);
  const cov = Math.max(0, Math.min(100, coveragePct));
  const T = Math.trunc(cov * 0.01 * Math.PI * 1000);
  const nt = m.indices.length / 3;
  const normals: ([number, number, number] | null)[] = new Array(nt);
  const nrm = (f: number) => (normals[f] === undefined ? (normals[f] = faceNormal(m, f)) : normals[f]);
  const n0 = nrm(seed) ?? [0, 0, 1];
  const seen = new Uint8Array(nt);
  const out = [seed];
  const used: (number[])[] = [n0];
  seen[seed] = 1;
  for (let i = 0; i < out.length; i++) {
    const f = out[i], nf = used[i];
    for (let k = 0; k < 3; k++) {
      const g = adj[f * 3 + k];
      if (g < 0 || seen[g]) continue;
      const ng = nrm(g) ?? nf;
      if (cov < 100 && (mrad(nf, ng) > 0.5 * T || mrad(n0, ng) > T)) continue;
      seen[g] = 1;
      out.push(g);
      used.push(ng);
    }
  }
  return out;
}

export const hexToInt = (hex: string) => parseInt(hex.replace('#', '').slice(0, 6), 16);
export const intToHex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
