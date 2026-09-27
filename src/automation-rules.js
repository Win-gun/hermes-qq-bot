// Pure rule helpers. Callers own persistence, authorization, execution and deduplication.
// Shape: { id, enabled?, timezone?, scope: { groupIds?, conversationIds? },
//   trigger: { type: "schedule", time: "HH:mm", daysOfWeek?, windowMinutes? }
//          | { type: "command", text: "/name" },
//   action: { kind: "message" | "summary" | "task" }, accountId?, prompt }

const MAX_RULES = 100;
const MAX_SCOPES = 100;
const MAX_PROMPT_LENGTH = 4000;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const COMMAND_PATTERN = /^\/[a-z][a-z0-9_-]{0,47}$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CONVERSATION_PATTERN = /^(group|private):([0-9]{1,20})$/;
const formatterCache = new Map();

function fail(message) {
  throw new TypeError(message);
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
  return value;
}

function knownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}.${key} is not supported`);
}

function canonicalConversationId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) value = String(value);
  if (typeof value !== "string") fail("conversationId must be a string or safe positive integer");
  const candidate = /^[0-9]{1,20}$/.test(value) ? `group:${value}` : value;
  const match = CONVERSATION_PATTERN.exec(candidate);
  if (!match || /^0+$/.test(match[2])) fail("conversationId must be a group ID, group:<id>, or private:<id>");
  return `${match[1]}:${match[2]}`;
}

function requiredText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    fail(`${label} must be nonempty text of at most ${maxLength} characters without control characters`);
  }
  return value.trim();
}

function timezone(value) {
  const zone = value === undefined ? "Asia/Shanghai" : requiredText(value, "timezone", 64);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
  } catch {
    fail(`invalid timezone: ${zone}`);
  }
  return zone;
}

function localParts(now, zone) {
  let formatter = formatterCache.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US-u-nu-latn", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    });
    formatterCache.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function dayOfWeek(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function previousDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function scheduleDate(rule, now) {
  if (rule.trigger.type !== "schedule") return null;
  const local = localParts(now, rule.timezone);
  const [hour, minute] = rule.trigger.time.split(":").map(Number);
  const target = hour * 60 + minute;
  const window = rule.trigger.windowMinutes;
  let date = null;
  if (local.minute >= target && local.minute - target < window) date = local.date;
  else if (target + window > 1440 && local.minute < target + window - 1440) date = previousDate(local.date);
  if (date === null || !rule.trigger.daysOfWeek.includes(dayOfWeek(date))) return null;
  return date;
}

function validatedDate(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) fail("now must be a valid date or timestamp");
  return date;
}

export function normalizeAutomationRule(input) {
  const rule = record(input, "rule");
  knownKeys(rule, ["id", "enabled", "timezone", "scope", "trigger", "action", "accountId", "prompt"], "rule");
  if (typeof rule.id !== "string" || !ID_PATTERN.test(rule.id)) fail("id must be 1-64 ASCII letters, digits, _ or -, starting with a letter");
  if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") fail("enabled must be boolean");

  const scope = record(rule.scope, "scope");
  knownKeys(scope, ["groupIds", "conversationIds"], "scope");
  const ids = [];
  for (const [field, entries] of [["groupIds", scope.groupIds], ["conversationIds", scope.conversationIds]]) {
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) fail(`scope.${field} must be an array`);
    for (const entry of entries) {
      const id = canonicalConversationId(entry);
      if (field === "groupIds" && !id.startsWith("group:")) fail("scope.groupIds may only contain groups");
      ids.push(id);
    }
  }
  const conversationIds = [...new Set(ids)];
  if (!conversationIds.length || conversationIds.length > MAX_SCOPES || ids.length > MAX_SCOPES) {
    fail(`scope requires 1-${MAX_SCOPES} explicit conversations`);
  }

  const trigger = record(rule.trigger, "trigger");
  let normalizedTrigger;
  if (trigger.type === "schedule") {
    knownKeys(trigger, ["type", "time", "daysOfWeek", "windowMinutes"], "trigger");
    if (typeof trigger.time !== "string" || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(trigger.time)) fail("trigger.time must be HH:mm (00:00-23:59)");
    const days = trigger.daysOfWeek === undefined ? [0, 1, 2, 3, 4, 5, 6] : trigger.daysOfWeek;
    if (!Array.isArray(days) || !days.length || days.length > 7 || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6) || new Set(days).size !== days.length) {
      fail("trigger.daysOfWeek must contain unique integers 0-6 (Sunday=0)");
    }
    const windowMinutes = trigger.windowMinutes === undefined ? 3 : trigger.windowMinutes;
    if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 15) fail("trigger.windowMinutes must be an integer from 1 to 15");
    normalizedTrigger = { type: "schedule", time: trigger.time, daysOfWeek: [...days].sort(), windowMinutes };
  } else if (trigger.type === "command") {
    knownKeys(trigger, ["type", "text"], "trigger");
    if (typeof trigger.text !== "string" || !COMMAND_PATTERN.test(trigger.text) || ["/bot", "/task", "/voice"].includes(trigger.text)) {
      fail("trigger.text must be a lowercase, argument-free slash command (excluding reserved bot commands)");
    }
    normalizedTrigger = { type: "command", text: trigger.text };
  } else fail("trigger.type must be schedule or command");

  const action = record(rule.action, "action");
  knownKeys(action, ["kind"], "action");
  if (!["message", "summary", "task"].includes(action.kind)) fail("action.kind must be message, summary or task");
  if (rule.accountId !== undefined && (typeof rule.accountId !== "string" || !ACCOUNT_PATTERN.test(rule.accountId))) fail("accountId must be a safe 1-64 character identifier");

  return {
    id: rule.id,
    enabled: rule.enabled ?? true,
    timezone: timezone(rule.timezone),
    scope: { conversationIds },
    trigger: normalizedTrigger,
    action: { kind: action.kind },
    ...(rule.accountId === undefined ? {} : { accountId: rule.accountId }),
    prompt: requiredText(rule.prompt, "prompt", MAX_PROMPT_LENGTH)
  };
}

export function validateAutomationRules(input) {
  const errors = [];
  const rules = [];
  if (!Array.isArray(input)) return { valid: false, rules, errors: [{ index: null, message: "rules must be an array" }] };
  if (input.length > MAX_RULES) errors.push({ index: null, message: `rules may contain at most ${MAX_RULES} items` });
  const seenIds = new Set();
  const commands = new Map();
  for (const [index, inputRule] of input.slice(0, MAX_RULES).entries()) {
    try {
      const rule = normalizeAutomationRule(inputRule);
      if (seenIds.has(rule.id)) errors.push({ index, message: `duplicate id: ${rule.id}` });
      seenIds.add(rule.id);
      if (rule.trigger.type === "command") {
        for (const conversationId of rule.scope.conversationIds) {
          const key = JSON.stringify([conversationId, rule.trigger.text]);
          if (commands.has(key)) errors.push({ index, message: `ambiguous command ${rule.trigger.text} in ${conversationId} (also rule ${commands.get(key)})` });
          else commands.set(key, rule.id);
        }
      }
      rules.push(rule);
    } catch (error) {
      errors.push({ index, message: error.message });
    }
  }
  return { valid: errors.length === 0, rules: errors.length === 0 ? rules : [], errors };
}

function checkedRules(input) {
  const result = validateAutomationRules(input);
  if (!result.valid) fail(result.errors.map((error) => `${error.index === null ? "rules" : `rule[${error.index}]`}: ${error.message}`).join("; "));
  return result.rules;
}

export function dueAutomationRules(now, rules, conversationId) {
  const date = validatedDate(now);
  const id = canonicalConversationId(conversationId);
  return checkedRules(rules).filter((rule) => rule.enabled && rule.scope.conversationIds.includes(id) && scheduleDate(rule, date) !== null);
}

export function matchAutomationCommand(text, rules, conversationId) {
  if (typeof text !== "string") fail("text must be a string");
  const id = canonicalConversationId(conversationId);
  const command = text.trim();
  return checkedRules(rules).filter((rule) => rule.enabled && rule.trigger.type === "command" && rule.scope.conversationIds.includes(id) && rule.trigger.text === command);
}

export function automationOccurrenceKey(rule, conversationId, now) {
  const normalized = normalizeAutomationRule(rule);
  const id = canonicalConversationId(conversationId);
  if (!normalized.scope.conversationIds.includes(id)) fail("conversationId is outside rule scope");
  const date = validatedDate(now);
  if (normalized.trigger.type === "schedule") {
    const occurrenceDate = scheduleDate(normalized, date);
    if (occurrenceDate === null) fail("schedule rule is not due at now");
    return JSON.stringify([normalized.id, id, occurrenceDate]);
  }
  // Command keys are time-based only; callers must use the inbound message ID for exact deduplication.
  return JSON.stringify([normalized.id, id, date.toISOString()]);
}
