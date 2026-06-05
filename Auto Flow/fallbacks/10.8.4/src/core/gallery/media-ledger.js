import {
  buildMediaRedirectUrl,
  buildMediaThumbnailUrl,
  normalizeMediaRedirectUrl,
  normalizeMediaThumbnailUrl
} from "../contracts/api.js";

const VIDEO_MODES = new Set([
  "text-to-video",
  "image-to-video",
  "start-end-image-to-video",
  "ingredients-to-video"
]);

const IMAGE_MODES = new Set(["text-to-image"]);

export function mediaKindForTaskMode(mode = "") {
  const normalized = String(mode || "").trim();
  if (IMAGE_MODES.has(normalized)) return "images";
  if (VIDEO_MODES.has(normalized)) return "videos";
  return "extended";
}

export function expectedOutputCount(task = {}) {
  return Math.max(
    1,
    Number.parseInt(
      task.expectedCount || task.expectedImages || task.expectedVideos || task.repeatCount || 1,
      10
    ) || 1
  );
}

export function slugWords(text = "", wordCount = 3) {
  const words = String(text || "")
    .toLowerCase()
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, Math.max(1, wordCount));
  return words.length ? words.join("-") : "media";
}
// Extract a leading [V99-S5]-style scene tag from a prompt. Returns the
// bracketed form (e.g., "[V99-S5]") so the animate-prompts matcher (which
// requires brackets) can find it later when the file is re-imported.
// Legacy parity: legacy preserved the scene tag in download filenames so
// that downstream Animate Images flows could re-pair files to their
// original prompts. The rebuild's slugWords used to strip the tag — this
// helper exists so callers can opt back in.
export function extractFilenameSceneTag(text = "") {
  const match = String(text || "").match(/^\s*(\[[A-Z0-9]+-[A-Z0-9]+\])/i);
  return match ? match[1].toUpperCase() : "";
}

// Slug a prompt while PRESERVING the leading scene tag if present. Used
// inside filenames so a downloaded "[V99-S5]_grey-cat.mp4" can later be
// matched back to its source prompt during Animate Images re-import.
export function slugWordsWithSceneTag(text = "", wordCount = 3) {
  const tag = extractFilenameSceneTag(text);
  const slug = slugWords(text, wordCount);
  return tag ? `${tag}_${slug}` : slug;
}


export function sanitizeFolderName(value = "Auto-Flow-01") {
  return String(value || "Auto-Flow-01")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "Auto-Flow-01";
}

function normalizeImageDownloadResolution(value = "1k") {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "2k" || normalized === "4k" ? normalized : "1k";
}

function normalizeVideoDownloadResolution(value = "720p") {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1080p" || normalized === "4k" ? normalized : "720p";
}

function downloadResolutionForItem(item = {}, options = {}) {
  const kind = String(item.kind || "");
  const byTask = options.resolutionByTaskId && typeof options.resolutionByTaskId === "object"
    ? options.resolutionByTaskId
    : {};
  const taskResolution = byTask[String(item.taskId || "")] || byTask[String(item.id || "")] || "";
  const itemResolution = item.downloadResolution || item.resolution || item.targetResolution || item.upscaleResolution || "";
  if (kind === "images") {
    return normalizeImageDownloadResolution(taskResolution || options.imageResolution || options.resolution || item.imageResolution || itemResolution || "1k");
  }
  if (kind === "videos") {
    return normalizeVideoDownloadResolution(taskResolution || options.videoResolution || options.resolution || item.videoResolution || itemResolution || "720p");
  }
  return "";
}

function extensionForKind(kind = "", resolution = "") {
  if (kind === "images") return normalizeImageDownloadResolution(resolution) === "1k" ? "jpg" : "png";
  return "mp4";
}

function requiresUpscaleDownload(item = {}, resolution = "") {
  if (String(item.kind || "") === "images") return normalizeImageDownloadResolution(resolution) !== "1k";
  if (String(item.kind || "") === "videos") return normalizeVideoDownloadResolution(resolution) !== "720p";
  return false;
}

function variationLetter(index) {
  const n = Number(index || 0);
  if (n >= 0 && n < 26) return String.fromCharCode(65 + n);
  return String(n + 1);
}

function sourceRank(item = {}) {
  if (String(item.source || "") === "queue-ledger") return 0;
  if (item.taskId) return 1;
  if (String(item.source || "") === "flow-project") return 5;
  if (String(item.matchMethod || "") === "project_initial_data") return 5;
  if (String(item.source || "") === "flow-dom") return 10;
  return 20;
}

function itemDedupeKey(item = {}) {
  const kind = String(item.kind || "");
  const mediaId = String(item.mediaId || "").trim();
  if (mediaId) return `${kind}:media:${mediaId}`;
  return `${kind}:url:${String(item.mediaUrl || item.thumbnailUrl || item.id || "").trim()}`;
}

const FLOW_PLACEHOLDER_TEXT_RE = /\b(start creating|drop media|what do you want to create|create or drop|upload an image|add media)\b/i;
const FLOW_PLACEHOLDER_URL_RE = /(^data:)|empty-state|placeholder|illustration|default-image/i;

function mediaIdFromRedirectUrl(value = "") {
  try {
    const parsed = new URL(String(value || ""));
    return compactMediaId(parsed.searchParams.get("name") || parsed.searchParams.get("mediaId") || "");
  } catch {
    return "";
  }
}

function galleryItemMediaIds(item = {}) {
  return uniqueIds([
    item.mediaId,
    item.name,
    item.mediaName,
    item.assetImageId,
    mediaIdFromRedirectUrl(item.mediaUrl)
  ]);
}

export function referenceMediaIdsFromTasks(tasks = []) {
  return uniqueIds((tasks || []).flatMap((task) => [...taskReferenceIds(task)]));
}

export function isReferenceGalleryItem(item = {}, options = {}) {
  if (!item || typeof item !== "object") return false;
  if (item.hiddenFromGallery === true || item.referenceOnly === true || item.isReference === true || item.inputAsset === true || item.isInputAsset === true) return true;
  const source = String(item.source || "");
  if (source === "reference-upload" || source === "reference-library" || source === "input-asset") return true;
  const referenceIds = new Set(uniqueIds(options.referenceMediaIds || []));
  if (!referenceIds.size) return false;
  return galleryItemMediaIds(item).some((id) => referenceIds.has(id));
}

export function isUsableGalleryItem(item = {}, options = {}) {
  if (!item?.mediaId && !item?.mediaUrl) return false;
  if (isReferenceGalleryItem(item, options)) return false;
  if (String(item.kind || "") === "videos" && !item?.mediaId) return false;
  const status = String(item.status || item.rawStatus || "").toLowerCase();
  if (/\bfailed\b|failure|policy|violate/.test(status)) return false;
  const promptText = `${item.prompt || ""} ${item.title || ""}`.trim();
  if (FLOW_PLACEHOLDER_TEXT_RE.test(promptText)) return false;
  const mediaUrl = String(item.mediaUrl || "");
  const thumbnailUrl = String(item.thumbnailUrl || "");
  if (String(item.source || "") === "flow-dom" && FLOW_PLACEHOLDER_URL_RE.test(`${mediaUrl} ${thumbnailUrl}`)) return false;
  return true;
}

export function filterUsableGalleryItems(items = [], options = {}) {
  return (items || []).filter((item) => isUsableGalleryItem(item, options));
}

function itemTaskNumber(item = {}, fallback = 1) {
  const explicit = Number.parseInt(item.taskNumber || item.jobIndex + 1, 10);
  return Number.isFinite(explicit) && explicit > 0 ? explicit : fallback;
}

function itemMediaIndex(item = {}) {
  const explicit = Number.parseInt(item.mediaIndex, 10);
  return Number.isFinite(explicit) && explicit >= 0 ? explicit : 0;
}

function hasExplicitMediaIndex(item = {}) {
  if (item.mediaIndex === undefined || item.mediaIndex === null || item.mediaIndex === "") return false;
  const explicit = Number.parseInt(item.mediaIndex, 10);
  return Number.isFinite(explicit) && explicit >= 0;
}

function preferGalleryItem(current = null, candidate = {}) {
  if (!current) return candidate;
  const currentRank = sourceRank(current);
  const candidateRank = sourceRank(candidate);
  if (candidateRank !== currentRank) return candidateRank < currentRank ? candidate : current;
  if (!current.taskId && candidate.taskId) return candidate;
  if (!current.prompt && candidate.prompt) return candidate;
  if (!current.mediaUrl && candidate.mediaUrl) return candidate;
  return current;
}

function normalizeGalleryItem(item = {}) {
  const mediaId = String(item.mediaId || "").trim();
  const kind = String(item.kind || "");
  const safeVideoMediaUrl = kind === "videos" && String(item.matchMethod || "") === "project_initial_data"
    ? ""
    : normalizeMediaRedirectUrl(item.mediaUrl || "", mediaId);
  return {
    ...item,
    mediaUrl: safeVideoMediaUrl,
    thumbnailUrl: kind === "videos"
      ? normalizeMediaThumbnailUrl(item.thumbnailUrl || "", mediaId)
      : normalizeMediaRedirectUrl(item.thumbnailUrl || "", mediaId)
  };
}

function normalizedProjectId(value = "") {
  return String(value || "").trim().toLowerCase();
}

function galleryItemProjectId(item = {}) {
  return normalizedProjectId(item.projectId || item.flowProjectId || item.project_id || "");
}

export function filterGalleryItemsForProject(items = [], projectId = "", options = {}) {
  const target = normalizedProjectId(projectId);
  const keepUnscoped = options.keepUnscoped === true;
  // No active project bound -> return nothing unless caller explicitly
  // opts in via keepUnscoped:true. Without this, stale items from prior
  // sessions (or queue items whose tabs have moved on) accumulate in
  // state.gallery.items and render as broken-thumbnail "Generated image"
  // placeholders when the sidepanel hasn't bound to a Flow project yet.
  // The user's mental model is "gallery shows things in the active
  // project" — fail closed when project context is missing.
  if (!target) return keepUnscoped ? (items || []) : [];
  return (items || []).filter((item) => {
    const itemProjectId = galleryItemProjectId(item);
    if (!itemProjectId) return keepUnscoped;
    return itemProjectId === target;
  });
}

export function canonicalGalleryItems(items = [], options = {}) {
  const selected = new Set((options.selectedIds || []).map((id) => String(id || "").trim()).filter(Boolean));
  const groups = new Map();
  // When the caller doesn't pass a projectId at all (e.g., test fixtures,
  // logic-layer helpers, programmatic dedup passes), default keepUnscoped
  // to true so the new fail-closed filter doesn't silently drop everything.
  // Callers that opt in to project scoping pass projectId AND can still
  // override keepUnscoped explicitly.
  const projectIdProvided = options.projectId !== undefined && options.projectId !== null;
  const keepUnscoped = options.keepUnscoped === true || (!projectIdProvided && options.keepUnscoped !== false);
  const scopedItems = filterGalleryItemsForProject(items, options.projectId, { keepUnscoped });
  for (const [index, item] of filterUsableGalleryItems(scopedItems, {
    referenceMediaIds: options.referenceMediaIds || []
  }).entries()) {
    if (!item?.mediaId && !item?.mediaUrl) continue;
    const key = itemDedupeKey(item);
    if (!key) continue;
    const selectedHit = selected.has(String(item.id || ""));
    const group = groups.get(key) || {
      item: null,
      selectedHit: false,
      firstIndex: index
    };
    group.item = preferGalleryItem(group.item, normalizeGalleryItem({
      ...item,
      _afOriginalIndex: item._afOriginalIndex ?? index
    }));
    group.selectedHit = group.selectedHit || selectedHit;
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter((group) => !selected.size || group.selectedHit)
    .map((group) => group.item)
    .sort((a, b) => {
      const taskDelta = itemTaskNumber(a, Number(a._afOriginalIndex || 0) + 1) - itemTaskNumber(b, Number(b._afOriginalIndex || 0) + 1);
      if (taskDelta) return taskDelta;
      const mediaDelta = itemMediaIndex(a) - itemMediaIndex(b);
      if (mediaDelta) return mediaDelta;
      return Number(a._afOriginalIndex || 0) - Number(b._afOriginalIndex || 0);
    })
    .map(({ _afOriginalIndex, ...item }) => item);
}

export function buildGalleryItemsFromTasks(tasks = []) {
  const items = [];
  for (const task of tasks || []) {
    if (task?.hiddenFromGallery === true || task?.generationRepair === true) continue;
    const kind = mediaKindForTaskMode(task.mode);
    const expected = expectedOutputCount(task);
    const activeStatus = ["submitting", "submitted", "generating"].includes(String(task.status || ""));
    const referenceMediaIds = taskReferenceIds(task);
    const failedIds = new Set(failedOutputIdsForTask(task));
    const outputIds = [...new Set([
      ...(Array.isArray(task?.outputs) ? task.outputs.map((output) => output?.mediaId) : []),
      ...(task?.outputMediaIds || [])
    ].map((id) => String(id || "").trim()).filter((id) => id && !failedIds.has(id) && !referenceMediaIds.has(id)))];
    const legacyTerminalIds = !activeStatus && !outputIds.length && !failedIds.size
      ? generatedMediaIdsForTask(task)
      : [];
    const mediaIds = activeStatus
      ? [...new Set([
        ...(task?.mediaIds || []),
        ...outputIds
      ].map((id) => String(id || "").trim()).filter((id) => id && !failedIds.has(id) && !referenceMediaIds.has(id)))]
      : (outputIds.length ? outputIds : legacyTerminalIds);
    const placeholderCount = activeStatus
      ? Math.max(expected, mediaIds.length)
      : mediaIds.length;
    if (!placeholderCount) continue;
    const referenceIds = taskReferenceInputIds(task);
    const outputByMediaId = new Map((task.outputs || [])
      .filter((output) => output?.mediaId)
      .map((output) => [String(output.mediaId), output]));
    for (let mediaIndex = 0; mediaIndex < placeholderCount; mediaIndex += 1) {
      const mediaId = mediaIds[mediaIndex] || "";
      const output = outputByMediaId.get(mediaId) || {};
      const stableMediaIndex = Number.isFinite(Number(output.mediaIndex)) ? Number(output.mediaIndex) : mediaIndex;
      const displayPrompt = String(kind === "images" ? (task.imagePrompt || task.prompt || "") : (task.prompt || ""));
      const item = {
        id: `${task.id}:${mediaId || `pending-${mediaIndex}`}`,
        taskId: String(task.id || ""),
        jobId: String(task.jobId || ""),
        projectId: String(task.projectId || ""),
        jobIndex: Number.isFinite(Number(task.jobIndex)) ? Number(task.jobIndex) : 0,
        taskNumber: Number.isFinite(Number(task.jobIndex)) ? Number(task.jobIndex) + 1 : 1,
        mediaId,
        kind,
        prompt: displayPrompt,
        sourcePrompt: String(task.sourcePrompt || ""),
        imagePrompt: String(task.imagePrompt || ""),
        videoPrompt: String(task.videoPrompt || ""),
        sceneTag: String(task.sceneTag || ""),
        title: `${displayPrompt || "Generated media"} ${variationLetter(stableMediaIndex)}`.slice(0, 96).trim(),
        status: String(task.status || ""),
        source: "queue-ledger",
        pendingOutput: !mediaId,
        mediaIndex: stableMediaIndex,
        referenceIds,
        fallbackThumbnailRefId: String(output.fallbackThumbnailRefId || referenceIds[0] || ""),
        filenameStyle: String(task.download?.filenameStyle || ""),
        filenameTemplatePrefix: String(task.download?.filenameTemplatePrefix || ""),
        filenameTemplateIndex: String(task.download?.filenameTemplateIndex || ""),
        filenameTemplatePromptPart: String(task.download?.filenameTemplatePromptPart || ""),
        filenameTemplateDate: String(task.download?.filenameTemplateDate || ""),
        filenameTemplateSuffix: String(task.download?.filenameTemplateSuffix || ""),
        filenameTemplateSeparator: String(task.download?.filenameTemplateSeparator || ""),
        mediaUrl: mediaId ? (normalizeMediaRedirectUrl(output.mediaUrl || "", mediaId) || buildMediaRedirectUrl({ mediaId })) : "",
        thumbnailUrl: mediaId
          ? (kind === "videos"
            ? normalizeMediaThumbnailUrl(output.thumbnailUrl || "", mediaId)
            : normalizeMediaRedirectUrl(output.thumbnailUrl || "", mediaId))
          : "",
        downloadedAt: output.downloadedAt || "",
        downloadFilename: output.downloadFilename || "",
        downloadId: output.downloadId || null,
        downloadStatus: output.downloadStatus || "",
        createdAt: task.completedAt || task.submittedAt || task.events?.at || ""
      };
      if (mediaId ? isUsableGalleryItem(item) : kind === "videos") items.push(item);
    }
  }
  return items;
}

function normalizedPrompt(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function taskReferenceIds(task = {}) {
  return new Set([
    ...(Array.isArray(task.refMediaIds) ? task.refMediaIds : []),
    task.startMediaId,
    task.endMediaId,
    ...(Array.isArray(task.refInputs) ? task.refInputs.map((ref) => ref?.mediaId || ref?.assetImageId) : []),
    task.startRefInput?.mediaId || task.startRefInput?.assetImageId,
    task.endRefInput?.mediaId || task.endRefInput?.assetImageId
  ].map((id) => String(id || "").trim()).filter(Boolean));
}

function taskReferenceInputIds(task = {}) {
  return [...new Set([
    ...(Array.isArray(task.refInputs) ? task.refInputs : []),
    task.startRefInput,
    task.endRefInput
  ]
    .map((ref) => String(ref?.id || "").trim())
    .filter(Boolean))];
}

function generatedMediaIdsForTask(task = {}) {
  const refs = taskReferenceIds(task);
  return [...new Set((task.mediaIds || [])
    .map((id) => String(id || "").trim())
    .filter((id) => id && !refs.has(id)))];
}

function submitOwnedMediaIdsForTask(task = {}) {
  const refs = taskReferenceIds(task);
  return [...new Set([
    ...(Array.isArray(task.submitOutputRows) ? task.submitOutputRows.map((row) => row?.mediaId) : []),
    ...(Array.isArray(task.mediaIds) ? task.mediaIds : [])
  ].map((id) => String(id || "").trim()).filter((id) => id && !refs.has(id)))];
}

function successfulStatusRowMediaIds(task = {}) {
  return [...new Set((Array.isArray(task.statusRows) ? task.statusRows : [])
    .filter((row) => {
      const status = String(row?.status || "").toLowerCase();
      const rawStatus = String(row?.rawStatus || "").toUpperCase();
      return status === "complete" || rawStatus === "MEDIA_GENERATION_STATUS_SUCCESSFUL";
    })
    .map((row) => String(row?.id || row?.mediaId || "").trim())
    .filter(Boolean))];
}

function taskOwnedVideoMediaIds(task = {}) {
  return [...new Set([
    ...successfulStatusRowMediaIds(task),
    ...(Array.isArray(task.outputMediaIds) ? task.outputMediaIds : [])
  ].map((id) => String(id || "").trim()).filter(Boolean))];
}

function taskClaimedMediaIds(task = {}) {
  return new Set([
    ...(Array.isArray(task.submitOutputRows) ? task.submitOutputRows.flatMap((row) => [row?.mediaId, row?.id, row?.workflowId, row?.mediaGenerationId]) : []),
    ...(Array.isArray(task.statusRows) ? task.statusRows.flatMap((row) => [row?.id, row?.mediaId, row?.workflowId, row?.mediaGenerationId]) : []),
    ...(Array.isArray(task.outputMediaIds) ? task.outputMediaIds : []),
    ...(Array.isArray(task.mediaIds) ? task.mediaIds : []),
    ...(Array.isArray(task.outputs) ? task.outputs.flatMap((output) => [output?.mediaId, output?.workflowId, output?.mediaGenerationId]) : [])
  ].map((id) => String(id || "").trim()).filter(Boolean));
}

function mediaIdClaimedByOtherTask(tasks = [], currentTask = {}, mediaId = "") {
  const target = String(mediaId || "").trim();
  if (!target) return false;
  return (tasks || []).some((task) => {
    if (!task?.id || String(task.id) === String(currentTask.id || "")) return false;
    return taskClaimedMediaIds(task).has(target);
  });
}

function itemMatchesTask(item = {}, task = {}) {
  const itemKind = String(item.kind || "");
  if (itemKind !== mediaKindForTaskMode(task.mode)) return false;
  if (item.taskId && String(item.taskId) === String(task.id || "")) return true;

  const mediaId = String(item.mediaId || "").trim();
  if (mediaId && submitOwnedMediaIdsForTask(task).includes(mediaId)) return true;

  const taskPrompt = normalizedPrompt(task.prompt);
  const itemPrompt = normalizedPrompt(item.prompt || item.title);
  if (!taskPrompt || !itemPrompt) return false;
  if (taskPrompt === itemPrompt && itemCreatedInsideTaskWindow(item, task)) return true;
  if (taskPrompt.length < 8) return false;
  return itemPrompt.includes(taskPrompt) || taskPrompt.includes(itemPrompt);
}

function itemCreatedInsideTaskWindow(item = {}, task = {}) {
  const itemMs = Date.parse(String(item.createdAt || ""));
  if (!Number.isFinite(itemMs)) return true;
  const hasSubmitAttemptOnly = !task.submittedAt && Boolean(task.submitAttemptStartedAt);
  const submittedMs = Date.parse(String(task.submittedAt || task.submitAttemptStartedAt || task.startedAt || ""));
  if (!Number.isFinite(submittedMs)) return true;
  const completedMs = Date.parse(String(task.completedAt || ""));
  const startMs = submittedMs - (hasSubmitAttemptOnly ? 15000 : 120000);
  const endMs = Number.isFinite(completedMs) ? completedMs + 120000 : Date.now() + 120000;
  return itemMs >= startMs && itemMs <= endMs;
}

function outputSignature(outputs = []) {
  return JSON.stringify((outputs || []).map((output) => ({
    mediaId: String(output.mediaId || ""),
    mediaUrl: String(output.mediaUrl || ""),
    thumbnailUrl: String(output.thumbnailUrl || ""),
    mediaIndex: Number(output.mediaIndex || 0),
    downloadStatus: String(output.downloadStatus || ""),
    downloadFilename: String(output.downloadFilename || "")
  })));
}

function idSignature(ids = []) {
  return JSON.stringify((ids || []).map((id) => String(id || "").trim()).filter(Boolean));
}

function compactMediaId(value = "") {
  return String(value || "").trim();
}

function uniqueIds(values = []) {
  return [...new Set((values || []).map(compactMediaId).filter(Boolean))];
}

function successfulOutputIdsForTask(task = {}) {
  const failedIds = new Set(failedOutputIdsForTask(task));
  return uniqueIds([
    ...(Array.isArray(task.outputs)
      ? task.outputs
        .filter((output) => {
          const status = String(output?.status || "").toLowerCase();
          return !status || status === "complete" || status === "downloaded";
        })
        .map((output) => output?.mediaId)
      : []),
    ...(Array.isArray(task.statusRows)
      ? task.statusRows
        .filter((row) => String(row?.status || "").toLowerCase() === "complete")
        .map((row) => row?.id || row?.mediaId)
      : []),
    ...(Array.isArray(task.outputMediaIds) ? task.outputMediaIds : [])
  ]).filter((id) => !failedIds.has(id));
}

function failedOutputIdsForTask(task = {}) {
  return uniqueIds([
    ...(Array.isArray(task.statusRows)
      ? task.statusRows
        .filter((row) => String(row?.status || "").toLowerCase() === "failed")
        .map((row) => row?.id || row?.mediaId || row?.workflowId)
      : []),
    ...(Array.isArray(task.failedOutputMediaIds) ? task.failedOutputMediaIds : [])
  ]);
}

export function deriveTaskOutputLedger(task = {}) {
  const kind = mediaKindForTaskMode(task.mode);
  const expectedCount = expectedOutputCount(task);
  const successfulIds = successfulOutputIdsForTask(task).slice(0, expectedCount);
  const failedIds = failedOutputIdsForTask(task);
  const downloadedIds = uniqueIds(task.downloadedMediaIds || []);
  const skippedDownloadIds = uniqueIds(task.skippedDownloadMediaIds || []);
  const downloadErrorIds = uniqueIds(task.downloadErrorMediaIds || []);
  const readyVideoIds = uniqueIds(task.videoDownloadReadyMediaIds || []);
  const terminalCount = Math.min(expectedCount, successfulIds.length + failedIds.length);
  const missingCount = Math.max(0, expectedCount - terminalCount);
  const expectedDownloadCount = successfulIds.length;
  const savedCount = successfulIds.filter((id) => downloadedIds.includes(id) || skippedDownloadIds.includes(id)).length;
  const pendingDownloadIds = successfulIds.filter((id) => {
    if (downloadedIds.includes(id) || skippedDownloadIds.includes(id) || downloadErrorIds.includes(id)) return false;
    if (kind !== "videos") return true;
    return readyVideoIds.includes(id);
  });
  return {
    kind,
    expectedCount,
    successfulIds,
    failedIds,
    downloadedIds,
    skippedDownloadIds,
    downloadErrorIds,
    readyVideoIds,
    resultCount: successfulIds.length,
    terminalCount,
    missingCount,
    expectedDownloadCount,
    savedCount,
    pendingDownloadIds,
    hasDownloadErrors: downloadErrorIds.length > 0 || (Array.isArray(task.outputs) ? task.outputs : []).some((output) => output?.downloadError || String(output?.downloadStatus || "").toLowerCase() === "download_failed"),
    isTerminal: ["complete", "done", "failed", "blocked"].includes(String(task.status || "").toLowerCase()) || terminalCount >= expectedCount
  };
}

function partialVideoSettleMs(task = {}, options = {}) {
  return Math.max(90000, Math.min(240000, Number(options.minPartialSettleMs ?? task.videoPartialSettleMs ?? 120000) || 120000));
}

function submittedAtForTask(task = {}) {
  const direct = String(task.submittedAt || "").trim();
  if (Number.isFinite(Date.parse(direct))) return direct;
  const events = Array.isArray(task.events) ? task.events : [];
  for (const event of events) {
    const fromPatch = String(event?.patch?.submittedAt || "").trim();
    if (Number.isFinite(Date.parse(fromPatch))) return fromPatch;
  }
  return "";
}

function outputRowsForSuccessfulIds(task = {}, successfulIds = []) {
  const existingById = new Map((Array.isArray(task.outputs) ? task.outputs : [])
    .filter((output) => output?.mediaId)
    .map((output) => [String(output.mediaId || "").trim(), output]));
  const statusRowById = new Map((Array.isArray(task.statusRows) ? task.statusRows : [])
    .filter((row) => row?.id || row?.mediaId)
    .map((row) => [String(row.id || row.mediaId || "").trim(), row]));
  const kind = mediaKindForTaskMode(task.mode);
  return successfulIds.map((mediaId, mediaIndex) => {
    const existing = existingById.get(mediaId) || {};
    const statusRow = statusRowById.get(mediaId) || {};
    return {
      ...existing,
      id: existing.id || `${task.id}:${mediaId}`,
      mediaId,
      mediaUrl: normalizeMediaRedirectUrl(existing.mediaUrl || statusRow.mediaUrl || "", mediaId) || buildMediaRedirectUrl({ mediaId }),
      thumbnailUrl: kind === "videos"
        ? normalizeMediaThumbnailUrl(existing.thumbnailUrl || statusRow.thumbnailUrl || "", mediaId)
        : normalizeMediaRedirectUrl(existing.thumbnailUrl || statusRow.thumbnailUrl || "", mediaId),
      prompt: existing.prompt || task.prompt || "",
      kind,
      status: "complete",
      rawStatus: existing.rawStatus || statusRow.rawStatus || "",
      mediaIndex: Number.isFinite(Number(existing.mediaIndex)) ? Number(existing.mediaIndex) : mediaIndex,
      source: existing.source || "partial_timeout"
    };
  });
}

export function buildPartialVideoCompletionPatch(task = {}, now = new Date().toISOString(), options = {}) {
  if (!task?.id || mediaKindForTaskMode(task.mode) !== "videos") return null;
  if (String(task.status || "").toLowerCase() !== "generating") return null;
  const expected = expectedOutputCount(task);
  const successfulIds = successfulOutputIdsForTask(task).slice(0, expected);
  if (!successfulIds.length || successfulIds.length >= expected) return null;
  const submittedMs = Date.parse(submittedAtForTask(task));
  const nowMs = Date.parse(String(now || ""));
  if ((!Number.isFinite(submittedMs) || !Number.isFinite(nowMs)) && options.force !== true) return null;
  const ageMs = Number.isFinite(submittedMs) && Number.isFinite(nowMs)
    ? nowMs - submittedMs
    : 0;
  const minPartialSettleMs = partialVideoSettleMs(task, options);
  if (ageMs > 0 && ageMs < minPartialSettleMs && options.force !== true) {
    return null;
  }
  const outputs = outputRowsForSuccessfulIds(task, successfulIds);
  const foundVideos = outputs.length;
  const failedIds = failedOutputIdsForTask(task);
  return {
    status: "complete",
    completedAt: now,
    outputs,
    outputMediaIds: outputs.map((output) => output.mediaId),
    mediaIds: uniqueIds([...(Array.isArray(task.mediaIds) ? task.mediaIds : []), ...outputs.map((output) => output.mediaId)]),
    foundVideos,
    expectedVideos: expected,
    failedVideos: Math.max(0, expected - foundVideos),
    failedOutputCount: Math.max(0, expected - foundVideos),
    failedOutputMediaIds: failedIds,
    missingOutputCount: Math.max(0, expected - foundVideos),
    partialFailure: true,
    lastError: `PARTIAL_VIDEO_OUTPUTS:${foundVideos}/${expected}`,
    failureClass: "partial_video_outputs",
    failureScope: "task",
    healAction: "",
    videoPartialTimedOutAt: now,
    videoPartialSettleMs: minPartialSettleMs
  };
}

export function reconcileTasksWithGalleryItems(tasks = [], galleryItems = [], now = new Date().toISOString()) {
  const patches = [];
  const referenceMediaIds = referenceMediaIdsFromTasks(tasks);
  for (const task of tasks || []) {
    if (!task?.id || ["failed", "blocked"].includes(task.status)) continue;
    const kind = mediaKindForTaskMode(task.mode);
    if (!["images", "videos"].includes(kind)) continue;

    const expected = expectedOutputCount(task);
    const existingGeneratedIds = generatedMediaIdsForTask(task);
    const submitOwnedIds = submitOwnedMediaIdsForTask(task);
    const ownedVideoIds = kind === "videos" ? taskOwnedVideoMediaIds(task).slice(0, expected) : [];
    const ownedVideoIdSet = new Set(ownedVideoIds);
    const allowVideoSupplementalMatches = kind === "videos"
      && ownedVideoIdSet.size > 0
      && ownedVideoIdSet.size < expected
      && ["generating", "submitted", "submitting"].includes(String(task.status || "").toLowerCase());
    const matchedCandidates = filterUsableGalleryItems(galleryItems, { referenceMediaIds })
      .filter((item) => itemMatchesTask(item, task))
      .filter((item) => {
        const itemMediaId = String(item.mediaId || "").trim();
        if (kind === "videos" && submitOwnedIds.length) {
          if (submitOwnedIds.includes(itemMediaId)) return true;
          return allowVideoSupplementalMatches
            && itemMediaId
            && !mediaIdClaimedByOtherTask(tasks, task, itemMediaId)
            && itemCreatedInsideTaskWindow(item, task);
        }
        if (!ownedVideoIdSet.size || allowVideoSupplementalMatches) return true;
        return ownedVideoIdSet.has(itemMediaId);
      });
    const matchedItems = canonicalGalleryItems(matchedCandidates, {
      projectId: task.projectId,
      keepUnscoped: true,
      referenceMediaIds
    }).slice(0, expected);
    const matchedIds = matchedItems
      .map((item) => String(item.mediaId || "").trim())
      .filter(Boolean);
    const allowReturnedIdSynthesis = kind === "images";
    const outputMediaIds = (ownedVideoIds.length
      ? [...new Set([...ownedVideoIds, ...matchedIds])]
      : (matchedIds.length ? [...new Set(matchedIds)] : (kind === "images" ? existingGeneratedIds : []))).slice(0, expected);
    const synthesizedFromReturnedIds = allowReturnedIdSynthesis && !matchedItems.length && existingGeneratedIds.length >= expected;
    const foundCount = ownedVideoIds.length
      ? outputMediaIds.length
      : (synthesizedFromReturnedIds ? outputMediaIds.length : matchedItems.length);
    const foundField = kind === "images" ? "foundImages" : "foundVideos";
    const expectedField = kind === "images" ? "expectedImages" : "expectedVideos";
    const priorOutputsByMediaId = new Map((task.outputs || [])
      .filter((output) => output?.mediaId)
      .map((output) => [String(output.mediaId), output]));
    const referenceIds = taskReferenceInputIds(task);
    const matchedItemByMediaId = new Map(matchedItems.map((item) => [String(item.mediaId || ""), item]));
    const sourceOutputs = ownedVideoIds.length
      ? outputMediaIds.map((mediaId) => matchedItemByMediaId.get(mediaId) || {
        id: `${task.id}:${mediaId}`,
        mediaId,
        mediaUrl: buildMediaRedirectUrl({ mediaId }),
        thumbnailUrl: kind === "videos" ? buildMediaThumbnailUrl({ mediaId }) : "",
        prompt: task.prompt || "",
        kind,
        source: "queue-ledger"
      })
      : matchedItems.length
      ? matchedItems
      : outputMediaIds.map((mediaId) => ({
        id: `${task.id}:${mediaId}`,
        mediaId,
        mediaUrl: buildMediaRedirectUrl({ mediaId }),
        thumbnailUrl: kind === "videos" ? buildMediaThumbnailUrl({ mediaId }) : "",
        prompt: task.prompt || "",
        kind,
        source: "queue-ledger"
      }));
    const outputs = sourceOutputs.map((item, mediaIndex) => {
      const mediaId = String(item.mediaId || "");
      const prior = priorOutputsByMediaId.get(mediaId) || {};
      return {
        ...prior,
        id: item.id || prior.id || `${task.id}:${mediaId || mediaIndex}`,
        mediaId,
        mediaUrl: normalizeMediaRedirectUrl(item.mediaUrl || prior.mediaUrl || "", mediaId) || (mediaId ? buildMediaRedirectUrl({ mediaId }) : ""),
        thumbnailUrl: kind === "videos"
          ? normalizeMediaThumbnailUrl(item.thumbnailUrl || prior.thumbnailUrl || "", mediaId)
          : normalizeMediaRedirectUrl(item.thumbnailUrl || prior.thumbnailUrl || "", mediaId),
        referenceIds: Array.isArray(prior.referenceIds) && prior.referenceIds.length ? prior.referenceIds : referenceIds,
        fallbackThumbnailRefId: String(prior.fallbackThumbnailRefId || referenceIds[0] || ""),
        prompt: item.prompt || prior.prompt || task.prompt || "",
        kind,
        mediaIndex: Number.isFinite(Number(prior.mediaIndex)) ? Number(prior.mediaIndex) : mediaIndex
      };
    });

    const patch = {
      [foundField]: foundCount,
      [expectedField]: expected,
      outputs,
      outputMediaIds,
      mediaIds: outputMediaIds.length ? outputMediaIds : existingGeneratedIds
    };

    if (foundCount >= expected) {
      patch.status = "complete";
      patch.completedAt = task.completedAt || now;
      patch.lastError = "";
      patch.failureClass = "";
      patch.healAction = "";
    } else if (task.mode === "text-to-image" && ["complete", "done"].includes(task.status)) {
      patch.status = "generating";
      patch.completedAt = "";
    }

    const nextStatus = patch.status || task.status || "";
    const materialChanged =
      Number(task[foundField] || 0) !== foundCount ||
      Number(task[expectedField] || 0) !== expected ||
      idSignature(task.outputMediaIds || []) !== idSignature(outputMediaIds) ||
      outputSignature(task.outputs || []) !== outputSignature(outputs) ||
      String(task.status || "") !== String(nextStatus) ||
      (patch.completedAt && String(task.completedAt || "") !== String(patch.completedAt));
    if (!materialChanged) continue;

    patch.lastGalleryReconcileAt = now;
    patches.push({
      taskId: task.id,
      patch,
      matchedCount: foundCount,
      expectedCount: expected
    });
  }
  return patches;
}

function feedRowMatchesTask(row = {}, task = {}) {
  const rowKind = String(row.kind || "");
  if (rowKind !== mediaKindForTaskMode(task.mode)) return false;
  const rowProjectId = galleryItemProjectId(row);
  const taskProjectId = normalizedProjectId(task.projectId || "");
  if (rowProjectId && taskProjectId && rowProjectId !== taskProjectId) return false;
  if (feedRowDirectlyMatchesTask(row, task)) return true;
  return feedRowPromptMatchesTask(row, task);
}

function feedRowIdentityValues(row = {}) {
  return uniqueIds([
    row.mediaId,
    row.id,
    row.workflowId,
    row.mediaGenerationId
  ]);
}

function feedRowClaimKey(row = {}) {
  return feedRowIdentityValues(row)[0] || "";
}

function feedRowDirectlyMatchesTask(row = {}, task = {}) {
  const claimed = taskClaimedMediaIds(task);
  if (!claimed.size) return false;
  return feedRowIdentityValues(row).some((id) => claimed.has(id));
}

function feedRowDirectlyClaimedByOtherTask(tasks = [], currentTask = {}, row = {}) {
  return (tasks || []).some((task) => {
    if (!task?.id || String(task.id) === String(currentTask.id || "")) return false;
    return feedRowDirectlyMatchesTask(row, task);
  });
}

function normalizedFeedRowStatus(row = {}) {
  const status = String(row?.status || "").toLowerCase();
  if (status && status !== "unknown") return status;
  if (
    String(row?.kind || "") === "images" &&
    (row?.mediaUrl || row?.thumbnailUrl || row?.mediaGenerationId)
  ) {
    return "complete";
  }
  return status || "unknown";
}

function feedRowPromptMatchesTask(row = {}, task = {}) {
  const rowProjectId = galleryItemProjectId(row);
  const taskProjectId = normalizedProjectId(task.projectId || "");
  if (rowProjectId && taskProjectId && rowProjectId !== taskProjectId) return false;
  const rowPrompt = normalizedPrompt(row.prompt || row.title);
  const taskPrompt = normalizedPrompt(task.prompt);
  if (!rowPrompt || !taskPrompt) return false;
  if (!itemCreatedInsideTaskWindow({ createdAt: row.createdAt }, task)) return false;
  return rowPrompt === taskPrompt || (taskPrompt.length >= 8 && (rowPrompt.includes(taskPrompt) || taskPrompt.includes(rowPrompt)));
}

export function reconcileTasksWithProjectMediaFeed(tasks = [], feedRows = [], now = new Date().toISOString()) {
  const patches = [];
  const claimedRowKeys = new Set();
  const referenceMediaIds = new Set(referenceMediaIdsFromTasks(tasks));
  const usableRows = (feedRows || [])
    .map((row) => ({
      ...row,
      mediaId: compactMediaId(row?.mediaId || row?.id),
      id: compactMediaId(row?.id || row?.mediaId),
      kind: String(row?.kind || ""),
      status: normalizedFeedRowStatus(row),
      rawStatus: String(row?.rawStatus || "")
    }))
    .filter((row) => row.mediaId && ["images", "videos"].includes(row.kind) && !referenceMediaIds.has(row.mediaId));

  for (const task of tasks || []) {
    if (!task?.id || ["failed", "blocked"].includes(String(task.status || "").toLowerCase())) continue;
    const kind = mediaKindForTaskMode(task.mode);
    if (!["images", "videos"].includes(kind)) continue;
    const expected = expectedOutputCount(task);
    const directRows = usableRows
      .filter((row) => row.kind === kind && feedRowMatchesTask(row, task) && feedRowDirectlyMatchesTask(row, task));
    const fallbackRows = usableRows
      .filter((row) => {
        if (row.kind !== kind) return false;
        const key = feedRowClaimKey(row);
        if (key && claimedRowKeys.has(key)) return false;
        if (feedRowDirectlyMatchesTask(row, task)) return false;
        if (feedRowDirectlyClaimedByOtherTask(tasks, task, row)) return false;
        return feedRowPromptMatchesTask(row, task);
      });
    const matchedRows = [...directRows, ...fallbackRows]
      .filter((row, index, all) => {
        const key = feedRowClaimKey(row);
        return !key || all.findIndex((candidate) => feedRowClaimKey(candidate) === key) === index;
      })
      .sort((a, b) => {
        const ai = Number.isFinite(Number(a.mediaIndex)) ? Number(a.mediaIndex) : 999;
        const bi = Number.isFinite(Number(b.mediaIndex)) ? Number(b.mediaIndex) : 999;
        if (ai !== bi) return ai - bi;
        return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
      })
      .slice(0, expected);
    if (!matchedRows.length) continue;

    for (const row of matchedRows) {
      const key = feedRowClaimKey(row);
      if (key) claimedRowKeys.add(key);
    }

    const completeRows = matchedRows.filter((row) => row.status === "complete");
    const failedRows = matchedRows.filter((row) => row.status === "failed");
    const outputRows = completeRows.map((row, mediaIndex) => {
      const prior = (task.outputs || []).find((output) => String(output?.mediaId || "") === row.mediaId) || {};
      return {
        ...prior,
        id: prior.id || `${task.id}:${row.mediaId}`,
        mediaId: row.mediaId,
        mediaGenerationId: row.mediaGenerationId || prior.mediaGenerationId || "",
        workflowId: row.workflowId || prior.workflowId || "",
        mediaUrl: normalizeMediaRedirectUrl(row.mediaUrl || prior.mediaUrl || "", row.mediaId) || (kind === "videos" ? "" : buildMediaRedirectUrl({ mediaId: row.mediaId })),
        thumbnailUrl: kind === "videos"
          ? normalizeMediaThumbnailUrl(row.thumbnailUrl || prior.thumbnailUrl || "", row.mediaId)
          : normalizeMediaRedirectUrl(row.thumbnailUrl || prior.thumbnailUrl || "", row.mediaId),
        prompt: row.prompt || prior.prompt || task.prompt || "",
        kind,
        status: "complete",
        rawStatus: row.rawStatus || prior.rawStatus || "",
        mediaIndex: Number.isFinite(Number(prior.mediaIndex)) ? Number(prior.mediaIndex) : mediaIndex,
        source: "project_initial_data"
      };
    });
    const outputMediaIds = uniqueIds(outputRows.map((output) => output.mediaId));
    const generatedIds = generatedMediaIdsForTask(task);
    const mediaIds = uniqueIds([
      ...(Array.isArray(task.mediaIds) ? task.mediaIds : []),
      ...outputMediaIds
    ]);
    const foundField = kind === "images" ? "foundImages" : "foundVideos";
    const expectedField = kind === "images" ? "expectedImages" : "expectedVideos";
    const failedField = kind === "images" ? "failedImages" : "failedVideos";
    const patch = {
      [foundField]: outputRows.length,
      [expectedField]: expected,
      [failedField]: failedRows.length,
      outputs: outputRows,
      outputMediaIds,
      mediaIds: outputMediaIds.length ? mediaIds : generatedIds,
      failedOutputCount: failedRows.length,
      failedOutputMediaIds: uniqueIds(failedRows.map((row) => row.mediaId || row.workflowId)),
      partialFailure: failedRows.length > 0 || (outputRows.length > 0 && outputRows.length < expected),
      flowProjectFeedAt: now
    };
    const terminalCount = Math.min(expected, outputRows.length + failedRows.length);
    if (outputRows.length >= expected) {
      patch.status = "complete";
      patch.completedAt = task.completedAt || now;
      patch.lastError = "";
      patch.failureClass = "";
      patch.healAction = "";
    } else if (terminalCount >= expected) {
      if (!outputRows.length) {
        const failureText = uniqueIds(failedRows.map((row) => row.failureText || row.failureReason || row.rawStatus || row.status)).join(" ");
        patch.status = "failed";
        patch.completedAt = "";
        patch.lastError = failureText || `FAILED_${kind === "videos" ? "VIDEO" : "IMAGE"}_OUTPUTS:${failedRows.length}/${expected}`;
        patch.failureClass = `failed_${kind === "videos" ? "video" : "image"}_outputs`;
        patch.healAction = "";
      } else {
        patch.status = "complete";
        patch.completedAt = task.completedAt || now;
        patch.lastError = `PARTIAL_${kind === "videos" ? "VIDEO" : "IMAGE"}_OUTPUTS:${outputRows.length}/${expected}`;
        patch.failureClass = `partial_${kind === "videos" ? "video" : "image"}_outputs`;
        patch.healAction = "";
      }
    }

    const nextStatus = patch.status || task.status || "";
    const materialChanged =
      Number(task[foundField] || 0) !== Number(patch[foundField] || 0) ||
      Number(task[expectedField] || 0) !== expected ||
      Number(task[failedField] || task.failedOutputCount || 0) !== failedRows.length ||
      idSignature(task.outputMediaIds || []) !== idSignature(outputMediaIds) ||
      outputSignature(task.outputs || []) !== outputSignature(outputRows) ||
      String(task.status || "") !== String(nextStatus) ||
      (patch.completedAt && String(task.completedAt || "") !== String(patch.completedAt));
    if (!materialChanged) continue;
    patches.push({
      taskId: task.id,
      patch,
      matchedCount: outputRows.length,
      failedCount: failedRows.length,
      expectedCount: expected
    });
  }
  return patches;
}

export function reconcileTasksWithDownloadResults(tasks = [], downloads = [], now = new Date().toISOString()) {
  const patches = [];
  const attempted = (downloads || []).filter((download) => download?.ok || download?.skipped || download?.error);
  for (const task of tasks || []) {
    if (!task?.id) continue;
    const relevant = attempted.filter((download) => {
      const taskId = String(download.taskId || "");
      if (taskId && taskId === String(task.id)) return true;
      const mediaId = String(download.mediaId || "").trim();
      return mediaId && (task.mediaIds || []).map((id) => String(id || "").trim()).includes(mediaId);
    });
    if (!relevant.length) continue;

    const byMediaId = new Map(relevant.map((download) => [String(download.mediaId || ""), download]));
    const priorOutputs = Array.isArray(task.outputs) ? task.outputs : [];
    const outputByMediaId = new Map(priorOutputs.map((output) => [String(output.mediaId || ""), { ...output }]));
    const kind = mediaKindForTaskMode(task.mode);
    const failedIds = new Set(failedOutputIdsForTask(task));
    const outputMediaIds = [...new Set([
      ...(Array.isArray(task.outputMediaIds) ? task.outputMediaIds : []),
      ...(kind === "images" ? generatedMediaIdsForTask(task) : []),
      ...relevant.map((download) => String(download.mediaId || "").trim()).filter(Boolean)
    ])].filter((id) => !failedIds.has(id));

    outputMediaIds.forEach((mediaId, mediaIndex) => {
      const current = outputByMediaId.get(mediaId) || {
        id: `${task.id}:${mediaId}`,
        mediaId,
        mediaUrl: buildMediaRedirectUrl({ mediaId }),
        thumbnailUrl: mediaKindForTaskMode(task.mode) === "videos" ? buildMediaThumbnailUrl({ mediaId }) : "",
        prompt: task.prompt || "",
        kind: mediaKindForTaskMode(task.mode),
        mediaIndex
      };
      const download = byMediaId.get(mediaId);
      if (download) {
        outputByMediaId.set(mediaId, {
          ...current,
          mediaIndex: Number.isFinite(Number(current.mediaIndex)) ? Number(current.mediaIndex) : mediaIndex,
          downloadedAt: download.ok ? now : current.downloadedAt || "",
          downloadFilename: download.filename || current.downloadFilename || "",
          downloadId: download.downloadId || current.downloadId || null,
          downloadStatus: download.ok ? "downloaded" : (download.skipped ? "duplicate_skipped" : "download_failed"),
          downloadError: download.error || ""
        });
      } else {
        outputByMediaId.set(mediaId, current);
      }
    });

    const outputs = outputMediaIds.map((mediaId, mediaIndex) => ({
      ...outputByMediaId.get(mediaId),
      mediaIndex: Number.isFinite(Number(outputByMediaId.get(mediaId)?.mediaIndex))
        ? Number(outputByMediaId.get(mediaId).mediaIndex)
        : mediaIndex
    }));
    const downloadedMediaIds = [...new Set([
      ...(Array.isArray(task.downloadedMediaIds) ? task.downloadedMediaIds : []),
      ...relevant.filter((download) => download.ok).map((download) => String(download.mediaId || "").trim()).filter(Boolean)
    ])];
    const skippedDownloadMediaIds = [...new Set([
      ...(Array.isArray(task.skippedDownloadMediaIds) ? task.skippedDownloadMediaIds : []),
      ...relevant.filter((download) => download.skipped).map((download) => String(download.mediaId || "").trim()).filter(Boolean)
    ])];

    const expectedCount = expectedOutputCount(task);
    const foundPatch = kind === "videos"
      ? { foundVideos: Math.min(expectedCount, Math.max(Number(task.foundVideos || 0) || 0, outputs.filter((output) => output?.mediaId).length, downloadedMediaIds.length)) }
      : kind === "images"
        ? { foundImages: Math.min(expectedCount, Math.max(Number(task.foundImages || 0) || 0, outputs.filter((output) => output?.mediaId).length, downloadedMediaIds.length)) }
        : {};

    patches.push({
      taskId: task.id,
      patch: {
        outputs,
        outputMediaIds,
        downloadedMediaIds,
        skippedDownloadMediaIds,
        downloadedCount: downloadedMediaIds.length,
        skippedDownloadCount: skippedDownloadMediaIds.length,
        ...foundPatch,
        lastDownloadAt: now
      },
      downloadedCount: downloadedMediaIds.length,
      skippedDownloadCount: skippedDownloadMediaIds.length
    });
  }
  return patches;
}

export function buildDownloadFilename(item = {}, options = {}) {
  const folder = sanitizeFolderName(options.folder || "Auto-Flow-01");
  const taskNumber = Math.max(1, Number(options.taskNumber || options.index || 1));
  const prefix = String(taskNumber).padStart(2, "0");
  const letter = variationLetter(item.mediaIndex || 0);
  const prompt = item.prompt || item.title || "media";
  const promptSlug = slugWordsWithSceneTag(prompt, 3);
  const resolution = options.resolution || item.downloadResolution || item.imageResolution || item.videoResolution || item.targetResolution || item.upscaleResolution || "";
  const extension = extensionForKind(item.kind, resolution);
  const style = String(options.filenameStyle || item.filenameStyle || "detailed");
  if (style === "prompt_prefix") {
    return `${folder}/${promptSlug}_${prefix}_${letter}.${extension}`;
  }
  if (style === "auto_flow") {
    // Auto Flow naming convention: {SCENE}_{LETTER}_{slug}.{ext}
    // Scene tag is unbracketed (V99-S4), prompt slug uses 4 words, and
    // 1k images use .jpeg (not .jpg) so the filename round-trips back to
    // the imported batch file naming users keep on disk.
    const sceneTag = extractFilenameSceneTag(prompt).replace(/^\[|\]$/g, "");
    const slug = slugWords(prompt, 4);
    const ext = autoFlowExtension(item.kind, resolution);
    const stem = sceneTag ? `${sceneTag}_${letter}_${slug}` : `${letter}_${slug}`;
    return `${folder}/${stem}.${ext}`;
  }
  if (style === "custom_template") {
    const templateName = buildTemplateFilenameStem(item, {
      ...options,
      taskNumber,
      prompt
    });
    return `${folder}/${templateName || `${prefix}_${letter}_${promptSlug}`}.${extension}`;
  }
  return `${folder}/${prefix}_${letter}_${promptSlug}.${extension}`;
}

function autoFlowExtension(kind = "", resolution = "") {
  if (kind === "images") return normalizeImageDownloadResolution(resolution) === "1k" ? "jpeg" : "png";
  return "mp4";
}

function templateIndexPart(mode = "nn", taskNumber = 1) {
  const value = Math.max(1, Number(taskNumber || 1));
  if (mode === "n") return String(value);
  if (mode === "nnn") return String(value).padStart(3, "0");
  if (mode === "nn") return String(value).padStart(2, "0");
  return "";
}

function templatePromptPart(mode = "first_3_words", prompt = "") {
  // All slug modes preserve the leading [Vn-Sn] scene tag so downloaded
  // files can be matched back to their source prompts on re-import.
  if (mode === "first_word") return slugWordsWithSceneTag(prompt, 1);
  if (mode === "slug_8") return slugWordsWithSceneTag(prompt, 8);
  if (mode === "first_3_words") return slugWordsWithSceneTag(prompt, 3);
  return "";
}

function templateDatePart(mode = "none", date = new Date()) {
  if (mode === "none") return "";
  const yy = String(date.getFullYear()).slice(-2);
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  if (mode === "yyyymmdd") return `${yyyy}${mm}${dd}`;
  if (mode === "yymmdd_hhmm") return `${yy}${mm}${dd}_${hh}${min}`;
  return "";
}

function templateSuffixPart(mode = "none", item = {}) {
  const source = String(item.mediaId || item.id || "media").replace(/[^a-z0-9]/gi, "");
  if (mode === "rand8") return source.slice(0, 8).toLowerCase() || "media";
  if (mode === "rand4") return source.slice(0, 4).toLowerCase() || "med";
  return "";
}

function buildTemplateFilenameStem(item = {}, options = {}) {
  const sep = String(options.filenameTemplateSeparator || item.filenameTemplateSeparator || "_") === "-" ? "-" : "_";
  const prefix = String(options.filenameTemplatePrefix || item.filenameTemplatePrefix || "").trim();
  const parts = [
    prefix,
    templateIndexPart(String(options.filenameTemplateIndex || item.filenameTemplateIndex || "nn"), options.taskNumber),
    templatePromptPart(String(options.filenameTemplatePromptPart || item.filenameTemplatePromptPart || "first_3_words"), options.prompt || item.prompt || item.title || ""),
    templateDatePart(String(options.filenameTemplateDate || item.filenameTemplateDate || "none")),
    templateSuffixPart(String(options.filenameTemplateSuffix || item.filenameTemplateSuffix || "none"), item)
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .map((part) => sanitizeFolderName(part));
  return parts.join(sep);
}

function normalizeDownloadTargetPathKey(value = "") {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .trim()
    .toLowerCase();
}

function downloadSlotGroupKey(item = {}, taskNumber = 1) {
  const taskId = String(item.taskId || "").trim();
  if (taskId) return `${item.kind || "media"}:task:${taskId}`;
  const jobId = String(item.jobId || "").trim();
  if (jobId) return `${item.kind || "media"}:job:${jobId}:${taskNumber}`;
  return `${item.kind || "media"}:loose:${taskNumber}:${normalizedPrompt(item.prompt || item.title)}`;
}

function plannedTaskNumber(item = {}, fallback = 1) {
  if (item.taskNumber !== undefined || item.jobIndex !== undefined) return itemTaskNumber(item, fallback);
  if (item.taskId || item.jobId) return 1;
  return itemTaskNumber(item, fallback);
}

function reserveDownloadSlot(slotGroups, item = {}, taskNumber = 1) {
  const groupKey = downloadSlotGroupKey(item, taskNumber);
  const group = slotGroups.get(groupKey) || new Set();
  let slot = hasExplicitMediaIndex(item) ? itemMediaIndex(item) : 0;
  if (!hasExplicitMediaIndex(item) || group.has(slot)) {
    slot = 0;
    while (group.has(slot)) slot += 1;
  }
  group.add(slot);
  slotGroups.set(groupKey, group);
  return slot;
}

export function planMediaDownloads(items = [], options = {}) {
  const seenArtifacts = new Set((options.reservedArtifactKeys || []).map((key) => String(key || "")));
  const seenTargets = new Set((options.reservedTargetPaths || []).map((key) => normalizeDownloadTargetPathKey(key)));
  const slotGroups = new Map();
  const plans = [];
  // Caller has already applied any project scoping; download planner
  // operates on the explicit selection it was handed. Pass keepUnscoped so
  // the new fail-closed default in filterGalleryItemsForProject doesn't
  // drop test fixtures or hand-built download sets without a projectId.
  const downloadItems = canonicalGalleryItems(items, { selectedIds: options.selectedIds || [], keepUnscoped: true })
    .filter((item) => item?.mediaId && item?.mediaUrl)
    .map((item, index) => ({ item, index }));
  for (const { item, index } of downloadItems) {
    const byTaskFilenameOptions = options.filenameOptionsByTaskId && typeof options.filenameOptionsByTaskId === "object"
      ? options.filenameOptionsByTaskId[String(item.taskId || "")] || {}
      : {};
    const resolution = downloadResolutionForItem(item, options);
    const upscale = requiresUpscaleDownload(item, resolution);
    const taskNumber = plannedTaskNumber(item, index + 1);
    const mediaIndex = reserveDownloadSlot(slotGroups, item, taskNumber);
    const filenameItem = {
      ...item,
      mediaIndex
    };
    const filename = buildDownloadFilename(filenameItem, {
      ...byTaskFilenameOptions,
      folder: options.folder,
      index: index + 1,
      taskNumber,
      resolution,
      filenameStyle: byTaskFilenameOptions.filenameStyle || options.filenameStyle || item.filenameStyle || "",
      filenameTemplatePrefix: byTaskFilenameOptions.filenameTemplatePrefix || options.filenameTemplatePrefix || item.filenameTemplatePrefix || "",
      filenameTemplateIndex: byTaskFilenameOptions.filenameTemplateIndex || options.filenameTemplateIndex || item.filenameTemplateIndex || "",
      filenameTemplatePromptPart: byTaskFilenameOptions.filenameTemplatePromptPart || options.filenameTemplatePromptPart || item.filenameTemplatePromptPart || "",
      filenameTemplateDate: byTaskFilenameOptions.filenameTemplateDate || options.filenameTemplateDate || item.filenameTemplateDate || "",
      filenameTemplateSuffix: byTaskFilenameOptions.filenameTemplateSuffix || options.filenameTemplateSuffix || item.filenameTemplateSuffix || "",
      filenameTemplateSeparator: byTaskFilenameOptions.filenameTemplateSeparator || options.filenameTemplateSeparator || item.filenameTemplateSeparator || ""
    });
    const artifactKey = `${item.kind || "media"}:${item.mediaId}:${resolution || "original"}`;
    const targetPathKey = normalizeDownloadTargetPathKey(filename);
    if (seenArtifacts.has(artifactKey) || seenTargets.has(targetPathKey)) continue;
    seenArtifacts.add(artifactKey);
    seenTargets.add(targetPathKey);
    plans.push({
      itemId: item.id,
      taskId: item.taskId || "",
      mediaId: item.mediaId,
      mediaGenerationId: item.mediaGenerationId || item.upscaleSourceId || "",
      kind: item.kind || "",
      url: normalizeMediaRedirectUrl(item.mediaUrl || "", item.mediaId),
      filename,
      mediaIndex,
      aspectRatio: item.aspectRatio || "",
      artifactKey,
      targetPathKey,
      source: item.source || "queue-ledger",
      matchMethod: item.matchMethod || "task_media_id",
      downloadPath: upscale ? "api_upscale" : "direct_named",
      resolution,
      filenameStyle: byTaskFilenameOptions.filenameStyle || options.filenameStyle || item.filenameStyle || "",
      filenameTemplatePrefix: byTaskFilenameOptions.filenameTemplatePrefix || options.filenameTemplatePrefix || item.filenameTemplatePrefix || "",
      filenameTemplateIndex: byTaskFilenameOptions.filenameTemplateIndex || options.filenameTemplateIndex || item.filenameTemplateIndex || "",
      filenameTemplatePromptPart: byTaskFilenameOptions.filenameTemplatePromptPart || options.filenameTemplatePromptPart || item.filenameTemplatePromptPart || "",
      filenameTemplateDate: byTaskFilenameOptions.filenameTemplateDate || options.filenameTemplateDate || item.filenameTemplateDate || "",
      filenameTemplateSuffix: byTaskFilenameOptions.filenameTemplateSuffix || options.filenameTemplateSuffix || item.filenameTemplateSuffix || "",
      filenameTemplateSeparator: byTaskFilenameOptions.filenameTemplateSeparator || options.filenameTemplateSeparator || item.filenameTemplateSeparator || "",
      requiresUpscale: upscale,
      dedupeDecision: "allowed"
    });
  }
  return plans;
}
