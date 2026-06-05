import { MessageType, createMessage, isAutoFlowRebuildMessage } from "../core/contracts/messages.js";
import { createChromeStorageAdapter, createLicenseClient } from "../core/auth/license-client.js";
import { createFlowClient, extractMediaIds } from "../core/media/flow-client.js";
import { createPageFlowTransport } from "../core/media/page-flow-transport.js";
import { createTaskLedger, sanitizeTaskForDebugReport, TaskStatus } from "../core/queue/task-ledger.js";
import { createScheduler } from "../core/queue/scheduler.js";
import { createQueueExecutor } from "../core/queue/executor.js";
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
const QUEUE_STORAGE_KEY = "autoflow-10767-rebuild-queue-ledger";
const RUNTIME_BINDING_STORAGE_KEY = "autoflow-1080-runtime-binding";
const DOM_DEBUGGER_TRACE_STORAGE_KEY = "autoflow-1081-dom-debugger-trace";
const DOWNLOAD_RESERVATION_TTL_MS = 10 * 60 * 1000;
const EXPECTED_FLOW_BRIDGE_VERSION = "10.8.4-launch-v105";
const EXPECTED_PAGE_HOOK_VERSION = "10.8.4-launch-v105";
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
const RECOVERABLE_GLOBAL_HEAL_ACTIONS = new Set(["cooldown_and_refresh", "reconnect_flow", "wait_for_capacity", "backoff"]);
const MAX_GLOBAL_RECOVERY_ATTEMPTS = 4;
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
    if (latest && latest.status !== TaskStatus.completed && latest.status !== TaskStatus.failed) {
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

function runtimeBindingPayload(tab = {}, extra = {}) {
  const tabUrl = compactString(tab.url || "");
  const tabIsFlow = Boolean(tabUrl && isFlowToolUrl(tabUrl));
  const tabId = tabIsFlow ? (tab?.id || null) : null;
  const url = compactString((tabIsFlow ? tabUrl : "") || extra.href || extra.url || tabUrl);
  const projectId = compactString(extra.projectId || projectIdFromUrl(url));
  return {
    activeTabId: tabId || null,
    projectId,
    pageUrl: url,
    pageTitle: compactString((tabId ? tab?.title : "") || extra.title || ""),
    connected: Boolean(tabId && projectId),
    error: projectId ? (tabId ? null : "flow_tab_not_found") : (tabId ? "missing_project_id" : "flow_tab_not_found"),
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
  return ["clear_flow_cache", "clearFlowCache", "clear_flow_cookies", "clearFlowCookies", "clear_all_flow_data", "clearAllFlowData"].includes(String(action || ""));
}

async function reloadFlowTab(tabId = 0) {
  const tab = await findFlowTab(Number(tabId || 0) || undefined).catch(() => null);
  if (!tab?.id || !chrome.tabs?.reload) return { ok: false, error: "flow_tab_not_found" };
  await chrome.tabs.reload(tab.id);
  return { ok: true, tabId: tab.id };
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

async function runBackgroundMaintenanceAction(action = "") {
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
  const promptMatch = candidates.find(promptMatchesTask) || candidates.find((task) => promptSet.has(normalizedPromptText(task.prompt)));
  if (promptMatch) return promptMatch;
  const activeCandidates = candidates.filter((task) => ["submitting", "submitted", "generating"].includes(String(task.status || "").toLowerCase()));
  if (endpointKind === "video" && activeCandidates.length === 1) return activeCandidates[0];
  if (eventIds.size || ["video", "video_workflow", "media_redirect"].includes(endpointKind)) {
    return null;
  }
  const pendingStatus = activeCandidates.find((task) => ["submitting", "generating"].includes(String(task.status || "").toLowerCase()));
  return pendingStatus || candidates[candidates.length - 1] || null;
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
  return new Set([
    ...(Array.isArray(task.mediaIds) ? task.mediaIds : []),
    ...(Array.isArray(task.outputMediaIds) ? task.outputMediaIds : []),
    ...(Array.isArray(task.submitOutputRows) ? task.submitOutputRows.flatMap((row) => [row?.mediaId, row?.workflowId]) : []),
    ...(Array.isArray(task.statusRows) ? task.statusRows.flatMap((row) => [row?.id, row?.workflowId]) : []),
    ...(Array.isArray(task.outputs) ? task.outputs.map((output) => output?.mediaId) : [])
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
    recordEvent({
      type: "queue.flow_generation_feed.failure",
      taskId: task.id,
      endpointKind,
      failureClass: failed?.failureClass || "",
      failureScope: failed?.failureScope || "",
      healAction: failed?.healAction || "",
      expectedVideos: expected,
      failedCount: failedRows.length,
      lastError: failed?.lastError || failureText
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

async function refreshVideoDownloadReadinessForTask(task = {}) {
  if (!task?.id || taskMediaKind(task) !== "videos") return task;
  const ownedIds = generatedDownloadIdsForTask(task);
  if (!ownedIds.length) return task;
  const existingReady = new Set((task.videoDownloadReadyMediaIds || []).map(compactString).filter(Boolean));
  const missing = ownedIds.filter((id) => !existingReady.has(id));
  if (!missing.length) return task;
  const result = await sendPageCommand({
    action: "resolveVideoDownloadReadiness",
    mediaIds: missing,
    submitOutputRows: Array.isArray(task.submitOutputRows) ? task.submitOutputRows : [],
    projectId: task.projectId || runtimeState.projectId,
    timeoutMs: 15000
  }).catch((error) => ({ ok: false, error: String(error?.message || error || "readiness_failed") }));
  const payload = result?.result || result;
  const readyIds = [...new Set([
    ...existingReady,
    ...(Array.isArray(payload?.readyMediaIds) ? payload.readyMediaIds : [])
  ].map(compactString).filter(Boolean))];
  recordEvent({
    type: "media.download.readiness",
    taskId: task.id,
    requested: missing.length,
    ready: readyIds.length,
    ok: payload?.ok !== false,
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
    selectedIds.push(...mediaIds.map((mediaId) => `${task.id}:${mediaId}`));
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

function resumeBlockedQueueTasks() {
  let resumed = 0;
  for (const task of queueBlockers()) {
    ledger.updateTask(task.id, {
      status: TaskStatus.pending,
      attempts: 0,
      resumedAt: new Date().toISOString(),
      previousFailureClass: task.failureClass || "",
      previousLastError: task.lastError || ""
    });
    resumed += 1;
  }
  return resumed;
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
  if (Number.isInteger(preferredTabId)) {
    const tab = await chrome.tabs.get(preferredTabId).catch(() => null);
    if (tab?.id && isFlowToolUrl(tab.url || "")) {
      return tab;
    }
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
  const exactProject = exact.find((tab) => projectIdFromUrl(tab.url || ""));
  if (exactProject) return exactProject;
  if (exact[0]) return exact[0];

  const allTabs = await chrome.tabs.query({}).catch(() => []);
  const broad = allTabs.filter((tab) => tab.id && isFlowToolUrl(tab.url || ""));
  return broad.find((tab) => projectIdFromUrl(tab.url || "")) || broad[0] || null;
}

async function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
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

function isFreshFlowBridge(probe = {}) {
  return Boolean(
    probe?.ok &&
    probe.bridgeVersion === EXPECTED_FLOW_BRIDGE_VERSION &&
    probe.pageHookVersion === EXPECTED_PAGE_HOOK_VERSION &&
    probe.pageHookInstalled === true
  );
}

function bridgeRuntimeFields(probe = {}, connected = false) {
  const bridgeHealthy = isFreshFlowBridge(probe);
  return {
    bridgeHealthy,
    bridgeVersion: compactString(probe?.bridgeVersion || ""),
    pageHookVersion: compactString(probe?.pageHookVersion || ""),
    pageHookInstalled: probe?.pageHookInstalled === true,
    hasNativeFetch: probe?.pageHookHealth?.hasNativeFetch === true || probe?.hasNativeFetch === true,
    bridgeError: bridgeHealthy ? null : (connected ? compactString(probe?.error || "flow_bridge_not_ready") : null)
  };
}

async function ensureFlowBridge(tabId) {
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
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/page-bridge.js"]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/page/page-hook.js"],
      world: "MAIN"
    });
  } catch (error) {
    const message = String(error?.message || error || "bridge_injection_failed");
    recordEvent({
      type: "bridge.inject.error",
      tabId,
      error: message
    });
    return { ok: false, error: message };
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
          composerSnapshot: event.composerSnapshot && typeof event.composerSnapshot === "object" ? event.composerSnapshot : null,
          strictAssetRowMatch: event.strictAssetRowMatch === true,
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
      if (event.type === "api_session_heat_retry" || event.type === "api_session_heat_dom_fallback") {
        recordEvent({
          type: event.type === "api_session_heat_retry" ? "queue.api_session_heat.retry" : "queue.api_session_heat.dom_fallback",
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
    async submitTask(task, meta = {}) {
      if (DOM_DEBUGGER_TRANSPORT_ENABLED) {
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
  if (String(task.mode || "") === "ingredients-to-video") return "8";
  const raw = String(task.videoLength || task.videoDurationSeconds || "8").trim();
  return raw === "4" || raw === "6" || raw === "8" ? raw : "8";
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
      const candidates = Array.from(document.querySelectorAll("button[role='tab']"))
        .filter(visible)
        .filter((item) => textOf(item) === value)
        .filter((item) => /-trigger-(4|6|8)$/.test(String(item.id || "")))
        .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
      return hit(candidates[0], "duration_tab") || {
        ok: false,
        error: "duration_tab_not_found",
        value,
        visibleNumberTabs: Array.from(document.querySelectorAll("button[role='tab']"))
          .filter(visible)
          .map((item) => ({ id: item.id || "", text: textOf(item), ariaSelected: item.getAttribute("aria-selected") || "", rect: rectOf(item) }))
          .filter((item) => /^(4|6|8)$/.test(item.text) || /-trigger-(4|6|8)$/.test(item.id))
      };
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

function isRecoverableGlobalTask(task = {}) {
  return task?.status === TaskStatus.pending
    && task?.failureScope === "global"
    && RECOVERABLE_GLOBAL_HEAL_ACTIONS.has(String(task?.healAction || ""));
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

async function recoverGlobalQueueFailure(task = {}, tabId = 0) {
  const recoveryAttempts = Number(task.globalRecoveryAttempts || 0) + 1;
  if (recoveryAttempts > MAX_GLOBAL_RECOVERY_ATTEMPTS) {
    const blocked = ledger.updateTask(task.id, {
      status: TaskStatus.blocked,
      healAction: "user_action_required",
      lastError: task.lastError || `${task.failureClass || "global_failure"} recovery exhausted`
    });
    recordEvent({
      type: "queue.global_recovery.exhausted",
      taskId: task.id,
      failureClass: task.failureClass || "",
      previousHealAction: task.healAction || "",
      recoveryAttempts
    });
    await persistQueueState();
    return { ok: false, blocked };
  }

  const cooldownMs = globalRecoveryDelayMs({ ...task, globalRecoveryAttempts: recoveryAttempts });
  const patch = {
    globalRecoveryAttempts: recoveryAttempts,
    nextRetryAt: new Date(Date.now() + cooldownMs).toISOString()
  };
  let tabReload = null;
  if (task.healAction === "cooldown_and_refresh" || task.healAction === "reconnect_flow") {
    tabReload = await reloadFlowTab(tabId).catch((error) => ({ ok: false, error: String(error?.message || error || "tab_reload_failed") }));
    patch.lastHealReloadOk = tabReload?.ok === true;
  }
  ledger.updateTask(task.id, patch);
  recordEvent({
    type: "queue.global_recovery.cooldown",
    taskId: task.id,
    failureClass: task.failureClass || "",
    healAction: task.healAction || "",
    cooldownMs,
    recoveryAttempts,
    tabReloaded: tabReload?.ok === true
  });
  await persistQueueState();
  await sleep(cooldownMs);
  recordEvent({
    type: "queue.global_recovery.resume",
    taskId: task.id,
    failureClass: task.failureClass || "",
    healAction: task.healAction || "",
    recoveryAttempts
  });
  return { ok: true };
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

async function runQueueUntilIdle(preferredTabId) {
  await queueReady;
  if (runtimeState.queueRunning) return;
  const runToken = Number(runtimeState.queueRunToken || 0) + 1;
  runtimeState.queueRunToken = runToken;
  runtimeState.queueRunning = true;
  const isActiveRun = () => runtimeState.queueRunning && runtimeState.queueRunToken === runToken;
  recordEvent({ type: "queue.start", runToken });
  try {
    const tab = await findFlowTab(preferredTabId);
    if (!tab?.id) throw new Error("flow_tab_not_found");
    const executor = createExecutorForTab(tab.id);

    while (isActiveRun()) {
      const next = scheduler.nextPendingTask();
      if (!next) {
        const activeVideoTask = ledger.listTasks().find((task) => task.status === TaskStatus.generating && taskMediaKind(task) === "videos");
        if (activeVideoTask) {
          const settledVideo = await waitForVideoTaskOutputs(activeVideoTask, tab.id);
          if (!isActiveRun()) break;
          recordEvent({
            type: "queue.video_settle.done",
            taskId: settledVideo?.id || activeVideoTask.id,
            status: settledVideo?.status || activeVideoTask.status,
            foundVideos: settledVideo?.foundVideos || 0,
            expectedVideos: settledVideo?.expectedVideos || activeVideoTask.expectedVideos || activeVideoTask.repeatCount || 1
          });
          if (settledVideo?.retryOfTaskId) {
            await mergeVideoRepairTaskIntoParent(settledVideo);
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
        await ensureTaskProjectId(next, tab.id);
        await persistQueueState();
        if (!isActiveRun()) break;
        const submitOnlyVideos = taskMediaKind(next) === "videos";
        let task = await executor.runTask(next.id, { submitOnlyVideos });
        if (!isActiveRun()) break;
        if (!submitOnlyVideos && taskMediaKind(task) === "images" && task?.status !== TaskStatus.generating && task?.status !== TaskStatus.complete) {
          task = await recoverImageTaskAfterSubmitFailure(task, tab.id, "after_submit_result");
        }
        if (!isActiveRun()) break;
        task = submitOnlyVideos ? task : await waitForImageTaskOutputs(task, tab.id);
        if (!isActiveRun()) break;
        recordEvent({
          type: "queue.task.done",
          taskId: task?.id || next.id,
          status: task?.status || "unknown",
          failureClass: task?.failureClass || "",
          failureScope: task?.failureScope || "",
          mediaIds: task?.mediaIds || []
        });
        if (task?.status === TaskStatus.complete) {
          if (task.retryOfTaskId) {
            task = await mergeVideoRepairTaskIntoParent(task) || task;
          } else {
            await appendVideoRepairTask(task, "queue_task_complete_partial");
          }
          await autoDownloadCompletedTasks([task.id], "queue_complete");
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
          if (!recovery.ok) break;
          continue;
        }
        if (["failed", "blocked"].includes(task?.status) && task?.failureScope === "global") {
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
  const maxAttempts = Math.max(0, Math.min(3, Number(task.partialRetryMax ?? task.generationRetryMax ?? 1) || 1));
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
  const foundVideos = mergedOutputs.length;
  const parentReady = new Set((parent.videoDownloadReadyMediaIds || []).map(compactString).filter(Boolean));
  (task.videoDownloadReadyMediaIds || []).map(compactString).filter(Boolean).forEach((id) => parentReady.add(id));
  const patch = {
    outputs: mergedOutputs,
    outputMediaIds: mergedOutputs.map((output) => output.mediaId),
    mediaIds: [...new Set([...(parent.mediaIds || []), ...(task.mediaIds || []), ...mergedOutputs.map((output) => output.mediaId)].map(compactString).filter(Boolean))],
    foundVideos,
    expectedVideos: expected,
    failedOutputCount: Math.max(0, expected - foundVideos),
    partialFailure: foundVideos < expected,
    retryStatus: foundVideos >= expected
      ? "repaired"
      : (duplicateRepairMediaIds.length ? "duplicate_repair_output" : "partial_repaired"),
    duplicateRepairMediaIds,
    videoDownloadReadyMediaIds: [...parentReady],
    lastError: "",
    failureClass: "",
    healAction: "",
    failureScope: ""
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
      const runtimeConnected = Boolean(binding.activeTabId && projectId);
      const bridgeProbe = runtimeConnected
        ? await ensureFlowBridge(binding.activeTabId).catch((error) => ({
          ok: false,
          error: String(error?.message || error || "flow_bridge_not_ready")
        }))
        : { ok: false, error: binding.activeTabId ? "missing_project_id" : "flow_tab_not_found" };
      const bridgeFields = bridgeRuntimeFields(bridgeProbe, runtimeConnected);
      runtimeState.bridgeHealthy = bridgeFields.bridgeHealthy;
      const payload = {
        ok: true,
        queue: queueState(),
        runtime: {
          connected: Boolean(binding.activeTabId && projectId),
          activeTabId: binding.activeTabId || null,
          projectId,
          pageUrl: binding.pageUrl || tab?.url || "",
          pageTitle: binding.pageTitle || tab?.title || "",
          ...bridgeFields,
          error: binding.activeTabId ? (projectId ? null : "missing_project_id") : "flow_tab_not_found",
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
        const result = await runBackgroundMaintenanceAction(action);
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
        composerSnapshot: event.composerSnapshot && typeof event.composerSnapshot === "object" ? event.composerSnapshot : null,
        strictAssetRowMatch: event.strictAssetRowMatch === true,
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
          submitPath: compactString(job?.submitPath) || compactString(message.payload?.submitPath),
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
          runQueueUntilIdle(Number(message.payload?.tabId || sender?.tab?.id || 0) || undefined);
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
        scheduler.markBlocked(next.id, access.reason || access.error || "license_required");
        const auth = await updateAuthState();
        await persistQueueState();
        sendResponse(createMessage(MessageType.QueueStart, {
          ok: false,
          error: access.reason || access.error || "license_required",
          access,
          queueRunning: runtimeState.queueRunning,
          startedTaskId: "",
          queue: queueState(),
          auth
        }));
        return;
      }
      if (!runtimeState.queueRunning) {
        runQueueUntilIdle(Number(message.payload?.tabId || sender?.tab?.id || 0) || undefined);
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
      const next = scheduler.nextPendingTask() || ledger.listTasks().find((task) => String(task.status || "").toLowerCase() === "blocked");
      if (next) {
        const access = await validateQueueStartAccess(next);
        if (!access.allowed) {
          scheduler.markBlocked(next.id, access.reason || access.error || "license_required");
          const auth = await updateAuthState();
          await persistQueueState();
          sendResponse(createMessage(MessageType.QueueResume, {
            ok: false,
            error: access.reason || access.error || "license_required",
            access,
            resumed: 0,
            queueRunning: runtimeState.queueRunning,
            queue: queueState(),
            gallery: galleryState(),
            auth,
            events: runtimeState.events.slice(-20)
          }));
          return;
        }
      }
      const resumed = resumeBlockedQueueTasks();
      await persistQueueState();
      recordEvent({ type: "queue.resume_blocked", resumed });
      if (resumed > 0 && !runtimeState.queueRunning) {
        runQueueUntilIdle(Number(message.payload?.tabId || sender?.tab?.id || 0) || undefined);
      }
      sendResponse(createMessage(MessageType.QueueResume, {
        ok: true,
        resumed,
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
