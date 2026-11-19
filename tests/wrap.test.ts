import { describe, expect, it } from 'vitest';
import { makePrimitive } from '../src/geometry/primitives';
import { analyze } from '../src/repair/analyze';
import { countSelfIntersections, wrapMesh } from '../src/repair/wrap';
import { repairSolid } from '../src/repair/solid';
import { type MeshData, merged, signedVolume, translated } from '../src/core/mesh-data';

const cube = (dx = 0, dy = 0, dz = 0, s = 1) => {
  const c = makePrimitive('cube');
  return translated({ positions: c.positions.map((v) => v * s), indices: c.indices }, dx, dy, dz);
};

/** Spindle torus (tube radius larger than the ring radius): one shell crossing itself. */
function spindleTorus(R: number, r: number, seg = 48, tube = 32): MeshData {
  const pos: number[] = [];
  for (let i = 0; i < seg; i++) {
    const u = (i / seg) * Math.PI * 2;
    for (let j = 0; j < tube; j++) {
      const v = (j / tube) * Math.PI * 2;
      const w = R + r * Math.cos(v);
      pos.push(w * Math.cos(u), w * Math.sin(u), r * Math.sin(v));
    }
  }
  const at = (i: number, j: number) => (i % seg) * tube + (j % tube);
  const idx: number[] = [];
  for (let i = 0; i < seg; i++) for (let j = 0; j < tube; j++) {
    const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
    idx.push(a, b, c, a, c, d);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

describe('wrap', () => {
  it('does nothing when no triangles intersect', async () => {
    expect(await wrapMesh(merged([cube(), cube(100)]))).toBeNull();
    expect(await countSelfIntersections(makePrimitive('sphere'))).toBe(0);
  });

  it('merges two overlapping cubes, including their coplanar faces', async () => {
    const res = await wrapMesh(merged([cube(), cube(20)]));
    expect(res).not.toBeNull();
    const r = analyze(res!.mesh);
    expect(r.openEdges).toBe(0);
    expect(r.shells).toBe(1);
    expect(r.volume).toBeCloseTo(40 * 40 * 60, -2);
  });

  it('rebuilds the outer surface of a shell pushed through itself', async () => {
    // Sphere whose north cap is pushed down through the south cap: one shell crossing itself.
    const s = makePrimitive('sphere');
    const pos = s.positions.slice();
    for (let i = 0; i < pos.length; i += 3) if (pos[i + 2] > 15) pos[i + 2] -= 45;
    const t = { positions: pos, indices: s.indices };
    expect(analyze(t).openEdges).toBe(0);
    expect(await countSelfIntersections(t)).toBeGreaterThan(0);
    const { mesh, log } = await repairSolid(t);
    expect(log.selfIntersections).toBeGreaterThan(0);
    const r = analyze(mesh);
    expect(r.ok).toBe(true);
    expect(await countSelfIntersections(mesh)).toBe(0);
  });

  it('never destroys a model it cannot wrap (spindle torus: all slices cross on one line)', async () => {
    // Known limit: dozens of nearly coincident intersection curves; without exact arithmetic the
    // cut pieces cannot be stitched. The repair must then leave the model intact and say so.
    const t = spindleTorus(6, 10);
    expect(analyze(t).ok).toBe(true);
    const { mesh, log } = await repairSolid(t);
    expect(analyze(mesh).ok).toBe(true);
    expect(mesh.indices.length).toBe(t.indices.length);
    expect(log.selfIntersectionsLeft).toBeGreaterThan(0);
  });

  it('removes debris crossing the inside of a solid', async () => {
    const debris = translated(makePrimitive('tetrahedron'), 15, 0, 0); // pokes through one wall
    const { mesh } = await repairSolid(merged([cube(), debris]));
    const r = analyze(mesh);
    expect(r.ok).toBe(true);
    expect(await countSelfIntersections(mesh)).toBe(0);
  });

  it('drops an inner cavity while merging overlapping parts (as 3D Builder does)', async () => {
    const outer = makePrimitive('cube');
    const inner = { positions: outer.positions.map((v) => v * 0.5), indices: outer.indices.slice() };
    for (let i = 0; i < inner.indices.length; i += 3) [inner.indices[i + 1], inner.indices[i + 2]] = [inner.indices[i + 2], inner.indices[i + 1]];
    const { mesh } = await repairSolid(merged([outer, inner, cube(35)]));
    expect(signedVolume(mesh)).toBeCloseTo(64000 * 2 - 5 * 40 * 40, -2);
  });
});
