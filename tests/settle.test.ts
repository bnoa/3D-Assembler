import { describe, expect, it } from 'vitest';
import { centreOfMass, settleRotation } from '../src/geometry/settle';
import { makePrimitive } from '../src/geometry/primitives';
import { type MeshData, bounds, translated } from '../src/core/mesh-data';
import { analyzePrint } from '../src/analysis/printability';

const rotX = (m: MeshData, deg: number): MeshData => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const p = new Float32Array(m.positions.length);
  for (let i = 0; i < p.length; i += 3) { const y = m.positions[i + 1], z = m.positions[i + 2]; p[i] = m.positions[i]; p[i + 1] = c * y - s * z; p[i + 2] = s * y + c * z; }
  return { positions: p, indices: m.indices };
};
const hull = (m: MeshData) => { const out: [number, number, number][] = []; for (let i = 0; i < m.positions.length; i += 3) out.push([m.positions[i], m.positions[i + 1], m.positions[i + 2]]); return out; };
const apply = (m: MeshData, R: number[], o: number[]): MeshData => {
  const p = new Float32Array(m.positions.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = m.positions[i] - o[0], y = m.positions[i + 1] - o[1], z = m.positions[i + 2] - o[2];
    p[i] = R[0] * x + R[1] * y + R[2] * z; p[i + 1] = R[3] * x + R[4] * y + R[5] * z; p[i + 2] = R[6] * x + R[7] * y + R[8] * z;
  }
  return { positions: p, indices: m.indices };
};
const flatHeight = (m: MeshData) => { const b = bounds(m); return b.max[2] - b.min[2]; };

describe('lay flat (3D Builder Settle: comes to rest under gravity)', () => {
  it('a cube tilted by 20° falls back onto the face it rests on', () => {
    const c = rotX(makePrimitive('cube'), 20);
    const { R, pivot } = settleRotation(c, hull(c));
    expect(flatHeight(apply(c, R, pivot))).toBeCloseTo(40, 3);
  });

  it('a cube tilted by 60° rolls onto the neighbouring face', () => {
    const c = rotX(makePrimitive('cube'), 60);
    const { R, pivot } = settleRotation(c, hull(c));
    const out = apply(c, R, pivot);
    expect(flatHeight(out)).toBeCloseTo(40, 3);
  });

  it('a tall box leaning past its tipping point falls on its side', () => {
    const tall = { positions: makePrimitive('cube').positions.map((v, i) => (i % 3 === 2 ? v * 3 : v * 0.5)), indices: makePrimitive('cube').indices };
    const leaning = rotX(tall, 30); // 20 × 20 × 120: tips past ~9.5°
    const { R, pivot } = settleRotation(leaning, hull(leaning));
    expect(flatHeight(apply(leaning, R, pivot))).toBeCloseTo(20, 3);
    const upright = rotX(tall, 5); // within its base: stands up again
    const r2 = settleRotation(upright, hull(upright));
    expect(flatHeight(apply(upright, r2.R, r2.pivot))).toBeCloseTo(120, 3);
  });

  it('computes the centre of mass of a solid', () => {
    const c = centreOfMass(translated(makePrimitive('cube'), 5, -3, 7));
    expect(c[0]).toBeCloseTo(5, 4); expect(c[1]).toBeCloseTo(-3, 4); expect(c[2]).toBeCloseTo(7, 4);
  });
});

describe('print checks (3D Builder rules)', () => {
  it('overhang: face pointing down off the plate; the angle setting is honoured', () => {
    // A cube floating 10 mm above the plate: its bottom faces overhang, its sides do not.
    const c = translated(makePrimitive('cube'), 0, 0, 30);
    const r = analyzePrint(c, { overhangAngle: 45 });
    expect(r.overhangFaces.length).toBeGreaterThan(0);
    expect(r.floating).toBe(true);
    const onPlate = translated(makePrimitive('cube'), 0, 0, 20);
    expect(analyzePrint(onPlate).overhangFaces.length).toBe(0);
    expect(analyzePrint(onPlate).floating).toBe(false);
    // A face tilted 50° from vertical-down counts at 45° but not at 30°.
    const tilted = translated(rotX(makePrimitive('cube'), 40), 0, 0, 60);
    expect(analyzePrint(tilted, { overhangAngle: 45 }).overhangFaces.length).toBeGreaterThan(analyzePrint(tilted, { overhangAngle: 30 }).overhangFaces.length);
  });
});
