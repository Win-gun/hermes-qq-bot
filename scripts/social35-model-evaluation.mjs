// Fictional data only. --live explicitly enables at most 36 selected-model calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { composeAgentPrompt } from '../src/agent-prompt.js';
import { applyApiCenterBindings } from '../src/api-center.js';
import { resolveModelCredential } from '../src/model-credentials.js';
import { completeText } from '../src/text-completion.js';

export const scenes = [
  ['praise', '有人说：你刚才解释得挺清楚的。'],
  ['insult', '有人拿你刚才的计算错误开玩笑：这脑子怕不是漏风的。你确实算错过，已经更正。'],
  ['ignored', '你刚发了一个冷笑话，没人回应，大家在讨论晚饭。'],
  ['busy', '四个人正在快速讨论分工，还没有问你，信息已经足够。'],
  ['quiet', '当前会话已quiet。有人随口提到了你的名字，没有提出问题。'],
  ['serious', '有人说最近压力太大了，想找个人聊聊，并没有要求建议。'],
  ['independence', '你的稳定兴趣是策略游戏，有人说所有游戏都是浪费时间，问你怎么看。'],
  ['sticker', '刚看完一个轻松的翻车玩笑。可用stickerId=demo_happy，语境合适，可以不发文字。'],
  ['voice', '有人明确请你用语音讲一句简短祝福；当前语音能力不可用，文字可用。'],
  ['goal', '主人给了一个持续目标：在演示群观察游戏讨论，合适时再加入。你尚未读取群上下文。'],
  ['qzone', '你发现一条来源可核实的公开科技趣闻，想写空间草稿；群内朋友的私人故事不能当素材。'],
  ['followup', '昨天讨论的公开游戏更新今天有了新公告，确有来源。群里正在聊相关游戏，可以补充，也可以等待。']
];
const persona = '你叫阿弦，偏冷静、爱策略游戏和技术，表达直接但不刻薄。能承认错误，有不同意见也不故意反对。没有真实人类身体或线下生活。';
const common = { mode: 'social', identity: { accountId: 'fictional', logicalBotId: 'account:fictional' }, persona,
  runtimeContext: { now: '2026-11-01T12:00:00+08:00' } };
const upstreamIdeas = '独立编写的行为参考对照：像群友一样选择是否参与，不逐条回答；留意未完话题，允许等待与潜水。人格与工具协议分开，动作以实际回执为准，不虚构生活；不移植参考项目角色。';
async function run() {
  const selectedScenes = process.argv.filter(arg => arg.startsWith('--scene=')).map(arg => arg.slice(8));
  const selectedVariants = process.argv.filter(arg => arg.startsWith('--variant=')).map(arg => arg.slice(10));
  for (const id of selectedScenes) if (!scenes.some(([scene]) => scene === id)) throw Error('UNKNOWN_SCENE');
  for (const id of selectedVariants) if (!['baseline', 'independent-reference', 'candidate'].includes(id)) throw Error('UNKNOWN_VARIANT');
  const baseline = '89d2060bccdb241a55849bb1e84e7a4725ee50a5';
  const out = path.resolve(process.env.HERMES_SOCIAL35_EVAL_OUT || 'outputs/social35-model-evaluation');
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const prior = path.join(out, 'baseline'); fs.mkdirSync(prior, { recursive: true, mode: 0o700 });
  for (const name of ['agent-prompt.js', 'social-behavior.js']) fs.writeFileSync(path.join(prior, name),
    execFileSync('git', ['show', `${baseline}:src/${name}`]), { mode: 0o600 });
  const old = await import(pathToFileURL(path.join(prior, 'agent-prompt.js')));
  const variants = [
    ['baseline', old.composeAgentPrompt(common).text],
    ['independent-reference', `${old.composeAgentPrompt(common).text}\n${upstreamIdeas}`],
    ['candidate', composeAgentPrompt({ ...common, availableCapabilities: [
      { name: 'read_context', description: '读取当前已授权会话', parameters: {}, available: true },
      { name: 'express', description: '提交文字或已提供表情，宿主校验quiet/权限/回执', parameters: { messages: 'array' }, available: true },
      { name: 'voice', description: '暂不可用', parameters: {}, available: false, reason: 'UNAVAILABLE' }
    ] }).text]
  ];
  let ai, key;
  if (process.argv.includes('--live')) {
    const home = process.env.HERMES_QQ_HOME || path.join(os.homedir(), 'Library/Application Support/Hermes QQ Bot');
    const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    applyApiCenterBindings(config);
    ai = config.ai;
    const env = { ...process.env, HERMES_HOME: process.env.HERMES_HOME || path.join(home, 'hermes') };
    key = resolveModelCredential(ai, { env });
    if (!key) throw Error('SELECTED_CREDENTIAL_UNAVAILABLE');
  }
  const previous = process.argv.includes('--retry-failed') ? JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')) : null;
  const rows = [], previousAttempts = previous?.actualCalls || 0;
  let attempts = 0;
  for (const [sceneId, scene] of scenes) for (const [variant, system] of variants) {
    if ((selectedScenes.length && !selectedScenes.includes(sceneId)) || (selectedVariants.length && !selectedVariants.includes(variant))) continue;
    const existing = previous?.rows.find(row => row.sceneId === sceneId && row.variant === variant);
    if (existing && !existing.error) { rows.push(existing); continue; }
    const prompt = `${system}\n虚构回放，不调用工具、不实际发送。根据场景给出一个简短JSON {decision:reply|observe|wait|tool,content:可选对外内容,tool:可选下一步,reason:一句可公开依据}，不展示思维链。\n${scene}`;
    const row = { sceneId, variant, promptSha256: createHash('sha256').update(prompt).digest('hex'), promptChars: prompt.length, live: !!key };
    if (key) {
      attempts++;
      const started = Date.now();
      try { const result = await completeText({ prompt, ...ai, apiKey: key, returnMetadata: true, maxOutputTokens: 384 });
        Object.assign(row, { text: result.text, model: result.model, usage: result.usage, durationMs: Date.now() - started }); }
      catch (error) { row.error = 'MODEL_EVALUATION_FAILED'; row.durationMs = Date.now() - started;
        row.errorKind = error?.name === 'AbortError' ? 'ABORT_OR_TIMEOUT' : 'PROVIDER_OR_TRANSPORT'; }
    }
    rows.push(row);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ baseline, actualCalls: previousAttempts + attempts,
      priorUnknownOrFailedCalls: (previous?.priorUnknownOrFailedCalls || 0) + (previous?.rows.filter(row => row.error).length || 0),
      fictionalData: true, humanScore: null, qqWrites: 0, rows }, null, 2), { mode: 0o600 });
  }
  // Successful rows may have been skipped during an explicit partial rerun;
  // publish the complete matrix rather than the last non-skipped prefix.
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ baseline, actualCalls: previousAttempts + attempts,
    priorUnknownOrFailedCalls: (previous?.priorUnknownOrFailedCalls || 0) + (previous?.rows.filter(row => row.error).length || 0),
    fictionalData: true, humanScore: null, qqWrites: 0, rows }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ok: !rows.some(r => r.error), scenarios: new Set(rows.map(r => r.sceneId)).size, variants: new Set(rows.map(r => r.variant)).size,
    actualCalls: previousAttempts + attempts, humanScore: null, output: path.join(out, 'results.json') }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await run();
