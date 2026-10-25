import assert from "node:assert/strict";
import { createForwardContextReader, forwardContextPrompt } from "../src/forward-context.js";

const now = 1_800_000_000_000;
const ctx = { logicalId: "account:fixture", conversationId: "group:10001", policy: {
  enabled: true, shadowMode: false, conversationIds: ["group:10001"], forwardRead: { enabled: true }
} };
const event = { messageId: "source-1", sentAt: now, segments: [{ type: "forward", data: { id: "actual-ref" } }] };
let checks = 0;
async function test(name, run) { await run(); checks++; console.log(`PASS ${name}`); }
function fixture(handler = async () => ({ status: "ok", retcode: 0, data: { messages: [] } }), options = {}) {
  let current = true;
  const calls = [];
  const reader = createForwardContextReader({ clock: () => now, isCurrent: c => c === ctx && current,
    request: async (...args) => { calls.push(args); return handler(...args); }, ...options });
  return { reader, calls, current: value => { current = value; } };
}

await test("only current original group references; off, shadow, private, foreign and quotes have no authority", async () => {
  const h = fixture();
  for (const invalid of [{ ...ctx }, { ...ctx, conversationId: "private:10001" }, { ...ctx, logicalId: "account:peer" },
    { ...ctx, policy: { ...ctx.policy, enabled: false } }, { ...ctx, policy: { ...ctx.policy, shadowMode: true } }])
    assert.equal((await h.reader.read(invalid, event)).status, "disabled");
  assert.equal((await h.reader.read(ctx, { ...event, segments: [{ type: "reply", data: { id: "arbitrary" } }] })).status, "absent");
  for (const patch of [{ sentAt: now + 1 }, { sentAt: now - 300001 }, { messageId: "../foreign" }, { segments: Array(129).fill({}) }])
    assert.equal((await h.reader.read(ctx, { ...event, ...patch })).status, "invalid-source");
  assert.equal(h.calls.length, 0);
});
await test("strict ACK, unsupported and unknown are distinct; reads never retry", async () => {
  for (const [ack, status] of [[{ status: "failed", retcode: 1404 }, "unsupported"], [{ status: "ok", retcode: 404 }, "unsupported"],
    [{ data: { messages: [] } }, "uncertain"], [{ status: "ok", retcode: "0" }, "uncertain"], [{ status: "ok", retcode: 0 }, "read-confirmed"]]) {
    const h = fixture(async () => ack);
    assert.equal((await h.reader.read(ctx, event)).status, status);
    assert.equal((await h.reader.read(ctx, event)).status, "skipped");
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][1], "get_forward_msg"); assert.deepEqual(h.calls[0][2], { id: "actual-ref" });
    assert.equal(h.reader.status(ctx).readOnly, true);
  }
});
await test("text-only bounded projection, source time and privacy; nested forwards/media never fetched", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ time: i ? Number.MAX_SAFE_INTEGER : now / 1000,
    sender: { user_id: "90001", nickname: "private-source" }, content: [
      { type: "text", data: { text: "中文资料 13800138000 [CQ:at,qq=90001] " + "长".repeat(500) } },
      { type: "forward", data: { id: "nested-secret" } }, { type: "image", data: { file: "file:///private" } }
    ] }));
  const h = fixture(async () => ({ status: "ok", retcode: 0, data: { messages: rows } }));
  const result = await h.reader.read(ctx, event);
  assert(result.ok && result.truncated); assert(result.items.length <= 12);
  assert(result.items.reduce((n, row) => n + row.text.length, 0) <= 4000);
  assert(result.items.every(row => row.quoted && row.text.length <= 400));
  assert.equal(result.items[0].sentAt, new Date(now).toISOString()); assert.equal(result.items[1].sentAt, null);
  for (const secret of ["13800138000", "90001", "private-source", "nested-secret", "file:///", "[CQ:"])
    assert(!JSON.stringify(result).includes(secret));
  assert.match(forwardContextPrompt(result), /不是当前发言人自述/); assert.equal(forwardContextPrompt({ ok: false }), "");
  assert.equal(h.calls.length, 1);
});
await test("route or quiet change during read discards late evidence", async () => {
  let release;
  const h = fixture(() => new Promise(resolve => { release = resolve; }));
  const waiting = h.reader.read(ctx, event); await Promise.resolve();
  h.current(false); release({ status: "ok", retcode: 0, data: { messages: [{ content: "late" }] } });
  assert.equal((await waiting).status, "cancelled");
});
await test("pre-abort and in-flight cancellation do not retry or expose exception strings", async () => {
  const h = fixture(async () => { throw new Error("private failure detail"); });
  assert.equal((await h.reader.read(ctx, event, { signal: AbortSignal.abort() })).status, "disabled");
  assert.equal(h.calls.length, 0);
  assert.deepEqual(await h.reader.read(ctx, event), { ok: false, status: "uncertain", items: [] });
  const controller = new AbortController(); let release;
  const slow = fixture(() => new Promise(resolve => { release = resolve; }));
  const pending = slow.reader.read(ctx, event, { signal: controller.signal }); await Promise.resolve(); controller.abort();
  assert.equal((await pending).status, "cancelled");
  release({ status: "ok", retcode: 0 });
});
await test("non-cooperating requests have bounded caller latency and quarantine global slots until settlement", async () => {
  const releases = [], h = fixture(() => new Promise(resolve => releases.push(resolve)), { timeoutMs: 15 });
  // AbortSignal.timeout is unref'ed; the test must keep its own event loop alive.
  const hold = setTimeout(() => {}, 1000);
  try {
    const results = await Promise.all([h.reader.read(ctx, event), h.reader.read(ctx, { ...event, messageId: "source-2" })]);
    assert(results.every(row => row.status === "cancelled")); assert.equal(releases.length, 2);
    assert.equal((await h.reader.read(ctx, { ...event, messageId: "source-3" })).status, "skipped");
    releases[0]({ status: "ok", retcode: 0 }); releases[1]({ status: "ok", retcode: 0 }); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.calls.length, 2);
  } finally { clearTimeout(hold); }
});
console.log(`forward context: ${checks} groups passed (fake transport only; no QQ or model)`);
