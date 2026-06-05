import { TaskStatus } from "../queue/task-ledger.js";

export function promptUsageCountForTask(task = {}) {
  const explicit = Number(task.promptUsageCount || task.usagePromptCount || 0);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, Math.floor(explicit));
  return 1;
}

export function promptUsageIdempotencyKey(task = {}) {
  const taskId = String(task?.id || "").trim();
  if (!taskId) return "";
  return `prompt_usage:${taskId}`;
}

export function shouldRecordPromptUsageForTask(task = {}) {
  if (!task?.id) return false;
  if (task.usageRecordedAt) return false;
  if (task.retryOfTaskId) return false;
  if (!task.submittedAt) return false;
  return [TaskStatus.generating, TaskStatus.complete].includes(String(task.status || ""));
}
