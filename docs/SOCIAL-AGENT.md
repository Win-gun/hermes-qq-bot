# Personality continuity and autonomous social Agent

## Status and boundaries

This is an additive, opt-in source upgrade. It does not authorize App replacement,
production policy changes, real QQ test messages or cross-conversation contact.
Every existing account remains off unless an administrator explicitly enables it
for named conversations. The existing model and reasoning settings stay unchanged.
The implementation is original; reference projects inform behavior, not runtime
dependencies or imported character identities.

Personality is the administrator's stable account-owned prompt. Optional profile
fields describe identity, self-name, expression, interests, boundaries and examples.
Copying a personality remains a detached snapshot. Emotion is simulated interaction
state, not a claim of consciousness or permission to change a core personality.
No generic framework personality should override a deliberately blank or custom
account prompt. Accurate answers and actual tool receipts take priority over acting.

## State and execution contracts

- Social state belongs to logical identities, not nicknames, account-array order
  or primary/standby labels. Independent bots are isolated; explicit failover
  carriers share their one logical identity. Conversation projections remain
  scoped, including private chats.
- Published memory is read-only. Persist through the existing background writer's
  synchronous latest-draft transaction; run models and tools outside it. Keep
  source message IDs, real event time, receipt time and audit provenance separate.
- Mood returns toward baseline with a two-hour half-life, including downtime.
  Replayed or quoted messages must not count as fresh self-evidence. Inferred
  habits require three distinct interactions across two dates; proposals never
  authorize core persona, capability or value changes.
- Ordinary drafts are not sends. Autonomous actions use the shared reply/send
  coordinator, rechecking logical identity, policy/control revision and quiet
  after every persistence await and immediately before wire. Store actual bot
  experiences only after confirmed delivery; uncertain attempts are not replayed.
- Read watermarks acknowledge only actually exposed sequence numbers, never QQ
  message IDs or unseen newer messages. Partial previews are labelled, unread
  capacity is backpressure rather than silent deletion.
- Scoped tools cannot grant terminal, file, authenticated-browser or computer
  access. Public research must not upload raw private chat. Formal tasks retain
  their existing independent permissions and approval rules.
- One-time future social actions re-evaluate relevance at execution, expire by
  default within 24 hours and remain visible/cancellable under the owning bot.
  Restart/restore must pause pending contact rather than replaying old drafts.

## Contact and cost policy

Cross-conversation contact requires BOTH an explicit administrator route policy
and current consent from the target's verified QQ identity. Familiarity does not
grant consent. A bot must already have a real private relationship and confirmed
friendship; an unavailable friendship check fails closed. Never auto-add friends
or transfer another bot's relationship, third-party messages or private secrets.

Initial unsolicited private contact is capped at once per recipient/day. Do not
follow up when unanswered. Default quiet hours are 22:00–09:00 Asia/Shanghai;
explicit reminders follow normal automation. Source-group quiet cannot be evaded
by moving to private chat. Revocation wins even after a plan was claimed. No
guilt, jealousy, exclusivity or emotional leverage is used to obtain attention.

Policy defaults: disabled, observation-only, no allowed conversations or contact
routes; at most 1,000 autonomous model calls/logical bot/day, eight tool calls per
turn, 60 seconds per turn, two global planning lanes and one lane/bot/conversation.
Actual usage is distinguished from unknown token usage. Exhausting autonomous
budget must not disable direct replies. No reply-review model is reintroduced.

## Evaluation and rollout

### Source verification checkpoint (2026-10-23)

Implemented: account-owned policy/profile projection, bounded durable continuity,
two-hour mood decay, source-bound habit candidates, exact experience/habit
revocation, autonomous scoped tool planning, unread pagination, one-time social
plans, dual-consent private contact, cancellation/restart/restore fences, local
authenticated CAS APIs and shared-console controls. Direct confirmed replies
also record experiences without a second serial model invocation. An optional
enabled account's background reflection uses the same autonomous budget and
cannot send, search or schedule even if the model requests it. Fixed account
automations (greetings/summaries) continue independently of the social planner.

The generic automation-rule editor now also supports a finite-window `at`
trigger with an explicit UTC offset and stable one-time occurrence ledger.
Social plans remain fresh planning requests, not stored outgoing drafts.
Persona changes are source-bound pending proposals: a local authenticated
administrator must preview and approve them with both proposal/state revisions.
A durable applying claim precedes the atomic account-profile config update;
crashed/uncertain applications cannot be automatically repeated. The original
system-prompt snapshot is retained. These source changes are not a substitute
for the human acceptance gates below.

The synthetic suites cover state/runtime, real isolated bridge HTTP/OneBot/model
adapters, console drafts, backup restoration, and existing account/memory guards.
The local benchmark includes 100 durable background-writer intake samples with
a 1 MiB unrelated synthetic store, in addition to 1,000 projection samples. Its
100 ms P95 gate is local fixture evidence, not a production-load guarantee.
Human blind ratings and real QQ/model pilots remain unperformed. No production
policy, memory, App installation or live messages are changed by these checks.

`npm run test:social-agent` runs synthetic state/runtime/UI/integration tests.
`npm run social:evaluate -- --fixtures` emits 60 fixed synthetic scenarios:
six contrasting personalities × ten situations (praise, criticism, distress,
correction, task, third-party quote, old event, unavailable audio, contact
revocation, peer identity). No live store or model is accessed.

For blind review, collect baseline and candidate replies using the SAME scene,
context and model, shuffle display labels, then record human scores 1–5 for
`personality`, `context`, `naturalness`, `empathy`, `nonIntrusiveness`. Ratings input:

```json
[{"id":"calm:praise","reviewerType":"human","safetyPassed":true,
  "baseline":{"personality":3,"context":3,"naturalness":3,"empathy":3,"nonIntrusiveness":3},
  "candidate":{"personality":4,"context":4,"naturalness":4,"empathy":4,"nonIntrusiveness":4}}]
```

`npm run social:evaluate -- --ratings <local-ratings.json>` returns only aggregate
results. Missing human ratings remain pending. Passing requires all 60 reviewed,
candidate mean ≥4/5 and ≥baseline, with zero safety failures. Synthetic test scores
are NOT evidence of real human acceptance. Keep real conversations out of Git.

Acceptance gates also include zero cross-bot/private leakage, quiet bypass,
unauthorized contact and duplicate delivery; durable watermark/restart safety;
no extra serial direct-reply model call; local continuity P95 overhead ≤100 ms.
Stage off → observation → one explicitly authorized bot/conversation → separately
authorized contact pilot. Source completion alone is not live deployment.

## Research references

- Derpyu520/qq-bridge at `a49877f4e58d04e47532d44b803360d0f001160d`:
  https://github.com/Derpyu520/qq-bridge/tree/a49877f4e58d04e47532d44b803360d0f001160d
  (separation of character and protocol, scoped observation/wait/send tools).
- whyever77/dafeiyu-astrbot at `5d7c7a9bd5f12817df466d18e0ce758ac35b46b5`:
  https://github.com/whyever77/dafeiyu-astrbot/tree/5d7c7a9bd5f12817df466d18e0ce758ac35b46b5
  (grounded experiences, natural expression and truthful tool status).
- Generative Agents, Park et al.: https://arxiv.org/abs/2304.03442
  (observation, memory, reflection and planning; not a guarantee for this bot).

Bilibili video pages returned HTTP 412 during research; no full-video observation
or claim about all viral implementations is made. External proprietary protocol
component licensing is separate from source-code licensing.
