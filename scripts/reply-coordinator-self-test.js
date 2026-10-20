import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ReplyCoordinator } from "../src/reply-coordinator.js";

const config = {
  responseQueue: {
    enabled: true,
    minDelayMs: 0,
    liveContext: {
      enabled: true,
      windowMs: 20_000,
      settleMs: 5,
      maxRegenerations: 2,
      maxMergedMessages: 8,
      cancelProactiveOnDirect: true
    }
  }
};

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

const coordinator = new ReplyCoordinator({ config: () => config });
let runs = 0;
let sent = 0;
const first = coordinator.enqueue({
  conversationId: "group:1",
  senderId: "u1",
  mode: "at",
  direct: true,
  messageIds: ["m1"],
  current: { user_id: "u1", text: "第一段", at: Date.now() },
  execute: async ({ job, signal, revision }) => {
    runs += 1;
    await abortableDelay(30, signal);
    if (job.contextRevision !== revision) return { retry: true };
    sent += 1;
    return { sent: true, text: job.currentMessages.map((item) => item.text).join("+") };
  }
});
await delay(8);
const absorbed = coordinator.observeMessage({
  conversationId: "group:1",
  senderId: "u1",
  messageIds: ["m2"],
  direct: true,
  current: { user_id: "u1", text: "第二段", at: Date.now() }
});
assert.equal(absorbed.absorbed, true, "同一人的临近补充应合并进正在生成的回复");
const firstResult = await first;
assert.equal(firstResult.sent, true);
assert.equal(runs, 2, "旧生成应取消并只重新生成一次");
assert.equal(sent, 1, "合并消息最终只发送一次");
assert.equal(coordinator.snapshot().merged, 1);

const order = [];
const slow = coordinator.enqueue({
  conversationId: "group:2",
  senderId: "u1",
  mode: "at",
  direct: true,
  messageIds: ["a1"],
  current: { user_id: "u1", text: "问题一", at: Date.now() },
  execute: async () => { await delay(15); order.push("u1"); return { sent: true }; }
});
const other = coordinator.enqueue({
  conversationId: "group:2",
  senderId: "u2",
  mode: "at",
  direct: true,
  messageIds: ["a2"],
  current: { user_id: "u2", text: "问题二", at: Date.now() },
  execute: async () => { order.push("u2"); return { sent: true }; }
});
await Promise.all([slow, other]);
assert.deepEqual(order, ["u1", "u2"], "不同用户的直接问题必须分别处理且不混并");

let proactiveSent = false;
const proactive = coordinator.enqueue({
  conversationId: "group:3",
  senderId: "u3",
  mode: "proactive",
  direct: false,
  messageIds: ["p1"],
  current: { user_id: "u3", text: "普通讨论", at: Date.now() },
  execute: async ({ signal }) => { await abortableDelay(40, signal); proactiveSent = true; return { sent: true }; }
});
await delay(5);
const direct = coordinator.enqueue({
  conversationId: "group:3",
  senderId: "u4",
  mode: "at",
  direct: true,
  messageIds: ["p2"],
  current: { user_id: "u4", text: "@bot 直接问题", at: Date.now() },
  execute: async () => ({ sent: true })
});
await Promise.all([proactive, direct]);
assert.equal(proactiveSent, false, "直接问题应取消尚未发送的主动插话");
assert.ok(coordinator.snapshot().dropped >= 1);

const peerCoordinator = new ReplyCoordinator({ config: () => config });
const peerSent = [];
const toPrimary = peerCoordinator.enqueue({
  conversationId: "group:peer", senderId: "u1", accountId: "primary", mode: "at", direct: true,
  messageIds: ["same-qq-message"], current: { user_id: "u1", text: "@甲 你好" },
  execute: async () => { peerSent.push("primary"); return { sent: true }; }
});
await toPrimary;
const toSecondary = peerCoordinator.enqueue({
  conversationId: "group:peer", senderId: "u1", accountId: "standby-a", mode: "at", direct: true,
  messageIds: ["same-qq-message"], current: { user_id: "u1", text: "@甲 @乙 你好" },
  execute: async () => { peerSent.push("standby-a"); return { sent: true }; }
});
await toSecondary;
assert.deepEqual(peerSent, ["primary", "standby-a"], "同一条 QQ 消息明确点名两个独立 bot 时，不应跨账号去重");
let releaseFirstPeer;
const firstPeerGate = new Promise((resolve) => { releaseFirstPeer = resolve; });
const firstPeer = peerCoordinator.enqueue({
  conversationId: "group:peer-2", senderId: "u1", accountId: "primary", mode: "at", direct: true,
  messageIds: ["peer-a"], current: { user_id: "u1", text: "@甲 问题一" },
  execute: async () => { await firstPeerGate; peerSent.push("primary-2"); return { sent: true }; }
});
const secondPeer = peerCoordinator.enqueue({
  conversationId: "group:peer-2", senderId: "u1", accountId: "standby-a", mode: "at", direct: true,
  messageIds: ["peer-b"], current: { user_id: "u1", text: "@乙 问题二" },
  execute: async () => { peerSent.push("standby-2"); return { sent: true }; }
});
await secondPeer;
releaseFirstPeer();
await Promise.all([firstPeer, secondPeer]);
assert.deepEqual(peerSent.slice(-2), ["standby-2", "primary-2"], "独立 bot 应并行生成，同一人的问题不能跨 bot 合并");

console.log(JSON.stringify({ ok: true, runs, sent, order, peerSent, metrics: coordinator.snapshot() }));
