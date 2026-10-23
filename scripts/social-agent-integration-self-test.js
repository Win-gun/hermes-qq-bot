// Isolated real bridge: only synthetic config/memory, fake Hermes and fake OneBot.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { ingestSocialMessage } from '../src/social-agent-state.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'social-bridge-test-'));
const clockOffset = Date.parse('2026-10-23T04:00:00Z') - Date.now();
const fixtureNow = () => Date.now() + clockOffset;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const p = server.address().port; await new Promise(resolve => server.close(resolve)); return p; }
const control = await port(), onebot = await port();
const base = `http://127.0.0.1:${control}`;
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
config.control = { ...config.control, host: '127.0.0.1', port: control };
config.listen = { ...config.listen, host: '127.0.0.1', port: onebot, path: '/onebot' };
config.accounts = { version: 2, items: [{ id: 'primary', qq: '10001', displayName: 'Test', selfName: 'Test', style: { systemPrompt: 'synthetic-persona' },
  enabled: true, protocolEnabled: true, managed: false, protocol: 'napcat', onebotWsUrl: '', onebotPath: '/onebot', features:{chat:true,proactive:true},
  socialAgent: { enabled: false, shadowMode: false, conversationIds: ['group:20001'] } }], failoverGroups: [] };
// External reverse clients need no actual container. No real protocol operation.
config.accounts.items[0].managed = true;
config.accounts.items[0].protocolContainer = 'synthetic-social-test';
config.automation = { enabled: false, rules: [], ownershipVersion: 1 };
config.dailyMessages = { enabled: false }; config.hourlyChat = { enabled: false };
config.proactive = { enabled: false }; config.socialPlanner = { enabled: false };
config.trigger = { ...config.trigger, activeReply: false, replyToKeywords: false };
config.messageDebounce = { enabled: false }; config.memory = { ...config.memory, privacyFilter:false, aiExtraction: { enabled: false }, learning: { enabled: false } };
config.vision = { enabled: false }; config.voice = { enabled: false }; config.webSearch = { enabled: false };
config.taskMode = { enabled: false }; config.learningMode = { enabled: false };
config.adminNotifications = { enabled: false }; config.targetGroups = ['20001','20002']; config.apiCenter = undefined;
config.privateChats = { enabled: true, targetUsers: ['30001'], ownerUserIds: ['30001'] };
config.commands = { ...config.commands, enabled: true, ownerUserIds: ['30001'], adminUserIds: ['30001'] };
config.responseQueue = { ...config.responseQueue, minDelayMs: 2500 };
const fake = path.join(home, 'fake-hermes.cjs');
fs.writeFileSync(fake, `#!${process.execPath}\nprocess.stdout.write('synthetic direct reply');\n`, { mode: 0o700 });
config.ai = { ...config.ai, command: fake, args: ['-z'], textTransport: 'hermes', provider: 'custom', model: 'synthetic-model', timeoutMs: 5000 };
let fakeRequests = 0;
const model = http.createServer(async (req,res) => {
  let raw=''; for await(const chunk of req) raw+=chunk;
  const payload=JSON.parse(raw); assert.equal(payload.tools,undefined); assert.equal(payload.tool_choice,undefined);
  assert(!raw.includes('13800138000'),'social evidence always redacts even when legacy privacyFilter=false');
  assert.equal(payload.model,'synthetic-model'); fakeRequests+=1;
  const projectedSnapshot=JSON.parse(payload.messages.at(-1).content.split('\n').at(-1)).snapshot;
  if(projectedSnapshot.messages.some(item=>item.messageId==='seed')) assert(projectedSnapshot.knownContext.includes('synthetic legacy continuity'),'social planning preserves existing account memory');
  fs.appendFileSync(path.join(home,'calls'),'call\n');
  const waiting=fs.existsSync(path.join(home,'wait'));
  let decision=waiting?{action:'wait',delayMs:1100}:{action:'reply',messages:['synthetic reply']};
  if (payload.messages.at(-1).content.includes('当前问题已完成回复')) decision={action:'reply',messages:['must not send reflection'],continuity:{mood:{valence:0.2}}};
  if (fs.existsSync(path.join(home,'persona'))) {
    const {snapshot}=JSON.parse(payload.messages.at(-1).content.split('\n').at(-1));
    decision={action:'observe',continuity:{personaChanges:[{field:'expression',value:'synthetic approved expression',evidenceMessageIds:[snapshot.messages.at(-1).messageId]}]}};
  }
  if(fs.existsSync(path.join(home,'pages'))) {
    const {snapshot}=JSON.parse(payload.messages.at(-1).content.split('\n').at(-1));
    decision=snapshot.seenSeq<233?{action:'tool',tool:{name:'read_unread',args:{limit:100,afterSeq:snapshot.seenSeq}}}:{action:'reply',throughSeq:snapshot.seenSeq,messages:['page reply']};
  }
  if(fs.existsSync(path.join(home,'cross'))) {
    const prompt=payload.messages.at(-1).content;
    const {snapshot}=JSON.parse(prompt.split('\n').at(-1));
    const privateContext=snapshot.messages.some(m=>m.text==='private-context-only');
    if(privateContext) { assert(!prompt.includes('cross-source-do-not-copy')); decision={action:'reply',messages:['fresh private followup']}; }
    else decision={action:'tool',tool:{name:'schedule_followup',args:{delayMs:1100,userId:'30001'}}};
  }
  await pause(fs.existsSync(path.join(home,'slow'))?1800:0);
  res.setHeader('content-type','application/json'); res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(decision)},finish_reason:'stop'}]}));
});
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
config.ai.baseUrl=`http://127.0.0.1:${model.address().port}/v1`; config.ai.apiKeyEnv='SOCIAL_FAKE_KEY'; config.ai.credentialSource='existing';
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
const seed = { groups: { '20001': { summaries:[{date:'2026-10-22',text:'synthetic legacy continuity'}],users:{} } } };
ingestSocialMessage(seed, { logicalId: 'account:primary', conversationId: 'group:20001', message: {messageId:'seed',userId:'30001',text:'synthetic evidence',sentAt:fixtureNow(),receivedAt:fixtureNow()},now:fixtureNow() });
ingestSocialMessage(seed, { logicalId:'account:primary',conversationId:'private:30001',message:{messageId:'private-seed',userId:'30001',text:'private-context-only',sentAt:fixtureNow(),receivedAt:fixtureNow()},now:fixtureNow() });
for(let i=1;i<=232;i++) ingestSocialMessage(seed,{logicalId:'account:primary',conversationId:'group:20002',message:{messageId:`page-${i}`,userId:'30001',text:`page evidence ${i}`,sentAt:fixtureNow(),receivedAt:fixtureNow()},now:fixtureNow()});
seed.socialAgents.bots['account:primary'].conversations['group:20001'].habits.push({ id:'habit:group:20001:1',userId:'30001',text:'synthetic habit 13800138000',kind:'inferred_habit',createdAt:fixtureNow() });
fs.mkdirSync(path.join(home,'data')); fs.writeFileSync(path.join(home,'data','memory.json'),JSON.stringify(seed));
// Refuse all host integrations in the child; only our fake model executable
// may spawn. This catches accidental Docker/security/launchctl operations.
const preload = path.join(home,'fake-host.cjs');
fs.writeFileSync(preload, `const now=Date.now;Date.now=()=>now()+Number(process.env.SOCIAL_FIXTURE_OFFSET||0);const cp=require('node:child_process');const {syncBuiltinESMExports}=require('node:module');const spawn=cp.spawn;cp.spawnSync=()=>({status:1,stdout:'',stderr:'fixture host operations disabled'});cp.spawn=(cmd,args,opts)=>[process.execPath,${JSON.stringify(fake)}].includes(cmd)?spawn(cmd,args,opts):spawn(process.execPath,['-e','process.exit(91)'],opts);syncBuiltinESMExports();`);
let child, socket, tail = '', token;
const calls = () => fs.existsSync(path.join(home,'calls')) ? fs.readFileSync(path.join(home,'calls'),'utf8').trim().split('\n').length : 0;
const sends = [];
async function request(url, { method = 'GET', body, auth = true, origin = base } = {}) {
  const response = await fetch(base + url, { method, headers: { ...(auth && token ? { 'x-hermes-qq-admin': token } : {}),
    ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
async function until(fn, label, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await pause(60); } throw new Error(`${label}: ${tail.slice(-600)}`); }
async function start() {
  child = spawn(process.execPath, [path.join(root, 'src/bridge.js')], { cwd: root, env: { ...process.env,
    HERMES_QQ_HOME: home, HERMES_QQ_RESOURCE_ROOT: root, HERMES_QQ_LOG_DIR: path.join(home,'logs'), HERMES_QQ_CONTROL_PORT: String(control), SOCIAL_FAKE_KEY:'synthetic-fake-key', SOCIAL_FIXTURE_OFFSET:String(clockOffset), NODE_OPTIONS:`--require=${preload}` }, stdio: ['ignore','pipe','pipe'] });
  child.stderr.on('data', b => { tail = (tail + b).slice(-4000); });
  child.stdout.on('data', b => { tail = (tail + b).slice(-4000); });
  await until(async () => { if(child.exitCode!==null)throw new Error(`startup exit ${child.exitCode}: ${tail}`); try { const r=await fetch(base+'/health'); if(!r.ok) tail+=` health HTTP ${r.status} ${await r.text()}`; return r.ok; } catch(e) { tail+=` fetch:${e.cause?.message || e.message}`; return false; } }, 'startup');
  token = (await request('/api/admin/session')).body.token;
  socket = new WebSocket(`ws://127.0.0.1:${onebot}/onebot`);
  socket.on('message', raw => { const item = JSON.parse(raw); if (!item.action) return;
    if (item.action.startsWith('send_')) sends.push(item);
    const data = item.action === 'get_login_info' ? { user_id: 10001, nickname: 'Test' }
      : item.action === 'get_group_member_list' ? [{ user_id: 10001 }, { user_id: 30001 }]
        : item.action === 'get_friend_list' ? [{user_id:30001}]
        : item.action.startsWith('send_') ? { message_id: 90000+sends.length } : { online: true, good: true };
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: item.echo, data }));
  });
  await new Promise(resolve => socket.once('open', resolve));
  socket.send(JSON.stringify({ post_type:'meta_event',meta_event_type:'lifecycle',sub_type:'connect',self_id:10001 }));
  await pause(150);
}
function message(id, text='ordinary synthetic chat', group=20001) { socket.send(JSON.stringify({ post_type:'message', message_type:group?'group':'private', self_id:10001, ...(group?{group_id:group}:{}), user_id:30001, message_id:id, time:Math.floor(fixtureNow()/1000), message:text, raw_message:text, sender:{nickname:'Human'} })); }
async function stop() { socket?.close(); child?.kill('SIGTERM'); if(child?.exitCode===null) await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(3000)]); }
const accountUrl = '/api/social-agent/accounts/primary';
async function policy(patch) { for(let attempt=0;attempt<8;attempt++) { const previous = await request(accountUrl); const r = await request(accountUrl,{method:'PATCH',body:{expectedRevision:previous.body.revision,policy:{...previous.body.policy,...patch}}}); if(r.status===409){await pause(100);continue;} assert.equal(r.status,200,JSON.stringify(r.body)); return r; } throw new Error('fixture policy CAS never quiesced'); }
try {
  await start();
  assert.equal((await request(accountUrl,{auth:false})).status,403);
  const initial = await request(accountUrl); assert.equal(initial.status,200); assert.equal(initial.body.policy.enabled,false); assert(!JSON.stringify(initial.body).includes('13800138000'));
  assert.equal((await request(accountUrl,{method:'PATCH',body:{expectedRevision:'stale',policy:{enabled:true}}})).status,409);
  assert.equal((await request(accountUrl,{method:'PATCH',origin:'http://evil.invalid',body:{expectedRevision:initial.body.revision,policy:{enabled:true}}})).status,403);
  message(1); await pause(1600); assert.equal(calls(),0); assert.equal(sends.length,0);
  await policy({enabled:true}); message(2,'ordinary phone 13800138000');
  await until(()=>sends.length===1,'autonomous send');
  await until(async()=> (await request(accountUrl)).body.state.conversations[0]?.unread===0,'durable ACK');
  const firstCalls=calls(); message(2); await pause(1300); assert.equal(calls(),firstCalls); assert.equal(sends.length,1);
  const habitState = await request(accountUrl);
  assert.equal((await request(accountUrl+'/habits/'+encodeURIComponent('habit:group:20001:1')+'/revoke',{method:'POST',body:{expectedRevision:habitState.body.revision}})).status,200);
  assert((await request(accountUrl)).body.state.habits[0].revokedAt);
  const experienceState = await request(accountUrl);
  const experience = experienceState.body.state.experiences.find(item => item.id && item.messageId);
  assert(experience, 'confirmed send exposes an exact, sourced experience');
  const experienceUrl = accountUrl + '/experiences/' + encodeURIComponent(experience.id) + '/revoke';
  assert.equal((await request(experienceUrl, {method:'POST',body:{expectedRevision:'stale'}})).status,409);
  assert.equal((await request(experienceUrl, {method:'POST',body:{expectedRevision:experienceState.body.revision}})).status,200);
  assert((await request(accountUrl)).body.state.experiences.find(item=>item.id===experience.id).revokedAt,
    'exact experience revocation preserves source record');
  await policy({enabled:true});
  const beforeConsent=calls(); message(20,'/bot social allow-private 20001');
  await until(async()=> (await request(accountUrl)).body.state.relations[0]?.consents?.some(c=>c.sourceConversationId==='group:20001'&&c.allowed),'self consent');
  message(21,'/bot social revoke-private 20001');
  await until(async()=> (await request(accountUrl)).body.state.relations[0]?.consents?.some(c=>c.sourceConversationId==='group:20001'&&!c.allowed),'self revoke');
  assert.equal(calls(),beforeConsent);
  fs.writeFileSync(path.join(home,'wait'),'1'); message(3);
  await until(async()=> (await request('/api/social-agent/plans?account_id=primary')).body.items?.some(p=>p.status==='pending'),'plan created');
  fs.unlinkSync(path.join(home,'wait'));
  await until(()=>sends.length===2,'due plan replanned');
  await until(async()=> (await request('/api/social-agent/plans?account_id=primary')).body.items?.some(p=>p.status==='completed'),'plan terminal');
  fs.writeFileSync(path.join(home,'slow'),'1'); message(4); await until(()=>calls()>firstCalls+2,'slow model started');
  await policy({enabled:false}); const before=sends.length; await pause(2200); assert.equal(sends.length,before,'disabled pending model must not send');
  fs.unlinkSync(path.join(home,'slow'));
  await policy({enabled:true,turnTimeoutMs:5000});
  fs.writeFileSync(path.join(home,'wait'),'1'); message(5);
  await until(async()=> (await request('/api/social-agent/plans?account_id=primary')).body.items?.some(p=>p.status==='pending'),'restart plan');
  await stop(); const beforeRestart=calls(); fs.unlinkSync(path.join(home,'wait')); await start(); await pause(2000);
  assert.equal(calls(),beforeRestart,'startup never replays pending plan');
  assert((await request('/api/social-agent/plans?account_id=primary')).body.items.some(p=>p.status==='paused'));
  await policy({enabled:true,crossConversation:{enabled:true,groupIds:['group:20001'],userIds:['30001']}});
  message(30,'/bot social allow-private 20001',0);
  await until(async()=> (await request(accountUrl)).body.state.relations.find(r=>r.userId==='30001')?.consents.some(c=>c.allowed),'private self grant');
  fs.writeFileSync(path.join(home,'cross'),'1'); const priorPrivate=sends.filter(s=>s.action==='send_private_msg').length;
  message(31,'cross-source-do-not-copy');
  await until(()=>sends.filter(s=>s.action==='send_private_msg').length===priorPrivate+1,'dual consent private followup',15000);
  fs.unlinkSync(path.join(home,'cross'));
  await until(()=>JSON.parse(fs.readFileSync(path.join(home,'data','memory.json'),'utf8')).socialAgents.bots['account:primary'].users['30001'].contacts.at(-1)?.status==='sent','durable contact settlement');
  const persisted=JSON.parse(fs.readFileSync(path.join(home,'data','memory.json'),'utf8'));
  assert.equal(persisted.socialAgents.bots['account:primary'].users['30001'].contacts.at(-1).status,'sent');
  fs.writeFileSync(path.join(home,'pages'),'1'); await policy({enabled:true,conversationIds:['group:20001','group:20002']});
  message(233,'page last',20002);
  await until(async()=> (await request(accountUrl)).body.state.conversations.find(c=>c.conversationId==='group:20002')?.readThroughSeq===233,'232+ contiguous page ACK',15000);
  fs.unlinkSync(path.join(home,'pages'));
  await policy({enabled:true,turnTimeoutMs:5000});
  const beforeGate=sends.length; message(900,'gate first'); await until(()=>sends.length===beforeGate+1,'gate first confirmed');
  await policy({turnTimeoutMs:1000}); message(901,'expired queued draft');
  await pause(4300); assert.equal(sends.length,beforeGate+1,'expired deferred coordinator intent must not reach wire');
  await policy({turnTimeoutMs:5000});
  const beforeQuiet=sends.length; const callsQuiet=calls(); fs.writeFileSync(path.join(home,'slow'),'1'); message(902,'quiet race draft');
  await until(()=>calls()>callsQuiet,'quiet race generation'); message(903,'/bot quiet 10m');
  await pause(2300); assert.equal(sends.length,beforeQuiet,'quiet cancels awaiting model'); fs.unlinkSync(path.join(home,'slow'));
  await policy({conversationIds:['group:20001','private:30001'],turnTimeoutMs:5000});
  const privateBefore=sends.filter(s=>s.action==='send_private_msg').length;
  message(904,'direct background continuity fixture',0);
  await until(()=>sends.filter(s=>s.action==='send_private_msg').length===privateBefore+1,'direct fast reply');
  await until(async()=> (await request(accountUrl)).body.state.conversations.find(c=>c.conversationId==='private:30001')?.mood?.valence>0,'background reflection updates mood');
  await pause(1300);
  assert.equal(sends.filter(s=>s.action==='send_private_msg').length,privateBefore+1,'reflection cannot send a duplicate reply');
  fs.writeFileSync(path.join(home,'persona'),'1'); message(905,'please propose a fictional expression change',0);
  await until(async()=> {const s=(await request(accountUrl)).body.state; return s.proposals.some(p=>p.kind==='persona_change')&&s.conversations.find(c=>c.conversationId==='private:30001')?.status==='idle';},'persona proposal without automatic mutation');
  fs.unlinkSync(path.join(home,'persona'));
  let review=(await request(accountUrl)).body;
  const proposal=review.state.proposals.find(p=>p.kind==='persona_change');
  const resolveUrl=accountUrl+'/persona-proposals/'+encodeURIComponent(proposal.id)+'/resolve';
  let delayed;
  const delayedResponse = new Promise((resolve,reject) => {
    delayed=http.request(base+resolveUrl,{method:'POST',headers:{origin:base,'content-type':'application/json','x-hermes-qq-admin':token,'transfer-encoding':'chunked'}},res=>{
      res.resume(); res.on('end',()=>resolve(res.statusCode));
    }); delayed.on('error',reject); delayed.write('{');
  });
  await pause(150); await policy({maxDailyCalls:999});
  review=(await request(accountUrl)).body;
  delayed.end(JSON.stringify({expectedRevision:proposal.revision,expectedStateRevision:review.revision,decision:'approve'}).slice(1));
  assert.equal(await delayedResponse,409,'slow body cannot overwrite a newer policy using a fresh state revision');
  assert.equal((await request(accountUrl)).body.policy.maxDailyCalls,999);
  const decisionBody={expectedRevision:proposal.revision,expectedStateRevision:review.revision,decision:'approve'};
  assert.equal((await request(resolveUrl,{method:'POST',body:decisionBody,auth:false})).status,403);
  assert.equal((await request(resolveUrl,{method:'POST',body:{...decisionBody,expectedStateRevision:'stale'}})).status,409);
  assert.equal((await request(resolveUrl,{method:'POST',body:decisionBody})).status,200);
  const approvedConfig=JSON.parse(fs.readFileSync(path.join(home,'config.json'),'utf8'));
  assert.equal(approvedConfig.accounts.items[0].socialAgent.profile.expression,'synthetic approved expression');
  assert.equal(approvedConfig.accounts.items[0].style.systemPrompt,'synthetic-persona','original persona snapshot must survive approval');
  assert.equal((await request(resolveUrl,{method:'POST',body:decisionBody})).status,409,'terminal proposal cannot replay');
  console.log('PASS social bridge integration: auth/CAS/default-off/restricted-model/confirmed-send/durable-ACK/dedup/habit-revoke/self-consent-revoke/at-replan-terminal/startup-pause/config-race');
} finally {
  socket?.close(); child?.kill('SIGTERM'); if (child && child.exitCode===null) await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(3000)]);
  fs.rmSync(home,{recursive:true,force:true});
  model.closeAllConnections(); await new Promise(resolve=>model.close(resolve));
}
