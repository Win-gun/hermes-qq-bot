# AGENTS.md

This file is the handoff guide for AI agents working on this project. Read it before editing code.

## Project overview

This is a local QQ bot bridge:

- `src/bridge.js` runs a Node.js service that receives NapCat / OneBot v11 events over WebSocket.
- It calls Hermes for chat replies, optional controlled web search, and optional image recognition.
- It sends replies back to QQ groups and private chats through OneBot.
- `public/admin.html` is the local admin console served by the bridge.
- `config.json` is the live runtime config; `config.example.json` is the safe template.
- `data/memory.json` stores group, member, and bot-self memory.
- `data/chat-archive/` stores local per-conversation JSONL chat archives when enabled.

The service is intended to run locally and expose its control UI only on `127.0.0.1`.

The repository also builds an Apple Silicon Electron desktop app. In packaged mode, code is read-only inside the app bundle and runtime state lives under `~/Library/Application Support/Hermes QQ Bot/`. Never write user state into the app bundle.

## Desktop application

- Electron main process: `desktop/main.cjs`
- Preload allowlist: `desktop/preload.cjs`
- First-run UI: `desktop/setup.html`
- Forge config: `forge.config.cjs`
- Backup/restore core: `src/backup-service.js`
- Distribution guide: `docs/DESKTOP-DISTRIBUTION.md`

Build and targeted verification:

```bash
npm run test:backup
npm run app:package
npm run app:make
```

Packaged runtime roots are provided through `HERMES_QQ_HOME`, `HERMES_QQ_RESOURCE_ROOT`, `HERMES_QQ_LOG_DIR`, and `HERMES_HOME`. Development mode must continue to work without these variables.

Do not add `config.json`, `data/`, logs, protocol state, `.hermesqqbackup` files, screenshots, or current-user absolute paths to Forge packaging. Full backups are encrypted and may contain credentials/login state; never print their password or contents.

## Important paths

- Main service: `src/bridge.js`
- Runtime config: `config.json` in the active state directory
- Example config: `config.example.json`
- Admin page: `public/admin.html`
- Memory store: `data/memory.json` in the active state directory
- Chat archive base: `data/chat-archive/` in the active state directory
- Image cache: `data/images/` in the active state directory
- Bridge logs: `logs/bridge.log` and `logs/bridge.error.log` in the active log directory
- Protocol state/cache: `napcat*/` and `snowluma*/` in the active state directory

Treat `config.json`, `data/memory.json`, `data/chat-archive/`, `napcat*/`, `snowluma*/`, `secrets/`, and `logs/` as potentially sensitive.

## Common commands

Run commands from the project root:

```bash
cd /path/to/hermes-qq-bot
npm run check
node --check src/bridge.js
```

Start manually:

```bash
npm start
```

Check local health:

```bash
curl -s http://127.0.0.1:6200/health
curl -s http://127.0.0.1:6200/api/status
curl -s http://127.0.0.1:6200/api/config
curl -s http://127.0.0.1:6200/api/archive/status
```

Restart the LaunchAgent-managed bridge:

```bash
launchctl kickstart -k gui/$(id -u)/com.codex.qq-hermes-onebot-bridge
```

Login startup is split into two user LaunchAgents:

- `com.codex.qq-hermes-onebot-bridge`: starts and keeps the Node bridge alive.
- `com.codex.qq-hermes-snowluma-bootstrap`: starts Docker Desktop, waits for Docker, starts enabled SnowLuma containers, then wakes the bridge. Its source files are `scripts/start-qq-bot-stack.sh` and `launchd/com.codex.qq-hermes-snowluma-bootstrap.plist`.

Admin console:

```text
http://127.0.0.1:6200/admin
```

NapCat WebUI is usually available locally. Prefer reading the current URL/token from config or status output instead of hardcoding assumptions.

SnowLuma standby WebUI, when enabled, is usually:

```text
http://127.0.0.1:6101
```

Prefer reading the current account/protocol URLs from `/api/status` or the admin page.

## Runtime architecture

The bridge has a few important subsystems in `src/bridge.js`:

- OneBot WebSocket listener.
- Reply decision logic for mentions, keywords, implicit follow-ups, private chats, and proactive participation.
- Per-group reply queue to avoid concurrent spam.
- Hermes chat call path for normal replies.
- Vision path for QQ images.
- Controlled web search path.
- Local chat archive, lightweight archive index, archive snippets, and archive export/clear APIs.
- Continuous-message debounce/merge before reply generation.
- Memory extraction, merge, compaction, and bot-self memory.
- Evidence-bound canonical memory keyed by QQ user ID, with conflict and supersession tracking.
- Adaptive reply reviewer that checks high-risk drafts without exposing reasoning traces.
- Persistent background task runtime under `data/tasks/`, separated from the normal reply queue.
- Multi-account routing/failover for primary and standby protocol clients.
- Local control API and admin page endpoints.

When changing behavior, prefer updating the relevant config defaults and keeping the runtime configurable from the admin page where practical.

## Current model setup

The intended setup is:

- Daily chat: DeepSeek `deepseek-v4-flash` via Hermes, with reasoning effort enabled in Hermes config.
- Image recognition: Xiaomi/MiMo `mimo-v2.5` via Hermes vision toolset.

Do not put API keys directly into source files, `config.example.json`, docs, logs, or final answers. The live system should use Hermes auth or environment variables. If a user pasted a key in conversation or a local config contains one, treat it as secret.

## Configuration rules

Use `config.example.json` for documented defaults and `config.json` for the live service.

When editing `config.json`:

- Keep JSON valid; verify with `jq empty config.json`.
- Avoid deleting existing user-tuned fields.
- Back up before risky live changes:

  ```bash
  cp config.json "config.json.bak.$(date -u +%Y-%m-%dT%H-%M-%S)"
  ```

- Do not store plaintext API keys. Store environment variable names or rely on Hermes auth.
- Keep `control.host` on `127.0.0.1` unless the user explicitly asks for LAN/public exposure and security is addressed.

Hot-reloadable areas generally include AI/model settings, prompt, behavior/activity settings, memory settings, web search, and vision settings. WebSocket host/port/path and control host/port usually need a bridge restart.

Live `config.json` is ignored by Git because it may contain account IDs, local tokens, provider settings, or other sensitive runtime state. Put safe documented defaults in `config.example.json`.

## Chat archive rules

The chat archive is local evidence/context, not a replacement for structured memory.

When enabled, archive files are written under:

- Group chat: `data/chat-archive/groups/<groupId>/messages.jsonl`
- Private chat: `data/chat-archive/private/<userId>/messages.jsonl`
- Metadata: same directory `index.json`, `summary.json`, and optional `media/`

Archive records can include:

- User messages and bot replies.
- Message time, sender ID/name/card, mentions, quoted messages, and text.
- Image refs and local image paths/descriptions when the vision path can produce them.
- Web search query, provider, summary, conclusion, sources, and uncertainty.

Important archive APIs:

```bash
curl -s http://127.0.0.1:6200/api/archive/status
curl -s http://127.0.0.1:6200/api/archive/conversations
curl -OJ "http://127.0.0.1:6200/api/archive/export?conversation_id=group:123456"
```

Archive management commands inside QQ:

```text
/bot archive status
/bot archive on
/bot archive off
/bot archive clear confirm
```

Rules for agents:

- Do not print or commit archive contents unless explicitly requested.
- Keep archive paths ignored by Git.
- Preserve privacy-filter behavior and avoid putting obvious passwords, verification codes, phone numbers, ID cards, bank cards, or detailed addresses into structured memory.
- When changing archive format, keep old JSONL records readable and make `index.json` regeneration best-effort.

## Message debounce and reply timing

The project has a `messageDebounce` subsystem so the bot does not reply to every fragment when a user splits one thought into several messages.

Default behavior:

- `/bot` commands and owner/private control commands are handled immediately.
- Normal chat is buffered by `conversationId + senderId`.
- Short incomplete messages, comma/semicolon endings, and connector endings wait a little longer.
- Clear mentions/questions/search requests wait only briefly.
- The final reply should use the merged text, not just the last fragment.

When editing this logic, preserve:

- Strict quiet mode: `/bot quiet ...` must make the bot actually quiet.
- Per-group reply queue and send delay.
- Reliable handling for direct `@` mentions and owner private commands.

## Memory rules

`data/memory.json` is live behavioral state, not disposable test data.

It contains:

- Group rolling summaries, topics, facts, and feedback state.
- Per-user memory such as aliases, personality profile, preferences, boundaries, strong memes, style, relationships, interaction tips, and quotes.
- Bot-self memory: identity, personality, speech style, capabilities, boundaries, recent bot messages, and notable bot messages.

When modifying memory code:

- Preserve backward compatibility with old fields such as `profile`, `memes`, `style`, and `preferences`.
- Redact or reject obvious sensitive data: passwords, verification codes, phone numbers, ID cards, bank cards, and detailed addresses.
- Prefer structured JSON patches from AI memory extraction; discard invalid JSON instead of polluting memory.
- Deduplicate semantically where possible, not just exact text.
- Never mass-delete memory without an explicit backup and user approval.

If implementing a full memory rebuild, provide a dry-run mode before writing back to `data/memory.json`.

Canonical memory is additive. Keep legacy fields intact and prefer `canonicalMemory.entries` only when entries are active, sufficiently confident, and bound to the same QQ user ID. Corrections must target memory IDs; never remove memories using fuzzy substring matching.

## Task mode and reviewer rules

- Formal tasks are stored under `data/tasks/<taskId>/` with `task.json`, `events.jsonl`, and `outputs/`.
- Task execution must stay separate from the chat reply queue so normal chat and status commands remain responsive.
- Non-owner group tasks may only use isolated public-network and text tools. They must never get local files, terminal, computer control, or authenticated browser state.
- Owner local-file, computer, and authenticated-browser permissions are per-task grants. Never infer a previous grant for a new task.
- The task runner brokers explicitly granted file reads/writes and omits general file and terminal toolsets. Keep macOS sandbox execution enabled unless a computer-control grant explicitly requires broader access.
- On restart, active tasks become `interrupted`; do not automatically replay external actions.
- Reviewer output is internal structured JSON. The admin page may show issue codes, timings, and counts, but never chain-of-thought or secret-bearing evidence.
- Keep task and reviewer shadow mode enabled during initial rollout until logs show acceptable false-positive and latency rates.

## Admin console rules

`public/admin.html` is a single-file UI without a frontend framework.

When editing it:

- Avoid inline `onclick` string handlers; prefer DOM APIs and `addEventListener`.
- Add visible error states instead of leaving sections stuck at “加载中”.
- Do not display real API keys.
- Keep restart/destructive actions local-only.
- Validate the embedded script syntax after large edits. A useful pattern is to extract the script and run `node --check` or `vm.Script` against it.

## NapCat and OneBot notes

The bridge listens on:

```text
ws://127.0.0.1:6199/onebot
```

If NapCat runs in Docker, the reverse WebSocket URL often needs:

```text
ws://host.docker.internal:6199/onebot
```

Do not casually edit files under `napcat/`; they include login state, QQ cache, DB files, QR codes, and OneBot configs. Use admin APIs or NapCat WebUI when possible.

Login status should be obvious when login is invalid. When login is valid, avoid spamming the console/admin page with QR codes.

## Multi-account and SnowLuma notes

The primary account is normally NapCat. Standby A can be NapCat or SnowLuma depending on `config.json`.

Current design expectations:

- Primary account display name: `Eraser的小跟班`.
- Standby account display name: `Eraser的小跟班2`.
- When primary is healthy, standby should not participate in chat.
- Failover should only occur when the active account is strongly unhealthy and the standby account is verified enough to send/receive.
- Avoid frequent account flapping. Prefer strong evidence from OneBot status, send checks, received messages, and peer/owner diagnostics.
- Do not auto-refresh/restart both primary and standby protocol clients at the same time. QR refresh/restart logic should use global mutex/cooldown protection.

NapCat reverse WebSocket commonly points to:

```text
ws://host.docker.internal:6199/onebot
```

SnowLuma standby usually uses forward WebSocket from bridge to SnowLuma:

```text
ws://127.0.0.1:6301
```

For SnowLuma login, prefer opening its WebUI. Do not assume its QR code file path is the same as NapCat.

## Reply behavior expectations

The bot should feel like an active but socially aware group member:

- Reply reliably to `@` mentions, private chats, explicit bot names, and likely follow-ups to its own messages.
- When several people talk to it at once, process each relevant message in order through the queue.
- Participate in discussion when useful, but reduce replies to unrelated chat.
- Merge consecutive fragments from the same user before replying when possible.
- Avoid self-talk when no human has spoken recently.
- Respect negative feedback such as “话真密”, “谁问你了”, “别插嘴”, and reduce proactive behavior for that group.
- Admit uncertainty and missing capabilities; do not invent model identity, permissions, search results, or image contents.

Keep these expectations intact when tuning probabilities or prompts.

## Search and vision behavior

Web search is controlled and should usually acknowledge before searching. Search query generation should be specific and context-aware, and should prefer Google through the configured local proxy with Baidu fallback if needed.

The AI search judge can classify search as `web`, `weather`, `url`, or `news`. Treat `news` as a web search mode with time-sensitive expectations unless a dedicated provider exists.

Vision should only be used when images are present and the user asks about them or the context clearly needs image understanding. The vision path downloads or maps QQ images locally, may compress large images, and then calls the configured vision model.

## Testing checklist

For code changes:

```bash
node --check src/bridge.js
npm run check
```

For config changes:

```bash
jq empty config.json
curl -s http://127.0.0.1:6200/api/config
```

For service health after restart:

```bash
launchctl kickstart -k gui/$(id -u)/com.codex.qq-hermes-onebot-bridge
sleep 5
curl -s http://127.0.0.1:6200/health
```

For admin page changes:

- Open `http://127.0.0.1:6200/admin`.
- Confirm status cards load.
- Confirm memory list loads.
- Confirm QR is hidden when QQ login is healthy and visible when login needs attention.
- Check browser console for JavaScript errors if using browser automation.
- Confirm the “聊天存档” page loads if archive-related code changed.

For model changes:

- Use `/api/ai/test` or the admin console model test.
- Confirm API key values are not returned in API responses or logs.
- Confirm normal chat and image recognition still use their intended separate models.

For archive/debounce changes:

```bash
curl -s http://127.0.0.1:6200/api/archive/status
curl -s http://127.0.0.1:6200/api/archive/conversations
```

Then test in QQ with consecutive fragments such as:

```text
我感觉
这个东西
有点问题
你看看怎么改
```

The bot should reply once, after a short wait, using the combined meaning.

## Git hygiene

The repository now has a clean initial baseline commit. Keep Git focused on source, docs, scripts, and safe examples.

Ignored sensitive/runtime paths include:

- `config.json` and `config.json.bak.*`
- `data/`
- `logs/`
- `napcat/` and `napcat-*/`
- `snowluma*/`
- `secrets/`
- temporary memory extraction JSON files

Before committing, check:

```bash
git status --short
git diff --cached --stat
git diff --cached --name-only
```

If Git grows unexpectedly:

```bash
du -sh .git
git count-objects -vH
git fsck --full
```

Do not commit API keys, QQ login material, chat archives, memory dumps, screenshots containing secrets, or protocol client cache/state.

## Style and implementation guidance

- This project currently uses plain Node.js ES modules and only depends on `ws`.
- Avoid adding frameworks or heavy dependencies unless clearly justified.
- Prefer small, reversible patches.
- Keep user-facing Chinese copy natural and concise.
- Preserve existing user changes in `config.json`, `data/memory.json`, and `public/admin.html`.
- Use `rg` for searching.
- Use `apply_patch` for file edits.

## Safety boundaries

Never:

- Leak API keys, QQ tokens, passkeys, cookies, or NapCat login material.
- Print large memory dumps into chat unless the user explicitly asks.
- Delete `data/memory.json`, `napcat/`, or QQ cache/database files without explicit approval.
- Expose the admin console beyond localhost without adding authentication and getting explicit user approval.
- Send QQ messages as a side effect of tests unless the user asked for live messaging.

When in doubt, inspect first, explain the risk briefly, and choose the safer reversible path.
