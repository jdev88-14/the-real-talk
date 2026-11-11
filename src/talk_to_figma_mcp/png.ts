// Composites a PNG onto a solid background, no dependency (system zlib only).
// Serves the "background" option of export_node_as_image: the node is never modified.
import { deflateSync, inflateSync } from "zlib";

export interface Rgba { r: number; g: number; b: number; a: number } // r, g, b: 0..255, a: 0..1

// "transparent", "#rgb", "#rrggbb" or "#rrggbbaa". null if the text is not a colour.
export function parseBackground(input: string): Rgba | null {
  const t = input.trim().toLowerCase();
  if (t === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(t);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(SIGNATURE)) return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// Places the PNG (RGBA or RGB, 8 bit, non-interlaced) on the bg background. Throws a clear error
// for any other format: the caller reports it, it never silently returns the image without background.
export function compositeOnBackground(png: Buffer, bg: Rgba): Buffer {
  if (bg.a === 0) return png;
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (pos + 12 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.subarray(pos + 4, pos + 8).toString("ascii");
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
    throw new Error(`unsupported PNG (bit depth ${bitDepth}, color type ${colorType}, interlace ${interlace}): only 8-bit RGB or RGBA`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error("PNG data has an unexpected size");
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error(`PNG filter ${f} unknown`);
      px[dst + x] = v & 0xff;
    }
  }
  const out = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    out[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const i = y * stride + x * bpp;
      const fa = bpp === 4 ? px[i + 3] / 255 : 1;
      const ra = fa + bg.a * (1 - fa);
      const o = y * (width * 4 + 1) + 1 + x * 4;
      const mix = (fc: number, bc: number) => (ra === 0 ? 0 : Math.round((fc * fa + bc * bg.a * (1 - fa)) / ra));
      out[o] = mix(px[i], bg.r);
      out[o + 1] = mix(px[i + 1], bg.g);
      out[o + 2] = mix(px[i + 2], bg.b);
      out[o + 3] = Math.round(ra * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(out)), chunk("IEND", Buffer.alloc(0))]);
}
