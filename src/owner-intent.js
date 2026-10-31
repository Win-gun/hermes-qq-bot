/**
 * Deterministic owner-utterance resolver (Owner First 3.4).
 *
 * Pure, synchronous, model-free. It turns a short Chinese owner utterance into ONE
 * strictly bounded intent, or into an explicit clarification, or `null` for ordinary
 * chat. It NEVER creates an actor, a permission, a target grant or a new action kind:
 * every destination must already be an actually allowed account/group pair.
 *
 * Trusted host contract (all synchronous):
 *   host.intentContext(envelope) -> { accounts:[{id,name,aliases?}],
 *                                     targets:[{accountId,groupId,name}],
 *                                     recentTarget?:{accountId,groupId} }
 *   host.allowedTargets?() -> [{accountId,groupId}]   (else legacy ownerControl.allowedTargets)
 * Both are intersected with the real account list and host.scopeAllows().
 */
const qq = v => typeof v === 'string' && /^[1-9]\d{4,19}$/.test(v);
const id = v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
const plain = v => v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && !Array.isArray(v);
const safeLabel = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 80
  && !/\[\s*CQ\s*:|[\u0000-\u001f\u007f]/u.test(v) && !/^[/\\]|^(?:sk-|bearer|password|secret)/iu.test(v);

export const OWNER_INTENT_LIMITS = Object.freeze({ text: 4096, accounts: 64, accountAliases: 8, targets: 256, candidates: 4,
  groupName: 80, minutes: 10080 });

const norm = v => String(v ?? '').normalize('NFKC').replace(/[\s\u3000]+/gu, '').toLowerCase();
/** Polite lead-ins and the explicit `/owner` prefix are noise, not part of the request. */
const strip = text => String(text ?? '').trim()
  .replace(/^[\s"'“”「」『』]+/u, '').replace(/[\s"'“”「」『』。！？!?、,，.~～…]+$/u, '')
  .replace(/^\/owner(?:\s+|$)/iu, '')
  .replace(/^(?:帮我|请问|麻烦你|麻烦|查一下|查询一下|查询|查下|看一下|看看|给我|请)+/u, '')
  .trim();

/** Validate + intersect the host context. Unknown/unauthorized pairs are DROPPED, never guessed. */
export function buildOwnerIntentContext({ context, allowedTargets = [], knownAccounts = [], scopeAllows = () => false,
  currentAccountId = '' } = {}) {
  const source = plain(context) ? context : {};
  const accountIds = new Set((Array.isArray(knownAccounts) ? knownAccounts : []).filter(id));
  const accounts = [];
  for (const row of (Array.isArray(source.accounts) ? source.accounts : []).slice(0, OWNER_INTENT_LIMITS.accounts)) {
    if (!plain(row) || !id(row.id) || !accountIds.has(row.id)) continue;
    const aliases = (Array.isArray(row.aliases) ? row.aliases : []).slice(0, OWNER_INTENT_LIMITS.accountAliases)
      .filter(safeLabel).map(value => value.trim());
    accounts.push({ id: row.id, name: safeLabel(row.name) ? row.name.trim() : row.id, aliases: [...new Set(aliases)] });
  }
  for (const accountId of accountIds) if (!accounts.some(row => row.id === accountId)) accounts.push({ id: accountId, name: accountId, aliases: [] });
  const allowed = (Array.isArray(allowedTargets) ? allowedTargets : []).filter(row => plain(row) && id(row.accountId)
    && qq(row.groupId) && accountIds.has(row.accountId) && scopeAllows(row.accountId, row.groupId) === true);
  const targets = [];
  const seen = new Set();
  for (const row of (Array.isArray(source.targets) ? source.targets : []).slice(0, OWNER_INTENT_LIMITS.targets)) {
    if (!plain(row) || !id(row.accountId) || !qq(row.groupId)) continue;
    // Only an actually allowed pair may become a destination.
    if (!allowed.some(a => a.accountId === row.accountId && a.groupId === String(row.groupId))) continue;
    const key = `${row.accountId}:${row.groupId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ accountId: row.accountId, groupId: String(row.groupId), name: safeLabel(row.name) ? row.name.trim() : "" });
  }
  for (const row of allowed) {
    const key = `${row.accountId}:${row.groupId}`;
    if (!seen.has(key)) { seen.add(key); targets.push({ accountId: row.accountId, groupId: String(row.groupId), name: "" }); }
  }
  const recent = plain(source.recentTarget) && targets.some(t => t.accountId === source.recentTarget.accountId
    && t.groupId === String(source.recentTarget.groupId))
    ? { accountId: source.recentTarget.accountId, groupId: String(source.recentTarget.groupId) } : null;
  return { accounts, targets, recentTarget: recent, currentAccountId: id(currentAccountId) ? currentAccountId : "" };
}

function matchAccount(token, context) {
  const value = norm(token);
  if (!value) return { status: 'unknown' };
  const rows = context.accounts.filter(row => row.id.toLowerCase() === value
    || norm(row.name) === value || row.aliases.some(alias => norm(alias) === value));
  if (rows.length === 1) return { status: 'ok', value: rows[0] };
  if (rows.length > 1) return { status: 'ambiguous', candidates: rows.map(row => row.name) };
  return { status: 'unknown' };
}

const bare = v => v.replace(/群$/u, '');
/** Unique-name / QQ resolution. Ambiguity is resolved ONLY by current bot, then recent target. */
function matchTarget(token, context) {
  const value = norm(token).replace(/^(?:qq群|群号)/u, '');
  if (!value) return { status: 'unknown' };
  // Grammar may consume a trailing 群; a bare 群 suffix is not part of the name.
  const rows = context.targets.filter(row => row.groupId === value || row.groupId === bare(value)
    || norm(row.name) === value || (norm(row.name) && bare(norm(row.name)) === bare(value)));
  if (rows.length === 1) return { status: 'ok', value: rows[0] };
  if (rows.length === 0) return { status: 'unknown' };
  const name = rows.map(row => `${row.accountId}:${row.groupId}${row.name ? ` ${row.name}` : ''}`);
  const byCurrent = context.currentAccountId ? rows.filter(row => row.accountId === context.currentAccountId) : [];
  if (byCurrent.length === 1) return { status: 'ok', value: byCurrent[0] };
  const byRecent = context.recentTarget ? rows.filter(row => row.accountId === context.recentTarget.accountId
    && row.groupId === context.recentTarget.groupId) : [];
  if (byRecent.length === 1) return { status: 'ok', value: byRecent[0] };
  return { status: 'ambiguous', candidates: name };
}

/** Only an already-allowed pair may be implicit: single allowed target, else the recent target. */
function implicitTarget(context) {
  if (context.targets.length === 1) return { ok: true, target: context.targets[0] };
  if (context.recentTarget) {
    const recent = context.targets.find(row => row.accountId === context.recentTarget.accountId
      && row.groupId === context.recentTarget.groupId);
    if (recent) return { ok: true, target: recent };
  }
  return { ok: false, ...clarify('OWNER_TARGET_REQUIRED', TARGET_QUESTION) };
}

const clarify = (code, question, candidates = []) => ({ clarify: { code, question,
  candidates: [...new Set(candidates)].slice(0, OWNER_INTENT_LIMITS.candidates) } });
const TARGET_QUESTION = '请给出明确账号和QQ群（例如 /owner send <账号> <群号> <文字>），我不猜目的地。';

/** Resolve an account/group pair from explicit tokens; never fabricate authority. */
function target(token, context) {
  const found = matchTarget(token, context);
  if (found.status === 'ok') return { ok: true, target: found.value };
  if (found.status === 'ambiguous') return { ok: false, ...clarify('OWNER_TARGET_AMBIGUOUS',
    `“${String(token).slice(0, 40)}”匹配多个授权群，请说明账号和QQ群。`, found.candidates) };
  return { ok: false, ...clarify('OWNER_TARGET_REQUIRED', TARGET_QUESTION) };
}

function account(token, context) {
  const found = matchAccount(token, context);
  if (found.status === 'ok') return { ok: true, value: found.value };
  if (found.status === 'ambiguous') return { ok: false, ...clarify('OWNER_ACCOUNT_AMBIGUOUS',
    `“${String(token).slice(0, 40)}”匹配多个账号，请用账号ID说明。`, found.candidates) };
  return { ok: false, ...clarify('OWNER_ACCOUNT_REQUIRED', '请给出明确账号ID（例如 /owner send <账号> <群号> <文字>）。') };
}

/** Target + (optional) account from `<account> <group>` or a single unique group token. */
function pairFromTokens(tokens, context) {
  if (tokens.length >= 2) {
    const acct = account(tokens[0], context);
    if (!acct.ok) {
      const asGroup = matchTarget(tokens[0], context);
      if (asGroup.status === 'unknown' && matchAccount(tokens[0], context).status === 'unknown') return acct;
    } else {
      const found = matchTarget(tokens[1], context);
      if (found.status === 'ok' && found.value.accountId === acct.value.id) return { ok: true, target: found.value };
      if (found.status === 'ok') return { ok: false, ...clarify('OWNER_TARGET_AMBIGUOUS',
        '该群不属于这个账号，请说明允许的账号和QQ群。', [`${found.value.accountId}:${found.value.groupId}`]) };
      if (found.status === 'ambiguous') return { ok: false, ...clarify('OWNER_TARGET_AMBIGUOUS',
        `“${String(tokens[1]).slice(0, 40)}”匹配多个授权群，请说明账号和QQ群。`, found.candidates) };
      return { ok: false, ...clarify('OWNER_TARGET_REQUIRED', TARGET_QUESTION) };
    }
  }
  if (tokens.length === 1) return target(tokens[0], context);
  return { ok: false, ...clarify('OWNER_TARGET_REQUIRED', TARGET_QUESTION) };
}

const QUERY_RULES = [
  [/^(?:你)?(?:今天|今日)(?:一共|总共)?(?:消耗|使用|用了)(?:了)?多少(?:token|令牌)$/iu, { action: 'tokens', days: 1 }],
  [/^(?:你)?(?:今天|今日)(?:都)?(?:遇到|碰到|有)(?:了)?(?:什么|哪些)(?:主要)?(?:阻碍|问题|故障|报错)$/u, { action: 'blockers' }],
  [/^(?:你)?(?:今天|今日)(?:都)?(?:干|做)了(?:些什么|什么|哪些事)(?:情)?$/u, { action: 'activity', days: 1 }],
  [/^(?:刚才|刚刚)(?:我)?(?:让|叫|请)你做的(?:事情|事|操作|任务)(?:现在)?(?:怎么样了|完成了吗|完成了|做完了吗|有结果了吗)$/u, { action: 'history' }],
  [/^(?:你)?(?:为什么|为啥)(?:没有|没|不)(?:回复|回|理)(?:刚才|刚刚)?(?:那个群|这个群|该群|本群)$/u, { action: 'why' }],
  [/^(?:今天|今日|当天)(?:的)?(?:token|令牌|用量|消耗|调用|调用量|用量情况)(?:是多少|多少|用了多少)?$/iu, { action: 'tokens', days: 1 }],
  [/^(?:今天|今日)?用了多少(?:token|令牌)$/iu, { action: 'tokens', days: 1 }],
  [/^(?:最近|近)(?:七|7)天(?:的)?(?:token|令牌|用量|消耗|调用量)(?:是多少|多少)?$/iu, { action: 'tokens', days: 7 }],
  [/^(?:今天|今日|当前)(?:的)?(?:主要)?(?:阻碍|故障|问题|报错|阻碍项|障碍)(?:是什么|有哪些|情况)?$/u, { action: 'blockers' }],
  [/^(?:今天|今日)(?:的)?(?:活跃|活跃度|互动|收发|消息统计|活跃情况|活跃数据)(?:怎么样|如何)?$/u, { action: 'activity', days: 1 }],
  [/^(?:最近|近)(?:七|7)天(?:的)?(?:活跃|活跃度|互动|收发|活跃情况|活跃数据)$/u, { action: 'activity', days: 7 }],
  [/^(?:任务|今天任务|今日任务|当前任务|任务状态|任务列表|未完成任务|未完成的任务和命令)(?:呢|怎么样)?$/u, { action: 'tasks' }],
  [/^(?:历史|历史记录|操作历史|操作记录|最近操作|命令历史|最近操作记录)$/u, { action: 'history' }],
  [/^(?:群里|刚才|刚刚)?(?:为什么|为啥|咋)(?:没|不)(?:有)?(?:回复|回|说话|动静|反应|理人|发消息|出声)(?:呢|啊|呀)?$/u, { action: 'why' }],
  [/^(?:why no reply|why no response|why silent)$/iu, { action: 'why' }],
  [/^(?:当前账号状态|账号状态|运行状态|查询运行状态|状态)$/u, { action: 'status' }],
];

/** Deterministic query phrasing. Anchored: unrelated chat can never match. */
export function parseOwnerQueryUtterance(text) {
  const body = strip(text);
  if (!body || body.length > OWNER_INTENT_LIMITS.text) return null;
  const variants = [body, body.replace(/[\s\u3000]+/gu, '')];
  for (const [pattern, value] of QUERY_RULES) if (variants.some(candidate => pattern.test(candidate))) return { ...value };
  return null;
}

const QUIET_VERB = /^(?:群里?)?(?:一下)?(?:安静|静默|闭嘴|停止发言|暂停发言|别说话)(?:一下)?(?:[\s:：]*(\d{1,5})\s*分钟)?$/u;
const RESUME_VERB = /^(?:群里?|的发言|的静默|的安静|发言|静默|安静)?$/u;
/** Persistent reduced participation. Distinct from the temporary `quiet` timer:
 *  "少说话"/"尽量少说话" is a standing preference the owner can revoke, not a countdown. */
const REDUCE_VERB = /^(?:群里?)?(?:的|里)?(?:(?:尽量|以后|就|都)?(?:再)?(?:少|别那么|不要那么|不要太|不要|少一些|减少|降低|控制|限制)(?:一点|一些)?(?:说话|发言|插话|接话|讲话|互动|聊天|参与|积极|存在感)(?:度)?(?:一点|一些|点|点儿)?(?:吧|啊|呀|哦)?|(?:说话|发言|插话|接话|讲话|互动|聊天|参与)(?:度)?(?:降低|减少)?(?:一点|一些|点)?)(?:\s*一下)?$/u;
const ADDRESS_PREFIX = /^(?:以后|之后)?\s*([\s\S]{0,40}?)(?:称呼我为|称我为|称呼我|称我|叫我|喊我)\s*([\s\S]{1,80})$/u;
/** Innocuous lead-in: the owner is simply stating the preference ("我希望你以后…"). */
const ADDRESS_NEUTRAL = /^(?:我)?(?:也)?(?:希望|想|要|请|请你|请都|就|都|以后|之后|帮我|麻烦你|麻烦|你)*$/u;
/** Explicit negative framing: "我不喜欢你总是称呼我主人" — a bounded avoid-preference. */
const ADDRESS_NEGATIVE = /(?:不喜欢|不希望|不想|不愿意|不要|不用|不必|不许|别|禁止|讨厌|受不了)/u;
const STICKER_VERB = /^(?:群里?)?(?:发个|发一个|来一个|来个|发|发送|来)?(?:表情|贴纸|表情包)[:：,，]?\s*([\s\S]+)$/u;
const STICKER_DESCRIPTION = /^(?:群里?)?(?:发|发送|来)(?:一个|一张|个|张)?\s*(.{1,200}?)(?:的)?(?:表情包|表情|贴纸)$/u;
const TEXT_VERB = /^(?:群里?)?(?:发个|发一条|发|发送|说一句|说|讲|通知|喊)(?:一?句|一下|一个|个|条)?[:：,，]?\s*([\s\S]+)$/u;
const LEAD = /^(?:给|向|在|对|让|把|去|到)/u;
/** The remainder must still look like an owner write; otherwise this is ordinary chat. */
const VERB_HINT = /(?:发一句|发消息|发个|发一条|发送|说一句|通知|表情|贴纸|安静|静默|闭嘴|恢复|减少|降低|少说话|称呼)/u;

/**
 * Longest-prefix destination match. Bounded by the smallest allowed name length,
 * so ordinary chat cannot be scanned without limit.
 */
function destinationPrefix(remainder, context) {
  const relative = /^(?:(?:刚才|刚刚)?(?:那个群|这个群)|该群|当前群|本群)(?:里|中)?/u.exec(remainder);
  if (relative) {
    const resolved = implicitTarget(context);
    return resolved.ok ? { ok: true, target: resolved.target, rest: remainder.slice(relative[0].length).replace(/^\s*先/u, '').trim() }
      : { ok: false, clarify: resolved.clarify };
  }
  const maxName = context.targets.reduce((best, row) => Math.max(best, row.name ? norm(row.name).length : 0,
    row.groupId.length), 0);
  const limit = Math.min(remainder.length, Math.max(6, maxName) + 8);
  let ambiguous = null;
  for (let size = limit; size >= 2; size -= 1) {
    const prefix = remainder.slice(0, size);
    if (!prefix.trim()) break;
    const found = target(prefix, context);
    if (found.ok) return { ok: true, target: found.target, rest: remainder.slice(size).replace(/^[\s:：,，]+/u, '') };
    if (found.clarify?.code === 'OWNER_TARGET_AMBIGUOUS' && !ambiguous) ambiguous = found.clarify;
  }
  return ambiguous ? { ok: false, clarify: ambiguous } : { ok: false };
}

/** Destinations from "@account group rest" tokens, else the longest authorized prefix. */
function destinationThen(remainder, context) {
  const tokens = remainder.split(/\s+/u);
  if (tokens.length >= 3) {
    const acct = matchAccount(tokens[0], context);
    if (acct.status === 'ok') {
      const found = matchTarget(tokens[1], context);
      const consumed = remainder.slice(tokens[0].length).replace(/^\s+/u, '');
      const rest = consumed.slice(tokens[1].length).replace(/^[\s:：,，]+/u, '');
      if (found.status === 'ok' && found.value.accountId === acct.value.id) return { ok: true, target: found.value, rest };
      if (found.status === 'ok') return { ok: false, ...clarify('OWNER_TARGET_AMBIGUOUS',
        '该群不属于这个账号，请说明允许的账号和QQ群。', [`${found.value.accountId}:${found.value.groupId}`]) };
      if (found.status === 'ambiguous') return { ok: false, ...clarify('OWNER_TARGET_AMBIGUOUS',
        `“${String(tokens[1]).slice(0, 40)}”匹配多个授权群，请说明账号和QQ群。`, found.candidates) };
      if (VERB_HINT.test(remainder)) return { ok: false, ...clarify('OWNER_TARGET_REQUIRED', TARGET_QUESTION) };
    }
  }
  return destinationPrefix(remainder, context);
}

/**
 * Address preference grammar. The lead-in before the address verb decides everything:
 * neutral ("以后", "请") → the owner WANTS this label; explicitly negative
 * ("我不喜欢你总是", "以后别") → the owner wants it AVOIDED; anything else unclear is
 * ordinary chat, so no persistent preference is ever created from a vague sentence.
 */
function addressPhrase(body) {
  const found = ADDRESS_PREFIX.exec(body);
  if (!found) return null;
  const lead = found[1].trim(), text = found[2].trim();
  if (!safeLabel(text) || text.length > OWNER_INTENT_LIMITS.groupName) return null;
  if (lead && !ADDRESS_NEUTRAL.test(lead)) return ADDRESS_NEGATIVE.test(lead) ? { action: 'set_address', text, avoid: true } : null;
  return { action: 'set_address', text };
}

/**
 * "以后这个群尽量少说话" — a standing reduced-participation preference for the group
 * currently in view, as opposed to the temporary `quiet` countdown. It needs either a
 * standing marker (以后/之后) or an explicit group marker (这个群/本群/…), and it is
 * resolved ONLY through implicitTarget (single allowed target or the verified recent
 * one); without one we ask instead of guessing a destination.
 */
/**
 * Natural revocation of an EXISTING owner-created directive. It never decides *what* to
 * delete: it only names a bounded selector (kind + resolved target), and the host must
 * find exactly one active, owned directive for it. Ambiguity is a clarification, never a
 * guess, and no directive id is ever fabricated here.
 */
const REVOKE_VERB = /^(?:取消|撤销|收回|解除|去掉|撤掉)(?:一下)?/u;
const RENAME_VERB = /^(?:恢复|取消|撤销|收回|解除|去掉|撤掉)(?:一下)?/u;
const ADDRESS_OBJECT = /^(?:以后|之后的?)?\s*(?:对我的?|我的?|你?对我的?)?\s*(?:称呼)(?:偏好|习惯|设定|设置|要求)?(?:吧|啊)?$/u;
const PARTICIPATION_OBJECT = /^(?:正常)?(?:发言|参与|说话|互动|接话|聊天)(?:吧|啊)?$|^(?:少说话|减少参与|减少发言|参与限制|发言限制|减少互动)(?:的)?(?:要求|限制|规则|设定)?(?:吧|啊)?$/u;
const GROUP_SCOPE_ONLY = /^(?:在)?\s*(?:这个群|这群|本群|该群|当前群)(?:里|中)?(?:的|里)?\s*/u;

function revokePhrase(body, context) {
  // 1) "取消对我的称呼偏好" — the address preference of THIS logical identity only.
  if (REVOKE_VERB.test(body)) {
    const rest = body.replace(REVOKE_VERB, '').trim();
    if (ADDRESS_OBJECT.test(rest)) return { action: 'revoke_directive', selector: { kind: 'address' } };
  }
  // 2) "恢复这个群正常发言" / "取消这个群少说话的要求" / "恢复开发群正常发言"
  //    — the reduced-participation rule only, never a temporary quiet.
  if (RENAME_VERB.test(body)) {
    let rest = body.replace(RENAME_VERB, '').trim();
    const scoped = GROUP_SCOPE_ONLY.test(rest);
    if (scoped) {
      rest = rest.replace(GROUP_SCOPE_ONLY, '').trim();
      // "这个群" is only usable when the group is unambiguous; otherwise ask.
      if (PARTICIPATION_OBJECT.test(rest)) {
        const implicit = implicitTarget(context);
        if (!implicit.ok) return { clarify: implicit.clarify || clarify('OWNER_TARGET_REQUIRED', TARGET_QUESTION).clarify };
        return { action: 'revoke_directive', selector: { kind: 'group_participation',
          accountId: implicit.target.accountId, groupId: implicit.target.groupId } };
      }
    } else {
      // A named/QQ destination must resolve to an already-allowed pair before it counts.
      const found = destinationPrefix(rest, context);
      if (found.ok && PARTICIPATION_OBJECT.test(found.rest))
        return { action: 'revoke_directive', selector: { kind: 'group_participation',
          accountId: found.target.accountId, groupId: found.target.groupId } };
      if (found.ok) return null;
      if (found.clarify) return { clarify: found.clarify };
      if (PARTICIPATION_OBJECT.test(rest)) return { clarify: clarify('OWNER_TARGET_REQUIRED', TARGET_QUESTION).clarify };
    }
  }
  // 3) "取消禁止拍一拍 22001…" — only with a real QQ id and a resolved allowed target.
  const poke = /^(?:取消|撤销|解除|去掉|撤掉|允许)(?:一下)?(?:禁止|限制)?(?:拍|戳)(?:一拍|一戳)?\s*([1-9]\d{4,19})(?:\s+(\S+)\s+(\S+))?$/u.exec(body);
  if (poke) {
    if (poke[2] && poke[3]) {
      const resolved = pairFromTokens([poke[2], poke[3]], context);
      if (!resolved.ok) return resolved.clarify ? { clarify: resolved.clarify } : null;
      return { action: 'revoke_directive', selector: { kind: 'poke', accountId: resolved.target.accountId,
        groupId: resolved.target.groupId, userId: poke[1] } };
    }
    const single = implicitTarget(context);
    if (!single.ok) return { clarify: single.clarify || clarify('OWNER_TARGET_REQUIRED', TARGET_QUESTION).clarify };
    return { action: 'revoke_directive', selector: { kind: 'poke', accountId: single.target.accountId,
      groupId: single.target.groupId, userId: poke[1] } };
  }
  return null;
}

const reduceBody = rest => REDUCE_VERB.test(rest) || REDUCE_VERB.test(rest.replace(/^(?:尽量|以后|就|都|再|一点|一些|点儿|点)+/u, ''));

function groupScopedReduce(body, context) {
  let rest = body;
  let standing = false;
  const timely = /^(?:以后|之后)\s*/u.exec(rest);
  if (timely) { rest = rest.slice(timely[0].length); standing = true; }
  const scoped = /^(?:在)?\s*(?:这个群|这群|本群|该群|当前群)(?:里|中)?(?:的|里)?\s*/u.exec(rest);
  if (scoped) { rest = rest.slice(scoped[0].length); standing = true; }
  rest = rest.trim();
  if (!standing || !rest) return null;
  if (!reduceBody(rest)) return null;
  const resolved = implicitTarget(context);
  if (!resolved.ok) return { clarify: resolved.clarify || clarify('OWNER_TARGET_REQUIRED', TARGET_QUESTION) };
  return { action: 'reduce_participation', accountId: resolved.target.accountId, groupId: resolved.target.groupId };
}

/** Bounded write phrasing that needs a resolvable, already-allowed destination. */
export function parseOwnerWriteUtterance(text, context) {
  // Only a trailing minute duration is normalized. No group/member identity is
  // inferred from language, and the resulting numeric intent is still bounded
  // by the capability validator.
  const body = strip(text).replace(/([一二两三四五六七八九十]{1,3})(?=分钟$)/u, value => {
    const digit = ch => '零一二三四五六七八九'.indexOf(ch === '两' ? '二' : ch);
    if (!value.includes('十')) return value.length === 1 ? String(digit(value)) : value;
    if (!/^[一二三四五六七八九]?十[一二三四五六七八九]?$/u.test(value)) return value;
    const [tens, ones] = value.split('十'); return String((tens ? digit(tens) : 1) * 10 + (ones ? digit(ones) : 0));
  });
  if (!body || body.length > OWNER_INTENT_LIMITS.text) return null;
  const done = value => ({ intent: value });

  if (/^(?:以后|今后|之后)?(?:只|就|只要)?(?:在)?(?:每天)?(?:早晚|早上和晚上|早上、晚上)(?:各)?(?:给我)?(?:汇报|报备|报告|发日报|发摘要)(?:一[次份])?(?:就好|即可|就行)?$/u.test(body)
    || /^(?:以后|今后|之后)?(?:别|不要)(?:再)?频繁(?:地)?给我(?:发消息|汇报|报备|报告)$/u.test(body))
    return done({ action: 'notifications', enabled: true, times: ['09:00', '21:00'], timezone: 'Asia/Shanghai' });

  // Explicit "verb <account> <group> <payload>" form.
  let m = /^(?:发送|发消息|发到|发送到|发)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/u.exec(body);
  if (m) {
    const resolved = pairFromTokens([m[1], m[2]], context);
    if (!resolved.ok) return resolved.clarify ? { clarify: resolved.clarify } : null;
    return done({ action: 'send_text', accountId: resolved.target.accountId, groupId: resolved.target.groupId, text: m[3].trim() });
  }
  m = /^(?:发个|发一个|来一个|来个|发送|发|来)?\s*(?:表情|贴纸|表情包)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/u.exec(body);
  if (m) {
    const resolved = pairFromTokens([m[1], m[2]], context);
    if (!resolved.ok) return resolved.clarify ? { clarify: resolved.clarify } : null;
    return done({ action: 'send_sticker', accountId: resolved.target.accountId, groupId: resolved.target.groupId, query: m[3].trim() });
  }

  // Destination-free bounded preferences and rules.
  m = /^(?:关闭|开启|打开|关|开|暂停)(.+?)(?:的)?(?:自动参与|自主|主动发言|自动化)$/u.exec(body);
  if (m) {
    const acct = account(m[1], context);
    // An ambiguous account nickname must be resolved by the owner, not guessed;
    // an unknown one is ordinary chat and stays unmatched.
    if (!acct.ok) return acct.clarify?.code === 'OWNER_ACCOUNT_AMBIGUOUS' ? { clarify: acct.clarify } : null;
    return done({ action: 'autonomy', accountId: acct.value.id, enabled: !/^(?:关闭|关|暂停)/u.test(body) });
  }
  m = /^(?:关闭|开启|打开|关|开)(?:一下)?(?:主人)?(?:通知|报备)(?:[\s]*(\d{1,2}:\d{2})\s*[,，、]?\s*(\d{1,2}:\d{2})?)?(?:\s*([A-Za-z_/+-]{1,64}))?$/u.exec(body);
  if (m) {
    const times = [m[1], m[2]].filter(Boolean).map(value => value.padStart(2, '0'));
    return done({ action: 'notifications', enabled: /^(?:开启|打开|开)/u.test(body),
      times: times.length ? times : ['09:00', '21:00'],
      timezone: m[3] && /^[A-Za-z_/+-]+$/u.test(m[3]) ? m[3] : 'Asia/Shanghai' });
  }
  m = /^(?:撤销|取消|收回)(?:指令|规则)?\s*([a-f0-9]{32})$/iu.exec(body);
  if (m) return done({ action: 'revoke_directive', directiveId: m[1].toLowerCase() });
  // Natural revocation of an existing owned directive (resolved to an exact id later).
  const revocation = revokePhrase(body, context);
  if (revocation) return revocation.clarify ? { clarify: revocation.clarify } : done(revocation);

  // Address preference (display label per logical identity — never authority).
  //   "以后叫我老板"                      -> use  "老板"
  //   "我不喜欢你总是称呼我主人"          -> avoid "主人"
  // A lead-in that is neither neutral nor explicitly negative makes this ordinary
  // chat: no persistent directive is created from an unclear owner sentence.
  const address = addressPhrase(body);
  if (address) return done(address);
  m = /^(?:别|不要|禁止|不许)(?:再)?(?:拍|戳)(?:一拍)?\s*([1-9]\d{4,19})(?:\s+(\S+)\s+(\S+))?$/u.exec(body);
  if (m) {
    if (m[2] && m[3]) {
      const resolved = pairFromTokens([m[2], m[3]], context);
      if (!resolved.ok) return resolved.clarify ? { clarify: resolved.clarify } : null;
      return done({ action: 'restrict_poke', accountId: resolved.target.accountId, groupId: resolved.target.groupId, userId: m[1] });
    }
    const single = implicitTarget(context);
    if (!single.ok) return clarify('OWNER_TARGET_REQUIRED', `${TARGET_QUESTION}（拍一拍限制需要明确账号和群。）`);
    return done({ action: 'restrict_poke', accountId: single.target.accountId, groupId: single.target.groupId, userId: m[1] });
  }
  m = /^(?:安静|静默|闭嘴)(?:一下)?(?:\s*(\d{1,5})\s*分钟)?$/u.exec(body);
  if (m) {
    const resolved = implicitTarget(context);
    if (!resolved.ok) return resolved.clarify ? { clarify: resolved.clarify } : null;
    return done({ action: 'quiet', accountId: resolved.target.accountId, groupId: resolved.target.groupId,
      minutes: m[1] === undefined ? 30 : Number(m[1]) });
  }

  // Standing group-scoped reduced participation ("以后这个群尽量少说话").
  const scopedReduce = groupScopedReduce(body, context);
  if (scopedReduce) return scopedReduce.clarify ? { clarify: scopedReduce.clarify } : done(scopedReduce);

  // Verb-first destination forms: <verb><destination>[payload].
  m = /^(?:恢复|解除|取消|开放)(?:一下)?\s*([\s\S]+)$/u.exec(body);
  if (m) {
    const found = destinationPrefix(m[1], context);
    // Ordinary chat ("取消这个想法") must stay unmatched: only a real resume phrase asks.
    if (!found.ok) { if (found.clarify) return { clarify: found.clarify };
      return RESUME_VERB.test(m[1].trim()) ? clarify('OWNER_TARGET_REQUIRED', TARGET_QUESTION) : null; }
    if (!RESUME_VERB.test(found.rest)) return null;
    return done({ action: 'resume', accountId: found.target.accountId, groupId: found.target.groupId });
  }
  m = /^(?:减少|降低|少|别那么)(?:一下|一点|一些)?\s*([\s\S]+)$/u.exec(body);
  if (m) {
    const found = destinationPrefix(m[1], context);
    if (!found.ok) { if (found.clarify) return { clarify: found.clarify };
      return REDUCE_VERB.test(m[1].trim()) ? clarify('OWNER_TARGET_REQUIRED', TARGET_QUESTION) : null; }
    if (!REDUCE_VERB.test(found.rest)) return null;
    return done({ action: 'reduce_participation', accountId: found.target.accountId, groupId: found.target.groupId });
  }

  // Destination-first forms: <lead><destination><verb><payload>.
  if (!LEAD.test(body)) return null;
  const remainder = body.replace(/^(?:给|向|在|对|让|把|去|到)/u, '');
  const found = destinationThen(remainder, context);
  if (!found.ok) {
    // A write verb without a resolvable, already-allowed destination must ask.
    if (!VERB_HINT.test(remainder)) return null;
    return found.clarify ? { clarify: found.clarify } : clarify('OWNER_TARGET_REQUIRED', TARGET_QUESTION);
  }
  const rest = found.rest;
  const base = { accountId: found.target.accountId, groupId: found.target.groupId };
  if (RESUME_VERB.test(rest)) return done({ action: 'resume', ...base });
  if (REDUCE_VERB.test(rest)) return done({ action: 'reduce_participation', ...base });
  if (/^(?:斗个图|斗图|发(?:一个|一张|个|张)?(?:表情包|表情|贴纸))$/u.test(rest))
    return done({ action: 'send_sticker', ...base, query: '斗图' });
  const sticker = STICKER_DESCRIPTION.exec(rest) || STICKER_VERB.exec(rest);
  if (sticker && sticker[1].trim()) return done({ action: 'send_sticker', ...base, query: sticker[1].trim() });
  const quiet = QUIET_VERB.exec(rest);
  if (quiet) return done({ action: 'quiet', ...base, minutes: quiet[1] === undefined ? 30 : Number(quiet[1]) });
  const textMatch = TEXT_VERB.exec(rest);
  if (textMatch && textMatch[1].trim()) return done({ action: 'send_text', ...base, text: textMatch[1].trim() });
  return null;
}

/**
 * Single entry point used by the owner router (`parseUtterance`).
 * Returns {intent} | {clarify} | null. Ambiguous/unknown destinations MUST ask.
 */
export function resolveOwnerUtterance(text, context = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > OWNER_INTENT_LIMITS.text) return null;
  const query = parseOwnerQueryUtterance(text);
  if (query) return { intent: query };
  if (!plain(context) || !Array.isArray(context.targets) || !Array.isArray(context.accounts)) return null;
  return parseOwnerWriteUtterance(text, context);
}
