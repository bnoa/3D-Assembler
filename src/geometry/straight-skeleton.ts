// Straight skeleton of a polygon with holes, by wavefront propagation: every edge moves inwards at
// unit speed, its ends sliding along the angle bisectors. Two kinds of events change the wavefront:
// an edge shrinking to nothing (edge event) and a reflex corner running into another edge (split
// event, which also merges a hole's wavefront with the outer one). Each input edge sweeps one face;
// the time at which the front passes a point is its height on the 45° roof.

export interface Skeleton {
  /** Nodes: x, y and the time the wavefront reached them (0 for the input corners). */
  vertices: [number, number, number][];
  /** One face per input edge (indices into vertices), starting with the edge's two corners. */
  polygons: number[][];
}

type V2 = [number, number];

interface Edge { a: V2; d: V2; n: V2; c: number }

interface Vert {
  /** Position extrapolated to time 0 (position at time t = p0 + t·v). */
  p0: V2;
  v: V2;
  node: number;
  eL: number;
  eR: number;
  prev: Vert;
  next: Vert;
  alive: boolean;
}

type Event =
  | { kind: 'edge'; t: number; a: Vert; b: Vert }
  | { kind: 'split'; t: number; v: Vert; e: number };

class Heap {
  private h: Event[] = [];
  get size() { return this.h.length; }
  push(e: Event) {
    const h = this.h;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(h[p], h[i])) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  }
  pop(): Event {
    const h = this.h, top = h[0], last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < h.length && less(h[l], h[m])) m = l;
        if (r < h.length && less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]];
        i = m;
      }
    }
    return top;
  }
}
// Earlier first; at the same time, edge events before split events.
const less = (x: Event, y: Event) => (x.t !== y.t ? x.t < y.t : x.kind === 'edge' && y.kind !== 'edge');

const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0];
const at = (v: Vert, t: number): V2 => [v.p0[0] + t * v.v[0], v.p0[1] + t * v.v[1]];

/**
 * Straight skeleton of closed rings (the outer one counter-clockwise, holes clockwise; a ring may
 * repeat its first point at the end). Null when the input defeats it (a face that does not close).
 */
export function straightSkeleton(rings: number[][][]): Skeleton | null {
  const edges: Edge[] = [];
  const nodes: [number, number, number][] = [];
  const arcs: { a: number; b: number; eL: number; eR: number }[] = [];
  const firstNode: number[] = []; // per edge: its start corner's node
  const lastNode: number[] = [];
  let size = 0;
  const loops: V2[][] = [];
  for (const raw of rings) {
    const r = raw.map(([x, y]) => [x, y] as V2);
    if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
    const clean: V2[] = [];
    for (const p of r) if (!clean.length || Math.hypot(p[0] - clean[clean.length - 1][0], p[1] - clean[clean.length - 1][1]) > 0) clean.push(p);
    while (clean.length > 1 && clean[0][0] === clean[clean.length - 1][0] && clean[0][1] === clean[clean.length - 1][1]) clean.pop();
    if (clean.length < 3) continue;
    loops.push(clean);
    for (const p of clean) size = Math.max(size, Math.abs(p[0]), Math.abs(p[1]));
  }
  if (!loops.length) return null;
  const eps = Math.max(size, 1) * 1e-9;
  const near = 1e3 * eps;

  // Nodes at the same place and time are shared, so that faces close on the same indices.
  const grid = new Map<string, number[]>();
  const cell = near * 4;
  const nodeAt = (p: V2, t: number): number => {
    const kx = Math.floor(p[0] / cell), ky = Math.floor(p[1] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of grid.get(`${kx + dx},${ky + dy}`) ?? []) {
        const q = nodes[i];
        if (Math.abs(q[0] - p[0]) <= near && Math.abs(q[1] - p[1]) <= near && Math.abs(q[2] - t) <= near) return i;
      }
    }
    nodes.push([p[0], p[1], t]);
    const k = `${kx},${ky}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(nodes.length - 1);
    return nodes.length - 1;
  };

  const heap = new Heap();
  const byEdge = new Map<number, Set<Vert>>(); // edge -> live vertices whose right edge it is
  const velocity = (eL: number, eR: number): V2 | null => {
    const nL = edges[eL].n, nR = edges[eR].n;
    const k = 1 + dot(nL, nR);
    if (k < 1e-10) return null; // opposite edges: the front has closed there
    return [(nL[0] + nR[0]) / k, (nL[1] + nR[1]) / k];
  };
  const reflex = (eL: number, eR: number) => cross(edges[eL].d, edges[eR].d) < -1e-12;

  let now = 0;
  const pushEdge = (a: Vert) => {
    const b = a.next;
    if (!a.alive || !b.alive || a === b) return;
    const d = edges[a.eR].d;
    const rate = dot([b.v[0] - a.v[0], b.v[1] - a.v[1]], d);
    if (rate >= -1e-12) return;
    const t = -dot([b.p0[0] - a.p0[0], b.p0[1] - a.p0[1]], d) / rate;
    if (t >= now - near) heap.push({ kind: 'edge', t: Math.max(t, now), a, b });
  };
  const pushSplits = (v: Vert) => {
    if (!reflex(v.eL, v.eR)) return;
    for (let e = 0; e < edges.length; e++) {
      if (e === v.eL || e === v.eR) continue;
      const E = edges[e];
      const k = dot(E.n, v.v) - 1;
      if (k >= -1e-12) continue;
      const f = dot(E.n, at(v, now)) - E.c - now; // ahead of the edge's front
      if (f < -near) continue;
      const t = (E.c - dot(E.n, v.p0)) / k;
      if (t >= now - near) heap.push({ kind: 'split', t: Math.max(t, now), v, e });
    }
  };
  const track = (v: Vert) => { (byEdge.get(v.eR) ?? byEdge.set(v.eR, new Set()).get(v.eR)!).add(v); };
  const kill = (v: Vert) => { v.alive = false; byEdge.get(v.eR)?.delete(v); };
  const arc = (from: number, to: number, eL: number, eR: number) => { if (from !== to) arcs.push({ a: from, b: to, eL, eR }); };

  // Initial wavefront.
  for (const loop of loops) {
    const base = edges.length;
    loop.forEach((p, i) => {
      const q = loop[(i + 1) % loop.length];
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const d: V2 = [(q[0] - p[0]) / L, (q[1] - p[1]) / L];
      const n: V2 = [-d[1], d[0]]; // interior on the left
      edges.push({ a: p, d, n, c: dot(n, p) });
    });
    const vs: Vert[] = loop.map((p, i) => {
      const eR = base + i, eL = base + ((i + loop.length - 1) % loop.length);
      const node = nodeAt(p, 0);
      firstNode[eR] = node;
      lastNode[eL] = node;
      return { p0: p, v: [0, 0], node, eL, eR, prev: null!, next: null!, alive: true };
    });
    vs.forEach((v, i) => {
      v.prev = vs[(i + vs.length - 1) % vs.length];
      v.next = vs[(i + 1) % vs.length];
      const vel = velocity(v.eL, v.eR);
      if (!vel) v.alive = false;
      else v.v = vel;
      track(v);
    });
    if (vs.some((v) => !v.alive)) return null;
  }
  const all: Vert[] = [];
  for (const set of byEdge.values()) all.push(...set);
  for (const v of all) { pushEdge(v); pushSplits(v); }

  /** A new vertex of the front at p (time t) between edges eL and eR; null if the front closed. */
  const make = (p: V2, t: number, eL: number, eR: number, node: number): Vert => {
    const vel = velocity(eL, eR) ?? [0, 0];
    return { p0: [p[0] - t * vel[0], p[1] - t * vel[1]], v: vel, node, eL, eR, prev: null!, next: null!, alive: true };
  };
  /** Closes the loops of fewer than three vertices left around v. */
  const settle = (v: Vert) => {
    if (!v.alive) return;
    if (v.next === v) { kill(v); return; }
    if (v.next.next === v) {
      arc(v.node, v.next.node, v.eR, v.eL);
      kill(v.next);
      kill(v);
    }
  };
  /** The consecutive vertices of ring meet at x (time t): one vertex replaces them. */
  const join = (ring: Vert[], x: V2, t: number, X: number) => {
    const first = ring[0], last = ring[ring.length - 1];
    for (const v of ring) arc(v.node, X, v.eL, v.eR);
    const before = first.prev, after = last.next;
    for (const v of ring) kill(v);
    if (before === last || !before.alive) return; // the whole loop ended here
    if (before === after) { arc(before.node, X, before.eL, before.eR); kill(before); return; }
    const nv = make(x, t, first.eL, last.eR, X);
    nv.prev = before; nv.next = after; before.next = nv; after.prev = nv;
    fresh(nv);
  };
  /**
   * A vertex between two opposite edges: the front has closed along their common line (two
   * parallel sides of a stroke meeting). The overlap zips shut at once: the vertex runs along the
   * line to the nearer of its neighbours, tracing the ridge, and they merge there.
   */
  const zip = (n: Vert) => {
    const x = n.p0, P = n.prev, Q = n.next;
    const pp = at(P, now), qq = at(Q, now);
    const dP = dist(pp, x), dQ = dist(qq, x);
    if (Math.abs(dP - dQ) <= near) join([P, n, Q], pp, now, nodeAt(pp, now));
    else if (dP < dQ) join([P, n], pp, now, nodeAt(pp, now));
    else join([n, Q], qq, now, nodeAt(qq, now));
  };
  const fresh = (v: Vert) => {
    track(v);
    settle(v);
    if (!v.alive) return;
    if (v.v[0] === 0 && v.v[1] === 0) { zip(v); return; }
    pushEdge(v.prev);
    pushEdge(v);
    pushSplits(v);
  };

  let guard = 0;
  const limit = 200 * (all.length + 10) * (all.length + 10);
  while (heap.size) {
    if (++guard > limit) return null;
    const ev = heap.pop();
    if (ev.kind === 'edge') {
      const { a, b } = ev;
      if (!a.alive || !b.alive || a.next !== b) continue;
      now = Math.max(now, ev.t);
      const x = at(a, ev.t);
      const X = nodeAt(x, ev.t);
      // Every vertex arriving at the same point at this time joins the event.
      let first = a, last = b;
      while (first.prev !== last && first.prev.alive && dist(at(first.prev, ev.t), x) <= near) first = first.prev;
      while (last.next !== first && last.next.alive && dist(at(last.next, ev.t), x) <= near) last = last.next;
      const ring: Vert[] = [];
      for (let v = first; ; v = v.next) { ring.push(v); if (v === last) break; }
      join(ring, x, ev.t, X);
    } else {
      const { v, e } = ev;
      if (!v.alive) continue;
      const t = ev.t;
      const x = at(v, t);
      const E = edges[e];
      // The piece of edge e that the corner runs into, among the live ones.
      let hit: Vert | null = null;
      for (const w of byEdge.get(e) ?? []) {
        if (!w.alive || w === v || w.next === v || w === v.prev) continue;
        const s0 = dot([x[0] - at(w, t)[0], x[1] - at(w, t)[1]], E.d);
        const s1 = dot([x[0] - at(w.next, t)[0], x[1] - at(w.next, t)[1]], E.d);
        if (s0 >= -near && s1 <= near && Math.abs(dot(E.n, x) - E.c - t) <= near * 10) { hit = w; break; }
      }
      if (!hit) continue;
      now = Math.max(now, t);
      const X = nodeAt(x, t);
      arc(v.node, X, v.eL, v.eR);
      const P = v.prev, N = v.next, W = hit, Wn = hit.next;
      kill(v);
      const v1 = make(x, t, v.eL, e, X); // continues v's left side, then edge e towards Wn
      const v2 = make(x, t, e, v.eR, X); // edge e from W, then v's right side
      v1.prev = P; P.next = v1; v1.next = Wn; Wn.prev = v1;
      v2.prev = W; W.next = v2; v2.next = N; N.prev = v2;
      fresh(v1);
      fresh(v2);
    }
  }

  // Faces: each edge's face is its two corners and the arcs that bound it, chained.
  const polygons: number[][] = [];
  const faceArcs = new Map<number, [number, number][]>();
  for (const a of arcs) {
    for (const e of [a.eL, a.eR]) (faceArcs.get(e) ?? faceArcs.set(e, []).get(e)!).push([a.a, a.b]);
  }
  for (let e = 0; e < edges.length; e++) {
    const start = firstNode[e], end = lastNode[e];
    const adj = new Map<number, number[]>();
    for (const [p, q] of faceArcs.get(e) ?? []) {
      (adj.get(p) ?? adj.set(p, []).get(p)!).push(q);
      (adj.get(q) ?? adj.set(q, []).get(q)!).push(p);
    }
    // Walk from the edge's end corner back to its start corner through the skeleton.
    const path = [start, end];
    const used = new Set<string>();
    let cur = end, prev = start, ok = false;
    for (let steps = 0; steps < adj.size + 2; steps++) {
      const options = (adj.get(cur) ?? []).filter((n) => !used.has(key(cur, n)));
      if (!options.length) break;
      // Several ways on (shared nodes): the one turning most to the left keeps to this face.
      let nextNode = options[0];
      if (options.length > 1) nextNode = leftmost(nodes, prev, cur, options);
      used.add(key(cur, nextNode));
      if (nextNode === start) { ok = true; break; }
      path.push(nextNode);
      prev = cur;
      cur = nextNode;
    }
    if (!ok) return null;
    polygons.push(path);
  }
  return { vertices: nodes, polygons };
}

const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

/** Among the candidates, the one making the sharpest left turn at cur (coming from prev). */
function leftmost(nodes: [number, number, number][], prev: number, cur: number, options: number[]): number {
  const p = nodes[prev], c = nodes[cur];
  const inA = Math.atan2(c[1] - p[1], c[0] - p[0]);
  let best = options[0], bestTurn = -Infinity;
  for (const o of options) {
    const q = nodes[o];
    let turn = Math.atan2(q[1] - c[1], q[0] - c[0]) - inA;
    while (turn <= -Math.PI) turn += 2 * Math.PI;
    while (turn > Math.PI) turn -= 2 * Math.PI;
    if (turn > bestTurn) { bestTurn = turn; best = o; }
  }
  return best;
}
