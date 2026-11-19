import { describe, expect, it } from 'vitest';
import { MAX_FOV, VIEW_PLATE, frameBox } from '../src/render/camera-controls';

// Reference poses measured in 3D Builder (maximised window, 3D view 1456 × 742).
const ASPECT = 1456 / 742;
const deg = (r: number) => (r * 180) / Math.PI;

describe('camera framing as 3D Builder', () => {
  it('keeps the plate diagonal as distance and narrows the field of view for a small object', () => {
    const p = frameBox({ min: [-20, -20, 0], max: [20, 20, 40] }, ASPECT);
    expect(p.eye.distanceTo(p.target)).toBeCloseTo(152.4 * Math.sqrt(3), 3);
    expect(p.target.toArray()).toEqual([0, 0, 20]);
    expect(deg(p.fov)).toBeCloseTo(24.6, 1);
    expect(p.eye.y).toBeCloseTo(-236.1, 1);
    expect(p.eye.z).toBeCloseTo(138.0, 1);
  });

  it('moves back with the widest field of view for a large object and for the empty plate', () => {
    const bar = frameBox({ min: [-100, -20, 0], max: [100, 20, 40] }, ASPECT);
    expect(bar.fov).toBe(MAX_FOV);
    expect(bar.eye.distanceTo(bar.target)).toBeGreaterThan(152.4 * Math.sqrt(3));
    const plate = frameBox(VIEW_PLATE, ASPECT);
    expect(plate.fov).toBe(MAX_FOV);
    expect(plate.eye.distanceTo(plate.target)).toBeCloseTo(491.5, 0);
  });
});
