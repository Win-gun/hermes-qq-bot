# Project Memory

## Product direction

- The bot should behave like a socially aware QQ group member: reliable when addressed, selective when unrelated, concise, context-aware, and honest about uncertainty.
- The established persona is the owner's configurable QQ bot nickname: opinionated but not hostile, able to joke lightly, and not constantly emphasizing that it is AI. Preserve each installation's live nickname and style.
- Preserve the three behavior modes (`lively`, `normal`, `restrained`) and existing per-group selections. Mode changes should affect participation thresholds, not replace the persona.

## Architecture decisions

- Keep the bridge as a plain Node.js ES-module service with the existing `ws` dependency; avoid adding frameworks or databases without a demonstrated need.
- Use deterministic rules for commands, owner private messages, direct mentions, quiet mode, and safety boundaries. Use AI social judgment only for ambiguous implicit replies and voluntary discussion participation.
- Keep `data/memory.json` backward compatible. New self-stances or evidence metadata must be additive and optional.
- Keep local chat archives as evidence and retrieval context, separate from structured memory.
- SnowLuma is the preferred protocol client for both primary and standby accounts. The bridge connects to SnowLuma through forward OneBot WebSockets.

## Operational constraints

- Never store API keys, passwords, QQ login material, WebUI credentials, or tokens in this file.
- Live configuration and runtime data remain ignored by Git.
- Before memory/schema work, back up `data/memory.json`; never mass-delete or rewrite it without an explicit migration and dry-run.
- Quiet mode must still archive and analyze messages while sending nothing.

## Known issues and lessons

- Chat archive writes have emitted `extractReplyIds is not defined`; archive reliability must be repaired before relying on history retrieval metrics.
- The legacy delayed-understanding path schedules many candidates that later skip. Consolidate ambiguous-message waiting instead of layering more timers.
- Prompt growth and conflicting behavioral instructions reduce consistency. Prefer a small stable persona block plus contextual state and a mode-specific response contract.

## Verification baseline

- Run `node --check src/bridge.js`, `npm run check`, JSON validation, and the embedded admin-script syntax check after behavior changes.
- Use dry-run or shadow decisions before switching ambiguous group participation to a new decision path.

## 2026-07-11 social behavior update

- Added an AI social planner for ambiguous implicit replies, discussion participation, and scheduled proactive checks. Commands, owner private messages, direct mentions, quiet mode, and safety rules still bypass it.
- The planner is enabled in live config with `shadowMode=false`. Safe rollback is `socialPlanner.enabled=false`; observation-only rollback is `shadowMode=true`.
- Mode thresholds are intentionally different: lively 0.45, normal 0.58, restrained 0.72. Existing per-group mode selections and the live default lively mode were preserved.
- Delayed-understanding pending work is isolated by conversation and sender, so concurrent users no longer overwrite each other's pending interpretation.
- Added lightweight repeated-opening detection and one rewrite attempt; the established system prompt was kept byte-for-byte unchanged.
- Added optional `botSelf.stances` as an additive memory field. Existing canonical user profiles and old memory fields remain authoritative and compatible.
- Fixed archive reply-id extraction by reusing `extractReplyMessageIds`; dry-run now clones memory and never writes normalization changes back to live memory.
- Validation completed with static checks, six self-tests, two model-backed dry-runs (clear bot follow-up replied; unrelated member exchange observed), admin-page browser QA, and live OneBot health checks.

## 2026-07-14 context-chain diagnosis

- QQ reply metadata is not part of the normal history item or social-planner prompt. Quoted text is fetched only for the vision path, so ordinary quoted replies often reach the planner as a generic `[引用消息]` marker without the quoted sender, text, or whether the target was the bot.
- The implicit-reply detector compares only the latest bot message. It cannot reliably track several people replying to different recent bot messages at the same time.
- Per-sender debounce can discard reply/image metadata from earlier fragments because the flushed item retains only the final OneBot event. It can also let concurrently buffered senders enter runtime history out of chronological order.
- Archive summaries for group chats currently read structured memory using `group:<id>` instead of the normal `<id>` key. This creates an empty parallel group-memory entry and produces blank archive summaries.
- `summarizeOlderHistory()` appends then truncates from the front; after reaching its length limit the rolling summary becomes effectively frozen and newer context is discarded.
- Archive retrieval happens only after the bot has already decided to reply, so it cannot rescue a missed social-planner candidate. Runtime history and `lastBotMessageByGroup` are also not hydrated from archives after a bridge restart.

## 2026-07-14 context-chain repair

- Reply relationships are now first-class context. The bridge resolves quoted OneBot messages into structured sender/text/bot metadata and carries that data through archives, social decisions, final prompts, and dry-run diagnostics.
- Implicit follow-up detection scores several recent bot messages instead of only the latest one. An explicit quote of a bot message is treated as direct address, while quotes of other members remain visible as conversation relationships.
- Debounced fragments retain every source event, image, mention, quote, sender name, and original timestamp. Each raw fragment is archived independently, while reply generation uses one merged semantic message.
- Reply decisions now see other users' still-pending fragments and a small archive retrieval result before deciding whether a message is relevant. This reduces missed replies in concurrent group conversations without lowering all participation thresholds.
- Archive summary lookup uses the real group-memory key, archive snippets preserve recent context plus relevant older matches, rolling summaries keep the newest information, and runtime history/last-bot state hydrate from local archives after restart.
- Live persona text and existing group modes were preserved. Context tuning must not promise perfect natural-language understanding; uncertain messages should use waiting, retrieval, or observation instead of fabricated certainty.
- Regression coverage now includes structured quote resolution, earlier-bot-message matching, debounce metadata preservation, newest-summary retention, correct group summary lookup, and archive hydration ordering.

## 2026-07-21 login startup

- The bridge LaunchAgent already uses `RunAtLoad + KeepAlive`. SnowLuma also needs Docker Desktop and its protocol containers, so a separate bootstrap LaunchAgent is used to start Docker, wait for its API, start enabled SnowLuma containers from live config, and then kickstart the bridge.
- The bootstrap runs on login and every five minutes as a bounded retry. It must not print configuration contents or secrets; Docker unavailability is logged as a retryable condition rather than causing a hot restart loop. Its periodic bridge `kickstart` must not use `-k`, otherwise it would force a disconnect every five minutes.
