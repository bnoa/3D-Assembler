import { describe, expect, it } from 'vitest';
import { contactFraction, detentAngle, snapAxis, snapCandidates } from '../src/geometry/align-snap';

describe('Alignement (3D Builder CSnapTool)', () => {
  const cube = { min: [-20, -20, 0], max: [20, 20, 40] };
  const cands = snapCandidates([cube]);

  it('lists the origin then min, max and centre of each other box', () => {
    expect(cands[0]).toEqual([0, -20, 20, 0]);
    expect(cands[2]).toEqual([0, 0, 40, 20]);
  });

  it('brings a box into contact, or lines up its far side, within the threshold', () => {
    // Moved box [20.6, 36.6] on X: its min snaps onto the cube's max (contact).
    expect(snapAxis(20.6, 36.6, cands[0], 1)).toBeCloseTo(-0.6);
    // Box [-4.3, 19.4]: its max lines up with the cube's max.
    expect(snapAxis(-4.3, 19.4, cands[0], 1)).toBeCloseTo(0.6);
    // Too far from everything: no correction.
    expect(snapAxis(30, 50, cands[0], 1)).toBe(0);
  });

  it('lets the centre snap too, including to the origin (3D Builder skips the first two candidates)', () => {
    expect(snapAxis(-9.5, 10.3, [0], 1)).toBeCloseTo(-0.4);
  });

  it('holds rotations at every 45° within 5°', () => {
    expect(detentAngle((47 * Math.PI) / 180)).toBeCloseTo(Math.PI / 4);
    expect(detentAngle((52 * Math.PI) / 180)).toBeCloseTo((52 * Math.PI) / 180);
    expect(detentAngle((-88 * Math.PI) / 180)).toBeCloseTo(-Math.PI / 2);
  });
});

describe('Collision (as 3D Builder: boxes, stop in contact, no sliding)', () => {
  const box = (x: number, y: number, s = 40) => ({ min: [x - s / 2, y - s / 2, 0], max: [x + s / 2, y + s / 2, s] });
  it('stops a cube pushed into another exactly in contact (X = 40), however far the mouse goes', () => {
    const t = contactFraction([box(43.48, 0)], [box(0, 0)], [-200, 0, 0]);
    expect(43.48 - 200 * t).toBeCloseTo(40, 9);
  });
  it('tests boxes, not shapes: spheres offset by 26.6 in Y stop at X = 40', () => {
    const t = contactFraction([box(54.77, -26.6)], [box(0, 0)], [-100, 0, 0]);
    expect(54.77 - 100 * t).toBeCloseTo(40, 9);
  });
  it('does not slide along the obstacle: a diagonal move from contact does not move at all', () => {
    expect(contactFraction([box(40, -26.6)], [box(0, 0)], [-30, 20, 0])).toBe(0);
  });
  it('lets objects that overlap at the start be pulled apart, and free moves go all the way', () => {
    expect(contactFraction([box(10, 0)], [box(0, 0)], [50, 0, 0])).toBe(1);
    expect(contactFraction([box(100, 0)], [box(0, 0)], [0, 50, 0])).toBe(1);
  });
});
