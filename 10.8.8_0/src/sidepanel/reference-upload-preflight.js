export const DEFAULT_REFERENCE_UPLOAD_MAX_ATTEMPTS = 3;
export const DEFAULT_REFERENCE_UPLOAD_RETRY_DELAY_MS = 350;

function defaultSleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

export function referenceUploadFileName(item = {}, index = 0) {
  const raw = String(item?.fileName || item?.title || item?.name || "").trim();
  return raw || `reference-${index + 1}.png`;
}

function uploadErrorFromResult(upload = {}, fallback = "missing_media_id") {
  return String(
    upload?.error
      || upload?.statusText
      || upload?.data?.error
      || fallback
      || "missing_media_id"
  ).trim() || "missing_media_id";
}

function referenceUploadFailureMessage(failures = []) {
  const details = failures.map((failure) => {
    const attempts = Number(failure?.attempts || 0);
    const suffix = attempts > 1 ? ` after ${attempts} attempts` : "";
    return `${failure.fileName}: ${failure.error || "missing_media_id"}${suffix}`;
  });
  return `Reference upload failed for ${details.join("; ")}. Queue was not started.`;
}

function createReferenceUploadError(failures = []) {
  const error = new Error(referenceUploadFailureMessage(failures));
  error.code = "REFERENCE_UPLOAD_FAILED";
  error.failedReferences = failures.map((failure) => ({
    fileName: failure.fileName,
    error: failure.error,
    attempts: failure.attempts
  }));
  return error;
}

async function uploadReferenceWithRetries(item, index, options = {}) {
  const {
    projectId,
    send,
    messageType,
    imageBytesForItem,
    isHidden = false,
    maxAttempts = DEFAULT_REFERENCE_UPLOAD_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_REFERENCE_UPLOAD_RETRY_DELAY_MS,
    sleep = defaultSleep,
    now = () => new Date().toISOString()
  } = options;
  const fileName = referenceUploadFileName(item, index);
  const imageBytes = await imageBytesForItem(item);
  if (!imageBytes || /^https?:\/\//i.test(String(imageBytes))) {
    const failure = {
      ok: false,
      item,
      index,
      fileName,
      error: "reference_source_missing",
      attempts: 0
    };
    item.uploadError = failure.error;
    return failure;
  }

  let lastFailure = null;
  const attempts = Math.max(1, Number(maxAttempts || 1));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await send(messageType, {
        projectId,
        files: [{
          fileName,
          mimeType: item.mimeType || "image/png",
          imageBytes,
          isHidden
        }]
      });
      const upload = response?.payload?.uploads?.[0] || {};
      const mediaId = String(upload.mediaId || "").trim();
      if (upload.ok && mediaId) {
        item.uploadError = "";
        if (!isHidden) {
          item.mediaId = mediaId;
          item.uploadedAt = now();
        }
        return {
          ok: true,
          item,
          index,
          fileName,
          mediaId,
          attempts: attempt
        };
      }
      lastFailure = {
        ok: false,
        item,
        index,
        fileName,
        error: uploadErrorFromResult(upload),
        attempts: attempt
      };
    } catch (error) {
      lastFailure = {
        ok: false,
        item,
        index,
        fileName,
        error: String(error?.message || error || "upload_failed"),
        attempts: attempt
      };
    }
    if (attempt < attempts) {
      await sleep(retryDelayMs * attempt);
    }
  }
  item.uploadError = lastFailure?.error || "missing_media_id";
  return lastFailure || {
    ok: false,
    item,
    index,
    fileName,
    error: "missing_media_id",
    attempts
  };
}

export async function materializeReferenceUploads(items = [], options = {}) {
  const refs = Array.isArray(items) ? items : [];
  const missing = refs
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !String(item?.mediaId || "").trim());
  if (!missing.length) {
    return {
      uploaded: [],
      mediaIds: refs.map((item) => String(item?.mediaId || "").trim()).filter(Boolean)
    };
  }

  const settled = await Promise.all(missing.map(({ item, index }) => (
    uploadReferenceWithRetries(item, index, options)
  )));
  const failures = settled.filter((result) => !result?.ok || !result?.mediaId);
  if (failures.length) {
    throw createReferenceUploadError(failures);
  }

  const uploadedByIndex = new Map(settled
    .filter((result) => result?.ok && result?.mediaId)
    .map((result) => [Number(result.index), String(result.mediaId || "").trim()]));
  const mediaIds = refs
    .map((item, index) => String(item?.mediaId || uploadedByIndex.get(index) || "").trim())
    .filter(Boolean);
  if (mediaIds.length !== refs.length) {
    const failed = refs
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => !String(item?.mediaId || uploadedByIndex.get(index) || "").trim())
      .map(({ item, index }) => ({
        ok: false,
        item,
        fileName: referenceUploadFileName(item, index),
        error: item?.uploadError || "missing_media_id",
        attempts: 0
      }));
    throw createReferenceUploadError(failed);
  }

  return {
    uploaded: settled,
    mediaIds
  };
}
