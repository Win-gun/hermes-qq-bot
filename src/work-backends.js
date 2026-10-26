import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { globalGuiLease } from "./gui-lease.js";
import { WORK_CAPABILITIES } from "./work-capabilities.js";

export { WORK_CAPABILITIES };
const BROWSER = ["public_web", "isolated_browser", "authenticated_browser"];
const DESKTOP = ["desktop_observe", "desktop_input", "app"];
const WRITES = new Set(["navigate", "click", "fill", "type", "press", "upload"]);
const fail = code => Object.assign(new Error(code), { code });
const unavailable = reason => ({ status: "failed", applied: false, code: "UNAVAILABLE", reason });
const identity = t => ({ taskId: t?.taskId || t?.id, logicalBotId: t?.logicalBotId, accountId: t?.accountId });
const same = (a, b) => ["taskId", "logicalBotId", "accountId"].every(k => typeof a?.[k] === "string" && a[k] && a[k] === b?.[k]);
const keyOf = owner => JSON.stringify([owner.taskId, owner.logicalBotId, owner.accountId]);
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const failure = error => ({ status: "failed", applied: false, code: ["ABORTED", "AUTHORIZATION_DENIED", "URL_DENIED", "SCOPE_DENIED", "GUI_ABORTED",
  "GUI_WAIT_TIMEOUT", "GUI_UNAVAILABLE", "GUI_LEASE_REVOKED"].includes(error?.code) ? error.code : "BACKEND_FAILED" });

// Conservative literal filter. IPv6 is deliberately unavailable rather than
// misclassifying mapped, transition, link-local or scoped addresses as public.
function publicAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
    || (a === 192 && b === 0 && c === 2) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

/** URL policy is defense in depth, NOT a DNS-pinning firewall. Real browser
 * verification additionally requires an externally enforced egress boundary. */
export async function assertPublicWebUrl(raw, { resolve = lookup } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw fail("URL_DENIED"); }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
    || (url.port && !["80", "443"].includes(url.port)) || !host.includes(".")
    || /(?:^|\.)(localhost|local|internal|home|lan|onion)$/.test(host)) throw fail("URL_DENIED");
  const answers = isIP(host) ? [{ address: host }] : await resolve(host, { all: true, verbatim: true });
  if (!Array.isArray(answers) || !answers.length || answers.some(a => !publicAddress(a.address))) throw fail("URL_DENIED");
  return url.href;
}

/** Actual CapabilityBroker protocol: authorize is synchronous and rechecks its
 * pinned grant + one-shot external grant in the durable claimed operation.
 * Broker currently checks actual.target only for external actions; this host
 * MUST additionally enforce the returned domain/session/app scope. Never pass
 * args.target as host evidence. No Promise/void authorization is accepted.
 * A read/snapshot/public-fetch operation cannot obtain an external-write grant
 * mid-flight: unexpected POST/upload/interaction is refused, not relabelled.
 */
function check(request, phase, target, { action = request.action } = {}) {
  if (request.signal?.aborted) throw fail("ABORTED");
  const actualTarget = target?.url || target?.handle;
  const context = freeze(structuredClone({ taskId: request.taskId, accountId: request.accountId,
    logicalBotId: request.logicalBotId, operationId: request.operationId,
    capability: request.capability, action, phase, target: actualTarget, hostTarget: target }));
  const result = request.authorize(context);
  if (result?.then) { Promise.resolve(result).catch(() => {}); throw fail("AUTHORIZATION_DENIED"); }
  if (!result?.scope || typeof result.scope !== "object") throw fail("AUTHORIZATION_DENIED");
  const scope = result.scope;
  if (!scope.actions?.includes(request.action)) throw fail("SCOPE_DENIED");
  if (BROWSER.includes(request.capability)) {
    if (request.capability !== "public_web" && (scope.sessionId !== request.args.sessionId || !scope.sessionId)) throw fail("SCOPE_DENIED");
    if (target?.url) {
      const url = new URL(target.url);
      if (!["http:", "https:"].includes(url.protocol) || !scope.domains?.includes(url.hostname)) throw fail("SCOPE_DENIED");
    }
    if (target?.method && !["GET", "HEAD", "OPTIONS"].includes(target.method.toUpperCase())
      && (request.capability === "public_web" || !WRITES.has(request.action))) throw fail("SCOPE_DENIED");
  } else if (DESKTOP.includes(request.capability) && (!scope.apps?.includes(target?.bundleId) || target.bundleId !== request.args.app)) {
    throw fail("SCOPE_DENIED");
  }
  if (request.signal?.aborted) throw fail("ABORTED");
  return result;
}

function usable(adapter, fixtures) {
  if (!adapter) return false;
  if (adapter.manifest?.fixtureOnly === true) return fixtures === true;
  return adapter.manifest?.verified === true && adapter.manifest?.available === true;
}

export function unavailableBackend(capability, reason = "No explicitly configured, verified backend") {
  return Object.freeze({ manifest: freeze({ id: `unavailable:${capability}`, capabilities: [capability],
    verified: false, available: false, gaps: [reason] }), execute: async () => unavailable(reason) });
}

/**
 * Pure registry; no driver creation, filesystem reads, network or native calls.
 * getBackend(capability, task) binds a backend to the host-owned identity.
 * No Hermes/shell fallback exists. Session authority is host configuration,
 * never task/model args. Pass one registry for all logical bots.
 *
 * Adapter protocol (trusted host, not a model plugin):
 * browser: readiness(), openSession({owner,partition,onRequest,authorizeStep,signal}) ->
 *   {owner,partition,observe(action,args),execute(action,args,target),close()}.
 *   authorizeStep(action,hostTarget) must be called again after an adapter awaits
 *   artifact resolution, and before its actual native/network action.
 *   onRequest receives actual host {url,method,resourceType}; authorizeStep is
 *   synchronous and must be called immediately before EVERY read/write/wire.
 * desktop: readiness({prompt:false}), observe({owner,lease,action,args,authorizeStep}),
 *   execute({owner,lease,action,args,target,signal,authorizeStep}) -> {stopped:true,data}.
 *   observe returns {bundleId,windowId,handle,fresh:true,controllable:true,...}.
 * A native adapter must atomically validate the fence and fresh handle at wire.
 * confirmStopped is supervisor-only and must prove the physical host stopped.
 */
export function createWorkBackends({ browserAdapter, desktopAdapter, leaseManager = globalGuiLease,
  allowFixtures = false, resolve = lookup, authorizeBrowserSession = () => false } = {}) {
  const used = new Set();
  const sessions = new Map();
  const ownersBusy = new Set();
  const blockedOwners = new Set();
  const closedOwners = new Set();
  const adapters = { browser: browserAdapter, desktop: desktopAdapter };

  function getBackend(capability, task) {
    const owner = freeze(identity(task));
    if (!same(owner, owner)) return unavailableBackend(capability, "Missing task/logicalBot/account identity");
    const kind = BROWSER.includes(capability) ? "browser" : DESKTOP.includes(capability) ? "desktop" : null;
    const adapter = adapters[kind];
    if (!kind || !usable(adapter, allowFixtures) || !adapter.manifest.capabilities?.includes(capability)) {
      return unavailableBackend(capability, adapter?.manifest?.gaps?.join("; ") || "Backend absent or unverified; no raw fallback");
    }
    const manifest = freeze({ ...structuredClone(adapter.manifest), capabilities: [...adapter.manifest.capabilities],
      verified: adapter.manifest.fixtureOnly === true ? false : adapter.manifest.verified === true });
    return Object.freeze({ manifest, execute: request => execute(kind, adapter, owner, capability, request) });
  }

  async function execute(kind, adapter, owner, capability, input) {
    if (!same(owner, input) || input.capability !== capability || typeof input.operationId !== "string"
      || !/^[A-Za-z0-9:_-]{1,160}$/.test(input.operationId) || typeof input.authorize !== "function"
      || !input.args || typeof input.args !== "object" || Array.isArray(input.args)) {
      return { status: "failed", applied: false, code: "INVALID_REQUEST" };
    }
    const actionAllowed = WORK_CAPABILITIES[capability]?.includes(input.action);
    if (!actionAllowed) return { status: "failed", applied: false, code: "ACTION_DENIED" };
    const op = JSON.stringify([keyOf(owner), input.operationId]);
    const slot = keyOf(owner);
    if (used.has(op)) return { status: "failed", applied: false, code: "OPERATION_ALREADY_USED" };
    if (closedOwners.has(slot)) return unavailable("Task session closed; a new task identity is required");
    if (blockedOwners.has(slot)) return unavailable("Previous execution or cleanup is uncertain; supervisor recovery required");
    if (ownersBusy.has(slot)) return { status: "failed", applied: false, code: "TASK_BUSY" };
    if (used.size >= 4096) return unavailable("Operation ledger full; refusing eviction/replay");
    let request;
    try { request = { ...input, ...owner, args: freeze(structuredClone(input.args)) }; }
    catch { return { status: "failed", applied: false, code: "INVALID_REQUEST" }; }
    used.add(op);
    ownersBusy.add(slot);
    try {
      if (request.signal?.aborted) throw fail("ABORTED");
      const ready = await adapter.readiness({ prompt: false, owner });
      if (ready?.available !== true) return unavailable(ready?.reason || "Host permissions/isolation not ready");
      return kind === "browser" ? await browserExecute(adapter, request, slot) : await desktopExecute(adapter, request);
    } catch (error) {
      // Do not return adapter error strings (may contain typed text, paths or credentials).
      return failure(error);
    } finally { ownersBusy.delete(slot); }
  }

  async function browserExecute(adapter, request, slot) {
    if (request.capability === "public_web") return unavailable("Public search/fetch adapter is not implemented; browser verbs are not public_web authority");
    if (request.capability === "authenticated_browser"
      && await authorizeBrowserSession({ ...identity(request), sessionId: request.args.sessionId, operationId: request.operationId }) !== true) {
      return unavailable("Authenticated context needs explicit same-task session authorization; system sessions forbidden");
    }
    // Fresh context per task/identity, never a system profile. Handles/cookies
    // may continue ONLY within this task until closeTask; none cross tasks.
    // Authenticated cookies must never be reused by a later public/isolated
    // capability invocation, even under the same task identity.
    if (typeof request.args.sessionId !== "string" || !/^[A-Za-z0-9:_-]{1,160}$/.test(request.args.sessionId)) throw fail("SCOPE_DENIED");
    const sessionKey = JSON.stringify([slot, request.args.sessionId, request.capability === "authenticated_browser" ? "authenticated" : "isolated"]);
    let record = sessions.get(sessionKey);
    if (!record) {
      const partition = freeze({ id: randomUUID(), owner: identity(request),
        downloads: `task-${createHash("sha256").update(slot).digest("hex")}/${randomUUID()}` });
      record = { partition, controller: new AbortController(), current: null, networkFailure: null, session: null };
      if (sessions.size >= 64) return unavailable("Session limit reached; close task contexts first");
      sessions.set(sessionKey, record);
    }
    const { partition } = record;
    record.current = request;
    let session = record.session, attempted = false, opening = false, result;
    const onRequest = async event => {
      try {
        const current = record.current;
        if (!current) throw fail("SCOPE_DENIED");
        const url = await assertPublicWebUrl(event.url, { resolve });
        const target = { kind: "network", url, method: String(event.method || "").toUpperCase(), resourceType: event.resourceType };
        if (!target.method) throw fail("SCOPE_DENIED");
        check(current, "network", target, { action: "network_request" });
        if (record.current !== current) throw fail("SCOPE_DENIED");
      } catch (error) { record.networkFailure = error; throw error; }
    };
    try {
      // URL supplied as a destination, not as trusted target evidence.
      if (request.action === "navigate") await assertPublicWebUrl(request.args.url, { resolve });
      if (!session) {
        // Broker checked before dispatch. Context creation must be a fresh,
        // private, about:blank context (no user state and no initial wire).
        opening = true;
        session = await adapter.openSession({ owner: identity(request), partition, onRequest, signal: record.controller.signal,
          authorizeStep: (action, target) => {
            if (!record.current) throw fail("SCOPE_DENIED");
            return check(record.current, "wire", target, { action });
          } });
        record.session = session;
        opening = false;
      }
      if (!same(request, session?.owner) || session.partition?.id !== partition.id) throw fail("SCOPE_DENIED");
      const target = await session.observe(request.action, request.args);
      if (!target || target.fresh !== true || target.partitionId !== partition.id) throw fail("SCOPE_DENIED");
      if (target.url) await assertPublicWebUrl(target.url, { resolve });
      check(request, "before", target);
      if (record.current !== request || record.controller.signal.aborted) throw fail("ABORTED");
      if (record.networkFailure) throw record.networkFailure;
      attempted = true;
      const data = await session.execute(request.action, request.args, target);
      if (record.current !== request || record.controller.signal.aborted) throw fail("ABORTED");
      if (record.networkFailure) throw record.networkFailure;
      const after = await session.observe("verify", { ...request.args, verifyAction: request.action });
      if (!after || after.fresh !== true || after.partitionId !== partition.id) throw fail("SCOPE_DENIED");
      if (after.url) await assertPublicWebUrl(after.url, { resolve });
      check(request, "after", after);
      result = { status: "succeeded", data };
    } catch (error) {
      if (attempted || opening) { blockedOwners.add(slot); result = { status: "uncertain", code: "EXECUTION_UNCERTAIN", retryable: false }; }
      else result = failure(error);
    } finally {
      record.current = null;
      if (result?.status === "uncertain" || opening) {
        record.controller.abort();
        try {
          if (!session || await session.close() !== true) throw fail("STOP_UNCONFIRMED");
          sessions.delete(sessionKey);
        } catch {
          blockedOwners.add(slot);
          result = { status: "uncertain", code: "CONTEXT_STOP_UNCONFIRMED", retryable: false };
        }
      }
    }
    return result;
  }

  async function desktopExecute(adapter, request) {
    const lease = await leaseManager.acquire(request, { signal: request.signal });
    const slot = keyOf(request);
    let attempted = false;
    try {
      return await leaseManager.run(lease, async signal => {
        const args = request.args;
        const authorizeStep = (action, target) => {
          leaseManager.assert(lease);
          validateDesktopTarget(target, args);
          return check({ ...request, signal }, "wire", target, { action });
        };
        const target = await adapter.observe({ owner: identity(request), lease, action: request.action, args, authorizeStep });
        validateDesktopTarget(target, args);
        check({ ...request, signal }, "before", target);
        leaseManager.assert(lease);
        attempted = true;
        const response = request.capability === "desktop_observe" || request.capability === "app" && request.action === "observe" ? { stopped: true, data: target }
          : await adapter.execute({ owner: identity(request), lease, action: request.action, args, target, signal, authorizeStep });
        if (response?.stopped !== true) throw fail("STOP_UNCONFIRMED");
        const after = await adapter.observe({ owner: identity(request), lease, action: "verify", args, authorizeStep });
        validateDesktopTarget(after, args);
        check({ ...request, signal }, "after", after);
        return { stopped: true, data: response.data };
      }).then(response => ({ status: "succeeded", data: response.data }));
    } catch (error) {
      if (attempted) { blockedOwners.add(slot); return { status: "uncertain", code: "EXECUTION_UNCERTAIN", retryable: false }; }
      throw error;
    } finally {
      try { leaseManager.release(lease); } catch (error) { if (error.code !== "GUI_STALE_FENCE") throw error; }
    }
  }

  async function closeTask(task) {
    const owner = identity(task), slot = keyOf(owner);
    if (!same(owner, owner)) return { status: "failed", applied: false, code: "INVALID_REQUEST" };
    closedOwners.add(slot);
    let uncertain = false;
    for (const [sessionKey, record] of sessions) {
      if (keyOf(record.partition.owner) !== slot) continue;
      record.current = null;
      record.controller.abort();
      try {
        if (!record.session || await record.session.close() !== true) throw fail("STOP_UNCONFIRMED");
        sessions.delete(sessionKey);
      } catch { blockedOwners.add(slot); uncertain = true; }
    }
    return uncertain ? { status: "uncertain", code: "CONTEXT_STOP_UNCONFIRMED", retryable: false }
      : { status: "succeeded", data: { closed: true } };
  }

  return Object.freeze({ getBackend, closeTask });
}

function validateDesktopTarget(target, args) {
  // No arbitrary selectors, coordinates, process IDs or cross-app handles.
  if (!target || target.fresh !== true || target.controllable !== true || typeof target.handle !== "string" || !target.handle
    || typeof target.windowId !== "string" || !target.windowId || target.bundleId !== args.app
    || args.handle !== undefined && args.handle !== target.handle || args.windowId !== undefined && args.windowId !== target.windowId
    || "selector" in args || "pid" in args || "x" in args || "y" in args) throw fail("SCOPE_DENIED");
}

export function createMacDesktopBackendContract() {
  const reason = "Mac native driver unavailable: no exclusive OS host supervisor, TCC proof, atomic AX handle/fence RPC or stop acknowledgement implemented";
  return Object.freeze({ manifest: freeze({ id: "mac-desktop", capabilities: [...DESKTOP], verified: false, available: false, gaps: [reason] }),
    execute: async () => unavailable(reason) });
}

/** Contract only: never accepts an arbitrary URL/RPC or arbitrary shell.
 * A future host must pin TLS peer identity, authenticate both directions,
 * negotiate capabilities/isolation/epoch and prove GUI exclusivity. */
export function createRemoteWorkerHost() {
  return Object.freeze({ manifest: freeze({ id: "remote-worker-host", capabilities: [], verified: false,
    available: false, requiredHandshake: { transport: "mutually-authenticated-pinned-TLS", protocol: "work-host-v1",
      hostOwnedFields: ["peerIdentity", "epoch", "capabilities", "osIsolation", "networkIsolation", "guiExclusive", "stopAcknowledgements"],
      taskOwnedFields: ["taskId", "accountId", "logicalBotId", "operationId", "capability", "action"],
      arbitraryShell: false, publicUnauthenticatedRpc: false },
    gaps: ["Authenticated pinned TLS handshake and remote GUI fencing are not implemented"] }),
    execute: async () => unavailable("No authenticated TLS/capability handshake; remote execution disabled") });
}

const defaultRegistry = createWorkBackends();
export const getBackend = (capability, task) => defaultRegistry.getBackend(capability, task);
