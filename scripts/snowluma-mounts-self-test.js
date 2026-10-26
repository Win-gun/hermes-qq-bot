import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { snowlumaMountArgs } from "../src/snowluma-mounts.js";

// Pure fixtures only: never import the bridge, run Docker or read runtime config.
const files = Object.freeze({ dataDir: "/fixture/SnowLuma state/data", configDir: "/fixture/SnowLuma state/config" });
const volumes = Object.freeze({ snowlumaData: "fixture-gateway", appConfig: "fixture-qq-config", localShare: "fixture-qq-share" });
let tests = 0;
function check(name, run) { run(); tests++; }
function mountsFor(inputFiles, inputVolumes) {
  const args = snowlumaMountArgs(inputFiles, inputVolumes);
  assert.equal(args.length % 2, 0);
  const mounts = new Map();
  for (let index = 0; index < args.length; index += 2) {
    assert.equal(args[index], "-v");
    const parts = args[index + 1].split(":");
    assert.equal(parts.length, 2, "every mount has an explicit source, never anonymous/options injection");
    const [source, target] = parts;
    assert.ok(source);
    assert.ok(!mounts.has(target), "no competing mounts at the same target");
    mounts.set(target, source);
  }
  return mounts;
}

check("managed gateway aliases and unchanged QQ volumes", () => {
  const mounts = mountsFor(files, volumes);
  assert.equal(mounts.size, 6);
  assert.equal(mounts.get("/app/data"), volumes.snowlumaData);
  assert.equal(mounts.get("/app/snowluma-data"), volumes.snowlumaData);
  assert.equal(mounts.get("/app/.config"), volumes.appConfig);
  assert.equal(mounts.get("/app/.local/share"), volumes.localShare);
  assert.ok(![...mounts.values()].includes(files.dataDir), "managed gateway must not be hidden by the old full host bind");
});
check("uploads and old host config bind", () => {
  for (const selectedVolumes of [volumes, null]) {
    const mounts = mountsFor(files, selectedVolumes);
    assert.equal(mounts.get("/app/data/hermes-task-uploads"), `${files.dataDir}/hermes-task-uploads`);
    assert.equal(mounts.get("/app/config"), files.configDir);
  }
});
check("unmanaged layout persists both gateway paths in the same host directory", () => {
  const mounts = mountsFor(files, null);
  assert.equal(mounts.size, 4);
  assert.equal(mounts.get("/app/data"), files.dataDir);
  assert.equal(mounts.get("/app/snowluma-data"), files.dataDir);
  assert.equal(mounts.get("/app/data/hermes-task-uploads"), `${mounts.get("/app/data")}/hermes-task-uploads`);
  assert.deepEqual(snowlumaMountArgs(files), snowlumaMountArgs(files, null));
});
check("deterministic construction without input mutation", () => {
  const before = JSON.stringify({ files, volumes });
  const first = snowlumaMountArgs(files, volumes);
  assert.deepEqual(first, snowlumaMountArgs(files, volumes));
  first.length = 0;
  assert.notEqual(snowlumaMountArgs(files, volumes).length, 0);
  assert.equal(JSON.stringify({ files, volumes }), before);
  assert.deepEqual(snowlumaMountArgs({ ...files, dataDir: `${files.dataDir}/` }, volumes), snowlumaMountArgs(files, volumes));
});
for (const invalid of [undefined, null, {}, [], "", false, 3]) {
  check("reject missing or invalid host directories", () => assert.throws(() => snowlumaMountArgs(invalid), TypeError));
}
for (const field of ["dataDir", "configDir"]) {
  for (const invalid of [undefined, null, "", "relative/data", " /fixture/data", "/fixture:ro", "/fixture\0data", "/fixture\ndata", {}, 3]) {
    check(`reject invalid ${field}`, () => assert.throws(() => snowlumaMountArgs({ ...files, [field]: invalid }, volumes), TypeError));
  }
}
for (const invalid of [[], "", "fixture", false, 3, {}]) {
  check("reject invalid volume sets rather than silently falling back", () => assert.throws(() => snowlumaMountArgs(files, invalid), TypeError));
}
for (const field of ["snowlumaData", "appConfig", "localShare"]) {
  for (const invalid of [undefined, null, "", " ", "-flag", "name:ro", "/host/path", "name/child", "name\n", {}, 3]) {
    check(`reject invalid ${field}`, () => assert.throws(() => snowlumaMountArgs(files, { ...volumes, [field]: invalid }), TypeError));
  }
}
check("bridge delegates mount construction and prepares the upload directory", () => {
  const source = readFileSync(new URL("../src/bridge.js", import.meta.url), "utf8");
  const creation = source.slice(source.indexOf("async function createSnowLumaAccountContainer("), source.indexOf("async function ensureSnowLumaAccountContainer("));
  assert.match(source, /import \{ snowlumaMountArgs \} from "\.\/snowluma-mounts\.js"/);
  assert.match(creation, /snowlumaMountArgs\(files, volumes\)/);
  assert.match(creation, /fs\.mkdirSync\(path\.join\(files\.dataDir, "hermes-task-uploads"\), \{ recursive: true \}\)/);
  assert.match(creation, /\.\.\.mountArgs/);
  assert.doesNotMatch(creation, /"-v"/);
});
console.log(JSON.stringify({ ok: true, tests, dockerUsed: false, liveConfigRead: false }));
