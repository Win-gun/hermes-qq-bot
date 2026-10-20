import fs from "node:fs";
import path from "node:path";
import { isMainThread, parentPort } from "node:worker_threads";
import { searchArchiveRecords, searchArchiveContext } from "./archive-search-index.js";
import { sanitizeArchiveValue } from "./privacy-filter.js";

const LIMIT_CODES = new Set(["SOURCE_LIMIT", "INDEX_LIMIT", "RESULT_LIMIT"]);

function coded(code) { return Object.assign(new Error(code), { code }); }

// The existing sync implementation has no size hooks. These guards are scoped
// to ONE synchronous request in this private worker's fs module, never the host.
// Bound cache reads before allocation and cache writes before disk publication.
// JSON construction itself is bounded by V8 resourceLimits; not a hard RSS cap.
function search({ kind, file, options, limits, temporary }) {
  if (!["search", "context"].includes(kind)) throw coded("SEARCH_FAILED");
  const source = fs.realpathSync(file);
  if (source !== file) throw coded("SEARCH_FAILED");
  const index = path.join(path.dirname(source), "search-index.json");
  if (source === index || path.dirname(temporary) !== path.dirname(index)
    || !/^search-index\.json\.[a-f0-9-]{36}\.tmp$/.test(path.basename(temporary))) throw coded("SEARCH_FAILED");
  let violation;
  function check(stat, kind) {
    if (!stat.isFile()) throw coded("SEARCH_FAILED");
    if (stat.size > (kind === "source" ? limits.maxSourceBytes : limits.maxIndexBytes)) {
      violation = kind === "source" ? "SOURCE_LIMIT" : "INDEX_LIMIT";
      throw coded(violation);
    }
  }
  check(fs.statSync(source), "source");
  try { check(fs.lstatSync(index), "index"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  const original = Object.fromEntries(["openSync", "closeSync", "readSync", "readFileSync", "writeFileSync", "renameSync", "unlinkSync"]
    .map((name) => [name, fs[name]]));
  const opened = new Map();
  let generated;
  const redirect = (target) => target === generated ? temporary : target;
  fs.openSync = function (target, flags, ...args) {
    const kind = target === source ? "source" : target === index ? "index" : null;
    const fd = original.openSync.call(fs, target,
      kind ? flags | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW : flags, ...args);
    if (kind) {
      try { check(fs.fstatSync(fd), kind); opened.set(fd, kind); }
      catch (error) { original.closeSync.call(fs, fd); throw error; }
    }
    return fd;
  };
  fs.closeSync = function (fd) { opened.delete(fd); return original.closeSync.call(fs, fd); };
  for (const name of ["readSync", "readFileSync"]) {
    fs[name] = function (fd, ...args) {
      if (opened.has(fd)) check(fs.fstatSync(fd), opened.get(fd));
      return original[name].call(fs, fd, ...args);
    };
  }
  fs.writeFileSync = function (target, data, ...args) {
    if (violation) throw coded(violation); // loadIndex catches errors internally
    if (typeof target !== "string" || !target.startsWith(`${index}.`)
      || !/\.[a-f0-9-]{36}\.tmp$/.test(target)) throw coded("SEARCH_FAILED");
    if (Buffer.byteLength(data) > limits.maxIndexBytes) { violation = "INDEX_LIMIT"; throw coded(violation); }
    generated = target;
    return original.writeFileSync.call(fs, temporary, data, ...args);
  };
  fs.renameSync = function (from, to) {
    if (from !== generated || to !== index || violation) throw coded(violation || "SEARCH_FAILED");
    return original.renameSync.call(fs, redirect(from), to);
  };
  fs.unlinkSync = function (target) { return original.unlinkSync.call(fs, redirect(target)); };
  try {
    // Explicit allowlist: no user-provided function, sanitizer or tokenizer.
    const query = {
      terms: options.terms, senderIds: options.senderIds, messageIds: options.messageIds,
      maxCandidates: options.maxCandidates, policyKey: options.policyKey
    };
    if (Object.hasOwn(options, "privacyFilter")) {
      if (typeof options.privacyFilter !== "boolean") throw coded("SEARCH_FAILED");
      const privacyFilter = options.privacyFilter;
      query.sanitizeRecord = (record) => sanitizeArchiveValue(record, { privacyFilter });
      // Function source is identical for both closure states; include BOTH the
      // flag and caller key in an unambiguous versioned cache policy identity.
      query.policyKey = JSON.stringify(["shared-v1", privacyFilter, options.policyKey ?? null]);
    }
    if (kind === "context") {
      for (const key of ["conversationId", "neighborWindow", "maxNeighbors", "maxQuoted", "quoteDepth"]) query[key] = options[key];
    }
    const records = kind === "context" ? searchArchiveContext(source, query) : searchArchiveRecords(source, query);
    if (violation) throw coded(violation);
    if (Buffer.byteLength(JSON.stringify(records)) > limits.maxResultBytes) throw coded("RESULT_LIMIT");
    return records;
  } finally {
    Object.assign(fs, original);
    // The sync search normally closes these; also cover guard failures.
    for (const fd of opened.keys()) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

if (!isMainThread && parentPort) {
  parentPort.on("message", (request) => {
    try { parentPort.postMessage({ type: "ok", id: request.id, kind: request.kind, records: search(request) }); }
    catch (error) {
      parentPort.postMessage({ type: "error", id: request?.id, kind: request?.kind,
        code: LIMIT_CODES.has(error?.code) ? error.code : "SEARCH_FAILED" });
    }
  });
}
