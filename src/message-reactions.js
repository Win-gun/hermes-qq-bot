import { randomUUID } from "node:crypto";
import { validateSocialExperiencePolicy } from "./social-experience-policy.js";

// QQ official system faces (EmojiType=1), checked 2026-10-25. These are
// semantic mappings, NOT evidence that a particular carrier supports them.
// https://bot.q.qq.com/wiki/develop/api-v2/openapi/emoji/model.html#Emoji列表
// Wire schema: https://snowluma.github.io/en/docs/api/extended/set_group_reaction
export const QQ_REACTION_LABELS = Object.freeze({
  "14": "微笑", "49": "拥抱", "66": "爱心", "76": "赞同 / 点赞",
  "78": "握手", "99": "鼓掌", "124": "OK", "179": "doge", "182": "笑哭", "315": "加油"
});
const LABELS = QQ_REACTION_LABELS;
const MAX_AGE = 300000, CAPACITY = 1000;
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const uint = v => Number.isSafeInteger(v) && v >= 0;
const qq = v => typeof v === "string" && /^[1-9]\d{0,19}$/.test(v);
const mid = v => typeof v === "string" && /^-?[1-9]\d{0,19}$/.test(v);
const fail = code => Object.assign(new Error(code), { code });
const dayAt = at => new Date(at + 28800000).toISOString().slice(0, 10);
const statuses = ["claimed", "accepted", "uncertain", "rejected", "unsupported"];

/** Host-only. Never expose ctx, targets or this service as model tools.
 * capture returns an exact host handle; isCurrent authenticates revision/session,
 * selected carrier, participation, quiet and live connection synchronously.
 * transact(syncBuilder({memory})) resolves ONLY after durable publication.
 * request(ctx,action,params,{signal,binding}) MUST enforce binding.isCurrent at
 * the final wire boundary, including after any queue wait. No fallback/replay.
 * send(ctx,id,{signal,onSendStarted}) forwards the host callback unchanged to
 * binding.onSendStarted. ONLY the real wire dispatcher may invoke it, not this
 * service's admission, durable claim, request handoff or ACK settlement.
 * status intentionally needs issuance only, so offline UI inspection is safe.
 */
export function createMessageReactions({ capture, isCurrent, readState, transact, request, clock = Date.now } = {}) {
  if ([capture, isCurrent, readState, transact, request, clock].some(fn => typeof fn !== "function")) throw fail("REACTION_DEPENDENCY");
  const issued = new WeakSet(), contexts = new WeakMap(), offers = new WeakMap();
  const now = () => { const at = clock(); if (!uint(at) || at > 8639999900000000) throw fail("REACTION_CLOCK"); return at; };
  function info(ctx) {
    if (!plain(ctx) || !issued.has(ctx)) throw fail("REACTION_CONTEXT");
    const c = contexts.get(ctx);
    if (["accountId", "logicalId", "conversationId", "revision"].some(k => ctx[k] !== c[k])
      || JSON.stringify(ctx.policy) !== c.policyKey) throw fail("REACTION_CONTEXT");
    return c;
  }
  function guard(ctx, signal) {
    const c = info(ctx);
    if (signal?.aborted) throw fail("REACTION_ABORTED");
    if (isCurrent(ctx) !== true) throw fail("REACTION_STALE");
    if (!c.policy.enabled || c.policy.shadowMode || !c.policy.reactions.enabled) throw fail("REACTION_DISABLED");
    return c;
  }
  function open(accountId, conversationId) {
    if (typeof accountId !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(accountId)
      || typeof conversationId !== "string" || !/^group:[1-9]\d{0,19}$/.test(conversationId)) throw fail("REACTION_SCOPE");
    const ctx = capture(accountId, conversationId);
    if (!plain(ctx) || issued.has(ctx) || ctx.accountId !== accountId || ctx.conversationId !== conversationId
      || typeof ctx.logicalId !== "string" || !/^(account|group):[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(ctx.logicalId)
      || !(typeof ctx.revision === "string" || uint(ctx.revision)) || !plain(ctx.policy)) throw fail("REACTION_CONTEXT");
    const { active, ...raw } = ctx.policy;
    const policy = validateSocialExperiencePolicy(raw);
    if (!policy.conversationIds.includes(conversationId)) throw fail("REACTION_SCOPE");
    issued.add(ctx); contexts.set(ctx, { accountId, conversationId, logicalId: ctx.logicalId, revision: ctx.revision,
      policy, policyKey: JSON.stringify(ctx.policy) });
    return ctx;
  }
  function book(root, c, create = false) {
    if (!plain(root) || !plain(root.memory)) throw fail("REACTION_STATE");
    const saved = root.memory.messageReactions;
    if (saved !== undefined && (!plain(saved) || saved.version !== 1 || !plain(saved.bots))) throw fail("REACTION_STATE");
    const bot = saved?.bots[c.logicalId];
    if (bot !== undefined && (!plain(bot) || !plain(bot.groups) || Object.keys(bot.groups).length > 128)) throw fail("REACTION_STATE");
    let count = 0;
    for (const [scope, b] of Object.entries(bot?.groups || {})) {
      if (!/^group:[1-9]\d{0,19}$/.test(scope) || !plain(b) || !plain(b.claims) || !plain(b.days) || !uint(b.lastAt)
        || !["unknown", "supported", "unsupported"].includes(b.capability) || Object.keys(b.days).length > 8) throw fail("REACTION_STATE");
      for (const [day, n] of Object.entries(b.days)) if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !uint(n)) throw fail("REACTION_STATE");
      for (const [target, entry] of Object.entries(b.claims)) {
        if (++count > CAPACITY || !mid(target) || !plain(entry) || !statuses.includes(entry.status)
          || !uint(entry.at) || !uint(entry.sentAt) || typeof entry.actionId !== "string"
          || !/^reaction_[a-f0-9-]{36}$/.test(entry.actionId)) throw fail("REACTION_STATE");
      }
    }
    if (create) {
      root.memory.messageReactions ??= { version: 1, bots: {} };
      const b = root.memory.messageReactions.bots[c.logicalId] ??= { groups: {} };
      if (!Object.hasOwn(b.groups, c.conversationId)) {
        if (Object.keys(b.groups).length >= 128) throw fail("REACTION_CAPACITY");
        b.groups[c.conversationId] = { claims: {}, days: {}, lastAt: 0, capability: "unknown" };
      }
      return { bot: b, group: b.groups[c.conversationId], count };
    }
    return { bot, group: bot?.groups[c.conversationId], count };
  }
  function dailyTotal(bot, at) {
    const total = Object.values(bot?.groups || {}).reduce((n, g) => n + (g.days[dayAt(at)] || 0), 0);
    if (!uint(total)) throw fail("REACTION_STATE");
    return total;
  }
  function available(bot, b, policy, at) {
    return b?.capability !== "unsupported" && (!b || at >= b.lastAt && (Object.keys(b.days).length === 0 || at - b.lastAt >= policy.cooldownMs))
      && Object.values(bot?.groups || {}).every(group => at >= group.lastAt && Object.keys(group.days).every(day => day <= dayAt(at)))
      && dailyTotal(bot, at) < policy.maxDaily;
  }
  function candidates(ctx, { targets = [], serious = false, direct = false } = {}) {
    try {
      const c = guard(ctx), at = now(), { group, bot } = book(readState(), c);
      const liveClaims = Object.values(bot?.groups || {}).reduce((n, g) => n
        + Object.values(g.claims).filter(row => at < row.sentAt || at - row.sentAt <= MAX_AGE).length, 0);
      offers.delete(ctx);
      if (typeof serious !== "boolean" || typeof direct !== "boolean" || serious || !Array.isArray(targets) || targets.length > 128
        || liveClaims >= CAPACITY || !available(bot, group, c.policy.reactions, at)) return [];
      const entries = new Map();
      for (const target of targets) {
        if (!plain(target) || !mid(target.messageId) || !qq(target.userId) || target.isBot !== false
          || !uint(target.sentAt) || at < target.sentAt || at - target.sentAt > MAX_AGE || group?.claims[target.messageId]) continue;
        for (const emoji of c.policy.reactions.emojiIds) {
          if (!Object.hasOwn(LABELS, emoji) || entries.size >= 3) continue;
          const id = `reaction_${randomUUID()}`;
          entries.set(id, Object.freeze({ messageId: target.messageId, sentAt: target.sentAt, emoji }));
        }
      }
      offers.set(ctx, entries);
      return [...entries].map(([id, target]) => ({ id, label: LABELS[target.emoji] }));
    } catch { if (plain(ctx)) offers.delete(ctx); return []; }
  }
  function status(ctx) {
    try {
      const c = info(ctx), at = now(), { bot, group, count } = book(readState(), c);
      const rows = Object.values(group?.claims || {});
      return { ok: true, enabled: c.policy.enabled && !c.policy.shadowMode && c.policy.reactions.enabled,
        capability: group?.capability || "unknown", daily: dailyTotal(bot, at), dailyScope: "logical-bot",
        maxDaily: c.policy.reactions.maxDaily, cooldownRemainingMs: group && Object.keys(group.days).length
          ? Math.max(0, c.policy.reactions.cooldownMs - (at - group.lastAt)) : 0,
        targetClaims: count, capacity: CAPACITY, accepted: rows.filter(r => r.status === "accepted").length,
        // These three outcome counters are NOT lifetime/daily audit totals:
        // expired target claims can be pruned on later admissions in any group.
        outcomeCounterScope: "group-retained-target-claims", targetRetentionMs: MAX_AGE,
        uncertain: rows.filter(r => ["claimed", "uncertain"].includes(r.status)).length,
        rejected: rows.filter(r => r.status === "rejected").length };
    } catch { return { ok: false, code: "REACTION_STATE" }; }
  }
  async function send(ctx, id, { signal, onSendStarted } = {}) {
    let actionId, target, c;
    try {
      c = guard(ctx, signal); target = offers.get(ctx)?.get(id);
      if (!target || onSendStarted !== undefined && typeof onSendStarted !== "function") throw fail("REACTION_CANDIDATE");
      offers.get(ctx).delete(id); // Consume before any await, including failed persistence.
      actionId = `reaction_${randomUUID()}`;
      await transact(root => {
        guard(ctx, signal);
        const at = now(), data = book(root, c, true), b = data.group;
        if (at < target.sentAt || at - target.sentAt > MAX_AGE || b.claims[target.messageId]
          || !available(data.bot, b, c.policy.reactions, at)) throw fail("REACTION_LIMIT");
        // Expired targets cannot be offered again. Prune only after monotonic gate;
        // daily totals/lastAt survive pruning, including crash-left claims.
        for (const group of Object.values(data.bot.groups)) for (const [key, row] of Object.entries(group.claims)) {
          if (at >= row.sentAt && at - row.sentAt > MAX_AGE) delete group.claims[key];
        }
        const count = Object.values(data.bot.groups).reduce((n, g) => n + Object.keys(g.claims).length, 0);
        if (count >= CAPACITY) throw fail("REACTION_CAPACITY");
        const day = dayAt(at);
        if (Object.keys(b.days).some(d => d > day)) throw fail("REACTION_CLOCK");
        const cutoff = dayAt(Math.max(0, at - 6 * 86400000));
        for (const d of Object.keys(b.days)) if (d < cutoff) delete b.days[d];
        b.days[day] = (b.days[day] || 0) + 1; b.lastAt = at;
        b.claims[target.messageId] = { actionId, at, sentAt: target.sentAt, status: "claimed" };
      });
    } catch { return { status: "rejected" }; }
    let result = "rejected";
    try {
      guard(ctx, signal);
      const at = now();
      if (at < target.sentAt || at - target.sentAt > MAX_AGE) throw fail("REACTION_EXPIRED");
      result = "uncertain"; // From this point the wire outcome may be unknown.
      const ack = await request(ctx, "set_group_reaction", { group_id: c.conversationId.slice(6),
        message_id: target.messageId, code: String(target.emoji), is_set: true }, { signal,
        binding: { ...(onSendStarted ? { onSendStarted } : {}),
          isCurrent: () => { try { guard(ctx, signal); return now() - target.sentAt <= MAX_AGE && now() >= target.sentAt; } catch { return false; } } } });
      if (ack?.retcode === 1404 || ack?.retcode === 404) result = "unsupported";
      else if (ack?.status === "ok" && ack?.retcode === 0) result = "accepted";
      else if (ack?.status === "failed" && Number.isSafeInteger(ack.retcode) && ack.retcode !== 0) result = "rejected";
    } catch { /* No guessed replay, fallback action or message. */ }
    try {
      // Fact-only settlement remains allowed after cancellation/revision changes.
      await transact(root => {
        const b = book(root, c).group, row = b?.claims[target.messageId];
        if (!row || row.actionId !== actionId || row.status !== "claimed") throw fail("REACTION_STATE");
        row.status = result;
        if (result === "accepted") b.capability = "supported";
        if (result === "unsupported") b.capability = "unsupported";
      });
    } catch { return { status: "uncertain", actionId }; }
    return { status: result, actionId, ...(result === "accepted" ? { targetMessageId: target.messageId } : {}) };
  }
  return Object.freeze({ open, candidates, send, status });
}
