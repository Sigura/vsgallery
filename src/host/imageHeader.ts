export interface ImageSize {
  w: number;
  h: number;
}

/**
 * Reads pixel dimensions from the start of a PNG/JPEG/WebP/BMP file.
 * Returns 'more' when the buffer ends before the size field and `complete` is false,
 * null when the data is not a supported/valid image.
 */
export function parseImageSize(b: Uint8Array, complete: boolean): ImageSize | 'more' | null {
  const need = (n: number): true | 'more' | null => (b.length >= n ? true : complete ? null : 'more');
  const u16be = (o: number) => (b[o] << 8) | b[o + 1];
  const u16le = (o: number) => b[o] | (b[o + 1] << 8);
  const u24le = (o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  const u32be = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const i32le = (o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
    return true;
  };
  const valid = (w: number, h: number): ImageSize | null => (w > 0 && h > 0 ? { w, h } : null);

  let r = need(4);
  if (r !== true) return r;

  if (b[0] === 0x89 && ascii(1, 'PNG')) {
    if ((r = need(24)) !== true) return r;
    if (!ascii(12, 'IHDR')) return null;
    return valid(u32be(16), u32be(20));
  }

  if (b[0] === 0x42 && b[1] === 0x4d) {
    if ((r = need(26)) !== true) return r;
    const dib = b[14] | (b[15] << 8) | (b[16] << 16) | (b[17] << 24);
    if (dib === 12) return valid(u16le(18), u16le(20));
    return valid(Math.abs(i32le(18)), Math.abs(i32le(22)));
  }

  if (ascii(0, 'RIFF')) {
    if ((r = need(30)) !== true) return r;
    if (!ascii(8, 'WEBP')) return null;
    if (ascii(12, 'VP8 ')) {
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return valid(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    }
    if (ascii(12, 'VP8L')) {
      if (b[20] !== 0x2f) return null;
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return valid((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (ascii(12, 'VP8X')) return valid(u24le(24) + 1, u24le(27) + 1);
    return null;
  }

  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    for (;;) {
      if ((r = need(i + 2)) !== true) return r;
      if (b[i] !== 0xff) return null;
      let m = b[i + 1];
      while (m === 0xff) {
        i++;
        if ((r = need(i + 2)) !== true) return r;
        m = b[i + 1];
      }
      i += 2;
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
      if (m === 0xd9 || m === 0xda) return null;
      if ((r = need(i + 2)) !== true) return r;
      const len = u16be(i);
      if (len < 2) return null;
      const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
      if (isSof) {
        if ((r = need(i + 7)) !== true) return r;
        return valid(u16be(i + 5), u16be(i + 3));
      }
      i += len;
    }
  }

  return null;
}
