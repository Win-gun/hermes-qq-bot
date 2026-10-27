// HOST ONLY. Ephemeral, finite expression context, NOT a sender or permission.
// No persistence, timers, models, network, asset selection or relationship claims.
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const uint = value => Number.isSafeInteger(value) && value >= 0;
const qq = value => typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);
const mid = value => typeof value === "string" && /^-?[1-9]\d{0,19}$/.test(value);
const MAX_AGE = 300000;
const DEFAULTS = Object.freeze({ enabled: false, shadowMode: false, ttlMs: 120000,
  maxDurationMs: 600000, maxReciprocations: 4, cooldownMs: 1000, maxSourceAgeMs: MAX_AGE });
const eventKeys = ["kind", "messageId", "logicalId", "recipientLogicalId", "conversationId", "userId",
  "sentAt", "receivedAt", "isBot", "isQuoted", "hasSticker", "directedToBot", "text",
  "stickerRequested", "battleRequested", "stop", "serious", "negativeFeedback"];
const flags = ["stickerRequested", "battleRequested", "stop", "serious", "negativeFeedback"];
const stopText = /(?:不斗图|不玩了|到此为止|停止斗图|(?:别|不要|不用|停止|不许).{0,8}(?:发图|表情|贴图|斗图)|只(?:要|用|发)文字)/u;
const negativeText = /(?:话真密|谁问你|别插嘴|闭嘴|别吵|别刷|太吵|别闹|别开玩笑)/u;
const seriousText = /(?:认真|严肃|求助|救命|急救|自杀|自残|轻生|不想活|活不下去|想死|结束生命|抑郁|去世|葬礼|难过|伤心|绝望|恐慌|生病|住院|事故|受伤|胸痛|呼吸困难|家暴|诈骗|报警|诊断|报错|故障|代码|数据丢失)/u;

function policy(value) {
  if (!plain(value) || Object.keys(value).some(key => !Object.hasOwn(DEFAULTS, key))) return null;
  const p = { ...DEFAULTS, ...value };
  if (typeof p.enabled !== "boolean" || typeof p.shadowMode !== "boolean"
    || !uint(p.ttlMs) || p.ttlMs < 1000 || p.ttlMs > 600000
    || !uint(p.maxDurationMs) || p.maxDurationMs < p.ttlMs || p.maxDurationMs > 600000
    || !uint(p.maxReciprocations) || p.maxReciprocations < 1 || p.maxReciprocations > 8
    || !uint(p.cooldownMs) || p.cooldownMs > 300000
    || !uint(p.maxSourceAgeMs) || p.maxSourceAgeMs < 1 || p.maxSourceAgeMs > MAX_AGE) return null;
  return p;
}
function scopeKey(scope) {
  if (!plain(scope) || typeof scope.logicalId !== "string"
    || !/^(account|group):[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(scope.logicalId)
    || typeof scope.conversationId !== "string" || !/^(group|private):[1-9]\d{0,19}$/.test(scope.conversationId)
    || !qq(scope.userId) || !(uint(scope.revision) || typeof scope.revision === "string" && scope.revision.length > 0 && scope.revision.length <= 128)
    || scope.conversationId.startsWith("private:") && scope.conversationId.slice(8) !== scope.userId) return null;
  return JSON.stringify([scope.logicalId, scope.conversationId, scope.userId]);
}
const policyKey = p => JSON.stringify(p);
const active = row => row && !["ordinary", "ended"].includes(row.stage);
function end(row, reason) {
  if (row) { row.stage = "ended"; row.reason = reason; row.source = null; }
}

/**
 * scope: {logicalId, conversationId: 'group:QQ'|'private:QQ', userId, revision}.
 * Every operation takes {interactions, signal}; interactions is SEPARATE from
 * socialExperience/stickers policy and defaults OFF. Pass the LIVE policy each
 * time. isCurrent(scope) must synchronously check route/control/quiet/revision.
 * isCurrentEvent(scope,event) must authenticate the exact current HOST event
 * object for this recipient/process (never return true for history/model data).
 * current is a host-only normalized direct message; isBot:false, isQuoted:false,
 * logicalId + recipientLogicalId and matching scope are REQUIRED. Private scope
 * still requires explicit recipient evidence; it never infers consent/closeness.
 *
 * observe(scope,{current,history=[]},options) -> {ok,reason,source,projection}.
 * history is accepted for bridge compatibility but NEVER hydrated or replayed;
 * existing history/model suggestions cannot advance any stage. source is an
 * opaque, one-use, process-local handle, not a message ID or send authority.
 * beginReply(scope,source,options) -> {ok,reason,ticket,projection}. Invoke once
 * immediately before the host's ONE image attempt; all ordinary asset, quiet,
 * revision and wire gates remain mandatory. A newer event replaces unused source;
 * input during an unresolved attempt ends it rather than starting a second one.
 * recordReceipt(scope,ticket,receipt,options) -> {recorded,reason,projection}.
 * receipt is host-normalized {type:'sticker'|'image',status:'sent',messageId}.
 * The ticket binds OWN attempt/recipient/source; raw OneBot or model receipts are
 * not accepted. Native accepted, text, malformed, failed and uncertain receipts
 * END the interaction and cannot be retried. ALWAYS settle timeout/exception as
 * uncertain. Late confirmed ACKs count facts once but NEVER revive ended state.
 * cancel(scope) ends context; project(scope,options) returns a frozen projection
 * with NO IDs, text, assets, tokens, relationship inference or send permission.
 *
 * Stages: ordinary (unaddressed/no sticker intent), directed (first addressed
 * human sticker/request), exchange (one confirmed reciprocation), battle (human
 * explicitly requested battle AND >=2 confirmed reciprocations), ended.
 * Each new human source permits at most one attempt, up to a hard session cap.
 * TTL refreshes ONLY on new relevant human input, never on reads/ACKs. Hard
 * duration never refreshes. Retained ended sessions need a NEW explicit human
 * request after cooldown; a bare sticker cannot reset the cap/stop/negative fence.
 * Inactive rows may be reclaimed after the five-minute source retention window;
 * durable quiet/negative-feedback policies remain the host's separate authority.
 * Restart discards ALL sessions/tickets; the host must also discard old event
 * issuance. Pre-start receivedAt and all old tickets are refused. No rehydration.
 */
export function createStickerInteraction({ clock = Date.now, isCurrent, isCurrentEvent,
  maxScopes = 256, maxSources = 4096 } = {}) {
  if (![clock, isCurrent, isCurrentEvent].every(fn => typeof fn === "function")
    || !Number.isSafeInteger(maxScopes) || maxScopes < 1 || maxScopes > 1024
    || !Number.isSafeInteger(maxSources) || maxSources < 1 || maxSources > 10000) throw new TypeError("STICKER_INTERACTION_DEPENDENCY");
  const rows = new Map(), seen = new Map(), acknowledged = new Map(), sources = new WeakMap(), tickets = new WeakMap();
  const startedAt = clock();
  if (!uint(startedAt) || startedAt > 8639999900000000) throw new TypeError("STICKER_INTERACTION_CLOCK");
  let watermark = startedAt, clockFailed = false;
  function now() {
    let at;
    try { at = clock(); } catch { clockFailed = true; }
    if (!uint(at) || at > 8639999900000000 || at < watermark) clockFailed = true;
    if (clockFailed) { for (const row of rows.values()) end(row, "clock-invalid"); return null; }
    watermark = at; return at;
  }
  function expire(row, at) {
    if (active(row) && at >= row.hardDeadline) end(row, "duration-limit");
    if (active(row) && at >= row.expiresAt) end(row, "expired");
  }
  function check(scope, options = {}) {
    const key = scopeKey(scope), row = key && rows.get(key), at = now();
    const p = plain(options) ? policy(options.interactions === undefined ? {} : options.interactions) : null;
    let reason = null;
    if (!key) reason = "invalid-scope";
    else if (at === null) reason = "clock-invalid";
    else if (!p) reason = "invalid-policy";
    else if (options.signal?.aborted) reason = "cancelled";
    else if (!p.enabled) reason = "disabled";
    else if (p.shadowMode) reason = "shadow";
    else {
      try { if (isCurrent(scope) !== true) reason = "stale"; } catch { reason = "stale"; }
    }
    if (reason) end(row, reason);
    else if (row) {
      expire(row, at);
      if (row.revision !== scope.revision || row.policyKey !== policyKey(p)) end(row, "context-changed");
    }
    return { key, row, at, p, reason };
  }
  function projection(row, p, at, reason) {
    return Object.freeze({ stage: reason ? "ended" : row?.stage || "ordinary",
      reason: reason || row?.reason || "no-session", ephemeral: true, restartReplay: false,
      relationshipEvidence: false, grantsAuthority: false,
      humanTurns: row?.humanTurns || 0, reciprocations: row?.reciprocations || 0,
      remainingReciprocations: Math.max(0, (p?.maxReciprocations || 0) - (row?.reciprocations || 0)),
      awaitingReceipt: !!row?.pending,
      hasCurrentOpportunity: !reason && active(row) && !!row.source && !row.pending,
      remainingTtlMs: !reason && active(row) ? Math.max(0, Math.min(row.expiresAt, row.hardDeadline) - at) : 0 });
  }
  const view = c => projection(c.row, c.p, c.at, c.reason);
  const result = (c, ok, reason, extra = {}) => Object.freeze({ ok, reason, ...extra, projection: view(c) });
  function project(scope, options) { return view(check(scope, options)); }
  function validEvent(scope, e, at, p) {
    if (!plain(e) || Object.keys(e).some(k => !eventKeys.includes(k)) || e.kind !== "message"
      || e.logicalId !== scope.logicalId || e.recipientLogicalId !== scope.logicalId
      || e.conversationId !== scope.conversationId || e.userId !== scope.userId
      || !mid(e.messageId) || e.isBot !== false || e.isQuoted !== false
      || typeof e.hasSticker !== "boolean" || typeof e.directedToBot !== "boolean"
      || typeof e.text !== "string" || e.text.length > 4000
      || flags.some(k => e[k] !== undefined && typeof e[k] !== "boolean")
      || !uint(e.sentAt) || !uint(e.receivedAt) || e.receivedAt < startedAt
      || e.sentAt > e.receivedAt || e.receivedAt > at || at - e.sentAt >= p.maxSourceAgeMs) return false;
    try { return isCurrentEvent(scope, e) === true; } catch { return false; }
  }
  function observe(scope, input, options) {
    const c = check(scope, options);
    if (c.reason) return result(c, false, c.reason, { source: null });
    if (!plain(input) || Object.keys(input).some(k => !["current", "history"].includes(k))
      || input.history !== undefined && (!Array.isArray(input.history) || input.history.length > 128)
      || !validEvent(scope, input.current, c.at, c.p)) return result(c, false, "invalid-source", { source: null });
    const e = input.current, sourceKey = JSON.stringify([scope.logicalId, scope.conversationId, e.messageId]);
    for (const [id, until] of seen) if (until <= c.at) seen.delete(id);
    if (seen.has(sourceKey)) return result(c, false, "duplicate-source", { source: null });
    if (seen.size >= maxSources) { end(c.row, "capacity"); return result(c, false, "capacity", { source: null }); }
    // Keep fences for the MAX admissible age, even if a later policy widens it.
    seen.set(sourceKey, e.sentAt + MAX_AGE);
    for (const [id, row] of rows) {
      expire(row, c.at);
      if (!row.pending && !active(row) && row.retainUntil <= c.at) rows.delete(id);
    }
    c.row = rows.get(c.key);
    if (!c.row) {
      if (rows.size >= maxScopes) return result(c, false, "capacity", { source: null });
      c.row = { stage: "ordinary", reason: "ordinary", humanTurns: 0, reciprocations: 0,
        retainUntil: 0, source: null, pending: null, lastAckAt: null, lastSentAt: null,
        latestEvent: null, revision: scope.revision, policyKey: policyKey(c.p) };
      rows.set(c.key, c.row);
    }
    const row = c.row;
    row.retainUntil = Math.max(row.retainUntil, e.sentAt + MAX_AGE);
    const text = e.text.normalize("NFKC").toLowerCase();
    const termination = e.stop || stopText.test(text) ? "stopped"
      : e.negativeFeedback || negativeText.test(text) ? "negative-feedback"
        : e.serious || seriousText.test(text) ? "serious" : null;
    // Safety signals win even if sender timestamps arrived out of order.
    if (termination) { end(row, termination); return result(c, true, termination, { source: null }); }
    if (row.lastSentAt !== null && e.sentAt < row.lastSentAt) return result(c, false, "out-of-order", { source: null });
    row.lastSentAt = e.sentAt;
    row.source = null; row.latestEvent = e;
    if (row.pending) { end(row, "reply-pending"); return result(c, true, "reply-pending", { source: null }); }
    const invited = e.stickerRequested === true || e.battleRequested === true;
    const addressed = e.directedToBot || scope.conversationId.startsWith("private:");
    const relevant = e.hasSticker || invited;
    const continuing = active(row);
    if (row.stage === "ended" && (!addressed || !invited)) return result(c, true, row.reason, { source: null });
    if (!relevant || !continuing && !addressed) {
      if (continuing) end(row, "topic-changed");
      return result(c, true, row.reason, { source: null });
    }
    if (row.lastAckAt !== null && c.at - row.lastAckAt < c.p.cooldownMs) return result(c, true, "cooldown", { source: null });
    if (!continuing) {
      row.createdAt = c.at; row.hardDeadline = c.at + c.p.maxDurationMs;
      row.reciprocations = 0; row.humanTurns = 0; row.battleRequested = false;
      row.stage = "directed"; row.revision = scope.revision; row.policyKey = policyKey(c.p);
    }
    row.battleRequested ||= e.battleRequested === true;
    row.humanTurns++; row.expiresAt = Math.min(c.at + c.p.ttlMs, row.hardDeadline);
    row.reason = "human-input";
    const source = Object.freeze({});
    row.source = source; sources.set(source, { row, key: c.key, event: e,
      snapshot: Object.fromEntries(eventKeys.map(k => [k, e[k]])) });
    return result(c, true, "human-input", { source });
  }
  function beginReply(scope, source, options) {
    const c = check(scope, options), offer = plain(source) && sources.get(source);
    if (c.reason) return result(c, false, c.reason, { ticket: null });
    if (!offer || offer.key !== c.key || offer.row !== c.row || c.row.source !== source || !active(c.row)
      || c.row.pending || c.row.reciprocations >= c.p.maxReciprocations
      || !validEvent(scope, offer.event, c.at, c.p) || eventKeys.some(k => offer.event[k] !== offer.snapshot[k])) {
      if (c.row && offer?.row === c.row && c.row.source === source) end(c.row, "stale-source");
      return result(c, false, "invalid-source", { ticket: null });
    }
    const ticket = Object.freeze({});
    c.row.source = null; c.row.pending = ticket;
    tickets.set(ticket, { key: c.key, row: c.row, settled: false });
    return result(c, true, "attempt-started", { ticket });
  }
  function recordReceipt(scope, ticket, receipt, options) {
    const c = check(scope, options), attempt = plain(ticket) && tickets.get(ticket);
    if (!c.key || !attempt || attempt.key !== c.key || attempt.row !== c.row || attempt.settled
      || c.row.pending !== ticket) return Object.freeze({ recorded: false, reason: "invalid-ticket", projection: view(c) });
    // Settle facts even after cancellation/quiet/policy/TTL. No callback can revive
    // an ended session, and one unknown receipt permanently consumes its ticket.
    attempt.settled = true; c.row.pending = null;
    const confirmed = plain(receipt) && ["sticker", "image"].includes(receipt.type)
      && receipt.status === "sent" && mid(receipt.messageId)
      && !Object.hasOwn(receipt, "skipped") && !Object.hasOwn(receipt, "message_id");
    if (!confirmed) {
      end(c.row, "unconfirmed-receipt");
      return Object.freeze({ recorded: false, reason: "unconfirmed-receipt", projection: view(c) });
    }
    for (const [id, until] of acknowledged) if (until <= c.at) acknowledged.delete(id);
    const ackKey = JSON.stringify([scope.logicalId, scope.conversationId, receipt.messageId]);
    if (acknowledged.has(ackKey) || acknowledged.size >= maxSources) {
      end(c.row, "receipt-duplicate-or-capacity");
      return Object.freeze({ recorded: false, reason: "receipt-duplicate-or-capacity", projection: view(c) });
    }
    // Clock failure cannot open more work; retain its late fact fence indefinitely.
    acknowledged.set(ackKey, c.at === null ? Infinity : c.at + 600000);
    c.row.reciprocations++;
    if (c.at !== null) c.row.lastAckAt = c.at;
    if (active(c.row)) {
      if (c.row.reciprocations >= c.p.maxReciprocations) end(c.row, "reciprocation-limit");
      else { c.row.stage = c.row.battleRequested && c.row.reciprocations >= 2 ? "battle" : "exchange"; c.row.reason = "confirmed-image"; }
    }
    return Object.freeze({ recorded: true, reason: "confirmed-image", projection: view(c) });
  }
  function cancel(scope) {
    const key = scopeKey(scope), row = key && rows.get(key);
    end(row, "cancelled");
    return Object.freeze({ cancelled: !!row });
  }
  return Object.freeze({ observe, beginReply, recordReceipt, project, cancel });
}
