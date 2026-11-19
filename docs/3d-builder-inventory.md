# Inventory of 3D Builder (reference for 3D Assembler)

Recorded on 16/11/2026 on 3D Builder 20.0.4.0 (Microsoft Store, French interface).

Sources:
- driving the open application through UI Automation (control tree and screenshots of each tab and each tool mode).

This document describes **what the software does**. Microsoft's code, icons, images and texts are not reused: 3D Assembler rewrites them.

## 1. Technology

| Item | Finding |
|---|---|
| Language | Native C++/CX, UWP application (`vccorlib140_app`, `concrt140_app`) — no .NET |
| 3D rendering | Direct3D 11, with a minimum of DirectX feature level 10 |
| 2D rendering / text | Direct2D, DirectWrite (embossed text comes from the system fonts) |
| 3MF | lib3mf (`Lib3mfUAP.dll`), the open-source library of the 3MF Consortium |
| Interface | UWP XAML (ribbon, NavigationView, flyouts), light/dark/high-contrast theme |
| Printing | Windows 3D Print API (files `SendPrintJob.xml`, `GetPrintDeviceCapabilities.xml`…), G-code for some drivers |
| Online | "Hubble" catalogue in a WebView, print ordering (i.materialise…), online repair service |

**Web equivalents for 3D Assembler:** three.js (rendering), manifold-3d in WASM (Booleans, hollowing, cutting), lib3mf in WASM or a home-made 3MF parser (zip file + XML), opentype.js (embossed text), three-mesh-bvh (selection, painting).

## 2. Home screen

Logo and tile grid: **New scene**, **Open** (file, recent objects or library), "Learn more" (tutorials) and the recent objects.

The **built-in catalogue** has 26 3MF models sorted into categories (Gadgets, …) and described in `Catalog.json`.

## 3. Editor layout

- **Title bar**: `Scene name - 3D Builder`.
- **☰ menu**: New scene · Open · Save · Save as · 3D print · Order a print online · Print on paper · About this model · 3D printer status · Feedback · Settings · Rate this app.
- **Ribbon with 6 tabs**: Insert · Object · Edit · Paint · View · Help. Clicking a tab that is already open collapses the ribbon.
- **Right of the bar**: 3D print · Save · Undo · Redo.
- **Right pane** (collapsible): Group · Ungroup · Select all · Deselect all · Invert selection · Temporary selection (toggle) · **Items** list (thumbnails `Object1`, `Object2`…).
- **Scene**: grey checkerboard build plate, rulers graduated in mm (0, 50, 100, 150 mm…), drop shadow and reflection under the object.
- **Floating transform bar** (at the bottom, when an object is selected): Move · Rotate · Scale · X / Y / Z values · unit (mm or %) · proportion lock.
- **Handles in the scene**: vertical (blue) and horizontal (green) move arrows on the selected object; light blue outline.

## 4. Ribbon tabs

### Insert
- **Add**: import a file (3MF, STL, OBJ, PLY, WRL/VRML, glTF/GLB) or an image (BMP, PNG, JPG).
- **Custom** (« Personnalisé »): additional parametric shapes (flyout).
- **Primitives**: Cube · Cylinder · Pyramid · Cone · Sphere · Hexagon · Wedge (« Coin ») · Torus · Tetrahedron. A click adds the shape at the centre; a drag places it at a precise spot. The default cube measures 40 mm and is shown in green.
- Related functions found in the app's resources: **Insert an image** (relief from a height map or from a contour) and **Scan** (Kinect, now obsolete).

### Object
Duplicate · Copy · Cut · Paste · Delete · **Settle** (« Positionner », mode) · **Mirror** (« Inverser », X / Y / Z mirror) · **Measure** (mode, with snapping to vertices).

### Edit
| Tool | Mode panel |
|---|---|
| Simplify | *Reduction level* slider, current / original face count, *Reduce faces* button |
| Split (« Fractionner ») | Movable cutting plane (rotation ring, arrows), *Keep top / bottom / both*, offset value in mm |
| Smooth (« Lisse ») | *Smoothing level* slider, *Smooth edges* toggle (subdivision) |
| Emboss (« Relief ») | *Pattern* (text or icon: stars, wave, lightning, smiley, rounded rectangle…, or imported image), *Projection* (Planar / Cylindrical / Spherical), *Bevel* (« Biseau »), top and side *Color*, *Text* + *Font*, Move / Rotate / Scale gizmo in %, proportion lock |
| Extrude down | Value in mm: extrudes the bottom of the object down to the build plate |
| Merge | Boolean union |
| Intersect | Boolean intersection (2 or more objects) |
| Subtract | Boolean difference (2 or more objects) |
| Hollow (« Creux ») | *Minimum wall thickness* slider |

Other functions found in the resources: **Repair** (automatic on opening, with a "click to repair" banner), *Remove fragments*, **Lay flat**, splitting the object into unconnected pieces, **supports and rafts** (density, overhang angle…).

### Paint
- **Material**: *Type* (Plain, …), *Color*, *Select materials*, then Apply. There are also metal and translucent materials, which cannot be painted.
- **Color**: choice of a colour, *Coverage* (« Couverture ») slider (propagation tolerance), click on the surface to paint.
- **Texture**: choice of a texture (24 textures supplied: marble, canvas…), *Sticker* or *Brush* (« Pinceau ») mode, *Coverage* slider.

### View
Center view · toggles Shading, Shadows, Colors, Reflections, Smoothing, Wireframe, X-ray · **Grid** (flyout: no grid or grid step).

### Help
Getting started (illustrated tutorials).

## 5. Settings
- **Units**: micron, millimetre, centimetre, inch, foot, metre.
- **Theme**: default (system), light, dark.
- **Toggles**: track recent items, snapping (Shift temporarily inverts it), collisions between objects, enlarged click area, metadata, prototype mode.
- Version, support and privacy links.

## 6. Analysis and printing
- **Model analysis**: thin walls, steep overhangs, narrow base, floating objects, object too large for the build plate, non-manifold mesh.
- **3D print**: choice of printer, material, quality (draft / fine), supports, raft, extrusion settings (speeds, temperatures, retraction, layers…).
- **Print on paper**, **Order a print online**: external services, outside the scope of 3D Assembler.

## 7. Formats
- **Open**: 3MF, STL, OBJ, PLY, WRL (VRML), glTF / GLB, BMP / PNG / JPG images.
- **Save**: 3MF, STL, OBJ, PLY, GLB, glTF (with a hint recommending 3MF for best compatibility).
- **File unit**: asked on import when it is ambiguous.

## 8. Interface resources

