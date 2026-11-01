import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskRuntime } from '../src/task-runtime.js';
import { createOwnerSocialController } from '../src/owner-social-controller.js';
import { createAgentExecutionLoop, createCapabilityRegistry, createTaskDelegationStore } from '../src/social-delegation.js';
import { createExpressionLibrary } from '../src/social-expression-library.js';
import { createStickerCache } from '../src/sticker-cache.js';
import { createMemecubSearch } from '../src/memecub-search.js';
import { createPublicStickerResolver } from '../src/public-sticker-resolver.js';
import { socialExperienceFor, validateSocialExperiencePolicy } from '../src/social-experience-policy.js';
import { validateReplyPlan } from '../src/reply-plan.js';
import { executeReplyPlan } from '../src/expression-renderer.js';
import { ExpressionDiagnostics } from '../src/social-expression-diagnostics.js';
import { createQzoneRuntime } from '../src/qzone-runtime.js';
import { normalizeQzonePolicy, isQzoneSafeText } from '../src/qzone-policy.js';
import { completeText } from '../src/text-completion.js';
import { claimModelCall, settleModelCall, recordOperationalEvent } from '../src/operational-ledger.js';

// Execute the CURRENT bridge functions unchanged, not copied implementations or
// regex assertions about their bodies. Never import/start the bridge. Real
// controller/TaskRuntime/loop/resolver/library/cache/renderer/QZone/ledger modules;
// fake HTTP/DNS/downloader/vision/OneBot and private synthetic temp directories.
assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Use Node 22');
const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const ambientFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('REAL_NETWORK_FORBIDDEN'); };
const directories = [];
let checks = 0;
const temp = name => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name))); directories.push(dir); return dir; };
const digest = input => createHash('sha256').update(input).digest('hex');
function section(start, end, from = 0) {
  const a = source.indexOf(start, from), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, `Current bridge fixture boundary missing: ${start}`);
  return source.slice(a, b);
}
const compile = (body, deps) => new Function(...Object.keys(deps), `"use strict";\n${body}`)(...Object.values(deps));
async function test(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }
async function until(predicate) { for (let i = 0; i < 4000; i++) { if (predicate()) return; await delay(1); } assert.fail('SYNTHETIC_HOST_TIMEOUT'); }
const TARGET = Object.freeze({ accountId: 'alpha', logicalBotId: 'account:alpha', groupId: '10001', conversationId: 'group:10001' });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0uoAAAAASUVORK5CYII=', 'base64');
const sha256 = digest(png);
const toolsCode = section('  const delegationTools = {', '  const capabilityDefinitions =');
const makeTools = deps => compile(`${toolsCode}\nreturn delegationTools;`, deps);

async function controllerFixture() {
  let root = {};
  const live = { revision: 'fixture-revision', session: 'fixture-session', control: 'fixture-control', owner: true, models: 0 };
  const config = { autonomousSocial: { version: 1, enabled: true, guidance: true, delegation: true },
    taskMode: { enabled: true, ownerUserIds: ['20001'], maxTurns: 6, maxRuntimeMs: 10000 } };
  const proofs = compile(section('  const ownerSocialSources = new Map();', '  function captureDelegationTarget(')
    + '\nreturn {ownerSocialEnvelope,verifyOwnerSocialEnvelope,setRevision:v=>{configRevision=v;}};', {
    randomBytes, createHash, configRevision: live.revision, config,
    ownerIdentityVerified: e => e.sessionId === live.session,
    isPrivateOwner: user => live.owner && user === '20001', accountExecutionRevision: () => live.control,
    ownerResolvedTargets: () => [{ accountId: 'alpha', groupId: '10001' }]
  });
  const runtime = new TaskRuntime({ rootDir: temp('host35-controller-'), config: () => config,
    ownerForAccount: () => TARGET.logicalBotId, execute: async () => { throw Error('UNEXPECTED_TASK'); }, notify: async () => {} });
  const controller = createOwnerSocialController({ read: () => root,
    transact: async build => { const draft = structuredClone(root), result = build(draft); root = draft; return result; },
    getConfig: () => config, getRevision: () => live.revision, accounts: () => [{ id: 'alpha', logicalBotId: TARGET.logicalBotId, enabled: true }],
    targets: () => [], verifyEnvelope: proofs.verifyOwnerSocialEnvelope, captureTarget: () => ({}), currentTarget: () => true,
    model: async () => { live.models++; return { kind: 'chat' }; }, registry: createCapabilityRegistry({ list: () => [], tools: {} }), runtime });
  const text = '以后少发表情', at = Date.now();
  const envelope = proofs.ownerSocialEnvelope({ accountId: 'alpha', logicalBotId: TARGET.logicalBotId, ownerUserId: '20001',
    private: true, verified: true, sessionId: live.session, messageId: '10001', time: at }, text);
  return { live, proofs, controller, text, envelope, root: () => root };
}

async function stickerFixture({ forged = false, revokeAtWire = false } = {}) {
  let root = { memory: {} }, library, loop, tail = Promise.resolve();
  const h = { current: true, wires: [], downloads: 0, http: 0, captures: 0, firstSignal: null };
  const dir = temp('host35-stickers-');
  const policy = validateSocialExperiencePolicy({ enabled: true, shadowMode: false, conversationIds: [TARGET.conversationId],
    expression: { minIntervalMs: 0, maxIntervalMs: 0 }, stickers: { enabled: true, autoSend: true, autonomousSelection: true,
      webSearch: true, visionLearning: true, cooldownMs: 0 } });
  const selected = { __activeAccountId: TARGET.accountId, socialExperience: policy, voice: { enabled: false } }, ws = { readyState: 1 };
  const captures = compile(section('  const expressionContentGrants = new WeakMap();', '  const interestWatch =')
    + '\nreturn {issueExpressionContentGrant,captureExpressionContext,expressionContextCurrent};', {
    config: {}, accountById: () => ({ id: 'alpha' }), configForReplyAccount: () => selected,
    accountScopeAllows: () => true, effectiveAccount: () => ({}), accountGroup: () => null,
    oneBotAccounts: new Map([['alpha', { ws }]]), socialExperienceFor,
    logicalBotId: () => TARGET.logicalBotId, accountRuntimeContext: () => ({ logicalBotId: TARGET.logicalBotId }),
    accountExecutionRevision: () => 'r1', accountRuntimeContextCurrent: () => h.current
  });
  library = createExpressionLibrary({ readState: () => root,
    transact: build => { const p = tail.then(() => { const draft = structuredClone(root), value = build(draft); root = draft; return value; }); tail = p.catch(() => {}); return p; },
    capture: (...args) => { h.captures++; return captures.captureExpressionContext(...args); }, isCurrent: captures.expressionContextCurrent,
    clock: Date.now, mediaCache: createStickerCache({ baseDir: path.join(dir, 'cache') }),
    request: async () => { throw Error('UNEXPECTED_PROTOCOL_READ'); },
    downloadImage: async () => { h.downloads++; return { buffer: png, mimeType: 'image/png' }; },
    describeImage: async () => ({ sticker: true, safeToReuse: true, confidence: 0.95, note: '无语', tags: ['无语'], usage: '无语', avoid: [] }) });
  const approval = Object.freeze({});
  const search = createMemecubSearch({ minIntervalMs: 0, isQueryApproved: request => request.approval === approval,
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async () => { h.http++; return new Response(JSON.stringify({ data: [{ title: '无语', kind: 'meme', width: 1, height: 1,
      url: 'https://cdn.memecub.com/fixture.png', page_url: 'https://memecub.com/meme/fixture', markdown: '',
      license: { code: 'provider-claim', commercial_use: false, attribution_required: false } }] }), { headers: { 'content-type': 'application/json' } }); } });
  const resolver = createPublicStickerResolver({ library, search, guard: (_scope, { context, signal }) => !signal?.aborted && h.current
    && (!context || captures.expressionContextCurrent(context)), approveQuery: ({ publicQuery }) => ({ publicQuery, approval }) });
  const deliver = compile(section('async function deliverChatExpression(', '\nasync function ', source.indexOf('async function deliverChatExpression('))
    + '\nreturn deliverChatExpression;', { socialExperienceFor, executeReplyPlan, asArray: x => Array.isArray(x) ? x : [],
      expressionDiagnostics: new ExpressionDiagnostics(), socialEpisodeDeliveredProvider: async () => {} });
  const request = async (_ws, action, params, { binding }) => {
    await Promise.resolve();
    if (revokeAtWire) h.current = false;
    assert.equal(binding.isCurrent(), true, 'actual late binding must still be current');
    h.wires.push({ action, params }); return { message_id: '30001' };
  };
  const offers = new Map();
  const tools = makeTools({ delegationSurface: meta => { meta.guard(); return { selected, ws, context: {}, recent: [],
    event: { message_type: 'group', group_id: 10001, user_id: 20001 } }; },
    taskRuntime: { get: () => ({ socialPrivateContext: false }) }, publicStickerResolver: resolver,
    ...captures, delegationOffers: offers, captureDelegationTarget: () => ({ epoch: 1 }), currentDelegationTarget: () => h.current,
    expressionLibrary: library, socialExperienceFor, memory: {}, aiVoicePlanAllowed: () => false, voiceReplyMode: () => 'text',
    groupSettings: () => ({}), validateReplyPlan, deliverChatExpression: deliver,
    oneBotBinding: () => ({ id: 'alpha', sessionId: 'synthetic' }), oneBotRequest: request,
    toolResult: (target, value, receiptId) => ({ status: 'succeeded', scope: target, value, ...(receiptId ? { receiptId } : {}) }) });
  const registry = createCapabilityRegistry({ tools, list: () => ['search_stickers', 'express'].map(id => ({ id,
    description: id, revision: 1, risk: 'low', cost: 1, effect: id === 'express' ? 'write' : 'read',
    argumentKeys: id === 'express' ? ['messages'] : ['query'], validate: () => true, available: true })) });
  const config = { taskMode: { enabled: true, ownerUserIds: ['20001'], allowedGroupIds: ['10001'], maxTurns: 6, maxRuntimeMs: 10000 } };
  const runtime = new TaskRuntime({ rootDir: dir, config: () => config, ownerForAccount: () => TARGET.logicalBotId,
    execute: (task, runtime) => loop.execute(task, runtime), notify: async () => {} });
  let plans = 0;
  loop = createAgentExecutionLoop({ store: createTaskDelegationStore(runtime), registry,
    capture: () => ({}), guard: () => h.current, authorize: () => true,
    budget: () => ({ maxSteps: 6, maxPlannerCalls: 6, maxUnits: 6, deadline: Date.now() + 10000, maxContextBytes: 16000, maxObservationBytes: 2000 }),
    observe: value => JSON.stringify(value), planner: async () => {
      plans++;
      if (plans === 1) return { action: 'tool', capability: 'search_stickers', args: { query: '无语' } };
      if (plans === 2) {
        if (forged) {
          const assets = root.memory.socialExpressionAssets.bots[TARGET.logicalBotId].stickers;
          const copy = structuredClone(assets[`public_${sha256}`]);
          copy.id = 'unoffered'; assets.unoffered = copy;
        }
        return { action: 'tool', capability: 'express', args: { messages: [{ type: 'sticker', stickerId: forged ? 'unoffered' : `public_${sha256}` }] } };
      }
      return { action: 'complete', summary: '仅合成回执' };
    } });
  // Observe the actual execution loop's search tool lifetime without replacing
  // its bounded() guard/cancellation or the bridge's search/express bodies.
  const searchTool = tools.search_stickers;
  tools.search_stickers = (args, meta) => { h.firstSignal = meta.signal; return searchTool(args, meta); };
  const task = runtime.createOffer({ ...TARGET, messageType: 'group', userId: '20001', objective: '合成测试', requestedTools: [] });
  await loop.start(task.id, { kind: 'goal', objective: '合成测试', target: TARGET }, { verified: true });
  assert.equal(runtime.confirm(task.id, { userId: '20001', accountId: 'alpha', kind: 'human', source: 'qq', verified: true }).ok, true);
  await until(() => !['offered', 'queued', 'planning', 'running', 'reviewing', 'delivering'].includes(runtime.get(task.id).status));
  return { ...h, task: runtime.get(task.id), root: () => root, offers, firstSignal: h.firstSignal };
}

function reconstructionFixture(mode) {
  let memory = { socialAgents: { bots: { [TARGET.logicalBotId]: {} } } }, ledger = {};
  const h = { http: 0, budgetTransactions: 0, ledgerTransactions: 0, current: true, environment: null };
  const ledgerHost = { read: () => ledger, transact: async build => {
    const draft = structuredClone(ledger), result = build(draft); ledger = draft; h.ledgerTransactions++;
    if (mode === 'model_ledger' && h.ledgerTransactions === 1) h.environment.setRevision('r2');
    return result;
  } };
  const modelCode = section('async function callHermes(', '\nfunction callHermesTransport(');
  const model = compile(modelCode + '\nreturn callHermes;', { modelLedgerHost: ledgerHost, randomBytes,
    aiSettingsFromConfig: c => c.ai, logicalBotId: () => TARGET.logicalBotId,
    claimModelCall, settleModelCall, recordOperationalEvent,
    callHermesTransport: async (prompt, selected, options) => completeText({ prompt, model: 'fixture', apiKey: 'fake-only-key',
      baseUrl: 'https://api.fixture.com/v1', reasoningEffort: 'none', returnMetadata: true, signal: options.signal,
      fetchImpl: async () => { h.http++; return new Response(JSON.stringify({ model: 'fixture', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        choices: [{ message: { content: '{"groups":[]}' } }] }), { headers: { 'content-type': 'application/json' } }); } }) });
  const callback = section('          reconstruct: async ({ prompt, binding, scope, signal, maxTokens, attemptId }) => {', '\n          } });') + '\n          }';
  h.environment = compile(`const fn=({${callback}}).reconstruct; return {fn,setRevision:v=>{configRevision=v;}};`, {
    configRevision: 'r1', config: {}, ownerTransact: async build => {
      const draft = structuredClone(memory), result = build(draft); memory = draft; h.budgetTransactions++;
      if (mode === 'budget' && h.budgetTransactions === 1) h.environment.setRevision('r2');
      return result;
    }, reconstructionEligible: () => h.current, socialPolicy: () => ({ maxDailyCalls: 10 }),
    accountRuntimeContextCurrent: () => h.current, oneBotAccounts: new Map([['alpha', { ws: {} }]]),
    configForReplyAccount: () => ({ __activeAccountId: 'alpha', ai: { model: 'fixture' }, ownerControl: { usageEnabled: true } }),
    accountById: () => ({ id: 'alpha' }), callHermes: model, extractJsonObject: JSON.parse });
  h.run = () => h.environment.fn({ prompt: 'synthetic', binding: { logicalBotId: TARGET.logicalBotId, accountId: 'alpha', revision: 'r1', identity: {} },
    scope: { conversationId: TARGET.conversationId }, signal: new AbortController().signal, maxTokens: 2048, attemptId: 'fixture' });
  h.memory = () => memory;
  return h;
}

async function qzoneFixture({ revoke = false } = {}) {
  let memory = {};
  const h = { quiet: false, active: true, writes: 0, beforeWire: null };
  const policy = normalizeQzonePolicy({ enabled: true, mode: 'scoped_autonomy', reviewTransport: 'console',
    publish: { enabled: true, maxDaily: 10, cooldownMs: 0 }, autonomy: { enabled: true } });
  const actorCode = section('  const qzoneAdminActor =', '  const publicIllustrations =');
  const adminCode = section('    isAdministrator: (ctx, actor) =>', '    peerQqs:', source.indexOf('  const qzoneRuntime ='));
  const host = compile(`${actorCode}\nconst check=({${adminCode}}).isAdministrator; return {check,qzoneAdminActor,qzoneAutonomyActor};`, {
    qzoneCurrent: () => h.active, isQuiet: () => h.quiet, memory: {}, config: {}, configForReplyAccount: () => ({}), accountById: () => ({}), isPrivateOwner: () => false });
  const q = createQzoneRuntime({ capture: () => ({ accountId: 'alpha', logicalId: TARGET.logicalBotId, qq: '10001', revision: 'r1', protocolVersion: 'synthetic', policy }),
    isCurrent: () => h.active, readState: () => ({ memory }), transact: async build => { const root = { memory: structuredClone(memory) }, result = build(root); memory = root.memory; return result; },
    isAdministrator: host.check, isLowImpact: () => true, isSourceAllowed: () => true, peerQqs: () => [],
    request: async (_ctx, _action, _params, { binding }) => {
      await Promise.resolve(); h.beforeWire?.();
      assert.equal(binding.isCurrent(), true, 'runtime/host final gate'); binding.onSendStarted(); h.writes++;
      return { status: 'ok', retcode: 0, data: { tid: `synthetic-${h.writes}` } };
    } });
  const ctx = q.open('alpha'), input = content => ({ content, source: { kind: 'public_information', ref: 'fixture' } });
  let first = await q.createDraft(ctx, input('合成首次协议资格'));
  first = await q.submitReview(ctx, first.id, first.revision, host.qzoneAdminActor);
  first = await q.approve(ctx, first.id, first.revision, host.qzoneAdminActor);
  await q.publish(ctx, first.id, first.revision, { actor: host.qzoneAdminActor });
  assert.equal(q.capabilityDescriptors(ctx).find(row => row.kind === 'publish').autonomous, true);
  const next = await q.createDraft(ctx, input('合成持续授权内容'));
  assert.equal(host.check(ctx, structuredClone(host.qzoneAutonomyActor)), false, 'shape is not host authority');
  if (revoke) h.beforeWire = () => { h.quiet = true; };
  const tools = makeTools({ delegationSurface: meta => meta.guard(), qzoneContext: () => ({ ctx }), qzoneRuntime: q,
    qzoneAutonomyActor: host.qzoneAutonomyActor, recordQzoneEpisode: async () => {} });
  const result = await tools.qzone_publish({ draftRef: next.id }, { target: TARGET, guard: () => true, signal: new AbortController().signal });
  return { ...h, result };
}

try {
  await test('actual bridge verifier supports original envelope AND copied actor; real controller passes source gate', async () => {
    const h = await controllerFixture(), receipt = h.proofs.verifyOwnerSocialEnvelope(h.envelope, h.text);
    assert.ok(receipt); assert.equal(h.proofs.verifyOwnerSocialEnvelope(structuredClone(receipt.actor)), true);
    const result = await h.controller.handle(h.envelope, h.text, { kindHint: 'guidance' });
    assert.equal(result.matched, false); assert.equal(h.live.models, 1);
    assert.equal(JSON.stringify(h.root()).includes(h.text), false, 'ephemeral raw proof text is not persisted');
    assert.equal(h.proofs.verifyOwnerSocialEnvelope({ ...receipt.actor, ownerUserId: '30001' }), false);
    h.live.session = 'another-session'; assert.equal(h.proofs.verifyOwnerSocialEnvelope(structuredClone(receipt.actor)), false);
  });
  await test('actual bridge verifier rejects config/control/owner revocation for copied actor overload', async () => {
    for (const mode of ['revision', 'control', 'owner']) {
      const h = await controllerFixture(), receipt = h.proofs.verifyOwnerSocialEnvelope(h.envelope, h.text);
      if (mode === 'revision') h.proofs.setRevision('r2');
      if (mode === 'control') h.live.control = 'r2';
      if (mode === 'owner') h.live.owner = false;
      assert.equal(h.proofs.verifyOwnerSocialEnvelope(structuredClone(receipt.actor)), false);
    }
  });
  await test('actual search/express + real task loop reopen fresh sticker context after search tool cancellation', async () => {
    const h = await stickerFixture();
    assert.equal(h.firstSignal.aborted, true); assert.equal(h.task.status, 'completed');
    assert.equal(h.wires.length, 1); assert.equal(h.downloads, 1); assert.equal(h.http, 1); assert(h.captures >= 2);
    assert.equal(h.root().memory.socialExpressionAssets.bots[TARGET.logicalBotId].stickers[`public_${sha256}`].annotations[TARGET.conversationId].sentCount, 1);
  });
  await test('fresh sticker context cannot promote a newly eligible but previously unoffered ID', async () => {
    const h = await stickerFixture({ forged: true }); assert.equal(h.wires.length, 0); assert.notEqual(h.task.status, 'completed');
  });
  await test('revocation at the fake queued wire still blocks the actual fresh-context delivery', async () => {
    const h = await stickerFixture({ revokeAtWire: true }); assert.equal(h.wires.length, 0); assert.notEqual(h.task.status, 'completed');
  });
  await test('actual reconstruction callback checks binding again after budget publication', async () => {
    const h = reconstructionFixture('budget'); await assert.rejects(h.run(), /RECONSTRUCTION_STALE/); assert.equal(h.http, 0);
  });
  await test('actual callHermes rechecks reconstruction binding after actual model-ledger claim await', async () => {
    const h = reconstructionFixture('model_ledger'); await assert.rejects(h.run(), { code: 'MODEL_CONTEXT_CHANGED' }); assert.equal(h.http, 0);
  });
  await test('current reconstruction path uses real usage from fake HTTP and settles the existing daily ledger', async () => {
    const h = reconstructionFixture('current'), result = await h.run(); assert.equal(h.http, 1);
    assert.deepEqual(result.groups, []); assert.equal(result.usage.inputTokens, 1);
    const day = Object.values(h.memory().socialAgents.bots[TARGET.logicalBotId].runtimeUsage.days)[0];
    assert.equal(day.actualCalls, 1); assert.deepEqual(day.pending, {});
  });
  await test('actual qzone_publish bridge tool supplies the trusted actor accepted by real runtime', async () => {
    const h = await qzoneFixture(); assert.equal(h.writes, 2); assert.equal(h.result.status, 'accepted');
  });
  await test('actual QZone autonomy actor remains quiet-gated at queued wire, not just tool entry', async () => {
    const h = await qzoneFixture({ revoke: true }); assert.equal(h.writes, 1); assert.equal(h.result.status, 'uncertain');
  });
  console.log(JSON.stringify({ ok: true, checks, bridgeSha256: sourceSha256, node: process.versions.node,
    realNetworkCalls: 0, paidCalls: 0, realQQCalls: 0, productionReads: 0, productionChanges: 0 }));
} finally {
  globalThis.fetch = ambientFetch;
  for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true });
}
