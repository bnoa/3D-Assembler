// Optional reference data for the comparison tests (skipped when absent):
// - ASSEMBLER3D_3DB_CATALOG: the Catalog folder of an installed 3D Builder (default: the Windows Store path);
// - ASSEMBLER3D_REFERENCE_DIR: files saved by 3D Builder for comparison (no default).
export const CATALOG = (process.env.ASSEMBLER3D_3DB_CATALOG ?? 'C:/Program Files/WindowsApps/Microsoft.3DBuilder_20.0.4.0_x64__8wekyb3d8bbwe/Assets/Catalog').replace(/\\/g, '/').replace(/\/$/, '');
export const REFERENCE = (process.env.ASSEMBLER3D_REFERENCE_DIR ?? '').replace(/\\/g, '/').replace(/\/?$/, '/');
