import { MessageType, createMessage } from "../core/contracts/messages.js";
import { applyTranslations, localeDiagnostics, translate } from "./i18n.js";
import { bindRefPanel } from "./ref-panel.js";
import { sanitizeFolderName } from "../core/gallery/media-ledger.js";
import { matchedReferenceIdsForPrompt, splitAutoFlowPromptLine } from "../core/gallery/animate-prompts.js";
import { CharacterFailureClass, buildCharacterAssetLedger, normalizeCharacterHandle, parseAutoFlowPacket, scanCharacterMentions, validateCharacterRun } from "../core/characters/character-prompts.js";
import { applyCharacterSetupPlanToSources, assertCharacterSetupReadyForPathC, buildCharacterSetupPlan, markStaleNativeCharacterSavedMappings, mergeNativeCharacterSavedMappings, nativeCharacterHandleMapFromSetup, readyNativeCharacterMappingsForProject } from "../core/characters/character-setup-runner.js";
import { renumberSceneClips, sceneGallerySelectionIds, totalSceneDuration } from "../core/gallery/scene-builder.js";
import { buildAutopilotF2VSeedsFromTasks } from "../core/queue/autopilot-pipeline.js";
import { buildRecoveryReportFields, buildTaskSupportSummary } from "../core/queue/recovery-policy.js";
import { base64FromDataUrl, getReferenceBlob, putReferenceBlob } from "../core/storage/reference-blob-store.js";
import { deriveBillingAccountState } from "../core/auth/billing-state.js";
import { FLOW_MODES, STORAGE_KEY, createDefaultState, mergeState } from "./runtime-config.js";
import { renderControl, renderGallery, renderHistory, renderLiveQueue, renderLogs, renderScenes, renderSettings } from "./views.js";
import { createGalleryController } from "./gallery-controller.js";
import { materializeReferenceUploads } from "./reference-upload-preflight.js";

const ROUTES = {
  control: {
    viewId: "view-control",
    render: (view, nextState) => renderControl(view, nextState, {
      onRun: requestEnqueueAndRun,
      onAddToQueue: enqueueJobsWithRender,
      onStartQueue: runQueue
    }),
    bind: bindAfterControl
  },
  live: { viewId: "view-live", render: renderLiveQueue, bind: bindAfterLiveQueue },
  gallery: { viewId: "view-gallery", render: renderGallery, bind: bindAfterGallery },
  history: { viewId: "view-history", render: renderHistory, bind: bindAfterHistory },
  settings: { viewId: "view-settings", render: renderSettings, bind: bindAfterSettings },
  logs: { viewId: "view-logs", render: renderLogs, bind: bindAfterLogs },
  scenes: { viewId: "view-scenes", render: renderScenes, bind: bindAfterScenes }
};

const APP_VERSION = "10.8.8";
const QUEUE_LEDGER_STORAGE_KEY = "autoflow-10767-rebuild-queue-ledger";
const SUPPORT_LINKS = Object.freeze({
  discord: "https://discord.gg/WK2qVXCrHE",
  telegram: "https://t.me/+2caK2vnkw8IwODFl"
});
const REVIEW_DUCK_ACTION_LINKS = Object.freeze({
  chromeStore: "https://chromewebstore.google.com/detail/auto-flow-automation-for/lhcmnhdbddgagibbbgppakocflbnknoa",
  discord: SUPPORT_LINKS.discord,
  telegram: SUPPORT_LINKS.telegram
});
const SUPPORT_FINGERPRINT_FILES = Object.freeze([
  "manifest.json",
  "src/background/service-worker.js",
  "src/content/page-bridge.js",
  "src/page/page-hook.js"
]);
let state = createDefaultState();
let buildFingerprint = {
  product: "Auto Flow",
  version: APP_VERSION,
  loadState: "pending"
};
let storageBound = false;
let suppressStorageRenderUntil = 0;
let gallerySyncInFlight = null;
let lastGalleryAutoSyncAt = 0;
let lastGalleryFullAutoScanProjectId = "";
let refImportIntent = "library";
let promptInputRenderTimer = 0;
let lastRuntimeSurfaceSignature = "";
const MAX_STORED_INLINE_MEDIA_CHARS = 300000;
// Tracks the wizardStep value as it was during the LAST render. Used by
// captureUiSnapshot/restoreUiSnapshot to detect step-changes — snapshot
// captures THIS (the previous render's value), not the current state, so
// the comparison "old vs new" actually finds a difference when the user
// clicks Next/Back. Without this, captureUiSnapshot runs INSIDE render()
// after chrome.storage.onChanged has already updated state.control.wizardStep,
// making snapshot.wizardStep === state.control.wizardStep at restore time
// (no diff detected, scroll restore wins, scrollIntoView gets undone).
let lastRenderedWizardStep = null;
let runtimeRefreshTimer = 0;
let queueLedgerRefreshTimer = 0;
let flowTabUpdatesBound = false;
let galleryController = null;
let controlActionDelegateBound = false;
let enqueueAndRunInFlight = false;
const seenEvents = new Set();
const suppressedRuntimeEventTypes = new Set([
  MessageType.GalleryRefresh,
  MessageType.PageEvent,
  "gallery.scan.ok",
  "bridge.inject.start",
  "bridge.inject.ready",
  "bridge.inject.stale",
  "bridge.inject.missing",
  "bridge.inject.stale_rejected",
  "queue.restore",
  "queue.gallery_reconcile",
  "queue.download_reconcile"
]);

const FLOW_PROJECT_URL_RE = /https:\/\/labs\.google(?:\.com)?\/fx\/(?:[^/?#]+\/)?tools\/flow\/project\/([0-9a-f-]{36})/i;
const FLOW_URL_RE = /^https:\/\/labs\.google(?:\.com)?\/fx\/(?:[^/?#]+\/)?tools\/flow(?:\/|$|\?)/i;

function projectIdFromFlowUrl(url = "") {
  return String(url || "").match(FLOW_PROJECT_URL_RE)?.[1] || "";
}

function isFlowUrl(url = "") {
  return FLOW_URL_RE.test(String(url || ""));
}

const HELP_TOPICS = Object.freeze([
  {
    id: "text_to_video",
    titleKey: "helpT2vTitle",
    bodyKey: "helpT2vBody",
    route: "control",
    steps: [
      { route: "control", target: ".mode-button-grid", titleKey: "mode", bodyKey: "helpT2vBody" },
      { route: "control", target: "#prompts", titleKey: "input", bodyKey: "promptPlaceholder" },
      { route: "control", target: "#addToQueueButton", titleKey: "addToQueue", bodyKey: "autoStartNextJob" }
    ]
  },
  {
    id: "create_image",
    titleKey: "helpT2iTitle",
    bodyKey: "helpT2iBody",
    route: "control",
    steps: [
      { route: "control", target: ".reference-grid", titleKey: "referenceLibrary", bodyKey: "helpT2iBody" },
      { route: "settings", target: "#imageModelSelector", titleKey: "model", bodyKey: "imageRatio" },
      { route: "control", target: "#mainActionButton", titleKey: "startQueue", bodyKey: "helpT2iBody" }
    ]
  },
  {
    id: "image_to_video",
    titleKey: "helpI2vTitle",
    bodyKey: "helpI2vBody",
    route: "control",
    steps: [
      { route: "control", target: ".reference-grid", titleKey: "startFrame", bodyKey: "helpI2vBody" },
      { route: "control", target: "[data-video-length]", titleKey: "timing", bodyKey: "generationWaitTime" },
      { route: "control", target: "#addToQueueButton", titleKey: "addToQueue", bodyKey: "helpI2vBody" }
    ]
  },
  {
    id: "gallery",
    titleKey: "helpGalleryTitle",
    bodyKey: "helpGalleryBody",
    route: "gallery",
    steps: [
      { route: "gallery", target: "#gallery-sync-btn", titleKey: "sync", bodyKey: "helpGalleryBody" },
      { route: "gallery", target: "#gallery-download-btn", titleKey: "download", bodyKey: "downloadSettings" },
      { route: "gallery", target: "#gallery-send-scenes-btn", titleKey: "sendToScenes", bodyKey: "helpScenesBody" }
    ]
  },
  {
    id: "ingredients_to_video",
    titleKey: "helpIngredientsTitle",
    bodyKey: "helpIngredientsBody",
    route: "control",
    steps: [
      { route: "control", target: ".reference-grid", titleKey: "ingredientsRefs", bodyKey: "helpIngredientsBody" },
      { route: "settings", target: "#ingredientsModelSelector", titleKey: "ingredientsVideoModel", bodyKey: "helpIngredientsBody" },
      { route: "control", target: "#addToQueueButton", titleKey: "addToQueue", bodyKey: "helpIngredientsBody" }
    ]
  },
  {
    id: "scene_builder",
    titleKey: "helpScenesTitle",
    bodyKey: "helpScenesBody",
    route: "scenes",
    steps: [
      { route: "gallery", target: "#gallery-send-scenes-btn", titleKey: "sendToScenes", bodyKey: "helpGalleryBody" },
      { route: "scenes", target: "#sceneBuilderClipList", titleKey: "clipList", bodyKey: "addFromGalleryHint" },
      { route: "scenes", target: "#sceneBuilderClearBtn", titleKey: "clearScenes", bodyKey: "helpScenesBody" }
    ]
  }
]);

async function loadState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  state = mergeState(createDefaultState(), stripVolatileRuntimeState(stored[STORAGE_KEY]));
  state.queue.running = false;
  await hydrateQueueLedgerFromStorage();
  await migrateStoredInlineReferenceMedia();
}

async function loadBuildFingerprint() {
  try {
    const response = await fetch(chrome.runtime.getURL("build-fingerprint.json"), { cache: "no-store" });
    if (!response.ok) throw new Error(`build_fingerprint_http_${response.status || "unknown"}`);
    const parsed = await response.json();
    buildFingerprint = {
      ...(parsed && typeof parsed === "object" ? parsed : {}),
      loadState: "ok"
    };
  } catch (error) {
    buildFingerprint = {
      product: "Auto Flow",
      version: APP_VERSION,
      loadState: "error",
      error: formatEventDiagnostic(error)
    };
  }
}

function buildFingerprintForReport() {
  const fp = buildFingerprint && typeof buildFingerprint === "object" ? buildFingerprint : {};
  const files = fp.files && typeof fp.files === "object" ? fp.files : {};
  const copied = Array.isArray(fp.copied) ? fp.copied : [];
  return {
    product: fp.product || "Auto Flow",
    version: fp.version || APP_VERSION,
    versionName: fp.versionName || "",
    releaseName: fp.releaseName || "",
    generatedAt: fp.generatedAt || "",
    branch: fp.branch || "",
    commit: fp.commit || "",
    shortCommit: fp.shortCommit || "",
    dirty: fp.dirty === true,
    loadState: fp.loadState || "unknown",
    error: fp.error || "",
    copiedCount: copied.length,
    requiredFiles: Object.fromEntries(SUPPORT_FINGERPRINT_FILES.map((filePath) => [
      filePath,
      {
        copied: copied.includes(filePath),
        sha256: files[filePath] || ""
      }
    ]))
  };
}

async function hydrateStateFromStorage() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  state = mergeState(createDefaultState(), stripVolatileRuntimeState(stored[STORAGE_KEY]));
  await hydrateQueueLedgerFromStorage();
  await migrateStoredInlineReferenceMedia();
  return state;
}

function stripVolatileRuntimeState(storedState = {}) {
  if (!storedState || typeof storedState !== "object") return storedState;
  const sanitized = { ...storedState };
  // Runtime binding and queue state are owned by the background/service-worker
  // health check and queue ledger. Persisting them in sidepanel storage can
  // resurrect an aborted run after the real ledger has been cleared.
  // Fallback sidepanel versions share chrome.storage.local, so persisted
  // runtime.bridgeHealthy=false or old queue items must never poison the
  // current 10.8.x UI.
  delete sanitized.runtime;
  delete sanitized.queue;
  return sanitized;
}

async function hydrateQueueLedgerFromStorage() {
  const stored = await chrome.storage.local.get(QUEUE_LEDGER_STORAGE_KEY).catch(() => null);
  applyQueueLedgerStorageSnapshot(stored?.[QUEUE_LEDGER_STORAGE_KEY]);
  if (!hasOpenQueueTasks()) state.queue.running = false;
}

async function persistState(options = {}) {
  state = mergeState(createDefaultState(), state);
  if (options.suppressStorageRender) suppressStorageRenderUntil = Date.now() + 1200;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: compactStateForStorage(state) });
  } catch (error) {
    if (!/quota/i.test(String(error?.message || error || ""))) throw error;
    const compacted = compactStateForStorage(state, { aggressive: true });
    await chrome.storage.local.set({ [STORAGE_KEY]: compacted });
    state = mergeState(createDefaultState(), compacted);
  }
}

function isInlineDataUrl(value = "") {
  return /^data:/i.test(String(value || ""));
}

function stripLargeInlineMediaFields(item = {}, { aggressive = false, preserveInlineMedia = false } = {}) {
  if (!item || typeof item !== "object") return item;
  const out = { ...item };
  const hasDurableMedia = Boolean(out.mediaId || out.downloadStatus || out.downloadedAt);
  for (const key of ["dataUrl", "imageUrl", "mediaUrl", "thumbnailUrl"]) {
    if (!isInlineDataUrl(out[key])) continue;
    const tooLargeForState = String(out[key] || "").length > MAX_STORED_INLINE_MEDIA_CHARS;
    const shouldStrip = aggressive || tooLargeForState || (hasDurableMedia && !preserveInlineMedia);
    if (shouldStrip) {
      out[key] = "";
      out.inlinePreviewStripped = true;
    }
  }
  return out;
}

function compactRunForStorage(run = {}, options = {}) {
  if (!run || typeof run !== "object") return run;
  const out = { ...run };
  if (Array.isArray(out.refs)) {
    out.refs = out.refs.map((ref) => stripLargeInlineMediaFields(ref, {
      aggressive: options.aggressive === true,
      preserveInlineMedia: true
    }));
  }
  if (out.control?.transientReferenceItems) {
    out.control = {
      ...out.control,
      transientReferenceItems: out.control.transientReferenceItems.map((ref) => stripLargeInlineMediaFields(ref, {
        aggressive: options.aggressive === true,
        preserveInlineMedia: true
      }))
    };
  }
  return out;
}

function compactStateForStorage(inputState = state, options = {}) {
  const compacted = structuredClone(inputState);
  delete compacted.runtime;
  delete compacted.queue;
  const aggressive = options.aggressive === true;
  compacted.logs.items = Array.isArray(compacted.logs?.items)
    ? compacted.logs.items.slice(aggressive ? -80 : -220)
    : [];
  compacted.referenceLibrary.savedItems = Array.isArray(compacted.referenceLibrary?.savedItems)
    ? compacted.referenceLibrary.savedItems.map((item) => stripLargeInlineMediaFields(item, { aggressive, preserveInlineMedia: true }))
    : [];
  compacted.control.transientReferenceItems = Array.isArray(compacted.control?.transientReferenceItems)
    ? compacted.control.transientReferenceItems.map((item) => stripLargeInlineMediaFields(item, { aggressive, preserveInlineMedia: true }))
    : [];
  compacted.gallery.items = Array.isArray(compacted.gallery?.items)
    ? compacted.gallery.items.map((item) => stripLargeInlineMediaFields(item, { aggressive }))
    : [];
  compacted.scenes.clips = Array.isArray(compacted.scenes?.clips)
    ? compacted.scenes.clips.map((clip) => stripLargeInlineMediaFields(clip, { aggressive }))
    : [];
  compacted.history.runs = Array.isArray(compacted.history?.runs)
    ? compacted.history.runs.slice(0, aggressive ? 20 : 50).map((run) => compactRunForStorage(run, { aggressive }))
    : [];
  return compacted;
}

function appendLog(level, scope, message) {
  state.logs.items.push({
    id: crypto.randomUUID(),
    level,
    scope,
    message: String(message || ""),
    createdAt: new Date().toISOString()
  });
  state.logs.items = state.logs.items.slice(-300);
}

function activeRoute() {
  return state.ui.activeRoute || "control";
}

function captureUiSnapshot() {
  const active = document.activeElement;
  const focusSnapshot = active?.matches?.("textarea,input,select")
    ? {
      selector: active.id ? `#${CSS.escape(active.id)}` : "",
      start: active.selectionStart,
      end: active.selectionEnd
    }
    : null;
  const scrollSelectors = [
    ".tab-content",
    ".view.active",
    ".afw-step-body",
    ".afw-pair-list",
    "#logDisplay",
    "#gallery-images",
    "#gallery-videos",
    ".gallery-grid-view",
    ".gallery-table-view",
    ".gallery-pane.active"
  ];
  return {
    pageY: document.scrollingElement?.scrollTop || 0,
    shellY: document.querySelector(".shell")?.scrollTop || 0,
    tabContentY: document.querySelector(".tab-content")?.scrollTop || 0,
    activeViewY: document.querySelector(".view.active")?.scrollTop || 0,
    scrollPositions: scrollSelectors.map((selector) => ({
      selector,
      top: document.querySelector(selector)?.scrollTop || 0,
      left: document.querySelector(selector)?.scrollLeft || 0
    })),
    route: activeRoute(),
    wizardStep: lastRenderedWizardStep,
    focus: focusSnapshot
  };
}

function restoreUiSnapshot(snapshot) {
  if (!snapshot || snapshot.route !== activeRoute()) return;
  // When the wizard step changed (Next/Back click), skip the tab/view
  // scroll restoration so renderControlWizard's scrollIntoView can land
  // the new step header at the top of the viewport. Without this, the
  // scroll-restore frames after render reset the panel to where the user
  // was before clicking, defeating the whole point of step navigation.
  //
  // snapshot.wizardStep is the step from the PREVIOUS render
  // (lastRenderedWizardStep). The current state.control.wizardStep is
  // the step we're about to render. If they differ, the user just
  // navigated.
  const currentStep = state?.control?.wizardStep;
  const wizardStepChanged = snapshot.wizardStep != null
    && currentStep != null
    && snapshot.wizardStep !== currentStep;
  if (wizardStepChanged) lastRenderedWizardStep = currentStep;
  const restore = () => {
    if (!wizardStepChanged) {
      const scrollingElement = document.scrollingElement;
      if (scrollingElement) scrollingElement.scrollTop = snapshot.pageY;
      const shell = document.querySelector(".shell");
      if (shell) shell.scrollTop = snapshot.shellY;
      const tabContent = document.querySelector(".tab-content");
      if (tabContent) tabContent.scrollTop = snapshot.tabContentY || 0;
      const view = document.querySelector(".view.active");
      if (view) view.scrollTop = snapshot.activeViewY;
      for (const entry of snapshot.scrollPositions || []) {
        const node = document.querySelector(entry.selector);
        if (!node) continue;
        node.scrollTop = entry.top || 0;
        node.scrollLeft = entry.left || 0;
      }
    }
    // Focus restoration always runs — preserving caret position in the
    // textarea is independent of scroll. Without this, typing in Step 1
    // and clicking Next would lose where you were if you came back.
    if (snapshot.focus?.selector) {
      const input = document.querySelector(snapshot.focus.selector);
      if (input?.focus) {
        input.focus({ preventScroll: true });
        try {
          input.setSelectionRange(snapshot.focus.start, snapshot.focus.end);
        } catch {}
      }
    }
  };
  requestAnimationFrame(restore);
  requestAnimationFrame(() => requestAnimationFrame(restore));
  window.setTimeout(restore, 60);
  window.setTimeout(restore, 180);
}

function clickFileInputWithoutScroll(input) {
  if (!input) return;
  const snapshot = captureUiSnapshot();
  input.click();
  restoreUiSnapshot(snapshot);
  window.setTimeout(() => restoreUiSnapshot(snapshot), 140);
}

function activateTab(route) {
  const nextRoute = ROUTES[route] ? route : "control";
  state.ui.activeRoute = nextRoute;
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.route === nextRoute);
  });
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));

  const cfg = ROUTES[nextRoute];
  const view = document.getElementById(cfg.viewId);
  if (!view) return;
  cfg.render(view, state);
  view.classList.add("active");
  cfg.bind(view);
  updateHeaderConnection();
}

function render(options = {}) {
  const snapshot = options.preserveUi === false ? null : captureUiSnapshot();
  activateTab(activeRoute());
  renderOverlays();
  applyTranslations(document, currentLocale());
  restoreUiSnapshot(snapshot);
  // Sync the module-level tracker AFTER restore — next snapshot captures
  // this value, and the next step-change detect will compare correctly.
  lastRenderedWizardStep = state?.control?.wizardStep ?? null;
  if (activeRoute() === "gallery" && options.autoSyncGallery !== false) {
    scheduleGalleryAutoSync();
  }
}

function renderUnlessLiveEditing() {
  if (isLiveEditing() && !["live", "gallery"].includes(activeRoute())) {
    updateHeaderConnection();
    applyTranslations(document, currentLocale());
    return;
  }
  render();
}

function scrollToControlTarget(selector, { delay = 80 } = {}) {
  window.setTimeout(() => {
    const target = document.querySelector(selector);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.remove("af-guidance-pulse");
    void target.offsetWidth;
    target.classList.add("af-guidance-pulse");
    window.setTimeout(() => target.classList.remove("af-guidance-pulse"), 1800);
  }, delay);
}

function nextModeTarget(mode) {
  if ([FLOW_MODES.textToImage, FLOW_MODES.imageToVideo, FLOW_MODES.ingredientsToVideo].includes(mode)) {
    return "#submitRouteSettingsRow";
  }
  return "#promptContainer";
}

function nextRouteTarget() {
  if ([FLOW_MODES.textToImage, FLOW_MODES.imageToVideo, FLOW_MODES.ingredientsToVideo].includes(state.control.mode)) {
    return "#imageModeContainer";
  }
  return "#prompts";
}

function scheduleGalleryAutoSync() {
  if (activeRoute() !== "gallery") return;
  const now = Date.now();
  const hasOpenQueue = (state.queue.items || []).some((item) => !["complete", "done", "failed", "blocked"].includes(item.status));
  const projectId = String(state.runtime?.projectId || "").trim();
  const persistedFullAutoScanProjectId = String(state.gallery?.meta?.autoFullScanProjectId || "").trim();
  if (!lastGalleryFullAutoScanProjectId && persistedFullAutoScanProjectId) {
    lastGalleryFullAutoScanProjectId = persistedFullAutoScanProjectId;
  }
  const shouldFullScanOnOpen = Boolean(projectId && !hasOpenQueue && lastGalleryFullAutoScanProjectId !== projectId);
  const minInterval = hasOpenQueue ? 10000 : 60000;
  if (gallerySyncInFlight) return;
  if (!shouldFullScanOnOpen && now - lastGalleryAutoSyncAt < minInterval) return;
  if (!shouldFullScanOnOpen && !hasOpenQueue && (state.gallery.items || []).length) return;
  lastGalleryAutoSyncAt = now;
  gallerySyncInFlight = syncGallery({ auto: true, fullScroll: shouldFullScanOnOpen })
    .then(() => {
      if (!shouldFullScanOnOpen) return;
      lastGalleryFullAutoScanProjectId = projectId;
      state.gallery.meta = {
        ...(state.gallery.meta || {}),
        autoFullScanProjectId: projectId,
        autoFullScanAt: new Date().toISOString()
      };
      return persistState({ suppressStorageRender: true });
    })
    .finally(() => {
      gallerySyncInFlight = null;
    });
}

function currentLocale() {
  return state.control?.presets?.language || "en";
}

function isLiveEditing() {
  const active = document.activeElement;
  return Boolean(active?.matches?.("textarea,input,select"));
}

function applyQueueLedgerStorageSnapshot(snapshot = {}) {
  const previousSignature = runtimeSurfaceSignature();
  if (!Array.isArray(snapshot?.tasks)) {
    state.queue = {
      running: false,
      paused: false,
      items: [],
      runtimeEvents: [],
      taskLedgerSnapshot: [],
      generatedMediaIds: []
    };
    return previousSignature !== runtimeSurfaceSignature();
  }
  state.queue.items = snapshot.tasks;
  state.queue.taskLedgerSnapshot = Array.isArray(snapshot.taskLedgerSnapshot) ? snapshot.taskLedgerSnapshot : [];
  state.queue.generatedMediaIds = Array.isArray(snapshot.generatedMediaIds) ? snapshot.generatedMediaIds : [];
  state.queue.runtimeEvents = Array.isArray(snapshot.events) ? snapshot.events.slice(-200) : state.queue.runtimeEvents || [];
  const nextSignature = runtimeSurfaceSignature();
  return previousSignature !== nextSignature;
}

function scheduleQueueLedgerRuntimeRefresh(delay = 50) {
  if (queueLedgerRefreshTimer) window.clearTimeout(queueLedgerRefreshTimer);
  queueLedgerRefreshTimer = window.setTimeout(() => {
    queueLedgerRefreshTimer = 0;
    if (!["gallery", "live"].includes(activeRoute())) return;
    refreshRuntime({ includeGallery: false }).catch(() => null);
  }, delay);
}

function bindStorageUpdates() {
  if (storageBound) return;
  storageBound = true;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const appStateChange = changes[STORAGE_KEY];
    const queueLedgerChange = changes[QUEUE_LEDGER_STORAGE_KEY];
    const hasQueueLedgerChange = Object.prototype.hasOwnProperty.call(changes, QUEUE_LEDGER_STORAGE_KEY);
    if (!appStateChange?.newValue && !hasQueueLedgerChange) return;
    const previousSignature = runtimeSurfaceSignature();
    if (appStateChange?.newValue) {
      const runtimeSnapshot = state.runtime;
      const queueSnapshot = state.queue;
      state = mergeState(createDefaultState(), stripVolatileRuntimeState(appStateChange.newValue));
      state.runtime = runtimeSnapshot;
      state.queue = queueSnapshot;
    }
    const queueLedgerChanged = hasQueueLedgerChange ? applyQueueLedgerStorageSnapshot(queueLedgerChange?.newValue) : false;
    if (queueLedgerChange?.newValue && ["gallery", "live"].includes(activeRoute())) {
      scheduleQueueLedgerRuntimeRefresh();
    }
    const nextSignature = runtimeSurfaceSignature();
    if (document.getElementById("galleryPreviewModal")) return;
    if (["gallery", "live"].includes(activeRoute()) && previousSignature === nextSignature && !queueLedgerChanged) return;
    if (Date.now() < suppressStorageRenderUntil || isLiveEditing()) return;
    render();
  });
}

function bindTabs() {
  // Format Guide lives inside the Control wizard step header (next to History).
  // Use document-level delegation so the rerendered wizard doesn't need to
  // reattach a handler each pass.
  document.addEventListener("click", async (event) => {
    const guideBtn = event.target instanceof Element ? event.target.closest('[data-action="format-guide"]') : null;
    if (!guideBtn) return;
    event.preventDefault();
    await openExternal(chrome.runtime.getURL("sample_prompt_formats.html"));
    appendLog("info", "input", "Opened prompt format guide.");
    await persistState();
  });
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!button.dataset.route) return;
      if (button.dataset.route === activeRoute()) return;
      // Apply the .active class SYNCHRONOUSLY before any awaits so the user
      // sees their selection acknowledged on the very first paint after click.
      // Without this, gallery/live tabs trigger an async hydrate before
      // activateTab runs, leaving the click invisible until mouse-off
      // (user-reported bug: image-v230 — "doesn't turn highlight on until hover off").
      state.ui.activeRoute = button.dataset.route;
      document.querySelectorAll(".tab-button").forEach((b) => {
        b.classList.toggle("active", b.dataset.route === button.dataset.route);
      });
      // Hydrate fresh state for tabs that depend on it. The class is already
      // visible — this just refreshes the data backing the upcoming render.
      if (["gallery", "live"].includes(button.dataset.route)) await hydrateStateFromStorage();
      // Full activateTab still runs to render the tab body + bind handlers.
      activateTab(button.dataset.route);
      await persistState();
      if (button.dataset.route === "gallery") scheduleGalleryAutoSync();
    });
  });
}

function bindHeader() {
  document.getElementById("header-home-btn")?.addEventListener("click", async () => {
    await chrome.storage.local.set({ af_show_runtime_launcher: true });
    window.location.href = chrome.runtime.getURL("src/gateway/gateway.html");
  });
  bindSupportMenu();
  document.getElementById("header-language-btn")?.addEventListener("click", async () => {
    activateTab("settings");
    await persistState();
  });
  document.getElementById("login-button")?.addEventListener("click", async () => {
    activateTab("settings");
    setTimeout(() => document.getElementById("accountSection")?.scrollIntoView({ block: "start" }), 80);
    await persistState();
  });
  document.getElementById("header-usage-pill")?.addEventListener("click", async () => {
    activateTab("settings");
    setTimeout(() => document.getElementById("accountSection")?.scrollIntoView({ block: "start" }), 80);
    await persistState();
  });
  document.getElementById("help-button")?.addEventListener("click", async () => {
    state.ui.helpOpen = true;
    state.ui.activeHelpTopic ||= "text_to_video";
    appendLog("info", "help", "Help Center opened.");
    await persistState();
    render();
  });
}

function bindControlActionDelegate() {
  if (controlActionDelegateBound) return;
  controlActionDelegateBound = true;
  document.addEventListener("click", (event) => {
    const target = event.target?.closest?.("#generate-btn, #addToQueueButton, #mainActionButton");
    if (!target || target.disabled) return;
    if (!document.getElementById("view-control")?.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    target.blur?.();
    if (target.id === "generate-btn") {
      requestEnqueueAndRun();
      return;
    }
    if (target.id === "addToQueueButton") {
      enqueueJobsWithRender();
      return;
    }
    if (target.id === "mainActionButton") {
      runQueue();
    }
  }, true);
}

function bindSupportMenu() {
  const button = document.getElementById("header-support-btn");
  const menu = document.getElementById("support-menu");
  if (!button || !menu || button.dataset.bound === "1") return;
  button.dataset.bound = "1";

  const close = () => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };
  const open = () => {
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
  };
  const toggle = () => {
    if (menu.hidden) open();
    else close();
  };

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggle();
  });
  menu.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  document.getElementById("support-discord-btn")?.addEventListener("click", async () => {
    close();
    appendLog("info", "support", "Discord opened.");
    await openExternal(SUPPORT_LINKS.discord);
    await persistState();
  });
  document.getElementById("support-telegram-btn")?.addEventListener("click", async () => {
    close();
    appendLog("info", "support", "Telegram opened.");
    await openExternal(SUPPORT_LINKS.telegram);
    await persistState();
  });
}

function renderOverlays() {
  document.getElementById("help-center-modal")?.remove();
  document.getElementById("walkthrough-overlay")?.remove();
  document.querySelectorAll(".walkthrough-target").forEach((node) => node.classList.remove("walkthrough-target"));

  if (state.ui.helpOpen) {
    document.body.appendChild(renderHelpCenterModal());
  }
  if (state.ui.walkthrough) {
    const walkthrough = renderWalkthroughOverlay();
    document.body.appendChild(walkthrough);
    bindWalkthroughControls(walkthrough);
    setTimeout(focusWalkthroughTarget, 0);
  }
}

function renderHelpCenterModal() {
  const locale = currentLocale();
  const active = helpTopicById(state.ui.activeHelpTopic) || HELP_TOPICS[0];
  const modal = node("div", { id: "help-center-modal", class: "help-center-backdrop" },
    node("section", { class: "help-center-modal", attrs: { role: "dialog", "aria-modal": "true", "aria-label": translate("helpCenterTitle", {}, locale) } },
      node("header", { class: "help-center-header" },
        node("div", null,
          node("h2", { class: "help-center-title", text: translate("helpCenterTitle", {}, locale) }),
          node("span", { class: "help-center-subtitle", text: translate("duckGuideSubtitle", {}, locale) })
        ),
        node("div", { class: "help-center-actions" },
          node("button", { id: "help-video-tutorial", attrs: { type: "button" } }, iconEl("play_circle"), node("span", { text: translate("videoTutorial", {}, locale) })),
          node("button", { id: "help-discord", attrs: { type: "button" } }, iconEl("forum"), node("span", { text: translate("discord", {}, locale) })),
          node("button", { id: "help-close", class: "help-close", attrs: { type: "button", title: translate("close", {}, locale) } }, iconEl("close"))
        )
      ),
      node("div", { class: "help-center-body" },
        node("nav", { class: "help-topic-list" },
          HELP_TOPICS.map((topic) => node("button", {
            class: `help-topic${topic.id === active.id ? " active" : ""}`,
            data: { helpTopic: topic.id },
            attrs: { type: "button" }
          }, node("span", { text: translate(topic.titleKey, {}, locale) })))
        ),
        node("article", { class: "help-topic-panel" },
          node("div", { class: "duck-guide-card" },
            node("span", { class: "duck-guide-kicker", text: translate("duckGuide", {}, locale) }),
            node("h3", { text: translate(active.titleKey, {}, locale) }),
            node("p", { text: translate(active.bodyKey, {}, locale) })
          ),
          node("ol", { class: "help-step-list" },
            active.steps.map((step) => node("li", null,
              node("strong", { text: translate(step.titleKey, {}, locale) }),
              node("span", { text: translate(step.bodyKey, {}, locale) })
            ))
          ),
          node("button", { id: "help-run-walkthrough", class: "help-walkthrough-btn", attrs: { type: "button" } },
            iconEl("touch_app"),
            node("span", { text: translate("runGuidedWalkthrough", {}, locale) })
          )
        )
      )
    )
  );

  modal.querySelector("#help-close")?.addEventListener("click", () => closeHelpCenter());
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeHelpCenter();
  });
  modal.querySelector("#help-video-tutorial")?.addEventListener("click", () => openExternal("https://www.youtube.com/@duckmartians"));
  modal.querySelector("#help-discord")?.addEventListener("click", () => openExternal("https://discord.gg/duckmartians"));
  modal.querySelector("#help-run-walkthrough")?.addEventListener("click", () => startWalkthrough(active.id));
  modal.querySelectorAll("[data-help-topic]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.ui.activeHelpTopic = button.dataset.helpTopic;
      await persistState();
      render();
    });
  });
  return modal;
}

function renderWalkthroughOverlay() {
  const locale = currentLocale();
  const topic = helpTopicById(state.ui.walkthrough?.topicId) || HELP_TOPICS[0];
  const stepIndex = Math.min(topic.steps.length - 1, Math.max(0, Number(state.ui.walkthrough?.stepIndex || 0)));
  const step = topic.steps[stepIndex] || topic.steps[0];
  return node("div", { id: "walkthrough-overlay", class: "walkthrough-overlay" },
    node("section", { class: "walkthrough-card", attrs: { role: "dialog", "aria-label": translate("walkthrough", {}, locale) } },
      node("div", { class: "walkthrough-kicker", text: `${translate("walkthrough", {}, locale)} ${stepIndex + 1}/${topic.steps.length}` }),
      node("h3", { text: translate(step.titleKey, {}, locale) }),
      node("p", { text: translate(step.bodyKey, {}, locale) }),
      node("div", { class: "walkthrough-controls" },
        node("button", { id: "walkthrough-back", attrs: { type: "button", disabled: stepIndex === 0 ? "disabled" : null } }, translate("back", {}, locale)),
        node("button", { id: "walkthrough-close", attrs: { type: "button" } }, translate("close", {}, locale)),
        node("button", { id: "walkthrough-next", class: "button-primary", attrs: { type: "button" } }, translate(stepIndex === topic.steps.length - 1 ? "finish" : "next", {}, locale))
      )
    )
  );
}

function bindWalkthroughControls(root = document) {
  root.querySelector("#walkthrough-back")?.addEventListener("click", () => advanceWalkthrough(-1));
  root.querySelector("#walkthrough-close")?.addEventListener("click", () => endWalkthrough());
  root.querySelector("#walkthrough-next")?.addEventListener("click", () => advanceWalkthrough(1));
}

function helpTopicById(topicId) {
  return HELP_TOPICS.find((topic) => topic.id === topicId) || null;
}

async function closeHelpCenter() {
  state.ui.helpOpen = false;
  await persistState();
  render();
}

async function openExternal(url) {
  await chrome.tabs.create({ url }).catch((error) => {
    appendLog("warn", "help", `Could not open ${url}: ${error.message}`);
  });
}

async function startWalkthrough(topicId) {
  const topic = helpTopicById(topicId) || HELP_TOPICS[0];
  state.ui.helpOpen = false;
  state.ui.walkthrough = { topicId: topic.id, stepIndex: 0 };
  state.ui.activeRoute = topic.steps[0]?.route || topic.route || "control";
  appendLog("info", "help", `Started walkthrough: ${topic.id}.`);
  await persistState();
  render();
}

async function advanceWalkthrough(delta) {
  const topic = helpTopicById(state.ui.walkthrough?.topicId) || HELP_TOPICS[0];
  const nextIndex = Number(state.ui.walkthrough?.stepIndex || 0) + delta;
  if (nextIndex >= topic.steps.length) {
    await endWalkthrough();
    return;
  }
  state.ui.walkthrough = {
    topicId: topic.id,
    stepIndex: Math.max(0, nextIndex)
  };
  state.ui.activeRoute = topic.steps[state.ui.walkthrough.stepIndex]?.route || state.ui.activeRoute;
  await persistState();
  render();
}

async function endWalkthrough() {
  state.ui.walkthrough = null;
  await persistState();
  render();
}

function focusWalkthroughTarget() {
  const topic = helpTopicById(state.ui.walkthrough?.topicId);
  const step = topic?.steps?.[Number(state.ui.walkthrough?.stepIndex || 0)];
  let target = step?.target ? document.querySelector(step.target) : null;
  if (!target) {
    target = document.querySelector(".view.active .control-section, .view.active .gallery-header, .view.active .settings-subheader, .view.active");
  }
  if (!target) return;
  target.classList.add("walkthrough-target");
  target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus?.({ preventScroll: true });
}

function node(tag, opts, ...kids) {
  const element = document.createElement(tag);
  if (opts) {
    if (opts.id) element.id = opts.id;
    if (opts.class) element.className = opts.class;
    if (opts.text != null) element.textContent = opts.text;
    if (opts.data) {
      for (const [key, value] of Object.entries(opts.data)) element.dataset[key] = value;
    }
    if (opts.attrs) {
      for (const [key, value] of Object.entries(opts.attrs)) {
        if (value == null || value === false) continue;
        element.setAttribute(key, value === true ? "" : value);
      }
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    element.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return element;
}

function iconEl(name) {
  return node("span", { class: "material-symbols-outlined", text: name });
}

function updateHeaderConnection() {
  const pill = document.getElementById("connection-status");
  const text = document.getElementById("connectionStatus");
  if (pill && text) {
    const locale = state.control?.presets?.language || "en";
    pill.classList.toggle("is-ready", state.runtime.connected === true);
    pill.classList.toggle("is-error", Boolean(state.runtime.error));
    text.textContent = state.runtime.connected
      ? translate("flowReady", {}, locale)
      : state.runtime.error
        ? translate("flowError", {}, locale)
        : translate("captureFlow", {}, locale);
  }

  const usagePill = document.getElementById("header-usage-pill");
  const usageText = document.getElementById("header-usage-text");
  const loginButton = document.getElementById("login-button");
  if (!usagePill || !usageText) return;
  const account = state.account || {};
  const usage = account.usage || {};
  const signedIn = account.status === "signed_in";
  const isPro = usage.unlimited === true || String(account.plan || "").toLowerCase() === "pro";
  const limit = Number.isFinite(Number(usage.limit)) ? Number(usage.limit) : 10;
  const used = Number.isFinite(Number(usage.used)) ? Number(usage.used) : 0;
  const usageLocale = state.control?.presets?.language || "en";
  usageText.textContent = isPro
    ? translate("proBadge", {}, usageLocale)
    : signedIn
      ? `${Math.min(used, limit)}/${limit}`
      : translate("login", {}, usageLocale);
  usagePill.classList.toggle("is-pro", isPro);
  usagePill.classList.toggle("is-signed-out", !signedIn);
  usagePill.classList.toggle("is-critical", !isPro && signedIn && Number(usage.remaining || 0) <= 0);
  usagePill.title = signedIn
    ? (isPro ? "Pro account verified" : `${Math.max(0, Number(usage.remaining || 0))} prompts remaining today`)
    : "Sign in to verify Auto Flow access";
  if (loginButton) {
    loginButton.classList.toggle("is-authenticated", signedIn);
    loginButton.title = signedIn ? "Account verified" : "Login";
  }
}

async function send(type, payload = {}) {
  return chrome.runtime.sendMessage(createMessage(type, payload, { source: "sidepanel" }));
}

function authEnvironment() {
  return {
    userAgent: navigator.userAgent,
    screen: {
      width: screen.width,
      height: screen.height
    }
  };
}

async function sendAuth(action, payload = {}) {
  const response = await send(MessageType.AuthCommand, {
    action,
    environment: authEnvironment(),
    ...payload
  });
  if (!response?.payload?.ok) throw new Error(response?.payload?.error || "auth_command_failed");
  applyAuth(response.payload.auth);
  return response.payload.auth;
}

function applyAuth(auth = {}) {
  const account = deriveBillingAccountState(auth);
  state.account = {
    ...state.account,
    status: account.status,
    email: account.email,
    userId: account.userId,
    plan: account.plan,
    rawPlan: account.rawPlan,
    subscriptionStatus: account.subscriptionStatus,
    stripeSubscriptionStatus: account.stripeSubscriptionStatus,
    supabaseSubscriptionStatus: account.supabaseSubscriptionStatus,
    currentPeriodEnd: account.currentPeriodEnd,
    cancelAtPeriodEnd: account.cancelAtPeriodEnd,
    usage: account.usage,
    billingHealth: account.billingHealth,
    billing: account.billing,
    error: null,
    lastCheckedAt: new Date().toISOString()
  };
  // Clear stale checkout/sign-in messages once Pro is verified. These
  // come from sendAccountCode / verifyAccountCode / openCheckout and are
  // transient flow notices — once the subscription is active they should
  // disappear (the PRO chip speaks for itself).
  if (account.hasProAccess) {
    state.account.message = null;
    state.account.pendingCheckout = false;
  }
}

function hasOpenQueueTasks() {
  return (state.queue.items || []).some((item) => !["complete", "done", "failed", "blocked"].includes(String(item.status || "")));
}

function shouldIncludeGalleryInHeartbeat() {
  return Boolean(state.queue.running || hasOpenQueueTasks() || ["gallery", "live"].includes(activeRoute()));
}

function runtimeRefreshDelayMs() {
  if (state.queue.running || hasOpenQueueTasks()) return 3000;
  if (["gallery", "live"].includes(activeRoute())) return 10000;
  return 30000;
}

async function refreshRuntime(options = {}) {
  const includeGallery = options.includeGallery ?? shouldIncludeGalleryInHeartbeat();
  if (!state.runtime.connected || !state.runtime.activeTabId || !state.runtime.projectId) {
    await syncRuntimeFromOpenFlowTab().catch(() => false);
  }
  const response = await send(MessageType.BridgeHealth, {
    lightweight: !includeGallery,
    includeGallery,
    tabId: state.runtime.activeTabId || undefined,
    projectId: state.runtime.projectId || undefined,
    href: state.runtime.pageUrl || undefined,
    title: state.runtime.pageTitle || undefined
  }).catch(() => null);
  const payload = response?.payload || {};
  applyRuntimePayload(payload);
}

function scheduleRuntimeRefresh(delay = runtimeRefreshDelayMs()) {
  if (runtimeRefreshTimer) window.clearTimeout(runtimeRefreshTimer);
  runtimeRefreshTimer = window.setTimeout(async () => {
    await refreshRuntime().catch(() => null);
    scheduleRuntimeRefresh();
  }, delay);
}

function scheduleLiveQueueRefreshBurst() {
  for (const delay of [0, 500, 1500, 3000, 6000]) {
    window.setTimeout(() => {
      if (activeRoute() !== "live") return;
      refreshRuntime({ includeGallery: false }).catch(() => null);
    }, delay);
  }
}

function applyRuntimeFromFlowTab(tab = {}, options = {}) {
  const projectId = projectIdFromFlowUrl(tab.url || "");
  if (!projectId) return false;
  const previousProjectId = String(state.runtime.projectId || "");
  state.runtime = {
    ...state.runtime,
    connected: true,
    activeTabId: tab.id || null,
    projectId,
    pageUrl: String(tab.url || ""),
    pageTitle: String(tab.title || ""),
    bridgeHealthy: false,
    bridgeVersion: "",
    pageHookVersion: "",
    pageHookInstalled: false,
    hasNativeFetch: false,
    bridgeError: null,
    error: null,
    lastSyncAt: new Date().toISOString()
  };
  if (previousProjectId && previousProjectId !== projectId) {
    state.gallery.items = [];
    state.gallery.meta = {
      ...(state.gallery.meta || {}),
      source: "project_changed",
      projectId,
      fetchedAt: new Date().toISOString()
    };
    state.ui.selectedGalleryIds = [];
    state.ui.deleteMarkedGalleryIds = [];
  }
  if (options.persist !== false) persistState().catch(() => null);
  if (options.render !== false) renderUnlessLiveEditing();
  return true;
}

async function syncRuntimeFromOpenFlowTab() {
  if (!chrome.tabs?.query) return false;
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const flowTabs = tabs.filter((tab) => isFlowUrl(tab.url || ""));
  const projectTabs = flowTabs.filter((tab) => projectIdFromFlowUrl(tab.url || ""));
  const activeProjectTab = projectTabs.find((tab) => tab.active) || projectTabs[0];
  if (activeProjectTab) return applyRuntimeFromFlowTab(activeProjectTab, { render: true });
  return false;
}

function bindFlowProjectTabUpdates() {
  if (flowTabUpdatesBound || !chrome.tabs?.onUpdated) return;
  flowTabUpdatesBound = true;
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const nextUrl = changeInfo.url || tab?.url || "";
    if (isFlowUrl(nextUrl) && projectIdFromFlowUrl(nextUrl)) {
      applyRuntimeFromFlowTab({ ...tab, id: tabId, url: nextUrl }, { render: true });
      scheduleRuntimeRefresh(0);
      return;
    }
    if (tabId === state.runtime.activeTabId && changeInfo.url && !isFlowUrl(changeInfo.url)) {
      state.runtime.connected = false;
      state.runtime.error = "Flow project tab changed";
      state.runtime.lastSyncAt = new Date().toISOString();
      renderUnlessLiveEditing();
      scheduleRuntimeRefresh(0);
    }
  });
  chrome.tabs.onActivated?.addListener(({ tabId }) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return;
      if (isFlowUrl(tab.url || "")) {
        applyRuntimeFromFlowTab(tab, { render: true });
        scheduleRuntimeRefresh(0);
      }
    });
  });
  chrome.tabs.onRemoved?.addListener((tabId) => {
    if (tabId !== state.runtime.activeTabId) return;
    state.runtime.connected = false;
    state.runtime.activeTabId = null;
    state.runtime.error = "Flow tab closed";
    state.runtime.lastSyncAt = new Date().toISOString();
    renderUnlessLiveEditing();
    scheduleRuntimeRefresh(0);
  });
}

function applyRuntimePayload(payload = {}, options = {}) {
  const previousSignature = runtimeSurfaceSignature();
  if (payload.runtime && typeof payload.runtime === "object") {
    const nextProjectId = String(payload.runtime.projectId || "");
    const previousProjectId = String(state.runtime.projectId || "");
    state.runtime = {
      ...state.runtime,
      connected: payload.runtime.connected === true,
      activeTabId: payload.runtime.activeTabId || null,
      projectId: nextProjectId,
      pageUrl: String(payload.runtime.pageUrl || ""),
      pageTitle: String(payload.runtime.pageTitle || ""),
      bridgeHealthy: payload.runtime.bridgeHealthy === true,
      bridgeVersion: String(payload.runtime.bridgeVersion || ""),
      pageHookVersion: String(payload.runtime.pageHookVersion || ""),
      pageHookInstalled: payload.runtime.pageHookInstalled === true,
      hasNativeFetch: payload.runtime.hasNativeFetch === true,
      flowPageBlocked: payload.runtime.flowPageBlocked === true,
      flowPageIssue: payload.runtime.flowPageIssue || null,
      bridgeError: friendlyRuntimeError(payload.runtime.bridgeError || null),
      error: friendlyRuntimeError(payload.runtime.error || null),
      lastSyncAt: payload.runtime.lastSyncAt || new Date().toISOString()
    };
    if (nextProjectId && previousProjectId && nextProjectId !== previousProjectId) {
      state.ui.selectedGalleryIds = [];
      state.ui.deleteMarkedGalleryIds = [];
    }
  }
  if (payload.queue) {
    const incomingTasks = Array.isArray(payload.queue.tasks) ? payload.queue.tasks : [];
    const localPreparingItems = (state.queue.items || []).filter((item) => item?.localPreparing === true);
    state.queue.items = incomingTasks.length || !localPreparingItems.length ? incomingTasks : localPreparingItems;
    state.queue.taskLedgerSnapshot = Array.isArray(payload.queue.taskLedgerSnapshot) ? payload.queue.taskLedgerSnapshot : [];
    state.queue.generatedMediaIds = Array.isArray(payload.queue.generatedMediaIds) ? payload.queue.generatedMediaIds : [];
    state.queue.runtimeEvents = Array.isArray(payload.queue.events) ? payload.queue.events.slice(-200) : state.queue.runtimeEvents || [];
  }
  if (payload.gallery) {
    const incomingItems = Array.isArray(payload.gallery.items) ? payload.gallery.items : [];
    const currentItems = Array.isArray(state.gallery.items) ? state.gallery.items : [];
    const preserveOnEmpty = options.preserveGalleryOnEmpty !== false;
    const shouldPreserveCurrent = preserveOnEmpty && currentItems.length > 0 && incomingItems.length === 0;
    state.gallery.items = shouldPreserveCurrent ? currentItems : incomingItems;
    state.gallery.meta = {
      ...(state.gallery.meta || {}),
      ...(payload.gallery.meta || {}),
      preservedExistingItems: shouldPreserveCurrent,
      preservedCount: shouldPreserveCurrent ? currentItems.length : 0
    };
    const current = new Set((state.gallery.items || []).map((item) => item.id));
    state.ui.selectedGalleryIds = (state.ui.selectedGalleryIds || []).filter((id) => current.has(id));
  }
  const runningWasTrue = state.queue.running === true;
  if (typeof payload.queueRunning === "boolean") state.queue.running = payload.queueRunning;
  // Autopilot T2I -> F2V (issue #208). Detect the running -> idle transition
  // and, if a T2I batch armed the autopilot, fire-and-forget a follow-up F2V
  // enqueue. We don't await here so applyRuntimePayload stays synchronous-ish
  // for the rest of its callers; runAutopilotF2VFollowUp handles its own
  // logging + state mutation + render.
  if (runningWasTrue && state.queue.running === false && state.control?.autopilotPendingBatch) {
    runAutopilotF2VFollowUp(state.control.autopilotPendingBatch).catch((error) => {
      appendLog("error", "queue", `Autopilot follow-up crashed: ${error?.message || error || "unknown"}.`);
    });
  }
  if (payload.auth) applyAuth(payload.auth);
  syncRuntimeEvents(payload.events || []);
  const nextSignature = runtimeSurfaceSignature();
  const unchangedLiveSurface = ["gallery", "live"].includes(activeRoute())
    && previousSignature
    && previousSignature === nextSignature
    && lastRuntimeSurfaceSignature === nextSignature;
  lastRuntimeSurfaceSignature = nextSignature;
  if (options.render !== false && !unchangedLiveSurface && !document.getElementById("galleryPreviewModal")) {
    renderUnlessLiveEditing();
  }
}

function friendlyRuntimeError(error = "") {
  const raw = String(error || "").trim();
  if (!raw) return null;
  if (raw === "flow_tab_not_found" || /flow tab not found/i.test(raw)) {
    return translate("flowTabNotFoundGuidance", {}, currentLocale());
  }
  if (raw === "missing_project_id") {
    return translate("flowProjectMissingGuidance", {}, currentLocale());
  }
  return raw;
}

function runtimeSurfaceSignature() {
  return JSON.stringify({
    projectId: state.runtime.projectId || "",
    connected: state.runtime.connected === true,
    bridgeHealthy: state.runtime.bridgeHealthy === true,
    bridgeVersion: state.runtime.bridgeVersion || "",
    pageHookVersion: state.runtime.pageHookVersion || "",
    flowPageBlocked: state.runtime.flowPageBlocked === true,
    flowPageError: state.runtime.flowPageIssue?.message || "",
    bridgeError: state.runtime.bridgeError || "",
    running: state.queue.running === true,
    tasks: (state.queue.items || []).map((task) => ({
      id: task.id,
      status: task.status,
      foundImages: task.foundImages,
      foundVideos: task.foundVideos,
      downloadedCount: task.downloadedCount,
      skippedDownloadCount: task.skippedDownloadCount,
      downloadedMediaIds: task.downloadedMediaIds || [],
      skippedDownloadMediaIds: task.skippedDownloadMediaIds || [],
      downloadErrorMediaIds: task.downloadErrorMediaIds || [],
      mediaIds: task.mediaIds || [],
      outputMediaIds: task.outputMediaIds || [],
      outputs: (task.outputs || []).map((output) => [output.mediaId, output.mediaUrl, output.thumbnailUrl, output.downloadStatus])
    })),
    gallery: (state.gallery.items || []).map((item) => [item.id, item.mediaId, item.mediaUrl, item.thumbnailUrl, item.kind])
  });
}

function syncRuntimeEvents(events = []) {
  for (const event of events) {
    if ([MessageType.BridgeHealth, MessageType.AuthCommand].includes(event.type)) continue;
    if (suppressedRuntimeEventTypes.has(event.type) && !event.error) continue;
    const key = runtimeEventKey(event);
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    appendLog(runtimeLogLevel(event), "runtime", eventMessage(event));
  }
  if (seenEvents.size > 500) {
    const keep = [...seenEvents].slice(-250);
    seenEvents.clear();
    keep.forEach((key) => seenEvents.add(key));
  }
}

function runtimeEventKey(event = {}) {
  const type = String(event.type || "");
  const stableTypes = new Set(["queue.task.done", "queue.start", "queue.stop", "queue.resume_blocked", "queue.task.start", "queue.submit.start", "queue.submit.ok", "queue.submit.failed"]);
  const prefix = stableTypes.has(type) ? "" : `${event.at || ""}:`;
  return `${prefix}${type}:${event.taskId || ""}:${event.status || ""}:${event.error || ""}:${event.fileName || ""}`;
}

function runtimeLogLevel(event = {}) {
  const type = String(event.type || "");
  if (type.includes("error") || type.includes("failed") || type.includes("global_block")) return "error";
  if (type.includes("partial")) return "warn";
  if (type.includes("blocked") || type.includes("dedupe_blocked") || type.includes("resume_blocked")) return "warn";
  return "info";
}

function formatModeLabel(mode = "") {
  const labels = {
    "text-to-image": "Create Image",
    "text-to-video": "Text to Video",
    "image-to-video": "Frame to Video",
    "start-end-image-to-video": "Frame to Video",
    "ingredients-to-video": "Ingredients to Video"
  };
  return labels[String(mode || "")] || String(mode || "task");
}

function formatPathLabel(path = "") {
  const raw = String(path || "").trim();
  if (raw === "dom") return "DOM";
  if (raw === "api") return "API";
  if (raw === "dom_first") return "DOM first";
  if (raw === "dom_fallback") return "API then DOM fallback";
  if (raw === "api_first") return "API first";
  return raw || "selected path";
}

function formatTransportLabel(transport = "") {
  const raw = String(transport || "").trim();
  if (raw === "chrome_debugger") return "Chrome debugger click";
  if (raw === "extension_api_submit") return "extension API submit";
  if (raw === "dom_page_command") return "DOM page command";
  return raw;
}

function formatEventDiagnostic(value = "") {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (value instanceof Error) return String(value.message || value).trim();
  try {
    const parts = [];
    const collect = (entry) => {
      if (entry === null || entry === undefined || entry === "") return;
      if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
        parts.push(String(entry).trim());
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
    return [...new Set(parts.filter(Boolean))].join(" ") || JSON.stringify(value);
  } catch {
    return String(value || "").trim();
  }
}

function formatTaskPosition(event = {}) {
  const index = Number(event.jobIndex);
  const total = Number(event.jobPromptCount || 0);
  if (Number.isFinite(index) && total > 1) return ` ${index + 1}/${total}`;
  return "";
}

function shortTaskId(event = {}) {
  return String(event.taskId || "task").slice(0, 8);
}

function eventMessage(event = {}) {
  if (event.type === "queue.start") return "Queue worker started.";
  if (event.type === "queue.stop") return "Queue worker stopped.";
  if (event.type === "license.cached_pro_allow") return "License server fallback allowed cached active Pro access.";
  if (event.type === "queue.task.start") {
    const refs = Number(event.refCount || 0);
    const outputs = Number(event.repeatCount || 1);
    const details = [
      `${outputs} output${outputs === 1 ? "" : "s"}`,
      refs ? `${refs} ref${refs === 1 ? "" : "s"}` : "",
      event.videoLength ? `${event.videoLength}s` : ""
    ].filter(Boolean).join(", ");
    return `Starting ${formatModeLabel(event.mode)}${formatTaskPosition(event)} via ${formatPathLabel(event.submitPath)}${details ? ` (${details})` : ""}.`;
  }
  if (event.type === "queue.submit.start") {
    return `Submitting ${formatModeLabel(event.mode)}${formatTaskPosition(event)} through ${formatPathLabel(event.path)} path.`;
  }
  if (event.type === "queue.submit.ok") {
    const refs = Number(event.attachedRefs || 0);
    const media = Number(event.mediaIdCount || 0);
    const attachText = event.path === "dom" && refs ? ` ${refs} ref${refs === 1 ? "" : "s"} attached.` : "";
    const transport = formatTransportLabel(event.transport);
    return `${formatPathLabel(event.path)} submit accepted${transport ? ` via ${transport}` : ""} for ${formatModeLabel(event.mode)}. ${media} media id${media === 1 ? "" : "s"} returned.${attachText}`.trim();
  }
  if (event.type === "queue.submit.failed") {
    const reason = formatEventDiagnostic(event.attachError || event.error || event.statusText) || `HTTP ${event.status || 0}`;
    const attachDetails = [
      event.attachStep ? `step=${event.attachStep}` : "",
      event.attachStepError ? `stepError=${event.attachStepError}` : "",
      event.attachRole ? `role=${event.attachRole}` : "",
      event.attachFileName ? `file=${event.attachFileName}` : "",
      event.attachHasDataUrl ? "inlineImage=yes" : ""
    ].filter(Boolean).join(", ");
    return `${formatPathLabel(event.path)} submit failed for ${formatModeLabel(event.mode)}: ${reason}${attachDetails ? ` (${attachDetails})` : ""}`;
  }
  if (event.type === "queue.submit.error") {
    return `${formatPathLabel(event.path)} submit crashed for ${formatModeLabel(event.mode)}: ${formatEventDiagnostic(event.error) || "unknown error"}`;
  }
  if (event.type === "queue.api_backend.dom_fallback") {
    return `API route failed for ${formatModeLabel(event.mode)}: ${formatEventDiagnostic(event.error) || "backend error"}. Trying DOM fallback.`;
  }
  if (event.type === "queue.api_backend.dom_fallback_failed") {
    const dom = formatEventDiagnostic(event.domError);
    return `API route and DOM fallback both failed for ${formatModeLabel(event.mode)}: ${formatEventDiagnostic(event.apiError || event.error) || "backend error"}${dom ? `; DOM: ${dom}` : ""}.`;
  }
  if (event.type === "queue.dom_api_repair") {
    return `DOM path needed API repair for ${formatModeLabel(event.mode)}: ${event.reason || "DOM submit did not produce usable ids"}.`;
  }
  if (event.type === "queue.poll") {
    const complete = Number(event.complete || 0);
    const pending = Number(event.pending || 0);
    const failed = Number(event.failed || 0);
    const total = complete + pending + failed + Number(event.unknown || 0);
    return `Polling ${formatModeLabel(event.mode)} ${complete}/${total || 0} complete${pending ? `, ${pending} pending` : ""}${failed ? `, ${failed} failed` : ""}.`;
  }
  if (event.type === "queue.global_block") {
    return `Queue paused: ${event.failureClass || "global block"} ${event.lastError || ""}`.trim();
  }
  if (event.type === "queue.image_wait") {
    return `Waiting for image outputs ${Number(event.foundImages || 0)}/${Number(event.expectedImages || 0)} (scan ${Number(event.scanIndex || 0)}/${Number(event.maxScans || 0)}).`;
  }
  if (event.type === "queue.image_scan") {
    return event.ok === false
      ? `Image scan failed: ${event.error || "unknown"}`
      : `Image scan found ${Number(event.foundImages || 0)}/${Number(event.expectedImages || 0)} outputs.`;
  }
  if (event.type === "queue.image_reconcile") {
    return `Image outputs reconciled ${Number(event.foundImages || 0)}/${Number(event.expectedImages || 0)}.`;
  }
  if (event.type === "queue.image_partial_complete") {
    return `Image run finished partially: ${Number(event.foundImages || 0)}/${Number(event.expectedImages || 0)} saved, ${Number(event.failedImages || 0)} failed.`;
  }
  if (event.type === "queue.image_settle.done") {
    return `Image settle finished with status ${event.status || "unknown"} (${Number(event.foundImages || 0)}/${Number(event.expectedImages || 0)}).`;
  }
  if (event.type === "queue.submitted") {
    const media = Array.isArray(event.mediaIds) ? event.mediaIds.length : 0;
    const repaired = event.repairedFromDom ? " after API repair" : "";
    const transport = formatTransportLabel(event.transport);
    return `Submitted ${formatModeLabel(event.mode)} ${shortTaskId(event)}${repaired}${transport ? ` via ${transport}` : ""}; ${media} media id${media === 1 ? "" : "s"} captured.`;
  }
  if (event.type === "queue.submit.rejected") {
    const transport = formatTransportLabel(event.transport);
    return `${formatModeLabel(event.mode)} submit rejected${transport ? ` via ${transport}` : ""}: ${formatEventDiagnostic(event.error || event.statusText) || `HTTP ${event.status || 0}`}`;
  }
  if (event.type === "queue.task.done") {
    const status = String(event.status || "unknown");
    if (status === "complete") return `Completed ${shortTaskId(event)}.`;
    if (status === "pending") return `Retry queued for ${shortTaskId(event)} (${event.failureClass || "retryable"}).`;
    if (status === "failed" || status === "blocked") return `${status === "blocked" ? "Blocked" : "Failed"} ${shortTaskId(event)}: ${event.failureClass || event.lastError || "unknown"}.`;
    return `Task ${shortTaskId(event)} is ${status}.`;
  }
  if (event.type === "queue.task.error") return `Queue error ${event.taskId || ""}: ${event.error || ""}`;
  if (event.type === "media.auto_download.start") return `Auto-download starting for ${Number(event.planned || 0)} file${Number(event.planned || 0) === 1 ? "" : "s"} (${event.reason || "completion"}).`;
  if (event.type === "media.auto_download.done") return `Auto-download finished: ${Number(event.downloaded || 0)} downloaded, ${Number(event.skipped || 0)} skipped.`;
  if (event.type === "media.download.dedupe_blocked") return `Skipped duplicate download ${event.fileName || event.mediaId || "media"} (${event.reason || "duplicate"}).`;
  if (event.type === "media.download.filename_suggest") return `Naming download as ${event.fileName || "planned file"}.`;
  if (event.type === "media.upload.start") return `Uploading reference ${event.fileName || "image"}.`;
  if (event.type === "media.upload") return `Uploaded ${event.fileName || "reference"}`;
  if (event.type === "media.upload.error") return `Upload failed ${event.fileName || ""}: ${event.error || ""}`;
  if (event.type === "media.inline_ref_upload.start") return `Uploading inline ref ${event.fileName || "reference"} (${event.role || "ref"}).`;
  if (event.type === "media.inline_ref_upload.ok") return `Inline ref uploaded ${event.fileName || event.mediaId || "reference"}.`;
  if (event.type === "media.api_repair_upload.start") return `API repair uploading ${event.fileName || "reference"} (${event.role || "ref"}).`;
  if (event.type === "media.api_repair_upload.ok") return `API repair uploaded ${event.fileName || event.mediaId || "reference"}.`;
  if (event.type === "media.download") return `Download queued ${event.fileName || event.mediaId || "media"}${event.resolution ? ` (${event.resolution})` : ""}`;
  if (event.type === "media.download.error") return `Download failed ${event.fileName || event.mediaId || "media"}: ${event.error || ""}`;
  return event.type || "runtime event";
}

async function captureFlowProject() {
  const response = await send(MessageType.PageCommand, {
    action: "projectState",
    tabId: state.runtime.activeTabId || undefined,
    timeoutMs: 10000
  }).catch((error) => ({ payload: { error: error.message } }));
  const result = response?.payload?.result;
  const page = result?.result || result;
  if (page?.ok && page.projectId) {
    state.runtime.connected = true;
    state.runtime.activeTabId = response?.payload?.tabId || state.runtime.activeTabId || null;
    state.runtime.projectId = String(page.projectId || "");
    state.runtime.pageUrl = page.href || response?.payload?.url || "";
    state.runtime.pageTitle = page.title || "";
    state.runtime.error = null;
    appendLog("info", "flow", `Connected to Flow project ${state.runtime.projectId || "unknown"}.`);
  } else {
    state.runtime.connected = false;
    state.runtime.error = friendlyRuntimeError(page?.error || response?.payload?.error || (page?.ok ? "missing_project_id" : "Flow tab not found"));
    appendLog("warn", "flow", state.runtime.error);
  }
  await persistState();
  renderUnlessLiveEditing();
  return state.runtime.connected;
}

function bindAfterControl(root) {
  bindControlNoScrollGuards(root);
  bindRefPanel(root, {
    state,
    onAssign: async (role, itemId) => {
      assignReference(role, itemId);
      appendLog("info", "refs", `Assigned ${role}.`);
      await persistState();
      render();
    },
    onImport: importReferenceFiles
  });

  root.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.control.mode = button.dataset.mode;
      coerceVideoPresetsForCurrentMode();
      await persistState();
      render();
      scrollToControlTarget(nextModeTarget(state.control.mode));
    });
  });
  root.querySelectorAll("[data-submit-path]").forEach((button) => {
    button.addEventListener("click", async () => {
      await updatePreset("submitPath", button.dataset.submitPath, { render: false });
      render();
      scrollToControlTarget(nextRouteTarget());
    });
  });
  root.querySelectorAll("[data-video-length]").forEach((button) => {
    button.addEventListener("click", async () => {
      await updatePreset("videoLength", button.dataset.videoLength, { render: false });
      render();
    });
  });
  bindTextInput(root, "#prompts", (value) => {
    state.control.livePrompt = value;
  }, { rerenderMap: true });
  bindTextInput(root, "#characterPrompts", (value) => {
    state.control.characterPromptText = value;
  });
  root.querySelectorAll("[data-ref-clear]").forEach((button) => {
    button.addEventListener("click", () => clearReference(button.dataset.refClear));
  });
  root.querySelector("#captureButton")?.addEventListener("click", () => captureFlowProject());
  root.querySelector("#referenceUploadButton")?.addEventListener("click", () => openReferenceUpload(root));
  root.querySelector("#addRefsToLibraryButton")?.addEventListener("click", () => openReferenceLibraryUpload(root));
  root.querySelector("#characterSourceUploadButton")?.addEventListener("click", () => openCharacterSourceUpload(root));
  root.querySelector("#uploadRefImageBtn")?.addEventListener("click", () => openReferenceUpload(root));
  root.querySelector("#refImageInput")?.addEventListener("change", (event) => {
    const input = event.target;
    const files = input.files;
    const libraryOnly = refImportIntent === "library_only";
    const activeApplyMode = String(state.control.activeApplyMode || "shared");
    const datasetApplyMode = String(input?.dataset?.applyMode || "").trim();
    if (input?.dataset) delete input.dataset.applyMode;
    const intent = libraryOnly
      ? refImportIntent
      : (datasetApplyMode || (refImportIntent === "library" || refImportIntent === "shared" ? activeApplyMode : refImportIntent));
    importReferenceFiles(files, {
      intent,
      activate: libraryOnly ? false : intent === "shared" || intent === "library" || intent === "match" || intent === "chain" || intent === "chain_match",
      saveToLibrary: libraryOnly ? true : undefined
    });
    refImportIntent = "library";
    input.value = "";
  });
  root.querySelector("#refSelectAllBtn")?.addEventListener("click", () => assignLibraryToActiveMode("all"));
  root.querySelector("#refClearMarkedBtn")?.addEventListener("click", () => clearAllReferences());
  root.querySelector("#deleteSelectedRefsBtn")?.addEventListener("click", () => deleteSelectedReferences());
  root.querySelector("#clearRefImagesBtn")?.addEventListener("click", () => clearReferenceLibrary());
  root.querySelector("#clearSelectedRef")?.addEventListener("click", () => clearAllReferences());
  root.querySelectorAll("[data-ref-library-id]").forEach((button) => {
    button.addEventListener("click", () => assignLibraryClick(button.dataset.refLibraryId));
  });
  root.querySelectorAll("[data-ref-delete-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteReferenceImage(button.dataset.refDeleteId);
    });
  });
  root.querySelectorAll("[data-character-source-ref-handle][data-character-source-ref-id]").forEach((button) => {
    button.addEventListener("click", () => selectCharacterSourceRef(button.dataset.characterSourceRefHandle, button.dataset.characterSourceRefId));
  });
  root.querySelectorAll("[data-character-source-clear]").forEach((button) => {
    button.addEventListener("click", () => clearCharacterSourceRef(button.dataset.characterSourceClear));
  });
  root.querySelector("#promptMapToggle")?.addEventListener("change", async (event) => {
    state.control.presets.mapLineRefs = event.target.checked;
    state.control.promptMapOpen = event.target.checked;
    await persistState();
    render();
  });
  root.querySelector("#promptMapHelpBtn")?.addEventListener("click", async () => {
    state.control.promptMapOpen = !state.control.promptMapOpen;
    await persistState();
    render();
  });
  root.querySelector("#assignDoneBtn")?.addEventListener("click", async () => {
    state.control.promptMapOpen = false;
    state.control.promptMapFullscreen = false;
    await persistState();
    render();
  });
  root.querySelector("#assignFullscreenBtn")?.addEventListener("click", async () => {
    state.control.promptMapOpen = true;
    state.control.promptMapFullscreen = !state.control.promptMapFullscreen;
    await persistState();
    render();
  });
  root.querySelector("#taskKeyManagerBtn")?.addEventListener("click", async () => {
    state.control.promptMapOpen = true;
    appendLog("info", "refs", "Task Key Manager is represented by scene tags like [V1-S1] in each prompt row.");
    await persistState();
    render();
  });
  root.querySelectorAll("[data-map-action]").forEach((button) => {
    button.addEventListener("click", () => applyPromptMapAction(button.dataset.mapAction, root));
  });
  root.querySelectorAll("[data-map-ref-id]").forEach((button) => {
    button.addEventListener("click", () => togglePromptMapRef(button.dataset.mapPromptKey, button.dataset.mapRefId, button.dataset.mapFrameSlot));
  });
  root.querySelectorAll("[data-map-pool-ref-id]").forEach((button) => {
    button.addEventListener("click", () => applyPoolRefToPromptRows(button.dataset.mapPoolRefId, root));
  });
  root.querySelector("#samplePromptLink")?.addEventListener("click", () => {
    appendLog("info", "input", "Opened prompt format guide.");
    persistState();
  });
  root.querySelector("#uploadPromptButton")?.addEventListener("click", () => root.querySelector("#fileInput")?.click());
  root.querySelector("#pastePromptButton")?.addEventListener("click", () => pastePromptFromClipboard());
  root.querySelector("#pasteAutoFlowPacketButton")?.addEventListener("click", () => pasteAutoFlowPacketFromClipboard());
  root.querySelector("#applyAutoFlowPacketButton")?.addEventListener("click", () => applyAutoFlowPacket());
  root.querySelector("#cancelAutoFlowPacketButton")?.addEventListener("click", () => cancelAutoFlowPacket());
  root.querySelector("#fileInput")?.addEventListener("change", (event) => importPromptTextFile(event.target));
  root.querySelector("#uploadCharacterPromptButton")?.addEventListener("click", () => root.querySelector("#characterPromptFileInput")?.click());
  root.querySelector("#pasteCharacterPromptButton")?.addEventListener("click", () => pasteCharacterPromptFromClipboard());
  root.querySelector("#pasteAutoFlowPacketButtonCharacter")?.addEventListener("click", () => pasteAutoFlowPacketFromClipboard());
  root.querySelector("#applyAutoFlowPacketButtonCharacter")?.addEventListener("click", () => applyAutoFlowPacket());
  root.querySelector("#cancelAutoFlowPacketButtonCharacter")?.addEventListener("click", () => cancelAutoFlowPacket());
  root.querySelector("#verifyNativeCharactersButton")?.addEventListener("click", () => createOrVerifyNativeCharacters());
  root.querySelector("#characterPromptFileInput")?.addEventListener("change", (event) => importCharacterPromptTextFile(event.target));
  root.querySelector("#uploadImageButton")?.addEventListener("click", () => openReferenceUpload(root, "shared"));
  root.querySelector("#uploadImageOneTimeButton")?.addEventListener("click", () => root.querySelector("#imageInput")?.click());
  root.querySelector("#imageInput")?.addEventListener("change", (event) => importOneToOneBatchReferences(event.target));
  root.querySelectorAll("[data-setting-key]").forEach((field) => {
    const eventName = field.type === "checkbox" || field.tagName === "SELECT" || field.type === "range" ? "change" : "input";
    field.addEventListener(eventName, () => updateSettingFromField(field));
  });
  bindHelpToggle(root, "#imageMultiPromptHelpBtn", "#imageMultiPromptHelpPanel");
  bindHelpToggle(root, "#imageOneTimeHelpBtn", "#imageOneTimeHelpPanel");
  bindHelpToggle(root, "#imageBulkHelpBtn", "#imageBulkHelpPanel");
  bindHelpToggle(root, "#imageSamePromptHelpBtn", "#imageSamePromptHelpPanel");
  root.querySelector("#addToQueueButton")?.addEventListener("click", () => enqueueJobsWithRender());
  root.querySelector("#openQueueButton")?.addEventListener("click", () => root.querySelector("#queueList")?.scrollIntoView({ block: "nearest" }));
  root.querySelector("#mainActionButton")?.addEventListener("click", () => runQueue());
  root.querySelector("#skipJobButton")?.addEventListener("click", () => skipCurrentJob());
  root.querySelector("#stopButton")?.addEventListener("click", () => stopQueue());
  root.querySelector("#clearQueueButton")?.addEventListener("click", () => clearQueue());
  root.querySelector("#autoStartNextJob")?.addEventListener("change", (event) => updatePreset("autoStartNextJob", event.target.checked));
  root.querySelector("#autoRetryFailedToggle")?.addEventListener("change", (event) => updatePreset("autoRetryFailedUntilZero", event.target.checked));
  root.querySelectorAll("[data-queue-action='remove']").forEach((button) => {
    button.addEventListener("click", () => removeQueueItem(button.dataset.queueId));
  });
  root.querySelector("#generate-btn")?.addEventListener("click", () => requestEnqueueAndRun());
  root.querySelector("#run-pending-btn")?.addEventListener("click", () => runQueue());
  root.querySelector("#stop-btn")?.addEventListener("click", () => stopQueue());
  root.querySelector("#clear-queue-btn")?.addEventListener("click", () => clearQueue());
  bindAccountDraftInputs(root);
  root.querySelector("#bannerUpgradeBtn")?.addEventListener("click", () => openCheckout());
  root.querySelector("#bannerSendCodeBtn")?.addEventListener("click", () => sendAccountCode());
  root.querySelector("#bannerVerifyBtn")?.addEventListener("click", () => verifyAccountCode());
}

function bindControlNoScrollGuards(root) {
  if (!root || root.dataset.noScrollGuardsBound === "1") return;
  root.dataset.noScrollGuardsBound = "1";
  root.querySelectorAll("button:not([type])").forEach((button) => {
    button.setAttribute("type", "button");
  });
  root.addEventListener("click", (event) => {
    const target = event.target?.closest?.("button,[role='button']");
    if (!target || !root.contains(target)) return;
    if (target.tagName === "BUTTON" && (!target.getAttribute("type") || target.getAttribute("type") === "submit")) {
      target.setAttribute("type", "button");
    }
    event.preventDefault();
    if (target.id === "generate-btn") {
      requestEnqueueAndRun();
    }
  }, true);
}

function bindAfterGallery(root) {
  return galleryController.bindAfterGallery(root);
}

function bindAfterLiveQueue(root) {
  galleryController.bindAfterGallery(root);
  bindReviewDuckActions(root);
  bindLiveQueueSupportActions(root);
  bindLiveQueueTaskActions(root);
}

function queueTasksForSupportSummary() {
  return Array.isArray(state.queue.taskLedgerSnapshot) && state.queue.taskLedgerSnapshot.length
    ? state.queue.taskLedgerSnapshot
    : (state.queue.items || []);
}

function findQueueTaskForSupportSummary(taskId = "") {
  const id = String(taskId || "").trim();
  return queueTasksForSupportSummary().find((task) => String(task?.id || "") === id)
    || (state.queue.items || []).find((task) => String(task?.id || "") === id)
    || null;
}

async function copySupportSummaryForTask(taskId = "") {
  const task = findQueueTaskForSupportSummary(taskId);
  if (!task) return;
  const summary = buildTaskSupportSummary(task, { tasks: queueTasksForSupportSummary(), version: APP_VERSION });
  await navigator.clipboard.writeText(summary);
  appendLog("info", "support", `Copied support summary for ${task.id || "task"}.`);
}

function bindLiveQueueSupportActions(root) {
  root.querySelectorAll("[data-copy-support-summary]").forEach((button) => {
    button.addEventListener("click", async () => {
      await copySupportSummaryForTask(button.dataset.copySupportSummary);
      await persistState();
      render();
    });
  });
  root.querySelectorAll("[data-quota-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = String(button.dataset.quotaAction || "");
      if (action === "exportReport") {
        await exportDebugReport("support");
        return;
      }
      if (action === "resumeLater") {
        button.closest(".live-quota-modal-backdrop")?.remove();
        appendLog("info", "queue", "Quota modal dismissed. Queue remains paused for later resume.");
        await persistState();
      }
      if (action === "chooseSupportedModel") {
        state.ui.activeRoute = "control";
        button.closest(".live-quota-modal-backdrop")?.remove();
        appendLog("info", "queue", "Opened Control so pending rows can be moved to a supported model.");
        await persistState();
        render();
      }
    });
  });
  root.querySelectorAll("[data-model-access-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = String(button.dataset.modelAccessAction || "");
      if (action === "exportReport") {
        await exportDebugReport("support");
        return;
      }
      if (action === "chooseSupportedModel" || action === "switchPendingRowsToSelectedModel") {
        state.ui.activeRoute = "control";
        button.closest(".live-model-access-modal-backdrop")?.remove();
        appendLog("info", "queue", action === "switchPendingRowsToSelectedModel"
          ? "Opened Control to choose a supported model before switching pending rows."
          : "Opened Control to choose a supported model.");
        await persistState();
        render();
        return;
      }
      if (action === "pause") {
        await stopQueue().catch(() => null);
        button.closest(".live-model-access-modal-backdrop")?.remove();
        appendLog("info", "queue", "Model access modal dismissed. Queue remains paused.");
        await persistState();
        render();
      }
    });
  });
  root.querySelectorAll("[data-api-path-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = String(button.dataset.apiPathAction || "");
      if (action === "exportReport") {
        await exportDebugReport("support");
        return;
      }
      if (action === "continueBrowserMode") {
        await resumeQueue({
          switchApiFirstQuotaSuspectedToDom: true,
          sourceTaskId: button.dataset.apiPathTaskId || ""
        });
        appendLog("info", "queue", "Continuing remaining prompts with browser/DOM mode.");
        return;
      }
      if (action === "pause") {
        await stopQueue().catch(() => null);
        button.closest(".live-api-path-modal-backdrop")?.remove();
        appendLog("info", "queue", "Browser mode prompt dismissed. Queue remains paused.");
        await persistState();
        render();
      }
    });
  });
  root.querySelectorAll("[data-repair-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = String(button.dataset.repairAction || "");
      if (action === "exportReport") {
        await exportDebugReport("support");
        return;
      }
      if (action === "pause") {
        await stopQueue().catch(() => null);
        button.closest(".live-repair-failed-modal-backdrop")?.remove();
        appendLog("info", "queue", "Repair failed modal dismissed. Queue remains paused.");
        await persistState();
        render();
      }
    });
  });
}

function bindReviewDuckActions(root) {
  root.querySelectorAll("[data-review-duck-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = String(button.dataset.reviewDuckAction || "");
      if (action === "exportReport") {
        await exportDebugReport("support");
        return;
      }
      const url = REVIEW_DUCK_ACTION_LINKS[action];
      if (!url) return;
      appendLog("info", action === "chromeStore" ? "review" : "support", action === "chromeStore" ? "Review link opened." : "Support link opened.");
      await openExternal(url);
    });
  });
}

function taskForSupportAction(taskId = "") {
  const id = String(taskId || "").trim();
  return (state.queue?.taskLedgerSnapshot || []).find((task) => String(task.id || "") === id)
    || (state.queue?.items || []).find((task) => String(task.id || "") === id)
    || null;
}

function buildSavedReferenceTaskSupportSummary(task = {}) {
  const fileName = task.userActionRequiredReferenceFileName || task.refInputs?.[0]?.fileName || "";
  return [
    "Auto Flow support summary",
    `Task: ${task.id || ""}`,
    `Mode: ${task.mode || ""}`,
    `Model: ${task.model || ""}`,
    `Submit path: ${task.submitPath || task.submitPathPreference || ""}`,
    `Failure class: ${task.failureClass || ""}`,
    `Title: ${task.userFacingFailureTitle || ""}`,
    `File: ${fileName}`,
    `Original error: ${task.apiBackendError || task.lastError || ""}`,
    `Recovery: ${task.finalFallbackOutcome || ""}`,
    `Original ref mediaId: ${task.originalRefMediaId || ""}`,
    `Original blobStoreId: ${task.originalBlobStoreId || ""}`,
    `Missing asset row mediaId: ${task.missingAssetRowMediaId || ""}`,
    `Re-upload attempted: ${task.refReuploadAttempted === true}`,
    `Re-upload succeeded: ${task.refReuploadSucceeded === true}`,
    `Replacement ref mediaId: ${task.replacementRefMediaId || ""}`,
    `Uploaded ref IDs: ${(task.uploadedRefIds || []).join(",")}`,
    `DOM fallback after re-upload: ${task.domFallbackAfterRefReupload === true}`,
    `Last error: ${task.lastError || ""}`
  ].join("\n");
}

function bindLiveQueueTaskActions(root) {
  root.querySelectorAll("[data-live-task-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = String(button.dataset.liveTaskAction || "");
      const task = taskForSupportAction(button.dataset.taskId || "");
      if (action === "exportReport") {
        await exportDebugReport("support");
        return;
      }
      if (action === "copySupportSummary") {
        await navigator.clipboard.writeText(buildSavedReferenceTaskSupportSummary(task || {}));
        appendLog("info", "support", "Copied task support summary.");
        return;
      }
      if (action === "retryBrowserMode") {
        await resumeQueue({ browserModeTaskId: task?.id || button.dataset.taskId || "" });
        return;
      }
      if (action === "reuploadReference") {
        state.ui.activeRoute = "control";
        appendLog("warn", "refs", `Re-upload the missing reference${task?.userActionRequiredReferenceFileName ? `: ${task.userActionRequiredReferenceFileName}` : ""}, then retry with browser mode.`);
        await persistState();
        render();
      }
    });
  });
}

function syncGallery(options = {}) {
  return galleryController.syncGallery(options);
}

function bindAfterHistory(root) {
  root.querySelector("#history-clear-btn")?.addEventListener("click", async () => {
    state.history.runs = [];
    appendLog("info", "history", "Cleared prompt history.");
    await persistState();
    render();
  });
  root.querySelectorAll("[data-history-restore]").forEach((button) => {
    button.addEventListener("click", async () => {
      await restoreHistoryRun(button.dataset.historyRestore);
    });
  });
  root.querySelectorAll("[data-history-run]").forEach((button) => {
    button.addEventListener("click", async () => {
      await restoreHistoryRun(button.dataset.historyRun, { runNow: true });
    });
  });
  root.querySelectorAll("[data-history-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = String(button.dataset.historyDelete || "");
      state.history.runs = (state.history.runs || []).filter((run) => run.id !== id);
      appendLog("info", "history", "Deleted history item.");
      await persistState();
      render();
    });
  });
}

function modeTitle(mode = "") {
  if (mode === FLOW_MODES.textToImage) return "Create Image";
  if (mode === FLOW_MODES.textToVideo) return "Text to Video";
  if (mode === FLOW_MODES.imageToVideo) return "Frame to Video";
  if (mode === FLOW_MODES.ingredientsToVideo) return "Ingredients";
  return "Auto Flow";
}

function activeHistoryRefIds() {
  const ids = new Set();
  for (const id of oneToOneBatchRefIds()) ids.add(id);
  for (const role of Object.keys(state.control.references || {})) {
    for (const id of refIdsForRoles([role])) ids.add(id);
  }
  for (const value of Object.values(state.control.promptRefMap || {})) {
    if (!Array.isArray(value)) continue;
    for (const id of value) {
      const trimmed = String(id || "").trim();
      if (trimmed) ids.add(trimmed);
    }
  }
  return [...ids];
}

function buildRunHistorySnapshot() {
  const promptsText = String(state.control.livePrompt || "").trim();
  const prompts = promptLines();
  if (!promptsText || !prompts.length) return null;
  const byId = new Map(allReferenceItems().map((item) => [item.id, item]));
  const refs = activeHistoryRefIds()
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((item) => ({
      id: String(item.id || ""),
      blobStoreId: String(item.blobStoreId || ""),
      title: String(item.title || item.fileName || "Reference"),
      fileName: String(item.fileName || item.title || "reference.png"),
      mediaId: String(item.mediaId || ""),
      imageUrl: String(item.imageUrl || item.mediaUrl || "")
    }));
  return {
    id: crypto.randomUUID(),
    title: `${modeTitle(state.control.mode)} - ${prompts.length} prompt${prompts.length === 1 ? "" : "s"}`,
    mode: state.control.mode,
    promptCount: prompts.length,
    promptsText,
    createdAt: new Date().toISOString(),
    projectId: String(state.runtime.projectId || ""),
    refs,
    control: {
      mode: state.control.mode,
      livePrompt: promptsText,
      characterPromptText: String(state.control.characterPromptText || ""),
      promptTab: String(state.control.promptTab || "workflow_prompts"),
      referencesTab: String(state.control.referencesTab || "prompt_references"),
      runMappingTab: String(state.control.runMappingTab || "prompt_mapping"),
      wizardStep: Number(state.control.wizardStep || 1),
      promptMapOpen: Boolean(state.control.promptMapOpen),
      promptMapFullscreen: false,
      promptRefMap: structuredClone(state.control.promptRefMap || {}),
      oneToOneBatchRefIds: [...oneToOneBatchRefIds()],
      references: structuredClone(state.control.references || {}),
      characterSources: structuredClone(state.control.characterSources || {}),
      activeApplyMode: String(state.control.activeApplyMode || "shared"),
      presets: structuredClone(state.control.presets || {})
    }
  };
}

function rememberCurrentRun() {
  const snapshot = buildRunHistorySnapshot();
  return rememberRunSnapshot(snapshot);
}

function rememberRunSnapshot(snapshot) {
  if (!snapshot) return false;
  state.history ||= { runs: [] };
  state.history.runs = [
    snapshot,
    ...(state.history.runs || []).filter((run) => run.promptsText !== snapshot.promptsText || run.mode !== snapshot.mode)
  ].slice(0, 50);
  return true;
}

function clearActiveRunDraft() {
  state.control.livePrompt = "";
  state.control.characterPromptText = "";
  state.control.promptTab = "workflow_prompts";
  state.control.referencesTab = "prompt_references";
  state.control.runMappingTab = "prompt_mapping";
  state.control.wizardStep = 1;
  state.control.promptMapOpen = false;
  state.control.promptMapFullscreen = false;
  state.control.promptRefMap = {};
  state.control.oneToOneBatchRefIds = [];
  state.control.transientReferenceItems = [];
  state.control.characterSources = {};
  state.control.references = {
    imagePromptRefs: "",
    styleRefRefs: "",
    omniRefRefs: "",
    startFrameRef: "",
    endFrameRef: "",
    ingredientsRefs: ""
  };
}

function ensureHistoryRefsInLibrary(run = {}) {
  const known = new Set((state.referenceLibrary.savedItems || []).map((item) => item.id));
  const missing = (run.refs || []).filter((ref) => ref?.id && !known.has(ref.id));
  if (!missing.length) return;
  state.referenceLibrary.savedItems = [
    ...missing.map((ref) => ({
      id: ref.id,
      blobStoreId: ref.blobStoreId || "",
      title: ref.title || ref.fileName || "Reference",
      fileName: ref.fileName || ref.title || "reference.png",
      mediaId: ref.mediaId || "",
      imageUrl: ref.imageUrl || "",
      mediaUrl: ref.imageUrl || "",
      mimeType: "image/png",
      restoredFromHistory: true
    })),
    ...(state.referenceLibrary.savedItems || [])
  ].slice(0, 100);
}

async function restoreHistoryRun(historyId, { runNow = false } = {}) {
  const run = (state.history?.runs || []).find((item) => item.id === historyId);
  if (!run?.control) return;
  ensureHistoryRefsInLibrary(run);
  state.control = {
    ...state.control,
    ...structuredClone(run.control),
    livePrompt: String(run.control.livePrompt || run.promptsText || ""),
    wizardStep: runNow ? 3 : Math.max(1, Number(run.control.wizardStep || 1))
  };
  state.ui.activeRoute = "control";
  appendLog("info", "history", runNow ? "Restored history item and starting run." : "Restored history item for editing.");
  await persistState();
  render();
  if (runNow) await enqueueAndRun();
}

function updateSceneClip(clipId, action) {
  const clips = [...(state.scenes.clips || [])].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  const index = clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) return;
  const removedIds = new Set();
  if (action === "remove") {
    const [removed] = clips.splice(index, 1);
    if (removed?.id) removedIds.add(removed.id);
  } else if (action === "up" && index > 0) {
    [clips[index - 1], clips[index]] = [clips[index], clips[index - 1]];
  } else if (action === "down" && index < clips.length - 1) {
    [clips[index + 1], clips[index]] = [clips[index], clips[index + 1]];
  }
  state.scenes.clips = renumberSceneClips(clips);
  state.scenes.selectedClipIds = (state.scenes.selectedClipIds || []).filter((id) => !removedIds.has(id));
  state.scenes.totalDuration = totalSceneDuration(state.scenes.clips);
  state.scenes.updatedAt = new Date().toISOString();
}

function selectedSceneClips() {
  const selected = new Set(state.scenes?.selectedClipIds || []);
  return (state.scenes?.clips || [])
    .filter((clip) => selected.has(clip.id))
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
}

async function handleSceneActionFailure(error, action) {
  appendLog("error", "scenes", `Scene Builder ${action} failed: ${error?.message || error}`);
  await persistState();
  render();
}

async function selectSceneAssetsInGallery() {
  const clips = selectedSceneClips();
  const galleryIds = sceneGallerySelectionIds(clips);
  if (!galleryIds.length) return;
  state.ui.selectedGalleryIds = [...new Set(galleryIds)];
  state.ui.galleryTab = "videos";
  state.ui.activeRoute = "gallery";
  appendLog("info", "scenes", `Scene Builder: selected ${galleryIds.length} gallery video${galleryIds.length === 1 ? "" : "s"}.`);
  await persistState();
  render();
}

function bindAfterSettings(root) {
  bindAccountSettings(root);
  root.querySelectorAll("[data-submit-path]").forEach((button) => {
    button.addEventListener("click", () => updatePreset("submitPath", button.dataset.submitPath));
  });
  root.querySelectorAll("[data-video-length]").forEach((button) => {
    button.addEventListener("click", () => updatePreset("videoLength", button.dataset.videoLength));
  });
  root.querySelector("#setting-map-line-refs")?.addEventListener("change", async (event) => {
    state.control.presets.mapLineRefs = event.target.checked;
    await persistState();
  });
  root.querySelector("#setting-auto-download")?.addEventListener("change", async (event) => {
    state.control.presets.autoDownload = event.target.checked;
    await persistState();
  });
  root.querySelectorAll("[data-setting-key]").forEach((field) => {
    const eventName = field.type === "checkbox" || field.tagName === "SELECT" || field.type === "range" ? "change" : "input";
    field.addEventListener(eventName, () => updateSettingFromField(field));
  });
  root.querySelector("#openDownloadsSettingsLink")?.addEventListener("click", (event) => {
    event.preventDefault();
    openChromeSettings("chrome://settings/downloads", "downloads");
  });
  // Maintenance buttons get inline feedback so users see when their click
  // takes effect (the underlying actions log to the Logs tab; users don't see
  // that tab during routine use).
  root.querySelector("#clearFlowCacheBtn")?.addEventListener("click", (e) => {
    runWithButtonFeedback(e.currentTarget, () => runMaintenanceAction("clear_flow_cache"), {
      busyText: "Clearing cache...", doneText: "Cache cleared + reloaded", failText: "Clear failed",
    });
  });
  root.querySelector("#clearFlowCookiesBtn")?.addEventListener("click", (e) => {
    runWithButtonFeedback(e.currentTarget, () => runMaintenanceAction("clear_flow_cookies"), {
      busyText: "Clearing cookies...", doneText: "Cookies cleared + reloaded", failText: "Clear failed",
    });
  });
  root.querySelector("#clearAllFlowDataBtn")?.addEventListener("click", (e) => {
    runWithButtonFeedback(e.currentTarget, () => runMaintenanceAction("clear_all_flow_data"), {
      busyText: "Clearing all Flow data...", doneText: "Flow data cleared + reloaded", failText: "Clear failed",
    });
  });
}

function bindAfterLogs(root) {
  requestAnimationFrame(() => {
    const logDisplay = root.querySelector("#logDisplay");
    if (logDisplay) logDisplay.scrollTop = logDisplay.scrollHeight;
  });
  root.querySelector("#clear-logs-btn")?.addEventListener("click", async () => {
    state.logs.items = [];
    await persistState();
    render();
  });
  root.querySelector("#copy-logs-btn")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(root.querySelector("#logOutput")?.textContent || "");
  });
  root.querySelector("#export-logs-btn")?.addEventListener("click", () => {
    downloadTextFile(`autoflow-logs-${Date.now()}.txt`, root.querySelector("#logOutput")?.textContent || "", "text/plain");
  });
  root.querySelector("#copyDebugReportBtn")?.addEventListener("click", async () => {
    const fileName = buildReportFileName();
    downloadTextFile(fileName, buildDebugReport(), "text/markdown");
    appendLog("info", "logs", `Debug report exported: ${fileName}.`);
    await persistState();
    render();
  });
}

function bindAfterScenes(root) {
  root.querySelector("#sceneBuilderSelectAllBtn")?.addEventListener("click", async () => {
    state.scenes.selectedClipIds = (state.scenes.clips || []).map((clip) => clip.id);
    await persistState();
    render();
  });
  root.querySelector("#sceneBuilderDeselectAllBtn")?.addEventListener("click", async () => {
    state.scenes.selectedClipIds = [];
    await persistState();
    render();
  });
  root.querySelector("#sceneBuilderSelectGalleryBtn")?.addEventListener("click", () => {
    selectSceneAssetsInGallery().catch((error) => handleSceneActionFailure(error, "Gallery selection"));
  });
  root.querySelector("#sceneBuilderClearBtn")?.addEventListener("click", async () => {
    state.scenes.clips = [];
    state.scenes.selectedClipIds = [];
    state.scenes.totalDuration = 0;
    state.scenes.updatedAt = new Date().toISOString();
    appendLog("info", "scenes", "Scene Builder cleared.");
    await persistState();
    render();
  });
  root.querySelectorAll("[data-scene-select-id]").forEach((input) => {
    input.addEventListener("change", async () => {
      const ids = new Set(state.scenes.selectedClipIds || []);
      if (input.checked) ids.add(input.dataset.sceneSelectId);
      else ids.delete(input.dataset.sceneSelectId);
      const validIds = new Set((state.scenes.clips || []).map((clip) => clip.id));
      state.scenes.selectedClipIds = [...ids].filter((id) => validIds.has(id));
      await persistState();
      render();
    });
  });
  root.querySelectorAll("[data-scene-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      updateSceneClip(button.dataset.sceneClipId, button.dataset.sceneAction);
      await persistState();
      render();
    });
  });
}

function bindAccountSettings(root) {
  bindAccountDraftInputs(root);
  root.querySelector("#authSendLinkBtn")?.addEventListener("click", () => sendAccountCode());
  root.querySelector("#authVerifyBtn")?.addEventListener("click", () => verifyAccountCode());
  root.querySelector("#refreshLicenseBtn")?.addEventListener("click", () => refreshAccount());
  root.querySelector("#authSignOutBtn")?.addEventListener("click", async () => {
    await sendAuth("sign_out");
    state.account.status = "signed_out";
    appendLog("info", "account", "Signed out.");
    await persistState();
    render();
  });
  root.querySelectorAll("[data-billing-action='manage']").forEach((button) => {
    button.addEventListener("click", () => manageSubscription());
  });
}

function bindAccountDraftInputs(root) {
  root.querySelectorAll("#authEmailInput, #bannerEmailInput").forEach((input) => {
    input.addEventListener("input", async () => {
      state.account.email = input.value.trim() || null;
      state.account.error = null;
      await persistState({ suppressStorageRender: true });
    });
  });
  root.querySelectorAll("#authOtpInput, #bannerOtpInput").forEach((input) => {
    input.addEventListener("input", async () => {
      state.account.otpCode = input.value.trim();
      state.account.error = null;
      await persistState({ suppressStorageRender: true });
    });
  });
}

function bindTextInput(root, selector, onInput, options = {}) {
  const input = root.querySelector(selector);
  if (!input) return;
  input.addEventListener("input", async () => {
    onInput(input.value);
    await persistState({ suppressStorageRender: true });
    if (options.rerenderMap) {
      window.clearTimeout(promptInputRenderTimer);
      promptInputRenderTimer = window.setTimeout(() => {
        if (activeRoute() === "control" && state.control.promptMapOpen) {
          render();
        } else {
          const summary = document.querySelector("#promptInlineSummary");
          if (summary) {
            const promptCount = promptLines().length;
            const activeRefs = mappingSourceIdsForMode().length;
            const mappedRows = Object.keys(state.control.promptRefMap || {}).length;
            summary.textContent = `${promptCount} prompts \u2022 ${activeRefs} refs active \u2022 ${mappedRows} mapped`;
          }
        }
      }, 180);
    }
  });
}

function bindHelpToggle(root, buttonSelector, panelId) {
  root.querySelector(buttonSelector)?.addEventListener("click", async () => {
    const normalizedPanelId = String(panelId || "").replace(/^#/, "");
    if (!normalizedPanelId) return;
    state.ui.openInlineHelpPanel = state.ui.openInlineHelpPanel === normalizedPanelId ? "" : normalizedPanelId;
    await persistState();
    render();
  });
}

async function updatePreset(key, value, options = {}) {
  state.control.presets[key] = value;
  coerceVideoPresetsForCurrentMode();
  syncDownloadFolderPresetMetadata(key);
  if (key === "submitPathPreference") {
    state.control.presets.submitPath = value === "dom_first" ? "dom_first" : "api_first";
  }
  if (key === "submitPath") {
    state.control.presets.submitPathPreference = value === "dom_first" ? "dom_first" : "api_first";
  }
  if (key === "language") {
    logLocaleDiagnostics(value);
  }
  await persistState();
  if (options.render !== false) render();
}

async function updateSettingFromField(field) {
  const key = field.dataset.settingKey;
  if (!key) return;
  let value = field.type === "checkbox" ? field.checked : field.value;
  if (String(key).startsWith("characterSource:")) {
    const [, handle, sourceKey] = String(key).split(":");
    if (handle && sourceKey) {
      state.control.characterSources ||= {};
      state.control.characterSources[handle] = {
        ...(state.control.characterSources[handle] || {}),
        [sourceKey]: value
      };
      await persistState();
      render();
    }
    return;
  }
  if (field.type === "number" || field.type === "range") value = Number.parseInt(value, 10);
  if (key === "returnSilentVideos") value = value !== false && value !== "false";
  state.control.presets[key] = value;
  coerceVideoPresetsForCurrentMode();
  syncDownloadFolderPresetMetadata(key);
  if (key === "submitPathPreference") {
    state.control.presets.submitPath = value === "dom_first" ? "dom_first" : "api_first";
  }
  if (key === "submitPath") {
    state.control.presets.submitPathPreference = value === "dom_first" ? "dom_first" : "api_first";
  }
  if (key === "language") {
    logLocaleDiagnostics(value);
  }
  if (key === "t2iBatchSize") {
    const label = document.getElementById("t2iBatchSizeValue");
    if (label) label.textContent = String(value);
  }
  if (String(key || "").startsWith("filename") || key === "downloadFolder") {
    const preview = document.getElementById("filenameStylePreviewValue");
    if (preview) preview.textContent = filenamePreviewForPresets(state.control.presets);
  }
  const tag = String(field.tagName || "").toUpperCase();
  const shouldRerenderForDependentControls = key === "model" || key === "ingredientsModel" || key === "imageModel";
  const liveEdit = !shouldRerenderForDependentControls && (tag === "SELECT" || (field.type !== "checkbox" && field.type !== "range"));
  await persistState({ suppressStorageRender: liveEdit });
  if (!liveEdit) render();
}

function isOmniVideoModel(value = "") {
  return /^(omni_flash|omni|abra)$/i.test(String(value || "").trim());
}

function allowedVideoLengthsForCurrentMode(mode = state.control.mode) {
  const presets = state.control.presets || {};
  if (mode === FLOW_MODES.ingredientsToVideo) {
    return isOmniVideoModel(presets.ingredientsModel) ? ["4", "6", "8", "10"] : ["8"];
  }
  if (mode === FLOW_MODES.textToVideo) {
    return isOmniVideoModel(presets.model) ? ["4", "6", "8", "10"] : ["4", "6", "8"];
  }
  if (mode === FLOW_MODES.imageToVideo) return isOmniVideoModel(presets.model) ? ["4", "6", "8", "10"] : ["4", "6", "8"];
  return ["4", "6", "8"];
}

function coerceVideoPresetsForCurrentMode(mode = state.control.mode) {
  const presets = state.control.presets || {};
  const allowed = allowedVideoLengthsForCurrentMode(mode);
  const videoLength = String(presets.videoLength || "8");
  if (!allowed.includes(videoLength)) {
    presets.videoLength = allowed.includes("8") ? "8" : allowed[0];
  }
}

function syncDownloadFolderPresetMetadata(changedKey = "") {
  const presets = state.control.presets || {};
  const base = String(presets.downloadFolder || "Auto-Flow").trim() || "Auto-Flow";
  if (changedKey === "downloadFolder" || presets.downloadFolderLastBase !== base) {
    presets.downloadFolderRunIndex = 0;
    presets.downloadFolderLastBase = base;
  }
  if (changedKey === "autoNumberFolder") {
    presets.downloadFolderLastBase = base;
  }
}

function filenamePreviewForPresets(presets = {}) {
  const sep = presets.filenameTemplateSeparator === "-" ? "-" : "_";
  const style = String(presets.filenameStyle || "detailed");
  if (style === "prompt_prefix") return "white-cat-standing-on_01_A.png";
  if (style === "auto_flow") return "V99-S4_A_grey-cat-upside-down.jpeg";
  if (style === "custom_template") {
    const pieces = [];
    if (presets.filenameTemplatePrefix) pieces.push(String(presets.filenameTemplatePrefix));
    if (presets.filenameTemplateIndex !== "none") pieces.push(presets.filenameTemplateIndex === "n" ? "1" : presets.filenameTemplateIndex === "nnn" ? "001" : "01");
    if (presets.filenameTemplatePromptPart !== "none") pieces.push(presets.filenameTemplatePromptPart === "first_word" ? "white" : "white-cat-standing-on");
    if (presets.filenameTemplateDate === "yyyymmdd") pieces.push("20260427");
    if (presets.filenameTemplateDate === "yymmdd_hhmm") pieces.push("260427_1430");
    if (presets.filenameTemplateSuffix === "rand4") pieces.push("a7f2");
    if (presets.filenameTemplateSuffix === "rand8") pieces.push("a7f2c91b");
    return `${pieces.length ? pieces.join(sep) : "01_white-cat-standing-on"}.png`;
  }
  return "01_A_white-cat-standing-on.png";
}

function logLocaleDiagnostics(locale) {
  const diagnostics = localeDiagnostics(locale);
  appendLog(
    diagnostics.fallback ? "warn" : "info",
    "i18n",
    diagnostics.fallback
      ? `Language ${diagnostics.locale} uses tested English fallback (${diagnostics.total} keys).`
      : `Language ${diagnostics.locale} coverage ${diagnostics.translated}/${diagnostics.total}.`
  );
}

function openReferenceUpload(root, forcedMode = "") {
  if (state.control.mode === FLOW_MODES.textToVideo) {
    appendLog("warn", "refs", "Text to Video does not use image references.");
    persistState();
    render();
    return;
  }
  const applyMode = forcedMode || state.control.activeApplyMode || "shared";
  if (applyMode === "batch" || applyMode === "repeat") {
    state.control.activeApplyMode = applyMode;
    refImportIntent = applyMode;
    const input = root.querySelector("#imageInput");
    if (input?.dataset) input.dataset.applyMode = applyMode;
    clickFileInputWithoutScroll(input);
    return;
  }
  state.control.activeApplyMode = applyMode;
  refImportIntent = applyMode === "match" || applyMode === "chain" || applyMode === "chain_match" ? applyMode : "shared";
  clickFileInputWithoutScroll(root.querySelector("#refImageInput"));
}

function openReferenceLibraryUpload(root) {
  if (state.control.mode === FLOW_MODES.textToVideo) {
    appendLog("warn", "refs", "Text to Video does not use image references.");
    persistState();
    render();
    return;
  }
  refImportIntent = "library_only";
  clickFileInputWithoutScroll(root.querySelector("#refImageInput"));
}

function openCharacterSourceUpload(root) {
  refImportIntent = "library_only";
  clickFileInputWithoutScroll(root.querySelector("#refImageInput"));
}

async function selectCharacterSourceRef(handle = "", refId = "") {
  const cleanHandle = String(handle || "").trim().toLowerCase();
  const cleanRefId = String(refId || "").trim();
  if (!cleanHandle || !cleanRefId) return;
  const item = [...(state.control.transientReferenceItems || []), ...(state.referenceLibrary?.savedItems || [])]
    .find((ref) => String(ref?.id || "") === cleanRefId);
  state.control.characterSources ||= {};
  state.control.characterSources[cleanHandle] = {
    ...(state.control.characterSources[cleanHandle] || {}),
    sourceMode: "reference_library",
    sourceRefId: cleanRefId,
    sourceMediaId: String(item?.mediaId || ""),
    status: CharacterFailureClass.characterAssetCreatedButNotNativeCharacter,
    setupStatus: CharacterFailureClass.characterAssetCreatedButNotNativeCharacter
  };
  appendLog("info", "characters", `Selected source image for @${cleanHandle}.`);
  await persistState();
  render();
}

async function clearCharacterSourceRef(handle = "") {
  const cleanHandle = String(handle || "").trim().toLowerCase();
  if (!cleanHandle) return;
  state.control.characterSources ||= {};
  state.control.characterSources[cleanHandle] = {
    ...(state.control.characterSources[cleanHandle] || {}),
    sourceRefId: "",
    sourceMediaId: "",
    status: ""
  };
  appendLog("info", "characters", `Cleared source image for @${cleanHandle}.`);
  await persistState();
  render();
}

function activeReferenceRoleForMode() {
  if (state.control.mode === FLOW_MODES.textToImage) return "imagePromptRefs";
  if (state.control.mode === FLOW_MODES.ingredientsToVideo) return "ingredientsRefs";
  if (state.control.mode === FLOW_MODES.imageToVideo) return "startFrameRef";
  return "imagePromptRefs";
}

async function assignLibraryClick(itemId) {
  if (!itemId) return;
  const changed = assignReferenceForActiveMode(itemId);
  if (changed) appendLog("info", "refs", "Updated active reference image.");
  await persistState();
  render();
}

async function assignLibraryToActiveMode(scope) {
  const items = state.referenceLibrary.savedItems || [];
  if (!items.length) return;
  if (state.control.activeApplyMode !== "batch") {
    state.control.oneToOneBatchRefIds = [];
  }
  state.control.promptRefMap = {};
  if (state.control.mode === FLOW_MODES.textToVideo) {
    appendLog("warn", "refs", "Text to Video does not use image references.");
    await persistState();
    render();
    return;
  }
  if (state.control.activeApplyMode === "batch") {
    for (const key of Object.keys(state.control.references || {})) {
      state.control.references[key] = "";
    }
    state.control.oneToOneBatchRefIds = items.map((item) => item.id).filter(Boolean).slice(0, 500);
    state.control.presets.mapLineRefs = true;
    state.control.promptMapOpen = true;
  } else if (scope === "all" && state.control.mode === FLOW_MODES.imageToVideo) {
    state.control.references.startFrameRef = items[0]?.id || "";
    state.control.references.endFrameRef = items[1]?.id || "";
  } else if (scope === "all" && state.control.mode === FLOW_MODES.ingredientsToVideo) {
    state.control.references.ingredientsRefs = items.slice(0, 3).map((item) => item.id).join("\n");
  } else {
    const limit = referenceLimitForMode(state.control.mode);
    state.control.references[activeReferenceRoleForMode()] = items.slice(0, limit).map((item) => item.id).join("\n");
  }
  appendLog("info", "refs", `Selected ${activeReferenceIdsForMode().length} reference image${activeReferenceIdsForMode().length === 1 ? "" : "s"}.`);
  await persistState();
  render();
}

async function clearAllReferences() {
  for (const key of Object.keys(state.control.references || {})) {
    state.control.references[key] = "";
  }
  state.control.oneToOneBatchRefIds = [];
  state.control.promptRefMap = {};
  state.control.transientReferenceItems = [];
  appendLog("info", "refs", "Cleared active references.");
  await persistState();
  render();
}

async function applyPromptMapAction(action, root) {
  const prompts = promptLines();
  const sourceIds = mappingSourceIdsForMode(state.control.mode);
  const selectedKeys = selectedPromptMapKeys(root, prompts);
  const targetKeys = selectedKeys.length ? selectedKeys : prompts.map((prompt, index) => promptMapKey(prompt, index));
  state.control.promptRefMap ||= {};

  if (action === "clear-active-refs") {
    await clearAllReferences();
    return;
  }
  if (action === "clear-selected") {
    for (const key of targetKeys) state.control.promptRefMap[key] = [];
    appendLog("info", "refs", `Unmapped ${targetKeys.length} prompt row${targetKeys.length === 1 ? "" : "s"}.`);
  } else if (action === "map-one-to-one") {
    if (!sourceIds.length) return;
    for (const key of targetKeys) {
      const index = Number(key.split(":").pop());
      if (state.control.mode === FLOW_MODES.imageToVideo && sourceIds.length >= prompts.length * 2) {
        state.control.promptRefMap[key] = [sourceIds[index] || "", sourceIds[index + prompts.length] || ""].filter(Boolean);
      } else {
        state.control.promptRefMap[key] = sourceIds[index % sourceIds.length] ? [sourceIds[index % sourceIds.length]] : [];
      }
    }
    appendLog("info", "refs", `Mapped ${targetKeys.length} row${targetKeys.length === 1 ? "" : "s"} 1:1.`);
  } else if (action === "map-all") {
    for (const key of targetKeys) state.control.promptRefMap[key] = [...sourceIds];
    appendLog("info", "refs", `Mapped ${targetKeys.length} row${targetKeys.length === 1 ? "" : "s"} to active refs.`);
  }

  state.control.presets.mapLineRefs = true;
  state.control.promptMapOpen = true;
  await persistState();
  render();
}

function selectedPromptMapKeys(root, prompts) {
  const checked = [...root.querySelectorAll(".map-row-check:checked")]
    .map((input) => input.dataset.promptKey)
    .filter(Boolean);
  if (checked.length) return checked;
  return prompts.length === 1 ? [promptMapKey(prompts[0], 0)] : prompts.map((prompt, index) => promptMapKey(prompt, index));
}

async function togglePromptMapRef(promptKey, refId, frameSlot = "") {
  if (!promptKey || !refId) return;
  state.control.promptRefMap ||= {};
  const current = Array.isArray(state.control.promptRefMap[promptKey]) ? [...state.control.promptRefMap[promptKey]] : [];
  if (state.control.mode === FLOW_MODES.imageToVideo && frameSlot) {
    const next = [current[0] || "", current[1] || ""];
    const slotIndex = frameSlot === "end" ? 1 : 0;
    next[slotIndex] = next[slotIndex] === refId ? "" : refId;
    state.control.promptRefMap[promptKey] = next.filter(Boolean);
  } else if (current.includes(refId)) {
    state.control.promptRefMap[promptKey] = current.filter((id) => id !== refId);
  } else {
    state.control.promptRefMap[promptKey] = [...current, refId];
  }
  state.control.presets.mapLineRefs = true;
  state.control.promptMapOpen = true;
  await persistState();
  render();
}

async function applyPoolRefToPromptRows(refId, root) {
  if (!refId) return;
  const prompts = promptLines();
  const targetKeys = selectedPromptMapKeys(root, prompts);
  if (!targetKeys.length) return;
  state.control.promptRefMap ||= {};
  for (const key of targetKeys) {
    const current = Array.isArray(state.control.promptRefMap[key]) ? state.control.promptRefMap[key] : [];
    state.control.promptRefMap[key] = current.includes(refId) ? current : [...current, refId];
  }
  state.control.presets.mapLineRefs = true;
  state.control.promptMapOpen = true;
  appendLog("info", "refs", `Mapped ${targetKeys.length} row${targetKeys.length === 1 ? "" : "s"} from reference pool.`);
  await persistState();
  render();
}

async function deleteSelectedReferences() {
  await clearAllReferences();
}

async function deleteReferenceImage(itemId) {
  if (!itemId) return;
  state.referenceLibrary.savedItems = (state.referenceLibrary.savedItems || []).filter((item) => item.id !== itemId);
  state.control.transientReferenceItems = (state.control.transientReferenceItems || []).filter((item) => item.id !== itemId);
  removeReferenceIdEverywhere(itemId);
  appendLog("info", "refs", "Removed reference image.");
  await persistState();
  render();
}

async function clearReferenceLibrary() {
  state.referenceLibrary.savedItems = [];
  state.control.transientReferenceItems = [];
  await clearAllReferences();
  appendLog("info", "refs", "Reference library cleared.");
  await persistState();
  render();
}

async function enqueueJobsWithRender() {
  try {
    await enqueueJobs();
    render();
  } catch (error) {
    appendLog("error", "queue", error.message);
    await persistState();
    render();
  }
}

async function skipCurrentJob() {
  appendLog("info", "queue", "Skip requested. The clean scheduler bridge will own this action after capture.");
  await persistState();
  render();
}

async function removeQueueItem(taskId) {
  if (!taskId || state.queue.running) return;
  const response = await send(MessageType.QueueRemove, { id: taskId }).catch(() => null);
  applyRuntimePayload(response?.payload || {
    queue: { tasks: state.queue.items.filter((item) => item.id !== taskId && item.jobId !== taskId) },
    queueRunning: state.queue.running
  });
  appendLog("info", "queue", `Removed ${Number(response?.payload?.removed || 0) || 1} queued item(s).`);
  await persistState();
  render();
}

async function openChromeSettings(url, label) {
  try {
    await chrome.tabs.create({ url });
    appendLog("info", "settings", `Opened ${label}.`);
  } catch (error) {
    appendLog("warn", "settings", `Could not open ${label}: ${error.message}`);
    throw error;
  }
  await persistState();
  render();
}


// Wrap a maintenance-style button click with visible feedback so the user sees
// activity even when the underlying action only logs internally.
//   - Disables the button + swaps label to busyText while the action runs
//   - On success: shows doneText with a check, reverts after 1.6s
//   - On failure: shows failText with an X, reverts after 2.4s
// Returns a Promise resolving to the original action's result (or null on error).
async function runWithButtonFeedback(button, action, { busyText = "Working...", doneText = "Done", failText = "Failed" } = {}) {
  if (!button || typeof action !== "function") return null;
  const labelEl = button.querySelector(".maintenance-btn-label") ||
    button.querySelector("span:not(.material-symbols-outlined)") ||
    button;
  const originalText = labelEl.textContent;
  const originalDisabled = button.disabled;
  button.disabled = true;
  button.classList.add("is-busy");
  labelEl.textContent = busyText;
  let ok = true;
  let result = null;
  try {
    result = await action();
  } catch (error) {
    ok = false;
    appendLog("warn", "maintenance", String(error?.message || error || "action_failed"));
  }
  button.classList.remove("is-busy");
  button.classList.add(ok ? "is-done" : "is-failed");
  labelEl.textContent = ok ? doneText : failText;
  setTimeout(() => {
    button.classList.remove("is-done", "is-failed");
    labelEl.textContent = originalText;
    button.disabled = originalDisabled;
  }, ok ? 1600 : 2400);
  return result;
}

async function runMaintenanceAction(action) {
  const label = action === "clear_flow_cookies" ? "Clear Flow Cookies"
    : action === "clear_all_flow_data" ? "Clear All Flow Data"
      : "Clear Flow Cache";
  const response = await send(MessageType.PageCommand, { action, timeoutMs: 15000 }).catch((error) => ({ payload: { error: error.message } }));
  const ok = response?.payload?.ok || response?.payload?.result?.ok || response?.payload?.result?.result?.ok;
  if (ok) {
    const result = response?.payload?.result?.result || response?.payload?.result || {};
    const reloadNote = result.tabReload?.ok ? " Flow tab reloaded." : " Flow tab reload skipped.";
    if (action === "clear_flow_cookies") {
      appendLog("info", "maintenance", `${label} completed. Deleted ${Number(result.deleted || 0)} cookies, preserved ${Number(result.preserved || 0)} login cookies.${reloadNote}`);
    } else if (action === "clear_all_flow_data") {
      appendLog("warn", "maintenance", `${label} completed. Deleted ${Number(result.deleted || 0)} cookies and cleared site data.${reloadNote}`);
    } else {
      const bridgeNote = result.pageBridge?.ok === false ? ` Page bridge skipped: ${result.pageBridge.error || "not available"}.` : "";
      appendLog("info", "maintenance", `${label} completed.${bridgeNote}${reloadNote}`);
    }
  } else {
    const message = `${label} failed. ${response?.payload?.error || response?.payload?.result?.error || ""}`.trim();
    appendLog("warn", "maintenance", message);
    throw new Error(message);
  }
  await persistState();
  render();
}

function buildDebugReport() {
  const generatedAt = new Date().toISOString();
  const taskLedgerSnapshot = Array.isArray(state.queue.taskLedgerSnapshot) && state.queue.taskLedgerSnapshot.length
    ? state.queue.taskLedgerSnapshot
    : state.queue.items.map((task) => sanitizeQueueTaskForReport(task));
  const queueRuntimeEvents = Array.isArray(state.queue.runtimeEvents) ? state.queue.runtimeEvents.slice(-200) : [];
  const diagnostics = buildSupportDiagnostics(taskLedgerSnapshot, queueRuntimeEvents);
  const allRefs = allReferenceItems();
  const promptCount = promptLines().length;
  const characterPreflight = characterPreflightForPrompts(promptLines());
  const oneToOneIds = oneToOneBatchRefIds();
  const generatedMediaIds = [...new Set([
    ...(Array.isArray(state.queue.generatedMediaIds) ? state.queue.generatedMediaIds : []),
    ...taskLedgerSnapshot.flatMap((task) => Array.isArray(task.generatedMediaIds) ? task.generatedMediaIds : [])
  ].map((id) => String(id || "").trim()).filter(Boolean))];
  const report = {
    product: "Auto Flow",
    version: APP_VERSION,
    generatedAt,
    build: buildFingerprintForReport(),
    billingHealth: state.account.billingHealth || "unknown",
    runtime: state.runtime,
    account: {
      status: state.account.status,
      plan: state.account.plan,
      rawPlan: state.account.rawPlan || state.account.plan,
      subscriptionStatus: state.account.subscriptionStatus,
      stripeSubscriptionStatus: state.account.stripeSubscriptionStatus || null,
      supabaseSubscriptionStatus: state.account.supabaseSubscriptionStatus || null,
      currentPeriodEnd: state.account.currentPeriodEnd || null,
      cancelAtPeriodEnd: state.account.cancelAtPeriodEnd ?? null,
      usage: state.account.usage,
      billingHealth: state.account.billingHealth || "unknown",
      billing: state.account.billing || null
    },
    control: {
      mode: state.control.mode,
      wizardStep: Number(state.control.wizardStep || 1),
      activeApplyMode: String(state.control.activeApplyMode || "shared"),
      saveUploadsToLibrary: state.control.saveUploadsToLibrary === true,
      promptCount,
      oneToOneBatchRefCount: oneToOneIds.length,
      transientReferenceCount: Array.isArray(state.control.transientReferenceItems) ? state.control.transientReferenceItems.length : 0,
      savedReferenceCount: Array.isArray(state.referenceLibrary.savedItems) ? state.referenceLibrary.savedItems.length : 0,
      referenceBlobBackedCount: allRefs.filter((item) => item?.blobStoreId).length,
      referencePreviewOnlyCount: allRefs.filter((item) => item?.blobStoreId && !item?.dataUrl).length,
      presets: state.control.presets,
      referenceCounts: Object.fromEntries(Object.entries(state.control.references || {}).map(([key, value]) => [key, String(value || "").split(/\s+/).filter(Boolean).length]))
    },
    characters: {
      active: Boolean(characterPreflight.active),
      storeInFlow: state.characters?.storeInFlow === true,
      promptCount: characterPreflight.intents?.length || 0,
      handles: (characterPreflight.intents || []).map((intent) => intent.handle),
      characterHashes: (characterPreflight.intents || []).map((intent) => ({ handle: intent.handle, characterHash: intent.characterHash })),
      usedHandles: characterPreflight.usedHandles || [],
      undefinedHandles: characterPreflight.undefinedHandles || [],
      errors: characterPreflight.errors || [],
      warnings: characterPreflight.warnings || [],
      sourceStates: Object.entries(state.control?.characterSources || {}).map(([handle, source]) => ({
        handle,
        status: String(source?.status || source?.setupStatus || ""),
        sourceMode: String(source?.sourceMode || ""),
        projectId: String(source?.projectId || source?.activeProjectId || ""),
        storedMappingProjectId: String(source?.storedMappingProjectId || ""),
        hasCharacterServerId: Boolean(source?.characterServerId || source?.flowCharacterId),
        mappingProjectMatchesActiveProject: source?.mappingProjectMatchesActiveProject === true
      })),
      setupRunner: state.control?.characterSetupRunner || {},
      assets: state.characters?.assets || characterPreflight.assets || [],
      voiceCatalog: {
        capturedAt: state.characters?.voiceCatalog?.capturedAt || "",
        accountTier: state.characters?.voiceCatalog?.accountTier || "",
        voiceCount: state.characters?.voiceCatalog?.voiceCount || 0,
        catalogHash: state.characters?.voiceCatalog?.catalogHash || characterPreflight.catalogHash || ""
      },
      quota: {
        quotaCommitType: "character_creation",
        quotaDelta: 0
      }
    },
    queue: {
      running: state.queue.running,
      count: state.queue.items.length,
      generatedMediaIds,
      taskLedgerSnapshot
    },
    gallery: {
      count: state.gallery.items.length,
      selectedCount: state.ui.selectedGalleryIds.length,
      tab: state.ui.galleryTab,
      viewMode: state.ui.galleryViewMode,
      size: state.ui.gallerySize
    },
    captures: {
      cdpPort: 9222,
      proxymanExpected: true,
      note: "Pair this report with release/live-captures/*/events.ndjson and an exported Proxyman HAR for the same run."
    },
    diagnostics,
    queueRuntimeEvents,
    scenes: {
      clipCount: state.scenes?.clips?.length || 0,
      totalDuration: state.scenes?.totalDuration || 0
    },
    i18n: localeDiagnostics(currentLocale()),
    logs: state.logs.items.slice(-200)
  };
  return [
    "# Auto Flow Debug Report",
    "",
    `- Product: ${report.product}`,
    `- Version: ${report.version}`,
    `- Build commit: ${report.build.shortCommit || report.build.commit || "unknown"}`,
    `- Build dirty: ${report.build.dirty}`,
    `- Generated: ${generatedAt}`,
    `- Mode: ${report.control.mode}`,
    `- Queue running: ${report.queue.running}`,
    `- Queue count: ${report.queue.count}`,
    `- Matrix: refs=${diagnostics.matrix.refs.status}, submit=${diagnostics.matrix.submit.status}, queue=${diagnostics.matrix.queue.status}, downloads=${diagnostics.matrix.downloads.status}`,
    `- Downloads: ${diagnostics.downloads.downloaded}/${diagnostics.downloads.total} ok, ${diagnostics.downloads.failed} failed, ${diagnostics.downloads.badArtifacts} bad, ${diagnostics.downloads.totalBytes} bytes`,
    "",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    ""
  ].join("\n");
}

function buildSupportDiagnostics(tasks = [], runtimeEvents = []) {
  const eventMs = (event = {}) => Date.parse(event.at || "") || 0;
  const events = Array.isArray(runtimeEvents) ? runtimeEvents : [];
  const taskList = Array.isArray(tasks) ? tasks : [];
  const downloadEvents = events.filter((event) => event.type === "media.download" || event.type === "media.download.error");
  const retryEvents = events.filter((event) => event.type === "media.download.retry_wait");
  const refEvents = events.filter((event) => String(event.type || "").startsWith("media.inline_ref_upload") || event.type === "queue.dom.stage" || String(event.type || "").startsWith("queue.submit"));
  const submitEvents = events.filter((event) => String(event.type || "").startsWith("queue.submit"));
  const queueErrors = events.filter((event) => ["queue.error", "queue.task.error"].includes(String(event.type || "")));
  const staleIgnored = events.filter((event) => ["queue.stale_task_ignored", "queue.stale_run_exit"].includes(String(event.type || "")));
  const outputs = taskList.flatMap((task) => Array.isArray(task.outputs) ? task.outputs.map((output) => ({ task, output })) : []);
  const terminalTasks = taskList.filter((task) => ["complete", "failed", "blocked"].includes(String(task.status || "")));
  const openTasks = taskList.filter((task) => !["complete", "failed", "blocked"].includes(String(task.status || "")));
  const failedTasks = taskList.filter((task) => ["failed", "blocked"].includes(String(task.status || "")));
  const downloadedOutputs = outputs.filter(({ output }) => String(output.downloadStatus || "") === "downloaded");
  const failedDownloads = [
    ...outputs.filter(({ output }) => String(output.downloadStatus || "") === "download_failed" || output.downloadError),
    ...downloadEvents.filter((event) => event.type === "media.download.error" || event.error)
  ];
  const badArtifacts = failedDownloads.filter((entry) => {
    const output = entry.output || entry;
    return /\.html(?:$|\?)/i.test(String(output.downloadFilename || output.fileName || output.filename || ""))
      || /SERVER_BAD_CONTENT|download_too_small|bad_content|interrupted|html/i.test(String(output.downloadError || output.error || ""));
  });
  const byteValues = downloadEvents.map((event) => Number(event.bytesReceived || event.fileSize || 0)).filter((value) => value > 0);
  const durationValues = downloadEvents.map((event) => Number(event.totalDurationMs || event.durationMs || 0)).filter((value) => value > 0);
  const totalDownloads = Math.max(outputs.length, downloadEvents.length);
  const downloaded = Math.max(downloadedOutputs.length, downloadEvents.filter((event) => event.type === "media.download" && !event.error).length);
  const submitOk = submitEvents.filter((event) => event.type === "queue.submit.ok");
  const submitFailed = submitEvents.filter((event) => event.type === "queue.submit.failed" || event.type === "queue.submit.error" || event.error);
  const refUploadStarts = events.filter((event) => event.type === "media.inline_ref_upload.start");
  const refUploadOk = events.filter((event) => event.type === "media.inline_ref_upload.ok");
  const refUploadFailed = events.filter((event) => event.type === "media.inline_ref_upload.failed");
  const refTimings = buildReportRefTimings(refEvents);
  const statusFor = (ok, warn = false) => ok ? (warn ? "WARN" : "PASS") : "FAIL";
  const downloadsMeasured = totalDownloads > 0 || downloadEvents.length > 0;
  const downloadsOk = downloadsMeasured && failedDownloads.length === 0 && badArtifacts.length === 0 && (downloaded >= totalDownloads || totalDownloads === 0);
  return sanitizeReportValue({
    matrix: {
      refs: {
        status: statusFor(refUploadFailed.length === 0, refUploadStarts.length > refUploadOk.length),
        starts: refUploadStarts.length,
        ok: refUploadOk.length,
        failed: refUploadFailed.length,
        timings: refTimings
      },
      submit: {
        status: statusFor(submitOk.length > 0 && submitFailed.length === 0),
        ok: submitOk.length,
        failed: submitFailed.length,
        last: submitEvents.at(-1) || null
      },
      queue: {
        status: statusFor(queueErrors.length === 0 && openTasks.length === 0, staleIgnored.length > 0),
        taskCount: taskList.length,
        terminal: terminalTasks.length,
        open: openTasks.length,
        failed: failedTasks.length,
        queueErrors: queueErrors.length,
        staleIgnored: staleIgnored.length,
        statuses: taskList.map((task) => ({ id: task.id || "", status: task.status || "", mode: task.mode || "", lastError: task.lastError || "" }))
      },
      downloads: {
        status: downloadsMeasured ? statusFor(downloadsOk) : "NOT_MEASURED",
        measured: downloadsMeasured,
        downloaded,
        total: totalDownloads,
        failed: failedDownloads.length,
        badArtifacts: badArtifacts.length
      }
    },
    downloads: {
      measured: downloadsMeasured,
      downloaded,
      total: totalDownloads,
      failed: failedDownloads.length,
      badArtifacts: badArtifacts.length,
      retryWaitCount: retryEvents.length,
      retryWaitMs: retryEvents.reduce((sum, event) => sum + Number(event.waitMs || 0), 0),
      minBytes: byteValues.length ? Math.min(...byteValues) : 0,
      maxBytes: byteValues.length ? Math.max(...byteValues) : 0,
      totalBytes: byteValues.reduce((sum, value) => sum + value, 0),
      minDurationMs: durationValues.length ? Math.min(...durationValues) : 0,
      maxDurationMs: durationValues.length ? Math.max(...durationValues) : 0,
      totalDurationMs: durationValues.reduce((sum, value) => sum + value, 0),
      events: downloadEvents.map((event) => ({
        at: event.at || "",
        type: event.type || "",
        taskId: event.taskId || "",
        mediaId: event.mediaId || "",
        filename: event.filename || event.fileName || "",
        finalFilepath: event.finalFilepath || "",
        bytesReceived: Number(event.bytesReceived || 0),
        fileSize: Number(event.fileSize || 0),
        durationMs: Number(event.durationMs || 0),
        totalDurationMs: Number(event.totalDurationMs || event.durationMs || 0),
        attempts: Number(event.attempts || 1),
        retryWaitMs: Number(event.retryWaitMs || 0),
        resolution: event.resolution || "",
        downloadPath: event.downloadPath || "",
        error: event.error || ""
      }))
    },
    refTimings,
    eventCounts: events.reduce((acc, event) => {
      const type = String(event.type || "");
      if (type) acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {}),
    generatedAt: new Date().toISOString()
  });
}

function buildReportRefTimings(events = []) {
  const byTask = new Map();
  const eventMs = (event = {}) => Date.parse(event.at || "") || 0;
  for (const event of events) {
    const taskId = String(event.taskId || "").trim();
    if (!taskId) continue;
    if (!byTask.has(taskId)) byTask.set(taskId, { taskId });
    const item = byTask.get(taskId);
    const ms = eventMs(event);
    if (!ms) continue;
    const setOnce = (key) => {
      if (!item[key]) item[key] = ms;
    };
    if (event.type === "media.inline_ref_upload.start") setOnce("uploadStartMs");
    if (event.type === "media.inline_ref_upload.ok") setOnce("uploadOkMs");
    if (event.type === "media.inline_ref_upload.failed") setOnce("uploadFailedMs");
    if (event.type === "queue.dom.stage" && event.stage === "attach_start") setOnce("attachStartMs");
    if (event.type === "queue.dom.stage" && event.stage === "attach_done") setOnce("attachDoneMs");
    if (event.type === "queue.dom.stage" && event.stage === "pre_submit_refs") setOnce("preSubmitRefsMs");
    if (event.type === "queue.submit.start") setOnce("submitStartMs");
    if (event.type === "queue.submit.ok") setOnce("submitOkMs");
    if (event.type === "queue.submit.failed" || event.type === "queue.submit.error") setOnce("submitFailedMs");
  }
  const delta = (item, start, end) => item[start] && item[end] ? Math.max(0, item[end] - item[start]) : null;
  return [...byTask.values()].map((item) => ({
    taskId: item.taskId,
    uploadDurationMs: delta(item, "uploadStartMs", "uploadOkMs"),
    uploadOkToAttachDoneMs: delta(item, "uploadOkMs", "attachDoneMs"),
    uploadOkToSubmitStartMs: delta(item, "uploadOkMs", "submitStartMs"),
    attachDurationMs: delta(item, "attachStartMs", "attachDoneMs"),
    preSubmitRefsToSubmitStartMs: delta(item, "preSubmitRefsMs", "submitStartMs"),
    uploadFailed: Boolean(item.uploadFailedMs),
    submitFailed: Boolean(item.submitFailedMs)
  }));
}

function sanitizeQueueTaskForReport(task = {}) {
  const reportFields = buildRecoveryReportFields(task, {
    tasks: Array.isArray(state.queue.taskLedgerSnapshot) && state.queue.taskLedgerSnapshot.length
      ? state.queue.taskLedgerSnapshot
      : state.queue.items
  });
  const referenceIds = new Set([
    ...(Array.isArray(task.refMediaIds) ? task.refMediaIds : []),
    task.startMediaId,
    task.endMediaId,
    ...(Array.isArray(task.refInputs) ? task.refInputs.map((ref) => ref?.mediaId || ref?.assetImageId) : [])
  ].map((id) => String(id || "").trim()).filter(Boolean));
  const generatedMediaIds = [...new Set([
    ...(Array.isArray(task.outputMediaIds) ? task.outputMediaIds : []),
    ...(Array.isArray(task.outputs) ? task.outputs.map((output) => output?.mediaId) : []),
    ...(Array.isArray(task.mediaIds) ? task.mediaIds : [])
  ].map((id) => String(id || "").trim()).filter((id) => id && !referenceIds.has(id)))];
  return sanitizeReportValue({
    id: task.id || "",
    jobId: task.jobId || "",
    jobIndex: Number.isFinite(Number(task.jobIndex)) ? Number(task.jobIndex) : null,
    jobPromptCount: Number(task.jobPromptCount || 0),
    status: task.status || "",
    mode: task.mode || "",
    prompt: task.prompt || "",
    projectId: task.projectId || "",
    model: task.model || "",
    aspectRatio: task.aspectRatio || "",
    repeatCount: Number(task.repeatCount || 1),
    videoLength: String(task.videoLength || task.videoDurationSeconds || ""),
    submitPath: task.submitPath || task.submitPathPreference || "",
    attempts: Number(task.attempts || 0),
    failureClass: task.failureClass || "",
    flowErrorCode: task.flowErrorCode || reportFields.flowErrorCode || "",
    userFacingFailureTitle: task.userFacingFailureTitle || reportFields.userFacingFailureTitle || "",
    userFacingFailureBody: task.userFacingFailureBody || reportFields.userFacingFailureBody || "",
    recoveryPolicy: task.recoveryPolicy || reportFields.recoveryPolicy || "",
    recoveryAttempted: task.recoveryAttempted === true || reportFields.recoveryAttempted === true,
    recoverySkippedBecauseHardQuota: task.recoverySkippedBecauseHardQuota === true || reportFields.recoverySkippedBecauseHardQuota === true,
    recoverySkippedBecauseModelAccess: task.recoverySkippedBecauseModelAccess === true || reportFields.recoverySkippedBecauseModelAccess === true,
    recoveryStepsAttempted: Array.isArray(task.recoveryStepsAttempted) ? task.recoveryStepsAttempted : reportFields.recoveryStepsAttempted,
    recoveryFinalOutcome: task.recoveryFinalOutcome || reportFields.recoveryFinalOutcome || "",
    completedTaskCountBeforeStop: Number(task.completedTaskCountBeforeStop ?? reportFields.completedTaskCountBeforeStop ?? 0),
    downloadedCountBeforeStop: Number(task.downloadedCountBeforeStop ?? reportFields.downloadedCountBeforeStop ?? 0),
    pendingTaskCountAfterStop: Number(task.pendingTaskCountAfterStop ?? reportFields.pendingTaskCountAfterStop ?? 0),
    recommendedNextAction: task.recommendedNextAction || reportFields.recommendedNextAction || "",
    sideEffectRetryBlocked: task.sideEffectRetryBlocked === true || reportFields.sideEffectRetryBlocked === true,
    mediaIdResubmitBlocked: task.mediaIdResubmitBlocked === true || reportFields.mediaIdResubmitBlocked === true,
    autoFlowSubscriptionIssue: task.autoFlowSubscriptionIssue === true || reportFields.autoFlowSubscriptionIssue === true,
    googleFlowAccountModelIssue: task.googleFlowAccountModelIssue === true || reportFields.googleFlowAccountModelIssue === true,
    apiFirstQuotaSuspected: task.apiFirstQuotaSuspected === true || reportFields.apiFirstQuotaSuspected === true,
    domVerificationAttempted: task.domVerificationAttempted === true || reportFields.domVerificationAttempted === true,
    domVerificationResult: task.domVerificationResult || reportFields.domVerificationResult || "",
    domVerificationFailureClass: task.domVerificationFailureClass || reportFields.domVerificationFailureClass || "",
    finalQuotaClassification: task.finalQuotaClassification || reportFields.finalQuotaClassification || "",
    modelSubmittedByApi: task.modelSubmittedByApi || reportFields.modelSubmittedByApi || "",
    modelVisibleInFlow: task.modelVisibleInFlow || reportFields.modelVisibleInFlow || "",
    refCount: Number(task.refCount ?? reportFields.refCount ?? 0),
    refsReusedForDomVerification: task.refsReusedForDomVerification === true || reportFields.refsReusedForDomVerification === true,
    pendingRowsPreserved: task.pendingRowsPreserved === true || reportFields.pendingRowsPreserved === true,
    switchedPendingRowsToDom: task.switchedPendingRowsToDom === true || reportFields.switchedPendingRowsToDom === true,
    userConfirmedSwitchToDom: task.userConfirmedSwitchToDom === true || reportFields.userConfirmedSwitchToDom === true,
    failureScope: task.failureScope || "",
    healAction: task.healAction || "",
    lastError: task.lastError || "",
    userFacingFailureTitle: task.userFacingFailureTitle || "",
    userFacingFailureBody: task.userFacingFailureBody || "",
    originalRefMediaId: task.originalRefMediaId || "",
    originalBlobStoreId: task.originalBlobStoreId || "",
    missingAssetRowMediaId: task.missingAssetRowMediaId || "",
    refReuploadAttempted: task.refReuploadAttempted === true,
    refReuploadSucceeded: task.refReuploadSucceeded === true,
    replacementRefMediaId: task.replacementRefMediaId || "",
    uploadedRefIds: task.uploadedRefIds || [],
    domFallbackAfterRefReupload: task.domFallbackAfterRefReupload === true,
    finalFallbackOutcome: task.finalFallbackOutcome || "",
    userActionRequiredReferenceFileName: task.userActionRequiredReferenceFileName || "",
    apiBackendError: task.apiBackendError || "",
    domFallbackError: task.domFallbackError || "",
    expectedImages: Number(task.expectedImages || 0),
    foundImages: Number(task.foundImages || 0),
    expectedVideos: Number(task.expectedVideos || 0),
    foundVideos: Number(task.foundVideos || 0),
    generatedMediaIds,
    downloadedMediaIds: task.downloadedMediaIds || [],
    skippedDownloadMediaIds: task.skippedDownloadMediaIds || [],
    downloadErrorMediaIds: task.downloadErrorMediaIds || [],
    refMediaIds: task.refMediaIds || [],
    outputs: (Array.isArray(task.outputs) ? task.outputs : []).map((output) => ({
      mediaId: output?.mediaId || "",
      mediaGenerationId: output?.mediaGenerationId || output?.upscaleSourceId || "",
      status: output?.status || output?.rawStatus || "",
      downloadStatus: output?.downloadStatus || "",
      fileName: output?.fileName || output?.filename || ""
    })),
    events: Array.isArray(task.events) ? task.events.slice(-25) : []
  });
}

function sanitizeReportValue(value, key = "", depth = 0) {
  if (/^(dataUrl|imageUrl|imageBytes|base64|bytesBase64)$/i.test(String(key || ""))) {
    const length = typeof value === "string" ? value.length : 0;
    return length ? `[omitted:${length} chars]` : "[omitted]";
  }
  if (typeof value === "string") return value.length > 1200 ? `${value.slice(0, 240)}...[truncated:${value.length} chars]` : value;
  if (!value || typeof value !== "object") return value;
  if (depth > 5) return "[truncated:depth]";
  if (Array.isArray(value)) return value.map((entry) => sanitizeReportValue(entry, "", depth + 1));
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitizeReportValue(entryValue, entryKey, depth + 1)]));
}

function buildReportFileName() {
  const stamp = new Date().toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[:]/g, "")
    .replace("T", "_");
  return `autoflow-report-${APP_VERSION}-${stamp}.md`;
}

function downloadTextFile(fileName, content, mimeType = "text/plain") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

function idsFromReferenceValue(value) {
  return String(value || "").split(/\s+/).map((id) => id.trim()).filter(Boolean);
}

function referenceLimitForMode(mode = state.control.mode) {
  if (mode === FLOW_MODES.textToImage) return 10;
  if (mode === FLOW_MODES.ingredientsToVideo) return 3;
  if (mode === FLOW_MODES.imageToVideo) return 2;
  return 0;
}

function activeReferenceIdsForMode(mode = state.control.mode) {
  const batchIds = oneToOneBatchRefIds();
  if (batchIds.length) return batchIds;
  if (mode === FLOW_MODES.textToImage) {
    return refIdsForRoles(["imagePromptRefs", "styleRefRefs", "omniRefRefs"]).slice(0, 10);
  }
  if (mode === FLOW_MODES.ingredientsToVideo) {
    return refIdsForRoles(["ingredientsRefs"]).slice(0, 3);
  }
  if (mode === FLOW_MODES.imageToVideo) {
    return refIdsForRoles(["startFrameRef", "endFrameRef"]).slice(0, 2);
  }
  return [];
}

function setReferenceIds(role, ids) {
  state.control.references[role] = [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))].join("\n");
}

function assignReferenceForActiveMode(itemId) {
  if (state.control.mode === FLOW_MODES.textToVideo) {
    appendLog("warn", "refs", "Text to Video does not use image references.");
    return false;
  }
  if (state.control.activeApplyMode === "batch" || state.control.activeApplyMode === "repeat") {
    for (const key of Object.keys(state.control.references || {})) {
      state.control.references[key] = "";
    }
    const current = oneToOneBatchRefIds();
    state.control.oneToOneBatchRefIds = current.includes(itemId)
      ? current.filter((id) => id !== itemId)
      : [...current, itemId].slice(0, 500);
    state.control.promptRefMap = {};
    state.control.presets.mapLineRefs = true;
    state.control.promptMapOpen = true;
    return true;
  }
  state.control.oneToOneBatchRefIds = [];
  state.control.promptRefMap = {};
  if (state.control.mode === FLOW_MODES.imageToVideo) {
    const start = state.control.references.startFrameRef || "";
    const end = state.control.references.endFrameRef || "";
    if (start === itemId) {
      state.control.references.startFrameRef = "";
    } else if (end === itemId) {
      state.control.references.endFrameRef = "";
    } else if (!start) {
      state.control.references.startFrameRef = itemId;
    } else if (!end) {
      state.control.references.endFrameRef = itemId;
    } else {
      state.control.references.startFrameRef = itemId;
      state.control.references.endFrameRef = "";
    }
    return true;
  }
  const role = activeReferenceRoleForMode();
  const limit = referenceLimitForMode(state.control.mode);
  const current = idsFromReferenceValue(state.control.references[role]);
  const next = current.includes(itemId)
    ? current.filter((id) => id !== itemId)
    : [...current, itemId].slice(0, limit);
  setReferenceIds(role, next);
  return true;
}

function removeReferenceIdEverywhere(itemId) {
  for (const role of Object.keys(state.control.references || {})) {
    setReferenceIds(role, idsFromReferenceValue(state.control.references[role]).filter((id) => id !== itemId));
  }
  state.control.oneToOneBatchRefIds = oneToOneBatchRefIds().filter((id) => id !== itemId);
  const map = state.control.promptRefMap || {};
  for (const key of Object.keys(map)) {
    map[key] = Array.isArray(map[key]) ? map[key].filter((id) => id !== itemId) : [];
  }
}

function assignReference(role, itemId) {
  state.control.oneToOneBatchRefIds = [];
  state.control.promptRefMap = {};
  const current = new Set(idsFromReferenceValue(state.control.references[role]));
  if (role === "ingredientsRefs" || role === "imagePromptRefs" || role === "styleRefRefs" || role === "omniRefRefs") {
    current.add(itemId);
    const limit = role === "ingredientsRefs" ? 3 : role === "imagePromptRefs" ? 10 : referenceLimitForMode();
    setReferenceIds(role, [...current].slice(0, Math.max(1, limit)));
    return;
  }
  state.control.references[role] = itemId;
}

async function clearReference(role) {
  state.control.references[role] = "";
  appendLog("info", "refs", `Cleared ${role}.`);
  await persistState();
  render();
}

function activateImportedReferences(items = []) {
  const ids = items.map((item) => item.id).filter(Boolean);
  if (!ids.length) return;
  state.control.oneToOneBatchRefIds = [];
  state.control.promptRefMap = {};
  if (state.control.mode === FLOW_MODES.textToVideo) return;
  if (state.control.mode === FLOW_MODES.imageToVideo) {
    state.control.references.startFrameRef = ids[0] || "";
    state.control.references.endFrameRef = ids[1] || "";
    return;
  }
  if (state.control.mode === FLOW_MODES.ingredientsToVideo) {
    state.control.references.ingredientsRefs = ids.slice(0, 3).join("\n");
    return;
  }
  const role = activeReferenceRoleForMode();
  const current = new Set(idsFromReferenceValue(state.control.references[role]));
  ids.forEach((id) => current.add(id));
  setReferenceIds(role, [...current].slice(0, referenceLimitForMode()));
}

async function importReferenceFiles(fileList, options = {}) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  const snapshot = captureUiSnapshot();
  const importIntent = String(options.intent || refImportIntent || state.control.activeApplyMode || "shared");
  const saveToLibrary = options.saveToLibrary ?? state.control.saveUploadsToLibrary === true;
  const priorApplyMode = String(state.control.activeApplyMode || "shared");
  const added = await addReferenceFiles(files, { saveToLibrary });
  if (importIntent === "match" || ((importIntent === "chain" || importIntent === "chain_match") && state.control.mode === FLOW_MODES.textToImage)) {
    state.control.activeApplyMode = importIntent;
  } else if (importIntent !== "library_only") {
    state.control.activeApplyMode = "shared";
  } else {
    state.control.activeApplyMode = priorApplyMode;
  }
  if (options.activate !== false) activateImportedReferences(added);
  if (importIntent === "match") {
    state.control.presets.mapLineRefs = true;
    state.control.promptMapOpen = true;
    state.control.promptRefMap = {};
  } else if (importIntent === "chain" && state.control.mode === FLOW_MODES.textToImage) {
    state.control.presets.mapLineRefs = true;
    state.control.presets.imageRepeatCount = 1;
    state.control.promptMapOpen = false;
    state.control.promptRefMap = {};
    state.control.oneToOneBatchRefIds = [];
  } else if (importIntent === "chain_match" && state.control.mode === FLOW_MODES.textToImage) {
    state.control.presets.mapLineRefs = true;
    state.control.presets.imageRepeatCount = 1;
    state.control.promptMapOpen = true;
    state.control.promptRefMap = {};
    state.control.oneToOneBatchRefIds = [];
  }
  appendLog("info", "refs", `Imported ${added.length} reference image${added.length === 1 ? "" : "s"}${options.activate === false ? "" : " and activated them"}${saveToLibrary ? "" : " for this run only"}.`);
  await persistState({ suppressStorageRender: true });
  render();
  restoreUiSnapshot(snapshot);
  if (options.scroll === true) scrollToControlTarget("#refImagesContent", { delay: 120 });
}

async function importOneToOneBatchReferences(input) {
  const files = [...(input?.files || [])];
  const requestedMode = String(input?.dataset?.applyMode || state.control.activeApplyMode || "").trim();
  if (input?.dataset) delete input.dataset.applyMode;
  if (input) input.value = "";
  if (!files.length) return;
  const snapshot = captureUiSnapshot();
  const saveToLibrary = state.control.saveUploadsToLibrary === true;
  const mode = requestedMode === "repeat" ? "repeat" : "batch";
  const added = await addReferenceFiles(files, { saveToLibrary });
  state.control.activeApplyMode = mode;
  const ids = added.map((item) => item.id).filter(Boolean);
  for (const key of Object.keys(state.control.references || {})) {
    state.control.references[key] = "";
  }
  state.control.oneToOneBatchRefIds = ids;
  state.control.promptRefMap = {};
  state.control.presets.mapLineRefs = true;
  state.control.promptMapOpen = true;
  appendLog("info", "refs", `${mode === "repeat" ? "Repeat prompt" : "1:1 batch"} imported ${added.length} image${added.length === 1 ? "" : "s"} and unchecked active library references${saveToLibrary ? "" : " for this run only"}.`);
  await persistState({ suppressStorageRender: true });
  render();
  restoreUiSnapshot(snapshot);
}

async function importPromptTextFile(input) {
  const file = input?.files?.[0];
  if (input) input.value = "";
  if (!file) return;
  const text = await file.text();
  state.control.livePrompt = String(text || "").trim();
  state.control.promptMapOpen = state.control.presets.mapLineRefs === true;
  appendLog("info", "input", `Imported prompt file ${file.name || "prompts.txt"}.`);
  await persistState();
  render();
}

async function pastePromptFromClipboard() {
  const text = await navigator.clipboard?.readText?.().catch(() => "");
  if (!text) {
    appendLog("warn", "input", "Clipboard prompt paste was unavailable.");
    await persistState();
    render();
    return;
  }
  state.control.livePrompt = String(text || "").trim();
  state.control.promptMapOpen = state.control.presets.mapLineRefs === true;
  appendLog("info", "input", "Pasted prompts from clipboard.");
  await persistState();
  render();
}

async function importCharacterPromptTextFile(input) {
  const file = input?.files?.[0];
  if (input) input.value = "";
  if (!file) return;
  const text = await file.text();
  state.control.characterPromptText = String(text || "").trim();
  state.control.promptTab = "character_prompts";
  appendLog("info", "characters", `Imported character prompt file ${file.name || "characters.txt"}.`);
  await persistState();
  render();
}

async function pasteCharacterPromptFromClipboard() {
  const text = await navigator.clipboard?.readText?.().catch(() => "");
  if (!text) {
    appendLog("warn", "characters", "Clipboard character prompt paste was unavailable.");
    await persistState();
    render();
    return;
  }
  state.control.characterPromptText = String(text || "").trim();
  state.control.promptTab = "character_prompts";
  appendLog("info", "characters", "Pasted character prompts from clipboard.");
  await persistState();
  render();
}

async function pasteAutoFlowPacketFromClipboard() {
  const text = await navigator.clipboard?.readText?.().catch(() => "");
  if (!text) {
    appendLog("warn", "packet", "Clipboard packet paste was unavailable.");
    await persistState();
    render();
    return;
  }
  const packet = parseAutoFlowPacket(text, {
    voiceCatalog: state.characters?.voiceCatalog || {},
    storeInFlow: state.characters?.storeInFlow === true
  });
  state.control.packetImport = {
    ...(state.control.packetImport || {}),
    open: true,
    rawText: String(text || "").trim(),
    lastStatus: packet.nativeCharacterSetupStatus || CharacterFailureClass.characterSetupRequired
  };
  state.control.promptTab = "workflow_prompts";
  appendLog("info", "packet", `Parsed Auto Flow Packet: ${packet.counts.characters} character${packet.counts.characters === 1 ? "" : "s"}, ${packet.counts.scenes} scene${packet.counts.scenes === 1 ? "" : "s"}.`);
  await persistState();
  render();
}

async function applyAutoFlowPacket() {
  const rawText = String(state.control?.packetImport?.rawText || "").trim();
  if (!rawText) {
    appendLog("warn", "packet", "No Auto Flow Packet preview is open.");
    await persistState();
    render();
    return;
  }
  const packet = parseAutoFlowPacket(rawText, {
    voiceCatalog: state.characters?.voiceCatalog || {},
    storeInFlow: state.characters?.storeInFlow === true
  });
  if (!packet.counts.characters || !packet.counts.scenes) {
    appendLog("warn", "packet", "Auto Flow Packet needs Character Prompts and Video Prompts before apply.");
    await persistState();
    render();
    return;
  }
  const nextSources = { ...(state.control.characterSources || {}) };
  for (const character of packet.characters || []) {
    const handle = String(character.handle || "").trim();
    if (!handle) continue;
    const existing = nextSources[handle] || {};
    const hasNativeMapping = Boolean(String(existing.flowCharacterId || existing.characterServerId || "").trim());
    const hasSourceAsset = Boolean(String(existing.sourceRefId || existing.sourceMediaId || "").trim());
    const setupStatus = hasNativeMapping
      ? CharacterFailureClass.characterMappingReady
      : hasSourceAsset
        ? CharacterFailureClass.characterAssetCreatedButNotNativeCharacter
        : CharacterFailureClass.characterSetupRequired;
    nextSources[handle] = {
      ...existing,
      sourceMode: existing.sourceMode || (hasNativeMapping ? "saved_flow_character" : "generate_from_description"),
      setupStatus,
      status: setupStatus
    };
  }
  state.control.characterPromptText = packet.characterPromptText;
  state.control.livePrompt = packet.videoPromptText;
  state.control.packetNotes = packet.notesText;
  state.control.characterSources = nextSources;
  state.control.packetImport = {
    ...(state.control.packetImport || {}),
    open: false,
    rawText,
    lastAppliedAt: new Date().toISOString(),
    lastStatus: CharacterFailureClass.characterSetupRequired
  };
  state.control.promptTab = "workflow_prompts";
  state.control.runMappingTab = "character_mapping";
  state.control.promptMapOpen = state.control.presets?.mapLineRefs === true;
  appendLog("info", "packet", `Applied Auto Flow Packet. Native character setup required for ${packet.counts.characters} character${packet.counts.characters === 1 ? "" : "s"}.`);
  await persistState();
  render();
}

async function cancelAutoFlowPacket() {
  state.control.packetImport = {
    ...(state.control.packetImport || {}),
    open: false
  };
  appendLog("info", "packet", "Closed Auto Flow Packet preview.");
  await persistState();
  render();
}

async function createOrVerifyNativeCharacters() {
  const preflight = characterPreflightForPrompts(promptLines());
  if (!characterFeatureActive() || !preflight.intents?.length) {
    appendLog("warn", "characters", "Paste Character Prompts before native character setup.");
    await persistState();
    render();
    return;
  }
  const runId = `character-setup:${Date.now()}`;
  state.control.characterSetupRunner = {
    ...(state.control.characterSetupRunner || {}),
    runId,
    status: CharacterFailureClass.characterCreationInProgress,
    startedAt: new Date().toISOString(),
    completedAt: "",
    readyCount: 0,
    totalCount: preflight.intents.length,
    blockers: []
  };
  appendLog("info", "characters", `Checking native Flow Character rows for ${preflight.intents.length} character${preflight.intents.length === 1 ? "" : "s"}.`);
  await persistState();
  render();
  try {
    await ensureFlowProject();
    const response = await send(MessageType.PageCommand, {
      action: "nativeCharacterCreateOrVerify",
      tabId: state.runtime.activeTabId || undefined,
      timeoutMs: 120000,
      createMissing: true,
      characters: preflight.intents.map((intent) => ({
        handle: intent.handle,
        displayName: intent.displayName,
        description: intent.description,
        additionalInfo: intent.additionalInfo
      }))
    });
    const scan = response?.payload?.result?.result || response?.payload?.result || {};
    if (scan?.ok === false || response?.payload?.ok === false) {
      throw new Error(scan?.error || response?.payload?.error || "native_character_setup_scan_failed");
    }
    const activeProjectId = String(scan.projectId || projectIdFromFlowUrl(scan.href || "") || state.runtime.projectId || projectIdFromFlowUrl(state.runtime.pageUrl || "") || "").trim();
    const plan = buildCharacterSetupPlan(preflight.intents, {
      activeProjectId,
      sources: state.control.characterSources || {},
      nativeRows: scan.characterRows || [],
      imageRows: scan.imageRows || [],
      savedMappings: state.characters?.savedMappings || [],
      creationAttempts: scan.creationAttempts || []
    });
    state.control.characterSources = applyCharacterSetupPlanToSources(state.control.characterSources || {}, plan);
    state.characters ||= {};
    state.characters.savedMappings = markStaleNativeCharacterSavedMappings(
      mergeNativeCharacterSavedMappings(state.characters.savedMappings || [], plan.mappings, { proofId: runId, activeProjectId }),
      plan.items || []
    );
    state.characters.assets = buildCharacterAssetLedger(preflight.intents, {
      runId,
      activeProjectId,
      storeInFlow: state.characters?.storeInFlow === true,
      explicitMappings: [...(state.characters.savedMappings || []), ...buildCharacterSourceMappings(preflight.intents)]
    }).assets;
    const flowTabReloadAfterSetup = plan.ready
      ? await send(MessageType.PageCommand, {
        action: "reload_flow_tab",
        tabId: state.runtime.activeTabId || undefined,
        projectId: activeProjectId,
        reason: "character_setup_picker_cache_refresh",
        timeoutMs: 30000
      }).then((reloadResponse) => reloadResponse?.payload?.result || reloadResponse?.payload || {})
        .catch((error) => ({ ok: false, error: String(error?.message || error || "reload_flow_tab_failed") }))
      : null;
    state.control.characterSetupRunner = {
      ...(state.control.characterSetupRunner || {}),
      runId,
      status: plan.ready ? CharacterFailureClass.characterMappingReady : CharacterFailureClass.characterSetupRequired,
      completedAt: new Date().toISOString(),
      readyCount: plan.counts.ready,
      totalCount: plan.counts.total,
      blockers: plan.blockers.map((item) => ({
        handle: item.handle,
        status: item.status,
        reason: item.reason
      })),
      projectId: activeProjectId,
      proof: {
        traceEventName: plan.traceEventName,
        activeProjectPreflight: plan.activeProjectPreflight || [],
        imageRowsAccepted: false,
        nativeRows: (scan.characterRows || []).length,
        imageRows: (scan.imageRows || []).length,
        route: scan.href || state.runtime.pageUrl || "",
        creationEndpoint: scan.creationContract?.createEntityEndpoint || "",
        saveEndpoint: scan.creationContract?.saveEntityEndpoint || "",
        imageEndpoint: scan.creationContract?.generateImageEndpoint || "",
        flowTabReloadAfterSetup,
        creationAttempts: (scan.creationAttempts || []).map((attempt) => ({
          handle: attempt.handle,
          displayName: attempt.displayName,
          status: attempt.status,
          error: attempt.error || "",
          characterServerIdHash: attempt.characterServerIdHash || "",
          mediaIdHash: attempt.mediaIdHash || ""
        }))
      }
    };
    appendLog(plan.ready ? "info" : "warn", "characters", plan.ready
      ? `Native Character setup ready for ${plan.counts.ready}/${plan.counts.total} character${plan.counts.total === 1 ? "" : "s"}.`
      : `Native Character setup still blocked: ${plan.blockers.map((item) => `@${item.handle}=${item.status}`).join(", ")}.`);
    if (flowTabReloadAfterSetup) {
      appendLog(flowTabReloadAfterSetup.ok !== false ? "info" : "warn", "characters", flowTabReloadAfterSetup.ok !== false
        ? "Reloaded Flow tab after native character setup so the @ picker refreshes its project cache."
        : `Flow tab reload after native character setup failed: ${flowTabReloadAfterSetup.error || flowTabReloadAfterSetup.tabReload?.error || "reload_flow_tab_failed"}`);
    }
  } catch (error) {
    state.control.characterSetupRunner = {
      ...(state.control.characterSetupRunner || {}),
      runId,
      status: CharacterFailureClass.characterCreationFailed,
      completedAt: new Date().toISOString(),
      error: String(error?.message || error || "native_character_setup_failed")
    };
    appendLog("error", "characters", state.control.characterSetupRunner.error);
  }
  await persistState();
  render();
}

async function createReferencePreviewDataUrl(dataUrl = "") {
  const source = String(dataUrl || "");
  if (!source) return "";
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxEdge = 220;
      const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
      const height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx?.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.66));
    };
    img.onerror = () => resolve(source.length <= MAX_STORED_INLINE_MEDIA_CHARS ? source : "");
    img.src = source;
  });
}

async function migrateStoredInlineReferenceMedia() {
  const collections = [
    state.referenceLibrary?.savedItems,
    state.control?.transientReferenceItems
  ].filter(Array.isArray);
  let changed = false;
  for (const items of collections) {
    for (const item of items) {
      if (!item || item.blobStoreId) continue;
      const fullDataUrl = [item.dataUrl, item.mediaUrl, item.imageUrl]
        .map((value) => String(value || ""))
        .find((value) => /^data:/i.test(value) && value.length > MAX_STORED_INLINE_MEDIA_CHARS);
      if (!fullDataUrl) continue;
      const blobStoreId = await putReferenceBlob({
        id: item.id || crypto.randomUUID(),
        dataUrl: fullDataUrl,
        mimeType: item.mimeType || "image/png",
        fileName: item.fileName || item.title || "reference.png",
        size: item.size || 0
      }).catch(() => "");
      if (!blobStoreId) continue;
      item.id ||= blobStoreId;
      item.blobStoreId = blobStoreId;
      item.imageUrl = await createReferencePreviewDataUrl(fullDataUrl);
      item.dataUrl = "";
      item.mediaUrl = "";
      changed = true;
    }
  }
  if (changed) appendLog("info", "refs", "Migrated stored reference uploads out of sidepanel state.");
  return changed;
}

async function addReferenceFiles(files, { saveToLibrary = false } = {}) {
  const added = [];
  for (const file of files) {
    const id = crypto.randomUUID();
    const dataUrl = await readFileDataUrl(file);
    const blobStoreId = await putReferenceBlob({
      id,
      dataUrl,
      mimeType: file.type || "image/png",
      fileName: file.name || "reference.png",
      size: file.size || 0
    }).catch(() => "");
    const previewDataUrl = await createReferencePreviewDataUrl(dataUrl);
    added.push({
      id,
      blobStoreId,
      title: file.name || "Reference image",
      fileName: file.name || "reference.png",
      mimeType: file.type || "image/png",
      size: file.size || 0,
      imageUrl: previewDataUrl || (!blobStoreId ? dataUrl : ""),
      dataUrl: blobStoreId ? "" : dataUrl,
      mediaId: "",
      createdAt: new Date().toISOString(),
      temporary: saveToLibrary ? false : true
    });
  }
  if (saveToLibrary) {
    state.referenceLibrary.savedItems.unshift(...added);
    state.referenceLibrary.savedItems = state.referenceLibrary.savedItems.slice(0, 100);
  } else {
    state.control.transientReferenceItems = [
      ...added,
      ...(state.control.transientReferenceItems || [])
    ].slice(0, 100);
  }
  state.referenceLibrary.lastSyncedAt = new Date().toISOString();
  return added;
}

async function addReferenceFilesToLibrary(files) {
  return addReferenceFiles(files, { saveToLibrary: true });
}

function readFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

async function sendAccountCode() {
  const email = firstInputValue(["#authEmailInput", "#bannerEmailInput"]) || state.account.email;
  if (!email) {
    state.account.error = "Enter your email to receive your Auto Flow code.";
    await persistState();
    render();
    return;
  }
  try {
    const pendingCheckout = Boolean(state.account.pendingCheckout);
    state.account = {
      ...state.account,
      status: "pending_confirmation",
      email,
      pendingCheckout,
      otpCode: "",
      error: null,
      message: pendingCheckout ? "Code sent. Verify it and Stripe Checkout opens automatically." : "Code sent. Check your email."
    };
    await sendAuth("send_code", { email });
    state.account.status = "pending_confirmation";
    state.account.email = email;
    state.account.pendingCheckout = pendingCheckout;
    state.account.otpCode = "";
    state.account.message = pendingCheckout ? "Code sent. Verify it and Stripe Checkout opens automatically." : "Code sent. Check your email.";
    appendLog("info", "account", "Sent sign-in code.");
  } catch (error) {
    state.account.error = error.message;
    appendLog("error", "account", error.message);
  }
  await persistState();
  render();
  window.setTimeout(() => {
    document.getElementById("bannerOtpInput")?.focus({ preventScroll: true });
    document.getElementById("authOtpInput")?.focus({ preventScroll: true });
  }, 80);
}

async function verifyAccountCode() {
  const email = firstInputValue(["#authEmailInput", "#bannerEmailInput"]) || state.account.email;
  const code = firstInputValue(["#authOtpInput", "#bannerOtpInput"]) || state.account.otpCode;
  if (!email || !code) {
    state.account.error = "Enter your email and verification code.";
    await persistState();
    render();
    return;
  }
  try {
    const pendingCheckout = Boolean(state.account.pendingCheckout);
    await sendAuth("verify_code", { email, code });
    state.account.pendingCheckout = false;
    state.account.otpCode = "";
    state.account.message = pendingCheckout ? "Signed in. Opening Stripe Checkout..." : "Signed in.";
    appendLog("info", "account", "Signed in.");
    await persistState();
    render();
    if (pendingCheckout) await launchCheckout();
  } catch (error) {
    state.account.error = error.message;
    appendLog("error", "account", error.message);
    await persistState();
    render();
  }
}

async function refreshAccount() {
  try {
    await sendAuth("refresh");
    appendLog("info", "account", "License refreshed.");
  } catch (error) {
    state.account.error = error.message;
    appendLog("error", "account", error.message);
  }
  await persistState();
  render();
}

async function openCheckout() {
  if (state.account.status !== "signed_in") {
    const email = firstInputValue(["#authEmailInput", "#bannerEmailInput"]) || state.account.email || "";
    const alreadyWaitingForCode = state.account.status === "pending_confirmation" && String(state.account.email || "") === String(email || "");
    state.account.pendingCheckout = true;
    state.account.email = email || null;
    state.account.status = alreadyWaitingForCode ? "pending_confirmation" : "signed_out";
    state.account.message = "Sign in once to attach Pro to your Auto Flow account. Checkout opens after code verification.";
    state.ui.activeRoute = "control";
    appendLog("info", "billing", "Sign in required before Stripe checkout.");
    if (email && !alreadyWaitingForCode) {
      await sendAccountCode();
      return;
    }
    await persistState();
    render();
    window.setTimeout(() => {
      document.getElementById("freemiumBanner")?.scrollIntoView({ block: "center", behavior: "smooth" });
      if (state.account.email) {
        document.getElementById("bannerOtpInput")?.focus({ preventScroll: true });
      } else {
        document.getElementById("bannerEmailInput")?.focus({ preventScroll: true });
      }
    }, 80);
    return;
  }
  await launchCheckout();
}

async function launchCheckout() {
  try {
    const auth = await sendAuth("upgrade");
    const upgrade = auth?.upgrade || {};
    if (!upgrade.checkout_url) {
      throw new Error(upgrade.error || "missing_checkout_url");
    }
    appendLog("info", "billing", "Opened Stripe checkout.");
  } catch (error) {
    state.account.error = error.message;
    appendLog("error", "billing", error.message);
  }
  await persistState();
  render();
}

async function manageSubscription() {
  try {
    await sendAuth("manage_subscription");
    appendLog("info", "billing", "Opened billing portal.");
  } catch (error) {
    state.account.error = error.message;
    appendLog("error", "billing", error.message);
  }
  await persistState();
  render();
}

function firstInputValue(selectors) {
  for (const selector of selectors) {
    const value = document.querySelector(selector)?.value?.trim();
    if (value) return value;
  }
  return "";
}

function promptLines() {
  return String(state.control.livePrompt || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
}

function characterPromptTextActive() {
  return String(state.control.characterPromptText || "").trim().length > 0;
}

function readySavedCharacterMappings() {
  return readyNativeCharacterMappingsForProject({
    activeProjectId: state.runtime?.projectId || projectIdFromFlowUrl(state.runtime?.pageUrl || ""),
    savedMappings: state.characters?.savedMappings || [],
    assets: state.characters?.assets || [],
    characterSources: state.control?.characterSources || {},
    setupRunner: state.control?.characterSetupRunner || {}
  });
}

function nativeCharacterRunnableRefDiagnostics(prompts = promptLines()) {
  const result = readyNativeCharacterMappingsForProject({
    activeProjectId: state.runtime?.projectId || projectIdFromFlowUrl(state.runtime?.pageUrl || ""),
    savedMappings: state.characters?.savedMappings || [],
    assets: state.characters?.assets || [],
    characterSources: state.control?.characterSources || {},
    setupRunner: state.control?.characterSetupRunner || {},
    includeDiagnostics: true
  });
  const preflight = characterPreflightForPrompts(prompts);
  const mentionedHandles = promptMentionHandles(prompts);
  return {
    ...(result.diagnostics || {}),
    mappingHandles: (result.mappings || []).map((mapping) => mapping.handle),
    nativeRows: Number(state.control?.characterSetupRunner?.proof?.nativeRows || 0),
    imageRows: Number(state.control?.characterSetupRunner?.proof?.imageRows || 0),
    imageRowsAccepted: state.control?.characterSetupRunner?.proof?.imageRowsAccepted === true,
    runnableRefCandidates: (result.mappings || []).filter((mapping) => mentionedHandles.includes(mapping.handle)).length,
    preflightActive: preflight.active === true,
    preflightOk: preflight.ok === true,
    preflightAcceptedRefs: (preflight.assets || []).map((asset) => asset.handle).filter(Boolean),
    preflightRejectedRefs: preflight.errors || [],
    usedHandles: preflight.usedHandles || [],
    undefinedHandles: preflight.undefinedHandles || []
  };
}

function promptMentionHandles(prompts = promptLines()) {
  const seen = new Set();
  return (Array.isArray(prompts) ? prompts : [])
    .flatMap((prompt) => scanCharacterMentions(prompt).map((mention) => normalizeCharacterHandle(mention.handle)))
    .filter((handle) => {
      if (!handle || seen.has(handle)) return false;
      seen.add(handle);
      return true;
    });
}

function promptUsesReadySavedCharacterMapping(prompts = promptLines()) {
  const ready = new Set(readySavedCharacterMappings().map((mapping) => mapping.handle));
  if (!ready.size) return false;
  return promptMentionHandles(prompts).some((handle) => ready.has(handle));
}

function characterFeatureActive(prompts = promptLines()) {
  return characterPromptTextActive() || promptUsesReadySavedCharacterMapping(prompts);
}

function characterPreflightForPrompts(prompts = promptLines()) {
  const savedPreflight = savedCharacterPreflightForPromptMentions(prompts);
  if (savedPreflight.active && savedPreflight.ok) return savedPreflight;
  if (!characterPromptTextActive()) {
    if (savedPreflight.active) return savedPreflight;
    return {
      active: false,
      activeProjectId: state.runtime?.projectId || "",
      ok: true,
      intents: [],
      errors: [],
      warnings: [],
      scenes: [],
      usedHandles: [],
      undefinedHandles: [],
      assets: [],
      ledgerErrors: []
    };
  }
  const validation = validateCharacterRun(prompts, state.control.characterPromptText, {
    voiceCatalog: state.characters?.voiceCatalog || {},
    storeInFlow: state.characters?.storeInFlow === true
  });
  const characterSourceMappings = buildCharacterSourceMappings(validation.intents);
  const ledger = buildCharacterAssetLedger(validation.intents, {
    runId: `run:${Date.now()}`,
    activeProjectId: state.runtime?.projectId || "",
    storeInFlow: state.characters?.storeInFlow === true,
    explicitMappings: [...(state.characters?.savedMappings || []), ...characterSourceMappings]
  });
  const errors = [...(validation.errors || []), ...(ledger.errors || [])];
  return {
    ...validation,
    active: true,
    activeProjectId: state.runtime?.projectId || "",
    ok: errors.length === 0,
    errors,
    assets: ledger.assets,
    ledgerErrors: ledger.errors || []
  };
}

function savedCharacterPreflightForPromptMentions(prompts = promptLines()) {
  const readyMappings = readySavedCharacterMappings();
  const readyByHandle = new Map(readyMappings.map((mapping) => [mapping.handle, mapping]));
  const used = new Map();
  const undefinedHandles = new Set();
  const scenes = (Array.isArray(prompts) ? prompts : []).map((prompt, promptIndex) => {
    const required = [];
    const undefinedForScene = [];
    for (const mention of scanCharacterMentions(prompt)) {
      const handle = normalizeCharacterHandle(mention.handle);
      if (!handle) continue;
      if (readyByHandle.has(handle)) {
        required.push(handle);
        used.set(handle, (used.get(handle) || 0) + 1);
      } else {
        undefinedForScene.push(handle);
        undefinedHandles.add(handle);
      }
    }
    return {
      promptIndex,
      requiredCharacters: [...new Set(required)],
      undefinedCharacters: [...new Set(undefinedForScene)]
    };
  });
  const usedHandles = [...used.keys()];
  const active = usedHandles.length > 0;
  const errors = [...undefinedHandles].map((handle) => ({
    code: CharacterFailureClass.undefinedMention,
    handle,
    message: `@${handle} is used in prompts but has no saved native Flow character mapping.`
  }));
  const assets = usedHandles.map((handle) => readyByHandle.get(handle)).filter(Boolean);
  const intents = assets.map((asset) => ({
      characterId: String(asset.characterId || `character:${asset.handle}`),
      handle: asset.handle,
      mention: `@${asset.handle}`,
      displayName: asset.displayName,
      description: "",
      additionalInfo: "",
      source: {
        mode: "saved_flow_character",
        flowCharacterId: asset.characterServerId,
        characterServerId: asset.characterServerId,
        projectId: asset.projectId || asset.activeProjectId || state.runtime?.projectId || ""
      },
      storage: {
        storeInFlow: true,
        saved: true
      }
    }));
  return {
    active,
    activeProjectId: state.runtime?.projectId || "",
    ok: active && errors.length === 0,
    intents,
    errors,
    warnings: [],
    scenes,
    usedHandles,
    undefinedHandles: [...undefinedHandles],
    assets,
    ledgerErrors: [],
    savedMappings: assets
  };
}

function buildCharacterSourceMappings(intents = []) {
  const refs = [...(state.control.transientReferenceItems || []), ...(state.referenceLibrary?.savedItems || [])];
  const byId = new Map(refs.map((item) => [String(item?.id || ""), item]));
  return (intents || []).map((intent) => {
    const handle = String(intent?.handle || "").trim().toLowerCase();
    if (!handle) return null;
    const source = state.control.characterSources?.[handle] || {};
    const sourceMode = String(source.sourceMode || "").trim();
    const sourceRefId = String(source.sourceRefId || "").trim();
    const item = sourceRefId ? byId.get(sourceRefId) : null;
    const sourceMediaId = String(source.sourceMediaId || item?.mediaId || "").trim();
    const flowCharacterId = String(source.flowCharacterId || source.characterServerId || "").trim();
    const projectId = String(source.projectId || source.activeProjectId || "").trim();
    if (!sourceMode && !sourceRefId && !sourceMediaId && !flowCharacterId) return null;
    return {
      handle,
      sourceMode: sourceRefId ? "reference_library" : sourceMode,
      sourceRefId,
      sourceMediaId,
      sourceHash: String(item?.blobStoreId || item?.id || ""),
      flowCharacterId,
      characterServerId: flowCharacterId,
      projectId,
      activeProjectId: projectId || String(state.runtime?.projectId || ""),
      mappingProjectMatchesActiveProject: Boolean(projectId && state.runtime?.projectId && projectId === state.runtime.projectId),
      requestedVoice: String(source.requestedVoice || ""),
      state: source.status || (flowCharacterId
        ? CharacterFailureClass.characterMappingReady
        : sourceRefId || sourceMediaId
          ? CharacterFailureClass.characterAssetCreatedButNotNativeCharacter
          : "")
    };
  }).filter(Boolean);
}

function assertCharacterPreflightOk(preflight = characterPreflightForPrompts()) {
  if (!preflight.active) return preflight;
  if (preflight.ok) return preflight;
  const first = preflight.errors?.[0] || {};
  throw new Error(first.message || first.code || "Character preflight failed.");
}

function characterMetadataForJob(preflight = {}, promptIndex = 0) {
  const scene = (preflight.scenes || [])[promptIndex] || {};
  const requiredHandles = Array.isArray(scene.requiredCharacters) ? scene.requiredCharacters : [];
  const assets = (preflight.assets || []).filter((asset) => requiredHandles.includes(asset.handle));
  return {
    active: Boolean(preflight.active),
    bindingMode: "native_flow_chip_preferred",
    fallbackMode: "Auto Flow Classic Match",
    requiredHandles,
    assets,
    parser: {
      characterCount: preflight.intents?.length || 0,
      usedHandles: preflight.usedHandles || [],
      undefinedHandles: preflight.undefinedHandles || [],
      warningCount: preflight.warnings?.length || 0
    },
    storage: {
      storeInFlow: state.characters?.storeInFlow === true,
      activeProjectId: String(state.runtime?.projectId || "")
    },
    quota: {
      quotaCommitType: "character_creation",
      quotaDelta: 0
    }
  };
}

function promptMapKey(_prompt, index) {
  return `line:${index}`;
}

function refIdsForRoles(roles) {
  return roles.flatMap((role) => String(state.control.references[role] || "").split(/\s+/).map((id) => id.trim()).filter(Boolean));
}

function oneToOneBatchRefIds() {
  return Array.isArray(state.control.oneToOneBatchRefIds)
    ? state.control.oneToOneBatchRefIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
}

function transientReferenceIds() {
  return Array.isArray(state.control.transientReferenceItems)
    ? state.control.transientReferenceItems.map((item) => String(item?.id || "").trim()).filter(Boolean)
    : [];
}

function referenceRolesForMode(mode = state.control.mode) {
  if (mode === FLOW_MODES.textToImage) return ["imagePromptRefs", "styleRefRefs", "omniRefRefs"];
  if (mode === FLOW_MODES.ingredientsToVideo) return ["ingredientsRefs"];
  if (mode === FLOW_MODES.imageToVideo) return ["startFrameRef", "endFrameRef"];
  return [];
}

function mappingSourceIdsForMode(mode = state.control.mode) {
  const batchIds = oneToOneBatchRefIds();
  if (batchIds.length) return batchIds;
  const roleIds = refIdsForRoles(referenceRolesForMode(mode));
  if (roleIds.length) return roleIds;
  return transientReferenceIds().slice(0, referenceLimitForMode(mode));
}

async function autoActivateSoleRequiredReference(mode = state.control.mode) {
  if (mode !== FLOW_MODES.imageToVideo && mode !== FLOW_MODES.ingredientsToVideo) return false;
  if (mappingSourceIdsForMode(mode).length || oneToOneBatchRefIds().length) return false;
  const items = allReferenceItems();
  if (items.length !== 1) return false;
  activateImportedReferences([items[0]]);
  appendLog("info", "refs", mode === FLOW_MODES.imageToVideo
    ? "Auto-selected the only reference as the Start Frame."
    : "Auto-selected the only reference for Ingredients to Video.");
  await persistState();
  return true;
}

function promptMappedIds(mode, prompt, index, totalPrompts, options = {}) {
  const key = promptMapKey(prompt, index);
  const sourceIds = mappingSourceIdsForMode(mode);
  const limit = Number.isFinite(Number(options.limit))
    ? Math.max(0, Number(options.limit))
    : referenceLimitForMode(mode);
  const map = state.control.promptRefMap || {};
  if (Object.prototype.hasOwnProperty.call(map, key)) {
    return Array.isArray(map[key]) ? map[key].filter((id) => sourceIds.includes(id)).slice(0, limit) : [];
  }
  if (state.control.activeApplyMode === "match" || state.control.activeApplyMode === "chain_match") {
    return matchedReferenceIdsForPrompt(prompt, savedItemsForIds(sourceIds), {
      limit
    });
  }
  const batchIds = oneToOneBatchRefIds();
  if (mode === FLOW_MODES.imageToVideo && state.control.activeApplyMode === "repeat" && batchIds.length) {
    const refIndex = index;
    return batchIds[refIndex % batchIds.length] ? [batchIds[refIndex % batchIds.length]] : [];
  }
  if (batchIds.length) {
    if (mode === FLOW_MODES.imageToVideo && batchIds.length >= totalPrompts * 2) {
      return [batchIds[index] || "", batchIds[index + totalPrompts] || ""].filter(Boolean);
    }
    return batchIds[index] ? [batchIds[index]] : [];
  }
  return sourceIds.slice(0, limit);
}

function imageToVideoRepeatFirstSlotCount() {
  const prompts = promptLines();
  const batchIds = oneToOneBatchRefIds();
  if (
    state.control.mode !== FLOW_MODES.imageToVideo ||
    state.control.activeApplyMode !== "repeat" ||
    prompts.length !== 1 ||
    batchIds.length < 1
  ) {
    return 1;
  }
  return Math.max(1, Number(state.control.presets?.repeatCount || 1) || 1);
}

function textToImageContinuityEnabled() {
  return state.control.mode === FLOW_MODES.textToImage
    && (state.control.activeApplyMode === "chain" || state.control.activeApplyMode === "chain_match");
}

function promptPayloadForMode(mode, prompt) {
  const split = splitAutoFlowPromptLine(prompt);
  if (!split.isAutoFlowFormat) {
    return {
      prompt: String(prompt || "").trim(),
      sourcePrompt: "",
      imagePrompt: "",
      videoPrompt: "",
      sceneTag: ""
    };
  }
  const videoMode = mode === FLOW_MODES.textToVideo
    || mode === FLOW_MODES.imageToVideo
    || mode === FLOW_MODES.ingredientsToVideo;
  return {
    prompt: videoMode ? (split.videoPrompt || split.imagePrompt || split.sourcePrompt) : (split.imagePrompt || split.sourcePrompt),
    sourcePrompt: split.sourcePrompt,
    imagePrompt: split.imagePrompt,
    videoPrompt: split.videoPrompt,
    sceneTag: split.tag
  };
}

function jobPromptLinesForRun() {
  const prompts = promptLines();
  const batchIds = oneToOneBatchRefIds();
  if (state.control.mode === FLOW_MODES.imageToVideo && state.control.activeApplyMode === "repeat" && prompts.length === 1 && batchIds.length > 1) {
    return batchIds.map(() => prompts[0]);
  }
  return prompts;
}

function promptsHaveAutopilotVideoPrompts(prompts = promptLines()) {
  return prompts.length > 0 && prompts.every((prompt) => {
    const split = splitAutoFlowPromptLine(prompt);
    return split.isAutoFlowFormat && String(split.videoPrompt || "").trim();
  });
}

function roleForMappedRefId(id, mode, fallbackRole) {
  for (const role of referenceRolesForMode(mode)) {
    if (refIdsForRoles([role]).includes(id)) return role;
  }
  return fallbackRole;
}

function savedItemsForIds(ids) {
  const byId = new Map(allReferenceItems().map((item) => [item.id, item]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function savedItemRolePairsForRoles(roles) {
  const byId = new Map(allReferenceItems().map((item) => [item.id, item]));
  return roles.flatMap((role) =>
    String(state.control.references[role] || "")
      .split(/\s+/)
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => {
        const item = byId.get(id);
        return item ? { item, role } : null;
      })
      .filter(Boolean)
  );
}

function allReferenceItems() {
  const seen = new Set();
  return [
    ...(state.control.transientReferenceItems || []),
    ...(state.referenceLibrary.savedItems || [])
  ].filter((item) => {
    const id = String(item?.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function refInputFromItem(item, role = "", mediaId = "", options = {}) {
  const useStoredMediaId = options.useStoredMediaId !== false;
  const hasBlobStore = Boolean(item?.blobStoreId);
  return {
    id: String(item?.id || ""),
    blobStoreId: String(item?.blobStoreId || ""),
    role: String(role || ""),
    mediaId: String(mediaId || (useStoredMediaId ? item?.mediaId : "") || ""),
    assetImageId: String(item?.assetImageId || ""),
    fileName: String(item?.fileName || item?.title || "reference.png"),
    title: String(item?.title || item?.fileName || "Reference"),
    mimeType: String(item?.mimeType || "image/png"),
    uploadedAt: String(item?.uploadedAt || ""),
    imageUrl: String(hasBlobStore ? "" : (item?.imageUrl || item?.mediaUrl || "")),
    mediaUrl: String(hasBlobStore ? "" : (item?.mediaUrl || "")),
    dataUrl: String(hasBlobStore ? "" : (item?.dataUrl || item?.imageUrl || ""))
  };
}

async function domFrameRefInputFromItem(item, role = "", options = {}) {
  const itemMediaId = String(item?.mediaId || "").trim();
  const itemAssetImageId = String(item?.assetImageId || "").trim();
  if (itemMediaId || itemAssetImageId) {
    return {
      ...refInputFromItem(item, role, itemMediaId, { useStoredMediaId: true }),
      mediaId: itemMediaId,
      assetImageId: itemAssetImageId,
      dataUrl: "",
      imageUrl: String(item?.imageUrl || item?.mediaUrl || ""),
      mediaUrl: String(item?.mediaUrl || item?.imageUrl || "")
    };
  }
  return domUploadRefInputFromItem(item, role, options);
}

async function domUploadRefInputFromItem(item, role = "", options = {}) {
  if (options.deferBlobStoreData !== false && item?.blobStoreId) {
    return {
      ...refInputFromItem(item, role, "", { useStoredMediaId: false }),
      mediaId: "",
      assetImageId: "",
      dataUrl: "",
      imageUrl: "",
      mediaUrl: ""
    };
  }
  const dataUrl = await fullDataUrlForReferenceItem(item);
  if (!/^data:image\//i.test(String(dataUrl || ""))) {
    throw new Error(`Reference image ${item.fileName || item.title || item.id || ""} is missing its full upload data.`);
  }
  return {
    ...refInputFromItem(item, role, "", { useStoredMediaId: false }),
    mediaId: "",
    assetImageId: "",
    dataUrl,
    imageUrl: String(item?.imageUrl || ""),
    mediaUrl: ""
  };
}

async function ensureFlowProject() {
  if (state.runtime.projectId) return state.runtime.projectId;
  if (await syncRuntimeFromOpenFlowTab()) return state.runtime.projectId;
  await captureFlowProject();
  return state.runtime.projectId;
}

async function ensureMediaIds(items) {
  const missing = items.filter((item) => !item.mediaId);
  if (!missing.length) return items.map((item) => item.mediaId).filter(Boolean);
  const projectId = await ensureFlowProject();
  if (!projectId) throw new Error("Capture a Flow project before uploading references.");
  const result = await materializeReferenceUploads(items, {
    projectId,
    send,
    messageType: MessageType.MediaUpload,
    imageBytesForItem: imageBytesForReferenceItem,
    isHidden: false
  });
  appendLog("info", "refs", `Uploaded ${result.uploaded.length} reference image${result.uploaded.length === 1 ? "" : "s"} to Flow.`);
  await persistState();
  return result.mediaIds;
}

async function uploadReferenceItems(items, { isHidden = false, reason = "reference_upload" } = {}) {
  const projectId = await ensureFlowProject();
  if (!projectId) throw new Error("Capture a Flow project before uploading references.");
  const result = await materializeReferenceUploads(items, {
    projectId,
    send,
    messageType: MessageType.MediaUpload,
    imageBytesForItem: imageBytesForReferenceItem,
    isHidden
  });
  appendLog("info", "refs", `Uploaded ${result.uploaded.length} reference image${result.uploaded.length === 1 ? "" : "s"} for ${reason}.`);
  if (!isHidden) await persistState();
  return result.mediaIds;
}

async function fullDataUrlForReferenceItem(item = {}) {
  if (item?.blobStoreId) {
    const stored = await getReferenceBlob(item.blobStoreId).catch(() => null);
    return String(stored?.dataUrl || "");
  }
  return String(item?.dataUrl || item?.mediaUrl || item?.imageUrl || "");
}

async function imageBytesForReferenceItem(item = {}) {
  return base64FromDataUrl(await fullDataUrlForReferenceItem(item));
}

function effectiveTextToImageModel(model = "nano_banana_pro", refInputs = [], options = {}) {
  void refInputs;
  void options;
  return model || "nano_banana_pro";
}

async function buildJobs() {
  const prompts = jobPromptLinesForRun();
  if (!prompts.length) throw new Error("Add at least one prompt.");
  const projectId = await ensureFlowProject();
  if (!projectId) throw new Error(state.runtime.error || translate("flowTabNotFoundGuidance", {}, currentLocale()));

  const mode = state.control.mode;
  await autoActivateSoleRequiredReference(mode);
  const settings = taskSettingsForMode(mode);
  const characterPreflight = assertCharacterPreflightOk(characterPreflightForPrompts(prompts));
  const characterActive = Boolean(characterPreflight.active);
  const nativeCharacterPathCRequired = mode === FLOW_MODES.ingredientsToVideo
    && characterActive
    && (characterPreflight.usedHandles || []).length > 0;
  if (nativeCharacterPathCRequired) assertCharacterSetupReadyForPathC(characterPreflight);
  const nativeCharacterHandleMap = nativeCharacterHandleMapFromSetup(characterPreflight.assets || []);
  if (characterActive) {
    state.characters ||= {};
    state.characters.assets = characterPreflight.assets || [];
  }
  const domFirst = state.control.presets.submitPath === "dom_first";
  const jobs = [];
  if (mode === FLOW_MODES.imageToVideo) {
    const repeatSlotCount = imageToVideoRepeatFirstSlotCount();
    const repeatSlotMode = state.control.activeApplyMode === "repeat" && repeatSlotCount > 1;
    const repeatSlotGroupId = repeatSlotMode ? `repeat-first-${projectId}-${Date.now()}` : "";
    for (const [index, prompt] of prompts.entries()) {
      const promptPayload = promptPayloadForMode(mode, prompt);
      const mappedIds = promptMappedIds(mode, prompt, index, prompts.length);
      const repeatRefIndex = repeatSlotMode ? index : -1;
      const repeatSlotIndex = repeatSlotMode ? 0 : -1;
      const startItem = savedItemsForIds([mappedIds[0]]).at(0) || null;
      const endItem = savedItemsForIds([mappedIds[1]]).at(0) || null;
      if (!startItem) throw new Error(`Frame to Video prompt ${index + 1} needs a Start Frame reference.`);
      const refPairs = [
        { item: startItem, role: "startFrameRef" },
        endItem ? { item: endItem, role: "endFrameRef" } : null
      ].filter(Boolean);
      const mediaIds = domFirst
        ? []
        : await ensureMediaIds(refPairs.map((pair) => pair.item));
      const refInputs = domFirst
        ? await Promise.all(refPairs.map((pair) => domFrameRefInputFromItem(pair.item, pair.role, { deferBlobStoreData: true })))
        : refPairs.map((pair, refIndex) => refInputFromItem(pair.item, pair.role, mediaIds[refIndex] || "", { useStoredMediaId: false }));
      const startRef = refInputs.find((ref) => ref.role === "startFrameRef") || null;
      const endRef = refInputs.find((ref) => ref.role === "endFrameRef") || null;
      const attachedFrameRefs = refInputs.map((ref) => ({
        role: ref.role || "",
        mediaId: ref.mediaId || "",
        blobStoreId: ref.blobStoreId || "",
        hasDataUrl: Boolean(ref.dataUrl)
      }));
      jobs.push({
        prompt: promptPayload.prompt,
        sourcePrompt: promptPayload.sourcePrompt,
        imagePrompt: promptPayload.imagePrompt,
        videoPrompt: promptPayload.videoPrompt,
        sceneTag: promptPayload.sceneTag,
        mode,
        requestedMode: mode,
        normalizedRuntimeMode: settings.normalizedRuntimeMode || mode,
        buildJobsMode: mode,
        projectId,
        ...settings,
        repeatCount: settings.repeatCount,
        repeatSlotMode: repeatSlotMode ? "repeat_first_reference" : "",
        repeatSlotGroupId,
        repeatSlotOriginalCount: repeatSlotMode ? repeatSlotCount : 0,
        repeatSlotRefIndex: repeatSlotMode ? repeatRefIndex : null,
        repeatSlotIndex: repeatSlotMode ? repeatSlotIndex : null,
        repeatSlotTotal: repeatSlotMode ? repeatSlotCount : 0,
        model: mode === FLOW_MODES.textToImage ? effectiveTextToImageModel(settings.model, refInputs, { domFirst }) : settings.model,
        submitPath: state.control.presets.submitPath,
        characterPreflight: characterMetadataForJob(characterPreflight, index),
        nativeCharacterHandleMap,
        mediaIds,
        refInputs,
        attachedFrameRefs,
        startRefInput: startRef,
        endRefInput: endRef,
        startMediaId: startRef?.mediaId || mediaIds[0] || "",
        endMediaId: endRef?.mediaId || ""
      });
    }
    return jobs;
  }

  for (const [index, prompt] of prompts.entries()) {
    const promptPayload = promptPayloadForMode(mode, prompt);
    const continuityChain = mode === FLOW_MODES.textToImage && state.control.activeApplyMode === "chain";
    const continuityChainPlus = mode === FLOW_MODES.textToImage && state.control.activeApplyMode === "chain_match";
    const mappedLimit = continuityChainPlus && index > 0 ? Math.max(0, referenceLimitForMode(mode) - 1) : referenceLimitForMode(mode);
    const mappedIds = (continuityChain && index > 0 ? [] : promptMappedIds(mode, prompt, index, prompts.length, { limit: mappedLimit }))
      .slice(0, mappedLimit);
    const fallbackRole = mode === FLOW_MODES.ingredientsToVideo ? "ingredientsRefs" : "imagePromptRefs";
    const refPairs = savedItemsForIds(mappedIds).map((item) => ({
      item,
      role: roleForMappedRefId(item.id, mode, fallbackRole)
    }));
    const promptCharacterPreflight = characterMetadataForJob(characterPreflight, index);
    const promptHasNativeCharacterRefs = mode === FLOW_MODES.ingredientsToVideo
      && nativeCharacterPathCRequired
      && (promptCharacterPreflight.requiredHandles || []).length > 0
      && (promptCharacterPreflight.assets || []).length === (promptCharacterPreflight.requiredHandles || []).length;
    if (mode === FLOW_MODES.ingredientsToVideo && refPairs.length < 1 && !promptHasNativeCharacterRefs) {
      throw new Error(`Ingredients to Video prompt ${index + 1} needs at least one reference image.`);
    }
    const refItems = refPairs.map((pair) => pair.item);
    const domFirstInlineRefUpload = domFirst
      && (mode === FLOW_MODES.ingredientsToVideo || mode === FLOW_MODES.textToImage);
    const mediaIds = refItems.length && !domFirstInlineRefUpload
      ? await ensureMediaIds(refItems)
      : [];
    const refInputs = domFirstInlineRefUpload
      ? await Promise.all(refPairs.map((pair) => domUploadRefInputFromItem(pair.item, pair.role, { deferBlobStoreData: true })))
      : refPairs.map((pair, refIndex) => refInputFromItem(pair.item, pair.role, mediaIds[refIndex] || ""));
    jobs.push({
      prompt: promptPayload.prompt,
      sourcePrompt: promptPayload.sourcePrompt,
      imagePrompt: promptPayload.imagePrompt,
      videoPrompt: promptPayload.videoPrompt,
      sceneTag: promptPayload.sceneTag,
      mode,
      requestedMode: mode,
      normalizedRuntimeMode: settings.normalizedRuntimeMode || mode,
      buildJobsMode: mode,
      projectId,
      ...settings,
      model: mode === FLOW_MODES.textToImage ? effectiveTextToImageModel(settings.model, refInputs, { domFirst }) : settings.model,
      submitPath: state.control.presets.submitPath,
      characterPreflight: promptCharacterPreflight,
      nativeCharacterHandleMap,
      mediaIds,
      refInputs,
      attachedFrameRefs: [],
      referenceChainMode: (continuityChain || continuityChainPlus) && index > 0 ? "previous_output" : "",
      referenceChainSeed: (continuityChain || continuityChainPlus) && index === 0,
      referenceChainIndex: (continuityChain || continuityChainPlus) ? index : null
    });
  }
  return jobs;
}

function taskSettingsForMode(mode) {
  const presets = state.control.presets || {};
  const normalizedRuntimeMode = String(mode || state.control.mode || "");
  if (mode === FLOW_MODES.textToImage) {
    const continuityMode = textToImageContinuityEnabled();
    return {
      model: presets.imageModel || "nano_banana_pro",
      aspectRatio: presets.imageAspectRatio || "portrait",
      repeatCount: continuityMode ? 1 : (presets.imageRepeatCount || 1),
      referenceChainMode: continuityMode ? "previous_output" : "",
      download: {
        enabled: presets.autoDownloadImages === true,
        resolution: presets.imageAutoDownloadResolution,
        method: presets.imageDownloadMethodPreference,
        folder: presets.downloadFolder,
        autoNumberFolder: presets.autoNumberFolder,
        filenameStyle: presets.filenameStyle,
        filenameTemplatePrefix: presets.filenameTemplatePrefix,
        filenameTemplateIndex: presets.filenameTemplateIndex,
        filenameTemplatePromptPart: presets.filenameTemplatePromptPart,
        filenameTemplateDate: presets.filenameTemplateDate,
        filenameTemplateSuffix: presets.filenameTemplateSuffix,
        filenameTemplateSeparator: presets.filenameTemplateSeparator
      }
    };
  }
  const videoModel = mode === FLOW_MODES.ingredientsToVideo ? presets.ingredientsModel || "veo3_fast_low" : presets.model || "default";
  const requestedVideoLength = String(presets.videoLength || "8");
  const allowedBeforeCoerce = allowedVideoLengthsForCurrentMode(mode);
  coerceVideoPresetsForCurrentMode(mode);
  const coercedVideoLength = allowedVideoLengthsForCurrentMode(mode).includes(String(presets.videoLength || "8"))
    ? String(presets.videoLength || "8")
    : "8";
  const durationFallbackReason = allowedBeforeCoerce.includes(requestedVideoLength)
    ? ""
    : `duration_${requestedVideoLength}s_not_available_for_model`;
  return {
    model: videoModel,
    aspectRatio: presets.aspectRatio || "portrait",
    repeatCount: presets.repeatCount || 1,
    videoLength: coercedVideoLength,
    requestedVideoLength,
    sidepanelVideoLength: requestedVideoLength,
    normalizedRuntimeMode,
    preflightDuration: coercedVideoLength,
    buildJobsDuration: coercedVideoLength,
    payloadDuration: coercedVideoLength,
    durationFallbackReason,
    minInitialWaitTime: presets.minInitialWaitTime || 20,
    maxInitialWaitTime: presets.maxInitialWaitTime || 40,
    returnSilentVideos: presets.returnSilentVideos !== false,
    download: {
      enabled: presets.autoDownload === true,
      resolution: presets.videoDownloadResolution,
      method: presets.videoDownloadMethodPreference,
      folder: presets.downloadFolder,
      autoNumberFolder: presets.autoNumberFolder,
      filenameStyle: presets.filenameStyle,
      filenameTemplatePrefix: presets.filenameTemplatePrefix,
      filenameTemplateIndex: presets.filenameTemplateIndex,
      filenameTemplatePromptPart: presets.filenameTemplatePromptPart,
      filenameTemplateDate: presets.filenameTemplateDate,
      filenameTemplateSuffix: presets.filenameTemplateSuffix,
      filenameTemplateSeparator: presets.filenameTemplateSeparator
    }
  };
}

function nextDownloadFolderForRun() {
  const presets = state.control.presets || {};
  const base = String(presets.downloadFolder || "Auto-Flow").trim() || "Auto-Flow";
  if (presets.autoNumberFolder !== true) {
    return {
      folder: sanitizeFolderName(base),
      baseFolder: base,
      runIndex: Number(presets.downloadFolderRunIndex || 0)
    };
  }
  const lastBase = String(presets.downloadFolderLastBase || base);
  const currentIndex = lastBase === base ? Number(presets.downloadFolderRunIndex || 0) : 0;
  const runIndex = Math.max(1, currentIndex + 1);
  return {
    folder: `${sanitizeFolderName(base)}-${String(runIndex).padStart(2, "0")}`,
    baseFolder: base,
    runIndex
  };
}

function commitDownloadFolderRunAllocation(allocation = {}) {
  const presets = state.control.presets || {};
  if (presets.autoNumberFolder !== true) return;
  presets.downloadFolderLastBase = String(allocation.baseFolder || presets.downloadFolder || "Auto-Flow");
  presets.downloadFolderRunIndex = Math.max(Number(presets.downloadFolderRunIndex || 0), Number(allocation.runIndex || 0));
}

function runDiagnosticSummary(prompts = promptLines()) {
  const refs = allReferenceItems();
  const oneToOne = oneToOneBatchRefIds();
  const characterPreflight = characterPreflightForPrompts(prompts);
  const nativeRunnableRefs = nativeCharacterRunnableRefDiagnostics(prompts);
  return {
    mode: state.control.mode,
    route: state.ui.activeRoute,
    wizardStep: Number(state.control.wizardStep || 1),
    promptCount: prompts.length,
    activeApplyMode: String(state.control.activeApplyMode || "shared"),
    oneToOneBatchRefCount: oneToOne.length,
    transientRefCount: Array.isArray(state.control.transientReferenceItems) ? state.control.transientReferenceItems.length : 0,
    savedRefCount: Array.isArray(state.referenceLibrary.savedItems) ? state.referenceLibrary.savedItems.length : 0,
    blobBackedRefCount: refs.filter((item) => item?.blobStoreId).length,
    saveUploadsToLibrary: state.control.saveUploadsToLibrary === true,
    characterPromptCount: characterPreflight.intents?.length || 0,
    characterErrorCount: characterPreflight.errors?.length || 0,
    nativeRunnableRefs,
    storeCharactersInFlow: state.characters?.storeInFlow === true,
    submitPath: state.control.presets.submitPath,
    videoLength: state.control.presets.videoLength,
    aspectRatio: state.control.mode === FLOW_MODES.textToImage ? state.control.presets.imageAspectRatio : state.control.presets.aspectRatio,
    model: state.control.mode === FLOW_MODES.textToImage
      ? state.control.presets.imageModel
      : state.control.mode === FLOW_MODES.ingredientsToVideo
        ? state.control.presets.ingredientsModel
        : state.control.presets.model
  };
}

function compactRunDiagnosticText(summary = {}) {
  const nativeRefs = summary.nativeRunnableRefs || {};
  return [
    `mode=${summary.mode}`,
    `path=${summary.submitPath}`,
    `prompts=${summary.promptCount}`,
    `batchRefs=${summary.oneToOneBatchRefCount}`,
    `savedRefs=${summary.savedRefCount}`,
    `tempRefs=${summary.transientRefCount}`,
    `blobRefs=${summary.blobBackedRefCount}`,
    `saveToLibrary=${summary.saveUploadsToLibrary}`,
    `characters=${summary.characterPromptCount || 0}`,
    `characterErrors=${summary.characterErrorCount || 0}`,
    `readyNativeRefs=${nativeRefs.readyNativeMappingCount || 0}`,
    `runnableNativeRefs=${nativeRefs.runnableRefCandidates || 0}`,
    `nativeRows=${nativeRefs.nativeRows || 0}`,
    `imageRows=${nativeRefs.imageRows || 0}`,
    `step=${summary.wizardStep}`,
    `route=${summary.route}`
  ].join(" ");
}

const CHROME_RUNTIME_MESSAGE_SAFE_BYTES = 56 * 1024 * 1024;

function jsonPayloadBytes(value) {
  const json = JSON.stringify(value);
  try {
    return new TextEncoder().encode(json).length;
  } catch {
    return json.length;
  }
}

function refCarriesInlineData(ref = {}) {
  return /^data:/i.test(String(ref?.dataUrl || ""))
    || (!ref?.blobStoreId && /^data:/i.test(String(ref?.imageUrl || ref?.mediaUrl || "")));
}

function queuePayloadSummary(jobs = []) {
  const refInputs = jobs.flatMap((job) => Array.isArray(job.refInputs) ? job.refInputs : []);
  const nativeRefs = jobs.flatMap((job) => Array.isArray(job.nativeCharacterHandleMap) ? job.nativeCharacterHandleMap : []);
  const jsonSize = jsonPayloadBytes(jobs);
  return {
    jobs: jobs.length,
    refInputs: refInputs.length,
    nativeCharacterRefs: nativeRefs.length,
    nativeCharacterHandles: [...new Set(nativeRefs.map((ref) => String(ref?.handle || "").trim()).filter(Boolean))],
    blobRefs: refInputs.filter((ref) => ref?.blobStoreId).length,
    inlineDataRefs: refInputs.filter(refCarriesInlineData).length,
    mediaIdRefs: refInputs.filter((ref) => ref?.mediaId).length,
    approxPayloadBytes: jsonSize
  };
}

function assertQueuePayloadFitsChromeMessageLimit(queuedJobs = []) {
  const summary = queuePayloadSummary(queuedJobs);
  if (summary.approxPayloadBytes <= CHROME_RUNTIME_MESSAGE_SAFE_BYTES) return summary;
  throw new Error([
    "Queue payload is too large to send to Chrome.",
    "Reference images must remain blob-backed before queue start.",
    `payloadBytes=${summary.approxPayloadBytes}`,
    `jobs=${summary.jobs}`,
    `refs=${summary.refInputs}`,
    `blobRefs=${summary.blobRefs}`,
    `inlineRefs=${summary.inlineDataRefs}`
  ].join(" "));
}

function showLocalPreparingQueue(prompts = []) {
  const settings = taskSettingsForMode(state.control.mode);
  const isImage = state.control.mode === FLOW_MODES.textToImage;
  const repeatSlotMode = state.control.mode === FLOW_MODES.imageToVideo && imageToVideoRepeatFirstSlotCount() > 1;
  const expectedCount = Math.max(1, Number(settings.repeatCount || 1));
  const jobId = `local-preparing-${Date.now()}`;
  state.queue.running = true;
  state.queue.items = prompts.map((prompt, index) => ({
    id: `${jobId}-${index}`,
    jobId,
    jobIndex: index,
    jobPromptCount: prompts.length,
    jobTitle: queueBatchTitle(state.control.mode, prompts.length),
    prompt,
    mode: state.control.mode,
    status: "pending",
    submitPath: state.control.presets.submitPath,
    submitPathPreference: state.control.presets.submitPath,
    repeatCount: expectedCount,
    repeatSlotMode: repeatSlotMode ? "repeat_first_reference" : "",
    expectedImages: isImage ? expectedCount : 0,
    expectedVideos: isImage ? 0 : expectedCount,
    download: settings.download || {},
    localPreparing: true
  }));
}

// T2I -> F2V autopilot follow-up (issue #208). Called from
// applyRuntimePayload when the queue transitions running -> idle and
// state.control.autopilotPendingBatch is set. Reads the just-finished T2I
// tasks from the ledger snapshot, builds F2V job descriptors using the
// stored videoPrompt half (right of |||) and the generated image media id
// as the start frame reference, then enqueues + starts the queue.
async function runAutopilotF2VFollowUp(pending = {}) {
  const { jobId = "", mode = "off" } = pending || {};
  // Always clear the flag so we don't fire twice on repeated polls. If the
  // build fails or there's nothing to animate we still want it cleared.
  state.control.autopilotPendingBatch = null;
  if (mode !== "all" && mode !== "one") {
    await persistState();
    return;
  }
  // Prefer state.queue.items: those are the full task records from
  // ledger.listTasks() — they carry mediaUrl/thumbnailUrl on outputs[],
  // which the autopilot uses to build the F2V start-frame ref. Fall back
  // to taskLedgerSnapshot (which is the sanitized debug shape) only if
  // items is empty.
  const tasksSource = Array.isArray(state.queue?.items) && state.queue.items.length
    ? state.queue.items
    : (state.queue?.taskLedgerSnapshot || []);
  const batchTasks = tasksSource.filter((task) => String(task?.jobId || "") === String(jobId));
  const seeds = buildAutopilotF2VSeedsFromTasks(batchTasks, { mode });
  if (!seeds.length) {
    appendLog("warn", "queue", `Autopilot ${mode}: no animatable images in batch ${jobId}. Tasks must use the [Vn-Sn] image ||| video format and have at least one completed output.`);
    await persistState();
    return;
  }
  appendLog("info", "queue", `Autopilot ${mode}: queuing ${seeds.length} Frame-to-Video task${seeds.length === 1 ? "" : "s"} from T2I batch ${jobId}.`);
  // Switch the wizard mode so taskSettingsForMode + buildJobs treat this as
  // an F2V run. The wizard will rerender on the next render() tick.
  state.control.mode = FLOW_MODES.imageToVideo;
  // Stage the wizard's livePrompt + ref slots from the seeds. Each seed
  // provides one prompt line and one start-frame mediaId; F2V's promptMap
  // pairs the prompt at line N with the ref at index N.
  const refIds = seeds.map((seed, index) => `autopilot-${jobId}-${index}-${seed.startMediaId}`);
  const promptText = seeds.map((seed) => seed.videoPrompt).join("\n");
  const newRefs = seeds.map((seed, index) => ({
    id: refIds[index],
    blobStoreId: "",
    title: seed.sceneTag ? `${seed.sceneTag} (autopilot)` : "Autopilot frame",
    fileName: `autopilot-${seed.sceneTag || index + 1}.jpg`,
    mimeType: "image/jpeg",
    size: 0,
    imageUrl: seed.startMediaUrl || seed.startThumbnailUrl || "",
    dataUrl: "",
    mediaUrl: seed.startMediaUrl || "",
    mediaId: seed.startMediaId,
    createdAt: new Date().toISOString(),
    temporary: true,
    sourceTaskId: seed.sourceTaskId
  }));
  const existingTransient = Array.isArray(state.control.transientReferenceItems)
    ? state.control.transientReferenceItems
    : [];
  const existingIds = new Set(existingTransient.map((r) => String(r?.id || "")));
  state.control.transientReferenceItems = [
    ...newRefs.filter((r) => !existingIds.has(r.id)),
    ...existingTransient
  ].slice(0, 100);
  state.control.livePrompt = promptText;
  state.control.oneToOneBatchRefIds = refIds;
  state.control.activeApplyMode = "batch";
  state.control.promptRefMap = {};
  state.control.presets.mapLineRefs = true;
  state.control.promptMapOpen = true;
  state.control.references = {
    ...(state.control.references || {}),
    startFrameRef: refIds.join(" "),
    endFrameRef: ""
  };
  state.control.wizardStep = 3;
  await persistState();
  render();
  // Re-use the existing run path so we get folder allocation, history
  // snapshotting, and queue plumbing for free. enqueueAndRun reads
  // state.control.mode + livePrompt + refs, builds jobs, enqueues, runs.
  await enqueueAndRun();
}

async function enqueueAndRun() {
  let appendToActiveRun = false;
  try {
    // Clear any prior lastRunError so the wizard step 3 banner doesn't
    // flash a stale failure on a fresh Run attempt. Set in the catch block
    // below on actual failure.
    state.control.lastRunError = "";
    const prompts = promptLines();
    if (!prompts.length) throw new Error("Add at least one prompt.");
    if (state.control.mode === FLOW_MODES.imageToVideo && state.control.activeApplyMode === "repeat" && oneToOneBatchRefIds().length < 1) {
      throw new Error("Repeat 1st Prompt needs uploaded reference images.");
    }
    appendToActiveRun = Boolean(state.queue?.running);
    // Pre-validate refs for ref-required modes BEFORE mutating state. Without
    // this, the route flashes to Live Queue + render() shows a 'preparing'
    // card, THEN buildJobs() throws on the missing ref, the catch block
    // reverts to control + wizardStep 2 — the user sees a visible flash and
    // bounce. Validating here makes the failure a single render that stays
    // on the same wizard step.
    const currentMode = state.control?.mode;
    const characterPreflight = characterPreflightForPrompts(prompts);
    const hasNativeCharacterRefs = currentMode === FLOW_MODES.ingredientsToVideo
      && characterPreflight.active
      && characterPreflight.ok
      && (characterPreflight.usedHandles || []).length > 0;
    if (currentMode === FLOW_MODES.imageToVideo || currentMode === FLOW_MODES.ingredientsToVideo) {
      if (!modeHasAnyReference(state) && !hasNativeCharacterRefs) {
        if (characterPreflight.active && !characterPreflight.ok) {
          assertCharacterPreflightOk(characterPreflight);
        }
        const isI2V = currentMode === FLOW_MODES.imageToVideo;
        throw new Error(isI2V
          ? "Add a start frame reference image before running Frame to Video."
          : "Add at least one reference image before running Ingredients to Video.");
      }
    }
    assertCharacterPreflightOk(characterPreflight);
    const projectId = await ensureFlowProject();
    if (!projectId) throw new Error(state.runtime.error || translate("flowTabNotFoundGuidance", {}, currentLocale()));
    const historySnapshot = buildRunHistorySnapshot();
    appendLog("info", "diagnostics", `Run requested: ${compactRunDiagnosticText(runDiagnosticSummary(prompts))}.`);
    if (appendToActiveRun) {
      state.ui.galleryTab = state.control.mode === FLOW_MODES.textToImage ? "images" : "videos";
      appendLog("info", "queue", `Preparing ${prompts.length} prompt${prompts.length === 1 ? "" : "s"} to append to the active queue.`);
      const jobs = await buildJobs();
      const payloadSummary = queuePayloadSummary(jobs);
      appendLog("info", "diagnostics", `Append job build complete: jobs=${payloadSummary.jobs} refs=${payloadSummary.refInputs} nativeRefs=${payloadSummary.nativeCharacterRefs} nativeHandles=${payloadSummary.nativeCharacterHandles.join(",") || "-"} blobRefs=${payloadSummary.blobRefs} inlineRefs=${payloadSummary.inlineDataRefs} mediaIdRefs=${payloadSummary.mediaIdRefs} payloadBytes=${payloadSummary.approxPayloadBytes}.`);
      const { added } = await enqueueJobs(jobs);
      if (added > 0 && rememberRunSnapshot(historySnapshot)) {
        clearActiveRunDraft();
        appendLog("info", "history", "Saved editable run snapshot to History.");
      }
      state.ui.activeRoute = "live";
      appendLog("info", "queue", `Added ${added} task${added === 1 ? "" : "s"} to the active queue.`);
      await persistState();
      render();
      if (state.queue.running) {
        scheduleRuntimeRefresh(0);
        scheduleLiveQueueRefreshBurst();
      } else {
        await runQueue();
      }
      return;
    }
    if ((state.queue.items || []).length) {
      await clearQueue({ renderAfter: false });
      appendLog("info", "queue", "Cleared the previous queue before starting a fresh Run.");
    }
    state.ui.activeRoute = "live";
    state.ui.galleryTab = state.control.mode === FLOW_MODES.textToImage ? "images" : "videos";
    const preparingPrompts = jobPromptLinesForRun();
    showLocalPreparingQueue(preparingPrompts);
    appendLog("info", "queue", `Preparing ${preparingPrompts.length} prompt${preparingPrompts.length === 1 ? "" : "s"} for ${state.ui.galleryTab}.`);
    render();
    await nextAnimationFrame();
    const jobs = await buildJobs();
    const payloadSummary = queuePayloadSummary(jobs);
    appendLog("info", "diagnostics", `Job build complete: jobs=${payloadSummary.jobs} refs=${payloadSummary.refInputs} nativeRefs=${payloadSummary.nativeCharacterRefs} nativeHandles=${payloadSummary.nativeCharacterHandles.join(",") || "-"} blobRefs=${payloadSummary.blobRefs} inlineRefs=${payloadSummary.inlineDataRefs} mediaIdRefs=${payloadSummary.mediaIdRefs} payloadBytes=${payloadSummary.approxPayloadBytes}.`);
    const { added, jobId: queuedJobId } = await enqueueJobs(jobs);
    if (added > 0 && rememberRunSnapshot(historySnapshot)) {
      clearActiveRunDraft();
      appendLog("info", "history", "Saved editable run snapshot to History.");
    }
    // Autopilot T2I -> F2V (issue #208). When the user picks "Animate all" or
    // "Animate one" on a textToImage run, stamp the running batch's jobId so
    // the queue-completion hook in applyRuntimePayload knows to follow up
    // with a Frame-to-Video batch built from the generated image media ids.
    const autopilotMode = state.control.mode === FLOW_MODES.textToImage
      ? String(state.control.presets.autopilotT2IToF2V || "off")
      : "off";
    const autopilotReady = state.control.mode === FLOW_MODES.textToImage && promptsHaveAutopilotVideoPrompts(prompts);
    if (added > 0 && (autopilotMode === "all" || autopilotMode === "one") && queuedJobId && autopilotReady) {
      state.control.autopilotPendingBatch = { jobId: queuedJobId, mode: autopilotMode };
      appendLog("info", "queue", `Autopilot armed: will animate ${autopilotMode === "all" ? "all" : "one random"} generated image after T2I run completes.`);
    } else if (added > 0 && (autopilotMode === "all" || autopilotMode === "one") && !autopilotReady) {
      state.control.autopilotPendingBatch = null;
      appendLog("warn", "queue", "After Run skipped: every prompt line must use Auto Flow format with image prompt ||| video prompt.");
    }
    await persistState();
    render();
    await runQueue();
  } catch (error) {
    appendLog("error", "diagnostics", `Run failed before/around queue start: ${error.message}; ${compactRunDiagnosticText(runDiagnosticSummary())}.`);
    // Surface a user-visible explanation in the wizard step 3 banner so the
    // bounce from Live Queue back to Control isn't silent. User reports
    // 2026-05-02_171146Z and 2026-05-02_172605Z both showed silent bounce
    // with no UI explanation — only the Logs tab carried the reason.
    const errorMessage = String(error?.message || "Run failed.").trim();
    state.control.lastRunError = errorMessage;
    state.queue.items = (state.queue.items || []).filter((item) => item.localPreparing !== true);
    if (!appendToActiveRun) {
      state.queue.running = false;
    }
    const needsControlFix = /reference|start frame|ingredients|prompt|character|voice/i.test(errorMessage);
    state.ui.activeRoute = needsControlFix ? "control" : appendToActiveRun ? "live" : "control";
    if (/reference|start frame|ingredients/i.test(errorMessage)) {
      state.control.wizardStep = 2;
    } else if (/prompt|character|voice/i.test(errorMessage)) {
      state.control.wizardStep = 1;
    }
    appendLog("error", "queue", error.message);
    await persistState();
    render();
  }
}

async function requestEnqueueAndRun() {
  if (enqueueAndRunInFlight) return;
  enqueueAndRunInFlight = true;
  try {
    await enqueueAndRun();
  } finally {
    enqueueAndRunInFlight = false;
  }
}

async function enqueueJobs(prebuiltJobs = null) {
  const jobs = Array.isArray(prebuiltJobs) ? prebuiltJobs : await buildJobs();
  const settings = taskSettingsForMode(state.control.mode);
  const folderAllocation = nextDownloadFolderForRun();
  settings.download = {
    ...(settings.download || {}),
    folder: folderAllocation.folder,
    baseFolder: folderAllocation.baseFolder,
    runFolderIndex: folderAllocation.runIndex
  };
  const jobId = crypto.randomUUID();
  const jobPromptCount = jobs.length;
  const jobTitle = queueBatchTitle(state.control.mode, jobPromptCount);
  const queuedJobs = jobs.map((job, jobIndex) => ({
    ...job,
    autoRetryFailedUntilZero: state.control.presets.autoRetryFailedUntilZero === true,
    download: {
      ...(job.download && typeof job.download === "object" ? job.download : {}),
      ...(settings.download || {})
    },
    jobId,
    jobIndex,
    jobPromptCount,
    jobTitle
  }));
  const payloadSummary = assertQueuePayloadFitsChromeMessageLimit(queuedJobs);
  appendLog("info", "diagnostics", `Queue add payload: jobs=${payloadSummary.jobs} refs=${payloadSummary.refInputs} nativeRefs=${payloadSummary.nativeCharacterRefs} nativeHandles=${payloadSummary.nativeCharacterHandles.join(",") || "-"} blobRefs=${payloadSummary.blobRefs} inlineRefs=${payloadSummary.inlineDataRefs} mediaIdRefs=${payloadSummary.mediaIdRefs} payloadBytes=${payloadSummary.approxPayloadBytes}.`);
  const response = await send(MessageType.QueueAddJob, {
    jobs: queuedJobs,
    jobId,
    jobPromptCount,
    jobTitle,
    mode: state.control.mode,
    projectId: state.runtime.projectId,
    submitPath: state.control.presets.submitPath,
    autoRetryFailedUntilZero: state.control.presets.autoRetryFailedUntilZero === true,
    videoLength: state.control.presets.videoLength,
    ...settings
  });
  applyRuntimePayload(response?.payload || {});
  if (Number(response?.payload?.added || 0) > 0) {
    commitDownloadFolderRunAllocation(folderAllocation);
  }
  appendLog("info", "queue", `Added ${Number(response?.payload?.added || 0)} task(s).`);
  await persistState();
  return { added: Number(response?.payload?.added || 0), jobId };
}

function modeHasAnyReference(currentState = state) {
  // Mirrors activeReferenceIdsForMode in control-wizard.js without
  // importing across the view layer. Returns true if any ref id is
  // attached for the current mode (one-to-one batch, per-prompt map,
  // or the mode-specific reference slot).
  const control = currentState?.control || {};
  const refs = control.references || {};
  const splitIds = (value) => String(value || "").split(/\s+/).map((id) => id.trim()).filter(Boolean);
  const batch = Array.isArray(control.oneToOneBatchRefIds) ? control.oneToOneBatchRefIds.filter(Boolean) : [];
  if (batch.length) return true;
  const promptRefs = control.promptRefMap || {};
  for (const value of Object.values(promptRefs)) {
    if (Array.isArray(value) ? value.some(Boolean) : Boolean(value)) return true;
  }
  if (control.mode === FLOW_MODES.imageToVideo) {
    return splitIds(refs.startFrameRef).length > 0 || splitIds(refs.endFrameRef).length > 0;
  }
  if (control.mode === FLOW_MODES.ingredientsToVideo) {
    return splitIds(refs.ingredientsRefs).length > 0;
  }
  if (control.mode === FLOW_MODES.textToImage) {
    return splitIds(refs.imagePromptRefs).length > 0
      || splitIds(refs.styleRefRefs).length > 0
      || splitIds(refs.omniRefRefs).length > 0;
  }
  return false;
}

function nextAnimationFrame() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(finish);
    window.setTimeout(finish, 80);
  });
}

function queueBatchTitle(mode, count = 0) {
  const labels = {
    [FLOW_MODES.textToImage]: "Create Image",
    [FLOW_MODES.imageToVideo]: "Frame to Video",
    [FLOW_MODES.textToVideo]: "Text to Video",
    [FLOW_MODES.ingredientsToVideo]: "Ingredients"
  };
  const total = Number(count || 0);
  return `${labels[mode] || "Auto Flow"} - ${total} prompt${total === 1 ? "" : "s"}`;
}

async function runQueue() {
  state.ui.activeRoute = "live";
  await persistState();
  render();
  const response = await send(MessageType.QueueStart, {
    environment: authEnvironment(),
    tabId: state.runtime.activeTabId || undefined,
    projectId: state.runtime.projectId || undefined
  });
  applyRuntimePayload(response?.payload || {});
  scheduleRuntimeRefresh(0);
  scheduleLiveQueueRefreshBurst();
  if (response?.payload?.ok === false) {
    appendLog("warn", "queue", response.payload.error || "License required.");
  } else {
    appendLog("info", "queue", response?.payload?.startedTaskId ? "Queue started." : "No pending tasks.");
  }
  await persistState();
  render();
}

async function resumeQueue(options = {}) {
  const response = await send(MessageType.QueueResume, {
    environment: authEnvironment(),
    switchApiFirstQuotaSuspectedToDom: options.switchApiFirstQuotaSuspectedToDom === true,
    sourceTaskId: options.sourceTaskId || "",
    browserModeTaskId: options.browserModeTaskId || ""
  });
  applyRuntimePayload(response?.payload || {});
  const resumed = Number(response?.payload?.resumed || 0);
  const pending = Number(response?.payload?.pending || 0);
  const switched = Number(response?.payload?.switchedPendingRowsToDom || 0);
  if (resumed > 0 || response?.payload?.startedPending === true) {
    state.ui.activeRoute = "live";
  }
  appendLog("info", "queue", `Resume requested for ${resumed} blocked and ${pending} pending task(s)${switched ? `; switched ${switched} to browser mode` : ""}.`);
  await persistState();
  render();
}

async function stopQueue() {
  const response = await send(MessageType.QueueStop);
  applyRuntimePayload(response?.payload || {});
  appendLog("info", "queue", "Stop requested.");
  await persistState();
}

async function pruneFinishedQueueItems() {
  const response = await send(MessageType.QueuePrune, {
    statuses: ["complete", "done", "failed", "blocked"]
  }).catch(() => null);
  applyRuntimePayload(response?.payload || {});
  appendLog("info", "queue", `Cleared ${Number(response?.payload?.removed || 0)} finished queue item(s).`);
  await persistState();
  render();
}

async function clearQueue({ force = false, renderAfter = true } = {}) {
  if (state.queue.running && !force) return;
  if (state.queue.running && force) {
    await send(MessageType.QueueStop).catch(() => null);
    state.queue.running = false;
  }
  const response = await send(MessageType.QueueClear).catch(() => null);
  applyRuntimePayload(response?.payload || { queue: { tasks: [] }, queueRunning: false });
  appendLog("info", "queue", "Queue cleared.");
  await persistState();
  if (renderAfter) render();
}

galleryController = createGalleryController({
  getState: () => state,
  send,
  appendLog,
  persistState,
  hydrateStateFromStorage,
  render,
  updatePreset,
  applyRuntimePayload,
  openExternal,
  captureUiSnapshot,
  restoreUiSnapshot,
  ensureFlowProject,
  ensureMediaIds,
  taskSettingsForMode,
  queueBatchTitle,
  resumeQueue,
  stopQueue,
  pruneFinishedQueueItems,
  clearQueue
});

async function boot() {
  await loadBuildFingerprint();
  await loadState();
  bindTabs();
  bindHeader();
  bindControlActionDelegate();
  bindStorageUpdates();
  bindFlowProjectTabUpdates();
  render();
  await sendAuth("init").catch((error) => {
    appendLog("error", "account", `Auth init failed: ${error.message}`);
  });
  await persistState();
  render();
  await syncRuntimeFromOpenFlowTab();
  refreshRuntime({ includeGallery: false });
  scheduleRuntimeRefresh();
}

boot();
