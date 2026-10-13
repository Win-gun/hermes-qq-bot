/* Early theme paint, then deferred UI-only bindings. Never calls bridge APIs. */
(() => {
  "use strict";
  const key = "hermesqq.console.theme";
  const themes = new Set(["dark", "light", "system"]);
  const root = document.documentElement;
  const desktop = window.hermesQQ;
  let media;
  try { media = window.matchMedia("(prefers-color-scheme: dark)"); } catch { /* Dark default when unavailable. */ }
  let preference = "dark";
  let nativeResolved = null;
  let themeRequest = 0;
  let confirmedRequest = 0;
  const pendingRequests = new Set();
  const validNativeState = (state) => state?.ok !== false && themes.has(state?.theme) && ["dark", "light"].includes(state?.resolvedTheme);
  const readPreference = () => {
    try { const value = window.localStorage.getItem(key); return themes.has(value) ? value : "dark"; }
    catch { return "dark"; }
  };
  preference = readPreference();
  // The native snapshot is authoritative in Electron and available before paint.
  try {
    const state = desktop?.getTheme?.();
    if (validNativeState(state)) {
      preference = state.theme;
      nativeResolved = state.resolvedTheme;
    }
  }
  catch { /* Web/local fallback remains usable if IPC is unavailable. */ }
  let confirmed = { theme: preference, resolvedTheme: nativeResolved };
  let renderedPreference;
  let renderedTheme;
  function apply() {
    const actual = preference === "system" ? (nativeResolved || (media?.matches ? "dark" : "light")) : preference;
    renderedPreference = preference;
    renderedTheme = actual;
    root.dataset.theme = actual;
    root.dataset.themePreference = preference;
    root.style.colorScheme = actual;
    document.querySelectorAll("[data-console-theme]").forEach((select) => { select.value = preference; });
  }
  function persist() {
    try { window.localStorage.setItem(key, preference); } catch { /* Private mode / disabled storage. */ }
  }
  async function setTheme(value, { native = true } = {}) {
    if (!themes.has(value)) return;
    const request = ++themeRequest;
    preference = value;
    nativeResolved = null;
    persist();
    apply();
    const feedback = document.getElementById("consoleThemeState");
    if (feedback) feedback.textContent = "";
    if (native && typeof desktop?.setTheme === "function") {
      pendingRequests.add(request);
      try {
        const state = await desktop.setTheme(value);
        if (!validNativeState(state)) throw new Error("Invalid native theme response");
        pendingRequests.delete(request);
        if (request >= confirmedRequest) {
          confirmed = { theme: state.theme, resolvedTheme: state.resolvedTheme };
          confirmedRequest = request;
        }
        if (request === themeRequest || !pendingRequests.size) {
          preference = confirmed.theme;
          nativeResolved = confirmed.resolvedTheme;
          persist();
          apply();
        }
      } catch {
        pendingRequests.delete(request);
        if (request !== themeRequest) return;
        preference = confirmed.theme;
        nativeResolved = confirmed.resolvedTheme;
        persist();
        apply();
        if (feedback) feedback.textContent = "外观保存失败，请重试。";
      }
    } else {
      confirmed = { theme: preference, resolvedTheme: nativeResolved };
      confirmedRequest = request;
    }
  }
  apply();
  const systemChanged = () => {
    if (preference !== "system") return;
    nativeResolved = null;
    try {
      const state = desktop?.getTheme?.();
      if (validNativeState(state) && state.theme === "system") {
        nativeResolved = state.resolvedTheme;
        if (!pendingRequests.size) confirmed = { theme: state.theme, resolvedTheme: state.resolvedTheme };
      }
    } catch { /* Browser media query remains the fallback. */ }
    apply();
  };
  if (media?.addEventListener) media.addEventListener("change", systemChanged);
  else media?.addListener?.(systemChanged);
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) setTheme(readPreference());
  });
  // Native preload also applies changes originating outside this page. Reflect
  // those changes in both selectors without re-sending IPC or affecting forms.
  const themeObserver = new MutationObserver(() => {
    if (root.dataset.themePreference === renderedPreference && root.dataset.theme === renderedTheme) return;
    // Own optimistic writes and preload writes from in-flight/stale responses
    // are not confirmations. Their promises establish request ordering.
    if (pendingRequests.size) { apply(); return; }
    try {
      const state = desktop?.getTheme?.();
      if (validNativeState(state)) {
        confirmed = { theme: state.theme, resolvedTheme: state.resolvedTheme };
        confirmedRequest = ++themeRequest;
        preference = confirmed.theme;
        nativeResolved = confirmed.resolvedTheme;
        persist();
      }
    } catch { /* Retain the last acknowledged native state. */ }
    apply();
  });
  themeObserver.observe(root, { attributes: true, attributeFilter: ["data-theme-preference", "data-theme"] });

  function bindUI() {
    document.querySelectorAll("[data-console-theme]").forEach((select) => {
      select.value = preference;
      select.addEventListener("change", () => setTheme(select.value));
    });
    const sidebar = document.getElementById("consoleSidebar");
    const main = document.getElementById("consoleMain");
    const header = document.getElementById("consoleMobileHeader");
    const opener = document.getElementById("consoleMenuButton");
    const closer = document.getElementById("consoleMenuClose");
    const backdrop = document.getElementById("consoleDrawerBackdrop");
    if (sidebar && main && header && opener && closer && backdrop) {
      const smallScreen = window.matchMedia("(max-width: 767px)");
      let open = false;
      let returnFocus;
      const focusable = () => [...sidebar.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex="0"]')]
        .filter((node) => !node.disabled && !node.closest("[hidden], .hidden, [inert]") && node.getClientRects().length);
      function closeDrawer({ restore = true } = {}) {
        if (!open) return;
        open = false;
        sidebar.classList.remove("drawer-open");
        document.body.classList.remove("drawer-open");
        backdrop.hidden = true;
        opener.setAttribute("aria-expanded", "false");
        sidebar.removeAttribute("role");
        sidebar.removeAttribute("aria-modal");
        main.inert = false;
        header.inert = false;
        if (restore) (returnFocus?.isConnected ? returnFocus : opener).focus();
      }
      function openDrawer() {
        if (open || !smallScreen.matches) return;
        open = true;
        returnFocus = document.activeElement;
        sidebar.classList.add("drawer-open");
        document.body.classList.add("drawer-open");
        backdrop.hidden = false;
        opener.setAttribute("aria-expanded", "true");
        sidebar.setAttribute("role", "dialog");
        sidebar.setAttribute("aria-modal", "true");
        main.inert = true;
        header.inert = true;
        closer.focus();
      }
      opener.addEventListener("click", openDrawer);
      closer.addEventListener("click", () => closeDrawer());
      backdrop.addEventListener("click", () => closeDrawer());
      document.addEventListener("keydown", (event) => {
        if (!open) return;
        if (event.key === "Escape") { event.preventDefault(); closeDrawer(); return; }
        if (event.key !== "Tab") return;
        const nodes = focusable();
        const first = nodes[0], last = nodes.at(-1);
        if (!first) { event.preventDefault(); closer.focus(); return; }
        if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      });
      document.addEventListener("focusin", (event) => {
        if (open && !sidebar.contains(event.target)) (focusable()[0] || closer).focus();
      });
      sidebar.addEventListener("click", (event) => {
        if (open && event.target.closest("#nav [data-page]")) { closeDrawer({ restore: false }); main.focus(); }
      });
      smallScreen.addEventListener("change", () => {
        if (!smallScreen.matches) {
          const focusedClose = document.activeElement === closer;
          closeDrawer({ restore: false });
          if (focusedClose) main.focus();
        }
      });
    }

    // Accessible names for legacy controls and dynamic fragments; no values,
    // business listeners, save scopes or draft state are changed here.
    function labelControls(scope) {
      scope.querySelectorAll(".field, .switch-row, .slider-line").forEach((field) => {
        const control = field.querySelector("input, select, textarea");
        const label = field.querySelector(":scope > label");
        if (label && control?.id && !label.htmlFor) label.htmlFor = control.id;
        if (control && !control.labels?.length && !control.hasAttribute("aria-label") && !control.hasAttribute("aria-labelledby")) {
          const name = label?.textContent?.trim() || field.querySelector("strong")?.textContent?.trim();
          if (name) control.setAttribute("aria-label", name);
        }
      });
      scope.querySelectorAll("#groupList .list-item").forEach((item) => {
        item.setAttribute("role", "button");
        item.tabIndex = 0;
      });
    }
    labelControls(document);
    const nav = document.getElementById("nav");
    function syncNavigation() {
      nav?.querySelectorAll("[data-page]").forEach((button) => {
        button.setAttribute("aria-controls", `page-${button.dataset.page}`);
        document.getElementById(`page-${button.dataset.page}`)?.setAttribute("aria-label", button.textContent.trim());
        if (button.classList.contains("active")) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      });
    }
    syncNavigation();
    document.getElementById("groupList")?.addEventListener("keydown", (event) => {
      if (["Enter", " "].includes(event.key) && event.target.matches(".list-item")) { event.preventDefault(); event.target.click(); }
    });
    if (nav) new MutationObserver(syncNavigation).observe(nav, { subtree: true, attributes: true, attributeFilter: ["class"] });
    document.querySelectorAll("[data-tabs]").forEach((tabs) => {
      const buttons = [...tabs.querySelectorAll('[role="tab"]')];
      const syncTabs = () => buttons.forEach((button) => {
        const selected = button.classList.contains("active");
        button.setAttribute("aria-selected", String(selected));
        button.tabIndex = selected ? 0 : -1;
        const panel = document.querySelector(`[data-tab-panel="${tabs.dataset.tabs}:${button.dataset.tab}"]`);
        if (panel) {
          if (!button.id) button.id = `console-tab-${tabs.dataset.tabs}-${button.dataset.tab}`;
          button.setAttribute("aria-controls", panel.id);
          panel.setAttribute("role", "tabpanel");
          panel.setAttribute("aria-labelledby", button.id);
        }
      });
      syncTabs();
      new MutationObserver(syncTabs).observe(tabs, { subtree: true, attributes: true, attributeFilter: ["class"] });
      tabs.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const index = buttons.indexOf(event.target);
        if (index < 0) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length;
        buttons[next].click(); buttons[next].focus();
      });
    });
    const dynamic = document.getElementById("consoleMain");
    if (dynamic) new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach((node) => {
        if (node.nodeType === 1) labelControls(node.parentElement || node);
      }));
    }).observe(dynamic, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bindUI, { once: true });
  else bindUI();
})();
