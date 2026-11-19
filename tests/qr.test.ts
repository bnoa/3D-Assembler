import { describe, expect, it } from 'vitest';
import { encodeQr, formatBits, rsDivisor, rsRemainder } from '../src/geometry/qr';

// Bit reading in the zigzag order, to check the stored codewords against Reed–Solomon.
function functionMask(size: number, ver: number): boolean[][] {
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < size && y < size) fn[y][x] = true; };
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(size - 1 - i, 8); mark(8, size - 1 - i); }
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2, step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const al = [6];
    for (let pos = size - 7; al.length < n; pos -= step) al.splice(1, 0, pos);
    al.forEach((ax, i) => al.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(ax + dx, ay + dy);
    }));
  }
  return fn;
}

describe('QR encoder (texture menu "Générer une texture QR")', () => {
  it('computes the known format bits (level M, mask 0)', () => {
    expect(formatBits('M', 0).toString(2).padStart(15, '0')).toBe('101010000010010');
  });

  it('builds a version-1 code for a short URL with valid Reed–Solomon codewords', () => {
    const q = encodeQr('HTTP://A.B', 'M');
    expect(q.version).toBe(1);
    expect(q.size).toBe(21);
    // Undo the mask, read the 26 codewords, check data + ECC divide exactly.
    const fn = functionMask(21, 1);
    let fmt = 0;
    for (let i = 0; i <= 5; i++) fmt |= (q.modules[i][8] ? 1 : 0) << i;
    fmt |= (q.modules[7][8] ? 1 : 0) << 6;
    fmt |= (q.modules[8][8] ? 1 : 0) << 7;
    fmt |= (q.modules[8][7] ? 1 : 0) << 8;
    for (let i = 9; i < 15; i++) fmt |= (q.modules[8][14 - i] ? 1 : 0) << i;
    const mask = [0, 1, 2, 3, 4, 5, 6, 7].find((m) => formatBits('M', m) === fmt);
    expect(mask).toBeDefined();
    const masks = [
      (x: number, y: number) => (x + y) % 2 === 0, (_x: number, y: number) => y % 2 === 0, (x: number) => x % 3 === 0, (x: number, y: number) => (x + y) % 3 === 0,
      (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ];
    const bits: number[] = [];
    for (let right = 20; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < 21; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? 20 - vert : vert;
        if (!fn[y][x]) bits.push((q.modules[y][x] !== masks[mask!](x, y)) ? 1 : 0);
      }
    }
    const cw: number[] = [];
    for (let i = 0; i + 8 <= bits.length && cw.length < 26; i += 8) cw.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    const data = cw.slice(0, 16), ecc = cw.slice(16);
    expect(rsRemainder(data, rsDivisor(10))).toEqual(ecc);
    // Byte mode, 10 characters.
    expect(data[0] >> 4).toBe(4);
    expect(((data[0] & 15) << 4) | (data[1] >> 4)).toBe(10);
  });

  it('grows the version with the length', () => {
    expect(encodeQr('https://example.com/' + 'x'.repeat(100)).version).toBeGreaterThan(4);
  });
});
