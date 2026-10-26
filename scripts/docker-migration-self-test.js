#!/usr/bin/env node
// Fixture-only Docker emulator: this test never talks to a Docker daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { registryConfig } from "../src/account-registry.js";
import { createBackup, restoreBackup, rollbackRestore, migrateLegacyProject } from "../src/backup-service.js";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-docker-fixture-"));
const state = path.join(temp, "source");
const destination = path.join(temp, "destination");
const fixturePath = path.join(temp, "docker-state.json");
const originalPath = process.env.PATH;
const originalFixture = process.env.HERMES_QQ_DOCKER_FIXTURE;
const destinations = { snowlumaData: "/app/snowluma-data", appConfig: "/app/.config", localShare: "/app/.local/share" };
const imagePin = `fixture/snowluma:2.1.1@sha256:${"2".repeat(64)}`;
const readFixture = () => JSON.parse(fs.readFileSync(fixturePath, "utf8"));
let tests = 0;
function check(value, message) { tests += 1; assert.ok(value, message); }

try {
  fs.mkdirSync(path.join(state, "data"), { recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(state, "data", "memory.json"), '{"groups":{}}');
  fs.writeFileSync(path.join(destination, "config.json"), '{"sentinel":"old"}');
  // Unsupported commands fail closed, never falling through to real Docker.
  fs.writeFileSync(path.join(temp, "docker"), `#!${process.execPath}
const fs = require("node:fs");
const file = process.env.HERMES_QQ_DOCKER_FIXTURE;
if (!file) process.exit(90);
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const fail = () => { save(); process.exit(1); };
const name = args.at(-1);
if (args[0] === "inspect") {
  if (!state.containers[name]) fail();
  process.stdout.write(JSON.stringify([state.containers[name]]));
} else if (["stop", "start"].includes(args[0])) {
  if (!state.containers[name]) fail();
  state.containers[name].State.Running = args[0] === "start";
} else if (args[0] === "rename") {
  if (!state.containers[args[1]] || state.containers[args[2]]) fail();
  state.containers[args[2]] = state.containers[args[1]];
  delete state.containers[args[1]];
} else if (args[0] === "volume" && args[1] === "create") {
  state.volumes[name] ??= "";
  process.stdout.write(name);
} else if (args[0] === "volume" && args[1] === "rm") {
  delete state.volumes[name];
} else if (args[0] === "run" && args.includes("-v")) {
  const mount = args[args.indexOf("-v") + 1];
  const volume = mount.split(":")[0];
  if (!Object.hasOwn(state.volumes, volume)) fail();
  if (mount.endsWith(":/source:ro")) process.stdout.write(Buffer.from(state.volumes[volume], "base64"));
  else if (mount.endsWith(":/target") && args.includes("-i")) state.volumes[volume] = fs.readFileSync(0).toString("base64");
  else fail();
} else if (args[0] === "rm" && args[1] === "-f") delete state.containers[name];
else fail();
save();
`, { mode: 0o700 });
  process.env.PATH = `${temp}${path.delimiter}${originalPath || ""}`;
  process.env.HERMES_QQ_DOCKER_FIXTURE = fixturePath;

  const items = [
    { id: "alpha", snowlumaImage: imagePin }, { id: "paused-bot", enabled: false }, { id: "third" },
    { id: "archived", archived: true }, { id: "protocol-off", protocolEnabled: false },
    { id: "external", managed: false }, { id: "orphan", archived: true }
  ].map((item) => ({ protocol: "snowluma", protocolContainer: `existing-${item.id}`, ...item,
    snowlumaVolumes: Object.fromEntries(Object.keys(destinations).map((key) => [key, `existing-${item.id}-${key}`])) }));
  const config = { bot: { enabled: false }, accounts: { version: 2, items,
    primary: { id: "stale-projection", protocol: "snowluma", protocolContainer: "must-not-be-touched" },
    failoverGroups: [{ id: "pair", name: "fixture group", memberIds: ["alpha", "paused-bot"], policyAccountId: "alpha", policy: { displayName: "shared" }, settings: {} }] } };
  fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
  const fixture = { containers: {}, volumes: {}, calls: [] };
  for (const item of items.filter((item) => item.managed !== false)) {
    for (const volume of Object.values(item.snowlumaVolumes)) fixture.volumes[volume] = Buffer.from(`fixture-volume:${volume}`).toString("base64");
    if (item.id !== "orphan") fixture.containers[item.protocolContainer] = {
      State: { Running: true }, Config: { Image: item.snowlumaImage || "fixture:only" },
      Mounts: [
        // 2.1.1 aliases the same gateway volume; other accounts retain the old layout.
        ...(item.id === "alpha" ? [{ Type: "volume", Name: item.snowlumaVolumes.snowlumaData, Destination: "/app/data" }] : []),
        ...Object.entries(destinations).map(([key, Destination]) => ({ Type: "volume", Name: item.snowlumaVolumes[key], Destination }))
      ]
    };
  }
  fs.writeFileSync(fixturePath, JSON.stringify(fixture));
  const options = { type: "full", password: "test-fixture-password", stateRoot: state, destinationDir: temp, platform: "darwin", arch: "arm64" };
  const controller = new AbortController();
  await assert.rejects(createBackup({ ...options, signal: controller.signal, onProgress: (item) => {
    if (item.stage === "docker" && item.detail.startsWith("已导出登录状态 1/")) controller.abort();
  } }), { name: "BackupCancelledError" });
  check(Object.values(readFixture().containers).every((item) => item.State.Running), "cancel must restart every previously running fixture container");
  check(!fs.readdirSync(temp).some((name) => name.endsWith(".hermesqqbackup")), "cancel must not leave a backup");

  const backupCallStart = readFixture().calls.length; // Exclude the cancelled export above.
  const backup = await createBackup(options);
  const exportCalls = readFixture().calls.slice(backupCallStart).filter((args) =>
    args[0] === "run" && args[args.indexOf("-v") + 1]?.endsWith(":/source:ro"));
  check(backup.manifest.accounts.length === items.length, "manifest must list every account including external and archived");
  check(backup.manifest.dockerVolumes.length === 18, "backup must preserve paused, protocol-off, archived and orphan volumes");
  check(backup.manifest.accountRegistry.failoverGroups[0].memberIds.join(",") === "alpha,paused-bot", "manifest must preserve group membership order");
  check(!JSON.stringify(readFixture().calls).includes("existing-external") && !JSON.stringify(readFixture().calls).includes("must-not-be-touched"), "external accounts and stale projections must never operate Docker");
  check(backup.manifest.dockerVolumes.every((record) => record.volume.startsWith("existing-")), "manifest must retain source volume names");
  check(backup.manifest.formatVersion === 1, "dual mounts must retain the existing backup format");
  check(exportCalls.length === 18, "dual-mounted gateway alias must not add an export command");
  for (const item of items.filter((item) => item.managed !== false)) {
    const records = backup.manifest.dockerVolumes.filter((record) => record.accountId === item.id);
    check(records.length === 3 && new Set(records.map((record) => record.key)).size === 3,
      `each managed account must retain exactly three logical volume records: ${item.id}`);
    check(records.every((record) => record.destination === destinations[record.key]),
      `new and old layouts must use the legacy-compatible destination manifest: ${item.id}`);
    for (const record of records) {
      const exports = exportCalls.filter((args) => args[args.indexOf("-v") + 1] === `${record.volume}:/source:ro`);
      check(exports.length === 1, `each source volume must be exported exactly once, including aliases: ${item.id}/${record.key}`);
      check(exports[0][exports[0].indexOf("--entrypoint") + 2] === record.image,
        `export must use the manifest image: ${item.id}/${record.key}`);
    }
  }
  check(backup.manifest.dockerVolumes.filter((record) => record.accountId === "alpha").every((record) => record.image === imagePin),
    "dual-mounted account must retain its image pin in all three volume records");

  const restoreCallStart = readFixture().calls.length;
  const restored = await restoreBackup({ path: backup.path, password: options.password, stateRoot: destination });
  const importCalls = readFixture().calls.slice(restoreCallStart).filter((args) =>
    args[0] === "run" && args.includes("-i") && args[args.indexOf("-v") + 1]?.endsWith(":/target"));
  check(restored.restoredVolumes.length === 18 && restored.parkedContainers.length === 5, "all existing managed accounts must be staged for rollback");
  check(importCalls.length === 18, "restore must import three logical volumes per managed account, not the alias");
  const restoredConfig = JSON.parse(fs.readFileSync(path.join(destination, "config.json"), "utf8"));
  for (const item of restoredConfig.accounts.items) {
    check(item.protocolContainer === `existing-${item.id}`, `stable transport identity must survive restore: ${item.id}`);
    if (item.managed === false) {
      check(item.snowlumaVolumes.snowlumaData === "existing-external-snowlumaData", "external transport must not be rewritten");
      continue;
    }
    for (const key of Object.keys(destinations)) {
      const volume = item.snowlumaVolumes[key];
      check(restored.restoredVolumes.includes(volume), `authoritative item volume must be rewritten: ${item.id}/${key}`);
      check(readFixture().volumes[volume] === fixture.volumes[`existing-${item.id}-${key}`], "fixture volume bytes must survive restore");
      const imports = importCalls.filter((args) => args[args.indexOf("-v") + 1] === `${volume}:/target`);
      const record = backup.manifest.dockerVolumes.find((record) => record.accountId === item.id && record.key === key);
      check(imports.length === 1 && imports[0][imports[0].indexOf("--entrypoint") + 2] === record.image,
        `restore must inherit the recorded image for each legacy-compatible volume: ${item.id}/${key}`);
    }
  }
  check(restoredConfig.accounts.items.find((item) => item.id === "alpha").snowlumaImage === imagePin
    && restoredConfig.accounts.primary.snowlumaImage === imagePin, "restore must preserve the image pin in the authoritative item and legacy projection");
  check(restoredConfig.accounts.primary.snowlumaVolumes.snowlumaData === restoredConfig.accounts.items[0].snowlumaVolumes.snowlumaData, "legacy projection must reflect rewritten items");
  check(restoredConfig.accounts.items.find((item) => item.id === "archived").archived, "restore must not unarchive accounts");
  check(restoredConfig.accounts.items.find((item) => item.id === "paused-bot").enabled === false, "restore must preserve bot pause independently of protocol state");
  check(JSON.stringify(restoredConfig.accounts.failoverGroups) === JSON.stringify(registryConfig(config).accounts.failoverGroups), "restore must preserve effective registry group policy and membership");
  await rollbackRestore({ stateRoot: destination, ...restored });
  check(JSON.parse(fs.readFileSync(path.join(destination, "config.json"), "utf8")).sentinel === "old", "rollback must restore prior config");
  check(Object.keys(readFixture().containers).sort().join() === Object.keys(fixture.containers).sort().join(), "rollback must return original container names");
  check(Object.values(readFixture().containers).every((item) => item.State.Running), "rollback must restart previous containers");
  check(Object.keys(readFixture().volumes).sort().join() === Object.keys(fixture.volumes).sort().join(), "rollback must remove only newly created volumes");

  // A pre-v2 config must migrate to items and rewrite its legacy projection.
  fs.writeFileSync(path.join(state, "config.json"), JSON.stringify({ accounts: {
    primary: { id: "alpha", protocol: "snowluma", protocolContainer: "existing-alpha" }, standbys: [] } }));
  const legacy = await migrateLegacyProject({ projectRoot: state, stateRoot: destination });
  const migratedConfig = JSON.parse(fs.readFileSync(path.join(destination, "config.json"), "utf8"));
  check(migratedConfig.accounts.version === 2 && migratedConfig.accounts.items[0].id === "alpha", "legacy config must become a v2 registry");
  check(migratedConfig.accounts.items[0].snowlumaVolumes.snowlumaData === migratedConfig.accounts.primary.snowlumaVolumes.snowlumaData, "legacy migration must rewrite canonical item and projection together");
  await rollbackRestore({ stateRoot: destination, ...legacy });
  console.log(JSON.stringify({ ok: true, fixtureOnly: true, tests, accounts: items.length, restoredVolumes: 18, rollback: true }));
} finally {
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  if (originalFixture === undefined) delete process.env.HERMES_QQ_DOCKER_FIXTURE; else process.env.HERMES_QQ_DOCKER_FIXTURE = originalFixture;
  fs.rmSync(temp, { recursive: true, force: true });
}
