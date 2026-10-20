import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { searchArchiveRecords } from "../src/archive-search-index.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-search-index-test-"));
let checks = 0;
const identity = (record) => record;
const raw = { sanitizeRecord: identity, policyKey: "test-raw-v1" };
const digest = (value) => createHash("sha256").update(value).digest("hex");

function test(name, run) {
  run();
  checks += 1;
  console.log(`PASS ${name}`);
}

function fixture(name, records = []) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "messages.jsonl");
  fs.writeFileSync(file, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  return file;
}

function cachePath(file) { return path.join(path.dirname(file), "search-index.json"); }
function cache(file) { return JSON.parse(fs.readFileSync(cachePath(file), "utf8")).data; }
function search(file, options) { return searchArchiveRecords(file, { ...raw, ...options }); }
function ids(records) { return records.map((record) => record.messageId); }
function append(file, record) { fs.appendFileSync(file, `${JSON.stringify(record)}\n`); }
function changeCache(file, change) {
  const data = cache(file);
  change(data);
  fs.writeFileSync(cachePath(file), JSON.stringify({ data, digest: digest(JSON.stringify(data)) }));
}

try {
  let history;
  const old = { messageId: "old-target", senderId: "old-sender", senderName: "早期成员", type: "user_message",
    text: "最初讨论星际量子航行协议，保留表情😀与𠮷字。", time: "2020-01-01T00:00:00.000Z" };
  test("旧目标在尾部1200条及2MiB之外仍可检索", () => {
    history = fixture("history", [old]);
    const fd = fs.openSync(history, "a");
    try {
      for (let i = 0; i < 1600; i += 1) {
        fs.writeSync(fd, `${JSON.stringify({ messageId: `recent-${i}`, senderId: "recent", text: `日常内容${"x".repeat(1700)}` })}\n`);
      }
    } finally { fs.closeSync(fd); }
    assert.ok(fs.statSync(history).size > 2 * 1024 * 1024);
    assert.deepEqual(search(history, { terms: ["际量子航"] }), [old]);
    assert.deepEqual(search(history, { senderIds: ["old-sender"] }), [old]);
    assert.deepEqual(search(history, { messageIds: ["old-target"] }), [old]);
    assert.equal(cache(history).rows.length, 1601);
  });

  test("任意中文子串、单汉字、补充平面汉字及ASCII大小写子串", () => {
    const file = fixture("substrings", [{ messageId: 42, senderId: 7, text: "人工智能大模型𠮷星 MixHTTPServer_v2.5" }]);
    for (const term of ["工智能大", "型", "𠮷", "型𠮷星", "httpserver", "Server_v2", "v2.5"]) {
      assert.deepEqual(ids(search(file, { terms: [term] })), [42]);
    }
    assert.deepEqual(ids(search(file, { senderIds: [7] })), [42]);
    assert.deepEqual(ids(search(file, { messageIds: ["42"] })), [42]);
  });

  test("无选择器和无匹配不泄露无关全文", () => {
    assert.deepEqual(search(history, {}), []);
    assert.deepEqual(search(history, { terms: ["完全不存在的内容"] }), []);
    assert.deepEqual(search(history, { terms: [" ", null, ""] }), []);
    assert.deepEqual(search(history, { senderIds: ["missing"], messageIds: ["missing"] }), []);
    assert.deepEqual(search(history, { terms: ["星际"], maxCandidates: 0 }), []);
    assert.deepEqual(searchArchiveRecords(path.join(root, "missing.jsonl"), { terms: ["test"] }), []);
  });

  test("OR选择器和messageId优先；返回原始结构", () => {
    const quoted = { messageId: "priority", senderId: "a", text: "引用旧消息", extra: { preserved: true } };
    const file = fixture("ranking", [quoted, { messageId: "term", text: "关键词" }, { messageId: "sender", senderId: "b", text: "其他" }]);
    assert.deepEqual(search(file, { terms: ["关键词"], senderIds: ["b"], messageIds: ["priority"], maxCandidates: 1 }), [quoted]);
    assert.deepEqual(ids(search(file, { terms: ["关键词"], senderIds: ["b"] })), ["term", "sender"]);
  });

  test("自定义tokenize整词命中优先；不牺牲子串覆盖", () => {
    const file = fixture("tokenizer", [{ messageId: "whole", text: "token foo" }, { messageId: "substring", text: "token foobar" }]);
    const tokenize = (text) => text.match(/[a-z]+/g) || [];
    assert.deepEqual(ids(search(file, { terms: ["foo"], tokenize, maxCandidates: 1 })), ["whole"]);
    assert.deepEqual(ids(search(file, { terms: ["oob"], tokenize })), ["substring"]);
  });

  test("追加只解析新增记录；热查询仅解析候选，不整读JSONL", () => {
    const file = fixture("incremental", [{ messageId: "a", text: "原始事件" }, { messageId: "b", text: "不同事件" }]);
    let sanitizations = 0;
    const sanitizeRecord = (record) => { sanitizations += 1; return record; };
    const options = { terms: ["原始"], sanitizeRecord, policyKey: "counter-v1" };
    searchArchiveRecords(file, options);
    assert.equal(sanitizations, 3, "首次构建两条+返回一条");
    const initialRows = cache(file).rows;
    sanitizations = 0;
    searchArchiveRecords(file, options);
    assert.equal(sanitizations, 1, "热查询只处理命中候选");
    append(file, { messageId: "c", text: "新增事件" });
    sanitizations = 0;
    assert.deepEqual(ids(searchArchiveRecords(file, { ...options, terms: ["新增"] })), ["c"]);
    assert.equal(sanitizations, 2, "增量只处理新行+候选");
    assert.deepEqual(cache(file).rows.slice(0, 2), initialRows);

    const readFileSync = fs.readFileSync;
    const parse = JSON.parse;
    let recordParses = 0;
    fs.readFileSync = function (target, ...args) {
      if (target === file || (typeof target === "number" && fs.fstatSync(target).ino === fs.statSync(file).ino)) {
        throw new Error("JSONL must not be readFileSync'ed");
      }
      return readFileSync.call(this, target, ...args);
    };
    JSON.parse = function (text, ...args) {
      if (String(text).startsWith('{"messageId"')) recordParses += 1;
      return parse.call(this, text, ...args);
    };
    try {
      assert.deepEqual(ids(searchArchiveRecords(file, options)), ["a"]);
      assert.equal(recordParses, 1);
    } finally { fs.readFileSync = readFileSync; JSON.parse = parse; }
  });

  test("截断、同inode同长度覆盖、原子替换和truncate后增长重建", () => {
    const file = fixture("rewrite", [{ messageId: "before", text: "旧档案" }]);
    search(file, { terms: ["旧档案"] });
    fs.truncateSync(file, 0);
    assert.deepEqual(search(file, { terms: ["旧档案"] }), []);
    append(file, { messageId: "same", text: "甲词语" });
    assert.equal(search(file, { terms: ["甲词语"] }).length, 1);
    const beforeSize = fs.statSync(file).size;
    fs.writeFileSync(file, `${JSON.stringify({ messageId: "same", text: "乙词语" })}\n`);
    assert.equal(fs.statSync(file).size, beforeSize);
    assert.equal(search(file, { terms: ["乙词语"] }).length, 1);
    assert.deepEqual(search(file, { terms: ["甲词语"] }), []);
    const replacement = path.join(path.dirname(file), "replacement.jsonl");
    fs.writeFileSync(replacement, `${JSON.stringify({ messageId: "atomic", text: "替换记录" })}\n`);
    fs.renameSync(replacement, file);
    assert.deepEqual(ids(search(file, { terms: ["替换记录"] })), ["atomic"]);
    fs.writeFileSync(file, `${JSON.stringify({ messageId: "regrow", text: `重写增长${"z".repeat(300)}` })}\n`);
    assert.deepEqual(ids(search(file, { terms: ["重写增长"] })), ["regrow"]);
  });

  test("坏行、CRLF、BOM、UTF8跨64KiB边界和无换行尾记录", () => {
    const file = fixture("bytes");
    const prefix = '\uFEFF{"text":"';
    const padding = "p".repeat(65535 - Buffer.byteLength(prefix));
    fs.writeFileSync(file, `${prefix}${padding}跨字节边界😀𠮷","messageId":"boundary"}\r\nnot-json\n\nnull\n[]\n{"text":\n`);
    const final = { messageId: "tail", text: "无换行尾部" };
    fs.appendFileSync(file, JSON.stringify(final));
    assert.deepEqual(ids(search(file, { terms: ["跨字节边界😀𠮷"] })), ["boundary"]);
    assert.deepEqual(search(file, { terms: ["无换行"] }), [final]);
    fs.appendFileSync(file, "\n");
    append(file, { messageId: "after", text: "之后追加" });
    assert.deepEqual(ids(search(file, { terms: ["无换行", "之后追加"] })), ["after", "tail"]);
    assert.equal(cache(file).rows.length, 3, "尾行不得重复索引");
    const incomplete = Buffer.from('{"messageId":"split","text":"半个字符𠮷"}\n');
    const splitAt = incomplete.indexOf(Buffer.from("𠮷")) + 2;
    fs.appendFileSync(file, incomplete.subarray(0, splitAt));
    assert.deepEqual(search(file, { terms: ["半个字符"] }), []);
    fs.appendFileSync(file, incomplete.subarray(splitAt));
    assert.deepEqual(ids(search(file, { terms: ["半个字符𠮷"] })), ["split"]);
  });

  test("损坏JSON、校验失败、非法posting和越界offset都重建", () => {
    const file = fixture("corruption", [{ messageId: "safe", text: "恢复检索" }]);
    search(file, { terms: ["恢复"] });
    fs.writeFileSync(cachePath(file), "{broken");
    assert.deepEqual(ids(search(file, { terms: ["恢复"] })), ["safe"]);
    const damaged = JSON.parse(fs.readFileSync(cachePath(file), "utf8"));
    damaged.data.rows = [];
    fs.writeFileSync(cachePath(file), JSON.stringify(damaged));
    assert.deepEqual(ids(search(file, { terms: ["恢复"] })), ["safe"]);
    changeCache(file, (index) => { index.rows[0][0] = Number.MAX_SAFE_INTEGER; });
    assert.deepEqual(ids(search(file, { terms: ["恢复"] })), ["safe"]);
    changeCache(file, (index) => { index.rows[0][0] = -1; });
    assert.deepEqual(ids(search(file, { terms: ["恢复"] })), ["safe"]);
    changeCache(file, (index) => { index.postings[0][1] = ["__proto__"]; });
    assert.deepEqual(ids(search(file, { terms: ["恢复"] })), ["safe"]);
  });

  test("目录隔离、复制缓存不可串档、缓存符号链接不覆盖外部文件", () => {
    const a = fixture("isolated-a", [{ messageId: "a", text: "独有甲" }]);
    const b = fixture("isolated-b", [{ messageId: "b", text: "独有乙" }]);
    search(a, { terms: ["独有甲"] });
    fs.copyFileSync(cachePath(a), cachePath(b));
    assert.deepEqual(search(b, { terms: ["独有甲"] }), []);
    assert.deepEqual(ids(search(b, { terms: ["独有乙"] })), ["b"]);
    const external = path.join(root, "external.txt");
    fs.writeFileSync(external, "do not modify");
    fs.unlinkSync(cachePath(b));
    fs.symlinkSync(external, cachePath(b));
    assert.deepEqual(ids(search(b, { terms: ["独有乙"] })), ["b"]);
    assert.equal(fs.readFileSync(external, "utf8"), "do not modify");
    assert.equal(fs.lstatSync(cachePath(b)).isSymbolicLink(), false);
  });

  test("默认强制脱敏；自定义回调在词元提取前、返回前均执行", () => {
    const record = { messageId: "privacy", senderId: "123", text: "星际笔记 password=FixtureSecretABC 电话13812345678",
      quotedMessage: { contexts: [{ text: "token=QuotedSecretXYZ", senderName: "甲" }] },
      images: [{ description: "密码 ImageSecretXYZ" }], sources: [{ title: "token=SourceSecretXYZ" }] };
    const file = fixture("privacy", [record]);
    const original = fs.readFileSync(file);
    const safe = searchArchiveRecords(file, { terms: ["星际"] });
    assert.equal(safe.length, 1);
    for (const secret of ["FixtureSecretABC", "13812345678", "QuotedSecretXYZ", "ImageSecretXYZ", "SourceSecretXYZ"]) {
      assert.ok(!JSON.stringify(safe).includes(secret));
      assert.deepEqual(searchArchiveRecords(file, { terms: [secret] }), []);
    }
    assert.deepEqual(fs.readFileSync(file), original, "原始存档不得重写");

    let calls = 0;
    const sanitizedTexts = [];
    const sanitizeRecord = (item) => { calls += 1; return { ...item, text: "安全替代词" }; };
    const tokenize = (text) => { sanitizedTexts.push(text); return ["__proto__", "constructor", text]; };
    const options = { sanitizeRecord, tokenize, policyKey: "custom-private-v1" };
    assert.deepEqual(ids(searchArchiveRecords(file, { ...options, terms: ["安全替代"] })), ["privacy"]);
    assert.equal(calls, 2);
    assert.equal(sanitizedTexts.length, 1);
    assert.ok(!sanitizedTexts[0].includes("FixtureSecretABC"));
    assert.deepEqual(searchArchiveRecords(file, { ...options, terms: ["FixtureSecretABC"] }), []);
    const serialized = fs.readFileSync(cachePath(file), "utf8");
    assert.ok(!serialized.includes("FixtureSecretABC"));
    assert.ok(!serialized.includes("安全替代词"), "缓存只能保存哈希词元、offset和元数据");
    assert.equal(Object.prototype.polluted, undefined);
  });

  test("隐私开关policyKey切换重建；未给key的闭包每次安全重建", () => {
    const file = fixture("policy", [{ messageId: "p", text: "旧存档敏感串FixturePrivate" }]);
    let privacy = false;
    let calls = 0;
    const sanitizer = (record) => { calls += 1; return privacy ? { ...record, text: "[已过滤]" } : record; };
    assert.equal(searchArchiveRecords(file, { terms: ["FixturePrivate"], sanitizeRecord: sanitizer, policyKey: "privacy-off-v1" }).length, 1);
    const offPolicy = cache(file).policy;
    privacy = true;
    calls = 0;
    assert.deepEqual(searchArchiveRecords(file, { terms: ["FixturePrivate"], sanitizeRecord: sanitizer, policyKey: "privacy-on-v1" }), []);
    assert.equal(calls, 1, "换策略必须重新脱敏构建");
    assert.notEqual(cache(file).policy, offPolicy);
    privacy = false;
    assert.equal(searchArchiveRecords(file, { terms: ["FixturePrivate"], sanitizeRecord: sanitizer }).length, 1);
    privacy = true;
    assert.deepEqual(searchArchiveRecords(file, { terms: ["FixturePrivate"], sanitizeRecord: sanitizer }), []);
  });

  test("限制读取候选；二元误匹配不返回；异常向父调用方传播", () => {
    const records = Array.from({ length: 1205 }, (_, i) => ({ messageId: `bounded-${i}`, text: "公共关键词" }));
    const file = fixture("bounded", records);
    let calls = 0;
    const sanitizer = (record) => { calls += 1; return record; };
    const options = { terms: ["公共关键词"], sanitizeRecord: sanitizer, policyKey: "bounded-v1" };
    searchArchiveRecords(file, options);
    calls = 0;
    assert.equal(searchArchiveRecords(file, { ...options, maxCandidates: 3 }).length, 3);
    assert.equal(calls, 3);
    calls = 0;
    assert.equal(searchArchiveRecords(file, { ...options, maxCandidates: 1_000_000 }).length, 1000);
    assert.equal(calls, 1000);
    const falsePositive = fixture("false-positive", [{ text: "甲乙……乙丙" }]);
    assert.deepEqual(search(falsePositive, { terms: ["甲乙丙"] }), []);
    assert.throws(() => searchArchiveRecords(file, { terms: ["公共"], sanitizeRecord: () => { throw new Error("callback-failed"); } }), /callback-failed/);
    assert.throws(() => searchArchiveRecords(file, { terms: ["公共"], sanitizeRecord: async (record) => record }), /synchronous/);
    assert.throws(() => search(file, { terms: ["公共"], tokenize: () => null }), /iterable/);
    assert.throws(() => search(file, { terms: "公共" }), /arrays/);
    assert.throws(() => search(file, { terms: ["公共"], maxCandidates: NaN }), /limit/);
  });

  test("构建读取逐块、有界；大坏行显式报错供父agent回退", () => {
    const file = fixture("chunked", Array.from({ length: 50 }, (_, i) => ({ messageId: i, text: `块扫描${"q".repeat(5000)}` })));
    const readSync = fs.readSync;
    const readFileSync = fs.readFileSync;
    const inode = fs.statSync(file).ino;
    let largestRead = 0;
    fs.readSync = function (fd, buffer, offset, length, position) {
      if (fs.fstatSync(fd).ino === inode) largestRead = Math.max(largestRead, length);
      return readSync.call(this, fd, buffer, offset, length, position);
    };
    fs.readFileSync = function (target, ...args) {
      if (target === file || (typeof target === "number" && fs.fstatSync(target).ino === inode)) throw new Error("whole JSONL read");
      return readFileSync.call(this, target, ...args);
    };
    try {
      assert.equal(search(file, { terms: ["块扫描"], maxCandidates: 1 }).length, 1);
      assert.ok(largestRead <= 64 * 1024);
    } finally { fs.readSync = readSync; fs.readFileSync = readFileSync; }
    const oversized = fixture("oversized");
    fs.writeFileSync(oversized, "x".repeat(8 * 1024 * 1024 + 1));
    assert.throws(() => search(oversized, { terms: ["x"] }), /8 MiB/);
  });

  test("构建中追加或原子替换安全失败，不发布不一致缓存", () => {
    const file = fixture("race", [{ messageId: "r", text: "竞态测试" }]);
    let mutated = false;
    const sanitizeRecord = (record) => {
      if (!mutated) { mutated = true; append(file, { messageId: "later", text: "之后" }); }
      return record;
    };
    assert.throws(() => searchArchiveRecords(file, { terms: ["竞态"], sanitizeRecord, policyKey: "race-v1" }), /changed/);
    assert.equal(fs.existsSync(cachePath(file)), false);
    assert.deepEqual(ids(search(file, { terms: ["竞态"] })), ["r"]);
    const replacing = fixture("replace-race", [{ messageId: "old", text: "原文件" }]);
    let replaced = false;
    assert.throws(() => searchArchiveRecords(replacing, {
      terms: ["原文件"], policyKey: "replace-race-v1",
      sanitizeRecord: (record) => {
        if (!replaced) {
          replaced = true;
          const next = path.join(path.dirname(replacing), "next.jsonl");
          fs.writeFileSync(next, '{"text":"替代文件"}\n');
          fs.renameSync(next, replacing);
        }
        return record;
      }
    }), /changed|replaced/);
    assert.equal(fs.existsSync(cachePath(replacing)), false);
  });

  console.log(JSON.stringify({ status: "PASS", checks, api: "searchArchiveRecords(messagesPath, options)",
    scope: "temporary directories only; no live data or QQ", maxCandidateRecords: 1000,
    defaultCandidateRecords: 200, maxLineBytes: 8 * 1024 * 1024 }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
