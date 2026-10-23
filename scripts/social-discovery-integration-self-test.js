// Real bridge HTTP/OneBot integration, synthetic state only. No live QQ or search.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { beginDiscoveryRound, finishDiscoveryRound, listDiscoveryItems } from '../src/social-discovery-state.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-bridge-test-'));
const NOW = Date.parse('2026-10-24T04:00:00Z'); // Saturday noon, Shanghai.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const clockFile = path.join(home, 'clock');
fs.writeFileSync(clockFile, String(NOW));
const advance = ms => fs.writeFileSync(clockFile, String(Number(fs.readFileSync(clockFile, 'utf8')) + ms));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const control = await freePort(), onebot = await freePort();
const base = `http://127.0.0.1:${control}`;
const endpoint = id => `/api/social-agent/accounts/${id}/discovery`;
const accountEndpoint = '/api/social-agent/accounts/primary';
const readLines = name => fs.existsSync(path.join(home, name))
  ? fs.readFileSync(path.join(home, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const candidate = (id, patch = {}) => ({ kind: 'expression', title: `太空探索合成素材${id}`,
  meaning: '合成的太空探索表达', applicable: '太空探索', avoid: '严肃求助', confidence: 0.9,
  sources: [{ url: `https://example.invalid/evidence/${id}`, title: 'Synthetic public evidence' }], ...patch });
const seed = { groups: {} };
const seedPolicy = { enabled: true, shadowMode: true, conversationIds: ['group:20001'] };
for (const id of ['primary', 'peer']) {
  const scope = { logicalId: `account:${id}`, now: NOW - 86_400_000, roundId: `seed-${id}` };
  assert(beginDiscoveryRound(seed, { ...scope, policy: seedPolicy }).ok);
  assert(finishDiscoveryRound(seed, { ...scope, status: 'complete',
    items: [candidate('shared'), candidate(id)] }).ok);
}
const seeded = id => listDiscoveryItems(seed, { logicalId: `account:${id}`, now: NOW });
const primaryOnly = seeded('primary').find(item => item.title.endsWith('primary')).id;
const sharedId = seeded('primary').find(item => item.title.endsWith('shared')).id;
assert(seeded('peer').some(item => item.id === sharedId), 'same public event deliberately exists in both accounts');
fs.mkdirSync(path.join(home, 'data'));
fs.writeFileSync(path.join(home, 'data/memory.json'), JSON.stringify(seed));

const fakeHermes = path.join(home, 'fake-hermes.cjs');
const fakeCurl = path.join(home, 'fake-curl.cjs');
fs.writeFileSync(fakeHermes, ['#!'+process.execPath, "const fs=require('node:fs');", 'fs.appendFileSync('+JSON.stringify(path.join(home,'chat-calls'))+',JSON.stringify({kind:"chat",args:process.argv.slice(2)})+String.fromCharCode(10));', 'process.stdout.write('+JSON.stringify('合成普通回复 [[DISCOVERY_USED:'+sharedId+']]')+');'].join(String.fromCharCode(10)), {mode:0o700});
fs.writeFileSync(fakeCurl, ['#!'+process.execPath, "const fs=require('node:fs');const args=process.argv.slice(2),url=args.at(-1);", "if(!['www.google.com','news.google.com'].includes(new URL(url).hostname)||args.includes('--proxy'))process.exit(93);", 'fs.appendFileSync('+JSON.stringify(path.join(home,'search-calls'))+',JSON.stringify({url,args})+String.fromCharCode(10));', 'process.stdout.write('+JSON.stringify('<rss><channel><item><title>太空探索合成网络表达</title><description>太空探索合成公开摘要</description><link>https://example.invalid/evidence/collected</link><pubDate>Sat, 24 Oct 2026 04:00:00 GMT</pubDate></item></channel></rss>')+');'].join(String.fromCharCode(10)),{mode:0o700});

// Preload is test-owned, inherited by workers. Fail closed on non-loopback IO;
// every permitted child process is a fixture, never Docker/security/shell/curl.
const preload = path.join(home, 'isolate.cjs');
fs.writeFileSync(preload, `
const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net');
const {syncBuiltinESMExports}=require('node:module');
Date.now=()=>Number(fs.readFileSync(${JSON.stringify(clockFile)},'utf8'));
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
  const normalized=Array.isArray(args[0])?args[0]:args;
  const a=normalized[0];const host=typeof a==='object'?a.host:typeof normalized[1]==='string'?normalized[1]:undefined;
  if(host&&!['127.0.0.1','localhost','::1'].includes(host))throw new Error('fixture refused non-loopback socket');
  if(typeof a==='string'||a?.path)throw new Error('fixture refused host IPC');
  return connect.apply(this,args);
};
const originalSpawn=cp.spawn;
cp.spawn=(cmd,args=[],opts)=>{
  if([${JSON.stringify(fakeCurl)},${JSON.stringify(fakeHermes)}].includes(cmd))return originalSpawn(cmd,args,opts);
  fs.appendFileSync(${JSON.stringify(path.join(home, 'host-denials'))},JSON.stringify({kind:'spawn',cmd})+'\\n');
  return originalSpawn(process.execPath,['-e','process.exit(91)'],opts);
};
cp.spawnSync=()=>({status:1,stdout:'',stderr:'fixture host operations disabled'});
for(const name of ['exec','execSync','execFile','execFileSync','fork'])cp[name]=()=>{throw new Error('fixture refused host process '+name);};
syncBuiltinESMExports();
`);

const modelCalls = [], sends = [];
let modelFailure, releaseFilter;
const model = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    assert.equal(payload.model, 'synthetic-discovery-model');
    assert.equal(payload.tools, undefined); assert.equal(payload.tool_choice, undefined);
    assert(raw.includes('后台网络素材筛选器'), 'only collection filtering may call model endpoint');
    assert(!raw.includes('ordinary-private-sentinel'), 'filter cannot read private chat');
    const evidence = JSON.parse(payload.messages.at(-1).content.split('\n').at(-1));
    assert(evidence.results.some(item => (item.link || item.url) === 'https://example.invalid/evidence/collected'));
    modelCalls.push(payload);
    if (releaseFilter) await releaseFilter.promise;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [candidate('collected', { title: '太空探索合成网络表达', sources: [{url:'https://example.invalid/evidence/collected'}] })] }) }, finish_reason: 'stop' }] }));
  } catch (error) { modelFailure = error; res.statusCode = 500; res.end('{}'); }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
config.control = { ...config.control, host: '127.0.0.1', port: control };
config.listen = { ...config.listen, host: '127.0.0.1', port: onebot, path: '/onebot' };
config.accounts = { version: 2, failoverGroups: [], items: ['primary', 'peer'].map((id, n) => ({
  id, qq: String(10001 + n), displayName: `Synthetic ${id}`, selfName: `Synthetic ${id}`,
  style: { systemPrompt: `synthetic-persona-${id}` }, enabled: true, protocolEnabled: true,
  managed: true, protocol: 'napcat', protocolContainer: `synthetic-discovery-${id}`,
  onebotWsUrl: '', onebotPath: n ? '/peer' : '/onebot', features: { chat: true, proactive: true },
  socialAgent: { enabled: false, shadowMode: true, conversationIds: ['group:20001'],
    profile: { expression: `synthetic-expression-${id}` }, maxDailyCalls: 30 },
})) };
config.automation = { enabled: false, rules: [], ownershipVersion: 1 };
for (const field of ['dailyMessages', 'hourlyChat', 'proactive', 'socialPlanner', 'vision', 'voice', 'taskMode', 'learningMode', 'adminNotifications']) config[field] = { enabled: false };
config.trigger = { ...config.trigger, activeReply: false, replyToKeywords: false };
config.messageDebounce = { enabled: false };
config.memory = { ...config.memory, aiExtraction: { enabled: false }, learning: { enabled: false } };
config.targetGroups = ['20001'];
config.privateChats = { enabled: true, targetUsers: ['30001'], ownerUserIds: ['30001'] };
config.commands = { ...config.commands, enabled: true, ownerUserIds: ['30001'], adminUserIds: ['30001'] };
delete config.apiCenter;
config.ai = { ...config.ai, command: fakeHermes, args: ['-z'], textTransport: 'hermes', provider: 'custom',
  model: 'synthetic-discovery-model', baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
  apiKeyEnv: 'DISCOVERY_FIXTURE_KEY', credentialSource: 'existing', timeoutMs: 5000 };
config.webSearch = { ...config.webSearch, enabled: true, provider: 'google', providerOrder: ['google'],
  curlPath: fakeCurl, minResultScore: 0, google: { proxy: false },
  proxy: { enabled: false, autoDetect: false, urls: [], directFallback: true }, aiJudge: { enabled: false } };
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
const env = { ...process.env, HERMES_QQ_HOME: home, HERMES_HOME: path.join(home, 'hermes'),
  HERMES_QQ_RESOURCE_ROOT: root, HERMES_QQ_LOG_DIR: path.join(home, 'logs'),
  HERMES_QQ_CONTROL_PORT: String(control), DISCOVERY_FIXTURE_KEY: 'synthetic-not-a-real-key', NODE_OPTIONS: `--require=${preload}` };
for (const key of Object.keys(env)) if (/proxy/i.test(key)) delete env[key];
let child, socket, token, tail = '';
async function request(url, { method = 'GET', body, auth = true, origin = base, host } = {}) {
  return new Promise((resolve, reject) => {
  const req = http.request(base + url, { method, headers: {
    ...(auth && token ? { 'x-hermes-qq-admin': token } : {}),
    ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}), ...(host ? { host } : {}),
  } }, response => {
    let raw = ''; response.on('data', b => { raw += b; });
    response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(raw) }); } catch (e) { reject(e); } });
    response.on('error', reject);
  });
  req.on('error', reject); req.setTimeout(12000, () => req.destroy(new Error('fixture HTTP timeout')));
  req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function until(fn, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (modelFailure) throw modelFailure; if (await fn()) return; await pause(50); }
  throw new Error(`${label}: ${tail.slice(-2000)}`);
}
const get = async (id = 'primary') => { const r = await request(endpoint(id)); assert.equal(r.status, 200); return r.body; };
const patch = async change => {
  const before = await get();
  const r = await request(endpoint('primary'), { method: 'PATCH', body: { expectedRevision: before.revision, policy: { ...before.policy, ...change } } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body;
};
const post = async (op, extra = {}, id = 'primary') => request(endpoint(id) + op,
  { method: 'POST', body: { expectedRevision: (await get(id)).revision, ...extra } });
const persistedConfig = () => JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
function message(id, text, group = true) {
  socket.send(JSON.stringify({ post_type: 'message', message_type: group ? 'group' : 'private', self_id: 10001,
    ...(group ? { group_id: 20001 } : {}), user_id: 30001, message_id: id,
    time: Math.floor(Number(fs.readFileSync(clockFile, 'utf8')) / 1000), message: text, raw_message: text, sender: { nickname: 'Synthetic human' } }));
}
let slow;
try {
  child = spawn(process.execPath, [path.join(root, 'src/bridge.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { tail = (tail + b).slice(-6000); });
  await until(async () => { if (child.exitCode !== null) throw new Error(`startup exit ${child.exitCode}: ${tail}`);
    try { return (await fetch(base + '/health')).ok; } catch { return false; } }, 'startup');
  token = (await request('/api/admin/session')).body.token; assert(token);
  socket = new WebSocket(`ws://127.0.0.1:${onebot}/onebot`);
  socket.on('message', raw => {
    const item = JSON.parse(raw); if (!item.action) return;
    if (item.action.startsWith('send_')) sends.push(item);
    const data = item.action === 'get_login_info' ? { user_id: 10001, nickname: 'Synthetic primary' }
      : item.action === 'get_group_member_list' ? [{ user_id: 10001 }, { user_id: 30001 }]
        : item.action === 'get_friend_list' ? [{ user_id: 30001 }]
          : item.action.startsWith('send_') ? { message_id: 90000 + sends.length } : { online: true, good: true };
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: item.echo, data }));
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: 10001 }));
  await pause(200);
  const initial = await get();
  assert.equal(initial.policy.enabled, false); assert.equal(initial.policy.shadowMode, true);
  assert.equal(initial.searchBinding.available, true); assert.equal(initial.searchBinding.tested, false);
  assert.equal((await request(endpoint('primary'), { auth: false })).status, 403);
  for (const op of ['', '/run', '/cancel', `/items/${sharedId}/feedback`]) {
    const method = op ? 'POST' : 'PATCH';
    const body = { expectedRevision: initial.revision, policy: initial.policy, action: 'block' };
    assert.equal((await request(endpoint('primary') + op, { method, body, auth: false })).status, 403);
    assert.equal((await request(endpoint('primary') + op, { method, body, origin: 'http://evil.invalid' })).status, 403);
    assert.equal((await request(endpoint('primary') + op, { method, body, host: 'evil.invalid' })).status, 403);
  }
  assert.equal((await request(endpoint('missing'))).status, 404);
  assert.equal((await request(endpoint('primary'), { method: 'DELETE' })).status, 405);
  assert.equal((await post('/run')).status, 409, 'disabled never collects');
  for (const policy of [null, [], { ...initial.policy, enabled: 'true' }, { ...initial.policy, maxSearchesPerRound: 4 },
    { ...initial.policy, conversationIds: ['private:30001'] }, { ...initial.policy, surprise: true }]) {
    assert.equal((await request(endpoint('primary'), { method: 'PATCH', body: { expectedRevision: initial.revision, policy } })).status, 400);
    assert.equal((await get()).revision, initial.revision, 'rejected policy must not mutate revision');
  }
  assert.equal((await request(endpoint('primary'), { method: 'PATCH', body: { expectedRevision: 'stale', policy: initial.policy } })).status, 409);
  assert.equal((await get()).revision, initial.revision);
  const configBefore = (await request('/api/config')).body;
  const socialBefore = (await request(accountEndpoint)).body.policy;
  const peerBefore = await get('peer');
  await patch({ interests: ['太空探索'] });
  const configAfter = (await request('/api/config')).body;
  assert.deepEqual(configAfter.accounts.items.map(a => a.style), configBefore.accounts.items.map(a => a.style));
  assert.deepEqual(configAfter.apiCenter, configBefore.apiCenter);
  const { discovery: beforeDiscovery, ...beforeSocial } = socialBefore;
  const { discovery: afterDiscovery, ...afterSocial } = (await request(accountEndpoint)).body.policy;
  assert.deepEqual(afterSocial, beforeSocial);
  assert.deepEqual((await get('peer')).policy, peerBefore.policy);
  assert.deepEqual((await get('peer')).items, peerBefore.items);

  // Headers + partial JSON arrive first; another HTTP writer changes social
  // policy while readBody awaits. The old full policy cannot overwrite it.
  const stale = await get();
  let slowResponse;
  const slowResult = new Promise((resolve, reject) => {
    slow = http.request(base + endpoint('primary'), { method: 'PATCH', headers: {
      'x-hermes-qq-admin': token, origin: base, 'content-type': 'application/json',
    } }, res => { let raw = ''; res.on('data', b => { raw += b; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) })); });
    slow.on('error', reject); slow.write('{"expectedRevision":');
  });
  await pause(200);
  const socialCurrent = (await request(accountEndpoint)).body;
  const newer = { ...socialCurrent.policy, profile: { ...socialCurrent.policy.profile, expression: 'concurrent synthetic expression' } };
  assert.equal((await request(accountEndpoint, { method: 'PATCH', body: { expectedRevision: socialCurrent.revision, policy: newer } })).status, 200);
  const revisionAfterConcurrent = (await get()).revision;
  slow.end(JSON.stringify(stale.revision) + ',"policy":' + JSON.stringify({ ...stale.policy, interests: ['must-not-win'] }) + '}');
  slowResponse = await slowResult; assert.equal(slowResponse.status, 409);
  assert.equal((await get()).revision, revisionAfterConcurrent);
  assert.equal((await request(accountEndpoint)).body.policy.profile.expression, 'concurrent synthetic expression');
  assert.deepEqual((await get()).policy.interests, ['太空探索']);

  // Exact primary-only ID cannot target peer; matching event ID is account-local.
  const peerRevision = (await get('peer')).revision;
  assert.equal((await post(`/items/${primaryOnly}/feedback`, { action: 'block' }, 'peer')).status, 409);
  assert.equal((await get('peer')).revision, peerRevision);
  assert.equal((await post(`/items/${sharedId.slice(0, -1)}/feedback`, { action: 'block' })).status, 409);
  assert.equal((await post(`/items/${sharedId}/feedback`, { action: 'block' })).status, 200);
  assert((await get('peer')).items.some(i => i.id === sharedId && i.status === 'active'));
  assert(!(await get()).items.some(i => i.id === sharedId && i.status === 'active'));
  assert.equal((await post('/cancel')).status, 200);

  await patch({ enabled: true, shadowMode: true, conversationIds: ['group:20001'], maxSearchesPerRound: 1 });
  assert.equal((await get()).status.blockedReason, 'DISCOVERY_NOT_IDLE');
  assert.equal((await post('/run')).status, 409, 'fresh startup cannot bypass 60s idle');
  assert.equal(modelCalls.length, 0); assert.equal(readLines('search-calls').length, 0);
  // The production interval is untouched: freeze Date.now and advance only just
  // before /run, well inside its first real 15s tick.
  advance(65_000);
  assert.equal((await get()).status.blockedReason, '');
  assert.equal((await post('/run')).status, 202);
  await until(async () => { const s = (await get()).status; return !s.running && s.lastRound?.id !== 'seed-primary'; }, 'new collection terminal');
  const collected = await get();
  assert.equal(collected.status.lastRound.status, 'complete', JSON.stringify({status:collected.status,modelFailure:modelFailure?.message}));
  assert.equal(modelCalls.length, 1, JSON.stringify({ status: collected.status, searches: readLines('search-calls').length, modelFailure: modelFailure?.message })); assert.equal(readLines('search-calls').length, 1);
  assert.equal(collected.status.today.searchRequests, 1); assert.equal(collected.status.today.filterCalls, 1);
  assert.equal(collected.status.today.unknownUsageCalls, 2, 'missing provider usage must remain unknown, not fabricated zero');
  assert(collected.items.some(i => i.title === '太空探索合成网络表达' && i.status === 'active'));
  assert.equal(sends.length, 0, 'shadow collector never sends QQ');
  assert.equal((await get('peer')).status.today.filterCalls, 0);
  assert.equal((await post('/run')).status, 409, 'interval must reject before accepting manual run');
  await pause(300);
  assert.equal(modelCalls.length, 1, 'round interval prevents another provider call');
  assert.equal(readLines('search-calls').length, 1);

  // Normal chat must remain one generation call; discovery cannot add another
  // filter/search call. A deliberately emitted internal marker never reaches wire.
  message(101, 'ordinary-private-sentinel', false);
  await until(() => sends.some(item => item.action === 'send_private_msg'), 'ordinary reply');
  assert.equal(readLines('chat-calls').length, 1);
  assert.equal(modelCalls.length, 1); assert.equal(readLines('search-calls').length, 1);
  assert(!JSON.stringify(sends).includes('DISCOVERY_USED'), 'internal marker stripped before OneBot');
  await pause(400);
  assert.equal(readLines('chat-calls').length, 1, 'no duplicate generation/reviewer call');
  assert.equal(persistedConfig().accounts.items[0].style.systemPrompt, 'synthetic-persona-primary');
  assert.equal(modelFailure, undefined);
  console.log('PASS discovery bridge HTTP: auth/origin/host/default-off/shadow/malformed/CAS/slow-body/preserve-style-API-social-policy/account-isolation/exact-feedback/idle/real-collection/unknown-usage/bounded-calls/ordinary-chat/marker-strip');
} finally {
  slow?.destroy(); releaseFilter?.resolve(); socket?.terminate();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
  }
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
}
