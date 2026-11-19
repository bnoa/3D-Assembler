// Automatic mesh repair. The sequence and its parameters follow what 3D Builder runs (its
// embedded engine's "extended" repair, the only level the app uses): the model is first
// normalised so its largest side lies in [5, 400], then a single pass of filters runs with
// fixed tolerances in that space. The algorithms here are our own.
import { type MeshData, bounds, size, triArea } from '../core/mesh-data';
import { type MeshReport, analyze, areaEpsilon } from './analyze';
import { boundaryLoops, buildEdges, edgeKey, shells } from './topology';

/** Tolerances in normalised units (= mm when the largest side is between 5 and 400 mm). */
export interface RepairOptions {
  /** Max gap closed by stitching. */
  stitchTolerance: number;
  closeHoles: boolean;
  /** Shells enclosing less than this volume are dropped. */
  removeTinyShells: boolean;
  tinyShellVolume: number;
  /** Grid on which degenerate faces are detected (zero area once snapped). */
  degenerateGrid: number;
  /** Final merge distance before the export clean-up. */
  exportMerge: number;
}

export const DEFAULT_REPAIR: RepairOptions = {
  stitchTolerance: 0.01,
  closeHoles: true,
  removeTinyShells: true,
  tinyShellVolume: 0.001,
  degenerateGrid: 0.002,
  exportMerge: 0.001,
};

/** Scale so the largest side lands in [5, 400], as 3D Builder does before repairing. */
export function normalisationScale(ext: number): number {
  if (ext > 1e-6 && ext < 5) return 5 / ext;
  if (ext > 400) return 400 / ext;
  return 1;
}

export interface RepairLog {
  welded: number;
  stitched: number;
  degenerateRemoved: number;
  duplicatesRemoved: number;
  flipped: number;
  holesClosed: number;
  shellsInverted: number;
  shellsRemoved: number;
  nonManifoldSplit: number;
}

interface Work {
  pos: Float64Array;
  tris: number[];
  /** Optional per-face tag (source face index), kept through face deletions and splits. */
  origin?: number[];
}

/** Separates the edges shared by more than two faces (vertex duplication), nothing else. */
export function separateNonManifold(input: MeshData): MeshData {
  const w: Work = { pos: Float64Array.from(input.positions), tris: Array.from(input.indices) };
  if (!splitNonManifold(w)) return input;
  return compact(w);
}

export function repairMesh(input: MeshData, opts: Partial<RepairOptions> = {}): { mesh: MeshData; log: RepairLog } {
  const o = { ...DEFAULT_REPAIR, ...opts };
  const log: RepairLog = {
    welded: 0, stitched: 0, degenerateRemoved: 0, duplicatesRemoved: 0,
    flipped: 0, holesClosed: 0, shellsInverted: 0, shellsRemoved: 0, nonManifoldSplit: 0,
  };
  if (!input.indices.length) return { mesh: input, log };

  // N. Normalise: min corner to the origin, largest side into [5, 400].
  const b = bounds(input);
  const ext = Math.max(...size(b));
  const scale = normalisationScale(ext);
  const pos = new Float64Array(input.positions.length);
  for (let i = 0; i < pos.length; i++) pos[i] = (input.positions[i] - b.min[i % 3]) * scale;
  const w: Work = { pos, tris: Array.from(input.indices) };

  log.welded = weld(w, 1e-6, false);
  log.degenerateRemoved += dropCollapsed(w);
  // 1. Stitch gaps: vertex to vertex, then vertex to edge (T-junctions).
  log.stitched += stitch(w, o.stitchTolerance);
  // 2. Close trivial holes.
  if (o.closeHoles) log.holesClosed += closeHoles(w, 3);
  // 3. Remove double triangles (after merging nodes closer than 1e-4).
  log.welded += weld(w, 1e-4, false);
  log.degenerateRemoved += dropCollapsed(w);
  log.duplicatesRemoved += removeDuplicates(w);
  // 4. Fix flipped triangles.
  log.flipped += orient(w);
  // 5. Close trivial holes.
  if (o.closeHoles) log.holesClosed += closeHoles(w, 3);
  // 6. Stitch gaps again, 7. fix flipped triangles.
  log.stitched += stitch(w, o.stitchTolerance);
  log.flipped += orient(w);
  // 8. Close all holes (repeated while patching exposes new ones).
  if (o.closeHoles) {
    for (let pass = 0; pass < 3; pass++) {
      const closed = closeHoles(w, Infinity);
      if (!closed) break;
      log.holesClosed += closed;
      log.duplicatesRemoved += removeDuplicates(w);
      log.flipped += orient(w);
    }
  }
  // 9. Wrap stage (topology part): make the surface 2-manifold and orient shells outward.
  //    Overlapping shells are merged afterwards by repairSolid.
  log.nonManifoldSplit += splitNonManifold(w);
  log.flipped += orient(w);
  log.shellsInverted += orientShellsOutward(w);
  // 10. Remove degenerate faces on a fine grid (edge flips, not deletions).
  log.degenerateRemoved += removeDegenerate(w, o.degenerateGrid);
  // 11. Remove tiny shells.
  if (o.removeTinyShells) log.shellsRemoved += removeTinyShells(w, o.tinyShellVolume);
  // 12. Prepare for export: merge near nodes, then separate edges shared by more than two faces.
  log.welded += weld(w, o.exportMerge, false);
  log.degenerateRemoved += dropCollapsed(w);
  log.duplicatesRemoved += removeDuplicates(w);
  log.nonManifoldSplit += splitNonManifold(w);
  log.flipped += orient(w);
  log.shellsInverted += orientShellsOutward(w);
  // 13. (3D Assembler) Removing folded faces and merging nodes can leave a slit: a zero-area hole whose
  //     middle vertex lies on its long edge. 3D Builder leaves it open; it is a T-junction,
  //     stitched here.
  if ([...buildEdges(w.tris, w.pos.length / 3).values()].some((e) => e.faces.length === 1)) {
    log.stitched += stitch(w, o.stitchTolerance);
    log.duplicatesRemoved += removeDuplicates(w);
    log.flipped += orient(w);
    log.degenerateRemoved += removeDegenerate(w, o.degenerateGrid);
    log.shellsInverted += orientShellsOutward(w);
  }

  // D. Denormalise.
  for (let i = 0; i < w.pos.length; i++) w.pos[i] = w.pos[i] / scale + b.min[i % 3];
  return { mesh: compact(w), log };
}

// --- stages -----------------------------------------------------------------------------------

/** Merges vertices closer than `tol` (all vertices, or only those on open edges). */
function weld(w: Work, tol: number, boundaryOnly: boolean): number {
  const nv = w.pos.length / 3;
  let candidates: number[];
  if (boundaryOnly) {
    const set = new Set<number>();
    for (const e of buildEdges(w.tris, nv).values()) if (e.faces.length === 1) set.add(e.a).add(e.b);
    candidates = [...set];
  } else {
    candidates = Array.from({ length: nv }, (_, i) => i);
  }
  if (candidates.length < 2) return 0;
  const cell = tol > 0 ? tol : 1e-9;
  // Spatial hash of grid cells (collisions are harmless: candidates are distance-checked).
  const hash = (x: number, y: number, z: number) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0;
  const grid = new Map<number, number[]>();
  const remap = new Int32Array(nv).map((_, i) => i);
  let merged = 0;
  const p = w.pos;
  for (const v of candidates) {
    const cx = Math.floor(p[v * 3] / cell), cy = Math.floor(p[v * 3 + 1] / cell), cz = Math.floor(p[v * 3 + 2] / cell);
    let target = -1;
    search: for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = grid.get(hash(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (const u of list) {
            const ddx = p[u * 3] - p[v * 3], ddy = p[u * 3 + 1] - p[v * 3 + 1], ddz = p[u * 3 + 2] - p[v * 3 + 2];
            if (ddx * ddx + ddy * ddy + ddz * ddz <= tol * tol) {
              target = u;
              break search;
            }
          }
        }
      }
    }
    if (target >= 0) {
      remap[v] = target;
      merged++;
    } else {
      const key = hash(cx, cy, cz);
      const list = grid.get(key);
      if (list) list.push(v);
      else grid.set(key, [v]);
    }
  }
  if (merged) for (let i = 0; i < w.tris.length; i++) w.tris[i] = remap[w.tris[i]];
  return merged;
}

/**
 * Last resort for the few zero-area faces the safe fixes refused: collapse the face's shortest
 * edge anyway, keep the result only if the full analysis says the mesh got healthier.
 */
export function forceFixDegenerates(input: MeshData, maxTries = 20): MeshData {
  let mesh = input;
  let report = analyze(mesh);
  const score = (r: MeshReport) => r.openEdges * 4 + r.nonManifoldEdges * 4 + r.flippedEdges * 4 + r.duplicateFaces * 2 + r.degenerateFaces;
  for (let tries = 0; tries < maxTries && report.degenerateFaces > 0; tries++) {
    const eps = areaEpsilon(mesh);
    const p = mesh.positions, t = mesh.indices;
    let improved = false;
    for (let f = 0; f < t.length / 3 && !improved; f++) {
      const a = t[f * 3], b = t[f * 3 + 1], c = t[f * 3 + 2];
      if (!(a === b || b === c || a === c || triArea(p, a, b, c) <= eps)) continue;
      // Try collapsing each edge of the face, shortest first.
      const edges = [[a, b], [b, c], [c, a]].sort((e1, e2) => dist(p, e1[0], e1[1]) - dist(p, e2[0], e2[1]));
      for (const [x, y] of edges) {
        if (x === y) continue;
        const tris = Array.from(t, (v) => (v === y ? x : v));
        const w: Work = { pos: Float64Array.from(p), tris };
        dropCollapsed(w);
        removeDuplicates(w);
        const candidate = compact(w);
        const r = analyze(candidate);
        if (score(r) < score(report)) {
          mesh = candidate;
          report = r;
          improved = true;
          break;
        }
      }
    }
    if (!improved) break;
  }
  return mesh;
}

const dist = (p: Float32Array, a: number, b: number) => Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);

/**
 * Gentle clean-up for meshes that are already sound (boolean results): fixes zero-area faces
 * and drops tiny fragments, without welding (close but distinct vertices stay distinct).
 */
export function cleanMesh(input: MeshData, opts: Partial<RepairOptions> = {}): MeshData {
  if (!input.indices.length) return input;
  const o = { ...DEFAULT_REPAIR, ...opts };
  const b = bounds(input);
  const scale = normalisationScale(Math.max(...size(b)));
  const pos = new Float64Array(input.positions.length);
  for (let i = 0; i < pos.length; i++) pos[i] = (input.positions[i] - b.min[i % 3]) * scale;
  const w: Work = { pos, tris: Array.from(input.indices) };
  dropCollapsed(w);
  removeDegenerate(w, o.degenerateGrid);
  removeTinyShells(w, o.tinyShellVolume);
  for (let i = 0; i < w.pos.length; i++) w.pos[i] = w.pos[i] / scale + b.min[i % 3];
  return compact(w);
}

/**
 * Welds and closes T-junctions in an arbitrary index soup (used by Wrap on its integer grid).
 * Positions are not modified; only indices are remapped and faces split.
 */
export function stitchSoup(pos: Float64Array, tris: number[], tol: number): { pos: Float64Array; tris: number[]; origin: number[] } {
  const w: Work = { pos, tris: [...tris], origin: Array.from({ length: tris.length / 3 }, (_, i) => i) };
  // Points of one intersection computed in different triangles may differ by a unit or two.
  weld(w, tol, false);
  dropCollapsed(w);
  stitch(w, tol);
  return { pos: w.pos, tris: w.tris, origin: w.origin! };
}

/** Drops faces that use the same vertex twice (left behind by welding). */
function dropCollapsed(w: Work): number {
  const out: number[] = [];
  const origin: number[] = [];
  for (let i = 0; i < w.tris.length; i += 3) {
    const a = w.tris[i], b = w.tris[i + 1], c = w.tris[i + 2];
    if (a !== b && b !== c && a !== c) {
      out.push(a, b, c);
      if (w.origin) origin.push(w.origin[i / 3]);
    }
  }
  const removed = (w.tris.length - out.length) / 3;
  w.tris = out;
  if (w.origin) w.origin = origin;
  return removed;
}

/** Stitches gaps: vertex-to-vertex welds, then T-junction splits re-welded. */
function stitch(w: Work, tol: number): number {
  let n = weld(w, tol, true);
  if (stitchTJunctions(w, tol)) n += weld(w, tol, true);
  dropCollapsed(w);
  return n;
}

/**
 * Fixes faces that would have zero area on a `grid` (3D Builder snaps to that grid; we test the
 * same condition — height below half a grid step — without moving vertices, which could flip
 * thin triangles). The longest edge of a degenerate face is flipped with its neighbour (keeping
 * the surface closed); a degenerate face on the boundary is deleted; two folded faces sharing
 * all vertices are both deleted.
 */
function removeDegenerate(w: Work, grid: number): number {
  // Collapse needles, flip caps; a flip can join two coincident (pinched) vertices into a new
  // zero-length edge, which the next collapse removes. A few rounds suffice.
  let fixed = 0;
  for (let round = 0; round < 3; round++) {
    const n = collapseShortEdges(w, grid / 2) + flipDegenerate(w, grid) + collapseCaps(w, grid);
    fixed += n;
    if (!n) break;
  }
  return fixed;
}

function flipDegenerate(w: Work, grid: number): number {
  let fixed = 0;
  const nv = w.pos.length / 3;
  const nt = w.tris.length / 3;
  const edgeFaces = new Map<number, number[]>();
  for (const [key, e] of buildEdges(w.tris, nv)) edgeFaces.set(key, [...e.faces]);
  const dead = new Uint8Array(nt);
  const isZero = (f: number) => {
    let longest = 0;
    for (let k = 0; k < 3; k++) {
      const a = w.tris[f * 3 + k], b = w.tris[f * 3 + ((k + 1) % 3)];
      longest = Math.max(longest, Math.hypot(w.pos[a * 3] - w.pos[b * 3], w.pos[a * 3 + 1] - w.pos[b * 3 + 1], w.pos[a * 3 + 2] - w.pos[b * 3 + 2]));
    }
    // twice the area / longest edge = height over the longest edge
    return Math.hypot(...faceNormal(w, f)) <= (grid / 2) * longest;
  };
  const unlink = (f: number) => {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(w.tris[f * 3 + k], w.tris[f * 3 + ((k + 1) % 3)], nv);
      const list = edgeFaces.get(key);
      if (list) list.splice(list.indexOf(f), 1);
    }
  };
  const link = (f: number) => {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(w.tris[f * 3 + k], w.tris[f * 3 + ((k + 1) % 3)], nv);
      const list = edgeFaces.get(key);
      if (list) list.push(f);
      else edgeFaces.set(key, [f]);
    }
  };
  const kill = (f: number) => {
    unlink(f);
    dead[f] = 1;
    fixed++;
  };
  const queue: number[] = [];
  for (let f = 0; f < nt; f++) if (isZero(f)) queue.push(f);
  let guard = queue.length * 20 + 100;
  while (queue.length && guard-- > 0) {
    const f = queue.pop()!;
    if (dead[f] || !isZero(f)) continue;
    // Longest edge a->b, apex c.
    let best = 0, bestLen = -1;
    for (let k = 0; k < 3; k++) {
      const a = w.tris[f * 3 + k], b = w.tris[f * 3 + ((k + 1) % 3)];
      const l = (w.pos[a * 3] - w.pos[b * 3]) ** 2 + (w.pos[a * 3 + 1] - w.pos[b * 3 + 1]) ** 2 + (w.pos[a * 3 + 2] - w.pos[b * 3 + 2]) ** 2;
      if (l > bestLen) { bestLen = l; best = k; }
    }
    const a = w.tris[f * 3 + best], b = w.tris[f * 3 + ((best + 1) % 3)], c = w.tris[f * 3 + ((best + 2) % 3)];
    const others = (edgeFaces.get(edgeKey(a, b, nv)) ?? []).filter((g) => g !== f);
    // As in 3D Builder: a degenerate face on an open edge is deleted. In any other doubtful case
    // (non-manifold edge, inconsistent neighbour) it is left alone: better a flat face than a hole.
    if (others.length === 0) {
      kill(f);
      continue;
    }
    if (others.length !== 1) continue;
    const g = others[0];
    let d = -1, consistent = false;
    for (let k = 0; k < 3; k++) {
      const x = w.tris[g * 3 + k], y = w.tris[g * 3 + ((k + 1) % 3)];
      if (x === b && y === a) consistent = true;
      if (x !== a && x !== b) d = x;
    }
    if (!consistent) continue;
    if (d === c) {
      kill(f);
      kill(g);
      continue;
    }
    if ((edgeFaces.get(edgeKey(c, d, nv))?.length ?? 0) > 0) continue;
    // Flip a-b into c-d: (a, b, c) + (b, a, d) -> (a, d, c) + (d, b, c).
    unlink(f);
    unlink(g);
    w.tris[f * 3] = a; w.tris[f * 3 + 1] = d; w.tris[f * 3 + 2] = c;
    w.tris[g * 3] = d; w.tris[g * 3 + 1] = b; w.tris[g * 3 + 2] = c;
    link(f);
    link(g);
    fixed++;
    if (isZero(f)) queue.push(f);
    if (isZero(g)) queue.push(g);
  }
  if (dead.some(Boolean)) w.tris = w.tris.filter((_, i) => !dead[Math.floor(i / 3)]);
  return fixed;
}

/**
 * (3D Assembler) A flat face whose flip is impossible (the new diagonal already exists: a small fan
 * folded onto the long edge) is removed by merging its apex into the nearer end of its long edge,
 * when that keeps the surface 2-manifold (the two vertices share exactly the two neighbours of
 * their common edge). 3D Builder leaves these faces.
 */
function collapseCaps(w: Work, grid: number): number {
  const p = w.pos;
  const nv = p.length / 3;
  const nt = w.tris.length / 3;
  const dist2 = (a: number, b: number) => (p[a * 3] - p[b * 3]) ** 2 + (p[a * 3 + 1] - p[b * 3 + 1]) ** 2 + (p[a * 3 + 2] - p[b * 3 + 2]) ** 2;
  const nbr: Set<number>[] = Array.from({ length: nv }, () => new Set());
  for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) {
    const a = w.tris[f * 3 + k], b = w.tris[f * 3 + ((k + 1) % 3)];
    nbr[a].add(b);
    nbr[b].add(a);
  }
  const map = new Int32Array(nv).map((_, i) => i);
  const touched = new Uint8Array(nv);
  let fixed = 0;
  for (let f = 0; f < nt; f++) {
    const t = [w.tris[f * 3], w.tris[f * 3 + 1], w.tris[f * 3 + 2]];
    if (t.some((v) => touched[v])) continue;
    let longest = 0, k0 = 0;
    for (let k = 0; k < 3; k++) {
      const l = dist2(t[k], t[(k + 1) % 3]);
      if (l > longest) { longest = l; k0 = k; }
    }
    if (Math.hypot(...faceNormal(w, f)) > (grid / 2) * Math.sqrt(longest)) continue;
    const a = t[k0], b = t[(k0 + 1) % 3], c = t[(k0 + 2) % 3];
    const x = dist2(c, a) <= dist2(c, b) ? a : b;
    // Link condition: exactly two common neighbours.
    let common = 0;
    for (const v of nbr[c]) if (nbr[x].has(v)) common++;
    if (common !== 2) continue;
    map[c] = x;
    for (const v of [a, b, c, ...nbr[c]]) touched[v] = 1;
    fixed++;
  }
  if (!fixed) return 0;
  const out: number[] = [];
  const origin: number[] = [];
  for (let f = 0; f < nt; f++) {
    const a = map[w.tris[f * 3]], b = map[w.tris[f * 3 + 1]], c = map[w.tris[f * 3 + 2]];
    if (a === b || b === c || a === c) continue;
    out.push(a, b, c);
    if (w.origin) origin.push(w.origin[f]);
  }
  w.tris = out;
  if (w.origin) w.origin = origin;
  return fixed;
}

/**
 * Merges the two ends of every edge shorter than `minLen` (needle triangles). Unlike a weld,
 * only vertices already joined by an edge are merged, so the surface is not pinched.
 */
function collapseShortEdges(w: Work, minLen: number): number {
  const p = w.pos;
  const len = (a: number, b: number) => Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
  const short: [number, number, number][] = [];
  const nt = w.tris.length / 3;
  for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) {
    const a = w.tris[f * 3 + k], b = w.tris[f * 3 + ((k + 1) % 3)];
    if (a < b && len(a, b) < minLen) short.push([len(a, b), a, b]);
  }
  if (!short.length) return 0;
  short.sort((x, y) => x[0] - y[0]);
  // Vertex -> incident faces, kept up to date while collapsing.
  const inc = new Map<number, Set<number>>();
  for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) {
    const v = w.tris[f * 3 + k];
    let s = inc.get(v);
    if (!s) inc.set(v, (s = new Set()));
    s.add(f);
  }
  const dead = new Uint8Array(nt);
  const neighbours = (v: number) => {
    const out = new Set<number>();
    for (const f of inc.get(v) ?? []) for (let k = 0; k < 3; k++) if (w.tris[f * 3 + k] !== v) out.add(w.tris[f * 3 + k]);
    return out;
  };
  let collapsed = 0;
  for (const [, a, b] of short) {
    const fa = inc.get(a), fb = inc.get(b);
    if (!fa || !fb || !fa.size || !fb.size) continue;
    const shared = [...fa].filter((f) => fb.has(f));
    if (!shared.length || len(a, b) >= minLen) continue; // no longer an edge, or grown
    // Link condition: common neighbours must be exactly the apexes of the edge's faces.
    const apex = new Set<number>();
    for (const f of shared) for (let k = 0; k < 3; k++) {
      const v = w.tris[f * 3 + k];
      if (v !== a && v !== b) apex.add(v);
    }
    const na = neighbours(a), nb = neighbours(b);
    let ok = true;
    for (const v of na) if (v !== b && nb.has(v) && !apex.has(v)) { ok = false; break; }
    if (!ok) continue;
    for (const f of shared) {
      dead[f] = 1;
      for (let k = 0; k < 3; k++) inc.get(w.tris[f * 3 + k])?.delete(f);
    }
    for (const f of [...fb]) {
      for (let k = 0; k < 3; k++) if (w.tris[f * 3 + k] === b) w.tris[f * 3 + k] = a;
      fa.add(f);
    }
    fb.clear();
    collapsed++;
  }
  if (dead.some(Boolean)) {
    const origin: number[] = [];
    const tris: number[] = [];
    for (let f = 0; f < nt; f++) {
      if (dead[f]) continue;
      tris.push(w.tris[f * 3], w.tris[f * 3 + 1], w.tris[f * 3 + 2]);
      if (w.origin) origin.push(w.origin[f]);
    }
    w.tris = tris;
    if (w.origin) w.origin = origin;
  }
  return collapsed + dropCollapsed(w);
}

/** Same-orientation copies keep one face; opposite pairs (zero-thickness walls) drop both. */
function removeDuplicates(w: Work): number {
  const nt = w.tris.length / 3;
  // Bucket by a hash of the sorted vertex triple; only colliding buckets are compared exactly.
  const sorted = new Int32Array(nt * 3);
  const buckets = new Map<number, number[]>();
  for (let f = 0; f < nt; f++) {
    let a = w.tris[f * 3], b = w.tris[f * 3 + 1], c = w.tris[f * 3 + 2];
    if (a > b) [a, b] = [b, a];
    if (b > c) [b, c] = [c, b];
    if (a > b) [a, b] = [b, a];
    sorted[f * 3] = a; sorted[f * 3 + 1] = b; sorted[f * 3 + 2] = c;
    const h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) | 0;
    const l = buckets.get(h);
    if (l) l.push(f);
    else buckets.set(h, [f]);
  }
  const groups: number[][] = [];
  for (const l of buckets.values()) {
    if (l.length < 2) continue;
    const exact = new Map<string, number[]>();
    for (const f of l) {
      const key = `${sorted[f * 3]},${sorted[f * 3 + 1]},${sorted[f * 3 + 2]}`;
      const g = exact.get(key);
      if (g) g.push(f);
      else exact.set(key, [f]);
    }
    for (const g of exact.values()) if (g.length > 1) groups.push(g);
  }
  const drop = new Uint8Array(nt);
  let removed = 0;
  for (const g of groups) {
    const parity = (f: number) => {
      const [a, b, c] = w.tris.slice(f * 3, f * 3 + 3);
      // even permutation of the sorted order means same orientation
      return (a < b ? 1 : 0) + (b < c ? 1 : 0) + (c < a ? 1 : 0) === 2 ? 1 : 0;
    };
    const pos = g.filter((f) => parity(f) === 1);
    const neg = g.filter((f) => parity(f) === 0);
    const pairs = Math.min(pos.length, neg.length);
    const keep: number[] = [];
    if (pos.length > pairs) keep.push(pos[pairs]);
    if (neg.length > pairs) keep.push(neg[pairs]);
    for (const f of g) {
      if (!keep.includes(f)) {
        drop[f] = 1;
        removed++;
      }
    }
  }
  if (removed) w.tris = w.tris.filter((_, i) => !drop[Math.floor(i / 3)]);
  return removed;
}

/**
 * Makes winding consistent inside each manifold patch. Faces of a patch (joined across 2-face
 * edges) get one of two labels by relative orientation; the label covering the smaller area is
 * flipped, as 3D Builder's engine does. Non-orientable patches are left untouched.
 */
function orient(w: Work): number {
  const nv = w.pos.length / 3;
  const nt = w.tris.length / 3;
  const edges = buildEdges(w.tris, nv);
  const label = new Uint8Array(nt); // 0 = unvisited, 1 or 2
  let flips = 0;
  const hasDirected = (f: number, a: number, b: number) => {
    for (let k = 0; k < 3; k++) if (w.tris[f * 3 + k] === a && w.tris[f * 3 + ((k + 1) % 3)] === b) return true;
    return false;
  };
  const area = (f: number) => Math.hypot(...faceNormal(w, f)) / 2;
  for (let seed = 0; seed < nt; seed++) {
    if (label[seed]) continue;
    label[seed] = 1;
    const patch = [seed];
    const areas = [0, area(seed), 0];
    let orientable = true;
    for (let i = 0; i < patch.length; i++) {
      const f = patch[i];
      for (let k = 0; k < 3; k++) {
        const a = w.tris[f * 3 + k], b = w.tris[f * 3 + ((k + 1) % 3)];
        const e = edges.get(edgeKey(a, b, nv))!;
        if (e.faces.length !== 2) continue;
        const g = e.faces[0] === f ? e.faces[1] : e.faces[0];
        // Consistent neighbours run the shared edge in opposite directions.
        const want = hasDirected(g, a, b) ? 3 - label[f] : label[f];
        if (!label[g]) {
          label[g] = want;
          areas[want] += area(g);
          patch.push(g);
        } else if (label[g] !== want) {
          orientable = false;
        }
      }
    }
    if (!orientable) continue;
    const flipLabel = areas[2] <= areas[1] ? 2 : 1;
    for (const f of patch) {
      if (label[f] !== flipLabel) continue;
      const t1 = w.tris[f * 3 + 1];
      w.tris[f * 3 + 1] = w.tris[f * 3 + 2];
      w.tris[f * 3 + 2] = t1;
      flips++;
    }
  }
  return flips;
}

/**
 * T-junctions: a boundary vertex lying on the interior of another open edge splits that edge's
 * face, so the next weld can join the two sides (second stage of 3D Builder's gap stitcher).
 */
function stitchTJunctions(w: Work, tol: number): number {
  let total = 0;
  // One split per face and per pass: a long edge with many points on it needs as many passes.
  for (let pass = 0; pass < 256; pass++) {
    const nv = w.pos.length / 3;
    const edges = buildEdges(w.tris, nv);
    const open = [...edges.values()].filter((e) => e.faces.length === 1);
    if (!open.length) break;
    const verts = new Set<number>();
    for (const e of open) verts.add(e.a).add(e.b);
    // Grid of open edges by their bounding boxes; cells about one average edge long.
    const p = w.pos;
    let avg = 0;
    for (const e of open) avg += Math.hypot(p[e.a * 3] - p[e.b * 3], p[e.a * 3 + 1] - p[e.b * 3 + 1], p[e.a * 3 + 2] - p[e.b * 3 + 2]);
    const cell = Math.max(tol * 4, avg / open.length, 1e-9);
    const grid = new Map<string, number[]>();
    open.forEach((e, i) => {
      const lo = [0, 1, 2].map((k) => Math.floor((Math.min(p[e.a * 3 + k], p[e.b * 3 + k]) - tol) / cell));
      const hi = [0, 1, 2].map((k) => Math.floor((Math.max(p[e.a * 3 + k], p[e.b * 3 + k]) + tol) / cell));
      if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 4096) return; // very long edge: skip
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
        const key = `${x},${y},${z}`;
        const list = grid.get(key);
        if (list) list.push(i);
        else grid.set(key, [i]);
      }
    });
    const splitFace = new Set<number>();
    const splits: { f: number; a: number; b: number; v: number }[] = [];
    for (const v of verts) {
      const key = [0, 1, 2].map((k) => Math.floor(p[v * 3 + k] / cell)).join(',');
      let best: { e: (typeof open)[number]; d: number } | null = null;
      for (const i of grid.get(key) ?? []) {
        const e = open[i];
        if (e.a === v || e.b === v) continue;
        const ab = [0, 1, 2].map((k) => p[e.b * 3 + k] - p[e.a * 3 + k]);
        const av = [0, 1, 2].map((k) => p[v * 3 + k] - p[e.a * 3 + k]);
        const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
        if (len2 === 0) continue;
        const t = (av[0] * ab[0] + av[1] * ab[1] + av[2] * ab[2]) / len2;
        if (t <= 0.001 || t >= 0.999) continue;
        const d = Math.hypot(av[0] - t * ab[0], av[1] - t * ab[1], av[2] - t * ab[2]);
        if (d <= tol && (!best || d < best.d)) best = { e, d };
      }
      if (best && !splitFace.has(best.e.faces[0])) {
        splitFace.add(best.e.faces[0]);
        splits.push({ f: best.e.faces[0], a: best.e.a, b: best.e.b, v });
      }
    }
    if (!splits.length) break;
    for (const s of splits) {
      // Face (x, y, c) with edge x->y equal to {a, b}: replace by (x, v, c) and (v, y, c).
      for (let k = 0; k < 3; k++) {
        const x = w.tris[s.f * 3 + k], y = w.tris[s.f * 3 + ((k + 1) % 3)], c = w.tris[s.f * 3 + ((k + 2) % 3)];
        if ((x === s.a && y === s.b) || (x === s.b && y === s.a)) {
          w.tris[s.f * 3] = x; w.tris[s.f * 3 + 1] = s.v; w.tris[s.f * 3 + 2] = c;
          w.tris.push(s.v, y, c);
          w.origin?.push(w.origin[s.f]);
          break;
        }
      }
    }
    total += splits.length;
  }
  return total;
}

/**
 * Makes the surface 2-manifold. At an edge shared by more than two faces, faces are sorted by
 * angle around the edge and each one is paired with the neighbour that closes a solid wedge;
 * then every vertex whose faces form several separate fans (including "bow-tie" vertices) is
 * duplicated once per extra fan. Returns the number of non-manifold edges resolved.
 */
function splitNonManifold(w: Work): number {
  const nv = w.pos.length / 3;
  const nt = w.tris.length / 3;
  const edges = buildEdges(w.tris, nv);
  const p = w.pos;
  // partner[f*3+k] = face across edge k of face f (edge k runs from corner k to k+1), or -1.
  const partner = new Int32Array(nt * 3).fill(-1);
  const slot = (f: number, a: number, b: number) => {
    for (let k = 0; k < 3; k++) {
      const x = w.tris[f * 3 + k], y = w.tris[f * 3 + ((k + 1) % 3)];
      if ((x === a && y === b) || (x === b && y === a)) return f * 3 + k;
    }
    return -1;
  };
  const link = (f: number, g: number, a: number, b: number) => {
    partner[slot(f, a, b)] = g;
    partner[slot(g, a, b)] = f;
  };
  let resolved = 0;
  for (const e of edges.values()) {
    if (e.faces.length === 2) {
      link(e.faces[0], e.faces[1], e.a, e.b);
      continue;
    }
    if (e.faces.length < 3) continue;
    resolved++;
    const a = e.a, b = e.b;
    const d = norm([p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]]);
    const u1 = norm(cross(Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], d));
    const u2 = cross(d, u1);
    const fans = e.faces.map((f) => {
      let c = -1, forward = false;
      for (let k = 0; k < 3; k++) {
        const x = w.tris[f * 3 + k], y = w.tris[f * 3 + ((k + 1) % 3)];
        if (x === a && y === b) forward = true;
        if (x !== a && x !== b) c = x;
      }
      const v = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]];
      return { f, forward, angle: Math.atan2(v[0] * u2[0] + v[1] * u2[1] + v[2] * u2[2], v[0] * u1[0] + v[1] * u1[1] + v[2] * u1[2]) };
    }).sort((x, y) => x.angle - y.angle);
    // An outward face using a->b has the solid on its lower-angle side, a face using b->a on its
    // higher-angle side: a solid wedge runs from a backward face to the next forward face.
    const paired = new Set<number>();
    const n = fans.length;
    for (let i = 0; i < n; i++) {
      const x = fans[i], y = fans[(i + 1) % n];
      if (!x.forward && y.forward && !paired.has(x.f) && !paired.has(y.f)) {
        link(x.f, y.f, a, b);
        paired.add(x.f).add(y.f);
      }
    }
    // Inconsistent leftovers: pair angular neighbours with opposite directions.
    for (let i = 0; i < n; i++) {
      const x = fans[i], y = fans[(i + 1) % n];
      if (x.forward !== y.forward && !paired.has(x.f) && !paired.has(y.f)) {
        link(x.f, y.f, a, b);
        paired.add(x.f).add(y.f);
      }
    }
  }

  // Split vertices whose incident faces are not all connected through partnered edges.
  // (Open-edge flags are taken now: splitting renames vertices, which the edge map does not know.)
  const openSlot = new Uint8Array(nt * 3);
  for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) {
    if (edges.get(edgeKey(w.tris[f * 3 + k], w.tris[f * 3 + ((k + 1) % 3)], nv))?.faces.length === 1) openSlot[f * 3 + k] = 1;
  }
  const incident: number[][] = Array.from({ length: nv }, () => []);
  for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) incident[w.tris[f * 3 + k]].push(f);
  const extra: number[] = [];
  let next = nv;
  for (let v = 0; v < nv; v++) {
    const faces = incident[v];
    if (faces.length < 2) continue;
    const comp = new Map<number, number>();
    const open: boolean[] = []; // fan touches an open edge at v (a hole, not a pinch)
    let ncomp = 0;
    for (const start of faces) {
      if (comp.has(start)) continue;
      const stack = [start];
      comp.set(start, ncomp);
      open[ncomp] = false;
      while (stack.length) {
        const f = stack.pop()!;
        for (let k = 0; k < 3; k++) {
          // edges of f touching v: (k, k+1) when corner k or k+1 is v
          const x = w.tris[f * 3 + k], y = w.tris[f * 3 + ((k + 1) % 3)];
          if (x !== v && y !== v) continue;
          const g = partner[f * 3 + k];
          if (g < 0) {
            if (openSlot[f * 3 + k]) open[ncomp] = true;
          } else if (!comp.has(g)) {
            comp.set(g, ncomp);
            stack.push(g);
          }
        }
      }
      ncomp++;
    }
    if (ncomp < 2) continue;
    // Fans separated only by holes stay joined (filling the holes reconnects them); every closed
    // fan, and every fan cut off by a non-manifold edge, gets its own vertex.
    const ids: number[] = [];
    let keptOriginal = false;
    const openId = open.some(Boolean) ? v : -1;
    if (openId === v) keptOriginal = true;
    for (let c = 0; c < ncomp; c++) {
      if (open[c]) ids.push(v);
      else if (!keptOriginal) {
        ids.push(v);
        keptOriginal = true;
      } else {
        ids.push(next++);
        extra.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
      }
    }
    for (const f of faces) {
      const id = ids[comp.get(f)!];
      if (id === v) continue;
      for (let k = 0; k < 3; k++) if (w.tris[f * 3 + k] === v) w.tris[f * 3 + k] = id;
    }
  }
  if (extra.length) {
    const np = new Float64Array(p.length + extra.length);
    np.set(p);
    np.set(extra, p.length);
    w.pos = np;
  }
  return resolved;
}

/** Fills boundary loops of at most `maxLen` vertices (3 = "trivial" holes only). */
function closeHoles(w: Work, maxLen: number): number {
  const nv = w.pos.length / 3;
  const edges = buildEdges(w.tris, nv);
  const loops = boundaryLoops(w.tris, nv, edges).flatMap(splitAtRepeats).filter((l) => l.length >= 3 && l.length <= maxLen);
  // Key base leaves room for one new centroid vertex per loop.
  const base = nv + loops.length;
  const used = new Set<number>();
  for (const e of edges.values()) used.add(edgeKey(e.a, e.b, base));
  const extra: number[] = [];
  for (const loop of loops) {
    // Boundary edges run a->b in their face; the patch must use b->a, so fill the reversed loop.
    const poly = [...loop].reverse();
    const tris = poly.length === 3 ? [poly[0], poly[1], poly[2]] : triangulateLoop(w, poly, extra, used, base);
    w.tris.push(...tris);
  }
  if (extra.length) {
    const np = new Float64Array(w.pos.length + extra.length);
    np.set(w.pos);
    np.set(extra, w.pos.length);
    w.pos = np;
  }
  return loops.length;
}

/** Splits a boundary walk that passes twice through a vertex (holes touching at a corner). */
function splitAtRepeats(loop: number[]): number[][] {
  const out: number[][] = [];
  const stack: number[] = [];
  const at = new Map<number, number>();
  for (const v of loop) {
    const prev = at.get(v);
    if (prev !== undefined) {
      const sub = stack.splice(prev + 1);
      for (const u of sub) at.delete(u);
      if (sub.length >= 2) out.push([v, ...sub]);
    } else {
      at.set(v, stack.length);
      stack.push(v);
    }
  }
  out.push(stack);
  return out;
}

/**
 * Minimum-area triangulation of the boundary loop by dynamic programming (the method 3D Builder
 * uses: weight = triangle area, near-degenerate triangles penalised). Diagonals that already
 * exist elsewhere in the mesh are penalised too, so the patch stays manifold. Very large loops
 * fall back to ear clipping, then a centroid fan.
 */
function triangulateLoop(w: Work, poly: number[], extra: number[], used: Set<number>, base: number): number[] {
  const n = poly.length;
  if (n <= 400) {
    const tris = minAreaTriangulation(w, poly, used, base);
    for (let i = 0; i < tris.length; i += 3) {
      used.add(edgeKey(tris[i], tris[i + 1], base)).add(edgeKey(tris[i + 1], tris[i + 2], base)).add(edgeKey(tris[i + 2], tris[i], base));
    }
    return tris;
  }
  return earClipLoop(w, poly, extra, used, base);
}

function minAreaTriangulation(w: Work, poly: number[], used: Set<number>, base: number): number[] {
  const n = poly.length;
  const p = w.pos;
  const W = new Float64Array(n * n);
  const split = new Int32Array(n * n).fill(-1);
  const diagonalPenalty = (x: number, y: number) =>
    y - x > 1 && !(x === 0 && y === n - 1) && used.has(edgeKey(poly[x], poly[y], base)) ? 1e6 : 0;
  const weight = (i: number, k: number, j: number) => {
    const a = poly[i] * 3, b = poly[k] * 3, c = poly[j] * 3;
    const ux = p[a] - p[c], uy = p[a + 1] - p[c + 1], uz = p[a + 2] - p[c + 2];
    const vx = p[b] - p[c], vy = p[b + 1] - p[c + 1], vz = p[b + 2] - p[c + 2];
    const cr = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    return (cr < 1e-4 ? 10000 : 0.5 * cr) + diagonalPenalty(i, k) + diagonalPenalty(k, j);
  };
  for (let len = 2; len < n; len++) {
    for (let i = 0; i + len < n; i++) {
      const j = i + len;
      let best = Infinity, bestK = -1;
      for (let k = i + 1; k < j; k++) {
        const v = W[i * n + k] + W[k * n + j] + weight(i, k, j);
        if (v < best) { best = v; bestK = k; }
      }
      W[i * n + j] = best;
      split[i * n + j] = bestK;
    }
  }
  const out: number[] = [];
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    if (j - i < 2) continue;
    const k = split[i * n + j];
    out.push(poly[i], poly[k], poly[j]);
    stack.push([i, k], [k, j]);
  }
  return out;
}

function earClipLoop(w: Work, poly: number[], extra: number[], used: Set<number>, base: number): number[] {
  const p = w.pos;
  const n = [0, 0, 0];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] * 3, b = poly[(i + 1) % poly.length] * 3;
    n[0] += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2]);
    n[1] += (p[a + 2] - p[b + 2]) * (p[a] + p[b]);
    n[2] += (p[a] - p[b]) * (p[a + 1] + p[b + 1]);
  }
  const len = Math.hypot(n[0], n[1], n[2]);
  if (len > 0 && poly.length <= 2000) {
    n[0] /= len; n[1] /= len; n[2] /= len;
    const u = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const ex = norm(cross(u, n));
    const ey = cross(n, ex);
    const pts = poly.map((v) => [dot(ex, p, v), dot(ey, p, v)]);
    // Never add a diagonal that already exists as an edge: it would become non-manifold.
    const allowed = (i: number, j: number) => !used.has(edgeKey(poly[i], poly[j], base));
    const ears = earClip(pts, allowed);
    if (ears) {
      const tris = ears.map((i) => poly[i]);
      for (let i = 0; i < tris.length; i += 3) {
        used.add(edgeKey(tris[i], tris[i + 1], base)).add(edgeKey(tris[i + 1], tris[i + 2], base)).add(edgeKey(tris[i + 2], tris[i], base));
      }
      return tris;
    }
  }
  // Fan around a new centroid vertex.
  const c = [0, 0, 0];
  for (const v of poly) for (let k = 0; k < 3; k++) c[k] += p[v * 3 + k] / poly.length;
  const id = (p.length + extra.length) / 3;
  extra.push(c[0], c[1], c[2]);
  const out: number[] = [];
  for (let i = 0; i < poly.length; i++) out.push(poly[i], poly[(i + 1) % poly.length], id);
  return out;
}

function earClip(pts: number[][], allowed: (i: number, j: number) => boolean = () => true): number[] | null {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  const sign = area >= 0 ? 1 : -1;
  const idx = Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  const crossZ = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      if (crossZ(a, b, c) * sign <= 0) continue;
      if (idx.length > 3 && !allowed(ia, ic)) continue;
      let inside = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        const q = pts[j];
        if (crossZ(a, b, q) * sign > 0 && crossZ(b, c, q) * sign > 0 && crossZ(c, a, q) * sign > 0) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null;
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

/** Drops shells whose absolute enclosed volume is below `minVolume` (never all of them). */
function removeTinyShells(w: Work, minVolume: number): number {
  const nv = w.pos.length / 3;
  const label = shells(w.tris, nv);
  const vol = new Map<number, number>();
  for (let f = 0; f < label.length; f++) vol.set(label[f], (vol.get(label[f]) ?? 0) + faceVolume(w, f));
  if (vol.size < 2) return 0;
  const drop = new Set<number>();
  for (const [id, v] of vol) if (Math.abs(v) < minVolume) drop.add(id);
  if (drop.size === vol.size) return 0;
  w.tris = w.tris.filter((_, i) => !drop.has(label[Math.floor(i / 3)]));
  return drop.size;
}

/** Shells nested an even number of times must enclose positive volume, odd ones negative (cavities). */
function orientShellsOutward(w: Work): number {
  const nv = w.pos.length / 3;
  const label = shells(w.tris, nv);
  const groups = new Map<number, number[]>();
  for (let f = 0; f < label.length; f++) {
    const g = groups.get(label[f]);
    if (g) g.push(f);
    else groups.set(label[f], [f]);
  }
  const list = [...groups.values()];
  const checkNesting = list.length > 1 && list.length <= 64;
  const boxes = list.map((faces) => shellBox(w, faces));
  let inverted = 0;
  for (const [i, faces] of list.entries()) {
    let v = 0;
    for (const f of faces) v += faceVolume(w, f);
    let depth = 0;
    if (checkNesting) {
      // A cavity lies strictly inside its container's box; probe a point just under the surface.
      const probe = probePoint(w, faces, v);
      for (const [j, other] of list.entries()) {
        if (j !== i && boxInside(boxes[i], boxes[j]) && insideShell(w, other, probe)) depth++;
      }
    }
    const wantPositive = depth % 2 === 0;
    if ((v < 0) === wantPositive) {
      for (const f of faces) {
        const t1 = w.tris[f * 3 + 1];
        w.tris[f * 3 + 1] = w.tris[f * 3 + 2];
        w.tris[f * 3 + 2] = t1;
      }
      inverted++;
    }
  }
  return inverted;
}

type Box = { min: number[]; max: number[] };

function shellBox(w: Work, faces: number[]): Box {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const f of faces) {
    for (let k = 0; k < 3; k++) {
      const v = w.tris[f * 3 + k];
      for (let a = 0; a < 3; a++) {
        const x = w.pos[v * 3 + a];
        if (x < min[a]) min[a] = x;
        if (x > max[a]) max[a] = x;
      }
    }
  }
  return { min, max };
}

const boxInside = (a: Box, b: Box) => [0, 1, 2].every((k) => a.min[k] > b.min[k] && a.max[k] < b.max[k]);

/** Centroid of the largest face, nudged a hair to the inside of the shell. */
function probePoint(w: Work, faces: number[], volume: number): number[] {
  const p = w.pos;
  let best = faces[0], bestArea = -1;
  for (const f of faces) {
    const n = faceNormal(w, f);
    const area = Math.hypot(n[0], n[1], n[2]);
    if (area > bestArea) { bestArea = area; best = f; }
  }
  const n = norm(faceNormal(w, best));
  const box = shellBox(w, faces);
  const eps = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) * 1e-4;
  const side = volume >= 0 ? -1 : 1; // inward is against the normal for an outward shell
  const c = [0, 1, 2].map((k) => (p[w.tris[best * 3] * 3 + k] + p[w.tris[best * 3 + 1] * 3 + k] + p[w.tris[best * 3 + 2] * 3 + k]) / 3);
  return [c[0] + n[0] * eps * side, c[1] + n[1] * eps * side, c[2] + n[2] * eps * side];
}

function faceNormal(w: Work, f: number): number[] {
  const p = w.pos;
  const a = w.tris[f * 3] * 3, b = w.tris[f * 3 + 1] * 3, c = w.tris[f * 3 + 2] * 3;
  return cross([p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]]);
}

/** Ray parity test along a slightly skewed +X ray. */
function insideShell(w: Work, faces: number[], o: number[]): boolean {
  const p = w.pos;
  const d = norm([1, 0.0013, 0.0007]);
  let hits = 0;
  for (const f of faces) {
    const t = rayTri(o, d, p, w.tris[f * 3], w.tris[f * 3 + 1], w.tris[f * 3 + 2]);
    if (t > 1e-12) hits++;
  }
  return hits % 2 === 1;
}

function rayTri(o: number[], d: number[], p: Float64Array, a: number, b: number, c: number): number {
  const e1 = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
  const e2 = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]];
  const h = cross(d, e2);
  const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
  if (Math.abs(det) < 1e-14) return -1;
  const inv = 1 / det;
  const s = [o[0] - p[a * 3], o[1] - p[a * 3 + 1], o[2] - p[a * 3 + 2]];
  const u = inv * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
  if (u < 0 || u > 1) return -1;
  const q = cross(s, e1);
  const vv = inv * (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]);
  if (vv < 0 || u + vv > 1) return -1;
  return inv * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]);
}

function faceVolume(w: Work, f: number): number {
  const p = w.pos;
  const a = w.tris[f * 3] * 3, b = w.tris[f * 3 + 1] * 3, c = w.tris[f * 3 + 2] * 3;
  return (
    (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6
  );
}

function compact(w: Work): MeshData {
  const nv = w.pos.length / 3;
  const remap = new Int32Array(nv).fill(-1);
  const pos: number[] = [];
  const idx = new Uint32Array(w.tris.length);
  for (let i = 0; i < w.tris.length; i++) {
    const v = w.tris[i];
    if (remap[v] < 0) {
      remap[v] = pos.length / 3;
      pos.push(w.pos[v * 3], w.pos[v * 3 + 1], w.pos[v * 3 + 2]);
    }
    idx[i] = remap[v];
  }
  return { positions: new Float32Array(pos), indices: idx };
}

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dot = (e: number[], p: Float64Array, v: number) => e[0] * p[v * 3] + e[1] * p[v * 3 + 1] + e[2] * p[v * 3 + 2];
