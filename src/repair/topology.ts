// Edge/shell topology helpers shared by analysis and repair.

export const edgeKey = (a: number, b: number, nv: number) => (a < b ? a * nv + b : b * nv + a);

export interface EdgeUse {
  a: number; // first vertex as seen by the first face
  b: number;
  faces: number[];
  forward: number; // faces using a->b
  backward: number; // faces using b->a
}

export function buildEdges(indices: ArrayLike<number>, nv: number): Map<number, EdgeUse> {
  const edges = new Map<number, EdgeUse>();
  const nt = indices.length / 3;
  for (let f = 0; f < nt; f++) {
    for (let k = 0; k < 3; k++) {
      const a = indices[f * 3 + k], b = indices[f * 3 + ((k + 1) % 3)];
      const key = edgeKey(a, b, nv);
      let e = edges.get(key);
      if (!e) {
        e = { a, b, faces: [], forward: 0, backward: 0 };
        edges.set(key, e);
      }
      e.faces.push(f);
      if (a === e.a) e.forward++;
      else e.backward++;
    }
  }
  return edges;
}

/** Connected components of faces, joined across edges (any number of incident faces). */
export function shells(indices: ArrayLike<number>, nv: number, edges = buildEdges(indices, nv)): Int32Array {
  const nt = indices.length / 3;
  const parent = new Int32Array(nt).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const e of edges.values()) {
    for (let i = 1; i < e.faces.length; i++) {
      const ra = find(e.faces[0]), rb = find(e.faces[i]);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const label = new Int32Array(nt);
  const ids = new Map<number, number>();
  for (let f = 0; f < nt; f++) {
    const r = find(f);
    let id = ids.get(r);
    if (id === undefined) {
      id = ids.size;
      ids.set(r, id);
    }
    label[f] = id;
  }
  return label;
}

/** Boundary loops as vertex sequences, oriented like the boundary edges of their faces. */
export function boundaryLoops(indices: ArrayLike<number>, nv: number, edges = buildEdges(indices, nv)): number[][] {
  // Directed boundary edges a->b (edge used by exactly one face).
  const next = new Map<number, number[]>();
  for (const e of edges.values()) {
    if (e.faces.length !== 1) continue;
    const a = e.forward ? e.a : e.b;
    const b = e.forward ? e.b : e.a;
    const list = next.get(a);
    if (list) list.push(b);
    else next.set(a, [b]);
  }
  const loops: number[][] = [];
  for (const start of [...next.keys()]) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const loop = [start];
      let cur = start;
      for (let guard = 0; guard < 1e7; guard++) {
        const outs = next.get(cur);
        if (!outs || outs.length === 0) break;
        const nxt = outs.pop()!;
        if (nxt === start) break;
        loop.push(nxt);
        cur = nxt;
      }
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}
