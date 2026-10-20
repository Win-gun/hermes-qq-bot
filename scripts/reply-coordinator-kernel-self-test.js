import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ReplyCoordinator } from "../src/reply-coordinator.js";

// Synthetic routing/policy harness only: no bridge, account state, network or sends.
const config = {
  responseQueue: {
    enabled: true, minDelayMs: 0,
    liveContext: { enabled: true, settleMs: 0, windowMs: 20_000, maxRegenerations: 2 }
  }
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("test timed out")), 2000); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function drained(coordinator) {
  await bounded((async () => {
    while (coordinator.states.size) await delay(1);
  })());
}

function input(accountId, messageId, extra = {}) {
  return {
    accountId, conversationId: "group:shared", senderId: "human", mode: "at", direct: true,
    messageIds: [messageId], current: { text: messageId, messageIds: [messageId] },
    execute: async () => ({ sent: true }), ...extra
  };
}

function scoped(owner, conversationId = "group:shared") {
  return { logicalBotId: owner, conversationId };
}

const passed = [];
async function test(name, run) {
  await bounded(run());
  passed.push(name);
}

await test("independent-generation-and-targeted-observe", async () => {
  const coordinator = new ReplyCoordinator({ config });
  const enteredA = deferred();
  const releaseA = deferred();
  let signalA;
  const a = coordinator.enqueue(input("a", "question-a", {
    execute: async ({ job, signal }) => {
      assert.equal(job.conversationId, "group:shared");
      assert.equal(job.logicalBotId, "account:a");
      signalA = signal;
      enteredA.resolve();
      await releaseA.promise; // Intentionally ignores abort.
      return { sent: true };
    }
  }));
  await enteredA.promise;
  const enteredB = deferred();
  const releaseB = deferred();
  let bRuns = 0;
  const b = coordinator.enqueue(input("b", "question-b", {
    execute: async () => {
      bRuns += 1;
      enteredB.resolve();
      if (bRuns === 1) await releaseB.promise;
      return { sent: true };
    }
  }));
  await enteredB.promise;
  assert.equal(coordinator.snapshot().activeCount, 2);
  assert.deepEqual(coordinator.snapshot().active.map((job) => job.logicalBotId).sort(), ["account:a", "account:b"]);
  assert.deepEqual(coordinator.queuedConversationIds(), ["group:shared"]);
  const observed = coordinator.observeMessage(input("b", "b-followup"));
  assert.equal(observed.absorbed, true);
  assert.equal(signalA.aborted, false, "B 的补充不得取消同一人的 A 生成");
  releaseB.resolve();
  assert.equal((await b).sent, true, "B 必须在 A 的模型等待期间完成");
  assert.equal(bRuns, 2, "忽略 abort 的旧 B 结果必须重新生成而不能直接算成功");
  assert.equal(coordinator.snapshot().sent, 1);
  releaseA.resolve();
  assert.equal((await a).sent, true);
  await drained(coordinator);
});

await test("coverage-owner-conversation-and-encoding", async () => {
  const coordinator = new ReplyCoordinator({ config, ownerForAccount: () => "group:failover" });
  const first = input("primary", "same-id", { logicalBotId: "owner\u0000:a", conversationId: "b" });
  assert.equal((await coordinator.enqueue(first)).sent, true);
  assert.equal(coordinator.isCovered(["same-id"], "standby", scoped("owner\u0000:a", "b")), true);
  assert.equal(coordinator.isCovered(["same-id"], "primary", scoped("owner", "a\u0000:b")), false);
  assert.equal((await coordinator.enqueue({ ...first, conversationId: "other-chat" })).sent, true);
  assert.equal((await coordinator.enqueue({ ...first, logicalBotId: "other-owner" })).sent, true);
  assert.equal((await coordinator.enqueue({ ...first, accountId: "standby" })).reason, "covered");
  assert.equal((await coordinator.enqueue(input("primary", "carrier-id"))).sent, true);
  assert.equal((await coordinator.enqueue(input("standby", "carrier-id"))).reason, "covered", "同一逻辑 owner 的覆盖不随物理载体切换");
  assert.equal(coordinator.isCovered(["carrier-id"], "standby"), true, "保留旧双参数查询");
  assert.equal(coordinator.isCovered(["carrier-id"], "standby", { conversationId: "different" }), false);
  await drained(coordinator);
});

await test("explicit-captured-owner-and-collision-safe-lanes", async () => {
  let liveOwner = "account:remapped";
  const coordinator = new ReplyCoordinator({ config, ownerForAccount: () => liveOwner });
  const entered = deferred();
  const release = deferred();
  let oldSignal;
  const old = coordinator.enqueue(input("carrier", "captured", {
    logicalBotId: "group:a", conversationId: "b:c",
    execute: async ({ signal }) => { oldSignal = signal; entered.resolve(); await release.promise; return { sent: true }; }
  }));
  await entered.promise;
  // Both tuples would collide under a naive colon-joined key.
  const peer = coordinator.enqueue(input("carrier", "collision-peer", {
    logicalBotId: "group:a:b", conversationId: "c"
  }));
  assert.equal((await peer).sent, true);
  liveOwner = "group:new-route";
  assert.equal(coordinator.observeMessage(input("carrier", "unscoped", { conversationId: "b:c" })).absorbed, false);
  assert.equal(coordinator.dropSenderJobs("b:c", "human", "unscoped", "carrier"), 0);
  assert.equal(oldSignal.aborted, false);
  assert.equal(coordinator.dropSenderJobs("b:c", "human", "captured-scope", "carrier", "group:a"), 1);
  assert.equal((await old).reason, "captured-scope");
  release.resolve();
  await drained(coordinator);
  assert.equal(coordinator.snapshot().sent, 1);
  assert.equal(coordinator.isCovered(["captured"], "carrier", scoped("group:a", "b:c")), false);
});

await test("same-owner-serial-strict-account-and-priority", async () => {
  const coordinator = new ReplyCoordinator({ config, ownerForAccount: () => "group:one" });
  const entered = deferred();
  const release = deferred();
  const order = [];
  const active = coordinator.enqueue(input("", "no-account", {
    execute: async () => { entered.resolve(); await release.promise; order.push("active"); return { sent: true }; }
  }));
  await entered.promise;
  const low = coordinator.enqueue(input("carrier", "low", {
    senderId: "second-human", mode: "implicit", direct: false,
    execute: async () => { order.push("low"); return { sent: true }; }
  }));
  const high = coordinator.enqueue(input("carrier", "high", {
    execute: async () => { order.push("high"); return { sent: true }; }
  }));
  assert.equal(coordinator.observeMessage(input("carrier", "cannot-wildcard")).absorbed, true, "只能合并同账号 pending");
  assert.equal(coordinator.snapshot().active[0].mergedMessages, 1, "空账号不再充当通配符");
  assert.equal(coordinator.snapshot().pending, 2);
  assert.equal(coordinator.dropSenderJobs("group:shared", "human", "carrier-only", "carrier"), 1);
  assert.equal((await high).skipped, true);
  assert.equal(coordinator.snapshot().active[0].accountId, "");
  const next = coordinator.enqueue(input("carrier", "next", {
    execute: async () => { order.push("next"); return { sent: true }; }
  }));
  release.resolve();
  await Promise.all([active, low, next]);
  assert.deepEqual(order, ["active", "next", "low"]);
  await drained(coordinator);
});

await test("drop-sender-only-target-lane-and-late-result", async () => {
  const warnings = [];
  const coordinator = new ReplyCoordinator({ config, warn: (message) => warnings.push(message) });
  const release = deferred();
  const entered = deferred();
  const a = coordinator.enqueue(input("a", "drop-a", {
    execute: async () => { entered.resolve(); await release.promise; return { sent: true }; }
  }));
  await entered.promise;
  const b = coordinator.enqueue(input("b", "keep-b"));
  assert.equal(coordinator.dropSenderJobs("group:shared", "human", "voice", "a"), 1);
  assert.equal(coordinator.dropSenderJobs("group:shared", "human", "voice", "a"), 0);
  assert.deepEqual(await a, { ok: true, skipped: true, reason: "voice" }, "活动调用应立即结算，不依赖 execute 配合");
  assert.equal((await b).sent, true);
  release.resolve();
  await drained(coordinator);
  assert.equal(coordinator.snapshot().sent, 1);
  assert.equal(coordinator.isCovered(["drop-a"], "a", { conversationId: "group:shared" }), false);
  assert.equal(coordinator.snapshot().dropped, 1);
  assert.deepEqual(warnings, []);
});

await test("refresh-preserves-pending-isolates-peer-and-retries", async () => {
  const warnings = [];
  const coordinator = new ReplyCoordinator({ config, warn: (message) => warnings.push(message) });
  const entered = deferred();
  const release = deferred();
  let runs = 0;
  let revisions = [];
  const a = coordinator.enqueue(input("a", "policy-a", {
    execute: async ({ revision, signal }) => {
      runs += 1;
      revisions.push(revision);
      if (runs === 1) {
        entered.resolve();
        await release.promise;
        assert.equal(signal.aborted, true);
      }
      return { sent: true };
    }
  }));
  await entered.promise;
  const pending = coordinator.enqueue(input("a", "pending", { senderId: "other-human" }));
  const peerEntered = deferred();
  const peerRelease = deferred();
  let peerSignal;
  const peer = coordinator.enqueue(input("b", "peer", {
    execute: async ({ signal }) => { peerSignal = signal; peerEntered.resolve(); await peerRelease.promise; return { sent: true }; }
  }));
  await peerEntered.promise;
  assert.deepEqual(coordinator.refreshLogicalBot("account:a"), { refreshed: 1, dropped: 0, pending: 1 });
  assert.equal(peerSignal.aborted, false);
  release.resolve();
  assert.equal((await a).regenerationCount, 1);
  assert.equal((await pending).sent, true);
  assert.deepEqual(revisions, [0, 1]);
  assert.equal(coordinator.snapshot().sent, 2, "被刷新取消但返回 sent 的旧生成不计成功");
  peerRelease.resolve();
  await peer;
  await drained(coordinator);
  assert.deepEqual(warnings, []);
  assert.deepEqual(coordinator.refreshLogicalBot("absent"), { refreshed: 0, dropped: 0, pending: 0 });
});

await test("refresh-budget-exhausted-drops-without-model-error", async () => {
  const warnings = [];
  const coordinator = new ReplyCoordinator({
    config: { responseQueue: { minDelayMs: 0, liveContext: { settleMs: 0, maxRegenerations: 1 } } },
    warn: (message) => warnings.push(message)
  });
  const firstEntered = deferred();
  const secondEntered = deferred();
  const firstRelease = deferred();
  const secondRelease = deferred();
  let runs = 0;
  const active = coordinator.enqueue(input("a", "stale", {
    execute: async () => {
      runs += 1;
      if (runs === 1) { firstEntered.resolve(); await firstRelease.promise; }
      else { secondEntered.resolve(); await secondRelease.promise; throw new Error("late ignored-abort failure"); }
      return { sent: true };
    }
  }));
  await firstEntered.promise;
  coordinator.refreshLogicalBot("account:a");
  firstRelease.resolve();
  await secondEntered.promise;
  const pending = coordinator.enqueue(input("a", "still-pending", { senderId: "other-human" }));
  assert.deepEqual(coordinator.refreshLogicalBot("account:a"), { refreshed: 0, dropped: 1, pending: 1 });
  assert.deepEqual(await active, { ok: true, skipped: true, reason: "policy-updated" });
  assert.deepEqual(coordinator.refreshLogicalBot("account:a"), { refreshed: 0, dropped: 0, pending: 1 });
  secondRelease.resolve();
  assert.equal((await pending).sent, true);
  await drained(coordinator);
  assert.equal(runs, 2);
  assert.equal(coordinator.snapshot().regenerated, 1);
  assert.equal(coordinator.snapshot().sent, 1);
  assert.equal(coordinator.isCovered(["stale"], "a"), false);
  assert.deepEqual(warnings, []);
});

await test("refresh-uses-updated-regeneration-budget", async () => {
  const liveConfig = { minDelayMs: 0, liveContext: { settleMs: 0, maxRegenerations: 0 } };
  const coordinator = new ReplyCoordinator({ config: () => liveConfig });
  const entered = deferred();
  const release = deferred();
  let runs = 0;
  const active = coordinator.enqueue(input("a", "updated-budget", {
    execute: async () => {
      runs += 1;
      if (runs === 1) { entered.resolve(); await release.promise; }
      return { sent: true };
    }
  }));
  await entered.promise;
  liveConfig.liveContext.maxRegenerations = 1;
  assert.deepEqual(coordinator.refreshLogicalBot("account:a"), { refreshed: 1, dropped: 0, pending: 0 });
  release.resolve();
  assert.equal((await active).regenerationCount, 1);
  assert.equal(runs, 2);
  assert.equal(coordinator.snapshot().sent, 1);
  await drained(coordinator);
});

await test("same-sender-regeneration-limit-keeps-next-question", async () => {
  const coordinator = new ReplyCoordinator({ config });
  const entered = [deferred(), deferred(), deferred()];
  const release = [deferred(), deferred(), deferred()];
  let runs = 0;
  const active = coordinator.enqueue(input("a", "fragment-0", {
    execute: async () => {
      const attempt = runs++;
      entered[attempt].resolve();
      await release[attempt].promise;
      return { sent: true };
    }
  }));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await entered[attempt].promise;
    assert.equal(coordinator.observeMessage(input("a", `fragment-${attempt + 1}`)).absorbed, true);
    release[attempt].resolve();
  }
  await entered[2].promise;
  assert.equal(coordinator.observeMessage(input("a", "next-question")).absorbed, false);
  const next = coordinator.enqueue(input("a", "next-question"));
  assert.equal(coordinator.snapshot().pending, 1);
  release[2].resolve();
  assert.equal((await active).regenerationCount, 2);
  assert.equal((await next).sent, true);
  assert.equal(coordinator.snapshot().regenerated, 2);
  assert.equal(coordinator.snapshot().sent, 2);
  await drained(coordinator);
});

await test("route-invalidation-drops-all-own-lanes-not-peer", async () => {
  const routes = new Map([["old", "group:route"], ["new", "group:route"], ["peer", "account:peer"]]);
  const coordinator = new ReplyCoordinator({ config, ownerForAccount: (id) => routes.get(id) });
  const entered = deferred();
  const release = deferred();
  let oldSignal;
  let pendingRan = false;
  const old = coordinator.enqueue(input("old", "old-carrier", {
    execute: async ({ signal }) => { oldSignal = signal; entered.resolve(); await release.promise; return { sent: true }; }
  }));
  await entered.promise;
  const pending = coordinator.enqueue(input("old", "pending-old", {
    senderId: "other-human", execute: async () => { pendingRan = true; return { sent: true }; }
  }));
  const otherChat = coordinator.enqueue(input("old", "other-old", { conversationId: "group:other" }));
  const peer = coordinator.enqueue(input("peer", "peer-keep"));
  assert.deepEqual(coordinator.invalidateLogicalBot("group:route", "route-changed"), { active: 1, pending: 2, dropped: 3 });
  assert.equal(oldSignal.aborted, true);
  for (const result of await Promise.all([old, pending, otherChat])) assert.equal(result.reason, "route-changed");
  assert.equal((await peer).sent, true);
  assert.deepEqual(coordinator.invalidateLogicalBot("group:route"), { active: 0, pending: 0, dropped: 0 });
  routes.set("old", "account:removed"); // Captured owner must survive mapping changes.
  const replacement = coordinator.enqueue(input("new", "old-carrier"));
  release.resolve();
  assert.equal((await replacement).sent, true);
  await drained(coordinator);
  assert.equal(pendingRan, false);
  assert.equal(coordinator.snapshot().sent, 2);
  assert.equal(coordinator.snapshot().regenerated, 0, "路由失效绝不能重跑旧物理载体");
  assert.equal(coordinator.isCovered(["pending-old"], "new"), false);
});

await test("proactive-preemption-and-multi-conversation-invalidation", async () => {
  const coordinator = new ReplyCoordinator({ config });
  const releases = [deferred(), deferred(), deferred()];
  const entries = [deferred(), deferred(), deferred()];
  const signals = [];
  const jobs = [
    { account: "a", conversation: "chat:1" },
    { account: "a", conversation: "chat:2" },
    { account: "b", conversation: "chat:1" }
  ].map(({ account, conversation }, index) => coordinator.enqueue(input(account, `proactive-${index}`, {
    conversationId: conversation, mode: "proactive", direct: false,
    execute: async ({ signal }) => {
      signals[index] = signal;
      entries[index].resolve();
      await releases[index].promise;
      return { sent: true };
    }
  })));
  await Promise.all(entries.map((entry) => entry.promise));
  const direct = coordinator.enqueue(input("b", "direct-peer", { conversationId: "chat:1", senderId: "another-human" }));
  assert.equal(signals[2].aborted, true);
  assert.equal(signals[0].aborted, false, "B 的直接问题不能抢占 A 的主动回复");
  assert.deepEqual(coordinator.invalidateLogicalBot("account:a"), { active: 2, pending: 0, dropped: 2 });
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, true);
  for (const result of await Promise.all(jobs)) assert.equal(result.skipped, true);
  releases.forEach((release) => release.resolve());
  assert.equal((await direct).sent, true);
  await drained(coordinator);
  assert.equal(coordinator.snapshot().sent, 1);
  assert.equal(coordinator.covered.size, 1);
});

await test("refresh-zero-budget-and-invalidate-before-start-cleanup", async () => {
  const coordinator = new ReplyCoordinator({ config: { minDelayMs: 0, liveContext: { maxRegenerations: 0 } } });
  let executed = false;
  const queued = coordinator.enqueue(input("a", "never-start", {
    execute: async () => { executed = true; return { sent: true }; }
  }));
  assert.deepEqual(coordinator.invalidateLogicalBot("account:a"), { active: 0, pending: 1, dropped: 1 });
  assert.equal((await queued).skipped, true);
  assert.equal(executed, false);
  assert.equal(coordinator.states.size, 0);
  const entered = deferred();
  const release = deferred();
  const active = coordinator.enqueue(input("a", "zero-budget", {
    execute: async () => { entered.resolve(); await release.promise; return { sent: true }; }
  }));
  await entered.promise;
  assert.equal(coordinator.refreshLogicalBot("account:a").dropped, 1);
  assert.equal((await active).skipped, true);
  release.resolve();
  await drained(coordinator);
  assert.equal(coordinator.snapshot().sent, 0);
  assert.equal(coordinator.covered.size, 0);
});

await test("owner-transition-recovers-only-bounded-unsent-direct-intents", async () => {
  const coordinator = new ReplyCoordinator({ config });
  const entered = deferred(), release = deferred();
  let aborted, generations = 0;
  const rebaseRuntime = () => true;
  const execute = async ({ job, signal }) => {
    generations += 1;
    if (job.logicalBotId === "account:a") {
      aborted = signal; entered.resolve(); await release.promise;
    }
    return { sent: true };
  };
  const old = coordinator.enqueue(input("a", "direct-handoff", { rebaseRuntime, execute }));
  await entered.promise;
  const result = coordinator.invalidateLogicalBot("account:a", "mode-change", { recoverUnsent: true });
  assert.equal(result.intents.length, 1);
  assert.equal(result.intents[0].ownerHandoffs, 1);
  assert.equal(result.intents[0].accountId, "a");
  assert.equal(result.intents[0].controller, undefined);
  assert.equal(aborted.aborted, true);
  assert.equal((await old).skipped, true);
  const fresh = coordinator.enqueue({ ...result.intents[0], logicalBotId: "group:new" });
  release.resolve();
  assert.equal((await fresh).sent, true);
  await drained(coordinator);
  assert.equal(generations, 2);
  assert.equal(coordinator.snapshot().sent, 1);
  assert.equal(coordinator.isCovered(["direct-handoff"], "a", scoped("account:a")), false);

  for (const [label, unsafe] of [
    ["sent", { deliveryStarted: true }], ["search-on-wire", { preReplyStarted: true }], ["acknowledged-search", { preReplySent: true }],
    ["web", { mode: "web" }], ["command", { mode: "command" }],
    ["proactive", { mode: "active", direct: false }], ["budget", { ownerHandoffs: 2 }],
    ["no-lease", { rebaseRuntime: undefined }]
  ]) {
    const pending = coordinator.enqueue(input("a", `no-replay-${label}`, { rebaseRuntime, ...unsafe }));
    if (unsafe.preReplySent) coordinator.state("group:shared", "account:a").pending[0].preReplySent = true;
    const cancelled = coordinator.invalidateLogicalBot("account:a", "mode-change", { recoverUnsent: true });
    assert.equal(cancelled.intents.length, 0, label);
    assert.equal((await pending).skipped, true);
  }
  await drained(coordinator);
});

console.log(JSON.stringify({ ok: true, tests: passed.length, passed }));
