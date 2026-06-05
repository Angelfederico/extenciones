import {
  FlowEndpoint,
  buildMediaRedirectUrl,
  buildTextToImageBody,
  buildTextToVideoBody,
  buildUploadImageBody,
  buildVideoReferenceImagesBody,
  buildVideoStartAndEndImageBody,
  buildVideoStartImageBody,
  buildVideoStatusBody,
  endpointUrl
} from "../contracts/api.js";

function parseJsonText(text = "") {
  const cleaned = String(text || "").replace(/^\)\]\}',?\s*/, "").trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

export function extractMediaIds(data, { projectId = "", exclude = [] } = {}) {
  const out = new Set();
  const excluded = new Set(exclude.map((id) => String(id || "").trim().toLowerCase()).filter(Boolean));
  const projectIdLower = String(projectId || "").trim().toLowerCase();
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const add = (value) => {
    const id = String(value || "").trim();
    if (!uuidRe.test(id)) return;
    if (projectIdLower && id.toLowerCase() === projectIdLower) return;
    if (excluded.has(id.toLowerCase())) return;
    out.add(id);
  };

  const mediaRows = Array.isArray(data?.media) ? data.media : data?.media ? [data.media] : [];
  for (const media of mediaRows) add(media?.name);
  if (Array.isArray(data?.operations)) {
    for (const item of data.operations) {
      add(item?.operation?.metadata?.primaryMediaId);
      add(item?.operation?.response?.media?.name);
      add(item?.operation?.response?.mediaGenerationId);
      add(item?.mediaGenerationId);
      add(item?.operation?.name);
    }
  }
  if (Array.isArray(data?.workflows)) {
    for (const workflow of data.workflows) add(workflow?.metadata?.primaryMediaId);
  }
  return [...out];
}

async function readFlowResponse(response, options = {}) {
  const text = await response.text().catch(() => "");
  const data = parseJsonText(text);
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText || "",
    text,
    data,
    mediaIds: extractMediaIds(data, options)
  };
}

export function createFlowClient({ fetchImpl = fetch, tokenProvider, recaptchaProvider, idProvider = () => crypto.randomUUID() } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl is required");

  async function authHeaders() {
    const token = tokenProvider ? String(await tokenProvider()).trim() : "";
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  async function recaptcha(action, options = {}) {
    return recaptchaProvider ? String(await recaptchaProvider(action, options)).trim() : "";
  }

  async function postJson(endpoint, body, options = {}) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      mode: "cors",
      credentials: "include",
      headers: {
        ...(options.contentType === false ? {} : { "Content-Type": "text/plain;charset=UTF-8" }),
        ...(await authHeaders())
      },
      body: JSON.stringify(body)
    });
    return {
      endpoint,
      requestBody: body,
      ...(await readFlowResponse(response, options))
    };
  }

  return {
    async submitTextToImage(input) {
      const recaptchaToken = await recaptcha("IMAGE_GENERATION", { forceFresh: input.forceFreshRecaptcha === true, preferDirect: input.forceFreshRecaptcha === true });
      const body = buildTextToImageBody({
        ...input,
        recaptchaToken,
        batchId: input.batchId || idProvider()
      });
      return postJson(
        endpointUrl(FlowEndpoint.generateImages, { projectId: input.projectId }),
        body,
        { projectId: input.projectId, exclude: input.mediaIds || [] }
      );
    },

    async submitTextToVideo(input) {
      const recaptchaToken = await recaptcha("VIDEO_GENERATION", { forceFresh: input.forceFreshRecaptcha === true, preferDirect: input.forceFreshRecaptcha === true });
      const body = buildTextToVideoBody({
        ...input,
        recaptchaToken,
        batchId: input.batchId || idProvider()
      });
      return postJson(endpointUrl(FlowEndpoint.videoText), body, { projectId: input.projectId });
    },

    async submitVideoStartImage(input) {
      const recaptchaToken = await recaptcha("VIDEO_GENERATION", { forceFresh: input.forceFreshRecaptcha === true, preferDirect: input.forceFreshRecaptcha === true });
      const body = buildVideoStartImageBody({
        ...input,
        recaptchaToken,
        batchId: input.batchId || idProvider()
      });
      return postJson(endpointUrl(FlowEndpoint.videoStartImage), body, {
        projectId: input.projectId,
        exclude: [input.startMediaId]
      });
    },

    async submitVideoStartAndEndImage(input) {
      const recaptchaToken = await recaptcha("VIDEO_GENERATION", { forceFresh: input.forceFreshRecaptcha === true, preferDirect: input.forceFreshRecaptcha === true });
      const body = buildVideoStartAndEndImageBody({
        ...input,
        recaptchaToken,
        batchId: input.batchId || idProvider()
      });
      return postJson(endpointUrl(FlowEndpoint.videoStartAndEndImage), body, {
        projectId: input.projectId,
        exclude: [input.startMediaId, input.endMediaId]
      });
    },

    async submitVideoReferenceImages(input) {
      const recaptchaToken = await recaptcha("VIDEO_GENERATION", { forceFresh: input.forceFreshRecaptcha === true, preferDirect: input.forceFreshRecaptcha === true });
      const body = buildVideoReferenceImagesBody({
        ...input,
        recaptchaToken,
        batchId: input.batchId || idProvider(),
        sceneIdFactory: () => idProvider()
      });
      return postJson(endpointUrl(FlowEndpoint.videoReferenceImages), body, {
        projectId: input.projectId,
        exclude: input.mediaIds || []
      });
    },

    async pollVideoStatus({ projectId, mediaIds = [] } = {}) {
      const body = buildVideoStatusBody({ projectId, mediaIds });
      return postJson(endpointUrl(FlowEndpoint.videoStatus), body, { projectId });
    },

    async uploadImage(input) {
      const body = buildUploadImageBody(input);
      return postJson(endpointUrl(FlowEndpoint.uploadImage), body, {
        projectId: input.projectId
      });
    },

    mediaRedirectUrl(input) {
      return buildMediaRedirectUrl(input);
    }
  };
}
