// Textures applied as per-face colours ("wallpaper"): the image is projected on the faces and
// each face takes the colour under its centre. Built-in textures are drawn procedurally.
import type { MeshData } from '../core/mesh-data';

export const TEXTURES: { id: string; label: string }[] = [
  { id: 'checker', label: 'Damier' },
  { id: 'stripes', label: 'Rayures' },
  { id: 'wood', label: 'Bois' },
  { id: 'marble', label: 'Marbre' },
  { id: 'bricks', label: 'Briques' },
  { id: 'dots', label: 'Pois' },
  // Same kinds of surfaces as 3D Builder's 24 textures, drawn by code (its images are not reused).
  { id: 'lightWood', label: 'Bois clair' },
  { id: 'darkWood', label: 'Bois foncé' },
  { id: 'planks', label: 'Planches' },
  { id: 'cork', label: 'Liège' },
  { id: 'denim', label: 'Toile de jean' },
  { id: 'burlap', label: 'Toile de jute' },
  { id: 'parchment', label: 'Parchemin' },
  { id: 'paper', label: 'Papier' },
  { id: 'sand', label: 'Sable' },
  { id: 'granite', label: 'Granit' },
  { id: 'greenMarble', label: 'Marbre vert' },
  { id: 'plaster', label: 'Plâtre' },
  { id: 'leather', label: 'Cuir' },
  { id: 'crumpled', label: 'Papier froissé' },
  { id: 'glitter', label: 'Paillettes' },
  { id: 'pastelBlue', label: 'Pastel bleu' },
  { id: 'pastelPink', label: 'Pastel rose' },
  { id: 'stone', label: 'Pierre' },
];

export interface TexturePixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Deterministic value noise for the procedural textures. */
function noise(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function smoothNoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = noise(xi, yi), b = noise(xi + 1, yi), c = noise(xi, yi + 1), d = noise(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number): number {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < 5; i++) {
    v += amp * smoothNoise(x * f, y * f);
    f *= 2;
    amp *= 0.5;
  }
  return v;
}

const cache = new Map<string, TexturePixels>();

/** Built-in texture (drawn once, then reused). */
export function proceduralTexture(id: string, size = 256): TexturePixels {
  const key = id + '@' + size;
  let hit = cache.get(key);
  if (!hit) cache.set(key, (hit = drawTexture(id, size)));
  return hit;
}

function drawTexture(id: string, size: number): TexturePixels {
  const data = new Uint8ClampedArray(size * size * 4);
  const put = (x: number, y: number, r: number, g: number, b: number) => data.set([r, g, b, 255], (y * size + x) * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    switch (id) {
      case 'checker': {
        const on = (Math.floor(u * 8) + Math.floor(v * 8)) % 2 === 0;
        on ? put(x, y, 30, 30, 34) : put(x, y, 235, 235, 238);
        break;
      }
      case 'stripes': {
        const on = Math.floor((u + v) * 10) % 2 === 0;
        on ? put(x, y, 214, 61, 61) : put(x, y, 245, 240, 230);
        break;
      }
      case 'wood': {
        const r = Math.hypot(u - 0.2, (v - 0.5) * 0.25) * 22 + fbm(u * 4, v * 4) * 3;
        const ring = 0.5 + 0.5 * Math.sin(r * Math.PI);
        put(x, y, 150 + ring * 60, 95 + ring * 45, 50 + ring * 25);
        break;
      }
      case 'marble': {
        const t = 0.5 + 0.5 * Math.sin((u * 6 + fbm(u * 5, v * 5) * 6) * Math.PI);
        const c = 200 + t * 50;
        put(x, y, c, c, c - t * 8);
        break;
      }
      case 'bricks': {
        const rows = 8, row = Math.floor(v * rows), off = row % 2 ? 0.5 : 0;
        const bx = (u * 4 + off) % 1, by = (v * rows) % 1;
        const mortar = bx < 0.05 || by < 0.1;
        const shade = 0.85 + 0.3 * noise(Math.floor(u * 4 + off), row);
        mortar ? put(x, y, 205, 200, 190) : put(x, y, 165 * shade, 70 * shade, 50 * shade);
        break;
      }
      case 'dots': {
        const cx = (u * 8) % 1 - 0.5, cy = (v * 8) % 1 - 0.5;
        Math.hypot(cx, cy) < 0.28 ? put(x, y, 40, 110, 200) : put(x, y, 245, 245, 245);
        break;
      }
      default: {
        const c = surface(id, u, v);
        put(x, y, c[0], c[1], c[2]);
      }
    }
  }
  return { width: size, height: size, data };
}

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** The other surfaces: a base colour pair blended by noise patterns. */
function surface(id: string, u: number, v: number): RGB {
  const n = fbm(u * 8, v * 8), fine = noise(u * 997, v * 991);
  switch (id) {
    case 'lightWood': case 'darkWood': {
      const ring = 0.5 + 0.5 * Math.sin((v * 18 + fbm(u * 2, v * 6) * 4) * Math.PI);
      return id === 'lightWood' ? mix([222, 186, 140], [196, 150, 98], ring) : mix([112, 66, 36], [74, 40, 20], ring);
    }
    case 'planks': {
      const row = Math.floor(v * 5), seam = (v * 5) % 1 < 0.04;
      const ring = 0.5 + 0.5 * Math.sin((u * 30 + fbm(u * 3, v * 10 + row) * 5) * Math.PI);
      const base = mix([184, 120, 62], [150, 92, 44], ring * (0.8 + 0.2 * noise(row, 3)));
      return seam ? [70, 42, 20] : base;
    }
    case 'cork': return mix([196, 140, 86], [140, 92, 50], clamp01(fine * 0.7 + n * 0.6 - 0.2));
    case 'denim': {
      const weave = ((Math.floor(u * 128) + Math.floor(v * 128)) % 4 < 2) ? 1 : 0.8;
      return mix([60, 90, 150], [100, 130, 190], n * weave);
    }
    case 'burlap': {
      const wx = 0.5 + 0.5 * Math.sin(u * 64 * Math.PI), wy = 0.5 + 0.5 * Math.sin(v * 64 * Math.PI);
      return mix([150, 118, 74], [206, 170, 116], clamp01((wx + wy) / 2 + (fine - 0.5) * 0.3));
    }
    case 'parchment': return mix([236, 214, 170], [206, 174, 120], clamp01(fbm(u * 3, v * 3) * 1.4 - 0.2));
    case 'paper': return mix([246, 240, 220], [228, 220, 196], clamp01(n + (fine - 0.5) * 0.2));
    case 'sand': return mix([228, 204, 160], [196, 168, 120], clamp01(fine * 0.6 + n * 0.5 - 0.1));
    case 'granite': {
      const speck = fine > 0.86 ? 1 : fine < 0.12 ? -1 : 0;
      const base = mix([150, 150, 152], [190, 188, 186], n);
      return speck > 0 ? [235, 232, 228] : speck < 0 ? [40, 40, 44] : base;
    }
    case 'greenMarble': {
      const vein = Math.abs(Math.sin((u * 4 + fbm(u * 4, v * 4) * 7) * Math.PI));
      return vein < 0.08 ? [210, 230, 215] : mix([20, 84, 52], [40, 120, 76], n);
    }
    case 'plaster': return mix([238, 236, 230], [214, 212, 206], clamp01(fine * 0.5 + n * 0.5));
    case 'leather': {
      const cell = fbm(u * 24, v * 24);
      return mix([96, 56, 30], [140, 86, 48], clamp01(cell * 1.3 - 0.15));
    }
    case 'crumpled': {
      const ridge = 1 - Math.abs(fbm(u * 5, v * 5) * 2 - 1);
      return mix([120, 196, 214], [200, 236, 242], ridge);
    }
    case 'glitter': return fine > 0.9 ? [230, 200, 255] : mix([60, 20, 110], [100, 50, 160], n);
    case 'pastelBlue': return mix([200, 222, 246], [220, 236, 252], n);
    case 'pastelPink': return mix([240, 204, 210], [250, 222, 228], n);
    case 'stone': return mix([120, 116, 108], [176, 170, 160], clamp01(fbm(u * 6, v * 6) * 1.3 - 0.15));
    default: return [200, 200, 200];
  }
}

/** Pixel colour (0xRRGGBB) at texture coordinates (u, v), tiled. */
export function sample(tex: TexturePixels, u: number, v: number): number {
  const x = Math.floor((((u % 1) + 1) % 1) * tex.width);
  const y = Math.floor((1 - (((v % 1) + 1) % 1)) * tex.height) % tex.height;
  const i = (y * tex.width + x) * 4;
  return (tex.data[i] << 16) | (tex.data[i + 1] << 8) | tex.data[i + 2];
}

export interface Projector {
  origin: number[]; // world point mapped to texture (0.5, 0.5) for stickers, (0, 0) for tiling
  u: number[]; // world direction of texture +u
  v: number[]; // world direction of texture +v
  size: number; // mm covered by one texture repetition
}

/** Colours the given faces from a planar projection; `clip` keeps a single (non-tiled) copy. */
export function projectTexture(
  m: MeshData, faces: Iterable<number>, tex: TexturePixels, pr: Projector, colors: Uint32Array, clip: boolean, normal?: number[],
): void {
  const p = m.positions, t = m.indices;
  for (const f of faces) {
    const a = t[f * 3] * 3, b = t[f * 3 + 1] * 3, c = t[f * 3 + 2] * 3;
    if (normal) {
      // Only faces turned towards the projector receive a sticker.
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * normal[0] + ny * normal[1] + nz * normal[2] <= 0) continue;
    }
    const cx = (p[a] + p[b] + p[c]) / 3 - pr.origin[0];
    const cy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3 - pr.origin[1];
    const cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3 - pr.origin[2];
    let tu = (cx * pr.u[0] + cy * pr.u[1] + cz * pr.u[2]) / pr.size;
    let tv = (cx * pr.v[0] + cy * pr.v[1] + cz * pr.v[2]) / pr.size;
    if (clip) {
      const ar = tex.width / tex.height;
      tu = tu / ar + 0.5;
      tv = tv + 0.5;
      if (tu < 0 || tu > 1 || tv < 0 || tv > 1) continue;
    }
    colors[f] = sample(tex, tu, tv);
  }
}

/** Two directions spanning the plane perpendicular to n (v as close to world up as possible). */
export function planeAxes(n: number[]): { u: number[]; v: number[] } {
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  const d = [n[0] / l, n[1] / l, n[2] / l];
  const up = Math.abs(d[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
  const u = [up[1] * d[2] - up[2] * d[1], up[2] * d[0] - up[0] * d[2], up[0] * d[1] - up[1] * d[0]];
  const ul = Math.hypot(u[0], u[1], u[2]) || 1;
  const uu = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v = [d[1] * uu[2] - d[2] * uu[1], d[2] * uu[0] - d[0] * uu[2], d[0] * uu[1] - d[1] * uu[0]];
  return { u: uu, v };
}

export interface WallpaperOptions { repeatX: number; repeatY: number; rotation: number; offsetX: number; offsetY: number }
export const WALLPAPER_DEFAULTS: WallpaperOptions = { repeatX: 1, repeatY: 1, rotation: 0, offsetX: 0, offsetY: 0 };

/**
 * 3D Builder's wallpaper (texture brush): the region is projected on the plane perpendicular to
 * the clicked face's normal; the image is fitted to the region's box there, repeated repeatX ×
 * repeatY times, rotated about the box centre and offset (texture units), and every corner gets
 * its texture coordinates. 3D Builder stretches the image to the box (distorting it, and dividing
 * by zero on a box of zero width); 3D Assembler keeps the image's proportions and covers the box.
 * Returns the texture coordinates of the faces' corners (6 numbers per face, in `faces` order).
 */
export function wallpaperUV(m: MeshData, faces: number[], normal: number[], aspect: number, o: WallpaperOptions): Float32Array {
  const p = m.positions, t = m.indices;
  const { u, v } = planeAxes(normal);
  const proj = (i: number) => [p[i * 3] * u[0] + p[i * 3 + 1] * u[1] + p[i * 3 + 2] * u[2], p[i * 3] * v[0] + p[i * 3 + 1] * v[1] + p[i * 3 + 2] * v[2]];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const f of faces) for (let k = 0; k < 3; k++) {
    const [x, y] = proj(t[f * 3 + k]);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const k = Math.max((x1 - x0) / aspect, y1 - y0) || 1; // image height covering the box, in mm
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const th = (o.rotation * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th);
  const out = new Float32Array(faces.length * 6);
  faces.forEach((f, j) => {
    for (let c = 0; c < 3; c++) {
      const [x, y] = proj(t[f * 3 + c]);
      const u0 = ((x - cx) * o.repeatX) / (k * aspect), v0 = ((y - cy) * o.repeatY) / k;
      out[j * 6 + c * 2] = u0 * cos - v0 * sin + 0.5 * o.repeatX + o.offsetX;
      out[j * 6 + c * 2 + 1] = u0 * sin + v0 * cos + 0.5 * o.repeatY + o.offsetY;
    }
  });
  return out;
}

/** Colour version of the wallpaper (each face takes the image colour at its centre). */
export function wallpaper(m: MeshData, faces: number[], normal: number[], tex: TexturePixels, o: WallpaperOptions, colors: Uint32Array): void {
  const uv = wallpaperUV(m, faces, normal, tex.width / tex.height, o);
  faces.forEach((f, j) => {
    colors[f] = sample(tex, (uv[j * 6] + uv[j * 6 + 2] + uv[j * 6 + 4]) / 3, (uv[j * 6 + 1] + uv[j * 6 + 3] + uv[j * 6 + 5]) / 3);
  });
}

/**
 * Sticker: one copy of the image projected along `d` (frame u, v), centred on `origin`, `size`
 * mm tall. Returns the faces turned towards the projector that the image covers, with their
 * corners' texture coordinates (image in [0, 1]², transparent around in the padded texture).
 */
export function stickerUV(m: MeshData, d: number[], u: number[], v: number[], origin: number[], size: number, aspect: number): { faces: number[]; uv: number[] } {
  const p = m.positions, t = m.indices;
  const faces: number[] = [], uv: number[] = [];
  for (let f = 0; f < t.length / 3; f++) {
    const a = t[f * 3] * 3, b = t[f * 3 + 1] * 3, c = t[f * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * d[0] + ny * d[1] + nz * d[2] <= 0) continue; // only faces turned towards the projector (same side as d)
    const tc: number[] = [];
    for (const i of [a, b, c]) {
      const x = p[i] - origin[0], y = p[i + 1] - origin[1], z = p[i + 2] - origin[2];
      tc.push((x * u[0] + y * u[1] + z * u[2]) / (size * aspect) + 0.5, (x * v[0] + y * v[1] + z * v[2]) / size + 0.5);
    }
    const us = [tc[0], tc[2], tc[4]], vs = [tc[1], tc[3], tc[5]];
    if (Math.max(...us) < 0 || Math.min(...us) > 1 || Math.max(...vs) < 0 || Math.min(...vs) > 1) continue;
    faces.push(f);
    uv.push(...tc);
  }
  return { faces, uv };
}

/** The image with a one-pixel transparent border, and the texture coordinates mapped into it. */
export function padImage(px: { width: number; height: number; data: Uint8ClampedArray }): { width: number; height: number; data: Uint8ClampedArray; map: (u: number, v: number) => [number, number] } {
  const w = px.width + 2, h = px.height + 2;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < px.height; y++) data.set(px.data.subarray(y * px.width * 4, (y + 1) * px.width * 4), ((y + 1) * w + 1) * 4);
  return { width: w, height: h, data, map: (u, v) => [(1 + u * px.width) / w, (1 + v * px.height) / h] };
}
