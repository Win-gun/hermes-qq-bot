const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeTaskWebDomains(values) {
  if (!Array.isArray(values) || values.length > 20) throw new Error("Task web domains must be a list of at most 20 domains");
  const domains = values.map((value) => String(value || "").trim().toLowerCase());
  if (domains.some((domain) => !DOMAIN.test(domain) || domain.includes("..") || domain.endsWith(".local"))) {
    throw new Error("Task web domains must be plain public hostnames");
  }
  return [...new Set(domains)];
}

export function taskWebSourceAllowed(url, domains) {
  if (!domains?.length) return true;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) return false;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

export function taskWebQuery(query, domains) {
  if (!domains?.length) return query;
  return `${query} (${domains.map((domain) => `site:${domain}`).join(" OR ")})`;
}
