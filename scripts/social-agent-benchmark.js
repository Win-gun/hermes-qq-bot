import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestSocialMessage, getSocialSnapshot, socialContinuityPrompt } from "../src/social-agent-state.js";
import { BackgroundMemoryRepository } from "../src/memory-repository-service.js";
import { MemoryRuntime } from "../src/memory-runtime.js";

// Synthetic local projection/intake overhead: no model, live files or sends.
// This is not a claim about Hermes/network end-to-end response latency.
const now = Date.UTC(2026, 9, 23, 4);
const root = { groups: {} };
const context = { logicalId: "account:benchmark", conversationId: "group:10001", now };
for (let i = 0; i < 200; i++) {
  assert(ingestSocialMessage(root, { ...context, message: { messageId: `bench-${i}`,
    userId: "10002", text: "虚构的本地开销测试。".repeat(30), sentAt: now - 1000, receivedAt: now } }).ok);
}
const samples = [];
for (let i = 0; i < 1000; i++) {
  const start = performance.now();
  const view = getSocialSnapshot(root, context);
  socialContinuityPrompt(root, { ...context, userId: "10002" });
  assert(view.messages.length <= 32 && view.hasMore);
  samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
const p95 = samples[Math.floor(samples.length * .95)];
assert(p95 < 100, "local continuity projection exceeded the 100 ms P95 gate");

// Include the real background writer, fsync/journal/publication and an unrelated
// 1 MiB synthetic store. Projection-only numbers must not hide durable intake.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-social-benchmark-"));
const runtime = new MemoryRuntime(new BackgroundMemoryRepository({ filePath: path.join(home, "memory.json") }));
const durableSamples = [];
try {
  await runtime.open();
  await runtime.transact(draft => { draft.fixturePadding = "x".repeat(1024 * 1024); });
  for (let i = 0; i < 110; i++) {
    const start = performance.now();
    const result = await runtime.transact(draft => ingestSocialMessage(draft, {
      ...context, message: { messageId: `durable-${i}`, userId: "10002",
        text: "虚构的持久化开销测试。", sentAt: now, receivedAt: now }
    }));
    assert(result.ok);
    getSocialSnapshot(runtime.value, context);
    socialContinuityPrompt(runtime.value, { ...context, userId: "10002" });
    if (i >= 10) durableSamples.push(performance.now() - start);
  }
} finally {
  await runtime.close();
  fs.rmSync(home, { recursive: true, force: true });
}
durableSamples.sort((a, b) => a - b);
const durableP95 = durableSamples[Math.floor(durableSamples.length * .95)];
assert(durableP95 < 100, "synthetic durable continuity intake exceeded the 100 ms P95 gate");
console.log(JSON.stringify({ ok: true, fixtureOnly: true, samples: samples.length,
  projectionP95Ms: Number(p95.toFixed(3)), durableSamples: durableSamples.length,
  durableIntakeP95Ms: Number(durableP95.toFixed(3)), fixturePaddingBytes: 1024 * 1024,
  thresholdMs: 100, modelCalls: 0,
  scope: "synthetic durable intake plus projection; no production load or end-to-end latency claim" }));
