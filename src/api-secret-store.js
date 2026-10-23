import { spawnSync } from "node:child_process";
import { keychainPasswordWriteInput } from "./keychain-write.js";

const SECURITY = "/usr/bin/security";
const SERVICE = "Hermes QQ Bot API Center";
const MAX_SECRET_BYTES = 4096;
const REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function keychainDate(output, field) {
  const line = String(output || "").split(/\r?\n/).find((item) => item.includes(`"${field}"<timedate>`));
  if (!line) return null;
  const raw = line.match(/=\s*(?:"([0-9]{14}Z?)"|0x([0-9a-f]+))/i);
  if (!raw) return null;
  const stamp = raw[1] || (raw[2].length % 2 === 0 ? Buffer.from(raw[2], "hex").toString("ascii").replace(/\0+$/, "") : "");
  const match = stamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z?$/);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function secretPreview(secret) {
  if (!secret) return null;
  return secret.length >= 16 ? `${secret.slice(0, 4)}••••${secret.slice(-4)}` : "••••";
}

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
    if (!secret) return null;
    if (/[\r\n\0]/.test(secret) || Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES)
      throw new Error("Keychain API 凭据无效");
    return secret;
  }

  function setApiSecret(ref, secret) {
    const id = account(ref);
    if (typeof secret !== "string" || !secret || /[\r\n\0]/.test(secret)
      || Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES) throw new Error("API 凭据格式无效");
    // A trailing -w prompts on a TTY; piping the password there stores an empty
    // value. Feed a bounded, escaped interactive command over stdin instead.
    const input = keychainPasswordWriteInput(id, SERVICE, secret);
    const result = execute(["-i"], input);
    if (result.status !== 0) throw new Error("无法保存 Keychain API 凭据");
    if (getApiSecret(ref) !== secret) throw new Error("Keychain 写入校验失败，请重新保存 API 凭据");
  }

  function deleteApiSecret(ref) {
    const result = execute(["delete-generic-password", "-a", account(ref), "-s", SERVICE]);
    if (result.status !== 0 && result.status !== 44) throw new Error("无法删除 Keychain API 凭据");
  }

  function getApiSecretMetadata(ref) {
    try {
      const secret = getApiSecret(ref);
      if (!secret) return { status: "missing", preview: null, createdAt: null, updatedAt: null };
      const result = execute(["find-generic-password", "-a", account(ref), "-s", SERVICE]);
      return { status: "configured", preview: secretPreview(secret),
        createdAt: result.status === 0 ? keychainDate(`${result.stderr || ""}\n${result.stdout || ""}`, "cdat") : null,
        updatedAt: result.status === 0 ? keychainDate(`${result.stderr || ""}\n${result.stdout || ""}`, "mdat") : null };
    } catch {
      return { status: "unavailable", preview: null, createdAt: null, updatedAt: null };
    }
  }

  return { getApiSecret, setApiSecret, deleteApiSecret, getApiSecretMetadata };
}

export const { getApiSecret, setApiSecret, deleteApiSecret, getApiSecretMetadata } = createApiSecretStore();
