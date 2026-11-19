import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { SceneDocument, movedTransform, objectMatrix, worldMesh } from '../src/core/model';
import { makePrimitive } from '../src/geometry/primitives';

describe('movedTransform (tumbles kept in the object rotation, as 3D Builder)', () => {
  it('gives the same world placement as applying the motion to the transformed object', () => {
    const o = { position: [3, -2, 7] as [number, number, number], rotation: [10, 25, -40] as [number, number, number], scale: [1.5, 0.5, 2] as [number, number, number] };
    const q = new Matrix4().makeTranslation(4, 1, -3).multiply(new Matrix4().makeRotationAxis(new Vector3(1, 2, 0.5).normalize(), 1.1));
    const moved = { ...o, ...movedTransform(o, q) };
    const expected = q.clone().multiply(objectMatrix(o));
    const got = objectMatrix(moved);
    for (const p of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [2, -3, 5]]) {
      const a = new Vector3(...p).applyMatrix4(expected), b = new Vector3(...p).applyMatrix4(got);
      expect(a.distanceTo(b)).toBeLessThan(1e-4);
    }
  });
});

describe('addTransformedMesh (3MF build transforms kept as the object transform)', () => {
  it('places the mesh exactly as the transform and keeps the rotation', () => {
    const doc = new SceneDocument();
    const c = Math.cos(0.9), s = Math.sin(0.9);
    const t = [c, s, 0, -s * 1.5, c * 1.5, 0, 0, 0, 1, 12, -4, 20]; // rotation about Z, ×1.5 on the local Y, moved
    const local = makePrimitive('wedge');
    const o = doc.addTransformedMesh(local, t);
    expect(o.rotation[2]).toBeCloseTo((0.9 * 180) / Math.PI, 4);
    const w = worldMesh(o), p = local.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i] * t[0] + p[i + 1] * t[3] + p[i + 2] * t[6] + t[9];
      const y = p[i] * t[1] + p[i + 1] * t[4] + p[i + 2] * t[7] + t[10];
      expect(w.positions[i]).toBeCloseTo(x, 3);
      expect(w.positions[i + 1]).toBeCloseTo(y, 3);
    }
  });
});
