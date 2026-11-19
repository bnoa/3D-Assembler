// Hollowing as 3D Builder does it: the solid is sampled in vertical columns on a fixed 150 × 150
// grid over its XY bounds, each solid interval is eroded in 3D by the wall thickness (8 × 8 probes
// around the cell), and the cavity is rebuilt as one blocky shell of merged column boxes, facing
// inward. The cavity is appended to the original mesh: no boolean operation.
import type { MeshData } from '../core/mesh-data';
import { bounds } from '../core/mesh-data';
import { separateNonManifold } from '../repair/repair';

const GRID = 150;
const PROBES = 8; // u, v = 0..7 across the cell grown by the thickness
const DEDUP = 1e-4;

interface Hit { z: number; down: boolean }

export class HollowError extends Error {}

/** Builds the inward-facing cavity shell, or null when the thickness leaves no cavity. */
export function hollowCavity(mesh: MeshData, t: number): MeshData | null {
  const P = mesh.positions, I = mesh.indices;
  const nt = I.length / 3;
  const b = bounds(mesh);
  const [minX, minY, minZ] = b.min, [maxX, maxY, maxZ] = b.max;
  const cx = (maxX - minX) / GRID, cy = (maxY - minY) / GRID;
  if (!(cx > 0) || !(cy > 0) || !(maxZ > minZ)) return null;
  const H = maxZ - minZ;
  const rayLo = minZ - H, rayHi = maxZ + H;

  // Triangles binned into every cell their XY box overlaps.
  const bins: number[][] = Array.from({ length: GRID * GRID }, () => []);
  const cell = (v: number, lo: number, c: number) => Math.max(0, Math.min(GRID - 1, Math.floor((v - lo) / c)));
  for (let f = 0; f < nt; f++) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const i = I[f * 3 + k] * 3;
      x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]);
      y0 = Math.min(y0, P[i + 1]); y1 = Math.max(y1, P[i + 1]);
    }
    const i0 = cell(x0, minX, cx), i1 = cell(x1, minX, cx), j0 = cell(y0, minY, cy), j1 = cell(y1, minY, cy);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) bins[j * GRID + i].push(f);
  }

  /** Crossings of the vertical line at (x, y) with the surface between z0 and z1, sorted. */
  const cast = (x: number, y: number, z0: number, z1: number): Hit[] => {
    const hits: Hit[] = [];
    for (const f of bins[cell(y, minY, cy) * GRID + cell(x, minX, cx)]) {
      const a = I[f * 3] * 3, bb = I[f * 3 + 1] * 3, c = I[f * 3 + 2] * 3;
      const ax = P[a], ay = P[a + 1], bx = P[bb], by = P[bb + 1], qx = P[c], qy = P[c + 1];
      const det = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax); // = 2 · area · n_z
      if (det === 0) continue;
      const u = ((x - ax) * (qy - ay) - (y - ay) * (qx - ax)) / det;
      const v = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / det;
      if (u < 0 || v < 0 || u + v > 1) continue;
      const z = P[a + 2] + u * (P[bb + 2] - P[a + 2]) + v * (P[c + 2] - P[a + 2]);
      if (z < z0 || z > z1) continue;
      hits.push({ z, down: det < 0 });
    }
    hits.sort((p, q) => p.z - q.z);
    const out: Hit[] = [];
    for (const h of hits) if (!out.length || h.z - out[out.length - 1].z > DEDUP) out.push(h);
    return out;
  };
  /** Solid intervals along a hit list: [z_k, z_k+1] where triangle k faces down. */
  const solids = (hits: Hit[]): [number, number][] => {
    const s: [number, number][] = [];
    for (let k = 0; k + 1 < hits.length; k++) if (hits[k].down) s.push([hits[k].z, hits[k + 1].z]);
    return s;
  };
  const intersect = (A: [number, number][], B: [number, number][]) => {
    const out: [number, number][] = [];
    for (const [a0, a1] of A) for (const [b0, b1] of B) {
      const lo = Math.max(a0, b0), hi = Math.min(a1, b1);
      if (hi > lo) out.push([lo, hi]);
    }
    return out;
  };
  const r2 = (v: number) => Math.round(v * 100) / 100;

  // Eroded intervals per column.
  const cols: [number, number][][] = Array.from({ length: GRID * GRID }, () => []);
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    const X0 = minX + i * cx, Y0 = minY + j * cy;
    const centre = cast(X0 + cx / 2, Y0 + cy / 2, rayLo, rayHi);
    if (centre.length < 2) continue;
    for (const [z0, z1] of solids(centre)) {
      const w0 = z0 - t, w1 = z1 + t;
      let keep: [number, number][] | null = [[w0, w1]];
      for (let pv = 0; pv < PROBES && keep; pv++) for (let pu = 0; pu < PROBES && keep; pu++) {
        const x = X0 - t + (pu * (cx + 2 * t)) / (PROBES - 1);
        const y = Y0 - t + (pv * (cy + 2 * t)) / (PROBES - 1);
        if (x < minX || x > maxX || y < minY || y > maxY) { keep = null; break; }
        const local = cast(x, y, w0, w1);
        let list: [number, number][];
        if (!local.length) {
          const below = cast(x, y, rayLo, w0);
          if (!below.length || !below[below.length - 1].down) { keep = null; break; }
          list = [[w0, w1]];
        } else if (local.length % 2) {
          continue; // odd crossings: this probe is ignored
        } else {
          list = solids(cast(x, y, rayLo, rayHi))
            .filter(([a, c]) => c > w0 && a < w1 && c - a >= t)
            .map(([a, c]) => [Math.max(a, w0), Math.min(c, w1)] as [number, number]);
          if (!list.length) { keep = null; break; }
        }
        keep = intersect(keep, list);
        if (!keep.length) keep = null;
      }
      if (!keep) continue;
      for (const [a, c] of keep) if (c - a > 3 * (t + 0.01)) cols[j * GRID + i].push([r2(a + t), r2(c - t)]);
    }
    cols[j * GRID + i].sort((p, q) => p[0] - q[0]);
  }
  return cavityShell(cols, minX, minY, cx, cy);
}

/**
 * One box per eroded interval, filling its cell; side faces only where the neighbouring column
 * does not cover that height, so the boxes merge into one shell. Normals point into the boxes.
 * Wall strips are split at every height found on their vertical edges: no T-junction.
 */
function cavityShell(cols: [number, number][][], minX: number, minY: number, cx: number, cy: number): MeshData | null {
  const pos: number[] = [];
  const idx: number[] = [];
  const vmap = new Map<string, number>();
  const V = (i: number, j: number, z: number) => {
    const key = `${i},${j},${z}`;
    let v = vmap.get(key);
    if (v === undefined) {
      v = pos.length / 3;
      pos.push(minX + i * cx, minY + j * cy, z);
      vmap.set(key, v);
    }
    return v;
  };
  const col = (i: number, j: number) => (i < 0 || j < 0 || i >= GRID || j >= GRID ? [] : cols[j * GRID + i]);
  // Heights present on the vertical line at grid corner (i, j): ends of the 4 columns around it.
  const breaks = new Map<number, number[]>();
  const breaksAt = (i: number, j: number) => {
    const key = j * (GRID + 1) + i;
    let s = breaks.get(key);
    if (!s) {
      const set = new Set<number>();
      for (const [a, c] of [...col(i - 1, j - 1), ...col(i, j - 1), ...col(i - 1, j), ...col(i, j)]) { set.add(a); set.add(c); }
      s = [...set].sort((p, q) => p - q);
      breaks.set(key, s);
    }
    return s;
  };
  const EPS = 1e-5;
  /** Parts of [a, c] not covered by the intervals of `other`. */
  const uncovered = (a: number, c: number, other: [number, number][]) => {
    let parts: [number, number][] = [[a, c]];
    for (const [o0, o1] of other) {
      const next: [number, number][] = [];
      for (const [p0, p1] of parts) {
        if (o1 <= p0 + EPS || o0 >= p1 - EPS) { next.push([p0, p1]); continue; }
        if (o0 > p0 + EPS) next.push([p0, o0]);
        if (o1 < p1 - EPS) next.push([o1, p1]);
      }
      parts = next;
    }
    return parts;
  };
  /** Vertical strip from corner A (ia, ja) to corner B (ib, jb), heights z0..z1. */
  const strip = (ia: number, ja: number, ib: number, jb: number, z0: number, z1: number) => {
    const L = breaksAt(ia, ja).filter((z) => z >= z0 && z <= z1);
    const R = breaksAt(ib, jb).filter((z) => z >= z0 && z <= z1);
    // Zipper triangulation between the two edges, bottom to top.
    let l = 0, r = 0;
    while (l < L.length - 1 || r < R.length - 1) {
      const advR = l >= L.length - 1 || (r < R.length - 1 && R[r + 1] <= L[l + 1]);
      if (advR) {
        idx.push(V(ia, ja, L[l]), V(ib, jb, R[r]), V(ib, jb, R[r + 1]));
        r++;
      } else {
        idx.push(V(ia, ja, L[l]), V(ib, jb, R[r]), V(ia, ja, L[l + 1]));
        l++;
      }
    }
  };
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    for (const [a, c] of cols[j * GRID + i]) {
      // Bottom (normal +z, into the box) and top (normal -z).
      idx.push(V(i, j, a), V(i + 1, j, a), V(i + 1, j + 1, a), V(i, j, a), V(i + 1, j + 1, a), V(i, j + 1, a));
      idx.push(V(i, j, c), V(i + 1, j + 1, c), V(i + 1, j, c), V(i, j, c), V(i, j + 1, c), V(i + 1, j + 1, c));
      // Sides, each wound so the normal points into the box.
      // A strip's normal is (B − A) × z.
      for (const [z0, z1] of uncovered(a, c, col(i - 1, j))) strip(i, j, i, j + 1, z0, z1); // -X face, normal +x
      for (const [z0, z1] of uncovered(a, c, col(i + 1, j))) strip(i + 1, j + 1, i + 1, j, z0, z1); // +X face, normal -x
      for (const [z0, z1] of uncovered(a, c, col(i, j - 1))) strip(i + 1, j, i, j, z0, z1); // -Y face, normal +y
      for (const [z0, z1] of uncovered(a, c, col(i, j + 1))) strip(i, j + 1, i + 1, j + 1, z0, z1); // +Y face, normal -y
    }
  }
  if (!idx.length) return null;
  // Boxes touching along a single edge share it with four faces: separate them, as the export
  // preparation does.
  return separateNonManifold({ positions: new Float32Array(pos), indices: new Uint32Array(idx) });
}

/** 3D Builder's hollow: the original surface plus the inward cavity shell, concatenated. */
export function hollowMesh(mesh: MeshData, thickness: number): MeshData {
  const cav = hollowCavity(mesh, thickness);
  if (!cav) throw new HollowError('Épaisseur trop grande pour cet objet : aucune cavité possible.');
  const n = mesh.positions.length / 3;
  const pos = new Float32Array(mesh.positions.length + cav.positions.length);
  pos.set(mesh.positions);
  pos.set(cav.positions, mesh.positions.length);
  const idx = new Uint32Array(mesh.indices.length + cav.indices.length);
  idx.set(mesh.indices);
  for (let k = 0; k < cav.indices.length; k++) idx[mesh.indices.length + k] = cav.indices[k] + n;
  return { positions: pos, indices: idx };
}
