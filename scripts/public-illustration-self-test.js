import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { assertPublicIllustration } from '../src/public-illustration.js';
import { MAX_IMAGE_BYTES, validateImage } from '../src/public-media.js';

// In-memory fixtures only: no image files, network, processes, QQ or disk IO.
const CODE = 'PUBLIC_ILLUSTRATION_UNSAFE';
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
function unsafe(value) {
  assert.throws(() => assertPublicIllustration(value), e => {
    assert.equal(e.constructor, Error);
    assert.equal(e.code, CODE); assert.equal(e.message, CODE);
    assert.deepEqual(Object.keys(e), ['code']);
    return true;
  });
}
function safe(value) {
  const before = Buffer.from(value);
  assert.equal(assertPublicIllustration(value), true);
  assert.deepEqual(value, before);
}
const join = (...buffers) => Buffer.concat(buffers);
const bytes = (...values) => Buffer.from(values);
function u32(value, little = false) {
  const b = Buffer.alloc(4); little ? b.writeUInt32LE(value) : b.writeUInt32BE(value); return b;
}
function u16(value, little = false) {
  const b = Buffer.alloc(2); little ? b.writeUInt16LE(value) : b.writeUInt16BE(value); return b;
}
function crc(b) {
  let c = 0xffffffff;
  for (const byte of b) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
const chunk = (name, data = Buffer.alloc(0)) => {
  const body = join(Buffer.from(name, 'latin1'), data);
  return join(u32(data.length), body, u32(crc(body)));
};
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const ihdr = ({ width = 1, height = 1, depth = 8, color = 6, interlace = 0 } = {}) =>
  chunk('IHDR', join(u32(width), u32(height), bytes(depth, color, 0, 0, interlace)));
function png({ header = ihdr(), pre = [], post = [], raw = bytes(0, 255, 0, 0, 255), compressed = deflateSync(raw), data } = {}) {
  return join(pngSignature, header, ...pre, ...(data || [chunk('IDAT', compressed)]), ...post, chunk('IEND'));
}
const basePng = png();

const marker = (id, data) => join(bytes(0xff, id), u16(data.length + 2), data);
const jfif = marker(0xe0, join(Buffer.from('JFIF\0'), bytes(1, 2, 0), u16(1), u16(1), bytes(0, 0)));
const dqt = marker(0xdb, join(bytes(0), Buffer.alloc(64, 1)));
const sof = marker(0xc0, join(bytes(8), u16(1), u16(1), bytes(1, 1, 0x11, 0)));
const huffTable = id => join(bytes(id, 1), Buffer.alloc(15), bytes(0));
const dht = marker(0xc4, join(huffTable(0), huffTable(0x10)));
const sos = marker(0xda, bytes(1, 1, 0, 0, 63, 0));
const eoi = bytes(0xff, 0xd9);
const jpeg = ({ pre = [], frame = sof, tables = dht, scan = sos, entropy = bytes(0x3f), after = [] } = {}) =>
  join(bytes(0xff, 0xd8), ...pre, dqt, frame, tables, scan, entropy, ...after, eoi);
// DC difference=0, AC EOB, followed by 1 padding bits: a valid 1x1 baseline scan.
const baseJpeg = jpeg();

const gifHeader = Buffer.from('47494638396101000100800000000000ffffff', 'hex');
const gifFrame = Buffer.from('2c0000000001000100000202440100', 'hex');
const gce = Buffer.from('21f9040100000000', 'hex');
const gif = (...blocks) => join(gifHeader, ...blocks, bytes(0x3b));
const baseGif = gif(gifFrame);
const gifExtension = (label, payload) => join(bytes(0x21, label, payload.length), payload, bytes(0));

const riffChunk = (type, data) => join(Buffer.from(type, 'latin1'), u32(data.length, true), data,
  data.length & 1 ? bytes(0) : Buffer.alloc(0));
const webp = (...chunks) => {
  const data = join(Buffer.from('WEBP'), ...chunks);
  return join(Buffer.from('RIFF'), u32(data.length, true), data);
};
// 1x1 VP8L header/payload fixture; this gate does not decode the VP8L codec.
const vp8l = Buffer.from('2f00000000071011118888fe0700', 'hex');
const baseWebp = webp(riffChunk('VP8L', vp8l));
const vp8x = (flags = 0, width = 1, height = 1) => {
  const b = Buffer.alloc(10); b[0] = flags;
  b.writeUIntLE(width - 1, 4, 3); b.writeUIntLE(height - 1, 7, 3);
  return riffChunk('VP8X', b);
};
// Header/partition fixture for parser branches; the guard does not decode VP8.
const vp8 = join(bytes(0x30, 0, 0, 0x9d, 1, 0x2a), u16(1, true), u16(1, true), bytes(0));

test('four formats have positive, immutable, synchronous deterministic verdicts', () => {
  for (const b of [basePng, baseJpeg, baseGif, baseWebp]) {
    safe(b); safe(b);
    const offset = join(bytes(7, 8, 9), b, bytes(10));
    safe(offset.subarray(3, 3 + b.length));
  }
});

test('invalid input, format spoof and shared backing memory use the one fixed error', () => {
  for (const b of [undefined, null, '', [], {}, new Uint8Array(basePng), Buffer.alloc(0),
    Buffer.from('<svg/>'), Buffer.from('secret=private@example.com'), Buffer.from('RIFFWEBP')]) unsafe(b);
  const shared = Buffer.from(new SharedArrayBuffer(basePng.length)); basePng.copy(shared); unsafe(shared);
  // Base validateImage's ASCII sniff masks bit 7; the structural parser must not.
  for (const [b, offsets] of [[basePng, [12]], [baseGif, [0, 1, 5]], [baseWebp, [0, 8, 12]]]) {
    for (const offset of offsets) { const changed = Buffer.from(b); changed[offset] |= 128; unsafe(changed); }
  }
});

test('PNG non-interlaced grayscale/RGB/indexed/alpha/16-bit with rendering transparency', () => {
  const examples = [
    { color: 0, depth: 1, raw: bytes(0, 0x80) },
    { color: 0, depth: 8, raw: bytes(0, 1), pre: [chunk('tRNS', u16(1))] },
    { color: 2, depth: 8, raw: bytes(0, 1, 2, 3), pre: [chunk('tRNS', join(u16(1), u16(2), u16(3)))] },
    { color: 3, depth: 1, raw: bytes(0, 0), pre: [chunk('PLTE', bytes(255, 0, 0, 0, 0, 255)), chunk('tRNS', bytes(0, 255))] },
    { color: 4, depth: 8, raw: bytes(0, 1, 255) },
    { color: 6, depth: 16, raw: bytes(0, 255, 255, 0, 0, 0, 0, 255, 255) }
  ];
  for (const sample of examples) safe(png({ ...sample, header: ihdr(sample) }));
  const compressed = deflateSync(bytes(0, 255, 0, 0, 255));
  safe(png({ data: [chunk('IDAT', compressed.subarray(0, 1)), chunk('IDAT'), chunk('IDAT', compressed.subarray(1))] }));
});

test('PNG rejects text, EXIF, XMP, IPTC-like private chunks, profiles and every unknown chunk', () => {
  for (const [name, payload] of [
    ['tEXt', Buffer.from('Owner\0Private Person')], ['zTXt', join(Buffer.from('Comment\0\0'), deflateSync(Buffer.from('GPS=private')))],
    ['iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<private/>')],
    ['eXIf', Buffer.from('II*\0GPS-private')], ['iCCP', Buffer.from('personal-profile\0\0')],
    ['tIME', Buffer.alloc(7)], ['iPTC', Buffer.from('Private Person')], ['vpAg', Buffer.from('private')],
    ['zzZZ', Buffer.alloc(0)], ['ABCD', Buffer.alloc(0)], ['gAMA', u32(45455)],
    ['sRGB', bytes(0)], ['acTL', join(u32(1), u32(0))]
  ]) {
    const b = png({ pre: [chunk(name, payload)] });
    assert.equal(validateImage(b).mimeType, 'image/png'); unsafe(b);
    unsafe(png({ post: [chunk(name, payload)] }));
  }
});

test('PNG bad CRC/order/length/palette/header/filter and zlib tails fail closed', () => {
  const badCrc = Buffer.from(basePng); badCrc[29] ^= 1; unsafe(badCrc);
  for (const header of [ihdr({ color: 1 }), ihdr({ depth: 3 }), ihdr({ interlace: 1 }),
    ihdr({ width: 0 }), ihdr({ width: 0x80000000 })]) unsafe(png({ header }));
  unsafe(png({ pre: [ihdr()] }));
  unsafe(join(pngSignature, chunk('IDAT', bytes(1)), ihdr(), chunk('IEND')));
  unsafe(png({ header: ihdr({ color: 3, depth: 1 }), raw: bytes(0, 0) }));
  unsafe(png({ pre: [chunk('PLTE', bytes(1, 2, 3))] }));
  unsafe(png({ header: ihdr({ color: 3, depth: 1 }), raw: bytes(0, 0), pre: [chunk('PLTE', Buffer.alloc(9))] }));
  unsafe(png({ pre: [chunk('tRNS', bytes(1))] }));
  unsafe(png({ post: [chunk('IDAT'), ihdr()] }));
  unsafe(png({ raw: bytes(5, 0, 0, 0, 0) }));
  unsafe(png({ raw: bytes(0, 1) }));
  unsafe(png({ raw: Buffer.alloc(6) }));
  unsafe(png({ compressed: bytes(1, 2, 3) }));
  unsafe(png({ compressed: join(deflateSync(bytes(0, 255, 0, 0, 255)), Buffer.from('hidden trailing metadata')) }));
  unsafe(png({ compressed: join(deflateSync(bytes(0, 255, 0, 0, 255)), deflateSync(Buffer.from('private'))) }));
  const hugeChunk = Buffer.from(basePng); hugeChunk.writeUInt32BE(0xffffffff, 33); unsafe(hugeChunk);
  unsafe(join(pngSignature, ihdr(), chunk('IEND')));
});

test('PNG bounded expansion rejects bombs and huge dimensions without growing output unboundedly', () => {
  unsafe(png({ header: ihdr({ width: 0x7fffffff, height: 0x7fffffff }) }));
  unsafe(png({ header: ihdr({ width: 1, height: 5000000, color: 6 }) }));
  // Small declared image with far more expanded scanline bytes than permitted.
  unsafe(png({ compressed: deflateSync(Buffer.alloc(2 * 1024 * 1024)) }));
});

test('JPEG baseline with/without fixed JFIF and escaped scan bytes', () => {
  safe(jpeg({ pre: [jfif] }));
  safe(jpeg({ entropy: bytes(0x3f, 0xff, 0, 0) }));
  safe(jpeg({ pre: [marker(0xdd, u16(1))], entropy: bytes(0x3f, 0xff, 0xd0, 0x3f, 0xff, 0xd1, 0x3f) }));
});

test('JPEG rejects EXIF/GPS, IPTC, XMP, ICC, comments and unknown APP markers', () => {
  for (const [id, body] of [
    [0xe1, Buffer.from('Exif\0\0II*\0GPS-Private')], [0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<private/>')],
    [0xed, Buffer.from('Photoshop 3.0\0IPTC Private Person')], [0xe2, Buffer.from('ICC_PROFILE\0private')],
    [0xfe, Buffer.from('Private Person')], [0xee, Buffer.from('Adobe-private')],
    [0xe3, Buffer.alloc(0)], [0xef, Buffer.from('unknown')]
  ]) {
    const segment = marker(id, body);
    unsafe(jpeg({ pre: [segment] }));
    unsafe(jpeg({ after: [segment] }));
  }
  unsafe(jpeg({ pre: [marker(0xe0, Buffer.from('JFXX\0hidden thumbnail'))] }));
  const thumbnail = Buffer.from(jfif); thumbnail[thumbnail.length - 2] = 1;
  unsafe(jpeg({ pre: [thumbnail] }));
  unsafe(jpeg({ pre: [jfif, jfif] }));
});

test('JPEG malformed tables/scan/restart/lengths, progressive and extra scans reject', () => {
  unsafe(jpeg({ frame: marker(0xc2, sof.subarray(4)) }));
  unsafe(jpeg({ frame: marker(0xc0, bytes(8, 0, 1)) }));
  unsafe(jpeg({ tables: marker(0xc4, bytes(0, 255)) }));
  unsafe(jpeg({ tables: marker(0xc4, join(bytes(0, 2), Buffer.alloc(15), bytes(0, 1))) }));
  unsafe(jpeg({ scan: marker(0xda, bytes(1, 1, 0, 1, 63, 0)) }));
  unsafe(jpeg({ tables: Buffer.alloc(0) }));
  unsafe(jpeg({ entropy: Buffer.alloc(0) }));
  unsafe(jpeg({ entropy: bytes(0x3f, 0xff) }));
  unsafe(jpeg({ entropy: bytes(0x3f, 0xff, 0xff, 0) }));
  unsafe(jpeg({ entropy: bytes(0x3f, 0xff, 0xd0, 0x3f) }));
  unsafe(jpeg({ pre: [marker(0xdd, u16(1))], entropy: bytes(0x3f, 0xff, 0xd1, 0x3f) }));
  unsafe(jpeg({ after: [sos, bytes(0x3f)] }));
  for (const size of [0, 1, 0xffff]) {
    const b = Buffer.from(baseJpeg); b.writeUInt16BE(size, 4); unsafe(b);
  }
  const duplicate = join(baseJpeg.subarray(0, 2), dqt, baseJpeg.subarray(2)); unsafe(duplicate);
});

test('GIF87a/89a palettes, transparency control, local table and animation frames', () => {
  const old = Buffer.from(baseGif); old[4] = 0x37; safe(old);
  safe(gif(gce, gifFrame));
  safe(gif(gce, gifFrame, gce, gifFrame));
  const local = Buffer.from(gifFrame); local[9] = 0x80;
  safe(gif(join(local.subarray(0, 10), bytes(0, 0, 0, 255, 255, 255), local.subarray(10))));
  const interlaced = Buffer.from(gifFrame); interlaced[9] |= 0x40; safe(gif(interlaced));
});

test('GIF comment/application/XMP/plain-text/unknown extensions are rejected at every boundary', () => {
  for (const extension of [gifExtension(0xfe, Buffer.from('private address')),
    gifExtension(0xff, Buffer.from('XMP DataXMPprivate')),
    join(bytes(0x21, 0xff, 11), Buffer.from('NETSCAPE2.0'), bytes(3, 1, 0, 0, 0)),
    gifExtension(1, Buffer.from('private text')), gifExtension(0xfd, Buffer.alloc(0))]) {
    unsafe(gif(extension, gifFrame)); unsafe(gif(gifFrame, extension));
    unsafe(gif(gifFrame, extension, gifFrame));
  }
});

test('GIF malformed fixed/sub-block lengths, reserved controls and missing palettes fail closed', () => {
  unsafe(gif()); unsafe(gif(gifFrame, gce)); unsafe(gif(gce, gce, gifFrame));
  const old = gif(gce, gifFrame); old[4] = 0x37; unsafe(old);
  const oldSorted = Buffer.from(baseGif); oldSorted[4] = 0x37; oldSorted[10] |= 8; unsafe(oldSorted);
  for (const index of [1, 2, 3, 7]) {
    const bad = Buffer.from(gce); bad[index] = 255; unsafe(gif(bad, gifFrame));
  }
  for (const [index, value] of [[9, 0x18], [10, 1], [11, 255], [1, 2], [5, 0], [14, 255]]) {
    const bad = Buffer.from(gifFrame); bad[index] = value; unsafe(gif(bad));
  }
  const noTable = Buffer.from(baseGif); noTable[10] = 0;
  unsafe(join(noTable.subarray(0, 13), gifFrame, bytes(0x3b)));
  const local = Buffer.from(gifFrame); local[9] = 0x87;
  unsafe(gif(local));
  unsafe(gif(gifFrame.subarray(0, -1)));
  unsafe(gif(join(gifFrame.subarray(0, 11), bytes(0))));
});

test('WebP VP8L/simple VP8/static VP8X/raw-alpha positive profiles and zero RIFF padding', () => {
  safe(webp(riffChunk('VP8 ', vp8)));
  safe(webp(vp8x(), riffChunk('VP8L', vp8l)));
  safe(webp(vp8x(0x10), riffChunk('ALPH', bytes(0, 255)), riffChunk('VP8 ', vp8)));
  const alphaHeader = Buffer.from(vp8l); alphaHeader[4] |= 0x10;
  safe(webp(vp8x(0x10), riffChunk('VP8L', alphaHeader)));
});

test('WebP EXIF, XMP, ICCP and unknown RIFF blocks rejected, including after pixel data', () => {
  for (const name of ['EXIF', 'XMP ', 'ICCP', 'IPTC', 'JUNK', 'zzzz', 'ANIM', 'ANMF']) {
    const metadata = riffChunk(name, Buffer.from('Private Person GPS=hidden'));
    unsafe(webp(vp8x(), metadata, riffChunk('VP8L', vp8l)));
    unsafe(webp(riffChunk('VP8L', vp8l), metadata));
  }
  for (const flags of [1, 2, 4, 8, 32, 64, 128]) unsafe(webp(vp8x(flags), riffChunk('VP8L', vp8l)));
});

test('WebP oversized chunks/RIFF length, hidden padding, bad order/headers and alpha mismatch reject', () => {
  for (const size of [0, 1, 0xffffffff]) {
    const bad = Buffer.from(baseWebp); bad.writeUInt32LE(size, 16); unsafe(bad);
  }
  for (const size of [0, 1, baseWebp.length, 0xffffffff]) {
    const bad = Buffer.from(baseWebp); bad.writeUInt32LE(size, 4); unsafe(bad);
  }
  const odd = riffChunk('VP8 ', vp8); odd[odd.length - 1] = 65; unsafe(webp(odd));
  unsafe(webp(vp8x(), riffChunk('VP8L', vp8l), riffChunk('VP8L', vp8l)));
  unsafe(webp(riffChunk('VP8L', vp8l), vp8x()));
  unsafe(webp(vp8x(0x10), riffChunk('VP8 ', vp8)));
  unsafe(webp(vp8x(), riffChunk('ALPH', bytes(0, 255)), riffChunk('VP8 ', vp8)));
  unsafe(webp(vp8x(0x10), riffChunk('ALPH', bytes(1, 255)), riffChunk('VP8 ', vp8)));
  unsafe(webp(vp8x(0x10), riffChunk('ALPH', bytes(0, 255, 128)), riffChunk('VP8 ', vp8)));
  unsafe(webp(vp8x(0x10), riffChunk('VP8L', vp8l)));
  unsafe(webp(vp8x(0, 2, 1), riffChunk('VP8L', vp8l)));
  const reserved = Buffer.from(vp8x()); reserved[9] = 1;
  unsafe(webp(reserved, riffChunk('VP8L', vp8l)));
  const losslessVersion = Buffer.from(vp8l); losslessVersion[4] |= 0x20;
  unsafe(webp(riffChunk('VP8L', losslessVersion)));
  const interframe = Buffer.from(vp8); interframe[0] |= 1;
  unsafe(webp(riffChunk('VP8 ', interframe)));
  unsafe(webp(riffChunk('VP8L', vp8l.subarray(0, 5))));
});

test('all formats reject every truncated prefix and bytes outside the final container', () => {
  for (const b of [basePng, baseJpeg, baseGif, baseWebp]) {
    for (let length = 0; length < b.length; length++) unsafe(b.subarray(0, length));
    for (const tail of [bytes(0), Buffer.from('hidden metadata'), b]) unsafe(join(b, tail));
  }
  // Keep weak signature checks satisfied while hiding bytes before a second
  // apparent trailer; a first end marker must still be terminal.
  unsafe(join(baseJpeg, Buffer.from('private'), eoi));
  unsafe(join(baseGif, Buffer.from('private'), bytes(0x3b)));
  const nested = join(baseWebp, riffChunk('JUNK', Buffer.from('private')));
  nested.writeUInt32LE(nested.length - 8, 4); unsafe(nested);
});

test('5MiB exact inclusive boundary, over-limit and malicious lengths; no metadata echo', () => {
  // Large encoded PNG, not a decompression bomb or an arbitrary ancillary pad.
  let boundary;
  for (let width = MAX_IMAGE_BYTES - 2000; width < MAX_IMAGE_BYTES; width++) {
    const compressed = deflateSync(Buffer.alloc(width + 1), { level: 0 });
    const image = png({ header: ihdr({ width, color: 0 }), compressed });
    const remaining = MAX_IMAGE_BYTES - image.length;
    if (remaining >= 0 && remaining % 12 === 0) {
      boundary = png({ header: ihdr({ width, color: 0 }),
        data: [chunk('IDAT', compressed), ...Array(remaining / 12).fill(chunk('IDAT'))] });
      break;
    }
  }
  assert(boundary); assert.equal(boundary.length, MAX_IMAGE_BYTES); safe(boundary);
  unsafe(join(boundary, bytes(0)));
  for (const image of [baseJpeg, baseGif, baseWebp]) {
    const tooLarge = Buffer.alloc(MAX_IMAGE_BYTES + 1); image.copy(tooLarge); unsafe(tooLarge);
  }
  const metadata = png({ pre: [chunk('tEXt', Buffer.from('SECRET-private-name@example.com'))] });
  unsafe(metadata);
});

test('deterministic bounded mutation fuzz yields true or the fixed error, never RangeError', () => {
  let seed = 1234567;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (const base of [basePng, baseJpeg, baseGif, baseWebp]) {
    for (let i = 0; i < 1000; i++) {
      const b = Buffer.from(base);
      for (let j = 0; j < 1 + i % 4; j++) b[random() % b.length] = random() & 255;
      const before = Buffer.from(b);
      try { assert.equal(assertPublicIllustration(b), true); }
      catch (e) { assert.equal(e.code, CODE); assert.equal(e.message, CODE); }
      assert.deepEqual(b, before);
    }
  }
});

console.log(`public-illustration: ${passed} tests passed (in-memory only; no IO)`);
