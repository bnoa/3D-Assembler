import { describe, expect, it } from 'vitest';
import { makePrimitive } from '../src/geometry/primitives';
import { merged, translated } from '../src/core/mesh-data';
import { repairSolid } from '../src/repair/solid';
import { transferFaceColors } from '../src/repair/colors';

describe('colours through the repair (as 3D Builder keeps them)', () => {
  it('keeps each part\'s colour when the Wrap merges two overlapping cubes', async () => {
    const a = makePrimitive('cube'), b = translated(makePrimitive('cube'), 20, 0, 0);
    const input = merged([a, b]);
    const na = a.indices.length / 3;
    const colors = new Uint32Array(input.indices.length / 3).map((_, f) => (f < na ? 0xff0000 : 0x0000ff));
    const { mesh, log } = await repairSolid(input);
    expect(log.selfIntersections).toBeGreaterThan(0);
    const out = transferFaceColors(input, colors, mesh);
    // Faces of the union left of x = 0 come from the red cube only, right of x = 20 from the blue one.
    for (let f = 0; f < mesh.indices.length / 3; f++) {
      let cx = 0;
      for (let k = 0; k < 3; k++) cx += mesh.positions[mesh.indices[f * 3 + k] * 3] / 3;
      if (cx < -0.5) expect(out[f]).toBe(0xff0000);
      if (cx > 20.5) expect(out[f]).toBe(0x0000ff);
    }
  });

  it('keeps painted faces through a simple repair (flipped faces)', async () => {
    const c = makePrimitive('cube');
    const idx = c.indices.slice();
    [idx[1], idx[2]] = [idx[2], idx[1]]; // one flipped face
    const input = { positions: c.positions, indices: idx };
    const colors = new Uint32Array(idx.length / 3).map((_, f) => 0x100000 * (f + 1));
    const { mesh } = await repairSolid(input);
    const out = transferFaceColors(input, colors, mesh);
    expect(new Set(out).size).toBe(new Set(colors).size);
  });
});
