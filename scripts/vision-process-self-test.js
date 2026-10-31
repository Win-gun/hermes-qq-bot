import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runVisionProcess } from "../src/vision-process.js";
import { selectVisionRoute, runVisionImage } from "../src/vision-completion.js";
const run = (code, options) => runVisionProcess(process.execPath, ["-e", code], options);
assert.equal(await run("process.stdout.write('合成测试')"), "合成测试");
await assert.rejects(run("process.stderr.write('DO_NOT_RETURN_SECRET');process.exit(1)"), e => e.code === "VISION_PROCESS_FAILED" && !e.message.includes("SECRET"));
await assert.rejects(run("setInterval(()=>{},1000)", { timeoutMs: 50 }), { code: "VISION_TIMEOUT" });
const aborted = new AbortController(); aborted.abort();
await assert.rejects(run("throw Error('never')", { signal: aborted.signal }), { code: "VISION_ABORTED" });
const c = new AbortController(), pending = run("setInterval(()=>{},1000)", { signal: c.signal });
setTimeout(() => c.abort(), 50);
await assert.rejects(pending, { code: "VISION_ABORTED" });
await assert.rejects(run("process.stdout.write('x'.repeat(10000))", { maxOutputBytes: 100 }), { code: "VISION_OUTPUT_LIMIT" });
assert.equal(await run("const b=Buffer.from('中文'); process.stdout.write(b.subarray(0,1)); setTimeout(()=>process.stdout.write(b.subarray(1)),10)"), "中文");
console.log("vision process: PASS (bounded output, UTF-8, timeout, cancellation, safe errors)");

// No network/model/QQ calls. Only disposable synthetic images and injected
// transports; a missing mock fails locally instead of contacting a provider.
const dir = await mkdtemp(path.join(os.tmpdir(), "vision-contract-test-"));
try {
  const imagePath = path.join(dir, "extensionless-image");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/+tgAAAAASUVORK5CYII=", "base64");
  await writeFile(imagePath, png, { mode: 0o600 });
  const chat = { profile: { id: "chat-a", kind: "chat", model: "opaque-model", connectionId: "conn-a" },
    connection: { id: "conn-a", provider: "custom", baseUrl: "https://synthetic.invalid/v1" } };
  const vision = { profile: { id: "vision-b", kind: "vision", model: "separate-model", connectionId: "conn-b" },
    connection: { id: "conn-b", provider: "xiaomi", baseUrl: "https://separate.invalid/v1" } };
  const capability = { source: "provider-metadata", accountId: "account-a", profileId: "chat-a", connectionId: "conn-a",
    provider: "custom", model: "opaque-model", baseUrl: chat.connection.baseUrl, supportsImages: true, transport: "chat-completions" };
  const base = { accountId: "account-a", chat, vision, capability, imagePath, prompt: "请判断图片内容", apiKey: "fake-key-only-for-tests",
    isCurrent: () => true, fetchImpl: () => { throw Error("MISSING_MOCK"); } };
  const invoke = changes => runVisionImage({ ...base, ...changes });
  const unknownUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, reasoningTokens: null };
  const answer = (content = "合成图片说明") => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  const rejectsCode = (promise, code) => assert.rejects(promise, error => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.doesNotMatch(JSON.stringify(error), /fake-key-only-for-tests|DO_NOT_RETURN_SECRET|extensionless-image/);
    return true;
  });
  const route = changes => selectVisionRoute({ ...base, ...changes });
  assert.equal(route().kind, "chat");
  assert.equal(route({ vision: undefined }).kind, "chat");
  for (const source of ["administrator", "provider-metadata"]) assert.equal(route({ capability: { ...capability, source } }).kind, "chat");
  for (const change of [{ source: "model-prose" }, { accountId: "account-b" }, { profileId: "other-profile" },
    { connectionId: "other-connection" }, { provider: "other" }, { model: "other-model" },
    { baseUrl: "https://other.invalid/v1" }, { transport: "responses" }, { supportsImages: "true" }]) {
    assert.equal(route({ capability: { ...capability, ...change } }).reason, "CHAT_IMAGES_UNKNOWN");
  }
  assert.equal(route({ preferChat: false }).reason, "VISION_BINDING_PINNED");
  assert.equal(route({ capability: { ...capability, supportsImages: false } }).reason, "CHAT_IMAGES_UNSUPPORTED");
  // A plausible name is never capability evidence.
  assert.equal(route({ chat: { ...chat, profile: { ...chat.profile, model: "vision-latest" } }, capability: undefined }).kind, "vision");
  assert.throws(() => route({ capability: undefined, vision: undefined }), { code: "VISION_FALLBACK_UNAVAILABLE" });
  assert.throws(() => route({ capability: undefined, vision: { ...vision, profile: { ...vision.profile, model: 123 } } }),
    { code: "VISION_FALLBACK_UNAVAILABLE" });
  assert.equal(route({ chat: { profile: chat.profile } }).kind, "vision");
  const badChat = { ...chat, connection: { ...chat.connection, baseUrl: "https://user:DO_NOT_RETURN_SECRET@synthetic.invalid" } };
  assert.equal(route({ chat: badChat, capability: { ...capability, baseUrl: badChat.connection.baseUrl } }).reason,
    "CHAT_IMAGE_TRANSPORT_UNAVAILABLE");

  let calls = 0;
  const result = await invoke({ fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, "https://synthetic.invalid/v1/chat/completions");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.authorization, "Bearer fake-key-only-for-tests");
    const payload = JSON.parse(options.body), parts = payload.messages[0].content;
    assert.equal(payload.model, chat.profile.model);
    assert.deepEqual(parts[0], { type: "text", text: base.prompt });
    assert.match(parts[1].image_url.url, /^data:image\/png;base64,/);
    assert.deepEqual(Buffer.from(parts[1].image_url.url.split(",")[1], "base64"), png);
    assert.equal(Object.hasOwn(payload, "tools"), false);
    assert.equal(Object.hasOwn(payload, "reasoning_effort"), false);
    assert.doesNotMatch(options.body, /extensionless-image|separate-model/);
    return answer();
  }, fallback: () => assert.fail("direct success must not call fallback") });
  assert.deepEqual(result, { text: "合成图片说明", route: "chat", reason: "CHAT_IMAGES_CONFIRMED",
    usage: unknownUsage, model: null, provider: "openai-compatible" });
  assert.equal(calls, 1);

  for (const evidence of [undefined, { ...capability, supportsImages: false }]) {
    const fallbackResult = await invoke({ capability: evidence, fallback: async options => {
      assert.deepEqual(options.selection, vision);
      assert.equal(options.imagePath, imagePath);
      assert.equal(options.signal.aborted, false);
      assert.equal(options.isCurrent(), true);
      assert.equal(Object.hasOwn(options, "apiKey"), false);
      return "独立识图兼容路径";
    }, fetchImpl: () => assert.fail("fallback must not call chat") });
    assert.equal(fallbackResult.route, "vision");
    assert.equal(fallbackResult.text, "独立识图兼容路径");
    assert.deepEqual(fallbackResult.usage, unknownUsage);
    assert.equal(fallbackResult.model, null);
    assert.equal(fallbackResult.provider, null);
  }
  assert.equal((await invoke({ preferChat: false, fallback: async () => "绑定测试仍使用独立模型",
    fetchImpl: () => assert.fail("pinned vision must not call chat") })).reason, "VISION_BINDING_PINNED");
  const fullEndpoint = "https://synthetic.invalid/v1/chat/completions";
  assert.equal((await invoke({ chat: { ...chat, connection: { ...chat.connection, baseUrl: fullEndpoint } },
    capability: { ...capability, baseUrl: fullEndpoint }, fetchImpl: async url => {
      assert.equal(url, fullEndpoint);
      return answer([{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }]);
    } })).text, "第一段第二段");
  await rejectsCode(invoke({ capability: undefined }), "VISION_FALLBACK_UNAVAILABLE");
  await rejectsCode(invoke({ apiKey: "" }), "VISION_CREDENTIAL_UNAVAILABLE");
  await rejectsCode(invoke({ isCurrent: undefined }), "VISION_ARGUMENTS_INVALID");
  await rejectsCode(invoke({ isCurrent: () => false }), "VISION_IDENTITY_STALE");

  const noCall = () => assert.fail("invalid image must not be submitted");
  for (const value of [path.join(dir, "missing-DO_NOT_RETURN_SECRET"), dir, "relative.png"]) {
    await rejectsCode(invoke({ imagePath: value, fetchImpl: noCall, fallback: noCall }), "VISION_IMAGE_UNREADABLE");
  }
  const empty = path.join(dir, "empty"), bad = path.join(dir, "fake.png"), link = path.join(dir, "link.png");
  await writeFile(empty, "");
  await writeFile(bad, "DO_NOT_RETURN_SECRET");
  await symlink(imagePath, link);
  await rejectsCode(invoke({ imagePath: empty, fetchImpl: noCall }), "VISION_IMAGE_UNREADABLE");
  await rejectsCode(invoke({ imagePath: link, fetchImpl: noCall }), "VISION_IMAGE_UNREADABLE");
  await rejectsCode(invoke({ imagePath: bad, fetchImpl: noCall }), "VISION_IMAGE_FORMAT_UNSUPPORTED");
  await rejectsCode(invoke({ imagePath: bad, capability: undefined, fallback: noCall }), "VISION_IMAGE_FORMAT_UNSUPPORTED");
  await rejectsCode(invoke({ maxImageBytes: png.length - 1, fetchImpl: noCall }), "VISION_IMAGE_TOO_LARGE");
  const preAbort = new AbortController(); preAbort.abort("DO_NOT_RETURN_SECRET");
  await rejectsCode(invoke({ signal: preAbort.signal, fetchImpl: noCall }), "VISION_ABORTED");

  // Post-await identity checks cover file reads, the response and legacy adapter.
  let checks = 0;
  await rejectsCode(invoke({ isCurrent: () => ++checks < 2, fetchImpl: noCall }), "VISION_IDENTITY_STALE");
  let current = true;
  await rejectsCode(invoke({ isCurrent: () => current, fetchImpl: async () => { current = false; return answer(); } }), "VISION_IDENTITY_STALE");
  current = true;
  await rejectsCode(invoke({ capability: undefined, isCurrent: () => current,
    fallback: async () => { current = false; return "stale"; } }), "VISION_IDENTITY_STALE");

  for (const status of [302, 400, 401, 500]) {
    let attempted = 0, cancelled = false;
    await rejectsCode(invoke({ fetchImpl: async () => {
      attempted++;
      return { status, body: { cancel: async () => { cancelled = true; } } };
    }, fallback: () => assert.fail("never retry an uncertain/failed call with another model") }),
    status === 302 ? "VISION_REDIRECT_REFUSED" : "VISION_REQUEST_FAILED");
    assert.equal(attempted, 1);
    assert.equal(cancelled, true);
  }
  await rejectsCode(invoke({ fetchImpl: async () => { throw Error("DO_NOT_RETURN_SECRET"); } }), "VISION_REQUEST_FAILED");
  await rejectsCode(invoke({ capability: undefined, fallback: async () => { throw Error("DO_NOT_RETURN_SECRET"); } }), "VISION_REQUEST_FAILED");
  for (const [value, code] of [
    ["not JSON DO_NOT_RETURN_SECRET", "VISION_RESPONSE_INVALID"],
    [JSON.stringify({ choices: [{ message: { content: "" } }] }), "VISION_EMPTY_RESPONSE"],
    [JSON.stringify({ choices: [{ message: { reasoning_content: "DO_NOT_RETURN_SECRET" } }] }), "VISION_EMPTY_RESPONSE"],
    [JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }), "VISION_OUTPUT_TRUNCATED"],
    [JSON.stringify({ choices: [{ message: { content: "call", tool_calls: [{}] } }] }), "VISION_TOOL_CALL_REFUSED"],
    ["x".repeat(262145), "VISION_OUTPUT_LIMIT"]
  ]) await rejectsCode(invoke({ fetchImpl: async () => new Response(value) }), code);

  const hanging = () => new Promise(() => {});
  await rejectsCode(invoke({ timeoutMs: 20, fetchImpl: hanging }), "VISION_TIMEOUT");
  await rejectsCode(invoke({ timeoutMs: 20, capability: undefined, fallback: hanging }), "VISION_TIMEOUT");
  await rejectsCode(invoke({ timeoutMs: 20, fetchImpl: async () => ({ status: 200,
    body: { getReader: () => ({ read: hanging, cancel: async () => {} }) } }) }), "VISION_TIMEOUT");
  for (const fallbackMode of [false, true]) {
    const controller = new AbortController();
    let childSignal;
    const hangUntilAborted = async options => {
      childSignal = options.signal;
      setTimeout(() => controller.abort("DO_NOT_RETURN_SECRET"), 5);
      return hanging();
    };
    await rejectsCode(invoke({ signal: controller.signal, ...(fallbackMode
      ? { capability: undefined, fallback: hangUntilAborted }
      : { fetchImpl: (_url, options) => hangUntilAborted(options) }) }), "VISION_ABORTED");
    assert.equal(childSignal.aborted, true);
  }
  let lateResponse, lateCancelled = false;
  await rejectsCode(invoke({ timeoutMs: 20, fetchImpl: () => new Promise(resolve => { lateResponse = resolve; }) }), "VISION_TIMEOUT");
  lateResponse({ status: 200, body: { cancel: async () => { lateCancelled = true; } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateCancelled, true);
  current = true;
  await rejectsCode(invoke({ isCurrent: () => current, fetchImpl: async () => ({ status: 200,
    body: { getReader: () => ({ read: async () => { current = false; return { done: true }; }, cancel: async () => {} }) }
  }) }), "VISION_IDENTITY_STALE");

  // Real provider usage, normalized by the exact existing ledger helper; no
  // estimates, text parsing or request-model claims. Preserve it on failures.
  const knownUsage = { inputTokens: 12, outputTokens: 4, totalTokens: 16, cachedInputTokens: 2, reasoningTokens: 1 };
  const openaiUsage = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16,
    prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } };
  const usageResponse = (usage, extra = {}) => ({ model: "reported/model-v2", usage,
    choices: [{ message: { content: "合成图片说明" } }], ...extra });
  const metadataRun = (data, changes = {}) => invoke({ fetchImpl: async () => new Response(JSON.stringify(data)), ...changes });
  assert.deepEqual(await metadataRun(usageResponse(openaiUsage)), {
    text: "合成图片说明", route: "chat", reason: "CHAT_IMAGES_CONFIRMED", usage: knownUsage,
    model: "reported/model-v2", provider: "openai-compatible"
  });
  assert.deepEqual((await metadataRun(usageResponse({ input_tokens: 12, output_tokens: 4, total_tokens: 16,
    input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } }))).usage, knownUsage);
  for (const usage of [undefined, null, "12 tokens", [], { prompt_tokens: "12", completion_tokens: -1, total_tokens: 1.5 }]) {
    assert.deepEqual((await metadataRun(usageResponse(usage))).usage, unknownUsage);
  }
  assert.deepEqual((await metadataRun(usageResponse({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }))).usage,
    { ...unknownUsage, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.deepEqual((await metadataRun(usageResponse({ prompt_tokens: 7 }))).usage, { ...unknownUsage, inputTokens: 7 });
  assert.equal((await metadataRun(usageResponse({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 100 }))).usage.totalTokens, null);
  for (const model of [base.apiKey, `echo-${base.apiKey}`, "sk-not-a-model", "BearerToken", base.prompt,
    "https://private.invalid/DO_NOT_RETURN_SECRET", { secret: base.apiKey }]) {
    assert.equal((await metadataRun(usageResponse(openaiUsage, { model }))).model, null);
  }
  const metadata = await metadataRun(usageResponse({ ...openaiUsage, secret: "DO_NOT_RETURN_SECRET" }, {
    provider: "DO_NOT_RETURN_SECRET", id: "DO_NOT_RETURN_SECRET", error: { message: "DO_NOT_RETURN_SECRET" }
  }));
  assert.doesNotMatch(JSON.stringify(metadata), /DO_NOT_RETURN_SECRET|fake-key-only-for-tests/);
  assert.deepEqual(Object.keys(metadata).sort(), ["model", "provider", "reason", "route", "text", "usage"]);
  for (const [status, data, code] of [
    [429, usageResponse(openaiUsage, { error: { message: "DO_NOT_RETURN_SECRET" } }), "VISION_REQUEST_FAILED"],
    [500, usageResponse({ prompt_tokens: 7 }), "VISION_REQUEST_FAILED"],
    [200, usageResponse(openaiUsage, { choices: [{ message: { content: "" } }] }), "VISION_EMPTY_RESPONSE"],
    [200, usageResponse(openaiUsage, { choices: [{ finish_reason: "length", message: { content: "partial" } }] }), "VISION_OUTPUT_TRUNCATED"],
    [200, usageResponse(openaiUsage, { choices: [{ message: { tool_calls: [{}] } }] }), "VISION_TOOL_CALL_REFUSED"]
  ]) {
    await assert.rejects(metadataRun(data, { fetchImpl: async () => new Response(JSON.stringify(data), { status }) }), error => {
      assert.equal(error.code, code);
      assert.deepEqual(error.metadata, { usage: status === 500 ? { ...unknownUsage, inputTokens: 7 } : knownUsage,
        model: "reported/model-v2", provider: "openai-compatible", httpStatus: status });
      assert.doesNotMatch(JSON.stringify(error), /DO_NOT_RETURN_SECRET|fake-key-only-for-tests/);
      return true;
    });
  }
  console.log("vision contract: PASS (image bytes, evidence-bound routing, fallback, identity, cancellation, privacy, real usage metadata incl. errors; mock only)");
} finally { await rm(dir, { recursive: true, force: true }); }
