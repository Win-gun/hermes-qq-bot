import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createBackup,
  inspectBackup,
  restoreBackup,
  rollbackRestore,
  migrateLegacyProject,
  sanitizeConfigForBackup
} from "../src/backup-service.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-backup-test-"));
const state = path.join(root, "state");
const safeRestore = path.join(root, "safe-restore");
const fullRestore = path.join(root, "full-restore");
const backups = path.join(root, "backups");
const hermesHome = path.join(root, "hermes");
const logRoot = path.join(root, "logs");
let tests = 0;

function check(condition, message) {
  tests += 1;
  if (!condition) throw new Error(message);
}

try {
  fs.mkdirSync(path.join(state, "data", "chat-archive", "groups", "123"), { recursive: true });
  fs.mkdirSync(path.join(state, "data", "tasks", "task_1", "outputs"), { recursive: true });
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.mkdirSync(logRoot, { recursive: true });
  fs.writeFileSync(path.join(logRoot, "bridge.log"), "diagnostic sample\n");
  const config = {
    ai: { command: "hermesqq2", args: ["-m", "deepseek-v4-flash", "--provider", "deepseek", "-z"], provider: "deepseek", model: "deepseek-v4-flash", apiKeyEnv: "DEEPSEEK_API_KEY", directApiKey: "FAKE_CREDENTIAL_FOR_TESTS" },
    prompt: { system: "保持原有风格" },
    taskMode: { workspaceBaseDir: path.join(state, "data", "tasks") },
    accounts: { primary: { id: "primary", protocol: "napcat", token: "sensitive-token-value-abcdefghijklmnopqrstuvwxyz" }, standbys: [] }
  };
  fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(state, "data", "memory.json"), JSON.stringify({ groups: { 123: { users: { 42: { nickname: "测试" } } } } }));
  fs.writeFileSync(path.join(state, "data", "chat-archive", "groups", "123", "messages.jsonl"), '{"text":"hello"}\n');
  fs.writeFileSync(path.join(state, "data", "tasks", "task_1", "outputs", "report.md"), "# report\n");
  fs.writeFileSync(path.join(hermesHome, ".env"), "DEEPSEEK_API_KEY=secret\n");
  fs.mkdirSync(path.join(hermesHome, "skills"), { recursive: true });
  fs.mkdirSync(path.join(root, "external-skill"), { recursive: true });
  fs.symlinkSync(path.join(root, "external-skill"), path.join(hermesHome, "skills", "external-skill"));
  fs.mkdirSync(path.join(hermesHome, "profiles", "hermesqq2", "lsp", "bin"), { recursive: true });
  fs.symlinkSync("/usr/bin/true", path.join(hermesHome, "profiles", "hermesqq2", "lsp", "bin", "tool"));

  const sanitized = sanitizeConfigForBackup(config);
  check(sanitized.config.ai.apiKeyEnv === "DEEPSEEK_API_KEY", "environment variable name must be retained");
  check(sanitized.config.ai.directApiKey === "", "direct API key must be redacted");
  check(sanitized.config.accounts.primary.token === "", "account token must be redacted");

  const safe = await createBackup({ type: "safe", stateRoot: state, hermesHome, destinationDir: backups, appVersion: "test" });
  check(fs.existsSync(safe.path), "safe backup must exist");
  const safeInfo = await inspectBackup({ path: safe.path });
  check(safeInfo.manifest.type === "safe" && !safeInfo.manifest.containsSensitiveInformation, "safe manifest flags must be correct");
  check(!safeInfo.manifest.files.some((item) => item.path.startsWith("diagnostic-logs/")), "safe backup must exclude diagnostic logs");
  let unsafeLogsRejected = false;
  try { await createBackup({ type: "safe", includeLogs: true, stateRoot: state, logRoot, destinationDir: backups }); } catch { unsafeLogsRejected = true; }
  check(unsafeLogsRejected, "unencrypted backup must reject diagnostic logs");
  const safeResult = await restoreBackup({ path: safe.path, stateRoot: safeRestore, hermesHome: path.join(safeRestore, "hermes") });
  const restoredSafeConfig = JSON.parse(fs.readFileSync(path.join(safeRestore, "config.json"), "utf8"));
  check(restoredSafeConfig.ai.directApiKey === "", "safe restore must stay sanitized");
  check(restoredSafeConfig.taskMode.workspaceBaseDir === path.join(safeRestore, "data", "tasks"), `safe restore must rewrite state paths for the new computer (got ${restoredSafeConfig.taskMode.workspaceBaseDir})`);
  check(fs.existsSync(path.join(safeRestore, "data", "memory.json")), "safe restore must include memory");
  check(!fs.existsSync(path.join(safeRestore, "hermes", ".env")), "safe backup must exclude Hermes secret files");
  await rollbackRestore({ stateRoot: safeRestore, rollbackDir: safeResult.rollbackDir, installedTargets: safeResult.installedTargets });
  check(!fs.existsSync(path.join(safeRestore, "config.json")), "rollback must remove newly installed config when no previous config existed");

  const progress = [];
  const full = await createBackup({ type: "full", password: "correct horse battery staple", includeLogs: true, stateRoot: state, hermesHome, logRoot, destinationDir: backups, appVersion: "test", onProgress: (item) => progress.push(item) });
  check(fs.existsSync(full.path), "full backup must exist");
  check(progress[0]?.stage === "copy" && progress.at(-1)?.percent === 98, "full backup must report bounded progress through file finalization");
  check(!full.manifest.files.some((item) => item.path.includes("external-skill") || item.path.includes("/lsp/")), "full backup must skip nonportable Hermes symlinks and generated LSP files");
  let wrongPasswordRejected = false;
  try { await inspectBackup({ path: full.path, password: "wrong" }); } catch { wrongPasswordRejected = true; }
  check(wrongPasswordRejected, "wrong password must be rejected");
  const fullInfo = await inspectBackup({ path: full.path, password: "correct horse battery staple" });
  check(fullInfo.manifest.type === "full" && fullInfo.header.encrypted, "full backup must be encrypted");
  check(fullInfo.manifest.components.includes("diagnostic-logs") && fullInfo.manifest.files.some((item) => item.path === "diagnostic-logs/bridge.log"), "encrypted full backup must include optional logs");
  await restoreBackup({ path: full.path, password: "correct horse battery staple", stateRoot: fullRestore, hermesHome: path.join(fullRestore, "hermes") });
  const restoredFullConfig = JSON.parse(fs.readFileSync(path.join(fullRestore, "config.json"), "utf8"));
  check(restoredFullConfig.ai.directApiKey === config.ai.directApiKey, "full restore must retain secrets inside encrypted package");
  check(fs.readFileSync(path.join(fullRestore, "hermes", ".env"), "utf8").includes("DEEPSEEK_API_KEY"), "full restore must include app Hermes credentials");

  const beforeCancelled = fs.readdirSync(backups).length;
  const controller = new AbortController();
  let cancelled = false;
  try {
    await createBackup({ type: "full", password: "test cancel", stateRoot: state, hermesHome, destinationDir: backups, signal: controller.signal, onProgress: (item) => { if (item.stage === "checksum") controller.abort(); } });
  } catch (error) { cancelled = error.name === "BackupCancelledError"; }
  check(cancelled, "cancel must report BackupCancelledError");
  check(fs.readdirSync(backups).length === beforeCancelled, "cancel must not leave a partial backup file");

  const broken = path.join(backups, "broken.hermesqqbackup");
  fs.writeFileSync(broken, "not-a-backup");
  let brokenRejected = false;
  try { await inspectBackup({ path: broken }); } catch { brokenRejected = true; }
  check(brokenRejected, "invalid container must be rejected");

  const legacyTarget = path.join(root, "legacy-target");
  const migrated = await migrateLegacyProject({ projectRoot: state, stateRoot: legacyTarget, legacyHermesHome: hermesHome, hermesHome: path.join(legacyTarget, "hermes") });
  check(migrated.ok && migrated.migratedDockerVolumes === 0, "legacy migration without SnowLuma must succeed");
  check(JSON.parse(fs.readFileSync(path.join(legacyTarget, "config.json"), "utf8")).prompt.system === "保持原有风格", "migration must preserve prompt");
  const migratedConfig = JSON.parse(fs.readFileSync(path.join(legacyTarget, "config.json"), "utf8"));
  check(migratedConfig.ai.command === "hermes" && migratedConfig.ai.args[0] === "-p" && migratedConfig.ai.args[1] === "hermesqq2", "migration must preserve the legacy Hermes profile");
  check(fs.existsSync(path.join(legacyTarget, "data", "chat-archive", "groups", "123", "messages.jsonl")), "migration must preserve chat archive");
  check(migrated.hermesProfileMigrated && fs.existsSync(path.join(legacyTarget, "hermes", ".env")), "migration must copy Hermes profile into app state");

  console.log(JSON.stringify({ ok: true, tests, safe: path.basename(safe.path), full: path.basename(full.path) }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
