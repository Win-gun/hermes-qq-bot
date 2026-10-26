import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalNoFollowPath } from "./work-capabilities.js";

const MAX_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const denied = /(^|\/)(?:\.env(?:\.[^/]*)?|\.ssh|id_rsa|id_ed25519|credentials|secrets?|cookies?|[^/]*\.keychain(?:-db)?)(\/|$)/i;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const leaf = name => typeof name === "string" && name.length > 0 && name !== "." && name !== ".."
  && Buffer.byteLength(name) <= 255 && !/[\\/:\u0000-\u001f\u007f]/u.test(name);
const codeFor = error => /^WORK_[A-Z_]+$/.test(error?.code || "") ? error.code : "WORK_FILE_IO_FAILED";

// Node has no openat/renameat API. Linux procfs can address an already-open
// directory; Darwin instead supports ONLY a host-owned private task workspace.
// That model excludes hostile same-UID processes; it is NOT native openat.
function systemDirectoryIO() {
  if (process.platform === "darwin") return { verified: true, taskPrivateOnly: true };
  return { verified: process.platform === "linux" && Number.isInteger(fs.constants.O_NOFOLLOW)
      && Number.isInteger(fs.constants.O_DIRECTORY) && fs.existsSync("/proc/self/fd"),
    descriptorPath: fd => `/proc/self/fd/${fd}` };
}

/**
 * Host-owned synchronous descriptor-relative operations; never retries.
 * authorize({target}) returns {fileBoundary:{path,...}} synchronously.
 * Returns the current broker's status:'succeeded' contract, not state/ok.
 *
 * directoryIO is a HOST-attested primitive, never model/task data:
 * {verified:true, descriptorPath(fd):string}. It MUST address the pinned open
 * directory even after ancestor rename/replacement. Darwin's separate default
 * supports only isolated_files in an owner-0700 task directory, with synchronous
 * ancestor/inode checks. It does NOT isolate hostile same-UID host processes.
 * Unsupported hosts attest verified:false. Test substitutes MUST declare
 * fixtureOnly:true and require allowFixtures:true; they prove logic, NOT OS
 * isolation. No claim is made of a general OS sandbox or inode-CAS overwrite.
 *
 * finalizeArtifacts is a TRUSTED host async helper, not a model-selected tool.
 * It must honor signal and settle only after child processes/cleanup stop. The
 * fifth argument supplies check() for optional per-await authorization checks.
 * Root/authority are checked before/after; an unconfirmed outcome is uncertain.
 */
export function createWorkFileBackend({ getTask, getWorkspace, finalizeArtifacts,
  directoryIO = systemDirectoryIO(), allowFixtures = false } = {}) {
  if (typeof getTask !== "function" || typeof getWorkspace !== "function") fail("WORK_FILE_DEPENDENCY");
  const privateOnly = directoryIO?.taskPrivateOnly === true;
  const available = directoryIO?.verified === true && (privateOnly || typeof directoryIO.descriptorPath === "function")
    && Number.isInteger(fs.constants.O_NOFOLLOW) && Number.isInteger(fs.constants.O_DIRECTORY)
    && (directoryIO.fixtureOnly !== true || allowFixtures === true);
  const busyRoots = new Set();
  const manifest = Object.freeze({ id: "local-files", verified: available, available,
    capabilities: Object.freeze(privateOnly ? ["isolated_files"] : ["isolated_files", "local_read", "local_write"]),
    enforcesScope: available, rechecksAuthorization: true, noAutomaticRetries: true,
    isolated: available, canonicalNoFollow: available, maxInputBytes: MAX_BYTES,
    maxArtifactBytes: MAX_ARTIFACT_BYTES,
    boundaryMode: privateOnly ? "task-private-directory" : "descriptor-relative",
    nativeOpenat: false, hostileSameUidWritersIsolated: false, hostFilesVerified: available && !privateOnly,
    finalizeArtifacts: typeof finalizeArtifacts === "function",
    finalizationBoundary: "trusted-helper-root-and-authority-recheck",
    ...(directoryIO?.fixtureOnly === true ? { fixtureOnly: true } : {}),
    gaps: Object.freeze(available ? [] : ["PINNED_DIRECTORY_IO_UNAVAILABLE"]) });

  return Object.freeze({ manifest, async execute(request) {
    if (!available) return { status: "failed", applied: false, code: "WORK_FILE_BOUNDARY_UNAVAILABLE" };
    const fds = [], owned = [], fdPaths = new Map();
    const descriptorPath = privateOnly ? fd => fdPaths.get(fd) : directoryIO.descriptorPath.bind(directoryIO);
    let committed = false, cleanupFailed = false, result, parent, busyRoot, cleanupGuard;
    const close = fd => { fs.closeSync(fd); fds.splice(fds.indexOf(fd), 1); fdPaths.delete(fd); };
    const open = (file, flags, mode) => {
      const fd = fs.openSync(file, flags, mode); fds.push(fd); fdPaths.set(fd, path.resolve(file)); return fd;
    };
    try {
      if (!plain(request) || !plain(request.args) || typeof request.authorize !== "function") fail("WORK_FILE_REQUEST");
      if (!manifest.capabilities.includes(request.capability)) fail("WORK_FILE_CAPABILITY_UNAVAILABLE");
      const allowed = { isolated_files: ["read", "list", "write"], local_read: ["read"], local_write: ["write"] };
      if (!Object.hasOwn(allowed, request.capability) || !allowed[request.capability].includes(request.action)) fail("WORK_FILE_ACTION");
      const permitted = request.action === "write" ? ["path", "target", "content", "artifactName", "finalizeArtifacts"] : ["path", "target"];
      if (Object.keys(request.args).some(key => !permitted.includes(key))) fail("WORK_FILE_REQUEST");
      const finalizing = request.args.finalizeArtifacts !== undefined;
      if (finalizing && (request.capability !== "isolated_files" || typeof finalizeArtifacts !== "function"
        || request.args.content !== undefined || request.args.artifactName !== undefined)) fail("WORK_FILE_ACTION");
      const task = getTask(request.taskId);
      const isOwner = value => value && value.id === request.taskId && value.logicalBotId === request.logicalBotId
        && value.accountId === request.accountId;
      if (!isOwner(task)) fail("WORK_FILE_OWNER");
      const requested = request.args.path ?? request.args.target;
      if (typeof requested !== "string" || !path.isAbsolute(requested) || requested.includes("\0")) fail("WORK_FILE_SCOPE");
      const file = path.resolve(requested);
      if (request.args.path !== undefined && request.args.target !== undefined
        && (typeof request.args.target !== "string" || path.resolve(request.args.target) !== file)) fail("WORK_FILE_SCOPE");
      if (request.capability === "local_write" && request.args.target !== file) fail("WORK_FILE_SCOPE");
      const authorize = () => {
        if (request.signal?.aborted) fail("WORK_FILE_CANCELLED");
        if (!isOwner(getTask(request.taskId))) fail("WORK_FILE_OWNER");
        const authorization = request.authorize({ target: request.args.target });
        if (authorization?.then || authorization?.fileBoundary?.path !== file) fail("WORK_FILE_SCOPE");
        if (request.signal?.aborted) fail("WORK_FILE_CANCELLED");
        return authorization;
      };
      authorize();
      if (denied.test(file)) fail("WORK_PROTECTED_FILE");
      const root = canonicalNoFollowPath(getWorkspace(task));
      if (!root.directory) fail("WORK_FILE_SCOPE");
      if (request.capability === "isolated_files" && !inside(root.path, file)) fail("WORK_FILE_SCOPE");
      const privateRoot = () => {
        const stat = fs.lstatSync(root.path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== root.device || stat.ino !== root.inode
          || (stat.mode & 0o777) !== 0o700 || typeof process.getuid !== "function" || stat.uid !== process.getuid()) fail("WORK_FILE_PRIVATE_WORKSPACE_REQUIRED");
      };
      if (request.capability === "isolated_files") privateRoot();
      if (finalizing && file !== root.path) fail("WORK_FILE_SCOPE");
      if (busyRoots.has(root.path)) fail("WORK_FILE_BUSY");
      busyRoots.add(root.path); busyRoot = root.path;
      const relative = (fd, entry) => {
        if (!leaf(entry)) fail("WORK_FILE_SCOPE");
        return path.join(descriptorPath(fd), entry);
      };
      const pinDirectory = absolute => {
        let fd = open(path.parse(absolute).root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        for (const entry of absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean)) {
          authorize();
          const child = open(relative(fd, entry), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
          if (!fs.fstatSync(child).isDirectory()) fail("WORK_FILE_SCOPE");
          close(fd); fd = child;
        }
        return fd;
      };
      parent = pinDirectory(path.dirname(file));
      const name = path.basename(file), parentStat = fs.fstatSync(parent);
      cleanupGuard = () => {
        // Darwin paths are checked synchronously, not descriptor-relative. Do
        // not even attempt cleanup through a replaced/symlinked ancestor.
        const current = canonicalNoFollowPath(root.path), currentParent = canonicalNoFollowPath(path.dirname(file));
        if (current.device !== root.device || current.inode !== root.inode
          || currentParent.device !== parentStat.dev || currentParent.inode !== parentStat.ino) fail("WORK_FILE_CHANGED");
        privateRoot();
      };
      const guard = () => {
        authorize();
        const currentRoot = canonicalNoFollowPath(getWorkspace(getTask(request.taskId)));
        if (currentRoot.path !== root.path || currentRoot.device !== root.device || currentRoot.inode !== root.inode) fail("WORK_FILE_SCOPE");
        const currentParent = canonicalNoFollowPath(path.dirname(file));
        if (!currentParent.directory || currentParent.device !== parentStat.dev || currentParent.inode !== parentStat.ino) fail("WORK_FILE_CHANGED");
        if (request.capability === "isolated_files") privateRoot();
      };
      const statAt = (fd, entry) => {
        try { return fs.lstatSync(relative(fd, entry)); }
        catch (error) { if (error.code === "ENOENT") return null; throw error; }
      };
      const regular = (stat, limit = MAX_BYTES) => {
        if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("WORK_FILE_NOT_REGULAR");
        if (stat.size > limit) fail("WORK_FILE_SIZE");
      };
      const read = (directory, entry, limit = MAX_BYTES) => {
        guard();
        const expected = statAt(directory, entry); regular(expected, limit);
        guard();
        const fd = open(relative(directory, entry), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          const start = fs.fstatSync(fd); regular(start, limit);
          if (!same(expected, start)) fail("WORK_FILE_CHANGED");
          const buffer = Buffer.alloc(limit + 1); let count = 0;
          while (count < buffer.length) {
            guard();
            const bytes = fs.readSync(fd, buffer, count, buffer.length - count, count);
            if (bytes === 0) break;
            count += bytes;
          }
          const end = fs.fstatSync(fd); regular(end, limit);
          if (count > limit) fail("WORK_FILE_SIZE");
          if (start.size !== end.size || start.mtimeMs !== end.mtimeMs || start.ctimeMs !== end.ctimeMs || count !== end.size) fail("WORK_FILE_CHANGED");
          guard();
          if (!same(end, statAt(directory, entry) || {})) fail("WORK_FILE_CHANGED");
          return { buffer: buffer.subarray(0, count), stat: end };
        } finally { close(fd); }
      };
      if (finalizing) {
        const artifacts = request.args.finalizeArtifacts;
        if (!Array.isArray(artifacts) || artifacts.length > 8) fail("WORK_FILE_FINALIZE_INPUT");
        const directory = pinDirectory(root.path);
        if (!same(fs.fstatSync(directory), { dev: root.device, ino: root.inode })) fail("WORK_FILE_CHANGED");
        const scanRoot = () => {
          guard();
          const iterator = fs.opendirSync(descriptorPath(directory));
          try {
            for (let i = 0; ; i++) {
              const entry = iterator.readSync(); if (!entry) break;
              if (i >= 1000) fail("WORK_FILE_FINALIZE_INPUT");
              const stat = statAt(directory, entry.name);
              if (!stat || stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile() && stat.nlink === 1)) fail("WORK_FILE_NOT_REGULAR");
            }
          } finally { iterator.closeSync(); }
          guard();
        };
        scanRoot();
        let inputBytes = 0;
        const names = new Set(), input = [];
        for (const artifact of artifacts) {
          if (!plain(artifact) || Object.keys(artifact).some(key => !["name", "type", "size"].includes(key))
            || !leaf(artifact.name) || denied.test(artifact.name) || artifact.name.startsWith(".") || names.has(artifact.name)
            || typeof artifact.type !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(artifact.type)) fail("WORK_FILE_FINALIZE_INPUT");
          names.add(artifact.name);
          const source = read(directory, artifact.name, MAX_BYTES - inputBytes);
          inputBytes += source.buffer.length;
          if (artifact.size !== undefined && artifact.size !== source.buffer.length) fail("WORK_FILE_FINALIZE_INPUT");
          input.push({ name: artifact.name, type: artifact.type, size: source.buffer.length });
        }
        if (Buffer.byteLength(String(task.resultSummary || task.summary || "")) > MAX_BYTES) fail("WORK_FILE_SIZE");
        guard();
        committed = true; // Trusted helper may write before rejecting/settling.
        const output = await finalizeArtifacts(structuredClone(task), input, root.path, request.signal, { check: guard });
        guard(); scanRoot();
        if (!plain(output) || typeof output.ok !== "boolean" || !Array.isArray(output.artifacts) || output.artifacts.length > 8) fail("WORK_FILE_FINALIZE_RECEIPT");
        const verified = [], seen = new Set(); let bytes = 0;
        if (output.ok) for (const artifact of output.artifacts) {
          if (!plain(artifact) || !leaf(artifact.name) || artifact.name.startsWith(".") || denied.test(artifact.name)
            || seen.has(artifact.name)) fail("WORK_FILE_FINALIZE_RECEIPT");
          seen.add(artifact.name);
          const data = read(directory, artifact.name, MAX_ARTIFACT_BYTES - bytes); bytes += data.buffer.length;
          const pdf = /\.pdf$/i.test(artifact.name);
          if (pdf && data.buffer.subarray(0, 5).toString("ascii") !== "%PDF-") fail("WORK_FILE_FINALIZE_RECEIPT");
          if (artifact.size !== undefined && artifact.size !== data.buffer.length) fail("WORK_FILE_FINALIZE_RECEIPT");
          const type = pdf ? "application/pdf" : artifact.type;
          if (typeof type !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(type)) fail("WORK_FILE_FINALIZE_RECEIPT");
          verified.push({ name: artifact.name, type, size: data.buffer.length });
        }
        if (output.ok && (output.requestedPdf === true || output.pdfCreated === true)
          && !verified.some(artifact => artifact.type === "application/pdf")) fail("WORK_FILE_FINALIZE_RECEIPT");
        guard();
        result = { status: "succeeded", data: { ok: output.ok, requestedPdf: output.requestedPdf === true,
          pdfCreated: output.ok && verified.some(artifact => artifact.type === "application/pdf"), artifacts: verified,
          ...(!output.ok ? { error: "WORK_ARTIFACT_FINALIZE_FAILED" } : {}) } };
      } else if (request.action === "list") {
        guard();
        const expected = statAt(parent, name);
        if (!expected?.isDirectory() || expected.isSymbolicLink()) fail("WORK_FILE_NOT_REGULAR");
        const directory = open(relative(parent, name), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        if (!same(expected, fs.fstatSync(directory))) fail("WORK_FILE_CHANGED");
        guard();
        const iterator = fs.opendirSync(descriptorPath(directory)), names = []; let exhausted = false;
        try {
          for (let scanned = 0; scanned < 1000 && names.length < 100; scanned++) {
            guard(); const entry = iterator.readSync(); if (!entry) { exhausted = true; break; }
            if (!leaf(entry.name) || !entry.isFile() || /^\.hermes-(?:work|backup)-/.test(entry.name)
              || denied.test(path.join(file, entry.name))) continue;
            const stat = statAt(directory, entry.name);
            if (stat?.isFile() && stat.nlink === 1) names.push(entry.name);
          }
        } finally { iterator.closeSync(); }
        guard();
        if (!same(expected, statAt(parent, name) || {})) fail("WORK_FILE_CHANGED");
        result = { status: "succeeded", data: { names, truncated: !exhausted } };
      } else if (request.action === "read") {
        const { buffer } = read(parent, name);
        result = { status: "succeeded", data: { name, text: buffer.toString("utf8") } };
      } else {
        let content;
        if (request.args.artifactName !== undefined) {
          if (request.args.content !== undefined || !leaf(request.args.artifactName)
            || denied.test(request.args.artifactName)) fail("WORK_FILE_SCOPE");
          const source = pinDirectory(root.path);
          if (!same(fs.fstatSync(source), { dev: root.device, ino: root.inode })) fail("WORK_FILE_CHANGED");
          content = read(source, request.args.artifactName, MAX_ARTIFACT_BYTES).buffer;
        } else {
          if (typeof request.args.content !== "string" || Buffer.byteLength(request.args.content) > MAX_BYTES) fail("WORK_FILE_SIZE");
          content = Buffer.from(request.args.content);
        }
        guard();
        const previous = statAt(parent, name);
        const writeLimit = request.args.artifactName !== undefined ? MAX_ARTIFACT_BYTES : MAX_BYTES;
        if (previous) regular(previous, writeLimit);
        const createOwned = (entry, buffer) => {
          guard();
          const fd = open(relative(parent, entry), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
          const stat = fs.fstatSync(fd); owned.push({ entry, stat });
          let offset = 0;
          while (offset < buffer.length) {
            guard();
            const bytes = fs.writeSync(fd, buffer, offset, buffer.length - offset);
            if (bytes < 1) fail("WORK_FILE_IO_FAILED");
            offset += bytes;
          }
          guard(); fs.fsyncSync(fd); close(fd);
        };
        const temporary = `.hermes-work-${randomBytes(12).toString("hex")}.tmp`;
        createOwned(temporary, content);
        let backupName;
        if (request.capability === "local_write" && previous) {
          const backup = read(parent, name, writeLimit);
          if (!same(previous, backup.stat)) fail("WORK_FILE_CHANGED");
          backupName = `.hermes-backup-${randomBytes(12).toString("hex")}`;
          createOwned(backupName, backup.buffer);
        }
        guard();
        const latest = statAt(parent, name);
        if (previous ? !latest || !same(previous, latest) || previous.mtimeMs !== latest.mtimeMs || previous.ctimeMs !== latest.ctimeMs
          : latest !== null) fail("WORK_FILE_CHANGED");
        guard();
        if (!same(owned[0].stat, statAt(parent, temporary) || {})) fail("WORK_FILE_CHANGED");
        fs.renameSync(relative(parent, temporary), relative(parent, name));
        committed = true;
        guard();
        const installed = statAt(parent, name); regular(installed, writeLimit);
        if (!same(owned[0].stat, installed)) fail("WORK_FILE_CHANGED");
        fs.fsyncSync(parent);
        result = { status: "succeeded", data: { name, bytes: content.length, ...(backupName ? { backupName } : {}) } };
      }
    } catch (error) {
      result = committed ? { status: "uncertain", code: "WORK_FILE_COMMIT_UNCERTAIN" }
        : { status: "failed", applied: false, code: codeFor(error) };
    } finally {
      // Cleanup only our unpredictable names under the pinned parent. Never
      // follow symlinks, and refuse known inode replacements. Keep backups
      // after a commit (including uncertain outcomes) for recovery.
      for (const entry of owned) {
        if (committed && !entry.entry.endsWith(".tmp")) continue;
        try {
          if (privateOnly) cleanupGuard();
          const file = path.join(descriptorPath(parent), entry.entry);
          let stat;
          try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
          if (stat && (!same(stat, entry.stat) || stat.isSymbolicLink())) cleanupFailed = true;
          else if (stat) fs.unlinkSync(file);
        } catch { cleanupFailed = true; }
      }
      for (const fd of [...fds].reverse()) { try { fs.closeSync(fd); } catch { cleanupFailed = true; } }
      if (busyRoot) busyRoots.delete(busyRoot);
    }
    return cleanupFailed ? { status: "uncertain", code: "WORK_FILE_CLEANUP_UNCERTAIN" } : result;
  } });
}
