// Split check on the models shipped with 3D Builder (read in place, never copied): every model,
// once repaired, is cut through its centre horizontally, at a slant and on its symmetry plane
// (which passes a hair off many vertices); every piece must be a valid closed solid.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { read3MF } from '../src/io/threemf';
import { analyze } from '../src/repair/analyze';
import { repairSolid } from '../src/repair/solid';
import { splitPlane } from '../src/geometry/csg';
import { bounds } from '../src/core/mesh-data';
import { CATALOG } from './reference-paths';

(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

const dir = CATALOG;
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.3mf')) : [];

describe.skipIf(!files.length)('split on the 3D Builder catalog', () => {
  it.each(files)('%s splits into valid pieces', async (file) => {
    for (const o of read3MF(new Uint8Array(readFileSync(join(dir, file))))) {
      const { mesh } = await repairSolid(o.mesh);
      if (!analyze(mesh).ok) continue;
      const b = bounds(mesh);
      const c = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2) as [number, number, number];
      for (const n of [[0, 0, 1], [0.3, 0.2, 1], [1, 0, 0]] as [number, number, number][]) {
        const r = await splitPlane(mesh, n, c);
        for (const p of [...r.above, ...r.below]) expect(analyze(p.mesh).ok).toBe(true);
      }
    }
  }, 120000);
});
