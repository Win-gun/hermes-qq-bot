// Pure compatibility helpers: no disk, memory, model calls, scheduling or sends.
// Routines own the configuration; legacy fields are detached runtime projections.
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clone = (value) => structuredClone(value);
const DAILY_FIELDS = ["enabled", "windowMinutes", "requireKnownGroup", "checkIntervalMs", "accountId", "groupId"];
const SCHEDULE_FIELDS = ["name", "mode", "time", "prompt", "enabled", "requireHistory"];
const HOURLY_FIELDS = ["enabled", "prompt", "checkIntervalMs", "ownerUserIds", "accountId", "groupId"];

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function keys(value, allowed, label) {
  object(value, label);
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TypeError(`${label} contains unsupported fields`);
}

function pick(value, fields) {
  const result = {};
  for (const key of fields) if (own(value, key)) {
    const item = value[key];
    if (key === "ownerUserIds" && Array.isArray(item)) {
      result[key] = item.filter((id) => typeof id === "string" || Number.isSafeInteger(id));
    } else if (item === null || ["string", "number", "boolean"].includes(typeof item)) result[key] = item;
  }
  return result; // Never expose unknown nested objects through an allowlisted field.
}

const text = (value, fallback = "") => typeof value === "string" && value ? value : fallback;

const oldScheduleKey = (schedule) => String((own(schedule, "legacyLedgerKey") && schedule.legacyLedgerKey)
  || schedule.name || schedule.mode || schedule.time || "daily");

// Pass the complete schedule array from the same runtime projection. Retain
// explicit frozen keys and unambiguous old keys for existing dailySent records;
// duplicate names/modes need time plus occurrence, not the shared mode alone.
export function dailyScheduleLedgerKey(schedule, schedules = [schedule]) {
  if (own(schedule, "legacyLedgerKey") && schedule.legacyLedgerKey) return String(schedule.legacyLedgerKey);
  const base = oldScheduleKey(schedule);
  const siblings = schedules.filter((item) => oldScheduleKey(item) === base);
  // Raw legacy entries may already have IDs, but the old executor ignored
  // them. Prefer its unambiguous key even then, or an occupied day re-sends.
  if (siblings.length < 2 && !own(Object.prototype, base) && base !== "prototype") return base;
  if (own(schedule, "id") && typeof schedule.id === "string" && schedule.id) return `daily:id:${JSON.stringify(schedule.id)}`;
  const index = schedules.indexOf(schedule);
  if (index < 0) throw new TypeError("schedule must belong to its schedule array");
  const time = String(schedule.time || "");
  const occurrence = schedules.slice(0, index).filter((item) => oldScheduleKey(item) === base && String(item.time || "") === time).length;
  return `daily:${JSON.stringify([base, time, occurrence])}`;
}

function syncProjection(config) {
  for (const [source, legacy] of [["daily", "dailyMessages"], ["hourly", "hourlyChat"]]) {
    if (own(config.automation.routines, source)) config[legacy] = clone(config.automation.routines[source]);
    else delete config[legacy]; // An authoritative missing source cannot resurrect a stale projection.
  }
  return config;
}

export function normalizeAutomationRoutines(config) {
  object(config, "config");
  const next = clone(config);
  if (!own(next, "automation")) next.automation = {};
  object(next.automation, "automation");
  if (!own(next.automation, "routines")) {
    next.automation.routines = { version: 1 };
    for (const [source, legacy] of [["daily", "dailyMessages"], ["hourly", "hourlyChat"]]) {
      if (own(next, legacy)) next.automation.routines[source] = clone(object(next[legacy], legacy));
    }
  }
  const routines = object(next.automation.routines, "routines");
  if (routines.version !== 1) throw new TypeError("unsupported routines version");
  for (const source of ["daily", "hourly"]) if (own(routines, source)) object(routines[source], source);
  return syncProjection(next);
}

export function legacyRoutineConfig(config) {
  const next = normalizeAutomationRoutines(config);
  // The old hourly executor treats missing `enabled` as enabled. Only ABSENT
  // sources get explicit disabled runtime placeholders; existing defaults stay intact.
  if (!own(next.automation.routines, "daily")) next.dailyMessages = { enabled: false, schedules: [] };
  if (!own(next.automation.routines, "hourly")) next.hourlyChat = { enabled: false };
  return next;
}

// Only this allowlisted view (never the lossless internal snapshots) is public.
// Prompt text follows the existing prompt-management API; never log this view.
export function publicAutomationRoutines(config) {
  const { routines } = normalizeAutomationRoutines(config).automation;
  const view = { version: 1 };
  if (own(routines, "daily")) {
    view.daily = pick(routines.daily, DAILY_FIELDS);
    if (Array.isArray(routines.daily.schedules)) {
      view.daily.schedules = routines.daily.schedules.map((schedule) => pick(object(schedule, "schedule"), SCHEDULE_FIELDS));
    }
  }
  if (own(routines, "hourly")) view.hourly = pick(routines.hourly, HOURLY_FIELDS);
  return view;
}

export function routineCatalog(config) {
  const next = normalizeAutomationRoutines(config);
  const { daily, hourly } = next.automation.routines;
  const dynamic = (next.targetGroups || []).some((id) => ["*", "all", "ALL"].includes(String(id)));
  const target = (source) => ({
    ...pick(source, ["accountId", "groupId"]),
    targetLabel: text(source.accountId, text(source.groupId, "原路由")),
    senderStrategy: source.accountId ? "指定账号；不复制规则或改变会话范围"
      : source.groupId ? "指定接管组，由现有路由解析发送者；不改变会话范围"
        : "保留原执行器路由，不推断账号或接管组"
  });
  const catalog = [];
  if (daily) for (const [index, schedule] of (daily.schedules || []).entries()) {
    object(schedule, "schedule");
    catalog.push({
      id: `daily-${index}`, kind: "daily", index,
      ...pick(schedule, ["name"]),
      time: text(schedule.time, null),
      enabled: daily.enabled !== false && schedule.enabled !== false,
      sourceEnabled: daily.enabled !== false, scheduleEnabled: schedule.enabled !== false,
      prompt: text(schedule.prompt, text(schedule.instruction, `${text(schedule.name, text(schedule.mode, text(schedule.time, "daily")))} 定时消息`)),
      mode: text(schedule.mode, text(schedule.name, text(schedule.time, "daily"))),
      requireHistory: Boolean(schedule.requireHistory),
      requireKnownGroup: daily.requireKnownGroup !== false,
      windowMinutes: Number(daily.windowMinutes || 3),
      checkIntervalMs: Number(daily.checkIntervalMs || 60_000),
      ...target(daily),
      scopeStrategy: dynamic ? "兼容动态已见群范围；仍按原 targetGroups、known-group 和 quiet 检查"
        : "沿用原 targetGroups 和 quiet 检查；不新增群或私聊",
      risks: ["保留系统本地时区和旧 dailySent 键；不转成新 automation.rules",
        ...(dynamic ? ["动态群范围保留兼容执行，不冻结为当前群列表"] : []),
        ...(schedule.requireHistory ? ["仍要求原执行器内存中存在历史，不从存档补造"] : [])]
    });
  }
  if (hourly) catalog.push({
    id: "hourly", kind: "hourly", time: null,
    enabled: hourly.enabled !== false, sourceEnabled: hourly.enabled !== false,
    prompt: text(hourly.prompt, "现在时间 {{time}}。给你的主人发一条简短私聊。"),
    mode: null, requireHistory: false, windowMinutes: null,
    checkIntervalMs: Number(hourly.checkIntervalMs || 60_000),
    ...target(hourly),
    scopeStrategy: "沿用原 ownerUserIds；为空时沿用 adminNotifications.recipients，不新增接收人",
    risks: ["兼容一小时经过时间策略，不改为整点 cron", "保留进程共享冷却、失败/跳过冷却和重启重置语义"]
  });
  return catalog;
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}

function prompt(value) {
  if (typeof value !== "string" || value.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new TypeError("prompt must be text of at most 4000 characters without control characters");
  }
  return value; // Empty text deliberately restores the original executor's fallback.
}

function updateTarget(target, patch, config) {
  for (const key of ["accountId", "groupId"]) if (own(patch, key)) {
    if (patch[key] === null) delete target[key];
    else {
      if (typeof patch[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(patch[key])) {
        throw new TypeError("invalid routine sender identifier");
      }
      target[key] = patch[key];
    }
  }
  if (own(target, "accountId") && own(target, "groupId")) throw new TypeError("choose one routine sender: accountId or groupId");
  for (const [key, collection] of [["accountId", config.accounts?.items], ["groupId", config.accounts?.failoverGroups]]) {
    if (own(target, key) && (!Array.isArray(collection) || !collection.some((item) => item?.id === target[key] && !item.archived))) {
      throw new TypeError("routine sender must exist and must not be archived");
    }
  }
}

// PATCH input is { version?: 1, daily?: {...}, hourly?: {...} }.
// daily.schedules is a sparse EDIT list, not replacement: [{id:"daily-0", ...}].
// Identity, mode, scopes, recipients, intervals and unknown fields are not editable.
export function patchAutomationRoutines(current, input) {
  keys(input, ["version", "daily", "hourly"], "routines patch");
  if (own(input, "version") && input.version !== 1) throw new TypeError("unsupported routines version");
  const next = normalizeAutomationRoutines(current);
  const { routines } = next.automation;
  for (const kind of ["daily", "hourly"]) {
    if (!own(input, kind)) continue;
    if (!own(routines, kind)) throw new TypeError("cannot create a missing legacy routine source");
    const patch = input[kind];
    keys(patch, kind === "daily"
      ? ["enabled", "windowMinutes", "requireKnownGroup", "schedules", "accountId", "groupId"]
      : ["enabled", "prompt", "accountId", "groupId"], `${kind} patch`);
    const target = routines[kind];
    if (own(patch, "enabled")) target.enabled = boolean(patch.enabled, "enabled");
    if (own(patch, "prompt")) target.prompt = prompt(patch.prompt);
    if (own(patch, "requireKnownGroup")) target.requireKnownGroup = boolean(patch.requireKnownGroup, "requireKnownGroup");
    if (own(patch, "windowMinutes")) {
      if (!Number.isInteger(patch.windowMinutes) || patch.windowMinutes < 1 || patch.windowMinutes > 1440) {
        throw new TypeError("windowMinutes must be an integer from 1 to 1440");
      }
      target.windowMinutes = patch.windowMinutes;
    }
    updateTarget(target, patch, next);
    if (own(patch, "schedules")) {
      if (!Array.isArray(patch.schedules) || !Array.isArray(target.schedules) || patch.schedules.length > target.schedules.length) {
        throw new TypeError("schedules must only edit existing entries");
      }
      const seen = new Set();
      for (const edit of patch.schedules) {
        keys(edit, ["id", "time", "prompt", "enabled", "requireHistory"], "schedule patch");
        if (typeof edit.id !== "string" || !/^daily-(0|[1-9][0-9]*)$/.test(edit.id) || seen.has(edit.id)) {
          throw new TypeError("schedule id must identify one existing entry without duplicates");
        }
        const schedule = target.schedules[Number(edit.id.slice(6))];
        if (!schedule) throw new TypeError("cannot create a new schedule");
        object(schedule, "schedule");
        seen.add(edit.id);
        if (own(edit, "time")) {
          if (typeof edit.time !== "string" || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(edit.time)) {
            throw new TypeError("time must be HH:mm (00:00-23:59)");
          }
          // Freeze every sibling before changing time: moving one duplicate
          // must not renumber another duplicate into its already-claimed key.
          const ledgerKeys = target.schedules.map((entry) => dailyScheduleLedgerKey(entry, target.schedules));
          for (const [index, entry] of target.schedules.entries()) entry.legacyLedgerKey ||= ledgerKeys[index];
          schedule.time = edit.time;
        }
        if (own(edit, "prompt")) schedule.prompt = prompt(edit.prompt);
        if (own(edit, "enabled")) schedule.enabled = boolean(edit.enabled, "enabled");
        if (own(edit, "requireHistory")) schedule.requireHistory = boolean(edit.requireHistory, "requireHistory");
      }
    }
  }
  return syncProjection(next);
}

// Optional dry run for a preview endpoint. Never returns the internal config.
export function previewAutomationRoutines(config) {
  const catalog = routineCatalog(config);
  return {
    version: 1,
    needed: !own(config.automation || {}, "routines"),
    plan: ["将已有来源完整快照为 routines；缺失来源不创建", "同步旧字段投影，继续单一旧执行器", "不修改 scope、风格、记忆、存档或 ledger"],
    catalog,
    risks: [...new Set(catalog.flatMap((entry) => entry.risks))]
  };
}
