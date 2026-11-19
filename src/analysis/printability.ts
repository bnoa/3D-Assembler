// Print-readiness checks, matching the warnings found in 3D Builder: steep overhangs, floating
// objects, narrow base, object larger than the print bed, thin walls.
import { type MeshData, bounds, triArea } from '../core/mesh-data';

export interface Bed { x: number; y: number; z: number }
export const DEFAULT_BED: Bed = { x: 250, y: 210, z: 210 };

export interface PrintReport {
  overhangFaces: number[]; // face indices facing down steeper than the limit, off the plate
  overhangArea: number; // mm²
  contactArea: number; // mm² of faces lying on the plate
  floating: boolean; // lowest point above the plate
  narrowBase: boolean; // small contact compared with the object's footprint and height
  fitsBed: boolean;
  size: [number, number, number];
  thinFaces: number[]; // faces where the wall is thinner than the minimum
  minThickness: number; // thinnest wall measured (mm), Infinity if none found
}

export interface PrintOptions {
  overhangAngle: number; // degrees from vertical: faces flatter than this, facing down, need support
  minWall: number; // mm
  bed: Bed;
}

// minWall: 3D Builder takes the material's minimum wall, or 0.25 without a printer (High 0.1,
// Medium 0.2, Draft 0.3 by print quality).
export const DEFAULT_PRINT: PrintOptions = { overhangAngle: 45, minWall: 0.25, bed: DEFAULT_BED };

export function analyzePrint(m: MeshData, opts: Partial<PrintOptions> = {}): PrintReport {
  const o = { ...DEFAULT_PRINT, ...opts };
  const b = bounds(m);
  const p = m.positions, t = m.indices;
  const nt = t.length / 3;
  // 3D Builder's print checks (CLocalSupportsScreen): the plate is z = 0, a face is an overhang
  // when n·z < −cos(angle), it is not degenerate (|cross|² > 1e-8) and at least one corner is off
  // the plate (|z| > 0.005). 3D Builder always uses about 45° and its "Overhang Degree"
  // slider has no effect; 3D Assembler applies the chosen angle (45° by default). 3D Builder also stops
  // at the first overhanging face; 3D Assembler lists them all (and their area).
  const limit = -Math.cos((o.overhangAngle * Math.PI) / 180);
  const overhangFaces: number[] = [];
  let overhangArea = 0, contactArea = 0;
  for (let f = 0; f < nt; f++) {
    const a = t[f * 3], bb = t[f * 3 + 1], c = t[f * 3 + 2];
    const area = triArea(p, a, bb, c);
    if ((2 * area) ** 2 <= 1e-8) continue;
    const n = normal(p, a, bb, c);
    const zs = [p[a * 3 + 2], p[bb * 3 + 2], p[c * 3 + 2]];
    const offPlate = zs.some((z) => Math.abs(z) > 0.005);
    if (!offPlate && n[2] < -0.99) {
      contactArea += area;
      continue;
    }
    if (n[2] < limit && offPlate) {
      overhangFaces.push(f);
      overhangArea += area;
    }
  }
  const size: [number, number, number] = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const footprint = size[0] * size[1];
  const thin = thinWalls(m, o.minWall);
  return {
    overhangFaces,
    overhangArea,
    contactArea,
    floating: b.min[2] - 0.005 > 0, // as 3D Builder
    // 3D Assembler only (3D Builder just advises a raft): little contact under a tall object.
    narrowBase: contactArea < Math.max(4, footprint * 0.05) && size[2] > Math.sqrt(Math.max(contactArea, 1)) * 3,
    fitsBed: size[0] <= o.bed.x && size[1] <= o.bed.y && size[2] <= o.bed.z,
    size,
    thinFaces: thin.faces,
    minThickness: thin.min,
  };
}

function normal(p: Float32Array, a: number, b: number, c: number): [number, number, number] {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/**
 * Wall thickness as 3D Builder measures it: from each face centre a ray goes inwards (against the
 * normal) as far as `minWall`; the wall there is as thick as the distance to the opposite surface,
 * and the face is thin below minWall − 0.001. Three 3D Builder oversights are corrected: it keeps
 * the first hit found rather than the nearest (3D Assembler: nearest), counts surfaces hit from either
 * side (3D Assembler: only the opposite wall, whose outside faces along the ray), and ignores every face
 * sharing a vertex with the source (3D Assembler: only hits at the start point), which missed thin
 * wedges at corners.
 */
export function thinWalls(m: MeshData, minWall: number): { faces: number[]; min: number } {
  const p = m.positions, t = m.indices;
  const nt = t.length / 3;
  const reach = minWall;
  const cell = Math.max(reach, 0.5);
  const grid = new Map<number, number[]>();
  const K = 1 << 16; // ±65536 cells per axis, key < 2^51 (exact in a double)
  const key = (x: number, y: number, z: number) => ((x + K) * 2 * K + (y + K)) * 2 * K + (z + K);
  for (let f = 0; f < nt; f++) {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) {
      const v = t[f * 3 + k];
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], p[v * 3 + a]);
        hi[a] = Math.max(hi[a], p[v * 3 + a]);
      }
    }
    lo = lo.map((x) => Math.floor(x / cell));
    hi = hi.map((x) => Math.floor(x / cell));
    if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 50000) continue; // giant face: ignore
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const kk = key(x, y, z);
      const l = grid.get(kk);
      if (l) l.push(f);
      else grid.set(kk, [f]);
    }
  }
  const faces: number[] = [];
  let min = Infinity;
  const stamp = new Int32Array(nt).fill(-1);
  for (let f = 0; f < nt; f++) {
    const a = t[f * 3], b = t[f * 3 + 1], c = t[f * 3 + 2];
    const n = normal(p, a, b, c);
    const o = [0, 1, 2].map((k) => (p[a * 3 + k] + p[b * 3 + k] + p[c * 3 + k]) / 3 - n[k] * 1e-4);
    const d = [-n[0], -n[1], -n[2]];
    // Cells along the short ray (sampled every half cell).
    let best = Infinity;
    const steps = Math.ceil(reach / (cell / 2)) + 1;
    for (let s = 0; s <= steps; s++) {
      const q = [0, 1, 2].map((k) => o[k] + d[k] * Math.min(reach, (s * cell) / 2));
      const l = grid.get(key(Math.floor(q[0] / cell), Math.floor(q[1] / cell), Math.floor(q[2] / cell)));
      if (!l) continue;
      for (const g of l) {
        if (g === f || stamp[g] === f) continue;
        stamp[g] = f;
        const hit = rayTri(o, d, p, t[g * 3], t[g * 3 + 1], t[g * 3 + 2]);
        if (!(hit > 1e-6 && hit <= reach && hit < best)) continue;
        // The opposite wall: the ray leaves the material through it (its normal along the ray).
        const ng = normal(p, t[g * 3], t[g * 3 + 1], t[g * 3 + 2]);
        if (ng[0] * d[0] + ng[1] * d[1] + ng[2] * d[2] > 0) best = hit;
      }
    }
    if (best < min) min = best;
    if (best < minWall - 0.001) faces.push(f);
  }
  return { faces, min };
}

function rayTri(o: number[], d: number[], p: Float32Array, a: number, b: number, c: number): number {
  const e1 = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
  const e2 = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]];
  const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const s = [o[0] - p[a * 3], o[1] - p[a * 3 + 1], o[2] - p[a * 3 + 2]];
  const u = inv * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
  if (u < 0 || u > 1) return -1;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = inv * (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]);
  if (v < 0 || u + v > 1) return -1;
  return inv * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]);
}

/** Sub-mesh made of the given faces (for highlighting). */
export function facesSubset(m: MeshData, faces: number[]): MeshData {
  const idx = new Uint32Array(faces.length * 3);
  faces.forEach((f, i) => idx.set(m.indices.subarray(f * 3, f * 3 + 3), i * 3));
  return { positions: m.positions, indices: idx };
}
