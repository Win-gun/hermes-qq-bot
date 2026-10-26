import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

// Host interfaces only. Neither grants, policy, manifests nor operation records
// may be constructed from model output. No worker is installed or marked ready
// here. In particular, a browser/computer tool name is not a verified backend.
export const WORK_GRANT_VERSION = 1;
export const WORK_CAPABILITIES = Object.freeze({
  public_web: ["search", "fetch"],
  isolated_browser: ["navigate", "read", "snapshot", "click", "fill", "type", "press", "upload"],
  authenticated_browser: ["navigate", "read", "snapshot", "click", "fill", "type", "press", "upload"],
  isolated_files: ["read", "list", "write"],
  local_read: ["read"],
  local_write: ["write"],
  code: ["run"],
  desktop_observe: ["capture", "list_apps"],
  desktop_input: ["click", "type", "key", "scroll", "drag", "set_value"],
  app: ["launch", "focus", "observe"],
  external_write: ["send", "upload", "post"]
});
for (const actions of Object.values(WORK_CAPABILITIES)) Object.freeze(actions);

const active = new Set(["planning", "running", "reviewing", "delivering"]);
const fileCapabilities = new Set(["isolated_files", "local_read", "local_write", "code"]);
const browserCapabilities = new Set(["isolated_browser", "authenticated_browser"]);
const isolated = new Set(["isolated_browser", "isolated_files", "code"]);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const token = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
  && !["__proto__", "constructor", "prototype"].includes(value);
const stamp = value => typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
const hash = value => createHash("sha256").update(value).digest("hex");
const jsonClone = value => JSON.parse(JSON.stringify(value));
const within = (base, target) => target === base || target.startsWith(`${base}${path.sep}`);
function freeze(value) {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}

export class CapabilityError extends Error {
  constructor(code, receipt) {
    super(code);
    this.name = "CapabilityError";
    this.code = code;
    if (receipt) this.receipt = receipt;
  }
}
const fail = code => { throw new CapabilityError(code); };

function stableJson(value, depth = 0) {
  if (depth > 16) fail("INVALID_ARGUMENTS");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item, depth + 1)).join(",")}]`;
  if (!plain(value) || Object.keys(value).some(key => ["__proto__", "constructor", "prototype"].includes(key))) fail("INVALID_ARGUMENTS");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key], depth + 1)}`).join(",")}}`;
}

/** Exact action/argument digest for the human confirmation UI; not a permission. */
export function operationDigest({ capability, action, args = {} }) {
  const serialized = stableJson({ capability, action, args });
  if (Buffer.byteLength(serialized) > 128 * 1024) fail("INVALID_ARGUMENTS");
  return hash(serialized);
}

function strings(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 64
    && value.every(item => typeof item === "string" && item.length > 0 && item.length <= 512);
}

function normalizeScope(capability, input) {
  if (!plain(input)) fail("GRANT_SCOPE_REQUIRED");
  const scope = jsonClone(input);
  if (!strings(scope.actions) || scope.actions.some(action => !WORK_CAPABILITIES[capability].includes(action))) fail("GRANT_SCOPE_INVALID");
  if (fileCapabilities.has(capability)) {
    if (scope.path === undefined) scope.path = scope.target;
    if (typeof scope.path !== "string" || !path.isAbsolute(scope.path) || scope.path.includes("\0")) fail("GRANT_SCOPE_INVALID");
    scope.path = path.resolve(scope.path);
    if (scope.recursive !== undefined && typeof scope.recursive !== "boolean") fail("GRANT_SCOPE_INVALID");
  } else if (capability === "public_web" || browserCapabilities.has(capability)) {
    if (!strings(scope.domains) || scope.domains.some(domain => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
      || domain.endsWith(".local") || domain.endsWith(".localhost"))) fail("GRANT_SCOPE_INVALID");
    if (browserCapabilities.has(capability) && !token(scope.sessionId)) fail("GRANT_SCOPE_INVALID");
  } else if (capability === "external_write") {
    if (!/^[a-f0-9]{64}$/.test(scope.operationDigest || "") || typeof scope.target !== "string"
      || !scope.target.trim() || scope.target.length > 512 || /[\u0000-\u001f]/.test(scope.target)) fail("GRANT_SCOPE_INVALID");
    scope.oneShot = true;
  } else if (!strings(scope.apps)) fail("GRANT_SCOPE_INVALID");
  return scope;
}

/**
 * Pure host grant builder. Actor.userId must come from the existing verified QQ
 * event/local session, never model arguments. Legacy read/write INPUTS map to
 * exact local paths; stored unversioned grants are deliberately NOT upgraded.
 */
export function normalizeWorkGrant(task, input, actor, now = Date.now()) {
  if (!plain(input) || !task?.id || !task.logicalBotId || !task.accountId) fail("GRANT_IDENTITY_REQUIRED");
  if (!actor?.userId || /^(?:model|ai|agent|tool)$/i.test(actor.source || "") || actor.kind === "model") fail("HUMAN_ACTOR_REQUIRED");
  if (actor.accountId !== undefined && actor.accountId !== task.accountId
    || actor.logicalBotId !== undefined && actor.logicalBotId !== task.logicalBotId) fail("GRANT_IDENTITY_MISMATCH");
  const type = String(input.type || input.capability || "").toLowerCase();
  if (type === "computer") fail("LEGACY_COMPUTER_DENIED");
  const capability = ({ read: "local_read", write: "local_write", browser: "isolated_browser" })[type] || type;
  if (!Object.hasOwn(WORK_CAPABILITIES, capability)) fail("CAPABILITY_UNKNOWN");
  if (input.capability && input.capability !== capability) fail("GRANT_SCOPE_INVALID");
  let rawScope = input.scope;
  if (["read", "write"].includes(type) && rawScope === undefined) {
    const target = input.target || input.path;
    if (typeof target !== "string" || !target.trim() || target.includes("\0")) fail("GRANT_SCOPE_INVALID");
    rawScope = { path: path.resolve(target), recursive: false, actions: [type] };
  }
  const scope = normalizeScope(capability, rawScope);
  const maxTtl = capability === "external_write" ? 120_000 : 60 * 60_000;
  const expires = input.expiresAt === undefined ? now + Math.min(15 * 60_000, maxTtl) : stamp(input.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expires) || expires <= now || expires > now + maxTtl) fail("GRANT_EXPIRY_INVALID");
  return {
    version: WORK_GRANT_VERSION, id: `grant_${randomBytes(12).toString("hex")}`,
    taskId: task.id, logicalBotId: task.logicalBotId, accountId: task.accountId,
    type, capability, scope, target: fileCapabilities.has(capability) ? scope.path : "",
    humanActor: { userId: String(actor.userId), source: String(actor.source || "verified-host") },
    grantedBy: String(actor.userId), grantedAt: new Date(now).toISOString(),
    expiresAt: new Date(expires).toISOString(), revokedAt: "",
    purpose: String(input.purpose || "").slice(0, 300)
  };
}

export function hasUnresolvedSideEffects(task) {
  // Execution authority only. deliveryLedger is a separate attempt/key-scoped
  // notification dedup ledger, not evidence that a work action is unresolved.
  // An explicit resume may create new notifications, but MUST NOT clear or
  // bypass a claimed/uncertain side-effect in operationLedger.
  if (task?.operationLedger === undefined) return false; // Pre-Broker task metadata.
  if (!Array.isArray(task.operationLedger)) return true;
  return task.operationLedger.some(item => !plain(item) || typeof item.sideEffect !== "boolean"
    || !["claimed", "succeeded", "failed", "uncertain"].includes(item.status)
    || item.sideEffect === true && ["claimed", "uncertain"].includes(item.status));
}

/** Metadata-only check, never follows symlinks (including ancestor symlinks).
 * File adapters MUST also enforce the boundary at their OS open/rename boundary
 * (pinned descriptors / equivalent isolation); this check is not an OS sandbox.
 */
export function canonicalNoFollowPath(value, { allowMissingLeaf = false } = {}) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) fail("PATH_INVALID");
  const target = path.resolve(value), root = path.parse(target).root;
  const components = target.slice(root.length).split(path.sep).filter(Boolean);
  let current = root, stat;
  try {
    stat = fs.lstatSync(root);
    for (let index = 0; index < components.length; index += 1) {
      if (!stat.isDirectory()) fail("PATH_NOT_DIRECTORY");
      current = path.join(current, components[index]);
      try { stat = fs.lstatSync(current); }
      catch (error) {
        if (error.code === "ENOENT" && allowMissingLeaf && index === components.length - 1) return { path: target, missing: true };
        throw error;
      }
      if (stat.isSymbolicLink()) fail("PATH_SYMLINK_DENIED");
    }
    if (!stat.isFile() && !stat.isDirectory()) fail("PATH_NOT_REGULAR");
    if (fs.realpathSync(target) !== target) fail("PATH_NOT_CANONICAL");
    return { path: target, directory: stat.isDirectory(), device: stat.dev, inode: stat.ino };
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    fail("PATH_UNAVAILABLE");
  }
}

function validateScope(capability, action, args, scope, manifest) {
  normalizeScope(capability, scope);
  if (!scope.actions.includes(action)) fail("GRANT_ACTION_DENIED");
  if (fileCapabilities.has(capability)) {
    if (manifest.canonicalNoFollow !== true) fail("BACKEND_FILE_BOUNDARY_UNVERIFIED");
    const base = canonicalNoFollowPath(scope.path, { allowMissingLeaf: capability === "local_write" });
    const requested = canonicalNoFollowPath(args.path ?? args.target, { allowMissingLeaf: action === "write" });
    if (requested.path !== base.path && !(scope.recursive === true && base.directory && within(base.path, requested.path))) fail("GRANT_PATH_DENIED");
    if (["local_read", "local_write"].includes(capability) && requested.directory) fail("PATH_NOT_REGULAR");
    return { path: requested.path, boundary: base };
  }
  if (capability === "public_web" || browserCapabilities.has(capability)) {
    if (manifest.publicNetworkOnly !== true) fail("BACKEND_NETWORK_BOUNDARY_UNVERIFIED");
    if (browserCapabilities.has(capability) && args.sessionId !== scope.sessionId) fail("GRANT_SESSION_DENIED");
    if (args.url !== undefined || action === "fetch" || action === "navigate") {
      let url;
      try { url = new URL(args.url); } catch { fail("GRANT_DOMAIN_DENIED"); }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port && !["80", "443"].includes(url.port)
        || !scope.domains.includes(url.hostname)) fail("GRANT_DOMAIN_DENIED");
    }
  } else if (capability === "external_write") {
    if (args.target !== scope.target) fail("EXTERNAL_TARGET_DENIED");
  } else if (!scope.apps.includes(args.app)) fail("GRANT_APP_DENIED");
  return null;
}

function risk(capability, action, manifest) {
  if (capability === "external_write" || capability === "desktop_input" || capability === "app") return { sideEffect: true, external: true };
  if (browserCapabilities.has(capability)) {
    // Models cannot label an action read-only. Only a host-verified adapter may
    // classify these two observation verbs; even navigate is conservative.
    const observation = ["snapshot", "read"].includes(action) && Array.isArray(manifest.readOnlyActions) && manifest.readOnlyActions.includes(action);
    return { sideEffect: !observation, external: !observation };
  }
  return { sideEffect: capability === "local_write" || capability === "isolated_files" && action === "write", external: capability === "local_write" };
}

/**
 * Policy: synchronous getTask(id), getPolicy(task) => {enabled:true,
 * capabilities:[...], ownerUserIds:[verified humans]}; validateIdentity(request,
 * task) => true is also synchronous so authorize() has no await-to-wire gap.
 * Optional policy.baseline may contain ONLY public_web and isolated_files scope
 * objects for a host-confirmed task. policy.taskWorkspace is the canonical
 * current-task output directory; an isolated_files baseline must name it exactly.
 * All other capabilities require versioned human grants. local_write and any
 * potentially mutating GUI/browser action ALSO require an exact external_write
 * one-shot grant (digest + target, <=2 min). Task confirmation is not publication.
 * getBackend(capability, task) may be asynchronous, and returns a trusted adapter:
 * {manifest:{id,verified:true,capabilities,enforcesScope:true,
 * rechecksAuthorization:true,noAutomaticRetries:true,isolated?,publicNetworkOnly?,
 * canonicalNoFollow?,readOnlyActions?}, execute(request)}.
 * The adapter MUST call request.authorize({target?}) immediately before EVERY
 * actual read/write/wire, and enforce OS/file/egress isolation itself. A manifest
 * is a host attestation, not model prose or automatic GUI readiness detection.
 * execute returns {status:'succeeded',data?}, {status:'failed',applied:false}, or
 * {status:'uncertain'}. Throws/invalid receipts after side-effect dispatch are
 * uncertain. recordOperation(record) must perform atomic CAS and return
 * {ok:true,durable:true}; bind TaskRuntime.recordOperation for the existing store.
 */
export class CapabilityBroker {
  constructor({ getTask, getPolicy, getBackend, validateIdentity, recordOperation, clock = Date.now }) {
    Object.assign(this, { getTask, getPolicy, getBackend, validateIdentity, recordOperation, clock });
    this.seen = new Set();
    this.persistenceBlocked = new Set();
  }

  check(request, pin, manifest, ownClaim = false) {
    if (request.signal?.aborted) fail("OPERATION_ABORTED");
    if (this.persistenceBlocked.has(request.taskId)) fail("OPERATION_DURABILITY_UNKNOWN");
    const task = this.getTask?.(request.taskId);
    if (!task || !active.has(task.status)) fail("TASK_NOT_ACTIVE");
    if (task.authorityBlocked === true) fail("TASK_DURABILITY_UNKNOWN");
    if (task.logicalBotId !== request.logicalBotId || task.accountId !== request.accountId || !task.accountId
      || !task.logicalBotId || task.logicalBotId.startsWith("unassigned:")) fail("TASK_IDENTITY_MISMATCH");
    if (!Number.isSafeInteger(task.revision) || task.revision < 1 || !Number.isSafeInteger(task.grantRevision) || task.grantRevision < 0
      || !token(task.attemptId) || !Number.isSafeInteger(task.attempt) || task.attempt < 1) fail("TASK_VERSION_REQUIRED");
    const policy = this.getPolicy?.(task);
    if (!plain(policy) || policy.enabled !== true || !Array.isArray(policy.capabilities) || !policy.capabilities.includes(request.capability)) fail("CAPABILITY_POLICY_DENIED");
    if (this.validateIdentity?.(request, task) !== true) fail("TASK_IDENTITY_STALE");
    if (pin && (pin.attemptId !== task.attemptId || pin.grantRevision !== task.grantRevision)) fail("TASK_AUTHORITY_CHANGED");
    if (!Array.isArray(task.operationLedger) || task.operationLedger.some(item => !plain(item) || !token(item.operationId)
      || typeof item.sideEffect !== "boolean" || !["claimed", "succeeded", "failed", "uncertain"].includes(item.status))) fail("TASK_LEDGER_INVALID");
    const ledger = task.operationLedger;
    const previous = ledger.find(item => item.operationId === request.operationId);
    if (ownClaim && !previous) fail("OPERATION_CLAIM_MISSING");
    if (previous && (!ownClaim || previous.status !== "claimed" || previous.attemptId !== task.attemptId)) fail("OPERATION_DUPLICATE");
    if (manifest) {
      if (manifest.verified !== true || !token(manifest.id) || !Array.isArray(manifest.capabilities) || !manifest.capabilities.includes(request.capability)) fail("BACKEND_UNVERIFIED");
      if (manifest.enforcesScope !== true || manifest.rechecksAuthorization !== true || manifest.noAutomaticRetries !== true) fail("BACKEND_BOUNDARY_UNVERIFIED");
      if (isolated.has(request.capability) && manifest.isolated !== true) fail("BACKEND_ISOLATION_UNVERIFIED");
      if (request.capability === "code" && manifest.networkDisabled !== true) fail("BACKEND_ISOLATION_UNVERIFIED");
    }
    const now = this.clock();
    const eligible = (Array.isArray(task.grants) ? task.grants : []).filter(grant => plain(grant) && grant.version === WORK_GRANT_VERSION
      && token(grant.id) && grant.taskId === task.id && grant.logicalBotId === task.logicalBotId && grant.accountId === task.accountId
      && grant.revokedAt === "" && stamp(grant.expiresAt) > now && stamp(grant.grantedAt) <= now
      && stamp(grant.expiresAt) - stamp(grant.grantedAt) <= (grant.capability === "external_write" ? 120_000 : 60 * 60_000)
      && grant.humanActor?.userId && Array.isArray(policy.ownerUserIds) && policy.ownerUserIds.includes(grant.humanActor.userId)
      && !/^(?:model|ai|agent|tool)$/i.test(grant.humanActor.source || ""));
    let grant, boundary = null, scopeError;
    for (const candidate of eligible.filter(item => item.capability === request.capability && item.scope?.actions?.includes(request.action)
      && (!pin?.grantId || item.id === pin.grantId))) {
      try {
        if (manifest) boundary = validateScope(request.capability, request.action, request.args, candidate.scope, manifest);
        grant = candidate;
        break;
      } catch (error) { scopeError = error; }
    }
    // Only host policy may supply baseline authority. Task confirmation grants
    // isolated document/research work, never host/private/GUI/publish authority.
    const baselineScope = policy.baseline?.[request.capability];
    if (!grant && ["public_web", "isolated_files"].includes(request.capability) && baselineScope
      && typeof task.confirmedBy === "string" && task.confirmedBy && Number.isFinite(stamp(task.confirmedAt)) && stamp(task.confirmedAt) <= now
      && (!pin?.grantId || pin.grantId === `baseline:${request.capability}`)) {
      const scope = normalizeScope(request.capability, baselineScope);
      if (request.capability === "isolated_files") {
        const workspace = canonicalNoFollowPath(policy.taskWorkspace);
        if (!workspace.directory || path.resolve(scope.path) !== workspace.path) fail("BASELINE_WORKSPACE_DENIED");
      }
      if (manifest) boundary = validateScope(request.capability, request.action, request.args, scope, manifest);
      grant = { id: `baseline:${request.capability}`, capability: request.capability, scope };
    }
    if (!grant && scopeError) throw scopeError;
    if (!grant) fail("GRANT_REQUIRED");
    const classification = manifest ? risk(request.capability, request.action, manifest) : null;
    if (classification?.sideEffect && ledger.some(item => item.sideEffect === true && ["claimed", "uncertain"].includes(item.status)
      && !(ownClaim && item.operationId === request.operationId))) fail("UNRESOLVED_SIDE_EFFECT");
    let externalGrant;
    if (classification?.external) {
      const candidates = eligible.filter(item => item.capability === "external_write" && item.scope?.oneShot === true
        && item.scope.operationDigest === request.digest && item.scope.target === request.args.target
        && (!pin?.externalGrantId || item.id === pin.externalGrantId));
      if (!candidates.length) fail("EXTERNAL_CONFIRMATION_REQUIRED");
      externalGrant = candidates.find(candidate => !ledger.some(item => item.externalGrantId === candidate.id
        && !(ownClaim && item.operationId === request.operationId && item.status === "claimed")));
      if (!externalGrant) fail("EXTERNAL_GRANT_CONSUMED");
    }
    return { task, grant, externalGrant, classification, boundary };
  }

  async record(record) {
    try {
      const result = await this.recordOperation?.(Object.freeze({ ...record }));
      if (result?.ok !== true || result?.durable !== true) fail("OPERATION_DURABILITY_UNKNOWN");
    } catch {
      this.persistenceBlocked.add(record.taskId);
      fail("OPERATION_DURABILITY_UNKNOWN");
    }
  }

  async execute(input) {
    if (!plain(input) || !token(input.taskId) || !token(input.operationId) || !Object.hasOwn(WORK_CAPABILITIES, input.capability)
      || !WORK_CAPABILITIES[input.capability].includes(input.action) || !plain(input.args || {})) fail("INVALID_OPERATION");
    const request = { taskId: input.taskId, logicalBotId: input.logicalBotId, accountId: input.accountId,
      operationId: input.operationId, capability: input.capability, action: input.action,
      args: freeze(JSON.parse(stableJson(input.args || {}))), signal: input.signal };
    request.digest = operationDigest(request);
    const key = JSON.stringify([request.taskId, request.operationId]);
    if (this.seen.has(key)) fail("OPERATION_DUPLICATE");
    this.seen.add(key); // Reserve before the first await, including failed requests.
    let checked = this.check(request);
    const initial = { attemptId: checked.task.attemptId, grantRevision: checked.task.grantRevision };
    const backend = await this.getBackend?.(request.capability, checked.task);
    if (!backend || typeof backend.execute !== "function" || !plain(backend.manifest)) fail("BACKEND_UNAVAILABLE");
    const manifest = freeze(jsonClone(backend.manifest));
    checked = this.check(request, initial, manifest);
    const pin = { ...initial, grantId: checked.grant.id, externalGrantId: checked.externalGrant?.id || "" };
    const record = { taskId: request.taskId, logicalBotId: request.logicalBotId, accountId: request.accountId,
      operationId: request.operationId, attemptId: pin.attemptId, attempt: checked.task.attempt,
      capability: request.capability, action: request.action, grantId: pin.grantId, grantRevision: pin.grantRevision,
      externalGrantId: pin.externalGrantId, operationDigest: request.digest,
      targetDigest: typeof request.args.target === "string" ? hash(request.args.target) : "",
      backendId: manifest.id, sideEffect: checked.classification.sideEffect };
    await this.record({ ...record, status: "claimed" });
    let invoked = false, authorized = 0, sealed = false, outcome, code, data;
    const authorize = (actual = {}) => {
      if (sealed) fail("OPERATION_CLOSED");
      if (checked.classification.external && actual.target !== request.args.target) fail("EXTERNAL_TARGET_DENIED");
      const latest = this.check(request, pin, manifest, true);
      authorized += 1;
      return Object.freeze({ attemptId: pin.attemptId, grantRevision: pin.grantRevision,
        scope: jsonClone(latest.grant.scope), fileBoundary: latest.boundary });
    };
    try {
      this.check(request, pin, manifest, true); // Last synchronous pre-dispatch check.
      invoked = true;
      const response = await backend.execute(Object.freeze({ ...request, attemptId: pin.attemptId,
        grantRevision: pin.grantRevision, scope: jsonClone(checked.grant.scope), authorize }));
      if (request.signal?.aborted) fail("OPERATION_ABORTED");
      if (response?.status === "succeeded" && authorized > 0) { outcome = "succeeded"; data = response.data; }
      else if (response?.status === "failed" && response.applied === false) { outcome = "failed"; code = "BACKEND_REJECTED"; }
      else { outcome = checked.classification.sideEffect ? "uncertain" : "failed"; code = "BACKEND_RECEIPT_INVALID"; }
    } catch (error) {
      outcome = invoked && checked.classification.sideEffect ? "uncertain" : "failed";
      code = error instanceof CapabilityError ? error.code : "BACKEND_EXECUTION_FAILED";
    }
    sealed = true; // A retained callback cannot dispatch after a backend settles.
    await this.record({ ...record, status: outcome, ...(outcome === "failed" ? { applied: false } : {}), ...(code ? { code } : {}) });
    const receipt = Object.freeze({ ...record, status: outcome });
    if (outcome !== "succeeded") throw new CapabilityError(outcome === "uncertain" ? "OPERATION_UNCERTAIN" : code || "OPERATION_FAILED", receipt);
    return { receipt, data };
  }
}
