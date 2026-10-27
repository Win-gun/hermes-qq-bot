import assert from "node:assert/strict";
import { recordSocialEpisode, listSocialEpisodes, socialEpisodesPrompt } from "../src/social-episodes.js";
import { qzoneActionKind, QZONE_READ_ACTIONS, QZONE_WRITE_ACTIONS, isQzoneAction } from "../src/qzone-delivery.js";
import { accountDeliveryDecision } from "../src/account-delivery.js";
import { registryConfig } from "../src/account-registry.js";

let checks = 0;
const check = fn => { fn(); checks++; };
const root = {}, owner = "account:alpha";
const base = { logicalId: owner, conversationId: "group:123456", kind: "sticker_interaction",
  eventId: "receipt:one", status: "confirmed", at: 1800000000000, text: "一起用猫猫表情接话" };
check(() => { const before = JSON.stringify(root); assert.deepEqual(listSocialEpisodes(root, base), []); assert.equal(JSON.stringify(root), before); });
check(() => assert.equal(recordSocialEpisode(root, base).ok, true));
check(() => { assert.equal(recordSocialEpisode(root, base).duplicate, true); assert.equal(listSocialEpisodes(root, base).length, 1); });
check(() => { recordSocialEpisode(root, { ...base, status: "failed", text: "迟到结果" }); assert.equal(listSocialEpisodes(root, base)[0].status, "confirmed"); });
for (const conversationId of ["private:123456", "group:234567", "qzone:123456"]) check(() =>
  assert.deepEqual(listSocialEpisodes(root, { ...base, conversationId }), []));
check(() => assert.deepEqual(listSocialEpisodes(root, { ...base, logicalId: "account:beta" }), []));
check(() => { const rows = listSocialEpisodes(root, base); rows[0].text = "mutated"; assert.notEqual(listSocialEpisodes(root, base)[0].text, "mutated"); });
check(() => assert.throws(() => recordSocialEpisode(root, { ...base, kind: "qzone_publish" }), /SOURCE/));
check(() => assert.throws(() => recordSocialEpisode(root, { ...base, logicalId: "__proto__" }), /SCOPE/));
check(() => assert.throws(() => recordSocialEpisode(root, { ...base, eventId: "../outside" }), /SOURCE/));
check(() => assert.throws(() => recordSocialEpisode({ socialEpisodes: { version: 99 } }, base), /STATE/));
check(() => { recordSocialEpisode(root, { ...base, kind: "reaction", eventId: "native:one", status: "accepted" });
  assert.equal(listSocialEpisodes(root, base).at(-1).evidence, "host_event"); });
check(() => { recordSocialEpisode(root, { ...base, eventId: "receipt:secret", text: "token=fixture-marker-9876 <script>alert(1)</script> https://example.test/?secret=hidden" });
  assert.doesNotMatch(listSocialEpisodes(root, base).at(-1).text, /fixture-marker|https:|<script/); });
for (const audience of [1, 4, 16, 64, 128]) {
  const q = { ...base, conversationId: "qzone:345678", kind: "qzone_publish", eventId: `publication:${audience}`,
    audience, text: `unique-publication-${audience}` };
  recordSocialEpisode(root, q);
  check(() => { const prompt = socialEpisodesPrompt(root, { ...base, ownQq: "345678", includeOwnPublicQzone: true });
    assert.equal(prompt.includes(q.text), audience === 1); });
}
check(() => { recordSocialEpisode(root, { ...base, conversationId: "qzone:345678", kind: "qzone_publish", eventId: "notverified",
  audience: 1, status: "accepted", text: "accepted-only-never-share" });
  assert.ok(!socialEpisodesPrompt(root, { ...base, ownQq: "345678", includeOwnPublicQzone: true }).includes("accepted-only-never-share")); });
check(() => assert.ok(!socialEpisodesPrompt(root, { ...base, ownQq: "456789", includeOwnPublicQzone: true }).includes("unique-publication-1")));
check(() => assert.ok(!socialEpisodesPrompt(root, { ...base, includeOwnPublicQzone: false }).includes("unique-publication-1")));
for (const action of QZONE_READ_ACTIONS) check(() => assert.equal(qzoneActionKind(action), "read"));
for (const action of QZONE_WRITE_ACTIONS) check(() => assert.equal(qzoneActionKind(action), "write"));
for (const action of ["qzone_unknown", "LIKE_QZONE", "send_qzone_msg "]) check(() => {
  assert.equal(isQzoneAction(action), true); assert.equal(qzoneActionKind(action), "unknown");
});
const config = registryConfig({ accounts: { items: [{ id: "alpha", qq: "345678", enabled: true, protocolEnabled: true }] } });
for (const action of [...QZONE_READ_ACTIONS, ...QZONE_WRITE_ACTIONS, "qzone_unknown", "add_custom_face"]) check(() =>
  assert.equal(accountDeliveryDecision(config, "alpha", action).allowed, false));
check(() => {
  const full = {};
  for (let i = 0; i < 512; i++) recordSocialEpisode(full, { ...base, eventId: `capacity:${i}` });
  const before = JSON.stringify(full);
  assert.equal(recordSocialEpisode(full, { ...base, eventId: "capacity:overflow" }).code, "EPISODE_CAPACITY");
  assert.equal(JSON.stringify(full), before, "optional projection backpressure never evicts durable evidence");
});
console.log(JSON.stringify({ ok: true, checks, fixtureOnly: true, qqSends: 0, modelCalls: 0 }));
