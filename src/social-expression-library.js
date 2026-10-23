import { createHash } from "node:crypto";
import { createStickerService } from "./sticker-service.js";
import { validateSocialExperiencePolicy } from "./social-experience-policy.js";
import { listGroupLanguage, reviewGroupSlang } from "./group-language-learning.js";

const plain = x => x !== null && typeof x === "object" && !Array.isArray(x);
const own = (x, k) => plain(x) && Object.hasOwn(x, k);
const uint = x => Number.isSafeInteger(x) && x >= 0;
const fail = code => Object.assign(new Error(code), { code });
const error = code => ({ ok: false, code });
const ACK = /^-?[1-9]\d{0,19}$/;
const SCOPE = /^(group|private):[1-9]\d{0,19}$/;
const LOGICAL = /^(account|group):[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const codes = new Set(["EXPRESSION_CONTEXT", "EXPRESSION_SCOPE", "EXPRESSION_POLICY", "EXPRESSION_STALE",
  "EXPRESSION_ABORTED", "EXPRESSION_STATE", "EXPRESSION_CONFLICT", "EXPRESSION_DISABLED", "EXPRESSION_BUSY",
  "EXPRESSION_BUDGET", "EXPRESSION_ARGUMENT", "EXPRESSION_UNAVAILABLE", "EXPRESSION_ACK", "EXPRESSION_STORAGE", "EXPRESSION_CAPACITY"]);
const serviceCodes = { STICKER_ABORTED: "EXPRESSION_ABORTED", STICKER_STALE: "EXPRESSION_STALE",
  STICKER_CONFLICT: "EXPRESSION_CONFLICT", STICKER_SCHEMA: "EXPRESSION_STATE", STICKER_CAPACITY: "EXPRESSION_CAPACITY" };
const safeCode = e => codes.has(e?.code) ? e.code : own(serviceCodes, e?.code) ? serviceCodes[e.code] : "EXPRESSION_OPERATION_FAILED";
const clone = x => structuredClone(x);
const strict = (x, names) => plain(x) && Object.keys(x).every(k => names.includes(k));
function stable(value, depth = 0, budget = { n: 0 }) {
  if (depth > 32 || ++budget.n > 50000) throw fail("EXPRESSION_STATE");
  if (value === null || ["string", "boolean"].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(x => stable(x, depth + 1, budget)).join(",")}]`;
  if (!plain(value)) throw fail("EXPRESSION_STATE");
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k], depth + 1, budget)}`).join(",")}}`;
}
const publicAnnotation = a => a ? { ...Object.fromEntries(["conversationId", "revision", "status", "note", "tags",
  "sha256", "sentCount", "updatedAt", "actor"].filter(k => a[k] !== undefined).map(k => [k, clone(a[k])])),
  lastSentAt: Object.values(a.receipts || {}).reduce((latest, receipt) => Math.max(latest, receipt.at), 0) } : null;
const publicSticker = a => ({ id: a.id, official: { desc: a.official.desc, trust: "untrusted" }, annotation: publicAnnotation(a.annotation) });

/** Host-only adapter; NEVER expose this object or ctx handles as model tools.
 * readState() -> {memory:<published memory root>}; transact(syncBuilder) receives
 * that same envelope's latest private draft and resolves after durable publish.
 * capture(accountId,conversationId) is synchronous and returns the exact host ctx:
 * {accountId,logicalId,conversationId,revision,policy,...opaqueHostData}.
 * isCurrent(ctx) authenticates route/revision/session, not selected/online/quiet.
 * Host request separately enforces connection, selected identity and scope; real
 * wire sends separately use the existing quiet/delivery guard. No wire send here.
 * UI ops: sync / annotate / review-sticker / review-language. All require the exact
 * SHA256 expectedStateRevision. Local-admin authority belongs to the authenticated
 * HTTP caller; body cannot supply actors, policy, identity, URL, paths or tools.
 * markSent is ONLY a trusted ACK callback, never an HTTP/model operation. An issued
 * old ctx may record a previously prepared attempt's real ACK without authority
 * to prepare/send again. Once attempted, receipt writes are never auto-retried.
 */
export function createExpressionLibrary({ readState, transact, capture, isCurrent, request, describeImage,
  downloadImage, clock = Date.now } = {}) {
  if ([readState, transact, capture, isCurrent, request, describeImage, clock].some(x => typeof x !== "function")
    || (downloadImage !== undefined && typeof downloadImage !== "function")) throw fail("EXPRESSION_DEPENDENCY");
  const issued = new WeakSet(), contexts = new WeakMap(), offered = new WeakMap(), prepared = new WeakMap(), receipts = new WeakMap();
  const annotating = new Set();
  function now() { const n = clock(); if (!Number.isSafeInteger(n) || n < 1 || n > 8640000000000000) throw fail("EXPRESSION_STATE"); return n; }
  function info(ctx) {
    if (!plain(ctx) || !issued.has(ctx)) throw fail("EXPRESSION_CONTEXT");
    const c = contexts.get(ctx);
    if (ctx.logicalId !== c.logicalId || ctx.conversationId !== c.conversationId || ctx.accountId !== c.accountId
      || ctx.revision !== c.revision) throw fail("EXPRESSION_CONTEXT");
    return c;
  }
  function guard(ctx, signal, send = false) {
    const c = info(ctx);
    if (signal?.aborted) throw fail("EXPRESSION_ABORTED");
    if (isCurrent(ctx) !== true) throw fail("EXPRESSION_STALE");
    if (send && !(c.policy.enabled && !c.policy.shadowMode && c.policy.stickers.enabled && c.policy.stickers.autoSend)) throw fail("EXPRESSION_DISABLED");
    return c;
  }
  function rootAt(root) { if (!plain(root) || !plain(root.memory)) throw fail("EXPRESSION_STATE"); return root; }
  function service(ctx, { expected, signal, fact = false, description } = {}) {
    return createStickerService({ readState, clock: now,
      isCurrent: value => { if (value !== ctx) return false; try { fact ? info(ctx) : guard(ctx, signal); return true; } catch { return false; } },
      request: async (...args) => { guard(ctx, signal); return request(...args); },
      describeImage: description || describeImage,
      ...(downloadImage ? { downloadImage } : {}),
      transact: builder => transact(root => {
        fact ? info(ctx) : guard(ctx, signal);
        if (expected !== undefined) check(root, ctx, expected);
        return builder(root);
      }) });
  }
  function parts(root, ctx) {
    rootAt(root); const c = info(ctx);
    // Service validates ONLY this logical library. Read on the passed draft,
    // not the separately published root, so every builder's CAS is latest-root.
    const s = createStickerService({ readState: () => root, transact: () => { throw fail("EXPRESSION_STATE"); },
      request, describeImage, ...(downloadImage ? { downloadImage } : {}), clock: now,
      isCurrent: value => value === ctx && issued.has(value) });
    const stickers = s.list(ctx);
    const bot = root.memory.socialExpressionAssets?.bots?.[c.logicalId];
    const language = listGroupLanguage(root.memory, c);
    if (!language.ok && c.conversationId.startsWith("group:")) throw fail("EXPRESSION_STATE");
    const assets = Object.values(bot?.stickers || {}).sort((a, b) => a.id.localeCompare(b.id))
      .map(({ annotations, ...a }) => ({ ...a, annotation: annotations[c.conversationId] || null }));
    const revision = createHash("sha256").update(stable({ hostRevision: c.revision, assets,
      collectionRevision: bot?.collectionRevision || 0, capabilities: bot?.capabilities || {}, language })).digest("hex");
    return { revision, stickers: stickers.map(publicSticker), language,
      capabilities: { collection: bot?.capabilities.collection || "unknown" } };
  }
  function check(root, ctx, expected) {
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw fail("EXPRESSION_ARGUMENT");
    if (parts(root, ctx).revision !== expected) throw fail("EXPRESSION_CONFLICT");
  }
  function write(ctx, expected, builder, { signal, fact = false } = {}) {
    return transact(root => { fact ? info(ctx) : guard(ctx, signal); check(root, ctx, expected); return builder(root); });
  }
  // Budget reservations consume admission, but are not reported as model attempts.
  // Only actual describeImage dispatch settles as attempted (failures included).
  // Crash/uncertain publication leaves a reserved slot: no refund/replay guesses.
  function budget(root, ctx, create = false) {
    rootAt(root); const c = info(ctx), saved = root.memory.socialExpressionLibrary;
    if (saved !== undefined && (!strict(saved, ["version", "bots"]) || saved.version !== 1 || !plain(saved.bots))) throw fail("EXPRESSION_STATE");
    const book = saved?.bots[c.logicalId];
    if (book !== undefined && (!strict(book, ["nextClaim", "lastAt", "days"]) || !uint(book.nextClaim) || book.nextClaim < 1
      || !uint(book.lastAt) || !plain(book.days))) throw fail("EXPRESSION_STATE");
    if (!create) return book;
    root.memory.socialExpressionLibrary ??= { version: 1, bots: {} };
    return root.memory.socialExpressionLibrary.bots[c.logicalId] ??= { nextClaim: 1, lastAt: 0, days: {} };
  }
  async function describe(ctx, media, options, expected) {
    const c = guard(ctx, options.signal), at = now(), day = new Date(at + 8 * 3600000).toISOString().slice(0, 10);
    const claim = await write(ctx, expected, root => {
      const b = budget(root, ctx, true);
      if (at < b.lastAt || b.nextClaim >= Number.MAX_SAFE_INTEGER) throw fail("EXPRESSION_BUDGET");
      // Bookkeeping only: keep current + preceding six Shanghai calendar days.
      // Never prune before the monotonic-time gate, nor touch another bot's book.
      const cutoff = new Date(at - 6 * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
      const days = Object.keys(b.days);
      if (days.some(key => !/^\d{4}-\d{2}-\d{2}$/.test(key) || key > day)) throw fail("EXPRESSION_STATE");
      for (const key of days) if (key !== day && key < cutoff) delete b.days[key];
      const daily = b.days[day] ??= { claims: {} };
      if (!strict(daily, ["claims"]) || !plain(daily.claims)) throw fail("EXPRESSION_STATE");
      const entries = Object.values(daily.claims);
      if (entries.some(x => !strict(x, ["status", "at"]) || !["reserved", "attempted", "cancelled"].includes(x.status) || !uint(x.at))) throw fail("EXPRESSION_STATE");
      if (entries.filter(x => x.status !== "cancelled").length >= c.policy.stickers.maxDailyVisionCalls || entries.length >= 128) throw fail("EXPRESSION_BUDGET");
      const id = String(b.nextClaim++); daily.claims[id] = { status: "reserved", at }; b.lastAt = at;
      return { day, id };
    }, options);
    let invoked = false;
    try { guard(ctx, options.signal); check(readState(), ctx, expected); invoked = true; return await describeImage(ctx, media, options); }
    finally {
      // Accounting is an exact host claim, not a stale-content commit. Capture a
      // fresh CAS for this independent fact write even after policy/route abort.
      const freshRevision = parts(readState(), ctx).revision;
      await write(ctx, freshRevision, root => {
        const entry = budget(root, ctx)?.days[claim.day]?.claims[claim.id];
        if (entry?.status !== "reserved") throw fail("EXPRESSION_STATE");
        entry.status = invoked ? "attempted" : "cancelled";
      }, { fact: true });
    }
  }
  function open(accountId, conversationId) {
    if (typeof accountId !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(accountId) || !SCOPE.test(conversationId)) throw fail("EXPRESSION_SCOPE");
    const ctx = capture(accountId, conversationId);
    if (!plain(ctx) || issued.has(ctx) || ctx.accountId !== accountId || !LOGICAL.test(ctx.logicalId) || ctx.conversationId !== conversationId
      || !(typeof ctx.revision === "string" || uint(ctx.revision))) throw fail("EXPRESSION_CONTEXT");
    let policy; try {
      const { active, ...raw } = ctx.policy;
      policy = validateSocialExperiencePolicy(raw);
    } catch { throw fail("EXPRESSION_POLICY"); }
    if (!policy.conversationIds.includes(conversationId)) throw fail("EXPRESSION_SCOPE");
    // Do not clone/freeze private ws/identity objects. Retain the exact host ctx.
    issued.add(ctx); contexts.set(ctx, { accountId, logicalId: ctx.logicalId, conversationId, revision: ctx.revision, policy });
    return ctx;
  }
  function snapshot(ctx) {
    try {
      const c = guard(ctx), root = readState(), data = parts(root, ctx);
      const day = new Date(now() + 8 * 3600000).toISOString().slice(0, 10);
      const daily = budget(root, ctx)?.days[day];
      if (daily !== undefined && (!strict(daily, ["claims"]) || !plain(daily.claims))) throw fail("EXPRESSION_STATE");
      const claims = Object.values(daily?.claims || {});
      if (claims.some(x => !strict(x, ["status", "at"]) || !["reserved", "attempted", "cancelled"].includes(x.status) || !uint(x.at))) throw fail("EXPRESSION_STATE");
      const dailyVisionCalls = { reserved: claims.filter(x => x.status === "reserved").length,
        attempted: claims.filter(x => x.status === "attempted").length, limit: c.policy.stickers.maxDailyVisionCalls };
      guard(ctx);
      return { ok: true, ...data, dailyVisionCalls }; // Budget is NOT hashed by parts.
    }
    catch (e) { return error(safeCode(e)); }
  }
  async function operate(ctx, op, body = {}, { signal } = {}) {
    let flight = false, c;
    try {
      c = guard(ctx, signal);
      const allowed = { sync: ["expectedStateRevision", "conversationId"], annotate: ["expectedStateRevision", "conversationId", "id"],
        "review-sticker": ["expectedStateRevision", "conversationId", "id", "expectedRevision", "status"],
        "review-language": ["expectedStateRevision", "conversationId", "id", "expectedRevision", "status", "meaning"] }[op];
      if (!allowed || !strict(body, allowed)) throw fail("EXPRESSION_ARGUMENT");
      if (body.conversationId !== undefined && body.conversationId !== c.conversationId) throw fail("EXPRESSION_SCOPE");
      body = clone(body);
      check(readState(), ctx, body.expectedStateRevision);
      if (["sync", "annotate"].includes(op) && !c.policy.stickers.enabled) throw fail("EXPRESSION_DISABLED");
      if (op === "annotate") {
        if (!c.policy.stickers.visionLearning) throw fail("EXPRESSION_DISABLED");
        if (annotating.has(c.logicalId)) throw fail("EXPRESSION_BUSY");
        annotating.add(c.logicalId); flight = true;
      }
      const s = service(ctx, { expected: body.expectedStateRevision, signal,
        description: (host, media, opts) => describe(host, media, opts, body.expectedStateRevision) });
      let result;
      if (op === "sync") result = await s.sync(ctx, { signal });
      if (op === "annotate") result = publicAnnotation(await s.annotate(ctx, { id: body.id, signal }));
      if (op === "review-sticker") result = publicAnnotation(await s.review(ctx, {
        id: body.id, expectedRevision: body.expectedRevision, status: body.status, actor: "local-admin" }));
      if (op === "review-language") {
        if (!c.conversationId.startsWith("group:")) throw fail("EXPRESSION_SCOPE");
        result = await write(ctx, body.expectedStateRevision, root => {
          const r = reviewGroupSlang(root.memory, { logicalId: c.logicalId, conversationId: c.conversationId,
            id: body.id, expectedRevision: body.expectedRevision, status: body.status, meaning: body.meaning, now: now(),
            actor: { id: "local-admin", authorized: true, logicalId: c.logicalId, conversationId: c.conversationId } });
          if (!r.ok) throw fail(r.reason === "stale_revision" ? "EXPRESSION_CONFLICT" : "EXPRESSION_ARGUMENT");
          return r;
        }, { signal });
      }
      guard(ctx, signal);
      return { ok: true, result, revision: parts(readState(), ctx).revision };
    } catch (e) { return error(safeCode(e)); }
    finally { if (flight) annotating.delete(c.logicalId); }
  }
  function eligible(ctx, query, serious, limit) {
    const c = guard(ctx, undefined, true);
    if (typeof query !== "string" || query.length > 1000 || typeof serious !== "boolean" || !Number.isSafeInteger(limit) || limit < 1 || limit > 3) throw fail("EXPRESSION_ARGUMENT");
    if (serious || query.trim().length < 2) return [];
    const q = query.normalize("NFKC").toLowerCase().trim(), root = rootAt(readState()), at = now();
    const list = service(ctx).list(ctx), raw = root.memory.socialExpressionAssets?.bots?.[c.logicalId]?.stickers || {};
    return list.filter(a => {
      const v = a.annotation;
      if (!v || v.status !== "confirmed") return false;
      const times = Object.values(raw[a.id].annotations[c.conversationId].receipts).map(r => r.at);
      if (times.some(time => time > at || at - time < c.policy.stickers.cooldownMs)) return false;
      const note = v.note.normalize("NFKC").toLowerCase();
      return note.length >= 2 && (note.includes(q) || q.includes(note))
        || v.tags.some(t => t.trim().length >= 2 && q.includes(t.normalize("NFKC").toLowerCase()));
    }).slice(0, limit).map(a => ({ id: a.id, note: a.annotation.note, tags: clone(a.annotation.tags) }));
  }
  function candidates(ctx, { query = "", serious = false, limit = 3 } = {}) {
    try {
      const rows = eligible(ctx, query, serious, limit);
      offered.set(ctx, { query, serious, ids: new Set(rows.map(x => x.id)) }); return rows;
    } catch { if (issued.has(ctx)) offered.delete(ctx); return []; }
  }
  async function prepare(ctx, { id, signal } = {}) {
    try {
      guard(ctx, signal, true); const offer = offered.get(ctx);
      if (!ID.test(id) || !offer?.ids.has(id) || !eligible(ctx, offer.query, offer.serious, 3).some(x => x.id === id)) throw fail("EXPRESSION_UNAVAILABLE");
      const result = await service(ctx, { signal }).prepare(ctx, { id, signal });
      guard(ctx, signal, true);
      if (!result.segment) throw fail("EXPRESSION_UNAVAILABLE");
      if (offered.get(ctx) !== offer || !eligible(ctx, offer.query, offer.serious, 3).some(x => x.id === id)) throw fail("EXPRESSION_UNAVAILABLE");
      if (!prepared.has(ctx)) prepared.set(ctx, new Set()); prepared.get(ctx).add(id);
      return { segment: result.segment };
    } catch (e) { return { segment: null, errorCode: safeCode(e) }; }
  }
  async function markSent(ctx, { id, messageId } = {}) {
    try {
      info(ctx);
      if (!prepared.get(ctx)?.has(id) || typeof messageId !== "string" || !ACK.test(messageId)) throw fail("EXPRESSION_ACK");
      if (!receipts.has(ctx)) receipts.set(ctx, new Map());
      const ledger = receipts.get(ctx), key = `${id}:${messageId}`;
      if (ledger.has(key)) {
        const previous = await ledger.get(key);
        return previous.ok ? { ok: true, counted: false } : previous;
      }
      const operation = (async () => {
        try {
          // Current send policy is intentionally NOT re-authorized for facts.
          const expected = parts(readState(), ctx).revision;
          const result = await service(ctx, { fact: true, expected }).markSent(ctx, { id, messageId });
          return { ok: true, ...result };
        } catch (e) { return error(safeCode(e)); }
      })();
      ledger.set(key, operation); return await operation;
    } catch (e) { return error(safeCode(e)); }
  }
  return Object.freeze({ open, snapshot, operate, candidates, prepare, markSent });
}
