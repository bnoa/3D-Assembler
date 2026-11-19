// Mouse camera of the 3D view, with the same rules as 3D Builder:
// - left drag on empty space orbits around the target: 2 radians of azimuth per view width and
//   2 radians of elevation per view height (dragging down raises the camera), elevation kept
//   within ±(90° − 0.57°);
// - right (or middle) drag pans: the target moves by dx·aspect·d·atan(fov) sideways and
//   dy·d·atan(fov) vertically, d being the camera distance, dx and dy the drag as fractions of the
//   view size, fov the full vertical field of view in radians;
// - the wheel zooms towards the target (not the cursor) by a factor 1 − Δ/960 per wheel event
//   (Δ = ±120 per notch, so ×0.875 in and ×1.125 out, never below ×0.125). Zooming out first
//   widens a field of view narrowed by the framing back towards 0.9 rad, then moves away.
// "View" sizes are those of the whole window area the 3D view stands for (see Viewport.resize):
// 3D Builder draws its view under the ribbon and the side panel, so its rates use that size.
import { EventDispatcher, MathUtils, PerspectiveCamera, Vector3 } from 'three';

/** Widest field of view of 3D Builder's camera (vertical, radians). */
export const MAX_FOV = 0.9;
const ELEVATION_LIMIT = 1.5607964; // π/2 − 0.01
const ORBIT_SPEED = 2;
const ANIMATION_SECONDS = 0.75;

type Mode = 'orbit' | 'pan' | null;

export interface CameraPose { eye: Vector3; target: Vector3; fov: number }

export class CameraControls extends EventDispatcher<{ change: object }> {
  readonly target = new Vector3();
  enabled = true;
  /** Zoom-out stops once distance × tan(fov) exceeds this (3D Builder: 1000 × scene size). */
  maxExtent = 152400;
  private mode: Mode = null;
  private last = { x: 0, y: 0 };
  private anim: { from: CameraPose; to: CameraPose; start: number } | null = null;
  private dirty = false;

  constructor(private camera: PerspectiveCamera, dom: HTMLElement, private viewSize: () => { w: number; h: number }) {
    super();
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('pointercancel', this.onUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Vertical field of view of the camera in radians. */
  get fov(): number { return MathUtils.degToRad(this.camera.fov); }
  set fov(v: number) {
    this.camera.fov = MathUtils.radToDeg(v);
    this.camera.updateProjectionMatrix();
  }

  /** Places the camera at once (stops a running animation). */
  setPose(eye: Vector3, target: Vector3, fov: number): void {
    this.anim = null;
    this.apply({ eye, target, fov });
  }

  /** Moves the camera to a pose over 0.75 s, as 3D Builder's framing does. */
  animateTo(eye: Vector3, target: Vector3, fov: number): void {
    this.anim = { from: this.pose(), to: { eye: eye.clone(), target: target.clone(), fov }, start: performance.now() };
    this.dirty = true;
  }

  /** Advances the animation; true when the camera changed since the last call. */
  update(): boolean {
    if (this.anim) {
      const k = Math.min(1, (performance.now() - this.anim.start) / (ANIMATION_SECONDS * 1000));
      const s = k * k * (3 - 2 * k);
      const { from, to } = this.anim;
      this.apply({ eye: from.eye.clone().lerp(to.eye, s), target: from.target.clone().lerp(to.target, s), fov: from.fov + (to.fov - from.fov) * s });
      if (k >= 1) this.anim = null;
    }
    const d = this.dirty;
    this.dirty = false;
    return d;
  }

  /** Orbit by a drag given as fractions of the view width and height. */
  rotate(dx: number, dy: number): void {
    const off = this.camera.position.clone().sub(this.target);
    const r = off.length();
    let az = Math.atan2(off.y, off.x);
    let el = Math.asin(MathUtils.clamp(off.z / (r || 1), -1, 1));
    az = (az - ORBIT_SPEED * dx) % (Math.PI * 2);
    el = MathUtils.clamp(el + ORBIT_SPEED * dy, -ELEVATION_LIMIT, ELEVATION_LIMIT);
    const eye = new Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)).multiplyScalar(r).add(this.target);
    this.apply({ eye, target: this.target.clone(), fov: this.fov });
  }

  /** Pan by a drag given as fractions of the view width and height (scene follows the cursor). */
  pan(dx: number, dy: number): void {
    const f = this.target.clone().sub(this.camera.position);
    const k = f.length() * Math.atan(this.fov);
    const right = f.clone().cross(new Vector3(0, 0, 1)).normalize();
    if (right.lengthSq() < 0.5) right.set(1, 0, 0);
    const up = right.clone().cross(f).normalize();
    const { w, h } = this.viewSize();
    const shift = right.multiplyScalar(-dx * (w / h) * k).add(up.multiplyScalar(dy * k));
    this.apply({ eye: this.camera.position.clone().add(shift), target: this.target.clone().add(shift), fov: this.fov });
  }

  /** Zoom by a factor (< 1 comes closer). */
  zoom(factor: number): void {
    let dist = this.camera.position.distanceTo(this.target);
    let fov = this.fov;
    const t = Math.tan(fov);
    if (factor >= 1) {
      if (dist * t > this.maxExtent) return;
      if (fov < MAX_FOV) fov = Math.atan(t * factor);
      else dist *= factor;
    } else {
      if (dist * t < 0.01) return;
      dist *= factor;
    }
    const dir = this.camera.position.clone().sub(this.target).normalize();
    this.apply({ eye: this.target.clone().addScaledVector(dir, dist), target: this.target.clone(), fov });
  }

  private pose(): CameraPose {
    return { eye: this.camera.position.clone(), target: this.target.clone(), fov: this.fov };
  }

  private apply(p: CameraPose): void {
    this.target.copy(p.target);
    this.camera.position.copy(p.eye);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(this.target);
    const dist = p.eye.distanceTo(p.target);
    this.camera.near = Math.max(0.01, dist * 0.01);
    this.camera.far = Math.max(5000, dist * 100);
    this.camera.fov = MathUtils.radToDeg(p.fov);
    this.camera.updateProjectionMatrix();
    this.dirty = true;
    this.dispatchEvent({ type: 'change' });
  }

  private onDown = (ev: PointerEvent): void => {
    if (!this.enabled) return;
    this.mode = ev.button === 0 ? 'orbit' : ev.button === 1 || ev.button === 2 ? 'pan' : null;
    if (!this.mode) return;
    this.anim = null;
    this.last = { x: ev.clientX, y: ev.clientY };
  };

  private onMove = (ev: PointerEvent): void => {
    if (!this.mode) return;
    if (!this.enabled) { this.mode = null; return; }
    const { w, h } = this.viewSize();
    const dx = (ev.clientX - this.last.x) / w, dy = (ev.clientY - this.last.y) / h;
    this.last = { x: ev.clientX, y: ev.clientY };
    if (!dx && !dy) return;
    if (this.mode === 'orbit') this.rotate(dx, dy);
    else this.pan(dx, dy);
  };

  private onUp = (): void => { this.mode = null; };

  private onWheel = (ev: WheelEvent): void => {
    if (!this.enabled) return;
    ev.preventDefault();
    // Browsers report about 100 px (or 3 lines) per notch; 3D Builder gets 120 per notch.
    const notches = ev.deltaMode === 1 ? ev.deltaY / 3 : ev.deltaMode === 2 ? ev.deltaY : ev.deltaY / 100;
    if (!notches) return;
    this.anim = null;
    this.zoom(Math.max(0.125, 1 + (notches * 120) / 960));
  };
}

/** Box 3D Builder frames when the scene is empty: its default plate, a 6-inch cube on the origin. */
export const VIEW_PLATE = { min: [-76.2, -76.2, 0] as const, max: [76.2, 76.2, 152.4] as const };
/** Direction 3D Builder looks along when it frames: from the front, 26.57° down (y forward 2, z −1). */
export const VIEW_DIRECTION = new Vector3(0, 2, -1).normalize();

/** Startup camera of 3D Builder: looking at the plate's centre from 208.5 mm, widest field of view. */
export function defaultPose(): CameraPose {
  const target = new Vector3(0, 0, 76.2);
  return { target, eye: target.clone().addScaledVector(VIEW_DIRECTION, -208.5), fov: MAX_FOV };
}

/**
 * Camera that frames a box, as 3D Builder's "Centrer la vue" and inserts do. The box is first
 * doubled around its centre plus 1/64 mm; the camera looks at its centre along VIEW_DIRECTION.
 * With the widest field of view (0.9 rad) the distance is the smallest that keeps the 8 corners
 * inside the frustum; if that is less than the plate's diagonal, the camera stays at the plate's
 * diagonal instead and the field of view narrows until the corners just fit. `aspect` is the
 * width / height of the view.
 */
export function frameBox(box: { min: readonly number[]; max: readonly number[] }, aspect: number): CameraPose {
  const c = new Vector3((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
  const lo = [0, 1, 2].map((i) => c.getComponent(i) + 2 * (box.min[i] - c.getComponent(i)) - 1 / 64);
  const hi = [0, 1, 2].map((i) => c.getComponent(i) + 2 * (box.max[i] - c.getComponent(i)) + 1 / 64);
  const corners: Vector3[] = [];
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) corners.push(new Vector3(x, y, z));
  const d = VIEW_DIRECTION.clone();
  const r = d.clone().cross(new Vector3(0, 0, 1)).normalize();
  const u = r.clone().cross(d);
  const half = MAX_FOV / 2, s = Math.sin(half), co = Math.cos(half);
  // Frustum side planes through the centre: n = sin·d ± cos·u and n = sin·d ± cos·r / aspect.
  const normals = [
    d.clone().multiplyScalar(s).addScaledVector(u, -co), d.clone().multiplyScalar(s).addScaledVector(u, co),
    d.clone().multiplyScalar(s).addScaledVector(r, -co / aspect), d.clone().multiplyScalar(s).addScaledVector(r, co / aspect),
  ];
  let t = -Infinity;
  for (const p of corners) {
    const v = p.clone().sub(c);
    for (const n of normals) t = Math.max(t, -n.dot(v) / s);
  }
  const plateDiag = new Vector3(...VIEW_PLATE.max).sub(new Vector3(...VIEW_PLATE.min)).length();
  if (t >= plateDiag) return { target: c, eye: c.clone().addScaledVector(d, -t), fov: MAX_FOV };
  const eye = c.clone().addScaledVector(d, -plateDiag);
  let m = 0;
  for (const p of corners) {
    const v = p.clone().sub(eye);
    const z = Math.abs(v.dot(d));
    m = Math.max(m, Math.abs(v.dot(u)) / z, Math.abs(v.dot(r)) / (aspect * z));
  }
  return { target: c, eye, fov: 2 * Math.atan(m) };
}
