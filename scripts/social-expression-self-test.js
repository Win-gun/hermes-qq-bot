import assert from "node:assert/strict";
import { evaluateConversationTurn as turn } from "../src/conversation-turn-manager.js";
import { parseReplyPlan as parse, validateReplyPlan, fromSocialMessages, replyPlanPrompt } from "../src/reply-plan.js";
import { executeReplyPlan as execute } from "../src/expression-renderer.js";
import { sanitizeChatReply } from "../src/reply-safety.js";

// Entirely synthetic: no bridge, files, sockets, credentials or model adapters.
let checks = 0;
async function test(name, run) {
  try { await run(); checks++; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
const plan = (messages = ["第一条", "第二条"], opts) => fromSocialMessages(messages, opts);
const rawPlan = (patch = {}) => ({ version: 1, action: "reply", messages: [{ type: "text", content: "答案" }], replyToMessageId: null, ...patch });
const policy = { turn: { minWaitMs: 100, maxWaitMs: 1000, ordinaryWaitMs: 500, incompleteWaitMs: 900, maxTurnMs: 2000 } };
const evaluate = patch => turn({ text: "普通陈述", elapsedMs: 0, policy, ...patch });

await test("commands bypass wait", () => {
  for (const text of ["/bot quiet", "/status", "马上回答", "请立即回复", "直接告诉我", "别等了，直接回答"]) {
    const value = evaluate({ text }); assert.equal(value.status, "ready"); assert.equal(value.suggestedWaitMs, 0);
  }
});
await test("negated immediacy is not an immediate command", () => assert.equal(evaluate({ text: "不要马上回答" }).status, "wait"));
await test("unaddressed question does not interrupt", () => {
  assert.deepEqual(evaluate({ text: "你们觉得呢？" }), evaluate({ text: "普通陈述" }));
  assert.equal(evaluate({ text: "问题?" }).suggestedWaitMs, 500);
});
for (const flag of ["mentioned", "isPrivate", "quotedBot"]) await test(`${flag} uses short wait`, () => {
  assert.equal(evaluate({ [flag]: true }).suggestedWaitMs, 100);
  assert.equal(evaluate({ [flag]: true, elapsedMs: 100 }).status, "ready");
});
await test("incomplete fragments retain merge window", () => {
  for (const text of ["我感觉", "这个东西", "但是", "先看这个，", "因为", "I think"]) {
    assert.equal(evaluate({ text, mentioned: true }).suggestedWaitMs, 900);
  }
});
await test("ordinary exact quiet boundary", () => {
  assert.equal(evaluate({ elapsedMs: 499 }).suggestedWaitMs, 1);
  assert.equal(evaluate({ elapsedMs: 500 }).status, "ready");
});
await test("incomplete exact quiet boundary", () => {
  assert.equal(evaluate({ text: "我觉得", elapsedMs: 899 }).suggestedWaitMs, 1);
  assert.equal(evaluate({ text: "我觉得", elapsedMs: 900 }).status, "ready");
});
for (const age of [0, 1000, 1999, 2000, 5000]) await test(`total boundary ${age}`, () => {
  const value = evaluate({ text: "但是", sentAtMs: 10000, now: 10000 + age });
  assert.ok(value.suggestedWaitMs <= Math.max(0, 2000 - age));
  if (age >= 2000) assert.equal(value.reason, "max-turn");
});
await test("gap sum bounds fragments without event clock", () => {
  assert.equal(evaluate({ text: "然后", messageCount: 3, gaps: [900, 1000], elapsedMs: 50 }).suggestedWaitMs, 50);
  assert.equal(evaluate({ text: "然后", messageCount: 3, gaps: [1000, 1000] }).reason, "max-turn");
});
await test("single message ignores stale gaps", () => assert.equal(evaluate({ gaps: [99999] }).suggestedWaitMs, 500));
await test("future timestamps do not extend cap", () => assert.equal(evaluate({ now: 100, sentAtMs: 10000,
  elapsedMs: 50, gaps: [1949], messageCount: 2, text: "然后" }).suggestedWaitMs, 1));
await test("bad numeric policy remains finite and bounded", () => {
  for (const item of [NaN, Infinity, -1, "900", null]) {
    const value = turn({ text: "hello", elapsedMs: item, now: item, gaps: [item], policy: { turn: { minWaitMs: item, maxWaitMs: item } } });
    assert.ok(Number.isFinite(value.suggestedWaitMs)); assert.ok(value.suggestedWaitMs >= 0 && value.suggestedWaitMs <= 12000);
  }
});
await test("zero total cap overrides minimum", () => assert.equal(turn({ text: "然后", policy: { turn: { maxTurnMs: 0, minWaitMs: 9999 } } }).suggestedWaitMs, 0));
await test("inverted wait policy clamps minimum", () => assert.equal(turn({ text: "hello", mentioned: true, policy: { turn: { minWaitMs: 1000, maxWaitMs: 10 } } }).suggestedWaitMs, 10));
await test("empty text is observation", () => assert.equal(turn({ text: " " }).status, "observe"));
await test("local evaluation leaves input unchanged", () => {
  const input = { text: "然后", policy: structuredClone(policy), gaps: [1, 2], messageCount: 3 };
  const old = structuredClone(input); turn(input); assert.deepEqual(input, old);
});
await test("bounded timing sweep never passes turn deadline", () => {
  for (let age = 0; age <= 2500; age += 25) for (const elapsedMs of [0, 99, 500, 1000]) {
    const result = evaluate({ text: "然后", elapsedMs, sentAtMs: 10000, now: 10000 + age });
    assert.ok(result.suggestedWaitMs <= Math.max(0, 2000 - Math.max(age, elapsedMs)));
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
  }
});

for (const text of ["一整句，不拆开。", "a b c d", "https://example.test/a?q=a%20b#x", "```js\nconst x = '😀';\nconsole.log(x);\n```", "👩🏽‍💻 👨‍👩‍👧‍👦 🇨🇳", "x".repeat(12000)]) {
  await test(`single intact text ${text.length}`, () => {
    const result = parse(text); assert.equal(result.messages.length, 1); assert.equal(result.messages[0].content, text);
  });
}
await test("one structured message", () => assert.deepEqual(parse(JSON.stringify(rawPlan())), rawPlan()));
await test("two structured messages", () => assert.deepEqual(parse(JSON.stringify(plan())), plan()));
await test("fenced structured JSON", () => assert.deepEqual(parse(`\`\`\`json\n${JSON.stringify(rawPlan())}\n\`\`\``), rawPlan()));
for (const raw of ['{ "answer": 42, "ok": true, "data": [null, "😀", "https://example.test"] }',
  '[1,2,{"result":"代码答案"}]', '```json\n{"answer":42}\n```', '  {"answer":{},"data":""}\n']) {
  for (const direct of [true, false]) await test(`ordinary technical JSON is single text ${direct} ${raw.length}`, () => {
    const result = parse(raw, { direct }); assert.equal(result.action, "reply");
    assert.deepEqual(result.messages, [{ type: "text", content: sanitizeChatReply(raw) }]);
  });
}
await test("ordinary object input is serialized as text, not a social array", () => {
  const value = { answer: 42 }; assert.equal(parse(value).messages[0].content, JSON.stringify(value));
  assert.equal(parse(["a", "b"]).messages.length, 1);
  assert.equal(fromSocialMessages(["a", "b"]).messages.length, 2);
});
for (const key of ["version", "action", "messages", "replyToMessageId", "delayMs", "accountId", "logicalId",
  "conversationId", "target", "path", "tools", "permissions", "ACCOUNT_ID", "file", "__proto__"]) {
  await test(`unwrapped nested JSON reserved key ${key} never echoed`, () => {
    for (const raw of [`{"${key}":"DO_NOT_ECHO"}`, `{"data":[{"${key}":"DO_NOT_ECHO"}]}`]) {
      assert.ok(!JSON.stringify(parse(raw)).includes("DO_NOT_ECHO"));
      assert.equal(parse(raw, { direct: false }).action, "observe");
    }
  });
}
await test("escaped reserved keys cannot bypass technical JSON check", () => {
  const raw = '{"data":{"a\\u0063countId":"DO_NOT_ECHO"}}';
  assert.ok(!JSON.stringify(parse(raw)).includes("DO_NOT_ECHO"));
});
await test("technical JSON must respect text quota and local bounds", () => {
  const raw = '{"answer":"123456789"}'; assert.notEqual(parse(raw, { maxTextLength: 10 }).messages[0].content, raw);
  let deep = { answer: 42 }; for (let index = 0; index < 20; index++) deep = { data: deep };
  assert.equal(parse(deep, { direct: false }).action, "observe");
  const cyclic = {}; cyclic.data = cyclic; assert.equal(parse(cyclic, { direct: false }).action, "observe");
  assert.equal(parse({ answer: "[CQ:image,file=secret]" }, { direct: false }).action, "observe");
});
await test("wrapped technical JSON/code remains intact including technical field names", () => {
  const content = '```json\n{"version":2,"path":"/example","tools":[]}\n```';
  const value = rawPlan({ messages: [{ type: "text", content }] });
  assert.equal(parse(JSON.stringify(value)).messages[0].content, content);
});
await test("legacy SKIP never becomes a wire message", () => {
  for (const raw of ["__SKIP__", " \n__SKIP__\n ", '"__SKIP__"',
    rawPlan({ messages: [{ type: "text", content: "__SKIP__" }] })]) {
    const direct = parse(raw); assert.equal(direct.action, "reply"); assert.ok(!direct.messages[0].content.includes("__SKIP__"));
    const indirect = parse(raw, { direct: false }); assert.equal(indirect.action, "observe"); assert.deepEqual(indirect.messages, []);
  }
  assert.equal(fromSocialMessages(["__SKIP__"], { direct: false }).action, "observe");
  assert.equal(fromSocialMessages(["__SKIP__"]).action, "reply");
  assert.throws(() => fromSocialMessages(["hi", "__SKIP__"]));
});
await test("verified quote retained", () => {
  const input = rawPlan({ replyToMessageId: "-123" });
  assert.deepEqual(parse(input, { allowedQuoteIds: ["-123"] }), input);
});
await test("forged quote fails closed", () => {
  const value = parse(rawPlan({ replyToMessageId: "foreign" }), { allowedQuoteIds: ["known"] });
  assert.equal(value.replyToMessageId, null); assert.ok(!value.messages[0].content.includes("foreign"));
});
for (const field of ["accountId", "logicalId", "target", "path", "tools", "permissions", "cq", "signal", "__proto__"]) {
  await test(`unknown authority field ${field}`, () => {
    const input = JSON.parse(JSON.stringify(rawPlan()).replace(/}$/, `,"${field}":"PAYLOAD_DO_NOT_ECHO"}`));
    const result = parse(input); assert.ok(!JSON.stringify(result).includes("PAYLOAD_DO_NOT_ECHO"));
    assert.throws(() => validateReplyPlan(input));
  });
}
await test("malformed JSON never echoed", () => {
  for (const raw of ['{"action":"send","target":"SECRET"', '[{"path":"SECRET"}]', '结果如下：\n{"accountId":"SECRET"}', '```json\n{"path":"SECRET"\n```']) {
    const value = parse(raw); assert.equal(value.action, "reply"); assert.ok(!JSON.stringify(value).includes("SECRET"));
  }
});
await test("invalid version and message schema rejected", () => {
  for (const patch of [{ version: 2 }, { action: "send" }, { messages: [] }, { messages: [{ type: "image", content: "x" }] },
    { messages: [{ type: "text", content: "x", file: "/secret" }] }, { delayMs: 1 }]) {
    assert.throws(() => validateReplyPlan(rawPlan(patch)));
  }
});
await test("CQ is never granted by plain or structured output", () => {
  for (const content of ["[CQ:image,file=/secret]", "hi [cq:at,qq=all]", "hello\u0000world"]) {
    assert.ok(!parse(content).messages[0].content.includes(content));
    assert.throws(() => fromSocialMessages([content]));
  }
});
await test("text quota counts all messages", () => {
  assert.equal(fromSocialMessages(["ab", "cd"], { maxTextLength: 4 }).messages.length, 2);
  assert.throws(() => fromSocialMessages(["ab", "cde"], { maxTextLength: 4 }));
  assert.throws(() => fromSocialMessages(["a", "b"], { maxMessages: 1 }));
  assert.throws(() => fromSocialMessages(["a", "b", "c"]));
  assert.equal(parse("x".repeat(12001)).messages.length, 1);
});
await test("social compatibility is explicit and detached", () => {
  const input = ["hello", "world"]; const value = fromSocialMessages(input); input[1] = "changed";
  assert.equal(value.messages[1].content, "world"); assert.equal(parse(["hi"]).action, "reply");
  assert.notEqual(parse(["hi"]).messages[0].content, "hi");
});
await test("direct observe and wait cannot swallow requests", () => {
  for (const action of ["observe", "wait"]) {
    const raw = rawPlan({ action, messages: [], ...(action === "wait" ? { delayMs: 100 } : {}) });
    assert.equal(parse(raw).action, "reply"); assert.equal(parse(raw, { direct: false }).action, action);
  }
});
await test("invalid indirect plan observes", () => assert.equal(parse('{"bad":', { direct: false }).action, "observe"));
await test("wait delay quota and action fields", () => {
  for (const delayMs of [0, -1, 1.5, 86400001, "100", null]) assert.throws(() => validateReplyPlan(rawPlan({ action: "wait", messages: [], delayMs }), { direct: false }));
  for (const delayMs of [1, 86400000]) assert.equal(parse(rawPlan({ action: "wait", messages: [], delayMs }), { direct: false }).delayMs, delayMs);
  assert.throws(() => validateReplyPlan(rawPlan({ action: "observe", messages: [], delayMs: 10 }), { direct: false }));
});
await test("invalid options reject rather than broaden quotas", () => {
  for (const opts of [{ maxMessages: 0 }, { maxMessages: 5 }, { maxTextLength: Infinity }, { direct: "true" }, { allowedQuoteIds: ["bad\nID"] }]) assert.throws(() => parse("hi", opts));
});
await test("prompt is one-pass and scope-free", () => {
  const text = replyPlanPrompt({ maxMessages: 2, allowedQuoteIds: ["123"] });
  assert.match(text, /一次生成/); assert.match(text, /不得 observe 或 wait/); assert.match(text, /123/);
  assert.match(replyPlanPrompt({ direct: false }), /delayMs/);
  assert.match(text, /技术 JSON 或代码/); assert.match(text, /text\.content/);
  assert.match(text, /技术解释、学习辅导等按需完整/);
  assert.match(text, /普通闲聊的简短建议不能截断正式内容/);
});
await test("shared reply safety cleans plain, structured and social text", () => {
  const content = "实际答案 https://example.test/api?q=1\n[[DISCOVERY_USED:discovery:123]]\nMEDIA:/Users/example/private/result.png\n下一段";
  const expected = sanitizeChatReply(content);
  const input = rawPlan({ messages: [{ type: "text", content }] });
  for (const result of [parse(content), parse(JSON.stringify(input)), validateReplyPlan(input), fromSocialMessages([content])]) {
    assert.equal(result.messages[0].content, expected); assert.ok(!JSON.stringify(result).includes("/Users/example"));
    assert.ok(!JSON.stringify(result).includes("DISCOVERY_USED"));
  }
  assert.equal(input.messages[0].content, content); // No caller-state mutation.
});
await test("internal marker prefixes do not discard the actual answer", () => {
  for (const prefix of ["[[DISCOVERY_USED:discovery:1]]\n", "MEDIA:/Users/example/private.png\n"]) {
    assert.equal(parse(`${prefix}保留实际答案`).messages[0].content, "保留实际答案");
    assert.equal(parse(`${prefix}${JSON.stringify(rawPlan())}`).messages[0].content, "答案");
  }
});
await test("local artifact paths and unterminated markers fail closed", () => {
  for (const content of ["MEDIA:/Users/example/a.png", "MEDIA:file:///home/example/a.png", "MEDIA:/var/private/a", "MEDIA:/tmp/private.txt", "[[DISCOVERY_USED:unfinished", "  "]) {
    for (const direct of [true, false]) {
      const input = rawPlan({ messages: [{ type: "text", content }] });
      for (const value of [parse(content, { direct }), parse(JSON.stringify(input), { direct }),
        validateReplyPlan(input, { direct }), fromSocialMessages([content], { direct })]) {
        assert.equal(value.action, direct ? "reply" : "observe");
        if (direct) assert.ok(value.messages[0].content.length > 0);
        assert.ok(!JSON.stringify(value).includes("MEDIA:")); assert.ok(!JSON.stringify(value).includes("DISCOVERY_USED"));
      }
    }
  }
});
await test("cleaning cannot launder invalid non-reply messages", () => {
  for (const action of ["observe", "wait"]) assert.throws(() => validateReplyPlan(rawPlan({ action,
    messages: [{ type: "text", content: "[[DISCOVERY_USED:x]]" }], ...(action === "wait" ? { delayMs: 1 } : {}) }), { direct: false }));
});
await test("empty cleaned parts are dropped, not sent as blank bubbles", () => {
  const p = fromSocialMessages(["[[DISCOVERY_USED:x]]", "正确答案"]);
  assert.deepEqual(p.messages, [{ type: "text", content: "正确答案" }]);
});
await test("ordinary JSON code URLs and emoji survive shared cleaning", () => {
  for (const content of ['{"answer":42,"url":"https://example.test/a?q=b#c"}',
    "```js\nconst url = 'https://example.test/api';\nconsole.log(url, '👩🏽‍💻');\n```", "https://example.test/media/Users/data?q=MEDIA%3A"]) {
    assert.equal(parse(content).messages[0].content, content);
    assert.equal(validateReplyPlan(rawPlan({ messages: [{ type: "text", content }] })).messages[0].content, content);
  }
});
await test("cleaning that constructs a new hidden marker is rejected", () => {
  const content = "[[DISCOVERY_[[DISCOVERY_USED:x]]USED:private]]";
  assert.equal(parse(content, { direct: false }).action, "observe");
});

function host(overrides = {}) {
  const calls = [], durable = [], waits = [], guards = [];
  return { calls, durable, waits, guards, options: {
    sendText: async (content, args) => { calls.push({ content, ...args }); return { messageId: `ack:${args.index}` }; },
    beforeEach: async args => { guards.push(args.index); return true; },
    onReceipt: async receipt => { durable.push(receipt); },
    sleep: async ms => { waits.push(ms); }, minIntervalMs: 20, maxIntervalMs: 40, ...overrides,
  } };
}
await test("ordered two sends with durable receipts before next guard", async () => {
  const order = []; const h = host({
    beforeEach: async ({ index }) => { order.push(`guard${index}`); },
    sendText: async (_, { index }) => { order.push(`send${index}`); return { messageId: index + 1 }; },
    onReceipt: async ({ index }) => { order.push(`receipt${index}`); },
    sleep: async () => { order.push("sleep"); },
  });
  const result = await execute(plan(), h.options);
  assert.deepEqual(order, ["guard0", "send0", "receipt0", "sleep", "guard1", "send1", "receipt1"]);
  assert.equal(result.sent, 2); assert.equal(result.partial, false); assert.equal(result.uncertain, false);
  assert.deepEqual(result.receipts.map(x => x.messageId), ["1", "2"]);
});
await test("quote only the first message", async () => {
  const p = plan(); p.replyToMessageId = "verified";
  const parsed = parse(p, { allowedQuoteIds: ["verified"] }); const h = host(); await execute(parsed, h.options);
  assert.deepEqual(h.calls.map(x => x.quoteId), ["verified", null]); assert.deepEqual(h.waits, [20]);
});
await test("reading rhythm uses both configured bounds without splitting content", async () => {
  const p = plan(); p.messages[1].content = "长".repeat(300);
  const h = host(); await execute(p, h.options);
  assert.deepEqual(h.waits, [40]);
  assert.equal(h.calls[1].content, "长".repeat(300));
});
await test("pre-cancelled does not attempt send", async () => {
  const controller = new AbortController(); controller.abort(); const h = host({ signal: controller.signal });
  assert.deepEqual(await execute(plan(), h.options), { sent: 0, partial: false, uncertain: false, receipts: [] }); assert.equal(h.calls.length, 0);
});
await test("cancel during beforeEach", async () => {
  const controller = new AbortController(); const h = host({ signal: controller.signal, beforeEach: async () => { controller.abort(); } });
  assert.equal((await execute(plan(), h.options)).sent, 0); assert.equal(h.calls.length, 0);
});
await test("cancel during ACK still records confirmed attempt", async () => {
  const controller = new AbortController(); const h = host({ signal: controller.signal,
    sendText: async () => { controller.abort(); return { messageId: "late-ack" }; } });
  const result = await execute(plan(), h.options); assert.equal(result.sent, 1); assert.equal(result.partial, true);
  assert.equal(h.durable.length, 1); assert.equal(h.durable[0].messageId, "late-ack");
});
await test("asynchronous ACK after cancellation is awaited and persisted once", async () => {
  const controller = new AbortController(); let resolveAck, attempted;
  const started = new Promise(resolve => { attempted = resolve; }); let count = 0;
  const h = host({ signal: controller.signal, sendText: () => {
    count++; attempted(); return new Promise(resolve => { resolveAck = resolve; });
  } });
  const pending = execute(plan(), h.options); await started; controller.abort(); resolveAck({ messageId: "late" });
  const result = await pending; assert.equal(count, 1); assert.equal(result.sent, 1);
  assert.equal(h.durable.length, 1); assert.equal(result.partial, true); assert.equal(result.uncertain, false);
});
await test("cancel during noncooperating sleep", async () => {
  const controller = new AbortController(); const h = host({ signal: controller.signal,
    sleep: () => { controller.abort(); return new Promise(() => {}); } });
  const result = await execute(plan(), h.options); assert.equal(result.sent, 1); assert.equal(h.calls.length, 1);
});
await test("second guard denied after delay", async () => {
  const h = host({ beforeEach: async ({ index }) => index === 0 });
  const result = await execute(plan(), h.options); assert.equal(result.sent, 1); assert.equal(result.partial, true); assert.equal(h.calls.length, 1);
});
await test("guard exception has no uncertain wire attempt", async () => {
  const h = host({ beforeEach: async () => { throw new Error("stale"); } });
  const result = await execute(plan(), h.options); assert.equal(result.uncertain, false); assert.deepEqual(result.receipts, []);
});
await test("false ACK stops without retry", async () => {
  let attempts = 0; const h = host({ sendText: async () => { attempts++; return false; } });
  const result = await execute(plan(), h.options); assert.equal(attempts, 1); assert.equal(result.receipts[0].status, "failed"); assert.equal(result.uncertain, false);
});
for (const ack of [undefined, null, true, {}, { messageId: "" }, { messageId: "bad\nid" }, { messageId: Infinity }]) {
  await test(`unknown ACK ${JSON.stringify(ack)}`, async () => {
    let attempts = 0; const h = host({ sendText: async () => { attempts++; return ack; } });
    const result = await execute(plan(), h.options); assert.equal(attempts, 1); assert.equal(result.uncertain, true); assert.equal(result.receipts[0].status, "uncertain"); assert.equal(h.durable.length, 1);
  });
}
await test("ACK exception after partial success never replays prefix", async () => {
  const attempts = []; const h = host({ sendText: async (_, { index }) => { attempts.push(index); if (index === 1) throw new Error("lost ACK"); return { messageId: "first" }; } });
  const result = await execute(plan(), h.options); assert.deepEqual(attempts, [0, 1]); assert.equal(result.partial, true); assert.equal(result.uncertain, true);
  assert.deepEqual(result.receipts.map(x => x.status), ["sent", "uncertain"]);
});
for (const outcome of ["throw", false, { ok: false }]) await test(`receipt failure ${JSON.stringify(outcome)}`, async () => {
  const h = host({ onReceipt: async () => { if (outcome === "throw") throw new Error("disk"); return outcome; } });
  const result = await execute(plan(), h.options); assert.equal(h.calls.length, 1); assert.equal(result.sent, 1); assert.equal(result.uncertain, true); assert.equal(result.partial, true);
});
await test("single ACK with failed persistence is uncertain, not unsent", async () => {
  const h = host({ onReceipt: async () => false }); const result = await execute(plan(["only"]), h.options);
  assert.equal(result.sent, 1); assert.equal(result.partial, false); assert.equal(result.uncertain, true);
});
await test("plan and receipt mutation cannot replace later content", async () => {
  const p = plan(); const h = host({ onReceipt: async receipt => { receipt.status = "failed"; p.messages[1].content = "injected"; } });
  const result = await execute(p, h.options); assert.equal(h.calls[1].content, "第二条"); assert.equal(result.receipts[0].status, "sent");
});
await test("non-reply plans do not schedule or sleep", async () => {
  const h = host(); const p = parse(rawPlan({ action: "wait", messages: [], delayMs: 100 }), { direct: false });
  assert.equal((await execute(p, h.options)).sent, 0); assert.equal(h.waits.length, 0); assert.equal(h.calls.length, 0);
});
await test("invalid plan and adapters fail before wire", async () => {
  const h = host(); await assert.rejects(execute(rawPlan({ target: "bad" }), h.options));
  await assert.rejects(execute(plan(), { ...h.options, beforeEach: undefined }));
  await assert.rejects(execute(plan(), { ...h.options, minIntervalMs: 41 })); assert.equal(h.calls.length, 0);
});
await test("default cancellable timer smoke", async () => {
  const h = host({ sleep: undefined, minIntervalMs: 1, maxIntervalMs: 1 }); assert.equal((await execute(plan(), h.options)).sent, 2);
});
await test("wire and durable ACK record share the exact sanitized content", async () => {
  const content = "技术答案\n```js\nconst url = 'https://example.test/a';\n```\n[[DISCOVERY_USED:x]]\nMEDIA:/Users/example/private.png\n✅";
  const expected = sanitizeChatReply(content);
  for (const p of [parse(JSON.stringify(rawPlan({ messages: [{ type: "text", content }] }))),
    rawPlan({ messages: [{ type: "text", content }] }), fromSocialMessages([content])]) {
    const h = host(); const result = await execute(p, h.options);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].content, expected);
    assert.equal(h.durable[0].content, expected); assert.equal(result.receipts[0].content, expected);
  }
  const h = host(); const result = await execute(parse("[[DISCOVERY_USED:x]]", { direct: false }), h.options);
  assert.equal(h.calls.length, 0); assert.equal(result.sent, 0);
});
// Phase2 media remains host-owned. Offered IDs are a separate host input at BOTH
// parsing and execution, never inferred from a model-provided plan or account.
const sticker = (stickerId = "asset_A", fallbackText) => ({ type: "sticker", stickerId,
  ...(fallbackText === undefined ? {} : { fallbackText }) });
const mediaPlan = (messages = [sticker()], opts = {}) => validateReplyPlan(rawPlan({ messages }), {
  allowedStickerIds: ["asset_A"], ...opts
});
function mediaHost(overrides = {}) {
  const stickers = [];
  const h = host({ allowedStickerIds: ["asset_A"],
    sendSticker: async (id, args) => { stickers.push({ id, ...args }); return { messageId: `sticker:${args.index}` }; }, ...overrides });
  return { ...h, stickers };
}
await test("sticker-only plan validates and parses without text-empty fallback", () => {
  const p = mediaPlan(); assert.deepEqual(p.messages, [sticker()]);
  assert.deepEqual(parse(JSON.stringify(p), { allowedStickerIds: ["asset_A"] }), p);
  assert.deepEqual(parse(p, { allowedStickerIds: ["asset_A"] }), p);
});
await test("default no-offer remains pure text; no implicit sticker authorization", async () => {
  const p = rawPlan({ messages: [sticker()] });
  assert.throws(() => validateReplyPlan(p));
  assert.equal(parse(p, { direct: false }).action, "observe");
  assert.equal(parse(p).messages[0].type, "text");
  const h = host({ sendSticker: async () => { throw new Error("must not call"); } });
  await assert.rejects(execute(p, h.options)); assert.equal(h.calls.length, 0);
  assert.equal((await execute(plan(["plain"]), host().options)).sent, 1);
});
await test("offered sticker option is bounded to three strict opaque IDs", () => {
  for (const allowedStickerIds of [null, "asset_A", Array(1), ["a", "b", "c", "d"], [1], [""], ["https://cdn.test/a"],
    ["/tmp/a"], ["../a"], ["file:a"], ["[CQ:image]"], ["__proto__"]]) {
    assert.throws(() => parse("hi", { allowedStickerIds }));
    assert.throws(() => replyPlanPrompt({ allowedStickerIds }));
  }
  const ids = ["asset_A", "asset_B", "asset_C"];
  assert.equal(validateReplyPlan(rawPlan({ messages: ids.map(id => sticker(id)) }), { allowedStickerIds: ids, maxMessages: 3 }).messages.length, 3);
});
await test("forged sticker IDs and media authority fields are rejected", () => {
  for (const item of [sticker("foreign"), sticker("https://cdn.test/a"), sticker("../asset_A"), sticker("C:\\a"),
    sticker("asset_A\n"), sticker("[CQ:image,file=a]"), sticker("__proto__"),
    ...["url", "path", "file", "bytes", "base64", "content", "cq", "target", "accountId", "allowedStickerIds", "replyToMessageId"].map(key => ({ ...sticker(), [key]: "DO_NOT_ECHO" })),
    { type: "image", stickerId: "asset_A" }]) {
    const p = rawPlan({ messages: [item] });
    assert.throws(() => validateReplyPlan(p, { allowedStickerIds: ["asset_A"] }));
    assert.equal(parse(p, { allowedStickerIds: ["asset_A"], direct: false }).action, "observe");
  }
});
await test("unwrapped and escaped sticker authority cannot masquerade as technical JSON", () => {
  for (const raw of ['{"stickerId":"DO_NOT_ECHO"}', '{"data":{"sticker_id":"DO_NOT_ECHO"}}',
    '{"fallbackText":"DO_NOT_ECHO"}', '{"data":{"sticker\\u0049d":"DO_NOT_ECHO"}}',
    '{"allowedStickerIds":["DO_NOT_ECHO"]}']) {
    assert.ok(!JSON.stringify(parse(raw)).includes("DO_NOT_ECHO"));
    assert.equal(parse(raw, { direct: false }).action, "observe");
  }
});
await test("sticker schema keeps original total bubble cap and fallback text quota", () => {
  const messages = [{ type: "text", content: "ab" }, sticker("asset_A", "cd")];
  assert.equal(mediaPlan(messages, { maxTextLength: 4 }).messages.length, 2);
  assert.throws(() => mediaPlan(messages, { maxTextLength: 3 }));
  assert.throws(() => mediaPlan(messages, { maxMessages: 1 }));
  assert.throws(() => mediaPlan([sticker(), sticker(), sticker()]));
  assert.throws(() => mediaPlan([sticker("asset_A", "x".repeat(12001))]));
});
await test("fallback text shares cleaning/CQ protections without dropping valid sticker", () => {
  const original = sticker("asset_A", "备用文字\nMEDIA:/tmp/private.png\n[[DISCOVERY_USED:x]]");
  assert.equal(mediaPlan([original]).messages[0].fallbackText, sanitizeChatReply(original.fallbackText));
  assert(original.fallbackText.includes("/tmp/private.png"));
  for (const fallbackText of [null, 42, {}, "[CQ:image,file=a]", "hello\u0000world", "__SKIP__"]) assert.throws(() => mediaPlan([sticker("asset_A", fallbackText)]));
  for (const fallbackText of ["", "  ", "MEDIA:/tmp/private.png"]) assert.deepEqual(mediaPlan([sticker("asset_A", fallbackText)]).messages, [sticker()]);
});
await test("prompt marks candidate IDs untrusted and restricts IDs/fallback/fields", () => {
  const prompt = replyPlanPrompt({ allowedStickerIds: ["asset_A", "asset_B"] });
  assert.match(prompt, /untrusted candidate ids/); assert.match(prompt, /当前账号\/会话/);
  assert.match(prompt, /asset_A/); assert.match(prompt, /asset_B/); assert.match(prompt, /fallbackText/);
  assert.match(prompt, /文字和表情合计/); assert.match(prompt, /发送和确认失败不得补发/);
  assert.match(replyPlanPrompt(), /没有可用表情 ID/);
});
await test("sendSticker signature and typed receipt use first-bubble quote, no bytes", async () => {
  const h = mediaHost({ sendSticker: async (id, args) => {
    h.stickers.push({ id, ...args }); assert.deepEqual(args, { quoteId: "verified", index: 0 });
    return { messageId: "image_ack", bytes: Buffer.from("DO_NOT_KEEP"), url: "DO_NOT_KEEP" };
  } });
  const p = mediaPlan([sticker("asset_A", "备用说明")]); p.replyToMessageId = "verified";
  const result = await execute(p, h.options);
  assert.equal(result.sent, 1); assert.equal(result.partial, false); assert.equal(result.uncertain, false);
  assert.deepEqual(result.receipts, [{ index: 0, type: "sticker", stickerId: "asset_A", content: "备用说明", status: "sent", messageId: "image_ack" }]);
  assert.deepEqual(h.durable, result.receipts); assert.equal(h.calls.length, 0);
  assert.ok(!JSON.stringify(result).includes("DO_NOT_KEEP"));
});
await test("sticker without fallback has empty receipt content and true ACK count", async () => {
  const h = mediaHost(); const result = await execute(mediaPlan(), h.options);
  assert.equal(result.receipts[0].content, ""); assert.equal(result.sent, 1);
});
await test("sendSticker required only for a sticker-containing plan", async () => {
  const h = host({ allowedStickerIds: ["asset_A"] });
  assert.equal((await execute(plan(["text"]), h.options)).sent, 1);
  await assert.rejects(execute(mediaPlan(), h.options), /INVALID_REPLY_ADAPTER/);
  assert.equal(h.calls.length, 1);
});
await test("mixed text/sticker bubbles ordered; typed guards and no later quote", async () => {
  const order = [], guards = [];
  const h = mediaHost({ beforeEach: async args => { guards.push(args); order.push(`guard:${args.type}`); },
    sendText: async (_, args) => { order.push("text"); assert.equal(args.quoteId, "q"); return { messageId: "text1" }; },
    sendSticker: async (id, args) => { order.push("sticker"); assert.equal(id, "asset_A"); assert.equal(args.quoteId, null); return { messageId: "image1" }; },
    onReceipt: async r => { order.push(`receipt:${r.type}`); }, sleep: async () => { order.push("sleep"); } });
  const p = mediaPlan([{ type: "text", content: "看这张" }, sticker()]); p.replyToMessageId = "q";
  const result = await execute(p, h.options);
  assert.deepEqual(order, ["guard:text", "text", "receipt:text", "sleep", "guard:sticker", "sticker", "receipt:sticker"]);
  assert.equal(guards[1].stickerId, "asset_A"); assert.equal(guards[0].stickerId, undefined);
  assert.deepEqual(result.receipts.map(r => r.type), ["text", "sticker"]); assert.equal(result.sent, 2);
});
await test("explicit skipped prep falls back only after second guard", async () => {
  const order = [];
  const h = mediaHost({ beforeEach: async ({ type, content }) => { order.push(`guard:${type}:${content}`); },
    sendSticker: async () => { order.push("skip"); return { skipped: true }; },
    sendText: async (content, args) => { order.push("fallback"); assert.equal(content, "替代文字"); assert.deepEqual(args, { quoteId: null, index: 0 }); return { messageId: "fallback_ack" }; },
    onReceipt: async r => { order.push(`receipt:${r.type}`); } });
  const result = await execute(mediaPlan([sticker("asset_A", "替代文字")]), h.options);
  assert.deepEqual(order, ["guard:sticker:替代文字", "skip", "guard:text:替代文字", "fallback", "receipt:text"]);
  assert.equal(result.sent, 1); assert.equal(result.uncertain, false);
  assert.deepEqual(result.receipts, [{ index: 0, type: "text", content: "替代文字", status: "sent", messageId: "fallback_ack" }]);
});
await test("skipped without fallback emits no receipt, continues later text", async () => {
  const h = mediaHost({ sendSticker: async () => ({ skipped: true }) });
  const result = await execute(mediaPlan([sticker(), { type: "text", content: "继续文字" }]), h.options);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].content, "继续文字"); assert.equal(h.calls[0].index, 1);
  assert.equal(result.sent, 1); assert.equal(result.partial, true); assert.equal(result.uncertain, false);
  assert.equal(result.receipts.length, 1); assert.equal(result.receipts[0].type, "text");
  const only = await execute(mediaPlan(), h.options);
  assert.deepEqual(only, { sent: 0, partial: false, uncertain: false, receipts: [] });
});
await test("fallback guard denial/throw/cancel means no wire and no fake receipt", async () => {
  for (const mode of ["deny", "throw", "abort"]) {
    const controller = new AbortController();
    const h = mediaHost({ signal: controller.signal, sendSticker: async () => ({ skipped: true }), beforeEach: async ({ type }) => {
      if (type !== "text") return true;
      if (mode === "throw") throw new Error("stale");
      if (mode === "abort") controller.abort();
      return false;
    } });
    const result = await execute(mediaPlan([sticker("asset_A", "fallback")]), h.options);
    assert.deepEqual(result, { sent: 0, partial: false, uncertain: false, receipts: [] }); assert.equal(h.calls.length, 0);
  }
});
await test("abort during preparation skipped result never falls back", async () => {
  const controller = new AbortController(); const h = mediaHost({ signal: controller.signal,
    sendSticker: async () => { controller.abort(); return { skipped: true }; } });
  const result = await execute(mediaPlan([sticker("asset_A", "fallback")]), h.options);
  assert.equal(result.sent, 0); assert.equal(result.uncertain, false); assert.deepEqual(result.receipts, []); assert.equal(h.calls.length, 0);
});
for (const outcome of ["throw", undefined, null, true, {}, { messageId: "" }, { skipped: false },
  { skipped: true, messageId: "contradictory" }, { skipped: true, bytes: "not an exact no-wire result" }]) {
  await test(`unknown sticker ACK cannot fallback/retry ${JSON.stringify(outcome)}`, async () => {
    let attempts = 0; const h = mediaHost({ sendSticker: async () => { attempts++; if (outcome === "throw") throw new Error("lost ACK"); return outcome; } });
    const p = mediaPlan([sticker("asset_A", "fallback"), { type: "text", content: "not sent" }]);
    const result = await execute(p, h.options);
    assert.equal(attempts, 1); assert.equal(h.calls.length, 0); assert.equal(result.sent, 0);
    assert.equal(result.uncertain, true); assert.equal(result.receipts[0].type, "sticker");
    assert.equal(result.receipts[0].status, "uncertain"); assert.equal(h.durable.length, 1);
  });
}
await test("known false sticker ACK stops with failed receipt, never fallback", async () => {
  const h = mediaHost({ sendSticker: async () => false });
  const result = await execute(mediaPlan([sticker("asset_A", "fallback")]), h.options);
  assert.equal(result.receipts[0].status, "failed"); assert.equal(result.uncertain, false); assert.equal(h.calls.length, 0);
});
await test("fallback text throw/unknown ACK stops without another sticker or text", async () => {
  for (const mode of ["throw", "unknown"]) {
    let attempts = 0; const h = mediaHost({ sendSticker: async () => ({ skipped: true }),
      sendText: async () => { attempts++; if (mode === "throw") throw Error("lost"); return {}; } });
    const result = await execute(mediaPlan([sticker("asset_A", "fallback"), { type: "text", content: "never" }]), h.options);
    assert.equal(attempts, 1); assert.equal(result.uncertain, true); assert.equal(result.receipts[0].type, "text"); assert.equal(result.sent, 0);
  }
});
await test("mixed bubbles canceled during sticker ACK retain only true ACK receipts", async () => {
  const controller = new AbortController(), h = mediaHost({ signal: controller.signal,
    sendSticker: async () => { controller.abort(); return { messageId: "late_sticker" }; } });
  const p = mediaPlan([{ type: "text", content: "before" }, sticker(), { type: "text", content: "never" }], { maxMessages: 3 });
  const result = await execute(p, h.options);
  assert.equal(result.sent, 2); assert.equal(result.partial, true); assert.equal(result.uncertain, false);
  assert.equal(h.calls.length, 1); assert.equal(h.durable[1].messageId, "late_sticker"); assert.equal(h.durable[1].type, "sticker");
});
await test("sticker guard revocation after earlier text blocks media without receipt", async () => {
  const h = mediaHost({ beforeEach: async ({ type }) => type !== "sticker" });
  const result = await execute(mediaPlan([{ type: "text", content: "before" }, sticker()]), h.options);
  assert.equal(result.sent, 1); assert.equal(result.uncertain, false); assert.equal(h.stickers.length, 0); assert.equal(result.receipts.length, 1);
});
await test("sticker ACK durable failure stops suffix without replay", async () => {
  const h = mediaHost({ onReceipt: async () => false });
  const result = await execute(mediaPlan([sticker(), { type: "text", content: "never" }]), h.options);
  assert.equal(h.stickers.length, 1); assert.equal(h.calls.length, 0); assert.equal(result.sent, 1); assert.equal(result.uncertain, true);
});
await test("plan/offered-list/receipt mutation cannot substitute later media", async () => {
  const allowedStickerIds = ["asset_A"], p = mediaPlan([{ type: "text", content: "before" }, sticker("asset_A", "fallback")]);
  const h = mediaHost({ allowedStickerIds, onReceipt: async receipt => {
    p.messages[1].stickerId = "foreign"; p.messages[1].fallbackText = "injected";
    allowedStickerIds[0] = "foreign"; receipt.type = "sticker"; receipt.stickerId = "foreign";
  } });
  const result = await execute(p, h.options);
  assert.equal(h.stickers[0].id, "asset_A"); assert.equal(result.receipts[0].type, "text");
  assert.equal(result.receipts[1].stickerId, "asset_A"); assert.equal(result.receipts[1].content, "fallback");
});
await test("account A/B and private offered-ID scopes cannot authorize each other", async () => {
  const p = mediaPlan();
  for (const allowedStickerIds of [["asset_B"], ["private_asset"], []]) {
    assert.throws(() => validateReplyPlan(p, { allowedStickerIds }));
    const h = mediaHost({ allowedStickerIds });
    await assert.rejects(execute(p, h.options)); assert.equal(h.stickers.length, 0); assert.equal(h.calls.length, 0);
  }
  const h = mediaHost(); assert.equal((await execute(p, h.options)).sent, 1);
  await assert.rejects(execute({ ...p, accountId: "account:A" }, h.options));
});
await test("async sticker ACK after mixed-plan cancellation persists once, never suffix", async () => {
  const controller = new AbortController(); let resolveAck, started;
  const sending = new Promise(resolve => { started = resolve; }); let attempts = 0;
  const h = mediaHost({ signal: controller.signal, sendSticker: () => {
    attempts++; started(); return new Promise(resolve => { resolveAck = resolve; });
  } });
  const p = mediaPlan([{ type: "text", content: "before" }, sticker(), { type: "text", content: "never" }], { maxMessages: 3 });
  const pending = execute(p, h.options); await sending; controller.abort(); resolveAck({ messageId: "late_async" });
  const result = await pending;
  assert.equal(attempts, 1); assert.equal(h.calls.length, 1); assert.equal(h.durable.length, 2);
  assert.equal(result.sent, 2); assert.equal(result.partial, true); assert.equal(result.uncertain, false);
  assert.equal(h.durable[1].messageId, "late_async"); assert.equal(h.durable[1].type, "sticker");
});
await test("fallback preserves first quote and cancellation during its ACK records text", async () => {
  const controller = new AbortController(); const h = mediaHost({ signal: controller.signal,
    sendSticker: async () => ({ skipped: true }), sendText: async (content, args) => {
      assert.equal(content, "fallback"); assert.deepEqual(args, { quoteId: "quote", index: 0 });
      controller.abort(); return { messageId: "fallback_late" };
    } });
  const p = mediaPlan([sticker("asset_A", "fallback"), { type: "text", content: "never" }]); p.replyToMessageId = "quote";
  const result = await execute(p, h.options);
  assert.equal(result.sent, 1); assert.equal(result.uncertain, false); assert.equal(h.durable.length, 1);
  assert.equal(h.durable[0].type, "text"); assert.equal(h.durable[0].messageId, "fallback_late");
});
await test("observe/wait never carry sticker bubbles even when host offers ID", () => {
  for (const action of ["observe", "wait"]) assert.throws(() => validateReplyPlan(rawPlan({ action, messages: [sticker()],
    ...(action === "wait" ? { delayMs: 1 } : {}) }), { allowedStickerIds: ["asset_A"], direct: false }));
});
await test("abort between async guard resolution and caller continuation prevents wire", async () => {
  for (const messages of [[{ type: "text", content: "never" }], [sticker()], [sticker("asset_A", "fallback")]]) {
    const controller = new AbortController(); let stickerAttempts = 0;
    const fallback = messages[0].fallbackText;
    const h = mediaHost({ signal: controller.signal, beforeEach: ({ type }) => {
      if (!fallback || type === "text") queueMicrotask(() => queueMicrotask(() => controller.abort()));
      return true;
    }, sendSticker: async () => { stickerAttempts++; return { skipped: true }; } });
    const result = await execute(mediaPlan(messages), h.options);
    assert.equal(h.calls.length, 0); assert.equal(stickerAttempts, fallback ? 1 : 0);
    assert.deepEqual(result, { sent: 0, partial: false, uncertain: false, receipts: [] });
  }
});
console.log(`PASS social-expression: ${checks} synthetic checks; no IO/model/QQ adapters used`);
