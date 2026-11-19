import { describe, expect, it } from 'vitest';
import { booleanMesh } from '../src/repair/wrap';
import { makePrimitive } from '../src/geometry/primitives';
import { analyze } from '../src/repair/analyze';
import { signedVolume, translated } from '../src/core/mesh-data';
import * as csg from '../src/geometry/csg';

const cube = (dx = 0, dy = 0, dz = 0) => translated(makePrimitive('cube'), dx, dy, dz);

describe('booleans (3D Builder engine: winding classification of cut faces)', () => {
  it('two overlapping cubes sharing face planes', async () => {
    const a = cube(), b = cube(20, 0, 0);
    const u = await booleanMesh(a, b, 'union');
    const s = await booleanMesh(a, b, 'subtract');
    const i = await booleanMesh(a, b, 'intersect');
    for (const m of [u, s, i]) expect(analyze(m).ok).toBe(true);
    expect(signedVolume(u)).toBeCloseTo(60 * 40 * 40, -1);
    expect(signedVolume(s)).toBeCloseTo(20 * 40 * 40, -1);
    expect(signedVolume(i)).toBeCloseTo(20 * 40 * 40, -1);
  });

  it('matches manifold-3d on a sphere and an offset cube', async () => {
    const a = makePrimitive('sphere'), b = cube(15, 10, 8);
    for (const op of ['union', 'subtract', 'intersect'] as const) {
      const m = await booleanMesh(a, b, op);
      expect(analyze(m).ok).toBe(true);
      const ref = op === 'union' ? await csg.union([a, b]) : op === 'intersect' ? await csg.intersection([a, b]) : await csg.subtract(a, [b]);
      expect(Math.abs(signedVolume(m) / signedVolume(ref) - 1)).toBeLessThan(1e-3);
    }
  });

  it('handles disjoint and nested operands (no intersection at all)', async () => {
    const far = await booleanMesh(cube(), cube(100, 0, 0), 'union');
    expect(signedVolume(far)).toBeCloseTo(2 * 64000, -1);
    expect(analyze(far).shells).toBe(2);
    const inner = translated({ positions: makePrimitive('cube').positions.map((v) => v * 0.5), indices: makePrimitive('cube').indices }, 0, 0, 0);
    const hollow = await booleanMesh(cube(), inner, 'subtract');
    expect(signedVolume(hollow)).toBeCloseTo(64000 - 8000, -1);
    expect(analyze(hollow).shells).toBe(2);
    expect((await booleanMesh(cube(), inner, 'intersect')).indices.length / 3).toBe(inner.indices.length / 3);
  });

  it('subtracts a tool flush with the top face (through-hole at the top)', async () => {
    const tool = translated({ positions: makePrimitive('cube').positions.map((v, k) => (k % 3 === 2 ? v : v * 0.25)), indices: makePrimitive('cube').indices }, 0, 0, 10);
    // Tool: 10×10, z from -10 to 30; the block: z from -20 to 20. Its top at 30 sticks out.
    const r = await booleanMesh(cube(), tool, 'subtract');
    expect(analyze(r).ok).toBe(true);
    expect(signedVolume(r)).toBeCloseTo(64000 - 10 * 10 * 30, -1);
  });
});
