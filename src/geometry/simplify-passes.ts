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
// As in 3D Builder, everything is computed in single precision (positions, costs, errors, normal
// tests), in the same evaluation order, on the coordinates as given (millimetres for Simplify):
// neighbours often tie to the last bits, and the winner of a near-tie decides which faces survive.
// The plane distance uses a unit normal and an offset (n·p − n·a), not (p − a)·n / |n|.
import type { MeshData } from '../core/mesh-data';

export const SIMPLIFY_MAX_PASSES = 6;
const SLOTS = 8;
const f = Math.fround;
const NORMAL_LIMIT = f(0.8);
const T_START = f(0.001), T_END = f(0.05), STOP_SWEEPS = f(0.001), PASS_OK = f(0.75), PASS_STOP = f(0.99);

export function simplifyPasses(mesh: MeshData, passes: number, faceColors?: Uint32Array): { mesh: MeshData; faceColors?: Uint32Array } {
  if (passes <= 0) return { mesh, faceColors };
  // On the object's own coordinates in millimetres, in single precision, as 3D Builder.
  let m: MeshData = { positions: Float32Array.from(mesh.positions), indices: mesh.indices }, fc = faceColors;
  for (let p = 0; p < passes; p++) {
    const r = onePass(m, fc);
    m = r.mesh;
    fc = r.faceColors;
    if (!r.ok) break;
  }
  return { mesh: m, faceColors: fc };
}

/**
 * One tolerance step of the same simplifier, alone, on the coordinates as given: 3D Builder ends
 * "Extruder vers le bas" (edge lock on) and image reliefs (colours detached) with it at t = 0.0001
 * (max error = 1e-4 × the smallest box dimension), which merges away flat areas (zero cost) and
 * leaves curved parts as they are. The degenerate-face test is on in every 3D Builder use.
 */
export function simplifyTolerance(mesh: MeshData, t: number, faceColors?: Uint32Array, lockColors = true, lockOpen = false, degenerateTest = true): { mesh: MeshData; faceColors?: Uint32Array } {
  const pos = Float32Array.from(mesh.positions);
  const nv = pos.length / 3;
  const idx = Array.from(mesh.indices);
  const col = faceColors ? Array.from(faceColors) : undefined;
  runStep(pos, nv, idx, col, new Float32Array(nv), f(t * smallestSide(pos)), lockColors, lockOpen, degenerateTest);
  return compact(mesh.positions, nv, idx, col);
}

/** Smallest side of the bounding box, in single precision. */
function smallestSide(pos: Float32Array): number {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
  return Math.min(f(max[0] - min[0]), f(max[1] - min[1]), f(max[2] - min[2]));
}

/** One step: errors reset, up to 20 sweeps until a sweep removes fewer than 0.1 % of the faces. */
function runStep(pos: Float32Array, nv: number, idx: number[], col: number[] | undefined, err: Float32Array, maxErr: number, lockColors = true, lockOpen = false, degenerateTest = true): void {
  err.fill(0);
  const lim = f(f(idx.length / 3) * STOP_SWEEPS);
  for (let sweep = 0; sweep < 20; sweep++) if (runSweep(pos, nv, idx, col, err, maxErr, lockColors, lockOpen, degenerateTest) < lim) break;
}

/** Unused vertices dropped, the others kept in index order. */
function compact(positions: ArrayLike<number>, nv: number, idx: number[], col: number[] | undefined): { mesh: MeshData; faceColors?: Uint32Array } {
  const used = new Uint8Array(nv);
  for (const i of idx) used[i] = 1;
  const map = new Int32Array(nv).fill(-1);
  const out: number[] = [];
  for (let i = 0; i < nv; i++) if (used[i]) { map[i] = out.length / 3; out.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]); }
  return { mesh: { positions: new Float32Array(out), indices: Uint32Array.from(idx, (i) => map[i]) }, faceColors: col ? Uint32Array.from(col) : undefined };
}

function onePass(mesh: MeshData, faceColors?: Uint32Array): { mesh: MeshData; faceColors?: Uint32Array; ok: boolean } {
  const pos = mesh.positions as Float32Array;
  const nv = pos.length / 3;
  const idx = Array.from(mesh.indices);
  const col = faceColors ? Array.from(faceColors) : undefined;
  const F0 = f(idx.length / 3);
  const smallest = smallestSide(pos);
  const err = new Float32Array(nv);
  let ok = false;
  for (let t = T_START; t < T_END; t = f(t + t)) {
    runStep(pos, nv, idx, col, err, f(t * smallest));
    if (f(idx.length / 3 / F0) < PASS_OK) { ok = true; break; }
  }
  if (!ok) ok = f(idx.length / 3 / F0) < PASS_STOP;
  const r = compact(pos, nv, idx, col);
  return { ...r, ok };
}

function runSweep(pos: Float32Array, nv: number, idx: number[], col: number[] | undefined, err: Float32Array, maxErr: number, lockColors = true, lockOpen = false, degenerateTest = true): number {
  // degenerateTest: a collapse may not give area back to a face flat to a line.
  const nt = idx.length / 3;
  // Face slots (8 per vertex) and flags: 1 = touched, 2 = locked.
  const slots = new Int32Array(nv * SLOTS).fill(-1);
  const count = new Uint8Array(nv);
  const flag = new Uint8Array(nv);
  for (let fc = 0; fc < nt; fc++) {
    for (let k = 0; k < 3; k++) {
      const v = idx[fc * 3 + k];
      if (flag[v] & 2) continue;
      if (count[v] < SLOTS) slots[v * SLOTS + count[v]++] = fc;
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
    for (let fc = 0; fc < nt; fc++) for (let k = 0; k < 3; k++) {
      const p = idx[fc * 3 + k], q = idx[fc * 3 + (k + 1) % 3];
      if (shared(p, q) !== 2) { flag[p] |= 4; flag[q] |= 4; }
    }
  }
  const facesOf = (v: number) => { const r: number[] = []; for (let s2 = 0; s2 < count[v]; s2++) r.push(slots[v * SLOTS + s2]); return r; };
  /**
   * |distance from point p to the plane through (a, b, c)|: normal (a − b) × (a − c) made unit
   * (zero when the face is flat to a line), offset −n·a, then n·p + offset.
   */
  const planeDist = (ia: number, ib: number, ic: number, ip: number) => {
    const ax = pos[ia * 3], ay = pos[ia * 3 + 1], az = pos[ia * 3 + 2];
    const e1x = f(ax - pos[ib * 3]), e1y = f(ay - pos[ib * 3 + 1]), e1z = f(az - pos[ib * 3 + 2]);
    const e2x = f(ax - pos[ic * 3]), e2y = f(ay - pos[ic * 3 + 1]), e2z = f(az - pos[ic * 3 + 2]);
    let nx = f(f(e1y * e2z) - f(e1z * e2y)), ny = f(f(e1z * e2x) - f(e1x * e2z)), nz = f(f(e1x * e2y) - f(e1y * e2x));
    const lsq = f(f(f(nx * nx) + f(ny * ny)) + f(nz * nz));
    if (lsq === Infinity) return NaN;
    const l = f(Math.sqrt(lsq));
    if (l === 0) nx = ny = nz = 0;
    else { nx = f(nx / l); ny = f(ny / l); nz = f(nz / l); }
    const d = -f(f(f(nx * ax) + f(ny * ay)) + f(nz * az));
    const px = pos[ip * 3], py = pos[ip * 3 + 1], pz = pos[ip * 3 + 2];
    return Math.abs(f(f(f(ny * py) + d) + f(f(nx * px) + f(nz * pz))));
  };
  /** Max of the plane distances (a NaN distance is passed over). */
  const cost = (v: number, u: number, vf: number[]) => {
    let c = 0;
    for (const fc of vf) {
      const i0 = idx[fc * 3], i1 = idx[fc * 3 + 1], i2 = idx[fc * 3 + 2];
      const d = planeDist(i0 === v ? u : i0, i1 === v ? u : i1, i2 === v ? u : i2, v);
      if (d > c) c = d;
    }
    for (const fc of vf) {
      const d = planeDist(idx[fc * 3], idx[fc * 3 + 1], idx[fc * 3 + 2], u);
      if (d > c) c = d;
    }
    return c;
  };
  // Edges e1 = P0 − P1 and e2 = P0 − P2 of a face, into a scratch array.
  const E = new Float64Array(12);
  const edgesInto = (o: number, i0: number, i1: number, i2: number) => {
    const ax = pos[i0 * 3], ay = pos[i0 * 3 + 1], az = pos[i0 * 3 + 2];
    E[o] = f(ax - pos[i1 * 3]); E[o + 1] = f(ay - pos[i1 * 3 + 1]); E[o + 2] = f(az - pos[i1 * 3 + 2]);
    E[o + 3] = f(ax - pos[i2 * 3]); E[o + 4] = f(ay - pos[i2 * 3 + 1]); E[o + 5] = f(az - pos[i2 * 3 + 2]);
  };
  const len3 = (x: number, y: number, z: number) => f(Math.sqrt(f(f(f(x * x) + f(z * z)) + f(y * y))));
  const dot3 = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => f(f(f(ax * bx) + f(ay * by)) + f(az * bz));
  /** |cos| of the angle between the two edges at o, or −1 when an edge has zero length. */
  const edgeCos = (o: number) => {
    const ll = f(len3(E[o + 3], E[o + 4], E[o + 5]) * len3(E[o], E[o + 1], E[o + 2]));
    if (!(ll > 0)) return -1;
    return Math.abs(f(dot3(E[o + 3], E[o + 4], E[o + 5], E[o], E[o + 1], E[o + 2]) / ll));
  };
  const crossInto = (o: number, r: number[]) => {
    const e1x = E[o], e1y = E[o + 1], e1z = E[o + 2], e2x = E[o + 3], e2y = E[o + 4], e2z = E[o + 5];
    r[0] = f(f(e1y * e2z) - f(e1z * e2y)); r[1] = f(f(e1z * e2x) - f(e1x * e2z)); r[2] = f(f(e1x * e2y) - f(e1y * e2x));
  };
  const nOld = [0, 0, 0], nNew = [0, 0, 0];
  /** true = reject */
  const normalTest = (v: number, u: number, vf: number[]) => {
    for (const fc of vf) {
      const i0 = idx[fc * 3], i1 = idx[fc * 3 + 1], i2 = idx[fc * 3 + 2];
      const n0 = i0 === v ? u : i0, n1 = i1 === v ? u : i1, n2 = i2 === v ? u : i2;
      if (n0 === n1 || n1 === n2 || n0 === n2) continue;
      edgesInto(0, i0, i1, i2);
      edgesInto(6, n0, n1, n2);
      let degenerate = false;
      if (degenerateTest) { const c = edgeCos(0); degenerate = c < 0 || !(1 > c); }
      if (degenerate) {
        // A face flat to a line (|cos| rounds to 1) may not open up again.
        const c = edgeCos(6);
        if (c >= 0 && 1 > c) return true;
      } else {
        crossInto(0, nOld);
        crossInto(6, nNew);
        const ll = f(len3(nNew[0], nNew[1], nNew[2]) * len3(nOld[0], nOld[1], nOld[2]));
        if (ll > 0 && NORMAL_LIMIT > f(dot3(nNew[0], nNew[1], nNew[2], nOld[0], nOld[1], nOld[2]) / ll)) return true;
      }
    }
    return false;
  };
  /** true = accept: the merged faces keep every edge at most twice, in opposite directions. */
  const ek: number[] = [], ed: number[] = [], en: number[] = [];
  const topology = (v: number, u: number) => {
    ek.length = ed.length = en.length = 0;
    const fv = facesOf(v), fu = facesOf(u);
    const doFace = (fc: number) => {
      let c0 = idx[fc * 3], c1 = idx[fc * 3 + 1], c2 = idx[fc * 3 + 2];
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
    for (const fc of fv) if (!doFace(fc)) return false;
    for (const fc of fu) if (!fv.includes(fc) && !doFace(fc)) return false;
    return true;
  };

  for (let v = 0; v < nv; v++) {
    if (flag[v] & 7 || count[v] === 0) continue;
    const vf = facesOf(v);
    if (lockColors && col && vf.some((fc) => col[fc] !== col[vf[0]])) continue;
    // Neighbours in first-seen order over the slot faces.
    const nbr: number[] = [];
    for (const fc of vf) for (let k = 0; k < 3; k++) { const w = idx[fc * 3 + k]; if (w !== v && !nbr.includes(w)) nbr.push(w); }
    let best = Infinity, bestU = -1;
    for (const u of nbr) {
      if (flag[u] & 3) continue;
      const c = cost(v, u, vf);
      if (!(best > c)) continue;
      if (!(maxErr > f(c + err[v])) || !(maxErr > f(c + err[u]))) continue;
      if (normalTest(v, u, vf) || !topology(v, u)) continue;
      best = c;
      bestU = u;
    }
    if (bestU < 0) continue;
    for (const fc of vf) for (let k = 0; k < 3; k++) if (idx[fc * 3 + k] === v) idx[fc * 3 + k] = bestU;
    flag[v] |= 1;
    flag[bestU] |= 1;
    err[v] = f(err[v] + best);
    err[bestU] = f(err[bestU] + best);
  }
  // Faces with repeated corners removed, the last face taking each one's place.
  let removed = 0;
  let n = nt;
  for (let fc = 0; fc < n;) {
    const a = idx[fc * 3], b = idx[fc * 3 + 1], c = idx[fc * 3 + 2];
    if (a === b || b === c || a === c) {
      n--;
      if (fc !== n) {
        idx[fc * 3] = idx[n * 3]; idx[fc * 3 + 1] = idx[n * 3 + 1]; idx[fc * 3 + 2] = idx[n * 3 + 2];
        if (col) col[fc] = col[n];
      }
      removed++;
    } else fc++;
  }
  idx.length = n * 3;
  if (col) col.length = n;
  return removed;
}
