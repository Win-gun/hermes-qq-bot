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
  enabled: true, protocolEnabled: true, managed: false, protocol: 'napcat', onebotWsUrl: '', onebotPath: '/onebot', features:{chat:true,proactive:true}, sendTypes:{text:true,image:true},
  socialAgent: { enabled: false, shadowMode: false, conversationIds: ['group:20001'] } }], failoverGroups: [] };
// External reverse clients need no actual container. No real protocol operation.
config.accounts.items[0].managed = true;
config.accounts.items[0].protocolContainer = 'synthetic-social-test';
config.automation = { enabled: false, rules: [], ownershipVersion: 1 };
config.dailyMessages = { enabled: false }; config.hourlyChat = { enabled: false };
config.proactive = { enabled: false }; config.socialPlanner = { enabled: false };
config.trigger = { ...config.trigger, activeReply: false, replyToKeywords: false };
config.messageDebounce = { enabled: false }; config.memory = { ...config.memory, privacyFilter:false, aiExtraction: { enabled: false }, learning: { enabled: false } };
config.vision = { enabled: true, provider: 'custom', model: 'synthetic-vision' }; config.voice = { enabled: false }; config.webSearch = { enabled: false };
config.taskMode = { enabled: false }; config.learningMode = { enabled: false };
config.adminNotifications = { enabled: false }; config.targetGroups = ['20001','20002']; config.apiCenter = undefined;
config.privateChats = { enabled: true, targetUsers: ['30001'], ownerUserIds: ['30001'] };
config.commands = { ...config.commands, enabled: true, ownerUserIds: ['30001'], adminUserIds: ['30001'] };
config.responseQueue = { ...config.responseQueue, minDelayMs: 2500 };
const fake = path.join(home, 'fake-hermes.cjs');
fs.writeFileSync(fake, `#!${process.execPath}\nprocess.stdout.write(process.argv.includes('--image')?JSON.stringify({note:'开心讨论',tags:['开心'],sticker:true,safeToReuse:true,confidence:0.95,usage:'开心讨论时表达赞同和祝贺',avoid:['认真求助']}):'synthetic direct reply');\n`, { mode: 0o700 });
config.ai = { ...config.ai, command: fake, args: ['-z'], textTransport: 'hermes', provider: 'custom', model: 'synthetic-model', timeoutMs: 5000 };
let fakeRequests = 0;
// In-memory 2.1 scenarios cannot leave filesystem flags behind for later cases.
// Keep the exact host snapshot as evidence, not a separately fabricated fixture.
let scenario21 = null;
const modelCalls21 = [];
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
  if (fs.existsSync(path.join(home,'burst'))) decision={action:'reply',messages:['synthetic first bubble','synthetic second bubble']};
  if (fs.existsSync(path.join(home,'sticker'))) decision={action:'reply',expressionPlan:{version:1,action:'reply',replyToMessageId:null,
    messages:[{type:'text',content:'synthetic happy reply'},{type:'sticker',stickerId:'fixture-sticker',fallbackText:'synthetic media unavailable'}]}};
  if (fs.existsSync(path.join(home,'learned-sticker'))) {
    const item=projectedSnapshot.stickerCandidates?.find(row=>row.id!=='fixture-sticker');
    decision=item?{action:'reply',expressionPlan:{version:1,action:'reply',replyToMessageId:null,
      messages:[{type:'sticker',stickerId:item.id}]}}:{action:'observe'};
  }
  if (fs.existsSync(path.join(home,'reaction'))) {
    const item=projectedSnapshot.reactionCandidates?.[0];
    decision=item?{action:'reply',expressionPlan:{version:1,action:'reply',replyToMessageId:null,
      messages:[{type:'reaction',reactionId:item.id}]}}:{action:'observe'};
  }
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
  if (scenario21) {
    const { snapshot, tools } = JSON.parse(payload.messages.at(-1).content.split('\n').at(-1));
    const reflection = snapshot.instruction?.includes('当前问题已完成回复') === true;
    // Reflection is never allowed to reuse an interest/action or read attempt.
    decision = { action: 'observe' };
    if (!reflection) {
      const source = snapshot.messages.find(item => item.messageId === String(scenario21.messageId));
      assert(source, `2.1 ${scenario21.kind} must read its actual current event`);
      if (scenario21.kind === 'interest') decision.interest = { kind: 'member', sourceSeq: source.seq, ttlMs: 30000 };
      if (scenario21.kind === 'mention') {
        const candidate = snapshot.mentionCandidates?.[0];
        assert(candidate, 'enabled mentions expose a host-issued candidate');
        decision = { action: 'reply', expressionPlan: { version: 1, action: 'reply', replyToMessageId: null,
          messages: [{ type: 'mention', mentionId: candidate.id, content: 'synthetic current member mention' }] } };
      }
      if (scenario21.kind === 'forged-forward') decision = { action: 'tool',
        tool: { name: 'get_forward_msg', args: { id: 'model-forged-forward' } } };
    }
    modelCalls21.push({ kind: scenario21.kind, reflection, snapshot, tools, decision: structuredClone(decision) });
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
// Trusted test seams ONLY in this temporary child preload. No real public DNS
// or HTTP access: the new public-media code still validates/pins the public IP,
// and the stream is a fixed synthetic PNG. Production has no test bypass flag.
fs.appendFileSync(preload, `
const mediaDNS=require('node:dns/promises'),mediaHTTPS=require('node:https'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
mediaDNS.lookup=async host=>{if(host!=='cdn.synthetic-stickers.net')throw Error('fixture denies external DNS');return[{address:'1.1.1.1',family:4}];};
mediaHTTPS.request=(url,opts,callback)=>{if(url.hostname!=='cdn.synthetic-stickers.net')throw Error('fixture denies external HTTPS');
const req=new EventEmitter();req.destroy=()=>req.emit('close');req.end=()=>setImmediate(()=>{const res=new PassThrough();res.statusCode=200;res.headers={'content-type':'image/png'};callback(res);res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCusAAAAASUVORK5CYII=','base64'));res.once('end',()=>req.emit('close'));});return req;};syncBuiltinESMExports();
`);
let child, socket, tail = '', token;
const calls = () => fs.existsSync(path.join(home,'calls')) ? fs.readFileSync(path.join(home,'calls'),'utf8').trim().split('\n').length : 0;
const sends = [], reactions = [], onebotRequests = [];
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
    onebotRequests.push(item);
    if (item.action.startsWith('send_')) sends.push(item);
    if (item.action==='set_group_reaction') reactions.push(item);
    const data = item.action === 'get_login_info' ? { user_id: 10001, nickname: 'Test' }
      : item.action === 'get_group_member_list' ? [{ user_id: 10001 }, { user_id: 30001 }]
        : item.action === 'get_friend_list' ? [{user_id:30001}]
        : item.action === 'fetch_custom_face_detail' ? [{emoji_id:'fixture-sticker',url:'https://cdn.synthetic-stickers.net/image.png',desc:'synthetic collection'}]
        : item.action === 'get_forward_msg' ? { messages: [{ time: Math.floor(fixtureNow()/1000),
          content: [{ type: 'text', data: { text: 'synthetic forwarded text only' } }] }] }
        : item.action.startsWith('send_') ? { message_id: 90000+sends.length } : { online: true, good: true };
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: item.echo, data }));
  });
  await new Promise(resolve => socket.once('open', resolve));
  socket.send(JSON.stringify({ post_type:'meta_event',meta_event_type:'lifecycle',sub_type:'connect',self_id:10001 }));
  await pause(150);
}
function message(id, text='ordinary synthetic chat', group=20001, segments=text) { socket.send(JSON.stringify({ post_type:'message', message_type:group?'group':'private', self_id:10001, ...(group?{group_id:group}:{}), user_id:30001, message_id:id, time:Math.floor(fixtureNow()/1000), message:segments, raw_message:text, sender:{nickname:'Human'} })); }
async function stop() { socket?.close(); child?.kill('SIGTERM'); if(child?.exitCode===null) await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(3000)]); }
const accountUrl = '/api/social-agent/accounts/primary';
async function policy(patch) { for(let attempt=0;attempt<8;attempt++) { const previous = await request(accountUrl); const r = await request(accountUrl,{method:'PATCH',body:{expectedRevision:previous.body.revision,policy:{...previous.body.policy,...patch}}}); if(r.status===409){await pause(100);continue;} assert.equal(r.status,200,JSON.stringify(r.body)); return r; } throw new Error('fixture policy CAS never quiesced'); }
try {
  await start();
  assert.equal((await request('/api/social-agent/expression-status', { auth: false })).status, 403);
  const expressionStatus = await request('/api/social-agent/expression-status');
  assert.equal(expressionStatus.status, 200);
  assert.equal(expressionStatus.body.plans, 0);
  assert.deepEqual(expressionStatus.body.recent, []);
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
  await policy({ enabled: true, conversationIds: ['group:20002'], turnTimeoutMs: 5000 });
  const registry = await request('/api/accounts');
  const expressionSave = await request('/api/accounts/primary', { method: 'PATCH', body: {
    expectedRevision: registry.body.revision, patch: { socialExperience: { enabled: true, shadowMode: false,
      conversationIds: ['group:20002'], expression: { minIntervalMs: 0, maxIntervalMs: 0 } } }
  } });
  assert.equal(expressionSave.status, 200, JSON.stringify(expressionSave.body));
  fs.writeFileSync(path.join(home,'burst'),'1');
  const beforeBurst = sends.length;
  message(999, 'synthetic expression burst', 20002);
  await until(() => sends.length === beforeBurst + 2, 'shared social expression sends separate bubbles', 10000);
  assert(sends.slice(beforeBurst).every(item => item.action === 'send_group_msg' && Number(item.params.group_id) === 20002 && Array.isArray(item.params.message)));
  await until(async () => (await request('/api/social-agent/expression-status')).body.plans === 1, 'expression receipt diagnostics');
  const expressionReceipt = (await request('/api/social-agent/expression-status')).body.recent.at(-1);
  assert.equal(expressionReceipt.confirmed, 2);
  assert.equal(expressionReceipt.uncertain, false);
  // Exercise the NEW protected library route against a real isolated bridge,
  // not merely a mocked UI. Collection sync is metadata-only; no model/send.
  await policy({ enabled: false });
  const libraryPolicy = await request('/api/accounts');
  assert.equal((await request('/api/accounts/primary', { method: 'PATCH', body: {
    expectedRevision: libraryPolicy.body.revision, patch: { socialExperience: { enabled: true, shadowMode: false,
      conversationIds: ['group:20002'], language: { enabled: true }, stickers: { enabled: true, visionLearning: true, autoSend: true } } }
  } })).status, 200);
  const libraryUrl = accountUrl + '/expression-library';
  assert.equal((await request(libraryUrl+'?conversation_id=group:20002', { auth: false })).status, 403);
  assert.equal((await request(libraryUrl+'?conversation_id=group:20001')).status, 409, 'unconfigured scope refused');
  let library = await request(libraryUrl+'?conversation_id=group:20002');
  assert.equal(library.status, 200, JSON.stringify(library.body));
  assert.equal(library.body.language.candidates.length, 0);
  const sendsBeforeLibrary = sends.length, callsBeforeLibrary = calls();
  const staleSync = { conversationId: 'group:20002', expectedStateRevision: 'a'.repeat(64) };
  assert.equal((await request(libraryUrl+'/sync', { method: 'POST', body: staleSync })).status, 409);
  assert.equal((await request(libraryUrl+'/sync', { method: 'POST', origin: 'http://evil.invalid', body: {
    ...staleSync, expectedStateRevision: library.body.revision } })).status, 403);
  const synced = await request(libraryUrl+'/sync', { method: 'POST', body: {
    conversationId: 'group:20002', expectedStateRevision: library.body.revision } });
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.equal(synced.body.capabilities.collection, 'supported');
  message(1001, '合成词在本群的意思是一起开心', 20002);
  await until(async () => (await request(libraryUrl+'?conversation_id=group:20002')).body.language?.candidates?.length === 1, 'actual background glossary intake');
  library = await request(libraryUrl+'?conversation_id=group:20002');
  const candidate = library.body.language.candidates[0];
  assert.equal(candidate.status, 'pending');
  assert.equal((await request(libraryUrl+'/review-language', { method:'POST', body: {
    conversationId:'group:20002', expectedStateRevision:library.body.revision, id:candidate.id,
    expectedRevision:candidate.revision, status:'confirmed' } })).status, 200);
  assert.equal((await request(libraryUrl+'/review-language', { method:'POST', body: {
    conversationId:'group:20002', expectedStateRevision:library.body.revision, id:candidate.id,
    expectedRevision:candidate.revision, status:'rejected' } })).status, 409, 'stale editor retains current review');
  assert.equal(sends.length, sendsBeforeLibrary, 'management and glossary observation send no QQ');
  assert.equal(calls(), callsBeforeLibrary, 'metadata sync and deterministic glossary intake call no model');
  library = await request(libraryUrl+'?conversation_id=group:20002');
  const annotated = await request(libraryUrl+'/annotate', { method:'POST', body: {
    conversationId:'group:20002', expectedStateRevision:library.body.revision, id:'fixture-sticker' } });
  assert.equal(annotated.status, 200, JSON.stringify(annotated.body));
  assert.equal(annotated.body.stickers[0].annotation.status, 'candidate');
  assert.equal(annotated.body.dailyVisionCalls.attempted, 1);
  const approved = await request(libraryUrl+'/review-sticker', { method:'POST', body: {
    conversationId:'group:20002', expectedStateRevision:annotated.body.revision, id:'fixture-sticker',
    expectedRevision:annotated.body.stickers[0].annotation.revision, status:'confirmed' } });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(sends.length, sendsBeforeLibrary, 'Vision and approval still never send QQ');
  fs.unlinkSync(path.join(home,'burst')); fs.writeFileSync(path.join(home,'sticker'),'1');
  await policy({enabled:true,conversationIds:['group:20002'],turnTimeoutMs:8000});
  const beforeSticker=sends.length;
  message(1002,'今天真的很开心',20002);
  await until(()=>sends.length===beforeSticker+2,'actual shared media renderer reaches fake OneBot',15000);
  assert.equal(sends.at(-1).params.message.at(-1).type,'image');
  assert(sends.at(-1).params.message.at(-1).data.file.startsWith('base64://'));
  await until(async()=> (await request(libraryUrl+'?conversation_id=group:20002')).body.stickers[0].annotation.sentCount===1,'actual image ACK persisted once');
  await policy({enabled:false}); fs.unlinkSync(path.join(home,'sticker'));
  // Actual group-event intake uses fake media/Vision and the real repository,
  // never the unsupported collection route or a manual approval workaround.
  async function expressionPolicy(patch) {
    const registry=await request('/api/accounts');
    const previous=registry.body.items.find(row=>row.id==='primary').socialExperience;
    const r=await request('/api/accounts/primary',{method:'PATCH',body:{expectedRevision:registry.body.revision,
      patch:{socialExperience:{...previous,...patch}}}});
    assert.equal(r.status,200,JSON.stringify(r.body));
  }
  await expressionPolicy({stickers:{enabled:true,visionLearning:true,autoSend:true,groupLearning:true,
    autonomousEligibility:true,maxDailyVisionCalls:8,maxDailyDownloads:8,cooldownMs:60000}});
  const beforeLearningSends=sends.length;
  socket.send(JSON.stringify({post_type:'message',message_type:'group',self_id:10001,group_id:20002,user_id:30001,
    message_id:1100,time:Math.floor(fixtureNow()/1000),sender:{nickname:'Human'},message:[
      {type:'text',data:{text:'开心讨论的时候用这个祝贺'}},
      {type:'image',data:{url:'https://cdn.synthetic-stickers.net/group.png',file:'group-fixture',sub_type:0,summary:'synthetic'}}]}));
  await until(async()=> (await request(libraryUrl+'?conversation_id=group:20002')).body.stickers?.some(row=>row.source==='group-observed'&&row.autoEligible),
    'group image learns usage and becomes eligible without manual review',15000);
  const learnedView=(await request(libraryUrl+'?conversation_id=group:20002')).body;
  const learned=learnedView.stickers.find(row=>row.source==='group-observed');
  assert.equal(learned.annotation.status,'candidate','automatic eligibility is not an administrator decision');
  assert.equal(learned.annotation.actor,undefined);
  assert(learned.usage.includes('开心')); assert(learnedView.cache.entries>=1);
  assert.equal(sends.length,beforeLearningSends,'learning never sends QQ');
  assert(!JSON.stringify(learnedView).includes('cdn.synthetic-stickers.net'),'signed media URLs stay out of admin API');
  assert(!JSON.stringify(learnedView).includes('开心讨论的时候用这个祝贺'),'raw learning context stays out of admin API');
  fs.writeFileSync(path.join(home,'learned-sticker'),'1');
  await policy({enabled:true,conversationIds:['group:20002'],turnTimeoutMs:8000});
  const beforeLearned=sends.length; message(1101,'大家聊得很开心',20002);
  await until(()=>sends.length===beforeLearned+1,'autonomous choice sends learned sticker via same renderer',15000);
  assert.equal(sends.at(-1).params.message.at(-1).type,'image');
  await until(async()=> (await request(libraryUrl+'?conversation_id=group:20002')).body.stickers.find(row=>row.id===learned.id)?.annotation.sentCount===1,
    'learned image receipt recorded exactly once');
  await policy({enabled:false}); fs.unlinkSync(path.join(home,'learned-sticker'));
  // A message reaction is an external write but not a new bot chat message.
  await expressionPolicy({reactions:{enabled:true,cooldownMs:60000,maxDaily:3,emojiIds:['76']}});
  fs.writeFileSync(path.join(home,'reaction'),'1');
  const beforeReaction=sends.length;
  const experiencesBefore=(await request(accountUrl)).body.state.experiences.length;
  await policy({enabled:true,conversationIds:['group:20002'],turnTimeoutMs:8000});
  message(1200,'这件小事值得点个赞',20002);
  await until(()=>reactions.length===1,'reaction reaches fake OneBot');
  assert.equal(String(reactions[0].params.group_id),'20002');
  assert.equal(String(reactions[0].params.message_id),'1200');
  assert.equal(reactions[0].params.code,'76'); assert.equal(reactions[0].params.is_set,true);
  await until(async()=> (await request(libraryUrl+'?conversation_id=group:20002')).body.reactions?.accepted===1,
    'reaction records interface acceptance, not invented message ACK');
  await until(async()=> (await request(accountUrl)).body.state.conversations.find(row=>row.conversationId==='group:20002')?.unread===0,
    'reaction-only autonomous turn acknowledges only actual read sources');
  await until(async()=> (await request(accountUrl)).body.state.conversations.find(row=>row.conversationId==='group:20002')?.status==='idle',
    'reaction-only acceptance completes the social runtime without a false failure');
  assert.equal(sends.length,beforeReaction,'reaction does not create a second text reply');
  assert.equal((await request(accountUrl)).body.state.experiences.length,experiencesBefore,'accepted reaction is not a fabricated spoken experience');
  const view=(await request(libraryUrl+'?conversation_id=group:20002')).body;
  assert.equal(view.reactions.capability,'supported');
  await policy({enabled:false}); fs.unlinkSync(path.join(home,'reaction'));
  // 2.1: drive the actual bridge model/API/event paths, not module-only seams.
  for (const flag of ['wait','burst','sticker','learned-sticker','reaction','persona','pages','cross','slow'])
    assert(!fs.existsSync(path.join(home,flag)), `prior ${flag} flag must not leak into 2.1`);
  const defaults21 = (await request('/api/accounts')).body.items.find(row=>row.id==='primary').socialExperience;
  for (const feature of ['interestWatch','mentions','pokes','forwardRead'])
    assert.equal(defaults21[feature].enabled,false, `${feature} remains opt-in after 2.0 policies`);
  const libraryView21 = async () => {
    const r = await request(libraryUrl+'?conversation_id=group:20002');
    assert.equal(r.status,200,JSON.stringify(r.body)); return r.body;
  };
  const writes21 = () => onebotRequests.filter(item => item.action.startsWith('send_')
    || ['set_group_reaction','group_poke'].includes(item.action));
  const forwards21 = () => onebotRequests.filter(item=>item.action==='get_forward_msg');
  const currentCall21 = kind => modelCalls21.find(item=>item.kind===kind&&!item.reflection);
  async function settled21(kind) {
    await until(()=>Boolean(currentCall21(kind)), `2.1 ${kind} model snapshot`);
    await until(async()=> {
      const state=(await request(accountUrl)).body.state.conversations.find(row=>row.conversationId==='group:20002');
      return state?.unread===0 && state.status==='idle';
    }, `2.1 ${kind} durable terminal ACK`,15000);
  }
  // With all new switches still off, even an original forward segment grants
  // no read. The planner observes, so this also proves absent native offers.
  const beforeDefaultWrites=writes21().length, beforeDefaultReads=forwards21().length;
  scenario21={kind:'default-off',messageId:1300};
  await policy({enabled:true,conversationIds:['group:20002'],turnTimeoutMs:8000});
  message(1300,'synthetic default-off context',20002,[
    {type:'text',data:{text:'synthetic default-off context'}},{type:'forward',data:{id:'disabled-original-forward'}}]);
  await settled21('default-off');
  assert.deepEqual(currentCall21('default-off').snapshot.mentionCandidates,[]);
  assert.deepEqual(currentCall21('default-off').snapshot.pokeCandidates,[]);
  assert.equal(currentCall21('default-off').snapshot.interestWatch,undefined);
  assert.equal(forwards21().length,beforeDefaultReads,'default-off original forward is not read');
  assert.equal(writes21().length,beforeDefaultWrites,'default-off observation writes no OneBot action');
  await policy({enabled:false}); scenario21=null;

  await expressionPolicy({interestWatch:{enabled:true,maxDurationMs:300000,maxActive:4}});
  scenario21={kind:'interest',messageId:1301};
  await policy({enabled:true});
  const beforeInterestWrites=writes21().length;
  message(1301,'synthetic member attention',20002);
  await settled21('interest');
  const interestCall=currentCall21('interest');
  const interestSource=interestCall.snapshot.messages.find(item=>item.messageId==='1301');
  assert.equal(interestSource.userId,'30001');
  assert.equal(interestCall.decision.action,'observe');
  assert.deepEqual(interestCall.decision.interest,{kind:'member',sourceSeq:interestSource.seq,ttlMs:30000});
  const interestView=(await libraryView21()).interest;
  assert.equal(interestView.ephemeral,true); assert.equal(interestView.restartReplay,false);
  assert.equal(interestView.items.length,1,'observe publishes its current-source interest to the library API');
  const watch=interestView.items[0];
  assert.equal(watch.kind,'member'); assert.equal(watch.expiresAt-watch.createdAt,30000);
  const interestUrl=accountUrl+'/interest-watch';
  const interestGet=await request(interestUrl+'?conversation_id=group:20002');
  assert.equal(interestGet.status,200); assert.deepEqual(interestGet.body.items,interestView.items);
  const cancelWatch={conversationId:'group:20002',id:watch.id,expectedRevision:interestGet.body.revision};
  const callsBeforeCancel=calls();
  assert.equal((await request(interestUrl,{method:'POST',body:{...cancelWatch,expectedRevision:'stale'}})).status,409);
  assert.deepEqual((await libraryView21()).interest.items,[watch],'stale cancellation preserves the watch');
  assert.equal((await request(interestUrl,{method:'POST',body:cancelWatch,auth:false})).status,403);
  assert.deepEqual((await libraryView21()).interest.items,[watch],'unauthenticated cancellation preserves the watch');
  const cancelled=await request(interestUrl,{method:'POST',body:cancelWatch});
  assert.equal(cancelled.status,200,JSON.stringify(cancelled.body)); assert.equal(cancelled.body.cancelled,1);
  assert.deepEqual((await libraryView21()).interest.items,[]);
  assert.deepEqual((await request(interestUrl+'?conversation_id=group:20002')).body.items,[]);
  assert.equal(calls(),callsBeforeCancel,'interest management calls no model');
  assert.equal(writes21().length,beforeInterestWrites,'interest observation/cancellation never sends QQ');
  await policy({enabled:false}); scenario21=null;

  // Enable pokes too: lack of proven host capability, not merely its switch,
  // must withhold every poke handle. Mentions bind only the current speaker.
  await expressionPolicy({interestWatch:{enabled:false},mentions:{enabled:true},pokes:{enabled:true}});
  scenario21={kind:'mention',messageId:1302};
  await policy({enabled:true});
  const beforeMention=writes21().length;
  message(1302,'synthetic friendly member greeting',20002);
  await settled21('mention');
  const mentionCall=currentCall21('mention');
  assert.equal(mentionCall.decision.expressionPlan.messages[0].mentionId,mentionCall.snapshot.mentionCandidates[0].id);
  assert.deepEqual(mentionCall.snapshot.pokeCandidates,[]);
  const mentionWrites=writes21().slice(beforeMention);
  assert.equal(mentionWrites.length,1,'one host-issued mention yields exactly one physical write');
  assert.equal(mentionWrites[0].action,'send_group_msg');
  assert.equal(String(mentionWrites[0].params.group_id),'20002');
  assert.deepEqual(mentionWrites[0].params.message,[{type:'at',data:{qq:'30001'}},
    {type:'text',data:{text:' synthetic current member mention'}}]);
  await policy({enabled:false}); scenario21=null;
  scenario21={kind:'unknown-poke',messageId:1303};
  await policy({enabled:true});
  const beforeUnknownPoke=writes21().length;
  message(1303,'synthetic lighthearted discussion',20002);
  await settled21('unknown-poke');
  assert.deepEqual(currentCall21('unknown-poke').snapshot.pokeCandidates,[]);
  assert.equal((await libraryView21()).native.capabilities.poke,'unknown');
  assert.equal(onebotRequests.filter(item=>item.action==='group_poke').length,0,'never probe unknown poke with a write');
  assert.equal(writes21().length,beforeUnknownPoke,'no poke offer means no native/text fallback write');
  await policy({enabled:false}); scenario21=null;

  await expressionPolicy({mentions:{enabled:false},pokes:{enabled:false},forwardRead:{enabled:true}});
  scenario21={kind:'forward',messageId:1304};
  await policy({enabled:true});
  const beforeForward=forwards21().length, beforeForwardWrites=writes21().length;
  message(1304,'synthetic current original forward',20002,[
    {type:'text',data:{text:'synthetic current original forward'}},{type:'forward',data:{id:'current-original-forward'}}]);
  await settled21('forward');
  assert.deepEqual(forwards21().slice(beforeForward).map(item=>item.params),[{id:'current-original-forward'}]);
  const forwardCall=currentCall21('forward');
  const forwarded=forwardCall.snapshot.recentContext.find(item=>item.text.includes('synthetic current original forward'))?.forwardedContext;
  assert(forwarded,'actual model recentContext includes current-event forwardedContext');
  assert.equal(forwarded.ok,true); assert.equal(forwarded.status,'read-confirmed');
  assert.equal(forwarded.items.length,1); assert.equal(forwarded.items[0].quoted,true);
  assert.equal(forwarded.items[0].text,'synthetic forwarded text only');
  assert(!forwardCall.snapshot.messages.some(item=>item.text.includes('synthetic forwarded text only')),
    'quoted forward is not promoted to an original speaker message');
  assert.equal((await libraryView21()).forwards.capability,'read-confirmed');
  assert.equal(writes21().length,beforeForwardWrites,'forward reading is not a send');
  await policy({enabled:false}); scenario21=null;

  // An arbitrary model ID/tool name cannot enter this host-only read adapter.
  scenario21={kind:'forged-forward',messageId:1305};
  await policy({enabled:true});
  const beforeForgedCalls=calls(), beforeForgedReads=forwards21().length, beforeForgedWrites=writes21().length;
  const usageCalls=body=>Object.values(body.state.usage.days||{}).reduce((sum,day)=>sum+(day.actualCalls||0),0);
  const priorUsage=usageCalls((await request(accountUrl)).body);
  message(1305,'synthetic model-only forward reference',20002);
  await until(()=>Boolean(currentCall21('forged-forward')),'forged forward model attempt');
  await until(async()=>usageCalls((await request(accountUrl)).body)>priorUsage,'invalid tool model call durably accounted');
  assert(!currentCall21('forged-forward').tools.some(tool=>tool.name==='get_forward_msg'),
    'host forward reader is never a model tool');
  await pause(500);
  await policy({enabled:false}); scenario21=null;
  assert.equal(calls(),beforeForgedCalls+1,'invalid forward tool is not retried');
  assert.equal(forwards21().length,beforeForgedReads,'model-forged ID opens no OneBot read');
  assert.equal(writes21().length,beforeForgedWrites,'invalid forward tool has no external write');
  console.log('PASS Social Experience 2.1 bridge: default-off; actual snapshot-seq interest observe/GET/cancel/auth403/stale409; host mention -> at 30001/group 20002; unknown poke -> no offer/write; original forward -> quoted recentContext; forged model forward -> no read/write/retry');
  console.log('PASS group expression bridge: direct group media -> bounded background learning -> cached auto eligibility -> shared image ACK; host-bound reaction -> acceptance only; no external calls or real QQ');
  console.log('PASS expression library bridge: auth/scope/CAS/intake/review/budget/fake-Vision/host-plan/image-wire/ACK; no external network or QQ');
  console.log('PASS social bridge integration: auth/CAS/default-off/restricted-model/confirmed-send/durable-ACK/dedup/habit-revoke/self-consent-revoke/at-replan-terminal/startup-pause/config-race');
} finally {
  socket?.close(); child?.kill('SIGTERM'); if (child && child.exitCode===null) await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(3000)]);
  fs.rmSync(home,{recursive:true,force:true});
  model.closeAllConnections(); await new Promise(resolve=>model.close(resolve));
}
