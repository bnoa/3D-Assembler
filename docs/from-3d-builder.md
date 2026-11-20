# Moving from 3D Builder to 3D Assembler

3D Assembler is built to feel like 3D Builder: the same tabs, tools, bars and help texts, and the same
results on your models. This page lists what stays the same, what is different, and why.

## Your files

- **3MF files open as in 3D Builder**: objects, positions, colours, painted faces, textures, metadata
  ("About this model") and materials (Realistic, Translucent).
- **Files saved by 3D Assembler open in 3D Builder** and in slicers (PrusaSlicer, Bambu Studio, Cura…).
- **STL, OBJ, PLY and VRML** open on the "File units" screen, as in 3D Builder (millimetres preselected).
  OBJ colours come from the `.mtl` file next to it; if it is missing, you are asked for it.
- **glTF / GLB**: one object per mesh, with its colour. A `.gltf` saved by 3D Builder keeps its data in a
  `.bin` file next to it: open both together, or point to the `.bin` when asked.
- **Save as** offers 3MF, STL, OBJ, PLY, GLTF and GLB, with the same warning before the formats that
  lose information.

## Where things are

Everything is where 3D Builder puts it: Insert, Object, Edit, Paint and View tabs, the side pane
(Group, Select all, Elements), the bottom bar (Move, Rotate, Scale) and the menu (Open, Save,
Print on paper, About this model, Settings). Keyboard shortcuts are the same (Ctrl+C, Ctrl+V, Ctrl+D,
Ctrl+Z, Ctrl+Y, Delete, Shift to suspend snapping and collisions…).

A few additions, kept out of the way:

- **Check for updates** in Settings, and a small banner when a new version is out (desktop app).
- **Print bed size** in Settings (3D Builder takes it from the Windows printer).
- **Language**: French or English, in Settings.
- **Third-party licenses**, under Settings > About.

## Differences on purpose

3D Assembler fixes some of 3D Builder's flaws instead of copying them. The full list, with the
details, is in [3D Builder flaws fixed in 3D Assembler](3d-builder-tools.md#3d-builder-flaws-fixed-in-3d-assembler).
The ones you are most likely to notice:

- Repaired holes take the colour around them (3D Builder leaves a dark patch).
- Opening a glTF whose `.bin` file is missing keeps your scene (3D Builder empties it).
- The 3D print layout names the axes as the scene does (Width = X, Depth = Y, Height = Z).
- The emboss bevel stays at 45°.

## What is not there

- **Printing straight to a Windows 3D printer**: a web page cannot reach printers, so "3D print"
  prepares the layout and saves a 3MF for your slicer.
- **Online ordering and the online catalogue**: those Microsoft services are gone.

## Getting help

If something behaves differently from 3D Builder, please
[open an issue](https://github.com/bnoa/3D-Assembler/issues/new/choose) and say what 3D Builder does:
matching it is the goal.
