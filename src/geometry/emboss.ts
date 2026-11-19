// Emboss / engrave. Like 3D Builder, the motif (text, shape or image) is first rendered to a
// bitmap and its contours are traced; the engine then cuts them into the object's surface.
// Shapes are drawn by this project; any image can be used too.
import type { MeshData } from '../core/mesh-data';
import { loadManifold } from './csg';
import { loadTextFonts, textOutline } from './font-outline';

export type Polygon = [number, number][];

// --- motifs -------------------------------------------------------------------------------------

export const SHAPES: { id: string; label: string }[] = [
  { id: 'star4', label: 'Étoile à 4 branches' },
  { id: 'star5', label: 'Étoile' },
  { id: 'star8', label: 'Étoile à 8 branches' },
  { id: 'heart', label: 'Cœur' },
  { id: 'circle', label: 'Cercle' },
  { id: 'oval', label: 'Ovale' },
  { id: 'donut', label: 'Anneau' },
  { id: 'square', label: 'Carré' },
  { id: 'rounded', label: 'Rectangle arrondi' },
  { id: 'triangle', label: 'Triangle' },
  { id: 'plus', label: 'Plus' },
  { id: 'cross', label: 'Croix' },
  { id: 'arrow', label: 'Flèche' },
  { id: 'chevron', label: 'Chevron' },
  { id: 'bolt', label: 'Éclair' },
  { id: 'moon', label: 'Lune' },
  { id: 'sun', label: 'Soleil' },
  { id: 'cloud', label: 'Nuage' },
  { id: 'wave', label: 'Vague' },
  { id: 'smiley', label: 'Sourire' },
  { id: 'forbidden', label: 'Interdit' },
];

const R = 256; // fallback text bitmap height (pixels)
// 3D Builder's shape bitmaps: 531 × 441, white shape on black.
const SHAPE_W = 531, SHAPE_H = 441;

/** Canvas with a black background (or transparent) and white ink, like 3D Builder's bitmaps. */
function canvas(w: number, h: number, background: string | null = '#000') {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  return { c, ctx };
}

function star(ctx: CanvasRenderingContext2D, n: number, inner: number) {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? inner : 1;
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
}

/** Draws a built-in shape in the unit square [-1, 1]², filled with the current (white) ink. */
function drawShape(ctx: CanvasRenderingContext2D, id: string) {
  const fillPath = (pts: [number, number][]) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (id) {
    case 'star4': star(ctx, 4, 0.38); break;
    case 'star5': star(ctx, 5, 0.42); break;
    case 'star8': star(ctx, 8, 0.55); break;
    case 'heart':
      ctx.beginPath();
      ctx.moveTo(0, 0.9);
      ctx.bezierCurveTo(-1.3, 0.05, -0.75, -1.05, 0, -0.45);
      ctx.bezierCurveTo(0.75, -1.05, 1.3, 0.05, 0, 0.9);
      ctx.fill();
      break;
    case 'circle': ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2); ctx.fill(); break;
    case 'oval': ctx.beginPath(); ctx.ellipse(0, 0, 0.95, 0.6, 0, 0, Math.PI * 2); ctx.fill(); break;
    case 'donut':
      ctx.beginPath();
      ctx.arc(0, 0, 0.95, 0, Math.PI * 2);
      ctx.arc(0, 0, 0.5, 0, Math.PI * 2, true);
      ctx.fill('evenodd');
      break;
    case 'square': ctx.fillRect(-0.9, -0.9, 1.8, 1.8); break;
    case 'rounded':
      ctx.beginPath();
      ctx.roundRect(-0.95, -0.6, 1.9, 1.2, 0.3);
      ctx.fill();
      break;
    case 'triangle': fillPath([[0, -0.9], [0.95, 0.75], [-0.95, 0.75]]); break;
    case 'plus': ctx.fillRect(-0.3, -0.9, 0.6, 1.8); ctx.fillRect(-0.9, -0.3, 1.8, 0.6); break;
    case 'cross':
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(-0.7, -0.7); ctx.lineTo(0.7, 0.7); ctx.moveTo(0.7, -0.7); ctx.lineTo(-0.7, 0.7); ctx.stroke();
      break;
    case 'arrow': fillPath([[-0.95, -0.25], [0.2, -0.25], [0.2, -0.65], [0.95, 0], [0.2, 0.65], [0.2, 0.25], [-0.95, 0.25]]); break;
    case 'chevron': fillPath([[-0.6, -0.9], [0.1, -0.9], [0.8, 0], [0.1, 0.9], [-0.6, 0.9], [0.1, 0]]); break;
    case 'bolt': fillPath([[0.15, -0.95], [-0.55, 0.12], [-0.05, 0.12], [-0.2, 0.95], [0.55, -0.15], [0.05, -0.15]]); break;
    case 'moon':
      ctx.beginPath();
      ctx.arc(0, 0, 0.9, 0, Math.PI * 2);
      ctx.fill();
      // The bite is cut out of the disc (it overhangs the disc, so no even-odd fill).
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(0.4, -0.2, 0.75, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      break;
    case 'sun':
      ctx.beginPath(); ctx.arc(0, 0, 0.45, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 0.14;
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6;
        ctx.beginPath(); ctx.moveTo(Math.cos(a) * 0.6, Math.sin(a) * 0.6); ctx.lineTo(Math.cos(a) * 0.92, Math.sin(a) * 0.92); ctx.stroke();
      }
      break;
    case 'cloud':
      ctx.beginPath();
      ctx.arc(-0.45, 0.15, 0.4, 0, Math.PI * 2);
      ctx.arc(0.05, -0.15, 0.5, 0, Math.PI * 2);
      ctx.arc(0.5, 0.15, 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(-0.45, 0.15, 0.95, 0.4);
      break;
    case 'wave':
      ctx.lineWidth = 0.28;
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const x = -0.85 + (i / 40) * 1.7;
        const y = Math.sin((i / 40) * Math.PI * 3) * 0.35;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      break;
    case 'smiley':
      ctx.beginPath();
      ctx.arc(0, 0, 0.95, 0, Math.PI * 2);
      ctx.moveTo(-0.25, -0.3); ctx.arc(-0.33, -0.3, 0.12, 0, Math.PI * 2);
      ctx.moveTo(0.45, -0.3); ctx.arc(0.33, -0.3, 0.12, 0, Math.PI * 2);
      ctx.fill('evenodd');
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = 0.13;
      ctx.beginPath(); ctx.arc(0, 0.05, 0.5, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      break;
    case 'forbidden':
      ctx.beginPath();
      ctx.arc(0, 0, 0.95, 0, Math.PI * 2);
      ctx.arc(0, 0, 0.72, 0, Math.PI * 2, true);
      ctx.fill('evenodd');
      ctx.save();
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-0.75, -0.12, 1.5, 0.24);
      ctx.restore();
      break;
  }
}

export interface Motif {
  kind: 'text' | 'shape' | 'image';
  text?: string;
  font?: string;
  bold?: boolean;
  shape?: string;
  image?: HTMLImageElement | ImageBitmap;
}

/** Largest side of a user image passed to the tracer (3D Builder uses the image as decoded). */
const MAX_IMAGE = 4096;

/**
 * Renders a shape or image motif to the bitmap the tracer reads, as 3D Builder: shapes are white
 * on black in a 531 × 441 bitmap; images keep their pixels and alpha. Text is only rasterised as
 * a fallback, when the font file cannot be read (3D Builder uses the glyph outlines).
 */
export function rasterize(m: Motif): ImageData {
  if (m.kind === 'text') {
    const font = `${m.bold === false ? '400' : '700'} ${R * 0.8}px "${m.font || 'Segoe UI'}", sans-serif`;
    const probe = canvas(8, 8).ctx;
    probe.font = font;
    const w = Math.max(8, Math.ceil(probe.measureText(m.text || ' ').width + R * 0.2));
    const { ctx } = canvas(w, R);
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.fillText(m.text || ' ', R * 0.1, R / 2);
    return ctx.getImageData(0, 0, w, R);
  }
  if (m.kind === 'image' && m.image) {
    const k = Math.min(1, MAX_IMAGE / Math.max(m.image.width, m.image.height));
    const w = Math.max(1, Math.round(m.image.width * k)), h = Math.max(1, Math.round(m.image.height * k));
    const { ctx } = canvas(w, h, null);
    ctx.drawImage(m.image, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }
  const { ctx } = canvas(SHAPE_W, SHAPE_H);
  const s = SHAPE_H / 2.1;
  ctx.setTransform(s, 0, 0, s, SHAPE_W / 2, SHAPE_H / 2);
  drawShape(ctx, m.shape || 'star5');
  return ctx.getImageData(0, 0, SHAPE_W, SHAPE_H);
}

// --- contour tracing (3D Builder's method) ---------------------------------------------------------
// Intensity v = max(R, G, B) × alpha (or alpha alone for a single-colour image, optionally
// inverted), pixels with v ≥ threshold are ink. Contours are traced by 8-direction Moore-neighbour tracing on pixel
// centres, each one flagged outer or hole by a flood fill, then simplified by Ramer-Douglas-Peucker.

// Neighbours clockwise on screen (y down): NW, N, NE, E, SE, S, SW, W.
const DX = [-1, 0, 1, 1, 1, 0, -1, -1];
const DY = [-1, -1, -1, 0, 1, 1, 1, 0];
/** First direction searched after a move in direction d. */
const NEXT = [6, 0, 0, 2, 2, 4, 4, 6];

export interface TraceOptions {
  /** Ink threshold on the 0-255 intensity (at least 1). */
  threshold?: number;
  /** Ramer-Douglas-Peucker tolerance in pixels (3D Builder's emboss: 2). */
  tolerance?: number;
  /** Dark ink on a light background (intensity inverted). */
  invert?: boolean;
}

/**
 * Traces the contours of the ink in a bitmap. Returns closed polygons in pixel units (y down,
 * pixel centres), outer contours with positive shoelace area in y-down coordinates, holes negative.
 */
export function traceContours(img: ImageData, opts: TraceOptions | number = {}): Polygon[] {
  const o = typeof opts === 'number' ? { tolerance: opts } : opts;
  const threshold = Math.max(1, Math.round(o.threshold ?? 128));
  const tol = o.tolerance ?? 2;
  const { width: w, height: h, data } = img;
  // Single-colour image (every pixel within ±10 of the first in R, G and B): alpha is the mask.
  let uniform = true;
  for (let i = 4; i < w * h * 4 && uniform; i += 4) {
    for (let c = 0; c < 3; c++) if (Math.abs(data[i + c] - data[c]) > 10) { uniform = false; break; }
  }
  // Padded grid: one background pixel on every side.
  const W = w + 2, H = h + 2;
  const ink = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let v = uniform ? data[i + 3] : Math.trunc((Math.max(data[i], data[i + 1], data[i + 2]) / 255) * data[i + 3]);
    if (o.invert) v = 255 - v;
    ink[(y + 1) * W + x + 1] = v >= threshold ? 1 : 0;
  }
  const visited = new Uint8Array(W * H);
  // Background regions (4-connected): 0 = outside, k > 0 = an enclosed region, traced once as a hole.
  const region = new Int32Array(W * H).fill(-1);
  {
    let next = 1;
    for (let s = 0; s < W * H; s++) {
      if (ink[s] || region[s] >= 0) continue;
      const id = s === 0 ? 0 : next++;
      const stack = [s];
      region[s] = id;
      let outside = false;
      const members: number[] = [];
      while (stack.length) {
        const q = stack.pop()!;
        members.push(q);
        const x = q % W, y = (q - x) / W;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) outside = true;
        for (const r of [x > 0 ? q - 1 : -1, x < W - 1 ? q + 1 : -1, y > 0 ? q - W : -1, y < H - 1 ? q + W : -1]) {
          if (r < 0 || ink[r] || region[r] >= 0) continue;
          region[r] = id;
          stack.push(r);
        }
      }
      if (outside) for (const q of members) region[q] = 0;
    }
  }
  const holeTraced = new Set<number>();

  /** Moore tracing from pixel s, with the backtrack direction b. */
  const trace = (s: number, b: number): [number, number][] => {
    const sx = s % W, sy = (s - sx) / W;
    let d0 = -1;
    for (let k = 1; k <= 7; k++) {
      const d = (b + k) % 8;
      if (ink[(sy + DY[d]) * W + sx + DX[d]]) { d0 = d; break; }
    }
    visited[s] = 1;
    if (d0 < 0) return []; // isolated pixel
    const pts: [number, number][] = [];
    const second = s + DY[d0] * W + DX[d0];
    let cur = second, d = d0;
    for (let guard = 0; guard < 4 * W * H; guard++) {
      const cx = cur % W, cy = (cur - cx) / W;
      let nd = -1;
      for (let k = 0; k < 8; k++) {
        const t = (NEXT[d] + k) % 8;
        if (ink[(cy + DY[t]) * W + cx + DX[t]]) { nd = t; break; }
      }
      if (nd < 0) break;
      pts.push([cx - 1, cy - 1]);
      visited[cur] = 1;
      cur = cur + DY[nd] * W + DX[nd];
      d = nd;
      if (cur === second && d === d0) break;
    }
    return pts;
  };

  /** 4-connected fill over unvisited pixels inside the contour's box: reaching its edge = outer. */
  const isHole = (seed: number, pts: [number, number][]): boolean => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x + 1); x1 = Math.max(x1, x + 1);
      y0 = Math.min(y0, y + 1); y1 = Math.max(y1, y + 1);
    }
    const seen = new Set<number>([seed]);
    const stack = [seed];
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % W, py = (p - px) / W;
      if (px <= x0 || px >= x1 || py <= y0 || py >= y1) return false;
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (visited[q] || seen.has(q)) continue;
        seen.add(q);
        stack.push(q);
      }
    }
    return true;
  };

  const polys: Polygon[] = [];
  const emit = (pts: [number, number][], hole: boolean) => {
    if (pts.length <= 2) return;
    let p = rdp(pts, tol);
    if (p.length < 3) return;
    if ((shoelace(p) > 0) === hole) p = p.reverse();
    polys.push(p);
  };
  for (let y = 1; y <= h; y++) for (let x = 1; x <= w; x++) {
    const i = y * W + x;
    if (!ink[i - 1] && ink[i] && !visited[i]) {
      const pts = trace(i, 7); // outer start, backtrack west
      emit(pts, isHole(i - 1, pts));
    } else if (ink[i - 1] && !ink[i] && region[i] > 0 && !holeTraced.has(region[i])) {
      // 3D Builder starts a hole only if the pixel left of it is not yet visited, so a hole whose
      // rim is one pixel thin (already traced as the outer contour) is lost: a thin ring comes out
      // as a filled disc. 3D Assembler traces every enclosed background region once.
      holeTraced.add(region[i]);
      const pts = trace(i - 1, 3); // hole start, backtrack east
      emit(pts, isHole(i, pts));
    }
  }
  return polys;
}

function shoelace(p: Polygon): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i], r = p[(i + 1) % p.length];
    a += q[0] * r[1] - r[0] * q[1];
  }
  return a / 2;
}

/**
 * Ramer-Douglas-Peucker on the loop taken as an open polyline P[0]..P[n-1] (its chord joins two
 * neighbouring pixels). 3D Builder never tests the last interior point of a span (it stops
 * one short), so a corner just before a split point can be lost; 3D Assembler tests every point.
 */
function rdp(P: Polygon, tol: number): Polygon {
  const keep = new Uint8Array(P.length);
  keep[0] = keep[P.length - 1] = 1;
  const span = (a: number, b: number) => {
    while (b - a > 1) {
      const [ax, ay] = P[a], [bx, by] = P[b];
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      let best = -1, idx = -1;
      for (let i = a + 1; i <= b - 1; i++) {
        const d = len ? Math.abs((P[i][0] - ax) * dy - (P[i][1] - ay) * dx) / len : Math.hypot(P[i][0] - ax, P[i][1] - ay);
        if (d > best) { best = d; idx = i; }
      }
      if (idx < 0 || best <= tol) return;
      keep[idx] = 1;
      span(a, idx);
      a = idx;
    }
  };
  span(0, P.length - 1);
  return P.filter((_, i) => keep[i]);
}

/**
 * Motif outline in millimetres, centred (y up). Text: the glyph outlines of the bold system font
 * at an em size of `size` mm, as 3D Builder (bitmap tracing only when the font file is out of
 * reach). Shapes and images: traced bitmap, `size` mm tall.
 */
export async function motifOutline(m: Motif, size: number): Promise<Polygon[]> {
  if (m.kind === 'text') {
    const fonts = await loadTextFonts(m.font || 'Segoe UI', m.bold !== false, m.text || '');
    if (fonts) {
      const glyphs = textOutline(fonts, m.text || '', size);
      if (!glyphs.length) return [];
      // Overlapping contours are merged with the non-zero rule (as 3D Builder).
      const wasm = await loadManifold();
      const cs = new wasm.CrossSection(glyphs, 'NonZero');
      const polys = (cs.toPolygons() as unknown as Polygon[]).filter((p) => p.length >= 3);
      cs.delete();
      return centred(polys);
    }
  }
  const img = rasterize(m);
  const polys = traceContours(img);
  const s = size / img.height;
  return polys.map((p) => p.map(([x, y]) => [(x - img.width / 2) * s, (img.height / 2 - y) * s] as [number, number]));
}

function centred(polys: Polygon[]): Polygon[] {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return polys.map((p) => p.map(([x, y]) => [x - cx, y - cy] as [number, number]));
}


// --- combining with the object ---------------------------------------------------------------------
// 3D Builder's method: the contours are cut into the surface and the vertices under the motif are
// moved along the projection (see emboss-engine.ts). No boolean operation is involved.

import { type Direction, type EmbossOptions, type EmbossResult, type Projection, embossMesh } from './emboss-engine';

export type { Direction, EmbossOptions, EmbossResult, Projection };

export const DIRECTIONS: { id: Direction; label: string }[] = [
  { id: '-y', label: 'Avant' },
  { id: '+y', label: 'Arrière' },
  { id: '-x', label: 'Gauche' },
  { id: '+x', label: 'Droite' },
  { id: '+z', label: 'Dessus' },
];

export const PROJECTIONS: { id: Projection; label: string }[] = [
  { id: 'planar', label: 'Planaire' },
  { id: 'cylindrical', label: 'Cylindrique' },
  { id: 'spherical', label: 'Sphérique' },
];

export function emboss(mesh: MeshData, o: EmbossOptions): Promise<EmbossResult> {
  return embossMesh(mesh, o);
}