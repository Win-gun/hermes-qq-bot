import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, lstat, readdir, writeFile, readFile, chmod,
  symlink, link, unlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStickerCache } from '../src/sticker-cache.js';

// Only isolated synthetic bytes on disk. No real config, memory, QQ or network.
const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'sticker-cache-test-'));
const hash = value => createHash('sha256').update(value).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0uoAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b', 'hex');
const jpg = Buffer.from('ffd8ffe00000ffd9', 'hex');
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([12, 0, 0, 0]), Buffer.from('WEBPVP8L'), Buffer.alloc(4)]);
const id = 'account:foo';
const asset = (base, logicalId, bytes) => path.join(base, hash(logicalId), `${hash(bytes)}.asset`);
const input = (buffer = png, mimeType = 'image/png') => ({ buffer, mimeType, sha256: hash(buffer) });
const absent = async file => assert.rejects(lstat(file), { code: 'ENOENT' });
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
function fresh(name, options = {}) {
  const baseDir = path.join(root, name, 'sticker-assets');
  return { baseDir, cache: createStickerCache({ baseDir, ...options }) };
}
try {
  await test('missing security primitive returns inert cache; invalid arguments still throw', async () => {
    // Exercise actual capability detection, not a fake Windows no-follow mode.
    const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
    const baseDir = path.join(root, 'unavailable', 'sticker-assets');
    let cache, defaults;
    try {
      Object.defineProperty(process, 'getuid', { configurable: true, value: undefined });
      cache = createStickerCache({ baseDir, maxBytes: 123, maxEntries: 2 });
      defaults = createStickerCache({ baseDir });
      for (const options of [{ baseDir: '' }, { maxBytes: -1 }, { maxEntries: NaN }, { baseDir: path.parse(root).root }]) {
        assert.throws(() => createStickerCache({ baseDir, ...options }), { code: 'STICKER_CACHE_UNSAFE' });
      }
    } finally {
      if (descriptor) Object.defineProperty(process, 'getuid', descriptor);
      else delete process.getuid;
    }
    // Remains inert even when the ambient capability is restored.
    assert(Object.isFrozen(cache));
    assert.equal(await cache.put(id, input()), false);
    assert.equal(await cache.read(id, hash(png)), null);
    assert.deepEqual(await cache.status(id), { available: false, bytes: 0, entries: 0, maxBytes: 123, maxEntries: 2 });
    assert.deepEqual(await defaults.status(id), { available: false, bytes: 0, entries: 0, maxBytes: 128 * 1024 * 1024, maxEntries: 500 });
    await absent(path.dirname(baseDir));
  });
  await test('lazy construction; missing read/status do not create any directories', async () => {
    const { baseDir, cache } = fresh('lazy');
    await absent(path.dirname(baseDir));
    assert.equal(await cache.read(id, hash(png)), null);
    assert.deepEqual(await cache.status(id), { available: true, bytes: 0, entries: 0, maxBytes: 128 * 1024 * 1024, maxEntries: 500 });
    await absent(path.dirname(baseDir));
    assert.deepEqual(Object.keys(cache).sort(), ['put', 'read', 'status']);
  });
  await test('four accepted formats; byte/MIME/hash roundtrip; private modes; no sidecars', async () => {
    const { baseDir, cache } = fresh('roundtrip');
    for (const [bytes, type] of [[png, 'image/png'], [gif, 'image/gif'], [jpg, 'image/jpeg'], [webp, 'image/webp']]) {
      assert.equal(await cache.put(id, input(bytes, type)), true);
      assert.deepEqual(await cache.read(id, hash(bytes)), { buffer: bytes, mimeType: type, sha256: hash(bytes) });
      assert.equal((await lstat(asset(baseDir, id, bytes))).mode & 0o7777, 0o600);
    }
    assert.equal((await lstat(baseDir)).mode & 0o7777, 0o700);
    assert.equal((await lstat(path.join(baseDir, hash(id)))).mode & 0o7777, 0o700);
    assert.equal((await readdir(path.join(baseDir, hash(id)))).length, 4);
    assert.equal((await cache.status(id)).entries, 4);
    assert.equal((await cache.status(id)).available, true);
  });
  await test('byte/entry quotas reject full without eviction; dedup survives full', async () => {
    const { baseDir, cache } = fresh('quota', { maxBytes: png.length, maxEntries: 1 });
    assert.equal(await cache.put(id, input()), true);
    const before = await lstat(asset(baseDir, id, png));
    assert.equal(await cache.put(id, input()), true);
    assert.equal(await cache.put(id, input(gif, 'image/gif')), false);
    assert.equal((await lstat(asset(baseDir, id, png))).ino, before.ino);
    assert.equal((await cache.status(id)).bytes, png.length);
    const entry = fresh('entry-quota', { maxEntries: 1 });
    assert.equal(await entry.cache.put(id, input()), true);
    assert.equal(await entry.cache.put(id, input(gif, 'image/gif')), false);
    const byte = fresh('byte-quota', { maxBytes: png.length - 1 });
    assert.equal(await byte.cache.put(id, input()), false);
    assert.equal((await byte.cache.status(id)).entries, 0);
    assert.equal(await fresh('zero', { maxEntries: 0 }).cache.put(id, input()), false);
  });
  await test('concurrent callers/instances share mutation gate; immutable dedup and quota', async () => {
    const { baseDir, cache } = fresh('concurrent', { maxEntries: 1 });
    const other = createStickerCache({ baseDir, maxEntries: 1 });
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? cache : other).put(id, input())));
    assert(results.every(Boolean));
    assert.equal((await cache.status(id)).entries, 1);
    assert.equal((await readdir(path.join(baseDir, hash(id)))).length, 1);
    const c = fresh('competing', { maxEntries: 1 }).cache;
    assert.deepEqual(await Promise.all([c.put(id, input()), c.put(id, input(gif, 'image/gif'))]), [true, false]);
  });
  await test('wrong hash, MIME, bytes and >5MiB rejected before creating directories', async () => {
    const { baseDir, cache } = fresh('invalid');
    for (const value of [
      { ...input(), sha256: '0'.repeat(64) }, { ...input(), sha256: '../x' },
      input(png, 'image/jpeg'), input(Buffer.from('not an image')), input(Buffer.alloc(0)),
      input(Buffer.alloc(5 * 1024 * 1024 + 1)), { ...input(), buffer: new Uint8Array(png) }, null
    ]) assert.equal(await cache.put(id, value), false);
    await absent(baseDir);
    const limit = Buffer.alloc(5 * 1024 * 1024); png.copy(limit);
    assert.equal(await cache.put(id, input(limit)), true);
    assert.equal((await cache.read(id, hash(limit))).buffer.length, limit.length);
  });
  await test('logical IDs hash-isolated including path-shaped suffixes; malformed IDs fail closed', async () => {
    const { baseDir, cache } = fresh('identity');
    const unusual = 'account:../../outside';
    assert.equal(await cache.put(unusual, input()), true);
    assert.equal(await cache.read(id, hash(png)), null);
    assert.equal(await cache.read('group:../../outside', hash(png)), null);
    assert.deepEqual(await readdir(baseDir), [hash(unusual)]);
    for (const bad of ['', 'foo', 'account:', 'account:foo\n', {}, '__proto__', 'group:a b']) {
      assert.equal(await cache.put(bad, input()), false);
      assert.equal(await cache.read(bad, hash(png)), null);
      await assert.rejects(cache.status(bad), { code: 'STICKER_CACHE_UNSAFE' });
    }
  });
  await test('caller mutation cannot change queued write; returned bytes are independent', async () => {
    const { cache } = fresh('snapshot');
    const bytes = Buffer.from(png), promise = cache.put(id, input(bytes)); bytes.fill(0);
    assert.equal(await promise, true);
    const found = await cache.read(id, hash(png)); found.buffer.fill(0);
    assert.deepEqual((await cache.read(id, hash(png))).buffer, png);
  });
  await test('restart preserves assets and detects same-size corruption; never repairs/clobbers', async () => {
    const { baseDir, cache } = fresh('restart');
    assert.equal(await cache.put(id, input()), true);
    const restarted = createStickerCache({ baseDir });
    assert.deepEqual((await restarted.read(id, hash(png))).buffer, png);
    const file = asset(baseDir, id, png), broken = Buffer.from(png); broken[30] ^= 1;
    await writeFile(file, broken);
    assert.equal(await restarted.read(id, hash(png)), null);
    assert.equal(await restarted.put(id, input()), false);
    assert.deepEqual(await readFile(file), broken);
    assert.equal((await restarted.status(id)).bytes, png.length);
  });
  await test('base, ancestor and namespace symlinks rejected without target writes', async () => {
    const outside = path.join(root, 'outside'); await mkdir(outside, { mode: 0o700 });
    for (const location of ['base', 'ancestor', 'namespace']) {
      const { baseDir, cache } = fresh(`symlink-${location}`);
      if (location === 'ancestor') await symlink(outside, path.dirname(baseDir));
      else {
        await mkdir(path.dirname(baseDir), { recursive: true, mode: 0o700 });
        if (location === 'base') await symlink(outside, baseDir);
        else { await mkdir(baseDir, { mode: 0o700 }); await symlink(outside, path.join(baseDir, hash(id))); }
      }
      assert.equal(await cache.put(id, input()), false);
      assert.equal(await cache.read(id, hash(png)), null);
      await assert.rejects(cache.status(id), { code: 'STICKER_CACHE_UNSAFE' });
      assert.deepEqual(await readdir(outside), []);
    }
  });
  await test('asset symlink/hardlink and insecure file/directory permissions rejected untouched', async () => {
    const { baseDir, cache } = fresh('asset-security');
    assert.equal(await cache.put(id, input()), true);
    const file = asset(baseDir, id, png), outside = path.join(root, 'sentinel');
    await writeFile(outside, png, { mode: 0o600 }); await unlink(file); await symlink(outside, file);
    assert.equal(await cache.read(id, hash(png)), null); assert.equal(await cache.put(id, input()), false);
    assert((await lstat(file)).isSymbolicLink()); assert.deepEqual(await readFile(outside), png);
    await unlink(file); await link(outside, file);
    assert.equal(await cache.read(id, hash(png)), null); assert.equal(await cache.put(id, input()), false);
    await unlink(file); assert.equal(await cache.put(id, input()), true);
    await chmod(file, 0o644);
    assert.equal(await cache.read(id, hash(png)), null); assert.equal(await cache.put(id, input()), false);
    await chmod(file, 0o600);
    for (const dir of [baseDir, path.dirname(file)]) {
      await chmod(dir, 0o755);
      assert.equal(await cache.put(id, input()), false); assert.equal(await cache.read(id, hash(png)), null);
      await assert.rejects(cache.status(id), { code: 'STICKER_CACHE_UNSAFE' });
      assert.equal((await lstat(dir)).mode & 0o777, 0o755); await chmod(dir, 0o700);
    }
  });
  await test('restart recovery only exact owned temps; read/status remain non-mutating', async () => {
    const { baseDir, cache } = fresh('recover'); assert.equal(await cache.put(id, input()), true);
    const dir = path.join(baseDir, hash(id));
    const temp = path.join(dir, `.sticker-cache-v1-${'a'.repeat(32)}.tmp`);
    await link(asset(baseDir, id, png), temp); // Crash just after atomic publication.
    const restarted = createStickerCache({ baseDir });
    assert.equal((await restarted.status(id)).entries, 1);
    assert.equal((await lstat(temp)).nlink, 2);
    assert.equal(await restarted.put(id, input()), true); await absent(temp);
    const unknown = path.join(dir, '.not-owned.tmp'); await writeFile(unknown, 'preserve', { mode: 0o600 });
    assert.equal(await restarted.put(id, input(gif, 'image/gif')), false);
    assert.equal(await readFile(unknown, 'utf8'), 'preserve'); await unlink(unknown);
    for (let i = 0; i < 33; i++) await writeFile(path.join(dir, `.sticker-cache-v1-${i.toString(16).padStart(32, '0')}.tmp`), '', { mode: 0o600 });
    assert.equal(await restarted.put(id, input()), false);
    assert.equal((await readdir(dir)).length, 34); // Bounded fail-closed, not partial cleanup.
  });
  await test('owned-looking symlink temp is never followed or removed', async () => {
    const { baseDir, cache } = fresh('temp-symlink'); await cache.put(id, input());
    const temp = path.join(baseDir, hash(id), `.sticker-cache-v1-${'b'.repeat(32)}.tmp`);
    await symlink(path.join(root, 'missing-target'), temp);
    assert.equal(await cache.put(id, input()), false); assert((await lstat(temp)).isSymbolicLink());
    await absent(path.join(root, 'missing-target'));
  });
  await test('bounded recovery clears 32 partial temps, preserves other namespaces', async () => {
    const { baseDir, cache } = fresh('bounded-recovery'); await cache.put(id, input());
    const dir = path.join(baseDir, hash(id));
    for (let i = 0; i < 32; i++) await writeFile(path.join(dir, `.sticker-cache-v1-${i.toString(16).padStart(32, '0')}.tmp`), '', { mode: 0o600 });
    const peer = path.join(baseDir, hash('account:peer')); await mkdir(peer, { mode: 0o700 });
    const untouched = path.join(peer, `.sticker-cache-v1-${'c'.repeat(32)}.tmp`);
    await writeFile(untouched, 'partial', { mode: 0o600 });
    assert.equal(await cache.put(id, input(gif, 'image/gif')), true);
    assert.equal((await readdir(dir)).length, 2);
    assert.equal(await readFile(untouched, 'utf8'), 'partial');
  });
  await test('oversized/truncated/non-image on disk fail closed and still occupy quota', async () => {
    const { baseDir, cache } = fresh('disk-corruption'); await cache.put(id, input());
    const file = asset(baseDir, id, png);
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(5 * 1024 * 1024 + 1)]) {
      await writeFile(file, bytes);
      assert.equal(await cache.read(id, hash(png)), null);
      assert.equal(await cache.put(id, input()), false);
      assert.equal((await cache.status(id)).entries, 1);
      assert.equal((await cache.status(id)).bytes, bytes.length);
    }
    await unlink(file);
    const bad = Buffer.from('not a supported image');
    await writeFile(asset(baseDir, id, bad), bad, { mode: 0o600 });
    assert.equal(await cache.read(id, hash(bad)), null);
  });
  await test('invalid options rejected without IO', () => {
    for (const options of [{ maxBytes: -1 }, { maxEntries: NaN }, { maxEntries: 100001 }, { baseDir: '/' }, { baseDir: `${root}/../escape` }]) {
      assert.throws(() => createStickerCache({ baseDir: path.join(root, 'options'), ...options }), { code: 'STICKER_CACHE_UNSAFE' });
    }
  });
  console.log(`sticker-cache: ${passed} tests passed`);
} finally { await rm(root, { recursive: true, force: true }); }
