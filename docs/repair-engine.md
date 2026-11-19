# The repair engine of 3D Builder

Behaviour of the 3D Builder 20.0.4.0 repair, recorded in November 2026 by comparing its results on test files.

This document describes **behaviour** only. The code of 3D Assembler is independent.

## What 3D Builder does when you click Repair (« Réparer »)

The application **always runs the same repair sequence**, the most complete one ("Extended"). The user cannot choose a lighter repair level.

The work is asynchronous, one scene object at a time. If repairing object by object produces no output object, the objects are combined and then repaired together.

### The "Extended" sequence

**N. Normalisation**
- The object is translated so that its minimum corner is at the origin.
- It is scaled so that its longest side is between **5 and 400**: s = 5/side below 5, s = 400/side above 400.
- All thresholds below are expressed in this frame: they are millimetres for an object of 5 to 400 mm, and relative values beyond that.

**The steps, in a single pass, with no loop**

| # | Filter | Parameter |
|---|---|---|
| 1 | Gap stitching | 0.01, consistent orientation required |
| 2 | Filling trivial holes (2 or 3 edges) | — |
| 3 | Removing duplicate triangles | prior merge of vertices closer than 1e-4 |
| 4 | Fixing flipped triangles | — |
| 5 | Filling trivial holes | — |
| 6 | Gap stitching | 0.01, free orientation |
| 7 | Fixing flipped triangles | — |
| 8 | Filling all holes | — |
| 9 | **Wrap** | grid step 0.001 |
| 10 | Removing degenerate faces | grid step 0.002 |
| 11 | Removing small shells | volume below 0.001 |
| 12 | Export preparation | weld on a 0.001 grid |

**D. Return** to the original scale and position.

### Filter details

**Gap stitching**
1. Merge vertices closer than 1e-4.
2. KD tree of the vertices lying on an open boundary.
3. Vertex-to-vertex merges, shortest distance first, as long as the distance is below the tolerance. The kept vertex keeps its position: nothing is averaged.
4. T-junctions: a vertex close to the interior of an open boundary edge, and further than the tolerance from both its ends, splits the face of that edge in two. The vertex itself does not move.
5. Welding of boundary edges that join the same vertices. With the "consistent orientation" option, only if their faces run along that edge in opposite directions.

**Duplicate triangles**: same triple of vertices, whatever the winding order. One is kept; its colours and materials are preserved if possible.

**Flipped triangles**
- For each region connected by edges with two faces, the faces are split into two groups according to their relative orientation.
- The group with the **smaller total area** is flipped.
- Non-orientable regions (Möbius-strip-like) are ignored.

**Hole filling**
- Loops that pass through the same vertex more than once are first split into simple loops.
- 2-edge hole: the two edges are welded. 3-edge hole: a triangle is added.
- Beyond that: **minimum total area triangulation by dynamic programming** (in O(n³)). The weight of a triangle is its area; a triangle whose doubled area is below 1e-4 gets a penalty of 10,000.
- No interior point added, no smoothing, no maximum size.

**Wrap** (exact topological Boolean)
1. Grid step = diagonal / 100,000, bounded between 1e-6 and 1.
2. Edges that are too long are halved until they are shorter than 30,400 grid steps.
3. Coordinates are rounded to integers. Triangles that became flat are dropped.
4. All intersections between triangles are computed.
5. Exact re-triangulation plane by plane. Overlapping coplanar faces are merged.
6. Faces are grouped into components; intersections link nested pieces.
7. For each component, an axis-parallel ray finds a face and its outer side.
8. Outside air spreads from face to face: around each edge, the next face by angle is taken.
9. A face is kept if **exactly one** of its sides touches outside air. Interior walls and zero-thickness sheets disappear.
10. A component entirely enclosed in the material of another is removed.
11. On output, faces are oriented towards the air and non-manifold edges are separated in pairs.

**Degenerate faces**
1. Edges that are too long are split, then vertices are rounded onto the grid.
2. A face is degenerate if its area is **exactly zero** on the grid.
3. Fix: **flip of the longest edge** with the neighbouring face. If the face is on an open boundary, it is removed. If the two faces share all three vertices, both are removed.
4. The result stays aligned with the grid.

**Small shells**: shells whose signed volume, in absolute value, is below the threshold are removed. This is an absolute threshold; there is no triangle-count criterion.

**Export preparation**
1. Weld vertices that fall into the same grid cell, and remove faces that collapse.
2. Edges shared by more than two faces are separated by inserting distinct vertices at k/n of their length.

**Walls too thin**: there is no local thickening. The application offers to enlarge the whole object up to the material's minimum thickness.

## Mapping to 3D Assembler (`src/repair/repair.ts`)

| 3D Builder step | 3D Assembler |
|---|---|
| N / D | `normalisationScale` + translation, as in 3D Builder |
| 1, 6 Stitching | `stitch`: vertex-to-vertex weld, then `stitchTJunctions` |
| 2, 5, 8 Holes | `closeHoles(w, 3)` then `closeHoles(w, ∞)`; `minAreaTriangulation` (same method), plus a penalty on diagonals that already exist elsewhere |
| 3 Duplicates | `removeDuplicates`. Difference: two identical opposite faces (zero-thickness wall) are removed together |
| 4, 7 Flipped | `orient`: majority vote by area, as in 3D Builder |
| 9 Wrap | `src/repair/wrap.ts`, called by `repairSolid` as soon as triangles intersect: same integer grid (diagonal / 100,000), same intersections, re-triangulation **plane by plane** with overlap counting, same air propagation in angular order. Differences: see below |
| 10 Degenerate | `removeDegenerate`: 0.002 grid and flip of the longest edge, as in 3D Builder |
| 11 Small shells | `removeTinyShells`: absolute volume below 0.001, as in 3D Builder |
| 12 Export | weld at 0.001, then `splitNonManifold`: vertices are duplicated instead of inserting points at k/n |

## The 3D Assembler Wrap

3D Builder works in exact rational arithmetic. 3D Assembler computes in double-precision floating point on the integer grid, which requires three precautions.

1. **Consistent rather than exact points.** The same point is often computed by several triangles. So it is always computed the same way:
 - point on an edge: interpolated in a fixed vertex order;
 - triple point, where three surfaces meet: solved from the three planes, taken in a fixed order.

 All triangles thus get exactly the same rounding. The gaps that remain (one to two grid units) are then stitched again.
2. **Topological orientation around edges.** To choose the neighbouring face, the direction of a face around an edge is computed from the exact plane of its original triangle and its winding order: the interior of a face is to the left of its edges. It never depends on the rounded vertices. Without this, very thin triangles along an intersection curve flip when rounded and the air leaks inside.
3. **Safeguards.**
 - If air propagation leaves defects, a **winding number** classification (ray casting on the original model) is tried, and the better of the two results is kept.
 - If the Wrap still fails, the model is kept without Wrap and the user is warned. A failed Wrap never destroys the model.

**Internal cavities**: as in 3D Builder, the Wrap removes all components that the air does not reach. An internal cavity therefore disappears, even if none of its faces is cut.

**Colours**: as in 3D Builder, repair keeps the face colours (`src/repair/colors.ts`). Each repaired face lies on an original face, within the stitching tolerance, including the fragments produced by the Wrap. It therefore takes the colour of the original face closest to its centre. Fill faces take the colour of their neighbour. The same rule is used by the other tools that replace a painted object: Split, Hollow, Simplify, Separate, Extrude down. Group and the Boolean operations keep the colour of each original piece.

**Detection**: self-intersections are searched for in the background after each import. The object then turns red and the repair banner appears.

**Performance**: full repair of two overlapping 40,000-triangle spheres in about 4 s (Wrap: 1.5 s). The result has the same volume as the union computed by manifold-3d, within 0.3 mm³, and no remaining intersection.

**Validation on the 3D Builder catalogue** (`tests/catalog.test.ts`, which reads the models shipped with the installed application without copying them): the 52 pieces of the 16 models come out valid. This test revealed three Wrap flaws, fixed on 17/11/2026:

- **Triangles crushed by rounding.** A very thin triangle whose third vertex falls less than half a grid unit from its long edge is removed, and the face on the other side of that edge is split in two at this vertex.
- **Coplanar overlaps with shared vertices.** Two triangles in the same plane that overlap are now detected even if they share vertices (a fin folded flat onto its neighbour). An edge lying on the boundary of the other triangle does not count as an overlap. The splitting handles layers oriented in opposite directions.
- **Pinholes.** Small loops of open edges left by rounding are filled with a fan, as are larger planar holes. An open edge stops the air instead of letting it through to the other side, so a single leak no longer empties the whole model. On 3D Builder's closed input, both rules give the same result.

Result: the 9 self-intersections of the bulldozer are resolved.

**Windmill (18/11/2026)**: the two remaining windmill pieces, made of folded fins and nearly coincident layers, are now resolved. They come out valid, with no intersection, and with a volume within 0.1 %. All 52 catalogue pieces pass. Six fixes:

- **Accepted air leak.** On piece 1, the air entered the material through a badly ordered edge and left only a closed 4-triangle fragment. This fragment was accepted because it had no defect. The propagation result is no longer kept if it loses more than half of the volume. The winding classification then takes over, even with a few defects that repair fixes afterwards.
- **Crossings within a plane.** When several triangles in the same plane overlap, the splitting also computes the crossings between their sides, and between a side and an intersection segment. Without them, the plane graph was not planar, and regions spilled outside the original triangles.
- **Sampling from the exact plane.** Stitching brings together vertices 2 grid units apart, which can shift a fragment by half a unit relative to its original triangle. The samples were at 0.25 unit and so all fell on the same side. They now start from the exact plane of the source triangle.
- **More robust winding** (`windingClassify`):
 - majority vote of the X, Y and Z rays, as for the Boolean operations;
 - sampling distance halved, up to the neighbouring layer, when another surface is less than 0.25 unit away;
 - thin slivers take the majority decision of their neighbours.
- **Slits and caps in repair** (`repair.ts`):
 - **Slits.** Removing two folded faces can leave a slit: a zero-area hole whose middle vertex is on the long edge. It is stitched like a T-junction, at the end of repair.
 - **Caps.** A flat face that cannot be flipped, because the new diagonal already exists, is removed by merging its vertex with the nearest end of its long edge. The merge happens only if the surface stays 2-manifold.
- **Repeated Wrap.** If nearly coincident layers still intersect after one pass, the Wrap is run again, up to 3 passes, as long as the result stays valid. On piece 2, 210 pairs remained after the first pass and none after the third.

**Known limit**: dozens of nearly coincident intersection curves (for example a torus whose slices all intersect on the axis). Without exact arithmetic, the fragments do not stitch back together. The model is then left intact and flagged.
