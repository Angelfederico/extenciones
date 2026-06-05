import { TaskStatus } from "./task-ledger.js";

const VIDEO_MODES = new Set([
  "text-to-video",
  "image-to-video",
  "start-end-image-to-video",
  "ingredients-to-video"
]);

export function isVideoTask(task = {}) {
  return VIDEO_MODES.has(String(task?.mode || ""));
}

export function isComposerNotReadyVideoRetry(task = {}) {
  if (!isVideoTask(task)) return false;
  if (String(task?.status || "") !== TaskStatus.pending) return false;
  const error = String(task?.lastError || task?.statusText || task?.error || "").toLowerCase();
  return error.includes("composer_not_ready")
    && (error.includes("editor_missing") || error.includes("editor_unstable") || error.includes("flow_loading"));
}

export function activeVideoTaskBeforeComposerRetry(task = {}, tasks = []) {
  if (!isComposerNotReadyVideoRetry(task)) return null;
  const priorWaits = Math.max(0, Number(task?.composerRetryWaitCount || 0) || 0);
  const attempts = Math.max(1, Number(task?.attempts || 0) || 0);
  if (priorWaits >= attempts) return null;
  return (Array.isArray(tasks) ? tasks : []).find((candidate) => (
    candidate?.id &&
    candidate.id !== task.id &&
    String(candidate.status || "") === TaskStatus.generating &&
    isVideoTask(candidate)
  )) || null;
}
