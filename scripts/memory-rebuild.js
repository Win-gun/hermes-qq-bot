#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCanonicalMemory } from "../src/memory-integrity.js";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");
const stateRoot = path.resolve(process.env.HERMES_QQ_HOME || rootDir);
const configPath = path.join(stateRoot, "config.json");
const memoryPath = path.join(stateRoot, "data", "memory.json");

const STANDARD_FIELDS = [
  "aliases",
  "personality",
  "coreMemes",
  "preferences",
  "boundaries",
  "style",
  "relationships",
  "interactionTips",
  "notableQuotes"
];

function parseArgs(argv) {
  const args = {
    apply: false,
    dryRun: true,
    check: false,
    noAi: false,
    group: "",
    user: "",
    limit: 0,
    reportDir: path.join(stateRoot, "data")
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      args.apply = true;
      args.dryRun = false;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      args.apply = false;
      continue;
    }
    if (arg === "--check") {
      args.check = true;
      args.noAi = true;
      continue;
    }
    if (arg === "--no-ai") {
      args.noAi = true;
      continue;
    }
    if (arg === "--group") {
      args.group = String(argv[++i] || "");
      continue;
    }
    if (arg === "--user") {
      args.user = String(argv[++i] || "");
      continue;
    }
    if (arg === "--limit") {
      args.limit = Math.max(0, Number(argv[++i] || 0));
      continue;
    }
    if (arg === "--report-dir") {
      args.reportDir = path.resolve(stateRoot, String(argv[++i] || "data"));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  npm run memory:rebuild -- [--dry-run] [--apply] [--group <id>] [--user <id>] [--limit <n>]

Options:
  --dry-run       Run AI analysis and write only a report. This is the default.
  --apply         Back up data/memory.json, then write canonicalMemory back.
  --check         Validate config/memory and print the work plan; does not call AI.
  --no-ai         Use deterministic local cleanup only, useful for smoke tests.
  --group <id>    Rebuild only one group/session.
  --user <id>     Rebuild only one user inside the selected scope.
  --limit <n>     Process at most n users.
  --report-dir    Directory for memory rebuild reports. Default: data/
`);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((x) => x !== undefined && x !== null);
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function clampText(value, max = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function redactSensitive(value) {
  return String(value || "")
    .replace(/\b1[3-9]\d{9}\b/g, "[手机号已过滤]")
    .replace(/\b\d{17}[\dXx]\b/g, "[身份证已过滤]")
    .replace(/\b\d{12,19}\b/g, "[长数字已过滤]")
    .replace(/(?:密码|口令|验证码|code|password|token|api\s*key|apikey)\s*[:：=]?\s*[A-Za-z0-9_\-]{4,}/gi, "$1：[敏感信息已过滤]")
    .replace(/(?:住址|地址)\s*[:：]\s*[^，。；\n]{6,}/g, "$1：[详细地址已过滤]");
}

function cleanList(value, max = 16) {
  const seen = new Set();
  const output = [];
  let removed = 0;
  for (const raw of asArray(value)) {
    const text = clampText(redactSensitive(raw), 180);
    if (!text) continue;
    const key = text
      .toLowerCase()
      .replace(/[，。！？!?、；;：:\s"'“”‘’（）()[\]【】]/g, "");
    if (!key) continue;
    if (seen.has(key)) {
      removed += 1;
      continue;
    }
    const contained = output.find((item) => {
      const itemKey = item
        .toLowerCase()
        .replace(/[，。！？!?、；;：:\s"'“”‘’（）()[\]【】]/g, "");
      return itemKey.length >= 8 && key.length >= 8 && (itemKey.includes(key) || key.includes(itemKey));
    });
    if (contained) {
      removed += 1;
      if (key.length > contained.length) {
        const index = output.indexOf(contained);
        output[index] = text;
      }
      continue;
    }
    seen.add(key);
    output.push(text);
    if (output.length >= max) break;
  }
  return { output, removed };
}

function mergeCleanLists(...lists) {
  return cleanList(lists.flatMap((x) => asArray(x)));
}

function normalizeAiArgs(rawArgs) {
  const source = Array.isArray(rawArgs) ? rawArgs : ["-z"];
  const tokens = [];
  for (const raw of source) {
    const value = String(raw || "").trim();
    if (!value) continue;
    tokens.push(...value.split(/\r?\n|\\n/).flatMap((part) => part.trim().split(/\s+/)).filter(Boolean));
  }
  let provider = "";
  let model = "";
  const others = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--provider") {
      provider = tokens[i + 1] || provider;
      i += 1;
      continue;
    }
    if (token === "-m" || token === "--model") {
      model = tokens[i + 1] || model;
      i += 1;
      continue;
    }
    if (token === "-z" || token === "--prompt") continue;
    others.push(token);
  }
  const next = [];
  if (model) next.push("-m", model);
  if (provider) next.push("--provider", provider);
  next.push(...others);
  next.push("-z");
  return next;
}

function extractJsonObject(text) {
  const cleaned = String(text || "")
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI output did not contain a JSON object");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function callHermes(prompt, config) {
  const command = config.ai?.command || "hermesqq2";
  const args = [...normalizeAiArgs(config.ai?.args || ["-z"]), prompt];
  const timeoutMs = Number(config.memory?.rebuild?.timeoutMs || config.ai?.timeoutMs || 120000);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: stateRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`AI timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (data) => (stdout += data.toString()));
    child.stderr.on("data", (data) => (stderr += data.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout.trim());
      reject(new Error(`AI command exited ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

function collectInputItems(user) {
  const fields = [
    "names",
    "aliases",
    "profile",
    "personality",
    "preferences",
    "boundaries",
    "memes",
    "coreMemes",
    "style",
    "relationships",
    "interactionTips",
    "notableQuotes"
  ];
  return fields.flatMap((field) => asArray(user?.[field]).map((value) => ({ field, value: redactSensitive(value) })));
}

function buildHeuristicCanonical(user) {
  const aliases = mergeCleanLists(user.aliases, user.names);
  const personality = mergeCleanLists(user.personality, user.style, asArray(user.profile).filter((x) => /性格|像是|风格|说话|喜欢吐槽|活跃|认真|抽象/.test(String(x))));
  const coreMemes = mergeCleanLists(user.coreMemes, user.memes);
  const preferences = mergeCleanLists(asArray(user.preferences).filter((x) => !/^(不喜欢\/雷点|雷点|不喜欢)[:：]/.test(String(x))));
  const boundaries = mergeCleanLists(
    user.boundaries,
    asArray(user.preferences)
      .filter((x) => /^(不喜欢\/雷点|雷点|不喜欢)[:：]/.test(String(x)))
      .map((x) => String(x).replace(/^(不喜欢\/雷点|雷点|不喜欢)[:：]\s*/, ""))
  );
  const style = mergeCleanLists(user.style);
  const relationships = mergeCleanLists(user.relationships);
  const interactionTips = mergeCleanLists(user.interactionTips, asArray(user.profile).filter((x) => /^相处建议[:：]/.test(String(x))).map((x) => String(x).replace(/^相处建议[:：]\s*/, "")));
  const notableQuotes = mergeCleanLists(user.notableQuotes);
  const postRemoved = [
    aliases,
    personality,
    coreMemes,
    preferences,
    boundaries,
    style,
    relationships,
    interactionTips,
    notableQuotes
  ].reduce((sum, item) => sum + item.removed, 0);
  return {
    aliases: aliases.output,
    personality: personality.output,
    coreMemes: coreMemes.output,
    preferences: preferences.output,
    boundaries: boundaries.output,
    style: style.output,
    relationships: relationships.output,
    interactionTips: interactionTips.output,
    notableQuotes: notableQuotes.output,
    confidence: 0.45,
    dedupe: {
      merged_or_removed: postRemoved,
      notes: ["local heuristic cleanup only"]
    }
  };
}

function buildPrompt({ groupId, userId, user, group }) {
  const payload = {
    group_id: groupId,
    user_id: userId,
    names: asArray(user.names).map(redactSensitive),
    lastName: redactSensitive(user.lastName || ""),
    messageCount: user.messageCount || 0,
    firstSeenAt: user.firstSeenAt || "",
    lastSeenAt: user.lastSeenAt || "",
    old_fields: {
      aliases: asArray(user.aliases).map(redactSensitive),
      profile: asArray(user.profile).map(redactSensitive),
      personality: asArray(user.personality).map(redactSensitive),
      preferences: asArray(user.preferences).map(redactSensitive),
      boundaries: asArray(user.boundaries).map(redactSensitive),
      memes: asArray(user.memes).map(redactSensitive),
      coreMemes: asArray(user.coreMemes).map(redactSensitive),
      style: asArray(user.style).map(redactSensitive),
      relationships: asArray(user.relationships).map(redactSensitive),
      interactionTips: asArray(user.interactionTips).map(redactSensitive),
      notableQuotes: asArray(user.notableQuotes).map(redactSensitive)
    },
    group_context: {
      topics: asArray(group.topics).slice(-10).map(redactSensitive),
      facts: asArray(group.facts).slice(-15).map(redactSensitive),
      rollingSummary: redactSensitive(group.rollingSummary || "")
    }
  };

  return `你是 QQ 群聊机器人 Hermes 的“记忆重整器”。

任务：把下面这个群成员的旧记忆字段重新整理成清晰、少重复、可长期用于聊天的标准结构。

要求：
- 只根据输入内容整理，不要脑补。
- 合并语义重复项，不只是完全相同才合并。
- 明显玩笑、反话、一次口嗨要降低置信度或不写入稳定画像。
- 密码、验证码、手机号、身份证、银行卡、详细住址等敏感信息不能输出。
- 每项尽量短，像给聊天机器人看的备忘卡。
- 如果某类没有可靠内容，输出空数组。
- 只能输出 JSON，不要解释，不要 Markdown。

标准 JSON 结构：
{
  "aliases": ["外号/称呼"],
  "personality": ["性格画像"],
  "coreMemes": ["强相关梗/外号梗/群内固定梗"],
  "preferences": ["偏好"],
  "boundaries": ["雷点/不喜欢/需要避开的点"],
  "style": ["说话风格"],
  "relationships": ["关系网/与群内其他人的互动关系"],
  "interactionTips": ["bot 和此人相处建议"],
  "notableQuotes": ["代表性原话，尽量短"],
  "confidence": 0.0,
  "dedupe": {
    "merged_or_removed": 0,
    "notes": ["合并说明"]
  }
}

输入：
${JSON.stringify(payload, null, 2)}
`;
}

function normalizeCanonical(raw, user) {
  const fallback = buildHeuristicCanonical(user);
  const merged = {};
  let postRemoved = 0;
  for (const field of STANDARD_FIELDS) {
    const cleaned = cleanList(raw?.[field] ?? fallback[field], field === "notableQuotes" ? 10 : 16);
    merged[field] = cleaned.output;
    postRemoved += cleaned.removed;
  }
  const confidence = Number.isFinite(Number(raw?.confidence)) ? Math.max(0, Math.min(1, Number(raw.confidence))) : fallback.confidence;
  const aiRemoved = Number(raw?.dedupe?.merged_or_removed || raw?.dedupe?.mergedOrRemoved || fallback.dedupe?.merged_or_removed || 0);
  const canonical = {
    ...merged,
    rebuiltAt: new Date().toISOString(),
    source: raw?.source || "ai-memory-rebuild",
    confidence,
    report: {
      inputItems: collectInputItems(user).length,
      outputItems: STANDARD_FIELDS.reduce((sum, field) => sum + merged[field].length, 0),
      mergedOrRemoved: aiRemoved + postRemoved,
      notes: cleanList(raw?.dedupe?.notes || fallback.dedupe?.notes || [], 8).output
    }
  };
  return canonical;
}

function outputItemCount(canonical) {
  return STANDARD_FIELDS.reduce((sum, field) => sum + asArray(canonical?.[field]).length, 0);
}

function buildWorkItems(memory, args) {
  const items = [];
  for (const [groupId, group] of Object.entries(memory.groups || {})) {
    if (args.group && groupId !== args.group) continue;
    for (const [userId, user] of Object.entries(group.users || {})) {
      if (args.user && userId !== args.user) continue;
      items.push({ groupId, userId, user, group });
      if (args.limit && items.length >= args.limit) return items;
    }
  }
  return items;
}

async function rebuildOne(item, config, args) {
  const beforeItems = collectInputItems(item.user).length;
  const beforeCanonicalItems = outputItemCount(item.user.canonicalMemory);
  let raw;
  let ok = true;
  let error = "";
  try {
    if (args.noAi) {
      raw = buildHeuristicCanonical(item.user);
    } else {
      const result = await callHermes(buildPrompt(item), config);
      raw = extractJsonObject(result);
    }
  } catch (err) {
    ok = false;
    error = String(err?.message || err);
    raw = buildHeuristicCanonical(item.user);
  }
  const canonical = normalizeCanonical(raw, item.user);
  const holder = { ...item.user, canonicalMemory: canonical };
  ensureCanonicalMemory(holder, item.userId, {
    at: canonical.rebuiltAt,
    sourceConversationId: item.groupId
  });
  return {
    ok,
    error,
    groupId: item.groupId,
    userId: item.userId,
    name: item.user.lastName || asArray(item.user.names).at(-1) || item.userId,
    beforeItems,
    beforeCanonicalItems,
    afterItems: outputItemCount(canonical),
    mergedOrRemoved: canonical.report.mergedOrRemoved,
    canonical: holder.canonicalMemory
  };
}

function summarizeReport(results, args) {
  const groups = {};
  for (const result of results) {
    const group = (groups[result.groupId] ||= {
      groupId: result.groupId,
      users: 0,
      ok: 0,
      failed: 0,
      inputItems: 0,
      outputItems: 0,
      mergedOrRemoved: 0
    });
    group.users += 1;
    group.ok += result.ok ? 1 : 0;
    group.failed += result.ok ? 0 : 1;
    group.inputItems += result.beforeItems;
    group.outputItems += result.afterItems;
    group.mergedOrRemoved += result.mergedOrRemoved;
  }
  return {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : args.check ? "check" : "dry-run",
    usedAi: !args.noAi,
    scope: {
      group: args.group || "*",
      user: args.user || "*",
      limit: args.limit || 0
    },
    totals: {
      groups: Object.keys(groups).length,
      users: results.length,
      ok: results.filter((x) => x.ok).length,
      failed: results.filter((x) => !x.ok).length,
      inputItems: results.reduce((sum, x) => sum + x.beforeItems, 0),
      outputItems: results.reduce((sum, x) => sum + x.afterItems, 0),
      mergedOrRemoved: results.reduce((sum, x) => sum + x.mergedOrRemoved, 0)
    },
    groups: Object.values(groups),
    users: results.map((result) => ({
      groupId: result.groupId,
      userId: result.userId,
      name: result.name,
      ok: result.ok,
      error: result.error,
      inputItems: result.beforeItems,
      previousCanonicalItems: result.beforeCanonicalItems,
      outputItems: result.afterItems,
      mergedOrRemoved: result.mergedOrRemoved,
      canonical: result.canonical
    }))
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(configPath)) throw new Error(`Missing config: ${configPath}`);
  if (!existsSync(memoryPath)) throw new Error(`Missing memory: ${memoryPath}`);
  const config = await readJson(configPath);
  const memory = await readJson(memoryPath);
  const workItems = buildWorkItems(memory, args);

  console.log(`[memory-rebuild] mode=${args.apply ? "apply" : args.check ? "check" : "dry-run"} users=${workItems.length} ai=${!args.noAi}`);

  if (args.check) {
    const report = summarizeReport(workItems.map((item) => ({
      ok: true,
      error: "",
      groupId: item.groupId,
      userId: item.userId,
      name: item.user.lastName || asArray(item.user.names).at(-1) || item.userId,
      beforeItems: collectInputItems(item.user).length,
      beforeCanonicalItems: outputItemCount(item.user.canonicalMemory),
      afterItems: outputItemCount(item.user.canonicalMemory),
      mergedOrRemoved: 0,
      canonical: item.user.canonicalMemory || null
    })), args);
    console.log(JSON.stringify(report.totals, null, 2));
    return;
  }

  const results = [];
  for (let i = 0; i < workItems.length; i += 1) {
    const item = workItems[i];
    process.stdout.write(`[memory-rebuild] ${i + 1}/${workItems.length} group=${item.groupId} user=${item.userId} ... `);
    const result = await rebuildOne(item, config, args);
    results.push(result);
    console.log(result.ok ? `ok merged=${result.mergedOrRemoved}` : `fallback error=${result.error.slice(0, 160)}`);
    if (args.apply) {
      item.user.canonicalMemory = result.canonical;
      ensureCanonicalMemory(item.user, result.userId, {
        at: result.canonical.rebuiltAt,
        sourceConversationId: result.groupId
      });
      item.user.updatedAt = new Date().toISOString();
    }
  }

  const report = summarizeReport(results, args);
  await fs.mkdir(args.reportDir, { recursive: true });
  const reportPath = path.join(args.reportDir, `memory-rebuild-report.${timestamp()}.json`);
  await writeJson(reportPath, report);

  let backupPath = "";
  if (args.apply) {
    backupPath = path.join(path.dirname(memoryPath), `memory.json.bak.${timestamp()}`);
    await fs.copyFile(memoryPath, backupPath);
    await writeJson(memoryPath, memory);
  }

  console.log(JSON.stringify({
    ok: true,
    mode: report.mode,
    reportPath,
    backupPath,
    totals: report.totals
  }, null, 2));
}

main().catch((err) => {
  console.error(`[memory-rebuild] failed: ${err?.stack || err}`);
  process.exit(1);
});
