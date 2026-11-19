import { beforeAll, describe, expect, it } from 'vitest';
import { emboss, traceContours, type Polygon } from '../src/geometry/emboss';
import { makePrimitive } from '../src/geometry/primitives';
import { analyze } from '../src/repair/analyze';
import { bounds, signedVolume } from '../src/core/mesh-data';
import { loadManifold } from '../src/geometry/csg';

// straight-skeleton's Wasm build only runs "on the web": load it once with a stand-in `window`
// (after manifold-3d, which must keep its Node loader).
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

const square = (s: number): Polygon[] => [[[-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2]]];
const ring = (r: number, w: number): Polygon[] => {
  const circle = (rad: number, n = 48) => Array.from({ length: n }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * rad, Math.sin((i / n) * Math.PI * 2) * rad] as [number, number]);
  return [circle(r), circle(r - w).reverse()];
};

describe('contour tracing (Moore, as 3D Builder)', () => {
  const img = (n: number, ink: (x: number, y: number) => boolean) => {
    const data = new Uint8ClampedArray(n * n * 4);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data.set(ink(x, y) ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * n + x) * 4);
    return { width: n, height: n, data, colorSpace: 'srgb' } as ImageData;
  };
  const area = (p: Polygon) => p.reduce((s, q, i) => { const r = p[(i + 1) % p.length]; return s + q[0] * r[1] - r[0] * q[1]; }, 0) / 2;

  it('traces a square through its edge pixel centres, outer contour positive', () => {
    const polys = traceContours(img(20, (x, y) => x >= 5 && x <= 14 && y >= 5 && y <= 14), { invert: true });
    expect(polys).toHaveLength(1);
    // 4 corners, plus the start pixel: like 3D Builder, RDP runs on the loop opened between the
    // start pixel and the next one, so both ends stay.
    expect(polys[0]).toHaveLength(5);
    expect(area(polys[0])).toBeCloseTo(81, 6);
  });

  it('finds the hole of a ring one pixel thin (3D Builder loses it)', () => {
    const ring = traceContours(img(20, (x, y) => (x === 5 || x === 14 || y === 5 || y === 14) && x >= 5 && x <= 14 && y >= 5 && y <= 14), { invert: true });
    expect(ring).toHaveLength(2);
    expect(ring.map(area).some((a) => a < 0)).toBe(true);
  });

  it('finds a hole and orients it negative', () => {
    const polys = traceContours(img(30, (x, y) => x >= 5 && x <= 24 && y >= 5 && y <= 24 && !(x >= 10 && x <= 19 && y >= 10 && y <= 19)), { invert: true });
    expect(polys).toHaveLength(2);
    const areas = polys.map(area).sort((a, b) => a - b);
    expect(areas[0]).toBeLessThan(0);
    expect(areas[1]).toBeGreaterThan(0);
  });
});

describe('emboss', () => {
  it('adds a raised square on the front of a cube', async () => {
    const { mesh: m } = await emboss(makePrimitive('cube'), { outline: square(10), direction: '-y', offsetU: 0, offsetV: 0, rotation: 0, depth: 2 });
    expect(analyze(m).ok).toBe(true);
    expect(signedVolume(m)).toBeCloseTo(64000 + 10 * 10 * 2, 0);
    expect(bounds(m).min[1]).toBeCloseTo(-22, 3);
  });

  it('engraves a ring (outline with a hole) on top of a cube', async () => {
    const { mesh: m } = await emboss(makePrimitive('cube'), { outline: ring(12, 3), direction: '+z', offsetU: 0, offsetV: 0, rotation: 0, depth: -1 });
    expect(analyze(m).ok).toBe(true);
    const area = Math.PI * (12 ** 2 - 9 ** 2);
    expect(64000 - signedVolume(m)).toBeCloseTo(area * 1, -1);
  });

  it('wraps a motif around a cylinder (cylindrical projection)', async () => {
    const cyl = makePrimitive('cylinder');
    const { mesh: m } = await emboss(cyl, { outline: square(10), projection: 'cylindrical', direction: '-y', offsetU: 0, offsetV: 0, rotation: 0, depth: -1 });
    expect(analyze(m).ok).toBe(true);
    // Removed volume ≈ motif area × depth (slightly less: the groove narrows inwards).
    const removed = signedVolume(cyl) - signedVolume(m);
    expect(removed).toBeGreaterThan(10 * 10 * 1 * 0.85);
    expect(removed).toBeLessThan(10 * 10 * 1 * 1.05);
  });

  it('raises a motif on a sphere (spherical projection)', async () => {
    const sphere = makePrimitive('sphere');
    const { mesh: m } = await emboss(sphere, { outline: square(8), projection: 'spherical', direction: '+x', offsetU: 0, offsetV: 0, rotation: 0, depth: 1 });
    expect(analyze(m).ok).toBe(true);
    expect(bounds(m).max[0]).toBeCloseTo(21, 0);
    expect(signedVolume(m)).toBeGreaterThan(signedVolume(sphere) + 8 * 8 * 0.9);
  });

  it('cuts the motif into the surface without booleans: only the front face changes', async () => {
    const cube = makePrimitive('cube');
    const { mesh: m, faceColors } = await emboss(cube, { outline: square(10), direction: '-y', offsetU: 0, offsetV: 0, rotation: 0, depth: 2, topColor: 0xff0000, sideColor: 0x00ff00 });
    expect(analyze(m).ok).toBe(true);
    // Raised top: 2 triangles (the square cut into the front face), 4 walls of 2 triangles.
    const tops = [...faceColors!].filter((c) => c === 0xff0000).length;
    const sides = [...faceColors!].filter((c) => c === 0x00ff00).length;
    expect(tops).toBeGreaterThanOrEqual(2);
    expect(sides).toBe(8);
  });

  it('bevels the motif with a 45° roof and a plateau (Biseau)', async () => {
    const { mesh: m } = await emboss(makePrimitive('cube'), { outline: square(10), direction: '-y', offsetU: 0, offsetV: 0, rotation: 0, depth: 2, bevel: true });
    expect(analyze(m).ok).toBe(true);
    expect(bounds(m).min[1]).toBeCloseTo(-22, 3);
    // Frustum: plateau 6×6 at 2 mm on a 10×10 base: V = h/3 (A + a + √(Aa)).
    const frustum = (2 / 3) * (100 + 36 + 60);
    expect(signedVolume(m) - 64000).toBeCloseTo(frustum, 0);
  });

  it('bevels up to a pyramid when the depth exceeds the inscribed radius', async () => {
    const { mesh: m } = await emboss(makePrimitive('cube'), { outline: square(10), direction: '+z', offsetU: 0, offsetV: 0, rotation: 0, depth: 9, bevel: true });
    expect(analyze(m).ok).toBe(true);
    expect(bounds(m).max[2]).toBeCloseTo(25, 2);
    expect(signedVolume(m) - 64000).toBeCloseTo((100 * 5) / 3, 0);
  });

  it('takes the bevel height as a percentage of the roof\'s top, as 3D Builder (Z = 50 by default)', async () => {
    // Square 10: roof top 5 mm. 100 % → full pyramid; 50 % → plateau at 2.5 mm (side 5).
    const full = (await emboss(makePrimitive('cube'), { outline: square(10), direction: '+z', offsetU: 0, offsetV: 0, rotation: 0, depth: 1, bevel: true, bevelHeight: 1 })).mesh;
    expect(bounds(full).max[2]).toBeCloseTo(25, 2);
    const half = (await emboss(makePrimitive('cube'), { outline: square(10), direction: '+z', offsetU: 0, offsetV: 0, rotation: 0, depth: 1, bevel: true, bevelHeight: 0.5 })).mesh;
    expect(analyze(half).ok).toBe(true);
    expect(bounds(half).max[2]).toBeCloseTo(22.5, 2);
    expect(signedVolume(half) - 64000).toBeCloseTo((2.5 / 3) * (100 + 25 + 50), 0);
  });

  it('follows a curved surface (sphere) when engraving', async () => {
    const sphere = makePrimitive('sphere');
    const { mesh: m } = await emboss(sphere, { outline: square(12), direction: '-y', offsetU: 0, offsetV: 4, rotation: 30, depth: -1.5 });
    const r = analyze(m);
    expect(r.ok).toBe(true);
    expect(signedVolume(m)).toBeLessThan(signedVolume(sphere));
    expect(signedVolume(m)).toBeGreaterThan(signedVolume(sphere) - 12 * 12 * 1.6);
  });
});
