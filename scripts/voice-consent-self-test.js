import assert from "node:assert/strict";
import { OneShotVoiceConsent } from "../src/voice-consent.js";

const consent = new OneShotVoiceConsent({ ttlMs: 1000 });
const ref = { source: "quoted", senderId: "123", messageId: "42", url: "https://media.qq.com/example.mp3" };
assert.throws(() => consent.request({ conversationId: "group:1", senderId: "456", accountId: "primary", ref, speech: "测试", now: 1 }), /speaker/);
assert.throws(() => consent.request({ conversationId: "group:1", senderId: "123", accountId: "primary", ref: { ...ref, source: "current" }, speech: "测试", now: 1 }), /speaker/);
const code = consent.request({ conversationId: "group:1", senderId: "123", accountId: "primary", ref, speech: "测试", now: 1 });
assert.equal(consent.confirm({ conversationId: "group:1", senderId: "456", accountId: "primary", code, now: 2 }), null);
assert.equal(consent.confirm({ conversationId: "group:1", senderId: "123", accountId: "standby-a", code, now: 2 }), null);
assert.equal(consent.confirm({ conversationId: "group:1", senderId: "123", accountId: "primary", code, now: 2 }), null, "wrong-account attempt consumes request");
const freshCode = consent.request({ conversationId: "group:1", senderId: "123", accountId: "primary", ref, speech: "测试", now: 10 });
assert.deepEqual(consent.confirm({ conversationId: "group:1", senderId: "123", accountId: "primary", code: freshCode, now: 11 }), { ref, speech: "测试" });
assert.equal(consent.confirm({ conversationId: "group:1", senderId: "123", accountId: "primary", code: freshCode, now: 12 }), null, "consent is one-use");
const expiredCode = consent.request({ conversationId: "group:1", senderId: "123", accountId: "primary", ref, speech: "测试", now: 20 });
assert.equal(consent.confirm({ conversationId: "group:1", senderId: "123", accountId: "primary", code: expiredCode, now: 1020 }), null);
console.log(JSON.stringify({ ok: true, checks: "speaker binding, account binding, confirmation, expiry, one use" }));
