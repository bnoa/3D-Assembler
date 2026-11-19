// "Wrap": rebuilds the outer surface of a mesh whose triangles intersect each other.
// Same principle as 3D Builder's engine: snap to an integer grid, cut every triangle along its
// intersections with the others, re-triangulate, then flood the outside air from face to face
// (choosing the angularly nearest face around each edge) and keep the faces that have exactly
// one side in the air. Inner walls, zero-thickness sheets and fully enclosed parts disappear.
import type { ManifoldToplevel } from 'manifold-3d';
import { type MeshData, bounds, size } from '../core/mesh-data';
import { loadManifold } from '../geometry/csg';
import { stitchSoup } from './repair';
import { analyze } from './analyze';

export interface WrapResult {
  mesh: MeshData;
  intersections: number; // intersecting triangle pairs found
  openEdges: number; // open edges left in the cut surface before the flood (rounding defects)
}

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crossV = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dotV = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

interface Grid {
  q: V3[]; // quantised vertices (integers)
  tris: [number, number, number][];
  unit: number;
  origin: V3;
}

function quantise(m: MeshData): Grid {
  const b = bounds(m);
  const diag = Math.hypot(...size(b)) || 1;
  const unit = diag / 100000;
  const q: V3[] = [];
  for (let i = 0; i < m.positions.length; i += 3) {
    q.push([0, 1, 2].map((k) => Math.round((m.positions[i + k] - b.min[k]) / unit)) as V3);
  }
  const tris: [number, number, number][] = [];
  for (let i = 0; i < m.indices.length; i += 3) {
    const t: [number, number, number] = [m.indices[i], m.indices[i + 1], m.indices[i + 2]];
    const n = crossV(sub(q[t[1]], q[t[0]]), sub(q[t[2]], q[t[0]]));
    if (n[0] || n[1] || n[2]) tris.push(t); // triangles flattened by rounding are dropped
  }
  return { q, tris, unit, origin: b.min };
}

// --- broad phase ------------------------------------------------------------------------------

function candidatePairs(g: Grid): [number, number][] {
  const boxes = g.tris.map((t) => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const v of t) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], g.q[v][k]);
      max[k] = Math.max(max[k], g.q[v][k]);
    }
    return { min, max };
  });
  let avg = 0;
  for (const b of boxes) avg += Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const cell = Math.max(1, (avg / Math.max(1, boxes.length)) * 2);
  const K = 131072; // cells per axis encoded in one number (< 2^51)
  const cellKey = (x: number, y: number, z: number) => (x * K + y) * K + z;
  const overlap = (A: (typeof boxes)[number], B: (typeof boxes)[number]) =>
    !(A.max[0] < B.min[0] || B.max[0] < A.min[0] || A.max[1] < B.min[1] || B.max[1] < A.min[1] || A.max[2] < B.min[2] || B.max[2] < A.min[2]);
  const cells = new Map<number, number[]>();
  const huge: number[] = []; // triangles spanning a huge number of cells: tested against all
  boxes.forEach((b, i) => {
    const lo = b.min.map((x) => Math.floor(x / cell)), hi = b.max.map((x) => Math.floor(x / cell));
    if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 4096) {
      huge.push(i);
      return;
    }
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const key = cellKey(x, y, z);
      const list = cells.get(key);
      if (list) list.push(i);
      else cells.set(key, [i]);
    }
  });
  const pairs: [number, number][] = [];
  for (const [key, list] of cells) {
    for (let a = 0; a < list.length; a++) for (let c = a + 1; c < list.length; c++) {
      const A = boxes[list[a]], B = boxes[list[c]];
      if (!overlap(A, B)) continue;
      // Report each pair once: in the cell where the overlap of the two boxes starts.
      const sx = Math.floor(Math.max(A.min[0], B.min[0]) / cell);
      const sy = Math.floor(Math.max(A.min[1], B.min[1]) / cell);
      const sz = Math.floor(Math.max(A.min[2], B.min[2]) / cell);
      if (cellKey(sx, sy, sz) !== key) continue;
      pairs.push(list[a] < list[c] ? [list[a], list[c]] : [list[c], list[a]]);
    }
  }
  const isHuge = new Set(huge);
  for (const h of huge) {
    for (let j = 0; j < boxes.length; j++) {
      if (j === h || (isHuge.has(j) && j < h)) continue;
      if (overlap(boxes[h], boxes[j])) pairs.push(h < j ? [h, j] : [j, h]);
    }
  }
  return pairs;
}

// --- narrow phase: triangle/triangle intersection ------------------------------------------------

/** Plane n·x = d of a quantised triangle (integer coefficients). */
interface PlaneEq { n: V3; d: number; key: string }
/** Constraint segment; intersection segments carry the two planes they lie on. */
type Seg = [V3, V3, PlaneEq?, PlaneEq?];

function planeOfTri(P: V3[]): PlaneEq {
  const n = crossV(sub(P[1], P[0]), sub(P[2], P[0]));
  const d = dotV(n, P[0]);
  return { n, d, key: `${n[0]},${n[1]},${n[2]},${d}` };
}

/** Point where an edge (p, q) crosses a plane, interpolated in a canonical vertex order. */
function edgeCross(p: V3, q: V3, dp: number, dq: number): V3 {
  const swap = p[0] > q[0] || (p[0] === q[0] && (p[1] > q[1] || (p[1] === q[1] && p[2] > q[2])));
  if (swap) [p, q, dp, dq] = [q, p, dq, dp];
  const t = dp / (dp - dq);
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
}

/** Intersection of three planes, solved in a canonical plane order (same result for every caller). */
function triplePoint(planes: PlaneEq[]): V3 | null {
  const [a, b, c] = [...planes].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const bc = crossV(b.n, c.n), ca = crossV(c.n, a.n), ab = crossV(a.n, b.n);
  const det = dotV(a.n, bc);
  const scale = Math.hypot(...a.n) * Math.hypot(...b.n) * Math.hypot(...c.n);
  if (!det || Math.abs(det) < scale * 1e-9) return null;
  return [0, 1, 2].map((k) => (a.d * bc[k] + b.d * ca[k] + c.d * ab[k]) / det) as V3;
}

/** Intersection segment of two non-coplanar triangles, or coplanar overlap constraints. */
function intersectPair(g: Grid, i: number, j: number, cons: Seg[][], tolerant = false): boolean {
  const ta = g.tris[i], tb = g.tris[j];
  const A = ta.map((v) => g.q[v]) as V3[], B = tb.map((v) => g.q[v]) as V3[];
  // Shared corners compared by position: split (duplicated) vertices along a seam still count.
  const same = (p: V3, q: V3) => p[0] === q[0] && p[1] === q[1] && p[2] === q[2];
  const shared = A.filter((p) => B.some((q) => same(p, q))).length;
  if (shared === 3) return false;
  const nA = crossV(sub(A[1], A[0]), sub(A[2], A[0]));
  const nB = crossV(sub(B[1], B[0]), sub(B[2], B[0]));
  if ((nA[0] === 0 && nA[1] === 0 && nA[2] === 0) || (nB[0] === 0 && nB[1] === 0 && nB[2] === 0)) return false;
  const dB = B.map((p) => dotV(nA, sub(p, A[0]))); // exact: integer inputs
  // Coplanar pairs overlap even when they share corners (a fin folded flat on its neighbour).
  if (dB[0] === 0 && dB[1] === 0 && dB[2] === 0) return coplanar(A, B, nA, cons[i], cons[j], tolerant);
  if (shared >= 2) return false;
  const dA = A.map((p) => dotV(nB, sub(p, B[0])));
  if ((dB[0] > 0 && dB[1] > 0 && dB[2] > 0) || (dB[0] < 0 && dB[1] < 0 && dB[2] < 0)) return false;
  if ((dA[0] > 0 && dA[1] > 0 && dA[2] > 0) || (dA[0] < 0 && dA[1] < 0 && dA[2] < 0)) return false;

  const dir = crossV(nA, nB);
  const span = (P: V3[], d: number[]): V3[] => {
    const pts: V3[] = [];
    for (let k = 0; k < 3; k++) {
      const a = k, b = (k + 1) % 3;
      if (d[a] === 0) pts.push(P[a]);
      if ((d[a] < 0 && d[b] > 0) || (d[a] > 0 && d[b] < 0)) pts.push(edgeCross(P[a], P[b], d[a], d[b]));
    }
    return pts;
  };
  const sa = span(A, dA), sb = span(B, dB);
  if (sa.length < 2 || sb.length < 2) return false;
  const proj = (p: V3) => dotV(dir, p);
  const order = (s: V3[]): [V3, number, V3, number] => {
    let lo = s[0], hi = s[0];
    for (const p of s) {
      if (proj(p) < proj(lo)) lo = p;
      if (proj(p) > proj(hi)) hi = p;
    }
    return [lo, proj(lo), hi, proj(hi)];
  };
  const [aLo, aLoT, aHi, aHiT] = order(sa);
  const [bLo, bLoT, bHi, bHiT] = order(sb);
  const lo = aLoT > bLoT ? aLo : bLo, loT = Math.max(aLoT, bLoT);
  const hi = aHiT < bHiT ? aHi : bHi, hiT = Math.min(aHiT, bHiT);
  if (hiT - loT <= 0) return false;
  const seg: Seg = [lo, hi, planeOfTri(A), planeOfTri(B)];
  // Touches at a point (e.g. a shared vertex); the validity count allows the grid rounding.
  if (Math.hypot(...sub(hi, lo)) < (tolerant ? 1 : 0.5)) return false;
  cons[i].push(seg);
  cons[j].push(seg);
  return true;
}

/** Area of the overlap of two 2D triangles divided by its longest extent (0 when they do not overlap). */
function overlapThickness(a: number[][], b: number[][]): number {
  const ccw = (t: number[][]) => ((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[1][1] - t[0][1]) * (t[2][0] - t[0][0]) < 0 ? [t[0], t[2], t[1]] : t);
  let poly = ccw(a).map((p) => [p[0], p[1]]);
  const c = ccw(b);
  for (let e = 0; e < 3 && poly.length; e++) {
    const u = c[e], v = c[(e + 1) % 3];
    const side = (p: number[]) => (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0]);
    const next: number[][] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) next.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    }
    poly = next;
  }
  if (poly.length < 3) return 0;
  let area = 0, ext = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    area += p[0] * q[1] - q[0] * p[1];
    for (const r of poly) ext = Math.max(ext, Math.hypot(r[0] - p[0], r[1] - p[1]));
  }
  return ext > 0 ? Math.abs(area) / 2 / ext : 0;
}

/** Coplanar overlap: each triangle's edges, clipped to the other triangle, become constraints. */
function coplanar(A: V3[], B: V3[], n: V3, consA: Seg[], consB: Seg[], tolerant = false): boolean {
  const k = dominantAxis(n);
  const P = (p: V3) => project(p, k, n[k] > 0);
  // For the validity count, overlaps thinner than one grid unit come from rounding the corners onto
  // the grid (two long, thin neighbours folded by half a unit), not from the model. The wrap itself
  // still cuts them.
  if (tolerant && overlapThickness(A.map(P), B.map(P)) < 1) return false;
  let any = false;
  const clipInto = (edgesOf: V3[], into: V3[], out: Seg[]) => {
    let T = into.map(P);
    // Make the clipping triangle counter-clockwise: opposite-facing layers come in clockwise.
    if ((T[1][0] - T[0][0]) * (T[2][1] - T[0][1]) - (T[1][1] - T[0][1]) * (T[2][0] - T[0][0]) < 0) T = [T[0], T[2], T[1]];
    for (let e = 0; e < 3; e++) {
      const p0 = edgesOf[e], p1 = edgesOf[(e + 1) % 3];
      const a = P(p0), b = P(p1);
      // An edge along the other triangle's boundary is not an overlap (neighbours, T-junctions).
      let along = false;
      for (let s = 0; s < 3; s++) {
        const u = T[s], v = T[(s + 1) % 3];
        const oa = (v[0] - u[0]) * (a[1] - u[1]) - (v[1] - u[1]) * (a[0] - u[0]);
        const ob = (v[0] - u[0]) * (b[1] - u[1]) - (v[1] - u[1]) * (b[0] - u[0]);
        if (oa === 0 && ob === 0) along = true;
      }
      if (along) continue;
      let t0 = 0, t1 = 1;
      for (let s = 0; s < 3 && t0 < t1; s++) {
        const u = T[s], v = T[(s + 1) % 3];
        // inside: orient(u, v, x) >= 0 for a CCW triangle
        const fa = (v[0] - u[0]) * (a[1] - u[1]) - (v[1] - u[1]) * (a[0] - u[0]);
        const fb = (v[0] - u[0]) * (b[1] - u[1]) - (v[1] - u[1]) * (b[0] - u[0]);
        if (fa < 0 && fb < 0) { t1 = -1; break; }
        if (fa < 0) t0 = Math.max(t0, fa / (fa - fb));
        else if (fb < 0) t1 = Math.min(t1, fa / (fa - fb));
      }
      if (t1 - t0 > 1e-9) {
        const lerp = (t: number): V3 => [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t];
        const s: Seg = [lerp(t0), lerp(t1)];
        if (Math.hypot(...sub(s[1], s[0])) >= 0.5) {
          out.push(s);
          any = true;
        }
      }
    }
  };
  clipInto(A, B, consB);
  clipInto(B, A, consA);
  return any;
}

const dominantAxis = (n: V3) => (Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2);

/** Drops axis k; the 2D image keeps the triangle's winding (CCW when the normal is along +k). */
function project(p: V3, k: number, positive: boolean): [number, number] {
  const u = (k + 1) % 3, v = (k + 2) % 3;
  return positive ? [p[u], p[v]] : [p[v], p[u]];
}

// --- re-triangulation of one triangle ---------------------------------------------------------------

interface Out {
  key: Map<string, number>;
  pts: V3[];
  tris: number[];
  /** Exact plane normal of each output triangle's source (rounding may tilt the piece itself). */
  planes: V3[];
  /** Whether each output triangle comes from a triangle that was cut. */
  cut: boolean[];
}

/** Offset of each source plane (n · p on the source triangle), for sampling from the exact plane. */
const planeOffset = new WeakMap<V3, number>();

function globalId(out: Out, p: V3): number {
  const r: V3 = [Math.round(p[0]), Math.round(p[1]), Math.round(p[2])];
  const key = `${r[0]},${r[1]},${r[2]}`;
  let id = out.key.get(key);
  if (id === undefined) {
    id = out.pts.length;
    out.key.set(key, id);
    out.pts.push(r);
  }
  return id;
}

/** Integer plane key: primitive normal with a canonical sign, plus offset. */
function planeKey(corners: V3[]): { key: string; n: V3 } {
  let n = crossV(sub(corners[1], corners[0]), sub(corners[2], corners[0]));
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));
  const g = gcd(gcd(Math.abs(n[0]), Math.abs(n[1])), Math.abs(n[2])) || 1;
  n = [n[0] / g, n[1] / g, n[2] / g];
  const first = n[0] || n[1] || n[2];
  if (first < 0) n = [-n[0], -n[1], -n[2]];
  return { key: `${n[0]},${n[1]},${n[2]},${dotV(n, corners[0])}`, n };
}

/**
 * Re-triangulates all the cut triangles lying in one plane together: every triangle edge and
 * intersection segment goes into one planar arrangement; each region is emitted once, oriented by
 * the net coverage of the source triangles (+1 aligned with the plane normal, -1 opposed), so
 * overlapping coplanar faces collapse into one surface and opposite ones cancel out.
 */
function retriangulatePlane(wasm: ManifoldToplevel, n: V3, triangles: V3[][], segs: Seg[], out: Out): void {
  const nNeg: V3 = [-n[0], -n[1], -n[2]];
  planeOffset.set(n, dotV(n, triangles[0][0]));
  planeOffset.set(nNeg, -dotV(n, triangles[0][0]));
  const k = dominantAxis(n);
  const pos = n[k] > 0;
  const corners = triangles.flat();
  // Local vertices: rounded 3D points, deduplicated; 2D = projection of the rounded point.
  const ids: number[] = []; // local -> global
  const p2: [number, number][] = [];
  const local = new Map<number, number>();
  const add = (p: V3) => {
    const gid = globalId(out, p);
    let l = local.get(gid);
    if (l === undefined) {
      l = ids.length;
      local.set(gid, l);
      ids.push(gid);
      p2.push(project(out.pts[gid], k, pos));
    }
    return l;
  };
  const C = corners.map(add);
  const triLocal = triangles.map((t) => t.map(add));
  const triSign = triangles.map((t) => (dotV(crossV(sub(t[1], t[0]), sub(t[2], t[0])), n) > 0 ? 1 : -1));
  const segIdx: [number, number][] = [];
  const segPlanes: (PlaneEq[] | null)[] = [];
  for (const [a, b, pa, pb] of segs) {
    const ia = add(a), ib = add(b);
    if (ia !== ib) {
      segIdx.push([ia, ib]);
      segPlanes.push(pa && pb ? [pa, pb] : null);
    }
  }
  const orient = (a: number, b: number, c: number) =>
    (p2[b][0] - p2[a][0]) * (p2[c][1] - p2[a][1]) - (p2[b][1] - p2[a][1]) * (p2[c][0] - p2[a][0]);
  const len = (a: number, b: number) => Math.hypot(p2[b][0] - p2[a][0], p2[b][1] - p2[a][1]);
  const param = (a: number, b: number, c: number) =>
    ((p2[c][0] - p2[a][0]) * (p2[b][0] - p2[a][0]) + (p2[c][1] - p2[a][1]) * (p2[b][1] - p2[a][1])) / (len(a, b) ** 2 || 1);

  // Segment/segment crossings inside the triangle.
  const lift = (a: number, b: number, t: number): V3 => {
    const pa = out.pts[ids[a]], pb = out.pts[ids[b]];
    return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t];
  };
  // With several overlapping triangles in the plane, a segment can also cross the side of another
  // triangle, and two sides can cross: those crossings are vertices of the arrangement too
  // (missing them leaves a non-planar graph whose regions spill outside the source triangles).
  const lines: [number, number][] = [...segIdx];
  const linePlanes: (PlaneEq[] | null)[] = [...segPlanes];
  if (triLocal.length > 1) for (const t of triLocal) for (let e = 0; e < 3; e++) { lines.push([t[e], t[(e + 1) % 3]]); linePlanes.push(null); }
  const nSeg = lines.length;
  for (let s = 0; s < nSeg; s++) for (let r = s + 1; r < nSeg; r++) {
    const [a, b] = lines[s], [c, d] = lines[r];
    if (a === c || a === d || b === c || b === d) continue;
    const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
    if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
      // Two intersection curves crossing = a point on three planes: solve it from the planes so
      // the other two triangles involved compute the very same point.
      const ps = linePlanes[s] && linePlanes[r] ? [...linePlanes[s]!, ...linePlanes[r]!] : null;
      const distinct = ps ? [...new Map(ps.map((p) => [p.key, p])).values()] : [];
      const p3 = distinct.length === 3 ? triplePoint(distinct) : null;
      add(p3 ?? lift(a, b, o3 / (o3 - o4)));
    }
  }

  // Every edge (triangle sides and segments) is split at the local points lying on it.
  const nLocal = ids.length;
  const edges = new Set<number>();
  const addEdge = (a: number, b: number) => {
    if (a !== b) edges.add(a < b ? a * nLocal + b : b * nLocal + a);
  };
  const splitAdd = (a: number, b: number) => {
    const L = len(a, b);
    const on: [number, number][] = [];
    for (let v = 0; v < nLocal; v++) {
      if (v === a || v === b) continue;
      const t = param(a, b, v);
      if (t <= 0 || t >= 1) continue;
      if (Math.abs(orient(a, b, v)) / (L || 1) <= 1.0) on.push([t, v]);
    }
    on.sort((x, y) => x[0] - y[0]);
    let prev = a;
    for (const [, v] of on) {
      addEdge(prev, v);
      prev = v;
    }
    addEdge(prev, b);
  };
  for (const t of triLocal) {
    splitAdd(t[0], t[1]);
    splitAdd(t[1], t[2]);
    splitAdd(t[2], t[0]);
  }
  for (const [a, b] of segIdx) splitAdd(a, b);

  // Adjacency; prune dangling edges (they cannot bound a region).
  const adj: Set<number>[] = Array.from({ length: nLocal }, () => new Set());
  for (const e of edges) {
    const a = Math.floor(e / nLocal), b = e % nLocal;
    adj[a].add(b);
    adj[b].add(a);
  }
  const isCorner = new Set(C);
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (let v = 0; v < nLocal; v++) {
      if (adj[v].size === 1 && !isCorner.has(v)) {
        const [u] = adj[v];
        adj[v].clear();
        adj[u].delete(v);
        pruned = true;
      }
    }
  }

  // Faces of the planar graph: next(u->v) = edge leaving v just clockwise of v->u.
  const sorted = adj.map((s, v) => [...s].sort((x, y) => Math.atan2(p2[x][1] - p2[v][1], p2[x][0] - p2[v][0]) - Math.atan2(p2[y][1] - p2[v][1], p2[y][0] - p2[v][0])));
  const used = new Set<string>();
  const cycles: number[][] = [];
  for (let u = 0; u < nLocal; u++) {
    for (const v of sorted[u]) {
      if (used.has(`${u},${v}`)) continue;
      const cyc: number[] = [];
      let a = u, b = v;
      for (let guard = 0; guard < 100000; guard++) {
        used.add(`${a},${b}`);
        cyc.push(a);
        const nb = sorted[b];
        const i = nb.indexOf(a);
        const c = nb[(i - 1 + nb.length) % nb.length];
        a = b;
        b = c;
        if (a === u && b === v) break;
      }
      cycles.push(cyc);
    }
  }
  const area = (cyc: number[]) => {
    let s = 0;
    for (let i = 0; i < cyc.length; i++) {
      const p = p2[cyc[i]], q = p2[cyc[(i + 1) % cyc.length]];
      s += p[0] * q[1] - q[0] * p[1];
    }
    return s / 2;
  };
  const faces = cycles.filter((c) => area(c) > 0);
  // Negative cycles are outer boundaries of pieces, or islands inside a face (holes); an island
  // is recognised by having a containing face.
  const holes = cycles.filter((c) => area(c) < 0);
  const inside = (pt: [number, number], cyc: number[]) => {
    let w = false;
    for (let i = 0, j = cyc.length - 1; i < cyc.length; j = i++) {
      const a = p2[cyc[i]], b = p2[cyc[j]];
      if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) w = !w;
    }
    return w;
  };
  const holesOf = new Map<number[], number[][]>();
  for (const hcyc of holes) {
    let best: number[] | null = null;
    for (const f of faces) {
      if (f.some((v) => hcyc.includes(v))) continue;
      if (inside(p2[hcyc[0]], f) && (!best || area(f) < area(best))) best = f;
    }
    if (best) holesOf.set(best, [...(holesOf.get(best) ?? []), hcyc]);
  }

  const inTri = (pt: [number, number], t: number[]) => {
    const s = (a: number, b: number) => (p2[b][0] - p2[a][0]) * (pt[1] - p2[a][1]) - (p2[b][1] - p2[a][1]) * (pt[0] - p2[a][0]);
    const d0 = s(t[0], t[1]), d1 = s(t[1], t[2]), d2 = s(t[2], t[0]);
    return (d0 > 0 && d1 > 0 && d2 > 0) || (d0 < 0 && d1 < 0 && d2 < 0);
  };

  for (const f of faces) {
    const polys = [f, ...(holesOf.get(f) ?? [])];
    const flat = polys.flat();
    let local: number[][];
    if (f.length === 3 && polys.length === 1) local = [f];
    else {
      try {
        local = wasm.triangulate(polys.map((c) => c.map((v) => [p2[v][0], p2[v][1]] as [number, number])), 0)
          .map((t) => [flat[t[0]], flat[t[1]], flat[t[2]]]);
      } catch {
        local = [];
        for (let i = 1; i + 1 < f.length; i++) local.push([f[0], f[i], f[i + 1]]);
      }
    }
    if (!local.length) continue;
    // Net coverage of the region by the source triangles, sampled at the centroid of its largest piece.
    let big = local[0], bigArea = -1;
    for (const t of local) {
      const a = Math.abs(orient(t[0], t[1], t[2]));
      if (a > bigArea) { bigArea = a; big = t; }
    }
    const sample: [number, number] = [
      (p2[big[0]][0] + p2[big[1]][0] + p2[big[2]][0]) / 3,
      (p2[big[0]][1] + p2[big[1]][1] + p2[big[2]][1]) / 3,
    ];
    let net = 0;
    triLocal.forEach((t, i) => { if (inTri(sample, t)) net += triSign[i]; });
    if (net === 0) continue;
    for (const t of local) {
      if (net > 0) out.tris.push(ids[t[0]], ids[t[1]], ids[t[2]]);
      else out.tris.push(ids[t[0]], ids[t[2]], ids[t[1]]);
      out.planes.push(net > 0 ? n : nNeg);
      out.cut.push(true);
    }
  }
}

// --- classification by outside-air flood (3D Builder's method) ------------------------------------------

/**
 * Floods the outside air from face side to face side. Around each edge the next face is the
 * angularly nearest one in the direction of the air; a face's direction around an edge comes
 * from its exact source plane and its winding (its interior lies left of its edges), never from
 * rounded vertex positions. Returns per face: bit0 = front side in the air, bit1 = back side.
 */
function floodOutside(pts: V3[], tris: number[], planes: V3[]): { label: Uint8Array; comp: Int32Array } {
  const nt = tris.length / 3;
  const nv = pts.length;
  const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  const edgeFaces = new Map<number, number[]>();
  for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) {
    const kk = key(tris[f * 3 + k], tris[f * 3 + ((k + 1) % 3)]);
    const l = edgeFaces.get(kk);
    if (l) l.push(f);
    else edgeFaces.set(kk, [f]);
  }
  const radial = new Map<number, { faces: number[]; forward: boolean[] }>();
  const radialOf = (a: number, b: number) => {
    const kk = key(a, b);
    let r = radial.get(kk);
    if (r) return r;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const d = sub(pts[hi], pts[lo]);
    const dl = Math.hypot(...d) || 1;
    const dn: V3 = [d[0] / dl, d[1] / dl, d[2] / dl];
    const u = crossV(Math.abs(dn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], dn);
    const ul = Math.hypot(...u);
    const e1: V3 = [u[0] / ul, u[1] / ul, u[2] / ul];
    const e2 = crossV(dn, e1);
    const list = edgeFaces.get(kk)!.map((f) => {
      let forward = false;
      for (let k = 0; k < 3; k++) if (tris[f * 3 + k] === lo && tris[f * 3 + ((k + 1) % 3)] === hi) forward = true;
      const w = crossV(planes[f], forward ? dn : [-dn[0], -dn[1], -dn[2]]);
      return { f, forward, angle: Math.atan2(dotV(w, e2), dotV(w, e1)) };
    }).sort((x, y) => x.angle - y.angle);
    r = { faces: list.map((x) => x.f), forward: list.map((x) => x.forward) };
    radial.set(kk, r);
    return r;
  };

  // One seed per connected component: an axis ray from beyond +X onto its right-most face; the
  // first face hit is in the open air, on its +X side.
  const comp = new Int32Array(nt).fill(-1);
  let ncomp = 0;
  for (let s = 0; s < nt; s++) {
    if (comp[s] >= 0) continue;
    comp[s] = ncomp;
    const stack = [s];
    while (stack.length) {
      const f = stack.pop()!;
      for (let k = 0; k < 3; k++) {
        for (const g of edgeFaces.get(key(tris[f * 3 + k], tris[f * 3 + ((k + 1) % 3)]))!) {
          if (comp[g] < 0) {
            comp[g] = ncomp;
            stack.push(g);
          }
        }
      }
    }
    ncomp++;
  }
  const centroid = (f: number): V3 => [0, 1, 2].map((k) => (pts[tris[f * 3]][k] + pts[tris[f * 3 + 1]][k] + pts[tris[f * 3 + 2]][k]) / 3) as V3;
  const triList = Array.from({ length: nt }, (_, f) => [tris[f * 3], tris[f * 3 + 1], tris[f * 3 + 2]] as [number, number, number]);
  const firstHit = rayIndex(pts, triList);
  const label = new Uint8Array(nt);
  const stack: number[] = [];
  const reach = (f: number, side: number) => {
    const bit = side ? 2 : 1;
    if (label[f] & bit) return;
    label[f] |= bit;
    stack.push(f * 2 + side);
  };
  const best = new Map<number, number>();
  for (let f = 0; f < nt; f++) {
    if (planes[f][0] === 0) continue;
    const b = best.get(comp[f]);
    if (b === undefined || centroid(f)[0] > centroid(b)[0]) best.set(comp[f], f);
  }
  for (const f of best.values()) {
    const c = centroid(f);
    const hit = firstHit(c[1] + 0.0137, c[2] + 0.0071);
    if (hit >= 0) reach(hit, planes[hit][0] > 0 ? 0 : 1);
  }
  while (stack.length) {
    const code = stack.pop()!;
    const f = code >> 1, side = code & 1;
    for (let k = 0; k < 3; k++) {
      const r = radialOf(tris[f * 3 + k], tris[f * 3 + ((k + 1) % 3)]);
      const i = r.faces.indexOf(f);
      // Air on the increasing-angle side of f when (forward and front) or (backward and back).
      // An open edge is a wall. (3D Builder lets the air wrap around to f's other side, which is
      // the same on its closed input; here rounding may leave a pinhole, and one leak would flood
      // the whole inside. A genuine dangling sheet still gets air on both sides from outside.)
      if (r.faces.length === 1) continue;
      const movingInc = r.forward[i] === (side === 0);
      const j = (i + (movingInc ? 1 : -1) + r.faces.length) % r.faces.length;
      reach(r.faces[j], r.forward[j] === !movingInc ? 0 : 1);
    }
  }
  return { label, comp };
}

/** First face hit by a ray coming from +X infinity at (y, z), or -1. */
function rayIndex(pts: V3[], tris: [number, number, number][]) {
  let extent = 0;
  for (const t of tris) {
    const ys = t.map((v) => pts[v][1]), zs = t.map((v) => pts[v][2]);
    extent += Math.max(Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs));
  }
  const cell = Math.max(1, extent / Math.max(1, tris.length));
  const grid = new Map<string, number[]>();
  tris.forEach((t, i) => {
    const ys = t.map((v) => pts[v][1]), zs = t.map((v) => pts[v][2]);
    for (let y = Math.floor(Math.min(...ys) / cell); y <= Math.floor(Math.max(...ys) / cell); y++) {
      for (let z = Math.floor(Math.min(...zs) / cell); z <= Math.floor(Math.max(...zs) / cell); z++) {
        const key = `${y},${z}`;
        const l = grid.get(key);
        if (l) l.push(i);
        else grid.set(key, [i]);
      }
    }
  });
  return (y: number, z: number): number => {
    let bestF = -1, bestX = -Infinity;
    for (const i of grid.get(`${Math.floor(y / cell)},${Math.floor(z / cell)}`) ?? []) {
      const [A, B, C] = tris[i].map((v) => pts[v]);
      const e0 = (B[1] - A[1]) * (z - A[2]) - (B[2] - A[2]) * (y - A[1]);
      const e1 = (C[1] - B[1]) * (z - B[2]) - (C[2] - B[2]) * (y - B[1]);
      const e2 = (A[1] - C[1]) * (z - C[2]) - (A[2] - C[2]) * (y - C[1]);
      if (!((e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0))) continue;
      const n = crossV(sub(B, A), sub(C, A));
      if (n[0] === 0) continue;
      const x = A[0] - (n[1] * (y - A[1]) + n[2] * (z - A[2])) / n[0];
      if (x > bestX) { bestX = x; bestF = i; }
    }
    return bestF;
  };
}

// --- classification by winding number --------------------------------------------------------------------

/**
 * Winding number of the original (closed, oriented) surface, by casting +X rays. 3D Assembler keeps a
 * cut piece when the material is on exactly one of its sides. This gives the same surface as the
 * air flood of 3D Builder on clean input, but it does not depend on how well the cut pieces are
 * stitched together, and it keeps genuine inner cavities.
 */
function windingField(q: V3[], tris: [number, number, number][]) {
  let extent = 0;
  for (const t of tris) {
    const ys = t.map((v) => q[v][1]), zs = t.map((v) => q[v][2]);
    extent += Math.max(Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs));
  }
  const cell = Math.max(1, extent / Math.max(1, tris.length));
  const grid = new Map<string, number[]>();
  tris.forEach((t, i) => {
    const ys = t.map((v) => q[v][1]), zs = t.map((v) => q[v][2]);
    for (let y = Math.floor(Math.min(...ys) / cell); y <= Math.floor(Math.max(...ys) / cell); y++) {
      for (let z = Math.floor(Math.min(...zs) / cell); z <= Math.floor(Math.max(...zs) / cell); z++) {
        const key = `${y},${z}`;
        const l = grid.get(key);
        if (l) l.push(i);
        else grid.set(key, [i]);
      }
    }
  });
  const normals = tris.map((t) => crossV(sub(q[t[1]], q[t[0]]), sub(q[t[2]], q[t[0]])));
  return (p: V3): number => {
    let w = 0;
    for (const i of grid.get(`${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`) ?? []) {
      const n = normals[i];
      if (n[0] === 0) continue;
      const [A, B, C] = tris[i].map((v) => q[v]);
      const e0 = (B[1] - A[1]) * (p[2] - A[2]) - (B[2] - A[2]) * (p[1] - A[1]);
      const e1 = (C[1] - B[1]) * (p[2] - B[2]) - (C[2] - B[2]) * (p[1] - B[1]);
      const e2 = (A[1] - C[1]) * (p[2] - C[2]) - (A[2] - C[2]) * (p[1] - C[1]);
      if (!((e0 > 0 && e1 > 0 && e2 > 0) || (e0 < 0 && e1 < 0 && e2 < 0))) continue;
      const x = A[0] - (n[1] * (p[1] - A[1]) + n[2] * (p[2] - A[2])) / n[0];
      if (x > p[0]) w += n[0] > 0 ? 1 : -1;
    }
    return w;
  };
}

/** Phase timer, active when globalThis.WRAP_TIMING is set. */
function timer() {
  let t = performance.now();
  return (label: string) => {
    if (!(globalThis as { WRAP_TIMING?: boolean }).WRAP_TIMING) return;
    const now = performance.now();
    console.log('wrap', label, Math.round(now - t));
    t = now;
  };
}

/** Topological defects of a candidate result (open, non-manifold or inconsistent edges). */
function defects(m: MeshData): number {
  if (!m.indices.length) return Infinity;
  const r = analyze(m);
  return r.openEdges + r.nonManifoldEdges + r.flippedEdges;
}

/**
 * Faces kept by the winding number of the original (closed) surface: solid behind, empty in front.
 * Each side is sampled at the face centroid, a quarter grid unit away or half way to the nearest
 * other surface when a layer lies closer (folded fins: two layers a fraction of a unit apart).
 * Inside test by rays along X, Y and Z, by majority, as in the booleans. A sliver along an
 * intersection curve, whose samples may straddle the other surface, takes the decision of its
 * neighbours when they agree.
 */
function windingClassify(g: Grid, pts: V3[], tris: number[], planeOf: V3[]): number[] {
  const perms: [number, number, number][] = [[0, 1, 2], [1, 2, 0], [2, 0, 1]];
  const fields = perms.map((pm) => windingField(g.q.map((p) => [p[pm[0]], p[pm[1]], p[pm[2]]] as V3), g.tris));
  const inside = (p: V3) => fields.reduce((n, fld, k) => n + (fld([p[perms[k][0]], p[perms[k][1]], p[perms[k][2]]]) > 0 ? 1 : 0), 0) >= 2;
  const nf = tris.length / 3;
  const src = g.tris.map((t) => t.map((v) => g.q[v]) as V3[]);
  const boxes = src.map((T) => [0, 1, 2].map((k) => [Math.min(T[0][k], T[1][k], T[2][k]), Math.max(T[0][k], T[1][k], T[2][k])]));
  // Distance along the unit direction d from o to the nearest source triangle within 0.25 units.
  const reach = 0.25;
  // Uniform grid of the source triangles' boxes, cells about one average triangle wide.
  let ext = 0;
  for (const bx of boxes) ext += Math.max(bx[0][1] - bx[0][0], bx[1][1] - bx[1][0], bx[2][1] - bx[2][0]);
  const cell = Math.max(1, ext / Math.max(1, boxes.length));
  const grid = new Map<string, number[]>();
  const always: number[] = []; // boxes spanning too many cells: tested every time
  boxes.forEach((bx, i) => {
    const lo = bx.map((r) => Math.floor(r[0] / cell)), hi = bx.map((r) => Math.floor(r[1] / cell));
    if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 4096) { always.push(i); return; }
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const key = `${x},${y},${z}`;
      const l = grid.get(key);
      if (l) l.push(i);
      else grid.set(key, [i]);
    }
  });
  const near = (o: V3): number[] => {
    const lo = o.map((v) => Math.floor((v - reach) / cell)), hi = o.map((v) => Math.floor((v + reach) / cell));
    const found = new Set<number>(always);
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      for (const i of grid.get(`${x},${y},${z}`) ?? []) found.add(i);
    }
    return [...found];
  };
  const nearest = (o: V3, d: V3): number => {
    let best = reach;
    for (const i of near(o)) {
      const bx = boxes[i];
      let skip = false;
      for (let k = 0; k < 3; k++) if (bx[k][0] > o[k] + reach || bx[k][1] < o[k] - reach) skip = true;
      if (skip) continue;
      const [A, B, C] = src[i];
      const e1 = sub(B, A), e2 = sub(C, A);
      const pv = crossV(d, e2);
      const det = dotV(e1, pv);
      if (Math.abs(det) < 1e-12) continue;
      const tv = sub(o, A);
      const u = dotV(tv, pv) / det;
      if (u < 0 || u > 1) continue;
      const qv = crossV(tv, e1);
      const v = dotV(d, qv) / det;
      if (v < 0 || u + v > 1) continue;
      const t = dotV(e2, qv) / det;
      if (t > 1e-6 && t < best) best = t;
    }
    return best;
  };
  const dec = new Int8Array(nf);
  const thin: boolean[] = [];
  for (let f = 0; f < nf; f++) {
    const [a, b, c] = [tris[f * 3], tris[f * 3 + 1], tris[f * 3 + 2]];
    const n = planeOf[f];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    const u: V3 = [n[0] / len, n[1] / len, n[2] / len];
    // Centroid, jittered within the face's plane (off mesh edges, but not off its own surface).
    const j: V3 = [0.00731, 0.00419, 0.00283];
    const jn = dotV(j, u);
    const o: V3 = [0, 1, 2].map((k) => (pts[a][k] + pts[b][k] + pts[c][k]) / 3 + j[k] - jn * u[k]) as V3;
    // Back onto the exact source plane: snapping nearby vertices together can shift a piece by
    // more than the sampling distance.
    const off = planeOffset.get(n);
    if (off !== undefined) {
      const e = (dotV(o, n) - off) / (len * len);
      for (let k = 0; k < 3; k++) o[k] -= e * n[k];
    }
    const hf = nearest(o, u), hb = nearest(o, [-u[0], -u[1], -u[2]]);
    const df = hf < reach ? hf / 2 : reach, db = hb < reach ? hb / 2 : reach;
    const front = inside([o[0] + u[0] * df, o[1] + u[1] * df, o[2] + u[2] * df]);
    const back = inside([o[0] - u[0] * db, o[1] - u[1] * db, o[2] - u[2] * db]);
    dec[f] = back && !front ? 1 : front && !back ? -1 : 0;
    const area2 = Math.hypot(...crossV(sub(pts[b], pts[a]), sub(pts[c], pts[a])));
    const longest = Math.max(Math.hypot(...sub(pts[b], pts[a])), Math.hypot(...sub(pts[c], pts[b])), Math.hypot(...sub(pts[a], pts[c])));
    thin.push(longest > 0 && area2 / longest < 2);
  }
  // Neighbours across manifold edges (an edge shared by more than two pieces is on a curve).
  const edges = new Map<string, number[]>();
  for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) {
    const x = tris[f * 3 + k], y = tris[f * 3 + ((k + 1) % 3)];
    const key = x < y ? `${x},${y}` : `${y},${x}`;
    const l = edges.get(key);
    if (l) l.push(f);
    else edges.set(key, [f]);
  }
  const nbrs: number[][] = Array.from({ length: nf }, () => []);
  for (const l of edges.values()) if (l.length === 2) { nbrs[l[0]].push(l[1]); nbrs[l[1]].push(l[0]); }
  for (let pass = 0; pass < 4; pass++) {
    let changed = 0;
    for (let f = 0; f < nf; f++) {
      if (!thin[f] || !nbrs[f].length) continue;
      // Majority of its neighbours (all of them when it has only one or two).
      const votes = new Map<number, number>();
      for (const h of nbrs[f]) votes.set(dec[h], (votes.get(dec[h]) ?? 0) + 1);
      let best = dec[f], bestN = 0;
      for (const [d, c] of votes) if (c > bestN) { best = d; bestN = c; }
      if (best !== dec[f] && bestN * 2 > nbrs[f].length && (nbrs[f].length > 2 || bestN === nbrs[f].length)) { dec[f] = best; changed++; }
    }
    if (!changed) break;
  }
  const kept: number[] = [];
  for (let f = 0; f < nf; f++) {
    if (dec[f] === 1) kept.push(tris[f * 3], tris[f * 3 + 1], tris[f * 3 + 2]);
    else if (dec[f] === -1) kept.push(tris[f * 3], tris[f * 3 + 2], tris[f * 3 + 1]);
  }
  return kept;
}

// --- driver --------------------------------------------------------------------------------------------

export async function countSelfIntersections(m: MeshData): Promise<number> {
  const g = quantise(m);
  const cons: Seg[][] = g.tris.map(() => []);
  let n = 0;
  for (const [i, j] of candidatePairs(g)) if (intersectPair(g, i, j, cons, true)) n++;
  return n;
}

/** Returns the wrapped mesh, or null when no triangles intersect (nothing to do). */
export async function wrapMesh(m: MeshData): Promise<WrapResult | null> {
  const tick = timer();
  const g = quantise(m);
  const cons: Seg[][] = g.tris.map(() => []);
  let intersections = 0;
  const pairs = candidatePairs(g);
  tick('pairs');
  for (const [i, j] of pairs) if (intersectPair(g, i, j, cons)) intersections++;
  tick('intersect');
  if (!intersections) return null;

  const wasm = await loadManifold();
  const out: Out = { key: new Map(), pts: [], tris: [], planes: [], cut: [] };
  const planes = new Map<string, { n: V3; tris: V3[][]; segs: Seg[] }>();
  g.tris.forEach((t, i) => {
    const corners = t.map((v) => g.q[v]) as V3[];
    if (!cons[i].length) {
      out.tris.push(globalId(out, corners[0]), globalId(out, corners[1]), globalId(out, corners[2]));
      const n = crossV(sub(corners[1], corners[0]), sub(corners[2], corners[0]));
      planeOffset.set(n, dotV(n, corners[0]));
      out.planes.push(n);
      out.cut.push(false);
      return;
    }
    const { key, n } = planeKey(corners);
    let pl = planes.get(key);
    if (!pl) planes.set(key, (pl = { n, tris: [], segs: [] }));
    pl.tris.push(corners);
    pl.segs.push(...cons[i]);
  });
  for (const pl of planes.values()) retriangulatePlane(wasm, pl.n, pl.tris, pl.segs, out);
  tick('retriangulate');

  // Rounding can leave T-junctions between pieces computed in different triangles: stitch them
  // on the grid so the final surface is closed.
  const stitched = stitchSoup(Float64Array.from(out.pts.flat()), out.tris, 2);
  tick('stitch');
  const pts: V3[] = [];
  for (let i = 0; i < stitched.pos.length; i += 3) pts.push([stitched.pos[i], stitched.pos[i + 1], stitched.pos[i + 2]]);
  const flat = splitSlivers(pts, stitched.tris, stitched.origin);
  const srcPlanes = flat.origin.map((o) => out.planes[o]);
  const srcCut = flat.origin.map((o) => out.cut[o]);

  // Coincident pieces: same orientation keeps one, opposite orientations cancel out.
  const { tris, planeOf, cutOf } = dedupe(flat.tris, srcPlanes, srcCut);
  fillPinholes(pts, tris, planeOf, cutOf, 64);
  let openEdges = 0;
  {
    const use = new Map<string, number>();
    for (let f = 0; f < tris.length / 3; f++) for (let k = 0; k < 3; k++) {
      const a = tris[f * 3 + k], b = tris[f * 3 + ((k + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      use.set(key, (use.get(key) ?? 0) + 1);
    }
    for (const c of use.values()) if (c === 1) openEdges++;
  }

  const positions = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => {
    for (let k = 0; k < 3; k++) positions[i * 3 + k] = p[k] * g.unit + g.origin[k];
  });

  // 1. Outside-air flood (3D Builder): keep faces with exactly one side in the air. A component the
  //    air never reaches is enclosed (an inner cavity): dropped, as 3D Builder does.
  tick('dedupe');
  const { label } = floodOutside(pts, tris, planeOf);
  tick('flood');
  const flood: number[] = [];
  for (let f = 0; f < tris.length / 3; f++) {
    if (label[f] === 1) flood.push(tris[f * 3], tris[f * 3 + 1], tris[f * 3 + 2]);
    else if (label[f] === 2) flood.push(tris[f * 3], tris[f * 3 + 2], tris[f * 3 + 1]);
  }
  const floodMesh = { positions, indices: new Uint32Array(flood) };
  const floodScore = defects(floodMesh);
  tick('defects');
  // A closed flood result is accepted only if it keeps the bulk of the solid: on folded fins the
  // air can leak inside through a mis-ordered edge and leave a closed scrap (3D Assembler's check; the
  // input here is closed, so its volume is meaningful).
  const inputVolume = Math.abs(analyze(m).volume);
  const floodVolume = floodMesh.indices.length ? analyze(floodMesh).volume : 0;
  const floodWhole = floodVolume >= 0.5 * inputVolume;
  if (floodScore === 0 && floodWhole) return { mesh: floodMesh, intersections, openEdges };

  // 2. Fallback: winding number of the original surface on each side of every piece.
  const windMesh = { positions, indices: new Uint32Array(windingClassify(g, pts, tris, planeOf)) };
  const windScore = defects(windMesh);
  // A flood that lost the bulk of the solid leaked: the winding result is the better start for
  // the repair that follows, even with a few defects.
  const mesh = windMesh.indices.length && (!floodWhole || windScore < floodScore) ? windMesh : floodMesh;
  return { mesh, intersections, openEdges };
}

// --- booleans --------------------------------------------------------------------------------------

export type BooleanOp = 'union' | 'subtract' | 'intersect';

/**
 * 3D Builder's boolean engine (a separate engine from the Wrap): the faces of A are cut by those of
 * B and vice versa (never by their own), and each piece is kept, reversed or dropped by the
 * winding number of the other operand: union keeps what lies outside the other, intersection what
 * lies inside it, subtraction keeps A outside B and B inside A, reversed. 3D Assembler evaluates the
 * winding a quarter grid unit in front of and behind each piece, on the Wrap's integer grid, so
 * coincident faces get a definite answer (3D Builder drops them and repairs afterwards).
 */
export async function booleanMesh(A: MeshData, B: MeshData, op: BooleanOp): Promise<MeshData> {
  const nA = A.indices.length / 3;
  const pos = new Float32Array(A.positions.length + B.positions.length);
  pos.set(A.positions);
  pos.set(B.positions, A.positions.length);
  const idx = new Uint32Array(A.indices.length + B.indices.length);
  idx.set(A.indices);
  for (let i = 0; i < B.indices.length; i++) idx[A.indices.length + i] = B.indices[i] + A.positions.length / 3;
  const m = { positions: pos, indices: idx };
  // Quantise, keeping each surviving triangle's operand.
  const b = bounds(m);
  const unit = (Math.hypot(...size(b)) || 1) / 100000;
  const q: V3[] = [];
  for (let i = 0; i < pos.length; i += 3) q.push([0, 1, 2].map((k) => Math.round((pos[i + k] - b.min[k]) / unit)) as V3);
  const tris: [number, number, number][] = [];
  const isB: boolean[] = [];
  for (let f = 0; f < idx.length / 3; f++) {
    const t: [number, number, number] = [idx[f * 3], idx[f * 3 + 1], idx[f * 3 + 2]];
    const n = crossV(sub(q[t[1]], q[t[0]]), sub(q[t[2]], q[t[0]]));
    if (n[0] || n[1] || n[2]) { tris.push(t); isB.push(f >= nA); }
  }
  const g: Grid = { q, tris, unit, origin: b.min };
  const cons: Seg[][] = tris.map(() => []);
  for (const [i, j] of candidatePairs(g)) if (isB[i] !== isB[j]) intersectPair(g, i, j, cons);

  // Cut pieces, each triangle on its own (pieces of A and B never merge here).
  const wasm = await loadManifold();
  const out: Out = { key: new Map(), pts: [], tris: [], planes: [], cut: [] };
  const fromB: boolean[] = [];
  const srcTri: number[] = [];
  tris.forEach((t, i) => {
    const corners = t.map((v) => q[v]) as V3[];
    const before = out.tris.length / 3;
    if (!cons[i].length) {
      out.tris.push(globalId(out, corners[0]), globalId(out, corners[1]), globalId(out, corners[2]));
      out.planes.push(crossV(sub(corners[1], corners[0]), sub(corners[2], corners[0])));
      out.cut.push(false);
    } else retriangulatePlane(wasm, planeKey(corners).n, [corners], cons[i], out);
    for (let f = before; f < out.tris.length / 3; f++) { fromB.push(isB[i]); srcTri.push(i); }
  });
  const stitched = stitchSoup(Float64Array.from(out.pts.flat()), out.tris, 2);
  const pts: V3[] = [];
  for (let i = 0; i < stitched.pos.length; i += 3) pts.push([stitched.pos[i], stitched.pos[i + 1], stitched.pos[i + 2]]);
  const flat = splitSlivers(pts, stitched.tris, stitched.origin);

  // Classification by the winding number of each operand on both sides of every piece.
  // Inside test by rays along X, Y and Z, by majority: a ray slipping through a pinhole left by
  // the rounding is outvoted.
  const field3 = (list: [number, number, number][]) => {
    const perms: [number, number, number][] = [[0, 1, 2], [1, 2, 0], [2, 0, 1]];
    const fields = perms.map((pm) => windingField(q.map((p) => [p[pm[0]], p[pm[1]], p[pm[2]]] as V3), list));
    return (p: V3) => fields.reduce((s, fld, k) => s + (fld([p[perms[k][0]], p[perms[k][1]], p[perms[k][2]]]) > 0 ? 1 : 0), 0) >= 2 ? 1 : 0;
  };
  const wA = field3(tris.filter((_, i) => !isB[i]));
  const wB = field3(tris.filter((_, i) => isB[i]));
  const result = (a: boolean, c: boolean) => (op === 'union' ? a || c : op === 'intersect' ? a && c : a && !c);
  const nf = flat.tris.length / 3;
  // Decision of each piece: 1 keep, -1 keep reversed, 0 drop.
  const decide = (f: number): number => {
    const [p0, p1, p2] = [flat.tris[f * 3], flat.tris[f * 3 + 1], flat.tris[f * 3 + 2]];
    const o = flat.origin[f];
    const n = out.planes[o];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    const cx = (pts[p0][0] + pts[p1][0] + pts[p2][0]) / 3 + 0.00731;
    const cy = (pts[p0][1] + pts[p1][1] + pts[p2][1]) / 3 + 0.00419;
    const cz = (pts[p0][2] + pts[p1][2] + pts[p2][2]) / 3 + 0.00283;
    const d = 0.25 / len;
    const front: V3 = [cx + n[0] * d, cy + n[1] * d, cz + n[2] * d], back: V3 = [cx - n[0] * d, cy - n[1] * d, cz - n[2] * d];
    // The piece's own operand: solid behind it, empty in front (3D Builder evaluates only the other).
    const inB = fromB[o];
    const rb = inB ? result(wA(back) > 0, true) : result(true, wB(back) > 0);
    const rf = inB ? result(wA(front) > 0, false) : result(false, wB(front) > 0);
    return rb && !rf ? 1 : rf && !rb ? -1 : 0;
  };
  // Edges of each piece and the operands using them (3D Builder propagates its classification
  // along the surface between intersection curves; 3D Assembler uses that neighbourhood to correct the
  // decisions of slivers along the curves).
  const edgeOwners = new Map<string, { a: number[]; b: number[] }>();
  for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) {
    const u = flat.tris[f * 3 + k], v = flat.tris[f * 3 + ((k + 1) % 3)];
    const key = u < v ? `${u},${v}` : `${v},${u}`;
    let e = edgeOwners.get(key);
    if (!e) edgeOwners.set(key, (e = { a: [], b: [] }));
    (fromB[flat.origin[f]] ? e.b : e.a).push(f);
  }
  // An edge lying on an intersection segment of its source triangle is on a curve, whether or not
  // the other operand's pieces ended up with exactly the same edge.
  const onSegment = (f: number, u: number, v: number) => {
    for (const [s0, s1] of cons[srcTri[flat.origin[f]]]) {
      const d = sub(s1, s0);
      const l2 = dotV(d, d);
      if (!l2) continue;
      const near = (p: V3) => {
        const t = dotV(sub(p, s0), d) / l2;
        if (t < -1e-9 || t > 1 + 1e-9) return false;
        const e = sub(p, [s0[0] + t * d[0], s0[1] + t * d[1], s0[2] + t * d[2]]);
        return dotV(e, e) <= 2.25; // within 1.5 grid units (rounding and stitching)
      };
      if (near(pts[u]) && near(pts[v])) return true;
    }
    return false;
  };
  // Neighbours of each piece within its own operand, across edges that are not on a curve.
  const nbrs: number[][] = Array.from({ length: nf }, () => []);
  for (const [key, e] of edgeOwners) {
    if (e.a.length && e.b.length) continue; // on an intersection curve
    const [u, v] = key.split(',').map(Number);
    const fs = e.a.length ? e.a : e.b;
    if (fs.some((f) => onSegment(f, u, v))) continue;
    for (const f of fs) for (const g of fs) if (f !== g) nbrs[f].push(g);
  }
  const dec = Int8Array.from({ length: nf }, (_, f) => decide(f));
  // A sliver (under two grid units thick) whose sample may fall on the wrong side of the other
  // surface takes the decision its neighbours agree on.
  const thin = Array.from({ length: nf }, (_, f) => {
    const [p0, p1, p2] = [flat.tris[f * 3], flat.tris[f * 3 + 1], flat.tris[f * 3 + 2]];
    const area2 = Math.hypot(...crossV(sub(pts[p1], pts[p0]), sub(pts[p2], pts[p0])));
    const longest = Math.max(Math.hypot(...sub(pts[p1], pts[p0])), Math.hypot(...sub(pts[p2], pts[p1])), Math.hypot(...sub(pts[p0], pts[p2])));
    return longest > 0 && area2 / longest < 2;
  });
  for (let pass = 0; pass < 4; pass++) {
    let changed = 0;
    for (let f = 0; f < nf; f++) {
      if (!thin[f] || !nbrs[f].length) continue;
      const d0 = dec[nbrs[f][0]];
      if (d0 !== dec[f] && nbrs[f].every((g) => dec[g] === d0)) { dec[f] = d0; changed++; }
    }
    if (!changed) break;
  }
  const kept: number[] = [], keptPlanes: V3[] = [], keptCut: boolean[] = [];
  for (let f = 0; f < nf; f++) {
    const [p0, p1, p2] = [flat.tris[f * 3], flat.tris[f * 3 + 1], flat.tris[f * 3 + 2]];
    const o = flat.origin[f], n = out.planes[o];
    if (dec[f] === 1) { kept.push(p0, p1, p2); keptPlanes.push(n); keptCut.push(out.cut[o]); }
    else if (dec[f] === -1) { kept.push(p0, p2, p1); keptPlanes.push([-n[0], -n[1], -n[2]]); keptCut.push(out.cut[o]); }
  }
  // Coincident pieces kept from both operands: one copy (opposite ones cancel).
  const dd = dedupe(kept, keptPlanes, keptCut);
  // Tiny gaps left by the rounding along the curves are closed, as in the Wrap.
  fillPinholes(pts, dd.tris, dd.planeOf, dd.cutOf, 64);
  const positions = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => { for (let k = 0; k < 3; k++) positions[i * 3 + k] = p[k] * unit + b.min[k]; });
  return { positions, indices: new Uint32Array(dd.tris) };
}

/**
 * Rounding to the grid can flatten a thin sliver: its third corner ends up on (or within half a
 * unit of) its long edge. Such a face is a T-junction in disguise; its long edge is often left
 * open, and one open edge lets the air flood the whole inside. Each flat face is removed and every
 * face across its long edge is split at the third corner, which keeps the surface closed.
 */
export function splitSlivers(pts: V3[], input: number[], origin: number[], eps = 0.5): { tris: number[]; origin: number[] } {
  let tris = input.slice(), org = origin.slice();
  const nv = pts.length;
  const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  for (let round = 0; round < 8; round++) {
    const nt = tris.length / 3;
    const edgeFaces = new Map<number, number[]>();
    for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) {
      const kk = key(tris[f * 3 + k], tris[f * 3 + ((k + 1) % 3)]);
      const l = edgeFaces.get(kk);
      if (l) l.push(f);
      else edgeFaces.set(kk, [f]);
    }
    const dead = new Uint8Array(nt);
    const splits = new Map<number, [number, number, number]>(); // face -> (a, b, m) edge split
    let changed = false;
    for (let f = 0; f < nt; f++) {
      if (dead[f] || splits.has(f)) continue;
      const t = [tris[f * 3], tris[f * 3 + 1], tris[f * 3 + 2]];
      if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) continue;
      let k = 0, best = -1;
      for (let e = 0; e < 3; e++) {
        const l = Math.hypot(...sub(pts[t[(e + 1) % 3]], pts[t[e]]));
        if (l > best) { best = l; k = e; }
      }
      const a = t[k], b = t[(k + 1) % 3], m = t[(k + 2) % 3];
      const area2 = Math.hypot(...crossV(sub(pts[b], pts[a]), sub(pts[m], pts[a])));
      if (!best || area2 / best >= eps) continue;
      const across = edgeFaces.get(key(a, b))!.filter((g) => g !== f);
      if (across.some((g) => dead[g] || splits.has(g))) continue;
      dead[f] = 1;
      for (const g of across) splits.set(g, [a, b, m]);
      changed = true;
    }
    if (!changed) break;
    const next: number[] = [], nextOrg: number[] = [];
    for (let f = 0; f < nt; f++) {
      if (dead[f]) continue;
      const t = [tris[f * 3], tris[f * 3 + 1], tris[f * 3 + 2]];
      const s = splits.get(f);
      if (!s) {
        next.push(...t);
        nextOrg.push(org[f]);
        continue;
      }
      const [a, b, m] = s;
      // Rotate so that the split edge is t[0]-t[1] (either direction).
      let r = 0;
      while (!((t[r] === a && t[(r + 1) % 3] === b) || (t[r] === b && t[(r + 1) % 3] === a))) r++;
      const p = t[r], q = t[(r + 1) % 3], x = t[(r + 2) % 3];
      if (m !== x) {
        next.push(p, m, x, m, q, x);
        nextOrg.push(org[f], org[f]);
      }
    }
    tris = next;
    org = nextOrg;
  }
  return { tris, origin: org };
}

/**
 * Closes the pinholes rounding leaves between tangled slivers (loops of open edges a few grid units
 * around) with a fan, in place. A single leak would let the air flood the whole inside.
 */
function fillPinholes(pts: V3[], tris: number[], planeOf: V3[], cutOf: boolean[], maxPerimeter: number) {
  const nv = pts.length;
  const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  const use = new Map<number, { n: number; a: number; b: number; f: number }>();
  for (let f = 0; f < tris.length / 3; f++) for (let k = 0; k < 3; k++) {
    const a = tris[f * 3 + k], b = tris[f * 3 + ((k + 1) % 3)];
    const kk = key(a, b);
    const u = use.get(kk);
    if (u) u.n++;
    else use.set(kk, { n: 1, a, b, f });
  }
  // Open edges as an undirected graph; the orientation of the soup is not consistent here.
  type Step = { to: number; e: { a: number; b: number; f: number; done: boolean } };
  const next = new Map<number, Step[]>();
  for (const u of use.values()) {
    if (u.n !== 1) continue;
    const e = { a: u.a, b: u.b, f: u.f, done: false };
    for (const [p, q] of [[u.a, u.b], [u.b, u.a]]) {
      const l = next.get(p);
      if (l) l.push({ to: q, e });
      else next.set(p, [{ to: q, e }]);
    }
  }
  const len = (a: number, b: number) => Math.hypot(...sub(pts[a], pts[b]));
  for (const start of [...next.keys()]) {
    for (;;) {
      if (!next.get(start)!.some((s) => !s.e.done)) break;
      const loop = [start];
      const steps: Step[] = [];
      let perimeter = 0, cur = start, closed = false;
      while (loop.length < 64) {
        // Prefer closing the loop; otherwise take the shortest unused edge.
        const l = next.get(cur)!.filter((s) => !s.e.done);
        if (!l.length) break;
        const step = l.find((s) => s.to === start && steps.length >= 2) ?? l.sort((x, y) => len(cur, x.to) - len(cur, y.to))[0];
        step.e.done = true;
        steps.push(step);
        perimeter += len(cur, step.to);
        if (step.to === start) { closed = true; break; }
        loop.push(step.to);
        cur = step.to;
      }
      if (!closed || loop.length < 3) continue;
      if (perimeter > maxPerimeter) {
        // A larger hole is only filled when it is flat: a gap left in a plane's re-triangulation.
        const n = planeOf[steps[0].e.f];
        const nl = Math.hypot(...n) || 1;
        const off = (v: number) => Math.abs(dotV(n, sub(pts[v], pts[loop[0]]))) / nl;
        if (loop.some((v) => off(v) > 1)) continue;
      }
      // Orientation: walk each open edge against its face's direction (majority vote).
      let vote = 0;
      loop.forEach((v, i) => (vote += steps[i].e.b === v ? 1 : -1));
      if (vote < 0) loop.reverse();
      const plane = planeOf[steps[0].e.f];
      for (let i = 1; i + 1 < loop.length; i++) {
        tris.push(loop[0], loop[i], loop[i + 1]);
        const n = crossV(sub(pts[loop[i]], pts[loop[0]]), sub(pts[loop[i + 1]], pts[loop[0]]));
        planeOf.push(n[0] || n[1] || n[2] ? n : plane);
        cutOf.push(true);
      }
    }
  }
}

function dedupe(tris: number[], planes: V3[], cuts: boolean[]): { tris: number[]; planeOf: V3[]; cutOf: boolean[] } {
  const planeOf: V3[] = [];
  const cutOf: boolean[] = [];
  const groups = new Map<string, number[]>();
  for (let f = 0; f < tris.length / 3; f++) {
    const t = tris.slice(f * 3, f * 3 + 3);
    if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) continue;
    const key = [...t].sort((a, b) => a - b).join(',');
    const l = groups.get(key);
    if (l) l.push(f);
    else groups.set(key, [f]);
  }
  const out: number[] = [];
  for (const fs of groups.values()) {
    const parity = (f: number) => {
      const [a, b, c] = tris.slice(f * 3, f * 3 + 3);
      return (a < b ? 1 : 0) + (b < c ? 1 : 0) + (c < a ? 1 : 0) === 2;
    };
    const pos = fs.filter(parity), neg = fs.filter((f) => !parity(f));
    const net = pos.length - neg.length;
    const pick = net > 0 ? pos[0] : net < 0 ? neg[0] : -1;
    if (pick >= 0) {
      const t = tris.slice(pick * 3, pick * 3 + 3);
      out.push(...t);
      planeOf.push(planes[pick]);
      cutOf.push(fs.length > 1 || cuts[pick]);
    }
  }
  return { tris: out, planeOf, cutOf };
}
