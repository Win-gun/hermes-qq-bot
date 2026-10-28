import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const releaseFiles = Object.freeze([
  "README.md",
  "LICENSE",
  "config.example.json",
  "docs/DESKTOP-DISTRIBUTION.md",
  "docs/EDITION-PARITY.md",
  "docs/OPEN-SOURCE-CHECKLIST.md",
  "docs/SOCIAL-DISCOVERY.md",
  "docs/MULTI-ACCOUNT.md",
  "docs/CONSOLE-DESIGN.md",
  "docs/AUDIT-REMEDIATION.md",
  "docs/CORE-UPGRADE.md",
  "docs/DIGITAL-LIFE-3.0.md",
  "docs/MEMORY-VERIFICATION.md",
  "docs/SOCIAL-AGENT.md",
  "docs/SOCIAL-EXPERIENCE-2.md",
  "docs/SOCIAL-EXPERIENCE-2.1.md",
  "docs/SOCIAL-LIFE-3.1.md",
  "docs/SELF-ROLE-CARDS.md",
  "docs/GROUP-STICKER-CAPABILITIES.md",
  "package.json",
  "package-lock.json",
  "public/admin.html",
  "public/console.css",
  "public/console-theme.js",
  "scripts/memory-rebuild.js",
  "scripts/recreate-napcat-stable.sh",
  "scripts/start-web.command",
  "src/api-center.js",
  "src/account-registry.js",
  "src/account-runtime.js",
  "src/account-automation.js",
  "src/account-delivery.js",
  "src/api-secret-store.js",
  "src/keychain-write.js",
  "src/text-completion.js",
  "src/automation-rules.js",
  "src/legacy-automation.js",
  "src/backup-service.js",
  "src/bot-capabilities.js",
  "src/bot-command-routing.js",
  "src/bridge.js",
  "src/snowluma-mounts.js",
  "src/behavior-settings.js",
  "src/archive-search-index.js",
  "src/archive-search-service.js",
  "src/archive-search-worker.js",
  "src/memory-integrity.js",
  "src/memory-learning.js",
  "src/social-agent-state.js",
  "src/social-agent-runtime.js",
  "src/social-preferences.js",
  "src/social-intent-journal.js",
  "src/social-agency.js",
  "src/social-agency-context.js",
  "src/social-agency-qzone.js",
  "src/social-behavior.js",
  "src/social-episodes.js",
  "src/sticker-interaction.js",
  "src/poke-observation.js",
  "src/qzone-policy.js",
  "src/qzone-delivery.js",
  "src/qzone-runtime.js",
  "src/qzone-draft.js",
  "src/self-role-card.js",
  "src/self-role-card-generator.js",
  "src/social-persona-proposals.js",
  "src/social-discovery-state.js",
  "src/social-discovery-runtime.js",
  "src/social-discovery-context.js",
  "src/memory-verification.js",
  "src/memory-verification-notifier.js",
  "src/memory-repository.js",
  "src/memory-repository-service.js",
  "src/memory-repository-worker.js",
  "src/memory-runtime.js",
  "src/memory-intake.js",
  "src/memory-rebuild-proposal.js",
  "src/memory-state.js",
  "src/memory-observation.js",
  "src/memory-evidence.js",
  "src/memory-application.js",
  "src/memory-extraction-jobs.js",
  "src/memory-extraction-async.js",
  "src/privacy-filter.js",
  "src/mimo-web-search.js",
  "src/reply-coordinator.js",
  "src/conversation-turn-manager.js",
  "src/reply-plan.js",
  "src/public-media.js",
  "src/sticker-service.js",
  "src/sticker-cache.js",
  "src/group-sticker-learning.js",
  "src/message-reactions.js",
  "src/social-expression-library.js",
  "src/group-language-learning.js",
  "src/vision-process.js",
  "src/expression-renderer.js",
  "src/social-experience-policy.js",
  "src/social-expression-diagnostics.js",
  "src/sticker-semantics.js",
  "src/social-interest-watch.js",
  "src/social-style-context.js",
  "src/native-social-actions.js",
  "src/forward-context.js",
  "src/reply-execution.js",
  "src/reply-safety.js",
  "src/task-artifacts.js",
  "src/task-runtime.js",
  "src/agent-life.js",
  "src/agent-prompt.js",
  "src/digital-life-policy.js",
  "src/gui-lease.js",
  "src/task-delivery.js",
  "src/work-backends.js",
  "src/work-browser.js",
  "src/work-capabilities.js",
  "src/work-local-files.js",
  "src/work-plan-runtime.js",
  "src/task-web-policy.js",
  "src/voice-audio.js",
  "src/voice-consent.js",
  "src/voice-credentials.js",
  "src/voice-design.js",
  "src/voice-intent.js",
  "src/voice-mode.js",
  "src/voice-onebot.js",
  "src/voice-secret-store.js",
  "src/voice-service.js",
  "src/web-host.js"
]);

const allowed = new Set(releaseFiles);
const secretRules = [
  ["PRIVATE_KEY", /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ["GITHUB_TOKEN", /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/],
  ["OPENAI_TOKEN", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ["AWS_ACCESS_KEY", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["PERSONAL_MAC_PATH", /\/Users\/[A-Za-z0-9._-]+\/(?:Documents|Library|Desktop)\//],
  ["CREDENTIAL_ASSIGNMENT", /(?:^|[,{\s])(?:["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)["']?)\s*[:=]\s*["'](?!\s*(?:<|\$|\{\{|example|sample|dummy|fake|test|changeme|your[_-]|REPLACE|xxx|\.\.\.))[A-Za-z0-9_+/.=-]{16,}["']/im]
];

function issue(issues, name, rule) { issues.push({ path: name, rule }); }

function cleanName(name) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || name.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
  return true;
}

function sensitivePath(name) {
  // Exact vetted source/docs paths only; snowluma* runtime directories remain
  // forbidden, and these files still undergo the ordinary content checks.
  if (["src/snowluma-mounts.js", "scripts/snowluma-mounts-self-test.js", "docs/SNOWLUMA-UPGRADE.md"].includes(name)) return false;
  const parts = name.toLowerCase().split("/");
  const base = parts.at(-1);
  if (parts.some((part) => /^(?:node_modules|data|logs|secrets|napcat(?:-.+)?|snowluma.*|out|\.git)$/.test(part))) return true;
  return base === "config.json" || base.startsWith("config.json.bak") || base === ".env" || (base.startsWith(".env.") && base !== ".env.example") || base.endsWith(".hermesqqbackup") || /(?:^|[-_.])(?:cookie|credential|private[-_]?key|access[-_]?token)(?:[-_.]|$)/.test(base);
}

function scanText(name, contents, issues) {
  for (const [rule, pattern] of secretRules) if (pattern.test(contents)) issue(issues, name, rule);
  if (name === "config.example.json") {
    try {
      const config = JSON.parse(contents);
      const ids = [config.accounts?.primary?.qq, ...(config.accounts?.standbys || []).map((account) => account.qq), ...(config.accounts?.items || []).map((account) => account.qq), ...(config.targetGroups || []), ...(config.privateChats?.targetUsers || [])];
      if (ids.some((id) => /^(?!0+$)\d{5,}$/.test(String(id)))) issue(issues, name, "ACCOUNT_ID");
    } catch { issue(issues, name, "INVALID_EXAMPLE_JSON"); }
  }
}

export function checkFiles(files) {
  const issues = [];
  for (const name of files) {
    if (!cleanName(name) || sensitivePath(name)) { issue(issues, name, "CANDIDATE_SENSITIVE_PATH"); continue; }
    const file = path.join(root, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) { issue(issues, name, "NOT_REGULAR_FILE"); continue; }
      scanText(name, fs.readFileSync(file, "utf8"), issues);
    } catch { issue(issues, name, "MISSING_CANDIDATE"); }
  }
  return issues;
}

export function checkSource() {
  const issues = [];
  let tracked;
  try {
    tracked = execFileSync("git", ["ls-files", "--cached", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean);
  } catch {
    // An unpacked release has no Git checkout. Candidate checks still apply.
    tracked = [];
  }
  for (const name of tracked) {
    const parts = name.toLowerCase().split("/");
    if (parts.some((part) => /^(?:test|tests|fixtures|__fixtures__|testdata)$/.test(part)) || /(?:^|[-_.])(?:test|spec|fixture)(?:[-_.]|$)/.test(parts.at(-1))) continue;
    if (!cleanName(name) || sensitivePath(name)) { issue(issues, name, "TRACKED_SENSITIVE_PATH"); continue; }
    if (allowed.has(name)) continue; // Candidate content is checked below, once.
    try {
      const file = path.join(root, name);
      const stat = fs.lstatSync(file);
      if (stat.isFile() && stat.size <= 5_000_000) scanText(name, fs.readFileSync(file, "utf8"), issues);
    } catch { /* A tracked deletion cannot enter the explicit release whitelist. */ }
  }
  issues.push(...checkFiles(releaseFiles));
  return issues;
}

export async function checkArchive(file, prefix, files = releaseFiles) {
  const issues = [];
  const found = new Set();
  const allowedFiles = new Set(files);
  try {
    await tar.t({ file, gzip: true, strict: true, onReadEntry(entry) {
      const name = entry.path;
      if (!cleanName(name) || !name.startsWith(`${prefix}/`)) { issue(issues, name, "ARCHIVE_PATH"); return; }
      const relative = name.slice(prefix.length + 1);
      if (sensitivePath(relative)) issue(issues, name, "ARCHIVE_SENSITIVE_PATH");
      if (!allowedFiles.has(relative)) issue(issues, name, "ARCHIVE_NOT_WHITELISTED");
      if (entry.type !== "File") issue(issues, name, "ARCHIVE_NOT_REGULAR_FILE");
      if (found.has(relative)) issue(issues, name, "ARCHIVE_DUPLICATE");
      found.add(relative);
      const chunks = [];
      let size = 0;
      entry.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 5_000_000) chunks.push(chunk);
      });
      entry.on("end", () => {
        if (size > 5_000_000) issue(issues, name, "ARCHIVE_FILE_TOO_LARGE");
        else if (allowedFiles.has(relative)) scanText(relative, Buffer.concat(chunks).toString("utf8"), issues);
      });
    } });
  } catch { issue(issues, path.basename(file), "ARCHIVE_READ_FAILED"); }
  for (const name of files) if (!found.has(name)) issue(issues, `${prefix}/${name}`, "ARCHIVE_MISSING_CANDIDATE");
  return issues;
}

export function report(issues) {
  for (const { path: name, rule } of issues) console.error(`${name} ${rule}`);
  return issues.length === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const archive = process.argv[2];
  const prefix = archive ? path.basename(archive).replace(/\.tar\.gz$/, "") : "";
  const issues = checkSource();
  if (archive) issues.push(...await checkArchive(path.resolve(archive), prefix));
  if (report(issues)) console.log(archive ? "Release source and archive safety checks passed" : "Release source safety checks passed");
  else process.exitCode = 1;
}
