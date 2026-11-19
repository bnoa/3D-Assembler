import { describe, expect, it } from 'vitest';
import { snapOnFloor, snapOnTriangle } from '../src/geometry/measure-snap';

describe('Measure "Ancrage" (3D Builder CMeasureTool)', () => {
  const tri: [[number, number, number], [number, number, number], [number, number, number]] = [[0, 0, 0], [20, 0, 0], [0, 20, 0]];

  it('jumps to a corner within 1.524 mm', () => {
    expect(snapOnTriangle([1, 1, 0], tri)).toEqual({ point: [0, 0, 0], kind: 'vertex' });
  });

  it('otherwise moves onto an edge within 0.762 mm', () => {
    const r = snapOnTriangle([10, 0.5, 0], tri);
    expect(r.kind).toBe('edge');
    expect(r.point[1]).toBeCloseTo(0);
    expect(r.point[0]).toBeCloseTo(10);
  });

  it('keeps the raw point elsewhere', () => {
    expect(snapOnTriangle([6, 6, 0], tri).kind).toBe('none');
  });

  it('on the floor snaps to the origin, then to the X or Y axis line', () => {
    expect(snapOnFloor([1, -0.5, 0]).point).toEqual([0, 0, 0]);
    expect(snapOnFloor([30, 0.4, 0]).point).toEqual([30, 0, 0]);
    expect(snapOnFloor([-0.3, 25, 0]).point).toEqual([0, 25, 0]);
    expect(snapOnFloor([30, 12, 0]).kind).toBe('none');
  });
});
