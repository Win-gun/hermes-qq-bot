import assert from "node:assert/strict";
import { ingestSocialMessage } from "../src/social-agent-state.js";
import { proposePersonaChanges, claimPersonaProposal, settlePersonaProposal,
  publicPersonaProposals } from "../src/social-persona-proposals.js";

// Fake in-memory fixtures only: no config, files, network, model or QQ sends.
const now = Date.UTC(2026, 9, 23, 4), DAY = 86_400_000;
const logicalId = "account:fixture", conversationId = "group:100", userId = "123";
const scope = { logicalId, conversationId, userId, now };
const actor = { id: "local-admin", authorized: true };
const baseProfile = { identity: "原有身份", selfName: "原名", expression: "", interests: "",
  boundaries: "原有边界", examples: "" };
const change = (field = "selfName", value = "新名字", ids = ["source-1"]) =>
  ({ field, value, evidenceMessageIds: ids });
function fixture() {
  const root = { unrelated: { keep: true }, profile: structuredClone(baseProfile) };
  for (const [messageId, extra] of [["source-1", {}], ["source-2", {}], ["other-user", { userId: "456" }],
    ["quote", { isQuoted: true }]]) {
    assert.equal(ingestSocialMessage(root, { ...scope, message: { messageId, userId, text: `raw fixture ${messageId}`,
      sentAt: now - 1000, receivedAt: now, ...extra } }).ok, true);
  }
  return root;
}
const options = extra => ({ ...scope, changes: [change()], baseProfile, ...extra });
const bot = root => root.socialAgents.bots[logicalId];
const messages = root => bot(root).conversations[conversationId].messages;
let checks = 0;
function unchanged(root, action, reason) {
  const before = structuredClone(root);
  const result = action();
  assert.equal(result.ok, false, JSON.stringify(result));
  if (reason) assert.equal(result.reason, reason);
  assert.deepEqual(root, before, "every rejection must be atomic");
  checks++;
}
function pending(root = fixture(), extra = {}) {
  const result = proposePersonaChanges(root, options(extra));
  assert.equal(result.ok, true, JSON.stringify(result));
  return { root, result, args: { logicalId, id: result.id, expectedRevision: 1, actor, now, currentProfile: baseProfile } };
}

// Exact interface + no automatic persona mutation + immutable stored evidence.
const input = options({ baseProfile: structuredClone(baseProfile),
  changes: [change("examples", "示例"), change("selfName", "新名字", ["source-2", "source-1", "source-1"])] });
const root = fixture(), original = structuredClone(root), inputBefore = structuredClone(input);
const result = proposePersonaChanges(root, input);
assert.equal(result.ok, true);
assert.equal(result.revision, 1);
assert.equal(result.proposal.status, "pending");
assert.deepEqual(input, inputBefore);
assert.deepEqual(root.profile, original.profile);
assert.deepEqual(root.unrelated, original.unrelated);
const stored = bot(root).personaProposals[0];
assert.equal(stored.baseProfileHash.length, 64);
assert.deepEqual(stored.baseProfile, baseProfile);
assert.equal(stored.evidence[0].text, "raw fixture source-1");
messages(root)[0].text = "later edited";
assert.equal(stored.evidence[0].text, "raw fixture source-1");
input.changes[0].value = "outside";
input.baseProfile.identity = "outside";
assert.equal(stored.changes.find(item => item.field === "examples").value, "示例");
assert.equal(stored.baseProfile.identity, "原有身份");

// Public whitelist excludes all snapshots, arbitrary state and evidence bodies.
stored.internalSecret = "NEVER PUBLIC";
const projected = publicPersonaProposals(root, logicalId);
assert.equal(projected.length, 1);
assert.deepEqual(projected[0].changes, stored.changes);
assert(!JSON.stringify(projected).includes("raw fixture"));
assert(!JSON.stringify(projected).includes("NEVER PUBLIC"));
assert(!Object.hasOwn(projected[0], "baseProfile"));
projected[0].changes[0].value = "outside";
projected[0].evidence[0].messageId = "outside";
assert.notEqual(stored.changes[0].value, "outside");
assert.equal(stored.evidence[0].messageId, "source-1");
assert.deepEqual(publicPersonaProposals({}, logicalId), []);
const empty = {};
publicPersonaProposals(empty, logicalId);
assert.deepEqual(empty, {});

// Canonical IDs ignore order, duplicates, timestamp and base profile changes.
const d = fixture();
const first = proposePersonaChanges(d, options({ changes: [change("selfName", "名", ["source-2", "source-1"]), change("identity", "身份")] }));
const beforeDuplicate = structuredClone(d);
const replay = proposePersonaChanges(d, options({ now: now + 100, baseProfile: { ...baseProfile, identity: "变更后" },
  changes: [change("identity", "身份"), change("selfName", "名", ["source-1", "source-2", "source-1"])] }));
assert.equal(replay.id, first.id);
assert.equal(replay.duplicate, true);
assert.deepEqual(d, beforeDuplicate);
assert.equal(proposePersonaChanges(fixture(), options({ changes: [change("identity", "身份"),
  change("selfName", "名", ["source-1", "source-2"])] })).id, first.id);

// Entire batch rejects unknown/ambiguous/malformed evidence, bot/quote and QQ mismatches.
for (const ids of [["missing"], ["other-user"], ["quote"], ["source-1", "missing"]]) {
  const state = fixture();
  unchanged(state, () => proposePersonaChanges(state, options({ changes: [change("identity", "有效"), change("selfName", "名", ids)] })), "invalid_source");
}
for (const mutate of [m => { m.isBot = true; }, m => { delete m.isQuoted; }, m => { m.isQuoted = "false"; },
  m => { m.userId = 123; }, m => { m.text = null; }, m => { m.sentAt = now + 1; },
  m => { m.sentAt = now - DAY - 1; }, m => { m.receivedAt = now + 1; },
  m => { m.sentAt = m.receivedAt + 1; }, m => { m.conversationId = "group:200"; },
  m => { m.quote = "quoted source"; }]) {
  const state = fixture(); mutate(messages(state)[0]);
  unchanged(state, () => proposePersonaChanges(state, options()), "invalid_source");
}
const ambiguous = fixture(); messages(ambiguous).push(structuredClone(messages(ambiguous)[0]));
unchanged(ambiguous, () => proposePersonaChanges(ambiguous, options()), "invalid_source");
for (const extra of [{ logicalId: "account:other" }, { conversationId: "group:200" }, { userId: "456" },
  { conversationId: "private:456" }, { userId: 123 }, { now: NaN }]) {
  const state = fixture(); unchanged(state, () => proposePersonaChanges(state, options(extra)));
}
const edge = fixture(); messages(edge)[0].sentAt = now - DAY;
assert.equal(proposePersonaChanges(edge, options()).ok, true);
// The same wire ID elsewhere is NOT evidence for the addressed conversation/bot.
const isolated = fixture();
bot(isolated).conversations["group:200"] = structuredClone(bot(isolated).conversations[conversationId]);
isolated.socialAgents.bots["account:other"] = structuredClone(bot(isolated));
messages(isolated).splice(0, 1);
unchanged(isolated, () => proposePersonaChanges(isolated, options()), "invalid_source");
const elsewhere = proposePersonaChanges(isolated, options({ logicalId: "account:other" }));
assert.equal(elsewhere.ok, true);
assert.deepEqual(publicPersonaProposals(isolated, logicalId), []);
assert.equal(publicPersonaProposals(isolated, "account:other").length, 1);
const privateRoot = fixture();
bot(privateRoot).conversations[`private:${userId}`] = structuredClone(bot(privateRoot).conversations[conversationId]);
assert.equal(proposePersonaChanges(privateRoot, options({ conversationId: `private:${userId}` })).ok, true);
const aggregate = fixture();
for (let i = 0; i < 33; i++) messages(aggregate).push({ ...structuredClone(messages(aggregate)[0]), messageId: `extra-${i}` });
unchanged(aggregate, () => proposePersonaChanges(aggregate, options({ changes: [change("identity", "一", Array.from({ length: 32 }, (_, i) => `extra-${i}`)),
  change("selfName", "二", ["extra-32"])] })), "invalid_source");

// Strict change/profile schema, limits, sparse arrays and atomic validation.
for (const changes of [[], [change("prompt")], [change("constructor")], [change("selfName", "")],
  [change("identity", "a".repeat(801))], [change("examples", "a".repeat(2001))],
  [change("selfName", {})], [change("selfName", "name", [])], [change("selfName", "name", [123])],
  [change("selfName", "name", new Array(1))], [change(), change()], [{ ...change(), profile: "escape" }],
  [{ field: "identity", value: "valid" }], [change("identity", "a\u0000b")], new Array(1)]) {
  const state = fixture(); unchanged(state, () => proposePersonaChanges(state, options({ changes })), "invalid_changes");
}
for (const bad of [null, [], { identity: 123 }, { prompt: "escape" }, { examples: "a".repeat(2001) }]) {
  const state = fixture(); unchanged(state, () => proposePersonaChanges(state, options({ baseProfile: bad })), "invalid_profile");
}
const limits = fixture();
assert.equal(proposePersonaChanges(limits, options({ changes: [change("identity", "a".repeat(800)), change("examples", "a".repeat(2000))] })).ok, true);

// Claim CAS, hash insertion-order independence, exact actor, no retries.
const p = pending();
for (const extra of [{ expectedRevision: undefined }, { expectedRevision: 2 }, { actor: null },
  { actor: { id: "local-admin", authorized: false } }, { actor: { id: "local-admin", authorized: true, role: "admin" } },
  { currentProfile: { ...baseProfile, identity: "stale" } }, { now: now - 1 }, { id: Symbol("bad") }]) {
  unchanged(p.root, () => claimPersonaProposal(p.root, { ...p.args, ...extra }));
}
const claimed = claimPersonaProposal(p.root, { ...p.args, currentProfile: Object.fromEntries(Object.entries(baseProfile).reverse()) });
assert.equal(claimed.ok, true);
assert.equal(claimed.revision, 2);
assert.equal(claimed.proposal.status, "applying");
assert.equal(claimed.proposal.changes[0].value, "新名字");
assert.deepEqual(bot(p.root).personaProposals[0].claim.currentProfile, baseProfile);
unchanged(p.root, () => claimPersonaProposal(p.root, p.args), "stale_revision");
unchanged(p.root, () => claimPersonaProposal(p.root, { ...p.args, expectedRevision: 2 }), "invalid_status");
const otherPending = proposePersonaChanges(p.root, options({ changes: [change("identity", "其他提案")] }));
unchanged(p.root, () => claimPersonaProposal(p.root, { ...p.args, id: otherPending.id }), "application_in_progress");
const recovered = structuredClone(p.root);
assert.equal(publicPersonaProposals(recovered, logicalId)[0].status, "applying");
unchanged(recovered, () => claimPersonaProposal(recovered, { ...p.args, expectedRevision: 2 }), "invalid_status");

// Settle: mandatory exact CAS and same admin; terminal records cannot reopen.
const settleArgs = { ...p.args, expectedRevision: 2, status: "approved" };
for (const extra of [{ expectedRevision: undefined }, { expectedRevision: 1 }, { status: "pending" },
  { actor: { id: "other-admin", authorized: true } }, { actor: { id: "local-admin", authorized: false } }]) {
  unchanged(p.root, () => settlePersonaProposal(p.root, { ...settleArgs, ...extra }));
}
assert.equal(settlePersonaProposal(p.root, settleArgs).revision, 3);
assert.deepEqual(p.root.profile, baseProfile);
const terminalOriginal = structuredClone(bot(p.root).personaProposals[0]);
unchanged(p.root, () => settlePersonaProposal(p.root, { ...settleArgs, expectedRevision: 3 }), "invalid_status");
unchanged(p.root, () => claimPersonaProposal(p.root, { ...p.args, expectedRevision: 3 }), "invalid_status");
assert.equal(proposePersonaChanges(p.root, options()).duplicate, true);
assert.deepEqual(bot(p.root).personaProposals[0], terminalOriginal);
for (const status of ["failed", "rejected"]) {
  const t = pending(); assert.equal(claimPersonaProposal(t.root, t.args).ok, true);
  assert.equal(settlePersonaProposal(t.root, { ...t.args, status, expectedRevision: 2 }).ok, true);
  assert.equal(publicPersonaProposals(t.root, logicalId)[0].status, status);
  unchanged(t.root, () => claimPersonaProposal(t.root, { ...t.args, expectedRevision: 3 }), "invalid_status");
}
const rejected = pending();
unchanged(rejected.root, () => settlePersonaProposal(rejected.root, { ...rejected.args, status: "approved" }), "invalid_status");
assert.equal(settlePersonaProposal(rejected.root, { ...rejected.args, status: "rejected" }).revision, 2);
assert.equal(publicPersonaProposals(rejected.root, logicalId)[0].status, "rejected");

// Capacity NEVER evicts originals, even terminal records; duplicate still works.
const full = fixture();
for (let i = 0; i < 32; i++) {
  const item = proposePersonaChanges(full, options({ changes: [change("identity", `proposal ${i}`)] }));
  assert.equal(item.ok, true);
  assert.equal(settlePersonaProposal(full, { logicalId, id: item.id, expectedRevision: 1, actor, now, status: "rejected" }).ok, true);
}
const fullBefore = structuredClone(full);
unchanged(full, () => proposePersonaChanges(full, options()), "backpressure");
assert.equal(proposePersonaChanges(full, options({ changes: [change("identity", "proposal 0")] })).duplicate, true);
assert.deepEqual(full, fullBefore);
for (const corrupt of [state => { bot(state).personaProposals = {}; }, state => { state.socialAgents.version = 2; },
  state => { bot(state).personaProposals[0].baseProfile.identity = "tamper"; },
  state => { bot(state).personaProposals.push(structuredClone(bot(state).personaProposals[0])); }]) {
  const state = structuredClone(full); corrupt(state);
  unchanged(state, () => proposePersonaChanges(state, options()), "invalid_state");
  assert.deepEqual(publicPersonaProposals(state, logicalId), []);
}
console.log(`social-persona-proposals self-test: PASS (${checks} atomic rejection checks + lifecycle/evidence/capacity assertions; fake only)`);
