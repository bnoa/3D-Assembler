// 3MF core spec reader/writer (zip + XML). Units are converted to millimetres.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { MeshData } from '../core/mesh-data';
import { type ObjectTexture, type TextureImage, compactTexture, emptyTexture } from '../core/texture-data';
import { decodePNG, encodePNG } from './png';

const NS_MAT = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';

const NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const UNIT_TO_MM: Record<string, number> = {
  micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000,
};

export interface ThreeMFObject {
  name: string;
  mesh: MeshData; // world coordinates, mm
  color?: string;
  /** Per-triangle colour (0xRRGGBB, 0xFFFFFFFF = object colour), when triangles differ. */
  faceColors?: Uint32Array;
  /** Textured triangles (3MF texture2d / texture2dgroup). */
  texture?: ObjectTexture;
  /**
   * Object transform as in the 3MF build item (row vectors: m00 m01 m02 m10 … m32, mm), for
   * writing: `mesh` is then in the object's own frame, as 3D Builder writes its files.
   */
  transform?: number[];
  /** On reading: the mesh in the object's own frame and the item transform (`mesh` stays in world coordinates). */
  local?: { mesh: MeshData; transform: number[] };
}

const NO_PAINT = 0xffffffff;
const hexInt = (c: string) => parseInt(c.replace('#', '').slice(0, 6), 16);

export function read3MF(data: Uint8Array): ThreeMFObject[] {
  const files = unzipSync(data);
  const modelPath = findModelPath(files);
  const xml = new DOMParser().parseFromString(strFromU8(files[modelPath]), 'application/xml');
  const model = xml.documentElement;
  const unit = UNIT_TO_MM[model.getAttribute('unit') ?? 'millimeter'] ?? 1;

  const colorGroups = new Map<string, string[]>();
  for (const el of all(model, 'basematerials')) {
    colorGroups.set(el.getAttribute('id')!, all(el, 'base').map((b) => normColor(b.getAttribute('displaycolor'))));
  }
  for (const el of all(model, 'colorgroup')) {
    colorGroups.set(el.getAttribute('id')!, all(el, 'color').map((c) => normColor(c.getAttribute('color'))));
  }

  // Textures: texture2d (image file) and texture2dgroup (texture coordinates).
  const images = new Map<string, TextureImage | null>();
  const imageOf = (id: string): TextureImage | null => {
    if (images.has(id)) return images.get(id)!;
    const el = all(model, 'texture2d').find((x) => x.getAttribute('id') === id);
    let img: TextureImage | null = null;
    if (el) {
      const path = (el.getAttribute('path') ?? '').replace(/^\//, '');
      const key = files[path] ? path : Object.keys(files).find((k) => k.toLowerCase() === path.toLowerCase());
      const bytes = key ? files[key] : undefined;
      const clamp = (el.getAttribute('tilestyleu') ?? 'wrap') === 'clamp';
      const wrap = clamp ? 'clamp' : 'repeat';
      const px = bytes ? decodePNG(bytes) : null;
      if (px) img = { ...px, wrap };
      else if (bytes && bytes[0] === 0xff && bytes[1] === 0xd8) {
        // JPEG: kept encoded, decoded by the browser when the file is imported (decodeTextures).
        img = { width: 0, height: 0, data: new Uint8ClampedArray(0), wrap, source: { bytes, type: 'image/jpeg' } };
      }
    }
    images.set(id, img);
    return img;
  };
  const texGroups = new Map<string, { img: TextureImage | null; uv: number[] }>();
  for (const el of all(model, 'texture2dgroup')) {
    const uv: number[] = [];
    for (const c of all(el, 'tex2coord')) uv.push(+(c.getAttribute('u') ?? 0), +(c.getAttribute('v') ?? 0));
    texGroups.set(el.getAttribute('id')!, { img: imageOf(el.getAttribute('texid') ?? ''), uv });
  }

  interface TriTex { img: TextureImage; uv: number[] }
  interface Def { name: string; mesh?: MeshData; color?: string; triColors?: (string | undefined)[]; triTex?: (TriTex | undefined)[]; components: { id: string; m: number[] }[] }
  const defs = new Map<string, Def>();
  for (const obj of all(model, 'object')) {
    const def: Def = { name: obj.getAttribute('name') ?? '', components: [] };
    const pid = obj.getAttribute('pid');
    if (pid && colorGroups.has(pid)) def.color = colorGroups.get(pid)![+(obj.getAttribute('pindex') ?? 0)];
    const meshEl = first(obj, 'mesh');
    if (meshEl) {
      const verts = all(meshEl, 'vertex');
      const positions = new Float32Array(verts.length * 3);
      verts.forEach((v, i) => {
        positions[i * 3] = +v.getAttribute('x')! * unit;
        positions[i * 3 + 1] = +v.getAttribute('y')! * unit;
        positions[i * 3 + 2] = +v.getAttribute('z')! * unit;
      });
      const tris = all(meshEl, 'triangle');
      const indices = new Uint32Array(tris.length * 3);
      const triColors: (string | undefined)[] = new Array(tris.length);
      const triTex: (TriTex | undefined)[] = new Array(tris.length);
      tris.forEach((t, i) => {
        indices[i * 3] = +t.getAttribute('v1')!;
        indices[i * 3 + 1] = +t.getAttribute('v2')!;
        indices[i * 3 + 2] = +t.getAttribute('v3')!;
        const tp = t.getAttribute('pid') ?? pid;
        const p1 = t.getAttribute('p1');
        if (tp && p1 !== null && colorGroups.has(tp)) triColors[i] = colorGroups.get(tp)![+p1];
        const g = tp ? texGroups.get(tp) : undefined;
        if (g?.img && p1 !== null) {
          const ks = [+p1, +(t.getAttribute('p2') ?? p1), +(t.getAttribute('p3') ?? p1)];
          triTex[i] = { img: g.img, uv: ks.flatMap((k) => [g.uv[k * 2] ?? 0, g.uv[k * 2 + 1] ?? 0]) };
        }
      });
      def.triTex = triTex;
      if (!def.color) def.color = triColors.find(Boolean);
      def.mesh = { positions, indices };
      def.triColors = triColors;
    }
    for (const c of all(obj, 'component')) {
      def.components.push({ id: c.getAttribute('objectid')!, m: parseTransform(c.getAttribute('transform'), unit) });
    }
    defs.set(obj.getAttribute('id')!, def);
  }

  type Part = { mesh: MeshData; colors: (string | undefined)[]; tex: (TriTex | undefined)[] };
  const flatten = (id: string, m: number[], depth = 0): Part[] => {
    const def = defs.get(id);
    if (!def || depth > 16) return [];
    const out: Part[] = [];
    if (def.mesh) out.push({ mesh: applyAffine(def.mesh, m), colors: def.triColors ?? [], tex: def.triTex ?? [] });
    for (const c of def.components) out.push(...flatten(c.id, mul(m, c.m), depth + 1));
    return out;
  };

  const result: ThreeMFObject[] = [];
  const build = first(model, 'build');
  const items = build ? all(build, 'item') : [];
  for (const item of items) {
    const id = item.getAttribute('objectid')!;
    const def0 = defs.get(id);
    // A plain mesh object placed by its build transform keeps that transform (3D Builder stores
    // an object's move, rotation and scale there).
    const itemT = parseTransform(item.getAttribute('transform'), unit);
    // (3D Builder writes item → object with one component → mesh: the item transform is the
    // object's, the component's stays in the mesh.)
    const local = item.getAttribute('transform') && def0 ? flatten(id, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]) : [];
    const keepT = local.length === 1;
    const parts = flatten(id, itemT);
    if (!parts.length) continue;
    const def = defs.get(id)!;
    const mesh = concat(parts.map((p) => p.mesh));
    const color = def.color ?? parts.flatMap((p) => p.colors).find(Boolean);
    // Per-face colours only when some triangle differs from the object colour.
    const per = parts.flatMap((p) => Array.from({ length: p.mesh.indices.length / 3 }, (_, i) => p.colors[i]));
    const differs = per.some((c) => c && c !== color);
    const faceColors = differs ? Uint32Array.from(per, (c) => (c && c !== color ? hexInt(c) : NO_PAINT)) : undefined;
    // Textured triangles.
    const tex = parts.flatMap((p) => Array.from({ length: p.mesh.indices.length / 3 }, (_, i) => p.tex[i]));
    let texture: ObjectTexture | undefined;
    if (tex.some(Boolean)) {
      const tx = emptyTexture(tex.length);
      tex.forEach((tt, f) => {
        if (!tt) return;
        let k = tx.images.indexOf(tt.img);
        if (k < 0) { tx.images.push(tt.img); k = tx.images.length - 1; }
        tx.face[f] = k;
        tx.uv.set(tt.uv, f * 6);
      });
      texture = compactTexture(tx);
    }
    result.push({ name: def.name, mesh, color, faceColors, texture, local: keepT ? { mesh: local[0].mesh, transform: itemT } : undefined });
  }
  return result;
}

/** 3MF metadata names for the model info (3MF core specification). */
const INFO_KEYS = [['title', 'Title'], ['designer', 'Designer'], ['copyright', 'Copyright'], ['licenseTerms', 'LicenseTerms'], ['description', 'Description']] as const;
export type ThreeMFInfo = Record<(typeof INFO_KEYS)[number][0], string>;

/** The model metadata of a 3MF file (empty strings when absent). */
export function read3MFInfo(data: Uint8Array): ThreeMFInfo {
  const files = unzipSync(data);
  const xml = new DOMParser().parseFromString(strFromU8(files[findModelPath(files)]), 'application/xml');
  const meta = new Map(all(xml.documentElement, 'metadata').map((m) => [m.getAttribute('name') ?? '', m.textContent ?? '']));
  return Object.fromEntries(INFO_KEYS.map(([k, n]) => [k, meta.get(n) ?? ''])) as ThreeMFInfo;
}

export function write3MF(objects: ThreeMFObject[], _title = '', info?: Partial<ThreeMFInfo>, thumbnail?: Uint8Array): Uint8Array {
  const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
  const palette = new Set(objects.map((o) => (o.color ?? '#9aa3ad').toLowerCase()));
  for (const o of objects) o.faceColors?.forEach((c) => { if (c !== NO_PAINT) palette.add(hex(c)); });
  const colors = [...palette];
  let res = `<basematerials id="1">${colors.map((c, i) => `<base name="Couleur ${i + 1}" displaycolor="${c.toUpperCase()}FF"/>`).join('')}</basematerials>`;
  let build = '';
  // Textures: one PNG and texture2d per image, one texture2dgroup per object and image.
  const pngs: Record<string, Uint8Array> = {};
  const texIds = new Map<TextureImage, number>();
  let nextId = objects.length + 2;
  const texRes: string[] = [];
  const groups = new Map<string, { id: number; texid: number; coords: string[] }>();
  objects.forEach((o, i) => {
    if (!o.texture) return;
    o.texture.images.forEach((img, k) => {
      if (!o.texture!.face.some((x) => x === k)) return;
      let texid = texIds.get(img);
      if (texid === undefined) {
        texid = nextId++;
        texIds.set(img, texid);
        // PNG, or the original JPEG bytes when the image was never decoded.
        const jpeg = !!img.source;
        const path = '3D/Textures/texture' + texid + (jpeg ? '.jpg' : '.png');
        pngs[path] = jpeg ? img.source!.bytes : encodePNG(img.width, img.height, img.data);
        const tile = img.wrap === 'clamp' ? 'clamp' : 'wrap';
        texRes.push('<m:texture2d id="' + texid + '" path="/' + path + '" contenttype="' + (jpeg ? 'image/jpeg' : 'image/png') + '" tilestyleu="' + tile + '" tilestylev="' + tile + '"/>');
      }
      groups.set(i + ':' + k, { id: nextId++, texid, coords: [] });
    });
  });
  objects.forEach((o, i) => {
    const id = i + 2;
    const p = o.mesh.positions, t = o.mesh.indices;
    const v: string[] = [];
    for (let k = 0; k < p.length; k += 3) v.push(`<vertex x="${fmt(p[k])}" y="${fmt(p[k + 1])}" z="${fmt(p[k + 2])}"/>`);
    const tr: string[] = [];
    for (let k = 0; k < t.length; k += 3) {
      const f = k / 3;
      const ti = o.texture?.face[f] ?? -1;
      const g = ti >= 0 ? groups.get(i + ':' + ti) : undefined;
      let paint = '';
      if (g) {
        const b0 = g.coords.length;
        for (let c = 0; c < 3; c++) g.coords.push('<m:tex2coord u="' + fmt(o.texture!.uv[f * 6 + c * 2]) + '" v="' + fmt(o.texture!.uv[f * 6 + c * 2 + 1]) + '"/>');
        paint = ' pid="' + g.id + '" p1="' + b0 + '" p2="' + (b0 + 1) + '" p3="' + (b0 + 2) + '"';
      } else {
        const fc = o.faceColors?.[f];
        paint = fc !== undefined && fc !== NO_PAINT ? ` pid="1" p1="${colors.indexOf(hex(fc))}"` : '';
      }
      tr.push(`<triangle v1="${t[k]}" v2="${t[k + 1]}" v3="${t[k + 2]}"${paint}/>`);
    }
    const pindex = colors.indexOf((o.color ?? '#9aa3ad').toLowerCase());
    res += `<object id="${id}" type="model" name="${escapeXml(o.name)}" pid="1" pindex="${pindex}"><mesh><vertices>${v.join('')}</vertices><triangles>${tr.join('')}</triangles></mesh></object>`;
    build += o.transform ? `<item objectid="${id}" transform="${o.transform.map(fmt).join(' ')}"/>` : `<item objectid="${id}"/>`;
  });
  for (const g of groups.values()) texRes.push(`<m:texture2dgroup id="${g.id}" texid="${g.texid}">${g.coords.join('')}</m:texture2dgroup>`);
  // Texture resources are declared before the objects that use them.
  res = res.replace('</basematerials>', `</basematerials>${texRes.join('')}`);
  const textured = texRes.length > 0;
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="fr-FR" xmlns="${NS}"${textured ? ` xmlns:m="${NS_MAT}"` : ''}>
${INFO_KEYS.map(([k, n]) => {
    // As 3D Builder: only the fields that are filled in (the scene name is not a title).
    const v = info?.[k];
    return v ? `<metadata name="${n}">${escapeXml(v)}</metadata>\n` : '';
  }).join('')}
<resources>${res}</resources>
<build>${build}</build>
</model>`;
  const modelRels = Object.keys(pngs).map((path, i) => `<Relationship Target="/${path}" Id="tex${i}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dtexture"/>`).join('');
  return zipSync({
    ...pngs,
    ...(textured ? { '3D/_rels/3dmodel.model.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${modelRels}</Relationships>`) } : {}),
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>${thumbnail ? '<Relationship Target="/Metadata/thumbnail.png" Id="rel1" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>' : ''}</Relationships>`),
    ...(thumbnail ? { 'Metadata/thumbnail.png': thumbnail } : {}),
    '3D/3dmodel.model': strToU8(model),
  });
}

// --- helpers ------------------------------------------------------------------------------------

function findModelPath(files: Record<string, Uint8Array>): string {
  const rels = files['_rels/.rels'];
  if (rels) {
    const m = /Target="\/?([^"]+\.model)"/i.exec(strFromU8(rels));
    if (m && files[m[1]]) return m[1];
  }
  const any = Object.keys(files).find((k) => k.toLowerCase().endsWith('.model'));
  if (!any) throw new Error('Fichier 3MF sans modèle 3D.');
  return any;
}

const all = (el: Element, tag: string) => Array.from(el.getElementsByTagNameNS('*', tag));
const first = (el: Element, tag: string) => el.getElementsByTagNameNS('*', tag)[0] as Element | undefined;

function normColor(c: string | null): string {
  if (!c) return '#9aa3ad';
  return c.length >= 7 ? c.slice(0, 7).toLowerCase() : c;
}

/** 3MF transform "m00 m01 m02 m10 ... m32" (row vectors) as a 3x4 [r0 r1 r2 t]. */
function parseTransform(s: string | null, unit: number): number[] {
  if (!s) return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const v = s.trim().split(/\s+/).map(Number);
  return [v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9] * unit, v[10] * unit, v[11] * unit];
}

function mul(a: number[], b: number[]): number[] {
  // Row-vector convention: p' = p * B * A  (child transform first)
  const r = new Array(12).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += b[i * 3 + k] * a[k * 3 + j];
  for (let j = 0; j < 3; j++) {
    r[9 + j] = a[9 + j];
    for (let k = 0; k < 3; k++) r[9 + j] += b[9 + k] * a[k * 3 + j];
  }
  return r;
}

function applyAffine(m: MeshData, t: number[]): MeshData {
  const p = m.positions, out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = x * t[0] + y * t[3] + z * t[6] + t[9];
    out[i + 1] = x * t[1] + y * t[4] + z * t[7] + t[10];
    out[i + 2] = x * t[2] + y * t[5] + z * t[8] + t[11];
  }
  return { positions: out, indices: m.indices };
}

function concat(ms: MeshData[]): MeshData {
  if (ms.length === 1) return ms[0];
  let nv = 0, ni = 0;
  for (const m of ms) { nv += m.positions.length; ni += m.indices.length; }
  const positions = new Float32Array(nv), indices = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const m of ms) {
    positions.set(m.positions, vo);
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + vo / 3;
    vo += m.positions.length;
    io += m.indices.length;
  }
  return { positions, indices };
}

const fmt = (n: number) => (Math.round(n * 1e5) / 1e5).toString();
const escapeXml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
