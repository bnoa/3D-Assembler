// "Insert image" as 3D Builder does it, with its four modes:
//   contour  — traced outline extruded to 10 % of the long side;
//   height   — colours reduced by median cut, height = R + G + B, Gaussian smoothing, relief from
//              8 % to 24 % of the width on a flat bottom;
//   edge     — same, height = largest colour difference with the 3 × 3 neighbours;
//   stamp    — blocks of b × b pixels turned black or white by ordered dithering, two-level relief.
// The relief geometry is 3D Builder's: one vertex per pixel, two triangles per cell with the
// diagonal through a corner that is a strict extremum, walls down to z = 0 and a flat bottom.
// The result is scaled so its long side is `width` mm (3D Builder: 0.01 scene unit per pixel).
import type { MeshData } from '../core/mesh-data';
import { NO_PAINT } from '../core/model';
import type { ObjectTexture } from '../core/texture-data';
import { analyze } from '../repair/analyze';
import { loadManifold } from './csg';
import { traceContours } from './emboss';

export type ImageMode = 'contour' | 'height' | 'edge' | 'stamp';

export interface ImageInsertOptions {
  mode: ImageMode;
  /** contour: threshold (an intensity level); height/edge: number of colours (2-256); stamp: dithering (0-3). */
  p1: number;
  /** contour: RDP tolerance − 1 (px); height/edge: smoothing radius; stamp: block size − 1. All 0-8. */
  p2: number;
  invert: boolean;
  /** "Reduced colours material": paint the relief with the reduced (or original) image. */
  reducedColors: boolean;
  /** Long side of the object, mm. */
  width: number;
}

/** 3D Builder's defaults per mode (p1, p2). */
export const IMAGE_DEFAULTS: Record<ImageMode, { p1: number; p2: number }> = {
  contour: { p1: 128, p2: 0 },
  height: { p1: 16, p2: 2 },
  edge: { p1: 16, p2: 2 },
  stamp: { p1: 0, p2: 2 },
};

export interface ImageInsertResult { mesh: MeshData; faceColors?: Uint32Array }

// --- intensity and contour threshold ---------------------------------------------------------------

/** Tracer intensity (alpha alone for a single-colour image). */
function intensities(px: ImageData): Uint8Array {
  const { width: w, height: h, data } = px;
  let uniform = true;
  for (let i = 4; i < w * h * 4 && uniform; i += 4) for (let c = 0; c < 3; c++) if (Math.abs(data[i + c] - data[c]) > 10) { uniform = false; break; }
  const out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    out[p] = uniform ? data[i + 3] : Math.trunc((Math.max(data[i], data[i + 1], data[i + 2]) / 255) * data[i + 3]);
  }
  return out;
}

/**
 * The threshold levels offered by the contour slider: the distinct intensity levels of the image,
 * and the one picked first (3D Builder tries the median level, then its neighbours outwards, and
 * keeps the first giving a non-empty outline; levels that failed are dropped).
 */
export function contourLevels(px: ImageData, invert = false): { levels: number[]; initial: number } {
  const seen = new Uint8Array(256);
  for (const v of intensities(px)) seen[invert ? 255 - v : v] = 1;
  let levels = [...seen.keys()].filter((v) => seen[v]);
  const ok = (t: number) => traceContours(px, { threshold: invert ? 255 - t : t, invert, tolerance: 1 }).length > 0;
  const mid = Math.floor(levels.length / 2);
  const failed = new Set<number>();
  for (let k = 0; k < levels.length; k++) {
    const i = k % 2 ? mid - Math.ceil(k / 2) : mid + k / 2;
    if (i < 0 || i >= levels.length) continue;
    if (ok(levels[i])) {
      const pick = levels[i];
      levels = levels.filter((l) => !failed.has(l));
      return { levels, initial: levels.indexOf(pick) };
    }
    failed.add(levels[i]);
  }
  return { levels: [], initial: 0 };
}

async function contourSolidBuilder(px: ImageData, o: ImageInsertOptions): Promise<MeshData> {
  const t = Math.max(1, Math.min(255, Math.round(o.p1)));
  const polys = traceContours(px, { threshold: o.invert ? 255 - t : t, invert: o.invert, tolerance: o.p2 + 1 });
  if (!polys.length) throw new Error('Aucun contour trouvé avec ce seuil.');
  const n = Math.max(px.width, px.height);
  // (p − 1) / max(W, H) in 3D Builder's padded pixels = p / n here; y flipped; top at 0.1.
  const wasm = await loadManifold();
  const raw = new wasm.CrossSection(polys.map((p) => p.map(([x, y]) => [x / n, -y / n] as [number, number])), 'EvenOdd');
  // Pixels touching only at a corner leave pinched outlines (a vertex used twice): extruded, they
  // give coincident vertices and zero-area faces, an invalid object. Shrinking by 0.01 pixel parts
  // them, and the simplification drops the slivers left by collinear points.
  const eps = 0.05 / n;
  const shrunk = raw.offset(-eps, 'Miter', 2);
  const section = shrunk.simplify(eps);
  raw.delete();
  shrunk.delete();
  const solid = section.extrude(0.1);
  section.delete();
  try {
    const m = solid.getMesh();
    const pos = Float32Array.from(m.vertProperties);
    // 3D Builder scales by the image (long side = 1 here), not by the outline.
    return normalise({ positions: pos, indices: Uint32Array.from(m.triVerts) }, o.width, 1);
  } finally {
    solid.delete();
  }
}

/** Min corner to the origin, long side (x or y, or `span` if given) scaled to `width` mm. */
function normalise(m: MeshData, width: number, span?: number): MeshData {
  const p = m.positions;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) { lo[i % 3] = Math.min(lo[i % 3], p[i]); hi[i % 3] = Math.max(hi[i % 3], p[i]); }
  const s = width / (span ?? (Math.max(hi[0] - lo[0], hi[1] - lo[1]) || 1));
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = (p[i] - (i % 3 === 2 ? 0 : lo[i % 3])) * s;
  return { positions: out, indices: m.indices };
}

// --- colour reduction (height / edge) --------------------------------------------------------------

/** Flood fill flattening near-uniform regions onto their seed colour (3D Builder's pre-pass). */
function flattenRegions(data: Uint8ClampedArray, w: number, h: number) {
  const done = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (done[s]) continue;
    done[s] = 1;
    const r = data[s * 4], g = data[s * 4 + 1], b = data[s * 4 + 2], a = data[s * 4 + 3];
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w, y = (p - x) / w;
      for (const q of [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, y > 0 ? p - w : -1, y + 1 < h ? p + w : -1]) {
        if (q < 0 || done[q]) continue;
        const i = q * 4;
        if (Math.abs(data[i] - r) < 8 && Math.abs(data[i + 1] - g) < 8 && Math.abs(data[i + 2] - b) <= 5 && Math.abs(data[i + 3] - a) <= 7) {
          done[q] = 1;
          data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
          stack.push(q);
        }
      }
    }
  }
}

const W_LUM = [0.2126, 0.7152, 0.0722];

/** Median cut on linear colours (gamma 2.2) into n colours; pixels mapped to the nearest one. */
export function medianCut(px: ImageData, n: number): Uint8ClampedArray {
  const { width: w, height: h } = px;
  const data = new Uint8ClampedArray(px.data);
  flattenRegions(data, w, h);
  const np = w * h;
  const lin = new Float32Array(np * 3);
  for (let p = 0; p < np; p++) for (let c = 0; c < 3; c++) lin[p * 3 + c] = (data[p * 4 + c] / 255) ** 2.2;
  type Box = { idx: number[]; side: number; axis: number };
  const box = (idx: number[]): Box => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of idx) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], lin[p * 3 + c]); hi[c] = Math.max(hi[c], lin[p * 3 + c]); }
    const r = [0, 1, 2].map((c) => hi[c] - lo[c]);
    const axis = r.indexOf(Math.max(...r));
    return { idx, side: r[axis], axis };
  };
  const boxes: Box[] = [box(Array.from({ length: np }, (_, i) => i))];
  const target = Math.max(1, Math.min(256, Math.round(n)));
  while (boxes.length < target) {
    // Largest box first (max-heap on the longest side).
    let k = 0;
    for (let i = 1; i < boxes.length; i++) if (boxes[i].side > boxes[k].side) k = i;
    const b = boxes[k];
    if (b.idx.length < 2 || b.side <= 0) break;
    const sorted = b.idx.slice().sort((p, q) => lin[p * 3 + b.axis] - lin[q * 3 + b.axis]);
    const half = Math.ceil(sorted.length / 2);
    boxes.splice(k, 1, box(sorted.slice(0, half)), box(sorted.slice(half)));
  }
  const palette = boxes.map((b) => {
    const m = [0, 0, 0];
    for (const p of b.idx) for (let c = 0; c < 3; c++) m[c] += lin[p * 3 + c];
    return m.map((v) => v / b.idx.length);
  });
  const out = new Uint8ClampedArray(data.length);
  for (let p = 0; p < np; p++) {
    let best = 0, bd = Infinity;
    for (let k = 0; k < palette.length; k++) {
      let d = 0;
      for (let c = 0; c < 3; c++) { const e = W_LUM[c] * (lin[p * 3 + c] - palette[k][c]); d += e * e; }
      if (d < bd) { bd = d; best = k; }
    }
    for (let c = 0; c < 3; c++) out[p * 4 + c] = Math.trunc(palette[best][c] ** (1 / 2.2) * 255);
    out[p * 4 + 3] = data[p * 4 + 3];
  }
  return out;
}

// --- heights and smoothing -------------------------------------------------------------------------

function heights(data: Uint8ClampedArray, w: number, h: number, mode: 'height' | 'edge', invert: boolean): Float64Array {
  const H = new Float64Array(w * h);
  if (mode === 'height') {
    for (let p = 0; p < w * h; p++) H[p] = Math.trunc((data[p * 4] + data[p * 4 + 1] + data[p * 4 + 2]) / (256 - data[p * 4 + 3]));
  } else {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const j = (Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))) * 4;
        m = Math.max(m, Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]) + Math.abs(data[i + 3] - data[j + 3]));
      }
      H[y * w + x] = m;
    }
  }
  if (invert) {
    let lo = Infinity, hi = -Infinity;
    for (const v of H) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (let p = 0; p < H.length; p++) H[p] = hi + lo - H[p];
  }
  return H;
}

/** Separable Gaussian, kernel 2r + 1, weights exp(−0.5 (2i / r)²), edges clamped, truncated. */
function smooth(H: Float64Array, w: number, h: number, r: number): Float64Array {
  if (r < 1) return H;
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-0.5 * ((2 * (i - r)) / r) ** 2));
  const sum = k.reduce((a, b) => a + b, 0);
  const pass = (src: Float64Array, horizontal: boolean) => {
    const dst = new Float64Array(src.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xx = horizontal ? Math.min(w - 1, Math.max(0, x + i)) : x;
        const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + i));
        s += src[yy * w + xx] * k[i + r];
      }
      dst[y * w + x] = Math.trunc(s / sum + 1e-9); // truncated; the margin absorbs rounding (765 stays 765)
    }
    return dst;
  };
  return pass(pass(H, true), false);
}

/**
 * Smoothing radius scaled for images over 128 px. 3D Builder forgets to scale square images (a
 * 512 × 512 image is smoothed 4 times less than a 512 × 511 one); 3D Assembler scales them too.
 */
export function smoothingRadius(w: number, h: number, p2: number): number {
  if (w > 128 || h > 128) return Math.trunc((Math.min(w, h) / 128) * p2);
  return p2;
}

// --- relief mesh -----------------------------------------------------------------------------------

/** Closed relief: grid top (one vertex per pixel), walls to z = 0, flat bottom. Units: 0.01 per pixel. */
function relief(H: Float64Array, w: number, h: number, colorOf?: (x: number, y: number) => number, lo0?: number, hi0?: number): { mesh: MeshData; faceColors?: Uint32Array } {
  let lo = Infinity, hi = -Infinity;
  for (const v of H) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (lo0 !== undefined && hi0 !== undefined) { lo = lo0; hi = hi0; }
  const base = 0.0008 * w, top = 0.0024 * w;
  const z = (v: number) => (hi > lo ? base + ((v - lo) * (top - base)) / (hi - lo) : top);
  // Built as 3D Builder does (the final simplifier visits vertices in index order, so the order
  // matters): grid point (x, y) at X = 0.01 x, Y = 0.01 (h − y); vertices numbered on first use;
  // faces: top, then walls, then bottom; top and bottom grids shared by the walls.
  const pos: number[] = [];
  const tv = new Int32Array(w * h).fill(-1), low = new Int32Array(w * h).fill(-1);
  const T = (x: number, y: number) => {
    const k = y * w + x;
    if (tv[k] < 0) { tv[k] = pos.length / 3; pos.push(x * 0.01, (h - y) * 0.01, z(H[k])); }
    return tv[k];
  };
  const B = (x: number, y: number) => {
    const k = y * w + x;
    if (low[k] < 0) { low[k] = pos.length / 3; pos.push(x * 0.01, (h - y) * 0.01, 0); }
    return low[k];
  };
  const idx: number[] = [], col: number[] = [];
  for (let y = 1; y < h; y++) for (let x = 1; x < w; x++) {
    // A = (x − 1, y − 1), B = (x, y − 1), C = (x − 1, y), D = (x, y).
    const v = [H[(y - 1) * w + x - 1], H[(y - 1) * w + x], H[y * w + x - 1], H[y * w + x]];
    const strict = (k: number) => v.every((u, j) => j === k || u < v[k]) || v.every((u, j) => j === k || u > v[k]);
    // The C–B diagonal when D or A is a strict peak or pit of the quad, else A–D.
    if (strict(3) || strict(0)) {
      const c = T(x - 1, y), bb = T(x, y - 1), aa = T(x - 1, y - 1);
      const d = T(x, y);
      idx.push(c, bb, aa, c, d, bb);
    } else {
      const aa = T(x - 1, y - 1), d = T(x, y), bb = T(x, y - 1);
      const c = T(x - 1, y);
      idx.push(aa, d, bb, aa, c, d);
    }
    const cc = colorOf ? colorOf(x - 1, y - 1) : NO_PAINT;
    col.push(cc, cc);
  }
  // Walls: edge P → Q gives (TP, TQ, BP) and (TQ, BQ, BP).
  const wall = (px: number, py: number, qx: number, qy: number) => {
    const tp = T(px, py), tq = T(qx, qy), bp = B(px, py), bq = B(qx, qy);
    idx.push(tp, tq, bp, tq, bq, bp);
    col.push(NO_PAINT, NO_PAINT);
  };
  for (let y = 1; y < h; y++) { wall(0, y, 0, y - 1); wall(w - 1, y - 1, w - 1, y); }
  for (let x = 1; x < w; x++) { wall(x - 1, 0, x, 0); wall(x, h - 1, x - 1, h - 1); }
  // Bottom: one triangulation of the outline (3D Builder's algorithm is not identified): a zipper
  // between the two chains from corner (w − 1, 0) to corner (0, h − 1), facing down.
  const c1: number[] = [], c2: number[] = [];
  for (let y = 1; y < h; y++) c1.push(B(w - 1, y));
  for (let x = w - 2; x >= 1; x--) c1.push(B(x, h - 1));
  for (let x = w - 2; x >= 0; x--) c2.push(B(x, 0));
  for (let y = 1; y < h - 1; y++) c2.push(B(0, y));
  const S = B(w - 1, 0), E = B(0, h - 1);
  const tri = (p: number, q: number, r: number) => { idx.push(p, r, q); col.push(NO_PAINT); }; // (p, q, r) counter-clockwise from above
  // Counter-clockwise from above, c2 (top then left side) lies to the left of c1 (right then bottom).
  tri(S, c2[0], c1[0]);
  let i = 0, j = 0;
  while (i < c1.length - 1 || j < c2.length - 1) {
    const ti = (i + 1) / c1.length, tj = (j + 1) / c2.length;
    if (j >= c2.length - 1 || (i < c1.length - 1 && ti <= tj)) { tri(c1[i], c2[j], c1[i + 1]); i++; }
    else { tri(c1[i], c2[j], c2[j + 1]); j++; }
  }
  tri(c1[i], c2[j], E);
  return { mesh: { positions: new Float32Array(pos), indices: new Uint32Array(idx) }, faceColors: colorOf ? Uint32Array.from(col) : undefined };
}

// --- stamp -----------------------------------------------------------------------------------------

const BAYER8 = [1, 49, 13, 61, 4, 52, 16, 64, 33, 17, 45, 29, 36, 20, 48, 32, 9, 57, 5, 53, 12, 60, 8, 56, 41, 25, 37, 21, 44, 28, 40, 24,
  3, 51, 15, 63, 2, 50, 14, 62, 35, 19, 47, 31, 34, 18, 46, 30, 11, 59, 7, 55, 10, 58, 6, 54, 43, 27, 39, 23, 42, 26, 38, 22];
const ORDER4 = [1, 5, 9, 2, 12, 16, 13, 6, 8, 15, 14, 10, 4, 11, 7, 3];
const ORDER2 = [51, 204, 153, 102];

function stampImage(px: ImageData, dither: number, block: number): Uint8ClampedArray {
  const { width: w, height: h, data } = px;
  const out = new Uint8ClampedArray(data.length);
  const thr = (bx: number, by: number) => dither === 3 ? 3 * BAYER8[(by % 8) * 8 + (bx % 8)] : dither === 2 ? 15 * ORDER4[(by % 4) * 4 + (bx % 4)] : ORDER2[(by % 2) * 2 + (bx % 2)];
  for (let by = 0; by * block < h; by++) for (let bx = 0; bx * block < w; bx++) {
    const m = [0, 0, 0, 0];
    let n = 0;
    for (let y = by * block; y < Math.min(h, (by + 1) * block); y++) for (let x = bx * block; x < Math.min(w, (bx + 1) * block); x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) m[c] += (data[i + c] / 255) ** 2.2;
      n++;
    }
    const L = Math.round(((W_LUM[0] * m[0] + W_LUM[1] * m[1] + W_LUM[2] * m[2]) / n) * 255);
    const a = Math.trunc((m[3] / n) ** (1 / 2.2) * 255);
    const v = thr(bx, by) < L ? 255 : 0;
    for (let y = by * block; y < Math.min(h, (by + 1) * block); y++) for (let x = bx * block; x < Math.min(w, (bx + 1) * block); x++) out.set([v, v, v, a], (y * w + x) * 4);
  }
  return out;
}

// --- entry point -----------------------------------------------------------------------------------

/**
 * The image's own pixels with their alpha (3D Builder decodes the image as is). Very large images
 * are reduced to `maxSide` pixels on their long side to keep the relief workable in a browser.
 */
export function imageData(img: CanvasImageSource & { width: number; height: number }, maxSide: number): ImageData {
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(2, Math.round(img.width * k)), h = Math.max(2, Math.round(img.height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

const hex = (d: Uint8ClampedArray, p: number) => (d[p * 4] << 16) | (d[p * 4 + 1] << 8) | d[p * 4 + 2];

export async function insertImage(px: ImageData, o: ImageInsertOptions): Promise<ImageInsertResult> {
  const { width: w, height: h } = px;
  if (o.mode === 'contour') return { mesh: await contourSolidBuilder(px, o) };
  let data: Uint8ClampedArray, H: Float64Array, colors: Uint8ClampedArray, raw: Float64Array;
  if (o.mode === 'stamp') {
    data = stampImage(px, Math.round(o.p1), Math.max(1, Math.round(o.p2) + 1));
    H = raw = heights(data, w, h, 'height', o.invert);
    colors = px.data;
  } else {
    data = medianCut(px, o.p1);
    raw = heights(data, w, h, o.mode, o.invert);
    H = smooth(raw, w, h, smoothingRadius(w, h, Math.round(o.p2)));
    colors = data;
  }
  // The height range is taken before smoothing (3D Builder): smoothed thin ridges stay below the top.
  let lo = Infinity, hi = -Infinity;
  for (const v of raw) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const r = relief(H, w, h, o.reducedColors ? (x, y) => hex(colors, y * w + x) : undefined, lo, hi);
  const mesh = normalise(r.mesh, o.width);
  // 3D Builder then runs one step of its vertex-merging simplifier at t = 0.0001, edges unlocked and
  // colours detached (they do not block merges), and without the degenerate-face test (
  // this gives exactly 3D Builder's 850 and 1 224 faces on the test image), which collapses the flat parts.
  const { simplifyTolerance } = await import('./simplify-passes');
  const simple = simplifyTolerance(mesh, 1e-4, r.faceColors, false, false, false);
  // 3D Builder leaves zero-area faces there (8 on a 40 × 30 test image), so the object is not
  // valid; 3D Assembler collapses them away and carries the colours over.
  const { cleanMesh } = await import('../repair/repair');
  const fixed = analyze(simple.mesh).degenerateFaces ? cleanMesh(simple.mesh) : simple.mesh;
  if (fixed === simple.mesh || !simple.faceColors) return { mesh: fixed, faceColors: simple.faceColors };
  const { transferFaceColors } = await import('../repair/colors');
  return { mesh: fixed, faceColors: transferFaceColors(simple.mesh, simple.faceColors, fixed) };
}

/**
 * 3D Builder's "Textures" switch (on by default): the original image is laid on every face of the
 * inserted object (top, bottom and sides) by a projection from above, repeated outside. Measured on a
 * file saved by 3D Builder: u = x / (image width × s) and, for the contour, v = (y / s + 1 − image
 * height) / image height; for the reliefs v = y / (image height × s) and only the top is textured.
 * s is the size of a pixel in mm, (x, y) in the frame of the generated mesh.
 */
export function imageTexture(mesh: MeshData, px: ImageData, o: Pick<ImageInsertOptions, 'mode' | 'width'>): ObjectTexture {
  const { width: w, height: h } = px;
  const contour = o.mode === 'contour';
  const s = o.width / Math.max(1, Math.max(w, h) - (contour ? 0 : 1));
  const nt = mesh.indices.length / 3;
  const uv = new Float32Array(nt * 6);
  const face = new Int16Array(nt);
  const P = mesh.positions;
  for (let f = 0; f < nt; f++) {
    // Reliefs: only the top carries the image (walls and bottom have no texture).
    if (!contour && [0, 1, 2].some((k) => Math.abs(P[mesh.indices[f * 3 + k] * 3 + 2]) < 1e-6)) { face[f] = -1; continue; }
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[f * 3 + k];
      uv[f * 6 + k * 2] = P[v * 3] / (w * s);
      uv[f * 6 + k * 2 + 1] = contour ? (P[v * 3 + 1] / s + 1 - h) / h : P[v * 3 + 1] / (h * s);
    }
  }
  return { images: [{ width: w, height: h, data: new Uint8ClampedArray(px.data), wrap: 'repeat' }], face, uv };
}
