#!/usr/bin/env node
// Executes the real shared WebUI/App editor against synthetic DOM + transport.
// --preview serves only this isolated fixture; no bridge, QQ, model or live data.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import http from "node:http";
import { validateQzonePolicy } from "../src/qzone-policy.js";
import { validateSocialExperiencePolicy } from "../src/social-experience-policy.js";

const html = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes("function registryEditable("));
for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
function source(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, "m").exec(script);
  assert(start, `missing actual function: ${name}`);
  const tail = script.slice(start.index), end = /^    \}/m.exec(tail);
  assert(end); return tail.slice(0, end.index + end[0].length);
}
const constants = ["registryTabs", "registryFeatures", "registrySendTypes", "registryIdentityKeys", "registryPolicyKeys"].map(name => script.match(new RegExp(`^    const ${name} = .+;$`, "m"))[0]).join("\n");
const names = ["api", "ensureAdminSession", "registryItem", "registryGroup", "registryEffective", "registryStyle", "registryEditable", "registryDraft", "registrySet", "registryGet", "registryButton", "registryRequest", "rebaseRegistryDraft", "refreshAccountRegistry", "registryField", "registryFields", "registryValidate", "registryTabKeys", "registryPatch", "confirmRegistrySave", "saveRegistryPatch", "saveRegistryEditor", "registrySelect", "syncRegistryDraftControls", "registryDraftStatus", "renderRegistryEditor", "socialLifeState", "socialLifeNode", "socialLifeText", "socialLifeRequest", "socialLifeRender", "loadQzoneSnapshot", "qzoneOperation", "renderQzoneRuntime", "loadBehaviorPreview", "renderBehaviorPreview"];
const realSource = `${constants}\nlet adminSessionToken = "", adminSessionRequest = null;\n${[...names, "experienceLibraryState", "probeExperiencePoke"].map(source).join("\n")}`;

class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = {};
    this.classes = new Set(); this._text = ""; this._value = ""; this.type = ""; this.disabled = false; this.checked = false;
    this.classList = { add: k => this.classes.add(k), remove: k => this.classes.delete(k), toggle: (k, v) => v ? this.classes.add(k) : this.classes.delete(k) };
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  set value(v) { this._value = String(v); }
  get value() { return this._value; }
  set innerHTML(_) { throw new Error("untrusted HTML forbidden"); }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this._text = ""; this.append(...items); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  contains(node) { return this === node || this.children.some(c => c.contains(node)); }
  querySelectorAll(selector) {
    const all = this.children.flatMap(c => [c, ...c.querySelectorAll("*")]);
    if (selector === "*") return all;
    const attr = /^\[data-([a-z-]+)\]$/.exec(selector);
    if (attr) { const key = attr[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()); return all.filter(c => Object.hasOwn(c.dataset, key)); }
    return [];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function mockDocument() {
  const nodes = new Map(["dynamicAccountEditor", "saveBtn", "saveState", "pageActionState"].map(id => [id, new Element()]));
  return { activeElement: null, getElementById: id => nodes.get(id) || null, createElement: tag => new Element(tag), querySelectorAll: () => [] };
}

// Serializable into --preview. All requests terminate here, never the network.
function fixture(document, scope = {}) {
  const policy = () => ({ enabled: false, mode: "draft_only", ugcRight: 64, allowedAudiences: [64], reads: { feeds: false, own: false, count: 20, maxDaily: 20, cooldownMs: 1000, freshnessMs: 300000, ttlMs: 3600000 }, publish: { enabled: false, maxDaily: 2, cooldownMs: 3600000 }, likes: { enabled: false, maxDaily: 5, cooldownMs: 300000 }, comments: { enabled: false, maxDaily: 2, cooldownMs: 600000 }, autonomy: { enabled: false, maxContentLength: 280, sources: [] } });
  const server = { revision: "r1", items: ["demo-a", "demo-b"].map(id => ({ id, displayName: `合成账号 ${id}`, enabled: true, qzone: policy() })), failoverGroups: [], statuses: [] };
  const requests = [], hooks = {}, snapshots = new Map(), feedback = [], confirmations = [];
  const snapshot = id => {
    if (!snapshots.has(id)) snapshots.set(id, { ok: true, revision: server.revision, accountId: id, logicalId: `account:${id}`, policy: structuredClone(server.items.find(a => a.id === id).qzone), capabilities: {}, drafts: [], feeds: [] });
    const value = snapshots.get(id); value.revision = server.revision; value.policy = structuredClone(server.items.find(a => a.id === id).qzone); return value;
  };
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
  Object.assign(scope, {
    renderExperienceLibrary: () => {},
    cfg: { revision: "r1" }, activePage: "account-functions", dirtyScopes: new Set(), conflictedScopes: new Set(),
    registryState: { loaded: true, selected: "demo-a", tab: "qzone", revision: "r1", epoch: 0, items: structuredClone(server.items), groups: [], statuses: [], drafts: new Map(), contexts: {}, operations: new Map(), modelLoadedAt: Date.now(), error: "", busy: false, refreshing: null },
    $: id => document.getElementById(id),
    renderRegistryLists() {}, renderRegistryContexts() {}, renderRegistrySaveState() {}, renderSaveState() {}, renderApiAccountModels() {}, renderAutomationTargetPicker() {}, fillConfig() {},
    refreshExperienceStatus() {}, registryExperienceDiagnostic: () => "仅合成诊断", renderExperienceLibrary() {},
    registryFeedback: message => feedback.push(message), sensitiveApi: async () => ({ center: {} }),
    confirm: message => { confirmations.push(message); return hooks.confirm !== false; },
    fetch: async (url, opts = {}) => {
      if (opts.signal?.aborted) throw new Error("aborted before transport");
      const method = opts.method || "GET", body = opts.body ? JSON.parse(opts.body) : null;
      requests.push({ url, method, body, token: opts.headers?.get("x-hermes-qq-admin") });
      if (url === "/api/admin/session") { await hooks.beforeSession?.(); return response({ token: "synthetic-session" }); }
      if (!opts.headers?.get("x-hermes-qq-admin") && !url.startsWith("/api/config?")) throw new Error("Missing synthetic admin session");
      if (url.startsWith("/api/accounts?")) {
        if (hooks.accountReadFailure) throw new Error("offline");
        return response({ ok: true, ...structuredClone(server) });
      }
      if (url.startsWith("/api/config?")) return response({ revision: server.revision });
      if (url.startsWith("/api/accounts/")) {
        if (hooks.patchStatus) return response({ error: "PRIVATE_ERROR_SENTINEL" }, hooks.patchStatus);
        if (body.expectedRevision !== server.revision) return response({ ok: false }, 409);
        await hooks.beforePatch?.();
        const id = decodeURIComponent(url.split("/").at(-1));
        Object.assign(server.items.find(a => a.id === id), structuredClone(body.patch)); server.revision = `r${Number(server.revision.slice(1)) + 1}`;
        hooks.afterPatch?.(); return response({ ok: true, revision: server.revision });
      }
      const parts = url.split("/"), id = decodeURIComponent(parts[4]), operation = parts.at(-1), current = snapshot(id);
      if (url.endsWith("/native-pokes/probe")) return response({ ok: true, result: { status: "accepted" } }, hooks.probeStatus || 200);
      if (operation === "behavior-preview") {
        await hooks.beforePreview?.(id);
        return response(hooks.preview || { ok: true, revision: server.revision, accountId: id, preset: "existing", chapters: ["request", "rhythm"], diagnostics: { promptCost: { promptChars: 120, estimatedTokens: 60 }, private: "PRIVATE_PERSONA_SENTINEL" }, composition: "PRIVATE_PERSONA_SENTINEL", comparison: { scope: "composed-system-only", baseline: { promptChars: 240, estimatedTokens: 120 }, candidate: { promptChars: 120, estimatedTokens: 60 } } }, hooks.previewStatus || 200);
      }
      if (operation === "qzone" && method === "GET") {
        await hooks.beforeSnapshot?.(id, opts.signal);
        return response(hooks.snapshot || structuredClone(current), hooks.snapshotStatus || 200);
      }
      if (!url.includes("/qzone/") || method !== "POST") throw new Error(`Unexpected synthetic route ${url}`);
      await hooks.beforeOperation?.(opts.signal);
      if (hooks.postStatus) return response({ error: "PRIVATE_ERROR_SENTINEL" }, hooks.postStatus);
      if (hooks.postFailure) throw new Error("wire unknown");
      if (body.expectedRevision !== server.revision) return response({ ok: false }, 409);
      if (["create-draft", "generate-draft", "propose-interaction"].includes(operation)) current.drafts.push({ id: `draft-${current.drafts.length + 1}`, revision: 1, status: "draft", kind: body.kind || "publish", content: body.content || (operation === "generate-draft" ? "合成模型草稿" : ""), source: body.source, audience: body.audience ?? null, protocolAccepted: false, clientVerified: false });
      else if (operation === "read-feeds" || operation === "read-own") current.feeds = [{ id: "host-feed-a", content: "<img src=x onerror=alert(1)>远端纯文本", source: "private_qzone", projectable: false }];
      else {
        const item = current.drafts.find(d => d.id === body.id);
        if (!item || body.draftRevision !== item.revision) return response({ ok: false }, 409);
        item.status = { "submit-review": "review", approve: "approved", publish: "publishing", verify: "confirmed", cancel: "uncertain" }[operation]; item.revision++;
        if (operation === "publish") item.protocolAccepted = true;
        if (operation === "verify") item.clientVerified = true;
      }
      return response({ ok: true });
    }
  });
  return { server, requests, hooks, snapshots, snapshot, feedback, confirmations, state: scope, document };
}
function runtime() {
  const document = mockDocument(), t = fixture(document, { document, Headers, Response, URL, structuredClone, Date, AbortController, setTimeout, clearTimeout });
  vm.runInContext(realSource, vm.createContext(t.state)); t.state.registrySelect("demo-a", "qzone");
  t.host = () => document.getElementById("dynamicAccountEditor");
  t.nodes = () => t.host().querySelectorAll("*");
  t.edit = (key, value) => {
    const node = t.nodes().find(n => n.dataset.registryField === key || n.dataset.qzoneEditor === key);
    assert(node, `control ${key}`); assert.equal(node.disabled, false);
    if (node.type === "checkbox") node.checked = value; else node.value = value;
    for (const fn of node.listeners[node.type === "checkbox" || node.tagName === "SELECT" ? "change" : "input"] || []) fn();
  };
  return t;
}
const plain = value => JSON.parse(JSON.stringify(value));
const posts = t => t.requests.filter(r => r.method === "POST" && r.url.includes("/qzone/"));
const cases = [];
async function test(name, fn) { await fn(); cases.push(name); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; }
async function until(check) { for (let n = 0; n < 300; n++) { if (check()) return; await Promise.resolve(); } throw new Error("synthetic wait exhausted"); }
function allow(t) {
  const p = t.server.items[0].qzone; p.enabled = true; p.mode = "reviewed"; p.reads.feeds = p.reads.own = true; p.publish.enabled = p.likes.enabled = p.comments.enabled = true;
  t.state.registryState.items = structuredClone(t.server.items); t.state.registryState.drafts.clear(); t.state.renderRegistryEditor(true);
}

await test("opening and polling are inert; defaults off, draft-only, self-only; one tab save", async () => {
  const t = runtime(), d = t.state.registryDraft();
  assert.equal(t.requests.length, 0); assert.equal(d.value.qzone.enabled, false); assert.equal(d.value.qzone.mode, "draft_only"); assert.equal(d.value.qzone.ugcRight, 64);
  assert.equal(d.value.qzone.reads.feeds, false); assert.equal(d.value.qzone.publish.enabled, false); assert.equal(d.value.qzone.likes.enabled, false); assert.equal(d.value.qzone.comments.enabled, false);
  t.state.renderRegistryEditor(); assert.equal(t.requests.length, 0);
  assert.equal(t.nodes().filter(n => n.tagName === "BUTTON" && /^保存/.test(n.textContent)).length, 1);
  assert.match(t.host().textContent, /协议验证/); assert.match(t.host().textContent, /审核/); assert.match(t.host().textContent, /实际回执/);
});
await test("single account qzone PATCH preserves nested normalized limits, other drafts and defaults", async () => {
  const t = runtime(), s = t.state;
  t.edit("qzone.reads.feeds", true); s.registrySet(s.registryDraft().value, "style.systemPrompt", "LOCAL_UNSAVED"); s.registryDraft().dirty.add("style.systemPrompt");
  s.registryDraft("demo-b").dirty.add("selfName");
  await s.saveRegistryEditor();
  const patches = t.requests.filter(r => r.method === "PATCH"); assert.equal(patches.length, 1);
  assert.deepEqual(Object.keys(patches[0].body.patch), ["qzone"]); assert.equal(patches[0].body.expectedRevision, "r1");
  const p = patches[0].body.patch.qzone; assert.equal(p.reads.count, 20); assert.equal(p.autonomy.enabled, false); assert.equal(p.publish.enabled, false); assert(!Object.hasOwn(p, "allowReads"));
  assert.deepEqual(validateQzonePolicy(p), p);
  assert(s.registryDraft().dirty.has("style.systemPrompt")); assert(s.registryDraft("demo-b").dirty.has("selfName")); assert.equal(posts(t).length, 0);
});
await test("generation is explicit, confirmed, topic-only, preserves draft text and never publishes", async () => {
  const t = runtime(); allow(t); await t.state.loadQzoneSnapshot("demo-a");
  t.edit("topic", "合成主题"); t.edit("text", "未提交手写内容");
  t.hooks.confirm = false; await t.state.qzoneOperation("demo-a", "generate-draft"); assert.equal(posts(t).length, 0);
  t.hooks.confirm = true; await t.state.qzoneOperation("demo-a", "generate-draft");
  assert.equal(posts(t).length, 1); assert.match(posts(t)[0].url, /generate-draft$/);
  assert.deepEqual(JSON.parse(JSON.stringify(posts(t)[0].body)), { expectedRevision: "r1", topic: "合成主题", audience: 64 });
  assert.equal(t.state.socialLifeState("demo-a").editor.text, "未提交手写内容");
  assert.equal(t.state.socialLifeState("demo-a").data.drafts[0].status, "draft");
});
await test("native probe requires explicit confirmation, scoped host handle and single attempt", async () => {
  const t = runtime(), source = { sourceId: `poke_notice:${"a".repeat(64)}`, userId: "12345", sentAt: Date.now() };
  t.hooks.confirm = false;
  await t.state.probeExperiencePoke("demo-a", "group:123456", source);
  assert.equal(t.requests.filter(r => r.url.endsWith("/native-pokes/probe")).length, 0);
  t.hooks.confirm = true;
  await t.state.probeExperiencePoke("demo-a", "group:123456", source);
  await t.state.probeExperiencePoke("demo-a", "group:123456", source);
  const requests = t.requests.filter(r => r.url.endsWith("/native-pokes/probe"));
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].body)), { expectedRevision: "r1", conversationId: "group:123456", sourceId: source.sourceId });
  assert.equal(t.state.experienceLibraryState("demo-a", "group:123456").busy, false);
});
await test("audience and daily limit edits are explicit draft configuration, not publication", async () => {
  const t = runtime(); t.edit("qzoneAudience.1", true); t.edit("qzone.publish.maxDaily", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(t.state.registryDraft().value.qzone.allowedAudiences)), [1, 64]);
  assert.equal(posts(t).length, 0);
  await t.state.saveRegistryEditor();
  const saved = t.requests.find(r => r.method === "PATCH").body.patch.qzone;
  assert.equal(saved.publish.maxDaily, 1); assert.equal(saved.publish.enabled, false); assert.equal(saved.autonomy.enabled, false);
  assert.equal(saved.ugcRight, 64); assert.equal(posts(t).length, 0);
});
await test("optional behavior preset preserves legacy absence; bounded image interaction is independent and off", async () => {
  const t = runtime(), s = t.state; s.registrySelect("demo-a", "experience");
  assert(!Object.hasOwn(s.registryDraft().value.socialExperience, "behaviorPreset"));
  assert.equal(t.nodes().find(n => n.dataset.registryField === "socialExperience.behaviorPreset").value, "existing");
  assert.equal(s.registryDraft().value.socialExperience.stickers.interactionEnabled, false);
  assert.deepEqual(plain(s.registryDraft().value.socialExperience), validateSocialExperiencePolicy({}));
  t.edit("socialExperience.behaviorPreset", "observant"); t.edit("socialExperience.stickers.interactionEnabled", true);
  assert.equal(s.registryDraft().value.socialExperience.stickers.autoSend, false); assert.equal(s.registryDraft().value.socialExperience.enabled, false);
  await s.saveRegistryEditor();
  const patch = t.requests.find(r => r.method === "PATCH").body.patch; assert.deepEqual(Object.keys(patch), ["socialExperience"]);
  assert.equal(patch.socialExperience.behaviorPreset, "observant"); assert.equal(patch.socialExperience.stickers.interactionEnabled, true); assert.equal(patch.socialExperience.stickers.autoSend, false);
  assert.deepEqual(validateSocialExperiencePolicy(patch.socialExperience), patch.socialExperience);
  const invalid = plain(s.registryDraft().value); invalid.socialExperience.behaviorPreset = "unbounded";
  assert.throws(() => s.registryValidate(invalid, ["socialExperience"]));
  assert.equal(t.requests.filter(r => r.url.endsWith("/behavior-preview")).length, 0); assert.equal(posts(t).length, 0);
});
await test("draft-only compatibility never persists qzone on another tab save; physical account in failover", async () => {
  const t = runtime(), s = t.state;
  delete s.registryState.items[0].qzone; delete t.server.items[0].qzone; s.registryState.drafts.clear();
  s.registryDraft().value.selfName = "合成自称"; s.registryDraft().dirty.add("selfName");
  await s.saveRegistryPatch("demo-a", ["selfName"], "基本");
  assert(!Object.hasOwn(t.requests.find(r => r.method === "PATCH").body.patch, "qzone"));
  s.registryState.groups = [{ id: "group-demo", name: "演示接管组", memberIds: ["demo-a", "demo-b"], policy: { style: { systemPrompt: "SHARED" } } }];
  s.renderRegistryEditor(true); t.edit("qzone.reads.own", true); await s.saveRegistryEditor();
  assert.equal(t.requests.filter(r => r.method === "PATCH").at(-1).url, "/api/accounts/demo-a");
  assert.equal(t.requests.filter(r => r.method === "PATCH").at(-1).body.patch.qzone.reads.own, true);
});
await test("policy 409, normalization readback mismatch and offline retain dirty inputs", async () => {
  for (const mode of ["conflict", "offline", "mismatch"]) {
    const t = runtime(); t.edit("qzone.reads.own", true);
    if (mode === "conflict") t.hooks.patchStatus = 409;
    if (mode === "offline") t.hooks.afterPatch = () => { t.hooks.accountReadFailure = true; };
    if (mode === "mismatch") t.hooks.afterPatch = () => { t.server.items[0].qzone.reads.own = false; };
    await assert.rejects(t.state.saveRegistryEditor()); assert.equal(t.state.registryDraft().value.qzone.reads.own, true); assert(t.state.registryDraft().dirty.has("qzone.reads.own"));
    assert.equal(t.requests.filter(r => r.method === "PATCH").length, 1);
  }
});
await test("local snapshot GET is authenticated, never remote reads; explicit remote read is separate", async () => {
  const t = runtime(); allow(t); await t.state.loadQzoneSnapshot("demo-a");
  assert.equal(posts(t).length, 0); assert(t.requests.find(r => r.url.endsWith("/qzone")).token);
  await t.state.qzoneOperation("demo-a", "read-feeds");
  assert.equal(posts(t).length, 1); assert.equal(posts(t)[0].body.expectedRevision, "r1"); assert.equal(t.confirmations.length, 1);
  t.state.renderRegistryEditor(); assert.equal(posts(t).length, 1);
  assert.match(t.host().textContent, /<img src=x onerror=alert\(1\)>/);
  assert(t.nodes().every(n => !["IMG", "IFRAME", "A", "VIDEO", "AUDIO"].includes(n.tagName)));
});
await test("runtime compose survives focused polling, account switches and delayed results", async () => {
  const t = runtime(), s = t.state; t.edit("text", "合成草稿 A"); t.edit("qzone.reads.own", true);
  const control = t.nodes().find(n => n.dataset.qzoneEditor === "text"); t.document.activeElement = control; s.renderRegistryEditor(); assert(t.host().contains(control));
  t.document.activeElement = null; s.registrySelect("demo-b", "qzone"); t.edit("text", "合成草稿 B");
  const gate = deferred(); t.hooks.beforeSnapshot = () => gate.promise;
  const pending = s.loadQzoneSnapshot("demo-a"); gate.resolve(); await pending;
  assert.equal(t.nodes().find(n => n.dataset.qzoneEditor === "text").value, "合成草稿 B");
  s.registrySelect("demo-a", "qzone"); assert.equal(t.nodes().find(n => n.dataset.qzoneEditor === "text").value, "合成草稿 A"); assert.equal(s.registryDraft().value.qzone.reads.own, true);
});
await test("create, review, approve, publish and verify use independent deliberate CAS steps", async () => {
  const t = runtime(); allow(t); await t.state.loadQzoneSnapshot("demo-a"); t.edit("text", "合成公开话题");
  await t.state.qzoneOperation("demo-a", "create-draft");
  assert.deepEqual(posts(t)[0].body, { expectedRevision: "r1", source: { kind: "admin_topic", ref: "admin_ui" }, content: "合成公开话题", audience: 64, images: [] });
  for (const op of ["submit-review", "approve", "publish", "verify"]) {
    const item = t.state.socialLifeState("demo-a").data.drafts[0], revision = item.revision;
    await t.state.qzoneOperation("demo-a", op, item);
    assert.deepEqual(posts(t).at(-1).body, { expectedRevision: "r1", id: item.id, draftRevision: revision });
  }
  assert.equal(posts(t).length, 5); assert.match(t.host().textContent, /客户端可见证据/);
  assert(t.confirmations.some(s => /受众：64/.test(s))); assert(t.confirmations.some(s => /核验会显式读取/.test(s)));
});
await test("unknown media and unavailable exact draft revision fail closed before transport", async () => {
  const t = runtime(); allow(t); const d = { id: "draft-media", kind: "publish", revision: 3, status: "approved", content: "fake", audience: 64, images: ["/Users/private.png"] };
  t.snapshot("demo-a").drafts.push(d); await t.state.loadQzoneSnapshot("demo-a");
  await t.state.qzoneOperation("demo-a", "publish", d); assert.equal(posts(t).length, 0); assert.match(t.host().textContent, /未知媒体/);
  delete d.images; d.revision = null; await t.state.loadQzoneSnapshot("demo-a");
  await t.state.qzoneOperation("demo-a", "approve", d); assert.equal(posts(t).length, 0);
});
await test("likes/comments only reference saved host feed handles, no raw QQ/tid or implied wire", async () => {
  const t = runtime(); allow(t); t.snapshot("demo-a").feeds.push({ id: "host-feed-a", content: "合成动态" }); await t.state.loadQzoneSnapshot("demo-a");
  await t.state.qzoneOperation("demo-a", "propose-interaction", { id: "not-owned" }, { kind: "like" }); assert.equal(posts(t).length, 0);
  const feed = t.state.socialLifeState("demo-a").data.feeds[0];
  await t.state.qzoneOperation("demo-a", "propose-interaction", feed, { kind: "comment", text: "合成评论" });
  assert.deepEqual(posts(t)[0].body, { expectedRevision: "r1", feedId: "host-feed-a", kind: "comment", content: "合成评论" });
  assert.equal(t.snapshot("demo-a").drafts[0].status, "draft");
});
await test("unsaved policy, config mismatch, consent cancellation and double click do not issue extra writes", async () => {
  const t = runtime(); allow(t); await t.state.loadQzoneSnapshot("demo-a"); t.edit("qzone.reads.own", false);
  await t.state.qzoneOperation("demo-a", "read-feeds"); assert.equal(posts(t).length, 0);
  t.state.registryDraft().dirty.clear(); t.hooks.confirm = false; await t.state.qzoneOperation("demo-a", "read-feeds"); assert.equal(posts(t).length, 0);
  t.hooks.confirm = true; const gate = deferred(); t.hooks.beforeOperation = () => gate.promise;
  const pending = t.state.qzoneOperation("demo-a", "read-feeds"); await until(() => posts(t).length === 1);
  await t.state.qzoneOperation("demo-a", "read-feeds"); gate.resolve(); await pending; assert.equal(posts(t).length, 1);
  t.state.registryState.revision = "r-other"; await t.state.qzoneOperation("demo-a", "read-feeds"); assert.equal(posts(t).length, 1);
});
await test("403/409/offline errors terminate loading, keep drafts and never replay uncertain mutations", async () => {
  for (const status of [403, 409, 503]) {
    const t = runtime(); t.edit("text", "待保留草稿"); t.hooks.snapshotStatus = status; await t.state.loadQzoneSnapshot("demo-a");
    assert.equal(t.state.socialLifeState("demo-a").loading, false); assert.match(t.host().textContent, /草稿保留/); assert.doesNotMatch(t.host().textContent, /PRIVATE_ERROR_SENTINEL/);
    assert.equal(t.nodes().find(n => n.dataset.qzoneEditor === "text").value, "待保留草稿");
  }
  const t = runtime(); allow(t); await t.state.loadQzoneSnapshot("demo-a"); t.edit("text", "待保留草稿"); t.hooks.postFailure = true;
  await t.state.qzoneOperation("demo-a", "create-draft"); assert.equal(t.state.socialLifeState("demo-a").busy, false);
  await t.state.qzoneOperation("demo-a", "create-draft"); assert.equal(posts(t).length, 1); assert.equal(t.state.socialLifeState("demo-a").editor.text, "待保留草稿");
});
await test("stopped account disables runtime actions, stale revisions hide private feeds, editor remains", async () => {
  const t = runtime(); allow(t); t.snapshot("demo-a").current = false; t.snapshot("demo-a").feeds = [{ id: "host-old", content: "OLD_PRIVATE_FEED" }];
  await t.state.loadQzoneSnapshot("demo-a"); t.edit("text", "离线保留草稿");
  assert.match(t.host().textContent, /停止、离线或载体已变化/);
  assert.equal(t.nodes().find(n => n.textContent === "创建本地草稿（不发布）").disabled, true);
  await t.state.qzoneOperation("demo-a", "read-feeds"); assert.equal(posts(t).length, 0);
  t.state.registryState.revision = "r2"; t.state.renderRegistryEditor(true);
  assert.doesNotMatch(t.host().textContent, /OLD_PRIVATE_FEED/); assert.equal(t.nodes().find(n => n.dataset.qzoneEditor === "text").value, "离线保留草稿");
});
await test("malformed and cross-account snapshots never unlock actions or replace compose drafts", async () => {
  for (const malformed of [{ ok: true }, { ok: true, revision: "r1", accountId: "demo-b", policy: {}, drafts: [], feeds: [] }]) {
    const t = runtime(); t.edit("text", "保留编辑"); t.hooks.snapshot = malformed; await t.state.loadQzoneSnapshot("demo-a");
    assert.equal(t.state.socialLifeState("demo-a").data, null); assert.equal(t.state.socialLifeState("demo-a").loading, false);
    await t.state.qzoneOperation("demo-a", "read-feeds"); assert.equal(posts(t).length, 0); assert.equal(t.state.socialLifeState("demo-a").editor.text, "保留编辑");
  }
});
await test("bounded request timeout ends spinner, retains compose and never retries uncertain POST", async () => {
  for (const mutation of [false, true]) {
    const t = runtime(); allow(t); if (mutation) await t.state.loadQzoneSnapshot("demo-a");
    t.edit("text", "超时保留编辑"); let expire;
    t.state.setTimeout = callback => { expire = callback; return 0; }; t.state.clearTimeout = () => {};
    const abortWait = signal => new Promise((_resolve, reject) => { if (signal.aborted) reject(new Error("aborted")); else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
    if (mutation) t.hooks.beforeOperation = abortWait; else t.hooks.beforeSnapshot = (_id, signal) => abortWait(signal);
    const pending = mutation ? t.state.qzoneOperation("demo-a", "create-draft") : t.state.loadQzoneSnapshot("demo-a");
    await until(() => typeof expire === "function"); expire(); await pending;
    const state = t.state.socialLifeState("demo-a"); assert.equal(state.loading, false); assert.equal(state.busy, false); assert.equal(state.editor.text, "超时保留编辑");
    if (mutation) { assert.equal(state.uncertain, true); await t.state.qzoneOperation("demo-a", "create-draft"); assert.equal(posts(t).length, 1); }
  }
});
await test("stalled admin-session bootstrap is bounded and cannot release a late action after timeout", async () => {
  for (const mutation of [false, true]) {
    const t = runtime(), gate = deferred(); let expire; allow(t);
    if (mutation) { t.state.socialLifeState("demo-a").data = structuredClone(t.snapshot("demo-a")); t.edit("text", "会话超时保留"); }
    t.hooks.beforeSession = () => gate.promise; t.state.setTimeout = callback => { expire = callback; return 0; }; t.state.clearTimeout = () => {};
    const pending = mutation ? t.state.qzoneOperation("demo-a", "create-draft") : t.state.loadQzoneSnapshot("demo-a");
    await until(() => t.requests.some(r => r.url === "/api/admin/session")); expire(); await pending;
    assert.equal(t.state.socialLifeState("demo-a").loading, false); assert.equal(t.state.socialLifeState("demo-a").busy, false);
    gate.resolve(); for (let n = 0; n < 30; n++) await Promise.resolve();
    assert.equal(t.requests.filter(r => r.url.endsWith("/qzone")).length, 0); assert.equal(posts(t).length, 0);
  }
});
await test("behavior preview uses only authenticated account GET; no composition/persona or task authority", async () => {
  const t = runtime(), host = new Element(); host.dataset.behaviorPreview = ""; host.dataset.accountId = "demo-a"; t.host().append(host);
  await t.state.loadBehaviorPreview("demo-a");
  const request = t.requests.find(r => r.url.endsWith("/behavior-preview")); assert.equal(request.method, "GET"); assert.equal(request.body, null); assert(request.token);
  assert.match(host.textContent, /组合 system：120/); assert.match(host.textContent, /双份估算 120/); assert.match(host.textContent, /明确请求/); assert.doesNotMatch(host.textContent, /PRIVATE_PERSONA_SENTINEL/);
  assert(!t.requests.some(r => /tasks/.test(r.url)));
  t.hooks.preview = { ok: true, accountId: "demo-b", chapters: ["PRIVATE_OTHER_ACCOUNT"] }; await t.state.loadBehaviorPreview("demo-a");
  assert.match(host.textContent, /账号不匹配/); assert.doesNotMatch(host.textContent, /PRIVATE_OTHER_ACCOUNT/);
});
await test("delayed preview cannot project another account; denied previews expose no raw error", async () => {
  const t = runtime(), gate = deferred(); t.hooks.beforePreview = () => gate.promise;
  const pending = t.state.loadBehaviorPreview("demo-a"); t.state.registrySelect("demo-b", "qzone"); gate.resolve(); await pending;
  assert.doesNotMatch(t.host().textContent, /组合 system|PRIVATE_PERSONA_SENTINEL/);
  assert.equal(t.state.socialLifeState("demo-b").preview, null);
  t.hooks.previewStatus = 403; await t.state.loadBehaviorPreview("demo-b");
  assert.equal(t.state.socialLifeState("demo-b").previewLoading, false); assert.match(t.state.socialLifeState("demo-b").previewError, /不可用/);
});

console.log(JSON.stringify({ ok: true, cases, offline: true, liveDataTouched: false, bridgeStarted: false }));
if (process.argv.includes("--preview")) {
  const css = fs.readFileSync(new URL("../public/console.css", import.meta.url), "utf8");
  const page = `<!doctype html><html lang="zh-CN" data-theme="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/console.css"><title>空间 · 隔离假数据预览</title><body><main style="max-width:1080px;margin:auto;padding:24px"><h1>账号功能 · 空间</h1><p>纯假数据 · 不连接真实 QQ、生产服务或模型。全部保存只在内存。</p><div class="row" style="flex-wrap:wrap"><button id="theme">明暗主题</button><button id="other">切换账号</button><button id="offline">模拟离线</button><button id="restore">恢复假服务</button><button id="behavior">行为预览</button></div><section class="card" id="dynamicAccountEditor"></section><p role="status" id="feedback"></p></main><script>
    const synthetic = (${fixture.toString()})(document, window);
    ${realSource}
    registryFeedback = text => document.getElementById('feedback').textContent = text;
    registrySelect('demo-a', 'qzone');
    document.getElementById('theme').addEventListener('click', () => document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    document.getElementById('other').addEventListener('click', () => registrySelect(registryState.selected === 'demo-a' ? 'demo-b' : 'demo-a', 'qzone'));
    document.getElementById('offline').addEventListener('click', () => { synthetic.hooks.snapshotStatus = 503; loadQzoneSnapshot(registryState.selected); });
    document.getElementById('restore').addEventListener('click', () => { synthetic.hooks.snapshotStatus = 0; loadQzoneSnapshot(registryState.selected); });
    document.getElementById('behavior').addEventListener('click', () => { const host = document.createElement('section'); host.className = 'settings-block'; host.dataset.behaviorPreview = ''; host.dataset.accountId = registryState.selected; document.getElementById('dynamicAccountEditor').append(host); loadBehaviorPreview(registryState.selected); });
  </script></body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url === "/console.css") { res.setHeader("content-type", "text/css"); res.end(css); }
    else if (req.url === "/") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(page); }
    else if (req.url === "/narrow") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>390px 隔离布局验收</title><body style="background:#151518;color:white"><p>390px 视口 · 仅假数据</p><iframe title="390px 空间面板" src="/" style="width:390px;height:900px;border:1px solid #555"></iframe></body></html>'); }
    else { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1", () => console.log(`Synthetic social life preview: http://127.0.0.1:${server.address().port}/`));
}
