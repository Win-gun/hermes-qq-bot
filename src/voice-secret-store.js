import { spawnSync } from "node:child_process";
import { keychainPasswordWriteInput } from "./keychain-write.js";

const SECURITY = "/usr/bin/security";
const SERVICE = "Hermes QQ Bot Voice API";
const ACCOUNT = "voice-api-key";
const MAX_SECRET_BYTES = 4096;

export function voiceSecretWriteInput(secret) {
  if (typeof secret !== "string" || !secret || /[\r\n\0]/.test(secret)
    || Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES) throw new Error("语音凭据格式无效");
  return keychainPasswordWriteInput(ACCOUNT, SERVICE, secret);
}

/** Synchronous so the existing voice environment path can use it without changing callers. */
export function createVoiceSecretStore({ runner = spawnSync, platform = process.platform } = {}) {
  function execute(args, input) {
    if (platform !== "darwin") throw new Error("语音凭据仅支持 macOS Keychain");
    let result;
    try {
      result = runner(SECURITY, args, {
        encoding: "utf8",
        input,
        timeout: 5000,
        maxBuffer: 8192,
        windowsHide: true
      });
    } catch {
      throw new Error("Keychain 操作失败");
    }
    // Never propagate stderr, stdout, argv, or the process error: any can contain a secret.
    if (result.error || result.signal) throw new Error("Keychain 操作失败");
    return result;
  }

  function getVoiceSecret() {
    if (platform !== "darwin") return null;
    const result = execute(["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"]);
    if (result.status === 44) return null; // errSecItemNotFound, as a shell exit status.
    if (result.status !== 0) throw new Error("无法读取 Keychain 语音凭据");
    const secret = String(result.stdout || "").replace(/\r?\n$/, "");
    if (!secret) return null;
    if (Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES) throw new Error("Keychain 语音凭据无效");
    return secret;
  }

  function setVoiceSecret(secret) {
    const input = voiceSecretWriteInput(secret);
    const result = execute(["-i"], input);
    if (result.status !== 0) throw new Error("无法保存 Keychain 语音凭据");
    if (getVoiceSecret() !== secret) throw new Error("Keychain 写入校验失败，请重新保存语音凭据");
  }

  function deleteVoiceSecret() {
    const result = execute(["delete-generic-password", "-a", ACCOUNT, "-s", SERVICE]);
    if (result.status !== 0 && result.status !== 44) throw new Error("无法删除 Keychain 语音凭据");
  }

  function hasVoiceSecret() { return getVoiceSecret() !== null; }

  return { getVoiceSecret, setVoiceSecret, deleteVoiceSecret, hasVoiceSecret };
}

export const { getVoiceSecret, setVoiceSecret, deleteVoiceSecret, hasVoiceSecret } = createVoiceSecretStore();
