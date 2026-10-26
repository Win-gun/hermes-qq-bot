// Synthetic files + fake ChildProcess objects only. No browser/converter/model,
// QQ, network, live config, profiles or user files are opened by this test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ensureRequestedTaskArtifactsAsync as ensure } from "../src/task-artifacts.js";

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-artifact-async-test-")));
const results = [];
let fixtureId = 0, pid = 700000;
const pdfBytes = Buffer.from("%PDF-synthetic-only\n");
const waitFor = async predicate => {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await delay(5); }
  throw new Error("fake renderer did not reach expected state");
};

function fixture(behavior = () => {}, overrides = {}) {
  const outputsDir = path.join(temp, `case-${++fixtureId}`);
  fs.mkdirSync(outputsDir);
  const calls = [], kills = [];
  const controller = new AbortController();
  const options = { task: { objective: "输出 PDF", resultSummary: "# 中文报告", expectedArtifacts: ["报告.pdf"] },
    outputsDir, signal: controller.signal, timeoutMs: 2000, killGraceMs: 15,
    findPandoc: async () => "", findChrome: async () => "/fake/chrome",
    spawnProcess(command, args, spawnOptions) {
      const child = new EventEmitter();
      Object.assign(child, { pid: ++pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      const call = { command, args, options: spawnOptions, child, closed: false, helpers: 1,
        pdfPath: args.find(arg => arg.startsWith("--print-to-pdf="))?.slice("--print-to-pdf=".length),
        close(code = 0, sig = null) {
          assert.equal(call.closed, false);
          call.closed = true;
          child.emit("close", code, sig);
        } };
      calls.push(call);
      setImmediate(() => behavior(call, calls));
      return child;
    },
    killProcess(group, sig) {
      const call = calls.find(item => item.child.pid === -group);
      assert.ok(call, "signals must only address this invocation's owned negative PGID");
      kills.push({ group, sig });
      if (sig === "SIGKILL") call.helpers = 0;
      if (!call.closed) call.onKill?.(sig);
    }, ...overrides };
  const run = patch => ensure({ ...options, ...patch });
  const clean = () => {
    assert.ok(!fs.readdirSync(outputsDir).some(name => name.startsWith(".task-pdf-")), "private render/profile files leaked");
    for (const call of calls) {
      assert.equal(call.closed, true, "settled before ChildProcess.close");
      assert.equal(call.helpers, 0, "owned process-group helper orphaned");
    }
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  };
  return { outputsDir, calls, kills, controller, options, run, clean };
}

function success(call) { fs.writeFileSync(call.pdfPath, pdfBytes); call.close(); }
async function test(name, body) { await body(); results.push(name); }

try {
  await test("pre-abort: no spawn or temporary files", async () => {
    const f = fixture(() => assert.fail("must not spawn"));
    f.controller.abort(new Error("PRIVATE_ABORT_REASON"));
    await assert.rejects(f.run(), { name: "AbortError", code: "TASK_ARTIFACT_ABORTED", message: "TASK_ARTIFACT_ABORTED" });
    assert.equal(f.calls.length, 0); f.clean();
  });

  await test("cancellation during asynchronous discovery and between converters never spawns the next stage", async () => {
    const f = fixture(() => assert.fail("discovery cancellation spawned"));
    await assert.rejects(f.run({ findChrome: async () => { f.controller.abort(); return "/fake/chrome"; } }), { code: "TASK_ARTIFACT_ABORTED" });
    f.clean();
    const between = fixture(call => {
      call.child.stdout.write("<h1>synthetic</h1>");
      call.close();
      between.controller.abort();
    }, { findPandoc: async () => "/fake/pandoc" });
    await assert.rejects(between.run(), { code: "TASK_ARTIFACT_ABORTED" });
    assert.equal(between.calls.length, 1); between.clean();
  });

  await test("success: private files/profile, escaped HTML, CSP/offline flags, close + helper reap", async () => {
    const payload = '<script>fetch("http://127.0.0.1/")</script><img src="file:///synthetic">';
    const f = fixture(call => {
      assert.equal(call.options.detached, true);
      assert.equal(call.options.shell, false);
      assert.deepEqual(call.options.stdio, ["pipe", "pipe", "pipe"]);
      const htmlPath = fileURLToPath(call.args.at(-1));
      const work = path.dirname(htmlPath);
      assert.notEqual(work, f.outputsDir);
      assert.equal(fs.statSync(work).mode & 0o777, 0o700);
      assert.equal(fs.statSync(htmlPath).mode & 0o777, 0o600);
      assert.equal(call.options.env.HOME, work);
      assert.equal(call.options.env.XDG_CACHE_HOME, work);
      assert.equal(call.options.env.TMPDIR, work);
      const html = fs.readFileSync(htmlPath, "utf8");
      assert.match(html, /default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'/);
      assert.match(html, /&lt;script&gt;/);
      assert.ok(!html.includes('<script>'));
      assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<style>"));
      assert.equal(call.args.find(arg => arg.startsWith("--user-data-dir=")), `--user-data-dir=${path.join(work, "profile")}`);
      for (const flag of ["--disable-background-networking", "--disable-extensions", "--no-first-run",
        "--host-resolver-rules=MAP * ~NOTFOUND", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>"]) assert.ok(call.args.includes(flag));
      assert.ok(!call.args.some(arg => /no-sandbox|disable-web-security|allow-file-access/.test(arg)));
      success(call);
    });
    const result = await f.run({ task: { ...f.options.task, resultSummary: payload } });
    assert.equal(result.ok, true); assert.equal(result.pdfCreated, true);
    assert.equal(result.artifacts[0].size, pdfBytes.length);
    assert.deepEqual(fs.readFileSync(path.join(f.outputsDir, result.artifacts[0].name)), pdfBytes);
    assert.deepEqual(f.kills.map(k => k.sig), ["SIGKILL"]); f.clean();
    f.controller.abort(); // completed artifacts are not owned by a stale abort handler
    assert.ok(fs.existsSync(path.join(f.outputsDir, result.artifacts[0].name)));
  });

  await test("abort during render: TERM/KILL escalation, pending through exit and error until close", async () => {
    const f = fixture(call => {
      fs.writeFileSync(call.pdfPath, "%PDF-partial");
      call.onKill = sig => {
        if (sig === "SIGTERM") { call.child.emit("exit", 0); call.child.emit("error", new Error("PRIVATE_STDERR")); }
      };
    });
    let settled = false;
    const pending = f.run().finally(() => { settled = true; });
    const rejection = assert.rejects(pending, { code: "TASK_ARTIFACT_ABORTED" });
    await waitFor(() => !!f.calls[0]?.onKill);
    const call = f.calls[0];
    f.controller.abort(); f.controller.abort();
    await waitFor(() => f.kills.some(k => k.sig === "SIGKILL"));
    assert.equal(settled, false);
    assert.ok(fs.existsSync(call.options.cwd), "cleanup must wait for close");
    call.close(0);
    await rejection;
    assert.deepEqual(f.kills.map(k => k.sig), ["SIGTERM", "SIGKILL", "SIGKILL"]);
    assert.deepEqual(fs.readdirSync(f.outputsDir), []); f.clean();
  });

  await test("abort: leader closes on TERM but surviving helper still receives KILL", async () => {
    const f = fixture(call => { call.onKill = sig => { if (sig === "SIGTERM") call.close(null, "SIGTERM"); }; });
    const pending = f.run();
    const rejection = assert.rejects(pending, { code: "TASK_ARTIFACT_ABORTED" });
    await waitFor(() => !!f.calls[0]?.onKill); f.controller.abort(); await rejection;
    assert.deepEqual(f.kills.map(k => k.sig), ["SIGTERM", "SIGKILL"]); f.clean();
  });

  await test("deadline: escalates and waits for close, no partial output", async () => {
    const f = fixture(call => { call.onKill = sig => { if (sig === "SIGKILL") setImmediate(() => call.close(null, "SIGKILL")); }; });
    const result = await f.run({ timeoutMs: 80 });
    assert.equal(result.code, "TASK_ARTIFACT_TIMEOUT");
    assert.deepEqual(f.kills.map(k => k.sig), ["SIGTERM", "SIGKILL", "SIGKILL"]);
    assert.deepEqual(fs.readdirSync(f.outputsDir), []); f.clean();
  });

  await test("nonblocking: unrelated event-loop work proceeds while renderer is pending", async () => {
    const f = fixture();
    let settled = false;
    const pending = f.run().then(value => { settled = true; return value; });
    await waitFor(() => f.calls.length === 1);
    let ticked = false;
    await new Promise(resolve => setImmediate(() => { ticked = true; resolve(); }));
    assert.equal(ticked, true); assert.equal(settled, false);
    success(f.calls[0]); assert.equal((await pending).ok, true); f.clean();
  });

  await test("Pandoc: strict sandbox reader and independent owned group", async () => {
    const f = fixture(call => {
      if (call.command === "/fake/pandoc") {
        assert.ok(call.args.includes("--sandbox"));
        assert.ok(call.args.includes("--from=markdown_strict+pipe_tables+fenced_code_blocks+backtick_code_blocks+strikeout-raw_html-raw_attribute"));
        call.child.stdout.write("<h1>中文</h1><table><tr><td>表格</td></tr></table>"); call.close();
      } else {
        assert.match(fs.readFileSync(fileURLToPath(call.args.at(-1)), "utf8"), /<h1>中文<\/h1><table>/); success(call);
      }
    }, { findPandoc: async () => "/fake/pandoc" });
    assert.equal((await f.run()).ok, true); assert.equal(f.calls.length, 2); f.clean();
  });

  await test("Pandoc cancellation and timeout cannot fall back to a browser", async () => {
    for (const abort of [true, false]) {
      const f = fixture(call => { call.onKill = sig => { if (sig === "SIGKILL") setImmediate(() => call.close(null, sig)); }; },
        { findPandoc: async () => "/fake/pandoc", pandocTimeoutMs: 60 });
      const pending = f.run();
      if (abort) {
        const rejected = assert.rejects(pending, { code: "TASK_ARTIFACT_ABORTED" });
        await waitFor(() => !!f.calls[0]?.onKill); f.controller.abort(); await rejected;
      } else assert.equal((await pending).code, "TASK_ARTIFACT_TIMEOUT");
      assert.equal(f.calls.length, 1); f.clean();
    }
  });

  await test("spawn error waits for close before escaped-text fallback", async () => {
    const f = fixture(call => {
      if (call.command === "/fake/pandoc") call.child.emit("error", new Error("PRIVATE_SPAWN_ERROR"));
      else success(call);
    }, { findPandoc: async () => "/fake/pandoc" });
    const pending = f.run();
    await waitFor(() => f.kills.some(k => k.sig === "SIGKILL"));
    assert.equal(f.calls.length, 1);
    assert.ok(fs.existsSync(f.calls[0].options.cwd));
    f.calls[0].close(-2);
    assert.equal((await pending).ok, true); assert.equal(f.calls.length, 2); f.clean();
    const thrown = fixture(() => {}, { spawnProcess: () => { throw new Error("PRIVATE_SPAWN_ERROR"); } });
    assert.equal((await thrown.run()).code, "TASK_ARTIFACT_SPAWN_FAILED"); thrown.clean();
  });

  await test("bounded stdout/stderr overflow terminates group without disclosing child text", async () => {
    for (const stream of ["stdout", "stderr"]) {
      const f = fixture(call => {
        call.onKill = sig => { if (sig === "SIGKILL") setImmediate(() => call.close(null, sig)); };
        call.child[stream].write("PRIVATE_CHILD_TEXT".repeat(100));
      });
      const result = await f.run({ maxArtifactBytes: 64 });
      assert.equal(result.code, "TASK_ARTIFACT_OUTPUT_LIMIT");
      assert.ok(!JSON.stringify(result).includes("PRIVATE_CHILD_TEXT")); f.clean();
    }
  });

  await test("output validation: missing, empty, bad header, oversized, symlink, directory, hardlink", async () => {
    for (const variant of ["missing", "empty", "header", "large", "symlink", "directory", "hardlink"]) {
      const f = fixture(call => {
        if (variant === "empty") fs.writeFileSync(call.pdfPath, "");
        if (variant === "header") fs.writeFileSync(call.pdfPath, "NOT-PDF");
        if (variant === "large") fs.writeFileSync(call.pdfPath, "%PDF-" + "x".repeat(100));
        if (variant === "symlink") fs.symlinkSync(path.join(temp, "synthetic.pdf"), call.pdfPath);
        if (variant === "directory") fs.mkdirSync(call.pdfPath);
        if (variant === "hardlink") fs.linkSync(path.join(temp, "synthetic.pdf"), call.pdfPath);
        call.close();
      });
      fs.writeFileSync(path.join(temp, "synthetic.pdf"), pdfBytes);
      const result = await f.run({ maxArtifactBytes: 64 });
      assert.equal(result.ok, false, variant);
      assert.deepEqual(fs.readdirSync(f.outputsDir), [], variant); f.clean();
    }
  });

  await test("growing output killed before close on size watchdog", async () => {
    const f = fixture(call => {
      call.onKill = sig => { if (sig === "SIGKILL") setImmediate(() => call.close(null, sig)); };
      fs.writeFileSync(call.pdfPath, "%PDF-" + "x".repeat(100));
    });
    assert.equal((await f.run({ maxArtifactBytes: 64 })).code, "TASK_ARTIFACT_SIZE_LIMIT"); f.clean();
  });

  await test("input validation: traversal, symlinks, special files, hardlinks, aggregate bytes", async () => {
    for (const name of ["../synthetic.pdf", "/absolute.pdf", "nested/file.md", "..\\file.md", ".", "..", "a\0.md", "C:foo.pdf"]) {
      const f = fixture(() => assert.fail("unsafe input spawned"));
      assert.equal((await f.run({ artifacts: [{ name }] })).code, "TASK_ARTIFACT_UNSAFE_PATH");
      assert.equal((await f.run({ task: { objective: "PDF", expectedArtifacts: [name.replace(/\.md$/, ".pdf")] } })).ok, false);
      f.clean();
    }
    for (const variant of ["symlink", "directory", "hardlink", "large", "aggregate"]) {
      const f = fixture(() => assert.fail("unsafe input spawned"));
      const input = path.join(f.outputsDir, "input.md");
      if (variant === "symlink") fs.symlinkSync(path.join(temp, "synthetic.pdf"), input);
      if (variant === "directory") fs.mkdirSync(input);
      if (variant === "hardlink") fs.linkSync(path.join(temp, "synthetic.pdf"), input);
      if (variant === "large") fs.writeFileSync(input, "x".repeat(65));
      if (variant === "aggregate") fs.writeFileSync(input, "x".repeat(40));
      const artifacts = [{ name: "input.md" }];
      if (variant === "aggregate") { fs.writeFileSync(path.join(f.outputsDir, "second.txt"), "x".repeat(40)); artifacts.push({ name: "second.txt" }); }
      assert.equal((await f.run({ artifacts, maxArtifactBytes: 64 })).ok, false, variant); f.clean();
    }
    const f = fixture();
    const alias = path.join(temp, "outputs-alias"); fs.symlinkSync(f.outputsDir, alias);
    assert.equal((await f.run({ outputsDir: alias })).code, "TASK_ARTIFACT_UNSAFE_PATH"); f.clean();
  });

  await test("existing valid PDF and no-PDF path do not start any renderer", async () => {
    const f = fixture(() => assert.fail("existing artifact spawned"));
    fs.writeFileSync(path.join(f.outputsDir, "existing.pdf"), pdfBytes);
    const artifacts = [{ name: "existing.pdf", size: 999 }];
    const result = await f.run({ artifacts });
    assert.equal(result.ok, true); assert.equal(result.artifacts[0].size, pdfBytes.length);
    assert.equal((await f.run({ task: { objective: "text" }, artifacts })).requestedPdf, false);
    fs.symlinkSync(path.join(temp, "synthetic.pdf"), path.join(f.outputsDir, "other.txt"));
    assert.equal((await f.run({ artifacts: [...artifacts, { name: "other.txt" }] })).ok, false, "do not bypass other invalid entries for existing PDF");
    f.clean();
  });

  await test("publication never overwrites existing files; concurrent invocations own different profiles", async () => {
    const f = fixture(success);
    fs.writeFileSync(path.join(f.outputsDir, "报告.pdf"), "preserve-invalid-original");
    const [a, b] = await Promise.all([f.run(), f.run()]);
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    assert.notEqual(a.artifacts[0].name, b.artifacts[0].name);
    assert.equal(fs.readFileSync(path.join(f.outputsDir, "报告.pdf"), "utf8"), "preserve-invalid-original");
    assert.notEqual(f.calls[0].options.cwd, f.calls[1].options.cwd); f.clean();
  });

  await test("target symlinks/directories/hardlinks are rejected, not overwritten or bypassed", async () => {
    for (const variant of ["symlink", "directory", "hardlink"]) {
      const f = fixture(success);
      const target = path.join(f.outputsDir, "报告.pdf");
      const sentinel = path.join(f.outputsDir, "sentinel.txt"); fs.writeFileSync(sentinel, "preserve");
      if (variant === "symlink") fs.symlinkSync(sentinel, target);
      if (variant === "directory") fs.mkdirSync(target);
      if (variant === "hardlink") fs.linkSync(sentinel, target);
      assert.equal((await f.run()).code, "TASK_ARTIFACT_UNSAFE_FILE");
      assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve"); f.clean();
    }
  });

  await test("renderer failure cannot accept even a valid-looking PDF", async () => {
    const f = fixture(call => { fs.writeFileSync(call.pdfPath, pdfBytes); call.child.stderr.write("PRIVATE_ERROR"); call.close(1); });
    const result = await f.run();
    assert.equal(result.code, "TASK_ARTIFACT_PROCESS_FAILED");
    assert.ok(!result.error.includes("PRIVATE_ERROR"));
    assert.deepEqual(fs.readdirSync(f.outputsDir), []); f.clean();
  });

  await test("late cancellation during awaited cleanup rolls back only this invocation's publication", async () => {
    const f = fixture(success);
    fs.writeFileSync(path.join(f.outputsDir, "keep.txt"), "keep");
    const rm = fs.promises.rm;
    fs.promises.rm = async (file, options) => {
      if (path.dirname(file) === f.outputsDir && path.basename(file).startsWith(".task-pdf-")) {
        assert.ok(fs.existsSync(path.join(f.outputsDir, "报告.pdf")), "fixture aborts only after publication");
        f.controller.abort();
        await delay(5);
      }
      return rm(file, options);
    };
    try { await assert.rejects(f.run(), { code: "TASK_ARTIFACT_ABORTED" }); }
    finally { fs.promises.rm = rm; }
    assert.deepEqual(fs.readdirSync(f.outputsDir), ["keep.txt"]); f.clean();
  });

  await test("late cancellation preserves a replacement artifact owned by another invocation", async () => {
    const f = fixture(success);
    const target = path.join(f.outputsDir, "报告.pdf");
    const rm = fs.promises.rm;
    fs.promises.rm = async (file, options) => {
      if (path.dirname(file) === f.outputsDir && path.basename(file).startsWith(".task-pdf-")) {
        fs.unlinkSync(target);
        fs.writeFileSync(target, "other-invocation-result");
        f.controller.abort();
      }
      return rm(file, options);
    };
    try { await assert.rejects(f.run(), { code: "TASK_ARTIFACT_ABORTED" }); }
    finally { fs.promises.rm = rm; }
    assert.equal(fs.readFileSync(target, "utf8"), "other-invocation-result"); f.clean();
  });

  await test("invalid limits and missing renderer fail closed with safe codes", async () => {
    const f = fixture(() => assert.fail("must not spawn"));
    for (const value of [0, -1, Infinity, NaN, "64", 257 * 1024 * 1024]) {
      assert.equal((await f.run({ maxArtifactBytes: value })).code, "TASK_ARTIFACT_INVALID_LIMIT");
    }
    assert.equal((await f.run({ findChrome: async () => "" })).code, "TASK_ARTIFACT_NO_RENDERER");
    assert.equal((await f.run({ task: { objective: "PDF" } })).code, "TASK_ARTIFACT_NO_SOURCE"); f.clean();
  });
  console.log(JSON.stringify({ ok: true, tests: results.length, results }));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
