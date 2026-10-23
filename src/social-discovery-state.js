import { createHash } from "node:crypto";

// Synchronous latest-draft builders only. Host owns durable publication, evidence
// grounding, idle/quiet/route checks, authorization and the actual network call.
// Never feed model output into usage/providerUsage or policy. No IO or clock.
//
// API details for adapters:
// - validateDiscoveryPolicy: {ok:true,policy} | {ok:false,reason:"invalid_policy"}.
//   Only known fields accepted, no coercion; defaults apply to omitted fields.
// - normalizeDiscoveryPolicy: complete detached policy; invalid input -> OFF.
// - writers: {ok,...} | {ok:false,reason}; rejected writes leave root untouched.
// - list: detached admin array incl terminal summaries (includeInactive:false
//   restricts to active); retrieve: detached <=3 related authorized group items.
// - call settlement: usage:{inputTokens,outputTokens}; providerUsage may carry
//   the same token fields plus toolCalls/pageCalls. Both MUST be host receipts.
// - markDiscoveryUsed receiptId === share claimId after a confirmed share.
// - status.today searchRequests/filterCalls count INVOKED calls, not admission.
// - host must recheck policy/quiet/route/idle immediately before actual wire;
//   returning ok is a state claim, never permission to bypass those checks.
const HOUR = 3_600_000, DAY = 24 * HOUR;
const LIMIT = 4096, HISTORY = 4096;
const FENCES = 65_536;
const plain = x => x !== null && typeof x === "object" && !Array.isArray(x)
  && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const own = (x, k) => plain(x) && Object.hasOwn(x, k);
const integer = (x, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(x) && x >= min && x <= max;
const stamp = x => integer(x, 1, 8_640_000_000_000_000 - 31 * DAY);
const token = x => typeof x === "string" && /^[A-Za-z0-9_.:\-]{1,160}$/.test(x)
  && !["__proto__", "constructor", "prototype"].includes(x);
const logical = x => typeof x === "string" && /^(account|group):[A-Za-z0-9_.:\-]{1,100}$/.test(x);
const group = x => typeof x === "string" && /^group:[1-9][0-9]{0,19}$/.test(x);
const clone = x => structuredClone(x);
const fail = reason => ({ ok: false, reason });
const hash = x => createHash("sha256").update(x).digest("hex").slice(0, 32);
const normalizedText = x => x.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
const risky = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]|<\/?(?:script|iframe)|javascript:|data:text|ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions|system\s*prompt|developer\s*message|忽略.{0,8}(?:指令|提示)|系统提示词|(?:密码|验证码|身份证|银行卡|手机号|家庭住址)\s*[:：=]|(?:password|api[_ -]?key|token)\s*[:=]|Bearer\s+|sk-[a-z0-9_-]{12,}|\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b|\b\d{16,19}\b/iu;
const text = (x, max, empty = false) => typeof x === "string" && x.length <= max && !risky.test(x)
  && (empty || x.trim().length > 0);
const defaults = { enabled: false, shadowMode: true, conversationIds: [], interests: [],
  humorPreference: "abstract/contextual", blockedTopics: [], maxRoundsPerDay: 4,
  minIntervalMs: 5_400_000, maxSearchesPerRound: 3, maxSharesPerDay: 2, shareCooldownMs: 10_800_000 };
const fixed = { timezone: "Asia/Shanghai", timeoutMs: 180_000, idleMs: 60_000, maxActiveItems: 300 };
const ranges = { maxRoundsPerDay: [1, 8], minIntervalMs: [HOUR, Number.MAX_SAFE_INTEGER],
  maxSearchesPerRound: [1, 3], maxSharesPerDay: [0, 4], shareCooldownMs: [HOUR, Number.MAX_SAFE_INTEGER] };

/** Strict write validation. Missing fields use defaults; unknown knobs reject. */
export function validateDiscoveryPolicy(value) {
  if (!plain(value)) return fail("invalid_policy");
  for (const [k, v] of Object.entries(value)) {
    if (own(fixed, k)) { if (v !== fixed[k]) return fail("invalid_policy"); }
    else if (!own(defaults, k)) return fail("invalid_policy");
    else if (["enabled", "shadowMode"].includes(k)) { if (typeof v !== "boolean") return fail("invalid_policy"); }
    else if (own(ranges, k)) { if (!integer(v, ...ranges[k])) return fail("invalid_policy"); }
    else if (k === "humorPreference") { if (!text(v, 240)) return fail("invalid_policy"); }
    else if (!Array.isArray(v) || v.length > 128 || v.some(s => k === "conversationIds" ? !group(s) : !text(s, 120))) return fail("invalid_policy");
  }
  const policy = { ...clone(defaults), ...clone(value), ...fixed };
  for (const k of ["conversationIds", "interests", "blockedTopics"]) policy[k] = [...new Set(policy[k])];
  return { ok: true, policy };
}

/** Compatibility reads fail closed for invalid policy rather than coerce grants. */
export function normalizeDiscoveryPolicy(value = {}) {
  const result = validateDiscoveryPolicy(value);
  return result.ok ? result.policy : { ...clone(defaults), ...fixed };
}
function local(now) { return new Date(now + 8 * HOUR); }
function dayOf(now) { return local(now).toISOString().slice(0, 10); }
export function discoveryWindowAllowed(now, { sharing = false } = {}) {
  if (!stamp(now)) return false;
  const d = local(now), h = d.getUTCHours(), weekday = d.getUTCDay();
  return !(weekday >= 1 && weekday <= 5 && ((h >= 9 && h < 12) || (h >= 14 && h < 18)))
    && !(sharing && (h >= 22 || h < 9));
}
function botAt(root, id) { return own(root?.socialAgents?.bots, id) ? root.socialAgents.bots[id] : undefined; }
function emptyState() { return { version: 1, items: [], blocks: [], rounds: [], shares: [], receipts: [], roundIds: [], callClaims: {}, policy: normalizeDiscoveryPolicy() }; }
function validState(s) {
  return plain(s) && s.version === 1 && ["items", "blocks", "rounds", "shares", "receipts", "roundIds"].every(k => Array.isArray(s[k]))
    && plain(s.callClaims) && s.items.length <= 300 && s.blocks.length <= LIMIT
    && s.roundIds.length <= FENCES && s.shares.length <= LIMIT && s.receipts.length <= LIMIT
    && Object.keys(s.callClaims).length <= LIMIT && s.rounds.length <= HISTORY
    && s.roundIds.every(token)
    && s.items.every(i => plain(i) && token(i.id) && token(i.eventKey) && text(i.title, 180)
      && text(i.meaning, 800, true) && text(i.applicable, 400, true) && text(i.avoid, 400, true)
      && (i.uncertainty === undefined || text(i.uncertainty, 240, true))
      && ["expression", "news"].includes(i.kind) && i.status === "active" && stamp(i.expiresAt) && stamp(i.collectedAt)
      && Number.isFinite(i.confidence) && Array.isArray(i.sources) && i.sources.length > 0 && i.sources.length <= 8
      && i.sources.every(source => plain(source) && !!canonicalUrl(source.url) && canonicalUrl(source.url) === source.url))
    && s.blocks.every(b => plain(b) && token(b.id) && token(b.eventKey) && stamp(b.at)
      && (b.conversationId === undefined || group(b.conversationId))
      && (b.urls === undefined || (Array.isArray(b.urls) && b.urls.length <= 8 && b.urls.every(url => !!canonicalUrl(url)))))
    && s.rounds.every(r => plain(r) && token(r.id) && stamp(r.startedAt) && typeof r.day === "string"
      && ["running", "complete", "cancelled", "failed", "interrupted"].includes(r.status)
      && integer(r.searches, 0, 3) && integer(r.filters, 0, 1) && integer(r.maxSearches, 1, 3) && validateDiscoveryPolicy(r.policy).ok)
    && [...s.shares, ...s.receipts].every(c => plain(c) && token(c.id) && group(c.conversationId) && stamp(c.at)
      && Array.isArray(c.itemIds) && c.itemIds.every(token) && Array.isArray(c.eventKeys) && c.eventKeys.every(token))
    && s.shares.every(c => ["pending", "sent", "uncertain", "cancelled"].includes(c.status))
    && Object.entries(s.callClaims).every(([id, c]) => token(id) && plain(c) && ["search", "filter"].includes(c.kind)
      && ["pending", "settled"].includes(c.status) && token(c.roundId) && typeof c.day === "string")
    && (s.history === undefined || (Array.isArray(s.history) && s.history.length <= HISTORY
      && s.history.every(h => plain(h) && token(h.id) && token(h.eventKey) && stamp(h.at))))
    && (s.days === undefined || (plain(s.days) && Object.keys(s.days).length <= LIMIT
      && Object.values(s.days).every(d => plain(d) && ["searchRequests", "filterCalls", "unknownUsageCalls", "providerToolCalls", "providerPageCalls"].every(k => integer(d[k])))))
    && (s.shareIds === undefined || (Array.isArray(s.shareIds) && s.shareIds.length <= FENCES && s.shareIds.every(token)))
    && (s.receiptIds === undefined || (Array.isArray(s.receiptIds) && s.receiptIds.length <= FENCES
      && s.receiptIds.every(c => plain(c) && token(c.id) && token(c.signature))));
}
function rootError(root, id) {
  if (!plain(root) || !logical(id)) return "invalid_args";
  if (own(root, "socialAgents") && (!plain(root.socialAgents) || root.socialAgents.version !== 1 || !plain(root.socialAgents.bots))) return "invalid_state";
  const bot = botAt(root, id);
  if (bot !== undefined && !plain(bot)) return "invalid_state";
  if (bot && own(bot, "discovery") && !validState(bot.discovery)) return "invalid_state";
  if (!bot && Object.keys(root.socialAgents?.bots || {}).length >= 64) return "backpressure";
  return "";
}
// Work on a detached discovery draft so all rejected mutations are atomic.
function write(root, args, fn, usage = false) {
  if (!plain(args) || !stamp(args.now)) return fail("invalid_args");
  const error = rootError(root, args.logicalId);
  if (error) return fail(error);
  const bot = botAt(root, args.logicalId);
  const s = bot?.discovery ? clone(bot.discovery) : emptyState();
  const runtime = usage ? clone(bot?.runtimeUsage || { days: {} }) : undefined;
  const result = fn(s, runtime);
  if (!result.ok) return result;
  root.socialAgents ??= { version: 1, bots: {} };
  const target = root.socialAgents.bots[args.logicalId] ??= {};
  target.discovery = s;
  if (usage) target.runtimeUsage = runtime;
  return result;
}
function stateAt(root, args) { return !rootError(root, args?.logicalId) ? botAt(root, args.logicalId)?.discovery : undefined; }
function policyAt(s, value) { return normalizeDiscoveryPolicy(value === undefined ? s?.policy : value); }
function topicAllowed(item, p) {
  const content = normalizedText([item.title, item.meaning, item.applicable, item.avoid].filter(Boolean).join(" "));
  return !p.blockedTopics.some(t => content.includes(normalizedText(t)));
}
function allowed(s, p, conversationId) { return p.enabled && !p.shadowMode && group(conversationId) && p.conversationIds.includes(conversationId); }
function blocked(s, item, conversationId) { return s.blocks.some(b => (b.id === item.id || b.eventKey === item.eventKey
  || b.urls?.some(url => item.sources.some(source => source.url === url)))
  && (!b.conversationId || b.conversationId === conversationId)); }
function recent(s, item, conversationId, now) {
  return s.receipts.some(r => r.conversationId === conversationId && r.eventKeys.includes(item.eventKey) && now - r.at < DAY)
    || s.shares.some(r => r.conversationId === conversationId && r.eventKeys.includes(item.eventKey)
      && ["pending", "uncertain", "sent"].includes(r.status) && now - r.at < DAY);
}
export function beginDiscoveryRound(root, args) {
  return write(root, args, s => {
    if (!token(args.roundId)) return fail("invalid_args");
    const v = validateDiscoveryPolicy(args.policy ?? s.policy);
    if (!v.ok) return v;
    const p = v.policy;
    if (!p.enabled || !p.conversationIds.length) return fail("disabled");
    if (!discoveryWindowAllowed(args.now)) return fail("outside_window");
    if (s.roundIds.includes(args.roundId) || s.roundIds.includes(hash(args.roundId))) return fail("round_replayed");
    if (s.rounds.some(r => r.status === "running")) return fail("round_running");
    if (s.rounds.filter(r => r.day === dayOf(args.now)).length >= p.maxRoundsPerDay) return fail("daily_limit");
    if (s.rounds.some(r => args.now - r.startedAt < p.minIntervalMs)) return fail("interval");
    if (!sweep(s, args.now) || s.roundIds.length >= FENCES || s.rounds.length >= HISTORY) return fail("backpressure");
    s.policy = p;
    s.roundIds.push(hash(args.roundId));
    s.rounds.push({ id: args.roundId, day: dayOf(args.now), startedAt: args.now, status: "running",
      searches: 0, filters: 0, maxSearches: p.maxSearchesPerRound, policy: p });
    return { ok: true, reason: "", roundId: args.roundId };
  });
}
export function reserveDiscoveryCall(root, args) {
  return write(root, args, (s, runtime) => {
    if (!["search", "filter"].includes(args.kind) || !token(args.roundId) || !integer(args.maxDailyCalls, 1, 10_000)) return fail("invalid_args");
    const r = s.rounds.find(r => r.id === args.roundId);
    if (!r || r.status !== "running") return fail("round_not_running");
    if (args.now < r.startedAt || args.now - r.startedAt >= fixed.timeoutMs) return fail("round_timeout");
    const key = args.kind === "search" ? "searches" : "filters";
    if (r[key] >= (args.kind === "search" ? r.maxSearches : 1)) return fail("round_call_limit");
    if (!plain(runtime) || !plain(runtime.days)) return fail("invalid_state");
    const day = dayOf(args.now);
    let daily = runtime.days[day];
    if (daily === undefined) daily = { reservedCalls: 0, actualCalls: 0, unknownUsageCalls: 0, inputTokens: 0, outputTokens: 0, pending: {} };
    if (!validDaily(daily)) return fail("invalid_state");
    if (daily.reservedCalls >= args.maxDailyCalls) return fail("daily_call_limit");
    if (Object.keys(s.callClaims).length >= LIMIT) return fail("backpressure");
    const claimId = `discovery:${hash(`${args.roundId}:${args.kind}:${r[key]}`)}`;
    if (own(daily.pending, claimId) || own(s.callClaims, claimId)) return fail("claim_replayed");
    daily.reservedCalls++;
    daily.pending[claimId] = { at: args.now };
    runtime.days[day] = daily;
    s.callClaims[claimId] = { day, kind: args.kind, roundId: args.roundId, at: args.now, status: "pending" };
    r[key]++;
    return { ok: true, claimId, day };
  }, true);
}
function validDaily(d) { return plain(d) && ["reservedCalls", "actualCalls", "unknownUsageCalls", "inputTokens", "outputTokens"].every(k => integer(d[k])) && plain(d.pending); }
function trustedUsage(u) { return plain(u) && integer(u.inputTokens) && integer(u.outputTokens); }
export function settleDiscoveryCall(root, args) {
  return write(root, args, (s, runtime) => {
    if (!token(args.claimId) || typeof args.invoked !== "boolean") return fail("invalid_args");
    const c = s.callClaims[args.claimId];
    if (!c || c.day !== args.day) return fail("unknown_claim");
    if (c.status === "settled") return { ok: true, duplicate: true };
    const daily = runtime?.days?.[c.day];
    if (!validDaily(daily) || !own(daily.pending, args.claimId)) return fail("invalid_state");
    const u = trustedUsage(args.usage) ? args.usage : trustedUsage(args.providerUsage) ? args.providerUsage : undefined;
    if (args.invoked && (daily.actualCalls === Number.MAX_SAFE_INTEGER || (!u && daily.unknownUsageCalls === Number.MAX_SAFE_INTEGER)
      || (u && (!integer(daily.inputTokens + u.inputTokens) || !integer(daily.outputTokens + u.outputTokens))))) return fail("usage_overflow");
    delete daily.pending[args.claimId];
    Object.assign(c, { status: "settled", invoked: args.invoked, settledAt: args.now, usageKnown: args.invoked ? !!u : null });
    if (args.invoked) {
      daily.actualCalls++;
      if (u) { daily.inputTokens += u.inputTokens; daily.outputTokens += u.outputTokens; }
      else daily.unknownUsageCalls++;
      s.usage ??= { search: 0, filter: 0, unknown: 0 };
      s.usage[c.kind]++;
      if (!u) s.usage.unknown++;
      s.days ??= {};
      if (!own(s.days, c.day) && Object.keys(s.days).length >= LIMIT) return fail("backpressure");
      const counts = s.days[c.day] ??= { searchRequests: 0, filterCalls: 0, unknownUsageCalls: 0, providerToolCalls: 0, providerPageCalls: 0 };
      if (!integer(counts[c.kind === "search" ? "searchRequests" : "filterCalls"] + 1)
        || (!u && !integer(counts.unknownUsageCalls + 1))) return fail("usage_overflow");
      counts[c.kind === "search" ? "searchRequests" : "filterCalls"]++;
      if (!u) counts.unknownUsageCalls++;
      // Host-only transport metadata, not a model-returned usage assertion.
      for (const [source, target] of [["toolCalls", "providerToolCalls"], ["pageCalls", "providerPageCalls"]]) {
        const count = args.providerUsage?.[source];
        if (integer(count)) {
          if (!integer(counts[target] + count)) return fail("usage_overflow");
          counts[target] += count;
        }
      }
    }
    return { ok: true };
  }, true);
}
function canonicalUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || risky.test(value)) return "";
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return "";
    // Public web evidence only; this is validation, NOT a network/SSRF firewall.
    if (!u.hostname.includes(".") || /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(u.hostname)
      || u.hostname.endsWith(".local") || u.hostname.startsWith("[")) return "";
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(?:utm_|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    return u.href;
  } catch { return ""; }
}
function candidate(value, now, p) {
  if (!plain(value) || !["expression", "news"].includes(value.kind) || !text(value.title, 180)
    || !text(value.meaning ?? "", 800, true) || !text(value.applicable ?? "", 400, true)
    || !text(value.avoid ?? "", 400, true) || !Number.isFinite(value.confidence) || value.confidence < 0.6 || value.confidence > 1
    || (value.uncertainty !== undefined && !text(value.uncertainty, 240, true))
    || (value.isTrending !== undefined && typeof value.isTrending !== "boolean")) return null;
  // Do not retain extra model fields (especially prompts, IDs or person memory).
  if (!topicAllowed(value, p)) return null;
  const raw = value.sources ?? value.source;
  if (!Array.isArray(raw) || !raw.length || raw.length > 8) return null;
  const sources = [];
  for (const source of raw) {
    if (!plain(source) || !text(source.title ?? "", 180, true)) return null;
    const url = canonicalUrl(source.url);
    if (!url) return null;
    const out = { url, title: (source.title || "").trim() };
    if (source.publishedAt !== undefined) {
      const at = typeof source.publishedAt === "string" ? Date.parse(source.publishedAt) : source.publishedAt;
      if (!stamp(at) || at > now) return null;
      out.publishedAt = at;
    }
    if (!sources.some(s => s.url === url)) sources.push(out);
  }
  const isTrending = value.isTrending === true;
  const ttl = value.kind === "news" ? DAY : isTrending ? 7 * DAY : 30 * DAY;
  const published = sources.flatMap(s => s.publishedAt === undefined ? [] : [s.publishedAt]);
  const origin = published.length ? Math.min(...published, now) : now;
  const expiresAt = origin + ttl;
  if (expiresAt <= now) return null;
  const title = value.title.trim(), eventKey = `event:${hash(normalizedText(title))}`;
  return { id: `discovery:${hash(eventKey)}`, eventKey, kind: value.kind, title,
    meaning: (value.meaning || "").trim(), applicable: (value.applicable || "").trim(), avoid: (value.avoid || "").trim(),
    sources, confidence: value.confidence, status: "active", expiresAt, collectedAt: now, isTrending,
    uncertainty: value.kind === "news" ? (value.uncertainty?.trim() || "公开检索摘要，尚未核验原始报道，不作为确定事实") : (value.uncertainty || "").trim(),
    verification: "unverified" };
}
function archiveItem(s, item, status, now) {
  s.history ??= [];
  s.history = s.history.filter(h => now - h.at < 30 * DAY);
  if (s.history.length >= HISTORY) return false;
  s.history.push({ id: item.id, eventKey: item.eventKey, kind: item.kind, title: item.title,
    expiresAt: item.expiresAt, collectedAt: item.collectedAt, uncertainty: item.uncertainty || "",
    verification: "unverified", status, at: now });
  return true;
}
function sweep(s, now) {
  for (const item of s.items.filter(i => i.expiresAt <= now || i.status !== "active")) {
    if (!archiveItem(s, item, item.status === "active" ? "expired" : item.status, now)) return false;
    s.items.splice(s.items.indexOf(item), 1);
  }
  if (s.history) s.history = s.history.filter(h => now - h.at < 30 * DAY);
  // Keep IDs permanently, but old round detail is dispensable. Last start is
  // retained as a monotonic interval fence even if the caller moves time back.
  const last = s.rounds.at(-1)?.id;
  s.rounds = s.rounds.filter(r => r.id === last || r.status === "running" || now - r.startedAt < 30 * DAY);
  // Calls cannot be reissued: their unique ID is derived from a permanently
  // fenced round ID + monotonically consumed per-kind ordinal. Late unfulfilled
  // pending claims remain settleable, even after restart or cancellation.
  for (const [id, c] of Object.entries(s.callClaims)) if (c.status === "settled" && now - c.settledAt >= 30 * DAY) delete s.callClaims[id];
  s.shareIds ??= [];
  for (const c of s.shares.filter(c => ["sent", "cancelled"].includes(c.status) && now - c.at >= 30 * DAY)) {
    if (s.shareIds.length >= FENCES) return false;
    s.shareIds.push(hash(c.id));
    s.shares.splice(s.shares.indexOf(c), 1);
  }
  s.receiptIds ??= [];
  for (const r of s.receipts.filter(r => now - r.at >= 30 * DAY)) {
    if (s.receiptIds.length >= FENCES) return false;
    s.receiptIds.push({ id: hash(r.id), signature: receiptSignature(r.conversationId, r.itemIds) });
    s.receipts.splice(s.receipts.indexOf(r), 1);
  }
  // Discovery summaries are not the social runtime's shared daily ledger.
  for (const day of Object.keys(s.days || {})) if (now - Date.parse(`${day}T00:00:00+08:00`) >= 31 * DAY
    && !Object.values(s.callClaims).some(c => c.day === day && c.status === "pending")) delete s.days[day];
  return true;
}
function similarNews(a, b) {
  if (a.kind !== "news" || b.kind !== "news" || Math.abs(a.collectedAt - b.collectedAt) >= DAY) return false;
  const na = normalizedText(a.title), nb = normalizedText(b.title);
  if (Math.min(na.length, nb.length) < 12) return false;
  // Never merge differing event numbers/dates. Require >=90% title-token
  // overlap and >=4 shared units: intentionally conservative, not semantics.
  const numbers = title => [...title.matchAll(/\d+/g)].map(m => m[0]).sort().join(",");
  if (numbers(na) !== numbers(nb)) return false;
  const units = title => {
    const words = title.normalize("NFKC").toLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]+/gu) || [];
    return new Set(words.flatMap(w => /\p{Script=Han}/u.test(w) ? Array.from({ length: Math.max(0, w.length - 1) }, (_, n) => w.slice(n, n + 2)) : [w]));
  };
  const x = units(a.title), y = units(b.title), shared = [...x].filter(t => y.has(t)).length;
  return shared >= 4 && shared / Math.max(x.size, y.size) >= 0.9;
}
export function finishDiscoveryRound(root, args) {
  return write(root, args, s => {
    if (!token(args.roundId) || !["complete", "cancelled", "failed"].includes(args.status)
      || (args.errorCode !== undefined && args.errorCode !== "" && (!token(args.errorCode) || args.errorCode.length > 80))
      || (args.items !== undefined && (!Array.isArray(args.items) || args.items.length > 300))) return fail("invalid_args");
    const r = s.rounds.find(r => r.id === args.roundId);
    if (!r || r.status !== "running") return fail("round_not_running");
    if (args.now < r.startedAt) return fail("invalid_time");
    if (args.status === "complete" && args.now - r.startedAt >= fixed.timeoutMs) return fail("round_timeout");
    if (!sweep(s, args.now)) return fail("backpressure");
    let accepted = 0, rejected = 0;
    for (const raw of args.status === "complete" ? args.items || [] : []) {
      const item = candidate(raw, args.now, r.policy);
      if (!item || blocked(s, item) || s.items.some(i => i.eventKey === item.eventKey || similarNews(i, item)
        || i.sources.some(source => item.sources.some(other => source.url === other.url)))) { rejected++; continue; }
      if (s.items.length >= 300) {
        const oldest = s.items.reduce((a, b) => a.collectedAt <= b.collectedAt ? a : b);
        if (!archiveItem(s, oldest, "evicted", args.now)) return fail("backpressure");
        s.items.splice(s.items.indexOf(oldest), 1);
      }
      s.items.push(item); accepted++;
    }
    Object.assign(r, { status: args.status, finishedAt: args.now, accepted, rejected, errorCode: args.errorCode || "" });
    return { ok: true, accepted, rejected };
  });
}
/** Read-only admin inventory, including bounded terminal summaries by default.
 * Unlike retrieval, this is not a prompt or send-authority projection. */
export function listDiscoveryItems(root, args = {}) {
  const s = stateAt(root, args);
  if (!s || !stamp(args.now)) return [];
  const p = policyAt(s, args.policy);
  if (args.conversationId !== undefined && !allowed(s, p, args.conversationId)) return [];
  const all = [...s.items.map(i => ({ ...i, status: i.expiresAt <= args.now ? "expired" : i.status })),
    ...(s.history || []).filter(h => args.now - h.at < 30 * DAY)];
  return clone(all.filter(i => (args.includeInactive !== false || i.status === "active")
    && (args.conversationId === undefined || !blocked(s, { ...i, sources: i.sources || [] }, args.conversationId))
    && (!args.status || i.status === args.status) && (!args.kind || i.kind === args.kind)
    && (!args.id || i.id === args.id)).slice(0, integer(args.limit, 1, HISTORY) ? args.limit : HISTORY));
}
function related(item, query) {
  const hay = normalizedText([item.title, item.meaning, item.applicable].join(" "));
  // Whole Latin words or contiguous CJK fragments only; no random character OR.
  const words = query.normalize("NFKC").toLowerCase().match(/[a-z0-9]{2,}|[\p{Script=Han}]{2,}/gu) || [];
  return words.some(w => /^[a-z0-9]+$/.test(w)
    ? new RegExp(`(?:^|[^a-z0-9])${w}(?:$|[^a-z0-9])`, "i").test([item.title, item.meaning, item.applicable].join(" "))
    : hay.includes(w) || (w.length >= 4 && [...hay.matchAll(/[\p{Script=Han}]{2,}/gu)].some(m => m[0].length >= 2 && w.includes(m[0]))));
}
export function retrieveDiscoveryItems(root, args = {}) {
  const s = stateAt(root, args);
  const p = policyAt(s, args.policy);
  if (!s || !stamp(args.now) || !text(args.query, 1000) || !allowed(s, p, args.conversationId)) return [];
  const limit = integer(args.limit, 1, 3) ? args.limit : 3;
  return clone(s.items.filter(i => i.status === "active" && i.expiresAt > args.now && !blocked(s, i, args.conversationId) && topicAllowed(i, p)
    && (args.repeatAllowed === true || !recent(s, i, args.conversationId, args.now)) && related(i, args.query))
    .sort((a, b) => b.confidence - a.confidence || b.collectedAt - a.collectedAt).slice(0, limit));
}
export function feedbackDiscoveryItem(root, args) {
  return write(root, args, s => {
    if (!token(args.id) || !["block", "delete", "expire", "dislike"].includes(args.action)
      || (args.conversationId !== undefined && !group(args.conversationId))
      || (args.action === "dislike" && !group(args.conversationId))) return fail("invalid_args");
    const item = s.items.find(i => i.id === args.id);
    const existing = s.blocks.find(b => b.id === args.id && (args.action !== "dislike" ? !b.conversationId : b.conversationId === args.conversationId));
    if (existing && ["block", "dislike"].includes(args.action)) return { ok: true, duplicate: true };
    if (!item) return fail("unknown_item");
    if (["block", "dislike"].includes(args.action)) {
      if (s.blocks.length >= LIMIT) return fail("backpressure");
      s.blocks.push({ id: item.id, eventKey: item.eventKey, at: args.now,
        urls: item.sources.map(source => source.url),
        ...(args.action === "dislike" ? { conversationId: args.conversationId } : {}) });
      if (args.action === "dislike") return { ok: true };
    }
    if (!archiveItem(s, item, args.action === "block" ? "blocked" : args.action === "delete" ? "deleted" : "expired", args.now)) return fail("backpressure");
    s.items.splice(s.items.indexOf(item), 1);
    return { ok: true };
  });
}
function selected(s, args) {
  if (!Array.isArray(args.itemIds) || args.itemIds.length < 1 || args.itemIds.length > 3 || args.itemIds.some(id => !token(id))
    || new Set(args.itemIds).size !== args.itemIds.length) return null;
  const items = args.itemIds.map(id => s.items.find(i => i.id === id));
  return items.every(i => i && i.status === "active" && i.expiresAt > args.now && !blocked(s, i, args.conversationId)) ? items : null;
}
function receipt(s, args, items) {
  if (s.receipts.length >= LIMIT) return fail("backpressure");
  s.receipts.push({ id: args.receiptId, conversationId: args.conversationId, itemIds: items.map(i => i.id),
    eventKeys: items.map(i => i.eventKey), at: args.now });
  return { ok: true };
}
function receiptSignature(conversationId, itemIds) { return hash(JSON.stringify([conversationId, itemIds])); }
export function markDiscoveryUsed(root, args) {
  return write(root, args, s => {
    if (!token(args.receiptId) || !group(args.conversationId)) return fail("invalid_args");
    const existing = s.receipts.find(r => r.id === args.receiptId);
    if (existing) return existing.conversationId === args.conversationId && JSON.stringify(existing.itemIds) === JSON.stringify(args.itemIds)
      ? { ok: true, duplicate: true } : fail("receipt_conflict");
    const old = s.receiptIds?.find(r => r.id === hash(args.receiptId));
    if (old) return old.signature === receiptSignature(args.conversationId, args.itemIds)
      ? { ok: true, duplicate: true } : fail("receipt_conflict");
    const p = policyAt(s, args.policy);
    if (!allowed(s, p, args.conversationId)) return fail("disabled");
    const items = selected(s, args);
    if (!items) return fail("invalid_items");
    if (items.some(i => !topicAllowed(i, p))) return fail("blocked_topic");
    return receipt(s, args, items);
  });
}
export function claimDiscoveryShare(root, args) {
  return write(root, args, s => {
    if (!token(args.claimId) || !group(args.conversationId)) return fail("invalid_args");
    const v = validateDiscoveryPolicy(args.policy ?? s.policy);
    if (!v.ok) return v;
    const p = v.policy;
    if (!allowed(s, p, args.conversationId)) return fail("disabled");
    if (!discoveryWindowAllowed(args.now, { sharing: true })) return fail("outside_window");
    if (s.shares.some(c => c.id === args.claimId) || s.shareIds?.includes(hash(args.claimId))) return fail("claim_replayed");
    const items = selected(s, args);
    if (!items) return fail("invalid_items");
    if (items.some(i => !topicAllowed(i, p))) return fail("blocked_topic");
    // Cancellation also consumes admission: wire may already have been reached.
    if (s.shares.filter(c => c.conversationId === args.conversationId && c.day === dayOf(args.now)).length >= p.maxSharesPerDay) return fail("daily_share_limit");
    if (s.shares.some(c => c.conversationId === args.conversationId && args.now - c.at < p.shareCooldownMs)) return fail("share_cooldown");
    if (items.some(i => recent(s, i, args.conversationId, args.now))) return fail("event_reuse");
    if (s.shares.length >= LIMIT) return fail("backpressure");
    s.shares.push({ id: args.claimId, conversationId: args.conversationId, itemIds: items.map(i => i.id),
      eventKeys: items.map(i => i.eventKey), day: dayOf(args.now), at: args.now, status: "pending" });
    return { ok: true, claimId: args.claimId };
  });
}
export function settleDiscoveryShare(root, args) {
  return write(root, args, s => {
    if (!token(args.claimId) || !["sent", "uncertain", "cancelled"].includes(args.status)) return fail("invalid_args");
    const c = s.shares.find(c => c.id === args.claimId);
    if (!c) return fail("unknown_claim");
    if (c.status === args.status) return { ok: true, duplicate: true };
    if (c.status !== "pending") return fail("claim_settled");
    if (args.status === "sent") {
      if (args.receiptIds !== undefined) {
        if (!Array.isArray(args.receiptIds) || !args.receiptIds.length || args.receiptIds.length > 4
          || new Set(args.receiptIds).size !== args.receiptIds.length) return fail("invalid_receipts");
        const receipts = args.receiptIds.map(id => s.receipts.find(row => row.id === id));
        if (receipts.some(row => !row || row.conversationId !== c.conversationId)) return fail("invalid_receipts");
        const actual = [...new Set(receipts.flatMap(row => row.itemIds))].sort();
        if (JSON.stringify(actual) !== JSON.stringify([...c.itemIds].sort())) return fail("invalid_receipts");
        Object.assign(c, { status: args.status, settledAt: args.now });
        return { ok: true };
      }
      const existing = s.receipts.find(r => r.id === c.id);
      if (existing && (existing.conversationId !== c.conversationId || JSON.stringify(existing.itemIds) !== JSON.stringify(c.itemIds))) return fail("receipt_conflict");
      const result = existing ? { ok: true } : receipt(s, { receiptId: c.id, conversationId: c.conversationId, now: args.now },
        c.itemIds.map((id, i) => ({ id, eventKey: c.eventKeys[i] })));
      if (!result.ok) return result;
    }
    Object.assign(c, { status: args.status, settledAt: args.now });
    return { ok: true };
  });
}
export function recoverDiscoveryState(root, { now } = {}) {
  if (!plain(root) || !stamp(now) || (own(root, "socialAgents") && (!plain(root.socialAgents)
    || root.socialAgents.version !== 1 || !plain(root.socialAgents.bots)))) return fail("invalid_state");
  const targets = Object.entries(root.socialAgents?.bots || {}).filter(([, b]) => own(b, "discovery"));
  if (targets.some(([id, b]) => !logical(id) || !validState(b.discovery))) return fail("invalid_state");
  let rounds = 0, shares = 0;
  for (const [, bot] of targets) {
    for (const r of bot.discovery.rounds) if (r.status === "running") { r.status = "interrupted"; r.finishedAt = now; rounds++; }
    for (const c of bot.discovery.shares) if (c.status === "pending") { c.status = "uncertain"; c.settledAt = now; shares++; }
  }
  return { ok: true, rounds, shares };
}
export function discoveryStatus(root, args = {}) {
  const s = stateAt(root, args) || emptyState();
  const emptyToday = { rounds: 0, searchRequests: 0, filterCalls: 0, unknownUsageCalls: 0, providerToolCalls: 0, providerPageCalls: 0 };
  if (!stamp(args.now)) return { version: 1, enabled: false, shadowMode: true, activeItems: 0, roundsToday: 0,
    sharesToday: 0, today: emptyToday, lastRound: null, nextEligibleAt: null };
  const p = policyAt(s, args.policy);
  const last = s.rounds.at(-1);
  const roundsToday = s.rounds.filter(r => r.day === dayOf(args.now)).length;
  let nextEligibleAt = p.enabled && p.conversationIds.length ? Math.max(args.now, (last?.startedAt || 0) + p.minIntervalMs) : null;
  if (nextEligibleAt !== null && roundsToday >= p.maxRoundsPerDay) {
    const midnight = new Date(`${dayOf(args.now)}T00:00:00+08:00`).getTime();
    nextEligibleAt = Math.max(nextEligibleAt, midnight + DAY);
  }
  // Windows have whole-hour boundaries; jumping to the next boundary is exact.
  if (nextEligibleAt !== null && !stamp(nextEligibleAt)) nextEligibleAt = null;
  while (nextEligibleAt !== null && !discoveryWindowAllowed(nextEligibleAt)) {
    nextEligibleAt = Math.floor(nextEligibleAt / HOUR) * HOUR + HOUR;
    if (!stamp(nextEligibleAt)) nextEligibleAt = null;
  }
  return { version: 1, enabled: p.enabled, shadowMode: p.shadowMode,
    activeItems: s.items.filter(i => i.status === "active" && i.expiresAt > args.now && !blocked(s, i)).length,
    roundsToday,
    today: { ...emptyToday, ...clone(s.days?.[dayOf(args.now)] || {}), rounds: roundsToday },
    lastRound: last ? { id: last.id, status: last.status, startedAt: last.startedAt, finishedAt: last.finishedAt ?? null,
      accepted: last.accepted ?? 0, rejected: last.rejected ?? 0 } : null,
    nextEligibleAt,
    sharesToday: s.shares.filter(c => c.day === dayOf(args.now)).length,
    running: s.rounds.some(r => r.status === "running"), blocks: s.blocks.length,
    usage: clone(s.usage || { search: 0, filter: 0, unknown: 0 }) };
}
