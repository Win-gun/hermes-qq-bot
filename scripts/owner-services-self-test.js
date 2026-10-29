import assert from 'node:assert/strict';
import { createOwnerServices, ownerQueryRange, normalizeOwnerControl, formatOwnerQueryResult } from '../src/owner-services.js';

let checks=0;const check=(v,m)=>{assert(v,m);checks++;};
const now=Date.parse('2026-03-08T20:00:00Z');
check(ownerQueryRange(now,1,'America/Los_Angeles').from===Date.parse('2026-03-08T08:00:00Z'),'DST calendar start, not sliding24h');
check(ownerQueryRange(now,7,'America/Los_Angeles').from===Date.parse('2026-03-02T08:00:00Z'),'7 calendar dates');
check(ownerQueryRange(Date.parse('2026-10-28T16:00:01Z'),1).from===Date.parse('2026-10-28T16:00:00Z'),'Shanghai midnight');
assert.throws(()=>ownerQueryRange(now,30));checks++;
assert.throws(()=>normalizeOwnerControl({allowedTargets:[{accountId:'alpha',groupId:'31001'},{accountId:'alpha',groupId:'31001'}]}));checks++;
assert.throws(()=>normalizeOwnerControl({shell:true}));checks++;
let root={},revision='config1',config={memory:{people:{enabled:false}},ownerControl:{enabled:false,allowedTargets:[]}},commits=0,queryExecutions=0;
const host={read:()=>root,transact:async fn=>{const draft=structuredClone(root),result=fn(draft);root=draft;return result;},
  getConfig:()=>config,getRevision:()=>revision,commitConfig:next=>{commits++;config=next;revision=`config${commits+1}`;},
  accounts:()=>[{id:'alpha',status:'online'},{id:'beta',status:'online'}],ownerIds:()=>['21001'],logicalId:id=>`account:${id}`,
  capture:()=>({revision}),isCurrent:s=>s.revision===revision,identityVerified:e=>e.accountId==='alpha',
  scopeAllows:(id,gid)=>id==='alpha'&&gid==='31001',taskStatus:()=>({running:0,queued:0,items:[]}),
  sendText:async()=>{queryExecutions++;return{status:'confirmed',resultId:'51001'};},sendSticker:async()=>({status:'not_supported'}),
  setQuiet:async()=>({status:'confirmed'}),setAutonomy:async()=>({status:'confirmed'}),now:()=>now};
const service=createOwnerServices(host),envelope={private:true,verified:true,ownerUserId:'21001',accountId:'alpha',logicalBotId:'account:alpha',messageId:'m1'};
let view=service.status();check(view.notifications.times.join(',')==='09:00,21:00'&&!view.notifications.enabled,'safe schedule defaults');
check(!view.control.enabled&&!view.people.enabled,'new authorities opt-in');
check(view.usage.range.timezone==='Asia/Shanghai'&&view.usage.prices.includes('unknown'),'query scope and unknownprice explicit');
check(root.ownerAuthority===undefined,'status no writes');
check((await service.router.handle(envelope,'/owner status')).status==='confirmed'&&queryExecutions===0,'read query no model/tool');
check((await service.router.handle(envelope,'/owner send alpha 31001 hello')).status==='blocked','off does notsend');
assert.throws(()=>service.settings({expectedRevision:'stale',control:{enabled:true}}));checks++;
check(commits===0,'CAS refusedbeforewrite');
assert.throws(()=>service.settings({expectedRevision:revision,control:{enabled:true,allowedTargets:[{accountId:'alpha',groupId:'31002'}]}}));checks++;
check(commits===0,'outsidegroups no write');
view=service.settings({expectedRevision:revision,notifications:{enabled:true,times:['09:00','21:00'],timezone:'Asia/Shanghai'},
  control:{enabled:true,allowedTargets:[{accountId:'alpha',groupId:'31001'}]},people:{enabled:true}});
check(view.notifications.enabled&&view.people.enabled&&view.control.enabled&&commits===1,'explicit localsettings readback');
check(view.control.allowedTargets[0].groupId==='31001','no implicit scope expansion');
check((await service.router.handle({...envelope,messageId:'m2'},'/owner send alpha 31001 hello')).status==='confirmed'&&queryExecutions===1,'allowlistedone-shot actualtool');
check((await service.router.handle({...envelope,messageId:'m3'},'/owner send beta 31001 hello')).status==='blocked','peer not implicittarget');
check((await service.router.handle({...envelope,messageId:'m4',ownerUserId:'22002'},'/owner tokens')).status==='blocked','member cannotquery authority');
check((await service.router.handle({...envelope,messageId:'m5',verified:false},'/owner tokens')).status==='blocked','unverified Carrier');
const before=root.ownerAuthority.revision;
assert.throws(()=>service.settings({expectedRevision:revision,notifications:{enabled:true,times:['00:00','12:00','23:00'],timezone:'Asia/Shanghai'}}));checks++;
check(root.ownerAuthority.revision===before,'invalid schedule no side effect');
check(service.query({action:'history'}).coverage.total===1,'history coverage honest');
const oldCommit=host.commitConfig;host.commitConfig=()=>{};
const uncertain=createOwnerServices({...host,commitConfig:()=>{}});
assert.throws(()=>uncertain.settings({expectedRevision:revision,people:{enabled:false}}),/OWNER_CONFIG_READBACK_UNCERTAIN/);checks++;
host.commitConfig=oldCommit;
config.ownerNotifications={...config.ownerNotifications,times:['08:30','20:30'],timezone:'UTC',recipients:['21001']};
const multiple=createOwnerServices({...host,ownerIds:()=>['21001','21002']});
check(multiple.status().notifications.recipients.join(',')==='21001','explicit recipient subset not expanded to every owner');
multiple.settings({expectedRevision:revision,notifications:{enabled:false}});
check(config.ownerNotifications.times.join(',')==='08:30,20:30'&&config.ownerNotifications.timezone==='UTC','partial notification patch retains times and timezone');
check(multiple.status().notifications.recipients.length===1,'partial patch preserves recipient selection');
check(service.query({action:'status',accountId:'beta'}).accounts.every(x=>x.id==='beta'),'status account filter is actually applied');
root.ownerAuthority.commands.fixtureExpired={id:'fixtureExpired',ownerUserId:'21001',accountId:'alpha',logicalBotId:'account:alpha',
  action:'quiet',status:'awaiting_confirmation',createdAt:now-1000,expiresAt:now-1};
root.ownerAuthority.commands.fixtureOther={id:'fixtureOther',ownerUserId:'21001',accountId:'beta',logicalBotId:'account:beta',
  action:'quiet',status:'confirmed',createdAt:now-1000,expiresAt:now+1000};
root.ownerAuthority.commands.fixtureOld={id:'fixtureOld',ownerUserId:'21001',accountId:'alpha',logicalBotId:'account:alpha',
  action:'quiet',status:'confirmed',createdAt:now-10*86400000,expiresAt:now-9*86400000};
const scopedHistory=service.query({action:'history',accountId:'alpha'});
check(scopedHistory.operations.every(x=>x.accountId==='alpha'&&x.createdAt>=scopedHistory.range.from),'history account and date filters applied');
check(scopedHistory.operations.find(x=>x.id==='fixtureExpired').code==='OWNER_APPROVAL_EXPIRED','expired approval honestly blocked, not a live pending operation');
check(!service.query({action:'tasks',accountId:'alpha'}).operations.some(x=>x.id==='fixtureExpired'),'expired proposal excluded from unfinished commands');
const report=formatOwnerQueryResult('tokens',service.query({action:'tokens'}));
check(report.includes('费用未知')&&report.includes('下界')&&report.includes('时区'),'QQ report retains price/coverage/range rather than truncating raw JSON');
check(!report.includes('fixture-model')&&!report.includes('intent'),'QQ report does not dump raw ledger data or proposals');
check(formatOwnerQueryResult('status',service.query({action:'status',accountId:'beta'})).includes('beta'),'status report uses actual selected account');
console.log(JSON.stringify({ok:true,checks,productionIO:false,actualModelCalls:0,actualQQ:0}));
