// Offline focused DOM/interaction checks. Optional --preview serves fictional
// in-memory data on loopback; it never starts the bridge or reads live state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const copy = value => structuredClone(value);
const settings = { enabled: true, shadowMode: true, adminUserIds: ['10001'], groupAdminUserIds: {}, notificationAccountIds: {}, perGroupDailyLimit: 3, cooldownMs: 60000, deferAfterMs: 86400000 };
const learningSettings = { enabled: false, maxWaitMs: 120000, minBatchMessages: 4, maxBatchMessages: 16, maxMessageChars: 4000, maxBatchChars: 12000, settleMs: 5000 };
const sample = (id, status = 'pending') => ({ id, conversationId: '20001', subjectUserId: id === 'case-b' ? '10002' : '10001',
  classification: 'possible_update', classifierReason: '同一人先后给出不同偏好，需核实时间与适用条件', status, revision: 1, createdAt: '2026-10-21T03:00:00Z',
  oldMemory: { id: 'old-a', value: '以前偏好清淡口味', sentAt: 1792461600, sourceMessageIds: ['fixture-old'] },
  newMemory: { id: 'new-a', value: '现在偏好辣味 <img src=x onerror=alert(1)>', sentAt: '2026-10-21T02:00:00Z', sourceMessageIds: ['fixture-new'], sourceMessages: [{ text: '虚构证据，仅用于界面验收', sentAt: '2026-10-21T02:00:00Z' }] } });

if (process.argv.includes('--preview')) {
  const { createPreviewServer } = await import('./console-preview-server.js');
  const server = createPreviewServer();
  const base = server.listeners('request')[0]; server.removeAllListeners('request');
  const cases = [sample('case-a'), sample('case-b'), sample('case-c', 'deferred'), sample('case-d', 'resolved'), ...Array.from({ length: 205 }, (_, i) => sample(`page-${i}`))];
  let injectConflict = true;
  server.on('request', async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/preview/memory-390') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>390px 隔离验收</title><body style="margin:0;background:#eef0f4"><iframe src="/admin" title="390 CSS 像素宽的控制台" style="display:block;width:390px;height:1000px;border:0"></iframe></body></html>');
    }
    if (!url.pathname.startsWith('/api/memory/verification')) return base(req, res);
    const reply = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.headers['x-hermes-qq-admin'] !== 'preview-session-not-a-credential') return reply({ ok: false, error: 'preview_session_required' }, 403);
    if (req.method === 'GET' && url.pathname === '/api/memory/verification') {
      const conversation = (url.searchParams.get('conversation_id') || '').replace(/^group:(\d+)$/, '$1'), status = url.searchParams.get('status');
      if (conversation === '99999') return reply({ ok: false, error: '虚构加载失败；改回空会话后刷新' }, 503);
      const config = await (await fetch(`http://127.0.0.1:${server.address().port}/api/config`)).json();
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 200);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) return reply({ ok: false, error: 'invalid_pagination' }, 400);
      const scoped = cases.filter(item => !conversation || item.conversationId === conversation), filtered = scoped.filter(item => !status || item.status === status);
      const page = filtered.slice(offset, offset + limit), truncated = Math.max(0, filtered.length - offset - page.length);
      return reply({ ok: true, cases: page,
        totals: { ...Object.fromEntries(['pending', 'deferred', 'resolved'].map(status => [status, scoped.filter(item => item.status === status).length])), total: scoped.length, filteredTotal: filtered.length, returned: page.length, truncated },
        pagination: { offset, limit, hasMore: truncated > 0, nextOffset: truncated > 0 ? offset + page.length : null },
        settings: { ...settings, ...config.memory?.verification }, learningSettings: { ...learningSettings, ...config.memory?.learning, enabled: config.memory?.learning?.enabled === true }, configRevision: config.revision });
    }
    if (req.method === 'POST' && ['/api/memory/verification/resolve', '/api/memory/verification/review'].includes(url.pathname)) {
      let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 16384) return reply({ ok: false, error: 'too_large' }, 413); }
      let body; try { body = JSON.parse(text); } catch { return reply({ ok: false, error: 'invalid_json' }, 400); }
      const item = cases.find(item => item.id === body.caseId && item.conversationId === body.conversationId);
      if (!item) return reply({ ok: false, error: 'not_found' }, 404);
      if (injectConflict && item.id === 'case-a' && url.pathname.endsWith('/resolve')) { injectConflict = false; item.revision++; item.stale = true; return reply({ ok: false, error: '虚构修订冲突，请刷新核对' }, 409); }
      if (body.expectedRevision !== item.revision || item.status === 'resolved') return reply({ ok: false, error: 'revision_conflict' }, 409);
      if (url.pathname.endsWith('/review')) { item.revision++; item.stale = false; return reply({ ok: true, case: copy(item) }); }
      if (item.stale) return reply({ ok: false, error: 'review_required' }, 409);
      if (!['update', 'coexist', 'new_invalid', 'old_invalid', 'unsure'].includes(body.action) || (body.action === 'coexist' && !String(body.condition || '').trim())) return reply({ ok: false, error: 'invalid_action' }, 400);
      item.revision++; item.status = body.action === 'unsure' ? 'deferred' : 'resolved'; return reply({ ok: true });
    }
    reply({ ok: false, error: 'unsupported_fixture_route' }, 404);
  });
  const port = Number(process.env.HERMES_QQ_PREVIEW_PORT || 6330);
  server.listen(port, '127.0.0.1', () => console.log(`Fictional memory verification: http://127.0.0.1:${port}/admin; real 390px viewport: /preview/memory-390 (case-a first submit = 409; group 99999 = error; no QQ)`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
} else {
  let checks = 0;
  const check = (description, fn) => { try { fn(); checks++; } catch (error) { throw new Error(description, { cause: error }); } };
  function source(name) {
    const start = html.search(new RegExp(`^    (?:async )?function ${name}\\(`, 'm'));
    const end = html.indexOf('\n    }', start); assert(start >= 0 && end > start, name); return html.slice(start, end + 6);
  }
  class Node {
    constructor(tag = 'div') { this.tagName = tag; this.value = ''; this.textContent = ''; this.disabled = false; this.hidden = false; this.children = []; this.attributes = {}; this.listeners = {}; this.classes = new Set(); this.classList = { toggle: (key, value) => value ? this.classes.add(key) : this.classes.delete(key) }; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.textContent = ''; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    fire(name) { return this.listeners[name]?.({ target: this }); }
    set innerHTML(_) { throw new Error('Untrusted HTML sink forbidden'); }
    set value(value) { this._value = String(value); }
    get value() { return this._value; }
  }
  const nodes = new Map(), requests = [], events = {};
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  $('verificationStatus').value = 'pending';
  const remote = { cases: [sample('case-a'), sample('case-b'), sample('case-c', 'deferred'), sample('case-d', 'resolved')], settings: copy(settings), learningSettings: copy(learningSettings), configRevision: 'config-1' };
  const snapshot = () => ({ ok: true, ...copy(remote), totals: { pending: 2, deferred: 1, resolved: 1 } });
  const state = { $, Date, JSON, encodeURIComponent, structuredClone, renderSaveState() {}, document: { createElement: tag => new Node(tag) }, window: { addEventListener: (name, callback) => { events[name] = callback; } },
    sensitiveApi: async (url, method, body) => { requests.push({ url, method, body: copy(body) }); if (method === 'GET') return snapshot(); return { ok: true }; } };
  const context = vm.createContext(state);
  const declaration = html.match(/    const verificationState = [\s\S]*?};/)[0];
  const names = ['verificationKey', 'verificationSelected', 'verificationDraft', 'verificationText', 'verificationSentTime', 'verificationNode', 'renderVerificationEvidence', 'renderVerificationDecision', 'renderVerificationList', 'fillVerificationSettings', 'renderVerificationSettings', 'refreshMemoryVerification', 'resolveMemoryVerification', 'reviewMemoryVerification', 'collectVerificationSettings', 'saveVerificationSettings', 'wireMemoryVerification'];
  vm.runInContext(declaration + '\n' + names.map(source).join('\n') + '\nglobalThis.store = verificationState;', context);
  const store = state.store, treeText = node => [node.textContent, ...node.children.map(treeText)].join('\n');
  state.wireMemoryVerification();
  check('loading distinct from empty', () => { state.renderVerificationList(); assert.match(treeText($('verificationList')), /尚未加载/); });
  await state.refreshMemoryVerification();
  check('old config explicit false, short bounded readonly summary', () => { assert.equal($('verificationLearningEnabled').checked, false); assert.match($('verificationLearningSummary').textContent, /2 分钟.*4000 字符.*不保证每条消息都提取为长期记忆；不会因本开关自动删除已有记忆，原始聊天按存档设置保留/); assert.match(html, /开启改变后台提取与选取，不修改原记忆；核实默认只记录/); });
  check('admin helper GET, query and totals', () => { assert.equal(requests[0].url, '/api/memory/verification?conversation_id=&status=pending&offset=0&limit=200'); assert.match($('verificationCounts').textContent, /待核实 2.*已暂缓 1.*已处理 1/); });
  $('verificationList').children[0].fire('click');
  check('classifier reason and evidence text safe', () => { assert.match(treeText($('verificationEvidence')), /需核实时间与适用条件/); assert.match(treeText($('verificationEvidence')), /<img src=x onerror=alert\(1\)>/); });
  check('actual sent times, seconds ISO and absent evidence', () => { assert.match(treeText($('verificationEvidence')), /2026-10-21T02:00:00.000Z/); assert.match(state.verificationSentTime(1792461600), /2026-/); assert.match(state.verificationSentTime(null), /未提供/); assert.match(state.verificationSentTime('invalid'), /无法解析/); });
  const keyA = store.selected, draftA = state.verificationDraft(state.verificationSelected());
  $('verificationAction').value = 'coexist'; $('verificationAction').fire('change');
  check('coexist requires condition', () => { assert($('verificationCondition').required); assert($('verificationSubmit').disabled); });
  await state.resolveMemoryVerification();
  check('invalid condition cannot call API', () => assert.equal(requests.filter(req => req.method === 'POST').length, 0));
  $('verificationCondition').value = '以前适用清淡，现在适用辣味'; $('verificationCondition').fire('input');
  check('valid condition enables ONE confirmation', () => assert(!$('verificationSubmit').disabled));
  $('verificationList').children[1].fire('click'); $('verificationAction').value = 'update'; $('verificationAction').fire('change');
  $('verificationList').children[0].fire('click');
  check('per-case action and condition drafts survive switching', () => { assert.equal(store.selected, keyA); assert.equal($('verificationAction').value, 'coexist'); assert.equal($('verificationCondition').value, draftA.condition); });
  $('verificationPerson').value = '10002'; $('verificationPerson').fire('input');
  check('person filter local only', () => { assert.equal($('verificationList').children.length, 1); assert.match(treeText($('verificationList')), /10002/); });
  $('verificationPerson').value = ''; $('verificationPerson').fire('input');
  const defaultApi = state.sensitiveApi;
  let release;
  state.sensitiveApi = async (url, method, body) => { if (method !== 'POST') return defaultApi(url, method, body); requests.push({ url, method, body: copy(body) }); return new Promise(resolve => { release = resolve; }); };
  const pending = state.resolveMemoryVerification(); await state.resolveMemoryVerification();
  check('double-click blocked during processing', () => { assert.equal(requests.filter(req => req.method === 'POST').length, 1); assert($('verificationSubmit').disabled); assert.match($('verificationSubmit').textContent, /处理中/); });
  release({ ok: true }); await pending;
  check('bounded POST payload', () => { const body = requests.find(req => req.method === 'POST').body; assert.deepEqual(body, { conversationId: '20001', caseId: 'case-a', expectedRevision: 1, action: 'coexist', condition: '以前适用清淡，现在适用辣味' }); });
  check('success clears only submitted selection/draft and tells destination', () => { assert.equal(store.selected, ''); assert(!store.drafts.has(keyA)); assert.equal([...store.drafts.values()].find(draft => draft.action === 'update')?.action, 'update'); assert.match($('verificationState').textContent, /已处理，记录移至“已处理”/); assert.doesNotMatch($('verificationState').textContent, /原选中记录|草稿已保留/); assert($('verificationDecision').hidden); });
  state.sensitiveApi = defaultApi;
  $('verificationList').children[0].fire('click');
  $('verificationAction').value = 'old_invalid'; $('verificationAction').fire('change');
  state.sensitiveApi = async (url, method, body) => { if (method === 'POST') throw Object.assign(new Error('revision_conflict'), { status: 409 }); return defaultApi(url, method, body); };
  await state.resolveMemoryVerification();
  const conflictDraft = state.verificationDraft(state.verificationSelected());
  check('409 retains selected/action/condition', () => { assert.equal(store.selected, keyA); assert.equal(conflictDraft.action, 'old_invalid'); assert(conflictDraft.conflict && conflictDraft.needsRefresh); assert($('verificationSubmit').disabled); assert.match($('verificationState').textContent, /刷新.*核对/); });
  check('cannot acknowledge conflict before refresh', () => { $('verificationReview').fire('click'); assert(conflictDraft.conflict); });
  remote.cases[0].revision = 2;
  await state.refreshMemoryVerification();
  check('refresh retains draft and requires explicit review', () => { assert.equal(state.verificationDraft(state.verificationSelected()), conflictDraft); assert.equal(conflictDraft.revision, 1); assert(!$('verificationReview').hidden); assert($('verificationSubmit').disabled); });
  $('verificationReview').fire('click');
  check('review alone advances revision, no mutation', () => { assert.equal(conflictDraft.revision, 2); assert.equal(conflictDraft.baseRevision, 2); assert(!$('verificationSubmit').disabled); });
  state.sensitiveApi = async () => ({ ok: false, error: 'fixture failure' });
  await state.refreshMemoryVerification();
  check('API ok:false is error, not empty success', () => { assert.match($('verificationState').textContent, /加载失败.*fixture failure/); assert.match($('verificationCounts').textContent, /不可用/); assert($('verificationSubmit').disabled); assert.equal(store.cases.length, 4); });
  state.sensitiveApi = defaultApi; await state.refreshMemoryVerification();
  state.sensitiveApi = async () => ({ ok: true, cases: [] }); await state.refreshMemoryVerification();
  check('malformed success rejected', () => assert.match($('verificationState').textContent, /响应不完整/));
  state.sensitiveApi = defaultApi; await state.refreshMemoryVerification();
  let olderRead, newerRead;
  state.sensitiveApi = () => new Promise(resolve => { if (!olderRead) olderRead = resolve; else newerRead = resolve; });
  const oldGet = state.refreshMemoryVerification(), newGet = state.refreshMemoryVerification();
  newerRead({ ...snapshot(), cases: [sample('case-new')] }); await newGet;
  olderRead({ ...snapshot(), cases: [] }); await oldGet;
  check('stale GET cannot replace newer selection/list', () => assert.equal(store.cases[0].id, 'case-new'));
  state.sensitiveApi = defaultApi; await state.refreshMemoryVerification();
  $('verificationGroup').value = '20001'; await state.refreshMemoryVerification();
  check('numeric group filter remains raw backend namespace', () => { assert(requests.some(req => req.url.includes('conversation_id=20001&'))); assert(!requests.some(req => req.url.includes('conversation_id=group%3A20001'))); });
  $('verificationAdmins').value = '10001\n10002'; $('verificationGroupAdmins').value = '{invalid'; $('verificationLearningEnabled').checked = true; $('verificationSettingsFields').fire('input');
  remote.configRevision = 'config-2'; await state.refreshMemoryVerification();
  check('invalid settings draft survives revision refresh', () => { assert.equal($('verificationGroupAdmins').value, '{invalid'); assert.equal($('verificationAdmins').value, '10001\n10002'); assert(store.settingsConflict); assert(!$('verificationSettingsReview').hidden); assert.match($('verificationRemoteSettings').textContent, /最新远端设置/); });
  check('learning draft survives refresh with remote false and shares conflict gate', () => { assert($('verificationLearningEnabled').checked); assert(store.settingsDirty && store.settingsConflict); assert($('verificationSettingsSave').disabled); assert.match($('verificationRemoteSettings').textContent, /"learning".*\n.*"enabled": false/); });
  $('verificationSettingsReview').fire('click'); await state.saveVerificationSettings();
  check('bad JSON never submitted', () => { assert.match($('verificationSettingsState').textContent, /有效 JSON/); assert.equal(requests.filter(req => req.method === 'PATCH').length, 0); });
  $('verificationGroupAdmins').value = '{}'; $('verificationAdmins').value = ''; $('verificationMode').value = 'notify';
  check('notification opt-in requires explicit admin', () => assert.throws(state.collectVerificationSettings, /明确填写/));
  $('verificationMode').value = 'observe';
  check('observe remains no-send shadow mode', () => assert.equal(state.collectVerificationSettings().shadowMode, true));
  $('verificationAdmins').value = '10001'; $('verificationMode').value = 'notify';
  state.sensitiveApi = async (url, method, body) => {
    if (method === 'PATCH') { requests.push({ url, method, body: copy(body) }); remote.settings = copy(body.memory.verification); Object.assign(remote.learningSettings, copy(body.memory.learning)); remote.configRevision = 'config-3'; return { ok: true }; }
    return defaultApi(url, method, body);
  };
  await state.saveVerificationSettings();
  check('settings patch scoped to verification and learning toggle with expected revision', () => { const req = requests.find(req => req.method === 'PATCH'); assert.equal(req.url, '/api/config'); assert.equal(req.body.expectedRevision, 'config-2'); assert.deepEqual(Object.keys(req.body.memory), ['verification', 'learning']); assert.deepEqual(req.body.memory.learning, { enabled: true }); assert.equal(req.body.memory.verification.shadowMode, false); assert(!store.settingsDirty); });
  check('save never overwrites learning tuning params', () => { assert.deepEqual(remote.learningSettings, { ...learningSettings, enabled: true }); assert($('verificationLearningEnabled').checked); });
  $('verificationAdmins').value = '10002'; $('verificationSettingsFields').fire('input');
  state.sensitiveApi = async (url, method, body) => { if (method === 'PATCH') throw Object.assign(new Error('config_conflict'), { status: 409 }); return defaultApi(url, method, body); };
  await state.saveVerificationSettings();
  check('settings 409 retains draft, prevents blind retry', () => { assert.equal($('verificationAdmins').value, '10002'); assert(store.settingsDirty && store.settingsConflict && store.settingsNeedsRefresh); assert($('verificationSettingsSave').disabled); assert.match($('verificationSettingsState').textContent, /修订冲突/); });
  check('learning checkbox participates in same conflict draft', () => assert($('verificationLearningEnabled').checked));
  state.sensitiveApi = defaultApi; await state.refreshMemoryVerification(); $('verificationSettingsReview').fire('click');
  $('verificationLearningEnabled').checked = false; $('verificationSettingsFields').fire('input');
  let releaseLearning;
  state.sensitiveApi = async (url, method, body) => {
    if (method !== 'PATCH') return defaultApi(url, method, body);
    requests.push({ url, method, body: copy(body) });
    await new Promise(resolve => { releaseLearning = resolve; });
    Object.assign(remote.learningSettings, body.memory.learning); remote.configRevision = 'config-4'; return { ok: true };
  };
  const learningSave = state.saveVerificationSettings();
  check('learning save locks existing fieldset and single save', () => { assert($('verificationSettingsFields').disabled); assert($('verificationSettingsSave').disabled); });
  $('verificationLearningEnabled').checked = true; $('verificationSettingsFields').fire('input');
  releaseLearning(); await learningSave;
  check('save snapshot cannot erase learning edits made in flight', () => { assert.equal(requests.findLast(req => req.method === 'PATCH').body.memory.learning.enabled, false); assert($('verificationLearningEnabled').checked); assert(store.settingsDirty); assert.equal(remote.learningSettings.maxMessageChars, 4000); });
  state.sensitiveApi = async () => { const result = snapshot(); delete result.learningSettings; return result; };
  await state.refreshMemoryVerification();
  check('missing learningSettings fails visibly, never guesses defaults from example', () => { assert.match($('verificationState').textContent, /响应不完整/); assert($('verificationSettingsSave').disabled); assert($('verificationLearningEnabled').checked); });
  state.sensitiveApi = defaultApi; await state.refreshMemoryVerification();
  let prevented = false; events.beforeunload({ preventDefault() { prevented = true; } });
  check('new drafts have unload protection', () => assert(prevented));
  const actualShape = sample('actual-api'); actualShape.classification = 'change'; delete actualShape.classifierReason; delete actualShape.oldMemory.sentAt;
  actualShape.oldMemory.evidence = { sourceMessageTimes: { 'fixture-old': '2026-10-20T02:00:00Z' } };
  state.renderVerificationEvidence(actualShape);
  check('canonical preview timestamps and honest classification explanation', () => { const text = treeText($('verificationEvidence')); assert.match(text, /消息 fixture-old · 实际发送时间.*2026-10-20T02:00:00.000Z/); assert.match(text, /可能发生变化.*分类含义；服务端未提供更细原因/); });
  actualShape.stale = true; store.cases = [actualShape]; store.selected = state.verificationKey(actualShape);
  state.verificationDraft(actualShape).action = 'update'; state.renderVerificationDecision();
  check('server stale snapshots cannot be submitted', () => { assert($('verificationSubmit').disabled); assert.match($('verificationDecisionState').textContent, /快照已过期/); });
  actualShape.stale = false;
  state.sensitiveApi = async (url, method, body) => {
    if (method === 'GET') return { ...snapshot(), cases: store.cases };
    requests.push({ url, method, body: copy(body) }); return { ok: true };
  };
  for (const action of ['update', 'new_invalid', 'old_invalid', 'unsure']) {
    actualShape.status = 'pending'; store.selected = state.verificationKey(actualShape); const draft = state.verificationDraft(actualShape); draft.action = action; draft.revision = actualShape.revision;
    await state.resolveMemoryVerification();
    check(`decision ${action} posts one bounded case without stale condition`, () => { const req = requests.at(-1); assert.equal(req.body.action, action); assert(!('condition' in req.body)); assert.equal(actualShape.status, action === 'unsure' ? 'deferred' : 'resolved'); });
    if (action === 'unsure') check('deferred success clears submitted selection and gives correct destination', () => { assert.equal(store.selected, ''); assert.match($('verificationState').textContent, /已暂缓，记录移至“已暂缓”/); });
  }
  actualShape.status = 'resolved'; store.selected = state.verificationKey(actualShape); state.renderVerificationDecision();
  check('resolved case read-only', () => { assert($('verificationAction').disabled); assert($('verificationSubmit').disabled); });
  for (const action of ['update', 'unsure']) {
    const completed = sample(`filtered-${action}`), completedKey = state.verificationKey(completed);
    store.cases = [completed]; store.selected = completedKey; state.verificationDraft(completed).action = action;
    const unrelated = new Map([...store.drafts].filter(([key]) => key !== completedKey));
    state.sensitiveApi = async (_url, method) => method === 'GET' ? { ...snapshot(), cases: [] } : { ok: true };
    await state.resolveMemoryVerification();
    check(`pending-filter ${action} success never claims deleted draft retained`, () => { assert.equal(store.selected, ''); assert(!store.drafts.has(completedKey)); assert.equal(store.drafts.size, unrelated.size); for (const [key, draft] of unrelated) assert.equal(store.drafts.get(key), draft); assert.match($('verificationState').textContent, action === 'unsure' ? /已暂缓，记录移至“已暂缓”/ : /已处理，记录移至“已处理”/); assert.doesNotMatch($('verificationState').textContent, /原选中记录|草稿已保留/); });
  }
  const committed = sample('committed-refresh-error'); store.cases = [committed]; store.selected = state.verificationKey(committed); state.verificationDraft(committed).action = 'update';
  state.sensitiveApi = async (_url, method) => { if (method === 'GET') throw new Error('fixture read failure'); return { ok: true }; };
  await state.resolveMemoryVerification();
  check('post-commit read failure reports completed mutation separately', () => { assert.equal(store.selected, ''); assert.match($('verificationState').textContent, /已处理.*列表刷新失败/); assert.doesNotMatch($('verificationState').textContent, /原选中记录|处理失败/); });
  store.cases = []; store.error = ''; state.renderVerificationList();
  check('genuine loaded empty page never implies exhaustive person search', () => assert.match(treeText($('verificationList')), /当前页没有匹配记录.*仅筛选本页/));
  const reviewCase = sample('review-stale'), reviewKey = state.verificationKey(reviewCase), reviewCalls = [];
  store.cases = [reviewCase]; store.selected = reviewKey;
  const reviewDraft = state.verificationDraft(reviewCase); reviewDraft.action = 'coexist'; reviewDraft.condition = '复核后仍需人工确认的条件';
  let releaseReview, reviewComplete = false, explicitResolved = false;
  state.sensitiveApi = async (url, method, body) => {
    reviewCalls.push({ url, method, body: copy(body) });
    if (method === 'GET') return { ...snapshot(), cases: explicitResolved ? [] : [{ ...copy(reviewCase), revision: reviewComplete ? 3 : 2, stale: !reviewComplete }] };
    if (url.endsWith('/review')) return new Promise(resolve => { releaseReview = resolve; });
    if (!reviewComplete) throw Object.assign(new Error('fixture stale conflict'), { status: 409 });
    explicitResolved = true; return { ok: true };
  };
  await state.resolveMemoryVerification(); await $('verificationReview').fire('click');
  check('409 cannot rebase stale draft until latest preview is loaded', () => { assert(reviewDraft.needsRefresh); assert.equal(reviewCalls.filter(call => call.url.endsWith('/review')).length, 0); assert.equal(reviewDraft.baseRevision, 1); });
  await state.refreshMemoryVerification();
  check('latest stale preview offers explicit server review but never resolve', () => { assert.equal(state.verificationSelected().revision, 2); assert(!$('verificationReview').hidden); assert($('verificationSubmit').disabled); assert.equal(reviewDraft.revision, 1); });
  const reviewPending = $('verificationReview').fire('click');
  await state.reviewMemoryVerification(); await state.resolveMemoryVerification();
  check('stale review posts displayed revision, not old draft baseline', () => { const call = reviewCalls.find(call => call.url.endsWith('/review')); assert.deepEqual(call.body, { conversationId: '20001', caseId: reviewCase.id, expectedRevision: 2 }); });
  check('review locks controls and duplicate review/resolve calls', () => { assert(store.busy); assert($('verificationReview').disabled && $('verificationSubmit').disabled); assert.equal(reviewCalls.filter(call => call.url.endsWith('/review')).length, 1); assert.equal(reviewCalls.filter(call => call.url.endsWith('/resolve')).length, 1); });
  reviewComplete = true; releaseReview({ ok: true, case: { ...copy(reviewCase), revision: 3, stale: false } }); await reviewPending;
  check('review response atomically rebases case and draft while preserving action', () => { assert.equal(store.selected, reviewKey); assert.equal(state.verificationSelected().revision, 3); assert.equal(state.verificationSelected().stale, false); assert.equal(reviewDraft.revision, 3); assert.equal(reviewDraft.baseRevision, 3); assert.equal(reviewDraft.action, 'coexist'); assert.equal(reviewDraft.condition, '复核后仍需人工确认的条件'); assert(!reviewDraft.conflict && !reviewDraft.needsRefresh); assert(!$('verificationSubmit').disabled); });
  check('server review never auto resolves', () => { assert.equal(reviewCalls.filter(call => call.url.endsWith('/resolve')).length, 1); assert.match($('verificationState').textContent, /复核已保存.*再次确认.*不会自动/); });
  await state.resolveMemoryVerification();
  check('separate explicit confirmation uses reviewed revision', () => { const call = reviewCalls.filter(call => call.url.endsWith('/resolve')).at(-1); assert.equal(call.body.expectedRevision, 3); assert.equal(call.body.action, 'coexist'); assert.equal(call.body.condition, '复核后仍需人工确认的条件'); assert.equal(store.selected, ''); });
  for (const failure of [409, 503, 'wrong-case']) {
    const item = { ...sample(`review-fail-${failure}`), revision: 4, stale: true }, key = state.verificationKey(item);
    store.cases = [item]; store.selected = key; store.error = '';
    const draft = state.verificationDraft(item); draft.revision = 3; draft.baseRevision = 3; draft.action = 'update'; draft.condition = '保留其他输入';
    let calls = 0;
    state.sensitiveApi = async () => { calls++; if (failure !== 'wrong-case') throw Object.assign(new Error(`fixture ${failure}`), { status: failure }); return { ok: true, case: { ...item, id: 'foreign-case', stale: false, revision: 5 } }; };
    await state.reviewMemoryVerification(); await state.reviewMemoryVerification();
    check(`review failure ${failure} cannot bless evidence, lose draft or replay`, () => { assert.equal(calls, 1); assert.equal(state.verificationSelected(), item); assert.equal(draft.revision, 3); assert.equal(draft.baseRevision, 3); assert.equal(draft.action, 'update'); assert.equal(draft.condition, '保留其他输入'); assert(draft.conflict && draft.needsRefresh); assert.match($('verificationState').textContent, /复核失败.*草稿保留.*刷新/); assert($('verificationSubmit').disabled); });
  }
  const paged = Array.from({ length: 205 }, (_, i) => sample(`paged-${i}`));
  const pagingRequests = [];
  state.sensitiveApi = async url => {
    pagingRequests.push(url); const query = new URL(url, 'http://offline.invalid').searchParams;
    const offset = Number(query.get('offset')), limit = Number(query.get('limit'));
    const cases = query.get('status') === 'resolved' ? [] : paged.slice(offset, offset + limit);
    const truncated = query.get('status') === 'resolved' ? 0 : Math.max(0, paged.length - offset - cases.length);
    return { ...snapshot(), cases, totals: { pending: 205, deferred: 0, resolved: 0, filteredTotal: query.get('status') === 'resolved' ? 0 : 205, truncated }, pagination: { offset, limit, nextOffset: truncated > 0 ? offset + cases.length : null, hasMore: truncated > 0 } };
  };
  $('verificationGroup').value = ''; $('verificationStatus').value = 'pending'; await state.refreshMemoryVerification();
  check('over-200 cases show partial notice and page boundary controls', () => { assert.equal(store.cases.length, 200); assert.match($('verificationPartialNotice').textContent, /部分加载.*200 条.*后续还有 5 条.*当事人 QQ 仅筛选当前已加载页/); assert($('verificationPrevious').disabled); assert(!$('verificationNext').disabled); });
  $('verificationList').children[0].fire('click'); const firstPageKey = store.selected, firstPageDraft = state.verificationDraft(state.verificationSelected());
  firstPageDraft.action = 'coexist'; firstPageDraft.condition = '分页间保留的适用条件';
  const beforePersonSearch = pagingRequests.length;
  $('verificationPerson').value = '99999'; $('verificationPerson').fire('input');
  check('person empty-page filter is local and explicitly non-exhaustive', () => { assert.equal(pagingRequests.length, beforePersonSearch); assert.match(treeText($('verificationList')), /当前页没有匹配记录.*仅筛选本页/); assert.match($('verificationPartialNotice').textContent, /不代表全部记录/); });
  $('verificationPerson').value = ''; $('verificationPerson').fire('input');
  await $('verificationNext').fire('click');
  check('next page uses backend nextOffset and retains unrelated drafts', () => { assert.match(pagingRequests.at(-1), /offset=200&limit=200/); assert.equal(store.cases.length, 5); assert(!$('verificationPrevious').disabled); assert($('verificationNext').disabled); assert.equal(store.drafts.get(firstPageKey), firstPageDraft); assert.equal(store.selected, firstPageKey); });
  await $('verificationPrevious').fire('click');
  check('previous page restores exact action and condition draft', () => { assert.match(pagingRequests.at(-1), /offset=0&limit=200/); assert.equal($('verificationAction').value, 'coexist'); assert.equal($('verificationCondition').value, '分页间保留的适用条件'); });
  await $('verificationNext').fire('click'); $('verificationStatus').value = 'resolved'; await $('verificationStatus').fire('change');
  check('server status filter resets pagination to first page', () => { assert.match(pagingRequests.at(-1), /status=resolved&offset=0/); assert.equal(store.pagination.offset, 0); assert.equal(store.cases.length, 0); });
  $('verificationGroup').value = '810101'; await state.refreshMemoryVerification();
  check('real raw numeric namespace remains raw with pagination', () => assert.match(pagingRequests.at(-1), /conversation_id=810101&/));
  state.sensitiveApi = async () => ({ ...snapshot(), cases: [sample('truncated-only')], totals: { pending: 205, deferred: 0, resolved: 0, truncated: 204 } });
  await state.refreshMemoryVerification();
  check('legacy truncated-only response never claims exhaustive success', () => { assert.match($('verificationPartialNotice').textContent, /部分加载.*204 条.*未提供分页信息/); assert($('verificationNext').disabled); });
  state.sensitiveApi = async () => ({ ...snapshot(), cases: [sample('bad-page')], pagination: { offset: 0, limit: 200, nextOffset: null, hasMore: false } });
  await state.refreshMemoryVerification({ offset: 200 });
  check('server ignoring offset is a visible error instead of repeating page one', () => { assert.match($('verificationState').textContent, /分页响应不完整或页码不一致/); assert($('verificationPrevious').disabled); assert($('verificationNext').disabled); });
  $('verificationGroupAdmins').value = '{"810101":["10001"]}';
  check('group administrator keys use raw namespace too', () => { assert.deepEqual(JSON.parse(JSON.stringify(state.collectVerificationSettings().groupAdminUserIds)), { '810101': ['10001'] }); $('verificationGroupAdmins').value = '{"group:810101":["10001"]}'; assert.throws(state.collectVerificationSettings, /原始数字群号/); $('verificationGroupAdmins').value = '{}'; });
  const newSource = names.map(source).join('\n');
  check('no HTML interpolation, native dialogs, source-link guesses or QQ test calls', () => { assert.doesNotMatch(newSource, /innerHTML|\b(?:confirm|prompt)\s*\(|\/api\/(?:send|ai\/test)|href\s*=/); });
  check('all actions present and exactly one confirmation button', () => { for (const action of ['update', 'coexist', 'new_invalid', 'old_invalid', 'unsure']) assert(html.includes(`value="${action}"`)); assert.equal((html.match(/id="verificationSubmit"/g) || []).length, 1); });
  check('new inline script parses', () => { for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]); });
  const transportCalls = [];
  let transportStatus = 200;
  const transport = { Headers, JSON, Date, structuredClone, registryState: { epoch: 0, modelLoadedAt: 1 }, fetch: async (url, opts = {}) => {
    transportCalls.push({ url, method: opts.method || 'GET', headers: new Headers(opts.headers), body: opts.body });
    const status = url === '/api/admin/session' ? 200 : transportStatus;
    return { ok: status < 400, status, statusText: 'fixture error', text: async () => JSON.stringify(url === '/api/admin/session' ? { token: 'fixture-admin-session' } : status < 400 ? { ok: true } : { ok: false, error: 'fixture denial' }) };
  } };
  const transportContext = vm.createContext(transport);
  vm.runInContext('let adminSessionToken = "", adminSessionRequest = null;\n' + ['api', 'ensureAdminSession', 'sensitiveApi'].map(source).join('\n'), transportContext);
  const sessions = () => transportCalls.filter(call => call.url === '/api/admin/session').length;
  await transport.api('/api/config'); await transport.api('/health');
  check('ordinary GET does not acquire admin session or attach token', () => { assert.equal(sessions(), 0); assert(transportCalls.every(call => !call.headers.has('x-hermes-qq-admin'))); });
  const supplied = new Headers({ 'x-probe': 'preserved', 'content-type': 'application/merge-patch+json' });
  await transport.api('/api/config?from=owner', { method: 'patch', headers: supplied, body: JSON.stringify({ privateChats: { ownerUserIds: ['10001'] } }) });
  check('generic config PATCH authenticates with no recursive session request', () => { assert.equal(sessions(), 1); assert.equal(transportCalls.at(-1).headers.get('x-hermes-qq-admin'), 'fixture-admin-session'); });
  check('provided headers and original Headers object remain unchanged', () => { assert.equal(transportCalls.at(-1).headers.get('x-probe'), 'preserved'); assert.equal(transportCalls.at(-1).headers.get('content-type'), 'application/merge-patch+json'); assert(!supplied.has('x-hermes-qq-admin')); });
  await transport.sensitiveApi('/api/config', 'PATCH', { memory: { learning: { enabled: true } } });
  check('sensitiveApi supplied token reuses same session', () => { assert.equal(sessions(), 1); assert.equal(transportCalls.at(-1).headers.get('content-type'), 'application/json'); });
  transportStatus = 403;
  const before403 = transportCalls.length;
  await assert.rejects(transport.api('/api/config', { method: 'PATCH', body: '{}' }), error => error.status === 403);
  check('403 clears token and never replays mutation', () => { assert.equal(transportCalls.length, before403 + 1); assert.equal(vm.runInContext('adminSessionToken', transportContext), ''); });
  transportStatus = 200; await transport.api('/api/config');
  check('GET after 403 does not silently recreate session', () => assert.equal(sessions(), 1));
  await transport.api('/api/config', { method: 'PATCH', headers: { 'x-hermes-qq-admin': 'fixture-provided-token', 'x-probe': 'kept' }, body: '{}' });
  check('explicit admin header preserved without extra session', () => { assert.equal(sessions(), 1); assert.equal(transportCalls.at(-1).headers.get('x-hermes-qq-admin'), 'fixture-provided-token'); assert.equal(transportCalls.at(-1).headers.get('x-probe'), 'kept'); });
  await Promise.all([transport.api('/api/config', { method: 'PATCH', body: '{}' }), transport.api('/api/config', { method: 'PATCH', body: '{}' })]);
  check('concurrent config PATCH calls share one session acquisition', () => assert.equal(sessions(), 2));
  transportStatus = 409;
  const before409 = transportCalls.length;
  await assert.rejects(transport.api('/api/config', { method: 'PATCH', body: '{}' }), error => error.status === 409);
  check('409 preserves token and never auto retries a mutation', () => { assert.equal(transportCalls.length, before409 + 1); assert.equal(vm.runInContext('adminSessionToken', transportContext), 'fixture-admin-session'); });
  console.log(JSON.stringify({ ok: true, checks, offline: true, liveStateTouched: false, qqMessagesSent: 0, preview: 'node scripts/memory-verification-ui-self-test.js --preview' }));
}
