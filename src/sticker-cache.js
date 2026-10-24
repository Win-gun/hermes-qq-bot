import { constants as C, lstatSync, openSync, closeSync, fstatSync, mkdirSync,
  opendirSync, readSync, writeSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { validateImage, MAX_IMAGE_BYTES } from './public-media.js';

const HASH = /^[a-f0-9]{64}$/;
const ASSET = /^[a-f0-9]{64}\.asset$/;
const TEMP = /^\.sticker-cache-v1-[a-f0-9]{32}\.tmp$/;
const MAX_TEMPS = 32;
// Shared across instances, including instances with different limits/overlapping roots.
let tail = Promise.resolve();
function serial(fn) {
  const next = tail.then(fn);
  tail = next.catch(() => {});
  return next;
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => Object.assign(new Error('Unsafe or unavailable sticker cache'), { code: 'STICKER_CACHE_UNSAFE' });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const privateMode = (s, mode) => (s.mode & 0o7777) === mode && s.uid === process.getuid();
function stat(file) {
  try { return lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** Local, per-logical-identity quotas; no eviction or metadata sidecars.
 * Host-controlled ancestors must not be renamed by another writer during calls.
 * Node has no portable openat: every component is no-follow opened, pinned and
 * revalidated around IO, but this is not a sandbox against a hostile host owner.
 * put returns false/read returns null on invalid or unsafe data; status rejects
 * unsafe trees rather than misreporting them as empty. Unsupported platforms
 * return an inert cache with available:false; security checks are never relaxed.
 * No IO at construction.
 */
export function createStickerCache({ baseDir, maxBytes = 128 * 1024 * 1024, maxEntries = 500 } = {}) {
  if (typeof baseDir !== 'string' || !baseDir || baseDir.includes('\0')
    || baseDir.split(path.sep).includes('..') || !Number.isSafeInteger(maxBytes) || maxBytes < 0
    || !Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > 100000) throw fail();
  const base = path.resolve(baseDir);
  if (base === path.parse(base).root) throw fail();
  // Validate arguments first, then fail closed without touching the filesystem.
  // Do not emulate POSIX no-follow/ownership guarantees on Windows.
  if (process.platform === 'win32' || typeof process.getuid !== 'function' || !C.O_NOFOLLOW || !C.O_DIRECTORY) {
    return Object.freeze({
      async put() { return false; },
      async read() { return null; },
      async status() { return { available: false, bytes: 0, entries: 0, maxBytes, maxEntries }; }
    });
  }
  function namespace(logicalId) {
    if (typeof logicalId !== 'string' || logicalId.length > 1024
      || !/^(account|group):[^\s\x00-\x1f\x7f]+$/u.test(logicalId)) throw fail();
    return path.join(base, digest(logicalId));
  }
  // Keep directory descriptors open until the operation ends. Never chmod a
  // pathname: existing insecure cache directories/files are rejected untouched.
  function tree(dir, create) {
    const pinned = [];
    const check = () => {
      for (const item of pinned) {
        const now = stat(item.file), held = fstatSync(item.fd);
        if (!now?.isDirectory() || !same(now, held) || !same(now, item.s)
          || (item.private && !privateMode(now, 0o700))) throw fail();
      }
    };
    const close = () => { for (const item of pinned.reverse()) closeSync(item.fd); };
    try {
      let current = path.parse(dir).root;
      const segments = [current];
      for (const part of dir.slice(current.length).split(path.sep)) {
        current = path.join(current, part); segments.push(current);
      }
      for (const file of segments) {
        check();
        let s = stat(file);
        if (!s && create) {
          try { mkdirSync(file, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
          s = stat(file);
        }
        if (!s) { close(); return null; }
        const isPrivate = file === base || file === dir;
        if (!s.isDirectory() || (isPrivate && !privateMode(s, 0o700))) throw fail();
        const fd = openSync(file, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
        pinned.push({ file, fd, s, private: isPrivate });
        check();
      }
      return { check, close, fd: pinned.at(-1).fd };
    } catch (e) { close(); throw e; }
  }
  function regular(s) {
    return s?.isFile() && privateMode(s, 0o600) && s.nlink === 1
      && s.size > 0 && s.size <= MAX_IMAGE_BYTES;
  }
  function load(dir, hash, guard) {
    guard.check();
    const file = path.join(dir, `${hash}.asset`), before = stat(file);
    if (!before) return null;
    if (!regular(before)) throw fail();
    let fd;
    try {
      fd = openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      const opened = fstatSync(fd);
      if (!same(before, opened) || !regular(opened)) throw fail();
      const buffer = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < buffer.length) {
        const n = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (!n) throw fail();
        offset += n;
      }
      const after = fstatSync(fd), named = stat(file);
      guard.check();
      if (!named || !same(named, after) || !same(opened, after) || !regular(after)
        || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs
        || opened.ctimeMs !== after.ctimeMs || digest(buffer) !== hash) throw fail();
      return { ...validateImage(buffer), sha256: hash };
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  function inventory(dir, guard, recover) {
    guard.check();
    const listing = opendirSync(dir), temps = [];
    let bytes = 0, entries = 0, seen = 0;
    try {
      let entry;
      while ((entry = listing.readSync())) {
        // Bound work even in a malformed directory; do not recurse.
        if (++seen > Math.max(500, maxEntries) + MAX_TEMPS + 1) throw fail();
        guard.check();
        const file = path.join(dir, entry.name), s = stat(file);
        if (TEMP.test(entry.name)) {
          if (temps.length >= MAX_TEMPS || !s?.isFile() || !privateMode(s, 0o600)
            || s.nlink < 1 || s.nlink > 2 || s.size > MAX_IMAGE_BYTES) throw fail();
          temps.push({ file, s });
        } else {
          // Count corrupt assets too: corruption must never free quota.
          if (!ASSET.test(entry.name) || !s?.isFile() || !privateMode(s, 0o600)
            || s.nlink < 1 || s.nlink > 2) throw fail();
          bytes += s.size; entries++;
          if (!Number.isSafeInteger(bytes)) throw fail();
        }
      }
    } finally { listing.closeSync(); }
    guard.check();
    if (recover) {
      for (const item of temps) {
        guard.check();
        const now = stat(item.file);
        if (!now?.isFile() || !same(now, item.s)) throw fail();
        unlinkSync(item.file);
      }
      if (temps.length) fsyncSync(guard.fd);
    }
    return { bytes, entries, maxBytes, maxEntries };
  }
  return Object.freeze({
    async put(logicalId, input) {
      // Snapshot caller-owned bytes before waiting behind another operation.
      let dir, buffer, sha256, mimeType;
      try {
        dir = namespace(logicalId);
        if (!input || !HASH.test(input.sha256) || !Buffer.isBuffer(input.buffer)
          || input.buffer.length > MAX_IMAGE_BYTES) return false;
        buffer = Buffer.from(input.buffer); sha256 = input.sha256;
        mimeType = validateImage(buffer, input.mimeType).mimeType;
        if (digest(buffer) !== sha256) return false;
      } catch { return false; }
      return serial(() => {
        let guard, fd, temp, owned;
        try {
          guard = tree(dir, true);
          const usage = inventory(dir, guard, true);
          const target = path.join(dir, `${sha256}.asset`);
          if (stat(target)) return load(dir, sha256, guard)?.mimeType === mimeType;
          if (usage.entries >= maxEntries || buffer.length > maxBytes - usage.bytes) return false;
          guard.check();
          temp = path.join(dir, `.sticker-cache-v1-${randomBytes(16).toString('hex')}.tmp`);
          fd = openSync(temp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
          owned = fstatSync(fd);
          if (!privateMode(owned, 0o600)) throw fail();
          let offset = 0;
          while (offset < buffer.length) {
            const n = writeSync(fd, buffer, offset, buffer.length - offset);
            if (!n) throw fail();
            offset += n;
          }
          fsyncSync(fd);
          guard.check();
          const written = fstatSync(fd), named = stat(temp);
          if (!regular(written) || !named || !same(written, named)) throw fail();
          // link is atomic create-if-absent: unlike rename it cannot clobber an
          // existing file or symlink. Crash between link/unlink is recoverable.
          linkSync(temp, target);
          guard.check();
          unlinkSync(temp); temp = undefined;
          fsyncSync(guard.fd);
          return Boolean(load(dir, sha256, guard));
        } catch { return false; }
        finally {
          if (fd !== undefined) closeSync(fd);
          if (temp && guard) {
            try {
              guard.check();
              const s = stat(temp);
              if (owned && s?.isFile() && same(s, owned) && privateMode(s, 0o600)) unlinkSync(temp);
            } catch { /* Exact owned temp only; retry cleanup on a later put. */ }
          }
          guard?.close();
        }
      });
    },
    async read(logicalId, sha256) {
      return serial(() => {
        let guard;
        try {
          if (typeof sha256 !== 'string' || !HASH.test(sha256)) return null;
          const dir = namespace(logicalId);
          guard = tree(dir, false);
          return guard ? load(dir, sha256, guard) : null;
        } catch { return null; } finally { guard?.close(); }
      });
    },
    async status(logicalId) {
      return serial(() => {
        let guard;
        try {
          const dir = namespace(logicalId);
          guard = tree(dir, false);
          return { available: true, ...(guard ? inventory(dir, guard, false) : { bytes: 0, entries: 0, maxBytes, maxEntries }) };
        } catch { throw fail(); } finally { guard?.close(); }
      });
    }
  });
}
