import { describe, expect, it } from 'vitest';
import { imageTexture } from '../src/geometry/image-insert';

describe('image insertion texture (3D Builder "Textures")', () => {
  it('maps the image from above as 3D Builder does (values read from a file it saved)', () => {
    // 40 × 30 px image, contour, 0.254 mm per pixel; corners taken from 3D Builder's file.
    const px = { width: 40, height: 30, data: new Uint8ClampedArray(40 * 30 * 4) } as unknown as ImageData;
    const mesh = { positions: new Float32Array([4.572, 5.842, 1.016, 0.254, 7.366, 1.016, 2.286, 5.588, 0]), indices: new Uint32Array([0, 1, 2]) };
    const t = imageTexture(mesh, px, { mode: 'contour', width: 40 * 0.254 });
    const uv = Array.from(t.uv);
    [0.45, -0.2, 0.025, 0, 0.225, -0.233333].forEach((v, i) => expect(uv[i]).toBeCloseTo(v, 4));
    expect(t.images[0].wrap).toBe('repeat');
    expect(Array.from(t.face)).toEqual([0]);
  });
});
