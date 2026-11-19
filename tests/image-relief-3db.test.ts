import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { unzlibSync } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { read3MF } from '../src/io/threemf';
import { IMAGE_DEFAULTS, insertImage } from '../src/geometry/image-insert';
import { bounds, signedVolume } from '../src/core/mesh-data';
import { analyze } from '../src/repair/analyze';
import { REFERENCE } from './reference-paths';
(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;
function png(buf: Uint8Array): ImageData {
  const dv = new DataView(buf.buffer, buf.byteOffset);
  let p = 8, w = 0, h = 0, ct = 0; const idat: Uint8Array[] = [];
  while (p < buf.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(...buf.slice(p + 4, p + 8));
    const d = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = new DataView(d.buffer).getUint32(0); h = new DataView(d.buffer).getUint32(4); ct = d[9]; if (d[8] !== 8) throw new Error('depth'); }
    if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const all = new Uint8Array(idat.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of idat) { all.set(x, o); o += x.length; }
  const raw = unzlibSync(all);
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : ct === 4 ? 2 : 1; const stride = w * bpp;
  const out = new Uint8Array(h * stride); 
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let pr = 0;
      if (f === 1) pr = a; else if (f === 2) pr = b; else if (f === 3) pr = (a + b) >> 1; else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = (v + pr) & 255;
    }
  }
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (bpp >= 3) { data[i * 4] = out[i * bpp]; data[i * 4 + 1] = out[i * bpp + 1]; data[i * 4 + 2] = out[i * bpp + 2]; data[i * 4 + 3] = bpp === 4 ? out[i * bpp + 3] : 255; }
    else { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = out[i * bpp]; data[i * 4 + 3] = bpp === 2 ? out[i * bpp + 1] : 255; }
  }
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData;
}
const dir = REFERENCE;
const have = existsSync(dir + 'image/test-img.png') && existsSync(dir + 'image-height-3db.3mf');

describe('image relief built in the order of 3D Builder (files saved by 3D Builder, outside the repo)', () => {
  it.skipIf(!have)('matches the face counts after the final simplifier step', async () => {
    const px = png(new Uint8Array(readFileSync(dir + 'image/test-img.png')));
    // Stamp (no smoothing) gives 3D Builder's exact faces; height and edge still differ by one level
    // on a few smoothed pixels, hence a few faces.
    const want = { height: [850, 2], edge: [1224, 6], stamp: [234, 0] } as const;
    for (const mode of ['height', 'edge', 'stamp'] as const) {
      const ref = read3MF(new Uint8Array(readFileSync(dir + 'image-' + mode + '-3db.3mf')))[0].mesh;
      expect(ref.indices.length / 3).toBe(want[mode][0]);
      const r = await insertImage(px, { mode, ...IMAGE_DEFAULTS[mode], invert: false, reducedColors: true, width: 39 * 0.254 });
      expect(analyze(r.mesh).ok).toBe(true);
      expect(Math.abs(r.mesh.indices.length / 3 - want[mode][0])).toBeLessThanOrEqual(want[mode][1]);
      expect(Math.abs(signedVolume(r.mesh) - signedVolume(ref)) / signedVolume(ref)).toBeLessThan(0.002);
      const hb = (m: typeof ref) => { const b = bounds(m); return b.max[2] - b.min[2]; };
      expect(hb(r.mesh)).toBeCloseTo(hb(ref), 2);
    }
  });
});
