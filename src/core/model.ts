// Scene document: objects, selection, undo history. Geometry is immutable: every edit creates
// a new MeshData, so history snapshots can share meshes.
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { type MeshData, bounds, centered, transformed } from './mesh-data';
import { analyze, type MeshReport } from '../repair/analyze';
import type { ObjectTexture } from './texture-data';

export type Vec3 = [number, number, number];

export interface SceneObject {
  id: number;
  name: string;
  mesh: MeshData; // local coordinates, centred on the origin
  color: string;
  position: Vec3; // world position of the mesh origin (bounding-box centre)
  rotation: Vec3; // degrees, XYZ order
  scale: Vec3;
  report: MeshReport;
  /** Intersecting triangle pairs, from a background check (undefined = not checked yet). */
  selfIntersections?: number;
  /** Painted colour per face (0xRRGGBB), aligned with mesh triangles; NO_PAINT = object colour. */
  faceColors?: Uint32Array;
  /** Surface look (rendering and 3MF material name). */
  material?: MaterialKind;
  /** Real textures (wallpaper, stickers, 3MF textures), aligned with mesh triangles. */
  texture?: ObjectTexture;
}

export type MaterialKind = 'simple' | 'gloss' | 'metal' | 'translucent' | 'rubber';
export const MATERIALS: { id: MaterialKind; label: string }[] = [
  { id: 'simple', label: 'Simple' },
  { id: 'gloss', label: 'Plastique brillant' },
  { id: 'metal', label: 'Métal' },
  { id: 'translucent', label: 'Translucide' },
  { id: 'rubber', label: 'Mat (caoutchouc)' },
];

export const NO_PAINT = 0xffffffff;

/** Valid for printing: clean topology and, once checked, no self-intersections. */
export const isValid = (o: SceneObject) => o.report.ok && !o.selfIntersections;

interface Snapshot {
  objects: SceneObject[];
  selection: number[];
}

export const PALETTE = ['#3cb55a', '#3c8fd6', '#e0863a', '#c94f4f', '#8a5cc7', '#d4b43a', '#4fb8b0', '#9aa3ad'];

type Listener = () => void;

/** 3MF model metadata, as 3D Builder's "À propos de ce modèle". */
export interface ModelInfo {
  title: string;
  designer: string;
  copyright: string;
  licenseTerms: string;
  description: string;
}

export const emptyInfo = (): ModelInfo => ({ title: '', designer: '', copyright: '', licenseTerms: '', description: '' });

export class SceneDocument {
  name = 'Nouvelle scène';
  info: ModelInfo = emptyInfo();
  objects: SceneObject[] = [];
  selection = new Set<number>();
  dirty = false;
  private nextId = 1;
  private colorIndex = 0;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private listeners = new Set<Listener>();

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  // --- history ---------------------------------------------------------------------------------

  private snapshot(): Snapshot {
    return { objects: this.objects.map((o) => ({ ...o })), selection: [...this.selection] };
  }

  /** Records the current state so the next change can be undone. Call before mutating. */
  checkpoint(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
  }

  get canUndo() { return this.undoStack.length > 0; }
  /** Number of states that can be undone. */
  get undoDepth() { return this.undoStack.length; }

  /** Goes back to the state recorded at depth `depth` (undoing everything after it, not redoable). */
  rollback(depth: number): void {
    let s: Snapshot | undefined;
    while (this.undoStack.length > depth) s = this.undoStack.pop();
    this.redoStack = [];
    if (s) this.restore(s);
  }

  /** Merges every change recorded after depth `depth + 1` into one undo step. */
  squash(depth: number): void {
    if (this.undoStack.length > depth + 1) this.undoStack.length = depth + 1;
    this.redoStack = [];
  }
  get canRedo() { return this.redoStack.length > 0; }

  undo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
  }

  redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
  }

  private restore(s: Snapshot): void {
    this.objects = s.objects.map((o) => ({ ...o }));
    this.selection = new Set(s.selection.filter((id) => this.objects.some((o) => o.id === id)));
    this.emit();
  }

  reset(name = 'Nouvelle scène'): void {
    this.objects = [];
    this.selection.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.nextId = 1;
    this.colorIndex = 0;
    this.name = name;
    this.info = emptyInfo();
    this.dirty = false;
    this.emit();
  }

  // --- objects ---------------------------------------------------------------------------------

  get(id: number): SceneObject | undefined {
    return this.objects.find((o) => o.id === id);
  }

  get selected(): SceneObject[] {
    return this.objects.filter((o) => this.selection.has(o.id));
  }

  nextColor(): string {
    return PALETTE[this.colorIndex++ % PALETTE.length];
  }

  /**
   * Adds a mesh given in world coordinates. The object origin is placed at the mesh centre.
   * With `dropOnPlate`, the object is lifted so it rests on z = 0.
   */
  addWorldMesh(world: MeshData, opts: { name?: string; color?: string; dropOnPlate?: boolean; faceColors?: Uint32Array; texture?: ObjectTexture } = {}): SceneObject {
    const { mesh, offset } = centered(world);
    const b = bounds(mesh);
    const position: Vec3 = opts.dropOnPlate ? [offset[0], offset[1], -b.min[2]] : offset;
    const id = this.nextId++;
    const obj: SceneObject = {
      id,
      name: opts.name ?? `Objet${id}`,
      mesh,
      color: opts.color ?? this.nextColor(),
      position,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      report: analyze(mesh),
      faceColors: opts.faceColors && opts.faceColors.length === mesh.indices.length / 3 ? opts.faceColors : undefined,
      texture: opts.texture && opts.texture.face.length === mesh.indices.length / 3 ? opts.texture : undefined,
    };
    this.objects.push(obj);
    return obj;
  }

  /**
   * Adds an object from a mesh in its own frame and a 3MF transform (row vectors), keeping the move,
   * rotation and scale as the object's transform. Falls back to a baked world mesh when the
   * transform is not a plain rotation and scale (shear, mirror).
   */
  addTransformedMesh(local: MeshData, t: number[], opts: { name?: string; color?: string; faceColors?: Uint32Array; texture?: ObjectTexture } = {}): SceneObject {
    const m = new Matrix4().set(t[0], t[3], t[6], t[9], t[1], t[4], t[7], t[10], t[2], t[5], t[8], t[11], 0, 0, 0, 1);
    const { mesh, offset } = centered(local);
    const full = m.clone().multiply(new Matrix4().makeTranslation(offset[0], offset[1], offset[2]));
    const p = new Vector3(), q = new Quaternion(), s = new Vector3();
    full.decompose(p, q, s);
    const e = new Euler().setFromQuaternion(q, 'XYZ');
    const deg = (x: number) => Math.round(((x * 180) / Math.PI) * 1e6) / 1e6 + 0;
    const tf = { position: [p.x, p.y, p.z] as Vec3, rotation: [deg(e.x), deg(e.y), deg(e.z)] as Vec3, scale: [s.x, s.y, s.z] as Vec3 };
    // Check that position / rotation / scale reproduce the transform.
    const back = objectMatrix(tf);
    const b = bounds(mesh);
    const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 1);
    const ok = s.x > 0 && s.y > 0 && s.z > 0 && [[b.min[0], b.min[1], b.min[2]], [b.max[0], b.min[1], b.min[2]], [b.min[0], b.max[1], b.min[2]], [b.min[0], b.min[1], b.max[2]]]
      .every((c) => new Vector3(...c).applyMatrix4(full).distanceTo(new Vector3(...c).applyMatrix4(back)) < size * 1e-5);
    if (!ok) return this.addWorldMesh(transformed(local, m.elements), opts);
    const obj = this.addWorldMesh(mesh, opts);
    Object.assign(obj, tf);
    return obj;
  }

  remove(ids: Iterable<number>): void {
    const drop = new Set(ids);
    this.objects = this.objects.filter((o) => !drop.has(o.id));
    for (const id of drop) this.selection.delete(id);
  }

  update(id: number, patch: Partial<SceneObject>): void {
    const i = this.objects.findIndex((o) => o.id === id);
    if (i < 0) return;
    const next = { ...this.objects[i], ...patch };
    if (patch.mesh) {
      next.report = analyze(patch.mesh);
      if (!('selfIntersections' in patch)) next.selfIntersections = undefined;
      // Paint follows faces; a new mesh (repair, boolean…) has new faces.
      if (!('faceColors' in patch)) next.faceColors = undefined;
      if (!('texture' in patch)) next.texture = undefined;
    }
    this.objects[i] = next;
  }

  select(ids: number[], additive = false): void {
    if (!additive) this.selection.clear();
    for (const id of ids) {
      if (additive && this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
    }
    this.emit();
  }
}

export function objectMatrix(o: Pick<SceneObject, 'position' | 'rotation' | 'scale'>): Matrix4 {
  const r = o.rotation.map((d) => (d * Math.PI) / 180);
  const q = new Quaternion().setFromEuler(new Euler(r[0], r[1], r[2], 'XYZ'));
  return new Matrix4().compose(new Vector3(...o.position), q, new Vector3(...o.scale));
}

/**
 * Transform of an object moved by a rigid world motion Q (rotation + translation): the motion goes
 * into its position and rotation, the mesh is untouched (as 3D Builder keeps a tumble in the
 * object's rotation). Q · T(p) · R · S = T(Q p) · (Qr R) · S.
 */
export function movedTransform(o: Pick<SceneObject, 'position' | 'rotation'>, q: Matrix4): { position: Vec3; rotation: Vec3 } {
  const p = new Vector3(...o.position).applyMatrix4(q);
  const r = o.rotation.map((d) => (d * Math.PI) / 180);
  const rot = new Matrix4().extractRotation(q).multiply(new Matrix4().makeRotationFromEuler(new Euler(r[0], r[1], r[2], 'XYZ')));
  const e = new Euler().setFromRotationMatrix(rot, 'XYZ');
  const deg = (x: number) => Math.round(((x * 180) / Math.PI) * 1e6) / 1e6 + 0;
  return { position: [p.x, p.y, p.z], rotation: [deg(e.x), deg(e.y), deg(e.z)] };
}

/** The object's mesh with its transform baked in. */
export function worldMesh(o: SceneObject): MeshData {
  return transformed(o.mesh, objectMatrix(o).elements);
}

export function worldBounds(objs: SceneObject[]) {
  const all = objs.map((o) => bounds(worldMesh(o)));
  return {
    min: [0, 1, 2].map((k) => Math.min(...all.map((b) => b.min[k]))) as Vec3,
    max: [0, 1, 2].map((k) => Math.max(...all.map((b) => b.max[k]))) as Vec3,
  };
}
