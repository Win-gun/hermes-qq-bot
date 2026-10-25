// Ephemeral, event-driven attention only. Never a reminder, contact permission,
// unread ACK or sending loop. Restart intentionally forgets every watch.
import { randomUUID } from 'node:crypto';
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const safeScope = c => plain(c) && /^(account|group):[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(c.logicalId)
  && /^group:[1-9]\d{0,19}$/.test(c.conversationId);
const qq = id => typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id);
const sourceId = id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(id);
const end = text => /(?:不聊了|到此为止|不用等(?:了)?|别等了|停止关注|晚安|拜拜|先下了|先这样)[。！!\s]*$/u.test(text);
const terms = text => [...new Set(String(text || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{2,16}/gu) || [])].slice(0,8);
export function createSocialInterestWatch({ clock = Date.now, isCurrent, getPolicy, maxScopes = 256 } = {}) {
  if (typeof clock !== 'function' || typeof isCurrent !== 'function' || typeof getPolicy !== 'function'
    || !Number.isSafeInteger(maxScopes) || maxScopes < 1 || maxScopes > 1024) throw new TypeError('INTEREST_DEPENDENCY');
  const scopes = new Map(), key = c => JSON.stringify([c.logicalId,c.conversationId]);
  function guard(c) {
    if (!safeScope(c) || isCurrent(c) !== true) return null;
    const p = getPolicy(c);
    if (!p || p.enabled !== true || p.shadowMode !== false || p.interestWatch?.enabled !== true
      || !p.conversationIds?.includes(c.conversationId)) return null;
    return p.interestWatch;
  }
  function prune(c) {
    if (!guard(c)) { if(safeScope(c))scopes.delete(key(c)); return []; }
    const at=clock(), rows=(scopes.get(key(c))||[]).filter(x=>x.expiresAt>at&&x.createdAt<=at&&x.revision===c.revision);
    if(rows.length)scopes.set(key(c),rows);else scopes.delete(key(c)); return rows;
  }
  function create(c, proposal, { sources = [] } = {}) {
    const p=guard(c); if(!p)return {ok:false,code:'INTEREST_DISABLED'};
    if(!plain(proposal)||Object.keys(proposal).some(k=>!['kind','sourceSeq','ttlMs'].includes(k))
      || !['member','photo','topic','reply'].includes(proposal.kind)
      || !Number.isSafeInteger(proposal.sourceSeq)||proposal.sourceSeq<1
      || !Number.isSafeInteger(proposal.ttlMs)||proposal.ttlMs<1000||proposal.ttlMs>600000
      || !Array.isArray(sources)||sources.length>256) return {ok:false,code:'INTEREST_INVALID'};
    const source=sources.find(x=>x.seq===proposal.sourceSeq), at=clock();
    if(!source||source.isBot===true||source.isQuoted===true||!qq(source.userId)||!sourceId(source.messageId)
      || !Number.isSafeInteger(source.sentAt)||source.sentAt>at||at-source.sentAt>300000
      || typeof source.text!=='string'||source.text.length>4000||end(source.text)) return {ok:false,code:'INTEREST_SOURCE'};
    const maxDuration=Number.isSafeInteger(p.maxDurationMs)?Math.max(1000,Math.min(600000,p.maxDurationMs)):300000;
    const limit=Number.isSafeInteger(p.maxActive)?Math.max(1,Math.min(4,p.maxActive)):4;
    // Reclaim expired, untouched scopes as well: a quiet group must not hold a
    // global slot forever. No messages or model calls are needed for cleanup.
    for (const [scope, items] of scopes) {
      const live = items.filter(row => row.expiresAt > at && row.createdAt <= at);
      if (live.length) scopes.set(scope, live); else scopes.delete(scope);
    }
    const rows=prune(c), topic=terms(source.text);
    if(proposal.kind==='topic'&&!topic.length)return {ok:false,code:'INTEREST_SOURCE'};
    if(rows.some(x=>x.sourceMessageId===source.messageId&&x.kind===proposal.kind))return {ok:false,code:'INTEREST_DUPLICATE'};
    if(rows.length>=limit||(!scopes.has(key(c))&&scopes.size>=maxScopes))return {ok:false,code:'INTEREST_CAPACITY'};
    const watch={id:'interest_'+randomUUID(),kind:proposal.kind,userId:source.userId,sourceMessageId:source.messageId,
      revision:c.revision,sourceSentAt:source.sentAt,createdAt:at,expiresAt:at+Math.min(maxDuration,proposal.ttlMs),topic};
    scopes.set(key(c),[...rows,watch]);return {ok:true,id:watch.id,expiresAt:watch.expiresAt};
  }
  function observe(c, event) {
    const rows=prune(c), at=clock();
    if(!plain(event)||!sourceId(event.messageId)||!qq(event.userId)||event.isBot===true||event.isQuoted===true
      ||!Number.isSafeInteger(event.sentAt)||event.sentAt>at||at-event.sentAt>300000
      ||typeof event.text!=='string'||event.text.length>4000)return {matched:false,reason:'invalid-source'};
    const remaining=[],matched=[];
    for(const row of rows){
      if(row.sourceMessageId===event.messageId || event.sentAt < row.sourceSentAt){remaining.push(row);continue;}
      if(row.userId===event.userId&&end(event.text))continue;
      const topicMatch=row.topic.some(t=>event.text.normalize('NFKC').toLowerCase().includes(t));
      const hit=row.kind==='topic'?topicMatch:row.userId===event.userId&&(row.kind!=='photo'||event.hasImage===true);
      if(hit)matched.push(row);else remaining.push(row);
    }
    if(remaining.length)scopes.set(key(c),remaining);else scopes.delete(key(c));
    return {matched:matched.length>0,reason:matched.length?'interest-'+matched[0].kind:'ordinary',ids:matched.map(x=>x.id)};
  }
  function cancel(logicalId,conversationId,id) {
    let count=0;
    for(const [k,rows]of scopes){const [bot,conv]=JSON.parse(k);if(bot!==logicalId||(conversationId!==undefined&&conv!==conversationId))continue;
      const next=id?rows.filter(r=>r.id!==id):[];count+=rows.length-next.length;if(next.length)scopes.set(k,next);else scopes.delete(k);}
    return {cancelled:count};
  }
  function status(c) { return {ephemeral:true,restartReplay:false,items:prune(c).map(({id,kind,createdAt,expiresAt})=>({id,kind,createdAt,expiresAt}))}; }
  return Object.freeze({create,observe,cancel,status});
}
