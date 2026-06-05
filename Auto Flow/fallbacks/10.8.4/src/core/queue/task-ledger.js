export const TaskStatus = Object.freeze({
  pending: "pending",
  submitting: "submitting",
  generating: "generating",
  downloading: "downloading",
  complete: "complete",
  failed: "failed",
  blocked: "blocked"
});

const REDACTED_EVENT_KEYS = new Set(["dataUrl", "imageUrl", "imageBytes", "base64", "bytesBase64"]);

function sanitizeEventValue(value, key = "", depth = 0) {
  if (REDACTED_EVENT_KEYS.has(String(key))) {
    const length = typeof value === "string" ? value.length : 0;
    return length ? `[omitted:${length} chars]` : "[omitted]";
  }
  if (typeof value === "string") {
    return value.length > 1200 ? `${value.slice(0, 240)}...[truncated:${value.length} chars]` : value;
  }
  if (!value || typeof value !== "object") return value;
  if (depth > 5) return "[truncated:depth]";
  if (Array.isArray(value)) return value.map((entry) => sanitizeEventValue(entry, "", depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitizeEventValue(entryValue, entryKey, depth + 1)])
  );
}

export function sanitizeTaskEventPatch(patch = {}) {
  return sanitizeEventValue(patch || {}, "", 0);
}

function compactIdList(values = []) {
  return [...new Set((values || [])
    .map((id) => String(id || "").trim())
    .filter(Boolean))];
}

function generatedMediaIdsFromTask(task = {}) {
  const referenceIds = new Set(compactIdList([
    ...(Array.isArray(task.refMediaIds) ? task.refMediaIds : []),
    task.startMediaId,
    task.endMediaId,
    ...(Array.isArray(task.refInputs) ? task.refInputs.map((ref) => ref?.mediaId || ref?.assetImageId) : []),
    task.startRefInput?.mediaId || task.startRefInput?.assetImageId,
    task.endRefInput?.mediaId || task.endRefInput?.assetImageId
  ]));
  return compactIdList([
    ...(Array.isArray(task.outputMediaIds) ? task.outputMediaIds : []),
    ...(Array.isArray(task.outputs) ? task.outputs.map((output) => output?.mediaId) : []),
    ...(Array.isArray(task.mediaIds) ? task.mediaIds : [])
  ]).filter((id) => !referenceIds.has(id));
}

function compactRefForDebug(ref = {}) {
  if (!ref || typeof ref !== "object") return null;
  const mediaId = String(ref.mediaId || ref.assetImageId || "").trim();
  const fileName = String(ref.fileName || ref.name || ref.title || "").trim();
  if (!mediaId && !fileName) return null;
  return {
    role: String(ref.role || "").trim(),
    mediaId,
    blobStoreId: String(ref.blobStoreId || "").trim(),
    fileName,
    mimeType: String(ref.mimeType || "").trim(),
    hasInlineData: Boolean(ref.dataUrl || ref.imageUrl || ref.mediaUrl || ref.imageBytes)
  };
}

function compactOutputForDebug(output = {}) {
  if (!output || typeof output !== "object") return null;
  const mediaId = String(output.mediaId || "").trim();
  const mediaGenerationId = String(output.mediaGenerationId || output.upscaleSourceId || "").trim();
  if (!mediaId && !mediaGenerationId) return null;
  return {
    mediaId,
    mediaGenerationId,
    status: String(output.status || output.rawStatus || "").trim(),
    downloadStatus: String(output.downloadStatus || "").trim(),
    fileName: String(output.fileName || output.filename || "").trim(),
    source: String(output.source || "").trim()
  };
}

export function sanitizeTaskForDebugReport(task = {}) {
  const events = Array.isArray(task.events) ? task.events.slice(-25) : [];
  return sanitizeEventValue({
    id: task.id || "",
    jobId: task.jobId || "",
    jobIndex: Number.isFinite(Number(task.jobIndex)) ? Number(task.jobIndex) : null,
    jobPromptCount: Number(task.jobPromptCount || 0),
    status: task.status || "",
    mode: task.mode || "",
    prompt: task.prompt || "",
    sourcePrompt: task.sourcePrompt || "",
    imagePrompt: task.imagePrompt || "",
    videoPrompt: task.videoPrompt || "",
    sceneTag: task.sceneTag || "",
    projectId: task.projectId || "",
    model: task.model || "",
    aspectRatio: task.aspectRatio || "",
    repeatCount: Number(task.repeatCount || 1),
    videoLength: String(task.videoLength || task.videoDurationSeconds || ""),
    submitPath: task.submitPath || task.submitPathPreference || "",
    attempts: Number(task.attempts || 0),
    failureClass: task.failureClass || "",
    failureScope: task.failureScope || "",
    healAction: task.healAction || "",
    lastError: task.lastError || "",
    expectedImages: Number(task.expectedImages || 0),
    foundImages: Number(task.foundImages || 0),
    expectedVideos: Number(task.expectedVideos || 0),
    foundVideos: Number(task.foundVideos || 0),
    generatedMediaIds: generatedMediaIdsFromTask(task),
    mediaIds: compactIdList(task.mediaIds || []),
    refMediaIds: compactIdList(task.refMediaIds || []),
    downloadedMediaIds: compactIdList(task.downloadedMediaIds || []),
    skippedDownloadMediaIds: compactIdList(task.skippedDownloadMediaIds || []),
    downloadErrorMediaIds: compactIdList(task.downloadErrorMediaIds || []),
    refInputs: (Array.isArray(task.refInputs) ? task.refInputs : []).map(compactRefForDebug).filter(Boolean),
    startRefInput: compactRefForDebug(task.startRefInput),
    endRefInput: compactRefForDebug(task.endRefInput),
    outputs: (Array.isArray(task.outputs) ? task.outputs : []).map(compactOutputForDebug).filter(Boolean),
    statusRows: Array.isArray(task.statusRows) ? task.statusRows.slice(-10).map((row) => sanitizeEventValue(row)) : [],
    events
  }, "", 0);
}

export function createTaskLedger(initialTasks = []) {
  const tasks = new Map();

  function normalizeTask(task = {}) {
    return {
      ...task,
      status: task.status || TaskStatus.pending,
      attempts: Number(task.attempts || 0),
      mediaIds: Array.isArray(task.mediaIds) ? [...task.mediaIds] : [],
      refMediaIds: Array.isArray(task.refMediaIds) ? [...task.refMediaIds] : [],
      refInputs: Array.isArray(task.refInputs) ? task.refInputs.map((ref) => ({ ...ref })) : [],
      startRefInput: task.startRefInput && typeof task.startRefInput === "object" ? { ...task.startRefInput } : null,
      endRefInput: task.endRefInput && typeof task.endRefInput === "object" ? { ...task.endRefInput } : null,
      events: Array.isArray(task.events) ? [...task.events] : []
    };
  }

  const api = {
    addTask(task) {
      const id = String(task?.id || "").trim();
      if (!id) throw new Error("Task id is required");
      if (tasks.has(id)) throw new Error(`Duplicate task id: ${id}`);
      tasks.set(id, normalizeTask(task));
      return tasks.get(id);
    },

    updateTask(id, patch) {
      const current = tasks.get(String(id));
      if (!current) throw new Error(`Unknown task id: ${id}`);
      const next = {
        ...current,
        ...patch,
        events: [
          ...current.events,
          {
            at: new Date().toISOString(),
            patch: sanitizeTaskEventPatch(patch)
          }
        ]
      };
      tasks.set(String(id), next);
      return next;
    },

    getTask(id) {
      return tasks.get(String(id)) || null;
    },

    listTasks() {
      return [...tasks.values()];
    },

    clearTasks() {
      tasks.clear();
    },

    pruneTasks(predicate) {
      if (typeof predicate !== "function") return 0;
      let removed = 0;
      for (const [id, task] of tasks.entries()) {
        if (!predicate(task)) continue;
        tasks.delete(id);
        removed += 1;
      }
      return removed;
    },

    replaceTasks(nextTasks = []) {
      tasks.clear();
      for (const task of nextTasks || []) {
        if (!task?.id) continue;
        tasks.set(String(task.id), normalizeTask(task));
      }
    },

    snapshot() {
      return [...tasks.values()].map((task) => ({
        ...task,
        mediaIds: Array.isArray(task.mediaIds) ? [...task.mediaIds] : [],
        refMediaIds: Array.isArray(task.refMediaIds) ? [...task.refMediaIds] : [],
        refInputs: Array.isArray(task.refInputs) ? task.refInputs.map((ref) => ({ ...ref })) : [],
        startRefInput: task.startRefInput && typeof task.startRefInput === "object" ? { ...task.startRefInput } : null,
        endRefInput: task.endRefInput && typeof task.endRefInput === "object" ? { ...task.endRefInput } : null,
        statusRows: Array.isArray(task.statusRows) ? [...task.statusRows] : [],
        events: Array.isArray(task.events) ? [...task.events] : []
      }));
    },

    debugSnapshot() {
      return [...tasks.values()].map((task) => sanitizeTaskForDebugReport(task));
    },

    hasOpenTasks() {
      return [...tasks.values()].some(
        (task) => ![TaskStatus.complete, TaskStatus.failed, TaskStatus.blocked].includes(task.status)
      );
    }
  };

  api.replaceTasks(initialTasks);
  return api;
}
