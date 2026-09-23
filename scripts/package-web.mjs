import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { root, releaseFiles, checkSource, checkArchive, report } from "./release-safety-check.mjs";

const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version)) throw new Error("Invalid package version");
const prefix = `hermes-qq-bot-web-${manifest.version}-macos-arm64`;
const destination = path.join(root, "out", `${prefix}.tar.gz`);

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.rmSync(destination, { force: true });
const temporary = `${destination}.tmp-${process.pid}`;
if (report(checkSource())) {
  try {
    await tar.c({ cwd: root, file: temporary, gzip: true, portable: true, noMtime: true, prefix, strict: true }, releaseFiles);
    if (report(await checkArchive(temporary, prefix))) {
      fs.renameSync(temporary, destination);
      console.log(`Built ${path.relative(root, destination)}`);
    } else process.exitCode = 1;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
} else {
  process.exitCode = 1;
}
