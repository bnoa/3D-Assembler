// Text as glyph outlines, the way 3D Builder's emboss draws text: each glyph's
// outline at emSize, quadratic curves flattened (0.0005 in its tool space, 0.001 em here), pen advanced by the design
// advance width (no kerning), near-duplicate points dropped (emSize × 0.005).
// Minimal TrueType reader (glyf outlines, also inside .ttc collections); CFF fonts are not read.

import { NOMINAL, shapeArabic } from './arabic';
import { visualOrder } from './bidi';

export { visualOrder };

export interface Font {
  unitsPerEm: number;
  glyphIndex(codePoint: number): number;
  advance(glyph: number): number;
  /** Contours in font units, y up: points with on-curve flags. */
  contours(glyph: number): { x: number; y: number; on: boolean }[][];
}

export class FontFormatError extends Error {}

export function parseFont(buf: ArrayBuffer, preferredName?: string): Font {
  const dv = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  let offsets = [0];
  if (tag(0) === 'ttcf') {
    const n = dv.getUint32(8);
    offsets = Array.from({ length: n }, (_, i) => dv.getUint32(12 + i * 4));
  }
  const fonts = offsets.map((o) => readFace(dv, o, tag));
  if (preferredName) {
    const want = preferredName.toLowerCase();
    const hit = fonts.find((f) => f.names.some((n) => n.toLowerCase() === want));
    if (hit) return hit.font;
  }
  return fonts[0].font;
}

function readFace(dv: DataView, base: number, tag: (o: number) => string): { font: Font; names: string[] } {
  const numTables = dv.getUint16(base + 4);
  const tables = new Map<string, number>();
  for (let i = 0; i < numTables; i++) {
    const r = base + 12 + i * 16;
    tables.set(tag(r), dv.getUint32(r + 8));
  }
  const need = (t: string) => {
    const o = tables.get(t);
    if (o === undefined) throw new FontFormatError(t === 'glyf' && tables.has('CFF ') ? 'Police CFF non prise en charge.' : `Table ${t} absente.`);
    return o;
  };
  const head = need('head'), maxp = need('maxp'), hhea = need('hhea'), hmtx = need('hmtx');
  const loca = need('loca'), glyf = need('glyf'), cmap = need('cmap');
  const unitsPerEm = dv.getUint16(head + 18);
  const longLoca = dv.getInt16(head + 50) === 1;
  const numGlyphs = dv.getUint16(maxp + 4);
  const numHMetrics = dv.getUint16(hhea + 34);
  const glyphOffset = (g: number) => (longLoca ? dv.getUint32(loca + g * 4) : dv.getUint16(loca + g * 2) * 2);

  // cmap: prefer a Unicode format 12 subtable, else format 4.
  let f4 = -1, f12 = -1;
  const nSub = dv.getUint16(cmap + 2);
  for (let i = 0; i < nSub; i++) {
    const r = cmap + 4 + i * 8;
    const pid = dv.getUint16(r), eid = dv.getUint16(r + 2), off = cmap + dv.getUint32(r + 4);
    const fmt = dv.getUint16(off);
    const unicode = pid === 0 || (pid === 3 && (eid === 1 || eid === 10));
    if (!unicode) continue;
    if (fmt === 12 && f12 < 0) f12 = off;
    if (fmt === 4 && f4 < 0) f4 = off;
  }
  const glyphIndex = (cp: number): number => {
    if (f12 >= 0) {
      const n = dv.getUint32(f12 + 12);
      for (let i = 0; i < n; i++) {
        const r = f12 + 16 + i * 12;
        const s = dv.getUint32(r), e = dv.getUint32(r + 4);
        if (cp >= s && cp <= e) return dv.getUint32(r + 8) + cp - s;
      }
      return 0;
    }
    if (f4 < 0 || cp > 0xffff) return 0;
    const segX2 = dv.getUint16(f4 + 6);
    const ends = f4 + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let i = 0; i < segX2; i += 2) {
      if (cp > dv.getUint16(ends + i)) continue;
      const s = dv.getUint16(starts + i);
      if (cp < s) return 0;
      const delta = dv.getInt16(deltas + i), ro = dv.getUint16(ranges + i);
      if (!ro) return (cp + delta) & 0xffff;
      const g = dv.getUint16(ranges + i + ro + (cp - s) * 2);
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  };
  const advance = (g: number) => dv.getUint16(hmtx + Math.min(g, numHMetrics - 1) * 4);

  const contours = (g: number, depth = 0): { x: number; y: number; on: boolean }[][] => {
    if (g < 0 || g >= numGlyphs || depth > 8) return [];
    const start = glyphOffset(g), end = glyphOffset(g + 1);
    if (end <= start) return [];
    const p = glyf + start;
    const nc = dv.getInt16(p);
    if (nc >= 0) {
      const endPts: number[] = [];
      for (let i = 0; i < nc; i++) endPts.push(dv.getUint16(p + 10 + i * 2));
      const n = nc ? endPts[nc - 1] + 1 : 0;
      let q = p + 10 + nc * 2;
      q += 2 + dv.getUint16(q); // instructions
      const flags: number[] = [];
      while (flags.length < n) {
        const f = dv.getUint8(q++);
        flags.push(f);
        if (f & 8) {
          const rep = dv.getUint8(q++);
          for (let k = 0; k < rep; k++) flags.push(f);
        }
      }
      const xs: number[] = [], ys: number[] = [];
      let v = 0;
      for (const f of flags) {
        if (f & 2) { const d = dv.getUint8(q++); v += f & 16 ? d : -d; }
        else if (!(f & 16)) { v += dv.getInt16(q); q += 2; }
        xs.push(v);
      }
      v = 0;
      for (const f of flags) {
        if (f & 4) { const d = dv.getUint8(q++); v += f & 32 ? d : -d; }
        else if (!(f & 32)) { v += dv.getInt16(q); q += 2; }
        ys.push(v);
      }
      const out: { x: number; y: number; on: boolean }[][] = [];
      let s = 0;
      for (const e of endPts) {
        const c = [];
        for (let i = s; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
        out.push(c);
        s = e + 1;
      }
      return out;
    }
    // Composite glyph.
    const out: { x: number; y: number; on: boolean }[][] = [];
    let q = p + 10;
    for (;;) {
      const fl = dv.getUint16(q), gi = dv.getUint16(q + 2);
      q += 4;
      let dx: number, dy: number;
      if (fl & 1) { dx = dv.getInt16(q); dy = dv.getInt16(q + 2); q += 4; }
      else { dx = dv.getInt8(q); dy = dv.getInt8(q + 1); q += 2; }
      let a = 1, b = 0, c = 0, d = 1;
      if (fl & 8) { a = d = dv.getInt16(q) / 16384; q += 2; }
      else if (fl & 0x40) { a = dv.getInt16(q) / 16384; d = dv.getInt16(q + 2) / 16384; q += 4; }
      else if (fl & 0x80) { a = dv.getInt16(q) / 16384; b = dv.getInt16(q + 2) / 16384; c = dv.getInt16(q + 4) / 16384; d = dv.getInt16(q + 6) / 16384; q += 8; }
      if (!(fl & 2)) { dx = 0; dy = 0; } // point matching: not supported, placed at origin
      for (const ct of contours(gi, depth + 1)) out.push(ct.map((pt) => ({ x: a * pt.x + c * pt.y + dx, y: b * pt.x + d * pt.y + dy, on: pt.on })));
      if (!(fl & 0x20)) break;
    }
    return out;
  };

  // Family and full names (name IDs 1, 4, 16), to pick a face inside a collection.
  const names: string[] = [];
  const nameT = tables.get('name');
  if (nameT !== undefined) {
    const count = dv.getUint16(nameT + 2), strings = nameT + dv.getUint16(nameT + 4);
    for (let i = 0; i < count; i++) {
      const r = nameT + 6 + i * 12;
      const pid = dv.getUint16(r), id = dv.getUint16(r + 6), len = dv.getUint16(r + 8), off = dv.getUint16(r + 10);
      if (pid !== 3 || (id !== 1 && id !== 4 && id !== 16)) continue;
      let s = '';
      for (let k = 0; k < len; k += 2) s += String.fromCharCode(dv.getUint16(strings + off + k));
      names.push(s);
    }
  }
  return { font: { unitsPerEm, glyphIndex, advance, contours }, names };
}

type Pt = [number, number];

/** Flattens a quadratic Bézier: as many segments as needed for the given flatness tolerance. */
function flattenQuad(out: Pt[], p0: Pt, p1: Pt, p2: Pt, tol: number) {
  const ex = (p0[0] - 2 * p1[0] + p2[0]) / 4, ey = (p0[1] - 2 * p1[1] + p2[1]) / 4;
  const n = Math.max(1, Math.ceil(Math.sqrt(Math.hypot(ex, ey) / tol)));
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
}

/**
 * Polygons of a text line (y up, origin at the start of the baseline). Each glyph at `emSize`,
 * pen advanced by its design advance; curves flattened at 0.001 em; points closer than
 * emSize × 0.005 to the previous kept point are dropped.
 */
export function textOutline(fonts: Font | Font[], text: string, emSize: number): Pt[][] {
  const list = Array.isArray(fonts) ? fonts : [fonts];
  const minGap = emSize * 0.005;
  // 3D Builder flattens at 0.0005 for an em size of scale × 0.5 (scale ≈ 1):
  // the same relative tolerance here.
  const flat = emSize * 0.001;
  const out: Pt[][] = [];
  let pen = 0;
  // Font fallback: the first font of the list that has the character (else the first's .notdef).
  const pick = (cp: number): [Font, number] => {
    for (const f of list) {
      const g = f.glyphIndex(cp);
      if (g) return [f, g];
    }
    return [list[0], 0];
  };
  const glyphs: [Font, number][] = [];
  for (const ch of visualOrder(shapeArabic(Array.from(text)))) {
    const cp = ch.codePointAt(0)!;
    const hit = pick(cp);
    const nominal = NOMINAL.get(cp);
    // A presentation form no font has: the nominal letters (visual order: reversed).
    if (!hit[1] && nominal) for (const c of Array.from(nominal).reverse()) glyphs.push(pick(c.codePointAt(0)!));
    else glyphs.push(hit);
  }
  for (const [font, g] of glyphs) {
    const s = emSize / font.unitsPerEm;
    for (const c of font.contours(g)) {
      if (c.length < 2) continue;
      // Start on an on-curve point (or the midpoint of two off-curve ones).
      let k0 = c.findIndex((p) => p.on);
      const pts = c.map((p) => ({ x: p.x * s + pen, y: p.y * s, on: p.on }));
      let startPt: Pt;
      if (k0 < 0) {
        startPt = [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2];
        k0 = 1;
      } else startPt = [pts[k0].x, pts[k0].y];
      const raw: Pt[] = [startPt];
      let cur = startPt;
      let ctrl: Pt | null = null;
      const n = pts.length;
      const first = pts[k0].on ? 1 : 0;
      for (let i = first; i <= n; i++) {
        const p = pts[(k0 + i) % n];
        const P: Pt = i === n ? startPt : [p.x, p.y];
        const on = i === n ? true : p.on;
        if (on) {
          if (ctrl) flattenQuad(raw, cur, ctrl, P, flat);
          else raw.push(P);
          cur = P;
          ctrl = null;
        } else if (ctrl) {
          const mid: Pt = [(ctrl[0] + P[0]) / 2, (ctrl[1] + P[1]) / 2];
          flattenQuad(raw, cur, ctrl, mid, flat);
          cur = mid;
          ctrl = P;
        } else ctrl = P;
      }
      const poly: Pt[] = [];
      for (const p of raw) {
        const last = poly[poly.length - 1];
        if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minGap) poly.push(p);
      }
      while (poly.length > 2 && Math.hypot(poly[0][0] - poly[poly.length - 1][0], poly[0][1] - poly[poly.length - 1][1]) < minGap) poly.pop();
      if (poly.length >= 3) out.push(poly);
    }
    pen += font.advance(g) * s;
  }
  return out;
}

// --- system fonts --------------------------------------------------------------------------------

interface LocalFont { family: string; fullName: string; style: string; postscriptName: string; blob(): Promise<Blob> }
const cache = new Map<string, Promise<Font | null>>();
const loaded = new Map<string, Font>();

/** A font file opened by the user, offered under `name` (used before the system fonts). */
export function registerFontFile(name: string, buf: ArrayBuffer): Font {
  const font = parseFont(buf);
  loaded.set(name.toLowerCase(), font);
  return font;
}

/**
 * Windows fonts tried for characters missing from the chosen font, by script, in the spirit of
 * System font fallback, as Windows does it for 3D Builder (the exact Windows table is not known).
 */
export function fallbackFamilies(cp: number): string[] {
  const r = (a: number, b: number) => cp >= a && cp <= b;
  if (r(0x1100, 0x11ff) || r(0x3130, 0x318f) || r(0xac00, 0xd7af)) return ['Malgun Gothic'];
  if (r(0x3040, 0x30ff) || r(0x31f0, 0x31ff)) return ['Yu Gothic', 'Meiryo', 'MS Gothic'];
  if (r(0x2e80, 0x2fdf) || r(0x3000, 0x303f) || r(0x3400, 0x4dbf) || r(0x4e00, 0x9fff) || r(0xf900, 0xfaff) || r(0xff00, 0xffef) || r(0x20000, 0x3134f))
    return ['Microsoft YaHei', 'Yu Gothic', 'Microsoft JhengHei', 'SimSun', 'Malgun Gothic'];
  if (r(0x0e00, 0x0eff)) return ['Leelawadee UI'];
  if (r(0x0900, 0x0dff)) return ['Nirmala UI'];
  if (r(0x0f00, 0x0fff)) return ['Microsoft Himalaya'];
  if (r(0x1000, 0x109f)) return ['Myanmar Text'];
  if (r(0x1200, 0x139f) || r(0x2d80, 0x2ddf)) return ['Ebrima'];
  if (r(0x13a0, 0x13ff) || r(0x1400, 0x167f)) return ['Gadugi'];
  if (r(0x1800, 0x18af)) return ['Mongolian Baiti'];
  if (r(0x1f000, 0x1faff) || r(0x2600, 0x27bf) || r(0xfe00, 0xfe0f)) return ['Segoe UI Emoji', 'Segoe UI Symbol'];
  if (r(0x2000, 0x2bff) || r(0x1d400, 0x1d7ff)) return ['Segoe UI Symbol', 'Cambria Math', 'Segoe UI'];
  return ['Segoe UI', 'Segoe UI Symbol', 'Arial', 'Times New Roman', 'Segoe UI Historic'];
}

/**
 * The fonts needed to draw `text`: the chosen family first, then fonts opened by the user and
 * Windows fallback fonts, each added only if it has characters the previous ones lack.
 * Null when the chosen font itself cannot be read.
 */
export async function loadTextFonts(family: string, bold: boolean, text: string): Promise<Font[] | null> {
  const primary = await loadSystemFont(family, bold);
  if (!primary) return null;
  const fonts = [primary];
  const has = (cp: number) => fonts.some((f) => f.glyphIndex(cp) !== 0);
  const shaped = shapeArabic(Array.from(text));
  const missing = () => [...new Set(shaped.map((c) => c.codePointAt(0)!))].filter((cp) => cp > 0x20 && !has(cp));
  let todo = missing();
  if (!todo.length) return fonts;
  for (const f of loaded.values()) {
    if (!fonts.includes(f) && todo.some((cp) => f.glyphIndex(cp))) fonts.push(f);
  }
  todo = missing();
  const tried = new Set<string>([family.toLowerCase()]);
  for (const cp of todo) {
    if (has(cp)) continue;
    for (const fam of fallbackFamilies(cp)) {
      if (tried.has(fam.toLowerCase())) continue;
      tried.add(fam.toLowerCase());
      const f = await loadSystemFont(fam, bold);
      if (f && todo.some((c) => !has(c) && f.glyphIndex(c))) fonts.push(f);
      if (has(cp)) break;
    }
  }
  return fonts;
}

let fontList: Promise<LocalFont[]> | null = null;
/** Installed fonts (asked once; a refusal or an empty answer is asked again next time). */
function localFonts(): Promise<LocalFont[]> {
  fontList ??= (globalThis as unknown as { queryLocalFonts(): Promise<LocalFont[]> }).queryLocalFonts();
  const p = fontList;
  p.then((l) => { if (!l.length) fontList = null; }, () => { fontList = null; });
  return p;
}

/** Whether the browser can hand over system font files (Local Font Access API). */
export const canReadSystemFonts = () => typeof (globalThis as { queryLocalFonts?: unknown }).queryLocalFonts === 'function';

/** Families of the installed fonts, or null when the browser does not give access. */
export async function systemFontFamilies(): Promise<string[] | null> {
  if (!canReadSystemFonts()) return null;
  try {
    const fonts = await localFonts();
    return [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  } catch {
    return null;
  }
}

/**
 * The installed face of `family`, bold as 3D Builder asks (weight 700, normal stretch and style),
 * else the regular one. Null when the browser does not give access or the font is not TrueType.
 */
export function loadSystemFont(family: string, bold = true): Promise<Font | null> {
  const opened = loaded.get(family.toLowerCase());
  if (opened) return Promise.resolve(opened);
  const key = `${family}|${bold}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      if (!canReadSystemFonts()) return null;
      try {
        const fonts = await localFonts();
        const faces = fonts.filter((f) => f.family.toLowerCase() === family.toLowerCase());
        const pick = (bold && faces.find((f) => f.style === 'Bold')) || faces.find((f) => f.style === 'Regular') || faces[0];
        if (!pick) return null;
        return parseFont(await (await pick.blob()).arrayBuffer(), pick.fullName);
      } catch {
        return null;
      }
    })();
    cache.set(key, p);
    // A refused permission is not cached for good: the next try may come with a user gesture.
    p.then((f) => { if (!f) cache.delete(key); });
  }
  return p;
}
