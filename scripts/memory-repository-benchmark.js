import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { MemoryRepository } from "../src/memory-repository.js";

// Diagnostic baseline, NOT a performance acceptance assertion. Entirely
// generated data approximating a multi-megabyte legacy memory snapshot.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-memory-bench-"));
const repository = new MemoryRepository({ filePath: path.join(home, "memory.json") });
try {
  repository.acquireWriter(); repository.load();
  const users = Object.fromEntries(Array.from({ length: 1400 }, (_, user) => [`fixture-${user}`, {
    names: [`fixture ${user}`], profile: Array.from({ length: 24 }, (_, item) => `fixture-${user}-${item} ${"synthetic context ".repeat(10)}`)
  }]));
  const memory = { groups: { fixture: { users } } };
  let start = performance.now(); repository.save(memory);
  const initialSaveMs = performance.now() - start;
  const samples = [], stalls = [];
  for (let index = 0; index < 5; index += 1) {
    start = performance.now();
    const tick = new Promise((resolve) => setImmediate(() => resolve(performance.now() - start)));
    memory.groups.fixture.users[`fixture-${index}`].messageCount = index + 1;
    repository.save(memory);
    samples.push(performance.now() - start);
    stalls.push(await tick);
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({ fixtureOnly: true, snapshotBytes: fs.statSync(path.join(home, "memory.json")).size,
    initialSaveMs: Math.round(initialSaveMs), saveP50Ms: Math.round(samples[2]), saveP95Ms: Math.round(samples.at(-1)),
    maxEventLoopStallMs: Math.round(Math.max(...stalls)), sampleCount: samples.length,
    note: "diagnostic baseline; no provider calls, live data or services" }, null, 2));
} finally {
  repository.close();
  fs.rmSync(home, { recursive: true, force: true });
}
