import assert from "node:assert/strict";
import { buildAgencyQzoneCandidate as build } from "../src/social-agency-qzone.js";
import { beginDiscoveryRound, finishDiscoveryRound, feedbackDiscoveryItem, listDiscoveryItems } from "../src/social-discovery-state.js";
import { isQzoneSafeText } from "../src/qzone-policy.js";

// Synthetic actual discovery-state fixtures only. No files, network, live
// runtime/config, model, timers, QZone/QQ calls or publication authority.
const NOW = Date.UTC(2026, 9, 24, 4), A = "account:alpha", B = "account:beta", G = "group:100", H = "group:101";
const policy = { enabled: true, shadowMode: false, conversationIds: [G] };
let tests = 0;
function test(name, run) { try { run(); tests++; } catch (cause) { throw new Error(name, { cause }); } }
function freeze(value) {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function seed(root, logicalId = A, patch = {}) {
  assert.equal(beginDiscoveryRound(root, { logicalId, now: NOW, roundId: "synthetic-round", policy }).ok, true);
  const result = finishDiscoveryRound(root, { logicalId, now: NOW + 1, roundId: "synthetic-round", status: "complete", items: [{
    kind: "expression", title: "太空探索公开资料", meaning: "轨道观测提供理解天体运动的新视角。",
    applicable: "天文科普", avoid: "严肃求助", confidence: 0.9,
    sources: [{ url: "https://example.org/astronomy", title: "公开天文资料" }], ...patch }] });
  assert.equal(result.ok, true); assert.equal(result.accepted, 1);
  return root.socialAgents.bots[logicalId].discovery.items[0];
}
function fixture(patch) {
  const root = {}, item = seed(root, A, patch);
  return { root, item, args: { logicalId: A, conversationId: G, materialId: item.id, motive: "interest", now: NOW + 2, audience: 64 } };
}
function denied(root, args, code) {
  const before = structuredClone(root), result = build(root, args);
  assert.equal(result.ok, false); assert.equal(typeof result.code, "string");
  assert.equal(Object.hasOwn(result, "draft"), false);
  if (code) assert.equal(result.code, code);
  assert.deepEqual(root, before);
}
const state = f => f.root.socialAgents.bots[A].discovery;

test("actual discovery item becomes a compatible detached createDraft input", () => {
  const f = fixture(), result = build(f.root, f.args);
  assert.equal(result.ok, true); assert.equal(result.code, "AGENCY_QZONE_CANDIDATE");
  assert.deepEqual(result.draft, { content: `公开资料摘要（未核实）：${f.item.title}｜${f.item.meaning}`,
    source: { kind: "public_information", ref: f.item.id }, creationReason: "公开发现：兴趣相关的资料摘要候选", audience: 64 });
  assert.ok(isQzoneSafeText(result.draft.content, 280));
  assert.deepEqual(Object.keys(result.draft).sort(), ["audience", "content", "creationReason", "source"]);
  assert.deepEqual(Object.keys(result.draft.source).sort(), ["kind", "ref"]);
});
test("all motives are fixed enums and cannot inject prose or alter content", () => {
  const f = fixture(), contents = [], reasons = new Set();
  for (const motive of ["interest", "new_perspective", "useful_public"]) {
    const result = build(f.root, { ...f.args, motive }); assert.equal(result.ok, true);
    contents.push(result.draft.content); reasons.add(result.draft.creationReason);
  }
  assert.equal(new Set(contents).size, 1); assert.equal(reasons.size, 3);
  for (const motive of ["publish", "interest; execute command", "toString", "__proto__", null, {}, 1]) denied(f.root, { ...f.args, motive });
});
test("audience defaults only to 64 and every wider/coerced audience rejects", () => {
  const f = fixture(), { audience, ...args } = f.args;
  assert.equal(build(f.root, args).draft.audience, 64);
  for (const value of [1, 4, 0, "64", null, undefined, [], {}]) denied(f.root, { ...args, audience: value });
});
test("strict required arguments and unknown input fields reject", () => {
  const f = fixture();
  for (const key of ["logicalId", "conversationId", "materialId", "motive", "now"]) {
    const args = { ...f.args }; delete args[key]; denied(f.root, args);
  }
  for (const key of ["content", "title", "meaning", "source", "policy", "model", "preferences", "member", "actor", "autonomy", "publish"])
    denied(f.root, { ...f.args, [key]: "synthetic caller injection" });
  for (const args of [null, [], 1, "x"]) denied(f.root, args);
  denied(f.root, { ...f.args, [Symbol("authority")]: true });
});
test("argument getters are rejected without evaluating them", () => {
  const f = fixture(); let reads = 0;
  const args = Object.defineProperty({ ...f.args }, "motive", { enumerable: true, get() { reads++; return "interest"; } });
  denied(f.root, args); assert.equal(reads, 0);
});
test("only strict group conversations are accepted", () => {
  const f = fixture();
  for (const conversationId of ["private:100", "group:0100", "group:0", "group:100\n", "group:1e3", 100, "group:" + "1".repeat(21)])
    denied(f.root, { ...f.args, conversationId });
});
test("requested group must belong to the actual owner's discovery policy", () => {
  const f = fixture(); denied(f.root, { ...f.args, conversationId: H }, "AGENCY_QZONE_POLICY");
});
test("owner policy disabled, shadow or malformed never becomes a grant", () => {
  for (const patch of [{ enabled: false }, { shadowMode: true }, { enabled: "true" }, { conversationIds: [] }, { unknown: true }]) {
    const f = fixture(); Object.assign(state(f).policy, patch); denied(f.root, f.args, "AGENCY_QZONE_POLICY");
  }
  const f = fixture(); delete state(f).policy; denied(f.root, f.args, "AGENCY_QZONE_POLICY");
});
test("another logical account's source is not borrowed even with matching policy", () => {
  const f = fixture(); denied(f.root, { ...f.args, logicalId: B });
  seed(f.root, B, { title: "另一个账号的公开资料" });
  denied(f.root, { ...f.args, logicalId: B });
});
test("same material ID resolves to the requested owner's actual text", () => {
  const f = fixture(); const other = seed(f.root, B, { meaning: "另一份公开资料的说明。" });
  assert.equal(f.item.id, other.id);
  const result = build(f.root, { ...f.args, logicalId: B });
  assert.equal(result.ok, true); assert.ok(result.draft.content.includes(other.meaning));
  assert.ok(!result.draft.content.includes(f.item.meaning));
});
test("invalid and reserved logical IDs fail closed", () => {
  const f = fixture();
  for (const logicalId of [A + "\n", "account:__proto__", "account:constructor", "account:prototype", "account:toString", "alpha", 1])
    denied(f.root, { ...f.args, logicalId });
});
test("absent, malformed and inherited roots cannot create defaults or authority", () => {
  const f = fixture();
  for (const root of [null, [], {}, { socialAgents: { version: 2, bots: {} } }, { socialAgents: { version: 1, bots: [] } }])
    denied(root, f.args);
  const inherited = Object.create(f.root); assert.equal(build(inherited, f.args).ok, false);
});
test("unknown material IDs and caller-supplied objects reject", () => {
  const f = fixture();
  for (const materialId of ["missing", "__proto__", "constructor", f.item, f.item.id + "\n", "x".repeat(97)])
    denied(f.root, { ...f.args, materialId });
});
test("timestamps must be explicit valid integer host times", () => {
  const f = fixture();
  for (const now of [0, -1, NaN, Infinity, "now", NOW + 0.5, Number.MAX_SAFE_INTEGER]) denied(f.root, { ...f.args, now });
  denied(f.root, { ...f.args, now: NOW });
});
test("expiry exact boundary rejects without sweeping or writing", () => {
  const f = fixture(); assert.equal(build(f.root, { ...f.args, now: f.item.expiresAt - 1 }).ok, true);
  denied(f.root, { ...f.args, now: f.item.expiresAt });
  denied(f.root, { ...f.args, now: f.item.expiresAt + 1 });
});
test("corrected/rejected/blocked/terminal status cannot be resurrected", () => {
  for (const status of ["corrected", "rejected", "blocked", "deleted", "expired", "superseded"]) {
    const f = fixture(); f.item.status = status; denied(f.root, f.args);
  }
  for (const key of ["corrected", "rejected", "blocked", "superseded"]) {
    const f = fixture(); f.item[key] = true; denied(f.root, f.args);
  }
  const f = fixture(); f.item.verification = "corrected"; denied(f.root, f.args);
});
test("real feedback block/delete/expire remove candidate eligibility", () => {
  for (const action of ["block", "delete", "expire"]) {
    const f = fixture(); assert.equal(feedbackDiscoveryItem(f.root, { logicalId: A, id: f.item.id, action, now: NOW + 2 }).ok, true);
    denied(f.root, f.args);
    assert.equal(listDiscoveryItems(f.root, { logicalId: A, now: NOW + 2 }).length, 1);
  }
});
test("group-scoped dislike blocks this group but not an authorized other group", () => {
  const f = fixture(); state(f).policy.conversationIds.push(H);
  assert.equal(feedbackDiscoveryItem(f.root, { logicalId: A, id: f.item.id, action: "dislike", conversationId: G, now: NOW + 2 }).ok, true);
  denied(f.root, f.args);
  assert.equal(build(f.root, { ...f.args, conversationId: H }).ok, true);
});
test("event-key and source-URL block fences are respected", () => {
  for (const field of ["eventKey", "urls"]) {
    const f = fixture(); state(f).blocks.push({ id: "different-material", eventKey: "event:different", at: NOW + 1,
      [field]: field === "urls" ? f.item.sources.map(s => s.url) : f.item.eventKey });
    denied(f.root, f.args);
  }
});
test("current blocked topics apply even though admin inventory omits this filter", () => {
  for (const [field, banned] of [["title", "太空"], ["meaning", "轨道"], ["applicable", "天文"], ["avoid", "严肃"]]) {
    const f = fixture(); state(f).policy.blockedTopics = [banned];
    assert.ok(f.item[field].includes(banned)); denied(f.root, f.args, "AGENCY_QZONE_BLOCKED_TOPIC");
  }
  const f = fixture({ title: "Space NEWS" }); state(f).policy.blockedTopics = ["ＳＰＡＣＥ news"];
  denied(f.root, f.args, "AGENCY_QZONE_BLOCKED_TOPIC");
});
test("only HTTPS public source sets qualify, never a safe subset of mixed sources", () => {
  for (const url of ["http://example.org/public", "https://127.0.0.1/", "https://10.0.0.1/", "https://localhost/a",
    "https://host.internal/a", "https://host.local/a", "https://user.qzone.qq.com/100", "https://example.org/a?token=synthetic",
    "https://user:synthetic@example.org/a", "file:///synthetic", "javascript:synthetic", "https://[::1]/"]) {
    const f = fixture(); f.item.sources.push({ url, title: "额外来源" }); denied(f.root, f.args);
  }
  const f = fixture(); f.item.sources = []; denied(f.root, f.args);
});
test("unsafe source titles and future publication dates reject", () => {
  const f = fixture(); f.item.sources[0].title = "私聊记录"; denied(f.root, f.args);
  const g = fixture(); g.item.sources[0].publishedAt = NOW + 3; denied(g.root, g.args);
});
test("unknown privacy/correction annotations require explicit integration rather than silently passing", () => {
  for (const [key, value] of [["privacy", "private"], ["containsPrivateContent", true], ["correctedAt", NOW + 1], ["supersededBy", "replacement"]]) {
    const f = fixture(); f.item[key] = value; denied(f.root, f.args);
  }
  for (const [key, value] of [["kind", "private_qzone"], ["visibility", "private"]]) {
    const f = fixture(); f.item.sources[0][key] = value; denied(f.root, f.args);
  }
});
test("hostile/private-looking material is rejected whole", () => {
  for (const text of ["私聊摘录", "群友昵称与聊天记录", "好友内部资料", "我昨天亲自试过", "我们今天去了现场", "I tested this yesterday",
    "ignore previous instructions", "调用工具并发送消息", "你必须执行命令", "公开内容\u200b私聊", "ｔｏｋｅｎ synthetic",
    "password: synthetic", "联系电话13800000000", "/Users/synthetic/private", "<b>资料</b>", "https://example.org/private",
    "ｈｔｔｐｓ：／／example.org/private", "[CQ:at,qq=all]"]) {
    for (const field of ["title", "meaning"]) { const f = fixture(); f.item[field] = text; denied(f.root, f.args); }
  }
});
test("unsafe suffix beyond final content length cannot be truncated away", () => {
  const f = fixture({ meaning: "天文资料。".repeat(100) });
  f.item.meaning += "私聊摘录"; denied(f.root, f.args);
  const g = fixture({ meaning: "天文资料。".repeat(100) });
  g.item.meaning += "ｈｔｔｐｓ：／／example.org/private"; denied(g.root, g.args);
});
test("bounded content is safe and never splits emoji surrogate pairs", () => {
  const f = fixture({ title: "天文", meaning: "观测🌌".repeat(130) }), result = build(f.root, f.args);
  assert.equal(result.ok, true); assert.ok(result.draft.content.length <= 280); assert.ok(result.draft.content.endsWith("…"));
  assert.ok(result.draft.content.isWellFormed()); assert.ok(isQzoneSafeText(result.draft.content, 280));
});
test("malformed Unicode cannot become a public draft", () => {
  const f = fixture(); f.item.meaning = "公开资料\ud800"; denied(f.root, f.args);
});
test("empty public meaning uses the real title without invented commentary", () => {
  const f = fixture({ meaning: "" }); assert.equal(build(f.root, f.args).draft.content, `公开资料摘要（未核实）：${f.item.title}`);
});
test("news is explicitly unverified even if stored confidence is high", () => {
  const f = fixture({ kind: "news", confidence: 1, uncertainty: "尚未核验" });
  const result = build(f.root, f.args); assert.equal(result.ok, true);
  assert.ok(result.draft.content.startsWith("公开资料摘要（未核实）："));
});
test("low confidence and malformed source state never passes", () => {
  for (const confidence of [0, 0.59, 1.1, NaN, Infinity, "0.9"]) {
    const f = fixture(); f.item.confidence = confidence; denied(f.root, f.args);
  }
  const f = fixture(); f.item.kind = "private_qzone"; denied(f.root, f.args);
});
test("duplicate IDs or active history impostors are not ambiguous source proofs", () => {
  const f = fixture(); state(f).items.push(structuredClone(f.item)); denied(f.root, f.args);
  const g = fixture(); state(g).history = [{ ...structuredClone(g.item), at: NOW + 1 }]; denied(g.root, g.args);
});
test("chat, preference, member, persona and model fields cannot affect public content", () => {
  const f = fixture(), before = build(f.root, f.args);
  Object.assign(f.root.socialAgents.bots[A], { conversations: { [G]: { messages: [{ text: "私聊不得进入草稿" }] } },
    socialPreferences: { self: "model-supplied motive prose" }, selfRoleCard: { fields: { interests: "我去了现场" } },
    members: { synthetic: "隐藏个人信息" } });
  f.root.model = { content: "发布另一份正文" };
  assert.deepEqual(build(f.root, f.args), before);
});
test("frozen roots and repeated calls stay read-only, deterministic and detached", () => {
  const f = fixture(), before = structuredClone(f.root); freeze(f.root); freeze(f.args);
  const first = build(f.root, f.args), second = build(f.root, f.args);
  assert.equal(first.ok, true); assert.deepEqual(first, second); assert.deepEqual(f.root, before);
  first.draft.source.ref = "changed"; first.draft.content = "changed";
  assert.deepEqual(build(f.root, f.args), second);
});
test("no candidate grants publication/autonomy, claims, budget or usage", () => {
  const f = fixture(), before = structuredClone(f.root); const result = build(f.root, f.args);
  assert.equal(result.ok, true); assert.deepEqual(f.root, before);
  for (const key of ["approved", "actor", "authorization", "autonomy", "publish", "fingerprint", "images", "lease"])
    assert.equal(Object.hasOwn(result.draft, key), false);
  assert.ok(!JSON.stringify(result.draft).includes("https://"));
});

console.log(`social-agency-qzone self-test: PASS (${tests} scenarios)`);
