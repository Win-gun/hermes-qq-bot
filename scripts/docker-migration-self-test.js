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
    { id: "alpha" }, { id: "paused-bot", enabled: false }, { id: "third" },
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
      State: { Running: true }, Config: { Image: "fixture:only" },
      Mounts: Object.entries(destinations).map(([key, Destination]) => ({ Type: "volume", Name: item.snowlumaVolumes[key], Destination }))
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

  const backup = await createBackup(options);
  check(backup.manifest.accounts.length === items.length, "manifest must list every account including external and archived");
  check(backup.manifest.dockerVolumes.length === 18, "backup must preserve paused, protocol-off, archived and orphan volumes");
  check(backup.manifest.accountRegistry.failoverGroups[0].memberIds.join(",") === "alpha,paused-bot", "manifest must preserve group membership order");
  check(!JSON.stringify(readFixture().calls).includes("existing-external") && !JSON.stringify(readFixture().calls).includes("must-not-be-touched"), "external accounts and stale projections must never operate Docker");
  check(backup.manifest.dockerVolumes.every((record) => record.volume.startsWith("existing-")), "manifest must retain source volume names");

  const restored = await restoreBackup({ path: backup.path, password: options.password, stateRoot: destination });
  check(restored.restoredVolumes.length === 18 && restored.parkedContainers.length === 5, "all existing managed accounts must be staged for rollback");
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
    }
  }
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
