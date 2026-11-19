// The repair of 3D Builder halves every edge longer than 30,400 wrap grid steps
// (grid = diagonal / 100,000, i.e. 0.304 × the diagonal of the model), round after round, so a
// coarse model always comes out subdivided. Face counts and patterns below were measured in
// 3D Builder 20.0.4.0 on the same small STL cases (20 mm cube, 40 × 10 × 5 mm box).
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/repair/analyze';
import { repairSolid } from '../src/repair/solid';
import { wrapMaxEdge } from '../src/repair/repair';
import { type MeshData, fromTriangleSoup, signedVolume } from '../src/core/mesh-data';

type V = [number, number, number];
const box = (X: number, Y: number, Z: number): V[] => [[0, 0, 0], [X, 0, 0], [X, Y, 0], [0, Y, 0], [0, 0, Z], [X, 0, Z], [X, Y, Z], [0, Y, Z]];
// Same vertex order and triangles as an STL exported face by face (bottom, top, then the sides).
const faces = (): number[][] => [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
const stl = (v: V[], f: number[][], extra: V[][] = []): MeshData => fromTriangleSoup([...f.map((t) => t.map((i) => v[i])), ...extra].flat(2));

const cube = box(20, 20, 20);
const cases = {
  hole: () => { const f = faces(); f.splice(2, 1); return stl(cube, f); },
  holeTop: () => { const f = faces(); f.splice(2, 2); return stl(cube, f); },
  clean: () => stl(cube, faces()),
  flip: () => { const f = faces(); f[0] = [0, 1, 2]; return stl(cube, f); },
  dup: () => { const f = faces(); f.push(f[5].slice()); return stl(cube, f); },
  brokenMix: () => {
    const f = faces();
    f.splice(2, 1);
    f[0] = [0, 1, 2];
    f.push(f[5].slice());
    return stl(cube, f, [[[40, 0, 0], [41, 0, 0], [40, 1, 0]]]);
  },
  boxHole: () => { const f = faces(); f.splice(2, 1); return stl(box(40, 10, 5), f); },
};

/** Triangles lying in the plane coordinate[axis] = value, as sorted vertex lists. */
function facesOn(m: MeshData, axis: number, value: number): string[] {
  const out: string[] = [];
  const P = m.positions, I = m.indices;
  for (let i = 0; i < I.length; i += 3) {
    const pts = [0, 1, 2].map((k) => [P[I[i + k] * 3], P[I[i + k] * 3 + 1], P[I[i + k] * 3 + 2]].map((q) => Math.round(q * 100) / 100));
    if (pts.every((p) => Math.abs(p[axis] - value) < 1e-6)) out.push(pts.map((p) => p.filter((_, k) => k !== axis).join(',')).sort().join(' '));
  }
  return out.sort();
}

describe('repair subdivides long edges (as 3D Builder does)', () => {
  it('limit is 0.304 × the diagonal, whatever the size', () => {
    expect(wrapMaxEdge(20, Math.sqrt(3) * 20)).toBeCloseTo(0.304 * Math.sqrt(3) * 20, 9);
    expect(wrapMaxEdge(1000, Math.sqrt(3) * 1000)).toBeCloseTo(0.304 * Math.sqrt(3) * 1000, 6);
    expect(wrapMaxEdge(1, Math.sqrt(3))).toBeCloseTo(0.304 * Math.sqrt(3), 9);
  });

  it.each([
    ['hole', 96],
    ['holeTop', 96],
    ['flip', 96],
    ['dup', 96],
    ['boxHole', 76],
    // The 1 mm fragment enlarges the box (diagonal 49.8 mm): sides are halved once only, then
    // the fragment is removed as a small shell.
    ['brokenMix', 48],
    // Nothing to fix (3D Builder does not even offer the repair): the faces are kept.
    ['clean', 12],
  ] as const)('%s → %i faces, one closed piece', async (name, count) => {
    const { mesh } = await repairSolid(cases[name]());
    const r = analyze(mesh);
    expect(mesh.indices.length / 3).toBe(count);
    expect(r.ok).toBe(true);
    expect(r.shells).toBe(1);
    expect(signedVolume(mesh)).toBeCloseTo(name === 'boxHole' ? 2000 : 8000, 6);
  });

  it('20 mm cube: each side becomes a 2 × 2 grid, each square 4 triangles around its centre', async () => {
    const { mesh } = await repairSolid(cases.hole());
    for (const [axis, value] of [[0, 0], [0, 20], [1, 0], [1, 20], [2, 0], [2, 20]]) {
      const tris = facesOn(mesh, axis, value);
      expect(tris.length).toBe(16);
      const corners = new Set(tris.flatMap((t) => t.split(' ')));
      // 4 corners, 4 edge midpoints, the centre and the 4 square centres.
      expect([...corners].sort()).toEqual(['0,0', '0,10', '0,20', '10,0', '10,10', '10,20', '15,15', '15,5', '20,0', '20,10', '20,20', '5,15', '5,5']);
    }
    // The patch is flat and faces outwards like the rest of the top.
    const P = mesh.positions, I = mesh.indices;
    for (let i = 0; i < I.length; i += 3) {
      const z = [0, 1, 2].map((k) => P[I[i + k] * 3 + 2]);
      if (z.every((q) => q === 20)) {
        const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
        const nz = (P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[b + 1] - P[a + 1]) * (P[c] - P[a]);
        expect(nz).toBeGreaterThan(0);
      }
    }
  });

  it('box 40 × 10 × 5: same triangles as 3D Builder on the patched top', async () => {
    const { mesh } = await repairSolid(cases.boxHole());
    expect(facesOn(mesh, 0, 0).length).toBe(2); // 10 × 5 ends: no edge over 12.6 mm
    expect(facesOn(mesh, 2, 0).length).toBe(18);
    expect(facesOn(mesh, 2, 5)).toEqual([
      '0,0 0,10 10,2.5', '0,0 10,0 10,2.5', '0,10 10,10 10,7.5', '0,10 10,2.5 10,7.5', '10,0 10,2.5 20,0',
      '10,10 10,7.5 20,10', '10,2.5 10,7.5 20,5', '10,2.5 20,0 20,5', '10,7.5 20,10 20,5', '20,0 20,5 30,2.5',
      '20,0 30,0 30,2.5', '20,10 20,5 30,7.5', '20,10 30,10 30,7.5', '20,5 30,2.5 30,7.5', '30,0 30,2.5 40,0',
      '30,10 30,7.5 40,10', '30,2.5 30,7.5 40,0', '30,7.5 40,0 40,10',
    ]);
  });
});
