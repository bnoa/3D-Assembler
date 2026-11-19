// Real textures on an object, as 3D Builder stores them (3MF texture2d + texture2dgroup): a list
// of images, and per face the image it shows (or none) and the texture coordinates of its three
// corners.
import type { MeshData } from './mesh-data';

export interface TextureImage {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA, rows from the top
  /** Wallpaper tiles the image; a sticker shows one copy (transparent outside). */
  wrap: 'repeat' | 'clamp';
  /** Encoded image still to decode (JPEG read from a 3MF: decoded by the browser on import). */
  source?: { bytes: Uint8Array; type: string };
}

export interface ObjectTexture {
  images: TextureImage[];
  /** Image index of each face, -1 = no texture (the face shows its colour). */
  face: Int16Array;
  /** Texture coordinates (u, v) of the three corners of each face: 6 numbers per face. */
  uv: Float32Array;
}

export function emptyTexture(faces: number): ObjectTexture {
  return { images: [], face: new Int16Array(faces).fill(-1), uv: new Float32Array(faces * 6) };
}

export const hasTexture = (t?: ObjectTexture) => !!t && t.face.some((i) => i >= 0);

/** Index of `img` in the texture's images, added if new (3D Builder adds one per stroke). */
export function imageIndex(t: ObjectTexture, img: TextureImage): number {
  const i = t.images.indexOf(img);
  if (i >= 0) return i;
  t.images.push(img);
  return t.images.length - 1;
}

/** Copy of the texture without the image references no face uses any more. */
export function compactTexture(t: ObjectTexture): ObjectTexture | undefined {
  const used = new Map<number, number>();
  const images: TextureImage[] = [];
  const face = new Int16Array(t.face.length);
  for (let f = 0; f < t.face.length; f++) {
    const i = t.face[f];
    if (i < 0) { face[f] = -1; continue; }
    let j = used.get(i);
    if (j === undefined) { j = images.length; images.push(t.images[i]); used.set(i, j); }
    face[f] = j;
  }
  return images.length ? { images, face, uv: t.uv } : undefined;
}

/** Textures of several meshes merged in order (faces without texture: -1). */
export function mergeTextures(parts: { faces: number; texture?: ObjectTexture }[]): ObjectTexture | undefined {
  if (!parts.some((p) => hasTexture(p.texture))) return undefined;
  const total = parts.reduce((s, p) => s + p.faces, 0);
  const out = emptyTexture(total);
  let off = 0;
  for (const p of parts) {
    if (p.texture) {
      const map = p.texture.images.map((img) => imageIndex(out, img));
      for (let f = 0; f < p.faces; f++) {
        const i = p.texture.face[f];
        if (i >= 0) { out.face[off + f] = map[i]; out.uv.set(p.texture.uv.subarray(f * 6, f * 6 + 6), (off + f) * 6); }
      }
    }
    off += p.faces;
  }
  return out;
}

/**
 * Texture of `dst` whose faces lie on the faces of `src` (repair, booleans, split…): each face takes
 * the image of the source face `nearest[f]` and texture coordinates interpolated at its corners.
 */
export function transferTexture(src: MeshData, tex: ObjectTexture, dst: MeshData, nearest: Int32Array): ObjectTexture | undefined {
  const nt = dst.indices.length / 3;
  const out: ObjectTexture = { images: tex.images, face: new Int16Array(nt).fill(-1), uv: new Float32Array(nt * 6) };
  const P = src.positions, I = src.indices, Q = dst.positions, J = dst.indices;
  for (let f = 0; f < nt; f++) {
    const g = nearest[f];
    const img = tex.face[g];
    if (img < 0) continue;
    out.face[f] = img;
    const a = [0, 1, 2].map((k) => [P[I[g * 3 + k] * 3], P[I[g * 3 + k] * 3 + 1], P[I[g * 3 + k] * 3 + 2]]);
    const e1 = a[1].map((v, k) => v - a[0][k]), e2 = a[2].map((v, k) => v - a[0][k]);
    const d11 = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2], d12 = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2];
    const d22 = e2[0] * e2[0] + e2[1] * e2[1] + e2[2] * e2[2];
    const den = d11 * d22 - d12 * d12 || 1;
    for (let k = 0; k < 3; k++) {
      const v = J[f * 3 + k];
      const w = [Q[v * 3] - a[0][0], Q[v * 3 + 1] - a[0][1], Q[v * 3 + 2] - a[0][2]];
      const w1 = w[0] * e1[0] + w[1] * e1[1] + w[2] * e1[2], w2 = w[0] * e2[0] + w[1] * e2[1] + w[2] * e2[2];
      const l1 = (d22 * w1 - d12 * w2) / den, l2 = (d11 * w2 - d12 * w1) / den, l0 = 1 - l1 - l2;
      for (let c = 0; c < 2; c++) out.uv[f * 6 + k * 2 + c] = l0 * tex.uv[g * 6 + c] + l1 * tex.uv[g * 6 + 2 + c] + l2 * tex.uv[g * 6 + 4 + c];
    }
  }
  return compactTexture(out);
}
