import { describe, expect, it } from 'vitest';
import { CUSTOM_SHAPES, makeCustom } from '../src/geometry/custom';
import { analyze } from '../src/repair/analyze';
import { bounds, signedVolume } from '../src/core/mesh-data';

const defaults = (id: string) => Object.fromEntries(CUSTOM_SHAPES.find((s) => s.id === id)!.params.map((p) => [p.key, p.value]));
const size = (m: ReturnType<typeof makeCustom>) => { const b = bounds(m); return b.max.map((v, i) => v - b.min[i]); };

describe('custom shapes (3D Builder "Personnalisé")', () => {
  it.each(CUSTOM_SHAPES.map((s) => s.id))('%s with its defaults is a valid solid', (id) => {
    const r = analyze(makeCustom(id, defaults(id)));
    expect(r.ok).toBe(true);
  });

  it('vertex counts follow 3D Builder', () => {
    const v = (id: Parameters<typeof makeCustom>[0], p: Record<string, number>) => makeCustom(id, { ...defaults(id), ...p }).positions.length / 3;
    expect(v('cube', {})).toBe(4 * 10 * 11 + 2 * 81);
    expect(v('cube', { lon: 7, lat: 3 })).toBe(4 * 7 * 4 + 2 * 36);
    expect(v('sphere', { lat: 7, lon: 9 })).toBe(9 * 6 + 2);
    expect(v('cone', { lat: 5, lon: 12, div: 3 })).toBe(12 * (5 + 3 - 1) + 2);
    expect(v('cylinder', { lat: 5, lon: 12, div: 3 })).toBe(12 * (5 + 1 + 4) + 2);
    expect(v('torus', { lat: 8, lon: 12 })).toBe(96);
  });

  it('a rounded cube keeps its size (Minkowski rounding, 2.54 mm per level)', () => {
    for (const round of [1, 2, 5]) for (const lat of [1, 4]) for (const lon of [1, 2, 5]) {
      const m = makeCustom('cube', { lat, lon, w: 40, h: 40, round });
      const r = analyze(m);
      expect(r.ok, `round ${round} lat ${lat} lon ${lon}`).toBe(true);
      size(m).forEach((s) => expect(s).toBeCloseTo(40, 3));
    }
    // More rounding, less volume; level 5 = radius 12.7 mm.
    const v = (round: number) => signedVolume(makeCustom('cube', { lat: 10, lon: 10, w: 40, h: 40, round }));
    expect(v(5)).toBeLessThan(v(1));
    expect(v(0)).toBeCloseTo(64000, 0);
  });

  it('torus: Rayon is the outer radius, Rayon interne the hole', () => {
    const s = size(makeCustom('torus', { lat: 24, lon: 48, r: 20, ri: 10 }));
    expect(s[0]).toBeCloseTo(40, 3);
    expect(s[2]).toBeCloseTo(10, 1);
  });

  it('cone and cylinder sizes; Longitude 4 keeps its Division rings', () => {
    expect(size(makeCustom('cylinder', defaults('cylinder')))[2]).toBeCloseTo(40, 4);
    const m = makeCustom('cylinder', { lat: 2, lon: 4, div: 3, r: 20, h: 40 });
    expect(analyze(m).ok).toBe(true);
    expect(m.positions.length / 3).toBe(4 * (2 + 1 + 4) + 2);
  });
});
