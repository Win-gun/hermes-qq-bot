import { createOwnerCommandRouter, ownerOperationHistory, putOwnerDirective, revokeOwnerDirective } from './owner-authority.js';
import { normalizeOwnerNotifications, getOwnerNotificationStatus } from './owner-notifications.js';
import { queryModelUsage, queryOperationalEvents } from './operational-ledger.js';
import { queryPersonMemory, administerPersonMemory } from './people-memory.js';

const object = v => v && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v));
const fields = (v, names) => object(v) && Reflect.ownKeys(v).every(k=>typeof k==='string' && names.includes(k) && Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const qq = v => typeof v==='string' && /^[1-9]\d{4,19}$/.test(v);
const accountId = v => typeof v==='string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
const error = code => Object.assign(new Error(code),{code});

/** Deterministic host report, never a model-generated usage/status statement. */
export function formatOwnerQueryResult(action, data) {
  const count=value=>Number.isSafeInteger(value)&&value>=0?String(value):'未知';
  const brief=value=>typeof value==='string'?value.replace(/[\u0000-\u001f]/g,' ').slice(0,160):'未知';
  const range=data?.range;
  const stamp=value=>Number.isSafeInteger(value)&&value>=0&&Number.isFinite(new Date(value).getTime())?new Date(value).toISOString():'未知';
  const lines=range?[`查询口径：${stamp(range.from)} 至 ${stamp(range.to)}（不含结束时刻）；日界时区 ${brief(range.timezone)}。`]:[];
  if(action==='tokens'){
    const s=data?.stats,t=s?.tokens?.totalTokens;
    lines.push(`已记录调用尝试 ${count(s?.callCount)} 次：已确认 ${count(s?.confirmedCallCount)}，失败 ${count(s?.failedCallCount)}，不确定 ${count(s?.uncertainCallCount)}，待结算 ${count(s?.pendingCallCount)}。`,
      `已知 Token ${count(t?.knownTokens)}；缺失用量 ${count(s?.unknownCallCount)} 次；完整 Token 总量 ${count(t?.total)}。`,
      data?.coverage?.complete===true?'查询时段已覆盖；缺失字段仍为未知。':'存在未覆盖时段；已记录值只是下界，不能把缺失历史算作零。',
      '费用未知：未配置独立核实的价格，联网插件另计费；调用尝试不等于供应商计费请求。');
  }else if(action==='status'){
    lines.push(...(data?.accounts||[]).slice(0,16).map(a=>`${brief(a.id)}：${brief(a.status)}`),
      `全局主人通知：${data?.notifications?.enabled?'开启':'关闭'}；${(data?.notifications?.times||[]).map(brief).join('、')}；${brief(data?.notifications?.timezone)}。`);
  }else if(action==='blockers'){
    lines.push(`已记录当前阻碍 ${count(data?.count)} 项；${data?.coverage?.complete===true?'时段已覆盖':'覆盖不完整，不能推断其余时段无故障'}。`,
      ...(data?.events||[]).slice(0,10).map(e=>`${brief(e.code)} · ${brief(e.accountId)} · ${brief(e.severity)} · ${stamp(e.time)}`));
  }else if(action==='history'||action==='tasks'){
    if(action==='tasks')lines.push(`当前任务：运行 ${count(data?.running)}，排队 ${count(data?.queued)}。`);
    lines.push(...(data?.operations||[]).slice(0,10).map(op=>`${brief(op.id)} · ${brief(op.accountId)} · ${brief(op.action)} · ${brief(op.status)} · ${brief(op.code)}`));
    const coverage=action==='tasks'?data?.operationCoverage:data?.coverage;
    lines.push(`操作列表：返回 ${count(coverage?.shown)} / ${count(coverage?.total)} 条，展示上限 ${count(coverage?.limit)}；此回复最多列出前 10 条，完整记录请用本机管理页。`);
  }else if(action==='people'){
    lines.push(`人物档案状态：${brief(data?.status)}；档案修订 ${count(data?.personRevision)}。`,
      ...(data?.entries||[]).slice(0,8).map(e=>`${brief(e.id)} · ${brief(e.kind)}：${brief(typeof e.value==='string'?e.value:JSON.stringify(e.value))}`),
      '仅返回当前允许会话可见的条目；完整来源、纠正与删除请用本机人物管理页。');
  }
  return lines.join('\n').slice(0,2600)||'暂无可核实的数据。';
}

/** Calendar interval, not a sliding 24h estimate. Binary search also handles DST days. */
export function ownerQueryRange(now, days=1, timezone='Asia/Shanghai') {
  if(!Number.isSafeInteger(now)||![1,7].includes(days))throw error('OWNER_RANGE_INVALID');
  const format=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  const date=at=>{const p=Object.fromEntries(format.formatToParts(new Date(at)).map(p=>[p.type,p.value]));return `${p.year}-${p.month}-${p.day}`;};
  const today=date(now), d=new Date(`${today}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-days+1);
  const target=d.toISOString().slice(0,10);
  let low=Date.parse(`${target}T00:00:00Z`)-2*86400000,high=low+4*86400000;
  while(low<high){const mid=Math.floor((low+high)/2);if(date(mid)<target)low=mid+1;else high=mid;}
  return {from:low,to:now+1,timezone,days,basis:'ledger startedAt; [from,to); no historical backfill',coverage:'only durably recorded calls; missing pre-upgrade history is unknown'};
}

export function normalizeOwnerControl(value={}) {
  if(!fields(value,['enabled','naturalLanguage','usageEnabled','allowedTargets']))throw error('OWNER_POLICY_INVALID');
  if(['enabled','naturalLanguage','usageEnabled'].some(k=>value[k]!==undefined&&typeof value[k]!=='boolean'))throw error('OWNER_POLICY_INVALID');
  const rows=value.allowedTargets??[];
  if(!Array.isArray(rows)||rows.length>100||rows.some(x=>!fields(x,['accountId','groupId'])||!accountId(x.accountId)||!qq(x.groupId)))throw error('OWNER_TARGETS_INVALID');
  const seen=new Set();for(const r of rows){const key=`${r.accountId}:${r.groupId}`;if(seen.has(key))throw error('OWNER_TARGETS_DUPLICATE');seen.add(key);}
  return {enabled:value.enabled===true,naturalLanguage:value.naturalLanguage===true,usageEnabled:value.usageEnabled!==false,allowedTargets:structuredClone(rows)};
}

/** Host adapter: callbacks are private capabilities, never model-supplied tools. */
export function createOwnerServices(host) {
  const {read,transact,getConfig,getRevision,commitConfig,accounts,ownerIds,logicalId,capture,isCurrent,identityVerified,scopeAllows,sendText,sendSticker,setQuiet,setAutonomy,taskStatus}=host;
  const now=host.now??Date.now;
  const policy=()=>normalizeOwnerControl(getConfig().ownerControl||{});
  const notificationPolicy=()=>{
    const raw=getConfig().ownerNotifications||{},selected=raw.recipients??ownerIds();
    if(!Array.isArray(selected))throw error('OWNER_RECIPIENTS_INVALID');
    return normalizeOwnerNotifications({...raw,recipients:[...new Set(selected)].filter(id=>qq(id)&&ownerIds().includes(id))});
  };
  const authorized=e=>e.private===true&&e.verified===true&&ownerIds().includes(e.ownerUserId)&&identityVerified(e);
  function operationCoverage(ownerUserId,accountId,range){
    const total=Object.values(read().ownerAuthority?.commands||{}).filter(x=>(!ownerUserId||x.ownerUserId===ownerUserId)
      &&(!accountId||x.accountId===accountId)&&(!range||x.createdAt>=range.from&&x.createdAt<range.to)).length;
    return{total,limit:40,shown:Math.min(total,40),truncated:total>40};
  }
  function authorize(e,intent){
    if(!authorized(e))return false;
    if(['status','tokens','blockers','tasks','history'].includes(intent.action))return true;
    if(intent.action==='people')return accounts().some(a=>a.id===intent.accountId)&&policy().allowedTargets.some(t=>t.accountId===intent.accountId);
    const p=policy();if(!p.enabled)return false;
    if(intent.action==='notifications')return true;
    if(intent.action==='revoke_directive'){
      const directive=read().ownerAuthority?.directives?.[intent.directiveId];
      return Boolean(directive&&directive.actorUserId===e.ownerUserId&&directive.logicalBotId===logicalId(directive.accountId)
        &&p.allowedTargets.some(t=>t.accountId===directive.accountId&&t.groupId===directive.groupId)&&scopeAllows(directive.accountId,directive.groupId));
    }
    if(!accounts().some(a=>a.id===intent.accountId))return false;
    if(intent.action==='autonomy')return p.allowedTargets.some(t=>t.accountId===intent.accountId);
    return p.allowedTargets.some(t=>t.accountId===intent.accountId&&t.groupId===intent.groupId)&&scopeAllows(intent.accountId,intent.groupId);
  }
  function query(intent,envelope){
    const range=ownerQueryRange(now(),intent.days||1,notificationPolicy().timezone);
    const filters=intent.accountId?{accountId:intent.accountId}:{};
    if(intent.action==='tokens')return{...queryModelUsage(read(),{from:range.from,to:range.to,...filters}),range,prices:'unknown unless independently verified host pricing is available'};
    if(intent.action==='blockers')return{...queryOperationalEvents(read(),{from:range.from,to:range.to,resolved:false,currentOnly:true,...filters}),range,basis:'latest unresolved host events only; not model speculation'};
    if(intent.action==='status')return{accounts:accounts().filter(x=>!intent.accountId||x.id===intent.accountId),notifications:notificationPolicy(),notificationScope:'global',range};
    const operationFilter={ownerUserId:envelope?.ownerUserId,accountId:intent.accountId,from:range.from,to:range.to,now:now()};
    if(intent.action==='history')return{operations:ownerOperationHistory(read(),operationFilter),coverage:operationCoverage(envelope?.ownerUserId,intent.accountId,range),range,basis:'operation createdAt; [from,to)'};
    if(intent.action==='tasks')return{...taskStatus(intent.accountId),operations:ownerOperationHistory(read(),operationFilter).filter(x=>['uncertain','accepted','awaiting_confirmation'].includes(x.status)),operationCoverage:operationCoverage(envelope?.ownerUserId,intent.accountId,range),range,basis:'live tasks; operation createdAt within query range'};
    if(intent.action==='people'){
      const target=policy().allowedTargets.find(t=>t.accountId===intent.accountId);
      if(!target||!scopeAllows(target.accountId,target.groupId))throw error('OWNER_PEOPLE_SCOPE_REQUIRED');
      return queryPersonMemory(read(),{logicalBotId:logicalId(intent.accountId),userId:intent.userId,conversationId:`group:${target.groupId}`,now:now()});
    }
    throw error('OWNER_QUERY_UNSUPPORTED');
  }
  function settings(body){
    if(!fields(body,['expectedRevision','notifications','control','people'])||body.expectedRevision!==getRevision())throw error('OWNER_CONFIG_CONFLICT');
    const next=structuredClone(getConfig());for(const k of Object.keys(next))if(k.startsWith('__'))delete next[k];
    if(body.notifications!==undefined){
      if(!fields(body.notifications,['enabled','times','timezone']))throw error('OWNER_POLICY_INVALID');
      const result=normalizeOwnerNotifications({...next.ownerNotifications,...body.notifications,recipients:notificationPolicy().recipients});
      if(result.enabled&&!result.recipients.length)throw error('OWNER_RECIPIENT_REQUIRED');
      next.ownerNotifications={...next.ownerNotifications,enabled:result.enabled,times:result.times,timezone:result.timezone};
    }
    if(body.control!==undefined){const p=normalizeOwnerControl({...next.ownerControl,...body.control});
      for(const t of p.allowedTargets)if(!scopeAllows(t.accountId,t.groupId))throw error('OWNER_TARGET_OUTSIDE_ACCOUNT_SCOPE');
      next.ownerControl=p;}
    if(body.people!==undefined){if(!fields(body.people,['enabled'])||typeof body.people.enabled!=='boolean')throw error('OWNER_POLICY_INVALID');
      next.memory={...next.memory,people:{...next.memory?.people,enabled:body.people.enabled}};}
    // Readback is mandatory. A thrown/uncertain write is not retried.
    commitConfig(next);
    if(body.notifications!==undefined){const actual=notificationPolicy();if(actual.enabled!==next.ownerNotifications.enabled
      ||JSON.stringify(actual.times)!==JSON.stringify(next.ownerNotifications.times)||actual.timezone!==next.ownerNotifications.timezone)throw error('OWNER_CONFIG_READBACK_UNCERTAIN');}
    if(body.control!==undefined&&JSON.stringify(policy())!==JSON.stringify(next.ownerControl))throw error('OWNER_CONFIG_READBACK_UNCERTAIN');
    if(body.people!==undefined&&getConfig().memory?.people?.enabled!==body.people.enabled)throw error('OWNER_CONFIG_READBACK_UNCERTAIN');
    return status();
  }
  function status(){return{ok:true,revision:getRevision(),notifications:notificationPolicy(),control:policy(),people:{enabled:getConfig().memory?.people?.enabled===true},
    accounts:accounts(),usage:query({action:'tokens',days:1}),events:query({action:'blockers'}),operations:ownerOperationHistory(read(),{now:now()}),tasks:taskStatus(),
    operationCoverage:operationCoverage(),notificationState:getOwnerNotificationStatus(read(),{now:now()})};}
  const router=createOwnerCommandRouter({read,transact,isOwner:authorized,capture,isCurrent,authorize,query,now,
    parseIntent:host.parseIntent?async(text,e)=>policy().enabled&&policy().naturalLanguage?host.parseIntent(text,e):null:undefined,
    execute:async(intent,ctx)=>{
      if(!ctx.guard())return{status:'blocked',code:'OWNER_STALE_SOURCE'};
      if(intent.action==='send_text')return sendText(intent,ctx);
      if(intent.action==='send_sticker')return sendSticker(intent,ctx);
      if(['quiet','resume'].includes(intent.action))return setQuiet(intent,ctx);
      if(intent.action==='autonomy')return setAutonomy(intent,ctx);
      if(intent.action==='notifications'){
        settings({expectedRevision:ctx.source.revision,notifications:{enabled:intent.enabled,times:intent.times,timezone:intent.timezone}});
        return{status:'confirmed',code:'OWNER_SETTINGS_VERIFIED'};
      }
      if(intent.action==='restrict_poke'){
        const result=await transact(root=>ctx.guard()?putOwnerDirective(root,{actorUserId:ctx.envelope.ownerUserId,logicalBotId:logicalId(intent.accountId),
          accountId:intent.accountId,groupId:intent.groupId,userId:intent.userId,messageId:ctx.envelope.messageId,authorized:true,now:now()}):{ok:false});
        return{status:result.ok?'confirmed':'blocked',code:result.ok?'OWNER_DIRECTIVE_SAVED':'OWNER_DIRECTIVE_BLOCKED',resultId:result.id};
      }
      if(intent.action==='revoke_directive'){
        const result=await transact(root=>ctx.guard()?revokeOwnerDirective(root,{directiveId:intent.directiveId,actorUserId:ctx.envelope.ownerUserId,
          authorized:true,expectedRevision:root.ownerAuthority?.revision,now:now()}):{ok:false});
        return{status:result.ok?'confirmed':'blocked',code:result.ok?'OWNER_DIRECTIVE_REVOKED':'OWNER_DIRECTIVE_BLOCKED'};
      }
      return{status:'not_supported',code:'OWNER_CAPABILITY_UNSUPPORTED'};
    }});
  return{router,status,settings,query,notificationPolicy,
    async administerPerson(body){
      if(!fields(body,['expectedRevision','personRevision','accountId','userId','operation','entryId','value'])||body.expectedRevision!==getRevision())throw error('OWNER_CONFIG_CONFLICT');
      if(!accounts().some(a=>a.id===body.accountId)||!qq(body.userId)||!ownerIds().length)throw error('OWNER_PEOPLE_SCOPE_REQUIRED');
      const revision=getRevision(),owner=logicalId(body.accountId);
      const result=await transact(root=>revision===getRevision()&&logicalId(body.accountId)===owner?administerPersonMemory(root,{logicalBotId:owner,userId:body.userId,
        expectedRevision:body.personRevision,operation:body.operation,entryId:body.entryId,value:body.value,authorized:true,actorUserId:ownerIds()[0],now:now()}):{ok:false,code:'STALE_CONFIG'});
      return{ok:result.ok,revision:getRevision(),result,profile:queryPersonMemory(read(),{logicalBotId:owner,userId:body.userId,conversationId:`private:${body.userId}`,now:now()})};
    }};
}
