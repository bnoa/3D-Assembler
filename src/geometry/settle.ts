// "Lay flat" as 3D Builder's Settle: the object drops onto the plate and comes to rest under
// gravity. 3D Builder runs a rigid-body simulation (500 × 32 steps, then a snap when the last tilt
// is under 0.2 rad); 3D Assembler computes the same resting pose quasi-statically: the object sits on
// its lowest point and, as long as its centre of mass is not above the support (the contact
// points' hull), it tips about the support point or edge on the side the centre of mass leans to,
// until another point of its convex hull touches the plate. It settles on the face it leans
// towards, not necessarily the largest one.
import type { MeshData } from '../core/mesh-data';

type V = [number, number, number];

/** Volume centre of a closed mesh. */
export function centreOfMass(m: MeshData): V {
  const p = m.positions, t = m.indices;
  let vol = 0;
  const c: V = [0, 0, 0];
  for (let f = 0; f < t.length / 3; f++) {
    const a = t[f * 3] * 3, b = t[f * 3 + 1] * 3, d = t[f * 3 + 2] * 3;
    const v = (p[a] * (p[b + 1] * p[d + 2] - p[b + 2] * p[d + 1]) - p[a + 1] * (p[b] * p[d + 2] - p[b + 2] * p[d]) + p[a + 2] * (p[b] * p[d + 1] - p[b + 1] * p[d])) / 6;
    vol += v;
    for (let k = 0; k < 3; k++) c[k] += (v * (p[a + k] + p[b + k] + p[d + k])) / 4;
  }
  if (Math.abs(vol) < 1e-12) {
    // Not a solid: the vertex average.
    const n = p.length / 3;
    for (let i = 0; i < p.length; i++) c[i % 3] += p[i] / n;
    return c;
  }
  return [c[0] / vol, c[1] / vol, c[2] / vol];
}

/** Rotation by angle θ about the unit axis a (Rodrigues), as a 3 × 3 row-major matrix. */
function rot(a: V, th: number): number[] {
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  const [x, y, z] = a;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}
const mul = (A: number[], B: number[]) => Array.from({ length: 9 }, (_, i) => A[Math.floor(i / 3) * 3] * B[i % 3] + A[Math.floor(i / 3) * 3 + 1] * B[3 + (i % 3)] + A[Math.floor(i / 3) * 3 + 2] * B[6 + (i % 3)]);
const apply = (R: number[], v: V, o: V): V => {
  const x = v[0] - o[0], y = v[1] - o[1], z = v[2] - o[2];
  return [R[0] * x + R[1] * y + R[2] * z + o[0], R[3] * x + R[4] * y + R[5] * z + o[1], R[6] * x + R[7] * y + R[8] * z + o[2]];
};

/** 2D convex hull (counter-clockwise). */
function hull2(pts: [number, number][]): [number, number][] {
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [], hi: [number, number][] = [];
  for (const p of s) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = s.length - 1; i >= 0; i--) { const p = s[i]; while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}

/**
 * Resting rotation of a mesh (world coordinates) under gravity: a 3 × 3 rotation about `pivot`
 * (the centre of mass) to apply before dropping the object onto the plate.
 */
export function settleRotation(m: MeshData, hullPts: V[]): { R: number[]; pivot: V } {
  const com = centreOfMass(m);
  const size = Math.max(...[0, 1, 2].map((k) => Math.max(...hullPts.map((p) => p[k])) - Math.min(...hullPts.map((p) => p[k])))) || 1;
  const eps = size * 1e-6;
  let R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let iter = 0; iter < 200; iter++) {
    const pts = hullPts.map((p) => apply(R, p, com));
    const zmin = Math.min(...pts.map((p) => p[2]));
    const contact = pts.filter((p) => p[2] - zmin < eps * 10);
    const c2: [number, number] = [com[0], com[1]];
    const h = hull2(contact.map((p) => [p[0], p[1]]));
    // Support polygon and the edge (or point) the object tips about.
    let pivotPt: V, dir: [number, number];
    if (h.length >= 3) {
      // Inside the support polygon: at rest.
      let inside = true, worst = -Infinity, wi = 0;
      for (let i = 0; i < h.length; i++) {
        const a = h[i], b = h[(i + 1) % h.length];
        const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
        const out = -((c2[0] - a[0]) * ey - (c2[1] - a[1]) * ex) / l; // > 0 = outside this edge (ccw hull)
        if (out > eps) inside = false;
        if (out > worst) { worst = out; wi = i; }
      }
      if (inside) break;
      const a = h[wi], b = h[(wi + 1) % h.length];
      const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
      dir = [ey / l, -ex / l]; // outward normal of that edge
      pivotPt = [a[0], a[1], zmin];
    } else if (h.length === 2) {
      const [a, b] = h;
      const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
      let nx = ey / l, ny = -ex / l;
      const side = (c2[0] - a[0]) * nx + (c2[1] - a[1]) * ny;
      if (side < 0) { nx = -nx; ny = -ny; }
      dir = [nx, ny];
      pivotPt = [a[0], a[1], zmin];
    } else {
      const p0 = contact[0];
      const dx = c2[0] - p0[0], dy = c2[1] - p0[1], l = Math.hypot(dx, dy);
      if (l < eps) break; // balanced on one point exactly above the centre of mass
      dir = [dx / l, dy / l];
      pivotPt = p0;
    }
    // Tip towards `dir` about the horizontal axis perpendicular to it through the pivot, until the
    // next hull point reaches the plate: z(θ) = h cos θ − s sin θ = 0.
    const axis: V = [-dir[1], dir[0], 0];
    let best = Infinity;
    for (const q of pts) {
      const hgt = q[2] - pivotPt[2];
      const s = (q[0] - pivotPt[0]) * dir[0] + (q[1] - pivotPt[1]) * dir[1];
      if (s <= eps || hgt <= eps) continue;
      best = Math.min(best, Math.atan2(hgt, s));
    }
    if (!Number.isFinite(best) || best < 1e-9) break;
    // A turn of +θ about Z × dir lowers the points lying towards dir. The pivot only shifts the
    // object, and it is dropped back onto the plate at the next step.
    R = mul(rot(axis, best), R);
  }
  return { R, pivot: com };
}
