import { conversationTurnHints } from "./conversation-turn-manager.js";

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value == null ? [] : [value];
}

function unique(values) {
  return [...new Set(asArray(values).map(String).filter(Boolean))];
}

function sameAccount(left, right) {
  return String(left?.accountId || "") === String(right?.accountId || "");
}

function laneKey(logicalBotId, conversationId) {
  return JSON.stringify([logicalBotId, conversationId]);
}

function coveredKey(logicalBotId, conversationId, messageId) {
  return JSON.stringify([logicalBotId, conversationId, String(messageId)]);
}

function modePriority(mode, direct = false) {
  if (direct || ["private", "at", "command"].includes(mode)) return 100;
  if (["web", "keyword"].includes(mode)) return 80;
  if (mode === "implicit") return 60;
  return 20;
}

function relationTokens(text) {
  const source = String(text || "").toLowerCase();
  const latin = source.match(/[a-z0-9][a-z0-9._+-]{1,}/g) || [];
  const chinese = source.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const chunks = [];
  for (const item of chinese) {
    if (item.length <= 4) chunks.push(item);
    else for (let index = 0; index < item.length - 1; index += 1) chunks.push(item.slice(index, index + 2));
  }
  return new Set([...latin, ...chunks].filter((item) => !["这个", "那个", "然后", "但是", "就是", "可以", "什么", "怎么"].includes(item)));
}

function currentOf(input) {
  return input.current || asArray(input.currentMessages).at(-1) || {};
}

function inputMessageIds(input) {
  return unique([...asArray(input.messageIds), ...asArray(input.currentMessages || input.current).flatMap((item) => asArray(item?.messageIds))]);
}

function messagesForIds(messages, messageIds) {
  const items = asArray(messages);
  const wanted = new Set(messageIds);
  return items.filter((item) => !asArray(item?.messageIds).length
    || asArray(item.messageIds).some((id) => wanted.has(String(id))))
    .map((item) => ({ ...item, messageIds: asArray(item?.messageIds).length
      ? unique(item.messageIds).filter((id) => wanted.has(id))
      : items.length === 1 ? [...messageIds] : [] }));
}

function withinLiveWindow(job, now, cfg) {
  // Related chatter must not keep an old turn alive indefinitely.
  return job && !job.dropped && !job.deliveryStarted
    && now - job.createdAt <= cfg.windowMs && now - job.updatedAt <= cfg.windowMs;
}

function freshIncoming(incoming, now, cfg) {
  const current = currentOf(incoming);
  const at = current.sentAtMs ?? current.at;
  return !Number.isFinite(at) || now - at <= cfg.windowMs;
}

function noteIncoming(state, incoming) {
  const previous = state.lastInput;
  // Observe and enqueue often see the same event in two host pipeline stages.
  // Preserve its interruption boundary instead of turning stage two into a merge.
  const sameEvent = previous?.senderId === incoming.senderId && incoming.messageIds.length
    && incoming.messageIds.some((id) => previous.messageIds.includes(id));
  incoming.interrupted = sameEvent ? previous.interrupted
    : Boolean(previous && previous.senderId !== incoming.senderId);
  state.lastInput = { senderId: incoming.senderId, messageIds: incoming.messageIds, interrupted: incoming.interrupted };
}

function compatibleTopic(job, incoming) {
  const before = currentOf({ currentMessages: job.currentMessages });
  const after = currentOf(incoming);
  if (/^\/[a-z][\w-]*(?:\s|$)/iu.test(after.text || "")) return false;
  return after.addressedTo !== "other"
    && !(before.topicId && after.topicId && String(before.topicId) !== String(after.topicId));
}

function canMergeTurn(job, incoming, now, cfg) {
  if (!withinLiveWindow(job, now, cfg) || !freshIncoming(incoming, now, cfg) || !sameAccount(job, incoming)
    || !incoming.senderId || job.senderId !== incoming.senderId || !compatibleTopic(job, incoming)) return false;
  const before = currentOf({ currentMessages: job.currentMessages });
  const after = currentOf(incoming);
  if (before.topicEnded === true || conversationTurnHints(before.text).topicEnded) return false;
  const refs = asArray(after.replyContexts).map((item) => String(item?.messageId || "")).filter(Boolean);
  // A resolved quote to a different turn is not a fragment of this question.
  if (refs.length && !refs.some((id) => job.messageIds.includes(id))) return false;
  if ((incoming.interrupted || after.interveningMessages > 0) && !conversationTurnHints(before.text).incomplete
    && !messagesRelated(job, incoming)) return false;
  return true;
}

function messagesRelated(job, incoming) {
  if (!compatibleTopic(job, incoming)) return false;
  const latest = currentOf({ currentMessages: job.currentMessages });
  if (latest.topicEnded === true || conversationTurnHints(latest.text).topicEnded) return false;
  const contexts = asArray(incoming.current?.replyContexts);
  const ids = new Set(unique(job.messageIds));
  if (contexts.some((item) => ids.has(String(item?.messageId || "")))) return true;
  // An independent addressed question is its own turn, even on the same topic.
  // Neither '?' nor an arbitrary bot quote assigns another user's question.
  if (incoming.direct || contexts.length || /[?？]/u.test(currentOf(incoming).text || "")) return false;
  const before = relationTokens(asArray(job.currentMessages).map((item) => item?.text || "").join("\n"));
  const after = relationTokens(incoming.current?.text || "");
  let overlap = 0;
  for (const token of after) {
    if (before.has(token)) overlap += 1;
    if (overlap >= 2) return true;
  }
  return false;
}

function mergeJobMessage(job, incoming) {
  const max = Math.max(1, Number(incoming.maxMergedMessages || 8));
  let currentMessages = [...asArray(job.currentMessages)];
  for (const next of asArray(incoming.currentMessages || incoming.current)) {
    const nextIds = new Set(asArray(next?.messageIds).map(String).filter(Boolean));
    if (nextIds.size) {
      currentMessages = currentMessages.filter((existing) => !asArray(existing?.messageIds).some((id) => nextIds.has(String(id))));
    }
    currentMessages.push(next);
  }
  job.currentMessages = currentMessages.slice(-max);
  job.messageIds = unique([...asArray(job.messageIds), ...asArray(incoming.messageIds)]);
  job.event = incoming.event || job.event;
  job.updatedAt = Date.now();
  job.contextRevision = Number(job.contextRevision || 0) + 1;
  job.mode = modePriority(incoming.mode, incoming.direct) > modePriority(job.mode, job.direct) ? incoming.mode : job.mode;
  job.direct = Boolean(job.direct || incoming.direct);
  job.priority = Math.max(Number(job.priority || 0), modePriority(incoming.mode, incoming.direct));
  job.settleUntil = Date.now() + Math.max(0, Number(incoming.settleMs || 0));
}

export class ReplyCoordinator {
  constructor({ config, log = () => {}, warn = () => {}, ownerForAccount = (id) => id ? `account:${id}` : "legacy:default" } = {}) {
    this.getConfig = typeof config === "function" ? config : () => config || {};
    this.log = log;
    this.warn = warn;
    this.ownerForAccount = ownerForAccount;
    this.states = new Map();
    this.covered = new Map();
    this.metrics = {
      enqueued: 0,
      sent: 0,
      merged: 0,
      regenerated: 0,
      cancelled: 0,
      dropped: 0,
      lastCancellationReason: "",
      lastCancellationAt: 0
    };
  }

  config() {
    const root = this.getConfig() || {};
    const queue = root.responseQueue || root;
    const live = queue.liveContext || {};
    return {
      enabled: queue.enabled !== false,
      minDelayMs: Math.max(0, Number(queue.minDelayMs ?? 1000)),
      liveEnabled: live.enabled !== false,
      windowMs: Math.max(1000, Number(live.windowMs ?? 20_000)),
      settleMs: Math.max(0, Number(live.settleMs ?? 350)),
      maxRegenerations: Math.max(0, Number(live.maxRegenerations ?? 2)),
      maxMergedMessages: Math.max(1, Number(live.maxMergedMessages ?? 8)),
      cancelProactiveOnDirect: live.cancelProactiveOnDirect !== false
    };
  }

  logicalOwner(accountId = "", scope = {}) {
    const explicit = typeof scope === "string" ? scope : scope?.logicalBotId;
    return String(explicit || this.ownerForAccount(String(accountId || "")) || "legacy:default");
  }

  state(conversationId, logicalBotId = "legacy:default") {
    const conversation = String(conversationId || "unknown");
    const key = laneKey(logicalBotId, conversation);
    if (!this.states.has(key)) this.states.set(key, { key, conversationId: conversation, logicalBotId, active: null, pending: [] });
    return this.states.get(key);
  }

  pruneCovered() {
    const now = Date.now();
    for (const [id, expiresAt] of this.covered.entries()) if (expiresAt <= now) this.covered.delete(id);
  }

  // Scope is { logicalBotId, conversationId }; old positional arguments remain valid.
  isCovered(messageIds, accountId = "", scope = {}) {
    this.pruneCovered();
    const owner = this.logicalOwner(accountId, scope);
    const ids = unique(messageIds);
    if (scope?.conversationId != null) {
      const conversation = String(scope.conversationId || "unknown");
      return ids.some((id) => this.covered.has(coveredKey(owner, conversation, id)));
    }
    // Legacy callers did not supply a conversation; retain their owner-wide query.
    // Enqueue always uses the full scope so equal IDs in different chats stay independent.
    const wanted = new Set(ids);
    for (const key of this.covered.keys()) {
      const [coveredOwner, , id] = JSON.parse(key);
      if (coveredOwner === owner && wanted.has(id)) return true;
    }
    return false;
  }

  // Optional current facts from the host: addressedTo ("bot"/"other"), opaque
  // topicId, topicEnded, interveningMessages, sentAtMs (milliseconds). These are
  // grouping hints, never permission to send; the host still owns wire guards.
  observeMessage({ conversationId, senderId, accountId = "", logicalBotId, current, event, messageIds = [], direct = false } = {}) {
    const cfg = this.config();
    if (!cfg.enabled || !cfg.liveEnabled) return { absorbed: false, contextUpdated: false };
    const owner = this.logicalOwner(accountId, { logicalBotId });
    const state = this.states.get(laneKey(owner, String(conversationId || "unknown")));
    if (!state) return { absorbed: false, contextUpdated: false };
    const incoming = {
      senderId: String(senderId || ""), accountId: String(accountId || ""), current, currentMessages: [current], event,
      messageIds: inputMessageIds({ messageIds, current }), direct, maxMergedMessages: cfg.maxMergedMessages, settleMs: cfg.settleMs
    };
    const now = Date.now();
    const unseenIds = incoming.messageIds.filter((id) => !this.isCovered([id], accountId, { logicalBotId: owner, conversationId }));
    if (incoming.messageIds.length && !unseenIds.length) return { absorbed: true, contextUpdated: false, duplicate: true };
    incoming.messageIds = unseenIds;
    incoming.currentMessages = current ? [{ ...current, messageIds: unseenIds }] : [];
    const duplicate = [state.active, ...state.pending].find((job) => job && !job.dropped
      && job.senderId === incoming.senderId && incoming.messageIds.length
      && incoming.messageIds.every((id) => job.messageIds.includes(id)));
    if (duplicate) return { absorbed: true, contextUpdated: false, duplicate: true, jobId: duplicate.id };
    noteIncoming(state, incoming);
    // A started burst is never regenerated/replayed, but its unsent remainder
    // can still yield to new relevant input. That input gets its own next job.
    if (state.active?.deliveryStarted && state.active.expressionSending && sameAccount(state.active, incoming) && freshIncoming(incoming, now, cfg)
      && currentOf(incoming).addressedTo !== "other"
      && (state.active.senderId === incoming.senderId || direct || (now - state.active.createdAt <= cfg.windowMs && messagesRelated(state.active, incoming)))) {
      state.active.stopRemaining?.("new-input-during-expression");
    }
    const mergeTarget = [state.active, ...state.pending].find((job) => (
      canMergeTurn(job, incoming, now, cfg)
    ));
    if (mergeTarget) {
      if (direct && cfg.cancelProactiveOnDirect && ["active", "proactive", "delayed"].includes(mergeTarget.mode)) {
        if (mergeTarget === state.active) this.cancelActive(mergeTarget, "direct-message-preempted-proactive", { drop: true });
        else {
          mergeTarget.dropped = true;
          state.pending = state.pending.filter((item) => item !== mergeTarget);
          this.metrics.dropped += 1;
          mergeTarget.resolve?.({ ok: true, skipped: true, reason: "direct-message-preempted-proactive" });
        }
        return { absorbed: false, contextUpdated: false, preemptedJobId: mergeTarget.id };
      }
      if (mergeTarget === state.active && Number(mergeTarget.regenerationCount || 0) >= cfg.maxRegenerations) {
        return { absorbed: false, contextUpdated: false, saturatedJobId: mergeTarget.id };
      }
      mergeJobMessage(mergeTarget, incoming);
      this.metrics.merged += incoming.messageIds.length || 1;
      if (mergeTarget === state.active && mergeTarget.controller && Number(mergeTarget.regenerationCount || 0) < cfg.maxRegenerations) {
        this.cancelActive(mergeTarget, "same-sender-followup", { drop: false });
      }
      this.log(`reply coordinator merged conversation=${state.conversationId} sender=${incoming.senderId} messages=${mergeTarget.messageIds.length}`);
      return { absorbed: true, contextUpdated: true, jobId: mergeTarget.id };
    }
    if (state.active && !state.active.dropped && !state.active.deliveryStarted && sameAccount(state.active, incoming)) {
      if (direct && cfg.cancelProactiveOnDirect && freshIncoming(incoming, now, cfg)
        && currentOf(incoming).addressedTo !== "other" && ["active", "proactive", "delayed"].includes(state.active.mode)) {
        this.cancelActive(state.active, "direct-message-preempted-proactive", { drop: true });
      } else if (withinLiveWindow(state.active, now, cfg) && freshIncoming(incoming, now, cfg) && messagesRelated(state.active, incoming)) {
        const relatedIds = state.active.relatedMessageIds || [];
        if (incoming.messageIds.length && incoming.messageIds.every((id) => relatedIds.includes(id))) {
          return { absorbed: false, contextUpdated: false, duplicate: true, jobId: state.active.id };
        }
        if (Number(state.active.regenerationCount || 0) >= cfg.maxRegenerations) {
          return { absorbed: false, contextUpdated: false, saturatedJobId: state.active.id };
        }
        state.active.contextRevision = Number(state.active.contextRevision || 0) + 1;
        state.active.updatedAt = now;
        state.active.relatedMessageIds = unique([...relatedIds, ...incoming.messageIds]).slice(-256);
        if (state.active.controller) this.cancelActive(state.active, "related-context-updated", { drop: false });
        return { absorbed: false, contextUpdated: true, jobId: state.active.id };
      }
    }
    return { absorbed: false, contextUpdated: false };
  }

  cancelActive(job, reason, { drop = false } = {}) {
    if (!job || job.dropped || job.deliveryStarted || (!drop && job.controller?.signal.aborted)) return;
    job.cancelReason = reason;
    job.dropped = drop || job.dropped;
    this.metrics.cancelled += 1;
    if (drop) this.metrics.dropped += 1;
    this.metrics.lastCancellationReason = reason;
    this.metrics.lastCancellationAt = Date.now();
    // Settle dropped callers even if execute ignores AbortSignal indefinitely.
    if (drop) job.resolve?.({ ok: true, skipped: true, reason });
    job.controller?.abort(reason);
  }

  dropSenderJobs(conversationId, senderId, reason = "direct-media-request", accountId = "", scope = {}) {
    const owner = this.logicalOwner(accountId, scope);
    const state = this.states.get(laneKey(owner, String(conversationId || "unknown")));
    if (!state) return 0;
    const sender = String(senderId || "");
    let dropped = 0;
    if (state.active && !state.active.dropped && !state.active.deliveryStarted && state.active.senderId === sender && sameAccount(state.active, { accountId })) {
      this.cancelActive(state.active, reason, { drop: true });
      dropped += 1;
    }
    state.pending = state.pending.filter((job) => {
      if (job.senderId !== sender || job.dropped || !sameAccount(job, { accountId })) return true;
      job.dropped = true;
      job.resolve?.({ ok: true, skipped: true, reason });
      this.metrics.dropped += 1;
      dropped += 1;
      return false;
    });
    this.cleanupState(state);
    return dropped;
  }

  cleanupState(state) {
    if (!state.active && !state.pending.length && this.states.get(state.key) === state) this.states.delete(state.key);
  }

  // Host-owned quiet/cancel gate for exactly one logical identity × conversation.
  // This cancels unsent work only; wire-started results remain non-replayable.
  invalidateConversation(conversationId, reason = "conversation-invalidated", accountId = "", scope = {}) {
    const owner = this.logicalOwner(accountId, scope);
    const state = this.states.get(laneKey(owner, String(conversationId || "unknown")));
    const counts = { active: 0, pending: 0, dropped: 0 };
    if (!state) return counts;
    if (state.active && !state.active.dropped && !state.active.deliveryStarted) {
      this.cancelActive(state.active, reason, { drop: true });
      counts.active += 1;
    }
    for (const job of state.pending) {
      if (job.dropped) continue;
      job.dropped = true;
      job.resolve?.({ ok: true, skipped: true, reason });
      this.metrics.dropped += 1;
      counts.pending += 1;
    }
    state.pending = [];
    this.cleanupState(state);
    counts.dropped = counts.active + counts.pending;
    return counts;
  }

  refreshLogicalBot(logicalBotId, reason = "policy-updated") {
    const owner = String(logicalBotId);
    const counts = { refreshed: 0, dropped: 0, pending: 0 };
    const cfg = this.config();
    for (const state of this.states.values()) {
      if (state.logicalBotId !== owner) continue;
      counts.pending += state.pending.length;
      const job = state.active;
      if (!job || job.dropped || job.deliveryStarted) continue;
      job.contextRevision += 1;
      if (job.regenerationCount < cfg.maxRegenerations) {
        this.cancelActive(job, reason, { drop: false });
        counts.refreshed += 1;
      } else {
        this.cancelActive(job, reason, { drop: true });
        counts.dropped += 1;
      }
    }
    return counts;
  }

  invalidateLogicalBot(logicalBotId, reason = "logical-bot-invalidated", { recoverUnsent = false } = {}) {
    const owner = String(logicalBotId);
    const counts = { active: 0, pending: 0, dropped: 0 };
    const intents = [];
    const rememberIntent = (job) => {
      if (!recoverUnsent || !job || job.dropped || job.deliveryStarted || job.preReplyStarted || job.preReplySent || !job.direct
        || !["private", "at", "keyword"].includes(job.mode) || typeof job.rebaseRuntime !== "function"
        || Number(job.ownerHandoffs || 0) >= 2) return;
      intents.push({ accountId: job.accountId, senderId: job.senderId, conversationId: job.conversationId,
        mode: job.mode, direct: true, currentMessages: [...job.currentMessages], messageIds: [...job.messageIds],
        event: job.event, execute: job.execute, rebaseRuntime: job.rebaseRuntime,
        ownerHandoffs: Number(job.ownerHandoffs || 0) + 1 });
    };
    for (const state of this.states.values()) {
      if (state.logicalBotId !== owner) continue;
      if (state.active && !state.active.dropped && !state.active.deliveryStarted) {
        rememberIntent(state.active);
        this.cancelActive(state.active, reason, { drop: true });
        counts.active += 1;
      }
      for (const job of state.pending) {
        if (job.dropped) continue;
        rememberIntent(job);
        job.dropped = true;
        job.resolve?.({ ok: true, skipped: true, reason });
        this.metrics.dropped += 1;
        counts.pending += 1;
      }
      state.pending = [];
      this.cleanupState(state);
    }
    counts.dropped = counts.active + counts.pending;
    return recoverUnsent ? { ...counts, intents } : counts;
  }

  enqueue(input = {}) {
    const cfg = this.config();
    const ids = inputMessageIds(input);
    const owner = this.logicalOwner(input.accountId, input);
    const conversationId = String(input.conversationId || "unknown");
    const messageIds = ids.filter((id) => !this.isCovered([id], input.accountId, { logicalBotId: owner, conversationId }));
    if (ids.length && !messageIds.length) return Promise.resolve({ ok: true, skipped: true, reason: "covered" });
    const currentMessages = messagesForIds(input.currentMessages || input.current, messageIds);
    const job = {
      ...input,
      id: String(input.id || `reply_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`),
      conversationId,
      senderId: String(input.senderId || ""),
      accountId: String(input.accountId || ""),
      logicalBotId: owner,
      mode: String(input.mode || "reply"),
      direct: input.direct === true,
      currentMessages,
      messageIds,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      contextRevision: 0,
      regenerationCount: 0,
      priority: Number(input.priority ?? modePriority(input.mode, input.direct)),
      dropped: false,
      preReplySent: false
    };
    const state = this.state(job.conversationId, job.logicalBotId);
    const duplicate = [state.active, ...state.pending].find((item) => item && !item.dropped
      && item.senderId === job.senderId && job.messageIds.length
      && job.messageIds.every((id) => item.messageIds.includes(id)));
    if (duplicate) return Promise.resolve({ ok: true, absorbed: true, duplicate: true, jobId: duplicate.id });
    noteIncoming(state, job);
    if (state.active?.deliveryStarted && state.active.expressionSending && sameAccount(state.active, job) && freshIncoming(job, Date.now(), cfg)
      && currentOf(job).addressedTo !== "other"
      && (state.active.senderId === job.senderId || job.direct)) state.active.stopRemaining?.("new-job-during-expression");
    const existing = [state.active, ...state.pending].find((item) => (
      canMergeTurn(item, { ...job, current: currentMessages.at(-1) }, Date.now(), cfg)
    ));
    if (existing && cfg.liveEnabled) {
      if (job.direct && cfg.cancelProactiveOnDirect && ["active", "proactive", "delayed"].includes(existing.mode)) {
        if (existing === state.active) this.cancelActive(existing, "direct-job-preempted-proactive", { drop: true });
        else {
          existing.dropped = true;
          state.pending = state.pending.filter((item) => item !== existing);
          this.metrics.dropped += 1;
          existing.resolve?.({ ok: true, skipped: true, reason: "direct-job-preempted-proactive" });
        }
      } else if (existing === state.active && Number(existing.regenerationCount || 0) >= cfg.maxRegenerations) {
        // Keep the saturated generation stable; this message becomes the next reply job.
      } else {
        mergeJobMessage(existing, { ...job, maxMergedMessages: cfg.maxMergedMessages, settleMs: cfg.settleMs });
        this.metrics.merged += job.messageIds.length || 1;
        if (existing === state.active && existing.controller && existing.regenerationCount < cfg.maxRegenerations) {
          this.cancelActive(existing, "same-sender-queued-followup", { drop: false });
        }
        return Promise.resolve({ ok: true, absorbed: true, jobId: existing.id });
      }
    }
    if (job.direct && cfg.cancelProactiveOnDirect && freshIncoming(job, Date.now(), cfg) && currentOf(job).addressedTo !== "other") {
      state.pending = state.pending.filter((item) => {
        const drop = sameAccount(item, job) && ["active", "proactive", "delayed"].includes(item.mode);
        if (drop) {
          this.metrics.dropped += 1;
          item.dropped = true;
          item.resolve?.({ ok: true, skipped: true, reason: "direct-job-preempted-proactive" });
        }
        return !drop;
      });
      if (state.active && !state.active.dropped && sameAccount(state.active, job) && ["active", "proactive", "delayed"].includes(state.active.mode)) {
        this.cancelActive(state.active, "direct-job-preempted-proactive", { drop: true });
      }
    }
    this.metrics.enqueued += 1;
    const promise = new Promise((resolve) => { job.resolve = resolve; });
    state.pending.push(job);
    state.pending.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    queueMicrotask(() => this.pump(state));
    return promise;
  }

  async pump(state) {
    if (state.active) return;
    if (!state.pending.length) {
      this.cleanupState(state);
      return;
    }
    const job = state.pending.shift();
    state.active = job;
    let outcome = { ok: true, skipped: true, reason: "dropped" };
    try {
      outcome = await this.runJob(job);
    } catch (err) {
      if (job.dropped) outcome = { ok: true, skipped: true, reason: job.cancelReason || "dropped" };
      else {
        this.warn(`reply coordinator failed conversation=${state.conversationId} job=${job.id}: ${err.message}`);
        outcome = { ok: false, error: err.message };
      }
    } finally {
      state.active = null;
      job.resolve?.(outcome);
      if (!state.pending.length) this.cleanupState(state);
      else queueMicrotask(() => this.pump(state));
    }
  }

  async runJob(job) {
    const cfg = this.config();
    // A preceding job may have covered part of this batch while it was queued,
    // including an uncertain wire attempt. Recheck before any execution.
    const unseenIds = job.messageIds.filter((id) => !this.isCovered([id], job.accountId, job));
    if (job.messageIds.length && !unseenIds.length) return { ok: true, skipped: true, reason: "covered" };
    job.messageIds = unseenIds;
    job.currentMessages = messagesForIds(job.currentMessages, unseenIds);
    while (!job.dropped) {
      // A new fragment can extend settling while the previous timer is asleep.
      // Recheck it, but never let refreshes extend the original live-turn cap.
      let settle;
      while (!job.dropped && (settle = Math.max(0,
        Math.min(Number(job.settleUntil || 0), job.createdAt + cfg.windowMs) - Date.now())) > 0) {
        await new Promise((resolve) => setTimeout(resolve, settle));
      }
      if (job.dropped) break;
      const revision = Number(job.contextRevision || 0);
      const controller = new AbortController();
      job.controller = controller;
      job.startedAt = Date.now();
      this.log(`reply coordinator start conversation=${job.conversationId} mode=${job.mode} sender=${job.senderId} regeneration=${job.regenerationCount}`);
      try {
        const result = await job.execute({ job, signal: controller.signal, revision, regeneration: job.regenerationCount });
        if (job.deliveryStarted && result?.retry) return { ok: true, skipped: true, deliveryUnconfirmed: true, reason: "delivery-started-no-replay" };
        if (job.dropped) return { ok: true, skipped: true, reason: job.cancelReason || "dropped" };
        const stale = controller.signal.aborted || Number(job.contextRevision || 0) !== revision;
        if (job.deliveryStarted && stale) return { ok: true, ...result, reason: "delivery-started-no-replay" };
        if ((result?.retry || stale) && job.regenerationCount < this.config().maxRegenerations) {
          job.regenerationCount += 1;
          this.metrics.regenerated += 1;
          job.settleUntil = Date.now() + cfg.settleMs;
          continue;
        }
        if (stale) return { ok: true, skipped: true, reason: job.cancelReason || "stale-context" };
        if (result?.sent) {
          job.deliveryStarted = true;
          this.metrics.sent += 1;
          for (const id of unique(job.deliveryMessageIds || job.messageIds)) this.covered.set(coveredKey(job.logicalBotId, job.conversationId, id), Date.now() + Math.max(cfg.windowMs * 3, 60_000));
          if (cfg.minDelayMs) await new Promise((resolve) => setTimeout(resolve, cfg.minDelayMs));
          // A completed send cannot be undone; never replay it after cancellation during spacing.
          if (job.dropped || controller.signal.aborted) return { ok: true, skipped: true, reason: job.cancelReason || "dropped" };
        }
        return { ok: true, ...result, regenerationCount: job.regenerationCount };
      } catch (err) {
        if (job.deliveryStarted) return { ok: true, skipped: true, deliveryUnconfirmed: true, reason: "delivery-started-no-replay" };
        if (controller.signal.aborted) {
          if (job.dropped) return { ok: true, skipped: true, reason: job.cancelReason || "dropped" };
          if (job.regenerationCount < this.config().maxRegenerations) {
            job.regenerationCount += 1;
            this.metrics.regenerated += 1;
            job.settleUntil = Date.now() + cfg.settleMs;
            continue;
          }
          return { ok: true, skipped: true, reason: job.cancelReason || "stale-context" };
        }
        throw err;
      } finally {
        if (job.deliveryStarted) for (const id of unique(job.deliveryMessageIds || job.messageIds)) {
          this.covered.set(coveredKey(job.logicalBotId, job.conversationId, id), Date.now() + Math.max(cfg.windowMs * 3, 60_000));
        }
        job.controller = null;
      }
    }
    return { ok: true, skipped: true, reason: job.cancelReason || "dropped" };
  }

  snapshot() {
    const active = [];
    let pending = 0;
    for (const state of this.states.values()) {
      pending += state.pending.length;
      if (state.active) active.push({
        conversationId: state.conversationId,
        logicalBotId: state.logicalBotId,
        jobId: state.active.id,
        mode: state.active.mode,
        senderId: state.active.senderId,
        accountId: state.active.accountId,
        regenerationCount: state.active.regenerationCount,
        mergedMessages: state.active.messageIds.length,
        startedAt: state.active.startedAt || 0
      });
    }
    return { active, activeCount: active.length, pending, ...this.metrics };
  }

  queuedConversationIds() {
    return unique([...this.states.values()].map((state) => state.conversationId));
  }
}
