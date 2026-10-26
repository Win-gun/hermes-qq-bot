import assert from "node:assert/strict";
import { GuiLeaseManager, globalGuiLease } from "../src/gui-lease.js";
import { WORK_CAPABILITIES, createWorkBackends, getBackend, assertPublicWebUrl,
  createMacDesktopBackendContract, createRemoteWorkerHost } from "../src/work-backends.js";
import { createPlaywrightBrowserAdapter } from "../src/work-browser.js";
import { CapabilityBroker, CapabilityError, normalizeWorkGrant, operationDigest } from "../src/work-capabilities.js";

// Pure fixtures: no fs, DNS, network, subprocess, TCC, browsers or GUI.
const cases = [];
async function test(name, fn) { await fn(); cases.push(name); }
const owner = (taskId = "task_a", logicalBotId = "bot_a", accountId = "account_a") => ({ taskId, logicalBotId, accountId });
const authority = () => ({ scope: { actions: [...new Set(Object.values(WORK_CAPABILITIES).flat())],
  sessionId: "fixture_session", domains: ["example.com"], apps: ["fixture.allowed"] } });
const req = (extra = {}) => ({ ...owner(), operationId: "op_1", capability: "isolated_browser", action: "read",
  authorize: authority, ...extra, args: { sessionId: "fixture_session", ...extra.args } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function clock() {
  let now = 0, next = 0;
  const timers = new Map();
  return { now: () => now, setTimer: (fn, ms) => { const id = ++next; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: id => timers.delete(id), advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); due[1].fn();
      }
    } };
}
async function arbiter() {
  const time = clock(), manager = new GuiLeaseManager(time);
  await manager.recover(async () => true);
  return { manager, time };
}
const resolvePublic = async () => [{ address: "93.184.216.34", family: 4 }];
function browserFixture(options = {}) {
  const stats = { opens: [], effects: [], observations: [], closes: 0 };
  const adapter = { manifest: { id: "fixture-browser", verified: false, fixtureOnly: true,
    capabilities: ["public_web", "isolated_browser", "authenticated_browser"] },
    readiness: async () => { await options.onReadiness?.(); return options.ready || { available: true }; },
    async openSession(host) {
      stats.opens.push(host);
      if (options.open) return options.open(host);
      const cookies = new Map();
      return { owner: options.badOwner ? owner("other") : host.owner, partition: host.partition,
        observe: async (action, args) => {
          stats.observations.push(action);
          if (options.observe) return options.observe(host, action, args);
          return { kind: "browser", fresh: true, partitionId: host.partition.id, url: "https://example.com/", handle: "host_element" };
        },
        execute: async (action, args, target) => {
          stats.effects.push({ action, args, target });
          if (options.execute) return options.execute(host, action, args, target);
          if (args.setCookie) cookies.set("session", args.setCookie);
          return { cookie: cookies.get("session") || null };
        },
        close: async () => { stats.closes++; if (options.close) return options.close(); return true; } };
    } };
  const registry = createWorkBackends({ browserAdapter: adapter, allowFixtures: true, resolve: resolvePublic,
    authorizeBrowserSession: options.authorizeBrowserSession });
  return { adapter, registry, stats, execute: r => registry.getBackend(r.capability, r).execute(r) };
}
function desktopFixture(manager, options = {}) {
  const stats = { effects: [], observed: [], prompts: [] };
  const adapter = { manifest: { id: "fixture-desktop", verified: false, fixtureOnly: true,
    capabilities: ["desktop_observe", "desktop_input", "app"] },
    readiness: async args => { stats.prompts.push(args.prompt); return options.ready || { available: true }; },
    observe: async input => {
      stats.observed.push(input);
      return options.target || { fresh: true, controllable: true, handle: "host:window:1", bundleId: "fixture.allowed", windowId: "window_1" };
    },
    execute: async input => { stats.effects.push(input); return options.execute ? options.execute(input) : { stopped: true, data: { verified: true } }; } };
  const registry = createWorkBackends({ desktopAdapter: adapter, allowFixtures: true, leaseManager: manager });
  const request = extra => req({ capability: "desktop_input", action: "click", args: { app: "fixture.allowed", handle: "host:window:1" }, ...extra });
  return { registry, stats, request, execute: r => registry.getBackend(r.capability, r).execute(r) };
}

await test("default global physical host is not armed", () => assert.equal(globalGuiLease.snapshot().ready, false));
await test("startup and restart require idle proof; queued actions not replayed", async () => {
  const m = new GuiLeaseManager(clock());
  await assert.rejects(m.acquire(owner()), /GUI_UNAVAILABLE/);
  await assert.rejects(m.recover(async () => false), /GUI_HOST_NOT_CONFIRMED_IDLE/);
  await m.recover(async () => true);
  const a = await m.acquire(owner());
  const n = new GuiLeaseManager(clock());
  assert.notEqual(m.snapshot().epoch, n.snapshot().epoch);
  await assert.rejects(n.acquire(owner()), /GUI_UNAVAILABLE/);
  assert.throws(() => n.release(a), /GUI_STALE_FENCE/); m.release(a);
});
await test("cross-bot FIFO shares one physical desktop", async () => {
  const { manager: m } = await arbiter();
  const a = await m.acquire(owner()), order = [];
  const pb = m.acquire(owner("b", "bot_b", "b")).then(b => { order.push("b"); return b; });
  const pc = m.acquire(owner("c", "bot_c", "c")).then(c => { order.push("c"); return c; });
  assert.equal(m.snapshot().waiting, 2);
  m.release(a); const b = await pb; assert.deepEqual(order, ["b"]);
  m.release(b); const c = await pc; assert.deepEqual(order, ["b", "c"]); m.release(c);
});
await test("fences are random and stale/forged tokens cannot release", async () => {
  const { manager: m } = await arbiter(); const a = await m.acquire(owner());
  assert.throws(() => m.release({ ...a }), /GUI_STALE_FENCE/);
  m.release(a); const b = await m.acquire(owner());
  assert.notEqual(a.token, b.token); assert.throws(() => m.assert(a), /GUI_STALE_FENCE/); m.release(b);
});
await test("cancel waiting removes only that FIFO entry", async () => {
  const { manager: m } = await arbiter(); const a = await m.acquire(owner()), abort = new AbortController();
  const b = m.acquire(owner("b"), { signal: abort.signal });
  const rejected = assert.rejects(b, /GUI_ABORTED/); abort.abort(); await rejected;
  assert.equal(m.snapshot().waiting, 0); m.release(a);
});
await test("waiting timeout never steals owner", async () => {
  const { manager: m, time } = await arbiter(); const a = await m.acquire(owner(), { ttlMs: 100 });
  const b = m.acquire(owner("b"), { waitTimeoutMs: 5 });
  const rejected = assert.rejects(b, /GUI_WAIT_TIMEOUT/); time.advance(6); await rejected;
  assert.equal(m.assert(a), true); m.release(a);
});
await test("TTL cannot hand over non-cooperative execution", async () => {
  const { manager: m, time } = await arbiter(), native = deferred();
  const a = await m.acquire(owner(), { ttlMs: 5 });
  const running = m.run(a, () => native.promise); const rejected = assert.rejects(running, /GUI_LEASE_REVOKED/);
  let granted = false; const next = m.acquire(owner("b")).then(b => { granted = true; return b; });
  time.advance(6); await tick(); assert.equal(granted, false); assert.equal(m.snapshot().holder.inFlight, 1);
  native.resolve({ stopped: true }); await rejected; const b = await next; m.release(b);
});
await test("abort revokes but does not unlock in-flight desktop", async () => {
  const { manager: m } = await arbiter(), native = deferred(), c = new AbortController();
  const a = await m.acquire(owner(), { signal: c.signal }); const running = m.run(a, () => native.promise);
  const rejected = assert.rejects(running, /GUI_LEASE_REVOKED/); c.abort();
  assert.equal(m.release(a), false); assert.equal(m.snapshot().holder.inFlight, 1);
  native.resolve({ stopped: true }); await rejected; assert.equal(m.snapshot().holder, null);
});
await test("uncertain rejection quarantines lock until supervisor acknowledgement", async () => {
  const { manager: m } = await arbiter(), a = await m.acquire(owner());
  await assert.rejects(m.run(a, async () => { throw new Error("fixture crash"); }));
  assert.equal(m.release(a), false); assert.equal(m.snapshot().holder.uncertain, true);
  await assert.rejects(m.confirmStopped(a, async () => false), /GUI_STOP_UNCONFIRMED/);
  await m.confirmStopped(a, async () => true); assert.equal(m.snapshot().holder, null);
});
await test("plain success without stopped acknowledgement is uncertain", async () => {
  const { manager: m } = await arbiter(), a = await m.acquire(owner());
  await assert.rejects(m.run(a, async () => ({ ok: true })), /GUI_STOP_UNCONFIRMED/);
  assert.equal(m.snapshot().holder.uncertain, true); await m.confirmStopped(a, async () => true);
});
await test("supervisor can fence pending old worker; old completion cannot release new owner", async () => {
  const { manager: m } = await arbiter(), pending = deferred(), a = await m.acquire(owner());
  const running = m.run(a, () => pending.promise); const rejected = assert.rejects(running, /GUI_STALE_FENCE/);
  m.release(a); await m.confirmStopped(a, async () => true);
  const b = await m.acquire(owner("b")); pending.resolve({ stopped: true }); await rejected;
  assert.equal(m.assert(b), true); m.release(b);
});
await test("close cancels waiters without releasing an uncertain holder", async () => {
  const { manager: m } = await arbiter(), a = await m.acquire(owner()), pending = deferred();
  const running = m.run(a, () => pending.promise), stopped = assert.rejects(running, /GUI_CLOSED|GUI_LEASE_REVOKED/);
  const wait = assert.rejects(m.acquire(owner("b")), /GUI_CLOSED/); m.close(); await wait;
  assert.equal(m.snapshot().holder.inFlight, 1); pending.resolve({ stopped: true }); await stopped;
});
await test("same lease cannot execute concurrent native actions", async () => {
  const { manager: m } = await arbiter(), a = await m.acquire(owner()), p = deferred();
  const running = m.run(a, () => p.promise); await assert.rejects(m.run(a, async () => ({ stopped: true })), /GUI_ACTION_IN_FLIGHT/);
  p.resolve({ stopped: true }); await running; m.release(a);
});
await test("invalid identity/TTL and pre-aborted queue fail closed", async () => {
  const { manager: m } = await arbiter(); await assert.rejects(m.acquire({ taskId: "x" }), /GUI_INVALID_LEASE/);
  await assert.rejects(m.acquire(owner(), { ttlMs: 0 }), /GUI_INVALID_LEASE/);
  const c = new AbortController(); c.abort(); await assert.rejects(m.acquire(owner(), { signal: c.signal }), /GUI_ABORTED/);
});
await test("guard error named revoked is not proof the worker stopped", async () => {
  const { manager: m } = await arbiter(), a = await m.acquire(owner());
  await assert.rejects(m.run(a, async () => { throw Object.assign(new Error("GUI_LEASE_REVOKED"), { code: "GUI_LEASE_REVOKED" }); }));
  assert.equal(m.snapshot().holder.uncertain, true); await m.confirmStopped(a, async () => true);
});

await test("all default capabilities including code/files are unavailable; no fallback", async () => {
  for (const capability of Object.keys(WORK_CAPABILITIES)) {
    const b = getBackend(capability, owner()); assert.equal(b.manifest.verified, false);
    assert.equal((await b.execute(req({ capability }))).code, "UNAVAILABLE");
  }
});
await test("fixture drivers are never verified nor enabled by default", async () => {
  const fixture = browserFixture(); const r = req();
  assert.equal(fixture.registry.getBackend(r.capability, r).manifest.verified, false);
  const defaults = createWorkBackends({ browserAdapter: fixture.adapter });
  assert.equal((await defaults.getBackend(r.capability, r).execute(r)).code, "UNAVAILABLE");
});
await test("unverified driver cannot claim readiness into authority", async () => {
  const adapter = { manifest: { id: "unverified", verified: false, available: true, capabilities: ["isolated_browser"] },
    readiness: () => assert.fail("must not call unverified host") };
  const b = createWorkBackends({ browserAdapter: adapter }).getBackend("isolated_browser", owner());
  assert.equal((await b.execute(req())).code, "UNAVAILABLE");
});
await test("identity binding rejects task/account/bot changes", async () => {
  const f = browserFixture(), b = f.registry.getBackend("isolated_browser", owner());
  for (const extra of [{ taskId: "other" }, { logicalBotId: "other" }, { accountId: "other" }]) {
    assert.equal((await b.execute(req(extra))).code, "INVALID_REQUEST");
  }
  assert.equal(f.stats.opens.length, 0);
});
await test("guard is mandatory; raw action and unsupported capability rejected", async () => {
  const f = browserFixture(); assert.equal((await f.execute(req({ authorize: undefined }))).code, "INVALID_REQUEST");
  assert.equal((await f.execute(req({ action: "evaluate" }))).code, "ACTION_DENIED");
  assert.equal((await f.execute(req({ capability: "external_write" }))).code, "UNAVAILABLE");
});
await test("successful operation is not replayed via another backend instance", async () => {
  const f = browserFixture(); assert.equal((await f.execute(req())).status, "succeeded");
  assert.equal((await f.execute(req())).code, "OPERATION_ALREADY_USED"); assert.equal(f.stats.effects.length, 1);
  await f.registry.closeTask(owner());
});
await test("pre-aborted request never opens context", async () => {
  const f = browserFixture(), c = new AbortController(); c.abort();
  assert.equal((await f.execute(req({ signal: c.signal }))).code, "ABORTED"); assert.equal(f.stats.opens.length, 0);
});
await test("host readiness unavailable never opens context or prompts", async () => {
  const f = browserFixture({ ready: { available: false, reason: "fixture isolation missing" } });
  assert.equal((await f.execute(req())).code, "UNAVAILABLE"); assert.equal(f.stats.opens.length, 0);
});
await test("authorization denial has no interaction side effect", async () => {
  const f = browserFixture(); assert.equal((await f.execute(req({ authorize: () => false }))).code, "AUTHORIZATION_DENIED");
  assert.equal(f.stats.effects.length, 0); await f.registry.closeTask(owner());
});
await test("task partition cookies and download namespaces never cross bot/task", async () => {
  const f = browserFixture(); await f.execute(req({ args: { setCookie: "fixture-cookie" } }));
  const repeat = await f.execute(req({ operationId: "op_2" })); assert.equal(repeat.data.cookie, "fixture-cookie");
  const other = req({ ...owner("task_b", "bot_b", "account_b") });
  assert.equal((await f.execute(other)).data.cookie, null);
  assert.notEqual(f.stats.opens[0].partition.id, f.stats.opens[1].partition.id);
  assert.notEqual(f.stats.opens[0].partition.downloads, f.stats.opens[1].partition.downloads);
  assert.equal(f.stats.opens.length, 2); await f.registry.closeTask(owner()); await f.registry.closeTask(other);
});
await test("same task ID under another logical bot still gets isolated context", async () => {
  const f = browserFixture(); await f.execute(req()); await f.execute(req({ logicalBotId: "bot_other" }));
  assert.notEqual(f.stats.opens[0].partition.downloads, f.stats.opens[1].partition.downloads);
  await f.registry.closeTask(owner()); await f.registry.closeTask(owner("task_a", "bot_other"));
});
await test("authenticated browser requires explicit same-task host authorization", async () => {
  const f = browserFixture(); assert.equal((await f.execute(req({ capability: "authenticated_browser" }))).code, "UNAVAILABLE");
  assert.equal(f.stats.opens.length, 0);
  const seen = [], permitted = browserFixture({ authorizeBrowserSession: async context => { seen.push(context); return true; } });
  assert.equal((await permitted.execute(req({ capability: "authenticated_browser" }))).status, "succeeded");
  assert.equal(seen[0].taskId, "task_a"); await permitted.registry.closeTask(owner());
});
await test("host-observed target, not model readOnly/url, reaches guard", async () => {
  const f = browserFixture(), seen = [];
  await f.execute(req({ args: { readOnly: true, url: "https://model.invalid/" }, authorize: event => { seen.push(event); return authority(); } }));
  assert.equal(seen.find(e => e.phase === "before").target, "https://example.com/");
  assert.equal(seen.find(e => e.phase === "before").hostTarget.url, "https://example.com/");
  assert.equal(seen.find(e => e.phase === "before").action, "read"); await f.registry.closeTask(owner());
});
for (const action of ["navigate", "click", "fill", "type", "press", "upload"]) {
  await test(`${action} cannot bypass pinned authorization using readOnly=true`, async () => {
    const f = browserFixture(), seen = [];
    const result = await f.execute(req({ action, args: { readOnly: true, url: "https://example.com/" }, authorize: event => {
      seen.push(event); return false;
    } }));
    assert.equal(result.code, "AUTHORIZATION_DENIED"); assert.equal(f.stats.effects.length, 0);
    assert.equal(seen[0].action, action); assert.equal(seen[0].target, "https://example.com/"); await f.registry.closeTask(owner());
  });
}
await test("unexpected POST in read-only operation is refused, not upgraded to a write", async () => {
  const seen = [], f = browserFixture({ execute: async host => { await host.onRequest({ url: "https://example.com/post", method: "POST", resourceType: "fetch" }); } });
  const result = await f.execute(req({ authorize: event => { seen.push(event); return authority(); } }));
  assert.equal(result.status, "uncertain"); assert.equal(seen.find(e => e.phase === "network").hostTarget.method, "POST");
  assert.equal(seen.find(e => e.phase === "network").action, "network_request");
});
await test("redirect/subresource private address denied at request boundary", async () => {
  const f = browserFixture({ execute: async host => { await host.onRequest({ url: "http://127.0.0.1/", method: "GET", resourceType: "image" }); } });
  assert.equal((await f.execute(req())).status, "uncertain");
});
await test("network work outside an active operation is denied", async () => {
  const f = browserFixture(); await f.execute(req());
  await assert.rejects(f.stats.opens[0].onRequest({ url: "https://example.com/", method: "GET" }), /SCOPE_DENIED/);
  assert.equal((await f.execute(req({ operationId: "op_2" }))).status, "failed"); await f.registry.closeTask(owner());
});
await test("abort during pre-action guard prevents execution", async () => {
  const c = new AbortController(), f = browserFixture();
  const r = await f.execute(req({ signal: c.signal, authorize: e => { if (e.phase === "before") c.abort(); return authority(); } }));
  assert.equal(r.code, "ABORTED"); assert.equal(f.stats.effects.length, 0); await f.registry.closeTask(owner());
});
await test("task close during guard cannot be followed by a late execute", async () => {
  const f = browserFixture(); let closed; const r = await f.execute(req({ authorize: e => {
    if (e.phase === "before") closed = f.registry.closeTask(owner()); return authority();
  } })); await closed; assert.equal(r.code, "ABORTED"); assert.equal(f.stats.effects.length, 0);
});
await test("uncertain browser execution is never retried by new operation ID", async () => {
  const f = browserFixture({ execute: async () => { throw new Error("fixture effect unknown"); } });
  assert.equal((await f.execute(req())).status, "uncertain");
  assert.equal((await f.execute(req({ operationId: "op_2" }))).code, "UNAVAILABLE"); assert.equal(f.stats.effects.length, 1);
});
await test("uncertain context close quarantines task", async () => {
  const f = browserFixture({ close: async () => false }); await f.execute(req());
  assert.equal((await f.registry.closeTask(owner())).status, "uncertain");
  assert.equal((await f.execute(req({ operationId: "op_2" }))).code, "UNAVAILABLE");
});
await test("partial context open failure is uncertain, not fake success", async () => {
  const f = browserFixture({ open: async () => { throw new Error("fixture partial start"); } });
  assert.equal((await f.execute(req())).status, "uncertain");
  assert.equal((await f.execute(req({ operationId: "op_2" }))).code, "UNAVAILABLE");
});
await test("adapter cannot return a context belonging to another task", async () => {
  const f = browserFixture({ badOwner: true }); assert.equal((await f.execute(req())).code, "SCOPE_DENIED");
  assert.equal(f.stats.effects.length, 0); await f.registry.closeTask(owner());
});
await test("post-observation guard failure cannot be claimed as success", async () => {
  const f = browserFixture(); const result = await f.execute(req({ authorize: e => e.phase !== "after" ? authority() : false }));
  assert.equal(result.status, "uncertain"); assert.equal(result.retryable, false);
});
await test("same task concurrent operations do not race guards/context", async () => {
  const pending = deferred(), f = browserFixture({ execute: () => pending.promise });
  const running = f.execute(req()); await tick();
  assert.equal((await f.execute(req({ operationId: "op_2" }))).code, "TASK_BUSY");
  pending.resolve({ fixture: true }); await running; await f.registry.closeTask(owner());
});

for (const url of ["file:///fixture", "data:text/plain,fixture", "javascript:alert(1)", "ftp://example.com/", "http://localhost/",
  "http://metadata.google.internal/", "http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://10.1.2.3/",
  "http://172.16.0.1/", "http://192.168.1.1/", "http://169.254.169.254/", "http://100.64.0.1/", "http://224.0.0.1/",
  "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://example.com:6200/", "https://fixture:secret@example.com/"]) {
  await test(`URL denied: ${url.split("//").pop()}`, () => assert.rejects(assertPublicWebUrl(url, { resolve: resolvePublic }), /URL_DENIED/));
}
await test("public URL accepted only when every DNS answer is public", async () => {
  assert.equal(await assertPublicWebUrl("https://example.com/a", { resolve: resolvePublic }), "https://example.com/a");
  await assert.rejects(assertPublicWebUrl("https://example.com/", { resolve: async () => [{ address: "93.184.216.34" }, { address: "10.0.0.1" }] }), /URL_DENIED/);
  await assert.rejects(assertPublicWebUrl("https://example.com/", { resolve: async () => [] }), /URL_DENIED/);
});

await test("missing TCC/host permission cannot call desktop observe or prompt", async () => {
  const { manager } = await arbiter(), f = desktopFixture(manager, { ready: { available: false, reason: "TCC_MISSING" } });
  assert.equal((await f.execute(f.request())).code, "UNAVAILABLE"); assert.equal(f.stats.observed.length, 0);
  assert.deepEqual(f.stats.prompts, [false]);
});
await test("desktop observes, guards host target, executes and observes again", async () => {
  const { manager } = await arbiter(), f = desktopFixture(manager), seen = [];
  const r = await f.execute(f.request({ authorize: e => { seen.push(e); return authority(); } }));
  assert.equal(r.status, "succeeded"); assert.equal(f.stats.observed.length, 2); assert.equal(f.stats.effects.length, 1);
  assert.equal(seen[0].hostTarget.bundleId, "fixture.allowed"); assert.equal(seen[0].target, "host:window:1");
  assert.equal(seen[1].phase, "after");
  assert.equal(manager.snapshot().holder, null);
});
for (const target of [{ bundleId: "fixture.other" }, { fresh: false }, { controllable: false }, { handle: "" }, { windowId: "" }]) {
  await test(`desktop rejects host target boundary ${Object.keys(target)[0]}`, async () => {
    const { manager } = await arbiter(); const f = desktopFixture(manager, { target: { fresh: true, controllable: true,
      handle: "host:1", windowId: "window_1", bundleId: "fixture.allowed", ...target } });
    assert.equal((await f.execute(f.request())).code, "SCOPE_DENIED"); assert.equal(f.stats.effects.length, 0);
  });
}
await test("desktop disallows raw arbitrary selector/coordinates", async () => {
  const { manager } = await arbiter(), f = desktopFixture(manager);
  assert.equal((await f.execute(f.request({ args: { app: "fixture.allowed", selector: "*" } }))).code, "SCOPE_DENIED");
  assert.equal(f.stats.effects.length, 0);
});
await test("desktop uncertain response keeps physical lock and blocks cross-bot takeover", async () => {
  const { manager, time } = await arbiter(), f = desktopFixture(manager, { execute: async () => ({ data: { ok: true } }) });
  const r = await f.execute(f.request()); assert.equal(r.status, "uncertain"); assert.equal(manager.snapshot().holder.uncertain, true);
  const next = manager.acquire(owner("task_b", "bot_b"), { waitTimeoutMs: 5 });
  const rejected = assert.rejects(next, /GUI_WAIT_TIMEOUT/); time.advance(6); await rejected;
  assert.equal(f.stats.effects.length, 1);
});
await test("app operation and desktop action capabilities cannot be swapped", async () => {
  const { manager } = await arbiter(), f = desktopFixture(manager);
  assert.equal((await f.execute(f.request({ action: "focus" }))).code, "ACTION_DENIED");
  assert.equal((await f.execute(f.request({ capability: "app", action: "focus" }))).status, "succeeded");
});
await test("native Mac and RemoteWorkerHost are explicit unavailable contracts", async () => {
  for (const backend of [createMacDesktopBackendContract(), createRemoteWorkerHost()]) {
    assert.equal(backend.manifest.verified, false); assert.equal((await backend.execute(req())).code, "UNAVAILABLE");
    assert.ok(backend.manifest.gaps.length);
  }
});

// Exercise the actual Playwright-context source with a tiny in-memory API peer.
function playwrightPeer({ failClose = false } = {}) {
  const stats = { contexts: [], routes: [], actions: [], closed: 0 };
  const browser = { async newContext(options) {
    const state = { options, cookie: null, url: "about:blank", elementUrl: "https://example.com/form", route: null, closed: false };
    stats.contexts.push(state);
    const element = { evaluate: async () => ({ tag: "input", type: "text", role: "", url: state.elementUrl, method: "POST", connected: true }),
      click: async () => stats.actions.push("click"), fill: async () => stats.actions.push("fill"),
      press: async () => stats.actions.push("press"), setInputFiles: async () => stats.actions.push("upload") };
    const page = { url: () => state.url,
      goto: async url => {
        await state.route({ request: () => ({ url: () => url, method: () => "GET", resourceType: () => "document" }),
          continue: async () => { state.url = url; stats.routes.push(url); }, abort: async () => stats.routes.push("blocked") });
      }, locator: () => ({ elementHandles: async () => [element], innerText: async () => "fixture page" }),
      screenshot: async () => Buffer.from("fixture screenshot"), close: async () => {} };
    return { routeWebSocket: async () => {}, route: async (_, callback) => { state.route = callback; }, newPage: async () => page,
      on: () => {}, close: async () => { stats.closed++; if (failClose) throw new Error("fixture stop unknown"); state.closed = true; } };
  } };
  return { browser, stats };
}
function contextFixture(options = {}) {
  const peer = playwrightPeer(options);
  const adapter = createPlaywrightBrowserAdapter({ fixtureBrowser: peer.browser, ...options });
  const registry = createWorkBackends({ browserAdapter: adapter, allowFixtures: true, resolve: resolvePublic });
  const execute = r => registry.getBackend(r.capability, r).execute(r);
  return { ...peer, adapter, registry, execute };
}
await test("optional Playwright missing is UNAVAILABLE, no browser launch", async () => {
  let imports = 0; const adapter = createPlaywrightBrowserAdapter({ loadPlaywright: async () => { imports++; throw new Error("fixture missing"); } });
  assert.equal(imports, 0); assert.equal((await adapter.probeDependency()).code, "UNAVAILABLE"); assert.equal(imports, 1);
  assert.equal((await adapter.readiness()).available, false); assert.equal(adapter.manifest.verified, false);
});
await test("dependency presence cannot imply isolated/verified runtime", async () => {
  const adapter = createPlaywrightBrowserAdapter({ loadPlaywright: async () => ({ chromium: { launch: () => assert.fail("no launch") } }) });
  assert.equal((await adapter.probeDependency()).available, false);
  await assert.rejects(adapter.openSession({}), /UNAVAILABLE/);
});
await test("real context adapter starts clean context, routes wire and closes task", async () => {
  const f = contextFixture(), events = [];
  const r = await f.execute(req({ action: "navigate", args: { url: "https://example.com/", userDataDir: "/forbidden-fixture-profile" }, authorize: e => { events.push(e); return authority(); } }));
  assert.equal(r.status, "succeeded"); assert.deepEqual(f.stats.contexts[0].options.storageState, { cookies: [], origins: [] });
  assert.equal(f.stats.contexts[0].options.serviceWorkers, "block"); assert.equal(f.stats.contexts[0].options.userDataDir, undefined);
  assert.equal(events.some(e => e.phase === "network" && e.hostTarget.method === "GET"), true);
  assert.equal((await f.registry.closeTask(owner())).status, "succeeded"); assert.equal(f.stats.closed, 1);
});
await test("context adapter uses fresh opaque handles across task operations", async () => {
  const f = contextFixture(); const inspected = await f.execute(req({ action: "snapshot" }));
  assert.equal(inspected.status, "succeeded"); const handle = inspected.data.targets[0].handle;
  const seen = []; const r = await f.execute(req({ operationId: "op_2", action: "fill", args: { handle, text: "fixture input", readOnly: true }, authorize: e => { seen.push(e); return authority(); } }));
  assert.equal(r.status, "succeeded"); assert.deepEqual(f.stats.actions, ["fill"]);
  assert.equal(seen.some(e => e.phase === "wire" && e.target === "https://example.com/form"), true);
  await f.registry.closeTask(owner());
});
await test("opaque browser handle cannot cross tasks", async () => {
  const f = contextFixture(), inspected = await f.execute(req({ action: "snapshot" }));
  const r = await f.execute(req({ ...owner("task_b"), action: "click", args: { handle: inspected.data.targets[0].handle } }));
  assert.equal(r.status, "failed"); assert.equal(f.stats.actions.length, 0);
  await f.registry.closeTask(owner()); await f.registry.closeTask(owner("task_b"));
});
await test("upload cannot use arbitrary file path; source is scoped fixture artifact", async () => {
  const f = contextFixture(), inspected = await f.execute(req({ action: "snapshot" }));
  const r = await f.execute(req({ operationId: "op_2", action: "upload", args: { handle: inspected.data.targets[0].handle, path: "/forbidden-fixture" } }));
  assert.equal(r.status, "failed"); assert.equal(f.stats.actions.length, 0); await f.registry.closeTask(owner());
});
await test("upload rechecks guard after async artifact resolution", async () => {
  let revoke = false;
  const f = contextFixture({ resolveUpload: async () => { revoke = true; return { ...owner(), name: "fixture.txt", buffer: Buffer.from("fixture") }; } });
  const inspected = await f.execute(req({ action: "snapshot" }));
  const r = await f.execute(req({ operationId: "op_2", action: "upload", args: { handle: inspected.data.targets[0].handle, artifactId: "fixture_artifact" }, authorize: () => revoke ? false : authority() }));
  assert.equal(r.status, "uncertain"); assert.equal(f.stats.actions.length, 0);
});
await test("successful upload uses only host-provided task artifact bytes", async () => {
  const f = contextFixture({ resolveUpload: async () => ({ ...owner(), name: "fixture.txt", buffer: Buffer.from("fixture") }) });
  const inspected = await f.execute(req({ action: "snapshot" }));
  const r = await f.execute(req({ operationId: "op_2", action: "upload", args: { handle: inspected.data.targets[0].handle, artifactId: "fixture_artifact" } }));
  assert.equal(r.status, "succeeded"); assert.deepEqual(f.stats.actions, ["upload"]); await f.registry.closeTask(owner());
});

// Actual CapabilityBroker + registry integration, with an in-memory CAS store.
// IMPORTANT: production registry and adapters remain verified:false, including
// fixture mode. Positive protocol tests must simulate an independent verified
// host at the BROKER boundary because the real broker rejects all unverified
// hosts. This test-only wrapper is NOT an isolation proof or a deployable host.
// Negative tests below verify that the unwrapped registry remains rejected.
function brokerFixture(registry, { simulateHostAttestation = true, persist = true } = {}) {
  const now = Date.UTC(2030, 0, 1);
  const task = { id: "task_a", accountId: "account_a", logicalBotId: "bot_a", status: "running",
    revision: 1, grantRevision: 1, attemptId: "attempt_fixture", attempt: 1, grants: [], operationLedger: [] };
  const records = [], authorizations = [];
  let grants = 0;
  const grant = (capability, scope) => {
    const value = normalizeWorkGrant(task, { capability, scope }, { userId: "fixture_owner", source: "fixture-human" }, now);
    value.id = `fixture_grant_${++grants}`;
    task.grants.push(value); return value;
  };
  const external = r => grant("external_write", { actions: ["post"], target: r.args.target, operationDigest: operationDigest(r) });
  const newBroker = () => new CapabilityBroker({ getTask: id => id === task.id ? task : null,
    getPolicy: () => ({ enabled: true, capabilities: Object.keys(WORK_CAPABILITIES), ownerUserIds: ["fixture_owner"] }),
    validateIdentity: () => true, clock: () => now,
    recordOperation: async record => {
      records.push(structuredClone(record));
      if (!persist) return { ok: false, durable: false };
      const previous = task.operationLedger.find(r => r.operationId === record.operationId);
      if (record.status === "claimed" ? Boolean(previous) : previous?.status !== "claimed") return { ok: false, durable: false };
      if (previous) Object.assign(previous, record); else task.operationLedger.push(structuredClone(record));
      task.revision++;
      return { ok: true, durable: true };
    },
    getBackend: (capability, t) => {
      const backend = registry.getBackend(capability, t);
      if (!simulateHostAttestation) return backend;
      assert.equal(backend.manifest.verified, false, "never upgrade the real registry/adapter");
      return { manifest: { ...backend.manifest, id: "synthetic-host-attestation-fixture-only", fixtureOnly: true,
        verified: true, enforcesScope: true, rechecksAuthorization: true, noAutomaticRetries: true,
        isolated: true, publicNetworkOnly: true, readOnlyActions: ["read", "snapshot"] },
        execute: input => {
          assert.equal(typeof input.authorize, "function"); assert.equal(input.guard, undefined);
          return backend.execute({ ...input, authorize: actual => {
            authorizations.push(structuredClone(actual));
            return input.authorize(actual);
          } });
        } };
    } });
  return { task, records, authorizations, grant, external, newBroker, broker: newBroker() };
}
const browserGrant = (h, actions = ["read", "snapshot", "navigate", "click", "fill", "type", "press", "upload"]) =>
  h.grant("isolated_browser", { actions, sessionId: "fixture_session", domains: ["example.com"] });
const rejectsCode = (fn, code) => assert.rejects(fn, error => error instanceof CapabilityError && error.code === code);

await test("Broker integration: default registry unavailable cannot bypass verification", async () => {
  const h = brokerFixture(createWorkBackends(), { simulateHostAttestation: false }); browserGrant(h);
  await rejectsCode(() => h.broker.execute(req()), "BACKEND_UNVERIFIED"); assert.equal(h.records.length, 0);
});
await test("Broker integration: fixture adapters stay unverified even when enabled for direct tests", async () => {
  const f = browserFixture(), h = brokerFixture(f.registry, { simulateHostAttestation: false }); browserGrant(h);
  await rejectsCode(() => h.broker.execute(req()), "BACKEND_UNVERIFIED"); assert.equal(f.stats.opens.length, 0);
});
await test("Broker integration: authorize and status protocol, durable claimed then succeeded", async () => {
  const f = browserFixture(), h = brokerFixture(f.registry); browserGrant(h);
  const result = await h.broker.execute(req());
  assert.equal(result.receipt.status, "succeeded"); assert.deepEqual(h.records.map(r => r.status), ["claimed", "succeeded"]);
  assert.ok(h.authorizations.length >= 2); assert.equal(h.authorizations[0].target, "https://example.com/");
  assert.equal(f.registry.getBackend("isolated_browser", owner()).manifest.verified, false); await f.registry.closeTask(owner());
});
await test("Broker integration: actual controlled context snapshot/read use current actions", async () => {
  const f = contextFixture(), h = brokerFixture(f.registry); browserGrant(h);
  const snapshot = await h.broker.execute(req({ action: "snapshot" }));
  assert.equal(snapshot.receipt.status, "succeeded"); assert.equal(snapshot.data.targets.length, 1);
  const read = await h.broker.execute(req({ operationId: "op_read" }));
  assert.equal(read.data.text, "fixture page"); assert.equal(f.stats.contexts.length, 1); await f.registry.closeTask(owner());
});
await test("Broker integration: navigation requires extra exact one-shot external grant", async () => {
  const f = contextFixture(), h = brokerFixture(f.registry); browserGrant(h);
  const r = req({ action: "navigate", args: { url: "https://example.com/", target: "https://example.com/", readOnly: true } });
  h.external(r); const result = await h.broker.execute(r);
  assert.equal(result.receipt.status, "succeeded"); assert.ok(result.receipt.externalGrantId);
  assert.ok(h.authorizations.some(a => a.action === "network_request"));
  assert.deepEqual(h.records.map(x => x.status), ["claimed", "succeeded"]); await f.registry.closeTask(owner());
});
for (const action of ["navigate", "click", "fill", "type", "press", "upload"]) {
  await test(`Broker integration: ${action} readOnly flag cannot replace external grant`, async () => {
    const f = browserFixture(), h = brokerFixture(f.registry); browserGrant(h);
    await rejectsCode(() => h.broker.execute(req({ action, args: { target: "https://example.com/", url: "https://example.com/", readOnly: true } })),
      "EXTERNAL_CONFIRMATION_REQUIRED"); assert.equal(f.stats.opens.length, 0);
  });
}
await test("Broker integration: host target drift never borrows model args.target", async () => {
  const f = browserFixture(), h = brokerFixture(f.registry); browserGrant(h);
  const r = req({ action: "click", args: { target: "https://example.com/another" } }); h.external(r);
  await rejectsCode(() => h.broker.execute(r), "BACKEND_REJECTED"); assert.equal(f.stats.effects.length, 0);
  assert.equal(h.authorizations[0].target, "https://example.com/"); assert.equal(h.records.at(-1).applied, false);
  await f.registry.closeTask(owner());
});
await test("Broker integration: host enforces observed domain missing from original model args", async () => {
  const f = browserFixture({ observe: host => ({ fresh: true, partitionId: host.partition.id, url: "https://other.example.com/" }) });
  const h = brokerFixture(f.registry); browserGrant(h);
  await rejectsCode(() => h.broker.execute(req()), "BACKEND_REJECTED"); assert.equal(f.stats.effects.length, 0);
  await f.registry.closeTask(owner());
});
await test("Broker integration: revocation during host readiness prevents action", async () => {
  let h; const f = browserFixture({ onReadiness: async () => { h.task.grantRevision++; } }); h = brokerFixture(f.registry); browserGrant(h);
  await rejectsCode(() => h.broker.execute(req()), "BACKEND_REJECTED"); assert.equal(f.stats.effects.length, 0);
  assert.equal(h.records.at(-1).status, "failed"); await f.registry.closeTask(owner());
});
await test("Broker integration: unconfirmed durable claim prevents context open", async () => {
  const f = browserFixture(), h = brokerFixture(f.registry, { persist: false }); browserGrant(h);
  await rejectsCode(() => h.broker.execute(req()), "OPERATION_DURABILITY_UNKNOWN"); assert.equal(f.stats.opens.length, 0);
});
await test("Broker integration: restart cannot replay an existing durable operation", async () => {
  const f = browserFixture(), h = brokerFixture(f.registry); browserGrant(h); await h.broker.execute(req());
  await rejectsCode(() => h.newBroker().execute(req()), "OPERATION_DUPLICATE"); assert.equal(f.stats.effects.length, 1);
  await f.registry.closeTask(owner());
});
await test("Broker integration: desktop capture uses current app scope without TCC prompt", async () => {
  const { manager } = await arbiter(), f = desktopFixture(manager), h = brokerFixture(f.registry);
  h.grant("desktop_observe", { actions: ["capture", "list_apps"], apps: ["fixture.allowed"] });
  const r = f.request({ capability: "desktop_observe", action: "capture" });
  const result = await h.broker.execute(r); assert.equal(result.receipt.status, "succeeded");
  assert.equal(f.stats.effects.length, 0); assert.deepEqual(f.stats.prompts, [false]);
});
await test("Broker integration: desktop click exact host handle plus one-shot grant", async () => {
  const { manager } = await arbiter(), f = desktopFixture(manager), h = brokerFixture(f.registry);
  h.grant("desktop_input", { actions: ["click"], apps: ["fixture.allowed"] });
  const r = f.request({ args: { app: "fixture.allowed", handle: "host:window:1", target: "host:window:1" } }); h.external(r);
  const result = await h.broker.execute(r); assert.equal(result.receipt.status, "succeeded"); assert.equal(f.stats.effects.length, 1);
  assert.equal(h.authorizations[0].target, "host:window:1"); assert.equal(manager.snapshot().holder, null);
});
await test("Broker integration: uncertain desktop is durable and cannot be replayed", async () => {
  const { manager } = await arbiter(), f = desktopFixture(manager, { execute: async () => ({ stopped: false }) });
  const h = brokerFixture(f.registry); h.grant("desktop_input", { actions: ["click"], apps: ["fixture.allowed"] });
  const r = f.request({ args: { app: "fixture.allowed", target: "host:window:1" } }); h.external(r);
  await rejectsCode(() => h.broker.execute(r), "OPERATION_UNCERTAIN");
  assert.equal(h.records.at(-1).status, "uncertain"); assert.equal(manager.snapshot().holder.uncertain, true);
  await rejectsCode(() => h.newBroker().execute(r), "OPERATION_DUPLICATE"); assert.equal(f.stats.effects.length, 1);
});
await test("Broker integration: upload reauthorizes after artifact await and refuses revocation", async () => {
  let h; const f = contextFixture({ resolveUpload: async () => {
    h.task.grantRevision++; return { ...owner(), name: "fixture.txt", buffer: Buffer.from("fixture") };
  } }); h = brokerFixture(f.registry); browserGrant(h);
  const snapshot = await h.broker.execute(req({ action: "snapshot" }));
  const r = req({ operationId: "op_upload", action: "upload", args: {
    handle: snapshot.data.targets[0].handle, target: "https://example.com/form", artifactId: "fixture_artifact" } }); h.external(r);
  await rejectsCode(() => h.broker.execute(r), "OPERATION_UNCERTAIN"); assert.equal(f.stats.actions.length, 0);
});
await test("Broker integration: auth session still needs explicit same-task host permission", async () => {
  const f = browserFixture(), h = brokerFixture(f.registry);
  h.grant("authenticated_browser", { actions: ["read"], sessionId: "fixture_session", domains: ["example.com"] });
  await rejectsCode(() => h.broker.execute(req({ capability: "authenticated_browser" })), "BACKEND_REJECTED");
  assert.equal(f.stats.opens.length, 0);
});
await test("Broker integration: unexpected POST cannot turn a read grant into a write grant", async () => {
  const f = browserFixture({ execute: async host => host.onRequest({ url: "https://example.com/", method: "POST", resourceType: "fetch" }) });
  const h = brokerFixture(f.registry); browserGrant(h);
  await rejectsCode(() => h.broker.execute(req()), "BACKEND_RECEIPT_INVALID"); assert.equal(h.records.at(-1).status, "failed");
});
await test("registry rejects asynchronous authorize and legacy guard-only request", async () => {
  const f = browserFixture();
  assert.equal((await f.execute(req({ authorize: async () => authority() }))).code, "AUTHORIZATION_DENIED");
  const legacy = req({ authorize: undefined, guard: authority, operationId: "op_legacy" });
  assert.equal((await f.execute(legacy)).code, "INVALID_REQUEST"); await f.registry.closeTask(owner());
});
await test("task session close is terminal and authenticated cookies never downgrade to isolated", async () => {
  const f = browserFixture({ authorizeBrowserSession: async () => true });
  await f.execute(req({ capability: "authenticated_browser", args: { setCookie: "fixture_auth_cookie" } }));
  const isolated = await f.execute(req({ operationId: "op_isolated" })); assert.equal(isolated.data.cookie, null);
  assert.equal(f.stats.opens.length, 2); await f.registry.closeTask(owner());
  assert.equal((await f.execute(req({ operationId: "op_closed" }))).code, "UNAVAILABLE");
});
await test("failed concrete context close cannot become fake stopped on second call", async () => {
  const f = contextFixture({ failClose: true }); assert.equal((await f.execute(req())).status, "succeeded");
  assert.equal((await f.registry.closeTask(owner())).status, "uncertain");
  assert.equal((await f.registry.closeTask(owner())).status, "uncertain"); assert.equal(f.stats.closed, 1);
});
await test("scope session mismatch cannot reuse task context", async () => {
  const f = browserFixture(); const r = req({ args: { sessionId: "other_fixture_session" } });
  assert.equal((await f.execute(r)).code, "SCOPE_DENIED"); assert.equal(f.stats.effects.length, 0);
  await f.registry.closeTask(owner());
});
await test("desktop rejects cross-window and stale host handles", async () => {
  for (const args of [{ app: "fixture.allowed", handle: "other_window_handle" }, { app: "fixture.allowed", windowId: "other_window" }]) {
    const { manager } = await arbiter(), f = desktopFixture(manager);
    assert.equal((await f.execute(f.request({ args }))).code, "SCOPE_DENIED"); assert.equal(f.stats.effects.length, 0);
  }
});
await test("Broker integration: fill with fresh form target succeeds after fresh target verification", async () => {
  const f = contextFixture(), h = brokerFixture(f.registry); browserGrant(h);
  const snapshot = await h.broker.execute(req({ action: "snapshot" }));
  const r = req({ action: "fill", operationId: "op_fill", args: { target: "https://example.com/form",
    handle: snapshot.data.targets[0].handle, text: "fixture input" } }); h.external(r);
  const result = await h.broker.execute(r); assert.equal(result.receipt.status, "succeeded");
  assert.deepEqual(f.stats.actions, ["fill"]); await f.registry.closeTask(owner());
});

console.log(JSON.stringify({ ok: true, tests: cases.length, fixtureOnly: true,
  brokerIntegrationTests: cases.filter(name => name.startsWith("Broker integration:")).length,
  productionVerifiedBackends: 0, positiveBrokerTestsUseSyntheticHostAttestation: true,
  realBrowserLaunches: 0, guiActions: 0, helperRuns: 0, networkCalls: 0, userDataReads: 0, cases }, null, 2));
