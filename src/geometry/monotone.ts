// Polygon triangulation without new vertices, the way 3D Builder caps a cut: the polygon (outer
// contour and holes) is split into x-monotone pieces by a sweep in x (then y), and each piece is
// triangulated with the sorted-stack algorithm. Triangles index the input points, counter-clockwise.
// Returns null when the input is too degenerate for the sweep (the caller falls back).

type P = [number, number];

const cross = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const ringArea = (pts: P[], ring: number[]) => {
  let s = 0;
  for (let i = 0; i < ring.length; i++) { const a = pts[ring[i]], b = pts[ring[(i + 1) % ring.length]]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
};

/**
 * @param pts   all points
 * @param rings outer contour first, then its holes (indices into pts), any orientation
 */
export function triangulateMonotone(pts: P[], rings: number[][]): [number, number, number][] | null {
  // Sweep order: by x, then y. Internally the classic top-down sweep runs on (X, Y) = (y, −x), a
  // rotation, so "above" (larger Y, then smaller X) is exactly "smaller x, then smaller y".
  const Q: P[] = pts.map(([x, y]) => [y, -x]);
  const above = (a: number, b: number) => Q[a][1] > Q[b][1] || (Q[a][1] === Q[b][1] && Q[a][0] < Q[b][0]);
  // Interior on the left: outer counter-clockwise, holes clockwise (rotation keeps orientation).
  const R = rings.map((r, k) => ((ringArea(Q, r) > 0) === (k === 0) ? r.slice() : r.slice().reverse()));
  const next = new Map<number, number>(), prev = new Map<number, number>();
  for (const r of R) for (let i = 0; i < r.length; i++) { next.set(r[i], r[(i + 1) % r.length]); prev.set(r[(i + 1) % r.length], r[i]); }
  const verts = R.flat();
  if (new Set(verts).size !== verts.length) return null;
  const order = verts.slice().sort((a, b) => (above(a, b) ? -1 : above(b, a) ? 1 : 0));

  // 1. Monotone partition (sweep status: edges v → next(v) with the interior on their right).
  type Kind = 'start' | 'end' | 'split' | 'merge' | 'regular';
  const kind = (v: number): Kind => {
    const u = prev.get(v)!, w = next.get(v)!;
    const convex = cross(Q[u], Q[v], Q[w]) > 0;
    if (above(v, u) && above(v, w)) return convex ? 'start' : 'split';
    if (above(u, v) && above(w, v)) return convex ? 'end' : 'merge';
    return 'regular';
  };
  const status = new Set<number>(); // edge id = its start vertex
  const helper = new Map<number, number>();
  const diagonals: [number, number][] = [];
  const xAt = (e: number, y: number) => {
    const a = Q[e], b = Q[next.get(e)!];
    if (a[1] === b[1]) return Math.max(a[0], b[0]);
    return a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
  };
  const leftOf = (v: number): number | undefined => {
    let best: number | undefined, bx = -Infinity;
    for (const e of status) {
      const x = xAt(e, Q[v][1]);
      if (x <= Q[v][0] + 1e-12 && x > bx) { bx = x; best = e; }
    }
    return best;
  };
  const kinds = new Map<number, Kind>();
  for (const v of verts) kinds.set(v, kind(v));
  const fixUp = (v: number, e: number | undefined) => {
    if (e === undefined) return;
    const h = helper.get(e);
    if (h !== undefined && kinds.get(h) === 'merge') diagonals.push([v, h]);
  };
  for (const v of order) {
    const k = kinds.get(v)!, ePrev = prev.get(v)!;
    if (k === 'start') { status.add(v); helper.set(v, v); }
    else if (k === 'end') { fixUp(v, ePrev); status.delete(ePrev); }
    else if (k === 'split') {
      const ej = leftOf(v);
      if (ej === undefined) return null;
      diagonals.push([v, helper.get(ej)!]);
      helper.set(ej, v);
      status.add(v); helper.set(v, v);
    } else if (k === 'merge') {
      fixUp(v, ePrev); status.delete(ePrev);
      const ej = leftOf(v);
      if (ej === undefined) return null;
      fixUp(v, ej); helper.set(ej, v);
    } else if (above(prev.get(v)!, v)) {
      // Boundary going down: the interior is on the right.
      fixUp(v, ePrev); status.delete(ePrev);
      status.add(v); helper.set(v, v);
    } else {
      const ej = leftOf(v);
      if (ej === undefined) return null;
      fixUp(v, ej); helper.set(ej, v);
    }
  }

  // 2. Faces of the polygon cut by the diagonals: at each vertex take the first neighbour
  //    clockwise from where we came from (interior on the left).
  const out = new Map<number, number[]>();
  const link = (a: number, b: number) => { const l = out.get(a); if (l) l.push(b); else out.set(a, [b]); };
  for (const v of verts) link(v, next.get(v)!);
  for (const [a, b] of diagonals) { link(a, b); link(b, a); }
  const used = new Set<string>();
  const pieces: number[][] = [];
  for (const [a, list] of out) for (const b0 of list) {
    if (used.has(`${a},${b0}`)) continue;
    const face: number[] = [];
    let u = a, v = b0;
    for (let guard = 0; guard <= verts.length + diagonals.length * 2; guard++) {
      used.add(`${u},${v}`);
      face.push(u);
      const back = Math.atan2(Q[u][1] - Q[v][1], Q[u][0] - Q[v][0]);
      let best = -1, bestTurn = Infinity;
      for (const w of out.get(v)!) {
        if (w === u && out.get(v)!.length > 1) continue;
        // Clockwise angle from the way back to w, in (0, 2π].
        let t = back - Math.atan2(Q[w][1] - Q[v][1], Q[w][0] - Q[v][0]);
        while (t <= 0) t += 2 * Math.PI;
        while (t > 2 * Math.PI) t -= 2 * Math.PI;
        if (t < bestTurn) { bestTurn = t; best = w; }
      }
      u = v; v = best;
      if (u === a && v === b0) break;
    }
    if (face.length >= 3) pieces.push(face);
  }

  // 3. Each x-monotone piece by the sorted-stack algorithm.
  const tris: [number, number, number][] = [];
  for (const face of pieces) {
    const n = face.length;
    if (n === 3) { tris.push([face[0], face[1], face[2]]); continue; }
    const sorted = face.slice().sort((a, b) => (above(a, b) ? -1 : above(b, a) ? 1 : 0));
    const top = sorted[0], bottom = sorted[n - 1];
    // Counter-clockwise from the top runs down the left chain.
    const left = new Set<number>();
    for (let i = face.indexOf(top); face[i] !== bottom; i = (i + 1) % n) left.add(face[i]);
    const isLeft = (v: number) => left.has(v) && v !== top;
    const stack = [sorted[0], sorted[1]];
    for (let j = 2; j < n - 1; j++) {
      const u = sorted[j];
      if (isLeft(u) !== isLeft(stack[stack.length - 1])) {
        while (stack.length > 1) { const s = stack.pop()!; tris.push([u, s, stack[stack.length - 1]]); }
        stack.pop();
        stack.push(sorted[j - 1], u);
      } else {
        let last = stack.pop()!;
        while (stack.length) {
          const t = stack[stack.length - 1];
          const ear = isLeft(u) ? cross(Q[t], Q[last], Q[u]) > 0 : cross(Q[u], Q[last], Q[t]) > 0;
          if (!ear) break;
          tris.push([u, last, t]);
          last = stack.pop()!;
        }
        stack.push(last, u);
      }
    }
    const u = sorted[n - 1];
    while (stack.length > 1) { const s = stack.pop()!; tris.push([u, s, stack[stack.length - 1]]); }
  }
  // Consistent winding (counter-clockwise in the input plane), then a sanity check.
  let sum = 0;
  for (const t of tris) {
    const a = cross(pts[t[0]], pts[t[1]], pts[t[2]]);
    if (a < 0) [t[1], t[2]] = [t[2], t[1]];
    sum += Math.abs(a) / 2;
  }
  const expected = verts.length - 2 + 2 * (rings.length - 1);
  const area = Math.abs(ringArea(pts, rings[0])) - rings.slice(1).reduce((s, r) => s + Math.abs(ringArea(pts, r)), 0);
  if (tris.length !== expected || Math.abs(sum - area) > 1e-6 * Math.max(1, Math.abs(area))) return null;
  return tris;
}
