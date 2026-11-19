// Face colours through the repair. 3D Builder's repair keeps colours and materials: welded,
// re-oriented or split faces keep theirs, a kept duplicate keeps its own, and the Wrap's output
// faces are pieces of the input faces. Every repaired face lies on an input face (up to the
// stitching tolerance), so it takes the colour of the input face nearest to its centroid.
import type { MeshData } from '../core/mesh-data';

type V = [number, number, number];

function closestOnTriangle(p: V, a: V, b: V, c: V): number {
  // Ericson, Real-Time Collision Detection, 5.1.5 (squared distance returned).
  const sub = (x: V, y: V): V => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
  const dot = (x: V, y: V) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const d2 = (q: V) => { const d = sub(p, q); return dot(d, d); };
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), e1 = dot(ac, ap);
  if (d1 <= 0 && e1 <= 0) return d2(a);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return d2(b);
  const vc = d1 * d4 - d3 * e1;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return d2([a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]]); }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return d2(c);
  const vb = d5 * e1 - d1 * d6;
  if (vb <= 0 && e1 >= 0 && d6 <= 0) { const w = e1 / (e1 - d6); return d2([a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]]); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return d2([b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])]);
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return d2([a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}

/** Colour of each face of `dst` taken from the nearest face of `src`. */
export function transferFaceColors(src: MeshData, colors: Uint32Array, dst: MeshData): Uint32Array {
  const near = nearestFaces(src, dst);
  return Uint32Array.from(near, (g) => colors[g] ?? 0);
}

/** For each face of `dst`, the face of `src` nearest to its centroid. */
export function nearestFaces(src: MeshData, dst: MeshData): Int32Array {
  const P = src.positions, I = src.indices, ns = I.length / 3;
  const out = new Int32Array(dst.indices.length / 3);
  if (!ns) return out;
  const vtx = (i: number): V => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  // Uniform grid of the source faces' boxes.
  const lo: V = [Infinity, Infinity, Infinity], hi: V = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i++) { lo[i % 3] = Math.min(lo[i % 3], P[i]); hi[i % 3] = Math.max(hi[i % 3], P[i]); }
  const ext = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const cell = Math.max(ext / Math.max(1, Math.cbrt(ns) * 2), ext * 1e-4);
  const n = [0, 1, 2].map((k) => Math.max(1, Math.ceil((hi[k] - lo[k]) / cell) + 1));
  const ci = (v: number, k: number) => Math.max(0, Math.min(n[k] - 1, Math.floor((v - lo[k]) / cell)));
  const grid = new Map<number, number[]>();
  const key = (x: number, y: number, z: number) => (z * n[1] + y) * n[0] + x;
  for (let f = 0; f < ns; f++) {
    const t = [vtx(I[f * 3]), vtx(I[f * 3 + 1]), vtx(I[f * 3 + 2])];
    const a = [0, 1, 2].map((k) => ci(Math.min(t[0][k], t[1][k], t[2][k]), k));
    const b = [0, 1, 2].map((k) => ci(Math.max(t[0][k], t[1][k], t[2][k]), k));
    for (let z = a[2]; z <= b[2]; z++) for (let y = a[1]; y <= b[1]; y++) for (let x = a[0]; x <= b[0]; x++) {
      const kk = key(x, y, z);
      const l = grid.get(kk);
      if (l) l.push(f); else grid.set(kk, [f]);
    }
  }
  const DP = dst.positions, DI = dst.indices;
  for (let f = 0; f < DI.length / 3; f++) {
    const p: V = [0, 0, 0];
    for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) p[a] += DP[DI[f * 3 + k] * 3 + a] / 3;
    const c = [0, 1, 2].map((k) => ci(p[k], k));
    let best = Infinity, bestF = 0;
    // Rings of cells around the centroid, until no closer face can be found.
    for (let r = 0; r <= Math.max(...n); r++) {
      for (let z = c[2] - r; z <= c[2] + r; z++) for (let y = c[1] - r; y <= c[1] + r; y++) for (let x = c[0] - r; x <= c[0] + r; x++) {
        if (Math.max(Math.abs(x - c[0]), Math.abs(y - c[1]), Math.abs(z - c[2])) !== r) continue;
        if (x < 0 || y < 0 || z < 0 || x >= n[0] || y >= n[1] || z >= n[2]) continue;
        for (const g of grid.get(key(x, y, z)) ?? []) {
          const d = closestOnTriangle(p, vtx(I[g * 3]), vtx(I[g * 3 + 1]), vtx(I[g * 3 + 2]));
          if (d < best) { best = d; bestF = g; }
        }
      }
      if (best <= (r * cell) ** 2) break;
    }
    out[f] = bestF;
  }
  return out;
}
