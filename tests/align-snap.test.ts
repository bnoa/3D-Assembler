import { describe, expect, it } from 'vitest';
import { detentAngle, snapAxis, snapCandidates } from '../src/geometry/align-snap';

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
