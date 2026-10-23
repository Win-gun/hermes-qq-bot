#!/usr/bin/env node
// Synthetic, offline only. --preview serves the isolated UI on loopback; no user state.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import http from "node:http";

const html = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/console.css", import.meta.url), "utf8");
const marked = html.split("// SOCIAL_AGENT_UI_BEGIN")[1].split("// SOCIAL_AGENT_UI_END")[0];
const block = marked.slice(marked.indexOf("\n") + 1);
const apiSource = html.slice(html.indexOf("    async function api("), html.indexOf("    async function hostApi("));
const authSource = html.slice(html.indexOf('    let adminSessionToken = "";'), html.indexOf("    async function sensitiveApi("));
const malicious = '<img src=x onerror="throw 1">';
// This function is also embedded in the preview. Every endpoint is synthetic.
function fixture() {
  const servers = new Map(); const requests = [];
  const policy = () => ({ enabled: false, shadowMode: true, conversationIds: [], profile: {}, maxDailyCalls: 1000, maxToolCalls: 8, turnTimeoutMs: 60000, crossConversation: { enabled: false, groupIds: [], userIds: [] } });
  for (const id of ["demo-a", "demo-b"]) servers.set(id, { ok: true, revision: 1, policy: policy(), state: {
    conversations: [{ conversationId: "group:10001", mood: { valence: 0.2, arousal: 0.1, engagement: 0.5 }, unread: 3, readThroughSeq: 7, status: "failed", errorCode: "SOCIAL_MODEL_ONLY_TRANSPORT_UNAVAILABLE" }],
    relations: [{ userId: "20001", privateHistoryObserved: true, consentStatus: "本人已同意部分来源群（仍需管理员许可与好友确认）", consents: [{ sourceConversationId: "group:10001", allowed: true }, { sourceConversationId: "group:10002", allowed: false }] }],
    habits: [{ id: "habit-demo", conversationId: "group:10001", text: '<img src=x onerror="throw 1">', candidate: true, revokedAt: null, evidenceMessageIds: ["m1", "m2"] }],
    experiences: [{ id: "experience:group:10001:1", conversationId: "group:10001", userId: "20001", text: "虚构经历，尚未确认为事实", candidate: true, revokedAt: null, messageId: "message-demo", evidenceMessageIds: ["m1", "m2"] }, { id: "legacy-experience", conversationId: "group:10001", text: "旧条目来源缺失", candidate: false, revokedAt: null }],
    usage: { days: { "2030-01-01": { actualCalls: 3, reservedCalls: 4, unknownUsageCalls: 1, inputTokens: 100, outputTokens: 20, pending: { hidden: "never render" } } } },
    proposals: [{ id: "proposal-demo", text: "合成建议（不是已确认事实）" }]
  } });
  const plans = ["pending", "claimed", "paused", "completed", "failed", "expired", "superseded", "cancelled", "unknown"].map((status, index) => ({ id: `plan-demo-${index}`, accountId: "demo-a", sourceConversationId: "group:10001", targetConversationId: "private:20001", runAt: "2030-01-01T12:00:00Z", expiresAt: "2030-01-01T12:05:00Z", status, revision: 1 }));
  const state = { servers, requests, plans, status: 0, wait: null };
  state.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET"; requests.push({ url, method, opts });
    if (state.wait) { const wait = state.wait; state.wait = null; await wait; }
    const response = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (state.status) { const status = state.status; state.status = 0; return response({ ok: false, error: "synthetic_error" }, status); }
    if (url === "/api/admin/session") return response({ token: "synthetic-session" });
    if (opts.headers?.get("x-hermes-qq-admin") !== "synthetic-session") return response({ error: "auth_required" }, 403);
    if (url.startsWith("/api/social-agent/plans?")) return response({ ok: true, items: plans.filter(p => p.accountId === new URLSearchParams(url.split("?")[1]).get("account_id")) });
    if (url.endsWith("/cancel")) { const p = plans.find(item => url.includes(`/plans/${encodeURIComponent(item.id)}/`)); if (JSON.parse(opts.body).expectedRevision !== p.revision) return response({ error: "conflict" }, 409); p.status = "cancelled"; p.revision++; return response({ ok: true }); }
    const match = url.match(/^\/api\/social-agent\/accounts\/([^/]+)(.*)$/);
    if (!match || !servers.has(match[1])) throw new Error(`Unexpected synthetic URL: ${url}`);
    const server = servers.get(match[1]);
    if (method === "PATCH" || method === "POST") {
      const body = JSON.parse(opts.body);
      if (body.expectedRevision !== server.revision) return response({ error: "conflict" }, 409);
      if (match[2].endsWith("/revoke")) {
        const kind = match[2].split("/")[1];
        const item = server.state[kind]?.find(item => item.id === decodeURIComponent(match[2].split("/")[2]));
        if (!item) return response({ error: "missing" }, 404);
        item.revokedAt = 1;
      }
      else server.policy = body.policy;
      server.revision++;
    }
    return response(structuredClone(server));
  };
  return state;
}

if (process.argv.includes("--preview")) {
  const server = http.createServer((req, res) => {
    if (req.url === "/console.css") { res.setHeader("content-type", "text/css"); res.end(css); return; }
    if (req.url !== "/") { res.writeHead(404); res.end(); return; }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/console.css"><title>社交代理 · 离线合成预览</title><body><main style="max-width:1060px;margin:24px auto;padding:16px"><h1>社交代理 · 离线合成预览</h1><p>仅虚构账号和数据。无真实服务连接；所有保存/取消均为内存桩。观察 / 主动需明确选择会话并保存，不能把草稿视为已启用。</p><div id="preview-controls" class="row"></div>${["account-functions", "qa", "memory", "automation"].map(id => `<section id="page-${id}"></section>`).join("")}</main><script>
      const $ = id => document.getElementById(id);
      const registryState = { items: [{id:'demo-a',displayName:'合成账号 A'}, {id:'demo-b',displayName:'合成账号 B'}], contexts:{qa:'demo-a'} };
      const synthetic = (${fixture.toString()})(); const fetch = synthetic.fetch;
      function switchPage() {};
      ${apiSource}${authSource}${block}
      socialUi.mount(); socialUi.select('policy','demo-a'); socialUi.select('audit','demo-a'); socialUi.select('plans','demo-a');
      for (const [title, action] of [
        ['下一请求返回 500（合成）', () => { synthetic.status = 500; }],
        ['外部修订变化（合成 CAS 冲突）', () => { synthetic.servers.get('demo-a').revision++; }],
        ['切换明暗主题', () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; }]
      ]) { const el = document.createElement('button'); el.textContent = title; el.addEventListener('click', action); $('preview-controls').append(el); }
    </script></body></html>`);
  });
  const requestedPort = process.argv.includes("--port") ? Number(process.argv[process.argv.indexOf("--port") + 1]) : 0;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error("Invalid synthetic preview port");
  server.listen(requestedPort, "127.0.0.1", () => console.log(`Synthetic preview: http://127.0.0.1:${server.address().port}/ (Ctrl-C to stop)`));
} else {
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.value = ""; this.disabled = false; this.hidden = false; this._text = ""; this.dataset = {}; this.classes = new Set(); this.classList = { toggle: (key, value) => value ? this.classes.add(key) : this.classes.delete(key), add: key => this.classes.add(key) }; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    get firstChild() { return this.children[0] || null; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this._text = ""; this.children = children; }
    setAttribute(key, value) { this[key] = value; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    scrollIntoView() {}
    // Deliberately no innerHTML: dynamic HTML insertion fails the test.
    set innerHTML(_) { throw new Error("Unsafe HTML insertion"); }
  }
  const elements = new Map(["account-functions", "qa", "memory", "automation"].map(id => [`page-${id}`, new Element("section")]));
  const f = fixture(); const events = {};
  const context = vm.createContext({
    console, Headers, structuredClone, URLSearchParams,
    fetch: f.fetch, $: id => elements.get(id), confirm: () => true,
    registryState: { items: [{ id: "demo-a", displayName: malicious }, { id: "demo-b", displayName: "Demo B" }], contexts: { qa: "demo-a" } },
    document: { createElement: tag => new Element(tag) },
    window: { addEventListener: (type, fn) => events[type] = fn },
    switchPage() {}
  });
  vm.runInContext(`${apiSource}\n${authSource}\n${block}\nglobalThis.ui = socialUi;`, context);
  const ui = context.ui; ui.mount();
  const flatten = element => [element, ...element.children.flatMap(flatten)];
  const control = id => flatten(ui.views.policy.body).find(el => el.id === `social-${id}`);
  await ui.select("policy", "demo-a");
  assert.equal(ui.drafts.get("demo-a").policy.enabled, false);
  assert.equal(control("mode").value, "off");
  assert.match(ui.views.policy.status.textContent, /保存模式：关闭/);
  control("mode").value = "observe"; control("mode").listeners.change();
  assert.equal(ui.drafts.get("demo-a").policy.enabled, true);
  assert.equal(ui.drafts.get("demo-a").policy.shadowMode, true);
  assert.match(ui.views.policy.status.textContent, /保存模式：关闭/, "draft must not claim enabled");
  control("conversationIds").value = "group:10001"; control("conversationIds").listeners.input();
  await ui.save(); assert.match(ui.views.policy.status.textContent, /保存模式：观察/);
  control("mode").value = "active"; control("mode").listeners.change();
  assert.equal(ui.drafts.get("demo-a").policy.shadowMode, false);
  assert.match(ui.views.policy.status.textContent, /保存模式：观察/);
  await ui.save(); assert.match(ui.views.policy.status.textContent, /保存模式：主动/);
  // Reset the synthetic revision so subsequent CAS assertions remain explicit.
  f.servers.get("demo-a").revision = 1; ui.drafts.get("demo-a").revision = 1;
  await ui.select("policy", "demo-a");
  control("profile.identity").value = malicious; control("profile.identity").listeners.input();
  assert.equal(ui.drafts.get("demo-a").dirty, true);
  assert.equal(ui.hasDirty("account-functions"), true);
  assert.equal(ui.hasDirty("qa"), true);
  assert.equal(ui.hasDirty("qa:persona"), true);
  assert.equal(ui.hasDirty("voice"), false);
  const focusedControl = control("profile.identity");
  await ui.load("demo-a");
  assert.equal(control("profile.identity"), focusedControl, "refresh does not redraw focused draft");
  await ui.select("policy", "demo-b"); await ui.select("policy", "demo-a");
  assert.equal(control("profile.identity").value, malicious, "account draft retained");
  assert.equal(f.servers.get("demo-a").policy.profile.identity, undefined, "draft not auto-saved");
  let release; f.wait = new Promise(resolve => release = resolve);
  const pending = ui.load("demo-a"); await ui.select("policy", "demo-b"); release(); await pending;
  assert.equal(ui.views.policy.selected, "demo-b", "late response isolated");
  await ui.select("policy", "demo-a");
  f.servers.get("demo-a").revision++;
  await ui.save();
  assert.equal(ui.drafts.get("demo-a").conflict, true);
  assert.equal(ui.drafts.get("demo-a").dirty, true);
  const mutations = () => f.requests.filter(r => r.method !== "GET").length;
  const before = mutations(); await ui.save(); assert.equal(mutations(), before, "no conflict replay");
  await ui.load("demo-a"); assert.equal(ui.drafts.get("demo-a").remoteRevision, 2);
  ui.views.policy.rebase.listeners.click(); await ui.save();
  assert.equal(ui.drafts.get("demo-a").dirty, false);
  assert.equal(ui.hasDirty("account-functions"), false, "successful own save clears own marker");
  assert.equal(ui.hasDirty("qa"), false);
  assert.equal(f.servers.get("demo-a").policy.profile.identity, malicious);
  const patch = f.requests.findLast(r => r.method === "PATCH");
  assert.deepEqual(Object.keys(JSON.parse(patch.opts.body)).sort(), ["expectedRevision", "policy"]);
  assert.equal(patch.opts.headers.get("x-hermes-qq-admin"), "synthetic-session");
  assert.equal(patch.opts.headers.get("content-type"), "application/json");
  ui.edit("demo-a", "profile.expression", "draft after save");
  f.status = 403; await ui.save(); assert.equal(ui.drafts.get("demo-a").dirty, true);
  const after403 = mutations(); assert.equal(after403, before + 2, "403 mutation not replayed");
  await ui.load("demo-a"); assert.ok(f.requests.filter(r => r.url === "/api/admin/session").length >= 2, "403 session invalidated");
  f.status = 500; await ui.load("demo-a"); assert.match(ui.views.policy.status.textContent, /失败/);
  assert.equal(control("profile.expression").value, "draft after save");
  await ui.select("audit", "demo-a");
  assert.ok(ui.views.audit.body.textContent.includes(malicious));
  assert.ok(ui.views.audit.body.textContent.includes("只读"));
  assert.ok(!flatten(ui.views.audit.body).some(el => el.tagName === "IMG"));
  assert.match(ui.views.audit.body.textContent, /候选推断 · 非已确认事实/);
  assert.match(ui.views.audit.body.textContent, /proposal · 待核实/);
  assert.match(ui.views.audit.body.textContent, /确认状态未知 \/ unknown/);
  assert.match(ui.views.audit.sections.relations.textContent, /group:10002：未同意或已撤销/);
  assert.match(ui.views.audit.sections.relations.textContent, /已观察（不等于同意）/);
  assert.match(ui.views.audit.sections.conversations.textContent, /SOCIAL_MODEL_ONLY_TRANSPORT_UNAVAILABLE/);
  assert.match(ui.views.audit.sections.conversations.textContent, /未读：3 · 已读序号：7/);
  assert.match(ui.views.audit.usage.textContent, /已发起调用 3.*用量未知调用 1/);
  assert.match(ui.views.audit.usage.textContent, /输入 100 \/ 输出 20.*非完整账单/);
  assert.ok(!ui.views.audit.body.textContent.includes("never render"));
  const revoke = flatten(ui.views.audit.sections.habits).find(el => el.tagName === "BUTTON");
  await revoke.listeners.click(); assert.equal(f.servers.get("demo-a").state.habits[0].revokedAt, 1);
  assert.equal(ui.drafts.get("demo-a").dirty, true, "revocation retains policy draft");
  const experienceButtons = () => flatten(ui.views.audit.sections.experiences).filter(el => el.tagName === "BUTTON");
  assert.equal(experienceButtons()[1].disabled, true, "missing source cannot be revoked ambiguously");
  assert.match(ui.views.audit.sections.experiences.textContent, /message-demo、m1、m2/);
  const experienceRevision = ui.drafts.get("demo-a").stateRevision;
  await experienceButtons()[0].listeners.click();
  assert.equal(f.servers.get("demo-a").state.experiences[0].revokedAt, 1);
  const experienceRequest = f.requests.findLast(r => r.url.includes("/experiences/"));
  assert.equal(experienceRequest.url, "/api/social-agent/accounts/demo-a/experiences/experience%3Agroup%3A10001%3A1/revoke");
  assert.deepEqual(JSON.parse(experienceRequest.opts.body), { expectedRevision: experienceRevision });
  assert.equal(experienceRequest.opts.headers.get("x-hermes-qq-admin"), "synthetic-session");
  assert.match(ui.views.audit.sections.experiences.textContent, /已撤销/);
  assert.equal(ui.hasDirty("account-functions"), true, "experience revoke must not clear policy draft");
  f.servers.get("demo-a").state.experiences[0].revokedAt = null;
  await ui.load("demo-a");
  f.status = 409; const beforeExperienceConflict = mutations();
  const conflictRevoke = experienceButtons()[0]; await conflictRevoke.listeners.click();
  assert.equal(mutations(), beforeExperienceConflict + 1, "experience CAS failure has no replay");
  assert.equal(f.servers.get("demo-a").state.experiences[0].revokedAt, null);
  assert.equal(conflictRevoke.disabled, true, "uncertain or conflicting action requires explicit refresh");
  assert.match(ui.views.audit.status.textContent, /修订冲突/);
  assert.equal(ui.hasDirty("account-functions"), true);
  f.servers.get("demo-a").state.usage = { billing: "unknown" };
  f.servers.get("demo-a").state.conversations[0].errorCode = "SOCIAL_MODEL_ONLY_UNAVAILABLE";
  await ui.load("demo-a");
  assert.match(ui.views.audit.usage.textContent, /未知 \/ unknown.*不等于零/);
  assert.match(ui.views.audit.sections.conversations.textContent, /SOCIAL_MODEL_ONLY_UNAVAILABLE/);
  await ui.select("plans", "demo-a");
  const cancelButtons = () => flatten(ui.views.plans.body).filter(el => el.tagName === "BUTTON");
  assert.equal(cancelButtons().length, 3, "only pending/claimed/paused are cancellable");
  for (let index = 0; index < 3; index++) { await cancelButtons()[0].listeners.click(); assert.equal(f.plans[index].status, "cancelled"); }
  assert.equal(cancelButtons().length, 0);
  await ui.select("plans", "demo-b"); assert.match(ui.views.plans.body.textContent, /暂无/);
  f.status = 409; await ui.select("plans", "demo-a"); assert.match(ui.views.plans.status.textContent, /修订冲突/);
  assert.throws(() => ui.validate({ ...ui.drafts.get("demo-a").policy, enabled: true, conversationIds: [] }));
  assert.throws(() => ui.validate({ ...ui.drafts.get("demo-a").policy, conversationIds: ["all"] }));
  ui.validate({ ...ui.drafts.get("demo-a").policy, maxDailyCalls: 10000, maxToolCalls: 0, crossConversation: { enabled: false, groupIds: ["group:10001"], userIds: ["20001"] } });
  assert.throws(() => ui.validate({ ...ui.drafts.get("demo-a").policy, maxDailyCalls: 10001 }));
  assert.throws(() => ui.validate({ ...ui.drafts.get("demo-a").policy, crossConversation: { enabled: false, groupIds: ["10001"], userIds: [] } }));
  assert.ok(f.requests.every(r => r.url === "/api/admin/session" || r.url.startsWith("/api/social-agent/")), "no QQ/model/config actions");
  const event = { preventDefault() { this.prevented = true; } }; events.beforeunload(event); assert.ok(event.prevented);
  // Execute the actual existing marker renderers: social drafts OR into old
  // config/registry state without entering dirtyScopes or clearing old marks.
  for (const id of ["saveState", "saveBtn", "pageActionState", "dynamicAccountEditor"]) elements.set(id, new Element("div"));
  const nav = ["account-functions", "account-status", "qa", "voice"].map(page => { const el = new Element("button"); el.dataset.page = page; return el; });
  const personaTab = new Element("button"); personaTab.dataset.tab = "persona"; personaTab.closest = () => ({ dataset: { tabs: "qa" } }); nav.push(personaTab);
  context.document.querySelectorAll = selector => selector.includes("data-registry-edit-state") ? [] : selector.includes('data-page="account-functions"') ? nav.filter(el => ["account-functions", "account-status"].includes(el.dataset.page)) : nav;
  Object.assign(context, { cfg: {}, dirty: false, dirtyScopes: new Set(["voice:model"]), routineState: { dirty: false }, scopeNames: { "qa:persona": "问答风格", "voice:model": "原语音草稿" }, currentScope: () => "qa:persona", savingConfigScopes: new Set(), conflictedScopes: new Set(), scopeFeedback: new Map(), activePage: "qa", activeTabs: { qa: "persona" } });
  context.registryState.drafts = new Map();
  const markerSource = html.slice(html.indexOf("    function renderSaveState()"), html.indexOf("    function markDirty("));
  const registryMarkerSource = html.slice(html.indexOf("    function renderRegistrySaveState()"), html.indexOf("    function registryDraftStatus("));
  vm.runInContext(markerSource + registryMarkerSource, context);
  context.renderSaveState();
  assert.ok(nav[0].classes.has("has-unsaved"), "account-functions social mark");
  assert.ok(nav[2].classes.has("has-unsaved"), "QA role-card social mark");
  assert.ok(personaTab.classes.has("has-unsaved"), "QA persona tab social mark");
  assert.ok(nav[3].classes.has("has-unsaved"), "old voice draft marker retained");
  assert.deepEqual([...context.dirtyScopes], ["voice:model"], "social must not enter old config save scope");
  for (const draft of ui.drafts.values()) { draft.dirty = false; draft.profileDirty = false; }
  context.renderSaveState();
  assert.ok(!nav[0].classes.has("has-unsaved")); assert.ok(!nav[2].classes.has("has-unsaved"));
  assert.ok(nav[3].classes.has("has-unsaved"), "clearing social does not clear old voice mark");
  context.registryState.drafts.set("demo-a", { dirty: new Set(["style"]) });
  context.renderSaveState(); assert.ok(nav[0].classes.has("has-unsaved"), "old registry dirty marker retained");
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "");
  console.log("PASS social-agent UI: session fetch, drafts/refresh/races, CAS/errors, safe candidate/source/consent/usage audit, experience/habit revoke, pending/claimed/paused cancel, additive navigation dirty markers, no live actions");
}
