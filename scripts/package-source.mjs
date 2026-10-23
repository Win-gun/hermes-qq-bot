import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import { root, releaseFiles, checkFiles, checkArchive, report } from "./release-safety-check.mjs";

const sourceFiles = Object.freeze([...new Set([
  ...releaseFiles,
  "scripts/memory-background-self-test.js", "scripts/memory-background-benchmark.js",
  "scripts/memory-extraction-async-self-test.js",
  "scripts/memory-verification-self-test.js",
  "scripts/memory-verification-notifier-self-test.js",
  "scripts/memory-learning-self-test.js",
  "scripts/social-agent-state-self-test.js",
  "scripts/text-completion-self-test.js",
  "scripts/keychain-write-self-test.js",
  "scripts/social-agent-runtime-self-test.js",
  "scripts/social-agent-ui-self-test.js",
  "scripts/social-agent-integration-self-test.js",
  "scripts/social-agent-evaluation.js",
  "scripts/social-agent-evaluation-self-test.js",
  "scripts/social-agent-benchmark.js",
  "scripts/social-persona-proposals-self-test.js",
  "scripts/social-discovery-state-self-test.js",
  "scripts/social-discovery-runtime-self-test.js",
  "scripts/social-discovery-context-self-test.js",
  "scripts/social-discovery-ui-self-test.js",
  "scripts/social-discovery-integration-self-test.js",
  "scripts/memory-verification-ui-self-test.js",
  "scripts/memory-verification-bridge-self-test.js",
  "scripts/memory-verification-integration-self-test.js",
  "scripts/memory-intake-self-test.js",
  "scripts/memory-async-guards-self-test.js",
  "scripts/memory-bridge-benchmark.js",
  "scripts/packaged-core-self-test.js",
  ".gitignore", ".gitleaks.toml", ".github/workflows/ci.yml", "AGENTS.md", "MEMORY.md", "PRD.md", "Tech-Spec.md", "forge.config.cjs",
  "desktop/main.cjs", "desktop/preload.cjs", "desktop/setup.html",
  "scripts/agent-feature-self-test.js", "scripts/backup-service-self-test.js",
  "scripts/core-audit-regression-self-test.js", "scripts/archive-search-index-self-test.js",
  "scripts/account-audit-regression-self-test.js", "scripts/security-regression-self-test.js",
  "scripts/memory-repository-self-test.js", "scripts/memory-rebuild-proposal-self-test.js", "scripts/memory-evidence-self-test.js",
  "scripts/memory-rebuild-integration-self-test.js",
  "scripts/memory-state-self-test.js",
  "scripts/memory-observation-self-test.js", "scripts/memory-evidence-attribution-self-test.js",
  "scripts/memory-application-self-test.js", "scripts/memory-extraction-integration-self-test.js",
  "scripts/memory-extraction-jobs-self-test.js", "scripts/archive-search-service-self-test.js",
  "scripts/archive-context-self-test.js",
  "scripts/memory-backup-self-test.js",
  "scripts/memory-repository-benchmark.js",
  "scripts/account-registry-self-test.js", "scripts/account-management-integration-self-test.js", "scripts/config-revision-self-test.js",
  "scripts/account-runtime-self-test.js", "scripts/reply-coordinator-kernel-self-test.js",
  "scripts/reply-wire-self-test.js", "scripts/task-owner-self-test.js", "scripts/account-kernel-integration-self-test.js",
  "scripts/account-automation-self-test.js", "scripts/account-group-policy-self-test.js", "scripts/automation-ui-self-test.js",
  "scripts/legacy-automation-self-test.js", "scripts/routine-scheduler-self-test.js",
  "scripts/api-center-self-test.js", "scripts/api-center-integration-self-test.js", "scripts/api-secret-store-self-test.js",
  "scripts/mimo-web-search-self-test.js", "scripts/bot-capabilities-self-test.js", "scripts/automation-rules-self-test.js",
  "scripts/new-features-integration-self-test.js", "scripts/task-web-policy-self-test.js",
  "scripts/voice-audio-self-test.js", "scripts/voice-consent-self-test.js", "scripts/voice-credentials-self-test.js",
  "scripts/voice-design-self-test.js", "scripts/voice-intent-self-test.js", "scripts/voice-mode-self-test.js",
  "scripts/voice-onebot-self-test.js", "scripts/voice-routing-integration-self-test.js", "scripts/voice-secret-store-self-test.js", "scripts/voice-service-self-test.js",
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
