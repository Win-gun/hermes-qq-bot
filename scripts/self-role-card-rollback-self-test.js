import assert from "node:assert/strict";
import { applySelfRoleCard, getSelfRoleCard, rollbackSelfRoleCard, selfRoleCardPrompt } from "../src/self-role-card.js";

// Pure in-memory fixtures: no runtime, accounts, files, clocks or external calls.
const NOW = 1_800_000_000_000, DAY = 86_400_000;
const ID = "account:fixture", PEER = "account:peer";
const POLICY = { enabled: true, autoGrow: false, minUpdateIntervalMs: DAY, maxVersions: 32 };
const base = { logicalId: ID, policy: POLICY };
let scenarios = 0, assertions = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); assertions++; };
const same = (a, b, message) => { assert.strictEqual(a, b, message); assertions++; };
const yes = (value, message) => { assert.ok(value, message); assertions++; };
const throws = (fn, code) => { assert.throws(fn, { code: `ROLE_CARD_${code}` }); assertions++; };
function check(name, fn) { fn(); scenarios++; console.log(`PASS ${name}`); }
const card = (root, id = ID) => root.socialAgents.bots[id].selfRoleCard;
const view = root => getSelfRoleCard(root, { logicalId: ID });
function append(root, fields, extra = {}) {
  const old = getSelfRoleCard(root, { logicalId: extra.logicalId ?? ID });
  const result = applySelfRoleCard(root, { ...base, expectedRevision: old.revision, fields, explicit: true,
    reason: "真实互动形成的偏好", evidenceMessageIds: [`source:${old.revision + 1}`], now: NOW + old.revision, ...extra });
  yes(result.ok, JSON.stringify(result));
  return result;
}
function fixture() {
  const root = { untouched: { preserve: true }, socialAgents: { version: 1, bots: {
    [ID]: { conversations: { untouched: true }, profile: { identity: "固定核心" }, growthFrozen: true },
    [PEER]: { unrelated: ["preserve"] },
  } } };
  append(root, { expression: "自然清楚" });
  append(root, { interests: "天文" });
  append(root, { examples: "围绕当前话题交流" });
  return root;
}
const rollbackArgs = (root, extra = {}) => ({ ...base, expectedRevision: view(root).revision,
  targetRevision: 1, now: NOW + 3, actor: { authorized: true }, ...extra });
const rollback = (root, extra = {}) => rollbackSelfRoleCard(root, rollbackArgs(root, extra));
function rejected(root, args, suffix) {
  const before = structuredClone(root);
  const refs = () => [root?.socialAgents, root?.socialAgents?.bots, root?.socialAgents?.bots?.[ID], root?.socialAgents?.bots?.[ID]?.selfRoleCard];
  const oldRefs = refs(), result = rollbackSelfRoleCard(root, args);
  eq(result, { ok: false, code: `ROLE_CARD_${suffix}` });
  eq(root, before, "every rejected rollback is atomic");
  refs().forEach((ref, i) => same(ref, oldRefs[i], "rejections preserve container identities"));
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

check("pure removal restores exact keys, appends audit metadata and original evidence", () => {
  const root = fixture(), prior = structuredClone(card(root)), input = rollbackArgs(root), inputBefore = structuredClone(input);
  const result = rollbackSelfRoleCard(root, input);
  yes(result.ok); eq(result.revision, 4); eq(input, inputBefore);
  eq(card(root).fields, { expression: "自然清楚" });
  eq(Object.keys(card(root).fields), ["expression"], "later interests/examples must be absent, not merged or blanked");
  eq(card(root).versions.slice(0, 3), prior.versions); eq(card(root).versions.length, 4);
  eq(card(root).versions[3], { revision: 4, fields: { expression: "自然清楚" }, reason: "管理员回滚至版本 1",
    evidenceMessageIds: ["source:1"], at: NOW + 3, operation: "rollback", sourceRevision: 1 });
  eq(view(root), result.card);
  yes(card(root).fields !== card(root).versions[3].fields, "current fields do not alias the new snapshot");
  yes(card(root).fields !== card(root).versions[0].fields, "restored fields do not alias their source");
  yes(card(root).versions[3].evidenceMessageIds !== card(root).versions[0].evidenceMessageIds);
  const prompt = selfRoleCardPrompt(root, { logicalId: ID });
  yes(prompt.includes("自然清楚")); yes(!prompt.includes("天文")); yes(!prompt.includes("围绕当前话题交流"));
  yes(!prompt.includes("sourceRevision")); yes(!prompt.includes("管理员回滚"));
});

check("old immutable snapshots, container identity and other logical bots remain untouched", () => {
  const root = fixture(); append(root, { expression: "其他账号" }, { logicalId: PEER });
  const bot = root.socialAgents.bots[ID], agents = root.socialAgents, bots = agents.bots;
  const peer = bots[PEER], peerBefore = structuredClone(peer), conversations = bot.conversations, profile = bot.profile;
  const old = card(root), oldBefore = structuredClone(old), oldVersions = [...old.versions];
  freeze(old);
  const result = rollback(root); yes(result.ok); eq(old, oldBefore);
  same(root.socialAgents, agents); same(root.socialAgents.bots, bots); same(bots[ID], bot); same(bots[PEER], peer);
  same(bot.conversations, conversations); same(bot.profile, profile); eq(peer, peerBefore);
  oldVersions.forEach((version, i) => same(card(root).versions[i], version));
  eq(root.untouched, { preserve: true }); eq(bot.growthFrozen, true, "administrator rollback must not unfreeze unrelated policy");
  result.card.fields.expression = "outside mutation";
  result.card.versions[0].fields.expression = "outside history mutation";
  result.card.versions[3].sourceRevision = 999; result.card.versions[3].evidenceMessageIds.push("outside");
  eq(card(root).fields.expression, "自然清楚"); eq(card(root).versions[3].sourceRevision, 1);
  eq(card(root).versions[3].evidenceMessageIds, ["source:1"]); eq(old, oldBefore);
});

check("apply after rollback merges only restored fields; rollback versions may be targets", () => {
  const root = fixture(); yes(rollback(root).ok);
  const history = structuredClone(card(root).versions);
  const applied = append(root, { interests: "历史" }, { now: NOW + 4 });
  eq(applied.revision, 5); eq(view(root).fields, { expression: "自然清楚", interests: "历史" });
  eq(card(root).versions.slice(0, 4), history);
  eq(Object.keys(card(root).versions[4]), ["revision", "fields", "reason", "evidenceMessageIds", "at"], "ordinary apply retains legacy version shape");
  const again = rollback(root, { targetRevision: 4, now: NOW + 5 }); yes(again.ok);
  eq(again.revision, 6); eq(again.card.fields, history[3].fields); eq(again.card.versions[5].sourceRevision, 4);
  const restoreLaterSnapshot = rollback(root, { targetRevision: 3, now: NOW + 6 }); yes(restoreLaterSnapshot.ok);
  eq(restoreLaterSnapshot.card.fields, history[2].fields); eq(restoreLaterSnapshot.revision, 7);
});

check("exact old whitespace, empty field presence and property ordering survive", () => {
  const root = {};
  append(root, { examples: "", interests: " 天文 \n", expression: " 自然\t表达 " });
  append(root, { examples: "后加示例", expression: "新的表达" });
  const result = rollback(root, { expectedRevision: 2, now: NOW + 2 }); yes(result.ok);
  eq(result.card.fields, { expression: " 自然\t表达 ", interests: " 天文 \n", examples: "" });
  eq(Object.keys(result.card.fields), ["expression", "interests", "examples"]);
  eq(view(root).versions[2].fields, view(root).versions[0].fields);
});

check("exact CAS; replay does not append or overwrite concurrent apply", () => {
  const root = fixture(), stale = rollbackArgs(root);
  append(root, { expression: "并发的最新表达" }, { now: NOW + 3 });
  rejected(root, stale, "REVISION_CONFLICT");
  const input = rollbackArgs(root, { now: NOW + 4 }); yes(rollbackSelfRoleCard(root, input).ok);
  rejected(root, input, "REVISION_CONFLICT");
  for (const expectedRevision of [undefined, null, "5", -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    rejected(root, rollbackArgs(root, { expectedRevision }), "INVALID_REVISION");
  }
  for (const expectedRevision of [0, 4, 6, Number.MAX_SAFE_INTEGER]) {
    rejected(root, rollbackArgs(root, { expectedRevision }), "REVISION_CONFLICT");
  }
});

check("no rollback zero, future, missing, current or same-fields older revision", () => {
  const root = fixture();
  for (const targetRevision of [undefined, null, "1", 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 4, Number.MAX_SAFE_INTEGER]) {
    rejected(root, rollbackArgs(root, { targetRevision }), "INVALID_TARGET_REVISION");
  }
  rejected(root, rollbackArgs(root, { targetRevision: 3 }), "NO_CHANGE");
  yes(rollback(root).ok);
  rejected(root, rollbackArgs(root), "NO_CHANGE");
  rejected(root, rollbackArgs(root, { targetRevision: 4 }), "NO_CHANGE");
  for (const absent of [{}, { socialAgents: {} }, { socialAgents: { version: 1, bots: {} } },
    { socialAgents: { version: 1, bots: { [ID]: { unrelated: true } } } }]) {
    rejected(absent, { ...base, expectedRevision: 0, targetRevision: 1, now: NOW, actor: { authorized: true } }, "INVALID_TARGET_REVISION");
  }
  rejected(root, rollbackArgs(root, { logicalId: PEER, expectedRevision: 0 }), "INVALID_TARGET_REVISION");
});

check("strict enabled policy; unknown/malformed policy cannot bypass any gate", () => {
  const root = fixture();
  for (const policy of [undefined, {}, { enabled: false, autoGrow: true }, { enabled: false, maxVersions: 64 }]) {
    rejected(root, rollbackArgs(root, { policy }), "DISABLED");
  }
  for (const policy of [null, [], true, "enabled", { enabled: 1 }, { enabled: undefined },
    { enabled: true, autoGrow: "true" }, { enabled: true, minUpdateIntervalMs: 0 }, { enabled: true, maxVersions: 65 },
    ...["unknown", "force", "explicit", "admin", "freeze", "frozen", "growthFrozen", "bypass", "ignoreCapacity", "targetRevision"]
      .map(key => ({ enabled: true, [key]: true })), JSON.parse('{"enabled":true,"__proto__":{}}'),
    Object.create({ enabled: true }), Object.defineProperty({ enabled: true }, "unknown", { value: true }),
    { enabled: true, [Symbol("policy")]: true }]) {
    rejected(root, rollbackArgs(root, { policy }), "INVALID_POLICY");
  }
  let getters = 0;
  const policy = Object.defineProperty({}, "enabled", { enumerable: true, get() { getters++; return true; } });
  rejected(root, rollbackArgs(root, { policy }), "INVALID_POLICY"); eq(getters, 0);
  const nullPolicy = Object.assign(Object.create(null), { enabled: true });
  yes(rollback(root, { policy: nullPolicy }).ok, "autoGrow/cooldown do not gate an explicit authorized rollback");
});

check("administrator host authorization is exact and cannot be inferred", () => {
  const root = fixture();
  for (const actor of [undefined, null, [], true, "admin", {}, { authorized: false }, { authorized: "true" },
    { authorized: 1 }, { authorized: true, role: "admin" }, Object.create({ authorized: true }),
    JSON.parse('{"authorized":true,"__proto__":{}}'), { authorized: true, [Symbol("actor")]: true },
    Object.defineProperty({}, "authorized", { value: true })]) {
    rejected(root, rollbackArgs(root, { actor }), "UNAUTHORIZED");
  }
  let getters = 0;
  const actor = Object.defineProperty({}, "authorized", { enumerable: true, get() { getters++; return true; } });
  rejected(root, rollbackArgs(root, { actor }), "UNAUTHORIZED"); eq(getters, 0);
  const input = rollbackArgs(root); delete input.actor; rejected(root, input, "UNAUTHORIZED");
});

check("timestamp monotonicity and explicit cooldown bypass stay unchanged", () => {
  const root = fixture();
  for (const now of [undefined, null, "now", 0, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, NOW + 1]) {
    rejected(root, rollbackArgs(root, { now }), "INVALID_TIME");
  }
  yes(rollback(root, { now: NOW + 2 }).ok, "equal last timestamp is permitted, even within cooldown");
  const result = rollback(root, { targetRevision: 3, now: Number.MAX_SAFE_INTEGER }); yes(result.ok);
  eq(view(root).versions.at(-1).at, Number.MAX_SAFE_INTEGER);
});

check("automatic apply after rollback uses the new version timestamp and normal policy gates", () => {
  const root = fixture(); yes(rollback(root).ok);
  const request = { ...base, expectedRevision: 4, fields: { interests: "历史" },
    reason: "后续互动偏好", evidenceMessageIds: ["source:later"], policy: { enabled: true, autoGrow: true },
    now: NOW + 3 + DAY - 1 };
  const before = structuredClone(root);
  eq(applySelfRoleCard(root, request), { ok: false, code: "ROLE_CARD_COOLDOWN" }); eq(root, before);
  eq(applySelfRoleCard(root, { ...request, policy: { enabled: true } }), { ok: false, code: "ROLE_CARD_AUTO_GROW_DISABLED" }); eq(root, before);
  const result = applySelfRoleCard(root, { ...request, now: NOW + 3 + DAY }); yes(result.ok);
  eq(result.revision, 5); eq(result.card.fields, { expression: "自然清楚", interests: "历史" });
  eq(result.card.versions.slice(0, 4), before.socialAgents.bots[ID].selfRoleCard.versions);
});

check("capacity/reduced cap never prunes or overwrites history", () => {
  for (const maxVersions of [1, 2, 3]) {
    const root = fixture();
    rejected(root, rollbackArgs(root, { policy: { enabled: true, maxVersions } }), "CAPACITY");
  }
  const root = {};
  for (let i = 0; i < 63; i++) append(root, { expression: `合法版本 ${i}` }, { policy: { enabled: true, maxVersions: 64 } });
  const old = structuredClone(card(root));
  yes(rollback(root, { now: NOW + 63, policy: { enabled: true, maxVersions: 64 } }).ok);
  eq(card(root).revision, 64); eq(card(root).versions.slice(0, 63), old.versions);
  rejected(root, rollbackArgs(root, { targetRevision: 2, now: NOW + 64, policy: { enabled: true, maxVersions: 64 } }), "CAPACITY");
  eq(view(root).versions.length, 64);
});

check("reforged rollback metadata/fields/noop references are not valid history", () => {
  const corruptions = [
    c => { c.versions[3].sourceRevision = 0; }, c => { c.versions[3].sourceRevision = -1; },
    c => { c.versions[3].sourceRevision = "1"; }, c => { c.versions[3].sourceRevision = 4; },
    c => { c.versions[3].sourceRevision = 5; }, c => { c.versions[3].sourceRevision = 2; },
    c => { c.versions[3].operation = "apply"; }, c => { c.versions[3].operation = undefined; },
    c => { delete c.versions[3].operation; }, c => { delete c.versions[3].sourceRevision; },
    c => { delete c.versions[3].operation; delete c.versions[3].sourceRevision; },
    c => { c.versions[3].fields = { expression: "伪造的恢复字段" }; c.fields = structuredClone(c.versions[3].fields); },
    c => { c.versions[3].fields = {}; c.fields = {}; },
    c => { c.versions[3].fields.interests = "新发明字段"; c.fields.interests = "新发明字段"; },
    c => { c.versions[3].fields = structuredClone(c.versions[2].fields); c.fields = structuredClone(c.versions[2].fields); c.versions[3].sourceRevision = 3; },
    c => { c.versions[0].operation = "rollback"; c.versions[0].sourceRevision = 1; },
    c => { c.versions[1].sourceRevision = 1; }, c => { c.versions[1].operation = "apply"; },
    c => { c.versions[3].extra = true; }, c => { c.versions[3].at = NOW + 1; },
    c => { c.versions[3].evidenceMessageIds = []; }, c => { c.versions[3].reason = ""; },
  ];
  for (const mutate of corruptions) {
    const root = fixture(); yes(rollback(root).ok); mutate(card(root));
    rejected(root, { ...base, expectedRevision: 4, targetRevision: 2, now: NOW + 5, actor: { authorized: true } }, "INVALID_STATE");
    throws(() => view(root), "INVALID_STATE");
    const before = structuredClone(root);
    eq(applySelfRoleCard(root, { ...base, expectedRevision: 4, fields: { expression: "不能修复伪造历史" },
      now: NOW + 5, explicit: true, reason: "安全拒绝", evidenceMessageIds: ["source:new"] }), { ok: false, code: "ROLE_CARD_INVALID_STATE" });
    eq(root, before);
  }
});

check("legacy snapshots accept exact original shape and keep their deletion guard", () => {
  const root = fixture(), old = structuredClone(card(root));
  eq(view(root), old);
  for (const v of old.versions) eq(Object.keys(v), ["revision", "fields", "reason", "evidenceMessageIds", "at"]);
  yes(rollback(root).ok); eq(view(root).versions.slice(0, old.versions.length), old.versions);
  const bad = fixture(); delete card(bad).versions[2].fields.interests; delete card(bad).fields.interests;
  rejected(bad, { ...base, expectedRevision: 3, targetRevision: 1, now: NOW + 3, actor: { authorized: true } }, "INVALID_STATE");
});

check("invalid scope/arguments/prototypes and accessor inputs never write", () => {
  const root = fixture();
  for (const logicalId of [undefined, "", "fixture", "account:constructor", "account:__proto__", "group:prototype", "private:123", "account:a.b"]) {
    rejected(root, rollbackArgs(root, { logicalId }), "INVALID_LOGICAL_ID");
  }
  for (const extra of [{ fields: { expression: "new" } }, { reason: "injected" }, { evidenceMessageIds: ["model"] },
    { explicit: true }, { force: true }, { frozen: false }, { operation: "rollback" }, { sourceRevision: 1 },
    { [Symbol("extra")]: true }, JSON.parse('{"__proto__":{}}')]) {
    rejected(root, { ...rollbackArgs(root), ...extra }, "INVALID_ARGS");
  }
  for (const args of [null, [], Object.create(rollbackArgs(root)), Object.defineProperty(rollbackArgs(root), "extra", { value: true })]) {
    rejected(root, args, "INVALID_ARGS");
  }
  let getters = 0;
  const args = Object.defineProperty(rollbackArgs(root), "targetRevision", { enumerable: true, get() { getters++; return 1; } });
  rejected(root, args, "INVALID_ARGS"); eq(getters, 0);
  eq({}.polluted, undefined);
});

check("read-only slots reject atomically; sealed writable slots publish once", () => {
  const root = fixture(); Object.defineProperty(root.socialAgents.bots[ID], "selfRoleCard", { writable: false });
  rejected(root, rollbackArgs(root), "NOT_WRITABLE");
  const frozenBot = fixture(); Object.freeze(frozenBot.socialAgents.bots[ID]);
  rejected(frozenBot, rollbackArgs(frozenBot), "NOT_WRITABLE");
  const sealed = fixture(); Object.seal(sealed.socialAgents.bots[ID]); yes(rollback(sealed).ok); eq(view(sealed).revision, 4);
  const accessor = fixture(), before = structuredClone(accessor); let getters = 0;
  Object.defineProperty(accessor.socialAgents.bots[ID], "selfRoleCard", { enumerable: true, configurable: true,
    get() { getters++; return before.socialAgents.bots[ID].selfRoleCard; } });
  eq(rollbackSelfRoleCard(accessor, { ...base, expectedRevision: 3, targetRevision: 1, now: NOW + 3, actor: { authorized: true } }),
    { ok: false, code: "ROLE_CARD_INVALID_STATE" });
  eq(getters, 0); yes(Object.getOwnPropertyDescriptor(accessor.socialAgents.bots[ID], "selfRoleCard").get);
});

console.log(`self-role-card-rollback: PASS (${scenarios} scenarios, ${assertions} assertions; ${process.version}; in-memory only)`);
