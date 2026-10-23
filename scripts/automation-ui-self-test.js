import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeAutomationRule } from '../src/automation-rules.js';

const html = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
function source(name) {
  const start = html.search(new RegExp(`^    (?:async )?function ${name}\\(`, 'm'));
  const end = html.indexOf('\n    }', start);
  assert(start >= 0 && end > start, name);
  return html.slice(start, end + 6);
}
const nodes = new Map(), forms = new Map(), requests = [];
const node = () => ({ value: '', checked: false, textContent: '', disabled: false, children: [],
  replaceChildren(...values) { this.children = values; }, contains: () => false });
const remote = new Map(['a', 'b'].map(id => [id, { ok: true, revision: 'r1', accountId: id, owner: { key: `account:${id}`, kind: 'account', id },
  enabled: true, rules: [{ id: `${id}-rule`, prompt: `${id} saved` }], routines: { version: 1 }, catalog: [] }]));
const state = {
  structuredClone, Date, encodeURIComponent, JSON,
  automationAccounts: { selected: '', drafts: new Map() }, automationRulesDraft: [], selectedAutomationRuleIndex: -1,
  automationEditorIds: ['prompt'], dirtyScopes: new Set(), routineState: null,
  newRoutineState: () => ({ revision: null, value: null, dirty: false, dirtyPaths: new Set(), catalog: [], loadedAt: 0 }),
  registryState: { items: [{ id: 'a', displayName: 'A' }, { id: 'b', displayName: 'B' }], groups: [] },
  registryItem: id => state.registryState.items.find(item => item.id === id),
  document: { createElement: node, activeElement: null, querySelectorAll: () => [], getElementById: () => node() },
  $: id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
  getVal: id => forms.get(id), setVal: (id, value) => forms.set(id, value),
  renderAutomationTargetPicker() {}, renderRoutines() {}, renderSaveState() {}, toggleAutomationTriggerFields() {}, setBusy() {}, toast() {}, confirm: () => true,
  loadAutomationEditor: () => forms.set('automationRule.prompt', state.automationRulesDraft[state.selectedAutomationRuleIndex]?.prompt || ''),
  automationPatch: () => { state.automationRulesDraft[state.selectedAutomationRuleIndex].prompt = forms.get('automationRule.prompt'); return { enabled: forms.get('automation.enabled'), rules: structuredClone(state.automationRulesDraft) }; },
  sensitiveApi: async (url, method, body) => {
    requests.push({ url, method, body: structuredClone(body) }); const id = url.split('/').at(-1);
    if (method === 'PATCH') { Object.assign(remote.get(id), structuredClone(body), { revision: 'r2' }); delete remote.get(id).expectedRevision; }
    return structuredClone(remote.get(id));
  }
};
const context = vm.createContext(state);
vm.runInContext(`const automationBaseline = result => JSON.stringify({owner:result.owner,enabled:result.enabled,rules:result.rules,routines:result.routines});\n` +
  ['rememberAutomationDraft', 'showAutomationDraft', 'renderAutomationAccountState', 'selectAutomationAccount', 'refreshRoutines', 'saveAccountAutomation'].map(source).join('\n'), context);
let checks = 0;
const check = fn => { fn(); checks++; };
await state.selectAutomationAccount('a');
check(() => assert.equal(forms.get('automationRule.prompt'), 'a saved'));
forms.set('automationRule.prompt', 'A unsaved invalid input');
const a = state.automationAccounts.drafts.get('a'); a.dirty = true; a.editVersion++;
await state.selectAutomationAccount('b');
check(() => assert.equal(forms.get('automationRule.prompt'), 'b saved'));
forms.set('automationRule.prompt', 'B unsaved');
const b = state.automationAccounts.drafts.get('b'); b.dirty = true; b.editVersion++;
await state.selectAutomationAccount('a');
check(() => assert.equal(forms.get('automationRule.prompt'), 'A unsaved invalid input'));
await state.saveAccountAutomation();
check(() => assert.equal(remote.get('a').rules[0].prompt, 'A unsaved invalid input'));
check(() => assert.equal(remote.get('b').rules[0].prompt, 'b saved'));
await state.selectAutomationAccount('b');
check(() => assert.equal(forms.get('automationRule.prompt'), 'B unsaved'));
check(() => assert.equal(b.dirty, true));
remote.get('b').revision = 'r2'; // only A changed globally, B content is identical.
await state.refreshRoutines({ force: true });
check(() => assert(!b.conflict && !b.routine.conflict));
remote.get('b').rules[0].prompt = 'remote B change'; remote.get('b').revision = 'r3';
await state.refreshRoutines({ force: true });
check(() => assert(b.conflict && !b.routine.conflict));
check(() => assert.equal(forms.get('automationRule.prompt'), 'B unsaved'));

// A delayed A save completes while B is being edited. Neither B's DOM nor its
// revision/draft may be replaced by A's response.
await state.selectAutomationAccount('a'); forms.set('automationRule.prompt', 'A delayed'); a.dirty = true; a.editVersion++;
let release;
const savedApi = state.sensitiveApi;
state.sensitiveApi = async (url, method, body) => {
  if (method === 'PATCH') await new Promise(resolve => { release = resolve; });
  return savedApi(url, method, body);
};
const pending = state.saveAccountAutomation();
await state.selectAutomationAccount('b'); release(); await pending;
check(() => assert.equal(state.automationAccounts.selected, 'b'));
check(() => assert.equal(forms.get('automationRule.prompt'), 'B unsaved'));
check(() => assert.equal(b.routine.revision, 'r3'));
check(() => assert.equal(b.dirty, true));
check(() => assert(requests.filter(request => request.method === 'PATCH').every(request => request.url.endsWith('/a'))));
await state.selectAutomationAccount('a');
forms.set('automationRule.prompt', 'sent draft'); a.dirty = true; a.editVersion++;
const typingSave = state.saveAccountAutomation();
forms.set('automationRule.prompt', 'typed during save'); a.dirty = true; a.editVersion++;
release(); await typingSave;
check(() => assert.equal(forms.get('automationRule.prompt'), 'typed during save'));
check(() => assert(a.dirty));
// A polling response prepared before a save must not overwrite the newer data.
state.sensitiveApi = savedApi;
a.dirty = false;
let releaseRead;
const oldSnapshot = structuredClone(remote.get('a'));
state.sensitiveApi = async (url, method, body) => method === 'GET'
  ? new Promise(resolve => { releaseRead = () => resolve(oldSnapshot); }) : savedApi(url, method, body);
const staleRead = state.refreshRoutines({ force: true });
forms.set('automationRule.prompt', 'newest saved'); a.dirty = true; a.editVersion++;
await state.saveAccountAutomation(); releaseRead(); await staleRead;
check(() => assert.equal(forms.get('automationRule.prompt'), 'newest saved'));
check(() => assert.equal(a.rules[0].prompt, 'newest saved'));
// Exercise the actual editor, including its date parser and persisted raw drafts.
const fieldIds = JSON.parse(html.match(/const automationEditorIds = (\[[^;]+\]);/)[1]);
state.automationEditorIds = fieldIds;
const editorNodes = new Map();
const editorNode = () => ({ disabled: false, textContent: '', classes: new Set(),
  classList: { add() {}, remove() {}, toggle() {} } });
const visibility = new Map(['schedule', 'command', 'at', 'window'].map(key => [`.automation-${key}`, [{ classList: { toggle: (_, hidden) => visibility.set(key, hidden) } }]]));
const editor = {
  Date, Intl, automationRulesDraft: [], selectedAutomationRuleIndex: 0,
  getVal: id => forms.get(id), setVal: (id, value) => forms.set(id, Array.isArray(value) ? value.join('\n') : value),
  $: id => { if (!editorNodes.has(id)) editorNodes.set(id, editorNode()); return editorNodes.get(id); },
  document: { querySelectorAll: selector => visibility.get(selector) || [] },
  renderAutomationRules() {}, renderAutomationTargetPicker: () => forms.set('automationRule.target', 'account:a'),
  registryItem: state.registryItem, registryState: state.registryState
};
const editorContext = vm.createContext(editor);
vm.runInContext(['readAutomationAt', 'readAutomationEditor', 'loadAutomationEditor', 'toggleAutomationTriggerFields', 'syncAutomationEditor'].map(source).join('\n'), editorContext);
editor.automationRulesDraft = [{ id: 'once', enabled: true, timezone: 'Asia/Shanghai', accountId: 'a', scope: { conversationIds: ['group:123'] }, trigger: { type: 'at', at: '2030-01-01T09:30:00.125+08:00', windowMinutes: 5 }, action: { kind: 'summary' }, prompt: 'offline only' }];
editor.loadAutomationEditor();
check(() => assert.equal(forms.get('automationRule.at'), '2030-01-01T09:30:00.125'));
check(() => assert.equal(forms.get('automationRule.atOffset'), '+08:00'));
check(() => assert.equal(visibility.get('at'), false));
check(() => assert.equal(visibility.get('command'), true));
const savedRule = editor.readAutomationEditor();
check(() => assert.equal(savedRule.trigger.at, '2030-01-01T01:30:00.125Z'));
check(() => assert.equal(normalizeAutomationRule(JSON.parse(JSON.stringify(savedRule))).trigger.windowMinutes, 5));
editor.automationRulesDraft[0] = savedRule; editor.loadAutomationEditor();
check(() => assert.equal(forms.get('automationRule.atOffset'), 'Z'));
for (const [local, offset] of [['2030-02-29T09:30', 'Z'], ['2030-01-01T09:30', ''], ['2030-01-01T09:30', '+14:01'], ['2030-01-01T24:00', '+08:00']]) check(() => assert.throws(() => editor.readAutomationAt(local, offset)));
check(() => assert.equal(editor.readAutomationAt('2028-02-29T09:30', '+08:00'), '2028-02-29T01:30:00.000Z'));
forms.set('automationRule.at', 'invalid date draft'); forms.set('automationRule.atOffset', '+99:00');
check(() => assert.equal(editor.syncAutomationEditor(), false));
// Real remember/show functions retain raw invalid fields across accounts/pages.
state.sensitiveApi = savedApi;
await state.selectAutomationAccount('a');
forms.set('automationRule.at', 'invalid date draft'); forms.set('automationRule.atOffset', '+99:00');
a.dirty = true; a.editVersion++;
await state.selectAutomationAccount('b');
forms.set('automationRule.at', '2035-01-01T12:00'); forms.set('automationRule.atOffset', '-05:00'); b.dirty = true;
await state.selectAutomationAccount('a'); state.rememberAutomationDraft(); state.showAutomationDraft();
check(() => assert.equal(forms.get('automationRule.at'), 'invalid date draft'));
check(() => assert.equal(forms.get('automationRule.atOffset'), '+99:00'));
await state.selectAutomationAccount('b');
check(() => assert.equal(forms.get('automationRule.atOffset'), '-05:00'));

// Persona review is tested here to stay inside the same UI worker ownership.
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.dataset = {}; this.value = ''; this.disabled = false; this.hidden = false; this._text = ''; this.classList = { toggle() {}, add() {} }; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  get firstChild() { return this.children[0]; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  set innerHTML(_) { throw new Error('unsafe HTML'); }
}
const sections = new Map(['account-functions', 'qa', 'memory', 'automation'].map(page => [`page-${page}`, new Element('section')]));
const malicious = '<img src=x onerror=alert(1)>';
const proposal = (status = 'pending') => ({ kind: 'persona_change', id: `proposal/${status}`, revision: 7, status, changes: [{ field: 'expression', value: malicious }], evidenceMessageIds: ['m1'], conversationId: 'group:123', userId: '9' });
const servers = new Map(['a', 'b'].map(id => [id, { ok: true, revision: 12, policy: {}, state: { proposals: ['pending', 'applying', 'approved', 'rejected', 'failed'].map(proposal) } }]));
const socialRequests = [], confirmations = []; let allowConfirm = true, failure = null, releasePersona;
const social = {
  structuredClone, console, registryState: { items: [{ id: 'a' }, { id: 'b' }], contexts: {} },
  $: id => sections.get(id), document: { createElement: tag => new Element(tag) }, window: { addEventListener() {} },
  confirm: text => { confirmations.push(text); return allowConfirm; },
  api: async (url, options = {}) => {
    socialRequests.push({ url, ...options }); const id = url.split('/')[4]; const server = servers.get(id);
    if (options.method === 'POST') {
      if (releasePersona === 'wait') await new Promise(resolve => releasePersona = resolve);
      if (failure) throw failure;
      const body = JSON.parse(options.body), item = server.state.proposals[0];
      assert.equal(body.expectedRevision, item.revision); assert.equal(body.expectedStateRevision, server.revision);
      item.status = body.decision === 'approve' ? 'approved' : 'rejected'; item.revision++; server.revision++;
      return { ok: true };
    }
    return structuredClone(server);
  }
};
const socialContext = vm.createContext(social);
const socialBlock = html.split('// SOCIAL_AGENT_UI_BEGIN')[1].split('// SOCIAL_AGENT_UI_END')[0];
vm.runInContext(socialBlock.slice(socialBlock.indexOf('\n') + 1) + '\nglobalThis.ui = socialUi;', socialContext);
const ui = social.ui; ui.mount(); await ui.select('audit', 'a');
const flatten = el => [el, ...el.children.flatMap(flatten)];
const buttons = () => flatten(ui.views.audit.sections.proposals).filter(el => el.tagName === 'BUTTON');
check(() => assert.equal(buttons().length, 2, 'only pending has actions'));
check(() => assert.match(ui.views.audit.body.textContent, /将修改该账号角色卡，不修改原提示词/));
check(() => assert.ok(ui.views.audit.body.textContent.includes(malicious)));
check(() => assert.ok(!flatten(ui.views.audit.body).some(el => el.tagName === 'IMG')));
allowConfirm = false; await buttons()[0].listeners.click();
check(() => assert.equal(socialRequests.filter(req => req.method === 'POST').length, 0));
allowConfirm = true;
ui.edit('a', 'profile.identity', 'keep policy draft');
await buttons()[0].listeners.click();
const resolved = socialRequests.find(req => req.method === 'POST');
check(() => assert.equal(resolved.url, '/api/social-agent/accounts/a/persona-proposals/proposal%2Fpending/resolve'));
check(() => assert.deepEqual(JSON.parse(resolved.body), { expectedRevision: 7, expectedStateRevision: 12, decision: 'approve' }));
check(() => assert.ok(confirmations.at(-1).includes(malicious)));
check(() => assert.equal(ui.drafts.get('a').policy.profile.identity, 'keep policy draft'));
check(() => assert(ui.drafts.get('a').dirty));
for (const error of [Object.assign(new Error('conflict'), { status: 409 }), Object.assign(new Error('forbidden'), { status: 403 }), new Error('uncertain network')]) {
  const server = servers.get('a'); server.state.proposals[0] = proposal(); server.state.proposals[0].revision = ++server.revision;
  await ui.load('a'); failure = error;
  const count = socialRequests.filter(req => req.method === 'POST').length;
  const old = buttons()[1]; await old.listeners.click(); await old.listeners.click();
  await ui.select('audit', 'b'); await ui.select('audit', 'a');
  for (const control of buttons()) await control.listeners.click();
  check(() => assert.equal(socialRequests.filter(req => req.method === 'POST').length, count + 1, 'no replay after errors or rerender'));
  check(() => assert(buttons().every(control => control.disabled)));
  check(() => assert.match(ui.views.audit.sections.proposals.textContent, /不会重复提交/, 'error survives refresh/account switching'));
  check(() => assert(ui.drafts.get('a').dirty));
  failure = null;
}
// Audit revision must be the loaded state revision, not an older policy draft.
const serverA = servers.get('a'); serverA.state.proposals[0] = proposal(); serverA.state.proposals[0].revision = ++serverA.revision;
await ui.load('a'); releasePersona = 'wait';
const pendingControls = buttons();
const beforeDelayed = socialRequests.filter(req => req.method === 'POST').length;
const delayed = pendingControls[1].listeners.click();
await pendingControls[0].listeners.click(); await pendingControls[1].listeners.click();
check(() => assert.equal(socialRequests.filter(req => req.method === 'POST').length, beforeDelayed + 1, 'both decisions lock during request'));
await ui.select('audit', 'b'); releasePersona(); await delayed;
check(() => assert.equal(ui.views.audit.selected, 'b', 'late resolve stays on originating account'));
check(() => assert.equal(serverA.state.proposals[0].status, 'rejected'));
check(() => assert.equal(ui.drafts.get('a').policy.profile.identity, 'keep policy draft'));
check(() => assert(socialRequests.every(req => req.url.startsWith('/api/social-agent/accounts/'))));
new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
console.log(JSON.stringify({ ok: true, checks, offline: true, liveStateTouched: false, coverage: 'account drafts/races, at parser/editor/roundtrip/invalid drafts, persona preview/confirm/dual revisions/pending gating/errors/no replay/account isolation' }));
