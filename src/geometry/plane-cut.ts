// Split, as 3D Builder's plane cut does it: no boolean. Each triangle is classified against the
// plane (|s| < 1e-7 counts as on it, nothing is snapped), triangles crossing it are cut (points
// shared per edge, fixed diagonal for the quad), the boundary loops lying in the plane are walked,
// and each group of coplanar loops is capped by a monotone triangulation (holes allowed), its
// winding reversed against the loops. Each kept half is then split into connected pieces.
import type { MeshData } from '../core/mesh-data';
import { NO_PAINT } from '../core/model';
import { shells } from '../repair/topology';
import { triangulateMonotone } from './monotone';

type V3 = [number, number, number];
const ON = 1e-7; // |n·v + d| below this: on the plane
const LOOP_ON = 1e-5; // loop vertices farther than this from the plane are dropped

export interface CutPiece { mesh: MeshData; faceColors?: Uint32Array }
export interface CutResult { above: CutPiece[]; below: CutPiece[] }

export function planeCut(input: MeshData, normal: V3, point: V3, faceColors?: Uint32Array, triangulate?: (pts: [number, number][], rings: number[][]) => [number, number, number][]): CutResult {
  const ln = Math.hypot(...normal) || 1;
  const n: V3 = [normal[0] / ln, normal[1] / ln, normal[2] / ln];
  const d = -(n[0] * point[0] + n[1] * point[1] + n[2] * point[2]);
  // Exact-duplicate weld (tolerance 0).
  const pos: number[] = [];
  const remap = new Int32Array(input.positions.length / 3);
  const seen = new Map<string, number>();
  for (let i = 0; i < remap.length; i++) {
    const x = input.positions[i * 3], y = input.positions[i * 3 + 1], z = input.positions[i * 3 + 2];
    const k = `${x},${y},${z}`;
    let j = seen.get(k);
    if (j === undefined) { j = pos.length / 3; pos.push(x, y, z); seen.set(k, j); }
    remap[i] = j;
  }
  const sd = (i: number) => n[0] * pos[i * 3] + n[1] * pos[i * 3 + 1] + n[2] * pos[i * 3 + 2] + d;
  const s: number[] = [];
  for (let i = 0; i < pos.length / 3; i++) s.push(sd(i));
  const cut = new Map<string, number>();
  const at = (a: number, b: number) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    let v = cut.get(key);
    if (v === undefined) {
      const t = Math.abs(s[a]) / (Math.abs(s[a]) + Math.abs(s[b]));
      v = pos.length / 3;
      for (let k = 0; k < 3; k++) pos.push(pos[a * 3 + k] + t * (pos[b * 3 + k] - pos[a * 3 + k]));
      s.push(0);
      cut.set(key, v);
    }
    return v;
  };
  const up: number[] = [], low: number[] = [], upC: number[] = [], lowC: number[] = [];
  const put = (side: 1 | -1, t: number[], c: number) => { if (side > 0) { up.push(...t); upC.push(c); } else { low.push(...t); lowC.push(c); } };
  const nt = input.indices.length / 3;
  for (let f = 0; f < nt; f++) {
    const v = [remap[input.indices[f * 3]], remap[input.indices[f * 3 + 1]], remap[input.indices[f * 3 + 2]]];
    const c = faceColors ? faceColors[f] : NO_PAINT;
    const on = v.map((i) => Math.abs(s[i]) < ON);
    const sign = v.map((i, k) => (on[k] ? 0 : s[i] < 0 ? -1 : 1));
    if (on.every(Boolean)) { put(-1, v, c); continue; } // coplanar: lower half
    if (!sign.includes(-1)) { put(1, v, c); continue; }
    if (!sign.includes(1)) { put(-1, v, c); continue; }
    const k0 = on.indexOf(true);
    if (k0 >= 0) {
      // One vertex on the plane, the other two on opposite sides: cut edge bc.
      const a = v[k0], b = v[(k0 + 1) % 3], cc = v[(k0 + 2) % 3];
      const I = at(b, cc);
      put(sign[(k0 + 1) % 3] as 1 | -1, [I, a, b], c);
      put(sign[(k0 + 2) % 3] as 1 | -1, [I, cc, a], c);
      continue;
    }
    // Lone vertex a on one side: I1 on ab, I2 on ac; the quad is split along I1–c.
    const kl = [0, 1, 2].find((k) => sign.filter((x) => x === sign[k]).length === 1)!;
    const a = v[kl], b = v[(kl + 1) % 3], cc = v[(kl + 2) % 3];
    const I1 = at(a, b), I2 = at(a, cc);
    const lone = sign[kl] as 1 | -1;
    put(lone, [I1, I2, a], c);
    put(-lone as 1 | -1, [I1, b, cc], c);
    put(-lone as 1 | -1, [I1, cc, I2], c);
  }
  const half = (tris: number[], cols: number[]): CutPiece[] => {
    if (tris.length < 3) return [];
    const capped = cap(pos, s, tris, cols, n, triangulate);
    // Each connected piece becomes an object (pieces under 1e-4 across are ignored).
    const label = shells(Uint32Array.from(capped.tris), pos.length / 3);
    const groups = new Map<number, number[]>();
    for (let f = 0; f < label.length; f++) { const g = groups.get(label[f]); if (g) g.push(f); else groups.set(label[f], [f]); }
    const out: CutPiece[] = [];
    for (const faces of groups.values()) {
      const map = new Map<number, number>();
      const p: number[] = [], idx: number[] = [], col: number[] = [];
      for (const f of faces) {
        for (let k = 0; k < 3; k++) {
          const v = capped.tris[f * 3 + k];
          let m = map.get(v);
          if (m === undefined) { m = p.length / 3; p.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); map.set(v, m); }
          idx.push(m);
        }
        col.push(capped.cols[f]);
      }
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.length; i++) { lo[i % 3] = Math.min(lo[i % 3], p[i]); hi[i % 3] = Math.max(hi[i % 3], p[i]); }
      if (Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) < 1e-4) continue;
      out.push({ mesh: { positions: new Float32Array(p), indices: new Uint32Array(idx) }, faceColors: faceColors ? Uint32Array.from(col) : undefined });
    }
    return out;
  };
  return { above: half(up, upC), below: half(low, lowC) };
}

/** Walks the boundary loops lying in the plane and caps them. */
function cap(pos: number[], s: number[], tris: number[], cols: number[], n: V3,
  fallback?: (pts: [number, number][], rings: number[][]) => [number, number, number][]): { tris: number[]; cols: number[] } {
  const directed = new Map<string, number>();
  for (let f = 0; f < tris.length / 3; f++) for (let k = 0; k < 3; k++) directed.set(`${tris[f * 3 + k]},${tris[f * 3 + ((k + 1) % 3)]}`, f);
  // Boundary edges a→b (no b→a), walked into loops; a revisited vertex closes a loop (pinches).
  const nextOf = new Map<number, { to: number; face: number }[]>();
  for (const [key, f] of directed) {
    const [a, b] = key.split(',').map(Number);
    if (directed.has(`${b},${a}`)) continue;
    const l = nextOf.get(a);
    if (l) l.push({ to: b, face: f }); else nextOf.set(a, [{ to: b, face: f }]);
  }
  const loops: { verts: number[]; color: number }[] = [];
  for (const start of [...nextOf.keys()]) {
    while (nextOf.get(start)?.length) {
      const path: number[] = [start];
      const faces: number[] = [];
      const index = new Map<number, number>([[start, 0]]);
      let cur = start;
      for (let guard = 0; guard < directed.size + 1; guard++) {
        const outs = nextOf.get(cur);
        if (!outs?.length) break;
        const e = outs.pop()!;
        faces.push(e.face);
        cur = e.to;
        const at = index.get(cur);
        if (at !== undefined) {
          const verts = path.slice(at);
          const fs = faces.slice(at);
          const c0 = cols[fs[0]];
          loops.push({ verts, color: fs.every((f) => cols[f] === c0) ? c0 : NO_PAINT });
          path.length = at + 1;
          faces.length = at;
          for (const v of verts.slice(1)) index.delete(v);
          if (at === 0) break;
          continue;
        }
        index.set(cur, path.length);
        path.push(cur);
      }
    }
  }
  // Keep the vertices in the plane; loops left empty (old holes elsewhere) are not capped.
  const planar = loops.map((l) => ({ verts: l.verts.filter((v) => Math.abs(s[v]) <= LOOP_ON), color: l.color })).filter((l) => l.verts.length >= 3);
  if (!planar.length) return { tris, cols };
  // All loops of a plane cut share the cutting plane: one group, triangulated together.
  const P = (i: number): V3 => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const crs = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  // 2D basis as 3D Builder: d1 = longest edge, e = first edge at more than 30° from it.
  const edges: V3[] = [];
  for (const l of planar) for (let i = 0; i < l.verts.length; i++) edges.push(sub(P(l.verts[(i + 1) % l.verts.length]), P(l.verts[i])));
  let d1 = edges[0];
  for (const e of edges) if (dot(e, e) > dot(d1, d1)) d1 = e;
  const u1 = unit(d1);
  let e2: V3 | null = null, bestSin = 0, bestE = edges[0];
  for (const e of edges) {
    const sin = Math.hypot(...crs(u1, unit(e)));
    if (sin > 0.5) { e2 = e; break; }
    if (sin > bestSin) { bestSin = sin; bestE = e; }
  }
  const ev = unit(e2 ?? bestE);
  let b = unit(crs(u1, ev));
  if (!Number.isFinite(b[0]) || Math.hypot(...crs(u1, ev)) < 1e-7) b = n;
  const a = unit([(u1[0] + ev[0]) / 2, (u1[1] + ev[1]) / 2, (u1[2] + ev[2]) / 2]);
  const c = unit(crs(a, b));
  // Points, rings (dropping edges shorter than 1e-4, re-inserted afterwards).
  const pts: [number, number][] = [];
  const global: number[] = [];
  const ringsOf: number[][] = [];
  const ringColor: number[] = [];
  // Skipped vertices with the vertex before them on the loop, in loop order.
  const skipped: { v: number; prev: number }[] = [];
  for (const l of planar) {
    const ring: number[] = [];
    const keep = l.verts.map(() => true);
    let last = l.verts[0];
    for (let i = 1; i < l.verts.length; i++) {
      const dd = sub(P(l.verts[i]), P(last));
      if (dot(dd, dd) <= 1e-8) keep[i] = false; else last = l.verts[i];
    }
    for (let i = l.verts.length - 1; i > 0 && keep[i]; i--) {
      const dd = sub(P(l.verts[i]), P(l.verts[0]));
      if (dot(dd, dd) > 1e-8) break;
      keep[i] = false;
    }
    // Points on a straight run of the contour are taken out too and put back the same way, so no
    // cap triangle spans three aligned points (they would have no area).
    const flat2 = (v: number): [number, number] => { const p = P(v); return [dot(a, p), dot(c, p)]; };
    for (let pass = 0, changed = true; changed && pass < 8; pass++) {
      changed = false;
      const ids = l.verts.map((_, i) => i).filter((i) => keep[i]);
      let lastKept = ids[ids.length - 1], left = ids.length;
      for (let k = 0; k < ids.length && left > 3; k++) {
        const u = flat2(l.verts[lastKept]), v = flat2(l.verts[ids[k]]), w = flat2(l.verts[ids[(k + 1) % ids.length]]);
        const len = Math.hypot(w[0] - u[0], w[1] - u[1]);
        const area2 = Math.abs((v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]));
        // On the segment u–w (not a spike back), within 1e-9 of its length.
        const along = (v[0] - u[0]) * (w[0] - u[0]) + (v[1] - u[1]) * (w[1] - u[1]);
        if (ids[k] !== 0 && len > 0 && area2 <= 1e-9 * len * len && along > 0 && along < len * len) { keep[ids[k]] = false; changed = true; left--; }
        else lastKept = ids[k];
      }
    }
    const kept = l.verts.filter((_, i) => keep[i]);
    if (kept.length < 3) continue;
    for (let i = 1; i < l.verts.length; i++) if (!keep[i]) skipped.push({ v: l.verts[i], prev: l.verts[i - 1] });
    for (const v of kept) { ring.push(pts.length); global.push(v); const p = P(v); pts.push([dot(a, p), dot(c, p)]); }
    ringsOf.push(ring);
    ringColor.push(l.color);
  }
  // Nesting by point-in-polygon: even depth = outer, odd = hole attached to its container.
  const inside = (q: [number, number], ring: number[]) => {
    let r = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const pi = pts[ring[i]], pj = pts[ring[j]];
      if ((pi[1] > q[1]) !== (pj[1] > q[1]) && q[0] < ((pj[0] - pi[0]) * (q[1] - pi[1])) / (pj[1] - pi[1]) + pi[0]) r = !r;
    }
    return r;
  };
  // Ring r inside ring o: most of r's vertices that o does not share lie inside o (loops of
  // touching parts can share a vertex, which is ambiguous).
  const within = (r: number[], o: number[]) => {
    const shared = new Set(o.map((i) => global[i]));
    let yes = 0, no = 0;
    for (const i of r) { if (shared.has(global[i])) continue; if (inside(pts[i], o)) yes++; else no++; }
    return yes > no;
  };
  const depth = ringsOf.map((r, i) => ringsOf.filter((o, j) => j !== i && within(r, o)).length);
  const outT: number[] = [], outC: number[] = [];
  for (let i = 0; i < ringsOf.length; i++) {
    if (depth[i] % 2) continue;
    const holes = ringsOf.map((_, j) => j).filter((j) => depth[j] === depth[i] + 1 && within(ringsOf[j], ringsOf[i]));
    const rings = [ringsOf[i], ...holes.map((j) => ringsOf[j])];
    let tri = triangulateMonotone(pts, rings);
    if (!tri && fallback) tri = fallback(pts, rings);
    if (!tri) continue;
    // Winding along the outer loop's direction in 2D, then reversed (3D Builder appends the cap
    // reversed): the cap edges run against the boundary edges.
    const ringCCW = (() => { let ar = 0; const r = rings[0]; for (let k = 0; k < r.length; k++) { const p = pts[r[k]], q = pts[r[(k + 1) % r.length]]; ar += p[0] * q[1] - q[0] * p[1]; } return ar > 0; })();
    const color = ringColor[i];
    for (const [x, y, z] of tri) {
      const t = ringCCW ? [global[x], global[y], global[z]] : [global[x], global[z], global[y]];
      outT.push(t[0], t[2], t[1]); // reversed
      outC.push(color);
    }
  }
  // Re-insert the skipped near-duplicate vertices (no T-junction): the boundary runs prev → v,
  // and the cap still has an unmatched edge (X, prev); its triangle (X, prev, z) is split at v.
  for (const sk of skipped) {
    const all = new Set<string>(directed.keys());
    for (let f = 0; f < outT.length / 3; f++) for (let k = 0; k < 3; k++) all.add(`${outT[f * 3 + k]},${outT[f * 3 + ((k + 1) % 3)]}`);
    let hit = false;
    for (let f = 0; f < outT.length / 3 && !hit; f++) for (let k = 0; k < 3; k++) {
      const x = outT[f * 3 + k], y = outT[f * 3 + ((k + 1) % 3)], z = outT[f * 3 + ((k + 2) % 3)];
      if (y !== sk.prev || x === sk.v || all.has(`${y},${x}`)) continue;
      outT[f * 3] = x; outT[f * 3 + 1] = sk.v; outT[f * 3 + 2] = z;
      outT.push(sk.v, y, z);
      outC.push(outC[f]);
      hit = true;
      break;
    }
  }
  return { tris: [...tris, ...outT], cols: [...cols, ...outC] };
}
