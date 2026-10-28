import assert from "node:assert/strict";
import { beginDiscoveryRound, finishDiscoveryRound, listDiscoveryItems, feedbackDiscoveryItem } from "../src/social-discovery-state.js";
import { buildAgencyQzoneCandidate } from "../src/social-agency-qzone.js";
import { createQzoneRuntime } from "../src/qzone-runtime.js";
import { normalizeQzonePolicy } from "../src/qzone-policy.js";

// Actual stores and QZone review runtime with an in-memory sole-writer double.
// Any protocol/model invocation throws, including reads. No private feeds.
const logicalId = "account:alpha", conversationId = "group:101", now = Date.UTC(2026, 9, 28, 5);
let memory = {}, beforeCommit, current = true, wire = 0;
assert(beginDiscoveryRound(memory, { logicalId, now: now - 2, roundId: "public-round",
  policy: { enabled: true, shadowMode: false, conversationIds: [conversationId] } }).ok);
assert(finishDiscoveryRound(memory, { logicalId, now: now - 1, roundId: "public-round", status: "complete", items: [{
  kind: "expression", title: "太空探索公开资料", meaning: "轨道观测提供理解天体运动的新视角。", applicable: "天文科普", avoid: "严肃求助", confidence: 0.9,
  sources: [{ url: "https://example.org/astronomy", title: "公开天文资料" }] }] }).ok);
const materialId = memory.socialAgents.bots[logicalId].discovery.items[0].id;
const candidate = () => buildAgencyQzoneCandidate(memory, { logicalId, conversationId, materialId, now, motive: "interest", audience: 64 });
const deps = { capture: accountId => ({ accountId, logicalId, qq: accountId === "alpha" ? "111" : "222", revision: "fixture",
  policy: normalizeQzonePolicy({ enabled: true, mode: "draft_only", allowedAudiences: [64] }), protocolVersion: "synthetic" }),
  isCurrent: () => current, readState: () => ({ memory }), clock: () => now,
  transact: async build => { beforeCommit?.(); const draft = structuredClone(memory); const out = build({ memory: draft }); memory = draft; return out; },
  isAdministrator: () => false, peerQqs: () => [], request: async () => { wire++; throw Error("NO_PROTOCOL_ALLOWED"); },
  isSourceAllowed: (ctx, source) => ctx.logicalId === logicalId && source.kind === "public_information"
    && listDiscoveryItems(memory, { logicalId, conversationId, now, includeInactive: false }).some(item => item.id === source.ref) };
const runtime = createQzoneRuntime(deps), ctx = runtime.open("alpha");
const first = candidate(); assert(first.ok);
const draft = await runtime.createDraft(ctx, first.draft);
assert.equal(draft.status, "draft"); assert.equal(draft.audience, 64);
assert.equal(draft.approval, undefined); assert.equal(wire, 0);
await assert.rejects(runtime.createDraft(ctx, candidate().draft), /QZONE_DUPLICATE/, "existing fingerprint refuses duplicate candidate rather than retrying");
assert.equal(runtime.status(ctx).drafts.length, 1);
await assert.rejects(runtime.publish(ctx, draft.id, draft.revision), /QZONE_/);
assert.equal(wire, 0, "draft candidate cannot publish without existing review/authority");
await assert.rejects(runtime.createDraft(deps.capture("alpha"), candidate().draft), /QZONE_CONTEXT/, "raw capture is not an opened host context");
beforeCommit = () => { current = false; };
await assert.rejects(runtime.createDraft(ctx, { ...candidate().draft, creationReason: "公开发现：不同角度" }), /QZONE_/);
assert.equal(wire, 0); current = true; beforeCommit = undefined;
assert(feedbackDiscoveryItem(memory, { logicalId, conversationId, id: materialId, action: "block", now,
  policy: memory.socialAgents.bots[logicalId].discovery.policy }).ok);
assert.equal(candidate().ok, false, "blocked public source cannot yield a later candidate");
await assert.rejects(runtime.createDraft(ctx, first.draft), /QZONE_SOURCE_PROOF_REQUIRED/);
assert.equal(wire, 0);
console.log(JSON.stringify({ ok: true, actualStoresAndReviewRuntime: true, drafts: 1, protocolCalls: 0, modelCalls: 0, privateFeeds: 0, productionTouched: false }));
