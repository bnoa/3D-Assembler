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

// ---------------------------------------------------------------------------------------------
// Positionner (Place): the live rigid-body simulation 3D Builder runs while the tool is open.
//
// All the selected objects form one rigid body of unit mass (volume centroid, volume inertia).
// The simulation advances in substeps of 1.25 ms, 32 per 40 ms, i.e. in real time:
// - gravity takes 2 % of the selection's bounding-box diagonal off the vertical speed each substep;
// - every hull point at or below the plate gives a contact (one normal row, two friction rows)
//   solved by projected Gauss-Seidel (friction 1.5 at rest, 0 while held; up to 50 sweeps);
// - while held, the body is driven kinematically by the grab point: each substep it turns about its
//   centre so that the lever centre -> grab point points at the target, and slides along that
//   lever, closing the gap at once (at most 20 % of the diagonal per substep). It therefore follows
//   the cursor and stops when the cursor stops. Touching the plate, it only slides (no turn);
// - once released it falls under gravity and comes to rest where it was dropped.
// ---------------------------------------------------------------------------------------------

/** Substep of the simulation in seconds (32 substeps per 40 ms tick). */
export const SETTLE_DT = 0.04 / 32;
const FRICTION = 1.5;
const MAX_SWEEPS = 50;
const SWEEP_TOL = 5e-5;
const DIVERGED = 1000;
const ANGLE_MIN = 0.001;
const SPIN_DAMP = 0.95;
const STILL = 1e-5;
const SINK_FIX = 0.25;

const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crs = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const mv = (M: number[], a: V): V => [M[0] * a[0] + M[1] * a[1] + M[2] * a[2], M[3] * a[0] + M[4] * a[1] + M[5] * a[2], M[6] * a[0] + M[7] * a[1] + M[8] * a[2]];
const tr = (M: number[]) => [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];
function inv3(M: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = M;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-30)) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** Volume centroid and inertia tensor per unit mass about it, of several closed meshes together. */
export function massProperties(meshes: MeshData[], pts: V[]): { com: V; inertia: number[] } {
  let vol = 0;
  const m1: V = [0, 0, 0];
  const m2 = [0, 0, 0, 0, 0, 0]; // integrals of xx, yy, zz, xy, yz, zx
  const sq = (u: number, v: number, w: number) => u * u + v * v + w * w + u * v + u * w + v * w;
  const pr = (u: V, v: V) => 2 * (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) + u[0] * v[1] + u[1] * v[0] + u[0] * v[2] + u[2] * v[0] + u[1] * v[2] + u[2] * v[1];
  for (const m of meshes) {
    const p = m.positions, t = m.indices;
    for (let f = 0; f < t.length; f += 3) {
      const a = t[f] * 3, b = t[f + 1] * 3, c = t[f + 2] * 3;
      const ax = p[a], ay = p[a + 1], az = p[a + 2], bx = p[b], by = p[b + 1], bz = p[b + 2], cx = p[c], cy = p[c + 1], cz = p[c + 2];
      const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
      vol += det / 6;
      m1[0] += (det * (ax + bx + cx)) / 24; m1[1] += (det * (ay + by + cy)) / 24; m1[2] += (det * (az + bz + cz)) / 24;
      m2[0] += (det * sq(ax, bx, cx)) / 60; m2[1] += (det * sq(ay, by, cy)) / 60; m2[2] += (det * sq(az, bz, cz)) / 60;
      m2[3] += (det * pr([ax, bx, cx], [ay, by, cy])) / 120;
      m2[4] += (det * pr([ay, by, cy], [az, bz, cz])) / 120;
      m2[5] += (det * pr([az, bz, cz], [ax, bx, cx])) / 120;
    }
  }
  const lo: V = [Infinity, Infinity, Infinity], hi: V = [-Infinity, -Infinity, -Infinity];
  for (const q of pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
  const size = len(sub(hi, lo)) || 1;
  if (Math.abs(vol) > 1e-9 * size ** 3) {
    const c: V = [m1[0] / vol, m1[1] / vol, m1[2] / vol];
    const xx = m2[0] / vol - c[0] * c[0], yy = m2[1] / vol - c[1] * c[1], zz = m2[2] / vol - c[2] * c[2];
    const xy = m2[3] / vol - c[0] * c[1], yz = m2[4] / vol - c[1] * c[2], zx = m2[5] / vol - c[2] * c[0];
    const I = [yy + zz, -xy, -zx, -xy, xx + zz, -yz, -zx, -yz, xx + yy];
    if (I[0] > 0 && I[4] > 0 && I[8] > 0 && inv3(I)) return { com: c, inertia: I };
  }
  // Not a solid: a uniform box over the points.
  const c: V = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const e = sub(hi, lo).map((x) => Math.max(x, size * 1e-3));
  return { com: c, inertia: [(e[1] ** 2 + e[2] ** 2) / 12, 0, 0, 0, (e[0] ** 2 + e[2] ** 2) / 12, 0, 0, 0, (e[0] ** 2 + e[1] ** 2) / 12] };
}

/** Pose of the simulated body: world = R · p + t, for points given in the starting world frame. */
export type SettlePose = { R: number[]; t: V };

type Row = { J: number[]; MJ: number[]; m: number; jv: number; lam: number };

export class SettleSim {
  /** Diagonal of the selection's bounding box: the scale of gravity and of the pull. */
  readonly size: number;
  R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  t: V = [0, 0, 0];
  v: V = [0, 0, 0];
  w: V = [0, 0, 0];
  /** Held by the pointer, with the grab point (moving with the body) and where it is pulled to. */
  held = false;
  anchor: V = [0, 0, 0];
  target: V = [0, 0, 0];
  /** Set when the last substep moved nothing noticeable. */
  resting = false;
  private readonly pts: V[];
  private readonly com0: V;
  private readonly invI0: number[];

  /** `meshes` and `hull` in world coordinates; the selection is first set down onto the plate. */
  constructor(meshes: MeshData[], hull: V[]) {
    this.pts = hull.map((p) => [p[0], p[1], p[2]] as V);
    const { com, inertia } = massProperties(meshes, this.pts);
    this.com0 = com;
    this.invI0 = inv3(inertia)!;
    const lo: V = [Infinity, Infinity, Infinity], hi: V = [-Infinity, -Infinity, -Infinity];
    for (const q of this.pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
    this.size = len(sub(hi, lo)) || 1;
    this.t = [0, 0, Number.isFinite(lo[2]) ? -lo[2] : 0];
  }

  /** World centre of mass. */
  centre(): V { return this.world(this.com0); }
  private world(p: V): V { const q = mv(this.R, p); return [q[0] + this.t[0], q[1] + this.t[1], q[2] + this.t[2]]; }

  /** The pose as a column-major 4 × 4 matrix (three.js `Matrix4.elements`). */
  matrix(): number[] {
    const R = this.R, t = this.t;
    return [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, t[0], t[1], t[2], 1];
  }
  pose(): SettlePose { return { R: [...this.R], t: [...this.t] }; }
  /** Puts the body at a pose, motionless (undo / redo of a drop). */
  setPose(p: SettlePose): void {
    this.R = [...p.R]; this.t = [...p.t];
    this.v = [0, 0, 0]; this.w = [0, 0, 0];
    this.held = false; this.resting = false;
  }
  /** Lowest point of the body. */
  bottom(): number { let z = Infinity; for (const p of this.pts) z = Math.min(z, this.world(p)[2]); return z; }

  /** Takes hold of the body at a world point of its surface. */
  grab(p: V): void {
    this.anchor = [p[0], p[1], Math.max(0, p[2])];
    this.target = [...this.anchor];
    this.held = true;
    this.resting = false;
  }
  /** Moves the point the grab point is pulled to (never under the plate). */
  pull(p: V): void { this.target = [p[0], p[1], Math.max(0, p[2])]; this.resting = false; }
  release(): void { this.held = false; this.resting = false; }

  /** One substep. */
  step(): void {
    const dt = SETTLE_DT, D = this.size;
    const sleep = Math.min(0.5 * (0.02 * D) ** 2, STILL);
    this.v[2] -= 0.02 * D;
    // Contacts with the plate, measured with the velocities before the pull.
    const c = this.centre();
    const Iw = mul(mul(this.R, this.invI0), tr(this.R));
    const rows: Row[] = [];
    // As 3D Builder does, the points only count once the body is strictly under the plate (in
    // single precision; `eps` stands for that rounding): a body lying exactly on it has no contact.
    const eps = 1e-6 * D;
    const wp = this.pts.map((p) => this.world(p));
    const sunk = wp.some((p) => p[2] < -eps);
    for (const p of sunk ? wp : []) {
      if (p[2] > 0) continue;
      const r = sub(p, c);
      for (const n of [[0, 0, 1], [1, 0, 0], [0, 1, 0]] as V[]) {
        const rn = crs(r, n), Irn = mv(Iw, rn);
        const k = dot(n, n) + dot(rn, Irn);
        rows.push({ J: [...n, ...rn], MJ: [...n, ...Irn], m: Math.abs(k) > 0 ? 1 / k : k, jv: dot(n, this.v) + dot(rn, this.w), lam: 0 });
      }
    }
    let mu = FRICTION;
    if (this.held) {
      mu = 0;
      let d = sub(this.target, this.anchor);
      const dl = len(d);
      if (dl > 0.2 * D) d = [(d[0] / dl) * 0.2 * D, (d[1] / dl) * 0.2 * D, (d[2] / dl) * 0.2 * D];
      const r = sub(this.anchor, c), rl = len(r);
      const rh: V = rl > 0 ? [r[0] / rl, r[1] / rl, r[2] / rl] : [0, 0, 0];
      const along = dot(rh, d) / dt;
      this.v = [along * rh[0], along * rh[1], along * rh[2]];
      let spin: V = [0, 0, 0];
      const r2: V = [r[0] + d[0], r[1] + d[1], r[2] + d[2]];
      const l2 = len(r2);
      if (rl > 0 && l2 > 0) {
        const ang = Math.acos(Math.max(-1, Math.min(1, dot(r, r2) / (rl * l2))));
        const ax = crs(r, r2), al = len(ax);
        if (ang > ANGLE_MIN && al > 0) spin = [(ax[0] / al) * (ang / dt), (ax[1] / al) * (ang / dt), (ax[2] / al) * (ang / dt)];
      }
      if (rows.length) { if (this.v[2] < 0) this.v[2] = 0; this.w = [0, 0, 0]; } else this.w = spin;
    }
    if (rows.length) {
      const dv = [0, 0, 0, 0, 0, 0];
      let sweeps = 0, moved: boolean, last = 0;
      do {
        moved = false;
        for (let i = 0; i < rows.length; i++) {
          const q = rows[i], old = q.lam;
          let lam = old - (q.J[0] * dv[0] + q.J[1] * dv[1] + q.J[2] * dv[2] + q.J[3] * dv[3] + q.J[4] * dv[4] + q.J[5] * dv[5] + q.jv) * q.m;
          if (i % 3) {
            const b = Math.abs(rows[i - (i % 3)].lam * mu);
            lam = Math.max(-b, Math.min(b, lam));
          }
          q.lam = lam;
          last = lam - old;
          for (let k = 0; k < 6; k++) dv[k] += last * q.MJ[k];
          if (Math.abs(last) > SWEEP_TOL) moved = true;
        }
        sweeps++;
      } while (!this.held && moved && sweeps < MAX_SWEEPS);
      if (Math.abs(last) <= DIVERGED) {
        for (let k = 0; k < 3; k++) { this.v[k] += dv[k]; this.w[k] += dv[k + 3]; }
        if (dv[3] ** 2 + dv[4] ** 2 + dv[5] ** 2 < SWEEP_TOL) this.w = [this.w[0] * SPIN_DAMP, this.w[1] * SPIN_DAMP, this.w[2] * SPIN_DAMP];
      } else {
        this.v = [0, 0, 0]; this.w = [0, 0, 0];
      }
    }
    // Integration: a turn about the centre of mass, then the move.
    if (dot(this.v, this.v) + dot(this.w, this.w) < sleep) { this.v = [0, 0, 0]; this.w = [0, 0, 0]; }
    const wl = len(this.w);
    let Ri = [1, 0, 0, 0, 1, 0, 0, 0, 1], turn = wl;
    if (wl > STILL) { turn = wl * dt; Ri = rot([this.w[0] / wl, this.w[1] / wl, this.w[2] / wl], turn); }
    const rc = mv(Ri, c);
    const ti: V = [this.v[0] * dt + c[0] - rc[0], this.v[1] * dt + c[1] - rc[1], this.v[2] * dt + c[2] - rc[2]];
    this.R = mul(Ri, this.R);
    const nt = mv(Ri, this.t);
    this.t = [nt[0] + ti[0], nt[1] + ti[1], nt[2] + ti[2]];
    if (this.held) { const a = mv(Ri, this.anchor); this.anchor = [a[0] + ti[0], a[1] + ti[1], a[2] + ti[2]]; }
    this.resting = turn < STILL && len(ti) < SWEEP_TOL;
    // Back out of the plate, a quarter of the depth per substep.
    if (rows.length && !this.held) {
      const z = Math.min(0, this.bottom());
      if (z < -1e-6 * D) { this.t[2] -= SINK_FIX * z; if (-SINK_FIX * z >= SWEEP_TOL) this.resting = false; }
    }
  }

  /** Runs the substeps covering `seconds` of real time (at most `maxSteps`); returns how many ran. */
  advance(seconds: number, maxSteps = 32 * 4): number {
    const n = Math.min(maxSteps, Math.max(0, Math.round(seconds / SETTLE_DT)));
    for (let i = 0; i < n; i++) this.step();
    return n;
  }
}
