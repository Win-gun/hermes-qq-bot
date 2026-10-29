import { createOwnerCommandRouter, ownerOperationHistory, putOwnerDirective, revokeOwnerDirective,
  ownerAddressFor, ownerAddressAvoided, ownerGroupParticipationReduced, ownerDirectiveById,
  ownerActiveDirectives } from './owner-authority.js';
import { buildOwnerIntentContext, resolveOwnerUtterance, parseOwnerQueryUtterance } from './owner-intent.js';
import { normalizeOwnerNotifications, getOwnerNotificationStatus } from './owner-notifications.js';
import { queryModelUsage, queryOperationalEvents } from './operational-ledger.js';
import { queryOwnerInteractions } from './owner-interactions.js';
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
  }else if(action==='activity'){
    const observed=data?.observed||{};
    lines.push(`今日已观测收到 ${count(observed.received)}，发出 ${count(observed.sent)}；完整总数 ${count(data?.received)==='未知'?'未知':count(data?.received)}。`,
      data?.coverage==='complete'?'查询时段已覆盖。':'存在未覆盖时段，已记录值只是下界；回应动作不是新 QQ 消息。');
  }else if(action==='why'){
    const observed=data?.observed||{};
    const list=value=>Array.isArray(value)?(value.length?value.slice(0,8).map(brief).join('、'):'无'):'未知（宿主未提供）';
    lines.push(`账号状态：${(data?.accounts||[]).slice(0,8).map(a=>`${brief(a.id)} ${brief(a.status)}`).join('，')||'未知'}。`,
      `群内静默：${list(data?.quietGroupIds)}。`,
      `自动参与：${data?.autonomyEnabled===true?'开启':data?.autonomyEnabled===false?'关闭':'未知（宿主未提供）'}。`,
      `主人降低参与：${list(data?.participationReduced)}。`,
      `今日已观测收到 ${count(observed.received)}、发出 ${count(observed.sent)}；完整总数 ${count(data?.received)}。`,
      `最近阻碍 ${count(data?.blockers?.count)} 项；${data?.blockers?.coverage?.complete===true?'时段已覆盖':'覆盖不完整'}。`,
      '只依据宿主可核实事实；模型不推测未回复原因，也不承诺补发。');
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

/**
 * Two owner-control target modes, both explicit:
 *   `explicit`  (default, the historical shape) — `allowedTargets` IS the authority: an
 *               empty list means "no group is authorised", never "all groups".
 *   `inherited` — the owner delegates target discovery to the trusted host. The static
 *               list becomes a narrowing restriction only, so an empty list no longer
 *               blanket-blocks every real joined group. It still requires the trusted
 *               synchronous `host.allowedTargets()` callback AND the account's actual
 *               current scope; without that callback it denies everything. It is never
 *               a wildcard, and it never overrides `scopeAllows` or a deny rule.
 * Absent `targetMode` normalises to `explicit`, so every pre-3.4 config keeps its meaning.
 */
const OWNER_TARGET_MODES=Object.freeze(['explicit','inherited']);
export function normalizeOwnerControl(value={}) {
  if(!fields(value,['enabled','naturalLanguage','usageEnabled','allowedTargets','lowRiskDirect','targetMode']))throw error('OWNER_POLICY_INVALID');
  if(['enabled','naturalLanguage','usageEnabled','lowRiskDirect'].some(k=>value[k]!==undefined&&typeof value[k]!=='boolean'))throw error('OWNER_POLICY_INVALID');
  if(value.targetMode!==undefined&&!OWNER_TARGET_MODES.includes(value.targetMode))throw error('OWNER_POLICY_INVALID');
  const rows=value.allowedTargets??[];
  if(!Array.isArray(rows)||rows.length>100||rows.some(x=>!fields(x,['accountId','groupId'])||!accountId(x.accountId)||!qq(x.groupId)))throw error('OWNER_TARGETS_INVALID');
  const seen=new Set();for(const r of rows){const key=`${r.accountId}:${r.groupId}`;if(seen.has(key))throw error('OWNER_TARGETS_DUPLICATE');seen.add(key);}
  return {enabled:value.enabled===true,naturalLanguage:value.naturalLanguage===true,usageEnabled:value.usageEnabled!==false,
    lowRiskDirect:value.lowRiskDirect===true,allowedTargets:structuredClone(rows),
    targetMode:value.targetMode===undefined?'explicit':value.targetMode};
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
  const authorized=e=>e.private===true&&e.verified===true&&ownerIds().includes(e.ownerUserId)&&identityVerified(e)
    // The claimed logical bot must be the one this physical account actually owns.
    &&logicalId(e.accountId)===e.logicalBotId;
  /**
   * Actual current allowed pairs. Two owner-selected modes (see `normalizeOwnerControl`):
   *  - `explicit`  : the config allowlist is the authority and the host callback (when
   *                  present) can only shrink it. An empty list therefore denies all.
   *  - `inherited` : the trusted host callback is the authority, so an empty static list
   *                  does not blanket-block real joined groups. A non-empty static list
   *                  still narrows it, and a missing callback denies everything — this is
   *                  never a wildcard, and neither mode can bypass `scopeAllows`.
   */
  const allowedTargets=()=>{
    const p=policy();
    const inherited=p.targetMode==='inherited';
    const hostRows=typeof host.allowedTargets==='function'?host.allowedTargets():undefined;
    // "absent" and "empty" are different answers: an absent callback gives no opinion,
    // while an empty one means the runtime currently has no allowed pair at all.
    const supplied=Array.isArray(hostRows);
    const trusted=supplied?hostRows.filter(row=>fields(row,['accountId','groupId'])):[];
    // `explicit` keeps the historical direction: the config list is authoritative and a
    // supplied host callback always narrows it (even down to nothing). `inherited` takes
    // candidates from the host, so an empty config list cannot blanket-block real groups.
    const raw=inherited?trusted:p.allowedTargets;
    const narrow=inherited?p.allowedTargets:trusted;
    const narrowAlways=inherited?p.allowedTargets.length>0:supplied;
    const out=[],seen=new Set();
    for(const row of raw){if(!fields(row,['accountId','groupId'])||!accountId(row.accountId)||!qq(row.groupId))continue;
      const key=`${row.accountId}:${row.groupId}`;if(seen.has(key))continue;
      // The other side narrows: always in `explicit` (a host that reports nothing denies),
      // and in `inherited` only when the owner set a restriction.
      if(narrowAlways&&!narrow.some(t=>t.accountId===row.accountId&&t.groupId===row.groupId))continue;
      // The account must exist and its actual current scope must still allow the group.
      if(!accounts().some(a=>a.id===row.accountId)||!scopeAllows(row.accountId,row.groupId))continue;
      seen.add(key);out.push({accountId:row.accountId,groupId:row.groupId});}
    return out;
  };
  /** Trusted synchronous intent context callback; absent means "no context supplied". */
  const rawIntentContext=e=>{
    if(typeof host.intentContext!=='function'||!e)return null;
    try{const raw=host.intentContext(e);return raw&&typeof raw==='object'?raw:null;}catch{return null;}
  };
  function operationCoverage(ownerUserId,accountId,range){
    const total=Object.values(read().ownerAuthority?.commands||{}).filter(x=>(!ownerUserId||x.ownerUserId===ownerUserId)
      &&(!accountId||x.accountId===accountId)&&(!range||x.createdAt>=range.from&&x.createdAt<range.to)).length;
    return{total,limit:40,shown:Math.min(total,40),truncated:total>40};
  }
  function authorize(e,intent){
    if(!authorized(e))return false;
    if(['status','tokens','blockers','tasks','history','activity','why'].includes(intent.action))return true;
    if(intent.action==='people')return accounts().some(a=>a.id===intent.accountId)&&allowedTargets().some(t=>t.accountId===intent.accountId);
    const p=policy();if(!p.enabled)return false;
    if(intent.action==='notifications')return true;
    if(intent.action==='set_address')return accounts().some(a=>a.id===e.accountId)&&logicalId(e.accountId)===e.logicalBotId;
    if(intent.action==='revoke_directive'){
      const directive=ownerDirectiveById(read(),{directiveId:intent.directiveId});
      // Tombstones (and unknown ids) are refused, never re-revoked.
      if(!directive||directive.state!=='active')return false;
      if(directive.action==='address')return directive.accountId===e.accountId&&logicalId(directive.accountId)===e.logicalBotId;
      return accounts().some(a=>a.id===directive.accountId)&&allowedTargets().some(t=>t.accountId===directive.accountId
        &&t.groupId===directive.groupId)&&scopeAllows(directive.accountId,directive.groupId);
    }
    if(!accounts().some(a=>a.id===intent.accountId))return false;
    if(intent.action==='autonomy')return allowedTargets().some(t=>t.accountId===intent.accountId);
    // Actual current pairs only: host.allowedTargets ∩ ownerControl allowlist ∩ real account scope.
    return allowedTargets().some(t=>t.accountId===intent.accountId&&t.groupId===intent.groupId);
  }
  function query(intent,envelope){
    const range=ownerQueryRange(now(),intent.days||1,notificationPolicy().timezone);
    const filters=intent.accountId?{accountId:intent.accountId}:{};
    if(intent.action==='tokens')return{...queryModelUsage(read(),{from:range.from,to:range.to,...filters}),range,prices:'unknown unless independently verified host pricing is available'};
    if(intent.action==='blockers')return{...queryOperationalEvents(read(),{from:range.from,to:range.to,resolved:false,currentOnly:true,...filters}),range,basis:'latest unresolved host events only; not model speculation'};
    if(intent.action==='status')return{accounts:accounts().filter(x=>!intent.accountId||x.id===intent.accountId),notifications:notificationPolicy(),notificationScope:'global',range};
    if(intent.action==='activity')return{...queryOwnerInteractions(read(),{from:range.from,to:range.to,
      logicalBotId:intent.accountId?logicalId(intent.accountId):undefined,accountId:intent.accountId}),range,
      basis:'durable received/sent records; reactions are not new QQ messages'};
    if(intent.action==='why')return whyReport(intent);
    const operationFilter={ownerUserId:envelope?.ownerUserId,accountId:intent.accountId,from:range.from,to:range.to,now:now()};
    if(intent.action==='history')return{operations:ownerOperationHistory(read(),operationFilter),coverage:operationCoverage(envelope?.ownerUserId,intent.accountId,range),range,basis:'operation createdAt; [from,to)'};
    if(intent.action==='tasks')return{...taskStatus(intent.accountId),operations:ownerOperationHistory(read(),operationFilter).filter(x=>['uncertain','accepted','awaiting_confirmation'].includes(x.status)),operationCoverage:operationCoverage(envelope?.ownerUserId,intent.accountId,range),range,basis:'live tasks; operation createdAt within query range'};
    if(intent.action==='people'){
      const target=allowedTargets().find(t=>t.accountId===intent.accountId);
      if(!target||!scopeAllows(target.accountId,target.groupId))throw error('OWNER_PEOPLE_SCOPE_REQUIRED');
      return queryPersonMemory(read(),{logicalBotId:logicalId(intent.accountId),userId:intent.userId,conversationId:`group:${target.groupId}`,now:now()});
    }
    throw error('OWNER_QUERY_UNSUPPORTED');
  }
  /**
   * Deterministic no-reply diagnosis. Only host-observable facts; a missing host
   * fact is reported as unknown rather than guessed, and nothing is re-sent.
   */
  function whyReport(intent){
    const range=ownerQueryRange(now(),1,notificationPolicy().timezone);
    const filters=intent.accountId?{accountId:intent.accountId}:{};
    const rows=accounts().filter(x=>!intent.accountId||x.id===intent.accountId).map(x=>({id:x.id,status:x.status}));
    const quiet=typeof host.quietGroups==='function'?(()=>{try{const value=host.quietGroups(intent.accountId);return Array.isArray(value)?value.filter(g=>qq(String(g))).map(String).slice(0,16):undefined;}catch{return undefined;}})():undefined;
    const autonomy=typeof host.autonomyFor==='function'?(()=>{try{const value=host.autonomyFor(intent.accountId);return typeof value==='boolean'?value:undefined;}catch{return undefined;}})():undefined;
    return{accounts:rows,quietGroupIds:quiet,autonomyEnabled:autonomy,
      participationReduced:reducedParticipation(intent.accountId),
      blockers:queryOperationalEvents(read(),{from:range.from,to:range.to,resolved:false,currentOnly:true,...filters}),
      ...queryOwnerInteractions(read(),{from:range.from,to:range.to,logicalBotId:intent.accountId?logicalId(intent.accountId):undefined,accountId:intent.accountId}),
      range,basis:'host facts only; no model inference and no automatic resend'};
  }
  /** Owner-recorded reduced participation for actual allowed pairs (read-only projection). */
  function reducedParticipation(accountIdValue){
    const rows=[];
    for(const target of allowedTargets().filter(t=>!accountIdValue||t.accountId===accountIdValue).slice(0,32))
      if(ownerGroupParticipationReduced(read(),{logicalBotId:logicalId(target.accountId),groupId:target.groupId}))
        rows.push(`account ${target.accountId} / group ${target.groupId}`);
    return rows;
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
  /**
   * Deterministic host context for the model-free resolver. Only actually allowed
   * pairs (host.allowedTargets ∩ ownerControl.allowedTargets ∩ host.scopeAllows)
   * may appear, so the resolver can never invent a destination.
   */
  function intentContext(e){
    const raw=rawIntentContext(e);
    const allowed=allowedTargets();
    const base=buildOwnerIntentContext({context:raw||{targets:[],accounts:[]},
      allowedTargets:allowed,knownAccounts:accounts().map(a=>a.id),scopeAllows,currentAccountId:e?.accountId||''});
    // Host-supplied names are display metadata only; ids drive routing.
    if(Array.isArray(raw?.accounts))base.accounts=base.accounts.map(row=>{
      const hint=raw.accounts.find(x=>x&&typeof x==='object'&&x.id===row.id);
      return hint?{id:row.id,name:typeof hint.name==='string'&&hint.name.trim()?hint.name.trim().slice(0,80):row.name,
        aliases:Array.isArray(hint.aliases)?hint.aliases.filter(a=>typeof a==='string'&&a.trim()).map(a=>a.trim().slice(0,80)).slice(0,8):row.aliases}:row;
    });
    if(Array.isArray(raw?.targets))base.targets=base.targets.map(row=>{
      const hint=raw.targets.find(x=>x&&typeof x==='object'&&x.accountId===row.accountId&&String(x.groupId)===row.groupId);
      return hint&&typeof hint.name==='string'&&hint.name.trim()?{...row,name:hint.name.trim().slice(0,80)}:row;
    });
    const recent=raw?.recentTarget;
    base.recentTarget=recent&&typeof recent==='object'&&allowed.some(t=>t.accountId===recent.accountId
      &&t.groupId===String(recent.groupId))?{accountId:recent.accountId,groupId:String(recent.groupId)}:null;
    base.currentAccountId=e?.accountId&&allowed.some(t=>t.accountId===e.accountId)?e.accountId:'';
    return base;
  }
  /**
   * Resolve a natural revocation selector to exactly ONE existing active directive that
   * belongs to the current logical identity. Read-only: the revoke itself still goes
   * through the durable claim, `authorize()` and the final `ctx.guard()`.
   *
   * Never fuzzy: 0 matches and 2+ matches are both answered with a bounded clarification
   * instead of picking a row, and nothing outside this logical bot / allowed pair is
   * even looked at.
   */
  function resolveRevocation(selector,e){
    if(!selector||typeof selector!=='object'||!e)return null;
    const logical=e.logicalBotId;
    let rows=[],label='';
    if(selector.kind==='address'){
      // Only this logical identity's own address preference(s): 'use' and/or 'avoid'.
      rows=ownerActiveDirectives(read(),{logicalBotId:logical,action:'address'}).filter(x=>x.accountId===e.accountId);
      label='称呼偏好';
    }else if(selector.kind==='group_participation'){
      const accountId=selector.accountId,groupId=String(selector.groupId);
      // The pair must belong to this logical bot and still be an actually allowed pair.
      rows=accounts().some(a=>a.id===accountId)&&logicalId(accountId)===logical
        &&allowedTargets().some(t=>t.accountId===accountId&&t.groupId===groupId)
        &&scopeAllows(accountId,groupId)
        ?ownerActiveDirectives(read(),{logicalBotId:logical,action:'group_participation',accountId,groupId}):[];
      label=`${accountId}:${groupId} 的减少参与规则`;
    }else if(selector.kind==='poke'){
      const accountId=selector.accountId,groupId=String(selector.groupId);
      rows=accounts().some(a=>a.id===accountId)&&logicalId(accountId)===logical
        &&allowedTargets().some(t=>t.accountId===accountId&&t.groupId===groupId)
        &&scopeAllows(accountId,groupId)
        ?ownerActiveDirectives(read(),{logicalBotId:logical,action:'poke',accountId,groupId,userId:String(selector.userId)}):[];
      label=`${String(selector.userId)} 在该群的拍一拍限制`;
    }else return null;
    if(rows.length===1)return{intent:{action:'revoke_directive',directiveId:rows[0].id}};
    if(!rows.length)return{clarify:{code:'OWNER_DIRECTIVE_NOT_FOUND',candidates:[],
      question:`当前没有生效的${label}，无需取消。`}};
    return{clarify:{code:'OWNER_DIRECTIVE_AMBIGUOUS',
      candidates:rows.slice(0,4).map(row=>row.id),
      question:`${label}有 ${rows.length} 条生效规则，请用 撤销指令 <编号> 指定要取消的那一条。`}};
  }
  const router=createOwnerCommandRouter({read,transact,isOwner:authorized,capture,isCurrent,authorize,query,now,
    parseUtterance:(text,e)=>{
      const parsed=resolveOwnerUtterance(text,intentContext(e));
      // A natural revocation only NAMES a selector; the host turns it into one exact
      // directive id (or refuses with a bounded clarification).
      if(parsed?.intent?.action==='revoke_directive'&&parsed.intent.selector!==undefined){
        const resolved=resolveRevocation(parsed.intent.selector,e);
        return resolved||{clarify:{code:'OWNER_DIRECTIVE_NOT_FOUND',question:'没有可取消的规则。',candidates:[]}};
      }
      return parsed;
    },
    // Only imperative owner prefixes may consult the model at all. Deterministic
    // query phrasing is already resolved above, so ordinary chat never reaches it.
    isLikelyCommand:text=>typeof text==='string'&&/^(?:请|帮我|以后|别再|暂停|恢复|向|给|发送|发个|发一条|撤销|取消|安静|静默|闭嘴|开启|关闭|打开|别|不要|禁止|不许|叫|称呼|减少|降低)/u.test(text.trim()),
    allowDirect:intent=>policy().enabled===true&&policy().lowRiskDirect===true,
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
      if(intent.action==='set_address'){
        const logical=logicalId(ctx.envelope.accountId), avoid=intent.avoid===true;
        const result=await transact(root=>ctx.guard()&&logical===logicalId(ctx.envelope.accountId)?putOwnerDirective(root,{action:'address',
          actorUserId:ctx.envelope.ownerUserId,logicalBotId:logical,accountId:ctx.envelope.accountId,address:intent.text,avoid,
          messageId:ctx.envelope.messageId,authorized:true,now:now()}):{ok:false});
        // Verified against the durable store: the exact preference the owner stated is readable now.
        const saved=result.ok&&(avoid?ownerAddressAvoided(read(),{logicalBotId:logical}).includes(intent.text.trim())
          :ownerAddressFor(read(),{logicalBotId:logical})===intent.text.trim());
        return{status:saved?'confirmed':'blocked',code:saved?(avoid?'OWNER_ADDRESS_AVOIDED':'OWNER_ADDRESS_VERIFIED'):'OWNER_ADDRESS_UNCERTAIN',resultId:result.id};
      }
      if(intent.action==='reduce_participation'){
        const result=await transact(root=>ctx.guard()?putOwnerDirective(root,{action:'group_participation',
          actorUserId:ctx.envelope.ownerUserId,logicalBotId:logicalId(intent.accountId),accountId:intent.accountId,groupId:intent.groupId,
          messageId:ctx.envelope.messageId,authorized:true,now:now()}):{ok:false});
        const saved=result.ok&&ownerGroupParticipationReduced(read(),{logicalBotId:logicalId(intent.accountId),groupId:intent.groupId});
        return{status:saved?'confirmed':'blocked',code:saved?'OWNER_PARTICIPATION_REDUCED':'OWNER_DIRECTIVE_BLOCKED',resultId:result.id};
      }
      if(intent.action==='revoke_directive'){
        const before=ownerDirectiveById(read(),{directiveId:intent.directiveId});
        const result=await transact(root=>ctx.guard()?revokeOwnerDirective(root,{directiveId:intent.directiveId,actorUserId:ctx.envelope.ownerUserId,
          authorized:true,expectedRevision:root.ownerAuthority?.revision,now:now()}):{ok:false});
        const after=ownerDirectiveById(read(),{directiveId:intent.directiveId});
        const effective=result.ok&&after?.state==='revoked';
        if(effective&&before?.action==='group_participation')
          try{host.onParticipationRevoked?.(logicalId(before.accountId),before.groupId);}catch{}
        return{status:effective?'confirmed':'blocked',code:effective?'OWNER_DIRECTIVE_REVOKED':'OWNER_DIRECTIVE_BLOCKED'};
      }
      return{status:'not_supported',code:'OWNER_CAPABILITY_UNSUPPORTED'};
    }});
  return{router,status,settings,query,notificationPolicy,intentContext,allowedTargets,
    /** Bridge helpers: durable owner address preference / reduced group participation. */
    addressFor:accountIdValue=>logicalId(accountIdValue)?ownerAddressFor(read(),{logicalBotId:logicalId(accountIdValue)}):null,
    /** Display labels the owner asked us NOT to use (never authority, never routing). */
    addressAvoidedFor:accountIdValue=>logicalId(accountIdValue)?ownerAddressAvoided(read(),{logicalBotId:logicalId(accountIdValue)}):[],
    participationReducedFor:(accountIdValue,groupId)=>ownerGroupParticipationReduced(read(),{logicalBotId:logicalId(accountIdValue),groupId}),
    async administerPerson(body){
      if(!fields(body,['expectedRevision','personRevision','accountId','userId','operation','entryId','value'])||body.expectedRevision!==getRevision())throw error('OWNER_CONFIG_CONFLICT');
      if(!accounts().some(a=>a.id===body.accountId)||!qq(body.userId)||!ownerIds().length)throw error('OWNER_PEOPLE_SCOPE_REQUIRED');
      const revision=getRevision(),owner=logicalId(body.accountId);
      const result=await transact(root=>revision===getRevision()&&logicalId(body.accountId)===owner?administerPersonMemory(root,{logicalBotId:owner,userId:body.userId,
        expectedRevision:body.personRevision,operation:body.operation,entryId:body.entryId,value:body.value,authorized:true,actorUserId:ownerIds()[0],now:now()}):{ok:false,code:'STALE_CONFIG'});
      return{ok:result.ok,revision:getRevision(),result,profile:queryPersonMemory(read(),{logicalBotId:owner,userId:body.userId,conversationId:`private:${body.userId}`,now:now()})};
    }};
}
