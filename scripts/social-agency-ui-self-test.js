// Offline VM/DOM fixtures only. No live service, real network, models or QQ.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
const marked = html.split("// SOCIAL_AGENT_UI_BEGIN")[1].split("// SOCIAL_AGENT_UI_END")[0];
const block = marked.slice(marked.indexOf("\n") + 1);
const api = html.slice(html.indexOf("    async function api("), html.indexOf("    async function hostApi("));
const auth = html.slice(html.indexOf('    let adminSessionToken = "";'), html.indexOf("    async function sensitiveApi("));
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.value = ""; this.disabled = false; this.hidden = false; this._text = ""; }
  detachChildren() { const active = this.ownerDocument?.activeElement; if (active && this.children.some(child => flatten(child).includes(active))) this.ownerDocument.activeElement = null; }
  set textContent(value) { this.detachChildren(); this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  get firstChild() { return this.children[0] || null; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.detachChildren(); this._text = ""; this.children = children; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(key, fn) { this.listeners[key] = fn; }
  scrollIntoView() {}
  focus() { this.ownerDocument.activeElement = this; }
  set innerHTML(_) { throw new Error("Unsafe HTML insertion"); }
}
const flatten = node => [node, ...node.children.flatMap(flatten)];
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await Promise.resolve(); } throw new Error("Synthetic wait exhausted"); }
function fixture() {
  const requests = [], hooks = {}, timers = new Map(), confirms = [], servers = new Map(); let serial = 0;
  const policy = () => ({ enabled: false, shadowMode: true, conversationIds: ["group:100", "group:101", "private:200"],
    profile: { identity: "STATIC" }, roleCard: { enabled: true, autoGrow: false, maxVersions: 32, minUpdateIntervalMs: 86400000 },
    discovery: { enabled: false, interests: ["KEEP-DISCOVERY"] }, maxDailyCalls: 1000, maxToolCalls: 8, turnTimeoutMs: 60000,
    crossConversation: { enabled: false, groupIds: [], userIds: [] } });
  for (const id of ["alpha", "beta"]) servers.set(id, { policy: policy(), policyVersion: 1, preferenceRevision: 2, growthFrozen: false,
    card: { revision: 2, fields: { expression: `新表达-${id}`, interests: "天文" }, versions: [
      { revision: 1, fields: { expression: `旧表达-${id}`, interests: "天文" } },
      { revision: 2, fields: { expression: `新表达-${id}`, interests: "天文" } }] }, cancelled: false });
  const registry = { selected: "alpha", revision: "config-1", epoch: 0, contexts: { qa: "alpha" }, drafts: new Map(), items: [...servers.keys()].map(id => ({ id })) };
  const pages = new Map(["account-functions", "qa", "memory", "automation"].map(id => [`page-${id}`, new Element("section")]));
  const socialRevision = id => `social-${id}-${servers.get(id).policyVersion}`;
  function view(id, group, userId = "") {
    const s = servers.get(id);
    const preference = (kind, status = "candidate") => ({ id: `${kind}-${id}`, kind, dimension: "interest", status,
      value: kind === "group" ? '<img src=x onerror="throw 1">' : `天文-${id}`, userId: kind === "member" ? userId : null,
      conversationId: kind === "self" ? null : group, sourceType: "synthetic-public", confidence: 0.5,
      evidence: [{ messageId: `evidence-${id}`, conversationId: "group:100", sentAt: 1000, polarity: "positive" }],
      tombstone: null, feedback: { negativeEvidenceIds: [], correctionEvidenceIds: [] }, expiresAt: 1000,
      privateTrace: "PRIVATE_SENTINEL" });
    const preferences = [preference("self"), ...(group ? [preference("group"), ...(userId ? [preference("member")] : []), preference("group", "rejected")] : [])];
    preferences.at(-1).id += "-last";
    if (s.expired) {
      const entry = preferences.find(e => e.kind === (s.expiredKind || "self"));
      if (entry) { entry.status = "expired"; entry.tombstone = s.tombstone || null; }
    }
    return { ok: true, revision: registry.revision, policy: s.policy.agency || { enabled: false, publicDrafts: false },
      preferenceRevision: s.preferenceRevision, growthFrozen: s.growthFrozen, preferences,
      conversations: ["group:100", "group:101"], card: structuredClone(s.card),
      journal: group ? { revision: s.cancelled ? 4 : 3, entries: [{ id: `intent-${id}`, kind: "opinion", conversationId: group,
        status: s.cancelled ? "abandoned" : "pending", summary: `待表达-${id}`, privateTrace: "PRIVATE_SENTINEL" }] } : null };
  }
  const response = (value, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(value) });
  const fetch = async (path, opts = {}) => {
    assert.equal(opts.signal?.aborted === true, false, "aborted request must not start transport");
    const method = opts.method || "GET", body = opts.body ? JSON.parse(opts.body) : null;
    requests.push({ path, method, body, signal: opts.signal });
    if (path === "/api/admin/session") { await hooks.auth?.(); return response({ token: "synthetic-session" }); }
    assert.equal(opts.headers.get("x-hermes-qq-admin"), "synthetic-session");
    assert.equal(opts.cache, "no-store"); assert.equal(opts.credentials, "same-origin"); assert.equal(opts.redirect, "error");
    const url = new URL(path, "https://offline.invalid"), match = url.pathname.match(/^\/api\/social-agent\/accounts\/([^/]+)(.*)$/);
    assert.ok(match); const id = decodeURIComponent(match[1]), s = servers.get(id); assert.ok(s);
    if (!match[2]) {
      await hooks.policy?.(method, id, opts.signal);
      if (hooks.policyStatus) return response({ error: "PRIVATE_SENTINEL" }, hooks.policyStatus);
      if (method === "PATCH") { assert.equal(body.expectedRevision, socialRevision(id)); s.policy = structuredClone(body.policy); s.policyVersion++; }
      return response({ ok: true, revision: socialRevision(id), policy: structuredClone(s.policy), state: {} });
    }
    assert.match(match[2], /^\/agency(?:\/(?:freeze|review|reconfirm|cancel-intent|rollback))?$/);
    const group = url.searchParams.get("conversation_id") || ""; assert.ok(!group || s.policy.conversationIds.includes(group));
    const userId = url.searchParams.get("user_id") || ""; assert.ok(!userId || group && /^[1-9]\d{0,19}$/.test(userId));
    await hooks.agency?.(method, id, path, opts.signal);
    if (hooks.offline) throw new Error("PRIVATE_SENTINEL");
    if (hooks.status) return response({ error: "PRIVATE_SENTINEL" }, hooks.status);
    if (method === "POST") {
      assert.equal(opts.headers.get("content-type"), "application/json");
      assert.equal(body.expectedRevision, registry.revision); assert.equal(body.preferenceRevision, s.preferenceRevision);
      const op = match[2].split("/")[2];
      if (op === "freeze") { assert.equal(typeof body.frozen, "boolean"); s.growthFrozen = body.frozen; s.preferenceRevision++; }
      if (op === "review") { assert.ok(body.id); s.preferenceRevision++; }
      if (op === "reconfirm") {
        assert.ok(group); assert.ok(s.expired && !s.tombstone); assert.ok(body.evidenceMessageIds.length);
        assert.equal(Object.hasOwn(body, "compatibility"), false); assert.equal(Object.hasOwn(body, "userId"), false);
        s.preferenceRevision++; s.expired = false;
      }
      if (op === "cancel-intent") { assert.equal(body.journalRevision, s.cancelled ? 4 : 3); assert.ok(group); s.cancelled = true; }
      if (op === "rollback") {
        assert.equal(body.cardRevision, s.card.revision); const target = s.card.versions.find(v => v.revision === body.targetRevision); assert.ok(target);
        s.card = { revision: s.card.revision + 1, fields: structuredClone(target.fields), versions: [...s.card.versions,
          { revision: s.card.revision + 1, fields: structuredClone(target.fields) }] };
      }
    }
    return response(hooks.result || view(id, group, userId));
  };
  const document = { activeElement: null, documentElement: { dataset: { theme: "light" } },
    createElement: tag => { const el = new Element(tag); el.ownerDocument = document; return el; } };
  const context = vm.createContext({ Headers, AbortController, structuredClone, console, fetch, registryState: registry,
    document, $: id => pages.get(id), window: { addEventListener() {} }, switchPage() {},
    confirm: text => { confirms.push(text); return hooks.confirm !== false; },
    setTimeout: (fn, ms) => { assert.ok([20000, 65000].includes(ms)); timers.set(++serial, fn); return serial; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(`${api}${auth}${block}\nglobalThis.ui = socialUi;`, context);
  const ui = context.ui; ui.mount();
  const t = { ui, registry, requests, hooks, servers, timers, confirms, view, document,
    resetAuth: () => vm.runInContext('adminSessionToken = "";', context),
    reads: () => requests.filter(r => /\/agency(?:\?|$)/.test(r.path)), posts: () => requests.filter(r => r.method === "POST"),
    qa: id => { registry.contexts.qa = id; ui.sync(); },
    refresh: () => ui.views.qa.agencyRefresh.listeners.click(),
    scope: value => { ui.views.qa.agencyScope.value = value; ui.views.qa.agencyScope.listeners.change(); },
    member: value => { ui.views.qa.agencyMember.value = value; ui.views.qa.agencyMember.listeners.input(); },
    evidence: value => { const input = flatten(t.body()).find(e => e.tagName === "TEXTAREA" && e.id?.startsWith("social-agency-evidence-")); assert.ok(input); input.value = value; input.listeners.input(); },
    body: () => ui.views.qa.agencyBody,
    buttons: text => flatten(ui.views.qa.agencyBody).filter(e => e.tagName === "BUTTON" && e.textContent.includes(text)),
    button: text => { const control = t.buttons(text)[0]; assert.ok(control, text); return control; },
    click: text => t.button(text).listeners.click(),
    policyControl: path => flatten(ui.views.policy.body).find(e => e.id === `social-${path}`),
    edit: (path, value) => { const control = t.policyControl(path); assert.ok(control); if (control.type === "checkbox") { control.checked = value; control.listeners.change(); } else { control.value = value; control.listeners.input(); } },
    compatible: () => { const control = flatten(t.body()).find(e => e.tagName === "INPUT" && e.type === "checkbox"); assert.ok(control); control.checked = true; control.listeners.change(); },
    compare: value => { const control = flatten(t.body()).find(e => e.id === "social-agency-card-version"); assert.ok(control); control.value = String(value); control.listeners.change(); }
  };
  return t;
}
async function ready(group = "") { const t = fixture(); await t.ui.select("policy", "alpha"); if (group) t.scope(group); await t.refresh(); return t; }
let tests = 0;
async function test(name, run) { try { await run(); tests++; } catch (cause) { throw new Error(name, { cause }); } }

await test("unchanged sync/theme polls preserve controls, options, expanded details and textarea focus/caret", async () => {
  const t = await ready("group:100"); t.servers.get("alpha").expired = true; await t.refresh(); t.evidence("manually-entered-source");
  const input = flatten(t.body()).find(e => e.tagName === "TEXTAREA"), freeze = t.button("冻结自动成长"), reconfirm = t.button("基于新证据重新确认");
  const details = flatten(t.body()).filter(e => e.tagName === "DETAILS"), options = [...t.ui.views.qa.agencyScope.children];
  details.forEach((el, i) => { el.open = i !== 0; }); t.ui.views.qa.agency.open = true;
  input.focus(); input.selectionStart = 4; input.selectionEnd = 10; input.scrollTop = 23;
  const requests = t.requests.length;
  for (let i = 0; i < 5; i++) { t.document.documentElement.dataset.theme = i % 2 ? "light" : "dark"; t.ui.sync(); }
  assert.equal(t.button("冻结自动成长"), freeze); assert.equal(t.button("基于新证据重新确认"), reconfirm);
  assert.equal(flatten(t.body()).find(e => e.tagName === "TEXTAREA"), input);
  assert.equal(t.document.activeElement, input); assert.equal(input.selectionStart, 4); assert.equal(input.selectionEnd, 10); assert.equal(input.scrollTop, 23);
  details.forEach((el, i) => { assert.ok(flatten(t.body()).includes(el)); assert.equal(el.open, i !== 0); });
  options.forEach((el, i) => assert.equal(t.ui.views.qa.agencyScope.children[i], el));
  assert.equal(t.ui.views.qa.agency.open, true); assert.equal(t.requests.length, requests);
});
await test("permission changes rerender disabled controls and permanently invalidate former handlers", async () => {
  const t = await ready(), old = t.button("冻结自动成长"); t.registry.busy = true; t.ui.sync();
  assert.notEqual(t.button("冻结自动成长"), old); assert.equal(t.button("冻结自动成长").disabled, true);
  await old.listeners.click(); assert.equal(t.posts().length, 0);
  t.registry.busy = false; t.ui.sync(); assert.equal(t.button("冻结自动成长").disabled, false);
  await old.listeners.click(); assert.equal(t.posts().length, 0, "restoring permission must not revive detached callbacks");
});
await test("polls preserve explicit compatibility choice while compare changes still update rollback permissions", async () => {
  const t = await ready(); t.compatible(); const approve = t.button("批准偏好"), check = flatten(t.body()).find(e => e.tagName === "INPUT");
  for (let i = 0; i < 3; i++) t.ui.sync();
  assert.equal(t.button("批准偏好"), approve); assert.equal(approve.disabled, false); assert.equal(check.checked, true);
  const rollback = t.button("追加回滚到"); t.compare(2);
  assert.notEqual(t.button("追加回滚到"), rollback); assert.equal(t.button("追加回滚到").disabled, true);
  await rollback.listeners.click(); assert.equal(t.posts().length, 0);
});
await test("permission revocation invalidates old evidence-input handlers even after access returns", async () => {
  const t = await ready("group:100"); t.servers.get("alpha").expired = true; await t.refresh(); t.evidence("keep-manual-evidence");
  const old = flatten(t.body()).find(e => e.tagName === "TEXTAREA"); t.registry.busy = true; t.ui.sync(); t.registry.busy = false; t.ui.sync();
  old.value = "detached-input-injection"; old.listeners.input(); t.ui.sync();
  assert.equal(flatten(t.body()).find(e => e.tagName === "TEXTAREA").value, "keep-manual-evidence");
  await t.refresh(); assert.equal(flatten(t.body()).find(e => e.tagName === "TEXTAREA").value, "keep-manual-evidence");
});

await test("first QA visit to unloaded beta has an explicit GET-only policy bootstrap", async () => {
  const t = await ready(), before = t.requests.length; t.qa("beta");
  assert.equal(t.requests.length, before, "selection and render must not auto-load management data");
  assert.equal(t.ui.drafts.get("beta")?.revision == null, true);
  assert.equal(t.ui.views.qa.agencyRefresh.disabled, false, "unloaded account must have a usable refresh entry");
  assert.match(t.ui.views.qa.agencyRefresh.textContent, /加载策略/);
  await t.refresh();
  assert.deepEqual(t.requests.slice(before).map(r => [r.method, r.path]), [
    ["GET", "/api/social-agent/accounts/beta"], ["GET", "/api/social-agent/accounts/beta/agency"]]);
  assert.equal(t.posts().length, 0); assert.equal(t.ui.drafts.get("beta").revision, "social-beta-1");
  assert.match(t.body().textContent, /天文-beta/); assert.equal(t.button("冻结自动成长").disabled, false);
});
await test("bootstrap selection switch aborts and prevents late policy/agency publication", async () => {
  const t = await ready(); t.qa("beta"); const gate = deferred(); t.hooks.policy = (_method, id) => id === "beta" ? gate.promise : undefined;
  const pending = t.refresh(); await until(() => t.requests.at(-1).path === "/api/social-agent/accounts/beta");
  const signal = t.requests.at(-1).signal; t.qa("alpha"); assert.equal(signal.aborted, true); gate.resolve(); await pending;
  assert.equal(t.ui.drafts.get("beta").revision, null); assert.equal(t.ui.drafts.get("beta").loading, null);
  assert.equal(t.requests.some(r => r.path.endsWith("beta/agency")), false); assert.ok(!t.body().textContent.includes("天文-beta"));
});
await test("bootstrap fences new local drafts, registry conflicts and CAS changes before adopting policy", async () => {
  for (const kind of ["dirty", "registry-dirty", "registry-conflict", "epoch", "cas"]) {
    const t = await ready(); t.qa("beta"); const gate = deferred(); t.hooks.policy = (_method, id) => id === "beta" ? gate.promise : undefined;
    const pending = t.refresh(); await until(() => t.requests.at(-1).path === "/api/social-agent/accounts/beta");
    if (kind === "dirty") t.ui.edit("beta", "profile.identity", "BOOTSTRAP-KEEP");
    if (kind === "registry-dirty") t.registry.drafts.set("beta", { dirty: new Set(["name"]), conflict: false });
    if (kind === "registry-conflict") t.registry.drafts.set("beta", { dirty: new Set(), conflict: true });
    if (kind === "epoch") t.registry.epoch++;
    if (kind === "cas") t.registry.revision = "new-config";
    gate.resolve(); await pending; assert.equal(t.ui.drafts.get("beta").revision, null);
    assert.equal(t.requests.some(r => r.path.endsWith("beta/agency")), false); assert.equal(t.posts().length, 0);
    if (kind === "dirty") assert.equal(t.ui.drafts.get("beta").policy.profile.identity, "BOOTSTRAP-KEEP");
  }
});
await test("failed bootstrap has manual retry and never starts an agency GET or POST", async () => {
  const t = await ready(); t.qa("beta"); t.hooks.policyStatus = 503; await t.refresh();
  assert.equal(t.ui.drafts.get("beta").revision, null); assert.match(t.ui.views.qa.agencyStatus.textContent, /失败|未确认/);
  assert.equal(t.ui.views.qa.agencyRefresh.disabled, false); assert.equal(t.requests.some(r => r.path.endsWith("beta/agency")), false);
  delete t.hooks.policyStatus; await t.refresh(); assert.match(t.body().textContent, /天文-beta/); assert.equal(t.posts().length, 0);
});
await test("bootstrap timeout clears its loading ticket; late policy cannot overwrite explicit retry", async () => {
  const t = await ready(); t.qa("beta"); const gate = deferred(); t.hooks.policy = (_method, id) => id === "beta" ? gate.promise : undefined;
  const pending = t.refresh(); await until(() => t.requests.at(-1).path === "/api/social-agent/accounts/beta" && t.timers.size === 1);
  const signal = t.requests.at(-1).signal; [...t.timers.values()][0](); await pending;
  assert.equal(signal.aborted, true); assert.equal(t.ui.drafts.get("beta").loading, null); assert.equal(t.ui.views.qa.agencyRefresh.disabled, false);
  delete t.hooks.policy; await t.refresh(); const revision = t.ui.drafts.get("beta").revision;
  gate.resolve(); await Promise.resolve(); assert.equal(t.ui.drafts.get("beta").revision, revision);
  assert.match(t.body().textContent, /天文-beta/); assert.equal(t.posts().length, 0);
});
await test("bootstrapping beta preserves alpha's unsaved policy and role-card topic", async () => {
  const t = await ready(); t.edit("profile.identity", "ALPHA-KEEP"); t.edit("agency.publicDrafts", true);
  t.ui.views.qa.topic.value = "ALPHA-TOPIC"; t.ui.views.qa.topic.listeners.input();
  t.qa("beta"); await t.refresh(); assert.match(t.body().textContent, /天文-beta/);
  assert.equal(t.ui.drafts.get("alpha").dirty, true); assert.equal(t.ui.drafts.get("alpha").policy.profile.identity, "ALPHA-KEEP");
  assert.equal(t.ui.drafts.get("alpha").policy.agency.publicDrafts, true); t.qa("alpha");
  assert.equal(t.ui.views.qa.topic.value, "ALPHA-TOPIC"); assert.equal(t.posts().length, 0);
});

await test("legacy defaults are false and scoped whole-policy save preserves existing fields", async () => {
  const t = fixture(); await t.ui.select("policy", "alpha");
  assert.equal(t.policyControl("agency.enabled").checked, false); assert.equal(t.policyControl("agency.publicDrafts").checked, false);
  t.edit("agency.enabled", true); t.edit("agency.publicDrafts", true);
  await t.ui.select("policy", "beta"); t.edit("profile.identity", "B-KEEP"); await t.ui.select("policy", "alpha");
  assert.equal(t.policyControl("agency.enabled").checked, true); await t.ui.load("alpha"); assert.equal(t.policyControl("agency.publicDrafts").checked, true);
  await t.ui.save(); const patch = t.requests.find(r => r.method === "PATCH");
  assert.deepEqual(plain(patch.body.policy.agency), { enabled: true, publicDrafts: true });
  assert.deepEqual(patch.body.policy.discovery, { enabled: false, interests: ["KEEP-DISCOVERY"] });
  assert.equal(patch.body.policy.roleCard.maxVersions, 32); assert.equal(patch.body.policy.profile.identity, "STATIC");
  assert.equal(t.ui.drafts.get("beta").policy.profile.identity, "B-KEEP");
});
await test("management mounts collapsed inside existing role card without automatic GET", async () => {
  const t = fixture(); assert.notEqual(t.ui.views.qa.agency.open, true); assert.ok(t.ui.views.qa.role.children.includes(t.ui.views.qa.agency));
  await t.ui.select("policy", "alpha"); t.ui.sync(); t.ui.sync(); assert.equal(t.reads().length, 0);
  assert.match(t.ui.views.qa.agency.textContent, /不调用模型/); assert.match(t.ui.views.policy.body.textContent, /不授予发表/);
});
await test("explicit read shows scoped pointers/status but never inserts HTML or raw traces", async () => {
  const t = await ready("group:100"); assert.equal(t.reads().length, 1); assert.equal(t.posts().length, 0);
  assert.match(t.body().textContent, /Self.*Group.*Member/s); assert.match(t.body().textContent, /evidence-alpha/);
  assert.match(t.body().textContent, /<img src=x/); assert.ok(!flatten(t.body()).some(e => e.tagName === "IMG"));
  assert.ok(!t.body().textContent.includes("PRIVATE_SENTINEL")); assert.match(t.body().textContent, /pending不是任务|pending不代表/);
});
await test("scope picker excludes private/unconfigured groups and never auto-fetches on change", async () => {
  const t = await ready(); const opts = t.ui.views.qa.agencyScope.children.map(e => e.value);
  assert.deepEqual(opts, ["", "group:100", "group:101"]); t.scope("group:100"); assert.equal(t.reads().length, 1);
  assert.equal(t.body().children.length, 0); await t.refresh(); assert.match(t.reads().at(-1).path, /agency\?conversation_id=group%3A100$/);
  t.scope("group:999"); await t.refresh(); assert.ok(!t.reads().at(-1).path.includes("999"));
});
await test("freeze and unfreeze send config CAS plus preference revision, no automatic GET", async () => {
  const t = await ready(); await t.click("冻结自动成长");
  assert.deepEqual(t.posts()[0].body, { expectedRevision: "config-1", preferenceRevision: 2, frozen: true });
  assert.equal(t.reads().length, 1); assert.match(t.ui.views.qa.agencyStatus.textContent, /成长已冻结/);
  await t.click("解除成长冻结"); assert.equal(t.posts()[1].body.preferenceRevision, 3); assert.equal(t.posts()[1].body.frozen, false);
});
await test("self approval requires explicit compatibility checkbox and confirmation", async () => {
  const t = await ready(); assert.equal(t.button("批准偏好").disabled, true); await t.click("批准偏好"); assert.equal(t.posts().length, 0);
  t.compatible(); assert.equal(t.button("批准偏好").disabled, false); await t.click("批准偏好");
  assert.equal(t.posts()[0].body.compatibility, "compatible"); assert.match(t.confirms.at(-1), /明确确认.*兼容/);
  assert.equal(t.button("批准偏好").disabled, true, "fresh evidence revision requires fresh compatibility confirmation");
});
await test("group approval and rejection do not send compatibility authority", async () => {
  const t = await ready("group:100"); await t.buttons("批准偏好")[1].listeners.click();
  assert.equal(Object.hasOwn(t.posts()[0].body, "compatibility"), false);
  await t.buttons("拒绝偏好")[0].listeners.click(); assert.equal(t.posts()[1].body.action, "reject");
  assert.equal(Object.hasOwn(t.posts()[1].body, "compatibility"), false);
});
await test("expiry review uses its exact action and terminal preferences are disabled", async () => {
  const t = await ready("group:100"); assert.equal(t.buttons("批准偏好").at(-1).disabled, true);
  assert.equal(t.buttons("拒绝偏好").at(-1).disabled, true); assert.equal(t.buttons("标记过期").at(-1).disabled, true);
  await t.buttons("标记过期")[0].listeners.click(); assert.equal(t.posts()[0].body.action, "expire");
});
await test("cancel-intent keeps query at URL end and uses journal CAS", async () => {
  const t = await ready("group:100"); await t.click("取消此想法");
  assert.match(t.posts()[0].path, /agency\/cancel-intent\?conversation_id=group%3A100$/);
  assert.deepEqual(t.posts()[0].body, { expectedRevision: "config-1", preferenceRevision: 2, id: "intent-alpha", journalRevision: 3 });
  assert.equal(t.button("取消此想法").disabled, true); assert.match(t.body().textContent, /abandoned/);
});
await test("card comparison and rollback preserve history using card CAS", async () => {
  const t = await ready("group:101"); assert.match(t.body().textContent, /旧表达-alpha/); assert.match(t.body().textContent, /新表达-alpha/);
  await t.click("追加回滚到"); assert.match(t.posts()[0].path, /agency\/rollback\?conversation_id=group%3A101$/);
  assert.deepEqual(t.posts()[0].body, { expectedRevision: "config-1", preferenceRevision: 2, targetRevision: 1, cardRevision: 2 });
  assert.equal(t.servers.get("alpha").card.versions.length, 3);
});
await test("choosing the current card version cannot roll it back again", async () => {
  const t = await ready(); t.compare(2); assert.equal(t.button("追加回滚到").disabled, true); await t.click("追加回滚到"); assert.equal(t.posts().length, 0);
});
await test("dirty social policy disables mutations and explicit reads preserve all drafts", async () => {
  const t = await ready(); t.edit("profile.identity", "KEEP-LOCAL"); t.edit("agency.publicDrafts", true);
  assert.equal(t.button("冻结自动成长").disabled, true); await t.click("冻结自动成长"); assert.equal(t.posts().length, 0);
  await t.refresh(); assert.equal(t.ui.drafts.get("alpha").policy.profile.identity, "KEEP-LOCAL");
  assert.equal(t.ui.drafts.get("alpha").policy.agency.publicDrafts, true); assert.equal(t.ui.drafts.get("alpha").dirty, true);
});
await test("registry dirty/conflict and social conflict block all management writes", async () => {
  for (const kind of ["registry-dirty", "registry-conflict", "social-conflict"]) {
    const t = await ready();
    if (kind === "social-conflict") t.ui.drafts.get("alpha").conflict = true;
    else t.registry.drafts.set("alpha", { dirty: new Set(kind === "registry-dirty" ? ["name"] : []), conflict: kind === "registry-conflict" });
    t.ui.sync(); assert.equal(t.button("冻结自动成长").disabled, true); await t.click("冻结自动成长"); assert.equal(t.posts().length, 0);
  }
});
await test("known config CAS drift invalidates mutation without overwriting policy", async () => {
  const t = await ready(); t.registry.revision = "config-2"; t.ui.sync();
  assert.equal(t.button("冻结自动成长").disabled, true); await t.click("冻结自动成长"); assert.equal(t.posts().length, 0);
  await t.refresh(); await t.click("冻结自动成长"); assert.equal(t.posts()[0].body.expectedRevision, "config-2");
});
await test("policy reload invalidates old API snapshots even if CAS text is unchanged", async () => {
  const t = await ready(); await t.ui.load("alpha"); assert.equal(t.button("冻结自动成长").disabled, true);
  await t.click("冻结自动成长"); assert.equal(t.posts().length, 0); await t.refresh(); assert.equal(t.button("冻结自动成长").disabled, false);
});
await test("late other-account GET is aborted and cannot render or cache across A-B-A", async () => {
  const t = await ready(); const gate = deferred(); t.hooks.agency = () => gate.promise;
  const pending = t.refresh(); await until(() => t.reads().length === 2); const signal = t.reads().at(-1).signal;
  t.qa("beta"); await t.ui.load("beta"); assert.equal(signal.aborted, true); assert.ok(!t.body().textContent.includes("天文-alpha"));
  t.qa("alpha"); gate.resolve(); await pending; assert.match(t.ui.views.qa.agencyStatus.textContent, /未确认/);
  assert.equal(t.button("冻结自动成长").disabled, true); delete t.hooks.agency; await t.refresh(); assert.equal(t.button("冻结自动成长").disabled, false);
});
await test("late mutation response never renders into another selected account or retries", async () => {
  const t = await ready(); const gate = deferred(); t.hooks.agency = method => method === "POST" ? gate.promise : undefined;
  const pending = t.click("冻结自动成长"); await until(() => t.posts().length === 1); t.qa("beta"); await t.ui.load("beta");
  gate.resolve(); await pending; assert.equal(t.posts().length, 1); assert.ok(!t.body().textContent.includes("alpha"));
  t.qa("alpha"); assert.equal(t.button("冻结自动成长").disabled, true);
});
await test("selection during auth bootstrap prevents a late POST from starting", async () => {
  const t = await ready(); t.resetAuth(); const gate = deferred(); t.hooks.auth = () => gate.promise;
  const pending = t.click("冻结自动成长"); await until(() => t.requests.at(-1).path === "/api/admin/session");
  t.qa("beta"); gate.resolve(); await pending; assert.equal(t.posts().length, 0);
});
await test("config/selection epoch change during GET leaves the old snapshot nonwritable", async () => {
  const t = await ready(); const gate = deferred(); t.hooks.agency = () => gate.promise;
  const pending = t.refresh(); await until(() => t.reads().length === 2); t.registry.epoch++;
  gate.resolve(); await pending; assert.equal(t.button("冻结自动成长").disabled, true); assert.match(t.ui.views.qa.agencyStatus.textContent, /未确认/);
});
await test("local edits while GET is pending survive and invalidate its response", async () => {
  const t = await ready(); const gate = deferred(); t.hooks.agency = () => gate.promise;
  const pending = t.refresh(); await until(() => t.reads().length === 2); t.edit("profile.identity", "LATE-KEEP");
  gate.resolve(); await pending; assert.equal(t.ui.drafts.get("alpha").policy.profile.identity, "LATE-KEEP"); assert.equal(t.button("冻结自动成长").disabled, true);
});
await test("409 blocks replay until explicit refresh and never exposes backend errors", async () => {
  const t = await ready(); t.hooks.status = 409; await t.click("冻结自动成长");
  assert.equal(t.posts().length, 1); assert.equal(t.button("冻结自动成长").disabled, true);
  await t.click("冻结自动成长"); assert.equal(t.posts().length, 1); assert.match(t.ui.views.qa.agencyStatus.textContent, /冲突/);
  assert.ok(!t.ui.views.qa.agencyStatus.textContent.includes("PRIVATE_SENTINEL"));
  delete t.hooks.status; await t.refresh(); assert.equal(t.button("冻结自动成长").disabled, false);
});
await test("403 and network uncertainty display actionable errors with no automatic requests", async () => {
  for (const mode of ["403", "offline"]) {
    const t = await ready(); if (mode === "403") t.hooks.status = 403; else t.hooks.offline = true;
    await t.click("冻结自动成长"); const count = t.requests.length; t.ui.sync(); t.ui.sync();
    assert.equal(t.requests.length, count); assert.equal(t.button("冻结自动成长").disabled, true);
    assert.match(t.ui.views.qa.agencyStatus.textContent, /手动刷新/); assert.ok(!t.ui.views.qa.agencyStatus.textContent.includes("PRIVATE_SENTINEL"));
  }
});
await test("invalid or cross-group snapshots cannot become writable", async () => {
  for (const patch of [{ preferenceRevision: "2" }, { growthFrozen: "false" }, { conversations: ["private:200"] },
    { card: { revision: 1, fields: { identity: "forbidden" }, versions: [] } }]) {
    const t = await ready(); t.hooks.result = { ...t.view("alpha", ""), ...patch }; await t.refresh();
    assert.equal(t.button("冻结自动成长").disabled, true); assert.match(t.ui.views.qa.agencyStatus.textContent, /未确认/);
  }
  const t = await ready("group:100"); const result = t.view("alpha", "group:100"); result.journal.entries[0].conversationId = "group:101";
  t.hooks.result = result; await t.refresh(); assert.equal(t.button("冻结自动成长").disabled, true);
});
await test("timeout aborts request, ignores late results and requires manual refresh", async () => {
  const t = await ready(); const gate = deferred(); t.hooks.agency = () => gate.promise;
  const pending = t.refresh(); await until(() => t.reads().length === 2 && t.timers.size === 1); [...t.timers.values()][0]();
  await pending; assert.equal(t.reads().at(-1).signal.aborted, true); assert.equal(t.button("冻结自动成长").disabled, true);
  gate.resolve(); await Promise.resolve(); assert.equal(t.reads().length, 2);
});
await test("cancelled native confirmation performs no write", async () => {
  const t = await ready("group:100"); t.hooks.confirm = false;
  await t.click("冻结自动成长"); await t.click("取消此想法"); await t.click("追加回滚到"); assert.equal(t.posts().length, 0);
});
await test("writes follow selected QA account, not the policy editor account", async () => {
  const t = await ready(); t.qa("beta"); await t.ui.load("beta"); await t.refresh();
  await t.click("冻结自动成长"); assert.match(t.posts()[0].path, /accounts\/beta\/agency\/freeze$/);
  assert.equal(t.servers.get("alpha").growthFrozen, false);
});
await test("detached old account/snapshot controls cannot mutate a newly selected view", async () => {
  const t = await ready(), old = t.button("冻结自动成长");
  t.qa("beta"); await t.ui.load("beta"); await t.refresh(); await old.listeners.click(); assert.equal(t.posts().length, 0);
  const stale = t.button("冻结自动成长"); await t.refresh(); await stale.listeners.click(); assert.equal(t.posts().length, 0);
});
await test("mismatched API/registry CAS remains read-only and missing card policy blocks rollback", async () => {
  const t = await ready(); t.hooks.result = { ...t.view("alpha", ""), revision: "different-config" }; await t.refresh();
  assert.equal(t.button("冻结自动成长").disabled, true); await t.click("冻结自动成长"); assert.equal(t.posts().length, 0);
  delete t.hooks.result; t.servers.get("alpha").policy.roleCard.enabled = false; await t.ui.load("alpha"); await t.refresh();
  assert.equal(t.button("追加回滚到").disabled, true); await t.click("追加回滚到"); assert.equal(t.posts().length, 0);
});
await test("member selector requires a policy group and only manual refresh sends user_id", async () => {
  const t = await ready(); assert.equal(t.ui.views.qa.agencyMember.disabled, true); t.member("20001");
  await t.refresh(); assert.ok(!t.reads().at(-1).path.includes("user_id"));
  t.scope("group:100"); t.member("20001"); const reads = t.reads().length; assert.equal(t.body().children.length, 0);
  assert.equal(t.reads().length, reads); await t.refresh();
  assert.match(t.reads().at(-1).path, /agency\?conversation_id=group%3A100&user_id=20001$/); assert.match(t.body().textContent, /Member.*QQ 20001/);
});
await test("invalid member input never reaches transport; unfiltered results cannot contain members", async () => {
  const t = await ready("group:100"); const count = t.reads().length;
  for (const value of ["nickname", "020001", "20001&user_id=999", "1".repeat(21)]) { t.member(value); await t.refresh(); assert.equal(t.reads().length, count); }
  t.member(""); t.hooks.result = t.view("alpha", "group:100", "20001"); await t.refresh();
  assert.match(t.ui.views.qa.agencyStatus.textContent, /未确认/); assert.equal(t.body().children.length, 0);
});
await test("cross-member response is rejected even within the correct group", async () => {
  const t = await ready("group:100"); t.member("20001"); t.hooks.result = t.view("alpha", "group:100", "20002"); await t.refresh();
  assert.match(t.ui.views.qa.agencyStatus.textContent, /未确认/); assert.equal(t.body().children.length, 0);
});
await test("natural expiry reconfirm uses new manual IDs and exact config/preference CAS", async () => {
  const t = await ready("group:100"); t.servers.get("alpha").expired = true; await t.refresh();
  assert.equal(t.button("基于新证据重新确认").disabled, true); t.evidence("fresh-receipt:1, fresh-source:2\nfresh:3");
  assert.equal(t.button("基于新证据重新确认").disabled, false); await t.click("基于新证据重新确认");
  assert.match(t.posts()[0].path, /agency\/reconfirm\?conversation_id=group%3A100$/);
  assert.deepEqual(t.posts()[0].body, { expectedRevision: "config-1", preferenceRevision: 2, id: "self-alpha", evidenceMessageIds: ["fresh-receipt:1", "fresh-source:2", "fresh:3"] });
  assert.match(t.confirms.at(-1), /成熟度.*不能复活墓碑/); assert.equal(t.reads().length, 2);
});
await test("member reconfirm retains URL scope and never grants self compatibility", async () => {
  const t = await ready("group:100"); const s = t.servers.get("alpha"); s.expired = true; s.expiredKind = "member";
  t.member("20001"); await t.refresh(); t.evidence("new-member-source"); await t.click("基于新证据重新确认");
  assert.match(t.posts()[0].path, /agency\/reconfirm\?conversation_id=group%3A100&user_id=20001$/);
  assert.equal(t.posts()[0].body.id, "member-alpha"); assert.equal(Object.hasOwn(t.posts()[0].body, "compatibility"), false);
});
await test("manual expiry/rejection tombstones never expose usable reconfirm controls", async () => {
  for (const type of ["expired", "correction", "negative"]) {
    const t = await ready("group:100"), s = t.servers.get("alpha"); s.expired = true; s.tombstone = { type };
    await t.refresh(); assert.equal(t.button("基于新证据重新确认").disabled, true);
    await t.click("基于新证据重新确认"); assert.equal(t.posts().length, 0); assert.match(t.body().textContent, /不提供重新确认/);
  }
});
await test("reconfirm rejects malformed, duplicate or already-used evidence IDs without POST", async () => {
  const t = await ready("group:100"); t.servers.get("alpha").expired = true; await t.refresh();
  for (const value of ["", "duplicate,duplicate", "https://example.org", "聊天正文", "x".repeat(129), "evidence-alpha"]) {
    t.evidence(value); await t.click("基于新证据重新确认"); assert.equal(t.posts().length, 0);
  }
});
await test("member selections and evidence drafts persist separately per account and group without auto-fill", async () => {
  const t = await ready("group:100"); t.servers.get("alpha").expired = true; t.member("20001"); await t.refresh(); t.evidence("alpha-manual-only");
  t.qa("beta"); await t.ui.load("beta"); assert.equal(t.ui.views.qa.agencyScope.value, ""); assert.equal(t.ui.views.qa.agencyMember.value, "");
  t.scope("group:101"); t.member("20002"); t.servers.get("beta").expired = true; await t.refresh(); t.evidence("beta-manual-only");
  t.qa("alpha"); assert.equal(t.ui.views.qa.agencyScope.value, "group:100"); assert.equal(t.ui.views.qa.agencyMember.value, "20001");
  assert.equal(flatten(t.body()).find(e => e.tagName === "TEXTAREA").value, "alpha-manual-only");
  t.scope("group:101"); await t.refresh(); assert.equal(flatten(t.body()).find(e => e.tagName === "TEXTAREA").value, "");
  t.scope("group:100"); await t.refresh(); assert.equal(flatten(t.body()).find(e => e.tagName === "TEXTAREA").value, "alpha-manual-only");
});
await test("uncertain reconfirm keeps manual input and requires explicit refresh before another request", async () => {
  const t = await ready("group:100"); t.servers.get("alpha").expired = true; await t.refresh(); t.evidence("manual-fresh-id");
  t.hooks.status = 409; await t.click("基于新证据重新确认"); assert.equal(t.posts().length, 1); assert.equal(t.button("基于新证据重新确认").disabled, true);
  await t.click("基于新证据重新确认"); assert.equal(t.posts().length, 1);
  assert.equal(flatten(t.body()).find(e => e.tagName === "TEXTAREA").value, "manual-fresh-id");
  delete t.hooks.status; await t.refresh(); assert.equal(flatten(t.body()).find(e => e.tagName === "TEXTAREA").value, "manual-fresh-id");
});
await test("natural self expiry still requires a chosen evidence group", async () => {
  const t = await ready(); t.servers.get("alpha").expired = true; await t.refresh();
  assert.equal(t.button("基于新证据重新确认").disabled, true); await t.click("基于新证据重新确认"); assert.equal(t.posts().length, 0);
});
await test("member-scoped late GET cannot render after changing the group filter", async () => {
  const t = await ready("group:100"); t.member("20001"); const gate = deferred(); t.hooks.agency = () => gate.promise;
  const pending = t.refresh(); await until(() => t.reads().length === 2); const signal = t.reads().at(-1).signal;
  t.scope("group:101"); assert.equal(signal.aborted, true); gate.resolve(); await pending;
  assert.equal(t.body().children.length, 0); delete t.hooks.agency; await t.refresh();
  assert.match(t.reads().at(-1).path, /conversation_id=group%3A101&user_id=20001$/);
});

console.log(`Social Agency UI: ${tests} offline VM/DOM scenarios passed (no live IO).`);
