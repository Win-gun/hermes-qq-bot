import { createHash, randomUUID } from "node:crypto";
import { types } from "node:util";
import { QZONE_READ_ACTIONS, QZONE_WRITE_ACTIONS, validateQzonePolicy, isQzoneSafeText } from "./qzone-policy.js";

const DAY = 86400000, MAX_DRAFTS = 128, MAX_CLAIMS = 4096, MAX_BOTS = 32;
const MAX_IMAGES = 9, MAX_IMAGE_BYTES = 5 * 1024 * 1024, MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const fail = code => { throw new Error(code); };
const exact = (v, fields) => {
  if (!plain(v) || Object.keys(v).some(k => !fields.includes(k))) fail("QZONE_INPUT");
};
const safeId = v => typeof v === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(v)
  && !["__proto__", "constructor", "prototype"].includes(v);
const wireQq = v => typeof v === "string" && /^[1-9]\d{0,15}$/.test(v)
  && Number.isSafeInteger(Number(v)) && String(Number(v)) === v;
const tid = v => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const hash = v => createHash("sha256").update(v).digest("hex");
const canonical = s => s.normalize("NFKC").replace(/\s+/gu, " ").trim();
const day = at => new Date(at + 28800000).toISOString().slice(0, 10);
const success = raw => plain(raw) && raw.status === "ok" && raw.retcode === 0 && Object.hasOwn(raw, "data") && raw.data !== undefined;
const rejection = raw => plain(raw) && raw.status === "failed" && Number.isSafeInteger(raw.retcode) && raw.retcode !== 0;
const unsupported = raw => rejection(raw) && [404, 1404].includes(raw.retcode);
const sectionFor = kind => ({ publish: "publish", like: "likes", comment: "comments" })[kind];
const actionFor = kind => ({ publish: "send_qzone_msg", like: "like_qzone", comment: "comment_qzone" })[kind];
const freeze = obj => {
  for (const value of Object.values(obj)) if (value && typeof value === "object") freeze(value);
  return Object.freeze(obj);
};
function textProjection(value) {
  return (typeof value === "string" ? value : "").slice(0, 8192)
    .replace(/<[^>]*>/gu, " ").replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/giu, " ")
    .replace(/(?:https?:\/\/|file:\/\/|base64:\/\/)[^\s<>]+/giu, "[链接已移除]")
    .replace(/(?:api[_ -]?key|password|passwd|token|secret|验证码|密码)\s*[:=：]\s*\S+/giu, "[敏感信息已移除]")
    .replace(/\b(?:1[3-9]\d{9}|\d{15,19}[Xx]?)\b/gu, "[敏感信息已移除]")
    .replace(/(?:\/Users\/|\/home\/)[^\s]+|\d+号楼[^\s]*(?:室|单元)/gu, "[私密信息已移除]")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>]/gu, " ").trim().slice(0, 500);
}

/** Pure startup/restore transform. Parent must adopt result.memory ONLY inside
 * its sole-writer transaction. No input mutation, IO, authorization or replay.
 * Physical QQ owners are separate even when they share a logical failover ID. */
export function recoverQzoneState(memory, { reason, now: at } = {}) {
  if (!plain(memory) || !["restart", "backup_restore"].includes(reason)
    || !Number.isSafeInteger(at) || at < 0) fail("QZONE_RECOVERY_INPUT");
  if (memory.qzoneSocial === undefined) return { memory, changed: false, recovered: 0 };
  const state = structuredClone(memory.qzoneSocial);
  if (!plain(state) || state.version !== 1 || !plain(state.bots)) fail("QZONE_STATE_VERSION");
  let changed = false, recovered = 0;
  for (const bot of Object.values(state.bots)) {
    if (!plain(bot) || !plain(bot.owners)) fail("QZONE_STATE_SCOPE");
    for (const owner of Object.values(bot.owners)) {
      if (!plain(owner) || !plain(owner.drafts) || !plain(owner.capabilities)) fail("QZONE_STATE_SCOPE");
      let ownerChanged = false;
      for (const row of Object.values(owner.drafts)) {
        let touched = false;
        if (["publishing", "claimed"].includes(row.status)) {
          row.status = "uncertain"; row.reason = `QZONE_${reason.toUpperCase()}_NO_RETRY`;
          row.recoveredAt = at;
          owner.lastWriteAt[sectionFor(row.kind)] = Math.max(owner.lastWriteAt[sectionFor(row.kind)] || 0, at);
          recovered++; touched = true;
        } else if (row.status === "approved") {
          row.status = "review"; row.reason = "QZONE_FRESH_APPROVAL_REQUIRED";
          recovered++; touched = true;
        }
        for (const key of ["approval", "approvedBy", "approvedAt", "authorization", "lease", "writeProof"])
          if (Object.hasOwn(row, key)) { delete row[key]; touched = true; }
        if (touched) { row.revision++; changed = true; ownerChanged = true; }
      }
      for (const [action, proof] of Object.entries(owner.capabilities)) {
        if (proof.state === "unknown" && !proof.writeSettled) continue;
        owner.capabilities[action] = { state: "unknown", at,
          diagnosticPrevious: { state: proof.state, at: proof.at, protocolVersion: proof.protocolVersion } };
        changed = true;
        ownerChanged = true;
      }
      if (ownerChanged) owner.recoveryRevision = (owner.recoveryRevision || 0) + 1;
    }
  }
  return { memory: changed ? { ...memory, qzoneSocial: state } : memory, changed, recovered };
}

/** HOST ONLY, not model tools. All adapters except transact/request are strictly
 * synchronous. transact(builder) calls builder({memory: latestDraft}) once and
 * resolves ONLY after durable publication. No independent writer, timers or IO.
 *
 * capture(accountId) => {accountId,logicalId,qq:string,revision,policy,protocolVersion:string}.
 * isCurrent(ctx) must cover route, selected carrier/socket, login, policy/config
 * revisions and QZone stop/quiet. isAdministrator(ctx,actor) MUST authenticate the
 * ORIGINAL actor object (never trust actor's fields). peerQqs(ctx) => QQ strings.
 * isSourceAllowed(ctx, originalSource) => true only for an active host-attested
 * public source; omitted => false. Public inspiration can create a draft with
 * no actor but NEVER grants approval or a publish caller identity.
 *
 * request(ctx,action,exactParams,{signal,binding}) MUST recheck isCurrent() at
 * actual wire then call onSendStarted() exactly once and never retry. The hook is
 * synchronous, throws on reuse/revocation, and is required even for reads.
 * Read raw OneBot envelopes, not unwrapped data. A thrown request is uncertain.
 *
 * Optional resolveImage(ctx, id) is a synchronous HOST cache lookup, never IO or
 * a model tool. It receives only a runtime-validated opaque ID and must return
 * {id, sha256, provenance:"public", containsPrivateMaterial:false, immutable:true,
 * wireReference:"base64://<canonical base64 of cached image bytes>"}.
 * The host attests public provenance AND no private material (including embedded
 * metadata), pins immutable bytes to the ID/hash, and enforces account scope and
 * revocation on EVERY lookup. Cache/download/inspection happen before runtime
 * calls, outside the repository transaction. Runtime verifies the byte hash;
 * URLs/files are intentionally unsupported to avoid fetch/path TOCTOU and SSRF.
 * Limit: 9 unique IDs/byte hashes, 5 MiB/image, 20 MiB total. Throws, promises,
 * missing cache entries or changed attestations fail closed. No wire references
 * or bytes are persisted/exposed in draft views; preview resolves the same IDs
 * separately and must match stored hashes. Reads/status never invoke resolver.
 *
 * Only publish/like/comment are implemented. Other protected QZone writes have
 * no dispatch API. Feed/cursor handles live only in this context, expire and never get
 * persisted. No private_qzone text is passed to onEpisode or any group projector.
 * All returned drafts/status are detached views. Recover never sends or resumes.
 */
export function createQzoneRuntime({ capture, isCurrent, readState, transact, request,
  clock = Date.now, isAdministrator, peerQqs, onEpisode, isSourceAllowed = () => false, resolveImage } = {}) {
  for (const dep of [capture, isCurrent, readState, transact, request, clock, isAdministrator, peerQqs])
    if (typeof dep !== "function") fail("QZONE_HOST_CONTRACT");
  if (typeof isSourceAllowed !== "function" || onEpisode !== undefined && typeof onEpisode !== "function") fail("QZONE_HOST_CONTRACT");
  if (resolveImage !== undefined && typeof resolveImage !== "function") fail("QZONE_HOST_CONTRACT");
  const contexts = new WeakMap(), leases = new Map(), targets = new Map(), attempted = new Set(), freshDrafts = new Map();
  const poisoned = new Set(); // Uncertain repository failures cannot be retried in this instance.
  const now = () => {
    const t = clock();
    if (!Number.isSafeInteger(t) || t < 0 || t > 8640000000000000 - DAY) fail("QZONE_CLOCK");
    return t;
  };
  function info(ctx) {
    const c = contexts.get(ctx);
    if (!c) fail("QZONE_CONTEXT");
    return c;
  }
  function guard(ctx, signal, active = true) {
    const c = info(ctx);
    if (signal?.aborted || isCurrent(ctx) !== true) fail("QZONE_STALE_OR_ABORTED");
    if (active && !c.policy.enabled) fail("QZONE_DISABLED");
    return c;
  }
  function admin(ctx, actor) {
    if (!actor || typeof actor !== "object" || isAdministrator(ctx, actor) !== true) fail("QZONE_ACTOR");
  }
  function peers(ctx) {
    const list = peerQqs(ctx);
    if (!Array.isArray(list) || list.length > 100 || list.some(q => !wireQq(q))) fail("QZONE_PEERS");
    return list;
  }
  function book(root, c, create = false) {
    if (!plain(root) || !plain(root.memory)) fail("QZONE_REPOSITORY");
    let store = root.memory.qzoneSocial;
    if (store === undefined && create) store = root.memory.qzoneSocial = { version: 1, bots: {} };
    if (store === undefined) return undefined;
    if (!plain(store) || store.version !== 1 || !plain(store.bots)) fail("QZONE_STATE_VERSION");
    let logical = Object.hasOwn(store.bots, c.logicalId) ? store.bots[c.logicalId] : undefined;
    if (!logical && create) {
      if (Object.keys(store.bots).length >= MAX_BOTS) fail("QZONE_CAPACITY");
      logical = store.bots[c.logicalId] = { owners: {} };
    }
    if (!logical) return undefined;
    if (!plain(logical) || !plain(logical.owners)) fail("QZONE_STATE_SCOPE");
    let bot = Object.hasOwn(logical.owners, c.qq) ? logical.owners[c.qq] : undefined;
    if (!bot && create) {
      if (Object.keys(logical.owners).length >= 8) fail("QZONE_CAPACITY");
      bot = logical.owners[c.qq] = { owner: { accountId: c.accountId, qq: c.qq },
        drafts: {}, claims: {}, days: {}, capabilities: {}, lastReadAt: null, lastWriteAt: {} };
    }
    if (bot && (!plain(bot) || bot.owner?.accountId !== c.accountId || bot.owner?.qq !== c.qq
      || ![bot.drafts, bot.claims, bot.days, bot.capabilities, bot.lastWriteAt].every(plain))) fail("QZONE_STATE_SCOPE");
    return bot;
  }
  const currentBook = ctx => book(readState(), info(ctx));
  const rowFor = (bot, id) => {
    if (!safeId(id) || !bot || !Object.hasOwn(bot.drafts, id)) fail("QZONE_DRAFT_NOT_FOUND");
    return bot.drafts[id];
  };
  function cap(bot, c, action) {
    const value = bot?.capabilities[action];
    return value?.protocolVersion === c.protocolVersion
      && ["unknown", "supported", "unsupported", "temporarily_unavailable"].includes(value.state) ? value.state : "unknown";
  }
  function capability(bot, c, action, state, evidence = {}) {
    bot.capabilities[action] = { state, protocolVersion: c.protocolVersion, at: now(), ...evidence };
  }
  function draftView(row) {
    return structuredClone({ id: row.id, kind: row.kind, revision: row.revision, status: row.status,
      content: row.content, source: row.source, audience: row.audience,
      images: imageRecords(row).map(image => image.id), containsPrivateContent: row.source?.kind === "private_qzone" ? true : null,
      creationReason: row.creationReason || (row.kind === "publish" ? "管理员创建的文字草稿" : "管理员提交的互动提案"),
      protocolAccepted: row.protocolAccepted, clientVerified: row.clientVerified,
      ...(row.reason ? { reason: row.reason } : {}) });
  }
  function status(ctx) {
    const c = info(ctx), b = currentBook(ctx), counts = b?.days[day(now())] || {};
    const actions = [...QZONE_READ_ACTIONS, ...QZONE_WRITE_ACTIONS];
    return { enabled: c.policy.enabled, mode: c.policy.mode, current: isCurrent(ctx) === true,
      capabilities: Object.fromEntries(actions.map(a => [a, cap(b, c, a)])),
      daily: { reads: counts.reads || 0, publish: counts.publish || 0, likes: counts.likes || 0, comments: counts.comments || 0 },
      drafts: Object.values(b?.drafts || {}).map(draftView),
      images: resolveImage ? { supported: true, maxCount: MAX_IMAGES }
        : { supported: false, reason: "QZONE_HOST_IMAGE_RESOLVER_REQUIRED" },
      destructive: { supported: false, reason: "QZONE_DESTRUCTIVE_NOT_IMPLEMENTED" } };
  }
  function open(accountId) {
    if (!safeId(accountId)) fail("QZONE_ACCOUNT");
    const raw = capture(accountId);
    if (!plain(raw) || raw.accountId !== accountId || !safeId(raw.logicalId) || !wireQq(raw.qq)
      || !(safeId(raw.revision) || Number.isSafeInteger(raw.revision) && raw.revision >= 0)
      || typeof raw.protocolVersion !== "string" || !raw.protocolVersion.length || raw.protocolVersion.length > 128)
      fail("QZONE_CAPTURE");
    const ctx = freeze({ accountId, logicalId: raw.logicalId, qq: raw.qq, revision: raw.revision,
      policy: validateQzonePolicy(raw.policy), protocolVersion: raw.protocolVersion });
    contexts.set(ctx, { ...ctx, feeds: new Map(), cursors: new Map() });
    book(readState(), info(ctx)); // Offline UI can inspect only this captured QQ namespace.
    return ctx;
  }
  function countClaim(bot, section, limit, cooldown, at) {
    const current = bot.days[day(at)] || {};
    const last = section === "reads" ? bot.lastReadAt : bot.lastWriteAt[section];
    if ((current[section] || 0) >= limit || last != null && (at < last || at - last < cooldown)) fail("QZONE_BUDGET_OR_COOLDOWN");
    for (const key of Object.keys(bot.days)) if (key < day(Math.max(0, at - 6 * DAY))) delete bot.days[key];
    bot.days[day(at)] ||= {};
    bot.days[day(at)][section] = (current[section] || 0) + 1;
    if (section === "reads") bot.lastReadAt = at;
    else bot.lastWriteAt[section] = at;
  }
  function bindingFor(ctx, signal, extra = () => {}) {
    let started = false;
    const check = () => { guard(ctx, signal); extra(); if (started) fail("QZONE_WIRE_REUSE"); };
    return { binding: Object.freeze({
      isCurrent: () => { try { check(); return true; } catch { return false; } },
      onSendStarted: () => { check(); started = true; }
    }), started: () => started };
  }
  async function read(ctx, own, options = {}) {
    exact(options, own ? ["signal"] : ["signal", "cursor"]);
    const { signal, cursor } = options, c = guard(ctx, signal), p = c.policy.reads;
    if (!p[own ? "own" : "feeds"]) fail("QZONE_READ_DISABLED");
    const action = own ? "get_qzone_msg_list" : "get_qzone_feeds";
    const params = own ? { target_uin: Number(c.qq), pos: 0, num: p.count } : { count: p.count, page_num: 1 };
    if (cursor !== undefined) {
      const entry = c.cursors.get(cursor);
      if (!entry || now() < entry.at || now() - entry.at > p.ttlMs) fail("QZONE_CURSOR");
      delete params.page_num; params.cursor = entry.raw;
      c.cursors.delete(cursor);
    }
    if (poisoned.has(c.accountId)) fail("QZONE_DURABILITY_UNCERTAIN");
    try {
      await transact(root => {
        guard(ctx, signal);
        const b = book(root, c, true);
        if (cap(b, c, action) === "unsupported") fail("QZONE_UNSUPPORTED");
        countClaim(b, "reads", p.maxDaily, p.cooldownMs, now());
      });
    } catch (e) { throw e; }
    guard(ctx, signal);
    const wire = bindingFor(ctx, signal);
    let raw;
    try { raw = await request(ctx, action, freeze(params), { signal, binding: wire.binding }); }
    catch { guard(ctx, signal); fail("QZONE_READ_UNAVAILABLE"); }
    guard(ctx, signal);
    const valid = wire.started() && success(raw) && plain(raw.data)
      && Array.isArray(raw.data[own ? "msglist" : "feeds"])
      && raw.data[own ? "msglist" : "feeds"].length <= (own ? 100 : 50);
    await transact(root => {
      guard(ctx, signal);
      capability(book(root, c, true), c, action, valid ? "supported" : unsupported(raw) ? "unsupported" : "temporarily_unavailable");
    });
    guard(ctx, signal);
    if (!valid) fail("QZONE_READ_ENVELOPE");
    const at = now(), result = [], internal = [];
    for (const item of raw.data[own ? "msglist" : "feeds"]) {
      if (!plain(item) || !tid(item.tid)) continue;
      const uin = own ? c.qq : typeof item.uin === "number" && Number.isSafeInteger(item.uin) ? String(item.uin) : "";
      if (!wireQq(uin) || !Number.isSafeInteger(item.time) || item.time <= 0 || item.time * 1000 > at + 60000) continue;
      const id = `feed_${randomUUID()}`, content = textProjection(item.content);
      const complete = own ? typeof item.content === "string" : item.content_complete === true;
      const eventHash = hash(JSON.stringify([uin, item.tid, item.time]));
      const record = { id, tid: item.tid, uin, time: item.time, at, eventHash, own, complete,
        contentHash: typeof item.content === "string" && isQzoneSafeText(item.content) ? hash(item.content) : null,
        selfOnly: own && item.is_private === true };
      c.feeds.set(id, record);
      result.push({ id, content, source: "private_qzone", projectable: false, complete });
      internal.push(record);
    }
    for (const [id, record] of c.feeds) if (at < record.at || at - record.at > p.ttlMs) c.feeds.delete(id);
    while (c.feeds.size > 100) c.feeds.delete(c.feeds.keys().next().value);
    let nextCursor = null;
    if (!own && raw.data.has_more === true && typeof raw.data.next_cursor === "string"
      && raw.data.next_cursor.length > 0 && raw.data.next_cursor.length <= 65536) {
      nextCursor = `cursor_${randomUUID()}`;
      c.cursors.set(nextCursor, { raw: raw.data.next_cursor, at });
      for (const [key, entry] of c.cursors) if (at < entry.at || at - entry.at > p.ttlMs) c.cursors.delete(key);
      while (c.cursors.size > 4) c.cursors.delete(c.cursors.keys().next().value);
    }
    return { public: { feeds: result, cursor: nextCursor, source: "private_qzone", projectable: false }, internal };
  }
  const readFeeds = async (ctx, opts) => {
    const result = await read(ctx, false, opts); guard(ctx, opts?.signal); return result.public;
  };
  const readOwn = async (ctx, opts) => {
    const result = await read(ctx, true, opts); guard(ctx, opts?.signal); return result.public;
  };

  function targetFor(ctx, row, signal) {
    const c = guard(ctx, signal), target = targets.get(row.id);
    if (!target || target.ctx !== ctx || target.eventHash !== row.eventHash || !target.complete
      || now() < target.at || now() - target.at > c.policy.reads.freshnessMs
      || now() - target.time * 1000 > c.policy.reads.ttlMs
      || target.uin === c.qq || peers(ctx).includes(target.uin)) fail("QZONE_TARGET_STALE_OR_SCOPE");
    return target;
  }
  function imageIds(value = []) {
    if (!Array.isArray(value) || value.length > MAX_IMAGES
      || Array.from(value).some(id => !safeId(id)) || new Set(value).size !== value.length) fail("QZONE_IMAGES_INVALID");
    return [...value];
  }
  function imageRecords(row) {
    if (row.images === undefined) return []; // Legacy text-only drafts.
    if (!Array.isArray(row.images) || row.images.length > MAX_IMAGES) fail("QZONE_IMAGES_INVALID");
    for (const image of Array.from(row.images)) {
      if (!plain(image) || Object.keys(image).sort().join(",") !== "id,sha256"
        || typeof image.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(image.sha256)) fail("QZONE_IMAGES_INVALID");
    }
    imageIds(row.images.map(image => image.id));
    if (new Set(row.images.map(image => image.sha256)).size !== row.images.length) fail("QZONE_IMAGES_INVALID");
    return row.images;
  }
  // Only called outside transact builders. Base64 is the documented SnowLuma
  // images:string[] wire shape, not a OneBot image segment or a model URL.
  function resolveImages(ctx, ids) {
    imageIds(ids);
    if (ids.length && !resolveImage) fail("QZONE_HOST_IMAGE_RESOLVER_REQUIRED");
    let total = 0;
    return ids.map(id => {
      let image;
      try {
        const result = resolveImage(ctx, id);
        // Reject asynchronous adapters, also consuming a rejected native Promise
        // so a bad injection cannot cause an unhandled-rejection process exit.
        if (types.isPromise(result)) Promise.prototype.then.call(result, undefined, () => {});
        image = plain(result) && result.then === undefined ? { id: result.id, provenance: result.provenance,
          containsPrivateMaterial: result.containsPrivateMaterial, immutable: result.immutable,
          sha256: result.sha256, wireReference: result.wireReference } : null;
      } catch { fail("QZONE_IMAGE_UNAVAILABLE"); }
      if (!plain(image) || image.id !== id || image.provenance !== "public"
        || image.containsPrivateMaterial !== false || image.immutable !== true
        || typeof image.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(image.sha256)
        || typeof image.wireReference !== "string" || !image.wireReference.startsWith("base64://")) fail("QZONE_IMAGE_PROOF_REQUIRED");
      const encoded = image.wireReference.slice(9);
      if (!encoded.length || encoded.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)
        || encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) fail("QZONE_IMAGE_BYTES_INVALID");
      const bytes = Buffer.from(encoded, "base64");
      total += bytes.length;
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || total > MAX_TOTAL_IMAGE_BYTES
        || bytes.toString("base64") !== encoded || hash(bytes) !== image.sha256) fail("QZONE_IMAGE_HASH_OR_SIZE");
      return { id, sha256: image.sha256, wireReference: image.wireReference };
    });
  }
  function checkImages(ctx, row) {
    try {
      const records = imageRecords(row), resolved = resolveImages(ctx, records.map(image => image.id));
      if (resolved.some((image, i) => image.sha256 !== records[i].sha256)) fail("QZONE_IMAGE_CHANGED");
      return resolved;
    } catch (e) { leases.delete(row.id); throw e; }
  }
  const fingerprintFor = row => hash(JSON.stringify([row.kind, row.kind === "publish" ? canonical(row.content) : row.eventHash,
    ...(imageRecords(row).length ? [row.images.map(image => image.sha256)] : [])]));
  // Dedupe canonicalizes text, but approval binds EXACT text, source, audience
  // and ordered IDs/hashes, including on every final delivery-gate check.
  const confirmationFor = row => hash(JSON.stringify([row.kind, row.content, row.source.kind, row.source.ref,
    row.audience, row.eventHash ?? null, imageRecords(row).map(image => [image.id, image.sha256])]));
  async function makeDraft(ctx, input, actor, kind) {
    const c = guard(ctx);
    exact(input, kind === "publish" ? ["content", "source", "images", "audience", "creationReason"] : ["kind", "feedId", "content"]);
    const originalSource = input.source;
    const sourcePin = kind === "publish" ? { kind: originalSource?.kind, ref: originalSource?.ref } : null;
    const authorize = () => {
      if (sourcePin?.kind === "public_information") {
        if (input.source !== originalSource || originalSource.kind !== sourcePin.kind || originalSource.ref !== sourcePin.ref
          || isSourceAllowed(ctx, originalSource) !== true) fail("QZONE_SOURCE_PROOF_REQUIRED");
      } else admin(ctx, actor);
    };
    authorize();
    let source, audience, target, images = [];
    const content = kind === "like" ? "" : input.content;
    if (kind !== "like" && !isQzoneSafeText(content)) fail("QZONE_CONTENT_UNSAFE");
    if (input.creationReason !== undefined && !isQzoneSafeText(input.creationReason, 120)) fail("QZONE_CONTENT_UNSAFE");
    if (kind === "like" && input.content !== undefined && input.content !== "") fail("QZONE_INPUT");
    if (kind === "publish") {
      exact(input.source, ["kind", "ref"]);
      if (!["admin_topic", "public_information"].includes(input.source.kind) || !safeId(input.source.ref)
        || input.source.ref.length > 96) fail("QZONE_SOURCE");
      images = resolveImages(ctx, imageIds(input.images)).map(({ id, sha256 }) => ({ id, sha256 }));
      source = { kind: input.source.kind, ref: input.source.ref };
      audience = input.audience === undefined ? c.policy.ugcRight : input.audience;
      if (!c.policy.allowedAudiences.includes(audience)) fail("QZONE_AUDIENCE");
    } else {
      if (!["like", "comment"].includes(kind)) fail("QZONE_INPUT");
      const feed = c.feeds.get(input.feedId);
      if (!feed) fail("QZONE_FEED_HANDLE");
      target = { ...feed, ctx };
      source = { kind: "private_qzone", ref: `event_${feed.eventHash}` };
    }
    const id = `draft_${randomUUID()}`;
    const row = { id, kind, revision: 1, status: "draft", content, source,
      audience: audience ?? null, protocolAccepted: false, clientVerified: false, createdAt: now(),
      ...(images.length ? { images } : {}),
      ...(input.creationReason ? { creationReason: input.creationReason } : {}),
      ...(target ? { eventHash: target.eventHash } : {}) };
    if (target) {
      targets.set(id, target);
      try { targetFor(ctx, row); } catch (e) { targets.delete(id); throw e; }
    }
    imageRecords(row);
    const fingerprint = fingerprintFor(row);
    row.fingerprint = fingerprint;
    try {
      await transact(root => {
        guard(ctx); authorize();
        const b = book(root, c, true);
        if (Object.keys(b.drafts).length >= MAX_DRAFTS) fail("QZONE_CAPACITY");
        if (Object.hasOwn(b.claims, fingerprint)
          || Object.values(b.drafts).some(r => r.fingerprint === fingerprint) || attempted.has(`${c.logicalId}:${c.qq}:${fingerprint}`)) fail("QZONE_DUPLICATE");
        b.drafts[id] = structuredClone(row);
      });
      guard(ctx); authorize(); checkImages(ctx, row); freshDrafts.set(id, { ctx, source: originalSource });
      return draftView(rowFor(currentBook(ctx), id));
    } catch (e) { targets.delete(id); throw e; }
  }
  const createDraft = (ctx, input, actor) => makeDraft(ctx, input, actor, "publish");
  const proposeInteraction = (ctx, input, actor) => makeDraft(ctx, input, actor, input?.kind);
  function cas(row, revision) {
    if (!Number.isSafeInteger(revision) || revision < 1 || row.revision !== revision) fail("QZONE_REVISION");
  }
  async function transition(ctx, id, revision, actor, next) {
    const c = guard(ctx); admin(ctx, actor);
    const original = rowFor(currentBook(ctx), id);
    const confirmation = next === "approved" ? confirmationFor(original) : null;
    if (next === "approved") checkImages(ctx, original);
    let sourceProof;
    if (next === "approved" && original.source.kind === "public_information") {
      // Re-approval after recovery may re-attest the stored HOST ref. An
      // identity-only source adapter will refuse until it can provide proof;
      // an active-public-record adapter can explicitly re-attest it here.
      const fresh = freshDrafts.get(id);
      sourceProof = fresh?.ctx === ctx ? fresh.source : structuredClone(original.source);
    }
    const checkSource = row => {
      if (sourceProof && (sourceProof.kind !== row.source.kind || sourceProof.ref !== row.source.ref
        || isSourceAllowed(ctx, sourceProof) !== true)) fail("QZONE_SOURCE_PROOF_REQUIRED");
    };
    await transact(root => {
      guard(ctx); admin(ctx, actor);
      const row = rowFor(book(root, c), id); cas(row, revision);
      if (confirmation !== null && confirmationFor(row) !== confirmation) fail("QZONE_CONFIRMATION_CHANGED");
      checkSource(row);
      if (next === "review" ? row.status !== "draft" : !["review", "approved"].includes(row.status)) fail("QZONE_TRANSITION");
      row.status = next; row.revision++;
    });
    guard(ctx); admin(ctx, actor);
    const row = rowFor(currentBook(ctx), id);
    if (row.revision !== revision + 1 || row.status !== next) fail("QZONE_REVISION");
    checkSource(row);
    if (next === "approved") {
      if (confirmationFor(row) !== confirmation) fail("QZONE_CONFIRMATION_CHANGED");
      checkImages(ctx, row);
    }
    if (sourceProof) freshDrafts.set(id, { ctx, source: sourceProof });
    if (next === "approved") leases.set(id, { ctx, revision: row.revision, actor, confirmation });
    return draftView(row);
  }
  const submitReview = (ctx, id, revision, actor) => transition(ctx, id, revision, actor, "review");
  const approve = (ctx, id, revision, actor) => transition(ctx, id, revision, actor, "approved");

  function permission(ctx, row, actor, signal, claimed = false) {
    const c = guard(ctx, signal); admin(ctx, actor);
    if (poisoned.has(c.accountId)) fail("QZONE_DURABILITY_UNCERTAIN");
    const section = sectionFor(row.kind), action = actionFor(row.kind), b = currentBook(ctx);
    if (!action || !c.policy[section].enabled || c.policy.mode === "draft_only") fail("QZONE_WRITE_DISABLED");
    const support = cap(b, c, action);
    if (["unsupported", "temporarily_unavailable"].includes(support)) fail("QZONE_UNSUPPORTED");
    if (row.kind === "publish" && !c.policy.allowedAudiences.includes(row.audience)) fail("QZONE_AUDIENCE");
    if (row.source.kind === "public_information") {
      const fresh = freshDrafts.get(row.id);
      if (fresh?.ctx !== ctx || fresh.source.kind !== row.source.kind || fresh.source.ref !== row.source.ref
        || isSourceAllowed(ctx, fresh.source) !== true) fail("QZONE_SOURCE_PROOF_REQUIRED");
    }
    if (row.kind !== "publish") targetFor(ctx, row, signal);
    const lease = leases.get(row.id);
    if (lease?.ctx === ctx && lease.confirmation !== confirmationFor(row)) {
      leases.delete(row.id); fail("QZONE_CONFIRMATION_CHANGED");
    }
    const reviewed = lease?.ctx === ctx && lease.actor === actor
      && lease.revision === row.revision - (claimed ? 1 : 0);
    if (reviewed) {
      admin(ctx, lease.actor); // Explicit reviewed operation may bootstrap unknown.
      return;
    }
    const proof = b?.capabilities[action];
    if (c.policy.mode !== "scoped_autonomy" || !c.policy.autonomy.enabled || row.kind !== "publish"
      || freshDrafts.get(row.id)?.ctx !== ctx || imageRecords(row).length || row.audience === 1 || support !== "supported" || proof?.writeSettled !== true
      || row.content.length > c.policy.autonomy.maxContentLength
      || !c.policy.autonomy.sources.some(s => s.kind === row.source.kind && s.ref === row.source.ref && s.content === row.content))
      fail("QZONE_APPROVAL_REQUIRED");
  }
  async function publish(ctx, id, expectedRevision, options = {}) {
    exact(options, ["signal", "actor"]);
    const { signal, actor } = options, c = guard(ctx, signal), original = rowFor(currentBook(ctx), id);
    cas(original, expectedRevision); permission(ctx, original, actor, signal);
    checkImages(ctx, original);
    const confirmation = confirmationFor(original);
    if (!["approved", "draft"].includes(original.status)) fail("QZONE_TRANSITION");
    const key = `${c.logicalId}:${c.qq}:${original.fingerprint}`;
    if (attempted.has(key)) fail("QZONE_DUPLICATE");
    const claimId = `claim_${randomUUID()}`;
    let claimed;
    await transact(root => {
      guard(ctx, signal);
      const b = book(root, c), row = rowFor(b, id); cas(row, expectedRevision);
      if (confirmationFor(row) !== confirmation || fingerprintFor(row) !== row.fingerprint) fail("QZONE_CONFIRMATION_CHANGED");
      permission(ctx, row, actor, signal);
      if (!["approved", "draft"].includes(row.status) || Object.hasOwn(b.claims, row.fingerprint) || attempted.has(key)) fail("QZONE_DUPLICATE");
      if (Object.keys(b.claims).length >= MAX_CLAIMS || attempted.size >= MAX_CLAIMS) fail("QZONE_CAPACITY");
      const section = sectionFor(row.kind), p = c.policy[section];
      // One in-flight operation per physical QQ/kind. Cooldown restarts on
      // settlement, so a delayed transport cannot bunch reserved writes.
      if (Object.values(b.drafts).some(r => r.kind === row.kind && r.claimId
        && r.wireSettledAt == null && r.recoveredAt == null)) fail("QZONE_WRITE_IN_FLIGHT");
      countClaim(b, section, p.maxDaily, p.cooldownMs, now());
      attempted.add(key); // Consumed even if durable publication rejects/throws.
      b.claims[row.fingerprint] = { id: claimId, draftId: id, at: now(), action: actionFor(row.kind), protocolVersion: c.protocolVersion };
      row.status = "publishing"; row.revision++; row.claimId = claimId; row.claimedAt = now();
      row.recoveryRevision = b.recoveryRevision || 0;
      claimed = structuredClone(row);
    });
    const checkClaim = () => {
      const live = rowFor(currentBook(ctx), id);
      if (live.claimId !== claimId || live.status !== "publishing" || live.revision !== claimed.revision) fail("QZONE_CLAIM_REVOKED");
      if (confirmationFor(live) !== confirmation) fail("QZONE_CONFIRMATION_CHANGED");
      if (now() < claimed.claimedAt || now() - claimed.claimedAt > 60000
        || day(now()) !== day(claimed.claimedAt)) fail("QZONE_CLAIM_EXPIRED");
      permission(ctx, live, actor, signal, true);
      checkImages(ctx, live);
    };
    const wire = bindingFor(ctx, signal, checkClaim);
    let raw, reason;
    try {
      guard(ctx, signal); checkClaim();
      const target = claimed.kind === "publish" ? null : targetFor(ctx, claimed, signal);
      const params = claimed.kind === "publish" ? { content: claimed.content, ugc_right: claimed.audience }
        : claimed.kind === "like" ? { tid: target.tid, target_uin: Number(target.uin), abstime: target.time }
          : { tid: target.tid, content: claimed.content, target_uin: Number(target.uin) };
      if (claimed.kind === "publish" && imageRecords(claimed).length)
        params.images = checkImages(ctx, claimed).map(image => image.wireReference);
      raw = await request(ctx, actionFor(claimed.kind), freeze(params), { signal, binding: wire.binding });
      guard(ctx, signal); // Settlement below records facts even after revocation.
    } catch { reason = "QZONE_WIRE_OR_CONTEXT_UNCERTAIN"; }
    const accepted = wire.started() && success(raw);
    const knownFailed = wire.started() && rejection(raw);
    let view;
    try {
      await transact(root => {
        const b = book(root, c), row = rowFor(b, id);
        if (row.claimId !== claimId) fail("QZONE_CLAIM_REVOKED");
        row.protocolAccepted = accepted;
        row.clientVerified = false;
        row.status = accepted && !row.cancelRequested && row.status === "publishing" && row.revision === claimed.revision
          ? "publishing" : knownFailed ? "failed" : "uncertain";
        row.reason = accepted ? "QZONE_CLIENT_VERIFICATION_REQUIRED" : knownFailed ? "QZONE_PROTOCOL_REJECTED" : reason || "QZONE_ENVELOPE_UNCERTAIN";
        row.revision++;
        row.wireSettledAt = now();
        const section = sectionFor(row.kind);
        b.lastWriteAt[section] = Math.max(b.lastWriteAt[section] || 0, now());
        if (accepted && tid(raw.data?.tid)) row.receiptTidHash = hash(raw.data.tid);
        if ((b.recoveryRevision || 0) === claimed.recoveryRevision) {
          if (accepted) capability(b, c, actionFor(row.kind), "supported", { writeSettled: true });
          else if (unsupported(raw)) capability(b, c, actionFor(row.kind), "unsupported");
        }
        view = draftView(row);
      });
    } catch {
      poisoned.add(c.accountId);
      return { ...draftView(claimed), status: "uncertain", protocolAccepted: false,
        clientVerified: false, reason: "QZONE_DURABILITY_UNCERTAIN" };
    } finally { leases.delete(id); }
    // No callback containing QZone content, source IDs, recipients or claimed
    // "life experience". Parent integration can inspect detached trusted status.
    return view;
  }
  async function verifyPublish(ctx, id, options = {}) {
    exact(options, ["signal"]);
    const c = guard(ctx, options.signal), before = structuredClone(rowFor(currentBook(ctx), id));
    if (before.kind !== "publish" || !before.protocolAccepted || !before.receiptTidHash
      || !["publishing", "uncertain"].includes(before.status)) fail("QZONE_NOT_VERIFIABLE");
    // The pinned own-list response does not attest attachment bytes/order. A
    // text-only match must NEVER certify an image publication as client-verified.
    if (imageRecords(before).length) return { ...draftView(before), reason: "QZONE_IMAGES_CLIENT_UNVERIFIED" };
    const rows = await read(ctx, true, options);
    guard(ctx, options.signal);
    // Official list response proves only private/self vs non-private. Never
    // infer friends/public visibility from is_private:false or ACK defaults.
    const match = rows.internal.find(r => hash(r.tid) === before.receiptTidHash
      && r.contentHash === hash(before.content) && r.selfOnly && before.audience === 64);
    if (!match) return { ...draftView(before), reason: "QZONE_VISIBILITY_OR_CONTENT_UNVERIFIED" };
    await transact(root => {
      guard(ctx, options.signal);
      const row = rowFor(book(root, c), id); cas(row, before.revision);
      if (row.claimId !== before.claimId || row.cancelRequested) fail("QZONE_CLAIM_REVOKED");
      row.status = "confirmed"; row.clientVerified = true; row.reason = "QZONE_OWN_READ_VERIFIED"; row.revision++;
    });
    guard(ctx, options.signal);
    return draftView(rowFor(currentBook(ctx), id));
  }
  async function cancel(ctx, id, expectedRevision, actor) {
    const c = guard(ctx, undefined, false); admin(ctx, actor);
    await transact(root => {
      guard(ctx, undefined, false); admin(ctx, actor);
      const row = rowFor(book(root, c), id); cas(row, expectedRevision);
      if (["confirmed", "failed"].includes(row.status)) fail("QZONE_TRANSITION");
      row.status = "uncertain"; row.cancelRequested = true; row.reason = "QZONE_CANCELLED_NO_RETRY"; row.revision++;
    });
    leases.delete(id); targets.delete(id); freshDrafts.delete(id);
    guard(ctx, undefined, false); admin(ctx, actor);
    return draftView(rowFor(currentBook(ctx), id));
  }
  async function recover(ctx) {
    const c = info(ctx); // Safe bookkeeping even when stop/quiet is active.
    const existing = currentBook(ctx);
    if (!existing) return { recovered: 0, automaticResume: false };
    let result;
    await transact(root => {
      for (const row of Object.values(book(root, c).drafts)) {
        leases.delete(row.id); targets.delete(row.id); freshDrafts.delete(row.id);
      }
      const scoped = { qzoneSocial: { version: 1, bots: { [c.logicalId]: { owners: { [c.qq]: book(root, c) } } } } };
      result = recoverQzoneState(scoped, { reason: "restart", now: now() });
      if (result.changed) root.memory.qzoneSocial.bots[c.logicalId].owners[c.qq] = result.memory.qzoneSocial.bots[c.logicalId].owners[c.qq];
    });
    return { recovered: result.recovered, automaticResume: false };
  }
  return Object.freeze({ open, status, readFeeds, readOwn, createDraft, submitReview, approve,
    approveInteraction: approve, publish, proposeInteraction, verifyPublish, cancel, recover });
}
