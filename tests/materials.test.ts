import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';
import { read3MF, write3MF } from '../src/io/threemf';
import { makePrimitive } from '../src/geometry/primitives';
import { colorFromAttenuation, materialOf, translucentAttenuation } from '../src/core/model';
import { REFERENCE } from './reference-paths';

(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

describe('Matériau (3D Builder: Aucun, Simple, Réaliste, Translucide)', () => {
  it('turns a translucent colour into 3D Builder\'s attenuation and back', () => {
    // Read in 3D Builder's files: grey #7F7F7F → 37.2852 on each channel.
    for (const a of translucentAttenuation('#7f7f7f')) expect(a).toBeCloseTo(37.2852, 1);
    expect(colorFromAttenuation([37.2852, 37.2852, 37.2852])).toBe('#7f7f7f');
    expect(colorFromAttenuation(translucentAttenuation('#21bb4c'))).toBe('#21bb4c');
  });

  it('writes Réaliste as pbmetallic, Translucide as translucent (white base), Aucun without material', () => {
    const cube = makePrimitive('cube');
    const file = write3MF([
      { name: 'or', mesh: cube, color: '#dbb22c', material: { kind: 'realistic', gloss: 0.75, metallic: true } },
      { name: 'verre', mesh: cube, color: '#7f7f7f', material: { kind: 'translucent', gloss: 0.5, metallic: false } },
      { name: 'rien', mesh: cube, color: '#bcbcbc', material: { kind: 'none', gloss: 0.5, metallic: false } },
      { name: 'simple', mesh: cube, color: '#21bb4c' },
    ]);
    const xml = strFromU8(unzipSync(file)['3D/3dmodel.model']);
    expect(xml).toContain('<m:pbmetallic name="Metallic" metallicness="1" roughness="0.25"/>');
    expect(xml).toContain('attenuation="37.28');
    expect(xml).toContain('<base name="Translucent" displaycolor="#FFFFFFFF"/>');
    expect(xml).toMatch(/<object id="\d+" type="model" name="rien">/);
    const back = read3MF(file);
    expect(back.map((o) => o.material?.kind)).toEqual(['realistic', 'translucent', undefined, undefined]);
    expect(back[0].material).toEqual({ kind: 'realistic', gloss: 0.75, metallic: true });
    expect(back[1].color).toBe('#7f7f7f');
    expect(back[0].color).toBe('#dbb22c');
  });

  it('reads older material names (saved sessions)', () => {
    expect(materialOf('metal')).toEqual({ kind: 'realistic', gloss: 0.75, metallic: true });
    expect(materialOf(undefined).kind).toBe('simple');
  });

  it.skipIf(!existsSync(REFERENCE + 'materials-a-3db.3mf'))('reads 3D Builder\'s files: translucent green, gold, none', () => {
    const objs = read3MF(new Uint8Array(readFileSync(REFERENCE + 'materials-a-3db.3mf')));
    const [glass, gold, none] = objs;
    expect(glass.material).toEqual({ kind: 'translucent', gloss: 0.5, metallic: false });
    expect(glass.color).toMatch(/^#2[12]b[ab]4[bc]$/); // the green, from its attenuation
    expect(gold.material).toEqual({ kind: 'realistic', gloss: 0.75, metallic: true });
    expect(gold.color).toBe('#dbb22c');
    expect(none.material).toBeUndefined();
  });
});
