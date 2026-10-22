import assert from "node:assert/strict";
import { createMemoryVerificationNotifier, formatVerificationNotice } from "../src/memory-verification-notifier.js";

let checks = 0;
const check = (fn) => { fn(); checks += 1; };
const now = "2026-10-21T08:00:00.000Z";
function fixture() {
  let root = { groups: { "810001": { memoryVerification: { cases: [], notifications: [] } } } };
  const item = { id: "M-fixture", conversationId: "810001", subjectUserId: "10001", status: "pending",
    revision: "revision1", createdAt: now, oldMemory: { value: "喜欢合成蓝纸", sentAt: now }, newMemory: { value: "不喜欢合成蓝纸", sentAt: now } };
  root.groups["810001"].memoryVerification.cases.push(item);
  const settings = { enabled: true, shadowMode: false, deferAfterMs: 604800000, perGroupDailyLimit: 3, cooldownMs: 86400000 };
  let quiet = false, paused = false, wire = 0, fail = false, afterClaim = null, changeOnWire = false;
  const listCases = (state, filter = {}) => {
    const rows = Object.values(state.groups).flatMap(group => group.memoryVerification.cases)
      .filter(row => (!filter.conversationId || row.conversationId === filter.conversationId)
        && (!filter.caseId || row.id === filter.caseId) && (!filter.status || row.status === filter.status));
    const offset = filter.offset || 0, limit = filter.limit || 200;
    return { cases: rows.slice(offset, offset + limit), pagination: { offset, limit,
      nextOffset: offset + limit < rows.length ? offset + limit : null, hasMore: offset + limit < rows.length } };
  };
  const dependencies = { getMemory: () => root, getSettings: () => settings, listCases,
    transact: async build => {
      const draft = structuredClone(root);
      const value = build(draft);
      root = draft;
      if (afterClaim && root.groups["810001"].memoryVerification.notifications.at(-1)?.status === "claimed") {
        const hook = afterClaim; afterClaim = null; hook();
      }
      return value;
    },
    selectRoute: () => paused ? null : { accountId: "account-a", recipientId: "20001", revision: "policy1" },
    canNotify: () => !quiet && !paused,
    send: async (_route, _body, allowed) => {
      if (changeOnWire) quiet = true;
      if (!allowed()) return false;
      wire += 1;
      if (fail) throw new Error("provider details must not escape");
      return true;
    }, clock: () => now };
  return { settings, item, dependencies, root: () => root, wire: () => wire,
    quiet: value => { quiet = value; }, paused: value => { paused = value; }, fail: () => { fail = true; },
    afterClaim: hook => { afterClaim = hook; }, changeOnWire: () => { changeOnWire = true; } };
}
{
  const f = fixture(); f.settings.shadowMode = true;
  const n = createMemoryVerificationNotifier(f.dependencies);
  await n.run(); check(() => assert.equal(f.wire(), 0));
  check(() => assert.equal(f.root().groups["810001"].memoryVerification.notifications.length, 0));
}
{
  const f = fixture(); const n = createMemoryVerificationNotifier(f.dependencies);
  await Promise.all([n.run(), n.run(), n.run()]);
  check(() => assert.equal(f.wire(), 1));
  await createMemoryVerificationNotifier(f.dependencies).run();
  check(() => assert.equal(f.wire(), 1));
  check(() => assert.equal(f.root().groups["810001"].memoryVerification.notifications[0].status, "sent"));
}
for (const gate of ["quiet", "paused"]) {
  const f = fixture(); f[gate](true);
  await createMemoryVerificationNotifier(f.dependencies).run();
  check(() => assert.equal(f.wire(), 0));
}
{
  const f = fixture(); f.fail(); const n = createMemoryVerificationNotifier(f.dependencies);
  await n.run(); await createMemoryVerificationNotifier(f.dependencies).run();
  check(() => assert.equal(f.wire(), 1));
  check(() => assert.equal(f.root().groups["810001"].memoryVerification.notifications[0].status, "uncertain"));
  check(() => assert.ok(!JSON.stringify(n.status()).includes("provider details")));
}
for (const mutate of [f => f.quiet(true), f => { f.settings.shadowMode = true; }, f => { f.item.revision = "revision2"; }]) {
  const f = fixture(); f.afterClaim(() => mutate(f));
  // Revision mutation must affect the current committed object, not an old alias.
  if (mutate.toString().includes("revision2")) f.afterClaim(() => { f.root().groups["810001"].memoryVerification.cases[0].revision = "revision2"; });
  await createMemoryVerificationNotifier(f.dependencies).run();
  check(() => assert.equal(f.wire(), 0));
}
{
  const f = fixture(); f.changeOnWire();
  await createMemoryVerificationNotifier(f.dependencies).run();
  check(() => assert.equal(f.wire(), 0));
  check(() => assert.equal(f.root().groups["810001"].memoryVerification.notifications[0].status, "uncertain"));
}
{
  const f = fixture(); f.settings.perGroupDailyLimit = 0;
  await createMemoryVerificationNotifier(f.dependencies).run();
  check(() => assert.equal(f.wire(), 0));
}
{
  const f = fixture(); f.item.createdAt = "2026-10-01T00:00:00Z";
  await createMemoryVerificationNotifier(f.dependencies).run();
  check(() => assert.equal(f.wire(), 0));
}
{
  const f = fixture(); f.root().groups["810001"].memoryVerification.notifications.push({ caseId: "other", subjectUserId: "10001", at: now });
  await createMemoryVerificationNotifier(f.dependencies).run();
  check(() => assert.equal(f.wire(), 0));
}
{
  const f = fixture(); f.root().groups["810001"].memoryVerification.notifications = Array.from({ length: 10 }, (_, i) => ({ caseId: `other${i}`, subjectUserId: "other", recipientId: "20001", at: now }));
  f.settings.perGroupDailyLimit = 20;
  await createMemoryVerificationNotifier(f.dependencies).run();
  check(() => assert.equal(f.wire(), 0));
}
check(() => assert.ok(!formatVerificationNotice({ oldMemory: { value: "[CQ:at,qq=all]" } }).includes("[CQ:")));
{
  const f = fixture();
  const group = f.root().groups["810001"];
  group.memoryVerification.cases = Array.from({ length: 240 }, (_, i) => ({ ...f.item, id: `M-blocked-${i}` }));
  const wanted = { ...f.item, id: "M-later-group", conversationId: "810002" };
  f.root().groups["810002"] = { memoryVerification: { cases: [wanted], notifications: [] } };
  f.dependencies.canNotify = item => item.conversationId === "810002";
  const n = createMemoryVerificationNotifier(f.dependencies);
  await n.run(); await n.run();
  check(() => assert.equal(f.wire(), 0));
  await n.run();
  check(() => assert.equal(f.wire(), 1));
  check(() => assert.equal(f.root().groups["810002"].memoryVerification.notifications[0].caseId, "M-later-group"));
}
{
  const f = fixture(); f.item.notificationReady = false;
  await createMemoryVerificationNotifier(f.dependencies).run();
  check(() => assert.equal(f.wire(), 0));
}
console.log(JSON.stringify({ ok: true, checks, sends: "synthetic-only" }));
