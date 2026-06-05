import { MessageType, createMessage, isAutoFlowRebuildMessage } from "../core/contracts/messages.js";
import { createChromeStorageAdapter, createLicenseClient } from "../core/auth/license-client.js";
import { queueStartAccessFromAuthSummary, queueStartAccessNeedsFreshBackend, refreshQueueStartAccessBeforeBlock } from "../core/auth/queue-start-access.js";
import { promptUsageCountForTask, promptUsageIdempotencyKey, shouldRecordPromptUsageForTask } from "../core/auth/prompt-usage.js";
import { createFlowClient, extractMediaIds } from "../core/media/flow-client.js";
import { createPageFlowTransport } from "../core/media/page-flow-transport.js";
import { createTaskLedger, sanitizeTaskForDebugReport, TaskStatus } from "../core/queue/task-ledger.js";
import { createScheduler, detectFlowRendererCrashSnapshot, flowRendererCrashErrorCode } from "../core/queue/scheduler.js";
import { buildRecoveryReportFields, classifyRecoveryPolicy, isHardQuotaFailure } from "../core/queue/recovery-policy.js";
import { createQueueExecutor } from "../core/queue/executor.js";
import { buildContinuityRefPatch } from "../core/queue/continuity-chain.js";
import { activeVideoTaskBeforeComposerRetry } from "../core/queue/video-retry-policy.js";
import { buildGalleryItemsFromTasks, buildPartialVideoCompletionPatch, canonicalGalleryItems, deriveTaskOutputLedger, filterGalleryItemsForProject, filterUsableGalleryItems, planMediaDownloads, reconcileTasksWithDownloadResults, reconcileTasksWithGalleryItems, reconcileTasksWithProjectMediaFeed, referenceMediaIdsFromTasks } from "../core/gallery/media-ledger.js";
import { buildMediaRedirectUrl, buildMediaThumbnailUrl } from "../core/contracts/api.js";
import { createDebuggerEngine, releaseDebuggerSessions } from "./debugger-engine.js";

const runtimeState = {
  bridgeHealthy: false,
  queueRunning: false,
  queueRunToken: 0,
  activeTabId: null,
  projectId: "",
  pageUrl: "",
  pageTitle: "",
  authEnvironment: null,
  auth: null,
  lastGalleryItems: [],
  lastGalleryProjectId: "",
  events: []
};
const flowSessionRecoveryState = {
  runToken: 0,
  attempts: 0,
  active: false,
  lastTriggerError: "",
  lastFlowErrorCode: "",
  lastStatus: 0,
  lastTaskId: "",
  lastStartedAt: 0,
  recentSessionRejectionAt: 0
};
const flowRendererCrashRecoveryState = {
  runToken: 0,
  attempts: 0,
  active: false,
  lastTriggerError: "",
  lastTaskId: "",
  lastStartedAt: 0
};
const QUEUE_STORAGE_KEY = "autoflow-10767-rebuild-queue-ledger";
const RUNTIME_BINDING_STORAGE_KEY = "autoflow-1080-runtime-binding";
const DOM_DEBUGGER_TRACE_STORAGE_KEY = "autoflow-1081-dom-debugger-trace";
const DOWNLOAD_RESERVATION_TTL_MS = 10 * 60 * 1000;
const EXPECTED_FLOW_BRIDGE_VERSION = "10.8.8-final-rc-pathc-f2v-omni-v247";
const EXPECTED_PAGE_HOOK_VERSION = "10.8.8-final-rc-pathc-f2v-omni-v247";
const FLOW_BRIDGE_SCRIPT_PATH = "src/content/page-bridge.js";
const FLOW_PAGE_HOOK_SCRIPT_PATH = "src/page/page-hook.js";
const REQUIRED_EXTENSION_BRIDGE_FILES = Object.freeze([
  FLOW_BRIDGE_SCRIPT_PATH,
  FLOW_PAGE_HOOK_SCRIPT_PATH,
  "build-fingerprint.json"
]);
const DOM_DEBUGGER_TRANSPORT_ENABLED = true;
const FLOW_ORIGINS = ["https://labs.google", "https://labs.google.com"];
const FLOW_COOKIE_HOSTS = ["labs.google", ".labs.google", "labs.google.com", ".labs.google.com"];
const PRESERVED_FLOW_COOKIE_RE = /(^|_)(SID|HSID|SSID|APISID|SAPISID|LSID|OSID|ACCOUNT|LOGIN|AUTH|TOKEN|NID|AEC|SOCS)(_|$)/i;
const ledger = createTaskLedger();
const scheduler = createScheduler({ ledger, maxAttempts: 12 });
const downloadReservations = {
  artifacts: new Map(),
  targets: new Map()
};
const pendingNativeDownloadFilenames = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RECOVERABLE_GLOBAL_HEAL_ACTIONS = new Set(["cooldown_and_refresh", "reconnect_flow", "wait_for_capacity", "backoff", "recover_flow_session", "recover_flow_page"]);
const MAX_FLOW_SESSION_RECOVERY_ATTEMPTS = 3;
const MAX_FLOW_RENDERER_CRASH_RECOVERY_ATTEMPTS = 2;
const FLOW_SESSION_RECOVERY_RECENT_MS = 5 * 60 * 1000;
const FLOW_SESSION_RECOVERY_LEVELS = Object.freeze(["soft_reload", "cache_clear_reload", "service_worker_bypass_reload"]);
const FLOW_RENDERER_CRASH_RECOVERY_LEVELS = Object.freeze(["soft_reload", "cache_clear_reload"]);
const licenseClient = createLicenseClient({
  storage: createChromeStorageAdapter(),
  environmentProvider: () => runtimeState.authEnvironment || {
    userAgent: navigator.userAgent || "",
    screen: { width: 0, height: 0 }
  },
  openTab: async (url) => chrome.tabs.create({ url })
});
const queueReady = restoreQueueFromStorage();

function recordEvent(event) {
  runtimeState.events.push({
    at: new Date().toISOString(),
    ...event
  });
  if (runtimeState.events.length > 500) runtimeState.events.shift();
}

function recordDebuggerTrace(task = {}, stage = "", detail = {}) {
  const at = new Date().toISOString();
  const entry = {
    at,
    type: "queue.dom.debugger.trace",
    taskId: task?.id || "",
    stage,
    mode: task?.mode || "",
    prompt: String(task?.prompt || "").slice(0, 120),
    repeatCount: Number(task?.repeatCount || 1) || 1,
    videoLength: String(task?.videoLength || task?.videoDurationSeconds || ""),
    model: task?.model || "",
    aspectRatio: task?.aspectRatio || "",
    ...detail
  };
  recordEvent(entry);
  chrome.storage?.local?.get?.(DOM_DEBUGGER_TRACE_STORAGE_KEY).then((stored = {}) => {
    const prior = Array.isArray(stored[DOM_DEBUGGER_TRACE_STORAGE_KEY]) ? stored[DOM_DEBUGGER_TRACE_STORAGE_KEY] : [];
    return chrome.storage.local.set({
      [DOM_DEBUGGER_TRACE_STORAGE_KEY]: prior.concat(entry).slice(-80)
    });
  }).catch(() => {});
  if (stage === "front_submit_transition_accepted_without_media_ids" && String(task?.mode || "") === "text-to-image" && task?.id) {
    const latest = ledger.getTask(task.id);
    if (latest && latest.status !== TaskStatus.complete && latest.status !== TaskStatus.failed) {
      const imageTask = ledger.updateTask(task.id, {
        status: TaskStatus.generating,
        submittedAt: latest.submittedAt || at,
        expectedImages: Number(task.repeatCount || latest.repeatCount || latest.expectedImages || 1) || 1,
        lastError: "",
        failureClass: "",
        healAction: ""
      });
      recordEvent({
        type: "queue.task.state",
        taskId: task.id,
        reason: "front_submit_observed",
        status: imageTask?.status || TaskStatus.generating,
        attempts: Number(imageTask?.attempts || 0),
        mediaIds: Array.isArray(imageTask?.mediaIds) ? imageTask.mediaIds : [],
        foundImages: Number(imageTask?.foundImages || 0),
        expectedImages: Number(imageTask?.expectedImages || 0),
        foundVideos: Number(imageTask?.foundVideos || 0),
        expectedVideos: Number(imageTask?.expectedVideos || 0)
      });
      persistQueueState().catch(() => {});
    }
  }
}

function compactString(value = "") {
  return String(value || "").trim();
}

function diagnosticString(value = "") {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (value instanceof Error) return String(value.message || value).trim();
  const parts = [];
  const collect = (entry) => {
    if (entry === null || entry === undefined || entry === "") return;
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      parts.push(String(entry).trim());
      return;
    }
    if (entry instanceof Error) {
      parts.push(String(entry.message || entry).trim());
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach(collect);
      return;
    }
    if (typeof entry === "object") {
      [
        entry.error,
        entry.code,
        entry.reason,
        entry.status,
        entry.statusText,
        entry.message,
        entry.details
      ].forEach(collect);
    }
  };
  collect(value);
  const text = [...new Set(parts.filter(Boolean))].join(" ");
  if (text) return text;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value || "").trim();
  }
}

function runtimeBindingPayload(tab = {}, extra = {}) {
  const tabUrl = compactString(tab.url || "");
  const tabIsFlow = !tabUrl || isFlowToolUrl(tabUrl);
  const tabId = tabIsFlow ? (tab?.id || null) : null;
  const hintedTabId = Number(extra.tabId || extra.activeTabId || 0) || null;
  const activeTabId = tabId || hintedTabId || null;
  const url = compactString((tabIsFlow ? tabUrl : "") || extra.href || extra.url || tabUrl);
  const projectId = compactString(extra.projectId || projectIdFromUrl(url));
  return {
    activeTabId,
    projectId,
    pageUrl: url,
    pageTitle: compactString((activeTabId ? tab?.title : "") || extra.title || ""),
    connected: Boolean(activeTabId && projectId),
    error: projectId ? null : (tabId || hintedTabId || runtimeState.activeTabId ? "missing_project_id" : "flow_tab_not_found"),
    lastSyncAt: new Date().toISOString()
  };
}

async function persistRuntimeBinding() {
  try {
    await chrome.storage.local.set({
      [RUNTIME_BINDING_STORAGE_KEY]: {
        activeTabId: runtimeState.activeTabId || null,
        projectId: runtimeState.projectId || "",
        pageUrl: runtimeState.pageUrl || "",
        pageTitle: runtimeState.pageTitle || "",
        updatedAt: new Date().toISOString()
      }
    });
  } catch (_error) {}
}

function promoteFlowTabBinding(tab = {}, extra = {}, reason = "unknown") {
  const binding = runtimeBindingPayload(tab, extra);
  if (!binding.activeTabId || !isFlowToolUrl(binding.pageUrl)) return null;
  const changed = runtimeState.activeTabId !== binding.activeTabId
    || runtimeState.projectId !== binding.projectId
    || runtimeState.pageUrl !== binding.pageUrl;
  runtimeState.activeTabId = binding.activeTabId;
  runtimeState.projectId = binding.projectId;
  runtimeState.pageUrl = binding.pageUrl;
  runtimeState.pageTitle = binding.pageTitle;
  if (binding.projectId) runtimeState.lastGalleryProjectId = binding.projectId;
  if (changed) {
    recordEvent({
      type: "runtime.flow_tab.promoted",
      tabId: binding.activeTabId,
      projectId: binding.projectId,
      reason
    });
    persistRuntimeBinding().catch(() => null);
  }
  return binding;
}

function isMaintenanceAction(action = "") {
  return [
    "clear_flow_cache",
    "clearFlowCache",
    "clear_flow_cookies",
    "clearFlowCookies",
    "clear_all_flow_data",
    "clearAllFlowData",
    "reload_flow_tab",
    "reloadFlowTab"
  ].includes(String(action || ""));
}

async function reloadFlowTab(tabId = 0) {
  const tab = await findFlowTab(Number(tabId || 0) || undefined).catch(() => null);
  if (!tab?.id || !chrome.tabs?.reload) return { ok: false, error: "flow_tab_not_found" };
  await chrome.tabs.reload(tab.id);
  return { ok: true, tabId: tab.id };
}

async function reloadFlowTabAndWait(tabId = 0, projectId = "", reason = "") {
  const reload = await reloadFlowTab(tabId);
  const wait = reload?.ok && projectId
    ? await waitForFlowProjectRoot(reload.tabId, projectId).catch((error) => ({
      ok: false,
      error: String(error?.message || error || "flow_project_root_navigation_timeout")
    }))
    : null;
  recordEvent({
    type: "maintenance.reload_flow_tab",
    tabId: reload?.tabId || tabId || null,
    projectId: String(projectId || ""),
    reason: String(reason || ""),
    ok: reload?.ok !== false && (!wait || wait.ok !== false),
    reloadOk: reload?.ok !== false,
    waitOk: wait ? wait.ok !== false : null,
    error: reload?.ok === false ? reload.error || "tab_reload_failed" : wait?.error || ""
  });
  return {
    ok: reload?.ok !== false && (!wait || wait.ok !== false),
    action: "reload_flow_tab",
    source: "background",
    reason: String(reason || ""),
    tabReload: reload,
    wait
  };
}

async function clearFlowCacheInBackground() {
  const result = {
    ok: true,
    action: "clear_flow_cache",
    source: "background",
    origins: FLOW_ORIGINS,
    browsingData: false,
    pageBridge: null
  };
  if (chrome.browsingData?.remove) {
    await chrome.browsingData.remove(
      { origins: FLOW_ORIGINS },
      {
        appcache: true,
        cache: true,
        cacheStorage: true,
        fileSystems: true,
        indexedDB: true,
        localStorage: true,
        serviceWorkers: true,
        webSQL: true
      }
    );
    result.browsingData = true;
  } else {
    result.browsingData = false;
    result.warning = "browsingData_unavailable";
  }
  try {
    const tab = await findFlowTab();
    if (tab?.id) {
      result.pageBridge = await sendPageCommand({ action: "clear_flow_cache", timeoutMs: 15000 }, tab.id);
      await sleep(300);
      result.tabReload = await reloadFlowTab(tab.id);
    }
  } catch (error) {
    result.pageBridge = { ok: false, error: String(error?.message || error || "page_bridge_failed") };
  }
  recordEvent({ type: "maintenance.clear_flow_cache", browsingData: result.browsingData, pageBridgeOk: result.pageBridge?.ok !== false, tabReloaded: result.tabReload?.ok === true });
  return result;
}

async function clearFlowCookiesInBackground() {
  const cookies = [];
  for (const domain of FLOW_COOKIE_HOSTS) {
    const matches = await chrome.cookies.getAll({ domain }).catch(() => []);
    cookies.push(...matches);
  }
  const seen = new Set();
  let deleted = 0;
  let preserved = 0;
  for (const cookie of cookies) {
    const key = `${cookie.domain}|${cookie.path}|${cookie.name}|${cookie.storeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (PRESERVED_FLOW_COOKIE_RE.test(cookie.name)) {
      preserved += 1;
      continue;
    }
    const host = String(cookie.domain || "").replace(/^\./, "");
    const url = `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`;
    await chrome.cookies.remove({ url, name: cookie.name, storeId: cookie.storeId }).catch(() => null);
    deleted += 1;
  }
  const result = {
    ok: true,
    action: "clear_flow_cookies",
    source: "background",
    deleted,
    preserved,
    scanned: seen.size,
    hosts: FLOW_COOKIE_HOSTS
  };
  result.tabReload = await reloadFlowTab().catch((error) => ({ ok: false, error: String(error?.message || error || "tab_reload_failed") }));
  recordEvent({ type: "maintenance.clear_flow_cookies", deleted, preserved, scanned: seen.size, tabReloaded: result.tabReload?.ok === true });
  return result;
}

async function clearAllFlowDataInBackground() {
  const result = {
    ok: true,
    action: "clear_all_flow_data",
    source: "background",
    origins: FLOW_ORIGINS,
    browsingData: false,
    deleted: 0,
    scanned: 0
  };
  if (chrome.browsingData?.remove) {
    await chrome.browsingData.remove(
      { origins: FLOW_ORIGINS },
      {
        appcache: true,
        cache: true,
        cacheStorage: true,
        cookies: true,
        fileSystems: true,
        indexedDB: true,
        localStorage: true,
        serviceWorkers: true,
        webSQL: true
      }
    );
    result.browsingData = true;
  }
  const seen = new Set();
  for (const domain of FLOW_COOKIE_HOSTS) {
    const matches = await chrome.cookies.getAll({ domain }).catch(() => []);
    for (const cookie of matches) {
      const key = `${cookie.domain}|${cookie.path}|${cookie.name}|${cookie.storeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const host = String(cookie.domain || "").replace(/^\./, "");
      const url = `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`;
      await chrome.cookies.remove({ url, name: cookie.name, storeId: cookie.storeId }).catch(() => null);
      result.deleted += 1;
    }
  }
  result.scanned = seen.size;
  result.tabReload = await reloadFlowTab().catch((error) => ({ ok: false, error: String(error?.message || error || "tab_reload_failed") }));
  recordEvent({ type: "maintenance.clear_all_flow_data", browsingData: result.browsingData, deleted: result.deleted, scanned: result.scanned, tabReloaded: result.tabReload?.ok === true });
  return result;
}

async function runBackgroundMaintenanceAction(action = "", payload = {}) {
  if (action === "reload_flow_tab" || action === "reloadFlowTab") {
    return reloadFlowTabAndWait(
      Number(payload?.tabId || runtimeState.activeTabId || 0) || 0,
      payload?.projectId || runtimeState.projectId || "",
      payload?.reason || ""
    );
  }
  if (action === "clear_flow_cache" || action === "clearFlowCache") return clearFlowCacheInBackground();
  if (action === "clear_flow_cookies" || action === "clearFlowCookies") return clearFlowCookiesInBackground();
  if (action === "clear_all_flow_data" || action === "clearAllFlowData") return clearAllFlowDataInBackground();
  return { ok: false, action, error: "unknown_maintenance_action" };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const match = takePendingNativeDownloadFilename(downloadItem);
  if (!match?.filename) return;
  suggest({
    filename: match.filename,
    conflictAction: "uniquify"
  });
  recordEvent({
    type: "media.download.filename_suggest",
    downloadId: downloadItem?.id || null,
    mediaId: match.mediaId || "",
    fileName: match.filename,
    url: downloadItem?.url || "",
    finalUrl: downloadItem?.finalUrl || ""
  });
});

function queueState() {
  repairQueueDownloadStateFromEvents("queue_state");
  const tasks = ledger.listTasks();
  const taskLedgerSnapshot = typeof ledger.debugSnapshot === "function"
    ? ledger.debugSnapshot()
    : tasks.map((task) => sanitizeTaskForDebugReport(task));
  return {
    tasks,
    taskLedgerSnapshot,
    events: runtimeState.events.slice(-200),
    generatedMediaIds: [...new Set(taskLedgerSnapshot
      .flatMap((task) => Array.isArray(task.generatedMediaIds) ? task.generatedMediaIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean))],
    hasOpenTasks: ledger.hasOpenTasks()
  };
}

async function restoreQueueFromStorage() {
  try {
    const stored = await chrome.storage.local.get(QUEUE_STORAGE_KEY);
    const snapshot = stored?.[QUEUE_STORAGE_KEY];
    const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
    ledger.replaceTasks(tasks.map((task) => {
      const restoredStatus = restoreTaskStatus(task);
      const status = restoredStatus || task.status;
      return { ...task, status };
    }));
    recordEvent({ type: "queue.restore", count: tasks.length });
  } catch (error) {
    recordEvent({ type: "queue.restore.error", error: String(error?.message || error || "restore_failed") });
  }
}

function restoreTaskStatus(task = {}) {
  const status = String(task.status || "").toLowerCase();
  if (!["submitting", "generating", "downloading"].includes(status)) return status || TaskStatus.pending;
  const kind = taskMediaKind(task);
  const hasGeneratedIds = [
    ...(Array.isArray(task.outputMediaIds) ? task.outputMediaIds : []),
    ...(Array.isArray(task.outputs) ? task.outputs.map((output) => output?.mediaId) : []),
    ...(Array.isArray(task.mediaIds) ? task.mediaIds : [])
  ].map((id) => String(id || "").trim()).filter(Boolean).length > 0;
  if (kind === "images" && status === "generating" && hasGeneratedIds) return TaskStatus.generating;
  if (kind === "images" && status === "downloading" && hasGeneratedIds) return TaskStatus.complete;
  return TaskStatus.pending;
}

async function persistQueueState() {
  try {
    repairQueueDownloadStateFromEvents("persist_queue_state");
    await chrome.storage.local.set({
      [QUEUE_STORAGE_KEY]: {
        version: 1,
        updatedAt: new Date().toISOString(),
        tasks: ledger.snapshot()
      }
    });
  } catch (error) {
    recordEvent({ type: "queue.persist.error", error: String(error?.message || error || "persist_failed") });
  }
}

function projectIdFromUrl(url = "") {
  return String(url || "").match(/\/fx\/(?:[^/?#]+\/)?tools\/flow\/project\/([0-9a-f-]{36})/i)?.[1] || "";
}

function isFlowToolUrl(url = "") {
  try {
    const parsed = new URL(String(url || ""));
    return /(^|\.)labs\.google(?:\.com)?$/i.test(parsed.hostname)
      && /^\/fx\/(?:[^/?#]+\/)?tools\/flow(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return /https:\/\/labs\.google(?:\.com)?\/fx\/(?:[^/?#]+\/)?tools\/flow(?:\/|$|\?)/i.test(String(url || ""));
  }
}

function projectRootUrlFromFlowUrl(url = "", projectId = "") {
  const id = String(projectId || projectIdFromUrl(url)).trim();
  if (!id) return "";
  const origin = String(url || "").startsWith("https://labs.google.com/")
    ? "https://labs.google.com"
    : "https://labs.google";
  const localeMatch = String(url || "").match(/\/fx\/([^/?#]+)\/tools\/flow/i);
  const localePath = localeMatch ? `${localeMatch[1]}/` : "";
  return `${origin}/fx/${localePath}tools/flow/project/${id}`;
}

function taskPrefersDom(task = {}) {
  const raw = String(task.submitPathPreference || task.submitPath || "").trim();
  return raw === "dom_first" || raw === "dom_fallback";
}

async function waitForFlowProjectRoot(tabId, projectId = "") {
  const expectedId = String(projectId || "").trim();
  for (let remain = 12000; remain > 0; remain -= 300) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const url = String(tab?.url || "");
    if (
      projectIdFromUrl(url) === expectedId &&
      !/\/edit\//i.test(url)
    ) {
      return { ok: true, tabId, url };
    }
    await sleep(300);
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return {
    ok: false,
    tabId,
    url: String(tab?.url || ""),
    error: "flow_project_root_navigation_timeout"
  };
}

function galleryState(extraItems = [], source = "queue-ledger", projectId = "") {
  const tasks = ledger.listTasks();
  const referenceMediaIds = referenceMediaIdsFromTasks(tasks);
  const scopedItems = filterGalleryItemsForProject([
    ...buildGalleryItemsFromTasks(tasks),
    ...(extraItems || [])
  ], projectId);
  const items = canonicalGalleryItems(scopedItems, { projectId, referenceMediaIds });
  return {
    items,
    meta: {
      source,
      fetchedAt: new Date().toISOString(),
      projectId: String(projectId || "")
    }
  };
}

function mergeGalleryItems(previousItems = [], nextItems = [], options = {}) {
  const seen = new Set();
  const merged = [];
  for (const item of filterUsableGalleryItems([...(nextItems || []), ...(previousItems || [])], {
    referenceMediaIds: options.referenceMediaIds || []
  })) {
    const key = String(item?.id || `${item?.kind || ""}:${item?.mediaId || ""}:${item?.mediaUrl || ""}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function reconcileQueueWithGalleryItems(items = []) {
  const patches = reconcileTasksWithGalleryItems(ledger.listTasks(), items);
  for (const entry of patches) {
    ledger.updateTask(entry.taskId, entry.patch);
    recordEvent({
      type: "queue.gallery_reconcile",
      taskId: entry.taskId,
      matchedCount: entry.matchedCount,
      expectedCount: entry.expectedCount,
      status: entry.patch.status || ""
    });
  }
  return patches;
}

function reconcileQueueWithProjectMediaFeed(rows = [], reason = "project_feed") {
  const patches = reconcileTasksWithProjectMediaFeed(ledger.listTasks(), rows);
  for (const entry of patches) {
    ledger.updateTask(entry.taskId, entry.patch);
    recordEvent({
      type: "queue.project_feed_reconcile",
      reason,
      taskId: entry.taskId,
      matchedCount: entry.matchedCount,
      failedCount: entry.failedCount,
      expectedCount: entry.expectedCount,
      status: entry.patch.status || ""
    });
  }
  return patches;
}

function hasOpenImageTasks() {
  return ledger.listTasks().some((task) => {
    if (!task?.id || taskMediaKind(task) !== "images") return false;
    return !["complete", "done", "failed", "blocked"].includes(String(task.status || "").toLowerCase());
  });
}

function taskMediaKind(task = {}) {
  const mode = String(task.mode || "").trim();
  if (mode === "text-to-image") return "images";
  if (["text-to-video", "image-to-video", "start-end-image-to-video", "ingredients-to-video"].includes(mode)) return "videos";
  return "";
}

function isTaskActive(task = {}) {
  return ["submitting", "generating", "downloading"].includes(String(task.status || "").toLowerCase());
}

function hasActiveTasks() {
  return ledger.listTasks().some((task) => isTaskActive(task));
}

function normalizedPromptText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizePageStatusRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    const rawStatus = String(row?.rawStatus || row?.status || "").trim();
    const normalizedStatus = String(row?.status || "").trim().toLowerCase();
    const status = ["complete", "failed", "pending"].includes(normalizedStatus)
      ? normalizedStatus
      : /success|complete/i.test(rawStatus)
        ? "complete"
        : /fail|reject|cancel/i.test(rawStatus)
          ? "failed"
          : /pending|running|processing/i.test(rawStatus)
            ? "pending"
            : "unknown";
    return {
      id: compactString(row?.id),
      workflowId: compactString(row?.workflowId),
      rawStatus,
      status,
      failureText: compactString(row?.failureText || row?.failureReason || row?.error || row?.message),
      model: compactString(row?.model),
      aspectRatio: compactString(row?.aspectRatio),
      mediaUrl: compactString(row?.mediaUrl),
      thumbnailUrl: compactString(row?.thumbnailUrl),
      mediaIndex: Number.isFinite(Number(row?.mediaIndex)) ? Number(row.mediaIndex) : index,
      source: "flow_status_feed"
    };
  }).filter((row) => row.id || row.workflowId || row.rawStatus);
}

function failureTextForStatusRows(rows = [], fallback = "MEDIA_GENERATION_STATUS_FAILED") {
  const parts = (Array.isArray(rows) ? rows : []).flatMap((row) => [
    row?.failureText,
    row?.failureReason,
    row?.error,
    row?.message,
    row?.rawStatus
  ]).map(compactString).filter(Boolean);
  return [...new Set(parts)].join(" ") || fallback;
}

function failedOutputMediaIdsFromRows(rows = [], fallbackIds = []) {
  return [...new Set([
    ...(Array.isArray(rows) ? rows : []).flatMap((row) => [row?.id, row?.workflowId]),
    ...(Array.isArray(fallbackIds) ? fallbackIds : [])
  ].map(compactString).filter(Boolean))];
}

function retryGenerationFailurePatch(rows = [], mediaIds = []) {
  return {
    status: TaskStatus.pending,
    mediaIds: [],
    outputMediaIds: [],
    outputs: [],
    statusRows: [],
    foundVideos: 0,
    videoDownloadReadyMediaIds: [],
    failedOutputCount: 0,
    failedOutputMediaIds: [],
    partialFailure: false,
    submittedAt: "",
    flowStatusFeedAt: "",
    generationFailureNeedsFlowReload: true,
    generationFailureRetryAt: new Date().toISOString(),
    previousFailedOutputMediaIds: failedOutputMediaIdsFromRows(rows, mediaIds)
  };
}

function chooseVideoTaskForFlowEvent(event = {}) {
  const endpointKind = compactString(event.endpointKind);
  const eventProjectId = compactString(event.projectId);
  const eventPrompts = (Array.isArray(event.prompts) ? event.prompts : [])
    .map(normalizedPromptText)
    .filter(Boolean);
  const promptSet = new Set(eventPrompts);
  const promptMatchesTask = (task = {}) => {
    const taskPrompt = normalizedPromptText(task.prompt);
    if (!taskPrompt || !eventPrompts.length) return false;
    return eventPrompts.some((prompt) => prompt === taskPrompt || prompt.includes(taskPrompt) || taskPrompt.includes(prompt));
  };
  const statusRows = normalizePageStatusRows(event.statusRows);
  const eventIds = new Set([
    ...(Array.isArray(event.mediaIds) ? event.mediaIds : []),
    ...statusRows.flatMap((row) => [row.id, row.workflowId])
  ].map(compactString).filter(Boolean));
  const candidates = ledger.listTasks()
    .filter((task) => taskMediaKind(task) === "videos")
    .filter((task) => {
      const status = String(task.status || "").toLowerCase();
      if (["submitting", "submitted", "generating", "downloading"].includes(status)) return true;
      if (status !== "complete") return false;
      const downloaded = new Set((task.downloadedMediaIds || []).map(compactString).filter(Boolean));
      const skipped = new Set((task.skippedDownloadMediaIds || []).map(compactString).filter(Boolean));
      return generatedDownloadIdsForTask(task).some((id) => id && !downloaded.has(id) && !skipped.has(id));
    })
    .filter((task) => !eventProjectId || !task.projectId || String(task.projectId) === eventProjectId);
  if (!candidates.length) return null;
  const activeCandidates = candidates.filter((task) => ["submitting", "submitted", "generating"].includes(String(task.status || "").toLowerCase()));
  const activePromptMatch = pickBestVideoFlowEventCandidate(activeCandidates.filter(promptMatchesTask))
    || pickBestVideoFlowEventCandidate(activeCandidates.filter((task) => promptSet.has(normalizedPromptText(task.prompt))));
  if (activePromptMatch) return activePromptMatch;
  if (endpointKind === "video" && activeCandidates.length === 1) return activeCandidates[0];
  if (eventIds.size || ["video", "video_workflow", "media_redirect"].includes(endpointKind)) {
    return null;
  }
  const promptMatch = pickBestVideoFlowEventCandidate(candidates.filter(promptMatchesTask))
    || pickBestVideoFlowEventCandidate(candidates.filter((task) => promptSet.has(normalizedPromptText(task.prompt))));
  if (promptMatch) return promptMatch;
  const pendingStatus = activeCandidates.find((task) => ["submitting", "generating"].includes(String(task.status || "").toLowerCase()));
  return pendingStatus || candidates[candidates.length - 1] || null;
}

function pickBestVideoFlowEventCandidate(tasks = []) {
  const statusRank = {
    submitting: 0,
    submitted: 1,
    generating: 2,
    downloading: 3,
    complete: 4
  };
  return [...tasks].sort((a, b) => {
    const aStatus = statusRank[String(a?.status || "").toLowerCase()] ?? 9;
    const bStatus = statusRank[String(b?.status || "").toLowerCase()] ?? 9;
    if (aStatus !== bStatus) return aStatus - bStatus;
    const aMs = Date.parse(String(a?.submitAttemptStartedAt || a?.submittedAt || a?.startedAt || ""));
    const bMs = Date.parse(String(b?.submitAttemptStartedAt || b?.submittedAt || b?.startedAt || ""));
    if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) return bMs - aMs;
    return Number(b?.jobIndex || 0) - Number(a?.jobIndex || 0);
  })[0] || null;
}

function taskOwnedStatusIdentitySet(task = {}) {
  const inputReferenceIds = new Set([
    ...(Array.isArray(task.refMediaIds) ? task.refMediaIds : []),
    ...(Array.isArray(task.refInputs) ? task.refInputs.map((ref) => ref?.mediaId || ref?.imageId) : []),
    task.startMediaId,
    task.endMediaId,
    task.startRefInput?.mediaId,
    task.endRefInput?.mediaId
  ].map(compactString).filter(Boolean));
  const explicitIds = [
    ...(Array.isArray(task.outputMediaIds) ? task.outputMediaIds : []),
    ...(Array.isArray(task.submitOutputRows) ? task.submitOutputRows.flatMap((row) => [row?.mediaId, row?.workflowId]) : []),
    ...(Array.isArray(task.statusRows) ? task.statusRows.flatMap((row) => [row?.id, row?.workflowId]) : []),
    ...(Array.isArray(task.outputs) ? task.outputs.map((output) => output?.mediaId) : [])
  ];
  return new Set([
    ...explicitIds,
    ...(explicitIds.map(compactString).filter(Boolean).length ? [] : (Array.isArray(task.mediaIds) ? task.mediaIds : []))
  ].map(compactString).filter((id) => id && !inputReferenceIds.has(id)));
}

function videoTasksForFlowEvent(event = {}) {
  const endpointKind = compactString(event.endpointKind);
  const eventProjectId = compactString(event.projectId);
  const statusRows = normalizePageStatusRows(event.statusRows);
  const eventIds = new Set([
    ...(Array.isArray(event.mediaIds) ? event.mediaIds : []),
    ...statusRows.flatMap((row) => [row.id, row.workflowId])
  ].map(compactString).filter(Boolean));
  const candidates = ledger.listTasks()
    .filter((task) => taskMediaKind(task) === "videos")
    .filter((task) => {
      const status = String(task.status || "").toLowerCase();
      if (["submitting", "submitted", "generating", "downloading"].includes(status)) return true;
      if (status !== "complete") return false;
      const downloaded = new Set((task.downloadedMediaIds || []).map(compactString).filter(Boolean));
      const skipped = new Set((task.skippedDownloadMediaIds || []).map(compactString).filter(Boolean));
      return generatedDownloadIdsForTask(task).some((id) => id && !downloaded.has(id) && !skipped.has(id));
    })
    .filter((task) => !eventProjectId || !task.projectId || String(task.projectId) === eventProjectId);
  if (!candidates.length) return [];
  if (endpointKind === "video_status" && eventIds.size) {
    const matched = candidates.filter((task) => {
      const owned = taskOwnedStatusIdentitySet(task);
      return [...eventIds].some((id) => owned.has(id));
    });
    if (matched.length) return matched;
  }
  const fallback = chooseVideoTaskForFlowEvent(event);
  if (fallback) return [fallback];
  if (eventIds.size) return [];
  return [];
}

async function applyFlowGenerationResponseEvent(event = {}) {
  if (event.type !== "flow_generation_response") return null;
  const endpointKind = compactString(event.endpointKind);
  if (!["video", "video_status", "video_workflow", "media_redirect"].includes(endpointKind)) return null;
  const tasks = videoTasksForFlowEvent(event);
  if (tasks.length > 1) {
    const results = [];
    for (const task of tasks) {
      results.push(await applyFlowGenerationResponseEventToTask(task, event));
    }
    return results[0] || null;
  }
  const task = tasks[0] || null;
  if (!task?.id) {
    recordEvent({
      type: "queue.flow_generation_feed.unmatched",
      endpointKind,
      projectId: compactString(event.projectId),
      mediaIdCount: Array.isArray(event.mediaIds) ? event.mediaIds.length : 0,
      statusRowCount: Array.isArray(event.statusRows) ? event.statusRows.length : 0,
      prompts: Array.isArray(event.prompts) ? event.prompts.slice(0, 3) : []
    });
    return null;
  }
  return applyFlowGenerationResponseEventToTask(task, event);
}

async function applyFlowGenerationResponseEventToTask(task = {}, event = {}) {
  const endpointKind = compactString(event.endpointKind);
  const incomingRows = normalizePageStatusRows(event.statusRows);
  const currentRows = normalizePageStatusRows(task.statusRows);
  const ownedIdentitySet = taskOwnedStatusIdentitySet(task);
  const scopedIncomingRows = endpointKind === "video_status" && ownedIdentitySet.size
    ? incomingRows.filter((row) => ownedIdentitySet.has(row.id) || ownedIdentitySet.has(row.workflowId))
    : incomingRows;
  const scopedEventMediaIds = endpointKind === "video_status" && ownedIdentitySet.size
    ? (Array.isArray(event.mediaIds) ? event.mediaIds : []).map(compactString).filter((id) => ownedIdentitySet.has(id))
    : (Array.isArray(event.mediaIds) ? event.mediaIds : []);
  const rowMap = new Map();
  [...currentRows, ...scopedIncomingRows].forEach((row) => {
    const key = row.id || row.workflowId;
    if (!key) return;
    rowMap.set(key, { ...(rowMap.get(key) || {}), ...row });
  });
  const statusRows = [...rowMap.values()];
  const mediaIds = [...new Set([
    ...(Array.isArray(task.mediaIds) ? task.mediaIds : []),
    ...(Array.isArray(task.outputMediaIds) ? task.outputMediaIds : []),
    ...scopedEventMediaIds,
    ...statusRows.map((row) => row.id)
  ].map(compactString).filter(Boolean))];
  const expected = Math.max(1, Number(task.expectedVideos || task.repeatCount || mediaIds.length || 1) || 1);
  const priorReadyIds = new Set((task.videoDownloadReadyMediaIds || []).map(compactString).filter(Boolean));
  if (endpointKind === "video_workflow" || endpointKind === "media_redirect") {
    (Array.isArray(event.mediaIds) ? event.mediaIds : []).map(compactString).filter(Boolean).forEach((id) => priorReadyIds.add(id));
  }
  statusRows
    .filter((row) => row.status === "complete" && (row.mediaUrl || row.thumbnailUrl))
    .map((row) => compactString(row.id))
    .filter(Boolean)
    .forEach((id) => priorReadyIds.add(id));
  const videoDownloadReadyMediaIds = [...priorReadyIds];
  const completeRows = statusRows.filter((row) => row.status === "complete" && row.id);
  const failedRows = statusRows.filter((row) => row.status === "failed");
  const terminalRows = statusRows.filter((row) => row.status === "complete" || row.status === "failed");

  let patch = {
    mediaIds,
    statusRows,
    expectedVideos: expected,
    foundVideos: completeRows.length,
      videoDownloadReadyMediaIds,
      lastPollAt: new Date().toISOString(),
      flowStatusFeedAt: new Date().toISOString()
  };
  let completed = null;
  if (terminalRows.length >= expected && !completeRows.length) {
    const failureText = failureTextForStatusRows(failedRows, "MEDIA_GENERATION_STATUS_FAILED");
    ledger.updateTask(task.id, {
      ...patch,
      foundVideos: 0,
      failedOutputCount: failedRows.length || expected,
      failedOutputMediaIds: failedRows.map((row) => row.id || row.workflowId).filter(Boolean),
      partialFailure: true
    });
    const failed = scheduler.markFailure(task.id, failureText);
    let retryReset = null;
    if (failed?.status === TaskStatus.pending && failed?.healAction === "retry_generation") {
      retryReset = ledger.updateTask(task.id, retryGenerationFailurePatch(failedRows, mediaIds));
      recordEvent({
        type: "queue.flow_generation_feed.retry_reset",
        taskId: task.id,
        endpointKind,
        previousMediaIds: mediaIds,
        previousFailedOutputMediaIds: retryReset?.previousFailedOutputMediaIds || [],
        tabReloadRequired: Boolean(retryReset?.generationFailureNeedsFlowReload)
      });
    }
    recordEvent({
      type: "queue.flow_generation_feed.failure",
      taskId: task.id,
      endpointKind,
      failureClass: retryReset?.failureClass || failed?.failureClass || "",
      failureScope: retryReset?.failureScope || failed?.failureScope || "",
      healAction: retryReset?.healAction || failed?.healAction || "",
      expectedVideos: expected,
      failedCount: failedRows.length,
      lastError: retryReset?.lastError || failed?.lastError || failureText
    });
  } else if (terminalRows.length >= expected && completeRows.length) {
    const outputs = completeRows.slice(0, expected).map((row, mediaIndex) => ({
      id: `${task.id}:${row.id || mediaIndex}`,
      mediaId: row.id,
      mediaUrl: row.mediaUrl || buildMediaRedirectUrl({ mediaId: row.id }),
      thumbnailUrl: row.thumbnailUrl || buildMediaThumbnailUrl({ mediaId: row.id }),
      prompt: task.prompt || "",
      kind: "videos",
      status: row.status,
      rawStatus: row.rawStatus,
      mediaIndex,
      source: "flow_status_feed"
    }));
    completed = scheduler.markComplete(task.id, {
      ...patch,
      outputs,
      outputMediaIds: outputs.map((output) => output.mediaId),
      foundVideos: outputs.length,
      failedOutputCount: Math.max(0, expected - outputs.length) + failedRows.length,
      failedOutputMediaIds: failedRows.map((row) => row.id).filter(Boolean),
      partialFailure: outputs.length < expected
    });
    if (outputs.every((output) => priorReadyIds.has(output.mediaId))) {
      await autoDownloadCompletedTasks([task.id], "flow_status_feed");
    }
  } else {
    ledger.updateTask(task.id, patch);
  }
  const after = ledger.getTask(task.id);
  if (shouldAttemptAutoDownloadForTask(after)) {
    await autoDownloadCompletedTasks([task.id], endpointKind);
  }
  await persistQueueState();
  recordEvent({
    type: "queue.flow_generation_feed",
    taskId: task.id,
    endpointKind,
    mediaIdCount: mediaIds.length,
    statusRowCount: statusRows.length,
    completeCount: completeRows.length,
    failedCount: failedRows.length,
    expectedVideos: expected,
    completed: completed?.status === TaskStatus.complete
  });
  return ledger.getTask(task.id);
}

function activeTaskSummary() {
  const tasks = ledger.listTasks();
  return {
    pending: tasks.filter((task) => task.status === TaskStatus.pending).length,
    active: tasks.filter((task) => isTaskActive(task)).length,
    complete: tasks.filter((task) => task.status === TaskStatus.complete).length,
    failed: tasks.filter((task) => task.status === TaskStatus.failed).length,
    blocked: tasks.filter((task) => task.status === TaskStatus.blocked).length,
    total: tasks.length
  };
}

function reconcileQueueWithDownloadResults(downloads = []) {
  const patches = reconcileTasksWithDownloadResults(ledger.listTasks(), downloads);
  for (const entry of patches) {
    ledger.updateTask(entry.taskId, entry.patch);
    recordEvent({
      type: "queue.download_reconcile",
      taskId: entry.taskId,
      downloadedCount: entry.downloadedCount,
      skippedDownloadCount: entry.skippedDownloadCount
    });
  }
  return patches;
}

function downloadResultsFromRuntimeEvents(events = runtimeState.events) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => ["media.download", "media.download.error", "media.download.dedupe_blocked"].includes(String(event?.type || "")))
    .map((event) => {
      const type = String(event.type || "");
      return {
        ok: type === "media.download",
        skipped: type === "media.download.dedupe_blocked",
        taskId: compactString(event.taskId),
        mediaId: compactString(event.mediaId),
        filename: compactString(event.filename || event.fileName || event.finalFilepath || event.targetFilepath),
        downloadId: event.downloadId || null,
        error: type === "media.download" ? "" : compactString(event.error || event.reason || "download_failed")
      };
    })
    .filter((download) => download.taskId || download.mediaId);
}

function downloadPatchChangesTask(task = {}, patch = {}) {
  for (const field of ["downloadedMediaIds", "skippedDownloadMediaIds", "downloadErrorMediaIds"]) {
    if (!Array.isArray(patch[field])) continue;
    const current = Array.isArray(task[field]) ? task[field] : [];
    if (JSON.stringify(current) !== JSON.stringify(patch[field])) {
      return true;
    }
  }
  for (const field of ["downloadedCount", "skippedDownloadCount"]) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    if (Number(task[field] || 0) !== Number(patch[field] || 0)) return true;
  }
  const currentById = new Map((Array.isArray(task.outputs) ? task.outputs : [])
    .filter((output) => output?.mediaId)
    .map((output) => [compactString(output.mediaId), output]));
  return (Array.isArray(patch.outputs) ? patch.outputs : []).some((output) => {
    const mediaId = compactString(output?.mediaId);
    if (!mediaId) return false;
    const current = currentById.get(mediaId) || {};
    return compactString(current.downloadStatus) !== compactString(output.downloadStatus)
      || compactString(current.downloadFilename) !== compactString(output.downloadFilename)
      || compactString(current.downloadError) !== compactString(output.downloadError);
  });
}

function repairQueueDownloadStateFromEvents(reason = "runtime_download_events") {
  const downloads = downloadResultsFromRuntimeEvents();
  if (!downloads.length) return [];
  const patches = reconcileTasksWithDownloadResults(ledger.listTasks(), downloads);
  const applied = [];
  for (const entry of patches) {
    const task = ledger.getTask(entry.taskId);
    if (!task || !downloadPatchChangesTask(task, entry.patch)) continue;
    ledger.updateTask(entry.taskId, entry.patch);
    applied.push(entry);
  }
  if (applied.length) {
    recordEvent({
      type: "queue.download_repair",
      reason,
      repaired: applied.length
    });
  }
  return applied;
}

function generatedDownloadIdsForTask(task = {}) {
  const referenceIds = new Set([
    ...(Array.isArray(task.refMediaIds) ? task.refMediaIds : []),
    task.startMediaId,
    task.endMediaId
  ].map((id) => String(id || "").trim()).filter(Boolean));
  return [...new Set([
    ...(Array.isArray(task.outputMediaIds) ? task.outputMediaIds : []),
    ...(Array.isArray(task.outputs) ? task.outputs.map((output) => output?.mediaId) : []),
    ...(Array.isArray(task.mediaIds) ? task.mediaIds : [])
  ].map((id) => String(id || "").trim()).filter((id) => id && !referenceIds.has(id)))];
}

function pendingAutoDownloadIdsForTask(task = {}) {
  if (task?.download?.enabled !== true) return [];
  return deriveTaskOutputLedger(task).pendingDownloadIds;
}

function shouldAttemptAutoDownloadForTask(task = {}) {
  if (!task?.id || task?.download?.enabled !== true || task.status !== TaskStatus.complete) return false;
  const outputLedger = deriveTaskOutputLedger(task);
  const consumed = new Set([
    ...outputLedger.downloadedIds,
    ...outputLedger.skippedDownloadIds,
    ...outputLedger.downloadErrorIds
  ]);
  return outputLedger.successfulIds.some((id) => id && !consumed.has(id));
}

function markUnplannedAutoDownloads(taskIds = [], error = "auto_download_no_plan") {
  const updated = [];
  for (const taskId of taskIds || []) {
    const task = ledger.getTask(taskId);
    if (!task) continue;
    const pendingIds = pendingAutoDownloadIdsForTask(task);
    if (!pendingIds.length) continue;
    const failedIds = new Set([
      ...(Array.isArray(task.downloadErrorMediaIds) ? task.downloadErrorMediaIds : []),
      ...pendingIds
    ].map(compactString).filter(Boolean));
    const outputs = (Array.isArray(task.outputs) ? task.outputs : []).map((output) => {
      const mediaId = compactString(output?.mediaId);
      if (!mediaId || !failedIds.has(mediaId)) return output;
      return {
        ...output,
        downloadStatus: "download_failed",
        downloadError: output.downloadError || error
      };
    });
    const patch = {
      downloadErrorMediaIds: [...failedIds],
      outputs,
      lastDownloadError: error
    };
    ledger.updateTask(task.id, patch);
    updated.push({ taskId: task.id, mediaIds: pendingIds });
    recordEvent({
      type: "media.auto_download.no_plan_marked",
      taskId: task.id,
      mediaIds: pendingIds,
      error
    });
  }
  return updated;
}

function isTransientPageCommandError(error = "") {
  return /message channel closed|receiving end does not exist|extension context invalidated|context invalidated|flow_bridge_not_ready|flow_tab_not_found/i.test(String(error || ""));
}

function successfulVideoOutputIdsForDirectDownload(task = {}) {
  const outputIds = (Array.isArray(task.outputs) ? task.outputs : [])
    .filter((output) => {
      const status = String(output?.status || "").toLowerCase();
      const rawStatus = String(output?.rawStatus || "").toUpperCase();
      return output?.mediaId && (!status || status === "complete" || rawStatus === "MEDIA_GENERATION_STATUS_SUCCESSFUL");
    })
    .map((output) => output.mediaId);
  const rowIds = (Array.isArray(task.statusRows) ? task.statusRows : [])
    .filter((row) => {
      const status = String(row?.status || "").toLowerCase();
      const rawStatus = String(row?.rawStatus || "").toUpperCase();
      return (row?.id || row?.mediaId) && (status === "complete" || rawStatus === "MEDIA_GENERATION_STATUS_SUCCESSFUL");
    })
    .map((row) => row.id || row.mediaId);
  return [...new Set([...outputIds, ...rowIds].map(compactString).filter(Boolean))];
}

async function refreshVideoDownloadReadinessForTask(task = {}) {
  if (!task?.id || taskMediaKind(task) !== "videos") return task;
  const ownedIds = generatedDownloadIdsForTask(task);
  if (!ownedIds.length) return task;
  const existingReady = new Set((task.videoDownloadReadyMediaIds || []).map(compactString).filter(Boolean));
  const missing = ownedIds.filter((id) => !existingReady.has(id));
  if (!missing.length) return task;
  let result = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = await sendPageCommand({
      action: "resolveVideoDownloadReadiness",
      mediaIds: missing,
      submitOutputRows: Array.isArray(task.submitOutputRows) ? task.submitOutputRows : [],
      projectId: task.projectId || runtimeState.projectId,
      timeoutMs: 20000
    }).catch((error) => ({ ok: false, error: String(error?.message || error || "readiness_failed") }));
    const attemptPayload = result?.result || result;
    if (attemptPayload?.ok !== false || !isTransientPageCommandError(attemptPayload?.error)) break;
    recordEvent({
      type: "media.download.readiness.retry",
      taskId: task.id,
      requested: missing.length,
      attempt: attempt + 1,
      error: attemptPayload.error || ""
    });
    await sleep(750 * (attempt + 1));
  }
  const payload = result?.result || result;
  const directFallbackIds = payload?.ok === false && isTransientPageCommandError(payload?.error)
    ? missing.filter((id) => successfulVideoOutputIdsForDirectDownload(task).includes(id))
    : [];
  const readyIds = [...new Set([
    ...existingReady,
    ...(Array.isArray(payload?.readyMediaIds) ? payload.readyMediaIds : []),
    ...directFallbackIds
  ].map(compactString).filter(Boolean))];
  recordEvent({
    type: "media.download.readiness",
    taskId: task.id,
    requested: missing.length,
    ready: readyIds.length,
    ok: payload?.ok !== false,
    directFallbackReady: directFallbackIds.length,
    error: payload?.error || "",
    rows: Array.isArray(payload?.rows) ? payload.rows.slice(0, 8) : []
  });
  if (readyIds.length === existingReady.size) return task;
  return ledger.updateTask(task.id, { videoDownloadReadyMediaIds: readyIds });
}

async function executeDownloadPlans(plans = [], source = "manual") {
  const downloads = [];
  for (const plan of plans) {
    const reservation = reserveDownloadPlan(plan);
    if (!reservation.ok) {
      const blocked = {
        ...plan,
        ok: false,
        skipped: true,
        error: reservation.reason,
        dedupeDecision: "blocked",
        attemptId: crypto.randomUUID()
      };
      downloads.push(blocked);
      recordEvent({
        type: "media.download.dedupe_blocked",
        mediaId: plan.mediaId,
        taskId: plan.taskId,
        fileName: plan.filename,
        artifactKey: reservation.artifactKey,
        targetPathKey: reservation.targetPathKey,
        downloadPath: plan.downloadPath,
        downloadUrl: summarizeDownloadUrl(plan.url || ""),
        targetFilepath: plan.filename || plan.targetPathKey || "",
        finalFilepath: "",
        fileSize: 0,
        dedupeDecision: "blocked",
        reason: reservation.reason,
        source
      });
      continue;
    }
    const resolvedPlan = await resolveDownloadPlan(plan);
    const result = resolvedPlan.ok
      ? await downloadFileWithReadinessRetries(resolvedPlan.url, resolvedPlan.filename, { ...plan, fallbackDownloadUrl: resolvedPlan.meta?.fallbackDownloadUrl || "" }, { kind: plan.kind, resolution: resolvedPlan.meta?.outputResolution || plan.resolution || "" })
      : { ok: false, error: resolvedPlan.error || "download_resolution_resolve_failed", downloadId: null };
    if (!result.ok) {
      releaseDownloadReservation(reservation);
    }
    const attemptId = crypto.randomUUID();
    downloads.push({
      ...plan,
      ...resolvedPlan.meta,
      ...result,
      url: summarizeDownloadUrl(resolvedPlan.url || plan.url || ""),
      downloadUrl: summarizeDownloadUrl(resolvedPlan.url || plan.url || ""),
      filename: resolvedPlan.filename || plan.filename,
      attemptId,
      artifactKey: reservation.artifactKey,
      targetPathKey: reservation.targetPathKey,
      dedupeDecision: "allowed"
    });
    recordEvent({
      type: result.ok ? "media.download" : "media.download.error",
      mediaId: plan.mediaId,
      taskId: plan.taskId,
      fileName: resolvedPlan.filename || plan.filename,
      filename: result.filename || resolvedPlan.filename || plan.filename,
      artifactKey: reservation.artifactKey,
      targetPathKey: reservation.targetPathKey,
      downloadPath: plan.downloadPath,
      downloadUrl: summarizeDownloadUrl(resolvedPlan.url || plan.url || ""),
      targetFilepath: resolvedPlan.filename || plan.filename || plan.targetPathKey || "",
      finalFilepath: result.filename || "",
      downloadId: result.downloadId || null,
      bytesReceived: Number(result.bytesReceived || 0),
      fileSize: Number(result.fileSize || 0),
      durationMs: Number(result.durationMs || 0),
      totalDurationMs: Number(result.totalDurationMs || result.durationMs || 0),
      attempts: Number(result.attempts || 1),
      retryWaitMs: Number(result.retryWaitMs || 0),
      matchMethod: plan.matchMethod,
      resolution: plan.resolution || "",
      dedupeDecision: "allowed",
      attemptId,
      source,
      error: result.error || ""
    });
  }
  return downloads;
}

function summarizeDownloadUrl(url = "") {
  const text = String(url || "");
  if (!text) return "";
  if (/^data:/i.test(text)) return `[data-url:${text.length} chars]`;
  if (text.length > 1200) return `${text.slice(0, 240)}...[truncated:${text.length} chars]`;
  return text;
}

function timeoutAfter(ms, error = "operation_timeout") {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, error }), Math.max(1000, Number(ms || 0) || 1000));
  });
}

async function resolveDownloadPlan(plan = {}) {
  if (plan.requiresUpscale !== true) {
    // Non-upscale (720p/native) downloads: let Chrome follow the Flow media
    // redirect URL natively. Per docs/GOTCHAS.md "Media Redirect / Download
    // Poisoning":
    //   - Native Chrome downloads should use the raw Flow redirect URL
    //     (media.getMediaUrlRedirect?name=<mediaId>).
    //   - Do not validate normal 720p video downloads with page fetch probes.
    //     Let Chrome follow the redirect, then validate the completed file size.
    //   - Range probes can fail against Flow redirects.
    //
    // Trigger evidence: autoflow-report-10.8.1-2026-05-02_171146Z.md showed
    // Downloads 3/4 ok, 2 failed because the in-background probe of every
    // candidate URL (operations array, generated_video, redirect_fallback)
    // failed where the redirect itself works fine when Chrome follows it
    // natively. Generation had succeeded with rawStatus
    // MEDIA_GENERATION_STATUS_SUCCESSFUL.
    //
    // Validation happens AFTER download via download_too_small + tiny-MP4
    // checks, not via background probe.
    //
    // Construct the redirect URL fresh from plan.mediaId rather than reusing
    // plan.url (which can carry gallery-scan mutations or cache-bust params).
    // The naked redirect URL is what Chrome's downloader follows cleanly.
    const directUrl = plan.mediaId
      ? buildMediaRedirectUrl({ mediaId: plan.mediaId })
      : plan.url;
    const fallbackUrl = String(plan.url || "").trim() && String(plan.url || "").trim() !== directUrl
      ? String(plan.url || "").trim()
      : "";
    return {
      ok: true,
      url: directUrl,
      filename: plan.filename,
      meta: {
        directDownloadPath: "flow_playback_redirect_native",
        fallbackDownloadUrl: fallbackUrl
      }
    };
  }
  const kind = String(plan.kind || "").trim() || (String(plan.filename || "").toLowerCase().endsWith(".png") ? "images" : "videos");
  const resolution = String(plan.resolution || "").trim().toLowerCase();
  try {
    if (kind === "images") {
      const result = await sendPageCommand({
        action: "upscaleImage",
        mediaId: plan.mediaId,
        resolution,
        timeoutMs: 180000
      });
      if (!result?.ok || !result.dataUrl) {
        return { ok: false, error: result?.error || "image_upscale_failed", url: "", filename: plan.filename, meta: { upscaleResult: result || null } };
      }
      return {
        ok: true,
        url: result.dataUrl,
        filename: filenameWithImageMimeExtension(plan.filename, result.mimeType),
        meta: {
          upscaleStatus: "ok",
          upscaleEndpoint: result.endpoint || "",
          outputResolution: resolution,
          byteLength: Number(result.byteLength || 0)
        }
      };
    }
    if (kind === "videos") {
      const videoResolution = resolution === "4k" ? "4k" : "1080p";
      const result = await sendPageCommand({
        action: "upscaleVideo",
        mediaId: plan.mediaId,
        mediaGenerationId: plan.mediaGenerationId || "",
        resolution: videoResolution,
        aspectRatio: plan.aspectRatio || "",
        timeoutMs: 360000
      });
      if (!result?.ok || (!result.mediaUrl && !result.dataUrl)) {
        return { ok: false, error: result?.error || "video_upscale_failed", url: "", filename: plan.filename, meta: { upscaleResult: result || null } };
      }
      return {
        ok: true,
        url: result.dataUrl || result.mediaUrl,
        filename: plan.filename,
        meta: {
          upscaleStatus: "ok",
          upscaleEndpoint: result.endpoint || "",
          resultMediaName: result.resultMediaName || "",
          outputResolution: videoResolution,
          modelKey: result.modelKey || "",
          byteLength: Number(result.byteLength || 0),
          mimeType: result.mimeType || ""
        }
      };
    }
    return { ok: false, error: "unsupported_upscale_media_kind", url: "", filename: plan.filename, meta: {} };
  } catch (error) {
    return { ok: false, error: String(error?.message || error || "upscale_exception"), url: "", filename: plan.filename, meta: {} };
  }
}

function filenameWithImageMimeExtension(filename = "", mimeType = "") {
  const base = String(filename || "image").replace(/\.(png|jpe?g|webp|avif)$/i, "");
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg")) return `${base}.jpeg`;
  if (mime.includes("webp")) return `${base}.webp`;
  if (mime.includes("avif")) return `${base}.avif`;
  return `${base}.png`;
}

async function autoDownloadCompletedTasks(taskIds = [], reason = "completion") {
  const ids = [...new Set((taskIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  const selectedIds = [];
  const folders = new Set();
  const projectIds = new Set();
  const resolutionByTaskId = {};
  const filenameOptionsByTaskId = {};
  for (const taskId of ids) {
    let task = ledger.getTask(taskId);
    if (!task || task.status !== TaskStatus.complete) continue;
    if (taskMediaKind(task) === "videos") {
      task = await refreshVideoDownloadReadinessForTask(task);
    }
    const mediaIds = pendingAutoDownloadIdsForTask(task);
    if (!mediaIds.length) {
      const outputLedger = deriveTaskOutputLedger(task);
      recordEvent({
        type: "media.auto_download.no_pending",
        reason,
        taskId: task.id,
        kind: outputLedger.kind,
        resultCount: outputLedger.resultCount,
        expectedDownloadCount: outputLedger.expectedDownloadCount,
        readyVideoIds: outputLedger.readyVideoIds.length,
        downloaded: outputLedger.downloadedIds.length,
        skipped: outputLedger.skippedDownloadIds.length,
        downloadErrors: outputLedger.downloadErrorIds.length,
        generatedIds: generatedDownloadIdsForTask(task).length,
        downloadEnabled: task.download?.enabled === true
      });
      continue;
    }
    folders.add(String(task.download?.folder || "Auto-Flow-01"));
    if (task.projectId) projectIds.add(String(task.projectId));
    resolutionByTaskId[String(task.id)] = String(task.download?.resolution || "").trim();
    filenameOptionsByTaskId[String(task.id)] = {
      filenameStyle: task.download?.filenameStyle || "",
      filenameTemplatePrefix: task.download?.filenameTemplatePrefix || "",
      filenameTemplateIndex: task.download?.filenameTemplateIndex || "",
      filenameTemplatePromptPart: task.download?.filenameTemplatePromptPart || "",
      filenameTemplateDate: task.download?.filenameTemplateDate || "",
      filenameTemplateSuffix: task.download?.filenameTemplateSuffix || "",
      filenameTemplateSeparator: task.download?.filenameTemplateSeparator || ""
    };
    selectedIds.push(...mediaIds.flatMap((mediaId) => [`${task.id}:${mediaId}`, mediaId]));
  }
  if (!selectedIds.length) {
    recordEvent({
      type: "media.auto_download.no_selection",
      reason,
      requestedTasks: ids.length
    });
    return [];
  }
  const folder = folders.size === 1 ? [...folders][0] : "Auto-Flow-01";
  const projectId = projectIds.size === 1 ? [...projectIds][0] : runtimeState.lastGalleryProjectId;
  const gallery = galleryState(runtimeState.lastGalleryItems || [], runtimeState.lastGalleryItems?.length ? "flow-dom+queue-ledger" : "queue-ledger", projectId);
  const plans = planMediaDownloads(gallery.items, {
    selectedIds,
    folder,
    resolutionByTaskId,
    filenameOptionsByTaskId,
    allowDuplicateTargetSuffix: true,
    reservedArtifactKeys: [...downloadReservations.artifacts.keys()],
    reservedTargetPaths: [...downloadReservations.targets.keys()]
  });
  if (!plans.length) {
    recordEvent({
      type: "media.auto_download.no_plans",
      reason,
      selected: selectedIds.length,
      galleryItems: gallery.items.length,
      folder,
      projectId: projectId || ""
    });
    markUnplannedAutoDownloads(ids, "auto_download_no_plan");
    return [];
  }
  recordEvent({ type: "media.auto_download.start", reason, planned: plans.length });
  const downloads = await executeDownloadPlans(plans, "auto");
  const reconciledDownloads = reconcileQueueWithDownloadResults(downloads);
  if (reconciledDownloads.length) await persistQueueState();
  recordEvent({
    type: "media.auto_download.done",
    reason,
    planned: plans.length,
    downloaded: downloads.filter((download) => download.ok).length,
    skipped: downloads.filter((download) => download.skipped).length
  });
  return downloads;
}

async function scanFlowGallery(preferredTabId, options = {}) {
  try {
    const auto = Boolean(options.auto || options.lightweight);
    const fullScroll = options.fullScroll ?? !auto;
    const maxSteps = auto ? 1 : 18;
    const settleMs = auto ? 20 : 35;
    const maxMediaNodes = auto ? 120 : 800;
    const maxProjectMedia = auto ? 500 : 800;
    const tab = await findFlowTab(preferredTabId);
    const tabProjectId = projectIdFromUrl(tab?.url || "");
    if (!tab?.id) {
      return {
        ok: false,
        error: "flow_tab_not_found",
        gallery: galleryState(runtimeState.lastGalleryItems || [], runtimeState.lastGalleryItems?.length ? "flow-dom+queue-ledger" : "queue-ledger", runtimeState.lastGalleryProjectId)
      };
    }
    const bridge = await ensureFlowBridge(tab.id);
    if (!bridge?.ok) {
      return {
        ok: false,
        error: bridge?.error || "flow_bridge_not_ready",
        gallery: galleryState(runtimeState.lastGalleryItems || [], runtimeState.lastGalleryItems?.length ? "flow-dom+queue-ledger" : "queue-ledger", tabProjectId || runtimeState.lastGalleryProjectId)
      };
    }
    const scan = await sendPageCommand({
      action: "projectGeneratedMedia",
      projectId: tabProjectId || runtimeState.projectId || "",
      maxProjectMedia,
      timeoutMs: 20000
    }, tab.id).catch((error) => ({ ok: false, error: String(error?.message || error || "project_feed_failed") }));
    const projectRows = scan?.ok && Array.isArray(scan.rows) ? scan.rows : [];
    const projectItems = scan?.ok && Array.isArray(scan.items) ? scan.items : [];
    const projectReconciled = reconcileQueueWithProjectMediaFeed(projectRows, "gallery_scan_project_feed");
    if (projectReconciled.length) {
      await autoDownloadCompletedTasks(projectReconciled.map((entry) => entry.taskId), "project_feed");
      await persistQueueState();
    }

    const domScan = await sendPageCommand({
      action: "scanGallery",
      options: {
        fullScroll,
        maxSteps,
        settleMs,
        maxMediaNodes,
        maxProjectMedia,
        includeProjectData: false
      },
      timeoutMs: 20000
    }, tab.id);
    const scanProjectId = String(scan?.meta?.projectId || domScan?.meta?.projectId || tabProjectId || "").trim();
    const referenceMediaIds = referenceMediaIdsFromTasks(ledger.listTasks());
    const items = domScan?.ok && Array.isArray(domScan.items)
      ? filterGalleryItemsForProject(filterUsableGalleryItems([...projectItems, ...domScan.items], { referenceMediaIds }), scanProjectId)
      : filterGalleryItemsForProject(filterUsableGalleryItems(projectItems, { referenceMediaIds }), scanProjectId);
    const domRecoveryAllowed = projectRows.length === 0
      || options.domRecovery === true
      || (projectReconciled.length === 0 && hasOpenImageTasks());
    const recoveryItems = domRecoveryAllowed
      ? items
      : [];
    const previousItems = runtimeState.lastGalleryProjectId === scanProjectId
      ? runtimeState.lastGalleryItems || []
      : [];
    const mergedItems = mergeGalleryItems(previousItems, items, { referenceMediaIds });
    runtimeState.lastGalleryItems = filterGalleryItemsForProject(filterUsableGalleryItems(mergedItems, { referenceMediaIds }), scanProjectId);
    runtimeState.lastGalleryProjectId = scanProjectId;
    const reconciled = domRecoveryAllowed ? reconcileQueueWithGalleryItems(recoveryItems) : [];
    if (reconciled.length) {
      await autoDownloadCompletedTasks(reconciled.map((entry) => entry.taskId), "gallery_reconcile");
      await persistQueueState();
    }
    recordEvent({
      type: scan?.ok || domScan?.ok ? "gallery.scan.ok" : "gallery.scan.failed",
      count: mergedItems.length,
      projectReconciled: projectReconciled.length,
      domReconciled: reconciled.length,
      domRecoveryAllowed,
      error: scan?.error || domScan?.error || "",
      scanMeta: { ...(scan?.meta || {}), dom: domScan?.meta || null }
    });
    return {
      ok: Boolean(scan?.ok || domScan?.ok),
      error: scan?.error || domScan?.error || "",
      gallery: galleryState(mergedItems, mergedItems.length ? "project-feed+dom+queue-ledger" : "queue-ledger", scanProjectId),
      scan: { ok: Boolean(scan?.ok || domScan?.ok), projectFeed: scan, dom: domScan }
    };
  } catch (error) {
    const message = String(error?.message || error || "gallery_scan_failed");
    recordEvent({ type: "gallery.scan.error", error: message });
    return {
      ok: false,
      error: message,
      gallery: galleryState(runtimeState.lastGalleryItems || [], runtimeState.lastGalleryItems?.length ? "flow-dom+queue-ledger" : "queue-ledger", runtimeState.lastGalleryProjectId),
      scan: { ok: false, error: message }
    };
  }
}

async function reconcileTaskFromKnownGallery(taskId, reason = "known_gallery") {
  const before = ledger.getTask(taskId);
  if (!before) return null;
  const items = runtimeState.lastGalleryItems || [];
  const reconciled = reconcileQueueWithGalleryItems(items);
  const entry = reconciled.find((patch) => patch.taskId === taskId) || null;
  if (reconciled.length) await persistQueueState();
  const after = ledger.getTask(taskId);
  if (entry) {
    recordEvent({
      type: "queue.image_reconcile",
      reason,
      taskId,
      status: after?.status || "",
      foundImages: after?.foundImages || 0,
      expectedImages: after?.expectedImages || before?.expectedImages || before?.repeatCount || 1
    });
  }
  return after;
}

function completeVideoTaskFromTerminalCapturedRows(task = {}, reason = "terminal_captured_rows") {
  if (!task?.id || taskMediaKind(task) !== "videos" || task.status !== TaskStatus.generating) return null;
  const rows = Array.isArray(task.statusRows) ? task.statusRows : [];
  const capturedIds = [...new Set((Array.isArray(task.mediaIds) ? task.mediaIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean))];
  if (!capturedIds.length || !rows.length) return null;
  const expected = Math.max(1, Number(task.expectedVideos || task.repeatCount || capturedIds.length || 1) || 1);
  const rowById = new Map(rows.map((row) => [String(row?.id || "").trim(), row]));
  const capturedRows = capturedIds.map((id) => rowById.get(id)).filter(Boolean);
  if (capturedRows.length !== capturedIds.length) return null;
  if (!capturedRows.every((row) => row.status === "complete" || row.status === "failed")) return null;
  const completeRows = capturedRows.filter((row) => row.status === "complete");
  const failedRows = capturedRows.filter((row) => row.status === "failed");
  if (capturedIds.length < expected && !failedRows.length) {
    const submittedMs = Date.parse(String(task.submittedAt || ""));
    const ageMs = Number.isFinite(submittedMs) ? Date.now() - submittedMs : 0;
    const minPartialSettleMs = Math.max(90000, Math.min(240000, Number(task.videoPartialSettleMs || 120000) || 120000));
    if (ageMs < minPartialSettleMs) {
      recordEvent({
        type: "queue.video_terminal_partial_wait",
        reason,
        taskId: task.id,
        capturedIds: capturedIds.length,
        completeRows: completeRows.length,
        expectedVideos: expected,
        ageMs,
        minPartialSettleMs
      });
      return null;
    }
  }
  if (!completeRows.length) {
    return scheduler.markFailure(task.id, failureTextForStatusRows(capturedRows, "MEDIA_GENERATION_FAILED"));
  }
  const outputs = completeRows.map((row, mediaIndex) => ({
    id: `${task.id}:${row.id || mediaIndex}`,
    mediaId: row.id,
    mediaUrl: row.mediaUrl || buildMediaRedirectUrl({ mediaId: row.id }),
    thumbnailUrl: row.thumbnailUrl || buildMediaThumbnailUrl({ mediaId: row.id }),
    prompt: task.prompt || "",
    kind: "videos",
    status: row.status,
    rawStatus: row.rawStatus,
    mediaIndex
  }));
  const next = scheduler.markComplete(task.id, {
    statusRows: rows,
    outputs,
    outputMediaIds: outputs.map((output) => output.mediaId),
    foundVideos: outputs.length,
    expectedVideos: expected,
    failedOutputCount: Math.max(0, expected - outputs.length) + failedRows.length,
    failedOutputMediaIds: failedRows.map((row) => row.id).filter(Boolean),
    partialFailure: outputs.length < expected,
    lastPollAt: new Date().toISOString()
  });
  recordEvent({
    type: "queue.video_terminal_captured_complete",
    reason,
    taskId: task.id,
    foundVideos: outputs.length,
    expectedVideos: expected,
    capturedIds: capturedIds.length
  });
  return next;
}

function completeVideoTaskFromPartialOutputs(task = {}, reason = "partial_outputs_timeout") {
  const now = new Date().toISOString();
  const patch = buildPartialVideoCompletionPatch(task, now);
  if (!patch) return null;
  const next = ledger.updateTask(task.id, patch);
  recordEvent({
    type: "queue.video_partial_complete",
    reason,
    taskId: task.id,
    foundVideos: patch.foundVideos,
    expectedVideos: patch.expectedVideos,
    missingOutputCount: patch.missingOutputCount,
    ageMs: Date.now() - (Date.parse(String(task.submittedAt || "")) || Date.now()),
    minPartialSettleMs: patch.videoPartialSettleMs
  });
  return next;
}

async function waitForVideoTaskOutputs(task = {}, preferredTabId) {
  if (!task?.id || taskMediaKind(task) !== "videos") return task;
  let current = ledger.getTask(task.id) || task;
  if (current.status !== TaskStatus.generating) return current;

  const scanResult = await scanFlowGallery(preferredTabId, { auto: true, lightweight: true });
  current = ledger.getTask(task.id) || current;
  recordEvent({
    type: "queue.video_wait_scan",
    taskId: current.id,
    ok: Boolean(scanResult.ok),
    count: scanResult.gallery?.items?.length || 0,
    foundVideos: current.foundVideos || 0,
    expectedVideos: current.expectedVideos || current.repeatCount || 1,
    status: current.status || "",
    error: scanResult.error || ""
  });
  if (current.status === TaskStatus.complete) {
    await autoDownloadCompletedTasks([current.id], "video_reconcile");
    return current;
  }
  const terminal = completeVideoTaskFromTerminalCapturedRows(current, "queue_resume_or_handoff");
  if (terminal?.status === TaskStatus.complete) {
    await autoDownloadCompletedTasks([terminal.id], "video_terminal_captured");
    await persistQueueState();
    return terminal;
  }
  const partial = completeVideoTaskFromPartialOutputs(current, "queue_resume_or_handoff");
  if (partial?.status === TaskStatus.complete) {
    await autoDownloadCompletedTasks([partial.id], "video_partial_timeout");
    await persistQueueState();
    return partial;
  }
  return ledger.getTask(task.id) || current;
}

async function waitForImageTaskOutputs(task = {}, preferredTabId) {
  if (!task?.id || taskMediaKind(task) !== "images") return task;
  let current = ledger.getTask(task.id) || task;
  if (current.status !== TaskStatus.generating) return current;

  current = await reconcileTaskFromKnownGallery(task.id, "returned_ids") || current;
  if (current.status === TaskStatus.complete) {
    await autoDownloadCompletedTasks([current.id], "image_reconcile");
    return current;
  }

  const expected = Number(current.expectedImages || current.repeatCount || 1) || 1;
  const maxScans = Math.max(3, Math.min(18, Number(current.imageSettleScans || 10)));
  const settleMs = Math.max(3500, Math.min(12000, Number(current.imageSettleIntervalMs || 4000)));

  for (let scanIndex = 0; runtimeState.queueRunning && scanIndex < maxScans; scanIndex += 1) {
    recordEvent({
      type: "queue.image_wait",
      taskId: current.id,
      scanIndex: scanIndex + 1,
      maxScans,
      foundImages: current.foundImages || 0,
      expectedImages: expected
    });
    await sleep(scanIndex === 0 ? Math.min(3500, settleMs) : settleMs);
    const scanResult = await scanFlowGallery(preferredTabId);
    current = ledger.getTask(task.id) || current;
    recordEvent({
      type: "queue.image_scan",
      taskId: current.id,
      ok: scanResult.ok,
      count: scanResult.gallery?.items?.length || 0,
      foundImages: current.foundImages || 0,
      expectedImages: current.expectedImages || expected,
      status: current.status || "",
      error: scanResult.error || ""
    });
    if (current.status === TaskStatus.complete) {
      await autoDownloadCompletedTasks([current.id], "image_reconcile");
      return current;
    }
  }

  current = await reconcileTaskFromKnownGallery(task.id, "partial_timeout") || ledger.getTask(task.id) || current;
  const found = Number(current.foundImages || current.outputs?.length || current.outputMediaIds?.length || 0) || 0;
  if (current.status === TaskStatus.generating && found > 0 && found < expected) {
    current = ledger.updateTask(current.id, {
      status: TaskStatus.complete,
      completedAt: new Date().toISOString(),
      foundImages: found,
      expectedImages: expected,
      failedImages: expected - found,
      partialFailure: true,
      lastError: `PARTIAL_IMAGE_OUTPUTS:${found}/${expected}`,
      failureClass: "partial_image_outputs",
      failureScope: "task"
    });
    recordEvent({
      type: "queue.image_partial_complete",
      taskId: current.id,
      foundImages: found,
      expectedImages: expected,
      failedImages: expected - found
    });
    await autoDownloadCompletedTasks([current.id], "image_partial_timeout");
  }

  return ledger.getTask(task.id) || current;
}

function domFrontendSettleTimeoutMs(task = {}) {
  const explicit = Number(task.domFrontendSettleTimeoutMs || 0);
  if (explicit > 0) return Math.max(5000, Math.min(90000, explicit));
  return taskMediaKind(task) === "videos" ? 60000 : 45000;
}

function domFrontendSettleShouldReload(error = "", snapshot = {}) {
  const problems = Array.isArray(snapshot?.problems)
    ? snapshot.problems.map((problem) => String(problem || "").trim()).filter(Boolean)
    : [];
  const text = `${String(error || "")} ${problems.join(" ")}`.toLowerCase();
  return /flow_page_loading|flow_loading|editor_missing|editor_unstable|create_missing|create_unstable|settings_trigger_missing|settings_trigger_unstable/.test(text);
}

async function waitForDomFrontendReadyBeforeTask(task = {}, tabId = 0, reason = "before_submit") {
  if (!task?.id || !taskPrefersDom(task)) return { ok: true, skipped: true, reason: "not_dom_task" };
  const timeoutMs = domFrontendSettleTimeoutMs(task);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let reloadAttempted = false;
  let last = null;
  let loggedWait = false;
  while (Date.now() < deadline && runtimeState.queueRunning) {
    const bridge = await ensureFlowBridge(tabId).catch((error) => ({
      ok: false,
      error: String(error?.message || error || "flow_bridge_not_ready")
    }));
    if (!bridge?.ok) {
      last = { ok: false, error: bridge?.error || "flow_bridge_not_ready", snapshot: null };
    } else {
      last = await sendPageCommand({
        action: "composerReadyState",
        task: {
          id: task.id,
          mode: task.mode || "",
          prompt: task.prompt || ""
        },
        options: {
          allowDisabledCreate: true,
          allowMissingCreate: true
        },
        timeoutMs: 8000
      }, tabId).catch((error) => ({
        ok: false,
        error: String(error?.message || error || "composer_ready_state_failed"),
        snapshot: null
      }));
    }
    if (last?.ok === true) {
      recordEvent({
        type: "queue.dom_frontend_settle.ready",
        reason,
        taskId: task.id,
        mode: task.mode || "",
        elapsedMs: Date.now() - startedAt,
        reloaded: reloadAttempted,
        problems: last.snapshot?.problems || []
      });
      return { ok: true, elapsedMs: Date.now() - startedAt, reloaded: reloadAttempted };
    }
    const elapsedMs = Date.now() - startedAt;
    const problems = Array.isArray(last?.snapshot?.problems) ? last.snapshot.problems : [];
    if (!loggedWait || elapsedMs > 5000) {
      loggedWait = true;
      recordEvent({
        type: "queue.dom_frontend_settle.wait",
        reason,
        taskId: task.id,
        mode: task.mode || "",
        elapsedMs,
        error: last?.error || "",
        problems
      });
    }
    if (!reloadAttempted && elapsedMs >= 5500 && domFrontendSettleShouldReload(last?.error || "", last?.snapshot || {})) {
      const tabReload = await reloadFlowTab(tabId).catch((error) => ({
        ok: false,
        error: String(error?.message || error || "tab_reload_failed")
      }));
      reloadAttempted = true;
      recordEvent({
        type: "queue.dom_frontend_settle.reload",
        reason,
        taskId: task.id,
        mode: task.mode || "",
        elapsedMs,
        error: last?.error || "",
        problems,
        tabReloaded: tabReload?.ok === true,
        reloadError: tabReload?.error || ""
      });
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const projectId = String(task.projectId || projectIdFromUrl(tab?.url || "") || runtimeState.projectId || "").trim();
      if (projectId) {
        await waitForFlowProjectRoot(tabId, projectId).catch(() => null);
      }
      await sleep(1800);
      continue;
    }
    await sleep(700);
  }
  recordEvent({
    type: "queue.dom_frontend_settle.timeout",
    reason,
    taskId: task.id || "",
    mode: task.mode || "",
    elapsedMs: Date.now() - startedAt,
    error: last?.error || "",
    problems: last?.snapshot?.problems || [],
    reloaded: reloadAttempted
  });
  return {
    ok: false,
    error: last?.error || "DOM_FRONTEND_NOT_READY",
    reloaded: reloadAttempted,
    elapsedMs: Date.now() - startedAt
  };
}

async function recoverImageTaskAfterSubmitFailure(task = {}, preferredTabId, reason = "submit_failure_project_feed") {
  if (!task?.id || taskMediaKind(task) !== "images") return task;
  const current = ledger.getTask(task.id) || task;
  if (!current?.id || current.status === TaskStatus.complete || current.status === TaskStatus.generating) return current;
  const attempts = Number(current.attempts || 0);
  if (attempts <= 0) return current;
  const errorText = String(current.lastError || current.failureClass || "");
  if (!/DOM_DEBUGGER|REF_NOT_SERIALIZED|REQUEST_NOT_OBSERVED|NO_REQUEST|meta is not defined/i.test(errorText)) return current;

  const tab = await findFlowTab(preferredTabId);
  const tabProjectId = projectIdFromUrl(tab?.url || "");
  let scanResult = { ok: false, error: "flow_tab_not_found", rows: [] };
  if (tab?.id) {
    const bridge = await ensureFlowBridge(tab.id);
    if (bridge?.ok) {
      scanResult = await sendPageCommand({
        action: "projectGeneratedMedia",
        projectId: tabProjectId || runtimeState.projectId || current.projectId || "",
        maxProjectMedia: 500,
        timeoutMs: 20000
      }, tab.id).catch((error) => ({ ok: false, error: String(error?.message || error || "project_feed_failed"), rows: [] }));
    } else {
      scanResult = { ok: false, error: bridge?.error || "flow_bridge_not_ready", rows: [] };
    }
  }
  const rows = scanResult?.ok && Array.isArray(scanResult.rows) ? scanResult.rows : [];
  const recoverableTask = {
    ...current,
    status: TaskStatus.generating,
    submittedAt: current.submittedAt || current.submitAttemptStartedAt || new Date().toISOString(),
    expectedImages: Number(current.expectedImages || current.repeatCount || 1) || 1
  };
  const patchEntry = reconcileTasksWithProjectMediaFeed([recoverableTask], rows).find((entry) => entry.taskId === current.id) || null;
  if (patchEntry) {
    ledger.updateTask(current.id, {
      ...patchEntry.patch,
      submitFailureRecoveredFromProjectFeed: true,
      submitFailureRecoveredAt: new Date().toISOString()
    });
  }
  const after = ledger.getTask(current.id) || current;
  recordEvent({
    type: "queue.image_submit_failure_reconcile",
    reason,
    taskId: current.id,
    ok: Boolean(scanResult.ok),
    projectRows: rows.length,
    matchedCount: patchEntry?.matchedCount || 0,
    status: after.status || "",
    foundImages: after.foundImages || 0,
    expectedImages: after.expectedImages || current.expectedImages || current.repeatCount || 1,
    outputMediaIds: Array.isArray(after.outputMediaIds) ? after.outputMediaIds : [],
    error: scanResult.error || ""
  });
  if (after.status === TaskStatus.complete) {
    await autoDownloadCompletedTasks([after.id], "image_submit_failure_reconcile");
    await persistQueueState();
  }
  return after;
}

function pruneDownloadReservations(now = Date.now()) {
  for (const [key, value] of downloadReservations.artifacts.entries()) {
    if (now - Number(value?.at || 0) > DOWNLOAD_RESERVATION_TTL_MS) {
      downloadReservations.artifacts.delete(key);
    }
  }
  for (const [key, value] of downloadReservations.targets.entries()) {
    if (now - Number(value?.at || 0) > DOWNLOAD_RESERVATION_TTL_MS) {
      downloadReservations.targets.delete(key);
    }
  }
}

function extractMediaIdFromDownloadUrl(url = "") {
  const text = String(url || "");
  if (!text) return "";
  try {
    const parsed = new URL(text);
    const name = parsed.searchParams.get("name");
    if (name) return name;
    const mediaPath = parsed.pathname.match(/\/(?:video|image)\/([^/?#]+)/i);
    if (mediaPath?.[1]) return mediaPath[1];
  } catch {}
  return "";
}

function prunePendingNativeDownloadFilenames(now = Date.now()) {
  for (let index = pendingNativeDownloadFilenames.length - 1; index >= 0; index -= 1) {
    if (now - Number(pendingNativeDownloadFilenames[index]?.at || 0) > 30000) {
      pendingNativeDownloadFilenames.splice(index, 1);
    }
  }
}

function registerNativeDownloadFilename(url, filename) {
  prunePendingNativeDownloadFilenames();
  pendingNativeDownloadFilenames.push({
    at: Date.now(),
    url: String(url || ""),
    mediaId: extractMediaIdFromDownloadUrl(url),
    filename: String(filename || "")
  });
}

function takePendingNativeDownloadFilename(downloadItem = {}) {
  prunePendingNativeDownloadFilenames();
  const urls = new Set([
    String(downloadItem.url || ""),
    String(downloadItem.finalUrl || "")
  ].filter(Boolean));
  const mediaIds = new Set([
    extractMediaIdFromDownloadUrl(downloadItem.url),
    extractMediaIdFromDownloadUrl(downloadItem.finalUrl)
  ].filter(Boolean));
  const index = pendingNativeDownloadFilenames.findIndex((entry) => {
    if (entry.url && urls.has(entry.url)) return true;
    return entry.mediaId && mediaIds.has(entry.mediaId);
  });
  if (index < 0) return null;
  const [entry] = pendingNativeDownloadFilenames.splice(index, 1);
  return entry;
}

function reserveDownloadPlan(plan = {}) {
  pruneDownloadReservations();
  const artifactKey = String(plan.artifactKey || `${plan.taskId || plan.itemId || "unknown"}:${plan.mediaId || ""}`);
  const targetPathKey = String(plan.targetPathKey || plan.filename || "");
  if (artifactKey && downloadReservations.artifacts.has(artifactKey)) {
    return { ok: false, reason: "duplicate_artifact", artifactKey, targetPathKey };
  }
  if (targetPathKey && downloadReservations.targets.has(targetPathKey)) {
    return { ok: false, reason: "duplicate_target_path", artifactKey, targetPathKey };
  }
  const record = {
    at: Date.now(),
    itemId: plan.itemId || "",
    taskId: plan.taskId || "",
    mediaId: plan.mediaId || "",
    filename: plan.filename || ""
  };
  if (artifactKey) downloadReservations.artifacts.set(artifactKey, record);
  if (targetPathKey) downloadReservations.targets.set(targetPathKey, record);
  return { ok: true, reason: "allowed", artifactKey, targetPathKey };
}

function releaseDownloadReservation(reservation = {}) {
  const artifactKey = String(reservation.artifactKey || "");
  const targetPathKey = String(reservation.targetPathKey || "");
  if (artifactKey) downloadReservations.artifacts.delete(artifactKey);
  if (targetPathKey) downloadReservations.targets.delete(targetPathKey);
}

function queueBlockers() {
  return ledger.listTasks().filter((task) => [TaskStatus.failed, TaskStatus.blocked].includes(task.status));
}

function resumeBlockedQueueTasks(options = {}) {
  let resumed = 0;
  const browserModeTaskId = compactString(options.browserModeTaskId || options.taskId || "");
  for (const task of queueBlockers()) {
    const patch = {
      status: TaskStatus.pending,
      attempts: 0,
      resumedAt: new Date().toISOString(),
      previousFailureClass: task.failureClass || "",
      previousLastError: task.lastError || ""
    };
    if (browserModeTaskId && browserModeTaskId === task.id) {
      patch.submitPathPreference = "dom_first";
      patch.submitPath = "dom_first";
      patch.browserModeRetryRequestedAt = new Date().toISOString();
    }
    ledger.updateTask(task.id, patch);
    resumed += 1;
  }
  return resumed;
}

function canRunTaskDomFirst(task = {}) {
  return [
    "text-to-image",
    "text-to-video",
    "image-to-video",
    "start-end-image-to-video",
    "ingredients-to-video"
  ].includes(String(task?.mode || ""));
}

function taskSignalsApiFirstDomAvailable(task = {}) {
  return task?.apiFirstQuotaSuspected === true &&
    task?.domVerificationAttempted === true &&
    (
      task?.domVerificationResult === "success" ||
      task?.finalQuotaClassification === "api_first_blocked_dom_available" ||
      task?.failureClass === "api_first_blocked_dom_available"
    );
}

function switchPendingApiFirstRowsToDom({ sourceTaskId = "" } = {}) {
  let switched = 0;
  const switchedIds = [];
  for (const task of ledger.listTasks()) {
    if (task.status !== TaskStatus.pending) continue;
    if (String(task.submitPathPreference || task.submitPath || "api_first") !== "api_first") continue;
    if (!canRunTaskDomFirst(task)) continue;
    ledger.updateTask(task.id, {
      submitPathPreference: "dom_first",
      submitPath: "dom_first",
      switchedPendingRowsToDom: true,
      userConfirmedSwitchToDom: true,
      browserModeSwitchReason: "api_first_blocked_dom_available",
      browserModeSwitchAt: new Date().toISOString()
    });
    switched += 1;
    switchedIds.push(task.id);
  }
  if (sourceTaskId) {
    const sourceTask = ledger.getTask(sourceTaskId);
    if (sourceTask) {
      ledger.updateTask(sourceTaskId, {
        switchedPendingRowsToDom: switched > 0,
        switchedPendingRowsToDomCount: switched,
        userConfirmedSwitchToDom: true,
        browserModeSwitchAt: new Date().toISOString()
      });
    }
  }
  recordEvent({
    type: "queue.api_first_dom_available.continue_browser_mode",
    sourceTaskId,
    switched,
    switchedIds
  });
  return { switched, switchedIds };
}

function minValidDownloadBytes(filename = "", options = {}) {
  const name = String(filename || "").toLowerCase();
  const kind = String(options.kind || "").toLowerCase();
  if (kind === "videos" || name.endsWith(".mp4")) return 16 * 1024;
  if (kind === "images" || /\.(png|jpe?g|webp|avif)$/i.test(name)) return 512;
  return 1;
}

function shouldRetryTinyVideoDownload(result = {}, plan = {}) {
  if (String(plan.kind || "") !== "videos") return false;
  return /^download_too_small:/i.test(String(result.error || ""));
}

function waitForDownloadComplete(downloadId, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 180000);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const resolveAfterRemovingInvalidFile = (item = {}, payload = {}) => {
      const done = () => resolve(payload);
      if (!downloadId || String(item.state || "") !== "complete") {
        done();
        return;
      }
      try {
        chrome.downloads.removeFile(downloadId, () => {
          chrome.downloads.erase({ id: downloadId }, () => done());
        });
      } catch {
        done();
      }
    };
    const finish = (item = {}, error = "") => {
      const bytes = Number(item.bytesReceived || item.fileSize || item.totalBytes || 0);
      const durationMs = Date.now() - startedAt;
      if (error) {
        resolve({ ok: false, error, downloadId, bytesReceived: bytes, fileSize: Number(item.fileSize || 0), filename: item.filename || "", durationMs });
        return;
      }
      const minBytes = minValidDownloadBytes(item.filename || options.filename || "", options);
      if (bytes < minBytes) {
        resolveAfterRemovingInvalidFile(item, {
          ok: false,
          error: `download_too_small:${bytes}<${minBytes}`,
          downloadId,
          bytesReceived: bytes,
          fileSize: Number(item.fileSize || 0),
          filename: item.filename || "",
          durationMs,
          removedInvalidFile: true
        });
        return;
      }
      resolve({ ok: true, downloadId, bytesReceived: bytes, fileSize: Number(item.fileSize || 0), filename: item.filename || "", durationMs });
    };
    const timer = setInterval(() => {
      chrome.downloads.search({ id: downloadId }, (items) => {
        const item = items?.[0] || {};
        if (item.state === "complete") {
          clearInterval(timer);
          finish(item);
          return;
        }
        if (item.state === "interrupted") {
          clearInterval(timer);
          finish(item, item.error || "download_interrupted");
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          clearInterval(timer);
          finish(item, "download_timeout");
        }
      });
    }, 500);
  });
}

function downloadFile(url, filename, options = {}) {
  return new Promise((resolve) => {
    registerNativeDownloadFilename(url, filename);
    chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify"
    }, (downloadId) => {
      const error = chromeCallbackError();
      if (error) {
        resolve({ ok: false, error, downloadId: null });
        return;
      }
      if (!downloadId) {
        resolve({ ok: false, error: "download_not_started", downloadId: null });
        return;
      }
      waitForDownloadComplete(downloadId, { ...options, filename }).then(resolve);
    });
  });
}

async function downloadFileWithReadinessRetries(url, filename, plan = {}, options = {}) {
  const delays = String(plan.kind || "") === "videos" ? [12000, 24000, 45000] : [];
  const startedAt = Date.now();
  let result = await downloadFile(url, filename, options);
  let retryWaitMs = 0;
  let attempts = 1;
  const fallbackUrl = String(plan.fallbackDownloadUrl || "").trim();
  if (shouldRetryTinyVideoDownload(result, plan) && fallbackUrl && fallbackUrl !== url) {
    recordEvent({
      type: "media.download.fallback_url",
      mediaId: plan.mediaId || "",
      taskId: plan.taskId || "",
      filename,
      error: result.error || "",
      fromUrl: summarizeDownloadUrl(url || ""),
      toUrl: summarizeDownloadUrl(fallbackUrl)
    });
    result = await downloadFile(fallbackUrl, filename, options);
    attempts += 1;
  }
  for (let attempt = 0; shouldRetryTinyVideoDownload(result, plan) && attempt < delays.length; attempt += 1) {
    const waitMs = delays[attempt];
    retryWaitMs += waitMs;
    recordEvent({
      type: "media.download.retry_wait",
      mediaId: plan.mediaId || "",
      taskId: plan.taskId || "",
      filename,
      error: result.error || "",
      attempt: attempt + 1,
      waitMs
    });
    await sleep(waitMs);
    result = await downloadFile(url, filename, options);
    attempts += 1;
  }
  return {
    ...result,
    attempts,
    retryWaitMs,
    totalDurationMs: Date.now() - startedAt
  };
}

function captureAuthEnvironment(payload = {}) {
  if (!payload.environment || typeof payload.environment !== "object") return;
  runtimeState.authEnvironment = {
    userAgent: String(payload.environment.userAgent || ""),
    screen: {
      width: Number(payload.environment.screen?.width || 0),
      height: Number(payload.environment.screen?.height || 0)
    }
  };
}

function chromeCallbackError() {
  return chrome.runtime.lastError ? String(chrome.runtime.lastError.message || chrome.runtime.lastError) : "";
}

async function findFlowTab(preferredTabId) {
  let preferredTab = null;
  if (Number.isInteger(preferredTabId)) {
    preferredTab = await chrome.tabs.get(preferredTabId).catch(() => null);
    if (!preferredTab?.id || !isFlowToolUrl(preferredTab.url || "")) preferredTab = null;
  }

  const runtimePreferredId = Number(runtimeState.activeTabId || 0);
  let runtimePreferredTab = null;
  if (Number.isInteger(runtimePreferredId) && runtimePreferredId > 0 && runtimePreferredId !== preferredTabId) {
    runtimePreferredTab = await chrome.tabs.get(runtimePreferredId).catch(() => null);
    if (!runtimePreferredTab?.id || !isFlowToolUrl(runtimePreferredTab.url || "")) runtimePreferredTab = null;
  }

  const tabs = await chrome.tabs.query({
    url: [
      "https://labs.google/fx/tools/flow*",
      "https://labs.google/fx/*/tools/flow*",
      "https://labs.google.com/fx/tools/flow*",
      "https://labs.google.com/fx/*/tools/flow*"
    ]
  });
  const exact = tabs.filter((tab) => tab.id && isFlowToolUrl(tab.url || ""));
  const projectTabs = exact.filter((tab) => projectIdFromUrl(tab.url || ""));
  const newestProject = [...projectTabs].sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0] || null;
  const newestLoadedProject = [...projectTabs]
    .filter((tab) => tab.status !== "unloaded" && tab.discarded !== true)
    .sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0] || null;
  const preferredProject = preferredTab?.id && projectIdFromUrl(preferredTab.url || "")
    ? projectTabs.find((tab) => Number(tab.id || 0) === Number(preferredTab.id || 0)) || preferredTab
    : null;
  const runtimeBound = runtimePreferredId
    ? projectTabs.find((tab) => Number(tab.id || 0) === runtimePreferredId)
      || (runtimePreferredTab?.id && projectIdFromUrl(runtimePreferredTab.url || "") ? runtimePreferredTab : null)
    : null;
  const activeProject = projectTabs.find((tab) => tab.active);
  const matchingProject = runtimeState.projectId
    ? projectTabs.find((tab) => projectIdFromUrl(tab.url || "") === runtimeState.projectId)
    : null;
  const exactProject = projectTabs[0] || null;
  if (preferredProject || activeProject || newestLoadedProject || matchingProject || runtimeBound || newestProject || exactProject) {
    return preferredProject || activeProject || newestLoadedProject || matchingProject || runtimeBound || newestProject || exactProject;
  }
  if (exact[0]) return exact[0];

  const allTabs = await chrome.tabs.query({}).catch(() => []);
  const broad = allTabs.filter((tab) => tab.id && isFlowToolUrl(tab.url || ""));
  return broad.find((tab) => projectIdFromUrl(tab.url || "")) || broad[0] || null;
}

function queuePreferredFlowTabId(message = {}, sender = {}) {
  const payloadTabId = Number(message.payload?.tabId || message.payload?.activeTabId || 0) || 0;
  if (payloadTabId > 0) return payloadTabId;
  if (Number(runtimeState.activeTabId || 0) > 0) return Number(runtimeState.activeTabId);
  const senderTabId = Number(sender?.tab?.id || 0) || 0;
  return senderTabId > 0 && isFlowToolUrl(sender?.tab?.url || "") ? senderTabId : undefined;
}

async function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
      const error = chromeCallbackError();
      if (error) {
        resolve({ ok: false, error });
        return;
      }
      resolve(response || { ok: false, error: "empty_tab_response" });
    });
  });
}

function isMissingReceiverError(error = "") {
  return /receiving end does not exist|could not establish connection|message port closed/i.test(String(error || ""));
}

async function probeFlowBridge(tabId) {
  return sendTabMessage(tabId, createMessage(MessageType.BridgeHealthV4, {
    probe: true
  }, {
    source: "background"
  }));
}

function isUnloadedFlowTab(tab = {}) {
  return Boolean(tab?.id && isFlowToolUrl(tab.url || "") && (tab.status === "unloaded" || tab.discarded === true));
}

async function wakeUnloadedFlowTab(tabId) {
  let tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id) return { ok: false, error: "flow_tab_not_found" };
  if (!isFlowToolUrl(tab.url || "")) return { ok: false, error: "flow_tab_not_flow_url" };
  if (!isUnloadedFlowTab(tab)) return { ok: true, tab };

  recordEvent({
    type: "bridge.tab.wake_unloaded",
    tabId,
    status: tab.status || "",
    discarded: tab.discarded === true
  });
  await chrome.tabs.reload(tabId).catch((error) => {
    recordEvent({
      type: "bridge.tab.wake_error",
      tabId,
      error: String(error?.message || error || "tab_reload_failed")
    });
  });
  for (const delayMs of [250, 500, 1000, 1500, 2500, 4000]) {
    await sleep(delayMs);
    tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.id && isFlowToolUrl(tab.url || "") && !isUnloadedFlowTab(tab)) {
      recordEvent({
        type: "bridge.tab.wake_ready",
        tabId,
        status: tab.status || "",
        discarded: tab.discarded === true
      });
      return { ok: true, tab };
    }
  }
  recordEvent({
    type: "bridge.tab.wake_failed",
    tabId,
    status: tab?.status || "",
    discarded: tab?.discarded === true
  });
  return { ok: false, error: "flow_tab_unloaded" };
}

function isFreshFlowBridge(probe = {}) {
  const ok = probe?.ok === true || probe?.ok === "true" || probe?.pageHookHealth?.ok === true || probe?.pageHookHealth?.ok === "true";
  const pageHookInstalled = probe?.pageHookInstalled === true || probe?.pageHookInstalled === "true";
  return Boolean(
    ok &&
    probe.bridgeVersion === EXPECTED_FLOW_BRIDGE_VERSION &&
    probe.pageHookVersion === EXPECTED_PAGE_HOOK_VERSION &&
    pageHookInstalled
  );
}

function bridgeRuntimeFields(probe = {}, connected = false) {
  const bridgeHealthy = isFreshFlowBridge(probe);
  const flowPageIssue = probe?.pageHookHealth?.flowPageIssue || probe?.flowPageIssue || null;
  const flowPageBlocked = flowPageIssue?.blocked === true;
  return {
    bridgeHealthy,
    bridgeVersion: compactString(probe?.bridgeVersion || ""),
    pageHookVersion: compactString(probe?.pageHookVersion || ""),
    pageHookInstalled: probe?.pageHookInstalled === true,
    hasNativeFetch: probe?.pageHookHealth?.hasNativeFetch === true || probe?.hasNativeFetch === true,
    flowPageIssue,
    flowPageBlocked,
    flowPageError: flowPageBlocked
      ? compactString(flowPageIssue.message || flowPageIssue.textPreview || "Flow page is temporarily rate limited.")
      : null,
    bridgeError: bridgeHealthy ? null : (connected ? compactString(probe?.error || "flow_bridge_not_ready") : null),
    extensionResourceCheck: probe?.extensionResourceCheck || null
  };
}

async function checkExtensionBridgeFiles(paths = REQUIRED_EXTENSION_BRIDGE_FILES) {
  const files = [];
  for (const filePath of paths) {
    const result = { path: filePath, ok: false, status: 0, error: "" };
    try {
      const response = await fetch(chrome.runtime.getURL(filePath), { cache: "no-store" });
      result.status = Number(response.status || 0);
      result.ok = response.ok === true;
      if (!result.ok) result.error = `http_${result.status || "unknown"}`;
    } catch (error) {
      result.error = compactString(error?.message || error || "extension_resource_fetch_failed");
    }
    files.push(result);
  }
  const missing = files.filter((file) => !file.ok);
  return {
    ok: missing.length === 0,
    files,
    missing: missing.map((file) => file.path),
    error: missing.length ? `EXTENSION_PACKAGE_MISSING_FILE:${missing.map((file) => file.path).join(",")}` : ""
  };
}

async function readBuildFingerprint() {
  try {
    const response = await fetch(chrome.runtime.getURL("build-fingerprint.json"), { cache: "no-store" });
    if (!response.ok) {
      return { ok: false, status: Number(response.status || 0), error: `http_${response.status || "unknown"}` };
    }
    const json = await response.json();
    return { ok: true, fingerprint: json };
  } catch (error) {
    return { ok: false, status: 0, error: compactString(error?.message || error || "build_fingerprint_read_failed") };
  }
}

function classifyDomDebuggerFailure(result = {}) {
  const text = [
    result?.error,
    result?.statusText,
    result?.data?.error,
    result?.data?.classification,
    result?.data?.preflight?.failedPhase
  ].map((value) => String(value || "")).join(" ");
  if (/api_repair_masked_dom_failure/i.test(text)) return "api_repair_masked_dom_failure";
  if (/DOM_PREFLIGHT_FAILED:(version_verified|dist_verified)|EXTENSION_PACKAGE_MISSING_FILE|build_fingerprint|version|stale_bridge|stale_rejected/i.test(text)) return "wrong_dist_or_version";
  if (/DOM_PREFLIGHT_FAILED:profile_verified/i.test(text)) return "wrong_profile_or_extension_id";
  if (/DOM_PREFLIGHT_FAILED:(flow_tab_bound|project_bound)/i.test(text)) return "wrong_flow_tab_or_project";
  if (/DOM_PREFLIGHT_FAILED:auth_ok/i.test(text)) return "auth_or_session_stale";
  if (/DOM_PREFLIGHT_FAILED:bridge_ok/i.test(text)) return "bridge_missing_before_click";
  if (/DOM_PREFLIGHT_FAILED:debugger_ok/i.test(text)) return "debugger_detached_before_click";
  if (/wrong_profile|profile/i.test(text)) return "wrong_profile_or_extension_id";
  if (/flow_tab_not_found|missing_project_id|flow_tab|project_bound|project_id/i.test(text)) return "wrong_flow_tab_or_project";
  if (/not_signed_in|daily_limit|auth|session/i.test(text)) return "auth_or_session_stale";
  if (/PROMPT_NOT_PERSISTED|PROMPT_EMPTY|DOM_PROMPT|prompt_uncommitted/i.test(text)) return "prompt_uncommitted_before_click";
  if (/IMAGE_REF_NOT_ATTACHED|REF_NOT_ATTACHED|REF_ATTACH|COMPOSER_UPLOAD_NOT_SETTLED|refs_uploaded_not_attached/i.test(text)) return "refs_uploaded_not_attached";
  if (/omni_store_ingredients_without_chips|store\.ingredients/i.test(text)) return "omni_store_ingredients_without_chips";
  if (/SETTINGS_STATE_INVALID|SETTINGS_FAILED|settings_invalid|videoApi|videoModelKey|duration:/i.test(text)) return "settings_invalid_before_click";
  if (/CREATE_TARGET_UNSAFE|IMAGE_DETAIL_EDITOR_OPEN|modal|overlay/i.test(text)) return "modal_or_overlay_blocking_click";
  if (/debugger.*detach|not attached to the tab|Debugger is not attached/i.test(text)) return "debugger_detached_before_click";
  if (/flow_bridge|bridge_missing|receiving end|Could not establish connection/i.test(text)) return "bridge_missing_before_click";
  if (/FLOW_CREDITS_BLOCK_F2V|flow_credits_block_f2v|Generating will use\s*-{2,}\s*credits/i.test(text)) return "flow_credits_block_f2v";
  if (/FRONTEND_NOT_UPDATED|network_only|REQUEST_SEEN_WITHOUT_VISIBLE/i.test(text)) return "request_seen_without_visible_pending";
  if (isHardQuotaFailure(text)) return "flow_model_daily_quota_reached";
  if (/PUBLIC_ERROR_UNUSUAL_ACTIVITY|reCAPTCHA|DOM_SUBMIT_REJECTED_403|RESOURCE_EXHAUSTED|\b429\b/i.test(text)) return "flow_session_heat";
  if (/PERMISSION_DENIED/i.test(text) && /\b403\b/.test(text)) return "flow_session_heat";
  if (/500|INTERNAL/i.test(text)) return "backend_500_after_visible_submit";
  if (/gallery.*stale/i.test(text)) return "gallery_card_stale";
  if (/download.*current_row|download.*mismatch/i.test(text)) return "downloaded_asset_not_current_row";
  if (/DOM_DEBUGGER|chrome_debugger|transport/i.test(text)) return "transport_failed_before_click";
  return "";
}

function classifyDomPreflightPhase(phase = "") {
  if (phase === "version_verified" || phase === "dist_verified") return "wrong_dist_or_version";
  if (phase === "profile_verified") return "wrong_profile_or_extension_id";
  if (phase === "flow_tab_bound" || phase === "project_bound") return "wrong_flow_tab_or_project";
  if (phase === "auth_ok") return "auth_or_session_stale";
  if (phase === "bridge_ok") return "bridge_missing_before_click";
  if (phase === "debugger_ok") return "debugger_detached_before_click";
  return "";
}

function preflightFailurePhase(checks = {}) {
  const ordered = [
    "version_verified",
    "dist_verified",
    "profile_verified",
    "flow_tab_bound",
    "project_bound",
    "auth_ok",
    "bridge_ok",
    "debugger_ok"
  ];
  return ordered.find((name) => checks[name] === false) || "";
}

async function domDebuggerPreflightForTask(tabId, task = {}) {
  const numericTabId = Number(tabId || 0);
  const tab = numericTabId ? await chrome.tabs.get(numericTabId).catch(() => null) : null;
  const tabProjectId = projectIdFromUrl(tab?.url || "");
  const resourceCheck = await checkExtensionBridgeFiles().catch((error) => ({
    ok: false,
    error: compactString(error?.message || error || "extension_resource_check_failed"),
    missing: [],
    files: []
  }));
  const buildFingerprint = await readBuildFingerprint();
  const bridge = tab?.id
    ? await ensureFlowBridge(tab.id).catch((error) => ({ ok: false, error: compactString(error?.message || error || "flow_bridge_not_ready") }))
    : { ok: false, error: "flow_tab_not_found" };
  const authAccess = runtimeState.auth ? queueStartAccessFromAuthSummary(runtimeState.auth) : null;
  const authBlocking = authAccess && authAccess.allowed === false && ["not_signed_in", "daily_limit_reached"].includes(authAccess.reason);
  const checks = {
    version_verified: Boolean(buildFingerprint.ok && (buildFingerprint.fingerprint?.shortCommit || buildFingerprint.fingerprint?.commit || buildFingerprint.fingerprint?.version)),
    dist_verified: resourceCheck.ok === true,
    profile_verified: Boolean(tab?.id),
    flow_tab_bound: Boolean(tab?.id && isFlowToolUrl(tab.url || "")),
    project_bound: Boolean(tabProjectId || task?.projectId || runtimeState.projectId),
    auth_ok: !authBlocking,
    bridge_ok: isFreshFlowBridge(bridge),
    debugger_ok: Boolean(chrome.debugger?.attach)
  };
  const failedPhase = preflightFailurePhase(checks);
  return {
    ok: !failedPhase,
    failedPhase,
    classification: failedPhase ? classifyDomPreflightPhase(failedPhase) : "",
    checks,
    tabId: numericTabId || null,
    runtimeActiveTabId: runtimeState.activeTabId || null,
    runtimeProjectId: runtimeState.projectId || "",
    tabProjectId,
    tabUrl: tab?.url || "",
    tabStatus: tab?.status || "",
    bridgeVersion: bridge?.bridgeVersion || "",
    pageHookVersion: bridge?.pageHookVersion || "",
    pageHookInstalled: bridge?.pageHookInstalled === true,
    bridgeError: bridge?.error || "",
    authReason: authAccess?.reason || "",
    authTier: authAccess?.tier || "",
    extensionResourceCheck: resourceCheck,
    buildFingerprint: buildFingerprint.ok ? {
      version: buildFingerprint.fingerprint?.version || buildFingerprint.fingerprint?.versionName || "",
      shortCommit: buildFingerprint.fingerprint?.shortCommit || "",
      commit: buildFingerprint.fingerprint?.commit || "",
      sourceRoot: buildFingerprint.fingerprint?.sourceRoot || "",
      dirty: buildFingerprint.fingerprint?.dirty === true
    } : { ok: false, error: buildFingerprint.error || "" }
  };
}

async function ensureFlowBridge(tabId) {
  const wake = await wakeUnloadedFlowTab(tabId);
  if (!wake?.ok) return { ok: false, error: wake?.error || "flow_tab_unavailable" };
  const firstProbe = await probeFlowBridge(tabId);
  if (isFreshFlowBridge(firstProbe)) return firstProbe;
  if (firstProbe?.ok && !isFreshFlowBridge(firstProbe)) {
    recordEvent({
      type: "bridge.inject.stale",
      tabId,
      bridgeVersion: firstProbe.bridgeVersion || "",
      pageHookVersion: firstProbe.pageHookVersion || "",
      pageHookInstalled: Boolean(firstProbe.pageHookInstalled)
    });
  } else if (!isMissingReceiverError(firstProbe?.error)) {
    return firstProbe;
  }

  recordEvent({
    type: "bridge.inject.start",
    tabId,
    reason: firstProbe?.ok ? "stale_bridge_or_page_hook" : firstProbe?.error || "missing_receiver"
  });

  try {
    const extensionResourceCheck = await checkExtensionBridgeFiles();
    if (!extensionResourceCheck.ok) {
      recordEvent({
        type: "bridge.inject.package_missing",
        tabId,
        extensionResourceCheck
      });
      return {
        ok: false,
        error: extensionResourceCheck.error,
        extensionResourceCheck
      };
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [FLOW_BRIDGE_SCRIPT_PATH]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [FLOW_PAGE_HOOK_SCRIPT_PATH],
      world: "MAIN"
    });
  } catch (error) {
    const message = String(error?.message || error || "bridge_injection_failed");
    const extensionResourceCheck = await checkExtensionBridgeFiles().catch((resourceError) => ({
      ok: false,
      files: [],
      missing: [],
      error: compactString(resourceError?.message || resourceError || "extension_resource_check_failed")
    }));
    recordEvent({
      type: "bridge.inject.error",
      tabId,
      error: message,
      extensionResourceCheck
    });
    return { ok: false, error: message, extensionResourceCheck };
  }

  let secondProbe = null;
  for (const delayMs of [150, 300, 600, 1000, 1500]) {
    await sleep(delayMs);
    secondProbe = await probeFlowBridge(tabId);
    if (isFreshFlowBridge(secondProbe)) break;
  }
  recordEvent({
    type: isFreshFlowBridge(secondProbe) ? "bridge.inject.ready" : "bridge.inject.missing",
    tabId,
    error: secondProbe?.error || "",
    bridgeVersion: secondProbe?.bridgeVersion || "",
    pageHookVersion: secondProbe?.pageHookVersion || "",
    pageHookInstalled: Boolean(secondProbe?.pageHookInstalled)
  });
  if (isFreshFlowBridge(secondProbe)) return secondProbe;
  if (secondProbe?.ok) {
    recordEvent({
      type: "bridge.inject.stale_rejected",
      tabId,
      bridgeVersion: secondProbe.bridgeVersion || "",
      pageHookVersion: secondProbe.pageHookVersion || "",
      pageHookInstalled: Boolean(secondProbe.pageHookInstalled)
    });
  }
  return {
    ok: false,
    error: secondProbe?.error || "flow_bridge_not_ready",
    bridgeVersion: secondProbe?.bridgeVersion || "",
    pageHookVersion: secondProbe?.pageHookVersion || "",
    pageHookInstalled: Boolean(secondProbe?.pageHookInstalled)
  };
}

async function sendPageCommand(payload, preferredTabId) {
  const tab = await findFlowTab(preferredTabId);
  if (!tab?.id) throw new Error("flow_tab_not_found");
  const bridge = await ensureFlowBridge(tab.id);
  if (!bridge?.ok) throw new Error(bridge?.error || "flow_bridge_not_ready");
  const result = await sendTabMessage(tab.id, createMessage(MessageType.PageCommandV4, payload, {
    source: "background"
  }));
  if (result?.ok === false && !Number(result?.status || 0)) {
    if (payload?.action === "domSubmitTask") {
      return {
        tabId: tab.id,
        url: tab.url,
        ...result
      };
    }
    throw new Error(result.error || "page_command_failed");
  }
  return {
    tabId: tab.id,
    url: tab.url,
    ...result
  };
}

function createExecutorForTab(tabId) {
  const flowClient = createFlowClientForTab(tabId);
  const pollSnapshots = new Map();
  const taskContext = (taskId) => {
    const task = ledger.getTask(taskId) || {};
    return {
      mode: task.mode || "",
      submitPath: task.submitPath || task.submitPathPreference || "",
      attempt: Number(task.attempts || 0),
      jobIndex: Number.isFinite(Number(task.jobIndex)) ? Number(task.jobIndex) : null,
      jobPromptCount: Number(task.jobPromptCount || 0),
      repeatCount: Number(task.repeatCount || 1) || 1,
      videoLength: String(task.videoLength || task.videoDurationSeconds || ""),
      model: task.model || "",
      aspectRatio: task.aspectRatio || "",
      failureClass: task.failureClass || "",
      healAction: task.healAction || "",
      lastError: task.lastError || ""
    };
  };
  return createQueueExecutor({
    ledger,
    scheduler,
    flowClient,
    domSubmitter: createDomSubmitterForTab(tabId),
    logger(event = {}) {
      if (event.type === "task_start") {
        recordEvent({
          type: "queue.task.start",
          taskId: event.taskId,
          mode: event.mode || "",
          submitPath: event.submitPath || "",
          attempt: event.attempt || 0,
          jobIndex: event.jobIndex,
          jobPromptCount: event.jobPromptCount || 0,
          repeatCount: event.repeatCount || 1,
          videoLength: event.videoLength || "",
          model: event.model || "",
          aspectRatio: event.aspectRatio || "",
          refCount: event.refCount || 0
        });
        return;
      }
      if (event.type === "submit_path_start") {
        recordEvent({
          type: "queue.submit.start",
          taskId: event.taskId,
          mode: event.mode || "",
          path: event.path || "",
          submitPath: event.submitPath || "",
          attempt: event.attempt || 0,
          jobIndex: event.jobIndex,
          jobPromptCount: event.jobPromptCount || 0,
          repeatCount: event.repeatCount || 1,
          videoLength: event.videoLength || "",
          model: event.model || "",
          aspectRatio: event.aspectRatio || "",
          refCount: event.refCount || 0,
          repairFromApi: Boolean(event.repairFromApi)
        });
        return;
      }
      if (event.type === "dom_submit_stage") {
        recordEvent({
          type: "queue.dom.stage",
          taskId: event.taskId || "",
          mode: event.mode || "",
          stage: event.stage || "",
          ok: event.ok,
          error: event.error || "",
          refCount: event.refCount || 0,
          attached: event.attached || 0,
          matchedCount: event.matchedCount || 0,
          selector: event.selector || "",
          mediaIds: Array.isArray(event.mediaIds) ? event.mediaIds : [],
          serializedIds: Array.isArray(event.serializedIds) ? event.serializedIds : [],
          capturedResponseCount: event.capturedResponseCount || 0,
          stableCount: Number(event.stableCount || 0),
          softSettled: event.softSettled === true,
          strategy: event.strategy || "",
          reason: event.reason || "",
          requestedPrompt: event.requestedPrompt || "",
          persisted: event.persisted || "",
          modeOutcome: event.modeOutcome || null,
          settingsOutcome: event.settingsOutcome || null,
          searchTerms: Array.isArray(event.searchTerms) ? event.searchTerms : [],
          lastTerm: event.lastTerm || "",
          rowCount: Number(event.rowCount || 0),
          rowSample: Array.isArray(event.rowSample) ? event.rowSample.slice(0, 12) : [],
          candidateIds: Array.isArray(event.candidateIds) ? event.candidateIds : [],
          targetImageId: event.targetImageId || "",
          ingredientIds: Array.isArray(event.ingredientIds) ? event.ingredientIds : [],
          requestSerializedIds: Array.isArray(event.requestSerializedIds) ? event.requestSerializedIds : [],
          finalIngredients: Array.isArray(event.finalIngredients) ? event.finalIngredients.slice(0, 12) : [],
          composerChipBaseline: Number(event.composerChipBaseline || 0),
          composerChipCount: Number(event.composerChipCount || 0),
          composerChipDelta: Number(event.composerChipDelta || 0),
	          nativeComposerChipProof: event.nativeComposerChipProof === true,
	          nativeFrameSlotProof: event.nativeFrameSlotProof === true,
	          visibleFrameSlotCount: Number(event.visibleFrameSlotCount || 0),
          missing: Array.isArray(event.missing) ? event.missing : [],
          wrongIngredientTypes: Array.isArray(event.wrongIngredientTypes) ? event.wrongIngredientTypes : [],
          uploadedMediaIds: Array.isArray(event.uploadedMediaIds) ? event.uploadedMediaIds : [],
          assetImageIds: Array.isArray(event.assetImageIds) ? event.assetImageIds : [],
          uploadedMediaId: event.uploadedMediaId || "",
          confirmedImageId: event.confirmedImageId || "",
          candidateId: event.candidateId || "",
          rowImageId: event.rowImageId || "",
          fileName: event.fileName || "",
          progress: event.progress || "",
          found: event.found,
          attempt: event.attempt || 0,
          source: event.source || "",
          text: event.text || "",
          rowText: event.rowText || "",
          candidates: Array.isArray(event.candidates) ? event.candidates.slice(0, 8) : [],
          selectedIds: Array.isArray(event.selectedIds) ? event.selectedIds.slice(0, 12) : [],
          targetIds: Array.isArray(event.targetIds) ? event.targetIds.slice(0, 12) : [],
          selectedText: event.selectedText || "",
          selectedHasVideo: event.selectedHasVideo,
          selectedHasImage: event.selectedHasImage,
          selectionOk: event.selectionOk,
          selectionError: event.selectionError || "",
          idMatched: event.idMatched,
          nameMatched: event.nameMatched,
          cardAttachOk: event.cardAttachOk,
          cardAttachError: event.cardAttachError || "",
          typeRepairOk: event.typeRepairOk,
          promptAttachOk: event.promptAttachOk,
          settledIds: Array.isArray(event.settledIds) ? event.settledIds : [],
	          composerSnapshot: event.composerSnapshot && typeof event.composerSnapshot === "object" ? event.composerSnapshot : null,
	          strictAssetRowMatch: event.strictAssetRowMatch === true,
	          nativeVisibleSlotAttached: event.nativeVisibleSlotAttached === true,
	          slotVisible: event.slotVisible,
	          targetMatched: event.targetMatched,
	          slotMediaIds: Array.isArray(event.slotMediaIds) ? event.slotMediaIds.slice(0, 8) : [],
	          retainedSlotVisible: event.retainedSlotVisible,
	          retainedTargetMatched: event.retainedTargetMatched,
	          retainedSlotMediaIds: Array.isArray(event.retainedSlotMediaIds) ? event.retainedSlotMediaIds.slice(0, 8) : [],
	          selectableAssetResolution: event.selectableAssetResolution || null,
	          domTrace: event.domTrace || null
	        });
        return;
      }
      if (event.type === "submit_path_result") {
        const attachOutcome = event.attachOutcome && typeof event.attachOutcome === "object" ? event.attachOutcome : null;
        const attachSteps = Array.isArray(attachOutcome?.steps) ? attachOutcome.steps : [];
        const failedAttachStep = attachSteps.findLast?.((step) => step && step.ok === false) || attachSteps.find((step) => step && step.ok === false) || null;
        const lastAttachStep = failedAttachStep || attachSteps[attachSteps.length - 1] || null;
        recordEvent({
          type: event.ok ? "queue.submit.ok" : "queue.submit.failed",
          taskId: event.taskId,
          mode: event.mode || "",
          path: event.path || "",
          submitPath: event.submitPath || "",
          transport: event.transport || "",
          status: event.status || 0,
          statusText: event.statusText || "",
          mediaIdCount: event.mediaIdCount || 0,
          endpoint: event.endpoint || "",
          error: event.error || "",
          attachError: attachOutcome?.ok === false ? attachOutcome.error || "" : "",
          attachStep: lastAttachStep?.step || "",
          attachStepError: lastAttachStep?.error || "",
          attachMessage: lastAttachStep?.message || "",
          attachRole: lastAttachStep?.role || "",
          attachFileName: lastAttachStep?.fileName || "",
          attachHasDataUrl: Boolean(lastAttachStep?.hasDataUrl),
          attachStepDetails: lastAttachStep || null,
          attachStepCount: attachSteps.length,
          attachedRefs: Number(attachOutcome?.attached || 0),
          serializedRefs: Array.isArray(attachOutcome?.serializedIds) ? attachOutcome.serializedIds.length : 0,
          repairedFromApi: Boolean(event.repairedFromApi)
        });
        return;
      }
      if (event.type === "submit_path_error") {
        recordEvent({
          type: "queue.submit.error",
          taskId: event.taskId,
          mode: event.mode || "",
          path: event.path || "",
          submitPath: event.submitPath || "",
          error: event.error || "submit_failed",
          repairFromApi: Boolean(event.repairFromApi)
        });
        return;
      }
      if (event.type === "api_403_fresh_token_retry" || event.type === "api_403_dom_fallback" || event.type === "api_session_heat_retry" || event.type === "api_session_heat_dom_fallback") {
        recordEvent({
          type: event.type === "api_403_fresh_token_retry" || event.type === "api_session_heat_retry" ? "queue.api_403.retry" : "queue.api_403.dom_fallback",
          taskId: event.taskId || "",
          mode: event.mode || "",
          submitPath: event.submitPath || "",
          attempt: event.attempt || 0,
          status: event.status || 0,
          statusText: event.statusText || "",
          error: event.error || ""
        });
        return;
      }
      if (event.type === "api_backend_dom_fallback" || event.type === "api_backend_dom_fallback_failed") {
        recordEvent({
          type: event.type === "api_backend_dom_fallback" ? "queue.api_backend.dom_fallback" : "queue.api_backend.dom_fallback_failed",
          taskId: event.taskId || "",
          mode: event.mode || "",
          submitPath: event.submitPath || "",
          attempt: event.attempt || 0,
          status: event.status || 0,
          statusText: event.statusText || "",
          error: diagnosticString(event.error || event.apiError || ""),
          apiError: diagnosticString(event.apiError || ""),
          domError: diagnosticString(event.domError || "")
        });
        return;
      }
      if (event.type === "reference_upload_start" || event.type === "reference_upload_ok" || event.type === "reference_upload_failed") {
        recordEvent({
          type: event.type === "reference_upload_start"
            ? "media.inline_ref_upload.start"
            : event.type === "reference_upload_ok"
              ? "media.inline_ref_upload.ok"
              : "media.inline_ref_upload.failed",
          taskId: event.taskId || "",
          mode: event.mode || "",
          role: event.role || "",
          fileName: event.fileName || "",
          mediaId: event.mediaId || "",
          status: event.status || 0,
          statusText: event.statusText || "",
          error: event.error || "",
          reason: event.reason || ""
        });
        return;
      }
      if (event.type === "api_repair_media_upload_start" || event.type === "api_repair_media_upload_ok") {
        recordEvent({
          type: event.type === "api_repair_media_upload_start" ? "media.api_repair_upload.start" : "media.api_repair_upload.ok",
          taskId: event.taskId || "",
          mode: event.mode || "",
          role: event.role || "",
          fileName: event.fileName || "",
          mediaId: event.mediaId || "",
          hasDataUrl: Boolean(event.hasDataUrl)
        });
        return;
      }
      if (event.type === "submitted") {
        const resultOk = event.result?.ok === true;
        if (!resultOk) {
          recordEvent({
            type: "queue.submit.rejected",
            taskId: event.taskId,
            mediaIds: event.result?.mediaIds || [],
            status: event.result?.status || 0,
            statusText: event.result?.statusText || "",
            error: diagnosticString(event.result?.error || event.result?.data?.error || event.result?.statusText || ""),
            transport: event.result?.data?.transport || event.result?.transport || (event.result?.endpoint ? "extension_api_submit" : ""),
            repairedFromDom: Boolean(event.result?.repairedFromDom),
            fallbackFromApiBackend: Boolean(event.result?.fallbackFromApiBackend),
            domError: diagnosticString(event.result?.domError || event.result?.data?.domError || ""),
            ...taskContext(event.taskId)
          });
          return;
        }
        recordEvent({
          type: "queue.submitted",
          taskId: event.taskId,
          mediaIds: event.result?.mediaIds || [],
          status: event.result?.status || 0,
          statusText: event.result?.statusText || "",
          transport: event.result?.data?.transport || event.result?.transport || (event.result?.endpoint ? "extension_api_submit" : ""),
          repairedFromDom: Boolean(event.result?.repairedFromDom),
          domError: event.result?.domError || "",
          ...taskContext(event.taskId)
        });
        return;
      }
      if (event.type === "dom_api_repair") {
        recordEvent({
          type: "queue.dom_api_repair",
          taskId: event.taskId,
          mode: event.mode || "",
          reason: event.reason || "",
          stage: event.stage || ""
        });
        return;
      }
      if (event.type === "poll") {
        const rows = event.rows || [];
        const signature = rows.map((row) => `${row.id || ""}:${row.status || ""}:${row.rawStatus || ""}`).join("|");
        const previous = pollSnapshots.get(event.taskId);
        const shouldRecord = event.poll === 0 || signature !== previous || event.poll % 6 === 5 || rows.some((row) => ["complete", "failed"].includes(row.status));
        pollSnapshots.set(event.taskId, signature);
        if (!shouldRecord) return;
        recordEvent({
          type: "queue.poll",
          taskId: event.taskId,
          poll: event.poll,
          rows,
          complete: rows.filter((row) => row.status === "complete").length,
          failed: rows.filter((row) => row.status === "failed").length,
          pending: rows.filter((row) => row.status === "pending").length,
          unknown: rows.filter((row) => row.status === "unknown").length,
          ...taskContext(event.taskId)
        });
      }
    },
    async onTaskStateChange({ taskId, reason, task } = {}) {
      recordEvent({
        type: "queue.task.state",
        taskId: taskId || task?.id || "",
        reason: reason || "",
        status: task?.status || "",
        attempts: Number(task?.attempts || 0),
        mediaIds: Array.isArray(task?.mediaIds) ? task.mediaIds : [],
        foundImages: Number(task?.foundImages || 0),
        expectedImages: Number(task?.expectedImages || 0),
        foundVideos: Number(task?.foundVideos || 0),
        expectedVideos: Number(task?.expectedVideos || 0)
      });
      if (
        reason === "video_poll" &&
        task?.status === TaskStatus.generating &&
        ["text-to-video", "image-to-video", "start-end-image-to-video", "ingredients-to-video"].includes(String(task.mode || "")) &&
        !task.videoGalleryReconcileInFlight
      ) {
        const rows = Array.isArray(task.statusRows) ? task.statusRows : [];
        const hasCompleteUrlLessRows = rows.some((row) => String(row?.status || "") === "complete" && !String(row?.mediaUrl || row?.url || "").trim());
        const expectedVideos = Math.max(1, Number(task.expectedVideos || task.repeatCount || 1) || 1);
        const needsVisibleOutputReconcile = hasCompleteUrlLessRows || Number(task.foundVideos || 0) < expectedVideos;
        if (needsVisibleOutputReconcile) {
          ledger.updateTask(task.id, { videoGalleryReconcileInFlight: true });
          await persistQueueState();
          try {
            const scan = await scanFlowGallery(tabId, { auto: true, lightweight: true });
            recordEvent({
              type: "queue.video_gallery_reconcile.poll",
              taskId: task.id,
              ok: Boolean(scan?.ok),
              galleryCount: scan?.gallery?.items?.length || 0,
              error: scan?.error || ""
            });
          } finally {
            const latest = ledger.getTask(task.id);
            if (latest) ledger.updateTask(task.id, { videoGalleryReconcileInFlight: false });
          }
        }
      }
      return persistQueueState();
    }
  });
}

function createDomSubmitterForTab(tabId) {
  const debuggerEngine = createDebuggerEngine({
    sendPageCommand,
    trace: recordDebuggerTrace,
    responseTimeoutMs: 45000
  });
  return {
    async repairStatusFeedOnlySubmitVisibility(task, result = {}) {
      if (typeof debuggerEngine.repairStatusFeedOnlySubmitVisibility !== "function") {
        return { ok: true, skipped: true, reason: "repair_not_supported" };
      }
      return debuggerEngine.repairStatusFeedOnlySubmitVisibility(tabId, task, result);
    },

    async submitTask(task, meta = {}) {
      if (DOM_DEBUGGER_TRANSPORT_ENABLED) {
        const preflight = await domDebuggerPreflightForTask(tabId, task);
        recordDebuggerTrace(task, "preflight_verified", {
          ok: Boolean(preflight.ok),
          failedPhase: preflight.failedPhase || "",
          classification: preflight.classification || "",
          checks: preflight.checks || {},
          tabId: preflight.tabId,
          runtimeActiveTabId: preflight.runtimeActiveTabId,
          runtimeProjectId: preflight.runtimeProjectId || "",
          tabProjectId: preflight.tabProjectId || "",
          tabStatus: preflight.tabStatus || "",
          bridgeVersion: preflight.bridgeVersion || "",
          pageHookVersion: preflight.pageHookVersion || "",
          pageHookInstalled: preflight.pageHookInstalled === true,
          bridgeError: preflight.bridgeError || "",
          authReason: preflight.authReason || "",
          authTier: preflight.authTier || "",
          buildFingerprint: preflight.buildFingerprint || null,
          extensionMissing: preflight.extensionResourceCheck?.missing || []
        });
        if (!preflight.ok) {
          const error = `DOM_PREFLIGHT_FAILED:${preflight.failedPhase || "unknown"}`;
          return {
            ok: false,
            status: 0,
            statusText: error,
            error,
            data: {
              transport: "chrome_debugger",
              preflight,
              classification: preflight.classification || classifyDomDebuggerFailure({ error })
            }
          };
        }
        const debuggerResult = await debuggerEngine.submitTask(tabId, task, meta).catch((error) => {
          const message = String(error?.message || error || "dom_debugger_submit_failed");
          return {
            ok: false,
            status: 0,
            statusText: message,
            error: message,
            data: { transport: "chrome_debugger", error: message }
          };
        });
        if (debuggerResult?.ok) return debuggerResult;
        recordEvent({
          type: "queue.dom.debugger_transport_failed",
          taskId: task?.id || "",
          error: debuggerResult?.error || debuggerResult?.statusText || "dom_debugger_submit_failed",
          status: Number(debuggerResult?.status || 0),
          classification: debuggerResult?.data?.classification || classifyDomDebuggerFailure(debuggerResult),
          mode: task?.mode || "",
          submitPath: task?.submitPath || task?.submitPathPreference || "",
          attempt: Number(task?.attempts || 0),
          jobIndex: Number.isFinite(Number(task?.jobIndex)) ? Number(task.jobIndex) : null,
          jobPromptCount: Number(task?.jobPromptCount || 0),
          repeatCount: Number(task?.repeatCount || 1) || 1,
          videoLength: String(task?.videoLength || task?.videoDurationSeconds || "")
        });
        return debuggerResult;
      }
      const page = await sendPageCommand({
        action: "domSubmitTask",
        task,
        meta,
        timeoutMs: 180000
      }, tabId);
      const result = page?.result || page;
      const payload = result?.result || result;
      if (!payload?.ok) {
        return {
          ok: false,
          status: Number(payload?.status || 0),
          error: payload?.error || "dom_submit_failed",
          statusText: payload?.error || "dom_submit_failed",
          data: payload || {}
        };
      }
      return {
        ok: true,
        status: Number(payload.status || 200),
        statusText: payload.statusText || "",
        mediaIds: mediaIdsFrom(payload.mediaIds),
        data: payload
      };
    }
  };
}

function pointFromRect(rect = {}) {
  const x = Number(rect.x || 0) + Number(rect.width || 0) / 2;
  const y = Number(rect.y || 0) + Number(rect.height || 0) / 2;
  return { x: Math.max(1, Math.round(x)), y: Math.max(1, Math.round(y)) };
}

function debuggerTarget(tabId) {
  return { tabId: Number(tabId) };
}

function debuggerSend(target, method, params = {}) {
  return chrome.debugger.sendCommand(target, method, params);
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

function uniqueDebuggerPoints(points = []) {
  const seen = new Set();
  return points
    .filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    .map((point) => ({ x: Math.max(1, Math.round(point.x)), y: Math.max(1, Math.round(point.y)) }))
    .filter((point) => {
      const key = `${point.x}:${point.y}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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

function debuggerVisibleModeForTask(task = {}) {
  const mode = String(task.mode || "");
  if (mode === "text-to-video") return "VIDEO";
  if (mode === "image-to-video" || mode === "start-end-image-to-video") return "VIDEO_FRAMES";
  if (mode === "ingredients-to-video") return "VIDEO_REFERENCES";
  if (mode === "text-to-image") return "IMAGE";
  return "";
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
      const nodes = Array.from(document.querySelectorAll("button[aria-haspopup='menu']"))
        .filter(visible)
        .map((node) => ({ node, rect: node.getBoundingClientRect(), text: textOf(node) }))
        .filter((item) => /x[1-4]|crop_(16_9|9_16|square|landscape|portrait)/i.test(item.text))
        .sort((a, b) => b.rect.y - a.rect.y);
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
      const wanted = new Set([value, value ? value + "s" : ""].filter(Boolean));
      const candidates = Array.from(document.querySelectorAll("button[role='tab']"))
        .filter(visible)
        .filter((item) => wanted.has(textOf(item).replace(/\s+/g, "")))
        .filter((item) => /-trigger-(4|6|8|10)$/.test(String(item.id || "")) || wanted.has(textOf(item).replace(/\s+/g, "")))
        .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
      return hit(candidates[0], "duration_tab") || {
        ok: false,
        error: "duration_tab_not_found",
        value,
        visibleNumberTabs: Array.from(document.querySelectorAll("button[role='tab']"))
          .filter(visible)
          .map((item) => ({ id: item.id || "", text: textOf(item), ariaSelected: item.getAttribute("aria-selected") || "", rect: rectOf(item) }))
          .filter((item) => /^(4|6|8|10)s?$/.test(item.text.replace(/\s+/g, "")) || /-trigger-(4|6|8|10)$/.test(item.id))
      };
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
  if (options.skipIfSelected === true && String(found.ariaSelected || "") === "true") {
    return { ok: true, descriptor, found, skipped: true };
  }
  await debuggerClick(target, pointFromRect(found.rect));
  await sleep(Number(options.waitMs || 260));
  return { ok: true, descriptor, found };
}

async function debuggerEnsureSettingsMenuOpen(target) {
  const attempts = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await debuggerFindControl(target, { kind: "tabSuffix", suffix: "-trigger-IMAGE" });
    if (existing?.ok) return { ok: true, opened: attempt > 0, existing, attempts };
    const existingVideo = await debuggerFindControl(target, { kind: "tabSuffix", suffix: "-trigger-VIDEO" });
    if (existingVideo?.ok) return { ok: true, opened: attempt > 0, existing: existingVideo, attempts };

    if (attempt > 0) {
      await debuggerPressKey(target, "Escape", "Escape", 27, { holdMs: 20 }).catch(() => {});
      await sleep(120);
    }
    const clicked = await debuggerClickControl(target, { kind: "settingsTrigger" }, { waitMs: 420 + attempt * 180 });
    attempts.push({ attempt: attempt + 1, clicked });
    if (!clicked.ok) {
      await sleep(180);
      continue;
    }
    const after = await debuggerFindControl(target, { kind: "tabSuffix", suffix: "-trigger-IMAGE" });
    const afterVideo = await debuggerFindControl(target, { kind: "tabSuffix", suffix: "-trigger-VIDEO" });
    if (after?.ok || afterVideo?.ok) {
      return { ok: true, opened: true, clicked, existing: after?.ok ? after : afterVideo, attempts };
    }
    await sleep(220);
  }
  return { ok: false, error: "settings_menu_not_open", attempts };
}

async function debuggerApplyModeAndSettings(target, task = {}) {
  const isImageMode = String(task.mode || "") === "text-to-image";
  const steps = [];
  recordDebuggerTrace(task, "settings_start");
  const menu = await debuggerEnsureSettingsMenuOpen(target);
  steps.push({ step: "open_settings", ...menu });
  recordDebuggerTrace(task, "settings_open", { ok: Boolean(menu.ok), error: menu.error || "", clickedText: menu.clicked?.found?.text || "", clickedRect: menu.clicked?.found?.rect || null });
  if (!menu.ok) return { ok: false, error: menu.error || "settings_menu_not_open", steps };

  const visibleMode = debuggerVisibleModeForTask(task);
  const suffixMap = {
    VIDEO: "-trigger-VIDEO",
    VIDEO_FRAMES: "-trigger-VIDEO_FRAMES",
    VIDEO_REFERENCES: "-trigger-VIDEO_REFERENCES",
    IMAGE: "-trigger-IMAGE"
  };
  const topMode = visibleMode === "IMAGE" ? "IMAGE" : "VIDEO";
  const topClicked = await debuggerClickControl(target, { kind: "tabSuffix", suffix: suffixMap[topMode] }, { waitMs: 360, skipIfSelected: true });
  steps.push({ step: "top_mode", target: topMode, ...topClicked });
  recordDebuggerTrace(task, "settings_top_mode", { target: topMode, ok: Boolean(topClicked.ok), error: topClicked.error || topClicked.found?.error || "", text: topClicked.found?.text || "", rect: topClicked.found?.rect || null });
  if (!topClicked.ok) return { ok: false, error: "mode_tab_not_clicked", steps };
  if (visibleMode === "VIDEO_FRAMES" || visibleMode === "VIDEO_REFERENCES") {
    const subClicked = await debuggerClickControl(target, { kind: "tabSuffix", suffix: suffixMap[visibleMode] }, { waitMs: 360, skipIfSelected: true });
    steps.push({ step: "sub_mode", target: visibleMode, ...subClicked });
    recordDebuggerTrace(task, "settings_sub_mode", { target: visibleMode, ok: Boolean(subClicked.ok), error: subClicked.error || subClicked.found?.error || "", text: subClicked.found?.text || "", rect: subClicked.found?.rect || null });
    if (!subClicked.ok) return { ok: false, error: "sub_mode_tab_not_clicked", steps };
  }

  const aspect = debuggerAspectForTask(task);
  const aspectClicked = await debuggerClickControl(target, { kind: "tabSuffix", suffix: `-trigger-${aspect}` }, { waitMs: 260, skipIfSelected: true });
  steps.push({ step: "aspect", target: aspect, ...aspectClicked });
  recordDebuggerTrace(task, "settings_aspect", { target: aspect, ok: Boolean(aspectClicked.ok), error: aspectClicked.error || aspectClicked.found?.error || "", text: aspectClicked.found?.text || "", rect: aspectClicked.found?.rect || null });
  if (!aspectClicked.ok) return { ok: false, error: "aspect_not_clicked", steps };

  const repeat = Math.max(1, Math.min(4, Number.parseInt(task.repeatCount, 10) || 1));
  const repeatPattern = repeat === 1 ? { pattern: "^1x$", flags: "i" } : { pattern: `^x${repeat}$`, flags: "i" };
  const repeatClicked = await debuggerClickControl(target, { kind: "tabText", ...repeatPattern }, { waitMs: 260, skipIfSelected: true });
  steps.push({ step: "repeat", target: repeat, ...repeatClicked });
  recordDebuggerTrace(task, "settings_repeat", { target: repeat, ok: Boolean(repeatClicked.ok), error: repeatClicked.error || repeatClicked.found?.error || "", text: repeatClicked.found?.text || "", rect: repeatClicked.found?.rect || null });
  if (!repeatClicked.ok) return { ok: false, error: "repeat_not_clicked", steps };

  let duration = "";
  if (!isImageMode) {
    duration = debuggerDurationForTask(task);
    const durationClicked = await debuggerClickControl(target, { kind: "durationTab", value: duration }, { waitMs: 260, skipIfSelected: true });
    steps.push({ step: "duration", target: duration, ...durationClicked });
    recordDebuggerTrace(task, "settings_duration", { target: duration, ok: Boolean(durationClicked.ok), error: durationClicked.error || durationClicked.found?.error || "", text: durationClicked.found?.text || "", rect: durationClicked.found?.rect || null });
    if (!durationClicked.ok) {
      if (durationClicked.found?.error === "duration_tab_not_found") {
        steps.push({ step: "duration_unavailable_assumed", target: duration, reason: "duration_tab_missing_visible_option" });
        recordDebuggerTrace(task, "settings_duration_unavailable_assumed", { target: duration, reason: "duration_tab_missing_visible_option" });
      } else {
        return { ok: false, error: "duration_not_clicked", steps };
      }
    }
  }

  const modelPattern = debuggerModelPatternForTask(task);
  const modelFamily = isImageMode ? "image" : "video";
  const currentModel = await debuggerFindControl(target, { kind: "modelDropdown", family: modelFamily });
  steps.push({ step: "model_current", currentModel });
  recordDebuggerTrace(task, "settings_model_current", { ok: Boolean(currentModel?.ok), error: currentModel?.error || "", text: currentModel?.text || "", rect: currentModel?.rect || null });
  const normalizedCurrent = String(currentModel?.text || "").replace(/\b(arrow_drop_down|volume_up|volume_off)\b/gi, " ").replace(/\(leaving\s+\d+\/\d+\)/gi, " ").replace(/\s+/g, " ").trim();
  if (!new RegExp(modelPattern.source, modelPattern.flags).test(normalizedCurrent)) {
    const modelMenu = await debuggerClickControl(target, { kind: "modelDropdown", family: modelFamily }, { waitMs: 360 });
    steps.push({ step: "model_open", ...modelMenu });
    recordDebuggerTrace(task, "settings_model_open", { ok: Boolean(modelMenu.ok), error: modelMenu.error || modelMenu.found?.error || "", text: modelMenu.found?.text || "", rect: modelMenu.found?.rect || null });
    if (!modelMenu.ok) return { ok: false, error: "model_dropdown_not_clicked", steps };
    const modelItem = await debuggerClickControl(target, { kind: "modelItem", family: modelFamily, pattern: modelPattern.source, flags: modelPattern.flags }, { waitMs: 520 });
    steps.push({ step: "model_select", requested: task.model || "default", ...modelItem });
    recordDebuggerTrace(task, "settings_model_select", { requested: task.model || "default", ok: Boolean(modelItem.ok), error: modelItem.error || modelItem.found?.error || "", text: modelItem.found?.text || "", rect: modelItem.found?.rect || null, visibleVeoItems: modelItem.found?.visibleVeoItems || [] });
    if (!modelItem.ok) return { ok: false, error: "model_item_not_clicked", steps };
  }
  await debuggerPressKey(target, "Escape", "Escape", 27, { holdMs: 25 });
  await sleep(120);
  recordDebuggerTrace(task, "settings_done", { aspect, repeat, duration, model: task.model || "default" });
  return { ok: true, steps, aspect, repeat, duration, model: task.model || "default" };
}

function debuggerPromptClickPoints(prepared = {}) {
  const editor = prepared.editorRect || {};
  const create = prepared.createRect || {};
  const editorX = Number(editor.x || 0);
  const editorY = Number(editor.y || 0);
  const editorWidth = Number(editor.width || 0);
  const editorHeight = Number(editor.height || 0);
  const createX = Number(create.x || 0);
  const createY = Number(create.y || 0);
  return uniqueDebuggerPoints([
    pointFromRect(editor),
    { x: editorX + Math.min(80, Math.max(24, editorWidth / 5)), y: editorY + Math.max(10, editorHeight / 2) },
    { x: editorX + Math.min(120, Math.max(40, editorWidth / 4)), y: createY - 20 },
    { x: editorX + Math.min(120, Math.max(40, editorWidth / 4)), y: createY + 16 },
    { x: createX - 320, y: createY - 20 },
    { x: createX - 320, y: createY + 16 },
    { x: createX - 220, y: createY - 20 },
    { x: createX - 220, y: createY + 16 }
  ]);
}

async function debuggerReadComposerState(target) {
  const expression = `(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const textOf = (element) => String(element?.value || element?.innerText || element?.textContent || "");
    const editors = Array.from(document.querySelectorAll("textarea, [role='textbox'], [contenteditable='true'], [contenteditable='plaintext-only'], [data-slate-editor='true']"))
      .filter(visible)
      .filter((element) => !element.closest("[data-autoflow-rebuild], #af-bot-panel"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          text: textOf(element),
          tag: String(element.tagName || "").toLowerCase(),
          role: element.getAttribute("role") || "",
          contenteditable: element.getAttribute("contenteditable") || "",
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        };
      });
    const active = document.activeElement;
    const activeRect = active?.getBoundingClientRect ? active.getBoundingClientRect() : null;
    return {
      activeTag: String(active?.tagName || "").toLowerCase(),
      activeRole: active?.getAttribute?.("role") || "",
      activeText: textOf(active).slice(0, 400),
      activeRect: activeRect ? { x: Math.round(activeRect.x), y: Math.round(activeRect.y), width: Math.round(activeRect.width), height: Math.round(activeRect.height) } : null,
      editors
    };
  })()`;
  const result = await debuggerSend(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  }).catch((error) => ({ result: { value: { error: String(error?.message || error) } } }));
  return result?.result?.value || {};
}

async function debuggerSelectAll(target) {
  await debuggerSend(target, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Meta",
    code: "MetaLeft",
    windowsVirtualKeyCode: 91,
    nativeVirtualKeyCode: 91,
    modifiers: 4
  });
  await debuggerSend(target, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 4
  });
  await debuggerSend(target, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 4
  });
  await debuggerSend(target, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Meta",
    code: "MetaLeft",
    windowsVirtualKeyCode: 91,
    nativeVirtualKeyCode: 91
  });
}

async function debuggerBackspace(target) {
  await debuggerSend(target, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 51
  }).catch(() => {});
  await debuggerSend(target, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 51
  }).catch(() => {});
}

async function debuggerSelectAllAndInsert(target, text = "") {
  await debuggerSelectAll(target);
  await sleep(40);
  await debuggerBackspace(target);
  await sleep(60);
  await debuggerSelectAll(target);
  await sleep(40);
  await debuggerBackspace(target);
  await sleep(45);
  await debuggerSend(target, "Input.insertText", { text: String(text || "") });
}

async function debuggerFocusPreparedEditor(target, prepared = {}) {
  const rect = prepared?.editorRect || {};
  const expression = `((targetRect) => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const textOf = (element) => String(element?.value || element?.innerText || element?.textContent || "");
    const candidates = Array.from(document.querySelectorAll("textarea, [role='textbox'], [contenteditable='true'], [contenteditable='plaintext-only'], [data-slate-editor='true']"))
      .filter(visible)
      .filter((element) => !element.closest("[data-autoflow-rebuild], #af-bot-panel"))
      .map((element) => {
        const box = element.getBoundingClientRect();
        const dx = Math.abs((box.x + box.width / 2) - (Number(targetRect.x || 0) + Number(targetRect.width || 0) / 2));
        const dy = Math.abs((box.y + box.height / 2) - (Number(targetRect.y || 0) + Number(targetRect.height || 0) / 2));
        return { element, box, score: dx + dy, text: textOf(element) };
      })
      .sort((a, b) => a.score - b.score);
    const hit = candidates[0]?.element || null;
    if (!hit) return { ok: false, error: "editor_not_found" };
    hit.focus?.({ preventScroll: true });
    const box = hit.getBoundingClientRect();
    hit.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, clientX: box.x + Math.min(40, box.width / 2), clientY: box.y + box.height / 2 }));
    hit.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, clientX: box.x + Math.min(40, box.width / 2), clientY: box.y + box.height / 2 }));
    hit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, clientX: box.x + Math.min(40, box.width / 2), clientY: box.y + box.height / 2 }));
    return {
      ok: document.activeElement === hit || hit.contains(document.activeElement),
      tag: String(hit.tagName || "").toLowerCase(),
      role: hit.getAttribute("role") || "",
      text: textOf(hit).slice(0, 160),
      rect: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
    };
  })(${JSON.stringify(rect)})`;
  const value = await debuggerEvaluate(target, expression).catch((error) => ({ ok: false, error: String(error?.message || error) }));
  return value || { ok: false, error: "focus_no_result" };
}

async function debuggerFocusAndInsertPrompt(target, prepared = {}, prompt = "") {
  const text = String(prompt || "");
  const normalizedTarget = text.replace(/\s+/g, " ").trim();
  const points = debuggerPromptClickPoints(prepared);
  const attempts = [];
  const focused = await debuggerFocusPreparedEditor(target, prepared);
  if (focused?.ok) {
    await sleep(120);
    await debuggerSelectAllAndInsert(target, text);
    await sleep(220);
    const state = await debuggerReadComposerState(target);
    const editorTexts = Array.isArray(state.editors) ? state.editors.map((editor) => String(editor.text || "")) : [];
    const values = [String(state.activeText || ""), ...editorTexts];
    const inserted = values.some((value) => value.replace(/\s+/g, " ").trim() === normalizedTarget);
    attempts.push({
      point: focused.rect ? pointFromRect(focused.rect) : null,
      inserted,
      activeTag: state.activeTag || "",
      activeRole: state.activeRole || "",
      activeRect: state.activeRect || null,
      editorCount: editorTexts.length,
      editorTexts: editorTexts.map((value) => value.slice(0, 160)),
      focusMethod: "runtime_focus_editor"
    });
    recordDebuggerTrace({ id: prepared.taskId || "", mode: prepared.mode || "", prompt: text }, "prompt_insert_attempt", {
      point: focused.rect ? pointFromRect(focused.rect) : null,
      inserted,
      activeTag: state.activeTag || "",
      activeRole: state.activeRole || "",
      editorCount: editorTexts.length,
      editorTexts: editorTexts.map((value) => value.slice(0, 160)),
      focusMethod: "runtime_focus_editor",
      focusResult: focused
    });
    if (inserted) {
      return { ok: true, point: focused.rect ? pointFromRect(focused.rect) : null, attempts, state };
    }
  } else {
    recordDebuggerTrace({ id: prepared.taskId || "", mode: prepared.mode || "", prompt: text }, "prompt_focus_result", {
      ok: false,
      error: focused?.error || "runtime_focus_failed"
    });
  }
  for (const point of points) {
    await debuggerClick(target, point);
    await sleep(120);
    await debuggerSelectAllAndInsert(target, text);
    await sleep(220);
    const state = await debuggerReadComposerState(target);
    const editorTexts = Array.isArray(state.editors) ? state.editors.map((editor) => String(editor.text || "")) : [];
    const values = [String(state.activeText || ""), ...editorTexts];
    const inserted = values.some((value) => value.replace(/\s+/g, " ").trim() === normalizedTarget);
    attempts.push({
      point,
      inserted,
      activeTag: state.activeTag || "",
      activeRole: state.activeRole || "",
      activeRect: state.activeRect || null,
      editorCount: editorTexts.length,
      editorTexts: editorTexts.map((value) => value.slice(0, 160))
    });
    recordDebuggerTrace({ id: prepared.taskId || "", mode: prepared.mode || "", prompt: text }, "prompt_insert_attempt", {
      point,
      inserted,
      activeTag: state.activeTag || "",
      activeRole: state.activeRole || "",
      editorCount: editorTexts.length,
      editorTexts: editorTexts.map((value) => value.slice(0, 160))
    });
    if (inserted) {
      return { ok: true, point, attempts, state };
    }
  }
  return {
    ok: false,
    error: "DOM_DEBUGGER_PROMPT_NOT_INSERTED",
    attempts,
    state: await debuggerReadComposerState(target)
  };
}

async function debuggerHitTest(target, point = {}) {
  const expression = `((point) => {
    const textOf = (node) => String(node?.innerText || node?.textContent || node?.value || "").replace(/\\s+/g, " ").trim();
    const node = document.elementFromPoint(Number(point.x || 0), Number(point.y || 0));
    const button = node?.closest?.("button, [role='button']") || node;
    const rect = button?.getBoundingClientRect?.();
    return {
      ok: Boolean(button),
      tag: String(button?.tagName || "").toLowerCase(),
      role: button?.getAttribute?.("role") || "",
      ariaLabel: button?.getAttribute?.("aria-label") || "",
      text: textOf(button),
      disabled: Boolean(button?.disabled || button?.getAttribute?.("aria-disabled") === "true"),
      rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null
    };
  })(${JSON.stringify(point)})`;
  return debuggerEvaluate(target, expression).catch((error) => ({ ok: false, error: String(error?.message || error) }));
}

function hitLooksLikeCreateButton(hit = {}) {
  const text = `${hit.text || ""} ${hit.ariaLabel || ""}`.toLowerCase();
  if (hit.disabled) return false;
  if (text.includes("delete") || text.includes("remove") || text.includes("trash")) return false;
  return /arrow_forward|create|submit|generate|send/.test(text);
}

async function waitForDebuggerGenerationResponse(target, { projectId = "", expectedCount = 1, timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + Number(timeoutMs || 90000);
  const requiredCount = Math.max(1, Number(expectedCount || 1) || 1);
  const requestIds = new Set();
  const responseBodies = [];
  const isGenerationUrl = (url = "") => /video:batchAsyncGenerateVideoText|image:batchAsyncGenerateImage|image:asyncGenerateImage/i.test(String(url || ""));
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
        responseBodies.push({ status: params.response?.status || 0, url: params.response?.url || "", mediaIds, data });
        if (mediaIds.length >= requiredCount) done(responseBodies[responseBodies.length - 1]);
      } catch (error) {
        responseBodies.push({ status: params.response?.status || 0, url: params.response?.url || "", mediaIds: [], error: String(error?.message || error) });
      }
    }
  };
  chrome.debugger.onEvent.addListener(listener);
  try {
    while (Date.now() < deadline) {
      const complete = responseBodies.find((row) => Number(row.mediaIds?.length || 0) >= requiredCount);
      if (complete) return complete;
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        promise,
        sleep(Math.min(500, Math.max(50, remaining))).then(() => null)
      ]);
      if (result && Number(result.mediaIds?.length || 0) >= requiredCount) return result;
    }
    const best = responseBodies
      .filter((row) => row.mediaIds?.length)
      .sort((a, b) => Number(b.mediaIds?.length || 0) - Number(a.mediaIds?.length || 0))[0];
    if (best) {
      return {
        ...best,
        incomplete: true,
        expectedCount: requiredCount,
        error: `DOM_DEBUGGER_INCOMPLETE_MEDIA_IDS:${best.mediaIds.length}/${requiredCount}`
      };
    }
    return { status: 0, mediaIds: [], expectedCount: requiredCount, error: "DOM_DEBUGGER_REQUEST_NOT_OBSERVED" };
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
  }
}

async function submitTaskWithDebuggerTransport(tabId, task = {}, meta = {}) {
  if (!chrome.debugger?.attach) {
    return { ok: false, status: 0, statusText: "DOM_DEBUGGER_PERMISSION_UNAVAILABLE", error: "DOM_DEBUGGER_PERMISSION_UNAVAILABLE" };
  }
  const target = debuggerTarget(tabId);
  let attached = false;
  try {
    recordDebuggerTrace(task, "attach_start", { tabId });
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    recordDebuggerTrace(task, "attach_ok", { tabId });
    await debuggerSend(target, "Network.enable");

    const prep = await sendPageCommand({
      action: "domPrepareTaskForDebugger",
      task,
      meta: {
        ...meta,
        debuggerTransport: true,
        skipDomModeAndSettingsMutation: true
      },
      timeoutMs: 120000
    }, tabId);
    const prepared = prep?.result?.result || prep?.result || prep;
    prepared.taskId = task?.id || "";
    prepared.mode = task?.mode || "";
    recordDebuggerTrace(task, "prep_result", {
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
        statusText: /^DOM_DEBUGGER_/i.test(error) ? error : `DOM_DEBUGGER_PREP_FAILED:${error}`,
        error: /^DOM_DEBUGGER_/i.test(error) ? error : `DOM_DEBUGGER_PREP_FAILED:${error}`,
        data: { ...(prepared || {}), transport: "chrome_debugger" }
      };
    }

    const requestedRepeat = Math.max(1, Number(task.repeatCount || task.expectedVideos || task.expectedImages || 1) || 1);
    recordDebuggerTrace(task, "settings_gate", {
      debuggerSettingsEnabled: true,
      requestedRepeat,
      reason: "video_dom_settings_required_per_task"
    });
    const settings = await debuggerApplyModeAndSettings(target, task);
    recordDebuggerTrace(task, "settings_result", {
      ok: Boolean(settings.ok),
      skipped: Boolean(settings.skipped),
      reason: settings.reason || "",
      error: settings.error || "",
      aspect: settings.aspect || "",
      repeat: settings.repeat || "",
      duration: settings.duration || "",
      model: settings.model || "",
      requestedRepeat,
      selectedRepeat: settings.selectedRepeat || "",
      settingsTriggerText: settings.settingsTriggerText || ""
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

    const refreshedPrep = await sendPageCommand({
      action: "domPrepareTaskForDebugger",
      task,
      meta: {
        ...meta,
        debuggerTransport: true,
        skipDomModeAndSettingsMutation: true,
        afterDebuggerSettings: true
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
    recordDebuggerTrace(task, "prep_refreshed", {
      ok: Boolean(refreshedPrepared?.ok),
      error: refreshedPrepared?.error || "",
      editorRect: prepared.editorRect || null,
      createRect: prepared.createRect || null,
      selector: prepared.selector || "",
      strategy: prepared.strategy || ""
    });
    prepared.debuggerSettings = settings;

    const commitPrep = await sendPageCommand({
      action: "domCommitPromptForDebugger",
      task,
      timeoutMs: 120000
    }, tabId);
    const committed = commitPrep?.result?.result || commitPrep?.result || commitPrep;
    recordDebuggerTrace(task, "prompt_commit_page_hook", {
      ok: Boolean(committed?.ok),
      error: committed?.error || "",
      persisted: committed?.commit?.persisted || "",
      storePersisted: committed?.commit?.storePersisted || "",
      slatePersisted: committed?.commit?.slatePersisted || "",
      method: committed?.commit?.method || "",
      createRect: committed?.createRect || null,
      selector: committed?.selector || "",
      strategy: committed?.strategy || ""
    });
    if (!committed?.ok) {
      const error = committed?.error || "DOM_PROMPT_NOT_PERSISTED";
      return {
        ok: false,
        status: 0,
        statusText: error,
        error,
        data: { prepared, committed, transport: "chrome_debugger" }
      };
    }
    prepared.editorRect = committed.editorRect || prepared.editorRect;
    prepared.createRect = committed.createRect || prepared.createRect;
    prepared.selector = committed.selector || prepared.selector;
    prepared.strategy = committed.strategy || prepared.strategy;
    prepared.visible = committed.visible || prepared.visible;
    prepared.store = committed.store || prepared.store;
    prepared.createButton = committed.createButton || prepared.createButton;

    const createPoint = pointFromRect(prepared.createRect);
    const inserted = { ok: true, point: null, skipped: true, reason: "page_hook_prompt_commit" };
    recordDebuggerTrace(task, "prompt_insert_result", { ok: Boolean(inserted.ok), error: inserted.error || "", point: inserted.point || null });
    if (!inserted.ok) {
      const error = inserted.error || "prompt_not_inserted";
      return {
        ok: false,
        status: 0,
        statusText: /^DOM_DEBUGGER_/i.test(error) ? error : `DOM_DEBUGGER_PROMPT_NOT_INSERTED:${error}`,
        error: /^DOM_DEBUGGER_/i.test(error) ? error : `DOM_DEBUGGER_PROMPT_NOT_INSERTED:${error}`,
        data: { prepared, inserted, transport: "chrome_debugger" }
      };
    }
    const refreshedAfterInsert = await sendPageCommand({
      action: "domPrepareTaskForDebugger",
      task,
      meta: {
        ...meta,
        debuggerTransport: true,
        skipDomModeAndSettingsMutation: true,
        afterPromptInsert: true
      },
      timeoutMs: 120000
    }, tabId);
    const afterInsert = refreshedAfterInsert?.result?.result || refreshedAfterInsert?.result || refreshedAfterInsert;
    if (afterInsert?.ok) {
      prepared.editorRect = afterInsert.editorRect || prepared.editorRect;
      prepared.createRect = afterInsert.createRect || prepared.createRect;
      prepared.selector = afterInsert.selector || prepared.selector;
      prepared.strategy = afterInsert.strategy || prepared.strategy;
    }
    const safeCreatePoint = pointFromRect(prepared.createRect);
    const hit = await debuggerHitTest(target, safeCreatePoint);
    recordDebuggerTrace(task, "submit_hit_test", { createPoint: safeCreatePoint, hit });
    if (!hitLooksLikeCreateButton(hit)) {
      return {
        ok: false,
        status: 0,
        statusText: "DOM_DEBUGGER_CREATE_TARGET_UNSAFE",
        error: "DOM_DEBUGGER_CREATE_TARGET_UNSAFE",
        data: { prepared, hit, createPoint: safeCreatePoint, transport: "chrome_debugger" }
      };
    }
    await sleep(350);
    const expectedCount = Number(task.expectedVideos || task.expectedImages || task.repeatCount || 1);
    const responsePromise = waitForDebuggerGenerationResponse(target, {
      projectId: prepared.projectId || "",
      expectedCount,
      timeoutMs: Math.min(12000, Number(meta.responseTimeoutMs || 12000) || 12000)
    });
    recordDebuggerTrace(task, "submit_click", { createPoint: safeCreatePoint, expectedCount });
    await debuggerClick(target, safeCreatePoint);
    const response = await responsePromise;
    const mediaIds = mediaIdsFrom(response?.mediaIds || []);
    recordDebuggerTrace(task, "response_result", {
      status: Number(response?.status || 0),
      error: response?.error || "",
      mediaIdCount: mediaIds.length,
      mediaIds,
      expectedCount,
      incomplete: Boolean(response?.incomplete)
    });
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
    if (mediaIds.length < expectedCount) {
      recordDebuggerTrace(task, "partial_media_ids_allowed", {
        mediaIdCount: mediaIds.length,
        expectedCount,
        mediaIds
      });
    }
    return {
      ok: true,
      status: Number(response.status || 200),
      statusText: mediaIds.length < expectedCount ? `DOM_DEBUGGER_PARTIAL_MEDIA_IDS:${mediaIds.length}/${expectedCount}` : "DOM_DEBUGGER_SUBMIT_OK",
      mediaIds,
      data: {
        ...prepared,
        response,
        mediaIds,
        expectedCount,
        partialMediaIds: mediaIds.length < expectedCount,
        transport: "chrome_debugger"
      }
    };
  } finally {
    if (attached) {
      await chrome.debugger.detach(target).catch(() => {});
      recordDebuggerTrace(task, "detach", { tabId });
    }
  }
}

function createFlowClientForTab(tabId) {
  const transport = createPageFlowTransport({
    sendPageCommand: (payload) => sendPageCommand(payload, tabId)
  });
  return createFlowClient({
    fetchImpl: transport.fetchImpl,
    recaptchaProvider: transport.recaptchaProvider
  });
}

function mediaIdsFrom(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => compactString(id)).filter(Boolean))];
}

function localRefIdsFrom(refs = []) {
  return new Set((Array.isArray(refs) ? refs : [])
    .flatMap((ref) => [ref?.blobStoreId, ref?.id].map(compactString).filter(Boolean)));
}

function mediaIdFromRefInput(ref = {}) {
  const mediaId = compactString(ref?.mediaId || ref?.assetImageId);
  if (!mediaId) return "";
  return localRefIdsFrom([ref]).has(mediaId) ? "" : mediaId;
}

function firstFlowMediaId(values = [], refs = []) {
  const localIds = localRefIdsFrom(refs);
  return (Array.isArray(values) ? values : [])
    .map(compactString)
    .find((mediaId) => mediaId && !localIds.has(mediaId)) || "";
}

function compactDiagnosticPreview(value = "", limit = 240) {
  return compactString(String(value || "").replace(/\s+/g, " ").trim()).slice(0, limit);
}

function diagnosticHash(value = "") {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function evaluateFlowRendererCrashDom(tabId = 0) {
  if (!chrome.debugger?.attach) return { ok: false, error: "chrome_debugger_unavailable" };
  await releaseDebuggerSessions("flow_renderer_crash_detect", recordDebuggerTrace).catch(() => null);
  const target = debuggerTarget(tabId);
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await debuggerSend(target, "Runtime.enable").catch(() => {});
    const result = await debuggerSend(target, "Runtime.evaluate", {
      expression: `(() => ({
        href: location.href,
        title: document.title || "",
        text: (document.body && (document.body.innerText || document.body.textContent) || "").slice(0, 1000)
      }))()`,
      returnByValue: true,
      awaitPromise: false
    });
    return { ok: true, ...(result?.result?.value || {}) };
  } catch (error) {
    return { ok: false, error: compactString(error?.message || error || "renderer_crash_dom_probe_failed") };
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
}

async function detectFlowRendererCrashForTask(task = {}, tabId = 0, phase = "") {
  const tab = Number(tabId || 0) ? await chrome.tabs.get(Number(tabId)).catch(() => null) : null;
  const base = {
    url: tab?.url || "",
    title: tab?.title || "",
    text: "",
    error: "",
    phase
  };
  let crash = detectFlowRendererCrashSnapshot(base);
  if (crash.crashed) {
    return {
      ...crash,
      ...base,
      tabId: Number(tabId || 0) || null,
      projectId: projectIdFromUrl(tab?.url || "") || task?.projectId || runtimeState.projectId || ""
    };
  }
  if (!tab?.id || !isFlowToolUrl(tab.url || "")) {
    return {
      ...crash,
      ...base,
      tabId: Number(tabId || 0) || null,
      projectId: task?.projectId || runtimeState.projectId || ""
    };
  }
  const dom = await evaluateFlowRendererCrashDom(tab.id);
  crash = detectFlowRendererCrashSnapshot({
    url: dom?.href || tab.url || "",
    title: [tab.title || "", dom?.title || ""].filter(Boolean).join(" "),
    text: dom?.text || "",
    error: dom?.error || ""
  });
  return {
    ...crash,
    url: dom?.href || tab.url || "",
    title: dom?.title || tab.title || "",
    text: dom?.text || "",
    error: dom?.error || "",
    tabId: tab.id,
    projectId: projectIdFromUrl(dom?.href || tab.url || "") || task?.projectId || runtimeState.projectId || "",
    phase
  };
}

function flowRendererCrashTriggerText(task = {}, crash = {}) {
  return diagnosticString([
    crash?.textPreview,
    crash?.title,
    crash?.error,
    task?.lastError,
    task?.failureClass,
    task?.healAction
  ]);
}

async function flowRendererCrashEventFields(task = {}, tabId = 0, recoveryLevel = "", detail = {}) {
  const tab = Number(tabId || 0) ? await chrome.tabs.get(Number(tabId)).catch(() => null) : null;
  const buildResult = detail.buildFingerprintResult || await readBuildFingerprint().catch((error) => ({
    ok: false,
    error: compactString(error?.message || error || "build_fingerprint_read_failed")
  }));
  const bridgeBefore = detail.bridgeBefore || detail.bridge || {};
  const bridgeAfter = detail.bridgeAfter || {};
  const textPreview = compactDiagnosticPreview(detail.textPreview || detail.text || detail.triggerError || task?.lastError || "");
  const errorCode = compactString(detail.errorCode || flowRendererCrashErrorCode(textPreview || task?.lastError || ""));
  return {
    tabId: Number(tabId || 0) || null,
    projectId: compactString(detail.projectId || task?.projectId || runtimeState.projectId || projectIdFromUrl(tab?.url || "")),
    url: compactString(detail.url || tab?.url || ""),
    title: compactDiagnosticPreview(detail.title || tab?.title || "", 160),
    detectedTextHash: textPreview ? diagnosticHash(textPreview) : "",
    textPreview,
    errorCode,
    taskId: task?.id || "",
    mode: task?.mode || "",
    submitPath: task?.submitPath || task?.submitPathPreference || "",
    attempt: Number(task?.attempts || 0),
    buildFingerprint: summarizeBuildFingerprint(buildResult),
    bridgeVersion: bridgeAfter?.bridgeVersion || bridgeBefore?.bridgeVersion || "",
    pageHookVersion: bridgeAfter?.pageHookVersion || bridgeBefore?.pageHookVersion || "",
    bridgeVersionBefore: bridgeBefore?.bridgeVersion || "",
    pageHookVersionBefore: bridgeBefore?.pageHookVersion || "",
    bridgeVersionAfter: bridgeAfter?.bridgeVersion || "",
    pageHookVersionAfter: bridgeAfter?.pageHookVersion || "",
    recoveryLevel,
    cacheCleared: detail.cacheCleared === true,
    ignoreCacheReload: detail.ignoreCacheReload === true,
    ...detail
  };
}

async function recordFlowRendererCrashEvent(type, task = {}, tabId = 0, recoveryLevel = "", detail = {}) {
  const fields = await flowRendererCrashEventFields(task, tabId, recoveryLevel, detail);
  recordEvent({ type, ...fields });
}

async function markFlowRendererCrashDetected(task = {}, tabId = 0, crash = {}, phase = "detected") {
  const triggerError = `FLOW_RENDERER_CRASHED:${crash.errorCode ? `Error code: ${crash.errorCode}` : (crash.textPreview || "Aw, Snap")}`;
  const blocked = ledger.updateTask(task.id, {
    status: TaskStatus.blocked,
    failureClass: "flow_renderer_crashed",
    failureScope: "global",
    healAction: "recover_flow_page",
    lastError: triggerError,
    flowRendererCrashDetectedAt: new Date().toISOString(),
    flowRendererCrashPhase: phase,
    flowRendererCrashErrorCode: crash.errorCode || ""
  }) || task;
  await recordFlowRendererCrashEvent("flow_renderer_crash.detected", blocked, tabId, "", {
    triggerError,
    phase,
    projectId: crash.projectId || blocked.projectId || "",
    url: crash.url || "",
    title: crash.title || "",
    textPreview: crash.textPreview || crash.text || "",
    errorCode: crash.errorCode || ""
  });
  await persistQueueState();
  return blocked;
}

function taskTriggersFlowRendererCrashRecovery(task = {}) {
  const text = flowRendererCrashTriggerText(task);
  return task?.failureClass === "flow_renderer_crashed" ||
    task?.healAction === "recover_flow_page" ||
    /flow_renderer_crashed|aw,\s*snap|something went wrong while displaying this webpage|error code:\s*[a-z0-9_-]+/i.test(text);
}

async function maybeMarkFlowRendererCrashFromCurrentTab(task = {}, tabId = 0, phase = "global_recovery") {
  if (!task?.id) return task;
  if (taskTriggersFlowRendererCrashRecovery(task)) return task;
  const text = diagnosticString([task.lastError, task.failureClass, task.healAction]);
  const shouldInspect = taskPrefersDom(task) ||
    /flow_connection|bridge|composer_not_ready|dom_frontend|debugger_transport|reconnect_flow/i.test(text);
  if (!shouldInspect) return task;
  const crash = await detectFlowRendererCrashForTask(task, tabId, phase);
  return crash?.crashed ? markFlowRendererCrashDetected(task, tabId, crash, phase) : task;
}

function isRecoverableGlobalTask(task = {}) {
  return [TaskStatus.pending, TaskStatus.blocked].includes(task?.status)
    && task?.failureScope === "global"
    && RECOVERABLE_GLOBAL_HEAL_ACTIONS.has(String(task?.healAction || ""));
}

function taskTriggersHardStop(task = {}) {
  if (!task?.id) return false;
  const text = diagnosticString([
    task.lastError,
    task.failureClass,
    task.flowErrorCode,
    task.healAction,
    task.statusText,
    task.error
  ]);
  const policy = classifyRecoveryPolicy({ ...task, message: text });
  return policy.recoveryPolicy === "hard_stop";
}

function recoveryReportPatch(task = {}, patch = {}) {
  const mergedTask = { ...task, ...patch };
  const tasks = ledger.listTasks().map((item) => item.id === task.id ? { ...item, ...mergedTask } : item);
  return buildRecoveryReportFields(mergedTask, { tasks });
}

function hasPendingQueueTaskAfter(taskId = "") {
  const currentId = compactString(taskId);
  return ledger.listTasks().some((task) => task.id !== currentId && task.status === TaskStatus.pending);
}

async function skipFailedTaskForAutoRetry(task = {}, reason = "auto_retry_skip_failed") {
  if (task?.autoRetryFailedUntilZero !== true) return false;
  if (!["failed", "blocked"].includes(String(task?.status || ""))) return false;
  if (!hasPendingQueueTaskAfter(task.id)) return false;
  const skipped = ledger.updateTask(task.id, {
    status: TaskStatus.failed,
    autoRetrySkipped: true,
    autoRetrySkippedAt: new Date().toISOString(),
    autoRetrySkipReason: reason,
    previousFailureClass: task.failureClass || "",
    previousLastError: task.lastError || ""
  });
  recordEvent({
    type: "queue.auto_retry.skip_failed",
    taskId: task.id,
    reason,
    failureClass: task.failureClass || "",
    failureScope: task.failureScope || "",
    healAction: task.healAction || "",
    lastError: task.lastError || "",
    pending: ledger.listTasks().filter((candidate) => candidate.status === TaskStatus.pending).length
  });
  await persistQueueState();
  return Boolean(skipped);
}

function globalRecoveryDelayMs(task = {}) {
  const attempts = Math.max(1, Number(task?.globalRecoveryAttempts || task?.attempts || 1));
  const action = String(task?.healAction || "");
  const base = action === "reconnect_flow" ? 6000
    : action === "wait_for_capacity" ? 30000
      : action === "backoff" ? 30000
        : 45000;
  return Math.min(120000, base + ((attempts - 1) * 15000));
}

function flowSessionRecoveryTriggerText(task = {}) {
  return diagnosticString([
    task?.lastError,
    task?.failureClass,
    task?.healAction,
    task?.statusText,
    task?.error
  ]);
}

function extractFlowSessionStatus(text = "") {
  const raw = String(text || "");
  if (/\b429\b/.test(raw) || /resource_exhausted/i.test(raw)) return 429;
  if (/\b403\b/.test(raw) || /permission_denied|public_error_unusual_activity|recaptcha/i.test(raw)) return 403;
  return 0;
}

function extractFlowErrorCode(text = "") {
  const raw = String(text || "");
  const codes = raw.match(/PUBLIC_ERROR_[A-Z0-9_]+|PERMISSION_DENIED|RESOURCE_EXHAUSTED|COMPOSER_NOT_READY|DOM_SUBMIT_REJECTED_403/gi) || [];
  if (/recaptcha evaluation failed/i.test(raw)) codes.push("RECAPTCHA_EVALUATION_FAILED");
  return [...new Set(codes.map((code) => String(code || "").toUpperCase()))].join(" ");
}

function isFlowSessionRecoveryTriggerText(text = "") {
  const raw = String(text || "");
  if (isHardQuotaFailure(raw)) return false;
  if (/PUBLIC_ERROR_MODEL_ACCESS_DENIED|model_access_denied|model access denied/i.test(raw)) return false;
  return /PUBLIC_ERROR_UNUSUAL_ACTIVITY/i.test(raw) ||
    /recaptcha evaluation failed|reCAPTCHA/i.test(raw) ||
    (/PERMISSION_DENIED/i.test(raw) && /\b403\b/.test(raw)) ||
    (/RESOURCE_EXHAUSTED/i.test(raw) && /\b429\b/.test(raw)) ||
    /\b429\b/.test(raw);
}

function taskTriggersFlowSessionRecovery(task = {}) {
  const text = flowSessionRecoveryTriggerText(task);
  if (isHardQuotaFailure(text) || task?.failureClass === "flow_model_daily_quota_reached") return false;
  if (task?.failureClass === "flow_model_access_denied" || task?.failureClass === "api_first_model_access_denied") return false;
  if (task?.failureClass === "flow_session_heat" || task?.healAction === "recover_flow_session") return true;
  if (isFlowSessionRecoveryTriggerText(text)) return true;
  const recentSessionRejection = flowSessionRecoveryState.recentSessionRejectionAt > 0
    && Date.now() - flowSessionRecoveryState.recentSessionRejectionAt <= FLOW_SESSION_RECOVERY_RECENT_MS;
  return recentSessionRejection && /COMPOSER_NOT_READY/i.test(text);
}

function resetFlowSessionRecoveryForRun(runToken) {
  flowSessionRecoveryState.runToken = runToken;
  flowSessionRecoveryState.attempts = 0;
  flowSessionRecoveryState.active = false;
  flowSessionRecoveryState.lastTriggerError = "";
  flowSessionRecoveryState.lastFlowErrorCode = "";
  flowSessionRecoveryState.lastStatus = 0;
  flowSessionRecoveryState.lastTaskId = "";
  flowSessionRecoveryState.lastStartedAt = 0;
  flowSessionRecoveryState.recentSessionRejectionAt = 0;
}

function resetFlowRendererCrashRecoveryForRun(runToken) {
  flowRendererCrashRecoveryState.runToken = runToken;
  flowRendererCrashRecoveryState.attempts = 0;
  flowRendererCrashRecoveryState.active = false;
  flowRendererCrashRecoveryState.lastTriggerError = "";
  flowRendererCrashRecoveryState.lastTaskId = "";
  flowRendererCrashRecoveryState.lastStartedAt = 0;
}

function summarizeBuildFingerprint(result = {}) {
  if (!result?.ok) return { ok: false, error: result?.error || "", status: Number(result?.status || 0) };
  const fingerprint = result.fingerprint || {};
  return {
    version: fingerprint.version || fingerprint.versionName || "",
    shortCommit: fingerprint.shortCommit || "",
    commit: fingerprint.commit || "",
    sourceRoot: fingerprint.sourceRoot || "",
    dirty: fingerprint.dirty === true
  };
}

async function flowSessionRecoveryEventFields(task = {}, tabId = 0, recoveryLevel = "", detail = {}) {
  const { bridge, buildFingerprintResult, ...eventDetail } = detail || {};
  const triggerError = compactString(eventDetail.triggerError || flowSessionRecoveryTriggerText(task));
  const buildResult = buildFingerprintResult || await readBuildFingerprint().catch((error) => ({
    ok: false,
    error: compactString(error?.message || error || "build_fingerprint_read_failed")
  }));
  const tab = Number(tabId || 0) ? await chrome.tabs.get(Number(tabId)).catch(() => null) : null;
  const bridgeHealth = bridge || (Number(tabId || 0)
    ? await probeFlowBridge(Number(tabId)).catch((error) => ({ ok: false, error: compactString(error?.message || error || "bridge_probe_failed") }))
    : {});
  return {
    triggerError,
    status: Number(eventDetail.status || extractFlowSessionStatus(triggerError) || 0),
    flowErrorCode: compactString(eventDetail.flowErrorCode || extractFlowErrorCode(triggerError)),
    taskId: task?.id || "",
    mode: task?.mode || "",
    submitPath: task?.submitPath || task?.submitPathPreference || "",
    attempt: Number(task?.attempts || 0),
    recoveryLevel,
    projectId: compactString(eventDetail.projectId || bridgeHealth?.projectId || task?.projectId || runtimeState.projectId || projectIdFromUrl(tab?.url || "")),
    tabId: Number(tabId || 0) || null,
    buildFingerprint: summarizeBuildFingerprint(buildResult),
    bridgeVersion: bridgeHealth?.bridgeVersion || "",
    pageHookVersion: bridgeHealth?.pageHookVersion || "",
    cacheCleared: eventDetail.cacheCleared === true,
    ignoreCacheReload: eventDetail.ignoreCacheReload === true,
    serviceWorkerBypassed: eventDetail.serviceWorkerBypassed === true,
    ...eventDetail
  };
}

async function recordFlowSessionRecoveryEvent(type, task = {}, tabId = 0, recoveryLevel = "", detail = {}) {
  const fields = await flowSessionRecoveryEventFields(task, tabId, recoveryLevel, detail);
  recordEvent({ type, ...fields });
}

function flowSessionRecoveryLevelForAttempt(attempt = 1) {
  return FLOW_SESSION_RECOVERY_LEVELS[Math.max(0, Math.min(FLOW_SESSION_RECOVERY_LEVELS.length - 1, Number(attempt || 1) - 1))];
}

async function withFlowSessionRecoveryDebugger(tabId, task = {}, recoveryLevel = "", callback = async () => {}) {
  if (!chrome.debugger?.attach) return { ok: false, error: "chrome_debugger_unavailable" };
  await releaseDebuggerSessions("flow_session_recovery", recordDebuggerTrace).catch(() => null);
  const target = debuggerTarget(tabId);
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await debuggerSend(target, "Page.enable").catch(() => {});
    await debuggerSend(target, "Network.enable").catch(() => {});
    return await callback(target);
  } catch (error) {
    return {
      ok: false,
      error: compactString(error?.message || error || "flow_session_recovery_debugger_failed"),
      recoveryLevel
    };
  } finally {
    if (attached) {
      await debuggerSend(target, "Network.setCacheDisabled", { cacheDisabled: false }).catch(() => {});
      await debuggerSend(target, "Network.setBypassServiceWorker", { bypass: false }).catch(() => {});
      await chrome.debugger.detach(target).catch(() => {});
    }
  }
}

async function performFlowSessionRecoveryLevel(task = {}, tabId = 0, recoveryLevel = "") {
  const projectId = compactString(task?.projectId || runtimeState.projectId || "");
  const cacheCleared = recoveryLevel === "cache_clear_reload";
  const serviceWorkerBypassed = recoveryLevel === "service_worker_bypass_reload";
  const result = await withFlowSessionRecoveryDebugger(tabId, task, recoveryLevel, async (target) => {
    if (cacheCleared) {
      await debuggerSend(target, "Network.clearBrowserCache");
      await debuggerSend(target, "Network.setCacheDisabled", { cacheDisabled: true });
      await recordFlowSessionRecoveryEvent("flow_session_recovery.cache_clear", task, tabId, recoveryLevel, {
        cacheCleared: true,
        ignoreCacheReload: true,
        serviceWorkerBypassed: false
      });
    }
    if (serviceWorkerBypassed) {
      await debuggerSend(target, "Network.setBypassServiceWorker", { bypass: true });
      await recordFlowSessionRecoveryEvent("flow_session_recovery.service_worker_bypass", task, tabId, recoveryLevel, {
        cacheCleared: false,
        ignoreCacheReload: true,
        serviceWorkerBypassed: true
      });
    }
    await recordFlowSessionRecoveryEvent("flow_session_recovery.reload", task, tabId, recoveryLevel, {
      cacheCleared,
      ignoreCacheReload: true,
      serviceWorkerBypassed
    });
    await debuggerSend(target, "Page.reload", { ignoreCache: true });
    await sleep(700);
    const waitResult = projectId ? await waitForFlowProjectRoot(tabId, projectId) : { ok: true, tabId };
    if (cacheCleared) await debuggerSend(target, "Network.setCacheDisabled", { cacheDisabled: false }).catch(() => {});
    if (serviceWorkerBypassed) await debuggerSend(target, "Network.setBypassServiceWorker", { bypass: false }).catch(() => {});
    return waitResult?.ok === false ? waitResult : { ok: true, tabId, waitResult };
  });
  if (!result?.ok) return result;
  const bridge = await ensureFlowBridge(tabId).catch((error) => ({
    ok: false,
    error: compactString(error?.message || error || "flow_bridge_not_ready")
  }));
  await recordFlowSessionRecoveryEvent("flow_session_recovery.bridge_revalidated", task, tabId, recoveryLevel, {
    bridge,
    projectId: bridge?.projectId || projectId,
    cacheCleared,
    ignoreCacheReload: true,
    serviceWorkerBypassed
  });
  if (!isFreshFlowBridge(bridge)) {
    return { ok: false, error: bridge?.error || "flow_bridge_revalidation_failed", bridge };
  }
  return { ok: true, bridge, projectId: bridge?.projectId || projectId };
}

async function pauseFlowSessionRecoveryUnresolved(task = {}, tabId = 0, recoveryLevel = "", reason = "flow_session_heat_unresolved") {
  const reportFields = recoveryReportPatch(task, {
    status: TaskStatus.blocked,
    failureClass: "flow_session_heat_unresolved",
    failureScope: "global",
    healAction: "user_action_required",
    lastError: task.lastError || reason,
    recoveryPolicy: "safe_recovery_ladder",
    recoveryAttempted: true,
    recoverySkippedBecauseHardQuota: false,
    recoveryFinalOutcome: "repair_failed"
  });
  const blocked = ledger.updateTask(task.id, {
    status: TaskStatus.blocked,
    failureClass: "flow_session_heat_unresolved",
    failureScope: "global",
    healAction: "user_action_required",
    lastError: task.lastError || reason,
    ...reportFields,
    recoveryFinalOutcome: "repair_failed",
    flowSessionRecoveryPausedAt: new Date().toISOString(),
    flowSessionRecoveryPauseReason: reason
  });
  await recordFlowSessionRecoveryEvent("flow_session_recovery.pause_unresolved", blocked || task, tabId, recoveryLevel, {
    triggerError: task.lastError || reason,
    status: extractFlowSessionStatus(task.lastError || reason),
    flowErrorCode: extractFlowErrorCode(task.lastError || reason),
    cacheCleared: recoveryLevel === "cache_clear_reload",
    ignoreCacheReload: recoveryLevel !== "",
    serviceWorkerBypassed: recoveryLevel === "service_worker_bypass_reload",
    userMessage: "Flow session is rejecting generation. Cool down, sign in again, or manually refresh Flow before resuming."
  });
  await persistQueueState();
  return { ok: false, blocked };
}

async function pauseHardStopQueueFailure(task = {}, tabId = 0, reason = "") {
  const triggerError = flowSessionRecoveryTriggerText(task) || reason || task.lastError || task.failureClass || "hard_stop";
  const policy = classifyRecoveryPolicy({ ...task, message: triggerError });
  const hardQuotaPatch = policy.recoverySkippedBecauseHardQuota === true
    ? { recoverySkippedBecauseHardQuota: true, recoveryFinalOutcome: "blocked_hard_quota" }
    : { recoverySkippedBecauseHardQuota: false, recoveryFinalOutcome: policy.recoveryFinalOutcome };
  const reportFields = recoveryReportPatch(task, {
    status: TaskStatus.blocked,
    failureClass: policy.failureClass,
    failureScope: policy.scope || "global",
    healAction: policy.healAction || "user_action_required",
    lastError: task.lastError || triggerError,
    flowErrorCode: policy.flowErrorCode || extractFlowErrorCode(triggerError),
    recoveryPolicy: policy.recoveryPolicy,
    recoveryAttempted: false,
    ...hardQuotaPatch,
    recoveryStepsAttempted: [],
    recommendedNextAction: policy.recommendedNextAction,
    sideEffectRetryBlocked: policy.sideEffectRetryBlocked === true
  });
  const blocked = ledger.updateTask(task.id, {
    status: TaskStatus.blocked,
    failureClass: policy.failureClass,
    failureScope: policy.scope || "global",
    healAction: policy.healAction || "user_action_required",
    lastError: task.lastError || triggerError,
    flowErrorCode: policy.flowErrorCode || extractFlowErrorCode(triggerError),
    ...reportFields,
    ...hardQuotaPatch,
    hardStopPausedAt: new Date().toISOString()
  });
  recordEvent({
    type: "queue.hard_stop.blocked",
    taskId: task.id || "",
    tabId: Number(tabId || 0) || null,
    failureClass: blocked?.failureClass || policy.failureClass,
    flowErrorCode: blocked?.flowErrorCode || policy.flowErrorCode || "",
    recoveryPolicy: blocked?.recoveryPolicy || policy.recoveryPolicy,
    recoveryAttempted: false,
    recoverySkippedBecauseHardQuota: blocked?.recoverySkippedBecauseHardQuota === true,
    recoveryFinalOutcome: blocked?.recoveryFinalOutcome || policy.recoveryFinalOutcome,
    recommendedNextAction: blocked?.recommendedNextAction || policy.recommendedNextAction,
    completedTaskCountBeforeStop: Number(blocked?.completedTaskCountBeforeStop || 0),
    downloadedCountBeforeStop: Number(blocked?.downloadedCountBeforeStop || 0),
    pendingTaskCountAfterStop: Number(blocked?.pendingTaskCountAfterStop || 0)
  });
  await persistQueueState();
  return { ok: false, blocked };
}

async function recoverFlowSessionGlobalFailure(task = {}, tabId = 0) {
  const triggerError = flowSessionRecoveryTriggerText(task) || "flow_session_heat";
  const priorAttempts = Math.max(
    Number(flowSessionRecoveryState.attempts || 0),
    Number(task.flowSessionRecoveryAttempts || 0)
  );
  const recoveryAttempts = priorAttempts + 1;
  const recoveryLevel = flowSessionRecoveryLevelForAttempt(recoveryAttempts);
  flowSessionRecoveryState.active = true;
  flowSessionRecoveryState.attempts = recoveryAttempts;
  flowSessionRecoveryState.lastTriggerError = triggerError;
  flowSessionRecoveryState.lastFlowErrorCode = extractFlowErrorCode(triggerError);
  flowSessionRecoveryState.lastStatus = extractFlowSessionStatus(triggerError);
  flowSessionRecoveryState.lastTaskId = task.id || "";
  flowSessionRecoveryState.lastStartedAt = Date.now();
  flowSessionRecoveryState.recentSessionRejectionAt = Date.now();
  const repairingPatch = recoveryReportPatch(task, {
    recoveryPolicy: "safe_recovery_ladder",
    recoveryAttempted: true,
    recoverySkippedBecauseHardQuota: false,
    recoveryStepsAttempted: FLOW_SESSION_RECOVERY_LEVELS,
    recoveryCurrentStep: recoveryLevel,
    recoveryAttemptCount: recoveryAttempts,
    recoveryFinalOutcome: "repairing"
  });
  ledger.updateTask(task.id, {
    ...repairingPatch,
    recoveryPolicy: "safe_recovery_ladder",
    recoveryAttempted: true,
    recoverySkippedBecauseHardQuota: false,
    recoveryStepsAttempted: FLOW_SESSION_RECOVERY_LEVELS,
    recoveryCurrentStep: recoveryLevel,
    recoveryAttemptCount: recoveryAttempts,
    recoveryFinalOutcome: "repairing"
  });

  if (recoveryAttempts > MAX_FLOW_SESSION_RECOVERY_ATTEMPTS) {
    return pauseFlowSessionRecoveryUnresolved(task, tabId, recoveryLevel, "flow_session_recovery_exhausted");
  }

  await recordFlowSessionRecoveryEvent("flow_session_recovery.start", task, tabId, recoveryLevel, {
    triggerError,
    status: flowSessionRecoveryState.lastStatus,
    flowErrorCode: flowSessionRecoveryState.lastFlowErrorCode,
    cacheCleared: false,
    ignoreCacheReload: true,
    serviceWorkerBypassed: false
  });

  const result = await performFlowSessionRecoveryLevel(task, tabId, recoveryLevel);
  if (!result?.ok) {
    return pauseFlowSessionRecoveryUnresolved(task, tabId, recoveryLevel, result?.error || "flow_session_recovery_failed");
  }

  const recovered = ledger.updateTask(task.id, {
    status: TaskStatus.pending,
    flowSessionRecoveryAttempts: recoveryAttempts,
    flowSessionRecoveryLevel: recoveryLevel,
    flowSessionRecoveryRetriedAt: new Date().toISOString(),
    nextRetryAt: new Date().toISOString(),
    lastHealReloadOk: true,
    recoveryPolicy: "safe_recovery_ladder",
    recoveryAttempted: true,
    recoverySkippedBecauseHardQuota: false,
    recoveryStepsAttempted: FLOW_SESSION_RECOVERY_LEVELS,
    recoveryCurrentStep: recoveryLevel,
    recoveryAttemptCount: recoveryAttempts,
    recoveryFinalOutcome: "retry_same_task"
  }) || task;
  await recordFlowSessionRecoveryEvent("flow_session_recovery.retry_same_task", recovered, tabId, recoveryLevel, {
    bridge: result.bridge,
    projectId: result.projectId || recovered.projectId || "",
    triggerError,
    status: flowSessionRecoveryState.lastStatus,
    flowErrorCode: flowSessionRecoveryState.lastFlowErrorCode,
    cacheCleared: recoveryLevel === "cache_clear_reload",
    ignoreCacheReload: true,
    serviceWorkerBypassed: recoveryLevel === "service_worker_bypass_reload"
  });
  await persistQueueState();
  return { ok: true, task: recovered };
}

async function markFlowSessionRecoverySuccessIfNeeded(task = {}, tabId = 0) {
  if (!flowSessionRecoveryState.active || !task?.id) return;
  if (task.id !== flowSessionRecoveryState.lastTaskId) return;
  if (![TaskStatus.generating, TaskStatus.complete, TaskStatus.downloading].includes(task.status)) return;
  const recoveryLevel = flowSessionRecoveryLevelForAttempt(flowSessionRecoveryState.attempts);
  await recordFlowSessionRecoveryEvent("flow_session_recovery.success", task, tabId, recoveryLevel, {
    triggerError: flowSessionRecoveryState.lastTriggerError,
    status: flowSessionRecoveryState.lastStatus,
    flowErrorCode: flowSessionRecoveryState.lastFlowErrorCode,
    cacheCleared: recoveryLevel === "cache_clear_reload",
    ignoreCacheReload: true,
    serviceWorkerBypassed: recoveryLevel === "service_worker_bypass_reload"
  });
  ledger.updateTask(task.id, {
    recoveryPolicy: "safe_recovery_ladder",
    recoveryAttempted: true,
    recoverySkippedBecauseHardQuota: false,
    recoveryStepsAttempted: FLOW_SESSION_RECOVERY_LEVELS,
    recoveryCurrentStep: recoveryLevel,
    recoveryFinalOutcome: "recovered"
  });
  flowSessionRecoveryState.attempts = 0;
  flowSessionRecoveryState.active = false;
  flowSessionRecoveryState.lastTriggerError = "";
  flowSessionRecoveryState.lastFlowErrorCode = "";
  flowSessionRecoveryState.lastStatus = 0;
  flowSessionRecoveryState.lastTaskId = "";
  flowSessionRecoveryState.lastStartedAt = 0;
  flowSessionRecoveryState.recentSessionRejectionAt = 0;
}

function flowRendererCrashRecoveryLevelForAttempt(attempt = 1) {
  return FLOW_RENDERER_CRASH_RECOVERY_LEVELS[Math.max(0, Math.min(FLOW_RENDERER_CRASH_RECOVERY_LEVELS.length - 1, Number(attempt || 1) - 1))];
}

async function debuggerFlowDocumentState(target, tabId = 0) {
  const frameTree = await debuggerSend(target, "Page.getFrameTree").catch((error) => ({
    error: compactString(error?.message || error || "frame_tree_failed")
  }));
  const frame = frameTree?.frameTree?.frame || {};
  const evaluated = await debuggerSend(target, "Runtime.evaluate", {
    expression: `(() => {
      const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\\s+/g, " ").trim();
      return {
        url: location.href,
        title: document.title || "",
        documentReadyState: document.readyState || "",
        textPreview: text.slice(0, 600),
        projectId: String(location.href || "").match(/\\/project\\/([0-9a-f-]{36})/i)?.[1] || "",
        bridgeVersion: window.__afRebuildContentBridgeVersion || "",
        pageHookVersion: window.__afRebuildPageHookVersion || "",
        pageHookInstalled: window.__afRebuildPageHookInstalled === true
      };
    })()`,
    returnByValue: true,
    awaitPromise: false
  }).catch((error) => ({
    error: compactString(error?.message || error || "document_state_failed")
  }));
  const value = evaluated?.result?.value || {};
  const snapshot = {
    ok: Boolean(!evaluated?.error),
    error: evaluated?.error || "",
    tabId: Number(tabId || 0) || null,
    frameId: frame?.id || "",
    frameUrl: frame?.url || "",
    url: value.url || frame?.url || "",
    title: value.title || "",
    documentReadyState: value.documentReadyState || "",
    textPreview: compactDiagnosticPreview(value.textPreview || ""),
    projectId: value.projectId || projectIdFromUrl(value.url || frame?.url || ""),
    bridgeVersion: value.bridgeVersion || "",
    pageHookVersion: value.pageHookVersion || "",
    pageHookInstalled: value.pageHookInstalled === true
  };
  const crash = detectFlowRendererCrashSnapshot({
    url: snapshot.url,
    title: snapshot.title,
    text: snapshot.textPreview,
    error: snapshot.error
  });
  return {
    ...snapshot,
    crashPageStillVisible: crash.crashed === true,
    errorCode: crash.errorCode || ""
  };
}

async function waitForRecoveredFlowDocumentReady(target, tabId = 0, expectedProjectId = "", beforeState = {}) {
  const deadline = Date.now() + 18000;
  let last = null;
  while (Date.now() < deadline) {
    last = await debuggerFlowDocumentState(target, tabId);
    const ready = /^(interactive|complete)$/i.test(String(last.documentReadyState || ""));
    const projectMatches = !expectedProjectId || last.projectId === expectedProjectId || projectIdFromUrl(last.url || "") === expectedProjectId;
    if (ready && projectMatches && last.crashPageStillVisible !== true) {
      return {
        ok: true,
        ...last,
        documentChangedOrRevalidated: Boolean(
          (beforeState.frameId && last.frameId && beforeState.frameId !== last.frameId) ||
          (beforeState.url && last.url && beforeState.url !== last.url) ||
          (ready && projectMatches)
        )
      };
    }
    await sleep(300);
  }
  return {
    ok: false,
    ...(last || {}),
    error: last?.crashPageStillVisible
      ? "flow_renderer_crash_page_still_visible"
      : "flow_recovered_document_not_ready"
  };
}

async function resetFlowRendererCrashSubmitState(task = {}, tabId = 0, recoveryLevel = "") {
  const response = await sendPageCommand({
    action: "domResetDebuggerSubmitCaptures",
    task: { id: task.id || "" },
    meta: { reason: "flow_renderer_crash_recovery" },
    timeoutMs: 10000
  }, tabId).catch((error) => ({
    ok: false,
    error: compactString(error?.message || error || "dom_submit_capture_reset_failed")
  }));
  const result = response?.result?.result || response?.result || response;
  return {
    ok: result?.ok !== false,
    error: result?.error || "",
    cleared: Number(result?.cleared || 0),
    recoveryLevel
  };
}

async function waitForPostCrashComposerSettle(task = {}, tabId = 0) {
  const deadline = Date.now() + 16000;
  let last = null;
  const settleTask = {
    id: task.id || "",
    mode: task.mode || "text-to-image",
    prompt: ""
  };
  while (Date.now() < deadline) {
    last = await sendPageCommand({
      action: "composerReadyState",
      task: settleTask,
      options: {
        allowDisabledCreate: true,
        allowMissingCreate: true,
        allowCreateUnavailableBeforePrompt: true
      },
      timeoutMs: 8000
    }, tabId).catch((error) => ({
      ok: false,
      error: compactString(error?.message || error || "composer_ready_state_failed"),
      snapshot: null
    }));
    const snapshot = last?.snapshot || last?.result?.snapshot || null;
    const problems = Array.isArray(snapshot?.problems) ? snapshot.problems : [];
    const stillLoading = problems.includes("flow_loading") ||
      snapshot?.flowLoading === true ||
      snapshot?.skeletonLoading?.visible === true ||
      snapshot?.flowPageIssue?.blocked === true;
    if (last?.ok === true && !stillLoading) {
      return { ok: true, snapshot };
    }
    await sleep(350);
  }
  return {
    ok: false,
    error: last?.error || "post_crash_composer_settle_timeout",
    snapshot: last?.snapshot || last?.result?.snapshot || null
  };
}

async function performFlowRendererCrashRecoveryLevel(task = {}, tabId = 0, recoveryLevel = "") {
  const tabBefore = await chrome.tabs.get(tabId).catch(() => null);
  const projectId = compactString(task?.projectId || runtimeState.projectId || projectIdFromUrl(tabBefore?.url || ""));
  const cacheCleared = recoveryLevel === "cache_clear_reload";
  const bridgeBefore = await probeFlowBridge(tabId).catch((error) => ({
    ok: false,
    error: compactString(error?.message || error || "bridge_probe_failed")
  }));
  let reloadResult = { ok: false, error: "reload_not_attempted" };
  let documentBefore = null;
  let documentAfter = null;
  let debuggerAttachedFresh = false;
  let networkEnabledFresh = false;
  if (chrome.debugger?.attach) {
    await releaseDebuggerSessions("flow_renderer_crash_recovery_pre_reload", recordDebuggerTrace).catch(() => null);
    const target = debuggerTarget(tabId);
    let attached = false;
    try {
      await chrome.debugger.detach(target).catch(() => {});
      await chrome.debugger.attach(target, "1.3");
      attached = true;
      await debuggerSend(target, "Page.enable").catch(() => {});
      await debuggerSend(target, "Runtime.enable").catch(() => {});
      await debuggerSend(target, "Network.enable").catch(() => {});
      documentBefore = await debuggerFlowDocumentState(target, tabId).catch((error) => ({
        ok: false,
        error: compactString(error?.message || error || "document_before_failed")
      }));
      if (cacheCleared) {
        await debuggerSend(target, "Network.clearBrowserCache");
        await debuggerSend(target, "Network.setCacheDisabled", { cacheDisabled: true });
      }
      await recordFlowRendererCrashEvent("flow_renderer_crash.reload", task, tabId, recoveryLevel, {
        bridgeBefore,
        documentBefore,
        cacheCleared,
        ignoreCacheReload: true
      });
      await debuggerSend(target, "Page.reload", { ignoreCache: true });
      await sleep(700);
      if (cacheCleared) await debuggerSend(target, "Network.setCacheDisabled", { cacheDisabled: false }).catch(() => {});
      if (attached) {
        await chrome.debugger.detach(target).catch(() => {});
        attached = false;
      }
      reloadResult = projectId ? await waitForFlowProjectRoot(tabId, projectId) : { ok: true, tabId };
      if (reloadResult?.ok) {
        await chrome.debugger.attach(target, "1.3");
        attached = true;
        debuggerAttachedFresh = true;
        await debuggerSend(target, "Page.enable").catch(() => {});
        await debuggerSend(target, "Runtime.enable").catch(() => {});
        await debuggerSend(target, "Network.enable");
        networkEnabledFresh = true;
        documentAfter = await waitForRecoveredFlowDocumentReady(target, tabId, projectId, documentBefore || {});
        if (!documentAfter?.ok) {
          reloadResult = documentAfter;
        }
      }
    } catch (error) {
      reloadResult = {
        ok: false,
        error: compactString(error?.message || error || "flow_renderer_crash_reload_failed")
      };
    } finally {
      if (attached) {
        await debuggerSend(target, "Network.setCacheDisabled", { cacheDisabled: false }).catch(() => {});
        await chrome.debugger.detach(target).catch(() => {});
      }
    }
  } else if (!cacheCleared && chrome.tabs?.reload) {
    await recordFlowRendererCrashEvent("flow_renderer_crash.reload", task, tabId, recoveryLevel, {
      bridgeBefore,
      cacheCleared: false,
      ignoreCacheReload: true
    });
    await chrome.tabs.reload(tabId);
    await sleep(700);
    reloadResult = projectId ? await waitForFlowProjectRoot(tabId, projectId) : { ok: true, tabId };
  }
  if (!reloadResult?.ok) return reloadResult;
  const bridgeAfter = await ensureFlowBridge(tabId).catch((error) => ({
    ok: false,
    error: compactString(error?.message || error || "flow_bridge_not_ready")
  }));
  const submitStateReset = isFreshFlowBridge(bridgeAfter)
    ? await resetFlowRendererCrashSubmitState(task, tabId, recoveryLevel)
    : { ok: false, error: "bridge_not_fresh", cleared: 0 };
  const composerSettle = isFreshFlowBridge(bridgeAfter)
    ? await waitForPostCrashComposerSettle(task, tabId)
    : { ok: false, error: "bridge_not_fresh", snapshot: null };
  const expectedProjectMatches = !projectId ||
    bridgeAfter?.projectId === projectId ||
    documentAfter?.projectId === projectId ||
    projectIdFromUrl(documentAfter?.url || "") === projectId;
  await recordFlowRendererCrashEvent("flow_renderer_crash.bridge_revalidated", task, tabId, recoveryLevel, {
    bridgeBefore,
    bridgeAfter,
    documentBefore,
    documentAfter,
    projectId: bridgeAfter?.projectId || documentAfter?.projectId || projectId,
    cacheCleared,
    ignoreCacheReload: true
  });
  if (!isFreshFlowBridge(bridgeAfter)) {
    return { ok: false, error: bridgeAfter?.error || "flow_bridge_revalidation_failed", bridgeAfter };
  }
  await recordFlowRendererCrashEvent("flow_renderer_crash.post_recovery_ready", task, tabId, recoveryLevel, {
    bridgeBefore,
    bridgeAfter,
    documentBefore,
    documentAfter,
    projectId: bridgeAfter?.projectId || documentAfter?.projectId || projectId,
    url: documentAfter?.url || "",
    title: documentAfter?.title || "",
    documentReadyState: documentAfter?.documentReadyState || "",
    debuggerAttachedFresh,
    networkEnabledFresh,
    pageHookFresh: isFreshFlowBridge(bridgeAfter),
    crashPageStillVisible: documentAfter?.crashPageStillVisible === true,
    documentChangedOrRevalidated: documentAfter?.documentChangedOrRevalidated === true,
    submitCaptureStateCleared: submitStateReset?.ok === true,
    submitCaptureStateClearedCount: Number(submitStateReset?.cleared || 0),
    composerSettled: composerSettle?.ok === true,
    composerProblems: composerSettle?.snapshot?.problems || [],
    cacheCleared,
    ignoreCacheReload: true
  });
  if (!expectedProjectMatches) {
    return { ok: false, error: "flow_renderer_crash_project_changed", bridgeAfter, documentAfter };
  }
  if (documentAfter?.crashPageStillVisible === true) {
    return { ok: false, error: "flow_renderer_crash_page_still_visible", bridgeAfter, documentAfter };
  }
  if (submitStateReset?.ok === false) {
    return { ok: false, error: submitStateReset.error || "dom_submit_capture_reset_failed", bridgeAfter, documentAfter, submitStateReset };
  }
  if (composerSettle?.ok === false) {
    return { ok: false, error: composerSettle.error || "post_crash_composer_settle_failed", bridgeAfter, documentAfter, composerSettle };
  }
  return {
    ok: true,
    bridgeBefore,
    bridgeAfter,
    documentBefore,
    documentAfter,
    submitStateReset,
    composerSettle,
    projectId: bridgeAfter?.projectId || documentAfter?.projectId || projectId
  };
}

async function pauseFlowRendererCrashUnresolved(task = {}, tabId = 0, recoveryLevel = "", reason = "flow_renderer_crashed_unresolved") {
  const message = "Flow page crashed. Reload Flow or restart Chrome, then resume.";
  const blocked = ledger.updateTask(task.id, {
    status: TaskStatus.blocked,
    failureClass: "flow_renderer_crashed_unresolved",
    failureScope: "global",
    healAction: "user_action_required",
    lastError: message,
    flowRendererCrashPausedAt: new Date().toISOString(),
    flowRendererCrashPauseReason: reason
  });
  await recordFlowRendererCrashEvent("flow_renderer_crash.pause_unresolved", blocked || task, tabId, recoveryLevel, {
    triggerError: task.lastError || reason,
    errorCode: task.flowRendererCrashErrorCode || flowRendererCrashErrorCode(task.lastError || reason),
    cacheCleared: recoveryLevel === "cache_clear_reload",
    ignoreCacheReload: recoveryLevel !== "",
    userMessage: message
  });
  await persistQueueState();
  return { ok: false, blocked };
}

async function recoverFlowRendererCrashGlobalFailure(task = {}, tabId = 0) {
  const triggerError = flowRendererCrashTriggerText(task) || "flow_renderer_crashed";
  const priorAttempts = Math.max(
    Number(flowRendererCrashRecoveryState.attempts || 0),
    Number(task.flowRendererCrashRecoveryAttempts || 0)
  );
  const recoveryAttempts = priorAttempts + 1;
  const recoveryLevel = flowRendererCrashRecoveryLevelForAttempt(recoveryAttempts);
  flowRendererCrashRecoveryState.active = true;
  flowRendererCrashRecoveryState.attempts = recoveryAttempts;
  flowRendererCrashRecoveryState.lastTriggerError = triggerError;
  flowRendererCrashRecoveryState.lastTaskId = task.id || "";
  flowRendererCrashRecoveryState.lastStartedAt = Date.now();

  if (recoveryAttempts > MAX_FLOW_RENDERER_CRASH_RECOVERY_ATTEMPTS) {
    return pauseFlowRendererCrashUnresolved(task, tabId, recoveryLevel, "flow_renderer_crash_recovery_exhausted");
  }

  await recordFlowRendererCrashEvent("flow_renderer_crash.detected", task, tabId, recoveryLevel, {
    triggerError,
    textPreview: task.lastError || triggerError,
    errorCode: task.flowRendererCrashErrorCode || flowRendererCrashErrorCode(triggerError)
  });

  const result = await performFlowRendererCrashRecoveryLevel(task, tabId, recoveryLevel);
  if (!result?.ok) {
    return pauseFlowRendererCrashUnresolved(task, tabId, recoveryLevel, result?.error || "flow_renderer_crash_recovery_failed");
  }

  const recovered = ledger.updateTask(task.id, {
    status: TaskStatus.pending,
    flowRendererCrashRecoveryAttempts: recoveryAttempts,
    flowRendererCrashRecoveryLevel: recoveryLevel,
    flowRendererCrashRetriedAt: new Date().toISOString(),
    nextRetryAt: new Date().toISOString(),
    lastHealReloadOk: true
  }) || task;
  await recordFlowRendererCrashEvent("flow_renderer_crash.retry_same_task", recovered, tabId, recoveryLevel, {
    bridgeBefore: result.bridgeBefore,
    bridgeAfter: result.bridgeAfter,
    projectId: result.projectId || recovered.projectId || "",
    triggerError,
    cacheCleared: recoveryLevel === "cache_clear_reload",
    ignoreCacheReload: true
  });
  await persistQueueState();
  return { ok: true, task: recovered };
}

async function recoverGlobalQueueFailure(task = {}, tabId = 0) {
  const effectiveTask = await maybeMarkFlowRendererCrashFromCurrentTab(task, tabId, "global_recovery");
  if (taskTriggersHardStop(effectiveTask)) {
    return pauseHardStopQueueFailure(effectiveTask, tabId, "hard_stop_user_action_required");
  }
  if (taskTriggersFlowRendererCrashRecovery(effectiveTask)) {
    return recoverFlowRendererCrashGlobalFailure(effectiveTask, tabId);
  }
  if (taskTriggersFlowSessionRecovery(effectiveTask)) {
    return recoverFlowSessionGlobalFailure(effectiveTask, tabId);
  }
  const recoveryAttempts = Number(effectiveTask.globalRecoveryAttempts || 0) + 1;
  if (recoveryAttempts > MAX_FLOW_SESSION_RECOVERY_ATTEMPTS) {
    const blocked = ledger.updateTask(effectiveTask.id, {
      status: TaskStatus.blocked,
      healAction: "user_action_required",
      lastError: effectiveTask.lastError || `${effectiveTask.failureClass || "global_failure"} recovery exhausted`
    });
    recordEvent({
      type: "queue.global_recovery.exhausted",
      taskId: effectiveTask.id,
      failureClass: effectiveTask.failureClass || "",
      previousHealAction: effectiveTask.healAction || "",
      recoveryAttempts
    });
    await persistQueueState();
    return { ok: false, blocked };
  }

  const cooldownMs = globalRecoveryDelayMs({ ...effectiveTask, globalRecoveryAttempts: recoveryAttempts });
  const patch = {
    globalRecoveryAttempts: recoveryAttempts,
    nextRetryAt: new Date(Date.now() + cooldownMs).toISOString()
  };
  let tabReload = null;
  if (effectiveTask.healAction === "cooldown_and_refresh" || effectiveTask.healAction === "reconnect_flow") {
    tabReload = await reloadFlowTab(tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "tab_reload_failed") }));
    patch.lastHealReloadOk = tabReload?.ok === true;
  }
  ledger.updateTask(effectiveTask.id, patch);
  recordEvent({
    type: "queue.global_recovery.cooldown",
    taskId: effectiveTask.id,
    failureClass: effectiveTask.failureClass || "",
    healAction: effectiveTask.healAction || "",
    cooldownMs,
    recoveryAttempts,
    tabReloaded: tabReload?.ok === true
  });
  await persistQueueState();
  await sleep(cooldownMs);
  recordEvent({
    type: "queue.global_recovery.resume",
    taskId: effectiveTask.id,
    failureClass: effectiveTask.failureClass || "",
    healAction: effectiveTask.healAction || "",
    recoveryAttempts
  });
  return { ok: true };
}

async function recoverGenerationFailureRetryTask(task = {}, tabId = 0) {
  const status = String(task?.status || "");
  if (
    ![TaskStatus.pending, TaskStatus.generating].includes(status) ||
    (task?.healAction && task.healAction !== "retry_generation") ||
    task?.generationFailureNeedsFlowReload !== true
  ) {
    return task;
  }
  const recoveryAttempts = Number(task.generationFailureRecoveryAttempts || 0) + 1;
  const tabReload = await reloadFlowTab(tabId).catch((error) => ({
    ok: false,
    error: String(error?.message || error || "tab_reload_failed")
  }));
  const patch = {
    status: TaskStatus.pending,
    healAction: "retry_generation",
    generationFailureNeedsFlowReload: false,
    generationFailureRecoveryAttempts: recoveryAttempts,
    lastHealReloadOk: tabReload?.ok === true,
    lastHealReloadError: tabReload?.ok === true ? "" : (tabReload?.error || "tab_reload_failed")
  };
  const recovered = ledger.updateTask(task.id, patch) || task;
  recordEvent({
    type: "queue.generation_retry.reload",
    taskId: task.id,
    recoveryAttempts,
    tabReloaded: tabReload?.ok === true,
    error: tabReload?.ok === true ? "" : (tabReload?.error || "tab_reload_failed"),
    previousFailedOutputMediaIds: task.previousFailedOutputMediaIds || []
  });
  await persistQueueState();
  await sleep(tabReload?.ok === true ? 3500 : 1200);
  return ledger.getTask(task.id) || recovered;
}

function normalizeRefInput(ref = {}) {
  if (!ref || typeof ref !== "object") return null;
  const mediaId = mediaIdFromRefInput(ref);
  const fileName = compactString(ref.fileName || ref.title || ref.name);
  if (!mediaId && !fileName) return null;
  return {
    id: compactString(ref.id),
    blobStoreId: compactString(ref.blobStoreId),
    role: compactString(ref.role),
    mediaId,
    fileName,
    title: compactString(ref.title || fileName),
    mimeType: compactString(ref.mimeType || "image/png"),
    imageUrl: compactString(ref.imageUrl || ref.dataUrl || ref.mediaUrl),
    dataUrl: compactString(ref.dataUrl),
    mediaUrl: compactString(ref.mediaUrl || ref.imageUrl || ref.dataUrl)
  };
}

function refInputsFrom(value) {
  if (!Array.isArray(value)) return [];
  return value.map((ref) => normalizeRefInput(ref)).filter(Boolean);
}

async function ensureTaskProjectId(task, tabId) {
  const currentTab = await chrome.tabs.get(tabId).catch(() => null);
  let projectId = String(task.projectId || projectIdFromUrl(currentTab?.url || "") || "").trim();
  const page = await sendPageCommand({
    action: "projectState",
    timeoutMs: 10000
  }, tabId);
  projectId = String(page.projectId || projectId).trim();
  if (!projectId) throw new Error("missing_project_id");
  ledger.updateTask(task.id, { projectId });
  if (taskPrefersDom(task)) {
    const latestTab = await chrome.tabs.get(tabId).catch(() => null);
    const latestUrl = String(latestTab?.url || "");
    if (/\/edit\//i.test(latestUrl)) {
      const targetUrl = projectRootUrlFromFlowUrl(latestUrl, projectId);
      if (targetUrl) {
        recordEvent({
          type: "queue.dom_project_root.navigate",
          taskId: task.id,
          tabId,
          fromUrl: latestUrl,
          toUrl: targetUrl
        });
        await chrome.tabs.update(tabId, { url: targetUrl });
        const ready = await waitForFlowProjectRoot(tabId, projectId);
        recordEvent({
          type: ready.ok ? "queue.dom_project_root.ready" : "queue.dom_project_root.timeout",
          taskId: task.id,
          tabId,
          url: ready.url || "",
          error: ready.error || ""
        });
        await sleep(1200);
      }
    }
  }
  return projectId;
}

async function resolveContinuityChainForTask(task = {}, tabId = null) {
  const result = buildContinuityRefPatch(ledger.listTasks(), task);
  if (result.status === "not_chain" || result.status === "already_resolved") {
    return { ok: true, task: ledger.getTask(task.id) || task, status: result.status };
  }
  if (result.status === "resolved" && result.patch) {
    const resolved = ledger.updateTask(task.id, result.patch);
    recordEvent({
      type: "queue.continuity_ref.resolved",
      taskId: task.id,
      sourceTaskId: result.sourceTask?.id || "",
      mediaId: result.patch.continuitySourceMediaId || "",
      jobIndex: Number(task.jobIndex || 0)
    });
    await persistQueueState();
    return { ok: true, task: resolved, status: result.status };
  }
  if (result.status === "source_not_ready" && result.sourceTask?.id && taskMediaKind(result.sourceTask) === "images") {
    recordEvent({
      type: "queue.continuity_ref.wait_source",
      taskId: task.id,
      sourceTaskId: result.sourceTask.id,
      sourceStatus: result.sourceTask.status || ""
    });
    if (result.sourceTask.status === TaskStatus.generating && tabId) {
      await waitForImageTaskOutputs(result.sourceTask, tabId);
      await persistQueueState();
    } else {
      await sleep(1000);
    }
    return { ok: false, waiting: true, status: result.status, sourceTask: result.sourceTask };
  }
  const errorByStatus = {
    missing_source: "CONTINUITY_SOURCE_TASK_MISSING",
    source_failed: "CONTINUITY_SOURCE_TASK_FAILED",
    source_output_missing: "CONTINUITY_SOURCE_OUTPUT_MISSING"
  };
  const error = errorByStatus[result.status] || "CONTINUITY_REF_NOT_READY";
  const blocked = scheduler.markBlocked(task.id, error);
  recordEvent({
    type: "queue.continuity_ref.blocked",
    taskId: task.id,
    sourceTaskId: result.sourceTask?.id || "",
    status: result.status,
    error
  });
  await persistQueueState();
  return { ok: false, blocked: true, task: blocked, status: result.status, error };
}

async function runQueueUntilIdle(preferredTabId) {
  await queueReady;
  if (runtimeState.queueRunning) return;
  const runToken = Number(runtimeState.queueRunToken || 0) + 1;
  runtimeState.queueRunToken = runToken;
  runtimeState.queueRunning = true;
  resetFlowSessionRecoveryForRun(runToken);
  resetFlowRendererCrashRecoveryForRun(runToken);
  const isActiveRun = () => runtimeState.queueRunning && runtimeState.queueRunToken === runToken;
  recordEvent({ type: "queue.start", runToken });
  try {
    const tab = await findFlowTab(preferredTabId);
    if (!tab?.id) throw new Error("flow_tab_not_found");
    const executor = createExecutorForTab(tab.id);

    while (isActiveRun()) {
      const next = scheduler.nextPendingTask();
      if (!next) {
        const mergedCompletedRepairs = await mergeCompletedVideoRepairTasks("queue_idle_completed_repairs");
        if (mergedCompletedRepairs > 0) {
          await persistQueueState();
          continue;
        }
        const completedTasksNeedingDownload = ledger.listTasks()
          .filter((task) => shouldAttemptAutoDownloadForTask(task))
          .map((task) => task.id);
        if (completedTasksNeedingDownload.length) {
          await autoDownloadCompletedTasks(completedTasksNeedingDownload, "queue_idle_complete");
          await persistQueueState();
          continue;
        }
        const activeVideoTask = ledger.listTasks().find((task) => task.status === TaskStatus.generating && taskMediaKind(task) === "videos");
        if (activeVideoTask) {
          if (activeVideoTask.generationFailureNeedsFlowReload === true) {
            await recoverGenerationFailureRetryTask(activeVideoTask, tab.id);
            await persistQueueState();
            continue;
          }
          const settledVideo = await waitForVideoTaskOutputs(activeVideoTask, tab.id);
          const usageRecord = await recordPromptUsageForTask(settledVideo || activeVideoTask, "after_video_settle");
          if (!usageRecord.ok) {
            await blockPendingQueueAfterUsageRecordingFailure(usageRecord.error || "usage_recording_failed");
            break;
          }
          if (!isActiveRun()) break;
          recordEvent({
            type: "queue.video_settle.done",
            taskId: settledVideo?.id || activeVideoTask.id,
            status: settledVideo?.status || activeVideoTask.status,
            foundVideos: settledVideo?.foundVideos || 0,
            expectedVideos: settledVideo?.expectedVideos || activeVideoTask.expectedVideos || activeVideoTask.repeatCount || 1
          });
          if (settledVideo?.retryOfTaskId) {
            const mergedParent = await mergeVideoRepairTaskIntoParent(settledVideo);
            if (mergedParent?.partialFailure === true) {
              await appendVideoRepairTask(mergedParent, "video_repair_still_partial");
            }
          } else {
            await appendVideoRepairTask(settledVideo, "video_settle_partial");
          }
          await persistQueueState();
          if (settledVideo?.status === TaskStatus.generating) {
            await sleep(3000);
            continue;
          }
          continue;
        }
        const activeImageTask = ledger.listTasks().find((task) => task.status === TaskStatus.generating && taskMediaKind(task) === "images");
        if (!activeImageTask) break;
        const settled = await waitForImageTaskOutputs(activeImageTask, tab.id);
        const usageRecord = await recordPromptUsageForTask(settled || activeImageTask, "after_image_settle");
        if (!usageRecord.ok) {
          await blockPendingQueueAfterUsageRecordingFailure(usageRecord.error || "usage_recording_failed");
          break;
        }
        if (!isActiveRun()) break;
        recordEvent({
          type: "queue.image_settle.done",
          taskId: settled?.id || activeImageTask.id,
          status: settled?.status || activeImageTask.status,
          foundImages: settled?.foundImages || 0,
          expectedImages: settled?.expectedImages || activeImageTask.expectedImages || activeImageTask.repeatCount || 1
        });
        await persistQueueState();
        if (settled?.status === TaskStatus.generating) {
          await sleep(3000);
          continue;
        }
        continue;
      }
      try {
        const activeBeforeComposerRetry = activeVideoTaskBeforeComposerRetry(next, ledger.listTasks());
        if (activeBeforeComposerRetry) {
          if (activeBeforeComposerRetry.generationFailureNeedsFlowReload === true) {
            await recoverGenerationFailureRetryTask(activeBeforeComposerRetry, tab.id);
            await persistQueueState();
            continue;
          }
          const settledVideo = await waitForVideoTaskOutputs(activeBeforeComposerRetry, tab.id);
          if (!isActiveRun()) break;
          const latestNext = ledger.getTask(next.id) || next;
          const composerRetryWaitCount = Math.max(0, Number(latestNext.composerRetryWaitCount || 0) || 0) + 1;
          ledger.updateTask(next.id, {
            composerRetryWaitCount,
            composerRetryWaitedAt: new Date().toISOString()
          });
          recordEvent({
            type: "queue.video_wait_before_composer_retry",
            taskId: next.id,
            activeTaskId: settledVideo?.id || activeBeforeComposerRetry.id,
            status: settledVideo?.status || activeBeforeComposerRetry.status,
            foundVideos: settledVideo?.foundVideos || 0,
            expectedVideos: settledVideo?.expectedVideos || activeBeforeComposerRetry.expectedVideos || activeBeforeComposerRetry.repeatCount || 1,
            lastError: next.lastError || "",
            composerRetryWaitCount
          });
          if (settledVideo?.retryOfTaskId) {
            const mergedParent = await mergeVideoRepairTaskIntoParent(settledVideo);
            if (mergedParent?.partialFailure === true) {
              await appendVideoRepairTask(mergedParent, "composer_retry_wait_repair_still_partial");
            }
          } else {
            await appendVideoRepairTask(settledVideo, "composer_retry_wait_video_settle_partial");
          }
          await persistQueueState();
          if (settledVideo?.status === TaskStatus.generating) {
            await sleep(3000);
          }
          continue;
        }
        const continuity = await resolveContinuityChainForTask(next, tab.id);
        if (continuity.waiting) continue;
        if (continuity.blocked) continue;
        const nextTask = continuity.task || ledger.getTask(next.id) || next;
        await ensureTaskProjectId(nextTask, tab.id);
        await persistQueueState();
        if (!isActiveRun()) break;
        let taskToRun = ledger.getTask(nextTask.id) || nextTask;
        const access = await validateQueueStartAccess(taskToRun);
        if (!access.allowed) {
          const blockReason = access.message || access.reason || access.error || "license_required";
          scheduler.markBlocked(taskToRun.id, blockReason);
          const auth = await updateAuthState();
          recordEvent({
            type: "license.queue_start.task_blocked",
            taskId: taskToRun.id,
            mode: taskToRun.mode || "",
            reason: access.reason || access.error || "license_required",
            message: access.message || "",
            billingHealth: access.billingHealth || "",
            remaining: Number(access.usage?.remaining || auth?.license?.remaining || 0)
          });
          await persistQueueState();
          break;
        }
        taskToRun = await recoverGenerationFailureRetryTask(taskToRun, tab.id);
        if (!isActiveRun()) break;
        const rendererCrash = await detectFlowRendererCrashForTask(taskToRun, tab.id, "before_submit");
        if (rendererCrash?.crashed) {
          const blocked = await markFlowRendererCrashDetected(taskToRun, tab.id, rendererCrash, "before_submit");
          if (isRecoverableGlobalTask(blocked)) {
            const recovery = await recoverGlobalQueueFailure(blocked, tab.id);
            if (recovery.ok) continue;
            const latest = recovery.blocked || ledger.getTask(blocked.id) || blocked;
            if (await skipFailedTaskForAutoRetry(latest, "flow_renderer_crash_unresolved")) continue;
          }
          break;
        }
        const domFrontendReady = await waitForDomFrontendReadyBeforeTask(taskToRun, tab.id, "before_submit");
        if (!isActiveRun()) break;
        if (domFrontendReady?.ok === false) {
          const error = domFrontendReady.error || "DOM_FRONTEND_NOT_READY";
          const blocked = scheduler.markBlocked(taskToRun.id, error);
          recordEvent({
            type: "queue.dom_frontend_settle.blocked",
            taskId: taskToRun.id,
            mode: taskToRun.mode || "",
            error,
            elapsedMs: domFrontendReady.elapsedMs || 0,
            reloaded: Boolean(domFrontendReady.reloaded),
            failureClass: blocked?.failureClass || "",
            failureScope: blocked?.failureScope || ""
          });
          await persistQueueState();
          if (isRecoverableGlobalTask(blocked)) {
            const recovery = await recoverGlobalQueueFailure(blocked, tab.id);
            if (recovery.ok) continue;
            const latest = recovery.blocked || ledger.getTask(blocked.id) || blocked;
            if (await skipFailedTaskForAutoRetry(latest, "global_recovery_exhausted")) continue;
          }
          break;
        }
        const submitOnlyVideos = taskMediaKind(taskToRun) === "videos";
        let task = await executor.runTask(taskToRun.id, {
          submitOnlyVideos,
          allowStatusFeedSubmitObservation: submitOnlyVideos
        });
        let usageRecord = await recordPromptUsageForTask(task, "after_submit");
        if (!usageRecord.ok) {
          await blockPendingQueueAfterUsageRecordingFailure(usageRecord.error || "usage_recording_failed");
          break;
        }
        if (!isActiveRun()) break;
        if (!submitOnlyVideos && taskMediaKind(task) === "images" && task?.status !== TaskStatus.generating && task?.status !== TaskStatus.complete) {
          task = await recoverImageTaskAfterSubmitFailure(task, tab.id, "after_submit_result");
          usageRecord = await recordPromptUsageForTask(task, "after_submit_recovery");
          if (!usageRecord.ok) {
            await blockPendingQueueAfterUsageRecordingFailure(usageRecord.error || "usage_recording_failed");
            break;
          }
        }
        if (!isActiveRun()) break;
        task = submitOnlyVideos ? task : await waitForImageTaskOutputs(task, tab.id);
        if (!isActiveRun()) break;
        usageRecord = await recordPromptUsageForTask(task, "after_settle");
        if (!usageRecord.ok) {
          await blockPendingQueueAfterUsageRecordingFailure(usageRecord.error || "usage_recording_failed");
          break;
        }
        recordEvent({
          type: "queue.task.done",
          taskId: task?.id || next.id,
          status: task?.status || "unknown",
          failureClass: task?.failureClass || "",
          failureScope: task?.failureScope || "",
          mediaIds: task?.mediaIds || []
        });
        await markFlowSessionRecoverySuccessIfNeeded(task, tab.id);
        if (task?.status === TaskStatus.complete) {
          if (task.retryOfTaskId) {
            task = await mergeVideoRepairTaskIntoParent(task) || task;
            if (task?.partialFailure === true) {
              await appendVideoRepairTask(task, "video_repair_still_partial");
            }
          } else {
            await appendVideoRepairTask(task, "queue_task_complete_partial");
          }
          await autoDownloadCompletedTasks([task.id], "queue_complete");
        }
        if (taskSignalsApiFirstDomAvailable(task)) {
          recordEvent({
            type: "queue.api_first_dom_available.pause_for_confirmation",
            taskId: task.id,
            mode: task.mode || "",
            model: task.model || "",
            pending: ledger.listTasks().filter((candidate) => candidate.status === TaskStatus.pending).length,
            refsReusedForDomVerification: task.refsReusedForDomVerification === true
          });
          await persistQueueState();
          break;
        }
        await persistQueueState();
        const pendingAfterSubmit = scheduler.nextPendingTask();
        if (submitOnlyVideos && task?.status === TaskStatus.generating && pendingAfterSubmit) {
          const waitMs = generationSubmitWaitMs(task);
          recordEvent({
            type: "queue.video_inter_submit_wait",
            taskId: task.id,
            waitMs,
            minInitialWaitTime: Number(task.minInitialWaitTime || 0),
            maxInitialWaitTime: Number(task.maxInitialWaitTime || 0)
          });
          if (waitMs > 0) await sleep(waitMs);
        } else if (submitOnlyVideos && task?.status === TaskStatus.generating) {
          recordEvent({
            type: "queue.video_submit_phase_complete",
            taskId: task.id,
            reason: "keep_debugger_until_queue_finish"
          });
        }
        if (isRecoverableGlobalTask(task)) {
          const recovery = await recoverGlobalQueueFailure(task, tab.id);
          if (!recovery.ok) {
            const latest = recovery.blocked || ledger.getTask(task.id) || task;
            if (await skipFailedTaskForAutoRetry(latest, "global_recovery_exhausted")) continue;
            break;
          }
          continue;
        }
        if (["failed", "blocked"].includes(task?.status) && task?.failureScope === "global") {
          if (await skipFailedTaskForAutoRetry(task, "global_block")) continue;
          recordEvent({
            type: "queue.global_block",
            taskId: task.id,
            failureClass: task.failureClass || "",
            healAction: task.healAction || "",
            lastError: task.lastError || ""
          });
          break;
        }
        if (task?.status === "pending") {
          await sleep(Math.min(30000, Math.max(3000, Number(task.attempts || 1) * 3000)));
        }
      } catch (error) {
        if (!isActiveRun() || !ledger.getTask(next.id)) {
          recordEvent({
            type: "queue.stale_task_ignored",
            taskId: next.id,
            runToken,
            activeRunToken: runtimeState.queueRunToken,
            error: String(error?.message || error || "stale_queue_task_failed")
          });
          break;
        }
        const task = scheduler.markBlocked(next.id, error);
        await persistQueueState();
        recordEvent({
          type: "queue.task.error",
          taskId: next.id,
          error: String(error?.message || error || "queue_task_failed"),
          failureClass: task?.failureClass || "",
          failureScope: task?.failureScope || "",
          healAction: task?.healAction || ""
        });
        if (isRecoverableGlobalTask(task)) {
          const recovery = await recoverGlobalQueueFailure(task, tab.id);
          if (recovery.ok) continue;
          const latest = recovery.blocked || ledger.getTask(task.id) || task;
          if (await skipFailedTaskForAutoRetry(latest, "global_recovery_exhausted")) continue;
        }
        if (task?.failureScope === "global") break;
      }
    }
  } catch (error) {
    if (runtimeState.queueRunToken === runToken) {
      recordEvent({
        type: "queue.error",
        runToken,
        error: String(error?.message || error || "queue_failed")
      });
    } else {
      recordEvent({
        type: "queue.stale_run_error_ignored",
        runToken,
        activeRunToken: runtimeState.queueRunToken,
        error: String(error?.message || error || "queue_failed")
      });
    }
  } finally {
    await releaseDebuggerSessions("queue_finished", recordDebuggerTrace);
    if (runtimeState.queueRunToken === runToken) {
      runtimeState.queueRunning = false;
      await persistQueueState();
      recordEvent({ type: "queue.stop", runToken });
    } else {
      recordEvent({
        type: "queue.stale_run_exit",
        runToken,
        activeRunToken: runtimeState.queueRunToken
      });
    }
  }
}

function generationSubmitWaitMs(task = {}) {
  const min = Math.max(0, Number(task.minInitialWaitTime || task.generationWaitMin || 0) || 0);
  const max = Math.max(min, Number(task.maxInitialWaitTime || task.generationWaitMax || min) || min);
  if (!max) return 0;
  const seconds = min + Math.random() * (max - min);
  return Math.round(seconds * 1000);
}

function videoMissingOutputCount(task = {}) {
  if (taskMediaKind(task) !== "videos") return 0;
  const expected = Math.max(1, Number(task.expectedVideos || task.repeatCount || 1) || 1);
  const found = Math.max(
    Number(task.foundVideos || 0) || 0,
    Array.isArray(task.outputMediaIds) ? task.outputMediaIds.length : 0,
    Array.isArray(task.outputs) ? task.outputs.filter((output) => output?.mediaId).length : 0
  );
  return Math.max(0, expected - found);
}

function shouldAppendVideoRepairTask(task = {}) {
  if (!task?.id || taskMediaKind(task) !== "videos") return false;
  if (task.status !== TaskStatus.complete) return false;
  if (task.retryOfTaskId) return false;
  const missing = videoMissingOutputCount(task);
  if (!missing) return false;
  const maxAttempts = Math.max(0, Math.min(3, Number(task.partialRetryMax ?? task.generationRetryMax ?? 3) || 3));
  const attempts = Number(task.partialRetryAttempts || 0) || 0;
  if (attempts >= maxAttempts) return false;
  return !ledger.listTasks().some((candidate) => (
    candidate?.retryOfTaskId === task.id &&
    candidate?.generationRepair === true &&
    ![TaskStatus.complete, TaskStatus.failed, TaskStatus.blocked].includes(candidate.status)
  ));
}

async function appendVideoRepairTask(task = {}, reason = "partial_video_outputs") {
  if (!shouldAppendVideoRepairTask(task)) return null;
  const missing = videoMissingOutputCount(task);
  if (!missing) return null;
  const attempt = Number(task.partialRetryAttempts || 0) + 1;
  const repairId = crypto.randomUUID();
  ledger.updateTask(task.id, {
    partialRetryAttempts: attempt,
    missingOutputCount: missing,
    retryStatus: "queued"
  });
  ledger.addTask({
    ...task,
    id: repairId,
    status: TaskStatus.pending,
    attempts: 0,
    retryOfTaskId: task.id,
    generationRepair: true,
    repairReason: reason,
    repairAttempt: attempt,
    repairMissingCount: missing,
    repeatCount: missing,
    expectedVideos: missing,
    foundVideos: 0,
    mediaIds: [],
    outputMediaIds: [],
    outputs: [],
    statusRows: [],
    submitOutputRows: [],
    events: [],
    downloadedMediaIds: [],
    skippedDownloadMediaIds: [],
    downloadErrorMediaIds: [],
    downloadedCount: 0,
    completedAt: "",
    partialFailure: false,
    failedOutputCount: 0,
    failedOutputMediaIds: [],
    lastError: "",
    failureClass: "",
    healAction: "",
    failureScope: "",
    download: task.download && typeof task.download === "object"
      ? { ...task.download, enabled: false }
      : task.download
  });
  await persistQueueState();
  recordEvent({
    type: "queue.video_repair.queued",
    parentTaskId: task.id,
    repairTaskId: repairId,
    missing,
    attempt,
    reason
  });
  return ledger.getTask(repairId);
}

async function mergeVideoRepairTaskIntoParent(task = {}) {
  if (!task?.retryOfTaskId || taskMediaKind(task) !== "videos" || task.status !== TaskStatus.complete) return null;
  const parent = ledger.getTask(task.retryOfTaskId);
  if (!parent) return null;
  const expected = Math.max(1, Number(parent.expectedVideos || parent.repeatCount || 1) || 1);
  const parentOutputs = Array.isArray(parent.outputs) ? parent.outputs.filter((output) => output?.mediaId) : [];
  const repairOutputs = Array.isArray(task.outputs) ? task.outputs.filter((output) => output?.mediaId) : [];
  const seen = new Set(parentOutputs.map((output) => String(output.mediaId || "").trim()).filter(Boolean));
  const mergedOutputs = [...parentOutputs];
  const duplicateRepairMediaIds = [];
  for (const output of repairOutputs) {
    const mediaId = String(output.mediaId || "").trim();
    if (!mediaId) continue;
    if (seen.has(mediaId)) {
      duplicateRepairMediaIds.push(mediaId);
      continue;
    }
    if (mergedOutputs.length >= expected) continue;
    seen.add(mediaId);
    mergedOutputs.push({
      ...output,
      id: `${parent.id}:${mediaId}`,
      prompt: parent.prompt || output.prompt || "",
      mediaIndex: mergedOutputs.length,
      source: output.source || "generation_repair"
    });
  }
  const parentReady = new Set((parent.videoDownloadReadyMediaIds || []).map(compactString).filter(Boolean));
  (task.videoDownloadReadyMediaIds || []).map(compactString).filter(Boolean).forEach((id) => parentReady.add(id));
  const parentDownloaded = new Set((parent.downloadedMediaIds || []).map(compactString).filter(Boolean));
  (task.downloadedMediaIds || []).map(compactString).filter(Boolean).forEach((id) => {
    parentDownloaded.add(id);
    parentReady.add(id);
  });
  const repairOutputById = new Map(repairOutputs.map((output) => [compactString(output.mediaId), output]));
  for (const mediaId of parentDownloaded) {
    if (!mediaId || seen.has(mediaId) || mergedOutputs.length >= expected) continue;
    const output = repairOutputById.get(mediaId) || {};
    seen.add(mediaId);
    mergedOutputs.push({
      ...output,
      id: `${parent.id}:${mediaId}`,
      mediaId,
      mediaUrl: output.mediaUrl || buildMediaRedirectUrl({ mediaId }),
      thumbnailUrl: output.thumbnailUrl || buildMediaThumbnailUrl({ mediaId }),
      prompt: parent.prompt || output.prompt || "",
      kind: "videos",
      status: output.status || "complete",
      downloadStatus: "downloaded",
      downloadFilename: output.downloadFilename || "",
      mediaIndex: mergedOutputs.length,
      source: output.source || "generation_repair_download"
    });
  }
  const parentSkipped = new Set((parent.skippedDownloadMediaIds || []).map(compactString).filter(Boolean));
  (task.skippedDownloadMediaIds || []).map(compactString).filter(Boolean).forEach((id) => {
    if (!parentDownloaded.has(id)) parentSkipped.add(id);
  });
  const parentDownloadErrors = new Set((parent.downloadErrorMediaIds || []).map(compactString).filter(Boolean));
  (task.downloadErrorMediaIds || []).map(compactString).filter(Boolean).forEach((id) => {
    if (!parentDownloaded.has(id)) parentDownloadErrors.add(id);
  });
  const foundVideos = mergedOutputs.length;
  const stillPartial = foundVideos < expected;
  const patch = {
    outputs: mergedOutputs,
    outputMediaIds: mergedOutputs.map((output) => output.mediaId),
    mediaIds: mergedOutputs.map((output) => output.mediaId).map(compactString).filter(Boolean),
    foundVideos,
    expectedVideos: expected,
    failedOutputCount: Math.max(0, expected - foundVideos),
    missingOutputCount: Math.max(0, expected - foundVideos),
    partialFailure: stillPartial,
    retryStatus: foundVideos >= expected
      ? "repaired"
      : (duplicateRepairMediaIds.length ? "duplicate_repair_output" : "partial_repaired"),
    duplicateRepairMediaIds,
    videoDownloadReadyMediaIds: [...parentReady],
    downloadedMediaIds: [...parentDownloaded],
    skippedDownloadMediaIds: [...parentSkipped],
    downloadErrorMediaIds: [...parentDownloadErrors],
    downloadedCount: parentDownloaded.size,
    skippedDownloadCount: parentSkipped.size,
    lastError: stillPartial ? `PARTIAL_VIDEO_OUTPUTS:${foundVideos}/${expected}` : "",
    failureClass: stillPartial ? "partial_video_outputs" : "",
    healAction: "",
    failureScope: stillPartial ? "task" : ""
  };
  const updated = ledger.updateTask(parent.id, patch);
  ledger.updateTask(task.id, {
    hiddenFromLiveQueue: true,
    hiddenFromGallery: true,
    mergedIntoTaskId: parent.id,
    retryStatus: "merged"
  });
  await persistQueueState();
  recordEvent({
    type: "queue.video_repair.merged",
    parentTaskId: parent.id,
    repairTaskId: task.id,
    foundVideos,
    expectedVideos: expected,
    stillMissing: Math.max(0, expected - foundVideos),
    duplicateRepairMediaIds
  });
  await autoDownloadCompletedTasks([parent.id], "video_repair_merge");
  return updated;
}

async function mergeCompletedVideoRepairTasks(reason = "completed_video_repair_drain") {
  let merged = 0;
  const repairs = ledger.listTasks().filter((task) => (
    task?.retryOfTaskId &&
    task?.generationRepair === true &&
    taskMediaKind(task) === "videos" &&
    task.status === TaskStatus.complete &&
    task.hiddenFromLiveQueue !== true &&
    !task.mergedIntoTaskId
  ));
  for (const repair of repairs) {
    const parent = await mergeVideoRepairTaskIntoParent(repair);
    if (parent) {
      merged += 1;
      recordEvent({
        type: "queue.video_repair.drain_merged",
        reason,
        parentTaskId: parent.id,
        repairTaskId: repair.id,
        stillMissing: videoMissingOutputCount(parent)
      });
      if (parent.partialFailure === true) {
        await appendVideoRepairTask(parent, "video_repair_still_partial");
      }
    }
  }
  return merged;
}

async function updateAuthState(data = null) {
  const summary = await licenseClient.authSummary(data);
  runtimeState.auth = summary;
  return summary;
}

function featureContextForTask(task = {}) {
  const download = task.download && typeof task.download === "object" ? task.download : {};
  return {
    task_count: ledger.listTasks().length,
    task_id: String(task.id || ""),
    mode: String(task.mode || ""),
    model: String(task.model || ""),
    aspect_ratio: String(task.aspectRatio || ""),
    repeat_count: Number(task.repeatCount || 1),
    video_length: String(task.videoLength || task.videoDurationSeconds || ""),
    submit_path: String(task.submitPath || ""),
    auto_download: download.enabled === true,
    download_resolution: String(download.resolution || ""),
    download_folder: String(download.folder || "")
  };
}

async function cachedActiveProAccess() {
  return licenseClient.getCachedActiveProLicense({ maxAgeMs: 60 * 60 * 1000 });
}

async function refreshCachedProAccessForQueueStart(reason) {
  let cachedPro = await cachedActiveProAccess();
  if (cachedPro.ok) return cachedPro;
  for (let attempt = 0; attempt < 2 && !cachedPro.ok; attempt += 1) {
    if (attempt > 0 && reason === "server_unavailable") await sleep(750);
    await updateAuthState().catch((error) => {
      recordEvent({
        type: "license.cached_pro_refresh_error",
        reason,
        attempt: attempt + 1,
        error: String(error?.message || error || "auth_refresh_failed")
      });
      return null;
    });
    cachedPro = await cachedActiveProAccess();
  }
  return cachedPro;
}

async function validateQueueStartAccess(task) {
  try {
    const auth = await updateAuthState();
    let authAccess = queueStartAccessFromAuthSummary(auth);
    if (!authAccess.allowed && queueStartAccessNeedsFreshBackend(authAccess)) {
      recordEvent({
        type: "license.queue_start.force_refresh.start",
        taskId: task?.id || "",
        mode: task?.mode || "",
        reason: authAccess.reason || "",
        billingHealth: authAccess.billingHealth || ""
      });
      authAccess = await refreshQueueStartAccessBeforeBlock(authAccess, async () => {
        const data = await licenseClient.refreshLicense();
        return updateAuthState(data);
      });
      recordEvent({
        type: "license.queue_start.force_refresh.result",
        taskId: task?.id || "",
        mode: task?.mode || "",
        allowed: authAccess.allowed,
        reason: authAccess.reason || "",
        billingHealth: authAccess.billingHealth || "",
        subscriptionStatus: authAccess.subscriptionStatus || ""
      });
    }
    if (authAccess.allowed || ["not_signed_in", "daily_limit_reached", "verify_subscription_needed"].includes(authAccess.reason)) {
      recordEvent({
        type: "license.queue_start.auth_summary",
        taskId: task?.id || "",
        mode: task?.mode || "",
        allowed: authAccess.allowed,
        reason: authAccess.reason || "",
        source: authAccess.source || "",
        tier: authAccess.tier || "",
        remaining: Number(authAccess.usage?.remaining || 0),
        billingHealth: authAccess.billingHealth || "",
        subscriptionStatus: authAccess.subscriptionStatus || ""
      });
      return authAccess;
    }
  } catch (error) {
    recordEvent({
      type: "license.queue_start.auth_summary_error",
      taskId: task?.id || "",
      mode: task?.mode || "",
      error: String(error?.message || error || "auth_summary_failed")
    });
  }

  const access = await licenseClient.validateFeatureAccess("queue_start", featureContextForTask(task));
  const reason = String(access?.reason || access?.error || "").trim();
  let cachedPro = { ok: false, reason: "not_checked" };
  if (!access.allowed && ["server_unavailable", "missing_feature_decision"].includes(reason)) {
    cachedPro = await refreshCachedProAccessForQueueStart(reason);
  }
  if (!access.allowed && ["server_unavailable", "missing_feature_decision"].includes(reason) && cachedPro.ok) {
    recordEvent({
      type: "license.cached_pro_allow",
      reason,
      taskId: task?.id || "",
      mode: task?.mode || "",
      cacheAgeMs: cachedPro.ageMs
    });
    return {
      ...access,
      allowed: true,
      source: "cached_pro",
      reason: "cached_active_pro"
    };
  }
  return access;
}

async function recordPromptUsageForTask(task = {}, reason = "queue_submit") {
  const current = ledger.getTask(task?.id) || task || {};
  if (!shouldRecordPromptUsageForTask(current)) {
    return { ok: true, skipped: true, reason: "not_recordable" };
  }
  const promptCount = promptUsageCountForTask(current);
  const idempotencyKey = promptUsageIdempotencyKey(current);
  ledger.updateTask(current.id, {
    usageRecordPendingAt: new Date().toISOString(),
    usageRecordReason: reason,
    usageRecordCount: promptCount,
    usageRecordKey: idempotencyKey
  });
  recordEvent({
    type: "license.prompt_usage.record.start",
    taskId: current.id,
    mode: current.mode || "",
    submitPath: current.submitPath || current.submitPathPreference || "",
    promptCount,
    idempotencyKey,
    reason
  });
  const result = await licenseClient.recordPromptUsage({
    promptCount,
    taskId: current.id,
    mode: current.mode || "",
    submitPath: current.submitPath || current.submitPathPreference || "",
    source: reason,
    idempotencyKey
  });
  if (!result.ok) {
    const error = result.error || result.reason || "usage_recording_failed";
    ledger.updateTask(current.id, {
      usageRecordPendingAt: "",
      usageRecordFailedAt: new Date().toISOString(),
      usageRecordError: error
    });
    recordEvent({
      type: "license.prompt_usage.record.failed",
      taskId: current.id,
      mode: current.mode || "",
      promptCount,
      idempotencyKey,
      error
    });
    await persistQueueState();
    return { ok: false, error };
  }

  ledger.updateTask(current.id, {
    usageRecordedAt: new Date().toISOString(),
    usageRecordPendingAt: "",
    usageRecordError: "",
    usageRecordCount: promptCount,
    usageRecordKey: idempotencyKey
  });
  const auth = await updateAuthState(result.license || null);
  recordEvent({
    type: "license.prompt_usage.record.ok",
    taskId: current.id,
    mode: current.mode || "",
    promptCount,
    idempotencyKey,
    tier: auth?.tier || "",
    used: Number(auth?.license?.prompts_today || auth?.license?.promptsToday || 0),
    limit: Number(auth?.license?.prompt_limit || auth?.license?.promptLimit || 0)
  });
  await persistQueueState();
  return { ok: true, auth };
}

async function blockPendingQueueAfterUsageRecordingFailure(error = "usage_recording_failed") {
  const pending = scheduler.nextPendingTask();
  if (!pending) return null;
  const blocked = scheduler.markBlocked(pending.id, error);
  recordEvent({
    type: "license.prompt_usage.queue_blocked",
    taskId: pending.id,
    error,
    failureClass: blocked?.failureClass || "",
    failureScope: blocked?.failureScope || ""
  });
  await persistQueueState();
  return blocked;
}

async function handleAuthCommand(payload = {}) {
  captureAuthEnvironment(payload);
  const action = String(payload.action || "state").trim();
  if (action === "state" || action === "init") {
    const data = await licenseClient.initLicense({ forceFresh: payload.forceFresh === true });
    return updateAuthState(data);
  }
  if (action === "send_code") {
    await licenseClient.signInWithMagicLink(payload.email);
    return { ...(await updateAuthState()), codeSent: true };
  }
  if (action === "verify_code") {
    await licenseClient.verifyOtpToken(payload.email, payload.code);
    const data = await licenseClient.initLicense({ forceFresh: true });
    return { ...(await updateAuthState(data)), verified: true };
  }
  if (action === "sign_out") {
    await licenseClient.signOut();
    return updateAuthState();
  }
  if (action === "refresh") {
    const data = await licenseClient.refreshLicense();
    return updateAuthState(data);
  }
  if (action === "upgrade") {
    const result = await licenseClient.startUpgradeFlow({ source: "rebuild_sidepanel" });
    return { ...(await updateAuthState()), upgrade: result };
  }
  if (action === "manage_subscription") {
    const result = await licenseClient.openManageSubscription();
    return { ...(await updateAuthState()), portal: result };
  }
  if (action === "runtime_capabilities") {
    const capabilities = await licenseClient.fetchRuntimeCapabilities({
      force: payload.force === true,
      requestedCapabilities: payload.requestedCapabilities || []
    });
    return { ...(await updateAuthState()), capabilities };
  }
  throw new Error(`unknown_auth_action:${action}`);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isAutoFlowRebuildMessage(message)) return false;

  if (![MessageType.BridgeHealth, MessageType.AuthCommand].includes(message.type)) {
    recordEvent({
      type: message.type,
      tabId: sender?.tab?.id || null
    });
  }

  if (message.type === MessageType.BridgeHealth) {
    (async () => {
      await queueReady;
      const healthPayload = message.payload || {};
      const senderBinding = sender?.tab?.id && isFlowToolUrl(sender.tab.url || "")
        ? promoteFlowTabBinding(sender.tab, healthPayload, "bridge_health")
        : null;
      const includeGallery = healthPayload.lightweight !== true && healthPayload.includeGallery !== false;
      const hintedTabId = Number(healthPayload.tabId || healthPayload.activeTabId || runtimeState.activeTabId || 0) || undefined;
      const tab = senderBinding?.activeTabId
        ? sender.tab
        : await findFlowTab(hintedTabId).catch(() => null);
      const binding = promoteFlowTabBinding(tab || {}, healthPayload, "bridge_health_lookup")
        || senderBinding
        || runtimeBindingPayload(tab || {}, healthPayload);
      const projectId = binding.projectId || projectIdFromUrl(tab?.url || "");
      if (projectId && runtimeState.lastGalleryProjectId && runtimeState.lastGalleryProjectId !== projectId) {
        runtimeState.lastGalleryItems = [];
      }
      if (projectId) runtimeState.lastGalleryProjectId = projectId;
      const tabProjectConnected = Boolean(binding.activeTabId && projectId);
      const bridgeProbe = tabProjectConnected
        ? await ensureFlowBridge(binding.activeTabId).catch((error) => ({
          ok: false,
          error: String(error?.message || error || "flow_bridge_not_ready")
        }))
        : { ok: false, error: binding.activeTabId ? "missing_project_id" : "flow_tab_not_found" };
      const bridgeFields = bridgeRuntimeFields(bridgeProbe, tabProjectConnected);
      const runtimeConnected = tabProjectConnected && bridgeFields.flowPageBlocked !== true;
      runtimeState.bridgeHealthy = bridgeFields.bridgeHealthy;
      const payload = {
        ok: true,
        queue: queueState(),
        runtime: {
          connected: runtimeConnected,
          activeTabId: binding.activeTabId || null,
          projectId,
          pageUrl: binding.pageUrl || tab?.url || "",
          pageTitle: binding.pageTitle || tab?.title || "",
          ...bridgeFields,
          error: bridgeFields.flowPageError || (binding.activeTabId ? (projectId ? null : "missing_project_id") : "flow_tab_not_found"),
          lastSyncAt: new Date().toISOString()
        },
        queueRunning: runtimeState.queueRunning,
        auth: runtimeState.auth,
        events: runtimeState.events.slice(-20)
      };
      if (includeGallery) {
        payload.gallery = galleryState(
          runtimeState.lastGalleryItems || [],
          runtimeState.lastGalleryItems?.length ? "flow-dom+queue-ledger" : "queue-ledger",
          projectId || runtimeState.lastGalleryProjectId
        );
      }
      sendResponse(createMessage(MessageType.BridgeHealth, payload));
    })();
    return true;
  }

  if (message.type === MessageType.AuthCommand) {
    (async () => {
      try {
        const auth = await handleAuthCommand(message.payload || {});
        sendResponse(createMessage(MessageType.AuthState, {
          ok: true,
          auth
        }));
      } catch (error) {
        sendResponse(createMessage(MessageType.AuthState, {
          ok: false,
          error: String(error?.message || error || "auth_command_failed"),
          auth: runtimeState.auth
        }));
      }
    })();
    return true;
  }

  if (message.type === MessageType.PageCommand) {
    (async () => {
      const action = String(message.payload?.action || "");
      if (isMaintenanceAction(action)) {
        const result = await runBackgroundMaintenanceAction(action, message.payload || {});
        sendResponse(createMessage(MessageType.PageCommandResult, {
          ok: result.ok !== false,
          result
        }));
        return;
      }
      const tab = await findFlowTab(Number(message.payload?.tabId || sender?.tab?.id || runtimeState.activeTabId || 0) || undefined);
      if (!tab?.id) {
        sendResponse(createMessage(MessageType.PageCommandResult, {
          ok: false,
          error: "flow_tab_not_found"
        }));
        return;
      }
      const bridge = await ensureFlowBridge(tab.id);
      if (!bridge?.ok) {
        sendResponse(createMessage(MessageType.PageCommandResult, {
          ok: false,
          tabId: tab.id,
          url: tab.url,
          error: bridge?.error || "flow_bridge_not_ready"
        }));
        return;
      }
      const result = await sendPageCommand(message.payload || {}, tab.id);
      promoteFlowTabBinding(tab, { projectId: result?.projectId, href: result?.href || tab.url }, `page_command:${action || "unknown"}`);
      sendResponse(createMessage(MessageType.PageCommandResult, {
        ok: result?.ok !== false,
        tabId: tab.id,
        url: tab.url,
        result
      }));
    })();
    return true;
  }

  if (message.type === MessageType.PageEvent) {
    const event = message.payload || {};
    const promoted = sender?.tab?.id
      ? promoteFlowTabBinding(sender.tab, event, event.kind || event.type || "page_event")
      : null;
    if (promoted) {
      recordEvent({
        type: "runtime.flow_tab.event_seen",
        tabId: promoted.activeTabId,
        projectId: promoted.projectId,
        kind: event.kind || event.type || ""
      });
    }
    if (event.type === "flow_recaptcha") {
      recordEvent({
        type: "flow.recaptcha",
        action: event.action || "",
        source: event.source || "",
        ok: event.ok === true,
        preferDirect: event.preferDirect === true,
        forceFresh: event.forceFresh === true,
        durationMs: Number(event.durationMs || 0)
      });
    }
    if (event.type === "flow_generation_response") {
      applyFlowGenerationResponseEvent(event).catch((error) => {
        recordEvent({
          type: "queue.flow_generation_feed.error",
          error: String(error?.message || error || "flow_generation_feed_failed")
        });
      });
    }
    if (event.type === "dom_submit_stage") {
      recordEvent({
        type: "queue.dom.stage",
        taskId: event.taskId || "",
        mode: event.mode || "",
        stage: event.stage || "",
        ok: event.ok,
        error: event.error || "",
        refCount: event.refCount || 0,
        attached: event.attached || 0,
        matchedCount: event.matchedCount || 0,
        selector: event.selector || "",
        mediaIds: Array.isArray(event.mediaIds) ? event.mediaIds : [],
        serializedIds: Array.isArray(event.serializedIds) ? event.serializedIds : [],
          capturedResponseCount: event.capturedResponseCount || 0,
          stableCount: Number(event.stableCount || 0),
          softSettled: event.softSettled === true,
          strategy: event.strategy || "",
        reason: event.reason || "",
        requestedPrompt: event.requestedPrompt || "",
        persisted: event.persisted || "",
        modeOutcome: event.modeOutcome || null,
        settingsOutcome: event.settingsOutcome || null,
        searchTerms: Array.isArray(event.searchTerms) ? event.searchTerms : [],
        lastTerm: event.lastTerm || "",
        rowCount: Number(event.rowCount || 0),
        rowSample: Array.isArray(event.rowSample) ? event.rowSample.slice(0, 12) : [],
        candidateIds: Array.isArray(event.candidateIds) ? event.candidateIds : [],
        targetImageId: event.targetImageId || "",
        ingredientIds: Array.isArray(event.ingredientIds) ? event.ingredientIds : [],
        requestSerializedIds: Array.isArray(event.requestSerializedIds) ? event.requestSerializedIds : [],
        finalIngredients: Array.isArray(event.finalIngredients) ? event.finalIngredients.slice(0, 12) : [],
        composerChipBaseline: Number(event.composerChipBaseline || 0),
        composerChipCount: Number(event.composerChipCount || 0),
        composerChipDelta: Number(event.composerChipDelta || 0),
	        nativeComposerChipProof: event.nativeComposerChipProof === true,
	        nativeFrameSlotProof: event.nativeFrameSlotProof === true,
	        visibleFrameSlotCount: Number(event.visibleFrameSlotCount || 0),
        missing: Array.isArray(event.missing) ? event.missing : [],
        wrongIngredientTypes: Array.isArray(event.wrongIngredientTypes) ? event.wrongIngredientTypes : [],
        uploadedMediaIds: Array.isArray(event.uploadedMediaIds) ? event.uploadedMediaIds : [],
        assetImageIds: Array.isArray(event.assetImageIds) ? event.assetImageIds : [],
        uploadedMediaId: event.uploadedMediaId || "",
        confirmedImageId: event.confirmedImageId || "",
        candidateId: event.candidateId || "",
        rowImageId: event.rowImageId || "",
        fileName: event.fileName || "",
        progress: event.progress || "",
        found: event.found,
        attempt: event.attempt || 0,
        source: event.source || "",
        text: event.text || "",
        rowText: event.rowText || "",
        candidates: Array.isArray(event.candidates) ? event.candidates.slice(0, 8) : [],
        selectedIds: Array.isArray(event.selectedIds) ? event.selectedIds.slice(0, 12) : [],
        targetIds: Array.isArray(event.targetIds) ? event.targetIds.slice(0, 12) : [],
        selectedText: event.selectedText || "",
        selectedHasVideo: event.selectedHasVideo,
        selectedHasImage: event.selectedHasImage,
        selectionOk: event.selectionOk,
        selectionError: event.selectionError || "",
        idMatched: event.idMatched,
        nameMatched: event.nameMatched,
        cardAttachOk: event.cardAttachOk,
        cardAttachError: event.cardAttachError || "",
        typeRepairOk: event.typeRepairOk,
        promptAttachOk: event.promptAttachOk,
        settledIds: Array.isArray(event.settledIds) ? event.settledIds : [],
	        composerSnapshot: event.composerSnapshot && typeof event.composerSnapshot === "object" ? event.composerSnapshot : null,
	        strictAssetRowMatch: event.strictAssetRowMatch === true,
	        nativeVisibleSlotAttached: event.nativeVisibleSlotAttached === true,
	        slotVisible: event.slotVisible,
	        targetMatched: event.targetMatched,
	        slotMediaIds: Array.isArray(event.slotMediaIds) ? event.slotMediaIds.slice(0, 8) : [],
	        retainedSlotVisible: event.retainedSlotVisible,
	        retainedTargetMatched: event.retainedTargetMatched,
	        retainedSlotMediaIds: Array.isArray(event.retainedSlotMediaIds) ? event.retainedSlotMediaIds.slice(0, 8) : [],
	        selectableAssetResolution: event.selectableAssetResolution || null,
	        domTrace: event.domTrace || null
	      });
    }
    sendResponse(createMessage(MessageType.PageEvent, { ok: true }));
    return true;
  }

  if (message.type === MessageType.MediaUpload) {
    (async () => {
      try {
        const tab = await findFlowTab(Number(message.payload?.tabId || sender?.tab?.id || 0) || undefined);
        if (!tab?.id) throw new Error("flow_tab_not_found");
        let projectId = compactString(message.payload?.projectId);
        if (!projectId) {
          const page = await sendPageCommand({
            action: "projectState",
            timeoutMs: 10000
          }, tab.id);
          projectId = compactString(page.projectId);
        }
        if (!projectId) throw new Error("missing_project_id");

        const files = Array.isArray(message.payload?.files) ? message.payload.files : [];
        const flowClient = createFlowClientForTab(tab.id);
        const uploads = [];
        for (const file of files) {
          const fileName = compactString(file?.fileName) || "reference.png";
          try {
            recordEvent({
              type: "media.upload.start",
              fileName,
              mimeType: compactString(file?.mimeType) || "image/png",
              hidden: file?.isHidden === true
            });
            const result = await flowClient.uploadImage({
              projectId,
              imageBytes: compactString(file?.imageBytes),
              mimeType: compactString(file?.mimeType) || "image/png",
              fileName,
              isHidden: file?.isHidden === true
            });
            const mediaId = result.mediaIds?.[0] || "";
            const ok = result.ok === true && Boolean(mediaId);
            uploads.push({
              ok,
              fileName,
              mediaId,
              status: result.status,
              error: ok ? "" : result.statusText || "missing_media_id"
            });
            recordEvent({
              type: ok ? "media.upload" : "media.upload.error",
              fileName,
              mediaId,
              status: result.status
            });
          } catch (error) {
            uploads.push({
              ok: false,
              fileName,
              mediaId: "",
              status: 0,
              error: String(error?.message || error || "upload_failed")
            });
            recordEvent({
              type: "media.upload.error",
              fileName,
              error: String(error?.message || error || "upload_failed")
            });
          }
        }

        sendResponse(createMessage(MessageType.MediaUpload, {
          ok: uploads.every((upload) => upload.ok),
          projectId,
          uploads,
          mediaIds: mediaIdsFrom(uploads.map((upload) => upload.mediaId)),
          events: runtimeState.events.slice(-20)
        }));
      } catch (error) {
        sendResponse(createMessage(MessageType.MediaUpload, {
          ok: false,
          error: String(error?.message || error || "media_upload_failed"),
          events: runtimeState.events.slice(-20)
        }));
      }
    })();
    return true;
  }

  if (message.type === MessageType.GalleryRefresh) {
    (async () => {
      try {
        await queueReady;
        const scanResult = await scanFlowGallery(message.payload?.preferredTabId, {
          auto: Boolean(message.payload?.auto),
          lightweight: Boolean(message.payload?.lightweight),
          fullScroll: message.payload?.fullScroll
        });
        sendResponse(createMessage(MessageType.GalleryRefresh, {
          ok: scanResult.ok,
          error: scanResult.error || "",
          gallery: scanResult.gallery,
          scan: scanResult.scan || null,
          queue: queueState(),
          events: runtimeState.events.slice(-20)
        }));
      } catch (error) {
        const messageText = String(error?.message || error || "gallery_refresh_failed");
        recordEvent({ type: "gallery.refresh.error", error: messageText });
        sendResponse(createMessage(MessageType.GalleryRefresh, {
          ok: false,
          error: messageText,
          gallery: galleryState(runtimeState.lastGalleryItems || [], runtimeState.lastGalleryItems?.length ? "flow-dom+queue-ledger" : "queue-ledger"),
          scan: { ok: false, error: messageText },
          queue: queueState(),
          events: runtimeState.events.slice(-20)
        }));
      }
    })();
    return true;
  }

  if (message.type === MessageType.MediaDownload) {
    (async () => {
      await queueReady;
      const projectId = compactString(message.payload?.projectId) || runtimeState.lastGalleryProjectId;
      const gallery = galleryState(runtimeState.lastGalleryItems || [], runtimeState.lastGalleryItems?.length ? "flow-dom+queue-ledger" : "queue-ledger", projectId);
      const plans = planMediaDownloads(gallery.items, {
        selectedIds: message.payload?.selectedIds || [],
        folder: message.payload?.folder || "Auto-Flow-01",
        imageResolution: message.payload?.imageResolution || "1k",
        videoResolution: message.payload?.videoResolution || "720p",
        filenameStyle: message.payload?.filenameStyle || "",
        filenameTemplatePrefix: message.payload?.filenameTemplatePrefix || "",
        filenameTemplateIndex: message.payload?.filenameTemplateIndex || "",
        filenameTemplatePromptPart: message.payload?.filenameTemplatePromptPart || "",
        filenameTemplateDate: message.payload?.filenameTemplateDate || "",
        filenameTemplateSuffix: message.payload?.filenameTemplateSuffix || "",
        filenameTemplateSeparator: message.payload?.filenameTemplateSeparator || "",
        reservedArtifactKeys: [...downloadReservations.artifacts.keys()],
        reservedTargetPaths: [...downloadReservations.targets.keys()]
      });
      const downloads = await executeDownloadPlans(plans, "manual");
      const reconciledDownloads = reconcileQueueWithDownloadResults(downloads);
      if (reconciledDownloads.length) await persistQueueState();
      const nextGallery = galleryState(runtimeState.lastGalleryItems || [], runtimeState.lastGalleryItems?.length ? "flow-dom+queue-ledger" : "queue-ledger", projectId);
      sendResponse(createMessage(MessageType.MediaDownload, {
        ok: downloads.every((download) => download.ok || download.skipped),
        downloads,
        gallery: nextGallery,
        queue: queueState(),
        reconciledDownloads,
        events: runtimeState.events.slice(-20)
      }));
    })();
    return true;
  }

  if (message.type === MessageType.QueueAddJob) {
    (async () => {
      await queueReady;
      const jobs = Array.isArray(message.payload?.jobs) && message.payload.jobs.length
        ? message.payload.jobs
        : (Array.isArray(message.payload?.prompts)
            ? message.payload.prompts
            : String(message.payload?.prompts || "").split(/\n+/)
          ).map((prompt) => ({ prompt }));
      const fallbackJobId = compactString(message.payload?.jobId) || crypto.randomUUID();
      const fallbackJobPromptCount = Number(message.payload?.jobPromptCount || jobs.length || 1);
      const fallbackJobTitle = compactString(message.payload?.jobTitle);
      let added = 0;
      for (const job of jobs) {
        const prompt = compactString(job?.prompt);
        if (!prompt) continue;
        const jobIndex = Number.isFinite(Number(job?.jobIndex)) ? Number(job.jobIndex) : added;
        const jobId = compactString(job?.jobId) || fallbackJobId;
        const jobPromptCount = Number(job?.jobPromptCount || fallbackJobPromptCount || jobs.length || 1);
        const jobTitle = compactString(job?.jobTitle) || fallbackJobTitle;
        const refInputs = refInputsFrom(job?.refInputs || message.payload?.refInputs);
        const inputMediaIds = mediaIdsFrom(job?.mediaIds || message.payload?.mediaIds || refInputs.map((ref) => ref.mediaId));
        const startRefInput = normalizeRefInput(job?.startRefInput)
          || refInputs.find((ref) => ref.role === "startFrameRef")
          || null;
        const endRefInput = normalizeRefInput(job?.endRefInput)
          || refInputs.find((ref) => ref.role === "endFrameRef")
          || null;
        const mediaRefScope = [
          ...refInputs,
          startRefInput,
          endRefInput
        ].filter(Boolean);
        const flowInputMediaIds = inputMediaIds.filter((mediaId) => firstFlowMediaId([mediaId], mediaRefScope));
        const startMediaId = firstFlowMediaId([job?.startMediaId, startRefInput?.mediaId, flowInputMediaIds[0]], mediaRefScope);
        const endMediaId = firstFlowMediaId([job?.endMediaId, endRefInput?.mediaId], mediaRefScope);
        ledger.addTask({
          id: crypto.randomUUID(),
          jobId,
          jobIndex,
          jobPromptCount,
          jobTitle,
          mode: compactString(job?.mode) || compactString(message.payload?.mode) || "text-to-image",
          prompt,
          sourcePrompt: compactString(job?.sourcePrompt),
          imagePrompt: compactString(job?.imagePrompt),
          videoPrompt: compactString(job?.videoPrompt),
          sceneTag: compactString(job?.sceneTag),
          projectId: compactString(job?.projectId) || compactString(message.payload?.projectId),
          model: compactString(job?.model) || compactString(message.payload?.model) || "default",
          aspectRatio: compactString(job?.aspectRatio) || compactString(message.payload?.aspectRatio) || "landscape",
          repeatCount: Number(job?.repeatCount || message.payload?.repeatCount || 1),
          videoLength: compactString(job?.videoLength || message.payload?.videoLength || "8"),
          videoDurationSeconds: compactString(job?.videoDurationSeconds || job?.videoLength || message.payload?.videoLength || "8"),
          requestedVideoLength: compactString(job?.requestedVideoLength || message.payload?.requestedVideoLength || job?.sidepanelVideoLength || message.payload?.sidepanelVideoLength),
          sidepanelVideoLength: compactString(job?.sidepanelVideoLength || message.payload?.sidepanelVideoLength),
          preflightDuration: compactString(job?.preflightDuration || message.payload?.preflightDuration || job?.videoLength || message.payload?.videoLength),
          buildJobsDuration: compactString(job?.buildJobsDuration || message.payload?.buildJobsDuration || job?.videoLength || message.payload?.videoLength),
          payloadDuration: compactString(job?.payloadDuration || message.payload?.payloadDuration || job?.videoLength || message.payload?.videoLength),
          durationFallbackReason: compactString(job?.durationFallbackReason || message.payload?.durationFallbackReason),
          requestedMode: compactString(job?.requestedMode || message.payload?.requestedMode || job?.mode || message.payload?.mode),
          normalizedRuntimeMode: compactString(job?.normalizedRuntimeMode || message.payload?.normalizedRuntimeMode || job?.mode || message.payload?.mode),
          buildJobsMode: compactString(job?.buildJobsMode || message.payload?.buildJobsMode || job?.mode || message.payload?.mode),
          attachedFrameRefs: Array.isArray(job?.attachedFrameRefs)
            ? job.attachedFrameRefs.map((ref) => ({
                role: compactString(ref?.role),
                mediaId: compactString(ref?.mediaId),
                blobStoreId: compactString(ref?.blobStoreId),
                hasDataUrl: ref?.hasDataUrl === true
              }))
            : [],
          submitPath: compactString(job?.submitPath) || compactString(message.payload?.submitPath),
          characterPreflight: job?.characterPreflight && typeof job.characterPreflight === "object"
            ? { ...job.characterPreflight }
            : (message.payload?.characterPreflight && typeof message.payload.characterPreflight === "object" ? { ...message.payload.characterPreflight } : null),
          nativeCharacterHandleMap: job?.nativeCharacterHandleMap && typeof job.nativeCharacterHandleMap === "object"
            ? { ...job.nativeCharacterHandleMap }
            : (message.payload?.nativeCharacterHandleMap && typeof message.payload.nativeCharacterHandleMap === "object" ? { ...message.payload.nativeCharacterHandleMap } : null),
          autoRetryFailedUntilZero: job?.autoRetryFailedUntilZero === true || message.payload?.autoRetryFailedUntilZero === true,
          referenceChainMode: compactString(job?.referenceChainMode),
          referenceChainSeed: job?.referenceChainSeed === true,
          referenceChainIndex: Number.isFinite(Number(job?.referenceChainIndex)) ? Number(job.referenceChainIndex) : null,
          download: job?.download && typeof job.download === "object"
            ? { ...job.download }
            : (message.payload?.download && typeof message.payload.download === "object" ? { ...message.payload.download } : null),
          mediaIds: [],
          refMediaIds: flowInputMediaIds,
          refInputs,
          startRefInput,
          endRefInput,
          startMediaId,
          endMediaId
        });
        added += 1;
      }
      await persistQueueState();
      sendResponse(createMessage(MessageType.QueueAddJob, {
        ok: true,
        added,
        queueRunning: runtimeState.queueRunning,
        queue: queueState(),
        gallery: galleryState()
      }));
    })();
    return true;
  }

  if (message.type === MessageType.QueueStart) {
    (async () => {
      await queueReady;
      captureAuthEnvironment(message.payload || {});
      const next = scheduler.nextPendingTask();
      if (!next) {
        const summary = activeTaskSummary();
        if (hasActiveTasks() && !runtimeState.queueRunning) {
          runQueueUntilIdle(queuePreferredFlowTabId(message, sender));
        }
        sendResponse(createMessage(MessageType.QueueStart, {
          ok: true,
          queueRunning: runtimeState.queueRunning,
          startedTaskId: "",
          queue: queueState(),
          activeSummary: summary,
          auth: runtimeState.auth
        }));
        return;
      }
      const access = await validateQueueStartAccess(next);
      if (!access.allowed) {
        const blockReason = access.message || access.reason || access.error || "license_required";
        scheduler.markBlocked(next.id, blockReason);
        const auth = await updateAuthState();
        await persistQueueState();
        sendResponse(createMessage(MessageType.QueueStart, {
          ok: false,
          error: blockReason,
          access,
          queueRunning: runtimeState.queueRunning,
          startedTaskId: "",
          queue: queueState(),
          auth
        }));
        return;
      }
      if (!runtimeState.queueRunning) {
        runQueueUntilIdle(queuePreferredFlowTabId(message, sender));
      }
      sendResponse(createMessage(MessageType.QueueStart, {
        ok: true,
        access,
        queueRunning: runtimeState.queueRunning,
        startedTaskId: next?.id || "",
        queue: queueState(),
        auth: runtimeState.auth
      }));
    })();
    return true;
  }

  if (message.type === MessageType.QueueResume) {
    (async () => {
      await queueReady;
      captureAuthEnvironment(message.payload || {});
      const browserModeSwitch = message.payload?.switchApiFirstQuotaSuspectedToDom === true
        ? switchPendingApiFirstRowsToDom({ sourceTaskId: message.payload?.sourceTaskId || "" })
        : { switched: 0, switchedIds: [] };
      const pendingBeforeResume = scheduler.nextPendingTask();
      const next = pendingBeforeResume || ledger.listTasks().find((task) => String(task.status || "").toLowerCase() === "blocked");
      if (next) {
        const access = await validateQueueStartAccess(next);
        if (!access.allowed) {
          const blockReason = access.message || access.reason || access.error || "license_required";
          scheduler.markBlocked(next.id, blockReason);
          const auth = await updateAuthState();
          await persistQueueState();
          sendResponse(createMessage(MessageType.QueueResume, {
            ok: false,
            error: blockReason,
            access,
            resumed: 0,
            switchedPendingRowsToDom: browserModeSwitch.switched,
            switchedPendingRowIds: browserModeSwitch.switchedIds,
            userConfirmedSwitchToDom: message.payload?.switchApiFirstQuotaSuspectedToDom === true,
            queueRunning: runtimeState.queueRunning,
            queue: queueState(),
            gallery: galleryState(),
            auth,
            events: runtimeState.events.slice(-20)
          }));
          return;
        }
      }
      const resumed = resumeBlockedQueueTasks(message.payload || {});
      const pendingAfterResume = scheduler.nextPendingTask();
      const pending = ledger.listTasks().filter((task) => String(task.status || "").toLowerCase() === "pending").length;
      await persistQueueState();
      recordEvent({ type: "queue.resume_blocked", resumed, pending });
      if ((resumed > 0 || pendingAfterResume) && !runtimeState.queueRunning) {
        runQueueUntilIdle(queuePreferredFlowTabId(message, sender));
      }
      sendResponse(createMessage(MessageType.QueueResume, {
        ok: true,
        resumed,
        pending,
        switchedPendingRowsToDom: browserModeSwitch.switched,
        switchedPendingRowIds: browserModeSwitch.switchedIds,
        userConfirmedSwitchToDom: message.payload?.switchApiFirstQuotaSuspectedToDom === true,
        startedPending: Boolean(pendingAfterResume),
        queueRunning: runtimeState.queueRunning,
        queue: queueState(),
        gallery: galleryState(),
        events: runtimeState.events.slice(-20)
      }));
    })();
    return true;
  }

  if (message.type === MessageType.QueueStop) {
    runtimeState.queueRunToken = Number(runtimeState.queueRunToken || 0) + 1;
    runtimeState.queueRunning = false;
    recordEvent({ type: "queue.stop.request", runToken: runtimeState.queueRunToken });
    (async () => {
      await queueReady;
      await releaseDebuggerSessions("queue_stop", recordDebuggerTrace);
      await persistQueueState();
      sendResponse(createMessage(MessageType.QueueStop, {
        ok: true,
        queueRunning: runtimeState.queueRunning,
        queue: queueState(),
        gallery: galleryState()
      }));
    })();
    return true;
  }

  if (message.type === MessageType.QueueClear) {
    (async () => {
      await queueReady;
      if (!runtimeState.queueRunning) {
        runtimeState.queueRunToken = Number(runtimeState.queueRunToken || 0) + 1;
        ledger.clearTasks();
        recordEvent({ type: "queue.clear", runToken: runtimeState.queueRunToken });
      }
      await persistQueueState();
      sendResponse(createMessage(MessageType.QueueClear, {
        ok: true,
        queueRunning: runtimeState.queueRunning,
        queue: queueState(),
        gallery: galleryState()
      }));
    })();
    return true;
  }

  if (message.type === MessageType.QueueRemove) {
    (async () => {
      await queueReady;
      const targetId = compactString(message.payload?.id || message.payload?.jobId);
      const removed = targetId && !runtimeState.queueRunning
        ? ledger.pruneTasks((task) => task.id === targetId || task.jobId === targetId)
        : 0;
      await persistQueueState();
      sendResponse(createMessage(MessageType.QueueRemove, {
        ok: true,
        removed,
        queueRunning: runtimeState.queueRunning,
        queue: queueState(),
        gallery: galleryState()
      }));
    })();
    return true;
  }

  if (message.type === MessageType.QueuePrune) {
    (async () => {
      await queueReady;
      const statuses = new Set((message.payload?.statuses || []).map((status) => String(status || "").toLowerCase()));
      const removed = ledger.pruneTasks((task) => statuses.has(String(task.status || "").toLowerCase()));
      await persistQueueState();
      sendResponse(createMessage(MessageType.QueuePrune, {
        ok: true,
        removed,
        queueRunning: runtimeState.queueRunning,
        queue: queueState(),
        gallery: galleryState()
      }));
    })();
    return true;
  }

  sendResponse(createMessage(message.type, { ok: true, accepted: true }));
  return true;
});
