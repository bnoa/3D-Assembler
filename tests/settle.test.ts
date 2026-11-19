import { describe, expect, it } from 'vitest';
import { SETTLE_DT, SettleSim, centreOfMass, settleRotation } from '../src/geometry/settle';
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

describe('Positionner (3D Builder Place: live rigid-body simulation)', () => {
  const heightOf = (s: SettleSim, m: MeshData) => {
    const pts = hull(m).map((p) => { const R = s.R; return R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + s.t[2]; });
    return Math.max(...pts) - Math.min(...pts);
  };

  it('a cube resting on the plate does not move', () => {
    const c = makePrimitive('cube');
    const s = new SettleSim([c], hull(c));
    s.advance(1, 1000);
    expect(s.bottom()).toBeCloseTo(0, 1);
    expect(Math.abs(s.t[0]) + Math.abs(s.t[1])).toBeLessThan(0.05);
    expect(s.R[8]).toBeCloseTo(1, 4);
  });

  it('a tilted cube dropped from above falls and comes to rest on a face within a second', () => {
    const c = translated(rotX(makePrimitive('cube'), 25), 0, 0, 30);
    const s = new SettleSim([c], hull(c));
    s.t = [0, 0, 30 + s.t[2]];
    s.advance(1, Math.round(1 / SETTLE_DT));
    expect(heightOf(s, c)).toBeCloseTo(40, 0);
    expect(s.bottom()).toBeGreaterThan(-0.5);
  });

  it('held, the grab point follows the target and stops when it stops; released, it falls', () => {
    const c = makePrimitive('cube');
    const s = new SettleSim([c], hull(c));
    const top = Math.max(...hull(c).map((p) => p[2])) + s.t[2];
    s.grab([0, -20, top]); // front top edge
    s.pull([0, -20, top + 20]); // straight up first
    s.advance(0.04);
    for (let k = 1; k <= 10; k++) { s.pull([3 * k, -20, top + 20]); s.advance(0.04); }
    expect(Math.hypot(s.anchor[0] - 30, s.anchor[1] + 20, s.anchor[2] - top - 20)).toBeLessThan(0.5);
    const held = s.pose();
    s.advance(0.2);
    expect(Math.hypot(...s.t.map((x, i) => x - held.t[i]))).toBeLessThan(1e-3);
    expect(s.bottom()).toBeGreaterThan(1);
    s.release();
    s.advance(1, Math.round(1 / SETTLE_DT));
    expect(s.bottom()).toBeCloseTo(0, 0);
    expect(heightOf(s, c)).toBeCloseTo(40, 0);
    expect(s.centre()[0]).toBeGreaterThan(5); // where it was dropped, not back home
  });
});
