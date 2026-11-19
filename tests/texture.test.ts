import { existsSync, readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { decodePNG, encodePNG } from '../src/io/png';
import { read3MF, write3MF } from '../src/io/threemf';
import { makePrimitive } from '../src/geometry/primitives';
import { type ObjectTexture, type TextureImage, emptyTexture, mergeTextures, transferTexture } from '../src/core/texture-data';
import { nearestFaces } from '../src/repair/colors';
import { repairSolid } from '../src/repair/solid';
import { paintRegion } from '../src/geometry/paint';
import { WALLPAPER_DEFAULTS, stickerUV, wallpaperUV } from '../src/geometry/texture';
import { CATALOG, REFERENCE } from './reference-paths';

(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

const img = (w: number, h: number, wrap: 'repeat' | 'clamp' = 'repeat'): TextureImage => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([(i * 37) % 256, (i * 91) % 256, (i * 13) % 256, 255], i * 4);
  return { width: w, height: h, data, wrap };
};

describe('PNG codec (3MF textures)', () => {
  it('round-trips RGBA pixels', () => {
    const a = img(7, 5);
    const b = decodePNG(encodePNG(a.width, a.height, a.data))!;
    expect(b.width).toBe(7);
    expect(Array.from(b.data)).toEqual(Array.from(a.data));
  });

  const cat = `${CATALOG}/shape_cube.3mf`;
  it.skipIf(!existsSync(cat))('reads a PNG written by 3D Builder (catalog thumbnail)', () => {
    const z = unzipSync(new Uint8Array(readFileSync(cat)));
    const px = decodePNG(z['Metadata/thumbnail.png']);
    expect(px).not.toBeNull();
    expect(px!.width).toBeGreaterThan(16);
  });
});

// A 3MF textured in 3D Builder itself (wallpaper), kept outside the repository.
const sample3DB = `${REFERENCE}cube-texture-3db.3mf`;
describe.skipIf(!existsSync(sample3DB))('a 3MF textured by 3D Builder', () => {
  it('reads its JPEG texture, texture coordinates and coloured faces', () => {
    const [o] = read3MF(new Uint8Array(readFileSync(sample3DB)));
    expect(o.mesh.indices.length / 3).toBe(12);
    const t = o.texture!;
    expect(t.images).toHaveLength(1);
    expect(t.images[0].source?.type).toBe('image/jpeg'); // decoded by the browser on import
    expect(t.images[0].wrap).toBe('repeat');
    const textured = Array.from(t.face).filter((i) => i >= 0).length;
    expect(textured).toBe(4);
    expect(Array.from(t.uv.slice(0, 6))).toEqual([0, 0, 1, 0, 0, 1]);
  });
});

describe('textures on objects', () => {
  it('3MF round trip: texture2d + texture2dgroup, coordinates and tiling kept', () => {
    const c = makePrimitive('cube');
    const tex: ObjectTexture = emptyTexture(c.indices.length / 3);
    const a = img(8, 8), b = img(4, 6, 'clamp');
    tex.images.push(a, b);
    tex.face[0] = 0; tex.face[1] = 0; tex.face[2] = 1;
    tex.uv.set([0, 0, 2, 0, 2, 3, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.25, 0.25, 0.75, 0.25, 0.75, 0.75], 0);
    const back = read3MF(write3MF([{ name: 'cube', mesh: c, color: '#3cb55a', texture: tex }]))[0];
    expect(back.texture).toBeDefined();
    expect(back.texture!.images).toHaveLength(2);
    expect(Array.from(back.texture!.face.slice(0, 4))).toEqual([0, 0, 1, -1]);
    expect(back.texture!.uv[4]).toBeCloseTo(2, 5);
    expect(back.texture!.uv[5]).toBeCloseTo(3, 5);
    expect(back.texture!.images[1].wrap).toBe('clamp');
    expect(Array.from(back.texture!.images[0].data)).toEqual(Array.from(a.data));
  });

  it('keeps a JPEG texture encoded (decoded by the browser on import) and writes it back as JPEG', () => {
    const c = makePrimitive('cube');
    const tex: ObjectTexture = emptyTexture(c.indices.length / 3);
    tex.images.push(img(4, 4));
    tex.face[0] = 0;
    // Swap the PNG of a written 3MF for JPEG bytes (only the signature matters here).
    const files = unzipSync(write3MF([{ name: 'cube', mesh: c, color: '#3cb55a', texture: tex }]));
    const pngPath = Object.keys(files).find((k) => k.endsWith('.png') && k.startsWith('3D/'))!;
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
    const model = strFromU8(files['3D/3dmodel.model']).replace(pngPath.slice(3), pngPath.slice(3).replace('.png', '.jpg')).replace('image/png', 'image/jpeg');
    files['3D/3dmodel.model'] = strToU8(model);
    files[pngPath.replace('.png', '.jpg')] = jpeg;
    delete files[pngPath];
    const back = read3MF(zipSync(files))[0];
    const im = back.texture!.images[0];
    expect(im.source?.type).toBe('image/jpeg');
    expect(back.texture!.face[0]).toBe(0);
    const again = unzipSync(write3MF([back]));
    const jpg = Object.keys(again).find((k) => k.endsWith('.jpg'))!;
    expect(Array.from(again[jpg])).toEqual(Array.from(jpeg));
  });

  it('wallpaper: texture coordinates on the region, image proportions kept, repeat honoured', () => {
    const c = makePrimitive('cube');
    const region = paintRegion(c, 0, 0);
    const P = c.positions, I = c.indices;
    const e1 = [0, 1, 2].map((k) => P[I[1] * 3 + k] - P[I[0] * 3 + k]), e2 = [0, 1, 2].map((k) => P[I[2] * 3 + k] - P[I[0] * 3 + k]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const uv = wallpaperUV(c, region, n, 1, WALLPAPER_DEFAULTS);
    const us = Array.from(uv).filter((_, i) => i % 2 === 0), vs = Array.from(uv).filter((_, i) => i % 2 === 1);
    // A square face with a square image: exactly one copy, from 0 to 1 both ways.
    expect(Math.min(...us)).toBeCloseTo(0, 5); expect(Math.max(...us)).toBeCloseTo(1, 5);
    expect(Math.min(...vs)).toBeCloseTo(0, 5); expect(Math.max(...vs)).toBeCloseTo(1, 5);
    const uv2 = wallpaperUV(c, region, n, 1, { ...WALLPAPER_DEFAULTS, repeatX: 3 });
    expect(Math.max(...Array.from(uv2).filter((_, i) => i % 2 === 0))).toBeCloseTo(3, 5);
  });

  it('sticker: only the faces facing the projector and covered by the image', () => {
    const c = makePrimitive('cube');
    const r = stickerUV(c, [0, -1, 0], [1, 0, 0], [0, 0, 1], [0, -20, 0], 20, 1);
    expect(r.faces.length).toBeGreaterThan(0);
    expect(r.faces.length).toBeLessThan(c.indices.length / 3);
  });

  it('follows the faces through a repair and through merging', async () => {
    const c = makePrimitive('cube');
    const tex = emptyTexture(c.indices.length / 3);
    tex.images.push(img(4, 4));
    for (let f = 0; f < tex.face.length; f++) { tex.face[f] = 0; tex.uv.set([0, 0, 1, 0, 1, 1], f * 6); }
    const idx = c.indices.slice();
    [idx[1], idx[2]] = [idx[2], idx[1]]; // a flipped face for the repair to fix
    const broken = { positions: c.positions, indices: idx };
    const { mesh } = await repairSolid(broken);
    const moved = transferTexture(broken, tex, mesh, nearestFaces(broken, mesh))!;
    expect(moved.face.every((i) => i === 0)).toBe(true);
    const m = mergeTextures([{ faces: 12, texture: tex }, { faces: 5 }])!;
    expect(m.face.length).toBe(17);
    expect(m.face[16]).toBe(-1);
  });
});
