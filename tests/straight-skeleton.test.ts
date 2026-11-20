import { describe, expect, it } from 'vitest';
import { type Skeleton, straightSkeleton } from '../src/geometry/straight-skeleton';

type P = [number, number];
const inside = (q: P, poly: P[]) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
};
/** Roof height at q: the plane of the face holding it. */
const height = (sk: Skeleton, q: P) => {
  for (const f of sk.polygons) {
    const vs = f.map((i) => sk.vertices[i]);
    if (!inside(q, vs.map((v) => [v[0], v[1]] as P))) continue;
    const [p0, p1, p2] = [vs[0], vs[1], vs.find((v) => v[2] > 0)!];
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uh = p1[2] - p0[2], vx = p2[0] - p0[0], vy = p2[1] - p0[1], vh = p2[2] - p0[2];
    const det = ux * vy - uy * vx;
    const a = (uh * vy - uy * vh) / det, b = (ux * vh - uh * vx) / det;
    return a * (q[0] - p0[0]) + b * (q[1] - p0[1]) + p0[2];
  }
  return NaN;
};
const close = (r: P[]) => [...r, r[0]];

describe('straight skeleton (bevel roof)', () => {
  it('square: a pyramid, one face per edge, top at the centre', () => {
    const sk = straightSkeleton([close([[0, 0], [10, 0], [10, 10], [0, 10]])])!;
    expect(sk.polygons).toHaveLength(4);
    expect(height(sk, [5, 5.001])).toBeCloseTo(4.999, 6);
    expect(height(sk, [2, 5])).toBeCloseTo(2, 6);
  });

  it('rectangle: a ridge at half the width', () => {
    const sk = straightSkeleton([close([[0, 0], [100, 0], [100, 40], [0, 40]])])!;
    expect(Math.max(...sk.vertices.map((v) => v[2]))).toBeCloseTo(20, 9);
    expect(height(sk, [50, 30])).toBeCloseTo(10, 6);
  });

  it('L shape (a reflex corner): height = distance to the nearest edge inside each arm', () => {
    const sk = straightSkeleton([close([[0, 0], [60, 0], [60, 20], [20, 20], [20, 80], [0, 80]])])!;
    expect(sk.polygons).toHaveLength(6);
    expect(height(sk, [45, 5])).toBeCloseTo(5, 6);
    expect(height(sk, [12, 60])).toBeCloseTo(8, 6);
  });

  it('square with a square hole (split events against the hole): a ring roof', () => {
    const sk = straightSkeleton([close([[0, 0], [100, 0], [100, 100], [0, 100]]), close([[30, 30], [30, 70], [70, 70], [70, 30]])])!;
    expect(sk.polygons).toHaveLength(8);
    expect(Math.max(...sk.vertices.map((v) => v[2]))).toBeCloseTo(15, 9);
    expect(height(sk, [50, 10])).toBeCloseTo(10, 6);
    expect(height(sk, [50, 25])).toBeCloseTo(5, 6);
  });

  it('comb (several split events)', () => {
    const sk = straightSkeleton([close([[0, 0], [100, 0], [100, 60], [85, 60], [85, 20], [70, 20], [70, 60], [55, 60], [55, 20], [40, 20], [40, 60], [25, 60], [25, 20], [10, 20], [10, 60], [0, 60]])])!;
    expect(sk.polygons).toHaveLength(16);
    expect(height(sk, [5, 40])).toBeCloseTo(5, 6);
    expect(height(sk, [50, 5])).toBeCloseTo(5, 6);
  });
});
