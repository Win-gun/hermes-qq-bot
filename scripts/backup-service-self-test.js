import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  BACKUP_MAGIC,
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

function tamperFullManifest(source, password, mutate, name) {
  const encoded = fs.readFileSync(source);
  const headerLength = encoded.readUInt32BE(BACKUP_MAGIC.length);
  const bodyOffset = BACKUP_MAGIC.length + 4 + headerLength;
  const header = JSON.parse(encoded.subarray(BACKUP_MAGIC.length + 4, bodyOffset).toString("utf8"));
  const oldKey = crypto.scryptSync(password, Buffer.from(header.crypto.salt, "base64"), 32,
    { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const decipher = crypto.createDecipheriv("aes-256-gcm", oldKey, Buffer.from(header.crypto.iv, "base64"));
  decipher.setAuthTag(Buffer.from(header.crypto.tag, "base64"));
  const archive = Buffer.concat([decipher.update(encoded.subarray(bodyOffset)), decipher.final()]);
  const fixture = path.join(root, name);
  fs.mkdirSync(fixture, { mode: 0o700 });
  const archiveFile = path.join(fixture, "payload.tgz");
  const payloadDir = path.join(fixture, "payload");
  fs.mkdirSync(payloadDir, { mode: 0o700 });
  fs.writeFileSync(archiveFile, archive, { mode: 0o600 });
  execFileSync("/usr/bin/tar", ["-xzf", archiveFile, "-C", payloadDir], { stdio: "ignore" });
  const manifestFile = path.join(payloadDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  mutate(manifest);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  execFileSync("/usr/bin/tar", ["-czf", archiveFile, "-C", payloadDir, "."], { stdio: "ignore" });
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(fs.readFileSync(archiveFile)), cipher.final()]);
  header.crypto = { ...header.crypto, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  const headerBuffer = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBuffer.length);
  const destination = path.join(fixture, "mutated.hermesqqbackup");
  fs.writeFileSync(destination, Buffer.concat([BACKUP_MAGIC, length, headerBuffer, encrypted]), { mode: 0o600 });
  return destination;
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
  if (process.platform === "darwin" && process.arch === "arm64") {
    // Full migration is intentionally rejected by the product on other platforms.
    const fullInfo = await inspectBackup({ path: full.path, password: "correct horse battery staple" });
    check(fullInfo.manifest.type === "full" && fullInfo.header.encrypted, "full backup must be encrypted");
    check(fullInfo.manifest.components.includes("diagnostic-logs") && fullInfo.manifest.files.some((item) => item.path === "diagnostic-logs/bridge.log"), "encrypted full backup must include optional logs");
    await restoreBackup({ path: full.path, password: "correct horse battery staple", stateRoot: fullRestore, hermesHome: path.join(fullRestore, "hermes") });
    const restoredFullConfig = JSON.parse(fs.readFileSync(path.join(fullRestore, "config.json"), "utf8"));
    check(restoredFullConfig.ai.directApiKey === config.ai.directApiKey, "full restore must retain secrets inside encrypted package");
    check(fs.readFileSync(path.join(fullRestore, "hermes", ".env"), "utf8").includes("DEEPSEEK_API_KEY"), "full restore must include app Hermes credentials");

    // Fake Keychain: no test touches the machine's real login keychain.
    let keychainValue = "previous-test-only-value";
    const voiceSecretStore = {
      getVoiceSecret: () => keychainValue,
      setVoiceSecret: (value) => { keychainValue = value; },
      deleteVoiceSecret: () => { keychainValue = null; }
    };
    config.voice = { credentialSource: "keychain", apiKeyEnv: "MIMO_API_KEY" };
    fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
    let missingKeychainRejected = false;
    try {
      await createBackup({ type: "full", password: "test-only-password", stateRoot: state, destinationDir: backups,
        voiceSecretStore: { getVoiceSecret: () => null } });
    } catch { missingKeychainRejected = true; }
    check(missingKeychainRejected, "full backup must reject missing configured Keychain secret");
    keychainValue = "backup-test-only-value";
    const voiceSafe = await createBackup({ type: "safe", stateRoot: state, destinationDir: backups, voiceSecretStore });
    check(!voiceSafe.manifest.files.some((item) => item.path.startsWith("voice-keychain/")), "safe backup must exclude Keychain secret");
    check(voiceSafe.manifest.voiceCredentialRequired === true, "safe backup must mark voice credential as requiring reconfiguration");
    const safeVoiceTarget = path.join(root, "safe-voice-restore");
    const safeVoiceRestored = await restoreBackup({ path: voiceSafe.path, stateRoot: safeVoiceTarget, voiceSecretStore });
    const safeVoiceConfig = JSON.parse(fs.readFileSync(path.join(safeVoiceTarget, "config.json"), "utf8"));
    check(safeVoiceRestored.voiceCredentialRequired && safeVoiceConfig.voice.enabled === false && safeVoiceConfig.voice.credentialSource === "existing", "safe restore must disable voice and avoid foreign Keychain items");
    check(keychainValue === "backup-test-only-value", "safe restore must not read or change Keychain item");
    const voiceFull = await createBackup({ type: "full", password: "test-only-password", stateRoot: state, hermesHome, destinationDir: backups, voiceSecretStore });
    check(voiceFull.manifest.components.includes("voice-keychain") && voiceFull.manifest.files.some((item) => item.path === "voice-keychain/secret"), "encrypted full backup must include Keychain component");
    keychainValue = "previous-test-only-value";
    const voiceTarget = path.join(root, "voice-restore");
    const voiceRestored = await restoreBackup({ path: voiceFull.path, password: "test-only-password", stateRoot: voiceTarget, hermesHome: path.join(voiceTarget, "hermes"), voiceSecretStore });
    check(keychainValue === "backup-test-only-value", "full restore must install Keychain secret");
    await rollbackRestore({ stateRoot: voiceTarget, rollbackDir: voiceRestored.rollbackDir, installedTargets: voiceRestored.installedTargets });
    check(keychainValue === "previous-test-only-value", "post-restore rollback must restore previous Keychain value");
    let rollbackActiveSecret = "previous-test-only-value";
    const rollbackFailStore = {
      getVoiceSecret: () => rollbackActiveSecret,
      setVoiceSecret: (value) => {
        if (value === "previous-test-only-value") throw new Error("simulated locked Keychain");
        rollbackActiveSecret = value;
      },
      deleteVoiceSecret: () => { rollbackActiveSecret = null; }
    };
    const rollbackFailTarget = path.join(root, "rollback-fail-voice-restore");
    const rollbackFailResult = await restoreBackup({ path: voiceFull.path, password: "test-only-password", stateRoot: rollbackFailTarget, hermesHome: path.join(rollbackFailTarget, "hermes"), voiceSecretStore: rollbackFailStore });
    let rollbackRejected = false;
    try { await rollbackRestore({ stateRoot: rollbackFailTarget, rollbackDir: rollbackFailResult.rollbackDir, installedTargets: rollbackFailResult.installedTargets }); }
    catch { rollbackRejected = true; }
    check(rollbackRejected && fs.existsSync(path.join(rollbackFailTarget, "config.json")) && rollbackActiveSecret === "backup-test-only-value", "failed Keychain rollback must leave restored config in place for fail-closed caller");
    let failedRestore = false;
    try {
      await restoreBackup({ path: voiceFull.path, password: "test-only-password", stateRoot: path.join(root, "failed-voice-restore"), hermesHome: path.join(root, "outside-hermes"), voiceSecretStore });
    } catch { failedRestore = true; }
    check(failedRestore && keychainValue === "previous-test-only-value", "failed restore must revert Keychain value");
    keychainValue = null;
    const emptyTarget = path.join(root, "empty-voice-restore");
    const emptyRestored = await restoreBackup({ path: voiceFull.path, password: "test-only-password", stateRoot: emptyTarget, hermesHome: path.join(emptyTarget, "hermes"), voiceSecretStore });
    await rollbackRestore({ stateRoot: emptyTarget, rollbackDir: emptyRestored.rollbackDir, installedTargets: emptyRestored.installedTargets });
    check(keychainValue === null, "rollback must delete new Keychain item when none existed before");
    keychainValue = "previous-test-only-value";
    await restoreBackup({ path: full.path, password: "correct horse battery staple", stateRoot: path.join(root, "old-full-restore"), hermesHome: path.join(root, "old-full-restore", "hermes"), voiceSecretStore });
    check(keychainValue === "previous-test-only-value", "old full backup without Keychain component must leave Keychain untouched");

    const apiRefA = "ec021717-671a-4c86-9ca0-c44265deee81";
    const apiRefB = "91b65f87-976e-4e74-9d8b-8fae04fe992c";
    const apiValues = new Map([[apiRefA, "backup-api-value-a"], [apiRefB, "backup-api-value-b"]]);
    const apiSecretStore = {
      getApiSecret: (ref) => apiValues.get(ref) ?? null,
      setApiSecret: (ref, secret) => { apiValues.set(ref, secret); },
      deleteApiSecret: (ref) => { apiValues.delete(ref); }
    };
    config.apiCenter = { connections: [
      { id: "a", credentialSource: "keychain", credentialRef: apiRefA, apiKeyEnv: "DEEPSEEK_API_KEY" },
      { id: "b", credentialSource: "keychain", credentialRef: apiRefB, apiKeyEnv: "MIMO_API_KEY" },
      { id: "legacy", credentialSource: "legacy-voice-keychain", apiKeyEnv: "MIMO_API_KEY" }
    ], profiles: [{ id: "api-asr", kind: "asr", connectionId: "b" }], bindings: { asr: "api-asr" } };
    config.voice.credentialSource = "existing";
    config.voice.enabled = true;
    config.ai.credentialSource = "keychain";
    config.ai.credentialRef = apiRefA;
    fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
    config.apiCenter.connections[0].credentialRef = "../invalid";
    fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
    let invalidRefRejected = false;
    try { await createBackup({ type: "safe", stateRoot: state, destinationDir: backups }); }
    catch { invalidRefRejected = true; }
    check(invalidRefRejected, "backup must reject unsafe API Keychain refs");
    config.apiCenter.connections[0].credentialRef = apiRefA;
    config.apiCenter.connections[1].apiKeyEnv = "not-an-environment-name";
    fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
    const apiSanitized = sanitizeConfigForBackup(config);
    check(apiSanitized.config.apiCenter.connections[0].credentialRef === apiRefA, "API refs must survive generic config sanitization before remapping");
    let missingApiRejected = false;
    try {
      await createBackup({ type: "full", password: "test-only-password", stateRoot: state, destinationDir: backups,
        voiceSecretStore, apiSecretStore: { getApiSecret: () => null } });
    } catch { missingApiRejected = true; }
    check(missingApiRejected, "full backup must reject missing API Keychain credentials");
    const apiSafe = await createBackup({ type: "safe", stateRoot: state, destinationDir: backups });
    check(apiSafe.manifest.apiCredentialReconfigurationRequired === true && apiSafe.manifest.apiKeychainRefs.length === 0,
      "safe backup must indicate API reconfiguration without listing old refs");
    check(!apiSafe.manifest.files.some((item) => item.path.startsWith("api-keychain/")), "safe backup must exclude API Keychain secrets");
    const apiSafeTarget = path.join(root, "api-safe-restore");
    const apiSafeResult = await restoreBackup({ path: apiSafe.path, stateRoot: apiSafeTarget, voiceSecretStore, apiSecretStore });
    const apiSafeConfig = JSON.parse(fs.readFileSync(path.join(apiSafeTarget, "config.json"), "utf8"));
    check(apiSafeResult.apiCredentialReconfigurationRequired === true, "safe restore must report API reconfiguration");
    check(apiSafeResult.voiceCredentialRequired === true && apiSafeConfig.voice.enabled === false,
      "safe restore must disable voice when its selected API connection has no backed-up Keychain secret");
    check(apiSafeConfig.apiCenter.connections[0].credentialRef !== apiRefA && apiSafeConfig.apiCenter.connections[1].credentialRef !== apiRefB,
      "safe restore must remap every API Keychain ref");
    check(apiSafeConfig.ai.credentialSource === "keychain"
      && apiSafeConfig.ai.credentialRef === apiSafeConfig.apiCenter.connections[0].credentialRef,
      "safe restore must keep projected API settings on the fresh fail-closed ref");
    check(apiSafeConfig.apiCenter.connections[0].credentialSource === "keychain"
      && apiSafeConfig.apiCenter.connections[2].credentialSource === "existing"
      && apiSafeConfig.apiCenter.connections[2].apiKeyEnv === "",
      "safe restore must keep API refs fail-closed and disable legacy voice Keychain use");
    check(apiSafeConfig.apiCenter.connections[1].apiKeyEnv === "", "safe backup must remove malformed API env values");
    check(apiValues.get(apiRefA) === "backup-api-value-a", "safe restore must not touch API Keychain");
    const apiFull = await createBackup({ type: "full", password: "test-only-password", stateRoot: state,
      destinationDir: backups, voiceSecretStore, apiSecretStore });
    check(apiFull.manifest.components.includes("api-keychain") && apiFull.manifest.apiKeychainRefs.length === 2,
      "full encrypted backup must list API Keychain refs");
    const wrongRefs = tamperFullManifest(apiFull.path, "test-only-password",
      (manifest) => { manifest.apiKeychainRefs = [apiRefA]; }, "tampered-api-refs");
    let wrongRefsRejected = false;
    try { await inspectBackup({ path: wrongRefs, password: "test-only-password" }); }
    catch { wrongRefsRejected = true; }
    check(wrongRefsRejected, "import must reject API manifest refs that do not match configured refs and files");
    const unsafePath = tamperFullManifest(apiFull.path, "test-only-password",
      (manifest) => { manifest.files.find((item) => item.path === `api-keychain/${apiRefA}`).path = "api-keychain/../unsafe"; }, "tampered-api-path");
    let unsafePathRejected = false;
    try { await inspectBackup({ path: unsafePath, password: "test-only-password" }); }
    catch { unsafePathRejected = true; }
    check(unsafePathRejected, "import must reject unsafe API Keychain manifest paths");
    apiValues.set(apiRefA, "previous-api-a");
    apiValues.delete(apiRefB);
    keychainValue = "previous-test-only-value";
    const apiTarget = path.join(root, "api-full-restore");
    const apiResult = await restoreBackup({ path: apiFull.path, password: "test-only-password", stateRoot: apiTarget,
      voiceSecretStore, apiSecretStore });
    check(apiValues.get(apiRefA) === "backup-api-value-a" && apiValues.get(apiRefB) === "backup-api-value-b"
      && keychainValue === "previous-test-only-value", "full restore must install both API refs and legacy voice secret");
    await rollbackRestore({ stateRoot: apiTarget, rollbackDir: apiResult.rollbackDir, installedTargets: apiResult.installedTargets });
    check(apiValues.get(apiRefA) === "previous-api-a" && !apiValues.has(apiRefB) && keychainValue === "previous-test-only-value",
      "rollback must restore all previous API refs and delete newly created ones");
    const apiRollbackFailStore = {
      getApiSecret: apiSecretStore.getApiSecret,
      setApiSecret: (ref, secret) => {
        if (ref === apiRefA && secret === "previous-api-a") throw new Error("simulated locked Keychain");
        apiValues.set(ref, secret);
      },
      deleteApiSecret: apiSecretStore.deleteApiSecret
    };
    const apiRollbackFailTarget = path.join(root, "failed-api-rollback");
    const apiRollbackFailResult = await restoreBackup({ path: apiFull.path, password: "test-only-password",
      stateRoot: apiRollbackFailTarget, voiceSecretStore, apiSecretStore: apiRollbackFailStore });
    let apiRollbackRejected = false;
    try { await rollbackRestore({ stateRoot: apiRollbackFailTarget, rollbackDir: apiRollbackFailResult.rollbackDir,
      installedTargets: apiRollbackFailResult.installedTargets }); }
    catch { apiRollbackRejected = true; }
    check(apiRollbackRejected && fs.existsSync(path.join(apiRollbackFailTarget, "config.json"))
      && apiValues.get(apiRefA) === "backup-api-value-a" && apiValues.get(apiRefB) === "backup-api-value-b",
      "failed multi-ref rollback must retain restored config and best-effort reapply its API credentials");
    apiValues.set(apiRefA, "previous-api-a");
    apiValues.delete(apiRefB);
    const rejectingApiStore = {
      getApiSecret: apiSecretStore.getApiSecret,
      setApiSecret: (ref, secret) => {
        if (ref === apiRefB) throw new Error("simulated locked Keychain");
        apiValues.set(ref, secret);
      },
      deleteApiSecret: apiSecretStore.deleteApiSecret
    };
    let apiRestoreRejected = false;
    try {
      await restoreBackup({ path: apiFull.path, password: "test-only-password", stateRoot: path.join(root, "failed-api-restore"),
        voiceSecretStore, apiSecretStore: rejectingApiStore });
    } catch { apiRestoreRejected = true; }
    check(apiRestoreRejected && apiValues.get(apiRefA) === "previous-api-a" && !apiValues.has(apiRefB),
      "partial Keychain restore failure must roll back every changed API ref");
    apiValues.set(apiRefB, "backup-api-value-b");
    delete config.voice;
    fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
    const legacyOnlyFull = await createBackup({ type: "full", password: "test-only-password", stateRoot: state,
      destinationDir: backups, voiceSecretStore, apiSecretStore });
    check(legacyOnlyFull.manifest.components.includes("voice-keychain"),
      "legacy API Center voice connection must retain voice-only full backup compatibility");
    const legacyOnlySafe = await createBackup({ type: "safe", stateRoot: state, destinationDir: backups });
    const legacyOnlyTarget = path.join(root, "legacy-only-safe-restore");
    const legacyOnlyResult = await restoreBackup({ path: legacyOnlySafe.path, stateRoot: legacyOnlyTarget,
      voiceSecretStore, apiSecretStore });
    const legacyOnlyConfig = JSON.parse(fs.readFileSync(path.join(legacyOnlyTarget, "config.json"), "utf8"));
    check(legacyOnlyResult.voiceCredentialRequired === true
      && legacyOnlyConfig.apiCenter.connections[2].credentialSource === "existing"
      && legacyOnlyConfig.apiCenter.connections[2].apiKeyEnv === ""
      && legacyOnlyConfig.voice.enabled === false,
      "legacy-only safe restore must not use target voice Keychain item");
    delete config.apiCenter;
    delete config.ai.credentialSource;
    delete config.ai.credentialRef;
    fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
  }

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
