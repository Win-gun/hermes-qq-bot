import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { keychainPasswordWriteInput } from "../src/keychain-write.js";
import { createApiSecretStore } from "../src/api-secret-store.js";

const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
const input = keychainPasswordWriteInput("test-account", "Isolated Test Service", printable);
assert(input.endsWith("\n"));
assert.equal(input.split("\n").length, 2);
assert(input.includes('\\"'));
assert(input.includes("\\\\"));
for (const value of ["", "line\nbreak", "carriage\rreturn", "null\0byte", "tab\tvalue", "中文", "x".repeat(4096)]) {
  assert.throws(() => keychainPasswordWriteInput("test-account", "Isolated Test Service", value));
}

if (process.argv.includes("--native")) {
  assert.equal(process.platform, "darwin", "native test requires macOS");
  const ref = randomUUID();
  const store = createApiSecretStore();
  let started = false;
  try {
    assert.equal(store.getApiSecret(ref), null);
    started = true;
    for (const value of ["test-only-keychain-value", printable, "test-only-replacement"]) {
      store.setApiSecret(ref, value);
      assert.equal(store.getApiSecret(ref), value);
      const metadata = store.getApiSecretMetadata(ref);
      assert.equal(metadata.status, "configured");
      assert.equal(metadata.preview, `${value.slice(0, 4)}••••${value.slice(-4)}`);
      assert(Number.isFinite(Date.parse(metadata.createdAt)), "native creation time must be available");
      assert(Number.isFinite(Date.parse(metadata.updatedAt)), "native update time must be available");
      assert(!JSON.stringify(metadata).includes(value), "metadata must not reveal the full value");
    }
    assert.throws(() => store.setApiSecret(ref, "x".repeat(4096)), /环境变量/);
    assert.equal(store.getApiSecret(ref), "test-only-replacement");
    store.deleteApiSecret(ref);
    assert.equal(store.getApiSecret(ref), null);
    started = false;
  } finally {
    if (started) store.deleteApiSecret(ref);
  }
}
console.log(JSON.stringify({ ok: true, keychainWrite: "PASS", native: process.argv.includes("--native"), realCredentialsUsed: false }));
