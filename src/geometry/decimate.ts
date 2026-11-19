// Cleanup decimation with a maximum deviation (the final step of 3D Builder's emboss). The
// Simplify tool's face reduction is in reduce-faces.ts.
import type { MeshData } from '../core/mesh-data';

/**
 * Cleanup decimation with a maximum deviation, as 3D Builder runs after an emboss: a vertex is
 * merged into a neighbour when the surface around it moves by at most `maxDev`, no face flips,
 * the surface keeps its topology, and every face around it has the same colour. Border vertices
 * stay. Face colours follow their faces.
 */
export function simplifyFlat(input: MeshData, maxDev: number, faceColors?: Uint32Array): { mesh: MeshData; faceColors?: Uint32Array } {
  const nv = input.positions.length / 3;
  const nt = input.indices.length / 3;
  const pos = Float64Array.from(input.positions);
  const tris = Int32Array.from(input.indices);
  const alive = new Uint8Array(nt).fill(1);
  const vFaces: Set<number>[] = Array.from({ length: nv }, () => new Set());
  for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) vFaces[tris[f * 3 + k]].add(f);
  const border = new Uint8Array(nv);
  {
    const count = new Map<string, number>();
    for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) {
      const a = tris[f * 3 + k], b = tris[f * 3 + ((k + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
    for (const [key, c] of count) if (c !== 2) for (const s of key.split(',')) border[+s] = 1;
  }
  // No collapse may leave a sliver (twice the area under 1e-10 × diagonal²).
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) { lo[i % 3] = Math.min(lo[i % 3], pos[i]); hi[i % 3] = Math.max(hi[i % 3], pos[i]); }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const minArea2 = diag * diag * 1e-10;
  const normal = (a: number, b: number, c: number): [number, number, number, number] => {
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const n: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    return [...n, Math.hypot(...n)];
  };
  const nbr = (x: number) => {
    const s = new Set<number>();
    for (const f of vFaces[x]) for (let k = 0; k < 3; k++) s.add(tris[f * 3 + k]);
    s.delete(x);
    return s;
  };
  const tryCollapse = (v: number, u: number): boolean => {
    const shared = [...vFaces[v]].filter((f) => vFaces[u].has(f));
    if (shared.length !== 2) return false;
    const nu = nbr(u);
    let common = 0;
    for (const x of nbr(v)) if (x !== u && nu.has(x)) common++;
    if (common !== 2) return false;
    for (const f of vFaces[v]) {
      if (shared.includes(f)) continue;
      const t = [tris[f * 3], tris[f * 3 + 1], tris[f * 3 + 2]];
      const o = normal(t[0], t[1], t[2]);
      const m = t.map((w) => (w === v ? u : w));
      const n = normal(m[0], m[1], m[2]);
      if (n[3] <= minArea2 || !o[3] || (o[0] * n[0] + o[1] * n[1] + o[2] * n[2]) / (o[3] * n[3]) <= 0) return false;
      // Distance from the removed vertex to the new face's plane.
      const d = ((pos[v * 3] - pos[u * 3]) * n[0] + (pos[v * 3 + 1] - pos[u * 3 + 1]) * n[1] + (pos[v * 3 + 2] - pos[u * 3 + 2]) * n[2]) / n[3];
      if (Math.abs(d) > maxDev) return false;
    }
    for (const f of shared) {
      alive[f] = 0;
      for (let k = 0; k < 3; k++) vFaces[tris[f * 3 + k]].delete(f);
    }
    for (const f of vFaces[v]) {
      for (let k = 0; k < 3; k++) if (tris[f * 3 + k] === v) tris[f * 3 + k] = u;
      vFaces[u].add(f);
    }
    vFaces[v].clear();
    return true;
  };
  for (let pass = 0; pass < 8; pass++) {
    let changed = 0;
    for (let v = 0; v < nv; v++) {
      if (border[v] || !vFaces[v].size) continue;
      if (faceColors) {
        const c = faceColors[[...vFaces[v]][0]];
        if ([...vFaces[v]].some((f) => faceColors[f] !== c)) continue;
      }
      for (const u of nbr(v)) if (tryCollapse(v, u)) { changed++; break; }
    }
    if (!changed) break;
  }
  const remap = new Int32Array(nv).fill(-1);
  const outPos: number[] = [], outIdx: number[] = [], outCol: number[] = [];
  for (let f = 0; f < nt; f++) {
    if (!alive[f]) continue;
    for (let k = 0; k < 3; k++) {
      const v = tris[f * 3 + k];
      if (remap[v] < 0) {
        remap[v] = outPos.length / 3;
        outPos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      }
      outIdx.push(remap[v]);
    }
    if (faceColors) outCol.push(faceColors[f]);
  }
  return {
    mesh: { positions: new Float32Array(outPos), indices: new Uint32Array(outIdx) },
    faceColors: faceColors ? Uint32Array.from(outCol) : undefined,
  };
}
