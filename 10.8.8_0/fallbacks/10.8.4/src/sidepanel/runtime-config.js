import { normalizeSceneClip, totalSceneDuration } from "../core/gallery/scene-builder.js";

export const PRODUCT_NAME = "Auto Flow";
export const STORAGE_KEY = "autoflow-10767-rebuild-sidepanel-state-fallback-10-8-4";

const VIDEO_MODEL_KEYS = Object.freeze([
  "default",
  "veo3_lite",
  "veo3_lite_low",
  "veo3_fast",
  "veo3_fast_low",
  "veo3_quality"
]);

const INGREDIENTS_VIDEO_MODEL_KEYS = Object.freeze([
  "veo3_fast_low",
  "veo3_fast"
]);

export const FLOW_MODES = Object.freeze({
  textToImage: "text-to-image",
  textToVideo: "text-to-video",
  imageToVideo: "image-to-video",
  ingredientsToVideo: "ingredients-to-video"
});

export function createDefaultState(now = new Date().toISOString()) {
  return {
    version: 4,
    seededAt: now,
    ui: {
      activeRoute: "control",
      galleryTab: "images",
      galleryScope: "all",
      galleryViewMode: "grid",
      gallerySize: "small",
      gallerySortOrder: "num-asc",
      videoSpeed: "1",
      videoVolume: "0.05",
      selectedGalleryIds: [],
      deleteMarkedGalleryIds: [],
      openInlineHelpPanel: "",
      galleryHelpKey: "",
      helpOpen: false,
      activeHelpTopic: "text_to_video",
      walkthrough: null
    },
    runtime: {
      connected: false,
      activeTabId: null,
      projectId: "",
      pageUrl: "",
      pageTitle: "",
      bridgeHealthy: false,
      bridgeVersion: "",
      pageHookVersion: "",
      pageHookInstalled: false,
      hasNativeFetch: false,
      bridgeError: null,
      error: null,
      lastSyncAt: null
    },
    control: {
      mode: FLOW_MODES.imageToVideo,
      livePrompt: "",
      wizardStep: 1,
      lastRunError: "",
      promptMapOpen: false,
      promptMapFullscreen: false,
      promptRefMap: {},
      oneToOneBatchRefIds: [],
      transientReferenceItems: [],
      saveUploadsToLibrary: false,
      autopilotPendingBatch: null,
      references: {
        imagePromptRefs: "",
        styleRefRefs: "",
        omniRefRefs: "",
        startFrameRef: "",
        endFrameRef: "",
        ingredientsRefs: ""
      },
      presets: {
        submitPath: "api_first",
        submitPathPreference: "api_first",
        videoLength: "6",
        aspectRatio: "portrait",
        imageAspectRatio: "portrait",
        model: "default",
        ingredientsModel: "veo3_fast_low",
        imageModel: "nano_banana_pro",
        returnSilentVideos: true,
        repeatCount: 4,
        imageRepeatCount: 4,
        startFrom: 1,
        safeRefAttachMode: true,
        overnight403Recovery: false,
        minInitialWaitTime: 20,
        maxInitialWaitTime: 40,
        recaptchaCooldownSmallThreshold: 15,
        recaptchaCooldownSmallWait: 30,
        recaptchaCooldownLargeThreshold: 30,
        recaptchaCooldownLargeWait: 60,
        autoDownload: true,
        autoDownloadImages: true,
        videoDownloadResolution: "720p",
        videoDownloadMethodPreference: "auto",
        imageAutoDownloadResolution: "1k",
        imageDownloadMethodPreference: "auto",
        downloadFolder: "Auto-Flow",
        autoNumberFolder: true,
        downloadFolderRunIndex: 0,
        downloadFolderLastBase: "Auto-Flow",
        t2iSubmitMode: "safe_serial",
        t2iBatchSize: 2,
        filenameStyle: "detailed",
        filenameTemplatePrefix: "",
        filenameTemplateIndex: "nn",
        filenameTemplatePromptPart: "first_3_words",
        filenameTemplateDate: "none",
        filenameTemplateSuffix: "none",
        filenameTemplateSeparator: "_",
        language: "en",
        mapLineRefs: true,
        autoStartNextJob: true,
        autoRetryFailedUntilZero: false,
        autopilotT2IToF2V: "off"
      }
    },
    queue: {
      running: false,
      paused: false,
      items: [],
      runtimeEvents: []
    },
    gallery: {
      items: [],
      deletedIds: [],
      meta: {
        source: "not_synced",
        fetchedAt: null
      }
    },
    scenes: {
      clips: [],
      audioName: "",
      selectedClipIds: [],
      totalDuration: 0,
      updatedAt: null
    },
    referenceLibrary: {
      savedItems: [],
      lastSyncedAt: null
    },
    history: {
      runs: []
    },
    settings: {
      persistLogs: true,
      requireFlowTab: true,
      debugCapture: false
    },
    account: {
      status: "unknown",
      email: null,
      userId: null,
      plan: "free",
      subscriptionStatus: "inactive",
      currentPeriodEnd: null,
      usage: {
        allowed: false,
        unlimited: false,
        limit: 10,
        used: 0,
        remaining: 10,
        resetAt: null
      },
      pendingCheckout: false,
      otpCode: "",
      message: null,
      error: null,
      lastCheckedAt: null
    },
    logs: {
      items: [
        {
          id: "log-bootstrap",
          level: "info",
          scope: "bootstrap",
          message: `${PRODUCT_NAME} initialized.`,
          createdAt: now
        }
      ]
    },
    login: {
      status: "unknown",
      provider: "flow",
      lastCheckedAt: null,
      email: null,
      userId: null,
      providers: [],
      moodboards: []
    }
  };
}

export function mergeState(base, incoming) {
  if (!incoming || typeof incoming !== "object") return structuredClone(base);
  const output = deepMerge(structuredClone(base), incoming);
  output.version = base.version;

  if (!["control", "live", "gallery", "history", "settings", "logs", "scenes"].includes(output.ui.activeRoute)) {
    output.ui.activeRoute = "control";
  }
  if (!["images", "videos"].includes(output.ui.galleryTab)) {
    output.ui.galleryTab = "images";
  }
  output.ui.galleryScope = "all";
  if (!["grid", "table", "live"].includes(output.ui.galleryViewMode)) {
    output.ui.galleryViewMode = "grid";
  }
  if (!["small", "medium"].includes(output.ui.gallerySize)) {
    output.ui.gallerySize = "small";
  }
  if (!["default", "num-asc", "num-desc", "az", "za"].includes(output.ui.gallerySortOrder)) {
    output.ui.gallerySortOrder = "num-asc";
  }
  output.ui.videoSpeed = String(output.ui.videoSpeed || "1");
  output.ui.videoVolume = String(output.ui.videoVolume || "0.05");
  if (!Object.values(FLOW_MODES).includes(output.control.mode)) {
    output.control.mode = FLOW_MODES.imageToVideo;
  }

  output.control.livePrompt = String(output.control.livePrompt || "");
  output.control.wizardStep = clampInt(output.control.wizardStep, 1, 3, 1);
  output.control.promptMapOpen = Boolean(output.control.promptMapOpen);
  output.control.promptMapFullscreen = Boolean(output.control.promptMapFullscreen);
  output.control.promptRefMap = normalizePromptRefMap(output.control.promptRefMap);
  output.control.oneToOneBatchRefIds = normalizeIdArray(output.control.oneToOneBatchRefIds);
  output.control.transientReferenceItems = Array.isArray(output.control.transientReferenceItems)
    ? output.control.transientReferenceItems.slice(0, 100)
    : [];
  output.control.saveUploadsToLibrary = output.control.saveUploadsToLibrary === true;
  output.control.presets = normalizePresets(output.control.presets, Number(incoming.version || 0));
  output.control.references = normalizeReferences(output.control.references);
  output.queue.items = Array.isArray(output.queue.items) ? output.queue.items : [];
  output.gallery.items = Array.isArray(output.gallery.items) ? output.gallery.items : [];
  output.gallery.deletedIds = Array.isArray(output.gallery.deletedIds) ? output.gallery.deletedIds : [];
  output.ui.selectedGalleryIds = Array.isArray(output.ui.selectedGalleryIds) ? output.ui.selectedGalleryIds : [];
  output.ui.deleteMarkedGalleryIds = Array.isArray(output.ui.deleteMarkedGalleryIds) ? output.ui.deleteMarkedGalleryIds : [];
  output.ui.openInlineHelpPanel = String(output.ui.openInlineHelpPanel || "");
  output.ui.galleryHelpKey = String(output.ui.galleryHelpKey || "");
  output.ui.helpOpen = Boolean(output.ui.helpOpen);
  output.ui.activeHelpTopic = String(output.ui.activeHelpTopic || "text_to_video");
  output.ui.walkthrough = normalizeWalkthrough(output.ui.walkthrough);
  output.scenes = normalizeScenes(output.scenes);
  output.logs.items = Array.isArray(output.logs.items) ? output.logs.items.slice(-300) : [];
  output.referenceLibrary.savedItems = Array.isArray(output.referenceLibrary.savedItems)
    ? output.referenceLibrary.savedItems.slice(0, 100)
    : [];
  output.history = normalizeHistory(output.history);
  output.account = normalizeAccount(output.account);
  return output;
}

function normalizePresets(presets = {}, sourceVersion = 0) {
  const base = createDefaultState().control.presets;
  const out = { ...base, ...(presets && typeof presets === "object" ? presets : {}) };
  // The validators below (allow-list checks + clampInt) replace any invalid
  // stored value with a system default. They are the single source of truth
  // for migration. We intentionally do NOT force-reset these keys for
  // sourceVersion < 3: that destroyed valid user choices on first load
  // (Alpha Bravo report 2026-05-04: Settings tab shows landscape but Run
  // page step 3 shows portrait — user's stored landscape was being wiped
  // by the migration on every cold load until first persistState bumped
  // version to 4).
  void sourceVersion;
  const submitPath = out.submitPath || out.submitPathPreference;
  out.submitPath = submitPath === "dom_first" || submitPath === "dom_fallback" ? "dom_first" : "api_first";
  out.submitPathPreference = out.submitPath;
  out.videoLength = ["4", "6", "8"].includes(String(out.videoLength)) ? String(out.videoLength) : "6";
  out.aspectRatio = ["landscape", "portrait"].includes(out.aspectRatio) ? out.aspectRatio : "portrait";
  out.imageAspectRatio = ["landscape", "landscape_4_3", "square", "portrait_3_4", "portrait"].includes(out.imageAspectRatio)
    ? out.imageAspectRatio
    : "portrait";
  out.repeatCount = clampInt(out.repeatCount, 1, 4, 4);
  out.imageRepeatCount = clampInt(out.imageRepeatCount, 1, 4, 4);
  out.startFrom = clampInt(out.startFrom, 1, 9999, 1);
  out.minInitialWaitTime = clampInt(out.minInitialWaitTime, 1, 999, 20);
  out.maxInitialWaitTime = Math.max(out.minInitialWaitTime, clampInt(out.maxInitialWaitTime, 1, 999, 40));
  out.recaptchaCooldownSmallThreshold = clampInt(out.recaptchaCooldownSmallThreshold, 1, 999, 15);
  out.recaptchaCooldownSmallWait = clampInt(out.recaptchaCooldownSmallWait, 0, 999, 30);
  out.recaptchaCooldownLargeThreshold = clampInt(out.recaptchaCooldownLargeThreshold, 1, 999, 30);
  out.recaptchaCooldownLargeWait = clampInt(out.recaptchaCooldownLargeWait, 0, 999, 60);
  out.t2iBatchSize = clampInt(out.t2iBatchSize, 1, 3, 2);
  out.model = VIDEO_MODEL_KEYS.includes(out.model) ? out.model : "default";
  out.ingredientsModel = INGREDIENTS_VIDEO_MODEL_KEYS.includes(out.ingredientsModel) ? out.ingredientsModel : "veo3_fast_low";
  out.imageModel = ["nano_banana_pro", "nano_banana_2", "imagen_4"].includes(out.imageModel) ? out.imageModel : "nano_banana_pro";
  out.returnSilentVideos = out.returnSilentVideos !== false && out.returnSilentVideos !== "false";
  out.videoDownloadResolution = ["720p", "1080p", "4k"].includes(out.videoDownloadResolution) ? out.videoDownloadResolution : "720p";
  out.videoDownloadMethodPreference = ["auto", "api", "dom"].includes(out.videoDownloadMethodPreference) ? out.videoDownloadMethodPreference : "auto";
  out.imageAutoDownloadResolution = ["1k", "2k", "4k"].includes(out.imageAutoDownloadResolution) ? out.imageAutoDownloadResolution : "1k";
  out.imageDownloadMethodPreference = ["auto", "api", "dom"].includes(out.imageDownloadMethodPreference) ? out.imageDownloadMethodPreference : "auto";
  out.t2iSubmitMode = ["safe_serial", "fast_batch"].includes(out.t2iSubmitMode) ? out.t2iSubmitMode : "safe_serial";
  out.filenameStyle = ["detailed", "prompt_prefix", "auto_flow", "custom_template"].includes(out.filenameStyle) ? out.filenameStyle : "detailed";
  out.autopilotT2IToF2V = ["off", "all", "one"].includes(out.autopilotT2IToF2V) ? out.autopilotT2IToF2V : "off";
  out.filenameTemplateIndex = ["none", "n", "nn", "nnn"].includes(out.filenameTemplateIndex) ? out.filenameTemplateIndex : "nn";
  out.filenameTemplatePromptPart = ["none", "first_word", "first_3_words", "slug_8"].includes(out.filenameTemplatePromptPart) ? out.filenameTemplatePromptPart : "first_3_words";
  out.filenameTemplateDate = ["none", "yyyymmdd", "yymmdd_hhmm"].includes(out.filenameTemplateDate) ? out.filenameTemplateDate : "none";
  out.filenameTemplateSuffix = ["none", "rand4", "rand8"].includes(out.filenameTemplateSuffix) ? out.filenameTemplateSuffix : "none";
  out.filenameTemplateSeparator = ["_", "-"].includes(out.filenameTemplateSeparator) ? out.filenameTemplateSeparator : "_";
  out.downloadFolder = normalizeDownloadFolderBase(out.downloadFolder);
  out.downloadFolderRunIndex = clampInt(out.downloadFolderRunIndex, 0, 9999, 0);
  out.downloadFolderLastBase = normalizeDownloadFolderBase(out.downloadFolderLastBase || out.downloadFolder);
  out.filenameTemplatePrefix = String(out.filenameTemplatePrefix || "");
  out.language = normalizeLanguage(out.language);
  out.safeRefAttachMode = Boolean(out.safeRefAttachMode);
  out.overnight403Recovery = Boolean(out.overnight403Recovery);
  out.autoDownload = Boolean(out.autoDownload);
  out.autoDownloadImages = Boolean(out.autoDownloadImages);
  out.autoNumberFolder = Boolean(out.autoNumberFolder);
  out.mapLineRefs = Boolean(out.mapLineRefs);
  out.autoStartNextJob = Boolean(out.autoStartNextJob);
  out.autoRetryFailedUntilZero = Boolean(out.autoRetryFailedUntilZero);
  return out;
}

function normalizeDownloadFolderBase(value = "Auto-Flow") {
  const raw = String(value || "Auto-Flow").trim();
  if (raw === "Auto-Flow-01") return "Auto-Flow";
  return raw || "Auto-Flow";
}

function clampInt(value, min, max, fallback) {
  const next = Number.parseInt(value, 10);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

function normalizeReferences(refs = {}) {
  const base = createDefaultState().control.references;
  return Object.fromEntries(
    Object.keys(base).map((key) => [key, String(refs?.[key] || "")])
  );
}

function normalizeHistory(history = {}) {
  const runs = Array.isArray(history?.runs) ? history.runs : [];
  return {
    runs: runs
      .filter((run) => run && typeof run === "object")
      .map((run) => ({
        id: String(run.id || ""),
        title: String(run.title || ""),
        mode: Object.values(FLOW_MODES).includes(run.mode) ? run.mode : FLOW_MODES.imageToVideo,
        promptCount: clampInt(run.promptCount, 0, 10000, 0),
        promptsText: String(run.promptsText || ""),
        createdAt: String(run.createdAt || ""),
        projectId: String(run.projectId || ""),
        refs: Array.isArray(run.refs) ? run.refs.slice(0, 20).map(normalizeHistoryRef).filter(Boolean) : [],
        control: normalizeHistoryControl(run.control)
      }))
      .filter((run) => run.id && run.promptsText.trim())
      .slice(0, 50)
  };
}

function normalizeHistoryRef(ref = {}) {
  const id = String(ref.id || "").trim();
  if (!id) return null;
  return {
    id,
    blobStoreId: String(ref.blobStoreId || ""),
    title: String(ref.title || ref.fileName || "Reference"),
    fileName: String(ref.fileName || ref.title || "reference.png"),
    mediaId: String(ref.mediaId || ""),
    imageUrl: String(ref.imageUrl || ref.mediaUrl || "")
  };
}

function normalizeHistoryControl(control = {}) {
  const base = createDefaultState().control;
  const refs = normalizeReferences(control?.references || {});
  return {
    mode: Object.values(FLOW_MODES).includes(control?.mode) ? control.mode : base.mode,
    livePrompt: String(control?.livePrompt || ""),
    wizardStep: clampInt(control?.wizardStep, 1, 3, 1),
    lastRunError: String(control?.lastRunError || ""),
    promptMapOpen: Boolean(control?.promptMapOpen),
    promptMapFullscreen: false,
    promptRefMap: normalizePromptRefMap(control?.promptRefMap || {}),
    oneToOneBatchRefIds: normalizeIdArray(control?.oneToOneBatchRefIds || []),
    references: refs,
    activeApplyMode: String(control?.activeApplyMode || "shared"),
    presets: normalizePresets(control?.presets || {}, 4)
  };
}

function normalizeIdArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id || "").trim()).filter(Boolean))];
}

function normalizePromptRefMap(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [key, ids] of Object.entries(value)) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) continue;
    output[normalizedKey] = Array.isArray(ids)
      ? ids.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
  }
  return output;
}

function normalizeAccount(account) {
  const source = account && typeof account === "object" ? account : {};
  return {
    status: ["unknown", "signed_out", "signed_in", "pending_confirmation"].includes(source.status) ? source.status : "unknown",
    email: source.email || null,
    userId: source.userId || null,
    plan: ["free", "pro", "team"].includes(source.plan) ? source.plan : "free",
    subscriptionStatus: source.subscriptionStatus || "inactive",
    currentPeriodEnd: source.currentPeriodEnd || null,
    usage: normalizeUsage(source.usage),
    pendingCheckout: Boolean(source.pendingCheckout),
    otpCode: source.otpCode || "",
    message: source.message || null,
    error: source.error || null,
    lastCheckedAt: source.lastCheckedAt || null
  };
}

function normalizeScenes(scenes = {}) {
  const source = scenes && typeof scenes === "object" ? scenes : {};
  const clips = Array.isArray(source.clips) ? source.clips : [];
  const normalizedClips = clips.slice(0, 200).map(normalizeSceneClip).filter(Boolean);
  const clipIds = new Set(normalizedClips.map((clip) => clip.id));
  return {
    clips: normalizedClips,
    audioName: String(source.audioName || ""),
    selectedClipIds: normalizeIdArray(source.selectedClipIds || []).filter((id) => clipIds.has(id)),
    totalDuration: totalSceneDuration(normalizedClips),
    updatedAt: source.updatedAt || null
  };
}

function normalizeWalkthrough(walkthrough) {
  if (!walkthrough || typeof walkthrough !== "object") return null;
  return {
    topicId: String(walkthrough.topicId || "text_to_video"),
    stepIndex: clampInt(walkthrough.stepIndex, 0, 99, 0)
  };
}

function normalizeLanguage(language = "en") {
  const raw = String(language || "en").trim().toLowerCase().replace("_", "-");
  const primary = raw.split("-")[0];
  const allowed = new Set(["en", "vi", "tr", "ar", "de", "fr", "ja", "id", "ko", "it", "ru", "nl", "hi", "th", "ur", "bn", "es", "tl", "pt"]);
  if (raw === "es-419") return "es";
  if (raw === "pt-br" || raw === "pt-pt") return "pt";
  if (raw === "fil") return "tl";
  return allowed.has(primary) ? primary : "en";
}

function normalizeUsage(usage = {}) {
  const limit = Number.isFinite(Number(usage.limit)) ? Number(usage.limit) : 10;
  const used = Number.isFinite(Number(usage.used)) ? Number(usage.used) : 0;
  const remaining = Number.isFinite(Number(usage.remaining)) ? Number(usage.remaining) : Math.max(0, limit - used);
  return {
    allowed: usage.allowed === true,
    unlimited: usage.unlimited === true,
    limit,
    used,
    remaining,
    resetAt: usage.resetAt || null
  };
}

function deepMerge(target, source) {
  if (!source || typeof source !== "object") return target;
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      target[key] = [...value];
      continue;
    }
    if (value && typeof value === "object") {
      target[key] = deepMerge(target[key] && typeof target[key] === "object" ? target[key] : {}, value);
      continue;
    }
    target[key] = value;
  }
  return target;
}
