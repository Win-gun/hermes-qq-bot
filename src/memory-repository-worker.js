import { parentPort } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { MemoryRepository } from "./memory-repository.js";
import { memoryIntegrityReport } from "./memory-integrity.js";

// The worker, not the bridge thread, owns the existing repository's writer
// ticket, journal fsync, validation, hashing, snapshot and recovery protocol.
let repository = null;
let memoryFile = "";
function backupBeforeCommit(destination, expectedRevision) {
  if (typeof destination !== "string" || destination.includes("\0")
    || path.dirname(path.resolve(destination)) !== path.dirname(memoryFile)
    || !path.basename(destination).startsWith(`${path.basename(memoryFile)}.bak.`)) {
    throw Object.assign(new Error(), { code: "MEMORY_PATH_UNSAFE" });
  }
  if (expectedRevision !== repository.revision) throw Object.assign(new Error(), { code: "MEMORY_CAS_MISMATCH" });
  const bytes = `${JSON.stringify(repository.load(), null, 2)}\n`;
  const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const directory = fs.openSync(path.dirname(memoryFile), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
parentPort?.on("message", request => {
  try {
    let result;
    if (request.kind === "open") {
      if (repository) throw Object.assign(new Error(), { code: "MEMORY_ALREADY_OPEN" });
      repository = new MemoryRepository({ filePath: request.filePath, writerToken: request.writerToken });
      memoryFile = path.resolve(request.filePath);
      repository.acquireWriter();
      result = { value: repository.load(), revision: repository.revision };
    } else {
      if (!repository) throw Object.assign(new Error(), { code: "MEMORY_LOAD_REQUIRED" });
      if (request.kind === "save" || request.kind === "commit") {
        if (request.backupPath !== undefined) backupBeforeCommit(request.backupPath, request.expectedRevision);
        const revision = repository.save(request.value, { expectedRevision: request.expectedRevision });
        result = request.kind === "commit" ? { revision, value: repository.load() } : revision;
      }
      else if (request.kind === "read") result = { value: repository.load(), revision: repository.revision };
      else if (request.kind === "integrity") result = memoryIntegrityReport(repository.load(), request.options || {});
      else if (request.kind === "close") { repository.close(); result = null; }
      else throw Object.assign(new Error(), { code: "MEMORY_INVALID_REQUEST" });
    }
    parentPort.postMessage({ id: request.id, ok: true, result, status: repository.status() });
    if (request.kind === "close") parentPort.close();
  } catch (error) {
    parentPort.postMessage({ id: request?.id, ok: false,
      code: /^MEMORY_[A-Z_]+$/.test(error?.code || "") ? error.code : "MEMORY_IO",
      status: repository?.status() || null });
  }
});
