(function installAutoFlowRebuildBridge() {
  const SOURCE = "autoflow-1080-rebuild-v26";
  const BRIDGE_VERSION = "10.8.4-launch-v105";
  const EXPECTED_PAGE_HOOK_VERSION = "10.8.4-launch-v105";
  if (window.__afRebuildContentBridgeInstalled && window.__afRebuildContentBridgeVersion === BRIDGE_VERSION) {
    const hasFreshPageHook = window.__afRebuildPageHookInstalled === true &&
      window.__afRebuildPageHookVersion === EXPECTED_PAGE_HOOK_VERSION;
    if (!hasFreshPageHook) {
      injectPageHook();
    }
    try {
      chrome.runtime.sendMessage({
        type: "af.rebuild.bridge.health",
        payload: {
          ok: true,
          href: location.href,
          alreadyInstalled: true,
          bridgeVersion: BRIDGE_VERSION,
          pageHookVersion: window.__afRebuildPageHookVersion || "",
          pageHookInstalled: Boolean(window.__afRebuildPageHookInstalled)
        },
        meta: {
          createdAt: new Date().toISOString(),
          source: SOURCE
        }
      });
    } catch (_err) {}
    return;
  }
  window.__afRebuildContentBridgeInstalled = true;
  window.__afRebuildContentBridgeVersion = BRIDGE_VERSION;
  const pending = new Map();

  function isCurrentBridge() {
    return window.__afRebuildContentBridgeVersion === BRIDGE_VERSION;
  }

  function send(type, payload) {
    try {
      chrome.runtime.sendMessage({
        type,
        payload,
        meta: {
          createdAt: new Date().toISOString(),
          source: SOURCE
        }
      });
    } catch (_err) {
      // Content scripts can be invalidated during extension reloads.
    }
  }

  function injectPageHook() {
    const script = document.createElement("script");
    script.src = `${chrome.runtime.getURL("src/page/page-hook.js")}?v=${encodeURIComponent(BRIDGE_VERSION)}-${Date.now()}`;
    script.dataset.autoflowRebuild = "page-hook";
    script.async = false;
    script.onload = () => script.remove();
    script.onerror = () => script.remove();
    (document.documentElement || document.head).appendChild(script);
  }

  function requestPageHook(payload = {}, timeoutMs = 10000, requireFreshHook = true) {
    const requestId = crypto.randomUUID();
    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({ ok: false, error: "page_command_timeout" });
      }, timeoutMs);
      pending.set(requestId, { resolve, timer, requireFreshHook });
    });
    window.postMessage(
      {
        source: SOURCE,
        type: "af.rebuild.page.command",
        requestId,
        payload
      },
      "*"
    );
    return promise;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE) return;
    if (data.type === "af.rebuild.page.command.result" && data.requestId) {
      const entry = pending.get(data.requestId);
      if (!entry) return;
      if (entry.requireFreshHook && data.payload?.hookVersion !== EXPECTED_PAGE_HOOK_VERSION) {
        return;
      }
      pending.delete(data.requestId);
      clearTimeout(entry.timer);
      entry.resolve(data.payload || {});
      return;
    }
    if (data.type !== "af.rebuild.page.event") return;
    send("af.rebuild.page.event", data.payload || {});
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isCurrentBridge()) return false;
    if (message && (message.type === "af.rebuild.bridge.health" || message.type === "af.rebuild.bridge.health.v2" || message.type === "af.rebuild.bridge.health.v3" || message.type === "af.rebuild.bridge.health.v4")) {
      const requireFreshHook = message.type === "af.rebuild.bridge.health.v4";
      requestPageHook({ action: "health" }, 1500, requireFreshHook).then((hook) => {
        sendResponse({
          ok: true,
          href: location.href,
          bridgeVersion: BRIDGE_VERSION,
          pageHookVersion: hook?.hookVersion || "",
          pageHookInstalled: hook?.hookInstalled === true,
          pageHookHealth: hook || null
        });
      });
      return true;
    }
    if (!message || (message.type !== "af.rebuild.page.command" && message.type !== "af.rebuild.page.command.v2" && message.type !== "af.rebuild.page.command.v3" && message.type !== "af.rebuild.page.command.v4")) return false;
    const timeoutMs = Math.max(1000, Number(message.payload?.timeoutMs || 10000));
    const requireFreshHook = message.payload?.requireFreshHook !== false;
    requestPageHook(message.payload || {}, timeoutMs, requireFreshHook).then((result) => sendResponse(result));
    return true;
  });

  injectPageHook();
  send("af.rebuild.bridge.health", { href: location.href });
})();
