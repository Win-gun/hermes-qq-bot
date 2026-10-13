import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

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
console.log(JSON.stringify({ ok: true, checks, offline: true, liveStateTouched: false, coverage: 'per-account drafts, invalid input, conflicts, unrelated revision, delayed saves' }));
