#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createBackup, restoreBackup, rollbackRestore } from "../src/backup-service.js";

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr?.trim() || result.error?.message}`);
  return result.stdout.trim();
}

const id = crypto.randomBytes(5).toString("hex");
const container = `hermesqq-backup-test-${id}`;
const volumeNames = ["snowluma", "config", "share"].map((key) => `${container}-${key}`);
const mountPaths = ["/app/snowluma-data", "/app/.config", "/app/.local/share"];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-docker-backup-test-"));
const state = path.join(temp, "source");
const destination = path.join(temp, "destination");
try {
  docker(["image", "inspect", "alpine:3.20"]);
  fs.mkdirSync(path.join(state, "data"), { recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(state, "data", "memory.json"), '{"groups":{}}');
  fs.writeFileSync(path.join(destination, "config.json"), '{"sentinel":"old"}');
  fs.writeFileSync(path.join(temp, "marker.txt"), `volume-${id}\n`);
  const config = { accounts: { primary: { id: "primary", protocol: "snowluma", protocolContainer: container, snowlumaImage: "alpine:3.20" }, standbys: [] } };
  fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
  for (const volume of volumeNames) docker(["volume", "create", volume]);
  const mounts = volumeNames.flatMap((volume, index) => ["-v", `${volume}:${mountPaths[index]}`]);
  docker(["run", "-d", "--name", container, ...mounts, "alpine:3.20", "sleep", "120"]);
  docker(["cp", path.join(temp, "marker.txt"), `${container}:/app/snowluma-data/marker.txt`]);

  const controller = new AbortController();
  let cancelled = false;
  try {
    await createBackup({ type: "full", password: "test-only-password", stateRoot: state, destinationDir: temp, signal: controller.signal, onProgress: (item) => {
      if (item.stage === "docker" && item.detail === "已导出登录状态 1/3") controller.abort();
    } });
  } catch (error) { cancelled = error.name === "BackupCancelledError"; }
  if (!cancelled) throw new Error("Docker volume export cancellation did not complete");
  if (!JSON.parse(docker(["inspect", container]))[0].State.Running) throw new Error("Docker container was not restarted after cancellation");
  if (fs.readdirSync(temp).some((name) => name.endsWith(".hermesqqbackup"))) throw new Error("Cancelled Docker backup left a partial file");

  const backup = await createBackup({ type: "full", password: "test-only-password", stateRoot: state, destinationDir: temp, appVersion: "1.0.0-beta.1" });
  if (backup.manifest.dockerVolumes.length !== 3) throw new Error("expected all three Docker volumes in backup");
  const restored = await restoreBackup({ path: backup.path, password: "test-only-password", stateRoot: destination, hermesHome: path.join(destination, "hermes") });
  if (restored.restoredVolumes.length !== 3 || restored.parkedContainers.length !== 1) throw new Error("Docker volumes or rollback container were not staged");
  const restoredConfig = JSON.parse(fs.readFileSync(path.join(destination, "config.json"), "utf8"));
  const volume = restoredConfig.accounts.primary.snowlumaVolumes.snowlumaData;
  const marker = docker(["run", "--rm", "-v", `${volume}:/source:ro`, "alpine:3.20", "cat", "/source/marker.txt"]);
  if (marker !== `volume-${id}`) throw new Error("restored volume content differs from backup");
  await rollbackRestore({ stateRoot: destination, rollbackDir: restored.rollbackDir, installedTargets: restored.installedTargets, parkedContainers: restored.parkedContainers, restoredVolumes: restored.restoredVolumes });
  if (JSON.parse(fs.readFileSync(path.join(destination, "config.json"), "utf8")).sentinel !== "old") throw new Error("old config did not return after rollback");
  if (!JSON.parse(docker(["inspect", container]))[0].State.Running) throw new Error("old container did not resume after rollback");
  console.log(JSON.stringify({ ok: true, restoredVolumes: 3, rollback: true }));
} finally {
  spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  for (const volume of volumeNames) spawnSync("docker", ["volume", "rm", volume], { stdio: "ignore" });
  fs.rmSync(temp, { recursive: true, force: true });
}
