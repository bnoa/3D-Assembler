// Extrude down, as 3D Builder does it (closed-mesh variant): the faces crossing the height limit
// are split there, every face below the limit that faces down is flattened in place onto the
// plate (z = 0), vertices shared with the rest of the object are duplicated, and walls join the
// two along the border. Walls and the low faces are painted grey (0.737). No boolean: the result
// then goes through the repair, as in 3D Builder.
import type { MeshData } from '../core/mesh-data';
import { bounds } from '../core/mesh-data';
import { NO_PAINT } from '../core/model';

/** 3D Builder's "BaseColor" for the added faces: RGB 0.7372549 = 188/255. */
export const EXTRUDE_GREY = 0xbcbcbc;

export class ExtrudeDownError extends Error {}

export interface ExtrudeDownResult {
  mesh: MeshData;
  faceColors: Uint32Array;
}

export function extrudeDownMesh(input: MeshData, limit: number, faceColors?: Uint32Array): ExtrudeDownResult {
  const b = bounds(input);
  const extent = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1;
  const eps = extent / 2048;
  if (b.min[2] < -eps) throw new ExtrudeDownError('L’objet passe sous le plateau : posez-le d’abord sur le plateau.');
  const H = limit;
  const pos: number[] = Array.from(input.positions);
  let tri: number[] = Array.from(input.indices);
  let colors: number[] = Array.from({ length: tri.length / 3 }, (_, f) => (faceColors ? faceColors[f] : NO_PAINT));

  // 1. Split the faces crossing z = H (only when the limit lies inside the object).
  if (H > eps && H < b.max[2] - eps) {
    const cut = new Map<string, number>();
    const at = (a: number, c: number) => {
      const key = a < c ? `${a},${c}` : `${c},${a}`;
      let v = cut.get(key);
      if (v === undefined) {
        const za = pos[a * 3 + 2], zc = pos[c * 3 + 2];
        const t = (H - za) / (zc - za);
        v = pos.length / 3;
        pos.push(pos[a * 3] + t * (pos[c * 3] - pos[a * 3]), pos[a * 3 + 1] + t * (pos[c * 3 + 1] - pos[a * 3 + 1]), H);
        cut.set(key, v);
      }
      return v;
    };
    const out: number[] = [], outC: number[] = [];
    // A vertex within eps of the plane counts as on it (no cut of zero length).
    const side = (i: number) => (pos[i * 3 + 2] > H + eps ? 1 : pos[i * 3 + 2] < H - eps ? -1 : 0);
    for (let f = 0; f < tri.length / 3; f++) {
      const v = [tri[f * 3], tri[f * 3 + 1], tri[f * 3 + 2]];
      const s = v.map(side);
      if (!(s.includes(1) && s.includes(-1))) { out.push(...v); outC.push(colors[f]); continue; }
      // Clip into the part above and the part below (each convex), fanned into triangles.
      const above: number[] = [], below: number[] = [];
      for (let k = 0; k < 3; k++) {
        const a = v[k], c = v[(k + 1) % 3], sa = s[k], sc = s[(k + 1) % 3];
        if (sa >= 0) above.push(a);
        if (sa <= 0) below.push(a);
        if (sa * sc < 0) { const p = at(a, c); above.push(p); below.push(p); }
      }
      for (const poly of [above, below]) for (let k = 1; k + 1 < poly.length; k++) {
        out.push(poly[0], poly[k], poly[k + 1]);
        outC.push(colors[f]);
      }
    }
    tri = out;
    colors = outC;
  }

  // 2. Score of each face: the z of its unit normal; 1 when a vertex is above the limit.
  const nt = tri.length / 3;
  const score = new Float64Array(nt);
  for (let f = 0; f < nt; f++) {
    const a = tri[f * 3] * 3, c = tri[f * 3 + 1] * 3, d = tri[f * 3 + 2] * 3;
    if (pos[a + 2] - eps > H || pos[c + 2] - eps > H || pos[d + 2] - eps > H) { score[f] = 1; continue; }
    const ux = pos[c] - pos[a], uy = pos[c + 1] - pos[a + 1], uz = pos[c + 2] - pos[a + 2];
    const vx = pos[d] - pos[a], vy = pos[d + 1] - pos[a + 1], vz = pos[d + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    score[f] = l ? nz / l : 0;
  }
  const selected = Array.from(score, (s) => s < -0.001);

  // 3. Flatten: a vertex used only by selected faces drops to z = 0; one shared with the rest of
  //    the object gets a copy at (x, y, 0) that the selected faces use instead.
  const nv0 = pos.length / 3;
  const usedSel = new Uint8Array(nv0), usedOther = new Uint8Array(nv0);
  for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) (selected[f] ? usedSel : usedOther)[tri[f * 3 + k]] = 1;
  const dup = new Int32Array(nv0).fill(-1);
  for (let v = 0; v < nv0; v++) {
    if (!usedSel[v]) continue;
    // A vertex already on the plate stays shared (3D Builder copies it and its cleanup welds the
    // copy back: same result).
    if (!usedOther[v] || Math.abs(pos[v * 3 + 2]) <= eps) { pos[v * 3 + 2] = 0; continue; }
    dup[v] = pos.length / 3;
    pos.push(pos[v * 3], pos[v * 3 + 1], 0);
  }
  // 4. Walls on the edges of selected faces that border a non-selected face: (a, b, b′) and
  //    (a, b′, a′) for the selected face's edge a→b; a side whose end stayed on the plate
  //    (no copy) reduces to one triangle.
  const otherEdges = new Set<string>();
  for (let f = 0; f < nt; f++) if (!selected[f]) for (let k = 0; k < 3; k++) otherEdges.add(`${tri[f * 3 + k]},${tri[f * 3 + ((k + 1) % 3)]}`);
  const walls: number[] = [];
  for (let f = 0; f < nt; f++) {
    if (!selected[f]) continue;
    for (let k = 0; k < 3; k++) {
      const a = tri[f * 3 + k], c = tri[f * 3 + ((k + 1) % 3)];
      if ((dup[a] < 0 && dup[c] < 0) || !otherEdges.has(`${c},${a}`)) continue;
      const a2 = dup[a] < 0 ? a : dup[a], c2 = dup[c] < 0 ? c : dup[c];
      if (c2 !== c) walls.push(a, c, c2);
      if (a2 !== a) walls.push(a, c2, a2);
    }
  }
  for (let f = 0; f < nt; f++) if (selected[f]) for (let k = 0; k < 3; k++) {
    const v = tri[f * 3 + k];
    if (dup[v] >= 0) tri[f * 3 + k] = dup[v];
  }
  // 5. Grey on the walls and on every face below the limit that does not face up.
  for (let f = 0; f < nt; f++) if (score[f] < 0.001) colors[f] = EXTRUDE_GREY;
  for (let i = 0; i < walls.length; i += 3) colors.push(EXTRUDE_GREY);
  return { mesh: { positions: new Float32Array(pos), indices: new Uint32Array([...tri, ...walls]) }, faceColors: Uint32Array.from(colors) };
}

/**
 * The validated result of "Extruder vers le bas", built as 3D Builder's validated result is (it is
 * not the preview's): no vertex moves; one flat copy (x, y, 0) of every vertex is appended in
 * index order; faces below the limit that do not face up (normal z ≤ 0.001, or degenerate) are
 * deleted; the kept faces come first, then walls down from the border of the kept surface, then
 * the whole kept surface projected flat and reversed as the bottom. The simplifier then merges the
 * flat bottom away (see csg.extrudeDown). Grey is added only when the object has face colours.
 */
export function extrudeDownApplyMesh(input: MeshData, limit: number, faceColors?: Uint32Array): ExtrudeDownResult {
  const b = bounds(input);
  const extent = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1;
  if (b.min[2] < -extent / 2048) throw new ExtrudeDownError('L’objet passe sous le plateau : posez-le d’abord sur le plateau.');
  const p = input.positions, t = input.indices;
  const V = p.length / 3, nt = t.length / 3;
  const above = new Uint8Array(V);
  for (let i = 0; i < V; i++) if (p[i * 3 + 2] > limit) above[i] = 1;
  // 1. Kept faces: a vertex above the limit, or a non-degenerate face whose normal points up.
  const kept: number[] = [];
  for (let f = 0; f < nt; f++) {
    const a = t[f * 3], c = t[f * 3 + 1], d = t[f * 3 + 2];
    let w: number;
    if (above[a] || above[c] || above[d]) w = 1;
    else {
      const ux = p[c * 3] - p[a * 3], uy = p[c * 3 + 1] - p[a * 3 + 1], uz = p[c * 3 + 2] - p[a * 3 + 2];
      const vx = p[d * 3] - p[a * 3], vy = p[d * 3 + 1] - p[a * 3 + 1], vz = p[d * 3 + 2] - p[a * 3 + 2];
      const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz);
      if (!(lu * lv > 0) || Math.abs(ux * vx + uy * vy + uz * vz) / (lu * lv) >= 1) w = -1;
      else {
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        w = nz / Math.hypot(nx, ny, nz);
      }
    }
    if (w > 0.001) kept.push(f);
  }
  const idx: number[] = [], col: number[] = [];
  for (const f of kept) { idx.push(t[f * 3], t[f * 3 + 1], t[f * 3 + 2]); col.push(faceColors ? faceColors[f] : NO_PAINT); }
  const nk = kept.length;
  // Faces of each vertex (in kept order) and the number of kept faces on each edge.
  const facesOf: number[][] = Array.from({ length: V }, () => []);
  for (let f = 0; f < nk; f++) for (let k = 0; k < 3; k++) facesOf[idx[f * 3 + k]].push(f);
  const shared = (u: number, v: number) => { let n = 0; for (const f of facesOf[u]) if (idx[f * 3] === v || idx[f * 3 + 1] === v || idx[f * 3 + 2] === v) n++; return n; };
  // 2. Walls, vertex by vertex: an edge (v, X) on fewer or more than 2 kept faces gets a wall to
  //    the copies (′ = index + V), emitted once from the first endpoint visited.
  const visited = new Uint8Array(V);
  const walls: number[] = [];
  for (let v = 0; v < V; v++) {
    if (above[v] || visited[v]) continue;
    visited[v] = 1;
    for (const f of facesOf[v]) for (let k = 0; k < 3; k++) {
      const X = idx[f * 3 + k];
      if (X === v || above[X] || visited[X] || shared(v, X) === 2) continue;
      // Does v follow X in the face's winding?
      const follows = idx[f * 3 + (k + 1) % 3] === v;
      if (follows) walls.push(v, X, X + V, v, X + V, v + V);
      else walls.push(v, X + V, X, v, v + V, X + V);
    }
  }
  // 3. Bottom: every kept face projected flat, reversed.
  const bottom: number[] = [];
  for (let f = 0; f < nk; f++) bottom.push(idx[f * 3] + V, idx[f * 3 + 2] + V, idx[f * 3 + 1] + V);
  const pos = new Float32Array(V * 6);
  pos.set(p);
  for (let i = 0; i < V; i++) { pos[(V + i) * 3] = p[i * 3]; pos[(V + i) * 3 + 1] = p[i * 3 + 1]; pos[(V + i) * 3 + 2] = 0; }
  const grey = faceColors ? EXTRUDE_GREY : NO_PAINT;
  for (let i = 0; i < (walls.length + bottom.length) / 3; i++) col.push(grey);
  // Copies no face uses are dropped (the simplifier's compaction drops them in 3D Builder).
  const all = [...idx, ...walls, ...bottom];
  const used = new Uint8Array(2 * V);
  for (const i of all) used[i] = 1;
  const map = new Int32Array(2 * V).fill(-1);
  const out: number[] = [];
  for (let i = 0; i < 2 * V; i++) if (used[i]) { map[i] = out.length / 3; out.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); }
  return { mesh: { positions: new Float32Array(out), indices: Uint32Array.from(all, (i) => map[i]) }, faceColors: Uint32Array.from(col) };
}
