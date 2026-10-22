# Memory verification and learning upgrade

This upgrade is source/staging work. It does not authorize a live configuration
change, App replacement, data rebuild or QQ test message.

## Invariants

- A contradictory message is a candidate, not proof that either version is true.
- Match subject QQ, conversation, source message and original event time before
  asking a human. Quotes, tools, images and peer bots are not self-assertions.
- Observe first: verification defaults to shadow mode. No private notification or
  automatic memory replacement is allowed in shadow mode.
- Explicit memory administrators are separate from QQ group roles. Group-scoped
  reviewers must never see another group's cases or private conversation memory.
- Decisions identify one case and its expected target revision. Recheck authority
  and revision inside the existing durable transaction. Never arrival-wins.
- Retain old values, sources and corrections. Administration is not self-evidence.
- Quiet still collects/analyzes; it suppresses group sends and, by default,
  unsolicited private verification notifications originating from that group.
- Group-shared cases have one notification ledger, not one per carrier account.
  Claim before wire; an uncertain attempt is never automatically replayed.

## Implementation and acceptance ledger

1. Pure verification cases, evidence attribution, stale-decision protection.
2. Local authenticated APIs and precise QQ commands; bounded private dispatcher.
3. Memory-page evidence comparison, drafts, errors and configuration controls.
4. Opt-in coherent extraction windows, full-message bounds, relevance/validity
   read projections and labelled discussion summaries.
5. Synthetic case replays, actual isolated bridge/API/protocol integration,
   existing memory/account/quiet/UI/backup and release-whitelist regressions.

No existing memory content is disposable test data. Backups continue to capture
the whole coherent memory root, including cases and notification receipts.

### Source/staging acceptance (2026-10-21)

- Verification core: 84 synthetic cases; notifier: 24 checks; coherent learning:
  30 cases; bridge source-bound adapters: 9 checks; verification UI: 77 checks.
- Actual isolated bridge integration: 24 checks using temporary state, a fake
  model and two fake OneBot carriers. Includes the real 30-second dispatcher,
  restart/no-replay, scoped reviewer commands, authorization/config CAS, stale
  evidence, explicit re-review and a separate final decision. No real QQ or
  external model calls.
- Existing memory, multi-account kernel, account isolation, console, config
  revision, API, backup, command, host and release-resource regression checks
  have passed. The optional PDF text-extraction probe remains environment-
  dependent; it is not evidence for this memory change.
- Rendered checks cover desktop light/dark and a 390px narrow layout, pagination,
  escaped untrusted text, conflict feedback and preserved decision drafts.
- A fixed legacy-compatible synthetic 10.3 MB memory workload preserved 24/24
  admitted inputs through forced exit/restart. Health latency P95 was 3.17 ms,
  with a maximum response gap of 122.43 ms (250 ms gate). Durable intake P95
  was 2572.81 ms; this is not a general throughput/size guarantee and does not
  benchmark the new admin list at arbitrary scale.
- Independent scoped review found no remaining confirmed P1/P2 in the corrected
  authorization, dispatch pagination, explicit re-review and `old_invalid`
  lifecycle paths. This is not a claim of perfect semantic conflict detection.

These results accept the source and isolated behavior only. No live config,
memory migration, App deployment, production notification or GitHub push is
part of this acceptance.

### beta.14 deployment verification (2026-10-22)

Following separate explicit authorization, the local App was built and replaced,
and notification mode was enabled through the authenticated, revision-bound
configuration API. Clean-install defaults remain observation-only; deployment
did not change the existing extraction-window opt-in, model/style bindings,
account policies or unrelated configuration.

The deployment exposed an omitted Origin translation in the shared host proxy
for protected config and memory-review mutations. The fix retains both the
public same-origin gate and the bridge session/CAS gate. Host integration now
passes 76 checks, including successful memory config save, unchanged bytes on
denied saves, read-session checks, resolve/review forwarding and cross-origin
rejection. No origin/token bypass was used to enable production notifications.

The final packaged App matches all 53 shared source/UI resources; isolated App
startup, ad-hoc signature verification and DMG checksum validation pass. Local
acceptance confirmed two connected accounts, a writable non-degraded memory
repository and persisted notification settings. A primary protocol handshake
failure was recovered by restarting that protocol container only; login state
was not reset. The previous App, config and coherent memory files were retained
in a private local rollback directory.

Cold replacement preserved the exact prior memory contents. After resuming,
normal background learning continued; acceptance checked that all prior groups,
users and canonical entry IDs/values remained present rather than requiring a
running memory store to remain byte-identical. There were no verification cases
at acceptance, so no artificial production conflict or QQ test notice was made.
Notification delivery is enabled, not claimed proven by a real human conflict.

## Administrator workflow

The existing Memory page contains the verification inbox. Select a group/status,
compare subject QQ, old/new values, original source times and IDs, then choose:

- `update`: endorse a fresh version and supersede the old version.
- `coexist`: supply explicit conditions; both versions remain conditional.
- `new_invalid`: reject the candidate, retaining the valid old information as a
  separately endorsed version. It is not another self-statement.
- `old_invalid`: reject the old assertion, without automatically endorsing NEW.
  The new candidate enters a tentative correction epoch: only genuinely fresh
  evidence from the same subject after the decision can requalify it. Replayed
  keys and late pre-decision events do not count; other cases' holds remain.
- `unsure`: defer, never select a winner because a deadline elapsed.

A changed target or already resolved case returns a conflict. Refresh evidence
and explicitly review it before resubmitting; no mutation automatically retries.
The explicit review uses `/api/memory/verification/review`; it refreshes only the
reviewed case snapshot, not the fact decision. A separate resolve request with
the resulting revision is still required.
Raw arrays, original evidence, terminal corrections and decision history remain.

`memory.verification.shadowMode` defaults to true. Observation stores candidates
only; it does not send private messages or install new verification holds. After
synthetic/replay acceptance, administrators may explicitly select notification
mode in the console. No test action in this page sends QQ messages.

`adminUserIds` names reviewers; `groupAdminUserIds` can override recipients for a
specific raw numeric group ID. An empty list does not grant QQ group roles access.
With no reviewer list, configured bot owners are used. Owners remain authorized
for managed group memory; private conversation evidence is not forwarded through
this group-verification workflow. `notificationAccountIds` optionally pins each
group to one carrier; an unavailable pinned account does not silently fall back.

Each case gets at most one automatic notification attempt. Attempts are claimed
durably before send. Claimed/uncertain attempts survive restart without replay.
The default daily budget is three attempts per group, with a 24-hour cooldown
per subject, plus a receiver-wide maximum of ten attempts/day. Quiet groups and
paused/unavailable carriers do not notify. Notifications require private chats
to be enabled. Explicit reviewer commands alone may bypass the ordinary private
chat target-user filter; account scope and reviewer authorization still apply.

QQ commands (group commands also follow existing `/bot a` / `/bot b` selectors):

```text
/bot memory pending
/bot memory resolve <case-id> update <revision>
/bot memory resolve <case-id> coexist <revision> <explicit conditions>
/bot memory resolve <case-id> unsure <revision>
```

The notification supplies the exact case revision. A bare “yes”/“对” is never a
memory update. Human event time and processing/decision time remain separate.

## Learning rollout and limits

Existing configurations without `memory.learning.enabled: true` retain their
old extraction timing. The new-install template opts into coherent windows; the
Memory page exposes an explicit switch without rewriting the existing values.

Default windows wait for four messages and settled complete turns (five seconds),
or at most two minutes plus the bounded background sweep/model time. A claim
contains at most 16 original messages / 12,000 rendered text characters. A
message may contribute up to 4,000 characters; excerpts preserve head/middle/tail,
explicit omissions and original IDs. A truncated/quoted/non-human source cannot
activate a factual assertion. When archiving is enabled, its full original
remains in the chat archive.
Pinned old batches that exceed a new budget fail safely rather than ACKing
unpresented messages; adjust the budget and retry after inspecting the case.

Read projections rank relevant memories after subject/integrity gates. Explicit
validity intervals suppress expired current-state claims; historical events and
conditions are labelled. Missing old chronology stays unknown. The system does
not invent an expiry date from a vague phrase or delete evidence by age. Discussion
summaries preserve source sequence and label decision/pending cues as unverified
excerpts, not a newly proven conclusion. No vector database, extra per-chat model
call or reply reviewer is introduced.

Per-group case capacity is 512, with bounded patch admissions. Reaching capacity
reports backpressure; it never silently deletes cases. Lists paginate, with at
most 200 previews per page and capped source-ID previews; original evidence is
not truncated in storage. Complex sarcasm/semantic conflicts can still be missed
or misclassified: the model proposes, the source boundary validates attribution,
and humans resolve the meaning. This is not a guarantee of perfect recall.
