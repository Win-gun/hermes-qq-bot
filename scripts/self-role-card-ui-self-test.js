#!/usr/bin/env node
// Offline VM/DOM fixtures only: no browser, real transport, config or user data.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
const marked = html.split("// SOCIAL_AGENT_UI_BEGIN")[1].split("// SOCIAL_AGENT_UI_END")[0];
const block = marked.slice(marked.indexOf("\n") + 1);
const api = html.slice(html.indexOf("    async function api("), html.indexOf("    async function hostApi("));
const auth = html.slice(html.indexOf('    let adminSessionToken = "";'), html.indexOf("    async function sensitiveApi("));
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.value = ""; this.disabled = false; this._text = ""; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  get firstChild() { return this.children[0] || null; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ""; this.children = children; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  scrollIntoView() {}
  set innerHTML(_) { throw new Error("Unsafe HTML insertion"); }
}
const flatten = el => [el, ...el.children.flatMap(flatten)];
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(check) {
  for (let n = 0; n < 100; n++) { if (check()) return; await Promise.resolve(); }
  throw new Error("Synthetic wait exhausted");
}
function runtime(enabled = true) {
  const requests = [], hooks = {}, timers = new Map(), deadlines = [], confirmations = [], servers = new Map();
  const rolePolicy = () => ({ enabled, autoGrow: false, minUpdateIntervalMs: 86400000, maxVersions: 32 });
  for (const id of ["demo-a", "demo-b"]) servers.set(id, {
    policy: { enabled: false, shadowMode: true, conversationIds: [], profile: { identity: `STATIC-${id}`, expression: "STATIC-EXPRESSION" }, ...(enabled ? { roleCard: rolePolicy() } : {}) },
    socialVersion: 1, card: { revision: 0, fields: {}, versions: [] }
  });
  const pages = new Map(["account-functions", "qa", "memory", "automation"].map(id => [`page-${id}`, new Element("section")]));
  const registry = { selected: "demo-a", items: [...servers.keys()].map(id => ({ id })), contexts: { qa: "demo-a" }, epoch: 0, drafts: new Map() };
  let configRevision = "config-1", timerId = 0;
  const socialRevision = id => `social-${id}-${servers.get(id).socialVersion}`;
  const response = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const fetch = async (url, opts = {}) => {
    assert(!opts.signal?.aborted, "aborted requests must not reach transport");
    const method = opts.method || "GET", body = opts.body ? JSON.parse(opts.body) : null;
    requests.push({ url, method, body, opts });
    if (url === "/api/admin/session") { await hooks.session?.(); return response({ token: "synthetic-session" }); }
    assert.equal(opts.headers.get("x-hermes-qq-admin"), "synthetic-session");
    assert.equal(opts.cache, "no-store"); assert.equal(opts.credentials, "same-origin"); assert.equal(opts.redirect, "error");
    const match = url.match(/^\/api\/social-agent\/accounts\/([^/]+)(.*)$/);
    assert(match, `Unexpected synthetic endpoint: ${url}`);
    const server = servers.get(decodeURIComponent(match[1])); assert(server);
    if (!match[2]) {
      await hooks.policy?.(method, match[1], opts.signal);
      if (method === "PATCH") {
        if (hooks.patchStatus) return response({ error: "PRIVATE_SENTINEL" }, hooks.patchStatus);
        assert.equal(body.expectedRevision, socialRevision(match[1])); server.policy = structuredClone(body.policy); configRevision += "-saved"; server.socialVersion++;
      } else if (hooks.policyStatus) return response({ error: "PRIVATE_SENTINEL" }, hooks.policyStatus);
      return response({ ok: true, revision: socialRevision(match[1]), policy: structuredClone(server.policy), state: {} });
    }
    assert(["/role-card", "/role-card/generate"].includes(match[2]));
    assert.equal(method, match[2].endsWith("/generate") ? "POST" : "GET");
    if (method === "POST") assert.equal(opts.headers.get("content-type"), "application/json");
    const snapshotRevision = configRevision;
    await hooks.role?.(method, match[1], opts.signal);
    if (hooks.roleOffline) throw new Error("PRIVATE_SENTINEL");
    if (hooks.roleStatus) return response({ error: "PRIVATE_SENTINEL" }, hooks.roleStatus);
    if (method === "POST") {
      if (body.expectedRevision !== configRevision || body.cardRevision !== server.card.revision) return response({ error: "conflict" }, 409);
      assert.equal(body.expectedRevision, snapshotRevision);
      const fields = { expression: '<img src=x onerror="throw 1">', interests: "合成兴趣", examples: `合成示例 ${server.card.revision + 1}` };
      server.card = { revision: server.card.revision + 1, fields, versions: [...server.card.versions, { revision: server.card.revision + 1, fields: structuredClone(fields), reason: "合成采用原因", evidenceMessageIds: ["synthetic-message"], at: server.card.revision + 1 }] };
      server.socialVersion++;
    }
    return response(hooks.roleResponse || { ok: true, revision: snapshotRevision, policy: structuredClone(server.policy.roleCard || rolePolicy()), card: structuredClone(server.card) });
  };
  const context = vm.createContext({
    Headers, AbortController, structuredClone, console, fetch, registryState: registry,
    document: { createElement: tag => new Element(tag) }, $: id => pages.get(id),
    window: { addEventListener() {} }, switchPage() {},
    confirm: message => { confirmations.push(message); return hooks.confirm !== false; },
    setTimeout: (fn, ms) => { assert([20000, 65000].includes(ms)); deadlines.push(ms); timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(`${api}${auth}${block}\nglobalThis.ui = socialUi;`, context);
  const ui = context.ui; ui.mount();
  const t = { ui, hooks, registry, servers, requests, timers, deadlines, confirmations, socialRevision,
    contextResetAuth: () => vm.runInContext('adminSessionToken = "";', context),
    posts: () => requests.filter(r => r.method === "POST"),
    roleReads: () => requests.filter(r => r.url.endsWith("/role-card")),
    qa: id => { registry.contexts.qa = id; ui.sync(); },
    topic: value => { ui.views.qa.topic.value = value; ui.views.qa.topic.listeners.input(); },
    refresh: () => ui.views.qa.refreshRole.listeners.click(),
    generate: () => ui.views.qa.generateRole.listeners.click(),
    control: key => flatten(ui.views.policy.body).find(n => n.id === `social-${key}`),
    edit: (key, value) => {
      const control = t.control(key); assert(control);
      if (control.type === "checkbox") { control.checked = value; control.listeners.change(); }
      else { control.value = value; control.listeners.input(); }
    },
    timeout: () => { assert.equal(timers.size, 1); [...timers.values()][0](); }
  };
  return t;
}
async function ready() {
  const t = runtime(); await t.ui.select("policy", "demo-a"); await t.refresh();
  assert.equal(t.ui.views.qa.generateRole.disabled, false); return t;
}
const cases = [];
async function test(name, fn) { await fn(); cases.push(name); }

await test("legacy defaults, checkbox draft roundtrip and scoped whole-policy save", async () => {
  const t = runtime(false), { ui } = t;
  assert.equal(t.requests.length, 0); await ui.select("policy", "demo-a");
  assert.deepEqual(plain(ui.drafts.get("demo-a").policy.roleCard), { enabled: false, autoGrow: false, minUpdateIntervalMs: 86400000, maxVersions: 32 });
  assert.equal(t.control("roleCard.enabled").checked, false); assert.equal(t.control("roleCard.autoGrow").checked, false);
  await t.refresh(); assert.equal(t.roleReads().length, 1); assert.equal(ui.views.qa.generateRole.disabled, true);
  t.edit("roleCard.enabled", true); t.edit("roleCard.autoGrow", true);
  assert.equal(ui.views.qa.refreshRole.disabled, true); await t.generate(); assert.equal(t.posts().length, 0);
  await ui.select("policy", "demo-b"); t.edit("profile.identity", "B-UNSAVED");
  await ui.select("policy", "demo-a"); assert.equal(t.control("roleCard.enabled").checked, true); assert.equal(t.control("roleCard.autoGrow").checked, true);
  await ui.load("demo-a"); assert.equal(t.control("roleCard.autoGrow").checked, true);
  await ui.save();
  const patch = t.requests.find(r => r.method === "PATCH");
  assert.equal(patch.url, "/api/social-agent/accounts/demo-a");
  assert.deepEqual(Object.keys(patch.body).sort(), ["expectedRevision", "policy"]);
  assert.equal(patch.body.policy.roleCard.autoGrow, true); assert.equal(patch.body.policy.roleCard.maxVersions, 32);
  assert.equal(patch.body.policy.profile.identity, "STATIC-demo-a"); assert.equal(t.servers.get("demo-b").policy.roleCard, undefined);
  assert.equal(ui.drafts.get("demo-b").policy.profile.identity, "B-UNSAVED"); assert.equal(ui.drafts.get("demo-b").dirty, true);
  assert.equal(t.posts().length, 0); assert.equal(t.roleReads().length, 1);
  const tuned = runtime(); tuned.servers.get("demo-a").policy.roleCard.minUpdateIntervalMs = 172800000;
  tuned.servers.get("demo-a").policy.roleCard.maxVersions = 7;
  await tuned.ui.select("policy", "demo-a"); tuned.edit("roleCard.autoGrow", true); await tuned.ui.save();
  assert.deepEqual(tuned.servers.get("demo-a").policy.roleCard, { enabled: true, autoGrow: true, minUpdateIntervalMs: 172800000, maxVersions: 7 });
});

await test("inert mounting/polling/selection, stable topic controls and QA account authority", async () => {
  const t = runtime(), { ui } = t;
  await ui.select("policy", "demo-a"); await ui.load("demo-b");
  t.topic("A-TOPIC"); const input = ui.views.qa.topic;
  ui.sync(); await ui.enter("qa"); assert.equal(ui.views.qa.topic, input); assert.equal(input.value, "A-TOPIC");
  t.qa("demo-b"); assert.equal(input.value, ""); t.topic("B-TOPIC");
  t.qa("demo-a"); assert.equal(input.value, "A-TOPIC"); t.qa("demo-b"); assert.equal(input.value, "B-TOPIC");
  assert.equal(t.roleReads().length, 0); assert.equal(t.posts().length, 0);
  await t.refresh(); assert.equal(t.roleReads()[0].url, "/api/social-agent/accounts/demo-b/role-card");
  assert.equal(ui.views.policy.selected, "demo-a"); assert.equal(t.registry.selected, "demo-a");
  t.hooks.confirm = false; await t.generate(); assert.equal(t.posts().length, 0);
  t.hooks.confirm = true;
  const originalA = plain(ui.drafts.get("demo-a")), originalB = plain(ui.drafts.get("demo-b"));
  await t.generate();
  assert.deepEqual(t.posts()[0].body, { expectedRevision: "config-1", cardRevision: 0, topic: "B-TOPIC" });
  assert.equal(t.posts()[0].url, "/api/social-agent/accounts/demo-b/role-card/generate");
  assert.match(t.confirmations.at(-1), /立即采用.*demo-b/); assert.match(t.confirmations.at(-1), /不发 QQ 消息/);
  assert.deepEqual(plain(ui.drafts.get("demo-a")), originalA); assert.deepEqual(plain(ui.drafts.get("demo-b")), originalB);
  assert.match(ui.views.qa.rolePreview.textContent, /角色卡修订 1.*合成采用原因/);
  assert.match(ui.views.qa.rolePreview.textContent, /<img src=x/); assert.doesNotMatch(ui.views.qa.host.textContent, /PRIVATE_SENTINEL/);
  assert(!flatten(ui.views.qa.host).some(n => ["IMG", "IFRAME", "A"].includes(n.tagName)));
  assert.equal(input.value, "B-TOPIC"); assert.equal(t.posts().length, 1);
});

await test("one explicit QA refresh bootstraps an unloaded selected account with distinct revisions and GETs only", async () => {
  for (const enabled of [true, false]) {
    const t = runtime(enabled), { ui } = t; await ui.select("policy", "demo-a"); t.topic("A-TOPIC");
    const draftA = plain(ui.drafts.get("demo-a")), before = t.requests.length;
    t.qa("demo-b"); t.topic("B-TOPIC");
    assert.equal(ui.drafts.has("demo-b"), false); assert.equal(t.requests.length, before, "selection alone is inert");
    assert.equal(ui.views.qa.refreshRole.disabled, false); assert.equal(ui.views.qa.generateRole.disabled, true);
    assert.match(ui.views.qa.refreshRole.textContent, /加载策略并刷新角色卡/);
    assert.match(ui.views.qa.roleStatus.textContent, /点击/);
    await t.refresh();
    assert.deepEqual(t.requests.slice(before).map(r => [r.method, r.url]), [
      ["GET", "/api/social-agent/accounts/demo-b"], ["GET", "/api/social-agent/accounts/demo-b/role-card"]
    ]);
    assert.equal(ui.drafts.get("demo-b").revision, "social-demo-b-1");
    assert.match(ui.views.qa.roleStatus.textContent, /账号 demo-b · 配置修订 config-1/);
    assert.match(ui.views.qa.rolePreview.textContent, /角色卡修订 0/);
    assert.equal(ui.views.qa.generateRole.disabled, !enabled);
    assert.equal(ui.views.qa.topic.value, "B-TOPIC"); assert.equal(t.registry.contexts.qa, "demo-b");
    assert.equal(ui.views.policy.selected, "demo-a"); assert.deepEqual(plain(ui.drafts.get("demo-a")), draftA);
    t.qa("demo-a"); assert.equal(ui.views.qa.topic.value, "A-TOPIC");
    assert.equal(t.posts().length, 0); assert.equal(t.confirmations.length, 0);
  }
});

await test("policy bootstrap is single-flight and fences selection, epoch and unsaved drafts", async () => {
  for (const mode of ["switch-back", "registry-epoch", "dirty", "conflict"]) {
    const t = runtime(), gate = deferred(); t.qa("demo-b"); t.topic("B-KEEP");
    t.hooks.policy = () => gate.promise;
    const pending = t.refresh(); await until(() => t.requests.some(r => r.url.endsWith("/demo-b")));
    await t.refresh(); assert.equal(t.requests.filter(r => r.url.endsWith("/demo-b")).length, 1);
    assert.equal(t.ui.views.qa.refreshRole.disabled, true); assert.equal(t.ui.views.qa.generateRole.disabled, true);
    if (mode === "switch-back") { t.qa("demo-a"); t.topic("A-KEEP"); t.qa("demo-b"); }
    if (mode === "registry-epoch") t.registry.epoch++;
    if (mode === "dirty") t.ui.edit("demo-b", "profile.identity", "LOCAL-UNSAVED");
    if (mode === "conflict") t.registry.drafts.set("demo-b", { dirty: new Set(), conflict: true });
    gate.resolve(); await pending;
    assert.equal(t.roleReads().length, 0); assert.equal(t.posts().length, 0);
    assert.equal(t.ui.views.qa.topic.value, "B-KEEP");
    if (mode === "dirty") {
      assert.equal(t.ui.drafts.get("demo-b").policy.profile.identity, "LOCAL-UNSAVED");
      assert.equal(t.ui.drafts.get("demo-b").dirty, true);
    }
    assert.equal(t.ui.views.qa.generateRole.disabled, true);
    if (["dirty", "conflict"].includes(mode)) assert.equal(t.ui.views.qa.refreshRole.disabled, true);
    else {
      assert.equal(t.ui.drafts.get("demo-b").revision, null, "invalidated load cannot publish policy");
      assert.equal(t.ui.views.qa.refreshRole.disabled, false);
      delete t.hooks.policy; await t.refresh(); assert.equal(t.roleReads().length, 1);
    }
  }
});

await test("failed initial policy GET has explicit retry in QA without issuing a role GET or POST", async () => {
  const t = runtime(); t.qa("demo-b"); t.topic("RETRY-TOPIC"); t.hooks.policyStatus = 503;
  await t.refresh(); assert.equal(t.roleReads().length, 0); assert.equal(t.posts().length, 0);
  assert.equal(t.ui.drafts.get("demo-b").revision, null); assert.equal(t.ui.views.qa.refreshRole.disabled, false);
  assert.equal(t.ui.views.qa.generateRole.disabled, true); assert.match(t.ui.views.qa.roleStatus.textContent, /失败/);
  delete t.hooks.policyStatus; await t.refresh();
  assert.equal(t.roleReads().length, 1); assert.equal(t.posts().length, 0); assert.equal(t.ui.views.qa.topic.value, "RETRY-TOPIC");
  assert.match(t.ui.views.qa.roleStatus.textContent, /账号 demo-b · 配置修订 config-1/);
});

await test("policy bootstrap deadline aborts and late response cannot overwrite a successful explicit retry", async () => {
  const t = runtime(), gate = deferred(); t.qa("demo-b"); t.topic("TIMEOUT-BOOTSTRAP");
  t.hooks.policy = () => gate.promise;
  const pending = t.refresh(); await until(() => t.requests.some(r => r.url.endsWith("/demo-b")));
  const initial = t.requests.find(r => r.url.endsWith("/demo-b"));
  assert.equal(t.deadlines.at(-1), 20000); t.timeout(); await pending;
  assert.equal(initial.opts.signal.aborted, true); assert.equal(t.ui.drafts.get("demo-b").loading, null);
  assert.equal(t.ui.views.qa.refreshRole.disabled, false); assert.equal(t.roleReads().length, 0);
  delete t.hooks.policy; await t.refresh();
  const successful = plain(t.ui.drafts.get("demo-b"));
  assert.equal(t.ui.views.qa.generateRole.disabled, false); assert.equal(t.roleReads().length, 1);
  gate.resolve(); for (let n = 0; n < 30; n++) await Promise.resolve();
  assert.deepEqual(plain(t.ui.drafts.get("demo-b")), successful);
  assert.equal(t.roleReads().length, 1); assert.equal(t.posts().length, 0);
  assert.equal(t.ui.views.qa.topic.value, "TIMEOUT-BOOTSTRAP");
});

await test("distinct config/social revisions support full-history adoption and policy reload lifecycle", async () => {
  const t = await ready(), { ui } = t;
  assert.equal(ui.drafts.get("demo-a").revision, "social-demo-a-1");
  assert.match(ui.views.qa.roleStatus.textContent, /配置修订 config-1/);
  const before = plain(ui.drafts.get("demo-a")); t.topic("REVISION-TEST"); await t.generate();
  assert.deepEqual(t.posts()[0].body, { expectedRevision: "config-1", cardRevision: 0, topic: "REVISION-TEST" });
  assert.deepEqual(plain(ui.drafts.get("demo-a")), before, "adoption does not rewrite social policy or local social revision");
  assert.equal(t.socialRevision("demo-a"), "social-demo-a-2");
  assert.equal(ui.views.qa.generateRole.disabled, false);
  await ui.load("demo-a"); assert.equal(ui.drafts.get("demo-a").revision, "social-demo-a-2");
  assert.equal(ui.views.qa.generateRole.disabled, true, "new social hash requires explicit snapshot binding");
  assert.match(ui.views.qa.rolePreview.textContent, /旧快照/);
  const refreshedPolicy = plain(ui.drafts.get("demo-a")); await t.refresh();
  assert.deepEqual(plain(ui.drafts.get("demo-a")), refreshedPolicy);
  assert.equal(ui.views.qa.generateRole.disabled, false);
  await t.generate(); assert.equal(t.posts()[1].body.expectedRevision, "config-1"); assert.equal(t.posts()[1].body.cardRevision, 1);
  assert.match(ui.views.qa.rolePreview.textContent, /角色卡修订 2/);
  assert.equal(t.servers.get("demo-a").card.versions.length, 2);
  assert.equal(t.servers.get("demo-a").card.versions[0].fields.examples, "合成示例 1");
  assert.equal(t.servers.get("demo-a").card.versions[1].fields.examples, "合成示例 2");
  assert.equal(ui.views.qa.topic.value, "REVISION-TEST");
});

await test("disabled policy still reads retained history without changing drafts or granting generation", async () => {
  const t = await ready(), { ui } = t; await t.generate(); await ui.load("demo-a");
  t.edit("roleCard.enabled", false); await ui.save(); t.topic("HISTORY-TOPIC");
  const saved = plain(ui.drafts.get("demo-a")), calls = t.posts().length;
  assert.equal(ui.views.qa.refreshRole.disabled, false); assert.equal(ui.views.qa.generateRole.disabled, true);
  await t.refresh();
  assert.match(ui.views.qa.rolePreview.textContent, /角色卡修订 1.*合成采用原因/);
  assert.match(ui.views.qa.roleStatus.textContent, /配置修订 config-1-saved.*仅查看历史/);
  assert.deepEqual(plain(ui.drafts.get("demo-a")), saved); assert.equal(ui.views.qa.topic.value, "HISTORY-TOPIC");
  await t.generate(); assert.equal(t.posts().length, calls);
  // An endpoint reporting disabled policy must also override stale local enablement.
  const stale = await ready(); stale.servers.get("demo-a").policy.roleCard.enabled = false;
  await stale.refresh(); assert.equal(stale.ui.drafts.get("demo-a").savedRoleCard.enabled, true);
  assert.equal(stale.ui.views.qa.generateRole.disabled, true); await stale.generate(); assert.equal(stale.posts().length, 0);
});

await test("GET requires nonempty config revision and POST cannot adopt a different config revision", async () => {
  for (const revision of ["", "  ", null]) {
    const t = await ready(); t.hooks.roleResponse = { ok: true, revision, policy: { enabled: true }, card: t.servers.get("demo-a").card };
    await t.refresh(); assert.equal(t.ui.views.qa.generateRole.disabled, true); await t.generate(); assert.equal(t.posts().length, 0);
  }
  const t = await ready(); t.hooks.roleResponse = { ok: true, revision: "other-config", card: { revision: 1, fields: {}, versions: [] } };
  await t.generate(); assert.equal(t.ui.views.qa.generateRole.disabled, true);
  assert.match(t.ui.views.qa.rolePreview.textContent, /角色卡修订 0/);
  await t.generate(); assert.equal(t.posts().length, 1);
});

await test("dirty, conflict and pending policy block both controls and handlers", async () => {
  for (const mode of ["dirty", "conflict", "busy", "loading", "error", "registry-dirty", "registry-conflict"]) {
    const t = await ready(), d = t.ui.drafts.get("demo-a"), before = t.requests.length;
    if (mode.startsWith("registry")) t.registry.drafts.set("demo-a", { dirty: new Set(mode.endsWith("dirty") ? ["style.systemPrompt"] : []), conflict: mode.endsWith("conflict") });
    else d[mode] = true;
    t.ui.sync(); assert.equal(t.ui.views.qa.refreshRole.disabled, true); assert.equal(t.ui.views.qa.generateRole.disabled, true);
    await t.refresh(); await t.generate(); assert.equal(t.requests.length, before, mode);
  }
  const t = await ready(); t.topic("x".repeat(1001)); await t.generate(); assert.equal(t.posts().length, 0);
  assert.match(t.ui.views.qa.roleStatus.textContent, /最多 1000/); assert.equal(t.ui.views.qa.topic.value.length, 1001);
});

await test("account switch race cannot project A adoption into B or discard either topic", async () => {
  const t = await ready(); await t.ui.load("demo-b"); t.topic("A-KEEP");
  const gate = deferred(); t.hooks.role = () => gate.promise;
  const pending = t.generate(); await until(() => t.posts().length === 1);
  await t.generate(); assert.equal(t.posts().length, 1, "double submission guarded");
  t.qa("demo-b"); t.topic("B-KEEP"); t.ui.edit("demo-b", "profile.identity", "B-DRAFT");
  const draftB = plain(t.ui.drafts.get("demo-b"));
  gate.resolve(); await pending;
  assert.equal(t.ui.views.qa.topic.value, "B-KEEP"); assert.deepEqual(plain(t.ui.drafts.get("demo-b")), draftB);
  assert.doesNotMatch(t.ui.views.qa.rolePreview.textContent, /合成兴趣/);
  t.qa("demo-a"); assert.equal(t.ui.views.qa.topic.value, "A-KEEP");
  assert.match(t.ui.views.qa.rolePreview.textContent, /角色卡修订 0/); assert.equal(t.ui.views.qa.generateRole.disabled, true);
  delete t.hooks.role; await t.refresh(); assert.match(t.ui.views.qa.rolePreview.textContent, /角色卡修订 1/);
});

await test("403/409/offline/500/malformed failures stay blocked across policy reads, no replay", async () => {
  for (const failure of [403, 409, 500, "offline", "malformed"]) {
    const t = await ready(); t.topic("KEEP-ON-FAILURE");
    if (typeof failure === "number") t.hooks.roleStatus = failure;
    if (failure === "offline") t.hooks.roleOffline = true;
    if (failure === "malformed") t.hooks.roleResponse = { ok: true, revision: "config-1" };
    await t.generate(); assert.equal(t.posts().length, 1);
    assert.equal(t.ui.views.qa.topic.value, "KEEP-ON-FAILURE"); assert.equal(t.ui.views.qa.generateRole.disabled, true);
    assert.match(t.ui.views.qa.roleStatus.textContent, /主题保留/); assert.doesNotMatch(t.ui.views.qa.host.textContent, /PRIVATE_SENTINEL/);
    delete t.hooks.roleStatus; delete t.hooks.roleOffline; delete t.hooks.roleResponse;
    await t.ui.load("demo-a"); t.ui.sync(); await t.generate();
    assert.equal(t.posts().length, 1); assert.equal(t.ui.views.qa.generateRole.disabled, true, "policy refresh cannot clear uncertain adoption");
    await t.refresh(); assert.equal(t.ui.views.qa.generateRole.disabled, false);
  }
});

await test("timeout bounds auth bootstrap; no late POST even after auth eventually succeeds", async () => {
  const t = await ready(); t.topic("KEEP-TIMEOUT");
  t.contextResetAuth();
  // Refresh is also timeout bounded, including its session bootstrap.
  const gate = deferred(); t.hooks.session = () => gate.promise;
  const before = t.requests.length, pending = t.refresh();
  await until(() => t.requests.length > before); assert.equal(t.deadlines.at(-1), 20000); t.timeout(); await pending;
  assert.match(t.ui.views.qa.roleStatus.textContent, /超时/); assert.equal(t.ui.views.qa.topic.value, "KEEP-TIMEOUT");
  const calls = t.requests.length; gate.resolve(); await until(() => t.timers.size === 0);
  for (let n = 0; n < 20; n++) await Promise.resolve();
  assert.equal(t.requests.length, calls, "expired auth cannot issue even a late GET");
  assert.equal(t.ui.views.qa.generateRole.disabled, true);
  delete t.hooks.session; await t.refresh();
  // Explicitly exercise POST bootstrap as well, without another mutation.
  t.contextResetAuth();
  const gate2 = deferred(); t.hooks.session = () => gate2.promise;
  const count = t.posts().length, generation = t.generate(); await until(() => t.timers.size === 1);
  assert.equal(t.deadlines.at(-1), 65000); t.timeout(); await generation; gate2.resolve();
  for (let n = 0; n < 20; n++) await Promise.resolve();
  assert.equal(t.posts().length, count); assert.equal(t.ui.views.qa.generateRole.disabled, true);
});

await test("timed-out wire response never revives snapshot or unlocks further writes", async () => {
  const t = await ready(), gate = deferred(); t.topic("UNCERTAIN"); t.hooks.role = () => gate.promise;
  const pending = t.generate(); await until(() => t.posts().length === 1);
  assert.equal(t.deadlines.at(-1), 65000); assert.equal(t.posts()[0].opts.signal.aborted, false);
  t.timeout(); await pending; assert.equal(t.posts()[0].opts.signal.aborted, true);
  assert.equal(t.ui.views.qa.generateRole.disabled, true); gate.resolve();
  for (let n = 0; n < 30; n++) await Promise.resolve();
  assert.match(t.ui.views.qa.rolePreview.textContent, /角色卡修订 0/); assert.equal(t.ui.views.qa.generateRole.disabled, true);
  assert.equal(t.ui.views.qa.topic.value, "UNCERTAIN"); await t.generate(); assert.equal(t.posts().length, 1);
});

await test("policy failure and registry epoch invalidate earlier successful role responses", async () => {
  for (const mode of ["policy-failure", "social-revision", "registry-epoch", "policy-save", "switch-back"]) {
    const t = await ready(), gate = deferred(); t.hooks.role = () => gate.promise;
    const pending = t.generate(); await until(() => t.posts().length === 1);
    if (mode === "policy-failure") { t.hooks.policyStatus = 500; await t.ui.load("demo-a"); }
    if (mode === "social-revision") { t.servers.get("demo-a").socialVersion++; await t.ui.load("demo-a"); }
    if (mode === "registry-epoch") t.registry.epoch++;
    if (mode === "policy-save") { t.ui.edit("demo-a", "roleCard.autoGrow", true); await t.ui.save(); }
    if (mode === "switch-back") { t.qa("demo-b"); t.qa("demo-a"); }
    gate.resolve(); await pending;
    assert.match(t.ui.views.qa.rolePreview.textContent, /角色卡修订 0/); assert.equal(t.ui.views.qa.generateRole.disabled, true, mode);
    await t.generate(); assert.equal(t.posts().length, 1, mode);
  }
});

console.log(`PASS self-role-card UI: embedded syntax and ${cases.length} offline cases (${cases.join("; ")})`);
