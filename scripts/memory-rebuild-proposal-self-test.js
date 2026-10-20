import assert from "node:assert/strict";
import { applyMemoryRebuildProposal, buildMemoryRebuildProposal } from "../src/memory-rebuild-proposal.js";

const entry = { id: "mem-old", subjectUserId: "u", value: "old", status: "rejected", correctedAt: "2026-01-01" };
const base = { groups: { g: { users: { u: { names: ["fixture"], profile: ["keep original"],
  canonicalMemory: { subjectUserId: "u", entries: [entry], conflicts: [{ entries: ["mem-old", "mem-new"] }] } } } } } };
const before = structuredClone(base);
const result = { ok: true, groupId: "g", userId: "u", canonical: { subjectUserId: "u", entries: [
  { ...entry, status: "active" }, { id: "mem-new", subjectUserId: "u", value: "new", status: "tentative" }
], conflicts: [] } };
const proposal = buildMemoryRebuildProposal(base, [result]);
assert.deepEqual(base, before, "proposal generation never changes its source");
assert.equal(proposal.targets[0].canonicalMemory.entries[0].status, "rejected", "rebuild cannot erase a correction");
assert.equal(proposal.targets[0].canonicalMemory.conflicts.length, 1);
assert.equal(proposal.targets[0].canonicalMemory.entries[1].source, "rebuild-proposal");
assert.equal(proposal.targets[0].canonicalMemory.entries[1].status, "tentative", "a paraphrase is not new independent evidence");
const advanced = structuredClone(base);
advanced.groups.other = { users: { other: { names: ["new person"] } } };
advanced.groups.g.runtime = { lastMessage: "new unrelated group state" };
const { nextMemory } = applyMemoryRebuildProposal(advanced, proposal);
assert.deepEqual(nextMemory.groups.other, advanced.groups.other, "unrelated data received meanwhile survives");
assert.deepEqual(nextMemory.groups.g.runtime, advanced.groups.g.runtime);
assert.deepEqual(nextMemory.groups.g.users.u.profile, ["keep original"]);
assert.equal(nextMemory.groups.g.users.u.canonicalMemory.entries.length, 2);
assert.deepEqual(advanced.groups.g.users.u, base.groups.g.users.u, "apply returns a candidate, does not mutate live objects");
const changed = structuredClone(base);
changed.groups.g.users.u.names.push("new name received meanwhile");
assert.throws(() => applyMemoryRebuildProposal(changed, proposal), { code: "MEMORY_CONFLICT" });
assert.deepEqual(changed.groups.g.users.u.names, ["fixture", "new name received meanwhile"]);
assert.throws(() => applyMemoryRebuildProposal(base, { ...proposal, targets: [...proposal.targets, ...proposal.targets] }), { code: "MEMORY_REBUILD_TARGET" });
assert.throws(() => applyMemoryRebuildProposal(base, { ...proposal, targets: [{ ...proposal.targets[0], subjectUserId: "__proto__" }] }), { code: "MEMORY_REBUILD_TARGET" });
assert.throws(() => buildMemoryRebuildProposal(base, [{ ...result, ok: false }]), { code: "MEMORY_REBUILD_INCOMPLETE" });
assert.throws(() => buildMemoryRebuildProposal(base, [{ ...result, canonical: { subjectUserId: "other" } }]), { code: "MEMORY_REBUILD_TARGET" });
assert.throws(() => applyMemoryRebuildProposal(base, { ...proposal, formatVersion: 999 }), { code: "MEMORY_REBUILD_INVALID" });
assert.deepEqual(applyMemoryRebuildProposal(base, buildMemoryRebuildProposal(base, [])).nextMemory, base);
console.log("memory rebuild proposal: immutable candidates, scoped CAS, preserved evidence and invalid targets passed");
