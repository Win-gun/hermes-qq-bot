import { memoryRevision } from "./memory-repository.js";

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const clone = (value) => structuredClone(value);
const validId = (value) => typeof value === "string" && value.length > 0
  && !["__proto__", "prototype", "constructor"].includes(value);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function userAt(memory, conversationId, subjectUserId) {
  if (!validId(conversationId) || !validId(subjectUserId)
    || !own(memory?.groups, conversationId)
    || !own(memory.groups[conversationId]?.users, subjectUserId)) {
    fail("MEMORY_REBUILD_TARGET", "记忆重整目标不存在或标识无效");
  }
  return memory.groups[conversationId].users[subjectUserId];
}

// Rebuilding a presentation of legacy fields must never erase evidence,
// corrections or conflict history collected by the online canonical system.
function preserveEvidence(previous = {}, candidate = {}, subjectUserId) {
  previous ??= {};
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    fail("MEMORY_REBUILD_INVALID", "记忆重整候选结构无效");
  }
  for (const canonical of [previous, candidate]) {
    if (canonical.subjectUserId && String(canonical.subjectUserId) !== subjectUserId) {
      fail("MEMORY_REBUILD_TARGET", "记忆重整候选身份不匹配");
    }
  }
  const result = { ...clone(previous), ...clone(candidate), subjectUserId };
  for (const canonical of [previous, candidate]) {
    if ((canonical.entries !== undefined && !Array.isArray(canonical.entries))
      || (canonical.conflicts !== undefined && !Array.isArray(canonical.conflicts))) {
      fail("MEMORY_REBUILD_INVALID", "记忆重整证据列表结构无效");
    }
  }
  const entries = new Map();
  for (const entry of previous.entries || []) {
    if (!entry || typeof entry.id !== "string") fail("MEMORY_REBUILD_INVALID", "已有记忆证据结构无效");
    entries.set(entry.id, clone(entry));
  }
  for (const entry of candidate.entries || []) {
    if (!entry || typeof entry.id !== "string" || String(entry.subjectUserId) !== subjectUserId) {
      fail("MEMORY_REBUILD_INVALID", "候选记忆证据结构无效");
    }
    // The old entry wins, including rejected/superseded status and timestamps.
    if (!entries.has(entry.id)) entries.set(entry.id, {
      ...clone(entry), status: "tentative", source: "rebuild-proposal",
      sourceMessageIds: [], evidenceKeys: [], evidenceConfirmations: 0,
      explicitEvidenceKeys: [], explicitAt: "", selfExplicitAt: ""
    });
  }
  result.entries = [...entries.values()];
  result.conflicts = [...new Map([...(previous.conflicts || []), ...(candidate.conflicts || [])]
    .map((conflict) => [memoryRevision(conflict), clone(conflict)])).values()];
  return result;
}

export function buildMemoryRebuildProposal(baseMemory, results, { createdAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(results) || results.some((item) => item?.ok !== true)) {
    fail("MEMORY_REBUILD_INCOMPLETE", "部分记忆重整失败；候选报告已保留，不会写入记忆");
  }
  const seen = new Set();
  const targets = results.map((item) => {
    const conversationId = String(item.groupId || "");
    const subjectUserId = String(item.userId || "");
    const user = userAt(baseMemory, conversationId, subjectUserId);
    const key = JSON.stringify([conversationId, subjectUserId]);
    if (seen.has(key)) fail("MEMORY_REBUILD_TARGET", "记忆重整候选含重复目标");
    seen.add(key);
    return {
      conversationId, subjectUserId,
      baseUserRevision: memoryRevision(user),
      canonicalMemory: preserveEvidence(user.canonicalMemory, item.canonical, subjectUserId),
      updatedAt: createdAt
    };
  });
  return { formatVersion: 1, baseRevision: memoryRevision(baseMemory), createdAt, targets };
}

export function applyMemoryRebuildProposal(memory, proposal) {
  if (proposal?.formatVersion !== 1 || !Array.isArray(proposal.targets)) {
    fail("MEMORY_REBUILD_INVALID", "记忆重整候选版本或结构无效");
  }
  const seen = new Set();
  // Validate every target before changing anything. Unrelated users/groups may
  // advance while the worker runs; changed target users require a new proposal.
  for (const target of proposal.targets) {
    const user = userAt(memory, target.conversationId, target.subjectUserId);
    const key = JSON.stringify([target.conversationId, target.subjectUserId]);
    if (seen.has(key)) fail("MEMORY_REBUILD_TARGET", "记忆重整候选含重复目标");
    seen.add(key);
    if (target.baseUserRevision !== memoryRevision(user)) {
      fail("MEMORY_CONFLICT", "目标记忆已更新；候选结果已保留，请重新预览后提交");
    }
    preserveEvidence(user.canonicalMemory, target.canonicalMemory, target.subjectUserId);
  }
  const nextMemory = clone(memory);
  for (const target of proposal.targets) {
    const user = userAt(nextMemory, target.conversationId, target.subjectUserId);
    user.canonicalMemory = preserveEvidence(user.canonicalMemory, target.canonicalMemory, target.subjectUserId);
    user.updatedAt = target.updatedAt;
  }
  return { nextMemory, changedTargets: proposal.targets.length };
}
