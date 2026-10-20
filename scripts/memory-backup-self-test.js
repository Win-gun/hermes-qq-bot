import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryRepository, readMemorySnapshot } from "../src/memory-repository.js";
import { createBackup, inspectBackup, restoreBackup } from "../src/backup-service.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-memory-backup-"));
const state = path.join(home, "state"), data = path.join(state, "data"), memoryPath = path.join(data, "memory.json");
let repository;
try {
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(state, "config.json"), JSON.stringify({ control: { host: "127.0.0.1" }, accounts: { version: 2, items: [], failoverGroups: [] } }));
  repository = new MemoryRepository({ filePath: memoryPath, failpoint: (phase) => {
    if (phase === "journal:durable") throw new Error("synthetic checkpoint interruption");
  } });
  repository.acquireWriter(); repository.load();
  const committed = { groups: { fixture: { users: { u: { names: ["fixture recovered user"] } } } } };
  assert.throws(() => repository.save(committed));
  repository.close();
  assert.deepEqual(readMemorySnapshot(memoryPath), committed);
  const backup = await createBackup({ type: "safe", stateRoot: state, destinationDir: path.join(home, "backups") });
  const inspected = await inspectBackup({ path: backup.path });
  assert(inspected.manifest.files.some((file) => file.path === "state/data/memory.json"));
  assert(!inspected.manifest.files.some((file) => /journal|\.writer/.test(file.path)), "backup must materialize, not copy transient storage state");
  const restored = path.join(home, "restored");
  await restoreBackup({ path: backup.path, stateRoot: restored, hermesHome: path.join(restored, "hermes") });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(restored, "data", "memory.json"), "utf8")), committed);
  // A witness makes loss of both files corruption, not a fresh empty install.
  fs.rmSync(memoryPath, { force: true });
  fs.rmSync(`${memoryPath}.journal.jsonl`);
  assert.throws(() => readMemorySnapshot(memoryPath), { code: "MEMORY_EXTERNAL_CHANGE" });
  await assert.rejects(() => createBackup({ type: "safe", stateRoot: state, destinationDir: path.join(home, "backups") }), { code: "MEMORY_EXTERNAL_CHANGE" });
  console.log("memory backup: durable-journal materialization, old-format restore and missing-store refusal passed");
} finally {
  repository?.close();
  fs.rmSync(home, { recursive: true, force: true });
}
