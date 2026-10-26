import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkFileBackend } from "../src/work-local-files.js";
import { CapabilityBroker, CapabilityError, canonicalNoFollowPath, normalizeWorkGrant, operationDigest } from "../src/work-capabilities.js";
import { ensureRequestedTaskArtifactsAsync } from "../src/task-artifacts.js";

// ALL file bodies are generated fixtures. No network, model, GUI, real user
// data or TaskRuntime persistence. The actual CapabilityBroker uses a synthetic
// in-memory CAS store. On Darwin the explicitly fixture-only directory driver
// below tests adapter logic, NOT native fd-relative isolation/readiness.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "work-files-fixture-")));
const realOpen = fs.openSync, realClose = fs.closeSync, descriptors = new Map();
fs.openSync = function (...args) {
  const fd = realOpen.apply(fs, args); descriptors.set(fd, path.resolve(String(args[0]))); return fd;
};
fs.closeSync = function (fd) { const result = realClose.call(fs, fd); descriptors.delete(fd); return result; };
const fixtureDirectoryIO = Object.freeze({ verified: true, fixtureOnly: true,
  descriptorPath(fd) { assert.ok(descriptors.has(fd)); return descriptors.get(fd); } });
const fixtureOnly = { directoryIO: fixtureDirectoryIO, allowFixtures: true };
let serial = 0, passed = 0;
const test = async (name, run) => {
  const before = descriptors.size;
  try { await run(); assert.equal(descriptors.size, before, "all adapter fds closed"); passed++; }
  catch (cause) { throw new Error(name, { cause }); }
};
async function patch(method, replacement, run) {
  const original = fs[method]; fs[method] = (...args) => replacement(original, ...args);
  try { return await run(); } finally { fs[method] = original; }
}
const rejects = (run, code, status) => assert.rejects(run, error => error instanceof CapabilityError
  && error.code === code && (status === undefined || error.receipt?.status === status));
function harness(extra = {}) {
  const base = path.join(root, `case-${++serial}`), workspace = path.join(base, "workspace"), external = path.join(base, "external");
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 }); fs.mkdirSync(external);
  const h = { base, workspace, external, now: Date.UTC(2030, 0, 1), authorizations: 0, finalized: 0 };
  h.task = { id: `task_${serial}`, logicalBotId: "account:alpha", accountId: "alpha", status: "running", revision: 1,
    grantRevision: 0, attemptId: "attempt_fixture", attempt: 1, grants: [], operationLedger: [],
    confirmedBy: "member", confirmedAt: new Date(h.now).toISOString() };
  h.policy = { enabled: true, capabilities: ["isolated_files", "local_read", "local_write", "external_write"],
    ownerUserIds: ["owner"], taskWorkspace: workspace,
    baseline: { isolated_files: { actions: ["read", "list", "write"], path: workspace, recursive: true } } };
  h.backend = createWorkFileBackend({ getTask: id => id === h.task.id ? h.task : null, getWorkspace: () => h.workspace,
    finalizeArtifacts: async (_task, artifacts, _outputs, _signal, controls) => {
      h.finalized++; await Promise.resolve(); controls.check(); return { ok: true, artifacts };
    }, ...fixtureOnly, ...extra });
  h.broker = new CapabilityBroker({ getTask: id => id === h.task.id ? h.task : null, getPolicy: () => h.policy,
    getBackend: () => ({ manifest: h.backend.manifest, execute: request => h.backend.execute({ ...request,
      authorize(actual) { h.authorizations++; h.onAuthorize?.(actual); return request.authorize(actual); } }) }),
    validateIdentity: () => true, clock: () => h.now, recordOperation: async record => {
      const index = h.task.operationLedger.findIndex(row => row.operationId === record.operationId);
      if (record.status === "claimed" ? index !== -1 : index === -1 || h.task.operationLedger[index].status !== "claimed") return { ok: false };
      if (index < 0) h.task.operationLedger.push({ ...record }); else h.task.operationLedger[index] = { ...record };
      h.task.revision++; return { ok: true, durable: true };
    } });
  h.request = (action, args, capability = "isolated_files", signal) => ({ taskId: h.task.id, accountId: h.task.accountId,
    logicalBotId: h.task.logicalBotId, operationId: `operation_${++serial}`, capability, action, args, signal });
  h.run = (action, args, capability, signal) => h.broker.execute(h.request(action, args, capability, signal));
  h.grant = (capability, scope, ttl = 60000) => {
    const grant = normalizeWorkGrant(h.task, { capability, scope, expiresAt: h.now + ttl }, { userId: "owner", source: "admin" }, h.now);
    h.task.grants.push(grant); h.task.grantRevision++; return grant;
  };
  h.confirm = request => h.grant("external_write", { actions: ["send"], target: request.args.target,
    operationDigest: operationDigest(request) });
  h.unit = (action, args, capability = "isolated_files", signal, authorize) => {
    const request = h.request(action, args, capability, signal);
    return h.backend.execute({ ...request, authorize: authorize || (() => ({ fileBoundary: { path: path.resolve(args.path ?? args.target) } })) });
  };
  h.file = (name, text = "fixture", externalFile = false) => {
    const file = path.join(externalFile ? external : workspace, name); fs.writeFileSync(file, text); return file;
  };
  h.leftovers = (directory = workspace) => fs.readdirSync(directory).filter(name => /^\.hermes-(?:work|backup)-/.test(name));
  return h;
}

try {
  await test("Darwin defaults support only task-private artifacts, never host files; fixture opt-in required", async () => {
    const h = harness({ directoryIO: undefined, allowFixtures: false });
    if (process.platform === "darwin") {
      assert.equal(h.backend.manifest.verified, true);
      assert.deepEqual(h.backend.manifest.capabilities, ["isolated_files"]);
      assert.equal(h.backend.manifest.boundaryMode, "task-private-directory");
      assert.equal(h.backend.manifest.nativeOpenat, false); assert.equal(h.backend.manifest.hostFilesVerified, false);
      assert.equal(h.backend.manifest.hostileSameUidWritersIsolated, false);
      const target = h.file("input.txt", "native Mac fixture");
      assert.equal((await h.run("read", { target })).data.text, "native Mac fixture");
      await h.run("write", { path: path.join(h.workspace, "out.txt"), content: "Mac task artifact" });
      assert.equal(fs.readFileSync(path.join(h.workspace, "out.txt"), "utf8"), "Mac task artifact");
      assert.equal((await h.unit("read", { target }, "local_read")).code, "WORK_FILE_CAPABILITY_UNAVAILABLE");
      h.grant("local_read", { path: target, actions: ["read"] });
      await rejects(() => h.run("read", { target }, "local_read"), "BACKEND_UNVERIFIED");
    } else if (process.platform !== "linux") {
      assert.equal(h.backend.manifest.verified, false); assert.equal(h.backend.manifest.canonicalNoFollow, false);
      await rejects(() => h.run("read", { target: h.file("input.txt") }), "BACKEND_UNVERIFIED");
      assert.deepEqual(await h.unit("read", { target: path.join(h.workspace, "missing") }),
        { status: "failed", applied: false, code: "WORK_FILE_BOUNDARY_UNAVAILABLE" });
    }
    const unapproved = harness({ allowFixtures: false }); assert.equal(unapproved.backend.manifest.verified, false);
    assert.ok(Object.isFrozen(h.backend.manifest)); assert.ok(Object.isFrozen(h.backend.manifest.capabilities));
  });
  await test("real broker read uses fileBoundary.path and status receipt", async () => {
    const h = harness(), file = h.file("input.txt", "合成 fixture");
    const r = await h.run("read", { path: file });
    assert.equal(r.receipt.status, "succeeded"); assert.equal(r.receipt.grantId, "baseline:isolated_files");
    assert.deepEqual(r.data, { name: "input.txt", text: "合成 fixture" }); assert.ok(h.authorizations > 3);
  });
  await test("confirmed isolated writes need no external one-shot grant", async () => {
    const h = harness(), target = path.join(h.workspace, "out.txt");
    const r = await h.run("write", { target, content: "new fixture" });
    assert.equal(r.receipt.status, "succeeded"); assert.equal(r.data.bytes, 11);
    assert.equal(fs.readFileSync(target, "utf8"), "new fixture"); assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(h.task.grants.length, 0); assert.deepEqual(h.leftovers(), []);
  });
  await test("external local write requires both file grant and exact one-shot", async () => {
    const h = harness(), target = h.file("target.txt", "old", true);
    h.grant("local_write", { path: target, actions: ["write"] });
    await rejects(() => h.run("write", { target, content: "new" }, "local_write"), "EXTERNAL_CONFIRMATION_REQUIRED");
    assert.equal(fs.readFileSync(target, "utf8"), "old");
    const request = h.request("write", { target, content: "new" }, "local_write"); h.confirm(request);
    const r = await h.broker.execute(request);
    assert.equal(r.receipt.status, "succeeded"); assert.equal(fs.readFileSync(target, "utf8"), "new");
    assert.equal(fs.readFileSync(path.join(h.external, r.data.backupName), "utf8"), "old");
    assert.equal(fs.statSync(path.join(h.external, r.data.backupName)).mode & 0o777, 0o600);
    await rejects(() => h.broker.execute({ ...request, operationId: `operation_${++serial}` }), "EXTERNAL_GRANT_CONSUMED");
  });
  await test("exact external argument digest cannot be reused for different content", async () => {
    const h = harness(), target = h.file("out.txt", "old", true);
    h.grant("local_write", { path: target, actions: ["write"] });
    const request = h.request("write", { target, content: "allowed" }, "local_write"); h.confirm(request);
    await rejects(() => h.broker.execute({ ...request, args: { target, content: "different" } }), "EXTERNAL_CONFIRMATION_REQUIRED");
    assert.equal(fs.readFileSync(target, "utf8"), "old");
  });
  await test("local read grant alone never permits write", async () => {
    const h = harness(), target = h.file("private.txt", "fixture", true);
    h.grant("local_read", { path: target, actions: ["read"] });
    assert.equal((await h.run("read", { target }, "local_read")).data.text, "fixture");
    await rejects(() => h.run("write", { target, content: "bad" }, "local_write"), "GRANT_REQUIRED");
    assert.equal((await h.unit("write", { target, content: "bad" }, "local_read")).code, "WORK_FILE_ACTION");
  });
  await test("list includes only regular unprotected nonlinked fixtures", async () => {
    const h = harness(); h.file("visible.txt"); h.file(".env.local", "protected fixture");
    fs.mkdirSync(path.join(h.workspace, "directory"));
    fs.symlinkSync(path.join(h.workspace, "visible.txt"), path.join(h.workspace, "link"));
    const r = await h.run("list", { target: h.workspace }); assert.deepEqual(r.data.names, ["visible.txt"]);
  });
  await test("list is bounded at 100 entries", async () => {
    const h = harness(); for (let i = 0; i < 110; i++) h.file(`entry-${i}.txt`);
    const r = await h.run("list", { target: h.workspace });
    assert.equal(r.data.names.length, 100); assert.equal(r.data.truncated, true);
  });
  await test("symlink leaves, ancestors and workspace aliases fail closed", async () => {
    const h = harness(), source = h.file("source.txt", "external fixture", true), link = path.join(h.workspace, "link");
    fs.symlinkSync(source, link);
    await rejects(() => h.run("read", { target: link }), "PATH_SYMLINK_DENIED");
    fs.symlinkSync(h.external, path.join(h.workspace, "alias"));
    await rejects(() => h.run("read", { target: path.join(h.workspace, "alias", "source.txt") }), "PATH_SYMLINK_DENIED");
    const oldWorkspace = h.workspace; h.workspace = path.join(h.base, "workspace-link"); fs.symlinkSync(oldWorkspace, h.workspace);
    assert.notEqual((await h.unit("read", { target: source }, "local_read")).status, "succeeded");
  });
  await test("isolated scope denies traversal, sibling prefix and external fixtures", async () => {
    const h = harness(), target = h.file("outside.txt", "external", true);
    for (const file of [target, path.join(h.workspace, "..", "external", "outside.txt")]) {
      await rejects(() => h.run("read", { target: file }), "GRANT_PATH_DENIED");
      assert.equal((await h.unit("read", { target: file })).code, "WORK_FILE_SCOPE");
    }
  });
  await test("hard links are rejected even when the path is in scope", async () => {
    const h = harness(), file = h.file("original.txt"); fs.linkSync(file, path.join(h.workspace, "hard.txt"));
    assert.equal((await h.unit("read", { target: file })).code, "WORK_FILE_NOT_REGULAR");
    const r = await h.unit("write", { target: file, content: "bad" }); assert.equal(r.code, "WORK_FILE_NOT_REGULAR");
    assert.equal(fs.readFileSync(file, "utf8"), "fixture");
  });
  await test("protected file names are rejected including dotenv suffixes", async () => {
    const h = harness();
    for (const name of [".env", ".env.local", "id_rsa", "credentials", "cookies", "fixture.keychain-db"]) {
      const file = h.file(name); const r = await h.unit("read", { target: file });
      assert.equal(r.code, "WORK_PROTECTED_FILE"); assert.equal(r.data, undefined);
    }
  });
  await test("read ceiling is 128KiB and multibyte writes are counted as bytes", async () => {
    const h = harness(), file = h.file("limit.txt", "x".repeat(128 * 1024));
    assert.equal((await h.run("read", { target: file })).data.text.length, 128 * 1024);
    fs.appendFileSync(file, "x"); assert.equal((await h.unit("read", { target: file })).code, "WORK_FILE_SIZE");
    const target = path.join(h.workspace, "out.txt");
    assert.equal((await h.unit("write", { target, content: "汉".repeat(44000) })).code, "WORK_FILE_SIZE");
    assert.equal(fs.existsSync(target), false); assert.deepEqual(h.leftovers(), []);
  });
  await test("adapter exact 128KiB write succeeds; broker retains its smaller JSON envelope limit", async () => {
    const h = harness(), target = path.join(h.workspace, "large.txt"), content = "x".repeat(128 * 1024);
    assert.equal((await h.unit("write", { target, content })).status, "succeeded");
    assert.equal(fs.statSync(target).size, content.length);
    await rejects(() => h.run("write", { target, content }), "INVALID_ARGUMENTS");
  });
  await test("partial reads and writes are looped correctly without padding", async () => {
    const h = harness(), file = h.file("partial.txt", "abcdefghijk"), target = path.join(h.workspace, "written.txt");
    await patch("readSync", (original, fd, buffer, offset, length, position) => original(fd, buffer, offset, Math.min(3, length), position), async () => {
      assert.equal((await h.run("read", { target: file })).data.text, "abcdefghijk");
    });
    await patch("writeSync", (original, fd, buffer, offset, length) => original(fd, buffer, offset, Math.min(3, length)), async () => {
      await h.run("write", { target, content: "abcdefghijk" });
    });
    assert.equal(fs.readFileSync(target, "utf8"), "abcdefghijk");
  });
  await test("source growth during read fails rather than returning a truncated success", async () => {
    const h = harness(), file = h.file("grow.txt", "a"); let grew = false;
    await patch("readSync", (original, ...args) => {
      const n = original(...args); if (!grew) { grew = true; fs.appendFileSync(file, "x".repeat(128 * 1024)); } return n;
    }, async () => { await rejects(() => h.run("read", { target: file }), "BACKEND_REJECTED", "failed"); });
  });
  await test("artifact copy is bounded and backed up through actual broker", async () => {
    const h = harness(); h.file("artifact.md", "合成 artifact"); const target = h.file("export.md", "old", true);
    h.grant("local_write", { path: target, actions: ["write"] });
    const request = h.request("write", { target, artifactName: "artifact.md" }, "local_write"); h.confirm(request);
    const r = await h.broker.execute(request); assert.equal(r.receipt.status, "succeeded");
    assert.equal(fs.readFileSync(target, "utf8"), "合成 artifact");
    assert.equal(fs.readFileSync(path.join(h.external, r.data.backupName), "utf8"), "old");
  });
  await test("artifact paths, symlinks, oversized and ambiguous sources are rejected", async () => {
    const h = harness(), target = path.join(h.workspace, "out.txt");
    for (const artifactName of ["../outside.txt", "/tmp/fixture", "dir\\file", ".", "..", ".env"]) {
      assert.equal((await h.unit("write", { target, artifactName })).code, "WORK_FILE_SCOPE");
    }
    h.file("large.txt", "x".repeat(20 * 1024 * 1024 + 1));
    assert.equal((await h.unit("write", { target, artifactName: "large.txt" })).code, "WORK_FILE_SIZE");
    const source = h.file("input.txt"); fs.symlinkSync(source, path.join(h.workspace, "alias.txt"));
    assert.equal((await h.unit("write", { target, artifactName: "alias.txt" })).code, "WORK_FILE_NOT_REGULAR");
    assert.equal((await h.unit("write", { target, artifactName: "input.txt", content: "ambiguous" })).code, "WORK_FILE_SCOPE");
    assert.equal(fs.existsSync(target), false); assert.deepEqual(h.leftovers(), []);
  });
  await test("finalizeArtifacts rejects model bodies instead of passing unvalidated input to trusted helper", async () => {
    const h = harness(), args = { target: h.workspace, finalizeArtifacts: [{ name: "output.txt", content: "fixture" }] };
    const r = await h.unit("write", args); assert.equal(r.code, "WORK_FILE_FINALIZE_INPUT");
    await rejects(() => h.run("write", args), "BACKEND_REJECTED", "failed");
    assert.equal(h.finalized, 0); assert.deepEqual(fs.readdirSync(h.workspace), []);
    assert.equal(h.backend.manifest.finalizeArtifacts, true);
  });
  await test("cancellation before dispatch performs no writes", async () => {
    const h = harness(), controller = new AbortController(), target = path.join(h.workspace, "out.txt"); controller.abort();
    await rejects(() => h.run("write", { target, content: "fixture" }, "isolated_files", controller.signal), "OPERATION_ABORTED");
    assert.equal(fs.existsSync(target), false); assert.deepEqual(h.leftovers(), []);
  });
  await test("cancellation during staging preserves old target and removes temporary", async () => {
    const h = harness(), controller = new AbortController(), target = h.file("out.txt", "old");
    await patch("writeSync", (original, ...args) => { const n = original(...args); controller.abort(); return n; }, async () => {
      await rejects(() => h.run("write", { target, content: "new" }, "isolated_files", controller.signal), "OPERATION_UNCERTAIN", "uncertain");
    });
    assert.equal(fs.readFileSync(target, "utf8"), "old"); assert.deepEqual(h.leftovers(), []);
  });
  await test("grant TTL is rechecked during read; no content is returned", async () => {
    const h = harness(), target = h.file("read.txt", "private fixture", true);
    h.grant("local_read", { path: target, actions: ["read"] }, 1000);
    await patch("readSync", (original, ...args) => { const n = original(...args); h.now += 2000; return n; }, async () => {
      await rejects(() => h.run("read", { target }, "local_read"), "BACKEND_REJECTED", "failed");
    });
  });
  await test("grant expiration after staging prevents rename and cleans temporary", async () => {
    const h = harness(), target = h.file("out.txt", "old", true);
    h.grant("local_write", { path: target, actions: ["write"] }, 1000);
    const request = h.request("write", { target, content: "new" }, "local_write"); h.confirm(request);
    await patch("writeSync", (original, ...args) => { const n = original(...args); h.now += 2000; return n; }, async () => {
      await rejects(() => h.broker.execute(request), "BACKEND_REJECTED", "failed");
    });
    assert.equal(fs.readFileSync(target, "utf8"), "old"); assert.deepEqual(h.leftovers(h.external), []);
    await rejects(() => h.broker.execute(request), "OPERATION_DUPLICATE");
  });
  await test("revocation after backup cleans both owned files before commit", async () => {
    const h = harness(), target = h.file("out.txt", "old", true);
    h.grant("local_write", { path: target, actions: ["write"] });
    const request = h.request("write", { target, content: "new" }, "local_write"); h.confirm(request);
    await patch("openSync", (original, file, ...args) => {
      const fd = original(file, ...args); if (String(file).includes(".hermes-backup-")) h.task.grantRevision++; return fd;
    }, async () => { await rejects(() => h.broker.execute(request), "BACKEND_REJECTED", "failed"); });
    assert.equal(fs.readFileSync(target, "utf8"), "old"); assert.deepEqual(h.leftovers(h.external), []);
  });
  await test("authorization boundary drift is rejected instead of using cached path", async () => {
    const h = harness(), target = h.file("out.txt", "old"); let calls = 0;
    const r = await h.unit("write", { target, content: "new" }, "isolated_files", undefined, () => ({
      fileBoundary: { path: ++calls > 2 ? path.join(h.workspace, "different.txt") : target } }));
    assert.equal(r.code, "WORK_FILE_SCOPE"); assert.equal(fs.readFileSync(target, "utf8"), "old");
    assert.deepEqual(h.leftovers(), []);
  });
  await test("symlink introduced after authorization never causes a follow", async () => {
    const h = harness(), target = h.file("read.txt", "allowed"), outside = h.file("outside.txt", "must not return", true);
    let swapped = false;
    await patch("openSync", (original, file, ...args) => {
      if (String(file) === target && !swapped) { swapped = true; fs.unlinkSync(target); fs.symlinkSync(outside, target); }
      return original(file, ...args);
    }, async () => { await rejects(() => h.run("read", { target }), "BACKEND_REJECTED", "failed"); });
    assert.equal(swapped, true); assert.equal(fs.readFileSync(outside, "utf8"), "must not return");
  });
  await test("regular leaf replacement between metadata and open returns no foreign bytes", async () => {
    const h = harness(), target = h.file("read.txt", "allowed"); let swapped = false;
    await patch("openSync", (original, file, ...args) => {
      if (String(file) === target && !swapped) {
        swapped = true; fs.renameSync(target, path.join(h.workspace, "pinned-original.txt")); fs.writeFileSync(target, "different inode fixture");
      }
      return original(file, ...args);
    }, async () => { await rejects(() => h.run("read", { target }), "BACKEND_REJECTED", "failed"); });
    assert.equal(swapped, true);
  });
  await test("parent replacement is rejected without touching the external fixture", async () => {
    const h = harness(), folder = path.join(h.workspace, "folder"); fs.mkdirSync(folder);
    const target = path.join(folder, "out.txt"); fs.writeFileSync(target, "old");
    let changed = false;
    h.onAuthorize = () => { if (!changed && h.authorizations > 8) { changed = true;
      fs.renameSync(folder, path.join(h.workspace, "moved")); fs.symlinkSync(h.external, folder); } };
    await rejects(() => h.run("write", { target, content: "new" }), "BACKEND_REJECTED", "failed");
    assert.equal(fs.existsSync(path.join(h.external, "out.txt")), false);
    assert.equal(fs.readFileSync(path.join(h.workspace, "moved", "out.txt"), "utf8"), "old");
  });
  await test("zero-byte writes and fsync errors cannot become success", async () => {
    const h = harness(), target = h.file("out.txt", "old");
    await patch("writeSync", () => 0, async () => {
      await rejects(() => h.run("write", { target, content: "new" }), "BACKEND_REJECTED", "failed");
    });
    assert.equal(fs.readFileSync(target, "utf8"), "old"); assert.deepEqual(h.leftovers(), []);
    await patch("fsyncSync", () => { throw Error("synthetic failure"); }, async () => {
      await rejects(() => h.run("write", { target, content: "new" }), "BACKEND_REJECTED", "failed");
    });
    assert.equal(fs.readFileSync(target, "utf8"), "old"); assert.deepEqual(h.leftovers(), []);
  });
  await test("post-rename cancellation is uncertain, keeps backup, and is never replayed", async () => {
    const h = harness(), target = h.file("out.txt", "old", true), controller = new AbortController();
    h.grant("local_write", { path: target, actions: ["write"] });
    const request = h.request("write", { target, content: "new" }, "local_write", controller.signal); h.confirm(request);
    await patch("renameSync", (original, ...args) => { original(...args); controller.abort(); }, async () => {
      await rejects(() => h.broker.execute(request), "OPERATION_UNCERTAIN", "uncertain");
    });
    assert.equal(fs.readFileSync(target, "utf8"), "new");
    const backups = h.leftovers(h.external); assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(h.external, backups[0]), "utf8"), "old");
    await rejects(() => h.broker.execute(request), "OPERATION_DUPLICATE");
  });
  await test("post-commit grant expiry is uncertain rather than false success", async () => {
    const h = harness(), target = h.file("out.txt", "old", true);
    h.grant("local_write", { path: target, actions: ["write"] }, 1000);
    const request = h.request("write", { target, content: "new" }, "local_write"); h.confirm(request);
    await patch("renameSync", (original, ...args) => { original(...args); h.now += 2000; }, async () => {
      await rejects(() => h.broker.execute(request), "OPERATION_UNCERTAIN", "uncertain");
    });
    assert.equal(fs.readFileSync(target, "utf8"), "new"); assert.equal(h.leftovers(h.external).length, 1);
  });
  await test("destination change after backup prevents commit and removes only owned staging", async () => {
    const h = harness(), target = h.file("out.txt", "old", true); let changed = false;
    h.grant("local_write", { path: target, actions: ["write"] });
    const request = h.request("write", { target, content: "new" }, "local_write"); h.confirm(request);
    await patch("writeSync", (original, fd, ...args) => {
      const n = original(fd, ...args);
      if (!changed && descriptors.get(fd)?.includes(".hermes-backup-")) {
        changed = true; fs.renameSync(target, path.join(h.external, "original.txt")); fs.writeFileSync(target, "concurrent fixture");
      }
      return n;
    }, async () => { await rejects(() => h.broker.execute(request), "BACKEND_REJECTED", "failed"); });
    assert.equal(changed, true); assert.equal(fs.readFileSync(target, "utf8"), "concurrent fixture");
    assert.deepEqual(h.leftovers(h.external), []);
  });
  await test("staging symlink substitution never follows it or reports success", async () => {
    const h = harness(), target = h.file("out.txt", "old"), sentinel = h.file("sentinel.txt", "external sentinel", true);
    await patch("renameSync", (original, from, to) => {
      if (String(from).includes(".hermes-work-")) { fs.unlinkSync(from); fs.symlinkSync(sentinel, from); }
      return original(from, to);
    }, async () => { await rejects(() => h.run("write", { target, content: "new" }), "OPERATION_UNCERTAIN", "uncertain"); });
    assert.equal(fs.readFileSync(sentinel, "utf8"), "external sentinel");
  });
  await test("cleanup refuses a known replaced staging inode", async () => {
    const h = harness(), target = h.file("out.txt", "old"); let replacement;
    await patch("writeSync", (_original, fd) => {
      replacement = descriptors.get(fd); fs.renameSync(replacement, replacement + ".moved");
      fs.writeFileSync(replacement, "replacement fixture"); throw Error("fixture write interrupted");
    }, async () => { await rejects(() => h.run("write", { target, content: "new" }), "OPERATION_UNCERTAIN", "uncertain"); });
    assert.equal(fs.readFileSync(replacement, "utf8"), "replacement fixture");
    assert.equal(fs.readFileSync(target, "utf8"), "old");
  });
  await test("cleanup failure cannot be reported as definitely unapplied", async () => {
    const h = harness(), target = h.file("out.txt", "old");
    await patch("writeSync", () => { throw Error("synthetic partial write"); }, async () => {
      await patch("unlinkSync", (original, file) => {
        if (String(file).includes(".hermes-work-")) throw Error("synthetic unlink failure"); return original(file);
      }, async () => { await rejects(() => h.run("write", { target, content: "new" }), "OPERATION_UNCERTAIN", "uncertain"); });
    });
    assert.equal(fs.readFileSync(target, "utf8"), "old");
  });
  await test("invalid owner, mismatched aliases, async authorization and unknown fields fail closed", async () => {
    const h = harness(), target = h.file("input.txt");
    assert.equal((await h.unit("read", { target, path: path.join(h.workspace, "other") })).code, "WORK_FILE_SCOPE");
    assert.equal((await h.unit("read", { target, arbitrary: true })).code, "WORK_FILE_REQUEST");
    assert.equal((await h.unit("read", { target }, "isolated_files", undefined, async () => ({ fileBoundary: { path: target } }))).code, "WORK_FILE_SCOPE");
    const r = await h.backend.execute({ ...h.request("read", { target }), accountId: "other", authorize: () => assert.fail("owner first") });
    assert.equal(r.code, "WORK_FILE_OWNER");
  });
  await test("private task workspace must remain owner-only 0700", async () => {
    const h = harness({ directoryIO: undefined, allowFixtures: false }), target = h.file("read.txt");
    if (process.platform !== "darwin") return;
    fs.chmodSync(h.workspace, 0o755);
    await rejects(() => h.run("read", { target }), "BACKEND_REJECTED", "failed");
    assert.equal(fs.readFileSync(target, "utf8"), "fixture");
  });
  await test("default Mac text finalization passes metadata to trusted async helper", async () => {
    let called = 0;
    const h = harness({ directoryIO: undefined, allowFixtures: false,
      finalizeArtifacts: async (task, artifacts, outputs, signal, controls) => {
        called++; assert.equal(task.id, h.task.id); assert.equal(outputs, h.workspace); assert.equal(signal, undefined);
        await Promise.resolve(); controls.check(); return { ok: true, requestedPdf: false, artifacts };
      } });
    if (!h.backend.manifest.verified) return;
    const file = h.file("report.md", "合成报告正文"), size = fs.statSync(file).size;
    const r = await h.run("write", { path: h.workspace, finalizeArtifacts: [{ name: "report.md", type: "text/markdown", size }] });
    assert.equal(r.receipt.status, "succeeded"); assert.equal(called, 1);
    assert.deepEqual(r.data, { ok: true, requestedPdf: false, pdfCreated: false,
      artifacts: [{ name: "report.md", type: "text/markdown", size }] });
    assert.ok(!JSON.stringify(r.data).includes(h.workspace));
  });
  await test("async PDF fixture may exceed text input cap while remaining bounded output", async () => {
    const h = harness({ directoryIO: undefined, allowFixtures: false,
      finalizeArtifacts: async (_task, _artifacts, outputs, _signal, controls) => {
        await Promise.resolve(); controls.check();
        const bytes = Buffer.concat([Buffer.from("%PDF-synthetic-fixture\n"), Buffer.alloc(200000, 32)]);
        await fs.promises.writeFile(path.join(outputs, "report.pdf"), bytes, { flag: "wx", mode: 0o600 });
        return { ok: true, requestedPdf: true, pdfCreated: true,
          artifacts: [{ name: "report.pdf", type: "application/pdf", size: bytes.length }] };
      } });
    if (!h.backend.manifest.verified) return;
    h.file("report.md", "synthetic report");
    const r = await h.run("write", { path: h.workspace, finalizeArtifacts: [{ name: "report.md", type: "text/markdown" }] });
    assert.equal(r.receipt.status, "succeeded"); assert.equal(r.data.pdfCreated, true);
    assert.ok(r.data.artifacts[0].size > 128 * 1024);
    // This verifies adapter/receipt logic, NOT PDF rendering or GUI delivery.
  });
  await test("finalization target must be exactly the current task root", async () => {
    const h = harness(); fs.mkdirSync(path.join(h.workspace, "nested"), { mode: 0o700 });
    const r = await h.unit("write", { path: path.join(h.workspace, "nested"), finalizeArtifacts: [] });
    assert.equal(r.code, "WORK_FILE_SCOPE"); assert.equal(h.finalized, 0);
  });
  await test("missing trusted helper is unavailable only for finalization, not ordinary text", async () => {
    const h = harness({ finalizeArtifacts: undefined });
    assert.equal(h.backend.manifest.finalizeArtifacts, false);
    assert.equal((await h.unit("write", { path: h.workspace, finalizeArtifacts: [] })).code, "WORK_FILE_ACTION");
    await h.run("write", { path: path.join(h.workspace, "out.txt"), content: "ordinary" });
    assert.equal(fs.readFileSync(path.join(h.workspace, "out.txt"), "utf8"), "ordinary");
  });
  await test("finalization rejects duplicate, unsafe, missing and size-mismatched inputs", async () => {
    const h = harness(); h.file("report.md", "fixture");
    for (const artifacts of [[{ name: "../report.md", type: "text/markdown" }],
      [{ name: "missing.md", type: "text/markdown" }], [{ name: "report.md", type: "text/markdown", size: 1 }],
      [{ name: "report.md", type: "text/markdown" }, { name: "report.md", type: "text/markdown" }],
      [{ name: "report.md", type: "text/markdown", filePath: "forbidden" }]]) {
      const r = await h.unit("write", { path: h.workspace, finalizeArtifacts: artifacts });
      assert.equal(r.status, "failed"); assert.equal(r.applied, false);
    }
    assert.equal(h.finalized, 0);
  });
  await test("finalization input total, not just each file, is limited to 128KiB", async () => {
    const h = harness(); h.file("one.md", "x".repeat(70000)); h.file("two.md", "x".repeat(70000));
    const r = await h.unit("write", { path: h.workspace, finalizeArtifacts: ["one.md", "two.md"].map(name => ({ name, type: "text/markdown" })) });
    assert.equal(r.code, "WORK_FILE_SIZE"); assert.equal(h.finalized, 0);
  });
  await test("source-free helper fallback summary is limited before invocation", async () => {
    const h = harness(); h.task.resultSummary = "x".repeat(128 * 1024 + 1);
    assert.equal((await h.unit("write", { path: h.workspace, finalizeArtifacts: [] })).code, "WORK_FILE_SIZE");
    assert.equal(h.finalized, 0);
  });
  await test("pre-existing workspace symlink is rejected before helper may write", async () => {
    const h = harness(); h.file("source.md"); fs.symlinkSync(h.external, path.join(h.workspace, "alias"));
    const r = await h.unit("write", { path: h.workspace, finalizeArtifacts: [{ name: "source.md", type: "text/markdown" }] });
    assert.equal(r.code, "WORK_FILE_NOT_REGULAR"); assert.equal(h.finalized, 0);
  });
  await test("helper false result remains failed artifact generation, strips private error text", async () => {
    const h = harness({ finalizeArtifacts: async () => ({ ok: false, requestedPdf: true,
      artifacts: [], error: "SYNTH_PRIVATE_HELPER_DETAIL" }) });
    const r = await h.run("write", { path: h.workspace, finalizeArtifacts: [] });
    assert.equal(r.receipt.status, "succeeded"); assert.equal(r.data.ok, false); assert.equal(r.data.pdfCreated, false);
    assert.deepEqual(r.data.artifacts, []); assert.ok(!JSON.stringify(r.data).includes("SYNTH_PRIVATE_HELPER_DETAIL"));
  });
  await test("helper cannot claim a missing, invalid PDF or cross-workspace artifact", async () => {
    for (const name of ["missing.pdf", "bad.pdf", "../outside.pdf"]) {
      const h = harness({ finalizeArtifacts: async () => ({ ok: true, requestedPdf: true, pdfCreated: true,
        artifacts: [{ name, type: "application/pdf" }] }) });
      h.file("bad.pdf", "not a PDF");
      await rejects(() => h.run("write", { path: h.workspace, finalizeArtifacts: [] }), "OPERATION_UNCERTAIN", "uncertain");
    }
  });
  await test("helper output size claims are verified against actual bytes", async () => {
    const h = harness({ finalizeArtifacts: async () => ({ ok: true, artifacts: [{ name: "report.md", type: "text/markdown", size: 1 }] }) });
    h.file("report.md", "fixture");
    await rejects(() => h.run("write", { path: h.workspace, finalizeArtifacts: [] }), "OPERATION_UNCERTAIN", "uncertain");
  });
  await test("helper root substitution after await cannot report success", async () => {
    const h = harness({ finalizeArtifacts: async () => {
      await Promise.resolve(); fs.renameSync(h.workspace, path.join(h.base, "old-root"));
      fs.mkdirSync(h.workspace, { mode: 0o700 }); return { ok: true, artifacts: [] };
    } });
    await rejects(() => h.run("write", { path: h.workspace, finalizeArtifacts: [] }), "OPERATION_UNCERTAIN", "uncertain");
  });
  await test("helper permission drift and grant revision changes after await cannot report success", async () => {
    for (const change of [h => fs.chmodSync(h.workspace, 0o755), h => { h.task.grantRevision++; }]) {
      const h = harness({ finalizeArtifacts: async () => { await Promise.resolve(); change(h); return { ok: true, artifacts: [] }; } });
      await rejects(() => h.run("write", { path: h.workspace, finalizeArtifacts: [] }), "OPERATION_UNCERTAIN", "uncertain");
    }
  });
  await test("helper TTL expiry is rechecked even for explicitly granted isolated files", async () => {
    const h = harness({ finalizeArtifacts: async () => { await Promise.resolve(); h.now += 2000; return { ok: true, artifacts: [] }; } });
    delete h.policy.baseline;
    h.grant("isolated_files", { path: h.workspace, recursive: true, actions: ["write"] }, 1000);
    await rejects(() => h.run("write", { path: h.workspace, finalizeArtifacts: [] }), "OPERATION_UNCERTAIN", "uncertain");
  });
  await test("helper cancellation waits for real settlement; no second operation enters busy root", async () => {
    let release, entered;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const h = harness({ finalizeArtifacts: async () => { entered(); await gate; return { ok: true, artifacts: [] }; } });
    const controller = new AbortController(), source = h.file("source.md");
    const pending = h.run("write", { path: h.workspace, finalizeArtifacts: [] }, "isolated_files", controller.signal);
    await enteredPromise; controller.abort();
    await rejects(() => h.run("read", { path: source }), "BACKEND_REJECTED", "failed");
    release(); await rejects(() => pending, "OPERATION_UNCERTAIN", "uncertain");
    assert.equal((await h.run("read", { path: source })).data.text, "fixture");
  });
  await test("default Mac private mode cannot cross into another task workspace", async () => {
    if (process.platform !== "darwin") return;
    const h = harness({ directoryIO: undefined, allowFixtures: false });
    const peer = harness({ directoryIO: undefined, allowFixtures: false }), target = peer.file("peer.txt", "peer fixture");
    await rejects(() => h.run("read", { target }), "GRANT_PATH_DENIED");
    assert.equal((await h.unit("write", { target, content: "not allowed" })).code, "WORK_FILE_SCOPE");
    assert.equal(fs.readFileSync(target, "utf8"), "peer fixture");
  });
  await test("oversized finalized binary cannot become a successful artifact receipt", async () => {
    const h = harness({ finalizeArtifacts: async (_task, _input, outputs) => {
      const file = path.join(outputs, "large.pdf");
      fs.writeFileSync(file, "%PDF-fixture", { mode: 0o600 }); fs.truncateSync(file, 20 * 1024 * 1024 + 1);
      return { ok: true, requestedPdf: true, artifacts: [{ name: "large.pdf", type: "application/pdf" }] };
    } });
    await rejects(() => h.run("write", { path: h.workspace, finalizeArtifacts: [] }), "OPERATION_UNCERTAIN", "uncertain");
  });
  await test("private-mode cleanup never traverses a replaced directory path", async () => {
    if (process.platform !== "darwin") return;
    const h = harness({ directoryIO: undefined, allowFixtures: false }), folder = path.join(h.workspace, "folder");
    fs.mkdirSync(folder, { mode: 0o700 }); const target = path.join(folder, "out.txt"); fs.writeFileSync(target, "old");
    let temporary, changed = false, unsafeCleanup = false;
    await patch("lstatSync", (original, file, ...args) => {
      if (changed && String(file) === temporary) unsafeCleanup = true;
      return original(file, ...args);
    }, async () => {
      await patch("writeSync", (original, fd, ...args) => {
        const n = original(fd, ...args);
        if (!changed) {
          temporary = descriptors.get(fd); fs.renameSync(folder, path.join(h.workspace, "moved"));
          fs.symlinkSync(h.external, folder); changed = true;
        }
        return n;
      }, async () => { await rejects(() => h.run("write", { target, content: "new" }), "OPERATION_UNCERTAIN", "uncertain"); });
    });
    assert.equal(changed, true); assert.equal(unsafeCleanup, false);
    assert.equal(fs.readFileSync(path.join(h.workspace, "moved", "out.txt"), "utf8"), "old");
    assert.deepEqual(fs.readdirSync(h.external), []);
  });
  for (const pdf of [false, true]) await test(`actual async artifact helper with no renderer: ${pdf ? "existing PDF-header fixture" : "text"}`, async () => {
    const h = harness({ directoryIO: undefined, allowFixtures: false,
      finalizeArtifacts: async (task, artifacts, outputsDir, signal, controls) => {
        controls.check();
        return ensureRequestedTaskArtifactsAsync({ task, artifacts, outputsDir, signal,
          findChrome: () => assert.fail("no renderer is permitted"), findPandoc: () => assert.fail("no native process is permitted") });
      } });
    if (!h.backend.manifest.verified) return;
    h.task.objective = pdf ? "PDF fixture" : "text fixture";
    const name = pdf ? "existing.pdf" : "report.md", type = pdf ? "application/pdf" : "text/markdown";
    h.file(name, pdf ? "%PDF-synthetic-header-only-fixture\n" : "synthetic text");
    const r = await h.run("write", { path: h.workspace, finalizeArtifacts: [{ name, type }] });
    assert.equal(r.receipt.status, "succeeded"); assert.equal(r.data.ok, true); assert.equal(r.data.pdfCreated, pdf);
    assert.equal(r.data.artifacts[0].name, name);
  });
  console.log(JSON.stringify({ ok: true, tests: passed, actualCapabilityBroker: true, fixtureOnly: true,
    darwinPrivateWorkspaceExercised: process.platform === "darwin", nativeDirectoryBoundaryVerified: false,
    realPdfRendererExercised: false, modelCalls: 0, realUserFiles: 0 }));
} finally {
  fs.openSync = realOpen; fs.closeSync = realClose;
  for (const fd of descriptors.keys()) { try { realClose(fd); } catch { /* fixture cleanup */ } }
  fs.rmSync(root, { recursive: true, force: true });
}
