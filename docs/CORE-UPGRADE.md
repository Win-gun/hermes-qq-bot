# Core upgrade work ledger

This is the source implementation ledger, not a deployment record. The beta.13
audit changes already in the working tree are the baseline and must be preserved.
No runtime update, live migration or QQ send is authorized by this ledger.

## Acceptance boundaries

- Existing identities, styles, model bindings, automation ownership, memories and
  raw archives remain readable. Copying a style is a detached snapshot.
- Independent bots own their reply decisions, private context and control state.
  Explicit failover groups alone share one logical identity. Same-group send
  spacing is shared, not a shared decision to answer every message.
- Quiet collects and analyzes but suppresses every group send.
- No database/vector dependency, extra normal-chat model call or reply reviewer.
- Tests use temporary synthetic data and fake protocol/model boundaries only.
- A rollback must never overwrite messages received after a new version starts.

## Milestones

| Stage | Required evidence | State |
| --- | --- | --- |
| 1. Memory safety | Exclusive writer; corruption protection; journal recovery; atomic snapshots; rebuild CAS; backup compatibility | Source correctness verified; not deployed |
| 2. Multi-account kernel | Explicit logical context/routing; scoped state and policy revisions; independent generation; shared send gate; connection-epoch tests | Source integration and transition review verified; not deployed |
| 3. Reliable memories | Unique source evidence; event-time corrections; legacy fallback gate; no durable FIFO deletion; replay tests | Source/module/integration and targeted independent review verified; not deployed |
| 4. Retrieval/background work | Scoped neighbor/quote retrieval; independent budgets; background index; recoverable ordered extraction; responsiveness benchmarks | Source/integration and representative latency gates verified; not deployed |
| 5. Maintainability/acceptance | Public module contracts; integrated event replay; safe observability; architecture docs; shared Web/App release resources | Contracts, CI, event replay, metrics and staging edition parity verified; not deployed |

## Current evidence and next action

Static inspection identified separate online/offline whole-file memory writers,
read errors falling back to an empty store, canonical FIFO removal and duplicate
confirmation counting. These are risks, not a claim of observed live corruption.

Stage 1 introduces a single repository. Read-only commands must not acquire a
writer or create files. Online rebuild workers produce candidate patches; only
the live writer may validate and commit them. Offline apply must refuse a live
writer and stale source revisions. Further stages remain open until their own
tests and integration gates pass. Logical runtime/routing, per-claim attribution,
durable extraction and background history lookup now have source integration
evidence. Background persistence and bounded intake pass the representative
latency gate below. All five stages have source/staging acceptance evidence,
including the targeted independent memory/send-boundary review and the
requirement map below. This is not a production switch. Deployment/migration and
real QQ acceptance require separate current authorization.

## Verification record

2026-10-19, synthetic/temporary state only:

- `npm run test:memory`: repository 18 groups (real competing writers, SIGKILL,
  CAS, private permissions, stable readers); commit-state reference/failure
  tests; immutable scoped rebuild proposals; real bridge/API/CLI conflict and
  quiet tests; journal-aware backup/restore; canonical evidence 31 cases.
- `npm run test:backup`: 88 cases. `npm run test:accounts`: six-account bridge
  integration 45 cases plus registry, policy, ownership and routine scheduler.
- `npm run test:account-isolation`: 502 assertions. `npm run test:audit`: passes;
  optional PDF Chinese text extraction was skipped without its Python runtime.
- `npm run test:console`, `npm run check`, release safety and source preview pass.
- Independent phase-1 review found invalid AI confidence poisoning the live
  object and a missing-file backup witness gap. Both were fixed and re-reviewed;
  synthetic delayed extraction/rebuild/new-message interleaving preserved data
  and group/user/array references.

`node scripts/memory-repository-benchmark.js` is a diagnostic, NOT a release
performance gate: synthetic 7,265,354-byte state, five updates, initial save
247ms, save P50 192ms/P95 223ms, maximum event-loop stall 224ms on this machine.
The synchronous compatibility interface still needs the background/performance
milestone before claiming low-latency acceptance. Snapshot limit 64MiB and
journal limit 16MiB refuse safely instead of deleting data. Torn journal tails
remain intact and require inspection; no automatic destructive repair.

No App build/replacement, production migration, real messages or Git publish
was performed. Passing these source tests is not full-goal completion.

2026-10-20, synthetic/temporary state only:

- `npm run test:kernel`: immutable runtime ownership, policy revisions, 13
  coordinator groups, wire/ACK cancellation, 11 task-owner groups, real bridge
  plus two fake carriers/models. Independent generation and shared send spacing
  are verified together.
- `npm run test:account-isolation`: 512 assertions, including scoped quiet,
  private controls, voice preset acknowledgment, stale socket/quote/ASR work,
  and policy changes that do not invalidate an unrelated bot.
- `npm run test:features` passes. Mode-switch regression cancels the old draft,
  regenerates once on the same eligible carrier, and uses the NEW private
  history/control/archive namespace. No old private log is transferred.
- Independent review found two transition gaps: stale private namespace and
  search pre-reply replay during ACK wait. Both have source fixes and targeted
  regressions and reviewer confirmation.
- Durable legacy string values no longer use FIFO deletion. The new observation
  boundary deduplicates sourced events and keeps first/last seen time monotonic
  without allowing late events to rename a user backwards.

Further verified source evidence:

- Memory evidence 32 groups; attribution 28; application 33; durable extraction
  state/scheduler 42. Real isolated bridge tests verify claims are durable BEFORE
  a fake model runs, new messages survive the patch+ACK transaction, invalid JSON
  retains the retry gate, and SIGKILL resumes the SAME batch. Quiet plus disabled
  chat still collects/extracts with zero send/upload actions.
- Background search 18 groups and neighbor/quote context 14; original synchronous
  index 15 retained. Bridge retrieval uses the worker, bounded relation expansion
  and independent recent/relevant budgets. The common privacy module applies to
  both foreground writes and worker queries. A cold synthetic build took 1460ms;
  the main-thread timer maximum gap was 12ms. This does not prove large-memory
  persistence is nonblocking: its 224ms baseline remains a separate open gate.
- A repeat generated 7,265,354-byte repository benchmark measured save P50
  184ms/P95 191ms and main-thread stall 191ms. This is still a failed latency
  gate, not evidence of a nonblocking write path. Moving durable persistence
  off-thread must preserve single-writer/CAS, commit-before-publish and concurrent
  new-input safety; simply returning a Promise around sync writes is insufficient.
- Worker cleanup failure is latched as `CLEANUP_FAILED`; explicit/repeated close
  rejects after retirement instead of falsely claiming cleanup succeeded.
  Synthetic EACCES regressions cover both caller-close and abort-triggered close.
- Source whitelist/preview and syntax/config checks pass. No App package was
  built or installed. Independent stage-3 review was unavailable due to a model
  usage limit; it is NOT recorded as passed. Local risk review and further
  fault/event-chain evidence remain required.

### Background persistence and integrated acceptance follow-up

2026-10-20, temporary synthetic state only; supersedes the online write-latency
gap above, without claiming the synchronous compatibility API is nonblocking:

- Background repository 21 checks: sole writer ownership, strict JSON without
  getter execution, uncertain termination/reopen, latest durable publication,
  external alias isolation, close/drain and exact private rebuild backups.
- Intake: 70 ordered messages coalesce into five durable batches. Partial
  builder failure rolls the whole batch back; controls remain independent;
  completion continuations, explicit backpressure and close/drain are tested.
- Async extraction scheduler 30 checks; synchronous compatibility scheduler 42
  retained. Real bridge extraction/rebuild/kernel tests pass on the background
  writer, including SIGKILL/same-batch recovery, concurrent intake and patch+ACK.
- Source-extracted async-send guards: 10 scenarios plus five intentional
  in-memory old-code reversions. They detect queued commands crossing quiet,
  preset identity/policy changes during I/O and automation using a scope ID
  instead of the real conversation-control key. Scheduled routine tests also
  change quiet/owner/control state after a durable claim and verify zero sends.
- `node scripts/memory-background-benchmark.js`: 7,265,354-byte fixture, save
  P50 240ms end-to-end; main-thread maximum timer gap 40ms (five samples).
- `node scripts/memory-bridge-benchmark.js`: same fixed 24-message/three-session
  workload before and after coalescing. Before: intake P50 9.29s/P95 17.72s/max
  18.53s, transaction queue peak 24. After: source fixture 7,001,967 bytes, ready
  snapshot 10,259,649 bytes, intake P50 748ms/P95 1503ms/max 1503ms, transaction
  queue peak 3. Health P95 5.12ms/max 77.68ms; max response gap 102.64ms, under
  the fixed 250ms acceptance limit. No queue-full, storage or extraction errors.
  All 24 original payloads/observations/pending inputs survive both pre-stop and
  SIGKILL/restart checks; two running batches recover unchanged. Two fake models,
  zero sends/uploads, loopback only; all fixture processes/directories removed.
  These are representative measurements, not guarantees for arbitrary store
  sizes or incoming traffic. The ~1.5s durability tail is explicitly measured.
- Staging Apple Silicon App builds using the locally installed pinned Electron
  44.4.5 distribution after the remote download timed out. No installed App was
  replaced. `npm run test:packaged-core` compares all 50 shared `src/`/`public/`
  release files byte-for-byte and rejects runtime state/backup files in ASAR.
- Read compatibility also covers absent optional integrity settings: legacy
  facts/topics remain visible; malformed explicit settings and canonical
  tentative/corrected/unknown mirrors still fail closed.
- A repeat of the fixed integrated workload after the final memory read-gate
  changes passed: intake P95/max 2414ms, health P95 2.83ms/max 82.76ms, maximum
  response gap 109.89ms. All 24 original inputs survived restart again. Timing
  varies with host load; the gate measures responsiveness and durability, not
  an unrealistically instantaneous durable ACK.
- Final memory review identified and fixed two additional P2s: tentative human
  corrections could be undone by old evidence, and populated markerless stores
  could re-import unknown raw mirrors. Corrections now retain a separate
  post-correction evidence/confidence epoch; prior counts, confidence, explicit
  markers, replayed IDs and late/equal-time events cannot reactivate the claim.
  Truly new, sufficiently confirmed evidence or a new authenticated explicit
  assertion can do so; reject/supersede tombstones remain terminal. Prompt,
  per-value/whole-user compatibility and memory-detail reads use the same gate.
  Missing `legacyImported` alone never authorizes re-bootstrap once canonical
  entries/conflicts exist. All original values/evidence/corrections remain intact.
- The targeted independent review is closed with no remaining confirmed P1/P2
  in its defined memory-attribution/application and async-send scopes. Canonical
  evidence tests increased from 32 to 67; attribution 28 and application 33 also
  pass (128 total in those suites). Extra cases cover per-source mixed timestamps,
  stronger group evidence despite relaxed personal policy, correction replay
  without epoch reset, genuinely newer corrections, confidence isolation and
  detached/pure read views. These findings were not dismissed because older
  suites passed; each received a source fix and regression.
- Final current-source repeat after the per-source/correction-idempotence fixes:
  the same 24-input workload passes again, intake P95/max 2434ms, health P95
  3.09ms/max 83.04ms, maximum response gap 109.37ms. All 24 inputs and both pinned
  batches survive SIGKILL/restart; no sends, forbidden actions, queue-full or
  storage errors. The final rebuilt App matches all 50 shared release files;
  isolated native startup and attachment to the isolated Web host both pass,
  including the background integrity endpoint. The pre-existing installed App
  process remains running and was not replaced/stopped by these tests.

## Requirement evidence map

| Requirement | Authoritative isolated proof |
| --- | --- |
| One writer, version/CAS, durable journal/atomic snapshots | `memory-repository-self-test`: actual competing processes, fsync/checkpoint failpoints, SIGKILL and 100-commit reader race |
| Never reset corrupt/missing initialized data; preserve old backups | Repository and memory-backup suites; full backup suite; original corrupt bytes/witness remain intact |
| Online rebuild cannot overwrite intervening messages | Real bridge/API/CLI rebuild suite; per-target CAS, immutable candidate, exact prior backup and unrelated update retention |
| Independent logical identities/private controls; explicit shared failover only | Runtime/kernel, source-extracted isolation and real two-carrier/model integration; identity/session/policy ABA rejection |
| Independent generation with shared same-group send spacing | Kernel/coordinator/wire tests plus actual fake protocol send times; no uncertain ACK replay |
| Quiet collects/analyzes with no sends | Real extraction integration with quiet/chat disabled, source-extracted send guards and account-control tests |
| QQ-bound unique provenance, original event time, correction and conflict gates | Canonical evidence, per-claim attribution and application suites; duplicate/late/tied-time/foreign-sender/quoted evidence cases |
| No silent durable FIFO eviction | Repository size-limit refusal, extraction backpressure, observation/rebuild preservation and legacy-array equality checks |
| Scoped related history plus bounded neighbors/quotes | Index/context/worker suites; cross-conversation/forged quote rejection and independent recent/relevant budgets |
| Background work without blocking chat's main thread | Cold-index timer probe plus real bridge fixed large-memory/24-message health and restart workload |
| Reliable recoverable extraction | Async scheduler + real bridge claim-before-model, latest-draft patch+ACK, failed JSON/retry and pinned SIGKILL batch recovery |
| Modular contracts, public tests, safe metrics and edition parity | Module contracts below, CI suites, `/health` fixed-code counters, 50-file ASAR comparison and isolated App/Web-host smoke tests |

This map covers source/staging acceptance. It is not evidence of a production
switch, real QQ delivery or deployment migration, none of which is authorized
by this goal. Those remain a separate explicitly approved operational workflow.

## Logical runtime and delivery contract

`AccountRuntime` is the routing authority: `account:<id>` is an independent bot;
`group:<id>` is an explicitly shared failover identity. Physical sessions,
route epochs, effective policy revisions and conversation controls bind every
execution. Unrelated peer edits do not invalidate another bot. Old A→B→A work
never revives merely because a socket or display name looks the same again.

`ReplyCoordinator` serializes each logical-bot/conversation lane, not all models
in a group. `GroupSendCoordinator` retains shared physical group spacing.
`replyDeliveryConfig` checks cancellation at the actual wire boundary, freezes
covered input on a send attempt, and prevents post-wire follow-ups disappearing
into the old draft. Uncertain attempts are not automatically replayed.

Only unsent directly addressed chat may be regenerated after an owner-mode
transition: same eligible carrier, new identity and private namespace, at most
two handoffs. Commands, formal tasks, proactive messages and attempted search
pre-replies are excluded. Task owner IDs are immutable; legacy task migration
backs up each original metadata file before adding ownership.

## Memory application and extraction contract

`memory-evidence.js` prepares eligible source rows and attributes EACH claim to
actual same-sender IDs from that batch. Quoted/forwarded/tool/bot material and
unknown event times cannot become human self-claims. An AI hint is not a trusted
explicit command. Missing sources become non-active proposals, never synthetic
independent confirmations from the rest of a batch.

Every attributed context carries `sourceMessageTimes` (ID -> original ISO).
Its aggregate `sentAt` is only the newest event, never a replacement for all
individual source times. Corrected records count post-epoch sources one by one;
mixed old/new IDs cannot manufacture two new confirmations. An old direct API
call with one source may use `sentAt`; multi-source calls without the map cannot
establish post-correction times. Replayed correction IDs/timestamps do not reset
the new evidence epoch; a genuinely later correction may start a new one.
Group fact/topic projections always retain the stronger independent-evidence
rule, even when personal-memory evidence requirements are relaxed by config.

`memory-application.js` applies only attributed assertions to draft groups;
per-user and group fact/topic evidence are separate. `groupMemoryValues` and
`legacyMemoryValues` are read projections: genuine older values stay readable,
but raw mirrors cannot revive rejected/disputed entries. Bot personality and
capability changes from extraction stay proposals, preserving existing styles.
Unknown legacy chronology stays unknown. Durable values, notable messages,
summaries, conflicts and correction tombstones are not FIFO-evicted.

`memory-extraction-jobs.js` is a pure persistent state machine plus bounded
scheduler: global concurrency two, one batch per conversation, stable source
deduplication, durable claim, latest-root patch+ACK commit, explicit backpressure,
bounded periodic retries, and restart recovery without dropping pending input.
Old pending arrays remain additive import sources. Limits reject safely rather
than deleting evidence; this is not unlimited disk capacity. `/bot memory
correct <id> <action>` targets one person's exact record, requires that person
or a group administrator, and retains original event/source metadata.

## Retrieval and observability contract

`ArchiveSearchService` owns the shared bounded worker pool. Source/index/result
limits, cancellation, timeouts and directory leases prevent simultaneous cache
writers and unbounded work. `searchArchiveContext` reads verified same-file rows
with explicit conversation checks, bounded neighbors and <=2 quote hops; inline
quote text is not independent evidence. A failed worker uses bounded recent
context, never a synchronous full-history fallback.

`/health` exposes logical owner/version metadata, repository durability, search
worker counts and extraction accepted/proposed/rejected counts/fixed codes. The
new storage/search/extraction metrics contain no prompts, message text, source
IDs or credentials; pre-existing local account diagnostics retain their existing
preview fields. Source release
whitelists include worker and shared privacy modules for Web/App parity.

## Memory repository contract

`src/memory-repository.js` is the only cooperating storage engine for `memory.json`.
The online bridge runs it inside `memory-repository-worker.js`, behind the bounded
`BackgroundMemoryRepository` request facade. Normal startup acquires its process
ticket in that worker before loading. Read-only
queries/checks use a stable recovered view without writing or taking a ticket.
Incremental journal operations are fsynced before snapshot rename; completed
checkpoints compact the journal. A failed uncertain commit latches protection;
do not retry mutations on that instance. Status exposes safe error codes and
durability only, never contents. Offline apply refuses the live writer and
stale source revisions.

`MemoryRuntime.transact(syncBuilder)` is the only online publication lane. Each
builder receives a fresh draft of the latest committed root when its turn
actually starts, not when it was queued. It may not await models/tools. The
background engine validates/hashes/journals/fsyncs/checkpoints; only its confirmed
snapshot is published, synchronously with updating the runtime revision. Builder
arguments cannot mutate that confirmed snapshot during the I/O wait. In-place
publication preserves existing group/user/array references. Prompt compatibility
defaults are read views, never uncommitted writes to the published root.

`MemoryIntake` coalesces up to 16 pending raw-message builders into one such
transaction, without adding an artificial debounce delay. It has a 1024-message
bounded pending lane. Each input resolves only after the batch is durable; a
failed batch rejects every affected input, without partial publication or an
uncertain implicit retry. The upstream archive keeps the raw source evidence.
Full queues report explicit backpressure, not successful collection. Controls,
rebuilds, extraction claims/ACKs and already-sent bot receipts stay on the direct
transaction lane. Intake and storage queue depths/fixed failure counts are
visible in `memoryStorage`; no input contents are part of those metrics.

`createAsyncMemoryExtractionScheduler` uses this asynchronous transaction
contract directly. Claims are durable before the model starts; attributed patch
and batch ACK commit together on the latest draft after the model finishes.
Retries/recovery retain membership and event times. The synchronous scheduler
export remains a tested compatibility/offline API, not the online bridge path.

Rebuild backups and integrity reports also run in the storage worker. A worker
crash/timeout is uncertain and latches protection. The parent releases only the
terminated worker's private preallocated ticket, never a peer's ticket, journal
or snapshot. Operator recovery is explicit; it never silently replays a write.

`src/memory-rebuild-proposal.js` preserves existing evidence/corrections and
validates each target user's source revision. Unrelated updates survive;
modified target users cause conflict without partial application. New rebuilt
paraphrases are tentative proposals, not independent evidence. The bridge owns
backup and commit, then applies state in place to preserve references held by
other async operations. The CLI supports `--proposal` without writing memory.

Backups materialize a coherent recovered `memory.json`; journal, lock tickets
and initialization markers never enter the backup format. An initialized store
with missing evidence is an error, not a successful empty backup. Existing
backup formats remain readable.
