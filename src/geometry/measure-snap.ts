// "Ancrage" of 3D Builder's Measure tool (CMeasureTool): the point under the cursor jumps to a corner
// of the triangle it lies on when closer than 0.06 inch (1.524 mm), otherwise onto one of its edges
// when closer than 0.03 inch (0.762 mm). On the floor it snaps to the origin (0.06 in) or onto the
// X or Y axis line (0.03 in). Fixed distances in world units, not pixels.

type V = [number, number, number];

export const VERTEX_SNAP = 0.06 * 25.4;
export const EDGE_SNAP = 0.03 * 25.4;

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a: V, b: V) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function snapOnTriangle(p: V, tri: [V, V, V]): { point: V; kind: 'vertex' | 'edge' | 'none' } {
  let best = tri[0], bd = dist(p, tri[0]);
  for (const v of tri) { const d = dist(p, v); if (d < bd) { bd = d; best = v; } }
  if (bd < VERTEX_SNAP) return { point: [...best] as V, kind: 'vertex' };
  let edge: V | null = null, ed = Infinity;
  for (let i = 0; i < 3; i++) {
    const a = tri[i], b = tri[(i + 1) % 3];
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    if (l2 === 0) continue;
    // Closest point on the edge's line (3D Builder tests the lines), clamped to the segment.
    const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
    const q: V = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
    const d = dist(p, q);
    if (d < ed) { ed = d; edge = q; }
  }
  if (edge && ed < EDGE_SNAP) return { point: edge, kind: 'edge' };
  return { point: p, kind: 'none' };
}

export function snapOnFloor(p: V): { point: V; kind: 'vertex' | 'edge' | 'none' } {
  if (Math.hypot(p[0], p[1]) < VERTEX_SNAP) return { point: [0, 0, 0], kind: 'vertex' };
  const dx = Math.abs(p[1]), dy = Math.abs(p[0]); // distance to the X axis line, to the Y axis line
  if (Math.min(dx, dy) < EDGE_SNAP) return { point: dx <= dy ? [p[0], 0, 0] : [0, p[1], 0], kind: 'edge' };
  return { point: [p[0], p[1], 0], kind: 'none' };
}
