# Reliability audit remediation

Version `1.0.0-beta.13` addresses the October 2026 audit. The source changes do
not migrate live state or send QQ test messages. Installing the desktop update
is a separate, explicitly approved deployment step.

## Acceptance matrix

| Area | Required invariant | Regression coverage |
| --- | --- | --- |
| PDF generation | Untrusted task content cannot run scripts or fetch local/network resources; safe text remains printable | `security-regression-self-test.js` |
| Backup/restore | App and Web host transactions, including bridge start/stop, acquire a lock before asynchronous work; only the owner may release it | `security-regression-self-test.js` |
| Task execution | Notification failures cannot leak execution slots or prevent later tasks from running | `security-regression-self-test.js` |
| Account addressing | Independent bots use their own names; legacy aliases stay with their original logical bot | `account-audit-regression-self-test.js` |
| Self memory | Prototype property names cannot return shared inherited objects or functions | `account-audit-regression-self-test.js` |
| Legacy memory compatibility | Startup mirrors legacy fields additively, without trimming or reordering existing portraits, boundaries or memes | `core-audit-regression-self-test.js` |
| Daily scheduling | Distinct schedules have distinct ledger identities; explicit legacy identities remain compatible | `account-audit-regression-self-test.js`, `routine-scheduler-self-test.js` |
| Activity controls | Saved values govern the selected default; explicitly different account/group modes use their own defaults | `core-audit-regression-self-test.js` |
| Form saving | A successful save only acknowledges its submitted snapshot, not edits made while waiting | `console-ui-self-test.js` |
| Archive privacy | Quotes, OCR, search evidence and sensitive URL parameters/fragments obey the archive filter independently of the memory filter | `core-audit-regression-self-test.js` |
| Historical retrieval | Indexed text, OCR, quotes and search evidence remain searchable beyond the recent line/byte window and survive bridge ranking | `archive-search-index-self-test.js`, `core-audit-regression-self-test.js` |
| Config check | `--check` creates no state directories, copies no config and writes no memory | `core-audit-regression-self-test.js` |

Run the focused suite with `npm run test:audit`, and the form interaction suite
with `npm run test:console`. All test inputs must be synthetic; integration
fixtures use isolated temporary state and mocked protocol/model boundaries.

## Compatibility and operational notes

- Existing configuration, account styles, memories and raw JSONL archives are
  not mass-rewritten. Archived evidence is filtered when retrieved into context;
  new archive records also filter quoted and derived text before writing.
- The local `search-index.json` is a disposable cache, not a new source of truth.
  Normal and full backups exclude it; raw JSONL and summaries remain included.
  Older archives are indexed lazily, appends are incremental, and corrupt,
  truncated or replaced files trigger rebuilding. The first full rebuild is
  synchronous and may take longer for large archives. JSONL records over the
  index safety limit fall back to bounded recent retrieval rather than reading
  unbounded input into memory.
- PDF task output is untrusted. Active HTML and externally loaded resources are
  not part of the supported document format. Do not relax renderer isolation to
  restore arbitrary HTML, remote images or scripts.
- Old sensitive content is not silently deleted from original archives or
  backups. Administrators can explicitly export/clear historical data under the
  existing privacy controls.
- Source verification is not deployment verification. Desktop packaging and
  replacement require a separate approved deployment with a rollback copy.
