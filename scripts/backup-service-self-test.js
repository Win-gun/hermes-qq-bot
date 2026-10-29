import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beginDiscoveryRound, recoverDiscoveryState } from "../src/social-discovery-state.js";
import { recoverQzoneState } from "../src/qzone-runtime.js";
import { ingestSocialMessage, appendSocialExperience } from "../src/social-agent-state.js";
import { recordSocialPreference, setSocialGrowthFrozen } from "../src/social-preferences.js";
import { proposeSocialIntent, settleSocialIntent } from "../src/social-intent-journal.js";
import { applySelfRoleCard, rollbackSelfRoleCard } from "../src/self-role-card.js";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { accountItems, registryConfig } from "../src/account-registry.js";
import { recordPersonEvidence, administerPersonMemory, queryPersonMemory, personMemoryControl } from "../src/people-memory.js";
import { createOwnerNotificationCenter, getOwnerNotificationStatus } from "../src/owner-notifications.js";
import { createOwnerCommandRouter, ownerOperationHistory, putOwnerDirective, ownerDirectiveAllows } from "../src/owner-authority.js";
import { claimModelCall, recordModelCall, recordOperationalEvent, queryModelUsage } from "../src/operational-ledger.js";
import { recordOwnerInteraction, queryOwnerInteractions } from "../src/owner-interactions.js";
import {
  BACKUP_MAGIC,
  createBackup,
  inspectBackup,
  restoreBackup,
  rollbackRestore,
  migrateLegacyProject,
  sanitizeConfigForBackup
} from "../src/backup-service.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-backup-test-"));
const state = path.join(root, "state");
const safeRestore = path.join(root, "safe-restore");
const fullRestore = path.join(root, "full-restore");
const backups = path.join(root, "backups");
const hermesHome = path.join(root, "hermes");
const logRoot = path.join(root, "logs");
let tests = 0;

function check(condition, message) {
  tests += 1;
  if (!condition) throw new Error(message);
}

// Social fixtures are data only: never dispatch a model, timer, QQ action or
// authenticated tool. They exercise the actual safe/full archive restore path.
const planStatuses = ["pending", "claimed", "waiting", "running", "future_status", "paused",
  "completed", "failed", "cancelled", "expired", "superseded"];
const runtimeStatuses = ["pending", "claimed", "waiting", "diving", "running", "intent_claimed", "schedule_claimed",
  "uncertain", "future_status", "paused", "idle", "shadow", "completed", "failed", "cancelled"];
const memoryFixture = { groups: { 123: { users: { 42: { nickname: "测试" } } } }, socialAgents: { version: 1, bots: {
  "account:fixture": {
    plans: Object.fromEntries(planStatuses.map((status, index) => [`plan-${index}`, { id: `plan-${index}`, status,
      revision: 4, sourceConversationId: "group:123", targetConversationId: "group:123", runAt: 100, expiresAt: 200,
      ...(status === "paused" ? { previousStatus: "claimed", reason: "already_paused" } : {}) }])),
    conversations: Object.fromEntries(runtimeStatuses.map((status, index) => [`group:${123 + index}`, {
      nextSeq: 10, readThroughSeq: 6, messages: [{ seq: 7, messageId: `human-${index}`, userId: "42", text: "fixture source", sentAt: 10, receivedAt: 11 }],
      experiences: [{ userId: "42", text: "fixture experience", kind: "bot_reply", messageId: `bot-${index}`, sentAt: 12 }],
      habits: [{ id: `habit:group:${123 + index}:1`, text: "fixture habit", evidenceMessageIds: [`human-${index}`] }],
      mood: { valence: 0.2, arousal: 0, engagement: 0.1, updatedAt: 10 },
      runtime: { status, seenSeq: 9, lastProcessedSeq: 9, intentFenceThroughSeq: 8, dueAt: 20, turnId: `turn-${index}`,
        ...(status === "paused" ? { previousStatus: "intent_claimed", reason: "already_paused" } : {}) },
    }])),
    runtimeUsage: { days: { fixture: { reservedCalls: 2, actualCalls: 1, pending: { claim1: { at: 10 } } } } },
    users: { 42: { contacts: [{ claimId: "contact1", status: "claimed", claimedAt: 12 }],
      consents: { "group:123": { allowed: true, evidenceConversationId: "private:42", messageId: "consent-fixture" } } } },
  },
  "group:fixture-failover": { plans: { second: { id: "second", status: "waiting", revision: 1 } },
    conversations: { "private:42": { readThroughSeq: 2, experiences: [], runtime: { status: "waiting", dueAt: 50 } } } },
} } };
// Real 3.2 schemas, not marker-shaped approximations. Backup restoration must
// preserve pending non-executable semantics, own ACK proof and rollback history.
const agency = {}, agencyAt = Date.UTC(2026, 9, 28, 5), agencyScope = { logicalId: "account:agency", conversationId: "group:101", now: agencyAt };
assert(ingestSocialMessage(agency, { ...agencyScope, message: { messageId: "public-human", userId: "11", text: "讨论科技的新方向",
  sentAt: agencyAt, receivedAt: agencyAt } }).ok);
assert(appendSocialExperience(agency, { ...agencyScope, userId: "11", messageId: "own-ack", text: "我喜欢科技", kind: "bot_reply",
  confirmed: true, agencyEligible: true, sentAt: agencyAt }).ok);
assert(recordSocialPreference(agency, { ...agencyScope, kind: "self", dimension: "interest", value: "科技", coreText: "喜欢科技",
  evidenceMessageIds: ["own-ack"], expectedRevision: 0 }).ok);
assert(setSocialGrowthFrozen(agency, { logicalId: agencyScope.logicalId, expectedRevision: 1, frozen: true,
  actor: { authorized: true }, reason: "fixture freeze", now: agencyAt }).ok);
const agencyIntent = proposeSocialIntent(agency, { ...agencyScope, kind: "question", summary: "科技发展的新方向", reason: "公开讨论的后续线索",
  trigger: { kind: "related_message", terms: ["科技"] }, evidenceMessageIds: ["public-human"], ttlMs: 60000, expectedRevision: 0 });
assert(agencyIntent.ok);
assert(settleSocialIntent(agency, { ...agencyScope, id: agencyIntent.id, expectedRevision: 1, status: "pending", reason: "fixture pending" }).ok);
const agencyCard = { logicalId: agencyScope.logicalId, policy: { enabled: true }, reason: "fixture card", evidenceMessageIds: ["own-ack"], explicit: true };
assert(applySelfRoleCard(agency, { ...agencyCard, expectedRevision: 0, fields: { expression: "稳健表达" }, now: agencyAt }).ok);
assert(applySelfRoleCard(agency, { ...agencyCard, expectedRevision: 1, fields: { interests: "科技" }, now: agencyAt + 1 }).ok);
assert(rollbackSelfRoleCard(agency, { logicalId: agencyScope.logicalId, policy: { enabled: true }, expectedRevision: 2,
  targetRevision: 1, actor: { authorized: true }, now: agencyAt + 2 }).ok);
memoryFixture.socialAgents.bots[agencyScope.logicalId] = agency.socialAgents.bots[agencyScope.logicalId];
memoryFixture.qzoneSocial = { version: 1, bots: { "account:fixture": { owners: { "10001": {
  owner: { accountId: "fixture", qq: "10001" }, claims: { fingerprint: { id: "wire-claim", draftId: "pending", at: 12 } },
  days: {}, lastReadAt: null, lastWriteAt: {},
  capabilities: { send_qzone_msg: { state: "supported", at: 12, protocolVersion: "fixture", writeSettled: true } },
  drafts: { pending: { id: "pending", kind: "publish", status: "publishing", revision: 2, content: "fixture pending", claimId: "wire-claim" },
    approved: { id: "approved", kind: "publish", status: "approved", revision: 2, content: "fixture approved", approvedBy: "discard" },
    terminal: { id: "terminal", kind: "publish", status: "confirmed", revision: 5, content: "fixture confirmed", clientVerified: true } }
} } } } };

assert.equal(beginDiscoveryRound(memoryFixture, { logicalId: "account:fixture", roundId: "backup-discovery",
  now: Date.parse("2026-10-24T04:00:00Z"), policy: { enabled: true, shadowMode: true, conversationIds: ["group:123"] } }).ok, true);

// Valid 3.3 roots produced by their public mutators, not marker-shaped JSON.
// These adapters are fixture-only draft callbacks. No production writer,
// current config/state, QQ, Docker, Keychain or model is consulted.
const ownerAt = Date.parse("2026-10-28T01:00:00Z"), ownerBot = "account:backup33";
const ownerPolicy = { enabled: true, naturalLanguage: true, usageEnabled: true,
  allowedTargets: [{ accountId: "primary", groupId: "23456789" }] };
const notificationPolicy = { enabled: true, timezone: "Asia/Shanghai", times: ["09:00", "21:00"],
  recipients: ["21001"], dueGraceMs: 600000, maxPerLocalDay: 2,
  critical: { enabled: true, codes: ["ACCOUNT_OFFLINE"], cooldownMs: 3600000 } };
const automationPolicy = { enabled: true, ownershipVersion: 1, accounts: { primary: {
  rules: [], legacyRuleIds: [], legacyRoutineLedger: {}, routines: { version: 1,
    daily: { enabled: true, checkIntervalMs: 60000, schedules: [
      { name: "fixture-window", mode: "custom", time: "08:30", enabled: true, prompt: "fixture routine" }] },
    hourly: { enabled: true, checkIntervalMs: 60000, ownerUserIds: ["21001"] } }
} }, groups: {}, unassigned: [], rules: [], routines: { version: 1 } };
const personEvidence = (userId, patch = {}) => ({ logicalBotId: ownerBot, userId, verifiedSenderId: userId,
  accountId: "primary", conversationId: "group:23456789", messageId: `person-${userId}`,
  time: ownerAt / 1000, now: ownerAt, kind: "preference", value: "偏好简短回复",
  confidence: 0.9, sourceType: "message", privacy: "public", ...patch });
for (const userId of ["12345678", "12345679", "12345680"])
  assert.equal(recordPersonEvidence(memoryFixture, personEvidence(userId)).ok, true);
assert.equal(recordPersonEvidence(memoryFixture, personEvidence("12345678", { messageId: "private-person",
  conversationId: "private:12345678", privacy: "private", value: "喜欢安静交流" })).ok, true);
for (const [userId, operation] of [["12345679", "freeze"], ["12345680", "delete"]])
  assert.equal(administerPersonMemory(memoryFixture, { logicalBotId: ownerBot, userId, operation,
    actorUserId: "21001", authorized: true, expectedRevision: memoryFixture.peopleMemory.revision, now: ownerAt }).ok, true);
const pendingModel = { callId: "backup-model-pending", logicalBotId: ownerBot, accountId: "primary",
  conversationId: "group:23456789", kind: "chat", model: "fixture/model", startedAt: ownerAt };
assert.equal(claimModelCall(memoryFixture, pendingModel).shouldCall, true);
assert.equal(recordModelCall(memoryFixture, { ...pendingModel, callId: "backup-model-confirmed", startedAt: ownerAt + 1,
  endedAt: ownerAt + 2, status: "confirmed", usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16,
    cachedInputTokens: 0, reasoningTokens: 0 } }).ok, true);
assert.equal(recordOperationalEvent(memoryFixture, { eventId: "backup-unresolved", code: "ACCOUNT_OFFLINE", severity: "warning",
  accountId: "primary", logicalBotId: ownerBot, feature: "chat", time: ownerAt + 2, resolved: false }).ok, true);
for (const direction of ["received", "sent"])
  assert.equal(recordOwnerInteraction(memoryFixture, { logicalBotId: ownerBot, accountId: "primary",
    conversationId: "private:21001", messageId: `interaction-${direction}`, direction, at: ownerAt, now: ownerAt }).recorded, true);
const ownerEnvelope = { private: true, verified: true, ownerUserId: "21001", accountId: "primary", logicalBotId: ownerBot };
const ownerSource = { revision: "backup-source-r1", carrier: "primary", session: "fixture-session" };
let fixtureWireCalls = 0;
let owner33RoundTrips = 0;
const forbiddenFixtureWire = () => { fixtureWireCalls++; throw new Error("fixture wire must never run"); };
const routerHost = (read, transact, authorize = () => true) => ({ read, transact, authorize,
  isOwner: envelope => envelope.ownerUserId === "21001", capture: () => ownerSource, isCurrent: () => true,
  execute: forbiddenFixtureWire, query: forbiddenFixtureWire, now: () => ownerAt });
const ownerRouter = createOwnerCommandRouter(routerHost(() => memoryFixture, async build => build(memoryFixture)));
const ownerPending = await ownerRouter.handle({ ...ownerEnvelope, messageId: "owner-pending" },
  "/owner notifications on 09:00,21:00 Asia/Shanghai");
assert.equal(ownerPending.code, "OWNER_CONFIRM_REQUIRED");
// Simulate a crash AFTER durable claim publication but BEFORE any execution.
const claimedRouter = createOwnerCommandRouter(routerHost(() => memoryFixture, async build => {
  build(memoryFixture); throw new Error("fixture publication outcome uncertain");
}));
await assert.rejects(() => claimedRouter.handle({ ...ownerEnvelope, messageId: "owner-claimed" },
  "/owner send primary 23456789 fixture"), /fixture publication outcome uncertain/);
assert.equal(putOwnerDirective(memoryFixture, { actorUserId: "21001", logicalBotId: ownerBot, accountId: "primary",
  groupId: "23456789", userId: "12345678", messageId: "directive-source", authorized: true, now: ownerAt }).ok, true);
const claimedNotification = createOwnerNotificationCenter({ read: () => memoryFixture,
  transact: async build => { build(memoryFixture); throw new Error("fixture publication outcome uncertain"); },
  now: () => ownerAt, policy: () => notificationPolicy,
  eligible: () => ({ allowed: true, ownerVerified: true, private: true, online: true, revision: "backup-route-r1" }),
  snapshot: forbiddenFixtureWire, send: forbiddenFixtureWire });
assert.equal((await claimedNotification.tick()).code, "OWNER_NOTIFICATIONS_PERSISTENCE_UNCERTAIN");
assert.equal(memoryFixture.ownerNotifications.windows.length, 1);
assert.equal(memoryFixture.ownerNotifications.windows[0].status, "claimed");
assert.equal(fixtureWireCalls, 0);

async function checkOwner33Restore(target) {
  const restoredMemoryBefore = fs.readFileSync(path.join(target, "data", "memory.json"), "utf8");
  const actual = JSON.parse(restoredMemoryBefore);
  const config = JSON.parse(fs.readFileSync(path.join(target, "config.json"), "utf8"));
  assert.deepEqual(config.ownerControl, { ...ownerPolicy, enabled: false });
  assert.deepEqual(config.ownerNotifications, { ...notificationPolicy, enabled: false });
  assert.deepEqual(config.automation, automationPolicy);
  assert.deepEqual(config.targetGroups, ["23456789"]);
  check(true, "restore disables only owner execution/summary enablement and preserves all targets/times/scopes");
  for (const key of ["peopleMemory", "ownerAuthority", "ownerNotifications", "operationalLedger", "ownerInteractions"])
    assert.deepEqual(actual[key], memoryFixture[key], `3.3 ${key} evidence/claims/fences must survive unchanged`);
  check(true, "all real 3.3 memory roots survive safe/full restoration without fabricated receipts");
  assert.equal(personMemoryControl(actual, { logicalBotId: ownerBot, userId: "12345679" }).frozen, true);
  const deleted = personMemoryControl(actual, { logicalBotId: ownerBot, userId: "12345680" });
  assert.equal(deleted.deleted, true); assert.equal(deleted.suppressesLegacy, true);
  assert.equal(queryPersonMemory(actual, { logicalBotId: ownerBot, userId: "12345678",
    conversationId: "group:23456789", now: ownerAt }).entries.length, 1);
  assert.equal(queryPersonMemory(actual, { logicalBotId: ownerBot, userId: "12345678",
    conversationId: "private:12345678", now: ownerAt }).entries.length, 1);
  const fenceBefore = structuredClone(actual.peopleMemory);
  assert.equal(recordPersonEvidence(actual, personEvidence("12345680")).ok, false);
  assert.equal(recordPersonEvidence(actual, personEvidence("12345679")).ok, false);
  assert.deepEqual(actual.peopleMemory, fenceBefore);
  check(true, "public/private person evidence, admin freeze and deletion fallback fences survive");
  const usageRange = { from: ownerAt, to: ownerAt + 3 };
  assert.deepEqual(queryModelUsage(actual, usageRange), queryModelUsage(memoryFixture, usageRange));
  const modelRetry = claimModelCall(actual, pendingModel);
  assert.equal(modelRetry.ok, true); assert.equal(modelRetry.shouldCall, false);
  assert.equal(modelRetry.duplicate, true);
  assert.equal(queryOwnerInteractions(actual, { from: ownerAt, to: ownerAt + 1 }).sent, 1);
  assert.equal(recordOwnerInteraction(actual, { logicalBotId: ownerBot, accountId: "primary", conversationId: "private:21001",
    messageId: "interaction-received", direction: "received", at: ownerAt, now: ownerAt }).duplicate, true);
  check(true, "known/unknown usage, pending model claims and confirmed interaction dedup survive restart");
  const authorityBefore = structuredClone(actual.ownerAuthority);
  // Use the same fixture clock as command creation. CI wall time may already
  // be beyond the two-minute approval TTL; that must not change restore QA.
  const history = ownerOperationHistory(actual, { now: ownerAt });
  assert(history.some(row => row.status === "uncertain") && history.some(row => row.status === "awaiting_confirmation"));
  const expiredHistory = ownerOperationHistory(actual, { now: ownerAt + 120001 });
  assert(expiredHistory.some(row => row.status === "blocked" && row.code === "OWNER_APPROVAL_EXPIRED"));
  assert(expiredHistory.some(row => row.status === "uncertain"));
  assert.deepEqual(actual.ownerAuthority, authorityBefore, "history projection never changes durable claims");
  const router = createOwnerCommandRouter(routerHost(() => actual, async build => build(actual), () => config.ownerControl.enabled));
  assert.equal((await router.handle({ ...ownerEnvelope, messageId: "owner-claimed" },
    "/owner send primary 23456789 fixture")).status, "blocked");
  // Even explicit re-enable cannot replay a persisted claim or silently confirm
  // a pending proposal. Only a separate current explicit confirmation may act.
  config.ownerControl.enabled = true;
  assert.equal((await router.handle({ ...ownerEnvelope, messageId: "owner-claimed" },
    "/owner send primary 23456789 fixture")).status, "uncertain");
  assert.equal((await router.handle({ ...ownerEnvelope, messageId: "owner-pending" },
    "/owner notifications on 09:00,21:00 Asia/Shanghai")).status, "uncertain");
  assert.deepEqual(actual.ownerAuthority, authorityBefore);
  assert.equal(ownerDirectiveAllows(actual, { logicalBotId: ownerBot, groupId: "23456789",
    userId: "12345678", action: "group_poke" }), false);
  check(true, "restored owner commands never execute automatically and restrictions remain effective");
  const notificationBefore = structuredClone(actual.ownerNotifications);
  assert.equal(getOwnerNotificationStatus(actual, { now: ownerAt }).recent[0].status, "uncertain");
  assert.deepEqual(actual.ownerNotifications, notificationBefore, "read-only status does not recover state");
  const center = createOwnerNotificationCenter({ read: () => actual, transact: async build => build(actual),
    now: () => ownerAt, policy: () => config.ownerNotifications,
    eligible: () => ({ allowed: true, ownerVerified: true, private: true, online: true, revision: "backup-route-r1" }),
    snapshot: forbiddenFixtureWire, send: forbiddenFixtureWire });
  assert.equal((await center.tick()).code, "DISABLED");
  assert.equal(actual.ownerNotifications.windows[0].status, "uncertain");
  config.ownerNotifications.enabled = true;
  await center.tick(); // Original claimed occurrence is consumed, never replayed.
  assert.equal(actual.ownerNotifications.windows.length, 1);
  assert.equal(actual.ownerNotifications.windows[0].status, "uncertain");
  assert.equal(fixtureWireCalls, 0);
  check(true, "recovery marks orphan notification claims uncertain without summary/model/wire replay");
  assert.equal(fs.readFileSync(path.join(target, "data", "memory.json"), "utf8"), restoredMemoryBefore,
    "fixture runtime checks are memory-only, never a second disk writer");
  owner33RoundTrips++;
}

function checkSocialRestore(target) {
  const actual = JSON.parse(fs.readFileSync(path.join(target, "data", "memory.json"), "utf8"));
  let expected = structuredClone(memoryFixture);
  const recoveredAt = actual.qzoneSocial.bots["account:fixture"].owners["10001"].drafts.pending.recoveredAt;
  expected = recoverQzoneState(expected, { reason: "backup_restore", now: recoveredAt }).memory;
  const space = actual.qzoneSocial.bots["account:fixture"].owners["10001"];
  assert.equal(space.drafts.pending.status, "uncertain"); assert.equal(space.drafts.approved.status, "review");
  assert.equal(space.drafts.terminal.status, "confirmed"); assert.equal(space.capabilities.send_qzone_msg.state, "unknown");
  assert.deepEqual(space.claims, memoryFixture.qzoneSocial.bots["account:fixture"].owners["10001"].claims);
  const interruptedAt = actual.socialAgents.bots["account:fixture"].discovery.rounds[0].finishedAt;
  assert.equal(actual.socialAgents.bots["account:fixture"].discovery.rounds[0].status, "interrupted");
  assert.equal(recoverDiscoveryState(expected, { now: interruptedAt }).ok, true);
  for (const bot of Object.values(expected.socialAgents.bots)) {
    for (const plan of Object.values(bot.plans || {})) {
      if (!["completed", "failed", "cancelled", "expired", "superseded", "paused"].includes(plan.status)) {
        plan.previousStatus = plan.status; plan.status = "paused"; plan.reason = "backup_restore"; plan.revision++;
      }
    }
    for (const conv of Object.values(bot.conversations)) {
      const runtime = conv.runtime;
      if (!runtime) continue;
      if (!["idle", "shadow", "completed", "failed", "cancelled", "paused"].includes(runtime.status)) {
        runtime.previousStatus = runtime.status; runtime.status = "paused"; runtime.reason = "backup_restore";
      }
    }
  }
  assert.deepEqual(actual, expected, "only restore statuses/revisions change; watermarks, evidence, terminal state and receipts survive");
  check(true, "restored social plans/runtime must be paused without evidence loss or terminal-state rewriting");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, "data", "memory.json"), "utf8")), memoryFixture,
    "backup/export/restore must never modify the source memory");
  check(true, "social restore gate must operate only on extracted staging");
}

function tamperFullManifest(source, password, mutate, name) {
  const encoded = fs.readFileSync(source);
  const headerLength = encoded.readUInt32BE(BACKUP_MAGIC.length);
  const bodyOffset = BACKUP_MAGIC.length + 4 + headerLength;
  const header = JSON.parse(encoded.subarray(BACKUP_MAGIC.length + 4, bodyOffset).toString("utf8"));
  const oldKey = crypto.scryptSync(password, Buffer.from(header.crypto.salt, "base64"), 32,
    { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const decipher = crypto.createDecipheriv("aes-256-gcm", oldKey, Buffer.from(header.crypto.iv, "base64"));
  decipher.setAuthTag(Buffer.from(header.crypto.tag, "base64"));
  const archive = Buffer.concat([decipher.update(encoded.subarray(bodyOffset)), decipher.final()]);
  const fixture = path.join(root, name);
  fs.mkdirSync(fixture, { mode: 0o700 });
  const archiveFile = path.join(fixture, "payload.tgz");
  const payloadDir = path.join(fixture, "payload");
  fs.mkdirSync(payloadDir, { mode: 0o700 });
  fs.writeFileSync(archiveFile, archive, { mode: 0o600 });
  execFileSync("/usr/bin/tar", ["-xzf", archiveFile, "-C", payloadDir], { stdio: "ignore" });
  const manifestFile = path.join(payloadDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  mutate(manifest, payloadDir);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  execFileSync("/usr/bin/tar", ["-czf", archiveFile, "-C", payloadDir, "."], { stdio: "ignore" });
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(fs.readFileSync(archiveFile)), cipher.final()]);
  header.crypto = { ...header.crypto, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  const headerBuffer = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBuffer.length);
  const destination = path.join(fixture, "mutated.hermesqqbackup");
  fs.writeFileSync(destination, Buffer.concat([BACKUP_MAGIC, length, headerBuffer, encrypted]), { mode: 0o600 });
  return destination;
}

try {
  fs.mkdirSync(path.join(state, "data", "chat-archive", "groups", "123"), { recursive: true });
  fs.mkdirSync(path.join(state, "data", "tasks", "task_1", "outputs"), { recursive: true });
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.mkdirSync(logRoot, { recursive: true });
  fs.writeFileSync(path.join(logRoot, "bridge.log"), "diagnostic sample\n");
  const config = {
    ai: { command: "hermesqq2", args: ["-m", "deepseek-v4-flash", "--provider", "deepseek", "-z"], provider: "deepseek", model: "deepseek-v4-flash", apiKeyEnv: "DEEPSEEK_API_KEY", directApiKey: "FAKE_CREDENTIAL_FOR_TESTS" },
    prompt: { system: "保持原有风格" },
    taskMode: { workspaceBaseDir: path.join(state, "data", "tasks") },
    ownerControl: structuredClone(ownerPolicy), ownerNotifications: structuredClone(notificationPolicy),
    automation: structuredClone(automationPolicy), targetGroups: ["23456789"],
    accounts: { primary: { id: "primary", protocol: "napcat", token: "sensitive-token-value-abcdefghijklmnopqrstuvwxyz" }, standbys: [] }
  };
  fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
  const sourceConfigBytes = fs.readFileSync(path.join(state, "config.json"), "utf8");
  const sourceMemoryBytes = JSON.stringify(memoryFixture);
  fs.writeFileSync(path.join(state, "data", "memory.json"), sourceMemoryBytes);
  fs.writeFileSync(path.join(state, "data", "chat-archive", "groups", "123", "messages.jsonl"), '{"text":"hello"}\n');
  fs.writeFileSync(path.join(state, "data", "chat-archive", "groups", "123", "search-index.json"), '{"disposable":"cache"}');
  fs.writeFileSync(path.join(state, "data", "tasks", "task_1", "outputs", "report.md"), "# report\n");
  fs.writeFileSync(path.join(hermesHome, ".env"), "DEEPSEEK_API_KEY=secret\n");
  fs.mkdirSync(path.join(hermesHome, "skills"), { recursive: true });
  fs.mkdirSync(path.join(root, "external-skill"), { recursive: true });
  fs.symlinkSync(path.join(root, "external-skill"), path.join(hermesHome, "skills", "external-skill"));
  fs.mkdirSync(path.join(hermesHome, "profiles", "hermesqq2", "lsp", "bin"), { recursive: true });
  fs.symlinkSync("/usr/bin/true", path.join(hermesHome, "profiles", "hermesqq2", "lsp", "bin", "tool"));

  const sanitized = sanitizeConfigForBackup(config);
  check(sanitized.config.ai.apiKeyEnv === "DEEPSEEK_API_KEY", "environment variable name must be retained");
  check(sanitized.config.ai.directApiKey === "", "direct API key must be redacted");
  check(sanitized.config.accounts.primary.token === "", "account token must be redacted");
  const longId = `a${"b".repeat(63)}`;
  const identityConfig = sanitizeConfigForBackup({ accounts: { version: 2, items: [{ id: longId,
    protocolContainer: longId, snowlumaVolumes: { snowlumaData: longId },
    onebotWsUrl: "wss://fixture-user:fixture-password@example.invalid/onebot?access_token=fixture-secret&keep=1" }] } });
  check(identityConfig.config.accounts.items[0].id === longId && identityConfig.config.accounts.items[0].protocolContainer === longId
    && identityConfig.config.accounts.items[0].snowlumaVolumes.snowlumaData === longId, "safe backups must preserve long stable registry and transport IDs");
  check(identityConfig.config.accounts.items[0].onebotWsUrl === "wss://example.invalid/onebot?keep=1", "safe backups must strip credentials embedded in OneBot URLs");

  const safe = await createBackup({ type: "safe", stateRoot: state, hermesHome, destinationDir: backups, appVersion: "test" });
  check(!safe.manifest.files.some((item) => item.path.endsWith("/search-index.json")), "safe backups exclude regenerable archive search caches");
  check(fs.existsSync(safe.path), "safe backup must exist");
  const safeInfo = await inspectBackup({ path: safe.path });
  check(safeInfo.manifest.type === "safe" && !safeInfo.manifest.containsSensitiveInformation, "safe manifest flags must be correct");
  check(!safeInfo.manifest.files.some((item) => item.path.startsWith("diagnostic-logs/")), "safe backup must exclude diagnostic logs");
  let unsafeLogsRejected = false;
  try { await createBackup({ type: "safe", includeLogs: true, stateRoot: state, logRoot, destinationDir: backups }); } catch { unsafeLogsRejected = true; }
  check(unsafeLogsRejected, "unencrypted backup must reject diagnostic logs");
  const safeResult = await restoreBackup({ path: safe.path, stateRoot: safeRestore, hermesHome: path.join(safeRestore, "hermes") });
  const restoredSafeConfig = JSON.parse(fs.readFileSync(path.join(safeRestore, "config.json"), "utf8"));
  check(restoredSafeConfig.ai.directApiKey === "", "safe restore must stay sanitized");
  check(restoredSafeConfig.taskMode.workspaceBaseDir === path.join(safeRestore, "data", "tasks"), `safe restore must rewrite state paths for the new computer (got ${restoredSafeConfig.taskMode.workspaceBaseDir})`);
  check(fs.existsSync(path.join(safeRestore, "data", "memory.json")), "safe restore must include memory");
  checkSocialRestore(safeRestore);
  await checkOwner33Restore(safeRestore);
  check(fs.readFileSync(path.join(state, "config.json"), "utf8") === sourceConfigBytes,
    "restoration disables staged owner policy only; source config stays byte-for-byte unchanged");
  check(fs.readFileSync(path.join(state, "data", "memory.json"), "utf8") === sourceMemoryBytes,
    "source memory must remain byte-for-byte unchanged");
  // Restoring the same archive again still pauses only its staged work, without
  // mutating the source archive, resetting read watermarks or duplicating data.
  const archiveHash = crypto.createHash("sha256").update(fs.readFileSync(safe.path)).digest("hex");
  const socialRepeat = path.join(root, "social-repeat-restore");
  await restoreBackup({ path: safe.path, stateRoot: socialRepeat });
  checkSocialRestore(socialRepeat);
  await checkOwner33Restore(socialRepeat);
  check(crypto.createHash("sha256").update(fs.readFileSync(safe.path)).digest("hex") === archiveHash,
    "restore must never rewrite the checksummed backup container");
  const pausedBackup = await createBackup({ type: "safe", stateRoot: socialRepeat, destinationDir: backups });
  const pausedRoundtrip = path.join(root, "social-paused-roundtrip");
  await restoreBackup({ path: pausedBackup.path, stateRoot: pausedRoundtrip });
  checkSocialRestore(pausedRoundtrip); // no repeated revision bump or previousStatus loss
  await checkOwner33Restore(pausedRoundtrip);
  // Pre-social memory remains compatible and does not acquire social defaults.
  const oldMemorySource = path.join(root, "old-memory-source");
  fs.mkdirSync(path.join(oldMemorySource, "data"), { recursive: true });
  fs.writeFileSync(path.join(oldMemorySource, "config.json"), JSON.stringify({ accounts: { version: 2, items: [], failoverGroups: [] } }));
  const oldMemory = { groups: { 123: { users: {}, facts: ["legacy fixture"] } } };
  fs.writeFileSync(path.join(oldMemorySource, "data", "memory.json"), JSON.stringify(oldMemory));
  const preSocialBackup = await createBackup({ type: "safe", stateRoot: oldMemorySource, destinationDir: backups });
  const oldMemoryTarget = path.join(root, "old-memory-restore");
  await restoreBackup({ path: preSocialBackup.path, stateRoot: oldMemoryTarget });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(oldMemoryTarget, "data", "memory.json"), "utf8")), oldMemory);
  check(true, "pre-social backup restore must preserve legacy memory without adding fields");
  const preOwnerConfig = JSON.parse(fs.readFileSync(path.join(oldMemoryTarget, "config.json"), "utf8"));
  check(!Object.hasOwn(preOwnerConfig, "ownerControl") && !Object.hasOwn(preOwnerConfig, "ownerNotifications"),
    "old config restore must not create 3.3 policy defaults");
  // Malformed owner policies fail BEFORE replacing an existing target or
  // touching credentials. No live user config/Keychain participates.
  const invalidOwnerSource = path.join(root, "invalid-owner-source");
  fs.mkdirSync(path.join(invalidOwnerSource, "data"), { recursive: true });
  fs.writeFileSync(path.join(invalidOwnerSource, "data", "memory.json"), JSON.stringify({ groups: {} }));
  const ownerTargetConfigBefore = fs.readFileSync(path.join(oldMemoryTarget, "config.json"));
  const ownerTargetMemoryBefore = fs.readFileSync(path.join(oldMemoryTarget, "data", "memory.json"));
  const ownerCredentialUntouched = () => { throw new Error("owner staging unexpectedly reached credentials"); };
  for (const policies of [{ ownerControl: [], ownerNotifications: notificationPolicy },
    { ownerControl: ownerPolicy, ownerNotifications: null }]) {
    fs.writeFileSync(path.join(invalidOwnerSource, "config.json"), JSON.stringify({ ...policies,
      accounts: { version: 2, items: [], failoverGroups: [] } }));
    const invalidOwnerBackup = await createBackup({ type: "safe", stateRoot: invalidOwnerSource, destinationDir: backups });
    await assert.rejects(() => restoreBackup({ path: invalidOwnerBackup.path, stateRoot: oldMemoryTarget,
      voiceSecretStore: { getVoiceSecret: ownerCredentialUntouched, setVoiceSecret: ownerCredentialUntouched, deleteVoiceSecret: ownerCredentialUntouched },
      apiSecretStore: { getApiSecret: ownerCredentialUntouched, setApiSecret: ownerCredentialUntouched, deleteApiSecret: ownerCredentialUntouched },
    }), /主人控制配置格式无效/);
    assert.deepEqual(fs.readFileSync(path.join(oldMemoryTarget, "config.json")), ownerTargetConfigBefore);
    assert.deepEqual(fs.readFileSync(path.join(oldMemoryTarget, "data", "memory.json")), ownerTargetMemoryBefore);
    check(true, "malformed owner policy rejects in staging with existing target and credentials untouched");
  }
  // Malformed executable social state fails closed in staging BEFORE existing
  // target files or fake Keychain handles can be touched.
  fs.writeFileSync(path.join(oldMemorySource, "data", "memory.json"), JSON.stringify({ groups: {},
    socialAgents: { version: 1, bots: { "account:fixture": { plans: [] } } } }));
  const invalidSocialBackup = await createBackup({ type: "safe", stateRoot: oldMemorySource, destinationDir: backups });
  const targetConfigBefore = fs.readFileSync(path.join(oldMemoryTarget, "config.json"));
  const targetMemoryBefore = fs.readFileSync(path.join(oldMemoryTarget, "data", "memory.json"));
  const keychainUntouched = () => { throw new Error("restore safety gate unexpectedly reached Keychain"); };
  await assert.rejects(() => restoreBackup({ path: invalidSocialBackup.path, stateRoot: oldMemoryTarget,
    voiceSecretStore: { getVoiceSecret: keychainUntouched, setVoiceSecret: keychainUntouched, deleteVoiceSecret: keychainUntouched },
    apiSecretStore: { getApiSecret: keychainUntouched, setApiSecret: keychainUntouched, deleteApiSecret: keychainUntouched },
  }), /社交状态格式无效/);
  assert.deepEqual(fs.readFileSync(path.join(oldMemoryTarget, "config.json")), targetConfigBefore);
  assert.deepEqual(fs.readFileSync(path.join(oldMemoryTarget, "data", "memory.json")), targetMemoryBefore);
  check(true, "invalid staged social state must reject restore without modifying the existing target");
  check(fs.existsSync(path.join(safeRestore, "data", "chat-archive", "groups", "123", "messages.jsonl"))
    && !fs.existsSync(path.join(safeRestore, "data", "chat-archive", "groups", "123", "search-index.json")), "restore preserves archive evidence without stale search cache");
  check(!fs.existsSync(path.join(safeRestore, "hermes", ".env")), "safe backup must exclude Hermes secret files");
  await rollbackRestore({ stateRoot: safeRestore, rollbackDir: safeResult.rollbackDir, installedTargets: safeResult.installedTargets });
  check(!fs.existsSync(path.join(safeRestore, "config.json")), "rollback must remove newly installed config when no previous config existed");

  const progress = [];
  const full = await createBackup({ type: "full", password: "correct horse battery staple", includeLogs: true, stateRoot: state, hermesHome, logRoot, destinationDir: backups, appVersion: "test", onProgress: (item) => progress.push(item) });
  check(fs.existsSync(full.path), "full backup must exist");
  check(!full.manifest.files.some((item) => item.path.endsWith("/search-index.json")), "full backups also exclude regenerable archive search caches");
  check(progress[0]?.stage === "copy" && progress.at(-1)?.percent === 98, "full backup must report bounded progress through file finalization");
  check(!full.manifest.files.some((item) => item.path.includes("external-skill") || item.path.includes("/lsp/")), "full backup must skip nonportable Hermes symlinks and generated LSP files");
  let wrongPasswordRejected = false;
  try { await inspectBackup({ path: full.path, password: "wrong" }); } catch { wrongPasswordRejected = true; }
  check(wrongPasswordRejected, "wrong password must be rejected");
  if (process.platform === "darwin" && process.arch === "arm64") {
    // Full migration is intentionally rejected by the product on other platforms.
    const fullInfo = await inspectBackup({ path: full.path, password: "correct horse battery staple" });
    check(fullInfo.manifest.type === "full" && fullInfo.header.encrypted, "full backup must be encrypted");
    check(fullInfo.manifest.components.includes("diagnostic-logs") && fullInfo.manifest.files.some((item) => item.path === "diagnostic-logs/bridge.log"), "encrypted full backup must include optional logs");
    const fullArchiveHash = crypto.createHash("sha256").update(fs.readFileSync(full.path)).digest("hex");
    await restoreBackup({ path: full.path, password: "correct horse battery staple", stateRoot: fullRestore, hermesHome: path.join(fullRestore, "hermes") });
    checkSocialRestore(fullRestore);
    await checkOwner33Restore(fullRestore);
    check(crypto.createHash("sha256").update(fs.readFileSync(full.path)).digest("hex") === fullArchiveHash,
      "3.3 restore gates must never rewrite the encrypted full archive");
    const restoredFullConfig = JSON.parse(fs.readFileSync(path.join(fullRestore, "config.json"), "utf8"));
    check(restoredFullConfig.ai.directApiKey === config.ai.directApiKey, "full restore must retain secrets inside encrypted package");
    check(fs.readFileSync(path.join(fullRestore, "hermes", ".env"), "utf8").includes("DEEPSEEK_API_KEY"), "full restore must include app Hermes credentials");

    // Fake Keychain: no test touches the machine's real login keychain.
    let keychainValue = "previous-test-only-value";
    const voiceSecretStore = {
      getVoiceSecret: () => keychainValue,
      setVoiceSecret: (value) => { keychainValue = value; },
      deleteVoiceSecret: () => { keychainValue = null; }
    };
    config.voice = { credentialSource: "keychain", apiKeyEnv: "MIMO_API_KEY" };
    fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
    let missingKeychainRejected = false;
    try {
      await createBackup({ type: "full", password: "test-only-password", stateRoot: state, destinationDir: backups,
        voiceSecretStore: { getVoiceSecret: () => null } });
    } catch { missingKeychainRejected = true; }
    check(missingKeychainRejected, "full backup must reject missing configured Keychain secret");
    keychainValue = "backup-test-only-value";
    const voiceSafe = await createBackup({ type: "safe", stateRoot: state, destinationDir: backups, voiceSecretStore });
    check(!voiceSafe.manifest.files.some((item) => item.path.startsWith("voice-keychain/")), "safe backup must exclude Keychain secret");
    check(voiceSafe.manifest.voiceCredentialRequired === true, "safe backup must mark voice credential as requiring reconfiguration");
    const safeVoiceTarget = path.join(root, "safe-voice-restore");
    const safeVoiceRestored = await restoreBackup({ path: voiceSafe.path, stateRoot: safeVoiceTarget, voiceSecretStore });
    const safeVoiceConfig = JSON.parse(fs.readFileSync(path.join(safeVoiceTarget, "config.json"), "utf8"));
    check(safeVoiceRestored.voiceCredentialRequired && safeVoiceConfig.voice.enabled === false && safeVoiceConfig.voice.credentialSource === "existing", "safe restore must disable voice and avoid foreign Keychain items");
    check(keychainValue === "backup-test-only-value", "safe restore must not read or change Keychain item");
    const voiceFull = await createBackup({ type: "full", password: "test-only-password", stateRoot: state, hermesHome, destinationDir: backups, voiceSecretStore });
    check(voiceFull.manifest.components.includes("voice-keychain") && voiceFull.manifest.files.some((item) => item.path === "voice-keychain/secret"), "encrypted full backup must include Keychain component");
    keychainValue = "previous-test-only-value";
    const voiceTarget = path.join(root, "voice-restore");
    const voiceRestored = await restoreBackup({ path: voiceFull.path, password: "test-only-password", stateRoot: voiceTarget, hermesHome: path.join(voiceTarget, "hermes"), voiceSecretStore });
    check(keychainValue === "backup-test-only-value", "full restore must install Keychain secret");
    await rollbackRestore({ stateRoot: voiceTarget, rollbackDir: voiceRestored.rollbackDir, installedTargets: voiceRestored.installedTargets });
    check(keychainValue === "previous-test-only-value", "post-restore rollback must restore previous Keychain value");
    let rollbackActiveSecret = "previous-test-only-value";
    const rollbackFailStore = {
      getVoiceSecret: () => rollbackActiveSecret,
      setVoiceSecret: (value) => {
        if (value === "previous-test-only-value") throw new Error("simulated locked Keychain");
        rollbackActiveSecret = value;
      },
      deleteVoiceSecret: () => { rollbackActiveSecret = null; }
    };
    const rollbackFailTarget = path.join(root, "rollback-fail-voice-restore");
    const rollbackFailResult = await restoreBackup({ path: voiceFull.path, password: "test-only-password", stateRoot: rollbackFailTarget, hermesHome: path.join(rollbackFailTarget, "hermes"), voiceSecretStore: rollbackFailStore });
    let rollbackRejected = false;
    try { await rollbackRestore({ stateRoot: rollbackFailTarget, rollbackDir: rollbackFailResult.rollbackDir, installedTargets: rollbackFailResult.installedTargets }); }
    catch { rollbackRejected = true; }
    check(rollbackRejected && fs.existsSync(path.join(rollbackFailTarget, "config.json")) && rollbackActiveSecret === "backup-test-only-value", "failed Keychain rollback must leave restored config in place for fail-closed caller");
    let failedRestore = false;
    try {
      await restoreBackup({ path: voiceFull.path, password: "test-only-password", stateRoot: path.join(root, "failed-voice-restore"), hermesHome: path.join(root, "outside-hermes"), voiceSecretStore });
    } catch { failedRestore = true; }
    check(failedRestore && keychainValue === "previous-test-only-value", "failed restore must revert Keychain value");
    keychainValue = null;
    const emptyTarget = path.join(root, "empty-voice-restore");
    const emptyRestored = await restoreBackup({ path: voiceFull.path, password: "test-only-password", stateRoot: emptyTarget, hermesHome: path.join(emptyTarget, "hermes"), voiceSecretStore });
    await rollbackRestore({ stateRoot: emptyTarget, rollbackDir: emptyRestored.rollbackDir, installedTargets: emptyRestored.installedTargets });
    check(keychainValue === null, "rollback must delete new Keychain item when none existed before");
    keychainValue = "previous-test-only-value";
    await restoreBackup({ path: full.path, password: "correct horse battery staple", stateRoot: path.join(root, "old-full-restore"), hermesHome: path.join(root, "old-full-restore", "hermes"), voiceSecretStore });
    check(keychainValue === "previous-test-only-value", "old full backup without Keychain component must leave Keychain untouched");

    const apiRefA = "ec021717-671a-4c86-9ca0-c44265deee81";
    const apiRefB = "91b65f87-976e-4e74-9d8b-8fae04fe992c";
    const apiValues = new Map([[apiRefA, "backup-api-value-a"], [apiRefB, "backup-api-value-b"]]);
    const apiSecretStore = {
      getApiSecret: (ref) => apiValues.get(ref) ?? null,
      setApiSecret: (ref, secret) => { apiValues.set(ref, secret); },
      deleteApiSecret: (ref) => { apiValues.delete(ref); }
    };
    config.apiCenter = { connections: [
      { id: "a", credentialSource: "keychain", credentialRef: apiRefA, apiKeyEnv: "DEEPSEEK_API_KEY" },
      { id: "b", credentialSource: "keychain", credentialRef: apiRefB, apiKeyEnv: "MIMO_API_KEY" },
      { id: "legacy", credentialSource: "legacy-voice-keychain", apiKeyEnv: "MIMO_API_KEY" }
    ], profiles: [{ id: "api-asr", kind: "asr", connectionId: "b" }], bindings: { asr: "api-asr" } };
    config.voice.credentialSource = "existing";
    config.voice.enabled = true;
    config.ai.credentialSource = "keychain";
    config.ai.credentialRef = apiRefA;
    fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
    config.apiCenter.connections[0].credentialRef = "../invalid";
    fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
    let invalidRefRejected = false;
    try { await createBackup({ type: "safe", stateRoot: state, destinationDir: backups }); }
    catch { invalidRefRejected = true; }
    check(invalidRefRejected, "backup must reject unsafe API Keychain refs");
    config.apiCenter.connections[0].credentialRef = apiRefA;
    config.apiCenter.connections[1].apiKeyEnv = "not-an-environment-name";
    fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
    const apiSanitized = sanitizeConfigForBackup(config);
    check(apiSanitized.config.apiCenter.connections[0].credentialRef === apiRefA, "API refs must survive generic config sanitization before remapping");
    let missingApiRejected = false;
    try {
      await createBackup({ type: "full", password: "test-only-password", stateRoot: state, destinationDir: backups,
        voiceSecretStore, apiSecretStore: { getApiSecret: () => null } });
    } catch { missingApiRejected = true; }
    check(missingApiRejected, "full backup must reject missing API Keychain credentials");
    const apiSafe = await createBackup({ type: "safe", stateRoot: state, destinationDir: backups });
    check(apiSafe.manifest.apiCredentialReconfigurationRequired === true && apiSafe.manifest.apiKeychainRefs.length === 0,
      "safe backup must indicate API reconfiguration without listing old refs");
    check(!apiSafe.manifest.files.some((item) => item.path.startsWith("api-keychain/")), "safe backup must exclude API Keychain secrets");
    const apiSafeTarget = path.join(root, "api-safe-restore");
    const apiSafeResult = await restoreBackup({ path: apiSafe.path, stateRoot: apiSafeTarget, voiceSecretStore, apiSecretStore });
    const apiSafeConfig = JSON.parse(fs.readFileSync(path.join(apiSafeTarget, "config.json"), "utf8"));
    check(apiSafeResult.apiCredentialReconfigurationRequired === true, "safe restore must report API reconfiguration");
    check(apiSafeResult.voiceCredentialRequired === true && apiSafeConfig.voice.enabled === false,
      "safe restore must disable voice when its selected API connection has no backed-up Keychain secret");
    check(apiSafeConfig.apiCenter.connections[0].credentialRef !== apiRefA && apiSafeConfig.apiCenter.connections[1].credentialRef !== apiRefB,
      "safe restore must remap every API Keychain ref");
    check(apiSafeConfig.ai.credentialSource === "keychain"
      && apiSafeConfig.ai.credentialRef === apiSafeConfig.apiCenter.connections[0].credentialRef,
      "safe restore must keep projected API settings on the fresh fail-closed ref");
    check(apiSafeConfig.apiCenter.connections[0].credentialSource === "keychain"
      && apiSafeConfig.apiCenter.connections[2].credentialSource === "existing"
      && apiSafeConfig.apiCenter.connections[2].apiKeyEnv === "",
      "safe restore must keep API refs fail-closed and disable legacy voice Keychain use");
    check(apiSafeConfig.apiCenter.connections[1].apiKeyEnv === "", "safe backup must remove malformed API env values");
    check(apiValues.get(apiRefA) === "backup-api-value-a", "safe restore must not touch API Keychain");
    const apiFull = await createBackup({ type: "full", password: "test-only-password", stateRoot: state,
      destinationDir: backups, voiceSecretStore, apiSecretStore });
    check(apiFull.manifest.components.includes("api-keychain") && apiFull.manifest.apiKeychainRefs.length === 2,
      "full encrypted backup must list API Keychain refs");
    const wrongRefs = tamperFullManifest(apiFull.path, "test-only-password",
      (manifest) => { manifest.apiKeychainRefs = [apiRefA]; }, "tampered-api-refs");
    let wrongRefsRejected = false;
    try { await inspectBackup({ path: wrongRefs, password: "test-only-password" }); }
    catch { wrongRefsRejected = true; }
    check(wrongRefsRejected, "import must reject API manifest refs that do not match configured refs and files");
    const unsafePath = tamperFullManifest(apiFull.path, "test-only-password",
      (manifest) => { manifest.files.find((item) => item.path === `api-keychain/${apiRefA}`).path = "api-keychain/../unsafe"; }, "tampered-api-path");
    let unsafePathRejected = false;
    try { await inspectBackup({ path: unsafePath, password: "test-only-password" }); }
    catch { unsafePathRejected = true; }
    check(unsafePathRejected, "import must reject unsafe API Keychain manifest paths");
    apiValues.set(apiRefA, "previous-api-a");
    apiValues.delete(apiRefB);
    keychainValue = "previous-test-only-value";
    const apiTarget = path.join(root, "api-full-restore");
    const apiResult = await restoreBackup({ path: apiFull.path, password: "test-only-password", stateRoot: apiTarget,
      voiceSecretStore, apiSecretStore });
    check(apiValues.get(apiRefA) === "backup-api-value-a" && apiValues.get(apiRefB) === "backup-api-value-b"
      && keychainValue === "previous-test-only-value", "full restore must install both API refs and legacy voice secret");
    await rollbackRestore({ stateRoot: apiTarget, rollbackDir: apiResult.rollbackDir, installedTargets: apiResult.installedTargets });
    check(apiValues.get(apiRefA) === "previous-api-a" && !apiValues.has(apiRefB) && keychainValue === "previous-test-only-value",
      "rollback must restore all previous API refs and delete newly created ones");
    const apiRollbackFailStore = {
      getApiSecret: apiSecretStore.getApiSecret,
      setApiSecret: (ref, secret) => {
        if (ref === apiRefA && secret === "previous-api-a") throw new Error("simulated locked Keychain");
        apiValues.set(ref, secret);
      },
      deleteApiSecret: apiSecretStore.deleteApiSecret
    };
    const apiRollbackFailTarget = path.join(root, "failed-api-rollback");
    const apiRollbackFailResult = await restoreBackup({ path: apiFull.path, password: "test-only-password",
      stateRoot: apiRollbackFailTarget, voiceSecretStore, apiSecretStore: apiRollbackFailStore });
    let apiRollbackRejected = false;
    try { await rollbackRestore({ stateRoot: apiRollbackFailTarget, rollbackDir: apiRollbackFailResult.rollbackDir,
      installedTargets: apiRollbackFailResult.installedTargets }); }
    catch { apiRollbackRejected = true; }
    check(apiRollbackRejected && fs.existsSync(path.join(apiRollbackFailTarget, "config.json"))
      && apiValues.get(apiRefA) === "backup-api-value-a" && apiValues.get(apiRefB) === "backup-api-value-b",
      "failed multi-ref rollback must retain restored config and best-effort reapply its API credentials");
    apiValues.set(apiRefA, "previous-api-a");
    apiValues.delete(apiRefB);
    const rejectingApiStore = {
      getApiSecret: apiSecretStore.getApiSecret,
      setApiSecret: (ref, secret) => {
        if (ref === apiRefB) throw new Error("simulated locked Keychain");
        apiValues.set(ref, secret);
      },
      deleteApiSecret: apiSecretStore.deleteApiSecret
    };
    let apiRestoreRejected = false;
    try {
      await restoreBackup({ path: apiFull.path, password: "test-only-password", stateRoot: path.join(root, "failed-api-restore"),
        voiceSecretStore, apiSecretStore: rejectingApiStore });
    } catch { apiRestoreRejected = true; }
    check(apiRestoreRejected && apiValues.get(apiRefA) === "previous-api-a" && !apiValues.has(apiRefB),
      "partial Keychain restore failure must roll back every changed API ref");
    apiValues.set(apiRefB, "backup-api-value-b");
    delete config.voice;
    fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
    const legacyOnlyFull = await createBackup({ type: "full", password: "test-only-password", stateRoot: state,
      destinationDir: backups, voiceSecretStore, apiSecretStore });
    check(legacyOnlyFull.manifest.components.includes("voice-keychain"),
      "legacy API Center voice connection must retain voice-only full backup compatibility");
    const legacyOnlySafe = await createBackup({ type: "safe", stateRoot: state, destinationDir: backups });
    const legacyOnlyTarget = path.join(root, "legacy-only-safe-restore");
    const legacyOnlyResult = await restoreBackup({ path: legacyOnlySafe.path, stateRoot: legacyOnlyTarget,
      voiceSecretStore, apiSecretStore });
    const legacyOnlyConfig = JSON.parse(fs.readFileSync(path.join(legacyOnlyTarget, "config.json"), "utf8"));
    check(legacyOnlyResult.voiceCredentialRequired === true
      && legacyOnlyConfig.apiCenter.connections[2].credentialSource === "existing"
      && legacyOnlyConfig.apiCenter.connections[2].apiKeyEnv === ""
      && legacyOnlyConfig.voice.enabled === false,
      "legacy-only safe restore must not use target voice Keychain item");
    delete config.apiCenter;
    delete config.ai.credentialSource;
    delete config.ai.credentialRef;
    fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
  }

  const beforeCancelled = fs.readdirSync(backups).length;
  const controller = new AbortController();
  let cancelled = false;
  try {
    await createBackup({ type: "full", password: "test cancel", stateRoot: state, hermesHome, destinationDir: backups, signal: controller.signal, onProgress: (item) => { if (item.stage === "checksum") controller.abort(); } });
  } catch (error) { cancelled = error.name === "BackupCancelledError"; }
  check(cancelled, "cancel must report BackupCancelledError");
  check(fs.readdirSync(backups).length === beforeCancelled, "cancel must not leave a partial backup file");

  const broken = path.join(backups, "broken.hermesqqbackup");
  fs.writeFileSync(broken, "not-a-backup");
  let brokenRejected = false;
  try { await inspectBackup({ path: broken }); } catch { brokenRejected = true; }
  check(brokenRejected, "invalid container must be rejected");

  const legacyTarget = path.join(root, "legacy-target");
  const migrated = await migrateLegacyProject({ projectRoot: state, stateRoot: legacyTarget, legacyHermesHome: hermesHome, hermesHome: path.join(legacyTarget, "hermes") });
  check(migrated.ok && migrated.migratedDockerVolumes === 0, "legacy migration without SnowLuma must succeed");
  check(JSON.parse(fs.readFileSync(path.join(legacyTarget, "config.json"), "utf8")).prompt.system === "保持原有风格", "migration must preserve prompt");
  const migratedConfig = JSON.parse(fs.readFileSync(path.join(legacyTarget, "config.json"), "utf8"));
  await checkOwner33Restore(legacyTarget);
  check(migratedConfig.ai.command === "hermes" && migratedConfig.ai.args[0] === "-p" && migratedConfig.ai.args[1] === "hermesqq2", "migration must preserve the legacy Hermes profile");
  check(fs.existsSync(path.join(legacyTarget, "data", "chat-archive", "groups", "123", "messages.jsonl")), "migration must preserve chat archive");
  check(migrated.hermesProfileMigrated && fs.existsSync(path.join(legacyTarget, "hermes", ".env")), "migration must copy Hermes profile into app state");

  // Dynamic account fixture: v2 wins over stale projections, without a count cap.
  const dynamicState = path.join(root, "dynamic-state");
  fs.mkdirSync(path.join(dynamicState, "data"), { recursive: true });
  const dynamicConfig = { bot: { enabled: false }, accounts: { version: 2,
    primary: { id: "stale", protocol: "snowluma", token: "stale-secret" },
    items: Array.from({ length: 12 }, (_, index) => ({ id: `account-${index}`, protocol: index === 2 ? "napcat" : "snowluma",
      protocolContainer: `untouched-container-${index}`, webuiPort: 7100 + index,
      enabled: index !== 1, protocolEnabled: index !== 3, managed: index !== 4, archived: index === 5,
      token: `fixture-secret-${index}`, onebotPath: `/account-${index}` })),
    failoverGroups: [{ id: "fixture-pair", name: "test", memberIds: ["account-0", "account-1"], policyAccountId: "account-0", policy: {}, settings: {} }] } };
  fs.writeFileSync(path.join(dynamicState, "config.json"), JSON.stringify(dynamicConfig));
  const dynamic = await createBackup({ type: "safe", stateRoot: dynamicState, destinationDir: backups });
  check(dynamic.manifest.accounts.length === 12, "safe manifest must include all protocols and archived accounts");
  check(dynamic.manifest.accountRegistry.itemIds.length === 12, "manifest must record all registry IDs");
  check(!JSON.stringify(dynamic.manifest).includes("fixture-secret"), "manifest must not include account credentials");
  const dynamicRestore = path.join(root, "dynamic-restore");
  await restoreBackup({ path: dynamic.path, stateRoot: dynamicRestore });
  const restoredDynamic = JSON.parse(fs.readFileSync(path.join(dynamicRestore, "config.json"), "utf8"));
  check(restoredDynamic.accounts.items.length === 12 && restoredDynamic.accounts.items[5].archived, "safe restore must retain archived registry items");
  check(restoredDynamic.accounts.items.every((item) => item.token === ""), "safe restore must redact credentials from every item");
  check(restoredDynamic.accounts.primary.id === "account-0" && restoredDynamic.accounts.primary.token === "", "legacy projection must be rebuilt from sanitized v2 items");
  check(restoredDynamic.accounts.items.every((item, index) => item.protocolContainer === `untouched-container-${index}`), "safe restore must not rename transport containers");
  check(JSON.stringify(restoredDynamic.accounts.failoverGroups) === JSON.stringify(registryConfig(dynamicConfig).accounts.failoverGroups), "safe restore must preserve effective failover group policies");

  // Execute the embedded enumeration code, never the LaunchAgent shell actions.
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const bootstrap = fs.readFileSync(path.join(projectRoot, "scripts", "start-qq-bot-stack.sh"), "utf8");
  const bootstrapCode = bootstrap.match(/node --input-type=module -e '([\s\S]*?)'\s+"\$project_dir\/config.json"/)?.[1];
  check(Boolean(bootstrapCode), "bootstrap must expose its registry-based enumeration");
  const containers = execFileSync(process.execPath, ["--input-type=module", "-e", bootstrapCode,
    path.join(dynamicState, "config.json"), path.join(projectRoot, "src", "account-registry.js")], { encoding: "utf8" }).split("\n");
  const expected = dynamicConfig.accounts.items.filter((item) => !item.archived && item.managed !== false && item.protocolEnabled !== false);
  check(containers.join() === expected.map((item) => item.protocolContainer).join(), "bootstrap must enumerate all managed protocol-enabled accounts, ignoring bot.enabled and account.enabled");
  const legacyContainers = execFileSync(process.execPath, ["--input-type=module", "-e", bootstrapCode,
    path.join(state, "config.json"), path.join(projectRoot, "src", "account-registry.js")], { encoding: "utf8" }).trim();
  check(legacyContainers === accountItems(config)[0].protocolContainer, "bootstrap must accept legacy account configs");

  // Isolate the real desktop setup handler with fake IPC, Docker and HTTP only.
  const desktop = fs.readFileSync(path.join(projectRoot, "desktop", "main.cjs"), "utf8");
  const setupHandler = desktop.slice(desktop.indexOf('  handle("setup:prepare-snowluma"'), desktop.indexOf('  handle("bot:start"'))
    .replace(/await import\(path\.join\(resourceRoot\(\), "src", "account-registry\.js"\)\)/g, "registry");
  let prepare;
  const desktopCalls = [];
  let deploymentFailed = false;
  vm.runInNewContext(setupHandler, {
    handle: (_name, handler) => { prepare = handler; }, registry: { accountItems, registryConfig }, fs, path,
    stateRoot: () => dynamicState, setupBridgeAllowed: true, setupComplete: () => true,
    resolveExecutable: (name) => name, CONTROL_URL: "http://fixture.invalid",
    execCapture: async (command, args) => { desktopCalls.push({ command, args }); return { ok: true }; },
    fetchJson: async (url) => {
      desktopCalls.push({ url });
      const id = url.match(/\/accounts\/(account-\d+)\/provision$/)?.[1];
      return id ? { ok: true, operationId: id } : { ok: true, operation: { accountId: url.split("/").at(-1), status: deploymentFailed ? "failed" : "completed" } };
    }
  });
  const prepared = await prepare();
  check(prepared.accounts.map((item) => item.id).join() === expected.map((item) => item.id).join(), "desktop setup must prepare every eligible account, including paused bots and NapCat");
  check(desktopCalls.filter((call) => call.url?.endsWith("/provision")).length === expected.length, "desktop setup must issue exactly one provision per eligible account");
  check(!desktopCalls.some((call) => call.url?.endsWith("/login/reset")), "desktop provisioning must never reset login state");
  check(!JSON.stringify(desktopCalls).includes("account-4") && !JSON.stringify(desktopCalls).includes("account-5"), "desktop setup must not operate external or archived accounts");
  deploymentFailed = true;
  let failedDeploymentRejected = false;
  try { await prepare(); } catch { failedDeploymentRejected = true; }
  check(failedDeploymentRejected, "desktop setup must not report success before a deployment operation succeeds");

  // Isolate the actual web restore handler, with no listening server or process.
  const web = fs.readFileSync(path.join(projectRoot, "src", "web-host.js"), "utf8");
  const resetStart = web.indexOf("async function resetRestoredAccounts(");
  const resetHandler = web.slice(resetStart, web.indexOf("\n}\n", resetStart) + 2);
  const webCalls = [];
  const reset = vm.runInNewContext(`${resetHandler}\nresetRestoredAccounts;`, {
    accountItems, registryConfig, readConfig: () => dynamicConfig, childPort: 1234, AbortSignal,
    fetch: async (url) => { webCalls.push(url); return { ok: true, json: async () => ({ ok: true }) }; }
  });
  await reset({ accounts: [{ id: "stale" }], dockerVolumes: dynamicConfig.accounts.items.map((item) => ({ accountId: item.id })) });
  check(webCalls.length === expected.length && expected.every((item) => webCalls.some((url) => url.includes(`/accounts/${item.id}/`))), "web restore must start only eligible restored registry members, not manifest projections");

  fs.writeFileSync(path.join(dynamicState, "config.json"), JSON.stringify({ accounts: { version: 2, items: [], failoverGroups: [], primary: { id: "ghost" } } }));
  const emptyContainers = execFileSync(process.execPath, ["--input-type=module", "-e", bootstrapCode,
    path.join(dynamicState, "config.json"), path.join(projectRoot, "src", "account-registry.js")], { encoding: "utf8" });
  check(emptyContainers === "", "empty registries must not bootstrap a ghost legacy account");
  check((await prepare()).accounts.length === 0, "empty registries must not provision legacy projections");

  if (process.platform === "darwin" && process.arch === "arm64") {
    const badMembership = tamperFullManifest(full.path, "correct horse battery staple", (manifest) => {
      manifest.accountRegistry.itemIds.push("not-in-config");
    }, "wrong-registry-membership");
    let badMembershipRejected = false;
    try { await inspectBackup({ path: badMembership, password: "correct horse battery staple" }); } catch { badMembershipRejected = true; }
    check(badMembershipRejected, "manifest registry membership must match its checksummed config");
    const oldBackup = tamperFullManifest(full.path, "correct horse battery staple", (manifest, payload) => {
      delete manifest.accountRegistry;
      const file = path.join(payload, "state", "config.json");
      const oldConfig = JSON.parse(fs.readFileSync(file, "utf8"));
      oldConfig.accounts = { primary: { id: "legacy-main", protocol: "napcat", protocolContainer: "legacy-existing" }, standbys: [{ id: "legacy-extra", protocol: "napcat" }] };
      fs.writeFileSync(file, JSON.stringify(oldConfig));
      const inventory = manifest.files.find((item) => item.path === "state/config.json");
      inventory.size = fs.statSync(file).size;
      inventory.sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    }, "pre-registry-backup");
    const oldTarget = path.join(root, "old-backup-restore");
    await restoreBackup({ path: oldBackup, password: "correct horse battery staple", stateRoot: oldTarget });
    const oldConfig = JSON.parse(fs.readFileSync(path.join(oldTarget, "config.json"), "utf8"));
    check(oldConfig.accounts.items.map((item) => item.id).join() === "legacy-main,legacy-extra", "pre-v2 backups must restore to dynamic items without changing IDs");
    check(oldConfig.accounts.items[0].protocolContainer === "legacy-existing", "pre-v2 backup transport names must remain unchanged");
  }

  const qzoneOnlyState = path.join(root, "qzone-only-source"), qzoneOnlyTarget = path.join(root, "qzone-only-target");
  fs.mkdirSync(path.join(qzoneOnlyState, "data"), { recursive: true });
  fs.writeFileSync(path.join(qzoneOnlyState, "config.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(qzoneOnlyState, "data", "memory.json"), JSON.stringify({ groups: {}, qzoneSocial: memoryFixture.qzoneSocial }));
  const qzoneOnlyBackup = await createBackup({ type: "safe", stateRoot: qzoneOnlyState, destinationDir: backups, appVersion: "test" });
  await restoreBackup({ path: qzoneOnlyBackup.path, stateRoot: qzoneOnlyTarget });
  const qzoneOnlyRestored = JSON.parse(fs.readFileSync(path.join(qzoneOnlyTarget, "data", "memory.json")));
  const qzoneOnlyOwner = qzoneOnlyRestored.qzoneSocial.bots["account:fixture"].owners["10001"];
  check(qzoneOnlyOwner.drafts.pending.status === "uncertain" && qzoneOnlyOwner.drafts.approved.status === "review",
    "QZone recovery also applies when old socialAgents state is absent");
  check(!Object.hasOwn(qzoneOnlyRestored, "socialAgents") && qzoneOnlyOwner.drafts.terminal.status === "confirmed",
    "QZone-only restore does not invent social state or erase confirmed evidence");

  console.log(JSON.stringify({ ok: true, tests, owner33RoundTrips, fixtureWireCalls,
    safe: path.basename(safe.path), full: path.basename(full.path) }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
