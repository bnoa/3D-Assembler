import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { DOMParser } from '@xmldom/xmldom';
import { read3MF } from '../src/io/threemf';
import { simplifyPasses } from '../src/geometry/simplify-passes';
import { analyze } from '../src/repair/analyze';
import { makePrimitive } from '../src/geometry/primitives';
import { CATALOG } from './reference-paths';

(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;
const sphereFile = `${CATALOG}/shape_sphere.3mf`;

describe('Simplifier as 3D Builder (passes)', () => {
  it.skipIf(!existsSync(sphereFile))('matches 3D Builder on the catalog sphere (2700, 1806, 1126, 526, 256, 216 faces measured live)', () => {
    const o = read3MF(new Uint8Array(readFileSync(sphereFile)))[0];
    const m = o.local?.mesh ?? o.mesh;
    const want = [2700, 1806, 1126, 526, 256, 216];
    for (let p = 1; p <= 6; p++) expect(simplifyPasses(m, p).mesh.indices.length / 3).toBe(want[p - 1]);
  });

  it('keeps a closed sphere closed and its face colours', () => {
    const m = makePrimitive('sphere');
    const colors = new Uint32Array(m.indices.length / 3).fill(0xff0000);
    const r = simplifyPasses(m, 3, colors);
    expect(r.faceColors!.length).toBe(r.mesh.indices.length / 3);
    const rep = analyze(r.mesh);
    expect(rep.openEdges).toBe(0);
    expect(rep.nonManifoldEdges).toBe(0);
  });

  it('does nothing at level 0', () => {
    const m = makePrimitive('cube');
    expect(simplifyPasses(m, 0).mesh).toBe(m);
  });
});
