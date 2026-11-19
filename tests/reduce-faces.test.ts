import { describe, expect, it } from 'vitest';
import { reduceFaces, reductionTarget } from '../src/geometry/reduce-faces';
import { makePrimitive } from '../src/geometry/primitives';
import { analyze } from '../src/repair/analyze';
import { signedVolume } from '../src/core/mesh-data';

describe('Face reduction by edge collapse (Windows TryReduceFacesAsync)', () => {
  it('computes 3D Builder\'s target', () => {
    expect(reductionTarget(1000, 0.5)).toBe(500);
    expect(reductionTarget(1000, 0.999)).toBe(10); // at least 1 % of the faces
    expect(reductionTarget(10, 0.99)).toBe(4);
  });

  it('halves a sphere into a valid solid of nearly the same volume, colours kept per face', () => {
    const s = makePrimitive('sphere');
    const n = s.indices.length / 3;
    const colors = new Uint32Array(n).map((_, f) => (f < n / 2 ? 0xff0000 : 0x0000ff));
    const r = reduceFaces(s, reductionTarget(n, 0.5), colors);
    const a = analyze(r.mesh);
    expect(a.ok).toBe(true);
    expect(r.mesh.indices.length / 3).toBeLessThanOrEqual(n / 2 + 2);
    expect(Math.abs(a.volume / signedVolume(s) - 1)).toBeLessThan(0.03);
    expect(r.faceColors!.length).toBe(r.mesh.indices.length / 3);
    expect(new Set(r.faceColors)).toEqual(new Set([0xff0000, 0x0000ff]));
  });

  it('flattens coplanar faces of a cube without changing its shape', () => {
    // 3D Builder's cube has only 12 faces: split each at its centre to give the reducer
    // coplanar vertices to remove.
    const c0 = makePrimitive('cube');
    const pos = Array.from(c0.positions), idx: number[] = [];
    for (let f = 0; f < c0.indices.length / 3; f++) {
      const [a, b, d] = [c0.indices[f * 3], c0.indices[f * 3 + 1], c0.indices[f * 3 + 2]];
      const m = pos.length / 3;
      for (let k = 0; k < 3; k++) pos.push((pos[a * 3 + k] + pos[b * 3 + k] + pos[d * 3 + k]) / 3);
      idx.push(a, b, m, b, d, m, d, a, m);
    }
    const c = { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
    const n = c.indices.length / 3;
    const r = reduceFaces(c, reductionTarget(n, 0.25));
    expect(analyze(r.mesh).ok).toBe(true);
    expect(signedVolume(r.mesh)).toBeCloseTo(64000, 0);
  });
});
