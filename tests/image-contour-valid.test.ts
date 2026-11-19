import { describe, expect, it } from 'vitest';
import { insertImage } from '../src/geometry/image-insert';
import { analyze } from '../src/repair/analyze';
import { countSelfIntersections } from '../src/repair/wrap';

/** Noisy picture: pixels that touch only at a corner, long thin runs, holes (like a webcam photo). */
function noisy(w: number, h: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dark = (x + y) % 2 === 0 && x < w / 3 ? true : y % 7 === 0 && x > w / 3 ? true : rnd() < 0.3;
    const v = dark ? 20 : 235;
    data.set([v, v, v, 255], (y * w + x) * 4);
  }
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData;
}

describe('image Contour on a photo-like picture', () => {
  it('gives a valid object (no zero-area face, no crossing)', async () => {
    const px = noisy(120, 80);
    const r = await insertImage(px, { mode: 'contour', p1: 128, p2: 0, invert: false, reducedColors: true, width: 120 * 0.254 });
    const a = analyze(r.mesh);
    expect(a.degenerateFaces).toBe(0);
    expect(a.ok).toBe(true);
    expect(await countSelfIntersections(r.mesh)).toBe(0);
  });
});
