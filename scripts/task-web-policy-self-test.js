import assert from "node:assert/strict";
import { normalizeTaskWebDomains, taskWebQuery, taskWebSourceAllowed } from "../src/task-web-policy.js";

const domains = normalizeTaskWebDomains([" Docs.Example.org ", "news.example.com", "docs.example.org"]);
assert.deepEqual(domains, ["docs.example.org", "news.example.com"]);
assert.equal(taskWebSourceAllowed("https://docs.example.org/guide", domains), true);
assert.equal(taskWebSourceAllowed("https://sub.docs.example.org/guide", domains), true);
assert.equal(taskWebSourceAllowed("https://docs.example.org.evil.net/guide", domains), false);
assert.equal(taskWebSourceAllowed("https://evil.net/guide", domains), false);
assert.equal(taskWebSourceAllowed("file:///docs.example.org/guide", domains), false);
assert.equal(taskWebSourceAllowed("https://docs.example.org/guide", []), true);
assert.equal(taskWebQuery("MiMo 文档", domains), "MiMo 文档 (site:docs.example.org OR site:news.example.com)");
for (const bad of ["https://example.com", "localhost", "127.0.0.1", "x.local", "evil.net/path", "*.example.com"]) {
  assert.throws(() => normalizeTaskWebDomains([bad]), /domains/);
}
console.log(JSON.stringify({ ok: true, checks: "domain normalization, exact/subdomain match, query scoping, unsafe rejection" }));
