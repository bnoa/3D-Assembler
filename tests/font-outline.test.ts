import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadTextFonts, parseFont, registerFontFile, textOutline, visualOrder } from '../src/geometry/font-outline';
import { emboss, motifOutline } from '../src/geometry/emboss';
import { shapeArabic } from '../src/geometry/arabic';
import { makePrimitive } from '../src/geometry/primitives';
import { analyze } from '../src/repair/analyze';
import { loadManifold } from '../src/geometry/csg';

// straight-skeleton's Wasm only runs "on the web": load it with a stand-in `window`.
beforeAll(async () => {
  await loadManifold();
  const g = globalThis as { window?: unknown; self?: unknown };
  g.self ??= globalThis;
  g.window = globalThis;
  try {
    const { SkeletonBuilder } = await import('straight-skeleton');
    await SkeletonBuilder.init();
  } finally {
    delete g.window;
  }
});

// Reads the fonts installed with Windows (not copied into the project); skipped elsewhere.
const FONTS = 'C:\\Windows\\Fonts\\';
const load = (file: string) => {
  const b = readFileSync(FONTS + file);
  return parseFont(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
};
const area = (p: [number, number][]) => p.reduce((s, q, i) => { const r = p[(i + 1) % p.length]; return s + q[0] * r[1] - r[0] * q[1]; }, 0) / 2;
const bbox = (ps: [number, number][][]) => {
  const xs = ps.flat().map((p) => p[0]), ys = ps.flat().map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

describe.skipIf(!existsSync(FONTS + 'calibrib.ttf'))('glyph outlines (as 3D Builder via DirectWrite)', () => {
  it('reads Calibri Bold: "O" is an outer contour and a hole of opposite orientation', () => {
    const f = load('calibrib.ttf');
    const o = textOutline(f, 'O', 10);
    expect(o).toHaveLength(2);
    const a = o.map(area).sort((x, y) => x - y);
    expect(a[0]).toBeLessThan(0);
    expect(a[1]).toBeGreaterThan(0);
    // Cap height of Calibri is about 0.64 em.
    const b = bbox(o);
    expect(b.y1 - b.y0).toBeGreaterThan(6);
    expect(b.y1 - b.y0).toBeLessThan(7.5);
  });

  it('advances the pen by the design advance width, without kerning', () => {
    const f = load('calibrib.ttf');
    const one = bbox(textOutline(f, 'I', 10));
    const two = bbox(textOutline(f, 'II', 10));
    const adv = (f.advance(f.glyphIndex('I'.codePointAt(0)!)) * 10) / f.unitsPerEm;
    expect(two.x1 - one.x1).toBeCloseTo(adv, 6);
  });

  it('embosses text from the glyph outlines (flat and bevel), with no bitmap involved', { timeout: 30000 }, async () => {
    const b = readFileSync(FONTS + 'calibrib.ttf');
    registerFontFile('Calibri test', b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const outline = await motifOutline({ kind: 'text', text: 'Rébus 3D', font: 'Calibri test' }, 8);
    expect(outline.length).toBeGreaterThan(8);
    for (const bevel of [false, true]) {
      const { mesh } = await emboss(makePrimitive('cube'), { outline, projection: 'planar', direction: '-y', offsetU: 0, offsetV: 0, rotation: 0, depth: 1, bevel });
      expect(analyze(mesh).ok).toBe(true);
    }
  });

  it('falls back to other fonts for missing characters (Korean, CJK, symbols, emoji)', async () => {
    const reg = (name: string, file: string) => {
      const b = readFileSync(FONTS + file);
      registerFontFile(name, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    };
    reg('Calibri fb', 'calibrib.ttf');
    if (existsSync(FONTS + 'malgunbd.ttf')) reg('Malgun Gothic', 'malgunbd.ttf');
    if (existsSync(FONTS + 'msyhbd.ttc')) reg('Microsoft YaHei', 'msyhbd.ttc');
    if (existsSync(FONTS + 'seguisym.ttf')) reg('Segoe UI Symbol', 'seguisym.ttf');
    if (existsSync(FONTS + 'seguiemj.ttf')) reg('Segoe UI Emoji', 'seguiemj.ttf');
    const text = 'A 한 中 ★ 😀';
    const fonts = (await loadTextFonts('Calibri fb', true, text))!;
    expect(fonts.length).toBeGreaterThan(1);
    // Every character but the spaces is found in one of the fonts.
    for (const ch of Array.from(text).filter((c) => c !== ' ')) expect(fonts.some((f) => f.glyphIndex(ch.codePointAt(0)!) !== 0)).toBe(true);
    // Each glyph is drawn from its own font: more outlines than with Calibri alone (.notdef boxes).
    expect(textOutline(fonts, '한中', 10).length).toBeGreaterThan(4);
    const outline = await motifOutline({ kind: 'text', text: 'Café 한글 ★', font: 'Calibri fb' }, 8);
    for (const bevel of [false, true]) {
      const { mesh } = await emboss(makePrimitive('cube'), { outline, projection: 'planar', direction: '-y', offsetU: 0, offsetV: 0, rotation: 0, depth: 1, bevel });
      expect(analyze(mesh).ok).toBe(true);
    }
  }, 30000);

  it('shapes Arabic: contextual forms and the lam-alef ligature', async () => {
    const hex = (s: string) => Array.from(s).map((c) => c.codePointAt(0)!.toString(16)).join(' ');
    expect(shapeArabic(Array.from('بيت')).map((c) => hex(c))).toEqual(['fe91', 'fef4', 'fe96']);
    expect(shapeArabic(Array.from('سلام')).map((c) => hex(c))).toEqual(['feb3', 'fefc', 'fee1']);
    expect(shapeArabic(Array.from('لا')).map((c) => hex(c))).toEqual(['fefb']);
    expect(shapeArabic(Array.from('abc'))).toEqual(['a', 'b', 'c']);
    // Embossed from Segoe UI Bold, shaped and laid out right to left.
    if (!existsSync(FONTS + 'segoeuib.ttf')) return;
    const b = readFileSync(FONTS + 'segoeuib.ttf');
    registerFontFile('Segoe UI ar', b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const outline = await motifOutline({ kind: 'text', text: 'سلام 3D', font: 'Segoe UI ar' }, 8);
    expect(outline.length).toBeGreaterThan(3);
    const { mesh } = await emboss(makePrimitive('cube'), { outline, projection: 'planar', direction: '-y', offsetU: 0, offsetV: 0, rotation: 0, depth: 1 });
    expect(analyze(mesh).ok).toBe(true);
  }, 30000);

  it('lays right-to-left runs out in reverse, as DirectWrite', () => {
    expect(visualOrder(Array.from('ab שלום cd')).join('')).toBe('ab םולש cd');
    expect(visualOrder(Array.from('abc')).join('')).toBe('abc');
  });

  it('reads composite glyphs (accented letters) and other system fonts', () => {
    const f = load('calibrib.ttf');
    expect(textOutline(f, 'é', 10).length).toBeGreaterThanOrEqual(3);
    if (existsSync(FONTS + 'arialbd.ttf')) expect(textOutline(load('arialbd.ttf'), '3D Assembler', 10).length).toBeGreaterThan(6);
    if (existsSync(FONTS + 'segoeuib.ttf')) expect(textOutline(load('segoeuib.ttf'), '3D Assembler', 10).length).toBeGreaterThan(6);
  });
});
