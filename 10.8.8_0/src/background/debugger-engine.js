import { extractMediaIds } from "../core/media/flow-client.js";
import { normalizeVideoModelKey } from "../core/contracts/api.js";

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

function debuggerCollectionWorkflowIdValue(value = null) {
  if (!value) return "";
  if (typeof value === "string") return normalizeId(value);
  if (typeof value !== "object") return "";
  return normalizeId(
    value.workflowId ||
    value.workflow ||
    value.flowWorkflowId ||
    value.id ||
    value.name ||
    ""
  );
}

function debuggerPreparedCollectionWorkflowId(store = {}) {
  return debuggerCollectionWorkflowIdValue(
    store.inputs?.collectionOrWorkflowId ||
    store.collectionOrWorkflowId ||
    store.collectionWorkflowId
  );
}

function debuggerIsOmniTextToVideo(task = {}) {
  return String(task.mode || "") === "text-to-video"
    && /^(omni_flash|omni|abra)$/i.test(String(task.model || "").trim());
}

function debuggerIsOmniIngredientsTask(task = {}) {
  return String(task.mode || "") === "ingredients-to-video"
    && /^(omni_flash|omni|abra)$/i.test(String(task.model || "").trim());
}

function debuggerRedactId(value = "") {
  const id = String(value || "").trim();
  if (!id) return "";
  if (id.length <= 12) return `${id.slice(0, 4)}...`;
  return `${id.slice(0, 8)}...${id.slice(-4)}`;
}

function debuggerVisibleVideoTriggerProblems(task = {}, visible = {}, proof = {}) {
  if (!debuggerIsOmniTextToVideo(task)) return [];
  const duration = String(proof.expectedDuration || debuggerDurationForTask(task));
  const triggerText = String(visible?.settingsTriggerText || "").replace(/\s+/g, " ").trim();
  const selectedTabs = Array.isArray(visible?.selectedModeTabs) ? visible.selectedModeTabs : [];
  const combined = [
    visible?.visibleTriggerMode,
    visible?.visibleTriggerDuration,
    visible?.visibleModel,
    visible?.settingsSurfaceText,
    visible?.activePanelText,
    triggerText,
    ...selectedTabs
  ].join(" ");
  const problems = [];
  if (!/\bVideo\b/i.test(combined)) {
    problems.push(`visibleTriggerMode:${triggerText || "missing"}!=Video`);
  }
  if (duration && !new RegExp(`\\b${duration}s\\b`, "i").test(combined)) {
    problems.push(`visibleTriggerDuration:${triggerText || "missing"}!=${duration}s`);
  }
  return problems;
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

async function debuggerNudgePromptWithNativeInput(target, editorRect, trace, task, reason = "") {
  if (!editorRect) return { ok: false, skipped: true, reason: "editor_rect_missing" };
  const point = pointFromRect(editorRect);
  try {
    await debuggerClick(target, point);
    await sleep(120);
    await debuggerPressKey(target, "End", "End", 35, { holdMs: 20 }).catch(() => {});
    await sleep(80);
    await debuggerSend(target, "Input.insertText", { text: " " });
    await sleep(80);
    await debuggerPressKey(target, "Backspace", "Backspace", 8, { nativeVirtualKeyCode: 51, holdMs: 20 });
    await sleep(180);
    const result = { ok: true, point, reason };
    trace(task, "prompt_native_input_nudge", result);
    return result;
  } catch (error) {
    const result = { ok: false, point, reason, error: String(error?.message || error || "NATIVE_INPUT_NUDGE_FAILED") };
    trace(task, "prompt_native_input_nudge", result);
    return result;
  }
}

async function debuggerPromptEditorSnapshot(target) {
  return await debuggerEvaluate(target, `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const rectFor = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const textFor = (element) => String(element?.innerText || element?.textContent || element?.value || "").trim();
    const editor = Array.from(document.querySelectorAll("[data-slate-editor='true'],[role='textbox'],textarea"))
      .filter(visible)
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height + br.bottom) - (ar.width * ar.height + ar.bottom);
      })[0] || null;
    const create = Array.from(document.querySelectorAll("button,[role='button']"))
      .filter(visible)
      .find((button) => /arrow_forward/i.test(String(button.innerText || button.textContent || ""))) || null;
    return {
      editorText: textFor(editor),
      editorRect: rectFor(editor),
      createText: textFor(create),
      createRect: rectFor(create),
      createDisabled: Boolean(create?.disabled || create?.getAttribute?.("aria-disabled") === "true")
    };
  })()`);
}

function normalizeDebuggerPromptText(value = "") {
  return String(value || "").replace(/\uFEFF/g, "").replace(/\s+/g, " ").trim();
}

async function debuggerTypeNativeText(target, text = "") {
  const value = String(text || "");
  for (const char of value) {
    if (char === "\n") {
      await debuggerSend(target, "Input.dispatchKeyEvent", {
        type: "char",
        text: "\n",
        unmodifiedText: "\n"
      });
    } else {
      await debuggerSend(target, "Input.dispatchKeyEvent", {
        type: "char",
        text: char,
        unmodifiedText: char
      });
    }
    await sleep(6);
  }
}

async function debuggerTypePromptWithNativeInput(target, editorRect, prompt, trace, task, reason = "") {
  const point = pointFromRect(editorRect);
  try {
    if (!editorRect) throw new Error("editor_rect_missing");
    await debuggerClick(target, point);
    await sleep(120);
    await debuggerSend(target, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 0,
      modifiers: 4,
      commands: ["selectAll"]
    }).catch(() => {});
    await debuggerSend(target, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 0,
      modifiers: 4
    }).catch(() => {});
    await sleep(100);
    await debuggerPressKey(target, "Backspace", "Backspace", 8, { nativeVirtualKeyCode: 51, holdMs: 20 }).catch(() => {});
    await debuggerEvaluate(target, `(() => {
      const visible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
      };
      const editor = Array.from(document.querySelectorAll("[data-slate-editor='true'],[role='textbox'],textarea")).filter(visible)[0] || null;
      if (!editor) return { ok: false, error: "editor_not_found" };
      editor.focus();
      document.execCommand?.("selectAll");
      document.execCommand?.("delete");
      return { ok: true };
    })()`).catch(() => null);
    await sleep(120);
    await debuggerTypeNativeText(target, prompt);
    await sleep(450);
    const snapshot = await debuggerPromptEditorSnapshot(target).catch((error) => ({ error: String(error?.message || error) }));
    const persisted = normalizeDebuggerPromptText(snapshot?.editorText || "");
    const requested = normalizeDebuggerPromptText(prompt);
    const ok = Boolean(requested && persisted.includes(requested));
    const result = {
      ok,
      error: ok ? "" : "NATIVE_PROMPT_NOT_PERSISTED",
      point,
      reason,
      editorRect: snapshot?.editorRect || editorRect,
      createRect: snapshot?.createRect || null,
      createButton: {
        text: snapshot?.createText || "",
        disabled: Boolean(snapshot?.createDisabled),
        rect: snapshot?.createRect || null
      },
      commit: {
        persisted: snapshot?.editorText || "",
        storePersisted: "",
        slatePersisted: "",
        method: "cdp.Input.dispatchKeyEvent.char",
        receivedUserInput: { attempted: true, ok: true, reason: "native_cdp_keyboard_entry" }
      }
    };
    trace(task, "prompt_native_input_entry", {
      ok: result.ok,
      error: result.error,
      reason,
      point,
      persisted: result.commit.persisted.slice(0, 260),
      createDisabled: result.createButton.disabled
    });
    return result;
  } catch (error) {
    const result = {
      ok: false,
      error: String(error?.message || error || "NATIVE_PROMPT_ENTRY_FAILED"),
      point,
      reason,
      commit: { persisted: "", method: "cdp.Input.dispatchKeyEvent.char" }
    };
    trace(task, "prompt_native_input_entry", result);
    return result;
  }
}

function debuggerNormalizeNativeCharacterHandle(value = "") {
  return String(value || "")
    .replace(/^@+/, "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function debuggerNativeCharacterDisplayNameFromHandle(value = "") {
  return String(value || "")
    .replace(/^@+/, "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function debuggerNativeCharacterHandlesFromPrompt(prompt = "") {
  const handles = [];
  const seen = new Set();
  const pattern = /@[\s\u00a0]*([A-Za-z0-9][A-Za-z0-9_-]{0,63})\b/g;
  let match;
  while ((match = pattern.exec(String(prompt || "")))) {
    const handle = String(match[1] || "").trim();
    const key = debuggerNormalizeNativeCharacterHandle(handle);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    handles.push({ handle, normalizedHandle: key, displayName: debuggerNativeCharacterDisplayNameFromHandle(handle) });
  }
  return handles;
}

function debuggerNativeCharacterHandleMap(task = {}, options = {}) {
  const map = {};
  const add = (handle = "", entry = {}) => {
    const explicitHandle = String(entry.handle || entry.mention || "").trim();
    const handleKey = String(handle || "").trim();
    const keySource = /^\d+$/.test(handleKey) && explicitHandle
      ? explicitHandle
      : (handleKey || explicitHandle || entry.displayName || entry.name);
    const key = debuggerNormalizeNativeCharacterHandle(keySource);
    if (!key) return;
    if (map[key]?.displayName && map[key]?.source !== "prompt_fallback") return;
    map[key] = {
      handle: String(explicitHandle || handleKey || key).replace(/^@+/, "").trim() || key,
      displayName: String(
        entry.displayName ||
        entry.flowDisplayName ||
        entry.characterName ||
        entry.name ||
        debuggerNativeCharacterDisplayNameFromHandle(keySource || key)
      ).trim(),
      characterServerId: String(entry.characterServerId || entry.flowCharacterId || entry.entityId || "").trim(),
      source: String(entry.source || entry.sourceMode || "task_mapping")
    };
  };
  const assets = Array.isArray(task?.characterPreflight?.assets) ? task.characterPreflight.assets : [];
  assets.forEach((asset) => add(asset?.handle || asset?.mention || asset?.displayName || "", asset || {}));
  const explicit = task?.nativeCharacterHandleMap || task?.characterHandleMap || task?.characterMappings || {};
  if (Array.isArray(explicit)) {
    explicit.forEach((entry) => {
      if (typeof entry === "string") add(entry, { handle: entry, source: "explicit" });
      else add(entry?.handle || entry?.mention || entry?.displayName || "", { ...(entry || {}), source: entry?.source || "explicit" });
    });
  } else if (explicit && typeof explicit === "object") {
    Object.entries(explicit).forEach(([handle, entry]) => {
      if (typeof entry === "string") add(handle, { handle, displayName: entry, source: "explicit" });
      else add(handle, { ...(entry || {}), handle: entry?.handle || handle, source: entry?.source || "explicit" });
    });
  }
  if (options.includePromptFallback === true) {
    debuggerNativeCharacterHandlesFromPrompt(task.prompt || "").forEach((entry) => {
      if (!map[entry.normalizedHandle]) map[entry.normalizedHandle] = { ...entry, source: "prompt_fallback" };
    });
  }
  return map;
}

function debuggerEscapeRegExp(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function debuggerSemanticPromptNeedlesForTask(task = {}) {
  const compact = (value = "") => String(value || "").replace(/\s+/g, " ").trim();
  const rawPrompt = compact(task.prompt || "");
  const needles = [];
  const addNeedle = (value = "") => {
    const text = compact(value).slice(0, 120);
    if (text && !needles.includes(text)) needles.push(text);
  };
  addNeedle(rawPrompt);
  if (!rawPrompt) return needles;
  const handleMap = debuggerNativeCharacterHandleMap(task, { includePromptFallback: false });
  let semanticPrompt = rawPrompt;
  for (const entry of debuggerNativeCharacterHandlesFromPrompt(rawPrompt)) {
    const mapping = handleMap[entry.normalizedHandle];
    const displayName = compact(mapping?.displayName || "");
    if (!displayName) continue;
    const handlePattern = debuggerEscapeRegExp(entry.handle).replace(/[\s_]+/g, "[\\s_]+");
    semanticPrompt = semanticPrompt.replace(new RegExp(`@\\s*${handlePattern}`, "gi"), displayName);
  }
  addNeedle(semanticPrompt);
  return needles;
}

function debuggerContextualPromptNeedlesForTask(task = {}) {
  const compact = (value = "") => String(value || "").replace(/\s+/g, " ").trim();
  const rawPrompt = compact(task.prompt || "");
  const needles = [];
  const addNeedle = (value = "") => {
    const text = compact(value).slice(0, 120);
    if (text.length >= 12 && !needles.includes(text)) needles.push(text);
  };
  const addBracketTokens = (value = "") => {
    for (const token of String(value || "").match(/\[[^\]]{8,80}\]/g) || []) addNeedle(token);
  };
  const addLongPromptChunks = (value = "") => {
    for (const chunk of String(value || "").split(/@\s*[\w.-]+/g)) {
      const text = compact(chunk.replace(/\[[^\]]+\]/g, " "));
      if (text.length >= 24) addNeedle(text);
    }
  };
  if (!rawPrompt) return needles;
  const handleMap = debuggerNativeCharacterHandleMap(task, { includePromptFallback: false });
  let semanticPrompt = rawPrompt;
  const displayNames = [];
  for (const entry of debuggerNativeCharacterHandlesFromPrompt(rawPrompt)) {
    const mapping = handleMap[entry.normalizedHandle];
    const displayName = compact(mapping?.displayName || "");
    if (!displayName) continue;
    displayNames.push(displayName);
    const handlePattern = debuggerEscapeRegExp(entry.handle).replace(/[\s_]+/g, "[\\s_]+");
    semanticPrompt = semanticPrompt.replace(new RegExp(`@\\s*${handlePattern}`, "gi"), displayName);
  }
  addBracketTokens(rawPrompt);
  addBracketTokens(semanticPrompt);
  addLongPromptChunks(rawPrompt);
  addLongPromptChunks(semanticPrompt);
  let promptWithoutCharacterNames = semanticPrompt;
  for (const displayName of displayNames) {
    promptWithoutCharacterNames = promptWithoutCharacterNames.replace(new RegExp(debuggerEscapeRegExp(displayName), "gi"), " ");
  }
  addLongPromptChunks(promptWithoutCharacterNames);
  return needles;
}

function debuggerNativeCharacterPathCProofPassed(promptCommitEvidence = {}) {
  const proof = promptCommitEvidence?.nativeCharacterPathC?.preSubmitChipProof || {};
  const nativeChipCount = Number(
    promptCommitEvidence?.nativeCharacterPathC?.nativeChipCountAfter
      || proof.nativeChipCountAfter
      || 0
  );
  return Boolean(
    promptCommitEvidence?.ok === true &&
    promptCommitEvidence?.commit?.method === "pathC.beforeinput.nativeCharacterChips" &&
    nativeChipCount > 0 &&
    (
      proof.ok === true ||
      (
        proof.atTagTypeProof === true &&
        proof.characterServerIdProof === true &&
        proof.noUnresolvedHandles === true
      )
    )
  );
}

async function debuggerPressNativeAtSign(target) {
  const params = {
    key: "@",
    code: "Digit2",
    windowsVirtualKeyCode: 50,
    nativeVirtualKeyCode: 19,
    modifiers: 8,
    text: "@",
    unmodifiedText: "2"
  };
  await debuggerSend(target, "Input.dispatchKeyEvent", { type: "keyDown", ...params }).catch(() => {});
  await sleep(35);
  await debuggerSend(target, "Input.dispatchKeyEvent", { type: "char", ...params });
  await sleep(35);
  await debuggerSend(target, "Input.dispatchKeyEvent", { type: "keyUp", ...params }).catch(() => {});
}

async function debuggerClearActiveTextInput(target) {
  await debuggerSend(target, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 0,
    modifiers: 4,
    commands: ["selectAll"]
  }).catch(() => {});
  await debuggerSend(target, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 0,
    modifiers: 4
  }).catch(() => {});
  await sleep(60);
  await debuggerPressKey(target, "Backspace", "Backspace", 8, { nativeVirtualKeyCode: 51, holdMs: 20 }).catch(() => {});
}

function debuggerNativeCharacterTabExpression() {
  return `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const rectOf = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const textOf = (element) => String(element?.innerText || element?.textContent || element?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim();
    const dialog = Array.from(document.querySelectorAll("[role='dialog']")).filter(visible)[0] || document;
    const tab = Array.from(dialog.querySelectorAll("[role='tab'],button"))
      .filter(visible)
      .map((node) => ({ node, text: textOf(node), rect: rectOf(node) }))
      .find((item) => /accessibility_new|character/i.test(item.text));
    return tab ? { ok: true, text: tab.text, rect: tab.rect } : { ok: false, error: "native_character_tab_not_found" };
  })()`;
}

async function debuggerClickNativeCharacterTab(target) {
  const tab = await debuggerEvaluate(target, debuggerNativeCharacterTabExpression()).catch((error) => ({
    ok: false,
    error: String(error?.message || error || "native_character_tab_scan_failed")
  }));
  if (!tab?.ok || !tab.rect) return tab;
  await debuggerClick(target, pointFromRect(tab.rect));
  await sleep(350);
  return tab;
}

function debuggerNativeCharacterSearchBoxExpression() {
  return `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const rectOf = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const dialog = Array.from(document.querySelectorAll("[role='dialog']")).filter(visible)[0] || null;
    if (!dialog) return { ok: false, error: "native_character_picker_not_found" };
    const search = Array.from(dialog.querySelectorAll("input,[role='searchbox'],[contenteditable='true']"))
      .filter(visible)
      .map((node) => ({ node, rect: rectOf(node) }))
      .sort((a, b) => a.rect.y - b.rect.y)[0];
    return search ? { ok: true, rect: search.rect } : { ok: false, error: "native_character_search_not_found" };
  })()`;
}

async function debuggerFocusNativeCharacterSearchBox(target) {
  const search = await debuggerEvaluate(target, debuggerNativeCharacterSearchBoxExpression()).catch((error) => ({
    ok: false,
    error: String(error?.message || error || "native_character_search_scan_failed")
  }));
  if (!search?.ok || !search.rect) return search;
  await debuggerClick(target, pointFromRect(search.rect));
  await sleep(120);
  return search;
}

async function debuggerWaitForNativeCharacterSearchBox(target, timeoutMs = 2500) {
  const deadline = Date.now() + Math.max(500, Number(timeoutMs || 2500));
  let last = null;
  while (Date.now() < deadline) {
    last = await debuggerFocusNativeCharacterSearchBox(target);
    if (last?.ok) return last;
    await sleep(120);
  }
  return last || { ok: false, error: "native_character_picker_not_found" };
}

function debuggerNativeCharacterPickerOptionExpression(displayName = "") {
  return `((displayName) => {
    const normalize = (value = "") => String(value || "")
      .trim()
      .toLowerCase()
      .replace(/^@+/, "")
      .replace(/[_-]+/g, " ")
      .replace(/[\\s\\u00a0]+/g, " ");
    const expected = normalize(displayName);
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const rectOf = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const textOf = (element) => String(element?.innerText || element?.textContent || element?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim();
    const dialog = Array.from(document.querySelectorAll("[role='dialog']")).filter(visible)[0] || document;
    const addToPromptVisible = Array.from(dialog.querySelectorAll("button,[role='button']"))
      .filter(visible)
      .some((node) => /add\\s*to\\s*prompt/i.test(textOf(node)));
    const rows = Array.from(dialog.querySelectorAll("[role='option'],[role='menuitem'],[role='button'],[cmdk-item],button,[data-radix-collection-item],li,a[href*='/character/']"))
      .filter(visible)
      .filter((node) => !node.closest("[data-slate-editor='true']"))
      .filter((node) => !/add\\s*to\\s*prompt/i.test(textOf(node)))
      .map((node) => {
        const text = textOf(node);
        const images = Array.from(node.querySelectorAll?.("img") || []).map((img) => ({
          alt: img.getAttribute("alt") || "",
          src: img.currentSrc || img.src || ""
        }));
        const altText = images.map((img) => img.alt || "").join(" ");
        const attrText = [
          node.getAttribute("aria-label") || "",
          node.getAttribute("title") || "",
          node.getAttribute("data-testid") || "",
          node.getAttribute("href") || "",
          node.closest?.("a[href*='/character/']")?.getAttribute("href") || "",
          node.querySelector?.("a[href*='/character/']")?.getAttribute("href") || ""
        ].join(" ");
        const normalizedText = normalize(text);
        const normalizedAlt = normalize(altText);
        const normalizedAttr = normalize(attrText);
        const exact = normalizedText === expected || normalizedAlt === expected;
        const contains = normalizedText.includes(expected) || normalizedAlt.includes(expected) || normalizedAttr.includes(expected);
        const role = node.getAttribute("role") || "";
        const rect = rectOf(node);
        const hasCharacterHref = /\\/character\\/[0-9a-f-]{8}-[0-9a-f-]{27,}/i.test(attrText);
        const characterLike = hasCharacterHref || /character|person|accessibility_new/i.test([text, altText, attrText, role].join(" "));
        const imageLike = !characterLike && (images.length > 0 || /image|photo|media|getMediaUrlRedirect/i.test([text, altText, attrText].join(" ")));
        const rowKind = characterLike ? "character" : imageLike ? "image" : "unknown";
        const score = (characterLike ? 100000 : 0) + (exact ? 10000 : 0) + (contains ? 1000 : 0) + (/option|menuitem/i.test(role) ? 200 : 0) + Math.max(0, 900 - rect.y);
        return { text, altText, images, role, rect, score, exact, contains, characterLike, imageLike, rowKind, hasCharacterHref };
      });
    const candidates = rows
      .filter((item) => item.exact || item.contains)
      .sort((a, b) => b.score - a.score);
    const characterCandidates = candidates.filter((item) => item.characterLike);
    const imageOnlyCandidates = candidates.filter((item) => item.imageLike && !item.characterLike);
    const best = characterCandidates[0] || null;
    const pickerVisible = Array.from(document.querySelectorAll("[role='listbox'],[role='menu'],[cmdk-list],[data-radix-popper-content-wrapper]"))
      .some(visible);
    const rowTextSamples = rows.slice(0, 8).map(({ text, altText, role, characterLike, imageLike, rowKind }) => ({ text, altText, role, characterLike, imageLike, rowKind }));
    const pickerRowImageCharacterSamples = rows
      .filter((row) => row.characterLike || row.images.length)
      .slice(0, 8)
      .map(({ text, altText, images, role, characterLike, imageLike, rowKind, hasCharacterHref }) => ({
        text,
        altText,
        role,
        characterLike,
        imageLike,
        rowKind,
        hasCharacterHref,
        imageAlts: images.map((img) => img.alt).filter(Boolean).slice(0, 4),
        imageSrcHints: images.map((img) => img.src).filter(Boolean).slice(0, 2)
      }));
    return best
      ? {
          ok: true,
          pickerVisible,
          pickerOpened: pickerVisible,
          pickerRowsVisible: rows.length,
          selectedOptionText: best.text || best.altText || "",
          addToPromptVisible,
          characterRowCount: characterCandidates.length,
          imageRowMatchCount: imageOnlyCandidates.length,
          selectedRowKind: best.rowKind,
          rowTextSamples,
          pickerRowTextSamples: rowTextSamples,
          pickerRowImageCharacterSamples,
          ...best,
          sample: candidates.slice(0, 5).map(({ text, altText, role, score, characterLike, imageLike, rowKind, hasCharacterHref }) => ({ text, altText, role, score, characterLike, imageLike, rowKind, hasCharacterHref }))
        }
      : {
          ok: false,
          pickerVisible,
          pickerOpened: pickerVisible,
          pickerRowsVisible: rows.length,
          selectedOptionText: "",
          addToPromptVisible,
          characterRowCount: characterCandidates.length,
          imageRowMatchCount: imageOnlyCandidates.length,
          selectedRowKind: imageOnlyCandidates.length ? "image" : "",
          rowTextSamples,
          pickerRowTextSamples: rowTextSamples,
          pickerRowImageCharacterSamples,
          error: pickerVisible
            ? (imageOnlyCandidates.length ? "character_picker_image_row_only" : "character_picker_character_row_not_found")
            : "native_character_picker_not_found"
        };
  })(${JSON.stringify(String(displayName || ""))})`;
}

async function debuggerCollectNativeCharacterPickerDiagnostics(target, displayName = "", searchTerm = "", extra = {}) {
  const option = await debuggerEvaluate(target, debuggerNativeCharacterPickerOptionExpression(displayName)).catch((error) => ({
    ok: false,
    error: String(error?.message || error || "native_character_picker_scan_failed")
  }));
  return {
    pickerOpened: Boolean(option?.pickerOpened || option?.pickerVisible),
    nativePickerOpened: Boolean(option?.pickerOpened || option?.pickerVisible),
    searchTermUsed: String(searchTerm || displayName || ""),
    nativePickerSearchTermUsed: String(searchTerm || displayName || ""),
    pickerRowsVisible: Number(option?.pickerRowsVisible || 0),
    pickerRowTextSamples: option?.pickerRowTextSamples || option?.rowTextSamples || [],
    pickerRowImageCharacterSamples: option?.pickerRowImageCharacterSamples || [],
    selectedOptionText: option?.selectedOptionText || option?.text || option?.altText || "",
    characterRowCount: Number(option?.characterRowCount || 0),
    imageRowMatchCount: Number(option?.imageRowMatchCount || 0),
    selectedRowKind: option?.selectedRowKind || option?.rowKind || "",
    addToPromptVisible: Boolean(option?.addToPromptVisible),
    optionError: option?.error || "",
    optionOk: Boolean(option?.ok),
    ...extra
  };
}

function debuggerNativeCharacterAddToPromptExpression() {
  return `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const rectOf = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const textOf = (element) => String(element?.innerText || element?.textContent || element?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim();
    const dialog = Array.from(document.querySelectorAll("[role='dialog']")).filter(visible)[0] || null;
    if (!dialog) return { ok: false, error: "native_character_picker_not_found" };
    const dialogRect = rectOf(dialog);
    const candidates = Array.from(dialog.querySelectorAll("button,[role='button']"))
      .filter(visible)
      .map((node) => {
        const rect = rectOf(node);
        const text = textOf(node);
        const bottomScore = Math.max(0, rect.y - dialogRect.y);
        const score = (rect.width > 180 ? 1000 : 0) + (/add\\s*to\\s*prompt/i.test(text) ? 10000 : 0) + bottomScore;
        return { text, rect, score };
      })
      .filter((item) => item.rect.y > dialogRect.y + dialogRect.height * 0.55 || /add\\s*to\\s*prompt/i.test(item.text))
      .sort((a, b) => b.score - a.score);
    return candidates[0] ? { ok: true, ...candidates[0] } : { ok: false, error: "native_character_add_to_prompt_not_found" };
  })()`;
}

async function debuggerClickNativeCharacterAddToPrompt(target) {
  const button = await debuggerEvaluate(target, debuggerNativeCharacterAddToPromptExpression()).catch((error) => ({
    ok: false,
    error: String(error?.message || error || "native_character_add_to_prompt_scan_failed")
  }));
  if (!button?.ok || !button.rect) return button;
  await debuggerClick(target, pointFromRect(button.rect));
  await sleep(700);
  return button;
}

async function debuggerFindNativeCharacterPickerOption(target, displayName = "", timeoutMs = 3500) {
  const deadline = Date.now() + Math.max(500, Number(timeoutMs || 3500));
  let last = null;
  while (Date.now() < deadline) {
    last = await debuggerEvaluate(target, debuggerNativeCharacterPickerOptionExpression(displayName)).catch((error) => ({
      ok: false,
      error: String(error?.message || error || "native_character_picker_scan_failed")
    }));
    if (last?.ok && last.rect) return last;
    await sleep(180);
  }
  return last || { ok: false, error: "native_character_option_not_found" };
}

async function debuggerInsertNativeCharacterChipsWithPathC({ target, tabId, task = {}, sendPageCommand, trace, reason = "" } = {}) {
  const recordPathCTrace = typeof trace === "function" ? trace : () => {};
  const explicitHandleMap = debuggerNativeCharacterHandleMap(task);
  const handleMap = debuggerNativeCharacterHandleMap(task, { includePromptFallback: true });
  const handles = debuggerNativeCharacterHandlesFromPrompt(task.prompt || "")
    .map((entry) => ({ ...entry, ...(handleMap[entry.normalizedHandle] || {}) }));
  const handlesRequested = handles.map((entry) => `@${entry.handle}`);
  const normalizedHandles = handles.map((entry) => entry.normalizedHandle).filter(Boolean);
  const explicitHandleMapKeys = Object.keys(explicitHandleMap).sort();
  const includePromptFallbackResult = Object.fromEntries(
    Object.entries(handleMap).map(([key, entry]) => [key, {
      handle: entry.handle || key,
      displayName: entry.displayName || "",
      source: entry.source || "",
      hasCharacterServerId: Boolean(entry.characterServerId)
    }])
  );
  const missingNativeCharacterMappings = handles
    .filter((entry) => !explicitHandleMap[entry.normalizedHandle])
    .map((entry) => `@${entry.handle}`);
  const captureSteps = [];
  const characterAvailabilityPreflight = {
    ok: false,
    status: missingNativeCharacterMappings.length ? "character_setup_required" : "character_creation_not_started",
    handlesRequested,
    normalizedHandles,
    explicitHandleMapKeys,
    includePromptFallback: true,
    includePromptFallbackResult,
    missingNativeCharacterMappings,
    usingNativePickerResolution: missingNativeCharacterMappings.length > 0,
    requiredCharactersMissing: [],
    verifiedMappings: [],
    steps: captureSteps
  };
  const baseDiagnostics = () => ({
    handlesRequested,
    normalizedHandles,
    explicitHandleMapKeys,
    includePromptFallback: true,
    includePromptFallbackResult,
    missingNativeCharacterMappings,
    characterAvailabilityPreflight
  });
  const failPathCPreflight = (error, data = {}) => {
    characterAvailabilityPreflight.ok = false;
    characterAvailabilityPreflight.error = error;
    characterAvailabilityPreflight.status = data.status || (
      error === "character_picker_image_row_only"
        ? "character_picker_image_row_only"
        : error === "character_picker_character_row_not_found" || error === "path_c_character_not_found_in_project"
          ? "character_not_available_in_picker"
          : error === "character_chip_missing_characterServerId"
            ? "character_chip_missing_characterServerId"
            : characterAvailabilityPreflight.status || "character_setup_required"
    );
    recordPathCTrace(task, "native_character_availability_preflight", {
      ok: false,
      error,
      ...baseDiagnostics()
    });
    return {
      ok: false,
      error,
      data: {
        ...baseDiagnostics(),
        captureSteps,
        ...data
      },
      nativeCharacterPathC: {
        ...baseDiagnostics(),
        captureSteps,
        ...data
      },
      commit: { method: "pathC.beforeinput.nativeCharacterChips" }
    };
  };
  if (!handles.length) {
    return failPathCPreflight("path_c_unresolved_handle");
  }
  const unresolvedHandles = handles
    .filter((entry) => !handleMap[entry.normalizedHandle])
    .map((entry) => `@${entry.handle}`);
  if (unresolvedHandles.length) {
    return failPathCPreflight("path_c_unresolved_handle", {
      unresolvedHandles,
      handlesResolved: handles.filter((entry) => handleMap[entry.normalizedHandle]).map((entry) => `@${entry.handle}`),
    });
  }
  recordPathCTrace(task, "native_character_path_c_mapping_preflight", {
    handlesRequested,
    normalizedHandles,
    explicitHandleMapKeys,
    includePromptFallback: true,
    includePromptFallbackResult,
    handlesWithExplicitMappings: handles.filter((entry) => explicitHandleMap[entry.normalizedHandle]).map((entry) => `@${entry.handle}`),
    missingNativeCharacterMappings,
    usingNativePickerResolution: missingNativeCharacterMappings.length > 0
  });
  let cachedFragmentProbe = null;
  const cachedFragmentInsertAttempted = missingNativeCharacterMappings.length === 0;
  if (!missingNativeCharacterMappings.length) {
    const cachedInsertMessage = await sendPageCommand({
      action: "domInsertNativeCharacterChipsFromHandles",
      task,
      promptText: task.prompt || "",
      handleMap,
      fragments: {},
      mode: task.mode || "",
      timeoutMs: 120000
    }, tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "path_c_cached_fragment_insert_failed") }));
    const cachedInserted = cachedInsertMessage?.result?.result || cachedInsertMessage?.result || cachedInsertMessage;
    cachedFragmentProbe = {
      ok: Boolean(cachedInserted?.ok),
      error: cachedInserted?.error || "",
      handlesRequested: cachedInserted?.handlesRequested || handlesRequested,
      handlesResolved: cachedInserted?.handlesResolved || [],
      unresolvedHandles: cachedInserted?.unresolvedHandles || [],
      nativeChipCountAfter: cachedInserted?.nativeChipCountAfter ?? null,
      visibleChipLabels: cachedInserted?.visibleChipLabels || []
    };
    recordPathCTrace(task, "native_character_path_c_cached_fragment_insert_result", cachedFragmentProbe);
    if (cachedInserted?.ok) {
      characterAvailabilityPreflight.ok = true;
      characterAvailabilityPreflight.error = "";
      characterAvailabilityPreflight.status = "character_mapping_ready";
      characterAvailabilityPreflight.verifiedMappings = handles.map((entry) => ({
        handle: `@${entry.handle}`,
        displayName: entry.displayName || entry.handle,
        source: "cached_fragment"
      }));
      return {
        ok: true,
        error: "",
        reason,
        editorRect: cachedInserted?.editorRect || null,
        createRect: cachedInserted?.createRect || null,
        createButton: cachedInserted?.createButton || null,
        commit: {
          ...(cachedInserted?.commit || {}),
          method: "pathC.beforeinput.nativeCharacterChips",
          persisted: cachedInserted?.commit?.persisted || cachedInserted?.persisted || ""
        },
        nativeCharacterPathC: {
          ...(cachedInserted || {}),
          captureSteps,
          missingNativeCharacterMappings,
          cachedFragmentReused: true,
          ...baseDiagnostics()
        },
        data: {
          ...(cachedInserted || {}),
          captureSteps,
          missingNativeCharacterMappings,
          cachedFragmentReused: true,
          ...baseDiagnostics()
        }
      };
    }
  }
  const fragments = {};
  for (let handleIndex = 0; handleIndex < handles.length; handleIndex += 1) {
    const entry = handles[handleIndex];
    const step = {
      handle: entry.handle,
      normalizedHandle: entry.normalizedHandle,
      displayName: entry.displayName,
      explicitMappingPresent: Boolean(explicitHandleMap[entry.normalizedHandle]),
      mappingSource: entry.source || "",
      searchTermsTried: [],
      ok: false
    };
    captureSteps.push(step);
    await debuggerSend(target, "Page.bringToFront").catch(() => {});
    const pickerOpenPreflight = await debuggerPathCPickerOpenPreflightSnapshot(target, task, handles, explicitHandleMap, {
      hasCachedFragment: Boolean(cachedFragmentProbe?.ok),
      cachedFragmentInsertAttempted,
      cachedFragmentInsertResult: cachedFragmentProbe,
      needsPickerCapture: true,
      cachedFragmentProbe,
      failurePhase: "before_path_c_picker_open"
    });
    recordPathCTrace(task, "path_c_picker_open_preflight", pickerOpenPreflight);
    const prepareMessage = await sendPageCommand({
      action: "domPrepareNativeCharacterPickerCapture",
      task,
      handle: entry.handle,
      displayName: entry.displayName,
      timeoutMs: 10000
    }, tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "native_character_picker_prepare_failed") }));
    const prepared = prepareMessage?.result?.result || prepareMessage?.result || prepareMessage;
    if (!prepared?.ok || !prepared.editorRect) {
      const error = "path_c_picker_open_failed";
      step.error = error;
      step.prepareError = prepared?.error || "";
      recordPathCTrace(task, "path_c_picker_open_failure", {
        error,
        prepared,
        pickerOpenPreflight
      });
      return failPathCPreflight(error, { prepared });
    }
    const point = pointFromRect(prepared.editorRect);
    await debuggerClick(target, point);
    await sleep(140);
    await debuggerPressNativeAtSign(target);
    const searchReady = await debuggerWaitForNativeCharacterSearchBox(target, 3500);
    if (!searchReady?.ok) {
      const pickerDiagnostics = await debuggerCollectNativeCharacterPickerDiagnostics(target, entry.displayName || entry.handle, "", { searchReady });
      const error = pickerDiagnostics.pickerOpened ? "path_c_picker_search_failed" : "path_c_picker_open_failed";
      Object.assign(step, pickerDiagnostics, { ok: false, error });
      recordPathCTrace(task, "path_c_picker_open_failure", {
        error,
        searchReady,
        pickerDiagnostics,
        pickerOpenPreflight
      });
      return failPathCPreflight(error, { searchReady, pickerDiagnostics });
    }
    step.pickerOpened = true;
    step.searchReady = searchReady;
    await debuggerClearActiveTextInput(target);
    const characterTab = await debuggerClickNativeCharacterTab(target);
    if (!characterTab?.ok) {
      const pickerDiagnostics = await debuggerCollectNativeCharacterPickerDiagnostics(target, entry.displayName || entry.handle, "", { characterTab });
      const error = "path_c_picker_open_failed";
      Object.assign(step, pickerDiagnostics, { ok: false, error });
      recordPathCTrace(task, "path_c_picker_open_failure", {
        error,
        characterTab,
        pickerDiagnostics,
        pickerOpenPreflight
      });
      return failPathCPreflight(error, { characterTab, pickerDiagnostics });
    }
    step.characterTab = characterTab;
    let option = await debuggerFindNativeCharacterPickerOption(target, entry.displayName || entry.handle, 1200);
    let searchTermUsed = "";
    if (!option?.ok) {
      await debuggerFocusNativeCharacterSearchBox(target);
      await debuggerClearActiveTextInput(target);
      searchTermUsed = entry.displayName || entry.handle;
      step.searchTermsTried.push(searchTermUsed);
      await debuggerTypeNativeText(target, searchTermUsed);
      await sleep(520);
      option = await debuggerFindNativeCharacterPickerOption(target, searchTermUsed, 4500);
    }
    if (!option?.ok && entry.displayName !== entry.handle) {
      await debuggerFocusNativeCharacterSearchBox(target);
      await debuggerClearActiveTextInput(target);
      searchTermUsed = entry.handle;
      step.searchTermsTried.push(searchTermUsed);
      await debuggerTypeNativeText(target, searchTermUsed);
      await sleep(520);
      option = await debuggerFindNativeCharacterPickerOption(target, entry.handle, 2200);
    }
    const pickerDiagnostics = await debuggerCollectNativeCharacterPickerDiagnostics(
      target,
      option?.ok ? (option.text || option.altText || entry.displayName || entry.handle) : (entry.displayName || entry.handle),
      searchTermUsed || entry.displayName || entry.handle,
      { option }
    );
    Object.assign(step, pickerDiagnostics);
    if (!option?.ok || !option.rect) {
      const error = pickerDiagnostics.pickerOpened
        ? (pickerDiagnostics.optionError === "character_picker_image_row_only" ? "character_picker_image_row_only" : "character_picker_character_row_not_found")
        : "path_c_picker_open_failed";
      step.ok = false;
      step.error = error;
      step.option = option;
      if (error === "character_picker_character_row_not_found" || error === "character_picker_image_row_only") {
        characterAvailabilityPreflight.requiredCharactersMissing.push(`@${entry.handle}`);
      }
      recordPathCTrace(task, "path_c_picker_open_failure", {
        error,
        option,
        pickerDiagnostics,
        pickerOpenPreflight
      });
      return failPathCPreflight(error, { option, pickerDiagnostics });
    }
    step.selectedOptionText = option.selectedOptionText || option.text || option.altText || "";
    await debuggerClick(target, pointFromRect(option.rect));
    await sleep(350);
    const addToPromptProbe = await debuggerEvaluate(target, debuggerNativeCharacterAddToPromptExpression()).catch((error) => ({
      ok: false,
      error: String(error?.message || error || "native_character_add_to_prompt_scan_failed")
    }));
    step.addToPromptVisible = Boolean(addToPromptProbe?.ok);
    const addToPrompt = addToPromptProbe?.ok && addToPromptProbe.rect
      ? await debuggerClick(target, pointFromRect(addToPromptProbe.rect))
        .then(async () => {
          await sleep(700);
          return addToPromptProbe;
        })
        .catch((error) => ({
          ...addToPromptProbe,
          ok: false,
          error: String(error?.message || error || "native_character_add_to_prompt_click_failed")
        }))
      : addToPromptProbe;
    const directRowInsertCandidate = !addToPrompt?.ok;
    const captureMessage = await sendPageCommand({
      action: "domCaptureNativeCharacterChipFragment",
      task,
      handle: entry.handle,
      normalizedHandle: entry.normalizedHandle,
      displayName: entry.displayName,
      timeoutMs: 15000
    }, tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "native_character_fragment_capture_failed") }));
    const capture = captureMessage?.result?.result || captureMessage?.result || captureMessage;
    Object.assign(step, {
      ok: Boolean(capture?.ok),
      error: capture?.error || "",
      nativePickerInsertMethod: directRowInsertCandidate ? "row_click_direct_insert" : "add_to_prompt",
      addToPromptOk: Boolean(addToPrompt?.ok),
      addToPromptError: addToPrompt?.error || "",
      visibleNativeChipCountAfterPicker: Number(capture?.nativeChipCountAfter || 0),
      nativeChipCountAfterPicker: Number(capture?.nativeChipCountAfter || 0),
      visibleChipLabels: capture?.visibleChipLabels || [],
      recopyAtTagCount: Number(capture?.recopyAtTagProof?.atTagCount || capture?.fragment?.atTagCount || 0),
      redactedCharacterServerIdHashes: capture?.redactedCharacterServerIdHashes || []
    });
    if (!capture?.ok || !capture.fragment?.slateFragment) {
      const recopyTags = Array.isArray(capture?.recopyAtTagProof?.atTags) ? capture.recopyAtTagProof.atTags : [];
      const missingCharacterServerId = recopyTags.length > 0 && recopyTags.some((tag) => tag?.hasCharacterServerId !== true && !String(tag?.characterServerIdHash || "").trim());
      const error = missingCharacterServerId
        ? "character_chip_missing_characterServerId"
        : pickerDiagnostics.optionError === "character_picker_image_row_only"
          ? "character_picker_image_row_only"
          : capture?.error === "path_c_chip_recopy_failed" || capture?.recopyAtTagProof?.ok === false
            ? "path_c_chip_recopy_failed"
            : "path_c_chip_insert_failed";
      step.ok = false;
      step.error = error;
      return failPathCPreflight(error, { option, addToPrompt, capture, pickerDiagnostics });
    }
    characterAvailabilityPreflight.verifiedMappings.push({
      handle: `@${entry.handle}`,
      displayName: capture.displayName || entry.displayName || entry.handle,
      selectedOptionText: step.selectedOptionText || "",
      selectedRowKind: step.selectedRowKind || "",
      redactedCharacterServerIdHashes: capture.redactedCharacterServerIdHashes || [],
      recopyAtTagCount: Number(capture?.recopyAtTagProof?.atTagCount || capture?.fragment?.atTagCount || 0)
    });
    fragments[entry.normalizedHandle] = capture.fragment;
    recordPathCTrace(task, "native_character_picker_fragment_captured", {
      handle: entry.handle,
      normalizedHandle: entry.normalizedHandle,
      displayName: entry.displayName,
      searchTermUsed: step.searchTermUsed || step.nativePickerSearchTermUsed || "",
      selectedOptionText: step.selectedOptionText || "",
      addToPromptVisible: Boolean(step.addToPromptVisible),
      visibleNativeChipCountAfterPicker: step.visibleNativeChipCountAfterPicker,
      visibleChipLabels: capture.visibleChipLabels || [],
      recopyAtTagCount: Number(capture?.recopyAtTagProof?.atTagCount || capture?.fragment?.atTagCount || 0),
      redactedCharacterServerIdHashes: capture.redactedCharacterServerIdHashes || []
    });
    if (handleIndex < handles.length - 1) {
      const reload = await debuggerSend(target, "Page.reload", { ignoreCache: false })
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, error: String(error?.message || error || "native_character_picker_state_reload_failed") }));
      recordPathCTrace(task, "native_character_picker_state_reload_between_handles", {
        ok: Boolean(reload.ok),
        error: reload.error || "",
        handle: entry.handle,
        nextHandle: handles[handleIndex + 1]?.handle || ""
      });
      if (!reload.ok) {
        return failPathCPreflight(reload.error || "native_character_picker_state_reload_failed", { reload });
      }
      await sleep(5500);
    }
  }
  characterAvailabilityPreflight.ok = true;
  characterAvailabilityPreflight.error = "";
  characterAvailabilityPreflight.status = "character_mapping_ready";
  recordPathCTrace(task, "native_character_availability_preflight", {
    ok: true,
    error: "",
    ...baseDiagnostics()
  });
  const insertMessage = await sendPageCommand({
    action: "domInsertNativeCharacterChipsFromHandles",
    task,
    promptText: task.prompt || "",
    handleMap,
    fragments,
    mode: task.mode || "",
    timeoutMs: 120000
  }, tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "path_c_beforeinput_replay_failed") }));
  const inserted = insertMessage?.result?.result || insertMessage?.result || insertMessage;
  recordPathCTrace(task, "native_character_path_c_insert_result", {
    ok: Boolean(inserted?.ok),
    error: inserted?.error || "",
    handlesRequested: inserted?.handlesRequested || [],
    handlesResolved: inserted?.handlesResolved || [],
    unresolvedHandles: inserted?.unresolvedHandles || [],
    pickerInsertions: inserted?.pickerInsertions ?? handles.length,
    pathCInsertions: inserted?.pathCInsertions || 0,
    nativeChipCountBefore: inserted?.nativeChipCountBefore ?? null,
    nativeChipCountAfter: inserted?.nativeChipCountAfter ?? null,
    visibleChipLabels: inserted?.visibleChipLabels || [],
    redactedCharacterServerIdHashes: inserted?.redactedCharacterServerIdHashes || [],
    preSubmitChipProof: inserted?.preSubmitChipProof || null,
    characterAvailabilityPreflight
  });
  return {
    ok: Boolean(inserted?.ok),
    error: inserted?.ok ? "" : (inserted?.error || "path_c_beforeinput_replay_failed"),
    reason,
    editorRect: inserted?.editorRect || null,
    createRect: inserted?.createRect || null,
    createButton: inserted?.createButton || null,
    commit: {
      ...(inserted?.commit || {}),
      method: "pathC.beforeinput.nativeCharacterChips",
      persisted: inserted?.commit?.persisted || inserted?.persisted || ""
    },
    nativeCharacterPathC: {
      ...(inserted || {}),
      captureSteps,
      missingNativeCharacterMappings,
      ...baseDiagnostics()
    },
    data: {
      ...(inserted || {}),
      captureSteps,
      missingNativeCharacterMappings,
      ...baseDiagnostics()
    }
  };
}

async function debuggerEvaluate(target, expression) {
  const result = await debuggerSend(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  return result?.result?.value;
}

function debuggerShouldBringToFront(meta = {}, task = {}) {
  return meta?.bringToFront === true
    || meta?.allowBringToFront === true
    || String(task.mode || "") === "text-to-video";
}

function debuggerModelPatternForTask(task = {}) {
  const mode = String(task.mode || "");
  const raw = String(task.model || "default").trim();
  if (mode === "text-to-image") {
    if (raw === "nano_banana_2") return { source: "Nano\\s+Banana\\s+2", flags: "i" };
    if (raw === "imagen_4" || raw.includes("imagen")) return { source: "Imagen\\s+4", flags: "i" };
    return { source: "Nano\\s+Banana\\s+Pro", flags: "i" };
  }
  if (/^(omni_flash|omni|abra)$/i.test(raw)) return { source: "^Omni\\s+Flash$", flags: "i" };
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

function debuggerFallbackModelPatternForTask(task = {}) {
  const mode = String(task.mode || "");
  const raw = String(task.model || "default").trim();
  if (
    mode === "ingredients-to-video" &&
    (raw === "default" || raw === "veo3_fast_low" || raw.includes("fast_low") || raw.includes("lower"))
  ) {
    return { source: "^Veo 3\\.1\\s*-\\s*Fast$", flags: "i" };
  }
  if (mode.includes("video") && /veo3?_fast|veo_3_1.*fast/i.test(raw)) {
    return { source: "Veo 3\\.1\\s*-\\s*Lite\\s*\\[Lower Priority\\]", flags: "i" };
  }
  return null;
}

function debuggerAcceptsCurrentVideoModelFallback(task = {}, normalizedCurrent = "") {
  const requested = String(task.model || "default").trim();
  if (!String(task.mode || "").includes("video")) return false;
  const fallbackPattern = debuggerFallbackModelPatternForTask(task);
  if (fallbackPattern && new RegExp(fallbackPattern.source, fallbackPattern.flags).test(String(normalizedCurrent || ""))) return true;
  if (!/default|veo3?_fast|veo_3_1.*fast/i.test(requested)) return false;
  return /Veo\s+3\.1\s*-\s*(Fast|Lite)\b(?:\s*\[Lower Priority\])?/i.test(String(normalizedCurrent || ""));
}

function debuggerModelKeyFromVisibleLabel(label = "") {
  const text = String(label || "");
  if (/Omni\s+Flash/i.test(text)) return "omni_flash";
  if (/Veo\s+3\.1\s*-\s*Quality\b/i.test(text)) return "veo3_quality";
  if (/Veo\s+3\.1\s*-\s*Fast\b/i.test(text)) {
    return /\[Lower Priority\]/i.test(text) ? "veo3_fast_low" : "veo3_fast";
  }
  if (/Veo\s+3\.1\s*-\s*Lite\b/i.test(text)) {
    return /\[Lower Priority\]/i.test(text) ? "veo3_lite_low" : "veo3_lite";
  }
  return "";
}

function debuggerAspectForTask(task = {}) {
  const raw = String(task.aspectRatio || "").trim().toLowerCase();
  if (raw === "portrait" || raw === "portrait_3_4" || raw === "9:16") return "PORTRAIT";
  if (raw === "square" || raw === "1:1") return "SQUARE";
  return "LANDSCAPE";
}

function debuggerDurationForTask(task = {}) {
  if (String(task.mode || "") === "ingredients-to-video" && !/^(omni_flash|omni|abra)$/i.test(String(task.model || ""))) return "8";
  const raw = String(task.videoLength || task.videoDurationSeconds || "8").trim();
  return raw === "4" || raw === "6" || raw === "8" || raw === "10" ? raw : "8";
}

function debuggerProjectIdFromUrl(url = "") {
  return String(url || "").match(/\/project\/([0-9a-f-]{36})/i)?.[1] || "";
}

function debuggerProjectRootUrlFromUrl(url = "", projectId = "") {
  const id = String(projectId || debuggerProjectIdFromUrl(url) || "").trim();
  return id ? `https://labs.google/fx/tools/flow/project/${id}` : "";
}

function expectedVideoRepeat(task = {}) {
  return Math.max(1, Math.min(4, Number.parseInt(task.repeatCount, 10) || 1));
}

function shouldValidateDebuggerStoreModelKeys(task = {}) {
  return String(task.mode || "") !== "ingredients-to-video" || /^(omni_flash|omni|abra)$/i.test(String(task.model || ""));
}

function debuggerPreparedHasNativeFrameSlotProof(prepared = {}) {
  const candidates = [
    prepared?.attachOutcome?.preSubmitRefs,
    prepared?.preSubmitRefs,
    prepared?.trace?.attachOutcome?.preSubmitRefs,
    prepared?.data?.attachOutcome?.preSubmitRefs
  ];
  return candidates.some((candidate) => candidate?.nativeFrameSlotProof === true);
}

function debuggerPreparedWithNativeFrameSlotProof(candidate = {}, proofSource = {}, task = {}) {
  const mode = String(task.mode || "");
  if (mode !== "image-to-video" && mode !== "start-end-image-to-video") return candidate;
  if (debuggerPreparedHasNativeFrameSlotProof(candidate) || !debuggerPreparedHasNativeFrameSlotProof(proofSource)) return candidate;
  return {
    ...candidate,
    attachOutcome: candidate?.attachOutcome?.preSubmitRefs ? candidate.attachOutcome : proofSource?.attachOutcome
  };
}

function debuggerExpectedVideoModelKeyForSelectedVisibleModel(task = {}, selectedModel = "") {
  const model = String(selectedModel || "").trim();
  if (!model) return "";
  const mode = String(task.mode || "");
  const aspectRatio = task.aspectRatio || "landscape";
  const duration = task.videoLength || task.videoDurationSeconds || "8";
  const hasEndImage = Boolean(
    task.endMediaId ||
    task.endRefInput ||
    (Array.isArray(task.refInputs) && task.refInputs.some((ref) => String(ref?.role || "") === "endFrameRef"))
  );
  if (mode === "text-to-video") {
    return normalizeVideoModelKey("t2v", model, aspectRatio, { duration });
  }
  if (mode === "image-to-video") {
    return normalizeVideoModelKey("i2v", model, aspectRatio, { duration, hasEndImage });
  }
  if (mode === "start-end-image-to-video") {
    return normalizeVideoModelKey("i2v", model, aspectRatio, { duration, hasEndImage: true });
  }
  if (mode === "ingredients-to-video" && /^(omni_flash|omni|abra)$/i.test(model)) {
    return normalizeVideoModelKey("r2v", model, aspectRatio, { duration });
  }
  return "";
}

function debuggerPreparedSettingsProblems(prepared = {}, task = {}, settings = {}) {
  const mode = String(task.mode || "");
  if (!mode || mode === "text-to-image") return [];
  const expected = prepared?.expected || {};
  const store = prepared?.store || prepared?.trace?.store || {};
  const expectedKeys = expected?.storeModelKeys || {};
  const actualKeys = store?.currentModelKeys || {};
  const visible = prepared?.visible || prepared?.trace?.visible || {};
  const selectedVisibleModelKey = debuggerExpectedVideoModelKeyForSelectedVisibleModel(task, settings?.model || "");
  const expectedDuration = String(expected.duration || debuggerDurationForTask(task));
  const problems = debuggerVisibleVideoTriggerProblems(task, visible, {
    store,
    expectedVisibleMode: expected.visibleMode || debuggerVisibleModeForTask(task),
    expectedDuration
  });
  if (
    expected.visibleMode
    && String(store.mode || "") !== String(expected.visibleMode || "")
    && !debuggerAcceptsStickyT2vSubMode(prepared, task)
  ) {
    problems.push(`mode:${String(store.mode || "") || "missing"}!=${String(expected.visibleMode || "")}`);
  }
  if (mode !== "ingredients-to-video" || /^(omni_flash|omni|abra)$/i.test(String(task.model || ""))) {
    const actualDuration = store.selectedVideoDuration == null ? "" : String(store.selectedVideoDuration);
    const visibleDurationAccepted =
      debuggerShouldAvoidHiddenSettingsStoreRepair(task) &&
      String(settings?.duration || "") === expectedDuration;
    if ((!actualDuration || actualDuration !== expectedDuration) && !visibleDurationAccepted) {
      problems.push(`duration:${actualDuration || "missing"}!=${expectedDuration}`);
    }
  }
  const expectedRepeat = Number(expected.repeat || expectedVideoRepeat(task));
  const actualRepeat = Number(store.outputsPerPrompt || 0);
  if (actualRepeat !== expectedRepeat) {
    problems.push(`repeat:${store.outputsPerPrompt ?? "missing"}!=${expectedRepeat}`);
  }
  const collectionWorkflowId = debuggerPreparedCollectionWorkflowId(store);
  if (mode === "text-to-video" && collectionWorkflowId) {
    problems.push(`collectionWorkflowId:${collectionWorkflowId}!=empty`);
  }
  const nativeFrameSlotProof = debuggerPreparedHasNativeFrameSlotProof(prepared);
  const skipHiddenModelKeyValidation =
    nativeFrameSlotProof === true
    && (mode === "image-to-video" || mode === "start-end-image-to-video");
  if (shouldValidateDebuggerStoreModelKeys(task) && !skipHiddenModelKeyValidation) {
    if (expectedKeys.videoApi && String(actualKeys.videoApi || "") !== expectedKeys.videoApi) {
      problems.push(`videoApi:${String(actualKeys.videoApi || "") || "missing"}!=${expectedKeys.videoApi}`);
    }
    const actualVideoModelKey = String(actualKeys.videoModelKey || "");
    const acceptsSelectedVisibleModel =
      Boolean(selectedVisibleModelKey) &&
      actualVideoModelKey === selectedVisibleModelKey &&
      selectedVisibleModelKey !== expectedKeys.videoModelKey;
    if (expectedKeys.videoModelKey && actualVideoModelKey !== expectedKeys.videoModelKey && !acceptsSelectedVisibleModel) {
      problems.push(`videoModelKey:${String(actualKeys.videoModelKey || "") || "missing"}!=${expectedKeys.videoModelKey}`);
    }
  }
  return problems;
}

function debuggerAcceptsStickyT2vSubMode(prepared = {}, task = {}) {
  if (String(task.mode || "") !== "text-to-video") return false;
  const isOmni = debuggerIsOmniTextToVideo(task);
  const store = prepared?.store || prepared?.trace?.store || {};
  const storeMode = String(store.mode || "");
  if (storeMode !== "VIDEO_FRAMES" && storeMode !== "VIDEO_REFERENCES") return false;
  const keys = store.currentModelKeys || {};
  if (String(keys.videoApi || "") !== "batchAsyncGenerateVideoText") return false;
  if (debuggerPreparedCollectionWorkflowId(store)) return false;
  const ingredientCount = Array.isArray(store.ingredients)
    ? store.ingredients.length
    : Number(store.ingredientCount || 0);
  if (ingredientCount > 0) return false;
  const visible = prepared?.visible || prepared?.trace?.visible || {};
  if (isOmni) {
    const expectedKey = debuggerExpectedVideoModelKeyForSelectedVisibleModel(task, task.model || "omni_flash");
    if (expectedKey && String(keys.videoModelKey || "") !== expectedKey) return false;
    return debuggerVisibleVideoTriggerProblems(task, visible, {
      expectedDuration: debuggerDurationForTask(task)
    }).length === 0;
  }
  const triggerText = String(visible.settingsTriggerText || "");
  const selectedTabs = Array.isArray(visible.selectedModeTabs) ? visible.selectedModeTabs : [];
  return /\bVideo\b/i.test(triggerText)
    || selectedTabs.some((text) => /\bVideo\b/i.test(String(text || "")));
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
  const mode = String(task.mode || "");
  return mode === "image-to-video" || mode === "start-end-image-to-video";
}

function debuggerShouldReseatVisibleSettingsAfterAttach(task = {}) {
  return debuggerShouldAvoidHiddenSettingsStoreRepair(task) || debuggerIsOmniTextToVideo(task);
}

function debuggerShouldUsePageVisibleSettingsMutation(task = {}) {
  return String(task.mode || "") === "text-to-video";
}

function debuggerShouldForceNativeVisibleSettingsReseat(task = {}) {
  return debuggerIsOmniTextToVideo(task);
}

function debuggerShouldForceSelectedDurationClick(task = {}) {
  return debuggerShouldAvoidHiddenSettingsStoreRepair(task) || debuggerShouldForceNativeVisibleSettingsReseat(task);
}

function debuggerShouldFailClosedOnSettingsProblems(task = {}) {
  const mode = String(task.mode || "");
  return mode === "text-to-image" || debuggerIsOmniTextToVideo(task);
}

function debuggerShouldSubmitWithPromptEnter(task = {}) {
  return false;
}

function debuggerShouldNudgePromptWithNativeInput(task = {}) {
  return String(task.mode || "") === "text-to-video";
}

function debuggerPromptHasNativeCharacterSyntax(task = {}) {
  return /(^|\s)@[\s\u00a0]*[A-Za-z0-9_-]/.test(String(task.prompt || ""));
}

function debuggerShouldTypePromptWithNativeInput(task = {}) {
  return String(task.mode || "") === "text-to-video" && !debuggerPromptHasNativeCharacterSyntax(task);
}

function debuggerShouldFocusEditorBeforeSubmitClick(task = {}) {
  const mode = String(task.mode || "");
  return ["text-to-video", "image-to-video", "start-end-image-to-video", "ingredients-to-video"].includes(mode);
}

function debuggerShouldUsePathCNativeCharacterEntry(task = {}) {
  const mode = String(task.mode || "");
  if (!["text-to-video", "ingredients-to-video"].includes(mode)) return false;
  if (!debuggerPromptHasNativeCharacterSyntax(task)) return false;
  if (mode === "ingredients-to-video") return true;
  const handles = debuggerNativeCharacterHandlesFromPrompt(task.prompt || "");
  if (!handles.length) return false;
  const handleMap = debuggerNativeCharacterHandleMap(task);
  const characterPreflightActive = task?.characterPreflight?.active === true
    || (Array.isArray(task?.characterPreflight?.assets) && task.characterPreflight.assets.length > 0);
  if (characterPreflightActive) return true;
  return handles.some((entry) => Boolean(handleMap[entry.normalizedHandle]?.characterServerId));
}

function debuggerShouldReprepareBeforeNoRequestRetry(task = {}, frontTransition = {}) {
  const mode = String(task.mode || "");
  if (!["text-to-video", "image-to-video", "start-end-image-to-video", "ingredients-to-video"].includes(mode)) return false;
  if (
    (mode === "image-to-video" || mode === "start-end-image-to-video")
    && frontSubmitSnapshotIsVideoContinuationEditRoute(frontTransition?.snapshot || {})
  ) {
    return false;
  }
  const editors = Array.isArray(frontTransition?.snapshot?.editors) ? frontTransition.snapshot.editors : [];
  const editorText = editors.join(" ");
  return /what do you want to change/i.test(editorText)
    || /what happens next/i.test(editorText)
    || !frontSubmitTransitionProvesGeneration(frontTransition, task)
    || !frontSubmitTransitionHasActiveProgressProof(frontTransition);
}

function debuggerShouldFastRetryBadFrontTransition(task = {}, frontTransition = {}) {
  const mode = String(task.mode || "");
  if (!["text-to-video", "image-to-video", "start-end-image-to-video", "ingredients-to-video"].includes(mode)) return false;
  if (frontSubmitTransitionProvesGeneration(frontTransition, task)) return false;
  if (frontSubmitSnapshotHasAnyFailedCard(frontTransition?.snapshot || {})) return false;
  if (frontSubmitSnapshotIsMediaDetailEditorRoute(frontTransition?.snapshot || {}) || frontSubmitSnapshotIsVideoContinuationEditRoute(frontTransition?.snapshot || {})) return true;
  if (frontSubmitSnapshotHasAnyProjectCard(frontTransition?.snapshot || {})) return false;
  return debuggerShouldReprepareBeforeNoRequestRetry(task, frontTransition);
}

function debuggerNoRequestTimeoutMs(task = {}) {
  const mode = String(task.mode || "");
  if (mode === "text-to-image") return 12000;
  return 15000;
}

function debuggerPageCommandTimeoutMs(task = {}, meta = {}, stage = "", metaPatch = {}) {
  const mode = String(task.mode || "");
  const apiBackendFallback = meta?.apiBackendFallback === true || metaPatch?.apiBackendFallback === true || Boolean(meta?.apiResult);
  const afterPromptRefAttach = metaPatch?.afterPromptInsert === true || /after_prompt_insert|final_before_click|no_request_retry_reprepare/i.test(String(stage || ""));
  if (mode === "ingredients-to-video" && apiBackendFallback && afterPromptRefAttach) return 300000;
  if (mode === "ingredients-to-video" && afterPromptRefAttach) return 240000;
  if (mode === "ingredients-to-video" && apiBackendFallback) return 180000;
  return 120000;
}

function debuggerShouldUsePageSubmitCapture(task = {}) {
  const mode = String(task.mode || "");
  return mode !== "image-to-video" && mode !== "start-end-image-to-video";
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

function debuggerAllowsNetworkOnlyFrontSubmit(task = {}) {
  // Release-green DOM proof must come from Flow's visible front-end transition,
  // not a backend request/media-id side effect. Keep this helper so older
  // diagnostics can still report the rejected escape hatch explicitly.
  return false;
}

function debuggerIsFlowLoadingPrepError(error = "") {
  return /flow_page_loading|flow_loading|COMPOSER_NOT_READY|COMPOSER_UPLOAD_NOT_SETTLED/i.test(String(error || ""));
}

function debuggerIsPostUploadSettleError(error = "") {
  return /COMPOSER_UPLOAD_NOT_SETTLED/i.test(String(error || ""));
}

function debuggerShouldReloadApiBackendFallbackComposer(prepared = {}, meta = {}) {
  if (meta?.apiBackendFallback !== true) return false;
  const error = String(prepared?.error || prepared?.statusText || "");
  if (!/COMPOSER_NOT_READY/i.test(error)) return false;
  const problems = Array.isArray(prepared?.ready?.snapshot?.problems)
    ? prepared.ready.snapshot.problems.map((problem) => String(problem || ""))
    : [];
  const reloadable = [
    "editor_missing",
    "editor_unstable",
    "create_missing",
    "create_unstable",
    "settings_trigger_missing",
    "settings_trigger_unstable"
  ];
  const reloadablePattern = /editor_missing|editor_unstable|create_missing|create_unstable|settings_trigger_missing|settings_trigger_unstable/i;
  return reloadablePattern.test(error)
    || reloadable.some((problem) => problems.includes(problem));
}

function debuggerShouldAttachRefsAfterPromptInsert(task = {}) {
  const mode = String(task.mode || "");
  return mode === "ingredients-to-video" || mode === "text-to-image";
}

function debuggerShouldPreserveAttachedRefsThroughFinalClick(task = {}) {
  return debuggerShouldAttachRefsAfterPromptInsert(task)
    && debuggerShouldUsePathCNativeCharacterEntry(task);
}

function debuggerShouldRecommitPromptBeforeFinalClick(task = {}) {
  if (debuggerShouldPreserveAttachedRefsThroughFinalClick(task)) return false;
  return debuggerRequiresFrontSubmitTransition(task);
}

function debuggerShouldRecommitPromptBeforeNoRequestRetry(task = {}) {
  if (debuggerShouldPreserveAttachedRefsThroughFinalClick(task)) return false;
  return debuggerRequiresFrontSubmitTransition(task);
}

function debuggerAllowsFrontSubmitReloadRepair(task = {}) {
  if (String(task.mode || "") === "text-to-video") return false;
  return true;
}

function debuggerShouldRepairStatusFeedOnlySubmitVisibility(task = {}) {
  return String(task.mode || "") === "text-to-video";
}

function debuggerPostResponseFrontProofWaitMs(task = {}) {
  const mode = String(task.mode || "");
  if (debuggerIsOmniIngredientsTask(task)) return 60000;
  if (mode === "image-to-video" || mode === "start-end-image-to-video") return 120000;
  if (mode === "ingredients-to-video" || mode === "text-to-video") return 24000;
  return 12000;
}

function debuggerCanAcceptFrontSubmitWithoutMediaIds(task = {}, frontTransition = {}) {
  const mode = String(task.mode || "");
  if (!["image-to-video", "start-end-image-to-video", "text-to-video", "ingredients-to-video"].includes(mode)) {
    return false;
  }
  return frontSubmitTransitionProvesGeneration(frontTransition, task);
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
      const menuRoots = Array.from(document.querySelectorAll("[role='menu'],[role='listbox']"))
        .filter(visible);
      const editor = Array.from(document.querySelectorAll("[contenteditable='true'], textarea"))
        .filter(visible)
        .sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0] || null;
      const editorRect = editor?.getBoundingClientRect?.() || null;
      const nodes = Array.from(document.querySelectorAll("button[aria-haspopup='menu']"))
        .filter(visible)
        .filter((node) => !menuRoots.some((root) => root === node || root.contains(node)))
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
      const modelButton = Array.from(document.querySelectorAll("button")).filter(visible).find((item) => /(Veo\s+\d|Omni\s+Flash)/i.test(textOf(item)));
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
    if (kind === "alternateDurationTab") {
      const value = String(descriptor.value || "").trim().replace(/s$/i, "");
      const target = value ? value + "s" : "";
      const modelButton = Array.from(document.querySelectorAll("button")).filter(visible).find((item) => /(Veo\s+\d|Omni\s+Flash)/i.test(textOf(item)));
      const modelY = modelButton?.getBoundingClientRect?.().y || 0;
      const candidates = Array.from(document.querySelectorAll("button[role='tab']"))
        .filter(visible)
        .filter((item) => /^\d+s$/i.test(textOf(item).replace(/\s+/g, "")))
        .filter((item) => textOf(item).replace(/\s+/g, "").toLowerCase() !== target.toLowerCase())
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter((item) => !modelY || item.rect.y > modelY)
        .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
      const fallbackCandidates = candidates.length ? candidates : Array.from(document.querySelectorAll("button[role='tab']"))
        .filter(visible)
        .filter((item) => /^\d+s$/i.test(textOf(item).replace(/\s+/g, "")))
        .filter((item) => textOf(item).replace(/\s+/g, "").toLowerCase() !== target.toLowerCase())
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter((item) => item.rect.y > Math.max(300, window.innerHeight * 0.45))
        .sort((a, b) => b.rect.y - a.rect.y || a.rect.x - b.rect.x);
      return hit(fallbackCandidates[0]?.node, "alternate_duration_tab") || { ok: false, error: "alternate_duration_tab_not_found", value, modelY };
    }
    if (kind === "modelDropdown") {
      const family = String(descriptor.family || "video");
      const modelPattern = family === "image" ? /(Nano\\s+Banana|Imagen)/i : /(Veo\\s+\\d|Omni\\s+Flash)/i;
      const node = Array.from(document.querySelectorAll("button[aria-haspopup='menu']")).filter(visible).find((item) => modelPattern.test(textOf(item)) && /arrow_drop_down/i.test(textOf(item)));
      return hit(node, "model_dropdown") || { ok: false, error: "model_dropdown_not_found" };
    }
    if (kind === "modelItem") {
      const pattern = new RegExp(String(descriptor.pattern || ""), String(descriptor.flags || ""));
      const family = String(descriptor.family || "video");
      const modelPattern = family === "image" ? /(Nano\\s+Banana|Imagen)/i : /(Veo\\s+\\d|Omni\\s+Flash)/i;
      const candidates = Array.from(document.querySelectorAll("[role='menuitem'], button")).filter(visible).filter((item) => modelPattern.test(textOf(item)));
      const node = candidates.find((item) => pattern.test(normalizeModel(textOf(item))));
      return hit(node, "model_item") || { ok: false, error: "model_item_not_found", pattern: String(descriptor.pattern || ""), visibleVideoModelItems: candidates.map((item) => normalizeModel(textOf(item))).slice(0, 20), visibleVeoItems: candidates.map((item) => normalizeModel(textOf(item))).slice(0, 20) };
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
  let triggerToggle = null;
  let bottomTriggerToggle = null;
  let closeButton = null;
  let outsideClick = null;
  let finalEscape = null;
  if (!closed.ok) {
    editor = await debuggerPromptEditorPoint(target);
    if (editor?.ok) {
      await debuggerClick(target, editor.point).catch(() => {});
      await sleep(180);
      closed = await debuggerWaitForSettingsMenuClosed(target, 1200);
    }
  }
  if (!closed.ok) {
    triggerToggle = await debuggerClickControl(target, { kind: "settingsTrigger" }, { waitMs: 180 }).catch((error) => ({
      ok: false,
      error: String(error?.message || error)
    }));
    await sleep(220);
    closed = await debuggerWaitForSettingsMenuClosed(target, 1200);
  }
  if (!closed.ok) {
    bottomTriggerToggle = await debuggerClickSettingsTriggerInPage(target).catch((error) => ({
      ok: false,
      error: String(error?.message || error)
    }));
    if (bottomTriggerToggle?.ok) {
      await sleep(260);
      closed = await debuggerWaitForSettingsMenuClosed(target, 1500);
    }
  }
  if (!closed.ok) {
    closeButton = await debuggerClickSettingsCloseButtonInPage(target).catch((error) => ({
      ok: false,
      error: String(error?.message || error)
    }));
    if (closeButton?.ok) {
      await sleep(220);
      closed = await debuggerWaitForSettingsMenuClosed(target, 1200);
    }
  }
  if (!closed.ok) {
    outsideClick = await debuggerClickOutsideSettingsMenuInPage(target).catch((error) => ({
      ok: false,
      error: String(error?.message || error)
    }));
    if (outsideClick?.ok) {
      await debuggerPressKey(target, "Escape", "Escape", 27, { holdMs: 25 }).catch(() => {});
      await sleep(220);
      closed = await debuggerWaitForSettingsMenuClosed(target, 1400);
    }
  }
  if (!closed.ok) {
    finalEscape = await debuggerForceEscapeSettingsSurfaceInPage(target).catch((error) => ({
      ok: false,
      error: String(error?.message || error)
    }));
    await debuggerPressKey(target, "Escape", "Escape", 27, { holdMs: 35 }).catch(() => {});
    await sleep(260);
    closed = await debuggerWaitForSettingsMenuClosed(target, 1800);
  }
  trace(task, "settings_close", {
    ok: Boolean(closed.ok),
    error: closed.error || "",
    editorPoint: editor?.point || null,
    editorRect: editor?.rect || null,
    triggerToggleOk: Boolean(triggerToggle?.ok),
    bottomTriggerToggleOk: Boolean(bottomTriggerToggle?.ok),
    bottomTriggerToggleText: bottomTriggerToggle?.text || "",
    closeButtonOk: Boolean(closeButton?.ok),
    closeButtonText: closeButton?.text || "",
    outsideClickOk: Boolean(outsideClick?.ok),
    outsideClickPoint: outsideClick?.point || null,
    finalEscapeOk: Boolean(finalEscape?.ok),
    finalEscapeFocusedText: finalEscape?.focusedText || ""
  });
  return closed;
}

async function debuggerClickOutsideSettingsMenuInPage(target) {
  return debuggerEvaluate(target, `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const menuRoots = Array.from(document.querySelectorAll("[role='menu'],[role='listbox']"))
      .filter(visible)
      .map((node) => node.getBoundingClientRect());
    const points = [
      { x: Math.max(12, Math.round(window.innerWidth * 0.08)), y: Math.max(12, Math.round(window.innerHeight * 0.18)) },
      { x: Math.max(12, Math.round(window.innerWidth * 0.5)), y: Math.max(12, Math.round(window.innerHeight * 0.18)) },
      { x: Math.max(12, Math.round(window.innerWidth * 0.5)), y: Math.max(12, Math.round(window.innerHeight * 0.88)) }
    ];
    const point = points.find((candidate) => !menuRoots.some((rect) =>
      candidate.x >= rect.left && candidate.x <= rect.right && candidate.y >= rect.top && candidate.y <= rect.bottom
    )) || points[0];
    const target = document.elementFromPoint(point.x, point.y) || document.body;
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window, pointerType: "mouse", isPrimary: true }));
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window, pointerType: "mouse" }));
    target.click?.();
    return {
      ok: true,
      point,
      tag: target.tagName || "",
      id: target.id || "",
      className: String(target.className || "").slice(0, 120)
    };
  })()`);
}

async function debuggerClickSettingsCloseButtonInPage(target) {
  return debuggerEvaluate(target, `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const textOf = (node) => String(node?.innerText || node?.textContent || node?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim();
    const rectOf = (node) => {
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const menuRoots = Array.from(document.querySelectorAll("[role='menu'],[role='listbox']"))
      .filter(visible);
    const buttons = Array.from(document.querySelectorAll("button,[role='button']"))
      .filter(visible)
      .map((node) => ({ node, text: textOf(node), rect: node.getBoundingClientRect() }))
      .filter((item) => {
        const inMenu = menuRoots.some((root) => root === item.node || root.contains(item.node));
        if (!inMenu) return false;
        const text = item.text;
        if (/\\barrow_drop_down\\b|\\b(Nano\\s+Banana|Imagen|Veo\\s+\\d|Omni\\s+Flash)\\b/i.test(text)) return false;
        const nearMenuCorner = menuRoots.some((root) => {
          const rect = root.getBoundingClientRect();
          return item.rect.right >= rect.right - 96 && item.rect.bottom >= rect.bottom - 96;
        });
        return /^(close|cancel|done|x|×)$/i.test(text) || /\\bclose\\b/i.test(text) || (!text && nearMenuCorner);
      })
      .sort((a, b) => (b.rect.right + b.rect.bottom) - (a.rect.right + a.rect.bottom));
    const target = buttons[0]?.node || null;
    if (!target) return { ok: false, error: "settings_close_button_not_found" };
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window, pointerType: "mouse", isPrimary: true }));
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    target.click();
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window, pointerType: "mouse", isPrimary: true }));
    return { ok: true, text: textOf(target), rect: rectOf(target) };
  })()`);
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
    const menuRoots = Array.from(document.querySelectorAll("[role='menu'],[role='listbox']"))
      .filter(visible);
    const candidates = Array.from(document.querySelectorAll("button[aria-haspopup='menu']"))
      .filter(visible)
      .filter((node) => !menuRoots.some((root) => root === node || root.contains(node)))
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

async function debuggerVisibleComposerSettingsSnapshot(target) {
  return debuggerEvaluate(target, `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const textOf = (node) => String(node?.innerText || node?.textContent || "").replace(/\\s+/g, " ").trim();
    const rectOf = (node) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const menuRoots = Array.from(document.querySelectorAll("[role='menu'],[role='listbox']"))
      .filter(visible);
    const bottomControls = Array.from(document.querySelectorAll("button,[role='button'],[role='tab']"))
      .filter(visible)
      .map((node) => ({ node, rect: node.getBoundingClientRect(), text: textOf(node), selected: node.getAttribute("aria-selected") === "true" }))
      .filter((item) => item.rect.y > Math.max(220, window.innerHeight * 0.38))
      .slice(-80);
    const scoreTrigger = (item) => {
      const text = String(item.text || "");
      const videoLike = /\\bVideo\\b/i.test(text);
      const durationLike = /\\b(?:4|6|8|10)s\\b/i.test(text);
      const modelLike = /\\b(?:Omni\\s+Flash|Veo\\s+\\d(?:\\.\\d)?)\\b/i.test(text);
      const cropLike = /x[1-4]|[1-4]x|crop_(16_9|9_16|square|landscape|portrait)|\\b(?:9:16|16:9|1:1)\\b/i.test(text);
      return (videoLike ? 100000 : 0)
        + (durationLike ? 30000 : 0)
        + (modelLike ? 20000 : 0)
        + (item.selected ? 5000 : 0)
        - (cropLike && !videoLike && !durationLike && !modelLike ? 20000 : 0)
        + Math.max(0, Math.round(item.rect.y));
    };
    const triggers = Array.from(document.querySelectorAll("button[aria-haspopup='menu']"))
      .filter(visible)
      .filter((node) => !menuRoots.some((root) => root === node || root.contains(node)))
      .map((node) => ({ node, rect: node.getBoundingClientRect(), text: textOf(node) }))
      .filter((item) => /\\bVideo\\b|x[1-4]|[1-4]x|crop_(16_9|9_16|square|landscape|portrait)|\\b(9:16|16:9|1:1)\\b/i.test(item.text))
      .filter((item) => item.rect.y > Math.max(240, window.innerHeight * 0.45))
      .map((item) => ({ ...item, score: scoreTrigger(item) }))
      .sort((a, b) => b.score - a.score || b.rect.y - a.rect.y || b.rect.x - a.rect.x);
    const trigger = triggers[0] || null;
    const selectedModeTabs = Array.from(document.querySelectorAll("button[role='tab']"))
      .filter(visible)
      .filter((node) => node.getAttribute("aria-selected") === "true")
      .map(textOf)
      .slice(0, 16);
    const activePanelText = menuRoots.map(textOf).filter(Boolean).join(" ").slice(0, 1600);
    const settingsSurfaceText = [
      trigger?.text || "",
      ...selectedModeTabs,
      ...bottomControls.map((item) => item.text)
    ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim().slice(0, 2000);
    const combined = [settingsSurfaceText, activePanelText].join(" ");
    const durationMatch = combined.match(/\\b(?:4|6|8|10)s\\b/i);
    const modelMatch = combined.match(/\\bOmni\\s+Flash\\b|\\bVeo\\s+\\d(?:\\.\\d)?\\s*-\\s*(?:Fast|Lite|Quality)(?:\\s*\\[Lower Priority\\])?/i);
    const triggerText = trigger?.text || "";
    const triggerCropOnly = /x[1-4]|[1-4]x|crop_(16_9|9_16|square|landscape|portrait)|\\b(?:9:16|16:9|1:1)\\b/i.test(triggerText)
      && !/\\bVideo\\b|\\b(?:4|6|8|10)s\\b|\\bOmni\\s+Flash\\b|\\bVeo\\s+\\d/i.test(triggerText);
    return {
      settingsTriggerText: trigger?.text || "",
      settingsTriggerRect: rectOf(trigger?.node),
      selectedModeTabs,
      settingsSurfaceText,
      activePanelText,
      visibleTriggerMode: /\\bVideo\\b/i.test(combined) ? "Video" : "",
      visibleTriggerDuration: durationMatch?.[0] || "",
      visibleModel: modelMatch?.[0] || "",
      staleCropControlsVisible: Boolean(triggerCropOnly && !/\\bVideo\\b/i.test(combined)),
      staleOmniStateVisible: !/\\bOmni\\s+Flash\\b|\\bVeo\\s+\\d/i.test(combined),
      triggerCandidates: triggers.slice(0, 8).map((item) => ({
        text: item.text,
        score: item.score,
        rect: rectOf(item.node)
      })),
      menuOpen: menuRoots.length > 0
    };
  })()`);
}

async function debuggerPathCModeTabSelectionSnapshot(target, task = {}, clicked = {}, options = {}) {
  const dom = await debuggerEvaluate(target, `(() => {
    const compact = (value = "") => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const textOf = (node) => compact(node?.innerText || node?.textContent || node?.value || node?.getAttribute?.("aria-label") || "");
    const rectOf = (node) => {
      const rect = node?.getBoundingClientRect?.();
      return rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null;
    };
    const tabs = Array.from(document.querySelectorAll("button[role='tab']"))
      .filter(visible)
      .map((node) => ({
        id: node.id || "",
        text: textOf(node),
        selected: node.getAttribute("aria-selected") === "true",
        rect: rectOf(node)
      }));
    const menuRoots = Array.from(document.querySelectorAll("[role='menu'],[role='listbox']"))
      .filter(visible);
    const settingsTriggers = Array.from(document.querySelectorAll("button[aria-haspopup='menu']"))
      .filter(visible)
      .filter((node) => !menuRoots.some((root) => root === node || root.contains(node)))
      .map((node) => ({ node, text: textOf(node), rect: rectOf(node) }))
      .filter((item) => /\\b(Video|Image)\\b|x[1-4]|[1-4]x|crop_(16_9|9_16|square|landscape|portrait)|\\b(?:9:16|16:9|1:1)\\b/i.test(item.text))
      .sort((a, b) => (b.rect?.y || 0) - (a.rect?.y || 0));
    const modelButtons = Array.from(document.querySelectorAll("button[aria-haspopup='menu'],button"))
      .filter(visible)
      .map((node) => ({ node, text: textOf(node), rect: rectOf(node) }))
      .filter((item) => /\\b(?:Omni\\s+Flash|Veo\\s+\\d(?:\\.\\d)?|Nano\\s+Banana|Imagen)\\b/i.test(item.text));
    const durationTabs = tabs
      .filter((tab) => /^(4|6|8|10)s?$/i.test(compact(tab.text)))
      .map((tab) => ({ text: tab.text, selected: tab.selected, rect: tab.rect }));
    const editor = document.querySelector("[data-slate-editor='true'],[contenteditable='true'],textarea,[role='textbox']");
    const createButtons = Array.from(document.querySelectorAll("button,[role='button']"))
      .filter(visible)
      .map((node) => ({ text: textOf(node), disabled: Boolean(node.disabled || node.getAttribute("aria-disabled") === "true"), rect: rectOf(node) }))
      .filter((item) => /\\bcreate\\b|arrow_forward|send/i.test(item.text));
    const dialogs = Array.from(document.querySelectorAll("[role='dialog'],[data-radix-popper-content-wrapper],.MuiDialog-root"))
      .filter(visible)
      .map(textOf)
      .filter(Boolean)
      .slice(0, 8);
    const active = document.activeElement;
    const settingsPanelText = menuRoots.map(textOf).filter(Boolean).join(" ").slice(0, 1800);
    const settingsSurfaceText = [
      settingsTriggers[0]?.text || "",
      ...tabs.filter((tab) => tab.selected).map((tab) => tab.text),
      ...durationTabs.map((tab) => tab.text),
      ...modelButtons.map((item) => item.text)
    ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim().slice(0, 1800);
    return {
      selectedModeTabs: tabs.filter((tab) => tab.selected).map((tab) => tab.text).slice(0, 24),
      visibleModeTabTexts: tabs.map((tab) => tab.text).filter(Boolean).slice(0, 40),
      visibleDurationText: durationTabs.find((tab) => tab.selected)?.text || settingsSurfaceText.match(/\\b(?:4|6|8|10)s\\b/i)?.[0] || "",
      visibleModelText: modelButtons[0]?.text || settingsSurfaceText.match(/\\b(?:Omni\\s+Flash|Veo\\s+\\d(?:\\.\\d)?)\\b/i)?.[0] || "",
      modeDropdownFound: Boolean(settingsTriggers[0]),
      modeDropdownText: settingsTriggers[0]?.text || "",
      modeDropdownRect: settingsTriggers[0]?.rect || null,
      modeMenuOpen: menuRoots.length > 0,
      settingsMenuOpen: menuRoots.length > 0,
      settingsPanelText,
      settingsSurfaceText,
      blockingModalText: dialogs.join(" | ").slice(0, 1200),
      activeElementSummary: {
        tag: String(active?.tagName || "").toLowerCase(),
        role: active?.getAttribute?.("role") || "",
        ariaLabel: active?.getAttribute?.("aria-label") || "",
        text: textOf(active).slice(0, 240)
      },
      route: location.href,
      composerFound: Boolean(editor),
      editorFound: Boolean(editor),
      createButtonFound: createButtons.length > 0,
      createButtonTexts: createButtons.map((button) => button.text).slice(0, 8)
    };
  })()`).catch((error) => ({ error: String(error?.message || error || "path_c_mode_tab_selection_snapshot_failed") }));
  return {
    taskId: String(task.id || ""),
    expectedMode: options.expectedMode || debuggerVisibleModeForTask(task),
    expectedDuration: String(options.expectedDuration || debuggerDurationForTask(task)),
    expectedModel: String(options.expectedModel || task.model || ""),
    selectedModeTabs: dom.selectedModeTabs || [],
    visibleModeTabTexts: dom.visibleModeTabTexts || [],
    visibleDurationText: dom.visibleDurationText || "",
    visibleModelText: dom.visibleModelText || "",
    modeDropdownFound: Boolean(dom.modeDropdownFound),
    modeDropdownText: dom.modeDropdownText || "",
    modeDropdownRect: dom.modeDropdownRect || null,
    modeMenuOpen: Boolean(dom.modeMenuOpen),
    clickedModeTabText: clicked?.found?.text || clicked?.selected?.text || "",
    clickedModeTabRect: clicked?.found?.rect || clicked?.selected?.rect || null,
    modeTabSelectedAfterClick: Boolean(clicked?.verified || String(clicked?.selected?.ariaSelected || clicked?.found?.ariaSelected || "") === "true"),
    settingsMenuOpen: Boolean(dom.settingsMenuOpen),
    settingsPanelText: dom.settingsPanelText || "",
    settingsSurfaceText: dom.settingsSurfaceText || "",
    blockingModalText: dom.blockingModalText || "",
    activeElementSummary: dom.activeElementSummary || null,
    route: dom.route || "",
    composerFound: Boolean(dom.composerFound),
    editorFound: Boolean(dom.editorFound),
    createButtonFound: Boolean(dom.createButtonFound),
    createButtonTexts: dom.createButtonTexts || [],
    cachedFragmentReplayAttemptedBeforeSettingsStable: options.cachedFragmentReplayAttemptedBeforeSettingsStable === true,
    failurePhase: options.failurePhase || "",
    domSnapshotError: dom.error || ""
  };
}

async function debuggerCleanProjectComposerSnapshot(target, task = {}, options = {}) {
  const expectedProjectId = String(options.expectedProjectId || task.projectId || "").trim();
  const dom = await debuggerEvaluate(target, `(() => {
    const compact = (value = "") => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const textOf = (node) => compact(node?.innerText || node?.textContent || node?.value || node?.getAttribute?.("aria-label") || "");
    const editors = Array.from(document.querySelectorAll("[data-slate-editor='true'],[contenteditable='true'],textarea,[role='textbox']"))
      .filter(visible)
      .map((node) => ({
        text: textOf(node),
        placeholder: node.getAttribute?.("placeholder") || node.getAttribute?.("aria-placeholder") || node.getAttribute?.("data-placeholder") || ""
      }));
    const editor = editors[0] || null;
    const menuRoots = Array.from(document.querySelectorAll("[role='menu'],[role='listbox']"))
      .filter(visible);
    const activePanelText = menuRoots.map(textOf).filter(Boolean).join(" ").slice(0, 1800);
    const controls = Array.from(document.querySelectorAll("button,[role='button'],[role='tab']"))
      .filter(visible)
      .map((node) => ({
        text: textOf(node),
        role: node.getAttribute("role") || "",
        ariaSelected: node.getAttribute("aria-selected") || "",
        ariaLabel: node.getAttribute("aria-label") || ""
      }))
      .filter((item) => item.text || item.ariaLabel)
      .slice(-120);
    const settingsSurfaceText = controls
      .map((item) => [item.text, item.ariaLabel].filter(Boolean).join(" "))
      .join(" ")
      .replace(/\\s+/g, " ")
      .trim()
      .slice(0, 2200);
    const createButtons = controls
      .filter((item) => /\\bcreate\\b|arrow_forward|send/i.test([item.text, item.ariaLabel].join(" ")));
    const href = location.href;
    const routeProjectId = String(href || "").match(/\\/project\\/([0-9a-f-]{36})/i)?.[1] || "";
    const routeClass = /\\/edit\\//i.test(href)
      ? "project_edit"
      : /\\/media\\//i.test(href)
        ? "media_detail"
        : /\\/project\\/[0-9a-f-]{36}(?:[/?#]|$)/i.test(href)
          ? "project_root"
          : /\\/project\\//i.test(href)
            ? "project_nested"
            : "other";
    const composerText = editor?.text || "";
    const composerPlaceholder = compact(editor?.placeholder || "");
    const combined = [composerText, composerPlaceholder, settingsSurfaceText, activePanelText].join(" ");
    const isEditRoute = /\\/edit\\//i.test(href);
    const isMediaEditSurface = /what do you want to change\\??|refine|edit image|make edits|change this/i.test(combined);
    const nanoBananaSurfaceVisible = /Nano\\s+Banana|Imagen|crop_(?:16_9|9_16|square|landscape|portrait)/i.test(combined)
      && !/\\bVideo\\b|\\b(?:4|6|8|10)s\\b|\\bOmni\\s+Flash\\b|\\bVeo\\s+\\d/i.test(combined);
    const settingsSurfaceCreateVideoCapable = /\\bVideo\\b|\\b(?:4|6|8|10)s\\b|\\bOmni\\s+Flash\\b|\\bVeo\\s+\\d/i.test(combined);
    const cleanProjectComposerFound = routeClass === "project_root"
      && Boolean(editor)
      && createButtons.length > 0
      && !isEditRoute
      && !isMediaEditSurface;
    return {
      url: href,
      routeClass,
      projectId: routeProjectId,
      isEditRoute,
      isMediaEditSurface,
      composerText,
      composerPlaceholder,
      settingsSurfaceText,
      activePanelText,
      nanoBananaSurfaceVisible,
      cleanProjectComposerFound,
      settingsSurfaceCreateVideoCapable,
      editorFound: Boolean(editor),
      createButtonFound: createButtons.length > 0,
      bridgeVersion: window.__afRebuildContentBridgeVersion || "",
      pageHookVersion: window.__afRebuildPageHookVersion || ""
    };
  })()`).catch((error) => ({ error: String(error?.message || error || "path_c_clean_project_composer_snapshot_failed") }));
  const projectId = String(dom.projectId || debuggerProjectIdFromUrl(dom.url || "") || "").trim();
  const projectMatches = !expectedProjectId || projectId === expectedProjectId;
  let failureClass = "";
  if (dom.error) failureClass = "path_c_clean_project_composer_snapshot_failed";
  else if (!projectMatches) failureClass = "path_c_wrong_project";
  else if (dom.isEditRoute || dom.isMediaEditSurface) failureClass = "path_c_media_edit_surface_active";
  else if (dom.routeClass !== "project_root") failureClass = "path_c_wrong_flow_surface";
  else if (!dom.editorFound || !dom.createButtonFound || !dom.cleanProjectComposerFound) failureClass = "path_c_wrong_flow_surface";
  return {
    url: dom.url || "",
    routeClass: dom.routeClass || "",
    projectId,
    expectedProjectId,
    isEditRoute: Boolean(dom.isEditRoute),
    isMediaEditSurface: Boolean(dom.isMediaEditSurface),
    composerText: dom.composerText || "",
    composerPlaceholder: dom.composerPlaceholder || "",
    settingsSurfaceText: dom.settingsSurfaceText || "",
    activePanelText: dom.activePanelText || "",
    nanoBananaSurfaceVisible: Boolean(dom.nanoBananaSurfaceVisible),
    cleanProjectComposerFound: Boolean(dom.cleanProjectComposerFound && projectMatches),
    settingsSurfaceCreateVideoCapable: Boolean(dom.settingsSurfaceCreateVideoCapable),
    navigationAttempted: options.navigationAttempted === true,
    navigationResult: options.navigationResult || null,
    bridgeVersion: dom.bridgeVersion || "",
    pageHookVersion: dom.pageHookVersion || "",
    editorFound: Boolean(dom.editorFound),
    createButtonFound: Boolean(dom.createButtonFound),
    failureClass,
    domSnapshotError: dom.error || ""
  };
}

async function ensureCleanProjectComposerForTask({ target, task = {}, prepared = null } = {}) {
  const expectedProjectId = String(task.projectId || prepared?.projectId || "").trim();
  const initial = await debuggerCleanProjectComposerSnapshot(target, task, { expectedProjectId });
  if (initial.cleanProjectComposerFound) return { ...initial, ok: true, initialSnapshot: initial };

  const canNavigate = initial.isEditRoute || initial.isMediaEditSurface || initial.routeClass !== "project_root";
  const projectRootUrl = debuggerProjectRootUrlFromUrl(initial.url, expectedProjectId || initial.projectId);
  if (!canNavigate || !projectRootUrl) {
    return { ...initial, ok: false, initialSnapshot: initial };
  }

  const navigationResult = await debuggerSend(target, "Page.navigate", { url: projectRootUrl })
    .then((result) => ({ ok: true, url: projectRootUrl, frameId: result?.frameId || "" }))
    .catch((error) => ({ ok: false, url: projectRootUrl, error: String(error?.message || error || "path_c_project_route_navigation_failed") }));
  let final = initial;
  if (navigationResult.ok) {
    const deadline = Date.now() + 12000;
    while (Date.now() <= deadline) {
      await sleep(650);
      final = await debuggerCleanProjectComposerSnapshot(target, task, {
        expectedProjectId: expectedProjectId || initial.projectId,
        navigationAttempted: true,
        navigationResult
      });
      if (final.cleanProjectComposerFound) break;
    }
  } else {
    final = await debuggerCleanProjectComposerSnapshot(target, task, {
      expectedProjectId: expectedProjectId || initial.projectId,
      navigationAttempted: true,
      navigationResult
    });
  }
  return {
    ...final,
    ok: Boolean(navigationResult.ok && final.cleanProjectComposerFound),
    navigationAttempted: true,
    navigationResult,
    initialSnapshot: initial,
    finalSnapshot: final,
    failureClass: final.failureClass || initial.failureClass || (navigationResult.ok ? "" : "path_c_wrong_flow_surface")
  };
}

async function debuggerDurationStateSnapshot(target, task = {}, options = {}) {
  const dom = await debuggerEvaluate(target, `(() => {
    const compact = (value = "") => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const textOf = (node) => compact(node?.innerText || node?.textContent || node?.value || node?.getAttribute?.("aria-label") || "");
    const rectOf = (node) => {
      const rect = node?.getBoundingClientRect?.();
      return rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null;
    };
    const tabs = Array.from(document.querySelectorAll("button[role='tab']"))
      .filter(visible)
      .map((node) => ({ id: node.id || "", text: textOf(node), selected: node.getAttribute("aria-selected") === "true", rect: rectOf(node) }));
    const durationDropdownOptions = tabs
      .filter((tab) => /^(4|6|8|10)s?$/i.test(compact(tab.text)) || /-trigger-(4|6|8|10)$/.test(tab.id))
      .map((tab) => ({ text: tab.text, selected: tab.selected, rect: tab.rect }));
    const menuRoots = Array.from(document.querySelectorAll("[role='menu'],[role='listbox']"))
      .filter(visible);
    const settingsTriggerText = Array.from(document.querySelectorAll("button[aria-haspopup='menu']"))
      .filter(visible)
      .filter((node) => !menuRoots.some((root) => root === node || root.contains(node)))
      .map(textOf)
      .find((text) => /\\b(?:4|6|8|10)s\\b|\\bVideo\\b|crop_/i.test(text)) || "";
    const selectedVisibleDuration = durationDropdownOptions.find((option) => option.selected)?.text
      || settingsTriggerText.match(/\\b(?:4|6|8|10)s\\b/i)?.[0]
      || "";
    const store = window.__AF_PROMPT_STORE__?.getState?.() || window.__AF_FLOW_STORE__?.getState?.() || {};
    const keys = store.currentModelKeys || {};
    const keyText = String(keys.videoModelKey || "");
    const requestDuration = keyText.match(/_(4|6|8|10)s\\b/i)?.[1] || "";
    return {
      selectedVisibleDuration,
      durationDropdownOptions,
      settingsTriggerText,
      previousMode: String(store.mode || ""),
      previousModel: String(keys.videoModelKey || keys.videoApi || ""),
      previousDuration: store.selectedVideoDuration == null ? "" : String(store.selectedVideoDuration),
      requestDuration,
      videoApi: String(keys.videoApi || ""),
      videoModelKey: String(keys.videoModelKey || "")
    };
  })()`).catch((error) => ({ error: String(error?.message || error || "duration_state_snapshot_failed") }));
  return {
	    cliRequestedVideoLength: String(task.cliRequestedVideoLength || task.requestedVideoLength || ""),
	    sidepanelVideoLength: String(task.sidepanelVideoLength || task.controlVideoLength || ""),
	    queueTaskVideoLength: String(task.videoLength || ""),
	    runtimeDuration: String(task.videoLength || task.videoDurationSeconds || ""),
	    preflightDuration: String(task.preflightDuration || ""),
	    buildJobsDuration: String(task.buildJobsDuration || ""),
	    payloadDuration: String(task.payloadDuration || task.videoLength || task.videoDurationSeconds || ""),
	    taskDurationField: String(task.duration || ""),
    durationFallbackReason: String(task.durationFallbackReason || ""),
    taskDuration: String(task.videoLength || task.videoDurationSeconds || ""),
    normalizedDuration: String(debuggerDurationForTask(task)),
    selectedVisibleDuration: dom.selectedVisibleDuration || "",
    requestedDuration: String(options.requestedDuration || debuggerDurationForTask(task)),
    durationDropdownOptions: dom.durationDropdownOptions || [],
    clickedDurationOption: options.clickedDurationOption || null,
    afterClickVisibleDuration: options.afterClickVisibleDuration || dom.selectedVisibleDuration || "",
    requestDuration: options.requestDuration || dom.requestDuration || "",
    outputDuration: options.outputDuration || "",
	    mode: String(task.mode || ""),
	    requestedMode: String(task.requestedMode || task.mode || ""),
	    normalizedRuntimeMode: String(task.normalizedRuntimeMode || task.mode || ""),
	    buildJobsMode: String(task.buildJobsMode || task.mode || ""),
	    model: String(task.model || ""),
    previousMode: options.previousMode || dom.previousMode || "",
    previousModel: options.previousModel || dom.previousModel || "",
    previousDuration: options.previousDuration || dom.previousDuration || "",
	    settingsTriggerText: dom.settingsTriggerText || "",
	    videoApi: dom.videoApi || "",
	    videoModelKey: dom.videoModelKey || "",
	    finalEndpoint: dom.videoApi || "",
	    finalModelKey: dom.videoModelKey || "",
	    attachedFrameRefs: Array.isArray(task.attachedFrameRefs) ? task.attachedFrameRefs : [],
	    failurePhase: options.failurePhase || "",
    domSnapshotError: dom.error || ""
  };
}

async function debuggerPathCComposerDomSnapshot(target) {
  return debuggerEvaluate(target, `(() => {
    const compact = (value = "") => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const textOf = (node) => compact(node?.innerText || node?.textContent || node?.value || node?.getAttribute?.("aria-label") || "");
    const rectOf = (node) => {
      const rect = node?.getBoundingClientRect?.();
      return rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null;
    };
    const editor = document.querySelector("[data-slate-editor='true']");
    const nativeChips = Array.from(document.querySelectorAll("[data-slate-editor='true'] [contenteditable='false'],[data-slate-editor='true'] button,[data-slate-editor='true'] [role='button']"))
      .filter(visible)
      .map((node) => ({ text: textOf(node), rect: rectOf(node) }))
      .filter((chip) => chip.text && !/^(add|agent|video|image|create|\\d+s|x\\d+)$/i.test(chip.text))
      .slice(0, 40);
    const createButtons = Array.from(document.querySelectorAll("button,[role='button']"))
      .filter(visible)
      .map((node) => ({ node, text: textOf(node), disabled: Boolean(node.disabled || node.getAttribute("aria-disabled") === "true"), rect: rectOf(node) }))
      .filter((item) => /\\bcreate\\b|arrow_forward|send/i.test(item.text))
      .sort((a, b) => (a.disabled === b.disabled ? 0 : a.disabled ? 1 : -1));
    const create = createButtons[0] || null;
    const center = create?.rect ? { x: create.rect.x + create.rect.width / 2, y: create.rect.y + create.rect.height / 2 } : null;
    const topNode = center ? document.elementFromPoint(center.x, center.y) : null;
    const topButton = topNode?.closest?.("button,[role='button']") || null;
    const dialogs = Array.from(document.querySelectorAll("[role='dialog'],[data-radix-popper-content-wrapper],.MuiDialog-root"))
      .filter(visible)
      .map(textOf)
      .filter(Boolean)
      .slice(0, 6);
    const active = document.activeElement;
    return {
      composerFound: Boolean(editor),
      editorFocused: Boolean(editor && (active === editor || editor.contains(active))),
      promptTextBeforePicker: textOf(editor).slice(0, 800),
      nativeCharacterChipCount: nativeChips.length,
      nativeCharacterChipLabels: nativeChips.map((chip) => chip.text).slice(0, 20),
      activeElementSummary: {
        tag: String(active?.tagName || "").toLowerCase(),
        role: active?.getAttribute?.("role") || "",
        ariaLabel: active?.getAttribute?.("aria-label") || "",
        text: textOf(active).slice(0, 240)
      },
      blockingModalText: dialogs.join(" | ").slice(0, 1200),
      pickerAlreadyOpen: dialogs.some((text) => /character|add to prompt|search/i.test(text)),
      uploadPickerOpen: dialogs.some((text) => /upload|uploads|recent|assets/i.test(text)),
      settingsPanelOpen: Array.from(document.querySelectorAll("[role='menu'],[role='listbox']")).some(visible),
      flowRoute: /\\/media\\//i.test(location.href) ? "media_detail" : /\\/project\\//i.test(location.href) ? "project" : location.pathname,
      selectedMode: compact((window.__AF_PROMPT_STORE__?.getState?.() || window.__AF_FLOW_STORE__?.getState?.() || {}).mode || ""),
      createEnabled: Boolean(create && !create.disabled),
      createTopmost: Boolean(create?.node && topButton === create.node),
      createButtonText: create?.text || ""
    };
  })()`).catch((error) => ({ ok: false, error: String(error?.message || error || "path_c_dom_snapshot_failed") }));
}

function debuggerNativeCharacterMappingDiagnostics(task = {}, explicitHandleMap = {}) {
  const entries = Object.entries(explicitHandleMap || {});
  const fragmentState = Object.fromEntries(entries.map(([key, entry]) => {
    const hasFragment = Boolean(entry?.slateFragment || entry?.fragment?.slateFragment || entry?.nativeCharacterFragment?.slateFragment);
    const hasServerId = Boolean(entry?.characterServerId || entry?.flowCharacterId || entry?.entityId);
    return [key, {
      hasCharacterServerId: hasServerId,
      hasCachedFragment: hasFragment,
      redactedCharacterServerId: debuggerRedactId(entry?.characterServerId || entry?.flowCharacterId || entry?.entityId || "")
    }];
  }));
  return {
    storedMappingKeys: entries.map(([key]) => key).sort(),
    storedCharacterServerIdsRedacted: Object.fromEntries(entries.map(([key, entry]) => [
      key,
      debuggerRedactId(entry?.characterServerId || entry?.flowCharacterId || entry?.entityId || "")
    ])),
    storedMappingFragmentState: fragmentState,
    hasCachedFragment: entries.some(([, entry]) => Boolean(entry?.slateFragment || entry?.fragment?.slateFragment || entry?.nativeCharacterFragment?.slateFragment))
  };
}

async function debuggerPathCPickerOpenPreflightSnapshot(target, task = {}, handles = [], explicitHandleMap = {}, extra = {}) {
  const dom = await debuggerPathCComposerDomSnapshot(target);
  const mapping = debuggerNativeCharacterMappingDiagnostics(task, explicitHandleMap);
  return {
    taskId: String(task.id || ""),
    handlesRequested: handles.map((entry) => `@${entry.handle || entry.normalizedHandle || ""}`).filter(Boolean),
    ...mapping,
    hasCachedFragment: Boolean(mapping.hasCachedFragment || extra.hasCachedFragment),
    cachedFragmentInsertAttempted: extra.cachedFragmentInsertAttempted === true,
    cachedFragmentInsertResult: extra.cachedFragmentInsertResult || cachedFragmentProbe || null,
    needsPickerCapture: extra.needsPickerCapture !== false,
    composerFound: Boolean(dom.composerFound),
    editorFocused: Boolean(dom.editorFocused),
    activeElementSummary: dom.activeElementSummary || null,
    blockingModalText: dom.blockingModalText || "",
    pickerAlreadyOpen: Boolean(dom.pickerAlreadyOpen),
    uploadPickerOpen: Boolean(dom.uploadPickerOpen),
    settingsPanelOpen: Boolean(dom.settingsPanelOpen),
    flowRoute: dom.flowRoute || "",
    selectedMode: dom.selectedMode || "",
    promptTextBeforePicker: dom.promptTextBeforePicker || "",
    domSnapshotError: dom.error || "",
    cachedFragmentProbe: extra.cachedFragmentProbe || null,
    failurePhase: extra.failurePhase || ""
  };
}

function debuggerShouldValidatePostChipSettings(task = {}) {
  return debuggerPromptHasNativeCharacterSyntax(task)
    && ["text-to-video", "ingredients-to-video"].includes(String(task.mode || ""));
}

function debuggerPostChipSettingsProblemList(task = {}, prepared = {}, visible = {}, activeSettings = {}) {
  const settingsPrepared = {
    ...(prepared || {}),
    visible: {
      ...(prepared?.visible || {}),
      ...(visible || {})
    }
  };
  return debuggerPreparedSettingsProblems(settingsPrepared, task, activeSettings);
}

async function debuggerCollectPostChipSettingsSnapshot(target, task = {}, prepared = {}, activeSettings = {}, typed = {}, extra = {}) {
  const visible = await debuggerVisibleComposerSettingsSnapshot(target).catch((error) => ({
    settingsTriggerText: "",
    selectedModeTabs: [],
    settingsSurfaceText: "",
    activePanelText: "",
    error: String(error?.message || error || "visible_settings_snapshot_failed")
  }));
  const dom = await debuggerPathCComposerDomSnapshot(target);
  const problems = debuggerPostChipSettingsProblemList(task, prepared, visible, activeSettings);
  const expectedDuration = String(activeSettings?.duration || debuggerDurationForTask(task));
  const expectedModel = String(activeSettings?.model || task.model || "");
  const expectedMode = debuggerVisibleModeForTask(task);
  const createPoint = prepared?.createRect ? pointFromRect(prepared.createRect) : null;
  const createHit = createPoint ? await debuggerHitTest(target, createPoint).catch((error) => ({ ok: false, error: String(error?.message || error) })) : null;
  const chipLabels = Array.isArray(typed?.nativeCharacterPathC?.visibleChipLabels) && typed.nativeCharacterPathC.visibleChipLabels.length
    ? typed.nativeCharacterPathC.visibleChipLabels
    : (dom.nativeCharacterChipLabels || []);
  const chipCount = Number(typed?.nativeCharacterPathC?.nativeChipCountAfter || typed?.nativeCharacterPathC?.preSubmitChipProof?.nativeChipCountAfter || dom.nativeCharacterChipCount || chipLabels.length || 0);
  const promptSemanticPersisted = Boolean(
    typed?.nativeCharacterPathC?.preSubmitChipProof?.semanticPromptPersisted ||
    typed?.nativeCharacterPathC?.preSubmitChipProof?.ok ||
    typed?.commit?.method === "pathC.beforeinput.nativeCharacterChips" ||
    typed?.commit?.nativeCharacterMentions?.ok
  );
  return {
    ok: problems.length === 0 && !visible?.staleCropControlsVisible,
    problems,
    visibleTriggerMode: visible.visibleTriggerMode || "",
    visibleTriggerDuration: visible.visibleTriggerDuration || "",
    visibleModel: visible.visibleModel || "",
    expectedMode,
    expectedDuration,
    expectedModel,
    settingsSurfaceText: visible.settingsSurfaceText || visible.settingsTriggerText || "",
    activePanelText: visible.activePanelText || "",
    selectedModeTabs: visible.selectedModeTabs || [],
    chipCount,
    chipLabels,
    promptSemanticPersisted,
    createEnabled: Boolean(dom.createEnabled || (prepared?.createButton && !prepared.createButton.disabled)),
    createTopmost: Boolean(dom.createTopmost || (createHit?.ok && !createHit.disabled)),
    createHit,
    staleCropControlsVisible: Boolean(visible.staleCropControlsVisible),
    staleOmniStateVisible: Boolean(visible.staleOmniStateVisible),
    reseatAttempted: extra.reseatAttempted === true,
    reseatResult: extra.reseatResult || null,
    visible,
    dom
  };
}

async function debuggerForceEscapeSettingsSurfaceInPage(target) {
  return debuggerEvaluate(target, `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const textOf = (node) => String(node?.innerText || node?.textContent || node?.value || "").replace(/\\s+/g, " ").trim();
    const roots = Array.from(document.querySelectorAll("[role='menu'],[role='listbox']"))
      .filter(visible);
    const target = roots[0] || document.activeElement || document.body;
    try { target.focus?.({ preventScroll: true }); } catch {}
    for (const type of ["keydown", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      document.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    }
    try { document.activeElement?.blur?.(); } catch {}
    return {
      ok: true,
      rootCount: roots.length,
      focusedText: textOf(target).slice(0, 120)
    };
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
  const forceClickSelected = options.forceClickSelected === true;
  const cycleSelected = options.cycleSelected === true;
  if (existing?.ok && String(existing.ariaSelected || "") === "true" && !forceClickSelected) {
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
  let alternateDurationClick = null;
  if (existing?.ok && String(existing.ariaSelected || "") === "true" && cycleSelected) {
    alternateDurationClick = await debuggerClickControl(target, { kind: "alternateDurationTab", value: String(duration || "") }, {
      ...options,
      waitMs: Math.max(420, Number(options.waitMs || 0) || 0)
    });
    if (alternateDurationClick?.ok) {
      const alternateNodeId = String(alternateDurationClick.found?.id || "");
      if (alternateNodeId) {
        await debuggerWaitForSelectedNodeId(target, alternateNodeId, Math.max(900, Number(options.verifyMs || 0) || 0)).catch(() => null);
      }
      await sleep(220);
    }
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
    forceClickSelected,
    cycleSelected,
    alternateDurationClick,
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
  if (visibleMode === "VIDEO") {
    const currentVideo = await debuggerFindControl(target, { kind: "tabSuffix", suffix: suffixMap.VIDEO });
    steps.push({ step: "video_parent_current", target: "VIDEO", current: currentVideo });
    trace(task, "settings_video_parent_current", {
      target: "VIDEO",
      ok: Boolean(currentVideo?.ok),
      selected: String(currentVideo?.ariaSelected || "") === "true",
      error: currentVideo?.error || "",
      text: currentVideo?.text || "",
      rect: currentVideo?.rect || null
    });
  }
  if (visibleMode === "VIDEO" && debuggerShouldForceNativeVisibleSettingsReseat(task)) {
    const imageReseat = await debuggerClickTabAndVerify(target, suffixMap.IMAGE, { waitMs: 360, verifyMs: 1400 });
    steps.push({ step: "top_mode_image_reseat", target: "IMAGE", ...imageReseat });
    trace(task, "settings_top_mode_image_reseat", {
      target: "IMAGE",
      ok: Boolean(imageReseat.ok),
      verified: Boolean(imageReseat.verified),
      error: imageReseat.error || imageReseat.verifyError || imageReseat.found?.error || "",
      text: imageReseat.found?.text || "",
      selectedText: imageReseat.selected?.text || "",
      rect: imageReseat.found?.rect || null
    });
    if (!imageReseat.ok || !imageReseat.verified) {
      const snapshot = await debuggerPathCModeTabSelectionSnapshot(target, task, imageReseat, {
        expectedMode: "IMAGE",
        expectedDuration: debuggerDurationForTask(task),
        expectedModel: task.model || "",
        failurePhase: imageReseat.ok ? "top_mode_image_reseat_not_selected" : "top_mode_image_reseat_not_clicked"
      });
      trace(task, "path_c_mode_tab_selection_snapshot", snapshot);
      return { ok: false, error: imageReseat.ok ? "top_mode_image_reseat_not_selected" : "top_mode_image_reseat_not_clicked", steps };
    }
    await sleep(180);
  }
  const topClicked = await debuggerClickTabAndVerify(target, suffixMap[topMode], { waitMs: 420, verifyMs: 1600 });
  steps.push({ step: "top_mode", target: topMode, ...topClicked });
  trace(task, "settings_top_mode", { target: topMode, ok: Boolean(topClicked.ok), verified: Boolean(topClicked.verified), error: topClicked.error || topClicked.verifyError || topClicked.found?.error || "", text: topClicked.found?.text || "", selectedText: topClicked.selected?.text || "", rect: topClicked.found?.rect || null });
  if (debuggerPromptHasNativeCharacterSyntax(task) || !topClicked.ok || !topClicked.verified) {
    const snapshot = await debuggerPathCModeTabSelectionSnapshot(target, task, topClicked, {
      expectedMode: topMode,
      expectedDuration: debuggerDurationForTask(task),
      expectedModel: task.model || "",
      failurePhase: topClicked.ok && topClicked.verified ? "top_mode_selected" : (topClicked.ok ? "mode_tab_not_selected" : "mode_tab_not_clicked")
    });
    trace(task, "path_c_mode_tab_selection_snapshot", snapshot);
  }
  if (!topClicked.ok || !topClicked.verified) return { ok: false, error: topClicked.ok ? "mode_tab_not_selected" : "mode_tab_not_clicked", steps };
  if (visibleMode === "VIDEO_FRAMES" || visibleMode === "VIDEO_REFERENCES") {
    const subClicked = await debuggerClickTabAndVerify(target, suffixMap[visibleMode], { waitMs: 420, verifyMs: 1600 });
    steps.push({ step: "sub_mode", target: visibleMode, ...subClicked });
    trace(task, "settings_sub_mode", { target: visibleMode, ok: Boolean(subClicked.ok), verified: Boolean(subClicked.verified), error: subClicked.error || subClicked.verifyError || subClicked.found?.error || "", text: subClicked.found?.text || "", selectedText: subClicked.selected?.text || "", rect: subClicked.found?.rect || null });
    if (debuggerPromptHasNativeCharacterSyntax(task) || !subClicked.ok || !subClicked.verified) {
      const snapshot = await debuggerPathCModeTabSelectionSnapshot(target, task, subClicked, {
        expectedMode: visibleMode,
        expectedDuration: debuggerDurationForTask(task),
        expectedModel: task.model || "",
        failurePhase: subClicked.ok && subClicked.verified ? "sub_mode_selected" : (subClicked.ok ? "sub_mode_tab_not_selected" : "sub_mode_tab_not_clicked")
      });
      trace(task, "path_c_mode_tab_selection_snapshot", snapshot);
    }
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
  let durationClicked = null;
  if (!isImageMode) {
    duration = debuggerDurationForTask(task);
    const beforeDurationSnapshot = await debuggerDurationStateSnapshot(target, task, {
      requestedDuration: duration,
      failurePhase: "before_duration_click"
    });
    trace(task, "duration_state_snapshot", beforeDurationSnapshot);
    const forceDurationClick = debuggerShouldForceSelectedDurationClick(task);
    durationClicked = await debuggerClickDurationAndVerify(target, duration, {
      waitMs: 360,
      verifyMs: 1800,
      findMs: 5000,
      forceClickSelected: forceDurationClick,
      cycleSelected: forceDurationClick
    });
    steps.push({ step: "duration", target: duration, ...durationClicked });
    trace(task, "settings_duration", {
      target: duration,
      ok: Boolean(durationClicked.ok),
      verified: Boolean(durationClicked.verified),
      skipped: Boolean(durationClicked.skipped),
      forceClickSelected: Boolean(durationClicked.forceClickSelected),
      cycleSelected: Boolean(durationClicked.cycleSelected),
      alternateText: durationClicked.alternateDurationClick?.found?.text || "",
      alternateOk: Boolean(durationClicked.alternateDurationClick?.ok),
      error: durationClicked.error || durationClicked.verifyError || durationClicked.found?.error || "",
      text: durationClicked.found?.text || "",
      selectedText: durationClicked.selected?.text || "",
      rect: durationClicked.found?.rect || null
    });
    const afterDurationSnapshot = await debuggerDurationStateSnapshot(target, task, {
      requestedDuration: duration,
      clickedDurationOption: {
        ok: Boolean(durationClicked.ok),
        verified: Boolean(durationClicked.verified),
        skipped: Boolean(durationClicked.skipped),
        text: durationClicked.found?.text || "",
        selectedText: durationClicked.selected?.text || "",
        rect: durationClicked.found?.rect || null,
        error: durationClicked.error || durationClicked.verifyError || durationClicked.found?.error || ""
      },
      previousMode: beforeDurationSnapshot.previousMode,
      previousModel: beforeDurationSnapshot.previousModel,
      previousDuration: beforeDurationSnapshot.previousDuration,
      failurePhase: durationClicked.ok && durationClicked.verified ? "after_duration_click" : (durationClicked.ok ? "duration_not_selected" : "duration_not_clicked")
    });
    trace(task, "duration_state_snapshot", afterDurationSnapshot);
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
  let selectedModel = task.model || "default";
  const currentModel = await debuggerFindControl(target, { kind: "modelDropdown", family: modelFamily });
  steps.push({ step: "model_current", currentModel });
  trace(task, "settings_model_current", { ok: Boolean(currentModel?.ok), error: currentModel?.error || "", text: currentModel?.text || "", rect: currentModel?.rect || null });
  const normalizedCurrent = String(currentModel?.text || "").replace(/\b(arrow_drop_down|volume_up|volume_off)\b/gi, " ").replace(/\(leaving\s+\d+\/\d+\)/gi, " ").replace(/\s+/g, " ").trim();
  const fallbackPattern = debuggerFallbackModelPatternForTask(task);
  const currentModelAccepted =
    new RegExp(modelPattern.source, modelPattern.flags).test(normalizedCurrent)
    || (fallbackPattern && new RegExp(fallbackPattern.source, fallbackPattern.flags).test(normalizedCurrent));
  if (!currentModelAccepted) {
    const modelMenu = await debuggerClickControl(target, { kind: "modelDropdown", family: modelFamily }, { waitMs: 360 });
    steps.push({ step: "model_open", ...modelMenu });
    trace(task, "settings_model_open", { ok: Boolean(modelMenu.ok), error: modelMenu.error || modelMenu.found?.error || "", text: modelMenu.found?.text || "", rect: modelMenu.found?.rect || null });
    if (!modelMenu.ok) return { ok: false, error: "model_dropdown_not_clicked", steps };
    let modelItem = null;
    const modelItemDeadline = Date.now() + 3500;
    do {
      modelItem = await debuggerClickControl(target, { kind: "modelItem", family: modelFamily, pattern: modelPattern.source, flags: modelPattern.flags }, { waitMs: 520 });
      if (!modelItem?.ok && fallbackPattern) {
        modelItem = await debuggerClickControl(target, { kind: "modelItem", family: modelFamily, pattern: fallbackPattern.source, flags: fallbackPattern.flags }, { waitMs: 520 });
      }
      if (modelItem?.ok) break;
      await sleep(180);
    } while (Date.now() < modelItemDeadline);
    steps.push({ step: "model_select", requested: task.model || "default", ...modelItem });
    trace(task, "settings_model_select", { requested: task.model || "default", ok: Boolean(modelItem.ok), error: modelItem.error || modelItem.found?.error || "", text: modelItem.found?.text || "", rect: modelItem.found?.rect || null, visibleVeoItems: modelItem.found?.visibleVeoItems || [] });
    if (!modelItem.ok) {
      const fallbackOk = debuggerAcceptsCurrentVideoModelFallback(task, normalizedCurrent);
      if (fallbackOk) selectedModel = debuggerModelKeyFromVisibleLabel(normalizedCurrent) || selectedModel;
      steps.push({ step: "model_current_fallback", ok: fallbackOk, current: normalizedCurrent });
      trace(task, "settings_model_current_fallback", {
        ok: fallbackOk,
        requested: task.model || "default",
        current: normalizedCurrent,
        selectedModel,
        reason: fallbackOk ? "compatible_visible_model_already_selected" : "model_item_not_clicked"
      });
      if (!fallbackOk) return { ok: false, error: "model_item_not_clicked", steps };
    } else {
      selectedModel = debuggerModelKeyFromVisibleLabel(modelItem.found?.text || "") || selectedModel;
    }
  } else {
    selectedModel = debuggerModelKeyFromVisibleLabel(normalizedCurrent) || selectedModel;
  }
  const close = await debuggerCloseSettingsMenu(target, task, trace);
  steps.push({ step: "close_settings", ...close });
  if (!close.ok) return { ok: false, error: close.error || "settings_menu_still_open", steps };
  const visibleSnapshot = await debuggerVisibleComposerSettingsSnapshot(target).catch((error) => ({
    settingsTriggerText: "",
    selectedModeTabs: [],
    menuOpen: false,
    error: String(error?.message || error)
  }));
  const visibleProblems = debuggerVisibleVideoTriggerProblems(task, visibleSnapshot, {
    expectedVisibleMode: visibleMode,
    expectedDuration: duration
  });
  steps.push({ step: "visible_settings_snapshot", visible: visibleSnapshot, problems: visibleProblems });
  trace(task, "settings_visible_snapshot", {
    ok: visibleProblems.length === 0,
    error: visibleProblems.length ? `visible_settings_invalid:${visibleProblems.join(",")}` : "",
    settingsTriggerText: visibleSnapshot?.settingsTriggerText || "",
    selectedModeTabs: visibleSnapshot?.selectedModeTabs || [],
    menuOpen: Boolean(visibleSnapshot?.menuOpen),
    problems: visibleProblems
  });
  if (visibleProblems.length) {
    return { ok: false, error: `visible_settings_invalid:${visibleProblems.join(",")}`, steps };
  }
  trace(task, "settings_done", { aspect, repeat, duration, model: selectedModel });
  return { ok: true, steps, aspect, repeat, duration, model: selectedModel, visible: visibleSnapshot };
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

async function debuggerPostClickNoRequestSnapshot(target, task = {}, options = {}) {
  const promptJson = JSON.stringify(String(task.prompt || "").replace(/\s+/g, " ").trim().slice(0, 140));
  const pointJson = JSON.stringify(options.createPoint || {});
  const requestObserverArmedAt = Number(options.requestObserverArmedAt || 0) || 0;
  const clickDispatchedAt = Number(options.clickDispatchedAt || 0) || 0;
  return debuggerEvaluate(target, `((expectedPrompt, point, requestObserverArmedAt, clickDispatchedAt) => {
    const compact = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const textOf = (node) => compact(node?.innerText || node?.textContent || node?.value || node?.getAttribute?.("aria-label") || "");
    const active = document.activeElement || null;
    const topNode = document.elementFromPoint(Number(point.x || 0), Number(point.y || 0));
    const topButton = topNode?.closest?.("button,[role='button']") || topNode;
    const topRect = topButton?.getBoundingClientRect?.();
    const createButtons = Array.from(document.querySelectorAll("button,[role='button']"))
      .filter(visible)
      .filter((node) => /arrow_forward/i.test(textOf(node)))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          text: textOf(node),
          disabled: Boolean(node.disabled || node.getAttribute("aria-disabled") === "true" || getComputedStyle(node).pointerEvents === "none"),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        };
      });
    const editors = Array.from(document.querySelectorAll("textarea,[contenteditable='true'],[role='textbox']"))
      .filter(visible)
      .map((node) => textOf(node));
    const promptStillVisible = Boolean(expectedPrompt && editors.some((text) => compact(text).includes(expectedPrompt)));
    const projectCards = Array.from(document.querySelectorAll("[data-tile-id]"))
      .filter(visible)
      .map((node) => ({ text: textOf(node), tileId: node.getAttribute("data-tile-id") || "" }));
    const failedCardCount = projectCards.filter((card) => /\\bfailed\\b|\\berror\\b|something went wrong|warning/i.test(card.text)).length;
    const progressCardCount = projectCards.filter((card) => /\\b([1-9]\\d?|100)%\\b|progress_activity|generating|loading/i.test(card.text)).length;
    const pendingCardCount = projectCards.filter((card) => /queued|pending|waiting/i.test(card.text)).length;
    const firstCreate = createButtons[0] || null;
    const createDisabledAfterClick = firstCreate ? firstCreate.disabled === true : false;
    return {
      ok: true,
      promptStillVisible,
      createStillEnabled: Boolean(firstCreate && firstCreate.disabled !== true),
      createDisabledAfterClick,
      activeElementText: textOf(active).slice(0, 180),
      activeElementRole: active?.getAttribute?.("role") || "",
      topmostAtCreateCenterAfterClick: {
        tag: String(topButton?.tagName || "").toLowerCase(),
        role: topButton?.getAttribute?.("role") || "",
        ariaLabel: topButton?.getAttribute?.("aria-label") || "",
        text: textOf(topButton).slice(0, 180),
        disabled: Boolean(topButton?.disabled || topButton?.getAttribute?.("aria-disabled") === "true"),
        rect: topRect ? { x: Math.round(topRect.x), y: Math.round(topRect.y), width: Math.round(topRect.width), height: Math.round(topRect.height) } : null
      },
      pendingCardCount,
      progressCardCount,
      failedCardCount,
      projectCardCount: projectCards.length,
      requestObserverArmedAt,
      clickDispatchedAt,
      bridgeVersion: window.__afRebuildContentBridgeVersion || "",
      pageHookVersion: window.__afRebuildPageHookVersion || "",
      documentUrl: location.href,
      documentReadyState: document.readyState || "",
      createButtons,
      editors: editors.slice(-4)
    };
  })(${promptJson}, ${pointJson}, ${requestObserverArmedAt}, ${clickDispatchedAt})`).catch((error) => ({
    ok: false,
    error: String(error?.message || error || "post_click_no_request_snapshot_failed"),
    requestObserverArmedAt,
    clickDispatchedAt
  }));
}

async function debuggerCreateButtonPoint(target, options = {}) {
  const allowDetailEditor = options.allowDetailEditor === true;
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
    if (detailEditorOpen && ${allowDetailEditor ? "false" : "true"}) return { ok: false, error: "IMAGE_DETAIL_EDITOR_OPEN", detailEditorOpen: true };
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
    const buttons = Array.from(document.querySelectorAll("button,[role='button']")).filter(visible);
    const isBackButton = (button) => /arrow_back|Go Back/i.test(textOf(button)) || /go back|back/i.test(String(button.getAttribute("aria-label") || ""));
    const back = buttons.find(isBackButton);
    const mediaDetailSignal = /Get more info about this media|Show history|Reuse text prompt|\\bDone\\b/i.test(pageText);
    const editDetailSignal = /What do you want to change\\?/i.test(pageText);
    const detailOpen = Boolean(back && (mediaDetailSignal || editDetailSignal))
      || editDetailSignal
      || /Show history|\\bDone\\b/i.test(pageText);
    if (!detailOpen) return { ok: true, closed: false, reason: "normal_view" };
    if (back) {
      back.click();
      return { ok: true, closed: true, method: "back_button" };
    }
    const done = buttons.find((button) => /\\bDone\\b/i.test(textOf(button)) || /\\bDone\\b/i.test(String(button.getAttribute("aria-label") || "")));
    if (done) {
      done.click();
      return { ok: true, closed: true, method: "done_button" };
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
    const candidate = await debuggerCreateButtonPoint(target, {
      allowDetailEditor: options.allowDetailEditor === true
    });
    const point = candidate?.ok && candidate.point ? candidate.point : null;
    const hit = point ? await debuggerHitTest(target, point) : { ok: false, error: candidate?.error || "LIVE_CREATE_ARROW_NOT_FOUND" };
    const current = { ...(candidate || {}), point, hit };
    const samePoint = Boolean(
      last?.point &&
      point &&
      Math.abs(Number(last.point.x || 0) - Number(point.x || 0)) <= 2 &&
      Math.abs(Number(last.point.y || 0) - Number(point.y || 0)) <= 2
    );
    if (candidate?.ok && point && hitLooksLikeCreateButton(hit, { allowDetailEditor: options.allowDetailEditor === true })) {
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

function hitLooksLikeCreateButton(hit = {}, options = {}) {
  const text = `${hit.text || ""} ${hit.ariaLabel || ""}`.toLowerCase();
  if (hit.detailEditorOpen && options.allowDetailEditor !== true) return false;
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

function frontSubmitSnapshotHasAnyFailedCard(snapshot = {}) {
  return Number(snapshot.failedProjectCardCount || 0) > 0
    || Number(snapshot.failedNewProjectCardCount || 0) > 0
    || Number(snapshot.failedMatchingPromptCardCount || 0) > 0
    || Number(snapshot.failedMatchingMediaCardCount || 0) > 0;
}

function frontSubmitSnapshotHasCurrentFailedCard(snapshot = {}) {
  return Number(snapshot.failedNewProjectCardCount || 0) > 0
    || Number(snapshot.failedMatchingPromptCardCount || 0) > 0
    || Number(snapshot.failedMatchingMediaCardCount || 0) > 0;
}

function frontSubmitSnapshotHasAnyProjectCard(snapshot = {}) {
  return Number(snapshot.matchingMediaCardCount || 0) > 0
    || Number(snapshot.matchingPromptCardCount || 0) > 0
    || Number(snapshot.newProjectCardCount || 0) > 0
    || Number(snapshot.generationProjectCardCount || 0) > 0
    || frontSubmitSnapshotHasAnyFailedCard(snapshot);
}

function frontSubmitSnapshotIsMediaDetailEditorRoute(snapshot = {}) {
  const editors = Array.isArray(snapshot.editors) ? snapshot.editors : [];
  const editorText = editors.join(" ");
  return /what do you want to change/i.test(editorText);
}

function frontSubmitSnapshotIsVideoContinuationEditRoute(snapshot = {}) {
  const editors = Array.isArray(snapshot.editors) ? snapshot.editors : [];
  const editorText = editors.join(" ");
  return /what happens next/i.test(editorText);
}

function frontSubmitSnapshotIsVideoEditRoute(snapshot = {}) {
  return frontSubmitSnapshotIsMediaDetailEditorRoute(snapshot)
    || frontSubmitSnapshotIsVideoContinuationEditRoute(snapshot);
}

function frontSubmitSnapshotHasVisibleGenerationProof(snapshot = {}, task = {}) {
  return Number(snapshot.matchingMediaCardCount || 0) > 0
    || Number(snapshot.matchingPromptCardCount || 0) > 0
    || frontSubmitNewProjectCardCount(snapshot, task) > 0
    || Number(snapshot.progressCardCount || 0) > 0
    || Boolean(snapshot.progressVisible);
}

function frontSubmitSnapshotHasOmniVisibleProjectMovieCard(snapshot = {}, task = {}) {
  if (!debuggerIsOmniIngredientsTask(task)) return false;
  const matchingCards = [
    ...(Array.isArray(snapshot.matchingProjectGridMovieQueuedCards) ? snapshot.matchingProjectGridMovieQueuedCards : []),
    ...(Array.isArray(snapshot.acceptedProjectMovieCardCandidates) ? snapshot.acceptedProjectMovieCardCandidates : []),
    ...(Array.isArray(snapshot.matchingProjectCards) ? snapshot.matchingProjectCards : [])
  ];
  const hasMatchingMovieCard = matchingCards.some((card) => {
    if (card?.failedLike) return false;
    if (card?.videoLike || card?.progressLike || card?.outputMediaMatch) return true;
    return /(^|\s)(movie|play_circle|progress_activity)(\s|$)|\bqueued\b|\bgenerating\b|\bpending\b|\bwaiting\b/i.test(String(card?.text || ""));
  });
  return Number(snapshot.matchingProjectGridMovieQueuedCardCount || 0) > 0
    || Number(snapshot.newProjectGridMovieQueuedCardCount || 0) > 0
    || Number(snapshot.matchingMediaCardCount || 0) > 0
    || hasMatchingMovieCard;
}

async function debuggerFrontSubmitSnapshot(target, task = {}, options = {}) {
  const prompt = String(task.prompt || "").replace(/\s+/g, " ").trim();
  const promptJson = JSON.stringify(prompt);
  const promptNeedlesJson = JSON.stringify(debuggerSemanticPromptNeedlesForTask(task));
  const contextPromptNeedlesJson = JSON.stringify(debuggerContextualPromptNeedlesForTask(task));
  const modeJson = JSON.stringify(String(task.mode || ""));
  const mediaIdsJson = JSON.stringify(Array.isArray(options.mediaIds) ? options.mediaIds : []);
  const baselineProjectCardIdsJson = JSON.stringify(Array.isArray(options.baselineProjectCardIds) ? options.baselineProjectCardIds : null);
  const baselineProjectCardSignaturesJson = JSON.stringify(
    Array.isArray(options.baselineProjectCardSignatures) ? options.baselineProjectCardSignatures : null
  );
  const baselineGenerationProjectCardCountJson = JSON.stringify(
    Number.isFinite(Number(options.baselineGenerationProjectCardCount))
      ? Number(options.baselineGenerationProjectCardCount)
      : null
  );
  return debuggerEvaluate(target, `((expectedPrompt, expectedPromptNeedles, expectedContextPromptNeedles, expectedMode, expectedMediaIds, baselineProjectCardIds, baselineProjectCardSignatures, baselineGenerationProjectCardCount) => {
		    const visible = (element) => {
		      if (!element) return false;
		      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
	    const compact = (value) => String(value || "").replace(/\\s+/g, " ").trim();
	    const textOf = (node) => compact(node?.innerText || node?.textContent || node?.value || "");
	    const promptNeedles = (Array.isArray(expectedPromptNeedles) && expectedPromptNeedles.length ? expectedPromptNeedles : [expectedPrompt])
	      .map((value) => compact(value).slice(0, 120))
	      .filter(Boolean);
	    const contextPromptNeedles = (Array.isArray(expectedContextPromptNeedles) ? expectedContextPromptNeedles : [])
	      .map((value) => compact(value).slice(0, 120))
	      .filter(Boolean);
	    const promptNeedle = promptNeedles[0] || "";
	    const matchesPromptNeedle = (text) => {
	      const compactText = compact(text);
	      return promptNeedles.some((needle) => needle && compactText.includes(needle));
	    };
	    const matchesContextPromptNeedle = (text) => {
	      const compactText = compact(text);
	      return contextPromptNeedles.some((needle) => needle && compactText.includes(needle));
	    };
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
	    const isVideoMode = ["text-to-video", "image-to-video", "start-end-image-to-video", "ingredients-to-video"].includes(String(expectedMode || ""));
	    const failedTextPattern = /\\bfailed\\b|\\berror\\b|something went wrong|warning/i;
	    const baselineProvided = Array.isArray(baselineProjectCardIds);
		    const baselineCardIds = new Set((baselineProvided ? baselineProjectCardIds : [])
		      .map(compact)
		      .filter(Boolean));
		    const baselineCardSignatures = new Map((Array.isArray(baselineProjectCardSignatures) ? baselineProjectCardSignatures : [])
		      .filter((card) => card && card.tileId)
		      .map((card) => [compact(card.tileId), card]));
		    const snapshotAt = new Date().toISOString();
		    const mediaIdPattern = /[?&]name=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
		    const mediaIdsFromUrls = (urls) => {
		      const ids = [];
		      for (const url of urls || []) {
		        let match;
		        mediaIdPattern.lastIndex = 0;
		        while ((match = mediaIdPattern.exec(String(url || "")))) {
		          if (match[1]) ids.push(match[1]);
		        }
		      }
		      return [...new Set(ids)];
		    };
		    const statusLabelsForCard = ({ text, videoLike, progressLike, failedLike, referenceUploadLike }) => {
		      const labels = [];
		      const value = compact(text);
		      if (failedLike) labels.push("failed");
		      if (/queued/i.test(value)) labels.push("queued");
		      if (/pending/i.test(value)) labels.push("pending");
		      if (/waiting/i.test(value)) labels.push("waiting");
		      if (/generating|loading/i.test(value)) labels.push("generating");
		      if (/\\b([1-9]\\d?|100)%\\b|progress_activity/i.test(value) || progressLike) labels.push("progress");
		      if (/play_circle/i.test(value)) labels.push("play_circle");
		      if (videoLike) labels.push("video");
		      if (referenceUploadLike) labels.push("reference_upload");
		      return [...new Set(labels)];
		    };
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
	    const nativeChipCount = Array.from(document.querySelectorAll('button[data-card-open] img[alt*="Generated or uploaded by you"]'))
	      .filter((node) => visible(node.closest?.("button") || node))
	      .length;
	    const toastText = Array.from(document.querySelectorAll('[role="status"],[role="alert"],.mat-mdc-snack-bar-container,[class*="snack"],[class*="toast"]'))
	      .filter(visible)
	      .map((node) => textOf(node))
	      .filter(Boolean)
	      .slice(-3)
	      .join(" | ");
	    const promptStillVisible = promptNeedles.some((needle) => needle && editors.some((text) => compact(text).includes(needle)));
	    const createDisabled = createButtons.some((button) => button.disabled || button.pointerEvents === "none");
	    const projectCards = Array.from(document.querySelectorAll("[data-tile-id]"))
	      .filter(visible)
	      .map((node) => {
	        const text = textOf(node);
	        const tileId = String(node.getAttribute?.("data-tile-id") || "");
	        const mediaUrls = [
	          ...Array.from(node.querySelectorAll?.("img,video,source") || []).map((media) => [
	            media.currentSrc || "",
	            media.src || "",
	            media.getAttribute?.("src") || "",
	            media.getAttribute?.("poster") || ""
	          ]).flat(),
	          ...Array.from(node.querySelectorAll?.("a[href]") || []).map((anchor) => anchor.getAttribute("href") || "")
	        ].filter(Boolean);
	        const videoLike = /play_circle|\\bvideo\\b/i.test(text) || Boolean(node.querySelector?.("video"));
	        const progressLike = /\\b([1-9]\\d?|100)%\\b|progress_activity|generating|loading|queued/i.test(text);
	        const failedLike = failedTextPattern.test(text);
	        const referenceUploadLike = !videoLike && !progressLike && (/\\bimage\\b/i.test(text) || /\\.(?:png|jpe?g|webp)\\b/i.test(text));
		        const mediaText = [
		          tileId,
		          text,
		          ...mediaUrls,
		          node.getAttribute?.("href") || "",
		          node.querySelector?.("a[href]")?.getAttribute?.("href") || ""
		        ].map(compact).join(" ");
		        const cardMediaIds = mediaIdsFromUrls(mediaUrls);
		        const mediaSignature = compact(mediaUrls.join(" ")).slice(0, 900);
		        const contentSignature = compact([text, ...cardMediaIds, ...mediaUrls].join(" ")).slice(0, 1200);
		        const outputMediaMatch = mediaNeedles.some((needle) => needle && mediaText.includes(needle));
		        const rect = node.getBoundingClientRect();
		        return {
		          tileId,
		          text: text.slice(0, 160),
		          cardMediaIds,
		          statusLabels: statusLabelsForCard({ text, videoLike, progressLike, failedLike, referenceUploadLike }),
		          videoLike,
		          progressLike,
		          failedLike,
		          referenceUploadLike,
		          outputMediaMatch,
		          mediaText,
		          mediaSignature,
		          contentSignature,
		          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
		        };
		      });
	    const matchingPromptCardsAll = projectCards.filter((card) => matchesPromptNeedle(card.text));
	    const matchingMediaCardsAll = projectCards.filter((card) => mediaNeedles.some((needle) => needle && card.mediaText.includes(needle)));
	    const validVideoCard = (card) => !card.failedLike && (!isVideoMode || card.videoLike || card.progressLike || card.outputMediaMatch);
	    const matchingPromptCards = isVideoMode ? matchingPromptCardsAll.filter(validVideoCard) : matchingPromptCardsAll;
	    const matchingMediaCards = isVideoMode ? matchingMediaCardsAll.filter(validVideoCard) : matchingMediaCardsAll;
	    const newProjectCards = baselineProvided
	      ? projectCards.filter((card) => card.tileId && !baselineCardIds.has(card.tileId))
	      : [];
	    const generationProjectCards = isVideoMode
	      ? newProjectCards.filter((card) => !card.failedLike && (card.videoLike || card.progressLike))
	      : newProjectCards;
	    const totalGenerationProjectCards = isVideoMode
	      ? projectCards.filter((card) => !card.failedLike && (card.videoLike || card.progressLike))
	      : projectCards;
	    const failedProjectCards = projectCards.filter((card) => card.failedLike);
	    const failedNewProjectCards = newProjectCards.filter((card) => card.failedLike);
	    const failedMatchingPromptCards = matchingPromptCardsAll.filter((card) => card.failedLike);
	    const failedMatchingMediaCards = matchingMediaCardsAll.filter((card) => card.failedLike);
	    const baselineGenerationCount = Number.isFinite(Number(baselineGenerationProjectCardCount))
	      ? Number(baselineGenerationProjectCardCount)
	      : null;
	    const generationProjectCardDelta = baselineGenerationCount === null
	      ? 0
	      : Math.max(0, totalGenerationProjectCards.length - baselineGenerationCount);
	    const visibleGenerationProjectCards = generationProjectCards.length
	      ? generationProjectCards
	      : (generationProjectCardDelta > 0 ? totalGenerationProjectCards.slice(-generationProjectCardDelta) : []);
	    const progressCards = projectCards.filter((card) =>
	      !card.failedLike &&
	      card.progressLike &&
	      (!isVideoMode || card.videoLike || card.progressLike || !card.referenceUploadLike)
	    );
	    const queuedCards = projectCards.filter((card) => /queued|pending|waiting/i.test(card.text));
	    const movieCards = projectCards.filter((card) => card.videoLike);
		    const projectGridMovieQueuedCards = projectCards.filter((card) =>
		      !card.failedLike &&
		      (
		        (
		          (card.videoLike || card.progressLike) &&
	          /play_circle|queued|pending|waiting|generating|loading|progress_activity|\\b([1-9]\\d?|100)%\\b/i.test(card.text)
	        ) ||
		        (isVideoMode && card.outputMediaMatch)
		      )
		    );
		    const cardMatchesCurrentMedia = (card) => mediaNeedles.some((needle) => needle && card.mediaText.includes(needle));
		    const cardMatchesCurrentPrompt = (card) => matchesPromptNeedle(card.text);
		    const cardMatchesCurrentContextPrompt = (card) => matchesContextPromptNeedle(card.text);
		    const cardIsNewSinceBaseline = (card) => Boolean(baselineProvided && card?.tileId && !baselineCardIds.has(card.tileId));
		    const cardChangedSinceBaseline = (card) => {
		      if (!baselineProvided || !card?.tileId || !baselineCardIds.has(card.tileId)) return false;
		      const baselineCard = baselineCardSignatures.get(card.tileId);
		      if (!baselineCard) return false;
		      const before = compact(baselineCard.contentSignature || baselineCard.mediaSignature || baselineCard.mediaText || baselineCard.text || "");
		      return Boolean(before && card.contentSignature && before !== card.contentSignature);
		    };
		    const cardHasCurrentProjectIdentity = (card) =>
		      cardMatchesCurrentMedia(card) ||
		      cardIsNewSinceBaseline(card) ||
		      (!baselineProvided && (cardMatchesCurrentPrompt(card) || cardMatchesCurrentContextPrompt(card))) ||
		      ((cardMatchesCurrentPrompt(card) || cardMatchesCurrentContextPrompt(card)) && cardChangedSinceBaseline(card));
		    const cardMatchesCurrentPromptOrMedia = (card) => cardMatchesCurrentPrompt(card) || cardMatchesCurrentContextPrompt(card) || cardMatchesCurrentMedia(card);
		    const matchingProjectGridMovieQueuedCardsAll = projectGridMovieQueuedCards.filter(cardHasCurrentProjectIdentity);
		    const matchingProjectGridMovieQueuedCards = baselineProvided
		      ? matchingProjectGridMovieQueuedCardsAll.filter((card) => cardMatchesCurrentMedia(card) || cardIsNewSinceBaseline(card) || cardChangedSinceBaseline(card))
		      : matchingProjectGridMovieQueuedCardsAll;
		    const staleProjectGridMovieQueuedCards = baselineProvided
		      ? projectGridMovieQueuedCards.filter((card) => cardMatchesCurrentPromptOrMedia(card) && card.tileId && baselineCardIds.has(card.tileId) && !cardMatchesCurrentMedia(card) && !cardChangedSinceBaseline(card))
		      : [];
		    const newProjectGridMovieQueuedCards = projectGridMovieQueuedCards.filter(cardIsNewSinceBaseline);
		    const changedProjectGridMovieQueuedCards = projectGridMovieQueuedCards.filter(cardChangedSinceBaseline);
		    const summarizeProjectMovieCardCandidate = (card) => {
		      const promptMatch = cardMatchesCurrentPrompt(card);
		      const contextPromptMatch = cardMatchesCurrentContextPrompt(card);
		      const mediaMatch = cardMatchesCurrentMedia(card);
		      const newSinceBaseline = cardIsNewSinceBaseline(card);
		      const changedSinceBaseline = cardChangedSinceBaseline(card);
		      const baselineCard = Boolean(baselineProvided && card.tileId && baselineCardIds.has(card.tileId));
		      const currentIdentity = cardHasCurrentProjectIdentity(card);
		      const movieOrProgress = Boolean(card.videoLike || card.progressLike || card.outputMediaMatch);
		      const strictAccept = Boolean(!card.failedLike && movieOrProgress && currentIdentity);
		      const rejectionReasons = [];
		      if (!strictAccept) {
		        if (card.failedLike) rejectionReasons.push("failed_card");
		        if (!movieOrProgress) rejectionReasons.push("not_movie_or_progress");
		        if (card.referenceUploadLike) rejectionReasons.push("reference_upload_like");
		        if (!currentIdentity) {
		          if (!promptMatch && !contextPromptMatch) rejectionReasons.push("prompt_not_matched");
		          if (mediaNeedles.length && !mediaMatch) rejectionReasons.push("media_id_not_matched");
		          if (baselineProvided && baselineCard && !newSinceBaseline && !changedSinceBaseline) rejectionReasons.push("baseline_card_unchanged");
		          rejectionReasons.push("no_current_task_identity");
		        }
		        if (baselineProvided && baselineCard && (promptMatch || contextPromptMatch) && !mediaMatch && !changedSinceBaseline) {
		          rejectionReasons.push("baseline_prompt_card_stale");
		        }
		      }
		      return {
		        tileId: card.tileId,
		        text: card.text,
		        cardMediaIds: card.cardMediaIds || [],
		        statusLabels: card.statusLabels || [],
		        videoLike: Boolean(card.videoLike),
		        progressLike: Boolean(card.progressLike),
		        failedLike: Boolean(card.failedLike),
		        referenceUploadLike: Boolean(card.referenceUploadLike),
		        outputMediaMatch: Boolean(card.outputMediaMatch),
		        promptMatch,
		        contextPromptMatch,
		        mediaMatch,
		        newSinceBaseline,
		        changedSinceBaseline,
		        baselineCard,
		        currentIdentity,
		        strictAccept,
		        rejectionReasons,
		        rect: card.rect
		      };
		    };
		    const projectMovieCardCandidates = projectGridMovieQueuedCards
		      .slice(0, 16)
		      .map(summarizeProjectMovieCardCandidate);
		    const progressVisible = progressCards.length > 0 || Array.from(document.querySelectorAll("body *"))
		      .some((node) => {
	        if (!visible(node)) return false;
	        const text = String(node.textContent || "");
	        if (!/\\b([1-9]\\d?|100)%\\b|progress_activity|queued/i.test(text)) return false;
	        const tile = node.closest?.("[data-tile-id]");
	        if (tile && failedTextPattern.test(textOf(tile))) return false;
	        return !failedTextPattern.test(text);
	      });
		    return {
		      snapshotAt,
		      promptStillVisible,
		      createDisabled,
	      progressVisible,
	      matchingPromptCardCount: matchingPromptCards.length,
	      matchingMediaCardCount: matchingMediaCards.length,
	      baselineProjectCardIdsProvided: baselineProvided,
	      baselineProjectCardCount: baselineCardIds.size,
	      baselineGenerationProjectCardCount: baselineGenerationCount,
	      nativeChipCount,
	      newProjectCardCount: newProjectCards.length,
	      generationProjectCardCount: Math.max(generationProjectCards.length, generationProjectCardDelta),
	      generatedCardCount: Math.max(generationProjectCards.length, generationProjectCardDelta),
	      totalGenerationProjectCardCount: totalGenerationProjectCards.length,
	      generationProjectCardDelta,
	      galleryDeltaCount: generationProjectCardDelta,
	      projectCardDeltaCount: newProjectCards.length,
	      progressCardCount: progressCards.length,
	      queuedCardCount: queuedCards.length,
	      movieCardCount: movieCards.length,
		      projectGridMovieQueuedCardCount: projectGridMovieQueuedCards.length,
		      matchingProjectGridMovieQueuedCardCount: matchingProjectGridMovieQueuedCards.length,
		      newProjectGridMovieQueuedCardCount: newProjectGridMovieQueuedCards.length,
		      changedProjectGridMovieQueuedCardCount: changedProjectGridMovieQueuedCards.length,
		      staleCardFilteredCount: staleProjectGridMovieQueuedCards.length,
	      failedProjectCardCount: failedProjectCards.length,
	      failedNewProjectCardCount: failedNewProjectCards.length,
	      failedMatchingPromptCardCount: failedMatchingPromptCards.length,
	      failedMatchingMediaCardCount: failedMatchingMediaCards.length,
	      route: location.href,
	      toastText,
	      promptNeedles: promptNeedles.slice(0, 4),
	      contextPromptNeedles: contextPromptNeedles.slice(0, 4),
	      visibleCandidateSelectors: [
	        { selector: "[data-tile-id]", count: projectCards.length },
	        { selector: "button[data-card-open] img", count: nativeChipCount },
	        { selector: "textarea,[contenteditable='true'],[role='textbox']", count: editors.length },
	        { selector: "button,[role='button'] arrow_forward", count: createButtons.length }
	      ],
	      matchingProjectCards: [...matchingMediaCards, ...matchingPromptCards].slice(0, 4).map((card) => ({
	        tileId: card.tileId,
	        text: card.text,
	        failedLike: Boolean(card.failedLike),
	        videoLike: Boolean(card.videoLike),
	        progressLike: Boolean(card.progressLike),
	        referenceUploadLike: Boolean(card.referenceUploadLike),
	        outputMediaMatch: Boolean(card.outputMediaMatch),
	        rect: card.rect
	      })),
	      newProjectCards: newProjectCards.slice(0, 6).map((card) => ({
	        tileId: card.tileId,
	        text: card.text,
	        videoLike: Boolean(card.videoLike),
	        progressLike: Boolean(card.progressLike),
	        failedLike: Boolean(card.failedLike),
	        referenceUploadLike: Boolean(card.referenceUploadLike),
	        rect: card.rect
	      })),
	      generationProjectCards: visibleGenerationProjectCards.slice(0, 6).map((card) => ({
	        tileId: card.tileId,
	        text: card.text,
	        videoLike: Boolean(card.videoLike),
	        progressLike: Boolean(card.progressLike),
	        failedLike: Boolean(card.failedLike),
	        referenceUploadLike: Boolean(card.referenceUploadLike),
	        rect: card.rect
	      })),
		      matchingProjectGridMovieQueuedCards: matchingProjectGridMovieQueuedCards.slice(0, 4).map((card) => ({
		        tileId: card.tileId,
		        text: card.text,
		        cardMediaIds: card.cardMediaIds || [],
		        statusLabels: card.statusLabels || [],
		        videoLike: Boolean(card.videoLike),
		        progressLike: Boolean(card.progressLike),
		        failedLike: Boolean(card.failedLike),
	        referenceUploadLike: Boolean(card.referenceUploadLike),
		        outputMediaMatch: Boolean(card.outputMediaMatch),
		        rect: card.rect
		      })),
		      projectMovieCardCandidates,
		      acceptedProjectMovieCardCandidates: projectMovieCardCandidates.filter((card) => card.strictAccept).slice(0, 8),
		      rejectedProjectMovieCardCandidates: projectMovieCardCandidates.filter((card) => !card.strictAccept).slice(0, 12),
		      failedProjectCards: failedProjectCards.slice(0, 4).map((card) => ({
		        tileId: card.tileId,
	        text: card.text,
	        videoLike: Boolean(card.videoLike),
	        progressLike: Boolean(card.progressLike),
		        rect: card.rect
		      })),
		      projectCardIds: projectCards.map((card) => card.tileId).filter(Boolean),
		      projectCardSignatures: projectCards.map((card) => ({
		        tileId: card.tileId,
		        text: card.text,
		        cardMediaIds: card.cardMediaIds || [],
		        videoLike: Boolean(card.videoLike),
		        progressLike: Boolean(card.progressLike),
		        failedLike: Boolean(card.failedLike),
		        referenceUploadLike: Boolean(card.referenceUploadLike),
		        mediaSignature: card.mediaSignature,
		        contentSignature: card.contentSignature
		      })),
		      editors: editors.slice(-4),
		      createButtons: createButtons.slice(-4)
		    };
		  })(${promptJson}, ${promptNeedlesJson}, ${contextPromptNeedlesJson}, ${modeJson}, ${mediaIdsJson}, ${baselineProjectCardIdsJson}, ${baselineProjectCardSignaturesJson}, ${baselineGenerationProjectCardCountJson})`).catch((error) => ({ ok: false, error: String(error?.message || error) }));
}

async function waitForFrontSubmitTransition(target, task = {}, timeoutMs = 7000, options = {}) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 7000));
  const requireStrongProof = Boolean(options.requireStrongProof);
  const mode = String(task?.mode || "");
  const isVideoMode = ["text-to-video", "image-to-video", "start-end-image-to-video", "ingredients-to-video"].includes(mode);
  const isOmniStrictProofMode = requireStrongProof && debuggerIsOmniIngredientsTask(task);
  let last = null;
  while (Date.now() < deadline) {
    last = await debuggerFrontSubmitSnapshot(target, task, options);
    const hasVisibleGenerationProof = frontSubmitSnapshotHasVisibleGenerationProof(last || {}, task);
    const failedOnlyVideoCard = isVideoMode && frontSubmitSnapshotHasAnyFailedCard(last || {}) && !hasVisibleGenerationProof;
    const mediaDetailRouteOnly = frontSubmitSnapshotIsMediaDetailEditorRoute(last || {});
    const wrongModeVideoEditRoute = !isVideoMode && frontSubmitSnapshotIsVideoContinuationEditRoute(last || {});
    const videoEditRouteOnly = isVideoMode && frontSubmitSnapshotIsVideoContinuationEditRoute(last || {}) && !hasVisibleGenerationProof;
    if (mediaDetailRouteOnly) {
      return { ok: false, reason: "media_detail_editor_after_submit", snapshot: last };
    }
    if (wrongModeVideoEditRoute) {
      return { ok: false, reason: "wrong_mode_video_edit_route_after_submit", snapshot: last };
    }
    if (videoEditRouteOnly) {
      return { ok: false, reason: "video_edit_route_after_submit", snapshot: last };
    }
    if (last && last.promptStillVisible === false && !requireStrongProof && !isVideoMode) {
      return { ok: true, reason: "prompt_cleared_or_replaced", snapshot: last };
    }
    if (frontSubmitSnapshotHasOmniVisibleProjectMovieCard(last || {}, task)) {
      return { ok: true, reason: "omni_project_grid_movie_card_visible_after_submit", snapshot: last };
    }
    if (last?.matchingMediaCardCount > 0 || last?.matchingPromptCardCount > 0) {
      return {
        ok: true,
        reason: last.matchingMediaCardCount > 0 ? "project_media_card_visible_after_submit" : "project_prompt_card_visible_after_submit",
        snapshot: last
      };
    }
    if (last?.baselineProjectCardIdsProvided && frontSubmitNewProjectCardCount(last, task) > 0) {
      return { ok: true, reason: "new_project_card_visible_after_submit", snapshot: last };
    }
    if (last?.createDisabled || last?.progressVisible) {
      if (failedOnlyVideoCard) {
        await sleep(260);
        continue;
      }
      if (isOmniStrictProofMode && !frontSubmitSnapshotHasOmniVisibleProjectMovieCard(last || {}, task)) {
        await sleep(260);
        continue;
      }
      return { ok: true, reason: last.createDisabled ? "create_disabled_after_submit" : "progress_visible_after_submit", snapshot: last };
    }
    await sleep(260);
  }
  return {
    ok: false,
    reason: frontSubmitSnapshotHasAnyFailedCard(last || {}) && !frontSubmitSnapshotHasVisibleGenerationProof(last || {}, task)
      ? "failed_project_card_visible_after_submit"
      : last?.promptStillVisible === false && requireStrongProof
      ? "strong_front_proof_not_visible_after_prompt_cleared"
      : "prompt_still_visible_after_submit",
    snapshot: last
  };
}

function frontSubmitNewProjectCardCount(snapshot = {}, task = {}) {
  const mode = String(task?.mode || "");
  const isVideoMode = ["text-to-video", "image-to-video", "start-end-image-to-video", "ingredients-to-video"].includes(mode);
  return Number((isVideoMode ? snapshot.generationProjectCardCount : snapshot.newProjectCardCount) || 0);
}

function frontSubmitTransitionHasStrongProof(frontTransition = {}, task = {}) {
  if (!frontTransition?.ok) return false;
  const reason = String(frontTransition.reason || "");
  const snapshot = frontTransition.snapshot || {};
  const hasVisibleGenerationProof = frontSubmitSnapshotHasVisibleGenerationProof(snapshot, task);
  if (frontSubmitSnapshotHasAnyFailedCard(snapshot) && !hasVisibleGenerationProof) return false;
  if (debuggerIsOmniIngredientsTask(task)) {
    return frontSubmitSnapshotHasOmniVisibleProjectMovieCard(snapshot, task);
  }
  if (/project_(media|prompt)_card_visible_after_submit|progress_visible_after_submit|dom_response_confirmed_without_front_transition/i.test(reason)) {
    return true;
  }
  if (/create_disabled_after_submit/i.test(reason)) {
    return true;
  }
  if (/new_project_card_visible_after_submit/i.test(reason) && frontSubmitNewProjectCardCount(snapshot, task) <= 0) return false;
  return hasVisibleGenerationProof
    || Boolean(snapshot.createDisabled);
}

function frontSubmitTransitionHasActiveProgressProof(frontTransition = {}) {
  if (!frontTransition?.ok) return false;
  const snapshot = frontTransition.snapshot || {};
  return Number(snapshot.progressCardCount || 0) > 0 || Boolean(snapshot.progressVisible);
}

async function debuggerRevealFrontSubmitProofCard(target, task = {}, frontTransition = {}, options = {}) {
  if (!frontTransition?.ok) return { ok: false, reason: "front_transition_not_ok" };
  const snapshot = frontTransition.snapshot || {};
  const candidateTileIds = [
    ...(Array.isArray(snapshot.matchingProjectCards) ? snapshot.matchingProjectCards : []),
    ...(Array.isArray(snapshot.generationProjectCards) ? snapshot.generationProjectCards : []),
    ...(Array.isArray(snapshot.newProjectCards) ? snapshot.newProjectCards : [])
  ].map((card) => String(card?.tileId || "").trim()).filter(Boolean);
  const promptJson = JSON.stringify(String(task.prompt || "").replace(/\s+/g, " ").trim());
  const modeJson = JSON.stringify(String(task.mode || ""));
  const mediaIdsJson = JSON.stringify(mediaIdsFrom(options.mediaIds || []));
  const candidateTileIdsJson = JSON.stringify([...new Set(candidateTileIds)]);
  return debuggerEvaluate(target, `((expectedPrompt, expectedMode, expectedMediaIds, candidateTileIds) => {
    const compact = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const rendered = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
    };
    const inViewport = (rect) => (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
    const rectOf = (node) => {
      const rect = node.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        right: Math.round(rect.right)
      };
    };
    const variantsForId = (value) => {
      const raw = compact(value);
      if (!raw) return [];
      const withoutPrefix = raw.replace(/^fe_id_/i, "");
      const withPrefix = /^fe_id_/i.test(raw) ? raw : "fe_id_" + raw;
      return [...new Set([raw, withoutPrefix, withPrefix].filter(Boolean))];
    };
    const promptNeedle = compact(expectedPrompt).slice(0, 120);
    const mediaNeedles = Array.isArray(expectedMediaIds)
      ? expectedMediaIds.flatMap(variantsForId).filter(Boolean)
      : [];
    const candidateIds = new Set(Array.isArray(candidateTileIds) ? candidateTileIds.map(compact).filter(Boolean) : []);
    const isVideoMode = ["text-to-video", "image-to-video", "start-end-image-to-video", "ingredients-to-video"].includes(String(expectedMode || ""));
    const cards = Array.from(document.querySelectorAll("[data-tile-id]"))
      .filter(rendered)
      .map((node) => {
        const text = compact(node.innerText || node.textContent || "");
        const tileId = compact(node.getAttribute("data-tile-id") || "");
        const img = node.querySelector("img");
        const mediaText = [
          tileId,
          text,
          img?.currentSrc || "",
          img?.src || "",
          node.getAttribute("href") || "",
          node.querySelector("a[href]")?.getAttribute("href") || ""
        ].map(compact).join(" ");
        const videoLike = /play_circle|\\bvideo\\b/i.test(text) || Boolean(node.querySelector("video"));
        const progressLike = /\\b([1-9]\\d?|100)%\\b|progress_activity|generating|loading|queued/i.test(text);
        const failedLike = /\\bfailed\\b|\\berror\\b|something went wrong|warning/i.test(text);
        const referenceUploadLike = !videoLike && !progressLike && (/\\bimage\\b/i.test(text) || /\\.(?:png|jpe?g|webp)\\b/i.test(text));
        const mediaMatch = mediaNeedles.some((needle) => needle && mediaText.includes(needle));
        const promptMatch = Boolean(promptNeedle && compact(text).includes(promptNeedle));
        const tileMatch = Boolean(tileId && candidateIds.has(tileId));
        const videoGenerationMatch = !isVideoMode || videoLike || progressLike;
        let score = 0;
        if (mediaMatch) score += 1000;
        if (promptMatch) score += 800;
        if (tileMatch) score += 600;
        if (videoLike || progressLike) score += 120;
        if (referenceUploadLike) score -= 250;
        if (failedLike) score -= 1200;
        if (isVideoMode && !videoGenerationMatch) score -= 500;
        if (isVideoMode && failedLike) score = -100000;
        return {
          node,
          tileId,
          text: text.slice(0, 160),
          mediaMatch,
          promptMatch,
          tileMatch,
          videoLike,
          progressLike,
          failedLike,
          referenceUploadLike,
          score,
          rect: rectOf(node)
        };
      })
      .filter((card) => card.score > 0)
      .sort((a, b) => b.score - a.score);
    const card = cards[0];
    if (!card) return { ok: false, reason: "proof_card_not_found", promptNeedle, candidateTileIds: [...candidateIds].slice(0, 8) };
    const before = card.rect;
    const beforeInViewport = inViewport(before);
    if (!beforeInViewport) {
      try { card.node.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch {}
      const afterFirst = rectOf(card.node);
      if (!inViewport(afterFirst)) {
        const targetTop = Math.max(0, window.scrollY + afterFirst.top - Math.round(window.innerHeight * 0.34));
        try { window.scrollTo({ top: targetTop, behavior: "instant" }); } catch { window.scrollTo(0, targetTop); }
      }
    }
    const after = rectOf(card.node);
    return {
      ok: inViewport(after),
      reason: inViewport(after) ? (beforeInViewport ? "already_in_viewport" : "scrolled_to_proof_card") : "proof_card_still_offscreen",
      tileId: card.tileId,
      text: card.text,
      score: card.score,
      mediaMatch: card.mediaMatch,
      promptMatch: card.promptMatch,
      tileMatch: card.tileMatch,
      videoLike: card.videoLike,
      progressLike: card.progressLike,
      failedLike: card.failedLike,
      referenceUploadLike: card.referenceUploadLike,
      beforeInViewport,
      afterInViewport: inViewport(after),
      before,
      after,
      scrollY: Math.round(window.scrollY)
    };
  })(${promptJson}, ${modeJson}, ${mediaIdsJson}, ${candidateTileIdsJson})`).catch((error) => ({ ok: false, reason: "reveal_eval_failed", error: String(error?.message || error) }));
}

function frontSubmitTransitionProvesGeneration(frontTransition = {}, task = {}) {
  if (!frontTransition?.ok) return false;
  const snapshot = frontTransition.snapshot || {};
  const hasVisibleGenerationProof = frontSubmitSnapshotHasVisibleGenerationProof(snapshot, task);
  if (frontSubmitSnapshotHasAnyFailedCard(snapshot) && !hasVisibleGenerationProof) return false;
  return hasVisibleGenerationProof
    || Boolean(snapshot.createDisabled);
}

function statusFeedVisibleRepairSnapshotHasProof(snapshot = {}) {
  const hasVisibleGenerationProof = Number(snapshot.matchingMediaCardCount || 0) > 0
    || Number(snapshot.matchingPromptCardCount || 0) > 0
    || Number(snapshot.progressCardCount || 0) > 0
    || Boolean(snapshot.progressVisible)
  if (frontSubmitSnapshotHasAnyFailedCard(snapshot) && !hasVisibleGenerationProof) return false;
  return hasVisibleGenerationProof || Boolean(snapshot.createDisabled);
}

function compactDiagnosticText(value = "", limit = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...[truncated:${text.length}]` : text;
}

function collectFlowErrorFields(value, out = {}, depth = 0) {
  if (value == null || depth > 5) return out;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (!out.message) out.message = compactDiagnosticText(value, 180);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFlowErrorFields(item, out, depth + 1);
    return out;
  }
  if (typeof value !== "object") return out;
  for (const key of ["reason", "status", "code", "message"]) {
    const text = compactDiagnosticText(value[key], key === "message" ? 180 : 80);
    if (text && !out[key]) out[key] = text;
  }
  collectFlowErrorFields(value.error, out, depth + 1);
  collectFlowErrorFields(value.details, out, depth + 1);
  return out;
}

function summarizeFlowError(data, text = "") {
  const summary = collectFlowErrorFields(data, {});
  const rawText = String(text || "");
  return {
    ...summary,
    bodyLength: rawText.length,
    bodyPreview: compactDiagnosticText(rawText, 240)
  };
}

function flowErrorDiagnostic(flowError = {}) {
  return [flowError.reason, flowError.status, flowError.code, flowError.message]
    .map((value) => compactDiagnosticText(value, 80))
    .filter(Boolean)
    .join(" ");
}

function domSubmitRejectedError(status = 0, flowError = {}) {
  const httpStatus = Number(status || 0);
  if (httpStatus < 400) return "";
  const diagnostic = flowErrorDiagnostic(flowError);
  return diagnostic ? `DOM_SUBMIT_REJECTED_${httpStatus}:${diagnostic}` : `DOM_SUBMIT_REJECTED_${httpStatus}`;
}

function normalizeDomSubmitFailureError(response = {}, fallback = "request_not_observed") {
  const status = Number(response?.status || 0);
  const rejected = domSubmitRejectedError(status, response?.flowError || {});
  if (rejected) return rejected;
  const error = String(response?.error || fallback || "request_not_observed");
  if (/^DOM_DEBUGGER_/i.test(error) || /^DOM_SUBMIT_REJECTED_/i.test(error)) return error;
  if (/^DOM_/i.test(error) && status <= 0) return `DOM_DEBUGGER_REQUEST_NOT_OBSERVED:${error}`;
  return error;
}

function debuggerObservedFailureResponse(...responses) {
  const candidates = responses.filter((response) => response && typeof response === "object");
  const rejected = candidates.find((response) => domSubmitRejectedError(response?.status || 0, response?.flowError || {}));
  if (rejected) return rejected;
  const httpFailure = candidates.find((response) => Number(response?.status || 0) >= 400);
  if (httpFailure) return httpFailure;
  const observedRequest = candidates.find((response) => Number(response?.status || 0) > 0
    || Boolean(response?.endpoint)
    || Boolean(response?.serializedRefs)
    || Number(response?.capturedResponseCount || 0) > 0);
  if (observedRequest) return observedRequest;
  return candidates.find((response) => {
    const error = String(response?.error || response?.statusText || "");
    return error && !/REQUEST_NOT_OBSERVED|NO_REQUEST|request_not_observed|DOM_SUBMIT_MEDIA_IDS_NOT_CAPTURED/i.test(error);
  }) || null;
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
        const flowError = summarizeFlowError(data, text);
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
        responseBodies.push({ status: params.response?.status || 0, url: params.response?.url || "", mediaIds, outputRows, data, flowError, error: domSubmitRejectedError(params.response?.status || 0, flowError) });
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
    const observedFailure = [...responseBodies].reverse().find((row) => Number(row.status || 0) > 0 || row.error);
    if (observedFailure) {
      return {
        ...observedFailure,
        mediaIds: [],
        outputRows: [],
        responseCount: responseBodies.length,
        expectedCount: requiredCount,
        error: normalizeDomSubmitFailureError(observedFailure, observedFailure.error || "DOM_SUBMIT_MEDIA_IDS_NOT_CAPTURED")
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
    async repairStatusFeedOnlySubmitVisibility(tabId, task = {}, result = {}) {
      if (!debuggerShouldRepairStatusFeedOnlySubmitVisibility(task)) {
        return { ok: true, skipped: true, reason: "not_required_for_mode" };
      }
      const mediaIds = mediaIdsFrom(result.mediaIds || result.data?.mediaIds || []);
      if (!mediaIds.length) {
        return { ok: false, reason: "missing_status_feed_media_ids", mediaIds };
      }
      let target = debuggerTarget(tabId);
      try {
        const attachment = await ensureDebuggerAttached(tabId, recordTrace, task);
        target = attachment.target;
        await ensureNetworkEnabled(tabId, target);
        const recordOmniStatusFeedVisibleRepair = (source, snapshot = {}, extra = {}) => {
          if (!debuggerIsOmniIngredientsTask(task)) return;
          if (!frontSubmitSnapshotHasOmniVisibleProjectMovieCard(snapshot, task)) return;
          recordTrace(task, "omni_visible_project_movie_card_seen", {
            strictDomGreen: true,
            strictDomGreenReason: "omni_visible_project_movie_card_seen",
            source,
            mediaIds,
            route: snapshot.route || "",
            matchingMediaCardCount: Number(snapshot.matchingMediaCardCount || 0),
            matchingPromptCardCount: Number(snapshot.matchingPromptCardCount || 0),
            projectGridMovieQueuedCardCount: Number(snapshot.projectGridMovieQueuedCardCount || 0),
            matchingProjectGridMovieQueuedCardCount: Number(snapshot.matchingProjectGridMovieQueuedCardCount || 0),
            staleCardFilteredCount: Number(snapshot.staleCardFilteredCount || 0),
            matchingProjectGridMovieQueuedCards: snapshot.matchingProjectGridMovieQueuedCards || [],
            ...extra
          });
        };
        const baseline = await debuggerFrontSubmitSnapshot(target, task, { mediaIds })
          .catch((error) => ({ ok: false, error: String(error?.message || error) }));
        const baselineProjectCardIds = Array.isArray(baseline?.projectCardIds) ? baseline.projectCardIds : [];
        const baselineProjectCardSignatures = Array.isArray(baseline?.projectCardSignatures) ? baseline.projectCardSignatures : [];
        const baselineGenerationProjectCardCount = Number(baseline?.totalGenerationProjectCardCount ?? baseline?.generationProjectCardCount ?? 0) || 0;
        recordTrace(task, "status_feed_visible_repair_start", {
          mediaIds,
          baselineProjectCardCount: baselineProjectCardIds.length,
          baselineProjectCardSignatureCount: baselineProjectCardSignatures.length,
          baselineGenerationProjectCardCount,
          promptStillVisible: Boolean(baseline?.promptStillVisible),
          matchingMediaCardCount: Number(baseline?.matchingMediaCardCount || 0)
        });
        const alreadyVisible = statusFeedVisibleRepairSnapshotHasProof(baseline);
        if (alreadyVisible) {
          recordTrace(task, "status_feed_visible_repair_result", {
            ok: true,
            skippedReload: true,
            reason: "already_visible",
            mediaIds,
            matchingMediaCardCount: Number(baseline?.matchingMediaCardCount || 0),
            matchingPromptCardCount: Number(baseline?.matchingPromptCardCount || 0),
            generationProjectCardCount: Number(baseline?.generationProjectCardCount || 0),
            progressCardCount: Number(baseline?.progressCardCount || 0),
            progressVisible: Boolean(baseline?.progressVisible),
            createDisabled: Boolean(baseline?.createDisabled)
          });
          recordOmniStatusFeedVisibleRepair("status_feed_visible_repair_already_visible", baseline, {
            skippedReload: true,
            reloadOk: false
          });
          return { ok: true, skippedReload: true, reason: "already_visible", snapshot: baseline, mediaIds };
        }
        const reloadResult = await debuggerSend(target, "Page.reload", { ignoreCache: false })
          .then(() => ({ ok: true }))
          .catch((error) => ({ ok: false, error: String(error?.message || error || "PAGE_RELOAD_FAILED") }));
        if (reloadResult.ok) {
          await sleep(4200);
        }
        const repaired = reloadResult.ok
          ? await waitForFrontSubmitTransition(target, task, debuggerPostResponseFrontProofWaitMs(task), {
	              mediaIds,
	              baselineProjectCardIds,
	              baselineProjectCardSignatures,
	              baselineGenerationProjectCardCount,
	              requireStrongProof: true
	            })
          : { ok: false, reason: "reload_failed", error: reloadResult.error, snapshot: null };
        recordTrace(task, "status_feed_visible_repair_result", {
          ok: Boolean(repaired?.ok),
          reloadOk: Boolean(reloadResult.ok),
          reloadError: reloadResult.error || "",
          reason: repaired?.reason || "",
          mediaIds,
          promptStillVisible: Boolean(repaired?.snapshot?.promptStillVisible),
          createDisabled: Boolean(repaired?.snapshot?.createDisabled),
          progressVisible: Boolean(repaired?.snapshot?.progressVisible),
          matchingMediaCardCount: Number(repaired?.snapshot?.matchingMediaCardCount || 0),
          matchingPromptCardCount: Number(repaired?.snapshot?.matchingPromptCardCount || 0),
          generationProjectCardCount: Number(repaired?.snapshot?.generationProjectCardCount || 0),
          progressCardCount: Number(repaired?.snapshot?.progressCardCount || 0),
          matchingProjectCards: repaired?.snapshot?.matchingProjectCards || [],
          generationProjectCards: repaired?.snapshot?.generationProjectCards || []
        });
        recordOmniStatusFeedVisibleRepair("status_feed_visible_repair_after_reload", repaired?.snapshot || {}, {
          reloadOk: Boolean(reloadResult.ok),
          reloadError: reloadResult.error || "",
          reason: repaired?.reason || ""
        });
        return {
          ok: frontSubmitTransitionHasStrongProof(repaired, task),
          reason: repaired?.reason || "",
          reloadOk: Boolean(reloadResult.ok),
          reloadError: reloadResult.error || "",
          snapshot: repaired?.snapshot || null,
          mediaIds
        };
      } catch (error) {
        const message = String(error?.message || error || "status_feed_visible_repair_failed");
        recordTrace(task, "status_feed_visible_repair_result", {
          ok: false,
          error: message,
          mediaIds
        });
        return { ok: false, error: message, mediaIds };
      }
    },

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
        const initialDetailClose = await debuggerCloseImageDetailIfOpen(target);
        recordTrace(task, "detail_editor_close_before_prep", {
          ok: Boolean(initialDetailClose?.ok),
          closed: Boolean(initialDetailClose?.closed),
          method: initialDetailClose?.method || "",
          reason: initialDetailClose?.reason || "",
          error: initialDetailClose?.error || ""
        });
        if (initialDetailClose?.closed) {
          await sleep(1800);
        } else if (initialDetailClose?.ok === false) {
          return {
            ok: false,
            status: 0,
            statusText: "DOM_DEBUGGER_IMAGE_DETAIL_EDITOR_OPEN",
            error: "DOM_DEBUGGER_IMAGE_DETAIL_EDITOR_OPEN",
            data: { initialDetailClose, transport: "chrome_debugger" }
          };
        }

        const pageCommandTimeoutMs = (stage = "", metaPatch = {}) => debuggerPageCommandTimeoutMs(task, meta, stage, metaPatch);
        const prepareForDebugger = async (stage = "prep", metaPatch = {}, timeoutMs = pageCommandTimeoutMs(stage, metaPatch)) => {
          let preparedResult = null;
          if (Number(timeoutMs || 0) > 120000) {
            recordTrace(task, `${stage}_page_command_timeout_budget`, {
              timeoutMs,
              apiBackendFallback: meta?.apiBackendFallback === true,
              afterPromptInsert: metaPatch?.afterPromptInsert === true,
              mode: String(task.mode || "")
            });
          }
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
              const prep = await sendPageCommand({
                action: "domPrepareTaskForDebugger",
                task,
                meta: {
                  ...meta,
                  debuggerTransport: true,
                  skipDomModeAndSettingsMutation: true,
                  ...metaPatch
                },
                timeoutMs
              }, tabId);
              preparedResult = prep?.result?.result || prep?.result || prep;
            } catch (error) {
              const message = String(error?.message || error || "DOM_DEBUGGER_PREP_FAILED");
              preparedResult = {
                ok: false,
                action: "domPrepareTaskForDebugger",
                error: message,
                statusText: message
              };
            }
            const error = String(preparedResult?.error || "");
            if (debuggerShouldReloadApiBackendFallbackComposer(preparedResult, meta)) {
              return preparedResult;
            }
            if (debuggerIsPostUploadSettleError(error)) {
              recordTrace(task, `${stage}_upload_retry_blocked_after_side_effect`, {
                attempt,
                error,
                failureClass: "composer_upload_not_settled_after_upload",
                healAction: "upload_retry_blocked_after_side_effect"
              });
              return preparedResult;
            }
            if (preparedResult?.ok !== false || !debuggerIsFlowLoadingPrepError(error) || attempt >= 3) {
              return preparedResult;
            }
            const waitMs = 2200 + attempt * 1800;
            recordTrace(task, `${stage}_flow_loading_retry`, {
              attempt,
              waitMs,
              error,
              problems: preparedResult?.problems || null
            });
            await sleep(waitMs);
          }
          return preparedResult;
        };

        let prepared = await prepareForDebugger("prep_initial", {
          skipDomModeAndSettingsMutation: !debuggerShouldUsePageVisibleSettingsMutation(task)
        });
        if (prepared && typeof prepared === "object") {
          prepared.taskId = task?.id || "";
          prepared.mode = task?.mode || "";
        }
        recordTrace(task, "prep_result", {
          ok: Boolean(prepared?.ok),
          error: prepared?.error || "",
          editorRect: prepared?.editorRect || null,
          createRect: prepared?.createRect || null,
          selector: prepared?.selector || "",
          strategy: prepared?.strategy || ""
        });
        if (!prepared?.ok && debuggerShouldReloadApiBackendFallbackComposer(prepared, meta)) {
          recordTrace(task, "api_backend_fallback_composer_reload_start", {
            error: prepared?.error || "",
            problems: prepared?.ready?.snapshot?.problems || [],
            reason: "api_backend_500_poisoned_create_button"
          });
          const reloadResult = await debuggerSend(target, "Page.reload", { ignoreCache: false })
            .then(() => ({ ok: true }))
            .catch((error) => ({ ok: false, error: String(error?.message || error || "PAGE_RELOAD_FAILED") }));
          recordTrace(task, "api_backend_fallback_composer_reload_result", {
            ok: Boolean(reloadResult.ok),
            error: reloadResult.error || ""
          });
          if (reloadResult.ok) {
            await sleep(4200);
            const retryPrepared = await prepareForDebugger("prep_api_backend_fallback_after_reload", {
              skipDomModeAndSettingsMutation: !debuggerShouldUsePageVisibleSettingsMutation(task),
              apiBackendFallbackReloaded: true
            });
            if (retryPrepared && typeof retryPrepared === "object") {
              retryPrepared.taskId = task?.id || "";
              retryPrepared.mode = task?.mode || "";
            }
            recordTrace(task, "api_backend_fallback_composer_reload_prep_result", {
              ok: Boolean(retryPrepared?.ok),
              error: retryPrepared?.error || "",
              editorRect: retryPrepared?.editorRect || null,
              createRect: retryPrepared?.createRect || null,
              selector: retryPrepared?.selector || "",
              strategy: retryPrepared?.strategy || ""
            });
            if (retryPrepared) prepared = retryPrepared;
          }
        }
        if (!prepared?.ok) {
          const error = prepared?.error || "DOM_DEBUGGER_PREP_FAILED";
          return {
            ok: false,
            status: Number(prepared?.status || 0),
            statusText: /^DOM_DEBUGGER_/i.test(error) || /^COMPOSER_/i.test(error) || /^FLOW_/i.test(error) ? error : `DOM_DEBUGGER_PREP_FAILED:${error}`,
            error: /^DOM_DEBUGGER_/i.test(error) || /^COMPOSER_/i.test(error) || /^FLOW_/i.test(error) ? error : `DOM_DEBUGGER_PREP_FAILED:${error}`,
            data: { ...(prepared || {}), transport: "chrome_debugger" }
          };
        }

        if (debuggerShouldUsePathCNativeCharacterEntry(task)) {
          const cleanProjectComposer = await ensureCleanProjectComposerForTask({ target, task, prepared });
          recordTrace(task, "path_c_clean_project_composer_preflight", cleanProjectComposer);
          if (!cleanProjectComposer.ok) {
            const error = cleanProjectComposer.failureClass || "path_c_wrong_flow_surface";
            return {
              ok: false,
              status: 0,
              statusText: `DOM_DEBUGGER_SETTINGS_FAILED:${error}`,
              error: `DOM_DEBUGGER_SETTINGS_FAILED:${error}`,
              data: { prepared, cleanProjectComposer, transport: "chrome_debugger" }
            };
          }
          if (cleanProjectComposer.navigationAttempted) {
            const cleanPrepared = await prepareForDebugger("prep_after_clean_project_composer", {
              skipDomModeAndSettingsMutation: !debuggerShouldUsePageVisibleSettingsMutation(task),
              afterCleanProjectComposer: true
            });
            if (cleanPrepared && typeof cleanPrepared === "object") {
              cleanPrepared.taskId = task?.id || "";
              cleanPrepared.mode = task?.mode || "";
            }
            recordTrace(task, "prep_after_clean_project_composer", {
              ok: Boolean(cleanPrepared?.ok),
              error: cleanPrepared?.error || "",
              editorRect: cleanPrepared?.editorRect || null,
              createRect: cleanPrepared?.createRect || null,
              selector: cleanPrepared?.selector || "",
              strategy: cleanPrepared?.strategy || "",
              projectId: cleanPrepared?.projectId || ""
            });
            if (!cleanPrepared?.ok) {
              const error = cleanPrepared?.error || "DOM_DEBUGGER_PREP_FAILED_AFTER_CLEAN_PROJECT_COMPOSER";
              return {
                ok: false,
                status: Number(cleanPrepared?.status || 0),
                statusText: /^DOM_DEBUGGER_/i.test(error) || /^COMPOSER_/i.test(error) || /^FLOW_/i.test(error) ? error : `DOM_DEBUGGER_PREP_FAILED:${error}`,
                error: /^DOM_DEBUGGER_/i.test(error) || /^COMPOSER_/i.test(error) || /^FLOW_/i.test(error) ? error : `DOM_DEBUGGER_PREP_FAILED:${error}`,
                data: { prepared, cleanProjectComposer, cleanPrepared, transport: "chrome_debugger" }
              };
            }
            prepared = cleanPrepared;
          }
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
        const refreshedPrepared = await prepareForDebugger("prep_after_settings", {
          afterDebuggerSettings: true,
          skipDebuggerAttach: attachRefsAfterPromptInsert
        });
        if (refreshedPrepared?.ok) {
          prepared.editorRect = refreshedPrepared.editorRect || prepared.editorRect;
          prepared.createRect = refreshedPrepared.createRect || prepared.createRect;
          prepared.selector = refreshedPrepared.selector || prepared.selector;
          prepared.strategy = refreshedPrepared.strategy || prepared.strategy;
          prepared.attachOutcome = refreshedPrepared.attachOutcome?.preSubmitRefs
            ? refreshedPrepared.attachOutcome
            : (prepared.attachOutcome || refreshedPrepared.attachOutcome);
        }
        recordTrace(task, "prep_refreshed", {
          ok: Boolean(refreshedPrepared?.ok),
          error: refreshedPrepared?.error || "",
          editorRect: prepared.editorRect || null,
          createRect: prepared.createRect || null,
          selector: prepared.selector || "",
          strategy: prepared.strategy || ""
        });

        let activeSettings = settings;
        const refreshedPreparedForSettings = refreshedPrepared?.ok
          ? debuggerPreparedWithNativeFrameSlotProof(refreshedPrepared, prepared, task)
          : prepared;
        let settingsProblems = debuggerPreparedSettingsProblems(refreshedPreparedForSettings, task, activeSettings);
        if (settingsProblems.length && debuggerShouldReseatVisibleSettingsAfterAttach(task)) {
          recordTrace(task, "settings_visible_reseat_start", {
            problems: settingsProblems,
            reason: "post_attach_visible_settings_reseat"
          });
          const reseatSettings = await applyModeAndSettings({ target, task, trace: recordTrace });
          activeSettings = reseatSettings?.ok ? reseatSettings : activeSettings;
          recordTrace(task, "settings_visible_reseat_result", {
            ok: Boolean(reseatSettings?.ok),
            error: reseatSettings?.error || "",
            aspect: reseatSettings?.aspect || "",
            repeat: reseatSettings?.repeat || "",
            duration: reseatSettings?.duration || "",
            model: reseatSettings?.model || ""
          });
          if (!reseatSettings?.ok) {
            const error = reseatSettings?.error || "settings_visible_reseat_failed";
            return {
              ok: false,
              status: 0,
              statusText: `DOM_DEBUGGER_SETTINGS_FAILED:${error}`,
              error: `DOM_DEBUGGER_SETTINGS_FAILED:${error}`,
              data: { prepared, settingsProblems, reseatSettings, transport: "chrome_debugger" }
            };
          }
          const reseatedPrepared = await prepareForDebugger("prep_after_visible_settings_reseat", {
            afterDebuggerSettings: true,
            skipDebuggerAttach: true,
            afterVisibleSettingsReseat: true
          });
          if (reseatedPrepared?.ok) {
            prepared.editorRect = reseatedPrepared.editorRect || prepared.editorRect;
            prepared.createRect = reseatedPrepared.createRect || prepared.createRect;
            prepared.selector = reseatedPrepared.selector || prepared.selector;
            prepared.strategy = reseatedPrepared.strategy || prepared.strategy;
            prepared.attachOutcome = reseatedPrepared.attachOutcome?.preSubmitRefs
              ? reseatedPrepared.attachOutcome
              : (prepared.attachOutcome || reseatedPrepared.attachOutcome);
            prepared.visible = reseatedPrepared.visible || prepared.visible;
            prepared.store = reseatedPrepared.store || prepared.store;
            prepared.createButton = reseatedPrepared.createButton || prepared.createButton;
            prepared.expected = reseatedPrepared.expected || prepared.expected;
          }
          const reseatedPreparedForSettings = reseatedPrepared?.ok
            ? debuggerPreparedWithNativeFrameSlotProof(reseatedPrepared, prepared, task)
            : prepared;
          settingsProblems = debuggerPreparedSettingsProblems(reseatedPreparedForSettings, task, activeSettings);
          recordTrace(task, "settings_visible_reseat_verified", {
            ok: Boolean(reseatedPrepared?.ok) && settingsProblems.length === 0,
            error: reseatedPrepared?.error || "",
            problems: settingsProblems,
            selectedVideoDuration: prepared.store?.selectedVideoDuration ?? null,
            videoApi: prepared.store?.currentModelKeys?.videoApi || "",
            videoModelKey: prepared.store?.currentModelKeys?.videoModelKey || ""
          });
        }
        if (settingsProblems.length) {
          if (debuggerShouldAvoidHiddenSettingsStoreRepair(task) || debuggerShouldFailClosedOnSettingsProblems(task)) {
            const avoidHiddenRepair = debuggerShouldAvoidHiddenSettingsStoreRepair(task);
            const failClosed = debuggerShouldFailClosedOnSettingsProblems(task);
            recordTrace(task, failClosed ? "settings_state_repair_blocked_for_visible_mode" : "settings_state_repair_skipped_for_frame_mode", {
              problems: settingsProblems,
              reason: failClosed ? "manual_visible_ref_submit_only" : "manual_visible_frame_submit_only",
              selectedVideoDuration: prepared.store?.selectedVideoDuration ?? null,
              videoApi: prepared.store?.currentModelKeys?.videoApi || "",
              videoModelKey: prepared.store?.currentModelKeys?.videoModelKey || ""
            });
            if (failClosed || avoidHiddenRepair) {
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
            timeoutMs: pageCommandTimeoutMs("settings_state_repair", { afterSettingsStateRepair: true })
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
          const afterSyncPrepared = await prepareForDebugger("prep_after_settings_repair", {
            afterDebuggerSettings: true,
            skipDebuggerAttach: true,
            skipPostUploadSettle: false,
            afterSettingsStateRepair: true
          });
          if (afterSyncPrepared?.ok) {
            prepared.editorRect = afterSyncPrepared.editorRect || prepared.editorRect;
            prepared.createRect = afterSyncPrepared.createRect || prepared.createRect;
            prepared.selector = afterSyncPrepared.selector || prepared.selector;
            prepared.strategy = afterSyncPrepared.strategy || prepared.strategy;
            prepared.attachOutcome = afterSyncPrepared.attachOutcome?.preSubmitRefs
              ? afterSyncPrepared.attachOutcome
              : (prepared.attachOutcome || afterSyncPrepared.attachOutcome);
            prepared.visible = afterSyncPrepared.visible || prepared.visible;
            prepared.store = afterSyncPrepared.store || prepared.store;
            prepared.createButton = afterSyncPrepared.createButton || prepared.createButton;
            prepared.expected = afterSyncPrepared.expected || prepared.expected;
          }
          const remainingProblems = debuggerPreparedSettingsProblems(afterSyncPrepared?.ok ? afterSyncPrepared : synced, task, activeSettings);
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

        let promptCommitEvidence = null;
        const useNativePromptEntry = debuggerShouldTypePromptWithNativeInput(task);
        const usePathCNativeCharacterEntry = !useNativePromptEntry && debuggerShouldUsePathCNativeCharacterEntry(task);
        const commitPrep = useNativePromptEntry
          ? await debuggerTypePromptWithNativeInput(
              target,
              prepared.editorRect,
              task.prompt,
              recordTrace,
              task,
              "initial_prompt_insert"
            )
          : usePathCNativeCharacterEntry
            ? await debuggerInsertNativeCharacterChipsWithPathC({
                target,
                tabId,
                task,
                sendPageCommand,
                trace: recordTrace,
                reason: "initial_prompt_insert"
              })
          : await sendPageCommand({
              action: "domCommitPromptForDebugger",
              task,
              timeoutMs: 120000
            }, tabId);
        const typed = (useNativePromptEntry || usePathCNativeCharacterEntry) ? commitPrep : (commitPrep?.result?.result || commitPrep?.result || commitPrep);
        promptCommitEvidence = typed || null;
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
          nativePromptEntry: useNativePromptEntry,
          createRect: typed?.createRect || null,
          selector: typed?.selector || "",
          strategy: typed?.strategy || "",
          createDisabled: Boolean(typed?.createButton?.disabled),
          selectedVideoDuration: typed?.store?.selectedVideoDuration ?? null,
          commitReceivedUserInput: typed?.commit?.receivedUserInput || null,
          receivedUserInput: typed?.store?.receivedUserInput || null,
          nativeCharacterPathC: typed?.nativeCharacterPathC || null
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

        if (debuggerShouldValidatePostChipSettings(task)) {
          let postChipSettings = await debuggerCollectPostChipSettingsSnapshot(target, task, prepared, activeSettings, typed);
          recordTrace(task, "path_c_post_chip_settings_snapshot", postChipSettings);
          if (!postChipSettings.ok) {
            recordTrace(task, "path_c_post_chip_settings_reseat_start", {
              problems: postChipSettings.problems || [],
              staleCropControlsVisible: Boolean(postChipSettings.staleCropControlsVisible),
              reason: "post_chip_visible_settings_validation"
            });
            const reseatSettings = await applyModeAndSettings({ target, task, trace: recordTrace });
            activeSettings = reseatSettings?.ok ? reseatSettings : activeSettings;
            const postChipReseatPrepared = reseatSettings?.ok
              ? await prepareForDebugger("prep_after_path_c_post_chip_settings_reseat", {
                  afterPromptInsert: true,
                  skipDebuggerAttach: true,
                  skipSettingsSettle: true,
                  afterPathCPostChipSettingsReseat: true
                })
              : null;
            if (postChipReseatPrepared?.ok) {
              prepared.editorRect = postChipReseatPrepared.editorRect || prepared.editorRect;
              prepared.createRect = postChipReseatPrepared.createRect || prepared.createRect;
              prepared.selector = postChipReseatPrepared.selector || prepared.selector;
              prepared.strategy = postChipReseatPrepared.strategy || prepared.strategy;
              prepared.visible = postChipReseatPrepared.visible || prepared.visible;
              prepared.store = postChipReseatPrepared.store || prepared.store;
              prepared.createButton = postChipReseatPrepared.createButton || prepared.createButton;
              prepared.expected = postChipReseatPrepared.expected || prepared.expected;
            }
            postChipSettings = await debuggerCollectPostChipSettingsSnapshot(target, task, prepared, activeSettings, typed, {
              reseatAttempted: true,
              reseatResult: {
                ok: Boolean(reseatSettings?.ok && postChipReseatPrepared?.ok),
                settingsOk: Boolean(reseatSettings?.ok),
                settingsError: reseatSettings?.error || "",
                prepareOk: Boolean(postChipReseatPrepared?.ok),
                prepareError: postChipReseatPrepared?.error || ""
              }
            });
            recordTrace(task, "path_c_post_chip_settings_snapshot", postChipSettings);
            if (!reseatSettings?.ok || !postChipReseatPrepared?.ok || !postChipSettings.ok) {
              const problems = postChipSettings.problems?.length ? postChipSettings.problems : ["post_chip_settings_invalid"];
              const error = reseatSettings?.error || postChipReseatPrepared?.error || `DOM_DEBUGGER_SETTINGS_STATE_INVALID:${problems.join(",")}`;
              return {
                ok: false,
                status: 0,
                statusText: error,
                error,
                data: { prepared, typed, postChipSettings, reseatSettings, postChipReseatPrepared, transport: "chrome_debugger" }
              };
            }
          }
        }

        const afterInsert = await prepareForDebugger("prep_after_prompt_insert", {
          afterPromptInsert: true,
          skipPostUploadSettle: false,
          skipSettingsSettle: debuggerShouldAvoidHiddenSettingsStoreRepair(task)
        });
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
          finalPrepared = await prepareForDebugger("prep_final_before_click", {
            afterPromptInsert: true,
            skipDebuggerAttach: attachRefsAfterPromptInsert,
            skipSettingsSettle: debuggerShouldAvoidHiddenSettingsStoreRepair(task)
          });
        }
        if (!finalPrepared?.ok && /SETTINGS|VIDEO|MODEL|COMPOSER_UPLOAD_NOT_SETTLED|videoApi|videoModelKey/i.test(String(finalPrepared?.error || "")) && debuggerShouldReseatVisibleSettingsAfterAttach(task)) {
          recordTrace(task, "final_settings_visible_reseat_start", {
            error: finalPrepared?.error || "",
            reason: "final_before_click_visible_settings_reseat"
          });
          const finalVisibleSettings = await applyModeAndSettings({ target, task, trace: recordTrace });
          const finalVisiblePrepared = finalVisibleSettings?.ok
            ? await prepareForDebugger("prep_after_final_visible_settings_reseat", {
                afterPromptInsert: true,
                skipDebuggerAttach: attachRefsAfterPromptInsert,
                skipSettingsSettle: true,
                afterFinalVisibleSettingsReseat: true
              })
            : null;
          recordTrace(task, "final_settings_visible_reseat_result", {
            ok: Boolean(finalVisiblePrepared?.ok),
            settingsOk: Boolean(finalVisibleSettings?.ok),
            settingsError: finalVisibleSettings?.error || "",
            retryError: finalVisiblePrepared?.error || ""
          });
          if (finalVisiblePrepared?.ok) {
            finalPrepared = finalVisiblePrepared;
          }
        }
        if (!finalPrepared?.ok && /SETTINGS|VIDEO|MODEL|COMPOSER_UPLOAD_NOT_SETTLED|videoApi|videoModelKey/i.test(String(finalPrepared?.error || "")) && !debuggerShouldAvoidHiddenSettingsStoreRepair(task)) {
          recordTrace(task, "final_settings_state_repair_start", {
            error: finalPrepared?.error || "",
            reason: "final_before_click_validation"
          });
          const finalSyncPrep = await sendPageCommand({
            action: "domSyncTaskSettingsForDebugger",
            task,
            meta: { ...meta, debuggerTransport: true, reason: "final_before_click_validation" },
            timeoutMs: pageCommandTimeoutMs("final_settings_state_repair", { afterFinalSettingsStateRepair: true })
          }, tabId);
          const finalSynced = finalSyncPrep?.result?.result || finalSyncPrep?.result || finalSyncPrep;
          const finalRetryPrepared = finalSynced?.ok
            ? await prepareForDebugger("prep_after_final_settings_repair", {
                afterPromptInsert: true,
                skipDebuggerAttach: attachRefsAfterPromptInsert,
                skipSettingsSettle: false,
                afterFinalSettingsStateRepair: true
              })
            : null;
          recordTrace(task, "final_settings_state_repair_result", {
            ok: Boolean(finalRetryPrepared?.ok),
            syncOk: Boolean(finalSynced?.ok),
            syncError: finalSynced?.error || "",
            retryError: finalRetryPrepared?.error || "",
            validation: finalSynced?.validation || null,
            storeSync: finalSynced?.storeSync || null
          });
          if (finalRetryPrepared?.ok) {
            finalPrepared = finalRetryPrepared;
          }
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
        if (String(task.mode || "") === "text-to-video" && finalPrepared?.ok) {
          let finalSettingsProblems = debuggerPreparedSettingsProblems(prepared, task, activeSettings);
          if (finalSettingsProblems.length) {
            recordTrace(task, "final_settings_state_repair_start", {
              problems: finalSettingsProblems,
              reason: "final_before_click_settings_drift"
            });
            const finalSyncPrep = await sendPageCommand({
              action: "domSyncTaskSettingsForDebugger",
              task,
              meta: { ...meta, debuggerTransport: true, reason: "final_before_click_settings_drift" },
              timeoutMs: pageCommandTimeoutMs("final_settings_state_repair", { afterFinalSettingsStateRepair: true })
            }, tabId);
            const finalSynced = finalSyncPrep?.result?.result || finalSyncPrep?.result || finalSyncPrep;
            const finalRetryPrepared = finalSynced?.ok
              ? await prepareForDebugger("prep_after_final_settings_repair", {
                  afterPromptInsert: true,
                  skipDebuggerAttach: attachRefsAfterPromptInsert,
                  skipSettingsSettle: false,
                  afterFinalSettingsStateRepair: true
                })
              : null;
            if (finalRetryPrepared?.ok) {
              prepared.editorRect = finalRetryPrepared.editorRect || prepared.editorRect;
              prepared.createRect = finalRetryPrepared.createRect || prepared.createRect;
              prepared.selector = finalRetryPrepared.selector || prepared.selector;
              prepared.strategy = finalRetryPrepared.strategy || prepared.strategy;
              prepared.attachOutcome = finalRetryPrepared.attachOutcome?.preSubmitRefs
                ? finalRetryPrepared.attachOutcome
                : (prepared.attachOutcome || finalRetryPrepared.attachOutcome);
              prepared.visible = finalRetryPrepared.visible || prepared.visible;
              prepared.store = finalRetryPrepared.store || prepared.store;
              prepared.createButton = finalRetryPrepared.createButton || prepared.createButton;
              prepared.expected = finalRetryPrepared.expected || prepared.expected;
              finalPrepared = finalRetryPrepared;
            }
            finalSettingsProblems = debuggerPreparedSettingsProblems(finalRetryPrepared?.ok ? prepared : finalSynced, task, activeSettings);
            recordTrace(task, "final_settings_state_repair_result", {
              ok: Boolean(finalRetryPrepared?.ok) && finalSettingsProblems.length === 0,
              syncOk: Boolean(finalSynced?.ok),
              syncError: finalSynced?.error || "",
              retryError: finalRetryPrepared?.error || "",
              problems: finalSettingsProblems,
              validation: finalSynced?.validation || null,
              storeSync: finalSynced?.storeSync || null
            });
            if (!finalSynced?.ok || !finalRetryPrepared?.ok || finalSettingsProblems.length) {
              const error = finalSynced?.error || finalRetryPrepared?.error || `DOM_DEBUGGER_SETTINGS_STATE_INVALID:${finalSettingsProblems.join(",")}`;
              return {
                ok: false,
                status: 0,
                statusText: error,
                error,
                data: { prepared, finalSynced, finalRetryPrepared, finalSettingsProblems, transport: "chrome_debugger" }
              };
            }
          }
        }
        recordTrace(task, "prep_final_before_click", {
          ok: Boolean(finalPrepared?.ok),
          error: finalPrepared?.error || "",
          editorRect: prepared.editorRect || null,
          createRect: prepared.createRect || null,
          selector: prepared.selector || "",
          strategy: prepared.strategy || ""
        });
        if (!finalPrepared?.ok) {
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
        const skipFinalPromptRecommitToPreserveRefs = debuggerShouldPreserveAttachedRefsThroughFinalClick(task);
        if (debuggerShouldRecommitPromptBeforeFinalClick(task)) {
          const useNativePromptEntry = debuggerShouldTypePromptWithNativeInput(task);
          const usePathCNativeCharacterEntry = !useNativePromptEntry && debuggerShouldUsePathCNativeCharacterEntry(task);
          const finalCommitPrep = useNativePromptEntry
            ? await debuggerTypePromptWithNativeInput(
                target,
                prepared.editorRect,
                task.prompt,
                recordTrace,
                task,
                "final_before_debugger_click"
              )
            : usePathCNativeCharacterEntry
              ? await debuggerInsertNativeCharacterChipsWithPathC({
                  target,
                  tabId,
                  task,
                  sendPageCommand,
                  trace: recordTrace,
                  reason: "final_before_debugger_click"
                })
            : await sendPageCommand({
                action: "domCommitPromptForDebugger",
                task,
                meta: { reason: "final_before_debugger_click" },
                timeoutMs: 120000
              }, tabId).catch((error) => ({
                ok: false,
                error: String(error?.message || error || "DOM_PROMPT_RECOMMIT_FAILED")
              }));
          const finalTyped = (useNativePromptEntry || usePathCNativeCharacterEntry) ? finalCommitPrep : (finalCommitPrep?.result?.result || finalCommitPrep?.result || finalCommitPrep);
          promptCommitEvidence = finalTyped || promptCommitEvidence;
          if (finalTyped?.ok) {
            prepared.editorRect = finalTyped.editorRect || prepared.editorRect;
            prepared.createRect = finalTyped.createRect || prepared.createRect;
            prepared.selector = finalTyped.selector || prepared.selector;
            prepared.strategy = finalTyped.strategy || prepared.strategy;
            prepared.visible = finalTyped.visible || prepared.visible;
            prepared.store = finalTyped.store || prepared.store;
            prepared.createButton = finalTyped.createButton || prepared.createButton;
          }
          recordTrace(task, "prompt_recommit_before_submit_click", {
            ok: Boolean(finalTyped?.ok),
            error: finalTyped?.error || "",
            persisted: finalTyped?.commit?.persisted || "",
            storePersisted: finalTyped?.commit?.storePersisted || "",
            slatePersisted: finalTyped?.commit?.slatePersisted || "",
            method: finalTyped?.commit?.method || "",
            nativePromptEntry: useNativePromptEntry,
            createRect: finalTyped?.createRect || null,
            selector: finalTyped?.selector || "",
            strategy: finalTyped?.strategy || "",
            createDisabled: Boolean(finalTyped?.createButton?.disabled),
            selectedVideoDuration: finalTyped?.store?.selectedVideoDuration ?? null,
            commitReceivedUserInput: finalTyped?.commit?.receivedUserInput || null,
            receivedUserInput: finalTyped?.store?.receivedUserInput || null
          });
          if (!finalTyped?.ok) {
            const error = finalTyped?.error || "DOM_PROMPT_NOT_PERSISTED_BEFORE_SUBMIT";
            return {
              ok: false,
              status: 0,
              statusText: error,
              error,
              data: { prepared, finalTyped, transport: "chrome_debugger" }
            };
          }
          await sleep(250);
        } else if (skipFinalPromptRecommitToPreserveRefs) {
          recordTrace(task, "prompt_recommit_before_submit_click_skipped", {
            ok: true,
            reason: "preserve_refs_after_path_c_native_character_insert",
            mode: String(task.mode || ""),
            attachOutcome: {
              attached: prepared.attachOutcome?.attached || 0,
              nativeComposerChipProof: prepared.attachOutcome?.nativeComposerChipProof === true
                || prepared.attachOutcome?.preSubmitRefs?.nativeComposerChipProof === true,
              serializedIds: [
                ...(Array.isArray(prepared.attachOutcome?.serializedIds) ? prepared.attachOutcome.serializedIds : []),
                ...(Array.isArray(prepared.attachOutcome?.preSubmitRefs?.serializedIds) ? prepared.attachOutcome.preSubmitRefs.serializedIds : [])
              ].filter(Boolean),
              requestSerializedIds: [
                ...(Array.isArray(prepared.attachOutcome?.requestSerializedIds) ? prepared.attachOutcome.requestSerializedIds : []),
                ...(Array.isArray(prepared.attachOutcome?.preSubmitRefs?.requestSerializedIds) ? prepared.attachOutcome.preSubmitRefs.requestSerializedIds : [])
              ].filter(Boolean)
            }
          });
        }
        if (debuggerShouldNudgePromptWithNativeInput(task)) {
          const nativeNudge = await debuggerNudgePromptWithNativeInput(
            target,
            prepared.editorRect,
            recordTrace,
            task,
            "final_before_debugger_click"
          );
          if (nativeNudge?.ok) {
            recordTrace(task, "prompt_native_input_nudge_before_submit_click", nativeNudge);
          }
        }
        const refModeNeedsLayoutSettle = debuggerShouldAttachRefsAfterPromptInsert(task);
        const createStabilizeTimeoutMs = refModeNeedsLayoutSettle ? 4200 : 1800;
        const createStabilizeOptions = refModeNeedsLayoutSettle ? { minWaitMs: 900 } : {};
        if (debuggerShouldFocusEditorBeforeSubmitClick(task) && prepared.editorRect) {
          const focusPoint = pointFromRect(prepared.editorRect);
          await debuggerClick(target, focusPoint).catch(() => {});
          await sleep(180);
          recordTrace(task, "submit_editor_focus_before_click", {
            point: focusPoint,
            mode: String(task.mode || "")
          });
        }
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
        let safeCreatePoint = liveCreate?.ok && liveCreate.point
          ? liveCreate.point
          : pointFromRect(prepared.createRect);
        let hit = liveCreate?.hit || await debuggerHitTest(target, safeCreatePoint);
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
        const usePageSubmitCapture = debuggerShouldUsePageSubmitCapture(task);
        const armedCapture = usePageSubmitCapture
          ? await sendPageCommand({
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
            }, tabId)
          : { ok: true, skipped: true, reason: "frame_video_uses_cdp_network_capture" };
        const armed = armedCapture?.result?.result || armedCapture?.result || armedCapture;
        recordTrace(task, "submit_capture_arm", {
          ok: Boolean(armed?.ok),
          skipped: Boolean(armed?.skipped),
          reason: armed?.reason || "",
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
        const requestObserverArmedAt = Date.now();
        const debuggerNetworkResponsePromise = waitForDebuggerGenerationResponse(target, {
          projectId: prepared.projectId || "",
          expectedCount,
          timeoutMs: Number(meta.responseTimeoutMs || responseTimeoutMs) || responseTimeoutMs
        });
        recordTrace(task, "network_observer_armed_before_click", {
          ok: true,
          captureId,
          usePageSubmitCapture,
          pageCaptureArmed: Boolean(usePageSubmitCapture && armed?.ok && !armed?.skipped),
          debuggerNetworkObserverArmed: true,
          expectedCount,
          requestObserverArmedAt,
          timeoutMs: Number(meta.responseTimeoutMs || responseTimeoutMs) || responseTimeoutMs
        });
        if (debuggerShouldBringToFront(meta, task)) {
          await debuggerSend(target, "Page.bringToFront").catch(() => {});
          recordTrace(task, "front_submit_bring_to_front", {
            ok: true,
            reason: meta?.bringToFront === true || meta?.allowBringToFront === true
              ? "explicit_meta_opt_in"
              : "text_to_video_user_activation"
          });
        } else {
          recordTrace(task, "front_submit_bring_to_front_skipped", { ok: true, reason: "no_focus_default" });
        }
        const frontSubmitBaseline = await debuggerFrontSubmitSnapshot(target, task).catch((error) => ({ ok: false, error: String(error?.message || error) }));
        const baselineProjectCardIds = Array.isArray(frontSubmitBaseline?.projectCardIds)
          ? frontSubmitBaseline.projectCardIds
          : [];
        const baselineProjectCardSignatures = Array.isArray(frontSubmitBaseline?.projectCardSignatures)
          ? frontSubmitBaseline.projectCardSignatures
          : [];
        const baselineGenerationProjectCardCount = Number(frontSubmitBaseline?.totalGenerationProjectCardCount ?? frontSubmitBaseline?.generationProjectCardCount ?? 0) || 0;
        recordTrace(task, "front_submit_baseline", {
          ok: frontSubmitBaseline?.ok !== false,
          error: frontSubmitBaseline?.error || "",
          projectCardCount: baselineProjectCardIds.length,
          projectCardSignatureCount: baselineProjectCardSignatures.length,
          totalGenerationProjectCardCount: baselineGenerationProjectCardCount,
          failedProjectCardCount: Number(frontSubmitBaseline?.failedProjectCardCount || 0),
          promptStillVisible: Boolean(frontSubmitBaseline?.promptStillVisible),
          createDisabled: Boolean(frontSubmitBaseline?.createDisabled),
          progressVisible: Boolean(frontSubmitBaseline?.progressVisible)
        });
        let clickCreate = await debuggerStableCreateButtonPoint(target, refModeNeedsLayoutSettle ? 2200 : 1200, {
          minWaitMs: refModeNeedsLayoutSettle ? 360 : 120
        });
        if (debuggerResultLooksDetached(clickCreate)) {
          recordTrace(task, "submit_pre_click_probe_reattach", { reason: "debugger_detached_during_pre_click_create_stabilize" });
          const reattached = await ensureDebuggerAttached(tabId, recordTrace, task);
          target = reattached.target;
          await ensureNetworkEnabled(tabId, target);
          clickCreate = await debuggerStableCreateButtonPoint(target, refModeNeedsLayoutSettle ? 2200 : 1200, {
            minWaitMs: refModeNeedsLayoutSettle ? 360 : 120
          });
        }
        const clickPoint = clickCreate?.ok && clickCreate.point
          ? clickCreate.point
          : safeCreatePoint;
        const clickHit = clickCreate?.hit || await debuggerHitTest(target, clickPoint);
        recordTrace(task, "submit_pre_click_hit_test", {
          createPoint: clickPoint,
          liveCreate: clickCreate,
          hit: clickHit,
          previousCreatePoint: safeCreatePoint,
          previousHit: hit
        });
        if (!hitLooksLikeCreateButton(clickHit)) {
          const cancelCapture = usePageSubmitCapture
            ? await sendPageCommand({
                action: "domCancelDebuggerSubmitCapture",
                task,
                meta: { captureId, reason: "pre_click_create_target_unsafe" },
                timeoutMs: 10000
              }, tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "DOM_DEBUGGER_CAPTURE_CANCEL_FAILED") }))
            : { ok: true, skipped: true };
          const cancelResult = cancelCapture?.result?.result || cancelCapture?.result || cancelCapture;
          recordTrace(task, "submit_pre_click_capture_cancel", {
            ok: Boolean(cancelResult?.ok),
            cancelled: Boolean(cancelResult?.cancelled),
            error: cancelResult?.error || ""
          });
          return {
            ok: false,
            status: 0,
            statusText: "DOM_DEBUGGER_CREATE_TARGET_UNSAFE_BEFORE_CLICK",
            error: "DOM_DEBUGGER_CREATE_TARGET_UNSAFE_BEFORE_CLICK",
            data: { prepared, hit: clickHit, createPoint: clickPoint, previousHit: hit, previousCreatePoint: safeCreatePoint, transport: "chrome_debugger" }
          };
        }
        safeCreatePoint = clickPoint;
        hit = clickHit;
        if (clickCreate?.ok && clickCreate.rect) {
          prepared.createRect = clickCreate.rect;
          prepared.createButton = {
            ...(prepared.createButton || {}),
            text: clickCreate.text || prepared.createButton?.text || "",
            rect: clickCreate.rect,
            strategy: clickCreate.strategy || prepared.createButton?.strategy || ""
          };
        }
        const expectedRefCountForTrace = Number(
          prepared.expected?.refCount ??
          prepared.attachOutcome?.expected ??
          prepared.attachOutcome?.preSubmitRefs?.expected ??
          (Array.isArray(task.refInputs) ? task.refInputs.length : 0)
        ) || 0;
        const finalSettingsProblemsForTrace = debuggerPreparedSettingsProblems(prepared, task, activeSettings);
        const modeProblemsForTrace = finalSettingsProblemsForTrace.filter((problem) => /^mode:/i.test(String(problem || "")));
        const promptEvidenceText = [
          promptCommitEvidence?.commit?.persisted,
          promptCommitEvidence?.commit?.storePersisted,
          promptCommitEvidence?.commit?.slatePersisted
        ].map((value) => String(value || "").trim()).filter(Boolean);
        const promptCommittedForTrace = Boolean(
          promptCommitEvidence?.ok === true &&
          (
            promptEvidenceText.length > 0 ||
            promptCommitEvidence?.commit?.receivedUserInput?.ok === true ||
            promptCommitEvidence?.commit?.receivedUserInput?.attempted === true
          )
        );
        const nativeCharacterPathCProofForTrace = debuggerNativeCharacterPathCProofPassed(promptCommitEvidence);
        const refsAttachedForTrace = Boolean(
          expectedRefCountForTrace <= 0 ||
          !debuggerShouldAttachRefsAfterPromptInsert(task) ||
          prepared.attachOutcome?.attached > 0 ||
          prepared.attachOutcome?.preSubmitRefs?.attached > 0 ||
          prepared.attachOutcome?.nativeComposerChipProof === true ||
          prepared.attachOutcome?.preSubmitRefs?.nativeComposerChipProof === true ||
          nativeCharacterPathCProofForTrace
        );
        const buttonEnabledForTrace = !clickCreate?.disabled && !prepared.createButton?.disabled;
        const buttonTopmostForTrace = hitLooksLikeCreateButton(hit);
        const modalOverlayClearForTrace = Boolean(buttonTopmostForTrace && !hit?.detailEditorOpen && !clickHit?.detailEditorOpen);
        const settingsValidForTrace = finalSettingsProblemsForTrace.length === 0;
        const modeConfirmedForTrace = modeProblemsForTrace.length === 0;
        recordTrace(task, "pre_submit_invariants_snapshot", {
          ok: Boolean(
            modeConfirmedForTrace &&
            promptCommittedForTrace &&
            settingsValidForTrace &&
            modalOverlayClearForTrace &&
            refsAttachedForTrace &&
            buttonEnabledForTrace &&
            buttonTopmostForTrace
          ),
          modeConfirmed: modeConfirmedForTrace,
          modeEvidence: {
            expectedMode: prepared.expected?.visibleMode || prepared.expected?.mode || "",
            actualMode: prepared.store?.mode || "",
            problems: modeProblemsForTrace
          },
          promptCommitted: promptCommittedForTrace,
          promptEvidence: {
            ok: promptCommitEvidence?.ok === true,
            method: promptCommitEvidence?.commit?.method || "",
            persistedLength: String(promptCommitEvidence?.commit?.persisted || "").length,
            storePersistedLength: String(promptCommitEvidence?.commit?.storePersisted || "").length,
            slatePersistedLength: String(promptCommitEvidence?.commit?.slatePersisted || "").length,
            receivedUserInput: promptCommitEvidence?.commit?.receivedUserInput || null
          },
          expectedRefCount: expectedRefCountForTrace,
          refsAttached: refsAttachedForTrace,
          nativeCharacterPathCProof: nativeCharacterPathCProofForTrace,
          settingsValid: settingsValidForTrace,
          settingsEvidence: {
            problems: finalSettingsProblemsForTrace,
            selectedVideoDuration: prepared.store?.selectedVideoDuration ?? null,
            videoApi: prepared.store?.currentModelKeys?.videoApi || "",
            videoModelKey: prepared.store?.currentModelKeys?.videoModelKey || ""
          },
          modalOverlayClear: modalOverlayClearForTrace,
          modalEvidence: {
            hitDetailEditorOpen: Boolean(hit?.detailEditorOpen),
            clickHitDetailEditorOpen: Boolean(clickHit?.detailEditorOpen)
          },
          buttonEnabled: buttonEnabledForTrace,
          buttonTopmost: buttonTopmostForTrace,
          networkObserverArmed: true,
          createPoint: safeCreatePoint,
          createButton: prepared.createButton || null
        });
        const enterSubmit = debuggerShouldSubmitWithPromptEnter(task);
        const editorPoint = pointFromRect(prepared.editorRect);
        const clickDispatchedAt = Date.now();
        recordTrace(task, "submit_click", {
          createPoint: safeCreatePoint,
          editorPoint,
          expectedCount,
          method: enterSubmit ? "editor_enter" : "create_button",
          clickDispatchedAt
        });
        if (enterSubmit) {
          await debuggerClick(target, editorPoint);
          await sleep(120);
          await debuggerPressKey(target, "Enter", "Enter", 13, { holdMs: 35 });
          await sleep(450);
          const afterEnterSnapshot = await debuggerFrontSubmitSnapshot(target, task, {
            baselineProjectCardIds,
            baselineProjectCardSignatures,
            baselineGenerationProjectCardCount
          });
          const fallbackCandidate = frontSnapshotStillSubmittable(afterEnterSnapshot);
          recordTrace(task, "submit_enter_probe", {
            fallbackCandidate: Boolean(fallbackCandidate),
            fallbackDeferredUntilNoRequest: Boolean(fallbackCandidate),
            promptStillVisible: Boolean(afterEnterSnapshot?.promptStillVisible),
            createDisabled: Boolean(afterEnterSnapshot?.createDisabled),
            progressVisible: Boolean(afterEnterSnapshot?.progressVisible),
            newProjectCardCount: Number(afterEnterSnapshot?.newProjectCardCount || 0),
            failedProjectCardCount: Number(afterEnterSnapshot?.failedProjectCardCount || 0),
            createButtons: afterEnterSnapshot?.createButtons || [],
            editors: afterEnterSnapshot?.editors || []
          });
        } else {
          await debuggerClick(target, safeCreatePoint);
        }
        let frontTransition = debuggerRequiresFrontSubmitTransition(task)
          ? await waitForFrontSubmitTransition(target, task, 7000, {
              baselineProjectCardIds,
              baselineProjectCardSignatures,
              baselineGenerationProjectCardCount
            })
          : { ok: true, skipped: true, reason: "not_required_for_mode" };
        if (
          String(task.mode || "") === "text-to-image"
          && usePageSubmitCapture
          && !frontTransition?.ok
          && frontSnapshotStillSubmittable(frontTransition?.snapshot || {})
          && frontSubmitNewProjectCardCount(frontTransition?.snapshot || {}, task) <= 0
          && !frontSubmitSnapshotHasCurrentFailedCard(frontTransition?.snapshot || {})
        ) {
          recordTrace(task, "submit_click_quick_rehit_start", {
            reason: frontTransition.reason || "",
            promptStillVisible: Boolean(frontTransition?.snapshot?.promptStillVisible),
            createDisabled: Boolean(frontTransition?.snapshot?.createDisabled),
            progressVisible: Boolean(frontTransition?.snapshot?.progressVisible),
            newProjectCardCount: Number(frontTransition?.snapshot?.newProjectCardCount || 0),
            failedNewProjectCardCount: Number(frontTransition?.snapshot?.failedNewProjectCardCount || 0),
            failedMatchingPromptCardCount: Number(frontTransition?.snapshot?.failedMatchingPromptCardCount || 0)
          });
          const quickCreate = await debuggerStableCreateButtonPoint(target, 1800, { minWaitMs: 300 });
          const quickPoint = quickCreate?.ok && quickCreate.point ? quickCreate.point : safeCreatePoint;
          const quickHit = quickCreate?.hit || await debuggerHitTest(target, quickPoint);
          recordTrace(task, "submit_click_quick_rehit", {
            createPoint: quickPoint,
            liveCreate: quickCreate,
            hit: quickHit
          });
          if (hitLooksLikeCreateButton(quickHit)) {
            await debuggerClick(target, quickPoint);
            const quickFrontTransition = await waitForFrontSubmitTransition(target, task, 7000, {
              baselineProjectCardIds,
              baselineProjectCardSignatures,
              baselineGenerationProjectCardCount
            });
            recordTrace(task, "front_submit_transition_after_quick_rehit", {
              ok: Boolean(quickFrontTransition?.ok),
              reason: quickFrontTransition?.reason || "",
              promptStillVisible: Boolean(quickFrontTransition?.snapshot?.promptStillVisible),
              createDisabled: Boolean(quickFrontTransition?.snapshot?.createDisabled),
              progressVisible: Boolean(quickFrontTransition?.snapshot?.progressVisible),
              matchingPromptCardCount: Number(quickFrontTransition?.snapshot?.matchingPromptCardCount || 0),
              matchingMediaCardCount: Number(quickFrontTransition?.snapshot?.matchingMediaCardCount || 0),
              newProjectCardCount: Number(quickFrontTransition?.snapshot?.newProjectCardCount || 0),
              generationProjectCardCount: Number(quickFrontTransition?.snapshot?.generationProjectCardCount || 0),
              progressCardCount: Number(quickFrontTransition?.snapshot?.progressCardCount || 0),
              failedProjectCardCount: Number(quickFrontTransition?.snapshot?.failedProjectCardCount || 0),
              failedNewProjectCardCount: Number(quickFrontTransition?.snapshot?.failedNewProjectCardCount || 0),
              failedMatchingPromptCardCount: Number(quickFrontTransition?.snapshot?.failedMatchingPromptCardCount || 0),
              failedMatchingMediaCardCount: Number(quickFrontTransition?.snapshot?.failedMatchingMediaCardCount || 0),
              matchingProjectCards: quickFrontTransition?.snapshot?.matchingProjectCards || [],
              newProjectCards: quickFrontTransition?.snapshot?.newProjectCards || [],
              failedProjectCards: quickFrontTransition?.snapshot?.failedProjectCards || []
            });
            frontTransition = quickFrontTransition;
          }
        }
        recordTrace(task, "front_submit_transition", {
          ok: Boolean(frontTransition.ok),
          skipped: Boolean(frontTransition.skipped),
          reason: frontTransition.reason || "",
          promptStillVisible: Boolean(frontTransition.snapshot?.promptStillVisible),
          createDisabled: Boolean(frontTransition.snapshot?.createDisabled),
          progressVisible: Boolean(frontTransition.snapshot?.progressVisible),
          matchingPromptCardCount: Number(frontTransition.snapshot?.matchingPromptCardCount || 0),
          matchingMediaCardCount: Number(frontTransition.snapshot?.matchingMediaCardCount || 0),
          newProjectCardCount: Number(frontTransition.snapshot?.newProjectCardCount || 0),
          generationProjectCardCount: Number(frontTransition.snapshot?.generationProjectCardCount || 0),
          totalGenerationProjectCardCount: Number(frontTransition.snapshot?.totalGenerationProjectCardCount || 0),
          generationProjectCardDelta: Number(frontTransition.snapshot?.generationProjectCardDelta || 0),
          progressCardCount: Number(frontTransition.snapshot?.progressCardCount || 0),
          failedProjectCardCount: Number(frontTransition.snapshot?.failedProjectCardCount || 0),
          failedNewProjectCardCount: Number(frontTransition.snapshot?.failedNewProjectCardCount || 0),
          failedMatchingPromptCardCount: Number(frontTransition.snapshot?.failedMatchingPromptCardCount || 0),
          failedMatchingMediaCardCount: Number(frontTransition.snapshot?.failedMatchingMediaCardCount || 0),
          matchingProjectCards: frontTransition.snapshot?.matchingProjectCards || [],
          newProjectCards: frontTransition.snapshot?.newProjectCards || [],
          failedProjectCards: frontTransition.snapshot?.failedProjectCards || [],
          editors: frontTransition.snapshot?.editors || []
        });
        if (String(task.mode || "") === "text-to-image" && frontTransition?.ok) {
          recordTrace(task, "front_submit_transition_wait_for_request", {
            reason: frontTransition.reason || "",
            strongProof: frontSubmitTransitionHasStrongProof(frontTransition, task),
            promptStillVisible: Boolean(frontTransition.snapshot?.promptStillVisible),
            matchingPromptCardCount: Number(frontTransition.snapshot?.matchingPromptCardCount || 0),
            matchingMediaCardCount: Number(frontTransition.snapshot?.matchingMediaCardCount || 0),
            progressCardCount: Number(frontTransition.snapshot?.progressCardCount || 0)
          });
        }
        const frontTransitionOpenedWrongEditor = /^(media_detail_editor_after_submit|wrong_mode_video_edit_route_after_submit)$/i.test(String(frontTransition?.reason || ""));
        if (frontTransitionOpenedWrongEditor && usePageSubmitCapture) {
          const cancelCapture = await sendPageCommand({
            action: "domCancelDebuggerSubmitCapture",
            task,
            meta: { captureId, reason: frontTransition.reason || "wrong_editor_after_submit" },
            timeoutMs: 10000
          }, tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "DOM_DEBUGGER_CAPTURE_CANCEL_FAILED") }));
          const cancelResult = cancelCapture?.result?.result || cancelCapture?.result || cancelCapture;
          recordTrace(task, "submit_capture_cancel_wrong_editor", {
            ok: Boolean(cancelResult?.ok),
            cancelled: Boolean(cancelResult?.cancelled),
            reason: frontTransition.reason || "",
            error: cancelResult?.error || ""
          });
        }
        const pageCapture = usePageSubmitCapture
          ? frontTransitionOpenedWrongEditor
            ? {
                ok: false,
                error: "DOM_SUBMIT_REQUEST_NOT_OBSERVED:wrong_editor_route",
                mediaIds: [],
                capturedResponseCount: 0,
                partialMediaCapture: false,
                endpoint: "",
                endpointKind: "",
                flowError: null
              }
            : await sendPageCommand({
	              action: "domAwaitDebuggerSubmitCapture",
	              task,
	              meta: { captureId },
	              timeoutMs: Number(meta.responseTimeoutMs || responseTimeoutMs) + 15000
	            }, tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "DOM_DEBUGGER_CAPTURE_AWAIT_FAILED") }))
          : {
              ok: false,
              skipped: true,
              error: "PAGE_CAPTURE_SKIPPED_FOR_FRAME_VIDEO",
              mediaIds: [],
              capturedResponseCount: 0
            };
        const pageResponse = pageCapture?.result?.result || pageCapture?.result || pageCapture;
        recordTrace(task, "submit_capture_result", {
          ok: Boolean(pageResponse?.ok),
          skipped: Boolean(pageResponse?.skipped),
          error: pageResponse?.error || "",
          status: Number(pageResponse?.status || 0),
          mediaIdCount: Array.isArray(pageResponse?.mediaIds) ? pageResponse.mediaIds.length : 0,
          capturedResponseCount: pageResponse?.capturedResponseCount || 0,
          partialMediaCapture: Boolean(pageResponse?.partialMediaCapture),
          endpoint: pageResponse?.endpoint || "",
          endpointKind: pageResponse?.endpointKind || "",
          flowError: pageResponse?.flowError || null,
          responseBodyLength: Number(pageResponse?.responseBodyLength || 0),
          serializedRefs: pageResponse?.serializedRefs || null,
          captureId
        });
        const pageCaptureError = String(pageResponse?.error || "");
        const noRequestErrorPattern = /REQUEST_NOT_OBSERVED|NO_REQUEST|request_not_observed|DOM_SUBMIT_MEDIA_IDS_NOT_CAPTURED/i;
        const pageCaptureObservedRequest = Number(pageResponse?.status || 0) > 0
          || Boolean(pageResponse?.endpoint)
          || Boolean(pageResponse?.serializedRefs)
          || Number(pageResponse?.capturedResponseCount || 0) > 0;
        const pageCaptureProvedNoRequest = !pageCaptureObservedRequest && noRequestErrorPattern.test(pageCaptureError);
        const fastRetryBadFrontTransition = !pageCaptureObservedRequest
          && !pageCaptureProvedNoRequest
          && debuggerShouldFastRetryBadFrontTransition(task, frontTransition);
        if (pageCaptureProvedNoRequest) {
          recordTrace(task, "submit_capture_no_request_fast_retry", {
            error: pageCaptureError,
            captureId,
            pageCaptureObservedRequest
          });
        }
        if (fastRetryBadFrontTransition) {
          recordTrace(task, "submit_bad_front_transition_fast_retry", {
            reason: frontTransition?.reason || "",
            promptStillVisible: Boolean(frontTransition?.snapshot?.promptStillVisible),
            createDisabled: Boolean(frontTransition?.snapshot?.createDisabled),
            progressVisible: Boolean(frontTransition?.snapshot?.progressVisible),
            matchingPromptCardCount: Number(frontTransition?.snapshot?.matchingPromptCardCount || 0),
            matchingMediaCardCount: Number(frontTransition?.snapshot?.matchingMediaCardCount || 0),
            newProjectCardCount: Number(frontTransition?.snapshot?.newProjectCardCount || 0),
            generationProjectCardCount: Number(frontTransition?.snapshot?.generationProjectCardCount || 0),
            progressCardCount: Number(frontTransition?.snapshot?.progressCardCount || 0),
            failedProjectCardCount: Number(frontTransition?.snapshot?.failedProjectCardCount || 0),
            failedNewProjectCardCount: Number(frontTransition?.snapshot?.failedNewProjectCardCount || 0),
            failedMatchingPromptCardCount: Number(frontTransition?.snapshot?.failedMatchingPromptCardCount || 0),
            failedMatchingMediaCardCount: Number(frontTransition?.snapshot?.failedMatchingMediaCardCount || 0),
            failedProjectCards: frontTransition?.snapshot?.failedProjectCards || [],
            editors: frontTransition?.snapshot?.editors || []
          });
        }
        let response = Array.isArray(pageResponse?.mediaIds) && pageResponse.mediaIds.length
          ? pageResponse
          : pageCaptureProvedNoRequest
            ? pageResponse
            : pageCaptureObservedRequest
              ? pageResponse
              : fastRetryBadFrontTransition
                ? { status: 0, mediaIds: [], expectedCount, error: "DOM_DEBUGGER_REQUEST_NOT_OBSERVED:front_transition_not_generation" }
                : await debuggerNetworkResponsePromise;
        let mediaIds = mediaIdsFrom(response?.mediaIds || []);
        let postResponseFrontTransition = null;
        let omniVisibilitySnapshotRecorded = false;
        let omniVisibilitySnapshotStrictDomGreen = false;
        const recordOmniPostSubmitVisibilitySnapshot = (visibilitySnapshot = {}) => {
          if (!debuggerIsOmniIngredientsTask(task)) return;
          const generatedCardCount = Number(visibilitySnapshot.generatedCardCount ?? visibilitySnapshot.generationProjectCardCount ?? 0);
          const progressCardCount = Number(visibilitySnapshot.progressCardCount || 0);
          const galleryDeltaCount = Number(visibilitySnapshot.galleryDeltaCount ?? visibilitySnapshot.generationProjectCardDelta ?? 0);
          const projectCardDeltaCount = Number(visibilitySnapshot.projectCardDeltaCount ?? visibilitySnapshot.newProjectCardCount ?? 0);
          const matchingPromptCardCount = Number(visibilitySnapshot.matchingPromptCardCount || 0);
	          const matchingMediaCardCount = Number(visibilitySnapshot.matchingMediaCardCount || 0);
	          const projectGridMovieQueuedCardCount = Number(visibilitySnapshot.projectGridMovieQueuedCardCount || 0);
	          const matchingProjectGridMovieQueuedCardCount = Number(visibilitySnapshot.matchingProjectGridMovieQueuedCardCount || 0);
	          const newProjectGridMovieQueuedCardCount = Number(visibilitySnapshot.newProjectGridMovieQueuedCardCount || 0);
	          const changedProjectGridMovieQueuedCardCount = Number(visibilitySnapshot.changedProjectGridMovieQueuedCardCount || 0);
	          const staleCardFilteredCount = Number(visibilitySnapshot.staleCardFilteredCount || 0);
	          const visibleTransitionFound = Boolean(
	            generatedCardCount > 0 ||
            progressCardCount > 0 ||
            galleryDeltaCount > 0 ||
            projectCardDeltaCount > 0 ||
            matchingPromptCardCount > 0 ||
	            matchingMediaCardCount > 0
	          );
	          const responseStatus = Number(response?.status || pageResponse?.status || 0);
	          const requestSeen = Boolean(pageCaptureObservedRequest || responseStatus > 0 || response?.endpoint || pageResponse?.endpoint);
	          const serializedRefs = pageResponse?.serializedRefs || response?.serializedRefs || null;
	          const uploadedRefIds = [
	            ...(Array.isArray(serializedRefs?.observed?.referenceImages) ? serializedRefs.observed.referenceImages : []),
	            ...(Array.isArray(serializedRefs?.expected) ? serializedRefs.expected : [])
	          ].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index);
	          const proofWindowStartMs = Math.min(
	            ...[requestObserverArmedAt, clickDispatchedAt].map(Number).filter((value) => Number.isFinite(value) && value > 0)
	          );
	          const proofWindowStartAt = Number.isFinite(proofWindowStartMs) ? new Date(proofWindowStartMs).toISOString() : "";
	          const proofWindowEndAt = visibilitySnapshot.snapshotAt || new Date().toISOString();
	          const nativeChipRefProofPassed = Boolean(
	            refsAttachedForTrace &&
            (
              prepared.attachOutcome?.nativeComposerChipProof === true ||
              prepared.attachOutcome?.preSubmitRefs?.nativeComposerChipProof === true ||
              nativeCharacterPathCProofForTrace
            )
          );
          const requestObserverArmedBeforeClick = Boolean(
            requestObserverArmedAt &&
            clickDispatchedAt &&
            requestObserverArmedAt <= clickDispatchedAt
          );
          const createButtonClickedThroughDom = Boolean(!enterSubmit && clickDispatchedAt && buttonTopmostForTrace && hitLooksLikeCreateButton(hit));
          const responseAcceptedOrActive = Boolean(
            responseStatus >= 200 && responseStatus < 300
          );
          const visibleProjectMovieCardMatchesCurrentTask = frontSubmitSnapshotHasOmniVisibleProjectMovieCard(visibilitySnapshot, task);
          const strictDomGreenMissing = [];
          if (!nativeChipRefProofPassed) strictDomGreenMissing.push("native_chip_ref_proof_missing");
          if (!requestObserverArmedBeforeClick) strictDomGreenMissing.push("request_observer_not_armed_before_click");
          if (!createButtonClickedThroughDom) strictDomGreenMissing.push("create_button_dom_click_missing");
          if (!requestSeen) strictDomGreenMissing.push("endpoint_request_not_seen");
          if (!responseAcceptedOrActive) strictDomGreenMissing.push("response_not_accepted_or_active");
          if (!visibleProjectMovieCardMatchesCurrentTask) strictDomGreenMissing.push("matching_project_grid_movie_card_missing");
          const strictDomGreen = strictDomGreenMissing.length === 0;
          if (omniVisibilitySnapshotRecorded && (!strictDomGreen || omniVisibilitySnapshotStrictDomGreen)) return;
          omniVisibilitySnapshotRecorded = true;
          if (strictDomGreen) omniVisibilitySnapshotStrictDomGreen = true;
          const strictDomGreenReason = strictDomGreen
            ? "omni_visible_project_movie_card_seen"
            : `missing:${strictDomGreenMissing.join(",") || "unknown"}`;
          recordTrace(task, "omni_post_submit_visibility_snapshot", {
            classification: requestSeen && !visibleTransitionFound
              ? "omni_backend_submitted_without_visible_frontend_transition"
              : strictDomGreen
                ? "omni_strict_visible_dom_submit_observed"
                : visibleTransitionFound
                ? "omni_visible_frontend_transition_observed"
                : "omni_submit_visibility_unresolved",
            strictDomGreen,
            strictDomGreenReason,
            nativeChipRefProofPassed,
            requestObserverArmedBeforeClick,
            createButtonClickedThroughDom,
            responseAcceptedOrActive,
            visibleProjectMovieCardMatchesCurrentTask,
            composerPromptStillVisible: Boolean(visibilitySnapshot.promptStillVisible),
            nativeChipCount: Number(visibilitySnapshot.nativeChipCount || 0),
            generatedCardCount,
            failedCardCount: Number(visibilitySnapshot.failedProjectCardCount || 0),
            queuedCardCount: Number(visibilitySnapshot.queuedCardCount || 0),
	            progressCardCount,
	            movieCardCount: Number(visibilitySnapshot.movieCardCount || 0),
	            matchingPromptCardCount,
	            matchingMediaCardCount,
	            projectGridMovieQueuedCardCount,
	            matchingProjectGridMovieQueuedCardCount,
	            newProjectGridMovieQueuedCardCount,
	            changedProjectGridMovieQueuedCardCount,
	            staleCardFilteredCount,
	            galleryDeltaCount,
	            projectCardDeltaCount,
	            toastText: visibilitySnapshot.toastText || "",
	            route: visibilitySnapshot.route || "",
	            routeBeforeSubmit: frontSubmitBaseline?.route || "",
	            routeAfterSubmit: visibilitySnapshot.route || "",
	            projectId: prepared.projectId || "",
	            requestObserverArmedAt,
	            clickDispatchedAt,
	            proofWindowStartAt,
	            proofWindowEndAt,
	            requestSeen,
	            responseStatus,
	            downloadedMediaIds: mediaIdsFrom(task.downloadedMediaIds || []),
	            mediaIds,
	            uploadedRefIds,
	            serializedRefs,
	            endpoint: response?.endpoint || pageResponse?.endpoint || "",
	            matchingProjectGridMovieQueuedCards: visibilitySnapshot.matchingProjectGridMovieQueuedCards || [],
	            acceptedProjectMovieCardCandidates: visibilitySnapshot.acceptedProjectMovieCardCandidates || [],
	            rejectedProjectMovieCardCandidates: visibilitySnapshot.rejectedProjectMovieCardCandidates || [],
	            projectMovieCardCandidates: visibilitySnapshot.projectMovieCardCandidates || [],
	            visibleCandidateSelectors: visibilitySnapshot.visibleCandidateSelectors || []
	          });
          if (strictDomGreen) {
            recordTrace(task, "omni_visible_project_movie_card_seen", {
              strictDomGreen,
              strictDomGreenReason,
              matchingPromptCardCount,
              matchingMediaCardCount,
	              projectGridMovieQueuedCardCount,
	              matchingProjectGridMovieQueuedCardCount,
	              newProjectGridMovieQueuedCardCount,
	              changedProjectGridMovieQueuedCardCount,
	              staleCardFilteredCount,
	              requestSeen,
	              responseStatus,
	              mediaIds,
	              uploadedRefIds,
	              projectId: prepared.projectId || "",
	              routeBeforeSubmit: frontSubmitBaseline?.route || "",
	              routeAfterSubmit: visibilitySnapshot.route || "",
	              proofWindowStartAt,
	              proofWindowEndAt,
	              endpoint: response?.endpoint || pageResponse?.endpoint || "",
	              matchingProjectGridMovieQueuedCards: visibilitySnapshot.matchingProjectGridMovieQueuedCards || [],
	              acceptedProjectMovieCardCandidates: visibilitySnapshot.acceptedProjectMovieCardCandidates || []
	            });
	          }
	        };
        recordTrace(task, "response_result", {
          status: Number(response?.status || 0),
          error: response?.error || "",
          flowError: response?.flowError || null,
          mediaIdCount: mediaIds.length,
          mediaIds,
          expectedCount,
          pageCaptureProvedNoRequest,
          incomplete: Boolean(response?.incomplete)
        });
        recordOmniPostSubmitVisibilitySnapshot(frontTransition?.snapshot || {});
        let frontSubmitAlreadyMoved = frontSubmitTransitionHasStrongProof(frontTransition, task);
        let frontSubmitProvesGeneration = frontSubmitTransitionProvesGeneration(frontTransition, task);
        let frontSubmitHasActiveProgressProof = frontSubmitTransitionHasActiveProgressProof(frontTransition);
        const noRequestCaptureMiss = noRequestErrorPattern.test(String(response?.error || pageResponse?.error || ""));
        if (String(task.mode || "") === "text-to-image" && !mediaIds.length && !pageCaptureObservedRequest && noRequestCaptureMiss) {
          const noRequestSnapshot = await debuggerPostClickNoRequestSnapshot(target, task, {
            createPoint: safeCreatePoint,
            requestObserverArmedAt,
            clickDispatchedAt
          });
          recordTrace(task, "post_click_no_request_snapshot", noRequestSnapshot);
        }
        if (
          String(task.mode || "") === "text-to-image" &&
          !mediaIds.length &&
          !pageCaptureObservedRequest &&
          noRequestCaptureMiss &&
          (!frontSubmitProvesGeneration || !frontSubmitHasActiveProgressProof)
        ) {
          const refreshedFrontTransition = await waitForFrontSubmitTransition(target, task, 7000, {
            baselineProjectCardIds,
            baselineProjectCardSignatures,
            baselineGenerationProjectCardCount
          });
          recordTrace(task, "front_submit_transition_after_no_request", {
            ok: Boolean(refreshedFrontTransition?.ok),
            reason: refreshedFrontTransition?.reason || "",
            promptStillVisible: Boolean(refreshedFrontTransition?.snapshot?.promptStillVisible),
            createDisabled: Boolean(refreshedFrontTransition?.snapshot?.createDisabled),
            progressVisible: Boolean(refreshedFrontTransition?.snapshot?.progressVisible),
            matchingPromptCardCount: Number(refreshedFrontTransition?.snapshot?.matchingPromptCardCount || 0),
            matchingMediaCardCount: Number(refreshedFrontTransition?.snapshot?.matchingMediaCardCount || 0),
            newProjectCardCount: Number(refreshedFrontTransition?.snapshot?.newProjectCardCount || 0),
            generationProjectCardCount: Number(refreshedFrontTransition?.snapshot?.generationProjectCardCount || 0),
            progressCardCount: Number(refreshedFrontTransition?.snapshot?.progressCardCount || 0),
            failedProjectCardCount: Number(refreshedFrontTransition?.snapshot?.failedProjectCardCount || 0),
            failedNewProjectCardCount: Number(refreshedFrontTransition?.snapshot?.failedNewProjectCardCount || 0),
            failedMatchingPromptCardCount: Number(refreshedFrontTransition?.snapshot?.failedMatchingPromptCardCount || 0),
            failedMatchingMediaCardCount: Number(refreshedFrontTransition?.snapshot?.failedMatchingMediaCardCount || 0),
            matchingProjectCards: refreshedFrontTransition?.snapshot?.matchingProjectCards || [],
            newProjectCards: refreshedFrontTransition?.snapshot?.newProjectCards || [],
            failedProjectCards: refreshedFrontTransition?.snapshot?.failedProjectCards || []
          });
          if (refreshedFrontTransition?.ok) {
            frontTransition = refreshedFrontTransition;
            frontSubmitAlreadyMoved = frontSubmitTransitionHasStrongProof(frontTransition, task);
            frontSubmitProvesGeneration = frontSubmitTransitionProvesGeneration(frontTransition, task);
            frontSubmitHasActiveProgressProof = frontSubmitTransitionHasActiveProgressProof(frontTransition);
          }
        }
        const shouldRetryNoRequest = !frontSubmitAlreadyMoved || !frontSubmitProvesGeneration || !frontSubmitHasActiveProgressProof;
        const failedProjectCardErrorText = (failureResponse = null, failurePageResponse = null) => {
          const status = Number(failureResponse?.status || failurePageResponse?.status || 0);
          const flowError = failureResponse?.flowError || failurePageResponse?.flowError || {};
          const rejected = domSubmitRejectedError(status, flowError);
          return compactDiagnosticText(
            rejected ||
            failureResponse?.error ||
            failurePageResponse?.error ||
            failureResponse?.statusText ||
            failurePageResponse?.statusText ||
            "DOM_DEBUGGER_FLOW_FAILED_PROJECT_CARD",
            360
          );
        };
        const failCurrentFailedProjectCard = (failureFrontTransition, failureResponse = null, failurePageResponse = null) => {
          const snapshot = failureFrontTransition?.snapshot || {};
          const failureStatus = Number(failureResponse?.status || failurePageResponse?.status || 0);
          const failureError = failedProjectCardErrorText(failureResponse, failurePageResponse);
          recordTrace(task, "front_submit_failed_project_card", {
            status: failureStatus,
            error: failureError,
            debuggerError: "DOM_DEBUGGER_FLOW_FAILED_PROJECT_CARD",
            reason: failureFrontTransition?.reason || "",
            failedProjectCardCount: Number(snapshot.failedProjectCardCount || 0),
            failedNewProjectCardCount: Number(snapshot.failedNewProjectCardCount || 0),
            failedMatchingPromptCardCount: Number(snapshot.failedMatchingPromptCardCount || 0),
            failedMatchingMediaCardCount: Number(snapshot.failedMatchingMediaCardCount || 0),
            failedProjectCards: snapshot.failedProjectCards || []
          });
          return {
            ok: false,
            status: failureStatus,
            statusText: failureError,
            error: failureError,
            mediaIds: [],
            outputRows: Array.isArray(failureResponse?.outputRows) ? failureResponse.outputRows : [],
            data: {
              prepared,
              response: failureResponse,
              pageResponse: failurePageResponse,
              frontTransition: failureFrontTransition,
              transport: "chrome_debugger",
              debuggerError: "DOM_DEBUGGER_FLOW_FAILED_PROJECT_CARD"
            }
          };
        };
        if (!mediaIds.length && frontSubmitSnapshotHasCurrentFailedCard(frontTransition?.snapshot || {})) {
          return failCurrentFailedProjectCard(frontTransition, response, pageResponse);
        }
        if (!mediaIds.length && !pageCaptureObservedRequest && shouldRetryNoRequest && noRequestCaptureMiss) {
          const retryCaptureId = `${String(task.id || "task").trim() || "task"}-retry-${Date.now()}`;
          const modeAllowsEditRouteFollowup = ["image-to-video", "start-end-image-to-video", "text-to-video", "ingredients-to-video"].includes(String(task.mode || ""));
          const editRouteFollowup = modeAllowsEditRouteFollowup && frontSubmitSnapshotIsVideoContinuationEditRoute(frontTransition?.snapshot || {});
          recordTrace(task, "submit_no_request_retry_create_start", {
            previousError: response?.error || pageResponse?.error || "",
            retryCaptureId,
            frontSubmitAlreadyMoved,
            frontSubmitProvesGeneration,
            frontSubmitHasActiveProgressProof,
            editRouteFollowup
          });
          if (!editRouteFollowup && frontSubmitSnapshotIsVideoEditRoute(frontTransition?.snapshot || {})) {
            const retryPreCommitDetailClose = await debuggerCloseImageDetailIfOpen(target)
              .catch((error) => ({ ok: false, error: String(error?.message || error) }));
            recordTrace(task, "submit_no_request_retry_detail_close_before_recommit", {
              ok: Boolean(retryPreCommitDetailClose?.ok),
              closed: Boolean(retryPreCommitDetailClose?.closed),
              method: retryPreCommitDetailClose?.method || "",
              reason: retryPreCommitDetailClose?.reason || "",
              error: retryPreCommitDetailClose?.error || ""
            });
            if (retryPreCommitDetailClose?.closed) await sleep(1200);
            if (retryPreCommitDetailClose?.ok === false) {
              return {
                ok: false,
                status: 0,
                statusText: "DOM_DEBUGGER_IMAGE_DETAIL_EDITOR_OPEN",
                error: "DOM_DEBUGGER_IMAGE_DETAIL_EDITOR_OPEN",
                data: { prepared, retryPreCommitDetailClose, frontTransition, transport: "chrome_debugger" }
              };
            }
          }
          if (debuggerShouldReprepareBeforeNoRequestRetry(task, frontTransition)) {
            const retryVisibleSettings = await applyModeAndSettings({ target, task, trace: recordTrace })
              .catch((error) => ({ ok: false, error: String(error?.message || error || "DOM_DEBUGGER_RETRY_SETTINGS_FAILED") }));
            let retryPrepared = retryVisibleSettings?.ok
              ? await prepareForDebugger("submit_no_request_retry_reprepare", {
                  afterPromptInsert: true,
                  skipPostUploadSettle: false,
                  skipDomModeAndSettingsMutation: !debuggerShouldUsePageVisibleSettingsMutation(task),
                  skipSettingsSettle: debuggerShouldAvoidHiddenSettingsStoreRepair(task),
                  noRequestRetry: true
                })
              : null;
            if (
              retryVisibleSettings?.ok
              && !retryPrepared?.ok
              && debuggerShouldRecommitPromptBeforeNoRequestRetry(task)
              && /DOM_CREATE_BUTTON_NOT_FOUND|DOM_PROMPT_EDITOR_NOT_FOUND|DOM_PROMPT_EMPTY/i.test(String(retryPrepared?.error || ""))
            ) {
              const useNativePromptEntry = debuggerShouldTypePromptWithNativeInput(task);
              const usePathCNativeCharacterEntry = !useNativePromptEntry && debuggerShouldUsePathCNativeCharacterEntry(task);
              const retryRecommitPrep = useNativePromptEntry
                ? await debuggerTypePromptWithNativeInput(
                    target,
                    prepared.editorRect,
                    task.prompt,
                    recordTrace,
                    task,
                    "retry_after_no_request_before_reprepare"
                  )
                : usePathCNativeCharacterEntry
                  ? await debuggerInsertNativeCharacterChipsWithPathC({
                      target,
                      tabId,
                      task,
                      sendPageCommand,
                      trace: recordTrace,
                      reason: "retry_after_no_request_before_reprepare"
                    })
                : await sendPageCommand({
                    action: "domCommitPromptForDebugger",
                    task,
                    meta: { reason: "retry_after_no_request_before_reprepare" },
                    timeoutMs: 120000
                  }, tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "DOM_PROMPT_RECOMMIT_FAILED") }));
              const retryRecommitted = (useNativePromptEntry || usePathCNativeCharacterEntry) ? retryRecommitPrep : (retryRecommitPrep?.result?.result || retryRecommitPrep?.result || retryRecommitPrep);
              recordTrace(task, "submit_no_request_retry_reprepare_prompt_recommit", {
                ok: Boolean(retryRecommitted?.ok),
                error: retryRecommitted?.error || "",
                previousError: retryPrepared?.error || "",
                persisted: retryRecommitted?.commit?.persisted || "",
                storePersisted: retryRecommitted?.commit?.storePersisted || "",
                slatePersisted: retryRecommitted?.commit?.slatePersisted || "",
                method: retryRecommitted?.commit?.method || "",
                nativePromptEntry: useNativePromptEntry,
                createRect: retryRecommitted?.createRect || null,
                selector: retryRecommitted?.selector || "",
                strategy: retryRecommitted?.strategy || "",
                createDisabled: Boolean(retryRecommitted?.createButton?.disabled),
                selectedVideoDuration: retryRecommitted?.store?.selectedVideoDuration ?? null
              });
              if (retryRecommitted?.ok) {
                retryPrepared = await prepareForDebugger("submit_no_request_retry_reprepare_after_prompt", {
                  afterPromptInsert: true,
                  skipPostUploadSettle: false,
                  skipDomModeAndSettingsMutation: true,
                  skipSettingsSettle: debuggerShouldAvoidHiddenSettingsStoreRepair(task),
                  noRequestRetry: true
                });
              }
            }
            recordTrace(task, "submit_no_request_retry_reprepare", {
              ok: Boolean(retryPrepared?.ok),
              settingsOk: Boolean(retryVisibleSettings?.ok),
              settingsError: retryVisibleSettings?.error || "",
              error: retryPrepared?.error || "",
              editorText: Array.isArray(frontTransition?.snapshot?.editors) ? frontTransition.snapshot.editors.join(" ").slice(0, 240) : "",
              selectedVideoDuration: retryPrepared?.store?.selectedVideoDuration ?? null,
              videoApi: retryPrepared?.store?.currentModelKeys?.videoApi || "",
              videoModelKey: retryPrepared?.store?.currentModelKeys?.videoModelKey || "",
              refCount: Array.isArray(retryPrepared?.visible?.refs) ? retryPrepared.visible.refs.length : null
            });
            if (!retryPrepared?.ok) {
              const error = retryVisibleSettings?.error || retryPrepared?.error || "DOM_DEBUGGER_RETRY_REPREPARE_FAILED";
              return {
                ok: false,
                status: 0,
                statusText: error,
                error,
                data: { prepared, retryVisibleSettings, retryPrepared, frontTransition, transport: "chrome_debugger" }
              };
            }
            prepared.editorRect = retryPrepared.editorRect || prepared.editorRect;
            prepared.createRect = retryPrepared.createRect || prepared.createRect;
            prepared.selector = retryPrepared.selector || prepared.selector;
            prepared.strategy = retryPrepared.strategy || prepared.strategy;
            prepared.attachOutcome = retryPrepared.attachOutcome || prepared.attachOutcome;
            prepared.visible = retryPrepared.visible || prepared.visible;
            prepared.store = retryPrepared.store || prepared.store;
            prepared.createButton = retryPrepared.createButton || prepared.createButton;
            prepared.expected = retryPrepared.expected || prepared.expected;
          }
          if (debuggerShouldRecommitPromptBeforeNoRequestRetry(task)) {
            const useNativePromptEntry = debuggerShouldTypePromptWithNativeInput(task);
            const usePathCNativeCharacterEntry = !useNativePromptEntry && debuggerShouldUsePathCNativeCharacterEntry(task);
            const retryCommitPrep = useNativePromptEntry
              ? await debuggerTypePromptWithNativeInput(
                  target,
                  prepared.editorRect,
                  task.prompt,
                  recordTrace,
                  task,
                  "retry_after_no_request"
                )
              : usePathCNativeCharacterEntry
                ? await debuggerInsertNativeCharacterChipsWithPathC({
                    target,
                    tabId,
                    task,
                    sendPageCommand,
                    trace: recordTrace,
                    reason: "retry_after_no_request"
                  })
              : await sendPageCommand({
                  action: "domCommitPromptForDebugger",
                  task,
                  meta: { reason: "retry_after_no_request" },
                  timeoutMs: 120000
                }, tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "DOM_PROMPT_RECOMMIT_FAILED") }));
            const retryTyped = (useNativePromptEntry || usePathCNativeCharacterEntry) ? retryCommitPrep : (retryCommitPrep?.result?.result || retryCommitPrep?.result || retryCommitPrep);
            recordTrace(task, "submit_no_request_retry_prompt_recommit", {
              ok: Boolean(retryTyped?.ok),
              error: retryTyped?.error || "",
              persisted: retryTyped?.commit?.persisted || "",
              storePersisted: retryTyped?.commit?.storePersisted || "",
              slatePersisted: retryTyped?.commit?.slatePersisted || "",
              method: retryTyped?.commit?.method || "",
              nativePromptEntry: useNativePromptEntry,
              createRect: retryTyped?.createRect || null,
              selector: retryTyped?.selector || "",
              strategy: retryTyped?.strategy || "",
              createDisabled: Boolean(retryTyped?.createButton?.disabled),
              selectedVideoDuration: retryTyped?.store?.selectedVideoDuration ?? null,
              commitReceivedUserInput: retryTyped?.commit?.receivedUserInput || null,
              receivedUserInput: retryTyped?.store?.receivedUserInput || null
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
            prepared.editorRect = retryTyped.editorRect || prepared.editorRect;
            prepared.createRect = retryTyped.createRect || prepared.createRect;
            prepared.selector = retryTyped.selector || prepared.selector;
            prepared.strategy = retryTyped.strategy || prepared.strategy;
            prepared.visible = retryTyped.visible || prepared.visible;
            prepared.store = retryTyped.store || prepared.store;
            prepared.createButton = retryTyped.createButton || prepared.createButton;
            if (debuggerShouldNudgePromptWithNativeInput(task)) {
              const retryNativeNudge = await debuggerNudgePromptWithNativeInput(
                target,
                prepared.editorRect,
                recordTrace,
                task,
                "retry_after_no_request"
              );
              if (retryNativeNudge?.ok) {
                recordTrace(task, "submit_no_request_retry_native_input_nudge", retryNativeNudge);
              }
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
          const retryDetailClose = editRouteFollowup
            ? { ok: true, closed: false, method: "", reason: "keep_video_edit_route_for_retry" }
            : await debuggerCloseImageDetailIfOpen(target).catch((error) => ({ ok: false, error: String(error?.message || error) }));
          recordTrace(task, "submit_no_request_retry_detail_close", {
            ok: Boolean(retryDetailClose?.ok),
            closed: Boolean(retryDetailClose?.closed),
            method: retryDetailClose?.method || "",
            reason: retryDetailClose?.reason || "",
            error: retryDetailClose?.error || ""
          });
          if (retryDetailClose?.closed) await sleep(900);
          if (debuggerShouldFocusEditorBeforeSubmitClick(task) && prepared.editorRect) {
            const retryFocusPoint = pointFromRect(prepared.editorRect);
            await debuggerClick(target, retryFocusPoint).catch(() => {});
            await sleep(180);
            recordTrace(task, "submit_no_request_retry_editor_focus_before_click", {
              point: retryFocusPoint,
              mode: String(task.mode || "")
            });
          }
          let retryCreate = await debuggerStableCreateButtonPoint(target, 4200, {
            minWaitMs: 900,
            allowDetailEditor: editRouteFollowup
          });
          if (debuggerResultLooksDetached(retryCreate)) {
            recordTrace(task, "submit_no_request_retry_reattach", { reason: "debugger_detached_during_retry_create_stabilize" });
            const retryReattached = await ensureDebuggerAttached(tabId, recordTrace, task);
            target = retryReattached.target;
            await ensureNetworkEnabled(tabId, target);
            retryCreate = await debuggerStableCreateButtonPoint(target, 4200, {
              minWaitMs: 900,
              allowDetailEditor: editRouteFollowup
            });
          }
          let retryPoint = retryCreate?.ok && retryCreate.point
            ? retryCreate.point
            : safeCreatePoint;
          let retryHit = retryCreate?.hit || await debuggerHitTest(target, retryPoint);
          recordTrace(task, "submit_no_request_retry_create_click", {
            armed: Boolean(retryArmed?.ok),
            armError: retryArmed?.error || "",
            createPoint: retryPoint,
            liveCreate: retryCreate,
            hit: retryHit
          });
          let retryCanClickCreate = Boolean(retryArmed?.ok && hitLooksLikeCreateButton(retryHit, { allowDetailEditor: editRouteFollowup }));
          if (retryArmed?.ok && !retryCanClickCreate) {
            recordTrace(task, "submit_no_request_retry_create_covered_recover_start", {
              createPoint: retryPoint,
              liveCreate: retryCreate,
              hit: retryHit
            });
            await debuggerPressKey(target, "Escape", "Escape", 27, { holdMs: 25 }).catch(() => {});
            await sleep(550);
            const recoveredDetailClose = editRouteFollowup
              ? { ok: true, closed: false, method: "", reason: "keep_video_edit_route_for_retry_recover" }
              : await debuggerCloseImageDetailIfOpen(target).catch((error) => ({ ok: false, error: String(error?.message || error) }));
            if (recoveredDetailClose?.closed) await sleep(900);
            const recoveredCreate = await debuggerStableCreateButtonPoint(target, 5200, {
              minWaitMs: 900,
              allowDetailEditor: editRouteFollowup
            });
            const recoveredPoint = recoveredCreate?.ok && recoveredCreate.point ? recoveredCreate.point : retryPoint;
            const recoveredHit = recoveredCreate?.hit || await debuggerHitTest(target, recoveredPoint);
            recordTrace(task, "submit_no_request_retry_create_covered_recover_result", {
              detailClose: recoveredDetailClose,
              createPoint: recoveredPoint,
              liveCreate: recoveredCreate,
              hit: recoveredHit
            });
            if (hitLooksLikeCreateButton(recoveredHit, { allowDetailEditor: editRouteFollowup })) {
              retryCreate = recoveredCreate;
              retryPoint = recoveredPoint;
              retryHit = recoveredHit;
              retryCanClickCreate = true;
            }
          }
          if (retryCanClickCreate) {
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
              flowError: retryPageResponse?.flowError || null,
              responseBodyLength: Number(retryPageResponse?.responseBodyLength || 0),
              retryCaptureId
            });
            const retryPageCaptureObservedRequest = Number(retryPageResponse?.status || 0) > 0
              || Boolean(retryPageResponse?.endpoint)
              || Boolean(retryPageResponse?.serializedRefs)
              || Number(retryPageResponse?.capturedResponseCount || 0) > 0;
            const retryPageResponseError = String(retryPageResponse?.error || "");
            if (retryPageCaptureObservedRequest && /WRONG_ENDPOINT_FOR_MODE|DOM_SUBMIT_WRONG_ENDPOINT_FOR_MODE/i.test(retryPageResponseError)) {
              return {
                ok: false,
                status: Number(retryPageResponse?.status || 0),
                statusText: retryPageResponseError,
                error: retryPageResponseError,
                mediaIds: [],
                outputRows: Array.isArray(retryPageResponse?.outputRows) ? retryPageResponse.outputRows : [],
                data: { prepared, retryPageResponse, frontTransition, transport: "chrome_debugger" }
              };
            }
            const retryPageCaptureProvedNoRequest = !retryPageCaptureObservedRequest && noRequestErrorPattern.test(retryPageResponseError);
            const retryResponse = Array.isArray(retryPageResponse?.mediaIds) && retryPageResponse.mediaIds.length
              ? retryPageResponse
              : retryPageCaptureProvedNoRequest
                ? retryPageResponse
              : await retryNetworkResponsePromise;
            const retryMediaIds = mediaIdsFrom(retryResponse?.mediaIds || []);
            recordTrace(task, "response_retry_result", {
              status: Number(retryResponse?.status || 0),
              error: retryResponse?.error || "",
              flowError: retryResponse?.flowError || null,
              mediaIdCount: retryMediaIds.length,
              mediaIds: retryMediaIds,
              expectedCount,
              retryPageCaptureProvedNoRequest,
              incomplete: Boolean(retryResponse?.incomplete)
            });
            if (String(task.mode || "") === "text-to-image" && !retryMediaIds.length) {
              const retryFrontTransition = await waitForFrontSubmitTransition(target, task, 7000, {
                baselineProjectCardIds,
                baselineProjectCardSignatures,
                baselineGenerationProjectCardCount
              });
              recordTrace(task, "front_submit_transition_after_no_request_retry", {
                ok: Boolean(retryFrontTransition?.ok),
                reason: retryFrontTransition?.reason || "",
                promptStillVisible: Boolean(retryFrontTransition?.snapshot?.promptStillVisible),
                createDisabled: Boolean(retryFrontTransition?.snapshot?.createDisabled),
                progressVisible: Boolean(retryFrontTransition?.snapshot?.progressVisible),
                matchingPromptCardCount: Number(retryFrontTransition?.snapshot?.matchingPromptCardCount || 0),
                matchingMediaCardCount: Number(retryFrontTransition?.snapshot?.matchingMediaCardCount || 0),
                newProjectCardCount: Number(retryFrontTransition?.snapshot?.newProjectCardCount || 0),
                generationProjectCardCount: Number(retryFrontTransition?.snapshot?.generationProjectCardCount || 0),
                progressCardCount: Number(retryFrontTransition?.snapshot?.progressCardCount || 0),
                failedProjectCardCount: Number(retryFrontTransition?.snapshot?.failedProjectCardCount || 0),
                failedNewProjectCardCount: Number(retryFrontTransition?.snapshot?.failedNewProjectCardCount || 0),
                failedMatchingPromptCardCount: Number(retryFrontTransition?.snapshot?.failedMatchingPromptCardCount || 0),
                failedMatchingMediaCardCount: Number(retryFrontTransition?.snapshot?.failedMatchingMediaCardCount || 0),
                matchingProjectCards: retryFrontTransition?.snapshot?.matchingProjectCards || [],
                newProjectCards: retryFrontTransition?.snapshot?.newProjectCards || [],
                failedProjectCards: retryFrontTransition?.snapshot?.failedProjectCards || []
              });
              if (frontSubmitSnapshotHasCurrentFailedCard(retryFrontTransition?.snapshot || {})) {
                return failCurrentFailedProjectCard(retryFrontTransition, retryResponse, retryPageResponse);
              }
              if (retryFrontTransition?.ok) {
                frontTransition = retryFrontTransition;
                frontSubmitAlreadyMoved = frontSubmitTransitionHasStrongProof(frontTransition, task);
                frontSubmitProvesGeneration = frontSubmitTransitionProvesGeneration(frontTransition, task);
                frontSubmitHasActiveProgressProof = frontSubmitTransitionHasActiveProgressProof(frontTransition);
              }
            }
            if (String(task.mode || "") === "text-to-image" && !retryMediaIds.length && retryPageCaptureObservedRequest && retryPageResponse?.ok !== false) {
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
            } else {
              const retryObservedFailure = debuggerObservedFailureResponse(retryResponse, retryPageResponse);
              if (retryObservedFailure) {
                response = retryObservedFailure;
              }
            }
          }
        } else if (!mediaIds.length && !pageCaptureObservedRequest && frontSubmitAlreadyMoved && noRequestErrorPattern.test(String(response?.error || pageResponse?.error || ""))) {
          recordTrace(task, "submit_no_request_retry_skipped_front_moved", {
            previousError: response?.error || pageResponse?.error || "",
            frontTransitionReason: frontTransition?.reason || "",
            frontSubmitProvesGeneration,
            frontSubmitHasActiveProgressProof,
            promptStillVisible: Boolean(frontTransition?.snapshot?.promptStillVisible),
            matchingPromptCardCount: Number(frontTransition?.snapshot?.matchingPromptCardCount || 0),
            matchingMediaCardCount: Number(frontTransition?.snapshot?.matchingMediaCardCount || 0),
            failedProjectCardCount: Number(frontTransition?.snapshot?.failedProjectCardCount || 0)
          });
        }
        if (debuggerRequiresFrontSubmitTransition(task) && !frontSubmitTransitionHasStrongProof(frontTransition, task) && mediaIds.length) {
          const refreshedFrontTransition = await waitForFrontSubmitTransition(target, task, debuggerPostResponseFrontProofWaitMs(task), {
            mediaIds,
            baselineProjectCardIds,
            baselineProjectCardSignatures,
            baselineGenerationProjectCardCount,
            requireStrongProof: true
          });
          postResponseFrontTransition = refreshedFrontTransition;
          recordTrace(task, "front_submit_transition_after_response", {
            ok: Boolean(refreshedFrontTransition.ok),
            skipped: Boolean(refreshedFrontTransition.skipped),
            reason: refreshedFrontTransition.reason || "",
            promptStillVisible: Boolean(refreshedFrontTransition.snapshot?.promptStillVisible),
            createDisabled: Boolean(refreshedFrontTransition.snapshot?.createDisabled),
            progressVisible: Boolean(refreshedFrontTransition.snapshot?.progressVisible),
            matchingPromptCardCount: Number(refreshedFrontTransition.snapshot?.matchingPromptCardCount || 0),
            matchingMediaCardCount: Number(refreshedFrontTransition.snapshot?.matchingMediaCardCount || 0),
            newProjectCardCount: Number(refreshedFrontTransition.snapshot?.newProjectCardCount || 0),
            generationProjectCardCount: Number(refreshedFrontTransition.snapshot?.generationProjectCardCount || 0),
            totalGenerationProjectCardCount: Number(refreshedFrontTransition.snapshot?.totalGenerationProjectCardCount || 0),
            generationProjectCardDelta: Number(refreshedFrontTransition.snapshot?.generationProjectCardDelta || 0),
            progressCardCount: Number(refreshedFrontTransition.snapshot?.progressCardCount || 0),
            failedProjectCardCount: Number(refreshedFrontTransition.snapshot?.failedProjectCardCount || 0),
            failedNewProjectCardCount: Number(refreshedFrontTransition.snapshot?.failedNewProjectCardCount || 0),
            failedMatchingPromptCardCount: Number(refreshedFrontTransition.snapshot?.failedMatchingPromptCardCount || 0),
            failedMatchingMediaCardCount: Number(refreshedFrontTransition.snapshot?.failedMatchingMediaCardCount || 0),
            matchingProjectCards: refreshedFrontTransition.snapshot?.matchingProjectCards || [],
            newProjectCards: refreshedFrontTransition.snapshot?.newProjectCards || [],
            failedProjectCards: refreshedFrontTransition.snapshot?.failedProjectCards || [],
            mediaIds,
            editors: refreshedFrontTransition.snapshot?.editors || []
          });
          if (refreshedFrontTransition.ok) {
            frontTransition = refreshedFrontTransition;
          }
        }
        recordOmniPostSubmitVisibilitySnapshot(postResponseFrontTransition?.snapshot || frontTransition?.snapshot || {});
        const frontSubmitObservedStatus = Number(response?.status || pageResponse?.status || 0);
        const t2iRequestAcceptedWithoutMediaIds = String(task.mode || "") === "text-to-image"
          && !mediaIds.length
          && pageCaptureObservedRequest
          && Boolean(response?.ok || pageResponse?.ok)
          && frontSubmitObservedStatus >= 200
          && frontSubmitObservedStatus < 300;
        const videoFrontSubmitObservedWithoutMediaIds = !mediaIds.length
          && debuggerCanAcceptFrontSubmitWithoutMediaIds(task, frontTransition);
        const t2iNoRequestFrontProof = String(task.mode || "") === "text-to-image"
          && !mediaIds.length
          && !pageCaptureObservedRequest
          && frontSubmitObservedStatus === 0
          && frontSubmitHasActiveProgressProof;
        const frontSubmitObservedWithoutMediaIds = (
          String(task.mode || "") === "text-to-image"
            && !mediaIds.length
            && (Boolean(frontTransition?.ok) || t2iRequestAcceptedWithoutMediaIds)
            && (pageCaptureObservedRequest || frontSubmitObservedStatus > 0 || t2iNoRequestFrontProof)
            && (frontSubmitObservedStatus === 0 || (frontSubmitObservedStatus >= 200 && frontSubmitObservedStatus < 500))
        ) || videoFrontSubmitObservedWithoutMediaIds;
        let frontSubmitReveal = null;
        const revealFrontSubmitProofCard = async (reason) => {
          if (frontSubmitReveal || !debuggerRequiresFrontSubmitTransition(task) || !frontSubmitTransitionHasStrongProof(frontTransition, task)) {
            return frontSubmitReveal;
          }
          frontSubmitReveal = await debuggerRevealFrontSubmitProofCard(target, task, frontTransition, { mediaIds })
            .catch((error) => ({ ok: false, reason: "reveal_failed", error: String(error?.message || error) }));
          recordTrace(task, "front_submit_reveal_card", {
            ok: Boolean(frontSubmitReveal?.ok),
            reason,
            revealReason: frontSubmitReveal?.reason || "",
            error: frontSubmitReveal?.error || "",
            tileId: frontSubmitReveal?.tileId || "",
            text: frontSubmitReveal?.text || "",
            score: Number(frontSubmitReveal?.score || 0),
            mediaMatch: Boolean(frontSubmitReveal?.mediaMatch),
            promptMatch: Boolean(frontSubmitReveal?.promptMatch),
            tileMatch: Boolean(frontSubmitReveal?.tileMatch),
            beforeInViewport: Boolean(frontSubmitReveal?.beforeInViewport),
            afterInViewport: Boolean(frontSubmitReveal?.afterInViewport),
            before: frontSubmitReveal?.before || null,
            after: frontSubmitReveal?.after || null,
            scrollY: Number(frontSubmitReveal?.scrollY || 0),
            mediaIds
          });
          return frontSubmitReveal;
        };
        if (frontSubmitObservedWithoutMediaIds) {
          await revealFrontSubmitProofCard("front_submit_without_media_ids");
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
          const error = normalizeDomSubmitFailureError(response, pageResponse?.error || "request_not_observed");
          return {
            ok: false,
            status: Number(response?.status || 0),
            statusText: error,
            error,
            data: {
              prepared,
              response,
              pageResponse,
              frontTransition,
              transport: "chrome_debugger",
              classification: pageCaptureObservedRequest ? "request_seen_without_visible_pending" : "transport_failed_before_click"
            }
          };
        }
        let frontSubmitProofMissing = debuggerRequiresFrontSubmitTransition(task) && !frontSubmitTransitionHasStrongProof(frontTransition, task);
        const responseStatusForFrontProof = Number(response?.status || pageResponse?.status || 0);
        if (frontSubmitProofMissing
          && mediaIds.length
          && responseStatusForFrontProof >= 200
          && responseStatusForFrontProof < 300
          && debuggerAllowsFrontSubmitReloadRepair(task)) {
          recordTrace(task, "front_submit_transition_reload_repair_start", {
            reason: frontTransition.reason || "front_transition_missing_but_dom_response_confirmed",
            mediaIdCount: mediaIds.length,
            mediaIds,
            expectedCount,
            baselineProjectCardCount: Array.isArray(baselineProjectCardIds) ? baselineProjectCardIds.length : 0
          });
          const reloadResult = await debuggerSend(target, "Page.reload", { ignoreCache: false })
            .then(() => ({ ok: true }))
            .catch((error) => ({ ok: false, error: String(error?.message || error || "PAGE_RELOAD_FAILED") }));
          if (reloadResult.ok) {
            await sleep(4200);
          }
          const reloadFrontTransition = reloadResult.ok
            ? await waitForFrontSubmitTransition(
                target,
                task,
                debuggerIsOmniIngredientsTask(task) ? debuggerPostResponseFrontProofWaitMs(task) : 24000,
                {
                  mediaIds,
                  baselineProjectCardIds,
                  baselineProjectCardSignatures,
                  baselineGenerationProjectCardCount,
                  requireStrongProof: true
                }
              )
            : { ok: false, reason: "reload_failed", error: reloadResult.error, snapshot: null };
          recordTrace(task, "front_submit_transition_reload_repair_result", {
            ok: Boolean(reloadFrontTransition.ok),
            reloadOk: Boolean(reloadResult.ok),
            reloadError: reloadResult.error || "",
            reason: reloadFrontTransition.reason || "",
            promptStillVisible: Boolean(reloadFrontTransition.snapshot?.promptStillVisible),
            createDisabled: Boolean(reloadFrontTransition.snapshot?.createDisabled),
            progressVisible: Boolean(reloadFrontTransition.snapshot?.progressVisible),
            matchingPromptCardCount: Number(reloadFrontTransition.snapshot?.matchingPromptCardCount || 0),
            matchingMediaCardCount: Number(reloadFrontTransition.snapshot?.matchingMediaCardCount || 0),
            newProjectCardCount: Number(reloadFrontTransition.snapshot?.newProjectCardCount || 0),
            generationProjectCardCount: Number(reloadFrontTransition.snapshot?.generationProjectCardCount || 0),
            totalGenerationProjectCardCount: Number(reloadFrontTransition.snapshot?.totalGenerationProjectCardCount || 0),
            generationProjectCardDelta: Number(reloadFrontTransition.snapshot?.generationProjectCardDelta || 0),
            progressCardCount: Number(reloadFrontTransition.snapshot?.progressCardCount || 0),
            failedProjectCardCount: Number(reloadFrontTransition.snapshot?.failedProjectCardCount || 0),
            failedNewProjectCardCount: Number(reloadFrontTransition.snapshot?.failedNewProjectCardCount || 0),
            failedMatchingPromptCardCount: Number(reloadFrontTransition.snapshot?.failedMatchingPromptCardCount || 0),
            failedMatchingMediaCardCount: Number(reloadFrontTransition.snapshot?.failedMatchingMediaCardCount || 0),
            matchingProjectCards: reloadFrontTransition.snapshot?.matchingProjectCards || [],
            newProjectCards: reloadFrontTransition.snapshot?.newProjectCards || [],
            failedProjectCards: reloadFrontTransition.snapshot?.failedProjectCards || [],
            mediaIds,
            editors: reloadFrontTransition.snapshot?.editors || []
          });
          recordOmniPostSubmitVisibilitySnapshot(reloadFrontTransition.snapshot || {});
          if (frontSubmitTransitionHasStrongProof(reloadFrontTransition, task)) {
            frontTransition = reloadFrontTransition;
          }
          frontSubmitProofMissing = debuggerRequiresFrontSubmitTransition(task) && !frontSubmitTransitionHasStrongProof(frontTransition, task);
        }
        if (!frontSubmitProofMissing) {
          await revealFrontSubmitProofCard("front_submit_confirmed");
        }
        const allowNetworkOnlyFrontSubmit = debuggerAllowsNetworkOnlyFrontSubmit(task);
        const frontSubmitNetworkOnlyAccepted = false;
        if (frontSubmitProofMissing && mediaIds.length) {
          recordTrace(task, "front_submit_transition_network_only_rejected", {
            reason: frontTransition.reason || "front_transition_missing_but_dom_response_confirmed",
            allowNetworkOnlyFrontSubmit,
            mediaIdCount: mediaIds.length,
            mediaIds,
            expectedCount,
            promptStillVisible: Boolean(frontTransition.snapshot?.promptStillVisible),
            progressVisible: Boolean(frontTransition.snapshot?.progressVisible),
            createDisabled: Boolean(frontTransition.snapshot?.createDisabled),
            newProjectCardCount: Number(frontTransition.snapshot?.newProjectCardCount || 0),
            generationProjectCardCount: Number(frontTransition.snapshot?.generationProjectCardCount || 0),
            failedProjectCardCount: Number(frontTransition.snapshot?.failedProjectCardCount || 0),
            newProjectCards: frontTransition.snapshot?.newProjectCards || []
          });
        }
        if (frontSubmitProofMissing && !frontSubmitNetworkOnlyAccepted) {
          const failedSubmitCleanup = mediaIds.length
            ? await sendPageCommand({
                action: "domClearPromptAfterDebuggerSubmit",
                task,
                meta: { reason: "debugger_frontend_not_updated_cleanup" },
                timeoutMs: 10000
              }, tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "DOM_PROMPT_CLEAR_FAILED") }))
            : null;
          const failedCleanupResult = failedSubmitCleanup?.result?.result || failedSubmitCleanup?.result || failedSubmitCleanup;
          if (mediaIds.length) {
            recordTrace(task, "prompt_clear_after_frontend_miss", {
              ok: Boolean(failedCleanupResult?.ok),
              error: failedCleanupResult?.error || "",
              frameSlotClears: failedCleanupResult?.frameSlotClears || []
            });
          }
          return {
            ok: false,
            status: responseStatusForFrontProof,
            statusText: "DOM_DEBUGGER_FRONTEND_NOT_UPDATED",
            error: "DOM_DEBUGGER_FRONTEND_NOT_UPDATED",
            mediaIds,
            outputRows: Array.isArray(response?.outputRows) ? response.outputRows : [],
            data: { prepared, response, frontTransition, transport: "chrome_debugger", classification: "request_seen_without_visible_pending" }
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
            frontendProofMissing: frontSubmitProofMissing,
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
