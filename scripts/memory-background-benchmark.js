import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { BackgroundMemoryRepository } from "../src/memory-repository-service.js";
import { MemoryRuntime } from "../src/memory-runtime.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-memory-background-bench-"));
const repository = new BackgroundMemoryRepository({ filePath: path.join(home, "memory.json") });
const runtime = new MemoryRuntime(repository);
let timer;
try {
  await runtime.open();
  const users = Object.fromEntries(Array.from({ length: 1400 }, (_, user) => [`fixture-${user}`, {
    names: [`fixture ${user}`], profile: Array.from({ length: 24 }, (_, item) => `fixture-${user}-${item} ${"synthetic context ".repeat(10)}`)
  }]));
  const gaps = [], samples = [];
  let previous = performance.now();
  timer = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now; }, 10);
  await runtime.transact(draft => { draft.groups.fixture = { users }; });
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    await runtime.transact(draft => { draft.groups.fixture.users[`fixture-${i}`].messageCount = i + 1; });
    samples.push(performance.now() - started);
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  console.log(JSON.stringify({ fixtureOnly: true, snapshotBytes: fs.statSync(path.join(home, "memory.json")).size,
    saveP50Ms: Math.round(samples.sort((a, b) => a - b)[2]), maxEventLoopGapMs: Math.round(Math.max(...gaps)),
    timerTicks: gaps.length, sampleCount: samples.length,
    note: "background repository foundation; bridge integration is a separate acceptance gate" }));
} finally { clearInterval(timer); await runtime.close(); fs.rmSync(home, { recursive: true, force: true }); }
