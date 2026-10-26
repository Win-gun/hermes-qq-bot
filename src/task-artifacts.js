import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function safeName(value, fallback = "任务结果.pdf") {
  const name = path.basename(String(value || "")).replace(/[^\p{L}\p{N}_. -]/gu, "-").slice(0, 120);
  return name || fallback;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function taskRequestsPdf(task = {}) {
  return /\bpdf\b|PDF|\.pdf(?:\s|$)/i.test([
    task.objective,
    task.summary,
    ...asArray(task.expectedArtifacts)
  ].filter(Boolean).join("\n"));
}

function markdownBody(source) {
  const pandoc = ["/usr/local/bin/pandoc", "/opt/homebrew/bin/pandoc"].find((item) => fs.existsSync(item));
  if (pandoc) {
    // Never enable raw HTML/attributes or filters for untrusted task output.
    // CSP below blocks resources generated from Markdown links and images too.
    // Pandoc 3.8.3's cmark-based gfm reader still emits raw HTML with -raw_html.
    // Use its strict Markdown reader with only the required formatting extensions.
    const result = spawnSync(pandoc, ["--sandbox", "--from=markdown_strict+pipe_tables+fenced_code_blocks+backtick_code_blocks+strikeout-raw_html-raw_attribute", "--to=html5"], {
      input: source,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024
    });
    if (result.status === 0 && String(result.stdout || "").trim()) return String(result.stdout);
  }
  // Missing/unsupported Pandoc fails closed to text, not to an HTML reader.
  return `<pre>${escapeHtml(source)}</pre>`;
}

function chromeBinary() {
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].find((item) => fs.existsSync(item)) || "";
}

function validPdf(filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 5) return false;
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(5);
    fs.readSync(fd, header, 0, 5, 0);
    return header.toString("ascii") === "%PDF-";
  } finally {
    fs.closeSync(fd);
  }
}

function renderPdfWithChrome(source, targetPath) {
  const chrome = chromeBinary();
  if (!chrome) return { ok: false, error: "未找到 Chrome/Edge PDF 渲染器" };
  const body = markdownBody(source);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-pdf-"));
  const htmlPath = path.join(workDir, ".task-pdf-render.html");
  const profileDir = path.join(workDir, ".task-pdf-profile");
  const html = pdfHtml(body);
  let result;
  try {
    fs.writeFileSync(htmlPath, html, { mode: 0o600 });
    fs.mkdirSync(profileDir, { mode: 0o700 });
    result = spawnSync(chrome, chromeArgs(htmlPath, profileDir, targetPath), { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  if (result.status !== 0 || !validPdf(targetPath)) {
    return { ok: false, error: String(result.stderr || `Chrome 退出码 ${result.status}`).trim().slice(-800) };
  }
  return { ok: true };
}

function pdfHtml(body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>
    @page{size:A4;margin:16mm 15mm 18mm}body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#172033;font-size:13px;line-height:1.7}h1{font-size:25px;border-bottom:2px solid #3b82f6;padding-bottom:8px}h2{font-size:19px;margin-top:24px;color:#1d4ed8}h3{font-size:16px;margin-top:18px}table{width:100%;border-collapse:collapse;margin:12px 0;font-size:12px}th,td{border:1px solid #cbd5e1;padding:7px;vertical-align:top}th{background:#eff6ff}blockquote{margin:12px 0;padding:8px 14px;border-left:4px solid #60a5fa;background:#f8fafc;color:#475569}code{font-family:ui-monospace,monospace;background:#f1f5f9;padding:1px 4px;border-radius:4px}pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:12px;border-radius:8px}img{max-width:100%}a{color:#2563eb}li{margin:3px 0}
  </style></head><body>${body}</body></html>`;
}

function chromeArgs(htmlPath, profileDir, targetPath) {
  return [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-extensions",
      // Page JavaScript is denied by CSP above. Chrome's print CLI itself needs
      // scriptEnabled; disabling it globally exits 0 without producing a PDF.
      "--host-resolver-rules=MAP * ~NOTFOUND",
      "--proxy-server=http://127.0.0.1:9",
      "--proxy-bypass-list=<-loopback>",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDir}`,
      `--print-to-pdf=${targetPath}`,
      "--no-pdf-header-footer",
      pathToFileURL(htmlPath).href
    ];
}

export function ensureRequestedTaskArtifacts({ task, artifacts = [], outputsDir, maxArtifactBytes = 20 * 1024 * 1024 }) {
  const requestedPdf = taskRequestsPdf(task);
  if (!requestedPdf) return { ok: true, requestedPdf: false, artifacts };

  const existingPdf = artifacts.find((item) => path.extname(item.name || "").toLowerCase() === ".pdf" && validPdf(path.join(outputsDir, item.name)));
  if (existingPdf) return { ok: true, requestedPdf: true, pdfCreated: true, artifacts: [existingPdf] };

  const sourceArtifact = artifacts.find((item) => /\.(?:md|markdown|txt|html?)$/i.test(item.name || ""))
    || artifacts.find((item) => path.extname(item.name || "").toLowerCase() === ".pdf");
  const sourcePath = sourceArtifact ? path.join(outputsDir, sourceArtifact.name) : "";
  const source = sourcePath && fs.existsSync(sourcePath)
    ? fs.readFileSync(sourcePath, "utf8")
    : String(task.resultSummary || task.summary || "").trim();
  if (!source) return { ok: false, requestedPdf: true, pdfCreated: false, artifacts, error: "模型没有返回可转换为 PDF 的正文" };

  const requestedName = asArray(task.expectedArtifacts).find((item) => /\.pdf$/i.test(String(item))) || "任务结果.pdf";
  const pdfName = safeName(requestedName).replace(/(?:\.[^.]+)?$/, ".pdf");
  const pdfPath = path.join(outputsDir, pdfName);
  const rendered = renderPdfWithChrome(source, pdfPath);
  if (!rendered.ok) return { ...rendered, requestedPdf: true, pdfCreated: false, artifacts };
  const size = fs.statSync(pdfPath).size;
  if (size > maxArtifactBytes) {
    fs.rmSync(pdfPath, { force: true });
    return { ok: false, requestedPdf: true, pdfCreated: false, artifacts, error: `PDF 超过大小限制（${size} bytes）` };
  }
  return {
    ok: true,
    requestedPdf: true,
    pdfCreated: true,
    artifacts: [{ name: pdfName, type: "application/pdf", size }]
  };
}

function artifactError(code) {
  return Object.assign(new Error(code), { code, ...(code === "TASK_ARTIFACT_ABORTED" ? { name: "AbortError" } : {}) });
}

function artifactName(name) {
  if (typeof name !== "string" || !name || name === "." || name === ".."
    || /[\\/\x00-\x1f\x7f:]/.test(name) || Buffer.byteLength(name) > 255) {
    throw artifactError("TASK_ARTIFACT_UNSAFE_PATH");
  }
  return name;
}

async function firstArtifactBinary(candidates) {
  for (const candidate of candidates) {
    try { await fs.promises.access(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return "";
}

// O_NONBLOCK prevents a raced-in FIFO from blocking a libuv worker indefinitely.
// Read at most limit + 1 bytes even if a regular file grows after fstat.
async function readArtifact(file, limit, check) {
  check();
  const before = await fs.promises.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw artifactError("TASK_ARTIFACT_UNSAFE_FILE");
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino) throw artifactError("TASK_ARTIFACT_UNSAFE_FILE");
    if (stat.size > limit) throw artifactError("TASK_ARTIFACT_SIZE_LIMIT");
    const chunks = [];
    let size = 0;
    while (size <= limit) {
      check();
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw artifactError("TASK_ARTIFACT_SIZE_LIMIT");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const entry = await fs.promises.lstat(file);
    if (!entry.isFile() || entry.dev !== stat.dev || entry.ino !== stat.ino || entry.nlink !== 1
      || after.size !== size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw artifactError("TASK_ARTIFACT_FILE_CHANGED");
    }
    check();
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}

// Never settle on exit/error: close also waits for inherited stdio. There is no
// early-rejection fallback that could race profile removal against a live child.
function runArtifactProcess(command, args, { cwd, input, signal, timeoutMs, killGraceMs,
  maxOutputBytes, spawnProcess, killProcess, outputPath, maxArtifactBytes, checkAuthority }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(artifactError("TASK_ARTIFACT_ABORTED"));
    let child;
    try {
      child = spawnProcess(command, args, {
        cwd, detached: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
        // All renderer-owned HOME/cache/temp state is disposable, never a user's profile.
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: cwd, TMPDIR: cwd, XDG_CONFIG_HOME: cwd, XDG_CACHE_HOME: cwd, LANG: "en_US.UTF-8" }
      });
    } catch { return reject(artifactError("TASK_ARTIFACT_SPAWN_FAILED")); }
    let failure, closed = false, bytes = 0, chunks = [], killTimer, sizeTimer, authorityTimer;
    const killGroup = sig => {
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
      try { killProcess(-child.pid, sig); }
      catch (error) {
        if (error?.code !== "ESRCH") failure ||= artifactError("TASK_ARTIFACT_KILL_FAILED");
      }
    };
    const stop = code => {
      if (closed || failure) return;
      failure = artifactError(code);
      clearTimeout(timer);
      killGroup("SIGTERM");
      if (!closed) killTimer = setTimeout(() => killGroup("SIGKILL"), killGraceMs);
    };
    const abort = () => stop("TASK_ARTIFACT_ABORTED");
    const timer = setTimeout(() => stop("TASK_ARTIFACT_TIMEOUT"), timeoutMs);
    if (checkAuthority) authorityTimer = setInterval(() => {
      try { checkAuthority(); } catch { stop("TASK_ARTIFACT_AUTHORITY_CHANGED"); }
    }, 50);
    // Poll serially (not overlapping stat calls); the definitive size/header
    // validation still happens after close, before anything is published.
    const checkSize = async () => {
      try {
        const stat = await fs.promises.lstat(outputPath);
        if (!closed && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) stop("TASK_ARTIFACT_UNSAFE_FILE");
        else if (!closed && stat.size > maxArtifactBytes) stop("TASK_ARTIFACT_SIZE_LIMIT");
      } catch (error) { if (!closed && error.code !== "ENOENT") stop("TASK_ARTIFACT_OUTPUT_FAILED"); }
      if (!closed && !failure) sizeTimer = setTimeout(checkSize, 50);
    };
    child.on("error", () => stop("TASK_ARTIFACT_SPAWN_FAILED"));
    child.on("close", (code, sig) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(sizeTimer); clearInterval(authorityTimer);
      signal?.removeEventListener("abort", abort);
      // A leader can close successfully while a helper still owns the group.
      // Kill those helpers on BOTH success and failure before cleaning files.
      killGroup("SIGKILL");
      if (signal?.aborted) failure = artifactError("TASK_ARTIFACT_ABORTED");
      if (failure) reject(failure);
      else if (code !== 0 || sig) reject(artifactError("TASK_ARTIFACT_PROCESS_FAILED"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
      chunks = [];
    });
    const collect = (chunk, retain) => {
      if (closed || failure) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxOutputBytes) stop("TASK_ARTIFACT_OUTPUT_LIMIT");
      else if (retain) chunks.push(buffer);
    };
    child.stdout.on("data", chunk => collect(chunk, true));
    child.stderr.on("data", chunk => collect(chunk, false));
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => stop("TASK_ARTIFACT_IO_FAILED"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (outputPath) sizeTimer = setTimeout(checkSize, 50);
    try { child.stdin.end(input || ""); } catch { stop("TASK_ARTIFACT_IO_FAILED"); }
  });
}

/**
 * Async counterpart for the isolated_files finalizer. Cancellation rejects with
 * AbortError/TASK_ARTIFACT_ABORTED; other failures return {ok:false, code, error}.
 * Trusted host-only test seams: spawnProcess/killProcess and findPandoc/findChrome.
 * No caller-supplied browser profile, shell command, flags or HTML is accepted.
 * POSIX process groups are required; unsupported platforms fail closed.
 */
export async function ensureRequestedTaskArtifactsAsync({ task = {}, artifacts = [], outputsDir,
  maxArtifactBytes = 20 * 1024 * 1024, signal, timeoutMs = 90_000, pandocTimeoutMs = 30_000,
  authorizeCheck = () => {},
  killGraceMs = 250, spawnProcess = spawn, killProcess = (pid, sig) => process.kill(pid, sig),
  findPandoc = () => firstArtifactBinary(["/usr/local/bin/pandoc", "/opt/homebrew/bin/pandoc"]),
  findChrome = () => firstArtifactBinary([
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ]) } = {}) {
  const requestedPdf = taskRequestsPdf(task);
  const deadline = Date.now() + timeoutMs;
  const check = () => {
    if (signal?.aborted) throw artifactError("TASK_ARTIFACT_ABORTED");
    if (Date.now() >= deadline) throw artifactError("TASK_ARTIFACT_TIMEOUT");
    const authorized = authorizeCheck();
    if (authorized?.then) throw artifactError("TASK_ARTIFACT_INVALID_AUTHORITY_CHECK");
  };
  let workDir, published, result, failure;
  const unlinkPublished = async () => {
    if (!published) return;
    const entry = await fs.promises.lstat(published.file).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    // Never delete a caller's replacement or an existing artifact.
    if (entry?.dev === published.dev && entry?.ino === published.ino) await fs.promises.unlink(published.file);
    published = null;
  };
  try {
    check();
    for (const [value, max] of [[maxArtifactBytes, 256 * 1024 * 1024], [timeoutMs, 180_000], [pandocTimeoutMs, 60_000], [killGraceMs, 5_000]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > max) throw artifactError("TASK_ARTIFACT_INVALID_LIMIT");
    }
    if (!Array.isArray(artifacts) || artifacts.length > 128) throw artifactError("TASK_ARTIFACT_INVALID_INPUT");
    for (const artifact of artifacts) artifactName(artifact?.name);
    if (requestedPdf) {
      for (const name of asArray(task.expectedArtifacts)) {
        if (/\.pdf$/i.test(String(name))) artifactName(name);
      }
    }
    const root = await fs.promises.realpath(outputsDir);
    const rootStat = await fs.promises.lstat(outputsDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw artifactError("TASK_ARTIFACT_UNSAFE_PATH");
    const checkRoot = async () => {
      check();
      const current = await fs.promises.lstat(outputsDir);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== rootStat.dev || current.ino !== rootStat.ino
        || await fs.promises.realpath(outputsDir) !== root) throw artifactError("TASK_ARTIFACT_UNSAFE_PATH");
      check();
    };
    let source, existingPdf;
    const sourceArtifact = artifacts.find(item => /\.(?:md|markdown|txt|html?)$/i.test(item.name))
      || artifacts.find(item => /\.pdf$/i.test(item.name));
    // Validate every supplied entry, not just the first candidate. Total input
    // bytes are bounded too, preventing an arbitrary manifest from draining RAM.
    let total = 0;
    for (const artifact of artifacts) {
      await checkRoot();
      const data = await readArtifact(path.join(root, artifact.name), maxArtifactBytes - total, check);
      total += data.length;
      if (/\.pdf$/i.test(artifact.name) && data.subarray(0, 5).toString("ascii") === "%PDF-") {
        existingPdf ||= { ...artifact, type: "application/pdf", size: data.length };
      }
      if (artifact === sourceArtifact) source = data.toString("utf8");
    }
    await checkRoot();
    if (!requestedPdf) result = { ok: true, requestedPdf: false, artifacts };
    else if (existingPdf) result = { ok: true, requestedPdf: true, pdfCreated: true, artifacts: [existingPdf] };
    else {
      if (process.platform === "win32") throw artifactError("TASK_ARTIFACT_PROCESS_GROUP_UNSUPPORTED");
      source ??= String(task.resultSummary || task.summary || "").trim();
      if (!source) throw artifactError("TASK_ARTIFACT_NO_SOURCE");
      if (Buffer.byteLength(source) > maxArtifactBytes) throw artifactError("TASK_ARTIFACT_SIZE_LIMIT");
      const chrome = await findChrome();
      check();
      if (!chrome) throw artifactError("TASK_ARTIFACT_NO_RENDERER");
      // Same filesystem as outputs permits atomic no-overwrite publication via
      // link(). Task inputs never control this fresh, mode-0700 private tree.
      await checkRoot();
      workDir = await fs.promises.mkdtemp(path.join(root, ".task-pdf-"));
      await fs.promises.chmod(workDir, 0o700);
      const processOptions = { cwd: workDir, signal, killGraceMs, spawnProcess, killProcess, maxArtifactBytes, checkAuthority: check,
        maxOutputBytes: Math.min(16 * 1024 * 1024, maxArtifactBytes * 8) };
      let body = `<pre>${escapeHtml(source)}</pre>`;
      const pandoc = await findPandoc();
      check();
      if (pandoc) {
        try {
          const converted = await runArtifactProcess(pandoc, ["--sandbox",
            "--from=markdown_strict+pipe_tables+fenced_code_blocks+backtick_code_blocks+strikeout-raw_html-raw_attribute", "--to=html5"], {
            ...processOptions, input: source, timeoutMs: Math.min(pandocTimeoutMs, deadline - Date.now())
          });
          if (converted.trim()) body = converted;
        } catch (error) {
          // Missing/unsupported Pandoc can fall back to escaped text. Cancellation,
          // timeout, I/O/size failures cannot silently restart another renderer.
          if (!["TASK_ARTIFACT_SPAWN_FAILED", "TASK_ARTIFACT_PROCESS_FAILED"].includes(error.code)) throw error;
        }
      }
      check();
      const htmlPath = path.join(workDir, "render.html");
      const profileDir = path.join(workDir, "profile");
      const renderedPath = path.join(workDir, "render.pdf");
      await fs.promises.mkdir(profileDir, { mode: 0o700 });
      await fs.promises.writeFile(htmlPath, pdfHtml(body), { mode: 0o600, flag: "wx" });
      check();
      await runArtifactProcess(chrome, chromeArgs(htmlPath, profileDir, renderedPath), {
        ...processOptions, timeoutMs: deadline - Date.now(), outputPath: renderedPath
      });
      await checkRoot();
      const pdf = await readArtifact(renderedPath, maxArtifactBytes, check);
      if (pdf.subarray(0, 5).toString("ascii") !== "%PDF-") throw artifactError("TASK_ARTIFACT_INVALID_PDF");
      const name = asArray(task.expectedArtifacts).find(item => /\.pdf$/i.test(String(item))) || "任务结果.pdf";
      const baseName = artifactName(safeName(name).replace(/(?:\.[^.]+)?$/, ".pdf"));
      const stat = await fs.promises.lstat(renderedPath);
      check();
      // Do not overwrite even an invalid pre-existing PDF or symlink. Collisions
      // get an invocation-unique name; EEXIST on that name fails closed.
      let pdfName = baseName;
      let file = path.join(root, pdfName);
      try { await fs.promises.link(renderedPath, file); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await fs.promises.lstat(file);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw artifactError("TASK_ARTIFACT_UNSAFE_FILE");
        pdfName = `${path.parse(baseName).name}-${path.basename(workDir).slice(".task-pdf-".length)}.pdf`;
        file = path.join(root, pdfName);
        check();
        await fs.promises.link(renderedPath, file);
      }
      published = { file, dev: stat.dev, ino: stat.ino };
      await checkRoot();
      result = { ok: true, requestedPdf: true, pdfCreated: true,
        artifacts: [{ name: pdfName, type: "application/pdf", size: pdf.length }] };
    }
  } catch (error) { failure = error; }
  // One owner controls cleanup. No abort handler ever removes files. Check again
  // AFTER awaited cleanup so late cancellation cannot leak a published success.
  try { if (workDir) await fs.promises.rm(workDir, { recursive: true, force: true }); }
  catch { failure ||= artifactError("TASK_ARTIFACT_CLEANUP_FAILED"); }
  try { check(); } catch (error) { failure ||= error; }
  if (signal?.aborted) failure = artifactError("TASK_ARTIFACT_ABORTED");
  if (failure) {
    try { await unlinkPublished(); } catch { throw artifactError("TASK_ARTIFACT_CLEANUP_FAILED"); }
    if (signal?.aborted) throw artifactError("TASK_ARTIFACT_ABORTED");
    const code = /^TASK_ARTIFACT_[A-Z_]+$/.test(failure.code || "") ? failure.code : "TASK_ARTIFACT_IO_FAILED";
    return { ok: false, requestedPdf, pdfCreated: false, artifacts, code, error: code };
  }
  return result;
}
