// "Personnalisé" (Insert > Custom), as 3D Builder does it: five shapes (cube, sphere, cone,
// torus, cylinder) built by one generator. A vertical profile of rings (radius, height) is swept
// around Z; each ring is a polygon with n corners, its sides subdivided, and its corners possibly
// rounded by arcs (the rounded cube is the Minkowski sum of a core box and a sphere). Consecutive
// rings are joined by quads cut along (lower i, upper i+1); a single-vertex ring is a pole.
// Behaviour measured on 3D Builder's shapes; see docs/3d-builder-tools.md.
import type { MeshData } from '../core/mesh-data';

export type CustomShapeId = 'cube' | 'sphere' | 'cone' | 'torus' | 'cylinder';

export interface ParamDef {
  key: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
}
export interface CustomShape { id: CustomShapeId; label: string; params: ParamDef[] }

/** Colour of a custom shape when 3D Builder inserts it (0.737 grey). */
export const CUSTOM_COLOR = '#bcbcbc';
/** One rounding level of the cube is 0.1 inch. */
export const ROUNDING_STEP = 2.54;

const lat = (min: number): ParamDef => ({ key: 'lat', label: 'Latitude', value: 10, min, max: 100, step: 1, unit: '' });
const lon = (min: number): ParamDef => ({ key: 'lon', label: 'Longitude', value: 10, min, max: 100, step: 1, unit: '' });
const len = (key: string, label: string, value: number): ParamDef => ({ key, label, value, min: 1, max: 1e6, step: 1, unit: 'mm' });
const division: ParamDef = { key: 'div', label: 'Division', value: 1, min: 1, max: 100, step: 1, unit: '' };

export const CUSTOM_SHAPES: CustomShape[] = [
  { id: 'cube', label: 'Cube', params: [lat(1), lon(1), len('w', 'Largeur', 40), len('h', 'Hauteur', 40), { key: 'round', label: 'Arrondi', value: 0, min: 0, max: 5, step: 1, unit: '' }] },
  { id: 'sphere', label: 'Sphère', params: [lat(2), lon(3), len('r', 'Rayon', 20)] },
  { id: 'cone', label: 'Cône', params: [lat(1), lon(3), division, len('r', 'Rayon', 20), len('h', 'Hauteur', 40)] },
  { id: 'torus', label: 'Tore', params: [lat(3), lon(3), len('r', 'Rayon', 20), len('ri', 'Rayon interne', 10)] },
  { id: 'cylinder', label: 'Cylindre', params: [lat(1), lon(3), division, len('r', 'Rayon', 20), len('h', 'Hauteur', 40)] },
];

/**
 * Bounds that depend on other values (3D Builder updates them as you type): the cube's rounding
 * is at most min(3.75 × width, 5 × height) in inches (radius ≤ 0.375 W and ≤ H / 2); the torus
 * hole is at most 0.95 × its radius.
 */
export function dynamicMax(id: CustomShapeId, key: string, p: Record<string, number>): number | undefined {
  if (id === 'cube' && key === 'round') return Math.max(0, Math.min(Math.floor((3.75 * p.w) / 25.4), Math.floor((5 * p.h) / 25.4)));
  if (id === 'torus' && key === 'ri') return Math.max(1, 0.95 * p.r);
  return undefined;
}

// --- rings ------------------------------------------------------------------------------------------

/**
 * One ring of the profile: a polygon with n corners on a circle of radius `core` (first corner at
 * angle `start`), each side cut into `side` segments, each corner replaced by an arc of radius `d`
 * in `arc` steps when d > 0. n = 1 is a plain circle of `side` points; core = 0 and d = 0 is a pole.
 */
interface Ring { n: number; core: number; d: number; arc: number; side: number; z: number; start: number }

/** Points of a ring, grouped per corner: [arc or corner points…, side points…]. */
function ringPoints(r: Ring): { pts: [number, number, number][]; corner: number } {
  if (r.core === 0 && r.d === 0) return { pts: [[0, 0, r.z]], corner: 0 };
  const pts: [number, number, number][] = [];
  if (r.n === 1) {
    for (let i = 0; i < r.side; i++) {
      const a = r.start + (i / r.side) * 2 * Math.PI;
      pts.push([r.d * Math.cos(a), r.d * Math.sin(a), r.z]);
    }
    return { pts, corner: 1 };
  }
  const step = (2 * Math.PI) / r.n;
  const cornerAt = (i: number): [number, number] => [r.core * Math.cos(r.start + i * step), r.core * Math.sin(r.start + i * step)];
  const arcN = r.d > 0 ? r.arc : 0;
  for (let i = 0; i < r.n; i++) {
    const c = cornerAt(i), c2 = cornerAt(i + 1);
    const th = r.start + i * step;
    // Arc around the corner, from the normal of the previous side to the normal of the next one.
    for (let j = 0; j <= arcN; j++) {
      const a = th - step / 2 + (arcN ? (j / arcN) * step : step / 2);
      pts.push(r.d > 0 ? [c[0] + r.d * Math.cos(a), c[1] + r.d * Math.sin(a), r.z] : [c[0], c[1], r.z]);
    }
    // Side towards the next corner (offset by d along its normal).
    const nrm = th + step / 2;
    const ox = r.d * Math.cos(nrm), oy = r.d * Math.sin(nrm);
    for (let k = 1; k < r.side; k++) {
      const t = k / r.side;
      pts.push([c[0] + (c2[0] - c[0]) * t + ox, c[1] + (c2[1] - c[1]) * t + oy, r.z]);
    }
  }
  return { pts, corner: arcN + 1 };
}

class Builder {
  pos: number[] = [];
  idx: number[] = [];
  add(p: [number, number, number]): number {
    this.pos.push(p[0], p[1], p[2]);
    return this.pos.length / 3 - 1;
  }
  emit(r: Ring): { ids: number[]; corner: number; n: number } {
    const { pts, corner } = ringPoints(r);
    return { ids: pts.map((p) => this.add(p)), corner, n: pts.length === 1 ? 0 : r.n };
  }
  /** Joins a lower ring A to an upper ring B (in profile order). */
  stitch(A: { ids: number[]; corner: number; n: number }, B: { ids: number[]; corner: number; n: number }): void {
    const t = (a: number, b: number, c: number) => this.idx.push(a, b, c);
    const a = A.ids, b = B.ids;
    if (a.length === 1) { for (let i = 0; i < b.length; i++) t(a[0], b[(i + 1) % b.length], b[i]); return; }
    if (b.length === 1) { for (let i = 0; i < a.length; i++) t(a[i], a[(i + 1) % a.length], b[0]); return; }
    if (a.length === b.length) {
      for (let i = 0; i < a.length; i++) {
        const i2 = (i + 1) % a.length;
        t(a[i], a[i2], b[i2]);
        t(a[i], b[i2], b[i]);
      }
      return;
    }
    // Same corners and sides, one ring with arcs at the corners: each arc fans to the corner point.
    const flip = A.corner > B.corner;
    const [S, L] = flip ? [B, A] : [A, B];
    const per = S.ids.length / S.n, perL = L.ids.length / L.n;
    const tri = (x: number, y: number, z: number) => (flip ? t(x, z, y) : t(x, y, z));
    for (let i = 0; i < S.n; i++) {
      const s0 = i * per, l0 = i * perL;
      // corner fan: small ring corner to the arc of the large ring
      for (let j = 0; j < L.corner - 1; j++) {
        const big = (k: number) => L.ids[(l0 + k) % L.ids.length];
        if (flip) t(big(j), big(j + 1), S.ids[s0]);
        else t(S.ids[s0], big(j + 1), big(j));
      }
      // sides: segments from the corner (S) / arc end (L) to the next corner / arc start
      const sPath = [S.ids[s0], ...S.ids.slice(s0 + 1, s0 + per), S.ids[((i + 1) * per) % S.ids.length]];
      const lPath = [L.ids[l0 + L.corner - 1], ...L.ids.slice(l0 + L.corner, l0 + perL), L.ids[((i + 1) * perL) % L.ids.length]];
      for (let k = 0; k + 1 < sPath.length; k++) {
        tri(sPath[k], sPath[k + 1], lPath[k + 1]);
        tri(sPath[k], lPath[k + 1], lPath[k]);
      }
    }
  }
  mesh(): MeshData {
    return { positions: new Float32Array(this.pos), indices: new Uint32Array(this.idx) };
  }
}

/** Sweeps a list of rings (bottom to top); `closed` joins the last ring back to the first. */
function sweep(rings: Ring[], closed = false): MeshData {
  const b = new Builder();
  const out = rings.map((r) => b.emit(r));
  for (let i = 0; i + 1 < out.length; i++) b.stitch(out[i], out[i + 1]);
  if (closed) b.stitch(out[out.length - 1], out[0]);
  return b.mesh();
}

// --- cube caps: Longitude × Longitude grid as concentric square rings ----------------------------------

/**
 * Flat square cap of `n` × `n` cells on the core square (circumradius rc, corners at 45°), built as
 * concentric square rings of s cells per side (s = n mod 2, then + 2). `outer` is the cap's edge ring
 * (already emitted, n points per side starting at a corner). Triangles face down when `down`.
 */
function squareCap(b: Builder, rc: number, n: number, z: number, outer: number[], down: boolean): void {
  const tri = (x: number, y: number, w: number) => (down ? b.idx.push(x, w, y) : b.idx.push(x, y, w));
  const ring = (s: number): number[] => {
    if (s === n) return outer;
    if (s === 0) return [b.add([0, 0, z])];
    const r: Ring = { n: 4, core: (rc * s) / n, d: 0, arc: 0, side: s, z, start: Math.PI / 4 };
    return ringPoints(r).pts.map((p) => b.add(p));
  };
  let s = n % 2;
  let inner = ring(s);
  if (s === 1) { tri(inner[0], inner[1], inner[2]); tri(inner[0], inner[2], inner[3]); }
  while (s < n) {
    const o = ring(s + 2);
    const pi = s, po = s + 2; // points per side
    for (let c = 0; c < 4; c++) {
      const I = (k: number) => inner[(c * pi + k) % inner.length];
      const O = (k: number) => o[(c * po + k + o.length) % o.length];
      // corner cell: cut off the outer corner, then join to the inner corner
      tri(O(-1), O(0), O(1));
      tri(I(0), O(-1), O(1));
      // edge cells along the side, diagonal inner k → outer k + 2
      for (let k = 0; k < pi; k++) {
        tri(I(k), O(k + 1), O(k + 2));
        tri(I(k), O(k + 2), I(k + 1));
      }
    }
    // s = 0: the single centre point is both inner corners; edge cells do not exist.
    inner = o;
    s += 2;
  }
}

// --- shapes --------------------------------------------------------------------------------------------

export function makeCustom(id: CustomShapeId, p: Record<string, number>): MeshData {
  const L = Math.max(1, Math.round(p.lat ?? 10));
  const N = Math.max(1, Math.round(p.lon ?? 10));
  const D = Math.max(1, Math.round(p.div ?? 1));
  switch (id) {
    case 'sphere': {
      const R = p.r, rings: Ring[] = [];
      const lt = Math.max(2, L), ln = Math.max(3, N);
      rings.push({ n: 1, core: 0, d: 0, arc: 0, side: 0, z: -R, start: 0 });
      for (let j = 1; j < lt; j++) {
        const phi = (Math.PI * j) / lt;
        rings.push({ n: 1, core: 0, d: R * Math.sin(phi), arc: 0, side: ln, z: -R * Math.cos(phi), start: 0 });
      }
      rings.push({ n: 1, core: 0, d: 0, arc: 0, side: 0, z: R, start: 0 });
      return sweep(rings);
    }
    case 'cone':
    case 'cylinder': {
      const R = p.r, H = p.h, ln = Math.max(3, N);
      const circle = (r: number, z: number): Ring => (r === 0 ? { n: 1, core: 0, d: 0, arc: 0, side: 0, z, start: 0 } : { n: 1, core: 0, d: r, arc: 0, side: ln, z, start: 0 });
      const rings: Ring[] = [circle(0, -H / 2)];
      for (let k = 1; k <= D; k++) rings.push(circle((R * k) / D, -H / 2));
      const top = id === 'cone' ? 0 : R;
      for (let k = 1; k <= L; k++) {
        const t = k / L;
        if (id === 'cone' && k === L) break;
        rings.push(circle(R + (top - R) * t, -H / 2 + H * t));
      }
      if (id === 'cone') rings.push(circle(0, H / 2));
      else {
        for (let k = D - 1; k >= 1; k--) rings.push(circle((R * k) / D, H / 2));
        rings.push(circle(0, H / 2));
      }
      return sweep(rings);
    }
    case 'torus': {
      // Rayon = outer radius, Rayon interne = radius of the hole.
      const ri = Math.min(p.ri, 0.95 * p.r);
      const Rc = (p.r + ri) / 2, rt = (p.r - ri) / 2;
      const lt = Math.max(3, L), ln = Math.max(3, N), rings: Ring[] = [];
      for (let j = 0; j < lt; j++) {
        const a = (2 * Math.PI * j) / lt; // from the outer equator, upwards first
        rings.push({ n: 1, core: 0, d: Rc + rt * Math.cos(a), arc: 0, side: ln, z: rt * Math.sin(a), start: 0 });
      }
      return sweep(rings, true);
    }
    case 'cube': {
      const W = p.w, H = p.h;
      const level = Math.max(0, Math.min(Math.round(p.round ?? 0), dynamicMax('cube', 'round', p) ?? 0));
      const r = Math.min(level * ROUNDING_STEP, W / 2, H / 2);
      const rc = ((W - 2 * r) / 2) * Math.SQRT2; // circumradius of the core square
      const hc = H - 2 * r;
      const sq = (d: number, z: number, side: number): Ring => ({ n: 4, core: rc, d, arc: level, side, z, start: Math.PI / 4 });
      const b = new Builder();
      const rings: { ids: number[]; corner: number; n: number }[] = [];
      // bottom cap edge, then the bottom rounding arcs (k steps), the side (Latitude), the top arcs
      const bottomEdge = b.emit(sq(0, -H / 2, N));
      rings.push(bottomEdge);
      for (let j = 1; j <= level; j++) {
        const a = -Math.PI / 2 + (Math.PI / 2) * (j / level);
        rings.push(b.emit(sq(r * Math.cos(a), -hc / 2 + r * Math.sin(a), N)));
      }
      const sideRings = hc > 0 ? L : 0;
      for (let k = 1; k <= sideRings; k++) {
        rings.push(b.emit(sq(r, -hc / 2 + (hc * k) / L, N)));
      }
      for (let j = level - 1; j >= 0; j--) {
        const a = (Math.PI / 2) * (1 - j / level);
        const ring = sq(r * Math.cos(a), hc / 2 + r * Math.sin(a), N);
        rings.push(b.emit(j === 0 ? { ...ring, d: 0 } : ring));
      }
      for (let i = 0; i + 1 < rings.length; i++) b.stitch(rings[i], rings[i + 1]);
      const topEdge = rings[rings.length - 1];
      squareCap(b, rc, N, -H / 2, bottomEdge.ids, true);
      squareCap(b, rc, N, H / 2, topEdge.ids, false);
      return b.mesh();
    }
  }
}
