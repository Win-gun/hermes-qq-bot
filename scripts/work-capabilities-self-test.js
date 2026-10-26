import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CapabilityBroker, CapabilityError, WORK_CAPABILITIES, canonicalNoFollowPath, normalizeWorkGrant, operationDigest } from "../src/work-capabilities.js";
import { TaskRuntime, publicTask } from "../src/task-runtime.js";
import { createTaskDelivery } from "../src/task-delivery.js";

// Synthetic state only. No model, protocol, network, shell, GUI, browser or
// installed Hermes imports. Fixture adapters explicitly attest verified:true;
// they merely increment counters and never perform the operation being tested.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qq-work-capability-test-")));
const owner = { userId: "owner", source: "admin" };
const passed = [];
let serial = 0;
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function until(predicate) {
  for (let index = 0; index < 300; index += 1) { if (predicate()) return; await delay(2); }
  throw new Error("fixture timed out");
}
async function test(name, run) { await run(); passed.push(name); }
const rejects = (run, code) => assert.rejects(run, error => error instanceof CapabilityError && error.code === code);

function harness() {
  const h = { now: Date.UTC(2030, 0, 1), calls: 0, records: [], identity: true };
  h.config = { taskMode: { workspaceBaseDir: "tasks", ownerUserIds: ["owner"], allowedGroupIds: ["fixture"] } };
  h.runtime = new TaskRuntime({ rootDir: path.join(root, `case-${serial++}`), config: () => h.config,
    clock: () => h.now, execute: async () => ({ ok: true }), notify: async () => true });
  h.runtime.pump = async () => {}; // Exercise lifecycle explicitly, not on timers.
  h.task = h.runtime.createOffer({ accountId: "a", conversationId: "group:fixture", groupId: "fixture", userId: "member", objective: "synthetic document" });
  assert.equal(h.runtime.confirm(h.task.id, { userId: "member", source: "qq" }).ok, true);
  h.task.status = "running";
  h.task.attempt = 1;
  h.task.attemptId = "attempt_fixture";
  h.runtime.persist(h.task);
  h.workspace = fs.realpathSync(h.runtime.outputsDir(h.task.id));
  h.file = path.join(h.workspace, "input.txt");
  fs.writeFileSync(h.file, "synthetic content");
  h.policy = { enabled: true, capabilities: Object.keys(WORK_CAPABILITIES), ownerUserIds: ["owner"], taskWorkspace: h.workspace,
    baseline: { public_web: { actions: ["search", "fetch"], domains: ["example.org"] },
      isolated_files: { actions: ["read", "list", "write"], path: h.workspace, recursive: true } } };
  h.backend = { manifest: { id: "fixture-only", fixtureOnly: true, verified: true, capabilities: Object.keys(WORK_CAPABILITIES),
    enforcesScope: true, rechecksAuthorization: true, noAutomaticRetries: true, publicNetworkOnly: true,
    canonicalNoFollow: true, isolated: true, networkDisabled: true, readOnlyActions: ["read", "snapshot"] },
    execute: async request => { h.lastAuthorization = request.authorize({ target: request.args.target }); h.calls += 1; return { status: "succeeded", data: "fixture" }; } };
  h.record = async record => { h.records.push(record); return h.runtime.recordOperation(record); };
  h.newBroker = () => new CapabilityBroker({ getTask: id => h.runtime.get(id), getPolicy: () => h.policy,
    getBackend: (...args) => h.lookup ? h.lookup(...args) : h.backend,
    validateIdentity: () => h.identity, recordOperation: record => h.record(record), clock: () => h.now });
  h.broker = h.newBroker();
  h.request = (patch = {}) => ({ taskId: h.task.id, logicalBotId: "account:a", accountId: "a",
    operationId: `op_${serial++}`, capability: "public_web", action: "search", args: { query: "synthetic" }, ...patch });
  h.grant = (capability, scope, extra = {}) => {
    const result = h.runtime.grant(h.task.id, { capability, scope, ...extra }, owner);
    assert.equal(result.ok, true, result.code);
    return h.task.grants.find(grant => grant.id === result.grant.id);
  };
  h.confirmExternal = request => h.grant("external_write", { actions: ["send"], target: request.args.target, operationDigest: operationDigest(request) });
  h.input = () => {
    h.grant("desktop_input", { actions: ["click", "type"], apps: ["fixture.app"] });
    const request = h.request({ capability: "desktop_input", action: "click", args: { app: "fixture.app", target: "fixture-target", x: 1 } });
    h.confirmExternal(request);
    return request;
  };
  return h;
}

try {
  await test("persist-monotonic-revision-durable-before-projection", async () => {
    const h = harness(), revision = h.task.revision;
    const seen = [];
    h.runtime.subscribeState(snapshot => {
      const disk = JSON.parse(fs.readFileSync(h.runtime.taskPath(snapshot.id), "utf8"));
      assert.ok(disk.revision >= snapshot.revision);
      seen.push(snapshot.revision);
    });
    h.task.summary = "changed"; h.runtime.persist(h.task);
    assert.equal(h.task.revision, revision + 1);
    assert.equal(seen.length, 0);
    await h.runtime.stateBarrier();
    assert.deepEqual(seen, [revision + 1]);
  });
  await test("replay-detached-frozen-redacted-snapshot-only", async () => {
    const h = harness();
    h.grant("local_read", { target: h.file, actions: ["read"] });
    const seen = [];
    const unsubscribe = h.runtime.subscribeState((snapshot, metadata) => { seen.push(snapshot); assert.equal(metadata.replay, true); }, { replay: true });
    await h.runtime.stateBarrier(); unsubscribe();
    assert.equal(seen.length, 1); assert.equal(h.calls, 0);
    assert.ok(Object.isFrozen(seen[0])); assert.ok(Object.isFrozen(seen[0].grants));
    assert.equal(seen[0].grants[0].scope.path, undefined);
    assert.ok(!JSON.stringify(seen[0].grants).includes(h.workspace));
    assert.equal(h.runtime.get(h.task.id).grants[0].scope.path, h.file);
  });
  await test("slow-or-failed-projection-cannot-block-task-or-other-listeners", async () => {
    const h = harness(), gate = deferred(); let completed = false;
    h.runtime.subscribeState(async () => { await gate.promise; throw new Error("fixture"); });
    h.runtime.subscribeState(() => { completed = true; });
    h.runtime.persist(h.task);
    await until(() => completed);
    assert.equal(h.runtime.get(h.task.id).revision, h.task.revision);
    gate.resolve(); await rejects(() => h.runtime.stateBarrier(), "TASK_STATE_PROJECTION_FAILED");
    assert.deepEqual(await h.runtime.stateBarrier(), { ok: true });
  });
  await test("attempt-count-and-host-attemptId-change-on-resume", async () => {
    const h = harness(); const original = h.task.attemptId;
    await h.runtime.run(h.task);
    assert.equal(h.task.attempt, 2); assert.notEqual(h.task.attemptId, original);
    const first = h.task.attemptId;
    assert.equal(h.runtime.resume(h.task.id, owner).ok, false, "completed tasks cannot replay");
    h.task.status = "failed"; h.runtime.persist(h.task);
    assert.equal(h.runtime.resume(h.task.id, owner).ok, true);
    await h.runtime.run(h.task);
    assert.equal(h.task.attempt, 3); assert.notEqual(h.task.attemptId, first);
  });
  await test("legacy-read-write-inputs-map-to-bound-versioned-grants", async () => {
    const h = harness();
    for (const type of ["read", "write"]) {
      const result = h.runtime.grant(h.task.id, { type, target: h.file }, owner);
      assert.equal(result.ok, true); const g = result.grant;
      assert.equal(g.version, 1); assert.equal(g.taskId, h.task.id); assert.equal(g.accountId, "a"); assert.equal(g.logicalBotId, "account:a");
      assert.equal(g.humanActor.userId, "owner"); assert.equal(g.capability, `local_${type}`);
      assert.equal(Date.parse(g.expiresAt) - h.now, 15 * 60_000);
    }
    assert.equal(h.task.grantRevision, 2);
  });
  await test("unversioned-stored-grants-never-auto-authorize", async () => {
    const h = harness(); delete h.policy.baseline;
    h.task.grants = [{ type: "read", target: h.file }, { type: "computer", target: "any purpose" }]; h.runtime.persist(h.task);
    await rejects(() => h.broker.execute(h.request({ capability: "local_read", action: "read", args: { target: h.file } })), "GRANT_REQUIRED");
    assert.equal(h.calls, 0); assert.equal(h.task.grants[0].version, undefined);
  });
  await test("legacy-computer-never-disables-isolation", async () => {
    const h = harness();
    assert.equal(h.runtime.grant(h.task.id, { type: "computer", target: "anything" }, owner).code, "LEGACY_COMPUTER_DENIED");
    assert.equal(h.task.grants.length, 0);
  });
  for (const capability of ["browser", "desktop_observe", "desktop_input", "app", "code", "external_write"]) {
    await test(`structured-scope-required-${capability}`, async () => {
      const h = harness(); assert.equal(h.runtime.grant(h.task.id, { type: capability, target: "any purpose" }, owner).ok, false);
    });
  }
  await test("human-actor-not-model-nor-cross-owner", async () => {
    const h = harness();
    for (const actor of [{ userId: "member" }, { userId: "owner", source: "model" }, { ...owner, accountId: "b" }, { ...owner, logicalBotId: "account:b" }]) {
      assert.equal(h.runtime.grant(h.task.id, { type: "read", target: h.file }, actor).ok, false);
    }
  });
  await test("grant-ttl-hard-limit-and-one-shot-two-minute-limit", async () => {
    const h = harness();
    assert.equal(h.runtime.grant(h.task.id, { type: "read", target: h.file, expiresAt: h.now + 3_600_001 }, owner).code, "GRANT_EXPIRY_INVALID");
    assert.equal(h.runtime.grant(h.task.id, { type: "read", target: h.file, expiresAt: h.now }, owner).ok, false);
    const scope = { actions: ["post"], target: "fixture", operationDigest: "a".repeat(64) };
    assert.equal(h.runtime.grant(h.task.id, { capability: "external_write", scope, expiresAt: h.now + 120_001 }, owner).ok, false);
    const g = h.grant("external_write", scope); assert.equal(Date.parse(g.expiresAt) - h.now, 120_000); assert.equal(g.scope.oneShot, true);
  });
  await test("expired-grant-blocks-new-operation", async () => {
    const h = harness(); const g = h.grant("local_read", { path: h.file, actions: ["read"] }); h.now = Date.parse(g.expiresAt);
    await rejects(() => h.broker.execute(h.request({ capability: "local_read", action: "read", args: { path: h.file } })), "GRANT_REQUIRED");
    assert.equal(h.calls, 0);
  });
  await test("revoke-increments-authority-and-aborts-controller", async () => {
    const h = harness(), g = h.grant("local_read", { path: h.file, actions: ["read"] }), controller = new AbortController();
    h.runtime.controllers.set(h.task.id, controller); h.runtime.running.add(h.task.id);
    const revision = h.task.grantRevision;
    assert.equal(h.runtime.revoke(h.task.id, g.id, owner).ok, true);
    assert.equal(controller.signal.aborted, true); assert.equal(h.task.grantRevision, revision + 1);
    assert.equal(h.task.status, "waiting_permission");
    h.runtime.running.clear(); h.runtime.controllers.clear();
    h.task.status = "running"; h.runtime.persist(h.task);
    await rejects(() => h.broker.execute(h.request({ capability: "local_read", action: "read", args: { path: h.file } })), "GRANT_REQUIRED");
  });
  await test("mismatched-grant-task-or-owner-cannot-authorize", async () => {
    for (const field of ["taskId", "accountId", "logicalBotId"]) {
      const h = harness(), g = h.grant("local_read", { path: h.file, actions: ["read"] }); g[field] = "wrong";
      await rejects(() => h.broker.execute(h.request({ capability: "local_read", action: "read", args: { path: h.file } })), "GRANT_REQUIRED");
    }
  });
  await test("group-confirmed-baseline-public-research-needs-no-owner-grant", async () => {
    const h = harness(); h.policy.ownerUserIds = [];
    const result = await h.broker.execute(h.request());
    assert.equal(h.task.confirmedBy, "member"); assert.equal(h.task.permissionTier, "isolated");
    assert.equal(result.data, "fixture"); assert.equal(result.receipt.grantId, "baseline:public_web");
    assert.deepEqual(h.task.operationLedger.map(x => x.status), ["succeeded"]);
  });
  await test("baseline-files-stay-inside-this-task-workspace-with-target-alias", async () => {
    const h = harness(); h.policy.ownerUserIds = [];
    await h.broker.execute(h.request({ capability: "isolated_files", action: "read", args: { target: h.file } }));
    assert.equal(h.lastAuthorization.fileBoundary.path, h.file);
    await h.broker.execute(h.request({ capability: "isolated_files", action: "write", args: { target: path.join(h.workspace, "new.txt"), content: "fixture" } }));
    assert.equal(h.calls, 2); assert.equal(h.task.grants.length, 0);
  });
  await test("baseline-requires-persisted-confirmation", async () => {
    for (const field of ["confirmedBy", "confirmedAt"]) {
      const h = harness(); delete h.task[field]; h.runtime.persist(h.task);
      await rejects(() => h.broker.execute(h.request()), "GRANT_REQUIRED");
    }
  });
  await test("baseline-cannot-select-another-workspace", async () => {
    const h = harness(); h.policy.baseline.isolated_files.path = root;
    await rejects(() => h.broker.execute(h.request({ capability: "isolated_files", action: "read", args: { path: h.file } })), "BASELINE_WORKSPACE_DENIED");
  });
  await test("baseline-does-not-imply-publication-or-host-file-authority", async () => {
    const h = harness();
    await rejects(() => h.broker.execute(h.request({ capability: "local_write", action: "write", args: { target: h.file } })), "GRANT_REQUIRED");
    await rejects(() => h.broker.execute(h.request({ capability: "external_write", action: "post", args: { target: "fixture" } })), "GRANT_REQUIRED");
  });
  for (const field of ["accountId", "logicalBotId"]) await test(`request-identity-mismatch-${field}`, async () => {
    const h = harness(); await rejects(() => h.broker.execute(h.request({ [field]: "wrong" })), "TASK_IDENTITY_MISMATCH");
  });
  await test("stale-host-identity-and-disabled-policy-block-dispatch", async () => {
    const h = harness(); h.identity = false;
    await rejects(() => h.broker.execute(h.request()), "TASK_IDENTITY_STALE");
    h.identity = true; h.policy.enabled = false;
    await rejects(() => h.broker.execute(h.request()), "CAPABILITY_POLICY_DENIED");
  });
  for (const status of ["offered", "queued", "waiting_permission", "completed", "cancelled", "interrupted", "failed"]) await test(`non-execution-state-denied-${status}`, async () => {
    const h = harness(); h.task.status = status;
    await rejects(() => h.broker.execute(h.request()), "TASK_NOT_ACTIVE");
  });
  await test("backend-missing-unverified-and-unsupported-fail-closed", async () => {
    const h = harness(); h.backend = null;
    await rejects(() => h.broker.execute(h.request()), "BACKEND_UNAVAILABLE");
    const other = harness(); other.backend.manifest.verified = false;
    await rejects(() => other.broker.execute(other.request()), "BACKEND_UNVERIFIED");
    const unsupported = harness(); unsupported.backend.manifest.capabilities = [];
    await rejects(() => unsupported.broker.execute(unsupported.request()), "BACKEND_UNVERIFIED");
    assert.equal(h.calls + other.calls + unsupported.calls, 0);
  });
  for (const flag of ["enforcesScope", "rechecksAuthorization", "noAutomaticRetries"]) await test(`backend-boundary-attestation-required-${flag}`, async () => {
    const h = harness(); h.backend.manifest[flag] = false;
    await rejects(() => h.broker.execute(h.request()), "BACKEND_BOUNDARY_UNVERIFIED");
  });
  await test("isolated-and-network-and-file-boundaries-are-required", async () => {
    const h = harness(); h.backend.manifest.isolated = false;
    await rejects(() => h.broker.execute(h.request({ capability: "isolated_files", action: "read", args: { path: h.file } })), "BACKEND_ISOLATION_UNVERIFIED");
    h.backend.manifest.isolated = true; h.backend.manifest.canonicalNoFollow = false;
    await rejects(() => h.broker.execute(h.request({ capability: "isolated_files", action: "read", args: { path: h.file } })), "BACKEND_FILE_BOUNDARY_UNVERIFIED");
    h.backend.manifest.publicNetworkOnly = false;
    await rejects(() => h.broker.execute(h.request()), "BACKEND_NETWORK_BOUNDARY_UNVERIFIED");
  });
  await test("identity-attempt-and-grant-rechecked-after-backend-await", async () => {
    for (const change of [h => { h.identity = false; }, h => { h.task.attemptId = "attempt_new"; }, h => { h.task.grantRevision++; }]) {
      const h = harness(), gate = deferred(); h.lookup = async () => { await gate.promise; return h.backend; };
      const request = h.broker.execute(h.request()); change(h); gate.resolve();
      await assert.rejects(request, error => ["TASK_IDENTITY_STALE", "TASK_AUTHORITY_CHANGED"].includes(error.code)); assert.equal(h.calls, 0);
    }
  });
  await test("exact-domain-policy-does-not-trust-readOnly-or-authorized-prose", async () => {
    const h = harness();
    for (const url of ["http://127.0.0.1", "https://evil.example.org", "https://example.org.evil.net", "file:///etc/passwd", "https://user@example.org", "https://example.org:6200"]) {
      await rejects(() => h.broker.execute(h.request({ action: "fetch", args: { url, readOnly: true, authorized: true } })), "GRANT_DOMAIN_DENIED");
    }
    await h.broker.execute(h.request({ action: "fetch", args: { url: "https://example.org/fixture" } }));
    assert.equal(h.calls, 1);
  });
  await test("file-symlink-leaf-and-ancestor-are-denied", async () => {
    const h = harness(), link = path.join(h.workspace, "link.txt"), dirLink = path.join(h.workspace, "linked-dir");
    fs.symlinkSync(h.file, link); fs.symlinkSync(h.workspace, dirLink);
    for (const target of [link, path.join(dirLink, "input.txt")]) {
      await rejects(() => h.broker.execute(h.request({ capability: "isolated_files", action: "read", args: { target } })), "PATH_SYMLINK_DENIED");
    }
    assert.equal(h.calls, 0);
  });
  await test("path-escape-sibling-prefix-and-nonregular-file-are-denied", async () => {
    const h = harness();
    const outside = path.join(root, "outside.txt"); fs.writeFileSync(outside, "fixture");
    await rejects(() => h.broker.execute(h.request({ capability: "isolated_files", action: "read", args: { path: outside } })), "GRANT_PATH_DENIED");
    h.grant("local_read", { path: h.workspace, actions: ["read"] });
    await rejects(() => h.broker.execute(h.request({ capability: "local_read", action: "read", args: { path: h.workspace } })), "PATH_NOT_REGULAR");
    assert.throws(() => canonicalNoFollowPath("relative.txt"), error => error.code === "PATH_INVALID");
  });
  await test("multiple-explicit-grants-select-the-actual-matching-path", async () => {
    const h = harness(); h.grant("local_read", { path: root, actions: ["read"] }); h.grant("local_read", { path: h.file, actions: ["read"] });
    await h.broker.execute(h.request({ capability: "local_read", action: "read", args: { path: h.file } })); assert.equal(h.calls, 1);
  });
  await test("host-file-write-needs-independent-exact-one-shot-confirmation", async () => {
    const h = harness(), target = path.join(h.workspace, "host-write.txt");
    h.grant("local_write", { target, actions: ["write"] });
    const request = h.request({ capability: "local_write", action: "write", args: { target, content: "fixture" } });
    await rejects(() => h.broker.execute(request), "EXTERNAL_CONFIRMATION_REQUIRED");
    const confirmed = { ...request, operationId: `op_${serial++}` }; h.confirmExternal(confirmed);
    await h.broker.execute(confirmed); assert.equal(h.lastAuthorization.fileBoundary.path, target);
  });
  for (const action of ["click", "fill", "upload"]) await test(`browser-${action}-cannot-self-classify-readonly`, async () => {
    const h = harness();
    h.grant("isolated_browser", { actions: [action], domains: ["example.org"], sessionId: "fixture_session" });
    h.backend.manifest.readOnlyActions.push(action);
    await rejects(() => h.broker.execute(h.request({ capability: "isolated_browser", action, args: { sessionId: "fixture_session", target: "fixture", readOnly: true, authorized: true } })), "EXTERNAL_CONFIRMATION_REQUIRED");
  });
  await test("desktop-app-authority-is-not-publish-confirmation", async () => {
    const h = harness(); h.grant("desktop_input", { actions: ["click"], apps: ["fixture.app"] });
    await rejects(() => h.broker.execute(h.request({ capability: "desktop_input", action: "click", args: { app: "fixture.app", target: "fixture", authorized: true } })), "EXTERNAL_CONFIRMATION_REQUIRED");
    h.grant("app", { actions: ["launch"], apps: ["fixture.app"] });
    await rejects(() => h.broker.execute(h.request({ capability: "app", action: "launch", args: { app: "fixture.app", target: "fixture" } })), "EXTERNAL_CONFIRMATION_REQUIRED");
  });
  await test("external-digest-binds-arguments-and-target-exactly", async () => {
    const h = harness(), request = h.input();
    await rejects(() => h.broker.execute({ ...request, args: { ...request.args, x: 2 } }), "EXTERNAL_CONFIRMATION_REQUIRED");
    await rejects(() => h.broker.execute({ ...request, operationId: `op_${serial++}`, args: { ...request.args, target: "another-target" } }), "EXTERNAL_CONFIRMATION_REQUIRED");
  });
  await test("external-confirmation-is-consumed-even-with-a-new-operationId", async () => {
    const h = harness(), request = h.input(); await h.broker.execute(request);
    await rejects(() => h.newBroker().execute({ ...request, operationId: `op_${serial++}` }), "EXTERNAL_GRANT_CONSUMED"); assert.equal(h.calls, 1);
  });
  await test("new-human-confirmation-is-not-shadowed-by-a-consumed-grant", async () => {
    const h = harness(), first = h.input(); await h.broker.execute(first);
    const next = { ...first, operationId: `op_${serial++}` }; h.confirmExternal(next);
    await h.broker.execute(next); assert.equal(h.calls, 2);
    assert.notEqual(h.task.operationLedger[0].externalGrantId, h.task.operationLedger[1].externalGrantId);
  });
  await test("backend-actual-target-must-match-confirmed-target", async () => {
    const h = harness(), request = h.input(); h.backend.execute = async r => { r.authorize({ target: "different" }); h.calls++; return { status: "succeeded" }; };
    await rejects(() => h.broker.execute(request), "OPERATION_UNCERTAIN"); assert.equal(h.calls, 0);
  });
  await test("duplicate-operation-denied-within-and-across-broker-instances", async () => {
    const h = harness(), request = h.request(); await h.broker.execute(request);
    await rejects(() => h.broker.execute(request), "OPERATION_DUPLICATE");
    await rejects(() => h.newBroker().execute(request), "OPERATION_DUPLICATE"); assert.equal(h.calls, 1);
  });
  await test("concurrent-brokers-cannot-claim-the-same-operation-twice", async () => {
    const h = harness(), gate = deferred(), entered = deferred(), request = h.request();
    h.backend.execute = async r => { r.authorize(); h.calls++; entered.resolve(); await gate.promise; return { status: "succeeded" }; };
    const settled = Promise.allSettled([h.broker.execute(request), h.newBroker().execute(request)]);
    await entered.promise; gate.resolve(); const results = await settled;
    assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
    assert.equal(results.find(x => x.status === "rejected").reason.code, "OPERATION_DUPLICATE"); assert.equal(h.calls, 1);
  });
  await test("concurrent-different-sideeffects-are-not-a-second-work-queue", async () => {
    const h = harness(), gate = deferred(), entered = deferred(), first = h.input(), next = h.input();
    h.backend.execute = async r => { r.authorize({ target: r.args.target }); h.calls++; entered.resolve(); await gate.promise; return { status: "succeeded" }; };
    const settled = Promise.allSettled([h.broker.execute(first), h.newBroker().execute(next)]);
    await entered.promise; gate.resolve(); const results = await settled;
    assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
    assert.equal(results.find(x => x.status === "rejected").reason.code, "UNRESOLVED_SIDE_EFFECT"); assert.equal(h.calls, 1);
  });
  await test("claim-must-be-durable-before-backend-entry", async () => {
    const h = harness(), gate = deferred(); let claimed = false;
    h.record = async record => { h.records.push(record); if (record.status === "claimed") { claimed = true; await gate.promise; } return h.runtime.recordOperation(record); };
    const execution = h.broker.execute(h.request()); await until(() => claimed);
    assert.equal(h.calls, 0); gate.resolve(); await execution; assert.equal(h.calls, 1);
  });
  await test("claim-persistence-failure-can-never-wire", async () => {
    const h = harness(); h.record = async () => { throw new Error("synthetic disk failure"); };
    await rejects(() => h.broker.execute(h.request()), "OPERATION_DURABILITY_UNKNOWN"); assert.equal(h.calls, 0);
    h.record = record => h.runtime.recordOperation(record);
    await rejects(() => h.broker.execute(h.request()), "OPERATION_DURABILITY_UNKNOWN");
  });
  await test("void-or-nondurable-record-ack-is-rejected", async () => {
    for (const acknowledgement of [undefined, true, { ok: true }, { ok: true, durable: false }]) {
      const h = harness(); h.record = async () => acknowledgement;
      await rejects(() => h.broker.execute(h.request()), "OPERATION_DURABILITY_UNKNOWN"); assert.equal(h.calls, 0);
    }
  });
  await test("failed-terminal-persistence-leaves-claimed-and-blocks-fresh-broker", async () => {
    const h = harness(), request = h.input();
    h.record = async record => { if (record.status !== "claimed") throw new Error("synthetic disk failure"); return h.runtime.recordOperation(record); };
    await rejects(() => h.broker.execute(request), "OPERATION_DURABILITY_UNKNOWN"); assert.equal(h.calls, 1);
    assert.equal(h.task.operationLedger[0].status, "claimed");
    const another = h.input(); await rejects(() => h.newBroker().execute(another), "UNRESOLVED_SIDE_EFFECT");
  });
  await test("uncertain-effect-blocks-new-id-resume-and-restart-replay", async () => {
    const h = harness(), request = h.input(); h.backend.execute = async r => { r.authorize({ target: r.args.target }); h.calls++; throw new Error("timeout after possible wire"); };
    await rejects(() => h.broker.execute(request), "OPERATION_UNCERTAIN");
    assert.equal(h.task.operationLedger[0].status, "uncertain");
    const another = h.input(); await rejects(() => h.newBroker().execute(another), "UNRESOLVED_SIDE_EFFECT");
    h.task.status = "failed"; h.runtime.persist(h.task);
    assert.equal(h.runtime.resume(h.task.id, owner).code, "UNRESOLVED_SIDE_EFFECT");
    const restarted = new TaskRuntime({ rootDir: h.runtime.rootDir, config: h.config, execute: async () => { throw new Error("must never replay"); }, notify: async () => {} });
    assert.equal(restarted.get(h.task.id).operationLedger[0].status, "uncertain");
    assert.equal(restarted.resume(h.task.id, owner).code, "UNRESOLVED_SIDE_EFFECT"); assert.equal(restarted.queue.length, 0);
  });
  for (const status of ["claimed", "uncertain"]) await test(`notification-only-${status}-does-not-block-explicit-resume`, async () => {
    const h = harness(), oldAttempt = h.task.attemptId;
    h.task.deliveryLedger = [{ id: `delivery_${status}`, attemptId: oldAttempt, status }];
    h.task.status = "failed"; h.runtime.persist(h.task);
    assert.equal(h.runtime.resume(h.task.id, owner).ok, true);
    await h.runtime.run(h.task);
    assert.equal(h.task.status, "completed"); assert.notEqual(h.task.attemptId, oldAttempt);
    assert.deepEqual(h.task.deliveryLedger, [{ id: `delivery_${status}`, attemptId: oldAttempt, status }]);
    assert.equal(h.calls, 0);
  });
  await test("actual-delivery-claim-dedups-old-attempt-but-allows-confirmed-new-attempt", async () => {
    const h = harness();
    const prepare = createTaskDelivery({ getTask: id => h.runtime.get(id), persist: task => h.runtime.persist(task), isCurrent: () => true });
    const first = prepare(h.task, { key: "completion-notice" }); first.onSendStarted(); first.settle(false);
    assert.equal(prepare(h.task, { key: "completion-notice" }).isCurrent(), false);
    const previousId = h.task.deliveryLedger[0].id;
    h.task.status = "failed"; h.runtime.persist(h.task);
    assert.equal(h.runtime.resume(h.task.id, owner).ok, true); await h.runtime.run(h.task);
    const next = prepare(h.task, { key: "completion-notice" }); assert.equal(next.isCurrent(), true); next.onSendStarted();
    assert.equal(h.task.deliveryLedger.length, 2); assert.notEqual(h.task.deliveryLedger[1].id, previousId);
    assert.equal(h.task.deliveryLedger[0].status, "uncertain");
  });
  await test("notification-ledger-never-clears-an-uncertain-execution-effect", async () => {
    const h = harness(), request = h.input();
    h.backend.execute = async r => { r.authorize({ target: r.args.target }); throw new Error("synthetic unknown execution"); };
    await rejects(() => h.broker.execute(request), "OPERATION_UNCERTAIN");
    h.task.deliveryLedger = [{ id: "delivery_fixture", attemptId: h.task.attemptId, status: "uncertain" }];
    h.task.status = "failed"; h.runtime.persist(h.task);
    const result = h.runtime.resume(h.task.id, owner);
    assert.equal(result.code, "UNRESOLVED_SIDE_EFFECT"); assert.match(result.reason, /执行副作用/);
    assert.equal(h.task.operationLedger[0].status, "uncertain");
  });
  await test("explicit-unapplied-failure-is-distinct-from-uncertain", async () => {
    const h = harness(), request = h.input(); h.backend.execute = async () => ({ status: "failed", applied: false });
    await rejects(() => h.broker.execute(request), "BACKEND_REJECTED"); assert.equal(h.task.operationLedger[0].status, "failed");
    assert.equal(h.task.operationLedger[0].applied, false);
  });
  await test("invalid-or-unauthorized-backend-receipt-cannot-claim-success", async () => {
    const h = harness(), request = h.input(); h.backend.execute = async () => ({ status: "succeeded", data: "fabricated" });
    await rejects(() => h.broker.execute(request), "OPERATION_UNCERTAIN");
    const other = harness(); other.backend.execute = async () => ({ ok: true, data: "wrong contract" });
    await rejects(() => other.broker.execute(other.request()), "BACKEND_RECEIPT_INVALID");
  });
  await test("cancel-after-durable-claim-prevents-backend-entry", async () => {
    const h = harness(); h.record = async record => { const result = h.runtime.recordOperation(record); if (record.status === "claimed") h.runtime.cancel(h.task.id, owner); return result; };
    await rejects(() => h.broker.execute(h.request()), "TASK_NOT_ACTIVE"); assert.equal(h.calls, 0);
    assert.equal(h.task.operationLedger[0].status, "failed");
  });
  await test("expiry-after-claim-is-checked-before-dispatch", async () => {
    const h = harness(), g = h.grant("local_read", { path: h.file, actions: ["read"] });
    h.record = async record => { const result = h.runtime.recordOperation(record); if (record.status === "claimed") h.now = Date.parse(g.expiresAt); return result; };
    await rejects(() => h.broker.execute(h.request({ capability: "local_read", action: "read", args: { path: h.file } })), "GRANT_REQUIRED");
    assert.equal(h.calls, 0);
  });
  await test("revoke-during-backend-await-prevents-next-physical-action", async () => {
    const h = harness(), request = h.input(), entered = deferred(), gate = deferred();
    h.backend.execute = async r => { entered.resolve(); await gate.promise; r.authorize({ target: r.args.target }); h.calls++; return { status: "succeeded" }; };
    const executing = h.broker.execute(request); await entered.promise;
    h.runtime.revoke(h.task.id, h.task.grants[0].id, owner); gate.resolve();
    await rejects(() => executing, "OPERATION_UNCERTAIN"); assert.equal(h.calls, 0);
  });
  await test("backend-must-recheck-every-action-not-just-first-entry", async () => {
    const h = harness(), request = h.input();
    h.backend.execute = async r => { r.authorize({ target: r.args.target }); h.calls++; h.runtime.revoke(h.task.id, h.task.grants[0].id, owner);
      r.authorize({ target: r.args.target }); h.calls++; return { status: "succeeded" }; };
    await rejects(() => h.broker.execute(request), "OPERATION_UNCERTAIN"); assert.equal(h.calls, 1);
  });
  await test("aborted-request-and-cancelled-receipt-never-retry", async () => {
    const h = harness(), controller = new AbortController(); controller.abort();
    await rejects(() => h.broker.execute(h.request({ signal: controller.signal })), "OPERATION_ABORTED"); assert.equal(h.calls, 0);
    const other = harness(), after = new AbortController(), request = other.input();
    other.backend.execute = async r => { r.authorize({ target: r.args.target }); other.calls++; after.abort(); return { status: "succeeded" }; };
    await rejects(() => other.broker.execute({ ...request, signal: after.signal }), "OPERATION_UNCERTAIN"); assert.equal(other.calls, 1);
  });
  await test("records-contain-host-metadata-not-secret-bearing-arguments", async () => {
    const h = harness(), request = h.request({ args: { query: "SYNTHETIC_PRIVATE_MARKER" } }); await h.broker.execute(request);
    assert.ok(h.records.every(record => !JSON.stringify(record).includes("SYNTHETIC_PRIVATE_MARKER")));
    assert.ok(!JSON.stringify(h.task.operationLedger).includes("SYNTHETIC_PRIVATE_MARKER"));
    assert.deepEqual(h.records.map(x => x.status), ["claimed", "succeeded"]);
  });
  await test("operation-store-cas-and-terminal-transition-immutability", async () => {
    const h = harness(); await h.broker.execute(h.request());
    const claim = h.records[0];
    assert.throws(() => h.runtime.recordOperation(claim), error => error.code === "OPERATION_DUPLICATE");
    assert.throws(() => h.runtime.recordOperation({ ...claim, status: "uncertain" }), error => error.code === "OPERATION_TRANSITION_DENIED");
  });
  await test("terminal-record-cannot-change-claim-digest-or-attempt", async () => {
    const h = harness(), gate = deferred(), entered = deferred();
    h.backend.execute = async r => { r.authorize(); entered.resolve(); await gate.promise; return { status: "succeeded" }; };
    const executing = h.broker.execute(h.request()); await entered.promise;
    for (const patch of [{ operationDigest: "b".repeat(64) }, { attemptId: "different_attempt" }, { grantRevision: 999 }]) {
      assert.throws(() => h.runtime.recordOperation({ ...h.records[0], ...patch, status: "succeeded" }), error => error.code === "OPERATION_RECORD_MISMATCH");
    }
    gate.resolve(); await executing;
  });
  await test("attempt-replacement-after-claim-stops-old-attempt-dispatch", async () => {
    const h = harness();
    h.record = async record => { const result = h.runtime.recordOperation(record); if (record.status === "claimed") {
      h.task.attemptId = "attempt_replaced"; h.task.attempt++; h.runtime.persist(h.task);
    } return result; };
    await rejects(() => h.broker.execute(h.request()), "TASK_AUTHORITY_CHANGED"); assert.equal(h.calls, 0);
  });
  await test("authorization-callback-is-sealed-on-backend-completion", async () => {
    const h = harness(); let retained;
    h.backend.execute = async r => { retained = r.authorize; r.authorize(); return { status: "succeeded" }; };
    await h.broker.execute(h.request());
    assert.throws(() => retained(), error => error.code === "OPERATION_CLOSED");
  });
  await test("malformed-ledger-cannot-hide-a-prior-uncertain-effect", async () => {
    for (const ledger of [{}, [null], [{ operationId: "old", sideEffect: true, status: "unknown" }]]) {
      const h = harness(); h.task.operationLedger = ledger;
      await rejects(() => h.broker.execute(h.request()), "TASK_LEDGER_INVALID");
      h.task.status = "failed";
      assert.equal(h.runtime.resume(h.task.id, owner).code, "UNRESOLVED_SIDE_EFFECT");
    }
  });
  await test("failed-persist-restores-published-grants-and-revision", async () => {
    const h = harness(), original = structuredClone(h.task), target = path.join(h.workspace, "blocked-target"); fs.mkdirSync(target);
    const taskPath = h.runtime.taskPath; h.runtime.taskPath = () => target;
    assert.throws(() => h.runtime.grant(h.task.id, { type: "read", target: h.file }, owner));
    h.runtime.taskPath = taskPath;
    assert.equal(h.task.authorityBlocked, true);
    assert.deepEqual({ ...h.task, authorityBlocked: undefined }, { ...original, authorityBlocked: undefined });
    assert.equal(h.runtime.snapshot(h.task.id).grantRevision, original.grantRevision);
  });
  await test("failed-revoke-persistence-latches-authority-closed", async () => {
    const h = harness(), grant = h.grant("local_read", { path: h.file, actions: ["read"] });
    const blocked = path.join(h.workspace, "blocked-revoke"); fs.mkdirSync(blocked);
    const taskPath = h.runtime.taskPath; h.runtime.taskPath = () => blocked;
    assert.throws(() => h.runtime.revoke(h.task.id, grant.id, owner), error => error.code === "TASK_DURABILITY_UNKNOWN");
    h.runtime.taskPath = taskPath;
    assert.equal(h.runtime.snapshot(h.task.id).authorityBlocked, true);
    await rejects(() => h.broker.execute(h.request({ capability: "local_read", action: "read", args: { path: h.file } })), "TASK_DURABILITY_UNKNOWN");
    assert.equal(h.calls, 0);
  });
  await test("mutation-api-grant-and-revoke-return-safe-grant-projections", async () => {
    const h = harness(), result = h.runtime.grant(h.task.id, { type: "read", target: h.file, purpose: h.workspace }, owner);
    assert.equal(result.ok, true); assert.equal(result.grant.target, "input.txt"); assert.equal(result.grant.scope.redacted, true);
    assert.ok(!JSON.stringify(result.grant).includes(h.workspace));
    const revoked = h.runtime.revoke(h.task.id, result.grant.id, owner);
    assert.equal(revoked.ok, true); assert.ok(revoked.grant.revokedAt); assert.equal(revoked.grant.scope.path, undefined);
    assert.equal(h.runtime.confirm(h.task.id, { userId: "owner", source: "model" }).ok, false);
  });
  await test("restart-replay-projects-interrupted-state-without-executing", async () => {
    const h = harness(); let executed = 0;
    const reloaded = new TaskRuntime({ rootDir: h.runtime.rootDir, config: h.config, execute: async () => { executed++; return { ok: true }; }, notify: async () => { executed++; } });
    const snapshots = []; reloaded.subscribeState(s => snapshots.push(s), { replay: true }); await reloaded.stateBarrier();
    assert.equal(executed, 0); assert.equal(snapshots[0].status, "interrupted"); assert.ok(snapshots[0].revision > h.task.revision);
    assert.equal(reloaded.queue.length + reloaded.running.size, 0);
  });
  for (const result of [null, undefined, "chat response", {}, { ok: "true" }, { ok: 1 }, { ok: true, waitingPermission: true }]) {
    await test(`invalid-result-never-completes-${passed.length}`, async () => {
      const h = harness(); h.runtime.execute = async () => result;
      await h.runtime.run(h.task); assert.equal(h.task.status, "failed"); assert.equal(h.task.lastError, "TASK_RESULT_INVALID");
      assert.equal(h.runtime.running.size + h.runtime.controllers.size, 0);
      if (typeof result === "string") assert.equal(h.task.resultSummary, result);
    });
  }
  await test("invalid-result-releases-lane-for-next-confirmed-task", async () => {
    const h = harness(); h.runtime.pump = TaskRuntime.prototype.pump.bind(h.runtime);
    h.runtime.execute = async task => task === h.task ? { ok: "invalid" } : { ok: true, summary: "synthetic next" };
    const next = h.runtime.createOffer({ accountId: "a", conversationId: "group:fixture", groupId: "fixture", userId: "member" });
    assert.equal(h.runtime.confirm(next.id, owner).ok, true);
    await h.runtime.run(h.task); await until(() => next.status === "completed" && h.runtime.running.size === 0);
    assert.equal(h.task.status, "failed");
  });
  await test("artifact-resolver-rejects-symlink-directory-and-traversal", async () => {
    const h = harness(), link = path.join(h.workspace, "escape.txt"); fs.symlinkSync(h.file, link); fs.mkdirSync(path.join(h.workspace, "dir"));
    assert.equal(h.runtime.artifactPath(h.task.id, "input.txt"), h.file);
    for (const name of ["escape.txt", "dir", "../input.txt", "..", "dir/input.txt"]) assert.equal(h.runtime.artifactPath(h.task.id, name), "");
    assert.deepEqual(h.runtime.artifacts(h.task.id).map(x => x.name), ["input.txt"]);
  });
  await test("artifact-output-directory-symlink-is-denied", async () => {
    const h = harness(); fs.renameSync(h.workspace, `${h.workspace}-real`); fs.symlinkSync(`${h.workspace}-real`, h.workspace);
    assert.equal(h.runtime.artifactPath(h.task.id, "input.txt"), ""); assert.deepEqual(h.runtime.artifacts(h.task.id), []);
  });
  await test("artifact-chinese-names-have-distinct-exact-sha256-ids", async () => {
    const h = harness();
    for (const name of ["第一份文档", "第二份文档", "中文甲.pdf", "中文乙.pdf"]) fs.writeFileSync(path.join(h.workspace, name), name);
    const artifacts = h.runtime.artifacts(h.task.id);
    assert.equal(new Set(artifacts.map(item => item.id)).size, artifacts.length);
    for (const item of artifacts) {
      assert.equal(item.id, createHash("sha256").update(item.name, "utf8").digest("hex"));
      assert.equal(h.runtime.artifactPath(h.task.id, item.name), item.filePath);
      assert.equal(h.runtime.artifactPath(h.task.id, item.id), item.filePath);
    }
    assert.equal(h.runtime.artifactPath(h.task.id, "task"), "");
    assert.equal(h.runtime.artifactPath(h.task.id, ".pdf"), "");
  });
  await test("artifact-punctuation-collisions-fail-closed-for-legacy-id", async () => {
    const h = harness();
    for (const name of ["a b.txt", "a?b.txt", "a!b.txt"]) fs.writeFileSync(path.join(h.workspace, name), name);
    assert.equal(h.runtime.artifactPath(h.task.id, "a-b.txt"), "");
    for (const name of ["a b.txt", "a?b.txt", "a!b.txt"]) assert.equal(h.runtime.artifactPath(h.task.id, name), path.join(h.workspace, name));
  });
  await test("artifact-legacy-id-works-only-when-unique-and-is-not-request-normalization", async () => {
    const h = harness(); fs.writeFileSync(path.join(h.workspace, "单份文档"), "fixture");
    assert.equal(h.runtime.artifactPath(h.task.id, "task"), path.join(h.workspace, "单份文档"));
    assert.equal(h.runtime.artifactPath(h.task.id, "不存在文档"), "");
    fs.writeFileSync(path.join(h.workspace, "另一份文档"), "fixture");
    assert.equal(h.runtime.artifactPath(h.task.id, "task"), "");
    fs.writeFileSync(path.join(h.workspace, "a b.txt"), "fixture");
    assert.equal(h.runtime.artifactPath(h.task.id, "a-b.txt"), path.join(h.workspace, "a b.txt"));
    assert.equal(h.runtime.artifactPath(h.task.id, "a!b.txt"), "");
  });
  await test("artifact-exact-name-wins-over-exact-hash-and-ambiguous-legacy-id", async () => {
    const h = harness(), name = "中文报告", digest = createHash("sha256").update(name, "utf8").digest("hex");
    for (const file of [name, digest, "task", "另一报告"]) fs.writeFileSync(path.join(h.workspace, file), file);
    assert.equal(h.runtime.artifactPath(h.task.id, digest), path.join(h.workspace, digest));
    assert.equal(h.runtime.artifactPath(h.task.id, "task"), path.join(h.workspace, "task"));
    assert.equal(h.runtime.artifactPath(h.task.id, name), path.join(h.workspace, name));
  });
  await test("artifact-exact-hash-wins-over-another-legacy-alias", async () => {
    const h = harness(), digest = createHash("sha256").update("input.txt", "utf8").digest("hex");
    fs.writeFileSync(path.join(h.workspace, `--${digest}--`), "fixture");
    assert.equal(h.runtime.artifactPath(h.task.id, digest), h.file);
  });
  await test("artifact-names-and-hashes-are-case-sensitive-even-on-case-insensitive-hosts", async () => {
    const h = harness(), name = "MixedCase.txt"; fs.writeFileSync(path.join(h.workspace, name), "fixture");
    const artifact = h.runtime.artifacts(h.task.id).find(item => item.name === name);
    assert.equal(h.runtime.artifactPath(h.task.id, name), path.join(h.workspace, name));
    assert.equal(h.runtime.artifactPath(h.task.id, "mixedcase.txt"), "");
    assert.equal(h.runtime.artifactPath(h.task.id, "MIXEDCASE.TXT"), "");
    assert.equal(h.runtime.artifactPath(h.task.id, artifact.id.toUpperCase()), "");
  });
  await test("artifact-id-is-filename-stable-across-content-changes-and-runtime-reload", async () => {
    const h = harness(), originalTaskId = h.task.id, id = h.runtime.artifacts(h.task.id).find(item => item.name === "input.txt").id;
    fs.writeFileSync(h.file, "changed fixture content");
    assert.equal(h.runtime.artifacts(h.task.id).find(item => item.name === "input.txt").id, id);
    const reloaded = new TaskRuntime({ rootDir: h.runtime.rootDir, config: h.config, execute: async () => ({ ok: true }), notify: async () => {} });
    assert.equal(reloaded.get(originalTaskId).id, originalTaskId);
    assert.equal(reloaded.artifacts(originalTaskId).find(item => item.name === "input.txt").id, id);
    assert.equal(reloaded.artifactPath(originalTaskId, id), h.file);
  });
  await test("artifact-traversal-and-malformed-requests-cannot-use-legacy-fallback", async () => {
    const h = harness(); fs.writeFileSync(path.join(h.workspace, "a b.txt"), "fixture");
    for (const value of ["../input.txt", "..\\input.txt", "/input.txt", "input.txt/", "input.txt\0other", ".", "..", "%2e%2e%2finput.txt", "", null, 42]) {
      assert.equal(h.runtime.artifactPath(h.task.id, value), "");
    }
  });
  await test("digest-canonicalization-rejects-non-json-and-prototype-keys", async () => {
    assert.equal(operationDigest({ capability: "x", action: "y", args: { b: 2, a: 1 } }), operationDigest({ capability: "x", action: "y", args: { a: 1, b: 2 } }));
    assert.throws(() => operationDigest({ capability: "x", action: "y", args: { value: NaN } }), CapabilityError);
    assert.throws(() => operationDigest({ capability: "x", action: "y", args: JSON.parse('{"__proto__":1}') }), CapabilityError);
  });
  await test("exported-normalizer-and-public-status-never-expose-scope-targets", async () => {
    const h = harness(), grant = normalizeWorkGrant(h.task, { type: "read", target: h.file }, owner, h.now);
    assert.equal(grant.scope.path, h.file); h.task.grants.push(grant);
    const view = publicTask(h.task); assert.equal(view.grants.at(-1).target, "input.txt"); assert.ok(!JSON.stringify(view.grants).includes(h.workspace));
  });
  await test("public-task-filters-obvious-secrets-and-privacy-without-changing-authority", async () => {
    const h = harness();
    h.task.userId = "13800138000"; // Stable host QQ IDs must not become PII placeholders.
    h.task.objective = "联系电话 13800138000；密码=FIXTURE_PASSWORD";
    h.task.resultSummary = "sk-fixture_only_not_real_12345 api_key=FIXTURE_API_VALUE Authorization: Bearer FIXTURE_BEARER";
    h.task.supplements = [{ userId: h.task.userId, text: "验证码:654321" }];
    h.task.research = { sources: [{ link: "https://example.org/?token=FIXTURE_QUERY#password=FIXTURE_FRAGMENT" }] };
    h.task.review = { credentials: { value: "FIXTURE_CREDENTIAL" }, headers: { authorization: "FIXTURE_HEADER", cookie: "FIXTURE_COOKIE" }, tokenCount: 42 };
    h.task.privateKey = "FIXTURE_PRIVATE_KEY";
    h.runtime.persist(h.task);
    const before = structuredClone(h.task), view = publicTask(h.task), snapshot = h.runtime.snapshot(h.task.id);
    for (const result of [view, snapshot]) {
      const serialized = JSON.stringify(result);
      for (const secret of ["FIXTURE_PASSWORD", "sk-fixture_only_not_real_12345", "FIXTURE_API_VALUE", "FIXTURE_BEARER", "FIXTURE_QUERY", "FIXTURE_FRAGMENT", "FIXTURE_CREDENTIAL", "FIXTURE_HEADER", "FIXTURE_COOKIE", "FIXTURE_PRIVATE_KEY"]) {
        assert.ok(!serialized.includes(secret), `public projection leaked ${secret}`);
      }
      assert.equal(result.userId, before.userId); assert.equal(result.attemptId, before.attemptId);
      assert.equal(result.revision, before.revision); assert.equal(result.review.tokenCount, 42);
      assert.ok(!result.objective.includes("13800138000")); assert.ok(!result.supplements[0].text.includes("654321"));
    }
    assert.deepEqual(h.task, before);
  });
  console.log(JSON.stringify({ ok: true, tests: passed.length, fixtureOnly: true, passed }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
