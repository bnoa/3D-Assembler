import { describe, expect, it } from 'vitest';
import { makePrimitive } from '../src/geometry/primitives';
import { analyze } from '../src/repair/analyze';
import { repairMesh } from '../src/repair/repair';
import { repairSolid } from '../src/repair/solid';
import { type MeshData, merged, signedVolume, translated } from '../src/core/mesh-data';

const cube = (dx = 0, dy = 0, dz = 0) => translated(makePrimitive('cube'), dx, dy, dz);

/** Merges vertices at identical positions, like an STL import does. */
function weldExact(m: MeshData): MeshData {
  const map = new Map<string, number>();
  const pos: number[] = [];
  const idx = m.indices.map((v) => {
    const key = `${m.positions[v * 3]},${m.positions[v * 3 + 1]},${m.positions[v * 3 + 2]}`;
    let id = map.get(key);
    if (id === undefined) {
      id = pos.length / 3;
      map.set(key, id);
      pos.push(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]);
    }
    return id;
  });
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

describe('non-manifold geometry', () => {
  it('splits two cubes touching along an edge', () => {
    // Prism cubes have no vertex on the shared edge midpoint, so weld makes the edge shared.
    const m = weldExact(merged([cube(), cube(40, 40, 0)]));
    const r0 = analyze(m);
    expect(r0.nonManifoldEdges).toBeGreaterThan(0);
    const { mesh, log } = repairMesh(m);
    expect(log.nonManifoldSplit).toBeGreaterThan(0);
    const r = analyze(mesh);
    expect(r).toMatchObject({ nonManifoldEdges: 0, openEdges: 0, flippedEdges: 0, ok: true });
    expect(r.shells).toBe(2);
    expect(r.volume).toBeCloseTo(128000, -1);
  });

  it('splits a bow-tie vertex', () => {
    const m = weldExact(merged([cube(), cube(40, 40, 40)]));
    const r = analyze(repairMesh(m).mesh);
    expect(r.ok).toBe(true);
    expect(r.shells).toBe(2);
  });
});

describe('overlapping shells', () => {
  it('merges overlapping parts into one solid', async () => {
    const m = merged([cube(), cube(20, 0, 0)]);
    expect(analyze(m).ok).toBe(true); // valid topology, but parts intersect
    const { mesh, log } = await repairSolid(m);
    expect(log.shellsMerged).toBe(1);
    expect(analyze(mesh).shells).toBe(1);
    expect(signedVolume(mesh)).toBeCloseTo(40 * 40 * 60, -1);
  });

  it('leaves separate parts alone', async () => {
    const m = merged([cube(), cube(100, 0, 0)]);
    const { mesh, log } = await repairSolid(m);
    expect(log.shellsMerged).toBe(0);
    expect(analyze(mesh).shells).toBe(2);
  });

  it('drops a cavity that another part cuts through (as 3D Builder does)', async () => {
    const outer = makePrimitive('cube');
    const inner = { positions: outer.positions.map((v) => v * 0.5), indices: outer.indices.slice() };
    for (let i = 0; i < inner.indices.length; i += 3) [inner.indices[i + 1], inner.indices[i + 2]] = [inner.indices[i + 2], inner.indices[i + 1]];
    const { mesh } = await repairSolid(merged([outer, inner, cube(10, 0, 0)]));
    expect(signedVolume(mesh)).toBeCloseTo(40 * 40 * 50, -1);
  });
});
