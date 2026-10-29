import { inflateSync } from 'node:zlib';
import { validateImage } from './public-media.js';

const CODE = 'PUBLIC_ILLUSTRATION_UNSAFE';
const reject = () => { throw Object.assign(new Error(CODE), { code: CODE }); };
const need = (ok) => { if (!ok) reject(); };
const range = (b, p, n) => need(Number.isSafeInteger(p) && Number.isSafeInteger(n)
  && p >= 0 && n >= 0 && p <= b.length && n <= b.length - p);
const tag = (b, p, n = 4) => { range(b, p, n); return b.toString('latin1', p, p + n); };

const crcTable = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  return c >>> 0;
});
function crc(b, start, end) {
  let c = 0xffffffff;
  for (let p = start; p < end; p++) c = (c >>> 8) ^ crcTable[(c ^ b[p]) & 255];
  return (c ^ 0xffffffff) >>> 0;
}

function png(b) {
  let p = 8, header = false, palette = 0, transparency = false, data = false;
  let color, depth, width, height, compressedBytes = 0;
  const compressed = Buffer.allocUnsafe(b.length);
  while (p < b.length) {
    range(b, p, 12);
    const size = b.readUInt32BE(p), type = tag(b, p + 4), start = p + 8;
    range(b, start, size + 4);
    need(crc(b, p + 4, start + size) === b.readUInt32BE(start + size));
    need(header || type === 'IHDR');
    switch (type) {
      case 'IHDR': {
        need(!header && p === 8 && size === 13);
        width = b.readUInt32BE(start); height = b.readUInt32BE(start + 4);
        depth = b[start + 8]; color = b[start + 9];
        const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        need(width > 0 && width <= 0x7fffffff && height > 0 && height <= 0x7fffffff
          && depths[color]?.includes(depth) && b[start + 10] === 0 && b[start + 11] === 0
          && b[start + 12] === 0); // Interlaced PNG/APNG deliberately unsupported.
        header = true;
        break;
      }
      case 'PLTE':
        // A suggested, unused palette in truecolor PNG could carry arbitrary
        // non-rendering data; only indexed-color palettes are accepted.
        need(color === 3 && !palette && !transparency && !data && size > 0
          && size % 3 === 0 && size / 3 <= 2 ** depth);
        palette = size / 3;
        break;
      case 'tRNS':
        need(!transparency && !data);
        if (color === 3) need(palette > 0 && size > 0 && size <= palette);
        else if (color === 0 || color === 2) {
          need(size === (color === 0 ? 2 : 6));
          for (let i = 0; i < size; i += 2) need(b.readUInt16BE(start + i) < 2 ** depth);
        } else reject();
        transparency = true;
        break;
      case 'IDAT':
        need(color !== 3 || palette > 0);
        data = true;
        b.copy(compressed, compressedBytes, start, start + size); compressedBytes += size;
        break;
      case 'IEND': {
        need(data && compressedBytes > 0 && size === 0 && start + 4 === b.length);
        const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
        const rowBytes = Math.ceil(width * channels * depth / 8), expected = (rowBytes + 1) * height;
        // Bound expansion independently of the 5MiB encoded-file bound. No
        // unbounded inflate, interlace implementation, or external decoder.
        need(Number.isSafeInteger(expected) && expected > 0 && expected <= 16 * 1024 * 1024);
        const inflated = inflateSync(compressed.subarray(0, compressedBytes), { info: true, maxOutputLength: expected });
        need(inflated.engine.bytesWritten === compressedBytes && inflated.buffer.length === expected);
        for (let row = 0; row < height; row++) need(inflated.buffer[row * (rowBytes + 1)] <= 4);
        return;
      }
      default:
        // Includes eXIf, iCCP, tEXt/zTXt/iTXt, tIME, APNG chunks, and ALL
        // unknown critical/ancillary/private chunks, regardless of payload.
        reject();
    }
    p = start + size + 4;
  }
  reject();
}

function jpeg(b) {
  let p = 2, jfif = false, frame = null, restartInterval = 0;
  const quantization = new Set(), huffman = new Set();
  while (p < b.length) {
    range(b, p, 4);
    need(b[p] === 0xff);
    const marker = b[p + 1], size = b.readUInt16BE(p + 2), start = p + 4;
    need(size >= 2); range(b, start, size - 2);
    const end = start + size - 2;
    if (marker === 0xe0) {
      need(!jfif && p === 2 && size === 16 && tag(b, start, 5) === 'JFIF\0'
        && b[start + 5] === 1 && b[start + 6] <= 2 && b[start + 7] <= 2
        && b.readUInt16BE(start + 8) > 0 && b.readUInt16BE(start + 10) > 0
        && b[start + 12] === 0 && b[start + 13] === 0);
      jfif = true; // Fixed JFIF header only: no thumbnail or JFXX extension.
    } else if (marker === 0xdb) {
      need(!frame && size > 2);
      let q = start;
      while (q < end) {
        const table = b[q++];
        need(table <= 3 && !quantization.has(table)); range(b, q, 64); need(q + 64 <= end);
        for (let i = 0; i < 64; i++) need(b[q + i] > 0);
        quantization.add(table); q += 64;
      }
      need(q === end);
    } else if (marker === 0xc0) {
      need(!frame && size >= 11 && b[start] === 8);
      const count = b[start + 5];
      need((count === 1 || count === 3) && size === 8 + 3 * count
        && b.readUInt16BE(start + 1) > 0 && b.readUInt16BE(start + 3) > 0);
      frame = new Map();
      let blocks = 0;
      for (let i = 0; i < count; i++) {
        const q = start + 6 + 3 * i, id = b[q], h = b[q + 1] >>> 4, v = b[q + 1] & 15;
        need(!frame.has(id) && h >= 1 && h <= 4 && v >= 1 && v <= 4 && quantization.has(b[q + 2]));
        blocks += h * v; frame.set(id, true);
      }
      need(blocks <= 10);
    } else if (marker === 0xc4) {
      need(size > 2);
      let q = start;
      while (q < end) {
        need(end - q >= 17);
        const table = b[q++], kind = table >>> 4;
        need(kind <= 1 && (table & 15) <= 3 && !huffman.has(table));
        let count = 0, slots = 1;
        for (let i = 0; i < 16; i++) { count += b[q + i]; slots = slots * 2 - b[q + i]; need(slots > 0); }
        q += 16;
        need(count > 0 && count <= 256 && count <= end - q);
        const symbols = new Set();
        for (let i = 0; i < count; i++) {
          const symbol = b[q++];
          need(!symbols.has(symbol) && (kind === 0 ? symbol <= 11
            : (symbol & 15) <= 10 && ((symbol & 15) !== 0 || symbol === 0 || symbol === 0xf0)));
          symbols.add(symbol);
        }
        huffman.add(table);
      }
      need(q === end);
    } else if (marker === 0xdd) {
      need(size === 4 && !restartInterval && b.readUInt16BE(start) > 0);
      restartInterval = b.readUInt16BE(start);
    } else if (marker === 0xda) {
      need(frame && b[start] === frame.size && size === 6 + 2 * frame.size);
      const ids = new Set();
      for (let i = 0; i < frame.size; i++) {
        const id = b[start + 1 + i * 2], tables = b[start + 2 + i * 2];
        need(frame.has(id) && !ids.has(id) && huffman.has(tables >>> 4) && huffman.has(0x10 | (tables & 15)));
        ids.add(id);
      }
      need(b[end - 3] === 0 && b[end - 2] === 63 && b[end - 1] === 0);
      let bytes = 0, restart = 0;
      p = end;
      while (p < b.length) {
        if (b[p++] !== 0xff) { bytes++; continue; }
        range(b, p, 1);
        const next = b[p++];
        if (next === 0) { bytes++; continue; } // Stuffed pixel byte, not a marker.
        if (next >= 0xd0 && next <= 0xd7) {
          need(restartInterval > 0 && bytes > 0 && next === 0xd0 + restart);
          restart = (restart + 1) % 8; bytes = 0;
          continue;
        }
        need(next === 0xd9 && bytes > 0 && p === b.length);
        return;
      }
      reject();
    } else {
      // EXIF/XMP (APP1), ICC (APP2), IPTC/Photoshop (APP13), Adobe APP14,
      // COM, all other APP/unknown markers, progressive/arithmetic JPEG,
      // multiple scans, marker fill and embedded thumbnails are unsupported.
      reject();
    }
    p = end;
  }
  reject();
}

function gif(b) {
  range(b, 0, 13);
  const version = tag(b, 0, 6), width = b.readUInt16LE(6), height = b.readUInt16LE(8);
  need(version === 'GIF87a' || version === 'GIF89a');
  if (version === 'GIF87a') need((b[10] & 8) === 0);
  const globalColors = b[10] & 0x80 ? 2 ** ((b[10] & 7) + 1) : 0;
  need(globalColors ? b[11] < globalColors : b[11] === 0);
  let p = 13 + 3 * globalColors, images = 0, control = null;
  range(b, 13, 3 * globalColors);
  while (p < b.length) {
    const block = b[p++];
    if (block === 0x3b) { need(images > 0 && control === null && p === b.length); return; }
    if (block === 0x21) {
      range(b, p, 7);
      // No comments, plain text, XMP/ICC or application extensions (including
      // NETSCAPE loop controls); only the fixed graphics control is allowed.
      need(version === 'GIF89a' && control === null && b[p] === 0xf9 && b[p + 1] === 4
        && (b[p + 2] & 0xe2) === 0 && ((b[p + 2] >>> 2) & 7) <= 3 && b[p + 6] === 0);
      control = { transparent: !!(b[p + 2] & 1), index: b[p + 5] };
      need(control.transparent || control.index === 0);
      p += 7;
    } else if (block === 0x2c) {
      range(b, p, 9);
      const left = b.readUInt16LE(p), top = b.readUInt16LE(p + 2);
      const w = b.readUInt16LE(p + 4), h = b.readUInt16LE(p + 6), flags = b[p + 8];
      need(w > 0 && h > 0 && left + w <= width && top + h <= height && (flags & 0x18) === 0);
      if (version === 'GIF87a') need((flags & 0x20) === 0);
      const localColors = flags & 0x80 ? 2 ** ((flags & 7) + 1) : 0, colors = localColors || globalColors;
      need(colors > 0 && (!control?.transparent || control.index < colors));
      p += 9; range(b, p, 3 * localColors + 1); p += 3 * localColors;
      need(b[p] >= 2 && b[p] <= 8); p++;
      let bytes = 0;
      while (true) {
        range(b, p, 1);
        const size = b[p++];
        if (!size) break;
        range(b, p, size); bytes += size; p += size;
      }
      need(bytes > 0); images++; control = null;
    } else reject();
  }
  reject();
}

function webp(b) {
  need(tag(b, 0) === 'RIFF' && tag(b, 8) === 'WEBP');
  let p = 12, extended = null, alpha = false, image = false;
  while (p < b.length) {
    range(b, p, 8);
    const type = tag(b, p), size = b.readUInt32LE(p + 4), start = p + 8;
    range(b, start, size + (size & 1));
    if (size & 1) need(b[start + size] === 0);
    if (type === 'VP8X') {
      need(p === 12 && size === 10 && (b[start] & ~0x10) === 0
        && b[start + 1] === 0 && b[start + 2] === 0 && b[start + 3] === 0);
      extended = { alpha: !!(b[start] & 0x10), width: b.readUIntLE(start + 4, 3) + 1,
        height: b.readUIntLE(start + 7, 3) + 1 };
      need(extended.width * extended.height <= 0xffffffff);
    } else if (type === 'ALPH') {
      // Only raw alpha is supported, not the separate compressed-alpha codec.
      need(extended?.alpha && !alpha && !image && size > 1 && (b[start] & 0xc3) === 0
        && ((b[start] >>> 4) & 3) <= 1 && size === 1 + extended.width * extended.height);
      alpha = true;
    } else if (type === 'VP8 ' || type === 'VP8L') {
      need(!image);
      let width, height;
      if (type === 'VP8 ') {
        need(size > 10);
        const frame = b.readUIntLE(start, 3), partition = frame >>> 5;
        need((frame & 1) === 0 && ((frame >>> 1) & 7) <= 3 && (frame & 16) !== 0
          && tag(b, start + 3, 3) === '\x9d\x01\x2a' && partition > 0 && partition <= size - 10);
        const w = b.readUInt16LE(start + 6), h = b.readUInt16LE(start + 8);
        need((w & 0xc000) === 0 && (h & 0xc000) === 0);
        width = w; height = h;
        need(!extended || extended.alpha === alpha);
      } else {
        need(!alpha && size > 5 && b[start] === 0x2f);
        const header = b.readUInt32LE(start + 1);
        need((header >>> 29) === 0);
        width = (header & 0x3fff) + 1; height = ((header >>> 14) & 0x3fff) + 1;
        need(!extended || extended.alpha === !!(header & 0x10000000));
      }
      need(width > 0 && height > 0 && (!extended || (width === extended.width && height === extended.height)));
      image = true;
    } else reject(); // EXIF, XMP , ICCP, ANIM/ANMF, JUNK and ALL unknown chunks.
    p = start + size + (size & 1);
  }
  need(p === b.length && image);
}

/** Synchronous, deterministic, non-mutating container gate, NOT an approval or
 * absolute privacy detector. Return true or throw Error with BOTH code/message
 * PUBLIC_ILLUSTRATION_UNSAFE (never includes input bytes or parser diagnostics).
 *
 * Buffer only, 1..5MiB via validateImage; no IO/process/network/dependencies.
 * Strict subsets: non-interlaced static PNG (IHDR/PLTE/tRNS/IDAT/IEND with CRC,
 * exact bounded zlib consumption and <=16MiB decoded scanlines); single-scan
 * baseline Huffman JPEG (+optional fixed JFIF without thumbnail); GIF87a/89a
 * frames (+fixed graphics controls only); still WebP VP8/VP8L, optionally VP8X
 * and raw ALPH. Unsupported metadata/ancillary chunks are rejected, not stripped.
 * Every container boundary, padding and terminal position must be exact.
 * Parsers advance monotonically, with input <=5MiB; PNG inflation is bounded.
 *
 * JPEG/GIF/WebP codec payloads are opaque rendering data, not fully decoded or
 * a steganography check. This does NOT prove decoder safety, pixel privacy,
 * public provenance, license or QQ owner consent. Host must bind this verdict
 * to the SAME bytes/hash it previews/sends, perform vision/privacy review and
 * obtain QQ owner preview approval. Input remains mutable: do not use this as
 * a lasting attestation of a subsequently changed Buffer. Shared buffers fail.
 *
 * Container references:
 * https://www.w3.org/TR/png-3/
 * https://www.w3.org/Graphics/JPEG/itu-t81.pdf (Annex B)
 * https://www.w3.org/Graphics/JPEG/jfif3.pdf
 * https://www.w3.org/Graphics/GIF/spec-gif89a.txt
 * https://developers.google.com/speed/webp/docs/riff_container
 */
export function assertPublicIllustration(buffer) {
  try {
    const { mimeType } = validateImage(buffer);
    need(!(buffer.buffer instanceof SharedArrayBuffer));
    ({ 'image/png': png, 'image/jpeg': jpeg, 'image/gif': gif, 'image/webp': webp })[mimeType](buffer);
    return true;
  } catch {
    reject();
  }
}
