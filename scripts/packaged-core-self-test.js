import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { releaseFiles, root } from "./release-safety-check.mjs";

// Inspect staging artifacts only. No App launch, state access or live services.
const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const archive = path.join(path.resolve(root, process.env.HERMES_QQ_BUILD_OUT || "out"),
  "Hermes QQ Bot-darwin-arm64/Hermes QQ Bot.app/Contents/Resources/app.asar");
assert(fs.existsSync(archive), "build a staging App before checking edition parity");
const paths = asar.listPackage(archive).map(value => value.replace(/^\//, ""));
const forbidden = /^(?:config\.json|data|logs|secrets|napcat[^/]*|snowluma[^/]*|\.git)(?:\/|$)|\.hermesqqbackup$/i;
assert(!paths.some(value => forbidden.test(value)), "App package must not contain runtime state or backups");
let compared = 0;
for (const name of releaseFiles.filter(value => /^(?:src|public)\//.test(value))) {
  assert.deepEqual(asar.extractFile(archive, name), fs.readFileSync(path.join(root, name)),
    `${name} differs between Web source and staging App; rebuild rather than testing stale code`);
  compared++;
}
const packaged = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
assert.equal(packaged.version, JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
console.log(JSON.stringify({ ok: true, stagingOnly: true, sharedFilesCompared: compared,
  version: packaged.version, liveStateTouched: false, appLaunched: false }));
