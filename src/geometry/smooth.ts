// Smoothing with 3D Builder's behaviour (our own code):
// - "Niveau de lissage" = number of passes;
// - each shell is processed on its own;
// - default: each pass splits the shell 1→4 at edge midpoints while it has fewer than 4096
//   VERTICES, then runs 10 iterations of the HC Laplacian smoother (Vollmer et al.) with α = 0.2,
//   β = 0.8 and edge weights equal to the average angle opposite the edge;
// - "Bords lisses": each pass is one Loop subdivision step (faces ×4 per pass), no smoothing.
import type { MeshData } from '../core/mesh-data';
import { merged } from '../core/mesh-data';
import { shells } from '../repair/topology';

/** Splits every triangle into 4 at edge midpoints; with `loop`, applies Loop's vertex rules. */
export function subdivide(m: MeshData, loop: boolean): MeshData {
  const p = m.positions, t = m.indices;
  const nv = p.length / 3, nt = t.length / 3;
  const mid = new Map<number, number>();
  const pos: number[] = Array.from(p);
  // Edge -> opposite vertices (for Loop's 3/8–1/8 edge rule).
  const opp = new Map<number, number[]>();
  const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) {
    const a = t[f * 3 + k], b = t[f * 3 + ((k + 1) % 3)], c = t[f * 3 + ((k + 2) % 3)];
    const kk = key(a, b);
    const l = opp.get(kk);
    if (l) l.push(c);
    else opp.set(kk, [c]);
  }
  const midpoint = (a: number, b: number) => {
    const kk = key(a, b);
    let id = mid.get(kk);
    if (id !== undefined) return id;
    id = pos.length / 3;
    const o = opp.get(kk) ?? [];
    for (let i = 0; i < 3; i++) {
      // Loop: 3/8 (a + b) + 1/8 per opposite vertex (one term only on an edge with one face).
      if (loop && o.length) pos.push((3 / 8) * (p[a * 3 + i] + p[b * 3 + i]) + (1 / 8) * o.reduce((acc, c) => acc + p[c * 3 + i], 0));
      else pos.push((p[a * 3 + i] + p[b * 3 + i]) / 2);
    }
    mid.set(kk, id);
    return id;
  };
  const idx: number[] = [];
  for (let f = 0; f < nt; f++) {
    const a = t[f * 3], b = t[f * 3 + 1], c = t[f * 3 + 2];
    const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
    idx.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  if (loop) {
    // Original vertices: v' = (1 − nβ)v + βΣ neighbours, β = 3/(8n) (n > 3) or 3/16 (n = 3).
    const nbrs: Set<number>[] = Array.from({ length: nv }, () => new Set());
    for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) {
      const a = t[f * 3 + k], b = t[f * 3 + ((k + 1) % 3)];
      nbrs[a].add(b);
      nbrs[b].add(a);
    }
    for (let v = 0; v < nv; v++) {
      const n = nbrs[v].size;
      if (n < 3) continue;
      const beta = n === 3 ? 3 / 16 : 3 / (8 * n);
      for (let i = 0; i < 3; i++) {
        let s = 0;
        for (const u of nbrs[v]) s += p[u * 3 + i];
        pos[v * 3 + i] = (1 - n * beta) * p[v * 3 + i] + beta * s;
      }
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** HC Laplacian smoothing (one pass = 10 iterations), angle-weighted. */
export function hcSmooth(m: MeshData, iterations = 10, alpha = 0.2, beta = 0.8): MeshData {
  const t = m.indices;
  const nv = m.positions.length / 3, nt = t.length / 3;
  const o = Float64Array.from(m.positions);
  let q = Float64Array.from(m.positions);
  // Edge weights from the current geometry: average of the angles opposite the edge.
  const weights = (pos: Float64Array) => {
    const w = new Map<number, number[]>();
    const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
    for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) {
      const a = t[f * 3 + k], b = t[f * 3 + ((k + 1) % 3)], c = t[f * 3 + ((k + 2) % 3)];
      const u = [pos[a * 3] - pos[c * 3], pos[a * 3 + 1] - pos[c * 3 + 1], pos[a * 3 + 2] - pos[c * 3 + 2]];
      const v = [pos[b * 3] - pos[c * 3], pos[b * 3 + 1] - pos[c * 3 + 1], pos[b * 3 + 2] - pos[c * 3 + 2]];
      const lu = Math.hypot(u[0], u[1], u[2]), lv = Math.hypot(v[0], v[1], v[2]);
      const angle = lu && lv ? Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv)))) : 0;
      const kk = key(a, b);
      const l = w.get(kk);
      if (l) l.push(angle);
      else w.set(kk, [angle]);
    }
    const adj: { j: number; w: number }[][] = Array.from({ length: nv }, () => []);
    for (const [kk, angles] of w) {
      const a = Math.floor(kk / nv), b = kk % nv;
      const wt = angles.reduce((s, x) => s + x, 0) / angles.length;
      adj[a].push({ j: b, w: wt });
      adj[b].push({ j: a, w: wt });
    }
    return adj;
  };
  for (let it = 0; it < iterations; it++) {
    const adj = weights(q);
    const p = new Float64Array(q.length);
    const b = new Float64Array(q.length);
    for (let i = 0; i < nv; i++) {
      let sw = 0;
      const acc = [0, 0, 0];
      for (const { j, w } of adj[i]) {
        sw += w;
        for (let k = 0; k < 3; k++) acc[k] += w * q[j * 3 + k];
      }
      for (let k = 0; k < 3; k++) {
        p[i * 3 + k] = sw ? acc[k] / sw : q[i * 3 + k];
        b[i * 3 + k] = p[i * 3 + k] - (alpha * o[i * 3 + k] + (1 - alpha) * q[i * 3 + k]);
      }
    }
    const next = new Float64Array(p);
    for (let i = 0; i < nv; i++) {
      let sw = 0;
      const acc = [0, 0, 0];
      for (const { j, w } of adj[i]) {
        sw += w;
        for (let k = 0; k < 3; k++) acc[k] += w * b[j * 3 + k];
      }
      if (!sw) continue;
      for (let k = 0; k < 3; k++) next[i * 3 + k] = p[i * 3 + k] - (beta * b[i * 3 + k] + (1 - beta) * (acc[k] / sw));
    }
    q = next;
  }
  return { positions: Float32Array.from(q), indices: m.indices };
}

/** The Smooth tool: `passes` = slider level; `smoothEdges` = "Bords lisses" (Loop subdivision). */
export function smoothTool(m: MeshData, passes: number, smoothEdges: boolean): MeshData {
  if (passes <= 0) return m;
  const parts = splitShells(m).map((part) => {
    let out = part;
    for (let i = 0; i < passes; i++) {
      if (smoothEdges) out = subdivide(out, true);
      else {
        if (out.positions.length / 3 < 4096) out = subdivide(out, false);
        out = hcSmooth(out, 10);
      }
    }
    return out;
  });
  return parts.length === 1 ? parts[0] : merged(parts);
}

/** The connected shells of a mesh, each with its own compact vertex list (face order kept). */
function splitShells(m: MeshData): MeshData[] {
  const label = shells(m.indices, m.positions.length / 3);
  let n = 0;
  for (let i = 0; i < label.length; i++) n = Math.max(n, label[i] + 1);
  if (n <= 1) return [m];
  const out: MeshData[] = [];
  for (let s = 0; s < n; s++) {
    const map = new Map<number, number>();
    const pos: number[] = [], idx: number[] = [];
    for (let f = 0; f < label.length; f++) {
      if (label[f] !== s) continue;
      for (let k = 0; k < 3; k++) {
        const v = m.indices[f * 3 + k];
        let id = map.get(v);
        if (id === undefined) { id = pos.length / 3; map.set(v, id); pos.push(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]); }
        idx.push(id);
      }
    }
    out.push({ positions: new Float32Array(pos), indices: new Uint32Array(idx) });
  }
  return out;
}
