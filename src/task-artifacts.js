import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>
    @page{size:A4;margin:16mm 15mm 18mm}body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#172033;font-size:13px;line-height:1.7}h1{font-size:25px;border-bottom:2px solid #3b82f6;padding-bottom:8px}h2{font-size:19px;margin-top:24px;color:#1d4ed8}h3{font-size:16px;margin-top:18px}table{width:100%;border-collapse:collapse;margin:12px 0;font-size:12px}th,td{border:1px solid #cbd5e1;padding:7px;vertical-align:top}th{background:#eff6ff}blockquote{margin:12px 0;padding:8px 14px;border-left:4px solid #60a5fa;background:#f8fafc;color:#475569}code{font-family:ui-monospace,monospace;background:#f1f5f9;padding:1px 4px;border-radius:4px}pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:12px;border-radius:8px}img{max-width:100%}a{color:#2563eb}li{margin:3px 0}
  </style></head><body>${body}</body></html>`;
  let result;
  try {
    fs.writeFileSync(htmlPath, html, { mode: 0o600 });
    fs.mkdirSync(profileDir, { mode: 0o700 });
    result = spawnSync(chrome, [
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
    ], { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  if (result.status !== 0 || !validPdf(targetPath)) {
    return { ok: false, error: String(result.stderr || `Chrome 退出码 ${result.status}`).trim().slice(-800) };
  }
  return { ok: true };
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
