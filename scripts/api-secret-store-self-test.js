import assert from "node:assert/strict";
import { createApiSecretStore, isValidApiSecretRef } from "../src/api-secret-store.js";

const ref = "ec021717-671a-4c86-9ca0-c44265deee81";
const other = "91b65f87-976e-4e74-9d8b-8fae04fe992c";
const values = new Map();
const calls = [];
const store = createApiSecretStore({ platform: "darwin", runner(command, args, options) {
  calls.push({ command, args, options });
  const id = args[args.indexOf("-a") + 1];
  if (args[0] === "find-generic-password") return values.has(id)
    ? { status: 0, stdout: `${values.get(id)}\n`, stderr: "" }
    : { status: 44, stdout: "", stderr: "" };
  if (args[0] === "add-generic-password") values.set(id, options.input.slice(0, -1));
  if (args[0] === "delete-generic-password") values.delete(id);
  return { status: 0, stdout: "", stderr: "" };
} });

assert.equal(isValidApiSecretRef(ref), true);
for (const invalid of ["../secret", "../../foo", "", "A".repeat(36), "00000000-0000-0000-0000-000000000000", `${ref}/other`]) {
  assert.equal(isValidApiSecretRef(invalid), false);
  assert.throws(() => store.getApiSecret(invalid), /引用格式无效/);
  assert.throws(() => store.deleteApiSecret(invalid), /引用格式无效/);
}
assert.equal(store.getApiSecret(ref), null);
store.setApiSecret(ref, "test-only-api-value");
store.setApiSecret(other, "other-test-value");
assert.equal(store.getApiSecret(ref), "test-only-api-value");
assert.equal(store.getApiSecret(other), "other-test-value");
const add = calls.find((item) => item.args[0] === "add-generic-password");
assert.equal(add.command, "/usr/bin/security");
assert.equal(add.args.at(-1), "-w");
assert.equal(add.args.includes("test-only-api-value"), false);
assert.equal(add.options.timeout, 5000);
assert.throws(() => store.setApiSecret(ref, "bad\nvalue"), /格式无效/);
store.deleteApiSecret(ref);
assert.equal(store.getApiSecret(ref), null);
assert.equal(store.getApiSecret(other), "other-test-value");
const unsupported = createApiSecretStore({ platform: "linux" });
assert.throws(() => unsupported.getApiSecret(ref), /macOS/);
assert.throws(() => unsupported.setApiSecret(ref, "test-only-api-value"), /macOS/);
const failing = createApiSecretStore({ platform: "darwin", runner: () => ({ status: 1, stderr: "test-only-api-value", stdout: "" }) });
assert.throws(() => failing.getApiSecret(ref), (error) => !error.message.includes("test-only-api-value"));
console.log("api-secret-store self-test: PASS");
