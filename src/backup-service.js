import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import * as tar from "tar";

export const BACKUP_MAGIC = Buffer.from("HERMESQQBACKUP1\n", "utf8");
export const BACKUP_FORMAT_VERSION = 1;
const CURRENT_APP_VERSION = "1.0.0-beta.4";
const DEFAULT_COMPONENTS = ["config.json", "data"];
const DATA_COMPONENTS = ["memory.json", "chat-archive", "images", "tasks"];
const HERMES_PROFILE_FILES = new Set([".env", "config.yaml", "config.yml", "config.json", "profiles", "auth.json", "skills"]);
const SECRET_KEY_RE = /(^|_)(password|passwd|secret|token|cookie|credential|privatekey|api[_-]?key)($|_)/i;
const SECRET_VALUE_RE = /^(sk[-_][A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_.-]{24,}|[A-Za-z0-9+/=_-]{48,})$/;

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  try { fs.chmodSync(dir, mode); } catch { /* best effort */ }
}

function safeSegment(value, fallback = "item") {
  return String(value || "").replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "") || fallback;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function versionParts(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[4])];
}

function versionAtLeast(current, minimum) {
  const left = versionParts(current);
  const right = versionParts(minimum);
  if (!left || !right) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return true;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function copyPath(source, destination, options = {}) {
  if (!fs.existsSync(source)) return false;
  ensureDir(path.dirname(destination));
  fs.cpSync(source, destination, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    filter: options.filter
  });
  return true;
}

export class BackupCancelledError extends Error {
  constructor() { super("备份已取消"); this.name = "BackupCancelledError"; }
}

function checkCancelled(signal) {
  if (signal?.aborted) throw new BackupCancelledError();
}

async function copyPathForBackup(source, destination, { signal, filter } = {}) {
  if (!fs.existsSync(source)) return false;
  const visit = async (from, to) => {
    checkCancelled(signal);
    const stat = await fs.promises.lstat(from);
    if (filter && !filter(from, stat)) return;
    if (stat.isSymbolicLink()) throw new Error(`备份不接受符号链接：${path.basename(from)}`);
    if (stat.isDirectory()) {
      await fs.promises.mkdir(to, { recursive: true, mode: 0o700 });
      for (const name of await fs.promises.readdir(from)) await visit(path.join(from, name), path.join(to, name));
    } else if (stat.isFile()) {
      await fs.promises.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      await pipeline(fs.createReadStream(from), fs.createWriteStream(to, { mode: stat.mode & 0o777 }), { signal });
      await fs.promises.utimes(to, stat.atime, stat.mtime);
    }
  };
  await visit(source, destination);
  return true;
}

function walkFiles(root, base = root, out = [], signal) {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    checkCancelled(signal);
    const full = path.join(root, entry.name);
    const relative = path.relative(base, full).split(path.sep).join("/");
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`backup refuses symbolic link: ${relative}`);
    if (stat.isDirectory()) walkFiles(full, base, out, signal);
    else if (stat.isFile()) out.push({ path: relative, size: stat.size });
  }
  return out;
}

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    do {
      bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes) hash.update(buffer.subarray(0, bytes));
    } while (bytes);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

async function checksumInventoryForBackup(payloadDir, signal, onProgress) {
  const files = walkFiles(payloadDir, payloadDir, [], signal).filter((entry) => entry.path !== "manifest.json");
  const result = [];
  for (let index = 0; index < files.length; index += 1) {
    checkCancelled(signal);
    const entry = files[index];
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(path.join(payloadDir, entry.path), { signal })) hash.update(chunk);
    result.push({ ...entry, sha256: hash.digest("hex") });
    onProgress?.(index + 1, files.length);
  }
  return result;
}

function likelySecret(value) {
  const text = String(value || "").trim();
  if (path.isAbsolute(text) || /^(?:https?:|file:)\/\//i.test(text)) return false;
  return SECRET_VALUE_RE.test(text) || (/^Bearer\s+/i.test(text) && text.length > 24);
}

function mapConfigStrings(value, transform) {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((item) => mapConfigStrings(item, transform));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapConfigStrings(item, transform)]));
}

function portableConfig(config, stateRoot, hermesHome) {
  return mapConfigStrings(config, (value) => {
    let output = value;
    if (hermesHome) output = output.split(hermesHome).join("${HERMES_HOME}");
    return output.split(stateRoot).join("${HERMES_QQ_HOME}");
  });
}

function localConfig(config, stateRoot, hermesHome) {
  return mapConfigStrings(config, (value) => value
    .split("${HERMES_QQ_HOME}").join(stateRoot)
    .split("${HERMES_HOME}").join(hermesHome || path.join(stateRoot, "hermes")));
}

export function sanitizeConfigForBackup(input) {
  const redactions = [];
  const visit = (value, trail = []) => {
    if (Array.isArray(value)) return value.map((item, index) => visit(item, [...trail, String(index)]));
    if (!value || typeof value !== "object") return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "__path") continue;
      const nextTrail = [...trail, key];
      const isEnvironmentName = /env(var|name)?$/i.test(key) || /apiKeyEnv/i.test(key);
      const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
      const secretKey = SECRET_KEY_RE.test(normalizedKey) && !isEnvironmentName;
      if (secretKey || (typeof child === "string" && likelySecret(child) && !isEnvironmentName)) {
        output[key] = "";
        redactions.push(nextTrail.join("."));
      } else {
        output[key] = visit(child, nextTrail);
      }
    }
    return output;
  };
  return { config: visit(input || {}), redactions };
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    if (options.signal?.aborted) { resolve({ ok: false, aborted: true, code: null, stdout: "", stderr: "" }); return; }
    const searchPath = (options.env?.PATH || process.env.PATH || "").split(path.delimiter);
    const candidates = [...searchPath.map((dir) => path.join(dir, command)), ...(command === "docker" ? ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"] : [])];
    const executable = candidates.find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } }) || command;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: [options.stdin ? "pipe" : "ignore", options.stdoutFile ? "pipe" : "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let fileStream = null;
    if (options.stdoutFile) {
      ensureDir(path.dirname(options.stdoutFile));
      fileStream = fs.createWriteStream(options.stdoutFile, { mode: 0o600 });
      child.stdout.pipe(fileStream);
    } else {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
    }
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    if (options.stdin) options.stdin.pipe(child.stdin);
    const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs) : null;
    const abort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => resolve({ ok: false, code: null, error: error.message, stdout: "", stderr: "" }));
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      const finish = () => resolve({
        ok: code === 0,
        aborted: Boolean(options.signal?.aborted),
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
      if (fileStream && !fileStream.writableFinished) fileStream.once("finish", finish);
      else finish();
    });
  });
}

async function dockerInspect(container) {
  const result = await run("docker", ["inspect", container], { timeoutMs: 15_000 });
  if (!result.ok) throw new Error(`Docker container unavailable (${container}): ${result.stderr.trim() || result.error || result.code}`);
  const parsed = JSON.parse(result.stdout);
  return parsed[0] || {};
}

function accountDefinitions(config = {}) {
  const primary = { id: "primary", role: "primary", ...(config.accounts?.primary || {}) };
  const standbys = Array.isArray(config.accounts?.standbys) ? config.accounts.standbys : [];
  return [primary, ...standbys.map((item, index) => ({ id: item.id || `standby-${index + 1}`, role: "standby", ...item }))]
    .filter((account) => String(account.protocol || "napcat").toLowerCase() === "snowluma");
}

function protocolContainer(account) {
  return String(account.protocolContainer || account.snowlumaContainer || `snowluma-${safeSegment(account.id || "primary")}`);
}

async function containerWasRunning(container) {
  const inspect = await dockerInspect(container);
  return Boolean(inspect.State?.Running);
}

async function stopContainers(containers, states = []) {
  for (const container of containers) {
    try {
      const running = await containerWasRunning(container);
      states.push({ container, running });
      if (running) {
        const result = await run("docker", ["stop", "-t", "15", container], { timeoutMs: 30_000 });
        if (!result.ok) throw new Error(result.stderr.trim() || `docker stop exited ${result.code}`);
      }
    } catch (error) {
      if (states.some((state) => state.container === container)) throw error;
      states.push({ container, running: false, missing: true, error: error.message });
    }
  }
  return states;
}

async function restartPreviouslyRunning(states) {
  for (const state of states) {
    if (!state.running) continue;
    const result = await run("docker", ["start", state.container], { timeoutMs: 30_000 });
    if (!result.ok) throw new Error(`无法重启 ${state.container}：${result.stderr.trim() || result.error || result.code}`);
  }
}

async function exportDockerVolume({ volume, image, output, signal }) {
  checkCancelled(signal);
  const temporaryContainer = `hermesqq-backup-export-${crypto.randomBytes(6).toString("hex")}`;
  const args = ["run", "--rm", "--name", temporaryContainer, "-v", `${volume}:/source:ro`, "--entrypoint", "sh", image, "-lc", "tar -czf - -C /source ."];
  const result = await run("docker", args, { stdoutFile: output, timeoutMs: 10 * 60_000, signal });
  if (signal?.aborted) {
    await run("docker", ["rm", "-f", temporaryContainer], { timeoutMs: 30_000 });
    throw new BackupCancelledError();
  }
  if (!result.ok) throw new Error(`Docker volume export failed (${volume}): ${result.stderr.trim() || result.error || result.code}`);
}

async function collectDockerState({ config, payloadDir, signal, onProgress }) {
  const accounts = accountDefinitions(config);
  const containers = accounts.map(protocolContainer);
  const states = [];
  const records = [];
  try {
    onProgress?.({ stage: "docker", percent: 10, detail: "暂停协议端并准备导出登录状态" });
    await stopContainers(containers, states);
    const inspections = [];
    for (const account of accounts) {
      checkCancelled(signal);
      try { inspections.push({ account, inspect: await dockerInspect(protocolContainer(account)) }); }
      catch (error) { if (account.enabled !== false) throw error; }
    }
    const volumeCount = inspections.reduce((count, item) => count + (item.inspect.Mounts || []).filter((mount) => mount.Type === "volume" && ["/app/snowluma-data", "/app/.config", "/app/.local/share"].includes(mount.Destination)).length, 0);
    let completed = 0;
    for (const { account, inspect } of inspections) {
      checkCancelled(signal);
      const container = protocolContainer(account);
      const image = String(account.snowlumaImage || inspect.Config?.Image || "motricseven7/snowluma:latest");
      let exported = 0;
      for (const mount of inspect.Mounts || []) {
        if (mount.Type !== "volume") continue;
        const keyByDestination = {
          "/app/snowluma-data": "snowlumaData",
          "/app/.config": "appConfig",
          "/app/.local/share": "localShare"
        };
        const key = keyByDestination[mount.Destination];
        if (!key) continue;
        const relative = path.join("docker", safeSegment(account.id), `${key}.tgz`);
        onProgress?.({ stage: "docker", percent: Math.round(12 + 58 * completed / Math.max(volumeCount, 1)), detail: `导出登录状态 ${completed + 1}/${volumeCount}（${account.id}）` });
        await exportDockerVolume({ volume: mount.Name, image, output: path.join(payloadDir, relative), signal });
        records.push({ accountId: String(account.id), container, destination: mount.Destination, key, image, archive: relative.split(path.sep).join("/") });
        exported += 1;
        completed += 1;
        onProgress?.({ stage: "docker", percent: Math.round(12 + 58 * completed / Math.max(volumeCount, 1)), detail: `已导出登录状态 ${completed}/${volumeCount}` });
      }
      if (account.enabled !== false && !exported) throw new Error(`SnowLuma account has no portable Docker volume: ${account.id}`);
    }
  } finally {
    await restartPreviouslyRunning(states);
  }
  return { records, containerStates: states };
}

function shouldCopyProtocolHost(name) {
  return /^(snowluma|napcat)(-|$)/.test(name);
}

function copyHermesProfile(sourceRoot, destinationRoot) {
  if (!sourceRoot || !fs.existsSync(sourceRoot)) return false;
  let copied = false;
  for (const name of fs.readdirSync(sourceRoot)) {
    if (!HERMES_PROFILE_FILES.has(name)) continue;
    copied = copyPath(path.join(sourceRoot, name), path.join(destinationRoot, name), {
      filter: (source) => !/(\/logs?|\/sessions?|\/cache|state\.db)(\/|$)/i.test(source)
    }) || copied;
  }
  return copied;
}

async function copyBackupPayload({ stateRoot, hermesHome, logRoot, includeLogs, payloadDir, type, signal }) {
  const configPath = path.join(stateRoot, "config.json");
  const rawConfig = readJson(configPath, {});
  const sensitive = type === "full";
  const sanitized = sensitive ? { config: rawConfig, redactions: [] } : sanitizeConfigForBackup(rawConfig);
  writeJson(path.join(payloadDir, "state", "config.json"), portableConfig(sanitized.config, stateRoot, hermesHome));
  const dataTarget = path.join(payloadDir, "state", "data");
  for (const name of DATA_COMPONENTS) await copyPathForBackup(path.join(stateRoot, "data", name), path.join(dataTarget, name), { signal });
  if (sensitive) {
    for (const name of fs.existsSync(stateRoot) ? fs.readdirSync(stateRoot) : []) {
      if (!shouldCopyProtocolHost(name)) continue;
      await copyPathForBackup(path.join(stateRoot, name), path.join(payloadDir, "protocol-host", name), {
        signal,
        filter: (source) => !/(\/logs?|\/cache)(\/|$)/i.test(source)
      });
    }
    if (hermesHome && fs.existsSync(hermesHome)) {
      for (const name of fs.readdirSync(hermesHome)) {
        if (!HERMES_PROFILE_FILES.has(name)) continue;
        await copyPathForBackup(path.join(hermesHome, name), path.join(payloadDir, "hermes-home", name), {
          signal,
          filter: (source, stat) => {
            const relative = path.relative(hermesHome, source).split(path.sep);
            if (relative.some((part) => /^(?:logs?|sessions?|cache|node_modules|lsp|\.venv|state\.db)$/i.test(part))) return false;
            if (stat.isSymbolicLink()) {
              if (relative.some((part) => /^(?:\.env|auth\.json|config\.(?:json|ya?ml))$/i.test(part))) throw new Error(`Hermes 凭据文件是符号链接，无法安全备份：${relative.join("/")}`);
              return false;
            }
            return true;
          }
        });
      }
    }
    if (includeLogs && logRoot) await copyPathForBackup(logRoot, path.join(payloadDir, "diagnostic-logs"), { signal });
  }
  return { rawConfig, redactions: sanitized.redactions };
}

async function buildPayload({ stateRoot, hermesHome, logRoot, includeLogs, type, appVersion, platform, arch, signal, onProgress }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-backup-"));
  fs.chmodSync(tempRoot, 0o700);
  try {
    const payloadDir = path.join(tempRoot, "payload");
    ensureDir(payloadDir);
    onProgress?.({ stage: "copy", percent: 2, detail: "复制配置、记忆和聊天数据" });
    const { rawConfig, redactions } = await copyBackupPayload({ stateRoot, hermesHome, logRoot, includeLogs, payloadDir, type, signal });
    checkCancelled(signal);
    onProgress?.({ stage: "copy", percent: 10, detail: "本地数据已复制" });
    let docker = { records: [], containerStates: [] };
    if (type === "full") docker = await collectDockerState({ config: rawConfig, payloadDir, signal, onProgress });
    checkCancelled(signal);
    const checksumStart = type === "full" ? 70 : 35;
    onProgress?.({ stage: "checksum", percent: checksumStart, detail: "校验备份内容" });
    const files = await checksumInventoryForBackup(payloadDir, signal, (done, total) => {
      onProgress?.({ stage: "checksum", percent: Math.round(checksumStart + (type === "full" ? 8 : 20) * done / Math.max(total, 1)), detail: `校验文件 ${done}/${total}` });
    });
    const manifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion,
    minimumAppVersion: CURRENT_APP_VERSION,
    createdAt: new Date().toISOString(),
    type,
    platform,
    arch,
    containsSensitiveInformation: type === "full",
    requiresPassword: type === "full",
    mayRequireQqRescan: type !== "full",
    components: includeLogs && fs.existsSync(path.join(payloadDir, "diagnostic-logs")) ? [...DEFAULT_COMPONENTS, "diagnostic-logs"] : DEFAULT_COMPONENTS,
    redactedConfigFields: redactions,
    accounts: accountDefinitions(rawConfig).map((account) => ({
      id: String(account.id),
      role: account.role,
      protocol: "snowluma",
      container: protocolContainer(account),
      image: String(account.snowlumaImage || "motricseven7/snowluma:latest")
    })),
    dockerVolumes: docker.records,
    files,
    totalBytes: files.reduce((sum, item) => sum + item.size, 0)
    };
    writeJson(path.join(payloadDir, "manifest.json"), manifest);
    return { tempRoot, payloadDir, manifest };
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function packPayload(payloadDir, output, signal) {
  checkCancelled(signal);
  const result = await run("/usr/bin/tar", ["-czf", output, "-C", payloadDir, "."], { timeoutMs: 30 * 60_000, signal });
  if (signal?.aborted) throw new BackupCancelledError();
  if (!result.ok) throw new Error(`无法压缩备份：${result.stderr.trim() || result.error || result.code}`);
  fs.chmodSync(output, 0o600);
}

async function encryptFile(source, destination, password, signal) {
  checkCancelled(signal);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  await pipeline(fs.createReadStream(source), cipher, fs.createWriteStream(destination, { mode: 0o600 }), { signal });
  return { salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), kdf: "scrypt", cipher: "aes-256-gcm" };
}

async function decryptFile(source, destination, password, cryptoHeader, start) {
  const salt = Buffer.from(cryptoHeader.salt, "base64");
  const iv = Buffer.from(cryptoHeader.iv, "base64");
  const key = crypto.scryptSync(password, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(cryptoHeader.tag, "base64"));
  try {
    await pipeline(fs.createReadStream(source, { start }), decipher, fs.createWriteStream(destination, { mode: 0o600 }));
  } catch {
    throw new Error("备份密码错误，或备份文件已经损坏");
  }
}

async function writeContainer(destination, header, bodyFile, signal) {
  checkCancelled(signal);
  const headerBuffer = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(headerBuffer.length, 0);
  await fs.promises.writeFile(destination, Buffer.concat([BACKUP_MAGIC, length, headerBuffer]), { mode: 0o600 });
  await pipeline(fs.createReadStream(bodyFile), fs.createWriteStream(destination, { flags: "a" }), { signal });
}

function readContainerHeader(file) {
  const fd = fs.openSync(file, "r");
  try {
    const magic = Buffer.alloc(BACKUP_MAGIC.length);
    fs.readSync(fd, magic, 0, magic.length, 0);
    if (!magic.equals(BACKUP_MAGIC)) throw new Error("不是有效的 Hermes QQ Bot 备份文件");
    const lengthBuffer = Buffer.alloc(4);
    fs.readSync(fd, lengthBuffer, 0, 4, BACKUP_MAGIC.length);
    const length = lengthBuffer.readUInt32BE(0);
    if (!length || length > 1024 * 1024) throw new Error("备份文件头无效");
    const headerBuffer = Buffer.alloc(length);
    fs.readSync(fd, headerBuffer, 0, length, BACKUP_MAGIC.length + 4);
    const header = JSON.parse(headerBuffer.toString("utf8"));
    return { header, bodyOffset: BACKUP_MAGIC.length + 4 + length };
  } finally {
    fs.closeSync(fd);
  }
}

async function extractContainer({ file, password = "" }) {
  const { header, bodyOffset } = readContainerHeader(file);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-restore-"));
  fs.chmodSync(tempRoot, 0o700);
  try {
    const archive = path.join(tempRoot, "payload.tgz");
    if (header.encrypted) {
      if (!password) throw new Error("这个完整迁移包需要密码");
      await decryptFile(file, archive, password, header.crypto, bodyOffset);
    } else {
      const output = fs.createWriteStream(archive, { mode: 0o600 });
      await pipeline(fs.createReadStream(file, { start: bodyOffset }), output);
    }
    const payloadDir = path.join(tempRoot, "payload");
    ensureDir(payloadDir);
    const allowedRoots = new Set(["manifest.json", "state", "docker", "protocol-host", "hermes-home", "diagnostic-logs"]);
    await tar.t({ file: archive, gzip: true, strict: true, onReadEntry(entry) {
      const name = String(entry.path || "").replace(/^\.\//, "").replace(/\/$/, "");
      if (!name || name === ".") return;
      const parts = name.split("/");
      if (path.posix.isAbsolute(name) || parts.includes("..") || parts.includes("") || !allowedRoots.has(parts[0])) throw new Error(`备份包含不安全路径：${name}`);
      if (entry.type !== "File" && entry.type !== "Directory") throw new Error(`备份包含不支持的文件类型：${name}`);
    } });
    await tar.x({ cwd: payloadDir, file: archive, gzip: true, strict: true, preservePaths: false });
    const actual = walkFiles(payloadDir);
    const manifest = readJson(path.join(payloadDir, "manifest.json"));
    if (!manifest || manifest.formatVersion !== BACKUP_FORMAT_VERSION || !Array.isArray(manifest.files)) throw new Error("备份格式版本不受支持");
    if (!versionAtLeast(CURRENT_APP_VERSION, manifest.minimumAppVersion)) throw new Error("备份需要更新版本的 Hermes QQ Bot");
    if (!(["safe", "full"].includes(manifest.type)) || Boolean(header.encrypted) !== (manifest.type === "full")) throw new Error("备份类型与加密标记不一致");
    if (manifest.type === "full" && (manifest.platform !== "darwin" || manifest.arch !== "arm64")) throw new Error("完整迁移包仅支持 Apple 芯片 Mac");
    const validPayloadPath = (value) => {
      const parts = String(value || "").split("/");
      if (parts[0] === "state") return parts[1] === "config.json" && parts.length === 2 || parts[1] === "data" && parts.length >= 3;
      if (manifest.type !== "full") return false;
      if (parts[0] === "protocol-host") return parts.length >= 3 && shouldCopyProtocolHost(parts[1]);
      if (parts[0] === "hermes-home") return parts.length >= 2 && HERMES_PROFILE_FILES.has(parts[1]);
      if (parts[0] === "docker") return parts.length === 3 && /^[A-Za-z0-9_.-]+$/.test(parts[1]) && /^(snowlumaData|appConfig|localShare)\.tgz$/.test(parts[2]);
      if (parts[0] === "diagnostic-logs") return parts.length >= 2 && manifest.components?.includes("diagnostic-logs");
      return false;
    };
    if (manifest.files.some((item) => !validPayloadPath(item.path))) throw new Error("备份包含未知组件或文件");
    if (!fs.existsSync(path.join(payloadDir, "state", "config.json"))) throw new Error("备份缺少配置文件");
    if (!Array.isArray(manifest.dockerVolumes) || manifest.dockerVolumes.some((item) => !validPayloadPath(item.archive) || !manifest.files.some((file) => file.path === item.archive))) throw new Error("Docker 卷清单无效");
    const expectedPaths = new Set(manifest.files.map((item) => item.path));
    if (expectedPaths.size !== manifest.files.length || actual.length !== manifest.files.length + 1 || actual.some((item) => item.path !== "manifest.json" && !expectedPaths.has(item.path))) throw new Error("备份文件清单不一致");
    for (const expected of manifest.files) {
      const resolved = path.resolve(payloadDir, expected.path);
      if (!resolved.startsWith(`${path.resolve(payloadDir)}${path.sep}`)) throw new Error(`备份包含越界路径：${expected.path}`);
      if (!fs.existsSync(resolved)) throw new Error(`备份缺少文件：${expected.path}`);
      const stat = fs.statSync(resolved);
      if (stat.size !== expected.size || hashFile(resolved) !== expected.sha256) throw new Error(`备份校验失败：${expected.path}`);
    }
    return { tempRoot, payloadDir, manifest, header };
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function createBackup(options = {}) {
  const type = options.type === "full" ? "full" : "safe";
  if (options.includeLogs && type !== "full") throw new Error("诊断日志可能包含敏感信息，只能加入加密的完整迁移备份");
  if (type === "full" && !String(options.password || "")) throw new Error("完整迁移备份必须设置密码");
  const stateRoot = path.resolve(options.stateRoot);
  const destinationDir = path.resolve(options.destinationDir);
  ensureDir(destinationDir);
  const name = `Hermes-QQ-Bot-${type}-${timestamp()}.hermesqqbackup`;
  const destination = path.join(destinationDir, name);
  const signal = options.signal;
  const onProgress = options.onProgress;
  let built;
  try {
    checkCancelled(signal);
    built = await buildPayload({
      stateRoot,
      hermesHome: options.hermesHome ? path.resolve(options.hermesHome) : "",
      logRoot: options.logRoot ? path.resolve(options.logRoot) : "",
      includeLogs: Boolean(options.includeLogs),
      type,
      appVersion: options.appVersion || CURRENT_APP_VERSION,
      platform: options.platform || process.platform,
      arch: options.arch || process.arch,
      signal,
      onProgress
    });
    const packed = path.join(built.tempRoot, "payload.tgz");
    onProgress?.({ stage: "compress", percent: type === "full" ? 78 : 55, detail: "压缩备份数据" });
    await packPayload(built.payloadDir, packed, signal);
    checkCancelled(signal);
    let body = packed;
    let cryptoHeader = null;
    if (type === "full") {
      onProgress?.({ stage: "encrypt", percent: 88, detail: "加密完整迁移包" });
      body = path.join(built.tempRoot, "payload.enc");
      cryptoHeader = await encryptFile(packed, body, String(options.password), signal);
    }
    checkCancelled(signal);
    onProgress?.({ stage: "write", percent: 96, detail: "写入备份文件" });
    await writeContainer(destination, {
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion: options.appVersion || CURRENT_APP_VERSION,
      createdAt: built.manifest.createdAt,
      type,
      encrypted: type === "full",
      crypto: cryptoHeader
    }, body, signal);
    checkCancelled(signal);
    onProgress?.({ stage: "finalize", percent: 98, detail: "备份文件已写入" });
    return { ok: true, path: destination, size: fs.statSync(destination).size, manifest: built.manifest };
  } catch (error) {
    fs.rmSync(destination, { force: true });
    if (error instanceof BackupCancelledError || error?.name === "AbortError") throw new BackupCancelledError();
    throw error;
  } finally {
    if (built?.tempRoot) fs.rmSync(built.tempRoot, { recursive: true, force: true });
  }
}

export async function inspectBackup(options = {}) {
  const extracted = await extractContainer({ file: path.resolve(options.path), password: options.password || "" });
  try {
    return { ok: true, manifest: extracted.manifest, header: extracted.header };
  } finally {
    fs.rmSync(extracted.tempRoot, { recursive: true, force: true });
  }
}

async function restoreDockerVolumes({ payloadDir, manifest, config }) {
  const byAccount = new Map();
  const createdVolumes = [];
  const restoreId = crypto.randomBytes(5).toString("hex");
  try {
  for (const record of manifest.dockerVolumes || []) {
    const accountId = safeSegment(record.accountId, "primary");
    if (!new Set(["snowlumaData", "appConfig", "localShare"]).has(record.key)) throw new Error("备份包含未知 Docker 卷类型");
    const volumeName = `hermes-qq-bot-${accountId}-${safeSegment(record.key)}-${restoreId}`;
    const create = await run("docker", ["volume", "create", volumeName], { timeoutMs: 30_000 });
    if (!create.ok) throw new Error(`无法创建 Docker 卷 ${volumeName}: ${create.stderr.trim()}`);
    createdVolumes.push(volumeName);
    const archive = path.resolve(payloadDir, record.archive);
    const image = String(record.image || "motricseven7/snowluma:latest");
    const input = fs.createReadStream(archive);
    const restore = await run("docker", ["run", "--rm", "-i", "-v", `${volumeName}:/target`, "--entrypoint", "sh", image, "-lc", "tar -xzf - -C /target"], { stdin: input, timeoutMs: 10 * 60_000 });
    if (!restore.ok) throw new Error(`无法恢复 Docker 卷 ${volumeName}: ${restore.stderr.trim()}`);
    const volumes = byAccount.get(accountId) || {};
    volumes[record.key] = volumeName;
    byAccount.set(accountId, volumes);
  }
  const all = [config.accounts?.primary, ...(config.accounts?.standbys || [])].filter(Boolean);
  for (const account of all) {
    const id = safeSegment(account.id || (account === config.accounts?.primary ? "primary" : "standby"));
    if (byAccount.has(id)) account.snowlumaVolumes = byAccount.get(id);
  }
  return { byAccount, createdVolumes };
  } catch (error) {
    for (const volume of createdVolumes) await run("docker", ["volume", "rm", volume], { timeoutMs: 30_000 });
    throw error;
  }
}

function replaceFromStage({ stateRoot, payloadDir, full, hermesHome }) {
  ensureDir(stateRoot);
  const rollbackDir = path.join(path.dirname(stateRoot), `.Hermes QQ Bot rollback ${timestamp()}`);
  ensureDir(rollbackDir);
  const incomingDir = fs.mkdtempSync(path.join(path.dirname(stateRoot), ".hermesqq-incoming-"));
  const targets = ["config.json", "data"];
  if (full && fs.existsSync(path.join(payloadDir, "protocol-host"))) {
    for (const name of fs.readdirSync(path.join(payloadDir, "protocol-host"))) targets.push(name);
  }
  const moved = [];
  const installed = [];
  try {
    for (const name of targets) copyPath(path.join(payloadDir, name === "config.json" || name === "data" ? "state" : "protocol-host", name), path.join(incomingDir, name));
    if (full && hermesHome && fs.existsSync(path.join(payloadDir, "hermes-home"))) {
      if (path.resolve(hermesHome) !== path.join(stateRoot, "hermes")) throw new Error("Hermes 配置目录不在应用数据目录内");
      copyPath(path.join(payloadDir, "hermes-home"), path.join(incomingDir, "hermes"));
      targets.push("hermes");
    }
    for (const name of targets) {
      const current = path.join(stateRoot, name);
      if (!fs.existsSync(current)) continue;
      const rollback = path.join(rollbackDir, name);
      ensureDir(path.dirname(rollback));
      fs.renameSync(current, rollback);
      moved.push({ current, rollback });
    }
    for (const name of targets) {
      const source = path.join(incomingDir, name);
      if (!fs.existsSync(source)) continue;
      const current = path.join(stateRoot, name);
      fs.renameSync(source, current);
      installed.push(current);
    }
    return { rollbackDir, moved, installedTargets: installed.map((item) => path.basename(item)) };
  } catch (error) {
    for (const current of installed) fs.rmSync(current, { recursive: true, force: true });
    for (const item of moved.reverse()) {
      fs.renameSync(item.rollback, item.current);
    }
    throw error;
  } finally {
    fs.rmSync(incomingDir, { recursive: true, force: true });
  }
}

async function parkContainers(config) {
  const parked = [];
  try {
    for (const account of accountDefinitions(config)) {
      const container = protocolContainer(account);
      let inspect;
      try { inspect = await dockerInspect(container); } catch { continue; }
      const oldName = `${container}-rollback-${crypto.randomBytes(4).toString("hex")}`;
      if (inspect.State?.Running) {
        const stopped = await run("docker", ["stop", "-t", "15", container], { timeoutMs: 30_000 });
        if (!stopped.ok) throw new Error(`无法停止旧容器 ${container}`);
      }
      const renamed = await run("docker", ["rename", container, oldName], { timeoutMs: 30_000 });
      if (!renamed.ok) throw new Error(`无法保留旧容器 ${container}: ${renamed.stderr.trim()}`);
      parked.push({ container, oldName, wasRunning: Boolean(inspect.State?.Running) });
    }
    return parked;
  } catch (error) {
    await rollbackRestoredContainers(parked);
    throw error;
  }
}

export async function rollbackRestoredContainers(parked = []) {
  for (const item of [...parked].reverse()) {
    const current = await run("docker", ["inspect", item.container], { timeoutMs: 15_000 });
    if (current.ok) await run("docker", ["rm", "-f", item.container], { timeoutMs: 30_000 });
    const rename = await run("docker", ["rename", item.oldName, item.container], { timeoutMs: 30_000 });
    if (!rename.ok) throw new Error(`无法恢复旧容器 ${item.container}: ${rename.stderr.trim()}`);
    if (item.wasRunning) await run("docker", ["start", item.container], { timeoutMs: 30_000 });
  }
}

export async function rollbackRestore({ stateRoot, rollbackDir, installedTargets = [], parkedContainers = [], restoredVolumes = [] }) {
  const target = path.resolve(stateRoot);
  const saved = path.resolve(rollbackDir);
  if (path.dirname(saved) !== path.dirname(target) || !path.basename(saved).startsWith(".Hermes QQ Bot rollback ")) throw new Error("回滚目录无效");
  for (const name of installedTargets) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error("回滚目标无效");
    fs.rmSync(path.join(target, name), { recursive: true, force: true });
  }
  for (const name of fs.readdirSync(saved)) {
    const current = path.join(target, name);
    fs.rmSync(current, { recursive: true, force: true });
    fs.renameSync(path.join(saved, name), current);
  }
  await rollbackRestoredContainers(parkedContainers);
  for (const volume of restoredVolumes) await run("docker", ["volume", "rm", volume], { timeoutMs: 30_000 });
  return { ok: true };
}

export async function restoreBackup(options = {}) {
  const stateRoot = path.resolve(options.stateRoot);
  const extracted = await extractContainer({ file: path.resolve(options.path), password: options.password || "" });
  let parked = [];
  let restoredVolumes = [];
  try {
    const disk = fs.statfsSync(path.dirname(stateRoot));
    const available = Number(disk.bavail) * Number(disk.bsize);
    if (available < Number(extracted.manifest.totalBytes || 0) * 2) throw new Error("目标磁盘剩余空间不足以安全恢复并保留回滚数据");
    const stagedConfigPath = path.join(extracted.payloadDir, "state", "config.json");
    const config = localConfig(readJson(stagedConfigPath, {}), stateRoot, options.hermesHome ? path.resolve(options.hermesHome) : "");
    if (extracted.manifest.type === "full" && (extracted.manifest.dockerVolumes || []).length) {
      const restored = await restoreDockerVolumes({ payloadDir: extracted.payloadDir, manifest: extracted.manifest, config });
      restoredVolumes = restored.createdVolumes;
      parked = await parkContainers(config);
    }
    writeJson(stagedConfigPath, config);
    const result = replaceFromStage({ stateRoot, payloadDir: extracted.payloadDir, full: extracted.manifest.type === "full", hermesHome: options.hermesHome });
    return { ok: true, manifest: extracted.manifest, rollbackDir: result.rollbackDir, installedTargets: result.installedTargets, parkedContainers: parked, restoredVolumes };
  } catch (error) {
    if (parked.length) await rollbackRestoredContainers(parked);
    for (const volume of restoredVolumes) await run("docker", ["volume", "rm", volume], { timeoutMs: 30_000 });
    throw error;
  } finally {
    fs.rmSync(extracted.tempRoot, { recursive: true, force: true });
  }
}

export function listLocalBackups(directory) {
  const root = path.resolve(directory);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => name.endsWith(".hermesqqbackup"))
    .map((name) => {
      const full = path.join(root, name);
      const stat = fs.statSync(full);
      return { name, path: full, size: stat.size, modifiedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export function deleteLocalBackup(file, directory) {
  const root = path.resolve(directory);
  const target = path.resolve(file);
  if (!target.startsWith(`${root}${path.sep}`) || !target.endsWith(".hermesqqbackup")) throw new Error("只能删除默认备份目录中的迁移包");
  fs.rmSync(target, { force: true });
  return { ok: true };
}

export function inspectLegacyProject(projectRoot) {
  const root = path.resolve(projectRoot);
  const config = path.join(root, "config.json");
  const data = path.join(root, "data");
  if (!fs.existsSync(config) || !fs.existsSync(data)) throw new Error("所选目录不是有效的 Hermes QQ Bot 项目");
  return {
    ok: true,
    root,
    configPath: config,
    hasMemory: fs.existsSync(path.join(data, "memory.json")),
    hasArchive: fs.existsSync(path.join(data, "chat-archive")),
    protocolDirectories: fs.readdirSync(root).filter(shouldCopyProtocolHost)
  };
}

export async function migrateLegacyProject({ projectRoot, stateRoot, legacyHermesHome = "", hermesHome = "" }) {
  const legacy = inspectLegacyProject(projectRoot);
  const target = path.resolve(stateRoot);
  if (legacy.root === target) throw new Error("旧项目与目标目录相同");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-legacy-"));
  fs.chmodSync(tempRoot, 0o700);
  const payloadDir = path.join(tempRoot, "payload");
  ensureDir(payloadDir);
  let parked = [];
  let restoredVolumes = [];
  let replaced = null;
  let hermesProfileMigrated = false;
  const config = readJson(legacy.configPath);
  if (!config) throw new Error("旧项目配置无法解析");
  const rewrite = (value) => typeof value === "string"
    ? (value === "hermesqq2" ? "hermes" : value.split(legacy.root).join(target))
    : value;
  const visit = (value) => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return rewrite(value);
    const migrated = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    if (value.command === "hermesqq2" && Array.isArray(migrated.args) && !migrated.args.includes("-p")) {
      migrated.args = ["-p", "hermesqq2", ...migrated.args];
    }
    return migrated;
  };
  try {
    copyPath(legacy.configPath, path.join(payloadDir, "state", "config.json"));
    copyPath(path.join(legacy.root, "data"), path.join(payloadDir, "state", "data"));
    for (const name of legacy.protocolDirectories) copyPath(path.join(legacy.root, name), path.join(payloadDir, "protocol-host", name));
    hermesProfileMigrated = copyHermesProfile(legacyHermesHome, path.join(payloadDir, "hermes-home"));
    const accounts = accountDefinitions(config);
    let dockerVolumes = [];
    if (accounts.length) {
      const exported = await collectDockerState({ config, payloadDir });
      dockerVolumes = exported.records;
      const restored = await restoreDockerVolumes({ payloadDir, manifest: { dockerVolumes }, config });
      restoredVolumes = restored.createdVolumes;
      parked = await parkContainers(config);
    }
    writeJson(path.join(payloadDir, "state", "config.json"), visit(config));
    replaced = replaceFromStage({ stateRoot: target, payloadDir, full: true, hermesHome });
    return { ok: true, legacy, rollbackDir: replaced.rollbackDir, installedTargets: replaced.installedTargets, parkedContainers: parked, restoredVolumes, migratedDockerVolumes: dockerVolumes.length, hermesProfileMigrated, accounts: accounts.filter((account) => account.enabled !== false).map((account) => ({ id: account.id, container: protocolContainer(account), expectedQq: String(account.qq || "") })) };
  } catch (error) {
    if (replaced) await rollbackRestore({ stateRoot: target, rollbackDir: replaced.rollbackDir, installedTargets: replaced.installedTargets, parkedContainers: parked, restoredVolumes });
    else {
      if (parked.length) await rollbackRestoredContainers(parked);
      for (const volume of restoredVolumes) await run("docker", ["volume", "rm", volume], { timeoutMs: 30_000 });
    }
    throw error;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
