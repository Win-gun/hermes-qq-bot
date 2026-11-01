import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Extract actual embedded controllers and the actual authenticated fetch helper.
// Synthetic browser/API only; no production config, memory, QQ or model calls.
assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Node 22 required');
const html = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
let embeddedScripts = 0;
for (const [, source] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) { new vm.Script(source); embeddedScripts++; }
function source(name) {
  const start = html.search(new RegExp(`^    (?:async )?function ${name}\\(`, 'm'));
  const end = html.indexOf('\n    }', start); assert(start >= 0 && end > start, name); return html.slice(start, end + 6);
}
const autonomySource = source('createAutonomousSocialStatusController');
const ownerSource = source('createPeopleOwnerController');
const apiSource = ['api', 'ensureAdminSession'].map(source).join('\n');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(test) { for (let i = 0; i < 100; i++) { if (test()) return; await Promise.resolve(); } assert.fail('fixture checkpoint not reached'); }
function autonomyData() {
  return { ok: true, revision: 'autonomy-config-1',
    policy: { version: 1, enabled: true, guidance: true, delegation: true, reconstruction: true, optOut: false, paused: false },
    capabilities: [{ accountId: 'demo-a', features: [{ id: 'guidance', available: true, reason: 'READY' },
      { id: 'qzone', available: false, reason: 'PROTOCOL_UNSUPPORTED' }, { id: 'voice', available: null }] }],
    delegations: { running: 2, waiting: 3, paused: 1, uncertain: 4 },
    guidance: { accounts: [{ accountId: 'demo-a', ruleCount: 6 }, { accountId: 'demo-b', ruleCount: 2 }] },
    reconstruction: { code: 'READY', initialized: true, busy: true,
      reconstruction: { status: 'running', stats: { scanned: 120, recoveredSources: 40, people: 12, unattributed: 3,
        tiers: { Verified: 20, Supported: 8, Tentative: 6, Conflicted: 4, Suppressed: 2 },
        modelAttempts: 5, unknownCalls: 1, usage: { inputTokens: 500, outputTokens: 100, totalTokens: 600 } } } } };
}
function ownerData() {
  return { ok: true, revision: 'owner-config-1', notifications: { enabled: true, times: ['09:00', '21:00'], timezone: 'Asia/Shanghai' },
    control: { enabled: true, allowedTargets: [{ accountId: 'demo-a', groupId: '31001' }] }, people: { enabled: true } };
}
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.value = ''; this.checked = false; this.disabled = false; this._text = ''; this.parentNode = null; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  get options() { return this.children; }
  get selectedIndex() { return this.children.findIndex(child => child.value === this.value); }
  setAttribute(k, v) { this[k] = v; }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } if (this.tagName === 'SELECT' && !this.value) this.value = children[0]?.value ?? ''; }
  insertBefore(child, reference) { const index = this.children.indexOf(reference); assert(index >= 0 || reference == null); child.parentNode = this; if (index < 0) this.children.push(child); else this.children.splice(index, 0, child); return child; }
  replaceChildren(...children) { this.children = []; this.value = ''; this._text = ''; this.append(...children); }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  async fire(name) { for (const listener of this.listeners[name] || []) await listener({ target: this }); }
}
function fixture() {
  const requests = [], timers = new Map(), hooks = {}, roots = [new Element('section'), new Element('section')]; let timer = 0;
  roots[0].id = 'page-memory'; roots[1].id = 'page-automation';
  const flatten = el => [el, ...el.children.flatMap(flatten)];
  const document = { createElement: tag => new Element(tag), getElementById: id => roots.flatMap(flatten).find(el => el.id === id) };
  const state = { Headers, AbortController, URLSearchParams, Intl, console, document, requests,
    registryState: { epoch: 0 }, rows: [{ id: 'demo-a', displayName: '合成账号 A' }, { id: 'demo-b', displayName: '合成账号 B' }],
    server: ownerData(), status: autonomyData(),
    setTimeout(fn, ms) { const id = ++timer; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => {
      const method = options.method || 'GET'; const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, method, body, options });
      const response = (data, code = 200) => ({ ok: code < 400, status: code, text: async () => JSON.stringify(data) });
      if (url === '/api/admin/session') { if (hooks.auth) await hooks.auth.promise; return response({ token: 'SYNTHETIC_SESSION' }); }
      assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
      assert.equal(options.headers.get('x-hermes-qq-admin'), 'SYNTHETIC_SESSION');
      if (url === '/api/owner/autonomy') {
        assert.equal(method, 'GET', 'autonomy is read-only'); assert.equal(options.body, undefined);
        if (hooks.autonomy) await hooks.autonomy.promise;
        if (hooks.error === 'offline') throw new Error('SECRET_SENTINEL');
        if (hooks.error) return response({ error: 'SECRET_SENTINEL', token: 'SECRET_SENTINEL' }, hooks.error);
        return response(clone(state.status));
      }
      if (url === '/api/owner/status') { assert.equal(method, 'GET'); return response(clone(state.server)); }
      if (url === '/api/owner/settings') {
        assert.equal(method, 'PATCH'); assert.equal(body.expectedRevision, state.server.revision);
        assert.deepEqual(Object.keys(body).sort(), ['control', 'expectedRevision', 'notifications', 'people']);
        state.server = { ...state.server, revision: 'owner-config-2', ...body }; return response(clone(state.server));
      }
      assert.fail(`unexpected request: ${url}`);
    } };
  vm.createContext(state);
  vm.runInContext(`let adminSessionToken = '', adminSessionRequest = null;\n${apiSource}\n${autonomySource}\n${ownerSource}\n`
    + `globalThis.autonomy = createAutonomousSocialStatusController({document, api, accounts:()=>rows, contextEpoch:()=>registryState.epoch});\n`
    + `globalThis.owner = createPeopleOwnerController({document, api, accounts:()=>rows, contextEpoch:()=>registryState.epoch, confirm:()=>true, beforeUnload:fn=>{globalThis.unload=fn}, onOwnerLoaded:()=>autonomy.load()});\n`
    + `owner.mount(); autonomy.mount();`, state);
  return { ...state, hooks, timers, roots, flatten,
    calls: () => requests.filter(r => r.url !== '/api/admin/session'),
    writes: () => requests.filter(r => !['GET', 'HEAD'].includes(r.method)),
    text: () => roots.map(el => el.textContent).join('\n'),
    timeout() { const entry = timers.values().next().value; assert(entry); assert.equal(entry.ms, 20000); entry.fn(); },
    resetAuth: () => vm.runInContext("adminSessionToken = '';", state),
    async edit(el, value) { if (typeof value === 'boolean') el.checked = value; else el.value = value; await el.fire('input'); }
  };
}
const cases = [];
async function test(name, run) { await run(); cases.push(name); }

await test('inert mount, existing sections/theme/navigation, one read button and no new toggles', async () => {
  const t = fixture(); t.autonomy.mount(); t.autonomy.syncAccounts();
  assert.equal(t.requests.length, 0);
  assert.equal(t.autonomy.views.owner.section.parentNode.id, 'ownerControlCard');
  assert.equal(t.autonomy.views.people.section.parentNode.id, 'peopleProfileCard');
  const nodes = [...t.flatten(t.autonomy.views.owner.section), ...t.flatten(t.autonomy.views.people.section)];
  assert.equal(nodes.filter(el => el.tagName === 'BUTTON').length, 1);
  assert(!nodes.some(el => ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)));
  const ids = t.roots.flatMap(t.flatten).map(el => el.id).filter(Boolean); assert.equal(ids.length, new Set(ids).size);
  assert.match(t.text(), /Supported.*不等于亲历/); assert.match(t.autonomy.views.people.body.textContent, /扫描 未知/);
  assert.doesNotMatch(autonomySource, /innerHTML|onclick|setInterval|localStorage|sessionStorage|classList|\/api\/send|method: "(?:POST|PATCH|DELETE)"/);
  assert.match(html, /<script src="\/console-theme.js"><\/script>/); assert.match(html, /href="\/console.css"/);
  assert(!html.includes('data-page="autonomy"')); assert.match(html, /onOwnerLoaded: \(\) => autonomousSocialUi.load\(\)/);
});
await test('explicit owner status read appends authenticated read-only snapshot with no save', async () => {
  const t = fixture(); await t.owner.views.owner.load.fire('click');
  assert.deepEqual(t.calls().map(r => r.url), ['/api/owner/status', '/api/owner/autonomy']);
  assert.equal(t.requests.filter(r => r.url === '/api/admin/session').length, 1);
  assert.equal(t.writes().length, 0); assert.equal(t.timers.size, 0);
  assert.match(t.autonomy.views.owner.body.textContent, /自主模式：开启.*指导：开启.*委托：开启.*重建：开启/);
  assert.match(t.autonomy.views.owner.body.textContent, /运行 2.*等待 3.*暂停 1.*结果不确定 4/);
  assert.match(t.autonomy.views.owner.body.textContent, /长期指导：8 条/);
  assert.match(t.autonomy.views.owner.accounts.textContent, /长期指导 6 条/);
  assert.match(t.autonomy.views.owner.accounts.textContent, /空间：不可用（当前协议不支持）/);
  assert.match(t.autonomy.views.owner.accounts.textContent, /语音：未知/);
  assert.match(t.autonomy.views.people.body.textContent, /扫描 120.*恢复来源 40.*人物 12.*归属待核实 3/);
  assert.match(t.autonomy.views.people.body.textContent, /Verified 20.*Supported 8.*Tentative 6.*Conflicted 4.*Suppressed 2/);
  assert.match(t.autonomy.views.people.body.textContent, /模型尝试 5.*用量未知调用 1.*输入 500.*输出 100.*合计 600/);
  assert.equal(t.autonomy.views.owner.details.open, false);
});
await test('memory progress refresh is one GET, no person scope guessing or restore/start/send action', async () => {
  const t = fixture(); await t.autonomy.views.people.refresh.fire('click');
  assert.deepEqual(t.calls().map(r => r.url), ['/api/owner/autonomy']); assert.equal(t.writes().length, 0);
  assert.equal(t.owner.views.people.account.value, ''); assert.equal(t.owner.state.person, null);
});
await test('dirty inputs, separate revision/CAS and page/context sync never adopt runtime policy into drafts', async () => {
  const t = fixture(), o = t.owner.views.owner, p = t.owner.views.people;
  await t.owner.loadOwner(); await t.edit(o.times, '12:34'); await t.edit(o.targets, 'demo-a:31001');
  p.entry.value = 'exact-entry'; p.value.value = '尚未提交的纠正'; p.account.value = 'demo-b'; p.user.value = '22001'; p.conversation.value = 'group:31001';
  const before = { times: o.times.value, targets: o.targets.value, entry: p.entry.value, value: p.value.value,
    account: p.account.value, user: p.user.value, conversation: p.conversation.value, base: t.owner.state.ownerBase, edit: t.owner.state.ownerEdit };
  for (let i = 0; i < 3; i++) { t.autonomy.syncAccounts(); t.owner.syncAccounts(); await t.autonomy.load(); }
  assert.deepEqual({ times: o.times.value, targets: o.targets.value, entry: p.entry.value, value: p.value.value,
    account: p.account.value, user: p.user.value, conversation: p.conversation.value, base: t.owner.state.ownerBase, edit: t.owner.state.ownerEdit }, before);
  assert.equal(t.owner.state.ownerDirty, true); assert.equal(t.owner.state.owner.revision, 'owner-config-1');
  assert.equal(t.autonomy.state.snapshot.revision, 'autonomy-config-1'); assert.equal(t.writes().length, 0);
  await t.owner.saveOwner(); assert.equal(t.writes().length, 1); assert.equal(t.writes()[0].body.expectedRevision, 'owner-config-1');
  assert(!Object.hasOwn(t.writes()[0].body, 'autonomousSocial'));
  assert.equal(t.calls().filter(r => r.url === '/api/owner/autonomy').length, 4, 'save never silently re-reads or writes autonomy');
});
await test('missing/null/string/negative metrics remain unknown, explicit zero remains zero', async () => {
  const original = fixture();
  for (const k of Object.keys(original.status)) delete original.status[k];
  Object.assign(original.status, { ok: true, revision: 0, policy: {}, delegations: { running: 0, waiting: null, paused: '0', uncertain: -1 },
    guidance: { accounts: [{ accountId: 'demo-a', ruleCount: null }] }, reconstruction: { initialized: true,
      reconstruction: { status: 'running', stats: { scanned: 0, recoveredSources: null, people: '0', unattributed: -1,
        tiers: { Verified: 0, Supported: null }, usage: {} } } } });
  await original.autonomy.load();
  assert.match(original.autonomy.views.owner.body.textContent, /自主模式：未知/);
  assert.match(original.autonomy.views.owner.body.textContent, /运行 0.*等待 未知.*暂停 未知.*结果不确定 未知/);
  assert.match(original.autonomy.views.owner.body.textContent, /长期指导：未知/);
  assert.match(original.autonomy.views.people.body.textContent, /扫描 0.*恢复来源 未知.*人物 未知.*归属待核实 未知/);
  assert.match(original.autonomy.views.people.body.textContent, /Verified 0.*Supported 未知/);
  assert.doesNotMatch(original.autonomy.views.owner.accounts.textContent, /宿主报告可用/);
});
await test('not initialized is not a fictitious zero-progress scan, empty guidance is known zero', async () => {
  const t = fixture(); t.status.reconstruction.initialized = false; t.status.reconstruction.busy = false;
  t.status.reconstruction.reconstruction.stats.scanned = 0; t.status.guidance.accounts = [];
  await t.autonomy.load();
  assert.match(t.autonomy.views.people.body.textContent, /尚未初始化/); assert.match(t.autonomy.views.people.body.textContent, /扫描 未知/);
  assert.match(t.autonomy.views.owner.body.textContent, /长期指导：0 条/);
});
await test('current host adapter capability IDs remain distinct, absent identity/duplicate rule totals unknown', async () => {
  const t = fixture();
  t.status.capabilities[0].features = ['read_context', 'read_person', 'read_self', 'public_discoveries', 'search_stickers',
    'web_search', 'express', 'execution_status', 'qzone_read', 'qzone_draft', 'qzone_publish', 'qzone_like', 'qzone_comment']
    .map(id => ({ id, available: false, reason: 'ACCOUNT_OR_SCOPE_UNAVAILABLE' }));
  await t.autonomy.load();
  const text = t.autonomy.views.owner.accounts.textContent;
  assert.match(text, /当前会话/); assert.match(text, /人物记忆/); assert.match(text, /空间评论/);
  assert.doesNotMatch(text, /其他能力|其余能力未展开/); assert.match(text, /账号、连接或范围未就绪/);
  t.status.guidance.accounts = [{ accountId: 'demo-a', ruleCount: 2 }, { accountId: 'demo-a', ruleCount: 2 }];
  await t.autonomy.load(); assert.match(t.autonomy.views.owner.body.textContent, /长期指导：未知/);
  t.status.guidance.accounts = [{ ruleCount: 0 }];
  await t.autonomy.load(); assert.match(t.autonomy.views.owner.body.textContent, /长期指导：未知/);
});
await test('master opt-out/pause/off are not reported as actively enabled', async () => {
  for (const [flag, text] of [['optOut', '已退出'], ['paused', '已暂停'], ['enabled', '关闭']]) {
    const t = fixture(); t.status.policy[flag] = flag !== 'enabled'; await t.autonomy.load();
    assert.match(t.autonomy.views.owner.body.textContent, new RegExp(`自主模式：${text}`));
  }
});
await test('errors visible in both areas, old successful data removed, sanitized, explicit retry only', async () => {
  for (const failure of [403, 404, 409, 500, 'offline']) {
    const t = fixture(); await t.autonomy.load(); t.hooks.error = failure; await t.autonomy.load();
    assert.equal(t.autonomy.state.snapshot, null); assert.equal(t.autonomy.views.people.refresh.disabled, false);
    for (const view of Object.values(t.autonomy.views)) { assert.equal(view.status.className, 'warning'); assert.match(view.status.textContent, /失败/); }
    assert.doesNotMatch(t.text(), /SECRET_SENTINEL/); assert.match(t.autonomy.views.people.body.textContent, /扫描 未知/);
    assert.equal(t.calls().length, 2, 'no automatic retry'); delete t.hooks.error; await t.autonomy.views.people.refresh.fire('click');
    assert(t.autonomy.state.snapshot); assert.equal(t.calls().length, 3); assert.equal(t.writes().length, 0);
  }
});
await test('malformed envelope is visible; nested malformed values are harmless unknowns', async () => {
  for (const fields of [{ ok: false }, { revision: null }, { policy: [] }, { policy: null }]) {
    const t = fixture(); Object.assign(t.status, fields); await t.autonomy.load(); assert.equal(t.autonomy.state.snapshot, null);
    assert.match(t.autonomy.views.owner.status.textContent, /格式无效/);
  }
  const t = fixture(); t.status.reconstruction.reconstruction.status = { toString: null };
  t.status.capabilities[0].features[0].id = { toString: null };
  await t.autonomy.load(); assert(t.autonomy.state.snapshot); assert.match(t.autonomy.views.people.body.textContent, /重建：未知/);
});
await test('XSS/private extras/prose exceptions never become markup or leaked raw JSON', async () => {
  const t = fixture(); t.rows[0].displayName = '<img src=x onerror=alert(1)>合成账号';
  t.status.capabilities[0].features[1].reason = '<svg onload=alert(1)>SECRET_SENTINEL';
  t.status.reconstruction.code = 'SECRET_SENTINEL'; t.status.privateBody = { apiKey: 'SECRET_SENTINEL' };
  await t.autonomy.load();
  assert(!t.roots.flatMap(t.flatten).some(el => ['IMG', 'SVG', 'IFRAME', 'SCRIPT'].includes(el.tagName)));
  assert.doesNotMatch(t.text(), /SECRET_SENTINEL|apiKey/); assert.match(t.autonomy.views.owner.accounts.textContent, /<img/);
});
await test('duplicate reads coalesce and editing during pending GET preserves all draft state', async () => {
  const t = fixture(); await t.owner.loadOwner(); const wait = deferred(); t.hooks.autonomy = wait;
  const pending = t.autonomy.load(); await until(() => t.calls().length === 3); await t.autonomy.load();
  await t.edit(t.owner.views.owner.times, '13:57'); t.owner.views.people.value.value = '保留纠正草稿';
  assert.equal(t.autonomy.views.people.refresh.disabled, true); wait.resolve(); await pending;
  assert.equal(t.calls().length, 3); assert.equal(t.owner.views.owner.times.value, '13:57');
  assert.equal(t.owner.views.people.value.value, '保留纠正草稿'); assert(t.owner.state.ownerDirty);
});
await test('registry epoch/removal/switch-away-and-back discard late snapshots and cancel before wire', async () => {
  for (const auth of [false, true]) {
    const t = fixture(), wait = deferred(); t.hooks[auth ? 'auth' : 'autonomy'] = wait;
    const pending = t.autonomy.load(); await until(() => auth ? t.requests.some(r => r.url === '/api/admin/session') : t.calls().length === 1);
    t.registryState.epoch++; t.autonomy.syncAccounts(); t.registryState.epoch++; t.autonomy.syncAccounts();
    await pending; wait.resolve(); for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(t.autonomy.state.snapshot, null); assert.equal(t.timers.size, 0); assert.equal(t.writes().length, 0);
    if (auth) assert.equal(t.calls().length, 0, 'stale auth never puts autonomy GET on wire');
  }
  const t = fixture(); await t.autonomy.load(); t.rows.splice(0, 1); t.autonomy.syncAccounts();
  assert.equal(t.autonomy.state.snapshot, null); assert.match(t.autonomy.views.owner.status.textContent, /已变化/);
});
await test('20s timeout includes auth; no late success, late GET or automatic retries', async () => {
  for (const auth of [true, false]) {
    const t = fixture(), wait = deferred(); t.hooks[auth ? 'auth' : 'autonomy'] = wait;
    const pending = t.autonomy.load(); await until(() => t.timers.size === 1); t.timeout(); await pending;
    const calls = t.calls().length; wait.resolve(); for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(t.autonomy.state.snapshot, null); assert.equal(t.timers.size, 0); assert.equal(t.calls().length, calls);
    assert.match(t.autonomy.views.people.status.textContent, /超时/); assert.equal(t.writes().length, 0);
  }
});
await test('bounded compact output, collapsed details retain open state, no full metadata dump', async () => {
  const t = fixture(); t.status.capabilities = Array.from({ length: 500 }, () => ({ accountId: 'demo-a',
    features: Array.from({ length: 500 }, () => ({ id: 'qzone', available: false, reason: 'CAPABILITY_NOT_ATTESTED' })) }));
  t.status.guidance.accounts = Array.from({ length: 500 }, () => ({ accountId: 'demo-a', ruleCount: 1 }));
  await t.autonomy.load(); assert(t.autonomy.views.owner.accounts.children.length <= 66);
  assert.match(t.autonomy.views.owner.accounts.textContent, /另有 468/); assert.match(t.autonomy.views.owner.body.textContent, /长期指导：未知/);
  t.autonomy.views.owner.details.open = true; await t.autonomy.load(); assert.equal(t.autonomy.views.owner.details.open, true);
});
console.log(JSON.stringify({ ok: true, scenarios: cases.length, embeddedScripts, node: process.versions.node,
  realNetwork: false, modelCalls: 0, productionIO: false }));

// Optional isolated render fixture. Serves the real shell/theme and extracted
// controllers with SYNTHETIC GET responses only. No bridge/runtime is started.
if (process.argv.includes('--preview')) {
  const { createServer } = await import('node:http');
  const boot = `const registryState={epoch:0}; let adminSessionToken='',adminSessionRequest=null;
    const rows=[{id:'demo-a',displayName:'合成账号 A'},{id:'demo-b',displayName:'合成账号 B'}];
    ${apiSource}\n${autonomySource}\n${ownerSource}
    const autonomy=createAutonomousSocialStatusController({document,api,accounts:()=>rows,contextEpoch:()=>0});
    const owner=createPeopleOwnerController({document,api,accounts:()=>rows,contextEpoch:()=>0,confirm:()=>false,beforeUnload:()=>{},onOwnerLoaded:()=>autonomy.load()});
    owner.mount();autonomy.mount();
    for(const b of document.querySelectorAll('#nav [data-page]'))b.addEventListener('click',()=>{
      for(const p of document.querySelectorAll('.page'))p.classList.toggle('active',p.id==='page-'+b.dataset.page);
      for(const n of document.querySelectorAll('#nav [data-page]'))n.classList.toggle('active',n===b);
      if(b.dataset.page==='memory')document.getElementById('secondaryNav').open=true;
      document.getElementById('pageTitle').textContent=b.dataset.page==='memory'?'记忆':'自动化';});
    for(const p of document.querySelectorAll('.page'))p.classList.toggle('active',p.id==='page-automation');
    for(const n of document.querySelectorAll('#nav [data-page]'))n.classList.toggle('active',n.dataset.page==='automation');
    document.getElementById('pageTitle').textContent='自动化 · 合成预览';
    document.getElementById('sideStatus').textContent='离线合成预览';
    for(const b of document.querySelectorAll('.toolbar button'))b.disabled=true;
    owner.loadOwner();`;
  const preview = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('</head>', '<script src="/console-theme.js"></script></head>').replace('</body>', `<script>${boot}</script></body>`);
  const server = createServer((req, res) => {
    if (req.method !== 'GET') { res.writeHead(405); res.end('read only'); return; }
    const assets = { '/console.css': '../public/console.css', '/console-theme.js': '../public/console-theme.js' };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'none'; connect-src 'self'");
    if (assets[req.url]) { res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(new URL(assets[req.url], import.meta.url))); return; }
    const data = req.url === '/api/admin/session' ? { token: 'SYNTHETIC_SESSION' }
      : req.url === '/api/owner/status' ? ownerData() : req.url === '/api/owner/autonomy' ? autonomyData() : null;
    if (data) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); return; }
    if (req.url !== '/') { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(preview);
  });
  server.listen(0, '127.0.0.1', () => console.log(`PREVIEW http://127.0.0.1:${server.address().port}`));
}
