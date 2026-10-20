import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { searchArchiveContext, searchArchiveRecords } from "../src/archive-search-index.js";
import { ArchiveSearchService } from "../src/archive-search-service.js";

// No bridge/config/runtime data: all files are synthetic and temporary.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-context-test-"));
const services = [];
let checks = 0;
const row = (messageId, text, extra = {}) => ({ messageId, conversationId: "group:a", text, ...extra });
const ids = (records) => records.map((record) => record.messageId);
const related = (records) => ids(records.map((item) => item.record));
const identity = (record) => record;
const raw = { sanitizeRecord: identity, policyKey: "context-test-v1" };
function fixture(name, rows) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const file = path.join(dir, "messages.jsonl");
  fs.writeFileSync(file, rows.map((record) => `${JSON.stringify(record)}\n`).join(""));
  return fs.realpathSync(file);
}
const cache = (file) => path.join(path.dirname(file), "search-index.json");
const query = (file, options = {}) => searchArchiveContext(file, { ...raw, ...options });
const service = (options) => { const value = new ArchiveSearchService(options); services.push(value); return value; };
const digest = (value) => createHash("sha256").update(value).digest("hex");
function changeIndex(file, edit) {
  const data = JSON.parse(fs.readFileSync(cache(file), "utf8")).data;
  edit(data);
  fs.writeFileSync(cache(file), JSON.stringify({ data, digest: digest(JSON.stringify(data)) }));
}
async function test(name, run) { await run(); checks += 1; console.log(`PASS ${name}`); }
async function until(predicate) {
  for (let i = 0; i < 1000; i += 1) { if (predicate()) return; await delay(5); }
  assert.fail("bounded wait expired");
}
async function code(promise, expected) {
  await assert.rejects(promise, (error) => error.code === expected && error.message === expected
    && error.stack === `ArchiveSearchError: ${expected}` && !error.cause);
}

try {
  const conversation = [row("before", "我在选一台轻便的电脑"), row("anchor", "那个挺合适", { anchorMessageId: "forged-root" }), row("after", "主要看续航")];
  const file = fixture("pronoun", conversation);

  await test("adjacency explains a pronoun; only outer packet carries derived relations", () => {
    const before = fs.readFileSync(file);
    const packet = query(file, { terms: ["那个"] });
    assert.deepEqual(packet.matches, [conversation[1]]);
    assert.deepEqual(related(packet.neighbors), ["before", "after"]);
    assert.deepEqual(packet.neighbors.map((item) => item.anchorMessageId), ["anchor", "anchor"]);
    assert.deepEqual(packet.neighbors.map((item) => item.record), [conversation[0], conversation[2]]);
    assert.deepEqual(packet.quoted, []);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(query(file, { terms: ["那个"], neighborWindow: 0 }), { matches: [conversation[1]], neighbors: [], quoted: [] });
    assert.ok(Array.isArray(searchArchiveRecords(file, { ...raw, terms: ["那个"] })));
  });

  await test("old references use actual same-file rows, bounded BFS, never quoted inline text", () => {
    const old = row("old", "真正的旧方案", { quotedMessage: { ids: ["older"] } });
    const older = row("older", "更早的依据");
    const far = row("far", "另一个真实来源");
    const rootRecord = row("root", "请解释那个方案", { quotedMessage: { ids: ["old", "missing"],
      contexts: [{ messageId: "far", text: "伪造的引用内容" }, { messageId: "missing", text: "不存在的来源" }] } });
    const archive = fixture("old-quote", [older, old, far, ...Array.from({ length: 1400 }, (_, i) => row(`filler-${i}`, "普通讨论")), rootRecord]);
    const packet = query(archive, { messageIds: ["root"] });
    assert.deepEqual(related(packet.quoted), ["old", "far", "older"]);
    assert.ok(packet.quoted.every((item) => item.anchorMessageId === "root"));
    assert.deepEqual(packet.quoted.map((item) => item.record), [old, far, older]);
    assert.deepEqual(related(query(archive, { messageIds: ["root"], quoteDepth: 1 }).quoted), ["old", "far"]);
    assert.deepEqual(query(archive, { messageIds: ["root"], quoteDepth: 0 }).quoted, []);
  });

  await test("explicit conversation exactness, legacy compatibility and mixed-file isolation", () => {
    const archive = fixture("mixed", [row("same", "正确旧消息"), row("same", "其他群旧消息", { conversationId: "group:b" }),
      row("foreign", "其他会话内容", { conversationId: "group:b" }), row("legacy", "无会话旧格式", { conversationId: undefined }),
      row("root", "共同匹配词", { quotedMessage: { ids: ["same", "foreign", "legacy"] } }),
      row("foreign-root", "共同匹配词", { conversationId: "group:b" })]);
    const packet = query(archive, { terms: ["共同匹配词"], conversationId: "group:a", neighborWindow: 2 });
    assert.deepEqual(ids(packet.matches), ["root"]);
    assert.deepEqual(related(packet.quoted), ["same", "legacy"]);
    assert.ok([...packet.matches, ...packet.neighbors.map((item) => item.record), ...packet.quoted.map((item) => item.record)]
      .every((record) => record.conversationId === undefined || record.conversationId === "group:a"));
    assert.deepEqual(query(archive, { messageIds: ["root"], conversationId: "GROUP:A" }).matches, []);
    assert.deepEqual(ids(query(archive, { terms: ["共同匹配词"] }).matches), ["foreign-root"], "implicit scope comes from highest-ranked actual match");
    assert.deepEqual(ids(searchArchiveRecords(archive, { ...raw, terms: ["共同匹配词"] })), ["foreign-root", "root"], "old array API must not acquire implicit scoping");
    const legacy = query(archive, { messageIds: ["legacy"] });
    assert.deepEqual(legacy.neighbors, [], "missing-ID root cannot authorize expansion into an explicit conversation");
  });

  await test("malicious quote cycles/duplicates/self-references terminate; reply user IDs are not message IDs", () => {
    const archive = fixture("cycles", [row("user-id", "这不是被引用的消息"), row("d", "第三跳不允许"),
      row("c", "第二跳", { replyMessageId: "d" }), row("b", "第一跳", { replyToMessageId: "c", replyIds: ["a", "c"] }),
      row("a", "循环根", { quotedMessage: { ids: ["a", "b", "b"] }, replyMessageIds: ["b"], replyToUserId: "user-id" })]);
    const packet = query(archive, { messageIds: ["a"], maxNeighbors: 0 });
    assert.deepEqual(related(packet.quoted), ["b", "c"]);
    assert.deepEqual(packet.quoted.map((item) => item.anchorMessageId), ["a", "a"]);
    assert.ok(packet.quoted.every((item) => !Object.hasOwn(item.record, "anchorMessageId")));
  });

  await test("independent quotas, hard total 12, fixed window and invalid budgets", () => {
    const refs = Array.from({ length: 20 }, (_, i) => row(`ref-${i}`, `引用${i}`));
    const archive = fixture("budgets", [...refs, row("p2", "前二"), row("p1", "前一"),
      row("root", "根", { quotedMessage: { ids: refs.map((record) => record.messageId) } }), row("n1", "后一"), row("n2", "后二")]);
    const packet = query(archive, { messageIds: ["root"], neighborWindow: 2, maxNeighbors: 2, maxQuoted: 2 });
    assert.deepEqual(related(packet.neighbors), ["p2", "p1"]);
    assert.deepEqual(related(packet.quoted), ["ref-0", "ref-1"]);
    const quotesOnly = query(archive, { messageIds: ["root"], maxNeighbors: 0, maxQuoted: 12 });
    assert.equal(quotesOnly.quoted.length, 12);
    assert.equal(quotesOnly.neighbors.length, 0);
    for (const options of [{ neighborWindow: 3 }, { neighborWindow: -1 }, { quoteDepth: 3 }, { maxNeighbors: 7, maxQuoted: 6 },
      { maxQuoted: NaN }, { maxNeighbors: 0.5 }, { conversationId: "" }, { conversationId: 7 }]) {
      assert.throws(() => query(archive, { messageIds: ["root"], ...options }), TypeError);
    }
  });

  await test("stable match rank, neighbor byte order, quote declaration order and append", () => {
    const archive = fixture("ordering", [row("q1", "引用一"), row("q2", "引用二"), row("before-1", "背景一"),
      row("a1", "锚点", { quotedMessage: { ids: ["q2", "q1"] } }), row("after-1", "补充一"), row("before-2", "背景二"),
      row("a2", "锚点", { quotedMessage: { contexts: [{ messageId: "q1" }] } }), row("after-2", "补充二")]);
    const options = { terms: ["锚点"] };
    const first = query(archive, options);
    assert.deepEqual(ids(first.matches), ["a2", "a1"]);
    assert.deepEqual(related(first.neighbors), ["before-2", "after-2", "before-1", "after-1"]);
    assert.deepEqual(first.quoted.map((item) => [item.anchorMessageId, item.record.messageId]), [["a2", "q1"], ["a1", "q2"], ["a1", "q1"]]);
    assert.deepEqual(query(archive, options), first);
    const previousRows = JSON.parse(fs.readFileSync(cache(archive), "utf8")).data.rows;
    fs.appendFileSync(archive, `${JSON.stringify(row("a3", "锚点"))}\n`);
    const appended = query(archive, options);
    assert.deepEqual(ids(appended.matches), ["a3", "a2", "a1"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(cache(archive), "utf8")).data.rows.slice(0, previousRows.length), previousRows);
  });

  await test("one source open/one cache load, no whole JSONL read or second parse of reused rows", () => {
    const archive = fixture("single-load", [row("old", "实际旧记录"), row("root", "锚点", { quotedMessage: { ids: ["old"] } }), row("next", "邻接")]);
    let sanitizations = 0;
    const sanitizeRecord = (record) => { sanitizations += 1; return record; };
    const options = { messageIds: ["root"], sanitizeRecord, policyKey: "count-v1" };
    searchArchiveContext(archive, options);
    sanitizations = 0;
    const originalOpen = fs.openSync;
    const originalRead = fs.readFileSync;
    const ino = fs.statSync(archive).ino;
    let sourceOpens = 0;
    let indexOpens = 0;
    fs.openSync = function (target, ...args) {
      if (target === archive) sourceOpens += 1;
      if (target === cache(archive)) indexOpens += 1;
      return originalOpen.call(this, target, ...args);
    };
    fs.readFileSync = function (target, ...args) {
      if (target === archive || (typeof target === "number" && fs.fstatSync(target).ino === ino)) throw new Error("whole source read forbidden");
      return originalRead.call(this, target, ...args);
    };
    try {
      const packet = searchArchiveContext(archive, options);
      assert.equal(sourceOpens, 1);
      assert.equal(indexOpens, 1);
      assert.equal(sanitizations, 3, "anchor, previous and next parsed/sanitized once; quote reuses previous");
      assert.deepEqual(related(packet.quoted), ["old"]);
    } finally { fs.openSync = originalOpen; fs.readFileSync = originalRead; }
  });

  await test("expansion verifies hashes, rejects forged postings and bounds rejected candidate reads", () => {
    const archive = fixture("integrity", [row("old", "来源"), row("root", "锚点", { quotedMessage: { ids: ["old"] } })]);
    query(archive, { messageIds: ["root"] });
    changeIndex(archive, (data) => { data.rows[0][2] = "0".repeat(64); });
    assert.throws(() => query(archive, { messageIds: ["root"] }), /record mismatch/);
    const poison = fixture("posting-poison", [...Array.from({ length: 100 }, (_, i) => row(`wrong-${i}`, "非目标")),
      row("root", "锚点", { quotedMessage: { ids: ["absent-id"] } })]);
    let calls = 0;
    const sanitizeRecord = (record) => { calls += 1; return record; };
    const options = { messageIds: ["root"], sanitizeRecord, policyKey: "bounded-reject-v1", maxNeighbors: 0, maxQuoted: 12 };
    searchArchiveContext(poison, options);
    calls = 0;
    changeIndex(poison, (data) => { data.postings.push([digest("message:absent-id"), Array.from({ length: 100 }, (_, i) => i)]); });
    const packet = searchArchiveContext(poison, options);
    assert.deepEqual(packet.quoted, [], "posting hit with wrong actual ID is not quote evidence");
    assert.equal(calls, 49, "one match plus at most 48 rejected quote candidates");
  });

  await test("custom sanitizer cannot erase conversation evidence or manufacture a quote identity", () => {
    const archive = fixture("sanitizer-proof", [row("foreign", "不应返回", { conversationId: "group:b" }), row("root", "锚点")]);
    const sanitizeRecord = (record) => { delete record.conversationId; return record; };
    const packet = query(archive, { messageIds: ["root", "foreign"], conversationId: "group:a", sanitizeRecord, policyKey: "erase-conversation" });
    assert.deepEqual(ids(packet.matches), ["root"]);
    assert.deepEqual(packet.neighbors, []);
    const manufactured = fixture("sanitizer-identity", [row("original", "真实消息"),
      row("root", "锚点", { quotedMessage: { ids: ["fabricated"] } })]);
    const rename = (record) => record.messageId === "original" ? { ...record, messageId: "fabricated" } : record;
    const renamed = query(manufactured, { messageIds: ["root"], maxNeighbors: 0, sanitizeRecord: rename, policyKey: "rename-message" });
    assert.deepEqual(renamed.quoted, [], "sanitized ID/posting is not proof of the raw message identity");
  });

  await test("empty/missing context packets preserve the original synchronous empty array API", () => {
    const empty = { matches: [], neighbors: [], quoted: [] };
    assert.deepEqual(query(file), empty);
    assert.deepEqual(query(file, { messageIds: ["anchor"], maxCandidates: 0 }), empty);
    assert.deepEqual(query(path.join(root, "missing.jsonl"), { terms: ["none"] }), empty);
    assert.deepEqual(searchArchiveRecords(path.join(root, "missing.jsonl"), { terms: ["none"] }), []);
  });

  await test("service context/search share a reusable worker and validate kind-specific options/packets", async () => {
    const instance = service();
    const [packet, records] = await Promise.all([
      instance.context(file, { messageIds: ["anchor"], conversationId: "group:a" }), instance.search(file, { messageIds: ["before"] })
    ]);
    assert.deepEqual(related(packet.neighbors), ["before", "after"]);
    assert.deepEqual(ids(records), ["before"]);
    assert.equal(instance.status().workerStarts, 1);
    assert.deepEqual(await instance.context(path.join(root, "missing.jsonl"), { terms: ["none"] }), { matches: [], neighbors: [], quoted: [] });
    for (const options of [{ neighborWindow: 3 }, { quoteDepth: 3 }, { maxNeighbors: 7 }, { maxQuoted: -1 },
      { conversationId: 7 }, { sanitizeRecord: identity }, { privacyFilter: "true" }]) {
      await code(instance.context(file, options), "INVALID_OPTIONS");
    }
    await code(instance.search(file, { neighborWindow: 1 }), "INVALID_OPTIONS");
    await instance.close();
  });

  await test("shared privacy applies to every context role; omitted mode remains default and false is compatible", async () => {
    const record = row("source", "https://example.org/manual password=SyntheticPassword987", { apiKey: "SyntheticKey765" });
    const archive = fixture("context-privacy", [record, row("root", "选那个", { quotedMessage: { ids: ["source"] } })]);
    const instance = service();
    const options = { messageIds: ["root"], privacyFilter: true, policyKey: "caller-v1" };
    const packet = await instance.context(archive, options);
    assert.equal(packet.neighbors[0].record.text.includes("https://example.org/manual"), true);
    assert.equal(packet.quoted[0].record.text.includes("https://example.org/manual"), true);
    assert.ok(!JSON.stringify(packet).includes("SyntheticPassword987"));
    assert.ok(!JSON.stringify(packet).includes("SyntheticKey765"));
    const safePolicy = JSON.parse(fs.readFileSync(cache(archive), "utf8")).data.policy;
    const unfiltered = await instance.context(archive, { ...options, privacyFilter: false });
    assert.deepEqual(unfiltered.quoted[0].record, record);
    assert.notEqual(JSON.parse(fs.readFileSync(cache(archive), "utf8")).data.policy, safePolicy);
    const safeAgain = await instance.context(archive, options);
    assert.deepEqual(safeAgain, packet);
    assert.equal(JSON.parse(fs.readFileSync(cache(archive), "utf8")).data.policy, safePolicy);
    const omitted = await instance.context(archive, { messageIds: ["root"] });
    assert.ok(!omitted.quoted[0].record.text.includes("https://example.org/manual"));
    await instance.close();
  });

  await test("result byte cap includes the entire packet; failure cannot retire the following search", async () => {
    const expected = searchArchiveContext(file, { messageIds: ["anchor"] });
    const bytes = Buffer.byteLength(JSON.stringify(expected));
    const exact = service({ maxResultBytes: bytes });
    assert.deepEqual(await exact.context(file, { messageIds: ["anchor"] }), expected);
    await exact.close();
    const below = service({ maxResultBytes: bytes - 1 });
    const rejected = code(below.context(file, { messageIds: ["anchor"] }), "RESULT_LIMIT");
    const next = below.search(file, { messageIds: ["before"] });
    await rejected;
    assert.deepEqual(ids(await next), ["before"]);
    assert.equal(below.status().workerStarts, 2);
    await below.close();
  });

  await test("active/pending context cancellation and timeout recover without killing next-kind requests", async () => {
    const heavy = fixture("cancellation", Array.from({ length: 6500 }, (_, i) => row(`heavy-${i}`, "synthetic context filler ".repeat(80))));
    const instance = service({ timeoutMs: 60000 });
    const abort = new AbortController();
    const stopped = code(instance.context(heavy, { messageIds: ["heavy-1"] }, { signal: abort.signal }), "ABORTED");
    await until(() => instance.status().running === 1);
    await delay(30);
    const pendingAbort = new AbortController();
    const pending = code(instance.context(file, { messageIds: ["anchor"] }, { signal: pendingAbort.signal }), "ABORTED");
    const next = instance.search(file, { messageIds: ["before"] });
    pendingAbort.abort();
    abort.abort("synthetic private reason");
    await Promise.all([stopped, pending]);
    assert.deepEqual(ids(await next), ["before"]);
    assert.equal(instance.status().workerStarts, 2);
    const old = new AbortController();
    await instance.context(file, { messageIds: ["anchor"] }, { signal: old.signal });
    const subsequent = instance.search(file, { messageIds: ["after"] });
    old.abort();
    assert.deepEqual(ids(await subsequent), ["after"]);
    const expired = code(instance.context(heavy, { messageIds: ["heavy-1"] }, { timeoutMs: 100 }), "TIMEOUT");
    const recovery = instance.context(file, { messageIds: ["anchor"] });
    await expired;
    assert.deepEqual(related((await recovery).neighbors), ["before", "after"]);
    await instance.close();
    assert.equal(instance.status().timers, 0);
    assert.deepEqual(fs.readdirSync(path.dirname(heavy)).filter((name) => name.endsWith(".tmp")), []);
  });

  console.log(JSON.stringify({ status: "PASS", checks, scope: "temporary synthetic data only", maxExpansionRecords: 12, maxExpansionAttempts: 48 }));
} finally {
  await Promise.all(services.map((instance) => instance.close()));
  fs.rmSync(root, { recursive: true, force: true });
}
