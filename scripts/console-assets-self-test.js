import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as tar from "tar";
import { releaseFiles, checkArchive, checkFiles } from "./release-safety-check.mjs";

// Execute only the real static branches, never import/start either application.
// No bot, live config, credentials, subprocess, provider or protocol is used.
// --self-check uses synthetic assets while the shared UI files are being built.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selfCheck = process.argv.includes("--self-check");
assert.ok(process.argv.slice(2).every((arg) => arg === "--self-check"), "unknown argument");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hermesqq-console-assets-"));
const assets = [
  { name: "console.css", type: "text/css; charset=utf-8" },
  { name: "console-theme.js", type: "text/javascript; charset=utf-8" }
];
let checks = 0;
function check(value, message) { assert.ok(value, message); checks += 1; }
const hash = (body) => crypto.createHash("sha256").update(body).digest("hex");

function between(source, start, end) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin + start.length);
  assert.ok(begin >= 0 && finish > begin && source.indexOf(start, begin + 1) === -1, `unique fixture boundary: ${start}`);
  return source.slice(begin, finish);
}

function request(server, route, method = "GET") {
  return new Promise((resolve, reject) => {
    // Raw HTTP paths keep ../ and encoded traversal intact for negative tests.
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: route, method, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("isolated static request timed out")));
    req.end();
  });
}

async function verifyRoutes(kind, codeRoot, resourceOverride, expected) {
  const source = fs.readFileSync(path.join(root, "src", `${kind}.js`), "utf8");
  const declaration = source.match(/^const resourceRoot = (.+);$/m);
  assert.ok(declaration, `${kind} resource root declaration`);
  const context = vm.createContext({
    path, fileURLToPath, __dirname: path.join(codeRoot, "src"),
    moduleUrl: pathToFileURL(path.join(codeRoot, "src", `${kind}.js`)).href,
    process: { env: resourceOverride ? { HERMES_QQ_RESOURCE_ROOT: resourceOverride } : {} }
  });
  const resourceRoot = vm.runInContext(declaration[1].replaceAll("import.meta.url", "moduleUrl"), context);
  check(resourceRoot === (resourceOverride || codeRoot), `${kind} resolves the correct development/packaged resource root`);
  context.resourceRoot = resourceRoot;
  if (kind === "bridge") {
    const publicDeclaration = source.match(/^const publicDir = (.+);$/m);
    assert.ok(publicDeclaration, "bridge public resource declaration");
    context.publicDir = vm.runInContext(publicDeclaration[1], context);
  }
  const reads = [];
  const allowed = new Set(assets.map(({ name }) => path.join(resourceRoot, "public", name)));
  context.fs = {
    existsSync(file) { assert.ok(allowed.has(file), "only fixed public asset paths may be tested"); return fs.existsSync(file); },
    readFileSync(file) { assert.ok(allowed.has(file), "only fixed public asset paths may be read"); reads.push(file); return fs.readFileSync(file); }
  };
  const branch = between(source, "const consoleAsset = new Map([", kind === "bridge" ? "const accountQrMatch =" : "if (req.method === \"GET\" && pathname === \"/health\"");
  const handler = vm.runInContext(`(req, res) => {
    const replyJson = (status, payload) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
    const reply = (_res, status, payload) => replyJson(status, payload);
    ${branch}
    replyJson(404, { ok: false, error: "fixture_not_static" });
  }`, context);
  const server = http.createServer((req, res) => {
    try { handler(req, res); } catch { res.writeHead(500); res.end(); }
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    for (const { name, type } of assets) {
      for (const suffix of ["", "?v=fixture", "?ignored=../../config.json"]) {
        const get = await request(server, `/${name}${suffix}`);
        check(get.status === 200, `${kind} GET ${name}`);
        check(get.headers["content-type"] === type, `${kind} MIME ${name}`);
        check(get.headers["content-length"] === String(expected.get(name).length), `${kind} length ${name}`);
        check(get.headers["x-content-type-options"] === "nosniff" && get.headers["cache-control"] === "no-store", `${kind} safe response headers`);
        check(hash(get.body) === hash(expected.get(name)), `${kind} exact asset hash ${name}`);
        const head = await request(server, `/${name}${suffix}`, "HEAD");
        check(head.status === 200 && head.body.length === 0, `${kind} HEAD has no body`);
        check(head.headers["content-type"] === type && head.headers["content-length"] === get.headers["content-length"], `${kind} HEAD metadata matches GET`);
      }
    }
    for (const route of [
      "/../console.css", "/x/../console-theme.js", "/%2e%2e/console.css",
      "/%2e%2e%2fconsole.css", "/console.css/../console-theme.js",
      "/console.css/../../config.json", "/console-theme.js%2f..%2fconfig.json",
      "/console.css%00", "/%63onsole.css", "/console.css/", "/console-theme.js/",
      "//console.css", "/public/console.css", "/public/config.json",
      "/config.json", "/data/memory.json", "/package.json", "/unknown.js", "/constructor", "/__proto__"
    ]) {
      for (const method of ["GET", "HEAD"]) {
        const before = reads.length;
        const result = await request(server, route, method);
        check(result.status === 404 && reads.length === before, `${kind} rejects non-allowlisted path without file read: ${route}`);
      }
    }
    for (const { name } of assets) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        const before = reads.length;
        check((await request(server, `/${name}`, method)).status === 404 && reads.length === before, `${kind} static branch refuses ${method}`);
      }
    }
    const missing = path.join(resourceRoot, "public", assets[0].name);
    fs.renameSync(missing, `${missing}.fixture-hidden`);
    try {
      for (const method of ["GET", "HEAD"]) check((await request(server, "/console.css", method)).status === 404, `${kind} missing asset returns 404`);
    } finally { fs.renameSync(`${missing}.fixture-hidden`, missing); }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

try {
  const expected = new Map(assets.map(({ name }) => [name, selfCheck
    ? Buffer.from(name.endsWith(".css") ? ":root { --fixture: '中文'; }\n" : "globalThis.consoleAssetFixture = '中文';\n")
    : fs.readFileSync(path.join(root, "public", name))]));
  const assetPaths = assets.map(({ name }) => `public/${name}`);
  for (const file of assetPaths) check(releaseFiles.includes(file), `Web release whitelist includes ${file}`);
  if (!selfCheck) check(checkFiles(assetPaths).length === 0, "real assets pass release content safety checks");
  const sourceScript = fs.readFileSync(path.join(root, "scripts", "package-source.mjs"), "utf8");
  const sourceFiles = vm.runInNewContext(`${between(sourceScript, "const sourceFiles =", "const version =")}\nsourceFiles;`, { releaseFiles });
  for (const file of [...assetPaths, "scripts/console-assets-self-test.js"]) check(sourceFiles.includes(file), `source whitelist includes ${file}`);
  const forge = createRequire(import.meta.url)(path.join(root, "forge.config.cjs"));
  for (const file of assetPaths) check(!forge.packagerConfig.ignore.some((rule) => rule.test(`/${file}`)), `Forge retains ${file} at app root`);

  const roots = [path.join(temp, "development"), path.join(temp, "Hermes QQ Bot.app", "Contents", "Resources", "app.asar")];
  for (const resourceRoot of roots) {
    fs.mkdirSync(path.join(resourceRoot, "public"), { recursive: true });
    for (const [name, contents] of expected) fs.writeFileSync(path.join(resourceRoot, "public", name), contents);
    // Writable state is deliberately different from the application asset root.
    fs.writeFileSync(path.join(resourceRoot, "config.json"), "fixture-must-not-be-served");
  }
  await verifyRoutes("bridge", roots[0], undefined, expected);
  await verifyRoutes("web-host", roots[0], undefined, expected);
  await verifyRoutes("bridge", path.join(temp, "unused-code-root"), roots[1], expected);
  await verifyRoutes("web-host", roots[1], undefined, expected);

  const archive = path.join(temp, "console-assets.tar.gz");
  const prefix = "console-assets-fixture";
  await tar.c({ cwd: roots[0], file: archive, gzip: true, prefix, portable: true }, assetPaths);
  check((await checkArchive(archive, prefix, assetPaths)).length === 0, "release archive preserves both explicit assets");
  const archivedHashes = new Map();
  await tar.t({ file: archive, onReadEntry(entry) {
    const chunks = [];
    entry.on("data", (chunk) => chunks.push(chunk));
    entry.on("end", () => archivedHashes.set(entry.path.slice(prefix.length + 1), hash(Buffer.concat(chunks))));
  } });
  for (const { name } of assets) check(archivedHashes.get(`public/${name}`) === hash(expected.get(name)), `packaged asset hash matches both servers: ${name}`);
  await tar.c({ cwd: roots[0], file: archive, gzip: true, prefix }, [assetPaths[0]]);
  check((await checkArchive(archive, prefix, assetPaths)).some(({ rule }) => rule === "ARCHIVE_MISSING_CANDIDATE"), "archive checker rejects omitted shared asset");
  await tar.c({ cwd: roots[0], file: archive, gzip: true, prefix }, [...assetPaths, "config.json"]);
  check((await checkArchive(archive, prefix, assetPaths)).some(({ rule }) => rule === "ARCHIVE_SENSITIVE_PATH"), "archive checker still rejects runtime config");
  console.log(`Console assets ${selfCheck ? "fixture-only self-check" : "self-test"} passed (${checks} checks; isolated static branches, no application startup)`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
