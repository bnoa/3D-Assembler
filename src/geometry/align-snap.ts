// "Alignement" as 3D Builder's CSnapTool: while objects are moved, the min, max and centre of the
// moved selection's bounding box snap, axis by axis, to the world origin (0) and to the min, max and
// centre of every other object's bounding box. The nearest candidate wins when the gap is under a
// threshold of about 1 % of the viewport height (in world units at the selection's depth). There is
// no grid. 3D Builder only lets the centre snap to candidates from the third on (it never snaps to
// the origin or to the first object's min, an off-by-one); 3D Assembler tests the centre against all.

export interface Box {
  min: ArrayLike<number>;
  max: ArrayLike<number>;
}

/** Candidate coordinates per axis: 0, then min, max and centre of each box. */
export function snapCandidates(others: Box[]): [number[], number[], number[]] {
  const c: [number[], number[], number[]] = [[0], [0], [0]];
  for (const b of others) {
    for (let k = 0; k < 3; k++) c[k].push(b.min[k], b.max[k], (b.min[k] + b.max[k]) / 2);
  }
  return c;
}

/** Correction to add along one axis so the box [min, max] snaps (0 when nothing is close enough). */
export function snapAxis(min: number, max: number, candidates: number[], threshold: number): number {
  const mid = (min + max) / 2;
  let best = Infinity;
  for (const c of candidates) {
    for (const v of [min, max, mid]) {
      const gap = c - v;
      if (Math.abs(gap) < Math.abs(best)) best = gap;
    }
  }
  return Math.abs(best) < threshold ? best : 0;
}

/** Rotation detents: every 45°, catching the angle within 5° of the mark. */
export const ROTATION_DETENT = Math.PI / 4;
export const ROTATION_CATCH = (5 * Math.PI) / 180;

export function detentAngle(a: number): number {
  const n = Math.round(a / ROTATION_DETENT) * ROTATION_DETENT;
  return Math.abs(a - n) < ROTATION_CATCH ? n : a;
}
