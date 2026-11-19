// File import/export dispatch. Imported geometry is returned in millimetres, Z up.
import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLLoader } from 'three/addons/loaders/VRMLLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { type MeshData, fromTriangleSoup, merged } from '../core/mesh-data';
import { read3MF, write3MF, type ThreeMFInfo } from './threemf';
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
export type ExportFormat = '3mf' | 'stl' | 'obj' | 'ply' | 'glb';

export const EXPORT_FORMATS: { id: ExportFormat; label: string }[] = [
  { id: '3mf', label: '3MF (recommandé)' },
  { id: 'stl', label: 'STL' },
  { id: 'obj', label: 'OBJ' },
  { id: 'ply', label: 'PLY' },
  { id: 'glb', label: 'GLB' },
];

const baseName = (file: string) => file.replace(/\.[^.]+$/, '');

export async function importFile(file: File): Promise<ImportedObject[]> {
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
      return [{ name, mesh: geometryToMesh(new PLYLoader().parse(buf)) }];
    case 'obj':
      return [{ name, mesh: objectToMesh(new OBJLoader().parse(new TextDecoder().decode(buf)), true) }];
    case 'wrl':
      return [{ name, mesh: objectToMesh(new VRMLLoader().parse(new TextDecoder().decode(buf), ''), true) }];
    case 'glb':
    case 'gltf': {
      const gltf = await new GLTFLoader().parseAsync(ext === 'glb' ? buf : new TextDecoder().decode(buf), '');
      return [{ name, mesh: objectToMesh(gltf.scene, true), color: firstColor(gltf.scene) }];
    }
    default:
      throw new Error(`Format non pris en charge : .${ext}`);
  }
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
      return new Blob([writeOBJ(items)], { type: 'text/plain' });
    case 'ply':
      return new Blob([writePLY(merged(items.map((i) => i.mesh)))], { type: 'application/octet-stream' });
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

function writeOBJ(items: ExportItem[]): string {
  // OBJ is conventionally Y up: (x, y, z) -> (x, z, -y).
  const lines = ['# 3D Assembler'];
  let base = 1;
  for (const it of items) {
    lines.push(`o ${it.name.replace(/\s+/g, '_')}`);
    const p = it.mesh.positions, t = it.mesh.indices;
    for (let i = 0; i < p.length; i += 3) lines.push(`v ${p[i]} ${p[i + 2]} ${-p[i + 1]}`);
    for (let i = 0; i < t.length; i += 3) lines.push(`f ${t[i] + base} ${t[i + 1] + base} ${t[i + 2] + base}`);
    base += p.length / 3;
  }
  return lines.join('\n') + '\n';
}

function writePLY(m: MeshData): ArrayBuffer {
  const nv = m.positions.length / 3, nt = m.indices.length / 3;
  const header = `ply\nformat binary_little_endian 1.0\ncomment 3D Assembler\nelement vertex ${nv}\nproperty float x\nproperty float y\nproperty float z\nelement face ${nt}\nproperty list uchar int vertex_indices\nend_header\n`;
  const hb = new TextEncoder().encode(header);
  const buf = new ArrayBuffer(hb.length + nv * 12 + nt * 13);
  new Uint8Array(buf).set(hb);
  const dv = new DataView(buf);
  let o = hb.length;
  for (let i = 0; i < m.positions.length; i++) { dv.setFloat32(o, m.positions[i], true); o += 4; }
  for (let f = 0; f < nt; f++) {
    dv.setUint8(o++, 3);
    for (let k = 0; k < 3; k++) { dv.setInt32(o, m.indices[f * 3 + k], true); o += 4; }
  }
  return buf;
}

async function writeGLB(items: ExportItem[]): Promise<Blob> {
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
  const out = await new GLTFExporter().parseAsync(scene, { binary: true });
  return new Blob([out as ArrayBuffer], { type: 'model/gltf-binary' });
}
