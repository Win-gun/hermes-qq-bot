import { accountItems, accountGroup, effectiveAccount, accountScopeAllows } from "./account-registry.js";

const COMMANDS = new Set(["help", "status", "voice", "learn", "archive", "mode", "style", "quiet", "mute", "shutup", "resume", "unquiet", "unmute", "remember", "forget", "memory", "lively", "normal", "restrained"]);

export function botCommandText(text) {
  const clean = String(text || "").trim().replace(/^(?:\[引用消息\]\s*)+/u, "").trim();
  return /^\/bot(?:\s|$)/i.test(clean) ? clean : "";
}

export function botCommandAlias(index) {
  let result = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(97 + (n - 1) % 26) + result;
  return result;
}

// Count logical bots, not standby transports. A disconnected member keeps its
// alias while QQ still reports it in the group, so b never silently becomes a.
export function groupCommandBots(config, groupId, memberQqs, { selectedForGroup, connected, qqForAccount = (account) => account.qq }) {
  const present = new Set(memberQqs.map(String));
  const groups = new Set();
  const bots = [];
  for (const item of accountItems(config)) {
    const group = accountGroup(config, item.id);
    const key = group ? `group:${group.id}` : `account:${item.id}`;
    if (groups.has(key)) continue;
    groups.add(key);
    const members = group ? group.memberIds.map((id) => effectiveAccount(config, id)).filter(Boolean) : [effectiveAccount(config, item.id)];
    const eligible = members.filter((a) => !a.archived && a.enabled && accountScopeAllows(a, "group", groupId));
    if (!eligible.some((a) => present.has(String(qqForAccount(a))))) continue;
    const selectedId = group ? selectedForGroup(group) : item.id;
    const selected = eligible.find((a) => a.id === selectedId);
    const representative = selected || eligible[0];
    bots.push({ key, id: representative.id, name: representative.displayName || representative.id, qq: qqForAccount(representative),
      available: Boolean(selected && selected.protocolEnabled && present.has(String(qqForAccount(selected))) && connected(selected.id)),
      alias: botCommandAlias(bots.length) });
  }
  return bots;
}

export function routeBotCommand(text, bots) {
  const clean = botCommandText(text);
  if (!clean) return null;
  const args = clean.split(/\s+/).slice(1);
  const token = String(args[0] || "").toLowerCase();
  const target = bots.find((bot) => bot.alias === token);
  const selector = Boolean(target || (/^[a-z]{1,3}$/.test(token) && !COMMANDS.has(token)));
  const reporter = bots.find((bot) => bot.available);
  const list = bots.map((bot) => `/bot ${bot.alias} → ${bot.name}${bot.qq ? `（QQ ${bot.qq}）` : ""}${bot.available ? "" : "（暂不可用）"}`).join("\n");
  const help = `本群有 ${bots.length} 个机器人，请指定要控制的机器人：\n${list}\n例如：/bot a status、/bot b voice mixed。`;
  if (selector && !target) return { accountId: reporter?.id, notice: `未找到机器人「${token}」。\n${help}` };
  if (target && !target.available) return { accountId: reporter?.id, notice: `机器人 ${target.alias}「${target.name}」暂不可用，未执行指令。\n${list}` };
  if (!target && bots.length > 1) return { accountId: reporter?.id, notice: help };
  const selected = target || bots[0];
  return { accountId: selected?.id, text: `/bot ${target ? args.slice(1).join(" ") || "help" : args.join(" ") || "help"}`, targeted: Boolean(target), alias: target?.alias || "" };
}

export function botCommandFeedback(text, event) {
  return event?.__botCommandAlias ? String(text).replace(/\/bot(?=\s|$)/g, `/bot ${event.__botCommandAlias}`) : text;
}

export class GroupBotMembership {
  constructor({ ttlMs = 60_000, fallbackTtlMs = 2000 } = {}) {
    this.ttlMs = ttlMs; this.fallbackTtlMs = fallbackTtlMs;
    this.cache = new Map(); this.observed = new Map();
  }
  observe(groupId, qq) {
    const id = String(groupId), at = Date.now();
    const seen = this.observed.get(id) || new Map();
    seen.set(String(qq), at); this.observed.set(id, seen);
    for (const [gid, entries] of this.observed) {
      for (const [userId, time] of entries) if (at - time > 300_000) entries.delete(userId);
      if (!entries.size) this.observed.delete(gid);
    }
  }
  invalidate(groupId) { this.cache.delete(String(groupId)); this.observed.delete(String(groupId)); }
  isCurrent(groupId, snapshot) { return snapshot?.verified === true && this.cache.get(String(groupId))?.snapshot === snapshot; }
  async members(groupId, query) {
    const id = String(groupId), cached = this.cache.get(id);
    if (cached && cached.until > Date.now()) return cached.promise;
    const entry = { until: Infinity };
    entry.promise = Promise.resolve().then(query).then((data) => {
      if (!Array.isArray(data)) throw new Error("invalid group member list");
      const qqs = data.map((member) => String(member.user_id || "")).filter(Boolean);
      entry.until = Date.now() + this.ttlMs;
      return entry.snapshot = { qqs, verified: true };
    }).catch(() => {
      entry.until = Date.now() + this.fallbackTtlMs;
      return entry.snapshot = { qqs: [...(this.observed.get(id)?.keys() || [])], verified: false };
    });
    this.cache.set(id, entry);
    return entry.promise;
  }
}
