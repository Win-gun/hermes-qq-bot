import assert from "node:assert/strict";
import { createVoiceSecretStore } from "../src/voice-secret-store.js";
import { voiceApiEnvironment } from "../src/voice-credentials.js";

let saved = null;
const calls = [];
const store = createVoiceSecretStore({ platform: "darwin", runner(command, args, options) {
  calls.push({ command, args, options });
  if (args[0] === "find-generic-password") return saved === null
    ? { status: 44, stdout: "", stderr: "not found" }
    : { status: 0, stdout: `${saved}\n`, stderr: "" };
  if (args[0] === "add-generic-password") {
    saved = options.input.slice(0, -1);
    return { status: 0, stdout: "", stderr: "" };
  }
  saved = null;
  return { status: 0, stdout: "", stderr: "" };
} });

assert.equal(store.getVoiceSecret(), null);
assert.equal(store.hasVoiceSecret(), false);
store.setVoiceSecret("test-only-placeholder");
assert.equal(store.getVoiceSecret(), "test-only-placeholder");
assert.equal(store.hasVoiceSecret(), true);
const add = calls.find((item) => item.args[0] === "add-generic-password");
assert.equal(add.command, "/usr/bin/security");
assert.equal(add.args.at(-1), "-w");
assert.equal(add.args.includes("test-only-placeholder"), false);
assert.equal(add.options.timeout, 5000);
assert.equal(add.options.maxBuffer, 8192);
assert.throws(() => store.setVoiceSecret("bad\nsecret"), /格式无效/);
const keychainVoice = { apiKeyEnv: "MIMO_API_KEY", credentialSource: "keychain" };
const explicit = { MIMO_API_KEY: "legacy-value" };
assert.equal(voiceApiEnvironment(keychainVoice, {}, explicit, store).MIMO_API_KEY, "test-only-placeholder");
store.deleteVoiceSecret();
assert.equal(voiceApiEnvironment(keychainVoice, {}, explicit, store).MIMO_API_KEY, undefined);
assert.equal(explicit.MIMO_API_KEY, "legacy-value");
const unsupported = createVoiceSecretStore({ platform: "linux" });
assert.equal(unsupported.getVoiceSecret(), null);
assert.equal(unsupported.hasVoiceSecret(), false);
assert.throws(() => unsupported.setVoiceSecret("test-only-placeholder"), /macOS/);
const failing = createVoiceSecretStore({ platform: "darwin", runner: () => ({ status: 1, stderr: "test-only-placeholder", stdout: "" }) });
assert.throws(() => failing.getVoiceSecret(), (error) => !error.message.includes("test-only-placeholder"));
assert.throws(() => voiceApiEnvironment(keychainVoice, {}, explicit, failing), /无法读取 Keychain/);
console.log("voice-secret-store self-test: PASS");
