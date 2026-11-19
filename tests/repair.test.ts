import { describe, expect, it } from 'vitest';
import { makePrimitive, PRIMITIVES } from '../src/geometry/primitives';
import { analyze } from '../src/repair/analyze';
import { repairMesh } from '../src/repair/repair';
import { type MeshData, flipped, fromTriangleSoup, merged, signedVolume, translated } from '../src/core/mesh-data';

const cube = () => makePrimitive('cube');

function dropFaces(m: MeshData, faces: number[]): MeshData {
  const keep: number[] = [];
  for (let f = 0; f < m.indices.length / 3; f++) if (!faces.includes(f)) keep.push(m.indices[f * 3], m.indices[f * 3 + 1], m.indices[f * 3 + 2]);
  return { positions: m.positions, indices: new Uint32Array(keep) };
}

function soup(m: MeshData): Float32Array {
  const s = new Float32Array(m.indices.length * 3);
  m.indices.forEach((v, i) => s.set(m.positions.subarray(v * 3, v * 3 + 3), i * 3));
  return s;
}

describe('primitives', () => {
  it.each(PRIMITIVES.map((p) => p.kind))('%s is closed and outward facing', (kind) => {
    const r = analyze(makePrimitive(kind));
    expect(r.openEdges).toBe(0);
    expect(r.nonManifoldEdges).toBe(0);
    expect(r.flippedEdges).toBe(0);
    expect(r.volume).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
  });

  it('cube is 40 mm', () => {
    expect(signedVolume(cube())).toBeCloseTo(64000, 0);
  });
});

describe('repair', () => {
  it('closes holes', () => {
    const holed = dropFaces(makePrimitive('cylinder'), [0, 3]);
    expect(analyze(holed).ok).toBe(false);
    const { mesh, log } = repairMesh(holed);
    expect(log.holesClosed).toBeGreaterThan(0);
    const r = analyze(mesh);
    expect(r.ok).toBe(true);
    expect(r.volume).toBeCloseTo(signedVolume(makePrimitive('cylinder')), 0);
  });

  it('fixes flipped faces', () => {
    const c = cube();
    const idx = new Uint32Array(c.indices);
    [idx[1], idx[2]] = [idx[2], idx[1]];
    [idx[7], idx[8]] = [idx[8], idx[7]];
    const bad = { positions: c.positions, indices: idx };
    expect(analyze(bad).flippedEdges).toBeGreaterThan(0);
    const r = analyze(repairMesh(bad).mesh);
    expect(r.ok).toBe(true);
  });

  it('turns an inside-out shell outward', () => {
    const c = cube();
    const inside = { positions: c.positions, indices: flipped(c.indices) };
    expect(analyze(inside).volume).toBeLessThan(0);
    const { mesh, log } = repairMesh(inside);
    expect(log.shellsInverted).toBe(1);
    expect(analyze(mesh).ok).toBe(true);
  });

  it('keeps cavities inward facing', () => {
    const outer = makePrimitive('cube');
    const inner = { positions: makePrimitive('cube').positions.map((v) => v * 0.5), indices: flipped(outer.indices) };
    const mesh = merged([outer, inner]);
    const fixed = repairMesh(mesh).mesh;
    expect(signedVolume(fixed)).toBeCloseTo(64000 - 8000, 0);
  });

  it('welds an STL-like triangle soup with tiny gaps', () => {
    const s = soup(makePrimitive('sphere'));
    for (let i = 0; i < s.length; i++) s[i] += (Math.random() - 0.5) * 1e-5;
    const raw = fromTriangleSoup(s);
    expect(analyze(raw).ok).toBe(false);
    expect(analyze(repairMesh(raw).mesh).ok).toBe(true);
  });

  it('removes duplicate and degenerate faces', () => {
    const c = cube();
    const idx = [...c.indices, c.indices[0], c.indices[1], c.indices[2], 0, 0, 1];
    const bad = { positions: c.positions, indices: new Uint32Array(idx) };
    const r0 = analyze(bad);
    expect(r0.duplicateFaces).toBe(1);
    expect(r0.degenerateFaces).toBe(1);
    expect(analyze(repairMesh(bad).mesh).ok).toBe(true);
  });

  it('repairs a sphere with scattered holes and flipped faces', () => {
    const s = makePrimitive('sphere');
    const keep: number[] = [];
    for (let f = 0; f < s.indices.length / 3; f++) {
      if (f % 50 === 7) continue;
      const t = Array.from(s.indices.slice(f * 3, f * 3 + 3));
      keep.push(...(f % 23 === 3 ? [t[0], t[2], t[1]] : t));
    }
    const broken = fromTriangleSoup(soup({ positions: s.positions, indices: new Uint32Array(keep) }));
    const r0 = analyze(broken);
    expect(r0.holes).toBeGreaterThan(10);
    expect(r0.flippedEdges).toBeGreaterThan(10);
    const r = analyze(repairMesh(broken).mesh);
    expect(r).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, flippedEdges: 0, duplicateFaces: 0, ok: true });
    expect(r.volume).toBeCloseTo(signedVolume(s), -2);
  });

  it('stitches a T-junction', () => {
    // Two boxes stacked: the top face of the lower box is split at x = 0 (extra vertices on the
    // shared edges), the bottom face of the upper box is not, so open edges meet in T-junctions.
    const quad = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
    const s = 10;
    const tris = [
      // lower box (z 0..s), top split into two quads along x = 0
      ...quad([-s, -s, 0], [-s, s, 0], [s, s, 0], [s, -s, 0]),
      ...quad([-s, -s, 0], [s, -s, 0], [s, -s, s], [-s, -s, s]),
      ...quad([s, -s, 0], [s, s, 0], [s, s, s], [s, -s, s]),
      ...quad([s, s, 0], [-s, s, 0], [-s, s, s], [s, s, s]),
      ...quad([-s, s, 0], [-s, -s, 0], [-s, -s, s], [-s, s, s]),
      ...quad([-s, -s, s], [0, -s, s], [0, s, s], [-s, s, s]),
      ...quad([0, -s, s], [s, -s, s], [s, s, s], [0, s, s]),
    ];
    const lower = fromTriangleSoup(new Float32Array(tris));
    const r0 = analyze(lower);
    expect(r0.openEdges).toBeGreaterThan(0); // side walls' top edges meet the split top in T-junctions
    const r = analyze(repairMesh(lower).mesh);
    expect(r.ok).toBe(true);
    expect(r.volume).toBeCloseTo(20 * 20 * 10, 0);
  });

  it('fixes a zero-area face by flipping, without opening a hole', () => {
    const c = cube();
    // Edge a-b of face f = (a, b, c0): put v at its midpoint, split f, and close the other side
    // with the degenerate face (a, b, v).
    const [a, b, c0] = [c.indices[0], c.indices[1], c.indices[2]];
    const pos = Array.from(c.positions);
    const v = pos.length / 3;
    for (let k = 0; k < 3; k++) pos.push((pos[a * 3 + k] + pos[b * 3 + k]) / 2);
    const idx = [a, v, c0, v, b, c0, a, b, v, ...Array.from(c.indices.slice(3))];
    const bad = { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
    const r0 = analyze(bad);
    expect(r0.degenerateFaces).toBe(1);
    expect(r0.openEdges).toBe(0);
    const { mesh, log } = repairMesh(bad);
    expect(log.degenerateRemoved).toBeGreaterThan(0);
    const r = analyze(mesh);
    expect(r).toMatchObject({ degenerateFaces: 0, openEdges: 0, ok: true });
    expect(r.volume).toBeCloseTo(64000, 0);
  });

  it.each([0.01, 50])('repairs at any scale (×%s), thanks to normalisation', (k) => {
    const holed = dropFaces(makePrimitive('sphere'), [5, 200, 600]);
    const scaled = { positions: holed.positions.map((x) => x * k), indices: holed.indices };
    const r = analyze(repairMesh(scaled).mesh);
    expect(r.ok).toBe(true);
    expect(r.volume / k ** 3).toBeCloseTo(signedVolume(makePrimitive('sphere')), -2);
  });

  it('fills a large hole with a minimal-area patch', () => {
    // Remove the whole top cap of a cylinder: a single 120-vertex hole.
    const cyl = makePrimitive('cylinder');
    const top: number[] = [];
    for (let f = 0; f < cyl.indices.length / 3; f++) if ([0, 1, 2].every((k) => cyl.positions[cyl.indices[f * 3 + k] * 3 + 2] > 19.9)) top.push(f);
    const { mesh, log } = repairMesh(dropFaces(cyl, top));
    expect(log.holesClosed).toBe(1);
    const r = analyze(mesh);
    expect(r.ok).toBe(true);
    expect(r.volume).toBeCloseTo(signedVolume(cyl), -1);
  });

  it('drops tiny floating fragments', () => {
    const tiny = translated(makePrimitive('tetrahedron'), 100, 0, 0);
    const small = { positions: tiny.positions.map((v, i) => (i % 3 === 0 ? 100 + (v - 100) * 0.001 : v * 0.001)), indices: tiny.indices };
    const { mesh, log } = repairMesh(merged([cube(), small]));
    expect(log.shellsRemoved).toBe(1);
    expect(analyze(mesh).shells).toBe(1);
  });
});
