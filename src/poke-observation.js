import { createHash } from "node:crypto";

const plain = v => v !== null && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const uint = v => Number.isSafeInteger(v) && v >= 0;
const qq = v => typeof v === "string" && /^[1-9]\d{0,19}$/.test(v);
const id = v => typeof v === "string" && /^poke_notice:[a-f0-9]{64}$/.test(v);
const AGE = 300000, CAPACITY = 1000;
const fail = () => { throw new Error("POKE_OBSERVATION_UNAVAILABLE"); };
const wireQQ = v => qq(v) ? v : Number.isSafeInteger(v) && v > 0 ? String(v) : null;
const keys = (v, names) => plain(v) && Object.keys(v).every(k => names.includes(k));

/** HOST ONLY. No policy grant, message ID, model call, timer or send adapter.
 * capture(accountId,groupConversation) returns a fresh exact host context with
 * {accountId,logicalId,conversationId,revision,selfId:string,peerIds:string[],...}.
 * isCurrent authenticates current recipient/route/session/revision (observation
 * may continue in quiet); isHostEvent(ctx,raw) authenticates real wire provenance.
 * A model/deserialized historical object is NEVER valid just because it has the
 * right OneBot shape. transact(syncBuilder({memory})) is the SOLE repository writer
 * and resolves only after durable publication. No uncertain write is retried.
 *
 * open(accountId,'group:QQ') -> ctx; observe(ctx,raw,{signal}) ->
 * {ok:true,observation:{sourceId:'poke_notice:<sha256>',userId,groupId,sentAt,kind:'poke'}}
 * or {ok:false,reason}. NO synthetic QQ message/message_id is created. Hash uses
 * recipient + logical identity + group + user + ORIGINAL time, not receive time,
 * random data or raw payload. Identical notices within the same protocol second
 * cannot be distinguished and conservatively deduplicate. No text is retained.
 * isObservationCurrent(ctx,observation) authenticates the exact issued projection
 * for a subsequent native evidence adapter; it grants no permission to poke back.
 * Keep observation in an event-owned native getTargets handle, not chat history.
 * Persisted dedup survives restart; canonical observations are never rehydrated.
 * Capacity is bounded and expiry pruning is transaction-only; read paths do not
 * create defaults/acquire a lock. Private friend_poke is deliberately absent.
 */
export function createPokeObservation({ capture, isCurrent, isHostEvent, readState, transact, clock = Date.now } = {}) {
  if (![capture, isCurrent, isHostEvent, readState, transact, clock].every(fn => typeof fn === "function"))
    throw new TypeError("POKE_OBSERVATION_DEPENDENCY");
  const contexts = new WeakMap(), issued = new WeakMap(), attempted = new Map();
  let watermark = 0;
  function now() { const at = clock(); if (!uint(at) || at < watermark || at > 8639999900000000) fail(); watermark = at; return at; }
  function info(ctx) {
    const c = plain(ctx) && contexts.get(ctx);
    if (!c || ["accountId", "logicalId", "conversationId", "revision", "selfId"].some(k => c[k] !== ctx[k])
      || JSON.stringify(ctx.peerIds) !== c.peerKey) fail();
    return c;
  }
  function guard(ctx, signal) { const c = info(ctx); if (signal?.aborted || isCurrent(ctx) !== true) fail(); return c; }
  function open(accountId, conversationId) {
    if (typeof accountId !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(accountId)
      || typeof conversationId !== "string" || !/^group:[1-9]\d{0,19}$/.test(conversationId)) fail();
    const ctx = capture(accountId, conversationId);
    if (!plain(ctx) || contexts.has(ctx) || ctx.accountId !== accountId || ctx.conversationId !== conversationId
      || typeof ctx.logicalId !== "string" || !/^(account|group):[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(ctx.logicalId)
      || !(uint(ctx.revision) || typeof ctx.revision === "string" && ctx.revision.length > 0 && ctx.revision.length <= 128)
      || !qq(ctx.selfId) || !Array.isArray(ctx.peerIds) || ctx.peerIds.length > 1024 || !Array.from(ctx.peerIds).every(qq)) fail();
    contexts.set(ctx, { accountId, conversationId, logicalId: ctx.logicalId, revision: ctx.revision,
      selfId: ctx.selfId, peerIds: [...ctx.peerIds], peerKey: JSON.stringify(ctx.peerIds) });
    return ctx;
  }
  function book(root, c, create = false) {
    if (!plain(root?.memory)) fail();
    const envelope = root.memory.pokeObservations;
    if (envelope !== undefined && (!keys(envelope, ["version", "bots"]) || envelope.version !== 1 || !plain(envelope.bots))) fail();
    const bot = envelope?.bots[c.logicalId];
    if (bot !== undefined && (!keys(bot, ["groups", "lastAt"]) || !plain(bot.groups) || !uint(bot.lastAt)
      || Object.keys(bot.groups).length > 128)) fail();
    let count = 0;
    for (const [scope, group] of Object.entries(bot?.groups || {})) {
      if (!/^group:[1-9]\d{0,19}$/.test(scope) || !keys(group, ["sources"]) || !plain(group.sources)) fail();
      for (const [source, row] of Object.entries(group.sources)) {
        if (++count > CAPACITY || !id(source) || !keys(row, ["userId", "sentAt", "receivedAt"])
          || !qq(row.userId) || !uint(row.sentAt) || !uint(row.receivedAt) || row.sentAt > row.receivedAt) fail();
      }
    }
    if (!create) return bot;
    root.memory.pokeObservations ??= { version: 1, bots: {} };
    return root.memory.pokeObservations.bots[c.logicalId] ??= { groups: {}, lastAt: 0 };
  }
  async function observe(ctx, raw, { signal } = {}) {
    let c, at, observation, fingerprint;
    try {
      c = guard(ctx, signal); at = now();
      if (!plain(raw) || isHostEvent(ctx, raw) !== true || raw.post_type !== "notice"
        || raw.notice_type !== "notify" || raw.sub_type !== "poke"
        || wireQQ(raw.self_id) !== c.selfId || wireQQ(raw.target_id) !== c.selfId
        || wireQQ(raw.group_id) !== c.conversationId.slice(6)
        || !wireQQ(raw.user_id) || wireQQ(raw.user_id) === c.selfId || c.peerIds.includes(wireQQ(raw.user_id))
        || !uint(raw.time) || !Number.isSafeInteger(raw.time * 1000) || raw.time * 1000 > at || at - raw.time * 1000 >= AGE) fail();
      const userId = wireQQ(raw.user_id), sentAt = raw.time * 1000, groupId = c.conversationId.slice(6);
      const snapshot = [raw.post_type, raw.notice_type, raw.sub_type, raw.self_id, raw.target_id, raw.group_id, raw.user_id, raw.time];
      const sourceId = `poke_notice:${createHash("sha256").update(JSON.stringify([c.logicalId, c.selfId, groupId, userId, sentAt])).digest("hex")}`;
      observation = Object.freeze({ sourceId, userId, groupId, sentAt, kind: "poke" });
      fingerprint = JSON.stringify([c.logicalId, sourceId]);
      for (const [key, until] of attempted) if (until <= at) attempted.delete(key);
      if (attempted.has(fingerprint)) return Object.freeze({ ok: false, reason: "duplicate" });
      if (attempted.size >= CAPACITY) return Object.freeze({ ok: false, reason: "capacity" });
      const before = book(readState(), c);
      if (before?.groups[c.conversationId]?.sources[sourceId]) return Object.freeze({ ok: false, reason: "duplicate" });
      attempted.set(fingerprint, sentAt + AGE);
      const admitted = await transact(root => {
        guard(ctx, signal);
        const latest = now();
        if (latest < sentAt || latest - sentAt >= AGE || isHostEvent(ctx, raw) !== true
          || [raw.post_type, raw.notice_type, raw.sub_type, raw.self_id, raw.target_id, raw.group_id, raw.user_id, raw.time]
            .some((value, index) => value !== snapshot[index])) fail();
        const bot = book(root, c, true);
        if (bot.lastAt > latest) fail();
        if (bot.groups[c.conversationId]?.sources[sourceId]) return false;
        for (const [key, group] of Object.entries(bot.groups)) {
          for (const [source, row] of Object.entries(group.sources)) {
            if (row.sentAt > latest || row.receivedAt > latest) fail();
            if (latest - row.sentAt >= AGE) delete group.sources[source];
          }
          if (!Object.keys(group.sources).length) delete bot.groups[key];
        }
        if (Object.values(bot.groups).reduce((n, g) => n + Object.keys(g.sources).length, 0) >= CAPACITY
          || !bot.groups[c.conversationId] && Object.keys(bot.groups).length >= 128) fail();
        const group = bot.groups[c.conversationId] ??= { sources: {} };
        group.sources[sourceId] = { userId, sentAt, receivedAt: at }; bot.lastAt = latest;
        book(root, c);
        return true;
      });
      guard(ctx, signal);
      if (!admitted) return Object.freeze({ ok: false, reason: "duplicate" });
      if (now() - sentAt >= AGE || isHostEvent(ctx, raw) !== true
        || [raw.post_type, raw.notice_type, raw.sub_type, raw.self_id, raw.target_id, raw.group_id, raw.user_id, raw.time]
          .some((value, index) => value !== snapshot[index])) fail();
      issued.set(observation, c);
      return Object.freeze({ ok: true, observation });
    } catch { return Object.freeze({ ok: false, reason: fingerprint ? "storage-or-stale" : "invalid-source" }); }
  }
  function isObservationCurrent(ctx, observation) {
    try {
      const c = guard(ctx), original = issued.get(observation), at = now();
      return original === c && observation.kind === "poke" && observation.groupId === c.conversationId.slice(6)
        && at >= observation.sentAt && at - observation.sentAt < AGE;
    } catch { return false; }
  }
  return Object.freeze({ open, observe, isObservationCurrent });
}
