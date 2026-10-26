// Offline DOM/HTTP fixtures only. No bridge imports/startup, user state, QQ or models.
// node scripts/digital-life-ui-self-test.js
// node scripts/digital-life-ui-self-test.js --preview [loopback-port, default 6336]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`^    (?:async )?function ${name}\\(`, 'm'));
  const end = html.indexOf('\n    }', start);
  assert(start >= 0 && end > start, `missing ${name}`);
  return html.slice(start, end + 6);
}
const copy = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const policy = () => ({ enabled: false, socialPreset: 'existing', work: { enabled: false, backendId: 'local', capabilities: [], maxActions: 12 } });
const backends = () => [
  { id: 'local', verified: true, available: true, capabilities: ['public_web', 'isolated_files'], reason: '虚构 fixture，未连接真实执行器' },
  { id: 'gui-unconfigured', verified: false, available: false, capabilities: ['desktop_observe', 'desktop_input', 'app', 'external_write', 'authenticated_browser'], reason: '未配置 / 未验证，不可执行' }
];
const life = id => ({ ok: true, revision: 'r1', accountId: id, logicalBotId: `account:${id}`, policy: policy(), activity: { state: 'idle' }, episodes: [], backends: backends(), gui: { available: false, verified: false } });
const task = (id = 't-a', accountId = 'a') => ({ id, accountId, logicalBotId: `account:${accountId}`, revision: 1, permissionTier: 'owner', status: 'waiting_permission', summary: '虚构任务', currentStage: 'planning', grants: [] });

async function selfTest() {
  let checks = 0;
  const check = (name, fn) => { try { fn(); checks++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } };
  const nodes = new Map(), requests = [], urls = new Set(), revoked = [], timers = [], blobTypes = [];
  function node(tag = 'div') {
    const n = { tagName: tag, value: '', checked: false, disabled: false, textContent: '', dataset: {}, children: [], listeners: {}, attrs: {},
      append(...items) { this.children.push(...items); }, appendChild(item) { this.append(item); return item; },
      replaceChildren(...items) { this.children = items; this.textContent = ''; }, setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(k, fn) { this.listeners[k] = fn; }, remove() {}, scrollIntoView() {}, focus() {}, click() { this.clicked = true; }, reset() {},
      querySelectorAll(selector) { return this.children.flatMap(c => [...(selector === 'input' && c.tagName === 'input' ? [c] : []), ...c.querySelectorAll(selector)]); },
      get options() { return this.children; }, classList: { add() {}, remove() {}, toggle() {} }
    }; return n;
  }
  const remote = new Map(['a', 'b'].map(id => [id, life(id)]));
  const s = {
    structuredClone, Headers, Blob, Date, JSON, Number, encodeURIComponent, Set, Map,
    agentLifeState: { selected: 'a', drafts: new Map(), tasksRequest: 0, promptRequest: 0, grant: null, timelineRequest: 0 },
    registryState: { items: [{ id: 'a', displayName: '虚构 A' }, { id: 'b', displayName: '虚构 B' }], epoch: 0 },
    cfg: { taskMode: {} }, taskData: { tasks: [task()] }, activeTaskArtifacts: [], activeArtifactTaskId: '', artifactPreviewRevision: 0, artifactPanelRevision: 0, artifactObjectUrls: new Set(),
    adminSessionToken: '', adminSessionRequest: null, toast() {}, confirm: () => true, prompt: () => '虚构补充要求', window: { addEventListener() {} },
    document: { createElement: node, body: node('body') }, $: id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    URL: { createObjectURL: blob => { blobTypes.push(blob.type); const url = `blob:fixture-${urls.size + revoked.length}`; urls.add(url); return url; }, revokeObjectURL: url => { urls.delete(url); revoked.push(url); } },
    setTimeout: fn => { timers.push(fn); }, renderReviewerAndIntegrity() {}, renderTasks() {},
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === '/api/admin/session') return new Response(JSON.stringify({ token: 'fixture-only-not-a-credential' }));
      if (/^\/api\/tasks(?:[/?]|$)/.test(url)) assert.equal(new Headers(options.headers).get('x-hermes-qq-admin'), 'fixture-only-not-a-credential');
      if (url.startsWith('/api/tasks/agent-life?')) return Response.json(copy(remote.get(new URL(url, 'http://fixture.invalid').searchParams.get('account_id'))));
      if (url.startsWith('/api/accounts/') && options.method === 'PATCH') {
        const id = decodeURIComponent(url.split('/').at(-1)), body = JSON.parse(options.body), current = remote.get(id);
        if (body.expectedRevision !== current.revision) return Response.json({ error: 'revision_conflict' }, { status: 409 });
        current.policy = copy(body.patch.digitalLife); current.revision = `r${Number(current.revision.slice(1)) + 1}`;
        return Response.json({ ok: true, revision: current.revision });
      }
      if (/\/artifacts\//.test(url)) return new Response('fixture artifact text', { headers: { 'content-type': 'text/plain' } });
      if (url.endsWith('/artifacts')) return Response.json({ ok: true, artifacts: [{ id: 'note', name: 'fixture.md', size: 21 }] });
      if (url.endsWith('/events')) return Response.json({ ok: true, events: [{ at: '2026-10-01T00:00:00Z', type: 'stage', stage: 'reviewing', thinking: 'PRIVATE_TRACE', content: 'PRIVATE_FILE', args: { path: '/private/never-show' } }] });
      if (url.startsWith('/api/tasks?')) return Response.json({ ok: true, tasks: [task()], running: 0 });
      if (url === '/api/tasks/prompt-preview') return Response.json({ ok: true, composition: { text: 'fixture composed prompt', layers: [{ id: 'identity' }], diagnostics: [{ code: 'NO_GUI_BACKEND' }] } });
      return Response.json({ ok: true });
    }
  };
  const context = vm.createContext(s);
  const names = ['api', 'ensureAdminSession', 'lifeNode', 'lifeDraft', 'lifeBackendReady', 'renderLifeAccounts', 'renderAgentLife', 'loadAgentLife', 'editAgentLife', 'saveAgentLife', 'lifePolicySignature', 'previewAgentPrompt', 'clearTaskPanels', 'grantCapability', 'grantAvailability', 'taskGrantBody', 'renderTaskGrant', 'openTaskGrant', 'submitTaskGrant', 'taskStageLabel', 'showTaskTimeline', 'taskAction', 'wireAgentLife', 'showTaskArtifacts', 'previewTaskArtifact', 'fetchTaskArtifact', 'releaseArtifactUrls', 'closeTaskArtifacts', 'downloadTaskArtifact', 'refreshAgentFeatures'];
  const constants = ['agentWorkLabels', 'taskGrantActions'].map(name => html.match(new RegExp(`^    const ${name} = .*;$`, 'm'))?.[0]).join('\n');
  vm.runInContext(constants + '\n' + names.map(source).join('\n'), context);
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!/\bsrc=/.test(attrs)) check('inline syntax', () => new vm.Script(body));
  check('no inline handlers', () => assert.doesNotMatch(html, /\bonclick\s*=/i));
  check('no token URLs', () => assert.doesNotMatch(html, /(?:href|src|url|path)\s*=.*[?&](?:token|x-hermes-qq-admin)=/i));
  check('no legacy global computer grant', () => assert.doesNotMatch(source('taskAction'), /prompt\([^\n]*授权|computer/));
  check('new forms excluded from legacy config dirty listener', () => assert.match(source('wireEvents'), /el\.closest\("[^"\n]*#agentLifePanel, #taskGrantPanel/));
  check('legacy task disclosure targets original task grid', () => { assert.match(html, /id="taskQueueGrid"/); assert.match(source('mountAdminPanels'), /const taskGrid = \$\("taskQueueGrid"\)/); });
  const realFetch = s.fetch;
  for (const [url, method] of [['/api/tasks', 'GET'], ['/api/tasks?account_id=a', 'GET'], ['/api/tasks/t-a/grant', 'POST'], ['/api/tasks/t-a/revoke', 'POST'], ['/api/tasks/prompt-preview', 'POST'], ['/api/tasks/t-a/events', 'GET']]) {
    await s.api(url, { method });
    const request = requests.at(-1);
    check('tasks session header all reads/writes', () => assert.equal(new Headers(request.options.headers).get('x-hermes-qq-admin'), 'fixture-only-not-a-credential'));
    check('tasks no-store and no redirect', () => { assert.equal(request.options.cache, 'no-store'); assert.equal(request.options.redirect, 'error'); });
  }
  let forbiddenCalls = 0;
  s.fetch = async () => { forbiddenCalls++; return Response.json({ error: 'forbidden' }, { status: 403 }); };
  await assert.rejects(s.api('/api/tasks/t-a/grant', { method: 'POST' }));
  check('403 clears token without replay', () => { assert.equal(forbiddenCalls, 1); assert.equal(s.adminSessionToken, ''); });
  s.fetch = realFetch;
  await s.loadAgentLife('a'); await s.loadAgentLife('b');
  const a = s.lifeDraft('a'), b = s.lifeDraft('b');
  a.policy.work.maxActions = ''; a.dirty = true; a.edit++;
  await s.loadAgentLife('a');
  check('poll preserves invalid raw draft', () => { assert.equal(a.policy.work.maxActions, ''); assert.equal(a.revision, 'r1'); });
  remote.get('a').revision = 'r2'; remote.get('a').policy.socialPreset = 'observant';
  await s.loadAgentLife('a');
  check('poll pins CAS with conflict', () => { assert.equal(a.revision, 'r1'); assert(a.conflict); assert.equal(a.policy.socialPreset, 'existing'); assert.equal(a.latest.policy.socialPreset, 'observant'); });
  const writesBefore = requests.filter(r => r.options.method === 'PATCH').length;
  await s.saveAgentLife();
  check('conflict blocks save', () => assert.equal(requests.filter(r => r.options.method === 'PATCH').length, writesBefore));
  a.revision = a.latest.revision; a.conflict = false; a.policy.work.maxActions = 7;
  s.agentLifeState.selected = 'b'; b.policy.socialPreset = 'engaged'; b.dirty = true;
  s.renderAgentLife({ fields: true }); s.agentLifeState.selected = 'a'; s.renderAgentLife({ fields: true });
  check('account Map restores drafts', () => { assert.equal(s.$('agentWorkMaxActions').value, 7); assert.equal(b.policy.socialPreset, 'engaged'); });
  const delayedSave = deferred();
  s.fetch = async (url, opts) => { if (opts?.method === 'PATCH') await delayedSave.promise; return realFetch(url, opts); };
  const saving = s.saveAgentLife(); await Promise.resolve();
  s.agentLifeState.selected = 'b'; s.renderAgentLife({ fields: true }); delayedSave.resolve(); await saving;
  check('save completion cannot overwrite next account', () => { assert.equal(s.$('agentSocialPreset').value, 'engaged'); assert(b.dirty); assert.equal(remote.get('b').revision, 'r1'); });
  const savedBody = JSON.parse(requests.findLast(r => r.options.method === 'PATCH').options.body);
  check('minimal account CAS patch', () => { assert.deepEqual(Object.keys(savedBody.patch), ['digitalLife']); assert.equal(savedBody.expectedRevision, 'r2'); assert.equal(savedBody.patch.digitalLife.work.maxActions, 7); });
  s.fetch = realFetch; s.agentLifeState.selected = 'a';
  const oldRead = deferred(), stale = copy(remote.get('a'));
  s.fetch = async (url, opts) => url.startsWith('/api/tasks/agent-life?') ? oldRead.promise : realFetch(url, opts);
  const reading = s.loadAgentLife('a'); a.policy.work.maxActions = 9; a.dirty = true; a.edit++;
  // The save's authoritative readback is newer than the pending polling read.
  s.fetch = realFetch; await s.saveAgentLife(); oldRead.resolve(Response.json(stale)); await reading;
  check('stale read cannot roll back saved policy', () => { assert.equal(a.policy.work.maxActions, 9); assert.equal(a.revision, 'r4'); });
  a.policy.work.maxActions = '10'; a.dirty = true; a.edit++;
  remote.get('a').revision = 'r5';
  const conflictWrites = requests.filter(r => r.options.method === 'PATCH').length;
  await s.saveAgentLife();
  check('server CAS 409 retains draft without replay', () => { assert(a.conflict && a.dirty); assert.equal(a.policy.work.maxActions, '10'); assert.equal(a.revision, 'r4'); assert.equal(requests.filter(r => r.options.method === 'PATCH').length, conflictWrites + 1); });
  s.fetch = async (url, opts) => url.startsWith('/api/tasks/agent-life?') ? new Response('', { status: 503 }) : realFetch(url, opts);
  await s.loadAgentLife('a');
  check('load error preserves raw draft with visible disabled state', () => { assert.equal(a.policy.work.maxActions, '10'); assert.match(a.error, /加载失败/); assert(s.$('saveAgentLifeBtn').disabled); });
  s.fetch = realFetch; await s.loadAgentLife('a');
  check('load recovery does not silently rebase conflict', () => { assert.equal(a.error, ''); assert(a.conflict); assert.equal(a.revision, 'r4'); });
  a.revision = a.latest.revision; a.conflict = false;
  s.fetch = async (url, opts) => opts?.method === 'PATCH' ? Response.json({ ok: true }) : realFetch(url, opts);
  await s.saveAgentLife();
  check('unapplied PATCH cannot claim saved or discard draft', () => { assert(a.dirty); assert.equal(a.policy.work.maxActions, '10'); assert.match(a.saveError, /回读/); assert.match(s.$('agentLifeFeedback').textContent, /回读/); });
  s.fetch = async (url, opts) => opts?.method === 'PATCH' ? Response.json({ error: 'fixture_save_failure' }, { status: 500 }) : realFetch(url, opts);
  await s.saveAgentLife(); await s.loadAgentLife('a');
  check('poll cannot erase visible save failure', () => { assert(a.dirty); assert.match(a.saveError, /fixture_save_failure/); assert.match(s.$('agentLifeFeedback').textContent, /fixture_save_failure/); });
  s.fetch = realFetch;
  a.policy.work.backendId = 'gui-unconfigured'; a.policy.work.enabled = true; a.dirty = true;
  const beforeUnavailableSave = requests.length; await s.saveAgentLife();
  check('unverified GUI blocked', () => { assert.equal(requests.length, beforeUnavailableSave); assert.equal(s.lifeBackendReady({ available: true }), false); assert.equal(s.lifeBackendReady({ verified: true }), false); });
  a.policy.work.backendId = 'local'; a.policy.work.enabled = false;
  const ownerTask = task();
  const fields = { type: 'read', target: '/fixture/report.md', actions: 'read', expiresInMs: 60000 };
  const body = s.taskGrantBody(ownerTask, fields);
  check('read grant exact nonrecursive scope', () => { assert.equal(body.expectedRevision, 1); assert.equal(body.scope.path, fields.target); assert.equal(body.scope.recursive, false); });
  for (const patch of [{ type: 'computer' }, { target: '*' }, { target: '/' }, { target: '/./' }, { target: '/fixture/../' }, { actions: 'read,write' }, { expiresInMs: 0 }, { expiresInMs: 3600001 }]) check('reject broad/invalid grants', () => assert.throws(() => s.taskGrantBody(ownerTask, { ...fields, ...patch })));
  check('nonowner rejected', () => assert.throws(() => s.taskGrantBody({ ...ownerTask, permissionTier: 'isolated' }, fields)));
  check('missing identity rejected', () => assert.throws(() => s.taskGrantBody({ ...ownerTask, logicalBotId: '' }, fields)));
  const ext = { type: 'external_write', actions: 'send', target: 'fixture-recipient:one', operationDigest: 'a'.repeat(64), expiresInMs: 120000 };
  const externalBody = s.taskGrantBody(ownerTask, ext);
  check('one shot target/digest bounded', () => { assert(externalBody.scope.oneShot); assert.equal(externalBody.scope.target, ext.target); assert.equal(externalBody.scope.operationDigest, ext.operationDigest); });
  for (const patch of [{ operationDigest: 'model-prose' }, { expiresInMs: 120001 }, { target: '*' }]) check('reject unsafe external grant', () => assert.throws(() => s.taskGrantBody(ownerTask, { ...ext, ...patch })));
  check('browser scoped by domain/session', () => { const g = s.taskGrantBody(ownerTask, { type: 'isolated_browser', target: 'example.org', sessionId: 'fixture-session', actions: 'read', expiresInMs: 60000 }); assert.equal(g.scope.domains[0], 'example.org'); assert.equal(g.scope.sessionId, 'fixture-session'); });
  check('desktop not global', () => assert.throws(() => s.taskGrantBody(ownerTask, { ...fields, type: 'desktop_input', target: 'all', actions: 'click' })));
  for (const [type, target, actions] of [['write', '/fixture/report.md', 'write'], ['code', '/fixture/code', 'run'], ['desktop_observe', 'org.example.fixture', 'capture'], ['desktop_input', 'org.example.fixture', 'click'], ['app', 'org.example.fixture', 'launch'], ['authenticated_browser', 'example.org', 'read']]) {
    check(`positive ${type} scope`, () => { const result = s.taskGrantBody(ownerTask, { ...fields, type, target, actions, sessionId: 'fixture-session' }); assert.equal(result.type, type); assert.equal(result.expectedRevision, ownerTask.revision); });
  }
  check('current local manifest is narrow and rejects unavailable grants', () => {
    assert.deepEqual(backends()[0].capabilities, ['public_web', 'isolated_files']);
    for (const type of ['read', 'write', 'isolated_browser', 'authenticated_browser', 'desktop_observe', 'desktop_input', 'app', 'code', 'external_write']) assert(s.grantAvailability(ownerTask, type));
  });
  // Pure wire-shape tests use a separately named synthetic adapter, never the
  // local/visual fixture manifest or an actual Mac file implementation.
  const priorBackends = a.data.backends, priorBackendId = a.data.policy.work.backendId;
  a.data.backends = [{ id: 'unit-read-adapter', verified: true, available: true, capabilities: ['local_read'] }];
  a.data.policy.work.backendId = 'unit-read-adapter';
  s.$('taskGrantType').value = 'read'; s.$('taskGrantExpiry').value = '60000';
  s.openTaskGrant('t-a');
  s.$('taskGrantTarget').value = fields.target; s.$('taskGrantActions').value = 'read'; s.$('taskGrantConfirm').checked = true;
  const savedRefresh = s.refreshAgentFeatures; s.refreshAgentFeatures = async () => {};
  await s.submitTaskGrant();
  check('grant wire exact revision', () => { const req = requests.findLast(r => r.url.endsWith('/grant')); const body = JSON.parse(req.options.body); assert.equal(body.expectedRevision, 1); assert.equal(body.scope.path, fields.target); });
  s.openTaskGrant('t-a'); await s.submitTaskGrant('fixture-grant');
  check('revoke wire exact revision', () => assert.deepEqual(JSON.parse(requests.findLast(r => r.url.endsWith('/revoke')).options.body), { grantId: 'fixture-grant', expectedRevision: 1 }));
  s.openTaskGrant('t-a'); s.taskData.tasks[0].revision++;
  const beforeStaleGrant = requests.length; await s.submitTaskGrant('fixture-grant');
  check('stale task cannot authorize', () => assert.equal(requests.length, beforeStaleGrant));
  s.taskData.tasks[0].revision = 1;
  a.data.backends = priorBackends; a.data.policy.work.backendId = priorBackendId;
  await s.taskAction('t-a', 'resume');
  check('resume carries exact revision', () => assert.deepEqual(JSON.parse(requests.findLast(r => r.url.endsWith('/resume')).options.body), { expectedRevision: 1 }));
  await s.taskAction('t-a', 'supplement');
  check('supplement carries revision and text', () => assert.deepEqual(JSON.parse(requests.findLast(r => r.url.endsWith('/supplement')).options.body), { expectedRevision: 1, text: '虚构补充要求' }));
  delete s.taskData.tasks[0].revision; const beforeMissingRevision = requests.length;
  await assert.rejects(s.taskAction('t-a', 'resume'), /修订/);
  await assert.rejects(s.taskAction('t-a', 'supplement'), /修订/);
  check('missing revision blocks noncancel before wire', () => assert.equal(requests.length, beforeMissingRevision));
  await s.taskAction('t-a', 'cancel');
  check('cancel remains revision exempt', () => assert.deepEqual(JSON.parse(requests.findLast(r => r.url.endsWith('/cancel')).options.body), {}));
  s.taskData.tasks[0].revision = 1; s.refreshAgentFeatures = savedRefresh;
  await s.showTaskTimeline('t-a');
  const timeline = s.$('taskTimelineList').children.map(n => n.textContent).join(' ');
  check('timeline safe metadata only', () => { assert.match(timeline, /reviewing/); assert.doesNotMatch(timeline, /PRIVATE_TRACE|PRIVATE_FILE|private\/never/); });
  const latePrompt = deferred(); s.$('agentPromptMode').value = 'task';
  s.fetch = async (url, opts) => url.endsWith('prompt-preview') ? latePrompt.promise : realFetch(url, opts);
  const prompt = s.previewAgentPrompt(); s.agentLifeState.selected = 'b';
  latePrompt.resolve(Response.json({ ok: true, composition: { text: 'old account prompt' } })); await prompt;
  check('prompt old account response ignored', () => assert.notEqual(s.$('agentPromptPreview').textContent, 'old account prompt'));
  s.fetch = realFetch; s.agentLifeState.selected = 'a'; await s.previewAgentPrompt();
  check('prompt preview contract', () => { assert.equal(s.$('agentPromptPreview').textContent, 'fixture composed prompt'); assert.deepEqual(JSON.parse(requests.findLast(r => r.url.endsWith('prompt-preview')).options.body), { accountId: 'a', mode: 'task' }); });
  await s.showTaskArtifacts('t-a');
  check('text preview authenticated', () => { assert.equal(s.$('taskArtifactPreview').children[0].textContent, 'fixture artifact text'); assert(!requests.at(-1).url.includes('token=')); });
  await s.previewTaskArtifact({ id: 'image', name: 'image.png', size: 5 });
  check('image uses blob URL', () => assert.match(s.$('taskArtifactPreview').children[0].src, /^blob:/));
  await s.previewTaskArtifact({ id: 'pdf', name: 'note.pdf', size: 5 });
  check('native PDF with pinned MIME and image URL revoked', () => { assert.equal(s.$('taskArtifactPreview').children[0].attrs.referrerpolicy, 'no-referrer'); assert.equal(blobTypes.at(-1), 'application/pdf'); assert.match(s.$('taskArtifactPreview').children[0].src, /^blob:/); assert.equal(revoked.length, 1); });
  await s.downloadTaskArtifact({ id: 'note', name: 'fixture.md' });
  check('download authenticated before blob link', () => assert.match(s.document.body.children.at(-1).href, /^blob:/));
  s.closeTaskArtifacts();
  check('close revokes every object URL', () => { assert.equal(urls.size, 0); assert.equal(s.artifactObjectUrls.size, 0); });
  let binaryForbiddenCalls = 0;
  s.fetch = async () => { binaryForbiddenCalls++; return new Response('', { status: 403 }); };
  await assert.rejects(s.fetchTaskArtifact('t-a', 'note'));
  check('binary 403 clears session without replay or URL', () => { assert.equal(binaryForbiddenCalls, 1); assert.equal(s.adminSessionToken, ''); assert.equal(urls.size, 0); });
  s.fetch = realFetch; await s.ensureAdminSession();
  const delayedArtifact = deferred();
  s.fetch = async (url, opts) => /\/artifacts\//.test(url) ? delayedArtifact.promise : realFetch(url, opts);
  s.activeArtifactTaskId = 't-a'; const latePreview = s.previewTaskArtifact({ id: 'image', name: 'image.png', size: 5 });
  s.closeTaskArtifacts(); s.activeArtifactTaskId = 't-b'; s.$('taskArtifactPreview').textContent = 'new task panel';
  delayedArtifact.resolve(new Response('late bytes')); await latePreview;
  check('old image cannot write new panel or leak URL', () => { assert.equal(s.$('taskArtifactPreview').textContent, 'new task panel'); assert.equal(urls.size, 0); });
  const delayedText = deferred(); s.activeArtifactTaskId = 't-a';
  s.fetch = async () => delayedText.promise;
  const lateText = s.previewTaskArtifact({ id: 'note', name: 'note.md', size: 5 }); s.closeTaskArtifacts();
  delayedText.resolve(new Response('old text')); await lateText;
  check('closed text preview ignores late response', () => assert.equal(s.$('taskArtifactPreview').children.length, 0));
  const delayedDownload = deferred(); s.activeArtifactTaskId = 't-a';
  s.fetch = async () => delayedDownload.promise;
  const oldDownload = s.downloadTaskArtifact({ id: 'note', name: 'old.md' }); s.closeTaskArtifacts();
  delayedDownload.resolve(new Response('old download')); await oldDownload;
  check('closed download never creates link or URL', () => assert.equal(urls.size, 0));
  s.fetch = realFetch;
  await s.refreshAgentFeatures();
  check('tasks account filter', () => assert(requests.some(r => /^\/api\/tasks\?account_id=a&/.test(r.url))));
  // Exercise a late list response too, independently of media/text races.
  const delayedList = deferred();
  s.fetch = async (url, opts) => url === '/api/tasks/t-old/artifacts' ? delayedList.promise : realFetch(url, opts);
  const oldList = s.showTaskArtifacts('t-old'); await s.showTaskArtifacts('t-new');
  delayedList.resolve(Response.json({ ok: true, artifacts: [{ id: 'old', name: 'old.md' }] })); await oldList;
  check('old artifact list cannot replace new task', () => { assert.equal(s.activeArtifactTaskId, 't-new'); assert.equal(s.activeTaskArtifacts[0].id, 'note'); });
  s.closeTaskArtifacts(); timers.forEach(fn => fn());
  check('cleanup leaves no URLs', () => assert.equal(urls.size, 0));
  console.log(JSON.stringify({ ok: true, checks, offline: true, fixtureOnly: true, bridgeStarted: false, liveDataTouched: false }));
}

// Optional visual QA: extend the existing safe console fixture with ONLY fictional
// Agent/task endpoints. Memory-only writes, no real bridge/auth/model execution.
async function preview(port) {
  assert(Number.isInteger(port) && port > 0 && port < 65536);
  const { createPreviewServer } = await import('./console-preview-server.js');
  const server = createPreviewServer({ stateRoot: '/preview/digital-life-no-state-io' });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  console.log(`Fictional Phase5 UI: http://127.0.0.1:${port}/admin (memory-only; no real bridge, QQ, models or user data)`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
}

if (process.argv[2] === '--preview') await preview(Number(process.argv[3] || 6336));
else { assert.equal(process.argv.length, 2, 'usage: digital-life-ui-self-test.js [--preview [port]]'); await selfTest(); }
