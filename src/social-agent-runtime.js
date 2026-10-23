// Callback-only planner. No sockets, files, model clients or background timers.
const TOOL_NAMES = ["read_unread", "read_detail", "read_history", "read_memory", "web_search", "schedule_followup"];
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = code => Object.assign(new Error(code), { code });
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const keys = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key));
const copy = value => JSON.parse(JSON.stringify(value));
// Only host adapter code can attach this receipt. JSON/model text cannot forge
// a WeakMap entry; model-supplied decision.usage is never billing evidence.
const usageReceipts = new WeakMap();
export function withSocialAgentUsage(decision, usage) {
  if (!plain(decision) || !keys(usage, ["inputTokens", "outputTokens"])
    || !integer(usage.inputTokens, 0, 1e9) || !integer(usage.outputTokens, 0, 1e9)) throw fail("SOCIAL_INVALID_USAGE_RECEIPT");
  usageReceipts.set(decision, copy(usage));
  return decision;
}
const safeKey = value => typeof value === "string" && /^(account|group):[A-Za-z0-9_.:\-]{1,100}$/.test(value);
const conversation = value => typeof value === "string" && /^(group|private):[1-9]\d{0,19}$/.test(value);
const qq = value => typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);
const localDay = time => new Date(time + 8 * 3_600_000).toISOString().slice(0, 10);
const ERROR_CODES = new Set(["SOCIAL_DISABLED", "SOCIAL_CANCELLED", "SOCIAL_TIMEOUT", "SOCIAL_STALE", "SOCIAL_STATE_INVALID",
  "SOCIAL_INVALID_DECISION", "SOCIAL_INVALID_SEQUENCE", "SOCIAL_INVALID_TOOL", "SOCIAL_INVALID_SNAPSHOT",
  "SOCIAL_BUDGET_EXHAUSTED", "SOCIAL_TOOL_LIMIT", "SOCIAL_INVALID_TOOL_RESULT", "SOCIAL_CALL_LIMIT", "SOCIAL_SCHEDULE_UNAVAILABLE",
  "SOCIAL_INVALID_CONTINUITY", "SOCIAL_CONTINUITY_REJECTED", "SOCIAL_FOREIGN_TOOL_RESULT", "SOCIAL_INTENT_ALREADY_CLAIMED",
  "SOCIAL_MODEL_ONLY_UNAVAILABLE"]);

function checkScope(value, ctx) {
  if (!plain(value)) return;
  if ((value.logicalId !== undefined && value.logicalId !== ctx.logicalId)
    || (value.conversationId !== undefined && value.conversationId !== ctx.conversationId)) throw fail("SOCIAL_FOREIGN_TOOL_RESULT");
}
function checkToolScopes(value, ctx, depth = 0, budget = { nodes: 0 }) {
  if (depth > 16 || ++budget.nodes > 10_000) throw fail("SOCIAL_INVALID_TOOL_RESULT");
  if (value === null || typeof value !== "object") return;
  checkScope(value, ctx);
  for (const item of Object.values(value)) checkToolScopes(item, ctx, depth + 1, budget);
}

// A page's declared bound is not evidence: the actual contiguous messages are.
// Repeated prefixes are permitted only when their IDs match already seen seqs.
function extendUnread(job, result, seenSeq) {
  if (!keys(result, ["messages", "seenSeq", "readThroughSeq", "hasMore", "state", "mood", "experiences", "habits", "habitCandidates", "logicalId", "conversationId"])
    || !Array.isArray(result.messages) || result.messages.length > 100 || !integer(result.seenSeq, 0, Number.MAX_SAFE_INTEGER)) throw fail("SOCIAL_INVALID_TOOL_RESULT");
  checkScope(result, job.ctx);
  let bound = seenSeq, previous = -1;
  const additions = [];
  for (const message of result.messages) {
    if (!plain(message) || !integer(message.seq, 1, Number.MAX_SAFE_INTEGER) || message.seq <= previous
      || !text(message.messageId, 128) || !/^[1-9]\d{0,19}$/.test(message.userId)
      || typeof message.text !== "string" || message.text.length > 4000
      || !integer(message.sentAt, 1, Number.MAX_SAFE_INTEGER) || !integer(message.receivedAt, 1, Number.MAX_SAFE_INTEGER)
      || (message.isQuoted !== undefined && typeof message.isQuoted !== "boolean")
      || (message.isBot !== undefined && typeof message.isBot !== "boolean")) throw fail("SOCIAL_INVALID_TOOL_RESULT");
    checkScope(message, job.ctx);
    previous = message.seq;
    if (message.seq <= seenSeq) {
      if (job.seenMessages.get(message.seq) !== message.messageId) throw fail("SOCIAL_INVALID_TOOL_RESULT");
    } else {
      if (message.seq !== bound + 1 || job.seenMessages.size + additions.length >= 256
        || [...job.seenMessages.values(), ...additions.map(item => item.messageId)].includes(message.messageId)) throw fail("SOCIAL_INVALID_TOOL_RESULT");
      bound = message.seq;
      additions.push(message);
    }
  }
  // No acknowledgement advance on an empty page, gaps or fabricated metadata.
  if (result.seenSeq !== (result.messages.at(-1)?.seq ?? seenSeq) || result.seenSeq > bound) throw fail("SOCIAL_INVALID_TOOL_RESULT");
  for (const message of additions) {
    job.seenMessages.set(message.seq, message.messageId);
    if (message.isQuoted !== true && message.isBot !== true) job.seenMessageIds.push(message.messageId);
  }
  return bound;
}

function validateArgs(name, args, seenSeq) {
  const limit = (max = 100) => args.limit === undefined || integer(args.limit, 1, max);
  switch (name) {
    case "read_unread": return keys(args, ["limit", "afterSeq"]) && limit()
      && (args.afterSeq === undefined || integer(args.afterSeq, 0, seenSeq));
    case "read_detail": return keys(args, ["seq"]) && integer(args.seq, 1, seenSeq);
    case "read_history": return keys(args, ["beforeSeq", "limit"]) && limit()
      && (args.beforeSeq === undefined || integer(args.beforeSeq, 0, seenSeq));
    case "read_memory": return keys(args, ["query", "limit"]) && limit(20)
      && (args.query === undefined || text(args.query, 500));
    case "web_search": return keys(args, ["query"]) && text(args.query, 500);
    case "schedule_followup": return keys(args, ["delayMs", "userId"]) && integer(args.delayMs, 1000, 86_400_000)
      && (args.userId === undefined || qq(args.userId));
    default: return false;
  }
}

function validateDecision(value, seenSeq, allowed, seenMessageIds) {
  if (!keys(value, ["action", "messages", "throughSeq", "delayMs", "tool", "continuity", "usage", "materialIds"])) throw fail("SOCIAL_INVALID_DECISION");
  if (value.materialIds !== undefined && (!Array.isArray(value.materialIds) || value.materialIds.length > 3
    || value.materialIds.some(id => !text(id, 160)))) throw fail("SOCIAL_INVALID_DECISION");
  if (!["reply", "observe", "wait", "dive", "tool"].includes(value.action)) throw fail("SOCIAL_INVALID_DECISION");
  if (value.throughSeq !== undefined && !integer(value.throughSeq, 0, seenSeq)) throw fail("SOCIAL_INVALID_SEQUENCE");
  if (value.usage !== undefined && (!keys(value.usage, ["inputTokens", "outputTokens"])
    || !integer(value.usage.inputTokens, 0, 1e9) || !integer(value.usage.outputTokens, 0, 1e9))) throw fail("SOCIAL_INVALID_DECISION");
  if (value.continuity !== undefined) {
    const proposal = value.continuity;
    if (!keys(proposal, ["mood", "experiences", "habits", "personaChanges"]) || Object.keys(proposal).length === 0) throw fail("SOCIAL_INVALID_CONTINUITY");
    if (proposal.personaChanges !== undefined) {
      if (!Array.isArray(proposal.personaChanges) || proposal.personaChanges.length < 1 || proposal.personaChanges.length > 6) throw fail("SOCIAL_INVALID_CONTINUITY");
      for (const item of proposal.personaChanges) if (!keys(item, ["field", "value", "evidenceMessageIds"])
        || !["identity", "selfName", "expression", "interests", "boundaries", "examples"].includes(item.field)
        || !text(item.value, item.field === "examples" ? 2000 : 800)
        || !Array.isArray(item.evidenceMessageIds) || !item.evidenceMessageIds.length || item.evidenceMessageIds.length > 32
        || item.evidenceMessageIds.some(id => !seenMessageIds.includes(id))) throw fail("SOCIAL_INVALID_CONTINUITY");
    }
    if (proposal.mood !== undefined && (!keys(proposal.mood, ["valence", "arousal", "engagement"])
      || Object.keys(proposal.mood).length === 0 || Object.values(proposal.mood).some(item => !Number.isFinite(item) || Math.abs(item) > 1))) throw fail("SOCIAL_INVALID_CONTINUITY");
    for (const kind of ["experiences", "habits"]) {
      if (proposal[kind] === undefined) continue;
      if (!Array.isArray(proposal[kind]) || proposal[kind].length > 8) throw fail("SOCIAL_INVALID_CONTINUITY");
      for (const item of proposal[kind]) {
        if (!keys(item, ["text", "evidenceMessageIds"]) || !text(item.text, 800)) throw fail("SOCIAL_INVALID_CONTINUITY");
        if (item.evidenceMessageIds !== undefined && (!Array.isArray(item.evidenceMessageIds)
          || item.evidenceMessageIds.length < 1 || item.evidenceMessageIds.length > 32
          || item.evidenceMessageIds.some(id => !seenMessageIds.includes(id)))) throw fail("SOCIAL_INVALID_CONTINUITY");
      }
    }
    if (seenMessageIds.length === 0) throw fail("SOCIAL_INVALID_CONTINUITY");
  }
  if (value.action === "reply") {
    if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 4
      || value.messages.some(item => !text(item, 2000))) throw fail("SOCIAL_INVALID_DECISION");
  } else if (value.messages !== undefined) throw fail("SOCIAL_INVALID_DECISION");
  if (["wait", "dive"].includes(value.action)) {
    if (!integer(value.delayMs, 1000, 86_400_000)) throw fail("SOCIAL_INVALID_DECISION");
  } else if (value.delayMs !== undefined) throw fail("SOCIAL_INVALID_DECISION");
  if (value.action === "tool") {
    if (!keys(value.tool, ["name", "args"]) || !allowed.includes(value.tool.name)
      || !validateArgs(value.tool.name, value.tool.args, seenSeq)) throw fail("SOCIAL_INVALID_TOOL");
  } else if (value.tool !== undefined) throw fail("SOCIAL_INVALID_DECISION");
  return copy(value);
}

/**
 * All callbacks receive an immutable {logicalId, conversationId} scope. The
 * caller resolves logical identity with account-runtime, never carrier labels.
 * getSnapshot(ctx): JSON-only, already scoped core view, with integer seenSeq.
 * transact(syncBuilder): mutateMemory-compatible; resolves AFTER publication.
 * callModel({context,snapshot,tools,signal}): strict decision object, not text.
 * tools[name](ctx,args,{signal}): scoped JSON result; adapters MUST honor signal
 * and must not expose foreign scopes or perform external sends. Descriptors
 * expose names/argument keys only; closures and credentials never reach model.
 * sendIntent(ctx,{messages,throughSeq,seenSeq,signal}): coordinator adapter; must honor
 * signal and recheck routing/quiet/revisions at wire time. Resolution is final;
 * rejection/uncertainty is never retried by this runtime.
 * isCurrent(ctx): includes identity, conversation controls and quiet state.
 * clock: () => epoch ms, or {now,setTimeout,clearTimeout} for deterministic tests.
 * observe queues fresh input; runDue executes only this instance's queue. Parent
 * owns future scheduling; wait/dive do not automatically replay after restart.
 * observe({...ctx,resumeDue:true}) explicitly authorizes a persisted due wait or
 * dive; never use it for automatic startup enumeration. shadowMode defaults true
 * and suppresses send/schedule callbacks. schedule_followup receives only
 * {delayMs,userId?} args and {signal,action,dueAt,throughSeq,userId?} metadata.
 * userId is a validated QQ string, NOT consent/authority: bridge owns both
 * policy and verified-recipient-consent gates and coordinator delivery.
 * read_unread accepts {limit?,afterSeq?}; afterSeq cannot exceed the currently
 * verified seenSeq. Forward it to the scoped bridge pager; only actual returned
 * contiguous messages advance the bound. Cursor omission remains compatible.
 * onDecision(ctx,{action,throughSeq,seenSeq,continuity,signal}) runs after a
 * successful nonreply outcome; bridge may durably ACK only <= seenSeq. Shadow
 * replies report action:'shadow'. applyContinuity(ctx,proposal,{seenMessageIds,
 * now,signal}) runs after successful nonshadow terminal outcomes (before the
 * nonreply ACK hook; reply ACK belongs to the confirmed coordinator sender).
 * Adapter must revalidate actual sender/current evidence through core mutators.
 * Model decision.usage is untrusted. Only withSocialAgentUsage host receipts
 * contribute known tokens; all other dispatched calls count unknown usage.
 * Public methods return content-free codes; status never returns model text.
 */
export function createSocialAgentRuntime({ getPolicy, getSnapshot, transact, callModel, tools = {}, sendIntent, isCurrent,
  applyContinuity, onDecision, clock = Date.now } = {}) {
  if ([getPolicy, getSnapshot, transact, callModel, sendIntent, isCurrent].some(fn => typeof fn !== "function")) throw fail("SOCIAL_INVALID_CALLBACK");
  const now = typeof clock === "function" ? clock : () => clock.now();
  const setTimer = typeof clock.setTimeout === "function" ? clock.setTimeout.bind(clock) : setTimeout;
  const clearTimer = typeof clock.clearTimeout === "function" ? clock.clearTimeout.bind(clock) : clearTimeout;
  const pending = new Map(), active = new Map(), initialized = new Set();
  let serial = 0;
  const metrics = { completed: 0, failed: 0, cancelled: 0, intents: 0 };
  const allowed = TOOL_NAMES.filter(name => typeof tools[name] === "function");
  const descriptors = allowed.map(name => ({ name, argumentKeys: ({
    read_unread: ["limit", "afterSeq"], read_detail: ["seq"], read_history: ["beforeSeq", "limit"],
    read_memory: ["query", "limit"], web_search: ["query"], schedule_followup: ["delayMs", "userId"]
  })[name] }));
  const keyFor = ctx => JSON.stringify([ctx.logicalId, ctx.conversationId]);
  function policyFor(ctx) {
    const p = getPolicy(ctx);
    if (!p || p.enabled !== true || !Array.isArray(p.conversationIds) || !p.conversationIds.includes(ctx.conversationId)) throw fail("SOCIAL_DISABLED");
    const bound = (key, fallback, max) => p[key] === undefined ? fallback
      : integer(p[key], 0, max) ? p[key] : 0;
    return { shadow: p.shadowMode !== false, daily: bound("maxDailyCalls", 1000, 10_000), tools: bound("maxToolCalls", 8, 8),
      timeout: bound("turnTimeoutMs", 60_000, 60_000) };
  }
  function guard(job) {
    if (job.controller.signal.aborted) throw fail(job.reason || "SOCIAL_CANCELLED");
    if (now() >= job.deadline) { job.reason = "SOCIAL_TIMEOUT"; job.controller.abort(); throw fail("SOCIAL_TIMEOUT"); }
    const policy = policyFor(job.ctx);
    if (isCurrent(job.ctx) !== true) throw fail("SOCIAL_STALE");
    return policy;
  }
  // Race even non-cooperating callbacks, rejecting late completions. The abort
  // listener is always removed and losing promises have rejection handlers.
  async function bounded(job, invoke) {
    guard(job);
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(fail(job.reason || "SOCIAL_CANCELLED"));
      job.controller.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const result = await Promise.race([Promise.resolve().then(() => { guard(job); return invoke(); }), interrupted]);
      guard(job);
      return result;
    } finally { job.controller.signal.removeEventListener("abort", abort); }
  }
  function botFor(root, ctx) {
    root.socialAgents ??= { version: 1, bots: {} };
    if (root.socialAgents.version !== 1 || !plain(root.socialAgents.bots)) throw fail("SOCIAL_STATE_INVALID");
    const bot = root.socialAgents.bots[ctx.logicalId] ??= {};
    bot.conversations ??= {};
    return bot;
  }
  function runtimeFor(root, ctx) {
    const bot = botFor(root, ctx);
    const conv = bot.conversations[ctx.conversationId] ??= {};
    conv.runtime ??= {};
    return conv.runtime;
  }
  async function write(job, build) {
    guard(job);
    const result = await bounded(job, () => transact(root => { guard(job); return build(root); }));
    guard(job); // Durable await may overlap direct input, disable or route change.
    return result;
  }
  async function finish(job, patch) {
    await write(job, root => {
      const state = runtimeFor(root, job.ctx);
      if (state.turnId !== job.id) throw fail("SOCIAL_STALE");
      Object.assign(state, patch, { updatedAt: now() });
    });
  }
  async function terminal(job, decision, seenSeq) {
    if (decision.continuity && !job.discoveryWakeId && !guard(job).shadow) {
      if (typeof applyContinuity !== "function") throw fail("SOCIAL_CONTINUITY_REJECTED");
      const result = await bounded(job, () => applyContinuity(job.ctx, copy(decision.continuity),
        { seenMessageIds: [...job.seenMessageIds], now: now(), signal: job.controller.signal }));
      if (result?.ok === false) throw fail("SOCIAL_CONTINUITY_REJECTED");
    }
    if (typeof onDecision === "function" && decision.action !== "reply") {
      await bounded(job, () => onDecision(job.ctx, { action: decision.action,
        throughSeq: decision.throughSeq, seenSeq, continuity: decision.continuity ? copy(decision.continuity) : undefined,
        signal: job.controller.signal }));
    }
  }
  async function schedule(job, action, delayMs, seenSeq, throughSeq, continuity, userId) {
    const dueAt = now() + delayMs;
    const shadow = guard(job).shadow;
    if (!shadow && !allowed.includes("schedule_followup")) throw fail("SOCIAL_SCHEDULE_UNAVAILABLE");
    if (job.toolCalls >= Math.min(job.initialToolLimit, guard(job).tools)) throw fail("SOCIAL_TOOL_LIMIT");
    job.toolCalls += 1;
    await finish(job, { status: shadow ? "shadow" : "schedule_claimed", plannedAction: action,
      dueAt, lastProcessedSeq: seenSeq, ...(continuity ? { continuity } : {}) });
    if (shadow || guard(job).shadow) {
      await terminal(job, { action, throughSeq, continuity }, seenSeq);
      return { code: "SOCIAL_SHADOWED" };
    }
    await bounded(job, () => {
      if (job.toolCalls > guard(job).tools) throw fail("SOCIAL_TOOL_LIMIT");
      const recipient = userId === undefined ? {} : { userId };
      return tools.schedule_followup(job.ctx, { delayMs, ...recipient },
        { signal: job.controller.signal, action, dueAt, throughSeq, ...recipient });
    });
    await finish(job, { status: action === "dive" ? "diving" : "waiting" });
    await terminal(job, { action, throughSeq, continuity }, seenSeq);
    return { code: "SOCIAL_WAITING" };
  }
  async function run(job) {
    const signal = job.controller.signal;
    let timer;
    try {
      const p = policyFor(job.ctx);
      job.initialToolLimit = p.tools;
      job.toolCalls = 0;
      job.deadline = now() + p.timeout;
      timer = setTimer(() => { job.reason = "SOCIAL_TIMEOUT"; job.controller.abort(); }, p.timeout);
      guard(job);
      // Mark persisted work from prior processes paused; never inspect it for
      // automatic replay, including send intents with uncertain delivery.
      await write(job, root => {
        const state = runtimeFor(root, job.ctx);
        if (!initialized.has(job.key) && state.status && !["idle", "paused"].includes(state.status)) {
          state.previousStatus = state.status;
          state.status = "paused";
          state.reason = "startup_interrupted";
        }
      });
      initialized.add(job.key);
      const snapshot = copy(await bounded(job, () => getSnapshot(job.ctx)));
      if (!plain(snapshot) || !integer(snapshot.seenSeq, 0, Number.MAX_SAFE_INTEGER)) throw fail("SOCIAL_INVALID_SNAPSHOT");
      checkScope(snapshot, job.ctx);
      let seenSeq = snapshot.seenSeq;
      job.seenMessages = new Map((Array.isArray(snapshot.messages) ? snapshot.messages : [])
        .filter(item => integer(item?.seq, 1, seenSeq) && text(item.messageId, 128)).map(item => [item.seq, item.messageId]));
      job.seenMessageIds = [...new Set((Array.isArray(snapshot.messages) ? snapshot.messages : [])
        .filter(item => integer(item?.seq, 1, seenSeq) && item.isQuoted !== true && item.isBot !== true && text(item.messageId, 128))
        .map(item => item.messageId))].slice(0, 256);
      const start = await write(job, root => {
        const state = runtimeFor(root, job.ctx);
        // Migrate prior in-flight claims before a new turn can overwrite status.
        // The durable fence survives new input, observe outcomes and restarts.
        if ((state.status === "intent_claimed" || (state.status === "paused" && state.previousStatus === "intent_claimed"))
          && integer(state.lastProcessedSeq, 0, Number.MAX_SAFE_INTEGER)) {
          state.intentFenceThroughSeq = Math.max(state.intentFenceThroughSeq || 0, state.lastProcessedSeq);
        }
        const replayable = ["waiting", "diving"].includes(state.status)
          || (state.status === "paused" && ["waiting", "diving"].includes(state.previousStatus));
        const authorizedDue = job.resumeDue && replayable
          && ["wait", "dive"].includes(state.plannedAction) && Number.isFinite(state.dueAt) && state.dueAt <= now();
        const uncertain = [state.status, state.status === "paused" ? state.previousStatus : ""]
          .some(value => ["intent_claimed", "schedule_claimed"].includes(value));
        const sameInput = state.lastInputReadThroughSeq === snapshot.readThroughSeq
          || !Array.isArray(snapshot.messages) || snapshot.messages.length === 0 || uncertain;
        if (job.discoveryWakeId) {
          // This host-created wake is not a human message or an unread ACK.
          // Claim once durably; never reuse an uncertain wake after restart.
          if (state.discoveryWakeId !== job.discoveryWakeId || state.lastDiscoveryWakeId === job.discoveryWakeId) return false;
          state.lastDiscoveryWakeId = job.discoveryWakeId;
        } else if (integer(state.lastProcessedSeq, seenSeq, Number.MAX_SAFE_INTEGER) && sameInput && !authorizedDue) return false;
        Object.assign(state, { turnId: job.id, status: "running", seenSeq, startedAt: now(),
          ...(snapshot.readThroughSeq === undefined ? {} : { lastInputReadThroughSeq: snapshot.readThroughSeq }) });
        delete state.dueAt;
        return true;
      });
      if (!start) return { code: "SOCIAL_ALREADY_PROCESSED" };
      const toolResults = [];
      for (let count = 0; count < 8; count += 1) {
        const day = localDay(now());
        const claim = `${job.id}:${count}`;
        await write(job, root => {
          const bot = botFor(root, job.ctx);
          bot.runtimeUsage ??= { days: {} };
          const daily = bot.runtimeUsage.days[day] ??= { reservedCalls: 0, actualCalls: 0, unknownUsageCalls: 0, inputTokens: 0, outputTokens: 0, pending: {} };
          if (!integer(daily.reservedCalls, 0, Number.MAX_SAFE_INTEGER) || daily.reservedCalls >= guard(job).daily) throw fail("SOCIAL_BUDGET_EXHAUSTED");
          daily.reservedCalls += 1;
          daily.pending[claim] = { at: now() };
        });
        let invoked = false, decision, trustedUsage;
        try {
          const raw = await bounded(job, () => {
            invoked = true;
            return callModel({ context: job.ctx, snapshot: copy({ ...snapshot, seenSeq, toolResults }), tools: copy(descriptors), signal });
          });
          trustedUsage = plain(raw) ? usageReceipts.get(raw) : undefined;
          if (plain(raw)) usageReceipts.delete(raw);
          decision = validateDecision(raw, seenSeq, allowed, job.seenMessageIds);
          if (job.reflectOnly || job.discoveryWakeId) {
            if (decision.action === "tool" && !["read_unread", "read_detail", "read_history", "read_memory"].includes(decision.tool.name)) throw fail("SOCIAL_INVALID_TOOL");
            if (["wait", "dive", ...(job.reflectOnly ? ["reply"] : [])].includes(decision.action)) {
              decision.action = "observe";
              delete decision.messages; delete decision.delayMs;
            }
          }
        } finally {
          // Accounting is allowed after cancellation; no prompt/output/error
          // strings are persisted. A failed write is not silently retried.
          await transact(root => {
            const daily = root.socialAgents?.bots?.[job.ctx.logicalId]?.runtimeUsage?.days?.[day];
            if (!daily?.pending?.[claim]) throw fail("SOCIAL_STATE_INVALID");
            delete daily.pending[claim];
            if (invoked) {
              daily.actualCalls += 1;
              if (trustedUsage) {
                daily.inputTokens += trustedUsage.inputTokens;
                daily.outputTokens += trustedUsage.outputTokens;
              } else daily.unknownUsageCalls += 1;
            }
          });
        }
        guard(job);
        if (decision.action === "tool") {
          const { name, args } = decision.tool;
          if (name === "schedule_followup") {
            return await schedule(job, "wait", args.delayMs, seenSeq, decision.throughSeq, decision.continuity, args.userId);
          }
          if (++job.toolCalls > Math.min(p.tools, guard(job).tools)) throw fail("SOCIAL_TOOL_LIMIT");
          const result = await bounded(job, () => {
            if (job.toolCalls > guard(job).tools) throw fail("SOCIAL_TOOL_LIMIT");
            return tools[name](job.ctx, copy(args), { signal });
          });
          const encoded = JSON.stringify(result);
          if (typeof encoded !== "string" || encoded.length > 524_288) throw fail("SOCIAL_INVALID_TOOL_RESULT");
          const parsed = JSON.parse(encoded);
          checkToolScopes(parsed, job.ctx);
          if (name === "read_unread") seenSeq = extendUnread(job, parsed, seenSeq);
          toolResults.push({ name, result: parsed });
          continue;
        }
        const patch = { status: decision.action === "wait" ? "waiting" : decision.action === "dive" ? "diving" : "idle",
          ...(!job.discoveryWakeId ? { lastProcessedSeq: seenSeq } : {}) };
        if (["wait", "dive"].includes(decision.action)) {
          return await schedule(job, decision.action, decision.delayMs, seenSeq, decision.throughSeq, decision.continuity);
        }
        if (decision.continuity) patch.continuity = decision.continuity;
        if (decision.delayMs) patch.dueAt = now() + decision.delayMs;
        if (decision.action === "reply") {
          if (guard(job).shadow) {
            await finish(job, { ...patch, status: "shadow" });
            // Shadowed replies are terminal observations, not wire replies.
            if (typeof onDecision === "function") await bounded(job, () => onDecision(job.ctx,
              { action: "shadow", throughSeq: decision.throughSeq, seenSeq, signal }));
            return { code: "SOCIAL_SHADOWED" };
          }
          // Claim before callback. An uncertain callback is terminal, never
          // retried even if the caller invokes observe again for this input.
          await write(job, root => {
            const state = runtimeFor(root, job.ctx);
            if (state.turnId !== job.id) throw fail("SOCIAL_STALE");
            const throughSeq = decision.throughSeq ?? seenSeq;
            if (!job.discoveryWakeId && state.intentFenceThroughSeq !== undefined && (!integer(state.intentFenceThroughSeq, 0, Number.MAX_SAFE_INTEGER)
              || throughSeq <= state.intentFenceThroughSeq)) throw fail("SOCIAL_INTENT_ALREADY_CLAIMED");
            if (job.discoveryWakeId && state.discoveryIntentClaimed === job.discoveryWakeId) throw fail("SOCIAL_INTENT_ALREADY_CLAIMED");
            Object.assign(state, patch, { status: "intent_claimed", ...(job.discoveryWakeId
              ? { discoveryIntentClaimed: job.discoveryWakeId } : { intentFenceThroughSeq: throughSeq }), updatedAt: now() });
          });
          guard(job);
          if (guard(job).shadow) return { code: "SOCIAL_SHADOWED" };
          metrics.intents += 1;
          await bounded(job, () => sendIntent(job.ctx, { messages: decision.messages,
            materialIds: decision.materialIds || [], throughSeq: decision.throughSeq, seenSeq, signal }));
        }
        await finish(job, patch);
        await terminal(job, decision, seenSeq);
        metrics.completed += 1;
        return { code: "SOCIAL_COMPLETED" };
      }
      throw fail("SOCIAL_CALL_LIMIT");
    } catch (error) {
      const code = ERROR_CODES.has(error?.code) ? error.code : "SOCIAL_CALLBACK_FAILED";
      metrics[code === "SOCIAL_CANCELLED" ? "cancelled" : "failed"] += 1;
      // Never retry failed transactions or replay uncertain external actions.
      return { code };
    } finally { if (timer !== undefined) clearTimer(timer); }
  }
  function observe({ logicalId, conversationId, resumeDue = false, reflectOnly = false, discoveryWakeId } = {}) {
    if (!safeKey(logicalId) || !conversation(conversationId)) return { code: "SOCIAL_INVALID_CONTEXT", queued: false };
    if (discoveryWakeId !== undefined && !/^[A-Za-z0-9:_-]{1,120}$/.test(discoveryWakeId)) return { code: "SOCIAL_INVALID_CONTEXT", queued: false };
    const ctx = Object.freeze({ logicalId, conversationId });
    try { policyFor(ctx); if (isCurrent(ctx) !== true) throw fail("SOCIAL_STALE"); }
    catch { return { code: "SOCIAL_DISABLED", queued: false }; }
    const key = keyFor(ctx);
    if (!pending.has(key) && pending.size >= 256) return { code: "SOCIAL_QUEUE_FULL", queued: false };
    // New observation supersedes any active plan, but the lane remains occupied
    // until the old turn's durable accounting has settled.
    const old = active.get(key);
    if (old) { old.reason = "SOCIAL_CANCELLED"; old.controller.abort(); }
    pending.set(key, { ctx, resumeDue: resumeDue === true, reflectOnly: reflectOnly === true, discoveryWakeId });
    return { code: "SOCIAL_QUEUED", queued: true };
  }
  async function runDue() {
    const batch = [];
    for (const [key, request] of pending) {
      if (active.size >= 2) break;
      if (active.has(key)) continue;
      pending.delete(key);
      const job = { key, ctx: request.ctx, resumeDue: request.resumeDue, reflectOnly: request.reflectOnly, discoveryWakeId: request.discoveryWakeId,
        id: `${now()}:${++serial}`, controller: new AbortController(), deadline: Infinity };
      active.set(key, job);
      const operation = run(job).finally(() => { if (active.get(key) === job) active.delete(key); });
      batch.push(operation);
    }
    return Promise.all(batch);
  }
  function cancel(logicalId, conversationId) {
    let count = 0;
    const matches = ctx => ctx.logicalId === logicalId && (conversationId === undefined || ctx.conversationId === conversationId);
    for (const [key, request] of pending) if (matches(request.ctx)) { pending.delete(key); count += 1; }
    for (const job of active.values()) if (matches(job.ctx)) { job.reason = "SOCIAL_CANCELLED"; job.controller.abort(); count += 1; }
    return { cancelled: count };
  }
  return { observe, runDue, cancel, status: () => ({ queued: pending.size, active: active.size, ...metrics }) };
}
