#!/usr/bin/env node
// Offline contract tests: real admin functions, synthetic DOM/transport only.
// --preview renders the same editor with an in-memory account API on loopback.
import assert from "node:assert/strict";
import { validateSocialExperiencePolicy } from "../src/social-experience-policy.js";
import fs from "node:fs";
import vm from "node:vm";
import http from "node:http";

const html = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes("function registryEditable("));
function source(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, "m").exec(script);
  assert.ok(start, `missing real function ${name}`);
  const rest = script.slice(start.index), end = /^    \}/m.exec(rest);
  assert.ok(end, `missing closing brace ${name}`);
  return rest.slice(0, end.index + end[0].length);
}
const constants = ["registryTabs", "registryFeatures", "registrySendTypes", "registryIdentityKeys", "registryPolicyKeys"]
  .map(name => script.match(new RegExp(`^    const ${name} = .+;$`, "m"))[0]).join("\n");
const functions = ["api", "ensureAdminSession", "switchPage", "currentScope", "registryItem", "registryGroup", "registryEffective", "registryStyle", "registryEditable", "registryDraft", "registryGet", "registrySet", "registryButton", "registryRequest", "rebaseRegistryDraft", "refreshAccountRegistry", "registryField", "registryFields", "refreshExperienceStatus", "renderExperienceDiagnostic", "registryExperienceDiagnostic", "registryValidate", "registryTabKeys", "registryPatch", "confirmRegistrySave", "saveRegistryPatch", "saveRegistryEditor", "registrySelect", "syncRegistryDraftControls", "renderRegistryEditor", "registryDraftStatus"]
  .concat(["experienceLibraryScopes", "experienceLibraryState", "experienceLibraryText", "experienceLibraryProjection", "loadExperienceLibrary", "selectExperienceLibrary", "mutateExperienceLibrary", "renderExperienceLibrary"])
  .map(source).join("\n");
const realSource = `${constants}\nlet adminSessionToken = "", adminSessionRequest = null;\n${functions}`;
// Syntax-check every inline script too, without running page initialization.
for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);

class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {}; this.listeners = {};
    this.attributes = {}; this.classes = new Set(); this.type = ""; this._value = ""; this._text = "";
    this.disabled = false; this.checked = false; this.open = false;
    this.classList = { add: key => this.classes.add(key), remove: key => this.classes.delete(key), toggle: (key, value) => value ? this.classes.add(key) : this.classes.delete(key) };
  }
  set value(value) { this._value = String(value); }
  get value() { return this._value; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this._text = ""; this.append(...items); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  contains(node) { return this === node || this.children.some(c => c.contains(node)); }
  querySelectorAll(selector) {
    const nodes = this.children.flatMap(c => [c, ...c.querySelectorAll("*")]);
    if (selector === "*") return nodes;
    if (selector === "[data-registry-field]") return nodes.filter(c => c.dataset.registryField);
    if (selector === "[data-registry-participation-state]") return nodes.filter(c => "registryParticipationState" in c.dataset);
    if (selector === "[data-registry-participation]") return nodes.filter(c => "registryParticipation" in c.dataset);
    if (selector === "[data-experience-diagnostic]") return nodes.filter(c => "experienceDiagnostic" in c.dataset);
    if (selector === "[data-experience-library]") return nodes.filter(c => "experienceLibrary" in c.dataset);
    return [];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  set innerHTML(_) { throw new Error("unsafe dynamic HTML"); }
}
function mockDocument() {
  const editor = new Element("div"); editor.id = "dynamicAccountEditor";
  const nodes = new Map([editor.id, "pageTitle", "pageSubtitle", "saveBtn", "page-qa", "page-account-functions"].map(id => [id, id === editor.id ? editor : new Element()]));
  return { activeElement: null, createElement: tag => new Element(tag), getElementById: id => nodes.get(id) || null,
    querySelectorAll: selector => selector === ".page" ? [nodes.get("page-qa"), nodes.get("page-account-functions")] : [] };
}

// Serializable for browser preview. No production URL, filesystem or tools.
function fixture(document, state = {}) {
  const requests = [], feedback = [], server = { revision: "r1", items: [
    { id: "demo-a", displayName: "演示账号 A", enabled: true, style: { systemPrompt: "saved A" }, features: { chat: true } },
    { id: "demo-b", displayName: "演示账号 B", enabled: true, style: { systemPrompt: "saved B" }, features: { chat: true } }
  ], failoverGroups: [], statuses: [] };
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const hooks = { diagnostic: { ok: true, turns: 0, plans: 0, recent: [] } }, libraries = new Map();
  const confirmAction = typeof state.confirm === "function" ? state.confirm.bind(state) : () => true;
  const library = (id, scope) => {
    const key = JSON.stringify([id, scope]);
    if (!libraries.has(key)) libraries.set(key, { ok: true, revision: "s1", capabilities: { collection: "unknown" }, dailyVisionCalls: { reserved: 0, attempted: 2, limit: 8 }, stickers: [
      { id: "sticker-a", official: { desc: "演示表情 · 未标注", url: "https://tracking.invalid/image.png", trust: "untrusted" }, annotation: null },
      { id: "sticker-b", official: { desc: "演示表情 · 候选", trust: "untrusted" }, annotation: { revision: 1, status: "candidate", note: "合成笑脸", tags: ["合成"], sentCount: 0 } }
    ], language: { ok: true, revision: 1, stats: { messageCount: 3, averageTextLength: 12, averageIntervalMs: 700, imageRatio: 0.2, emojiRatio: 0.3 }, candidates: [
      { id: "slang:demo:1", revision: 1, status: "pending", term: "合成词", meaning: "演示词义", evidence: [{ quote: "RAW_MESSAGE_SENTINEL", userId: "123456" }] }
    ] } });
    return libraries.get(key);
  };
  Object.assign(state, {
    cfg: { revision: "r1" }, dirtyScopes: new Set(), conflictedScopes: new Set(), activePage: "account-functions", activeTabs: { qa: "persona" },
    pageMeta: {}, scopeNames: { "account-functions": "账号功能", "qa:persona": "风格" },
    registryState: { loaded: true, selected: "demo-a", tab: "experience", revision: "r1", epoch: 0, items: structuredClone(server.items), groups: [], statuses: [], drafts: new Map(), contexts: {}, operations: new Map(), error: "", refreshing: null, modelLoadedAt: Date.now(), busy: false },
    $: id => document.getElementById(id),
    renderRegistryLists() {}, renderRegistryContexts() {}, renderRegistrySaveState() {}, renderSaveState() {}, renderApiAccountModels() {}, renderAutomationTargetPicker() {}, fillConfig() {},
    registryFeedback: message => feedback.push(message), confirm: confirmAction,
    sensitiveApi: async () => ({ center: {} }),
    fetch: async (url, opts = {}) => {
      const method = opts.method || "GET";
      requests.push({ url, method, body: opts.body ? JSON.parse(opts.body) : null, token: opts.headers?.get("x-hermes-qq-admin") });
      if (url === "/api/admin/session") return response({ token: "synthetic-session" });
      if (url.includes("/expression-library")) {
        assertRoute(opts.headers.get("x-hermes-qq-admin") === "synthetic-session");
        const parsed = new URL(url, "https://synthetic.invalid"), parts = parsed.pathname.split("/"), id = decodeURIComponent(parts[4]);
        const body = opts.body ? JSON.parse(opts.body) : null, scope = body?.conversationId || parsed.searchParams.get("conversation_id");
        const data = library(id, scope);
        if (method === "GET") {
          const snapshot = structuredClone(data); await hooks.beforeLibraryRead?.(id, scope);
          return response(hooks.libraryResponse || snapshot, hooks.libraryStatus || 200);
        }
        assertRoute(method === "POST"); await hooks.beforeLibraryPost?.();
        if (hooks.libraryPostStatus) return response({ error: "PRIVATE_ERROR_SENTINEL" }, hooks.libraryPostStatus);
        if (body.expectedStateRevision !== data.revision) return response({ error: "conflict" }, 409);
        const action = parts.at(-1);
        if (action === "sync") data.capabilities.collection = "supported";
        else if (action === "annotate") {
          const item = data.stickers.find(i => i.id === body.id);
          data.dailyVisionCalls.attempted++;
          item.annotation = { revision: (item.annotation?.revision || 0) + 1, status: "candidate", note: "合成单项标注", tags: ["合成"], sentCount: 0 };
        } else {
          assertRoute(["review-sticker", "review-language"].includes(action));
          const item = action === "review-language" ? data.language.candidates.find(i => i.id === body.id) : data.stickers.find(i => i.id === body.id)?.annotation;
          if (body.expectedRevision !== item?.revision) return response({ error: "conflict" }, 409);
          item.status = body.status; item.revision++;
        }
        data.revision = `s${Number(data.revision.slice(1)) + 1}`;
        hooks.afterLibraryPost?.(data);
        return response({ ok: true });
      }
      if (url === "/api/social-agent/expression-status") {
        assertRoute(method === "GET" && opts.headers.get("x-hermes-qq-admin") === "synthetic-session");
        await hooks.beforeDiagnostic?.();
        return response(hooks.diagnostic, hooks.diagnosticStatus || 200);
      }
      if (url.startsWith("/api/config?")) return response({ revision: server.revision });
      if (url.startsWith("/api/accounts?")) {
        const snapshot = structuredClone(server);
        await hooks.beforeRead?.();
        if (hooks.readError) throw new Error("synthetic readback unavailable");
        return response({ ok: true, ...snapshot });
      }
      assertRoute(url.startsWith("/api/accounts/") && method === "PATCH");
      assertRoute(opts.headers.get("x-hermes-qq-admin") === "synthetic-session");
      const body = JSON.parse(opts.body);
      await hooks.beforePatch?.();
      if (hooks.patchStatus) return response({ error: "synthetic rejection" }, hooks.patchStatus);
      if (body.expectedRevision !== server.revision) return response({ error: "synthetic conflict" }, 409);
      const item = server.items.find(i => i.id === decodeURIComponent(url.split("/").at(-1)));
      Object.assign(item, structuredClone(body.patch)); server.revision = `r${Number(server.revision.slice(1)) + 1}`;
      hooks.afterPatch?.(item);
      return response({ ok: true, revision: server.revision });
    }
  });
  function assertRoute(ok) { if (!ok) throw new Error("Unexpected synthetic route or missing session"); }
  return { state, server, requests, feedback, hooks, document, libraries, library };
}
async function runtime() {
  const document = mockDocument();
  const t = fixture(document, { document, Headers, Response, URL, structuredClone, Date });
  vm.runInContext(realSource, vm.createContext(t.state));
  t.edit = (path, value) => {
    const control = document.getElementById("dynamicAccountEditor").querySelectorAll("[data-registry-field]").find(c => c.dataset.registryField === `socialExperience.${path}`);
    assert.ok(control, `control ${path}`); assert.equal(control.disabled, false);
    if (control.type === "checkbox") control.checked = value; else control.value = value;
    for (const listener of control.listeners[control.type === "checkbox" || control.tagName === "SELECT" ? "change" : "input"]) listener();
    return control;
  };
  t.state.registrySelect("demo-a", "experience");
  await t.state.registryState.experienceStatus.loading;
  return t;
}
const plain = value => JSON.parse(JSON.stringify(value));
const expected = validateSocialExperiencePolicy({});
const cases = [];
async function test(name, fn) { await fn(); cases.push(name); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await Promise.resolve(); } throw new Error("synthetic boundary not reached"); }
function libraryScope(t, id = "demo-a", scopes = ["group:123456", "private:654321"]) {
  const s = t.state, d = s.registryDraft(id);
  d.value.socialExperience.conversationIds = [...scopes];
  d.base = structuredClone(d.value);
  s.registryItem(id).socialExperience = structuredClone(d.value.socialExperience);
  t.server.items.find(item => item.id === id).socialExperience = structuredClone(d.value.socialExperience);
  s.renderRegistryEditor(true);
  return d;
}
function libraryHost(t) { return t.document.getElementById("dynamicAccountEditor").querySelector("[data-experience-library]"); }
const libraryPosts = t => t.requests.filter(row => row.method === "POST" && row.url.includes("/expression-library/"));

await test("draft-only defaults, controls and no implicit activation", async () => {
  const t = await runtime(), s = t.state, d = s.registryDraft();
  assert.deepEqual(plain(d.value.socialExperience), expected);
  assert.equal(Object.hasOwn(s.registryItem(), "socialExperience"), false);
  assert.equal(Object.hasOwn(t.server.items[0], "socialExperience"), false);
  assert.equal(d.dirty.size, 0); assert(t.requests.every(r => r.method === "GET"));
  const host = t.document.getElementById("dynamicAccountEditor");
  const nodes = host.querySelectorAll("*");
  assert(nodes.some(n => n.tagName === "DETAILS" && !n.open));
  const mode = nodes.find(n => n.dataset.registryField === "socialExperience.shadowMode");
  assert.equal(mode.value, "true"); assert.equal(mode.children.length, 2);
  assert.match(host.textContent, /全局累计/);
  t.edit("shadowMode", "false"); t.edit("expression.maxMessages", 3);
  assert.equal(d.value.socialExperience.enabled, false); assert.equal(d.value.socialExperience.shadowMode, false);
  assert.equal(d.value.socialExperience.expression.maxMessages, 3);
  assert(t.requests.every(r => r.method === "GET"));
  // Polling preserves both focus and select's boolean value, including false.
  t.document.activeElement = mode; s.renderRegistryEditor();
  assert(host.contains(mode));
  t.document.activeElement = null; s.syncRegistryDraftControls(host, d.value);
  assert.equal(mode.value, "false");
});
await test("group learning and reactions save independently per account without production effects", async () => {
  const t = await runtime(), s = t.state;
  t.edit("conversationIds", "group:123456");
  for (const key of ["stickers.groupLearning", "stickers.autonomousEligibility", "reactions.enabled"]) t.edit(key, true);
  t.edit("stickers.maxDailyDownloads", 12); t.edit("reactions.maxDaily", 9);
  const draft = s.registryDraft(), patch = s.registryPatch(draft, ["socialExperience"]);
  assert.equal(patch.socialExperience.enabled, false, "editing does not enable root");
  assert.equal(patch.socialExperience.stickers.autoSend, false, "learning does not grant sending");
  assert.equal(patch.socialExperience.stickers.groupLearning, true);
  assert.equal(patch.socialExperience.stickers.autonomousEligibility, true);
  assert.equal(patch.socialExperience.stickers.maxDailyDownloads, 12);
  assert.equal(patch.socialExperience.reactions.enabled, true);
  assert.equal(patch.socialExperience.reactions.maxDaily, 9);
  s.registrySelect("demo-b", "experience");
  assert.equal(s.registryDraft().value.socialExperience.stickers.groupLearning, false);
  assert.equal(s.registryDraft().value.socialExperience.reactions.enabled, false);
  s.registrySelect("demo-a", "experience");
  assert.equal(s.registryDraft().value.socialExperience.reactions.maxDaily, 9);
  assert(t.requests.every(row => row.method === "GET"));
  for (const [key, value] of [["maxDailyDownloads", 101], ["maxDailyDownloads", -1]]) {
    const bad = structuredClone(patch); bad.socialExperience.stickers[key] = value;
    assert.throws(() => s.registryValidate(bad, ["socialExperience"]));
  }
});
await test("save only the account root; preserve other tabs/accounts across navigation", async () => {
  const t = await runtime(), s = t.state, d = s.registryDraft();
  t.edit("conversationIds", "group:123456\nprivate:654321,group:123456"); t.edit("enabled", true);
  d.value.style.systemPrompt = "unsaved style"; d.dirty.add("style.systemPrompt");
  s.switchPage("qa"); assert.equal(s.activePage, "qa");
  s.switchPage("account-functions"); s.registrySelect("demo-b", "experience"); t.edit("turn.maxWaitMs", 5000);
  const b = s.registryDraft(); s.registrySelect("demo-a", "identity"); s.registrySelect("demo-a", "experience");
  assert.equal(s.registryDraft(), d); assert.equal(b.value.socialExperience.turn.maxWaitMs, 5000);
  await s.saveRegistryEditor();
  const writes = t.requests.filter(r => r.method === "PATCH");
  assert.equal(writes.length, 1); assert.equal(writes[0].url, "/api/accounts/demo-a");
  assert.equal(writes[0].token, "synthetic-session"); assert.equal(writes[0].body.expectedRevision, "r1");
  assert.deepEqual(Object.keys(writes[0].body.patch), ["socialExperience"]);
  assert.deepEqual(writes[0].body.patch.socialExperience.conversationIds, ["group:123456", "private:654321"]);
  assert.deepEqual([...d.dirty], ["style.systemPrompt"]); assert(b.dirty.has("socialExperience.turn.maxWaitMs"));
  assert.equal(t.server.items[0].style.systemPrompt, "saved A"); assert.equal(Object.hasOwn(t.server.items[1], "socialExperience"), false);
  assert(t.requests.some(r => r.url.startsWith("/api/accounts?"))); assert.equal(s.registryState.revision, "r2");
  assert.equal(d.value.socialExperience.shadowMode, true);
});
await test("saving another tab never persists experience defaults", async () => {
  const t = await runtime(), s = t.state, d = s.registryDraft();
  d.value.displayName = "renamed"; d.dirty.add("displayName");
  await s.saveRegistryPatch("demo-a", s.registryTabKeys("identity"), "基本");
  assert.equal(Object.hasOwn(t.requests.find(r => r.method === "PATCH").body.patch, "socialExperience"), false);
  assert.equal(Object.hasOwn(t.server.items[0], "socialExperience"), false);
});
await test("409 retains draft and session failure never replays", async () => {
  for (const status of [409, 403, 500]) {
    const t = await runtime(), s = t.state, d = s.registryDraft(); t.edit("turn.incompleteWaitMs", 2800);
    t.hooks.patchStatus = status;
    await assert.rejects(s.saveRegistryPatch("demo-a", s.registryTabKeys("experience"), "社交表达"));
    assert(d.dirty.has("socialExperience.turn.incompleteWaitMs")); assert.equal(d.value.socialExperience.turn.incompleteWaitMs, 2800);
    assert.equal(t.requests.filter(r => r.method === "PATCH").length, 1);
    assert.equal(d.saveState.status, "failed"); if (status === 409) assert.equal(d.conflict, true);
    assert.equal(Object.hasOwn(t.server.items[0], "socialExperience"), false);
    if (status === 403) { await s.api("/api/accounts?retry-read"); assert.equal(t.requests.filter(r => r.url === "/api/admin/session").length, 2); }
  }
});
await test("fresh readback mismatch/failure retains submitted dirty root", async () => {
  for (const mode of ["mismatch", "read-error"]) {
    const t = await runtime(), s = t.state, d = s.registryDraft(); t.edit("turn.incompleteWaitMs", 2800);
    t.hooks.afterPatch = item => { if (mode === "mismatch") item.socialExperience.turn.incompleteWaitMs = 999; else t.hooks.readError = true; };
    await assert.rejects(s.saveRegistryPatch("demo-a", ["socialExperience"], "社交表达"));
    assert.equal(d.saveState.status, "unverified"); assert(d.dirty.has("socialExperience.turn.incompleteWaitMs"));
    assert.equal(d.value.socialExperience.turn.incompleteWaitMs, 2800); assert.match(t.feedback.at(-1), /未通过保存核对/);
  }
});
await test("real stale CAS refresh preserves local value without resubmission", async () => {
  const t = await runtime(), s = t.state, d = s.registryDraft(); t.edit("turn.incompleteWaitMs", 2800);
  t.hooks.beforePatch = () => {
    t.server.revision = "r2";
    t.server.items[0].socialExperience = structuredClone(expected);
    t.server.items[0].socialExperience.turn.incompleteWaitMs = 3000;
  };
  await assert.rejects(s.saveRegistryPatch("demo-a", ["socialExperience"], "社交表达"));
  assert.equal(d.conflict, true); assert.equal(s.registryState.revision, "r2");
  assert.equal(d.value.socialExperience.turn.incompleteWaitMs, 2800);
  assert.equal(d.base.socialExperience.turn.incompleteWaitMs, 3000);
  assert.equal(t.requests.filter(r => r.method === "PATCH").length, 1);
});
await test("new input during save remains dirty after acknowledgement", async () => {
  const t = await runtime(), s = t.state, d = s.registryDraft(), gate = deferred();
  t.edit("turn.incompleteWaitMs", 2800); t.hooks.beforePatch = () => gate.promise;
  const saving = s.saveRegistryPatch("demo-a", ["socialExperience"], "社交表达");
  await until(() => t.requests.some(r => r.method === "PATCH"));
  t.edit("turn.incompleteWaitMs", 3100); gate.resolve(); await saving;
  assert.equal(t.server.items[0].socialExperience.turn.incompleteWaitMs, 2800);
  assert.equal(d.value.socialExperience.turn.incompleteWaitMs, 3100); assert(d.dirty.has("socialExperience.turn.incompleteWaitMs"));
  assert.equal(d.conflict, false);
});
await test("pre-save refresh is not fresh post-save evidence", async () => {
  const t = await runtime(), s = t.state, d = s.registryDraft(), gate = deferred(); let reads = 0;
  t.hooks.beforeRead = () => ++reads === 1 ? gate.promise : undefined;
  const oldRead = s.refreshAccountRegistry(); await until(() => reads === 1);
  t.edit("turn.incompleteWaitMs", 2800);
  let finished = false;
  const saving = s.saveRegistryPatch("demo-a", ["socialExperience"], "社交表达").then(() => { finished = true; });
  await until(() => t.server.revision === "r2"); assert.equal(finished, false);
  gate.resolve(); await oldRead; await saving;
  assert(reads >= 3); assert.equal(d.dirty.size, 0); assert.equal(s.registryState.revision, "r2");
});
await test("shared policy is disabled in member editor and cannot PATCH", async () => {
  const t = await runtime(), s = t.state;
  s.registryState.groups = [{ id: "shared", name: "共享", memberIds: ["demo-a", "demo-b"], policy: { socialExperience: { ...structuredClone(expected), expression: { ...expected.expression, maxMessages: 3 } } } }];
  s.renderRegistryEditor(true);
  const controls = t.document.getElementById("dynamicAccountEditor").querySelectorAll("[data-registry-field]");
  assert(controls.length > 0 && controls.every(c => c.disabled));
  assert.equal(controls.find(c => c.dataset.registryField === "socialExperience.expression.maxMessages").value, "3");
  await assert.rejects(s.saveRegistryPatch("demo-a", ["socialExperience"], "社交表达"), /接管组/);
  assert(t.requests.every(r => r.method === "GET"));
  // Shared policy rendering also works when legacy policy lacks the new root.
  const host = new Element(); const policy = {};
  s.registryFields(host, policy, "experience", (path, value) => s.registrySet(policy, path, value), { policy: true });
  assert.deepEqual(policy, {});
  const control = host.querySelectorAll("[data-registry-field]").find(c => c.dataset.registryField === "socialExperience.expression.maxMessages");
  control.value = "3"; control.listeners.input[0]();
  s.registryValidate(policy, ["socialExperience"]); assert.equal(policy.socialExperience.enabled, false);
});
await test("invalid ranges, scope and toggles fail before transport", async () => {
  const t = await runtime(), s = t.state;
  for (const [path, value] of [["enabled", "true"], ["enabled", true], ["conversationIds", ["all"]], ["turn.minWaitMs", -1], ["turn.maxWaitMs", 9000], ["turn.ordinaryWaitMs", 0], ["turn.incompleteWaitMs", 5000], ["expression.maxMessages", 0], ["expression.maxMessages", 1.5], ["expression.minIntervalMs", 1000], ["expression.maxIntervalMs", NaN]]) {
    const valueRoot = structuredClone(expected); s.registrySet(valueRoot, path, value);
    assert.throws(() => s.registryValidate({ socialExperience: valueRoot }, ["socialExperience"]));
  }
  assert(t.requests.every(r => r.method === "GET"));
  assert.deepEqual(plain(s.registryTabKeys("experience")), ["socialExperience"]);
  assert.match(constants, /registryPolicyKeys[^\n]*"socialExperience"/);
});
await test("admin-only diagnostics filter owners, bound rows and never expose content", async () => {
  const t = await runtime(), s = t.state;
  t.hooks.diagnostic = { ok: true, turns: 120, plans: 50, recent: [
    { kind: "plans", owner: "account:demo-b", reason: "other_account" },
    ...Array.from({ length: 7 }, (_, i) => ({ kind: "turns", owner: "account:demo-a", at: 1700000000000 + i,
      waitMs: i, messageCount: i, shadow: true, reason: `code_${i}`, content: "PRIVATE_CONTENT_SENTINEL", reasoning: "REASONING_SENTINEL" })),
    { kind: "plans", owner: "demo-a", at: 1700000000010, confirmed: 0, partial: false, uncertain: true, shadow: false, reason: "<script>PRIVATE_CONTENT_SENTINEL</script>" }
  ] };
  await s.refreshExperienceStatus();
  const text = s.registryExperienceDiagnostic("demo-a");
  assert.match(text, /全局累计（非当前账号计数）：turn 120 · ReplyPlan 50/);
  assert.match(text, /最近 5 条/); assert.match(text, /确认 0 · 部分发送 否 · 结果不确定 是/);
  assert.match(text, /实际/); assert.match(text, /观察/); assert.match(text, /原因 未报告/);
  assert(!/other_account|code_0|code_1|code_2|PRIVATE_CONTENT|REASONING/.test(text));
  assert(text.indexOf("ReplyPlan · 实际") < text.indexOf("原因 code_6"));
  const reads = t.requests.filter(r => r.url === "/api/social-agent/expression-status");
  assert(reads.every(r => r.method === "GET" && r.token === "synthetic-session"));
  assert(t.requests.every(r => r.url === "/api/admin/session" || r.url === "/api/social-agent/expression-status"));
  assert(!text.includes("[object Object]"));
});
await test("shared identity diagnostics do not mix independent histories", async () => {
  const t = await runtime(), s = t.state;
  s.registryState.groups = [{ id: "team", memberIds: ["demo-a", "demo-b"] }];
  t.hooks.diagnostic = { ok: true, recent: [
    { kind: "turns", owner: "account:demo-a", reason: "old_independent" },
    { kind: "plans", owner: "group:team", confirmed: true, partial: false, uncertain: false, reason: "shared_current" },
    { kind: "plans", owner: "group:elsewhere", reason: "other_group" }
  ] };
  await s.refreshExperienceStatus();
  const text = s.registryExperienceDiagnostic("demo-a");
  assert.match(text, /turn 未知 · ReplyPlan 未知/); assert.match(text, /当前接管组共享身份/);
  assert.match(text, /确认 是/); assert.match(text, /shared_current/);
  assert(!/old_independent|other_group/.test(text));
  assert.equal(text, s.registryExperienceDiagnostic("demo-b"));
  assert.match(s.registryExperienceDiagnostic(""), /请到接管组成员账号/);
});
await test("diagnostic refresh deduplicates, preserves focused drafts and clears failed auth", async () => {
  const t = await runtime(), s = t.state, d = s.registryDraft(), gate = deferred();
  const field = t.edit("turn.incompleteWaitMs", 3100); t.document.activeElement = field;
  const host = t.document.getElementById("dynamicAccountEditor"), diagnostic = host.querySelector("[data-experience-diagnostic]");
  const draftBefore = plain(d.value), dirtyBefore = [...d.dirty], revision = s.registryState.revision;
  const count = () => t.requests.filter(r => r.url === "/api/social-agent/expression-status").length;
  const before = count(); t.hooks.beforeDiagnostic = () => gate.promise;
  t.hooks.diagnostic = { ok: true, turns: 1, plans: 0, recent: [{ kind: "turns", owner: "account:demo-a", waitMs: 700, shadow: true, reason: "complete" }] };
  const first = s.refreshExperienceStatus(), second = s.refreshExperienceStatus();
  await until(() => count() === before + 1); assert.match(diagnostic.textContent, /正在读取/);
  gate.resolve(); await Promise.all([first, second]); s.renderRegistryEditor();
  assert.equal(count(), before + 1); assert.equal(host.querySelector("[data-experience-diagnostic]"), diagnostic);
  assert.match(diagnostic.textContent, /原因 complete/); assert.equal(t.document.activeElement, field); assert(host.contains(field));
  assert.deepEqual(plain(d.value), draftBefore); assert.deepEqual([...d.dirty], dirtyBefore); assert.equal(s.registryState.revision, revision);
  t.hooks.diagnosticStatus = 403; await s.refreshExperienceStatus();
  assert.equal(count(), before + 2); assert.equal(s.registryState.experienceStatus.value, null);
  assert.match(diagnostic.textContent, /旧摘要已清空/); assert(!diagnostic.textContent.includes("complete"));
  t.hooks.diagnosticStatus = 200; t.hooks.diagnostic = { ok: true, recent: [] }; await s.refreshExperienceStatus();
  assert.equal(t.requests.filter(r => r.url === "/api/admin/session").length, 2);
  assert.match(diagnostic.textContent, /暂无最近记录/);
  t.hooks.diagnostic = { ok: true, recent: "invalid" }; await s.refreshExperienceStatus();
  assert.equal(s.registryState.experienceStatus.value, null); assert.match(diagnostic.textContent, /加载失败/);
  assert(t.requests.every(r => r.method === "GET"));
});
await test("generic registry refresh works without activePage in old VM harnesses", async () => {
  const t = await runtime(), s = t.state;
  delete s.activePage;
  const count = t.requests.filter(r => r.url === "/api/social-agent/expression-status").length;
  await s.refreshAccountRegistry();
  assert.equal(s.registryState.error, "");
  assert.equal(t.requests.filter(r => r.url === "/api/social-agent/expression-status").length, count);
});
await test("media policy defaults stay off and save only the current account root", async () => {
  const t = await runtime(), s = t.state, d = s.registryDraft();
  t.edit("stickers.autoSend", true); t.edit("language.autoCandidates", false);
  assert.equal(d.value.socialExperience.enabled, false); assert.equal(d.value.socialExperience.stickers.enabled, false);
  assert.equal(d.value.socialExperience.stickers.visionLearning, false); assert.equal(d.value.socialExperience.language.enabled, false);
  t.edit("stickers.maxDailyVisionCalls", 4); t.edit("stickers.cooldownMs", 90000);
  await s.saveRegistryEditor();
  const patch = t.requests.find(r => r.method === "PATCH").body.patch;
  assert.deepEqual(Object.keys(patch), ["socialExperience"]);
  assert.equal(patch.socialExperience.stickers.maxDailyVisionCalls, 4);
  assert.equal(t.server.items[0].socialExperience.language.autoCandidates, false);
  assert.equal(Object.hasOwn(t.server.items[1], "socialExperience"), false);
  assert.equal(libraryPosts(t).length, 0);
  for (const [path, value] of [["stickers.autoSend", "true"], ["stickers.maxDailyVisionCalls", -1], ["stickers.maxDailyVisionCalls", 101], ["stickers.cooldownMs", 0.5], ["stickers.cooldownMs", 86400001], ["language.enabled", "false"]]) {
    const candidate = structuredClone(expected); s.registrySet(candidate, path, value);
    assert.throws(() => s.registryValidate({ socialExperience: candidate }, ["socialExperience"]));
  }
  for (const [calls, cooldown] of [[0, 0], [100, 86400000]]) {
    const candidate = structuredClone(expected); candidate.stickers.maxDailyVisionCalls = calls; candidate.stickers.cooldownMs = cooldown;
    assert.doesNotThrow(() => s.registryValidate({ socialExperience: candidate }, ["socialExperience"]));
  }
  const writesBefore = t.requests.filter(r => r.method === "PATCH").length;
  for (const [path, value, max, error] of [["stickers.maxDailyVisionCalls", 101, "100", /0–100/], ["stickers.cooldownMs", 86400001, "86400000", /24 小时/]]) {
    const control = t.edit(path, value); assert.equal(control.max, max);
    await assert.rejects(s.saveRegistryPatch("demo-a", ["socialExperience"], "社交表达"), error);
    assert(d.dirty.has(`socialExperience.${path}`));
    t.edit(path, expected.stickers[path.split(".")[1]]);
  }
  assert.equal(t.requests.filter(r => r.method === "PATCH").length, writesBefore, "over-limit drafts are rejected before transport");
});
await test("library scope uses saved/draft intersection, never unsaved authority", async () => {
  const t = await runtime(), s = t.state;
  assert.deepEqual(plain(s.experienceLibraryScopes("demo-a")), []);
  await s.selectExperienceLibrary("demo-a", "group:123456");
  assert(!t.requests.some(r => r.url.includes("expression-library")));
  const d = libraryScope(t);
  d.value.socialExperience.conversationIds.push("group:999999");
  assert.deepEqual(plain(s.experienceLibraryScopes("demo-a")), ["group:123456", "private:654321"]);
  await s.selectExperienceLibrary("demo-a", "group:123456");
  const state = s.experienceLibraryState("demo-a", "group:123456");
  assert.equal(state.data.revision, "s1");
  t.edit("conversationIds", "private:654321");
  assert(!libraryHost(t).textContent.includes("sticker-a"));
  await s.mutateExperienceLibrary("demo-a", "group:123456", "sync");
  assert.equal(libraryPosts(t).length, 0);
});
await test("metadata projection creates no remote media, URLs, source text or evidence", async () => {
  const t = await runtime(), s = t.state; libraryScope(t);
  const remote = t.library("demo-a", "group:123456");
  remote.stickers[0].official.desc = '<img src="https://tracking.invalid/secret">';
  remote.stickers[1].annotation.note = "note https://tracking.invalid/hidden";
  remote.language.candidates[0].meaning = "meaning https://tracking.invalid/hidden";
  await s.selectExperienceLibrary("demo-a", "group:123456");
  const host = libraryHost(t), stored = JSON.stringify(s.experienceLibraryState("demo-a", "group:123456").data);
  assert(!/https?:|tracking.invalid|RAW_MESSAGE_SENTINEL|evidence|userId/.test(stored));
  assert(!/https?:|tracking.invalid|RAW_MESSAGE_SENTINEL/.test(host.textContent));
  assert(host.querySelectorAll("*").every(el => !["IMG", "IFRAME", "VIDEO", "AUDIO", "A"].includes(el.tagName)));
  assert.match(host.textContent, /来源描述（不可信）/); assert.match(host.textContent, /候选不是事实/);
  assert.match(host.textContent, /样本 3/); assert.match(host.textContent, /待审核候选/);
  assert.match(host.textContent, /未知（未确认）/); assert.equal(libraryPosts(t).length, 0);
});
await test("sync is metadata-only; annotation requires per-item paid consent and fresh readback", async () => {
  const t = await runtime(), s = t.state, d = libraryScope(t);
  t.edit("turn.incompleteWaitMs", 3000); const before = plain(d.value), dirty = [...d.dirty], revision = s.registryState.revision;
  await s.selectExperienceLibrary("demo-a", "group:123456");
  await s.mutateExperienceLibrary("demo-a", "group:123456", "sync");
  assert.deepEqual(libraryPosts(t)[0].body, { conversationId: "group:123456", expectedStateRevision: "s1" });
  assert.match(libraryHost(t).textContent, /协议支持/);
  const item = s.experienceLibraryState("demo-a", "group:123456").data.stickers[0];
  s.confirm = () => false; await s.mutateExperienceLibrary("demo-a", "group:123456", "annotate", item);
  assert.equal(libraryPosts(t).length, 1);
  let prompt = ""; s.confirm = text => { prompt = text; return true; };
  await s.mutateExperienceLibrary("demo-a", "group:123456", "annotate", item);
  assert.match(prompt, /这一项/); assert.match(prompt, /费用/);
  assert.deepEqual(libraryPosts(t)[1].body, { conversationId: "group:123456", expectedStateRevision: "s2", id: "sticker-a" });
  const data = s.experienceLibraryState("demo-a", "group:123456").data;
  assert.equal(data.stickers[0].annotation.status, "candidate"); assert.equal(data.revision, "s3");
  assert.equal(data.stickers[1].annotation.revision, 1);
  assert.deepEqual(plain(d.value), before); assert.deepEqual([...d.dirty], dirty); assert.equal(s.registryState.revision, revision);
  assert(libraryPosts(t).every(r => /\/(?:sync|annotate)$/.test(r.url)));
});
await test("sticker and language reviews pin exact item and state revisions", async () => {
  const t = await runtime(), s = t.state; libraryScope(t); const scope = "group:123456";
  await s.selectExperienceLibrary("demo-a", scope);
  const state = s.experienceLibraryState("demo-a", scope), sticker = state.data.stickers[1];
  await s.mutateExperienceLibrary("demo-a", scope, "review-sticker", sticker, "confirmed");
  assert.deepEqual(libraryPosts(t)[0].body, { conversationId: scope, expectedStateRevision: "s1", id: "sticker-b", expectedRevision: 1, status: "confirmed" });
  await s.mutateExperienceLibrary("demo-a", scope, "review-sticker", sticker, "rejected");
  assert.equal(libraryPosts(t).length, 1, "stale item revision must not wire");
  const term = state.data.language.candidates[0];
  await s.mutateExperienceLibrary("demo-a", scope, "review-language", term, "confirmed");
  assert.deepEqual(libraryPosts(t)[1].body, { conversationId: scope, expectedStateRevision: "s2", id: "slang:demo:1", expectedRevision: 1, status: "confirmed" });
  const confirmed = state.data.language.candidates[0];
  await s.mutateExperienceLibrary("demo-a", scope, "review-language", confirmed, "revoked");
  assert.equal(state.data.language.candidates[0].status, "revoked");
  await s.mutateExperienceLibrary("demo-a", scope, "review-language", state.data.language.candidates[0], "confirmed");
  assert.equal(libraryPosts(t).length, 3, "terminal language candidate cannot resurrect");
  await s.selectExperienceLibrary("demo-a", "private:654321");
  assert.match(libraryHost(t).textContent, /群语感仅支持群聊/);
  assert(!libraryHost(t).textContent.includes("演示词义"));
  assert.equal(s.experienceLibraryState("demo-a", "private:654321").data.language.candidates.length, 0);
  await s.mutateExperienceLibrary("demo-a", "private:654321", "review-language", term, "confirmed");
  assert.equal(libraryPosts(t).length, 3);
});
await test("library failures are fixed, retain config drafts and never replay uncertain POSTs", async () => {
  for (const status of [403, 409, 500]) {
    const t = await runtime(), s = t.state, d = libraryScope(t), scope = "group:123456";
    t.edit("stickers.maxDailyVisionCalls", 5); const before = plain(d.value);
    await s.selectExperienceLibrary("demo-a", scope);
    t.hooks.libraryPostStatus = status;
    await s.mutateExperienceLibrary("demo-a", scope, "annotate", s.experienceLibraryState("demo-a", scope).data.stickers[0]);
    assert.equal(libraryPosts(t).length, 1); assert(!libraryHost(t).textContent.includes("PRIVATE_ERROR_SENTINEL"));
    assert.match(libraryHost(t).textContent, status === 409 ? /修订冲突/ : /结果不确定/);
    assert.deepEqual(plain(d.value), before); assert(d.dirty.has("socialExperience.stickers.maxDailyVisionCalls"));
    t.hooks.libraryPostStatus = 0; await s.loadExperienceLibrary("demo-a", scope);
    await s.mutateExperienceLibrary("demo-a", scope, "annotate", s.experienceLibraryState("demo-a", scope).data.stickers[0]);
    assert.equal(libraryPosts(t).length, 1, "same uncertain action/revision never repeats even after fresh read");
    assert.match(libraryHost(t).textContent, /此修订已尝试过/);
  }
  const t = await runtime(), s = t.state; libraryScope(t); const scope = "group:123456";
  await s.selectExperienceLibrary("demo-a", scope);
  t.hooks.afterLibraryPost = () => { t.hooks.libraryStatus = 500; };
  await s.mutateExperienceLibrary("demo-a", scope, "sync");
  assert.equal(libraryPosts(t).length, 1); assert.match(libraryHost(t).textContent, /已提交但读回未核实/);
  assert.equal(s.experienceLibraryState("demo-a", scope).data, null);
});
await test("delayed library responses cannot cross account/scope; recheck revocation before POST", async () => {
  const t = await runtime(), s = t.state, gate = deferred(); libraryScope(t); libraryScope(t, "demo-b");
  t.hooks.beforeLibraryRead = id => id === "demo-a" ? gate.promise : undefined;
  const pending = s.selectExperienceLibrary("demo-a", "group:123456");
  await until(() => t.requests.some(r => r.url.includes("demo-a/expression-library")));
  s.registrySelect("demo-b", "experience"); await s.selectExperienceLibrary("demo-b", "private:654321");
  gate.resolve(); await pending;
  assert.equal(libraryHost(t).dataset.accountId, "demo-b"); assert.match(libraryHost(t).textContent, /群语感仅支持群聊/);
  const scope = "private:654321", state = s.experienceLibraryState("demo-b", scope);
  const mutation = s.mutateExperienceLibrary("demo-b", scope, "annotate", state.data.stickers[0]);
  s.registryDraft("demo-b").value.socialExperience.conversationIds = [];
  await mutation; assert.equal(libraryPosts(t).length, 0, "scope revoked during session await cannot wire");
});
await test("daily vision cost counters are read-only; zero is known, absent/invalid is unknown", async () => {
  const t = await runtime(), s = t.state, d = libraryScope(t), scope = "group:123456";
  const before = plain(d.value), dirty = [...d.dirty], revision = s.registryState.revision;
  await s.selectExperienceLibrary("demo-a", scope);
  assert.match(libraryHost(t).textContent, /已预留 0 · 已尝试 2 · 上限 8/);
  assert.match(libraryHost(t).textContent, /不是费用金额/);
  const state = s.experienceLibraryState("demo-a", scope);
  await s.mutateExperienceLibrary("demo-a", scope, "annotate", state.data.stickers[0]);
  assert.match(libraryHost(t).textContent, /已预留 0 · 已尝试 3 · 上限 8/);
  assert(!JSON.stringify(libraryPosts(t)[0].body).includes("dailyVisionCalls"));
  delete t.library("demo-a", scope).dailyVisionCalls;
  await s.loadExperienceLibrary("demo-a", scope);
  assert.match(libraryHost(t).textContent, /已预留 未知 · 已尝试 未知 · 上限 未知/);
  t.library("demo-a", scope).dailyVisionCalls = { reserved: -1, attempted: "2", limit: false };
  await s.loadExperienceLibrary("demo-a", scope);
  assert.deepEqual(plain(state.data.dailyVisionCalls), { reserved: null, attempted: null, limit: null });
  assert.deepEqual(plain(d.value), before); assert.deepEqual([...d.dirty], dirty); assert.equal(s.registryState.revision, revision);
});
await test("learned source and reaction acceptance stay distinct from administrator approval and chat ACK", async () => {
  const t=await runtime(); libraryScope(t); const scope="group:123456", raw=t.library("demo-a",scope);
  raw.learning={ok:true,queued:1,active:1,dailyDownloads:2,downloadLimit:16,rawContext:"DO_NOT_SHOW"};
  raw.reactions={ok:true,capability:"unsupported",daily:1,maxDaily:30,accepted:0,uncertain:1,targetMessageId:"DO_NOT_SHOW"};
  raw.cache={available:true,bytes:1048576,maxBytes:134217728,entries:1,path:"/PRIVATE_PATH"};
  raw.stickers.push({id:"gs_fixture",source:"group-observed",autoEligible:true,usage:"庆祝时表达赞同",avoid:["认真求助"],
    official:{desc:"",trust:"untrusted"},annotation:{revision:1,status:"candidate",note:"庆祝",tags:["开心"],sentCount:0,lastSentAt:0}});
  await t.state.selectExperienceLibrary("demo-a",scope);
  const host=libraryHost(t), data=t.state.experienceLibraryState("demo-a",scope).data;
  assert.match(host.textContent,/群聊学习/); assert.match(host.textContent,/自动可用（无需审批）/);
  assert.match(host.textContent,/庆祝时表达赞同/); assert.match(host.textContent,/排队 1/);
  assert.match(host.textContent,/1 \/ 128 MiB/); assert.match(host.textContent,/当前协议不支持/);
  assert.match(host.textContent,/受理不代表已确认对端显示/);
  assert(!JSON.stringify(data).includes("DO_NOT_SHOW")); assert(!JSON.stringify(data).includes("PRIVATE_PATH"));
  assert.equal(libraryPosts(t).length,0,"viewing statuses does not initiate learning or reactions");
});
console.log(JSON.stringify({ ok: true, cases, offline: true, liveDataTouched: false, bridgeStarted: false }));

if (process.argv.includes("--preview")) {
  const css = fs.readFileSync(new URL("../public/console.css", import.meta.url), "utf8");
  const page = `<!doctype html><html lang="zh-CN" data-theme="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/console.css"><title>社交表达 · 合成预览</title><body><main style="max-width:1000px;margin:auto;padding:24px"><h1>社交表达 · 合成预览</h1><p>仅虚构账号与内存保存，不连接真实机器人。</p><div class="row"><button id="theme">切换明暗</button><button id="other">切换演示账号</button></div><section id="dynamicAccountEditor" class="card"></section><p id="preview-feedback" role="status"></p></main><script>
    const synthetic = (${fixture.toString()})(document, window);
    for (const item of synthetic.server.items) item.socialExperience = { conversationIds: ['group:123456', 'private:654321'] };
    registryState.items = structuredClone(synthetic.server.items);
    ${realSource}
    registryFeedback = message => document.getElementById('preview-feedback').textContent = message;
    registrySelect('demo-a', 'experience');
    document.getElementById('theme').addEventListener('click', () => document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    document.getElementById('other').addEventListener('click', () => registrySelect(registryState.selected === 'demo-a' ? 'demo-b' : 'demo-a', 'experience'));
  </script></body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url === "/console.css") { res.setHeader("content-type", "text/css"); res.end(css); }
    else if (req.url === "/") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(page); }
    else { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1", () => console.log(`Synthetic experience preview: http://127.0.0.1:${server.address().port}/`));
}
