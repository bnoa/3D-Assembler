// Face reduction by edge collapse (as offered by the Windows 3D printing API's
// Printing3DModel.TryReduceFacesAsync): edges are collapsed one at a time, cheapest first.
// - Cost of an edge (a, b): the planes of the faces met around both ends (counted as the filter
//   enumerates them: both faces of every edge at a and at b) form a quadric; the new vertex is its
//   optimum (or the midpoint when the quadric is singular); cost = √error + base + penalties.
// - Penalties (dev + 1 each, dev = 10000 by default) for every new edge longer than the edge-length
//   threshold and for every normal turned past 60° (more for each further step), so an edge with
//   any penalty is never collapsed: in practice the target, the length threshold, the normal test
//   and the topology checks decide.
// - Only edges with two faces whose six edges all have two faces are collapsed (borders stay).
// Faces are never recreated, so they keep their colours; nothing protects a colour border.
import type { MeshData } from '../core/mesh-data';

const DEV = 10000; // MaxReductionArea not set by 3D Builder → 10000
const PENALTY = DEV + 1;
const NORMAL_STEPS = [0.5, 0.25, -0.25, -0.75, -0.9, -0.95];

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop(): [number, number] {
    const k = this.k, v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

export function reduceFaces(input: MeshData, targetFaces: number, faceColors?: Uint32Array, maxEdgeLength = 1e5): { mesh: MeshData; faceColors?: Uint32Array } {
  const nv = input.positions.length / 3, nt = input.indices.length / 3;
  const target = Math.max(4, targetFaces);
  if (target >= nt) return { mesh: input, faceColors };
  const P = Float64Array.from(input.positions);
  const T = Int32Array.from(input.indices);
  const alive = new Uint8Array(nt).fill(1);
  const vFaces: Set<number>[] = Array.from({ length: nv }, () => new Set());
  for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) vFaces[T[f * 3 + k]].add(f);
  const len = (a: number, b: number) => Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
  const neighbours = (x: number) => {
    const s = new Set<number>();
    for (const f of vFaces[x]) for (let k = 0; k < 3; k++) s.add(T[f * 3 + k]);
    s.delete(x);
    return s;
  };
  const edgeFaces = (a: number, b: number) => [...vFaces[a]].filter((f) => vFaces[b].has(f));

  // Edge-length threshold. 3D Builder sets only TargetTriangleCount; the options object it creates
  // leaves MaxEdgeLength uninitialised (heap leftovers), so its limit is undefined in practice. 0
  // would mean "auto" = (shortest + longest initial edge) / 2, which stops a sphere almost at
  // once, unlike what 3D Builder does: 3D Assembler uses the largest accepted value, 1e5 (no limit).
  let thr = maxEdgeLength;
  if (!(thr > 0)) {
    let lmin = 1000, lmax = 0;
    for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) {
      const l = len(T[f * 3 + k], T[f * 3 + ((k + 1) % 3)]);
      lmin = Math.min(lmin, l); lmax = Math.max(lmax, l);
    }
    thr = (lmin + lmax) / 2;
  }

  const normal = (a: number, b: number, c: number, pa?: number[]): number[] => {
    const A = pa ?? [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]];
    const ux = P[b * 3] - A[0], uy = P[b * 3 + 1] - A[1], uz = P[b * 3 + 2] - A[2];
    const vx = P[c * 3] - A[0], vy = P[c * 3 + 1] - A[1], vz = P[c * 3 + 2] - A[2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const l = Math.hypot(n[0], n[1], n[2]);
    return l <= 1e-10 ? [0, 0, 0] : [n[0] / l, n[1] / l, n[2] / l];
  };
  /** Normal of face f with vertex `x` moved to `p`. */
  const movedNormal = (f: number, x: number, p: number[]): number[] => {
    const t = [T[f * 3], T[f * 3 + 1], T[f * 3 + 2]];
    const pt = (i: number) => (i === x ? p : [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
    const A = pt(t[0]), B = pt(t[1]), C = pt(t[2]);
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(n[0], n[1], n[2]);
    return l <= 1e-10 ? [0, 0, 0] : [n[0] / l, n[1] / l, n[2] / l];
  };

  /** Cost and new position of collapsing a–b. */
  const cost = (a: number, b: number): { c: number; p: number[] } => {
    const A = [0, 0, 0, 0, 0, 0, 0, 0, 0], bq = [0, 0, 0];
    let cq = 0;
    for (const x of [a, b]) for (const w of neighbours(x)) for (const f of edgeFaces(x, w)) {
      const t = [T[f * 3], T[f * 3 + 1], T[f * 3 + 2]];
      const n = normal(t[0], t[1], t[2]);
      const d = -(n[0] * P[t[0] * 3] + n[1] * P[t[0] * 3 + 1] + n[2] * P[t[0] * 3 + 2]);
      for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) A[i * 3 + j] += n[i] * n[j]; bq[i] += d * n[i]; }
      cq += d * d;
    }
    const det = A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
    let p: number[], base: number;
    if (Math.abs(det) > 0.0005) {
      // v = −A⁻¹ b (Cramer).
      const inv = [
        A[4] * A[8] - A[5] * A[7], A[2] * A[7] - A[1] * A[8], A[1] * A[5] - A[2] * A[4],
        A[5] * A[6] - A[3] * A[8], A[0] * A[8] - A[2] * A[6], A[2] * A[3] - A[0] * A[5],
        A[3] * A[7] - A[4] * A[6], A[1] * A[6] - A[0] * A[7], A[0] * A[4] - A[1] * A[3],
      ].map((x) => x / det);
      p = [0, 1, 2].map((i) => -(inv[i * 3] * bq[0] + inv[i * 3 + 1] * bq[1] + inv[i * 3 + 2] * bq[2]));
      base = 1;
    } else {
      p = [0, 1, 2].map((i) => (P[a * 3 + i] + P[b * 3 + i]) / 2);
      base = len(a, b) / thr;
    }
    let q = cq;
    for (let i = 0; i < 3; i++) { q += 2 * bq[i] * p[i]; for (let j = 0; j < 3; j++) q += p[i] * A[i * 3 + j] * p[j]; }
    let c = Math.sqrt(Math.max(0, q)) + base;
    // Penalties on the faces touching exactly one end.
    for (const x of [a, b]) for (const f of vFaces[x]) {
      if (vFaces[a].has(f) && vFaces[b].has(f)) continue;
      const t = [T[f * 3], T[f * 3 + 1], T[f * 3 + 2]];
      for (const o of t) if (o !== x && Math.hypot(p[0] - P[o * 3], p[1] - P[o * 3 + 1], p[2] - P[o * 3 + 2]) > thr) c += PENALTY;
      const n0 = normal(t[0], t[1], t[2]), n1 = movedNormal(f, x, p);
      const dt = n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2];
      for (const s of NORMAL_STEPS) if (dt < s) c += PENALTY;
    }
    return { c, p };
  };

  // Queue: lazy heap; an entry is valid while its edge's stamp is unchanged.
  const heap = new Heap();
  const stamp = new Map<string, number>();
  const entries: { a: number; b: number; s: number; p: number[]; c: number }[] = [];
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const score = (a: number, b: number) => {
    const k = key(a, b);
    const s = (stamp.get(k) ?? 0) + 1;
    stamp.set(k, s);
    const { c, p } = cost(a, b);
    entries.push({ a, b, s, p, c });
    heap.push(c, entries.length - 1);
  };
  for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) {
    const a = T[f * 3 + k], b = T[f * 3 + ((k + 1) % 3)];
    if (!stamp.has(key(a, b))) score(a, b);
  }

  const manifoldEdge = (x: number, y: number) => edgeFaces(x, y).length === 2;
  let faces = nt;
  while (faces > target && heap.size) {
    const [, idx] = heap.pop();
    const e = entries[idx];
    if (stamp.get(key(e.a, e.b)) !== e.s) continue;
    stamp.set(key(e.a, e.b), e.s + 1); // dropped until re-scored
    const { a, b } = e;
    if (a === b || len(a, b) > thr || Math.abs(e.c) > DEV + 1) continue;
    // Topology checks of the collapse.
    const shared = edgeFaces(a, b);
    if (shared.length !== 2) continue;
    const others = shared.map((f) => [T[f * 3], T[f * 3 + 1], T[f * 3 + 2]].find((v) => v !== a && v !== b)!);
    if (others[0] === others[1]) continue;
    const six = [[a, b], [a, others[0]], [b, others[0]], [a, others[1]], [b, others[1]]];
    if (!six.every(([x, y]) => manifoldEdge(x, y))) continue;
    // Two vertices joined twice afterwards (the filter throws there): skipped.
    const na = neighbours(a), nb = neighbours(b);
    let common = 0;
    for (const x of na) if (nb.has(x)) common++;
    if (common !== 2) continue;
    // Collapse b into a, moved to the new position.
    for (const f of shared) { alive[f] = 0; faces--; for (let k = 0; k < 3; k++) vFaces[T[f * 3 + k]].delete(f); }
    for (const f of vFaces[b]) { for (let k = 0; k < 3; k++) if (T[f * 3 + k] === b) T[f * 3 + k] = a; vFaces[a].add(f); }
    vFaces[b].clear();
    P[a * 3] = e.p[0]; P[a * 3 + 1] = e.p[1]; P[a * 3 + 2] = e.p[2];
    // Re-score the edges taken over from b; the survivor's other edges only if it moved notably.
    const rescore = Math.abs(e.c) > 1.001 ? neighbours(a) : nb;
    for (const x of rescore) if (x !== a && vFaces[a].size && edgeFaces(a, x).length) score(a, x);
  }

  // Compact; faces keep their colours.
  const remap = new Int32Array(nv).fill(-1);
  const pos: number[] = [], idx: number[] = [], col: number[] = [];
  for (let f = 0; f < nt; f++) {
    if (!alive[f]) continue;
    for (let k = 0; k < 3; k++) {
      const v = T[f * 3 + k];
      if (remap[v] < 0) { remap[v] = pos.length / 3; pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); }
      idx.push(remap[v]);
    }
    if (faceColors) col.push(faceColors[f]);
  }
  return { mesh: { positions: new Float32Array(pos), indices: new Uint32Array(idx) }, faceColors: faceColors ? Uint32Array.from(col) : undefined };
}

/** 3D Builder's target: faces × max(0.01, 1 − level), at least 4 and at most the face count. */
export const reductionTarget = (faces: number, level: number) => Math.min(faces, Math.max(4, Math.floor(faces * Math.max(0.01, 1 - level))));
