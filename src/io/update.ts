// Update check: asks GitHub for the latest release of 3D Assembler and picks the installer of this
// system. Nothing is sent but the request itself, and only when the user asks for it (or turned on
// the check at startup in the settings).

declare const __APP_VERSION__: string;

/** Version of this build (from package.json). */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

const REPO = 'bnoa/3D-Assembler';
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

export interface UpdateInfo {
  latest: string;
  newer: boolean;
  /** The installer for this system, or the release page when none fits. */
  download: string;
}

/** true when version a is strictly greater than b (numbers compared part by part: 0.10.0 > 0.9.2). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** The installer name of this system (the names of the release files). */
export function installerFor(ua = navigator.userAgent): RegExp | null {
  if (/Windows/i.test(ua)) return /Setup-x64\.exe$/i;
  if (/Macintosh|Mac OS X/i.test(ua)) return /macOS\.dmg$/i;
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return /Linux-x64\.AppImage$/i;
  return null;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`GitHub: ${res.status}`);
  const rel = (await res.json()) as { tag_name: string; assets?: { name: string; browser_download_url: string }[] };
  const latest = rel.tag_name.replace(/^v/i, '');
  const want = installerFor();
  const asset = want ? rel.assets?.find((a) => want.test(a.name)) : undefined;
  return { latest, newer: isNewer(latest, APP_VERSION), download: asset?.browser_download_url ?? RELEASES_PAGE };
}
