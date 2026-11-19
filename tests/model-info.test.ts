import { describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { unzipSync } from 'fflate';
import { read3MF, read3MFInfo, write3MF } from '../src/io/threemf';
import { makePrimitive } from '../src/geometry/primitives';

(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

describe('3MF model metadata ("À propos de ce modèle")', () => {
  it('writes and reads back title, designer, copyright, licence terms and description', () => {
    const info = { title: 'Support <casque>', designer: 'Atelier', copyright: '© 2026', licenseTerms: 'CC BY 4.0', description: 'Ligne 1\nLigne 2 & fin' };
    const back = read3MFInfo(write3MF([{ name: 'cube', mesh: makePrimitive('cube'), color: '#21bb4c' }], 'scène', info));
    expect(back).toEqual(info);
  });

  it('writes only the filled fields, as 3D Builder (no title from the scene name)', () => {
    const back = read3MFInfo(write3MF([{ name: 'cube', mesh: makePrimitive('cube') }], 'Ma scène', { designer: '' }));
    expect(back).toEqual({ title: '', designer: '', copyright: '', licenseTerms: '', description: '' });
  });

  it('keeps an object transform in the build item and reads it back with the mesh in its own frame', () => {
    const t = [0, 1, 0, -2, 0, 0, 0, 0, 1, 5, -3, 7]; // 90° about Z, ×2 along the new X, moved
    const mesh = makePrimitive('cube');
    const back = read3MF(write3MF([{ name: 'c', mesh, transform: t }]))[0];
    expect(back.local!.transform).toEqual(t);
    expect(Array.from(back.local!.mesh.positions)).toEqual(Array.from(mesh.positions));
  });

  it('adds a thumbnail when given one', () => {
    const z = unzipSync(write3MF([{ name: 'c', mesh: makePrimitive('cube') }], '', undefined, new Uint8Array([137, 80, 78, 71])));
    expect(z['Metadata/thumbnail.png']).toBeDefined();
    expect(new TextDecoder().decode(z['_rels/.rels'])).toContain('metadata/thumbnail');
  });
});
