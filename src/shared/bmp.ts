/**
 * 24-bit uncompressed BMP (canvas cannot encode BMP). Alpha is composited over `background`
 * because 24-bit BMP has no alpha channel.
 */
export function encodeBmp24(
  width: number,
  height: number,
  rgba: Uint8ClampedArray | Uint8Array,
  background: [number, number, number] = [255, 255, 255],
): Uint8Array {
  const rowSize = (width * 3 + 3) & ~3;
  const pixelBytes = rowSize * height;
  const out = new Uint8Array(54 + pixelBytes);
  const v = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  v.setUint32(2, out.length, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, width, true);
  v.setInt32(22, height, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(34, pixelBytes, true);
  v.setInt32(38, 2835, true);
  v.setInt32(42, 2835, true);
  const [br, bg, bb] = background;
  for (let y = 0; y < height; y++) {
    // Rows are stored bottom-up.
    let o = 54 + (height - 1 - y) * rowSize;
    let i = y * width * 4;
    for (let x = 0; x < width; x++, i += 4) {
      const a = rgba[i + 3] / 255;
      out[o++] = Math.round(rgba[i + 2] * a + bb * (1 - a));
      out[o++] = Math.round(rgba[i + 1] * a + bg * (1 - a));
      out[o++] = Math.round(rgba[i] * a + br * (1 - a));
    }
  }
  return out;
}
