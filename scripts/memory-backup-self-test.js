import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryRepository, readMemorySnapshot } from "../src/memory-repository.js";
import { createBackup, inspectBackup, restoreBackup } from "../src/backup-service.js";
import { createHash } from "node:crypto";
import { createStickerCache } from "../src/sticker-cache.js";

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
  // Optional expression state is additive, not a new writer/file. Ordinary
  // backups preserve these non-credential branches even for old-style config;
  // restored data alone cannot enable a policy or replay an outbound action.
  committed.socialExpressionAssets = { version: 1, bots: { "account:fixture": { capabilities: {}, stickers: {} } } };
  committed.socialExpressionLanguage = { version: 1, bots: {} };
  committed.socialExpressionLibrary = { version: 1, bots: { "account:fixture": { nextClaim: 2, lastAt: 1000,
    days: { "2026-10-23": { claims: { "1": { status: "reserved", at: 1000 } } } } } } };
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0uoAAAAASUVORK5CYII=", "base64");
  const sha256 = createHash("sha256").update(image).digest("hex");
  const cache = createStickerCache({ baseDir: path.join(fs.realpathSync(data), "sticker-assets") });
  assert.equal(await cache.put("account:fixture", { buffer: image, mimeType: "image/png", sha256 }), true);
  committed.socialExpressionAssets.bots["account:fixture"].stickers[`gs_${sha256}`] = {
    id: `gs_${sha256}`, source: "group-observed", sha256, cacheSha256: sha256,
    url: "https://cdn.qq.com/fixture.png?rkey=TRANSPORT_SENTINEL", desc: "", active: true,
    revision: 1, trust: "untrusted", annotations: {}
  };
  assert.throws(() => repository.save(committed));
  repository.close();
  assert.deepEqual(readMemorySnapshot(memoryPath), committed);
  const backup = await createBackup({ type: "safe", stateRoot: state, destinationDir: path.join(home, "backups") });
  const inspected = await inspectBackup({ path: backup.path });
  assert(inspected.manifest.files.some((file) => file.path === "state/data/memory.json"));
  assert(inspected.manifest.files.some((file) => file.path.startsWith("state/data/sticker-assets/") && file.path.endsWith(".asset")));
  assert(!inspected.manifest.files.some((file) => /journal|\.writer/.test(file.path)), "backup must materialize, not copy transient storage state");
  const restored = path.join(home, "restored");
  await restoreBackup({ path: backup.path, stateRoot: restored, hermesHome: path.join(restored, "hermes") });
  const portable = structuredClone(committed);
  delete portable.socialExpressionAssets.bots["account:fixture"].stickers[`gs_${sha256}`].url;
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(restored, "data", "memory.json"), "utf8")), portable);
  assert.deepEqual(readMemorySnapshot(memoryPath), committed, "sanitizing a backup must not change published source memory");
  const restoredCache = createStickerCache({ baseDir: path.join(fs.realpathSync(path.join(restored, "data")), "sticker-assets") });
  assert.deepEqual((await restoredCache.read("account:fixture", sha256))?.buffer, image, "ordinary restore retains bounded learned image bytes");
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
