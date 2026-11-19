// Tool modes: the blue bar with Annuler / OK plus the tool's own controls, and a live preview.
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Matrix4, Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { MATERIALS, type MaterialKind, NO_PAINT, type SceneObject, movedTransform, objectMatrix, worldMesh } from '../core/model';
import { type MeshData, bounds, merged, transformed, triCount } from '../core/mesh-data';
import { hexToInt, intToHex, paintRegion } from '../geometry/paint';
import { SIMPLIFY_MAX_PASSES, simplifyPasses } from '../geometry/simplify-passes';
import { makePrimitive } from '../geometry/primitives';
import { settleRotation } from '../geometry/settle';
import { snapOnFloor, snapOnTriangle } from '../geometry/measure-snap';
import { CUSTOM_COLOR, CUSTOM_SHAPES, dynamicMax, makeCustom } from '../geometry/custom';
import { smoothTool } from '../geometry/smooth';
import { TEXTURES, type TexturePixels, WALLPAPER_DEFAULTS, padImage, proceduralTexture, stickerUV, wallpaperUV } from '../geometry/texture';
import { type ObjectTexture, type TextureImage, compactTexture, emptyTexture, imageIndex } from '../core/texture-data';
import { IMAGE_DEFAULTS, type ImageMode, contourLevels, imageData, imageTexture, insertImage } from '../geometry/image-insert';
import * as csg from '../geometry/csg';
import { type Direction, type EmbossResult, type Motif, PROJECTIONS, type Projection, SHAPES, emboss, motifOutline } from '../geometry/emboss';
import { encodeQr, qrImage } from '../geometry/qr';
import { canReadSystemFonts, registerFontFile, systemFontFamilies } from '../geometry/font-outline';
import { analyzePrint, facesSubset } from '../analysis/printability';
import { icon } from './icons';
import { currentLang, toEnglish } from './i18n';
import { exportScene } from '../io/formats';
import { download } from './dom';
import { h, pickFiles } from './dom';
import { type App, UNITS } from './app';

export interface ModeContext {
  app: App;
  bar: HTMLElement;
  selection: SceneObject[];
  world: MeshData[]; // selection meshes in world coordinates
  /** A tool's own step history (Annuler / Refaire of the bar), when it keeps it itself. */
  history?: { undo(): void; redo(): void };
}

export interface ModeSpec {
  okLabel: string;
  /** The mode edits the document step by step: Annuler / Refaire buttons on the right of the bar, as 3D Builder. */
  history?: boolean;
  /** Help shown at the bottom right while the tool is open (3D Builder's tip). */
  tip?: string;
  /** No validation button (3D Builder's Mesure: Annuler only). */
  noOk?: boolean;
  /** Adds controls to the bar; may return a cleanup function. */
  build(ctx: ModeContext): (() => void) | void;
  /** Applies the tool. Throwing keeps the mode open with an error message. */
  apply(ctx: ModeContext): Promise<true>;
}

/** Runs async previews, dropping results that arrive after a newer request. */
function previewer(ctx: ModeContext, compute: () => Promise<{ mesh: MeshData; color: string; opacity?: number; faceColors?: Uint32Array; texture?: ObjectTexture }[]>) {
  let token = 0;
  let timer = 0;
  return (delay = 120) => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const mine = ++token;
      try {
        const res = await compute();
        if (mine !== token) return;
        ctx.app.view.setHidden(ctx.selection.map((o) => o.id));
        ctx.app.view.showPreview(res);
      } catch (e) {
        if (mine === token) ctx.app.toast(e instanceof Error ? e.message : String(e), 'warn');
      }
    }, delay);
  };
}

/** A tool's bar at the bottom of the scene, as 3D Builder's (Mouvement / Rotation / Échelle and values). */
function floatingBar(ctx: ModeContext): HTMLElement {
  const el = h('div', { class: 'tbar' });
  (ctx.app.view as unknown as { host: HTMLElement }).host.append(el);
  return el;
}
const fmtVal = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',');
/** One value of a bottom bar (coloured underline per axis, as 3D Builder). */
function barValue(axis: string, name: string, value: number, set: (v: number) => void, readOnly = false): HTMLElement {
  const input = h('input', { type: 'text', inputmode: 'decimal', value: fmtVal(value), 'aria-label': name, readonly: readOnly }) as HTMLInputElement;
  input.addEventListener('change', () => { const v = parseFloat(input.value.replace(',', '.')); if (Number.isFinite(v)) set(v); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); e.stopPropagation(); });
  return h('label', { class: `val ${axis}` }, h('small', {}, name), input);
}
function barTool(on: boolean, ico: string, label: string, run: () => void): HTMLElement {
  return h('button', { class: `tool${on ? ' on' : ''}`, title: label, 'aria-label': label, html: icon(ico, 22), onclick: run });
}

function slider(label: string, min: number, max: number, step: number, value: number, oninput: (v: number) => void, onchange?: (v: number) => void) {
  const input = h('input', { type: 'range', min, max, step, value: String(value), 'aria-label': label });
  input.addEventListener('input', () => oninput(+input.value));
  if (onchange) input.addEventListener('change', () => onchange(+input.value));
  return h('label', {}, label, input);
}

/**
 * Smoothing passes: the slider value, as in 3D Builder. Loop subdivision multiplies the faces by 4
 * per pass, so passes that would exceed 4 million faces are dropped to keep the browser alive.
 */
function smoothPasses(ctx: ModeContext, edges: boolean): number {
  const level = st(ctx, 'level', 3);
  if (!edges) return level;
  let faces = ctx.world[0].indices.length / 3, n = 0;
  while (n < level && faces * 4 <= 4e6) { faces *= 4; n++; }
  return level > 0 ? Math.max(1, n) : 0;
}

/** Part(s) kept by Fractionner, remembered from one use to the next as in 3D Builder. */
let splitKeep = 'top';
/** Wall thickness of Creux, kept from one use to the next as in 3D Builder. */
let hollowThickness = 1;

interface EmbossState {
  motif: Motif; direction: Direction; projection: Projection; size: number; depth: number;
  offsetU: number; offsetV: number; rotation: number; bevel: boolean; bevelPct: number; top: string | null; side: string | null;
  /** Height / width scale of the motif (3D Builder's Y % / X %, 1 when locked). */
  scaleY: number;
}

/** Width and height of the last motif outline for a size of 1 (bottom bar values in mm). */
let lastMotifSize: [number, number] = [1, 1];

async function runEmboss(ctx: ModeContext, s: EmbossState): Promise<EmbossResult> {
  let outline = await motifOutline(s.motif, s.size);
  if (!outline.length) throw new Error('Motif vide.');
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of outline) for (const [x, y] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  lastMotifSize = [(x1 - x0) / s.size, (y1 - y0) / s.size];
  if (s.scaleY !== 1) outline = outline.map((p) => p.map(([x, y]) => [x, y * s.scaleY] as [number, number]));
  return emboss(ctx.world[0], {
    outline, projection: s.projection, direction: s.direction, offsetU: s.offsetU, offsetV: s.offsetV,
    rotation: s.rotation, depth: s.depth, bevel: s.bevel, bevelHeight: s.bevelPct / 100, faceColors: ctx.selection[0].faceColors,
    topColor: s.top ? hexToInt(s.top) : undefined, sideColor: s.side ? hexToInt(s.side) : undefined,
  });
}

/** 3D Builder's on / off switch: label, a pill, then « Activé » or « Désactivé ». */
function switchToggle(label: string, on: boolean, onchange: (on: boolean) => void, en?: string): HTMLElement {
  const state = h('span', { class: 'switch-state' }, on ? 'Activé' : 'Désactivé');
  const pill = h('button', { class: `switch${on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(on), 'aria-label': label });
  pill.addEventListener('click', () => {
    on = !on;
    pill.classList.toggle('on', on);
    pill.setAttribute('aria-checked', String(on));
    state.textContent = on ? 'Activé' : 'Désactivé';
    onchange(on);
  });
  return h('span', { class: 'switch-row' }, h('span', en ? { 'data-en': en } : {}, label), pill, state);
}

function toggle(label: string, ico: string, on: boolean, onclick: (btn: HTMLButtonElement) => void) {
  const b = h('button', { class: `toggle${on ? ' on' : ''}`, html: `${icon(ico)}<span>${label}</span>` });
  b.addEventListener('click', () => onclick(b));
  return b;
}

/** 3D Builder's "Couleurs standard" (sampled from its colour menu: Paint's palette). */
const STANDARD_COLORS = ['#ffffff', '#000000', '#7f7f7f', '#880015', '#ed1c24', '#ff7f27', '#fff200', '#b5e61d', '#22b14c', '#00a2e8', '#3f48cc', '#a349a4'];

function recentColors(): string[] {
  try { return JSON.parse(localStorage.getItem('3dbr.recentColors') ?? '[]') as string[]; } catch { return []; }
}
function rememberColor(c: string): void {
  try { localStorage.setItem('3dbr.recentColors', JSON.stringify([c, ...recentColors().filter((x) => x !== c)].slice(0, 12))); } catch { /* storage unavailable */ }
}

/**
 * Colour button as 3D Builder's: a swatch opening a menu with Compte-gouttes (pick a colour on an
 * object), Plus de couleurs… (system colour dialog), Couleurs récentes and Couleurs standard.
 */
function colorPicker(label: string, get: () => string, choose: (c: string) => void, eyedrop: () => void): HTMLElement {
  const swatch = h('span', { style: `display:inline-block;width:24px;height:24px;border:1px solid rgba(255,255,255,.6);background:${get()}` });
  const more = h('input', { type: 'color', style: 'position:absolute;opacity:0;width:0;height:0', 'aria-hidden': 'true' }) as HTMLInputElement;
  const pick = (c: string) => { choose(c); rememberColor(c); swatch.style.background = c; close(); };
  more.addEventListener('input', () => { choose(more.value); swatch.style.background = more.value; });
  more.addEventListener('change', () => pick(more.value));
  let menu: HTMLElement | null = null;
  const close = () => { menu?.remove(); menu = null; document.removeEventListener('pointerdown', outside, true); };
  const outside = (e: Event) => { if (menu && !menu.contains(e.target as Node) && !btn.contains(e.target as Node)) close(); };
  const chip = (c: string) => h('button', { title: c, style: `width:26px;height:26px;margin:4px;background:${c};border:1px solid rgba(255,255,255,.4)`, onclick: () => pick(c) });
  const item = (text: string, run: () => void) => h('button', { style: 'display:block;width:100%;text-align:left;padding:8px 12px', onclick: run }, text);
  const btn = h('button', {
    class: 'color-btn', title: label, 'aria-label': label, style: 'display:flex;align-items:center;gap:6px;padding:6px',
    onclick: () => {
      if (menu) return close();
      const rect = btn.getBoundingClientRect();
      const recent = recentColors();
      menu = h('div', { class: 'color-menu', style: `position:fixed;left:${rect.left}px;top:${rect.bottom + 4}px;z-index:50;background:#2b2b2b;color:#fff;min-width:230px;box-shadow:0 6px 24px rgba(0,0,0,.5)` },
        item('Compte-gouttes', () => { close(); eyedrop(); }),
        item('Plus de couleurs…', () => { more.value = get(); more.click(); }),
        h('div', { style: 'padding:6px 12px;font-size:12px;opacity:.75' }, 'Couleurs récentes'),
        h('div', { style: 'padding:0 8px' }, ...recent.map(chip)),
        h('div', { style: 'padding:6px 12px;font-size:12px;opacity:.75' }, 'Couleurs standard'),
        h('div', { style: 'padding:0 8px 8px;display:grid;grid-template-columns:repeat(6,34px)' }, ...STANDARD_COLORS.map(chip)));
      document.body.append(menu);
      setTimeout(() => document.addEventListener('pointerdown', outside, true));
    },
  }, swatch, h('span', { html: icon('chevronDown', 14) }), more);
  (btn as HTMLElement & { setColor?: (c: string) => void }).setColor = (c: string) => { swatch.style.background = c; };
  return btn;
}

/** Small canvas thumbnail of texture pixels (nearest sampling; no data URL, which is slow). */
function pixelsThumb(px: TexturePixels, size: number): HTMLCanvasElement {
  const t = document.createElement('canvas');
  t.width = t.height = size;
  const out = new ImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = Math.floor((x / size) * px.width), sy = Math.floor((y / size) * px.height);
    const i = (sy * px.width + sx) * 4, o = (y * size + x) * 4;
    out.data[o] = px.data[i]; out.data[o + 1] = px.data[i + 1]; out.data[o + 2] = px.data[i + 2]; out.data[o + 3] = px.data[i + 3];
  }
  t.getContext('2d')!.putImageData(out, 0, 0);
  t.style.cssText = 'width:100%;height:100%';
  return t;
}

/** A shape of the texture menu as an image: dark shape, light or transparent ground. */
const shapeCache = new Map<string, Promise<TexturePixels | null>>();
function shapePixels(id: string, transparent: boolean): Promise<TexturePixels | null> {
  const key = id + (transparent ? ':t' : ':o');
  let p = shapeCache.get(key);
  // Drawn later, one per task, so that opening the menu stays immediate.
  if (!p) shapeCache.set(key, (p = new Promise((res) => setTimeout(() => res(drawShape(id, transparent)), 0))));
  return p;
}

async function drawShape(id: string, transparent: boolean): Promise<TexturePixels | null> {
  const polys = await motifOutline({ kind: 'shape', shape: id }, 100);
  if (!polys.length) return null;
  const xs = polys.flat().map((p) => p[0]), ys = polys.flat().map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const S = 512, pad = 24, k = (S - 2 * pad) / Math.max(maxX - minX, maxY - minY);
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  if (!transparent) { g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S); }
  g.fillStyle = '#000000';
  g.beginPath();
  for (const p of polys) p.forEach(([x, y], i) => {
    const X = S / 2 + (x - (minX + maxX) / 2) * k, Y = S / 2 - (y - (minY + maxY) / 2) * k;
    if (i) g.lineTo(X, Y); else g.moveTo(X, Y);
  });
  g.fill('evenodd');
  const d = g.getImageData(0, 0, S, S);
  return { width: S, height: S, data: d.data };
}

/** Colour of a clicked face: its painted colour, or the object's. */
function faceColorOf(o: SceneObject, face: number): string {
  const fc = o.faceColors?.[face];
  return fc !== undefined && fc !== NO_PAINT ? intToHex(fc) : o.color;
}

type V3 = [number, number, number];
let lastEmboss: Partial<EmbossState> | null = null;
const cross3 = (a: number[], b: number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: number[]): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Projection frame of a side (d towards the viewer, u right, v up), as for the emboss tool. */
function frameOf(dir: Direction): { d: number[]; u: number[]; v: number[] } {
  switch (dir) {
    case '-y': return { d: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] };
    case '+y': return { d: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] };
    case '-x': return { d: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] };
    case '+x': return { d: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] };
    case '+z': return { d: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] };
  }
}

function faceNormalOf(m: MeshData, f: number): number[] {
  const p = m.positions, t = m.indices;
  const a = t[f * 3] * 3, b = t[f * 3 + 1] * 3, c = t[f * 3 + 2] * 3;
  return cross3([p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]]);
}

/** Cutting plane of the split tool: +Z tilted about X then Y, through the centre at height z. */
function splitPlane(ctx: ModeContext, b: ReturnType<typeof bounds>): { normal: V3; point: V3 } {
  const ax = (st(ctx, 'tiltX', 0) * Math.PI) / 180, ay = (st(ctx, 'tiltY', 0) * Math.PI) / 180, az = (st(ctx, 'tiltZ', 0) * Math.PI) / 180;
  // Rx, then Ry, then Rz applied to (0, 0, 1) (3D Builder's Roulis, Tangage, Lacet)
  const n1: V3 = [0, -Math.sin(ax), Math.cos(ax)];
  const n2: V3 = [n1[0] * Math.cos(ay) + n1[2] * Math.sin(ay), n1[1], -n1[0] * Math.sin(ay) + n1[2] * Math.cos(ay)];
  const normal = normalize([n2[0] * Math.cos(az) - n2[1] * Math.sin(az), n2[0] * Math.sin(az) + n2[1] * Math.cos(az), n2[2]]);
  return { normal, point: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, st(ctx, 'z', 0)] };
}

/**
 * Thin walls are fixed like in 3D Builder: one uniform scale factor s = minWall / (thinnest wall
 * of all the objects), applied to every object, accepted only if each still fits the plate (3D
 * Builder compares strictly and swaps Y and Z in one of its two size checks; 3D Assembler uses ≤ on the
 * right axes).
 */
function thicken(ctx: ModeContext, minWall: number): void {
  const bed = ctx.app.bed();
  const doc = ctx.app.doc;
  const reports = ctx.world.map((w) => analyzePrint(w, { minWall, bed }));
  const thinnest = Math.min(...reports.map((r) => r.minThickness));
  if (!Number.isFinite(thinnest) || thinnest >= minWall - 0.001) return void ctx.app.toast('Aucun mur plus fin que le minimum.', 'info');
  const k = minWall / thinnest;
  if (reports.some((r) => r.size[0] * k > bed.x || r.size[1] * k > bed.y || r.size[2] * k > bed.z)) {
    return void ctx.app.toast('Certaines parties sont trop fines pour être imprimées, même à la taille maximale possible.', 'warn');
  }
  doc.checkpoint();
  const changed = true;
  ctx.world.forEach((w, i) => {
    const o = ctx.selection[i];
    const lift = (o.position[2] - bounds(w).min[2]) * (k - 1);
    doc.update(o.id, { scale: o.scale.map((v) => v * k) as [number, number, number], position: [o.position[0], o.position[1], o.position[2] + lift] });
  });
  ctx.app.toast(`Objet${ctx.world.length > 1 ? 's' : ''} agrandi${ctx.world.length > 1 ? 's' : ''} ×${k.toFixed(2)} : le mur le plus fin atteint ${minWall} mm.`, 'ok');
  if (changed) {
    doc.emit();
    ctx.app.exitMode();
    ctx.app.enterMode(MODES.print); // re-analyse at the new size
  }
}

const state = new WeakMap<ModeContext, Record<string, unknown>>();
const st = <T>(ctx: ModeContext, key: string, init: T): T => {
  let s = state.get(ctx);
  if (!s) state.set(ctx, (s = {}));
  if (!(key in s)) s[key] = init;
  return s[key] as T;
};
const set = (ctx: ModeContext, key: string, v: unknown) => {
  st(ctx, key, v);
  state.get(ctx)![key] = v;
};

export const MODES: Record<string, ModeSpec> = {
  print3d: {
    okLabel: 'Exporter pour l’impression',
    build(ctx) {
      // 3D Builder's "Imprimer en 3D" screen, Disposition page: units, a uniform scale (%) and the
      // three sizes of the whole scene, with "Réinitialiser l'échelle"; the scene itself is left
      // unchanged. A web page cannot reach Windows 3D printers, so the job is a 3MF file for a slicer.
      const app = ctx.app;
      const objs = app.doc.objects;
      const world = objs.map((o) => worldMesh(o));
      const b = bounds(merged(world));
      const base = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
      const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
      let unit: keyof typeof UNITS = 'mm';
      let k = 1;
      const scaled = () => world.map((w) => transformed(w, [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, cx * (1 - k), cy * (1 - k), -b.min[2] * k, 1]));
      const fmt = (v: number) => String(Math.round((v / UNITS[unit].mm) * 1000) / 1000);
      const pct = h('input', { type: 'number', min: '1', step: '1', 'aria-label': 'Mise à l’échelle (%)', style: 'width:80px' }) as HTMLInputElement;
      const dims = ['Largeur', 'Profondeur', 'Hauteur'].map((label) => h('input', { type: 'number', min: '0', step: 'any', 'aria-label': label, style: 'width:90px' }) as HTMLInputElement);
      const unitSel = h('select', { 'aria-label': 'Unités' }, ...Object.entries(UNITS).map(([id, u]) => h('option', { value: id, selected: id === 'mm' }, u.label))) as HTMLSelectElement;
      const warn = h('div', { class: 'stat', style: 'text-align:left' });
      const draw = () => {
        pct.value = String(Math.round(k * 10000) / 100);
        dims.forEach((d, i) => (d.value = fmt(base[i] * k)));
        const meshes = scaled();
        set(ctx, 'meshes', meshes);
        app.view.setHidden(objs.map((o) => o.id));
        app.view.showPreview(meshes.map((mesh, i) => ({ mesh, color: objs[i].color, faceColors: objs[i].faceColors })));
        const bed = app.bed();
        const s = base.map((v) => v * k);
        warn.textContent = s[0] > bed.x || s[1] > bed.y || s[2] > bed.z ? '⚠ Le modèle dépasse le plateau d’impression.' : '';
      };
      pct.addEventListener('change', () => { const v = parseFloat(pct.value.replace(',', '.')); if (v > 0) k = v / 100; draw(); });
      dims.forEach((d, i) => d.addEventListener('change', () => {
        const v = parseFloat(d.value.replace(',', '.')) * UNITS[unit].mm;
        if (v > 0 && base[i] > 0) k = v / base[i];
        draw();
      }));
      unitSel.addEventListener('change', () => { unit = unitSel.value as typeof unit; draw(); });
      ctx.bar.append(
        h('label', {}, 'Unités', unitSel),
        h('label', {}, 'Mise à l’échelle', pct, '%'),
        ...dims.map((d) => h('label', {}, d.getAttribute('aria-label')!, d)),
        h('button', { class: 'toggle', onclick: () => { k = 1; draw(); } }, 'Réinitialiser l’échelle'),
        // The print analysis (overhangs, thin walls, plate) is part of 3D Builder's print flow.
        h('button', { class: 'toggle', onclick: () => { if (ctx.app.doc.selected.length || ctx.app.doc.objects.length) { if (!ctx.app.doc.selected.length) ctx.app.doc.select(ctx.app.doc.objects.map((o) => o.id)); ctx.app.enterMode(MODES.print); } } }, 'Analyser'),
        warn,
      );
      draw();
    },
    async apply(ctx) {
      const app = ctx.app;
      const meshes = st<MeshData[]>(ctx, 'meshes', []);
      const items = app.doc.objects.map((o, i) => ({ name: o.name, mesh: meshes[i], color: o.color, faceColors: o.faceColors, texture: o.texture }));
      download(await exportScene(items, '3mf', app.doc.name, app.doc.info), `${app.doc.name}.3mf`);
      return true;
    },
  },

  position: {
    okLabel: 'Positionner',
    build(ctx) {
      // 3D Builder's Positionner: dragging an object lifts it above the plate and turns it like a
      // trackball; on release it falls and comes to rest (the same settling as Poser à plat).
      const view = ctx.app.view;
      type Item = { base: MeshData; hull: V3[]; q: Matrix4; radius: number };
      const items: Item[] = [];
      const ready = Promise.all(ctx.world.map(async (w) => {
        const hull = await csg.hullPoints(w);
        const b = bounds(w);
        const radius = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 || 1;
        return { base: w, hull, q: new Matrix4(), radius };
      })).then((r) => { items.push(...r); });
      const hullOf = (it: Item, q: Matrix4) => it.hull.map((p) => new Vector3(...p).applyMatrix4(q));
      const centreOf = (pts: Vector3[]) => {
        const lo = pts.reduce((a, p) => a.min(p), pts[0].clone()), hi = pts.reduce((a, p) => a.max(p), pts[0].clone());
        return lo.add(hi).multiplyScalar(0.5);
      };
      let drag: { i: number; x: number; y: number; q0: Matrix4; c: Vector3; lift: number } | null = null;
      const draw = () => {
        view.setHidden(ctx.selection.map((o) => o.id));
        view.showPreview(items.map((it, i) => {
          let q = it.q;
          if (drag && drag.i === i) q = new Matrix4().makeTranslation(0, 0, drag.lift).multiply(q);
          return { mesh: transformed(it.base, q.elements), color: ctx.selection[i].color, faceColors: ctx.selection[i].faceColors };
        }));
      };
      void ready.then(draw);
      set(ctx, 'items', items);
      const past: Matrix4[][] = [], future: Matrix4[][] = [];
      const snap = () => items.map((it) => it.q.clone());
      const restore = (qs: Matrix4[]) => { qs.forEach((q, i) => { items[i].q = q.clone(); }); set(ctx, 'changed', true); draw(); };
      ctx.history = {
        undo() { const s = past.pop(); if (s) { future.push(snap()); restore(s); } },
        redo() { const s = future.pop(); if (s) { past.push(snap()); restore(s); } },
      };
      view.toolPointer = {
        down(ev) {
          if (!items.length) return false;
          const i = view.pickOverlay(ev);
          if (i === null) return false;
          const it = items[i];
          past.push(snap());
          future.length = 0;
          const pts = hullOf(it, it.q);
          // Lifted so that it can turn freely without going through the plate.
          const c = centreOf(pts);
          drag = { i, x: ev.clientX, y: ev.clientY, q0: it.q.clone(), c, lift: Math.max(0, it.radius * 1.5 - c.z) };
          draw();
          return true;
        },
        move(ev) {
          if (!drag) return;
          const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
          const len = Math.hypot(dx, dy);
          const it = items[drag.i];
          if (len < 1) { it.q = drag.q0.clone(); draw(); return; }
          // Trackball: horizontal motion turns about the camera's up axis, vertical about its right axis.
          const cam = view.camera.matrixWorld.elements;
          const right = new Vector3(cam[0], cam[1], cam[2]), up = new Vector3(cam[4], cam[5], cam[6]);
          const axis = up.multiplyScalar(dx).add(right.multiplyScalar(dy)).normalize();
          const c = drag.c;
          const r = new Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new Matrix4().makeRotationAxis(axis, len * 0.01)).multiply(new Matrix4().makeTranslation(-c.x, -c.y, -c.z));
          it.q = r.multiply(drag.q0);
          draw();
        },
        up() {
          if (!drag) return;
          const it = items[drag.i];
          drag = null;
          // Fall and settle, then rest on the plate.
          const mesh = transformed(it.base, it.q.elements);
          const { R, pivot: p } = settleRotation(mesh, hullOf(it, it.q).map((v) => [v.x, v.y, v.z] as V3));
          const rot = new Matrix4().set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1);
          let q = new Matrix4().makeTranslation(p[0], p[1], p[2]).multiply(rot).multiply(new Matrix4().makeTranslation(-p[0], -p[1], -p[2])).multiply(it.q);
          const zmin = Math.min(...hullOf(it, q).map((v) => v.z));
          q = new Matrix4().makeTranslation(0, 0, -zmin).multiply(q);
          it.q = q;
          set(ctx, 'changed', true);
          draw();
        },
      };
      ctx.bar.append(h('div', { class: 'stat', style: 'text-align:left' }, 'Faites glisser un objet pour le faire basculer : il retombe sur le plateau.'));
      return () => { view.toolPointer = null; };
    },
    async apply(ctx) {
      const items = st<{ base: MeshData; q: Matrix4 }[]>(ctx, 'items', []);
      if (!st(ctx, 'changed', false) || items.length !== ctx.selection.length) return true;
      // The tumbles go into each object's rotation and position, as in 3D Builder.
      const doc = ctx.app.doc;
      doc.checkpoint();
      ctx.selection.forEach((o, i) => doc.update(o.id, movedTransform(o, items[i].q)));
      doc.emit();
      return true;
    },
  },

  custom: {
    okLabel: 'Ajouter',
    build(ctx) {
      // 3D Builder's Personnalisé: the shape is shown in the scene while its settings change, with a
      // "Rendu filaire" toggle; every change of shape resets the defaults.
      let shape = CUSTOM_SHAPES[0];
      const values: Record<string, number> = {};
      set(ctx, 'values', values);
      set(ctx, 'shape', shape);
      const draw = () => {
        const mesh = makeCustom(shape.id, values);
        const b = bounds(mesh);
        // Where "Ajouter" will put it: resting on the plate.
        const placed = { positions: mesh.positions.map((x, i) => (i % 3 === 2 ? x - b.min[2] : x)), indices: mesh.indices };
        set(ctx, 'mesh', mesh);
        ctx.app.view.showPreview([{ mesh: placed, color: CUSTOM_COLOR, wireframe: st(ctx, 'wire', true) }]);
      };
      const fields = h('span', { style: 'display:contents' });
      // Annuler / Refaire of the settings, as 3D Builder (right of the bar).
      type Snap = { shape: string; values: Record<string, number> };
      const snap = (): Snap => ({ shape: shape.id, values: { ...values } });
      const past: Snap[] = [], future: Snap[] = [];
      let prev: Snap | null = null;
      const record = () => { const now = snap(); if (prev && JSON.stringify(prev) !== JSON.stringify(now)) { past.push(prev); future.length = 0; } prev = now; };
      const restore = (from: Snap[], to: Snap[]) => {
        const p = from.pop();
        if (!p) return;
        to.push(snap());
        shape = CUSTOM_SHAPES.find((x) => x.id === p.shape)!;
        set(ctx, 'shape', shape);
        select.value = shape.id;
        renderFields(p.values);
        prev = snap();
      };
      ctx.history = { undo: () => restore(past, future), redo: () => restore(future, past) };
      const renderFields = (preset?: Record<string, number>) => {
        for (const k of Object.keys(values)) delete values[k];
        for (const p of shape.params) values[p.key] = preset?.[p.key] ?? p.value;
        const inputs = shape.params.map((p) => {
          const input = h('input', { type: 'number', min: String(p.min), max: String(p.max), step: String(p.step), value: String(values[p.key]), 'aria-label': p.label, style: 'width:60px;min-width:0' }) as HTMLInputElement;
          const commit = (final: boolean) => {
            let v = parseFloat(input.value.replace(',', '.'));
            if (!Number.isFinite(v)) { if (final) input.value = String(values[p.key]); return; }
            const max = dynamicMax(shape.id, p.key, values) ?? p.max;
            v = Math.min(max, Math.max(p.min, p.step === 1 && !p.unit ? Math.round(v) : v));
            if (final) input.value = String(v);
            if (v === values[p.key]) return;
            values[p.key] = v;
            // Bounds depending on this value (rounding of the cube, hole of the torus).
            shape.params.forEach((q, i) => {
              const m = dynamicMax(shape.id, q.key, values);
              if (m === undefined) return;
              inputs[i].max = String(m);
              if (values[q.key] > m) { values[q.key] = m; inputs[i].value = String(m); }
            });
            draw();
          };
          input.addEventListener('input', () => commit(false));
          input.addEventListener('change', () => { commit(true); record(); });
          return input;
        });
        shape.params.forEach((q, i) => { const m = dynamicMax(shape.id, q.key, values); if (m !== undefined) inputs[i].max = String(m); });
        fields.replaceChildren(...shape.params.map((p, i) => h('label', {}, p.label, inputs[i], p.unit ?? '')));
        draw();
      };
      const select = h('select', { 'aria-label': 'Forme' }, ...CUSTOM_SHAPES.map((s) => h('option', { value: s.id }, s.label))) as HTMLSelectElement;
      select.addEventListener('change', () => {
        shape = CUSTOM_SHAPES.find((s) => s.id === select.value)!;
        set(ctx, 'shape', shape);
        renderFields();
        record();
      });
      // As 3D Builder: Rendu filaire first (a switch, on), then Forme and its values.
      ctx.bar.append(
        switchToggle('Rendu filaire', true, (on) => { set(ctx, 'wire', on); draw(); }),
        h('span', { class: 'vsep' }),
        h('label', {}, 'Forme', select),
        fields,
      );
      renderFields();
      record();
    },
    async apply(ctx) {
      const shape = st<(typeof CUSTOM_SHAPES)[number]>(ctx, 'shape', CUSTOM_SHAPES[0]);
      const mesh = st<MeshData | null>(ctx, 'mesh', null) ?? makeCustom(shape.id, st(ctx, 'values', {}));
      const doc = ctx.app.doc;
      doc.checkpoint();
      const o = doc.addWorldMesh(mesh, { name: `${currentLang() === 'en' ? toEnglish(shape.label) : shape.label}${doc.objects.length + 1}`, color: CUSTOM_COLOR, dropOnPlate: true });
      doc.select([o.id]);
      return true;
    },
  },

  simplify: {
    okLabel: 'Réduire les faces',
    build(ctx) {
      const original = triCount(ctx.world[0]);
      const now = h('span', {}, String(original));
      const run = previewer(ctx, async () => {
        // As 3D Builder: the slider is a number of passes, 0 to 6, of its own
        // vertex-merging simplifier (simplify-passes.ts); faces keep their colours.
        const r = simplifyPasses(ctx.world[0], st(ctx, 'level', 0), ctx.selection[0].faceColors);
        set(ctx, 'result', r);
        now.textContent = String(triCount(r.mesh));
        // 3D Builder draws the mesh's triangles over the object while simplifying.
        return [{ mesh: r.mesh, color: ctx.selection[0].color, faceColors: r.faceColors }, { mesh: r.mesh, color: '#3a3f46', wireframe: true, onTop: true }];
      });
      ctx.bar.append(
        slider('Niveau de réduction', 0, SIMPLIFY_MAX_PASSES, 1, 0, (v) => { set(ctx, 'level', v); run(); }),
        h('span', { class: 'vsep' }),
        h('div', { class: 'stat' }, h('div', {}, 'Nombre de faces ', now), h('div', {}, `Nombre de faces d’origine ${original}`)),
      );
      run(0); // shows the triangles from the start
    },
    async apply(ctx) {
      const r = st<{ mesh: MeshData; faceColors?: Uint32Array } | null>(ctx, 'result', null) ?? simplifyPasses(ctx.world[0], st(ctx, 'level', 0), ctx.selection[0].faceColors);
      ctx.app.replaceObjects(ctx.selection, [[r.mesh]], { faceColors: [[r.faceColors]] });
      return true;
    },
  },

  split: {
    okLabel: 'Fractionner',
    build(ctx) {
      const b = bounds(merged(ctx.world));
      // 3D Builder starts with the plane through the centre of the selection; its value box shows the
      // distance from that centre ("0 mm").
      const z0 = (b.min[2] + b.max[2]) / 2;
      set(ctx, 'z', z0);
      set(ctx, 'keep', splitKeep); // the last choice, kept even after Annuler (3D Builder)
      set(ctx, 'tiltX', 0);
      set(ctx, 'tiltY', 0);
      const plane = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ color: 0x7fd36b, transparent: true, opacity: 0.45, side: DoubleSide, depthWrite: false }));
      const half = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 0.65 + 5;
      const draw = () => {
        const { normal, point } = splitPlane(ctx, b);
        // Quad in the plane: two in-plane axes built from the normal.
        const ref = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        const u = normalize(cross3(ref, normal)), v = cross3(normal, u);
        const corner = (su: number, sv: number) => [0, 1, 2].map((k) => point[k] + (u[k] * su + v[k] * sv) * half);
        const [p00, p10, p11, p01] = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
        plane.geometry.setAttribute('position', new Float32BufferAttribute([...p00, ...p10, ...p11, ...p00, ...p11, ...p01], 3));
        plane.geometry.attributes.position.needsUpdate = true;
        plane.geometry.computeBoundingSphere();
        ctx.app.view.invalidate();
      };
      draw();
      ctx.app.view.addOverlay(plane);
      set(ctx, 'tiltZ', 0);
      const setZ = (z: number) => { set(ctx, 'z', z); draw(); };
      const keepBtns: HTMLButtonElement[] = [];
      const keep = (id: string, label: string) => {
        const btn = toggle(label, 'split', id === splitKeep, () => {
          set(ctx, 'keep', id);
          splitKeep = id;
          keepBtns.forEach((x) => x.classList.toggle('on', x === btn));
        });
        keepBtns.push(btn);
        return btn;
      };
      // 3D Builder moves and turns the plane in the scene (arrow and rings), with Mouvement /
      // Rotation in the bar at the bottom: the distance from the centre in mm, or the Roulis,
      // Tangage and Lacet angles.
      const view = ctx.app.view;
      const pivot = new Object3D();
      pivot.rotation.order = 'ZYX'; // n = Rz · Ry · Rx · z, as splitPlane
      view.addOverlay(pivot);
      const tc = new TransformControls(view.camera, view.renderer.domElement);
      tc.setSize(0.9);
      view.addOverlay(tc.getHelper());
      tc.attach(pivot);
      const rad = (k: string) => (st(ctx, k, 0) * Math.PI) / 180;
      const syncPivot = () => {
        pivot.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, st(ctx, 'z', z0));
        pivot.rotation.set(rad('tiltX'), rad('tiltY'), rad('tiltZ'));
        pivot.updateMatrixWorld();
        view.invalidate();
      };
      let tmode: 'translate' | 'rotate' = 'translate';
      const bottom = floatingBar(ctx);
      // Annuler / Refaire of the plane's moves (3D Builder has them in this tool).
      type PlaneState = { z: number; tiltX: number; tiltY: number; tiltZ: number };
      const snap = (): PlaneState => ({ z: st(ctx, 'z', z0), tiltX: st(ctx, 'tiltX', 0), tiltY: st(ctx, 'tiltY', 0), tiltZ: st(ctx, 'tiltZ', 0) });
      const past: PlaneState[] = [], future: PlaneState[] = [];
      let prev = snap();
      const record = () => { const now = snap(); if (JSON.stringify(now) === JSON.stringify(prev)) return; past.push(prev); future.length = 0; prev = now; };
      const renderBottom = () => {
        const angle = (k: string, name: string) => barValue('', name, st(ctx, k, 0), (v) => { set(ctx, k, Math.max(-89, Math.min(89, v))); record(); draw(); syncPivot(); renderBottom(); });
        bottom.replaceChildren(
          barTool(tmode === 'translate', 'move', 'Mouvement', () => setTool('translate')),
          barTool(tmode === 'rotate', 'rotate', 'Rotation', () => setTool('rotate')),
          ...(tmode === 'translate'
            ? [barValue('', '', st(ctx, 'z', z0) - z0, (v) => { setZ(z0 + v); record(); syncPivot(); renderBottom(); }), h('span', { class: 'unit' }, 'mm')]
            : [angle('tiltX', 'Roulis'), angle('tiltY', 'Tangage'), angle('tiltZ', 'Lacet'), h('span', { class: 'unit' }, 'deg')]),
        );
      };
      const setTool = (mode: 'translate' | 'rotate') => {
        tmode = mode;
        tc.setMode(mode);
        tc.showX = tc.showY = mode === 'rotate';
        tc.showZ = true;
        renderBottom();
      };
      const restore = (from: PlaneState[], to: PlaneState[]) => {
        const p = from.pop();
        if (!p) return;
        to.push(snap());
        for (const [k, v] of Object.entries(p)) set(ctx, k, v);
        prev = snap();
        draw(); syncPivot(); renderBottom();
      };
      ctx.history = { undo: () => restore(past, future), redo: () => restore(future, past) };
      tc.addEventListener('dragging-changed', (e) => {
        const dragging = (e as unknown as { value: boolean }).value;
        view.orbit.enabled = !dragging;
        if (!dragging) record();
      });
      tc.addEventListener('objectChange', () => {
        if (tc.mode === 'translate') setZ(Math.max(b.min[2] - 1, Math.min(b.max[2] + 1, pivot.position.z)));
        else {
          const deg = (v: number) => Math.max(-89, Math.min(89, Math.round((v * 180) / Math.PI)));
          set(ctx, 'tiltX', deg(pivot.rotation.x));
          set(ctx, 'tiltY', deg(pivot.rotation.y));
          set(ctx, 'tiltZ', deg(pivot.rotation.z));
          draw();
        }
        syncPivot();
        if (!bottom.contains(document.activeElement)) renderBottom();
      });
      // Clicks in the scene go to the manipulator, not to the selection.
      view.clickTool = { click() {}, hover() {} };
      syncPivot();
      setTool('translate');
      ctx.bar.append(keep('top', 'Conserver le haut'), keep('bottom', 'Conserver le bas'), keep('both', 'Conserver les deux'));
      return () => {
        bottom.remove();
        tc.detach();
        tc.dispose();
        view.clickTool = null;
        view.orbit.enabled = true;
      };
    },
    async apply(ctx) {
      const keep = st(ctx, 'keep', 'top');
      const { normal, point } = splitPlane(ctx, bounds(merged(ctx.world)));
      const results: MeshData[][] = [];
      const colors: (Uint32Array | undefined)[][] = [];
      for (const [i, w] of ctx.world.entries()) {
        // As in 3D Builder: direct cut and caps, each kept half separated into its connected
        // pieces (one object each), left where they are.
        const { above, below } = await csg.splitPlane(w, normal, point, ctx.selection[i].faceColors);
        const kept = keep === 'top' ? above : keep === 'bottom' ? below : [...above, ...below];
        results.push(kept.map((p) => p.mesh));
        colors.push(kept.map((p) => p.faceColors));
      }
      if (results.every((r) => !r.length)) throw new Error('Le plan ne coupe pas l’objet.');
      ctx.app.replaceObjects(ctx.selection, results, { faceColors: colors });
      return true;
    },
  },

  smooth: {
    okLabel: 'Lisse',
    build(ctx) {
      set(ctx, 'level', 3);
      set(ctx, 'edges', false);
      const run = previewer(ctx, async () => {
        const edges = st(ctx, 'edges', false);
        // Passes of HC smoothing, or of Loop subdivision with "Bords lisses" (×4 faces each).
        const m = smoothTool(ctx.world[0], smoothPasses(ctx, edges), edges);
        set(ctx, 'result', m);
        return [{ mesh: m, color: ctx.selection[0].color }];
      });
      ctx.bar.append(
        slider('Définir le niveau de lissage', 0, 6, 1, 3, // 3D Builder: SmoothRange 0–6, 3 by default
         (v) => set(ctx, 'level', v), () => run(0)),
        h('span', { class: 'vsep' }),
        switchToggle('Bords lisses', false, (on) => { set(ctx, 'edges', on); run(0); }),
      );
      run(0);
    },
    async apply(ctx) {
      const edges = st(ctx, 'edges', false);
      const m = st<MeshData | null>(ctx, 'result', null) ?? smoothTool(ctx.world[0], smoothPasses(ctx, edges), edges);
      ctx.app.replaceObjects(ctx.selection, [[m]]);
      return true;
    },
  },

  extrudeDown: {
    okLabel: 'Extruder vers le bas',
    build(ctx) {
      // Height limit H (absolute Z): what lies below it is extended to the plate. 3D Builder starts
      // with H at the bottom of the selection, shown as a green plane, and the user raises it.
      const top = Math.max(...ctx.world.map((w) => bounds(w).max[2]));
      const all = bounds(merged(ctx.world));
      // Start: the plane through the centre of the selection, as 3D Builder (its value box shows the
      // distance from that centre, 0 mm at the start).
      const start = Math.max(0, (all.min[2] + all.max[2]) / 2);
      set(ctx, 'limit', start);
      const plane = (z: number): MeshData => {
        const m = 0.15 * Math.max(all.max[0] - all.min[0], all.max[1] - all.min[1]) + 5;
        const x0 = all.min[0] - m, x1 = all.max[0] + m, y0 = all.min[1] - m, y1 = all.max[1] + m;
        return { positions: new Float32Array([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
      };
      const run = previewer(ctx, async () => {
        const out: { mesh: MeshData; color: string; opacity?: number; faceColors?: Uint32Array }[] = [];
        for (const [i, w] of ctx.world.entries()) {
          const r = await csg.extrudeDown(w, st(ctx, 'limit', start), ctx.selection[i].faceColors);
          out.push({ mesh: r.mesh, faceColors: r.faceColors, color: ctx.selection[i].color });
        }
        out.push({ mesh: plane(st(ctx, 'limit', start)), color: '#5fd35a', opacity: 0.45 });
        return out;
      });
      // As 3D Builder: nothing in the top bar but Annuler / Refaire; the bar at the bottom shows the
      // plane's distance from the centre of the selection (0 mm at the start), which can be typed.
      const bottom = floatingBar(ctx);
      const renderBottom = () => bottom.replaceChildren(
        barValue('', '', st(ctx, 'limit', start) - start, (v) => { setLimit(Math.max(0, Math.min(top, start + v))); pivot.position.z = st(ctx, 'limit', start); record(); }),
        h('span', { class: 'unit' }, 'mm'));
      const setLimit = (v: number) => { set(ctx, 'limit', v); if (!bottom.contains(document.activeElement)) renderBottom(); run(150); };
      const past: number[] = [], future: number[] = [];
      let prev = start;
      const record = () => { const now = st(ctx, 'limit', start); if (now === prev) return; past.push(prev); future.length = 0; prev = now; };
      const restore = (from: number[], to: number[]) => {
        const v = from.pop();
        if (v === undefined) return;
        to.push(st(ctx, 'limit', start));
        prev = v;
        pivot.position.z = v;
        setLimit(v);
        renderBottom();
      };
      ctx.history = { undo: () => restore(past, future), redo: () => restore(future, past) };
      // The green plane can be dragged up and down in the scene, as in 3D Builder.
      const view = ctx.app.view;
      const pivot = new Object3D();
      pivot.position.set((all.min[0] + all.max[0]) / 2, (all.min[1] + all.max[1]) / 2, start);
      const tc = new TransformControls(view.camera, view.renderer.domElement);
      tc.setSize(0.9);
      tc.showX = tc.showY = false;
      view.scene.add(pivot, tc.getHelper());
      tc.attach(pivot);
      tc.addEventListener('dragging-changed', (e) => {
        const dragging = (e as unknown as { value: boolean }).value;
        view.orbit.enabled = !dragging;
        if (!dragging) record();
      });
      tc.addEventListener('objectChange', () => {
        pivot.position.z = Math.max(0, Math.min(top, pivot.position.z));
        setLimit(pivot.position.z);
      });
      view.clickTool = { click() {}, hover() {} };
      renderBottom();
      run(0);
      return () => {
        bottom.remove();
        tc.detach();
        view.scene.remove(pivot, tc.getHelper());
        tc.dispose();
        view.clickTool = null;
        view.orbit.enabled = true;
      };
    },
    async apply(ctx) {
      const results: MeshData[][] = [];
      const colors: (Uint32Array | undefined)[][] = [];
      for (const [i, w] of ctx.world.entries()) {
        const r = await csg.extrudeDown(w, st(ctx, 'limit', Infinity), ctx.selection[i].faceColors, true);
        results.push([r.mesh]);
        colors.push([r.faceColors]);
      }
      ctx.app.replaceObjects(ctx.selection, results, { faceColors: colors });
      return true;
    },
  },

  hollow: {
    okLabel: 'Creux',
    build(ctx) {
      // 3D Builder: 1 mm by default, slider from 0.1 to 10 mm; the last thickness is kept for the
      // next use, even after Annuler (observed 19/11/2026).
      set(ctx, 't', hollowThickness);
      const val = h('span', {}, `${hollowThickness.toFixed(1)} mm`);
      const run = previewer(ctx, async () => {
        const m = await csg.hollow(ctx.world[0], st(ctx, 't', 1));
        set(ctx, 'result', m);
        // 3D Builder shows the hollowed object translucent blue, the cavity visible inside.
        return [{ mesh: m, color: '#6fa8f0', opacity: 0.5 }];
      });
      ctx.bar.append(
        slider('Épaisseur minimale de mur', 0.1, 10, 0.1, hollowThickness, (v) => { hollowThickness = v; set(ctx, 't', v); set(ctx, 'result', null); val.textContent = `${v.toFixed(1)} mm`; }, () => run(0)),
        val,
      );
      run(0);
    },
    async apply(ctx) {
      const m = st<MeshData | null>(ctx, 'result', null) ?? (await csg.hollow(ctx.world[0], st(ctx, 't', 1)));
      ctx.app.replaceObjects(ctx.selection, [[m]]);
      return true;
    },
  },

  emboss: {
    okLabel: 'Relief',
    build(ctx) {
      const b = bounds(ctx.world[0]);
      const L = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      const s = {
        motif: { kind: 'text', text: 'abc', font: 'Segoe UI', bold: true } as Motif,
        direction: '-y' as Direction,
        projection: 'planar' as Projection,
        // Size = the text's em size. 3D Builder (read live): em = 0.1 × the object's largest dimension
        // (text size 0.2, em = 0.5 × size), and the motif box is the glyphs' ink extent × that
        // dimension: "abc" in Segoe UI Bold is 1.5742 em wide, 6.30 mm on a 40 mm cube.
        size: Math.max(0.1, Math.round(L * 0.1 * 1000) / 1000),
        // 3D Builder: flat depth 0.015 × the object's largest dimension (0.6 mm on a 40 mm cube).
        depth: Math.round(0.015 * L * 1000) / 1000,
        offsetU: 0,
        offsetV: 0,
        rotation: 0,
        bevel: true, // 3D Builder opens the Relief with Biseau on
        bevelPct: 50, // 3D Builder: the Biseau height is a percentage of the roof's top
        top: null as string | null,
        side: null as string | null,
        scaleY: 1,
      };
      // 3D Builder keeps the Relief settings from one use to the next (even after Annuler).
      if (lastEmboss) Object.assign(s, lastEmboss);
      set(ctx, 'emboss', s);
      const run = previewer(ctx, async () => {
        const r = await runEmboss(ctx, s);
        set(ctx, 'result', r);
        refreshBottom();
        return [{ mesh: r.mesh, color: ctx.selection[0].color, faceColors: r.faceColors }];
      });
      let recordChange = () => {};
      let refreshBottom = () => {};
      const changed = () => { recordChange(); set(ctx, 'result', null); run(300); };
      // --- top bar, as 3D Builder's: Motif ▾, Projection, Biseau, Couleur Haut ▾ / Côté ▾ | Texte, Police
      /** Popup menu under `anchor`, closed by a click outside or Échap. */
      const popup = (anchor: HTMLElement, content: (close: () => void) => HTMLElement[]) => {
        const rect = anchor.getBoundingClientRect();
        const menu = h('div', { class: 'color-menu', style: `position:fixed;left:${rect.left}px;top:${rect.bottom + 2}px;z-index:50;background:#2b2b2b;color:#fff;min-width:230px;box-shadow:0 6px 24px rgba(0,0,0,.5)` });
        const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc, true); };
        const outside = (e: Event) => { if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
        const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
        menu.append(...content(close));
        document.body.append(menu);
        setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc, true); });
        return close;
      };
      const row = (text: string, ico: string | null, run: () => void) =>
        h('button', { style: 'display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:10px 12px', onclick: run, html: `${ico ? icon(ico, 22) : ''}<span>${text}</span>` });
      const header = (text: string) => h('div', { style: 'padding:8px 12px;font-size:12px;opacity:.75;background:#1f1f1f' }, text);
      const motifIcon = h('span', { style: 'display:grid;place-items:center;width:26px;height:26px' });
      const showMotifIcon = () => {
        if (s.motif.kind === 'text') { motifIcon.innerHTML = icon('text', 22); return; }
        motifIcon.innerHTML = icon(s.motif.kind === 'image' ? 'image' : 'emboss', 22);
        if (s.motif.kind === 'shape') void shapePixels(s.motif.shape!, true).then((px) => { if (px && s.motif.kind === 'shape') { const t = pixelsThumb(px, 24); t.style.filter = 'invert(1)'; motifIcon.replaceChildren(t); } });
      };
      const setMotif = (m: Motif) => { s.motif = m; showMotifIcon(); textGroup.style.display = m.kind === 'text' ? 'contents' : 'none'; changed(); };
      const motifBtn: HTMLButtonElement = h('button', {
        class: 'color-btn', title: 'Motif', 'aria-label': 'Motif', style: 'display:flex;align-items:center;gap:4px;padding:6px',
        onclick: () => popup(motifBtn, (close) => {
          const grid = h('div', { style: 'display:grid;grid-template-columns:repeat(6,46px);gap:4px;padding:8px' });
          for (const sh of SHAPES) {
            const cell = h('button', { title: sh.label, 'aria-label': sh.label, style: 'width:46px;height:46px;display:grid;place-items:center', onclick: () => { close(); setMotif({ kind: 'shape', shape: sh.id }); } });
            grid.append(cell);
            void shapePixels(sh.id, true).then((px) => { if (px) { const t = pixelsThumb(px, 38); t.style.filter = 'invert(1)'; cell.append(t); } });
          }
          return [
            row('Texte', 'text', () => { close(); setMotif({ kind: 'text', text: textIn.value, font: fontSel.value, bold: true }); }),
            row('Charger', 'image', () => {
              close();
              void pickFiles('image/*', false).then(async ([file]) => { if (file) setMotif({ kind: 'image', image: await createImageBitmap(file) }); });
            }),
            header('Formes'),
            grid,
          ];
        }),
      }, motifIcon, h('span', { html: icon('chevronDown', 14) }));
      const textIn = h('input', { type: 'text', value: 'abc', 'aria-label': 'Texte', style: 'width:140px' });
      textIn.addEventListener('input', () => { s.motif = { ...s.motif, kind: 'text', text: textIn.value }; changed(); });
      textIn.addEventListener('keydown', (e) => e.stopPropagation());
      // Police: the installed fonts as in 3D Builder. « Fichier de police… » (not in 3D Builder) only
      // shows when the browser cannot read the installed fonts.
      const fileOption = () => (canReadSystemFonts() ? [] : [h('option', { value: ':file' }, 'Fichier de police…')]);
      const fontOption = (f: string) => h('option', { value: f, style: `font-family:"${f}"` }, f);
      const fontSel = h('select', { 'aria-label': 'Police', style: 'width:140px' },
        ...['Segoe UI', 'Calibri', 'Arial', 'Verdana', 'Georgia', 'Times New Roman', 'Courier New', 'Impact', 'Comic Sans MS', 'Trebuchet MS'].map(fontOption),
        ...fileOption()) as HTMLSelectElement;
      let lastFont = 'Segoe UI';
      fontSel.addEventListener('change', async () => {
        if (fontSel.value === ':file') {
          fontSel.value = lastFont; // the choice can be made again
          // A TrueType file (.ttf / .ttc) gives the exact glyph outlines in any browser.
          const [file] = await pickFiles('.ttf,.ttc,font/ttf,font/collection', false);
          if (!file) return;
          const name = file.name.replace(/\.[^.]+$/, '');
          try {
            registerFontFile(name, await file.arrayBuffer());
          } catch (e) {
            ctx.app.toast(`Police illisible : ${(e as Error).message}`, 'warn');
            return;
          }
          if (![...fontSel.options].some((o) => o.value === name)) fontSel.insertBefore(fontOption(name), fontSel.querySelector('option[value=":file"]'));
          fontSel.value = name;
        }
        lastFont = fontSel.value;
        fontSel.style.fontFamily = `"${lastFont}"`;
        s.motif = { ...s.motif, font: fontSel.value };
        changed();
      });
      // As 3D Builder, the list shows the installed fonts once the browser grants access to them
      // (asked on the first click, which also lets the glyph outlines be read).
      let fontsListed = false;
      fontSel.addEventListener('pointerdown', async () => {
        if (fontsListed || !canReadSystemFonts()) return;
        fontsListed = true;
        const families = await systemFontFamilies();
        if (!families?.length) { fontsListed = false; return; }
        const current = fontSel.value;
        const opened = [...fontSel.options].filter((o) => o.value !== ':file' && !families.includes(o.value)).map((o) => o.value);
        fontSel.replaceChildren(...[...families, ...opened].map(fontOption), ...fileOption());
        fontSel.value = families.includes(current) ? current : families[0];
        if (fontSel.value !== current) { s.motif = { ...s.motif, font: fontSel.value }; changed(); }
      });
      const textGroup = h('span', { style: 'display:contents' }, h('label', {}, 'Texte', textIn), h('label', {}, 'Police', fontSel));
      const projSel = h('select', { 'aria-label': 'Projection', style: 'width:140px' }, ...PROJECTIONS.map((x) => h('option', { value: x.id }, x.label))) as HTMLSelectElement;
      projSel.addEventListener('change', () => { s.projection = projSel.value as Projection; clampDepth(); changed(); renderBottom(); });
      const bevelBtn = toggle('Biseau', 'bevel', false, (btn) => {
        s.bevel = !s.bevel;
        btn.classList.toggle('on', s.bevel);
        changed();
        renderBottom();
      });
      // Couleur: Haut (top) and Côté (sides), each « Utiliser une couleur d'arrière-plan » (the
      // object's own colour) by default, or a colour.
      const colourChoice = (label: string, glyph: string, key: 'top' | 'side') => {
        const under = h('span', { style: 'position:absolute;left:6px;right:6px;bottom:2px;height:3px' });
        const more = h('input', { type: 'color', style: 'position:absolute;opacity:0;width:0;height:0', 'aria-hidden': 'true' }) as HTMLInputElement;
        const show = () => { under.style.background = s[key] ?? 'transparent'; under.style.outline = s[key] ? '' : '1px solid rgba(255,255,255,.35)'; };
        const choose = (c: string | null) => { s[key] = c; if (c) rememberColor(c); show(); changed(); };
        more.addEventListener('change', () => choose(more.value));
        const btn: HTMLButtonElement = h('button', {
          class: 'color-btn', title: label, 'aria-label': label, style: 'position:relative;display:flex;align-items:center;gap:3px;padding:6px 5px',
          onclick: () => popup(btn, (close) => [
            row('Plus de couleurs…', null, () => { close(); more.value = s[key] ?? '#ffffff'; more.click(); }),
            row('Utiliser une couleur d’arrière-plan', null, () => { close(); choose(null); }),
            header('Couleurs standard'),
            h('div', { style: 'padding:6px 8px 8px;display:grid;grid-template-columns:repeat(6,34px)' },
              ...STANDARD_COLORS.map((c) => h('button', { title: c, style: `width:26px;height:26px;margin:4px;background:${c};border:1px solid rgba(255,255,255,.4)`, onclick: () => { close(); choose(c); } }))),
          ]),
        }, h('span', { style: 'font-size:18px' }, glyph), h('span', {}, label), h('span', { html: icon('chevronDown', 14) }), under, more);
        show();
        return { btn, show };
      };
      const topColour = colourChoice('Haut', '★', 'top');
      const sideColour = colourChoice('Côté', '☆', 'side');
      ctx.bar.append(
        h('label', {}, 'Motif', motifBtn),
        h('label', {}, 'Projection', projSel),
        bevelBtn,
        h('span', { style: 'display:flex;align-items:center;gap:2px' }, h('span', {}, 'Couleur'), topColour.btn, sideColour.btn),
        h('span', { class: 'vsep' }),
        textGroup,
      );

      // --- bottom bar, as 3D Builder's: Mouvement / Rotation / Échelle with their values.
      // Échelle: X and Y = motif size in % (3D Builder: 20 % = an em of 0.1 × the object's largest
      // dimension), Z = the Biseau height in % (negative engraves); without Biseau, sizes and depth
      // in mm (negative depth engraves). Rotation: the motif's angle. Mouvement: the motif is moved
      // with the mouse on the object; the value is the projection distance (the object's bounding
      // radius, 34.64 mm on a 40 mm cube as in 3D Builder; not editable).
      const view = ctx.app.view;
      const bottom = h('div', { class: 'tbar' });
      (view as unknown as { host: HTMLElement }).host.append(bottom);
      let tmode: 'move' | 'rotate' | 'scale' = 'scale';
      let lock = true;
      const xPct = () => (s.size / (0.5 * L)) * 100;
      const clampDepth = () => {
        const ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
        const m = s.projection !== 'planar' ? Math.max(ext[0], ext[1]) / 2 : s.direction === '+z' ? ext[2] : s.direction.endsWith('x') ? ext[0] : ext[1];
        // As 3D Builder: the depth goes from 0 to the object's thickness (an engraving can go through).
        if (Math.abs(s.depth) > m) s.depth = Math.sign(s.depth) * m;
      };
      const fmt = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',');
      const val = (axis: string, name: string, value: number, set: (v: number) => void, readOnly = false) => {
        const input = h('input', { type: 'text', inputmode: 'decimal', value: fmt(value), 'aria-label': name, readonly: readOnly });
        input.addEventListener('change', () => { const v = parseFloat(input.value.replace(',', '.')); if (Number.isFinite(v)) set(v); renderBottom(); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); e.stopPropagation(); });
        return h('label', { class: `val ${axis}` }, h('small', {}, name), input);
      };
      const renderBottom = () => {
        const tool = (m: typeof tmode, ico: string, label: string) =>
          h('button', { class: `tool${tmode === m ? ' on' : ''}`, title: label, 'aria-label': label, html: icon(ico, 22), onclick: () => { tmode = m; renderBottom(); } });
        const items: HTMLElement[] = [tool('move', 'move', 'Mouvement'), tool('rotate', 'rotate', 'Rotation'), tool('scale', 'scale', 'Mise à l’échelle')];
        if (tmode === 'move') {
          items.push(val('', 'Distance', Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2, () => {}, true), h('span', { class: 'unit' }, 'mm'));
        } else if (tmode === 'rotate') {
          items.push(val('', 'Rotation', s.rotation, (v) => { s.rotation = v; changed(); }), h('span', { class: 'unit' }, 'deg'));
        } else {
          const mm = !s.bevel;
          const w = lastMotifSize[0] * s.size, hh = lastMotifSize[1] * s.size * s.scaleY;
          const setX = (v: number) => {
            const px = mm ? (v / (lastMotifSize[0] * s.size || 1)) * xPct() : v;
            const ratio = px / (xPct() || 1);
            s.size = Math.max(0.05, (Math.max(0.01, px) / 100) * 0.5 * L);
            if (!lock) s.scaleY = s.scaleY / ratio;
            changed();
          };
          const setY = (v: number) => {
            const py = mm ? (v / (lastMotifSize[1] * s.size || 1)) * xPct() * s.scaleY : v;
            if (lock) { s.size = Math.max(0.05, (Math.max(0.01, py / s.scaleY) / 100) * 0.5 * L); } else s.scaleY = Math.max(0.01, py / (xPct() || 1));
            changed();
          };
          items.push(
            val('x', 'X', mm ? w : xPct(), setX),
            val('y', 'Y', mm ? hh : xPct() * s.scaleY, setY),
            val('z', 'Z', mm ? s.depth : s.bevelPct, (v) => { if (mm) { s.depth = v; clampDepth(); } else s.bevelPct = Math.max(-100, Math.min(100, v)); changed(); }),
            h('span', { class: 'unit' }, mm ? 'mm' : '%'),
            h('button', { class: `tool${lock ? ' on' : ''}`, title: 'Verrouiller les proportions', 'aria-label': 'Verrouiller les proportions', html: icon(lock ? 'lock' : 'unlock', 20), onclick: () => { lock = !lock; renderBottom(); } }),
          );
        }
        bottom.replaceChildren(...items);
      };
      clampDepth();
      run(0);
      // 3D Builder: Z / X / C choose the planar / cylindrical / spherical projection.
      const onKey = (e: KeyboardEvent) => {
        const t = e.target as HTMLElement;
        if (e.ctrlKey || e.metaKey || e.altKey || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
        const id = ({ z: 'planar', x: 'cylindrical', c: 'spherical' } as Record<string, string>)[e.key.toLowerCase()];
        if (!id || projSel.value === id) return;
        projSel.value = id;
        projSel.dispatchEvent(new Event('change'));
      };
      window.addEventListener('keydown', onKey);
      // The motif is placed with the mouse, as in 3D Builder: a click on the object puts it there (on
      // the side the clicked face looks at), and dragging moves it on that side.
      const wb = bounds(ctx.world[0]);
      const centre = new Vector3((wb.min[0] + wb.max[0]) / 2, (wb.min[1] + wb.max[1]) / 2, (wb.min[2] + wb.max[2]) / 2);
      let grab: { p0: Vector3; u0: number; v0: number } | null = null;
      const onPlane = (ev: PointerEvent) => {
        const { d } = frameOf(s.direction);
        const ray = view.rayAt(ev);
        const n = new Vector3(...d);
        const den = ray.direction.dot(n);
        if (Math.abs(den) < 1e-6) return null;
        // Plane of the object's face on the projection side.
        const half = Math.abs((wb.max[0] - wb.min[0]) * d[0] + (wb.max[1] - wb.min[1]) * d[1] + (wb.max[2] - wb.min[2]) * d[2]) / 2;
        const face = centre.clone().addScaledVector(n, half);
        const t = face.sub(ray.origin).dot(n) / den;
        return ray.origin.clone().addScaledVector(ray.direction, t);
      };
      const sideOf = (n: number[]): Direction | null => {
        const a = n.map(Math.abs);
        const k = a.indexOf(Math.max(...a));
        if (k === 2) return n[2] > 0 ? '+z' : null; // no motif under the object
        return k === 0 ? (n[0] > 0 ? '+x' : '-x') : (n[1] > 0 ? '+y' : '-y');
      };
      view.toolPointer = {
        down(ev) {
          // The preview is the whole object: a press on the motif drags it, a press elsewhere on the
          // object puts the motif there.
          const hit = view.hitOverlay(ev);
          if (!hit) return false;
          const side = sideOf(hit.normal);
          const f = frameOf(s.direction);
          const q = new Vector3(...hit.point).sub(centre);
          const du = q.dot(new Vector3(...f.u)) - s.offsetU, dv = q.dot(new Vector3(...f.v)) - s.offsetV;
          const onMotif = side === s.direction && Math.abs(du) <= (lastMotifSize[0] * s.size) / 2 + 1 && Math.abs(dv) <= (lastMotifSize[1] * s.size * s.scaleY) / 2 + 1;
          if (!onMotif) {
            if (!side) return false;
            if (side !== s.direction) { s.direction = side; clampDepth(); }
            const { u, v } = frameOf(s.direction);
            s.offsetU = Math.round(q.dot(new Vector3(...u)) * 10) / 10;
            s.offsetV = Math.round(q.dot(new Vector3(...v)) * 10) / 10;
            changed();
          }
          const p = onPlane(ev);
          if (!p) return false;
          grab = { p0: p, u0: s.offsetU, v0: s.offsetV };
          return true;
        },
        move(ev) {
          if (!grab) return;
          const p = onPlane(ev);
          if (!p) return;
          const { u, v } = frameOf(s.direction);
          const dp = p.sub(grab.p0);
          s.offsetU = Math.round((grab.u0 + dp.dot(new Vector3(...u))) * 10) / 10;
          s.offsetV = Math.round((grab.v0 + dp.dot(new Vector3(...v))) * 10) / 10;
          changed();
        },
        up() { grab = null; },
      };
      // Controls showing the settings (restored from the last use, or after Annuler / Refaire).
      const sync = () => {
        projSel.value = s.projection;
        if (s.motif.kind === 'text') {
          textIn.value = s.motif.text ?? 'abc';
          if ([...fontSel.options].some((o) => o.value === s.motif.font)) { fontSel.value = s.motif.font!; lastFont = fontSel.value; fontSel.style.fontFamily = `"${lastFont}"`; }
        }
        showMotifIcon();
        textGroup.style.display = s.motif.kind === 'text' ? 'contents' : 'none';
        bevelBtn.classList.toggle('on', s.bevel);
        topColour.show();
        sideColour.show();
        renderBottom();
      };
      sync();
      refreshBottom = () => { if (!bottom.contains(document.activeElement)) renderBottom(); };
      // Annuler / Refaire inside the Relief (3D Builder has them, with Ctrl+Z / Ctrl+Y): one step
      // per change, changes less than 0.7 s apart counting as one.
      type Snap = EmbossState;
      const copy = (): Snap => ({ ...s, motif: { ...s.motif } });
      const past: Snap[] = [], future: Snap[] = [];
      let prev = copy(), last = 0, restoring = false;
      const record = () => {
        if (restoring) return;
        const now = performance.now();
        if (now - last > 700) { past.push(prev); future.length = 0; }
        last = now;
        prev = copy();
      };
      const back = (from: Snap[], to: Snap[]) => {
        const st0 = from.pop();
        if (!st0) return;
        to.push(copy());
        restoring = true;
        Object.assign(s, st0, { motif: { ...st0.motif } });
        prev = copy();
        last = 0;
        sync();
        changed();
        restoring = false;
      };
      ctx.history = { undo: () => back(past, future), redo: () => back(future, past) };
      recordChange = record;
      return () => {
        view.toolPointer = null;
        bottom.remove();
        window.removeEventListener('keydown', onKey);
        const keep = s.motif.kind === 'image' ? {} : { motif: s.motif };
        lastEmboss = { ...keep, direction: s.direction, projection: s.projection, depth: s.depth, bevel: s.bevel, bevelPct: s.bevelPct };
      };
    },
    async apply(ctx) {
      const s = st<EmbossState | null>(ctx, 'emboss', null)!;
      const r = st<EmbossResult | null>(ctx, 'result', null) ?? (await runEmboss(ctx, s));
      ctx.app.replaceObjects(ctx.selection, [[r.mesh]], { faceColors: [[r.faceColors]] });
      return true;
    },
  },

  measure: {
    okLabel: 'Fermer',
    noOk: true, // 3D Builder's Mesure bar only has Annuler
    build(ctx) {
      // As 3D Builder's Measure (CMeasureTool): first click puts point A (blue), then a line follows the
      // cursor to a green marker with the distance updated live; the second click fixes B, a third
      // starts a new measurement, a click on nothing (not even the floor) or Échap resets. Points
      // lie on objects or on the floor. "Ancrage" (on, not saved) snaps to the corner or edge of the
      // triangle under the cursor; Shift inverts it. Straight 3D distance, rounded to the hundredth.
      const view = ctx.app.view;
      const pts: V3[] = [];
      let hover: V3 | null = null;
      let snapping = true;
      const dist = h('span', {}, '0,00');
      const unitLabel = h('span', {}, ctx.app.unit().short);
      const marker = (q: number[], r: number): MeshData => {
        const s = makePrimitive('sphere');
        const k = r / 20;
        return { positions: s.positions.map((v, i) => v * k + q[i % 3]), indices: s.indices };
      };
      const segment = (a: number[], b: number[], r: number): MeshData => {
        // Thin square prism from a to b.
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const l = Math.hypot(d[0], d[1], d[2]) || 1;
        const n = d.map((x) => x / l);
        const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        const u = cross3(n, ref), ul = Math.hypot(...u) || 1;
        const uu = u.map((x) => (x / ul) * r), vv = cross3(n, uu);
        const pos: number[] = [];
        for (const e of [a, b]) for (const [su, sv] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) pos.push(...[0, 1, 2].map((k) => e[k] + su * uu[k] + sv * vv[k]));
        const idx: number[] = [];
        for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; idx.push(i, j, 4 + j, i, 4 + j, 4 + i); }
        idx.push(0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7);
        return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
      };
      const span = Math.max(...ctx.app.doc.objects.map((o) => { const b = bounds(worldMesh(o)); return Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]); }), 10);
      const draw = () => {
        const r = span * 0.015;
        const parts: { mesh: MeshData; color: string; onTop: boolean }[] = [];
        if (pts[0]) parts.push({ mesh: marker(pts[0], r), color: '#2f8fff', onTop: true });
        const end = pts[1] ?? hover;
        if (end) parts.push({ mesh: marker(end, r), color: '#3ad15a', onTop: true });
        if (pts[0] && end) parts.push({ mesh: segment(pts[0], end, r * 0.3), color: '#f08080', onTop: true });
        view.showPreview(parts);
        const u = ctx.app.unit();
        const d = pts[0] && end ? Math.hypot(end[0] - pts[0][0], end[1] - pts[0][1], end[2] - pts[0][2]) / u.mm : 0;
        dist.textContent = (Math.round(d * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        unitLabel.textContent = u.short;
      };
      const pointAt = (ev: PointerEvent): V3 | null => {
        const hit = view.hitAt(ev);
        if (!hit) return null;
        if (snapping === ev.shiftKey) return hit.point;
        return hit.tri ? snapOnTriangle(hit.point, hit.tri).point : snapOnFloor(hit.point).point;
      };
      view.clickTool = {
        hover(ev) {
          if (pts.length !== 1) return;
          hover = ev ? pointAt(ev) : null;
          draw();
        },
        click(ev) {
          const p = pointAt(ev);
          if (!p) { pts.length = 0; hover = null; draw(); return; }
          if (pts.length === 2) pts.length = 0;
          pts.push(p);
          hover = null;
          draw();
        },
      };
      // Pressing on a marker grabs it (the nearer one within 12 px) and drags it, distance live.
      let grabbed = -1;
      const toScreen = (p: V3) => {
        const r = view.renderer.domElement.getBoundingClientRect();
        const q = new Vector3(...p).project(view.camera);
        return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height];
      };
      view.toolPointer = {
        down(ev) {
          let best = -1, bd = 12;
          pts.forEach((p, i) => { const [x, y] = toScreen(p); const d = Math.hypot(x - ev.clientX, y - ev.clientY); if (d < bd) { bd = d; best = i; } });
          grabbed = best;
          return best >= 0;
        },
        move(ev) {
          if (grabbed < 0) return;
          const p = pointAt(ev);
          if (p) { pts[grabbed] = p; draw(); }
        },
        up() { grabbed = -1; },
      };
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { pts.length = 0; hover = null; draw(); } };
      window.addEventListener('keydown', onKey);
      ctx.bar.append(
        h('div', { class: 'stat', style: 'text-align:left' }, 'Distance ', dist, ' ', unitLabel),
        h('span', { class: 'vsep' }),
        switchToggle('Ancrage', true, (on) => { snapping = on; }),
      );
      draw();
      return () => {
        view.clickTool = null;
        view.toolPointer = null;
        window.removeEventListener('keydown', onKey);
        view.clearOverlay();
      };
    },
    async apply() {
      return true;
    },
  },

  print: {
    okLabel: 'Fermer',
    build(ctx) {
      const s = { angle: 45, wall: 0.25, overhangs: true, thin: true }; // 3D Builder: 0.25 mm without a printer
      const stats = h('div', { class: 'stat', style: 'text-align:left' });
      const run = () => {
        const parts: { mesh: MeshData; color: string; onTop: boolean }[] = [];
        const lines: string[] = [];
        let warnings = 0;
        ctx.world.forEach((w, i) => {
          const r = analyzePrint(w, { overhangAngle: s.angle, minWall: s.wall, bed: ctx.app.bed() });
          const name = ctx.selection[i].name;
          const issues: string[] = [];
          if (r.overhangFaces.length) issues.push(`surplombs ${(r.overhangArea / 100).toFixed(1)} cm²`);
          if (r.thinFaces.length) issues.push(`murs fins (min ${r.minThickness.toFixed(2)} mm)`);
          if (r.floating) issues.push('flotte au-dessus du plateau');
          if (r.narrowBase) issues.push('base étroite');
          if (!r.fitsBed) issues.push('trop grand pour le plateau');
          warnings += issues.length;
          lines.push(`${name} : ${issues.length ? issues.join(', ') : 'prêt à imprimer'}`);
          if (s.overhangs && r.overhangFaces.length) parts.push({ mesh: facesSubset(w, r.overhangFaces), color: '#ff9f1a', onTop: true });
          if (s.thin && r.thinFaces.length) parts.push({ mesh: facesSubset(w, r.thinFaces), color: '#e5383b', onTop: true });
        });
        stats.replaceChildren(...lines.map((l) => h('div', {}, l)));
        ctx.app.view.showPreview(parts);
        set(ctx, 'warnings', warnings);
      };
      const angle = slider('Angle de surplomb', 20, 80, 5, 45, (v) => { s.angle = v; angleVal.textContent = `${v}°`; }, () => run());
      const angleVal = h('span', {}, '45°');
      const wall = h('input', { type: 'number', step: '0.1', min: '0.1', value: '0.25', 'aria-label': 'Épaisseur minimale', style: 'width:70px' });
      wall.addEventListener('change', () => { s.wall = Math.max(0.1, parseFloat(wall.value.replace(',', '.')) || 0.25); run(); });
      wall.addEventListener('keydown', (e) => e.stopPropagation());
      ctx.bar.append(
        angle, angleVal,
        h('label', {}, 'Mur minimal', wall, 'mm'),
        toggle('Surplombs', 'layFlat', true, (b) => { s.overhangs = !s.overhangs; b.classList.toggle('on', s.overhangs); run(); }),
        toggle('Murs fins', 'hollow', true, (b) => { s.thin = !s.thin; b.classList.toggle('on', s.thin); run(); }),
        h('span', { class: 'vsep' }),
        stats,
        h('button', {
          class: 'act', title: 'Agrandit l’objet pour que son mur le plus fin atteigne l’épaisseur minimale (comme 3D Builder)',
          html: `${icon('scale', 22)}<span>Épaissir</span>`,
          onclick: () => thicken(ctx, s.wall),
        }),
      );
      run();
    },
    async apply() {
      return true;
    },
  },

  texture: {
    okLabel: 'Appliquer',
    history: true,
    tip: 'Choisissez une image dans Sélectionné. En Pinceau, cliquez sur une zone de l’objet pour l’en recouvrir ; en Sticker, cliquez à l’endroit où poser l’autocollant.',
    build(ctx) {
      const doc = ctx.app.doc;
      doc.checkpoint();
      const target = ctx.selection[0];
      const span = Math.max(...bounds(ctx.world[0]).max.map((v, k) => v - bounds(ctx.world[0]).min[k]));
      const s = {
        tex: proceduralTexture('checker') as TexturePixels,
        mode: 'brush' as 'sticker' | 'brush', // 3D Builder opens on Pinceau
        size: Math.round(span * 0.6),
        direction: '-y' as Direction,
        offsetU: 0,
        offsetV: 0,
        coverage: 22.5, // 3D Builder's texture-brush default (%)
        wall: { ...WALLPAPER_DEFAULTS },
        rotation: 0, // sticker angle (degrees)
        scaleX: 100, // sticker scale in % (3D Builder's Échelle X / Y)
        scaleY: 100,
      };
      let placeSticker = (_face: number, _point: number[]) => {};
      // Real textures, as 3D Builder: an image and texture coordinates per face (3MF texture2d).
      let base: ObjectTexture | undefined = target.texture;
      const current = () => doc.get(target.id)!;
      const fresh = (): ObjectTexture => {
        const n = current().mesh.indices.length / 3;
        return base ? { images: [...base.images], face: new Int16Array(base.face), uv: new Float32Array(base.uv) } : emptyTexture(n);
      };
      // One texture image per picture (3D Builder appends a new one at every stroke).
      const images = new Map<TexturePixels, { wall: TextureImage; sticker: TextureImage; map: (u: number, v: number) => [number, number] }>();
      const imagesOf = (px: TexturePixels) => {
        let e = images.get(px);
        if (!e) {
          const pad = padImage(px);
          e = { wall: { width: px.width, height: px.height, data: px.data, wrap: 'repeat' }, sticker: { width: pad.width, height: pad.height, data: pad.data, wrap: 'clamp' }, map: pad.map };
          images.set(px, e);
        }
        return e;
      };
      // Sticker: one copy projected from the chosen side, recomputed over the base texture.
      const sticker = (force = false) => {
        if (s.mode !== 'sticker' || !(force || placed)) return;
        const o = current();
        const w = worldMesh(o);
        const b = bounds(w);
        const c = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2);
        const f = frameOf(s.direction);
        const origin = [0, 1, 2].map((k) => c[k] + f.u[k] * s.offsetU + f.v[k] * s.offsetV);
        // Rotation about the projection axis, and the Échelle of the bottom bar.
        const ca = Math.cos((s.rotation * Math.PI) / 180), sa = Math.sin((s.rotation * Math.PI) / 180);
        const u = [0, 1, 2].map((k) => f.u[k] * ca + f.v[k] * sa), v = [0, 1, 2].map((k) => -f.u[k] * sa + f.v[k] * ca);
        const tex = fresh();
        const im = imagesOf(s.tex);
        const r = stickerUV(w, f.d, u, v, origin, (s.size * s.scaleX) / 100, (s.tex.width / s.tex.height) * (s.scaleX / s.scaleY));
        const idx = imageIndex(tex, im.sticker);
        r.faces.forEach((f, j) => {
          tex.face[f] = idx;
          for (let k = 0; k < 3; k++) {
            const [uu, vv] = im.map(r.uv[j * 6 + k * 2], r.uv[j * 6 + k * 2 + 1]);
            tex.uv[f * 6 + k * 2] = uu; tex.uv[f * 6 + k * 2 + 1] = vv;
          }
        });
        doc.update(target.id, { texture: compactTexture(tex) });
        doc.emit();
      };
      ctx.app.view.paintPick = (id, face, point) => {
        if (picking) {
          // Sélecteur de texture: take the texture image of the clicked face.
          picking = false;
          const src = doc.get(id);
          const ti = src?.texture?.face[face] ?? -1;
          if (src?.texture && ti >= 0) {
            const im = src.texture.images[ti];
            choose({ width: im.width, height: im.height, data: im.data });
          } else ctx.app.toast('Cette face n’a pas de texture.', 'warn');
          return;
        }
        if (s.mode === 'sticker') { if (id === target.id) placeSticker(face, point); return; }
        if (id !== target.id) return;
        doc.checkpoint(); // one step per stroke
        const o = current();
        const w = worldMesh(o);
        const region = paintRegion(o.mesh, face, s.coverage);
        // 3D Builder's wallpaper: projected perpendicular to the clicked face, fitted to the region.
        const uv = wallpaperUV(w, region, faceNormalOf(w, face), s.tex.width / s.tex.height, s.wall);
        const tex = o.texture ? { images: [...o.texture.images], face: new Int16Array(o.texture.face), uv: new Float32Array(o.texture.uv) } : emptyTexture(o.mesh.indices.length / 3);
        const idx = imageIndex(tex, imagesOf(s.tex).wall);
        region.forEach((f, j) => { tex.face[f] = idx; tex.uv.set(uv.subarray(j * 6, j * 6 + 6), f * 6); });
        doc.update(target.id, { texture: compactTexture(tex) });
        base = doc.get(target.id)!.texture;
        doc.emit();
      };
      // 3D Builder's texture menu: Charger, Sélecteur de texture, Caméra, QR code for a URL (with a
      // transparent background switch), recent textures, the textures and the shapes.
      let picking = false;
      const recent: TexturePixels[] = [];
      const choose = (px: TexturePixels) => {
        s.tex = px;
        if (!recent.includes(px)) recent.unshift(px);
        recent.length = Math.min(recent.length, 6);
        thumb.replaceChildren(pixelsThumb(px, 28));
        sticker();
      };
      const fromBlob = async (b: Blob) => {
        const px = imageData(await createImageBitmap(b), 1024); // keeps transparency (stickers)
        choose({ width: px.width, height: px.height, data: px.data });
      };
      let transparent = true;
      const thumb = h('span', { style: 'display:inline-block;width:28px;height:28px;border:1px solid rgba(255,255,255,.5)' }, pixelsThumb(s.tex, 28));
      let menu: HTMLElement | null = null;
      const closeMenu = () => { menu?.remove(); menu = null; document.removeEventListener('pointerdown', outside, true); };
      const outside = (e: Event) => { if (menu && !menu.contains(e.target as Node) && !texBtn.contains(e.target as Node)) closeMenu(); };
      const row = (text: string, run: () => void) => h('button', { style: 'display:block;width:100%;text-align:left;padding:9px 12px', onclick: run }, text);
      const tile = (img: HTMLCanvasElement, title: string, run: () => void) => h('button', { title, style: 'width:56px;height:56px;padding:2px;margin:2px', onclick: () => { closeMenu(); run(); } }, img);
      const openMenu = () => {
        if (menu) return closeMenu();
        const rect = texBtn.getBoundingClientRect();
        const url = h('input', { type: 'url', placeholder: 'Insérer l’URL', style: 'flex:1;padding:6px', onkeydown: (e: KeyboardEvent) => { e.stopPropagation(); if (e.key === 'Enter') makeQr(); } }) as HTMLInputElement;
        const makeQr = () => {
          const text = url.value.trim();
          if (!text) return;
          try {
            choose(qrImage(encodeQr(text, 'M'), 8, transparent));
            closeMenu();
          } catch (e) { ctx.app.toast(e instanceof Error ? e.message : String(e), 'warn'); }
        };
        const transp = h('input', { type: 'checkbox', checked: transparent, onchange: () => { transparent = transp.checked; } }) as HTMLInputElement;
        const shapes = h('div', { style: 'display:grid;grid-template-columns:repeat(6,60px);padding:0 6px 8px' });
        menu = h('div', { class: 'color-menu', style: `position:fixed;left:${rect.left}px;top:${rect.bottom + 4}px;z-index:50;background:#2b2b2b;color:#fff;width:390px;max-height:calc(100vh - ${rect.bottom + 16}px);overflow:auto;box-shadow:0 6px 24px rgba(0,0,0,.5)` },
          row('Charger', () => { closeMenu(); void pickFiles('image/*', false).then(([f]) => f && fromBlob(f)); }),
          row('Sélecteur de texture', () => { closeMenu(); picking = true; ctx.app.toast('Cliquez sur une face texturée pour reprendre sa texture.'); }),
          row('Caméra', () => { closeMenu(); void ctx.app.capturePhoto().then((b) => b && fromBlob(b)); }),
          h('div', { style: 'display:flex;gap:6px;align-items:center;padding:6px 12px' }, h('span', { style: 'font-size:13px' }, 'Générer une texture QR pour'), url, h('button', { title: 'Générer', html: icon('ok', 18), onclick: makeQr })),
          h('label', { style: 'display:flex;gap:8px;align-items:center;padding:4px 12px 8px;font-size:13px' }, transp, 'Arrière-plan transparent'),
          h('div', { style: 'padding:6px 12px;font-size:12px;opacity:.75' }, 'Matériaux récents'),
          h('div', { style: 'padding:0 6px' }, ...recent.map((px) => tile(pixelsThumb(px, 52), 'Récent', () => choose(px)))),
          h('div', { style: 'padding:6px 12px;font-size:12px;opacity:.75' }, 'Texture'),
          h('div', { style: 'display:grid;grid-template-columns:repeat(6,60px);padding:0 6px' }, ...TEXTURES.map((t) => tile(pixelsThumb(proceduralTexture(t.id, 64), 52), t.label, () => choose(proceduralTexture(t.id))))),
          shapes);
        document.body.append(menu);
        setTimeout(() => document.addEventListener('pointerdown', outside, true));
        // Shapes, drawn from the same outlines as the emboss motifs (dark on a light or clear ground).
        for (const sh of SHAPES) {
          void shapePixels(sh.id, transparent).then((px) => { if (px) shapes.append(tile(pixelsThumb(px, 52), sh.label, () => choose(px))); });
        }
      };
      const texBtn = h('button', { class: 'color-btn', title: 'Texture', 'aria-label': 'Texture', style: 'display:flex;align-items:center;gap:6px;padding:6px', onclick: openMenu },
        thumb, h('span', { html: icon('chevronDown', 14) }));
      // Sticker as 3D Builder: a click on the object puts the sticker there (on the side the clicked
      // face looks at); « Modifier l'autocollant » (on once one is placed) makes the next clicks move
      // it, off they place a new one; « Supprimer l'autocollant » removes it. Its bar at the bottom:
      // Rotation (degrees) and Échelle (X, Y in %, 100 at first, lock).
      let placed = false, editing = false, lock = true, tmode: 'rotate' | 'scale' = 'scale';
      const bottom = floatingBar(ctx);
      bottom.classList.add('hidden');
      const renderBottom = () => {
        bottom.classList.toggle('hidden', !(s.mode === 'sticker' && placed));
        bottom.replaceChildren(
          barTool(tmode === 'rotate', 'rotate', 'Rotation', () => { tmode = 'rotate'; renderBottom(); }),
          barTool(tmode === 'scale', 'scale', 'Mise à l’échelle', () => { tmode = 'scale'; renderBottom(); }),
          ...(tmode === 'rotate'
            ? [barValue('', '', s.rotation, (v) => { s.rotation = v; sticker(); renderBottom(); }), h('span', { class: 'unit' }, 'deg')]
            : [
              barValue('x', 'X', s.scaleX, (v) => { const k = Math.max(1, v) / s.scaleX; s.scaleX = Math.max(1, v); if (lock) s.scaleY *= k; sticker(); renderBottom(); }),
              barValue('y', 'Y', s.scaleY, (v) => { const k = Math.max(1, v) / s.scaleY; s.scaleY = Math.max(1, v); if (lock) s.scaleX *= k; sticker(); renderBottom(); }),
              h('span', { class: 'unit' }, '%'),
              h('button', { class: `tool${lock ? ' on' : ''}`, title: 'Verrouiller les proportions', 'aria-label': 'Verrouiller les proportions', html: icon(lock ? 'lock' : 'unlock', 20), onclick: () => { lock = !lock; renderBottom(); } }),
            ]),
        );
      };
      const editBtn = toggle('Modifier l’autocollant', 'move', false, () => { if (!placed) return; editing = !editing; editBtn.classList.toggle('on', editing); });
      const deleteBtn = h('button', { class: 'toggle', disabled: true, html: `${icon('delete')}<span>Supprimer l’autocollant</span>` }) as HTMLButtonElement;
      const setPlaced = (on: boolean) => {
        placed = on;
        editing = on;
        editBtn.classList.toggle('on', on);
        deleteBtn.disabled = !on;
        renderBottom();
      };
      deleteBtn.addEventListener('click', () => {
        if (!placed) return;
        doc.checkpoint();
        doc.update(target.id, { texture: base });
        doc.emit();
        setPlaced(false);
      });
      placeSticker = (face: number, point: number[]) => {
        const o = current();
        const w = worldMesh(o);
        const n = faceNormalOf(w, face);
        const a = n.map(Math.abs);
        const k = a.indexOf(Math.max(...a));
        const side: Direction | null = k === 2 ? (n[2] > 0 ? '+z' : null) : k === 0 ? (n[0] > 0 ? '+x' : '-x') : (n[1] > 0 ? '+y' : '-y');
        if (!side) return;
        if (placed && !editing) base = o.texture; // the previous sticker stays, a new one is placed
        const b = bounds(w);
        const c = [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);
        const q = [0, 1, 2].map((i) => point[i] - c[i]);
        const { u, v } = frameOf(side);
        s.direction = side;
        s.offsetU = q[0] * u[0] + q[1] * u[1] + q[2] * u[2];
        s.offsetV = q[0] * v[0] + q[1] * v[1] + q[2] * v[2];
        doc.checkpoint();
        if (!placed) { s.rotation = 0; s.scaleX = s.scaleY = 100; }
        sticker(true);
        setPlaced(true);
      };
      const coverage = h('span', { style: 'display:none' },
        h('span', { class: 'vsep' }),
        slider('Couverture', 0, 100, 0.5, 22.5, (val) => { s.coverage = val; }));
      const stickerGroup = h('span', { style: 'display:none' }, h('span', { class: 'vsep' }), editBtn, deleteBtn);
      const modeBtns: HTMLButtonElement[] = [];
      const modeBtn = (id: 'sticker' | 'brush', label: string, ico: string) => {
        const b = toggle(label, ico, id === s.mode, () => {
          s.mode = id;
          modeBtns.forEach((x) => x.classList.toggle('on', x === b));
          stickerGroup.style.display = id === 'sticker' ? 'contents' : 'none';
          coverage.style.display = id === 'brush' ? 'contents' : 'none';
          renderBottom();
        });
        modeBtns.push(b);
        return b;
      };
      ctx.bar.append(
        h('label', {}, 'Sélectionné', texBtn),
        h('span', { class: 'vsep' }),
        modeBtn('sticker', 'Sticker', 'texture'), modeBtn('brush', 'Pinceau', 'grid'),
        stickerGroup, coverage,
      );
      stickerGroup.style.display = s.mode === 'sticker' ? 'contents' : 'none';
      coverage.style.display = s.mode === 'brush' ? 'contents' : 'none';
      renderBottom();
      return () => {
        bottom.remove();
        ctx.app.view.paintPick = null;
        if (!st(ctx, 'applied', false)) ctx.app.rollbackMode();
      };
    },
    async apply(ctx) {
      set(ctx, 'applied', true);
      return true;
    },
  },

  material: {
    okLabel: 'Appliquer',
    tip: 'Le matériau et la couleur s’appliquent à tout l’objet. Choisissez le type, puis la couleur.',
    build(ctx) {
      const first = ctx.selection[0];
      const s = { material: (first.material ?? 'simple') as MaterialKind, color: first.color };
      const past: { material: MaterialKind; color: string }[] = [], future: typeof past = [];
      let prev = { ...s };
      const preview = (record = true) => {
        if (record && (prev.material !== s.material || prev.color !== s.color)) { past.push(prev); future.length = 0; prev = { ...s }; }
        // Live: temporarily restyle the selected objects (restored on cancel).
        for (const o of ctx.selection) ctx.app.doc.update(o.id, { material: s.material, color: s.color });
        ctx.app.doc.emit();
      };
      // Annuler / Refaire of the bar, as 3D Builder.
      const back = (from: typeof past, to: typeof past) => {
        const p = from.pop();
        if (!p) return;
        to.push({ ...s });
        Object.assign(s, p);
        prev = { ...s };
        typeSel.value = s.material;
        picker.setColor?.(s.color);
        preview(false);
      };
      ctx.history = { undo: () => back(past, future), redo: () => back(future, past) };
      const original = ctx.selection.map((o) => ({ id: o.id, material: o.material, color: o.color }));
      const typeSel = h('select', { 'aria-label': 'Type' }, ...MATERIALS.map((x) => h('option', { value: x.id, selected: x.id === s.material }, x.label)));
      typeSel.addEventListener('change', () => { s.material = typeSel.value as MaterialKind; preview(); });
      // Eyedropper: the next click on an object takes its material and colour (or only the colour).
      const eyedrop = (withMaterial: boolean) => {
        ctx.app.toast(withMaterial ? 'Cliquez sur un objet pour reprendre son matériau.' : 'Cliquez sur un objet pour reprendre sa couleur.');
        ctx.app.view.paintPick = (id, face) => {
          ctx.app.view.paintPick = null;
          const o = ctx.app.doc.get(id);
          if (!o) return;
          if (withMaterial) { s.material = o.material ?? 'simple'; typeSel.value = s.material; }
          s.color = faceColorOf(o, face);
          picker.setColor?.(s.color);
          preview();
        };
      };
      const picker = colorPicker('Couleur', () => s.color, (c) => { s.color = c; preview(); }, () => eyedrop(false)) as HTMLElement & { setColor?: (c: string) => void };
      ctx.bar.append(h('label', {}, 'Type', typeSel), h('label', {}, 'Couleur', picker),
        h('button', { class: 'act', html: `${icon('eyedropper', 22)}<span>Sélectionner les matériaux</span>`, onclick: () => eyedrop(true) }));
      return () => {
        ctx.app.view.paintPick = null;
        if (st(ctx, 'applied', false)) return;
        for (const o of original) ctx.app.doc.update(o.id, { material: o.material, color: o.color });
        ctx.app.doc.emit();
      };
    },
    async apply(ctx) {
      // Record the change for undo: restore the originals, checkpoint, re-apply.
      const now = ctx.selection.map((o) => ({ id: o.id, material: ctx.app.doc.get(o.id)!.material, color: ctx.app.doc.get(o.id)!.color }));
      for (const o of ctx.selection) ctx.app.doc.update(o.id, { material: o.material, color: o.color });
      ctx.app.doc.checkpoint();
      for (const o of now) ctx.app.doc.update(o.id, { material: o.material, color: o.color });
      ctx.app.doc.emit();
      set(ctx, 'applied', true);
      return true;
    },
  },

  color: {
    okLabel: 'Couleur',
    history: true,
    tip: 'Choisissez une couleur dans Sélectionné. Survolez l’objet pour voir la zone qui sera peinte, puis cliquez pour la peindre. Couverture agrandit ou réduit cette zone.',
    build(ctx) {
      // Painting edits the document directly; Annuler rolls back to this checkpoint.
      const doc = ctx.app.doc;
      doc.checkpoint();
      const ids = new Set(ctx.selection.map((o) => o.id));
      // Coverage in % (3D Builder: 0 = smallest area, 100 = whole object; its colour default, 180,
      // lies past the slider's end, so the slider starts at 100).
      const s = { color: ctx.selection[0].color, coverage: 100, whole: false };
      let picking = false;
      const picker = colorPicker('Sélectionné', () => s.color, (c) => { s.color = c; }, () => {
        picking = true;
        ctx.app.toast('Cliquez sur un objet pour reprendre sa couleur.');
      }) as HTMLElement & { setColor?: (c: string) => void };
      const region = (id: number, face: number) => {
        const o = doc.get(id)!;
        return s.whole ? Array.from({ length: o.mesh.indices.length / 3 }, (_, i) => i) : paintRegion(o.mesh, face, s.coverage);
      };
      ctx.app.view.paintPick = (id, face) => {
        if (picking) {
          // Compte-gouttes: take the colour under the click instead of painting.
          picking = false;
          const src = doc.get(id);
          if (src) { s.color = faceColorOf(src, face); picker.setColor?.(s.color); }
          return;
        }
        if (!ids.has(id)) return;
        doc.checkpoint(); // one step per stroke (Annuler / Refaire of the bar)
        const o = doc.get(id)!;
        // A face shows one material: painting a colour replaces its texture, as in 3D Builder.
        if (s.whole) {
          doc.update(id, { color: s.color, faceColors: undefined, texture: undefined });
        } else {
          const colors = o.faceColors ? new Uint32Array(o.faceColors) : new Uint32Array(o.mesh.indices.length / 3).fill(NO_PAINT);
          const c = hexToInt(s.color);
          const faces = region(id, face);
          for (const f of faces) colors[f] = c;
          let texture = o.texture;
          if (texture) {
            texture = { ...texture, face: new Int16Array(texture.face) };
            for (const f of faces) texture.face[f] = -1;
            texture = compactTexture(texture);
          }
          doc.update(id, { faceColors: colors, texture });
        }
        doc.emit();
      };
      // Hovering shows the region a click would paint.
      ctx.app.view.paintHover = (hit) => {
        if (!hit || !ids.has(hit.id)) return void ctx.app.view.clearOverlay();
        const o = doc.get(hit.id)!;
        const sub = facesSubset(o.mesh, region(hit.id, hit.face));
        ctx.app.view.showPreview([{ mesh: transformed(sub, objectMatrix(o).elements), color: s.color, opacity: 0.75, onTop: true }]);
      };
      ctx.bar.append(
        h('label', {}, 'Sélectionné', picker),
        h('span', { class: 'vsep' }),
        slider('Couverture', 0, 100, 0.5, 100, (v) => { s.coverage = v; }),
      );

      return () => {
        ctx.app.view.paintPick = null;
        ctx.app.view.paintHover = null;
        if (!st(ctx, 'applied', false)) ctx.app.rollbackMode();
      };
    },
    async apply(ctx) {
      set(ctx, 'applied', true);
      return true;
    },
  },
};

/**
 * 3D Builder's image insertion tool: a bar with Méthode (Contour, Carte de texture, Bordure,
 * Tampon; Contour by default), the method's two sliders (Niveaux and Lisse, Détail and Lisse for
 * Tampon), Textures (on: the image is laid on the object) and Inverser, with a live preview.
 * Size: 0.254 mm per pixel (the contour spans the long side, the reliefs one step less).
 */
export function imageInsertMode(px: ImageData, name: string): ModeSpec {
  return {
    okLabel: 'Importer une image',
    build(ctx) {
      const s = { mode: 'contour' as ImageMode, level: 0, levels: [] as number[], p1: 16, p2: 0, invert: false, textures: true, reduced: true, width: 0, widthEdited: false };
      const natural = (m: ImageMode) => (Math.max(px.width, px.height) - (m === 'contour' ? 0 : 1)) * 0.254;
      const opts = () => ({
        mode: s.mode,
        p1: s.mode === 'contour' ? s.levels[s.level] ?? 128 : s.p1,
        p2: s.p2, invert: s.invert, reducedColors: s.reduced, width: s.width,
      });
      const run = previewer(ctx, async () => {
        const o = opts();
        const r = await insertImage(px, o);
        const b = bounds(r.mesh);
        // Shown where it will be added: centred, resting on the plate.
        const placed = transformed(r.mesh, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2], 1]);
        set(ctx, 'result', { ...r, o });
        // With Textures, the image is shown on the object while it is set (3D Builder).
        const texture = s.textures ? imageTexture(r.mesh, px, o) : undefined;
        return [{ mesh: placed, color: texture ? '#ffffff' : '#bcbcbc', faceColors: s.textures ? undefined : r.faceColors, texture }];
      });
      const fields = h('span', { style: 'display:contents' });
      const widthIn = h('input', { type: 'number', step: '0.1', min: '1', 'aria-label': 'Grand côté', style: 'width:80px' }) as HTMLInputElement;
      widthIn.addEventListener('change', () => { s.width = Math.max(1, parseFloat(widthIn.value.replace(',', '.')) || s.width); s.widthEdited = true; run(); });
      widthIn.addEventListener('keydown', (e) => e.stopPropagation());
      const range = (label: string, min: number, max: number, value: number, set2: (v: number) => void) => {
        const input = h('input', { type: 'range', min: String(min), max: String(max), step: '1', value: String(value), 'aria-label': label }) as HTMLInputElement;
        input.addEventListener('input', () => { set2(+input.value); run(); });
        return h('label', {}, label, input);
      };
      const setMode = (m: ImageMode) => {
        s.mode = m;
        const d = IMAGE_DEFAULTS[m];
        s.p1 = d.p1;
        s.p2 = d.p2;
        if (!s.widthEdited) { s.width = natural(m); widthIn.value = s.width.toFixed(2); }
        const items: HTMLElement[] = [];
        if (m === 'contour') {
          const r = contourLevels(px, s.invert);
          s.levels = r.levels;
          s.level = r.initial;
          items.push(range('Niveaux', 0, Math.max(0, s.levels.length - 1), s.level, (v) => { s.level = v; }), range('Lisse', 0, 8, s.p2, (v) => { s.p2 = v; }));
        } else if (m === 'stamp') {
          // Détail = dithering pattern (0-3), Lisse = block size − 1.
          items.push(range('Détail', 0, 3, s.p1, (v) => { s.p1 = v; }), range('Lisse', 0, 8, s.p2, (v) => { s.p2 = v; }));
        } else {
          // Niveaux = number of colours kept (2-256), Lisse = smoothing radius.
          items.push(range('Niveaux', 2, 256, s.p1, (v) => { s.p1 = v; }), range('Lisse', 0, 8, s.p2, (v) => { s.p2 = v; }));
        }
        fields.replaceChildren(...items);
        run(0);
      };
      const method = h('select', { 'aria-label': 'Méthode' }, ...([['contour', 'Contour'], ['height', 'Carte de texture'], ['edge', 'Bordure'], ['stamp', 'Tampon']] as const).map(([id, l]) => h('option', { value: id }, l))) as HTMLSelectElement;
      method.addEventListener('change', () => setMode(method.value as ImageMode));
      ctx.bar.append(
        h('label', {}, 'Méthode', method),
        fields,
        // As 3D Builder: no size field (0.254 mm per pixel; the object is scaled afterwards), and
        // Textures / Inverser are switches.
        h('span', { class: 'vsep' }),
        switchToggle('Textures', true, (on) => { s.textures = on; run(); }),
        switchToggle('Inverser', false, (on) => { s.invert = on; if (s.mode === 'contour') setMode('contour'); else run(); }, 'Invert'),
      );
      set(ctx, 'state', s);
      setMode('contour');
    },
    async apply(ctx) {
      const s = st<{ textures: boolean } | null>(ctx, 'state', null)!;
      let r = st<{ mesh: MeshData; faceColors?: Uint32Array; o: Parameters<typeof insertImage>[1] } | null>(ctx, 'result', null);
      if (!r) throw new Error('Aperçu en cours de calcul.');
      const texture = s.textures ? imageTexture(r.mesh, px, r.o) : undefined;
      const doc = ctx.app.doc;
      doc.checkpoint();
      // With Textures, 3D Builder leaves the untextured faces (relief walls and bottom) white.
      const obj = doc.addWorldMesh(r.mesh, { name, dropOnPlate: true, faceColors: texture ? undefined : r.faceColors, texture, color: texture ? '#ffffff' : undefined });
      doc.update(obj.id, { position: [0, 0, obj.position[2]] });
      doc.select([obj.id]);
      r = null;
      return true;
    },
  };
}
