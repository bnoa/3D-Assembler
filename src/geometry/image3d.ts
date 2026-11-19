// Image pixels on a white background (used by the wallpaper tool). The insert-image tool itself
// is in image-insert.ts.

export function imagePixels(img: CanvasImageSource & { width: number; height: number }, longest: number): ImageData {
  const ar = img.width / img.height;
  const w = Math.max(2, Math.round(ar >= 1 ? longest : longest * ar));
  const h = Math.max(2, Math.round(ar >= 1 ? longest / ar : longest));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}
