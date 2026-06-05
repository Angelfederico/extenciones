import { extractMediaIds } from "../core/media/flow-client.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEBUGGER_IDLE_DETACH_MS = 10 * 60 * 1000;
const debuggerSessions = new Map();

let fileChooserListenerInstalled = false;

function installFileChooserListener() {
  if (fileChooserListenerInstalled) return;
  if (!chrome?.debugger?.onEvent?.addListener) return;
  fileChooserListenerInstalled = true;
  chrome.debugger.onEvent.addListener(async (source, method) => {
    if (method !== "Page.fileChooserOpened") return;
    const key = sessionKey(source?.tabId);
    if (!debuggerSessions.get(key)?.attached) return;
    try {
      await debuggerSend(debuggerTarget(source.tabId), "Page.handleFileChooser", { action: "cancel" });
    } catch {
      // Best-effort suppression; page-hook DataTransfer still completes the upload silently.
    }
  });
}

function pointFromRect(rect = {}) {
  const x = Number(rect.x || 0) + Number(rect.width || 0) / 2;
  const y = Number(rect.y || 0) + Number(rect.height || 0) / 2;
  return { x: Math.max(1, Math.round(x)), y: Math.max(1, Math.round(y)) };
}

function mediaIdsFrom(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id || "").trim()).filter(Boolean))];
}

function normalizeId(value = "") {
  return String(value || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || "";
}

function extractSubmitOutputRows(data, { projectId = "" } = {}) {
  const mediaIds = extractMediaIds(data, { projectId });
  const rows = [];
  const add = (mediaId = "", workflowId = "", index = rows.length) => {
    const id = normalizeId(mediaId);
    if (!id) return;
    rows.push({
      mediaId: id,
      workflowId: normalizeId(workflowId),
      mediaIndex: index
    });
  };
  const mediaRows = Array.isArray(data?.media) ? data.media : data?.media ? [data.media] : [];
  mediaRows.forEach((media, index) => add(media?.name, media?.workflowId || media?.mediaMetadata?.workflowId, index));
  if (Array.isArray(data?.operations)) {
    data.operations.forEach((item, index) => {
      const operation = item?.operation || item || {};
      add(
        operation?.metadata?.primaryMediaId || operation?.response?.media?.name || item?.mediaGenerationId || operation?.response?.mediaGenerationId,
        operation?.metadata?.workflowId || operation?.name || item?.workflowId,
        index
      );
    });
  }
  if (!rows.length) mediaIds.forEach((mediaId, index) => add(mediaId, "", index));
  const seen = new Set();
  return rows.filter((row) => {
    if (!row.mediaId || seen.has(row.mediaId)) return false;
    seen.add(row.mediaId);
    return true;
  });
}

function debuggerTarget(tabId) {
  return { tabId: Number(tabId) };
}

function debuggerSend(target, method, params = {}) {
  return chrome.debugger.sendCommand(target, method, params);
}

async function debuggerAttachmentAlive(target) {
  try {
    await debuggerSend(target, "Runtime.evaluate", { expression: "undefined", returnByValue: true });
    return true;
  } catch (error) {
    const message = String(error?.message || error || "");
    if (/not attached|No target with given id|Cannot access/i.test(message)) return false;
    throw error;
  }
}

function sessionKey(tabId) {
  return String(Number(tabId));
}

async function ensureDebuggerAttached(tabId, trace, task) {
  const key = sessionKey(tabId);
  const target = debuggerTarget(tabId);
  const existing = debuggerSessions.get(key);
  if (existing?.detachTimer) {
    clearTimeout(existing.detachTimer);
    existing.detachTimer = null;
  }
  if (existing?.attached) {
    const alive = await debuggerAttachmentAlive(target);
    if (!alive) {
      debuggerSessions.delete(key);
      trace(task, "attach_stale_cleared", { tabId });
    } else {
      trace(task, "attach_reuse", { tabId });
      return { target, reused: true };
    }
  }
  trace(task, "attach_start", { tabId });
  await chrome.debugger.attach(target, "1.3");
  debuggerSessions.set(key, { attached: true, networkEnabled: false, detachTimer: null });
  trace(task, "attach_ok", { tabId });
  return { target, reused: false };
}

async function ensureNetworkEnabled(tabId, target) {
  const key = sessionKey(tabId);
  const session = debuggerSessions.get(key) || { attached: true };
  if (!session.networkEnabled) {
    await debuggerSend(target, "Network.enable");
  }
  if (!session.pageEnabled) {
    await debuggerSend(target, "Page.enable").catch(() => {});
    await debuggerSend(target, "Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});
  }
  debuggerSessions.set(key, { ...session, attached: true, networkEnabled: true, pageEnabled: true });
}

function markDebuggerBusy(tabId, busy, trace, task, reason = "") {
  const key = sessionKey(tabId);
  const session = debuggerSessions.get(key);
  if (!session?.attached) return;
  debuggerSessions.set(key, { ...session, busy: Boolean(busy) });
  trace(task, busy ? "submit_busy_start" : "submit_busy_end", { tabId, reason });
}

function scheduleDebuggerDetach(tabId, trace, task, delayMs = DEBUGGER_IDLE_DETACH_MS) {
  const key = sessionKey(tabId);
  const session = debuggerSessions.get(key);
  if (!session?.attached) return;
  if (session.busy) {
    trace(task, "detach_deferred_busy", { tabId, idleMs: delayMs });
    return;
  }
  if (session.detachTimer) clearTimeout(session.detachTimer);
  session.detachTimer = setTimeout(async () => {
    const latest = debuggerSessions.get(key);
    if (!latest?.attached) return;
    debuggerSessions.delete(key);
    await debuggerSend(debuggerTarget(tabId), "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    await chrome.debugger.detach(debuggerTarget(tabId)).catch(() => {});
    trace(task, "detach_idle", { tabId, idleMs: delayMs });
  }, delayMs);
  debuggerSessions.set(key, session);
  trace(task, "detach_scheduled", { tabId, idleMs: delayMs });
}

export async function releaseDebuggerSessions(reason = "queue_idle", trace = () => {}) {
  const entries = [...debuggerSessions.entries()];
  await Promise.all(entries.map(async ([key, session]) => {
    if (session?.busy) {
      trace({}, "detach_skipped_busy", { tabId: Number(key), reason });
      return;
    }
    debuggerSessions.delete(key);
    if (session?.detachTimer) clearTimeout(session.detachTimer);
    const tabId = Number(key);
    await debuggerSend(debuggerTarget(tabId), "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    await chrome.debugger.detach(debuggerTarget(tabId)).catch(() => {});
    trace({}, "detach_result", { tabId, reason });
  }));
}

async function debuggerClick(target, point) {
  await debuggerSend(target, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
    pointerType: "mouse"
  }).catch(() => {});
  await sleep(35);
  await debuggerSend(target, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    pointerType: "mouse"
  });
  await sleep(45);
  await debuggerSend(target, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    pointerType: "mouse"
  });
}

async function debuggerPressKey(target, key, code, windowsVirtualKeyCode, options = {}) {
  const params = {
    key,
    code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: options.nativeVirtualKeyCode || windowsVirtualKeyCode,
    modifiers: Number(options.modifiers || 0)
  };
  await debuggerSend(target, "Input.dispatchKeyEvent", { type: "keyDown", ...params }).catch(() => {});
  await sleep(Number(options.holdMs || 25));
  await debuggerSend(target, "Input.dispatchKeyEvent", { type: "keyUp", ...params }).catch(() => {});
}

async function debuggerEvaluate(target, expression) {
  const result = await debuggerSend(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  return result?.result?.value;
}

function debuggerModelPatternForTask(task = {}) {
  const mode = String(task.mode || "");
  const raw = String(task.model || "default").trim();
  if (mode === "text-to-image") {
    const hasRefs = [
      ...(Array.isArray(task.refInputs) ? task.refInputs : []),
      ...(Array.isArray(task.refMediaIds) ? task.refMediaIds : []),
      ...(Array.isArray(task.mediaIds) ? task.mediaIds : [])
    ].filter(Boolean).length > 0;
    if (hasRefs) return { source: "Imagen\\s+4", flags: "i" };
    if (raw === "nano_banana_2") return { source: "Nano\\s+Banana\\s+2", flags: "i" };
    if (raw === "imagen_4" || raw.includes("imagen")) return { source: "Imagen\\s+4", flags: "i" };
    return { source: "Nano\\s+Banana\\s+Pro", flags: "i" };
  }
  if (mode === "ingredients-to-video") {
    return raw === "veo3_fast"
      ? { source: "^Veo 3\\.1\\s*-\\s*Fast$", flags: "i" }
      : { source: "Veo 3\\.1\\s*-\\s*Fast\\s*\\[Lower Priority\\]", flags: "i" };
  }
  if (raw === "veo3_lite") return { source: "^Veo 3\\.1\\s*-\\s*Lite$", flags: "i" };
  if (raw === "veo3_fast") return { source: "^Veo 3\\.1\\s*-\\s*Fast$", flags: "i" };
  if (raw === "veo3_fast_low") return { source: "Veo 3\\.1\\s*-\\s*Fast\\s*\\[Lower Priority\\]", flags: "i" };
  if (raw === "veo3_quality") return { source: "^Veo 3\\.1\\s*-\\s*Quality$", flags: "i" };
  return { source: "Veo 3\\.1\\s*-\\s*Lite\\s*\\[Lower Priority\\]", flags: "i" };
}

function debuggerAcceptsCurrentVideoModelFallback(task = {}, normalizedCurrent = "") {
  const requested = String(task.model || "default").trim();
  if (!String(task.mode || "").includes("video")) return false;
  if (!/default|veo3?_fast|veo_3_1.*fast/i.test(requested)) return false;
  return /Veo\s+3\.1\s*-\s*Fast\b/i.test(String(normalizedCurrent || ""));
}

function debuggerAspectForTask(task = {}) {
  const raw = String(task.aspectRatio || "").trim().toLowerCase();
  if (raw === "portrait" || raw === "portrait_3_4" || raw === "9:16") return "PORTRAIT";
  if (raw === "square" || raw === "1:1") return "SQUARE";
  return "LANDSCAPE";
}

function debuggerDurationForTask(task = {}) {
  if (String(task.mode || "") === "ingredients-to-video") return "8";
  const raw = String(task.videoLength || task.videoDurationSeconds || "8").trim();
  return raw === "4" || raw === "6" || raw === "8" ? raw : "8";
}

function expectedVideoRepeat(task = {}) {
  return Math.max(1, Math.min(4, Number.parseInt(task.repeatCount, 10) || 1));
}

function shouldValidateDebuggerStoreModelKeys(task = {}) {
  return String(task.mode || "") !== "ingredients-to-video";
}

function debuggerPreparedSettingsProblems(prepared = {}, task = {}) {
  const mode = String(task.mode || "");
  if (!mode || mode === "text-to-image") return [];
  const expected = prepared?.expected || {};
  const store = prepared?.store || prepared?.trace?.store || {};
  const expectedKeys = expected?.storeModelKeys || {};
  const actualKeys = store?.currentModelKeys || {};
  const problems = [];
  if (expected.visibleMode && String(store.mode || "") !== String(expected.visibleMode || "")) {
    problems.push(`mode:${String(store.mode || "") || "missing"}!=${String(expected.visibleMode || "")}`);
  }
  if (mode !== "ingredients-to-video") {
    const expectedDuration = String(expected.duration || debuggerDurationForTask(task));
    const actualDuration = store.selectedVideoDuration == null ? "" : String(store.selectedVideoDuration);
    if (!actualDuration || actualDuration !== expectedDuration) {
      problems.push(`duration:${actualDuration || "missing"}!=${expectedDuration}`);
    }
  }
  const expectedRepeat = Number(expected.repeat || expectedVideoRepeat(task));
  const actualRepeat = Number(store.outputsPerPrompt || 0);
  if (actualRepeat !== expectedRepeat) {
    problems.push(`repeat:${store.outputsPerPrompt ?? "missing"}!=${expectedRepeat}`);
  }
  if (shouldValidateDebuggerStoreModelKeys(task)) {
    if (expectedKeys.videoApi && String(actualKeys.videoApi || "") !== expectedKeys.videoApi) {
      problems.push(`videoApi:${String(actualKeys.videoApi || "") || "missing"}!=${expectedKeys.videoApi}`);
    }
    if (expectedKeys.videoModelKey && String(actualKeys.videoModelKey || "") !== expectedKeys.videoModelKey) {
      problems.push(`videoModelKey:${String(actualKeys.videoModelKey || "") || "missing"}!=${expectedKeys.videoModelKey}`);
    }
  }
  return problems;
}

function debuggerVisibleModeForTask(task = {}) {
  const mode = String(task.mode || "");
  if (mode === "text-to-video") return "VIDEO";
  if (mode === "image-to-video" || mode === "start-end-image-to-video") return "VIDEO_FRAMES";
  if (mode === "ingredients-to-video") return "VIDEO_REFERENCES";
  if (mode === "text-to-image") return "IMAGE";
  return "";
}

function debuggerShouldAvoidHiddenSettingsStoreRepair(task = {}) {
  void task;
  return false;
}

function debuggerShouldFailClosedOnSettingsProblems(task = {}) {
  const mode = String(task.mode || "");
  return mode === "ingredients-to-video" || mode === "text-to-image";
}

function debuggerShouldSubmitWithPromptEnter(task = {}) {
  void task;
  return false;
}

function debuggerNoRequestTimeoutMs(task = {}) {
  const mode = String(task.mode || "");
  if (mode === "text-to-image") return 12000;
  return 15000;
}

function debuggerRequiresFrontSubmitTransition(task = {}) {
  const mode = String(task.mode || "");
  return [
    "text-to-image",
    "text-to-video",
    "image-to-video",
    "start-end-image-to-video",
    "ingredients-to-video"
  ].includes(mode);
}

function debuggerShouldAttachRefsAfterPromptInsert(task = {}) {
  const mode = String(task.mode || "");
  return mode === "ingredients-to-video" || mode === "text-to-image";
}

async function debuggerFindControl(target, descriptor = {}) {
  const descriptorJson = JSON.stringify(descriptor || {});
  const expression = `((descriptor) => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const textOf = (node) => String(node?.innerText || node?.textContent || "").replace(/\\s+/g, " ").trim();
    const normalizeModel = (text) => String(text || "")
      .replace(/\\b(arrow_drop_down|volume_up|volume_off)\\b/gi, " ")
      .replace(/\\(leaving\\s+\\d+\\/\\d+\\)/gi, " ")
      .replace(/\\s+/g, " ")
      .trim();
    const rectOf = (node) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const hit = (node, strategy = "") => node ? { ok: true, strategy, id: node.id || "", text: textOf(node), rect: rectOf(node), ariaSelected: node.getAttribute?.("aria-selected") || "", disabled: Boolean(node.disabled || node.getAttribute?.("aria-disabled") === "true") } : null;
    const kind = String(descriptor.kind || "");
    if (kind === "settingsTrigger") {
      const editor = Array.from(document.querySelectorAll("[contenteditable='true'], textarea"))
        .filter(visible)
        .sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0] || null;
      const editorRect = editor?.getBoundingClientRect?.() || null;
      const nodes = Array.from(document.querySelectorAll("button[aria-haspopup='menu']"))
        .filter(visible)
        .map((node) => ({ node, rect: node.getBoundingClientRect(), text: textOf(node) }))
        .filter((item) => /x[1-4]|[1-4]x|crop_(16_9|9_16|square|landscape|portrait)|\\b(9:16|16:9|1:1)\\b/i.test(item.text))
        .sort((a, b) => {
          if (editorRect) {
            const distanceA = Math.abs(a.rect.y - editorRect.y);
            const distanceB = Math.abs(b.rect.y - editorRect.y);
            if (distanceA !== distanceB) return distanceA - distanceB;
          }
          return b.rect.y - a.rect.y || b.rect.x - a.rect.x;
        });
      return hit(nodes[0]?.node, "settings_trigger") || { ok: false, error: "settings_trigger_not_found" };
    }
    if (kind === "tabSuffix") {
      const suffix = String(descriptor.suffix || "");
      const node = Array.from(document.querySelectorAll("button[role='tab']")).filter(visible).find((item) => String(item.getAttribute("id") || "").endsWith(suffix));
      return hit(node, "tab_suffix") || { ok: false, error: "tab_suffix_not_found", suffix };
    }
    if (kind === "tabText") {
      const pattern = new RegExp(String(descriptor.pattern || ""), String(descriptor.flags || ""));
      const node = Array.from(document.querySelectorAll("button[role='tab']")).filter(visible).find((item) => pattern.test(textOf(item)));
      return hit(node, "tab_text") || { ok: false, error: "tab_text_not_found", pattern: String(descriptor.pattern || "") };
    }
    if (kind === "durationTab") {
      const value = String(descriptor.value || "").trim();
      const modelButton = Array.from(document.querySelectorAll("button")).filter(visible).find((item) => /Veo\s+\d/i.test(textOf(item)));
      const modelY = modelButton?.getBoundingClientRect?.().y || 0;
      const wanted = new Set([value, value ? value + "s" : ""].filter(Boolean));
      const candidates = Array.from(document.querySelectorAll("button[role='tab']"))
        .filter(visible)
        .filter((item) => wanted.has(textOf(item).replace(/\s+/g, "")))
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter((item) => !modelY || item.rect.y > modelY)
        .sort((a, b) => a.rect.y - b.rect.y);
      const fallbackCandidates = candidates.length ? candidates : Array.from(document.querySelectorAll("button[role='tab']"))
        .filter(visible)
        .filter((item) => wanted.has(textOf(item).replace(/\s+/g, "")))
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter((item) => item.rect.y > Math.max(300, window.innerHeight * 0.45))
        .sort((a, b) => b.rect.y - a.rect.y);
      return hit(fallbackCandidates[0]?.node, "duration_tab") || { ok: false, error: "duration_tab_not_found", value, modelY };
    }
    if (kind === "modelDropdown") {
      const family = String(descriptor.family || "video");
      const modelPattern = family === "image" ? /(Nano\\s+Banana|Imagen)/i : /Veo\\s+\\d/i;
      const node = Array.from(document.querySelectorAll("button[aria-haspopup='menu']")).filter(visible).find((item) => modelPattern.test(textOf(item)) && /arrow_drop_down/i.test(textOf(item)));
      return hit(node, "model_dropdown") || { ok: false, error: "model_dropdown_not_found" };
    }
    if (kind === "modelItem") {
      const pattern = new RegExp(String(descriptor.pattern || ""), String(descriptor.flags || ""));
      const family = String(descriptor.family || "video");
      const modelPattern = family === "image" ? /(Nano\\s+Banana|Imagen)/i : /Veo\\s+\\d/i;
      const candidates = Array.from(document.querySelectorAll("[role='menuitem'], button")).filter(visible).filter((item) => modelPattern.test(textOf(item)));
      const node = candidates.find((item) => pattern.test(normalizeModel(textOf(item))));
      return hit(node, "model_item") || { ok: false, error: "model_item_not_found", pattern: String(descriptor.pattern || ""), visibleVeoItems: candidates.map((item) => normalizeModel(textOf(item))).slice(0, 20) };
    }
    return { ok: false, error: "unknown_control_kind", kind };
  })(${descriptorJson})`;
  return await debuggerEvaluate(target, expression);
}

async function debuggerClickControl(target, descriptor = {}, options = {}) {
  const found = await debuggerFindControl(target, descriptor);
  if (!found?.ok || !found.rect) return { ok: false, descriptor, found };
  if (found.disabled) return { ok: false, descriptor, found, error: "control_disabled" };
  await debuggerClick(target, pointFromRect(found.rect));
  await sleep(Number(options.waitMs || 260));
  return { ok: true, descriptor, found };
}

async function debuggerClickVisibleNodeInPage(target, selectorMode = "", value = "") {
  const modeJson = JSON.stringify(String(selectorMode || ""));
  const valueJson = JSON.stringify(String(value || ""));
  return debuggerEvaluate(target, `((selectorMode, value) => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const textOf = (node) => String(node?.innerText || node?.textContent || "").replace(/\\s+/g, " ").trim();
    const rectOf = (node) => {
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    let node = null;
    if (selectorMode === "id") {
      node = document.getElementById(value);
    } else if (selectorMode === "tabSuffix") {
      node = Array.from(document.querySelectorAll("button[role='tab']")).filter(visible).find((item) => String(item.getAttribute("id") || "").endsWith(value)) || null;
    }
    if (!node || !visible(node)) return { ok: false, error: "node_not_found", selectorMode, value };
    try {
      node.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch {}
    node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window, pointerType: "mouse", isPrimary: true }));
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    node.click();
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    node.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window, pointerType: "mouse", isPrimary: true }));
    return { ok: true, id: node.id || "", text: textOf(node), rect: rectOf(node), ariaSelected: node.getAttribute("aria-selected") || "" };
  })(${modeJson}, ${valueJson})`);
}

async function debuggerWaitForSettingsMenu(target, timeoutMs = 1800) {
  const endAt = Date.now() + Math.max(300, Number(timeoutMs) || 1800);
  let lastImage = null;
  let lastVideo = null;
  while (Date.now() <= endAt) {
    lastImage = await debuggerFindControl(target, { kind: "tabSuffix", suffix: "-trigger-IMAGE" });
    if (lastImage?.ok) return { ok: true, existing: lastImage, suffix: "-trigger-IMAGE" };
    lastVideo = await debuggerFindControl(target, { kind: "tabSuffix", suffix: "-trigger-VIDEO" });
    if (lastVideo?.ok) return { ok: true, existing: lastVideo, suffix: "-trigger-VIDEO" };
    await sleep(120);
  }
  return { ok: false, error: "settings_menu_not_open", lastImage, lastVideo };
}

async function debuggerWaitForSettingsMenuClosed(target, timeoutMs = 1200) {
  const endAt = Date.now() + Math.max(250, Number(timeoutMs) || 1200);
  let last = null;
  while (Date.now() <= endAt) {
    const image = await debuggerFindControl(target, { kind: "tabSuffix", suffix: "-trigger-IMAGE" });
    const video = await debuggerFindControl(target, { kind: "tabSuffix", suffix: "-trigger-VIDEO" });
    last = { image, video };
    if (!image?.ok && !video?.ok) return { ok: true, last };
    await sleep(100);
  }
  return { ok: false, error: "settings_menu_still_open", last };
}

async function debuggerPromptEditorPoint(target) {
  return debuggerEvaluate(target, `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const editor = Array.from(document.querySelectorAll("[contenteditable='true'], textarea"))
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0] || null;
    if (!editor) return { ok: false, error: "prompt_editor_not_found" };
    const rect = editor.getBoundingClientRect();
    return {
      ok: true,
      point: {
        x: Math.max(1, Math.round(rect.x + Math.min(24, Math.max(8, rect.width * 0.08)))),
        y: Math.max(1, Math.round(rect.y + rect.height / 2))
      },
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
  })()`).catch((error) => ({ ok: false, error: String(error?.message || error) }));
}

async function debuggerCloseSettingsMenu(target, task, trace) {
  await debuggerPressKey(target, "Escape", "Escape", 27, { holdMs: 25 }).catch(() => {});
  await sleep(140);
  let closed = await debuggerWaitForSettingsMenuClosed(target, 900);
  let editor = null;
  if (!closed.ok) {
    editor = await debuggerPromptEditorPoint(target);
    if (editor?.ok) {
      await debuggerClick(target, editor.point).catch(() => {});
      await sleep(180);
      closed = await debuggerWaitForSettingsMenuClosed(target, 1200);
    }
  }
  trace(task, "settings_close", {
    ok: Boolean(closed.ok),
    error: closed.error || "",
    editorPoint: editor?.point || null,
    editorRect: editor?.rect || null
  });
  return closed;
}

async function debuggerClickSettingsTriggerInPage(target) {
  return debuggerEvaluate(target, `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const textOf = (node) => String(node?.innerText || node?.textContent || "").replace(/\\s+/g, " ").trim();
    const rectOf = (node) => {
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const candidates = Array.from(document.querySelectorAll("button[aria-haspopup='menu']"))
      .filter(visible)
      .map((node) => ({ node, rect: node.getBoundingClientRect(), text: textOf(node) }))
      .filter((item) => /x[1-4]|[1-4]x|crop_(16_9|9_16|square|landscape|portrait)|\\b(9:16|16:9|1:1)\\b/i.test(item.text))
      .filter((item) => item.rect.y > Math.max(240, window.innerHeight * 0.45))
      .sort((a, b) => b.rect.y - a.rect.y || b.rect.x - a.rect.x);
    const target = candidates[0]?.node || null;
    if (!target) return { ok: false, error: "settings_trigger_not_found_page_fallback" };
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window, pointerType: "mouse", isPrimary: true }));
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    target.click();
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window, pointerType: "mouse", isPrimary: true }));
    return { ok: true, text: textOf(target), rect: rectOf(target) };
  })()`);
}

async function debuggerWaitForSelectedTab(target, suffix = "", timeoutMs = 1400) {
  const endAt = Date.now() + Math.max(200, Number(timeoutMs) || 1400);
  let last = null;
  while (Date.now() <= endAt) {
    last = await debuggerFindControl(target, { kind: "tabSuffix", suffix });
    if (last?.ok && String(last.ariaSelected || "") === "true") {
      return { ok: true, selected: last };
    }
    await sleep(120);
  }
  return { ok: false, selected: last, error: "tab_not_selected" };
}

async function debuggerClickTabAndVerify(target, suffix = "", options = {}) {
  const existing = await debuggerFindControl(target, { kind: "tabSuffix", suffix });
  if (existing?.ok && String(existing.ariaSelected || "") === "true") {
    return {
      ok: true,
      descriptor: { kind: "tabSuffix", suffix },
      found: existing,
      skipped: true,
      verified: true,
      selected: existing,
      verifyError: ""
    };
  }
  const clicked = await debuggerClickControl(target, { kind: "tabSuffix", suffix }, options);
  if (!clicked.ok) return { ...clicked, verified: false };
  let verified = await debuggerWaitForSelectedTab(target, suffix, options.verifyMs || 1400);
  let pageFallback = null;
  if (!verified.ok) {
    pageFallback = await debuggerClickVisibleNodeInPage(target, "tabSuffix", suffix).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    if (pageFallback?.ok) {
      await sleep(Number(options.waitMs || 260));
      verified = await debuggerWaitForSelectedTab(target, suffix, options.verifyMs || 1400);
    }
  }
  return {
    ...clicked,
    verified: Boolean(verified.ok),
    selected: verified.selected || null,
    verifyError: verified.error || "",
    pageFallback
  };
}

async function debuggerWaitForSelectedNodeId(target, nodeId = "", timeoutMs = 1400) {
  const idJson = JSON.stringify(String(nodeId || ""));
  const endAt = Date.now() + Math.max(200, Number(timeoutMs) || 1400);
  let last = null;
  while (Date.now() <= endAt) {
    last = await debuggerEvaluate(target, `((id) => {
      const node = document.getElementById(id);
      if (!node) return { ok: false, error: "node_not_found", id };
      const rect = node.getBoundingClientRect();
      return {
        ok: true,
        id,
        text: String(node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim(),
        ariaSelected: node.getAttribute("aria-selected") || "",
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      };
    })(${idJson})`);
    if (last?.ok && String(last.ariaSelected || "") === "true") {
      return { ok: true, selected: last };
    }
    await sleep(120);
  }
  return { ok: false, selected: last, error: "tab_not_selected" };
}

async function debuggerClickTabTextAndVerify(target, descriptor = {}, options = {}) {
  const deadline = Date.now() + Math.max(300, Number(options.findMs || 1600) || 1600);
  let clicked = null;
  do {
    clicked = await debuggerClickControl(target, { kind: "tabText", ...descriptor }, options);
    if (clicked.ok || clicked.error === "control_disabled") break;
    await sleep(120);
  } while (Date.now() <= deadline);
  if (!clicked.ok) return { ...clicked, verified: false };
  const nodeId = String(clicked.found?.id || "");
  let verified = nodeId
    ? await debuggerWaitForSelectedNodeId(target, nodeId, options.verifyMs || 1400)
    : { ok: false, error: "clicked_tab_missing_id", selected: null };
  let pageFallback = null;
  if (!verified.ok && nodeId) {
    pageFallback = await debuggerClickVisibleNodeInPage(target, "id", nodeId).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    if (pageFallback?.ok) {
      await sleep(Number(options.waitMs || 260));
      verified = await debuggerWaitForSelectedNodeId(target, nodeId, options.verifyMs || 1400);
    }
  }
  return {
    ...clicked,
    verified: Boolean(verified.ok),
    selected: verified.selected || null,
    verifyError: verified.error || "",
    pageFallback
  };
}

async function debuggerClickDurationAndVerify(target, duration = "", options = {}) {
  const descriptor = { kind: "durationTab", value: String(duration || "") };
  const existing = await debuggerFindControl(target, descriptor);
  if (existing?.ok && String(existing.ariaSelected || "") === "true") {
    return {
      ok: true,
      descriptor,
      found: existing,
      skipped: true,
      verified: true,
      selected: existing,
      verifyError: ""
    };
  }
  const deadline = Date.now() + Math.max(1200, Number(options.findMs || 5000) || 5000);
  let clicked = null;
  do {
    clicked = await debuggerClickControl(target, descriptor, options);
    if (clicked.ok || clicked.error === "control_disabled") break;
    await sleep(180);
  } while (Date.now() <= deadline);
  if (!clicked.ok) return { ...clicked, verified: false };
  const nodeId = String(clicked.found?.id || "");
  let verified = nodeId
    ? await debuggerWaitForSelectedNodeId(target, nodeId, options.verifyMs || 1800)
    : { ok: false, error: "clicked_duration_missing_id", selected: null };
  let pageFallback = null;
  if (!verified.ok && nodeId) {
    pageFallback = await debuggerClickVisibleNodeInPage(target, "id", nodeId).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    if (pageFallback?.ok) {
      await sleep(Number(options.waitMs || 260));
      verified = await debuggerWaitForSelectedNodeId(target, nodeId, options.verifyMs || 1800);
    }
  }
  return {
    ...clicked,
    verified: Boolean(verified.ok),
    selected: verified.selected || null,
    verifyError: verified.error || "",
    pageFallback
  };
}

async function debuggerEnsureSettingsMenuOpen(target) {
  const attempts = [];
  const initial = await debuggerWaitForSettingsMenu(target, 350);
  if (initial.ok) return { ok: true, opened: false, existing: initial.existing, attempts };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const clicked = await debuggerClickControl(target, { kind: "settingsTrigger" }, { waitMs: 120 + attempt * 80 });
    attempts.push({ attempt: attempt + 1, clicked });
    if (clicked.ok) {
      const afterClick = await debuggerWaitForSettingsMenu(target, 1800 + attempt * 450);
      if (afterClick.ok) {
        return { ok: true, opened: true, clicked, existing: afterClick.existing, attempts };
      }
      attempts[attempt].afterClick = afterClick;
    }

    const fallback = await debuggerClickSettingsTriggerInPage(target).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    attempts[attempt].fallback = fallback;
    if (fallback?.ok) {
      const afterFallback = await debuggerWaitForSettingsMenu(target, 1800 + attempt * 450);
      if (afterFallback.ok) {
        return { ok: true, opened: true, clicked, fallback, existing: afterFallback.existing, attempts };
      }
      attempts[attempt].afterFallback = afterFallback;
    }
    await debuggerPressKey(target, "Escape", "Escape", 27, { holdMs: 20 }).catch(() => {});
    await sleep(180);
  }
  return { ok: false, error: "settings_menu_not_open", attempts };
}

async function applyModeAndSettings({ target, task, trace }) {
  const isImageMode = String(task.mode || "") === "text-to-image";
  const steps = [];
  trace(task, "settings_start");
  const menu = await debuggerEnsureSettingsMenuOpen(target);
  steps.push({ step: "open_settings", ...menu });
  trace(task, "settings_open", { ok: Boolean(menu.ok), error: menu.error || "", clickedText: menu.clicked?.found?.text || "", clickedRect: menu.clicked?.found?.rect || null });
  if (!menu.ok) return { ok: false, error: menu.error || "settings_menu_not_open", steps };

  const visibleMode = debuggerVisibleModeForTask(task);
  const suffixMap = {
    VIDEO: "-trigger-VIDEO",
    VIDEO_FRAMES: "-trigger-VIDEO_FRAMES",
    VIDEO_REFERENCES: "-trigger-VIDEO_REFERENCES",
    IMAGE: "-trigger-IMAGE"
  };
  const topMode = visibleMode === "IMAGE" ? "IMAGE" : "VIDEO";
  const topClicked = await debuggerClickTabAndVerify(target, suffixMap[topMode], { waitMs: 420, verifyMs: 1600 });
  steps.push({ step: "top_mode", target: topMode, ...topClicked });
  trace(task, "settings_top_mode", { target: topMode, ok: Boolean(topClicked.ok), verified: Boolean(topClicked.verified), error: topClicked.error || topClicked.verifyError || topClicked.found?.error || "", text: topClicked.found?.text || "", selectedText: topClicked.selected?.text || "", rect: topClicked.found?.rect || null });
  if (!topClicked.ok || !topClicked.verified) return { ok: false, error: topClicked.ok ? "mode_tab_not_selected" : "mode_tab_not_clicked", steps };
  if (visibleMode === "VIDEO_FRAMES" || visibleMode === "VIDEO_REFERENCES") {
    const subClicked = await debuggerClickTabAndVerify(target, suffixMap[visibleMode], { waitMs: 420, verifyMs: 1600 });
    steps.push({ step: "sub_mode", target: visibleMode, ...subClicked });
    trace(task, "settings_sub_mode", { target: visibleMode, ok: Boolean(subClicked.ok), verified: Boolean(subClicked.verified), error: subClicked.error || subClicked.verifyError || subClicked.found?.error || "", text: subClicked.found?.text || "", selectedText: subClicked.selected?.text || "", rect: subClicked.found?.rect || null });
    if (!subClicked.ok || !subClicked.verified) return { ok: false, error: subClicked.ok ? "sub_mode_tab_not_selected" : "sub_mode_tab_not_clicked", steps };
  }

  const aspect = debuggerAspectForTask(task);
  const aspectClicked = await debuggerClickTabAndVerify(target, `-trigger-${aspect}`, { waitMs: 300, verifyMs: 1200 });
  steps.push({ step: "aspect", target: aspect, ...aspectClicked });
  trace(task, "settings_aspect", { target: aspect, ok: Boolean(aspectClicked.ok), verified: Boolean(aspectClicked.verified), error: aspectClicked.error || aspectClicked.verifyError || aspectClicked.found?.error || "", text: aspectClicked.found?.text || "", selectedText: aspectClicked.selected?.text || "", rect: aspectClicked.found?.rect || null });
  if (!aspectClicked.ok || !aspectClicked.verified) return { ok: false, error: aspectClicked.ok ? "aspect_not_selected" : "aspect_not_clicked", steps };

  const repeat = Math.max(1, Math.min(4, Number.parseInt(task.repeatCount, 10) || 1));
  const repeatClicked = await debuggerClickTabAndVerify(target, `-trigger-${repeat}`, { waitMs: 300, verifyMs: 1200 });
  steps.push({ step: "repeat", target: repeat, ...repeatClicked });
  trace(task, "settings_repeat", { target: repeat, ok: Boolean(repeatClicked.ok), verified: Boolean(repeatClicked.verified), error: repeatClicked.error || repeatClicked.verifyError || repeatClicked.found?.error || "", text: repeatClicked.found?.text || "", selectedText: repeatClicked.selected?.text || "", rect: repeatClicked.found?.rect || null });
  if (!repeatClicked.ok || !repeatClicked.verified) return { ok: false, error: repeatClicked.ok ? "repeat_not_selected" : "repeat_not_clicked", steps };

  let duration = "";
  if (!isImageMode) {
    duration = debuggerDurationForTask(task);
    const durationClicked = await debuggerClickDurationAndVerify(target, duration, { waitMs: 360, verifyMs: 1800, findMs: 5000 });
    steps.push({ step: "duration", target: duration, ...durationClicked });
    trace(task, "settings_duration", { target: duration, ok: Boolean(durationClicked.ok), verified: Boolean(durationClicked.verified), error: durationClicked.error || durationClicked.verifyError || durationClicked.found?.error || "", text: durationClicked.found?.text || "", selectedText: durationClicked.selected?.text || "", rect: durationClicked.found?.rect || null });
    if (!durationClicked.ok || !durationClicked.verified) {
      if (durationClicked.found?.error === "duration_tab_not_found") {
        steps.push({ step: "duration_unavailable_assumed", target: duration, reason: "duration_tab_missing_visible_option" });
        trace(task, "settings_duration_unavailable_assumed", { target: duration, reason: "duration_tab_missing_visible_option" });
      } else {
        return { ok: false, error: durationClicked.ok ? "duration_not_selected" : "duration_not_clicked", steps };
      }
    }
  }

  const modelPattern = debuggerModelPatternForTask(task);
  const modelFamily = isImageMode ? "image" : "video";
  const currentModel = await debuggerFindControl(target, { kind: "modelDropdown", family: modelFamily });
  steps.push({ step: "model_current", currentModel });
  trace(task, "settings_model_current", { ok: Boolean(currentModel?.ok), error: currentModel?.error || "", text: currentModel?.text || "", rect: currentModel?.rect || null });
  const normalizedCurrent = String(currentModel?.text || "").replace(/\b(arrow_drop_down|volume_up|volume_off)\b/gi, " ").replace(/\(leaving\s+\d+\/\d+\)/gi, " ").replace(/\s+/g, " ").trim();
  if (!new RegExp(modelPattern.source, modelPattern.flags).test(normalizedCurrent)) {
    const modelMenu = await debuggerClickControl(target, { kind: "modelDropdown", family: modelFamily }, { waitMs: 360 });
    steps.push({ step: "model_open", ...modelMenu });
    trace(task, "settings_model_open", { ok: Boolean(modelMenu.ok), error: modelMenu.error || modelMenu.found?.error || "", text: modelMenu.found?.text || "", rect: modelMenu.found?.rect || null });
    if (!modelMenu.ok) return { ok: false, error: "model_dropdown_not_clicked", steps };
    let modelItem = null;
    const modelItemDeadline = Date.now() + 3500;
    do {
      modelItem = await debuggerClickControl(target, { kind: "modelItem", family: modelFamily, pattern: modelPattern.source, flags: modelPattern.flags }, { waitMs: 520 });
      if (modelItem?.ok) break;
      await sleep(180);
    } while (Date.now() < modelItemDeadline);
    steps.push({ step: "model_select", requested: task.model || "default", ...modelItem });
    trace(task, "settings_model_select", { requested: task.model || "default", ok: Boolean(modelItem.ok), error: modelItem.error || modelItem.found?.error || "", text: modelItem.found?.text || "", rect: modelItem.found?.rect || null, visibleVeoItems: modelItem.found?.visibleVeoItems || [] });
    if (!modelItem.ok) {
      const fallbackOk = debuggerAcceptsCurrentVideoModelFallback(task, normalizedCurrent);
      steps.push({ step: "model_current_fallback", ok: fallbackOk, current: normalizedCurrent });
      trace(task, "settings_model_current_fallback", {
        ok: fallbackOk,
        requested: task.model || "default",
        current: normalizedCurrent,
        reason: fallbackOk ? "compatible_fast_model_already_selected" : "model_item_not_clicked"
      });
      if (!fallbackOk) return { ok: false, error: "model_item_not_clicked", steps };
    }
  }
  const close = await debuggerCloseSettingsMenu(target, task, trace);
  steps.push({ step: "close_settings", ...close });
  trace(task, "settings_done", { aspect, repeat, duration, model: task.model || "default" });
  return { ok: true, steps, aspect, repeat, duration, model: task.model || "default" };
}

async function debuggerHitTest(target, point = {}) {
  const expression = `((point) => {
    const textOf = (node) => String(node?.innerText || node?.textContent || node?.value || "").replace(/\\s+/g, " ").trim();
    const pageText = textOf(document.body);
    const detailEditorOpen = /What do you want to change\\?|Show history|\\bDone\\b/i.test(pageText);
    const visibleEditors = Array.from(document.querySelectorAll("textarea,[contenteditable='true'],[role='textbox']"))
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
      })
      .map((element) => textOf(element));
    const node = document.elementFromPoint(Number(point.x || 0), Number(point.y || 0));
    const button = node?.closest?.("button, [role='button']") || node;
    const rect = button?.getBoundingClientRect?.();
    return {
      ok: Boolean(button),
      tag: String(button?.tagName || "").toLowerCase(),
      role: button?.getAttribute?.("role") || "",
      ariaLabel: button?.getAttribute?.("aria-label") || "",
      text: textOf(button),
      detailEditorOpen,
      editorText: visibleEditors[0] || "",
      disabled: Boolean(button?.disabled || button?.getAttribute?.("aria-disabled") === "true"),
      rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null
    };
  })(${JSON.stringify(point)})`;
  return debuggerEvaluate(target, expression).catch((error) => ({ ok: false, error: String(error?.message || error) }));
}

async function debuggerCreateButtonPoint(target) {
  const expression = `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const textOf = (node) => String(node?.innerText || node?.textContent || node?.value || "").replace(/\\s+/g, " ").trim();
    const pageText = textOf(document.body);
    const detailEditorOpen = /What do you want to change\\?|Show history|\\bDone\\b/i.test(pageText);
    if (detailEditorOpen) return { ok: false, error: "IMAGE_DETAIL_EDITOR_OPEN", detailEditorOpen: true };
    const iconToken = (node) => textOf(node).split(/\\s+/)[0] || "";
    const rectOf = (node) => {
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const pointFrom = (rect) => ({
      x: Math.max(1, Math.round(Number(rect.x || 0) + Number(rect.width || 0) / 2)),
      y: Math.max(1, Math.round(Number(rect.y || 0) + Number(rect.height || 0) / 2))
    });
    const isCreate = (node) => {
      if (!visible(node)) return false;
      if (node.disabled || node.getAttribute?.("aria-disabled") === "true") return false;
      return iconToken(node) === "arrow_forward";
    };
    const editor = Array.from(document.querySelectorAll("textarea,[contenteditable='true'],[role='textbox']"))
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0] || null;
    let scope = editor;
    for (let depth = 0; scope && depth < 8; depth += 1, scope = scope.parentElement) {
      const scoped = Array.from(scope.querySelectorAll("button,[role='button']")).filter(isCreate);
      if (scoped.length === 1) {
        const rect = rectOf(scoped[0]);
        return { ok: true, strategy: "live_scoped_arrow_forward", rect, point: pointFrom(rect), text: textOf(scoped[0]) };
      }
    }
    const editorRect = editor?.getBoundingClientRect?.() || null;
    const candidates = Array.from(document.querySelectorAll("button,[role='button']"))
      .filter(isCreate)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        let score = 0;
        if (editorRect) {
          const dx = Math.abs((rect.left + rect.right) / 2 - editorRect.right);
          const dy = Math.abs((rect.top + rect.bottom) / 2 - editorRect.bottom);
          score -= dx * 0.2 + dy * 0.5;
          if (rect.top >= editorRect.top - 20 && rect.top <= editorRect.bottom + 80) score += 120;
        }
        if (rect.top > window.innerHeight * 0.45) score += 50;
        return { node, score };
      })
      .sort((a, b) => b.score - a.score);
    if (candidates[0]?.node) {
      const rect = rectOf(candidates[0].node);
      return { ok: true, strategy: "live_arrow_forward_near_editor", rect, point: pointFrom(rect), text: textOf(candidates[0].node), score: candidates[0].score };
    }
    return { ok: false, error: "LIVE_CREATE_ARROW_NOT_FOUND" };
  })()`;
  return debuggerEvaluate(target, expression).catch((error) => ({ ok: false, error: String(error?.message || error) }));
}

async function debuggerCloseImageDetailIfOpen(target) {
  const expression = `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const textOf = (node) => String(node?.innerText || node?.textContent || node?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim();
    const pageText = textOf(document.body);
    const detailOpen = /What do you want to change\\?|Show history|\\bDone\\b/i.test(pageText);
    if (!detailOpen) return { ok: true, closed: false, reason: "normal_view" };
    const buttons = Array.from(document.querySelectorAll("button,[role='button']")).filter(visible);
    const done = buttons.find((button) => /\\bDone\\b/i.test(textOf(button)) || /\\bDone\\b/i.test(String(button.getAttribute("aria-label") || "")));
    if (done) {
      done.click();
      return { ok: true, closed: true, method: "done_button" };
    }
    const back = buttons.find((button) => /arrow_back|Go Back/i.test(textOf(button)) || /go back|back/i.test(String(button.getAttribute("aria-label") || "")));
    if (back) {
      back.click();
      return { ok: true, closed: true, method: "back_button" };
    }
    return { ok: false, closed: false, error: "IMAGE_DETAIL_EDITOR_CLOSE_NOT_FOUND", sample: pageText.slice(0, 240) };
  })()`;
  return debuggerEvaluate(target, expression).catch((error) => ({ ok: false, closed: false, error: String(error?.message || error) }));
}

async function debuggerStableCreateButtonPoint(target, timeoutMs = 1600, options = {}) {
  const deadline = Date.now() + Math.max(400, Number(timeoutMs || 1600));
  const startedAt = Date.now();
  const minWaitMs = Math.max(0, Number(options.minWaitMs || 0) || 0);
  let last = null;
  let stableCount = 0;
  while (Date.now() <= deadline) {
    const candidate = await debuggerCreateButtonPoint(target);
    const point = candidate?.ok && candidate.point ? candidate.point : null;
    const hit = point ? await debuggerHitTest(target, point) : { ok: false, error: candidate?.error || "LIVE_CREATE_ARROW_NOT_FOUND" };
    const current = { ...(candidate || {}), point, hit };
    const samePoint = Boolean(
      last?.point &&
      point &&
      Math.abs(Number(last.point.x || 0) - Number(point.x || 0)) <= 2 &&
      Math.abs(Number(last.point.y || 0) - Number(point.y || 0)) <= 2
    );
    if (candidate?.ok && point && hitLooksLikeCreateButton(hit)) {
      stableCount = samePoint ? stableCount + 1 : 1;
      if (stableCount >= 2 && Date.now() - startedAt >= minWaitMs) {
        return { ...current, ok: true, stable: true, stableCount };
      }
    } else {
      stableCount = 0;
    }
    last = current;
    await sleep(180);
  }
  return last || { ok: false, stable: false, error: "LIVE_CREATE_ARROW_NOT_STABLE" };
}

function hitLooksLikeCreateButton(hit = {}) {
  const text = `${hit.text || ""} ${hit.ariaLabel || ""}`.toLowerCase();
  if (hit.detailEditorOpen) return false;
  if (hit.disabled) return false;
  if (text.includes("delete") || text.includes("remove") || text.includes("trash")) return false;
  return /arrow_forward|create|submit|generate|send/.test(text);
}

function debuggerResultLooksDetached(result = {}) {
  const text = [
    result?.error,
    result?.hit?.error,
    result?.liveCreate?.error,
    result?.liveCreate?.hit?.error
  ].map((value) => String(value || "")).join(" ");
  return /Debugger is not attached|not attached to the tab/i.test(text);
}

function frontSnapshotStillSubmittable(snapshot = {}) {
  if (!snapshot?.promptStillVisible) return false;
  const createButtons = Array.isArray(snapshot.createButtons) ? snapshot.createButtons : [];
  if (!createButtons.length) return true;
  return createButtons.some((button) => !button.disabled && button.pointerEvents !== "none");
}

async function debuggerFrontSubmitSnapshot(target, task = {}, options = {}) {
  const prompt = String(task.prompt || "").replace(/\s+/g, " ").trim();
  const promptJson = JSON.stringify(prompt);
  const mediaIdsJson = JSON.stringify(Array.isArray(options.mediaIds) ? options.mediaIds : []);
  return debuggerEvaluate(target, `((expectedPrompt, expectedMediaIds) => {
	    const visible = (element) => {
	      if (!element) return false;
	      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
	    const compact = (value) => String(value || "").replace(/\\s+/g, " ").trim();
	    const textOf = (node) => compact(node?.innerText || node?.textContent || node?.value || "");
	    const promptNeedle = compact(expectedPrompt).slice(0, 120);
	    const variantsForId = (value) => {
	      const raw = compact(value);
	      if (!raw) return [];
	      const withoutPrefix = raw.replace(/^fe_id_/i, "");
	      const withPrefix = /^fe_id_/i.test(raw) ? raw : "fe_id_" + raw;
	      return [...new Set([raw, withoutPrefix, withPrefix].filter(Boolean))];
	    };
	    const mediaNeedles = Array.isArray(expectedMediaIds)
	      ? expectedMediaIds.flatMap(variantsForId).filter(Boolean)
	      : [];
	    const editors = Array.from(document.querySelectorAll("textarea,[contenteditable='true'],[role='textbox']"))
	      .filter(visible)
	      .map((node) => textOf(node))
      .filter(Boolean);
    const createButtons = Array.from(document.querySelectorAll("button,[role='button']"))
      .filter(visible)
      .filter((node) => /arrow_forward/i.test(textOf(node)))
      .map((node) => ({
        text: textOf(node),
        disabled: Boolean(node.disabled || node.getAttribute("aria-disabled") === "true"),
        pointerEvents: String(getComputedStyle(node).pointerEvents || "")
      }));
	    const promptStillVisible = Boolean(promptNeedle && editors.some((text) => compact(text).includes(promptNeedle)));
	    const createDisabled = createButtons.some((button) => button.disabled || button.pointerEvents === "none");
	    const projectCards = Array.from(document.querySelectorAll("[data-tile-id]"))
	      .filter(visible)
	      .map((node) => {
	        const img = node.querySelector?.("img") || null;
	        const text = textOf(node);
	        const tileId = String(node.getAttribute?.("data-tile-id") || "");
	        const mediaText = [
	          tileId,
	          text,
	          img?.currentSrc || "",
	          img?.src || "",
	          node.getAttribute?.("href") || "",
	          node.querySelector?.("a[href]")?.getAttribute?.("href") || ""
	        ].map(compact).join(" ");
	        const rect = node.getBoundingClientRect();
	        return {
	          tileId,
	          text: text.slice(0, 160),
	          mediaText,
	          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
	        };
	      });
	    const matchingPromptCards = projectCards.filter((card) => promptNeedle && compact(card.text).includes(promptNeedle));
	    const matchingMediaCards = projectCards.filter((card) => mediaNeedles.some((needle) => needle && card.mediaText.includes(needle)));
	    const progressCards = projectCards.filter((card) => /\\b([1-9]\\d?|100)%\\b|progress_activity|generating|loading/i.test(card.text));
	    const progressVisible = progressCards.length > 0 || Array.from(document.querySelectorAll("body *"))
	      .some((node) => visible(node) && /\\b([1-9]\\d?|100)%\\b|progress_activity/i.test(String(node.textContent || "")));
	    return {
	      promptStillVisible,
	      createDisabled,
	      progressVisible,
	      matchingPromptCardCount: matchingPromptCards.length,
	      matchingMediaCardCount: matchingMediaCards.length,
	      progressCardCount: progressCards.length,
	      matchingProjectCards: [...matchingMediaCards, ...matchingPromptCards].slice(0, 4).map((card) => ({
	        tileId: card.tileId,
	        text: card.text,
	        rect: card.rect
	      })),
	      editors: editors.slice(-4),
	      createButtons: createButtons.slice(-4)
	    };
	  })(${promptJson}, ${mediaIdsJson})`).catch((error) => ({ ok: false, error: String(error?.message || error) }));
}

async function waitForFrontSubmitTransition(target, task = {}, timeoutMs = 7000, options = {}) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 7000));
  let last = null;
  while (Date.now() < deadline) {
    last = await debuggerFrontSubmitSnapshot(target, task, options);
    if (last && last.promptStillVisible === false) {
      return { ok: true, reason: "prompt_cleared_or_replaced", snapshot: last };
    }
    if (last?.matchingMediaCardCount > 0 || last?.matchingPromptCardCount > 0) {
      return {
        ok: true,
        reason: last.matchingMediaCardCount > 0 ? "project_media_card_visible_after_submit" : "project_prompt_card_visible_after_submit",
        snapshot: last
      };
    }
    if (last?.createDisabled || last?.progressVisible) {
      return { ok: true, reason: last.createDisabled ? "create_disabled_after_submit" : "progress_visible_after_submit", snapshot: last };
    }
    await sleep(260);
  }
  return { ok: false, reason: "prompt_still_visible_after_submit", snapshot: last };
}

function frontSubmitTransitionHasStrongProof(frontTransition = {}) {
  if (!frontTransition?.ok) return false;
  const reason = String(frontTransition.reason || "");
  if (/project_(media|prompt)_card_visible_after_submit|create_disabled_after_submit|progress_visible_after_submit|dom_response_confirmed_without_front_transition/i.test(reason)) {
    return true;
  }
  const snapshot = frontTransition.snapshot || {};
  return Number(snapshot.matchingMediaCardCount || 0) > 0
    || Number(snapshot.matchingPromptCardCount || 0) > 0
    || Number(snapshot.progressCardCount || 0) > 0
    || Boolean(snapshot.progressVisible)
    || Boolean(snapshot.createDisabled);
}

async function waitForDebuggerGenerationResponse(target, { projectId = "", expectedCount = 1, timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + Number(timeoutMs || 90000);
  const requiredCount = Math.max(1, Number(expectedCount || 1) || 1);
  const partialQuietMs = requiredCount > 1 ? 5000 : 2500;
  const partialMinWaitMs = requiredCount > 1 ? 12000 : 4500;
  const requestIds = new Set();
  const responseBodies = [];
  const aggregateMediaIds = new Set();
  const aggregateOutputRows = new Map();
  let firstMediaAt = 0;
  let lastMediaAt = 0;
  const isGenerationUrl = (url = "") => /video:batchAsyncGenerateVideoText|video:batchAsyncGenerateVideoStartImage|video:batchAsyncGenerateVideoStartAndEndImage|video:batchAsyncGenerateVideoReferenceImages|image:batchAsyncGenerateImage|image:asyncGenerateImage|flowMedia:batchGenerateImages/i.test(String(url || ""));
  let done;
  const promise = new Promise((resolve) => {
    done = resolve;
  });
  const listener = async (source, method, params = {}) => {
    if (source.tabId !== target.tabId) return;
    if (method === "Network.requestWillBeSent" && isGenerationUrl(params.request?.url || "")) {
      requestIds.add(params.requestId);
    }
    if (method === "Network.responseReceived" && requestIds.has(params.requestId)) {
      try {
        const body = await debuggerSend(target, "Network.getResponseBody", { requestId: params.requestId });
        const text = body?.body || "";
        const data = JSON.parse(String(text || "").replace(/^\)\]\}',?\s*/, "").trim() || "null");
        const mediaIds = extractMediaIds(data, { projectId });
        const outputRows = extractSubmitOutputRows(data, { projectId });
        for (const row of outputRows) {
          if (!row.mediaId || aggregateOutputRows.has(row.mediaId)) continue;
          aggregateOutputRows.set(row.mediaId, row);
        }
        for (const id of mediaIds) {
          const cleaned = String(id || "").trim();
          if (!cleaned || aggregateMediaIds.has(cleaned)) continue;
          aggregateMediaIds.add(cleaned);
          firstMediaAt = firstMediaAt || Date.now();
          lastMediaAt = Date.now();
        }
        responseBodies.push({ status: params.response?.status || 0, url: params.response?.url || "", mediaIds, outputRows, data });
        if (aggregateMediaIds.size >= requiredCount) {
          const aggregatedOutputRows = [...aggregateOutputRows.values()].map((row, mediaIndex) => ({ ...row, mediaIndex }));
          done({
            ...responseBodies[responseBodies.length - 1],
            mediaIds: [...aggregateMediaIds].filter(Boolean),
            outputRows: aggregatedOutputRows,
            responseCount: responseBodies.length
          });
        }
      } catch (error) {
        responseBodies.push({ status: params.response?.status || 0, url: params.response?.url || "", mediaIds: [], error: String(error?.message || error) });
      }
    }
  };
  chrome.debugger.onEvent.addListener(listener);
  try {
    while (Date.now() < deadline) {
      if (aggregateMediaIds.size >= requiredCount) {
        const last = responseBodies[responseBodies.length - 1] || {};
        const aggregatedOutputRows = [...aggregateOutputRows.values()].map((row, mediaIndex) => ({ ...row, mediaIndex }));
        return {
          ...last,
          mediaIds: [...aggregateMediaIds].filter(Boolean),
          outputRows: aggregatedOutputRows,
          responseCount: responseBodies.length
        };
      }
      if (aggregateMediaIds.size > 0 && firstMediaAt && Date.now() - lastMediaAt >= partialQuietMs && Date.now() - firstMediaAt >= partialMinWaitMs) {
        const last = responseBodies[responseBodies.length - 1] || {};
        const aggregatedOutputRows = [...aggregateOutputRows.values()].map((row, mediaIndex) => ({ ...row, mediaIndex }));
        return {
          ...last,
          mediaIds: [...aggregateMediaIds].filter(Boolean),
          outputRows: aggregatedOutputRows,
          responseCount: responseBodies.length,
          incomplete: aggregateMediaIds.size < requiredCount,
          expectedCount: requiredCount,
          error: aggregateMediaIds.size < requiredCount ? `DOM_DEBUGGER_INCOMPLETE_MEDIA_IDS:${aggregateMediaIds.size}/${requiredCount}` : ""
        };
      }
      const complete = responseBodies.find((row) => Number(row.mediaIds?.length || 0) >= requiredCount);
      if (complete) return complete;
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        promise,
        sleep(Math.min(500, Math.max(50, remaining))).then(() => null)
      ]);
      if (result && Number(result.mediaIds?.length || 0) >= requiredCount) return result;
    }
    const aggregate = [...aggregateMediaIds].filter(Boolean);
    if (aggregate.length) {
      const best = responseBodies
        .filter((row) => row.mediaIds?.length)
        .sort((a, b) => Number(b.mediaIds?.length || 0) - Number(a.mediaIds?.length || 0))[0] || {};
      const aggregatedOutputRows = [...aggregateOutputRows.values()].map((row, mediaIndex) => ({ ...row, mediaIndex }));
      return {
        ...best,
        mediaIds: aggregate,
        outputRows: aggregatedOutputRows,
        responseCount: responseBodies.length,
        incomplete: true,
        expectedCount: requiredCount,
        error: `DOM_DEBUGGER_INCOMPLETE_MEDIA_IDS:${aggregate.length}/${requiredCount}`
      };
    }
    return { status: 0, mediaIds: [], expectedCount: requiredCount, error: "DOM_DEBUGGER_REQUEST_NOT_OBSERVED" };
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
  }
}

export function createDebuggerEngine({ sendPageCommand, trace, responseTimeoutMs = 12000 } = {}) {
  if (typeof sendPageCommand !== "function") throw new Error("createDebuggerEngine requires sendPageCommand");
  installFileChooserListener();
  const recordTrace = typeof trace === "function" ? trace : () => {};

  return {
    async submitTask(tabId, task = {}, meta = {}) {
      if (!chrome.debugger?.attach) {
        return { ok: false, status: 0, statusText: "DOM_DEBUGGER_PERMISSION_UNAVAILABLE", error: "DOM_DEBUGGER_PERMISSION_UNAVAILABLE" };
      }
      let target = debuggerTarget(tabId);
      try {
        const attachment = await ensureDebuggerAttached(tabId, recordTrace, task);
        target = attachment.target;
        await ensureNetworkEnabled(tabId, target);
        markDebuggerBusy(tabId, true, recordTrace, task, "submit_task");

        const prep = await sendPageCommand({
          action: "domPrepareTaskForDebugger",
          task,
          meta: { ...meta, debuggerTransport: true, skipDomModeAndSettingsMutation: true },
          timeoutMs: 120000
        }, tabId);
        const prepared = prep?.result?.result || prep?.result || prep;
        prepared.taskId = task?.id || "";
        prepared.mode = task?.mode || "";
        recordTrace(task, "prep_result", {
          ok: Boolean(prepared?.ok),
          error: prepared?.error || "",
          editorRect: prepared?.editorRect || null,
          createRect: prepared?.createRect || null,
          selector: prepared?.selector || "",
          strategy: prepared?.strategy || ""
        });
        if (!prepared?.ok) {
          const error = prepared?.error || "DOM_DEBUGGER_PREP_FAILED";
          return {
            ok: false,
            status: Number(prepared?.status || 0),
            statusText: /^DOM_DEBUGGER_/i.test(error) || /^COMPOSER_/i.test(error) ? error : `DOM_DEBUGGER_PREP_FAILED:${error}`,
            error: /^DOM_DEBUGGER_/i.test(error) || /^COMPOSER_/i.test(error) ? error : `DOM_DEBUGGER_PREP_FAILED:${error}`,
            data: { ...(prepared || {}), transport: "chrome_debugger" }
          };
        }

        // The requested Flow output count is the run setting. Existing
        // expectedVideos/expectedImages can be stale from retries or repaired
        // tasks, so never let them override the user's selected repeat count.
        const expectedCount = Math.max(1, Number(task.repeatCount || task.expectedVideos || task.expectedImages || 1) || 1);
        const acceptTextToImageFrontSubmit = async ({
          status = 0,
          response = null,
          pageResponse = null,
          frontTransition = null,
          pageCaptureObservedRequest = false,
          traceLabel = "front_submit_transition_accepted_without_media_ids"
        } = {}) => {
          const observedStatus = Number(status || response?.status || pageResponse?.status || 0);
          recordTrace(task, traceLabel, {
            status: observedStatus,
            error: response?.error || pageResponse?.error || "",
            endpoint: response?.endpoint || pageResponse?.endpoint || "",
            endpointKind: response?.endpointKind || pageResponse?.endpointKind || "",
            serializedRefs: response?.serializedRefs || pageResponse?.serializedRefs || null,
            pageCaptureObservedRequest,
            frontTransitionReason: frontTransition?.reason || ""
          });
          const detailCloseAfterSubmit = await debuggerCloseImageDetailIfOpen(target);
          recordTrace(task, "detail_editor_close_after_front_submit", {
            ok: Boolean(detailCloseAfterSubmit?.ok),
            closed: Boolean(detailCloseAfterSubmit?.closed),
            method: detailCloseAfterSubmit?.method || "",
            reason: detailCloseAfterSubmit?.reason || "",
            error: detailCloseAfterSubmit?.error || ""
          });
          if (detailCloseAfterSubmit?.closed) await sleep(1200);
          const clearedPrompt = await sendPageCommand({
            action: "domClearPromptAfterDebuggerSubmit",
            task,
            meta: { reason: "debugger_front_submit_observed" },
            timeoutMs: 10000
          }, tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "DOM_PROMPT_CLEAR_FAILED") }));
          const clearResult = clearedPrompt?.result?.result || clearedPrompt?.result || clearedPrompt;
          recordTrace(task, "prompt_clear_after_front_submit_observed", {
            ok: Boolean(clearResult?.ok),
            error: clearResult?.error || "",
            before: clearResult?.before || "",
            after: clearResult?.after || "",
            storeAfter: clearResult?.storeAfter || "",
            method: clearResult?.method || ""
          });
          return {
            ok: true,
            status: observedStatus || 202,
            statusText: "DOM_DEBUGGER_FRONT_SUBMIT_OBSERVED",
            mediaIds: [],
            outputRows: [],
            data: {
              ...prepared,
              response,
              pageResponse,
              frontTransition,
              expectedCount,
              frontSubmitObserved: true,
              refSerializationUnverified: Boolean(!response && !pageResponse) || Boolean(response?.error || pageResponse?.error),
              transport: "chrome_debugger"
            }
          };
        };
        recordTrace(task, "settings_gate", {
          debuggerSettingsEnabled: true,
          requestedRepeat: expectedCount,
          reason: "video_dom_settings_required_per_task"
        });
        const settings = await applyModeAndSettings({ target, task, trace: recordTrace });
        recordTrace(task, "settings_result", {
          ok: Boolean(settings.ok),
          skipped: Boolean(settings.skipped),
          reason: settings.reason || "",
          error: settings.error || "",
          aspect: settings.aspect || "",
          repeat: settings.repeat || "",
          duration: settings.duration || "",
          model: settings.model || "",
          requestedRepeat: expectedCount
        });
        if (!settings.ok) {
          const error = settings.error || "settings_failed";
          return {
            ok: false,
            status: 0,
            statusText: `DOM_DEBUGGER_SETTINGS_FAILED:${error}`,
            error: `DOM_DEBUGGER_SETTINGS_FAILED:${error}`,
            data: { prepared, settings, transport: "chrome_debugger" }
          };
        }

        const attachRefsAfterPromptInsert = debuggerShouldAttachRefsAfterPromptInsert(task);
        const refreshedPrep = await sendPageCommand({
          action: "domPrepareTaskForDebugger",
          task,
          meta: {
            ...meta,
            debuggerTransport: true,
            skipDomModeAndSettingsMutation: true,
            afterDebuggerSettings: true,
            skipDebuggerAttach: attachRefsAfterPromptInsert
          },
          timeoutMs: 120000
        }, tabId);
        const refreshedPrepared = refreshedPrep?.result?.result || refreshedPrep?.result || refreshedPrep;
        if (refreshedPrepared?.ok) {
          prepared.editorRect = refreshedPrepared.editorRect || prepared.editorRect;
          prepared.createRect = refreshedPrepared.createRect || prepared.createRect;
          prepared.selector = refreshedPrepared.selector || prepared.selector;
          prepared.strategy = refreshedPrepared.strategy || prepared.strategy;
        }
        recordTrace(task, "prep_refreshed", {
          ok: Boolean(refreshedPrepared?.ok),
          error: refreshedPrepared?.error || "",
          editorRect: prepared.editorRect || null,
          createRect: prepared.createRect || null,
          selector: prepared.selector || "",
          strategy: prepared.strategy || ""
        });

        const settingsProblems = debuggerPreparedSettingsProblems(refreshedPrepared?.ok ? refreshedPrepared : prepared, task);
        if (settingsProblems.length) {
          if (debuggerShouldAvoidHiddenSettingsStoreRepair(task) || debuggerShouldFailClosedOnSettingsProblems(task)) {
            const failClosed = debuggerShouldFailClosedOnSettingsProblems(task);
            recordTrace(task, failClosed ? "settings_state_repair_blocked_for_visible_mode" : "settings_state_repair_skipped_for_frame_mode", {
              problems: settingsProblems,
              reason: failClosed ? "manual_visible_ref_submit_only" : "manual_visible_frame_submit_only",
              selectedVideoDuration: prepared.store?.selectedVideoDuration ?? null,
              videoApi: prepared.store?.currentModelKeys?.videoApi || "",
              videoModelKey: prepared.store?.currentModelKeys?.videoModelKey || ""
            });
            if (failClosed) {
              const error = `DOM_DEBUGGER_SETTINGS_STATE_INVALID:${settingsProblems.join(",")}`;
              return {
                ok: false,
                status: 0,
                statusText: error,
                error,
                data: { prepared, settingsProblems, transport: "chrome_debugger" }
              };
            }
          } else {
          recordTrace(task, "settings_state_repair_start", {
            problems: settingsProblems,
            reason: "post_attach_store_validation"
          });
          const syncPrep = await sendPageCommand({
            action: "domSyncTaskSettingsForDebugger",
            task,
            meta: { ...meta, debuggerTransport: true, reason: "post_attach_store_validation" },
            timeoutMs: 120000
          }, tabId);
          const synced = syncPrep?.result?.result || syncPrep?.result || syncPrep;
          recordTrace(task, "settings_state_repair_result", {
            ok: Boolean(synced?.ok),
            error: synced?.error || "",
            reason: synced?.reason || "",
            before: synced?.before || null,
            validation: synced?.validation || null,
            storeSync: synced?.storeSync || null
          });
          if (!synced?.ok) {
            const error = synced?.error || "DOM_DEBUGGER_SETTINGS_STATE_INVALID";
            return {
              ok: false,
              status: 0,
              statusText: error,
              error,
              data: { prepared, synced, transport: "chrome_debugger" }
            };
          }
          const afterSyncPrep = await sendPageCommand({
            action: "domPrepareTaskForDebugger",
            task,
            meta: {
              ...meta,
              debuggerTransport: true,
              skipDomModeAndSettingsMutation: true,
              afterDebuggerSettings: true,
              skipDebuggerAttach: true,
              afterSettingsStateRepair: true
            },
            timeoutMs: 120000
          }, tabId);
          const afterSyncPrepared = afterSyncPrep?.result?.result || afterSyncPrep?.result || afterSyncPrep;
          if (afterSyncPrepared?.ok) {
            prepared.editorRect = afterSyncPrepared.editorRect || prepared.editorRect;
            prepared.createRect = afterSyncPrepared.createRect || prepared.createRect;
            prepared.selector = afterSyncPrepared.selector || prepared.selector;
            prepared.strategy = afterSyncPrepared.strategy || prepared.strategy;
            prepared.visible = afterSyncPrepared.visible || prepared.visible;
            prepared.store = afterSyncPrepared.store || prepared.store;
            prepared.createButton = afterSyncPrepared.createButton || prepared.createButton;
            prepared.expected = afterSyncPrepared.expected || prepared.expected;
          }
          const remainingProblems = debuggerPreparedSettingsProblems(afterSyncPrepared?.ok ? afterSyncPrepared : synced, task);
          recordTrace(task, "settings_state_repair_verified", {
            ok: Boolean(afterSyncPrepared?.ok) && remainingProblems.length === 0,
            error: afterSyncPrepared?.error || "",
            problems: remainingProblems,
            editorRect: prepared.editorRect || null,
            createRect: prepared.createRect || null,
            createDisabled: Boolean(prepared.createButton?.disabled),
            selectedVideoDuration: prepared.store?.selectedVideoDuration ?? null,
            videoApi: prepared.store?.currentModelKeys?.videoApi || "",
            videoModelKey: prepared.store?.currentModelKeys?.videoModelKey || ""
          });
          if (!afterSyncPrepared?.ok || remainingProblems.length) {
            const error = afterSyncPrepared?.error || `DOM_DEBUGGER_SETTINGS_STATE_INVALID:${remainingProblems.join(",")}`;
            return {
              ok: false,
              status: 0,
              statusText: error,
              error,
              data: { prepared, synced, afterSyncPrepared, remainingProblems, transport: "chrome_debugger" }
            };
          }
          }
        }

        const commitPrep = await sendPageCommand({
          action: "domCommitPromptForDebugger",
          task,
          timeoutMs: 120000
        }, tabId);
        const typed = commitPrep?.result?.result || commitPrep?.result || commitPrep;
        if (typed?.ok) {
          prepared.editorRect = typed.editorRect || prepared.editorRect;
          prepared.createRect = typed.createRect || prepared.createRect;
          prepared.selector = typed.selector || prepared.selector;
          prepared.strategy = typed.strategy || prepared.strategy;
          prepared.visible = typed.visible || prepared.visible;
          prepared.store = typed.store || prepared.store;
          prepared.createButton = typed.createButton || prepared.createButton;
        }
        recordTrace(task, "prompt_commit_page_hook", {
          ok: Boolean(typed?.ok),
          error: typed?.error || "",
          persisted: typed?.commit?.persisted || "",
          storePersisted: typed?.commit?.storePersisted || "",
          slatePersisted: typed?.commit?.slatePersisted || "",
          method: typed?.commit?.method || "",
          createRect: typed?.createRect || null,
          selector: typed?.selector || "",
          strategy: typed?.strategy || "",
          createDisabled: Boolean(typed?.createButton?.disabled),
          selectedVideoDuration: typed?.store?.selectedVideoDuration ?? null,
          commitReceivedUserInput: typed?.commit?.receivedUserInput || null,
          receivedUserInput: typed?.store?.receivedUserInput || null
        });
        recordTrace(task, "prompt_insert_result", {
          ok: Boolean(typed?.ok),
          error: typed?.error || "",
          point: null,
          method: typed?.commit?.method || "page_hook_prompt_commit",
          length: String(task.prompt || "").length
        });
        if (!typed?.ok) {
          const error = typed?.error || "DOM_PROMPT_NOT_PERSISTED";
          return { ok: false, status: 0, statusText: error, error, data: { prepared, typed, transport: "chrome_debugger" } };
        }

        const refreshedAfterInsert = await sendPageCommand({
          action: "domPrepareTaskForDebugger",
          task,
          meta: {
            ...meta,
            debuggerTransport: true,
            skipDomModeAndSettingsMutation: true,
            afterPromptInsert: true,
            skipPostUploadSettle: false,
            skipSettingsSettle: debuggerShouldAvoidHiddenSettingsStoreRepair(task)
          },
          timeoutMs: 120000
        }, tabId);
        const afterInsert = refreshedAfterInsert?.result?.result || refreshedAfterInsert?.result || refreshedAfterInsert;
        if (afterInsert?.ok) {
          prepared.editorRect = afterInsert.editorRect || prepared.editorRect;
          prepared.createRect = afterInsert.createRect || prepared.createRect;
          prepared.selector = afterInsert.selector || prepared.selector;
          prepared.strategy = afterInsert.strategy || prepared.strategy;
          prepared.attachOutcome = afterInsert.attachOutcome || prepared.attachOutcome;
          prepared.visible = afterInsert.visible || prepared.visible;
          prepared.store = afterInsert.store || prepared.store;
          prepared.createButton = afterInsert.createButton || prepared.createButton;
          prepared.expected = afterInsert.expected || prepared.expected;
        }
        recordTrace(task, "prep_after_prompt_insert", {
          ok: Boolean(afterInsert?.ok),
          error: afterInsert?.error || "",
          attached: afterInsert?.attachOutcome?.attached || 0,
          serializedIds: [
            ...(Array.isArray(afterInsert?.attachOutcome?.serializedIds) ? afterInsert.attachOutcome.serializedIds : []),
            ...(Array.isArray(afterInsert?.attachOutcome?.preSubmitRefs?.serializedIds) ? afterInsert.attachOutcome.preSubmitRefs.serializedIds : [])
          ].filter(Boolean),
          refAttachAfterPromptInsert: attachRefsAfterPromptInsert
        });
        if (attachRefsAfterPromptInsert && !afterInsert?.ok) {
          const error = afterInsert?.error || "DOM_DEBUGGER_AFTER_PROMPT_ATTACH_FAILED";
          return {
            ok: false,
            status: Number(afterInsert?.status || 0),
            statusText: error,
            error,
            data: { prepared, afterInsert, transport: "chrome_debugger" }
          };
        }
        let finalPrepared = afterInsert;
        if (!attachRefsAfterPromptInsert) {
          await sleep(300);
          const finalPrep = await sendPageCommand({
            action: "domPrepareTaskForDebugger",
            task,
            meta: {
              ...meta,
              debuggerTransport: true,
              skipDomModeAndSettingsMutation: true,
              afterPromptInsert: true,
              skipDebuggerAttach: attachRefsAfterPromptInsert,
              skipSettingsSettle: debuggerShouldAvoidHiddenSettingsStoreRepair(task)
            },
            timeoutMs: 120000
          }, tabId);
          finalPrepared = finalPrep?.result?.result || finalPrep?.result || finalPrep;
        }
        if (finalPrepared?.ok) {
          prepared.editorRect = finalPrepared.editorRect || prepared.editorRect;
          prepared.createRect = finalPrepared.createRect || prepared.createRect;
          prepared.selector = finalPrepared.selector || prepared.selector;
          prepared.strategy = finalPrepared.strategy || prepared.strategy;
          prepared.attachOutcome = finalPrepared.attachOutcome?.preSubmitRefs
            ? finalPrepared.attachOutcome
            : (prepared.attachOutcome || finalPrepared.attachOutcome);
          prepared.visible = finalPrepared.visible || prepared.visible;
          prepared.store = finalPrepared.store || prepared.store;
          prepared.createButton = finalPrepared.createButton || prepared.createButton;
          prepared.expected = finalPrepared.expected || prepared.expected;
        }
        recordTrace(task, "prep_final_before_click", {
          ok: Boolean(finalPrepared?.ok),
          error: finalPrepared?.error || "",
          editorRect: prepared.editorRect || null,
          createRect: prepared.createRect || null,
          selector: prepared.selector || "",
          strategy: prepared.strategy || ""
        });
        if (attachRefsAfterPromptInsert && !finalPrepared?.ok) {
          const error = finalPrepared?.error || "DOM_DEBUGGER_FINAL_PREP_FAILED";
          return {
            ok: false,
            status: Number(finalPrepared?.status || 0),
            statusText: error,
            error,
            data: { prepared, finalPrepared, transport: "chrome_debugger" }
          };
        }
        const liveAttachment = await ensureDebuggerAttached(tabId, recordTrace, task);
        target = liveAttachment.target;
        await ensureNetworkEnabled(tabId, target);
        const detailClose = await debuggerCloseImageDetailIfOpen(target);
        recordTrace(task, "detail_editor_close_before_submit", {
          ok: Boolean(detailClose?.ok),
          closed: Boolean(detailClose?.closed),
          method: detailClose?.method || "",
          reason: detailClose?.reason || "",
          error: detailClose?.error || ""
        });
        if (detailClose?.closed) {
          await sleep(1600);
        } else if (detailClose?.ok === false) {
          return {
            ok: false,
            status: 0,
            statusText: "DOM_DEBUGGER_IMAGE_DETAIL_EDITOR_OPEN",
            error: "DOM_DEBUGGER_IMAGE_DETAIL_EDITOR_OPEN",
            data: { prepared, detailClose, transport: "chrome_debugger" }
          };
        }
        const refModeNeedsLayoutSettle = debuggerShouldAttachRefsAfterPromptInsert(task);
        const createStabilizeTimeoutMs = refModeNeedsLayoutSettle ? 4200 : 1800;
        const createStabilizeOptions = refModeNeedsLayoutSettle ? { minWaitMs: 900 } : {};
        let liveCreate = await debuggerStableCreateButtonPoint(target, createStabilizeTimeoutMs, createStabilizeOptions);
        if (debuggerResultLooksDetached(liveCreate)) {
          recordTrace(task, "submit_create_probe_reattach", { reason: "debugger_detached_during_create_stabilize" });
          const reattached = await ensureDebuggerAttached(tabId, recordTrace, task);
          target = reattached.target;
          await ensureNetworkEnabled(tabId, target);
          liveCreate = await debuggerStableCreateButtonPoint(target, createStabilizeTimeoutMs, createStabilizeOptions);
        }
        if (liveCreate?.ok && liveCreate.rect) {
          prepared.createRect = liveCreate.rect;
          prepared.createButton = {
            ...(prepared.createButton || {}),
            text: liveCreate.text || prepared.createButton?.text || "",
            rect: liveCreate.rect,
            strategy: liveCreate.strategy || prepared.createButton?.strategy || ""
          };
        }
        const safeCreatePoint = liveCreate?.ok && liveCreate.point
          ? liveCreate.point
          : pointFromRect(prepared.createRect);
        const hit = liveCreate?.hit || await debuggerHitTest(target, safeCreatePoint);
        recordTrace(task, "submit_hit_test", { createPoint: safeCreatePoint, liveCreate, hit });
        if (!hitLooksLikeCreateButton(hit)) {
          return {
            ok: false,
            status: 0,
            statusText: "DOM_DEBUGGER_CREATE_TARGET_UNSAFE",
            error: "DOM_DEBUGGER_CREATE_TARGET_UNSAFE",
            data: { prepared, hit, createPoint: safeCreatePoint, transport: "chrome_debugger" }
          };
        }
        const captureId = `${String(task.id || "task").trim() || "task"}-${Date.now()}`;
        const shouldVerifySerializedRefs = String(task.mode || "") === "text-to-image" || String(task.mode || "") === "ingredients-to-video";
        const requestSerializedRefs = [
          ...(Array.isArray(prepared.attachOutcome?.requestSerializedIds) ? prepared.attachOutcome.requestSerializedIds : []),
          ...(Array.isArray(prepared.attachOutcome?.preSubmitRefs?.requestSerializedIds) ? prepared.attachOutcome.preSubmitRefs.requestSerializedIds : [])
        ].map((id) => String(id || "").trim()).filter(Boolean);
        const storeSerializedRefs = [
          ...(Array.isArray(prepared.attachOutcome?.serializedIds) ? prepared.attachOutcome.serializedIds : []),
          ...(Array.isArray(prepared.attachOutcome?.preSubmitRefs?.serializedIds) ? prepared.attachOutcome.preSubmitRefs.serializedIds : [])
        ].map((id) => String(id || "").trim()).filter(Boolean);
        const expectedSerializedRefs = shouldVerifySerializedRefs
          ? [...new Set((requestSerializedRefs.length ? requestSerializedRefs : storeSerializedRefs))]
          : [];
        const armedCapture = await sendPageCommand({
          action: "domArmDebuggerSubmitCapture",
          task,
          meta: {
            ...meta,
            captureId,
            expectedSerializedRefs,
            timeoutMs: meta.noRequestTimeoutMs || meta.timeoutMs || debuggerNoRequestTimeoutMs(task),
            responseTimeoutMs: meta.responseTimeoutMs || undefined
          },
          timeoutMs: 10000
        }, tabId);
        const armed = armedCapture?.result?.result || armedCapture?.result || armedCapture;
        recordTrace(task, "submit_capture_arm", {
          ok: Boolean(armed?.ok),
          error: armed?.error || "",
          captureId,
          expectedSerializedRefs: armed?.expectedSerializedRefs || expectedSerializedRefs,
          storeSerializedRefs,
          requestSerializedRefs,
          expectedMediaIdCount: armed?.expectedMediaIdCount || expectedCount
        });
        if (!armed?.ok) {
          const error = armed?.error || "DOM_DEBUGGER_CAPTURE_ARM_FAILED";
          return {
            ok: false,
            status: 0,
            statusText: error,
            error,
            data: { prepared, armed, transport: "chrome_debugger" }
          };
        }
        const debuggerNetworkResponsePromise = waitForDebuggerGenerationResponse(target, {
          projectId: prepared.projectId || "",
          expectedCount,
          timeoutMs: Number(meta.responseTimeoutMs || responseTimeoutMs) || responseTimeoutMs
        });
        await debuggerSend(target, "Page.bringToFront").catch(() => {});
        const enterSubmit = debuggerShouldSubmitWithPromptEnter(task);
        const editorPoint = pointFromRect(prepared.editorRect);
        recordTrace(task, "submit_click", {
          createPoint: safeCreatePoint,
          editorPoint,
          expectedCount,
          method: enterSubmit ? "editor_enter" : "create_button"
        });
        if (enterSubmit) {
          await debuggerClick(target, editorPoint);
          await sleep(120);
          await debuggerPressKey(target, "Enter", "Enter", 13, { holdMs: 35 });
          await sleep(450);
          const afterEnterSnapshot = await debuggerFrontSubmitSnapshot(target, task);
          const fallbackCandidate = frontSnapshotStillSubmittable(afterEnterSnapshot);
          recordTrace(task, "submit_enter_probe", {
            fallbackCandidate: Boolean(fallbackCandidate),
            fallbackDeferredUntilNoRequest: Boolean(fallbackCandidate),
            promptStillVisible: Boolean(afterEnterSnapshot?.promptStillVisible),
            createDisabled: Boolean(afterEnterSnapshot?.createDisabled),
            progressVisible: Boolean(afterEnterSnapshot?.progressVisible),
            createButtons: afterEnterSnapshot?.createButtons || [],
            editors: afterEnterSnapshot?.editors || []
          });
        } else {
          await debuggerClick(target, safeCreatePoint);
        }
        let frontTransition = debuggerRequiresFrontSubmitTransition(task)
          ? await waitForFrontSubmitTransition(target, task, 7000)
          : { ok: true, skipped: true, reason: "not_required_for_mode" };
        recordTrace(task, "front_submit_transition", {
          ok: Boolean(frontTransition.ok),
          skipped: Boolean(frontTransition.skipped),
          reason: frontTransition.reason || "",
          promptStillVisible: Boolean(frontTransition.snapshot?.promptStillVisible),
          createDisabled: Boolean(frontTransition.snapshot?.createDisabled),
          progressVisible: Boolean(frontTransition.snapshot?.progressVisible),
          matchingPromptCardCount: Number(frontTransition.snapshot?.matchingPromptCardCount || 0),
          matchingMediaCardCount: Number(frontTransition.snapshot?.matchingMediaCardCount || 0),
          progressCardCount: Number(frontTransition.snapshot?.progressCardCount || 0),
          matchingProjectCards: frontTransition.snapshot?.matchingProjectCards || [],
          editors: frontTransition.snapshot?.editors || []
        });
        if (String(task.mode || "") === "text-to-image" && frontTransition?.ok) {
          recordTrace(task, "front_submit_transition_wait_for_request", {
            reason: frontTransition.reason || "",
            strongProof: frontSubmitTransitionHasStrongProof(frontTransition),
            promptStillVisible: Boolean(frontTransition.snapshot?.promptStillVisible),
            matchingPromptCardCount: Number(frontTransition.snapshot?.matchingPromptCardCount || 0),
            matchingMediaCardCount: Number(frontTransition.snapshot?.matchingMediaCardCount || 0),
            progressCardCount: Number(frontTransition.snapshot?.progressCardCount || 0)
          });
        }
        const pageCapture = await sendPageCommand({
          action: "domAwaitDebuggerSubmitCapture",
          task,
          meta: { captureId },
          timeoutMs: Number(meta.responseTimeoutMs || responseTimeoutMs) + 15000
        }, tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "DOM_DEBUGGER_CAPTURE_AWAIT_FAILED") }));
        const pageResponse = pageCapture?.result?.result || pageCapture?.result || pageCapture;
        recordTrace(task, "submit_capture_result", {
          ok: Boolean(pageResponse?.ok),
          error: pageResponse?.error || "",
          status: Number(pageResponse?.status || 0),
          mediaIdCount: Array.isArray(pageResponse?.mediaIds) ? pageResponse.mediaIds.length : 0,
          capturedResponseCount: pageResponse?.capturedResponseCount || 0,
          partialMediaCapture: Boolean(pageResponse?.partialMediaCapture),
          endpoint: pageResponse?.endpoint || "",
          endpointKind: pageResponse?.endpointKind || "",
          serializedRefs: pageResponse?.serializedRefs || null,
          captureId
        });
        const pageCaptureError = String(pageResponse?.error || "");
        const pageCaptureProvedNoRequest = /REQUEST_NOT_OBSERVED|NO_REQUEST|request_not_observed/i.test(pageCaptureError);
        const pageCaptureObservedRequest = Number(pageResponse?.status || 0) > 0
          || Boolean(pageResponse?.endpoint)
          || Boolean(pageResponse?.serializedRefs);
        if (pageCaptureProvedNoRequest) {
          recordTrace(task, "submit_capture_no_request_fast_retry", {
            error: pageCaptureError,
            captureId,
            pageCaptureObservedRequest
          });
        }
        let response = Array.isArray(pageResponse?.mediaIds) && pageResponse.mediaIds.length
          ? pageResponse
          : pageCaptureProvedNoRequest
            ? pageResponse
            : pageCaptureObservedRequest
              ? pageResponse
            : await debuggerNetworkResponsePromise;
        let mediaIds = mediaIdsFrom(response?.mediaIds || []);
        recordTrace(task, "response_result", {
          status: Number(response?.status || 0),
          error: response?.error || "",
          mediaIdCount: mediaIds.length,
          mediaIds,
          expectedCount,
          pageCaptureProvedNoRequest,
          incomplete: Boolean(response?.incomplete)
        });
        const frontSubmitAlreadyMoved = frontSubmitTransitionHasStrongProof(frontTransition);
        if (!mediaIds.length && !pageCaptureObservedRequest && !frontSubmitAlreadyMoved && /REQUEST_NOT_OBSERVED|NO_REQUEST|request_not_observed/i.test(String(response?.error || pageResponse?.error || ""))) {
          const retryCaptureId = `${String(task.id || "task").trim() || "task"}-retry-${Date.now()}`;
          recordTrace(task, "submit_no_request_retry_create_start", {
            previousError: response?.error || pageResponse?.error || "",
            retryCaptureId,
            frontSubmitAlreadyMoved
          });
          if (String(task.mode || "") === "text-to-image") {
            const retryCommitPrep = await sendPageCommand({
              action: "domCommitPromptForDebugger",
              task,
              meta: { reason: "retry_after_no_request" },
              timeoutMs: 120000
            }, tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "DOM_PROMPT_RECOMMIT_FAILED") }));
            const retryTyped = retryCommitPrep?.result?.result || retryCommitPrep?.result || retryCommitPrep;
            recordTrace(task, "submit_no_request_retry_prompt_recommit", {
              ok: Boolean(retryTyped?.ok),
              error: retryTyped?.error || "",
              persisted: retryTyped?.commit?.persisted || "",
              storePersisted: retryTyped?.commit?.storePersisted || "",
              method: retryTyped?.commit?.method || ""
            });
            if (!retryTyped?.ok) {
              const error = retryTyped?.error || "DOM_PROMPT_RECOMMIT_FAILED";
              return {
                ok: false,
                status: 0,
                statusText: error,
                error,
                data: { prepared, retryTyped, transport: "chrome_debugger" }
              };
            }
            await sleep(350);
          }
          const retryArmedCapture = await sendPageCommand({
            action: "domArmDebuggerSubmitCapture",
            task,
            meta: {
              ...meta,
              captureId: retryCaptureId,
              expectedSerializedRefs,
              timeoutMs: meta.noRequestTimeoutMs || meta.timeoutMs || debuggerNoRequestTimeoutMs(task),
              responseTimeoutMs: meta.responseTimeoutMs || undefined,
              reason: "retry_create_after_no_request"
            },
            timeoutMs: 10000
          }, tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "DOM_DEBUGGER_CAPTURE_ARM_FAILED") }));
          const retryArmed = retryArmedCapture?.result?.result || retryArmedCapture?.result || retryArmedCapture;
          const retryNetworkResponsePromise = waitForDebuggerGenerationResponse(target, {
            projectId: prepared.projectId || "",
            expectedCount,
            timeoutMs: Number(meta.responseTimeoutMs || responseTimeoutMs) || responseTimeoutMs
          });
          let retryCreate = await debuggerStableCreateButtonPoint(target, 4200, { minWaitMs: 900 });
          if (debuggerResultLooksDetached(retryCreate)) {
            recordTrace(task, "submit_no_request_retry_reattach", { reason: "debugger_detached_during_retry_create_stabilize" });
            const retryReattached = await ensureDebuggerAttached(tabId, recordTrace, task);
            target = retryReattached.target;
            await ensureNetworkEnabled(tabId, target);
            retryCreate = await debuggerStableCreateButtonPoint(target, 4200, { minWaitMs: 900 });
          }
          const retryPoint = retryCreate?.ok && retryCreate.point
            ? retryCreate.point
            : safeCreatePoint;
          const retryHit = retryCreate?.hit || await debuggerHitTest(target, retryPoint);
          recordTrace(task, "submit_no_request_retry_create_click", {
            armed: Boolean(retryArmed?.ok),
            armError: retryArmed?.error || "",
            createPoint: retryPoint,
            liveCreate: retryCreate,
            hit: retryHit
          });
          if (retryArmed?.ok && hitLooksLikeCreateButton(retryHit)) {
            await debuggerClick(target, retryPoint);
            const retryPageCapture = await sendPageCommand({
              action: "domAwaitDebuggerSubmitCapture",
              task,
              meta: { captureId: retryCaptureId },
              timeoutMs: Number(meta.responseTimeoutMs || responseTimeoutMs) + 15000
            }, tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "DOM_DEBUGGER_CAPTURE_AWAIT_FAILED") }));
            const retryPageResponse = retryPageCapture?.result?.result || retryPageCapture?.result || retryPageCapture;
            recordTrace(task, "submit_no_request_retry_capture_result", {
              ok: Boolean(retryPageResponse?.ok),
              error: retryPageResponse?.error || "",
              status: Number(retryPageResponse?.status || 0),
              mediaIdCount: Array.isArray(retryPageResponse?.mediaIds) ? retryPageResponse.mediaIds.length : 0,
              capturedResponseCount: retryPageResponse?.capturedResponseCount || 0,
              endpoint: retryPageResponse?.endpoint || "",
              endpointKind: retryPageResponse?.endpointKind || "",
              retryCaptureId
            });
            const retryPageCaptureObservedRequest = Number(retryPageResponse?.status || 0) > 0
              || Boolean(retryPageResponse?.endpoint)
              || Boolean(retryPageResponse?.serializedRefs);
            const retryResponse = Array.isArray(retryPageResponse?.mediaIds) && retryPageResponse.mediaIds.length
              ? retryPageResponse
              : await retryNetworkResponsePromise;
            const retryMediaIds = mediaIdsFrom(retryResponse?.mediaIds || []);
            recordTrace(task, "response_retry_result", {
              status: Number(retryResponse?.status || 0),
              error: retryResponse?.error || "",
              mediaIdCount: retryMediaIds.length,
              mediaIds: retryMediaIds,
              expectedCount,
              incomplete: Boolean(retryResponse?.incomplete)
            });
            if (String(task.mode || "") === "text-to-image" && !retryMediaIds.length && retryPageCaptureObservedRequest) {
              const retryFrontTransition = await waitForFrontSubmitTransition(target, task, 7000);
              return await acceptTextToImageFrontSubmit({
                status: Number(retryResponse?.status || retryPageResponse?.status || 202),
                response: retryResponse,
                pageResponse: retryPageResponse,
                frontTransition: retryFrontTransition,
                pageCaptureObservedRequest: true,
                traceLabel: "front_submit_retry_request_confirmed_without_media_ids"
              });
            }
            if (retryMediaIds.length) {
              response = retryResponse;
              mediaIds = retryMediaIds;
            }
          }
        } else if (!mediaIds.length && !pageCaptureObservedRequest && frontSubmitAlreadyMoved && /REQUEST_NOT_OBSERVED|NO_REQUEST|request_not_observed/i.test(String(response?.error || pageResponse?.error || ""))) {
          recordTrace(task, "submit_no_request_retry_skipped_front_moved", {
            previousError: response?.error || pageResponse?.error || "",
            frontTransitionReason: frontTransition?.reason || "",
            promptStillVisible: Boolean(frontTransition?.snapshot?.promptStillVisible),
            matchingPromptCardCount: Number(frontTransition?.snapshot?.matchingPromptCardCount || 0),
            matchingMediaCardCount: Number(frontTransition?.snapshot?.matchingMediaCardCount || 0)
          });
        }
        if (debuggerRequiresFrontSubmitTransition(task) && !frontSubmitTransitionHasStrongProof(frontTransition) && mediaIds.length) {
          const refreshedFrontTransition = await waitForFrontSubmitTransition(target, task, 12000, { mediaIds });
          recordTrace(task, "front_submit_transition_after_response", {
            ok: Boolean(refreshedFrontTransition.ok),
            skipped: Boolean(refreshedFrontTransition.skipped),
            reason: refreshedFrontTransition.reason || "",
            promptStillVisible: Boolean(refreshedFrontTransition.snapshot?.promptStillVisible),
            createDisabled: Boolean(refreshedFrontTransition.snapshot?.createDisabled),
            progressVisible: Boolean(refreshedFrontTransition.snapshot?.progressVisible),
            matchingPromptCardCount: Number(refreshedFrontTransition.snapshot?.matchingPromptCardCount || 0),
            matchingMediaCardCount: Number(refreshedFrontTransition.snapshot?.matchingMediaCardCount || 0),
            progressCardCount: Number(refreshedFrontTransition.snapshot?.progressCardCount || 0),
            matchingProjectCards: refreshedFrontTransition.snapshot?.matchingProjectCards || [],
            mediaIds,
            editors: refreshedFrontTransition.snapshot?.editors || []
          });
          if (refreshedFrontTransition.ok) {
            frontTransition = refreshedFrontTransition;
          }
        }
        const frontSubmitObservedStatus = Number(response?.status || pageResponse?.status || 0);
        const t2iRequestAcceptedWithoutMediaIds = String(task.mode || "") === "text-to-image"
          && !mediaIds.length
          && pageCaptureObservedRequest
          && Boolean(response?.ok || pageResponse?.ok)
          && frontSubmitObservedStatus >= 200
          && frontSubmitObservedStatus < 300;
        const frontSubmitObservedWithoutMediaIds = String(task.mode || "") === "text-to-image"
          && !mediaIds.length
          && (Boolean(frontTransition?.ok) || t2iRequestAcceptedWithoutMediaIds)
          && (pageCaptureObservedRequest || frontSubmitObservedStatus > 0)
          && (frontSubmitObservedStatus === 0 || (frontSubmitObservedStatus >= 200 && frontSubmitObservedStatus < 500));
        if (frontSubmitObservedWithoutMediaIds) {
          return await acceptTextToImageFrontSubmit({
            status: frontSubmitObservedStatus,
            response,
            pageResponse,
            frontTransition,
            pageCaptureObservedRequest,
            traceLabel: t2iRequestAcceptedWithoutMediaIds
              ? "t2i_request_accepted_without_media_ids"
              : "front_submit_transition_accepted_without_media_ids"
          });
        }
        if (!mediaIds.length) {
          const error = response?.error || "request_not_observed";
          return {
            ok: false,
            status: Number(response?.status || 0),
            statusText: /^DOM_DEBUGGER_/i.test(error) ? error : `DOM_DEBUGGER_REQUEST_NOT_OBSERVED:${error}`,
            error: /^DOM_DEBUGGER_/i.test(error) ? error : `DOM_DEBUGGER_REQUEST_NOT_OBSERVED:${error}`,
            data: { prepared, response, transport: "chrome_debugger" }
          };
        }
        if (debuggerRequiresFrontSubmitTransition(task) && !frontSubmitTransitionHasStrongProof(frontTransition) && mediaIds.length) {
          recordTrace(task, "front_submit_transition_network_only_rejected", {
            reason: frontTransition.reason || "front_transition_missing_but_dom_response_confirmed",
            mediaIdCount: mediaIds.length,
            mediaIds,
            expectedCount,
            promptStillVisible: Boolean(frontTransition.snapshot?.promptStillVisible),
            progressVisible: Boolean(frontTransition.snapshot?.progressVisible),
            createDisabled: Boolean(frontTransition.snapshot?.createDisabled)
          });
        }
        if (debuggerRequiresFrontSubmitTransition(task) && !frontSubmitTransitionHasStrongProof(frontTransition)) {
          return {
            ok: false,
            status: Number(response?.status || 0),
            statusText: "DOM_DEBUGGER_FRONTEND_NOT_UPDATED",
            error: "DOM_DEBUGGER_FRONTEND_NOT_UPDATED",
            mediaIds,
            outputRows: Array.isArray(response?.outputRows) ? response.outputRows : [],
            data: { prepared, response, frontTransition, transport: "chrome_debugger" }
          };
        }
        if (mediaIds.length < expectedCount) {
          recordTrace(task, "partial_media_ids_allowed", { mediaIdCount: mediaIds.length, expectedCount, mediaIds });
        }
        const clearedPrompt = await sendPageCommand({
          action: "domClearPromptAfterDebuggerSubmit",
          task,
          meta: { reason: "debugger_submit_confirmed" },
          timeoutMs: 10000
        }, tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "DOM_PROMPT_CLEAR_FAILED") }));
        const clearResult = clearedPrompt?.result?.result || clearedPrompt?.result || clearedPrompt;
        recordTrace(task, "prompt_clear_after_submit", {
          ok: Boolean(clearResult?.ok),
          error: clearResult?.error || "",
          before: clearResult?.before || "",
          after: clearResult?.after || "",
          storeAfter: clearResult?.storeAfter || "",
          method: clearResult?.method || ""
        });
        return {
          ok: true,
          status: Number(response.status || 200),
          statusText: mediaIds.length < expectedCount ? `DOM_DEBUGGER_PARTIAL_MEDIA_IDS:${mediaIds.length}/${expectedCount}` : "DOM_DEBUGGER_SUBMIT_OK",
          mediaIds,
          outputRows: Array.isArray(response?.outputRows) ? response.outputRows : [],
          data: {
            ...prepared,
            response,
            mediaIds,
            outputRows: Array.isArray(response?.outputRows) ? response.outputRows : [],
            expectedCount,
            partialMediaIds: mediaIds.length < expectedCount,
            transport: "chrome_debugger"
          }
        };
      } finally {
        markDebuggerBusy(tabId, false, recordTrace, task, "submit_task_finally");
        scheduleDebuggerDetach(tabId, recordTrace, task);
      }
    }
  };
}
