# The editing tools of 3D Builder

Behaviour of 3D Builder 20.0.4.0, recorded in November 2026 by using the application (measurements, saved files, comparison of results). This document describes behaviour; the code of 3D Assembler is independent.

| Tool | What 3D Builder does | 3D Assembler |
|---|---|---|
| **Smooth** (« Lisse ») | The slider sets a **number of passes**. Each piece is processed on its own. By default, each pass first subdivides the piece (each triangle into 4, at the edge midpoints) as long as it has fewer than 4,096 vertices, then applies **10 iterations of HC Laplacian smoothing** (Vollmer) with α = 0.2 and β = 0.8; the weight of an edge is the mean of the angles opposite it. With "Smooth edges", each pass is a **Loop subdivision** (faces × 4). No protection of sharp edges | Same method (`src/geometry/smooth.ts`), checked on 19/11/2026 on the catalogue sphere: at level 3 (default), same radius (19.9872 to 19.9907 mm) and same size (39.9794 × 39.9805 × 39.9784 mm) as 3D Builder. Each piece is processed on its own; without Smooth edges, each pass subdivides 1→4 as long as the piece has fewer than 4,096 **vertices** (earlier versions of 3D Assembler counted faces, and so did not subdivide the 5,120-face sphere). With "Smooth edges", 3D Assembler stops before exceeding 4 million faces |
| **Simplify** | 3D Builder's own simplifier, checked live in the application: the "Reduction level" slider counts **passes**, from 0 to 6. Each pass merges vertices into a neighbour, with a tolerance that doubles (0.001 to 0.032 × the smallest dimension) until a quarter of the faces are removed. Details below | Same method (`src/geometry/simplify-passes.ts`), same slider; results within a few % (see below). Faces keep their colours |
| **Hollow** (« Creux ») | Thickness in mm: 1 mm by default, slider from 0.1 to 10 mm (measured in the application). The volume is sampled in **vertical columns on a fixed 150 × 150 grid** of cells over the XY box, then eroded **in 3D**. The cavity is made of **merged block columns**, simply **added** to the original mesh, with no Boolean. No drain hole. Details below | Same method (`src/geometry/hollow.ts`). Blocks that touch only along an edge are separated, as in the export preparation |
| **Extrude down** | Parameter: a **limit height** in absolute Z. Downward-facing faces below the limit are flattened onto the build plate, with vertical walls along their edges. Walls and bottom faces in grey (0.737). No Boolean: the result goes through repair. Details below | Same method (`src/geometry/extrude-down.ts`). Full repair runs only if the result needs it (overlapping flattened areas); colours follow |
| **Split** (« Fractionner ») | Plane defined by a normal and a point; each triangle is kept, removed or cut, and each cut loop is capped by a monotone triangulation. Each kept half is **separated into connected pieces**, each of which becomes an object, left in place. Details below | Same method, with no Boolean (`src/geometry/plane-cut.ts`, `monotone.ts`), with a tiltable plane |
| **Merge, Subtract, Intersect** | Its own Boolean engine, distinct from the Wrap: each object is cut by the other, then each fragment is kept, flipped or removed according to the winding number of the other object. Merge works pair by pair; Subtract uses the selected object as the tool; Intersect needs two objects. Details below | Same rule and same selections (`booleanMesh`, `src/repair/wrap.ts`), on the Wrap's integer grid |
| **Emboss** (« Relief ») | Image (text or shape) → intensity = max(R, G, B) × alpha → contours by **8-direction Moore tracing** → **Ramer–Douglas–Peucker** simplification → normalisation into the unit square. Up to 8 shapes, planar, cylindrical or spherical projection; final clean-up by maximum-deviation decimation | Same method (`src/geometry/emboss-engine.ts`): UV projector, area facing the projector (88° threshold), frame and quadtree cut into the mesh, contours cut in, then vertices copied and moved with walls, with no Boolean. Bevel, and top and side colours. Contours by the same Moore tracing and the same RDP (`traceContours`) |
| **Inserted image** | Four modes: **contour**, **height map**, **edges**, **stamp** (dithering). Colours reduced by "median cut", a single terraced relief. Details below | Same modes, same settings and same defaults (`src/geometry/image-insert.ts`) |
| **Thin walls** | Automatic analysis in the print preview: a ray goes from the centre of each face inwards, over a length equal to the minimum thickness. A face is thin below minimum − 0.001. The minimum comes from the material, or is 0.25 mm with no printer. Fix: a uniform enlargement of all objects, accepted if they fit on the build plate. Details below | Same method (`thinWalls`, Print analysis tool), with the flaws fixed |
| **Primitives** | Each shape is a 3MF file from the catalogue, with its colour. Measurements: 40 cube; cylinder Ø 40 × 40 with 120 sides; cone Ø 40 × 40 with 96 sides; square pyramid 40 × 40; hexagon 50 across flats and 15.49 high; wedge 40 × 40 with a ridge of 20 in the middle; sphere Ø 40 as an icosahedron subdivided 4 times (5,120 faces, poles on Z); torus R 25, r 10 at 100 × 100; tetrahedron on an equilateral base of 49.5, 40 high. Flat faces with no centre vertex. Colours: green #21bb4c (cube, sphere), blue #00a0e8 (cylinder, wedge, tetrahedron), orange #ff7f25 (hexagon, cone), yellow #fef100 (pyramid, torus) | Same shapes, sizes, tessellations and colours, generated by code (`src/geometry/primitives.ts`) without reusing the files |
| **Custom** (« Personnalisé ») | Five shapes (cube, sphere, cone, torus, cylinder) produced by a single generator: a vertical profile of rings swept around Z. Each ring is a polygon with subdivided sides, with corners optionally rounded by arcs. Quads are split from lower ring i to upper ring i + 1. Latitude from 1 to 100 (2 for the sphere, 3 for the torus), Longitude from 3 to 100 (1 for the cube), Division from 1 to 100 (concentric rings on the end caps of the cone and cylinder). Cube: Longitude × Longitude grid in square rings on the end faces, Latitude over the height. Rounding: level k, radius k × 2.54 mm (0.1 inch), arcs of k segments, Minkowski sum of a core and a sphere; maximum min(3.75 × L, 5 × H) in inches. Torus: Radius = outer radius, Inner radius = radius of the hole (at most 0.95 × Radius). Grey colour #BCBCBC | Same generator (`src/geometry/custom.ts`), same settings, same bounds and same colour. Tool mode: the shape is shown live in the scene while adjusting, with the "Wireframe" toggle and the face count; "Add" places it on the build plate |

## The Emboss engine


**No Boolean operation.** The pattern is not a solid that is added or subtracted. Its contours are cut directly into the object's mesh, in a UV space specific to the projection, then the affected vertices are moved along the projection direction. The result stays a single stitched mesh.

**The projector** is a separate object, with its own matrix (position, rotation, radii, proportions) and a type: plane, cylinder or sphere.

- *Plane*: u = y + 0.5, v = z + 0.5 in the projector's frame; constant direction along its X axis.
- *Cylinder* (Z axis): u = angle around the axis / 2π + 0.5, v = z + 0.5; radial direction.
- *Sphere*: u as for the cylinder, v = 1 − (polar angle / π); direction from the centre.
- First placement: the axis is the cardinal direction closest to (clicked point − object centre), and the radius is half the object's diagonal.
- The pattern is framed in the UV square with a 3 % margin (scale 0.97).

**Projected area**. A ray is cast from the projector; the triangle hit is the seed. A propagation by adjacency gives UVs to neighbouring triangles as long as their UV box overlaps the pattern's box. Triangles turned more than 88° from the direction are excluded, unless they are fully surrounded by accepted triangles. This is what stops the pattern from wrapping onto the back of the object.

**Two profile modes**.

- *Flat*: the contour edges are cut into the mesh. Each vertex inside the pattern is duplicated and offset by the depth (inwards for a hole, which stacks the levels). Each boundary edge gets two vertical wall triangles.
- *Bevel* (« Biseau »): a straight skeleton of the contours gives a 45° roof truncated at a plateau. The skeleton edges are cut into the mesh, then each vertex rises by the roof height at its UV. No wall: the contour stays at height 0.
- A negative depth engraves the pattern instead of raising it.

**Colours**: one colour for the top and one for the sides. In flat mode, the sides are the added walls; in bevel mode, they are the sloped faces. Nothing is coloured if the object has a texture.

**Resolution**: no global remeshing. Detail comes only from the cut edges: the pattern frame, a quadtree that subdivides beyond 100 contour points per cell, then the contours or the skeleton. The result is finally simplified (maximum deviation of 1e-5 × the smallest dimension).

**Contours** (routine shared by Emboss and the inserted image). The image is surrounded by an empty one-pixel border. The intensity is max(R, G, B) / 255 × alpha, with optional inversion; a pixel is ink if the intensity reaches the threshold (at least 1).
- **8-neighbour Moore tracing**, clockwise on screen: NW, N, NE, E, SE, S, SW, W.
 - Scanning is row by row. An outer contour starts from a background → ink transition on an unvisited pixel, with the backtrack towards the west. A hole starts from an ink → background transition, with the backtrack towards the east.
 - After a step in direction d, the search resumes at {6, 0, 0, 2, 2, 4, 4, 6}[d].
 - Jacob's stopping criterion: return to the second pixel in the same state.
 - Points are pixel **centres**.
- **Outer or hole**: 4-connected flood fill from the neighbouring pixel, bounded by the contour's box; if it reaches the edge of the box, the contour is outer.
- Contours of 2 points or fewer are ignored.
- **RDP** on the open loop between its first and last pixel, with the distance to the infinite line. The last interior point of a segment is never a candidate.
- Contours are then cleaned by a Direct2D outline step, then oriented: outer positive, hole negative.
- **Emboss values**: threshold 128, RDP tolerance of 2 pixels, no inversion.
- **Single-colour image**: if all pixels are within ±10 of the first one on R, G and B, the intensity is the alpha alone. A plain PNG image thus becomes a mask.

**Text does not go through an image**. 3D Builder takes the glyph outlines directly with DirectWrite:
- font chosen from the list of installed fonts, Calibri by default on error, always **bold** (weight 700, normal stretch and style);
- each glyph is read on its own, at the em size (`scale × 0.5`); curves are flattened with a tolerance of 0.0005;
- the pen advances by the glyph's advance width, with no kerning;
- points less than 0.005 em from the previous one are removed;
- each glyph is cleaned by a Direct2D outline step with the non-zero rule;
- the text fits on a single line. A DirectWrite analyser handles font fallback and right-to-left writing.

**Built-in shapes**: these are 531 × 441 PNG images, an antialiased white shape on a black background, traced by the same routine. **User images**: decoded at their own size, with no resizing.

**3D Assembler.**
- **Text**: 3D Assembler reads the glyph outlines from the font file (`src/geometry/font-outline.ts`). This small TrueType reader handles glyf tables, .ttc collections and composite glyphs; CFF fonts are not read. The file comes from the installed fonts, if the browser gives access to them (Local Font Access, Chrome and Edge), or from a "Font file…" opened by the user. Text is bold, the pen advances with no kerning, and the contours are merged with the non-zero rule.
 - The flattening tolerance is 0.001 em, the relative equivalent of 0.0005 for an em size of 0.5 (assuming a scale of 1 for the tool).
 - **Font fallback**: a character missing from the chosen font is taken from another font, at the same em size, with that font's advance width. 3D Assembler first tries the fonts opened by the user, then Windows fonts chosen by script: Malgun Gothic (Korean), Yu Gothic (kana), Microsoft YaHei (ideographs), Leelawadee UI (Thai), Nirmala UI (Indic scripts), Segoe UI Emoji, Segoe UI Symbol, etc. DirectWrite's exact fallback table is not reproduced.
 - **Right to left**: 3D Assembler applies the Unicode Bidirectional Algorithm (UAX #9) on a left-to-right line (`src/geometry/bidi.ts`), like the DirectWrite analyser.
 - It takes into account strong and weak types and the number rules: digits stay readable, and a number keeps its separators, its sign and its units (`%`, `$`). After Arabic letters, Arabic-Indic digits become Arabic numbers.
 - Punctuation and spaces take the direction of the surrounding words, and the trailing space returns to the line direction.
 - Runs are reversed by level, and parentheses, brackets and quotation marks are mirrored in a right-to-left run.
 - Limits: explicit controls (LRE, RLO, LRI…) are ignored, and character types are taken by Unicode ranges, without the full table.
 - **Arabic shaping** (`src/geometry/arabic.ts`): each letter takes its form according to its position (isolated, initial, medial, final), with the mandatory lam-alef ligatures and the Persian and Urdu letters. DirectWrite applies the OpenType features `init`, `medi`, `fina`, `isol` and `rlig`; 3D Assembler uses the Unicode presentation forms, which map to the same glyphs in Windows fonts (Segoe UI, Arial, Tahoma, Times New Roman, Calibri). Diacritics stay at the pen position, with no GPOS positioning, as 3D Builder does.
 - Without access to the font, 3D Assembler draws an image of the text, as for a shape.
- **Shapes**: 3D Assembler's shapes are drawn by the project, not copied, but in the same format: 531 × 441, white on black.
- **Images**: taken at their own size, capped at 4096 pixels.
- **Inserted image** in contour mode: 3D Assembler keeps the inversion (the dark parts) and a tolerance of 0.7 pixel.

**3D Assembler** follows this method (`src/geometry/emboss-engine.ts`, `traceContours` in `emboss.ts`). The Direct2D clean-up is replaced by a manifold-3d union. Two differences remain:

- **Bevel.** Like 3D Builder, 3D Assembler computes the exact straight skeleton of the contours with its own implementation (`src/geometry/straight-skeleton.ts`: wavefront propagation with edge and split events, holes included). Each skeleton face is cut into the mesh and becomes a roof facet, with a height equal to the skeleton time; the plateau is the contour offset at the depth. The bevel height is a **percentage of the maximum roof height** (50 % by default), as in 3D Builder. Checked on 18/11/2026 in the application: with Bevel, the Z field shows 50. 3D Builder also shows the pattern size in its internal unit, the inch: 12.5 × 12.5 instead of 317.5 × 317.5 mm, a factor of 25.4, for the same visual size. This is a display flaw, which 3D Assembler does not reproduce. Each part is recentred and scaled to a fixed size, collinear points and holes of one or two pixels are removed, and on failure other scales and a slightly stronger clean-up are tried.
- **End of computation.** Final maximum-deviation simplification (1e-5 × the shortest side), as in 3D Builder: a vertex is merged with a neighbour if the surface moves by less than this threshold, without flipping a face and without crossing a colour boundary.

## Hollow


- **Grid**: 150 × 150 cells over the object's XY box, not necessarily square. Each triangle is put in every cell covered by its XY box.
- **Column**: a vertical segment at the centre of the cell, from minZ − H to maxZ + H (H = object height). Hits are sorted, and those less than 1e-4 from the previous one are ignored. The interval between two successive hits is solid when the first triangle faces down; there is no parity rule.
- **3D erosion**: for each solid interval [z0, z1], 8 × 8 probes cover the cell enlarged by the thickness t on each side.
 - A probe outside the object's box removes the interval.
 - Each probe casts a segment from z0 − t to z1 + t:
 - **no hit**: the probe is solid if the hit just below faces down, otherwise the interval is removed;
 - **odd number of hits**: the probe is ignored;
 - **otherwise**: its solid intervals at least t long are kept, clipped to the window.
 - The lists from all probes are intersected.
 - An interval [a, b] is kept if b − a > 3 (t + 0.01). It becomes [a + t, b − t], rounded to the hundredth.
- **Cavity**: one box per interval, filling its cell. Side faces are produced only where the neighbouring column does not cover the same height, so the boxes form a single blocky shell. Normals point into the boxes: the shell is inverted.
- **Result**: the original surface and the cavity are concatenated into a single mesh.

**3D Assembler** reproduces these rules. To avoid T-junctions, each wall strip is cut at every height present on its two vertical edges. In 3D Builder, a final step that has not been analysed probably plays this role.

## Extrude down


- **Frame**: the object is taken in world coordinates. The limit H is an absolute Z, the build plate is at z = 0, and eps is the largest dimension / 2048. An object that goes below −eps is ignored.
- **Cut**: if eps < H < zmax − eps, faces crossing z = H are cut. Intersection points are shared per edge.
- **Face score**: the z component of its unit normal. A face with a vertex above H + eps gets score 1.
- **Main variant** (closed object):
 - Faces with score < −0.001 are flattened **in place**, with no face copy.
 - A vertex used only by these faces goes down to z = 0. A vertex shared with the rest gets a copy at (x, y, 0), which the flattened faces use.
 - Each edge between a flattened face and another face gets a wall of two triangles, (a, b, b′) and (a, b′, a′).
 - Grey ("BaseColor" material 0.7372549) goes to the walls and to every face with score < 0.001: bottom faces and nearly vertical faces below the limit.
- **Validation**: the validated result does not come from the preview routine. It ends with a step of the Simplify simplifier at tolerance 0.0001 (maximum error = 1e-4 × the smallest dimension): the flat bottom collapses (catalogue sphere, plane at the equator: 102 triangles on the bottom instead of 2,560 flattened faces), the curved parts remain. Grey is added only if the object already has per-face colours: a single-colour sphere stays entirely green, walls included. The validation routine also builds a different mesh from the preview: no vertex moves, a flat copy (x, y, 0) of each vertex is added in index order; faces below the limit that do not face up (normal z ≤ 0.001, or degenerate) are removed; then come the kept faces in their order, then walls on the boundary of the kept surface (vertex by vertex; edge (v, X) on a number of kept faces other than 2; (v, X, X′), (v, X′, v′) if v follows X in the face, otherwise (v, X′, X), (v, v′, X′)), then the whole kept surface projected flat and flipped as the bottom. For the simplifier step, 3D Builder turns on the edge lock: a vertex lying on an edge that is not shared by exactly two faces (counted in the 8-face lists per vertex, so also around vertices with more than 8 faces) is not removed during the sweep, but other vertices can merge into it. **3D Assembler** does the same at validation (`extrudeDownApplyMesh`): 2,818 faces with 98 on the bottom, against 2,822 with 102 (2,808 when flattening in place, 2,802 without the lock); outside the bottom, 3D Builder's walls take the other diagonal on 11 of the 80 wall quads, which shows that its walls are not yet built exactly the same way; the preview keeps in-place flattening. 3D Builder also comes out 39.984 mm wide instead of 40, with no explanation so far.
- **Starting height**: the plane goes through the centre of the selection; the displayed value is the distance from the centre to the plane (0 mm at the start); the limit passed on is the absolute height of the plane. **3D Assembler** starts from the same place and displays the absolute height.
- **Fallback variant** (open object): downward-facing faces are removed, a flattened and flipped copy of the remaining faces is added, and walls line their free edges. 3D Assembler does not use it: its objects are repaired on import.
- **End**: clean-up with a tolerance of 1e-4 × the size, then a repair task. Two overlapping flattened areas are not merged before repair.

**3D Assembler** applies the main variant. A vertex already lying on the build plate is not copied, which 3D Builder's clean-up achieves by merging the copy back: the result is the same, and a wall reduced to an edge becomes a single triangle. Full repair (with Wrap) runs only if the result is not valid or self-intersects. The old method, a union with a prism, wrongly filled the space under an overhang all the way up.

## The inserted image


**Settings**: two per mode, plus "Invert" (off by default) and "Reduced-colour material" (on by default).

| Mode | Setting 1 | Setting 2 (0 to 8) |
|---|---|---|
| Contour | threshold, 128 then set automatically | RDP tolerance − 1, default 0 |
| Height map, Edges | number of colours, 16 (2 to 256) | smoothing radius, default 2 |
| Stamp | dithering, default 2 × 2 | block size − 1, default 2 |

**Contour**
- The slider steps through the intensity levels present in the image. The first level chosen is the median; if it gives no contour, its neighbours are tried moving outwards, and levels that fail are removed from the list.
- The tracer is the Emboss one, with an RDP tolerance equal to setting 2 + 1.
- Nested contours are triangulated with their holes and extruded from 0 to 0.1, i.e. **10 % of the long side of the image**.

**Height map and Edges**
1. Flood-fill pre-pass: a neighbouring pixel takes the starting colour if the differences stay small (R and G < 8, B ≤ 5, alpha ≤ 7).
2. **Median cut** on linear colours (gamma 2.2): the box with the largest side is always cut, at the median of its longest axis. Each pixel takes the closest mean colour, with weights 0.2126 / 0.7152 / 0.0722.
3. Height of a pixel:
 - **Map**: (R + G + B) / (256 − alpha);
 - **Edges**: the largest colour difference with the 8 neighbours.
 - Inversion reverses the heights.
4. Separable Gaussian smoothing of radius r (σ = r/2). Beyond 128 pixels, r is multiplied by min(w, h) / 128, except for a square image: this is a 3D Builder flaw, reproduced as is.
5. Relief: one vertex per pixel. Each cell has two triangles, with the diagonal going through a corner that is a strict extremum. The height goes from **8 % to 24 % of the width**. Walls go down to z = 0 and a flat bottom closes the solid.
6. With the material on, the relief is textured with the reduced image. 3D Assembler gives each cell the colour of its pixel.

**Stamp**: blocks of b × b pixels. Each block becomes white if its linear luminance exceeds an ordered-dithering threshold (2 × 2, 4 × 4 or Bayer 8 × 8), black otherwise. The result is a two-level relief, textured with the original image.

**Size** (measured on 18/11/2026): the scene unit is the inch, so **0.254 mm per pixel**. A 287 × 405 pixel image inserted in Contour gives 72.64 × 102.62 × 10.29 mm, i.e. 286 × 404 pixel steps, and 10 % of 405 × 0.254 for the thickness. 3D Assembler offers this size by default, as well as Contour mode by default, and leaves it editable. Images larger than 1024 pixels are scaled down (3D Builder keeps their size). The contour-mode material has not been worked out, so it is not reproduced.

## Split


- **Classification**: s = n·v + d, computed in double precision on world coordinates, after welding identical positions. A vertex with |s| < 1e-7 is "on the plane", without being moved.
 - A triangle entirely in the plane goes to the lower half.
 - A triangle with no strictly negative vertex goes to the upper half; otherwise, if it has no strictly positive vertex, to the lower half. The others are cut.
- **Cut**: the intersection point is at t = |sa| / (|sa| + |sb|), shared per edge.
 - One vertex on the plane: two triangles are produced.
 - One vertex alone on one side: one triangle on its side, and on the other side a quadrilateral split along the fixed diagonal I1–c.
 - Colours follow their faces.
- **Loops**: boundary edges are walked; a revisited vertex closes a loop, which handles pinches. Vertices more than 1e-5 from the plane are discarded, so old holes elsewhere are not capped. Loops of the same plane are grouped.
- **Capping**: sweep triangulation, with no added point.
 1. 2D frame: the longest edge, and the first edge more than 30° from it.
 2. Nesting of contours by point-in-polygon test (odd depth = hole).
 3. Split into x-monotone pieces by diagonals, then triangulation of each piece with a sorted stack.
 4. Edges shorter than 1e-4 are discarded, then their vertices are reinserted by splitting the neighbouring triangles, to avoid T-junctions.
 5. The cap is added with a winding order reversed relative to the loops.
 6. Cap colour: that of the loop's faces if they all have the same colour.
- **End**: a half with fewer than 3 indices or a diagonal below 1e-4 is ignored. Each half is separated into connected pieces. No repair is run, and the pieces are not moved.

**3D Assembler** follows these rules, with four additions:
- collinear contour points are reinserted like very close points, so that no cap triangle joins three collinear points;
- nesting is tested on the majority of unshared vertices, because two touching pieces can have a common cut vertex;
- if the sweep fails, manifold-3d's triangulation takes over;
- nearly flat triangles, left by vertices a hair's breadth from the plane, are removed by the light clean-up (edge flips). 3D Builder leaves them, but 3D Assembler would then flag the piece as not valid.

Validation: the 3D Builder catalogue models, cut horizontally, at an angle and on their plane of symmetry, all give valid pieces (`tests/catalog-cut.test.ts`). Earlier versions of 3D Assembler also dropped the top half onto the build plate; 3D Builder does not.

## Boolean operations


- **Engine**: a separate engine, distinct from the Wrap. Merge is a true Boolean operation, not a simple combination followed by repair.
 - Objects are taken in world coordinates, in floating point, with no grid or normalisation.
 - Only subtraction first checks that the objects are valid.
- **Winding number**: for each vertex of A inside B's box, a ray along +Z counts the signed crossings of B, and vice versa.
 - Each edge of A is cut by the triangles of B, and each edge of B by those of A.
- **Keep rule**: each vertex gets the value s·w + o.
 - Merge: 1 − w on both objects.
 - Subtract: 1 − w on A, and −w on B.
 - Intersect: w on both.

 An uncut face is kept if its three values are 1, flipped if they are −1, and removed otherwise. A cut face is rebuilt from its intersection chains, then triangulated.
- **Coincident faces**: no special handling. A face whose crossings do not agree is removed, and repair then fills the hole.
- **Several objects**:
 - **Merge**: objects are merged two by two. A pair stays merged only if it gives a single piece; otherwise the objects stay separate, in a group.
 - **Subtract**: a single selected object, the tool. It is removed from every object whose box overlaps its own, then it disappears. An object reduced to fewer than 4 triangles is deleted.
 - **Intersect**: exactly two objects.
- **Colours**: each fragment keeps the material of its original face. An object with no material gets the grey 0.737.
- **End**: an invalid result goes through repair. A valid result is separated into one object per piece.

**3D Assembler** applies the same keep rule and the same selection rules, with four implementation differences:
1. **Cutting** on the Wrap's integer grid, more robust than floating point: each triangle is cut only by those of the other object.
2. **Winding** evaluated a quarter of a grid unit in front of and behind each fragment, with three rays (X, Y, Z) and a majority vote. Coincident faces thus get a clear answer, instead of a hole to repair.
3. **Very thin triangles** along the intersection curves: they take the unanimous decision of their neighbours, as 3D Builder's propagation along the surface would.
4. **Last resort**: if the result is still invalid after repair, the computation is redone with manifold-3d.

The result matches manifold-3d to within 0.1 % (`tests/boolean.test.ts`). The valid 3D Builder catalogue models, merged and intersected with an offset copy, and subtracted from a sphere, all give valid solids (`tests/catalog-boolean.test.ts`).

## Simplify


- **Path**: Simplify mode uses 3D Builder's own simplifier, not the Windows face-reduction API (`TryReduceFacesAsync`), as an earlier analysis on 18/11/2026 had wrongly assumed.
- **Slider**: maximum = 0.06 × 100 = 6; the value is a number of passes (1 keyboard step = 1 pass; observed: passes = 1, 2…). Each preview starts again from the original object.
- **Pass**: tolerance t = 0.001, then doubled while t < 0.05, applied one after the other on the same mesh, until the faces drop below 75 % of the count at the start of the pass. Maximum error = t × the smallest dimension of the box. For each t, up to 20 sweeps, stopped when a sweep removes less than 0.1 % of the faces. A pass that keeps 99 % of the faces or more stops the passes.
- **Sweep**: vertices are visited in index order, with no priority queue. A vertex with more than 8 faces is locked, as is a vertex already touched during the sweep or whose faces do not all have the same colour. The vertex is merged into the neighbour with the lowest cost: cost = the larger of the distance from the vertex to the planes of its triangles once moved, and the distance from the neighbour to the original planes. The merge must keep the added cost plus the accumulated error of each below the maximum error, must not turn any normal by more than acos 0.8, and must keep the surface manifold. The neighbour keeps its position: no new vertex is computed.
- **Details**: cost over all faces of the vertex (including those that disappear, at zero distance); normal test per face, with a separate branch for an already degenerate face (it must not become a real triangle again); topology test: the combined faces of the two vertices keep each edge at most twice, in opposite directions; 8-face table per vertex rebuilt at each sweep; errors reset to zero at each tolerance step; degenerate faces removed at the end of the sweep by replacing them with the last face (the face order changes). Computation in single precision throughout (positions, plane distances with a unit normal and an offset, errors, normal tests), on the object's own coordinates in millimetres for Simplify; image reliefs are simplified while still in inches.
- **Measurements**: catalogue sphere (5,120 faces): 3D Builder 2,700, 1,806, 1,126, 526, 256, 216 faces after 1 to 6 passes. The degenerate-face test (an internal check: a merge must not give area back to a face reduced to a line) is on in every use (Simplify, Extrude down, image reliefs); it computes the cosine in single precision and compares it to exactly 1.0: a nearly collinear face whose rounded cosine is 1 counts as degenerate. Custom rounded cube (2,760 faces): 496, 278, 152, 108, 108, 108 (floor caused by locking vertices with more than 8 faces).

**3D Assembler** applies the same method (`src/geometry/simplify-passes.ts`): on the catalogue sphere, 2,700, 1,806, 1,126, 526, 256, 216, as 3D Builder (earlier versions, in double precision or in inches: 1,804, 1,110, 518, 252, 208). On a sphere generated by 3D Assembler, the vertex order differs from that of the 3D Builder file and the results diverge a little more (2,764 on the first pass). Earlier versions of 3D Assembler reproduced the Windows API (quadric edge collapse towards a target of faces × (1 − level)), which is not what Simplify mode uses; this code remains in `src/geometry/reduce-faces.ts`.

## Brush and wallpaper


- **Modes**: surface colour, texture as wallpaper (Brush (« Pinceau ») mode) or as a Sticker, eyedropper, volume material (plain, metallic, translucent). There is no brush size: paint covers **whole triangles**, with no re-cutting of the mesh.
- **Area**: Coverage (« Couverture », 0 to 100 %) gives T = coverage × π, in whole milliradians. From the clicked face, a neighbouring face (by shared edge, welded vertices) is taken if the angle with the face it comes from is at most T/2, and the angle with the clicked face at most T. Defaults: 22.5 % for texture, 180 for colour, a fixed 48 for the sticker.
- **Colours**: one material index per face, in the 3MF way. An identical colour is reused. An object with no material first gets the grey 188.
- **Wallpaper**: the area's vertices are projected onto the plane perpendicular to the clicked face's normal. The image is fitted to the area's bounding frame, with X and Y repetition (1 by default), rotation around the centre (0) and offset (0). Texture coordinates are stored per vertex. Faces outside the area keep their colour.

**3D Assembler** applies the same area rule (coverage in %, same thresholds) and the same wallpaper projection, with the flaws fixed (see the table).

**Real textures** (`src/core/texture-data.ts`): like 3D Builder, 3D Assembler keeps for each object a list of images and, for each face, the image shown and the texture coordinates of its three corners. The mesh is not refined.
- **Wallpaper**: coordinates computed at the vertices with 3D Builder's formula. The image repeats ("wrap" mode).
- **Sticker**: a single copy of the image, with a transparent border and no mipmaps ("clamp" mode). The object stays visible around it.
- **Colour and texture**: painting a colour on a face replaces its texture, because a face has only one material.
- **Operations**: textures follow the faces through copies, moves, mirroring and grouping. For repair, Boolean operations, Split, Simplify and Hollow, each face takes the image and interpolated coordinates of the nearest original face.
- **3MF**: export and import as `texture2d` and `texture2dgroup`. PNG goes through a built-in encoder and decoder. JPEG is kept encoded on read, then decoded by the browser on import, which also covers progressive JPEG. A JPEG image that was never decoded is written back unchanged on export.
- **3D Builder flaw fixed**: each brush stroke creates a new texture material. 3D Assembler reuses the image already present.

## Thin walls


- **Trigger**: automatic when the print preview opens. The result is kept per object. Thin faces are flagged, with a message that suggests enlarging the object.
- **Measure** (the Measure tool): first click = point A (blue marker), then a line follows the cursor to a green marker and the distance updates live; the second click sets B, a third starts again with a new A; a click on nothing (neither object nor ground) or Esc resets. Points snap onto objects or onto the ground (z = 0). Straight 3D distance, rounded to the hundredth in the chosen unit, with no dx/dy/dz. "Snap" toggle (on, not saved): the point jumps to the vertex of the targeted triangle within 0.06 inch (1.524 mm), otherwise onto one of its edges within 0.03 inch (0.762 mm); on the ground, to the origin (0.06 inch) or onto the X or Y axis (0.03 inch). Shift inverts snapping. A marker can also be grabbed to move it, and the arrow keys move a cursor. **3D Assembler** does the same (`src/geometry/measure-snap.ts`), movable markers included (the nearest within 12 px), except the keyboard cursor.
 - Candidate faces come from a spatial tree. They are discarded if they are the face itself or a face sharing a vertex with it.
 - The first hit found at d > 0 gives the thickness.
 - With no hit, the thickness is treated as infinite: a wall thicker than the minimum is never measured.
- **Threshold**: a face is thin if its thickness is less than minimum − 0.001. The minimum used is the smallest over all faces of all objects.
- **Minimum**: the material's minimum thickness (online print service). With no printer, 0.25 mm. By print quality: 0.1 (high), 0.2 (medium), 0.3 (draft).
- **Fix**: s = minimum / thinnest thickness, applied uniformly to all objects, provided each dimension × s stays below the material's maximum size. Otherwise, a message says the object is too thin even at the maximum size. There is no other option.

**3D Assembler** applies this method: ray of the length of the minimum, margin of 0.001, 0.25 mm by default, a single factor for all analysed objects, build plate check. The flaws found are fixed (see the table of flaws).

## Lay flat, Mirror, Measure, print analysis


- **Lay flat** (« Poser à plat »): 3D Builder does not look for a flat face. It runs a **rigid-body physics simulation**: the object, placed on z = 0, falls and rolls (up to 500 × 32 steps), then it is set flat if its last tilt is less than 0.2 rad. This is also the fix offered for a floating object. **3D Assembler** computes the same rest position in a quasi-static way: the object tips around its contact point or edge, towards the side where its centre of gravity leans, until the centre of gravity is above the support area (`src/geometry/settle.ts`). So it no longer takes the largest face, but the face it leans towards.
- **Settle** (« Positionner », a mode of the Object tab): Cancel / Settle bar, with no setting. Dragging an object lifts it above the build plate and rotates it like a trackball; on release, it falls back and comes to rest (same simulation as Lay flat). Each tip can be undone within the mode. **3D Assembler** reproduces the gesture, with Undo / Redo in the mode (`MODES.position`): rotation axis in the screen plane, perpendicular to the drag, 0.01 rad per pixel, object lifted by 1.5 times its radius, then the quasi-static rest position on release. The Lay flat button remains available for a direct placement. As in 3D Builder (Yaw 52.51 after a tip), the tips of Settle and Lay flat are stored in the object's rotation and position, without touching the mesh: "Reset rotation" undoes them.
- **Tool bars**:
 - Simplify ("Reduce faces"): Reduction level | Face count and Original face count, on two lines.
 - Split: Keep top / bottom / both | Undo, Redo. Bottom bar: Move (distance from the plane to the centre, in mm) or Rotate (Roll, Pitch, Yaw, in degrees); the plane also moves and rotates in the scene.
 - Smooth: Set smoothing level | Smooth edges, a switch with "On / Off".
 - Extrude down: nothing but Undo, Redo; bottom bar: the distance from the green plane to the centre, in mm.
 - Hollow: Minimum wall thickness | the value in mm.
 - Settle: Undo, Redo only.
 - Measure: Undo only (no confirm) | Distance 0.00 mm | Snap, a switch.
 - Material ("Apply"): Type, Color ▾, Select materials (eyedropper) | Undo, Redo.
 - Color ("Color"): Selected ▾ | Coverage | Undo, Redo.
 - Texture ("Apply"): Selected ▾ | Sticker, Brush | in Brush, Coverage; in Sticker, Edit sticker and Remove sticker (greyed out until one is placed) | Undo, Redo. A click on the object places the sticker; its bottom bar: Rotate (degrees) and Scale (X, Y at 100 %, padlock).
 - Custom ("Add"): Wireframe, a switch, on, first | Shape, Latitude, Longitude, Width, Height, Rounding | Undo, Redo; no face count.
 - Image insertion ("Import image"): Method | Levels | Smooth | Textures (switch, on) | Invert (switch); no size field.
 - Add: panel centred above the scene (about 11 % margin at the top and sides), not a pane docked on the left.
 - Ribbons: Insert (Add | Custom | 9 shapes), Object (Duplicate, Copy, Cut, Paste, Delete | Settle, Mirror (« Inverser »), Measure), Edit (Simplify, Split, Smooth, Emboss, Extrude down, Merge, Intersect, Subtract, Hollow), Paint (Material | Color, Texture), View (Center view | Shading, Shadows, Colors, Reflections, Smoothing | Wireframe, Grid | X-ray), Help (Getting started, Compatible printers, User guide). No Repair button at the top: a banner offers it when an object is not valid.
 - ☰ menu: New scene, Open, Save, Save as | 3D print, Order a print online, Print on paper | About this model, 3D printer status | at the bottom Feedback, Settings, Rate this app; about 195 px wide.
 - Settings: panel to the right of the menu, each setting applied at once: Units (µm, mm / cm, in / ft, m), App color mode (Use system setting, Light, Dark), Alignment (switch, on), Collision (switch), "3D Builder 20.0.4.0 / Microsoft Corporation", links to 3D Builder technical support and the privacy statement. **3D Assembler**: same panel (the old one was a dialog with Apply); without Microsoft's links, an About link under the version, and at the bottom the build plate, which 3D Builder takes from the printer.
 - Material, Color and Texture show a help bubble (i icon) at the bottom right while the tool is open.
 **3D Assembler** reuses these bars (earlier versions of 3D Assembler also had, in the top bar: Long side of the image insertion, face count for Custom, Height and Tilts for Split, Limit height for Extrude, Whole object for Color, Size, Face, Offsets, Repeats and Rotation for Texture; a Close button in Measure; toggle buttons instead of switches; no Undo / Redo in Split, Extrude and Material, and no help bubbles; the Object ribbon also had Place on build plate, Lay flat, Repair, Analysis and Print, the ☰ menu Insert a file and Repair, and the top bar a Repair button). Entries that need a Microsoft or Windows service (Order a print online, 3D printer status, Feedback, Rate this app, Compatible printers, User guide) are not reproduced. Print analysis opens from 3D print (Analyse button); About is in Settings (and Ctrl+B). The Split plane also rotates around Z (Yaw).
- **Emboss bar**: at the top, Cancel, Emboss | Pattern (icon and menu: Text, Load, then Shapes, 19 white shapes in six columns), Projection (Planar, Cylindrical, Spherical), Bevel, Color ★ Top ▾ and ☆ Side ▾ (menu: More colors…, Use a background color, Standard colors; a line under the button shows the colour) | Text, Font (each font written in its own typeface, with "abc") | Undo, Redo on the right. At the bottom, in the scene: Move (one value in mm, 34.64 on a 40 mm cube), Rotate (in degrees), Scale (X 20, Y 20, Z 50 %, padlock; without Bevel: X and Y at 508, Z = depth 0.6 mm). The face is chosen by clicking on the object, the pattern is dragged with the mouse. No Face, Size, Engrave or Offset field. **3D Assembler** reuses this layout (earlier versions of 3D Assembler had all these settings as fields in the top bar, on two lines): a click on the object places the pattern (face chosen by the normal), a click on the pattern drags it; Scale X / Y in % (20 % = em size of 0.1 × the largest dimension), Y free when the padlock is open; Z = Bevel height in % (negative: engrave) or, without Bevel, depth in mm (negative: engrave); without Bevel, X and Y in real mm instead of 508. "Font file…", absent from 3D Builder, is shown only if the browser cannot read the installed fonts.
- **Tool modes**: during Smooth, Split, Simplify or Emboss, the other objects are drawn in translucent blue; not during Hollow, where it is the hollowed object that is translucent blue, with the cavity visible. Simplify draws the object's triangles on top as soon as it opens. Split starts with the plane at the centre of the selection ("0 mm", distance to the centre); it is moved (arrow) or tilted (rings) in the scene, with a Move / Rotate toggle; 3D Assembler adds this manipulator to its Height and Tilt fields. Extrude down too: the limit height starts at the centre of the selection, shown by a green plane that is raised with the mouse in the scene (3D Assembler: same manipulator, plus its slider) (earlier versions of 3D Assembler started from the top of the object, i.e. extruding everything). In Emboss, the pattern is placed with the mouse (a Move / Rotate / Scale in % bar appears at the bottom); 3D Assembler lets you drag it over the object, with rotation and size staying in fields. Emboss keeps its settings from one use to the next, even after Cancel (Bevel, projection, text…). Hollow likewise keeps its wall thickness and Split its kept part; Smooth returns to level 3. Slider ranges: Smooth 0 to 6, Hollow 0.1 to 10 mm, Simplify 0 to 6. **3D Assembler** does the same (an early reading of the screenshots had wrongly placed these planes at the bottom of the object; it showed the hollow in the object's colour and restarted from the default settings of Emboss, Hollow and Split; its Smooth slider went from 1 to 10).
- **Undo / Redo inside a tool**: the Color, Texture, Material, Split, Emboss, Settle… modes have their own Undo / Redo buttons on the right of the bar. **3D Assembler**: Color and Texture have these buttons, one step per brush stroke, Settle one step per tip, and Emboss one step per setting change (changes less than 0.7 s apart count as one); Ctrl+Z / Ctrl+Y act only on these steps during the tool (and no longer on the scene history, which put the previews out of sync); on confirm, the steps become a single undo step, and cancelling the tool returns to the starting state.
- **Temporary selection** (toggle in the right pane): switches from simple selection to additive selection. A click on an object (in the scene or in the Items list) adds it, another click removes it, and a click in empty space keeps the selection. **3D Assembler** does the same (the view's `additiveSelect`); an already selected object can still be moved with the mouse.
- **Click in the Items list**: the clicked object is seen through the others, which are drawn in translucent blue while the mouse stays over the pane (a click in the scene does not do this, nor does simple hovering). **3D Assembler** does the same (the view's `focusObject`, cleared when the mouse leaves the pane).
- **Ungroup**: greyed out for a single-piece object, as in 3D Builder (3D Assembler used to enable it and show a message).
- **3D print**: a separate screen, with a left pane Printer (online service, installed or detected Windows printers), Material (online service catalogue), Layout, 3D printer status and About, and a bottom bar Estimated cost, warnings, Order online, Cancel. The Layout page sets the Units, the Scale in %, and the Width, Height and Depth of the whole scene (linked), with Reset orientation and Reset scale. Supports, raft and density are shown only with an installed printer. The scene itself is not modified. **3D Assembler**: a 3D print button (top right and in the menu) that opens the Layout in tool mode, with a scaled preview and a warning if the model exceeds the build plate. A web page cannot reach Windows printers: the job is exported as 3MF for a slicer, without touching the scene. Flaw fixed: in 3D Builder, "Height" shows the extent in Y (the vertical axis of Windows printing), and "Depth" the extent in Z (a catalogue cube of 39.998 × 39.998 × 40 mm shows Height 39.998 and Depth 40); 3D Assembler shows Width = X, Depth = Y and Height = Z, the scene's vertical axis.
- **Transform bar, Scale**: the unit shown after X / Y / Z is a button that toggles between size (mm…) and percentage of the original size. The proportion lock is open by default: X = 50 % leaves Y and Z at 100 %. A click on a value opens a small window with a field, "Accept" and the lock; it shows the exact value (100.0001 % on a tipped pyramid, a rounding error). **3D Assembler**: same mm / % toggle, lock open by default; values are typed directly into the bar, rounded for display.
- **Transform bar, Rotate**: the three angles are called Roll, Pitch and Yaw, in "deg", followed by a "Reset object rotation" button (align it with the axes). Move mode has no equivalent button. **3D Assembler** does the same (rotation reset to 0, 0, 0).
- **Add** (Insert tab): a pane over the full height of the scene, with the title "Add" and a close cross at the top; on the left, Recent (unnamed thumbnails in two columns, six first, then "more"), a line, Load object, Load image, Camera (the photo taken joins the recent items); on the right, the online 3D Library (search, categories Kitchen, Miniatures and figurines, Trophy kit, Games and toys, Boxes and containers, Decor, Numbers and letters, Accessories, Stencils, with no models: the service no longer responds). The home screen also shows recent files as tiles. **3D Assembler**: same pane and same layout, Esc or the cross close it; without the 3D Library (earlier versions of 3D Assembler showed a small centred box, with names under the thumbnails) (recent files kept in the browser, IndexedDB, 12 at most, thumbnail taken on import; Camera through the browser's webcam, the photo is inserted as an image), and the last 3 files as home tiles (opened as a new scene), in the same layout: large "Learn more" tile on the left, New scene, Open across, then the recent items; 3D Assembler's Cube and Sphere tiles are shown only while there is no recent file. The 3D Library, Microsoft's online content, is not reproduced.
- **About this model** (menu): editor for the model metadata (Title, Designer, Copyright, License terms, Description), "Update" button. **3D Assembler** does the same: the fields are read when a 3MF is opened and written on save (3MF metadata Title, Designer, Copyright, LicenseTerms, Description; the title falls back to the scene name). The mesh analysis, which 3D Assembler used to open from this menu, stays under Object > Analysis.
- **Alignment** (Settings, on by default): at the start of a move, each axis gets a list of values: 0 (world origin), then the min, max and centre of the box of every other object. At each movement, the min, max and centre of the box of the moved selection are compared with these values; the closest wins if the gap is below the threshold, about 1 % of the view height, in world units, at the depth of the selection centre. Dragging the object on the build plate snaps X then Y; a move arrow snaps only its axis; scaling does not snap. Rotation has detents every 45°, which hold the angle within 5° (within 1.05 times the ring radius). No grid, no face or vertex, and no snap line is drawn. Holding Shift suspends snapping and collisions. **3D Assembler** does the same (`src/geometry/align-snap.ts`) and replaces its old grid snapping, which does not exist in 3D Builder. The 1.05-radius condition is not reproduced. Collision: off by default, as in 3D Builder.
- **Colour picker (Material, Color)**: the colour is a swatch that opens a menu Eyedropper, More colors…, Recent colors and Standard colors (12 swatches, the Paint palette: white, black, grey, maroon, red, orange, yellow, light green, green, blue, indigo, purple, read from the screen). Material mode also has "Select materials", an eyedropper that picks up the material and colour of a clicked object. The confirm button of Color mode is called "Color", and its swatch "Selected". **3D Assembler** does the same (recent colours kept in the browser; the eyedropper picks up the painted colour of the clicked face, otherwise that of the object).
- **Texture menu (Texture mode)**: the "Selected" swatch opens Load, Texture picker (eyedropper), Camera, "Generate a QR texture for [URL]" with the "Transparent background" toggle (on), Recent materials, the 24 textures, then 19 shapes (stars, arrow, chevron, cloud, ring, flag, heart, lightning, moon, cross, no-entry, circle, plus, square, rounded square, smiley, triangle, wave). The mode opens on Brush. **3D Assembler**: same menu; QR code produced by an encoder written from the standard (`src/geometry/qr.ts`, byte mode, error correction M, versions 1 to 40); shapes taken from the Emboss contours, black on a white or transparent background; 24 textures drawn by code, of the same kind as 3D Builder's (wood, cork, canvases, papers, sand, granite, marbles, plaster, leather, glitter, pastels, stone…), whose images are not reused. The mode opens on Brush.
- **Duplicate, Paste**: the copy is placed to the left of the selection (of the last pasted copy when pasting several times), 5 mm away: a 40.13 mm cube at x = 0 gives x = −45.13, then −90.26, −135.38, −180.51. **3D Assembler** does the same (the copy's box ends 5 mm before the selection's box). Earlier versions of 3D Assembler placed the duplicate on the right and pasted with an offset of 10 mm in X and Y.
- **Session recovery**: at start-up, if a previous session left unsaved changes, 3D Builder offers to recover them (Continue and Ignore buttons). Backup: after each command that changes the scene, at most every 30 s (5 min or 60 s in some unidentified cases; a change during the interval waits for it to end), and forced on close or sleep; one ordinary 3MF scene per window; no undo history. At start-up, a copy whose window is no longer open is offered; several copies each reopen a window. **3D Assembler** does the same (`src/io/recovery.ts`): one 3MF copy per tab in the browser (objects, transforms, colours, textures, information), at the same rate, and immediately when the tab is hidden; a tab that is still open keeps its own (Web Locks). Save (3MF of the whole scene), New scene and Ignore delete the copy. Continue reloads the most recent one in the tab, objects in place, scene marked unsaved, with no entry in the recent items; the others are still offered at the next start-up.
- **Keyboard shortcuts**: Ctrl+N New scene, Ctrl+O Open, Ctrl+S Save, Ctrl+Shift+S Save as, Ctrl+P 3D print, Ctrl+T Settings, Ctrl+B About, Ctrl+Z / Ctrl+Y Undo / Redo, Ctrl+X / C / V, Ctrl+Shift+C Clone, Ctrl+D Duplicate, Ctrl+A Select all, Ctrl+I Invert selection, Ctrl+G / Ctrl+Shift+G Group / Ungroup, Ctrl+0 Center view, Ctrl+M maximum fit, Ctrl+J Simplify, Ctrl+K Smooth, Ctrl+R Repair, Ctrl+L Add, Del, Esc (cancel), Enter (confirm). Single keys with a selection: R Move, E Rotate, Q Free scale, W Proportional scale, A / S / D axis X / Y / Z. Arrows: left / right on X, up / down on Y, Alt + up / down on Z, with the active tool; step of 0.1 % of the largest size of the selection (1 % with Shift) to move or scale, 1° (10° with Shift) to rotate. In Emboss, Z / X / C choose the projection. Typing a digit opens entry for the hovered value of the transform bar (3D Assembler: the hovered field, otherwise X). **3D Assembler** reproduces all of this, except: Ctrl+N and Ctrl+T, which browsers keep for themselves; Ctrl+M and A / S / D, whose exact effect is not established; Ctrl+Shift+C does a Duplicate.
- **3MF saving**: each mesh is written in its own frame, and the object's move, rotation and scale go into the transform attribute of its <build> element (a Settle tip appears there as a rotation around Z); only filled-in metadata are written (Copyright, Designer, Title, LicenseTerms, Description, with no title taken from the scene name and no application name); a Metadata/thumbnail.png thumbnail accompanies the model. **3D Assembler** does the same and, on opening, turns the transform of a mesh object back into its position, rotation and scale (Reset rotation therefore works on a reopened file); a transform with shear or mirroring is applied to the mesh. Earlier versions of 3D Assembler wrote already transformed coordinates, with no thumbnail, and with a default title.
- **Image insertion, panel and texture**: the image is set up in a tool bar with a live preview: Method: Contour (default), Texture map, Border, Stamp; two sliders: Levels and Smooth (Stamp: Detail, from 0 to 3, and Smooth); Textures (on) and Invert; "Import image" button. With Textures, the original image is mapped onto all faces of the object (top, bottom, sides), projected from above and repeated: u = x / (width × s), v = (y / s + 1 − height) / height, with s the size of a pixel in mm, and the image is saved in the 3MF. **3D Assembler** does the same (`imageTexture`, same coordinates as the 3D Builder file on the test image); same method and slider names; it also keeps the Long side field. Earlier versions of 3D Assembler set up the image in a dialog, with no texture.
- **Image insertion, Contour on a photo**: a webcam photo in Contour gives many pixels that touch only at a corner. **3D Assembler** shrinks the section by 0.05 pixel before extrusion to separate these pinches (otherwise coincident vertices and zero-area faces: 1,258 degenerate faces and 7,716 crossings on the test photo), then simplifies collinear points; the result is valid (0 degenerate faces, 0 crossings). 3D Assembler's crossing counter no longer counts overlaps of less than one step of its grid (1/100,000 of the diagonal) caused by rounding vertices onto that grid (long thin triangles on the top and bottom); repair, however, still cuts as precisely as possible. With Textures, the image is shown on the object from the preview on, as in 3D Builder, and rendered without tone mapping or strong reflection of the part, to keep its colours (earlier versions of 3D Assembler showed a grey preview and a washed-out image).
- **Image insertion, reliefs (Texture map, Border, Stamp)**: after the relief is built (same face count as 3D Assembler, 2,670 on the test image), 3D Builder runs a single step of its simplifier at tolerance 0.0001, with edges not locked and colours detached (they do not block merges): 850 faces on the test image in Texture map (8 of them with zero area), 234 in Stamp (10 of them). The texture covers only the top (u = x / (width × s), v = y / (height × s)); walls and bottom stay white. The height range (minimum, maximum) is taken before smoothing: in Border, the smoothed thin ridges no longer reach the top (2.172 mm instead of 2.438 on the test image). Because the simplifier walks the vertices in index order, the build order matters: a grid point (x, y) is at X = 0.01 x, Y = 0.01 (height − y) inch; vertices are numbered at their first use; top faces first (rows y = 1…h − 1, columns x = 1…w − 1, corners A = (x − 1, y − 1), B = (x, y − 1), C = (x − 1, y), D = (x, y): triangles (A, D, B), (A, C, D), or (C, B, A), (C, D, B) when D or A is a strict peak or pit of the square), then the walls (edge P → Q: (TP, TQ, BP), (TQ, BQ, BP), left and right row by row, then top and bottom column by column), then the bottom, a single triangulation of the outline (algorithm not identified). No flat area is merged before the simplifier. Stamp goes through the same grid, with no smoothing. **3D Assembler** does the same (bottom: a zipper between the two halves of the outline): with the grid built in inches in single precision (X = 0.01 x, heights = base + level × step) and simplified before scaling, degenerate-face test on, as 3D Builder: Stamp gives exactly 3D Builder's 234 faces (same triangles); 852 in Texture map against 850 and 1,218 in Border against 1,224, because a few smoothed pixels still land one level apart (smoothing in single precision, the horizontal pass kept unrounded and only the final value truncated, as 3D Builder); same heights and volumes within 0.1 % (earlier versions of 3D Assembler, with a grid numbered row by row and a fan-shaped bottom: 1,028, 1,414, 158), and removes the zero-area faces, which 3D Builder leaves (the object would otherwise be flagged as not valid).
- **Mirror**: in place, relative to the plane through the centre of the selection's box, along a world axis. Triangles are flipped (corners 0 and 1 swapped), and colours and textures follow. 3D Builder offers only the X axis. **3D Assembler** does the same, with all three axes, and now flips the triangles: earlier versions of 3D Assembler left the surface inside out.
- **Measure**: distance between two points clicked on the objects, with no snapping or angle, rounded to the hundredth in the chosen unit. **3D Assembler** does the same (a third click restarts the measurement).
- **Overhangs**: a face is an overhang if n·z < −cos(0.787) (45.1°), if it is not degenerate and if at least one of its corners is off the build plate (|z| > 0.005). The build plate is z = 0.
- **Floating object**: z min − 0.005 > 0.
- **Narrow base**: 3D Builder has no stability calculation, only a tip (a raft helps when the base is narrow). 3D Assembler keeps its narrow-base indicator, which does not exist in 3D Builder.

## 3D Builder flaws fixed in 3D Assembler

3D Assembler follows the methods of 3D Builder. When a behaviour looks like a bug or an oversight, it fixes it and records it here.

| Tool | 3D Builder flaw | 3D Assembler |
|---|---|---|
| Inserted image | The smoothing radius is not enlarged for large **square** images: a 512 × 512 image is smoothed 4 times less than a 512 × 511 image | The radius is enlarged for all images larger than 128 pixels |
| Contours (Emboss, inserted image) | A hole is traced only if the pixel to its left has not yet been visited: a one-pixel-thick ring, or two holes separated by a one-pixel wall, lose their hole | Each enclosed background region is traced once as a hole |
| Contours | The RDP simplification never examines the second-to-last point of a segment, so a corner can disappear | All points are examined |
| Face reduction through the Windows API (a path that Simplify mode does not use) | The `MaxEdgeLength` and `MaxReductionArea` options are not set to defined values: the result is unstable, and an out-of-range value even makes the reduction fail | Length limit set to the largest accepted value (1e5) and maximum deformation to 10,000: stable result |
| Emboss | The depth typed into the Z field of the bottom bar is not bounded (1,016 mm accepted, the relief sticks out by a metre), whereas the slider stops at the object's thickness | The depth is always bounded by the thickness |
| Emboss | Without Bevel, the bottom bar in mm shows the pattern size as a percentage multiplied by 25.4 (X = Y = 508 "mm" for 20 %, while the text measures a few millimetres); only the Z depth (0.6 mm) is correct | Sizes are in real mm |
| Emboss | With Bevel, the pattern size is shown in inches under the mm label (12.5 instead of 317.5) | Sizes are always in mm |
| Boolean operations | Coincident faces of the two objects are removed, which leaves a hole that repair must fill | Coincident faces are resolved directly: a single copy is kept, or both cancel out |
| Thin walls | The first hit found is kept, not the nearest | The nearest hit |
| Thin walls | A surface hit from behind counts as the opposite wall | Only the wall through which the ray leaves the material counts |
| Thin walls | Any face that shares a vertex with the measured face is ignored, so thin bevelled corners go unnoticed | Only hits at the starting point are ignored |
| Thin walls | The minimum thickness is not converted, whereas the object size is (inches against mm). The build plate check uses a strict comparison, and one of the two checks swaps Y and Z | Everything is in mm, and the check uses ≤ on the right axes |
| Paint | At 100 % coverage, the area still stops at edges sharper than 90°: "the whole object" is not reached | 100 % paints the whole piece |
| Paint | A degenerate triangle counts as 0° and lets the area overflow | It takes the normal of the face it is reached from |
| Paint | The default colour coverage (180) is outside the slider range (0 to 100) | The slider starts at 100 % |
| Wallpaper | The image is stretched to the area's frame, which distorts it, with a division by zero on an area that is flat along one axis | The image keeps its proportions and covers the frame |
| Wallpaper | Each brush stroke adds a new texture material, with no deduplication | The same image is stored only once per object |
| Print analysis | The "overhang angle" slider has no effect: the threshold is fixed at 0.787 rad (45.1°) | The threshold follows the slider (45° by default) |
| Print analysis | The overhang check stops at the first face found | All overhanging faces are flagged, with their area |
| Mirror | Only the X axis is offered | Three axes |
| Lay flat | The final flattening step uses an inconsistent test and does not check the height of the second contact point | Rest position computed directly (quasi-static tipping) |
| Measure | An unknown unit is shown with the "mm" label | The unit shown is always the one from the settings |
| Split | Vertices a hair's breadth from the plane leave nearly flat triangles, and the piece is then flagged for repair | Light clean-up by edge flips |
| Repair | Removing two folded faces can leave a slit (a zero-area hole), and a flat face that cannot be flipped is left as is | The slit is stitched like a T-junction; the flat face is removed by merging its vertex with the nearest one, if the surface stays 2-manifold |
| Wrap | A single pass: nearly coincident layers can still intersect after rounding | Up to 3 passes as long as the result stays valid |
| Primitives | The catalogue hexagon is not quite regular (vertices off by up to 0.2 mm) | Regular hexagon of the same dimensions (50 mm across flats) |
| Custom | Sizes are truncated to the hundredth of an inch before meshing: a 40 mm cube comes out 39.88 mm high, a sphere of 20 mm radius at 19.81 mm; the cube's width also varies with Rounding (39.87 mm at 0, 39.97 mm at 2) | Exact sizes |
| Alignment | The box centre is compared only with the values from the third one on: it never snaps to the origin or to the min of the first object | The centre is compared with all values |
| Alignment | The help says Shift "temporarily inverts" snapping, but in practice it only suspends it: Shift does not turn it on when it is off | Shift really inverts Alignment (and suspends collisions) |
| Emboss | With Bevel, the roof height is converted to millimetres by a factor estimated from the object's edges (total length / u component only), biased upwards: the roof is not at 45° but at 53.5° on the 40 mm cube, and the slope changes with the object's triangulation | Roof at 45°, height = inset |
| Image insertion | In Stamp, the incomplete cells on the right and bottom edges are not recomputed: they take the value of the last complete cell | Each edge cell takes the mean of its own pixels |
| Image insertion | The reliefs (Texture map, Border, Stamp) come out with zero-area faces, left by the final simplification: the object is not valid | Zero-area faces are removed |
| Opening a file | 3D Builder does not report self-intersections (catalogue windmill and bulldozer: no banner) | 3D Assembler looks for them on import, colours the object red and offers repair, which resolves them |
| Custom | With a Longitude of 4, the cone and cylinder ignore Division: the end caps become a fan starting from a vertex on the rim | Division applies as for the other values |

## Values measured in 3D Builder (18/11/2026)

- **Hollow**: 1 mm by default, from 0.1 to 10 mm.
- **Emboss**: default depth in flat mode = 0.015 × the object's largest dimension (0.6 mm on a 40 mm cube, which becomes 40.6 mm); Bevel is on when the tool opens, height 50 %; text size: em size = 0.1 × the object's largest dimension (size field 0.2, em = 0.5 × size), the pattern box being the ink extent of the glyphs multiplied by this dimension ("abc" in Segoe UI Bold: 1.5742 em, 6.30 mm on a 40 mm cube), centred on the front face. 3D Assembler uses these defaults (it used to take 10 % of the width or height of the face, rounded to the tenth). Bevel height: each piece of the pattern (a glyph and its holes) is cut at |v| × the maximum of its own skeleton, roof at 45°; negative v engraves. 3D Assembler also cuts each piece at its own height (it used to take the maximum of the whole pattern). Protrusion: 0.227 mm in 3D Builder against about 0.16 mm in 3D Assembler: the strokes have the same width, but 3D Builder's roof is at 53.5° instead of 45°, because the height goes through a factor estimated from the object's edges, biased upwards (see the table of flaws); 3D Assembler keeps 45°. The depth slider goes from 0 to the object's thickness: at the maximum, an engraving goes through the whole object. 3D Assembler applies the same bound (thickness along the projection direction, or radius for cylindrical and spherical projections). The default text is "abc", in Segoe UI, with a planar projection. With Bevel, the Z field shows a height of 50 %: this is the fraction v at which the roof is cut.
- **Internal unit: the inch.** Emboss sometimes shows the projector size in this unit (508 = 20 inches; 12.5 instead of 317.5 mm).
- **Inserted image**: 0.254 mm per pixel; the tool opens in Contour mode.

## Open questions


- How Emboss cuts a triangle by a segment, and its "inside" test (not studied).
- Text rasterisation (not studied).
- The exact algorithm of the thin-wall analysis.
- The triangulation of the cut cap.

