#!/usr/bin/env node
// Offline fixtures only; --preview serves synthetic HTML, never the bridge.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import http from "node:http";

const html = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/console.css", import.meta.url), "utf8");
const block = html.split("// SOCIAL_DISCOVERY_UI_BEGIN")[1].split("// SOCIAL_DISCOVERY_UI_END")[0];
const apiSource = html.slice(html.indexOf("    async function api("), html.indexOf("    async function hostApi("));
const authSource = html.slice(html.indexOf('    let adminSessionToken = "";'), html.indexOf("    async function sensitiveApi("));
const pages = ["automation", "qa", "memory", "api-center"];
function fixture() {
  const state = { servers: new Map(), requests: [], status: 0, patchStatus: 0, wait: null };
  for (const id of ["demo-a", "demo-b"]) state.servers.set(id, {
    ok: true, revision: "config:1-state:1", policy: { enabled: true, shadowMode: true, conversationIds: ["group:10001"], interests: [], humorPreference: "轻松", blockedTopics: [], maxRoundsPerDay: 4, minIntervalMs: 5400000, maxSearchesPerRound: 3, maxSharesPerDay: 2, shareCooldownMs: 10800000, futureField: "preserve" },
    status: { running: false, blockedReason: null, nextEligibleAt: "2030-01-01T12:00:00Z", today: { rounds: 1, searchRequests: 2, filterCalls: 1, unknownUsageCalls: 1, providerToolCalls: null, providerPageCalls: null }, activeItems: 1 },
    items: [{ id: "sample/1", title: '<img src=x onerror="throw 1">', status: "active", meaning: "合成素材，不是人物事实", applicable: ["轻松讨论"], avoid: ["敏感讨论"], sources: [{ url: "https://example.org/synthetic" }, { url: "javascript:alert(1)" }, { url: "https://user:password@example.org/" }] }], searchBinding: { provider: "合成搜索提供方", model: "synthetic-search", available: true, secret: "NEVER_RENDER" }
  });
  state.fetch = async (url, opts = {}) => {
    state.requests.push({ url, method: opts.method || "GET", opts });
    if (state.wait) { const wait = state.wait; state.wait = null; await wait; }
    const response = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (url === "/api/admin/session") return response({ token: "synthetic-session" });
    assert.equal(opts.headers?.get("x-hermes-qq-admin"), "synthetic-session");
    assert.equal(opts.cache, "no-store");
    if (state.status) { const status = state.status; state.status = 0; return response({ error: "synthetic_error", blockedReason: "working_time" }, status); }
    if (opts.method === "PATCH" && state.patchStatus) { const status = state.patchStatus; state.patchStatus = 0; return response({ error: "synthetic_conflict" }, status); }
    const match = url.match(/^\/api\/social-agent\/accounts\/([^/]+)\/discovery(.*)$/);
    assert.ok(match, `Unexpected URL: ${url}`); const server = state.servers.get(match[1]); assert.ok(server);
    if (opts.method === "PATCH" || opts.method === "POST") {
      const body = JSON.parse(opts.body); if (body.expectedRevision !== server.revision) return response({ error: "revision_conflict" }, 409);
      if (opts.method === "PATCH") { assert.equal(match[2], ""); server.policy = body.policy; }
      else if (match[2] === "/run") { if (!server.policy.enabled || server.status.blockedReason) return response({ error: "blocked", blockedReason: server.status.blockedReason || "disabled" }, 409); server.status.running = true; }
      else if (match[2] === "/cancel") { assert.deepEqual(Object.keys(body), ["expectedRevision"]); server.status.running = false; }
      else { assert.equal(match[2], "/items/sample%2F1/feedback"); assert.ok(["block", "delete", "expire"].includes(body.action)); server.items[0].status = body.action; }
      server.revision += "-next";
    }
    return response(structuredClone(server), match[2] === "/run" ? 202 : 200);
  }; return state;
}

if (process.argv.includes("--preview")) {
  const server = http.createServer((req, res) => {
    if (req.url === "/console.css") { res.setHeader("content-type", "text/css"); res.end(css); return; }
    if (req.url !== "/") { res.writeHead(404); res.end(); return; }
    res.setHeader("content-type", "text/html; charset=utf-8");
    // Browser fixture assertions replace node:assert without importing any runtime data.
    res.end(`<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/console.css"><title>网络发现 · 离线合成预览</title><body><main style="max-width:1060px;margin:24px auto;padding:16px"><h1>网络发现 · 离线合成预览</h1><p>仅虚构账号、内存 API。无 QQ、密钥或真实服务。</p>${pages.map(page => `<section id="page-${page}"></section>`).join("")}</main><script>
    const assert = { equal(a,b) { if(a!==b)throw Error('fixture mismatch') }, ok(v) { if(!v)throw Error('fixture mismatch') }, deepEqual(a,b) { if(JSON.stringify(a)!==JSON.stringify(b))throw Error('fixture mismatch') } };
    const $ = id => document.getElementById(id); const registryState = { items: [{id:'demo-a',displayName:'合成账号 A'}, {id:'demo-b',displayName:'合成账号 B'}] };
    function switchPage() {};
    const synthetic = (${fixture.toString()})(); const fetch = synthetic.fetch;
    ${apiSource}${authSource}${block}
    discoveryUi.mount(); Promise.all(${JSON.stringify(pages)}.map(page => discoveryUi.select(page,'demo-a')));
    </script></body></html>`);
  });
  const index = process.argv.indexOf("--port"), port = index < 0 ? 0 : Number(process.argv[index + 1]);
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535);
  server.listen(port, "127.0.0.1", () => console.log(`Synthetic discovery preview: http://127.0.0.1:${server.address().port}/`));
} else {
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.value = ""; this.type = ""; this.disabled = false; this.hidden = false; this.dataset = {}; this._text = ""; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this._text = ""; this.children = children; }
    setAttribute(k, v) { this[k] = v; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    set innerHTML(_) { throw new Error("Unsafe HTML insertion"); }
  }
  const elements = new Map(pages.map(page => [`page-${page}`, new Element("section")]));
  const f = fixture(), events = {}, registryState = { items: [{ id: "demo-a", displayName: "合成 A" }, { id: "demo-b", displayName: "合成 B" }] };
  let confirmations = true;
  const context = vm.createContext({ console, Headers, structuredClone, URL, Date, fetch: f.fetch, $: id => elements.get(id), registryState, document: { createElement: tag => new Element(tag) }, window: { addEventListener: (type, fn) => events[type] = fn }, confirm: () => confirmations, switchPage() {} });
  vm.runInContext(`${apiSource}${authSource}${block}\nglobalThis.ui = discoveryUi;`, context);
  const ui = context.ui; ui.mount();
  for (const kind of pages) await ui.select(kind, "demo-a");
  assert.match(ui.views.automation.host.textContent, /09:00–12:00、14:00–18:00/);
  assert.match(ui.views.automation.runtime.textContent, /提供方费用：未知/);
  assert.match(ui.views["api-center"].body.textContent, /非密钥测试结果/);
  assert.doesNotMatch(ui.views["api-center"].body.textContent, /NEVER_RENDER/);
  const flatten = el => [el, ...el.children.flatMap(flatten)];
  assert.deepEqual(flatten(ui.views.memory.body).filter(el => el.tagName === "A").map(el => el.href), ["https://example.org/synthetic"]);
  const input = (kind, key, value) => { const control = ui.views[kind].controls[key]; control.value = value; control.listeners.input(); };
  input("qa", "interests", "天文\n科技"); input("automation", "maxRoundsPerDay", "3");
  assert.equal(ui.hasDirty("qa"), true); assert.equal(ui.hasDirty("automation"), true);
  await ui.load("demo-a"); assert.equal(ui.views.qa.controls.interests.value, "天文\n科技");
  context.document.activeElement = ui.views.qa.controls.interests;
  await ui.select("qa", "demo-b"); assert.equal(ui.views.qa.controls.interests.value, "", "focused control must not leak prior account draft"); await ui.select("qa", "demo-a"); assert.equal(ui.views.qa.controls.interests.value, "天文\n科技");
  context.document.activeElement = null;
  f.servers.get("demo-a").policy.blockedTopics = ["远端新增"];
  await ui.save("automation");
  assert.deepEqual(f.servers.get("demo-a").policy.interests, []);
  assert.deepEqual(f.servers.get("demo-a").policy.blockedTopics, ["远端新增"]);
  assert.equal(f.servers.get("demo-a").policy.futureField, "preserve");
  assert.equal(ui.hasDirty("qa"), true); assert.equal(ui.hasDirty("automation"), false);
  await ui.save("qa"); assert.deepEqual(f.servers.get("demo-a").policy.interests, ["天文", "科技"]);
  input("qa", "humorPreference", "本地偏好"); f.servers.get("demo-a").policy.humorPreference = "远端偏好"; f.servers.get("demo-a").revision += "-outside";
  await ui.save("qa"); assert.equal(ui.drafts.get("demo-a").conflicts.qa, true);
  assert.equal(ui.views.qa.controls.humorPreference.value, "本地偏好");
  const mutations = () => f.requests.filter(r => r.method !== "GET").length;
  const before = mutations(); await ui.save("qa"); assert.equal(mutations(), before);
  await ui.load("demo-a"); ui.views.qa.rebase.listeners.click(); await ui.save("qa"); assert.equal(ui.hasDirty(), false);
  input("qa", "humorPreference", "CAS冲突草稿"); f.patchStatus = 409; await ui.save("qa"); assert.equal(ui.drafts.get("demo-a").conflicts.qa, true); assert.equal(ui.views.qa.controls.humorPreference.value, "CAS冲突草稿");
  await ui.load("demo-a"); ui.views.qa.rebase.listeners.click(); await ui.save("qa");
  f.status = 403; await ui.load("demo-a"); assert.match(ui.views.qa.status.textContent, /加载失败/); await ui.load("demo-a");
  input("qa", "interests", "保留草稿"); f.status = 500; await ui.load("demo-a"); assert.match(ui.views.qa.status.textContent, /加载失败/); assert.equal(ui.views.qa.controls.interests.value, "保留草稿");
  await ui.load("demo-a");
  f.servers.get("demo-a").status.blockedReason = "working_time"; await ui.load("demo-a"); assert.equal(ui.views.automation.run.disabled, true);
  await ui.action("automation", "/run"); assert.match(ui.views.automation.status.textContent, /working_time/); assert.equal(f.servers.get("demo-a").status.running, false);
  f.servers.get("demo-a").status.blockedReason = null; await ui.load("demo-a");
  await ui.action("automation", "/run"); assert.equal(ui.views.automation.cancel.disabled, false); await ui.action("automation", "/cancel"); assert.equal(f.servers.get("demo-a").status.running, false);
  const feedback = flatten(ui.views.memory.body).filter(el => el.tagName === "BUTTON"); confirmations = false; const count = mutations(); await feedback[0].listeners.click(); assert.equal(mutations(), count);
  confirmations = true; await feedback[0].listeners.click(); assert.equal(f.servers.get("demo-a").items[0].status, "block");
  for (const action of ["delete", "expire"]) await ui.action("memory", "/items/sample%2F1/feedback", { action });
  let release; f.wait = new Promise(resolve => release = resolve); const pending = ui.load("demo-a"); await Promise.resolve(); await ui.select("qa", "demo-b"); release(); await pending; assert.equal(ui.views.qa.selected, "demo-b");
  let prevented = false; events.beforeunload({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  registryState.items[0].archived = true; ui.sync(); assert.equal(ui.views.memory.selected, ""); assert.equal(ui.hasDirty(), true);
  assert.throws(() => ui.validate({ ...f.servers.get("demo-b").policy, conversationIds: ["private:1"] }), /群范围/);
  assert.ok(f.requests.every(r => r.url === "/api/admin/session" || r.url.startsWith("/api/social-agent/accounts/")), "No QQ or production endpoints");
  assert.ok(!block.includes("localStorage") && !block.includes("innerHTML") && !block.includes("onclick="));
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  console.log("social-discovery-ui-self-test: PASS (offline authenticated API, isolated drafts, merged CAS saves/conflicts, stale loads, errors, run/cancel, confirmations, safe rendering)");
}
