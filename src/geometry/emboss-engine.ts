// Emboss engine modelled on 3D Builder's (see docs/3d-builder-tools.md, "Le moteur du Relief"):
// no boolean operation. A projector maps the surface to a 2D UV space; the motif contours are cut
// into the triangles of the facing patch in that space; then the vertices under the motif are
// copied and moved along the projection direction, with walls along the motif boundary.
// Clean-room implementation from the documented behaviour.
import type { CrossSection, ManifoldToplevel } from 'manifold-3d';
import { NO_PAINT } from '../core/model';
import type { MeshData } from '../core/mesh-data';
import { bounds } from '../core/mesh-data';
import { separateNonManifold, stitchSoup } from '../repair/repair';
import { splitSlivers } from '../repair/wrap';
import { loadManifold } from './csg';
import { simplifyFlat } from './decimate';

type V3 = [number, number, number];
type V2 = [number, number];
export type Polygon = V2[];
export type Direction = '-y' | '+y' | '-x' | '+x' | '+z';
export type Projection = 'planar' | 'cylindrical' | 'spherical';

export interface EmbossOptions {
  outline: Polygon[]; // mm, centred on the motif
  projection?: Projection;
  direction: Direction; // the side the projector faces
  offsetU: number; // mm along the surface
  offsetV: number;
  rotation: number; // degrees
  depth: number; // mm: > 0 raised, < 0 engraved
  /** 3D Builder's "Biseau": a 45° bevelled roof (straight skeleton) instead of vertical walls. */
  bevel?: boolean;
  /**
   * Bevel height as a fraction of the roof's top (3D Builder's Biseau "Z", shown in %, default 50):
   * the 45° roof is cut flat at this fraction of its highest point. Without it, |depth| in mm.
   */
  bevelHeight?: number;
  /** Existing per-face colours of the object (NO_PAINT = none). */
  faceColors?: Uint32Array;
  /** 0xRRGGBB colour of the top of the motif, and of its sides (walls or bevel). */
  topColor?: number;
  sideColor?: number;
}

export interface EmbossResult {
  mesh: MeshData;
  faceColors?: Uint32Array;
}

const COS_88 = Math.cos((88 * Math.PI) / 180);
const COS_1 = Math.cos(Math.PI / 180);

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** Projection frame of a side: d = towards the viewer, u = right, v = up. */
export function frame(dir: Direction): { d: V3; u: V3; v: V3 } {
  switch (dir) {
    case '-y': return { d: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] };
    case '+y': return { d: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] };
    case '-x': return { d: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] };
    case '+x': return { d: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] };
    case '+z': return { d: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] };
  }
}

// --- projector ---------------------------------------------------------------------------------------

interface Projector {
  /** Surface point -> motif plane (mm), or null where the map is undefined (on the axis). */
  uv(p: V3): V2 | null;
  /** Unit projection direction at a surface point (outwards). */
  dir(p: V3): V3;
  /** Ray that finds the seed triangle. */
  ray: { o: V3; d: V3 };
  /** Half the period of u for wrapping projections (a triangle spanning more lies across the seam). */
  seam: number;
}

function rayHit(P: Float32Array, I: Uint32Array, o: V3, d: V3, maxT = Infinity): number {
  let best = -1, bestT = maxT;
  for (let f = 0; f < I.length / 3; f++) {
    const a: V3 = [P[I[f * 3] * 3], P[I[f * 3] * 3 + 1], P[I[f * 3] * 3 + 2]];
    const b: V3 = [P[I[f * 3 + 1] * 3], P[I[f * 3 + 1] * 3 + 1], P[I[f * 3 + 1] * 3 + 2]];
    const c: V3 = [P[I[f * 3 + 2] * 3], P[I[f * 3 + 2] * 3 + 1], P[I[f * 3 + 2] * 3 + 2]];
    const e1 = sub(b, a), e2 = sub(c, a);
    const h = cross(d, e2);
    const det = dot(e1, h);
    if (Math.abs(det) < 1e-12) continue;
    const s = sub(o, a);
    const u = dot(s, h) / det;
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1);
    const v = dot(d, q) / det;
    if (v < 0 || u + v > 1) continue;
    const t = dot(e2, q) / det;
    if (t >= 0 && t < bestT) { bestT = t; best = f; }
  }
  return best;
}

function makeProjector(mesh: MeshData, o: EmbossOptions): Projector {
  const b = bounds(mesh);
  const c: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const far = diag * 2 + 1;
  const { d, u, v } = frame(o.direction);
  let projection = o.projection ?? 'planar';
  if (projection === 'cylindrical' && o.direction === '+z') projection = 'planar';
  if (projection === 'planar') {
    const O = add(add(c, u, o.offsetU), v, o.offsetV);
    return { uv: (p) => [dot(sub(p, O), u), dot(sub(p, O), v)], dir: () => d, ray: { o: add(O, d, far), d: [-d[0], -d[1], -d[2]] }, seam: Infinity };
  }
  // Radius at the motif's centre: distance from the axis (or centre) to the surface along d.
  const radiusAt = (from: V3, dir: V3) => {
    const P = mesh.positions, I = mesh.indices;
    const back: V3 = [-dir[0], -dir[1], -dir[2]];
    const f = rayHit(P, I, add(from, dir, far), back);
    if (f < 0) return diag / 2;
    // Distance along dir to the hit plane.
    const a: V3 = [P[I[f * 3] * 3], P[I[f * 3] * 3 + 1], P[I[f * 3] * 3 + 2]];
    const bb: V3 = [P[I[f * 3 + 1] * 3], P[I[f * 3 + 1] * 3 + 1], P[I[f * 3 + 1] * 3 + 2]];
    const cc: V3 = [P[I[f * 3 + 2] * 3], P[I[f * 3 + 2] * 3 + 1], P[I[f * 3 + 2] * 3 + 2]];
    const n = cross(sub(bb, a), sub(cc, a));
    const den = dot(n, dir);
    return Math.max(1e-3, Math.abs(den) > 1e-12 ? dot(n, sub(a, from)) / den : diag / 2);
  };
  if (projection === 'cylindrical') {
    // Axis: vertical (local Z = v) through the object's centre.
    const ref: V3 = [c[0], c[1], c[2] + o.offsetV];
    const R0 = radiusAt(ref, d);
    const a0 = o.offsetU / R0;
    const dirH: V3 = add([d[0] * Math.cos(a0), d[1] * Math.cos(a0), d[2] * Math.cos(a0)], u, Math.sin(a0));
    const R = radiusAt(ref, dirH);
    return {
      uv: (p) => {
        const q = sub(p, c);
        const x = dot(q, d), y = dot(q, u);
        if (Math.hypot(x, y) < 1e-5) return null;
        return [Math.atan2(y, x) * R - o.offsetU, dot(q, v) - o.offsetV];
      },
      dir: (p) => {
        const q = sub(p, c);
        const x = dot(q, d), y = dot(q, u);
        const r = Math.hypot(x, y) || 1;
        return add([(d[0] * x) / r, (d[1] * x) / r, (d[2] * x) / r], u, y / r);
      },
      ray: { o: add(ref, dirH, far), d: [-dirH[0], -dirH[1], -dirH[2]] },
      seam: Math.PI * R,
    };
  }
  // Spherical, about the object's centre.
  const R0 = radiusAt(c, d);
  const a0 = o.offsetU / R0, b0 = o.offsetV / R0;
  const dirC: V3 = [0, 1, 2].map((k) => Math.cos(b0) * (Math.cos(a0) * d[k] + Math.sin(a0) * u[k]) + Math.sin(b0) * v[k]) as V3;
  const R = radiusAt(c, dirC);
  return {
    uv: (p) => {
      const q = sub(p, c);
      const r = len(q);
      if (r < 1e-5) return null;
      const x = dot(q, d), y = dot(q, u), z = dot(q, v);
      return [Math.atan2(y, x) * R - o.offsetU, Math.asin(Math.max(-1, Math.min(1, z / r))) * R - o.offsetV];
    },
    dir: (p) => {
      const q = sub(p, c);
      const r = len(q) || 1;
      return [q[0] / r, q[1] / r, q[2] / r];
    },
    ray: { o: add(c, dirC, far), d: [-dirC[0], -dirC[1], -dirC[2]] },
    seam: Math.PI * R,
  };
}

// --- 2D helpers ----------------------------------------------------------------------------------

function insidePoly(p: V2, poly: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segsCross(a: V2, b: V2, c: V2, d: V2): boolean {
  const o = (p: V2, q: V2, r: V2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0) !== (d2 > 0) || d1 === 0 || d2 === 0) && ((d3 > 0) !== (d4 > 0) || d3 === 0 || d4 === 0);
}

interface Rect { x0: number; y0: number; x1: number; y1: number }

/** 3D Builder's refinement: the motif frame, split in four while a cell holds over 100 points. */
function quadtree(box: Rect, pts: V2[]): Rect[] {
  const leaves: Rect[] = [];
  const rec = (r: Rect, inside: V2[], depth: number) => {
    if (inside.length <= 100 || depth > 10) { leaves.push(r); return; }
    const mx = (r.x0 + r.x1) / 2, my = (r.y0 + r.y1) / 2;
    const quads: Rect[] = [
      { x0: r.x0, y0: r.y0, x1: mx, y1: my }, { x0: mx, y0: r.y0, x1: r.x1, y1: my },
      { x0: r.x0, y0: my, x1: mx, y1: r.y1 }, { x0: mx, y0: my, x1: r.x1, y1: r.y1 },
    ];
    for (const q of quads) rec(q, inside.filter((p) => p[0] >= q.x0 && p[0] <= q.x1 && p[1] >= q.y0 && p[1] <= q.y1), depth + 1);
  };
  rec(box, pts, 0);
  return leaves;
}

// --- engine --------------------------------------------------------------------------------------

export async function embossMesh(input: MeshData, o: EmbossOptions): Promise<EmbossResult> {
  const wasm = await loadManifold();
  const b0 = bounds(input);
  const size = Math.max(b0.max[0] - b0.min[0], b0.max[1] - b0.min[1], b0.max[2] - b0.min[2]) || 1;
  const tol = 1e-6 * size;
  // Final cleanup as 3D Builder: decimation with a maximum deviation of 1e-5 × the smallest side.
  const minSide = Math.min(b0.max[0] - b0.min[0], b0.max[1] - b0.min[1], b0.max[2] - b0.min[2]) || size;
  // Contours touching at a single point give a wall edge shared by four faces: separate them.
  const finish = (mesh: MeshData, faceColors?: Uint32Array): EmbossResult => {
    const closed = closeTrivialHoles(mesh, faceColors);
    const r = simplifyFlat(closed.mesh, 1e-5 * minSide, closed.faceColors);
    return { mesh: separateNonManifold(r.mesh), faceColors: r.faceColors };
  };

  // Welded working copy (adjacency by shared vertices).
  const welded = stitchSoup(Float64Array.from(input.positions), Array.from(input.indices), tol);
  const P = welded.pos, T = welded.tris;
  const nt = T.length / 3;
  const colorOf = (f: number) => (o.faceColors ? o.faceColors[welded.origin[f]] : NO_PAINT);
  const vtx = (i: number): V3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const proj = makeProjector(input, o);

  // Motif in UV (rotated about its centre).
  const ang = (o.rotation * Math.PI) / 180;
  const rotated: Polygon[] = o.outline.filter((p) => p.length >= 3).map((p) => p.map(([x, y]) => [x * Math.cos(ang) - y * Math.sin(ang), x * Math.sin(ang) + y * Math.cos(ang)] as V2));
  // Clean outline of the filled contours (overlaps merged, as in 3D Builder): the
  // zero-width spikes that pixel-centre tracing leaves on 1-pixel strokes disappear.
  let polys: Polygon[] = rotated;
  if (rotated.length) {
    const clean = new wasm.CrossSection(rotated, 'EvenOdd');
    polys = (clean.toPolygons() as unknown as Polygon[]).filter((p) => p.length >= 3);
    clean.delete();
  }
  if (!polys.length) return { mesh: input, faceColors: o.faceColors };
  const box: Rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of polys) for (const [x, y] of p) {
    box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y);
    box.x1 = Math.max(box.x1, x); box.y1 = Math.max(box.y1, y);
  }
  if (box.x1 - box.x0 < 1e-4 || box.y1 - box.y0 < 1e-4) return { mesh: input, faceColors: o.faceColors };

  // Per-vertex UV and per-face validity (undefined map, or across the seam).
  const vUV: (V2 | null)[] = [];
  for (let i = 0; i < P.length / 3; i++) vUV.push(proj.uv(vtx(i)));
  const faceUV = (f: number): V2[] | null => {
    const t = [vUV[T[f * 3]], vUV[T[f * 3 + 1]], vUV[T[f * 3 + 2]]];
    if (t.some((x) => !x)) return null;
    const us = t.map((x) => x![0]);
    if (Math.max(...us) - Math.min(...us) > proj.seam) return null;
    return t as V2[];
  };

  // Adjacency.
  const nv = P.length / 3;
  const ekey = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  const edgeFaces = new Map<number, number[]>();
  for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) {
    const kk = ekey(T[f * 3 + k], T[f * 3 + ((k + 1) % 3)]);
    const l = edgeFaces.get(kk);
    if (l) l.push(f);
    else edgeFaces.set(kk, [f]);
  }
  const neighbours = (f: number) => {
    const out: number[] = [];
    for (let k = 0; k < 3; k++) for (const g of edgeFaces.get(ekey(T[f * 3 + k], T[f * 3 + ((k + 1) % 3)]))!) if (g !== f) out.push(g);
    return out;
  };

  // 1. Facing patch: flood from the triangle under the projector's ray.
  const seed = rayHit(Float32Array.from(P), Uint32Array.from(T), proj.ray.o, proj.ray.d);
  if (seed < 0) return { mesh: input, faceColors: o.faceColors };
  const accepted = new Uint8Array(nt);
  const seen = new Uint8Array(nt);
  const rejected: number[] = [];
  const queue = [seed];
  seen[seed] = 1;
  const pad = 1e-6 * size;
  while (queue.length) {
    const f = queue.pop()!;
    const uv = faceUV(f);
    if (!uv) continue;
    const fx0 = Math.min(uv[0][0], uv[1][0], uv[2][0]), fx1 = Math.max(uv[0][0], uv[1][0], uv[2][0]);
    const fy0 = Math.min(uv[0][1], uv[1][1], uv[2][1]), fy1 = Math.max(uv[0][1], uv[1][1], uv[2][1]);
    if (fx1 < box.x0 - pad || fx0 > box.x1 + pad || fy1 < box.y0 - pad || fy0 > box.y1 + pad) continue;
    const A = vtx(T[f * 3]), B = vtx(T[f * 3 + 1]), C = vtx(T[f * 3 + 2]);
    const n = cross(sub(B, A), sub(C, A));
    const nl = len(n);
    const centroid: V3 = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3];
    const facing = nl > 0 && dot(n, proj.dir(centroid)) / nl > COS_88;
    const e = [len(sub(B, A)), len(sub(C, B)), len(sub(A, C))];
    const corner = (p: V3, q: V3, r: V3) => {
      const x = sub(q, p), y = sub(r, p);
      const l = len(x) * len(y);
      return l ? dot(x, y) / l : 1;
    };
    const wellShaped = Math.min(...e) > 0 && Math.max(...e) / Math.min(...e) <= 300 &&
      [corner(A, B, C), corner(B, C, A), corner(C, A, B)].every((cs) => Math.abs(cs) < COS_1);
    if (!facing && wellShaped) { rejected.push(f); continue; }
    accepted[f] = 1;
    for (const g of neighbours(f)) if (!seen[g]) { seen[g] = 1; queue.push(g); }
  }
  for (const f of rejected) if (neighbours(f).every((g) => accepted[g])) accepted[f] = 1;

  // 2. Cut the motif into the patch: motif frame, quadtree lines and contour edges.
  const contourPts = polys.flat();
  const leaves = quadtree(box, contourPts);
  const segs: [V2, V2][] = [];
  const addSegs = (ps: Polygon[]) => {
    for (const p of ps) for (let i = 0; i < p.length; i++) segs.push([p[i], p[(i + 1) % p.length]]);
  };
  addSegs(polys);
  const cs: CrossSection[] = [];
  const motifCS = new wasm.CrossSection(polys, 'EvenOdd');
  const boxCS = new wasm.CrossSection([[[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]]], 'Positive');
  cs.push(motifCS, boxCS);
  // Zones that partition the motif frame. Flat: inside / outside the motif. Bevel: the bands
  // between successive mitred inward offsets (the straight-skeleton wavefront) plus the plateau.
  const zones: CrossSection[] = [boxCS.subtract(motifCS)];
  cs.push(zones[0]);
  let roof: Roof | null = null;
  if (o.bevel) {
    roof = await buildRoof(wasm, motifCS, Math.abs(o.depth), o.bevelHeight);
    zones.push(...roof.zones);
    cs.push(...roof.zones);
    addSegs(roof.polys);
  } else zones.push(motifCS);
  const zoneBB = zones.map((z) => {
    const ps = z.toPolygons() as unknown as Polygon[];
    return ps.length ? rectOf(ps.flat()) : null;
  });
  const leafCS = leaves.map((r) => new wasm.CrossSection([[[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]]], 'Positive'));
  cs.push(...leafCS);

  const outPos: number[] = Array.from(P);
  const outTri: number[] = [];
  const outOrigin: number[] = []; // welded face index
  const newVertex = (p: V3) => {
    outPos.push(p[0], p[1], p[2]);
    return outPos.length / 3 - 1;
  };
  try {
    for (let f = 0; f < nt; f++) {
      const t = [T[f * 3], T[f * 3 + 1], T[f * 3 + 2]];
      const uv = accepted[f] ? faceUV(f) : null;
      if (!uv || !needsCut(uv, box, leaves, segs)) {
        outTri.push(...t);
        outOrigin.push(f);
        continue;
      }
      // Counter-clockwise copy of the triangle in UV.
      const area = (uv[1][0] - uv[0][0]) * (uv[2][1] - uv[0][1]) - (uv[1][1] - uv[0][1]) * (uv[2][0] - uv[0][0]);
      if (Math.abs(area) < 1e-14) {
        outTri.push(...t);
        outOrigin.push(f);
        continue;
      }
      const flip = area < 0;
      const order = flip ? [0, 2, 1] : [0, 1, 2];
      const tv = order.map((k) => t[k]), tuv = order.map((k) => uv[k]);
      const tri3 = tv.map(vtx);
      const triCS = new wasm.CrossSection([tuv], 'Positive');
      const pieces: CrossSection[] = [];
      try {
        pieces.push(triCS.subtract(boxCS));
        leaves.forEach((r, i) => {
          if (r.x1 < Math.min(tuv[0][0], tuv[1][0], tuv[2][0]) || r.x0 > Math.max(tuv[0][0], tuv[1][0], tuv[2][0])) return;
          if (r.y1 < Math.min(tuv[0][1], tuv[1][1], tuv[2][1]) || r.y0 > Math.max(tuv[0][1], tuv[1][1], tuv[2][1])) return;
          const cell = triCS.intersect(leafCS[i]);
          const cx0 = Math.max(r.x0, Math.min(tuv[0][0], tuv[1][0], tuv[2][0])), cx1 = Math.min(r.x1, Math.max(tuv[0][0], tuv[1][0], tuv[2][0]));
          const cy0 = Math.max(r.y0, Math.min(tuv[0][1], tuv[1][1], tuv[2][1])), cy1 = Math.min(r.y1, Math.max(tuv[0][1], tuv[1][1], tuv[2][1]));
          zones.forEach((z, zi) => {
            const b = zoneBB[zi];
            if (!b || b.x1 < cx0 || b.x0 > cx1 || b.y1 < cy0 || b.y0 > cy1) return;
            pieces.push(cell.intersect(z));
          });
          cell.delete();
        });
        const den = area * (flip ? -1 : 1);
        for (const piece of pieces) {
          const contours = piece.toPolygons() as unknown as V2[][];
          if (!contours.length) continue;
          const flatPts = contours.flat();
          const ids = flatPts.map((q) => {
            // Barycentric coordinates in the (counter-clockwise) UV triangle.
            const l1 = ((tuv[1][0] - q[0]) * (tuv[2][1] - q[1]) - (tuv[1][1] - q[1]) * (tuv[2][0] - q[0])) / den;
            const l2 = ((tuv[2][0] - q[0]) * (tuv[0][1] - q[1]) - (tuv[2][1] - q[1]) * (tuv[0][0] - q[0])) / den;
            const l3 = 1 - l1 - l2;
            const ls = [l1, l2, l3];
            for (let k = 0; k < 3; k++) if (Math.abs(ls[k] - 1) < 1e-9) return tv[k];
            return newVertex([0, 1, 2].map((a) => l1 * tri3[0][a] + l2 * tri3[1][a] + l3 * tri3[2][a]) as V3);
          });
          for (const [i, j, k] of triangulateSafe(wasm, contours)) {
            if (flip) outTri.push(ids[i], ids[k], ids[j]);
            else outTri.push(ids[i], ids[j], ids[k]);
            outOrigin.push(f);
          }
        }
      } finally {
        triCS.delete();
        for (const x of pieces) x.delete();
      }
    }
  } finally {
    for (const x of cs) x.delete();
  }

  // Weld the cut points shared by neighbouring triangles, close T-junctions.
  const cut = stitchSoup(Float64Array.from(outPos), outTri, tol);
  const pos: number[] = Array.from(cut.pos);
  // Collinear cut points along a triangle edge can give flat triangles: split them away.
  const pts3: V3[] = [];
  for (let i = 0; i < pos.length / 3; i++) pts3.push([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
  const flat = splitSlivers(pts3, cut.tris, cut.origin, tol);
  const tri: number[] = flat.tris;
  const origin: number[] = flat.origin.map((i) => outOrigin[i]);
  const inPatch = origin.map((f) => !!accepted[f]);
  const base: V3[] = [];
  for (let i = 0; i < pos.length / 3; i++) base.push([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
  const uvOf = (i: number) => proj.uv(base[i]);
  const faceCentroidUV = (f: number): V2 | null => {
    const q = [uvOf(tri[f * 3]), uvOf(tri[f * 3 + 1]), uvOf(tri[f * 3 + 2])];
    if (q.some((x) => !x)) return null;
    return [(q[0]![0] + q[1]![0] + q[2]![0]) / 3, (q[0]![1] + q[1]![1] + q[2]![1]) / 3];
  };
  const centroidUV = tri.map((_, i) => i).filter((i) => i % 3 === 0).map((i) => (inPatch[i / 3] ? faceCentroidUV(i / 3) : null));
  const isWall: boolean[] = origin.map(() => false);
  const winding = new Int32Array(origin.length);

  if (roof) {
    // Bevel: a continuous height field (straight-skeleton roof), no wall.
    const patchVertices = new Set<number>();
    for (let f = 0; f < tri.length / 3; f++) if (inPatch[f]) for (let k = 0; k < 3; k++) patchVertices.add(tri[f * 3 + k]);
    const h = new Float64Array(base.length);
    const caps = new Float64Array(base.length).fill(roof.cap);
    const eps = 1e-6 * Math.max(box.x1 - box.x0, box.y1 - box.y0);
    for (const i of patchVertices) {
      const q = uvOf(i);
      if (q) { h[i] = roofHeight(roof, q, eps * 10); caps[i] = lastCap; }
    }
    const sign = o.depth >= 0 ? 1 : -1;
    for (let i = 0; i < base.length; i++) {
      if (!h[i]) continue;
      const p = add(base[i], proj.dir(base[i]), sign * h[i]);
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
    }
    const colors = paintBevel(h, caps); // top = the plateau of each part (or its roof's top)
    return finish({ positions: Float32Array.from(pos), indices: Uint32Array.from(tri) }, colors);
  }

  // 3. Flat profile: one pass per contour, like 3D Builder. Outer contours go up by the depth,
  //    holes go back down, so nested contours stack.
  for (let k = 0; k < polys.length; k++) {
    const poly = polys[k];
    let nest = 0;
    for (let j = 0; j < polys.length; j++) if (j !== k && insidePoly(poly[0], polys[j])) nest++;
    const sign = nest % 2 ? -1 : 1;
    const D = sign * o.depth;
    const S = new Set<number>();
    for (let f = 0; f < tri.length / 3; f++) {
      const c = centroidUV[f];
      if (c && !isWall[f] && insidePoly(c, poly)) S.add(f);
    }
    if (!S.size) continue;
    const directed = new Map<string, number[]>();
    for (let f = 0; f < tri.length / 3; f++) for (let e = 0; e < 3; e++) {
      const key = `${tri[f * 3 + e]},${tri[f * 3 + ((e + 1) % 3)]}`;
      const l = directed.get(key);
      if (l) l.push(f);
      else directed.set(key, [f]);
    }
    const copy = new Map<number, number>();
    const copyOf = (v: number) => {
      let c = copy.get(v);
      if (c === undefined) {
        const p = add([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]], proj.dir(base[v]), D);
        pos.push(p[0], p[1], p[2]);
        base.push(base[v]);
        c = pos.length / 3 - 1;
        copy.set(v, c);
      }
      return c;
    };
    const walls: number[] = [];
    const wallOrigin: number[] = [];
    for (const f of S) {
      for (let e = 0; e < 3; e++) {
        const a = tri[f * 3 + e], bb = tri[f * 3 + ((e + 1) % 3)];
        const across = directed.get(`${bb},${a}`) ?? [];
        if (across.some((g) => S.has(g))) continue;
        const a2 = copyOf(a), b2 = copyOf(bb);
        walls.push(a, bb, b2, a, b2, a2);
        wallOrigin.push(origin[f], origin[f]);
      }
    }
    for (const f of S) {
      for (let e = 0; e < 3; e++) tri[f * 3 + e] = copyOf(tri[f * 3 + e]);
      winding[f] += sign;
    }
    for (let i = 0; i < walls.length / 3; i++) {
      tri.push(walls[i * 3], walls[i * 3 + 1], walls[i * 3 + 2]);
      origin.push(wallOrigin[i]);
      isWall.push(true);
      centroidUV.push(null);
    }
  }

  // Colours: top where the motif is raised (winding > 0), sides on the walls.
  let faceColors: Uint32Array | undefined;
  if (o.faceColors || o.topColor !== undefined || o.sideColor !== undefined) {
    faceColors = new Uint32Array(origin.length);
    for (let f = 0; f < origin.length; f++) {
      let c = colorOf(origin[f]);
      if (isWall[f] && o.sideColor !== undefined) c = o.sideColor;
      else if (!isWall[f] && f < winding.length && winding[f] > 0 && o.topColor !== undefined) c = o.topColor;
      faceColors[f] = c;
    }
  }
  return finish({ positions: Float32Array.from(pos), indices: Uint32Array.from(tri) }, faceColors);

  function paintBevel(h: Float64Array, caps: Float64Array): Uint32Array | undefined {
    if (!o.faceColors && o.topColor === undefined && o.sideColor === undefined) return undefined;
    const out = new Uint32Array(origin.length);
    for (let f = 0; f < origin.length; f++) {
      const vs = [tri[f * 3], tri[f * 3 + 1], tri[f * 3 + 2]];
      const hs = vs.map((v) => h[v]);
      let c = colorOf(origin[f]);
      if (hs.some((x, k) => x > Math.max(0.001 * caps[vs[k]], 1e-6))) {
        const top = hs.every((x, k) => x > caps[vs[k]] - 0.001 * caps[vs[k]]);
        if (top && o.topColor !== undefined) c = o.topColor;
        else if (!top && o.sideColor !== undefined) c = o.sideColor;
      }
      out[f] = c;
    }
    return out;
  }
}

/**
 * Closes the open loops of 3 or 4 edges left by near-coincident cut points (as the trivial-hole
 * step of 3D Builder's repair). The new faces take the colour of a neighbour.
 */
function closeTrivialHoles(mesh: MeshData, faceColors?: Uint32Array): { mesh: MeshData; faceColors?: Uint32Array } {
  const I = mesh.indices;
  const nt = I.length / 3;
  const directed = new Map<string, number>();
  for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) directed.set(`${I[f * 3 + k]},${I[f * 3 + ((k + 1) % 3)]}`, f);
  // Open edge a→b (no b→a): the hole runs b→a. Map each hole step start → end.
  const next = new Map<number, { to: number; face: number }>();
  let ambiguous = false;
  for (const [key, f] of directed) {
    const [a, b] = key.split(',').map(Number);
    if (directed.has(`${b},${a}`)) continue;
    if (next.has(b)) ambiguous = true;
    next.set(b, { to: a, face: f });
  }
  if (!next.size || ambiguous) return { mesh, faceColors };
  const add: number[] = [], addColor: number[] = [];
  const done = new Set<number>();
  for (const start of next.keys()) {
    if (done.has(start)) continue;
    const loop = [start];
    let cur = next.get(start)!.to;
    while (cur !== start && loop.length < 5 && next.has(cur)) { loop.push(cur); cur = next.get(cur)!.to; }
    if (cur !== start || loop.length > 4) continue;
    for (const v of loop) done.add(v);
    for (let i = 1; i + 1 < loop.length; i++) {
      add.push(loop[0], loop[i], loop[i + 1]);
      if (faceColors) addColor.push(faceColors[next.get(start)!.face]);
    }
  }
  if (!add.length) return { mesh, faceColors };
  const idx = new Uint32Array(I.length + add.length);
  idx.set(I);
  idx.set(add, I.length);
  let cols = faceColors;
  if (faceColors) {
    cols = new Uint32Array(faceColors.length + addColor.length);
    cols.set(faceColors);
    cols.set(addColor, faceColors.length);
  }
  return { mesh: { positions: mesh.positions, indices: idx }, faceColors: cols };
}

/** Whether a patch triangle (UV corners) is crossed by the motif frame, a quadtree line or a contour edge. */
function needsCut(uv: V2[], box: Rect, leaves: Rect[], segs: [V2, V2][]): boolean {
  const x0 = Math.min(uv[0][0], uv[1][0], uv[2][0]), x1 = Math.max(uv[0][0], uv[1][0], uv[2][0]);
  const y0 = Math.min(uv[0][1], uv[1][1], uv[2][1]), y1 = Math.max(uv[0][1], uv[1][1], uv[2][1]);
  if (x1 <= box.x0 || x0 >= box.x1 || y1 <= box.y0 || y0 >= box.y1) return false;
  // Not inside a single quadtree cell: crossed by a cell line.
  if (!leaves.some((r) => x0 >= r.x0 && x1 <= r.x1 && y0 >= r.y0 && y1 <= r.y1)) return true;
  for (const [a, b] of segs) {
    if (Math.max(a[0], b[0]) < x0 || Math.min(a[0], b[0]) > x1 || Math.max(a[1], b[1]) < y0 || Math.min(a[1], b[1]) > y1) continue;
    for (let k = 0; k < 3; k++) if (segsCross(a, b, uv[k], uv[(k + 1) % 3])) return true;
    // Contour vertex strictly inside the triangle.
    const inTri = (p: V2) => {
      const s = (q: V2, r: V2) => (r[0] - q[0]) * (p[1] - q[1]) - (r[1] - q[1]) * (p[0] - q[0]);
      const d1 = s(uv[0], uv[1]), d2 = s(uv[1], uv[2]), d3 = s(uv[2], uv[0]);
      return (d1 > 0 && d2 > 0 && d3 > 0) || (d1 < 0 && d2 < 0 && d3 < 0);
    };
    if (inTri(a)) return true;
  }
  return false;
}

// --- bevel (straight-skeleton roof) ----------------------------------------------------------------

/** One facet of the 45° roof: a straight-skeleton face and its plane h = a·u + b·v + c. */
interface Facet {
  poly: Polygon;
  plane: [number, number, number];
  bb: Rect;
  /** Cut height of the facet's part (3D Builder: |v| × that part's own maximum skeleton time). */
  cap: number;
}

interface Roof {
  facets: Facet[];
  /** Zones cut into the mesh: each facet below the plateau, then the plateau. */
  zones: CrossSection[];
  /** Skeleton edges and plateau contour, cut into the mesh like the motif contours. */
  polys: Polygon[];
  /** Plateau height (the requested depth, or the roof's top when the motif is too thin). */
  cap: number;
}

let skeletonReady: Promise<typeof import('straight-skeleton').SkeletonBuilder> | null = null;
function skeletonBuilder() {
  // The package is a webpack UMD bundle that expects `self` (absent under Node, in the tests).
  (globalThis as { self?: unknown }).self ??= globalThis;
  skeletonReady ??= import('straight-skeleton').then(async (m) => {
    if (!(m.SkeletonBuilder as unknown as { module?: unknown }).module) await m.SkeletonBuilder.init();
    return m.SkeletonBuilder;
  });
  return skeletonReady;
}

const rectOf = (p: Polygon): Rect => {
  const r = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const [x, y] of p) {
    r.x0 = Math.min(r.x0, x); r.y0 = Math.min(r.y0, y);
    r.x1 = Math.max(r.x1, x); r.y1 = Math.max(r.y1, y);
  }
  return r;
};

const signedArea = (p: Polygon) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i], r = p[(i + 1) % p.length];
    a += q[0] * r[1] - r[0] * q[1];
  }
  return a / 2;
};

/**
 * 3D Builder's bevel: the straight skeleton of the motif (CGAL) gives a roof whose height is the
 * skeleton time (45°), cut flat at the depth. Each connected part of the motif (outer contour and
 * its holes) is skeletonised separately.
 */
async function buildRoof(wasm: ManifoldToplevel, motif: CrossSection, depthMm: number, fraction?: number): Promise<Roof> {
  const SB = await skeletonBuilder();
  const facets: Facet[] = [];
  const plateaus: CrossSection[] = [];
  const parts = motif.decompose();
  let top = 0;
  try {
    for (const part of parts) {
      let partTop = 0;
      const first = facets.length;
      // CGAL rejects some inputs: rings with collinear points (Moore tracing leaves one at its
      // start pixel) or nearly degenerate corners. Retry with a slightly stronger cleanup.
      const ext = Math.sqrt(Math.max(part.area(), 1e-12));
      let sk: ReturnType<typeof SB.buildFromPolygon> = null;
      const area = part.area();
      // Pinhole holes (a pixel or two left inside a stroke, under 0.1 % of the part) are dropped:
      // CGAL can spend seconds on them and then fail.
      attempts: for (const [eps, minHole] of [[1e-9, 1e-3], [1e-5, 1e-3], [1e-4, 1e-3], [1e-3, 1e-2], [3e-3, 1e-2]]) {
        const clean = part.simplify(eps * ext);
        const rings = (clean.toPolygons() as unknown as Polygon[]).filter((r) => r.length >= 3 && (signedArea(r) > 0 || -signedArea(r) >= minHole * area));
        clean.delete();
        if (!rings.length) break;
        // Outer ring counter-clockwise first, holes clockwise; each ring closed.
        rings.sort((a, b) => signedArea(b) - signedArea(a));
        // Centred on the part and brought to a fixed size: the binding's tolerances depend on
        // the coordinates' magnitude. Other scales are tried if CGAL still gives up.
        const bb = rectOf(rings[0]);
        const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
        const half = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) / 2 || 1;
        for (const target of [1000, 100, 10000, 10]) {
          const s = target / half;
          const close = (r: Polygon) => [...r, r[0]].map(([x, y]) => [(x - cx) * s, (y - cy) * s]);
          try {
            sk = SB.buildFromPolygon(rings.map(close));
          } catch {
            // A CGAL assertion aborts the Wasm instance: start a fresh one.
            sk = null;
            await SB.init();
          }
          if (sk) {
            for (const v of sk.vertices) { v[0] = v[0] / s + cx; v[1] = v[1] / s + cy; v[2] /= s; }
            break attempts;
          }
        }
      }
      if (!sk) throw new Error('Biseau impossible pour ce motif (squelette droit non calculable).');
      for (const face of sk.polygons) {
        const vs = face.map((i) => sk.vertices[i]);
        let poly: Polygon = vs.map(([x, y]) => [x, y] as V2);
        if (signedArea(poly) < 0) poly = poly.reverse();
        const plane = fitPlane(vs);
        if (!plane) continue;
        for (const v of vs) partTop = Math.max(partTop, v[2]);
        facets.push({ poly, plane, bb: rectOf(poly), cap: 0 });
      }
      // Each part (a glyph component) is cut at its own fraction of its own top (3D Builder).
      const partCap = Math.min(fraction !== undefined ? Math.max(0, Math.min(1, fraction)) * partTop : depthMm, partTop);
      for (let k = first; k < facets.length; k++) facets[k].cap = partCap;
      if (partCap < partTop) plateaus.push(part.offset(-partCap, 'Miter', 1e4));
      top = Math.max(top, partTop);
    }
  } finally {
    for (const p of parts) p.delete();
  }
  // 3D Builder: plateau at the fraction × the roof's top; 3D Assembler's API also takes a height in mm.
  const cap = facets.reduce((m, f) => Math.max(m, f.cap), 0);
  const zones: CrossSection[] = [];
  const polys: Polygon[] = facets.map((f) => f.poly);
  let plateau: CrossSection | null = null;
  if (plateaus.length) {
    plateau = plateaus.length === 1 ? plateaus[0] : wasm.CrossSection.union(plateaus);
    if (plateaus.length > 1) for (const p of plateaus) p.delete();
  }
  for (const f of facets) {
    // Clipped to the motif: a dropped pinhole stays in the outside zone, so zones never overlap.
    const raw = new wasm.CrossSection([f.poly], 'NonZero');
    const z = raw.intersect(motif);
    raw.delete();
    if (plateau) {
      zones.push(z.subtract(plateau));
      z.delete();
    } else zones.push(z);
  }
  if (plateau) {
    zones.push(plateau);
    polys.push(...(plateau.toPolygons() as unknown as Polygon[]));
  }
  return { facets, zones, polys, cap };
}

/** Plane h = a·u + b·v + c through the (u, v, time) corners of a skeleton face. */
function fitPlane(vs: [number, number, number][]): [number, number, number] | null {
  // The largest triangle among the corners gives the best-conditioned plane.
  let best: [number, number, number] | null = null, bestA = 0;
  const p0 = vs[0];
  for (let i = 1; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
    const p1 = vs[i], p2 = vs[j];
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uh = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vh = p2[2] - p0[2];
    const det = ux * vy - uy * vx;
    if (Math.abs(det) <= bestA) continue;
    bestA = Math.abs(det);
    const a = (uh * vy - uy * vh) / det;
    const b = (ux * vh - uh * vx) / det;
    best = [a, b, p0[2] - a * p0[0] - b * p0[1]];
  }
  return best;
}

function distToPoly(q: V2, p: Polygon): number {
  let best = Infinity;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy));
  }
  return best;
}

/** Roof height at a motif-plane point: the plane of the facet holding it, cut at the plateau. */
function roofHeight(R: Roof, q: V2, eps: number): number {
  let bestD = eps, best: Facet | null = null;
  for (const f of R.facets) {
    if (q[0] < f.bb.x0 - eps || q[0] > f.bb.x1 + eps || q[1] < f.bb.y0 - eps || q[1] > f.bb.y1 + eps) continue;
    if (insidePoly(q, f.poly)) { best = f; break; }
    const d = distToPoly(q, f.poly);
    if (d <= bestD) { bestD = d; best = f; }
  }
  if (!best) return 0;
  const h = best.plane[0] * q[0] + best.plane[1] * q[1] + best.plane[2];
  lastCap = best.cap;
  return Math.max(0, Math.min(best.cap, h));
}
/** Cut height of the facet found by the last roofHeight call. */
let lastCap = 0;

function triangulateSafe(wasm: ManifoldToplevel, contours: V2[][]): [number, number, number][] {
  try {
    return wasm.triangulate(contours, 0) as unknown as [number, number, number][];
  } catch {
    return [];
  }
}
