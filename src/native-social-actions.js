import { randomUUID } from "node:crypto";
import { validateSocialExperiencePolicy } from "./social-experience-policy.js";
import { validateReplyPlan } from "./reply-plan.js";

const plain = v => v !== null && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const keys = (v, names) => plain(v) && Object.keys(v).every(k => names.includes(k));
const uint = v => Number.isSafeInteger(v) && v >= 0;
const qq = v => typeof v === "string" && /^[1-9]\d{0,19}$/.test(v);
const mid = v => typeof v === "string" && /^-?[1-9]\d{0,19}$/.test(v);
const ref = v => v !== null && typeof v === "object";
const error = code => { throw new Error(code); };
const DAY = 86400000, AGE = 300000, MEMBER_AGE = 60000, CAPACITY = 1000;
const dayAt = at => new Date(at + 28800000).toISOString().slice(0, 10);
const outcomes = ["claimed", "accepted", "rejected", "uncertain", "unsupported"];
const supported = value => ["unknown", "supported", "unsupported"].includes(value);
// SnowLuma's documented group_poke schema requires integers. Do not coerce
// identifiers that cannot be represented exactly, or guess an alternate API.
// https://snowluma.github.io/en/docs/api/extended/group_poke
const wireId = value => qq(value) && Number.isSafeInteger(Number(value)) && String(Number(value)) === value;

/** Validates the native extension subset without writing read-time defaults.
 * forwardRead stays config-compatible for the separate parent-owned reader;
 * this service grants no forward capability and performs no forward reads. */
export function validateNativeSocialPolicy(value = {}) {
  if (!keys(value, ["pokes", "mentions", "forwardRead"])) error("NATIVE_POLICY");
  const result = { pokes: { enabled: false, cooldownMs: 300000, maxDaily: 5 },
    mentions: { enabled: false }, forwardRead: { enabled: false } };
  for (const name of Object.keys(result)) {
    if (value[name] === undefined) continue;
    if (!keys(value[name], Object.keys(result[name]))) error("NATIVE_POLICY");
    for (const [key, entry] of Object.entries(value[name])) {
      if (key === "enabled" ? typeof entry !== "boolean"
        : !uint(entry) || entry > (key === "maxDaily" ? 200 : DAY)) error("NATIVE_POLICY");
      result[name][key] = entry;
    }
  }
  return result;
}

/** HOST ONLY, not a model tool registry. No IO except injected adapters.
 * capture/isCurrent: same exact handle/revision/logical route/quiet/participation
 * contract as message-reactions. Capture includes policy + capabilities
 * {poke,mention}: unknown|supported|unsupported; absent = unknown.
 * getTargets(ctx) SYNCHRONOUSLY returns HOST-AUTHENTICATED current group evidence:
 * {event:{ref,groupId,messageId,userId,sentAt,isBot:false},
 *  members:[{groupId,userId,verifiedAt,isBot:false}]}.
 * ref is a host object capability, never a deserialized model/user object.
 * isCurrent must invalidate ctx on current-event/control/route changes too.
 * transact(syncBuilder({memory})) is the SOLE background repository writer,
 * resolves after publication, rejects on failure (never returns a failed ACK).
 * request(ctx,'group_poke',exactIntegerParams,{signal,binding}) MUST use the
 * existing physical group gate and recheck binding.isCurrent at actual wire.
 * onSendStarted is forwarded verbatim; ONLY real dispatcher invokes it.
 * sendMention(ctx,{userId,content},{signal,binding}) constructs safe at+text
 * segments in the host, uses the SAME send gate/receipt path; never sends CQ.
 * Its normalized ACK {messageId: string|safeInteger} is passed through unchanged;
 * false means proven rejection/no send. Raw OneBot data.message_id is NOT a
 * normalized ACK. Unknown ACKs/exceptions remain uncertain in the renderer,
 * never accepted-as-action, retried or replaced by unmentioned text.
 * Each candidate is single-use, including denied/uncertain storage attempts.
 * Wire adapters own their ACK deadline; no replay/fallback endpoint exists here.
 */
export function createNativeSocialActions({ capture, isCurrent, getTargets, readState, transact,
  request, sendMention: mentionAdapter, clock = Date.now } = {}) {
  if ([capture, isCurrent, getTargets, readState, transact, clock].some(fn => typeof fn !== "function")
    || [request, mentionAdapter].some(fn => fn !== undefined && typeof fn !== "function")) error("NATIVE_DEPENDENCY");
  const contexts = new WeakMap(), offers = new WeakMap();
  // Bounded backpressure, not an evicting retry cache. Restart relies on durable
  // poke claims; failed/uncertain repository publication must stop host writer.
  const attempted = new Map();
  let clockWatermark = 0;
  const now = () => {
    const at = clock();
    if (!uint(at) || at > 8639999900000000 || at < clockWatermark) error("NATIVE_CLOCK");
    clockWatermark = at;
    return at;
  };
  const fresh = (at, time, age) => uint(time) && at >= time && at - time <= age;
  function info(ctx) {
    const c = contexts.get(ctx);
    if (!c || ["accountId", "logicalId", "conversationId", "revision"].some(k => ctx[k] !== c[k])
      || JSON.stringify(ctx.policy) !== c.policyKey || JSON.stringify(ctx.capabilities) !== c.capabilityKey) error("NATIVE_CONTEXT");
    return c;
  }
  function guard(ctx, kind, signal) {
    const c = info(ctx);
    if (signal?.aborted || isCurrent(ctx) !== true) error("NATIVE_STALE");
    const section = { poke: "pokes", mention: "mentions" }[kind];
    if (!c.policy.enabled || c.policy.shadowMode || !c.native[section]?.enabled
      || c.capabilities[kind] !== "supported") error("NATIVE_DISABLED");
    return c;
  }
  function open(accountId, conversationId) {
    if (typeof accountId !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(accountId)
      || typeof conversationId !== "string" || !/^group:[1-9]\d{0,19}$/.test(conversationId)) error("NATIVE_SCOPE");
    const ctx = capture(accountId, conversationId);
    if (!plain(ctx) || contexts.has(ctx) || ctx.accountId !== accountId || ctx.conversationId !== conversationId
      || typeof ctx.logicalId !== "string" || !/^(account|group):[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(ctx.logicalId)
      || !(typeof ctx.revision === "string" || uint(ctx.revision)) || !plain(ctx.policy)
      || ctx.capabilities !== undefined && (!keys(ctx.capabilities, ["poke", "mention"])
        || Object.values(ctx.capabilities).some(v => !supported(v)))) error("NATIVE_CONTEXT");
    const { active, pokes, mentions, forwardRead, ...base } = ctx.policy;
    const policy = validateSocialExperiencePolicy(base);
    if (!policy.conversationIds.includes(conversationId)) error("NATIVE_SCOPE");
    const native = validateNativeSocialPolicy({ pokes, mentions, forwardRead });
    contexts.set(ctx, { accountId, conversationId, logicalId: ctx.logicalId, revision: ctx.revision,
      policy, native, capabilities: { ...ctx.capabilities }, policyKey: JSON.stringify(ctx.policy),
      capabilityKey: JSON.stringify(ctx.capabilities) });
    return ctx;
  }
  function evidence(ctx) {
    const c = info(ctx), at = now(), data = getTargets(ctx), e = data?.event;
    if (!plain(data) || !plain(e) || !ref(e.ref) || e.groupId !== c.conversationId.slice(6)
      || !mid(e.messageId) || !qq(e.userId) || e.isBot !== false || !fresh(at, e.sentAt, AGE)
      || !Array.isArray(data.members) || data.members.length > 1024) error("NATIVE_EVIDENCE");
    const members = data.members.filter(m => plain(m) && m.groupId === e.groupId && qq(m.userId)
      && m.isBot === false && fresh(at, m.verifiedAt, MEMBER_AGE));
    return { e, members };
  }
  function checkTarget(ctx, item, signal) {
    const c = guard(ctx, item.kind, signal), { e, members } = evidence(ctx);
    if (e.ref !== item.eventRef || e.messageId !== item.messageId || e.sentAt !== item.sentAt
      || e.userId !== item.senderId || !members.some(m => m.userId === item.userId)) error("NATIVE_TARGET");
    return c;
  }
  function book(root, c, create = false) {
    if (!plain(root) || !plain(root.memory)) error("NATIVE_STATE");
    const state = root.memory.nativeSocialActions;
    if (state !== undefined && (!keys(state, ["version", "bots"]) || state.version !== 1 || !plain(state.bots))) error("NATIVE_STATE");
    const bot = state?.bots[c.logicalId];
    if (bot !== undefined && (!keys(bot, ["groups"]) || !plain(bot.groups) || Object.keys(bot.groups).length > 128)) error("NATIVE_STATE");
    let count = 0;
    for (const [id, group] of Object.entries(bot?.groups || {})) {
      if (!/^group:[1-9]\d{0,19}$/.test(id) || !keys(group, ["claims", "days", "lastAt", "capability"])
        || !supported(group.capability) || !plain(group.claims) || !plain(group.days)
        || !uint(group.lastAt) || Object.keys(group.days).length > 8) error("NATIVE_STATE");
      for (const [day, n] of Object.entries(group.days)) if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !uint(n)) error("NATIVE_STATE");
      for (const [id, row] of Object.entries(group.claims)) {
        if (++count > CAPACITY || !mid(id) || !keys(row, ["actionId", "status", "at", "sentAt"])
          || !outcomes.includes(row.status) || !uint(row.at) || !uint(row.sentAt)
          || typeof row.actionId !== "string" || !/^poke_[a-f0-9-]{36}$/.test(row.actionId)) error("NATIVE_STATE");
      }
    }
    if (!create) return { bot, group: bot?.groups[c.conversationId] };
    root.memory.nativeSocialActions ??= { version: 1, bots: {} };
    const b = root.memory.nativeSocialActions.bots[c.logicalId] ??= { groups: {} };
    if (!Object.hasOwn(b.groups, c.conversationId)) {
      if (Object.keys(b.groups).length >= 128) error("NATIVE_CAPACITY");
      b.groups[c.conversationId] = { claims: {}, days: {}, lastAt: 0, capability: "unknown" };
    }
    return { bot: b, group: b.groups[c.conversationId] };
  }
  function available(data, c, at) {
    const { bot, group } = data, day = dayAt(at);
    const groups = Object.values(bot?.groups || {});
    const daily = groups.reduce((sum, g) => sum + (g.days[day] || 0), 0);
    return group?.capability !== "unsupported" && uint(daily) && daily < c.native.pokes.maxDaily
      && groups.every(g => at >= g.lastAt && Object.keys(g.days).every(d => d <= day))
      && (!group || !Object.keys(group.days).length || at - group.lastAt >= c.native.pokes.cooldownMs);
  }
  const attemptKey = (c, item) => `${c.logicalId}/${c.conversationId}/${item.kind}/${item.messageId}/${item.userId}`;
  function candidates(ctx) {
    const result = { mentions: [], pokes: [] }, entries = new Map();
    offers.delete(ctx);
    try {
      const at = now();
      for (const [key, sentAt] of attempted) if (at - sentAt > AGE) attempted.delete(key);
      const { e, members } = evidence(ctx);
      const add = (kind, target) => {
        try {
          const c = guard(ctx, kind), item = Object.freeze({ kind, eventRef: e.ref, messageId: e.messageId,
            senderId: e.userId, sentAt: e.sentAt, ...target });
          if (attempted.size >= CAPACITY || attempted.has(attemptKey(c, item))) return;
          if (kind === "poke") {
            const data = book(readState(), c);
            if (!wireId(e.groupId) || !wireId(item.userId) || data.group?.claims[e.messageId] || !available(data, c, now())) return;
          }
          const id = `${kind}_${randomUUID()}`;
          entries.set(id, item);
          result[{ poke: "pokes", mention: "mentions" }[kind]].push({ id,
            label: { poke: "拍一拍当前发言者", mention: "提及宿主核实的当前群成员" }[kind] });
        } catch { /* No policy/capability/evidence means no offer. */ }
      };
      if (mentionAdapter) for (const m of [...new Map(members.map(m => [m.userId, m])).values()].slice(0, 3)) add("mention", { userId: m.userId });
      if (request && members.some(m => m.userId === e.userId)) add("poke", { userId: e.userId });
    } catch { /* Issued handles only; never accept raw target arguments. */ }
    if (contexts.has(ctx)) offers.set(ctx, entries);
    return result;
  }
  function take(ctx, id, kind, signal, onSendStarted) {
    const item = offers.get(ctx)?.get(id);
    if (!item || item.kind !== kind || onSendStarted !== undefined && typeof onSendStarted !== "function") error("NATIVE_CANDIDATE");
    offers.get(ctx).delete(id); // Consume even on quiet/abort/claim failure.
    const c = info(ctx), key = attemptKey(c, item);
    if (attempted.size >= CAPACITY || attempted.has(key)) error("NATIVE_REUSE");
    attempted.set(key, item.sentAt);
    checkTarget(ctx, item, signal);
    return { c, item, binding: { ...(onSendStarted ? { onSendStarted } : {}), isCurrent: () => {
      try { checkTarget(ctx, item, signal); return true; } catch { return false; }
    } } };
  }
  async function sendPoke(ctx, id, { signal, onSendStarted } = {}) {
    let c, item, binding, actionId;
    try {
      ({ c, item, binding } = take(ctx, id, "poke", signal, onSendStarted));
      actionId = `poke_${randomUUID()}`;
      await transact(root => {
        checkTarget(ctx, item, signal);
        const at = now(), data = book(root, c, true), b = data.group;
        if (b.claims[item.messageId] || !available(data, c, at)) error("NATIVE_LIMIT");
        for (const g of Object.values(data.bot.groups)) for (const [id, row] of Object.entries(g.claims)) {
          if (at >= row.sentAt && at - row.sentAt > AGE) delete g.claims[id];
        }
        if (Object.values(data.bot.groups).reduce((n, g) => n + Object.keys(g.claims).length, 0) >= CAPACITY) error("NATIVE_CAPACITY");
        const day = dayAt(at), cutoff = dayAt(Math.max(0, at - 6 * DAY));
        for (const d of Object.keys(b.days)) if (d < cutoff) delete b.days[d];
        b.days[day] = (b.days[day] || 0) + 1; b.lastAt = at;
        b.claims[item.messageId] = { actionId, status: "claimed", at, sentAt: item.sentAt };
      });
    } catch { return { status: "rejected" }; }
    let status = "rejected";
    try {
      checkTarget(ctx, item, signal);
      status = "uncertain";
      const ack = await request(ctx, "group_poke", { group_id: Number(c.conversationId.slice(6)), user_id: Number(item.userId) }, { signal, binding });
      if (ack?.retcode === 404 || ack?.retcode === 1404) status = "unsupported";
      else if (ack?.status === "ok" && ack.retcode === 0) status = "accepted";
      else if (ack?.status === "failed" && Number.isSafeInteger(ack.retcode) && ack.retcode !== 0) status = "rejected";
    } catch { /* Exactly one attempt, even on abort, timeout or late ACK. */ }
    try {
      await transact(root => {
        const b = book(root, c).group, row = b?.claims[item.messageId];
        if (!row || row.actionId !== actionId || row.status !== "claimed") error("NATIVE_STATE");
        row.status = status; // Fact-only settlement after quiet/cancellation too.
        if (status === "accepted") b.capability = "supported";
        if (status === "unsupported") b.capability = "unsupported";
      });
    } catch { return { status: "uncertain", actionId }; }
    return { status, actionId }; // NEVER manufacture a QQ message ID or speech.
  }
  async function sendMention(ctx, id, content, { signal, onSendStarted } = {}) {
    let item, binding, text;
    try {
      ({ item, binding } = take(ctx, id, "mention", signal, onSendStarted));
      text = validateReplyPlan({ version: 1, action: "reply", messages: [{ type: "text", content }],
        replyToMessageId: null }).messages[0].content;
      if (typeof content !== "string" || !content.trim() || !text || text !== content) error("NATIVE_TEXT");
    } catch { return false; }
    // The ordinary reply host owns message ACK and durable spoken receipts.
    return mentionAdapter(ctx, { userId: item.userId, content: text }, { signal, binding });
  }
  function status(ctx) {
    try {
      const c = info(ctx), data = book(readState(), c), at = now();
      return { ok: true, capabilities: { poke: data.group?.capability === "unsupported" ? "unsupported" : c.capabilities.poke || "unknown", mention: c.capabilities.mention || "unknown" },
        daily: Object.values(data.bot?.groups || {}).reduce((n, g) => n + (g.days[dayAt(at)] || 0), 0),
        dailyScope: "logical-bot", maxDaily: c.native.pokes.maxDaily,
        cooldownRemainingMs: data.group && Object.keys(data.group.days).length
          ? Math.max(0, c.native.pokes.cooldownMs - (at - data.group.lastAt)) : 0 };
    } catch { return { ok: false, code: "NATIVE_STATE" }; }
  }
  return Object.freeze({ open, candidates, sendPoke, sendMention, status });
}
