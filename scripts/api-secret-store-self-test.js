import assert from "node:assert/strict";
import { createApiSecretStore, isValidApiSecretRef } from "../src/api-secret-store.js";

const ref = "ec021717-671a-4c86-9ca0-c44265deee81";
const other = "91b65f87-976e-4e74-9d8b-8fae04fe992c";
const values = new Map();
const calls = [];
const store = createApiSecretStore({ platform: "darwin", runner(command, args, options) {
  calls.push({ command, args, options });
  const interactive = args[0] === "-i" ? options.input.match(/^add-generic-password -a ("(?:\\.|[^"\\])*") -s ("(?:\\.|[^"\\])*") -U -w ("(?:\\.|[^"\\])*")\n$/) : null;
  if (args[0] === "-i") assert(interactive, "interactive command must contain exactly one escaped write");
  const id = interactive ? JSON.parse(interactive[1]) : args[args.indexOf("-a") + 1];
  if (args[0] === "find-generic-password") return values.has(id)
    ? args.includes("-w") ? { status: 0, stdout: `${values.get(id)}\n`, stderr: "" }
      : { status: 0, stdout: "", stderr: '    "cdat"<timedate>="20261022080910Z"\n    "mdat"<timedate>=0x32303236313032323131313231335a00\n' }
    : { status: 44, stdout: "", stderr: "" };
  if (interactive) values.set(id, JSON.parse(interactive[3]));
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
assert.deepEqual(store.getApiSecretMetadata(ref), { status: "configured", preview: "test••••alue",
  createdAt: "2026-10-22T08:09:10Z", updatedAt: "2026-10-22T11:12:13Z" });
assert.equal(store.getApiSecretMetadata(other).preview, "othe••••alue");
values.set(other, "short-key");
assert.equal(store.getApiSecretMetadata(other).preview, "••••");
values.set(other, "other-test-value");
const add = calls.find((item) => item.args[0] === "-i");
assert.equal(add.command, "/usr/bin/security");
assert.deepEqual(add.args, ["-i"]);
assert.equal(add.args.includes("test-only-api-value"), false);
assert.equal(add.options.timeout, 5000);
assert.throws(() => store.setApiSecret(ref, "bad\nvalue"), /格式无效/);
const beforeRejected = calls.length;
assert.throws(() => store.setApiSecret(ref, "test-only-中文"), /环境变量/);
assert.throws(() => store.setApiSecret(ref, "x".repeat(4096)), /环境变量/);
assert.equal(calls.length, beforeRejected, "unsupported input is rejected before touching existing credentials");
store.setApiSecret(ref, 'test-only-quote-"-slash-\\-meta-&|%;`$!');
assert.equal(store.getApiSecret(ref), 'test-only-quote-"-slash-\\-meta-&|%;`$!');
values.set(ref, "");
assert.equal(store.getApiSecret(ref), null, "legacy empty credentials are missing, not an unavailable Keychain");
assert.deepEqual(store.getApiSecretMetadata(ref), { status: "missing", preview: null, createdAt: null, updatedAt: null });
const emptyWrite = createApiSecretStore({ platform: "darwin", runner: () => ({ status: 0, stdout: "\n", stderr: "" }) });
assert.throws(() => emptyWrite.setApiSecret(ref, "test-only-api-value"), /写入校验失败/);
store.deleteApiSecret(ref);
assert.equal(store.getApiSecret(ref), null);
assert.equal(store.getApiSecret(other), "other-test-value");
const unsupported = createApiSecretStore({ platform: "linux" });
assert.throws(() => unsupported.getApiSecret(ref), /macOS/);
assert.throws(() => unsupported.setApiSecret(ref, "test-only-api-value"), /macOS/);
const failing = createApiSecretStore({ platform: "darwin", runner: () => ({ status: 1, stderr: "test-only-api-value", stdout: "" }) });
assert.throws(() => failing.getApiSecret(ref), (error) => !error.message.includes("test-only-api-value"));
assert.deepEqual(failing.getApiSecretMetadata(ref), { status: "unavailable", preview: null, createdAt: null, updatedAt: null });
console.log("api-secret-store self-test: PASS");
