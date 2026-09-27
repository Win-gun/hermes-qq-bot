import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function hermesProfile(ai = {}) {
  const args = Array.isArray(ai.args) ? ai.args : [];
  for (let i = 0; i < args.length; i += 1) {
    const value = String(args[i]);
    const candidate = value === "-p" || value === "--profile" ? args[i + 1]
      : value.startsWith("--profile=") ? value.slice("--profile=".length) : "";
    if (candidate && /^[A-Za-z0-9_-]{1,80}$/.test(String(candidate))) return String(candidate);
  }
  return "";
}

/** Reuse only the active Hermes profile's private Xiaomi credential; never log or persist it. */
export function voiceApiEnvironment(voice = {}, ai = {}, env = process.env) {
  const name = voice.apiKeyEnv || "MIMO_API_KEY";
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return env;
  if (typeof env[name] === "string" && env[name].trim()) return env;
  if (name !== "MIMO_API_KEY") return env;
  const profile = hermesProfile(ai);
  if (!profile) return env;
  const home = path.resolve(env.HERMES_HOME || path.join(os.homedir(), ".hermes"));
  const authPath = path.join(home, "profiles", profile, "auth.json");
  try {
    const stat = fs.lstatSync(authPath);
    if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return env;
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const credential = auth?.credential_pool?.xiaomi?.find((item) => {
      if (item?.auth_type !== "api_key" || typeof item.access_token !== "string"
        || !/^\S{10,512}$/.test(item.access_token)) return false;
      try { return new URL(item.base_url).origin === "https://api.xiaomimimo.com"; }
      catch { return false; }
    });
    return credential ? { ...env, [name]: credential.access_token } : env;
  } catch {
    return env;
  }
}

export function voiceApiKeyAvailable(voice = {}, ai = {}, env = process.env) {
  const name = voice.apiKeyEnv || "MIMO_API_KEY";
  return typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    && Boolean(voiceApiEnvironment(voice, ai, env)[name]);
}
