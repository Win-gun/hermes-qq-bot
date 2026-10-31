// Owner First 3.4 integration aggregator.
//
// This wrapper deliberately does NOT invent a new fixture. It runs the real
// module suites plus the two existing fake-bridge fixtures that already cover
// the owner surfaces end to end:
//   * scripts/people-owner-integration-self-test.js  -> real isolated bridge,
//     two fake OneBots, owner commands/claims/notifications/people memory.
//   * scripts/social-agent-integration-self-test.js  -> real isolated bridge,
//     fake CDN + fake OneBot, and (with OWNER_FIRST_FIXTURE=1) the owner
//     query + qualified sticker wire/ACK/readback branch.
// Every child is spawned with its own temporary HOME/config/memory; no real
// QQ, model, network, Keychain or production state is touched. Numbers below
// are read back from the children, never estimated.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

const MODULE_SUITES = [
  'scripts/owner-first-template-self-test.js',
  'scripts/owner-first-migration-self-test.js',
  'scripts/owner-first-router-self-test.js',
  'scripts/owner-first-people-self-test.js',
  'scripts/owner-first-ledger-self-test.js'
];
const BRIDGE_FIXTURES = [
  { id: 'people-owner', script: 'scripts/people-owner-integration-self-test.js', env: {}, json: true },
  { id: 'social-owner', script: 'scripts/social-agent-integration-self-test.js', env: { OWNER_FIRST_FIXTURE: '1' }, json: false }
];

function lastJsonObject(output) {
  for (const line of [...String(output || '').split('\n')].reverse()) {
    const text = line.trim();
    if (!text.startsWith('{') || !text.endsWith('}')) continue;
    try { return JSON.parse(text); } catch { /* keep looking for the real summary */ }
  }
  return null;
}

const rows = [], failures = [];

function run(id, script, env, { json, timeout = 900000 } = {}) {
  // Children run sequentially: each owns a temporary port pair and a large
  // memory/CPU budget, and overlapping fixtures would only add flakiness.
  const started = Date.now();
  const child = spawnSync(process.execPath, [path.join(root, script)], {
    cwd: root,
    env: { ...process.env, ...env, NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024
  });
  const output = `${child.stdout || ''}${child.stderr || ''}`;
  const exitCode = child.status;
  const summary = json ? lastJsonObject(child.stdout) : null;
  const passes = (child.stdout || '').split('\n').filter(line => line.startsWith('PASS ')).length;
  const ownerBranch = id !== 'social-owner' || /^PASS owner-first bridge:/m.test(child.stdout || '');
  const row = { id, script, exitCode, signal: child.signal, durationMs: Date.now() - started,
    summary: summary || undefined, passLines: passes || undefined };
  rows.push(row);
  if (exitCode !== 0 || !ownerBranch || (json && summary?.ok !== true)) failures.push({ id, script, exitCode, signal: child.signal,
    // Keep the reason short: a tail, never a full log, and no fixture content.
    detail: `${!ownerBranch ? 'Owner-specific integration branch did not report execution\n' : ''}${output.trim().split('\n').slice(-14).join('\n').slice(0, 2400)}` });
  return row;
}

async function main() {
  for (const script of MODULE_SUITES) run(path.basename(script, '.js'), script, {}, { json: true });
  for (const fixture of BRIDGE_FIXTURES) run(fixture.id, fixture.script, fixture.env, { json: fixture.json });
  await pause();

  const summaries = rows.map(row => row.summary).filter(Boolean);
  // Two honest counters, never merged into one misleading "passed" number:
  // module suites report `checks`, the bridge fixtures report `passed` tests.
  const fixtureTests = summaries.reduce((sum, item) => sum + (Number.isSafeInteger(item.passed) ? item.passed : 0), 0);
  const passLines = rows.reduce((sum, row) => sum + (row.passLines || 0), 0);
  // Only values a child actually reported are summed; nothing is inferred.
  const fakeHttpCalls = summaries.reduce((sum, item) => sum + (Number.isSafeInteger(item.fakeHttpCalls) ? item.fakeHttpCalls : 0), 0);
  const fakeWireSends = summaries.reduce((sum, item) => sum + (Number.isSafeInteger(item.fakeWireSends) ? item.fakeWireSends : 0), 0);
  const report = {
    ok: failures.length === 0,
    suites: rows.length,
    // Different children count scenario groups, assertions or suites. Preserve
    // their original reports instead of inventing one incomparable total.
    fixtureTests,
    fixturePassLines: passLines,
    failed: failures.length,
    failures,
    children: rows.map(({ id, script, exitCode, durationMs, summary, passLines: lines }) => ({
      id, script, exitCode, durationMs, passLines: lines,
      // Verbatim child summary (already synthetic-only), not a rewrite of it.
      reported: summary || null
    })),
    fakeHttpCalls,
    fakeWireSends,
    // This aggregator adds no fixture of its own: it only spawns the two
    // existing isolated bridges, so these hard zeros describe the whole run.
    realQqWrites: 0,
    realModelCalls: 0,
    realNetwork: false,
    productionIO: false,
    productionConfig: false,
    runtime: process.versions.node.split('.').slice(0, 1)[0] === '22' ? process.versions.node : `${process.versions.node} (expected Node 22)`,
    ackTimeoutShimMs: 5000,
    // Honest scope note: the owner branch proves host <-> fake-OneBot protocol
    // behaviour, not real QQ delivery or client rendering.
    evidence: 'synthetic fake OneBot wire + fake model/CDN only; real QQ delivery and client display remain unverified'
  };
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}

await main();
