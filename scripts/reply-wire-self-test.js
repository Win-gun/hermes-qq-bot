import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { ReplyCoordinator } from "../src/reply-coordinator.js";
import { GroupSendCoordinator } from "../src/account-delivery.js";
import { replyDeliveryConfig } from "../src/reply-execution.js";

const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("synthetic wire test timeout"); await pause(1); }
}
const config = (delay = 0) => ({ responseQueue: { enabled: true, minDelayMs: delay,
  liveContext: { enabled: true, settleMs: 0, windowMs: 20000, maxRegenerations: 2 } } });
const input = (id, execute) => ({ conversationId: "g", accountId: "a", senderId: "human", mode: "at", direct: true,
  messageIds: [id], currentMessages: [{ text: id, messageIds: [id] }], execute });

// A final draft waits behind another account's send. New input must invalidate
// that queued payload at the actual wire boundary, not merely its model call.
{
  const gate = new GroupSendCoordinator({ minDelayMs: () => 0 });
  const release = deferred(), entered = deferred(), sent = [];
  const blocker = gate.dispatch("g", () => {}, () => { entered.resolve(); return release.promise; });
  await entered.promise;
  const coordinator = new ReplyCoordinator({ config: config() });
  let executions = 0;
  const pending = coordinator.enqueue(input("m1", async ({ job, signal, revision }) => {
    executions += 1;
    const delivery = replyDeliveryConfig({}, job, signal, revision);
    await gate.dispatch("g", () => {
      if (!delivery.__deliveryGuard()) throw Object.assign(new Error("old draft cancelled"), { name: "AbortError" });
    }, () => {
      delivery.__deliveryStarted();
      sent.push(job.currentMessages.map((item) => item.text));
    });
    return { sent: true };
  }));
  await until(() => executions === 1);
  assert.equal(coordinator.observeMessage({ conversationId: "g", accountId: "a", senderId: "human", direct: true,
    messageIds: ["m2"], current: { text: "m2", messageIds: ["m2"] } }).absorbed, true);
  release.resolve(); await blocker; await pending;
  assert.deepEqual(sent, [["m1", "m2"]]);
  assert.equal(executions, 2);
}

// Follow-ups after transmission (including ACK wait and the spacing interval)
// are new questions. They cannot disappear into an already sent active job.
for (const acknowledgeLater of [false, true]) {
  const coordinator = new ReplyCoordinator({ config: config(70) });
  const sent = [], ack = deferred();
  const first = coordinator.enqueue(input("first", async ({ job, signal, revision }) => {
    const delivery = replyDeliveryConfig({}, job, signal, revision);
    delivery.__deliveryStarted(); sent.push("first");
    if (acknowledgeLater) await ack.promise;
    return { sent: true };
  }));
  await until(() => sent.length === 1);
  const observed = coordinator.observeMessage({ conversationId: "g", accountId: "a", senderId: "human", direct: true,
    messageIds: ["next"], current: { text: "next", messageIds: ["next"] } });
  assert.equal(observed.absorbed, false);
  assert.equal(coordinator.isCovered(["next"], "a", { conversationId: "g" }), false);
  const next = coordinator.enqueue(input("next", async () => { sent.push("next"); return { sent: true }; }));
  coordinator.refreshLogicalBot("account:a", "policy-updated-after-wire");
  ack.resolve(); await first; await next;
  assert.deepEqual(sent, ["first", "next"]);
  assert.equal(coordinator.metrics.merged, 0);
  assert.equal(coordinator.metrics.sent, 2);
}

// An ambiguous outcome after a wire attempt must not trigger regeneration.
{
  const coordinator = new ReplyCoordinator({ config: config() });
  let attempts = 0;
  const outcome = await coordinator.enqueue(input("uncertain", async ({ job, signal, revision }) => {
    replyDeliveryConfig({}, job, signal, revision).__deliveryStarted();
    attempts += 1;
    return { retry: true };
  }));
  assert.equal(attempts, 1);
  assert.equal(outcome.deliveryUnconfirmed, true);
}
console.log("reply wire: queued cancellation, ACK/spacing follow-ups and no uncertain delivery replay passed");
