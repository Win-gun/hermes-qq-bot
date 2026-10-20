import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TaskRuntime, publicTask, taskOwnedBy } from "../src/task-runtime.js";

// Every real TaskRuntime below is confined to a disposable synthetic state root.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qq-task-owner-test-"));
const runtimes = [];
const gates = [];
const passed = [];
const actor = { userId: "owner", source: "admin" };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const gate = { promise, resolve, reject };
  gates.push(gate);
  return gate;
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("task owner test timed out")), 3000); })
    ]);
  } finally { clearTimeout(timer); }
}

async function waitFor(predicate) {
  await bounded((async () => { while (!predicate()) await delay(1); })());
}

function harness(name, options = {}) {
  const runtime = new TaskRuntime({
    rootDir: path.join(tempRoot, name),
    config: { taskMode: { workspaceBaseDir: "tasks", ownerUserIds: ["owner"] } },
    execute: async () => ({ ok: true, summary: "synthetic result" }),
    notify: async () => true,
    ...options
  });
  runtimes.push(runtime);
  return runtime;
}

function offer(runtime, accountId, extra = {}) {
  return runtime.createOffer({
    accountId, conversationId: "group:shared", groupId: "shared", userId: "human",
    objective: "synthetic task", ...extra
  });
}

function confirm(runtime, task) {
  assert.equal(runtime.confirm(task.id, actor).ok, true);
}

function legacyFixture(name, task) {
  const rootDir = path.join(tempRoot, name);
  const dir = path.join(rootDir, "tasks", task.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "task.json");
  const original = Buffer.from(`${JSON.stringify(task, null, 3)}\n\n`);
  fs.writeFileSync(file, original);
  return { rootDir, dir, file, original, backup: `${file}.pre-logical-owner.bak` };
}

async function test(name, run) {
  await bounded(run());
  passed.push(name);
}

try {
  await test("new-owner-validation-scoped-queries-and-private-task-files", async () => {
    const runtime = harness("new-owner");
    const a = offer(runtime, "a");
    const b = offer(runtime, "b", { logicalBotId: "account:b" });
    const legacy = offer(runtime, "", { conversationId: "private:legacy" });
    assert.equal(a.logicalBotId, "account:a");
    assert.equal(b.logicalBotId, "account:b");
    assert.equal(legacy.logicalBotId, "legacy:default");
    assert.equal(JSON.parse(fs.readFileSync(runtime.taskPath(a.id))).logicalBotId, "account:a");
    assert.throws(() => offer(runtime, "a", { logicalBotId: "account:b" }), /logicalBotId/);
    assert.throws(() => offer(runtime, "a", { logicalBotId: "" }), /logicalBotId/);
    assert.equal(runtime.tasks.size, 3);
    assert.equal(fs.readdirSync(runtime.config().workspaceBaseDir).length, 3, "拒绝不一致 owner 时不得留下任务文件");
    assert.equal(runtime.activeForConversation("group:shared"), a, "保留管理端无 owner 过滤查询");
    assert.equal(runtime.activeForConversation("group:shared", { logicalBotId: "account:b" }), b);
    assert.equal(runtime.activeForConversation("group:shared", { logicalBotId: "" }), undefined);
    assert.deepEqual(runtime.list({ conversationId: "group:shared", logicalBotId: "account:a" }).map((task) => task.id), [a.id]);
    assert.equal(runtime.list({ logicalBotId: "" }).length, 0);
    assert.equal(runtime.list().length, 3);
    assert.equal(taskOwnedBy(a, "account:a"), true);
    assert.equal(taskOwnedBy(a, "account:b"), false);
    assert.equal(taskOwnedBy({ accountId: "" }, "account:b"), false, "空物理账号不得匹配其他 bot");
    assert.equal(taskOwnedBy({}, ""), false);
    assert.equal(runtime.grant(a.id, { type: "read", target: path.join(tempRoot, "private-file") }, actor).ok, true);
    assert.equal(a.grants.length, 1);
    assert.deepEqual(b.grants, [], "授权只能属于单个任务");
    const view = publicTask(a);
    assert.equal(view.logicalBotId, "account:a");
    assert.equal(view.grants[0].target, "private-file");
    assert.equal(a.grants[0].target, path.join(tempRoot, "private-file"));
    assert.equal(fs.statSync(runtime.taskDir(a.id)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(runtime.taskPath(a.id)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(runtime.eventsPath(a.id)).mode & 0o777, 0o600);
  });

  await test("independent-lanes-fill-global-two-and-same-lane-stays-serial", async () => {
    const entered = new Map();
    const releases = new Map();
    const liveLanes = new Set();
    let live = 0;
    let peak = 0;
    const runtime = harness("concurrency", {
      execute: async (task) => {
        const key = JSON.stringify([task.logicalBotId, task.conversationId]);
        assert.equal(liveLanes.has(key), false, "同 owner＋会话只能运行一个任务");
        liveLanes.add(key);
        live += 1;
        peak = Math.max(peak, live);
        assert.ok(live <= 2);
        entered.get(task.id).resolve();
        await releases.get(task.id).promise;
        liveLanes.delete(key);
        live -= 1;
        return { ok: true };
      }
    });
    const tasks = [offer(runtime, "a"), offer(runtime, "a"), offer(runtime, "b"), offer(runtime, "c")];
    for (const task of tasks) { entered.set(task.id, deferred()); releases.set(task.id, deferred()); confirm(runtime, task); }
    await Promise.all([entered.get(tasks[0].id).promise, entered.get(tasks[2].id).promise]);
    assert.equal(runtime.running.size, 2);
    assert.equal(tasks[1].status, "queued", "A 的第二个任务等待，但不能挡住 B");
    assert.equal(tasks[3].status, "queued", "第三个独立 owner 仍受全局 2 槽限制");
    releases.get(tasks[0].id).resolve();
    await waitFor(() => tasks[1].status === "running" || tasks[3].status === "running");
    for (const release of releases.values()) release.resolve();
    await waitFor(() => tasks.every((task) => task.status === "completed") && runtime.running.size === 0);
    assert.equal(peak, 2);
    assert.equal(runtime.controllers.size, 0);
  });

  await test("failover-carriers-share-owner-and-role-reordering-cannot-transfer", async () => {
    const routes = new Map([["first", "group:failover"], ["second", "group:failover"], ["peer", "account:peer"]]);
    const entered = deferred();
    const release = deferred();
    let firstId;
    const executed = [];
    const runtime = harness("failover", {
      ownerForAccount: (id) => routes.get(id),
      execute: async (task) => {
        executed.push(task.id);
        if (task.id === firstId) { entered.resolve(); await release.promise; }
        return { ok: true };
      }
    });
    const first = offer(runtime, "first");
    firstId = first.id;
    const second = offer(runtime, "second");
    confirm(runtime, first);
    confirm(runtime, second);
    await entered.promise;
    assert.equal(runtime.running.size, 1);
    assert.equal(second.status, "queued");
    routes.set("first", "account:new-role");
    routes.set("second", "account:another-role");
    assert.equal(first.logicalBotId, "group:failover");
    assert.equal(second.logicalBotId, "group:failover");
    assert.equal(runtime.list({ logicalBotId: "account:another-role" }).length, 0);
    const reloaded = harness("failover", { ownerForAccount: (id) => routes.get(id) });
    assert.equal(reloaded.get(first.id).logicalBotId, "group:failover");
    assert.equal(reloaded.get(first.id).status, "interrupted");
    assert.equal(reloaded.get(second.id).logicalBotId, "group:failover");
    release.resolve();
    await waitFor(() => second.status === "completed" && runtime.running.size === 0);
    assert.deepEqual(executed, [first.id, second.id]);
  });

  await test("same-owner-different-conversations-have-independent-slots", async () => {
    const release = deferred();
    const runtime = harness("different-conversations", {
      ownerForAccount: () => "group:stable",
      execute: async () => { await release.promise; return { ok: true }; }
    });
    const first = offer(runtime, "carrier-a", { conversationId: "group:one" });
    const second = offer(runtime, "carrier-b", { conversationId: "group:two" });
    confirm(runtime, first);
    confirm(runtime, second);
    await waitFor(() => first.status === "running" && second.status === "running");
    assert.equal(runtime.running.size, 2);
    release.resolve();
    await waitFor(() => first.status === "completed" && second.status === "completed" && runtime.running.size === 0);
  });

  await test("legacy-migration-is-additive-backed-up-private-and-frozen", async () => {
    const originalTask = {
      id: "legacy-one", accountId: "old-carrier", conversationId: "group:shared", status: "offered",
      objective: "legacy fixture", createdAt: "2026-01-01", updatedAt: "2026-01-02",
      grants: [{ type: "read", target: "/synthetic/private", purpose: "legacy grant" }],
      supplements: [{ text: "preserve me" }], unknownExtension: { nested: [1, false, null] }
    };
    const fixture = legacyFixture("migration", originalTask);
    let resolved = 0;
    const runtime = harness("migration", { ownerForAccount: (id) => { resolved += 1; assert.equal(id, "old-carrier"); return "group:stable"; } });
    assert.equal(resolved, 1);
    assert.deepEqual(fs.readFileSync(fixture.backup), fixture.original, "备份必须逐字节保留首次 owner 写入前的原文");
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.file)), { ...originalTask, logicalBotId: "group:stable" });
    for (const file of [fixture.backup, fixture.file]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(fixture.dir).mode & 0o777, 0o700);
    const migratedBytes = fs.readFileSync(fixture.file);
    const reloaded = harness("migration", { ownerForAccount: () => { throw new Error("frozen owner must not be recomputed"); } });
    assert.equal(reloaded.get(originalTask.id).logicalBotId, "group:stable");
    assert.deepEqual(fs.readFileSync(fixture.file), migratedBytes);
    assert.deepEqual(fs.readFileSync(fixture.backup), fixture.original);
    assert.equal(runtime.get(originalTask.id).grants[0].target, "/synthetic/private");
  });

  await test("legacy-active-backup-precedes-interruption-and-never-replays", async () => {
    const original = { id: "legacy-running", accountId: "a", status: "running", conversationId: "group:shared", grants: [] };
    const fixture = legacyFixture("legacy-active", original);
    let executed = false;
    const runtime = harness("legacy-active", { execute: async () => { executed = true; return {}; } });
    assert.deepEqual(fs.readFileSync(fixture.backup), fixture.original);
    const task = runtime.get(original.id);
    assert.equal(task.logicalBotId, "account:a");
    assert.equal(task.status, "interrupted");
    assert.ok(task.interruptedAt);
    assert.equal(runtime.queue.length + runtime.running.size, 0);
    await runtime.pump();
    assert.equal(executed, false);
  });

  await test("migration-backup-failure-and-retry-fail-closed", async () => {
    const original = { id: "legacy-backup", accountId: "a", status: "offered", grants: [] };
    const fixture = legacyFixture("backup-blocked", original);
    fs.mkdirSync(fixture.backup);
    assert.throws(() => harness("backup-blocked"), /backup/);
    assert.deepEqual(fs.readFileSync(fixture.file), fixture.original, "备份失败不得写入 owner");
    fs.rmdirSync(fixture.backup);
    fs.writeFileSync(fixture.backup, "partial prior backup");
    assert.throws(() => harness("backup-blocked"), /backup does not match/);
    assert.deepEqual(fs.readFileSync(fixture.file), fixture.original);
    fs.writeFileSync(fixture.backup, fixture.original);
    const runtime = harness("backup-blocked");
    assert.equal(runtime.get(original.id).logicalBotId, "account:a");
    assert.deepEqual(fs.readFileSync(fixture.backup), fixture.original);
    const linked = legacyFixture("backup-linked", { ...original, id: "legacy-linked" });
    fs.symlinkSync(fixture.backup, linked.backup);
    assert.throws(() => harness("backup-linked"), /not a regular file/);
    assert.deepEqual(fs.readFileSync(linked.file), linked.original);
  });

  await test("unknown-owners-quarantine-no-fallback-and-stay-frozen", async () => {
    let owner;
    let executed = false;
    const runtime = harness("unknown", {
      ownerForAccount: () => owner,
      execute: async () => { executed = true; return { ok: true }; }
    });
    const task = offer(runtime, "missing");
    assert.equal(task.logicalBotId, "unassigned:missing");
    assert.equal(runtime.confirm(task.id, actor).ok, false);
    assert.equal(taskOwnedBy(task, "account:peer"), false);
    assert.throws(() => offer(runtime, "missing", { logicalBotId: "account:peer" }), /logicalBotId/);
    task.status = "queued"; // Defense-in-depth: even a directly queued quarantine cannot execute.
    runtime.queue.push(task.id);
    runtime.persist(task);
    await runtime.pump();
    await runtime.run(task);
    assert.equal(executed, false);
    assert.equal(runtime.running.size + runtime.controllers.size, 0);
    owner = "account:now-known";
    const reloaded = harness("unknown", { ownerForAccount: () => owner });
    assert.equal(reloaded.get(task.id).logicalBotId, "unassigned:missing");
    assert.equal(reloaded.resume(task.id, actor).ok, false);
    const fixture = legacyFixture("unknown-legacy", { id: "unknown-legacy", accountId: "gone", status: "offered", grants: [] });
    const migrated = harness("unknown-legacy", { ownerForAccount: () => undefined });
    assert.equal(migrated.get("unknown-legacy").logicalBotId, "unassigned:gone");
    assert.deepEqual(fs.readFileSync(fixture.backup), fixture.original);
    const throwing = harness("unknown-throw", { ownerForAccount: () => { throw new Error("synthetic registry lookup failure"); } });
    assert.equal(offer(throwing, "broken").logicalBotId, "unassigned:broken");
    assert.equal(offer(throwing, "").logicalBotId, "unassigned:legacy:default");
  });

  await test("notice-and-initial-write-failures-release-all-slots", async () => {
    for (const failure of ["start-notice", "all-notices", "initial-persist", "initial-event", "execute-error"]) {
      const executed = [];
      const runtime = harness(`cleanup-${failure}`, {
        config: { taskMode: { workspaceBaseDir: "tasks", ownerUserIds: ["owner"], maxConcurrentGlobal: 1 } },
        execute: async (task) => {
          executed.push(task.id);
          if (failure === "execute-error" && task.objective === "first") throw new Error("synthetic execution error");
          return { ok: true };
        },
        notify: async (task, notice) => {
          if (["all-notices", "execute-error"].includes(failure) || (task.objective === "first" && notice.type === "started")) throw new Error("synthetic notice failure");
        }
      });
      const first = offer(runtime, "a", { objective: "first" });
      const next = offer(runtime, "a", { objective: "next" });
      next.status = "queued";
      runtime.queue.push(next.id);
      const initializationFailure = ["initial-persist", "initial-event"].includes(failure);
      if (initializationFailure) {
        const method = failure === "initial-persist" ? "persist" : "event";
        const original = runtime[method].bind(runtime);
        let once = true;
        runtime[method] = (...args) => {
          if (once) { once = false; throw new Error("synthetic initial write failure"); }
          return original(...args);
        };
      }
      await runtime.run(first);
      await waitFor(() => next.status === "completed" && runtime.running.size === 0);
      assert.equal(runtime.controllers.size, 0);
      assert.equal(first.status, initializationFailure || failure === "execute-error" ? "failed" : "completed");
      assert.deepEqual(executed, initializationFailure ? [next.id] : [first.id, next.id]);
    }
    for (const method of ["persist", "event"]) {
      const runtime = harness(`permanent-${method}`);
      const task = offer(runtime, "a");
      runtime[method] = () => { throw new Error("permanent synthetic write failure"); };
      await assert.rejects(runtime.run(task), /permanent synthetic write failure/);
      assert.equal(runtime.running.size + runtime.controllers.size, 0);
    }
  });

  await test("cancel-during-start-notice-keeps-status-and-cleans-slots", async () => {
    for (const rejects of [false, true]) {
      const notice = deferred();
      let executed = false;
      const runtime = harness(`cancel-notice-${rejects}`, {
        execute: async () => { executed = true; return { ok: true }; },
        notify: () => notice.promise
      });
      const task = offer(runtime, "a");
      const run = runtime.run(task);
      assert.equal(runtime.running.size, 1);
      assert.equal(runtime.cancel(task.id, actor).ok, true);
      if (rejects) notice.reject(new Error("synthetic cancelled notice failure"));
      else notice.resolve();
      await run;
      assert.equal(task.status, "cancelled");
      assert.equal(executed, false);
      assert.equal(runtime.running.size + runtime.controllers.size, 0);
    }
  });

  await test("cancelled-uncooperative-task-keeps-slot-until-settled", async () => {
    const entered = deferred();
    const release = deferred();
    let activeId;
    const runtime = harness("cancel-execute", {
      execute: async (task) => {
        if (task.id === activeId) { entered.resolve(); await release.promise; }
        return { ok: true, summary: "late success" };
      }
    });
    const active = offer(runtime, "a");
    activeId = active.id;
    const next = offer(runtime, "a");
    confirm(runtime, active);
    confirm(runtime, next);
    await entered.promise;
    assert.equal(runtime.cancel(active.id, actor).ok, true);
    assert.equal(runtime.running.has(active.id), true, "取消不能提前释放尚未结束的物理执行槽");
    await runtime.pump();
    assert.equal(next.status, "queued");
    release.resolve();
    await waitFor(() => next.status === "completed" && runtime.running.size === 0);
    assert.equal(active.status, "cancelled");
    assert.equal(active.resultSummary, "");
    assert.equal(runtime.controllers.size, 0);
  });

  console.log(JSON.stringify({ ok: true, tests: passed.length, passed }));
} finally {
  for (const runtime of runtimes) for (const controller of runtime.controllers.values()) controller.abort();
  for (const gate of gates) gate.resolve();
  await waitFor(() => runtimes.every((runtime) => runtime.running.size === 0));
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
