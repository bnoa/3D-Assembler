import { describe, expect, it } from 'vitest';
import { importFile } from '../src/io/formats';

// The loader reads the embedded data with browser events that Node lacks.
(globalThis as { ProgressEvent?: unknown }).ProgressEvent ??= class extends Event { loaded = 0; total = 0; lengthComputable = false; };

/** A .gltf with two coloured boxes in metres (node scale 0.001), the second tall along glTF's Y. */
function twoBoxes(): string {
  const box = (sx: number, sy: number, sz: number, ox: number) => {
    const c = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
    const p = new Float32Array(c.flatMap((v) => [v[0] * sx + ox, v[1] * sy, v[2] * sz]));
    const i = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3]);
    return { p, i };
  };
  const a = box(10, 10, 10, 0), b = box(10, 30, 10, 20);
  const parts = [a.p, a.i, b.p, b.i].map((x) => new Uint8Array(x.buffer));
  const views: object[] = [];
  let off = 0;
  for (const x of parts) { views.push({ buffer: 0, byteOffset: off, byteLength: x.length }); off += Math.ceil(x.length / 4) * 4; }
  const bin = new Uint8Array(off);
  off = 0;
  for (const x of parts) { bin.set(x, off); off += Math.ceil(x.length / 4) * 4; }
  const acc = (v: number, t: 'VEC3' | 'SCALAR', p?: Float32Array) => ({
    bufferView: v, componentType: t === 'VEC3' ? 5126 : 5123, count: t === 'VEC3' ? 8 : 36, type: t,
    ...(p ? { min: [0, 1, 2].map((k) => Math.min(...p.filter((_, j) => j % 3 === k))), max: [0, 1, 2].map((k) => Math.max(...p.filter((_, j) => j % 3 === k))) } : {}),
  });
  return JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'Rouge', mesh: 0, scale: [0.001, 0.001, 0.001] }, { name: 'Vert', mesh: 1, scale: [0.001, 0.001, 0.001] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }, { primitives: [{ attributes: { POSITION: 2 }, indices: 3, material: 1 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }, { pbrMetallicRoughness: { baseColorFactor: [0, 1, 0, 1] } }],
    accessors: [acc(0, 'VEC3', a.p), acc(1, 'SCALAR'), acc(2, 'VEC3', b.p), acc(3, 'SCALAR')],
    bufferViews: views,
    buffers: [{ byteLength: bin.length, uri: 'data:application/octet-stream;base64,' + Buffer.from(bin).toString('base64') }],
  });
}

const size = (p: Float32Array) => [0, 1, 2].map((k) => {
  let lo = Infinity, hi = -Infinity;
  for (let i = k; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
  return Math.round(hi - lo);
});

describe('glTF import (as 3D Builder)', () => {
  it('keeps one object per mesh with its colour, in millimetres, Z up', async () => {
    const objs = await importFile(new File([twoBoxes()], 'two.gltf'));
    expect(objs.map((o) => o.name)).toEqual(['Rouge', 'Vert']);
    expect(objs.map((o) => o.color)).toEqual(['#ff0000', '#00ff00']);
    expect(size(objs[0].mesh.positions)).toEqual([10, 10, 10]);
    expect(size(objs[1].mesh.positions)).toEqual([10, 10, 30]);
  });

  it('reads a .gltf whose data is in a .bin next to it (as 3D Builder saves it), and refuses it without', async () => {
    const j = JSON.parse(twoBoxes());
    const bin = Uint8Array.from(Buffer.from(j.buffers[0].uri.split(',')[1], 'base64'));
    j.buffers[0].uri = 'two.bin';
    const file = new File([JSON.stringify(j)], 'two.gltf');
    const objs = await importFile(file, { companions: new Map([['two.bin', bin]]) });
    expect(size(objs[1].mesh.positions)).toEqual([10, 10, 30]);
    await expect(importFile(file)).rejects.toThrow('two.bin');
  });
});
