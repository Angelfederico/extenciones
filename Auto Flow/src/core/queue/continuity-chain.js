export const CONTINUITY_CHAIN_MODE = "previous_output";

function compactIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean))];
}

function mediaIdFromOutput(output = {}) {
  if (typeof output === "string") return output.trim();
  return String(output?.mediaId || output?.id || "").trim();
}

function workflowIdFromOutput(output = {}) {
  if (!output || typeof output !== "object") return "";
  return String(
    output.workflowId ||
    output.sourceWorkflowId ||
    output.flowWorkflowId ||
    output.workflow ||
    ""
  ).trim();
}

function outputRowsForTask(task = {}) {
  return [
    ...(Array.isArray(task.outputs) ? task.outputs : []),
    ...(Array.isArray(task.submitOutputRows) ? task.submitOutputRows : []),
    ...(Array.isArray(task.statusRows) ? task.statusRows : [])
  ].filter((row) => row && typeof row === "object");
}

function workflowIdForOutputMedia(task = {}, mediaId = "") {
  const target = String(mediaId || "").trim();
  if (!target) return "";
  const row = outputRowsForTask(task).find((candidate) => String(
    candidate.mediaId ||
    candidate.id ||
    candidate.name ||
    ""
  ).trim() === target);
  return workflowIdFromOutput(row);
}

function referenceMediaIdsFromTask(task = {}) {
  return new Set(compactIds([
    ...(Array.isArray(task.refMediaIds) ? task.refMediaIds : []),
    ...(Array.isArray(task.refInputs) ? task.refInputs.map((ref) => ref?.mediaId || ref?.assetImageId) : []),
    task.startMediaId,
    task.endMediaId,
    task.startRefInput?.mediaId,
    task.startRefInput?.assetImageId,
    task.endRefInput?.mediaId,
    task.endRefInput?.assetImageId
  ]));
}

function compactRefInputs(values = [], limit = 10) {
  const seen = new Set();
  const refs = [];
  for (const ref of Array.isArray(values) ? values : []) {
    if (!ref || typeof ref !== "object") continue;
    const key = String(ref.id || ref.mediaId || ref.assetImageId || ref.blobStoreId || ref.fileName || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    refs.push({ ...ref });
    if (refs.length >= limit) break;
  }
  return refs;
}

export function continuityOutputMediaIds(task = {}) {
  const referenceIds = referenceMediaIdsFromTask(task);
  return compactIds([
    ...(Array.isArray(task.outputMediaIds) ? task.outputMediaIds : []),
    ...(Array.isArray(task.outputs) ? task.outputs.map(mediaIdFromOutput) : []),
    ...(Array.isArray(task.mediaIds) ? task.mediaIds : [])
  ]).filter((id) => !referenceIds.has(id));
}

export function isContinuityChainTask(task = {}) {
  return String(task.mode || "") === "text-to-image"
    && String(task.referenceChainMode || "") === CONTINUITY_CHAIN_MODE
    && Number(task.jobIndex || 0) > 0;
}

export function findContinuitySourceTask(tasks = [], task = {}) {
  if (!isContinuityChainTask(task)) return null;
  const jobId = String(task.jobId || "").trim();
  const sourceIndex = Number(task.jobIndex || 0) - 1;
  return (Array.isArray(tasks) ? tasks : []).find((candidate) => (
    String(candidate?.jobId || "").trim() === jobId
    && Number(candidate?.jobIndex || 0) === sourceIndex
    && String(candidate?.mode || "") === "text-to-image"
  )) || null;
}

export function buildContinuityRefPatch(tasks = [], task = {}) {
  if (!isContinuityChainTask(task)) {
    return { status: "not_chain", patch: null, sourceTask: null };
  }
  const existingIds = compactIds([
    ...(Array.isArray(task.refMediaIds) ? task.refMediaIds : []),
    ...(Array.isArray(task.refInputs) ? task.refInputs.map((ref) => ref?.mediaId) : [])
  ]);
  if (existingIds.length && task.continuitySourceMediaId) {
    return { status: "already_resolved", patch: null, sourceTask: null };
  }
  const sourceTask = findContinuitySourceTask(tasks, task);
  if (!sourceTask) {
    return { status: "missing_source", patch: null, sourceTask: null };
  }
  if (["failed", "blocked"].includes(String(sourceTask.status || ""))) {
    return { status: "source_failed", patch: null, sourceTask };
  }
  if (String(sourceTask.status || "") !== "complete") {
    return { status: "source_not_ready", patch: null, sourceTask };
  }
  const mediaId = continuityOutputMediaIds(sourceTask)[0] || "";
  if (!mediaId) {
    return { status: "source_output_missing", patch: null, sourceTask };
  }
  const sourceNumber = Number(sourceTask.jobIndex || 0) + 1;
  const workflowId = workflowIdForOutputMedia(sourceTask, mediaId);
  const assetImageId = workflowId
    ? `fe_id_${workflowId.replace(/^fe_id_/i, "")}`
    : `fe_id_${mediaId.replace(/^fe_id_/i, "")}`;
  const ref = {
    id: `continuity:${sourceTask.id}:${mediaId}`,
    role: "imagePromptRefs",
    mediaId,
    assetImageId,
    workflowId,
    sourceWorkflowId: workflowId,
    collectionOrWorkflowId: workflowId ? { workflowId } : null,
    title: `Previous output from prompt ${sourceNumber}`,
    fileName: `previous-output-${String(sourceNumber).padStart(2, "0")}.png`,
    mimeType: "image/png",
    source: "continuity_chain",
    sourceTaskId: sourceTask.id || "",
    sourceJobIndex: Number(sourceTask.jobIndex || 0)
  };
  const maxRefs = 10;
  const existingRefInputs = compactRefInputs(Array.isArray(task.refInputs) ? task.refInputs : [], maxRefs - 1)
    .filter((input) => String(input.mediaId || input.id || "") !== mediaId);
  const mergedRefInputs = compactRefInputs([ref, ...existingRefInputs], maxRefs);
  const mergedRefMediaIds = compactIds([
    mediaId,
    ...(Array.isArray(task.refMediaIds) ? task.refMediaIds : []),
    ...mergedRefInputs.map((input) => input.mediaId)
  ]).slice(0, maxRefs);
  return {
    status: "resolved",
    sourceTask,
    patch: {
      refInputs: mergedRefInputs,
      refMediaIds: mergedRefMediaIds,
      continuitySourceTaskId: sourceTask.id || "",
      continuitySourceMediaId: mediaId,
      continuityResolvedAt: new Date().toISOString()
    }
  };
}
