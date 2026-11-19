import { describe, expect, it } from 'vitest';
import { planeCut } from '../src/geometry/plane-cut';
import { triangulateMonotone } from '../src/geometry/monotone';
import { makePrimitive } from '../src/geometry/primitives';
import { analyze } from '../src/repair/analyze';
import { signedVolume } from '../src/core/mesh-data';

const total = (ps: { mesh: Parameters<typeof signedVolume>[0] }[]) => ps.reduce((s, p) => s + signedVolume(p.mesh), 0);

describe('monotone cap triangulation (no new vertices)', () => {
  it('triangulates a comb with a hole', () => {
    // Comb: teeth going up, plus a square hole in its base.
    const pts: [number, number][] = [[0, 0], [10, 0], [10, 6], [9, 6], [9, 2], [7, 2], [7, 6], [6, 6], [6, 2], [4, 2], [4, 6], [3, 6], [3, 2], [1, 2], [1, 6], [0, 6],
      [4, 0.5], [6, 0.5], [6, 1.5], [4, 1.5]];
    const outer = Array.from({ length: 16 }, (_, i) => i), hole = [16, 17, 18, 19];
    const t = triangulateMonotone(pts, [outer, hole])!;
    expect(t).not.toBeNull();
    expect(t.length).toBe(20 - 2 + 2);
    const area = t.reduce((s, [a, b, c]) => s + ((pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0])) / 2, 0);
    expect(area).toBeCloseTo(10 * 2 + 4 * 4 - 2, 6);
  });
});

describe('split (3D Builder plane cut, no boolean)', () => {
  it('cuts a cube into two closed halves', () => {
    const { above, below } = planeCut(makePrimitive('cube'), [0, 0, 1], [0, 0, 5]);
    expect(above).toHaveLength(1);
    expect(below).toHaveLength(1);
    for (const p of [...above, ...below]) expect(analyze(p.mesh).ok).toBe(true);
    expect(total(above)).toBeCloseTo(40 * 40 * 15, 1);
    expect(total(below)).toBeCloseTo(40 * 40 * 25, 1);
  });

  it('cuts a sphere through its vertices and at an angle', () => {
    const s = makePrimitive('sphere');
    const v0 = signedVolume(s);
    for (const [n, p] of [[[0, 0, 1], [0, 0, 0]], [[1, 2, 3], [3, -2, 1]]] as const) {
      const { above, below } = planeCut(s, [...n], [...p]);
      for (const piece of [...above, ...below]) expect(analyze(piece.mesh).ok).toBe(true);
      expect(total(above) + total(below)).toBeCloseTo(v0, 0);
    }
  });

  it('caps a torus cut flat (cap with a hole) or through its axis (two caps per half)', () => {
    const t = makePrimitive('torus');
    const v0 = signedVolume(t);
    const flat = planeCut(t, [0, 0, 1], [0, 0, 0.3]);
    expect(flat.above).toHaveLength(1);
    expect(analyze(flat.above[0].mesh).ok).toBe(true);
    expect(total(flat.above) + total(flat.below)).toBeCloseTo(v0, 0);
    const vertical = planeCut(t, [1, 0, 0], [0, 0, 0]);
    expect(vertical.above).toHaveLength(1);
    expect(vertical.below).toHaveLength(1);
    for (const p of [...vertical.above, ...vertical.below]) expect(analyze(p.mesh).ok).toBe(true);
  });

  it('separates each half into its connected pieces', () => {
    // Two cubes side by side in one mesh, cut across both: two pieces on each side.
    const a = makePrimitive('cube');
    const pos = new Float32Array(a.positions.length * 2);
    pos.set(a.positions);
    for (let i = 0; i < a.positions.length; i += 3) { pos[a.positions.length + i] = a.positions[i] + 100; pos[a.positions.length + i + 1] = a.positions[i + 1]; pos[a.positions.length + i + 2] = a.positions[i + 2]; }
    const idx = new Uint32Array(a.indices.length * 2);
    idx.set(a.indices);
    for (let i = 0; i < a.indices.length; i++) idx[a.indices.length + i] = a.indices[i] + a.positions.length / 3;
    const { above, below } = planeCut({ positions: pos, indices: idx }, [0, 0, 1], [0, 0, 0]);
    expect(above).toHaveLength(2);
    expect(below).toHaveLength(2);
  });

  it('keeps colours and gives the cap the colour of the faces around it', () => {
    const c = makePrimitive('cube');
    const colors = new Uint32Array(c.indices.length / 3).fill(0x336699);
    const { above } = planeCut(c, [0, 0, 1], [0, 0, 0], colors);
    expect(new Set(above[0].faceColors)).toEqual(new Set([0x336699]));
  });
});
