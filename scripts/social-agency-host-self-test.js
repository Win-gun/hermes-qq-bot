import assert from "node:assert/strict";
import { ingestSocialMessage, appendSocialExperience } from "../src/social-agent-state.js";
import { getSocialPreferences } from "../src/social-preferences.js";
import { getSocialIntentJournal, proposeSocialIntent } from "../src/social-intent-journal.js";
import { normalizeAgencyPolicy, validateAgencyProposal, agencySnapshot, applyAgencyObservations,
  claimAgencyIntent, completeAgencyIntent, abandonAgencyAttention } from "../src/social-agency.js";

const now = Date.UTC(2026, 9, 28, 5), logicalId = "account:alpha", conversationId = "group:101", userId = "11";
const root = {}, base = { logicalId, conversationId, now }, coreText = "喜欢科技，表达稳健";
let checks = 0;
const check = (x, note) => { assert(x, note); checks++; };
const human = (id, text, conv = conversationId, bot = logicalId) => check(ingestSocialMessage(root, { logicalId: bot, conversationId: conv, now,
  message: { messageId: id, userId, text, sentAt: now, receivedAt: now } }).ok, "synthetic human ingestion");
human("human-a", "我喜欢科技，愿意讨论公开的新进展"); human("human-b", "本群关注摄影", "group:202");
human("peer-human", "同一个公开话题", conversationId, "account:beta");
const args = { ...base, userId, coreText, seenMessageIds: ["human-a"], ownEvidenceIds: [], materialIds: [], offeredIntentIds: [] };
const member = { kind: "member", dimension: "interest", value: "科技", evidenceMessageIds: ["human-a"] };
const thought = { kind: "question", summary: "科技发展的新方向", reason: "话题具有进一步了解的价值",
  trigger: { kind: "related_message", terms: ["科技"] }, evidenceMessageIds: ["human-a"], ttlMs: 60000 };
check(normalizeAgencyPolicy().enabled === false && normalizeAgencyPolicy().publicDrafts === false, "default off");
assert.throws(() => normalizeAgencyPolicy({ enabled: "true" })); checks++;
assert.throws(() => validateAgencyProposal({ useIntentIds: ["intent:a", "intent:b"] })); checks++;
assert.throws(() => validateAgencyProposal({ useIntentIds: ["intent:a"], abandonIntentIds: ["intent:a"] })); checks++;
const before = JSON.stringify(root);
check(!applyAgencyObservations(root, { ...args, proposal: { preferences: [member], intents: [{ ...thought, evidenceMessageIds: ["human-b"] }] } }).ok,
  "forged source in later batch rejected");
check(JSON.stringify(root) === before, "no partial preference write when later intent fails");
check(!applyAgencyObservations(root, { ...args, proposal: { preferences: [{ ...member, kind: "self" }] } }).ok, "human cannot authorize a self preference");
check(JSON.stringify(root) === before, "self spoof leaves no default state");
check(applyAgencyObservations(root, { ...args, proposal: { preferences: [member], intents: [thought] } }).ok, "one coherent candidate batch");
const pref = getSocialPreferences(root, { ...base, userId }).entries;
check(pref.length === 1 && pref[0].kind === "member" && pref[0].status === "candidate", "ownership and maturity retained");
const offered = agencySnapshot(root, { ...base, userId, coreText, query: "科技" });
check(offered.intentions.length === 1 && offered.ownEvidence.length === 0, "only current-group related candidate offered");
const id = offered.intentions[0].id;
check(!claimAgencyIntent(root, { ...base, ids: [id], offeredIntentIds: [id], eventMessageIds: ["human-a"] }).ok, "old source alone cannot wake a new thought");
human("fresh-topic", "科技有了新进展");
check(claimAgencyIntent(root, { ...base, ids: [id], offeredIntentIds: [id], eventMessageIds: ["fresh-topic"] }).ok, "fresh related event claims pending before wire");
check(agencySnapshot(root, { ...base, userId, coreText, query: "科技" }).intentions.length === 0, "pending never offered again");
const pending = JSON.stringify(root);
check(!completeAgencyIntent(root, { ...base, id, receiptMessageId: "invented" }).ok, "invented receipt rejected");
check(JSON.stringify(root) === pending, "unconfirmed receipt atomic");
check(appendSocialExperience(root, { ...base, userId, messageId: "real-ack", text: "科技也可以从这个方向考虑", sentAt: now,
  kind: "bot_reply", confirmed: true, agencyEligible: true }).ok, "host-confirmed own ACK");
check(completeAgencyIntent(root, { ...base, id, receiptMessageId: "real-ack" }).ok, "confirmed completion");
check(getSocialIntentJournal(root, base).entries[0].status === "expressed", "durable expressed state");
check(agencySnapshot(root, { ...base, userId, coreText, query: "科技" }).ownEvidence[0].messageId === "real-ack", "own evidence host marker survives");
const second = proposeSocialIntent(root, { ...base, ...thought, summary: "科技发展的另一条新线索", expectedRevision: 3 });
check(second.ok, "new source meaning may be considered once");
const foreign = { ...base, conversationId: "group:202", expectedRevision: 4,
  ...thought, evidenceMessageIds: ["human-b"], summary: "摄影相关的新思路", trigger: { kind: "related_message", terms: ["摄影"] } };
check(proposeSocialIntent(root, foreign).ok, "different group independent journal scope");
human("stop", "别再跟进这个话题");
const stopBefore = JSON.stringify(root);
check(!abandonAgencyAttention(root, { ...base, sourceMessageId: "invented" }).ok, "stop must resolve actual source");
check(JSON.stringify(root) === stopBefore, "forged stop no mutation");
check(abandonAgencyAttention(root, { ...base, sourceMessageId: "stop" }).cancelled === 1, "actual addressed stop abandons only live candidate");
check(getSocialIntentJournal(root, { ...base, conversationId: "group:202" }).entries[0].status === "candidate", "stop does not cancel other group");
check(getSocialIntentJournal(root, base).entries.find(e => e.id === id).status === "expressed", "terminal history untouched by stop");
const bad = structuredClone(root); bad.socialAgents.bots[logicalId].socialIntentJournal = { version: 999 };
assert.throws(() => agencySnapshot(bad, { ...base, userId, coreText, query: "科技" }), /INVALID_JOURNAL/); checks++;
console.log(JSON.stringify({ ok: true, checks, synthetic: true, modelCalls: 0, qqSends: 0, stateIO: false }));
