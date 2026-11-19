// App icon: a stepped pyramid of print layers in a stylised perspective (edges running to a vanishing
// point on the right, the far side thinner), top faces left out so the layers read as bands; a
// bright front face and a darker side. Writes the PNG icons, no dependency.
// Usage: node scripts/make-icons.cjs public/icons
const fs = require('fs');
const zlib = require('zlib');
const out = process.argv[2] || 'public/icons';
fs.mkdirSync(out, { recursive: true });
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
function inside(poly, x, y) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; }
const FRONT = hex('#00a8e8'), SIDE = hex('#0a6fa8');

/** Faces of the layers in a 0..1 box, scaled by k around the centre. */
function faces(k) {
  const t = ([x, y]) => [0.5 + (x - 0.5) * k, 0.5 + (y - 0.5) * k];
  const list = [];
  const C = 0.44; // the near vertical edge
  const thick = 0.115, gap = 0.04;
  let base = 0.81;
  for (let i = 0; i < 4; i++) {
    const f = 1 - 0.24 * i;
    const wl = 0.3 * f, wr = 0.38 * f; // left (front) and right (side) widths
    const riseL = 0.42, riseR = 0.3; // edges going up away from the near edge
    const far = 0.6; // the far end of the side is thinner (vanishing point to the right)
    const front = [[C, base - thick], [C - wl, base - thick - wl * riseL], [C - wl, base - wl * riseL], [C, base]];
    const side = [[C, base - thick], [C + wr, base - thick * (1 + far) / 2 - wr * riseR], [C + wr, base - thick * (1 - far) / 2 - thick * far - wr * riseR + thick * far], [C, base]];
    list.push([front.map(t), FRONT], [side.map(t), SIDE]);
    base -= thick + gap;
  }
  return list;
}

function draw(size, k, bg) {
  const list = faces(k);
  const img = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = (x + (sx + 0.5) / SS) / size, v = (y + (sy + 0.5) / SS) / size;
      let col = bg;
      for (const [poly, c] of list) if (inside(poly, u, v)) col = c;
      if (col) { r += col[0]; g += col[1]; b += col[2]; a += 255; }
    }
    const o = (y * size + x) * 4, kk = a / 255 || 1;
    img[o] = Math.round(r / kk); img[o + 1] = Math.round(g / kk); img[o + 2] = Math.round(b / kk); img[o + 3] = Math.round(a / (SS * SS));
  }
  return png(size, size, img);
}

fs.writeFileSync(`${out}/icon-192.png`, draw(192, 1.05, null));
fs.writeFileSync(`${out}/icon-512.png`, draw(512, 1.05, null));
fs.writeFileSync(`${out}/icon-maskable-512.png`, draw(512, 0.78, hex('#f2f9fd')));
fs.writeFileSync(`${out}/apple-touch-icon.png`, draw(180, 0.86, hex('#f2f9fd')));
console.log('ok');
