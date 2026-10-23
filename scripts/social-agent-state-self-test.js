import assert from "node:assert/strict";
import {
  socialAgentConfig, ingestSocialMessage, getSocialSnapshot, markSocialRead,
  applySocialContinuity, appendSocialExperience, socialContinuityPrompt,
  setSocialConsent, socialContactAllowed, claimSocialContact, settleSocialContact,
  socialExperienceId,
} from "../src/social-agent-state.js";

// All fixtures live in memory. Never opens config, archives, sockets or models.
const HOUR = 3_600_000, DAY = 24 * HOUR;
const now = Date.UTC(2026, 9, 23, 4); // 12:00 UTC+8
const base = { logicalId: "account:fixture", conversationId: "group:100", now };
const root = { unrelated: { preserve: true } };
const event = (id, extra = {}) => ({ messageId: id, userId: "123", text: `fixture ${id}`,
  sentAt: now - 1000, receivedAt: now, ...extra });
const ingest = (id, extra = {}, scope = base, target = root) => ingestSocialMessage(target,
  { ...scope, message: event(id, extra) });
const unchanged = (target, action, reason) => {
  const before = JSON.stringify(target);
  const result = action();
  assert.equal(result.ok, false, JSON.stringify(result));
  if (reason) assert.equal(result.reason, reason);
  assert.equal(JSON.stringify(target), before, "rejection is atomic and side-effect-free");
};
const snapshot = (scope = base, target = root) => getSocialSnapshot(target, scope);

// Defaults and strict canonical, optional-string config; no input mutation.
const configInput = { enabled: true, conversationIds: ["group:1", "group:1", "private:2", "group:01", "3"],
  profile: { identity: "fixture", examples: ["not a string"], boundaries: "token=secret-example" },
  maxToolCalls: 999, maxDailyCalls: 9999, turnTimeoutMs: -1,
  crossConversation: { enabled: true, groupIds: ["group:1", "1", "private:2"], userIds: ["123", 123, "__proto__"] } };
const configBefore = structuredClone(configInput);
const config = socialAgentConfig(configInput);
assert.deepEqual(configInput, configBefore);
assert.equal(socialAgentConfig().enabled, false);
assert.equal(config.shadowMode, true);
assert.equal(socialAgentConfig({ shadowMode: false }).shadowMode, false);
assert.equal(socialAgentConfig({ enabled: "true" }).enabled, false);
assert.deepEqual(config.conversationIds, ["group:1", "private:2"]);
assert.equal(config.profile.examples, "");
assert(!config.profile.boundaries.includes("secret-example"));
assert.equal(config.maxToolCalls, 8);
assert.equal(config.maxDailyCalls, 9999);
assert.equal(socialAgentConfig().maxDailyCalls, 1000);
assert.equal(socialAgentConfig({ maxDailyCalls: 5000 }).maxDailyCalls, 5000);
assert.equal(socialAgentConfig({ maxDailyCalls: 10000 }).maxDailyCalls, 10000);
assert.equal(socialAgentConfig({ maxDailyCalls: 50000 }).maxDailyCalls, 10000);
assert.equal(config.turnTimeoutMs, 1000);
assert.deepEqual(config.crossConversation.groupIds, ["group:1"]);
assert.deepEqual(config.crossConversation.userIds, ["123"]);
assert.deepEqual(socialAgentConfig(null), socialAgentConfig());

// Read APIs do not create persistent compatibility defaults.
const blank = {};
assert.equal(snapshot(base, blank).seenSeq, 0);
assert.equal(socialContinuityPrompt(blank, { ...base, userId: "123" }), "");
assert.deepEqual(blank, {});
assert.equal(ingest("one").seq, 1);
const saved = JSON.stringify(root);
assert.equal(ingest("one", { text: "a conflicting duplicate" }).duplicate, true);
assert.equal(JSON.stringify(root), saved);
assert.deepEqual(root.unrelated, { preserve: true });
unchanged(root, () => ingest("bot", { isBot: true }), "bot_message");
unchanged(root, () => ingest("stale", { sentAt: now - DAY - 1 }), "stale_message");
unchanged(root, () => ingest("future", { sentAt: now + 120_000 }), "stale_message");
unchanged(root, () => ingest("malformed", { userId: "__proto__" }), "invalid_message");
unchanged(root, () => ingest("badtime", { sentAt: "now" }), "invalid_message");
unchanged(root, () => ingest("wrongprivate", {}, { ...base, conversationId: "private:124" }), "sender_mismatch");
unchanged(root, () => ingest("badconv", {}, { ...base, conversationId: "group:001" }), "invalid_args");
unchanged(root, () => ingest("badowner", {}, { ...base, logicalId: "__proto__" }), "invalid_args");

// Sequence is arrival order, pages cannot silently skip older unread input.
assert.equal(ingest("two", { sentAt: now - 3000 }).seq, 2);
assert.equal(ingest("three").seq, 3);
let page = snapshot({ ...base, limit: 2 });
assert.deepEqual(page.messages.map(item => item.messageId), ["one", "two"]);
assert.equal(page.seenSeq, 2);
assert.equal(page.hasMore, true);
page.messages[0].text = "mutated copy";
assert.notEqual(snapshot().messages[0].text, "mutated copy");
assert.equal(markSocialRead(root, { ...base, throughSeq: page.seenSeq }).ok, true);
assert.deepEqual(snapshot().messages.map(item => item.seq), [3]);
assert.equal(snapshot().hasMore, false);
unchanged(root, () => markSocialRead(root, { ...base, throughSeq: 99 }), "future_watermark");
unchanged(root, () => markSocialRead(root, { ...base, throughSeq: 1 }), "stale_watermark");
assert.equal(markSocialRead(root, { ...base, throughSeq: 2 }).ok, true);

// Logical owner and conversation partitions; runtime-owned fields survive.
assert.equal(ingest("other-owner", {}, { ...base, logicalId: "group:failover-fixture" }).seq, 1);
assert.equal(ingest("other-conv", {}, { ...base, conversationId: "group:101" }).seq, 1);
assert.equal(snapshot().state.nextSeq, 4);
const reserved = { socialAgents: { version: 1, bots: { "account:fixture": {
  runtimeUsage: { days: { fixture: 1 } }, conversations: { "group:100": { runtime: { status: "paused" } } },
} } } };
assert.equal(snapshot(base, reserved).seenSeq, 0);
assert.equal(ingest("reserved", {}, base, reserved).ok, true);
assert.equal(reserved.socialAgents.bots[base.logicalId].runtimeUsage.days.fixture, 1);
assert.equal(reserved.socialAgents.bots[base.logicalId].conversations[base.conversationId].runtime.status, "paused");
unchanged({ socialAgents: { version: 2, bots: {} } }, () => ingest("unsupported", {}, base,
  { socialAgents: { version: 2, bots: {} } }), "unsupported_state");

// Full unread buffer rejects, not evicts; ACK releases room, not dedup receipts.
const full = {};
for (let index = 0; index < 256; index++) assert.equal(ingest(`cap-${index}`, {}, base, full).ok, true);
unchanged(full, () => ingest("cap-extra", {}, base, full), "backpressure");
assert.equal(snapshot(base, full).messages[0].messageId, "cap-0");
markSocialRead(full, { ...base, throughSeq: 1 });
assert.equal(ingest("cap-extra", {}, base, full).ok, true);
assert.equal(ingest("cap-0", {}, base, full).duplicate, true);
assert.equal(snapshot(base, full).messages[0].messageId, "cap-1");

// Actual-sender, original-time evidence. Quote/tool/bot and stale inputs cannot
// become facts; habits are explicitly candidates with 3 sources on 2 dates.
const continuity = {};
const previousDate = now - 13 * HOUR;
ingest("h1", { sentAt: previousDate, receivedAt: previousDate }, { ...base, now: previousDate }, continuity);
ingest("h2", { sentAt: now - 3000 }, base, continuity);
ingest("h3", { sentAt: now - 2000 }, base, continuity);
ingest("h4", { sentAt: now - 1500 }, base, continuity);
ingest("quoted", { isQuoted: true }, base, continuity);
ingest("late", { sentAt: now - HOUR }, base, continuity);
ingest("peer", { userId: "124" }, base, continuity);
const apply = (proposal, ids = ["h1", "h2", "h3"], extra = {}) => applySocialContinuity(continuity,
  { ...base, userId: "123", proposal, evidenceMessageIds: ids, ...extra });
unchanged(continuity, () => apply({ experiences: [{ text: "quote" }] }, ["quoted"]), "invalid_evidence");
unchanged(continuity, () => apply({ experiences: [{ text: "late" }] }, ["late"]), "invalid_evidence");
unchanged(continuity, () => apply({ experiences: [{ text: "other sender" }] }, ["peer"]), "invalid_evidence");
unchanged(continuity, () => apply({ experiences: [{ text: "unknown" }] }, ["missing"]), "invalid_evidence");
unchanged(continuity, () => apply({ identity: "rewrite persona" }), "unsupported_proposal");
unchanged(continuity, () => apply({ mood: { valence: NaN } }), "invalid_mood");
assert.equal(apply({ habits: [{ text: "not enough" }] }, ["h1", "h1", "h2"]).ok, true);
assert.equal(snapshot(base, continuity).habits.length, 0);
assert.equal(snapshot(base, continuity).habitCandidates[0].evidence.length, 2);
unchanged(continuity, () => apply({ habits: [{ text: "same date" }] }, ["h2", "h3", "peer"], { userId: "123" }), "invalid_evidence");
assert.equal(apply({ habits: [{ text: "same date actual human" }] }, ["h2", "h3", "h4"]).ok, true);
assert.equal(snapshot(base, continuity).habits.length, 0);
for (const key of ["identity", "persona", "profile", "kind", "explicit", "candidate", "evidence", "revokedAt"]) {
  for (const kind of ["experiences", "habits"]) unchanged(continuity,
    () => apply({ [kind]: [{ text: "hidden field must reject", [key]: "forged" }] }), "invalid_proposal");
}
unchanged(continuity, () => apply({ experiences: [{ text: "outside pinned batch", evidenceMessageIds: ["peer"] }] }), "invalid_evidence");
assert.equal(apply({ mood: { valence: 1, arousal: 0.5, engagement: -0.5 },
  experiences: [{ text: "fixture likes tea" }], habits: [{ text: "fixture tea candidate" }] }).ok, true);
assert.equal(snapshot(base, continuity).habits[0].candidate, true);
assert.deepEqual(snapshot(base, continuity).habits[0].evidence.map(item => item.sentAt), [previousDate, now - 3000, now - 2000]);
assert.equal(apply({ habits: [{ text: "fixture tea candidate" }] }).habitsAdded, 0);
unchanged(continuity, () => apply({ mood: { valence: -1 } }), "stale_mood_proposal");
assert.equal(snapshot({ ...base, now: now + 2 * HOUR }, continuity).mood.valence, 0.5);
const restarted = JSON.parse(JSON.stringify(continuity));
assert.equal(snapshot({ ...base, now: now + 4 * HOUR }, restarted).mood.valence, 0.25);
assert.equal(snapshot({ ...base, now: now - HOUR }, restarted).mood.valence, 1);
unchanged(continuity, () => apply({ experiences: [{ text: "too old now" }] }, ["h1"], { now: now + DAY }), "invalid_evidence");
assert.equal(snapshot({ ...base, logicalId: "account:other" }, continuity).habits.length, 0);
assert.equal(snapshot({ ...base, conversationId: "group:101" }, continuity).experiences.length, 0);
assert.equal(socialContinuityPrompt(continuity, { ...base, userId: "124" }).includes("fixture likes tea"), false);
assert.equal(appendSocialExperience(continuity, { ...base, userId: "123", messageId: "tool1", text: "tool fixture",
  sentAt: now, kind: "tool_result", confirmed: true }).ok, true);
assert.equal(appendSocialExperience(continuity, { ...base, userId: "123", messageId: "tool1", text: "duplicate",
  sentAt: now, kind: "tool_result", confirmed: true }).duplicate, true);
unchanged(continuity, () => apply({ experiences: [{ text: "tool is not human evidence" }] }, ["tool1"]), "invalid_evidence");
assert(socialContinuityPrompt(continuity, { ...base, userId: "123" }).length < 10_000);

// Stable exact IDs are conversation-qualified and source-bound, not array
// offsets or fuzzy text. Legacy read projection must NEVER mutate stored roots.
const experiences = continuity.socialAgents.bots[base.logicalId].conversations[base.conversationId].experiences;
const humanExperience = experiences.find(item => item.kind === "human_experience");
const toolExperience = experiences.find(item => item.kind === "tool_result");
assert.match(humanExperience.id, /^experience:group:100:[a-f0-9]{64}$/);
assert.match(toolExperience.id, /^experience:group:100:[a-f0-9]{64}$/);
assert.equal(socialExperienceId(JSON.parse(JSON.stringify(toolExperience)), base), toolExperience.id);
assert.equal(socialExperienceId({ ...toolExperience, id: undefined, text: "changed tool display text", createdAt: now + 1 }, base), toolExperience.id);
assert.equal(socialExperienceId({ ...humanExperience, id: undefined, evidenceMessageIds: [...humanExperience.evidenceMessageIds].reverse(),
  revokedAt: now, status: "revoked", updatedAt: now + DAY }, base), humanExperience.id);
assert.notEqual(socialExperienceId({ ...humanExperience, id: undefined, text: "distinct claim on same source batch" }, base), humanExperience.id);
assert.notEqual(socialExperienceId({ ...toolExperience, id: undefined }, { conversationId: "group:101" }), toolExperience.id);
assert.notEqual(socialExperienceId({ ...toolExperience, id: undefined, kind: "bot_reply" }, base), toolExperience.id);
assert.notEqual(socialExperienceId({ ...toolExperience, id: undefined, userId: "124" }, base), toolExperience.id);
assert.notEqual(socialExperienceId({ ...toolExperience, id: undefined, messageId: "different-tool-source" }, base), toolExperience.id);
assert.equal(socialExperienceId(toolExperience, { conversationId: "invalid" }), "");
assert.equal(socialExperienceId(null, base), "");
const oldExperienceRoot = JSON.parse(JSON.stringify(continuity));
const oldExperiences = oldExperienceRoot.socialAgents.bots[base.logicalId].conversations[base.conversationId].experiences;
for (const item of oldExperiences) delete item.id;
oldExperiences.push({ userId: "123", text: "source-less legacy fixture", sentAt: now - 1000, createdAt: now });
const beforeExperienceProjection = JSON.stringify(oldExperienceRoot);
const projectedExperiences = snapshot(base, oldExperienceRoot).experiences;
assert.equal(projectedExperiences[0].id, humanExperience.id);
assert.equal(projectedExperiences[1].id, toolExperience.id);
assert.equal(JSON.stringify(oldExperienceRoot), beforeExperienceProjection);
assert.equal(snapshot(base, JSON.parse(beforeExperienceProjection)).experiences.at(-1).id, projectedExperiences.at(-1).id);
assert.equal(new Set(projectedExperiences.map(item => item.id)).size, projectedExperiences.length);
assert(!projectedExperiences.at(-1).id.includes("legacy fixture"));
// Bridge can resolve the legacy raw entry using exact ID, WITHOUT first writing
// an id or searching by text. Tombstone preserves both entry and its identity.
const requestedExperienceId = projectedExperiences[0].id;
const matches = oldExperiences.filter(item => socialExperienceId(item, base) === requestedExperienceId);
assert.equal(matches.length, 1);
matches[0].revokedAt = now;
assert.equal(Object.hasOwn(matches[0], "id"), false);
assert.equal(socialExperienceId(matches[0], base), requestedExperienceId);
assert(!snapshot(base, oldExperienceRoot).experiences.some(item => item.id === requestedExperienceId));
assert(!socialContinuityPrompt(oldExperienceRoot, { ...base, userId: "123" }).includes(matches[0].text));

// Multi-day candidates retain ACTUAL raw event provenance, not extracted prose.
// Only fresh outer evidence IDs can be appended; historical IDs cannot be forged
// back into the current batch. Pending candidates are absent from prompt habits.
let multi = {};
const habitText = "fixture repeatedly prepares tea";
const proposeHabit = (target, time, ids, text = habitText, extra = {}) => applySocialContinuity(target,
  { ...base, now: time, userId: "123", proposal: { habits: [{ text }] }, evidenceMessageIds: ids, ...extra });
ingest("multi1", { text: "raw first tea message", sentAt: now }, base, multi);
assert.equal(proposeHabit(multi, now, ["multi1"]).habitsAdded, 0);
const initialCandidate = snapshot(base, multi).habitCandidates[0];
assert(initialCandidate.id);
assert.equal(initialCandidate.evidence[0].text, "raw first tea message");
assert.equal(initialCandidate.evidence[0].conversationId, base.conversationId);
assert(!socialContinuityPrompt(multi, { ...base, userId: "123" }).includes(habitText));
markSocialRead(multi, { ...base, throughSeq: 1 });
for (let index = 0; index < 256; index++) ingest(`rotation-${index}`, { userId: "124" }, base, multi);
markSocialRead(multi, { ...base, throughSeq: 257 });
assert(!multi.socialAgents.bots[base.logicalId].conversations[base.conversationId].messages.some(item => item.messageId === "multi1"));
const day2 = now + 2 * DAY, day3 = now + 4 * DAY;
ingest("multi2", { text: "raw second tea message", sentAt: day2, receivedAt: day2 }, { ...base, now: day2 }, multi);
assert.equal(proposeHabit(multi, day2, ["multi2"]).habitsAdded, 0);
assert.equal(proposeHabit(multi, day2, ["multi2", "multi2"]).habitsAdded, 0);
assert.equal(snapshot({ ...base, now: day2 }, multi).habitCandidates[0].evidence.length, 2);
unchanged(multi, () => proposeHabit(multi, day2, ["multi1", "multi2"]), "invalid_evidence");
// Same original evidence under another candidate wording is not independent
// corroboration of either claim; candidate text is never used as source proof.
assert.equal(proposeHabit(multi, day2, ["multi2"], "a different candidate").habitsAdded, 0);
multi = JSON.parse(JSON.stringify(multi));
ingest("multi3", { text: "raw third tea message", sentAt: day3, receivedAt: day3 }, { ...base, now: day3 }, multi);
assert.equal(proposeHabit(multi, day3, ["multi3"]).habitsAdded, 1);
const promoted = snapshot({ ...base, now: day3 }, multi).habits[0];
assert.equal(promoted.id, initialCandidate.id);
assert.equal(promoted.candidate, true);
assert.deepEqual(promoted.evidence.map(item => item.text), ["raw first tea message", "raw second tea message", "raw third tea message"]);
assert.deepEqual(promoted.evidence.map(item => item.sentAt), [now, day2, day3]);
assert.equal(snapshot({ ...base, now: day3 }, multi).habitCandidates.length, 1);
assert.equal(proposeHabit(multi, day3, ["multi3"]).habitsAdded, 0);
assert.equal(snapshot({ ...base, now: day3 }, multi).habits[0].evidence.length, 3);
// Exact-ID revocation must suppress prompt/snapshot AND prevent proposal replay
// from silently resurrecting the same habit under a new id.
const multiState = multi.socialAgents.bots[base.logicalId].conversations[base.conversationId];
multiState.habits.find(item => item.id === promoted.id).revokedAt = day3;
assert.equal(snapshot({ ...base, now: day3 }, multi).habits.length, 0);
assert(!socialContinuityPrompt(multi, { ...base, userId: "123", now: day3 }).includes(habitText));
unchanged(multi, () => proposeHabit(multi, day3, ["multi3"]), "revoked_habit");
const revokedExperience = continuity.socialAgents.bots[base.logicalId].conversations[base.conversationId].experiences[0];
revokedExperience.revokedAt = now;
assert(!socialContinuityPrompt(continuity, { ...base, userId: "123" }).includes(revokedExperience.text));

// Bounded pending ledger and provenance have explicit backpressure, never
// silent pruning of a candidate/source or consumption of an id on rejection.
const pendingFull = {};
ingest("pending-proof", {}, base, pendingFull);
for (let batch = 0; batch < 4; batch++) assert.equal(applySocialContinuity(pendingFull,
  { ...base, userId: "123", evidenceMessageIds: ["pending-proof"], proposal: {
    habits: Array.from({ length: 8 }, (_, index) => ({ text: `candidate ${batch * 8 + index}` })),
  } }).ok, true);
unchanged(pendingFull, () => proposeHabit(pendingFull, now, ["pending-proof"], "candidate overflow"), "backpressure");
const provenanceFull = {};
for (let index = 0; index < 32; index++) ingest(`source-cap-${index}`, {}, base, provenanceFull);
assert.equal(proposeHabit(provenanceFull, now,
  Array.from({ length: 32 }, (_, index) => `source-cap-${index}`)).ok, true);
ingest("source-overflow", { sentAt: day2, receivedAt: day2 }, { ...base, now: day2 }, provenanceFull);
unchanged(provenanceFull, () => proposeHabit(provenanceFull, day2, ["source-overflow"]), "backpressure");

// Contact consent: authenticated caller still must supply the actual sender's
// original message; opt-in does not manufacture previous private interaction.
const contacts = {};
ingest("consent1", {}, base, contacts);
const consent = { logicalId: base.logicalId, userId: "123", sourceConversationId: base.conversationId,
  now, messageId: "consent1", allowed: true };
assert.equal(setSocialConsent(contacts, consent).ok, true);
assert.equal(setSocialConsent(contacts, consent).duplicate, true);
const permission = { logicalId: base.logicalId, userId: "123", sourceConversationId: base.conversationId,
  now, adminAllowed: true, friendConfirmed: true, sourceQuiet: false, targetQuiet: false };
assert.equal(socialContactAllowed(contacts, permission).reason, "no_private_interaction");
ingest("private-quote", { isQuoted: true }, { ...base, conversationId: "private:123" }, contacts);
assert.equal(socialContactAllowed(contacts, permission).reason, "no_private_interaction");
ingest("private1", {}, { ...base, conversationId: "private:123" }, contacts);
assert.equal(socialContactAllowed(contacts, permission).allowed, true);
for (const change of [{ adminAllowed: false }, { friendConfirmed: false }, { sourceQuiet: true },
  { targetQuiet: true }, { sourceQuiet: undefined }, { sourceConversationId: "group:101" }, { logicalId: "account:other" }]) {
  assert.equal(socialContactAllowed(contacts, { ...permission, ...change }).allowed, false);
}
for (const hour of [0, 8, 22, 23]) {
  const time = Date.UTC(2026, 9, 24, hour - 8);
  assert.equal(socialContactAllowed(contacts, { ...permission, now: time }).reason, "quiet_hours");
}
unchanged(contacts, () => setSocialConsent(contacts, { ...consent, userId: "124" }), "invalid_evidence");
unchanged(contacts, () => setSocialConsent(contacts, { ...consent, allowed: false }), "consent_conflict");
assert.equal(claimSocialContact(contacts, { ...permission, claimId: "claim1" }).ok, true);
unchanged(contacts, () => claimSocialContact(contacts, { ...permission, claimId: "claim1" }), "claim_exists");
unchanged(contacts, () => claimSocialContact(contacts, { ...permission, claimId: "claim2" }), "daily_cap");
assert.equal(settleSocialContact(contacts, { ...permission, claimId: "claim1", status: "uncertain" }).ok, true);
assert.equal(settleSocialContact(contacts, { ...permission, claimId: "claim1", status: "uncertain" }).duplicate, true);
unchanged(contacts, () => settleSocialContact(contacts, { ...permission, claimId: "claim1", status: "sent" }), "already_settled");
const nextDay = { ...permission, now: now + DAY + 1 };
assert.equal(socialContactAllowed(JSON.parse(JSON.stringify(contacts)), nextDay).reason, "unanswered");
// A late-arriving OLD private message cannot count as a response to the claim.
ingest("old-private", { sentAt: now - 2000, receivedAt: now + 2000 },
  { ...base, conversationId: "private:123", now: now + 2000 }, contacts);
assert.equal(socialContactAllowed(contacts, nextDay).reason, "unanswered");
ingest("private-answer", { sentAt: now + DAY, receivedAt: now + DAY },
  { ...base, conversationId: "private:123", now: now + DAY }, contacts);
assert.equal(socialContactAllowed(contacts, nextDay).allowed, true);
assert.equal(claimSocialContact(contacts, { ...nextDay, claimId: "claim2" }).ok, true);
assert.equal(settleSocialContact(contacts, { ...nextDay, claimId: "claim2", status: "failed" }).ok, true);
assert.equal(socialContactAllowed(contacts, { ...nextDay, now: nextDay.now + DAY }).reason, "unanswered");
ingest("revoke", { sentAt: now + 1000, receivedAt: now + 1000 }, { ...base, now: now + 1000 }, contacts);
assert.equal(setSocialConsent(contacts, { ...consent, now: now + 1000, messageId: "revoke", allowed: false }).ok, true);
assert.equal(socialContactAllowed(contacts, nextDay).reason, "no_consent");
unchanged(contacts, () => setSocialConsent(contacts, consent), "stale_consent");
// OneBot timestamps may be second-granularity: later same-time self revocation
// wins by original intake seq, while replaying the old command cannot undo it.
const sameTime = {};
ingest("same-consent", {}, base, sameTime);
ingest("same-revoke", {}, base, sameTime);
assert.equal(setSocialConsent(sameTime, { ...consent, messageId: "same-consent" }).ok, true);
assert.equal(setSocialConsent(sameTime, { ...consent, messageId: "same-revoke", allowed: false }).ok, true);
unchanged(sameTime, () => setSocialConsent(sameTime, { ...consent, messageId: "same-consent" }), "stale_consent");

// A private self command authorizes/revokes a TARGET GROUP without forging its
// event location. Group seq and private seq belong to different order spaces.
const privateConsent = {};
const privateScope = { ...base, conversationId: "private:123" };
ingest("private-allow", {}, privateScope, privateConsent);
const privateArgs = { ...consent, messageId: "private-allow", evidenceConversationId: "private:123" };
assert.equal(setSocialConsent(privateConsent, privateArgs).ok, true);
assert.equal(socialContactAllowed(privateConsent, permission).allowed, true);
assert(!Object.hasOwn(privateConsent.socialAgents.bots[base.logicalId].conversations, base.conversationId));
let record = privateConsent.socialAgents.bots[base.logicalId].users["123"].consents[base.conversationId];
assert.equal(record.sourceConversationId, base.conversationId);
assert.equal(record.evidenceConversationId, "private:123");
assert.equal(record.messageId, "private-allow");
assert.equal(record.sentAt, now - 1000);
assert.equal(record.receivedAt, now);
unchanged(privateConsent, () => setSocialConsent(privateConsent, { ...privateArgs, evidenceConversationId: "private:124" }), "invalid_args");
unchanged(privateConsent, () => setSocialConsent(privateConsent, { ...privateArgs, evidenceConversationId: null }), "invalid_args");
unchanged(privateConsent, () => setSocialConsent(privateConsent, { ...privateArgs, evidenceConversationId: "group:101" }), "invalid_args");
unchanged(privateConsent, () => setSocialConsent(privateConsent, { ...privateArgs, evidenceConversationId: base.conversationId }), "missing_state");
for (let index = 0; index < 8; index++) ingest(`group-noise-${index}`, {}, base, privateConsent);
// A high group seq does not make an older same-time received event newer.
ingest("older-group-grant", { receivedAt: now - 1 }, base, privateConsent);
unchanged(privateConsent, () => setSocialConsent(privateConsent, { ...consent, messageId: "older-group-grant" }), "stale_consent");
// Later receipt time, same sentAt: genuine private revoke wins over group seq.
ingest("group-grant", { receivedAt: now + 1 }, { ...base, now: now + 1 }, privateConsent);
assert.equal(setSocialConsent(privateConsent, { ...consent, messageId: "group-grant", now: now + 1 }).ok, true);
ingest("private-revoke", { receivedAt: now + 2 }, { ...privateScope, now: now + 2 }, privateConsent);
assert.equal(setSocialConsent(privateConsent, { ...privateArgs, messageId: "private-revoke", allowed: false, now: now + 2 }).ok, true);
assert.equal(socialContactAllowed(privateConsent, { ...permission, now: now + 2 }).reason, "no_consent");
// Exact cross-space timestamp ties cannot re-enable a grant after revocation.
ingest("group-ambiguous", { receivedAt: now + 2 }, { ...base, now: now + 2 }, privateConsent);
unchanged(privateConsent, () => setSocialConsent(privateConsent,
  { ...consent, messageId: "group-ambiguous", now: now + 2 }), "ambiguous_consent");
// Same wire id in another conversation is NOT the same command identity.
ingest("private-revoke", { receivedAt: now + 3 }, { ...base, now: now + 3 }, privateConsent);
assert.equal(setSocialConsent(privateConsent, { ...consent, messageId: "private-revoke", now: now + 3 }).ok, true);
record = privateConsent.socialAgents.bots[base.logicalId].users["123"].consents[base.conversationId];
assert.equal(record.evidenceConversationId, base.conversationId);
ingest("private-quoted-command", { isQuoted: true }, privateScope, privateConsent);
unchanged(privateConsent, () => setSocialConsent(privateConsent,
  { ...privateArgs, messageId: "private-quoted-command" }), "invalid_evidence");
assert.equal(socialContactAllowed({}, null).allowed, false);
assert.equal(claimSocialContact({}, null).ok, false);
assert.equal(settleSocialContact({}, null).ok, false);

console.log("social-agent-state self-test: PASS (pure fake fixtures; policy10000, dedup, pagination/backpressure, strict proposals, multi-day provenance, decay/isolation, private consent chronology, claims/revocation)");
