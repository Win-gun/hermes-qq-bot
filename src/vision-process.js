import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

// One bounded CLI attempt, never retried. Kill the process group on cancellation
// so a vision helper cannot survive a changed account/scope. No prompt/errors
// from the child are returned in failures (they can contain local credentials).
export function runVisionProcess(command, args, { cwd, env, signal, timeoutMs = 120000,
  maxOutputBytes = 262144, killGraceMs = 250 } = {}) {
  return new Promise((resolve, reject) => {
    const failure = code => Object.assign(new Error(code), { code });
    if (signal?.aborted) return reject(failure("VISION_ABORTED"));
    const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const decoder = new StringDecoder("utf8");
    let output = "", bytes = 0, errorCode = "", settled = false, killTimer, settleTimer;
    const kill = sig => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig); else child.kill(sig); }
      catch { try { child.kill(sig); } catch {} }
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(settleTimer);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value);
    };
    const stop = code => {
      if (errorCode || settled) return;
      errorCode = code; clearTimeout(timer); kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), killGraceMs);
      settleTimer = setTimeout(() => finish(failure(code)), killGraceMs + 500);
    };
    const abort = () => stop("VISION_ABORTED");
    const timer = setTimeout(() => stop("VISION_TIMEOUT"), Math.max(1, Math.min(timeoutMs, 180000)));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) stop("VISION_OUTPUT_LIMIT");
      else if (!errorCode) output += decoder.write(chunk);
    });
    child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > maxOutputBytes) stop("VISION_OUTPUT_LIMIT"); });
    child.on("error", () => finish(failure(errorCode || "VISION_PROCESS_FAILED")));
    child.on("close", code => {
      if (errorCode) kill("SIGKILL"); // The leader can exit before a helper does.
      finish(errorCode ? failure(errorCode) : code === 0 ? null : failure("VISION_PROCESS_FAILED"), output + decoder.end());
    });
  });
}
