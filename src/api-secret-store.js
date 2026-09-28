import { spawnSync } from "node:child_process";

const SECURITY = "/usr/bin/security";
const SERVICE = "Hermes QQ Bot API Center";
const MAX_SECRET_BYTES = 4096;
const REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidApiSecretRef(ref) {
  return typeof ref === "string" && REF_RE.test(ref);
}

export function createApiSecretStore({ runner = spawnSync, platform = process.platform } = {}) {
  function account(ref) {
    if (!isValidApiSecretRef(ref)) throw new Error("API 凭据引用格式无效");
    return ref.toLowerCase();
  }

  function execute(args, input) {
    if (platform !== "darwin") throw new Error("API 凭据仅支持 macOS Keychain");
    let result;
    try {
      result = runner(SECURITY, args, {
        encoding: "utf8", input, timeout: 5000, maxBuffer: 8192, windowsHide: true
      });
    } catch {
      throw new Error("Keychain 操作失败");
    }
    // Child errors, stdout and stderr can contain credential material.
    if (!result || result.error || result.signal) throw new Error("Keychain 操作失败");
    return result;
  }

  function getApiSecret(ref) {
    const result = execute(["find-generic-password", "-a", account(ref), "-s", SERVICE, "-w"]);
    if (result.status === 44) return null;
    if (result.status !== 0) throw new Error("无法读取 Keychain API 凭据");
    const secret = String(result.stdout || "").replace(/\r?\n$/, "");
    if (!secret || /[\r\n\0]/.test(secret) || Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES)
      throw new Error("Keychain API 凭据无效");
    return secret;
  }

  function setApiSecret(ref, secret) {
    const id = account(ref);
    if (typeof secret !== "string" || !secret || /[\r\n\0]/.test(secret)
      || Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES) throw new Error("API 凭据格式无效");
    // A valueless trailing -w makes security read the value from stdin, not argv.
    const result = execute(["add-generic-password", "-a", id, "-s", SERVICE, "-U", "-w"], `${secret}\n`);
    if (result.status !== 0) throw new Error("无法保存 Keychain API 凭据");
  }

  function deleteApiSecret(ref) {
    const result = execute(["delete-generic-password", "-a", account(ref), "-s", SERVICE]);
    if (result.status !== 0 && result.status !== 44) throw new Error("无法删除 Keychain API 凭据");
  }

  return { getApiSecret, setApiSecret, deleteApiSecret };
}

export const { getApiSecret, setApiSecret, deleteApiSecret } = createApiSecretStore();
