// Simplifier with 3D Builder's behaviour (matched on the face counts it gives). The "Niveau de
// réduction" slider is a number of passes, 0 to 6; each preview starts again from the original object.
//
// Pass: tolerance t = 0.001, then t += t while t < 0.05, each step on the same mesh, until the faces
// fall under 75 % of the pass start; a pass that ends at 99 % or more stops the passes.
// Step: max error = t × the smallest box dimension; errors reset; up to 20 sweeps, stopping when a
// sweep removes fewer than 0.1 % of the faces present at the step start.
// Sweep: a table of 8 face slots per vertex is built from the faces in corner order; a vertex that
// reaches a 9th face is locked. Vertices are visited in index order (no priority queue); a vertex
// already touched in the sweep, locked, or with faces of different colours is skipped. Neighbours,
// in first-seen order over the slot faces, are tried; the strictly cheapest acceptable one wins:
// - cost = max of |distance from v to the plane of each of its faces with v replaced by u| and
//   |distance from u to the plane of each original face of v|;
// - accumulated errors of v and u plus the cost stay under the maximum;
// - normal test: no face of v turns by more than acos 0.8 (a degenerate face may not become proper);
// - topology test: the merged faces keep every edge at most twice and consistently oriented.
// v is merged into u (u keeps its position), both are marked touched and both add the cost to their
// error. At the end of the sweep, faces with repeated corners are removed by moving the last face
// into their place, which changes the face order for the next sweep.
import type { MeshData } from '../core/mesh-data';

export const SIMPLIFY_MAX_PASSES = 6;
const SLOTS = 8;
const NORMAL_LIMIT = 0.8;

export function simplifyPasses(mesh: MeshData, passes: number, faceColors?: Uint32Array): { mesh: MeshData; faceColors?: Uint32Array } {
  if (passes <= 0) return { mesh, faceColors };
  // 3D Builder works in inches, in single precision.
  let m: MeshData = { positions: Float32Array.from(mesh.positions, (x) => x / 25.4), indices: mesh.indices }, fc = faceColors;
  for (let p = 0; p < passes; p++) {
    const r = onePass(m, fc);
    m = r.mesh;
    fc = r.faceColors;
    if (!r.ok) break;
  }
  return { mesh: { positions: Float32Array.from(m.positions, (x) => x * 25.4), indices: m.indices }, faceColors: fc };
}

/**
 * One tolerance step of the same simplifier, alone: 3D Builder ends "Extruder vers le bas" with it
 * at t = 0.0001 (max error = 1e-4 × the smallest box dimension), which merges away the flat
 * bottom's extra vertices (zero cost) and leaves curved parts as they are.
 */
export function simplifyTolerance(mesh: MeshData, t: number, faceColors?: Uint32Array, lockColors = true, lockOpen = false, degenerateTest = true): { mesh: MeshData; faceColors?: Uint32Array } {
  const pos = Float32Array.from(mesh.positions, (x) => x / 25.4);
  const nv = pos.length / 3;
  const idx = Array.from(mesh.indices);
  const col = faceColors ? Array.from(faceColors) : undefined;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i * 3 + k]); max[k] = Math.max(max[k], pos[i * 3 + k]); }
  const maxErr = t * Math.min(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const err = new Float64Array(nv);
  const lim = (idx.length / 3) * 0.001;
  for (let sweep = 0; sweep < 20; sweep++) if (runSweep(pos, nv, idx, col, err, maxErr, lockColors, lockOpen, degenerateTest) < lim) break;
  const used = new Uint8Array(nv);
  for (const i of idx) used[i] = 1;
  const map = new Int32Array(nv).fill(-1);
  const out: number[] = [];
  for (let i = 0; i < nv; i++) if (used[i]) { map[i] = out.length / 3; out.push(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]); }
  return { mesh: { positions: new Float32Array(out), indices: Uint32Array.from(idx, (i) => map[i]) }, faceColors: col ? Uint32Array.from(col) : undefined };
}

function onePass(mesh: MeshData, faceColors?: Uint32Array): { mesh: MeshData; faceColors?: Uint32Array; ok: boolean } {
  const pos = mesh.positions;
  const nv = pos.length / 3;
  const idx = Array.from(mesh.indices);
  const col = faceColors ? Array.from(faceColors) : undefined;
  const F0 = idx.length / 3;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i * 3 + k]); max[k] = Math.max(max[k], pos[i * 3 + k]); }
  const smallest = Math.min(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const err = new Float64Array(nv);
  let ok = false;
  for (let t = 0.001; t < 0.05; t += t) {
    const maxErr = t * smallest;
    err.fill(0);
    const lim = (idx.length / 3) * 0.001;
    for (let sweep = 0; sweep < 20; sweep++) {
      const removed = runSweep(pos, nv, idx, col, err, maxErr);
      if (removed < lim) break;
    }
    if (idx.length / 3 / F0 < 0.75) { ok = true; break; }
  }
  if (!ok) ok = idx.length / 3 / F0 < 0.99;
  // Compaction: unused vertices dropped, the others kept in index order.
  const used = new Uint8Array(nv);
  for (const i of idx) used[i] = 1;
  const map = new Int32Array(nv).fill(-1);
  const out: number[] = [];
  for (let i = 0; i < nv; i++) if (used[i]) { map[i] = out.length / 3; out.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); }
  return { mesh: { positions: new Float32Array(out), indices: Uint32Array.from(idx, (i) => map[i]) }, faceColors: col ? Uint32Array.from(col) : undefined, ok };
}


function runSweep(pos: ArrayLike<number>, nv: number, idx: number[], col: number[] | undefined, err: Float64Array, maxErr: number, lockColors = true, lockOpen = false, degenerateTest = true): number {
  // degenerateTest: a collapse may not give area back to a face flat to a line.
  const nt = idx.length / 3;
  // Face slots (8 per vertex) and flags: 1 = touched, 2 = locked.
  const slots = new Int32Array(nv * SLOTS).fill(-1);
  const count = new Uint8Array(nv);
  const flag = new Uint8Array(nv);
  for (let f = 0; f < nt; f++) {
    for (let k = 0; k < 3; k++) {
      const v = idx[f * 3 + k];
      if (count[v] < SLOTS) slots[v * SLOTS + count[v]++] = f;
      else flag[v] |= 2;
    }
  }
  // Edge lock (used by Extruder vers le bas): a vertex on an edge whose two
  // slot lists do not share exactly 2 faces (open or non-manifold edge) is not removed this sweep;
  // it can still be the vertex others merge into. With more than 8 faces the lists are cut short,
  // which adds locks as in 3D Builder.
  if (lockOpen) {
    const shared = (p: number, q: number) => {
      let n = 0;
      for (let a = 0; a < count[p]; a++) for (let b = 0; b < count[q]; b++) if (slots[p * SLOTS + a] === slots[q * SLOTS + b]) n++;
      return n;
    };
    for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) {
      const p = idx[f * 3 + k], q = idx[f * 3 + (k + 1) % 3];
      if (shared(p, q) !== 2) { flag[p] |= 4; flag[q] |= 4; }
    }
  }
  // Hot paths, written without temporary arrays (same arithmetic as the readable versions).
  const facesOf = (v: number) => { const r: number[] = []; for (let s2 = 0; s2 < count[v]; s2++) r.push(slots[v * SLOTS + s2]); return r; };
  /** |distance from point p to the plane of (a, b, c)|, n = (a − b) × (a − c); 0 for a zero normal. */
  const planeDist = (ia: number, ib: number, ic: number, ip: number) => {
    const ax = pos[ia * 3], ay = pos[ia * 3 + 1], az = pos[ia * 3 + 2];
    const e1x = ax - pos[ib * 3], e1y = ay - pos[ib * 3 + 1], e1z = az - pos[ib * 3 + 2];
    const e2x = ax - pos[ic * 3], e2y = ay - pos[ic * 3 + 1], e2z = az - pos[ic * 3 + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 0)) return 0;
    return Math.abs((nx * (pos[ip * 3] - ax) + ny * (pos[ip * 3 + 1] - ay) + nz * (pos[ip * 3 + 2] - az)) / l);
  };
  const cost = (v: number, u: number, vf: number[]) => {
    let c = 0;
    for (const f of vf) {
      const i0 = idx[f * 3], i1 = idx[f * 3 + 1], i2 = idx[f * 3 + 2];
      c = Math.max(c, planeDist(i0 === v ? u : i0, i1 === v ? u : i1, i2 === v ? u : i2, v));
      c = Math.max(c, planeDist(i0, i1, i2, u));
    }
    return c;
  };
  // Edges e1 = P0 − P1, e2 = P0 − P2 and normal n = e1 × e2 of a face, into a scratch array.
  const E = new Float64Array(10);
  const edgesInto = (o: number, i0: number, i1: number, i2: number) => {
    const ax = pos[i0 * 3], ay = pos[i0 * 3 + 1], az = pos[i0 * 3 + 2];
    const e1x = ax - pos[i1 * 3], e1y = ay - pos[i1 * 3 + 1], e1z = az - pos[i1 * 3 + 2];
    const e2x = ax - pos[i2 * 3], e2y = ay - pos[i2 * 3 + 1], e2z = az - pos[i2 * 3 + 2];
    const l1 = Math.hypot(e1x, e1y, e1z), l2 = Math.hypot(e2x, e2y, e2z);
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    // In single precision, as 3D Builder: a face whose cosine rounds to 1.0f counts as degenerate.
    const f = Math.fround; E[o] = f(f(l1) * f(l2)); E[o + 1] = f(f(f(e1x * e2x) + f(e1y * e2y)) + f(e1z * e2z)); // |e1||e2| and e1·e2
    E[o + 2] = nx; E[o + 3] = ny; E[o + 4] = nz;
  };
  const degenerateAt = (o: number) => !(E[o] > 0) || Math.fround(Math.abs(E[o + 1]) / E[o]) >= 1;
  /** true = reject */
  const normalTest = (v: number, u: number, vf: number[]) => {
    for (const f of vf) {
      const i0 = idx[f * 3], i1 = idx[f * 3 + 1], i2 = idx[f * 3 + 2];
      const n0 = i0 === v ? u : i0, n1 = i1 === v ? u : i1, n2 = i2 === v ? u : i2;
      if (n0 === n1 || n1 === n2 || n0 === n2) continue;
      edgesInto(0, i0, i1, i2);
      edgesInto(5, n0, n1, n2);
      if (degenerateTest && degenerateAt(0)) {
        if (!degenerateAt(5)) return true;
      } else {
        const lo = Math.hypot(E[2], E[3], E[4]);
        const ln = Math.hypot(E[7], E[8], E[9]);
        const ll = ln * lo;
        if (ll > 0 && !((E[7] * E[2] + E[8] * E[3] + E[9] * E[4]) / ll >= NORMAL_LIMIT)) return true;
      }
    }
    return false;
  };
  /** true = accept: the merged faces keep every edge at most twice, in opposite directions. */
  const ek: number[] = [], ed: number[] = [], en: number[] = [];
  const topology = (v: number, u: number) => {
    ek.length = ed.length = en.length = 0;
    const fv = facesOf(v), fu = facesOf(u);
    const doFace = (f: number) => {
      let c0 = idx[f * 3], c1 = idx[f * 3 + 1], c2 = idx[f * 3 + 2];
      if (c0 === u) c0 = v; if (c1 === u) c1 = v; if (c2 === u) c2 = v;
      if (c0 === c1 || c1 === c2 || c0 === c2) return true;
      for (let k = 0; k < 3; k++) {
        const a2 = k === 0 ? c0 : k === 1 ? c1 : c2, b2 = k === 0 ? c1 : k === 1 ? c2 : c0;
        const key = Math.min(a2, b2) * nv + Math.max(a2, b2);
        const dir = a2 < b2 ? 1 : 2;
        const at = ek.indexOf(key);
        if (at < 0) { ek.push(key); ed.push(dir); en.push(1); continue; }
        if (ed[at] === dir || en[at] >= 2) return false;
        en[at]++;
      }
      return true;
    };
    for (const f of fv) if (!doFace(f)) return false;
    for (const f of fu) if (!fv.includes(f) && !doFace(f)) return false;
    return true;
  };

  for (let v = 0; v < nv; v++) {
    if (flag[v] & 7 || count[v] === 0) continue;
    const vf = facesOf(v);
    if (lockColors && col && vf.some((f) => col[f] !== col[vf[0]])) continue;
    // Neighbours in first-seen order over the slot faces.
    const nbr: number[] = [];
    for (const f of vf) for (let k = 0; k < 3; k++) { const w = idx[f * 3 + k]; if (w !== v && !nbr.includes(w)) nbr.push(w); }
    let best = Infinity, bestU = -1;
    for (const u of nbr) {
      if (flag[u] & 3) continue;
      const c = cost(v, u, vf);
      if (c >= best) continue;
      if (maxErr <= c + err[v] || maxErr <= c + err[u]) continue;
      if (normalTest(v, u, vf) || !topology(v, u)) continue;
      best = c;
      bestU = u;
    }
    if (bestU < 0) continue;
    for (const f of vf) for (let k = 0; k < 3; k++) if (idx[f * 3 + k] === v) idx[f * 3 + k] = bestU;
    flag[v] |= 1;
    flag[bestU] |= 1;
    err[v] += best;
    err[bestU] += best;
  }
  // Faces with repeated corners removed, the last face taking each one's place.
  let removed = 0;
  let n = nt;
  for (let f = 0; f < n;) {
    const a = idx[f * 3], b = idx[f * 3 + 1], c = idx[f * 3 + 2];
    if (a === b || b === c || a === c) {
      n--;
      if (f !== n) {
        idx[f * 3] = idx[n * 3]; idx[f * 3 + 1] = idx[n * 3 + 1]; idx[f * 3 + 2] = idx[n * 3 + 2];
        if (col) col[f] = col[n];
      }
      removed++;
    } else f++;
  }
  idx.length = n * 3;
  if (col) col.length = n;
  return removed;
}
