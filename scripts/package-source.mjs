import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import { root, releaseFiles, checkFiles, checkArchive, report } from "./release-safety-check.mjs";

const sourceFiles = Object.freeze([...new Set([
  ...releaseFiles,
  ".gitignore", ".gitleaks.toml", ".github/workflows/ci.yml", "AGENTS.md", "MEMORY.md", "PRD.md", "Tech-Spec.md", "forge.config.cjs",
  "desktop/main.cjs", "desktop/preload.cjs", "desktop/setup.html",
  "scripts/agent-feature-self-test.js", "scripts/backup-service-self-test.js",
  "scripts/account-registry-self-test.js", "scripts/account-management-integration-self-test.js", "scripts/config-revision-self-test.js",
  "scripts/account-isolation-self-test.js",
  "scripts/bot-command-routing-self-test.js", "scripts/bot-command-routing-integration-self-test.js",
  "scripts/console-assets-self-test.js", "scripts/console-ui-self-test.js", "scripts/console-preview-server.js",
  "scripts/console-contrast-self-test.js",
  "scripts/desktop-theme-self-test.js", "scripts/console-desktop-preview.js",
  "scripts/desktop-smoke-test.js", "scripts/docker-migration-self-test.js",
  "scripts/make-dmg.sh", "scripts/package-source.mjs", "scripts/package-web.mjs",
  "scripts/release-safety-check.mjs", "scripts/reply-coordinator-self-test.js",
  "scripts/start-qq-bot-stack.sh", "scripts/status-report.py", "scripts/status_report.sh",
  "scripts/web-host-self-test.js"
])].sort());

const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const prefix = `hermes-qq-bot-source-preview-${version}`;
const destination = path.join(root, "out", `${prefix}.tar.gz`);
const temporary = `${destination}.tmp-${process.pid}`;
fs.mkdirSync(path.dirname(destination), { recursive: true });
if (!report(checkFiles(sourceFiles))) process.exitCode = 1;
else {
  try {
    await tar.c({ cwd: root, file: temporary, gzip: true, portable: true, noMtime: true, prefix, strict: true }, sourceFiles);
    if (report(await checkArchive(temporary, prefix, sourceFiles))) {
      fs.renameSync(temporary, destination);
      console.log(`Built ${path.relative(root, destination)} (preview only; no Git history)`);
    } else process.exitCode = 1;
  } finally { fs.rmSync(temporary, { force: true }); }
}
