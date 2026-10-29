// Offline UI contract tests: extracts the real controller AND session API helper.
// Reads source/CSS only. No service state, secrets, real endpoints or QQ calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
for (const [, source] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(source);
function source(name) {
  const start = html.search(new RegExp(`^    (?:async )?function ${name}\\(`, "m"));
  const end = html.indexOf("\n    }", start); assert(start >= 0 && end > start, name);
  return html.slice(start, end + 6);
}
const controller = source("createPeopleOwnerController");
const cssSource = fs.readFileSync(new URL("../public/console.css", import.meta.url), "utf8");
const apiSource = ["api", "ensureAdminSession"].map(source).join("\n");
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate) { for (let i = 0; i < 80; i++) { if (predicate()) return; await Promise.resolve(); } assert.fail("mock did not reach checkpoint"); }

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.value = ""; this.checked = false; this.disabled = false; this._text = ""; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  get options() { return this.children; }
  get selectedIndex() { return this.children.findIndex(child => child.value === this.value); }
  setAttribute(name, value) { this[name] = value; }
  append(...children) { this.children.push(...children); if (this.tagName === "SELECT" && !this.value) this.value = children[0]?.value ?? ""; }
  replaceChildren(...children) { this.children = children; this.value = ""; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  async fire(name) { for (const listener of this.listeners[name] || []) await listener({ target: this }); }
}
function fixture() {
  const requests = [], hooks = {}, confirmations = [], timers = new Map(); let timer = 0;
  const roots = [new Element("section"), new Element("section")]; roots[0].id = "page-memory"; roots[1].id = "page-automation";
  const flatten = el => [el, ...el.children.flatMap(flatten)];
  const document = { createElement: tag => new Element(tag), getElementById: id => roots.flatMap(flatten).find(el => el.id === id) };
  const profile = { ok: true, revision: 17, personRevision: 3, status: "active", suppressesLegacy: false, entries: [{ id: "entry/exact-1", value: "<img src=x onerror=alert(1)>合成资料" }] };
  const server = {
    ok: true, revision: "config-1", notifications: { enabled: false, times: ["08:00", "20:00"], timezone: "Asia/Shanghai" },
    control: { enabled: false, naturalLanguage: true, usageEnabled: true, allowedTargets: [{ accountId: "demo-a", groupId: "123456" }] },
    people: { enabled: false }, accounts: [{ id: "demo-a", displayName: "合成账号 A" }, { id: "demo-b", displayName: "合成账号 B" }],
    usage: { range: "1d", tokens: 12 }, events: [], operations: [], tasks: [], notificationState: { last: "未发送" }
  };
  const state = {
    Headers, AbortController, URLSearchParams, Intl, console, document,
    registryState: { epoch: 0 }, rows: copy(server.accounts), requests, server, profile,
    setTimeout(fn, ms) { const id = ++timer; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, opts) => {
      const method = opts.method || "GET", body = opts.body ? JSON.parse(opts.body) : undefined;
      const call = { url, method, body, opts }; requests.push(call);
      const response = (data, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
      if (url === "/api/admin/session") { if (hooks.auth) await hooks.auth.promise; return response({ token: "SYNTHETIC_SESSION" }); }
      assert.equal(opts.credentials, "same-origin"); assert.equal(opts.redirect, "error"); assert.equal(opts.cache, "no-store");
      assert.equal(opts.headers.get("x-hermes-qq-admin"), "SYNTHETIC_SESSION");
      if (method !== "GET") assert.equal(opts.headers.get("content-type"), "application/json");
      const key = url.startsWith("/api/people") ? "people" : url.startsWith("/api/owner/query") ? "query" : "owner";
      if (hooks[key]) await hooks[key].promise;
      if (hooks.fail) { if (hooks.fail === "offline") throw new Error("SECRET_SENTINEL"); return response({ error: "SECRET_SENTINEL" }, hooks.fail); }
      if (hooks.malformed) return response({ ok: true, revision: null });
      if (url.startsWith("/api/people?")) return response({ ok: true, revision: server.revision, profile: copy(profile) });
      if (url === "/api/people/admin") {
        assert.equal(body.expectedRevision, server.revision); assert.equal(body.personRevision, profile.revision);
        assert.notEqual(body.personRevision, profile.personRevision);
        profile.revision++; profile.personRevision++;
        if (["freeze", "unfreeze", "delete"].includes(body.operation)) profile.status = body.operation === "freeze" ? "frozen" : body.operation === "delete" ? "deleted" : "active";
        if (body.operation === "correct") profile.entries[0].value = body.value;
        return response({ ok: true, revision: server.revision, result: { ok: true }, profile: copy(profile) });
      }
      if (url === "/api/owner/settings") {
        assert.equal(method, "PATCH"); assert.equal(body.expectedRevision, server.revision);
        assert.deepEqual(Object.keys(body).sort(), ["control", "expectedRevision", "notifications", "people"]);
        assert.deepEqual(Object.keys(body.control).sort(), ["allowedTargets", "enabled"]);
        server.notifications = copy(body.notifications); Object.assign(server.control, copy(body.control)); server.people = copy(body.people); server.revision += "-saved";
      }
      if (url.startsWith("/api/owner/query?")) return response(hooks.queryResult ?? { ok: true, actual: "<svg onload=alert(1)>仅合成数据", params: Object.fromEntries(new URL(url, "http://fixture").searchParams) });
      assert(["/api/owner/status", "/api/owner/settings"].includes(url), `unexpected URL ${url}`);
      return response(copy(server));
    }
  };
  vm.createContext(state);
  vm.runInContext(`let adminSessionToken = "", adminSessionRequest = null;\n${apiSource}\n${controller}\n` +
    `globalThis.ui = createPeopleOwnerController({document, api, accounts: () => rows, contextEpoch: () => registryState.epoch, confirm: text => confirmHook(text), beforeUnload: fn => { globalThis.unload = fn; }});`, Object.assign(state, {
      confirmHook(text) { confirmations.push(text); return hooks.confirm !== false; }
    }));
  state.ui.mount();
  return { ...state, hooks, confirmations, timers, flatten, roots,
    calls: () => requests.filter(call => call.url !== "/api/admin/session"), writes: () => requests.filter(call => ["PATCH", "POST"].includes(call.method)),
    resetAuth: () => vm.runInContext('adminSessionToken = "";', state),
    timeout: () => { const entry = timers.values().next().value; assert(entry); assert.equal(entry.ms, 20000); entry.fn(); },
    async edit(el, value, event = "input") { if (typeof value === "boolean") el.checked = value; else el.value = value; await el.fire(event); },
    async target(account = "demo-a") { const p = state.ui.views.people; await this.edit(p.account, account, "change"); await this.edit(p.user, "123456"); await this.edit(p.conversation, "group:654321"); }
  };
}
const cases = [];
async function test(name, run) { await run(); cases.push(name); }

await test("inert mount/sync, existing pages only, stable IDs, no HTML injection", async () => {
  const t = fixture(), { ui } = t; ui.syncAccounts(); ui.syncAccounts(); assert.equal(t.requests.length, 0);
  assert.equal(ui.views.people.host.id, "peopleProfileCard"); assert.equal(ui.views.owner.host.id, "ownerControlCard");
  assert.equal(ui.views.people.account.options.length, 3); assert.equal(ui.views.people.account.value, "");
  assert.equal(ui.views.owner.fields.disabled, true); assert.equal(ui.views.owner.save.disabled, true); assert.equal(ui.views.people.apply.disabled, true);
  await t.target(); await ui.views.people.load.fire("click"); assert.match(ui.views.people.output.textContent, /<img/);
  assert(!t.roots.flatMap(t.flatten).some(el => ["IMG", "SVG", "IFRAME"].includes(el.tagName)));
  const ids = t.roots.flatMap(t.flatten).map(el => el.id).filter(Boolean); assert.equal(ids.length, new Set(ids).size);
  assert.equal(t.writes().length, 0); assert.doesNotMatch(controller, /innerHTML|setInterval|onclick/);
});
await test("explicit scope, config CAS separate from global people CAS, exact IDs and confirmation", async () => {
  const t = fixture(), { ui } = t, p = ui.views.people;
  await ui.loadPerson(); assert.equal(t.calls().length, 0);
  await t.target(); await ui.loadPerson(); assert.equal(t.calls()[0].url, "/api/people?account_id=demo-a&user_id=123456&conversation_id=group%3A654321");
  p.operation.value = "correct"; p.entry.value = "entry/exact"; p.value.value = "新内容"; await ui.applyPerson(); assert.equal(t.writes().length, 0);
  p.entry.value = "entry/exact-1"; t.hooks.confirm = false; await ui.applyPerson(); assert.equal(t.writes().length, 0);
  t.hooks.confirm = true; await p.apply.fire("click");
  assert.deepEqual(t.writes()[0].body, { expectedRevision: "config-1", personRevision: 17, accountId: "demo-a", userId: "123456", operation: "correct", entryId: "entry/exact-1", value: "新内容" });
  assert.equal(p.value.value, "新内容"); assert.equal(ui.state.person.result.revision, 18);
  for (const operation of ["revoke", "freeze", "unfreeze", "delete"]) { p.operation.value = operation; await ui.applyPerson(); assert.equal(t.writes().at(-1).body.operation, operation); }
  assert(t.confirmations.every(text => /demo-a/.test(text) && /123456/.test(text) && /group:654321/.test(text)));
  await t.edit(p.conversation, "private:123456"); await ui.loadPerson(); assert.match(t.calls().at(-1).url, /conversation_id=private%3A123456/);
});
await test("owner one-save contract, query kinds/ranges/account, preserving extra control fields", async () => {
  const t = fixture(), { ui } = t, o = ui.views.owner;
  await o.load.fire("click"); await t.edit(o.notifications, true); await t.edit(o.control, true); await t.edit(o.people, true);
  await t.edit(o.times, "09:30\n22:00"); await t.edit(o.targets, "demo-a:123456\ndemo-b:654321");
  assert.equal(t.writes().length, 0); await o.save.fire("click"); assert.equal(t.writes().length, 1);
  assert.deepEqual(t.writes()[0].body.notifications, { enabled: true, times: ["09:30", "22:00"], timezone: "Asia/Shanghai" });
  assert.equal(t.server.control.naturalLanguage, true); assert.equal(t.server.control.usageEnabled, true); assert.equal(ui.state.ownerDirty, false);
  assert.match(o.json.textContent, /notificationState/);
  for (const kind of ["tokens", "status", "blockers", "tasks", "history"]) for (const days of ["1", "7"]) {
    await t.edit(o.kind, kind, "change"); await t.edit(o.days, days, "change"); await t.edit(o.account, "demo-b", "change"); await ui.queryOwner();
    const params = new URL(t.calls().at(-1).url, "http://fixture").searchParams; assert.equal(params.get("kind"), kind); assert.equal(params.get("days"), days); assert.equal(params.get("account_id"), "demo-b");
  }
  await t.edit(o.account, "", "change"); await ui.queryOwner(); assert(!t.calls().at(-1).url.includes("account_id"));
  assert.match(o.queryJson.textContent, /<svg/); assert.doesNotMatch(o.queryOutput.textContent, /<svg/); assert.equal(t.writes().length, 1);
});
await test("target/time/timezone validation and 100-line bound", async () => {
  const t = fixture(), { ui } = t, o = ui.views.owner; await ui.loadOwner();
  for (const [el, value] of [[o.times, "25:00"], [o.timezone, "not/a-zone"], [o.targets, "demo-a:*"], [o.targets, "missing:123456"], [o.targets, Array(101).fill("demo-a:123456").join("\n")]]) {
    await ui.loadOwner(); await t.edit(o.times, "08:00"); await t.edit(o.timezone, "Asia/Shanghai"); await t.edit(o.targets, "demo-a:123456"); await t.edit(el, value); await ui.saveOwner(); assert.equal(t.writes().length, 0);
  }
  await t.edit(o.targets, Array(100).fill("demo-a:123456").join("\n")); await ui.saveOwner(); assert.equal(t.writes().length, 1);
});
await test("403/409/offline/500/malformed preserve drafts, no retry or write until explicit read", async () => {
  for (const mode of [403, 409, 500, "offline", "malformed"]) for (const lane of ["people", "owner"]) {
    const t = fixture(), { ui } = t, p = ui.views.people, o = ui.views.owner;
    await t.target(); await ui.loadPerson(); await ui.loadOwner();
    p.operation.value = "correct"; p.entry.value = "entry/exact-1"; p.value.value = "人物草稿"; await t.edit(o.times, "11:11");
    if (mode === "malformed") t.hooks.malformed = true; else t.hooks.fail = mode;
    await (lane === "people" ? ui.applyPerson() : ui.saveOwner()); const count = t.writes().length; assert.equal(count, 1);
    await (lane === "people" ? ui.applyPerson() : ui.saveOwner()); assert.equal(t.writes().length, count);
    assert.equal(p.value.value, "人物草稿"); assert.equal(o.times.value, "11:11"); assert.equal(ui.state.ownerDirty, true);
    assert.doesNotMatch(t.roots.map(el => el.textContent).join(""), /SECRET_SENTINEL/);
    assert.match((lane === "people" ? p : o).status.textContent, /草稿保留/);
    delete t.hooks.fail; delete t.hooks.malformed;
    await (lane === "people" ? ui.loadPerson() : ui.loadOwner()); assert.equal(p.value.value, "人物草稿"); assert.equal(o.times.value, "11:11"); assert.equal(t.writes().length, count);
  }
});
await test("read failure visible, fresh explicit retry, dirty status refresh and in-flight edits retained", async () => {
  const t = fixture(), { ui } = t, o = ui.views.owner; await t.target(); t.hooks.fail = 503;
  await ui.loadPerson(); await ui.loadOwner(); await ui.queryOwner();
  assert.equal(ui.views.people.apply.disabled, true); assert.equal(o.save.disabled, true); assert.match(o.queryOutput.textContent, /503/);
  delete t.hooks.fail; await ui.loadOwner(); await t.edit(o.times, "12:34"); t.server.revision = "config-2"; await ui.loadOwner();
  assert.equal(o.times.value, "12:34"); assert.equal(ui.state.ownerBase, "config-1");
  const wait = deferred(); t.hooks.owner = wait; const saving = ui.saveOwner(); await until(() => t.writes().length === 1);
  await ui.saveOwner(); assert.equal(t.writes().length, 1); await t.edit(o.times, "15:45"); wait.resolve(); await saving;
  assert.equal(o.times.value, "15:45"); assert.equal(ui.state.ownerDirty, true); assert.match(t.confirmations.at(-1), /远端版本已变化/);
  let prevented = false; t.unload({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
});
await test("stale people/query responses, switch-away-and-back, config epoch and removed account fences", async () => {
  for (const mode of ["selection", "switch-back", "epoch", "removed"]) for (const lane of ["people", "query"]) {
    const t = fixture(), { ui } = t, p = ui.views.people, o = ui.views.owner; await t.target();
    await t.edit(o.account, "demo-a", "change"); const wait = deferred(); t.hooks[lane] = wait;
    const pending = lane === "people" ? ui.loadPerson() : ui.queryOwner(); await until(() => t.calls().length === 1);
    if (["selection", "switch-back"].includes(mode)) { const el = lane === "people" ? p.account : o.account; await t.edit(el, "demo-b", "change"); if (mode === "switch-back") await t.edit(el, "demo-a", "change"); }
    if (mode === "epoch") { t.registryState.epoch++; ui.syncAccounts(); }
    if (mode === "removed") { t.rows.splice(0, 1); ui.syncAccounts(); }
    wait.resolve(); await pending;
    assert.equal(ui.state.person, null); assert.doesNotMatch((lane === "people" ? p.output : o.queryOutput).textContent, /合成资料|仅合成数据/);
    assert.equal(t.writes().length, 0);
  }
});
await test("stale people POST and owner PATCH cannot adopt after identity/config changes", async () => {
  for (const lane of ["people", "owner"]) {
    const t = fixture(), { ui } = t, p = ui.views.people, o = ui.views.owner; await t.target(); await ui.loadPerson(); await ui.loadOwner();
    p.value.value = "保留人物草稿"; await t.edit(o.times, "10:10");
    const wait = deferred(); t.hooks[lane] = wait; const pending = lane === "people" ? ui.applyPerson() : ui.saveOwner();
    await until(() => t.writes().length === 1);
    if (lane === "people") await t.edit(p.account, "demo-b", "change"); else { t.registryState.epoch++; ui.syncAccounts(); }
    wait.resolve(); await pending;
    assert.equal(p.value.value, "保留人物草稿"); assert.equal(o.times.value, "10:10");
    assert.equal(lane === "people" ? ui.state.person : ui.state.owner, null);
  }
});
await test("timeout bounds session bootstrap; late auth never sends GET/POST/PATCH", async () => {
  for (const action of ["loadPerson", "applyPerson", "loadOwner", "saveOwner", "queryOwner"]) {
    const t = fixture(), { ui } = t; await t.target(); await ui.loadPerson(); await ui.loadOwner();
    t.resetAuth(); const wait = deferred(); t.hooks.auth = wait; const before = t.calls().length; const pending = ui[action]();
    await until(() => t.timers.size === 1); t.timeout(); await pending; wait.resolve();
    for (let i = 0; i < 40; i++) await Promise.resolve(); assert.equal(t.calls().length, before, action);
    assert.equal(t.timers.size, 0); assert.match((action.includes("Person") ? ui.views.people.status : action === "queryOwner" ? ui.views.owner.queryOutput : ui.views.owner.status).textContent, /超时/);
  }
});
await test("wire timeout and late replies never revive state, no replay", async () => {
  for (const lane of ["people", "owner"]) {
    const t = fixture(), { ui } = t; await t.target(); await ui.loadPerson(); await ui.loadOwner();
    const wait = deferred(); t.hooks[lane] = wait; const pending = lane === "people" ? ui.applyPerson() : ui.saveOwner();
    await until(() => t.writes().length === 1); const call = t.writes()[0]; t.timeout(); await pending; assert.equal(call.opts.signal.aborted, true);
    wait.resolve(); for (let i = 0; i < 40; i++) await Promise.resolve();
    assert.equal(lane === "people" ? ui.state.person : ui.state.owner, null);
    await (lane === "people" ? ui.applyPerson() : ui.saveOwner()); assert.equal(t.writes().length, 1);
  }
});
await test("selection/config changes during authentication cancel before wire, keep draft inputs", async () => {
  for (const action of ["loadPerson", "applyPerson", "saveOwner", "queryOwner"]) {
    const t = fixture(), { ui } = t; await t.target(); await ui.loadPerson(); await ui.loadOwner();
    ui.views.people.value.value = "未提交的人物草稿"; await t.edit(ui.views.owner.times, "13:00");
    t.resetAuth(); const wait = deferred(); t.hooks.auth = wait; const before = t.calls().length;
    const pending = ui[action](); await until(() => t.timers.size === 1);
    if (action === "saveOwner") { t.registryState.epoch++; ui.syncAccounts(); }
    else if (action === "queryOwner") await t.edit(ui.views.owner.account, "demo-b", "change");
    else await t.edit(ui.views.people.account, "demo-b", "change");
    await pending; wait.resolve(); for (let i = 0; i < 40; i++) await Promise.resolve();
    assert.equal(t.calls().length, before); assert.equal(t.timers.size, 0);
    assert.equal(ui.views.people.value.value, "未提交的人物草稿"); assert.equal(ui.views.owner.times.value, "13:00");
  }
});
await test("large owner payload stays a bounded Chinese summary, full metadata collapsed and scroll-limited", async () => {
  const t = fixture(), { ui, server } = t, o = ui.views.owner;
  server.notifications.enabled = true;
  server.usage = { stats: { callCount: 4, totalCallCount: null, unknownCallCount: 2, tokens: { totalTokens: { knownTokens: 123, total: null } } }, coverage: { complete: false }, range: { days: 1, basis: "FULL_METADATA_SENTINEL" } };
  server.events = { count: 2, totalCount: null, coverage: { complete: false }, events: [{ code: "OWNER_BLOCKED" }, { code: "OWNER_FAILED" }] };
  server.operations = Array.from({ length: 1200 }, (_, id) => ({ id, status: id % 2 ? "confirmed" : "uncertain", raw: "FULL_METADATA_SENTINEL" }));
  server.tasks = { running: 1, queued: 2, items: Array.from({ length: 1000 }, (_, id) => ({ id })) };
  await ui.loadOwner();
  const summary = o.output.textContent;
  assert(summary.length < 900); assert.equal(o.output.tagName, "DIV"); assert.equal(o.output.children.length, 6);
  for (const text of [/通知：开启/, /08:00、20:00/, /主人命令：关闭/, /范围：1 个明确目标/, /人物档案：关闭/, /已记录调用：4 次/, /已知 Token：123/, /完整调用 \/ Token 总量：未知 \/ 未知/, /未知的调用：2/, /不按零计算/, /当前阻碍：已记录 2 项/, /运行 1 · 排队 2/, /已确认 600/, /结果不明 600/]) assert.match(summary, text);
  assert.doesNotMatch(summary, /FULL_METADATA_SENTINEL/);
  assert.equal(o.details.tagName, "DETAILS"); assert.equal(o.details.open, false); assert.equal(o.json.tagName, "PRE");
  assert(o.details.children.includes(o.json)); assert.equal(o.details.id, "ownerResultDetails"); assert.equal(o.json.id, "ownerResultJson");
  assert.deepEqual(JSON.parse(o.json.textContent), copy(server)); assert(o.json.textContent.split("\n").length > 5000);
  const preRule = cssSource.match(/(?:^|\n)pre\s*\{([^}]+)\}/)?.[1]; assert(preRule); assert.match(preRule, /max-height:\s*360px/); assert.match(preRule, /overflow:\s*auto/);
  await t.edit(o.times, "12:34"); await ui.loadOwner(); assert.equal(o.times.value, "12:34"); assert.equal(t.writes().length, 0);
});
await test("query summaries keep real per-kind metadata only in details; changed/failed query clears stale JSON", async () => {
  const t = fixture(), { ui } = t, o = ui.views.owner;
  const payloads = {
    tokens: { stats: { callCount: 0, totalCallCount: null, unknownCallCount: 0, tokens: { totalTokens: { knownTokens: 0, total: null } } }, coverage: { complete: false } },
    blockers: { count: 0, totalCount: null, events: [], coverage: { complete: false } },
    tasks: { running: 2, queued: 1, operations: [{ status: "accepted" }] },
    history: { operations: [{ status: "failed" }, { status: "uncertain" }] },
    status: { accounts: [{ id: "demo-a" }], notifications: { enabled: false, times: ["08:00"], timezone: "Asia/Shanghai" } }
  };
  for (const [kind, fields] of Object.entries(payloads)) {
    t.hooks.queryResult = { ok: true, ...fields, range: { days: 7, basis: "EXACT_RANGE_METADATA" }, extra: Array(1200).fill("<svg>FULL_QUERY_SENTINEL") };
    await t.edit(o.kind, kind, "change"); await t.edit(o.days, "7", "change"); await ui.queryOwner();
    assert(o.queryOutput.textContent.length < 600); assert.match(o.queryOutput.textContent, /最近 7 天/);
    assert.doesNotMatch(o.queryOutput.textContent, /FULL_QUERY_SENTINEL|EXACT_RANGE_METADATA/);
    assert.equal(o.queryDetails.open, false); assert.equal(o.queryJson.tagName, "PRE"); assert(o.queryDetails.children.includes(o.queryJson));
    assert.deepEqual(JSON.parse(o.queryJson.textContent), t.hooks.queryResult);
    if (kind === "tokens") assert.match(o.queryOutput.textContent, /完整调用 \/ Token 总量：未知 \/ 未知/);
    if (kind === "blockers") assert.match(o.queryOutput.textContent, /已记录 0 项（覆盖不完整或未知，不代表全部）/);
    if (kind === "tasks") assert.match(o.queryOutput.textContent, /运行 2 · 排队 1/);
    if (kind === "history") assert.match(o.queryOutput.textContent, /失败 1、结果不明 1/);
  }
  o.queryDetails.open = true; await t.edit(o.account, "demo-b", "change");
  assert.equal(o.queryDetails.open, false); assert.doesNotMatch(o.queryJson.textContent, /FULL_QUERY_SENTINEL/);
  t.hooks.fail = 503; await ui.queryOwner(); assert.match(o.queryOutput.textContent, /503/); assert.doesNotMatch(o.queryJson.textContent, /FULL_QUERY_SENTINEL/);
  assert.equal(t.writes().length, 0); assert(!t.roots.flatMap(t.flatten).some(el => el.tagName === "SVG"));
});

console.log(`PASS people/owner UI: embedded syntax + ${cases.length} offline cases (${cases.join("; ")})`);

// Optional isolated real-browser preview: all reads/writes below are synthetic,
// in-memory and never forwarded. Reuses the actual controller and console CSS.
if (process.argv.includes("--preview")) {
  const http = await import("node:http");
  const css = fs.readFileSync(new URL("../public/console.css", import.meta.url));
  const preview = `<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/console.css"><title>人物与主人管理 · 离线合成预览</title><body class="console-page"><main class="main"><h1>离线合成预览</h1><p class="hint">只有虚构账号和内存响应，无真实服务、QQ 消息或生产写入。</p><section id="page-memory" class="page active"></section><section id="page-automation" class="page active"></section></main><script>
  const rows = [{id:'demo-a', displayName:'合成账号 A'}, {id:'demo-b', displayName:'合成账号 B'}];
  const profile = {ok:true, revision:17, personRevision:3, status:'active', entries:[{id:'entry/exact-1', value:'合成人物资料，仅用于界面检查'}]};
  const status = {ok:true, revision:'config-1', notifications:{enabled:false, times:['08:00'], timezone:'Asia/Shanghai'}, control:{enabled:false, allowedTargets:[]}, people:{enabled:false}, accounts:rows,
    usage:{stats:{callCount:4,totalCallCount:null,unknownCallCount:2,tokens:{totalTokens:{knownTokens:123,total:null}}},coverage:{complete:false},range:{days:1}},
    events:{count:2,coverage:{complete:false},events:[]},operations:Array.from({length:1200},(_,id)=>({id,status:id%2?'confirmed':'uncertain',metadata:'仅合成明细'})),tasks:{running:1,queued:2},notificationState:{last:'未发送'}};
  let calls = 0;
  const api = async (url, opts = {}) => {
    calls++; document.title = '合成预览 · 请求 ' + calls;
    if (url.startsWith('/api/people')) { if (opts.method === 'POST') profile.revision++; return {ok:true, revision:status.revision, profile:structuredClone(profile)}; }
    if (url.startsWith('/api/owner/query')) return {ok:true,...status.usage,notifications:status.notifications,accounts:rows,range:{days:7},metadata:Array(1200).fill('合成查询元数据')};
    if (opts.method === 'PATCH') { const body = JSON.parse(opts.body); Object.assign(status, body); delete status.expectedRevision; status.revision += '-saved'; }
    return structuredClone(status);
  };
  ${controller}
  const ui = createPeopleOwnerController({document, api, accounts:()=>rows, contextEpoch:()=>0, confirm:text=>confirm(text), beforeUnload:handler=>window.addEventListener('beforeunload',handler)}); ui.mount();
  </script></body></html>`;
  const server = http.createServer((req, res) => {
    res.setHeader("cache-control", "no-store");
    if (req.url === "/console.css") { res.setHeader("content-type", "text/css"); res.end(css); }
    else if (req.url === "/") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(preview); }
    else { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1", () => console.log(`Synthetic people/owner preview: http://127.0.0.1:${server.address().port}/`));
}
