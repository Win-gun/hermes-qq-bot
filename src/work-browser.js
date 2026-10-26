import { randomUUID } from "node:crypto";

const fail = code => Object.assign(new Error(code), { code });

/**
 * Controlled Playwright-context implementation, NOT a verified browser host.
 * Production readiness is intentionally false. Browser routing cannot prove OS
 * isolation, DNS pinning, redirect/QUIC/WebRTC egress or native process fencing.
 * No launch(), CDP, persistent profile, cookies import, shell or filesystem read.
 * The only runnable path accepts an explicitly injected fixtureBrowser. Never
 * register it for real work by turning on fixture mode in production.
 *
 * A future isolated host may reuse the context code after independently proving
 * its network/OS boundary. Optional dependency is probed only on explicit call;
 * importing this module does not import Playwright or start any process.
 */
export function createPlaywrightBrowserAdapter({ fixtureBrowser = null,
  loadPlaywright = () => import("playwright"), resolveUpload } = {}) {
  const gaps = Object.freeze(["No verified OS/network-isolated browser host or pinned egress proxy",
    "No production browser process stop/fencing supervisor; no existing profiles/login state accepted",
    "No standalone download/submit Broker actions; downloads are disabled (forms use click/press)"]);
  const manifest = Object.freeze({ id: "playwright-controlled-context", capabilities: Object.freeze(["isolated_browser", "authenticated_browser"]),
    verified: false, available: false, fixtureOnly: fixtureBrowser !== null, gaps });

  return Object.freeze({ manifest,
    readiness: async () => fixtureBrowser ? { available: true, fixtureOnly: true }
      : { available: false, reason: gaps.join("; ") },
    async probeDependency() {
      try { await loadPlaywright(); return { available: false, dependencyPresent: true, code: "UNAVAILABLE", gaps }; }
      catch { return { available: false, dependencyPresent: false, code: "UNAVAILABLE", gaps: ["Optional Playwright dependency missing", ...gaps] }; }
    },
    async openSession({ owner, partition, onRequest, signal, authorizeStep }) {
      if (!fixtureBrowser) throw fail("UNAVAILABLE");
      if (typeof authorizeStep !== "function") throw fail("AUTHORIZATION_REQUIRED");
      if (signal?.aborted) throw fail("ABORTED");
      // Only fresh contexts. No userDataDir, executablePath, launch arguments,
      // storage-state path, proxy or CDP endpoint may come from request args.
      const context = await fixtureBrowser.newContext({ serviceWorkers: "block", acceptDownloads: false,
        ignoreHTTPSErrors: false, permissions: [], storageState: { cookies: [], origins: [] } });
      let page, closed = false, poisoned = false, closePromise;
      const handles = new Map();
      try {
        if (typeof context.routeWebSocket !== "function") throw fail("UNAVAILABLE");
        await context.routeWebSocket("**/*", socket => socket.close());
        await context.route("**/*", async route => {
          try {
            if (closed || signal?.aborted) throw fail("ABORTED");
            const req = route.request();
            const target = { kind: "network", url: req.url(), method: req.method(), resourceType: req.resourceType() };
            await onRequest(target);
            if (closed || signal?.aborted) throw fail("ABORTED");
            authorizeStep("network_request", target);
            await route.continue();
          } catch { poisoned = true; await route.abort("blockedbyclient"); }
        });
        page = await context.newPage();
        context.on("page", other => { if (other !== page) { poisoned = true; void other.close().catch(() => {}); } });
      } catch (error) {
        // If cleanup throws, propagate failure; the registry quarantines an
        // incomplete open and never treats it as a safe-to-retry operation.
        await context.close();
        throw error;
      }

      const alive = () => { if (closed || poisoned || signal?.aborted) throw fail("BROWSER_SESSION_FENCED"); };
      const describe = element => element.evaluate(el => ({ tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "", role: el.getAttribute("role") || "",
        url: el.href || el.form?.action || el.ownerDocument.location.href,
        method: el.form?.method || "GET", connected: el.isConnected }));
      const resolveElement = async (handle, action) => {
        const entry = handles.get(handle);
        if (!entry) throw fail("BROWSER_STALE_HANDLE");
        const { element } = entry;
        authorizeStep(action, { kind: "browser", partitionId: partition.id, fresh: true, handle, ...entry.description });
        const description = await describe(element);
        if (!description.connected) throw fail("BROWSER_STALE_HANDLE");
        return { element, description };
      };
      const observe = async (action, args) => {
        alive();
        const target = { kind: "browser", partitionId: partition.id, fresh: true, url: page.url() };
        if (action === "navigate") return { ...target, url: new URL(args.url).href, method: "GET" };
        // about:blank is internal initial state only, never a navigable target.
        if (target.url === "about:blank") delete target.url;
        const targetAction = action === "verify" ? args.verifyAction : action;
        if (["click", "fill", "type", "press", "upload"].includes(targetAction)) {
          if ("selector" in args || "path" in args || "files" in args) throw fail("BROWSER_RAW_TARGET_DENIED");
          const { description } = await resolveElement(args.handle, targetAction);
          return { ...target, ...description, handle: args.handle };
        }
        if (action === "snapshot") {
          authorizeStep(action, target);
          handles.clear();
          const elements = await page.locator("a,button,input,textarea,select,[role=button]").elementHandles();
          const targets = [];
          for (const element of elements.slice(0, 128)) {
            const handle = randomUUID();
            authorizeStep(action, target);
            const description = await describe(element);
            handles.set(handle, { element, description });
            targets.push({ handle, ...description });
          }
          return { ...target, targets };
        }
        return target;
      };
      return {
        owner: structuredClone(owner), partition: structuredClone(partition), observe,
        async execute(action, args, target) {
          alive();
          const wireTarget = await observe(action, args);
          authorizeStep(action, wireTarget);
          alive();
          let result;
          if (action === "navigate") { handles.clear(); await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 15_000 }); result = { url: page.url() }; }
          else if (action === "read") result = { text: (await page.locator("body").innerText({ timeout: 5_000 })).slice(0, 32_000) };
          else if (action === "snapshot") result = { mimeType: "image/png", bytes: await page.screenshot({ type: "png", fullPage: false, timeout: 5_000 }), targets: wireTarget.targets };
          else {
            const { element, description } = await resolveElement(args.handle, action);
            // Freshness check at the host boundary. All interactions additionally
            // require external_write; navigation requests get their own guard.
            for (const key of ["tag", "type", "role", "url", "method"]) {
              if (description[key] !== target[key]) throw fail("BROWSER_TARGET_CHANGED");
            }
            authorizeStep(action, { ...wireTarget, ...description });
            if (action === "click") await element.click({ timeout: 5_000 });
            else if (action === "fill" || action === "type") {
              if (typeof args.text !== "string" || args.text.length > 16_000) throw fail("BROWSER_INPUT_DENIED");
              await element.fill(args.text, { timeout: 5_000 });
            } else if (action === "press") {
              if (!["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "Space"].includes(args.key)) throw fail("BROWSER_KEY_DENIED");
              await element.press(args.key, { timeout: 5_000 });
            } else if (action === "upload") {
              if (typeof resolveUpload !== "function") throw fail("UPLOAD_UNAVAILABLE");
              const upload = await resolveUpload({ owner, artifactId: args.artifactId, partition });
              if (upload?.taskId !== owner.taskId || upload?.logicalBotId !== owner.logicalBotId
                || upload?.accountId !== owner.accountId || !Buffer.isBuffer(upload?.buffer)
                || upload.buffer.length > 16 * 1024 * 1024 || [".", ".."].includes(upload.name)
                || typeof upload.name !== "string" || !/^[\w.-]{1,128}$/.test(upload.name)) throw fail("UPLOAD_SCOPE_DENIED");
              alive();
              const uploadTarget = await observe(action, args);
              authorizeStep(action, uploadTarget);
              alive();
              await element.setInputFiles({ name: upload.name, mimeType: "application/octet-stream", buffer: upload.buffer }, { timeout: 5_000 });
            } else throw fail("BROWSER_ACTION_DENIED");
            result ??= { completed: true };
          }
          alive();
          return result;
        },
        async close() {
          if (!closePromise) {
            closed = true;
            handles.clear();
            closePromise = (async () => { await context.close(); return true; })();
          }
          // A failed/pending first close is never upgraded to stopped:true and
          // never retried. Only the external supervisor can resolve uncertainty.
          return closePromise;
        }
      };
    }
  });
}
