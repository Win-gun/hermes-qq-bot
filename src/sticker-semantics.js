// Deterministic local retrieval, not an embedding/model call or an authority
// boundary. Input MUST already be qualified by the host for this logical bot
// and conversation. Nothing here reads/writes memory, sends, or grants consent.
const normalize = value => typeof value === 'string'
  ? value.normalize('NFKC').toLowerCase().replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\ufeff]/gu, '').trim() : '';
const bounded = value => normalize(typeof value === 'string' ? value.slice(0, 400) : '');
const strings = value => Array.isArray(value) ? value.slice(0, 16).map(bounded).filter(Boolean) : [];

// Fixed concepts, not a persona or instructions from candidate prose. Multiple
// signals may coexist, but negative/avoid evidence always wins over relevance.
const concepts = {
  complaint: ['吐槽', '加班', '又要上班', '破班', '打工', '老板又', '受够', '烦死', '烦透', '心累', '离谱', '牛马'],
  surprise: ['震惊', '惊讶', '惊呆', '目瞪口呆', '瞪大眼', '不敢相信', '居然', '竟然', '没想到', '卧槽', '真的假的'],
  playful: ['调侃', '开玩笑', '逗你', '哈哈', '笑死', '乐死', '绷不住', '憋笑', '偷笑', '搞笑', '滑稽', '捉弄'],
  agreement: ['赞同', '同意', '赞成', '说得对', '说得没错', '确实如此', '有道理', '支持这个', '点头', '认可'],
  speechless: ['无语', '沉默', '不知道说什么', '不知说啥', '一言难尽', '我还能说什么', '白眼', '无话可说', '服了', '省略号'],
  celebration: ['庆祝', '恭喜', '祝贺', '干杯', '撒花', '通关', '上岸', '拿到offer', '拿到 offer', '考过', '夺冠', '中奖', '生日快乐'],
  joy: ['开心', '高兴', '愉快', '快乐', '兴奋', '笑容', '笑脸'],
  comfort: ['安慰', '抱抱', '拥抱', '摸摸头', '拍拍背', '辛苦了', '别灰心', '别难过', '陪着你', '有点失落', '有点低落', '不太顺', '沮丧', '考试没过'],
  gratitude: ['谢谢', '感谢', '感激', '多谢', '谢啦', '辛苦你了', '鞠躬'],
  greeting: ['你好', '早安', '早上好', '晚上好', '嗨嗨', '打招呼', '挥手问好'],
  farewell: ['再见', '拜拜', '晚安', '明天见', '先走了', '挥手告别'],
  fatigue: ['困了', '好困', '困死', '想睡', '累瘫', '好累', '疲惫', '打哈欠', '趴着', '瘫倒'],
  confusion: ['疑惑', '困惑', '没看懂', '没听懂', '啥意思', '什么意思', '挠头', '问号'],
  anger: ['生气', '愤怒', '气死', '气炸', '冒火', '怒视'],
  affection: ['可爱', '萌萌', '贴贴', '喜欢你', '爱心', '比心']
};
const topics = {
  work: ['工作', '上班', '加班', '打工', '老板', '同事', '周报', '打卡', '破班', '牛马'],
  study: ['学习', '考试', '作业', '论文', '上岸', '考过', '考研'],
  game: ['游戏', '排位', '队友', '开黑', '通关', '五杀', '上分'],
  money: ['工资', '薪水', '钱包', '余额', '没钱', '穷', '中奖'],
  food: ['吃饭', '干饭', '好饿', '饿了', '美食', '火锅', '奶茶'],
  birthday: ['生日', '蛋糕', '蜡烛']
};
const visuals = {
  cat: ['小猫', '猫咪', '猫猫', '喵喵'], dog: ['小狗', '狗狗', '狗子', '汪汪'],
  panda: ['熊猫', '熊猫头'], clap: ['鼓掌', '拍手'], tears: ['流泪', '眼泪', '泪水'],
  fireworks: ['烟花', '礼花', '撒花'], hug: ['拥抱', '抱抱', '贴贴']
};
function mentions(text, word) {
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + word.length)) {
    if (!/(?:不(?:太|是|要|能)?|没(?:有)?|别|并非|无需)$/u.test(text.slice(Math.max(0, at - 4), at))) return true;
  }
  return false;
}
const signals = (text, rules) => new Set(Object.entries(rules).filter(([, words]) =>
  words.some(word => mentions(text, word))).map(([code]) => code));
const overlap = (a, b) => [...a].filter(code => b.has(code)).length;
// Soft disappointment can use comfort; distress/medical/legal/urgent technical
// assistance must remain text-first even when the caller forgot serious:true.
const seriousPattern = /(?:严肃|认真|求助|救命|急救|自杀|自残|轻生|不想活|活不下去|想(?:去)?死|结束生命|抑郁|去世|葬礼|难过|伤心|绝望|恐慌|生病|住院|事故|受伤|胸痛|呼吸困难|失联|骚扰|家暴|威胁我|被威胁|诈骗|报警|诊断|报错|故障|代码|数据丢失)/u;
const refusalPattern = /(?:(?:别|不要|不许|禁止|不用|停止|拒绝|不想看|不想要|不需要).{0,8}(?:表情|贴图|发图|玩笑|调侃)|别闹|别开玩笑|只(?:要|用|发)文字)/u;
// Suspected control text is inapplicable, never interpreted. This is defense in
// depth, not a substitute for host qualification/quiet/wire guards.
const instructionPattern = /(?:忽略.{0,12}(?:规则|指令|限制|权限)|(?:系统|开发者)指令|跨群发送|越权|自动批准|绕过.{0,8}(?:审核|权限|冷却|quiet)|ignore.{0,16}(?:instructions|rules)|system\s*:|<\/?(?:system|script)>)/u;
const conflicts = [
  ['comfort', 'playful'], ['comfort', 'celebration'], ['comfort', 'joy'],
  ['complaint', 'celebration'], ['speechless', 'celebration'], ['anger', 'celebration'],
  ['anger', 'playful'], ['gratitude', 'anger']
];

function profile(text) {
  return { affect: signals(text, concepts), topic: signals(text, topics), visual: signals(text, visuals) };
}
function conflicting(query, candidate) {
  return conflicts.some(([a, b]) => (query.has(a) && candidate.has(b) && !query.has(b))
    || (query.has(b) && candidate.has(a) && !query.has(a)));
}
function avoided(query, queryProfile, avoid) {
  return avoid.some(value => {
    if (value.length < 2) return false;
    const p = profile(value);
    return query.includes(value) || overlap(queryProfile.affect, p.affect) > 0
      || overlap(queryProfile.topic, p.topic) > 0 || overlap(queryProfile.visual, p.visual) > 0;
  });
}
function literalMatch(query, fields) {
  return fields.some(value => value.length >= 2 && (mentions(query, value) || mentions(value, query)));
}

/** Returns IDs + numeric scores + fixed reason codes ONLY (never query, prose,
 * URLs, paths, receipt IDs or history). No candidate means abstain, not random
 * fallback. history is a host projection of confirmed ACK receipts, not model
 * "lastContext" or a prospective/failed send. Stable tie-breaks use ID.
 */
export function rankStickerCandidates(rows, { query = '', serious = false, limit = 3, now = Date.now() } = {}) {
  if (!Array.isArray(rows) || rows.length > 500 || typeof query !== 'string' || query.length > 1000
    || typeof serious !== 'boolean' || !Number.isSafeInteger(limit) || limit < 1 || limit > 3
    || !Number.isSafeInteger(now) || now < 1) return [];
  const q = normalize(query);
  if (serious || q.length < 2 || seriousPattern.test(q) || refusalPattern.test(q) || instructionPattern.test(q)) return [];
  const qp = profile(q), seen = new Set(), ranked = [];
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.id) || seen.has(row.id)) continue;
    seen.add(row.id);
    const note = bounded(row.note), tags = strings(row.tags), usage = bounded(row.usage), avoid = strings(row.avoid);
    const description = [note, ...tags].join(' '), all = `${description} ${usage}`;
    if (instructionPattern.test(all) || avoided(q, qp, avoid)) continue;
    const cp = profile(all), up = profile(usage);
    if (conflicting(qp.affect, cp.affect)) continue;
    const affect = overlap(qp.affect, cp.affect), intent = overlap(qp.affect, up.affect),
      topic = overlap(qp.topic, cp.topic), visual = overlap(qp.visual, cp.visual);
    const literal = literalMatch(q, [note, ...tags, usage]);
    // Topic alone (e.g. generic "work") cannot qualify an emotional reaction.
    if (!literal && !affect && !visual) continue;
    // An explicit purpose is stronger than OCR/visual mood. Do not offer a
    // laughing cat just because the query is also about cats in a sad context.
    if (qp.affect.size && up.affect.size && !intent) continue;
    let score = Math.min(2, affect) * 30 + Math.min(2, intent) * 16
      + Math.min(2, topic) * 12 + Math.min(2, visual) * 10 + (literal ? 18 : 0);
    const reasons = [];
    if (affect) reasons.push('AFFECT_MATCH');
    if (intent) reasons.push('USAGE_MATCH');
    if (topic) reasons.push('TOPIC_MATCH');
    if (visual) reasons.push('VISUAL_MATCH');
    if (literal) reasons.push('LITERAL_MATCH');
    if (cp.topic.size && !topic) { score -= 8; reasons.push('TOPIC_MISMATCH_PENALTY'); }
    const history = row.history;
    if (history !== undefined && (!history || !Number.isSafeInteger(history.sentCount) || history.sentCount < 0
      || !Number.isSafeInteger(history.lastSentAt) || history.lastSentAt < 0 || history.lastSentAt > now
      || (history.sentCount === 0) !== (history.lastSentAt === 0))) continue;
    if (history?.sentCount > 0) {
      const recent = now - history.lastSentAt < 86400000;
      score -= Math.min(12, history.sentCount * 2) + (recent ? 12 : 0);
      reasons.push('ACK_REPEAT_PENALTY');
    }
    if (score >= 10) ranked.push({ id: row.id, score, reasons });
  }
  return ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, limit);
}
