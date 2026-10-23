import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });

// Fail closed: only ordinary public IPv4 and global-unicast IPv6 are accepted.
export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes('%') || address.includes('.')) return false;
  const parts = address.toLowerCase().split('::');
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  const words = [...left, ...Array(parts.length === 2 ? 8 - left.length - right.length : 0).fill('0'), ...right].map(x => parseInt(x, 16));
  // Excludes mapped IPv4, ULA, link-local, multicast, NAT64, 6to4, Teredo,
  // documentation, benchmarking and special-purpose 2001::/23 allocations.
  return words.length === 8 && words[0] >= 0x2000 && words[0] <= 0x3fff
    && words[0] !== 0x2002 && !(words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8))
    && !(words[0] === 0x3fff && words[1] <= 0xfff);
}

export function publicMediaUrl(input) {
  if (typeof input !== 'string' || input.length > 4096 || /[\s\\\x00-\x1f\x7f]/.test(input)) throw fail('MEDIA_URL');
  let url;
  try { url = new URL(input); } catch { throw fail('MEDIA_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.hash) throw fail('MEDIA_URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host.includes('%') || /(^|\.)(localhost|local|internal|home|lan|test|invalid|example)\.?$/i.test(host)
    || (isIP(host) && !isPublicAddress(host))) throw fail('MEDIA_ADDRESS');
  return url;
}

/** Byte validation is repeated by the sticker service even for injected readers.
 * This validates container signatures, not image decoding or semantic safety.
 */
export function validateImage(buffer, declaredType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_IMAGE_BYTES) throw fail('MEDIA_SIZE');
  let mimeType;
  if (buffer.length >= 33 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && buffer.toString('ascii', 12, 16) === 'IHDR' && buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(20) > 0) mimeType = 'image/png';
  else if (buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
    && buffer.at(-2) === 255 && buffer.at(-1) === 217) mimeType = 'image/jpeg';
  else if (buffer.length >= 14 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))
    && buffer.readUInt16LE(6) > 0 && buffer.readUInt16LE(8) > 0 && buffer.at(-1) === 0x3b) mimeType = 'image/gif';
  else if (buffer.length >= 20 && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(buffer.toString('ascii', 12, 16))
    && buffer.readUInt32LE(4) + 8 === buffer.length) mimeType = 'image/webp';
  if (!mimeType || (declaredType && String(declaredType).split(';')[0].trim().toLowerCase() !== mimeType)) throw fail('MEDIA_TYPE');
  return { buffer, mimeType };
}

/** Trusted test/host seams: lookup(host,{all:true}), request(url,options,cb).
 * No filesystem APIs; a whole-operation deadline covers DNS, redirects and body.
 * Each hop checks ALL DNS answers, then pins exactly one through lookup.
 */
export function createPublicMediaReader({ lookup = dnsLookup, request, timeoutMs = 15000, maxRedirects = 3 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5) throw fail('MEDIA_OPTIONS');
  return async function downloadImage(input, { signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(fail('MEDIA_TIMEOUT')), timeoutMs);
    const onAbort = () => controller.abort(fail('MEDIA_ABORTED'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const active = controller.signal;
    const check = () => { if (active.aborted) throw active.reason; };
    // Race DNS promises too: abort must not wait for an unresponsive resolver.
    const cancellable = promise => new Promise((resolve, reject) => {
      const abort = () => reject(active.reason);
      active.addEventListener('abort', abort, { once: true });
      if (active.aborted) abort();
      Promise.resolve(promise).then(resolve, reject).finally(() => active.removeEventListener('abort', abort));
    });
    try {
      let url = publicMediaUrl(input);
      for (let hop = 0; ; hop++) {
        check();
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const answers = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
          : await cancellable(lookup(hostname, { all: true, verbatim: true }));
        check();
        if (!Array.isArray(answers) || !answers.length || answers.some(a => !a || !isPublicAddress(a.address)
          || a.family !== isIP(a.address))) throw fail('MEDIA_DNS');
        const pinned = answers[0];
        const result = await new Promise((resolve, reject) => {
          let response;
          const transport = request || (url.protocol === 'https:' ? https.request : http.request);
          const req = transport(url, {
            method: 'GET', agent: false, signal: active, rejectUnauthorized: true, maxHeaderSize: 16384,
            headers: { accept: 'image/png,image/jpeg,image/gif,image/webp', 'accept-encoding': 'identity' },
            lookup: (_host, options, cb) => {
              if (typeof options === 'function') { cb = options; options = {}; }
              cb(null, options?.all ? [pinned] : pinned.address, pinned.family);
            }
          }, res => {
            response = res;
            res.on('error', reject);
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
              resolve({ redirect: res.headers.location });
              res.destroy();
              return;
            }
            if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
              reject(fail('MEDIA_HTTP')); res.destroy(); return;
            }
            const length = res.headers['content-length'];
            if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > MAX_IMAGE_BYTES)) {
              reject(fail('MEDIA_SIZE')); res.destroy(); return;
            }
            let bytes = 0;
            const chunks = [];
            res.on('data', chunk => {
              bytes += chunk.length;
              if (bytes > MAX_IMAGE_BYTES) { reject(fail('MEDIA_SIZE')); res.destroy(); req.destroy(); }
              else chunks.push(Buffer.from(chunk));
            });
            res.on('aborted', () => reject(fail('MEDIA_TRUNCATED')));
            res.on('end', () => {
              try {
                if (length !== undefined && bytes !== Number(length)) throw fail('MEDIA_TRUNCATED');
                resolve(validateImage(Buffer.concat(chunks), res.headers['content-type']));
              } catch (error) { reject(error); }
            });
          });
          req.on('error', reject);
          const abort = () => { reject(active.reason); response?.destroy(); req.destroy(); };
          active.addEventListener('abort', abort, { once: true });
          req.on('close', () => active.removeEventListener('abort', abort));
          if (active.aborted) abort();
          else req.end();
        });
        check();
        if (!Object.hasOwn(result, 'redirect')) return result;
        if (hop >= maxRedirects || typeof result.redirect !== 'string' || !result.redirect) throw fail('MEDIA_REDIRECT');
        const next = publicMediaUrl(new URL(result.redirect, url).href);
        if (url.protocol === 'https:' && next.protocol !== 'https:') throw fail('MEDIA_REDIRECT');
        url = next;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}
