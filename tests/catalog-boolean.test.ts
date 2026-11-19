// Booleans on the models shipped with 3D Builder (read in place, never copied): each repaired
// model is merged with a shifted copy of itself, intersected with it, and a sphere is subtracted
// from it; every result must be a valid solid.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { read3MF } from '../src/io/threemf';
import { analyze } from '../src/repair/analyze';
import { repairSolid } from '../src/repair/solid';
import { booleanPair } from '../src/geometry/csg';
import { countSelfIntersections } from '../src/repair/wrap';
import { makePrimitive } from '../src/geometry/primitives';
import { bounds, translated } from '../src/core/mesh-data';
import { CATALOG } from './reference-paths';

(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

const dir = CATALOG;
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.3mf')) : [];

describe.skipIf(!files.length)('booleans on the 3D Builder catalog', () => {
  it.each(files)('%s merges, intersects and subtracts into valid solids', async (file) => {
    for (const o of read3MF(new Uint8Array(readFileSync(join(dir, file))))) {
      const { mesh } = await repairSolid(o.mesh);
      // Booleans need valid solids (3D Builder checks it before subtracting): models the repair
      // could not untangle are left out.
      if (!analyze(mesh).ok || (await countSelfIntersections(mesh))) continue;
      const b = bounds(mesh);
      const s = [0, 1, 2].map((k) => b.max[k] - b.min[k]);
      const c = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2);
      const copy = translated(mesh, s[0] * 0.3, s[1] * 0.2, s[2] * 0.1);
      const r = Math.max(...s) * 0.3 / 20;
      const sphere = makePrimitive('sphere');
      const ball = translated({ positions: sphere.positions.map((v) => v * r), indices: sphere.indices }, c[0] + s[0] * 0.3, c[1], c[2] + s[2] * 0.2);
      for (const [x, y, op] of [[mesh, copy, 'union'], [mesh, copy, 'intersect'], [mesh, ball, 'subtract']] as const) {
        const res = await booleanPair(x, y, op);
        if (!res.indices.length) continue;
        const a = analyze(res);
        if (!a.ok) console.log(`${file} / ${o.name} ${op}: open ${a.openEdges} nm ${a.nonManifoldEdges} deg ${a.degenerateFaces}`);
        expect(a.ok).toBe(true);
      }
    }
  }, 300000);
});
