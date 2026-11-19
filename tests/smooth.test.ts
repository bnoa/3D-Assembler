import { describe, expect, it } from 'vitest';
import { hcSmooth, smoothTool, subdivide } from '../src/geometry/smooth';
import { makePrimitive, prism } from '../src/geometry/primitives';
import * as csg from '../src/geometry/csg';
import { analyze } from '../src/repair/analyze';
import { bounds, signedVolume, translated } from '../src/core/mesh-data';

describe('smooth (3D Builder behaviour)', () => {
  it('Loop subdivision multiplies faces by 4 and stays closed', () => {
    const c = makePrimitive('cube');
    const m = subdivide(c, true);
    expect(m.indices.length).toBe(c.indices.length * 4);
    expect(analyze(m).ok).toBe(true);
    expect(signedVolume(m)).toBeLessThan(64000); // corners pulled in
  });

  it('HC smoothing rounds a cube without collapsing it', () => {
    const m = smoothTool(makePrimitive('cube'), 3, false);
    const r = analyze(m);
    expect(r.ok).toBe(true);
    expect(r.volume).toBeLessThan(64000);
    // HC keeps most of the volume (a plain Laplacian would shrink the 12-face cube to a blob).
    expect(r.volume).toBeGreaterThan(64000 * 0.4);
  });

  it('HC smoothing leaves a sphere almost unchanged', () => {
    const s = makePrimitive('sphere');
    const m = hcSmooth(s, 10);
    expect(Math.abs(signedVolume(m) - signedVolume(s)) / signedVolume(s)).toBeLessThan(0.05);
  });
});

describe('extrude down with a height limit', () => {
  const box = (sx: number, sy: number, sz: number, x = 0, y = 0, z = 0) =>
    translated(prism([[-sx / 2, -sy / 2], [sx / 2, -sy / 2], [sx / 2, sy / 2], [-sx / 2, sy / 2]], sz), x, y, z + sz / 2);

  it('only extends what lies below the limit', async () => {
    // A post with a wide plate on top floating at 30..36 mm, plus a low ledge at 10..12 mm.
    const shape = await csg.union([box(8, 8, 36), box(40, 8, 6, 0, 0, 30), box(20, 8, 2, 14, 0, 10)]);
    const { mesh: low } = await csg.extrudeDown(shape, 20); // only the ledge goes down
    const { mesh: all } = await csg.extrudeDown(shape); // the top plate goes down too
    expect(analyze(low).ok).toBe(true);
    expect(signedVolume(low)).toBeLessThan(signedVolume(all));
    expect(bounds(all).min[2]).toBeCloseTo(0, 3);
    // As 3D Builder, each downward face goes straight down: the top plate (40×8) becomes a 36 mm
    // column, and the ledge's 4 mm overhang beyond it (4×8) a 12 mm one.
    expect(analyze(all).ok).toBe(true);
    expect(signedVolume(all)).toBeCloseTo(40 * 8 * 36 + 4 * 8 * 12, -2);
  });
});
