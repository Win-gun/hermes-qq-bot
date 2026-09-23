function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value == null ? [] : [value];
}

function unique(values) {
  return [...new Set(asArray(values).map(String).filter(Boolean))];
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

function messagesRelated(job, incoming) {
  const contexts = asArray(incoming.current?.replyContexts);
  const ids = new Set(unique(job.messageIds));
  if (contexts.some((item) => item?.isBot || ids.has(String(item?.messageId || "")))) return true;
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
  constructor({ config, log = () => {}, warn = () => {} } = {}) {
    this.getConfig = typeof config === "function" ? config : () => config || {};
    this.log = log;
    this.warn = warn;
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

  state(conversationId) {
    const key = String(conversationId || "unknown");
    if (!this.states.has(key)) this.states.set(key, { conversationId: key, active: null, pending: [] });
    return this.states.get(key);
  }

  pruneCovered() {
    const now = Date.now();
    for (const [id, expiresAt] of this.covered.entries()) if (expiresAt <= now) this.covered.delete(id);
  }

  isCovered(messageIds) {
    this.pruneCovered();
    return unique(messageIds).some((id) => this.covered.has(id));
  }

  observeMessage({ conversationId, senderId, current, event, messageIds = [], direct = false } = {}) {
    const cfg = this.config();
    if (!cfg.enabled || !cfg.liveEnabled) return { absorbed: false, contextUpdated: false };
    const state = this.states.get(String(conversationId || "unknown"));
    if (!state) return { absorbed: false, contextUpdated: false };
    const incoming = {
      senderId: String(senderId || ""), current, currentMessages: [current], event,
      messageIds: unique(messageIds), direct, maxMergedMessages: cfg.maxMergedMessages, settleMs: cfg.settleMs
    };
    const now = Date.now();
    const mergeTarget = [state.active, ...state.pending].find((job) => (
      job && !job.dropped && String(job.senderId) === incoming.senderId && now - Number(job.updatedAt || job.createdAt || 0) <= cfg.windowMs
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
    if (state.active && !state.active.dropped) {
      if (direct && cfg.cancelProactiveOnDirect && ["active", "proactive", "delayed"].includes(state.active.mode)) {
        this.cancelActive(state.active, "direct-message-preempted-proactive", { drop: true });
      } else if (messagesRelated(state.active, incoming)) {
        if (Number(state.active.regenerationCount || 0) >= cfg.maxRegenerations) {
          return { absorbed: false, contextUpdated: false, saturatedJobId: state.active.id };
        }
        state.active.contextRevision = Number(state.active.contextRevision || 0) + 1;
        state.active.updatedAt = now;
        if (state.active.controller) this.cancelActive(state.active, "related-context-updated", { drop: false });
        return { absorbed: false, contextUpdated: true, jobId: state.active.id };
      }
    }
    return { absorbed: false, contextUpdated: false };
  }

  cancelActive(job, reason, { drop = false } = {}) {
    if (!job) return;
    job.cancelReason = reason;
    job.dropped = drop || job.dropped;
    this.metrics.cancelled += 1;
    if (drop) this.metrics.dropped += 1;
    this.metrics.lastCancellationReason = reason;
    this.metrics.lastCancellationAt = Date.now();
    job.controller?.abort(reason);
  }

  enqueue(input = {}) {
    const cfg = this.config();
    const job = {
      ...input,
      id: String(input.id || `reply_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`),
      conversationId: String(input.conversationId || "unknown"),
      senderId: String(input.senderId || ""),
      mode: String(input.mode || "reply"),
      direct: input.direct === true,
      currentMessages: asArray(input.currentMessages || input.current),
      messageIds: unique(input.messageIds),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      contextRevision: 0,
      regenerationCount: 0,
      priority: Number(input.priority ?? modePriority(input.mode, input.direct)),
      dropped: false,
      preReplySent: false
    };
    if (this.isCovered(job.messageIds)) return Promise.resolve({ ok: true, skipped: true, reason: "covered" });
    const state = this.state(job.conversationId);
    const existing = [state.active, ...state.pending].find((item) => (
      item && !item.dropped && item.senderId === job.senderId && Date.now() - Number(item.updatedAt || item.createdAt) <= cfg.windowMs
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
    if (job.direct && cfg.cancelProactiveOnDirect) {
      state.pending = state.pending.filter((item) => {
        const drop = ["active", "proactive", "delayed"].includes(item.mode);
        if (drop) {
          this.metrics.dropped += 1;
          item.dropped = true;
          item.resolve?.({ ok: true, skipped: true, reason: "direct-job-preempted-proactive" });
        }
        return !drop;
      });
      if (state.active && !state.active.dropped && ["active", "proactive", "delayed"].includes(state.active.mode)) {
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
    if (state.active || !state.pending.length) return;
    const job = state.pending.shift();
    state.active = job;
    let outcome = { ok: true, skipped: true, reason: "dropped" };
    try {
      outcome = await this.runJob(job);
    } catch (err) {
      this.warn(`reply coordinator failed conversation=${state.conversationId} job=${job.id}: ${err.message}`);
      outcome = { ok: false, error: err.message };
    } finally {
      state.active = null;
      job.resolve?.(outcome);
      if (!state.pending.length) this.states.delete(state.conversationId);
      else queueMicrotask(() => this.pump(state));
    }
  }

  async runJob(job) {
    const cfg = this.config();
    while (!job.dropped) {
      const settle = Math.max(0, Number(job.settleUntil || 0) - Date.now());
      if (settle) await new Promise((resolve) => setTimeout(resolve, settle));
      const revision = Number(job.contextRevision || 0);
      const controller = new AbortController();
      job.controller = controller;
      job.startedAt = Date.now();
      this.log(`reply coordinator start conversation=${job.conversationId} mode=${job.mode} sender=${job.senderId} regeneration=${job.regenerationCount}`);
      try {
        const result = await job.execute({ job, signal: controller.signal, revision, regeneration: job.regenerationCount });
        if ((result?.retry || Number(job.contextRevision || 0) !== revision) && job.regenerationCount < cfg.maxRegenerations) {
          job.regenerationCount += 1;
          this.metrics.regenerated += 1;
          job.settleUntil = Date.now() + cfg.settleMs;
          continue;
        }
        if (result?.sent) {
          this.metrics.sent += 1;
          for (const id of unique(job.messageIds)) this.covered.set(id, Date.now() + Math.max(cfg.windowMs * 3, 60_000));
          if (cfg.minDelayMs) await new Promise((resolve) => setTimeout(resolve, cfg.minDelayMs));
        }
        return { ok: true, ...result, regenerationCount: job.regenerationCount };
      } catch (err) {
        if (controller.signal.aborted) {
          if (job.dropped) return { ok: true, skipped: true, reason: job.cancelReason || "dropped" };
          if (job.regenerationCount < cfg.maxRegenerations) {
            job.regenerationCount += 1;
            this.metrics.regenerated += 1;
            job.settleUntil = Date.now() + cfg.settleMs;
            continue;
          }
        }
        throw err;
      } finally {
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
        jobId: state.active.id,
        mode: state.active.mode,
        senderId: state.active.senderId,
        regenerationCount: state.active.regenerationCount,
        mergedMessages: state.active.messageIds.length,
        startedAt: state.active.startedAt || 0
      });
    }
    return { active, activeCount: active.length, pending, ...this.metrics };
  }

  queuedConversationIds() {
    return [...this.states.keys()];
  }
}
