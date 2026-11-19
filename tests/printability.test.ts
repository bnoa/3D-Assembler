import { describe, expect, it } from 'vitest';
import { analyzePrint } from '../src/analysis/printability';
import { makePrimitive, prism } from '../src/geometry/primitives';
import * as csg from '../src/geometry/csg';
import { translated } from '../src/core/mesh-data';

const box = (sx: number, sy: number, sz: number, x = 0, y = 0, z = 0) =>
  translated(prism([[-sx / 2, -sy / 2], [sx / 2, -sy / 2], [sx / 2, sy / 2], [-sx / 2, sy / 2]], sz), x, y, z + sz / 2);

describe('print checks', () => {
  it('a cube on the plate is ready to print', () => {
    const r = analyzePrint(translated(makePrimitive('cube'), 0, 0, 20));
    expect(r.overhangFaces.length).toBe(0);
    expect(r.floating).toBe(false);
    expect(r.narrowBase).toBe(false);
    expect(r.fitsBed).toBe(true);
    expect(r.contactArea).toBeCloseTo(1600, 0);
    expect(r.thinFaces.length).toBe(0);
  });

  it('finds the overhang of a T shape', async () => {
    const t = await csg.union([box(8, 8, 30), box(40, 8, 6, 0, 0, 30)]);
    const r = analyzePrint(t);
    expect(r.overhangArea).toBeCloseTo((40 - 8) * 8, 0);
    expect(r.narrowBase).toBe(false);
  });

  it('flags a floating object and one too big for the bed', () => {
    expect(analyzePrint(translated(makePrimitive('cube'), 0, 0, 30)).floating).toBe(true);
    expect(analyzePrint(box(300, 20, 20)).fitsBed).toBe(false);
  });

  it('measures thin walls', async () => {
    const shell = await csg.hollow(translated(makePrimitive('cube'), 0, 0, 20), 0.5);
    const r = analyzePrint(shell, { minWall: 0.8 });
    expect(r.thinFaces.length).toBeGreaterThan(0);
    expect(r.minThickness).toBeCloseTo(0.5, 1);
    expect(analyzePrint(shell, { minWall: 0.4 }).thinFaces.length).toBe(0);
  }, 30000); // slow: the blocky cavity has many faces

  it('a needle standing on its tip has a narrow base', () => {
    const cone = makePrimitive('cone');
    const flipped = { positions: cone.positions.map((v, i) => (i % 3 === 2 ? -v + 20 : v)), indices: cone.indices.map((v, i, a) => (i % 3 === 1 ? a[i + 1] : i % 3 === 2 ? a[i - 1] : v)) };
    expect(analyzePrint(flipped).narrowBase).toBe(true);
  });
});
