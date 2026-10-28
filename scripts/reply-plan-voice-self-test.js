import assert from "node:assert/strict";
import { validateReplyPlan, parseReplyPlan, replyPlanPrompt, fromSocialMessages } from "../src/reply-plan.js";
import { executeReplyPlan } from "../src/expression-renderer.js";

// Synthetic only: no files, sockets, models, real credentials or live state.
let checks = 0;
async function test(name, run) {
  try { await run(); checks++; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
const voice = (content = "今天也要好好休息。") => ({ type: "voice", content });
const text = (content = "另一段文字") => ({ type: "text", content });
const plan = (messages = [voice()], patch = {}) => ({ version: 1, action: "reply", messages, replyToMessageId: null, ...patch });
const opts = { allowVoice: true };
const emptyResult = { sent: 0, accepted: 0, handled: false, partial: false, uncertain: false, receipts: [] };
const invalidFallback = plan([text("这次回复格式有误，请再试一次。")]);
const observeFallback = { version: 1, action: "observe", messages: [], replyToMessageId: null };
function host(overrides = {}) {
  const attempts = [], guards = [], durable = [];
  return { attempts, guards, durable, options: {
    allowVoice: true, minIntervalMs: 0, maxIntervalMs: 0,
    beforeEach: async args => { guards.push(args); return true; },
    sendVoice: async (content, args) => { attempts.push({ type: "voice", content, ...args }); return { messageId: "voice_ack" }; },
    sendText: async (content, args) => { attempts.push({ type: "text", content, ...args }); return { messageId: "text_ack" }; },
    onReceipt: async receipt => { durable.push(receipt); return true; },
    ...overrides
  } };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

await test("default deny and old invalid-plan fallback shapes", async () => {
  assert.throws(() => validateReplyPlan(plan()), /INVALID_REPLY_PLAN/);
  for (const raw of [plan(), JSON.stringify(plan())]) {
    assert.deepEqual(parseReplyPlan(raw), invalidFallback);
    assert.deepEqual(parseReplyPlan(raw, { direct: false }), observeFallback);
    assert.deepEqual(parseReplyPlan(raw, { allowVoice: false }), invalidFallback);
  }
  const h = host({ allowVoice: undefined });
  await assert.rejects(executeReplyPlan(plan(), h.options), /INVALID_REPLY_PLAN/);
  h.options.allowVoice = false;
  await assert.rejects(executeReplyPlan(plan(), h.options), /INVALID_REPLY_PLAN/);
  assert.deepEqual(h.attempts, []); assert.deepEqual(h.guards, []);
});
await test("allowVoice must be boolean, not model-provided permission", () => {
  for (const allowVoice of [null, 1, "true", [], {}]) {
    assert.throws(() => validateReplyPlan(plan(), { allowVoice }));
    assert.throws(() => parseReplyPlan("plain", { allowVoice }));
    assert.throws(() => replyPlanPrompt({ allowVoice }));
  }
  assert.throws(() => validateReplyPlan(plan([voice()], { allowVoice: true }), opts));
});
await test("allowed object, JSON and fenced roundtrip; detached stable text", () => {
  const raw = plan([voice("  你好，世界！\n明天见。  ")]);
  const expected = plan([voice("你好，世界！\n明天见。")]);
  for (const input of [raw, JSON.stringify(raw), `\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``]) {
    assert.deepEqual(parseReplyPlan(input, opts), expected);
  }
  assert.deepEqual(validateReplyPlan(expected, opts), expected);
  const result = validateReplyPlan(raw, opts); result.messages[0].content = "changed";
  assert.equal(raw.messages[0].content, "  你好，世界！\n明天见。  ");
  assert.equal(validateReplyPlan(plan([voice("字".repeat(350))]), opts).messages[0].content.length, 350);
  // Match the existing text cap's JS string-length accounting (UTF-16 units).
  assert.equal(validateReplyPlan(plan([voice("😀".repeat(175))]), opts).messages[0].content.length, 350);
  assert.throws(() => validateReplyPlan(plan([voice("😀".repeat(176))]), opts));
});
await test("forged fields, media locators, credentials and non-plain content denied without echo", () => {
  const forged = [
    ...["path", "url", "file", "audio", "bytes", "voiceId", "voiceID", "target", "targets", "apiKey", "key", "signal", "allowVoice", "fallbackText"].map(key => ({ ...voice(), [key]: "DO_NOT_ECHO" })),
    ...["", "  ", null, 123, {}, [], "字".repeat(351), "__SKIP__", "[CQ:record,file=bad]", "hi\u0000there",
      "/tmp/DO_NOT_ECHO.wav", "播放 /Users/example/DO_NOT_ECHO.wav", "./DO_NOT_ECHO.wav", "../DO_NOT_ECHO.wav",
      "~/DO_NOT_ECHO.wav", "C:\\temp\\DO_NOT_ECHO.wav", "\\\\host\\DO_NOT_ECHO.wav", "media/DO_NOT_ECHO.wav",
      "https://example.test/DO_NOT_ECHO", "file:///tmp/DO_NOT_ECHO", "www.example.test/DO_NOT_ECHO",
      "data:audio/wav;base64,DO_NOT_ECHO", "MEDIA:/tmp/DO_NOT_ECHO.wav", "[[DISCOVERY_USED:DO_NOT_ECHO]]",
      "__LEARN__ DO_NOT_ECHO", "`code`", "<audio>DO_NOT_ECHO</audio>", "[label](relative)",
      "api_key=DO_NOT_ECHO", "token:DO_NOT_ECHO", "password=DO_NOT_ECHO", "密钥：DO_NOT_ECHO",
      "sk-FAKE_NOT_A_REAL_KEY", "voiceId=DO_NOT_ECHO", "target=DO_NOT_ECHO"].map(voice),
    { type: "voice" }, { type: "audio", content: "DO_NOT_ECHO" }
  ];
  for (const item of forged) {
    const raw = plan([item]);
    assert.throws(() => validateReplyPlan(raw, opts), /INVALID_REPLY_PLAN/);
    for (const input of [raw, JSON.stringify(raw)]) {
      assert.deepEqual(parseReplyPlan(input, opts), invalidFallback);
      assert.deepEqual(parseReplyPlan(input, { ...opts, direct: false }), observeFallback);
    }
  }
});
await test("at most one voice and no identical cleaned text or mention content in either order", () => {
  assert.throws(() => validateReplyPlan(plan([voice("一"), voice("二")]), opts));
  for (const other of [text("  一  "), { type: "mention", mentionId: "member", content: "一" }]) {
    for (const messages of [[voice("一"), other], [other, voice("一")]]) {
      assert.throws(() => validateReplyPlan(plan(messages), { ...opts, allowedMentionIds: ["member"] }));
    }
  }
  assert.deepEqual(validateReplyPlan(plan([text("一"), voice("二")]), opts), plan([text("一"), voice("二")]));
});
await test("voice object callers cannot hide extra authority in non-enumerable or symbol fields", () => {
  const hidden = Object.defineProperty(voice(), "path", { value: "/tmp/hidden.wav" });
  const symbol = { ...voice(), [Symbol("target")]: "hidden" };
  for (const item of [hidden, symbol]) assert.throws(() => validateReplyPlan(plan([item]), opts));
});
await test("voice shares old message and total text quotas including sticker fallback", () => {
  const mixedOpts = { ...opts, maxMessages: 4, allowedStickerIds: ["asset"], allowedReactionIds: ["reaction"] };
  const mixed = plan([voice("ab"), text("cd"), { type: "sticker", stickerId: "asset", fallbackText: "ef" },
    { type: "reaction", reactionId: "reaction" }]);
  assert.deepEqual(validateReplyPlan(mixed, { ...mixedOpts, maxTextLength: 6 }), mixed);
  assert.throws(() => validateReplyPlan(mixed, { ...mixedOpts, maxTextLength: 5 }));
  assert.throws(() => validateReplyPlan(mixed, opts)); // Existing default remains two.
  assert.throws(() => validateReplyPlan(plan([...mixed.messages, text("fifth")]), mixedOpts));
  assert.throws(() => validateReplyPlan(plan([voice("ab"), text("cd")]), { ...opts, maxMessages: 1 }));
  assert.throws(() => validateReplyPlan(plan([voice("ab")]), { ...opts, maxTextLength: 1 }));
});
await test("voice cannot hide in observe or wait control plans", () => {
  for (const action of ["observe", "wait"]) {
    const value = plan([voice()], { action, ...(action === "wait" ? { delayMs: 100 } : {}) });
    assert.throws(() => validateReplyPlan(value, { ...opts, direct: false }));
    assert.deepEqual(parseReplyPlan(value, { ...opts, direct: false }), observeFallback);
    assert.deepEqual(parseReplyPlan(value, opts), plan([text("这次没有生成可发送的回答，请再试一次。")]));
  }
});
await test("voice prompt is host-opt-in only and requires actual speech and host ACK", () => {
  assert.equal(replyPlanPrompt(), replyPlanPrompt({ allowVoice: false }));
  assert.doesNotMatch(replyPlanPrompt(), /voice|语音|ACK/);
  const prompt = replyPlanPrompt(opts);
  for (const pattern of [/"type":"voice"/, /实际要说出/, /350字符/, /至多一条/, /总文字/, /等待宿主 ACK/, /不得声称已发送/]) {
    assert.match(prompt, pattern);
  }
  assert.deepEqual(parseReplyPlan("普通文字", opts), parseReplyPlan("普通文字"));
  assert.deepEqual(fromSocialMessages(["普通文字"], opts), fromSocialMessages(["普通文字"]));
});
await test("sendVoice required only for voice-containing plan with explicit flag", async () => {
  const h = host({ sendVoice: undefined });
  await assert.rejects(executeReplyPlan(plan(), h.options), /INVALID_REPLY_ADAPTER/);
  assert.deepEqual(h.guards, []);
  assert.equal((await executeReplyPlan(plan([text()]), h.options)).sent, 1);
});
await test("typed pre-wire guard, callback signature, actual content/ACK receipt without audio metadata", async () => {
  const controller = new AbortController(), order = [];
  const h = host({ signal: controller.signal,
    beforeEach: async args => { order.push("guard"); assert.deepEqual(args,
      { index: 0, content: voice().content, quoteId: "verified", signal: controller.signal, type: "voice" }); },
    sendVoice: async (content, args) => {
      order.push("voice"); assert.equal(content, voice().content);
      assert.deepEqual(args, { quoteId: "verified", index: 0, signal: controller.signal });
      return { messageId: 42 };
    }, onReceipt: async receipt => { order.push("receipt"); h.durable.push(receipt); } });
  const result = await executeReplyPlan(plan([voice()], { replyToMessageId: "verified" }), h.options);
  assert.deepEqual(order, ["guard", "voice", "receipt"]);
  assert.deepEqual(result.receipts, [{ index: 0, type: "voice", content: voice().content, status: "sent", messageId: "42" }]);
  assert.deepEqual(h.durable, result.receipts); assert.equal(result.sent, 1); assert.equal(result.uncertain, false);
});
await test("pre-wire deny, throwing guard and cancellation never synthesize or invent receipts", async () => {
  for (const mode of ["deny", "throw", "abort", "already-aborted"]) {
    const controller = new AbortController();
    if (mode === "already-aborted") controller.abort();
    const h = host({ signal: controller.signal, beforeEach: async () => {
      if (mode === "throw") throw Error("revoked");
      if (mode === "abort") controller.abort();
      return mode === "deny" ? false : true;
    } });
    assert.deepEqual(await executeReplyPlan(plan(), h.options), emptyResult);
    assert.deepEqual(h.attempts, []); assert.deepEqual(h.durable, []);
  }
});
await test("host callback rechecks revocation after synthesis await; fallback gets current text guard", async () => {
  const entered = deferred(), synthesis = deferred();
  let current = true, wire = 0, calls = 0;
  const h = host({ beforeEach: async () => current,
    sendVoice: async (_, { signal }) => {
      calls++; entered.resolve(); await synthesis.promise;
      // This MUST be enforced by the host callback, not the pure renderer:
      // repeat identity/quiet/revision/cancellation checks immediately pre-wire.
      if (!current || signal?.aborted) return { skipped: true };
      wire++; return { messageId: "should_not_send" };
    } });
  const pending = executeReplyPlan(plan(), h.options);
  await entered.promise; current = false; synthesis.resolve();
  assert.deepEqual(await pending, emptyResult);
  assert.equal(calls, 1); assert.equal(wire, 0); assert.deepEqual(h.attempts, []);
});
await test("exact no-wire skip creates NEW guarded text attempt with same content, quote and index", async () => {
  const order = [];
  const h = host({ beforeEach: async ({ type, content }) => { order.push(`guard:${type}`); assert.equal(content, voice().content); },
    sendVoice: async () => { order.push("skip"); return { skipped: true }; },
    sendText: async (content, args) => { order.push("text"); assert.equal(content, voice().content);
      assert.deepEqual(args, { quoteId: "q", index: 0 }); return { messageId: "fallback_ack" }; },
    onReceipt: async receipt => { order.push("receipt"); h.durable.push(receipt); } });
  const result = await executeReplyPlan(plan([voice()], { replyToMessageId: "q" }), h.options);
  assert.deepEqual(order, ["guard:voice", "skip", "guard:text", "text", "receipt"]);
  assert.deepEqual(result.receipts, [{ index: 0, type: "text", content: voice().content, status: "sent", messageId: "fallback_ack" }]);
  assert.deepEqual(h.durable, result.receipts); assert.equal(result.uncertain, false);
});
await test("fallback denial/throw/abort and cancellation during preparation stop without wire", async () => {
  for (const mode of ["deny", "throw", "abort", "abort-in-prepare"]) {
    const controller = new AbortController();
    const h = host({ signal: controller.signal,
      sendVoice: async () => { if (mode === "abort-in-prepare") controller.abort(); return { skipped: true }; },
      beforeEach: async ({ type }) => {
        if (type !== "text") return true;
        if (mode === "throw") throw Error("revoked");
        if (mode === "abort") controller.abort();
        return false;
      } });
    assert.deepEqual(await executeReplyPlan(plan(), h.options), emptyResult);
    assert.deepEqual(h.attempts, []); assert.deepEqual(h.durable, []);
  }
});
await test("null-prototype exact skip is valid; inherited or mixed skip is not proof", async () => {
  const exact = Object.assign(Object.create(null), { skipped: true });
  const h = host({ sendVoice: async () => exact });
  assert.equal((await executeReplyPlan(plan(), h.options)).receipts[0].type, "text");
  const inherited = Object.create({ skipped: true });
  const mixed = host({ sendVoice: async () => inherited });
  const result = await executeReplyPlan(plan(), mixed.options);
  assert.equal(result.uncertain, true); assert.deepEqual(mixed.attempts, []);
});
await test("hidden conflicting skip/ACK properties never establish a confirmed voice result", async () => {
  const hiddenSkip = Object.defineProperty({ skipped: true }, "messageId", { value: "conflicting" });
  const symbolSkip = { skipped: true, [Symbol("wire")]: true };
  const hiddenAck = Object.defineProperty({ messageId: "conflicting" }, "skipped", { value: true });
  const accessorAck = { get messageId() { return "not_a_data_ack"; } };
  for (const ack of [hiddenSkip, symbolSkip, hiddenAck, accessorAck]) {
    const h = host({ sendVoice: async () => ack });
    const result = await executeReplyPlan(plan([voice(), text("never")]), h.options);
    assert.equal(result.sent, 0); assert.equal(result.uncertain, true);
    assert.equal(result.receipts[0].type, "voice"); assert.deepEqual(h.attempts, []);
  }
});
for (const outcome of ["throw", false, undefined, null, true, {}, [], { messageId: "" }, { message_id: "raw" },
  { messageId: "valid", status: "uncertain" }, { messageId: "valid", path: "/tmp/DO_NOT_KEEP.wav" },
  { skipped: false }, { skipped: true, messageId: "contradiction" }, { skipped: true, path: "/tmp/DO_NOT_KEEP.wav" },
  { status: "accepted", actionId: "not_a_voice_ack" }]) {
  await test(`uncertain/false/error ACK never retries, falls back or sends suffix: ${JSON.stringify(outcome)}`, async () => {
    let calls = 0;
    const h = host({ sendVoice: async () => { calls++; if (outcome === "throw") throw Error("unknown ACK"); return outcome; } });
    const result = await executeReplyPlan(plan([voice(), text("never")]), h.options);
    assert.equal(calls, 1); assert.deepEqual(h.attempts, []); assert.equal(result.sent, 0);
    assert.equal(result.receipts[0].type, "voice"); assert.equal(result.receipts[0].content, voice().content);
    assert.equal(result.receipts[0].status, outcome === false ? "failed" : "uncertain");
    assert.equal(result.uncertain, outcome !== false); assert.deepEqual(h.durable, result.receipts);
    assert.ok(!JSON.stringify(result).includes("DO_NOT_KEEP"));
  });
}
await test("fallback errors/unknown/false stop without retry or suffix", async () => {
  for (const outcome of ["throw", {}, false]) {
    let calls = 0;
    const h = host({ sendVoice: async () => ({ skipped: true }), sendText: async () => {
      calls++; if (outcome === "throw") throw Error("lost ACK"); return outcome;
    } });
    const result = await executeReplyPlan(plan([voice(), text("never")]), h.options);
    assert.equal(calls, 1); assert.equal(result.sent, 0); assert.equal(result.receipts[0].type, "text");
    assert.equal(result.receipts[0].status, outcome === false ? "failed" : "uncertain");
  }
});
await test("voice mixes with media within four and preserves native acceptance semantics", async () => {
  const h = host({ direct: true, allowedStickerIds: ["asset"], allowedPokeIds: ["poke"],
    sendSticker: async () => ({ messageId: "sticker_ack" }),
    sendPoke: async () => ({ status: "accepted", actionId: "poke_action" }) });
  const value = plan([{ type: "poke", pokeId: "poke" }, voice(), { type: "sticker", stickerId: "asset" }, text()]);
  const result = await executeReplyPlan(value, h.options);
  assert.deepEqual(result.receipts.map(receipt => receipt.type), ["voice", "sticker", "text", "poke"]);
  assert.equal(result.sent, 3); assert.equal(result.accepted, 1); assert.equal(result.partial, false);
  assert.equal(result.receipts[3].content, undefined); assert.equal(result.receipts[3].messageId, undefined);
});
await test("cancellation during voice ACK still durably records confirmed receipt and stops suffix", async () => {
  const controller = new AbortController(), entered = deferred(), ack = deferred();
  const h = host({ signal: controller.signal, sendVoice: async () => { entered.resolve(); return ack.promise; } });
  const pending = executeReplyPlan(plan([voice(), text("never")]), h.options);
  await entered.promise; controller.abort(); ack.resolve({ messageId: "late_ack" });
  const result = await pending;
  assert.equal(result.sent, 1); assert.equal(result.partial, true); assert.equal(result.uncertain, false);
  assert.equal(h.durable[0].messageId, "late_ack"); assert.equal(h.durable[0].type, "voice");
  assert.deepEqual(h.durable, result.receipts); assert.deepEqual(h.attempts, []);
});
await test("receipt persistence failure stops suffix without losing confirmed voice ACK", async () => {
  for (const mode of ["false", "throw"]) {
    const h = host({ onReceipt: async () => { if (mode === "throw") throw Error("not durable"); return false; } });
    const result = await executeReplyPlan(plan([voice(), text("never")]), h.options);
    assert.equal(result.sent, 1); assert.equal(result.uncertain, true); assert.equal(result.partial, true);
    assert.equal(h.attempts.length, 1); assert.equal(result.receipts[0].messageId, "voice_ack");
  }
});
await test("plan mutation after awaits cannot replace later speech; receipt mutation is isolated", async () => {
  const value = plan([text(), voice()]);
  const h = host({ onReceipt: async receipt => { value.messages[1].content = "injected"; receipt.content = "injected"; } });
  const result = await executeReplyPlan(value, h.options);
  assert.equal(h.attempts[1].content, voice().content);
  assert.equal(h.attempts[1].quoteId, null); assert.equal(h.attempts[1].index, 1);
  assert.equal(result.receipts[0].content, text().content); assert.equal(result.receipts[1].content, voice().content);
});

console.log(`reply-plan voice self-test: ${checks} passed (synthetic, offline)`);
