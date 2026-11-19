import { describe, expect, it } from 'vitest';
import { contourLevels, insertImage, medianCut, smoothingRadius } from '../src/geometry/image-insert';
import { paintRegion } from '../src/geometry/paint';
import { WALLPAPER_DEFAULTS, wallpaper } from '../src/geometry/texture';
import { makePrimitive } from '../src/geometry/primitives';
import { analyze } from '../src/repair/analyze';
import { bounds } from '../src/core/mesh-data';

/** Minimal ImageData stand-in. */
function image(n: number, color: (x: number, y: number) => [number, number, number, number]): ImageData {
  const data = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data.set(color(x, y), (y * n + x) * 4);
  return { width: n, height: n, data, colorSpace: 'srgb' } as ImageData;
}
/** White disc (radius n/3) on black, as 3D Builder reads ink: bright = inside. */
const disc = (n: number) => image(n, (x, y) => (Math.hypot(x - n / 2, y - n / 2) < n / 3 ? [255, 255, 255, 255] : [0, 0, 0, 255]));

describe('insert image (3D Builder modes)', () => {
  it('height map: closed relief from 8 % to 24 % of the width, painted with the reduced colours', async () => {
    const n = 40;
    const { mesh, faceColors } = await insertImage(disc(n), { mode: 'height', p1: 16, p2: 0, invert: false, reducedColors: true, width: 50 });
    expect(analyze(mesh).ok).toBe(true);
    const b = bounds(mesh);
    expect(b.min[2]).toBe(0);
    expect(b.max[0]).toBeCloseTo(50, 3);
    const k = n / (n - 1); // 3D Builder's heights follow the pixel count, the size the pixel spacing
    expect(b.max[2]).toBeCloseTo(0.24 * 50 * k, 3);
    expect(faceColors!.length).toBe(mesh.indices.length / 3);
    expect(new Set(faceColors).has(0xffffff)).toBe(true);
  });

  it('median cut reduces to the requested number of colours', () => {
    const img = image(30, (x, y) => [x * 8, y * 8, (x + y) * 4, 255]);
    const out = medianCut(img, 5);
    const colours = new Set<number>();
    for (let p = 0; p < 900; p++) colours.add((out[p * 4] << 16) | (out[p * 4 + 1] << 8) | out[p * 4 + 2]);
    expect(colours.size).toBeLessThanOrEqual(5);
    expect(colours.size).toBeGreaterThan(1);
  });

  it('contour: extruded to 10 % of the image\'s long side, auto threshold on a non-empty level', async () => {
    const img = disc(64);
    const { levels, initial } = contourLevels(img);
    expect(levels.length).toBeGreaterThan(0);
    const { mesh } = await insertImage(img, { mode: 'contour', p1: levels[initial], p2: 0, invert: false, reducedColors: false, width: 30 });
    const r = analyze(mesh);
    expect(r.ok).toBe(true);
    expect(bounds(mesh).max[2]).toBeCloseTo(3, 3); // 10 % of the 30 mm long side
    // Disc of radius 1/3 of the image (half a pixel inside: pixel-centre tracing).
    const rad = ((64 / 3 - 0.5) / 64) * 30;
    expect(Math.abs(r.volume / (Math.PI * rad * rad * 3) - 1)).toBeLessThan(0.03);
  });

  it('stamp: two-level relief from ordered dithering', async () => {
    const img = image(24, (x) => [x * 10, x * 10, x * 10, 255]);
    const { mesh } = await insertImage(img, { mode: 'stamp', p1: 2, p2: 2, invert: false, reducedColors: false, width: 24 });
    expect(analyze(mesh).ok).toBe(true);
    const z = new Set<number>();
    for (let i = 2; i < mesh.positions.length; i += 3) if (mesh.positions[i] > 0) z.add(Math.round(mesh.positions[i] * 1000));
    expect(z.size).toBe(2);
  });

  it('scales the smoothing radius over 128 px, square images included (3D Builder forgets them)', () => {
    expect(smoothingRadius(100, 80, 2)).toBe(2);
    expect(smoothingRadius(512, 256, 2)).toBe(4);
    expect(smoothingRadius(512, 512, 2)).toBe(8);
  });
});

describe('paint region (3D Builder: coverage % → T = % × π, local ≤ T/2, from seed ≤ T)', () => {
  it('stays on a cube face below 100 % (90° edges need T/2 ≥ 1570 mrad) and takes the whole cube at 100 %', () => {
    const c = makePrimitive('cube');
    const face = paintRegion(c, 0, 0);
    expect(face.length).toBeGreaterThanOrEqual(2);
    expect(face.length).toBeLessThan(c.indices.length / 3);
    expect(paintRegion(c, 0, 99).length).toBe(face.length);
    expect(paintRegion(c, 0, 100).length).toBe(c.indices.length / 3);
  });

  it('grows over a smooth sphere with the coverage', () => {
    const s = makePrimitive('sphere');
    const a = paintRegion(s, 0, 10).length, b = paintRegion(s, 0, 40).length;
    expect(b).toBeGreaterThan(a);
  });

  it('wallpaper keeps the image proportions over the region', () => {
    const c = makePrimitive('cube');
    const region = paintRegion(c, 0, 0);
    // 2 × 1 image: left half red, right half blue.
    const tex = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) };
    const colors = new Uint32Array(c.indices.length / 3);
    const P = c.positions, I = c.indices;
    const e1 = [0, 1, 2].map((k) => P[I[1] * 3 + k] - P[I[0] * 3 + k]), e2 = [0, 1, 2].map((k) => P[I[2] * 3 + k] - P[I[0] * 3 + k]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    wallpaper(c, region, n, tex, WALLPAPER_DEFAULTS, colors);
    // Both halves of the image show up on the face.
    expect(new Set(region.map((f) => colors[f])).size).toBe(2);
    expect(region.every((f) => colors[f] === 0xff0000 || colors[f] === 0x0000ff)).toBe(true);
  });
});
