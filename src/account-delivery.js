import { accountScopeAllows, effectiveAccount } from "./account-registry.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { socialExperienceFor } from "./social-experience-policy.js";
import { QQ_REACTION_LABELS } from "./message-reactions.js";

function localMediaKind(value) {
  let filename = String(value || "");
  if (filename.startsWith("file://")) {
    try { filename = fileURLToPath(filename); } catch { return "file"; }
  }
  if (!path.isAbsolute(filename)) return "file";
  let descriptor;
  try {
    descriptor = fs.openSync(filename, "r");
    if (!fs.fstatSync(descriptor).isFile()) return "file";
    const header = Buffer.alloc(32);
    const size = fs.readSync(descriptor, header, 0, header.length, 0);
    const bytes = header.subarray(0, size);
    const text = bytes.toString("latin1");
    if (/^(?:ID3|OggS|fLaC|#!AMR|\x02?#!SILK)/.test(text) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
      || (text.startsWith("RIFF") && text.slice(8, 12) === "WAVE")) return "record";
    if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) || text.startsWith("GIF8")
      || (bytes[0] === 0xff && bytes[1] === 0xd8) || (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP")) return "image";
    if (text.slice(4, 8) === "ftyp" || (text.startsWith("RIFF") && text.slice(8, 12) === "AVI ")
      || bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video";
  } catch { /* The protocol will report unreadable files; never expose paths. */ }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  return "file";
}

function fileKind(name = "") {
  const ext = String(name).split(/[?#]/)[0].split(".").at(-1).toLowerCase();
  if (["mp3", "wav", "amr", "silk", "ogg", "opus", "m4a", "aac", "flac"].includes(ext)) return "record";
  if (["mp4", "mov", "webm", "avi", "mkv"].includes(ext)) return "video";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) return "image";
  return "file";
}

export function messageContentTypes(message) {
  const types = new Set();
  const visit = (content) => {
    if (typeof content === "string") {
      const clean = content.replace(/\[CQ:([^,\]]+)(?:,([^\]]*))?\]/g, (_, type, data = "") => {
        if (!["reply", "at"].includes(type)) types.add(type === "face" ? "image" : type);
        if (type === "file") types.add(fileKind(data));
        return "";
      });
      if (clean.trim()) types.add("text");
    } else if (Array.isArray(content)) content.forEach(visit);
    else if (content && typeof content === "object") {
      if (content.type === "text") { if (content.data?.text?.trim()) types.add("text"); }
      else if (content.type === "node") {
        if (content.data?.content) visit(content.data.content);
        else types.add("unresolved_forward");
      }
      else if (!["reply", "at"].includes(content.type)) {
        types.add(content.type === "face" ? "image" : content.type);
        if (content.type === "file") {
          types.add(fileKind(content.data?.file)); types.add(fileKind(content.data?.name));
          types.add(localMediaKind(content.data?.file));
        }
      }
    }
  };
  visit(message);
  return [...types];
}

export function accountDeliveryDecision(config, accountId, action, params = {}, { quiet = false, activeGroupAccountId = "", nativePokeVerified = false } = {}) {
  // Native poke is not a read action. Until a verified protocol capability,
  // target evidence and dedicated policy exist, fail closed even for group_poke
  // (whose name does not match the legacy send_* guard). The alternate reaction
  // endpoint is deliberately unsupported; it must not become a write bypass.
  if (["friend_poke", "send_poke", "set_msg_emoji_like"].includes(action) || action === "group_poke" && nativePokeVerified !== true) return {
    allowed: false, reason: "该原生交互能力尚未验证或授权", code: "ACCOUNT_SEND_BLOCKED", types: []
  };
  const reaction = action === "set_group_reaction";
  const poke = action === "group_poke";
  if (!reaction && !poke && !/^send_/.test(action) && !/^upload_(?:group|private)_file$/.test(action)) return { allowed: true, types: [] };
  const account = effectiveAccount(config, accountId);
  const groupId = params.group_id;
  const messageType = groupId ? "group" : "private";
  const deny = (reason) => ({ allowed: false, reason, code: "ACCOUNT_SEND_BLOCKED", types: [] });
  if (!account || !account.enabled || account.archived || !account.protocolEnabled) return deny("账号机器人已暂停或协议端已停止");
  if (account.groupId && activeGroupAccountId !== accountId) return deny("该账号不是接管组当前成员");
  if (!accountScopeAllows(account, messageType, groupId)) return deny("该会话不在账号参与范围内");
  if (messageType === "group" && quiet) return deny("群聊处于 quiet 状态");
  if (poke) {
    const policy = socialExperienceFor({ socialExperience: account.socialExperience ?? config.socialExperience }, `group:${groupId}`);
    if (!policy.active || policy.shadowMode || !policy.pokes.enabled || account.features?.chat !== true
      || !Number.isSafeInteger(params.group_id) || params.group_id <= 0 || !Number.isSafeInteger(params.user_id) || params.user_id <= 0
      || Object.keys(params).some(key => !["group_id", "user_id"].includes(key))) return deny("拍一拍未授权");
  }
  if (reaction) {
    if (account.features?.chat !== true) return deny("账号未开启聊天参与");
    const policy = socialExperienceFor({ socialExperience: account.socialExperience ?? config.socialExperience }, `group:${groupId}`);
    if (!/^[1-9]\d{0,19}$/.test(String(groupId)) || !/^-?[1-9]\d{0,19}$/.test(String(params.message_id))
      || typeof params.code !== "string" || !Object.hasOwn(QQ_REACTION_LABELS, params.code)
      || !policy.reactions.emojiIds.includes(params.code) || params.is_set !== true
      || Object.keys(params).some(key => !["group_id", "message_id", "code", "is_set"].includes(key))
      || !policy.active || policy.shadowMode || !policy.reactions.enabled) return deny("消息回应未授权");
  }
  let types = reaction || poke ? ["text"] : messageContentTypes(params.message ?? params.messages);
  if (/^upload_/.test(action)) types = [...new Set(["file", fileKind(params.name), fileKind(params.file), localMediaKind(params.file)])];
  if (!types.length) return deny("无法验证待发送内容类型");
  if (types.some((type) => account.sendTypes?.[type] !== true)) return deny("账号未允许发送该内容类型");
  return { allowed: true, types };
}

// One queue per group across every account. Policy is checked again immediately
// before sending, so a paused account cannot leak an already queued message.
export class GroupSendCoordinator {
  constructor({ minDelayMs = () => 1000 } = {}) { this.tails = new Map(); this.lastSent = new Map(); this.minDelayMs = minDelayMs; }
  dispatch(groupId, validate, send) {
    if (!groupId) return Promise.resolve().then(validate).then(send);
    const key = String(groupId);
    const previous = this.tails.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const wait = Math.max(0, Number(this.minDelayMs()) - (Date.now() - (this.lastSent.get(key) || 0)));
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      await validate();
      const result = send();
      this.lastSent.set(key, Date.now());
      return result;
    });
    this.tails.set(key, pending);
    pending.finally(() => { if (this.tails.get(key) === pending) this.tails.delete(key); }).catch(() => {});
    return pending;
  }
}
