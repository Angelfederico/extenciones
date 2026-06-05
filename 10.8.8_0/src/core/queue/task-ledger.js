import { buildRecoveryReportFields } from "./recovery-policy.js";

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
const LEGACY_EMPTY_OMIT_KEYS = new Set(["rateLimitDomFallbackAt", "rateLimitDomFallbackFromTaskId"]);

function shouldOmitLegacyEmptyField(key = "", value) {
  if (!LEGACY_EMPTY_OMIT_KEYS.has(String(key))) return false;
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

function omitEmptyLegacyTaskFields(task = {}) {
  if (!task || typeof task !== "object") return task;
  const next = { ...task };
  for (const key of LEGACY_EMPTY_OMIT_KEYS) {
    if (shouldOmitLegacyEmptyField(key, next[key])) delete next[key];
  }
  return next;
}

function legacyRateLimitDomFallbackFields(task = {}) {
  return Object.fromEntries(
    [...LEGACY_EMPTY_OMIT_KEYS]
      .filter((key) => !shouldOmitLegacyEmptyField(key, task?.[key]))
      .map((key) => [key, task[key]])
  );
}

function sanitizeEventValue(value, key = "", depth = 0) {
  if (shouldOmitLegacyEmptyField(key, value)) return undefined;
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
    Object.entries(value)
      .filter(([entryKey, entryValue]) => !shouldOmitLegacyEmptyField(entryKey, entryValue))
      .map(([entryKey, entryValue]) => [entryKey, sanitizeEventValue(entryValue, entryKey, depth + 1)])
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
  const reportFields = buildRecoveryReportFields(task, { tasks: [task] });
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
    referenceChainMode: task.referenceChainMode || "",
    referenceChainSeed: task.referenceChainSeed === true,
    referenceChainIndex: Number.isFinite(Number(task.referenceChainIndex)) ? Number(task.referenceChainIndex) : null,
    continuitySourceTaskId: task.continuitySourceTaskId || "",
    continuitySourceMediaId: task.continuitySourceMediaId || "",
    projectId: task.projectId || "",
    model: task.model || "",
    aspectRatio: task.aspectRatio || "",
    repeatCount: Number(task.repeatCount || 1),
    videoLength: String(task.videoLength || task.videoDurationSeconds || ""),
    requestedVideoLength: String(task.requestedVideoLength || ""),
    sidepanelVideoLength: String(task.sidepanelVideoLength || ""),
    preflightDuration: String(task.preflightDuration || ""),
    buildJobsDuration: String(task.buildJobsDuration || ""),
    payloadDuration: String(task.payloadDuration || ""),
    durationFallbackReason: String(task.durationFallbackReason || ""),
    requestedMode: task.requestedMode || "",
    normalizedRuntimeMode: task.normalizedRuntimeMode || "",
    buildJobsMode: task.buildJobsMode || "",
    attachedFrameRefs: Array.isArray(task.attachedFrameRefs) ? sanitizeEventValue(task.attachedFrameRefs) : [],
    submitPath: task.submitPath || task.submitPathPreference || "",
    characterPreflight: task.characterPreflight ? sanitizeEventValue(task.characterPreflight) : null,
    nativeCharacterHandleMap: task.nativeCharacterHandleMap ? sanitizeEventValue(task.nativeCharacterHandleMap) : null,
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
    uploadedRefIds: compactIdList(task.uploadedRefIds || []),
    domFallbackAfterRefReupload: task.domFallbackAfterRefReupload === true,
    finalFallbackOutcome: task.finalFallbackOutcome || "",
    userActionRequiredReferenceFileName: task.userActionRequiredReferenceFileName || "",
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
    events,
    ...legacyRateLimitDomFallbackFields(task)
  }, "", 0);
}

export function createTaskLedger(initialTasks = []) {
  const tasks = new Map();

  function normalizeTask(task = {}) {
    const cleaned = omitEmptyLegacyTaskFields(task);
    return {
      ...cleaned,
      status: cleaned.status || TaskStatus.pending,
      attempts: Number(cleaned.attempts || 0),
      mediaIds: Array.isArray(cleaned.mediaIds) ? [...cleaned.mediaIds] : [],
      refMediaIds: Array.isArray(cleaned.refMediaIds) ? [...cleaned.refMediaIds] : [],
      refInputs: Array.isArray(cleaned.refInputs) ? cleaned.refInputs.map((ref) => ({ ...ref })) : [],
      startRefInput: cleaned.startRefInput && typeof cleaned.startRefInput === "object" ? { ...cleaned.startRefInput } : null,
      endRefInput: cleaned.endRefInput && typeof cleaned.endRefInput === "object" ? { ...cleaned.endRefInput } : null,
      events: Array.isArray(cleaned.events) ? cleaned.events.map((event) => sanitizeEventValue(event)) : []
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
      const next = omitEmptyLegacyTaskFields({
        ...current,
        ...patch,
        events: [
          ...current.events,
          {
            at: new Date().toISOString(),
            patch: sanitizeTaskEventPatch(patch)
          }
        ]
      });
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
      return [...tasks.values()].map((task) => omitEmptyLegacyTaskFields({
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
