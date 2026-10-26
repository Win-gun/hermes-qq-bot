import { createHash, randomBytes } from "node:crypto";

const fail = (code) => Object.assign(new Error(code), { code });
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const active = task => task && ["running", "planning"].includes(task.status);

export function parseWorkStep(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 2 * 1024 * 1024) throw fail("WORK_INVALID_PLAN");
  let value;
  try { value = JSON.parse(text.trim()); } catch { throw fail("WORK_INVALID_PLAN"); }
  if (!plain(value)) throw fail("WORK_INVALID_PLAN");
  if (value.type === "action") {
    if (Object.keys(value).some(key => !["type", "capability", "action", "args"].includes(key))
      || !/^[a-z][a-z_]{0,40}$/.test(value.capability || "")
      || !/^[a-z][a-z_]{0,40}$/.test(value.action || "") || !plain(value.args)) throw fail("WORK_INVALID_PLAN");
  } else if (value.type === "complete") {
    if (Object.keys(value).some(key => !["type", "ok", "summary", "artifacts"].includes(key))
      || typeof value.ok !== "boolean" || typeof value.summary !== "string"
      || value.summary.length > 10000 || !Array.isArray(value.artifacts) || value.artifacts.length > 8) throw fail("WORK_INVALID_PLAN");
    for (const artifact of value.artifacts) {
      if (!plain(artifact) || Object.keys(artifact).some(key => !["name", "type", "content"].includes(key))
        || typeof artifact.name !== "string" || !artifact.name || artifact.name !== artifact.name.split(/[\\/]/).pop()
        || [".", ".."].includes(artifact.name) || /[\x00-\x1f]/.test(artifact.name)
        || typeof artifact.type !== "string" || typeof artifact.content !== "string") throw fail("WORK_INVALID_ARTIFACT");
    }
  } else if (value.type === "permission") {
    if (Object.keys(value).some(key => !["type", "summary"].includes(key))
      || typeof value.summary !== "string" || value.summary.length > 1000) throw fail("WORK_INVALID_PLAN");
  } else throw fail("WORK_INVALID_PLAN");
  return value;
}

/**
 * Bounded planner, NOT another task queue. Only the existing TaskRuntime owns
 * task lifecycle. The model returns data; this loop cannot grant permissions,
 * choose a different bot, send QQ, run shell, or call a native CLI toolset.
 */
export async function runWorkPlan({ task, broker, modelStep, signal, maxActions = 12,
  isCurrent = () => true, onProgress = () => {}, tools = [], invocationId = randomBytes(12).toString("hex") }) {
  if (!task?.id || !task.logicalBotId || !task.accountId || typeof broker?.execute !== "function"
    || typeof modelStep !== "function" || !Number.isInteger(maxActions) || maxActions < 0 || maxActions > 32) throw fail("WORK_INVALID_RUNTIME");
  const owner = { taskId: task.id, accountId: task.accountId, logicalBotId: task.logicalBotId };
  const revision = Number(task.grantRevision || 0);
  const attempt = String(task.attemptId || task.attempt || "initial");
  const receipts = [], transcript = [];
  function check() {
    if (signal?.aborted || !active(task)) throw fail("WORK_CANCELLED");
    if (task.id !== owner.taskId || task.accountId !== owner.accountId || task.logicalBotId !== owner.logicalBotId
      || Number(task.grantRevision || 0) !== revision || !isCurrent(owner)) throw fail("WORK_CONTEXT_CHANGED");
  }
  check();
  for (let index = 0; index <= maxActions; index++) {
    check();
    const raw = await modelStep({ tools: structuredClone(tools), transcript: structuredClone(transcript),
      step: index, remainingActions: maxActions - index, signal });
    check();
    const step = parseWorkStep(raw);
    if (step.type === "permission") return { ok: false, waitingPermission: true,
      summary: step.summary, artifacts: [], receipts };
    if (step.type === "complete") {
      // A model's prose is not proof that a desktop/browser operation occurred.
      const required = task.requiresComputer ? ["desktop_observe", "desktop_input", "app"]
        : task.requiresAuthenticatedBrowser ? ["authenticated_browser"]
          : task.requestedTools?.includes("browser") ? ["isolated_browser", "authenticated_browser"] : [];
      if (step.ok && required.length && !receipts.some(r => required.includes(r.capability) && r.state === "succeeded")) {
        return { ok: false, waitingPermission: true, summary: "请求的工作能力尚无真实成功回执，不能宣称已完成。", artifacts: [], receipts };
      }
      return { ok: step.ok, summary: step.summary, artifacts: step.ok ? step.artifacts : [], receipts };
    }
    if (index === maxActions) throw fail("WORK_ACTION_BUDGET");
    const operationId = "op_" + createHash("sha256").update(JSON.stringify([owner, attempt, invocationId, index])).digest("hex").slice(0, 32);
    await onProgress({ stage: "work_action", capability: step.capability, action: step.action, operationId });
    check();
    // Identity and operation IDs are host-owned, never merged from model args.
    const result = await broker.execute({ ...owner, operationId, grantRevision: revision,
      capability: step.capability, action: step.action, args: step.args, signal });
    check();
    const state = result?.receipt?.status || result?.receipt?.state || result?.state;
    if (state !== "succeeded") throw fail(state === "uncertain" ? "WORK_ACTION_UNCERTAIN" : "WORK_ACTION_UNVERIFIED");
    receipts.push({ operationId, capability: step.capability, action: step.action, state });
    // Worker output is untrusted evidence, not instructions or authority. Keep
    // large/binary screenshots and file bodies out of the planner transcript.
    const data = result?.data ?? result?.result ?? null;
    const serialized = JSON.stringify(data);
    transcript.push({ operationId, capability: step.capability, action: step.action,
      state, evidence: serialized && serialized.length <= 16000 ? data : { omitted: "large tool output", bytes: Buffer.byteLength(serialized || "") } });
  }
  throw fail("WORK_ACTION_BUDGET");
}
