import { createHash } from "node:crypto";

const text = value => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\[CQ:/gi, "［CQ：");
const cut = (value, length = 160) => text(value).slice(0, length);
const asTime = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const day = value => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_:-]{1,160}$/.test(value);

/** Display text is NEVER executable OneBot CQ data. Inputs must already have
 * passed the production privacy filter; no raw archive content is loaded here.
 */
export function formatVerificationNotice(item) {
  const old = item.oldMemory || {};
  const fresh = item.newMemory || {};
  return ["【记忆核实】不是认定任何人说错，请核对：",
    `编号 ${cut(item.id, 100)} · 群 ${cut(item.conversationId, 80)} · 当事人 ${cut(item.subjectUserId, 40)}`,
    `旧记录：${cut(old.value)}（${cut(old.sentAt || old.lastConfirmedAt || "时间未知", 40)}）`,
    `新消息候选：${cut(fresh.value)}（${cut(fresh.sentAt || "时间未知", 40)}）`,
    "update 更新版本；coexist 有条件共存；new_invalid 新消息非有效依据；old_invalid 旧记忆有误；unsure 暂不确定。",
    `回复：/bot memory resolve ${cut(item.id, 100)} <选项> ${cut(item.revision, 100)}`,
    "共存时在末尾填写明确条件。也可到控制台「记忆 → 待核实」查看证据。"
  ].join("\n");
}

/** Bounded, durable at-most-one-attempt notification dispatcher. All authority,
 * account policy and quiet checks are injected and repeated at the wire boundary.
 * A claimed/uncertain receipt survives restart and is NOT automatically retried.
 * No timers/models/IO, no secondary storage writer, no global group broadcast.
 */
export function createMemoryVerificationNotifier({ getMemory, getSettings, listCases, transact,
  selectRoute, canNotify, send, prepare = async () => {}, clock = () => new Date().toISOString() }) {
  for (const fn of [getMemory, getSettings, listCases, transact, selectRoute, canNotify, send, clock]) {
    if (typeof fn !== "function") throw new TypeError("MEMORY_NOTIFICATION_INVALID_CALLBACK");
  }
  let running = null;
  let scanOffset = 0;
  const metrics = { attempts: 0, sent: 0, uncertain: 0, blocked: 0, lastCode: "" };
  const enabled = settings => settings?.enabled === true && settings.shadowMode === false;
  const groupState = (root, id) => root.groups?.[id]?.memoryVerification;
  const eligible = (item, root, settings, now) => {
    if (!enabled(settings) || !item || item.status !== "pending" || item.notificationReady === false || !/^\d{5,20}$/.test(item.conversationId)
      || !safeId(item.id) || !safeId(String(item.revision))) return false;
    const at = asTime(now), created = asTime(item.createdAt);
    if (at === null || created === null || created > at || at - created >= settings.deferAfterMs) return false;
    const receipts = groupState(root, item.conversationId)?.notifications || [];
    if (!Array.isArray(receipts) || receipts.some(row => row.caseId === item.id)) return false;
    const daily = receipts.filter(row => asTime(row.at) !== null && day(row.at) === day(now));
    if (daily.length >= settings.perGroupDailyLimit) return false;
    if (receipts.some(row => row.subjectUserId === item.subjectUserId
      && asTime(row.at) !== null && at - asTime(row.at) < settings.cooldownMs)) return false;
    // Also bound the receiver's total volume across busy groups. All attempts,
    // including uncertain/blocked ones, consume the budget.
    return true;
  };
  const current = (root, item) => listCases(root, { conversationId: item.conversationId, caseId: item.id, status: "pending" })
    .cases?.find(row => row.id === item.id && row.revision === item.revision);
  async function sweep() {
    const initialSettings = getSettings();
    if (!enabled(initialSettings)) return { skipped: true, code: "OBSERVATION_ONLY" };
    try { await prepare(); } catch { metrics.lastCode = "PREPARE_FAILED"; return { code: metrics.lastCode }; }
    const now = clock();
    let page = listCases(getMemory(), { status: "pending", offset: scanOffset, limit: 100 });
    if (!page.cases?.length && scanOffset > 0) {
      scanOffset = 0;
      page = listCases(getMemory(), { status: "pending", offset: 0, limit: 100 });
    }
    const cases = page.cases || [];
    // Rotate across groups and blocked/already-notified cases. Persisted claims,
    // not this ephemeral scan cursor, are the duplicate-delivery authority.
    scanOffset = page.pagination?.hasMore ? page.pagination.nextOffset : 0;
    // One notice per sweep, bounded candidate inspection. No per-message model.
    for (const item of cases.slice(0, 100)) {
      let settings = getSettings();
      if (!eligible(item, getMemory(), settings, now)) continue;
      const route = selectRoute(item, settings);
      if (!route || !/^\d{5,20}$/.test(String(route.recipientId)) || !safeId(route.accountId)
        || !canNotify(item, route, getMemory(), settings)) continue;
      const guardKey = hash([settings, route.accountId, route.recipientId, route.revision]);
      const allowed = root => {
        const live = getSettings();
        const selected = selectRoute(item, live);
        return enabled(live) && selected && hash([live, selected.accountId, selected.recipientId, selected.revision]) === guardKey
          && current(root, item) && canNotify(item, route, root, live);
      };
      const ticket = hash([item.conversationId, item.id, item.revision, route.accountId, route.recipientId]);
      let claim;
      try {
        claim = await transact(root => {
          settings = getSettings();
          if (!eligible(item, root, settings, clock()) || !allowed(root)) return false;
          const all = Object.values(root.groups || {}).flatMap(group => group.memoryVerification?.notifications || []);
          const recipientToday = all.filter(row => row.recipientId === String(route.recipientId)
            && asTime(row.at) !== null && day(row.at) === day(now)).length;
          if (recipientToday >= 10) return false;
          const state = groupState(root, item.conversationId);
          if (!state) return false;
          state.notifications ||= [];
          state.notifications.push({ ticket, caseId: item.id, caseRevision: item.revision,
            subjectUserId: item.subjectUserId, accountId: route.accountId,
            recipientId: String(route.recipientId), at: now, status: "claimed" });
          return true;
        });
      } catch { metrics.lastCode = "CLAIM_FAILED"; return { code: metrics.lastCode }; }
      if (!claim) continue;
      metrics.attempts += 1;
      let status = "uncertain";
      try {
        if (!allowed(getMemory())) status = "blocked";
        else status = await send(route, formatVerificationNotice(item), () => allowed(getMemory())) ? "sent" : "uncertain";
      } catch { /* A wire error is uncertain; never replay this receipt. */ }
      metrics[status] += 1;
      metrics.lastCode = status === "sent" ? "SENT" : status === "blocked" ? "POLICY_CHANGED" : "SEND_UNCERTAIN";
      try {
        await transact(root => {
          const receipt = groupState(root, item.conversationId)?.notifications?.find(row => row.ticket === ticket);
          if (receipt?.status === "claimed") { receipt.status = status; receipt.finishedAt = clock(); }
        });
      } catch { metrics.lastCode = "RECEIPT_UNCERTAIN"; }
      return { code: metrics.lastCode };
    }
    return { skipped: true, code: "NO_ELIGIBLE_CASE" };
  }
  return {
    run() { if (!running) running = sweep().finally(() => { running = null; }); return running; },
    status() { return { ...metrics, running: Boolean(running), scanOffset }; }
  };
}
