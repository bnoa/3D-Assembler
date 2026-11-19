// Real-world check on the models shipped with 3D Builder, when it is installed on this machine.
// The files are read in place and never copied into the repository.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { read3MF } from '../src/io/threemf';
import { analyze } from '../src/repair/analyze';
import { repairSolid } from '../src/repair/solid';
import { countSelfIntersections } from '../src/repair/wrap';
import { CATALOG } from './reference-paths';

(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

const dir = CATALOG;
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.3mf')) : [];

describe.skipIf(!files.length)('3D Builder catalog models', () => {
  it.each(files)('%s imports, and repairs to a valid solid', async (file) => {
    const objects = read3MF(new Uint8Array(readFileSync(join(dir, file))));
    expect(objects.length).toBeGreaterThan(0);
    for (const o of objects) {
      const before = analyze(o.mesh);
      const t0 = performance.now();
      const { mesh, log } = await repairSolid(o.mesh);
      const after = analyze(mesh);
      const left = await countSelfIntersections(mesh);
      console.log(`${file} / ${o.name || '(sans nom)'}: ${before.triangles} tri, ok avant=${before.ok} (ouverts ${before.openEdges}, nm ${before.nonManifoldEdges}, coques ${before.shells}) → ok après=${after.ok}, coques ${after.shells}, intersections résolues ${log.selfIntersections}, restantes ${left}, non résolues ${log.selfIntersectionsLeft}, ${Math.round(performance.now() - t0)} ms`);
      expect(after.ok).toBe(true);
    }
  }, 120000);

  it.skipIf(!files.includes('windmill.3mf'))('windmill: the folded fins are wrapped (no crossing left, volume kept)', async () => {
    for (const o of read3MF(new Uint8Array(readFileSync(join(dir, 'windmill.3mf'))))) {
      const { mesh, log } = await repairSolid(o.mesh);
      expect(analyze(mesh).ok).toBe(true);
      expect(log.selfIntersectionsLeft).toBe(0);
      expect(await countSelfIntersections(mesh)).toBe(0);
      // Overlaps counted twice in the input: the union is a little smaller (under 0.1 %).
      expect(Math.abs(analyze(mesh).volume / analyze(o.mesh).volume - 1)).toBeLessThan(0.001);
    }
  }, 120000);
});
