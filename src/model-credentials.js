import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Resolve only the selected connection. Never borrow a voice/other-provider key,
// search other profiles, or fall back after an explicit Keychain failure.
export function resolveModelCredential(ai, { env = process.env, getApiSecret, getVoiceSecret, read = fs.readFileSync, stat = fs.lstatSync } = {}) {
  if (ai.credentialSource === 'keychain' || ai.credentialSource === 'legacy-voice-keychain') {
    const key = ai.credentialSource === 'keychain' ? getApiSecret?.(ai.credentialRef) : getVoiceSecret?.();
    if (!key) throw Object.assign(new Error('所选 Keychain 凭据不可用'), { code: 'MODEL_CREDENTIAL_UNAVAILABLE' });
    return key;
  }
  const name = ai.apiKeyEnv;
  if (typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof env[name] === 'string' && env[name].trim()) return env[name];
  const args = Array.isArray(ai.args) ? ai.args : [];
  let profile = '';
  for (let i = 0; i < args.length; i++) {
    if (['-p', '--profile'].includes(args[i])) profile = args[++i];
    else if (typeof args[i] === 'string' && args[i].startsWith('--profile=')) profile = args[i].slice(10);
  }
  if (typeof profile !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(profile)) return null;
  const provider = ai.provider === 'mimo' ? 'xiaomi' : ai.provider;
  // Custom gateways must use their selected env/Keychain, not an unrelated pool.
  if (!['xiaomi', 'deepseek', 'openai'].includes(provider)) return null;
  let target;
  try { target = new URL(ai.baseUrl); } catch { return null; }
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash) return null;
  const file = path.join(path.resolve(env.HERMES_HOME || path.join(os.homedir(), '.hermes')), 'profiles', profile, 'auth.json');
  try {
    const info = stat(file);
    if (!info.isFile() || info.size > 65536 || (info.mode & 0o077) || typeof process.getuid === 'function' && info.uid !== process.getuid()) return null;
    const pool = JSON.parse(read(file, 'utf8'))?.credential_pool?.[provider];
    if (!Array.isArray(pool)) return null;
    const matches = pool.filter(item => {
      if (item?.auth_type !== 'api_key' || typeof item.access_token !== 'string' || !/^\S{10,4096}$/.test(item.access_token)) return false;
      try { const u = new URL(item.base_url); return u.origin === target.origin && !u.username && !u.password
        && u.pathname.replace(/\/+$/, '') === target.pathname.replace(/\/+$/, ''); } catch { return false; }
    });
    // Ambiguous rotating pools must be managed by Hermes, never guessed here.
    return matches.length === 1 ? matches[0].access_token : null;
  } catch { return null; }
}
