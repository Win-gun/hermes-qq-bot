import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { voiceApiEnvironment, voiceApiKeyAvailable } from "../src/voice-credentials.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-voice-auth-"));
try {
  const profileDir = path.join(root, "profiles", "voice-test");
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const file = path.join(profileDir, "auth.json");
  const fixture = { credential_pool: { xiaomi: [{ auth_type: "api_key", base_url: "https://api.xiaomimimo.com/v1", access_token: "test-only-placeholder" }] } };
  fs.writeFileSync(file, JSON.stringify(fixture), { mode: 0o600 });
  const voice = { apiKeyEnv: "MIMO_API_KEY" };
  const ai = { args: ["-m", "model", "-p", "voice-test", "-z"] };
  const env = { HERMES_HOME: root };
  assert.equal(voiceApiKeyAvailable(voice, ai, env), true);
  assert.equal(voiceApiEnvironment(voice, ai, env).MIMO_API_KEY, "test-only-placeholder");
  assert.equal(env.MIMO_API_KEY, undefined);
  assert.equal(voiceApiEnvironment(voice, ai, { ...env, MIMO_API_KEY: "explicit-key" }).MIMO_API_KEY, "explicit-key");
  assert.equal(voiceApiKeyAvailable(voice, { args: ["-p", "missing"] }, env), false);
  assert.equal(voiceApiKeyAvailable({ apiKeyEnv: "CUSTOM_KEY" }, ai, env), false);
  fs.chmodSync(file, 0o644);
  assert.equal(voiceApiKeyAvailable(voice, ai, env), false);
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, JSON.stringify({ credential_pool: { xiaomi: [{ ...fixture.credential_pool.xiaomi[0], base_url: "https://example.com" }] } }), { mode: 0o600 });
  assert.equal(voiceApiKeyAvailable(voice, ai, env), false);
  console.log("voice-credentials self-test: PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
