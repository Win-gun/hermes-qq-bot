import { createHash } from "node:crypto";

const fail = code => Object.assign(new Error(code), { code });

// Host-owned delivery claims. A timeout is not proof that QQ rejected a send.
// Claims are persisted at the physical send gate, never replayed on restart.
export function createTaskDelivery({ getTask, persist, isCurrent }) {
  return function prepare(task, { key, guard = () => true } = {}) {
    if (!task || typeof key !== "string" || key.length > 10000) throw fail("TASK_DELIVERY_INVALID");
    const pin = { id: task.id, accountId: task.accountId, logicalBotId: task.logicalBotId,
      attemptId: task.attemptId || "", grantRevision: task.grantRevision || 0, status: task.status };
    const id = createHash("sha256").update(JSON.stringify([pin, key])).digest("hex");
    let claimed = false;
    const current = () => {
      const latest = getTask(pin.id);
      return Boolean(latest && Object.entries(pin).every(([k, v]) => (latest[k] ?? (k === "attemptId" ? "" : k === "grantRevision" ? 0 : undefined)) === v)
        && latest.status !== "cancelled" && latest.authorityBlocked !== true && isCurrent(latest) && guard()
        && (!latest.deliveryLedger?.some(row => row.id === id) || claimed));
    };
    return {
      isCurrent: current,
      onSendStarted() {
        if (claimed || !current()) throw fail("TASK_DELIVERY_STALE");
        const latest = getTask(pin.id), ledger = latest.deliveryLedger || [];
        if (ledger.length >= 1024) throw fail("TASK_DELIVERY_LEDGER_FULL");
        latest.deliveryLedger = [...ledger, { id, attemptId: pin.attemptId, status: "claimed", at: new Date().toISOString() }];
        persist(latest); // throw before wire on an uncertain durable claim
        claimed = true;
      },
      settle(confirmed) {
        if (!claimed) return false;
        const latest = getTask(pin.id), row = latest?.deliveryLedger?.find(item => item.id === id);
        if (!row || row.status !== "claimed") return false;
        row.status = confirmed === true ? "confirmed" : "uncertain";
        row.settledAt = new Date().toISOString();
        persist(latest);
        return true;
      }
    };
  };
}
