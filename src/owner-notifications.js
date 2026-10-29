import { createHash, randomUUID } from "node:crypto";

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const RETENTION = 7 * DAY, MAX_OWNERS = 32, MAX_WINDOWS = 1024, MAX_CRITICAL = 8192;
const activeClaims = new Set(); // Liveness only; durable claims remain the authority.
const writerHealth = new WeakMap();
const publicErrors = new Set(["INVALID_POLICY", "INVALID_TIMEZONE", "INVALID_TIMES", "INVALID_RECIPIENTS", "INVALID_GRACE",
  "INVALID_CAP", "INVALID_CRITICAL", "INVALID_STATE", "INVALID_CALLBACK", "INVALID_CLOCK", "PERSISTENCE_UNCERTAIN"]
  .map(code => `OWNER_NOTIFICATIONS_${code}`));
const publicError = error => publicErrors.has(error?.code) ? error.code : "OWNER_NOTIFICATIONS_HOST_ERROR";
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const ownerId = value => typeof value === "string" && /^[1-9]\d{4,19}$/.test(value);
const codeId = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(value);
const issueId = value => typeof value === "string" && /^[A-Za-z0-9_:.-]{1,128}$/.test(value);
const stamp = value => typeof value === "number" ? value
  : value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const increment = value => Math.min((count(value) ?? 0) + 1, 1_000_000_000);

/** Pass ONLY the new ownerNotifications config section, never legacy
 * adminNotifications. Unknown fields (including text/prompts) are discarded.
 * Recipients here are candidates, NOT proof of authority; eligible() verifies.
 */
export function normalizeOwnerNotifications(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!object(raw)) fail("OWNER_NOTIFICATIONS_INVALID_POLICY");
  for (const key of ["enabled"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") fail("OWNER_NOTIFICATIONS_INVALID_POLICY");
  }
  const timezone = raw.timezone === undefined ? "Asia/Shanghai" : raw.timezone;
  if (typeof timezone !== "string" || !timezone || /^[+-]/.test(timezone)) fail("OWNER_NOTIFICATIONS_INVALID_TIMEZONE");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0); }
  catch { fail("OWNER_NOTIFICATIONS_INVALID_TIMEZONE"); }
  const times = raw.times === undefined ? ["09:00", "21:00"] : raw.times;
  if (!Array.isArray(times) || times.length < 1 || times.length > 2
    || times.some(time => typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
    || new Set(times).size !== times.length) fail("OWNER_NOTIFICATIONS_INVALID_TIMES");
  const recipients = raw.recipients === undefined ? [] : raw.recipients;
  if (!Array.isArray(recipients) || recipients.length > MAX_OWNERS || recipients.some(id => !ownerId(id))
    || new Set(recipients).size !== recipients.length) fail("OWNER_NOTIFICATIONS_INVALID_RECIPIENTS");
  const dueGraceMs = raw.dueGraceMs === undefined ? 10 * MINUTE : raw.dueGraceMs;
  if (!Number.isSafeInteger(dueGraceMs) || dueGraceMs < 1 || dueGraceMs > 10 * MINUTE) fail("OWNER_NOTIFICATIONS_INVALID_GRACE");
  if (raw.maxPerLocalDay !== undefined && raw.maxPerLocalDay !== 2) fail("OWNER_NOTIFICATIONS_INVALID_CAP");
  const critical = raw.critical === undefined ? {} : raw.critical;
  if (!object(critical) || (critical.enabled !== undefined && typeof critical.enabled !== "boolean")) fail("OWNER_NOTIFICATIONS_INVALID_CRITICAL");
  const codes = critical.codes === undefined ? [] : critical.codes;
  const cooldownMs = critical.cooldownMs === undefined ? HOUR : critical.cooldownMs;
  if (!Array.isArray(codes) || codes.length > 32 || codes.some(code => !codeId(code)) || new Set(codes).size !== codes.length
    || !Number.isSafeInteger(cooldownMs) || cooldownMs < HOUR || cooldownMs > RETENTION) fail("OWNER_NOTIFICATIONS_INVALID_CRITICAL");
  return { enabled: raw.enabled === true, timezone, times: [...times].sort(), recipients: [...recipients],
    maxPerLocalDay: 2, dueGraceMs,
    critical: { enabled: critical.enabled === true, codes: [...codes].sort(), cooldownMs } };
}

function local(at, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, ms: (+p.hour * 3600 + +p.minute * 60 + +p.second) * 1000 + at % 1000 };
}
function dueSlot(at, policy, slot) {
  const day = local(at, policy.timezone);
  const [hour, minute] = slot.split(":").map(Number);
  const elapsed = day.ms - (hour * 60 + minute) * MINUTE;
  return elapsed >= 0 && elapsed < policy.dueGraceMs ? day.date : null;
}
function stateOf(root) {
  const state = root?.ownerNotifications;
  if (state === undefined) return null;
  if (!object(state) || state.version !== 1 || !Array.isArray(state.windows) || !Array.isArray(state.critical)
    || !Array.isArray(state.events) || !state.windows.every(object) || !state.critical.every(object)
    || !state.events.every(object)) fail("OWNER_NOTIFICATIONS_INVALID_STATE");
  return state;
}
function writable(root) {
  return stateOf(root) ?? (root.ownerNotifications = { version: 1, windows: [], critical: [], events: [] });
}
const rowsOf = state => [...(state?.windows ?? []), ...(state?.critical ?? [])];
function currentDay(row, at, policy, date = local(at, policy.timezone).date) {
  // Keep the original day fence AND reproject absolute attempts into the current
  // timezone. Time/route changes cannot reset the owner's budget.
  return row.localDate === date || (Number.isFinite(row.claimedAt) && local(row.claimedAt, policy.timezone).date === date);
}
function prune(state, at, policy) {
  const date = local(at, policy.timezone).date;
  for (const name of ["windows", "critical"]) {
    state[name] = state[name].filter(row => !Number.isFinite(row.claimedAt) || at - row.claimedAt < RETENTION
      || currentDay(row, at, policy, date));
  }
  state.events = state.events.filter(row => row.localDate === date || !Number.isFinite(row.at) || at - row.at < RETENTION);
}

function summaryRange(value) {
  if (!object(value) || ![value.from, value.to].every(at => Number.isSafeInteger(at) && at >= 0
    && Number.isFinite(new Date(at).getTime())) || value.to < value.from
    || typeof value.timezone !== "string" || !value.timezone || value.timezone.length > 128 || /^[+-]/.test(value.timezone)) return null;
  try {
    const timezone = new Intl.DateTimeFormat("en", { timeZone: value.timezone }).resolvedOptions().timeZone;
    return { from: value.from, to: value.to, timezone };
  } catch { return null; }
}
function summaryDate(at, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23", timeZoneName: "longOffset" }).formatToParts(at);
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.${p.fractionalSecond} ${p.timeZoneName}`;
}

/** Genuine host event families only. Each entry is a machine code the host has
 * actually observed and may record in the operational ledger; the Chinese text
 * is a fixed description, never model output or event text. Adding a code here
 * is a description decision, NOT authority: severity, recipients and critical
 * alerting stay with the host's own events and config.
 */
export const OWNER_EVENT_CODES = Object.freeze({
  MODEL_CALL_FAILED: "模型调用失败",
  MODEL_TIMEOUT: "模型调用超时",
  ONEBOT_UNAVAILABLE: "OneBot 连接不可用",
  ONEBOT_SEND_FAILED: "OneBot 发送失败",
  STICKER_SEND_FAILED: "表情发送失败",
  PERMISSION_DENIED: "权限校验未通过",
  MEMORY_WRITE_FAILED: "记忆写入失败",
  MEMORY_WRITE_UNCERTAIN: "记忆写入结果不确定",
  CONFIG_INVALID: "配置校验失败",
  IDENTITY_UNVERIFIED: "身份核验未通过",
  PROTOCOL_AUTH_REQUIRED: "协议端需要重新登录",
  TASK_FAILED: "后台任务失败",
  TASK_INTERRUPTED: "后台任务被中断",
  OWNER_NOTIFICATIONS_PERSISTENCE_UNCERTAIN: "通知状态写入结果不确定",
  RESTART_UNCERTAIN: "重启后发送结果不确定",
});
/** Concise Chinese description for a known host code, or null. Unknown codes are
 * still shown as their machine identifier; no free-form text is ever echoed.
 */
export function describeOwnerEventCode(code) {
  return codeId(code) && Object.hasOwn(OWNER_EVENT_CODES, code) ? OWNER_EVENT_CODES[code] : null;
}
/** Host-side mapping from an actually observed failure family to a canonical
 * ledger code. Absence of a receipt, an unknown receipt and every success are
 * NOT failures and return null: never record an unproven outcome as a fault.
 */
export function ownerFailureEventCode(family, detail) {
  const table = {
    model: { failed: "MODEL_CALL_FAILED", timeout: "MODEL_TIMEOUT" },
    onebot: { unavailable: "ONEBOT_UNAVAILABLE", failed: "ONEBOT_SEND_FAILED" },
    sticker: { failed: "STICKER_SEND_FAILED" },
    permission: { denied: "PERMISSION_DENIED" },
    memory: { failed: "MEMORY_WRITE_FAILED", uncertain: "MEMORY_WRITE_UNCERTAIN" },
    config: { invalid: "CONFIG_INVALID" },
    identity: { unverified: "IDENTITY_UNVERIFIED" },
    protocol: { authRequired: "PROTOCOL_AUTH_REQUIRED" },
    task: { failed: "TASK_FAILED", interrupted: "TASK_INTERRUPTED" },
  };
  if (typeof family !== "string" || !Object.hasOwn(table, family)) return null;
  if (typeof detail !== "string" || !Object.hasOwn(table[family], detail)) return null;
  return table[family][detail];
}

/** Numeric/validated-calendar whitelist only. No task descriptions, model
 * output, errors, raw messages, credentials, URLs, account names or free-form
 * range/basis/pricing prose ever enter the summary/state.
 *
 * OPTIONAL trusted inputs (host-computed, never model prose) may be supplied
 * for a richer deterministic summary: period ("morning"/"evening"), lastNight
 * activity counters, people:{new}, blockers (operational events or already
 * folded {code,state} rows) and pendingOperations. Every one of them is
 * re-validated and re-projectable, so sanitize(safe) === safe still holds.
 */
export function sanitizeOwnerNotificationFacts(raw = {}) {
  const safeCounts = (value, keys) => Object.fromEntries(keys.map(key => [key, count(value?.[key])]));
  const array = value => Array.isArray(value) && value.length <= 1024 ? value : null;
  const accounts = array(raw?.accounts);
  const events = array(Array.isArray(raw?.events) ? raw.events : raw?.events?.ok === true ? raw.events.events : null);
  const stats = raw?.usage?.ok === true && object(raw.usage.stats) ? raw.usage.stats : null;
  const direct = raw?.usage;
  const completeness = value => typeof value === "boolean" ? value : null;
  const usageComplete = completeness(raw?.usage?.coverage?.complete ?? direct?.coverageComplete);
  const usage = stats ? {
    known: usageComplete !== false && stats.unknownCallCount === 0 && count(stats.tokens?.inputTokens?.total) !== null && count(stats.tokens?.outputTokens?.total) !== null,
    requests: count(stats.callCount), totalRequests: usageComplete === false ? null : count(stats.totalCallCount), coverageComplete: usageComplete,
    inputTokens: usageComplete === false ? null : count(stats.tokens?.inputTokens?.total), outputTokens: usageComplete === false ? null : count(stats.tokens?.outputTokens?.total),
    knownInputTokens: count(stats.tokens?.inputTokens?.knownTokens), knownOutputTokens: count(stats.tokens?.outputTokens?.knownTokens),
    unknownCalls: count(stats.unknownCallCount), pendingCalls: count(stats.pendingCallCount), uncertainCalls: count(stats.uncertainCallCount)
  } : { ...safeCounts(direct, ["requests", "totalRequests", "inputTokens", "outputTokens", "knownInputTokens", "knownOutputTokens", "unknownCalls", "pendingCalls", "uncertainCalls"]),
    known: usageComplete !== false && direct?.known === true, coverageComplete: usageComplete,
    ...(usageComplete === false ? { totalRequests: null, inputTokens: null, outputTokens: null } : {}) };
  const unresolvedComplete = completeness(raw?.events?.coverage?.complete ?? raw?.operational?.unresolvedCoverageComplete);
  const recordedUnresolved = count(raw?.operational?.recordedUnresolved) ?? count(raw?.operational?.unresolved)
    ?? (events && events.every(event => typeof event?.resolved === "boolean") ? events.filter(event => event.resolved === false).length : null);
  const interactionKeys = ["received", "sent", "groupMessages", "privateMessages"];
  const interaction = raw?.interactions;
  const interactionPartial = interaction?.unknown === true || interaction?.incomplete === true
    || ["partial", "not_started", "invalid"].includes(interaction?.coverage);
  const interactionComplete = !interactionPartial && (interaction?.coverage === "complete" || interaction?.complete === true)
    && count(interaction?.received) !== null && count(interaction?.sent) !== null;
  const observed = safeCounts(interaction?.observed ?? (interactionPartial ? null : interaction), interactionKeys);
  return { usage, timeRange: summaryRange(raw?.usage?.range ?? raw?.timeRange), accounts: accounts ? { total: accounts.length,
    online: accounts.filter(account => account?.status === "online").length,
    offline: accounts.filter(account => account?.status === "offline").length,
    unknown: accounts.filter(account => !["online", "offline"].includes(account?.status)).length }
    : safeCounts(raw?.accounts, ["total", "online", "offline", "unknown"]),
  tasks: { ...safeCounts(raw?.tasks, ["running", "waiting", "failed", "completed"]), waiting: count(raw?.tasks?.waiting ?? raw?.tasks?.queued) },
  operational: { ...safeCounts(raw?.operational, ["unresolved", "offlineAccounts", "interruptedTasks", "pendingOperations", "needsOwner"]),
    unresolved: unresolvedComplete === false ? null : count(raw?.operational?.unresolved) ?? recordedUnresolved,
    recordedUnresolved, unresolvedCoverageComplete: unresolvedComplete,
    offlineAccounts: count(raw?.operational?.offlineAccounts) ?? (accounts ? accounts.filter(account => account?.status === "offline").length : null),
    pendingOperations: count(raw?.operational?.pendingOperations) ?? count(raw?.pendingOperations)
      ?? (array(raw?.pendingOperations)?.length ?? null) },
  interactions: { ...safeCounts(interactionPartial ? null : interaction, interactionKeys), observed, complete: interactionComplete },
  period: raw?.period === "morning" || raw?.period === "evening" ? raw.period : null,
  lastNight: sanitizeLastNight(raw?.lastNight ?? raw?.sinceLastWindow),
  people: { new: count(raw?.people?.new ?? raw?.newPeople ?? raw?.operational?.newPeople) },
  blockers: sanitizeBlockers(raw?.blockers ?? events) };
}
const LAST_NIGHT_KEYS = ["modelCalls", "failedCalls", "received", "sent", "newPeople", "unresolvedEvents", "restoredEvents"];
function sanitizeLastNight(raw) {
  if (!object(raw)) return null;
  const safe = Object.fromEntries(LAST_NIGHT_KEYS.map(key => [key, count(raw[key])]));
  return LAST_NIGHT_KEYS.some(key => safe[key] !== null) ? safe : null;
}
const blockerState = value => value === "unresolved" || value === "restored" ? value
  : value === true ? "restored" : value === false ? "unresolved" : null;
/** Fold retained operational events (or already-folded rows) into per-code
 * current state. Unresolved wins: a later resolution must arrive as the SAME
 * single row (queryOperationalEvents currentOnly:true) to be reported restored,
 * so a pruned or reordered history can never silently look resolved.
 */
function sanitizeBlockers(raw) {
  const list = Array.isArray(raw) && raw.length <= 1024 ? raw : null;
  if (!list) return null;
  const folded = new Map();
  for (const item of list) {
    if (!object(item) || !codeId(item.code) || !Object.hasOwn(OWNER_EVENT_CODES, item.code)) continue;
    const state = blockerState(item.state ?? item.resolved);
    if (state === null) continue;
    if (folded.get(item.code) !== "unresolved") folded.set(item.code, state);
  }
  return folded.size ? [...folded.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([code, state]) => ({ code, state })) : null;
}
export function formatOwnerNotificationSummary(facts, { criticalCode } = {}) {
  const safe = sanitizeOwnerNotificationFacts(facts);
  const show = value => value === null ? "未知" : String(value);
  const lines = [codeId(criticalCode) ? `【主人通知 · 严重事件 ${criticalCode}】` : "【主人通知 · 定时摘要】",
    safe.timeRange ? `用量统计范围：[${summaryDate(safe.timeRange.from, safe.timeRange.timezone)}, ${summaryDate(safe.timeRange.to, safe.timeRange.timezone)})（${safe.timeRange.timezone}）`
      : "用量统计范围：未知（未提供有效时间范围）",
    "统计口径：仅本账本开始记录后的数据，按调用开始时间统计；未提供 token/费用为未知，不是 0。",
    `账号计数：在线 ${show(safe.accounts.online)}；离线 ${show(safe.accounts.offline)}；状态未知 ${show(safe.accounts.unknown)}`,
    `运行：已记录未解决 ${show(safe.operational.recordedUnresolved)}${safe.operational.unresolvedCoverageComplete === true ? "" : "（完整总数未知）"}；需主人处理 ${show(safe.operational.needsOwner)}；离线账号 ${show(safe.operational.offlineAccounts)}；中断任务 ${show(safe.operational.interruptedTasks)}；待处理操作 ${show(safe.operational.pendingOperations)}`,
    `任务计数：运行 ${show(safe.tasks.running)}；等待 ${show(safe.tasks.waiting)}；失败 ${show(safe.tasks.failed)}；完成 ${show(safe.tasks.completed)}`];
  const token = (total, known) => total !== null ? show(total) : known !== null ? `未知（已知计数 ${show(known)}）` : "未知";
  lines.push(`${safe.usage.known ? "用量计数" : "用量：未知或不完整"}：已记录请求 ${show(safe.usage.requests)}；完整请求总数 ${show(safe.usage.totalRequests)}；输入 token ${token(safe.usage.inputTokens, safe.usage.knownInputTokens)}；输出 token ${token(safe.usage.outputTokens, safe.usage.knownOutputTokens)}`);
  lines.push(`调用计数：用量未知 ${show(safe.usage.unknownCalls)}；未结算 ${show(safe.usage.pendingCalls)}；结果不确定 ${show(safe.usage.uncertainCalls)}`);
  lines.push("价格/费用：未知（未核实价格，不估算）。");
  lines.push(safe.interactions.complete ? `完整交互计数：收到 ${show(safe.interactions.received)}；发出 ${show(safe.interactions.sent)}`
    : `交互计数：已观测收到 ${show(safe.interactions.observed.received)}；发出 ${show(safe.interactions.observed.sent)}，完整总数未知。`);
  lines.push(safe.people.new !== null ? `新联系人计数：${show(safe.people.new)}` : "新联系人计数：未知（未提供有效计数）");
  if (safe.lastNight) {
    const morning = safe.period !== "evening";
    const part = key => safe.lastNight[key] === null ? "未知" : show(safe.lastNight[key]);
    lines.push(`${morning ? "昨夜活动" : "本时段活动"}：模型调用 ${part("modelCalls")}（失败 ${part("failedCalls")}）；收到消息 ${part("received")}；发出消息 ${part("sent")}；新增联系人 ${part("newPeople")}`);
    lines.push(`${morning ? "昨夜事件" : "本时段事件"}：未解决 ${part("unresolvedEvents")}；已恢复 ${part("restoredEvents")}`);
  }
  lines.push(safe.blockers ? `当前未解决事件：${safe.blockers.filter(item => item.state === "unresolved")
    .map(item => `${item.code}（${OWNER_EVENT_CODES[item.code]}）`).join("；") || "无"}`
    : "当前未解决事件：未知（未提供有效事件计数）");
  const restored = safe.blockers?.filter(item => item.state === "restored") ?? [];
  if (restored.length) lines.push(`已恢复事件：${restored.map(item => `${item.code}（${OWNER_EVENT_CODES[item.code]}）`).join("；")}`);
  lines.push("仅含计数；运行问题未解决时不会据此标记完成。详情请在本机控制台查看。");
  return lines.join("\n");
}

/** Read-only projection; no initialization, recovery, lock or pruning on query.
 * Unowned pending claims are already displayed uncertain before the next tick.
 */
export function getOwnerNotificationStatus(root, { now = Date.now() } = {}) {
  try {
    const state = stateOf(root);
    const counts = { claimed: 0, confirmed: 0, accepted: 0, failed: 0, uncertain: 0 };
    const rows = rowsOf(state);
    const visible = row => row.status === "claimed" && !activeClaims.has(row.claimId) ? "uncertain"
      : Object.hasOwn(counts, row.status) ? row.status : "uncertain";
    for (const row of rows) counts[visible(row)] += 1;
    return { version: 1, counts, eventCount: (state?.events ?? []).reduce((sum, row) => Math.min(sum + (count(row.total) ?? 0), 1_000_000_000), 0),
      recent: [...rows].sort((a, b) => b.claimedAt - a.claimedAt).slice(0, 50).map(row => ({
        kind: row.kind === "critical" ? "critical" : "window", ownerUserId: ownerId(row.ownerUserId) ? row.ownerUserId : null,
        localDate: /^\d{4}-\d\d-\d\d$/.test(row.localDate) ? row.localDate : null,
        slot: /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.slot) ? row.slot : null,
        status: visible(row), claimedAt: Number.isFinite(row.claimedAt) ? row.claimedAt : null,
        finishedAt: Number.isFinite(row.finishedAt) ? row.finishedAt : null,
        code: codeId(row.code) ? row.code : null,
        issueCode: codeId(row.issueCode) ? row.issueCode : null })), asOf: stamp(now) };
  } catch { return { version: 1, code: "OWNER_NOTIFICATIONS_INVALID_STATE" }; }
}

/** Integration contract (host callbacks, never model-selected authority):
 * read() -> published memory root; transact(syncDraftBuilder) -> durable result
 * (MemoryRuntime semantics); now() -> epoch ms, Date or ISO, defaults Date.now.
 * policy() -> ONLY the new config section accepted by normalize above.
 * eligible(ownerUserId, {kind, code?}) -> synchronous host guard:
 * { allowed:true, ownerVerified:true, private:true, online:true, revision:string,
 *   logicalBotId?:string, carrierId?:string }. Quiet/revocation/route checks
 * belong here. All returned guard fields must be JSON scalars, no secrets.
 * snapshot(ownerUserId) -> async {accounts:[{id,status:'online'|'offline'|...}],
 * usage:{...queryModelUsage(...),range:{from:epochMs,to:epochMs,timezone}},
 * events:queryOperationalEvents(...)|event[],
 * pendingOperations:number|array, tasks:{running,queued,failed?,completed?},
 * interactions:queryOwnerInteractions(...) or numeric counts, with optional
 * observed:{received?,sent?,groupMessages?,privateMessages?} lower bounds.
 * Incomplete ledger/event coverage never certifies full totals; unknown
 * interaction coverage shows observed counts only, never an invented zero.
 * operational:{needsOwner?:number,...}, timeRange?:{from,to,timezone}}.
 * Only numeric/enum/validated-range projections survive; usage.range takes
 * precedence over timeRange. All IDs, pricing and free-form prose are ignored.
 * The explicit numeric operational/usage projection above is also accepted.
 * send({ownerUserId,text,guard,hostGuard,claimId,kind,code?}) -> async receipt
 * {status:'confirmed'|'accepted'|'failed'|'uncertain'}. NOTHING else confirms.
 * guard() is sync and must ALSO be called by the host at its actual wire gate.
 * Accepted means transport acceptance ONLY, not delivery/completion.
 *
 * No timers, filesystem, new writer, model calls or automatic critical replay.
 * Same-process centers share liveness; orphan claims on tick become uncertain.
 * On persistence error the writer adapter is latched off for all centers until
 * the host recovers/recreates that adapter; no silent write retries.
 */
export function createOwnerNotificationCenter({ read, transact, now = Date.now, snapshot, send, eligible, policy } = {}) {
  for (const fn of [read, transact, now, snapshot, send, eligible, policy]) {
    if (typeof fn !== "function") fail("OWNER_NOTIFICATIONS_INVALID_CALLBACK");
  }
  if (!writerHealth.has(transact)) writerHealth.set(transact, { failed: false });
  const health = writerHealth.get(transact);
  let running = null;
  const atNow = () => {
    const at = stamp(now());
    if (!Number.isFinite(at) || at < 0 || !Number.isFinite(new Date(at).getTime())) fail("OWNER_NOTIFICATIONS_INVALID_CLOCK");
    return at;
  };
  const getPolicy = () => normalizeOwnerNotifications(policy());
  async function write(build) {
    if (health.failed) fail("OWNER_NOTIFICATIONS_PERSISTENCE_UNCERTAIN");
    try { return await transact(build); }
    catch { health.failed = true; fail("OWNER_NOTIFICATIONS_PERSISTENCE_UNCERTAIN"); }
  }
  function hostGuard(owner, context) {
    const guard = eligible(owner, context);
    if (!object(guard) || guard.allowed !== true || guard.ownerVerified !== true || guard.private !== true || guard.online !== true
      || typeof guard.revision !== "string" || !guard.revision || guard.revision.length > 128
      || Object.values(guard).some(value => value !== null && !["string", "boolean", "number"].includes(typeof value))) return null;
    return { ...guard };
  }
  function allowed(owner, context, expectedPolicy, expectedGuard) {
    if (health.failed) return false;
    try {
      const p = getPolicy();
      if (!p.enabled || !p.recipients.includes(owner) || digest(p) !== expectedPolicy) return false;
      if (context.kind === "critical" && (!p.critical.enabled || !p.critical.codes.includes(context.code))) return false;
      const current = hostGuard(owner, context);
      return current !== null && digest(current) === expectedGuard;
    } catch { return false; }
  }
  async function recover(p, at) {
    const state = stateOf(read());
    if (!state || !rowsOf(state).some(row => row.status === "claimed" && !activeClaims.has(row.claimId))) return;
    await write(root => {
      const latest = stateOf(root);
      for (const row of rowsOf(latest)) {
        if (row.status === "claimed" && !activeClaims.has(row.claimId)) {
          row.status = "uncertain"; row.finishedAt = at; row.code = "RESTART_UNCERTAIN";
        }
      }
      if (latest) prune(latest, at, p);
    });
  }
  async function attempt(owner, context, p) {
    const at = atNow(), date = local(at, p.timezone).date;
    if (context.kind === "window" && !dueSlot(at, p, context.slot)) return "NOT_DUE";
    if (context.kind === "critical" && (at < context.eventAt || at - context.eventAt >= p.dueGraceMs)) return "EXPIRED";
    const initialGuard = hostGuard(owner, context);
    if (!initialGuard) return "INELIGIBLE";
    const policyHash = digest(p), guardHash = digest(initialGuard);
    const key = digest(context.kind === "window" ? [owner, date, context.slot] : [owner, context.code, context.issueId]);
    const collection = context.kind === "window" ? "windows" : "critical";
    function available(state, currentAt) {
      const currentDate = local(currentAt, p.timezone).date;
      const retained = (state?.[collection] ?? []).filter(row => !Number.isFinite(row.claimedAt)
        || currentAt - row.claimedAt < RETENTION || currentDay(row, currentAt, p, currentDate));
      if (retained.some(row => row.key === key)) return false;
      if (context.kind === "window") return retained.length < MAX_WINDOWS
        && retained.filter(row => row.ownerUserId === owner && currentDay(row, currentAt, p, currentDate)).length < 2;
      return retained.length < MAX_CRITICAL && !retained.some(row => row.ownerUserId === owner
        && (!Number.isFinite(row.claimedAt) || currentAt - row.claimedAt < p.critical.cooldownMs));
    }
    // A read-only fast path avoids durable no-op commits on every polling tick;
    // the transaction MUST repeat all checks against its latest draft below.
    if (!available(stateOf(read()), at)) return "DEDUPED_OR_CAPPED";
    const claimId = randomUUID();
    activeClaims.add(claimId); // Before persistence await, so concurrent centers cannot recover a live claim.
    try {
      const claimed = await write(root => {
        if (!allowed(owner, context, policyHash, guardHash)) return false;
        const currentAt = atNow();
        if (context.kind === "window" ? dueSlot(currentAt, p, context.slot) !== date
          : currentAt < context.eventAt || currentAt - context.eventAt >= p.dueGraceMs) return false;
        const state = writable(root);
        prune(state, currentAt, p);
        if (!available(state, currentAt)) return false;
        state[collection].push({ key, claimId, kind: context.kind, ownerUserId: owner, localDate: date,
          ...(context.kind === "window" ? { slot: context.slot } : { issueHash: digest(context.issueId), issueCode: context.code }),
          claimedAt: currentAt, status: "claimed" });
        return true;
      });
      if (claimed !== true) return "DEDUPED_OR_CAPPED";
      // Verify durable publication, not merely a callback's return value.
      const guard = () => {
        if (!allowed(owner, context, policyHash, guardHash)) return false;
        try {
          const row = stateOf(read())?.[collection].find(item => item.key === key && item.claimId === claimId);
          const currentAt = atNow();
          return row?.status === "claimed" && (context.kind === "window" ? dueSlot(currentAt, p, context.slot) === date
            : currentAt >= context.eventAt && currentAt - context.eventAt < p.dueGraceMs);
        } catch { return false; }
      };
      let outcome = "failed", resultCode = "GUARD_BLOCKED";
      if (guard()) {
        let text;
        try { text = formatOwnerNotificationSummary(await snapshot(owner), { criticalCode: context.kind === "critical" ? context.code : undefined }); }
        catch { resultCode = "SNAPSHOT_FAILED"; }
        // AFTER the persistence AND snapshot awaits; host checks again at wire.
        if (text !== undefined && guard()) {
          outcome = "uncertain"; resultCode = "SEND_UNCERTAIN";
          try {
            const receipt = await send({ ownerUserId: owner, text, guard, hostGuard: { ...initialGuard }, claimId,
              kind: context.kind, ...(context.kind === "critical" ? { code: context.code } : {}) });
            if (object(receipt) && ["confirmed", "accepted", "failed", "uncertain"].includes(receipt.status)) outcome = receipt.status;
            resultCode = `SEND_${outcome.toUpperCase()}`;
          } catch { /* Unknown wire result consumes the claim and is never replayed. */ }
        }
      }
      await write(root => {
        const row = stateOf(root)?.[collection].find(item => item.key === key && item.claimId === claimId);
        if (row?.status === "claimed") { row.status = outcome; row.finishedAt = atNow(); row.code = resultCode; }
      });
      return resultCode;
    } finally { activeClaims.delete(claimId); }
  }
  async function tickOnce() {
    try {
      const p = getPolicy(), at = atNow();
      if (health.failed) return { code: "OWNER_NOTIFICATIONS_PERSISTENCE_UNCERTAIN" };
      await recover(p, at);
      if (!p.enabled) return { code: "DISABLED", results: [] };
      const results = [];
      for (const slot of p.times) {
        if (!dueSlot(atNow(), p, slot)) continue;
        for (const owner of p.recipients) results.push({ ownerUserId: owner, slot, code: await attempt(owner, { kind: "window", slot }, p) });
      }
      return { code: "TICK_COMPLETE", results };
    } catch (error) { return { code: publicError(error) }; }
  }
  async function ingestEvent(event) {
    try {
      const p = getPolicy(), at = atNow();
      if (!p.enabled) return { code: "DISABLED" };
      // Host-authored events only. Source strings are not authentication: callers
      // must never expose this method as a model tool or accept model event data.
      if (!object(event) || event.source !== "host" || !Number.isFinite(stamp(event.at))
        || stamp(event.at) > at || at - stamp(event.at) >= p.dueGraceMs) return { code: "INVALID_OR_EXPIRED_EVENT" };
      await recover(p, at);
      await write(root => {
        const state = writable(root);
        prune(state, at, p);
        const date = local(at, p.timezone).date;
        let bucket = state.events.find(row => row.localDate === date);
        // Hard bound even on rapid timezone churn; never evict today's dedupe.
        if (!bucket && state.events.length < 32) { bucket = { localDate: date, at, total: 0, critical: 0 }; state.events.push(bucket); }
        if (bucket) { bucket.total = increment(bucket.total); if (event.severity === "critical") bucket.critical = increment(bucket.critical); }
      });
      if (event.severity !== "critical" || !p.critical.enabled || !p.critical.codes.includes(event.code) || !issueId(event.issueId)) {
        return { code: "AGGREGATED", results: [] };
      }
      const results = [];
      for (const owner of p.recipients) results.push({ ownerUserId: owner, code: await attempt(owner,
        { kind: "critical", code: event.code, issueId: event.issueId, eventAt: stamp(event.at) }, p) });
      return { code: "CRITICAL_COMPLETE", results };
    } catch (error) { return { code: publicError(error) }; }
  }
  return {
    tick() { if (!running) running = tickOnce().finally(() => { running = null; }); return running; },
    ingestEvent,
    status() {
      try { return { ...getOwnerNotificationStatus(read(), { now: atNow() }), running: Boolean(running), persistenceUncertain: health.failed }; }
      catch (error) { return { code: publicError(error), running: Boolean(running), persistenceUncertain: health.failed }; }
    }
  };
}
