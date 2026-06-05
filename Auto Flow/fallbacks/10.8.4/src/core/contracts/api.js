export const FLOW_API_ORIGIN = "https://aisandbox-pa.googleapis.com";
export const FLOW_WEB_ORIGIN = "https://labs.google";
export const RECAPTCHA_SITE_KEY = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";

export const FlowEndpoint = Object.freeze({
  generateImages: "/v1/projects/{projectId}/flowMedia:batchGenerateImages",
  videoText: "/v1/video:batchAsyncGenerateVideoText",
  videoStartImage: "/v1/video:batchAsyncGenerateVideoStartImage",
  videoStartAndEndImage: "/v1/video:batchAsyncGenerateVideoStartAndEndImage",
  videoReferenceImages: "/v1/video:batchAsyncGenerateVideoReferenceImages",
  videoStatus: "/v1/video:batchCheckAsyncVideoGenerationStatus",
  uploadImage: "/v1/flow/uploadImage"
});

export const FlowWebEndpoint = Object.freeze({
  mediaRedirect: "/fx/api/trpc/media.getMediaUrlRedirect"
});

export function endpointUrl(endpoint, params = {}) {
  const path = String(endpoint || "").replace(/\{(\w+)\}/g, (_match, key) => {
    const value = String(params[key] || "").trim();
    if (!value) throw new Error(`Missing endpoint param: ${key}`);
    return encodeURIComponent(value);
  });
  return `${FLOW_API_ORIGIN}${path}`;
}

export function webEndpointUrl(endpoint, params = {}) {
  const path = String(endpoint || "").replace(/\{(\w+)\}/g, (_match, key) => {
    const value = String(params[key] || "").trim();
    if (!value) throw new Error(`Missing endpoint param: ${key}`);
    return encodeURIComponent(value);
  });
  return `${FLOW_WEB_ORIGIN}${path}`;
}

export function normalizeVideoAspectRatio(value = "landscape") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "portrait" || raw === "portrait_3_4" || raw === "9:16") {
    return "VIDEO_ASPECT_RATIO_PORTRAIT";
  }
  if (raw === "square" || raw === "1:1") {
    return "VIDEO_ASPECT_RATIO_SQUARE";
  }
  return "VIDEO_ASPECT_RATIO_LANDSCAPE";
}

export function normalizeImageAspectRatio(value = "landscape") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "landscape_4_3" || raw === "4:3") {
    return "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE";
  }
  if (raw === "portrait_3_4" || raw === "3:4") {
    return "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR";
  }
  if (raw === "portrait" || raw === "9:16") {
    return "IMAGE_ASPECT_RATIO_PORTRAIT";
  }
  if (raw === "square" || raw === "1:1") {
    return "IMAGE_ASPECT_RATIO_SQUARE";
  }
  return "IMAGE_ASPECT_RATIO_LANDSCAPE";
}

export function normalizeVideoDuration(value = "8") {
  const raw = String(value || "").trim();
  return raw === "4" || raw === "6" || raw === "8" ? raw : "8";
}

export function normalizeImageModelName(value = "nano_banana_pro", hasRefs = false) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "default") return "GEM_PIX_2";
  if (raw.includes("narwhal")) return "NARWHAL";
  if (raw.includes("banana") && raw.includes("2")) return "NARWHAL";
  if (raw.includes("nano") && raw.includes("2")) return "NARWHAL";
  if (raw.includes("imagen")) return hasRefs ? "R2I" : "IMAGEN_3_5";
  return "GEM_PIX_2";
}

export function normalizeVideoModelKey(mode, value = "default", aspectRatio = "landscape", options = {}) {
  const incoming = String(value || "").trim().toLowerCase();
  const raw = incoming === "veo_3_1" || incoming === "veo3" || incoming === "veo-3-1"
    ? "default"
    : incoming;
  const aspect = normalizeVideoAspectRatio(aspectRatio);
  const isPortrait = aspect === "VIDEO_ASPECT_RATIO_PORTRAIT";
  const hasEndImage = options.hasEndImage === true;
  const duration = normalizeVideoDuration(options.duration || options.videoLength || "8");
  const isLowerPriority =
    !raw ||
    raw === "default" ||
    raw.includes("lite_low") ||
    raw.includes("fast_low") ||
    raw.includes("lower");

  if (mode === "t2v") {
    if (raw.includes("quality") && !raw.includes("veo2")) {
      if (duration === "4") return "veo_3_1_t2v_quality_4s";
      if (duration === "6") return "veo_3_1_t2v_quality_6s";
      return isPortrait ? "veo_3_1_t2v_portrait" : "veo_3_1_t2v";
    }
    if (raw.includes("lite") || !raw || raw === "default") {
      if (duration === "4") return isLowerPriority ? "veo_3_1_t2v_lite_4s_low_priority" : "veo_3_1_t2v_lite_4s";
      if (duration === "6") return isLowerPriority ? "veo_3_1_t2v_lite_6s_low_priority" : "veo_3_1_t2v_lite_6s";
      return isLowerPriority ? "veo_3_1_t2v_lite_low_priority" : "veo_3_1_t2v_lite";
    }
    if (isLowerPriority) {
      if (duration === "4") return "veo_3_1_t2v_fast_4s_relaxed";
      if (duration === "6") return "veo_3_1_t2v_fast_6s_relaxed";
      return isPortrait ? "veo_3_1_t2v_fast_portrait_ultra_relaxed" : "veo_3_1_t2v_fast_ultra_relaxed";
    }
    if (duration === "4") return "veo_3_1_t2v_fast_4s";
    if (duration === "6") return "veo_3_1_t2v_fast_6s";
    return isPortrait ? "veo_3_1_t2v_fast_portrait_ultra" : "veo_3_1_t2v_fast_ultra";
  }

  if (mode === "i2v") {
    if (raw.includes("quality")) {
      if (duration === "4") return hasEndImage ? "veo_3_1_i2v_s_quality_4s_fl" : "veo_3_1_i2v_s_quality_4s";
      if (duration === "6") return hasEndImage ? "veo_3_1_i2v_s_quality_6s_fl" : "veo_3_1_i2v_s_quality_6s";
      if (hasEndImage) return isPortrait ? "veo_3_1_i2v_s_portrait_fl" : "veo_3_1_i2v_s_fl";
      return isPortrait ? "veo_3_1_i2v_s_portrait" : "veo_3_1_i2v_s";
    }
    if (raw.includes("lite") || !raw || raw === "default") {
      if (hasEndImage) {
        if (duration === "4") return isLowerPriority ? "veo_3_1_interpolation_lite_4s_low_priority" : "veo_3_1_interpolation_lite_4s";
        if (duration === "6") return isLowerPriority ? "veo_3_1_interpolation_lite_6s_low_priority" : "veo_3_1_interpolation_lite_6s";
        return isLowerPriority ? "veo_3_1_interpolation_lite_low_priority" : "veo_3_1_interpolation_lite";
      }
      if (duration === "4") return isLowerPriority ? "veo_3_1_i2v_s_lite_4s_low_priority" : "veo_3_1_i2v_s_lite_4s";
      if (duration === "6") return isLowerPriority ? "veo_3_1_i2v_s_lite_6s_low_priority" : "veo_3_1_i2v_s_lite_6s";
      return isLowerPriority ? "veo_3_1_i2v_lite_low_priority" : "veo_3_1_i2v_lite";
    }
    if (isLowerPriority) {
      if (duration === "4") return hasEndImage ? "veo_3_1_i2v_s_fast_4s_fl_relaxed" : "veo_3_1_i2v_s_fast_4s_relaxed";
      if (duration === "6") return hasEndImage ? "veo_3_1_i2v_s_fast_6s_fl_relaxed" : "veo_3_1_i2v_s_fast_6s_relaxed";
      if (hasEndImage) return isPortrait ? "veo_3_1_i2v_s_fast_portrait_fl_ultra_relaxed" : "veo_3_1_i2v_s_fast_fl_ultra_relaxed";
      return isPortrait ? "veo_3_1_i2v_s_fast_portrait_ultra_relaxed" : "veo_3_1_i2v_s_fast_ultra_relaxed";
    }
    if (duration === "4") return hasEndImage ? "veo_3_1_i2v_s_fast_4s_fl" : "veo_3_1_i2v_s_fast_4s";
    if (duration === "6") return hasEndImage ? "veo_3_1_i2v_s_fast_6s_fl" : "veo_3_1_i2v_s_fast_6s";
    if (hasEndImage) return isPortrait ? "veo_3_1_i2v_s_fast_portrait_fl_ultra" : "veo_3_1_i2v_s_fast_fl_ultra";
    return isPortrait ? "veo_3_1_i2v_s_fast_portrait_ultra" : "veo_3_1_i2v_s_fast_ultra";
  }

  if (mode === "r2v") {
    // Legacy ingredients-to-video never used an r2v_lite catalog key in the
    // effective UI path. Non-fast/default selections were normalized to the
    // fast lower-priority R2V model, which is the safer public account route.
    if (raw.includes("lite") || isLowerPriority) {
      return isPortrait ? "veo_3_1_r2v_fast_portrait_ultra_relaxed" : "veo_3_1_r2v_fast_landscape_ultra_relaxed";
    }
    return isPortrait ? "veo_3_1_r2v_fast_portrait" : "veo_3_1_r2v_fast_landscape";
  }

  throw new Error(`Unknown video mode: ${mode}`);
}

export function normalizeAudioFailurePreference(returnSilentVideos = true) {
  return returnSilentVideos === false || returnSilentVideos === "false"
    ? "BLOCK_SILENCED_VIDEOS"
    : "RETURN_SILENCED_VIDEOS";
}

function buildVideoMediaGenerationContext({ batchId, returnSilentVideos = true } = {}) {
  return {
    batchId,
    audioFailurePreference: normalizeAudioFailurePreference(returnSilentVideos)
  };
}

export function buildClientContext({
  projectId = "",
  recaptchaToken = "",
  now = Date.now(),
  includePaygateTier = true
} = {}) {
  const context = {
    tool: "PINHOLE",
    sessionId: `;${now}`
  };
  if (includePaygateTier) context.userPaygateTier = "PAYGATE_TIER_TWO";
  if (projectId) context.projectId = String(projectId);
  if (recaptchaToken) {
    context.recaptchaContext = {
      token: String(recaptchaToken),
      applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB"
    };
  }
  return context;
}

export function buildTextToImageBody({
  prompt,
  projectId,
  recaptchaToken,
  mediaIds = [],
  repeatCount = 1,
  model = "nano_banana_pro",
  aspectRatio = "landscape",
  batchId,
  seedFactory = () => Math.floor(Math.random() * 2147483647)
}) {
  const refs = [...new Set(mediaIds.map((id) => String(id || "").trim()).filter(Boolean))];
  const clientContext = buildClientContext({
    projectId,
    recaptchaToken,
    includePaygateTier: false
  });
  const requestCount = Math.max(1, Math.min(8, Number.parseInt(repeatCount, 10) || 1));
  return {
    clientContext,
    mediaGenerationContext: { batchId },
    useNewMedia: true,
    requests: Array.from({ length: requestCount }, () => ({
      clientContext: { ...clientContext, recaptchaContext: clientContext.recaptchaContext ? { ...clientContext.recaptchaContext } : undefined },
      imageModelName: normalizeImageModelName(model, refs.length > 0),
      imageAspectRatio: normalizeImageAspectRatio(aspectRatio),
      structuredPrompt: { parts: [{ text: String(prompt || "").trim() }] },
      seed: seedFactory(),
      imageInputs: refs.map((name) => ({
        imageInputType: "IMAGE_INPUT_TYPE_REFERENCE",
        name
      }))
    }))
  };
}

export function buildTextToVideoBody({
  prompt,
  projectId,
  recaptchaToken,
  repeatCount = 1,
  model = "default",
  aspectRatio = "landscape",
  videoLength = "8",
  returnSilentVideos = true,
  batchId,
  seedFactory = () => Math.floor(Math.random() * 2147483647)
}) {
  const requestCount = Math.max(1, Math.min(8, Number.parseInt(repeatCount, 10) || 1));
  const apiAspectRatio = normalizeVideoAspectRatio(aspectRatio);
  return {
    mediaGenerationContext: buildVideoMediaGenerationContext({ batchId, returnSilentVideos }),
    clientContext: buildClientContext({ projectId, recaptchaToken }),
    requests: Array.from({ length: requestCount }, () => ({
      aspectRatio: apiAspectRatio,
      seed: seedFactory(),
      textInput: { structuredPrompt: { parts: [{ text: String(prompt || "").trim() }] } },
      videoModelKey: normalizeVideoModelKey("t2v", model, aspectRatio, { duration: videoLength }),
      metadata: {}
    })),
    useV2ModelConfig: true
  };
}

export function buildVideoStartImageBody({
  prompt,
  projectId,
  recaptchaToken,
  startMediaId,
  repeatCount = 1,
  model = "default",
  aspectRatio = "landscape",
  videoLength = "8",
  returnSilentVideos = true,
  batchId,
  seedFactory = () => Math.floor(Math.random() * 2147483647)
}) {
  const requestCount = Math.max(1, Math.min(8, Number.parseInt(repeatCount, 10) || 1));
  const apiAspectRatio = normalizeVideoAspectRatio(aspectRatio);
  return {
    mediaGenerationContext: buildVideoMediaGenerationContext({ batchId, returnSilentVideos }),
    clientContext: buildClientContext({ projectId, recaptchaToken }),
    requests: Array.from({ length: requestCount }, () => ({
      aspectRatio: apiAspectRatio,
      seed: seedFactory(),
      textInput: { structuredPrompt: { parts: [{ text: String(prompt || "").trim() }] } },
      videoModelKey: normalizeVideoModelKey("i2v", model, aspectRatio, { duration: videoLength }),
      metadata: {},
      startImage: { mediaId: String(startMediaId || "").trim() }
    })),
    useV2ModelConfig: true
  };
}

export function buildVideoStartAndEndImageBody({
  prompt,
  projectId,
  recaptchaToken,
  startMediaId,
  endMediaId,
  repeatCount = 1,
  model = "default",
  aspectRatio = "landscape",
  videoLength = "8",
  returnSilentVideos = true,
  batchId,
  seedFactory = () => Math.floor(Math.random() * 2147483647)
}) {
  const requestCount = Math.max(1, Math.min(8, Number.parseInt(repeatCount, 10) || 1));
  const apiAspectRatio = normalizeVideoAspectRatio(aspectRatio);
  return {
    mediaGenerationContext: buildVideoMediaGenerationContext({ batchId, returnSilentVideos }),
    clientContext: buildClientContext({ projectId, recaptchaToken }),
    requests: Array.from({ length: requestCount }, () => ({
      aspectRatio: apiAspectRatio,
      seed: seedFactory(),
      textInput: { structuredPrompt: { parts: [{ text: String(prompt || "").trim() }] } },
      videoModelKey: normalizeVideoModelKey("i2v", model, aspectRatio, { hasEndImage: true, duration: videoLength }),
      metadata: {},
      startImage: { mediaId: String(startMediaId || "").trim() },
      endImage: { mediaId: String(endMediaId || "").trim() }
    })),
    useV2ModelConfig: true
  };
}

export function buildVideoReferenceImagesBody({
  prompt,
  projectId,
  recaptchaToken,
  mediaIds = [],
  repeatCount = 1,
  model = "default",
  aspectRatio = "landscape",
  returnSilentVideos = true,
  batchId,
  sceneIdFactory = () => globalThis.crypto.randomUUID(),
  seedFactory = () => Math.floor(Math.random() * 2147483647)
}) {
  const refs = [...new Set(mediaIds.map((id) => String(id || "").trim()).filter(Boolean))];
  const requestCount = Math.max(1, Math.min(8, Number.parseInt(repeatCount, 10) || 1));
  const apiAspectRatio = normalizeVideoAspectRatio(aspectRatio);
  return {
    mediaGenerationContext: buildVideoMediaGenerationContext({ batchId, returnSilentVideos }),
    clientContext: buildClientContext({ projectId, recaptchaToken }),
    requests: Array.from({ length: requestCount }, () => ({
      aspectRatio: apiAspectRatio,
      seed: seedFactory(),
      textInput: { structuredPrompt: { parts: [{ text: String(prompt || "").trim() }] } },
      videoModelKey: normalizeVideoModelKey("r2v", model, aspectRatio),
      metadata: { sceneId: sceneIdFactory() },
      referenceImages: refs.map((mediaId) => ({
        mediaId,
        imageUsageType: "IMAGE_USAGE_TYPE_ASSET"
      }))
    })),
    useV2ModelConfig: true
  };
}

export function buildVideoStatusBody({ projectId, mediaIds = [] }) {
  return {
    media: mediaIds.map((name) => ({
      name: String(name || "").trim(),
      projectId: String(projectId || "").trim()
    }))
  };
}

export function buildUploadImageBody({
  projectId,
  imageBytes,
  mimeType = "image/png",
  fileName = "ref_image.png",
  isHidden = false
}) {
  return {
    clientContext: {
      projectId: String(projectId || "").trim(),
      tool: "PINHOLE"
    },
    imageBytes: String(imageBytes || "").replace(/\s+/g, ""),
    isUserUploaded: true,
    isHidden: isHidden === true,
    mimeType: String(mimeType || "image/png").trim().toLowerCase(),
    fileName: String(fileName || "ref_image.png").trim() || "ref_image.png"
  };
}

export function buildMediaRedirectUrl({
  mediaId,
  mediaUrlType = "",
  cacheBustKey = ""
}) {
  const params = new URLSearchParams();
  params.set("name", String(mediaId || "").trim());
  if (mediaUrlType) params.set("mediaUrlType", String(mediaUrlType).trim());
  if (cacheBustKey) params.set("_afcb", String(cacheBustKey));
  return `${webEndpointUrl(FlowWebEndpoint.mediaRedirect)}?${params.toString()}`;
}

export function buildMediaThumbnailUrl({ mediaId }) {
  return buildMediaRedirectUrl({
    mediaId,
    mediaUrlType: "MEDIA_URL_TYPE_THUMBNAIL"
  });
}

export function normalizeMediaRedirectUrl(url = "", fallbackMediaId = "") {
  const raw = String(url || "").trim();
  const fallback = String(fallbackMediaId || "").trim();
  if (!raw && fallback) return buildMediaRedirectUrl({ mediaId: fallback });
  if (!raw) return "";
  try {
    const parsed = new URL(raw, FLOW_WEB_ORIGIN);
    if (parsed.origin === FLOW_WEB_ORIGIN && parsed.pathname === FlowWebEndpoint.mediaRedirect) {
      const mediaId = String(parsed.searchParams.get("name") || fallback).trim();
      return mediaId ? buildMediaRedirectUrl({ mediaId }) : raw;
    }
  } catch {}
  return raw;
}

export function normalizeMediaThumbnailUrl(url = "", fallbackMediaId = "") {
  const raw = String(url || "").trim();
  const fallback = String(fallbackMediaId || "").trim();
  if (!raw && fallback) return buildMediaThumbnailUrl({ mediaId: fallback });
  if (!raw) return "";
  try {
    const parsed = new URL(raw, FLOW_WEB_ORIGIN);
    if (parsed.origin === FLOW_WEB_ORIGIN && parsed.pathname === FlowWebEndpoint.mediaRedirect) {
      const mediaId = String(parsed.searchParams.get("name") || fallback).trim();
      return mediaId ? buildMediaThumbnailUrl({ mediaId }) : raw;
    }
  } catch {}
  return raw;
}
