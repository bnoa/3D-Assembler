// three.js view of the scene document. Z is up, units are millimetres.
import {
  ACESFilmicToneMapping, AmbientLight, Box3, BufferAttribute, BufferGeometry, CanvasTexture, Color, DirectionalLight,
  DoubleSide, Fog, Group, HemisphereLight, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Object3D, PCFSoftShadowMap, PerspectiveCamera, PMREMGenerator, Plane, PlaneGeometry, Raycaster,
  RepeatWrapping, ClampToEdgeWrapping, DataTexture, LinearFilter, LinearMipmapLinearFilter, Scene, ShadowMaterial, SRGBColorSpace, Vector2, Vector3, WebGLRenderer,
  GridHelper, Quaternion,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CameraControls, MAX_FOV, VIEW_PLATE, defaultPose, frameBox } from './camera-controls';
import type { MeshData } from '../core/mesh-data';
import { type SceneDocument, type SceneObject, type Vec3, isValid, objectBounds, objectMatrix } from '../core/model';
import { detentAngle, snapAxis, snapCandidates } from '../geometry/align-snap';
import { type ObjectTexture, type TextureImage, hasTexture } from '../core/texture-data';

Object3D.DEFAULT_UP.set(0, 0, 1);

export interface ViewSettings {
  shading: boolean;
  shadows: boolean;
  colors: boolean;
  reflections: boolean;
  smoothing: boolean;
  wireframe: boolean;
  xray: boolean;
  grid: 'checker' | 'lines' | 'none';
}

export type GizmoMode = 'translate' | 'rotate' | 'scale';

interface Entry {
  obj: SceneObject;
  group: Group;
  mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  /** Selection outline, built on first selection (most objects are never selected). */
  outline: LineSegments<BufferGeometry, LineBasicMaterial> | null;
  /** Textured faces, one mesh per image, drawn over the object. */
  overlays: Mesh<BufferGeometry, MeshStandardMaterial>[];
}

const GHOST_COLOR = '#7fa6e6';
const SELECT_COLOR = 0x8fd0ff;

const MATERIAL_LOOK: Record<string, { roughness: number; metalness: number; opacity: number }> = {
  simple: { roughness: 0.55, metalness: 0.05, opacity: 1 },
  gloss: { roughness: 0.18, metalness: 0.05, opacity: 1 },
  metal: { roughness: 0.3, metalness: 0.9, opacity: 1 },
  translucent: { roughness: 0.15, metalness: 0, opacity: 0.55 },
  rubber: { roughness: 0.95, metalness: 0, opacity: 1 },
};
const INVALID_COLOR = '#d9534f';

export class Viewport {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly orbit: CameraControls;
  readonly gizmo: TransformControls;
  settings: ViewSettings = {
    shading: true, shadows: true, colors: true, reflections: true,
    smoothing: false, wireframe: false, xray: false, grid: 'checker',
  };
  /** Called with the picked object id (or null) on click. */
  onPick: (id: number | null, additive: boolean) => void = () => {};
  /** Called after the user finished moving/rotating/scaling objects. */
  onTransformStart: () => void = () => {};
  onTransformEnd: (changes: { id: number; position: Vec3; rotation: Vec3; scale: Vec3 }[]) => void = () => {};
  onTransformLive: () => void = () => {};

  private entries = new Map<number, Entry>();
  private plate = new Group();
  private checker!: Mesh;
  private gridLines!: GridHelper;
  private shadowCatcher!: Mesh;
  private sun!: DirectionalLight;
  private overlay = new Group(); // previews from tool modes
  private hidden = new Set<number>();
  private raycaster = new Raycaster();
  private drag: { ids: number[]; plane: Plane; start: Vector3; origins: Map<number, Vector3>; moved: boolean; box: Box3; snap: { cands: [number[], number[], number[]]; threshold: number } } | null = null;
  private needsRender = true;

  constructor(private host: HTMLElement, private doc: SceneDocument) {
    // preserveDrawingBuffer stays: the view is drawn only when something changes, and without it
    // Chromium can show (and capture) an empty canvas when it composites the page again later.
    this.renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    // The sun is fixed in the world: the shadow map only changes with the scene, not the camera
    // (invalidate() asks for it, invalidateView() does not).
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    host.appendChild(this.renderer.domElement);

    this.scene.background = new Color('#4a4d52');
    this.scene.fog = new Fog('#4a4d52', 500, 1400);
    this.camera = new PerspectiveCamera((MAX_FOV * 180) / Math.PI, 1, 1, 5000);
    this.orbit = new CameraControls(this.camera, this.renderer.domElement, () => this.fullView());
    this.orbit.addEventListener('change', () => this.invalidateView());
    this.resetCamera();

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.9);
    // Shift held: no snapping and no collisions (3D Builder).
    window.addEventListener('keydown', (e) => { if (e.key === 'Shift') this.shiftHeld = true; });
    window.addEventListener('keyup', (e) => { if (e.key === 'Shift') this.shiftHeld = false; });
    window.addEventListener('blur', () => { this.shiftHeld = false; });
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      this.gizmoSnap = null; // snap candidates are taken again at each drag start
      if (e.value) this.onTransformStart();
      else this.commitGizmo();
    });
    this.gizmo.addEventListener('objectChange', () => {
      this.onTransformLive();
      this.invalidate();
    });
    this.scene.add(this.gizmo.getHelper());

    // Soft studio environment for reflections (metal, gloss); toggled by "Reflets".
    const pmrem = new PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    pmrem.dispose();
    this.buildLights();
    this.buildPlate();
    this.scene.add(this.overlay);

    new ResizeObserver(() => this.resize()).observe(host);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.bindPointer();
    doc.on(() => this.sync());
    this.sync();
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.orbit.update() || this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    loop();
  }

  /** Something in the scene changed: draw again, shadows included. */
  invalidate(): void {
    this.needsRender = true;
    this.renderer.shadowMap.needsUpdate = true;
  }

  /** Only the camera or the canvas size changed: draw again with the same shadow map. */
  invalidateView(): void {
    this.needsRender = true;
  }

  /**
   * Area the 3D view stands for: 3D Builder draws its view over the whole window, under the ribbon
   * and the side panel, so the projection centre is the window's centre, not the visible part's.
   */
  private fullView(): { w: number; h: number; x: number; y: number } {
    const r = this.host.getBoundingClientRect();
    const w = Math.max(window.innerWidth, r.right, 1), h = Math.max(window.innerHeight, r.bottom, 1);
    return { w, h, x: Math.max(0, r.left), y: Math.max(0, r.top) };
  }

  private resize(): void {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    const full = this.fullView();
    this.camera.aspect = full.w / full.h;
    this.camera.setViewOffset(full.w, full.h, full.x, full.y, w, h);
    this.camera.updateProjectionMatrix();
    this.invalidateView();
  }

  // --- scene construction --------------------------------------------------------------------

  private buildLights(): void {
    this.scene.add(new HemisphereLight('#ffffff', '#6b6e73', 1.1));
    this.scene.add(new AmbientLight('#ffffff', 0.25));
    this.sun = new DirectionalLight('#ffffff', 2.2);
    this.sun.position.set(120, -160, 320);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const c = this.sun.shadow.camera;
    c.left = -300; c.right = 300; c.top = 300; c.bottom = -300; c.near = 10; c.far = 1200;
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);
    const fill = new DirectionalLight('#dfe8ff', 0.6);
    fill.position.set(-200, 150, 120);
    this.scene.add(fill);
  }

  private buildPlate(): void {
    const tex = checkerTexture();
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.repeat.set(100, 100); // 20 mm squares over 2 m
    tex.anisotropy = 8;
    this.checker = new Mesh(new PlaneGeometry(2000, 2000), new MeshBasicMaterial({ map: tex }));
    this.checker.renderOrder = -2;
    this.plate.add(this.checker);

    this.gridLines = new GridHelper(2000, 200, 0x8a8e94, 0x63676d);
    this.gridLines.rotation.x = Math.PI / 2;
    this.gridLines.visible = false;
    this.plate.add(this.gridLines);

    this.shadowCatcher = new Mesh(new PlaneGeometry(2000, 2000), new ShadowMaterial({ opacity: 0.35 }));
    this.shadowCatcher.position.z = 0.05;
    this.shadowCatcher.receiveShadow = true;
    this.plate.add(this.shadowCatcher);

    this.setRulerUnit('mm', 1);
    this.scene.add(this.plate);
  }

  private rulers: Mesh[] = [];
  private rulerKey = '';

  /**
   * Rulers along +X and +Y in the unit of the settings, as 3D Builder (0 mm, 50 mm… or 0 po, 5 po…):
   * a step of 5 × 10^k units, the closest to 50 mm, up to about 300 mm.
   */
  setRulerUnit(short: string, mmPerUnit: number): void {
    const key = short + mmPerUnit;
    if (key === this.rulerKey) return;
    this.rulerKey = key;
    for (const r of this.rulers) { this.plate.remove(r); r.geometry.dispose(); const m = r.material as MeshBasicMaterial; m.map?.dispose(); m.dispose(); }
    this.rulers = [];
    const target = 50 / mmPerUnit;
    const step = 5 * 10 ** Math.round(Math.log10(target / 5));
    const fmt = (v: number) => String(Math.round(v * 1e6) / 1e6).replace('.', ',');
    for (let i = 0; i * step * mmPerUnit <= 300 + 1e-6 || i <= 1; i++) {
      const d = i * step * mmPerUnit, text = `${fmt(i * step)} ${short}`;
      const lx = label(text);
      lx.position.set(d + 2, -6, 0.2);
      this.plate.add(lx);
      this.rulers.push(lx);
      if (i > 0) {
        const ly = label(text);
        ly.position.set(2, d, 0.2);
        this.plate.add(ly);
        this.rulers.push(ly);
      }
    }
  }

  // --- document sync -------------------------------------------------------------------------

  sync(): void {
    const alive = new Set<number>();
    for (const obj of this.doc.objects) {
      alive.add(obj.id);
      let e = this.entries.get(obj.id);
      const repaint = e && (e.obj.faceColors !== obj.faceColors || e.obj.texture !== obj.texture || (obj.faceColors && e.obj.color !== obj.color));
      if (!e || e.obj.mesh !== obj.mesh || repaint) {
        if (e) this.disposeEntry(e);
        e = this.createEntry(obj);
        this.entries.set(obj.id, e);
      }
      e.obj = obj;
      e.group.matrix.copy(objectMatrix(obj));
      e.group.matrixWorldNeedsUpdate = true;
      this.styleEntry(e);
    }
    for (const [id, e] of this.entries) {
      if (!alive.has(id)) {
        this.disposeEntry(e);
        this.entries.delete(id);
      }
    }
    this.updateGizmoTarget();
    this.invalidate();
  }

  // --- list focus -------------------------------------------------------------------------------

  /**
   * As in 3D Builder, clicking an object in the Éléments list shows it through the others: every
   * other object is drawn translucent blue while the pointer stays on the list.
   */
  private focusId: number | null = null;

  /** In tool modes, as in 3D Builder, the objects outside the selection are drawn translucent blue. */
  private modeKeep: Set<number> | null = null;

  ghostOutside(ids: number[] | null): void {
    this.modeKeep = ids ? new Set(ids) : null;
    for (const e of this.entries.values()) this.styleEntry(e);
    this.invalidate();
  }

  focusObject(id: number | null): void {
    if (id === this.focusId) return;
    this.focusId = id;
    for (const e of this.entries.values()) this.styleEntry(e);
    this.invalidate();
  }

  private createEntry(obj: SceneObject): Entry {
    const geo = toGeometry(obj.mesh, this.settings.smoothing, obj.faceColors, obj.color);
    const mat = new MeshStandardMaterial({ color: obj.color, roughness: 0.55, metalness: 0.05, side: DoubleSide });
    const mesh = new Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.objectId = obj.id;
    const group = new Group();
    group.matrixAutoUpdate = false;
    group.add(mesh);
    const overlays = textureOverlays(obj.mesh, obj.texture);
    for (const o of overlays) { o.userData.objectId = obj.id; group.add(o); }
    this.scene.add(group);
    return { obj, group, mesh, outline: null, overlays };
  }

  private disposeEntry(e: Entry): void {
    this.scene.remove(e.group);
    e.mesh.geometry.dispose();
    e.mesh.material.dispose();
    if (e.outline) { e.outline.geometry.dispose(); e.outline.material.dispose(); }
    for (const o of e.overlays) { o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose(); }
  }

  private styleEntry(e: Entry): void {
    const s = this.settings;
    const selected = this.doc.selection.has(e.obj.id);
    const m = e.mesh.material;
    const invalid = !isValid(e.obj);
    const painted = !!e.obj.faceColors && s.colors && !invalid;
    m.vertexColors = painted;
    m.color.set(invalid ? INVALID_COLOR : !s.colors ? '#b9bec5' : painted ? '#ffffff' : e.obj.color);
    m.emissive.set(selected ? '#1d3a52' : '#000000');
    m.wireframe = s.wireframe;
    const look = MATERIAL_LOOK[e.obj.material ?? 'simple'];
    m.roughness = look.roughness;
    m.metalness = look.metalness;
    const glassy = look.opacity < 1;
    m.transparent = s.xray || glassy;
    m.opacity = s.xray ? 0.35 : look.opacity;
    m.depthWrite = !s.xray && !glassy;
    m.flatShading = !s.smoothing;
    m.envMapIntensity = s.reflections ? 1 : 0;
    m.needsUpdate = true;
    if (!s.shading) {
      m.emissive.set(m.color);
      m.emissiveIntensity = 0.85;
    } else {
      m.emissiveIntensity = 1;
    }
    e.mesh.castShadow = s.shadows;
    for (const o of e.overlays) {
      o.visible = s.colors && !invalid;
      o.material.wireframe = s.wireframe;
      o.material.emissive.set(selected ? '#1d3a52' : '#000000');
      o.material.envMapIntensity = s.reflections ? 1 : 0;
    }
    if (((this.focusId !== null && e.obj.id !== this.focusId) || (this.modeKeep && !this.modeKeep.has(e.obj.id))) && !s.xray) {
      // Another object is focused from the list: translucent blue so it shows through.
      m.vertexColors = false;
      m.color.set(GHOST_COLOR);
      m.emissive.set('#000000');
      m.transparent = true;
      m.opacity = 0.4;
      m.depthWrite = false;
      m.needsUpdate = true;
      e.mesh.castShadow = false;
      for (const o of e.overlays) o.visible = false;
    }
    if (selected && !e.outline) {
      e.outline = new LineSegments(outlineGeometry(e.obj.mesh), new LineBasicMaterial({ color: SELECT_COLOR }));
      e.group.add(e.outline);
    }
    if (e.outline) e.outline.visible = selected;
    e.group.visible = !this.hidden.has(e.obj.id);
  }

  applySettings(patch: Partial<ViewSettings>): void {
    const smoothingChanged = patch.smoothing !== undefined && patch.smoothing !== this.settings.smoothing;
    Object.assign(this.settings, patch);
    this.checker.visible = this.settings.grid === 'checker';
    this.gridLines.visible = this.settings.grid === 'lines';
    this.shadowCatcher.visible = this.settings.shadows;
    if (smoothingChanged) {
      for (const e of this.entries.values()) {
        e.mesh.geometry.dispose();
        e.mesh.geometry = toGeometry(e.obj.mesh, this.settings.smoothing, e.obj.faceColors, e.obj.color);
      }
    }
    for (const e of this.entries.values()) this.styleEntry(e);
    this.invalidate();
  }

  /** Hides objects (e.g. while a tool shows a preview in their place). */
  setHidden(ids: number[]): void {
    this.hidden = new Set(ids);
    for (const e of this.entries.values()) this.styleEntry(e);
    this.invalidate();
  }

  clearOverlay(): void {
    for (const c of [...this.overlay.children]) {
      this.overlay.remove(c);
      c.traverse((o) => {
        const m = o as Mesh;
        m.geometry?.dispose();
        (m.material as MeshStandardMaterial | undefined)?.dispose?.();
      });
    }
    this.invalidate();
  }

  /** Shows world-space meshes as a tool preview. */
  showPreview(meshes: { mesh: MeshData; color: string; opacity?: number; edges?: boolean; onTop?: boolean; faceColors?: Uint32Array; wireframe?: boolean; texture?: ObjectTexture }[]): void {
    this.clearOverlay();
    for (const p of meshes) {
      const geo = toGeometry(p.mesh, false, p.faceColors, p.color);
      const mat = new MeshStandardMaterial({
        color: p.faceColors ? '#ffffff' : p.color, vertexColors: !!p.faceColors, roughness: 0.55, flatShading: true, side: DoubleSide,
        transparent: (p.opacity ?? 1) < 1, opacity: p.opacity ?? 1, depthWrite: (p.opacity ?? 1) >= 1,
        // Highlights drawn over the object's own faces win the depth test.
        polygonOffset: !!p.onTop, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        wireframe: !!p.wireframe,
      });
      const mesh = new Mesh(geo, mat);
      mesh.castShadow = (p.opacity ?? 1) >= 1;
      this.overlay.add(mesh);
      if (p.edges) this.overlay.add(new LineSegments(outlineGeometry(p.mesh), new LineBasicMaterial({ color: 0x1b1d20 })));
      for (const t of textureOverlays(p.mesh, p.texture)) this.overlay.add(t);
    }
    this.invalidate();
  }

  /** Moves the whole tool preview by a world transform (column-major 4 × 4), or back in place. */
  setPreviewTransform(m: ArrayLike<number> | null): void {
    this.overlay.matrixAutoUpdate = !m;
    if (m) this.overlay.matrix.fromArray(m);
    else { this.overlay.position.set(0, 0, 0); this.overlay.quaternion.identity(); this.overlay.scale.set(1, 1, 1); this.overlay.updateMatrix(); }
    this.overlay.updateMatrixWorld(true);
    this.invalidate();
  }

  addOverlay(o: Object3D): void {
    this.overlay.add(o);
    this.invalidate();
  }

  // --- gizmo -----------------------------------------------------------------------------------

  private gizmoMode: GizmoMode | null = null;
  private gizmoProxy = new Object3D();

  setGizmo(mode: GizmoMode | null): void {
    this.gizmoMode = mode;
    if (mode) this.gizmo.setMode(mode);
    this.updateGizmoTarget();
  }

  private updateGizmoTarget(): void {
    const sel = this.doc.selected;
    if (!this.gizmoMode || sel.length !== 1 || this.hidden.has(sel[0].id)) {
      this.gizmo.detach();
      return;
    }
    const o = sel[0];
    if (!this.gizmo.dragging) {
      this.gizmoProxy.position.set(...o.position);
      this.gizmoProxy.rotation.set(...(o.rotation.map((d) => (d * Math.PI) / 180) as Vec3), 'XYZ');
      this.gizmoProxy.scale.set(...o.scale);
      this.gizmoProxy.updateMatrixWorld();
    }
    if (!this.gizmoProxy.parent) this.scene.add(this.gizmoProxy);
    this.gizmo.attach(this.gizmoProxy);
    // Mirror the proxy onto the object while dragging.
    this.gizmo.removeEventListener('objectChange', this.mirrorProxy);
    this.gizmo.addEventListener('objectChange', this.mirrorProxy);
  }

  private mirrorProxy = () => {
    const sel = this.doc.selected[0];
    const e = sel && this.entries.get(sel.id);
    if (!e) return;
    const g = this.gizmo as unknown as { mode: string; axis: string | null; space: string; rotationAngle: number; rotationAxis: Vector3; _quaternionStart: Quaternion };
    if (this.dragOptions.snap !== this.shiftHeld) {
      if (g.mode === 'translate' && g.axis) {
        // Move arrows: the box snaps along the dragged axes only.
        if (!this.gizmoSnap) this.gizmoSnap = this.snapContext([sel.id]);
        // Arrows only move: the object's exact box (cached for its rotation and scale) at the proxy.
        const pp = this.gizmoProxy.position;
        const wb = objectBounds({ ...sel, position: [pp.x, pp.y, pp.z] });
        const box = new Box3(new Vector3(...wb.min), new Vector3(...wb.max));
        ['X', 'Y', 'Z'].forEach((name, k) => {
          if (!g.axis!.includes(name)) return;
          const fix = snapAxis(box.min.getComponent(k), box.max.getComponent(k), this.gizmoSnap!.cands[k], this.gizmoSnap!.threshold);
          this.gizmoProxy.position.setComponent(k, this.gizmoProxy.position.getComponent(k) + fix);
        });
      } else if (g.mode === 'rotate' && g.axis && g.axis !== 'XYZE') {
        // Rotation: detents every 45°, held within 5°.
        const a = detentAngle(g.rotationAngle);
        if (a !== g.rotationAngle) {
          const q = new Quaternion().setFromAxisAngle(g.rotationAxis, a);
          if (g.space === 'local' && g.axis !== 'E') this.gizmoProxy.quaternion.copy(g._quaternionStart).multiply(q).normalize();
          else this.gizmoProxy.quaternion.copy(q.multiply(g._quaternionStart)).normalize();
        }
      }
    }
    this.gizmoProxy.updateMatrix();
    e.group.matrix.copy(this.gizmoProxy.matrix);
    e.group.matrixWorldNeedsUpdate = true;
  };

  private commitGizmo(): void {
    const sel = this.doc.selected[0];
    if (!sel) return;
    const p = this.gizmoProxy;
    this.onTransformEnd([{
      id: sel.id,
      position: [p.position.x, p.position.y, p.position.z],
      rotation: [p.rotation.x, p.rotation.y, p.rotation.z].map((r) => round((r * 180) / Math.PI, 3)) as Vec3,
      scale: [p.scale.x, p.scale.y, p.scale.z].map((s) => Math.max(1e-3, s)) as Vec3,
    }]);
  }

  // --- pointer: pick and drag on the plate ---------------------------------------------------------

  /** Paint tool hooks: when set, left clicks on objects paint instead of selecting. */
  paintPick: ((id: number, face: number, point: Vec3) => void) | null = null;
  paintHover: ((hit: { id: number; face: number } | null) => void) | null = null;
  private painting = false;
  /** Tool hook: a mode that takes over left-button drags (returns true from down to capture). */
  toolPointer: { down(ev: PointerEvent): boolean; move(ev: PointerEvent): void; up(ev: PointerEvent): void } | null = null;
  private toolActive = false;
  /** Tool hook for click-based tools (Measure): clicks and hover go to the tool, not to selection. */
  clickTool: { click(ev: PointerEvent): void; hover(ev: PointerEvent | null): void } | null = null;

  /** Point under the pointer: on an object (with its triangle in world space), else on the floor z = 0. */
  hitAt(ev: PointerEvent): { point: Vec3; id: number | null; tri?: [Vec3, Vec3, Vec3] } | null {
    this.scene.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc(ev), this.camera);
    const meshes = [...this.entries.values()].filter((e) => e.group.visible).map((e) => e.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (hit && hit.face) {
      const pos = (hit.object as Mesh).geometry.getAttribute('position');
      const w = (i: number) => new Vector3().fromBufferAttribute(pos, i).applyMatrix4(hit.object.matrixWorld).toArray() as Vec3;
      return { point: hit.point.toArray() as Vec3, id: hit.object.userData.objectId as number, tri: [w(hit.face.a), w(hit.face.b), w(hit.face.c)] };
    }
    const p = new Vector3();
    if (this.raycaster.ray.intersectPlane(new Plane(new Vector3(0, 0, 1), 0), p)) return { point: p.toArray() as Vec3, id: null };
    return null;
  }

  /** "Sélection temporaire": clicks add to (or remove from) the selection instead of replacing it. */
  additiveSelect = false;

  /** World ray under the pointer. */
  rayAt(ev: PointerEvent): { origin: Vector3; direction: Vector3 } {
    this.raycaster.setFromCamera(this.ndc(ev), this.camera);
    return { origin: this.raycaster.ray.origin.clone(), direction: this.raycaster.ray.direction.clone() };
  }

  /** Index of the preview mesh under the pointer (previews in the order given to showPreview). */
  pickOverlay(ev: PointerEvent): number | null {
    this.raycaster.setFromCamera(this.ndc(ev), this.camera);
    const meshes = this.overlay.children.filter((c) => (c as Mesh).isMesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return hit ? meshes.indexOf(hit.object) : null;
  }

  /** Point and world normal of the preview surface under the pointer. */
  hitOverlay(ev: PointerEvent): { point: Vec3; normal: Vec3 } | null {
    this.scene.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc(ev), this.camera);
    const meshes = this.overlay.children.filter((c) => (c as Mesh).isMesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit || !hit.face) return null;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    return { point: hit.point.toArray() as Vec3, normal: n.toArray() as Vec3 };
  }

  pickFace(ev: PointerEvent): { id: number; face: number; point: Vec3 } | null {
    this.raycaster.setFromCamera(this.ndc(ev), this.camera);
    const meshes = [...this.entries.values()].filter((e) => e.group.visible).map((e) => e.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return hit && hit.faceIndex != null ? { id: hit.object.userData.objectId as number, face: hit.faceIndex, point: [hit.point.x, hit.point.y, hit.point.z] } : null;
  }

  private bindPointer(): void {
    const el = this.renderer.domElement;
    let down: { x: number; y: number; button: number; wasSelected?: boolean } | null = null;
    // Capture phase: a tool drag must win over the camera controls listening on the same element.
    el.addEventListener('pointerdown', (ev) => {
      if (this.toolPointer && ev.button === 0 && this.toolPointer.down(ev)) {
        ev.stopImmediatePropagation();
        this.orbit.enabled = false;
        this.toolActive = true;
        el.setPointerCapture(ev.pointerId);
      }
    }, { capture: true });
    el.addEventListener('pointerdown', (ev) => {
      if (this.toolActive) return;
      if (this.paintPick && ev.button === 0) {
        const hit = this.pickFace(ev);
        if (hit) {
          this.orbit.enabled = false;
          this.painting = true;
          this.paintPick(hit.id, hit.face, hit.point);
          return;
        }
      }
      down = { x: ev.clientX, y: ev.clientY, button: ev.button };
      if (this.clickTool) return;
      if (ev.button !== 0 || this.gizmo.dragging || (this.gizmo as unknown as { axis: string | null }).axis) return;
      const hit = this.pick(ev);
      if (hit !== null && this.doc.selection.has(hit) && !ev.ctrlKey && !ev.shiftKey) {
        down.wasSelected = true;
        this.startDrag(ev, [...this.doc.selection]);
      } else if (hit !== null && !ev.ctrlKey && !ev.shiftKey) {
        // Additive selection ("Sélection temporaire"): a click adds the object to the selection.
        this.onPick(hit, this.additiveSelect);
        this.startDrag(ev, this.additiveSelect ? [...this.doc.selection] : [hit]);
      }
    });
    el.addEventListener('pointermove', (ev) => {
      if (this.toolActive) { this.toolPointer?.move(ev); return; }
      if (this.clickTool && !ev.buttons) { this.clickTool.hover(ev); return; }
      if (this.drag) this.moveDrag(ev);
      else if (this.paintHover && !ev.buttons) this.paintHover(this.pickFace(ev));
    });
    el.addEventListener('pointerup', (ev) => {
      if (this.toolActive) {
        this.toolActive = false;
        this.orbit.enabled = true;
        down = null;
        this.toolPointer?.up(ev);
        return;
      }
      if (this.painting) {
        this.painting = false;
        this.orbit.enabled = true;
        down = null;
        return;
      }
      const wasDrag = this.drag?.moved;
      if (this.drag) this.endDrag();
      if (this.clickTool) {
        if (down && down.button === 0 && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 5) this.clickTool.click(ev);
        down = null;
        return;
      }
      if (down && !wasDrag && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 5 && down.button === 0 && !(this.gizmo as unknown as { axis: string | null }).axis) {
        const hit = this.pick(ev);
        if (ev.ctrlKey || ev.shiftKey) {
          if (hit !== null) this.onPick(hit, true);
        } else if (this.additiveSelect && hit !== null && down.wasSelected) {
          this.onPick(hit, true); // second click on a selected object takes it out of the selection
        } else if (hit === null && !this.additiveSelect) { // additive mode: clicking the void keeps the selection
          this.onPick(null, false);
        }
      }
      down = null;
    });
  }

  private ndc(ev: PointerEvent): Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }

  private pick(ev: PointerEvent): number | null {
    this.raycaster.setFromCamera(this.ndc(ev), this.camera);
    const meshes = [...this.entries.values()].filter((e) => e.group.visible).map((e) => e.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return hit ? (hit.object.userData.objectId as number) : null;
  }

  private startDrag(ev: PointerEvent, ids: number[]): void {
    this.raycaster.setFromCamera(this.ndc(ev), this.camera);
    const objs = ids.map((id) => this.doc.get(id)!).filter(Boolean);
    const z = Math.min(...objs.map((o) => o.position[2]));
    const plane = new Plane(new Vector3(0, 0, 1), -z);
    const start = new Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, start)) return;
    this.orbit.enabled = false;
    const box = objs.reduce((b, o) => b.union(this.boxOf(o, o.position)), new Box3());
    this.drag = { ids, plane, start, origins: new Map(objs.map((o) => [o.id, new Vector3(...o.position)])), moved: false, box, snap: this.snapContext(ids) };
  }

  /**
   * Mouse-move options from the settings, as 3D Builder: "Alignement" (on by default) and
   * collisions. Holding Shift inverts the snapping, as 3D Builder's help says (its code only
   * suspends it), and suspends collisions.
   */
  dragOptions = { snap: true, collision: false };
  private shiftHeld = false;
  private gizmoSnap: { cands: [number[], number[], number[]]; threshold: number } | null = null;

  /**
   * Snap candidates from the objects that do not move, and the threshold: about 1 % of the
   * viewport height in world units at the depth of the moved objects' centre (3D Builder).
   */
  private snapContext(ids: number[]): { cands: [number[], number[], number[]]; threshold: number } {
    const moving = new Set(ids);
    const others = this.doc.objects.filter((o) => !moving.has(o.id)).map((o) => this.boxOf(o, o.position));
    const sel = this.doc.objects.filter((o) => moving.has(o.id)).map((o) => this.boxOf(o, o.position));
    const c = sel.reduce((b, x) => b.union(x), new Box3()).getCenter(new Vector3());
    const dist = c.distanceTo(this.camera.position);
    const visible = 2 * dist * Math.tan((this.camera.fov * Math.PI) / 360) * (this.host.clientHeight / this.fullView().h);
    return { cands: snapCandidates(others.map((b) => ({ min: b.min.toArray(), max: b.max.toArray() }))), threshold: 0.01 * visible };
  }

  private moveDrag(ev: PointerEvent): void {
    const d = this.drag!;
    this.raycaster.setFromCamera(this.ndc(ev), this.camera);
    const p = new Vector3();
    if (!this.raycaster.ray.intersectPlane(d.plane, p)) return;
    const delta = p.sub(d.start);
    if (!d.moved && delta.length() < 0.5) return;
    if (!d.moved) this.onTransformStart();
    d.moved = true;
    // Alignement: the moved box snaps on X, then Y, to the other objects' boxes and the origin.
    if (this.dragOptions.snap !== ev.shiftKey) {
      delta.x += snapAxis(d.box.min.x + delta.x, d.box.max.x + delta.x, d.snap.cands[0], d.snap.threshold);
      delta.y += snapAxis(d.box.min.y + delta.y, d.box.max.y + delta.y, d.snap.cands[1], d.snap.threshold);
    }
    // Collisions: refuse a move that makes a dragged object's box enter another object's box.
    if (this.dragOptions.collision && !ev.shiftKey && this.wouldCollide(d, delta)) return;
    for (const id of d.ids) {
      const e = this.entries.get(id);
      const o = d.origins.get(id);
      if (!e || !o) continue;
      const obj = e.obj;
      const pos: Vec3 = [o.x + delta.x, o.y + delta.y, o.z];
      e.group.matrix.copy(objectMatrix({ ...obj, position: pos }));
      e.group.matrixWorldNeedsUpdate = true;
      e.group.userData.dragPos = pos;
    }
    this.onTransformLive();
    this.invalidate();
  }

  private boxOf(obj: SceneObject, position: Vec3): Box3 {
    const b = objectBounds({ ...obj, position });
    return new Box3(new Vector3(...b.min), new Vector3(...b.max));
  }

  private wouldCollide(d: NonNullable<Viewport['drag']>, delta: Vector3): boolean {
    const moving = new Set(d.ids);
    const others = this.doc.objects.filter((o) => !moving.has(o.id)).map((o) => this.boxOf(o, o.position).expandByScalar(-0.01));
    for (const id of d.ids) {
      const obj = this.doc.get(id);
      const o = d.origins.get(id);
      if (!obj || !o) continue;
      const box = this.boxOf(obj, [o.x + delta.x, o.y + delta.y, o.z]);
      if (others.some((b) => b.intersectsBox(box))) return true;
    }
    return false;
  }

  private endDrag(): void {
    const d = this.drag!;
    this.drag = null;
    this.orbit.enabled = true;
    if (!d.moved) return;
    const changes = d.ids.map((id) => {
      const e = this.entries.get(id)!;
      const pos = (e.group.userData.dragPos as Vec3) ?? e.obj.position;
      delete e.group.userData.dragPos;
      return { id, position: pos, rotation: e.obj.rotation, scale: e.obj.scale };
    });
    this.onTransformEnd(changes);
  }

  // --- camera ------------------------------------------------------------------------------------

  /**
   * Frames a box (or the plate when null) from the front, as 3D Builder's "Centrer la vue": the
   * view direction is reset and the camera glides there in 0.75 s (at once with `instant`).
   */
  frame(box: { min: Vec3; max: Vec3 } | null, instant = false): void {
    this.resize();
    const p = frameBox(box ?? VIEW_PLATE, this.camera.aspect);
    if (instant) this.orbit.setPose(p.eye, p.target, p.fov);
    else this.orbit.animateTo(p.eye, p.target, p.fov);
    this.invalidate();
  }

  /** 3D Builder's startup view of an empty scene. */
  resetCamera(): void {
    const p = defaultPose();
    this.orbit.setPose(p.eye, p.target, p.fov);
  }

  /** Live transform of an object (from the gizmo or a drag) before it is committed. */
  liveTransform(id: number): { position: Vec3; rotation: Vec3; scale: Vec3 } | null {
    const e = this.entries.get(id);
    if (!e) return null;
    if (e.group.userData.dragPos) return { position: e.group.userData.dragPos, rotation: e.obj.rotation, scale: e.obj.scale };
    if (this.gizmo.dragging && this.doc.selected[0]?.id === id) {
      const p = this.gizmoProxy;
      return {
        position: [p.position.x, p.position.y, p.position.z],
        rotation: [p.rotation.x, p.rotation.y, p.rotation.z].map((r) => (r * 180) / Math.PI) as Vec3,
        scale: [p.scale.x, p.scale.y, p.scale.z],
      };
    }
    return null;
  }

  private thumbRenderer: WebGLRenderer | null = null;
  /** Last pictures per mesh, newest first (a few, for objects sharing a mesh). */
  private thumbCache = new WeakMap<MeshData, { key: string; colors?: Uint32Array; texture?: ObjectTexture; url: string }[]>();

  /** Called when pictures asked with thumbnail() are ready (the side panel shows them). */
  onThumbnails: () => void = () => {};
  private thumbQueue = new Map<MeshData, SceneObject>();
  private thumbTimer = 0;

  private static thumbKey(obj: SceneObject): string {
    // The picture shows the object turned and scaled (framed on its scaled bounding sphere).
    return `${obj.color}|${obj.material ?? ''}|${isValid(obj)}|${obj.scale.join()}|${obj.rotation.join()}`;
  }

  private thumbHit(obj: SceneObject): string | null {
    const key = Viewport.thumbKey(obj);
    return this.thumbCache.get(obj.mesh)?.find((t) => t.key === key && t.colors === obj.faceColors && t.texture === obj.texture)?.url ?? null;
  }

  /**
   * Small rendered picture of an object for the side panel (cached per mesh and colours). A
   * picture not ready yet is rendered when the page is idle (a big mesh takes a while, and the panel
   * is drawn again after every change): meanwhile the previous picture of the mesh, if any, is
   * returned, else an empty image, and onThumbnails is called once it is there.
   */
  thumbnail(obj: SceneObject): string {
    const url = this.thumbHit(obj);
    if (url) return url;
    this.thumbQueue.set(obj.mesh, obj);
    if (!this.thumbTimer) {
      const run = () => {
        this.thumbTimer = 0;
        const jobs = [...this.thumbQueue.values()];
        this.thumbQueue.clear();
        let done = false;
        // Only objects still in the scene as they were asked.
        for (const o of jobs) if (this.doc.get(o.id) === o && !this.thumbHit(o)) { this.thumbnailNow(o); done = true; }
        if (done) this.onThumbnails();
      };
      const idle = (window as unknown as { requestIdleCallback?: (f: () => void, o: { timeout: number }) => number }).requestIdleCallback;
      this.thumbTimer = idle ? idle(run, { timeout: 500 }) : window.setTimeout(run, 50);
    }
    return this.thumbCache.get(obj.mesh)?.[0]?.url ?? EMPTY_IMAGE;
  }

  /** The picture at once (e.g. for the recent files list). */
  thumbnailNow(obj: SceneObject): string {
    const cached = this.thumbHit(obj);
    if (cached) return cached;
    const key = Viewport.thumbKey(obj);
    if (!this.thumbRenderer) {
      this.thumbRenderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
      this.thumbRenderer.setSize(96, 96);
      this.thumbRenderer.outputColorSpace = SRGBColorSpace;
    }
    const scene = new Scene();
    scene.add(new HemisphereLight('#ffffff', '#555a61', 1.6));
    const sun = new DirectionalLight('#ffffff', 2);
    sun.position.set(1, -2, 3);
    scene.add(sun);
    // On the mesh's own arrays (no copy) unless painted.
    const geo = toGeometry(obj.mesh, false, obj.faceColors, obj.color);
    const mat = new MeshStandardMaterial({ color: obj.faceColors ? '#ffffff' : isValid(obj) ? obj.color : INVALID_COLOR, vertexColors: !!obj.faceColors, roughness: 0.6, side: DoubleSide, flatShading: true });
    const mesh = new Mesh(geo, mat);
    // Textures too, as in the 3D view (only on a valid object, like the colours).
    const overlays = isValid(obj) ? textureOverlays(obj.mesh, obj.texture) : [];
    for (const o of overlays) mesh.add(o);
    mesh.scale.set(...obj.scale);
    mesh.rotation.set(...(obj.rotation.map((d) => (d * Math.PI) / 180) as Vec3), 'XYZ');
    scene.add(mesh);
    geo.computeBoundingSphere();
    const r = (geo.boundingSphere?.radius ?? 20) * Math.max(...obj.scale);
    const cam = new PerspectiveCamera(30, 1, r * 0.1, r * 20);
    cam.position.set(r * 1.6, -r * 2.6, r * 1.9);
    cam.lookAt(0, 0, 0);
    this.thumbRenderer.render(scene, cam);
    const url = this.thumbRenderer.domElement.toDataURL('image/png');
    geo.dispose();
    mat.dispose();
    for (const o of overlays) { o.geometry.dispose(); o.material.dispose(); } // images stay cached
    this.thumbCache.set(obj.mesh, [{ key, colors: obj.faceColors, texture: obj.texture, url }, ...(this.thumbCache.get(obj.mesh) ?? [])].slice(0, 4));
    return url;
  }

  snapshotPNG(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}

// --- helpers ---------------------------------------------------------------------------------------

/** Transparent 1 × 1 GIF, while a thumbnail is not rendered yet. */
const EMPTY_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const imageTextures = new WeakMap<TextureImage, DataTexture>();

/** GPU texture of an image (rows flipped: texture v = 0 is the bottom of the image). */
function gpuTexture(img: TextureImage): DataTexture {
  let tex = imageTextures.get(img);
  if (tex) return tex;
  const flipped = new Uint8Array(img.data.length);
  const row = img.width * 4;
  for (let y = 0; y < img.height; y++) flipped.set(img.data.subarray(y * row, (y + 1) * row), (img.height - 1 - y) * row);
  tex = new DataTexture(flipped, img.width, img.height);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = img.wrap === 'repeat' ? RepeatWrapping : ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  // A sticker relies on its one-pixel transparent border: mipmaps would blend it into the image
  // and smear the image's edge over the whole face.
  const clamp = img.wrap === 'clamp';
  tex.minFilter = clamp ? LinearFilter : LinearMipmapLinearFilter;
  tex.generateMipmaps = !clamp;
  tex.needsUpdate = true;
  imageTextures.set(img, tex);
  return tex;
}

/** One mesh per texture image with the faces showing it, slightly pulled towards the viewer. */
export function textureOverlays(m: MeshData, t?: ObjectTexture): Mesh<BufferGeometry, MeshStandardMaterial>[] {
  if (!hasTexture(t)) return [];
  const out: Mesh<BufferGeometry, MeshStandardMaterial>[] = [];
  t!.images.forEach((img, i) => {
    const faces: number[] = [];
    for (let f = 0; f < t!.face.length; f++) if (t!.face[f] === i) faces.push(f);
    if (!faces.length) return;
    const pos = new Float32Array(faces.length * 9), uv = new Float32Array(faces.length * 6);
    faces.forEach((f, j) => {
      for (let k = 0; k < 3; k++) {
        const v = m.indices[f * 3 + k] * 3;
        pos.set([m.positions[v], m.positions[v + 1], m.positions[v + 2]], j * 9 + k * 3);
      }
      uv.set(t!.uv.subarray(f * 6, f * 6 + 6), j * 6);
    });
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('uv', new BufferAttribute(uv, 2));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mat = new MeshStandardMaterial({
      // The image keeps its own colours, as in 3D Builder: no tone mapping (ACES washes them out)
      // and little of the room reflection.
      map: gpuTexture(img), roughness: 0.6, metalness: 0.05, side: DoubleSide, flatShading: true, toneMapped: false, envMapIntensity: 0.35,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
      transparent: img.wrap === 'clamp', alphaTest: img.wrap === 'clamp' ? 0.5 : 0,
    });
    const mesh = new Mesh(g, mat);
    mesh.receiveShadow = true;
    // Picking goes through the object's own mesh (its face indices).
    mesh.raycast = () => {};
    out.push(mesh);
  });
  return out;
}

const outlines = new WeakMap<MeshData, Float32Array>();

/**
 * Selection outline: the edges whose two faces meet at more than 30°, and the open edges, as
 * three's EdgesGeometry(geometry, 30) draws them, but read from the indexed mesh with integer edge
 * keys (EdgesGeometry hashes vertex positions as strings: seconds on a million triangles).
 * Vertices at the same place to 1e-4 mm count as one, as EdgesGeometry merges them. Cached per mesh.
 */
export function outlineGeometry(m: MeshData): BufferGeometry {
  let lines = outlines.get(m);
  if (!lines) { lines = outlineSegments(m); outlines.set(m, lines); }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(lines, 3));
  return g;
}

/** Open-addressing table size: a power of two at least twice `n`. */
const tableSize = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(16, n * 2)));

export function outlineSegments(m: MeshData, thresholdAngle = 30): Float32Array {
  const P = m.positions, I = m.indices;
  const nv = P.length / 3, nt = I.length / 3;
  // 1. Same position to 4 decimals, same vertex (EdgesGeometry's precision).
  const bits = new Float64Array(P.length);
  for (let i = 0; i < P.length; i++) bits[i] = Math.round(P[i] * 1e4);
  const vcap = tableSize(nv), vmask = vcap - 1;
  const vtab = new Int32Array(vcap).fill(-1);
  const canon = new Uint32Array(nv);
  for (let v = 0; v < nv; v++) {
    const x = bits[v * 3], y = bits[v * 3 + 1], z = bits[v * 3 + 2];
    let h = (Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(y | 0, 0x85ebca77) ^ Math.imul(z | 0, 0xc2b2ae3d)) >>> 0;
    for (;;) {
      h &= vmask;
      const u = vtab[h];
      if (u < 0) { vtab[h] = v; canon[v] = v; break; }
      if (bits[u * 3] === x && bits[u * 3 + 1] === y && bits[u * 3 + 2] === z) { canon[v] = u; break; }
      h++;
    }
  }
  // 2. Unit face normals.
  const normals = new Float32Array(nt * 3);
  for (let f = 0; f < nt; f++) {
    const a = I[f * 3] * 3, b = I[f * 3 + 1] * 3, c = I[f * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    normals[f * 3] = nx / l; normals[f * 3 + 1] = ny / l; normals[f * 3 + 2] = nz / l;
  }
  // 3. Edges keyed by their (smaller, larger) vertex. As EdgesGeometry: the first face of an edge
  // waits for the next one going the other way; the pair draws a line when their normals differ by
  // the threshold; an edge left without its pair (open, or wound the same way) draws a line too.
  const thresholdDot = Math.cos((thresholdAngle * Math.PI) / 180);
  const ecap = tableSize(nt * 1.5), emask = ecap - 1;
  const ka = new Uint32Array(ecap), kb = new Uint32Array(ecap);
  // Face index + 1 waiting for its pair, the direction in the sign; 0 = empty slot, PAIRED = matched.
  const state = new Int32Array(ecap);
  const PAIRED = 0x7fffffff;
  const out: number[] = [];
  const push = (u: number, v: number) => {
    out.push(P[u * 3], P[u * 3 + 1], P[u * 3 + 2], P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
  };
  for (let f = 0; f < nt; f++) {
    const c0 = canon[I[f * 3]], c1 = canon[I[f * 3 + 1]], c2 = canon[I[f * 3 + 2]];
    if (c0 === c1 || c1 === c2 || c2 === c0) continue; // degenerate, skipped as EdgesGeometry does
    for (let k = 0; k < 3; k++) {
      const a = k === 0 ? c0 : k === 1 ? c1 : c2, b = k === 0 ? c1 : k === 1 ? c2 : c0;
      const lo = a < b ? a : b, hi = a < b ? b : a, forward = a < b;
      let h = (Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca77)) >>> 0;
      for (;;) {
        h &= emask;
        const st = state[h];
        if (st === 0) { ka[h] = lo; kb[h] = hi; state[h] = forward ? f + 1 : -(f + 1); break; }
        if (ka[h] === lo && kb[h] === hi) {
          if (st === PAIRED) {
            // A third face on the edge starts a new wait, as EdgesGeometry does after a pair.
            state[h] = forward ? f + 1 : -(f + 1);
          } else if ((st > 0) !== forward) {
            const g = (st > 0 ? st : -st) - 1;
            const dot = normals[f * 3] * normals[g * 3] + normals[f * 3 + 1] * normals[g * 3 + 1] + normals[f * 3 + 2] * normals[g * 3 + 2];
            if (dot <= thresholdDot) push(lo, hi);
            state[h] = PAIRED;
          }
          break;
        }
        h++;
      }
    }
  }
  for (let h = 0; h < ecap; h++) {
    const st = state[h];
    if (st !== 0 && st !== PAIRED) push(ka[h], kb[h]);
  }
  return new Float32Array(out);
}

export function toGeometry(m: MeshData, smooth: boolean, faceColors?: Uint32Array, baseColor?: string): BufferGeometry {
  const g = new BufferGeometry();
  if (faceColors) {
    // Painted faces need their own vertices (one colour per face).
    const nt = m.indices.length / 3;
    const pos = new Float32Array(nt * 9), col = new Float32Array(nt * 9);
    const base = new Color(baseColor ?? '#9aa3ad');
    const c = new Color();
    for (let f = 0; f < nt; f++) {
      const fc = faceColors[f];
      if (fc === 0xffffffff) c.copy(base);
      else c.setHex(fc, SRGBColorSpace);
      for (let k = 0; k < 3; k++) {
        const v = m.indices[f * 3 + k] * 3;
        pos.set([m.positions[v], m.positions[v + 1], m.positions[v + 2]], f * 9 + k * 3);
        col.set([c.r, c.g, c.b], f * 9 + k * 3);
      }
    }
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('color', new BufferAttribute(col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
  // Indexed on the mesh's own arrays, faces in the mesh's order (picking's faceIndex is the mesh
  // face). Without smoothing the materials use flatShading (normals from the screen derivatives),
  // so the vertices need not be split per face nor carry normals.
  g.setAttribute('position', new BufferAttribute(m.positions, 3));
  g.setIndex(new BufferAttribute(m.indices, 1));
  if (smooth) g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function checkerTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#7a7d82';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#6a6d72';
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillRect(32, 32, 32, 32);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Ruler text lying flat on the plate, reading along +X. */
function label(text: string): Mesh {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.font = '500 34px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = 'rgba(40,42,46,0.7)';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, 32);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  const geo = new PlaneGeometry(28, 7);
  geo.translate(14, 0, 0);
  return new Mesh(geo, new MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
