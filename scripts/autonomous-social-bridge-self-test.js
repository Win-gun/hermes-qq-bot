// Actual bridge, controller, registry, MemoryRuntime, TaskRuntime and expression
// delivery. Only HTTP model/CDN/DNS and OneBot peers are synthetic. Node 22.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { registryConfig } from '../src/account-registry.js';
import { normalizeApiCenter } from '../src/api-center.js';
import { readMemorySnapshot } from '../src/memory-repository.js';

assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Use Node 22');
const root = path.resolve(import.meta.dirname, '..');
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-social35-')));
const memoryFile = path.join(home, 'data/memory.json'), auditFile = path.join(home, 'network-audit.jsonl');
const OWNER = '21001', PERSON = '22001', GROUP = '31001';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0uoAAAAASUVORK5CYII=', 'base64');
const sha = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const completed = [], calls = [], wire = [], sockets = [], holds = new Map();
let child, base, token, config, log = '', sequence = 51000, responseSequence = 61000;
const memory = () => readMemorySnapshot(memoryFile);
const tasks = () => {
  const directory = path.join(home, 'data/tasks');
  return fs.existsSync(directory) ? fs.readdirSync(directory).flatMap(id => {
    try { return [JSON.parse(fs.readFileSync(path.join(directory, id, 'task.json'), 'utf8'))]; } catch { return []; }
  }) : [];
};
const textOf = row => typeof row.params?.message === 'string' ? row.params.message
  : (row.params?.message || []).filter(s => s.type === 'text').map(s => s.data.text).join('');
const groups = () => wire.filter(row => row.action === 'send_group_msg');
const privates = () => wire.filter(row => row.action === 'send_private_msg');
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw Error(`bridge exited: ${log.slice(-1500)}`);
    try { if (await fn()) return; } catch (e) { if (e.code !== 'MEMORY_READ_BUSY' && e.code !== 'ENOENT') throw e; }
    await pause(25);
  }
  throw Error(`TIMEOUT ${label}; ${JSON.stringify({ tasks: tasks().map(t => ({ id: t.id, status: t.status,
    code: t.socialDelegation?.code, steps: t.socialDelegation?.steps?.map(s => [s.capability, s.status, s.code]) })),
    calls: calls.slice(-4).map(c => ({ account: c.account, kind: c.kind, objective: c.input?.objective })), log: log.slice(-1800) })}`);
}
async function api(route, method = 'GET', body, auth = true) {
  const response = await fetch(base + route, { method, signal: AbortSignal.timeout(10000),
    headers: { origin: base, 'content-type': 'application/json', ...(auth ? { 'x-hermes-qq-admin': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise(r => s.close(r)); return port; }
async function test(name, run) { await run(); completed.push(name); console.log(`PASS ${name}`); }
function event(account, text, { id = ++sequence, userId = OWNER, groupId, selfId, segments } = {}) {
  const self = account === 'alpha' ? 11001 : 11002;
  return { post_type: 'message', message_type: groupId ? 'group' : 'private', sub_type: 'friend',
    self_id: selfId ?? self, user_id: Number(userId), ...(groupId ? { group_id: Number(groupId) } : {}),
    message_id: id, time: Math.floor(Date.now() / 1000), raw_message: text,
    message: segments || [{ type: 'text', data: { text } }], sender: { user_id: Number(userId), nickname: 'FictionalHuman' } };
}
function emit(account, text, options) {
  const value = event(account, text, options); sockets[account === 'alpha' ? 0 : 1].send(JSON.stringify(value)); return value;
}
async function owner(text, account = 'alpha') {
  const before = privates().length, value = emit(account, text);
  await until(() => privates().slice(before).some(row => row.account === account), `private owner receipt: ${text}`);
  return value;
}
function choose(input, account, objective) {
  const target = input.targets.find(t => t.accountId === account && t.groupId === GROUP);
  assert(target, 'classifier must choose a real host candidate');
  return { kind: 'goal', objective, targetId: target.targetId, targetEvidence: `${account}:${GROUP}` };
}
async function respondModel(request, response) {
  let raw = ''; for await (const chunk of request) raw += chunk;
  if (!raw && request.aborted) return;
  const payload = JSON.parse(raw), content = payload.messages.at(-1).content;
  const account = request.url.split('/')[1]; assert(['alpha', 'beta'].includes(account));
  assert.equal(payload.model, `fixture-${account}`); assert.equal(payload.tools, undefined, 'no native model tools');
  let output, kind, input;
  if (Array.isArray(content)) {
    kind = 'vision'; assert(content.some(p => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')));
    output = { note: '开心的通用合成表情', tags: ['开心'], sticker: true, safeToReuse: true,
      confidence: 0.99, usage: '轻松聊天时表达开心', avoid: [] };
  } else {
    try { input = JSON.parse(content.split('\n').at(-1)); } catch { input = {}; }
    kind = input.objective ? 'plan' : input.targets ? 'classify' : 'chat';
    assert(content.includes(`PERSONA_${account.toUpperCase()}_FICTIONAL`), 'current account persona reaches its own bound model');
    assert(!content.includes(`PERSONA_${account === 'alpha' ? 'BETA' : 'ALPHA'}_FICTIONAL`), 'peer persona is not inherited');
    if (input.allowedScopes && input.fields && input.text) {
      kind = 'group_guidance';
      output = { operations: [{ op: 'create', scope: { kind: 'group', groupId: GROUP }, field: 'stickers',
        value: { mode: 'off' }, evidence: '以后不要发表情' }] };
    } else if (kind === 'classify') {
      const text = input.text;
      if (text.includes('HOLD_SOURCE')) {
        const hold = holds.get('source'); hold.entered.resolve(); await hold.release.promise;
      }
      if (text.includes('少套话')) output = { kind: 'guidance', guidance: { operations: [{ op: 'create', scope: { kind: 'bot' },
        field: 'style', value: { tone: 'natural', verbosity: 'concise', instruction: '少套话，保持简洁' }, evidence: '少套话' }] } };
      else if (text.includes('改成开心')) output = { kind: 'control', action: 'correct', objective: 'PRIVATE_OWNER_GOAL_STICKER' };
      else if (text.includes('取消这个委托')) output = { kind: 'control', action: 'cancel' };
      else if (text.includes('继续这个委托')) output = { kind: 'control', action: 'resume' };
      else if (text.includes('持续看空间')) output = choose(input, account, 'PRIVATE_OWNER_GOAL_QZONE_TAINT');
      else if (text.includes('持续准备排队')) output = choose(input, account, 'PRIVATE_OWNER_GOAL_QUEUE');
      else if (text.includes('持续等待取消')) output = choose(input, account, 'PRIVATE_OWNER_GOAL_CANCEL');
      else output = choose(input, account, 'PRIVATE_OWNER_GOAL_OBSERVE');
    } else if (kind === 'plan') {
      const obs = input.observations;
      const tool = (capability, args = {}) => ({ action: 'tool', capability, args });
      if (input.objective.includes('CANCEL')) {
        const hold = holds.get('cancel'); hold.entered.resolve(); await hold.release.promise;
        output = tool('express', { messages: [{ type: 'text', content: 'CANCEL_MUST_NOT_SEND' }] });
      } else if (input.objective.includes('QUEUE')) output = obs.length
        ? { action: 'wait', summary: 'OWNER_RESULT_QUEUE_STOPPED' }
        : tool('express', { messages: [{ type: 'text', content: 'QUEUE_MUST_NOT_SEND' }] });
      else if (input.objective.includes('QZONE')) {
        output = obs.length === 0 ? tool('qzone_read') : obs.length === 1
          ? tool('express', { messages: [{ type: 'text', content: 'PRIVATE_QZONE_SENTINEL_MUST_NOT_PUBLISH' }] })
          : obs.length === 2 ? tool('search_stickers', { query: '开心' }) : { action: 'wait', summary: 'OWNER_RESULT_PRIVACY_BLOCKED' };
      } else if (!obs.some(o => o.capability === 'read_context' && o.controlRevision === input.controlRevision)) output = tool('read_context');
      else if (!input.objective.includes('STICKER')) output = { action: 'wait', summary: 'OWNER_RESULT_OBSERVED_ONLY' };
      else if (!obs.some(o => o.capability === 'search_stickers' && o.controlRevision === input.controlRevision)) output = tool('search_stickers', { query: '开心' });
      else if (!obs.some(o => o.capability === 'express' && o.controlRevision === input.controlRevision)) {
        const search = obs.findLast(o => o.capability === 'search_stickers');
        const observed = JSON.parse(search.observation);
        const id = observed.candidates?.[0]?.id; assert(id, `search must return a qualified real asset: ${search.observation}`);
        output = tool('express', { messages: [{ type: 'sticker', stickerId: id }] });
      } else output = { action: 'complete', summary: `OWNER_RESULT_${account}_ACK_RECORDED` };
    } else output = { action: 'wait', summary: 'no synthetic unsolicited chat' };
  }
  calls.push({ account, kind, input, output });
  response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ model: payload.model,
    choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
}
const model = http.createServer((req, res) => { void respondModel(req, res).catch(e => { log += ` MODEL_FIXTURE:${e.message}`;
  res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'SYNTHETIC_MODEL_ASSERTION' })); }); });
try {
  await new Promise(r => model.listen(0, '127.0.0.1', r));
  config = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
  config.listen = { host: '127.0.0.1', port: await freePort(), path: '/autonomous35' };
  config.control = { ...config.control, host: '127.0.0.1', port: await freePort() }; base = `http://127.0.0.1:${config.control.port}`;
  for (const key of ['proactive', 'socialPlanner', 'discussionParticipation', 'implicitReply', 'learningMode', 'loginRecovery',
    'adminNotifications', 'automation', 'voice', 'webSearch', 'dailyMessages', 'hourlyChat']) config[key] = { enabled: false };
  config.ownerFirst = { version: 1, optOuts: { ownerNotifications: true } };
  config.autonomousSocial = { version: 1, enabled: true, guidance: true, delegation: true, reconstruction: false };
  config.ownerNotifications = { enabled: false };
  config.ownerControl = { enabled: true, naturalLanguage: false, usageEnabled: true, lowRiskDirect: true,
    targetMode: 'explicit', allowedTargets: ['alpha', 'beta'].map(accountId => ({ accountId, groupId: GROUP })) };
  config.privateChats = { enabled: true, targetUsers: [OWNER], ownerUserIds: [OWNER] };
  config.memory = { ...config.memory, aiExtraction: { enabled: false }, learning: { enabled: false }, botSelf: { enabled: false } };
  config.memory.verification = { ...config.memory.verification, groupAdminUserIds: { [GROUP]: [PERSON] } };
  config.chatArchive = { enabled: false }; config.messageDebounce = { enabled: false };
  config.targetGroups = [GROUP]; config.send = { ...config.send, minIntervalMs: 1500, privateMinIntervalMs: 0, splitLongReplies: false };
  config.taskMode = { ...config.taskMode, enabled: true, ownerUserIds: [OWNER], maxTurns: 12, maxRuntimeMs: 60000 };
  config.ai = { ...config.ai, textTransport: 'direct', provider: 'custom', model: 'fixture-alpha',
    baseUrl: `http://127.0.0.1:${model.address().port}/alpha/v1`, apiKeyEnv: 'SOCIAL35_FAKE_KEY', credentialSource: 'existing', timeoutMs: 10000 };
  config.vision = { ...config.vision, enabled: true }; config.apiCenter = undefined; config.aiProfiles = [];
  const center = normalizeApiCenter(config);
  for (const id of ['alpha', 'beta']) {
    center.connections.push({ id: `conn-${id}`, name: id, provider: 'custom', baseUrl: `http://127.0.0.1:${model.address().port}/${id}/v1`,
      credentialSource: 'existing', apiKeyEnv: 'SOCIAL35_FAKE_KEY' });
    center.profiles.push({ id: `chat-${id}`, name: id, kind: 'chat', connectionId: `conn-${id}`, model: `fixture-${id}`, reasoningEffort: 'none', timeoutMs: 10000 });
  }
  config.apiCenter = center;
  config.accounts = { version: 2, failoverGroups: [], diagnostics: { peerPingEnabled: false, peerPingOnMessageInactive: false },
    items: ['alpha', 'beta'].map((id, index) => ({ id, qq: String(11001 + index), displayName: id, selfName: id,
      enabled: true, protocolEnabled: true, managed: true, protocolContainer: `fictional35-${id}`, protocol: 'napcat', onebotPath: config.listen.path,
      scope: { groups: true, groupMode: 'allowlist', groupIds: [GROUP], private: true }, sendTypes: { text: true, image: true },
      features: { chat: true, task: true, proactive: false }, modelBindings: { chat: `chat-${id}`, task: `chat-${id}` },
      style: { systemPrompt: `PERSONA_${id.toUpperCase()}_FICTIONAL` }, socialAgent: { enabled: false, conversationIds: [`group:${GROUP}`] },
      socialExperience: { enabled: false, conversationIds: [], stickers: { enabled: true, autonomousSelection: true, webSearch: true,
        maxDailyVisionCalls: 20, cooldownMs: 0 } },
      qzone: { enabled: true, mode: 'reviewed', reads: { feeds: true, own: true, cooldownMs: 0 }, publish: { enabled: true } } })) };
  fs.mkdirSync(path.join(home, 'tmp')); fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(registryConfig(config, { strict: true })));
  const preload = path.join(home, 'fixture-preload.cjs');
  fs.writeFileSync(preload, `
const fs=require('node:fs'),net=require('node:net'),tls=require('node:tls'),https=require('node:https'),cp=require('node:child_process');
const dns=require('node:dns/promises'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const audit=${JSON.stringify(auditFile)},append=fs.appendFileSync.bind(fs),allow=new Set(${JSON.stringify([config.listen.port, config.control.port, model.address().port])});
const record=(kind,value)=>append(audit,JSON.stringify({kind,value})+'\\n');
const denied=()=>{record('denied','EXTERNAL_IO');throw Error('FIXTURE_EXTERNAL_IO_FORBIDDEN');};
cp.spawnSync=()=>({status:1,stdout:'',stderr:'FIXTURE_PROCESS_DISABLED'});for(const k of ['spawn','exec','execFile','execSync','execFileSync','fork'])cp[k]=denied;
const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){let a=args[0];if(Array.isArray(a))a=a[0];if(typeof a==='number')a={port:a,host:typeof args[1]==='string'?args[1]:'127.0.0.1'};if(!a||a.path||!['127.0.0.1','::1'].includes(a.host||a.hostname||'127.0.0.1')||!allow.has(Number(a.port)))denied();return connect.apply(this,args);};tls.connect=denied;
dns.lookup=async host=>{if(!['memecub.com','cdn.memecub.com'].includes(host))return denied();return[{address:'8.8.8.8',family:4}];};
const fetch=global.fetch;global.fetch=(input,options)=>{const u=new URL(String(input));if(u.origin==='https://memecub.com'&&u.pathname==='/api/v1/search'){record('search',u.searchParams.get('q'));return Promise.resolve(new Response(JSON.stringify({data:[{title:'开心合成表情',kind:'meme',width:1,height:1,url:'https://cdn.memecub.com/happy.png',page_url:'https://memecub.com/meme/fictional',markdown:'synthetic metadata only',license:{code:'synthetic-test-only',commercial_use:false,attribution_required:false},private:false,profane:false}]}),{headers:{'content-type':'application/json'}}));}if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!allow.has(Number(u.port)))return denied();return fetch(input,options);};
https.request=(url,options,callback)=>{if(url.hostname!=='cdn.memecub.com')return denied();record('download','synthetic-png');const req=new EventEmitter();req.destroy=()=>req.emit('close');req.end=()=>setImmediate(()=>{const res=new PassThrough();res.statusCode=200;res.headers={'content-type':'image/png'};callback(res);res.end(Buffer.from(${JSON.stringify(png.toString('base64'))},'base64'));res.once('end',()=>req.emit('close'));});return req;};require('node:module').syncBuiltinESMExports();
`);
  child = spawn(process.execPath, [path.join(root, 'src/bridge.js')], { cwd: root, env: {
    HOME: home, TMPDIR: path.join(home, 'tmp'), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HERMES_QQ_HOME: home, HERMES_QQ_RESOURCE_ROOT: root, HERMES_QQ_LOG_DIR: path.join(home, 'logs'), HERMES_HOME: path.join(home, 'hermes'),
    SOCIAL35_FAKE_KEY: 'synthetic-never-real', NODE_OPTIONS: `--require=${preload}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', x => { log = (log + x).slice(-10000); }); child.stderr.on('data', x => { log = (log + x).slice(-10000); });
  await until(async () => { try { return (await api('/health', 'GET', undefined, false)).status === 200; } catch { return false; } }, 'start');
  token = (await api('/api/admin/session', 'GET', undefined, false)).body.token;
  for (const [index, account] of ['alpha', 'beta'].entries()) {
    const ws = new WebSocket(`ws://127.0.0.1:${config.listen.port}${config.listen.path}`); sockets.push(ws);
    ws.on('message', raw => {
      const request = JSON.parse(raw); if (!request.action) return;
      const data = request.action === 'get_login_info' ? { user_id: 11001 + index }
        : request.action === 'get_group_list' ? [{ group_id: Number(GROUP), group_name: 'FictionalGroup' }]
        : request.action === 'get_group_member_list' ? [{ user_id: Number(OWNER) }, { user_id: Number(PERSON) }]
        : request.action === 'get_friend_list' ? [{ user_id: Number(OWNER) }]
        : request.action === 'get_qzone_feeds' ? { feeds: [{ uin: 32001, tid: 'private_fixture', time: Math.floor(Date.now() / 1000),
          content: 'PRIVATE_QZONE_SENTINEL_MUST_NOT_PUBLISH', content_complete: true }], has_more: false }
        : /^send_/.test(request.action) ? { message_id: ++responseSequence }
        : { online: true, good: true };
      wire.push({ account, ...request, receipt: data }); ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data }));
    });
    await new Promise(r => ws.once('open', r)); ws.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat',
      self_id: 11001 + index, status: { online: true, good: true } }));
  }
  await until(async () => (await api('/api/accounts')).body.statuses.filter(s => s.connected).length === 2, 'two genuine fixture carriers');
  const vision = (await api('/api/config')).body;
  assert.equal((await api('/api/config', 'PATCH', { expectedRevision: vision.revision, vision: { enabled: true, preferChatModel: true } })).status, 200);
  await test('owner original Chinese event -> persistent guidance -> authenticated read API and peer isolation', async () => {
    const before = groups().length; const sent = await owner('以后少套话，保持简洁。');
    await until(() => memory().ownerGuidance?.bots?.['account:alpha']?.revision === 1, 'durable guidance');
    const journal = memory().ownerGuidance.bots['account:alpha'];
    assert.equal(journal.events[0].source.messageId, String(sent.message_id)); assert.equal(journal.events[0].source.textHash, sha('以后少套话，保持简洁。'));
    assert.equal(memory().ownerGuidance.bots['account:beta'], undefined);
    const read = await api('/api/owner/autonomy'); assert.equal(read.status, 200);
    assert.equal(read.body.guidance.accounts.find(a => a.accountId === 'alpha').ruleCount, 1);
    assert.equal(read.body.guidance.accounts.find(a => a.accountId === 'beta').ruleCount, 0);
    assert.equal((await api('/api/owner/autonomy', 'GET', undefined, false)).status, 403); assert.equal(groups().length, before);
  });
  let firstTask;
  await test('continuous goal -> real registry read_context -> correction without private goal leaking to group', async () => {
    emit('alpha', '公开的合成群话题', { userId: PERSON, groupId: GROUP }); await pause(200);
    await owner(`请在alpha:${GROUP}持续观察讨论。`);
    await until(() => tasks().some(t => t.socialDelegation?.status === 'waiting'), 'delegation read and wait');
    firstTask = tasks().find(t => t.socialDelegation?.status === 'waiting');
    assert.equal(firstTask.socialDelegation.steps[0].capability, 'read_context'); assert.equal(firstTask.socialDelegation.steps[0].status, 'succeeded');
    assert.equal(firstTask.socialDelegation.target.logicalBotId, 'account:alpha');
    const beforeSteps = firstTask.socialDelegation.steps.length;
    const followup = emit('alpha', '公开话题的新进展', { userId: PERSON, groupId: GROUP });
    await until(() => { const t = tasks().find(t => t.id === firstTask.id); return t.socialDelegation.status === 'waiting'
      && t.socialDelegation.steps.length > beforeSteps; }, 'fresh human event resumes existing owner goal');
    const afterSteps = tasks().find(t => t.id === firstTask.id).socialDelegation.steps.length;
    sockets[0].send(JSON.stringify(followup)); await pause(150);
    assert.equal(tasks().find(t => t.id === firstTask.id).socialDelegation.steps.length, afterSteps, 'duplicate event is not a new opportunity');
    await owner('请把刚才目标改成开心表情。');
    await until(() => tasks().find(t => t.id === firstTask.id)?.socialDelegation.objective === 'PRIVATE_OWNER_GOAL_STICKER', 'exact existing task correction');
    assert.equal(tasks().filter(t => t.socialDelegation).length, 1, 'correction does not silently retarget/create a second task');
  });
  await test('search_stickers fake public network -> actual bytes -> express ACK -> private owner result only', async () => {
    const event = await owner('请继续这个委托。');
    await until(() => tasks().find(t => t.id === firstTask.id)?.socialDelegation.status === 'completed', 'real tool loop completion', 25000);
    const task = tasks().find(t => t.id === firstTask.id);
    assert(task.socialDelegation.steps.some(s => s.capability === 'search_stickers' && s.status === 'succeeded'));
    assert(task.socialDelegation.steps.some(s => s.capability === 'express' && s.status === 'succeeded'));
    const image = groups().filter(row => row.params.message?.some?.(s => s.type === 'image'));
    assert.equal(image.length, 1); assert.equal(image[0].account, 'alpha');
    assert.equal(image[0].params.message[0].data.file, `base64://${png.toString('base64')}`);
    const asset = memory().socialExpressionAssets.bots['account:alpha'].stickers[`public_${sha(png)}`];
    assert(asset.annotations[`group:${GROUP}`].receipts[String(image[0].receipt.message_id)]);
    await until(() => privates().some(row => textOf(row).includes('OWNER_RESULT_alpha_ACK_RECORDED')), 'actual private result wire');
    const before = { models: calls.length, sends: wire.length }; sockets[0].send(JSON.stringify(event)); await pause(400);
    assert.equal(calls.length, before.models, 'duplicate original owner event cannot rerun the planner');
    assert.equal(groups().filter(row => row.params.message?.some?.(s => s.type === 'image')).length, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.deepEqual(saved.accounts.items.find(a => a.id === 'alpha').socialExperience.conversationIds, [], 'exact content preparation does not expand autonomous scope');
  });
  await test('second logical bot uses its own persona/model and cannot inherit alpha guidance or goal', async () => {
    await owner(`请在beta:${GROUP}持续观察讨论。`, 'beta');
    await until(() => tasks().some(t => t.accountId === 'beta' && t.socialDelegation?.status === 'waiting'), 'independent beta task');
    const b = tasks().find(t => t.accountId === 'beta'); assert.notEqual(b.id, firstTask.id);
    assert.equal(b.socialDelegation.objective, 'PRIVATE_OWNER_GOAL_OBSERVE');
    assert(calls.some(c => c.account === 'beta' && c.kind === 'plan'));
    assert.equal(memory().ownerGuidance.bots['account:beta'], undefined);
  });
  await test('cancellation during actual planner await produces no express wire or replay', async () => {
    const hold = { entered: deferred(), release: deferred() }; holds.set('cancel', hold);
    const count = groups().length; emit('alpha', `请在alpha:${GROUP}持续等待取消。`);
    await Promise.race([hold.entered.promise, until(() => false, 'cancel planner enters')]);
    await owner('请取消这个委托。'); hold.release.resolve();
    await until(() => tasks().some(t => t.socialDelegation?.status === 'cancelled'), 'cancel persisted');
    await pause(300); assert.equal(groups().length, count);
  });
  await test('private QZone read taints subsequent public expression and search', async () => {
    const count = groups().length;
    await owner(`请在alpha:${GROUP}持续看空间。`);
    await until(() => tasks().some(t => t.socialDelegation?.objective.includes('QZONE')
      && ['waiting', 'failed', 'interrupted'].includes(t.status)), 'tainted task stops');
    const task = tasks().find(t => t.socialDelegation?.objective.includes('QZONE'));
    assert.equal(task.socialPrivateContext, true); assert(wire.some(row => row.action === 'get_qzone_feeds'));
    assert(!task.socialDelegation.steps.some(s => ['express', 'search_stickers'].includes(s.capability) && s.status === 'succeeded'));
    assert.equal(groups().length, count);
  });
  await test('configured reviewer original @ -> group-only guidance; unconfigured human cannot copy authority', async () => {
    const before = calls.filter(c => c.kind === 'group_guidance').length;
    const text = '以后不要发表情';
    emit('alpha', text, { userId: '23001', groupId: GROUP,
      segments: [{ type: 'at', data: { qq: '11001' } }, { type: 'text', data: { text } }] });
    await pause(150); assert.equal(calls.filter(c => c.kind === 'group_guidance').length, before);
    emit('alpha', text, { userId: PERSON, groupId: GROUP,
      segments: [{ type: 'at', data: { qq: '11001' } }, { type: 'text', data: { text } }] });
    await until(() => memory().ownerGuidance.bots['account:alpha'].events.some(e => e.source.role === 'group_reviewer'), 'reviewer group guidance persisted');
    const row = memory().ownerGuidance.bots['account:alpha'].events.find(e => e.source.role === 'group_reviewer');
    assert.equal(row.source.actorUserId, PERSON);
    assert.equal(row.operations[0].scope.kind, 'group'); assert.equal(row.operations[0].scope.groupId, GROUP);
    assert.equal(memory().ownerGuidance.bots['account:beta'], undefined);
  });
  await test('privacy and boundary audit', async () => {
    assert(groups().every(row => !/PRIVATE_OWNER_GOAL|OWNER_RESULT_|PRIVATE_QZONE_SENTINEL/.test(JSON.stringify(row.params))));
    assert(privates().every(row => String(row.params.user_id) === OWNER));
    const audit = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    assert(audit.some(row => row.kind === 'search' && row.value === '开心'));
    assert(audit.some(row => row.kind === 'download')); assert(!audit.some(row => row.kind === 'denied'));
    assert(!/ReferenceError|TypeError/.test(log), log.slice(-1200));
  });
  console.log(JSON.stringify({ ok: true, scenarios: completed.length, completed, actualBridge: true, actualRegistry: true,
    fakeOneBots: 2, fakeModelCalls: calls.length, realModelCalls: 0, realQQCalls: 0, productionIO: false }));
  if (process.argv.includes('--ui')) {
    console.log(JSON.stringify({ fictionalUi: `${base}/admin`, fixturePid: process.pid }));
    await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  }
} finally {
  for (const hold of holds.values()) hold.release.resolve();
  for (const ws of sockets) ws.terminate();
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(r => child.once('exit', r)), pause(2500)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(r => child.once('exit', r)); } }
  model.closeAllConnections(); await new Promise(r => model.close(r)); fs.rmSync(home, { recursive: true, force: true });
}
