// Plain indexed triangle mesh used by every geometry operation (repair, booleans, I/O).
// Kept independent of three.js so it can run in workers and tests.

export interface MeshData {
  positions: Float32Array; // xyz per vertex
  indices: Uint32Array; // 3 per triangle, counter-clockwise seen from outside
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export const triCount = (m: MeshData) => m.indices.length / 3;
export const vertCount = (m: MeshData) => m.positions.length / 3;

export function bounds(m: MeshData): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  return { min, max };
}

export function size(b: Bounds): [number, number, number] {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

export function center(b: Bounds): [number, number, number] {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

export function translated(m: MeshData, dx: number, dy: number, dz: number): MeshData {
  const p = new Float32Array(m.positions);
  for (let i = 0; i < p.length; i += 3) {
    p[i] += dx;
    p[i + 1] += dy;
    p[i + 2] += dz;
  }
  return { positions: p, indices: m.indices };
}

/** Applies a column-major 4x4 matrix (three.js Matrix4.elements). Flips winding on mirroring. */
export function transformed(m: MeshData, e: ArrayLike<number>): MeshData {
  const src = m.positions;
  const p = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    p[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    p[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    p[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  const det =
    e[0] * (e[5] * e[10] - e[9] * e[6]) - e[4] * (e[1] * e[10] - e[9] * e[2]) + e[8] * (e[1] * e[6] - e[5] * e[2]);
  return { positions: p, indices: det < 0 ? flipped(m.indices) : m.indices };
}

export function flipped(idx: Uint32Array): Uint32Array {
  const out = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i += 3) {
    out[i] = idx[i];
    out[i + 1] = idx[i + 2];
    out[i + 2] = idx[i + 1];
  }
  return out;
}

export function merged(meshes: MeshData[]): MeshData {
  let nv = 0, ni = 0;
  for (const m of meshes) {
    nv += m.positions.length;
    ni += m.indices.length;
  }
  const positions = new Float32Array(nv);
  const indices = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const m of meshes) {
    positions.set(m.positions, vo);
    const base = vo / 3;
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + base;
    vo += m.positions.length;
    io += m.indices.length;
  }
  return { positions, indices };
}

/** Moves the mesh so its bounding-box centre is at the origin; returns the old centre. */
export function centered(m: MeshData): { mesh: MeshData; offset: [number, number, number] } {
  const c = center(bounds(m));
  return { mesh: translated(m, -c[0], -c[1], -c[2]), offset: c };
}

/** Builds an indexed mesh from triangle soup, merging vertices closer than `tolerance`. */
export function fromTriangleSoup(soup: ArrayLike<number>, tolerance = 0): MeshData {
  const n = soup.length / 3;
  const map = new Map<string, number>();
  const pos: number[] = [];
  const indices = new Uint32Array(n);
  const q = tolerance > 0 ? 1 / tolerance : 1e5;
  for (let i = 0; i < n; i++) {
    const x = soup[i * 3], y = soup[i * 3 + 1], z = soup[i * 3 + 2];
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = pos.length / 3;
      map.set(key, id);
      pos.push(x, y, z);
    }
    indices[i] = id;
  }
  return { positions: new Float32Array(pos), indices };
}

export function cloneMesh(m: MeshData): MeshData {
  return { positions: new Float32Array(m.positions), indices: new Uint32Array(m.indices) };
}

/** Signed volume (positive when triangles face outward). */
export function signedVolume(m: MeshData): number {
  const p = m.positions, t = m.indices;
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

export function surfaceArea(m: MeshData): number {
  const p = m.positions, t = m.indices;
  let s = 0;
  for (let i = 0; i < t.length; i += 3) s += triArea(p, t[i], t[i + 1], t[i + 2]);
  return s;
}

export function triArea(p: Float32Array, a: number, b: number, c: number): number {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
}
