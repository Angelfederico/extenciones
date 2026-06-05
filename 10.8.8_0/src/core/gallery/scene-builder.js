export function normalizeSceneKind(value = "") {
  const raw = String(value || "").toLowerCase();
  if (raw === "video" || raw === "videos" || raw.includes("video")) return "videos";
  return "";
}

export function sceneClipFromGalleryItem(item = {}, order = 0, options = {}) {
  const kind = normalizeSceneKind(item.kind || item.type || item.mediaKind || item.mode);
  if (kind !== "videos") return null;
  const mediaId = String(item.mediaId || item.media_id || "").trim();
  const mediaUrl = firstString(
    item.mediaUrl,
    item.url
  );
  const thumbnailUrl = firstString(
    item.thumbnailUrl,
    item.thumbUrl,
    mediaUrl
  );
  const title = firstString(item.title, item.fileName, item.prompt, mediaId, `Scene video ${order + 1}`);
  const prompt = firstString(item.prompt, item.videoPrompt, item.title, "");
  const duration = sceneDurationForItem(item);

  return {
    id: options.idFactory ? options.idFactory(item, order) : randomId("scene"),
    kind,
    mediaId,
    mediaUrl,
    thumbnailUrl,
    prompt,
    title,
    duration,
    order: toInt(order, 0, 9999, 0),
    sourceTaskId: firstString(item.sourceTaskId, item.taskId, item.jobId, ""),
    sourceGalleryId: firstString(item.sourceGalleryId, item.id, ""),
    projectId: firstString(item.projectId, item.flowProjectId, options.projectId, ""),
    mediaIndex: toInt(item.mediaIndex, 0, 9999, 0),
    createdAt: firstString(item.createdAt, item.downloadedAt, item.updatedAt, options.now, new Date().toISOString()),
    source: firstString(item.source, "gallery")
  };
}

export function normalizeSceneClip(clip = {}, index = 0) {
  const kind = sceneClipKindFromPersistedClip(clip);
  if (kind !== "videos") return null;
  const start = toNumber(clip.startTime, 0);
  const end = toNumber(clip.endTime, 0);
  const inferredDuration = end > start ? end - start : clip.duration;
  const mediaUrl = firstString(clip.mediaUrl, clip.sourceUrl, clip.url);
  return {
    id: firstString(clip.id, `clip-${index + 1}`),
    kind,
    mediaId: firstString(clip.mediaId, clip.assetId, clip.genId, ""),
    mediaUrl,
    thumbnailUrl: firstString(clip.thumbnailUrl, clip.thumbUrl, mediaUrl),
    prompt: firstString(clip.prompt, clip.description, ""),
    title: firstString(clip.title, clip.prompt, clip.fileName, clip.mediaId, "Generated media"),
    duration: toInt(inferredDuration, 1, 120, 6),
    order: toInt(clip.order, 0, 9999, index),
    sourceTaskId: firstString(clip.sourceTaskId, clip.taskId, ""),
    sourceGalleryId: firstString(clip.sourceGalleryId, clip.galleryId, ""),
    projectId: firstString(clip.projectId, clip.flowProjectId, ""),
    mediaIndex: toInt(clip.mediaIndex, 0, 9999, 0),
    createdAt: firstString(clip.createdAt, ""),
    source: firstString(clip.source, "scene")
  };
}

export function sceneDedupeKey(clip = {}) {
  const kind = normalizeSceneKind(clip.kind);
  const mediaId = firstString(clip.mediaId);
  if (mediaId) return `${kind}:media:${mediaId}`;
  const galleryId = firstString(clip.sourceGalleryId);
  if (galleryId) return `${kind}:gallery:${galleryId}`;
  const url = firstString(clip.mediaUrl, clip.thumbnailUrl);
  if (url) return `${kind}:url:${url}`;
  return `${kind}:clip:${firstString(clip.id)}`;
}

export function mergeSceneGalleryItems(existingClips = [], galleryItems = [], options = {}) {
  const normalizedExisting = existingClips.map(normalizeSceneClip).filter(Boolean);
  const seen = new Set(normalizedExisting.map(sceneDedupeKey));
  const added = [];
  const skipped = [];
  const startOrder = normalizedExisting.length;

  for (const item of galleryItems) {
    const clip = sceneClipFromGalleryItem(item, startOrder + added.length, options);
    if (!clip) {
      skipped.push({
        reason: "not_video",
        sourceGalleryId: firstString(item?.sourceGalleryId, item?.id, ""),
        mediaId: firstString(item?.mediaId, item?.media_id, "")
      });
      continue;
    }
    const key = sceneDedupeKey(clip);
    if (seen.has(key)) {
      skipped.push(clip);
      continue;
    }
    seen.add(key);
    added.push(clip);
  }

  const clips = renumberSceneClips([...normalizedExisting, ...added]);
  return {
    clips,
    added,
    skipped,
    totalDuration: totalSceneDuration(clips)
  };
}

export function renumberSceneClips(clips = []) {
  return clips
    .map(normalizeSceneClip)
    .filter(Boolean)
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .map((clip, order) => ({ ...clip, order }));
}

export function totalSceneDuration(clips = []) {
  return clips.reduce((sum, clip) => sum + Math.max(0, Number(clip.duration || 0) || 0), 0);
}

export function sceneGallerySelectionIds(clips = []) {
  return [...new Set(clips
    .map((clip) => firstString(clip.sourceGalleryId))
    .filter(Boolean))];
}

function sceneDurationForItem(item = {}) {
  const explicit = toNumber(item.duration || item.videoLength || item.lengthSeconds, 0);
  if (explicit > 0) return Math.max(1, Math.min(120, Math.round(explicit)));
  return 6;
}

function sceneClipKindFromPersistedClip(clip = {}) {
  const explicit = normalizeSceneKind(clip.kind || clip.type || clip.assetType);
  if (explicit) return explicit;
  const mediaUrl = firstString(clip.sourceUrl, clip.mediaUrl, clip.url);
  if (!mediaUrl) return "";
  if (looksLikeImageAsset(mediaUrl) || firstString(clip.imageUrl, clip.dataUrl)) return "";
  return "videos";
}

function looksLikeImageAsset(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (/^data:image\//i.test(raw)) return true;
  try {
    const url = new URL(raw, "https://autoflow.local");
    return /\.(png|jpe?g|webp|gif|avif|heic)(?:$|[?#])/i.test(url.pathname);
  } catch {
    return /\.(png|jpe?g|webp|gif|avif|heic)(?:$|[?#])/i.test(raw);
  }
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function toInt(value, min, max, fallback) {
  const next = Number.parseInt(value, 10);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

function toNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function randomId(prefix = "id") {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
