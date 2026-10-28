import { randomUUID } from "node:crypto";
import { normalizeDiscoveryPolicy, discoveryWindowAllowed, beginDiscoveryRound, reserveDiscoveryCall,
  settleDiscoveryCall, finishDiscoveryRound, listDiscoveryItems } from "./social-discovery-state.js";

// Adapters, never model JSON, attach billing evidence through this identity map.
const receipts = new WeakMap();
const plain = x => x !== null && typeof x === "object" && !Array.isArray(x)
  && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const uint = x => Number.isSafeInteger(x) && x >= 0;
const copy = x => structuredClone(x);
const error = code => Object.assign(new Error(code), { code });
const CODES = new Set(["DISCOVERY_DISABLED", "DISCOVERY_CANCELLED", "DISCOVERY_TIMEOUT", "DISCOVERY_STALE",
  "DISCOVERY_NOT_IDLE", "DISCOVERY_WINDOW_CLOSED", "DISCOVERY_UNAVAILABLE", "DISCOVERY_INVALID_RESULT",
  "DISCOVERY_PERSISTENCE_FAILED", "DISCOVERY_BUDGET_EXHAUSTED", "DISCOVERY_INTERVAL", "DISCOVERY_DAILY_LIMIT",
  "DISCOVERY_INVALID_CONTEXT", "DISCOVERY_BUSY", "DISCOVERY_FAILED", "DISCOVERY_NO_ELIGIBLE_INTERESTS"]);
const safeCode = e => CODES.has(e?.code) ? e.code : "DISCOVERY_FAILED";
const scopeOf = ctx => ({ logicalId: ctx.logicalId, accountId: ctx.accountId, revision: ctx.revision });
const stateCode = reason => ({ disabled: "DISCOVERY_DISABLED", outside_window: "DISCOVERY_WINDOW_CLOSED",
  daily_call_limit: "DISCOVERY_BUDGET_EXHAUSTED", interval: "DISCOVERY_INTERVAL", daily_limit: "DISCOVERY_DAILY_LIMIT",
  round_running: "DISCOVERY_BUSY", round_timeout: "DISCOVERY_TIMEOUT" })[reason] || "DISCOVERY_PERSISTENCE_FAILED";
export function withSocialDiscoveryUsage(result, usage) {
  if (!plain(result) || !plain(usage) || !uint(usage.inputTokens) || !uint(usage.outputTokens)) throw error("DISCOVERY_INVALID_RESULT");
  receipts.set(result, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
  return result;
}
const day = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
// Only short administrator-configured public topic tags are query inputs.
// Never project root memory, conversations, identifiers or arbitrary ctx fields.
function queries(policy, time, allowDefaults = true) {
  const tags = (Array.isArray(policy.interests) ? policy.interests : [])
    .filter(x => typeof x === "string" && /^[\p{L}][\p{L}\p{N} ·-]{0,23}$/u.test(x)
      && !/\d{5}|私聊|群聊|聊天|QQ|微信|用户|密码|token|secret|ignore|instruction/i.test(x));
  const topics = tags.length ? [...new Set(tags)] : allowDefaults ? ["新奇巧妙的梗 游戏", "科技 趣闻", "生活 创意"] : [];
  return topics.slice(0, Math.min(3, policy.maxSearchesPerRound)).map(x => `${day(time)} ${x} 公开资讯`);
}
function publicUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port
      || !url.hostname.includes(".") || /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(url.hostname)
      || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) return null;
    return url.href;
  } catch { return null; }
}
function cleanText(value, max) { return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : ""; }
function evidenceFrom(raw) {
  if (!plain(raw) || (raw.searched !== undefined && raw.searched !== true)
    || !Array.isArray(raw.results) || !cleanText(raw.provider, 80)) throw error("DISCOVERY_INVALID_RESULT");
  const results = []; let validRows = 0;
  for (const row of raw.results.slice(0, 30)) {
    if (!plain(row)) continue;
    const link = publicUrl(row.link), title = cleanText(row.title, 500);
    // Official plugin citations often contain no per-link snippet. Its actual
    // searched answer is secondary evidence, never a verified original report.
    const snippet = cleanText(row.snippet || (raw.provider === "mimo-web-search" && raw.searched === true
      ? raw.answer : ""), 2000);
    if (!link || !title) continue;
    validRows++;
    // A title is not enough context for a grounded extraction. It is still a
    // legitimate hit, so continue the round rather than treating it as outage.
    if (!snippet) continue;
    const publishedAt = typeof row.publishedAt === "string" && Number.isFinite(Date.parse(row.publishedAt)) ? row.publishedAt : null;
    results.push({ link, title, snippet, provider: cleanText(raw.provider, 80), ...(publishedAt ? { publishedAt } : {}) });
  }
  if (raw.results.length && !validRows) throw error("DISCOVERY_INVALID_RESULT");
  return results;
}

/**
 * Pure callback runtime; one shared instance across all accounts. Parent owns
 * idle-60s qualification, routes, quiet/control revisions and scheduling.
 * getPolicy(ctx) returns the normalized discovery block plus maxDailyCalls;
 * discovery.enabled is independent of the conversational social-agent switch.
 * transact(syncBuilder) resolves only after durable publication; getRoot is its
 * current published root, never a model input. isCurrent/isIdle are synchronous.
 * search(ctx, publicQuery, {signal}) returns {provider,searched?,results:[
 *   {title,link,snippet,publishedAt?}]}; synthesized answer text is never retained.
 * filter(ctx,{results,policy},{signal}) returns {items:[{kind:'news'|'expression',
 *   title,meaning?,applicable?,avoid?,uncertainty?,confidence,sources:[{url}],isTrending?}]}.
 * Host search evidence, not model provenance, supplies source metadata. Search
 * and filter each reserve the same social runtimeUsage.days budget. JSON usage
 * is untrusted; adapters may attach withSocialDiscoveryUsage for token counts.
 * Only search callback transport toolUsage/pageUsage are passed to state as
 * providerUsage.toolCalls/pageCalls; filter/model JSON can never supply them.
 * Host ctx is shallow frozen, preserving opaque identity/ws references. It is
 * passed only to host callbacks, never spread into state or model payloads.
 * onCollected(ctx,{itemIds,signal}) is a wake hook only, never send permission.
 * Every adapter must honor abort and independently guard real wire operations.
 * Callback awaits are raced even when adapters ignore cancellation. No retry,
 * startup replay or scheduling timer is created; guards exist only during run.
 */
export function createSocialDiscoveryRuntime({ getPolicy, getRoot, transact, isCurrent, isIdle, search, filter,
  onCollected, allowDefaultTopics = () => true, clock = Date.now } = {}) {
  if ([getPolicy, getRoot, transact, isCurrent, isIdle].some(x => typeof x !== "function")) throw error("DISCOVERY_INVALID_CALLBACK");
  const now = typeof clock === "function" ? clock : () => clock.now();
  const setTimer = clock.setTimeout?.bind(clock) || setTimeout;
  const clearTimer = clock.clearTimeout?.bind(clock) || clearTimeout;
  let active = null, lastErrorCode = "";
  function policyFor(ctx) {
    const raw = getPolicy(ctx);
    const { maxDailyCalls: supplied, ...discovery } = plain(raw) ? raw : {};
    const policy = normalizeDiscoveryPolicy(discovery);
    if (!policy.enabled || !policy.conversationIds.length) throw error("DISCOVERY_DISABLED");
    const maxDailyCalls = supplied === undefined ? 1000 : supplied;
    if (!uint(maxDailyCalls) || maxDailyCalls < 1 || maxDailyCalls > 10000) throw error("DISCOVERY_BUDGET_EXHAUSTED");
    return { ...policy, maxDailyCalls };
  }
  function guard(job) {
    if (job.controller.signal.aborted) throw error(job.reason || "DISCOVERY_CANCELLED");
    if (now() >= job.deadline) throw error("DISCOVERY_TIMEOUT");
    const p = policyFor(job.ctx);
    if (isCurrent(job.ctx) !== true) throw error("DISCOVERY_STALE");
    if (isIdle(job.ctx) !== true) throw error("DISCOVERY_NOT_IDLE");
    if (!discoveryWindowAllowed(now())) throw error("DISCOVERY_WINDOW_CLOSED");
    return p;
  }
  function stop(job, code) { job.reason = code; job.controller.abort(); }
  async function bounded(job, invoke, accounting = false) {
    if (!accounting) guard(job);
    let abort, timer;
    const interrupt = new Promise((_, reject) => {
      abort = () => reject(error(job.reason || "DISCOVERY_CANCELLED"));
      if (!accounting) job.controller.signal.addEventListener("abort", abort, { once: true });
      timer = setTimer(() => reject(error("DISCOVERY_TIMEOUT")), accounting ? 1000 : Math.max(0, job.deadline - now()));
    });
    try {
      const result = await Promise.race([Promise.resolve().then(() => {
        if (!accounting) guard(job);
        return invoke();
      }), interrupt]);
      if (!accounting) guard(job);
      return result;
    } finally { clearTimer(timer); job.controller.signal.removeEventListener("abort", abort); }
  }
  async function write(job, build, accounting = false) {
    try {
      return await bounded(job, () => transact(root => {
        if (!accounting) guard(job);
        const result = build(root);
        if (result?.ok !== true) throw error(stateCode(result?.reason));
        return result;
      }), accounting);
    } catch (e) {
      if (CODES.has(e?.code)) throw e;
      throw error("DISCOVERY_PERSISTENCE_FAILED");
    }
  }
  const args = job => {
    const { maxDailyCalls, ...policy } = policyFor(job.ctx);
    return { ...scopeOf(job.ctx), now: now(), policy, maxDailyCalls, roundId: job.roundId };
  };
  async function call(job, kind, invoke) {
    const claim = await write(job, root => reserveDiscoveryCall(root, { ...args(job), kind }));
    let started = false, usage, providerUsage, raw;
    try {
      raw = await bounded(job, () => { started = true; return invoke(); });
      usage = plain(raw) ? receipts.get(raw) : undefined;
      if (plain(raw)) receipts.delete(raw);
      if (kind === "search" && plain(raw)) {
        providerUsage = { ...(uint(raw.toolUsage) ? { toolCalls: raw.toolUsage } : {}),
          ...(uint(raw.pageUsage) ? { pageCalls: raw.pageUsage } : {}) };
      }
      return raw;
    } finally {
      // Accounting may finish after cancellation, but never accepts late content.
      await write(job, root => settleDiscoveryCall(root, { ...scopeOf(job.ctx), now: now(), roundId: job.roundId,
        claimId: claim.claimId, day: claim.day, invoked: started, usage, providerUsage }), true);
    }
  }
  async function execute(job) {
    let timer, poll;
    const watch = () => {
      try { guard(job); poll = setTimer(watch, 1000); }
      catch (e) { stop(job, safeCode(e)); }
    };
    try {
      guard(job);
      if (typeof search !== "function" || typeof filter !== "function") throw error("DISCOVERY_UNAVAILABLE");
      timer = setTimer(() => stop(job, "DISCOVERY_TIMEOUT"), 180000);
      poll = setTimer(watch, 1000);
      const begun = await write(job, root => beginDiscoveryRound(root, args(job)));
      job.roundId = begun.roundId;
      job.claimed = true;
      if (typeof job.roundId !== "string" || !job.roundId) throw error("DISCOVERY_PERSISTENCE_FAILED");
      const results = [];
      const selectedQueries = queries(guard(job), now(), allowDefaultTopics(job.ctx) === true);
      if (!selectedQueries.length) throw error("DISCOVERY_NO_ELIGIBLE_INTERESTS");
      for (const query of selectedQueries) {
        if (!queries(guard(job), now(), allowDefaultTopics(job.ctx) === true).includes(query)) throw error("DISCOVERY_STALE");
        const raw = await call(job, "search", () => search(job.ctx, query, { signal: job.controller.signal }));
        results.push(...evidenceFrom(raw));
      }
      let items = [];
      if (results.length) {
        const filtered = await call(job, "filter", () => filter(job.ctx,
          { results: copy(results), policy: copy(guard(job)) }, { signal: job.controller.signal }));
        items = groundedItems(filtered, results);
      }
      const finished = await write(job, root => {
        const scope = args(job);
        const before = new Set(listDiscoveryItems(root, scope).map(x => x.id));
        const result = finishDiscoveryRound(root, { ...scope, status: "complete", items });
        return { ...result, itemIds: result.ok ? listDiscoveryItems(root, scope).filter(x => !before.has(x.id)).map(x => x.id) : [] };
      });
      job.complete = true;
      // A failed wake must never rewrite a successfully completed round.
      try {
        if (!guard(job).shadowMode && typeof onCollected === "function" && finished.itemIds?.length) {
          await bounded(job, () => onCollected(job.ctx, { itemIds: [...finished.itemIds], signal: job.controller.signal }));
        }
      } catch (e) { lastErrorCode = safeCode(e); }
      return { ok: true, code: "DISCOVERY_COMPLETED", roundId: job.roundId };
    } catch (e) {
      const code = safeCode(e);
      lastErrorCode = code;
      stop(job, code);
      // A cancellation can race the publication await. Inspect only the exact
      // host-owned claim, never use getRoot as query/model input or mutate it.
      if (!job.claimed) {
        try { job.claimed = getRoot()?.socialAgents?.bots?.[job.ctx.logicalId]?.discovery?.rounds
          ?.some(round => round.id === job.roundId) === true; } catch { /* publication remains uncertain */ }
      }
      try {
        if (getRoot()?.socialAgents?.bots?.[job.ctx.logicalId]?.discovery?.rounds
          ?.some(round => round.id === job.roundId && round.status === "complete")) job.complete = true;
      } catch { /* retain the durable claim fence on uncertain publication */ }
      if (job.complete) return { ok: true, code: "DISCOVERY_COMPLETED", roundId: job.roundId };
      if (job.claimed && !job.complete) {
        try { await write(job, root => finishDiscoveryRound(root, { ...scopeOf(job.ctx), now: now(), roundId: job.roundId,
          status: ["DISCOVERY_CANCELLED", "DISCOVERY_STALE", "DISCOVERY_NOT_IDLE", "DISCOVERY_DISABLED", "DISCOVERY_WINDOW_CLOSED"].includes(code)
            ? "cancelled" : "failed", errorCode: code, items: [] }), true); }
        catch { lastErrorCode = "DISCOVERY_PERSISTENCE_FAILED"; }
      }
      return { ok: false, code: lastErrorCode, ...(job.claimed ? { roundId: job.roundId } : {}) };
    } finally {
      clearTimer(timer); clearTimer(poll);
      if (active === job) active = null;
    }
  }
  function run(ctx) {
    if (active) return Promise.resolve({ ok: false, code: "DISCOVERY_BUSY" });
    if (!plain(ctx) || !/^(account|group):[A-Za-z0-9_.:-]{1,100}$/.test(ctx.logicalId)
      || typeof ctx.accountId !== "string" || !ctx.accountId || !(typeof ctx.revision === "string" || uint(ctx.revision))) {
      return Promise.resolve({ ok: false, code: "DISCOVERY_INVALID_CONTEXT" });
    }
    const job = { ctx: Object.freeze({ ...ctx }),
      controller: new AbortController(), deadline: now() + 180000, roundId: `discovery:${randomUUID()}` };
    active = job; lastErrorCode = "";
    return execute(job);
  }
  function cancel(logicalId) {
    const job = active;
    if (!job || (logicalId !== undefined && job.ctx.logicalId !== logicalId)) return { cancelled: 0 };
    stop(job, "DISCOVERY_CANCELLED"); return { cancelled: 1 };
  }
  return { run, cancel, status: () => ({ running: active !== null,
    ...(active ? { logicalId: active.ctx.logicalId, ...(active.claimed ? { roundId: active.roundId } : {}) } : {}), lastErrorCode }) };
}

function groundedItems(raw, evidence) {
  if (!plain(raw) || !Array.isArray(raw.items) || raw.items.length > 12) throw error("DISCOVERY_INVALID_RESULT");
  const byUrl = new Map(evidence.map(x => [x.link, x]));
  return raw.items.map(item => {
    if (!plain(item) || Object.keys(item).some(k => !["kind", "title", "meaning", "applicable", "avoid", "uncertainty", "confidence", "sources",
      "isTrending", "id", "eventKey", "collectedAt", "createdAt", "updatedAt", "expiresAt"].includes(k))
      || !["expression", "news"].includes(item.kind)
      || !cleanText(item.title, 180) || item.title.length > 180
      || !Number.isFinite(item.confidence) || item.confidence < 0.6 || item.confidence > 1
      || ["meaning", "applicable", "avoid"].some(k => item[k] !== undefined && typeof item[k] !== "string")
      || (item.uncertainty !== undefined && (typeof item.uncertainty !== "string" || item.uncertainty.length > 240))
      || !Array.isArray(item.sources) || !item.sources.length || item.sources.length > 8) throw error("DISCOVERY_INVALID_RESULT");
    const sources = item.sources.map(source => {
      const url = publicUrl(typeof source === "string" ? source : source?.url ?? source?.link);
      const actual = byUrl.get(url);
      if (!actual || (plain(source) && Object.keys(source).some(k => !["url", "link", "title", "snippet", "provider", "publishedAt"].includes(k)))) throw error("DISCOVERY_INVALID_RESULT");
      // Metadata is copied exclusively from the host search result, not prose.
      if (plain(source) && ["provider", "publishedAt", "title", "snippet"].some(k => source[k] !== undefined && source[k] !== actual[k])) throw error("DISCOVERY_INVALID_RESULT");
      return { url: actual.link, title: actual.title.slice(0, 180), ...(actual.publishedAt ? { publishedAt: actual.publishedAt } : {}) };
    });
    if (item.provider !== undefined || item.publishedAt !== undefined || item.sourceType !== undefined) throw error("DISCOVERY_INVALID_RESULT");
    return { kind: item.kind, title: item.title, meaning: item.meaning || "", applicable: item.applicable || "",
      avoid: item.avoid || "", confidence: item.confidence, sources,
      ...(item.uncertainty === undefined ? {} : { uncertainty: item.uncertainty }),
      ...(item.isTrending === undefined ? {} : { isTrending: item.isTrending }) };
  });
}
