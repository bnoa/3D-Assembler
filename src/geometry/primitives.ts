// Closed, consistently oriented primitives, centred on the origin, in millimetres (Z up).
import { type MeshData, centered } from '../core/mesh-data';

export type PrimitiveKind =
  | 'cube' | 'cylinder' | 'pyramid' | 'cone' | 'sphere' | 'hexagon' | 'wedge' | 'torus' | 'tetrahedron';

export const PRIMITIVES: { kind: PrimitiveKind; label: string; icon: string }[] = [
  { kind: 'cube', label: 'Cube', icon: 'cube' },
  { kind: 'cylinder', label: 'Cylindre', icon: 'cylinder' },
  { kind: 'pyramid', label: 'Pyramide', icon: 'pyramid' },
  { kind: 'cone', label: 'Cône', icon: 'cone' },
  { kind: 'sphere', label: 'Sphère', icon: 'sphere' },
  { kind: 'hexagon', label: 'Hexagone', icon: 'hexagon' },
  { kind: 'wedge', label: 'Coin', icon: 'wedge' },
  { kind: 'torus', label: 'Tore', icon: 'torus' },
  { kind: 'tetrahedron', label: 'Tétraèdre', icon: 'tetrahedron' },
];

const S = 40; // default size

/**
 * Colour of each shape as 3D Builder inserts it (each primitive is a 3MF of the catalogue with its
 * own colour; measured, not copied).
 */
export const PRIMITIVE_COLORS: Record<PrimitiveKind, string> = {
  cube: '#21bb4c', sphere: '#21bb4c',
  cylinder: '#00a0e8', wedge: '#00a0e8', tetrahedron: '#00a0e8',
  hexagon: '#ff7f25', cone: '#ff7f25',
  pyramid: '#fef100', torus: '#fef100',
};

/**
 * The shapes of 3D Builder's catalogue, measured in its files (sizes in mm, tessellation):
 * cube 40; cylinder Ø40 × 40 in 120 sides; cone Ø40 × 40 in 96 sides; square pyramid 40 × 40;
 * hexagon 50 across flats, 15.49 high; wedge 40 × 40 with a ridge 20 high across the middle;
 * sphere Ø40 as an icosahedron subdivided 4 times (5,120 faces, poles on Z); torus R 25, r 10 in
 * 100 × 100; tetrahedron on an equilateral base of 49.5 (circumradius 200/7), 40 high. Flat caps
 * have no centre vertex.
 */
export function makePrimitive(kind: PrimitiveKind): MeshData {
  switch (kind) {
    case 'cube': return prism(regular(4, S / Math.SQRT2, Math.PI / 4), S);
    case 'cylinder': return prism(regular(120, S / 2), S);
    case 'hexagon': return prism(regular(6, 25 / Math.cos(Math.PI / 6)), 15.489);
    case 'pyramid': return pyramid(regular(4, S / Math.SQRT2, Math.PI / 4), S);
    case 'cone': return pyramid(regular(96, S / 2), S);
    case 'wedge': return wedge(S, S / 2);
    case 'sphere': return icosphere(S / 2, 4);
    case 'torus': return torus(25, 10, 100, 100);
    case 'tetrahedron': return pyramid(regular(3, 200 / 7), S);
  }
}

function regular(n: number, r: number, phase = 0): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

/** Triangles of a convex polygon (indices offset by `base`), zigzag strip without a centre vertex. */
function cap(n: number, base: number, up: boolean): number[] {
  const out: number[] = [];
  let lo = 0, hi = n - 1, fromLo = true;
  const tri = (a: number, b: number, c: number) => (up ? out.push(base + a, base + b, base + c) : out.push(base + a, base + c, base + b));
  // Fan start: (0, 1, n-1), then alternate advancing each side.
  while (hi - lo >= 2) {
    if (fromLo) { tri(lo, lo + 1, hi); lo++; }
    else { tri(lo, hi - 1, hi); hi--; }
    fromLo = !fromLo;
  }
  return out;
}

/** Extrudes a convex CCW polygon from z=0 to z=h. */
export function prism(poly: [number, number][], h: number): MeshData {
  const n = poly.length;
  const pos: number[] = [];
  for (const [x, y] of poly) pos.push(x, y, 0);
  for (const [x, y] of poly) pos.push(x, y, h);
  const idx: number[] = [...cap(n, 0, false), ...cap(n, n, true)];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    idx.push(i, j, n + j, i, n + j, n + i);
  }
  return centered({ positions: new Float32Array(pos), indices: new Uint32Array(idx) }).mesh;
}

/** Convex CCW base polygon at z=0 with an apex at (0, 0, h). */
export function pyramid(poly: [number, number][], h: number): MeshData {
  const n = poly.length;
  const pos: number[] = [];
  for (const [x, y] of poly) pos.push(x, y, 0);
  // Apex above the centroid of the base.
  const cx = poly.reduce((a, p) => a + p[0], 0) / n, cy = poly.reduce((a, p) => a + p[1], 0) / n;
  pos.push(cx, cy, h);
  const idx: number[] = cap(n, 0, false);
  for (let i = 0; i < n; i++) idx.push(i, (i + 1) % n, n);
  return centered({ positions: new Float32Array(pos), indices: new Uint32Array(idx) }).mesh;
}

/** Square base s × s with a horizontal ridge of height h along X, across the middle. */
function wedge(s: number, h: number): MeshData {
  const a = s / 2;
  const pos = new Float32Array([-a, -a, 0, a, -a, 0, a, a, 0, -a, a, 0, -a, 0, h, a, 0, h]);
  const idx = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom
    0, 1, 5, 0, 5, 4, // front slope
    3, 4, 5, 3, 5, 2, // back slope
    0, 4, 3, 1, 2, 5, // gable ends
  ]);
  return centered({ positions: pos, indices: idx }).mesh;
}

/** Icosahedron with poles on Z, each face split in 4 `levels` times, vertices pushed to the sphere. */
function icosphere(r: number, levels: number): MeshData {
  const pts: [number, number, number][] = [[0, 0, 1]];
  const lat = Math.atan(0.5);
  for (let k = 0; k < 5; k++) pts.push(dir(lat, (k * 2 * Math.PI) / 5 + Math.PI / 5));
  for (let k = 0; k < 5; k++) pts.push(dir(-lat, (k * 2 * Math.PI) / 5));
  pts.push([0, 0, -1]);
  let tris: number[] = [];
  for (let k = 0; k < 5; k++) {
    const u = 1 + k, u2 = 1 + ((k + 1) % 5), d = 6 + k, d2 = 6 + ((k + 1) % 5);
    tris.push(0, u, u2, u, d2, u2, u, d, d2, d, 11, d2);
  }
  for (let l = 0; l < levels; l++) {
    const mid = new Map<string, number>();
    const m = (a: number, b: number) => {
      const key = a < b ? a + ',' + b : b + ',' + a;
      let i = mid.get(key);
      if (i === undefined) {
        const p = [0, 1, 2].map((k) => pts[a][k] + pts[b][k]);
        const len = Math.hypot(p[0], p[1], p[2]);
        i = pts.push([p[0] / len, p[1] / len, p[2] / len]) - 1;
        mid.set(key, i);
      }
      return i;
    };
    const next: number[] = [];
    for (let f = 0; f < tris.length; f += 3) {
      const [a, b, c] = [tris[f], tris[f + 1], tris[f + 2]];
      const ab = m(a, b), bc = m(b, c), ca = m(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    tris = next;
  }
  const pos = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => { pos[i * 3] = p[0] * r; pos[i * 3 + 1] = p[1] * r; pos[i * 3 + 2] = p[2] * r; });
  return { positions: pos, indices: new Uint32Array(tris) };
}

function dir(lat: number, lon: number): [number, number, number] {
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

function torus(R: number, r: number, seg: number, tube: number): MeshData {
  const pos: number[] = [];
  for (let i = 0; i < seg; i++) {
    const u = (i / seg) * Math.PI * 2;
    for (let j = 0; j < tube; j++) {
      const v = (j / tube) * Math.PI * 2;
      const w = R + r * Math.cos(v);
      pos.push(w * Math.cos(u), w * Math.sin(u), r * Math.sin(v));
    }
  }
  const at = (i: number, j: number) => (i % seg) * tube + (j % tube);
  const idx: number[] = [];
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < tube; j++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      idx.push(a, b, c, a, c, d);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

