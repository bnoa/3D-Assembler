import { describe, expect, it } from 'vitest';
import * as csg from '../src/geometry/csg';
import { makePrimitive } from '../src/geometry/primitives';
import { analyze } from '../src/repair/analyze';
import { bounds, signedVolume, translated } from '../src/core/mesh-data';

describe('solid operations', () => {
  const a = makePrimitive('cube');
  const b = translated(makePrimitive('cube'), 20, 0, 0);

  it('union / intersection / subtraction volumes', async () => {
    expect(signedVolume(await csg.union([a, b]))).toBeCloseTo(40 * 40 * 60, -1);
    expect(signedVolume(await csg.intersection([a, b]))).toBeCloseTo(40 * 40 * 20, -1);
    expect(signedVolume(await csg.subtract(a, [b]))).toBeCloseTo(40 * 40 * 20, -1);
  });

  it('splits by a horizontal plane', async () => {
    const [above, below] = await csg.splitByZ(a, 0);
    expect(signedVolume(above)).toBeCloseTo(32000, -1);
    expect(signedVolume(below)).toBeCloseTo(32000, -1);
    expect(analyze(above).ok).toBe(true);
  });

  it('hollows as 3D Builder: blocky cavity on a 150 × 150 grid, eroded in 3D', async () => {
    const shell = await csg.hollow(a, 2);
    // 40 mm cube: cells of 40/150 mm; a cell is kept when the cell grown by 2 mm stays inside,
    // so columns 8..141 (134 cells); Z is eroded from [0, 40] to [2, 38] (z rounded to 0.01).
    const side = (134 * 40) / 150;
    expect(signedVolume(shell)).toBeCloseTo(64000 - side * side * 36, 0);
    const r = analyze(shell);
    expect(r.openEdges).toBe(0);
    expect(r.shells).toBe(2);
  });

  it('hollows a sphere into one watertight blocky cavity', async () => {
    const s = makePrimitive('sphere');
    const shell = await csg.hollow(s, 2);
    const r = analyze(shell);
    expect(r.openEdges).toBe(0);
    expect(r.shells).toBe(2);
    expect(signedVolume(shell)).toBeLessThan(signedVolume(s) * 0.6);
    expect(signedVolume(shell)).toBeGreaterThan(0);
  });

  it('extrudes down to the plate', async () => {
    const floating = translated(makePrimitive('cube'), 0, 0, 50);
    const { mesh: out, faceColors } = await csg.extrudeDown(floating);
    expect(bounds(out).min[2]).toBeCloseTo(0, 3);
    expect(signedVolume(out)).toBeCloseTo(40 * 40 * 70, -1);
    expect(analyze(out).ok).toBe(true);
    // As 3D Builder: the bottom is flattened in place (no extra faces but the walls), and the walls
    // and the low faces are grey (0.737).
    const cube = makePrimitive('cube');
    expect(out.indices.length / 3).toBe(cube.indices.length / 3 + 8);
    for (let f = 0; f < out.indices.length / 3; f++) {
      const up = [0, 1, 2].every((k) => out.positions[out.indices[f * 3 + k] * 3 + 2] > 69.9);
      expect(faceColors![f] === 0xbcbcbc).toBe(!up);
    }
  });

  it('extrudes down curved shapes, cut at the limit or overlapping themselves', async () => {
    // Sphere (min z 10) cut at mid-height: the lower half goes down, the top stays.
    const sphere = translated(makePrimitive('sphere'), 0, 0, 30);
    const half = await csg.extrudeDown(sphere, 30);
    expect(analyze(half.mesh).ok).toBe(true);
    expect(bounds(half.mesh).min[2]).toBeCloseTo(0, 3);
    expect(half.faceColors!.length).toBe(half.mesh.indices.length / 3);
    // Torus: its outer and inner downward rings both drop, the walls overlap, the repair merges them.
    const torus = translated(makePrimitive('torus'), 0, 0, 30);
    const t = await csg.extrudeDown(torus);
    expect(analyze(t.mesh).ok).toBe(true);
    expect(bounds(t.mesh).min[2]).toBeCloseTo(0, 2);
  });

  it('validates as 3D Builder: down faces removed, kept surface projected as the bottom, then merged', async () => {
    const floating = translated(makePrimitive('cube'), 0, 0, 50);
    const c = await csg.extrudeDown(floating, Infinity, undefined, true);
    expect(analyze(c.mesh).ok).toBe(true);
    expect(signedVolume(c.mesh)).toBeCloseTo(40 * 40 * 70, -1);
    expect(bounds(c.mesh).min[2]).toBeCloseTo(0, 3);
    const sphere = translated(makePrimitive('sphere'), 0, 0, 30);
    const half = await csg.extrudeDown(sphere, 30, new Uint32Array(sphere.indices.length / 3).fill(0xff0000), true);
    expect(analyze(half.mesh).ok).toBe(true);
    expect(half.faceColors!.length).toBe(half.mesh.indices.length / 3);
    expect(half.faceColors!.includes(0xbcbcbc)).toBe(true);
    const torus = translated(makePrimitive('torus'), 0, 0, 30);
    const t = await csg.extrudeDown(torus, Infinity, undefined, true);
    expect(analyze(t.mesh).ok).toBe(true);
    expect(bounds(t.mesh).min[2]).toBeCloseTo(0, 2);
  });

  it('simplify keeps a valid solid', async () => {
    const s = await csg.simplify(makePrimitive('sphere'), 0.5);
    expect(analyze(s).ok).toBe(true);
    expect(s.indices.length).toBeLessThan(makePrimitive('sphere').indices.length);
  });
});
