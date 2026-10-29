/**
 * Reproducible, bounded, synthetic ledger benchmark. No network, user state,
 * disk writes, bridge startup, model calls, or n sequential ledger mutations.
 * Run: node scripts/operational-ledger-benchmark.js [--iterations=1..3]
 * Each size/profile runs in its own child process for independent RSS peaks.
 * Linear row construction + O(b log b) canonical bucket sorting, derived from
 * ONE successful recordModelCall seed (b = dimension buckets);
 * exact public query acceptance validates its schema/projection before writes.
 *
 * Measurements include query validation/projection and TWO private draft clones
 * around claim/settle, analogous to synchronous MemoryRuntime builders. They do
 * NOT include repository/worker IO, durable JSON commits, publication/reconcile,
 * unrelated memory subtrees, or a real model wait. JSON stringify is measured
 * separately. All wall-clock values are observations, never pass/fail thresholds.
 * GC (when available) runs only outside timed samples. Failed legal-fixture
 * validation is reported, not repaired by bypassing production validation.
 */
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  OPERATIONAL_LEDGER_LIMITS, recordModelCall, claimModelCall, settleModelCall, queryModelUsage,
} from '../src/operational-ledger.js';

const SIZES = [1000, 7000, 49000];
const PROFILES = ['seven-day-low-dimension', 'seven-day-max-dimension'];
const DAY = 86400000, T = Date.UTC(2026, 9, 29);
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningTokens'];
const SCOPE = ['logicalBotId', 'accountId', 'conversationId', 'kind', 'model'];
const usage = { inputTokens: 12, outputTokens: 4, totalTokens: 16, cachedInputTokens: 2, reasoningTokens: 1 };
const scope = { logicalBotId: 'account:benchmark', accountId: 'benchmark', conversationId: 'group:10000', kind: 'chat', model: 'benchmark/model' };
const round = n => Math.round(n * 1000) / 1000;
const rss = () => process.memoryUsage().rss;
const gc = () => { if (typeof global.gc === 'function') global.gc(); };
const requireResult = (condition, stage, reason) => {
  if (!condition) throw Object.assign(new Error('BENCHMARK_CHECK_FAILED'), { stage, reason: reason ?? 'invariant' });
};

function multiplyStats(value, n) {
  if (typeof value === 'number') return value * n;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => multiplyStats(v, n));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, multiplyStats(v, n)]));
}

function fixture(size, profile) {
  const root = {};
  const seed = recordModelCall(root, { callId: 'seed', startedAt: T, endedAt: T + 100,
    ...scope, status: 'confirmed', usage });
  requireResult(seed.ok, 'seed.recordModelCall', seed.reason);
  requireResult(size + 1 <= OPERATIONAL_LEDGER_LIMITS.calls, 'fixture.capacity');
  const ledger = root.operationalLedger, templateDay = ledger.days[0];
  const bucketCount = profile === PROFILES[0] ? 7 : Math.min(size, OPERATIONAL_LEDGER_LIMITS.dayAggregates);
  requireResult(bucketCount >= 7, 'fixture.days');
  const buckets = new Map();
  ledger.calls = Array.from({ length: size }, (_, i) => {
    const bucket = i % bucketCount, dayIndex = bucket % 7;
    const c = { ...seed.entry, usage: { ...seed.entry.usage }, callId: `benchmark-${i}`,
      startedAt: T + dayIndex * DAY, endedAt: T + dayIndex * DAY + 100,
      conversationId: profile === PROFILES[0] ? scope.conversationId : `group:${10000 + bucket}` };
    const dimension = { day: new Date(c.startedAt).toISOString().slice(0, 10), ...Object.fromEntries(SCOPE.map(k => [k, c[k]])) };
    const key = JSON.stringify(dimension);
    if (!buckets.has(key)) buckets.set(key, { dimension, count: 0 });
    buckets.get(key).count++;
    return c;
  });
  ledger.days = [...buckets.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([, b]) => ({ ...b.dimension, stats: multiplyStats(templateDay.stats, b.count) }));
  ledger.revision = size * seed.entry.revision;
  ledger.retention.through = T + 6 * DAY + 100;
  requireResult(ledger.calls.length === size && ledger.days.length === bucketCount, 'fixture.counts');
  return root;
}

// Diagnostic node count matching jsonData's recursive visit accounting for this
// plain JSON fixture, NOT a bypass or substitute for actual module acceptance.
function jsonNodes(value, depth = 0, result = { nodes: 0, maxDepth: 0 }) {
  result.nodes++;
  result.maxDepth = Math.max(result.maxDepth, depth);
  if (value !== null && typeof value === 'object') for (const v of Object.values(value)) jsonNodes(v, depth + 1, result);
  return result;
}
function statsCheck(result, count, buckets, stage) {
  requireResult(result.ok, stage, result.reason);
  requireResult(result.coverage.complete && result.stats.callCount === count && result.stats.totalCallCount === count
    && result.stats.knownCallCount === count && result.stats.unknownCallCount === 0 && result.days.length === buckets, stage);
  for (const field of TOKEN_FIELDS) requireResult(result.stats.tokens[field].total === count * usage[field], stage);
}
function summary(values) {
  const sorted = values.slice().sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { min: round(sorted[0]), median: round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2), max: round(sorted.at(-1)) };
}

function runCase(size, profile, iterations) {
  gc();
  const rssBeforeBytes = rss(), buildStart = performance.now();
  const root = fixture(size, profile);
  const fixtureBuildMs = performance.now() - buildStart;
  gc();
  const rssFixtureBytes = rss(), shape = jsonNodes(root.operationalLedger.days);
  let serialized = '', serializationStart = performance.now();
  serialized = JSON.stringify(root);
  const jsonStringifyMs = performance.now() - serializationStart, jsonBytes = Buffer.byteLength(serialized);
  serialized = null;
  gc();
  const bucketCount = root.operationalLedger.days.length;
  const queryArgs = { from: T, to: root.operationalLedger.retention.through + 1 };
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    gc();
    const start = performance.now();
    let queried = queryModelUsage(root, queryArgs);
    const queryMs = performance.now() - start, rssQueryBytes = rss();
    statsCheck(queried, size, bucketCount, 'queryModelUsage');
    queried = null;
    gc();
    // Reuse an existing dimension so the 20k-bucket profile tests real maximum
    // validator budget, NOT an intentionally over-capacity new dimension.
    const representative = root.operationalLedger.calls[6];
    const claimArgs = { callId: 'benchmark-new-claim', startedAt: root.operationalLedger.retention.through + 1,
      ...Object.fromEntries(SCOPE.map(k => [k, representative[k]])), expectedRevision: root.operationalLedger.revision };
    const pairStart = performance.now();
    let stage = pairStart, claimDraft = structuredClone(root);
    const claimCloneMs = performance.now() - stage;
    stage = performance.now();
    const claim = claimModelCall(claimDraft, claimArgs);
    const claimBuilderMs = performance.now() - stage;
    requireResult(claim.ok && claim.shouldCall && !claim.duplicate, 'claimModelCall', claim.reason);
    stage = performance.now();
    let settleDraft = structuredClone(claimDraft);
    const settleCloneMs = performance.now() - stage;
    stage = performance.now();
    const settled = settleModelCall(settleDraft, { callId: claimArgs.callId, endedAt: claimArgs.startedAt + 1,
      status: 'confirmed', usage, expectedRevision: claim.revision, expectedCallRevision: claim.entry.revision });
    const settleBuilderMs = performance.now() - stage, claimAndSettleWithClonesMs = performance.now() - pairStart;
    const rssPairBytes = rss();
    requireResult(settled.ok && !settled.duplicate && settled.entry.status === 'confirmed', 'settleModelCall', settled.reason);
    // Verify the resulting private draft through the actual public reader. The
    // verification duration is separate from the measured mutation pair.
    const verifyStart = performance.now();
    let verified = queryModelUsage(settleDraft, { from: T, to: claimArgs.startedAt + 2 });
    const verificationQueryMs = performance.now() - verifyStart;
    statsCheck(verified, size + 1, bucketCount, 'post-settlement.queryModelUsage');
    requireResult(settleDraft.operationalLedger.revision === root.operationalLedger.revision + 2
      && root.operationalLedger.calls.length === size && root.operationalLedger.revision === size, 'isolated-drafts');
    samples.push({ queryMs, claimCloneMs, claimBuilderMs, settleCloneMs, settleBuilderMs, claimAndSettleWithClonesMs,
      verificationQueryMs, rssQueryBytes, rssPairBytes });
    verified = null; claimDraft = null; settleDraft = null;
  }
  gc();
  const timingsMs = Object.fromEntries(Object.keys(samples[0]).filter(k => k.endsWith('Ms')).map(k => [k, summary(samples.map(s => s[k]))]));
  return { ok: true, size, profile, bucketCount, iterations, fixtureBuildMs: round(fixtureBuildMs),
    jsonBytes, jsonMiB: round(jsonBytes / 1048576), jsonStringifyMs: round(jsonStringifyMs),
    dayProjectionJsonNodes: shape.nodes, dayProjectionMaxDepth: shape.maxDepth,
    documentedJsonDataBudget: 4000000, // Informational snapshot; acceptance is verified above.
    timingsMs, memory: { rssBeforeBytes, rssFixtureBytes, rssAfterSamplesBytes: rss(),
      maxSampleRssBytes: Math.max(...samples.flatMap(s => [s.rssQueryBytes, s.rssPairBytes])),
      processPeakRssBytes: process.resourceUsage().maxRSS * 1024 },
    samples: samples.map(s => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k.endsWith('Ms') ? round(v) : v]))) };
}

const options = process.argv.slice(2);
const iterationArg = options.find(a => /^--iterations=[1-3]$/.test(a));
const iterations = iterationArg ? Number(iterationArg.split('=')[1]) : 3;
const child = options.includes('--case');
const allowed = child ? ['--case', ...SIZES.map(n => `--size=${n}`), ...PROFILES.map(p => `--profile=${p}`)] : [];
requireResult(options.every(a => a === iterationArg || allowed.includes(a)), 'arguments', 'use --iterations=1..3');
if (child) {
  const size = Number(options.find(a => a.startsWith('--size='))?.split('=')[1]);
  const profile = options.find(a => a.startsWith('--profile='))?.split('=')[1];
  try {
    requireResult(SIZES.includes(size) && PROFILES.includes(profile), 'arguments');
    console.log(JSON.stringify(runCase(size, profile, iterations)));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, size, profile, stage: error.stage ?? 'runtime', reason: error.reason ?? error.name }));
    process.exitCode = 1;
  }
} else {
  const results = [];
  for (const size of SIZES) for (const profile of PROFILES) {
    const processResult = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--case',
      `--size=${size}`, `--profile=${profile}`, `--iterations=${iterations}`], { encoding: 'utf8', timeout: 180000, maxBuffer: 1048576 });
    let result;
    try { result = JSON.parse(processResult.stdout.trim()); }
    catch { result = { ok: false, size, profile, stage: 'child-process', reason: processResult.error?.code ?? processResult.signal ?? 'no-json-result' }; }
    if (processResult.status !== 0) result.ok = false;
    results.push(result);
    console.error(JSON.stringify({ progress: `${results.length}/${SIZES.length * PROFILES.length}`, size, profile, ok: result.ok }));
  }
  console.log(JSON.stringify({ benchmark: 'operational-ledger', node: process.version, platform: process.platform,
    arch: process.arch, iterations, isolatedProcesses: true, gcOutsideSamples: true,
    limits: OPERATIONAL_LEDGER_LIMITS, includes: 'query validation/projection; claim + settle with two structuredClone drafts',
    excludes: 'disk/worker IO; durable serialization; publication/reconcile; unrelated root state; model calls', results }, null, 2));
  if (results.some(r => !r.ok)) process.exitCode = 1;
}
