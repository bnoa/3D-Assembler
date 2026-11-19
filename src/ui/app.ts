// Application shell: ribbon, side panel, transform bar, menu, notifications and commands.
import { Matrix4, Vector3 } from 'three';
import { NO_PAINT, SceneDocument, type SceneObject, type Vec3, isValid, movedTransform, objectMatrix, worldBounds, worldMesh } from '../core/model';
import { type MeshData, bounds, merged, size, surfaceArea, transformed } from '../core/mesh-data';
import { Viewport, type GizmoMode, type ViewSettings } from '../render/viewport';
import { PRIMITIVES, PRIMITIVE_COLORS, makePrimitive, type PrimitiveKind } from '../geometry/primitives';
import * as csg from '../geometry/csg';
import { type SolidRepairLog, splitShells } from '../repair/solid';
import { analyze } from '../repair/analyze';
import { repairAsync, selfIntersectionsAsync } from '../workers/client';
import { shells } from '../repair/topology';
import { nearestFaces, transferFaceColors } from '../repair/colors';
import { type ObjectTexture, mergeTextures, transferTexture } from '../core/texture-data';
import { EXPORT_FORMATS, IMPORT_ACCEPT, exportScene, importFile, type ExportFormat } from '../io/formats';
import { read3MFInfo } from '../io/threemf';
import { icon } from './icons';
import { download, h, pickFiles } from './dom';
import { addRecent, listRecent, recentFile } from '../io/recent';
import { clearRecovery, orphanRecoveries, recoverySession, saveRecovery } from '../io/recovery';
import { type Lang, currentLang, setLang, systemLang, toEnglish } from './i18n';
import { type ModeContext, type ModeSpec, MODES, imageInsertMode } from './modes';
import { type Bed, DEFAULT_BED } from '../analysis/printability';
import { imageData } from '../geometry/image-insert';
import { settleRotation } from '../geometry/settle';

type Tab = 'insert' | 'object' | 'edit' | 'paint' | 'view' | 'help';
const TABS: { id: Tab; label: string }[] = [
  { id: 'insert', label: 'Insérer' },
  { id: 'object', label: 'Objet' },
  { id: 'edit', label: 'Modifier' },
  { id: 'paint', label: 'Pinceau' },
  { id: 'view', label: 'Affichage' },
  { id: 'help', label: 'Aide' },
];

export const UNITS = {
  micron: { label: 'Micron', short: 'µm', mm: 0.001 },
  mm: { label: 'Millimètre', short: 'mm', mm: 1 },
  cm: { label: 'Centimètre', short: 'cm', mm: 10 },
  inch: { label: 'Pouce', short: 'in', mm: 25.4 },
  foot: { label: 'Pied', short: 'ft', mm: 304.8 },
  m: { label: 'Mètre', short: 'm', mm: 1000 },
} as const;
export type Unit = keyof typeof UNITS;

interface Prefs {
  unit: Unit;
  theme: 'system' | 'light' | 'dark';
  bed: Bed;
  align: boolean; // 3D Builder's "Alignement" (on by default)
  collision: boolean;
  /** Interface language: the system's (French for a French system, English otherwise) or a choice. */
  lang: 'auto' | Lang;
}

function loadPrefs(): Prefs {
  try {
    return { unit: 'mm', theme: 'system', bed: { ...DEFAULT_BED }, align: true, collision: false, lang: 'auto', ...JSON.parse(localStorage.getItem('3dbr.prefs') ?? '{}') };
  } catch {
    return { unit: 'mm', theme: 'system', bed: { ...DEFAULT_BED }, align: true, collision: false, lang: 'auto' };
  }
}

/** Number of separate parts (shells) of a mesh, cached per mesh. */
const partCounts = new WeakMap<MeshData, number>();
function partCount(m: MeshData): number {
  let n = partCounts.get(m);
  if (n === undefined) {
    const label = shells(m.indices, m.positions.length / 3);
    n = 0;
    for (let i = 0; i < label.length; i++) n = Math.max(n, label[i] + 1);
    partCounts.set(m, n);
  }
  return n;
}

/** Small thumbnail (data URL) of an image file, for the recent list. */
async function imageThumb(file: File): Promise<string | undefined> {
  try {
    const bmp = await createImageBitmap(file);
    const k = 128 / Math.max(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } catch {
    return undefined;
  }
}

/** An object's transform as a 3MF build transform (row vectors m00 m01 m02 m10 … m32). */
function rowTransform(o: SceneObject): number[] {
  const e = objectMatrix(o).elements;
  return [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10], e[12], e[13], e[14]];
}

function dataUrlBytes(url: string): Uint8Array {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class App {
  readonly doc = new SceneDocument();
  readonly view: Viewport;
  prefs = loadPrefs();
  private tab: Tab | null = 'insert';
  private mode: { spec: ModeSpec; depth: number; ctx: ModeContext; cleanup?: () => void } | null = null;
  private gizmo: GizmoMode = 'translate';
  private lockScale = false; // 3D Builder: proportions unlocked by default
  private scalePercent = false; // scale values in % of the original size instead of the unit
  private sideCollapsed = false;
  private clipboard: { mesh: MeshData; color: string; name: string; faceColors?: Uint32Array; texture?: ObjectTexture }[] = [];

  private top = h('div');
  private ribbon = h('div', { class: 'ribbon' });
  private side = h('aside', { class: 'side', onpointerleave: () => this.view.focusObject(null) });
  private viewEl = h('div', { class: 'view' });
  private tbar = h('div', { class: 'tbar hidden' });
  private toasts = h('div', { class: 'toasts' });
  private busyEl = h('div', { class: 'busy hidden' }, 'Traitement de l’opération…');
  private home = h('div', { class: 'home' });
  private drawer = h('nav', { class: 'drawer hidden' });
  private scrim = h('div', { class: 'scrim hidden' });
  private invalidToast: HTMLElement | null = null;
  /** Recovery copy, as 3D Builder's AutoSave: after a change, at most every 30 s (a change inside
   * the interval waits for its end), and at once when the tab is hidden or closed. Off until the
   * start-up prompt is answered. */
  private backupReady = false;
  /** The browser's install offer (« Installer l'application » in the menu while it is available). */
  private installPrompt: (Event & { prompt(): Promise<void> }) | null = null;
  private backupTimer = 0;
  private backupLast = 0;

  constructor(root: HTMLElement) {
    this.applyTheme();
    const main = h('div', { class: 'main' }, this.viewEl, this.side);
    root.append(this.top, this.ribbon, main);
    this.viewEl.append(this.tbar, this.toasts, this.busyEl, this.home, this.scrim, this.drawer);
    this.view = new Viewport(this.viewEl, this.doc);
    this.view.onPick = (id, additive) => this.doc.select(id === null ? [] : [id], additive);
    this.view.onTransformStart = () => this.doc.checkpoint();
    this.view.onTransformEnd = (changes) => {
      for (const c of changes) this.doc.update(c.id, { position: c.position, rotation: c.rotation, scale: c.scale });
      this.doc.emit();
    };
    this.view.onTransformLive = () => this.renderTbarValues();
    this.view.setGizmo(null);
    this.applyPrefs();
    this.doc.on(() => this.refresh());
    this.doc.on(() => this.scheduleBackup());
    this.scrim.addEventListener('click', () => this.closeDrawer());
    this.bindKeys();
    this.bindDrop();
    this.buildHome();
    this.buildDrawer();
    this.refresh();
    window.addEventListener('beforeunload', (e) => {
      if (this.doc.dirty && this.doc.objects.length) e.preventDefault();
    });
    // The tab may be closed without a chance to finish the timer: write the copy when it is hidden.
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.backupTimer) { clearTimeout(this.backupTimer); this.backupTimer = 0; void this.writeBackup(); } });
    recoverySession();
    void this.offerRecovery();
    this.bindInstall();
  }

  // --- installed app -------------------------------------------------------------------------------

  private bindInstall(): void {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installPrompt = e as Event & { prompt(): Promise<void> };
      this.buildDrawer();
    });
    window.addEventListener('appinstalled', () => { this.installPrompt = null; this.buildDrawer(); });
    // Files opened with the installed app (« Ouvrir avec », double click on a .3mf / .stl…).
    const lq = (window as unknown as { launchQueue?: { setConsumer(f: (p: { files?: { getFile(): Promise<File> }[] }) => void): void } }).launchQueue;
    lq?.setConsumer((p) => {
      if (!p.files?.length) return;
      void Promise.all(p.files.map((f) => f.getFile())).then((files) => this.importFiles(files, true));
    });
    // Desktop app (installer): the files it was opened with.
    const desktop = (window as unknown as { assemblerDesktop?: { onOpenFiles(cb: (f: { name: string; data: ArrayBuffer }[]) => void): void } }).assemblerDesktop;
    desktop?.onOpenFiles((files) => { void this.importFiles(files.map((f) => new File([f.data], f.name)), true); });
  }

  // --- session recovery ----------------------------------------------------------------------------

  private scheduleBackup(): void {
    if (!this.backupReady) return;
    if (this.backupTimer) return; // pending: written at the end of the interval
    const wait = Math.max(0, this.backupLast + 30000 - Date.now());
    this.backupTimer = window.setTimeout(() => { this.backupTimer = 0; void this.writeBackup(); }, wait);
  }

  /** The scene is saved or new: its recovery copy goes at once (3D Builder deletes the file). */
  private dropBackup(): void {
    clearTimeout(this.backupTimer);
    this.backupTimer = 0;
    if (this.backupReady) void clearRecovery();
  }

  private async writeBackup(): Promise<void> {
    this.backupLast = Date.now();
    if (!this.doc.dirty || !this.doc.objects.length) return clearRecovery();
    try {
      await saveRecovery(this.doc.name, await exportScene(this.sceneItems(this.doc.objects), '3mf', this.doc.name, this.doc.info));
    } catch { /* the copy is best effort */ }
  }

  /** 3D Builder's start-up prompt when the previous session left unsaved changes. */
  private async offerRecovery(): Promise<void> {
    const orphans = await orphanRecoveries();
    if (!orphans.length) { this.backupReady = true; return; }
    // The newest copy is reloaded in this tab; the others stay for a later start (3D Builder reopens
    // one window per orphaned session).
    const r = orphans[0];
    const answer = (keep: boolean) => async () => {
      el.remove();
      if (keep) {
        await this.restoreScene(new File([r.data], `${r.name}.3mf`), r.name);
        if (r.session !== recoverySession()) await clearRecovery(r.session);
      } else for (const o of orphans) await clearRecovery(o.session);
      this.backupReady = true;
      if (keep) this.scheduleBackup();
    };
    const el: HTMLElement = h('div', { class: 'dialog' },
      h('div', { class: 'box', role: 'alertdialog', 'aria-label': 'Récupération' },
        h('p', {}, 'La dernière session s’est fermée avec des modifications non enregistrées. Les récupérer ?'),
        h('div', { class: 'btns' },
          h('button', { class: 'primary', onclick: answer(true) }, 'Continuer'),
          h('button', { onclick: answer(false) }, 'Ignorer'))));
    document.body.append(el);
  }

  /** Puts the recovery copy back as it was: objects where they were, scene unsaved, no recent entry. */
  private async restoreScene(file: File, name: string): Promise<void> {
    await this.busy(async () => {
      this.doc.reset(name);
      try { Object.assign(this.doc.info, read3MFInfo(new Uint8Array(await file.arrayBuffer()))); } catch { /* no metadata */ }
      for (const item of await importFile(file)) {
        const opts = { name: item.name, color: item.color, faceColors: item.faceColors, texture: item.texture };
        if (item.local) this.doc.addTransformedMesh(item.local.mesh, item.local.transform, opts);
        else this.doc.addWorldMesh(item.mesh, opts);
      }
      this.home.classList.add('hidden');
      this.doc.dirty = true;
      this.frameAll();
      this.doc.emit();
    });
  }

  /** Scene objects as saved in a 3MF (each mesh in its own frame, its transform in the build item). */
  private sceneItems(objs: SceneObject[]) {
    return objs.map((o) => ({ name: o.name, mesh: worldMesh(o), color: o.color, faceColors: o.faceColors, texture: o.texture, local: { mesh: o.mesh, transform: rowTransform(o) } }));
  }

  // --- rendering ---------------------------------------------------------------------------------

  refresh(): void {
    if (!this.mode) this.renderTop();
    this.renderRibbon();
    this.renderSide();
    this.renderTbar();
    this.updateInvalidToast();
    document.title = `${currentLang() === 'en' ? toEnglish(this.doc.name) : this.doc.name}${this.doc.dirty ? ' *' : ''} - 3D Assembler`;
  }

  private renderTop(): void {
    this.top.replaceChildren(
      h('header', { class: 'topbar' },
        h('button', { class: 'burger', title: 'Menu', html: icon('menu', 22), onclick: () => this.openDrawer() }),
        h('nav', { class: 'tabs', role: 'tablist' },
          ...TABS.map((t) => h('button', {
            class: this.tab === t.id ? 'on' : '', role: 'tab', 'aria-selected': this.tab === t.id ? 'true' : 'false',
            onclick: () => { this.tab = this.tab === t.id ? null : t.id; this.refresh(); },
          }, t.label))),
        h('div', { class: 'spacer' }),
        h('div', { class: 'quick' },
          h('button', { title: 'Imprimer en 3D', disabled: !this.doc.objects.length, onclick: () => this.enterMode(MODES.print3d), html: `${icon('print')}<span class="label">Imprimer en 3D</span>` }),
          h('button', { title: 'Enregistrer', disabled: !this.doc.objects.length, onclick: () => this.save(), html: icon('save') }),
          h('span', { class: 'sep' }),
          h('button', { title: 'Annuler (Ctrl+Z)', disabled: !this.doc.canUndo, onclick: () => this.doc.undo(), html: icon('undo') }),
          h('button', { title: 'Refaire (Ctrl+Y)', disabled: !this.doc.canRedo, onclick: () => this.doc.redo(), html: icon('redo') }),
        ),
      ),
    );
  }

  private rb(label: string, ico: string, onclick: () => void, opts: { disabled?: boolean; on?: boolean; title?: string } = {}) {
    return h('button', {
      class: `rb${opts.on ? ' on' : ''}`, 'data-rb': label, disabled: !!opts.disabled, title: opts.title ?? label,
      onclick, html: `${icon(ico)}<span>${label}</span>`,
    });
  }

  private renderRibbon(): void {
    const r = this.ribbon;
    r.classList.toggle('hidden', !this.tab || !!this.mode);
    if (!this.tab || this.mode) return;
    const sel = this.doc.selected;
    const n = sel.length;
    const s = this.view.settings;
    const sep = () => h('span', { class: 'rb-sep' });
    const items: HTMLElement[] = [];
    switch (this.tab) {
      case 'insert':
        items.push(
          this.rb('Ajouter', 'add', () => void this.addPanel(), { title: 'Fichiers récents, fichier 3D, image ou photo' }),
          sep(),
          this.rb('Personnalisé', 'custom', () => this.customShapeDialog(), { title: 'Forme paramétrique aux dimensions voulues' }),
          sep(),
        );
        for (const p of PRIMITIVES) items.push(this.rb(p.label, p.icon, () => this.addPrimitive(p.kind)));
        break;
      case 'object':
        items.push(
          this.rb('Dupliquer', 'duplicate', () => this.duplicate(), { disabled: !n }),
          this.rb('Copier', 'copy', () => this.copy(), { disabled: !n }),
          this.rb('Couper', 'cut', () => this.cut(), { disabled: !n }),
          this.rb('Coller', 'paste', () => this.paste(), { disabled: !this.clipboard.length }),
          this.rb('Supprimer', 'delete', () => this.deleteSelection(), { disabled: !n }),
          sep(),
          this.rb('Positionner', 'layFlat', () => this.enterMode(MODES.position), { disabled: !n, title: 'Faire basculer l’objet à la souris ; il retombe à plat sur le plateau' }),
          this.rb('Inverser', 'mirror', () => this.mirrorFlyout(), { disabled: !n }),
          this.rb('Mesure', 'measure', () => this.enterMode(MODES.measure), { disabled: !this.doc.objects.length, title: 'Distance entre deux points cliqués sur les objets' }),
        );
        break;
      case 'edit':
        items.push(
          this.rb('Simplifier', 'simplify', () => this.enterMode(MODES.simplify), { disabled: n !== 1 }),
          this.rb('Fractionner', 'split', () => this.enterMode(MODES.split), { disabled: !n }),
          this.rb('Lisse', 'smooth', () => this.enterMode(MODES.smooth), { disabled: n !== 1 }),
          this.rb('Relief', 'emboss', () => this.enterMode(MODES.emboss), { disabled: n !== 1, title: 'Texte, forme ou image en relief ou gravé' }),
          this.rb('Extruder vers le bas', 'extrude', () => this.enterMode(MODES.extrudeDown), { disabled: !n }),
          sep(),
          this.rb('Fusionner', 'union', () => this.boolean('union'), { disabled: !n }),
          this.rb('Définir une intersection', 'intersect', () => this.boolean('intersect'), { disabled: n !== 2, title: 'Garde la partie commune des deux objets sélectionnés' }),
          this.rb('Soustraire', 'subtract', () => this.boolean('subtract'), { disabled: n !== 1, title: 'Retire l’objet sélectionné de tous les objets qu’il touche' }),
          sep(),
          this.rb('Creux', 'hollow', () => this.enterMode(MODES.hollow), { disabled: n !== 1 }),
        );
        break;
      case 'paint':
        items.push(
          this.rb('Matériau', 'material', () => this.enterMode(MODES.material), { disabled: !n }),
          sep(),
          this.rb('Couleur', 'color', () => this.enterMode(MODES.color), { disabled: !n, title: 'Peindre une zone de l’objet' }),
          this.rb('Texture', 'texture', () => this.enterMode(MODES.texture), { disabled: n !== 1, title: 'Appliquer une image comme papier peint' }),
        );
        break;
      case 'view': {
        const toggle = (label: string, ico: string, key: keyof ViewSettings) =>
          this.rb(label, ico, () => { this.view.applySettings({ [key]: !s[key] } as Partial<ViewSettings>); this.refresh(); }, { on: !!s[key] });
        items.push(
          this.rb('Centrer la vue', 'center', () => this.frameAll()),
          sep(),
          toggle('Ombrage', 'shading', 'shading'),
          toggle('Ombres', 'shadows', 'shadows'),
          toggle('Couleurs', 'colors', 'colors'),
          toggle('Reflets', 'reflections', 'reflections'),
          toggle('Lissage', 'smoothing', 'smoothing'),
          sep(),
          toggle('Rendu filaire', 'wireframe', 'wireframe'),
          this.rb('Grille', 'grid', () => this.gridFlyout()),
          sep(),
          toggle('Rayon X', 'xray', 'xray'),
        );
        break;
      }
      case 'help':
        // À propos is in Paramètres (and Ctrl+B).
        items.push(this.rb('Prise en main', 'help', () => this.showHelp()));
        break;
    }
    r.replaceChildren(...items);
  }

  private renderSide(): void {
    const n = this.doc.selected.length;
    const all = this.doc.objects.length;
    const c = this.sideCollapsed;
    const cmd = (label: string, ico: string, fn: () => void, disabled = false) =>
      h('button', { class: 'cmd', disabled, title: label, onclick: fn, html: `${icon(ico)}<span>${label}</span>` });
    this.side.classList.toggle('collapsed', c);
    this.side.replaceChildren(
      h('button', { class: 'collapse', title: c ? 'Développer le volet' : 'Réduire le volet', html: icon(c ? 'chevronLeft' : 'chevronRight'), onclick: () => { this.sideCollapsed = !c; this.renderSide(); } }),
      cmd('Grouper', 'group', () => this.group(), n < 2),
      cmd('Dissocier', 'ungroup', () => this.ungroup(), n !== 1 || partCount(this.doc.selected[0].mesh) < 2),
      cmd('Sélectionner tout', 'selectAll', () => this.doc.select(this.doc.objects.map((o) => o.id)), !all || n === all),
      cmd('Tout désélectionner', 'deselect', () => this.doc.select([]), !n),
      cmd('Inverser la sélection', 'invert', () => this.doc.select(this.doc.objects.filter((o) => !this.doc.selection.has(o.id)).map((o) => o.id)), !all),
      (() => {
        // 3D Builder's "Sélection temporaire": switches between single and additive selection.
        const b = cmd('Sélection temporaire', 'selectAdd', () => { this.view.additiveSelect = !this.view.additiveSelect; this.renderSide(); });
        b.classList.toggle('on', this.view.additiveSelect);
        b.setAttribute('aria-pressed', String(this.view.additiveSelect));
        return b;
      })(),
      h('h3', {}, 'Éléments'),
      h('div', { class: 'items' },
        ...this.doc.objects.map((o) => h('button', {
          class: `item${this.doc.selection.has(o.id) ? ' on' : ''}`, title: o.name,
          onclick: (e: MouseEvent) => { this.doc.select([o.id], e.ctrlKey || e.shiftKey || this.view.additiveSelect); this.view.focusObject(o.id); },
        },
          h('img', { src: this.view.thumbnail(o), alt: '' }),
          isValid(o) ? null : h('span', { class: 'bad', title: 'Objet non valide' }, '!'),
          h('span', { class: 'nm' }, o.name),
        )),
      ),
    );
  }

  private renderTbar(): void {
    const sel = this.doc.selected;
    const show = sel.length > 0 && !this.mode;
    this.tbar.classList.toggle('hidden', !show);
    this.view.setGizmo(show && this.gizmo !== 'translate' ? this.gizmo : show && sel.length === 1 ? 'translate' : null);
    if (!show) return;
    const tool = (m: GizmoMode, ico: string, label: string) =>
      h('button', { class: `tool${this.gizmo === m ? ' on' : ''}`, title: label, html: icon(ico, 22), onclick: () => { this.gizmo = m; this.renderTbar(); } });
    const unit = UNITS[this.prefs.unit];
    // 3D Builder names the rotation angles Roulis, Tangage, Lacet (about X, Y, Z).
    const names = this.gizmo === 'rotate' ? ['Roulis', 'Tangage', 'Lacet'] : ['X', 'Y', 'Z'];
    const vals = ['x', 'y', 'z'].map((axis, i) => {
      const input = h('input', { type: 'text', inputmode: 'decimal', 'data-axis': i, 'aria-label': names[i] });
      input.addEventListener('change', () => this.applyTbarValue(i, input.value));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); e.stopPropagation(); });
      return h('label', { class: `val ${axis}` }, h('small', {}, names[i]), input);
    });
    const unitLabel = this.gizmo === 'rotate' ? 'deg' : this.gizmo === 'scale' && this.scalePercent ? '%' : unit.short;
    this.tbar.replaceChildren(
      tool('translate', 'move', 'Mouvement'),
      tool('rotate', 'rotate', 'Rotation'),
      tool('scale', 'scale', 'Mise à l’échelle'),
      ...vals,
      this.gizmo === 'scale'
        // As in 3D Builder, the unit of the scale values is a switch: size in the unit, or %.
        ? h('button', { class: 'unit', title: 'Basculer entre taille et pourcentage', style: 'text-decoration:underline', onclick: () => { this.scalePercent = !this.scalePercent; this.renderTbar(); } }, unitLabel)
        : h('span', { class: 'unit' }, unitLabel),
    );
    if (this.gizmo === 'rotate') {
      this.tbar.append(h('button', {
        class: 'tool', title: 'Réinitialiser la rotation de l’objet (l’aligner sur les axes)', html: icon('resetRotation', 20),
        onclick: () => {
          this.doc.checkpoint();
          for (const o of this.doc.selected) this.doc.update(o.id, { rotation: [0, 0, 0] });
          this.doc.emit();
        },
      }));
    }
    if (this.gizmo === 'scale') {
      this.tbar.append(h('button', {
        class: `tool${this.lockScale ? ' on' : ''}`, title: 'Verrouiller les proportions', html: icon(this.lockScale ? 'lock' : 'unlock', 20),
        onclick: () => { this.lockScale = !this.lockScale; this.renderTbar(); },
      }));
    }
    this.renderTbarValues();
  }

  /** Current values for the transform bar: centre position, rotation, or size. */
  private tbarValues(): Vec3 | null {
    const sel = this.doc.selected;
    if (!sel.length) return null;
    const live = sel.length === 1 ? this.view.liveTransform(sel[0].id) : null;
    const o = live ? { ...sel[0], ...live } : sel[0];
    const k = UNITS[this.prefs.unit].mm;
    if (this.gizmo === 'rotate') return o.rotation;
    if (this.gizmo === 'scale' && this.scalePercent) return sel.length === 1 ? o.scale.map((s) => s * 100) as Vec3 : [100, 100, 100];
    if (this.gizmo === 'scale') {
      const b = sel.length === 1 ? bounds(worldMesh(o as SceneObject)) : worldBounds(sel);
      return size(b).map((v) => v / k) as Vec3;
    }
    if (sel.length === 1) return o.position.map((v) => v / k) as Vec3;
    const b = worldBounds(sel);
    return [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2 / k) as Vec3;
  }

  private renderTbarValues(): void {
    const v = this.tbarValues();
    if (!v) return;
    this.tbar.querySelectorAll<HTMLInputElement>('input[data-axis]').forEach((input) => {
      if (document.activeElement !== input) input.value = fmtNum(v[+input.dataset.axis!]);
    });
  }

  private applyTbarValue(axis: number, raw: string): void {
    const value = parseFloat(raw.replace(',', '.'));
    const cur = this.tbarValues();
    if (!Number.isFinite(value) || !cur) return this.renderTbarValues();
    const k = UNITS[this.prefs.unit].mm;
    this.doc.checkpoint();
    for (const o of this.doc.selected) {
      if (this.gizmo === 'translate') {
        const pos = [...o.position] as Vec3;
        pos[axis] += (value - cur[axis]) * k;
        this.doc.update(o.id, { position: pos });
      } else if (this.gizmo === 'rotate') {
        const rot = [...o.rotation] as Vec3;
        rot[axis] = value;
        this.doc.update(o.id, { rotation: rot });
      } else {
        if (value <= 0 || cur[axis] <= 0) continue;
        const f = value / cur[axis];
        const sc = this.lockScale ? o.scale.map((s) => s * f) as Vec3 : o.scale.map((s, i) => (i === axis ? s * f : s)) as Vec3;
        this.doc.update(o.id, { scale: sc });
      }
    }
    this.doc.emit();
  }

  // --- notifications -------------------------------------------------------------------------------

  toast(message: string, kind: 'info' | 'warn' | 'ok' = 'info', action?: { label: string; run: () => void }, sticky = false): HTMLElement {
    const el = h('div', { class: `toast ${kind}`, role: 'status' }, h('span', {}, message));
    if (action) el.append(h('button', { onclick: () => { el.remove(); action.run(); } }, action.label));
    el.append(h('button', { class: 'x', title: 'Fermer', html: icon('close', 16), onclick: () => el.remove() }));
    this.toasts.append(el);
    if (!sticky) setTimeout(() => el.remove(), 6000);
    return el;
  }

  private updateInvalidToast(): void {
    const bad = this.doc.objects.filter((o) => !isValid(o)).length;
    if (bad && !this.mode) {
      if (!this.invalidToast || !this.invalidToast.isConnected) {
        this.invalidToast = this.toast(
          bad > 1 ? `${bad} objets ne sont pas valides (trous, faces inversées, auto-intersections…).` : 'Un objet n’est pas valide (trous, faces inversées, auto-intersections…).',
          'warn', { label: 'Cliquez ici pour réparer', run: () => this.repair() }, true,
        );
      }
    } else if (this.invalidToast) {
      this.invalidToast.remove();
      this.invalidToast = null;
    }
  }

  async busy<T>(fn: () => Promise<T>): Promise<T | undefined> {
    this.busyEl.classList.remove('hidden');
    await new Promise((r) => setTimeout(r, 30));
    try {
      return await fn();
    } catch (e) {
      console.error(e);
      this.toast(e instanceof Error ? e.message : String(e), 'warn');
      return undefined;
    } finally {
      this.busyEl.classList.add('hidden');
    }
  }

  // --- modes -----------------------------------------------------------------------------------------

  enterMode(spec: ModeSpec): void {
    if (this.mode) this.exitMode();
    const bar = h('div', { class: 'modebar' });
    const ctx: ModeContext = {
      app: this,
      bar,
      selection: this.doc.selected,
      world: this.doc.selected.map((o) => worldMesh(o)),
    };
    const done = async (apply: boolean) => {
      if (apply) {
        const ok = await this.busy(() => this.mode!.spec.apply(ctx));
        if (ok === undefined) return; // error already reported, stay in mode
        // The strokes made in a history tool become one undo step.
        if (this.mode?.spec.history) this.doc.squash(this.mode.depth);
      }
      this.exitMode();
    };
    bar.append(
      h('button', { class: 'act', html: `${icon('back', 22)}<span>Annuler</span>`, onclick: () => done(false) }),
      ...(spec.noOk ? [] : [h('button', { class: 'act', html: `${icon('ok', 22)}<span>${spec.okLabel}</span>`, onclick: () => done(true) })]),
      h('span', { class: 'vsep' }),
    );
    this.mode = { spec, depth: this.doc.undoDepth, ctx };
    this.mode.cleanup = spec.build(ctx) ?? undefined;
    if (spec.history || ctx.history) {
      // Annuler / Refaire inside the tool, on the right of the bar (3D Builder).
      bar.append(h('span', { style: 'flex:1' }),
        h('button', { class: 'act', title: 'Annuler (Ctrl+Z)', html: `${icon('undo', 22)}<span data-en="Undo">Annuler</span>`, onclick: () => this.modeUndo() }),
        h('button', { class: 'act', title: 'Refaire (Ctrl+Y)', html: `${icon('redo', 22)}<span data-en="Redo">Refaire</span>`, onclick: () => this.modeRedo() }));
    }
    this.top.replaceChildren(bar);
    // 3D Builder's help tip at the bottom right while some tools are open.
    if (spec.tip) {
      const tip = h('div', { class: 'mode-tip', role: 'note' }, h('span', { class: 'mode-tip-i' }, 'i'), h('span', {}, spec.tip));
      this.viewEl.append(tip);
      const prevCleanup = this.mode.cleanup;
      this.mode.cleanup = () => { tip.remove(); prevCleanup?.(); };
    }
    // Tools working on the selection show the other objects translucent, as 3D Builder.
    if (ctx.selection.length && spec !== MODES.measure && spec !== MODES.print3d && spec !== MODES.custom && spec !== MODES.hollow) this.view.ghostOutside(ctx.selection.map((o) => o.id));
    this.refresh();
  }

  /** Undo / redo of the steps made inside a history tool (never past its start). */
  modeUndo(): void {
    if (this.mode?.ctx.history) this.mode.ctx.history.undo();
    else if (this.mode && this.doc.undoDepth > this.mode.depth + 1) this.doc.undo();
  }

  modeRedo(): void {
    if (this.mode?.ctx.history) this.mode.ctx.history.redo();
    else if (this.mode) this.doc.redo();
  }

  /** Cancels a history tool: back to the state before it started. */
  rollbackMode(): void {
    if (this.mode) this.doc.rollback(this.mode.depth);
  }

  exitMode(): void {
    if (!this.mode) return;
    this.mode.cleanup?.();
    this.mode = null;
    this.view.ghostOutside(null);
    this.view.clearOverlay();
    this.view.setHidden([]);
    this.refresh();
  }

  /** Replaces objects by new world meshes (one result per entry), keeping names and colours. */
  replaceObjects(olds: SceneObject[], results: MeshData[][], opts: { dropOnPlate?: boolean; faceColors?: (Uint32Array | undefined)[][] } = {}): void {
    this.doc.checkpoint();
    const ids: number[] = [];
    olds.forEach((o, i) => {
      for (const [k, m] of results[i].entries()) {
        if (!m.indices.length) continue;
        const faceColors = opts.faceColors ? opts.faceColors[i]?.[k] : inheritColors(o, m);
        const added = this.doc.addWorldMesh(m, { name: k ? `${o.name} (${k + 1})` : o.name, color: o.color, dropOnPlate: opts.dropOnPlate, faceColors, texture: inheritTexture(o, m) });
        ids.push(added.id);
      }
    });
    this.doc.remove(olds.map((o) => o.id));
    this.doc.select(ids);
  }

  // --- commands: files -------------------------------------------------------------------------------

  newScene(): void {
    if (this.doc.dirty && this.doc.objects.length && !confirm('Abandonner les modifications de la scène actuelle ?')) return;
    this.doc.reset();
    this.dropBackup();
    this.home.classList.add('hidden');
    this.view.frame(null);
  }

  async openFiles(replace = false): Promise<void> {
    const files = await pickFiles(IMPORT_ACCEPT);
    if (files.length) await this.importFiles(files, replace);
  }

  async importFiles(all: File[], replace = false): Promise<void> {
    const isImage = (f: File) => /\.(png|jpe?g|bmp|gif|webp)$/i.test(f.name);
    for (const img of all.filter(isImage)) {
      void imageThumb(img).then((t) => addRecent(img, t)).then(() => this.buildHome());
      await this.importImage(img);
    }
    const files = all.filter((f) => !isImage(f));
    if (!files.length) return;
    await this.busy(async () => {
      if (replace) {
        this.doc.reset(files[0].name.replace(/\.[^.]+$/, ''));
        // The opened 3MF's metadata becomes the scene's ("À propos de ce modèle").
        if (/\.3mf$/i.test(files[0].name)) {
          try { Object.assign(this.doc.info, read3MFInfo(new Uint8Array(await files[0].arrayBuffer()))); } catch { /* unreadable metadata */ }
        }
      }
      this.doc.checkpoint();
      const added: number[] = [];
      // New objects line up along +X, to the right of what is already on the plate.
      let cursor: number | null = this.doc.objects.length ? worldBounds(this.doc.objects).max[0] + 10 : null;
      for (const f of files) {
        const first = added.length;
        for (const item of await importFile(f)) {
          const opts = { name: item.name, color: item.color, faceColors: item.faceColors, texture: item.texture };
          const o = item.local ? this.doc.addTransformedMesh(item.local.mesh, item.local.transform, opts) : this.doc.addWorldMesh(item.mesh, { ...opts, dropOnPlate: true });
          if (item.local) {
            // Rest on the plate, keeping the rotation and scale read from the file.
            const zmin = bounds(worldMesh(o)).min[2];
            this.doc.update(o.id, { position: [o.position[0], o.position[1], o.position[2] - zmin] });
          }
          const width = size(bounds(o.mesh))[0] * o.scale[0];
          const x = cursor === null ? 0 : cursor + width / 2;
          this.doc.update(o.id, { position: [x, 0, o.position[2]] });
          cursor = x + width / 2 + 10;
          added.push(o.id);
        }
        const o = this.doc.get(added[first]);
        void addRecent(f, o ? this.view.thumbnail(o) : undefined).then(() => this.buildHome());
      }
      this.home.classList.add('hidden');
      this.doc.select(added);
      this.frameAll();
      const bad = this.doc.objects.filter((o) => added.includes(o.id) && !isValid(o)).length;
      if (!bad) this.toast(`${added.length} objet(s) chargé(s).`, 'ok');
      void this.checkSelfIntersections(added);
      // Unit-less formats: a model a few millimetres (or metres) wide was probably not in mm.
      const unitless = files.some((f) => /\.(stl|obj|ply|wrl)$/i.test(f.name));
      const extent = added.length ? Math.max(...size(worldBounds(added.map((id) => this.doc.get(id)!)))) : 0;
      if (unitless && (extent < 3 || extent > 2000)) {
        this.toast(`Le modèle mesure ${fmtNum(extent)} mm : le fichier n’était peut-être pas en millimètres.`, 'warn',
          { label: 'Choisir l’unité du fichier', run: () => this.fileUnitDialog(added) }, true);
      }
    });
  }

  /** Rescales freshly imported objects from the unit their file actually used. */
  private fileUnitDialog(ids: number[]): void {
    let unit: Unit = 'inch';
    const box = h('fieldset', {}, h('legend', {}, 'Unité du fichier'),
      ...Object.entries(UNITS).map(([id, u]) => h('label', {}, h('input', { type: 'radio', name: 'fileunit', value: id, checked: id === unit, onchange: () => (unit = id as Unit) }), u.label)));
    this.dialog('Unité du fichier', [box], [{
      label: 'Convertir', primary: true, run: () => {
        const k = UNITS[unit].mm;
        this.doc.checkpoint();
        for (const id of ids) {
          const o = this.doc.get(id);
          if (!o) continue;
          const b = bounds(worldMesh(o));
          const scale = o.scale.map((s) => s * k) as Vec3;
          // Keep it standing on the plate where it was.
          this.doc.update(id, { scale, position: [o.position[0], o.position[1], o.position[2] + (o.position[2] - b.min[2]) * (k - 1)] });
        }
        this.doc.emit();
        this.frameAll();
      },
    }]);
  }

  /**
   * Image → object, with 3D Builder's four methods (contour, height map, edges, stamp; see
   * geometry/image-insert.ts), set in a tool bar with a live preview as in 3D Builder.
   */
  async importImage(file: File): Promise<void> {
    const bitmap = await createImageBitmap(file);
    const px = imageData(bitmap, 1024);
    this.home.classList.add('hidden');
    this.enterMode(imageInsertMode(px, file.name.replace(/\.[^.]+$/, '')));
  }

  /** Background search for triangles crossing each other (too costly to run on every edit). */
  private async checkSelfIntersections(ids: number[]): Promise<void> {
    let found = false;
    for (const id of ids) {
      const o = this.doc.get(id);
      if (!o || o.selfIntersections !== undefined) continue;
      const mesh = o.mesh;
      await new Promise((r) => setTimeout(r, 0)); // let the UI breathe between objects
      const n = await selfIntersectionsAsync(mesh);
      const cur = this.doc.get(id);
      if (cur && cur.mesh === mesh) {
        this.doc.update(id, { selfIntersections: n });
        if (n) found = true;
      }
    }
    if (found) {
      this.invalidToast?.remove();
      this.invalidToast = null;
    }
    this.doc.emit();
  }

  async save(format?: ExportFormat): Promise<void> {
    const fmt = format ?? '3mf';
    // 3MF as 3D Builder: each mesh in its own frame, its move / rotation / scale in the build item,
    // and a thumbnail of the view.
    const items = this.sceneItems(this.doc.selected.length && format ? this.doc.selected : this.doc.objects);
    if (!items.length) return;
    await this.busy(async () => {
      const thumb = fmt === '3mf' ? dataUrlBytes(this.view.snapshotPNG()) : undefined;
      const blob = await exportScene(items, fmt, this.doc.name, this.doc.info, thumb);
      download(blob, `${this.doc.name}.${fmt}`);
      this.doc.dirty = false;
      this.refresh();
      if (fmt === '3mf' && !(this.doc.selected.length && format)) this.dropBackup();
    });
  }

  saveAs(): void {
    let fmt: ExportFormat = '3mf';
    const name = h('input', { type: 'text', value: this.doc.name, style: 'width:100%;padding:6px' });
    this.dialog('Enregistrer sous', [
      h('fieldset', {}, h('legend', {}, 'Nom'), name),
      h('fieldset', {}, h('legend', {}, 'Format'),
        ...EXPORT_FORMATS.map((f) => h('label', {}, h('input', { type: 'radio', name: 'fmt', value: f.id, checked: f.id === '3mf', onchange: () => (fmt = f.id) }), f.label))),
    ], [{ label: 'Enregistrer', primary: true, run: () => { this.doc.name = name.value.trim() || this.doc.name; void this.save(fmt); } }]);
  }

  // --- commands: objects -------------------------------------------------------------------------------

  addPrimitive(kind: PrimitiveKind): void {
    this.doc.checkpoint();
    const label = PRIMITIVES.find((p) => p.kind === kind)!.label;
    const o = this.doc.addWorldMesh(makePrimitive(kind), { dropOnPlate: true, color: PRIMITIVE_COLORS[kind], name: `${currentLang() === 'en' ? toEnglish(label) : label}${this.doc.objects.length + 1}` });
    this.home.classList.add('hidden');
    this.doc.select([o.id]);
  }

  /** Prints the current 3D view with the scene's name and object sizes (browser print dialog). */
  printPaper(): void {
    const img = this.view.snapshotPNG();
    const k = UNITS[this.prefs.unit];
    const rows = this.doc.objects.map((o) => {
      const s = size(bounds(worldMesh(o))).map((v) => fmtNum(v / k.mm)).join(' × ');
      return `<tr><td>${o.name.replace(/</g, '&lt;')}</td><td>${s} ${k.short}</td></tr>`;
    }).join('');
    const frame = h('iframe', { style: 'position:fixed;width:0;height:0;border:0' });
    document.body.append(frame);
    const d = frame.contentDocument!;
    d.open();
    d.write(`<!doctype html><html lang="${currentLang()}"><head><meta charset="utf-8"><title>${this.doc.name}</title>
<style>body{font-family:"Segoe UI",system-ui,sans-serif;margin:24px}img{max-width:100%;border:1px solid #ccc}
table{border-collapse:collapse;margin-top:16px}td{padding:4px 12px;border-bottom:1px solid #ddd}</style></head>
<body><h1>${this.doc.name.replace(/</g, '&lt;')}</h1><img src="${img}" alt=""><table>${rows}</table></body></html>`);
    d.close();
    frame.contentWindow!.onafterprint = () => frame.remove();
    setTimeout(() => frame.contentWindow!.print(), 200);
  }

  customShapeDialog(): void {
    // Live preview in the scene, as in 3D Builder (tool mode with the shape's settings).
    this.home.classList.add('hidden');
    this.enterMode(MODES.custom);
  }

  /**
   * As 3D Builder, a duplicate goes to the left of the selection, 5 mm away (x − (width + 5) for
   * the same width).
   */
  duplicate(): void {
    const sel = this.doc.selected;
    if (!sel.length) return;
    this.doc.checkpoint();
    const anchor = worldBounds(sel);
    const ids = sel.map((o) => this.doc.addWorldMesh(worldMesh(o), { name: `${o.name} copie`, color: o.color, faceColors: o.faceColors, texture: o.texture }).id);
    this.placeLeftOf(ids, anchor.min[0]);
    this.doc.select(ids);
  }

  /** Moves objects together along X so that their box ends 5 mm before x = edge. */
  private placeLeftOf(ids: number[], edge: number): void {
    const objs = ids.map((id) => this.doc.get(id)!);
    const dx = edge - 5 - worldBounds(objs).max[0];
    for (const o of objs) this.doc.update(o.id, { position: [o.position[0] + dx, o.position[1], o.position[2]] });
  }

  copy(): void {
    this.clipboard = this.doc.selected.map((o) => ({ mesh: worldMesh(o), color: o.color, name: o.name, faceColors: o.faceColors, texture: o.texture }));
    this.toast('Objet copié dans le Presse-papiers.');
    this.refresh();
  }

  cut(): void {
    this.copy();
    this.deleteSelection();
  }

  /** Paste as 3D Builder: to the left of the current selection (or of where the copy was), 5 mm away. */
  paste(): void {
    if (!this.clipboard.length) return;
    const sel = this.doc.selected;
    this.doc.checkpoint();
    const ids = this.clipboard.map((c) => this.doc.addWorldMesh(c.mesh, { name: c.name, color: c.color, faceColors: c.faceColors, texture: c.texture }).id);
    const anchor = sel.length ? worldBounds(sel) : worldBounds(ids.map((id) => this.doc.get(id)!));
    this.placeLeftOf(ids, anchor.min[0]);
    this.doc.select(ids);
  }

  deleteSelection(): void {
    if (!this.doc.selected.length) return;
    this.doc.checkpoint();
    this.doc.remove([...this.doc.selection]);
    this.doc.emit();
  }

  dropToPlate(): void {
    this.doc.checkpoint();
    for (const o of this.doc.selected) {
      const b = bounds(worldMesh(o));
      this.doc.update(o.id, { position: [o.position[0], o.position[1], o.position[2] - b.min[2]] });
    }
    this.doc.emit();
  }

  /** Rotates each selected object onto the largest flat face of its convex hull, on the plate. */
  /** Lay flat as 3D Builder's Settle: each object comes to rest under gravity (geometry/settle.ts). */
  async layFlat(): Promise<void> {
    const sel = this.doc.selected;
    if (!sel.length) return;
    await this.busy(async () => {
      const moves: Matrix4[] = [];
      for (const o of sel) {
        const w = worldMesh(o);
        const hull = await csg.hullPoints(w);
        const { R, pivot: c } = settleRotation(w, hull);
        const rot = new Matrix4().set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1);
        const m = new Matrix4().makeTranslation(c[0], c[1], c[2]).multiply(rot).multiply(new Matrix4().makeTranslation(-c[0], -c[1], -c[2]));
        // Then down onto the plate.
        const zmin = Math.min(...hull.map((p) => new Vector3(...p).applyMatrix4(m).z));
        moves.push(new Matrix4().makeTranslation(0, 0, -zmin).multiply(m));
      }
      // The settling goes into the objects' rotation, as in 3D Builder.
      this.doc.checkpoint();
      sel.forEach((o, i) => this.doc.update(o.id, movedTransform(o, moves[i])));
      this.doc.emit();
    });
  }


  /**
   * Mirror as 3D Builder: in place, about the plane through the centre of the selection's box,
   * along a world axis; triangles are re-wound (corners 0 and 1 swapped) so the surface stays
   * outward, and colours and textures follow. 3D Builder only offers X (its Y and Z texts are never
   * used); 3D Assembler keeps the three axes.
   */
  mirror(axis: 0 | 1 | 2): void {
    const sel = this.doc.selected;
    if (!sel.length) return;
    this.doc.checkpoint();
    const box = worldBounds(sel);
    const mid = (box.min[axis] + box.max[axis]) / 2;
    for (const o of sel) {
      const w = worldMesh(o);
      const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      m[axis * 5] = -1;
      m[12 + axis] = 2 * mid;
      const moved = transformed(w, m);
      const idx = new Uint32Array(moved.indices);
      for (let i = 0; i < idx.length; i += 3) [idx[i], idx[i + 1]] = [idx[i + 1], idx[i]];
      let texture = o.texture;
      if (texture) {
        const uv = new Float32Array(texture.uv);
        for (let f = 0; f < uv.length / 6; f++) {
          [uv[f * 6], uv[f * 6 + 2]] = [uv[f * 6 + 2], uv[f * 6]];
          [uv[f * 6 + 1], uv[f * 6 + 3]] = [uv[f * 6 + 3], uv[f * 6 + 1]];
        }
        texture = { ...texture, uv };
      }
      const added = this.doc.addWorldMesh({ positions: moved.positions, indices: idx }, { name: o.name, color: o.color, faceColors: o.faceColors, texture });
      this.doc.remove([o.id]);
      this.doc.selection.add(added.id);
    }
    this.doc.emit();
  }


  group(): void {
    const sel = this.doc.selected;
    if (sel.length < 2) return;
    this.doc.checkpoint();
    // Each part keeps its colour, as in 3D Builder.
    const g = this.doc.addWorldMesh(merged(sel.map(worldMesh)), { name: 'Groupe', color: sel[0].color, faceColors: partColors(sel), texture: partTextures(sel) });
    this.doc.remove(sel.map((o) => o.id));
    this.doc.select([g.id]);
  }

  /** Splits the selected object into its separate parts (greyed out for a one-part object, as in 3D Builder). */
  ungroup(): void {
    const [o] = this.doc.selected;
    if (!o) return;
    const w = worldMesh(o);
    const label = shells(w.indices, w.positions.length / 3);
    let count = 0;
    for (let i = 0; i < label.length; i++) count = Math.max(count, label[i] + 1);
    if (count < 2) return void this.toast('Cet objet ne contient qu’une seule partie.');
    const parts: MeshData[] = [];
    for (let s = 0; s < count; s++) {
      const idx: number[] = [];
      for (let f = 0; f < label.length; f++) if (label[f] === s) idx.push(w.indices[f * 3], w.indices[f * 3 + 1], w.indices[f * 3 + 2]);
      parts.push({ positions: w.positions, indices: new Uint32Array(idx) });
    }
    this.replaceObjects([o], [parts.map(compactMesh)]);
  }

  /**
   * Booleans as in 3D Builder (booleanPair):
   * - Merge: the selected objects are merged pair by pair; a pair is kept merged only if it gives
   *   one piece, so separate objects stay separate (grouped).
   * - Subtract: the one selected object is the tool, removed from every other object it overlaps;
   *   the tool disappears, each target is replaced by its pieces.
   * - Intersect: exactly two objects, replaced by their common part.
   * Every piece keeps the colours of the operand it comes from.
   */
  async boolean(op: 'union' | 'intersect' | 'subtract'): Promise<void> {
    const sel = this.doc.selected;
    if (!sel.length) return;
    if (op === 'subtract' && sel.length !== 1) return void this.toast('Sélectionnez uniquement l’objet à soustraire : il sera retiré de tous les objets qu’il touche.', 'warn');
    if (op === 'intersect' && sel.length !== 2) return void this.toast('Sélectionnez exactement deux objets.', 'warn');
    await this.busy(async () => {
      const colorsOf = (objs: SceneObject[], m: MeshData) => {
        const multi = objs.some((x) => x.faceColors || x.color !== objs[0].color);
        return multi ? transferFaceColors(merged(objs.map(worldMesh)), partColors(objs), m) : undefined;
      };
      const textureOf = (objs: SceneObject[], m: MeshData) => {
        const tex = partTextures(objs);
        if (!tex) return undefined;
        const src = merged(objs.map(worldMesh));
        return transferTexture(src, tex, m, nearestFaces(src, m));
      };
      if (op === 'union') {
        const list: (MeshData | null)[] = sel.map(worldMesh);
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
          if (!list[i] || !list[j]) continue;
          const u = await csg.booleanPair(list[i]!, list[j]!, 'union');
          if (u.indices.length && analyze(u).shells === 1) { list[j] = u; list[i] = null; break; }
        }
        const parts = list.filter((m): m is MeshData => !!m);
        const result = parts.length === 1 ? parts[0] : merged(parts);
        this.doc.checkpoint();
        const o = this.doc.addWorldMesh(result, { name: parts.length === 1 ? sel[0].name : 'Groupe', color: sel[0].color, faceColors: colorsOf(sel, result), texture: textureOf(sel, result) });
        this.doc.remove(sel.map((x) => x.id));
        this.doc.select([o.id]);
        return;
      }
      if (op === 'intersect') {
        const result = await csg.booleanPair(worldMesh(sel[0]), worldMesh(sel[1]), 'intersect');
        this.doc.checkpoint();
        this.doc.remove(sel.map((x) => x.id));
        if (result.indices.length < 3) { this.toast('Les deux objets n’ont aucune partie commune.', 'warn'); return; }
        const ids = splitShells(result).map((p) => this.doc.addWorldMesh(p, { name: sel[0].name, color: sel[0].color, faceColors: colorsOf(sel, p), texture: textureOf(sel, p) }).id);
        this.doc.select(ids);
        return;
      }
      // Subtract: the tool against every object whose box overlaps its box.
      const tool = sel[0];
      const tw = worldMesh(tool), tb = bounds(tw);
      const overlaps = (o: SceneObject) => {
        const b = bounds(worldMesh(o));
        return [0, 1, 2].every((k) => b.min[k] < tb.max[k] && tb.min[k] < b.max[k]);
      };
      const targets = this.doc.objects.filter((o) => o.id !== tool.id && overlaps(o));
      if (!targets.length) return void this.toast('L’objet sélectionné ne touche aucun autre objet.', 'warn');
      const results: MeshData[][] = [];
      for (const t of targets) {
        const r = await csg.booleanPair(worldMesh(t), tw, 'subtract');
        results.push(r.indices.length < 12 ? [] : splitShells(r));
      }
      this.doc.checkpoint();
      const ids: number[] = [];
      targets.forEach((t, i) => {
        for (const p of results[i]) ids.push(this.doc.addWorldMesh(p, { name: t.name, color: t.color, faceColors: colorsOf([t, tool], p), texture: textureOf([t, tool], p) }).id);
      });
      this.doc.remove([tool.id, ...targets.map((t) => t.id)]);
      this.doc.select(ids);
    });
  }

  async repair(): Promise<void> {
    const targets = this.doc.selected.length ? this.doc.selected : this.doc.objects.filter((o) => !isValid(o));
    const list = targets.length ? targets : this.doc.objects;
    if (!list.length) return;
    await this.busy(async () => {
      this.doc.checkpoint();
      const logs: SolidRepairLog[] = [];
      let stillBad = 0;
      for (const o of list) {
        const { mesh, log } = await repairAsync(o.mesh);
        logs.push(log);
        // As 3D Builder, the repair keeps the face colours.
        // As 3D Builder, the repair keeps the face colours and textures.
        const near = o.faceColors || o.texture ? nearestFaces(o.mesh, mesh) : null;
        const faceColors = o.faceColors && near ? Uint32Array.from(near, (g) => o.faceColors![g]) : undefined;
        const texture = o.texture && near ? transferTexture(o.mesh, o.texture, mesh, near) : undefined;
        this.doc.update(o.id, { mesh, faceColors, texture, selfIntersections: log.selfIntersectionsLeft });
        if (!isValid(this.doc.get(o.id)!)) stillBad++;
      }
      this.doc.emit();
      const sum = (k: keyof SolidRepairLog) => logs.reduce((a, l) => a + l[k], 0);
      const parts = [
        sum('holesClosed') && `${sum('holesClosed')} trou(s) bouché(s)`,
        sum('flipped') && `${sum('flipped')} face(s) réorientée(s)`,
        sum('stitched') && `${sum('stitched')} sommet(s) cousu(s)`,
        sum('nonManifoldSplit') && `${sum('nonManifoldSplit')} arête(s) non manifold corrigée(s)`,
        sum('degenerateRemoved') + sum('duplicatesRemoved') && `${sum('degenerateRemoved') + sum('duplicatesRemoved')} face(s) parasite(s) supprimée(s)`,
        sum('shellsRemoved') && `${sum('shellsRemoved')} fragment(s) supprimé(s)`,
        sum('shellsInverted') && `${sum('shellsInverted')} coque(s) retournée(s)`,
        sum('shellsMerged') && `${sum('shellsMerged')} pièce(s) imbriquée(s) fusionnée(s)`,
        sum('selfIntersections') && `${sum('selfIntersections')} auto-intersection(s) résolue(s)`,
      ].filter(Boolean);
      if (sum('selfIntersectionsLeft')) {
        this.toast(`${sum('selfIntersectionsLeft')} auto-intersection(s) n’ont pas pu être résolues : le modèle a été conservé tel quel sur ce point.`, 'warn');
      }
      if (stillBad) this.toast(`Réparation partielle : ${stillBad} objet(s) restent non valides. ${parts.join(', ')}`, 'warn');
      else this.toast(parts.length ? `Objet réparé : ${parts.join(', ')}.` : 'Aucun défaut détecté.', 'ok');
    });
  }

  showReport(): void {
    const [o] = this.doc.selected;
    if (!o) return;
    const r = o.report;
    const w = worldMesh(o);
    const sz = size(bounds(w));
    const k = UNITS[this.prefs.unit];
    const row = (a: string, b: string | number, bad = false) => h('div', { class: `row${bad ? ' bad' : ''}` }, h('span', {}, a), h('span', {}, String(b)));
    this.dialog(`À propos de « ${o.name} »`, [
      row('Dimensions', sz.map((v) => fmtNum(v / k.mm)).join(' × ') + ` ${k.short}`),
      row('Volume', `${fmtNum(Math.abs(r.volume) / 1000)} cm³`),
      row('Surface', `${fmtNum(surfaceArea(w) / 100)} cm²`),
      row('Triangles', r.triangles),
      row('Sommets', r.vertices),
      row('Coques', r.shells),
      row('Bords ouverts', r.openEdges, r.openEdges > 0),
      row('Trous', r.holes, r.holes > 0),
      row('Arêtes non manifold', r.nonManifoldEdges, r.nonManifoldEdges > 0),
      row('Faces mal orientées', r.flippedEdges, r.flippedEdges > 0),
      row('Faces dégénérées', r.degenerateFaces, r.degenerateFaces > 0),
      row('Faces en double', r.duplicateFaces, r.duplicateFaces > 0),
      row('Auto-intersections', o.selfIntersections === undefined ? 'non vérifié' : o.selfIntersections, !!o.selfIntersections),
      row('État', isValid(o) ? 'Valide' : 'À réparer', !isValid(o)),
    ], isValid(o) ? [] : [{ label: 'Réparer', primary: true, run: () => this.repair() }]);
  }

  /** Display unit chosen in the settings. */
  unit(): (typeof UNITS)[Unit] {
    return UNITS[this.prefs.unit];
  }

  /** Print bed size from the settings. */
  bed(): Bed {
    return this.prefs.bed ?? DEFAULT_BED;
  }

  frameAll(): void {
    const objs = this.doc.selected.length ? this.doc.selected : this.doc.objects;
    this.view.frame(objs.length ? worldBounds(objs) : null);
  }



  // --- flyouts and dialogs -------------------------------------------------------------------------------

  private flyout(anchor: Element | null, entries: { label: string; ico?: string; on?: boolean; run: () => void }[]): void {
    document.querySelector('.flyout')?.remove();
    const r = (anchor ?? this.ribbon).getBoundingClientRect();
    const el = h('div', { class: 'flyout', style: `left:${r.left}px;top:${r.bottom}px;position:fixed` },
      ...entries.map((e) => h('button', { class: e.on ? 'on' : '', onclick: () => { el.remove(); e.run(); }, html: `${e.ico ? icon(e.ico) : ''}<span>${e.label}</span>` })));
    document.body.append(el);
    setTimeout(() => document.addEventListener('pointerdown', (ev) => { if (!el.contains(ev.target as Node)) el.remove(); }, { once: true }));
  }

  private mirrorFlyout(): void {
    const anchor = this.ribbon.querySelector<HTMLElement>('.rb[data-rb="Inverser"]');
    this.flyout(anchor, [
      { label: 'Inverser en X', run: () => this.mirror(0) },
      { label: 'Inverser en Y', run: () => this.mirror(1) },
      { label: 'Inverser en Z', run: () => this.mirror(2) },
    ]);
  }

  private gridFlyout(): void {
    const anchor = this.ribbon.querySelector<HTMLElement>('.rb[data-rb="Grille"]');
    const g = this.view.settings.grid;
    const set = (grid: ViewSettings['grid']) => { this.view.applySettings({ grid }); this.refresh(); };
    this.flyout(anchor, [
      { label: 'Damier', on: g === 'checker', run: () => set('checker') },
      { label: 'Lignes', on: g === 'lines', run: () => set('lines') },
      { label: 'Aucune grille', on: g === 'none', run: () => set('none') },
    ]);
  }

  dialog(title: string, body: Node[], buttons: { label: string; primary?: boolean; run: () => void }[] = []): void {
    const close = () => el.remove();
    const el = h('div', { class: 'dialog', onclick: (e: MouseEvent) => { if (e.target === el) close(); } },
      h('div', { class: 'box', role: 'dialog', 'aria-label': title },
        h('h2', {}, title),
        ...body,
        h('div', { class: 'btns' },
          ...buttons.map((b) => h('button', { class: b.primary ? 'primary' : '', onclick: () => { close(); b.run(); } }, b.label)),
          h('button', { onclick: close }, buttons.length ? 'Annuler' : 'Fermer'),
        )));
    document.body.append(el);
  }

  /**
   * 3D Builder's Paramètres: a panel next to the menu, each change applied at once: Unités (µm, mm /
   * cm, po / pi, m), Mode Couleur de l'application, Alignement and Collision switches, the version
   * and two Microsoft links (greyed out here). 3D Assembler adds the print bed size at the bottom (3D
   * Builder takes it from the printer). À propos: link under the version (also Ctrl+B).
   */
  private showSettings(): void {
    this.openDrawer();
    document.querySelector('.settings-panel')?.remove();
    const save = () => {
      try { localStorage.setItem('3dbr.prefs', JSON.stringify(this.prefs)); } catch { /* storage unavailable */ }
      this.applyPrefs();
      this.refresh();
    };
    const radio = (name: string, value: string, label: string, checked: boolean, run: () => void) =>
      h('label', { class: 'set-radio' }, h('input', { type: 'radio', name, value, checked, onchange: run }), label);
    const unitShort: Record<Unit, string> = { micron: 'µm', mm: 'mm', cm: 'cm', inch: 'po', foot: 'pi', m: 'm' };
    const units = (['micron', 'mm', 'cm', 'inch', 'foot', 'm'] as Unit[]).map((u) => radio('set-unit', u, unitShort[u], this.prefs.unit === u, () => { this.prefs.unit = u; save(); }));
    const themes = ([['system', 'Utiliser le paramètre système'], ['light', 'Clair'], ['dark', 'Foncé']] as const)
      .map(([id, label]) => radio('set-theme', id, label, this.prefs.theme === id, () => { this.prefs.theme = id; save(); }));
    // Language names stay in their own language.
    const langs = ([['auto', 'Langue du système'], ['en', 'English'], ['fr', 'Français']] as const)
      .map(([id, label]) => radio('set-lang', id, label, this.prefs.lang === id, () => { this.prefs.lang = id; save(); }));
    const sw = (label: string, on: boolean, run: (v: boolean) => void) => {
      const state = h('span', {}, on ? 'Activé' : 'Désactivé');
      const pill = h('button', { class: `switch${on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(on), 'aria-label': label });
      pill.addEventListener('click', () => { on = !on; pill.classList.toggle('on', on); pill.setAttribute('aria-checked', String(on)); state.textContent = on ? 'Activé' : 'Désactivé'; run(on); });
      return h('div', { class: 'set-block' }, h('div', { class: 'set-title' }, label), h('div', { class: 'set-switch' }, pill, state));
    };
    const bedIn = (k: keyof Bed, label: string) => {
      const input = h('input', { type: 'number', min: '10', step: '1', value: String(this.prefs.bed[k]), 'aria-label': label, style: 'width:64px' }) as HTMLInputElement;
      input.addEventListener('change', () => { const v = parseFloat(input.value); if (v > 0) { this.prefs.bed[k] = v; save(); } });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      return h('label', { class: 'set-bed' }, label, input, 'mm');
    };
    const panel = h('div', { class: 'settings-panel', role: 'dialog', 'aria-label': 'Paramètres' },
      h('div', { class: 'set-block' }, h('div', { class: 'set-title' }, 'Unités'), h('div', { class: 'set-units' }, ...units)),
      h('div', { class: 'set-block' }, h('div', { class: 'set-title' }, 'Langue'), ...langs),
      h('div', { class: 'set-block' }, h('div', { class: 'set-title' }, 'Mode Couleur de l’application'), ...themes),
      sw('Alignement', this.prefs.align, (v) => { this.prefs.align = v; save(); }),
      sw('Collision', this.prefs.collision, (v) => { this.prefs.collision = v; save(); }),
      h('div', { class: 'set-block' }, h('div', {}, '3D Assembler 0.1'), h('div', {}, 'Logiciel libre (MIT)'),
        h('button', { class: 'set-link', onclick: () => this.showAbout() }, 'À propos')),
      h('div', { class: 'set-block' }, h('div', { class: 'set-title' }, 'Plateau d’impression'), bedIn('x', 'Largeur'), bedIn('y', 'Profondeur'), bedIn('z', 'Hauteur')));
    this.viewEl.append(panel);
    // The panel closes with the menu.
    const obs = new MutationObserver(() => { if (this.drawer.classList.contains('hidden')) { panel.remove(); obs.disconnect(); } });
    obs.observe(this.drawer, { attributes: true, attributeFilter: ['class'] });
  }

  private applyPrefs(): void {
    this.applyTheme();
    setLang(this.prefs.lang === 'auto' ? systemLang() : this.prefs.lang);
    this.view.dragOptions = { snap: this.prefs.align, collision: this.prefs.collision };
  }

  private applyTheme(): void {
    if (this.prefs.theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = this.prefs.theme;
  }

  private showHelp(): void {
    const li = (t: string) => h('li', { style: 'margin:6px 0' }, t);
    this.dialog('Prise en main', [h('ul', { style: 'padding-left:18px;line-height:1.5' },
      li('Insérer : ajoutez une forme ou importez un fichier (3MF, STL, OBJ, PLY, glTF, VRML). Vous pouvez aussi glisser-déposer des fichiers.'),
      li('Cliquez sur un objet pour le sélectionner, glissez-le pour le déplacer sur le plateau. Ctrl+clic pour une sélection multiple.'),
      li('Clic gauche dans le vide + glisser : tourner la vue. Clic droit : déplacer la vue. Molette : zoom.'),
      li('La barre du bas règle la position, la rotation et la taille au millimètre près.'),
      li('Un objet rouge n’est pas valide : utilisez Réparer avant de l’imprimer.'),
      li('Raccourcis : Ctrl+Z / Ctrl+Y, Suppr, Ctrl+C / X / V, Ctrl+D, Ctrl+A, Échap.'),
    )]);
  }

  private showAbout(): void {
    this.dialog('À propos', [
      h('p', {}, '3D Assembler 0.1 : un outil libre pour préparer des modèles 3D avant l’impression, inspiré de Microsoft 3D Builder et pensé pour le remplacer. Le projet d’un passionné d’impression 3D, attristé par la disparition de ce logiciel.'),
      h('p', {}, 'Logiciel libre et indépendant, sous licence MIT. Il n’est ni affilié à Microsoft Corporation, ni approuvé, ni soutenu par elle. Microsoft, Windows et 3D Builder sont des marques du groupe Microsoft. Le code est écrit de zéro et reproduit des comportements : il ne contient aucun code de Microsoft, ni copié ni traduit, ni aucun de ses modèles, textures ou images.'),
      h('p', {}, h('a', { href: 'https://learn.microsoft.com/fr-fr/windows/whats-new/deprecated-features', target: '_blank', rel: 'noopener' }, 'Annonce de la fin de 3D Builder par Microsoft')),
      h('p', { style: 'color:var(--text-dim)' }, 'Rendu three.js, opérations solides manifold-3d.'),
    ]);
  }

  // --- home and drawer -----------------------------------------------------------------------------------

  private buildHome(): void {
    const tile = (label: string, ico: string, fn: () => void, wide = false) =>
      h('button', { class: `tile${wide ? ' wide' : ''}`, onclick: fn, html: `${icon(ico, 40)}<span>${label}</span>` });
    this.home.replaceChildren(h('div', { class: 'wrap' },
      h('div', { class: 'logo', html: '<img src="/icons/icon-192.png" alt="" width="64" height="64"><span><b>3D</b> Assembler</span>' }),
      h('div', { class: 'tiles' },
        // As 3D Builder's home: En savoir plus (tall), Nouvelle scène, Ouvrir (wide), then recent files.
        Object.assign(tile('En savoir plus', 'help', () => this.showHelp()), { className: 'tile tall' }),
        tile('Nouvelle scène', 'newScene', () => this.newScene()),
        tile('Ouvrir', 'open', () => this.openFiles(true), true),
        Object.assign(tile('Cube', 'cube', () => this.addPrimitive('cube')), { className: 'tile starter' }),
        Object.assign(tile('Sphère', 'sphere', () => this.addPrimitive('sphere')), { className: 'tile starter' }),
      ),
    ));
    // As 3D Builder's home: the most recent files as tiles (opened as a new scene).
    void listRecent().then((list) => {
      const tiles = this.home.querySelector('.tiles');
      if (!tiles) return;
      tiles.querySelectorAll('.recent').forEach((t) => t.remove());
      // Cube and Sphère only stand in for the recent files until there are some.
      tiles.querySelectorAll<HTMLElement>('.starter').forEach((t) => (t.style.display = list.length ? 'none' : ''));
      for (const e of list.slice(0, 3)) {
        tiles.append(h('button', { class: 'tile recent', title: e.name, onclick: () => void this.openRecent(e.id, true) },
          e.thumb ? h('img', { src: e.thumb, alt: '' }) : h('span', { html: icon('open', 40) }),
          h('span', {}, e.name)));
      }
    });
  }

  private async openRecent(id: string, replace: boolean): Promise<void> {
    const f = await recentFile(id);
    if (f) await this.importFiles([f], replace);
    else this.toast('Ce fichier n’est plus disponible.', 'warn');
  }

  /**
   * 3D Builder's Ajouter panel: a flyout over the scene, title and close cross at the top; on the
   * left, Récent (thumbnails without names, two columns, six at first, « plus » for the rest), a
   * separator, then Charger l'objet, Charger l'image, Caméra. (3D Builder's online library, no
   * longer served, is left out.)
   */
  async addPanel(): Promise<void> {
    const list = await listRecent();
    const close = () => { el.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const item = (e: (typeof list)[number]) => h('button', { class: 'recent-item', title: e.name, 'aria-label': e.name, onclick: () => { close(); void this.openRecent(e.id, false); } },
      e.thumb ? h('img', { src: e.thumb, alt: '' }) : h('span', { html: icon('open', 32) }));
    const grid = h('div', { class: 'recent-grid' }, ...list.slice(0, 6).map(item));
    const more = list.length > 6 ? h('button', { class: 'add-more', onclick: () => { grid.replaceChildren(...list.map(item)); more!.remove(); } }, 'plus') : null;
    const action = (label: string, ico: string, run: () => void) =>
      h('button', { class: 'add-action', onclick: () => { close(); run(); }, html: `${icon(ico, 22)}<span>${label}</span>` });
    const el: HTMLElement = h('div', { class: 'add-flyout', role: 'dialog', 'aria-label': 'Ajouter' },
      h('div', { class: 'add-head' },
        h('h2', {}, 'Ajouter'),
        h('button', { class: 'add-close', title: 'Fermer', 'aria-label': 'Fermer', html: icon('close', 22), onclick: close })),
      h('div', { class: 'add-body' },
        h('div', { class: 'add-left' },
          h('h3', {}, 'Récent'),
          list.length ? grid : h('p', { class: 'add-empty' }, 'Aucun fichier récent.'),
          ...(more ? [more] : []),
          h('div', { class: 'add-sep' }),
          action('Charger l’objet', 'open', () => void this.openFiles()),
          action('Charger l’image', 'image', () => void pickFiles('.png,.jpg,.jpeg,.bmp,.gif,.webp').then((f) => (f.length ? this.importFiles(f) : undefined))),
          action('Caméra', 'camera', () => void this.cameraDialog()))));
    document.addEventListener('keydown', onKey, true);
    document.body.append(el);
  }

  /** 3D Builder's "À propos de ce modèle": the 3MF metadata of the scene, saved with it. */
  modelInfoDialog(): void {
    const info = this.doc.info;
    const field = (label: string, key: keyof typeof info, multi = false) => {
      const input = multi
        ? h('textarea', { rows: 4, style: 'width:100%;padding:6px', 'data-key': key }, info[key])
        : h('input', { type: 'text', value: info[key], style: 'width:100%;padding:6px', 'data-key': key });
      return h('label', { style: 'display:block;margin-bottom:10px' }, h('div', {}, label), input);
    };
    const body = h('div', {},
      field('Titre', 'title'), field('Concepteur', 'designer'), field('Copyright', 'copyright'),
      field('Termes du contrat de licence', 'licenseTerms'), field('Description', 'description', true));
    this.dialog('À propos de ce modèle', [body], [{
      label: 'Mettre à jour', primary: true, run: () => {
        body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-key]').forEach((el) => { info[el.dataset.key as keyof typeof info] = el.value; });
        this.doc.dirty = true;
        this.refresh();
      },
    }]);
  }

  /** 3D Builder's Caméra: a photo from the webcam, inserted like an image file. */
  private async cameraDialog(): Promise<void> {
    const photo = await this.capturePhoto();
    if (photo) void this.importFiles([new File([photo], 'Photo.png', { type: 'image/png' })]);
  }

  /** A photo from the webcam (PNG), or null when cancelled or no camera is available. */
  capturePhoto(): Promise<Blob | null> {
    return new Promise((resolve) => void this.photoDialog(resolve));
  }

  private async photoDialog(resolve: (b: Blob | null) => void): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true });
    } catch {
      this.toast('Aucune caméra accessible.', 'warn');
      return resolve(null);
    }
    let taken = false;
    const video = h('video', { autoplay: true, playsinline: true, style: 'width:100%;background:#000' }) as HTMLVideoElement;
    video.srcObject = stream;
    const stop = () => stream.getTracks().forEach((t) => t.stop());
    this.dialog('Caméra', [video], [{
      label: 'Prendre la photo', primary: true, run: () => {
        const c = document.createElement('canvas');
        c.width = video.videoWidth || 640;
        c.height = video.videoHeight || 480;
        c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
        taken = true;
        stop();
        c.toBlob((b) => resolve(b), 'image/png');
      },
    }]);
    // Stop the camera when the dialog closes without a photo.
    const box = document.body.lastElementChild!;
    new MutationObserver((_, obs) => { if (!box.isConnected) { stop(); obs.disconnect(); if (!taken) resolve(null); } }).observe(document.body, { childList: true });
  }

  private buildDrawer(): void {
    const item = (label: string, ico: string, fn: () => void) =>
      h('button', { onclick: () => { this.closeDrawer(); fn(); }, html: `${icon(ico, 22)}<span>${label}</span>` });
    this.drawer.replaceChildren(
      h('button', { title: 'Fermer', html: icon('menu', 22), onclick: () => this.closeDrawer() }),
      item('Nouvelle scène', 'newScene', () => this.newScene()),
      item('Ouvrir', 'open', () => this.openFiles(true)),
      item('Enregistrer', 'save', () => this.save()),
      item('Enregistrer sous', 'saveAs', () => this.saveAs()),
      h('div', { class: 'gap' }),
      item('Imprimer en 3D', 'print', () => { if (this.doc.objects.length) this.enterMode(MODES.print3d); }),
      item('Imprimer sur papier', 'print', () => this.printPaper()),
      h('div', { class: 'gap' }),
      item('À propos de ce modèle', 'info', () => this.modelInfoDialog()),
      h('div', { class: 'push' }),
      ...(this.installPrompt ? [item('Installer l’application', 'save', () => { void this.installPrompt?.prompt(); this.installPrompt = null; this.buildDrawer(); })] : []),
      h('button', { onclick: () => this.showSettings(), html: `${icon('settings', 22)}<span>Paramètres</span>` }),
    );
  }

  private openDrawer(): void {
    this.drawer.classList.remove('hidden');
    this.scrim.classList.remove('hidden');
  }

  private closeDrawer(): void {
    this.drawer.classList.add('hidden');
    this.scrim.classList.add('hidden');
  }

  // --- input -----------------------------------------------------------------------------------------------

  /**
   * Keyboard shortcuts as 3D Builder (its resource table and scene key handler). Browsers keep
   * Ctrl+N and Ctrl+T for themselves, so those two cannot be taken over.
   */
  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
      if (document.querySelector('.dialog')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const run = (fn: () => void) => { e.preventDefault(); fn(); };
      const n = this.doc.selected.length;
      if (ctrl) {
        // In a tool, Ctrl+Z / Ctrl+Y only act on the tool's own steps.
        if (k === 'z' && !e.shiftKey) return run(() => (this.mode ? (this.mode.spec.history || this.mode.ctx.history) && this.modeUndo() : this.doc.undo()));
        if (k === 'y' || (e.shiftKey && k === 'z')) return run(() => (this.mode ? (this.mode.spec.history || this.mode.ctx.history) && this.modeRedo() : this.doc.redo()));
        if (this.mode) return;
        if (k === 's' && e.shiftKey) return run(() => this.saveAs());
        if (k === 's') return run(() => void this.save());
        if (k === 'o') return run(() => void this.openFiles(true));
        if (k === 'n') return run(() => this.newScene());
        if (k === 'p') return run(() => { if (this.doc.objects.length) this.enterMode(MODES.print3d); });
        if (k === 't') return run(() => this.showSettings());
        if (k === 'b') return run(() => this.showAbout());
        if (k === 'x') return run(() => this.cut());
        if (k === 'c' && !e.shiftKey) return run(() => this.copy());
        if (k === 'v') return run(() => this.paste());
        if (k === 'd' || (k === 'c' && e.shiftKey)) return run(() => this.duplicate());
        if (k === 'a') return run(() => this.doc.select(this.doc.objects.map((o) => o.id)));
        if (k === 'i') return run(() => this.doc.select(this.doc.objects.filter((o) => !this.doc.selection.has(o.id)).map((o) => o.id)));
        if (k === 'g' && e.shiftKey) return run(() => { if (n === 1) this.ungroup(); });
        if (k === 'g') return run(() => { if (n >= 2) this.group(); });
        if (k === '0') return run(() => this.frameAll());
        if (k === 'j') return run(() => { if (n === 1) this.enterMode(MODES.simplify); });
        if (k === 'k') return run(() => { if (n === 1) this.enterMode(MODES.smooth); });
        if (k === 'r') return run(() => void this.repair());
        if (k === 'l') return run(() => void this.addPanel());
        return;
      }
      // Échap: leaves the tool (the Measure tool uses it to restart its measurement).
      if (k === 'escape') { if (this.mode?.spec === MODES.measure) return; return run(() => { if (this.mode) this.exitMode(); else this.doc.select([]); }); }
      if (k === 'enter' && this.mode) {
        // Accept: the mode's OK button.
        const ok = this.top.querySelectorAll<HTMLButtonElement>('.modebar .act')[1];
        return run(() => ok?.click());
      }
      if (this.mode) return;
      if (k === 'delete' || k === 'backspace') return run(() => this.deleteSelection());
      if (!n || e.altKey && !k.startsWith('arrow')) return;
      // Tools: R move, E rotate, Q scale (free), W scale (proportions kept).
      if (k === 'r') return run(() => { this.gizmo = 'translate'; this.renderTbar(); });
      if (k === 'e') return run(() => { this.gizmo = 'rotate'; this.renderTbar(); });
      if (k === 'q' || k === 'w') return run(() => { this.gizmo = 'scale'; this.lockScale = k === 'w'; this.renderTbar(); });
      if (k.startsWith('arrow')) return run(() => this.nudge(k, e.shiftKey, e.altKey));
      // Any number key starts typing a value in the transform bar (the field under the mouse, else X).
      if (/^[0-9]$/.test(e.key) || e.key === '-') return run(() => {
        const input = this.tbar.querySelector<HTMLInputElement>('input[data-axis]:hover') ?? this.tbar.querySelector<HTMLInputElement>('input[data-axis]');
        if (!input) return;
        input.focus();
        input.value = e.key;
      });
    });
  }

  /**
   * Arrow keys as 3D Builder: Left/Right act on X, Up/Down on Y, Alt+Up/Down on Z, with the active
   * tool; a step is 0.1 % of the selection's largest size (1 % with Shift) to move or scale, 1°
   * (10° with Shift) to rotate.
   */
  private nudge(key: string, coarse: boolean, alt: boolean): void {
    const sel = this.doc.selected;
    const axis = key === 'arrowleft' || key === 'arrowright' ? 0 : alt ? 2 : 1;
    const sign = key === 'arrowright' || key === 'arrowup' ? 1 : -1;
    const b = worldBounds(sel);
    const largest = Math.max(...size(b));
    this.doc.checkpoint();
    for (const o of sel) {
      if (this.gizmo === 'rotate') {
        const rot = [...o.rotation] as Vec3;
        rot[axis] += sign * (coarse ? 10 : 1);
        this.doc.update(o.id, { rotation: rot });
      } else if (this.gizmo === 'scale') {
        const f = 1 + sign * (coarse ? 0.01 : 0.001);
        const sc = this.lockScale ? o.scale.map((v) => v * f) as Vec3 : o.scale.map((v, i) => (i === axis ? v * f : v)) as Vec3;
        this.doc.update(o.id, { scale: sc });
      } else {
        const pos = [...o.position] as Vec3;
        pos[axis] += sign * largest * (coarse ? 0.01 : 0.001);
        this.doc.update(o.id, { position: pos });
      }
    }
    this.doc.emit();
  }

  private bindDrop(): void {
    this.viewEl.addEventListener('dragover', (e) => e.preventDefault());
    this.viewEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) void this.importFiles(files);
    });
  }
}

/**
 * Colours of a result that replaces `o`: unchanged face order (a transform, a smoothing pass) keeps
 * them as they are, anything else takes each face's colour from the nearest face of `o`.
 */
function inheritColors(o: SceneObject, m: MeshData): Uint32Array | undefined {
  if (!o.faceColors) return undefined;
  if (m.indices.length === o.mesh.indices.length) return o.faceColors;
  return transferFaceColors(worldMesh(o), o.faceColors, m);
}

/** Texture of a result that replaces `o`: same faces → kept, otherwise carried over by nearest face. */
function inheritTexture(o: SceneObject, m: MeshData): ObjectTexture | undefined {
  if (!o.texture) return undefined;
  if (m.indices.length === o.mesh.indices.length) return o.texture;
  const w = worldMesh(o);
  return transferTexture(w, o.texture, m, nearestFaces(w, m));
}

/** Textures of several objects merged in order. */
function partTextures(objs: SceneObject[]): ObjectTexture | undefined {
  return mergeTextures(objs.map((o) => ({ faces: o.mesh.indices.length / 3, texture: o.texture })));
}

/** Per-face colours of several objects merged in order (each unpainted face: its object's colour). */
function partColors(objs: SceneObject[]): Uint32Array {
  const out: number[] = [];
  for (const o of objs) {
    const own = parseInt(o.color.replace('#', '').slice(0, 6), 16);
    const n = o.mesh.indices.length / 3;
    for (let f = 0; f < n; f++) {
      const c = o.faceColors?.[f];
      out.push(c === undefined || c === NO_PAINT ? own : c);
    }
  }
  return Uint32Array.from(out);
}

function compactMesh(m: MeshData): MeshData {
  const remap = new Map<number, number>();
  const pos: number[] = [];
  const idx = new Uint32Array(m.indices.length);
  m.indices.forEach((v, i) => {
    let n = remap.get(v);
    if (n === undefined) {
      n = pos.length / 3;
      remap.set(v, n);
      pos.push(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]);
    }
    idx[i] = n;
  });
  return { positions: new Float32Array(pos), indices: idx };
}

export function fmtNum(v: number): string {
  const r = Math.round(v * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toLocaleString('fr-FR', { maximumFractionDigits: 2, useGrouping: false });
}
