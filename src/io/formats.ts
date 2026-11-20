// File import/export dispatch. Imported geometry is returned in millimetres, Z up.
import { BufferAttribute, BufferGeometry, Color, LinearSRGBColorSpace, Mesh, MeshStandardMaterial, Object3D, SRGBColorSpace, Scene } from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLLoader } from 'three/addons/loaders/VRMLLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { type MeshData, fromTriangleSoup, merged } from '../core/mesh-data';
import { read3MF, write3MF, type ThreeMFInfo } from './threemf';
import { LoadingManager } from 'three';
import { MAX_PIXELS, MAX_SIDE } from './png';

/**
 * Loader manager that keeps a model to what it contains: links to outside files or addresses
 * (glTF buffers and images, VRML textures) are not fetched, so opening a file sends no request.
 */
/** A .gltf whose data lives in other files (or on the web) cannot be read: they are never fetched. */
function refuseExternal(text: string): void {
  let j: { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
  try { j = JSON.parse(text); } catch { return; }
  const outside = [...(j.buffers ?? []), ...(j.images ?? [])].some((x) => typeof x?.uri === 'string' && !/^data:/i.test(x.uri));
  if (outside) throw new Error('Ce fichier glTF dépend d’autres fichiers, qui ne sont pas lus. Ouvrez plutôt la version .glb (tout en un seul fichier).');
}

function embeddedOnly(): LoadingManager {
  const m = new LoadingManager();
  m.setURLModifier((u) => (/^(data|blob):/i.test(u) ? u : 'data:,'));
  return m;
}
import { type ObjectTexture, compactTexture } from '../core/texture-data';

export interface ImportedObject {
  name: string;
  mesh: MeshData; // world coordinates
  color?: string;
  faceColors?: Uint32Array;
  texture?: ObjectTexture;
  /** 3MF: mesh in the object's frame and its build transform (row vectors), kept as the object's transform. */
  local?: { mesh: MeshData; transform: number[] };
}

export const IMPORT_ACCEPT = '.3mf,.stl,.obj,.ply,.glb,.gltf,.wrl,.png,.jpg,.jpeg,.bmp,.gif,.webp';
export type ExportFormat = '3mf' | 'stl' | 'obj' | 'ply' | 'gltf' | 'glb';

export const EXPORT_FORMATS: { id: ExportFormat; label: string }[] = [
  { id: '3mf', label: '3MF (recommandé)' },
  { id: 'stl', label: 'STL' },
  { id: 'obj', label: 'OBJ' },
  { id: 'ply', label: 'PLY' },
  { id: 'gltf', label: 'GLTF' },
  { id: 'glb', label: 'GLB' },
];

const baseName = (file: string) => file.replace(/\.[^.]+$/, '');

/** Name of the material library an OBJ file refers to (its "mtllib" line), if any. */
export function objMaterialLibrary(text: string): string | null {
  const m = /^mtllib[ \t]+(.+?)[ \t]*$/m.exec(text);
  return m ? m[1] : null;
}

/** Diffuse colours (Kd) of a .mtl file, by material name, as #rrggbb. */
function parseMtl(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let name = '';
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'newmtl') name = t.slice(1).join(' ');
    else if (t[0] === 'Kd' && name) {
      const c = t.slice(1, 4).map((x) => Math.max(0, Math.min(255, Math.round(parseFloat(x) * 255))));
      if (c.length === 3 && c.every((x) => Number.isFinite(x))) out.set(name, '#' + c.map((x) => x.toString(16).padStart(2, '0')).join(''));
    }
  }
  return out;
}

/** OBJ with the colours of its material library: the object's colour, and per-face colours if they differ. */
function objObject(name: string, text: string, mtl?: string): ImportedObject {
  const root = new OBJLoader().parse(text);
  const mesh = objectToMesh(root, false); // Z up, as 3D Builder reads (and writes) OBJ files
  if (!mtl) return { name, mesh };
  const kd = parseMtl(mtl);
  const faces: number[] = [];
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || !m.geometry) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const count = (m.geometry.getIndex()?.count ?? m.geometry.getAttribute('position').count) / 3;
    const colorOf = (i: number) => parseInt((kd.get(mats[i]?.name ?? '') ?? '#bcbcbc').slice(1), 16);
    const groups = m.geometry.groups.length ? m.geometry.groups : [{ start: 0, count: count * 3, materialIndex: 0 }];
    const per = new Array<number>(count).fill(colorOf(0));
    for (const g of groups) for (let t = g.start / 3; t < (g.start + g.count) / 3 && t < count; t++) per[t] = colorOf(g.materialIndex ?? 0);
    faces.push(...per);
  });
  if (faces.length !== mesh.indices.length / 3 || !faces.length) return { name, mesh };
  const counts = new Map<number, number>();
  for (const c of faces) counts.set(c, (counts.get(c) ?? 0) + 1);
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const color = '#' + main.toString(16).padStart(6, '0');
  return counts.size > 1 ? { name, mesh, color, faceColors: Uint32Array.from(faces) } : { name, mesh, color };
}

export async function importFile(file: File, opts: { mtl?: string } = {}): Promise<ImportedObject[]> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const buf = await file.arrayBuffer();
  const name = baseName(file.name);
  switch (ext) {
    case '3mf': {
      const objs = read3MF(new Uint8Array(buf)).map((o, i, a) => ({ ...o, name: o.name || (a.length > 1 ? `${name} ${i + 1}` : name) }));
      await decodeTextures(objs);
      return objs;
    }
    case 'stl':
      return [{ name, mesh: geometryToMesh(new STLLoader().parse(buf)) }];
    case 'ply':
      return [plyObject(name, new PLYLoader().parse(buf))];
    case 'obj':
      return [objObject(name, new TextDecoder().decode(buf), opts.mtl)];
    case 'wrl':
      return [{ name, mesh: objectToMesh(new VRMLLoader(embeddedOnly()).parse(new TextDecoder().decode(buf), ''), true) }];
    case 'glb':
    case 'gltf': {
      if (ext === 'gltf') refuseExternal(new TextDecoder().decode(buf));
      const gltf = await new GLTFLoader(embeddedOnly()).parseAsync(ext === 'glb' ? buf : new TextDecoder().decode(buf), '');
      return [{ name, mesh: objectToMesh(gltf.scene, true), color: firstColor(gltf.scene) }];
    }
    default:
      throw new Error(`Format non pris en charge : .${ext}`);
  }
}

/** PLY with vertex colours (3D Builder writes one per vertex): the object's colour, or per-face colours. */
function plyObject(name: string, g: BufferGeometry): ImportedObject {
  const mesh = geometryToMesh(g);
  const col = g.getAttribute('color');
  if (!col) return { name, mesh };
  const idx = g.getIndex();
  const nt = mesh.indices.length / 3;
  const faceColors = new Uint32Array(nt);
  // The loader gives linear colours: back to the file's sRGB values.
  const tmp = new Color();
  const vertexColor = (v: number) => tmp.setRGB(col.getX(v), col.getY(v), col.getZ(v), LinearSRGBColorSpace).getHex(SRGBColorSpace);
  // Colours are per vertex: a face takes the colour at least two of its corners share (on a fine mesh
  // this follows the painted areas; a mesh with very few vertices cannot keep per-face colours).
  for (let f = 0; f < nt; f++) {
    const c = [0, 1, 2].map((k) => vertexColor(idx ? idx.getX(f * 3 + k) : f * 3 + k));
    faceColors[f] = c[1] === c[2] ? c[1] : c[0];
  }
  const first = faceColors[0];
  const hex = '#' + first.toString(16).padStart(6, '0');
  return faceColors.every((c) => c === first) ? { name, mesh, color: hex } : { name, mesh, color: hex, faceColors };
}

function geometryToMesh(g: BufferGeometry): MeshData {
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  if (idx) {
    const soup = new Float32Array(idx.count * 3);
    for (let i = 0; i < idx.count; i++) {
      const v = idx.getX(i);
      soup[i * 3] = pos.getX(v);
      soup[i * 3 + 1] = pos.getY(v);
      soup[i * 3 + 2] = pos.getZ(v);
    }
    return fromTriangleSoup(soup);
  }
  return fromTriangleSoup(pos.array as Float32Array);
}

/** Bakes every mesh with its world matrix; `yUp` converts Y-up formats to Z-up. */
function objectToMesh(root: Object3D, yUp: boolean): MeshData {
  if (yUp) root.rotation.x = Math.PI / 2;
  root.updateMatrixWorld(true);
  const parts: MeshData[] = [];
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || !m.geometry) return;
    const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
    parts.push(geometryToMesh(g));
  });
  if (!parts.length) throw new Error('Aucun objet 3D trouvé dans ce fichier.');
  return merged(parts);
}

function firstColor(root: Object3D): string | undefined {
  let color: string | undefined;
  root.traverse((o) => {
    const mat = (o as Mesh).material as MeshStandardMaterial | undefined;
    if (!color && mat && 'color' in mat && mat.color instanceof Color) color = `#${mat.color.getHexString()}`;
  });
  return color;
}

/**
 * Decodes the texture images kept encoded by the 3MF reader (JPEG) with the browser's decoder.
 * Faces whose image cannot be decoded lose their texture (they show their colour).
 */
export async function decodeTextures(objs: { texture?: ObjectTexture }[]): Promise<void> {
  for (const o of objs) {
    const t = o.texture;
    if (!t) continue;
    for (const img of t.images) {
      if (!img.source) continue;
      try {
        const bmp = await createImageBitmap(new Blob([img.source.bytes as BlobPart], { type: img.source.type }));
        if (bmp.width > MAX_SIDE || bmp.height > MAX_SIDE || bmp.width * bmp.height > MAX_PIXELS) { bmp.close(); continue; }
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(0, 0, bmp.width, bmp.height);
        img.width = px.width;
        img.height = px.height;
        img.data = px.data;
        delete img.source;
      } catch {
        // left encoded: removed below
      }
    }
    if (t.images.some((img) => img.source)) {
      const bad = new Set(t.images.map((img, i) => (img.source ? i : -1)).filter((i) => i >= 0));
      const face = Int16Array.from(t.face, (i) => (bad.has(i) ? -1 : i));
      o.texture = compactTexture({ ...t, face });
    }
  }
}

// --- export ---------------------------------------------------------------------------------------

export interface ExportItem {
  name: string;
  mesh: MeshData; // world coordinates
  /** 3MF only: the mesh in the object's frame and its transform (3MF row-vector 3×4), as 3D Builder writes. */
  local?: { mesh: MeshData; transform: number[] };
  color: string;
  faceColors?: Uint32Array;
  texture?: ObjectTexture;
}

export async function exportScene(items: ExportItem[], format: ExportFormat, title: string, info?: Partial<ThreeMFInfo>, thumbnail?: Uint8Array): Promise<Blob> {
  switch (format) {
    case '3mf':
      return new Blob([write3MF(items.map((i) => (i.local ? { ...i, mesh: i.local.mesh, transform: i.local.transform } : i)), title, info, thumbnail) as BlobPart], { type: 'model/3mf' });
    case 'stl':
      return new Blob([writeSTL(merged(items.map((i) => i.mesh)))], { type: 'model/stl' });
    case 'obj':
      return new Blob([writeOBJ(items, title + '.mtl')], { type: 'text/plain' });
    case 'ply':
      return new Blob([writePLY(items)], { type: 'application/octet-stream' });
    case 'gltf':
      return writeGLB(items, false);
    case 'glb':
      return writeGLB(items);
  }
}

function writeSTL(m: MeshData): ArrayBuffer {
  const nt = m.indices.length / 3;
  const buf = new ArrayBuffer(84 + nt * 50);
  const dv = new DataView(buf);
  const header = 'Binary STL - 3D Assembler';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, nt, true);
  const p = m.positions, t = m.indices;
  let o = 84;
  for (let f = 0; f < nt; f++) {
    const a = t[f * 3] * 3, b = t[f * 3 + 1] * 3, c = t[f * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const v of [nx, ny, nz]) { dv.setFloat32(o, v, true); o += 4; }
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) { dv.setFloat32(o, p[v + k], true); o += 4; }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}

/** Colour of each face of an export item (painted faces, or the object's colour). */
function faceColorsOf(it: ExportItem): Uint32Array {
  const nt = it.mesh.indices.length / 3;
  const base = parseInt(it.color.slice(1), 16) & 0xffffff;
  const out = new Uint32Array(nt).fill(base);
  if (it.faceColors) for (let f = 0; f < nt; f++) if (it.faceColors[f] !== undefined && it.faceColors[f] !== 0xffffffff) out[f] = it.faceColors[f] & 0xffffff;
  return out;
}

const mtlName = (c: number) => 'Color_' + c.toString(16).padStart(6, '0');

/**
 * OBJ as 3D Builder writes it: Z up (coordinates as they are), one object per item, its colours as
 * materials of a companion .mtl file (see objMaterials).
 */
function writeOBJ(items: ExportItem[], mtlFile: string): string {
  const lines = ['# Exported from 3D Assembler', 'mtllib ' + mtlFile];
  let base = 1;
  items.forEach((it, n) => {
    lines.push('', 'o ' + (it.name.replace(/\s+/g, '_') || 'Object.' + (n + 1)));
    const p = it.mesh.positions, t = it.mesh.indices;
    for (let i = 0; i < p.length; i += 3) lines.push('v ' + p[i].toFixed(6) + ' ' + p[i + 1].toFixed(6) + ' ' + p[i + 2].toFixed(6));
    const fc = faceColorsOf(it);
    let current = -1;
    for (let f = 0; f < t.length / 3; f++) {
      if (fc[f] !== current) { current = fc[f]; lines.push('usemtl ' + mtlName(current)); }
      lines.push('f ' + (t[f * 3] + base) + ' ' + (t[f * 3 + 1] + base) + ' ' + (t[f * 3 + 2] + base));
    }
    base += p.length / 3;
  });
  return lines.join('\n') + '\n';
}

/** The .mtl file that goes with writeOBJ: one material per colour (diffuse colour Kd). */
export function objMaterials(items: ExportItem[]): Blob {
  const colors = new Set<number>();
  for (const it of items) for (const c of faceColorsOf(it)) colors.add(c);
  const lines = ['# Exported from 3D Assembler'];
  for (const c of colors) lines.push('', 'newmtl ' + mtlName(c), 'Kd ' + [16, 8, 0].map((sh) => (((c >> sh) & 255) / 255).toFixed(6)).join(' '));
  return new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
}

/** Binary PLY with a colour per vertex (RGBA), as 3D Builder writes it. */
function writePLY(items: ExportItem[]): ArrayBuffer {
  const nv = items.reduce((n, it) => n + it.mesh.positions.length / 3, 0), nt = items.reduce((n, it) => n + it.mesh.indices.length / 3, 0);
  const header = 'ply\nformat binary_little_endian 1.0\ncomment 3D Assembler\nelement vertex ' + nv + '\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\nelement face ' + nt + '\nproperty list uchar int vertex_indices\nend_header\n';
  const hb = new TextEncoder().encode(header);
  const buf = new ArrayBuffer(hb.length + nv * 16 + nt * 13);
  new Uint8Array(buf).set(hb);
  const dv = new DataView(buf);
  let o = hb.length;
  for (const it of items) {
    // A vertex takes the object's colour, or that of a painted face using it (painted faces win).
    const fc = faceColorsOf(it), base = parseInt(it.color.slice(1), 16) & 0xffffff;
    const vc = new Uint32Array(it.mesh.positions.length / 3).fill(base);
    for (let f = 0; f < fc.length; f++) if (fc[f] !== base) for (let k = 0; k < 3; k++) vc[it.mesh.indices[f * 3 + k]] = fc[f];
    for (let v = 0; v < vc.length; v++) {
      for (let k = 0; k < 3; k++) { dv.setFloat32(o, it.mesh.positions[v * 3 + k], true); o += 4; }
      dv.setUint8(o++, (vc[v] >> 16) & 255); dv.setUint8(o++, (vc[v] >> 8) & 255); dv.setUint8(o++, vc[v] & 255); dv.setUint8(o++, 255);
    }
  }
  let base = 0;
  for (const it of items) {
    const t = it.mesh.indices;
    for (let f = 0; f < t.length / 3; f++) {
      dv.setUint8(o++, 3);
      for (let k = 0; k < 3; k++) { dv.setInt32(o, t[f * 3 + k] + base, true); o += 4; }
    }
    base += it.mesh.positions.length / 3;
  }
  return buf;
}

async function writeGLB(items: ExportItem[], binary = true): Promise<Blob> {
  const scene = new Scene();
  const root = new Object3D();
  root.rotation.x = -Math.PI / 2; // back to Y up
  scene.add(root);
  for (const it of items) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(it.mesh.positions, 3));
    g.setIndex(new BufferAttribute(it.mesh.indices, 1));
    g.computeVertexNormals();
    const mesh = new Mesh(g, new MeshStandardMaterial({ color: it.color }));
    mesh.name = it.name;
    root.add(mesh);
  }
  const out = await new GLTFExporter().parseAsync(scene, { binary });
  // glTF: one JSON file with its data embedded.
  return binary ? new Blob([out as ArrayBuffer], { type: 'model/gltf-binary' }) : new Blob([JSON.stringify(out)], { type: 'model/gltf+json' });
}
