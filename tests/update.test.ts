import { describe, expect, it } from 'vitest';
import { installerFor, isNewer } from '../src/io/update';

describe('Update check', () => {
  it('compares versions part by part', () => {
    expect(isNewer('0.1.2', '0.1.1')).toBe(true);
    expect(isNewer('v0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('0.1.1', '0.1.1')).toBe(false);
    expect(isNewer('0.1.0', '0.1.1')).toBe(false);
    expect(isNewer('1.0', '0.9.9')).toBe(true);
  });

  it('picks the installer of the system', () => {
    expect(installerFor('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')!.test('3D-Assembler-Setup-x64.exe')).toBe(true);
    expect(installerFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')!.test('3D-Assembler-macOS.dmg')).toBe(true);
    expect(installerFor('Mozilla/5.0 (X11; Linux x86_64)')!.test('3D-Assembler-Linux-x64.AppImage')).toBe(true);
    expect(installerFor('Mozilla/5.0 (Linux; Android 14)')).toBeNull();
  });
});
