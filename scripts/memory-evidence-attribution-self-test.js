import assert from "node:assert/strict";
import { attributeMemoryEvidence, prepareMemoryEvidenceBatch } from "../src/memory-evidence.js";
import { applyCanonicalCorrections, ensureCanonicalMemory, mergeCanonicalEvidence } from "../src/memory-integrity.js";

// Public API tests only. All fixtures are synthetic; no filesystem/network IO.
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T01:00:00.000Z";
const T2 = "2026-01-01T02:00:00.000Z";
const T3 = "2026-01-01T03:00:00.000Z";
const OPTIONS = { conversationId: "group:test", botUserIds: ["90001"] };
let passed = 0;

function test(name, run) {
  try { run(); passed += 1; } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

function message(id = "m1", extra = {}) {
  return { message_id: id, user_id: "10001", conversation_id: OPTIONS.conversationId,
    sentAt: T1, sender: "小明", text: "我喜欢绿茶", ...extra };
}

function claim(extra = {}) {
  return { user_id: "10001", kind: "preference", value: "喜欢绿茶", confidence: 0.8, source_message_ids: ["m1"], ...extra };
}

function run(candidate = claim(), messages = [message()], options = OPTIONS) {
  return attributeMemoryEvidence({ canonical_entries: [candidate] }, messages, options);
}

function denied(item, reason) {
  assert.equal(item.status, "rejected");
  assert.equal(item.reasonCodes.includes(reason), true, JSON.stringify(item.reasonCodes));
  assert.equal(item.context, null);
  assert.equal(item.patch, null);
  assert.equal(item.correction, null);
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (Object.hasOwn(descriptor, "value")) freeze(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}

test("one assertion yields one integrity-compatible patch and selected context", () => {
  const result = run();
  assert.deepEqual(result.errors, []);
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.status, "attributed");
  assert.deepEqual(item.reasonCodes, []);
  assert.deepEqual(item.patch, { user_id: "10001", canonical_entries: [{ kind: "preference", value: "喜欢绿茶", confidence: 0.8, explicit: false }] });
  assert.deepEqual(item.context, { subjectUserId: "10001", sourceUserId: "10001", conversationId: "group:test",
    sourceMessageIds: ["m1"], sourceMessageTimes: { m1: T1 }, sentAt: T1, explicit: false });
  assert.equal(item.correction, null);
});

test("each user field object owns its sources; a user-level source list is never inherited", () => {
  const result = attributeMemoryEvidence({ user_updates: [{ user_id: "10001", confidence: 0.9, source_message_ids: ["m1", "m2"],
    preferences: [{ value: "喜欢绿茶", source_message_ids: ["m1"] }, { value: "喜欢黑咖啡", source_message_ids: ["m2"] }, "喜欢拼装模型"]
  }] }, [message(), message("m2", { sentAt: T2, text: "我也喜欢黑咖啡" })], OPTIONS);
  assert.deepEqual(result.items.map((item) => item.status), ["attributed", "attributed", "unattributed"]);
  assert.deepEqual(result.items[0].context.sourceMessageIds, ["m1"]);
  assert.equal(result.items[0].context.sentAt, T1);
  assert.deepEqual(result.items[1].context.sourceMessageIds, ["m2"]);
  assert.equal(result.items[1].context.sentAt, T2);
  assert.equal(result.items[2].patch, null);
  assert.equal(result.items[2].context, null);
});

test("legacy strings and missing/empty lists are non-executable unattributed candidates", () => {
  for (const sources of [undefined, []]) {
    const candidate = claim();
    if (sources === undefined) delete candidate.source_message_ids;
    else candidate.source_message_ids = sources;
    const item = run(candidate).items[0];
    assert.equal(item.status, "unattributed");
    assert.deepEqual(item.reasonCodes, ["SOURCE_IDS_MISSING"]);
    assert.equal(item.context, null);
    assert.equal(item.patch, null);
    assert.equal(item.candidate.value, "喜欢绿茶");
  }
  const result = attributeMemoryEvidence({ user_updates: [{ user_id: "10001", memes: ["老梗"], notable_quotes: ["旧原话"] }] }, [message()], OPTIONS);
  for (const item of result.items) {
    assert.equal(item.status, "unattributed");
    assert.equal(item.patch, null, "unsourced memes/quotes must not activate via canonical kind exemptions");
  }
});

test("forged or partly forged IDs reject the whole assertion instead of partial fallback", () => {
  for (const ids of [["forged"], ["m1", "forged"]]) denied(run(claim({ source_message_ids: ids })).items[0], "SOURCE_NOT_IN_BATCH");
});

test("same nickname never substitutes for the actual QQ sender", () => {
  const messages = [message(), message("other", { user_id: "10002", sender: "小明", text: "我不喜欢绿茶" })];
  denied(run(claim({ source_message_ids: ["other"] }), messages).items[0], "SOURCE_SUBJECT_MISMATCH");
  denied(run(claim({ user_id: "小明" }), messages).items[0], "SOURCE_SUBJECT_MISMATCH");
  denied(run(claim({ source_message_ids: ["m1", "other"] }), messages).items[0], "SOURCE_SUBJECT_MISMATCH");
});

test("same QQ with different names stays one sender; numeric/string IDs agree", () => {
  const messages = [message(), message("m2", { user_id: 10001, sender: "改名之后", sentAt: T2 })];
  const item = run(claim({ user_id: 10001, source_message_ids: ["m2", "m1", "m1"] }), messages).items[0];
  assert.equal(item.status, "attributed");
  assert.deepEqual(item.context.sourceMessageIds, ["m1", "m2"]);
  assert.equal(item.context.subjectUserId, "10001");
  assert.equal(item.context.sentAt, T2);
});

test("event time is newest selected real event, independent of processing/arrival order", () => {
  const messages = [message("m3", { sentAt: T3 }), message(), message("m2", { sentAt: T2 })];
  const candidate = claim({ source_message_ids: ["m2", "m1"], sent_at: "2099-01-01T00:00:00.000Z" });
  const first = run(candidate, messages, { ...OPTIONS, now: "2099", receivedAt: "2099" });
  const second = run(candidate, [...messages].reverse());
  assert.equal(first.items[0].context.sentAt, T2);
  assert.deepEqual(first.items, second.items);
});

test("explicit timestamp units and aliases normalize without clock fallback", () => {
  const cases = [
    { sent_at: T1 }, { sentAtMs: Date.parse(T1) }, { time: Date.parse(T1) / 1000 },
    { sent_at: "2026-01-01T09:00:00+08:00", time: Date.parse(T1) / 1000 }
  ];
  for (const timing of cases) {
    const source = message();
    delete source.sentAt;
    Object.assign(source, timing);
    const item = run(claim(), [source]).items[0];
    assert.equal(item.status, "attributed");
    assert.equal(item.context.sentAt, T1);
  }
  const source = message();
  delete source.sentAt;
  source.at = T1;
  source.receivedAt = T3;
  denied(run(claim(), [source]).items[0], "INVALID_EVENT_TIME");
});

test("invalid/ambiguous numerical and calendar timestamps reject sources", () => {
  for (const sentAt of [undefined, null, NaN, Infinity, -1, 1, Date.parse(T1), "2026-02-30T01:00:00Z", "2026-01-01", "yesterday", {}, "2026-01-01T25:00:00Z"]) {
    denied(run(claim(), [message("m1", { sentAt })]).items[0], "INVALID_EVENT_TIME");
  }
  denied(run(claim(), [message("m1", { time: Date.parse(T2) / 1000 })]).items[0], "INVALID_EVENT_TIME");
  denied(run(claim(), [message("m1", { sentAt: Number.MAX_SAFE_INTEGER })]).items[0], "INVALID_EVENT_TIME");
});

test("bot/tool/system messages cannot authorize user facts", () => {
  for (const actor of [{ isBot: true }, { is_tool: true }, { role: "assistant" }, { role: "tool" },
    { role: "system" }, { user_id: "90001" }, { self_id: "10001" }, { post_type: "message_sent" },
    { source: "tool" }, { type: "tool_result" }, { source_type: "bot" }, { sender: { user_id: "10001", role: "bot" } }]) {
    const source = message("m1", actor);
    const candidate = claim({ user_id: source.user_id });
    denied(run(candidate, [source]).items[0], "NON_HUMAN_SOURCE");
  }
  denied(run(claim(), [message("m1", { isBot: "false" })]).items[0], "INVALID_ACTOR_FLAG");
});

test("replies and old quoted IDs never become speaker self-statements or batch sources", () => {
  const source = message("m1", { reply: { message_id: "old", user_id: "10002", text: "我喜欢绿茶", sentAt: T0 } });
  denied(run(claim(), [source]).items[0], "QUOTED_SOURCE");
  denied(run(claim({ user_id: "10002", source_message_ids: ["old"] }), [source]).items[0], "SOURCE_NOT_IN_BATCH");
  const prepared = prepareMemoryEvidenceBatch([source], OPTIONS);
  assert.deepEqual(prepared.messages, []);
  assert.equal(prepared.rejected[0].reasonCodes.includes("QUOTED_SOURCE"), true);
});

test("quote markup, forward segments and attached authored clauses fail closed", () => {
  const extras = [
    { text: "他说：“我喜欢绿茶”" }, { text: "他说: '我喜欢绿茶'" }, { text: "> 我喜欢绿茶\n我只是转述" },
    { text: "[CQ:reply,id=old]我也这么想" }, { text: "`我喜欢绿茶`" }, { text: "<blockquote>我喜欢绿茶</blockquote>" },
    { replyContexts: [{ text: "我喜欢绿茶" }] }, { quoted_message_id: "old" }, { isQuoted: true },
    { message: [{ type: "reply", data: { id: "old" } }, { type: "text", data: { text: "我喜欢绿茶" } }] },
    { message: [{ type: "forward", data: { id: "old" } }] }, { message: [{ type: "node", data: { content: "旧引用" } }] }
  ];
  for (const extra of extras) denied(run(claim(), [message("m1", extra)]).items[0], "QUOTED_SOURCE");
});

test("message bodies must be actual text, not model summaries or hidden segments", () => {
  const source = message();
  delete source.text;
  source.message = [{ type: "text", data: { text: "我喜欢绿茶" } }];
  assert.equal(run(claim(), [source]).items[0].status, "attributed");
  denied(run(claim(), [message("m1", { message: "别人的话" })]).items[0], "CONFLICTING_MESSAGE_BODY");
  denied(run(claim(), [message("m1", { message: [{ type: "image", data: { file: "image" } }] })]).items[0], "NON_TEXT_SOURCE");
  denied(run(claim(), [message("m1", { text: "" })]).items[0], "EMPTY_SOURCE_TEXT");
});

test("exact duplicate deliveries coalesce, inconsistent duplicate IDs are ambiguous", () => {
  assert.equal(run(claim(), [message(), message("m1", { sender: "新昵称" })]).items[0].status, "attributed");
  assert.equal(prepareMemoryEvidenceBatch([message(), message()], OPTIONS).messages.length, 1);
  for (const change of [{ user_id: "10002" }, { text: "另一个文本" }, { sentAt: T2 }, { isBot: true }]) {
    denied(run(claim(), [message(), message("m1", change)]).items[0], "AMBIGUOUS_SOURCE_ID");
  }
});

test("conversation scope cannot be forged and IDs from other conversations do not count", () => {
  denied(run(claim({ conversation_id: "group:other" })).items[0], "CONVERSATION_MISMATCH");
  denied(run(claim(), [message("m1", { conversation_id: "group:other" })]).items[0], "SOURCE_NOT_IN_BATCH");
  assert.equal(run(claim(), [message(), message("m1", { conversation_id: "group:other", user_id: "10002" })]).items[0].status, "attributed");
});

test("source ID aliases agree by set; malformed/conflicting lists never authorize", () => {
  assert.equal(run(claim({ sourceMessageIds: ["m1", "m1"] })).items[0].status, "attributed");
  for (const value of ["m1", [NaN], [Infinity], [{}], [null], [true], [""], ["__proto__"], [Number.MAX_SAFE_INTEGER + 1]]) {
    denied(run(claim({ source_message_ids: value })).items[0], "INVALID_SOURCE_IDS");
  }
  denied(run(claim({ sourceMessageIds: ["other"] })).items[0], "INVALID_SOURCE_IDS");
});

test("identity aliases must agree; malformed IDs and parent/child rebinding are rejected", () => {
  for (const user_id of [null, {}, NaN, Infinity, true, "", "__proto__", "constructor"]) denied(run(claim({ user_id })).items[0], "INVALID_SUBJECT_ID");
  denied(run(claim({ userId: "10002" })).items[0], "INVALID_SUBJECT_ID");
  const result = attributeMemoryEvidence({ user_updates: [{ user_id: "10002", preferences: [claim()] }] }, [message()], OPTIONS);
  denied(result.items[0], "INVALID_SUBJECT_ID");
  denied(run(claim(), [message("m1", { sender: { user_id: "10002", nickname: "小明" } })]).items[0], "INVALID_SENDER_ID");
});

test("all canonical field mappings and camel envelope aliases are supported", () => {
  const fields = { aliases: "alias", profile: "profile", personality: "personality", preferences: "preference",
    boundaries: "boundary", coreMemes: "core_meme", core_memes: "core_meme", memes: "meme", style: "style",
    relationships: "relationship", interactionTips: "interaction_tip", interaction_tips: "interaction_tip",
    notableQuotes: "notable_quote", notable_quotes: "notable_quote" };
  for (const [field, kind] of Object.entries(fields)) {
    const result = attributeMemoryEvidence({ userUpdates: [{ userId: "10001", [field]: [{ value: "旧值", sourceMessageIds: ["m1"] }] }] }, [message()], OPTIONS);
    assert.equal(result.items[0].status, "attributed", field);
    assert.equal(result.items[0].patch.canonical_entries[0].kind, kind);
  }
  const result = attributeMemoryEvidence({ user_updates: [{ user_id: "10001", canonicalEntries: [{ kind: "preference", value: "喜欢绿茶", sourceMessageIds: ["m1"] }] }] }, [message()], OPTIONS);
  assert.equal(result.items[0].status, "attributed");
});

test("invalid scalar fields, NaN confidence and kind ambiguity stay non-executable", () => {
  for (const value of [NaN, Infinity, -Infinity, -1, 2, "0.8", true, null, {}, []]) denied(run(claim({ confidence: value })).items[0], "INVALID_CONFIDENCE");
  for (const value of [null, 42, true, {}, [], "", "x".repeat(241)]) denied(run(claim({ value })).items[0], "INVALID_VALUE");
  denied(run(claim({ kind: "__proto__" })).items[0], "INVALID_KIND");
  denied(run(claim({ explicit: "true" })).items[0], "INVALID_EXPLICIT_HINT");
  const result = attributeMemoryEvidence({ user_updates: [{ user_id: "10001", preferences: [claim({ kind: "boundary" })] }] }, [message()], OPTIONS);
  denied(result.items[0], "KIND_MISMATCH");
});

test("AI explicit hints never mint trusted explicit commands", () => {
  const item = run(claim({ explicit: true, context: { explicit: true } })).items[0];
  assert.equal(item.candidate.explicitHint, true);
  assert.equal(item.patch.canonical_entries[0].explicit, false);
  assert.equal(item.context.explicit, false);
});

test("correction source is per-item, same-sender, real-time and separately authorized", () => {
  const result = attributeMemoryEvidence({ forget_or_correct: [
    { user_id: "10001", memory_id: "mem_known", action: "reject", reason: "本人纠正", source_message_ids: ["m1"] },
    { user_id: "10001", memory_id: "mem_known", action: "reject" },
    { user_id: "10002", memory_id: "mem_known", action: "reject", source_message_ids: ["m1"] }
  ] }, [message()], OPTIONS);
  assert.equal(result.items[0].status, "attributed");
  assert.deepEqual(result.items[0].correction, { user_id: "10001", memory_id: "mem_known", action: "reject", reason: "本人纠正" });
  assert.equal(result.items[0].context.sentAt, T1);
  assert.equal(result.items[0].requiresAuthorization, true);
  assert.equal(result.items[0].context.explicit, false);
  denied(result.items[1], "SOURCE_IDS_MISSING");
  denied(result.items[2], "SOURCE_SUBJECT_MISMATCH");
});

test("missing subject, malformed correction action/ID and old string corrections fail closed", () => {
  for (const candidate of [
    { memory_id: "mem_known", action: "reject", source_message_ids: ["m1"] },
    { user_id: "10001", memory_id: {}, action: "reject", source_message_ids: ["m1"] },
    { user_id: "10001", memory_id: "mem_known", action: "delete-all", source_message_ids: ["m1"] },
    "把所有旧记忆忘掉"
  ]) {
    const result = attributeMemoryEvidence({ corrections: [candidate] }, [message()], OPTIONS);
    assert.equal(result.items[0].status, "rejected");
    assert.equal(result.items[0].correction, null);
  }
});

test("prototype payloads and accessors cannot be read or pollute output", () => {
  const polluted = JSON.parse('{"user_id":"10001","kind":"preference","value":"bad","source_message_ids":["m1"],"__proto__":{"polluted":true}}');
  denied(run(polluted).items[0], "INVALID_CANDIDATE");
  assert.equal({}.polluted, undefined);
  const inherited = Object.assign(Object.create({ source_message_ids: ["m1"] }), claim());
  denied(run(inherited).items[0], "INVALID_CANDIDATE");
  let reads = 0;
  const getter = { ...claim() };
  Object.defineProperty(getter, "value", { get() { reads += 1; throw new Error("must not run"); } });
  denied(run(getter).items[0], "INVALID_CANDIDATE");
  const sources = ["m1"];
  Object.defineProperty(sources, "0", { get() { reads += 1; throw new Error("must not run"); } });
  denied(run(claim({ source_message_ids: sources })).items[0], "INVALID_SOURCE_IDS");
  const raw = message();
  Object.defineProperty(raw, "text", { get() { reads += 1; throw new Error("must not run"); } });
  denied(run(claim(), [raw]).items[0], "SOURCE_NOT_IN_BATCH");
  assert.equal(reads, 0);
});

test("null-prototype JSON records are safe and supported", () => {
  const candidate = Object.assign(Object.create(null), claim());
  const source = Object.assign(Object.create(null), message());
  assert.equal(run(candidate, [source]).items[0].status, "attributed");
});

test("invalid containers/options produce diagnostics without executable patches", () => {
  for (const value of [null, [], "raw JSON", NaN]) assert.equal(attributeMemoryEvidence(value, [message()], OPTIONS).errors.includes("INVALID_PATCH"), true);
  assert.equal(attributeMemoryEvidence({ canonical_entries: "bad" }, [message()], OPTIONS).errors[0], "INVALID_ARRAY:canonical_entries");
  assert.equal(attributeMemoryEvidence({ user_updates: [null] }, [message()], OPTIONS).errors[0], "INVALID_USER_UPDATE:user_updates[0]");
  denied(run(claim(), [message()], {}).items[0], "INVALID_CONVERSATION_ID");
  denied(run(claim(), [message()], { ...OPTIONS, botUserIds: [NaN] }).items[0], "INVALID_BOT_USER_IDS");
  denied(run(claim(), null).items[0], "INVALID_BATCH");
  const sparse = new Array(2);
  sparse[1] = "m1";
  denied(run(claim({ source_message_ids: sparse })).items[0], "INVALID_SOURCE_IDS");
  denied(run(claim(), [message()], { ...OPTIONS, botUserIds: sparse }).items[0], "INVALID_BOT_USER_IDS");
});

test("module uses only supplied event timestamps, never the current clock", () => {
  const RealDate = globalThis.Date;
  class EventOnlyDate extends RealDate {
    constructor(...args) {
      assert.notEqual(args.length, 0, "clock constructor forbidden");
      super(...args);
    }
    static now() { throw new Error("clock access forbidden"); }
  }
  try {
    globalThis.Date = EventOnlyDate;
    const prepared = prepareMemoryEvidenceBatch([message()], OPTIONS);
    assert.equal(prepared.messages[0].sent_at, T1);
    assert.equal(run(claim(), prepared.messages).items[0].context.sentAt, T1);
    denied(run(claim(), [message("m1", { sentAt: undefined })]).items[0], "INVALID_EVENT_TIME");
  } finally {
    globalThis.Date = RealDate;
  }
});

test("public APIs are deterministic and do not mutate frozen input or expose references", () => {
  const patch = freeze({ canonical_entries: [claim()] });
  const messages = freeze([message()]);
  const options = freeze({ ...OPTIONS, botUserIds: ["90001"] });
  const first = attributeMemoryEvidence(patch, messages, options);
  assert.deepEqual(first, attributeMemoryEvidence(patch, messages, options));
  const prepared = prepareMemoryEvidenceBatch(messages, options);
  first.items[0].context.sourceMessageIds.push("forged");
  first.items[0].patch.canonical_entries[0].value = "changed";
  prepared.messages[0].text = "changed";
  assert.equal(messages[0].text, "我喜欢绿茶");
  assert.deepEqual(patch.canonical_entries[0].source_message_ids, ["m1"]);
  assert.equal(attributeMemoryEvidence(patch, messages, options).items[0].candidate.value, "喜欢绿茶");
});

test("integration preserves integrity dedupe and never turns unbound sources active", () => {
  const user = {};
  ensureCanonicalMemory(user, "10001", { at: T0 });
  const first = run().items[0];
  mergeCanonicalEvidence(user, first.patch, first.context);
  mergeCanonicalEvidence(user, first.patch, first.context);
  assert.equal(user.canonicalMemory.entries[0].evidenceConfirmations, 1);
  assert.equal(user.canonicalMemory.entries[0].status, "tentative");
  const second = run(claim({ source_message_ids: ["m2"] }), [message("m2", { sentAt: T2 })]).items[0];
  mergeCanonicalEvidence(user, second.patch, second.context);
  assert.equal(user.canonicalMemory.entries[0].evidenceConfirmations, 2);
  assert.equal(user.canonicalMemory.entries[0].status, "active");
  const correction = attributeMemoryEvidence({ forget_or_correct: [{ user_id: "10001", memory_id: user.canonicalMemory.entries[0].id,
    action: "reject", source_message_ids: ["m3"] }] }, [message("m3", { sentAt: T3, text: "我本人纠正这条记忆" })], OPTIONS).items[0];
  // The synthetic test explicitly supplies the separate authorization decision.
  const callerAuthorized = true;
  if (callerAuthorized && correction.status === "attributed") applyCanonicalCorrections(user, [correction.correction], correction.context);
  assert.equal(user.canonicalMemory.entries[0].status, "rejected");
  const invalid = run(claim({ source_message_ids: ["forged"], explicit: true })).items[0];
  assert.equal(invalid.patch, null);
  assert.equal(user.canonicalMemory.entries.length, 1);
});

console.log(JSON.stringify({ ok: true, tests: passed, suite: "memory-evidence-attribution" }));
