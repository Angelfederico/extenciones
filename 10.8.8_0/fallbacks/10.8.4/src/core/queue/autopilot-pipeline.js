// T2I -> F2V autopilot pipeline (issue #208).
//
// Builds Frame-to-Video job descriptors from completed Text-to-Image tasks
// using the prompt's video half (right side of |||) and the generated image's
// mediaId as the start frame reference. Mode "all" emits one F2V job per
// generated output; mode "one" picks a single random output per task.
//
// We do NOT build payload-shaped F2V jobs ourselves — that's the sidepanel's
// job (it knows the current presets, project, submitPath, etc.). This module
// only emits the *seed* descriptors that the sidepanel turns into proper jobs:
//
//   { videoPrompt, sceneTag, sourcePrompt, startMediaId, sourceTaskId }
//
// That separation keeps this file pure (no chrome.*, no state) so it's easy
// to unit-test.

const VIDEO_MODES = new Set(["text-to-video", "image-to-video", "ingredients-to-video"]);

function pickOneRandom(items, rng = Math.random) {
  if (!items.length) return null;
  return items[Math.floor(rng() * items.length)];
}

function isCompletedTextToImageTask(task = {}) {
  if (!task || typeof task !== "object") return false;
  if (String(task.mode || "") !== "text-to-image") return false;
  return ["complete", "done"].includes(String(task.status || ""));
}

function referenceMediaIdsForTask(task = {}) {
  return new Set([
    ...(Array.isArray(task.refMediaIds) ? task.refMediaIds : []),
    ...(Array.isArray(task.refInputs) ? task.refInputs.map((ref) => ref?.mediaId || ref?.assetImageId) : []),
    task.startMediaId,
    task.endMediaId,
    task.startRefInput?.mediaId,
    task.startRefInput?.assetImageId,
    task.endRefInput?.mediaId,
    task.endRefInput?.assetImageId
  ].map((id) => String(id || "").trim()).filter(Boolean));
}

function outputsForTask(task = {}) {
  const outputs = Array.isArray(task.outputs) ? task.outputs : [];
  const seen = new Set();
  const acc = [];
  for (const output of outputs) {
    const mediaId = String(output?.mediaId || "").trim();
    if (!mediaId || seen.has(mediaId)) continue;
    seen.add(mediaId);
    acc.push({
      mediaId,
      mediaUrl: String(output?.mediaUrl || ""),
      thumbnailUrl: String(output?.thumbnailUrl || ""),
      mediaIndex: Number.isFinite(Number(output?.mediaIndex)) ? Number(output.mediaIndex) : acc.length
    });
  }
  if (acc.length) return acc;
  // Fallback: derive from generatedMediaIds/mediaIds when outputs[] is missing
  // (older completed tasks used to populate ids before output detail was
  // filled in). Exclude uploaded/reference ids so After Run never animates a
  // user's T2I input reference instead of the image T2I just generated.
  const refs = referenceMediaIdsForTask(task);
  const sourceIds = Array.isArray(task.generatedMediaIds) && task.generatedMediaIds.length
    ? task.generatedMediaIds
    : (Array.isArray(task.mediaIds) ? task.mediaIds : []);
  const mediaIds = sourceIds.filter((id) => !refs.has(String(id || "").trim()));
  return mediaIds
    .map((id, index) => ({
      mediaId: String(id || "").trim(),
      mediaUrl: "",
      thumbnailUrl: "",
      mediaIndex: index
    }))
    .filter((output) => output.mediaId && !VIDEO_MODES.has(String(task.mode || "")));
}

export function buildAutopilotF2VSeedsFromTasks(tasks = [], options = {}) {
  const mode = options.mode === "all" || options.mode === "one" ? options.mode : "off";
  if (mode === "off") return [];
  const rng = typeof options.random === "function" ? options.random : Math.random;
  const seeds = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!isCompletedTextToImageTask(task)) continue;
    const videoPrompt = String(task.videoPrompt || "").trim();
    if (!videoPrompt) continue;
    const outputs = outputsForTask(task);
    if (!outputs.length) continue;
    const chosen = mode === "one" ? [pickOneRandom(outputs, rng)].filter(Boolean) : outputs;
    for (const output of chosen) {
      seeds.push({
        videoPrompt,
        sceneTag: String(task.sceneTag || ""),
        sourcePrompt: String(task.sourcePrompt || task.prompt || ""),
        imagePrompt: String(task.imagePrompt || ""),
        startMediaId: output.mediaId,
        startMediaUrl: output.mediaUrl,
        startThumbnailUrl: output.thumbnailUrl,
        sourceTaskId: String(task.id || ""),
        sourceMediaIndex: output.mediaIndex
      });
    }
  }
  return seeds;
}

// True iff at least one of the supplied tasks would produce an autopilot
// seed under the given mode. Used by the sidepanel to decide whether to flip
// the wizard mode + enqueue, vs. log a "nothing to animate" warning.
export function autopilotHasUsableTasks(tasks = [], options = {}) {
  return buildAutopilotF2VSeedsFromTasks(tasks, options).length > 0;
}
