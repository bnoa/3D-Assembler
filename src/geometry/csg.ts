// Solid operations backed by manifold-3d (WASM).
import Module, { type Manifold, type ManifoldToplevel } from 'manifold-3d';
import { type MeshData, bounds, merged, size } from '../core/mesh-data';
import { cleanMesh, forceFixDegenerates, repairMesh } from '../repair/repair';
import { analyze } from '../repair/analyze';
import { HollowError, hollowMesh } from './hollow';
import { ExtrudeDownError, extrudeDownApplyMesh, extrudeDownMesh } from './extrude-down';
import { type BooleanOp, booleanMesh, countSelfIntersections } from '../repair/wrap';
import { transferFaceColors } from '../repair/colors';
import { type CutPiece, type CutResult, planeCut } from './plane-cut';

let toplevel: Promise<ManifoldToplevel> | null = null;

export function loadManifold(locateWasm?: string): Promise<ManifoldToplevel> {
  if (!toplevel) {
    toplevel = Module(locateWasm ? { locateFile: () => locateWasm } : undefined).then((m) => {
      m.setup();
      return m;
    });
  }
  return toplevel;
}

export class SolidError extends Error {}

async function api() {
  return loadManifold();
}

/** Builds a Manifold; invalid input is repaired once before giving up. */
export async function toManifold(mesh: MeshData): Promise<Manifold> {
  const wasm = await api();
  const make = (m: MeshData) => {
    const mm = new wasm.Mesh({ numProp: 3, vertProperties: m.positions, triVerts: m.indices });
    mm.merge();
    return new wasm.Manifold(mm);
  };
  let solid = make(mesh);
  if (solid.status() !== 'NoError') {
    solid.delete();
    solid = make(repairMesh(mesh).mesh);
    if (solid.status() !== 'NoError') {
      const status = solid.status();
      solid.delete();
      throw new SolidError(`Objet non valide (${status}). Réparez-le avant cette opération.`);
    }
  }
  return solid;
}

export function fromManifold(solid: Manifold): MeshData {
  const m = solid.getMesh();
  const np = m.numProp;
  const nv = m.vertProperties.length / np;
  const positions = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    positions[i * 3] = m.vertProperties[i * np];
    positions[i * 3 + 1] = m.vertProperties[i * np + 1];
    positions[i * 3 + 2] = m.vertProperties[i * np + 2];
  }
  return { positions, indices: new Uint32Array(m.triVerts) };
}

async function withSolids<T>(meshes: MeshData[], fn: (s: Manifold[], wasm: ManifoldToplevel) => T): Promise<T> {
  const wasm = await api();
  const solids: Manifold[] = [];
  try {
    for (const m of meshes) solids.push(await toManifold(m));
    return fn(solids, wasm);
  } finally {
    for (const s of solids) s.delete();
  }
}

/**
 * Converts a result and releases it. Boolean outputs may contain zero-area slivers (valid for
 * manifold, flagged by 3D Builder): they go through the repair chain, which flips them away.
 */
function take(result: Manifold): MeshData {
  try {
    return clean(fromManifold(result));
  } finally {
    result.delete();
  }
}

export function clean(m: MeshData): MeshData {
  const score = (r: ReturnType<typeof analyze>) =>
    r.ok ? 0 : 1 + 4 * (r.openEdges + r.nonManifoldEdges + r.flippedEdges) + r.degenerateFaces + r.duplicateFaces;
  const candidates: { mesh: MeshData; s: number }[] = [];
  const consider = (mesh: MeshData) => {
    const s = score(analyze(mesh));
    candidates.push({ mesh, s });
    return s === 0;
  };
  // 1. gentle pass; 2. force out remaining flat faces; 3. full repair chain. Keep the healthiest.
  const gentle = cleanMesh(m);
  if (!gentle.indices.length || consider(gentle)) return gentle;
  const forced = forceFixDegenerates(gentle);
  if (consider(forced)) return forced;
  const full = repairMesh(gentle).mesh;
  if (consider(full)) return full;
  if (consider(forceFixDegenerates(full))) return candidates[candidates.length - 1].mesh;
  return candidates.reduce((a, b) => (b.s < a.s ? b : a)).mesh;
}

/**
 * Boolean of two solids with 3D Builder's method (see booleanMesh in repair/wrap.ts); an invalid
 * result goes through the repair, as in 3D Builder. Unused vertices are dropped.
 */
export async function booleanPair(a: MeshData, b: MeshData, op: BooleanOp): Promise<MeshData> {
  let m = await booleanMesh(a, b, op);
  if (m.indices.length && !analyze(m).ok) {
    const { repairSolid } = await import('../repair/solid');
    m = (await repairSolid(m)).mesh;
    // Last resort, so a boolean never hands back a broken object (e.g. parts touching at a point).
    if (!analyze(m).ok) {
      try {
        m = op === 'union' ? await union([a, b]) : op === 'intersect' ? await intersection([a, b]) : await subtract(a, [b]);
      } catch { /* keep the repaired result */ }
    }
  }
  const remap = new Int32Array(m.positions.length / 3).fill(-1);
  const pos: number[] = [];
  const idx = new Uint32Array(m.indices.length);
  for (let i = 0; i < idx.length; i++) {
    const v = m.indices[i];
    if (remap[v] < 0) { remap[v] = pos.length / 3; pos.push(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]); }
    idx[i] = remap[v];
  }
  return { positions: new Float32Array(pos), indices: idx };
}

export const union = (meshes: MeshData[]) =>
  withSolids(meshes, (s, w) => take(w.Manifold.union(s)));

export const intersection = (meshes: MeshData[]) =>
  withSolids(meshes, (s, w) => take(w.Manifold.intersection(s)));

/** Removes every tool from the base. */
export const subtract = (base: MeshData, tools: MeshData[]) =>
  withSolids([base, ...tools], (s, w) => {
    const tool = w.Manifold.union(s.slice(1));
    try {
      return take(s[0].subtract(tool));
    } finally {
      tool.delete();
    }
  });

/** Cuts with the plane z = height (world). Returns [above, below]; either may be empty. */
export const splitByZ = (mesh: MeshData, height: number) => splitByPlane(mesh, [0, 0, 1], height);

/**
 * 3D Builder's split (plane-cut.ts): halves on the normal side and the other side, each as its
 * connected pieces. A cap the monotone sweep cannot handle falls back to manifold's
 * triangulation. Slivers left by vertices a hair off the plane are removed by the light cleanup
 * (3D Builder leaves them; 3D Assembler would flag the pieces invalid).
 */
export async function splitPlane(mesh: MeshData, normal: [number, number, number], point: [number, number, number], faceColors?: Uint32Array): Promise<CutResult> {
  const wasm = await api();
  const fallback = (pts: [number, number][], rings: number[][]) => {
    try {
      return wasm.triangulate(rings.map((r) => r.map((i) => pts[i])), 0).map(([a, b, c]: number[]) => {
        const flat = rings.flat();
        return [flat[a], flat[b], flat[c]] as [number, number, number];
      });
    } catch {
      return [];
    }
  };
  const r = planeCut(mesh, normal, point, faceColors, fallback);
  const tidy = (p: CutPiece): CutPiece => {
    const a = analyze(p.mesh);
    if (a.ok || a.openEdges || a.nonManifoldEdges) return p;
    const m = forceFixDegenerates(cleanMesh(p.mesh));
    return { mesh: m, faceColors: p.faceColors && transferFaceColors(p.mesh, p.faceColors, m) };
  };
  return { above: r.above.map(tidy), below: r.below.map(tidy) };
}

/** Cuts with the plane normal·x = offset. Returns [on the normal side, other side]. */
export const splitByPlane = (mesh: MeshData, normal: [number, number, number], offset: number) =>
  withSolids([mesh], (s) => {
    const [above, below] = s[0].splitByPlane(normal, offset);
    return [take(above), take(below)] as const;
  });

/** Vertices of the convex hull. */
export const hullPoints = (mesh: MeshData) =>
  withSolids([mesh], (s) => {
    const h = take(s[0].hull());
    const out: [number, number, number][] = [];
    for (let i = 0; i < h.positions.length; i += 3) out.push([h.positions[i], h.positions[i + 1], h.positions[i + 2]]);
    return out;
  });

/** Subdivides until every edge is shorter than `length` (finer textures and paint). */
export const refine = (mesh: MeshData, length: number) =>
  withSolids([mesh], (s) => take(s[0].refineToLength(length)));

/** Splits into disconnected parts. */
export const decompose = (mesh: MeshData) =>
  withSolids([mesh], (s) => s[0].decompose().map(take));

/** Mesh decimation; `level` 0..1 maps to an edge-collapse tolerance relative to the object size. */
export const simplify = (mesh: MeshData, level: number) =>
  withSolids([mesh], (s) => {
    const d = Math.hypot(...size(bounds(mesh)));
    return take(s[0].simplify(level * level * d * 0.05));
  });

/** Subdivision smoothing; `sharpAngle` keeps edges sharper than this (degrees) crisp. */
export const smooth = (mesh: MeshData, level: number, smoothEdges: boolean) =>
  withSolids([mesh], (s) => {
    const smoothed = s[0].smoothOut(smoothEdges ? 180 : 60, level / 10);
    try {
      return take(smoothed.refine(Math.max(1, Math.round(1 + level / 2))));
    } finally {
      smoothed.delete();
    }
  });

/** Hollows as 3D Builder does (see hollow.ts): blocky inner cavity appended to the surface. */
export async function hollow(mesh: MeshData, thickness: number): Promise<MeshData> {
  try {
    return hollowMesh(mesh, thickness);
  } catch (e) {
    if (e instanceof HollowError) throw new SolidError(e.message);
    throw e;
  }
}

/**
 * Extrude down, as in 3D Builder (see extrude-down.ts): downward faces below `limit` (world Z)
 * flattened onto the plate with walls, then the repair when the result needs it (overlapping
 * flattened regions); the colours follow through the repair.
 */
/**
 * Extrude down. `final` = the committed result, which 3D Builder computes differently
 * than the preview: the grey of the new faces is only added when the object already has per-face
 * colours, and the result ends with one step of the vertex-merging simplifier at t = 0.0001 (the
 * flat bottom collapses, curved parts stay).
 */
export async function extrudeDown(mesh: MeshData, limit = Infinity, faceColors?: Uint32Array, final = false): Promise<{ mesh: MeshData; faceColors?: Uint32Array }> {
  let r: { mesh: MeshData; faceColors?: Uint32Array };
  try {
    r = final ? extrudeDownApplyMesh(mesh, limit, faceColors) : extrudeDownMesh(mesh, limit, faceColors);
  } catch (e) {
    if (e instanceof ExtrudeDownError) throw new SolidError(e.message);
    throw e;
  }
  if (final) {
    const { simplifyTolerance } = await import('./simplify-passes');
    r = simplifyTolerance(r.mesh, 1e-4, faceColors ? r.faceColors : undefined, true, true);
  }
  if (analyze(r.mesh).ok && !(await countSelfIntersections(r.mesh))) return r;
  const { repairSolid } = await import('../repair/solid');
  const repaired = (await repairSolid(r.mesh)).mesh;
  return { mesh: repaired, faceColors: r.faceColors && transferFaceColors(r.mesh, r.faceColors, repaired) };
}

export function mergeMeshes(meshes: MeshData[]): MeshData {
  return merged(meshes);
}
