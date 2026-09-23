import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { applyCanonicalCorrections, ensureCanonicalMemory, mergeCanonicalEvidence, memoryIntegrityReport } from "../src/memory-integrity.js";
import { TaskRuntime } from "../src/task-runtime.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qq-bot-agent-test-"));

try {
  const first = { aliases: ["小明"], profile: ["喜欢做模型"] };
  const second = { aliases: ["小明"] };
  const firstCanonical = ensureCanonicalMemory(first, "10001", { sourceConversationId: "group:test" });
  const secondCanonical = ensureCanonicalMemory(second, "10002", { sourceConversationId: "group:test" });
  assert.equal(firstCanonical.subjectUserId, "10001");
  assert.equal(secondCanonical.subjectUserId, "10002");
  assert.notEqual(firstCanonical.entries[0].id, secondCanonical.entries[0].id, "同名用户必须按 QQ 号隔离");

  const update = { preferences: ["喜欢黑咖啡"], confidence: 0.8 };
  mergeCanonicalEvidence(first, update, {
    subjectUserId: "10001",
    conversationId: "group:test",
    sourceMessageIds: ["m1"],
    sentAt: "2026-08-14T01:00:00.000Z"
  }, { requireEvidence: true, minStableConfidence: 0.65 });
  const preference = first.canonicalMemory.entries.find((item) => item.value === "喜欢黑咖啡");
  assert.equal(preference.status, "tentative", "单次 AI 提取不能直接成为稳定事实");
  mergeCanonicalEvidence(first, update, {
    subjectUserId: "10001",
    conversationId: "group:test",
    sourceMessageIds: ["m2"],
    sentAt: "2026-08-14T02:00:00.000Z"
  }, { requireEvidence: true, minStableConfidence: 0.65 });
  assert.equal(preference.status, "active", "第二次独立提取应可确认稳定事实");
  applyCanonicalCorrections(first, [{ memory_id: preference.id, action: "supersede", reason: "本人明确纠正" }], {
    subjectUserId: "10001",
    conversationId: "group:test",
    sentAt: "2026-08-14T03:00:00.000Z"
  });
  assert.equal(preference.status, "superseded");

  const memory = { groups: { "group:test": { users: { "10001": first, "10002": second } } } };
  const integrity = memoryIntegrityReport(memory, { minStableConfidence: 0.65 });
  assert.equal(integrity.totals.invalidSubject, 0);

  const runtimeConfig = {
    taskMode: {
      enabled: true,
      workspaceBaseDir: "tasks",
      ownerUserIds: ["owner"],
      allowedGroupIds: ["group:test"],
      maxConcurrentGlobal: 2,
      maxConcurrentPerConversation: 1,
      progressHeartbeatMs: 60_000
    }
  };
  const notices = [];
  const runtime = new TaskRuntime({
    rootDir: tempRoot,
    config: () => runtimeConfig,
    execute: async (task, { outputsDir }) => {
      await delay(40);
      fs.writeFileSync(path.join(outputsDir, "draft.md"), "draft");
      fs.writeFileSync(path.join(outputsDir, "final.pdf"), "%PDF-test");
      return { ok: true, summary: `done:${task.id}`, artifacts: [{ name: "final.pdf" }] };
    },
    notify: async (task, notice) => {
      notices.push({ taskId: task.id, type: notice.type, text: notice.text, artifacts: notice.artifacts });
      return true;
    }
  });
  const isolated = runtime.createOffer({ conversationId: "group:test", messageType: "group", groupId: "group:test", userId: "member", objective: "联网整理资料", complexity: "standard", reasoningEffort: "medium" });
  assert.equal(isolated.complexity, "standard");
  assert.equal(isolated.reasoningEffort, "medium");
  assert.equal(runtime.confirm(isolated.id, { userId: "member", source: "qq" }).ok, true, "白名单群发起人可确认隔离任务");
  const local = runtime.createOffer({ conversationId: "group:other", messageType: "group", groupId: "group:test", userId: "member", objective: "读取文件", requiresLocalFiles: true });
  assert.equal(runtime.confirm(local.id, { userId: "member" }).ok, false, "群友不能确认本地文件任务");
  assert.equal(runtime.confirm(local.id, { userId: "owner", source: "admin" }).ok, true, "主人可确认后续等待具体授权");
  await delay(160);
  assert.equal(runtime.get(isolated.id).status, "completed");
  assert.equal(runtime.get(local.id).status, "completed");
  assert.equal(runtime.get(isolated.id).currentStage, "已完成");
  assert.equal(runtime.get(isolated.id).review, null, "新任务不应产生回复审查结果");
  assert.equal(notices.some((notice) => notice.taskId === isolated.id && notice.type === "started"), false, "QQ 确认后不应重复发送开始通知");
  assert.equal(notices.some((notice) => notice.taskId === local.id && notice.type === "started"), true, "管理页确认应保留异步开始通知");
  assert.deepEqual(notices.find((notice) => notice.taskId === isolated.id && notice.type === "completed")?.artifacts?.map((item) => item.name), ["final.pdf"], "只交付任务声明的最终产物");

  const retryable = runtime.createOffer({ conversationId: "private:owner", messageType: "private", userId: "owner", objective: "失败后恢复" });
  retryable.status = "failed";
  retryable.lastError = "simulated failure";
  runtime.persist(retryable);
  assert.equal(runtime.resume(retryable.id, { userId: "owner", source: "admin" }).ok, true, "失败任务应允许由主人恢复执行");
  await delay(100);
  assert.equal(runtime.get(retryable.id).status, "completed", "恢复后的失败任务应重新进入执行队列");

  console.log(JSON.stringify({ ok: true, memoryEntries: integrity.totals.entries, tasks: runtime.list().length }));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
