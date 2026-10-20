import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const VERSION = 1;
const CHUNK_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_CANDIDATES = 1000;
const SAMPLE_BYTES = 4096;
const TEXT_FIELDS = ["text", "rawText", "summary", "query", "senderName", "groupCard",
  "usedConclusion", "uncertainty", "rollingSummary", "botDisplayName"];
const ID_FIELDS = /^(?:conversationId|messageId|senderId|accountId|sourceMessageIds|replyToUserId|ids|mentions|id|time|sentAt|receivedAt|processedAt|searchedAt|updatedAt|file|localPath|source|type|messageType|kind|provider)$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Safe fallback for standalone use. The bridge should supply archiveSafeValue
// and a policyKey containing its privacy switch AND sanitizer revision.
function defaultSanitize(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => defaultSanitize(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([name]) => !FORBIDDEN_KEYS.has(name))
      .map(([name, item]) => [name, defaultSanitize(item, name)]));
  }
  if (typeof value !== "string") return value;
  if (ID_FIELDS.test(key)) return value;
  if (/(?:password|passkey|secret|token|cookie|authorization|api.?key|密码|密钥)/i.test(key)) return "[已过滤]";
  return value
    .replace(/https?:\/\/\S+/gi, "[链接]")
    .replace(/\b1[3-9]\d{9}\b/g, "[手机号]")
    .replace(/\b\d{17}[\dXx]\b/g, "[身份证]")
    .replace(/\b\d{12,19}\b/g, "[长数字]")
    .replace(/(密码|口令|验证码|token|密钥|secret|password|code)[:：= ]{0,4}[A-Za-z0-9._\-]{4,}/gi, "$1=[已过滤]")
    .replace(/(住址|地址|宿舍|寝室)[:： ]?[^，。！？!?\n]{6,80}/g, "$1=[已过滤]");
}

function normalize(value) {
  return String(value).normalize("NFC").toLowerCase();
}

// Shared search/display text, including image descriptions, quoted contexts and
// source evidence. Preserve original case/Unicode; callers sanitize the record
// before extraction and normalize explicitly when comparing or indexing it.
export function archiveRecordText(record) {
  const strings = [];
  function collect(value) {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (!FORBIDDEN_KEYS.has(key) && !ID_FIELDS.test(key) && !/^(?:url|link|localPath|file)$/.test(key)) collect(item);
      }
    }
  }
  for (const key of TEXT_FIELDS) collect(record[key]);
  for (const image of Array.isArray(record.images) ? record.images : []) collect(image?.description);
  for (const source of Array.isArray(record.sources) ? record.sources : []) {
    collect(source?.title);
    collect(source?.snippet);
  }
  for (const context of Array.isArray(record.quotedMessage?.contexts) ? record.quotedMessage.contexts : []) {
    collect(context?.text);
    collect(context?.senderName);
  }
  return strings.join("\n");
}

function grams(text) {
  const chars = Array.from(text);
  const result = new Set();
  for (let i = 0; i < chars.length; i += 1) {
    if (!/\s/u.test(chars[i])) result.add(`u:${chars[i]}`);
    if (i + 1 < chars.length) result.add(`b:${chars[i]}${chars[i + 1]}`);
  }
  return result;
}

function id(value) {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? String(value) : "";
}

function sanitize(record, callback) {
  const safe = callback(record);
  if (safe && typeof safe.then === "function") throw new Error("Archive sanitizer must be synchronous");
  return safe && typeof safe === "object" && !Array.isArray(safe) ? safe : null;
}

function statFile(fd) {
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsupported archive file");
  return { dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs),
    size: Number(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs) };
}

function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.birth === b.birth;
}

function sameSnapshot(a, b) {
  return sameIdentity(a, b) && a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime;
}

function readBytes(fd, offset, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = fs.readSync(fd, buffer, read, length - read, offset + read);
    if (!count) throw new Error("Archive changed while reading");
    read += count;
  }
  return buffer;
}

// Bounded prefix/middle/tail anchors detect ordinary truncate/rewrite/regrow.
// Same-inode growth is assumed append-only; arbitrary concurrent interior edits
// require a rebuild (delete the cache), not an expensive full-file hash/query.
function anchors(fd, size) {
  const width = Math.min(SAMPLE_BYTES, size);
  return [...new Set([0, Math.max(0, Math.floor((size - width) / 2)), size - width])]
    .map((offset) => hash(readBytes(fd, offset, width)));
}

function parseRecord(buffer, offset) {
  try {
    let text = buffer.toString("utf8");
    if (offset === 0) text = text.replace(/^\uFEFF/, "");
    const record = JSON.parse(text);
    return record && typeof record === "object" && !Array.isArray(record) ? record : null;
  } catch { return null; }
}

// Never read the JSONL as a whole. Memory is bounded by a chunk + one line.
function scanLines(fd, start, size, visit) {
  const chunk = Buffer.alloc(CHUNK_BYTES);
  let parts = [];
  let length = 0;
  let lineStart = start;
  let completeBytes = start;
  function add(part) {
    length += part.length;
    if (length > MAX_RECORD_BYTES) throw new Error("Archive line exceeds 8 MiB safety limit");
    if (part.length) parts.push(part);
  }
  for (let position = start; position < size;) {
    const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
    if (!count) throw new Error("Archive changed while indexing");
    let cursor = 0;
    for (let end = chunk.indexOf(10, cursor); end >= 0 && end < count; end = chunk.indexOf(10, cursor)) {
      add(chunk.subarray(cursor, end));
      visit(Buffer.concat(parts, length), lineStart);
      lineStart = position + end + 1;
      completeBytes = lineStart;
      parts = [];
      length = 0;
      cursor = end + 1;
    }
    // Copy because the next read reuses chunk; offsets are bytes, not JS chars.
    add(Buffer.from(chunk.subarray(cursor, count)));
    position += count;
  }
  if (length) visit(Buffer.concat(parts, length), lineStart);
  return completeBytes;
}

function validateIndex(index, sourceKey, policy) {
  if (index?.version !== VERSION || index.sourceKey !== sourceKey || index.policy !== policy
    || !index.source || !Number.isSafeInteger(index.source.size) || index.source.size < 0
    || !["dev", "ino", "birth", "mtime", "ctime"].every((key) => typeof index.source[key] === "string")
    || !Number.isSafeInteger(index.completeBytes) || index.completeBytes < 0 || index.completeBytes > index.source.size
    || !Array.isArray(index.anchors) || !index.anchors.every((item) => /^[a-f0-9]{64}$/.test(item))
    || !Array.isArray(index.rows) || !Array.isArray(index.postings)) return false;
  let end = -1;
  for (const row of index.rows) {
    if (!Array.isArray(row) || row.length !== 3 || !Number.isSafeInteger(row[0]) || !Number.isSafeInteger(row[1])
      || row[0] <= end || row[1] <= 0 || row[1] > MAX_RECORD_BYTES || row[0] < 0
      || row[0] > index.source.size - row[1] || !/^[a-f0-9]{64}$/.test(row[2])) return false;
    end = row[0] + row[1];
  }
  const seen = new Set();
  for (const entry of index.postings) {
    if (!Array.isArray(entry) || entry.length !== 2 || !/^[a-f0-9]{64}$/.test(entry[0])
      || seen.has(entry[0]) || !Array.isArray(entry[1])) return false;
    seen.add(entry[0]);
    let previous = -1;
    for (const rowId of entry[1]) {
      if (!Number.isSafeInteger(rowId) || rowId <= previous || rowId >= index.rows.length) return false;
      previous = rowId;
    }
  }
  return true;
}

function loadIndex(indexPath, sourceKey, policy) {
  let fd;
  try {
    fd = fs.openSync(indexPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const envelope = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!validateIndex(envelope.data, sourceKey, policy) || envelope.digest !== hash(JSON.stringify(envelope.data))) return null;
    return envelope.data;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function saveIndex(indexPath, index) {
  const temporary = `${indexPath}.${randomUUID()}.tmp`;
  try {
    const data = JSON.stringify(index);
    fs.writeFileSync(temporary, `{"digest":"${hash(data)}","data":${data}}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, indexPath);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function addPosting(postings, key, rowId) {
  const digest = hash(key);
  if (!postings.has(digest)) postings.set(digest, []);
  postings.get(digest).push(rowId);
}

function buildIndex(fd, source, previous, sourceKey, policy, sanitizeRecord, tokenize) {
  const index = previous || { version: VERSION, sourceKey, policy, source, completeBytes: 0, rows: [], postings: [] };
  const postings = new Map(index.postings);
  // The unterminated last line may have been valid JSON, invalid JSON, or half
  // a UTF-8 character. Re-read only that line on append, without duplicating it.
  if (previous && index.rows.at(-1)?.[0] >= index.completeBytes) {
    const removedId = index.rows.length - 1;
    index.rows.pop();
    for (const [key, list] of postings) {
      if (list.at(-1) === removedId) list.pop();
      if (!list.length) postings.delete(key);
    }
  }
  index.completeBytes = scanLines(fd, index.completeBytes, source.size, (buffer, offset) => {
    const record = parseRecord(buffer, offset);
    if (!record) return; // Malformed/blank JSONL lines never poison later lines.
    const safe = sanitize(record, sanitizeRecord);
    if (!safe) return;
    const rowId = index.rows.length;
    index.rows.push([offset, buffer.length, hash(buffer)]);
    const text = normalize(archiveRecordText(safe));
    for (const gram of grams(text)) addPosting(postings, `text:${gram}`, rowId);
    if (tokenize) {
      const tokens = tokenize(text);
      if (!tokens || typeof tokens === "string" || typeof tokens[Symbol.iterator] !== "function") {
        throw new Error("Archive tokenizer must return an iterable of strings");
      }
      for (const token of new Set(Array.from(tokens).filter((item) => typeof item === "string" && item))) {
        addPosting(postings, `token:${normalize(token)}`, rowId);
      }
    }
    if (id(safe.senderId)) addPosting(postings, `sender:${id(safe.senderId)}`, rowId);
    if (id(safe.messageId)) addPosting(postings, `message:${id(safe.messageId)}`, rowId);
  });
  index.source = source;
  index.anchors = anchors(fd, source.size);
  index.postings = [...postings];
  return index;
}

function termCandidates(term, postings) {
  // Bigrams are necessary (not sufficient) for exact substrings. Single-char
  // queries use unigrams, including astral Han characters. ASCII substrings
  // work too, regardless of an optional tokenizer's stopwords/segmentation.
  const singleChar = Array.from(term).length === 1;
  const keys = [...grams(term)].filter((key) => singleChar || key.startsWith("b:"));
  const lists = keys.map((key) => postings.get(hash(`text:${key}`)) || []).sort((a, b) => a.length - b.length);
  if (!lists.length || !lists[0].length) return [];
  const others = lists.slice(1).map((list) => new Set(list));
  return lists[0].filter((rowId) => others.every((list) => list.has(rowId)));
}

/**
 * Synchronous, directory-local, regenerable full-history JSONL search.
 *
 * Options: terms=[], senderIds=[], messageIds=[], maxCandidates=200,
 * tokenize(text) (optional supplemental tokens), sanitizeRecord(record),
 * policyKey (nonempty stable string including privacy mode/sanitizer version).
 * Custom callbacks without policyKey force a rebuild on every query; closure
 * state cannot be fingerprinted safely. With a key, callers MUST change it
 * whenever callback semantics/config change. Callback errors propagate.
 *
 * Selectors are ORed; message IDs rank first, then number of matching terms,
 * then supplemental whole-token matches, sender IDs, newest byte offset.
 * Exact sanitized substring/ID checks
 * precede return. At most maxCandidates JSONL records are read/parsed (hard cap
 * 1000, zero disables the query), not counting an initial/incremental build.
 * Empty selectors/no matches return []; never return unrelated recent text.
 *
 * Returns original record objects when sanitizer is identity; otherwise returns
 * sanitized objects with the same schema. No prompt construction or raw text
 * persistence. Missing file => []; I/O/race/oversized-line errors => throw so
 * the bridge can fall back to its recent-only search. Cache corruption rebuilds.
 * Index metadata/postings live in memory and scale with history; first rebuild
 * is synchronous O(file bytes), append parses only appended/unfinished lines.
 * Gram false positives can consume the bounded candidate budget. This is not
 * exhaustive ranking when matches exceed that budget, nor a general redactor
 * for arbitrary secrets. Supply the bridge's authoritative privacy callback.
 */
export function searchArchiveRecords(messagesPath, options = {}) {
  return searchArchive(messagesPath, options);
}

/**
 * Same selectors/callbacks as searchArchiveRecords; opt-in context packet:
 * {matches: records[], neighbors: [{anchorMessageId, record}], quoted: [...] }.
 * Additional options: neighborWindow=1 (0..2), maxNeighbors=6 (0..12),
 * maxQuoted=6 (0..12), quoteDepth=2 (0..2), conversationId (nonempty string).
 * maxNeighbors + maxQuoted must be <=12; zero disables each expansion.
 * One index load/source fd; matches keep existing ranking/candidate budget.
 * Without conversationId, the first actual match sets the conversation scope;
 * legacy missing IDs are compatible, but explicit different/invalid IDs are not.
 * A legacy-only first match scopes the packet to legacy records only. With an
 * explicit scope, both raw and sanitized conversation IDs must be compatible.
 * Adjacency uses indexed row order, not timestamps: anchor rank, then ascending
 * byte offset within its window; matches are omitted from neighbors. Quotes
 * use sanitized quotedMessage.ids/contexts[].messageId and explicit reply IDs,
 * NEVER inline quoted text as evidence. Each anchor uses deterministic BFS,
 * replyMessageId/replyToMessageId/replyId and replyMessageIds/replyIds are the
 * only additional quote fields. Traversal follows declared ID order, newest
 * valid duplicate ID first, and <=2 hops. The outer
 * anchorMessageId always identifies the root match, not necessarily a direct
 * quote at hop two. Cycles/self-references are suppressed per root.
 * Each relation consumes one output slot, including repeats across roots/roles.
 * Expansion checks at most 4*maxNeighbors neighbor rows + 4*maxQuoted quote
 * posting candidates (<=48); reads are cached within the query. Each traversed
 * record inspects only the first 16 elements per explicit ID field and follows
 * at most 16 distinct IDs. Rejected candidates consume budgets; no unbounded
 * scan to fill quotas. Missing anchor message IDs cannot create relations.
 * Returned records are never augmented with synthetic relationship fields.
 * This is evidence retrieval, NOT permission filtering or semantic resolution.
 */
export function searchArchiveContext(messagesPath, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Invalid archive context options");
  const bounded = (key, fallback, max) => {
    const value = options[key] === undefined ? fallback : options[key];
    if (!Number.isInteger(value) || value < 0 || value > max) throw new TypeError("Invalid archive context budget");
    return value;
  };
  const context = {
    neighborWindow: bounded("neighborWindow", 1, 2), maxNeighbors: bounded("maxNeighbors", 6, 12),
    maxQuoted: bounded("maxQuoted", 6, 12), quoteDepth: bounded("quoteDepth", 2, 2),
    conversationId: options.conversationId
  };
  if (context.maxNeighbors + context.maxQuoted > 12) throw new TypeError("Archive context budget exceeds 12");
  if (context.conversationId !== undefined && (typeof context.conversationId !== "string" || !context.conversationId.length)) {
    throw new TypeError("Invalid archive conversation ID");
  }
  return searchArchive(messagesPath, options, context);
}

function emptyContext() { return { matches: [], neighbors: [], quoted: [] }; }

function readIndexedRecord(fd, index, source, rowId, sanitizeRecord) {
  const [offset, length, digest] = index.rows[rowId];
  // Cache offsets/postings remain untrusted, including for expansion records.
  if (offset > source.size - length || (offset > 0 && readBytes(fd, offset - 1, 1)[0] !== 10)
    || (offset + length < source.size && readBytes(fd, offset + length, 1)[0] !== 10)) {
    throw new Error("Archive index line boundary mismatch");
  }
  const buffer = readBytes(fd, offset, length);
  if (hash(buffer) !== digest) throw new Error("Archive index record mismatch");
  const record = parseRecord(buffer, offset);
  // Preserve identity before invoking even an in-place custom sanitizer.
  const conversationId = record?.conversationId;
  const messageId = id(record?.messageId);
  return { safe: record && sanitize(record, sanitizeRecord), conversationId, messageId };
}

function inConversation(entry, scope) {
  return entry.safe && [entry.conversationId, entry.safe.conversationId]
    .every((value) => value === undefined || (typeof value === "string" && value === scope));
}

function quoteIds(record) {
  const result = new Set();
  const add = (value) => { const key = id(value); if (key && key.length <= 1024 && result.size < 16) result.add(key); };
  const list = (value) => { if (Array.isArray(value)) for (let i = 0; i < Math.min(value.length, 16); i += 1) add(value[i]); };
  list(record.quotedMessage?.ids);
  const contexts = record.quotedMessage?.contexts;
  if (Array.isArray(contexts)) for (let i = 0; i < Math.min(contexts.length, 16); i += 1) add(contexts[i]?.messageId);
  for (const key of ["replyMessageId", "replyToMessageId", "replyId"]) add(record[key]);
  for (const key of ["replyMessageIds", "replyIds"]) list(record[key]);
  return [...result];
}

function expandContext(matches, matchRows, index, postings, read, settings, scope) {
  const packet = { matches, neighbors: [], quoted: [] };
  const matched = new Set(matchRows);
  let neighborAttempts = 0;
  let quoteAttempts = 0;
  for (const root of matchRows) {
    const anchor = read(root);
    const anchorMessageId = id(anchor.safe.messageId);
    if (!anchorMessageId || anchor.messageId !== anchorMessageId) continue;
    if (packet.neighbors.length < settings.maxNeighbors && settings.neighborWindow) {
      for (let row = Math.max(0, root - settings.neighborWindow); row <= Math.min(index.rows.length - 1, root + settings.neighborWindow); row += 1) {
        if (matched.has(row)) continue;
        if (packet.neighbors.length >= settings.maxNeighbors || neighborAttempts >= settings.maxNeighbors * 4) break;
        neighborAttempts += 1;
        const entry = read(row);
        if (inConversation(entry, scope)) packet.neighbors.push({ anchorMessageId, record: entry.safe });
      }
    }
    if (!settings.quoteDepth || packet.quoted.length >= settings.maxQuoted) continue;
    const visitedRows = new Set([root]);
    const visitedIds = new Set([anchorMessageId]);
    const frontier = [{ entry: anchor, depth: 0 }];
    for (let cursor = 0; cursor < frontier.length; cursor += 1) {
      const node = frontier[cursor];
      if (node.depth >= settings.quoteDepth) continue;
      for (const reference of quoteIds(node.entry.safe)) {
        if (visitedIds.has(reference) || packet.quoted.length >= settings.maxQuoted || quoteAttempts >= settings.maxQuoted * 4) continue;
        visitedIds.add(reference);
        const rows = postings.get(hash(`message:${reference}`)) || [];
        for (let i = rows.length - 1; i >= 0 && quoteAttempts < settings.maxQuoted * 4; i -= 1) {
          quoteAttempts += 1;
          const row = rows[i];
          if (visitedRows.has(row)) continue;
          visitedRows.add(row);
          const entry = read(row);
          // A hash posting alone is NOT evidence of a message/quote identity.
          if (!inConversation(entry, scope) || entry.messageId !== reference || id(entry.safe.messageId) !== reference) continue;
          packet.quoted.push({ anchorMessageId, record: entry.safe });
          frontier.push({ entry, depth: node.depth + 1 });
          break; // one actual record per declared message ID/root
        }
      }
    }
  }
  return packet;
}

function searchArchive(messagesPath, {
  terms = [], senderIds = [], messageIds = [], maxCandidates = 200,
  tokenize, sanitizeRecord = defaultSanitize, policyKey
} = {}, context) {
  if (![terms, senderIds, messageIds].every(Array.isArray)) throw new TypeError("Archive selectors must be arrays");
  if (typeof sanitizeRecord !== "function" || (tokenize !== undefined && typeof tokenize !== "function")) {
    throw new TypeError("Archive callbacks must be functions");
  }
  const limit = Math.min(MAX_CANDIDATES, Math.max(0, Math.floor(Number(maxCandidates))));
  if (!Number.isFinite(limit)) throw new TypeError("Invalid archive candidate limit");
  const queryTerms = [...new Set(terms.filter((term) => typeof term === "string").map(normalize).map((term) => term.trim()).filter(Boolean))];
  const users = new Set(senderIds.map(id).filter(Boolean));
  const messages = new Set(messageIds.map(id).filter(Boolean));
  if (!limit || (!queryTerms.length && !users.size && !messages.size)) return context ? emptyContext() : [];
  let realPath;
  try { realPath = fs.realpathSync(messagesPath); }
  catch (error) { if (error.code === "ENOENT") return context ? emptyContext() : []; throw error; }
  const sourceKey = hash(realPath);
  const indexPath = path.join(path.dirname(realPath), "search-index.json");
  if (realPath === indexPath) throw new Error("Archive source cannot be its search index");
  const explicitKey = typeof policyKey === "string" && policyKey.length > 0;
  const customCallbacks = sanitizeRecord !== defaultSanitize || tokenize !== undefined;
  const policy = hash(JSON.stringify([VERSION, explicitKey ? policyKey : customCallbacks ? randomUUID() : "safe-default-v1",
    String(sanitizeRecord), tokenize ? String(tokenize) : "builtin-grams-v1"]));
  const fd = fs.openSync(realPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const source = statFile(fd);
    let index = loadIndex(indexPath, sourceKey, policy);
    if (index && (!sameIdentity(index.source, source) || source.size < index.source.size
      || (source.size === index.source.size && !sameSnapshot(index.source, source))
      || JSON.stringify(index.anchors) !== JSON.stringify(anchors(fd, index.source.size)))) index = null;
    if (!index || !sameSnapshot(index.source, source)) {
      index = buildIndex(fd, source, index, sourceKey, policy, sanitizeRecord, tokenize);
      assertUnchanged(fd, realPath, source);
      saveIndex(indexPath, index);
    }
    const postings = new Map(index.postings);
    const scores = new Map();
    const add = (rowId, dimension) => {
      if (!scores.has(rowId)) scores.set(rowId, [0, 0, 0, 0]);
      scores.get(rowId)[dimension] += 1;
    };
    for (const term of queryTerms) {
      const wholeTokenMatches = new Set(postings.get(hash(`token:${term}`)) || []);
      for (const rowId of termCandidates(term, postings)) {
        add(rowId, 1);
        if (wholeTokenMatches.has(rowId)) add(rowId, 2);
      }
    }
    for (const user of users) for (const rowId of postings.get(hash(`sender:${user}`)) || []) add(rowId, 3);
    for (const message of messages) for (const rowId of postings.get(hash(`message:${message}`)) || []) add(rowId, 0);
    const selected = [...scores].sort((a, b) => {
      for (let dimension = 0; dimension < 4; dimension += 1) {
        const delta = b[1][dimension] - a[1][dimension];
        if (delta) return delta;
      }
      return b[0] - a[0];
    }).slice(0, limit);
    const result = [];
    const matchRows = [];
    const records = new Map();
    const read = (rowId) => {
      if (!records.has(rowId)) records.set(rowId, readIndexedRecord(fd, index, source, rowId, sanitizeRecord));
      return records.get(rowId);
    };
    let scope = context?.conversationId;
    let scoped = scope !== undefined;
    for (const [rowId] of selected) {
      const entry = read(rowId);
      const safe = entry.safe;
      if (!safe) continue;
      const text = normalize(archiveRecordText(safe));
      if (!(queryTerms.some((term) => text.includes(term)) || users.has(id(safe.senderId)) || messages.has(id(safe.messageId)))) continue;
      if (context) {
        const candidateScope = scoped ? scope : entry.conversationId;
        if (!inConversation(entry, candidateScope)) continue;
        scope = candidateScope;
        scoped = true;
        matchRows.push(rowId);
      }
      result.push(safe);
    }
    const output = context ? expandContext(result, matchRows, index, postings, read, context, scope) : result;
    assertUnchanged(fd, realPath, source);
    return output;
  } finally { fs.closeSync(fd); }
}

function assertUnchanged(fd, realPath, source) {
  if (!sameSnapshot(source, statFile(fd))) throw new Error("Archive changed during search");
  const stat = fs.statSync(realPath, { bigint: true });
  if (String(stat.dev) !== source.dev || String(stat.ino) !== source.ino || Number(stat.size) !== source.size
    || String(stat.mtimeNs) !== source.mtime || String(stat.ctimeNs) !== source.ctime) {
    throw new Error("Archive replaced during search");
  }
}
