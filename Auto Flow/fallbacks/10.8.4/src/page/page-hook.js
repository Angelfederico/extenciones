(function installAutoFlowRebuildPageHook() {
	  const SOURCE = "autoflow-1080-rebuild-v26";
	  const HOOK_VERSION = "10.8.4-launch-v105";
	  if (window.__afRebuildPageHookInstalled && window.__afRebuildPageHookVersion === HOOK_VERSION) return;
    if (typeof window.__afRebuildPageMessageHandler === "function") {
      window.removeEventListener("message", window.__afRebuildPageMessageHandler);
    }
	  window.__afRebuildPageHookInstalled = true;
	  window.__afRebuildPageHookVersion = HOOK_VERSION;

	  const originalFetch = window.__afRebuildNativeFetch || window.fetch;
    const OriginalXMLHttpRequest = window.__afRebuildNativeXMLHttpRequest || window.XMLHttpRequest;
	  window.__afRebuildNativeFetch = originalFetch;
    window.__afRebuildNativeXMLHttpRequest = OriginalXMLHttpRequest;
	  const domSubmitWaiters = [];
    const debuggerSubmitCaptures = new Map();

  function emit(payload) {
    // Auto-stamp tab identity so the SW's promoteFlowTabBinding always has a
    // Flow URL in extra.href, regardless of whether sender.tab.url is
    // populated by Chrome. Without this, page events arrive (e.g. the 8 in
    // user report 2026-05-02_053449Z-v1.md) but runtime stays unbound
    // because runtimeBindingPayload falls back to tab.url which is empty,
    // and isFlowToolUrl("") -> false. Single-source the stamp here so every
    // call site gets it without per-caller boilerplate.
    const stampedPayload = {
      ...(payload || {}),
      href: (payload && payload.href) || location.href,
      projectId: (payload && payload.projectId) || projectIdFromUrl(),
      emittedAt: (payload && payload.emittedAt) || new Date().toISOString()
    };
    window.postMessage(
      {
        source: SOURCE,
        type: "af.rebuild.page.event",
        payload: stampedPayload
      },
      "*"
    );
  }

  function projectIdFromUrl(url = location.href) {
    return String(url || "").match(/\/project\/([0-9a-f-]{36})/i)?.[1] || "";
  }

	  function compact(text = "") {
	    return String(text || "").replace(/\s+/g, " ").trim();
	  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function withAbortTimeout(ms = 2500) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    if (!controller) return { signal: undefined, cancel: () => {} };
    const timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {}
    }, Math.max(500, Number(ms || 2500)));
    return {
      signal: controller.signal,
      cancel: () => clearTimeout(timer)
    };
  }

  function parseExpiryMs(value, nowMs) {
    if (value === null || value === undefined || value === "") return 0;
    const asNum = Number(value);
    if (Number.isFinite(asNum)) {
      if (asNum > 10_000_000_000) return asNum;
      if (asNum > 1_000_000_000) return asNum * 1000;
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) && parsed > nowMs ? parsed : 0;
  }

  async function getAccessToken() {
    const now = Date.now();
    const cached = window.__afRebuildAccessTokenCache;
    if (
      cached &&
      typeof cached === "object" &&
      typeof cached.token === "string" &&
      cached.token &&
      Number(cached.expiresAt || 0) > now + 5000
    ) {
      return cached.token;
    }
    if (window.__afRebuildAccessTokenPromise) {
      return await window.__afRebuildAccessTokenPromise;
    }
    if (typeof window.refreshAccessToken !== "function") return "";
    window.__afRebuildAccessTokenPromise = (async () => {
      const tokenObj = await window.refreshAccessToken();
      if (!tokenObj) return "";

      let token = "";
      let expiresAt = 0;
      if (typeof tokenObj === "string") {
        token = tokenObj;
      } else {
        token = String(
          tokenObj.access_token || tokenObj.accessToken || tokenObj.token || ""
        ).trim();
        expiresAt = parseExpiryMs(tokenObj.expires, now);
      }
      if (token) {
        window.__afRebuildAccessTokenCache = {
          token,
          expiresAt: expiresAt > now ? expiresAt : now + 30000
        };
      }
      return token;
    })();
    try {
      return await window.__afRebuildAccessTokenPromise;
    } finally {
      window.__afRebuildAccessTokenPromise = null;
    }
  }

  async function getRecaptchaToken(action, options = {}) {
    const startedAt = Date.now();
    try {
      const recaptchaAction = String(action || "VIDEO_GENERATION").trim();
      const queue = window.__afRecaptchaTokenQueue;
      let source = "direct";
      let token = "";
      if (options.preferDirect !== true && queue && typeof queue.requestToken === "function") {
        source = "queue";
        token = String(
          await queue.requestToken("6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV", recaptchaAction)
        ).trim();
        emit({
          type: "flow_recaptcha",
          action: recaptchaAction,
          source,
          ok: Boolean(token),
          preferDirect: options.preferDirect === true,
          forceFresh: options.forceFresh === true,
          durationMs: Date.now() - startedAt
        });
        return token;
      }
      const grecaptcha = window.grecaptcha;
      if (!grecaptcha?.enterprise?.execute) return "";
      if (typeof grecaptcha.enterprise.ready === "function") {
        await new Promise((resolve) => grecaptcha.enterprise.ready(resolve));
      }
      token = String(
        await grecaptcha.enterprise.execute("6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV", {
          action: recaptchaAction
        })
      ).trim();
      emit({
        type: "flow_recaptcha",
        action: recaptchaAction,
        source,
        ok: Boolean(token),
        preferDirect: options.preferDirect === true,
        forceFresh: options.forceFresh === true,
        durationMs: Date.now() - startedAt
      });
      return token;
    } catch {
      emit({
        type: "flow_recaptcha",
        action: String(action || "VIDEO_GENERATION").trim(),
        source: options.preferDirect === true ? "direct" : "unknown",
        ok: false,
        preferDirect: options.preferDirect === true,
        forceFresh: options.forceFresh === true,
        durationMs: Date.now() - startedAt
      });
      return "";
    }
  }

  function allowedFlowFetchUrl(value = "") {
    try {
      const url = new URL(String(value || ""), location.href);
      if (url.origin === "https://aisandbox-pa.googleapis.com") return true;
      return url.origin === "https://labs.google" && url.pathname === "/fx/api/trpc/media.getMediaUrlRedirect";
    } catch {
      return false;
    }
  }

	  function requestHeadersObject(headers = {}) {
	    const out = {};
	    if (!headers || typeof headers !== "object") return out;
	    const entries = Array.isArray(headers) ? headers : Object.entries(headers);
	    for (const [key, value] of entries) {
	      const name = String(key || "").trim();
	      if (!name || /^authorization$/i.test(name) || /^cookie$/i.test(name)) continue;
	      out[name] = String(value);
	    }
	    return out;
	  }

	  function generationFetchCandidate(url = "", method = "GET") {
	    const text = String(url || "");
	    if (String(method || "GET").toUpperCase() !== "POST") return false;
	    if (!text.includes("aisandbox-pa.googleapis.com")) return false;
      if (/batchCheck|generationStatus|videoGenerationStatus/i.test(text)) return false;
	    return /batchAsyncGenerate|batchGenerateImages|generateImages|generateVideo/i.test(text);
	  }

  function generationStatusFetchCandidate(url = "", method = "GET") {
    const text = String(url || "");
    if (String(method || "GET").toUpperCase() !== "POST") return false;
    if (!text.includes("aisandbox-pa.googleapis.com")) return false;
    return /batchCheckAsyncVideoGenerationStatus|generationStatus|videoGenerationStatus/i.test(text);
  }

  function flowWorkflowFetchCandidate(url = "", method = "GET") {
    const text = String(url || "");
    if (String(method || "GET").toUpperCase() !== "GET") return false;
    if (!text.includes("aisandbox-pa.googleapis.com")) return false;
    return /\/v1\/flowWorkflows\/[0-9a-f-]{36}/i.test(text);
  }

  function mediaRedirectFetchCandidate(url = "", method = "GET") {
    const text = String(url || "");
    if (String(method || "GET").toUpperCase() !== "GET") return false;
    return /\/fx\/api\/trpc\/media\.getMediaUrlRedirect\?/i.test(text);
  }

  function generationEndpointKind(url = "") {
    const text = String(url || "");
    if (/generateImages|image:/i.test(text)) return "image";
    if (/batchCheck|generationStatus|videoGenerationStatus/i.test(text)) return "video_status";
    if (/\/v1\/flowWorkflows\//i.test(text)) return "video_workflow";
    if (/\/fx\/api\/trpc\/media\.getMediaUrlRedirect\?/i.test(text)) return "media_redirect";
    if (/generateVideo|batchAsyncGenerateVideo/i.test(text)) return "video";
    return "unknown";
  }

  function expectedEndpointKindForMode(mode = "") {
    return String(mode || "") === "text-to-image" ? "image" : "video";
  }

  function audioFailurePreferenceForTask(task = {}) {
    if (String(task.mode || "") === "text-to-image") return "";
    return task.returnSilentVideos === false || task.returnSilentVideos === "false"
      ? "BLOCK_SILENCED_VIDEOS"
      : "RETURN_SILENCED_VIDEOS";
  }

	  function safeJson(text = "") {
	    try {
	      return JSON.parse(String(text || ""));
	    } catch {
	      return null;
	    }
	  }

	  function normalizeMediaId(value = "") {
	    const raw = String(value || "").trim();
	    if (!raw) return "";
	    const uuid = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || "";
	    if (uuid) return uuid;
	    if (!/[/?#\s]/.test(raw) && /^[\w.-]{12,}$/.test(raw)) return raw;
	    return "";
	  }

	  function collectMediaIds(value, out = new Set()) {
	    if (value == null) return out;
	    if (typeof value === "string" || typeof value === "number") {
	      const normalized = normalizeMediaId(value);
	      if (normalized) out.add(normalized);
	      return out;
	    }
	    if (Array.isArray(value)) {
	      value.forEach((item) => collectMediaIds(item, out));
	      return out;
	    }
	    if (typeof value !== "object") return out;
	    for (const [key, nested] of Object.entries(value)) {
	      if (/^(name|mediaId|mediaIds|mediaName|mediaNames|mediaGenerationId|generationId|operationName)$/i.test(key)) {
	        collectMediaIds(nested, out);
	      } else if (nested && typeof nested === "object") {
	        collectMediaIds(nested, out);
	      }
	    }
	    return out;
	  }

  function collectWorkflowIds(value, out = new Set()) {
    if (value == null) return out;
    if (typeof value === "string" || typeof value === "number") {
      const normalized = normalizeMediaId(value);
      if (normalized) out.add(normalized);
      return out;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectWorkflowIds(item, out));
      return out;
    }
    if (typeof value !== "object") return out;
    for (const [key, nested] of Object.entries(value)) {
      if (/^(workflowId|workflowIds|flowWorkflowId|flowWorkflowName)$/i.test(key)) {
        collectWorkflowIds(nested, out);
      } else if (nested && typeof nested === "object") {
        collectWorkflowIds(nested, out);
      }
    }
    return out;
  }

  function collectGeneratedMediaIds(data) {
    const out = new Set();
    const add = (value) => {
      const id = normalizeMediaId(value);
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) out.add(id);
    };
    const mediaRows = Array.isArray(data?.media) ? data.media : data?.media ? [data.media] : [];
    mediaRows.forEach((media) => add(media?.name));
    if (Array.isArray(data?.operations)) {
      data.operations.forEach((item) => {
        add(item?.operation?.metadata?.primaryMediaId);
        add(item?.operation?.response?.media?.name);
        add(item?.operation?.response?.mediaGenerationId);
        add(item?.mediaGenerationId);
        add(item?.operation?.name);
      });
    }
    if (Array.isArray(data?.workflows)) {
      data.workflows.forEach((workflow) => add(workflow?.metadata?.primaryMediaId));
    }
    return [...out];
  }

  function normalizeFlowMediaStatus(status = "") {
    const raw = String(status || "").trim().toUpperCase();
    if (!raw) return "unknown";
    if (raw.includes("SUCCESSFUL") || raw === "COMPLETE" || raw === "COMPLETED") return "complete";
    if (raw.includes("FAILED") || raw.includes("REJECTED") || raw.includes("CANCELLED")) return "failed";
    if (raw.includes("PENDING") || raw.includes("RUNNING") || raw.includes("PROCESSING")) return "pending";
    return "unknown";
  }

  function collectFailureText(value, out = [], depth = 0, keyHint = "") {
    if (value == null || depth > 5) return out;
    const keyLooksRelevant = /error|fail|reason|message|status|detail|description|capacity|demand|busy/i.test(String(keyHint || ""));
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value || "").trim();
      if (text && keyLooksRelevant) out.push(text);
      return out;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => collectFailureText(entry, out, depth + 1, keyHint));
      return out;
    }
    if (typeof value !== "object") return out;
    for (const [key, child] of Object.entries(value)) {
      collectFailureText(child, out, depth + 1, key);
    }
    return out;
  }

  function failureTextForMedia(media = {}, rawStatus = "") {
    const parts = [
      ...collectFailureText(media?.mediaMetadata?.mediaStatus),
      ...collectFailureText(media?.mediaStatus),
      ...collectFailureText(media?.error, [], 0, "error"),
      ...collectFailureText(media?.failure, [], 0, "failure"),
      ...collectFailureText(media?.status, [], 0, "status"),
      String(rawStatus || "").trim()
    ].map((part) => String(part || "").trim()).filter(Boolean);
    return [...new Set(parts)].join(" ");
  }

  function extractVideoStatusRows(data) {
    const mediaRows = Array.isArray(data?.media) ? data.media : data?.media ? [data.media] : [];
    return mediaRows.map((media, index) => {
      const video = media?.video || media?.videoData || {};
      const metaVideo = media?.mediaMetadata?.videoData || {};
      const generated = video?.generatedVideo || metaVideo?.generatedVideo || {};
      const rawStatus =
        media?.mediaMetadata?.mediaStatus?.mediaGenerationStatus ||
        media?.mediaStatus?.mediaGenerationStatus ||
        "";
      const status = normalizeFlowMediaStatus(rawStatus);
      const failureText = status === "failed" ? failureTextForMedia(media, rawStatus) : "";
      return {
        id: normalizeMediaId(media?.name || "") || "",
        workflowId: normalizeMediaId(media?.workflowId || media?.mediaMetadata?.workflowId || "") || "",
        rawStatus,
        status,
        ...(failureText ? { failureText } : {}),
        model: String(generated.model || ""),
        aspectRatio: String(generated.aspectRatio || video.aspectRatio || metaVideo.aspectRatio || ""),
        mediaUrl: String(generated.fifeUri || generated.uri || generated.url || video.fifeUri || video.uri || video.url || media?.mediaData?.url || ""),
        thumbnailUrl: String(generated.thumbnailUri || generated.thumbnailUrl || video.thumbnailUri || video.thumbnailUrl || media?.thumbnailUrl || ""),
        mediaIndex: index
      };
    }).filter((row) => row.id || row.workflowId || row.rawStatus);
  }

  function extractPromptTexts(data, out = new Set()) {
    if (data == null) return out;
    if (typeof data === "string") return out;
    if (Array.isArray(data)) {
      data.forEach((item) => extractPromptTexts(item, out));
      return out;
    }
    if (typeof data !== "object") return out;
    for (const [key, value] of Object.entries(data)) {
      if (/^(prompt|textPrompt|userPrompt)$/i.test(key) && typeof value === "string" && compact(value)) {
        out.add(compact(value));
      } else if (value && typeof value === "object") {
        extractPromptTexts(value, out);
      }
    }
    return out;
  }

	  function emitFlowGenerationResponse({ url, method, status, ok, text, requestBodyText, elapsedMs = 0 }) {
	    const data = safeJson(text);
	    const endpointKind = generationEndpointKind(url);
	    const serializedRefs = domSubmitWaiters.length
	      ? verifySerializedRefs(requestBodyText, domSubmitWaiters[0]?.expectedSerializedRefs || [])
	      : null;
	    if (endpointKind === "media_redirect") {
	      let mediaId = "";
	      let mediaUrlType = "";
      try {
        const parsed = new URL(String(url || ""), location.href);
        mediaId = normalizeMediaId(parsed.searchParams.get("name") || "");
        mediaUrlType = String(parsed.searchParams.get("mediaUrlType") || "");
      } catch {}
      if (!mediaId) return;
		    emit({
	      type: "flow_generation_response",
	      endpointKind,
	      url: String(url || ""),
        method: String(method || "GET").toUpperCase(),
        status: Number(status || 0),
        ok: Boolean(ok),
        mediaIds: [mediaId],
        workflowIds: [],
        statusRows: [],
        prompts: [],
	        mediaUrlType,
	        responseBodyLength: String(text || "").length,
	        requestBodyLength: String(requestBodyText || "").length,
	        serializedRefs,
	        elapsedMs: Math.round(Number(elapsedMs || 0))
	      });
      return;
    }
    if (!data) return;
    const rawMediaIds = endpointKind === "video_status"
      ? extractVideoStatusRows(data).map((row) => row.id)
      : endpointKind === "video_workflow"
        ? Array.from(collectMediaIds(data))
        : collectGeneratedMediaIds(data);
    const mediaIds = [...new Set(rawMediaIds.map((id) => normalizeMediaId(id)).filter(Boolean))];
    const statusRows = endpointKind === "video_status" ? extractVideoStatusRows(data) : [];
    const workflowIds = [...new Set([
      ...Array.from(collectWorkflowIds(data)),
      ...statusRows.map((row) => row.workflowId)
    ].map((id) => normalizeMediaId(id)).filter(Boolean))];
    const prompts = [...new Set([
      ...Array.from(extractPromptTexts(safeJson(requestBodyText))),
      ...Array.from(extractPromptTexts(data))
    ].map((textValue) => compact(textValue)).filter(Boolean))];
    emit({
      type: "flow_generation_response",
      endpointKind,
      url: String(url || ""),
      method: String(method || "GET").toUpperCase(),
      status: Number(status || 0),
      ok: Boolean(ok),
      mediaIds,
      workflowIds,
      statusRows,
	      prompts,
	      responseBodyLength: String(text || "").length,
	      requestBodyLength: String(requestBodyText || "").length,
	      serializedRefs,
	      elapsedMs: Math.round(Number(elapsedMs || 0))
	    });
	  }

  async function readFetchBodyText(input, init) {
    try {
      const body = init?.body;
      if (typeof body === "string") return body;
      if (body instanceof URLSearchParams) return body.toString();
      if (body instanceof Blob) return await body.text();
      if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
      if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
      if (!body && typeof Request !== "undefined" && input instanceof Request) {
        return await input.clone().text();
      }
    } catch {}
    return "";
  }

  function rebuildTextResponse(response, text = "") {
    try {
      return new Response(String(text || ""), {
        status: response?.status || 200,
        statusText: response?.statusText || "",
        headers: response?.headers || undefined
      });
    } catch {
      return response;
    }
  }

  function rewriteVideoGenerationBody(input, init, requestBodyText = "", audioFailurePreference = "") {
    const preference = String(audioFailurePreference || "").trim();
    if (!preference || !requestBodyText) return { input, init, requestBodyText, rewritten: false };
    const data = safeJson(requestBodyText);
    if (!data || typeof data !== "object" || Array.isArray(data)) return { input, init, requestBodyText, rewritten: false };
    data.mediaGenerationContext = {
      ...(data.mediaGenerationContext && typeof data.mediaGenerationContext === "object" ? data.mediaGenerationContext : {}),
      audioFailurePreference: preference
    };
    const nextBodyText = JSON.stringify(data);
    if (init && Object.prototype.hasOwnProperty.call(init, "body")) {
      return {
        input,
        init: { ...init, body: nextBodyText },
        requestBodyText: nextBodyText,
        rewritten: true
      };
    }
    if (typeof Request !== "undefined" && input instanceof Request) {
      try {
        return {
          input: new Request(input, { body: nextBodyText }),
          init,
          requestBodyText: nextBodyText,
          rewritten: true
        };
      } catch {}
    }
    return { input, init, requestBodyText, rewritten: false };
  }

	  function refSerializationVariants(value = "") {
	    const raw = String(value || "").trim();
	    if (!raw) return [];
	    const withoutPrefix = raw.replace(/^fe_id_/i, "");
	    const withPrefix = /^fe_id_/i.test(raw) ? raw : `fe_id_${raw}`;
	    return [...new Set([raw, withoutPrefix, withPrefix].filter(Boolean))];
	  }

	  function requestBodyRefSummary(requestBodyText = "") {
	    const data = safeJson(requestBodyText);
	    const summary = {
	      imageInputs: [],
	      referenceImages: [],
	      startImages: [],
	      endImages: [],
	      uuidLikeValues: []
	    };
	    const seenValues = new Set();
	    const pushValue = (bucket, value = "") => {
	      const text = String(value || "").trim();
	      if (!text) return;
	      const normalized = text.replace(/^fe_id_/i, "");
	      const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized);
	      if (bucket !== "uuidLikeValues" && !summary[bucket].includes(text)) summary[bucket].push(text);
	      if (uuidLike && !seenValues.has(text)) {
	        seenValues.add(text);
	        summary.uuidLikeValues.push(text);
	      }
	    };
	    const visit = (node, key = "", depth = 0) => {
	      if (!node || depth > 14) return;
	      if (typeof node === "string") {
	        pushValue("uuidLikeValues", node);
	        return;
	      }
	      if (Array.isArray(node)) {
	        for (const item of node) visit(item, key, depth + 1);
	        return;
	      }
	      if (typeof node !== "object") return;
	      if (key === "imageInputs") {
	        for (const item of Array.isArray(node) ? node : [node]) {
	          if (!item || typeof item !== "object") continue;
	          pushValue("imageInputs", item.name || item.mediaId || item.imageId || item.id || "");
	        }
	      }
	      if (key === "referenceImages") {
	        for (const item of Array.isArray(node) ? node : [node]) {
	          if (!item || typeof item !== "object") continue;
	          pushValue("referenceImages", item.mediaId || item.name || item.imageId || item.id || "");
	        }
	      }
	      if (key === "startImage") pushValue("startImages", node.mediaId || node.name || node.imageId || node.id || "");
	      if (key === "endImage") pushValue("endImages", node.mediaId || node.name || node.imageId || node.id || "");
	      for (const [childKey, value] of Object.entries(node)) {
	        if (childKey === "imageInputs" && Array.isArray(value)) {
	          for (const item of value) {
	            if (item && typeof item === "object") pushValue("imageInputs", item.name || item.mediaId || item.imageId || item.id || "");
	          }
	        } else if (childKey === "referenceImages" && Array.isArray(value)) {
	          for (const item of value) {
	            if (item && typeof item === "object") pushValue("referenceImages", item.mediaId || item.name || item.imageId || item.id || "");
	          }
	        } else if (childKey === "startImage" && value && typeof value === "object") {
	          pushValue("startImages", value.mediaId || value.name || value.imageId || value.id || "");
	        } else if (childKey === "endImage" && value && typeof value === "object") {
	          pushValue("endImages", value.mediaId || value.name || value.imageId || value.id || "");
	        }
	        visit(value, childKey, depth + 1);
	      }
	    };
	    visit(data);
	    return {
	      imageInputs: summary.imageInputs.slice(0, 20),
	      referenceImages: summary.referenceImages.slice(0, 20),
	      startImages: summary.startImages.slice(0, 8),
	      endImages: summary.endImages.slice(0, 8),
	      uuidLikeValues: summary.uuidLikeValues.slice(0, 40)
	    };
	  }

	  function verifySerializedRefs(requestBodyText = "", expectedRefs = [], expectedMode = "") {
	    const refs = [...new Set((expectedRefs || []).map((id) => String(id || "").trim()).filter(Boolean))];
	    if (!refs.length) return { ok: true, expected: [], missing: [] };
	    const body = String(requestBodyText || "");
	    if (!body) {
	      return { ok: false, expected: refs, missing: refs, reason: "request_body_not_captured" };
	    }
	    const observed = requestBodyRefSummary(body);
	    const missing = refs.filter((id) => !refSerializationVariants(id).some((variant) => body.includes(variant)));
	    const acceptedByImageInputCount = String(expectedMode || "") === "text-to-image"
	      && observed.imageInputs.length >= refs.length;
	    const acceptedByReferenceImageCount = String(expectedMode || "") === "ingredients-to-video"
	      && observed.referenceImages.length >= refs.length;
	    return {
	      ok: missing.length === 0 || acceptedByImageInputCount || acceptedByReferenceImageCount,
	      expected: refs,
	      missing,
	      bodyLength: body.length,
	      hasImageInputs: body.includes("imageInputs"),
	      hasStartImage: body.includes("startImage"),
	      hasReferenceImages: body.includes("referenceImages"),
	      acceptedByImageInputCount,
	      acceptedByReferenceImageCount,
	      observed
	    };
	  }

  function removeDomSubmitWaiter(waiter) {
    const index = domSubmitWaiters.indexOf(waiter);
    if (index >= 0) domSubmitWaiters.splice(index, 1);
  }

  function clearDomSubmitWaiterTimers(waiter) {
    clearTimeout(waiter?.timer);
    clearTimeout(waiter?.settleTimer);
  }

  function finalizeDomSubmitWaiter(waiter, result = {}) {
    if (!waiter || waiter.done) return;
    waiter.done = true;
    clearDomSubmitWaiterTimers(waiter);
    removeDomSubmitWaiter(waiter);
    waiter.resolve(result);
  }

  function domSubmitExpectedMediaCount(task = {}) {
    const raw = Number.parseInt(
      task.expectedVideos || task.expectedImages || task.repeatCount || task.imageRepeatCount || 1,
      10
    );
    if (!Number.isFinite(raw) || raw <= 1) return 1;
    return Math.max(1, Math.min(8, raw));
  }

  function scheduleDomSubmitSettle(waiter) {
    clearTimeout(waiter.settleTimer);
    waiter.settleTimer = setTimeout(() => {
      const mediaIds = [...waiter.mediaIds];
      const textToImageAcceptedWithoutMediaIds = String(waiter.expectedMode || "") === "text-to-image"
        && Number(waiter.lastStatus || 0) >= 200
        && Number(waiter.lastStatus || 0) < 300
        && waiter.serializedRefs?.ok === true;
      const ok = mediaIds.length > 0 || textToImageAcceptedWithoutMediaIds;
      finalizeDomSubmitWaiter(waiter, {
        ok,
        status: waiter.lastStatus || 0,
        endpoint: waiter.lastEndpoint || "",
        mediaIds,
        error: ok ? "" : "DOM_SUBMIT_MEDIA_IDS_NOT_CAPTURED",
        serializedRefs: waiter.serializedRefs,
        textToImageAcceptedWithoutMediaIds,
        expectedMediaIdCount: waiter.expectedMediaIdCount,
        capturedResponseCount: waiter.responses.length,
        partialMediaCapture: mediaIds.length > 0 && mediaIds.length < waiter.expectedMediaIdCount,
        responses: waiter.responses
      });
    }, waiter.settleMs);
  }

  function domSubmitRequestTimeoutMs(task = {}) {
    const mode = String(task.mode || "");
    if (mode === "text-to-image") return 120000;
    if (mode === "text-to-video") return 90000;
    return 45000;
  }

  function domSubmitNoRequestTimeoutMs(task = {}) {
    const mode = String(task.mode || "");
    if (mode === "text-to-image" || mode === "text-to-video") return 45000;
    return 15000;
  }

  function markDomSubmitRequestStarted(waiter, url = "") {
    if (!waiter || waiter.done) return;
    waiter.requestStarted = true;
    waiter.lastEndpoint = String(url || "");
    clearTimeout(waiter.timer);
    waiter.timer = setTimeout(() => {
      finalizeDomSubmitWaiter(waiter, {
        ok: false,
        status: waiter.lastStatus || 0,
        endpoint: waiter.lastEndpoint || "",
        mediaIds: [...waiter.mediaIds],
        error: "DOM_SUBMIT_RESPONSE_TIMEOUT",
        expectedMediaIdCount: waiter.expectedMediaIdCount,
        capturedResponseCount: waiter.responses.length,
        partialMediaCapture: waiter.mediaIds.size > 0,
        responses: waiter.responses
      });
    }, Math.max(5000, Number(waiter.responseTimeoutMs || 90000)));
  }

	  function createDomSubmitCapture(timeoutMs = 15000, expectedSerializedRefs = [], expectedMode = "", audioFailurePreference = "", expectedMediaIdCount = 1, responseTimeoutMs = 90000) {
	    let waiter;
	    const promise = new Promise((resolve) => {
	      waiter = {
          expectedSerializedRefs: [...new Set((expectedSerializedRefs || []).map((id) => String(id || "").trim()).filter(Boolean))],
          expectedMode: String(expectedMode || ""),
          audioFailurePreference: String(audioFailurePreference || ""),
          expectedMediaIdCount: Math.max(1, Number.parseInt(expectedMediaIdCount, 10) || 1),
          responseTimeoutMs: Math.max(5000, Number(responseTimeoutMs || 90000)),
          requestStarted: false,
          mediaIds: new Set(),
          responses: [],
          serializedRefs: null,
          settleMs: 2500,
	        resolve,
	        timer: setTimeout(() => {
            finalizeDomSubmitWaiter(waiter, {
	            ok: false,
	            error: waiter.requestStarted ? "DOM_SUBMIT_RESPONSE_TIMEOUT" : "DOM_SUBMIT_REQUEST_NOT_OBSERVED",
	            mediaIds: [...waiter.mediaIds],
              expectedMediaIdCount: waiter.expectedMediaIdCount,
              capturedResponseCount: waiter.responses.length,
              partialMediaCapture: waiter.mediaIds.size > 0,
              responses: waiter.responses
	          });
	        }, Math.max(1000, Number(timeoutMs || 15000)))
	      };
	      domSubmitWaiters.push(waiter);
	    });
	    return {
	      promise,
	      cancel() {
	        if (!waiter) return;
	        clearDomSubmitWaiterTimers(waiter);
	        removeDomSubmitWaiter(waiter);
	      }
	    };
	  }

  function taskCurrentSerializedRefs(task = {}) {
    const store = resolvePromptStore();
    if (!store) return [];
    const mode = String(task.mode || "");
    const ingredients = Array.isArray(store.getState()?.ingredients) ? store.getState().ingredients : [];
    const ids = ingredients
      .map((ingredient) => String(ingredient?.imageId || "").trim())
      .filter(Boolean);
    if (mode === "text-to-image") return ids;
    if (["image-to-video", "start-end-image-to-video", "ingredients-to-video"].includes(mode)) return ids;
    return [];
  }

  function armDebuggerSubmitCapture(task = {}, meta = {}) {
    const fallbackId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
    const captureId = String(meta.captureId || task.id || fallbackId).trim();
    if (!captureId) return { ok: false, error: "CAPTURE_ID_EMPTY" };
    const existing = debuggerSubmitCaptures.get(captureId);
    if (existing?.capture?.cancel) existing.capture.cancel();
    const expectedSerializedRefs = Array.isArray(meta.expectedSerializedRefs)
      ? meta.expectedSerializedRefs
      : taskCurrentSerializedRefs(task);
    const capture = createDomSubmitCapture(
      Number(meta.noRequestTimeoutMs || meta.timeoutMs || domSubmitNoRequestTimeoutMs(task)),
      expectedSerializedRefs,
      String(task.mode || ""),
      audioFailurePreferenceForTask(task),
      domSubmitExpectedMediaCount(task),
      Number(meta.responseTimeoutMs || domSubmitRequestTimeoutMs(task))
    );
    const record = {
      capture,
      createdAt: Date.now(),
      promise: capture.promise.finally(() => {
        debuggerSubmitCaptures.delete(captureId);
      })
    };
    debuggerSubmitCaptures.set(captureId, record);
    return {
      ok: true,
      action: "domArmDebuggerSubmitCapture",
      captureId,
      expectedSerializedRefs,
      expectedMediaIdCount: domSubmitExpectedMediaCount(task)
    };
  }

  async function awaitDebuggerSubmitCapture(task = {}, meta = {}) {
    const captureId = String(meta.captureId || task.id || "").trim();
    const record = debuggerSubmitCaptures.get(captureId);
    if (!record) {
      return { ok: false, action: "domAwaitDebuggerSubmitCapture", error: "CAPTURE_NOT_FOUND", captureId };
    }
    const result = await record.promise;
    return {
      action: "domAwaitDebuggerSubmitCapture",
      captureId,
      ...result
    };
  }

	  function resolveDomSubmitWaiterFromFetch({ url, method, status, ok, text, requestBodyText }) {
	    if (!domSubmitWaiters.length || !generationFetchCandidate(url, method)) return;
	    const waiter = domSubmitWaiters[0];
      if (!waiter || waiter.done) return;
	    const data = safeJson(text);
    const endpointKind = generationEndpointKind(url);
    const expectedEndpointKind = expectedEndpointKindForMode(waiter.expectedMode);
    if (expectedEndpointKind !== "unknown" && endpointKind !== "unknown" && endpointKind !== expectedEndpointKind) {
      finalizeDomSubmitWaiter(waiter, {
        ok: false,
        status,
        endpoint: String(url || ""),
        endpointKind,
        expectedEndpointKind,
        mediaIds: [],
        error: "DOM_SUBMIT_WRONG_ENDPOINT_FOR_MODE",
        data
      });
      return;
    }
	    const excludedIds = waiter.expectedSerializedRefs || [];
	    const mediaIds = collectGeneratedMediaIds(data).filter((id) => !excludedIds.some((excluded) => idsMatch(id, excluded)));
    const serializedRefs = verifySerializedRefs(requestBodyText, waiter.expectedSerializedRefs || [], waiter.expectedMode);
    if (!serializedRefs.ok) {
      finalizeDomSubmitWaiter(waiter, {
        ok: false,
        status,
        endpoint: String(url || ""),
        mediaIds: [],
        error: "REF_NOT_SERIALIZED",
        serializedRefs,
        data
      });
      return;
    }
      waiter.serializedRefs = serializedRefs;
      waiter.lastStatus = status;
      waiter.lastEndpoint = String(url || "");
      mediaIds.forEach((id) => waiter.mediaIds.add(id));
      waiter.responses.push({
        status,
        ok: Boolean(ok),
        endpoint: String(url || ""),
        endpointKind,
        mediaIds
      });
      if (!ok) {
        scheduleDomSubmitSettle(waiter);
        return;
      }
      if (waiter.mediaIds.size >= waiter.expectedMediaIdCount) {
        finalizeDomSubmitWaiter(waiter, {
          ok: true,
          status,
          endpoint: String(url || ""),
          mediaIds: [...waiter.mediaIds],
      serializedRefs,
          expectedMediaIdCount: waiter.expectedMediaIdCount,
          capturedResponseCount: waiter.responses.length,
          partialMediaCapture: false,
          responses: waiter.responses,
          data
        });
        return;
      }
      scheduleDomSubmitSettle(waiter);
	  }

  async function flowFetch(request = {}) {
    const url = String(request.url || "");
    if (!allowedFlowFetchUrl(url)) {
      return { ok: false, status: 0, error: "blocked_flow_fetch_url" };
    }
    const token = await getAccessToken();
    if (!token) {
      return { ok: false, status: 0, error: "missing_access_token" };
    }
    const fetchImpl = window.__afRebuildNativeFetch || originalFetch || window.fetch;
    const response = await fetchImpl.call(window, url, {
      method: String(request.method || "GET").toUpperCase(),
      mode: String(request.mode || "cors"),
      credentials: String(request.credentials || "include"),
      headers: {
        ...requestHeadersObject(request.headers),
        authorization: `Bearer ${token}`
      },
      body: request.body === undefined ? undefined : String(request.body)
    });
    const text = await response.text().catch(() => "");
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText || "",
      text
    };
  }

  function mediaRedirectUrl(mediaId = "", options = {}) {
    const params = new URLSearchParams();
    params.set("name", String(mediaId || "").trim());
    if (options.mediaUrlType) params.set("mediaUrlType", String(options.mediaUrlType));
    if (options.cacheBustKey) params.set("_afcb", String(options.cacheBustKey));
    return `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?${params.toString()}`;
  }

  function uuidLike(value = "") {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || "").trim());
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }

  function detectImageFormat(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (view.length >= 8 && view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4e && view[3] === 0x47) {
      return { format: "png", mimeType: "image/png" };
    }
    if (view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) {
      return { format: "jpeg", mimeType: "image/jpeg" };
    }
    return null;
  }

  function extractEncodedImageString(payload) {
    if (!payload || typeof payload !== "object") return "";
    const queue = [payload];
    const seen = new Set();
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      const candidates = [node.encodedImage, node.imageBytes, node.base64, node.bytesBase64];
      for (const candidate of candidates) {
        const raw = String(candidate || "").trim();
        if (raw) return raw;
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") queue.push(value);
      }
    }
    return "";
  }

  function normalizeUpscaledImagePayload(buffer) {
    const bytes = new Uint8Array(buffer || []);
    const direct = detectImageFormat(bytes);
    if (direct) {
      return {
        ok: true,
        responseFormat: "binary",
        mimeType: direct.mimeType,
        byteLength: bytes.length,
        dataUrl: `data:${direct.mimeType};base64,${arrayBufferToBase64(bytes)}`
      };
    }
    try {
      const text = new TextDecoder("utf-8").decode(bytes).trim();
      const parsed = text && (text.startsWith("{") || text.startsWith("[")) ? JSON.parse(text) : null;
      const encoded = extractEncodedImageString(parsed);
      if (!encoded) return { ok: false, error: "missing_encoded_image" };
      const encodedBase64 = encoded.startsWith("data:")
        ? String(encoded.match(/^data:[^;,]+;base64,(.+)$/is)?.[1] || "").trim()
        : encoded;
      const binary = atob(encodedBase64);
      const decoded = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) decoded[index] = binary.charCodeAt(index);
      const wrapped = detectImageFormat(decoded);
      if (!wrapped) return { ok: false, error: "unknown_image_signature" };
      return {
        ok: true,
        responseFormat: "json_base64",
        mimeType: wrapped.mimeType,
        byteLength: decoded.length,
        dataUrl: `data:${wrapped.mimeType};base64,${arrayBufferToBase64(decoded)}`
      };
    } catch (error) {
      return { ok: false, error: String(error?.message || error || "image_payload_decode_failed") };
    }
  }

  async function fetchMediaDataUrl(url = "", fallbackMimeType = "application/octet-stream") {
    const mediaUrl = String(url || "").trim();
    if (!mediaUrl) return { ok: false, error: "missing_media_url" };
    const fetchImpl = window.__afRebuildNativeFetch || originalFetch || window.fetch;
    const response = await fetchImpl.call(window, mediaUrl, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store"
    });
    const buffer = await response.arrayBuffer().catch(() => null);
    if (!response.ok) {
      let text = "";
      try {
        text = buffer ? new TextDecoder("utf-8").decode(buffer) : "";
      } catch {}
      return { ok: false, error: `http_${response.status}:${text.slice(0, 200)}` };
    }
    const byteLength = Number(buffer?.byteLength || 0);
    if (!byteLength) return { ok: false, error: "empty_media_bytes" };
    const mimeType = String(response.headers.get("content-type") || fallbackMimeType || "application/octet-stream")
      .split(";")[0]
      .trim() || fallbackMimeType;
    return {
      ok: true,
      byteLength,
      mimeType,
      dataUrl: `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`
    };
  }

  function firstString(candidates = []) {
    for (const candidate of candidates) {
      const value = String(candidate || "").trim();
      if (value) return value;
    }
    return "";
  }

  function firstNumber(candidates = []) {
    for (const candidate of candidates) {
      const value = Number(candidate);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
  }

  function normalizeVideoAspect(width = 0, height = 0, explicit = "") {
    const raw = String(explicit || "").trim().toLowerCase();
    if (raw.includes("portrait") || raw === "9:16") return "portrait";
    if (raw.includes("landscape") || raw === "16:9") return "landscape";
    const w = Number(width || 0);
    const h = Number(height || 0);
    if (w > 0 && h > 0) return h > w ? "portrait" : "landscape";
    return "";
  }

  function looksLikeMp4Bytes(bytes = new Uint8Array()) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (view.length < 12) return false;
    for (let index = 4; index <= Math.min(view.length - 4, 32); index += 1) {
      if (view[index] === 0x66 && view[index + 1] === 0x74 && view[index + 2] === 0x79 && view[index + 3] === 0x70) {
        return true;
      }
    }
    return false;
  }

  async function validateVideoRenditionUrl(url = "", options = {}) {
    const target = String(url || "").trim();
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: "invalid_video_url" };
    const fetchImpl = window.__afRebuildNativeFetch || originalFetch || window.fetch;
    const attempts = Math.max(1, Math.min(6, Number(options.attempts || 3) || 3));
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchImpl.call(window, target, {
          method: "GET",
          mode: "cors",
          credentials: "include",
          cache: "no-store",
          headers: {
            "Cache-Control": "no-store",
            Pragma: "no-cache",
            Range: "bytes=0-65535"
          }
        });
        const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer || []);
        if (!response.ok && response.status !== 206) {
          last = { ok: false, error: `http_${response.status}`, contentType, byteLength: bytes.length, attempt };
        } else if (bytes.length < 16 * 1024) {
          last = { ok: false, error: `video_rendition_too_small:${bytes.length}`, contentType, byteLength: bytes.length, attempt };
        } else if (!contentType.includes("video") && !looksLikeMp4Bytes(bytes)) {
          last = { ok: false, error: "video_rendition_not_mp4", contentType, byteLength: bytes.length, attempt };
        } else {
          return { ok: true, contentType, byteLength: bytes.length, attempt };
        }
      } catch (error) {
        last = { ok: false, error: String(error?.message || error || "video_rendition_probe_failed"), attempt };
      }
      if (attempt < attempts && /too_small|http_404|http_403|http_5/i.test(String(last?.error || ""))) {
        await sleep(1800 * attempt);
        continue;
      }
      break;
    }
    return last || { ok: false, error: "video_rendition_probe_failed" };
  }

  async function resolveVideoRendition({ mediaId = "", aspectRatio = "" } = {}) {
    const sourceMediaId = String(mediaId || "").trim();
    const projectId = projectIdFromUrl();
    if (!uuidLike(sourceMediaId)) return { ok: false, error: "missing_media_id" };
    if (!projectId) return { ok: false, error: "missing_project_id" };
    const payload = unwrapProjectData(await fetchProjectInitialData(projectId));
    const contents = payload?.projectContents || {};
    const mediaRows = Array.isArray(contents.media) ? contents.media : Object.values(contents.media || {});
    const media = mediaRows.find((row) => {
      const name = String(row?.name || row?.mediaId || "").trim();
      return name === sourceMediaId || name.endsWith(`/${sourceMediaId}`);
    });
    if (!media) return { ok: false, error: "media_not_found_in_project_data", mediaId: sourceMediaId, projectId };

    const video = media?.video || media?.videoData || {};
    const meta = media?.mediaMetadata || {};
    const generated = video?.generatedVideo || meta?.videoData?.generatedVideo || {};
    const width = firstNumber([
      generated.widthPixels,
      generated.width,
      video.widthPixels,
      video.width,
      meta?.videoData?.widthPixels,
      media.width
    ]);
    const height = firstNumber([
      generated.heightPixels,
      generated.height,
      video.heightPixels,
      video.height,
      meta?.videoData?.heightPixels,
      media.height
    ]);
    const normalizedAspect = normalizeVideoAspect(width, height, firstString([
      generated.aspectRatio,
      video.aspectRatio,
      meta?.videoData?.aspectRatio,
      media.aspectRatio
    ]));
    const desiredAspect = String(aspectRatio || "").trim().toLowerCase();
    const rawCandidates = [
      ["generated_video_fife_uri", generated.fifeUri],
      ["generated_video_uri", generated.uri],
      ["generated_video_url", generated.url],
      ["video_fife_uri", video.fifeUri],
      ["video_uri", video.uri],
      ["video_url", video.url],
      ["meta_video_fife_uri", meta?.videoData?.fifeUri],
      ["meta_video_url", meta?.videoData?.url],
      ["media_data_url", media?.mediaData?.url],
      ["generated_media_url", media?.generatedMedia?.url]
    ];
    const candidates = rawCandidates
      .map(([source, url]) => ({ source, url: String(url || "").trim(), width, height, aspectRatio: normalizedAspect }))
      .filter((candidate) => /^https?:\/\//i.test(candidate.url));
    candidates.push({
      source: "redirect_fallback",
      url: mediaRedirectUrl(sourceMediaId),
      width,
      height,
      aspectRatio: normalizedAspect
    });
    const scored = candidates
      .map((candidate) => {
        const url = candidate.url.toLowerCase();
        let score = 0;
        if (!url.includes("getmediaurlredirect")) score += 50;
        if (/storage\.googleapis\.com|googleusercontent\.com|googlevideo\.com|gvt1\.com/.test(url)) score += 25;
        if (candidate.source.includes("generated_video")) score += 20;
        if (candidate.source.includes("video")) score += 10;
        if (desiredAspect && candidate.aspectRatio === desiredAspect) score += 40;
        if (desiredAspect && candidate.aspectRatio && candidate.aspectRatio !== desiredAspect) score -= 20;
        return { ...candidate, score };
      })
      .sort((a, b) => b.score - a.score);
    let selected = null;
    const rejected = [];
    for (const candidate of scored) {
      const probe = await validateVideoRenditionUrl(candidate.url, { attempts: 4 });
      if (probe.ok) {
        selected = { ...candidate, probe };
        break;
      }
      rejected.push({
        source: candidate.source,
        score: candidate.score,
        error: probe.error || "video_rendition_probe_failed",
        contentType: probe.contentType || "",
        byteLength: Number(probe.byteLength || 0),
        isRedirect: candidate.url.includes("getMediaUrlRedirect")
      });
    }
    if (!selected?.url) return { ok: false, error: "missing_video_rendition_url", mediaId: sourceMediaId, projectId };
    return {
      ok: true,
      mediaId: sourceMediaId,
      projectId,
      url: selected.url,
      urlSource: selected.source,
      width,
      height,
      aspectRatio: normalizedAspect,
      candidateCount: scored.length,
      probe: selected.probe || null,
      rejectedCandidates: rejected.slice(0, 6),
      candidates: scored.slice(0, 6).map((candidate) => ({
        source: candidate.source,
        score: candidate.score,
        isRedirect: candidate.url.includes("getMediaUrlRedirect")
      }))
    };
  }

  async function upscaleImage({ mediaId = "", resolution = "2k", projectId = "" } = {}) {
    const sourceMediaId = String(mediaId || "").trim();
    const targetProjectId = String(projectId || projectIdFromUrl() || "").trim();
    const normalizedResolution = String(resolution || "").trim().toLowerCase() === "4k" ? "4k" : "2k";
    const targetResolution = normalizedResolution === "4k"
      ? "UPSAMPLE_IMAGE_RESOLUTION_4K"
      : "UPSAMPLE_IMAGE_RESOLUTION_2K";
    if (!uuidLike(sourceMediaId)) return { ok: false, error: "missing_media_id" };
    if (!targetProjectId) return { ok: false, error: "missing_project_id" };
    const token = await getAccessToken();
    if (!token) return { ok: false, error: "missing_access_token" };
    const recaptchaToken = await getRecaptchaToken("IMAGE_GENERATION");
    if (!recaptchaToken) return { ok: false, error: "missing_recaptcha_token" };
    const endpoint = "https://aisandbox-pa.googleapis.com/v1/flow/upsampleImage";
    const fetchImpl = window.__afRebuildNativeFetch || originalFetch || window.fetch;
    const response = await fetchImpl.call(window, endpoint, {
      method: "POST",
      mode: "cors",
      credentials: "include",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        mediaId: sourceMediaId,
        targetResolution,
        clientContext: {
          projectId: targetProjectId,
          tool: "PINHOLE",
          userPaygateTier: "PAYGATE_TIER_TWO",
          sessionId: `;${Date.now()}`,
          recaptchaContext: {
            token: recaptchaToken,
            applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB"
          }
        }
      })
    });
    const buffer = await response.arrayBuffer().catch(() => null);
    if (!response.ok) {
      let text = "";
      try {
        text = buffer ? new TextDecoder("utf-8").decode(buffer) : "";
      } catch {}
      return { ok: false, error: `http_${response.status}:${text.slice(0, 200)}`, endpoint, targetResolution };
    }
    const byteLength = Number(buffer?.byteLength || 0);
    if (!byteLength) return { ok: false, error: "empty_upscaled_image", endpoint, targetResolution };
    const decoded = normalizeUpscaledImagePayload(buffer);
    if (!decoded.ok) return { ok: false, error: decoded.error || "upscaled_image_decode_failed", endpoint, targetResolution };
    return {
      ok: true,
      endpoint,
      mediaId: sourceMediaId,
      resolution: normalizedResolution,
      targetResolution,
      responseFormat: decoded.responseFormat,
      byteLength: decoded.byteLength,
      mimeType: decoded.mimeType,
      dataUrl: decoded.dataUrl
    };
  }

  async function fetchProjectInitialData(projectId = "") {
    const input = encodeURIComponent(JSON.stringify({ json: { projectId: String(projectId || "").trim() } }));
    const response = await (window.__afRebuildNativeFetch || originalFetch || window.fetch).call(
      window,
      `/fx/api/trpc/flow.projectInitialData?input=${input}&af_upscale_ts=${Date.now()}`,
      { method: "GET", cache: "no-store", credentials: "same-origin", headers: { accept: "application/json, text/plain, */*" } }
    );
    if (!response.ok) return null;
    return response.json().catch(() => null);
  }

  function unwrapProjectData(raw) {
    const queue = [raw];
    const seen = new Set();
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      const candidate = node.projectContents ? node : node.data;
      if (candidate?.projectContents) return candidate;
      if (node.json) queue.push(node.json);
      if (node.result) queue.push(node.result);
      if (node.data) queue.push(node.data);
      if (Array.isArray(node)) queue.push(...node);
    }
    return null;
  }

  async function workflowIdForMedia(projectId = "", mediaId = "") {
    const payload = unwrapProjectData(await fetchProjectInitialData(projectId));
    const contents = payload?.projectContents || {};
    const mediaItems = Array.isArray(contents.media) ? contents.media : Object.values(contents.media || {});
    const workflows = Array.isArray(contents.workflows) ? contents.workflows : Object.values(contents.workflows || {});
    for (const item of mediaItems) {
      if (String(item?.name || "").trim() === mediaId && item?.workflowId) return String(item.workflowId).trim();
    }
    for (const workflow of workflows) {
      if (String(workflow?.metadata?.primaryMediaId || "").trim() === mediaId) {
        return String(workflow?.workflowId || workflow?.name || "").trim();
      }
    }
    return "";
  }

  async function resolveVideoDownloadReadiness({ mediaIds = [], submitOutputRows = [], projectId = "" } = {}) {
    const targetProjectId = String(projectId || projectIdFromUrl() || "").trim();
    const ids = [...new Set((mediaIds || []).map((id) => String(id || "").trim()).filter(uuidLike))];
    const outputRows = Array.isArray(submitOutputRows) ? submitOutputRows : [];
    if (!targetProjectId) return { ok: false, error: "missing_project_id", readyMediaIds: [] };
    if (!ids.length) return { ok: false, error: "missing_media_ids", readyMediaIds: [] };

    const ready = new Set();
    const rows = [];
    const payload = unwrapProjectData(await fetchProjectInitialData(targetProjectId));
    const contents = payload?.projectContents || {};
    const mediaItems = Array.isArray(contents.media) ? contents.media : Object.values(contents.media || {});
    const mediaById = new Map(mediaItems.map((media) => [String(media?.name || "").trim(), media]));
    for (const mediaId of ids) {
      const media = mediaById.get(mediaId);
      const rawStatus = String(media?.mediaMetadata?.mediaStatus?.mediaGenerationStatus || "").trim();
      const workflowId = String(
        outputRows.find((row) => String(row?.mediaId || "").trim() === mediaId)?.workflowId ||
        media?.workflowId ||
        ""
      ).trim();
      const hasGeneratedVideo = Boolean(media?.video?.generatedVideo);
      const ok = rawStatus === "MEDIA_GENERATION_STATUS_SUCCESSFUL" && hasGeneratedVideo;
      if (ok) ready.add(mediaId);
      rows.push({
        mediaId,
        workflowId,
        rawStatus,
        hasGeneratedVideo,
        ok,
        source: "project_initial_data"
      });
    }
    return {
      ok: true,
      projectId: targetProjectId,
      mediaIds: ids,
      readyMediaIds: [...ready],
      rows
    };
  }

  async function projectGeneratedMediaFeed({ projectId = "", maxProjectMedia = 800 } = {}) {
    const targetProjectId = String(projectId || projectIdFromUrl() || "").trim();
    if (!targetProjectId) return { ok: false, error: "missing_project_id", projectId: "", rows: [], items: [] };
    const payload = unwrapProjectData(await fetchProjectInitialData(targetProjectId));
    const contents = payload?.projectContents || {};
    const mediaRows = Array.isArray(contents.media) ? contents.media : Object.values(contents.media || {});
    const rows = [];
    const items = [];
    for (const media of mediaRows.slice(0, Math.max(100, Math.min(1500, Number(maxProjectMedia || 800) || 800)))) {
      const mediaId = String(media?.name || "").trim();
      if (!mediaId) continue;
      const hasVideo = Boolean(media?.video?.generatedVideo);
      const hasImage = Boolean(media?.image?.generatedImage);
      if (!hasVideo && !hasImage) continue;
      const kind = hasVideo ? "videos" : "images";
      const generated = hasVideo ? media.video.generatedVideo : media.image.generatedImage;
      const rawStatus = String(media?.mediaMetadata?.mediaStatus?.mediaGenerationStatus || "").trim();
      const status = normalizeFlowMediaStatus(rawStatus);
      const failureText = status === "failed" ? failureTextForMedia(media, rawStatus) : "";
      const prompt = compact(
        generated?.prompt ||
        media?.mediaMetadata?.requestData?.promptInputs?.[0]?.textInput ||
        ""
      );
      const mediaGenerationId = String(generated?.mediaGenerationId || "").trim();
      const thumbnailUrl = hasVideo
        ? mediaRedirectUrl(mediaId, { mediaUrlType: "MEDIA_URL_TYPE_THUMBNAIL" })
        : mediaRedirectUrl(mediaId);
      const mediaUrl = hasVideo && status !== "complete" ? "" : mediaRedirectUrl(mediaId);
      const row = {
        id: mediaId,
        mediaId,
        mediaGenerationId,
        workflowId: String(media.workflowId || media?.mediaMetadata?.workflowId || "").trim(),
        projectId: targetProjectId,
        kind,
        prompt,
        rawStatus,
        status,
        ...(failureText ? { failureText } : {}),
        model: String(generated?.model || ""),
        aspectRatio: String(generated?.aspectRatio || ""),
        mediaUrl,
        thumbnailUrl,
        createdAt: media?.mediaMetadata?.createTime || "",
        source: "project_initial_data"
      };
      rows.push(row);
      if (status === "complete") {
        items.push({
          id: `flow-project:${kind}:${mediaId}`,
          mediaId,
          mediaGenerationId,
          projectId: targetProjectId,
          kind,
          prompt,
          title: prompt || (hasVideo ? "Generated video" : "Generated image"),
          mediaUrl: hasVideo ? "" : mediaUrl,
          thumbnailUrl,
          source: "flow-project",
          matchMethod: "project_initial_data",
          workflowId: row.workflowId,
          createdAt: row.createdAt || new Date().toISOString()
        });
      }
    }
    return {
      ok: true,
      projectId: targetProjectId,
      rows,
      items,
      meta: {
        projectId: targetProjectId,
        source: "project_initial_data",
        fetchedAt: new Date().toISOString(),
        rowCount: rows.length,
        itemCount: items.length
      }
    };
  }

  async function pollUpscaledVideo({ mediaName = "", projectId = "", timeoutMs = 300000 } = {}) {
    const endpoint = "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus";
    const deadline = Date.now() + Math.max(15000, Number(timeoutMs) || 300000);
    const fetchImpl = window.__afRebuildNativeFetch || originalFetch || window.fetch;
    while (Date.now() < deadline) {
      await sleep(3000);
      const token = await getAccessToken();
      if (!token) return { ok: false, error: "missing_access_token_during_poll" };
      const response = await fetchImpl.call(window, endpoint, {
        method: "POST",
        mode: "cors",
        credentials: "include",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ media: [{ name: mediaName, projectId }] })
      });
      const text = await response.text().catch(() => "");
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      if (!response.ok) return { ok: false, error: `http_${response.status}:${text.slice(0, 200)}`, endpoint };
      const media = Array.isArray(data?.media)
        ? data.media.find((item) => String(item?.name || "").trim() === mediaName) || data.media[0]
        : null;
      const status = String(media?.mediaMetadata?.mediaStatus?.mediaGenerationStatus || "").trim();
      if (status === "MEDIA_GENERATION_STATUS_SUCCESSFUL") {
        const mediaUrl = String(
          media?.video?.generatedVideo?.fifeUrl ||
          media?.video?.fifeUrl ||
          media?.mediaUrl ||
          ""
        ).trim();
        return { ok: true, endpoint, mediaName: String(media?.name || mediaName).trim(), status, mediaUrl, data };
      }
      if (status && status !== "MEDIA_GENERATION_STATUS_PENDING") {
        return { ok: false, endpoint, mediaName, status, error: `status_${status.toLowerCase()}` };
      }
    }
    return { ok: false, endpoint, mediaName, error: "status_timeout" };
  }

  async function upscaleVideo({ mediaId = "", mediaGenerationId = "", resolution = "1080p", projectId = "", aspectRatio = "landscape" } = {}) {
    const baseMediaName = String(mediaId || "").trim();
    const sourceMediaId = String(mediaGenerationId || mediaId || "").trim();
    const targetProjectId = String(projectId || projectIdFromUrl() || "").trim();
    const normalizedResolution = String(resolution || "").trim().toLowerCase() === "4k" ? "4k" : "1080p";
    const resolutionEnum = normalizedResolution === "4k" ? "VIDEO_RESOLUTION_4K" : "VIDEO_RESOLUTION_1080P";
    const modelKey = normalizedResolution === "4k" ? "veo_3_1_upsampler_4k" : "veo_3_1_upsampler_1080p";
    const apiAspect = String(aspectRatio || "").toLowerCase().includes("portrait")
      ? "VIDEO_ASPECT_RATIO_PORTRAIT"
      : "VIDEO_ASPECT_RATIO_LANDSCAPE";
    if (!sourceMediaId) return { ok: false, error: "missing_media_id" };
    if (!targetProjectId) return { ok: false, error: "missing_project_id" };
    const token = await getAccessToken();
    if (!token) return { ok: false, error: "missing_access_token" };
    const recaptchaToken = await getRecaptchaToken("VIDEO_GENERATION");
    if (!recaptchaToken) return { ok: false, error: "missing_recaptcha_token" };
    const endpoint = "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoUpsampleVideo";
    const fetchImpl = window.__afRebuildNativeFetch || originalFetch || window.fetch;
    const buildBody = (attemptRecaptchaToken) => ({
        mediaGenerationContext: { batchId: crypto.randomUUID() },
        clientContext: {
          projectId: targetProjectId,
          tool: "PINHOLE",
          userPaygateTier: "PAYGATE_TIER_TWO",
          sessionId: `;${Date.now()}`,
          recaptchaContext: {
            token: attemptRecaptchaToken,
            applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB"
          }
        },
        requests: [{
          resolution: resolutionEnum,
          aspectRatio: apiAspect,
          seed: Math.floor(Math.random() * 2147483647),
          videoModelKey: modelKey,
          metadata: { sceneId: crypto.randomUUID() },
          videoInput: { mediaId: sourceMediaId }
        }],
        useV2ModelConfig: true
      });
    let data = null;
    let text = "";
    let status = 0;
    let ok = false;
    let attempts = 0;
    for (attempts = 1; attempts <= 3; attempts += 1) {
      const attemptRecaptchaToken = attempts === 1
        ? recaptchaToken
        : (await getRecaptchaToken("VIDEO_GENERATION")) || recaptchaToken;
      const response = await fetchImpl.call(window, endpoint, {
        method: "POST",
        mode: "cors",
        credentials: "include",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(buildBody(attemptRecaptchaToken))
      });
      status = response.status;
      text = await response.text().catch(() => "");
      data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      ok = response.ok;
      if (ok) break;
      if (![500, 502, 503, 504].includes(status) || attempts >= 3) break;
      await sleep(12000 * attempts);
    }
    if (!ok) return { ok: false, error: `http_${status}:${text.slice(0, 200)}`, endpoint, modelKey, attempts };
    const operationName = String(data?.operations?.[0]?.operation?.name || data?.operations?.[0]?.mediaGenerationId || "").trim();
    const fallbackSuffix = normalizedResolution === "4k" ? "_4k_upsampled" : "_upsampled";
    const resultMediaName = /_upsampled$/i.test(operationName) ? operationName : `${baseMediaName || sourceMediaId}${fallbackSuffix}`;
    const poll = await pollUpscaledVideo({ mediaName: resultMediaName, projectId: targetProjectId, timeoutMs: 300000 });
    if (!poll.ok) return { ok: false, error: poll.error || "upscale_poll_failed", endpoint, modelKey, resultMediaName, poll };
    const fallbackRedirectUrl = mediaRedirectUrl(resultMediaName, { cacheBust: false });
    const videoPayload = poll.mediaUrl
      ? null
      : await fetchMediaDataUrl(fallbackRedirectUrl, "video/mp4");
    if (!poll.mediaUrl && !videoPayload?.ok) {
      return { ok: false, error: videoPayload?.error || "upscaled_video_bytes_failed", endpoint, modelKey, resultMediaName, poll };
    }
    return {
      ok: true,
      endpoint,
      mediaId: sourceMediaId,
      resultMediaName,
      operationName,
      resolution: normalizedResolution,
      resolutionEnum,
      modelKey,
      attempts,
      mediaUrl: poll.mediaUrl || fallbackRedirectUrl,
      dataUrl: videoPayload?.dataUrl || "",
      byteLength: Number(videoPayload?.byteLength || 0),
      mimeType: videoPayload?.mimeType || ""
    };
  }

  function collectProjectState() {
    return {
      href: location.href,
      title: document.title,
      projectId: projectIdFromUrl(),
      counts: {
        buttons: document.querySelectorAll("button,[role=button]").length,
        inputs: document.querySelectorAll("input").length,
        textareas: document.querySelectorAll("textarea").length,
        images: document.querySelectorAll("img").length,
        videos: document.querySelectorAll("video").length
      },
      bodyTextPreview: compact(document.body?.innerText || "").slice(0, 1200)
    };
  }

  function smallHash(value = "") {
    let hash = 2166136261;
    const text = String(value || "");
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function absoluteMediaUrl(value = "") {
    try {
      return new URL(String(value || ""), location.href).href;
    } catch {
      return String(value || "");
    }
  }

  function mediaIdFromUrl(value = "") {
    const url = absoluteMediaUrl(value);
    try {
      const parsed = new URL(url);
      const fromName = normalizeMediaId(parsed.searchParams.get("name") || parsed.searchParams.get("mediaId") || "");
      if (fromName) return fromName;
    } catch {}
    return normalizeMediaId(url) || `dom-${smallHash(url)}`;
  }

  function promptNearElement(element) {
    const text = compact(
      element.closest("[data-testid], article, li, [role='listitem'], [role='button'], button, div")?.innerText ||
      element.parentElement?.innerText ||
      ""
    );
    return text
      .replace(/^(download|share|more|play|pause|open|close)\b/ig, "")
      .slice(0, 160)
      .trim();
  }

  function shouldKeepGalleryMedia(element, url = "") {
    const cleanUrl = String(url || "");
    if (!cleanUrl || cleanUrl.startsWith("data:")) return false;
    if (/favicon|avatar|profile|googleusercontent\.com\/.*(photo|avatar)|logo|icon/i.test(cleanUrl)) return false;
    if (/empty-state|placeholder|illustration|default-image/i.test(cleanUrl)) return false;
    const rect = element.getBoundingClientRect?.() || { width: 0, height: 0 };
    if ((rect.width && rect.width < 36) || (rect.height && rect.height < 36)) return false;
    return true;
  }

  async function scanProjectGallery(options = {}) {
    const startedAt = Date.now();
    const currentProjectId = projectIdFromUrl();
    const scanMeta = {
      projectId: currentProjectId,
      fullScroll: Boolean(options.fullScroll),
      scrollSteps: 0,
      scrollBounded: false,
      mediaNodesSeen: 0,
      mediaNodesScanned: 0
    };
    if (options.fullScroll) {
      const maxSteps = Math.max(1, Math.min(24, Number(options.maxSteps || 18) || 18));
      const settleMs = Math.max(20, Math.min(120, Number(options.settleMs || 35) || 35));
      const step = Math.max(420, Math.floor(window.innerHeight * 0.78));
      const startY = window.scrollY;
      for (let index = 0; index <= maxSteps; index += 1) {
        const maxScroll = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        const targetY = Math.min(maxScroll, index * step);
        window.scrollTo(0, targetY);
        scanMeta.scrollSteps += 1;
        await sleep(settleMs);
        if (targetY >= maxScroll) break;
      }
      scanMeta.scrollBounded = scanMeta.scrollSteps >= maxSteps;
      window.scrollTo(0, startY);
    }

    const seen = new Set();
    const items = [];
    const allMediaNodes = [
      ...document.querySelectorAll("img[src], video[src], video[poster], video source[src]")
    ];
    const maxMediaNodes = Math.max(100, Math.min(2000, Number(options.maxMediaNodes || 800) || 800));
    const mediaNodes = allMediaNodes.slice(0, maxMediaNodes);
    scanMeta.mediaNodesSeen = allMediaNodes.length;
    scanMeta.mediaNodesScanned = mediaNodes.length;
    for (const node of mediaNodes) {
      const tag = node.tagName.toLowerCase();
      const host = tag === "source" ? node.closest("video") || node : node;
      const rawUrl = node.currentSrc || node.src || node.getAttribute("src") || node.getAttribute("poster") || host.getAttribute?.("poster") || "";
      const mediaUrl = absoluteMediaUrl(rawUrl);
      if (!shouldKeepGalleryMedia(host, mediaUrl)) continue;
      const isVideo = tag === "video" || tag === "source" || /\.(mp4|webm|mov)(?:$|[?#])/i.test(mediaUrl);
      const mediaId = mediaIdFromUrl(mediaUrl);
      const dedupe = `${isVideo ? "videos" : "images"}:${mediaId}:${mediaUrl}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const prompt = promptNearElement(host);
      items.push({
        id: `flow-dom:${isVideo ? "videos" : "images"}:${mediaId}`,
        mediaId,
        projectId: currentProjectId,
        kind: isVideo ? "videos" : "images",
        prompt,
        title: prompt || (isVideo ? "Generated video" : "Generated image"),
        mediaUrl,
        thumbnailUrl: isVideo ? (host.getAttribute?.("poster") || "") : "",
        source: "flow-dom",
        matchMethod: "dom_visible_media",
        createdAt: new Date().toISOString()
      });
    }
    if (options.includeProjectData !== false) {
      try {
        const projectId = currentProjectId;
        const payload = unwrapProjectData(await fetchProjectInitialData(projectId));
        const contents = payload?.projectContents || {};
        const mediaRows = Array.isArray(contents.media) ? contents.media : Object.values(contents.media || {});
        for (const media of mediaRows.slice(0, Math.max(100, Math.min(1000, Number(options.maxProjectMedia || 500) || 500)))) {
          const mediaId = String(media?.name || "").trim();
          if (!mediaId) continue;
          // Trigger evidence: Alpha Bravo image-v34 — uploaded reference image
          // appearing in the gallery as a "Generated image" output. Cause:
          // Flow's project_initial_data returns BOTH user uploads AND
          // generated outputs under contents.media; both have a `media.image`
          // field. The marker that distinguishes a generated output is the
          // presence of `media.image.generatedImage` (or `media.video.
          // generatedVideo`) sub-object — uploads omit it. Filter on that
          // sub-object so uploads stay out of the gallery output view.
          const hasVideo = !!media?.video?.generatedVideo;
          const hasImage = !!media?.image?.generatedImage;
          if (!hasVideo && !hasImage) continue;
          const status = String(media?.mediaMetadata?.mediaStatus?.mediaGenerationStatus || "").trim();
          if (status && status !== "MEDIA_GENERATION_STATUS_SUCCESSFUL") continue;
          const kind = hasVideo ? "videos" : "images";
          if (items.some((item) => item.kind === kind && item.mediaId === mediaId)) continue;
          const prompt = compact(
            media?.video?.generatedVideo?.prompt ||
            media?.image?.generatedImage?.prompt ||
            media?.mediaMetadata?.requestData?.promptInputs?.[0]?.textInput ||
            ""
          );
          const mediaGenerationId = hasVideo
            ? String(media?.video?.generatedVideo?.mediaGenerationId || "").trim()
            : String(media?.image?.generatedImage?.mediaGenerationId || "").trim();
          items.push({
            id: `flow-project:${kind}:${mediaId}`,
            mediaId,
            mediaGenerationId,
            projectId,
            kind,
            prompt,
            title: prompt || (hasVideo ? "Generated video" : "Generated image"),
            // Project initial data can list a video as successful before the
            // playback redirect is actually safe. Exposing the raw playback
            // redirect here lets gallery reconcile/autodownload hit it too
            // early, producing tiny "Something went wrong loading your media"
            // files. For videos, only expose thumbnail readiness from the
            // thumbnail redirect; the service worker unlocks playback/download
            // after Flow itself requests workflow/redirect proof.
            mediaUrl: hasVideo ? "" : mediaRedirectUrl(mediaId),
            thumbnailUrl: hasVideo ? mediaRedirectUrl(mediaId, { mediaUrlType: "MEDIA_URL_TYPE_THUMBNAIL" }) : "",
            source: "flow-project",
            matchMethod: "project_initial_data",
            workflowId: String(media.workflowId || "").trim(),
            createdAt: media?.mediaMetadata?.createTime || new Date().toISOString()
          });
        }
      } catch (error) {
        scanMeta.projectDataError = String(error?.message || error || "project_initial_data_failed");
      }
    }
    return {
      ok: true,
      action: "scanGallery",
      items,
      counts: {
        images: items.filter((item) => item.kind === "images").length,
        videos: items.filter((item) => item.kind === "videos").length
      },
      meta: {
        ...scanMeta,
        durationMs: Date.now() - startedAt
      }
    };
  }

  async function clearFlowCache() {
    const result = {
      localStorage: false,
      sessionStorage: false,
      cachesDeleted: 0,
      indexedDbDeleted: 0
    };
    try {
      window.localStorage?.clear();
      result.localStorage = true;
    } catch {}
    try {
      window.sessionStorage?.clear();
      result.sessionStorage = true;
    } catch {}
    try {
      if (window.caches?.keys) {
        const keys = await window.caches.keys();
        await Promise.all(keys.map((key) => window.caches.delete(key)));
        result.cachesDeleted = keys.length;
      }
    } catch {}
    try {
      if (window.indexedDB?.databases) {
        const dbs = await window.indexedDB.databases();
        await Promise.all(
          dbs
            .map((db) => db.name)
            .filter(Boolean)
            .map((name) => new Promise((resolve) => {
              const req = window.indexedDB.deleteDatabase(name);
              req.onsuccess = req.onerror = req.onblocked = () => resolve();
            }))
        );
        result.indexedDbDeleted = dbs.length;
      }
    } catch {}
    return result;
  }

  function clearFlowCookies() {
    const preserved = /(^|_)(SID|HSID|SSID|APISID|SAPISID|LSID|OSID|ACCOUNT|LOGIN|AUTH|TOKEN|NID|AEC|SOCS)(_|$)/i;
    const cookies = String(document.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.split("=")[0])
      .filter(Boolean);
    let deleted = 0;
    let preservedCount = 0;
    for (const name of cookies) {
      if (preserved.test(name)) {
        preservedCount += 1;
        continue;
      }
      const encoded = encodeURIComponent(name);
      document.cookie = `${encoded}=; Max-Age=0; path=/`;
      document.cookie = `${encoded}=; Max-Age=0; path=/; domain=.google.com`;
      document.cookie = `${encoded}=; Max-Age=0; path=/; domain=.labs.google`;
      deleted += 1;
    }
    return { deleted, preserved: preservedCount };
  }

  const flowDomActions = Object.freeze({
    shell: {
      addMedia: {
        candidates: [
          { strategy: "generated-class", selector: "button.sc-5a7bdc3e-1", expectedCount: 1 }
        ]
      },
      viewSettings: {
        candidates: [
          { strategy: "generated-class", selector: "button.sc-507a0d81-6", expectedCount: 1 }
        ]
      }
    },
    composer: {
      create: {
        candidates: [
          { strategy: "generated-class", selector: "button.sc-522e4d41-4", materialIcon: "arrow_forward", expectedCount: 1 },
          { strategy: "generated-class", selector: "button.sc-2951028b-4", materialIcon: "arrow_forward", expectedCount: 1 }
        ]
      },
      clearPrompt: {
        candidates: [
          { strategy: "generated-class", selector: "button.sc-522e4d41-7", materialIcon: "close", expectedCount: 1 }
        ]
      }
    },
    gallery: {
      viewImages: {
        candidates: [
          { strategy: "material-icon-ligature", selector: "button.sc-e503ddc8-0", materialIcon: "image" }
        ]
      },
      viewVideos: {
        candidates: [
          { strategy: "material-icon-ligature", selector: "button.sc-e503ddc8-0", materialIcon: "videocam" }
        ]
      },
      viewArchive: {
        candidates: [
          { strategy: "material-icon-ligature", selector: "button.sc-e503ddc8-0", materialIcon: "archive" }
        ]
      }
    }
  });

  function assertLocaleSafeDomCandidate(candidate = {}) {
    const strategy = String(candidate.strategy || "");
    if (/text|aria-label|role-text|visible/i.test(strategy)) {
      throw new Error("locale_bound_dom_strategy");
    }
    const selector = String(candidate.selector || "");
    if (!selector) throw new Error("missing_dom_selector");
    if (/:text\(|text=|has-text|aria-label/i.test(selector)) {
      throw new Error("locale_bound_dom_selector");
    }
  }

  function elementIconLigature(element) {
    const iconNodes = Array.from(
      element.querySelectorAll(".material-symbols-outlined,.material-symbols-rounded,.material-icons,[class*='material-symbol']")
    );
    for (const node of iconNodes) {
      const token = compact(node.innerText || node.textContent || "").split(/\s+/)[0] || "";
      if (token) return token;
    }
    return compact(element.innerText || element.textContent || "").split(/\s+/)[0] || "";
  }

  function elementMatchesIconLigature(element, expected) {
    const expectedToken = String(expected || "");
    if (!expectedToken) return true;
    const token = elementIconLigature(element);
    return token === expectedToken || token.startsWith(expectedToken);
  }

  function candidatesForDomAction(area, name) {
    return flowDomActions[String(area || "")]?.[String(name || "")]?.candidates || [];
  }

  function resolveDomActionElement(area, name) {
    const misses = [];
    for (const candidate of candidatesForDomAction(area, name)) {
      assertLocaleSafeDomCandidate(candidate);
      let nodes = Array.from(document.querySelectorAll(candidate.selector));
      const rawCount = nodes.length;
      if (candidate.materialIcon) {
        nodes = nodes.filter((node) => elementMatchesIconLigature(node, candidate.materialIcon));
      }
      if (nodes.length === 1) {
        return {
          element: nodes[0],
          selector: candidate.selector,
          strategy: candidate.strategy,
          rawCount,
          matchedCount: nodes.length
        };
      }
      misses.push({
        selector: candidate.selector,
        strategy: candidate.strategy,
        rawCount,
        matchedCount: nodes.length
      });
    }
    return { element: null, misses };
  }

  function resolveComposerCreateElement(editor = findPromptEditor()) {
    const isArrowCreate = (node) => {
      if (!node || !visibleElement(node)) return false;
      if (node.disabled || node.getAttribute("aria-disabled") === "true") return false;
      return elementMatchesIconLigature(node, "arrow_forward");
    };
    let scope = editor;
    for (let depth = 0; scope && depth < 8; depth += 1, scope = scope.parentElement) {
      const scoped = Array.from(scope.querySelectorAll("button, [role='button']")).filter(isArrowCreate);
      if (scoped.length === 1) {
        return {
          element: scoped[0],
          selector: "scoped_composer_arrow_forward",
          strategy: "legacy-scoped-arrow-forward",
          rawCount: scoped.length,
          matchedCount: scoped.length
        };
      }
    }
    try {
      const xpath = "//button[.//i[text()='arrow_forward']] | (//button[.//i[normalize-space(text())='arrow_forward']])";
      const snapshot = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const nodes = [];
      for (let index = 0; index < snapshot.snapshotLength; index += 1) {
        const node = snapshot.snapshotItem(index);
        if (isArrowCreate(node)) nodes.push(node);
      }
      if (nodes.length === 1) {
        return {
          element: nodes[0],
          selector: xpath,
          strategy: "legacy-generate-xpath",
          rawCount: snapshot.snapshotLength,
          matchedCount: nodes.length
        };
      }
    } catch {}
    return null;
  }

  function resolveComposerSubmitHandler(editor = findPromptEditor()) {
    if (!editor) return null;
    const fiberKey = Object.keys(editor).find((key) => key.startsWith("__reactFiber"));
    if (!fiberKey) return null;
    for (let fiber = editor[fiberKey], depth = 0; fiber && depth < 36; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps || {};
      if (typeof props.onSubmit !== "function") continue;
      if (props.promptBoxStore?.getState) {
        return {
          submit: props.onSubmit,
          depth,
          strategy: "react-promptbox-onsubmit",
          submitDisabled: props.submitDisabled === true
        };
      }
    }
    return null;
  }

  function markComposerReceivedUserInput(editor = findPromptEditor()) {
    if (!editor) return { attempted: false, reason: "editor_not_found" };
    const fiberKey = Object.keys(editor).find((key) => key.startsWith("__reactFiber"));
    if (!fiberKey) return { attempted: false, reason: "react_fiber_not_found" };
    const updated = [];
    for (let fiber = editor[fiberKey], depth = 0; fiber && depth < 24; depth += 1, fiber = fiber.return) {
      const receivedUserInput = fiber.memoizedProps?.receivedUserInput;
      if (receivedUserInput && typeof receivedUserInput === "object" && "current" in receivedUserInput) {
        receivedUserInput.current = true;
        updated.push(depth);
      }
    }
    return {
      attempted: true,
      ok: updated.length > 0,
      updatedDepths: updated,
      reason: updated.length ? "received_user_input_marked" : "received_user_input_ref_not_found"
    };
  }

	  async function clickDomAction(area, name) {
    const actionArea = String(area || "");
    const actionName = String(name || "");
    if (!candidatesForDomAction(actionArea, actionName).length) {
      return {
        ok: false,
        action: "flowDomClick",
        area: actionArea,
        name: actionName,
        error: "missing_dom_action_contract"
      };
    }
    if (actionArea === "composer" && actionName === "create") {
      markComposerReceivedUserInput();
    }
    const resolved = actionArea === "composer" && actionName === "create"
      ? (resolveComposerCreateElement() || resolveDomActionElement(actionArea, actionName))
      : resolveDomActionElement(actionArea, actionName);
	    if (!resolved.element) {
      return {
        ok: false,
        action: "flowDomClick",
        area: actionArea,
        name: actionName,
        error: "dom_action_target_not_found",
        misses: resolved.misses || []
      };
	    }
	    if (resolved.element.disabled || resolved.element.getAttribute("aria-disabled") === "true") {
	      return {
	        ok: false,
	        action: "flowDomClick",
	        area: actionArea,
	        name: actionName,
	        error: "dom_action_target_disabled",
	        selector: resolved.selector,
	        strategy: resolved.strategy
	      };
	    }
	    resolved.element.scrollIntoView({ block: "center", inline: "center" });
	    await sleep(25);
	    pointerClick(resolved.element, { nativeClick: false });
    return {
      ok: true,
      action: "flowDomClick",
      area: actionArea,
      name: actionName,
      selector: resolved.selector,
      strategy: actionArea === "composer" && actionName === "create"
        ? `${resolved.strategy || "resolved"}:single_user_click`
        : resolved.strategy,
      rawCount: resolved.rawCount,
      matchedCount: resolved.matchedCount
	    };
	  }

	  function visibleElement(element) {
	    if (!element) return false;
	    const style = getComputedStyle(element);
	    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) return false;
	    const rect = element.getBoundingClientRect();
	    return rect.width > 0 && rect.height > 0;
	  }

	  function findPromptEditor() {
	    if (/\/archive(?:[/?#]|$)/i.test(location.pathname || "")) return null;
	    const selector = "textarea, [role='textbox'], [contenteditable='true'], [contenteditable='plaintext-only'], [data-slate-editor='true']";
	    const candidates = Array.from(document.querySelectorAll(selector))
	      .filter((element) => visibleElement(element))
	      .filter((element) => !element.closest("[data-autoflow-rebuild], #af-bot-panel"))
	      .filter((element) => !element.disabled && !element.readOnly)
	      .filter((element) => {
	        const label = [
	          element.getAttribute?.("type"),
	          element.getAttribute?.("aria-label"),
	          element.getAttribute?.("placeholder"),
	          element.getAttribute?.("name"),
	          element.id,
	          element.className
	        ].map((value) => String(value || "")).join(" ").toLowerCase();
	        return !/\bsearch\b/.test(label);
	      })
	      .map((element) => {
	        const rect = element.getBoundingClientRect();
	        const tag = String(element.tagName || "").toLowerCase();
	        const score = rect.width * rect.height + rect.bottom + (tag === "textarea" ? 5000 : 0);
	        return { element, score };
	      })
	      .sort((a, b) => b.score - a.score);
	    return candidates[0]?.element || null;
	  }

	  function editorText(element) {
	    if (!element) return "";
	    const tag = String(element.tagName || "").toLowerCase();
	    if (tag === "textarea" || tag === "input") return String(element.value || "");
	    return String(element.innerText || element.textContent || "");
	  }

	  function dispatchEditorInput(element, inputType = "insertText", data = null) {
	    try {
	      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
	    } catch {
	      element.dispatchEvent(new Event("input", { bubbles: true }));
	    }
	    element.dispatchEvent(new Event("change", { bubbles: true }));
	  }

  function collectSlateText(node, out = []) {
    if (!node || typeof node !== "object") return out;
    if (typeof node.text === "string") out.push(node.text);
    if (Array.isArray(node.children)) {
      node.children.forEach((child) => collectSlateText(child, out));
    }
    return out;
  }

  function promptStoreText(store = resolvePromptStore()) {
    const textEditor = store?.getState?.()?.inputs?.textEditor;
    if (!textEditor) return "";
    return collectSlateText(textEditor, []).join("");
  }

  async function setPromptStoreText(value) {
    const store = resolvePromptStore();
    const setPrompt = store?.getState?.()?.actions?.setPrompt;
    if (typeof setPrompt !== "function") return { attempted: false, persisted: "" };
    setPrompt(String(value || ""));
    await sleep(50);
    return { attempted: true, persisted: promptStoreText(store) };
  }

  function findSlateEditorObject(root) {
    const slateRoot = root?.matches?.("[data-slate-editor='true']")
      ? root
      : root?.closest?.("[data-slate-editor='true']");
    if (!slateRoot) return null;
    for (const key of Object.keys(slateRoot).filter((name) => name.startsWith("__react"))) {
      const stack = [slateRoot[key]];
      const seen = new Set();
      let guard = 0;
      while (stack.length && guard < 4000) {
        guard += 1;
        const node = stack.pop();
        if (!node || typeof node !== "object" || seen.has(node)) continue;
        seen.add(node);
        const candidates = [
          node.memoizedProps?.editor,
          node.memoizedProps?.node,
          node.memoizedState?.editor,
          node.pendingProps?.editor,
          node.stateNode?.editor,
          node.editor
        ];
        const editor = candidates.find((candidate) =>
          candidate &&
          typeof candidate === "object" &&
          Array.isArray(candidate.children) &&
          (typeof candidate.insertText === "function" || typeof candidate.apply === "function")
        );
        if (editor) return editor;
        if (node.child) stack.push(node.child);
        if (node.sibling) stack.push(node.sibling);
        if (node.return) stack.push(node.return);
        if (node.alternate) stack.push(node.alternate);
      }
    }
    return null;
  }

  async function setSlateEditorText(element, value) {
    // Native Slate-API typing path. Legacy Auto Flow used this; rebuild
    // shipped without it and so submit-button validation never trusted
    // the input. Calling editor.insertText(value) runs through Slate's
    // own data model + normalization + onChange listeners, which is what
    // Flow's React form-validation watches to enable the submit arrow.
    //
    // Returns { attempted, persisted }. attempted=true means the Slate
    // editor was found and we could call its API. Caller falls back to
    // DOM execCommand path if attempted=false.
    const editor = findSlateEditorObject(element);
    if (!editor) return { attempted: false, persisted: "" };
    const target = String(value || "");
    try {
      // Step 1: clear existing children's text by selecting full range and
      // deleting fragment. Slate's editor.children is [{children: [{text}]}]
      // for a single-line editor.
      const existingText = String(editor?.children?.[0]?.children?.[0]?.text || "");
      const range = {
        anchor: { path: [0, 0], offset: 0 },
        focus: { path: [0, 0], offset: existingText.length }
      };
      if (typeof editor.select === "function") editor.select(range);
      if (typeof editor.deleteFragment === "function") editor.deleteFragment();
      // Step 2: insert via Slate's native API. This fires the onChange
      // listeners Flow's submit-enable validator subscribes to.
      if (typeof editor.insertText === "function") {
        editor.insertText(target);
      } else if (typeof editor.apply === "function") {
        editor.apply({ type: "insert_text", path: [0, 0], offset: 0, text: target });
      } else {
        return { attempted: false, persisted: "" };
      }
      if (typeof editor.onChange === "function") editor.onChange();
      await sleep(50);
      const persisted = collectSlateText(editor.children?.[0] || {}, []).join("");
      return { attempted: true, persisted, ok: persisted.trim() === target.trim() };
    } catch (error) {
      return { attempted: false, persisted: "", error: String(error?.message || error || "slate_insert_failed") };
    }
  }

	  async function notifyPromptEditorChanged(element, value) {
    try {
      const slateEditor = findSlateEditorObject(element);
      if (slateEditor && typeof slateEditor.onChange === "function") slateEditor.onChange();
    } catch {}
    try {
      element.focus?.();
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertReplacementText",
        data: null
      }));
    } catch {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    try {
      element.dispatchEvent(new KeyboardEvent("keyup", {
        key: " ",
        code: "Space",
        keyCode: 32,
        which: 32,
        bubbles: true,
        cancelable: true,
        composed: true
      }));
    } catch {}
    await sleep(150);
  }

	  async function setPromptEditorText(element, text) {
	    const value = String(text || "");
    const visiblePromptMatches = () => {
      if (!value.trim()) return !compactPromptForCompare(editorText(element));
      return compactPromptForCompare(editorText(element)) === compactPromptForCompare(value);
    };
    const slateSet = await setSlateEditorText(element, value);
    if (slateSet.attempted && String(slateSet.persisted || "").trim() === value.trim()) {
      const storePersistedAfterSlate = promptStoreText();
      const storeSet = String(storePersistedAfterSlate || "").trim() === value.trim()
        ? { attempted: false, persisted: storePersistedAfterSlate }
        : await setPromptStoreText(value);
      const inputMark = markComposerReceivedUserInput(element);
      await notifyPromptEditorChanged(element, value);
      if (visiblePromptMatches()) {
        return {
          ok: true,
          persisted: editorText(element),
          storePersisted: promptStoreText(),
          slatePersisted: slateSet.persisted,
          slateAttempted: true,
          storeAttempted: storeSet.attempted === true,
          receivedUserInput: inputMark,
          method: "slateEditor.insertText"
        };
      }
    }
    const storeSet = await setPromptStoreText(value);
    if (storeSet.attempted && String(storeSet.persisted || "").trim() === value.trim()) {
      const inputMark = markComposerReceivedUserInput(element);
      await notifyPromptEditorChanged(element, value);
      if (visiblePromptMatches()) {
        return {
          ok: true,
          persisted: editorText(element),
          storePersisted: storeSet.persisted,
          slatePersisted: slateSet.persisted || "",
          slateAttempted: slateSet.attempted === true,
          storeAttempted: true,
          receivedUserInput: inputMark,
          method: "promptStore.setPrompt+receivedUserInput"
        };
      }
    }
	    const tag = String(element.tagName || "").toLowerCase();
	    element.focus();
    pointerClick(element);
	    await sleep(70);
    try {
      document.execCommand?.("selectAll", false, null);
    } catch {}
	    if (tag === "textarea" || tag === "input") {
	      const proto = tag === "textarea" ? window.HTMLTextAreaElement?.prototype : window.HTMLInputElement?.prototype;
	      const setter = Object.getOwnPropertyDescriptor(proto || {}, "value")?.set;
	      if (setter) setter.call(element, value);
	      else element.value = value;
	      dispatchEditorInput(element, "insertText", value);
	    } else {
      let inserted = false;
      try {
        inserted = document.execCommand?.("insertText", false, value) === true;
      } catch {
        inserted = false;
      }
      if (!inserted) {
        return {
          ok: false,
          persisted: editorText(element),
          storePersisted: promptStoreText(),
          slatePersisted: slateSet.persisted || "",
          slateAttempted: slateSet.attempted === true,
          storeAttempted: storeSet.attempted === true,
          method: "legacyExecCommand",
          error: "PROMPT_EXEC_COMMAND_DID_NOT_INSERT"
        };
      }
      dispatchEditorInput(element, value ? "insertText" : "deleteContentBackward", value || null);
	    }
	    await sleep(120);
    const inputMark = markComposerReceivedUserInput(element);
    await notifyPromptEditorChanged(element, value);
    const persisted = editorText(element);
    const storePersisted = promptStoreText();
    const domOk = persisted.trim() === value.trim();
	    return {
	      ok: domOk,
      persisted,
      storePersisted,
      slatePersisted: slateSet.persisted || "",
      slateAttempted: slateSet.attempted === true,
      storeAttempted: storeSet.attempted === true,
      receivedUserInput: inputMark,
      method: "legacyExecCommand"
	    };
	  }

  function normalizeAssetName(name = "") {
    return String(name || "")
      .toLowerCase()
      .replace(/^autoflow-[a-f0-9-]{8,}-/i, "")
      .replace(/\.[a-z0-9]{2,6}$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeRefDescriptor(ref = {}, fallbackRole = "") {
    if (!ref || typeof ref !== "object") return null;
    const rawMediaId = String(ref.mediaId || "").trim();
    const rawId = String(ref.id || "").trim();
    const blobStoreId = String(ref.blobStoreId || "").trim();
    const fileName = String(ref.fileName || ref.title || ref.name || "").trim();
    const role = String(ref.role || fallbackRole || "").trim();
    const dataUrl = String(ref.dataUrl || "").trim();
    const imageUrl = String(ref.imageUrl || "").trim();
    const mediaUrl = String(ref.mediaUrl || "").trim();
    const hasInlineImage = Boolean([dataUrl, imageUrl, mediaUrl].some((value) => /^data:image\//i.test(value)));
    const localIds = new Set([blobStoreId, rawId].map((value) => String(value || "").trim()).filter(Boolean));
    const mediaIdFromRawId = /^(fe_id_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId) && !blobStoreId && !hasInlineImage
      ? rawId
      : "";
    const mediaId = [rawMediaId, mediaIdFromRawId]
      .map((value) => String(value || "").trim())
      .find((value) => value && !localIds.has(value) && !localIds.has(value.replace(/^fe_id_/i, ""))) || "";
    const rawAssetImageId = String(ref.assetImageId || "").trim();
    const trustedAssetImageId = rawAssetImageId && !localIds.has(rawAssetImageId) && !localIds.has(rawAssetImageId.replace(/^fe_id_/i, ""))
      ? rawAssetImageId
      : "";
    if (!mediaId && !fileName && !dataUrl && !imageUrl && !mediaUrl) return null;
    return {
      id: String(ref.id || ""),
      blobStoreId,
      role,
      mediaId,
      fileName,
      title: String(ref.title || fileName || mediaId || ""),
      mimeType: String(ref.mimeType || "image/png"),
      uploadedAt: String(ref.uploadedAt || ref.uploadedAtIso || ""),
      dataUrl,
      imageUrl,
      mediaUrl,
      assetImageId: String(trustedAssetImageId || (mediaId ? `fe_id_${mediaId.replace(/^fe_id_/i, "")}` : "")).trim()
    };
  }

  function taskRefDescriptors(task = {}) {
    const refs = [];
    const push = (ref, fallbackRole = "") => {
      const normalized = normalizeRefDescriptor(ref, fallbackRole);
      if (normalized) refs.push(normalized);
    };
    (Array.isArray(task.refInputs) ? task.refInputs : []).forEach((ref) => push(ref));
    push(task.startRefInput, "startFrameRef");
    push(task.endRefInput, "endFrameRef");

    const fallbackMediaIds = Array.isArray(task.refMediaIds) && task.refMediaIds.length
      ? task.refMediaIds
      : (Array.isArray(task.mediaIds) ? task.mediaIds : []);
    if (refs.length && fallbackMediaIds.length) {
      for (let index = 0; index < refs.length; index += 1) {
        if (refs[index]?.mediaId) continue;
        const mediaId = String(fallbackMediaIds[index] || "").trim();
        if (!mediaId) continue;
        refs[index] = {
          ...refs[index],
          mediaId,
          assetImageId: refs[index].assetImageId || `fe_id_${mediaId.replace(/^fe_id_/i, "")}`
        };
      }
    }
    if (!refs.length && fallbackMediaIds.length) {
      const mode = String(task.mode || "");
      fallbackMediaIds.forEach((mediaId, index) => {
        const role = mode === "image-to-video" || mode === "start-end-image-to-video"
          ? (index === 0 ? "startFrameRef" : "endFrameRef")
          : (mode === "ingredients-to-video" ? "ingredientsRefs" : "imagePromptRefs");
        push({ mediaId, role });
      });
    }
    if (["image-to-video", "start-end-image-to-video"].includes(String(task.mode || ""))) {
      if (task.startMediaId) push({ mediaId: task.startMediaId, role: "startFrameRef" });
      if (task.endMediaId) push({ mediaId: task.endMediaId, role: "endFrameRef" });
    }

    const seen = new Set();
    const seenFrameSlots = new Set();
    return refs.filter((ref) => {
      const idKey = frameIdTail(ref.mediaId || ref.assetImageId || "");
      const nameKey = normalizeAssetName(ref.fileName || ref.title);
      const key = `${ref.role}|${idKey || nameKey}`;
      if (seen.has(key)) return false;
      if (ref.role === "startFrameRef" || ref.role === "endFrameRef") {
        if (seenFrameSlots.has(ref.role)) return false;
        seenFrameSlots.add(ref.role);
      }
      seen.add(key);
      return true;
    });
  }

  function resolvePromptStore() {
    const slateEl = document.querySelector("[data-slate-editor='true']");
    if (!slateEl) return null;
    const fiberKey = Object.keys(slateEl).find((key) => key.startsWith("__reactFiber"));
    if (!fiberKey) return null;
    for (let fiber = slateEl[fiberKey], depth = 0; fiber && depth < 40; depth += 1, fiber = fiber.return) {
      if (fiber.memoizedProps?.promptBoxStore?.getState) return fiber.memoizedProps.promptBoxStore;
    }
    return null;
  }

  function desiredStoreModesForTask(task = {}) {
    const mode = String(task.mode || "");
    if (mode === "text-to-image") return { target: "IMAGE", acceptable: ["IMAGE"] };
    if (mode === "text-to-video") return { target: "VIDEO", acceptable: ["VIDEO_FRAMES", "VIDEO"] };
    if (mode === "image-to-video" || mode === "start-end-image-to-video") {
      return { target: "VIDEO_FRAMES", acceptable: ["VIDEO_FRAMES"] };
    }
    if (mode === "ingredients-to-video") {
      return { target: "VIDEO_REFERENCES", acceptable: ["VIDEO_REFERENCES", "INGREDIENTS"] };
    }
    return { target: "", acceptable: [] };
  }

  function findFlowModeTabBySuffix(suffix) {
    const tabs = Array.from(document.querySelectorAll("button[role='tab']"))
      .filter((node) => {
        const id = String(node.getAttribute("id") || "");
        return id.endsWith(suffix);
      });
    // Prefer visible tabs (rendered + non-zero size + not display:none)
    return tabs.find((node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle?.(node);
      return rect.width > 0 && rect.height > 0 && style?.visibility !== "hidden" && style?.display !== "none";
    }) || null;
  }

  function isVisibleElement(node) {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle?.(node);
    return rect.width > 0 && rect.height > 0 && style?.visibility !== "hidden" && style?.display !== "none";
  }

  function visibleText(node) {
    return String(node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function domRectSummary(element) {
    if (!element?.getBoundingClientRect) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function selectedVisibleTabText(pattern) {
    return Array.from(document.querySelectorAll("button[role='tab']"))
      .filter(isVisibleElement)
      .filter((node) => node.getAttribute("aria-selected") === "true")
      .map((node) => visibleText(node))
      .find((text) => pattern.test(text)) || "";
  }

  function promptEditorText(element = findPromptEditor()) {
    if (!element) return "";
    const tag = String(element.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "input") return String(element.value || "");
    return String(element.innerText || element.textContent || "");
  }

  function summarizeComposerCreateButton() {
    const resolved = resolveComposerCreateElement() || resolveDomActionElement("composer", "create");
    const element = resolved?.element || null;
    return {
      found: Boolean(element),
      text: element ? visibleText(element) : "",
      disabled: Boolean(element?.disabled),
      ariaDisabled: String(element?.getAttribute?.("aria-disabled") || ""),
      pointerEvents: element ? String(getComputedStyle(element).pointerEvents || "") : "",
      selector: String(resolved?.selector || ""),
      strategy: String(resolved?.strategy || ""),
      matchedCount: Number(resolved?.matchedCount || 0),
      rect: domRectSummary(element)
    };
  }

  function summarizeVisibleVeoMenuItems(limit = 12) {
    return Array.from(document.querySelectorAll("[role='menuitem'], button"))
      .filter(isVisibleElement)
      .map((node) => visibleText(node))
      .filter((text) => /Veo\s+\d/i.test(text))
      .slice(0, limit);
  }

  function summarizePromptStoreForTrace() {
    const store = resolvePromptStore();
    const state = store?.getState?.() || null;
    if (!state) return { found: false };
    const editor = findPromptEditor();
    const userInputMark = (() => {
      if (!editor) return null;
      const fiberKey = Object.keys(editor).find((key) => key.startsWith("__reactFiber"));
      if (!fiberKey) return null;
      for (let fiber = editor[fiberKey], depth = 0; fiber && depth < 24; depth += 1, fiber = fiber.return) {
        const receivedUserInput = fiber.memoizedProps?.receivedUserInput;
        if (receivedUserInput && typeof receivedUserInput === "object" && "current" in receivedUserInput) {
          return { depth, current: receivedUserInput.current === true };
        }
      }
      return null;
    })();
    return {
      found: true,
      mode: String(state.mode || ""),
      aspectRatio: String(state.aspectRatio || ""),
      outputsPerPrompt: state.outputsPerPrompt ?? null,
      selectedVideoDuration: state.selectedVideoDuration ?? null,
      currentModelKeys: {
        imageModelKey: String(state.currentModelKeys?.imageModelKey || ""),
        videoApi: String(state.currentModelKeys?.videoApi || ""),
        videoModelKey: String(state.currentModelKeys?.videoModelKey || "")
      },
      prompt: promptStoreText(store).slice(0, 220),
      receivedUserInput: userInputMark,
      ingredientCount: Array.isArray(state.ingredients) ? state.ingredients.length : null,
      ingredientIds: Array.isArray(state.ingredients)
        ? state.ingredients.map((item) => String(item?.imageId || item?.mediaId || "").trim()).filter(Boolean).slice(0, 12)
        : []
    };
  }

  function summarizeDomAutomationTrace(task = {}) {
    const editor = findPromptEditor();
    const modelButton = findModelDropdownButton();
    const settingsTrigger = findComposerSettingsTrigger();
    const expected = {
      mode: String(task.mode || ""),
      model: String(task.model || ""),
      aspect: normalizeDomAspectRatio(task.aspectRatio),
      repeat: Math.max(1, Math.min(4, Number.parseInt(task.repeatCount, 10) || 1)),
      duration: domVideoDurationForTask(task),
      visibleMode: visibleModeForDomTask(task),
      modelPattern: String(modelLabelPatternForTask(task)),
      storeModelKeys: domVideoModelKeys(task) || null
    };
    return {
      expected,
      href: location.href,
      projectId: projectIdFromUrl(),
      store: summarizePromptStoreForTrace(),
      editor: {
        found: Boolean(editor),
        text: promptEditorText(editor).slice(0, 260),
        rect: domRectSummary(editor)
      },
      visible: {
        settingsTriggerText: settingsTrigger ? visibleText(settingsTrigger) : "",
        modelButtonText: modelButton ? visibleText(modelButton) : "",
        selectedModeTabs: Array.from(document.querySelectorAll("button[role='tab']"))
          .filter(isVisibleElement)
          .filter((node) => node.getAttribute("aria-selected") === "true")
          .map((node) => visibleText(node))
          .slice(0, 16),
        selectedAspect: selectedVisibleTabText(/LANDSCAPE|PORTRAIT|SQUARE|crop_16_9|crop_9_16|crop_square/i),
        selectedRepeat: selectedVisibleTabText(/^1x$|^x[2-4]$/i),
        selectedDuration: selectedVisibleTabText(/^[468]s$/i),
        veoMenuItems: summarizeVisibleVeoMenuItems()
      },
      createButton: summarizeComposerCreateButton()
    };
  }

  function rectSignature(rect = {}) {
    if (!rect) return "";
    return [
      Math.round(Number(rect.x || 0)),
      Math.round(Number(rect.y || 0)),
      Math.round(Number(rect.width || 0)),
      Math.round(Number(rect.height || 0))
    ].join(":");
  }

  function elementCenterHitSummary(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect) return { ok: false, error: "missing_rect" };
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    const button = hit?.closest?.("button, [role='button'], textarea, [role='textbox'], [contenteditable='true'], [data-slate-editor='true']") || hit;
    return {
      ok: Boolean(button && (button === element || element.contains(button) || button.contains(element))),
      hitText: visibleText(button).slice(0, 160),
      hitTag: String(button?.tagName || "").toLowerCase(),
      hitRole: button?.getAttribute?.("role") || "",
      rect: domRectSummary(element)
    };
  }

  function composerReadySnapshot(task = {}) {
    const editor = findPromptEditor();
    const create = resolveComposerCreateElement() || resolveDomActionElement("composer", "create");
    const settingsTrigger = findComposerSettingsTrigger();
    const store = resolvePromptStore();
    const createElement = create?.element || null;
    const editorRect = domRectSummary(editor);
    const createRect = domRectSummary(createElement);
    const settingsRect = domRectSummary(settingsTrigger);
    const problems = [];
    if (/\/archive(?:[/?#]|$)/i.test(location.pathname || "")) problems.push("flow_archive_view");
    if (!editor) problems.push("editor_missing");
    if (!editorRect || editorRect.width < 20 || editorRect.height < 8) problems.push("editor_unstable");
    if (!createElement) problems.push("create_missing");
    if (!createRect || createRect.width < 12 || createRect.height < 12) problems.push("create_unstable");
    if (String(task.mode || "") !== "text-to-image") {
      if (!settingsTrigger) problems.push("settings_trigger_missing");
      if (!settingsRect || settingsRect.width < 20 || settingsRect.height < 12) problems.push("settings_trigger_unstable");
      const settingsHit = elementCenterHitSummary(settingsTrigger);
      if (settingsTrigger && !settingsHit.ok) problems.push("settings_trigger_covered");
    }
    const createHit = elementCenterHitSummary(createElement);
    if (createElement && !createHit.ok) problems.push("create_covered");
    return {
      ok: problems.length === 0,
      problems,
      storeFound: Boolean(store),
      storeMode: String(store?.getState?.()?.mode || ""),
      editorRect,
      editorText: promptEditorText(editor).slice(0, 180),
      createRect,
      createText: createElement ? visibleText(createElement) : "",
      createDisabled: Boolean(createElement && (createElement.disabled || createElement.getAttribute("aria-disabled") === "true")),
      createHit,
      settingsRect,
      settingsText: settingsTrigger ? visibleText(settingsTrigger) : "",
      settingsHit: settingsTrigger ? elementCenterHitSummary(settingsTrigger) : null,
      trace: summarizeDomAutomationTrace(task)
    };
  }

  async function waitForComposerReadyForDebugger(task = {}, options = {}) {
    const timeoutMs = Math.max(1000, Math.min(12000, Number(options.timeoutMs || 6000)));
    const intervalMs = Math.max(80, Math.min(400, Number(options.intervalMs || 180)));
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let stableCount = 0;
    let lastSignature = "";
    while (Date.now() < deadline) {
      const snapshot = composerReadySnapshot(task);
      const signature = [
        rectSignature(snapshot.editorRect),
        rectSignature(snapshot.createRect),
        rectSignature(snapshot.settingsRect),
        snapshot.createText,
        snapshot.settingsText
      ].join("|");
      if (snapshot.ok && signature === lastSignature) stableCount += 1;
      else stableCount = snapshot.ok ? 1 : 0;
      lastSignature = signature;
      last = snapshot;
      if (stableCount >= 2) {
        return {
          ok: true,
          action: "waitForComposerReadyForDebugger",
          stableCount,
          snapshot
        };
      }
      await sleep(intervalMs);
    }
    return {
      ok: false,
      action: "waitForComposerReadyForDebugger",
      error: `COMPOSER_NOT_READY:${(last?.problems || ["unknown"]).join(",")}`,
      stableCount,
      snapshot: last
    };
  }

  function compactPromptForCompare(value = "") {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function taskExpectedAttachedRefCount(task = {}) {
    if (!domTaskRequiresAttach(task)) return 0;
    const refs = taskRefDescriptors(task);
    if (refs.length) return refs.length;
    return taskMediaIds(task).length;
  }

  function refsSettledForTask(store, task = {}) {
    const mode = String(task.mode || "");
    const refs = taskRefDescriptors(task);
    const expectedCount = taskExpectedAttachedRefCount(task);
    if (!expectedCount) return { ok: true, expectedCount, ingredientIds: [], roles: {} };
    if (!store?.getState) return { ok: false, error: "PROMPT_STORE_NOT_FOUND", expectedCount, ingredientIds: [], roles: {} };
    const state = store.getState() || {};
    const ingredients = Array.isArray(state.ingredients) ? state.ingredients : [];
    const ingredientIds = ingredients
      .map((ingredient) => String(ingredient?.imageId || ingredient?.mediaId || "").trim())
      .filter(Boolean);
    const roles = {
      firstFrame: String(roleImageId(store, "FIRST_FRAME") || "").trim(),
      lastFrame: String(roleImageId(store, "LAST_FRAME") || "").trim()
    };
    if (mode === "image-to-video" || mode === "start-end-image-to-video") {
      const needsFirst = refs.some((ref) => String(ref.role || "") === "startFrameRef")
        || Boolean(task.startMediaId || task.startRefInput)
        || expectedCount > 0;
      const needsLast = mode === "start-end-image-to-video"
        && (refs.some((ref) => String(ref.role || "") === "endFrameRef") || Boolean(task.endMediaId || task.endRefInput));
      if (needsFirst && !roles.firstFrame) return { ok: false, error: "FIRST_FRAME_NOT_SETTLED", expectedCount, ingredientIds, roles };
      if (needsLast && !roles.lastFrame) return { ok: false, error: "LAST_FRAME_NOT_SETTLED", expectedCount, ingredientIds, roles };
      return { ok: true, expectedCount, ingredientIds, roles };
    }
    if (ingredientIds.length < expectedCount) {
      return { ok: false, error: "REF_COUNT_NOT_SETTLED", expectedCount, actualCount: ingredientIds.length, ingredientIds, roles };
    }
    if (mode === "ingredients-to-video") {
      const ingredientRefIds = ingredients
        .filter((ingredient) => String(ingredient?.preferredIngredientType || "") === "INGREDIENT" && ingredient?.isLoading !== true)
        .map((ingredient) => String(ingredient?.imageId || ingredient?.mediaId || "").trim())
        .filter(Boolean);
      if (ingredientRefIds.length < expectedCount) {
        return {
          ok: false,
          error: "INGREDIENT_REF_TYPE_NOT_SETTLED",
          expectedCount,
          actualCount: ingredientIds.length,
          actualIngredientCount: ingredientRefIds.length,
          ingredientIds,
          ingredientRefIds,
          roles
        };
      }
    }
    return { ok: true, expectedCount, actualCount: ingredientIds.length, ingredientIds, roles };
  }

  function shouldValidateDomVideoModelKeys(task = {}) {
    return String(task.mode || "") !== "ingredients-to-video";
  }

  function composerPostUploadSettleSnapshot(task = {}, options = {}) {
    const expectPrompt = options.expectPrompt === true;
    const checkSettings = options.checkSettings !== false;
    const prompt = compactPromptForCompare(task.prompt || "");
    const store = resolvePromptStore();
    const trace = summarizeDomAutomationTrace(task);
    const ready = composerReadySnapshot(task);
    const problems = [];
    if (!ready.ok) problems.push(...(ready.problems || []));
    if (uploadSpinnerVisible()) problems.push("upload_spinner_visible");
    if (findAssetBrowserRoot()) problems.push("asset_browser_still_open");

    const expected = trace.expected || {};
    const actualStore = trace.store || {};
    if (checkSettings) {
      const desiredMode = desiredStoreModesForTask(task);
      if (desiredMode.acceptable?.length && !desiredMode.acceptable.includes(String(actualStore.mode || ""))) {
        problems.push("mode_not_settled");
      }
      if (Number(expected.repeat || 0) > 0 && Number(actualStore.outputsPerPrompt || 0) !== Number(expected.repeat)) {
        problems.push("repeat_not_settled");
      }
      if (String(task.mode || "") !== "text-to-image" && String(task.mode || "") !== "ingredients-to-video" && String(expected.duration || "")) {
        const actualDuration = String(actualStore.selectedVideoDuration ?? "");
        if (actualDuration !== String(expected.duration)) problems.push("duration_not_settled");
      }
      const expectedModelKeys = expected.storeModelKeys || null;
      if (shouldValidateDomVideoModelKeys(task)) {
        if (expectedModelKeys?.videoApi && String(actualStore.currentModelKeys?.videoApi || "") !== String(expectedModelKeys.videoApi)) {
          problems.push("video_api_not_settled");
        }
        if (expectedModelKeys?.videoModelKey && String(actualStore.currentModelKeys?.videoModelKey || "") !== String(expectedModelKeys.videoModelKey)) {
          problems.push("video_model_not_settled");
        }
      }
    }

    const refSettle = refsSettledForTask(store, task);
    if (!refSettle.ok) problems.push(refSettle.error || "refs_not_settled");

    if (expectPrompt) {
      const editorPrompt = compactPromptForCompare(trace.editor?.text || "");
      const storePrompt = compactPromptForCompare(actualStore.prompt || "");
      if (prompt && editorPrompt !== prompt) problems.push("editor_prompt_not_settled");
      if (prompt && storePrompt && storePrompt !== prompt) problems.push("store_prompt_not_settled");
      if (actualStore.receivedUserInput && actualStore.receivedUserInput.current !== true) {
        problems.push("received_user_input_not_settled");
      }
    }

    return {
      ok: problems.length === 0,
      problems: [...new Set(problems)],
      ready,
      refSettle,
      expectPrompt,
      checkSettings,
      trace
    };
  }

  async function waitForComposerPostUploadSettle(task = {}, options = {}) {
    const timeoutMs = Math.max(1200, Math.min(15000, Number(options.timeoutMs || 9000)));
    const intervalMs = Math.max(100, Math.min(500, Number(options.intervalMs || 240)));
    const stableNeeded = Math.max(2, Math.min(6, Number(options.stableNeeded || 3)));
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let stableCount = 0;
    let lastSignature = "";
    while (Date.now() < deadline) {
      const snapshot = composerPostUploadSettleSnapshot(task, options);
      const trace = snapshot.trace || {};
      const signature = JSON.stringify({
        mode: trace.store?.mode || "",
        repeat: trace.store?.outputsPerPrompt ?? null,
        duration: trace.store?.selectedVideoDuration ?? null,
        videoApi: trace.store?.currentModelKeys?.videoApi || "",
        videoModelKey: trace.store?.currentModelKeys?.videoModelKey || "",
        prompt: options.expectPrompt === true ? compactPromptForCompare(trace.editor?.text || "") : "",
        create: {
          disabled: Boolean(trace.createButton?.disabled),
          ariaDisabled: trace.createButton?.ariaDisabled || "",
          pointerEvents: trace.createButton?.pointerEvents || ""
        },
        refs: snapshot.refSettle || {}
      });
      if (snapshot.ok && signature === lastSignature) stableCount += 1;
      else stableCount = snapshot.ok ? 1 : 0;
      lastSignature = signature;
      last = snapshot;
      if (stableCount >= stableNeeded) {
        return { ok: true, action: "waitForComposerPostUploadSettle", stableCount, snapshot };
      }
      await sleep(intervalMs);
    }
    return {
      ok: false,
      action: "waitForComposerPostUploadSettle",
      error: `COMPOSER_UPLOAD_NOT_SETTLED:${(last?.problems || ["unknown"]).join(",")}`,
      stableCount,
      snapshot: last
    };
  }

  function findComposerSettingsTrigger() {
    const candidates = Array.from(document.querySelectorAll("button[aria-haspopup='menu']"))
      .filter(isVisibleElement)
      .map((node) => ({ node, rect: node.getBoundingClientRect(), text: visibleText(node) }))
      .filter((item) => /x[1-4]|crop_(16_9|9_16|square|landscape|portrait)/i.test(item.text));
    candidates.sort((a, b) => b.rect.y - a.rect.y);
    return candidates[0]?.node || null;
  }

  function findVisibleModeTab(suffix) {
    return findFlowModeTabBySuffix(suffix)
      || Array.from(document.querySelectorAll("button[role='tab']"))
        .filter(isVisibleElement)
        .find((node) => {
          const text = visibleText(node).toLowerCase();
          if (suffix === "-trigger-IMAGE") return /\bimage\b/.test(text);
          if (suffix === "-trigger-VIDEO") return /\bvideo\b/.test(text);
          if (suffix === "-trigger-VIDEO_FRAMES") return /\bframes?\b/.test(text);
          if (suffix === "-trigger-VIDEO_REFERENCES") return /\bingredients?\b|\breferences?\b/.test(text);
          return false;
        }) || null;
  }

  function findVisibleTabBySuffix(suffix) {
    return Array.from(document.querySelectorAll("button[role='tab']"))
      .filter(isVisibleElement)
      .find((node) => String(node.getAttribute("id") || "").endsWith(suffix)) || null;
  }

  async function clickVisibleTabBySuffix(suffix) {
    const tab = findVisibleTabBySuffix(suffix);
    if (!tab) return { ok: false, error: "tab_not_found", suffix };
    const beforeSelected = tab.getAttribute("aria-selected") === "true";
    if (!beforeSelected) {
      pointerClick(tab);
      await sleep(220);
    }
    const after = findVisibleTabBySuffix(suffix) || tab;
    return {
      ok: after.getAttribute("aria-selected") === "true",
      clicked: !beforeSelected,
      suffix,
      text: visibleText(tab),
      error: after.getAttribute("aria-selected") === "true" ? "" : "tab_not_selected"
    };
  }

  async function clickVisibleTabByText(pattern, label = "") {
    const tab = Array.from(document.querySelectorAll("button[role='tab']"))
      .filter(isVisibleElement)
      .find((node) => pattern.test(visibleText(node)));
    if (!tab) return { ok: false, error: "tab_not_found", label };
    const beforeSelected = tab.getAttribute("aria-selected") === "true";
    if (!beforeSelected) {
      pointerClick(tab);
      await sleep(220);
    }
    const after = Array.from(document.querySelectorAll("button[role='tab']"))
      .filter(isVisibleElement)
      .find((node) => pattern.test(visibleText(node))) || tab;
    return {
      ok: after.getAttribute("aria-selected") === "true",
      clicked: !beforeSelected,
      label,
      text: visibleText(tab),
      error: after.getAttribute("aria-selected") === "true" ? "" : "tab_not_selected"
    };
  }

  async function ensureComposerSettingsMenuOpen() {
    const existing = findVisibleModeTab("-trigger-IMAGE") || findVisibleModeTab("-trigger-VIDEO");
    if (existing) return { ok: true, opened: false, triggerText: "" };
    const trigger = findComposerSettingsTrigger();
    if (!trigger) return { ok: false, error: "COMPOSER_SETTINGS_TRIGGER_NOT_FOUND" };
    const triggerText = visibleText(trigger);
    pointerClick(trigger);
    await sleep(260);
    const opened = Boolean(findVisibleModeTab("-trigger-IMAGE") || findVisibleModeTab("-trigger-VIDEO"));
    return { ok: opened, opened, triggerText, error: opened ? "" : "COMPOSER_SETTINGS_MENU_NOT_OPEN" };
  }

  async function clickFlowModeTabForTarget(target) {
    // Maps our internal store-mode target to Flow's DOM tab id suffix.
    // Legacy reference: injector.js reseatToExplicitTextVideo searches by
    // "-trigger-IMAGE" / "-trigger-VIDEO" suffix and clicks via afHumanClick.
    // Without this DOM click, Flow's React listeners (which are wired to
    // the actual tab button onClick) never observe the mode change, even
    // when the Zustand store has the new mode value. Submit-enable
    // validator stays in stale state -> submit arrow gray.
    const suffixMap = {
      VIDEO: "-trigger-VIDEO",
      VIDEO_FRAMES: "-trigger-VIDEO_FRAMES",
      VIDEO_REFERENCES: "-trigger-VIDEO_REFERENCES",
      INGREDIENTS: "-trigger-VIDEO_REFERENCES",
      IMAGE: "-trigger-IMAGE"
    };
    const targetKey = String(target || "").toUpperCase();
    const suffix = suffixMap[targetKey];
    if (!suffix) return { attempted: false, reason: "no_dom_suffix_for_target" };
    const menu = await ensureComposerSettingsMenuOpen();
    if (!menu.ok) return { attempted: true, clicked: false, suffix, error: menu.error || "COMPOSER_SETTINGS_MENU_NOT_OPEN" };
    const clicked = [];
    const store = resolvePromptStore();
    const clickTab = async (tabSuffix) => {
      const result = await clickVisibleTabBySuffix(tabSuffix);
      if (result.ok) {
        clicked.push({ ...result, ariaSelected: true });
        return { ok: true };
      }
      const tab = findVisibleModeTab(tabSuffix);
      if (!tab) return { ok: false, error: result.error || "tab_not_found", suffix: tabSuffix };
      const beforeSelected = tab.getAttribute("aria-selected") === "true";
      if (!beforeSelected) {
        pointerClick(tab);
        await sleep(300);
      }
      const after = findVisibleModeTab(tabSuffix) || tab;
      const ariaSelected = after.getAttribute("aria-selected") === "true";
      clicked.push({ suffix: tabSuffix, text: visibleText(tab), clicked: !beforeSelected, ariaSelected });
      return { ok: ariaSelected, error: ariaSelected ? "" : "tab_not_selected" };
    };
    if (targetKey !== "IMAGE") {
      if (targetKey === "VIDEO") {
        const framesActive = findVisibleModeTab("-trigger-VIDEO_FRAMES")?.getAttribute("aria-selected") === "true";
        const ingredientsActive = findVisibleModeTab("-trigger-VIDEO_REFERENCES")?.getAttribute("aria-selected") === "true";
        if (framesActive || ingredientsActive) {
          const imageReseat = await clickTab("-trigger-IMAGE");
          if (!imageReseat.ok) return { attempted: true, clicked: false, suffix, error: imageReseat.error, menu, clicked, reseat: "image_first" };
          await ensureComposerSettingsMenuOpen();
        }
      }
      const topVideo = await clickTab("-trigger-VIDEO");
      if (!topVideo.ok) return { attempted: true, clicked: false, suffix, error: topVideo.error, menu, clicked };
      if (targetKey === "VIDEO_FRAMES" || targetKey === "VIDEO_REFERENCES" || targetKey === "INGREDIENTS") {
        const sub = await clickTab(suffix);
        if (!sub.ok) return { attempted: true, clicked: false, suffix, error: sub.error, menu, clicked };
      }
    } else {
      const topImage = await clickTab("-trigger-IMAGE");
      if (!topImage.ok) return { attempted: true, clicked: false, suffix, error: topImage.error, menu, clicked };
    }
    return {
      attempted: true,
      clicked: true,
      clickedTabs: clicked,
      suffix,
      ariaSelected: clicked[clicked.length - 1]?.ariaSelected === true
    };
  }

  function modelLabelPatternForTask(task = {}) {
    const mode = String(task.mode || "");
    const raw = String(task.model || "default").trim();
    if (mode === "ingredients-to-video") {
      if (raw === "veo3_fast") return /^Veo 3\.1\s*-\s*Fast$/i;
      return /Veo 3\.1\s*-\s*Fast\s*\[Lower Priority\]/i;
    }
    if (raw === "veo3_lite") return /^Veo 3\.1\s*-\s*Lite$/i;
    if (raw === "veo3_fast") return /^Veo 3\.1\s*-\s*Fast$/i;
    if (raw === "veo3_fast_low") return /Veo 3\.1\s*-\s*Fast\s*\[Lower Priority\]/i;
    if (raw === "veo3_quality") return /^Veo 3\.1\s*-\s*Quality$/i;
    return /Veo 3\.1\s*-\s*Lite\s*\[Lower Priority\]/i;
  }

  function normalizeModelLabelText(text = "") {
    return String(text || "")
      .replace(/\b(arrow_drop_down|volume_up|volume_off)\b/gi, " ")
      .replace(/\(leaving\s+\d+\/\d+\)/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function findModelDropdownButton() {
    return Array.from(document.querySelectorAll("button[aria-haspopup='menu']"))
      .filter(isVisibleElement)
      .find((node) => /Veo\s+\d/i.test(visibleText(node)) && /arrow_drop_down/i.test(visibleText(node))) || null;
  }

  function findModelMenuItem(pattern) {
    const candidates = Array.from(document.querySelectorAll("[role='menuitem'], button"))
      .filter(isVisibleElement)
      .filter((node) => /Veo\s+\d/i.test(visibleText(node)));
    return candidates.find((node) => pattern.test(normalizeModelLabelText(visibleText(node)))) || null;
  }

  async function applyVisibleVideoModel(task = {}) {
    const pattern = modelLabelPatternForTask(task);
    let current = findModelDropdownButton();
    if (current && pattern.test(normalizeModelLabelText(visibleText(current)))) {
      return { ok: true, skipped: true, selected: visibleText(current), normalizedSelected: normalizeModelLabelText(visibleText(current)) };
    }
    if (!current) return { ok: false, error: "DOM_MODEL_DROPDOWN_NOT_FOUND" };
    pointerClick(current);
    await sleep(260);
    const item = findModelMenuItem(pattern);
    if (!item) return {
      ok: false,
      error: "DOM_MODEL_OPTION_NOT_FOUND",
      requestedModel: String(task.model || "default"),
      currentText: current ? visibleText(current) : "",
      currentNormalized: current ? normalizeModelLabelText(visibleText(current)) : "",
      visibleVeoItems: summarizeVisibleVeoMenuItems(20)
    };
    const selected = visibleText(item);
    pointerClick(item);
    await sleep(420);
    current = findModelDropdownButton();
    return {
      ok: !current || pattern.test(normalizeModelLabelText(visibleText(current))),
      clicked: true,
      selected,
      normalizedSelected: normalizeModelLabelText(selected),
      currentText: current ? visibleText(current) : "",
      currentNormalized: current ? normalizeModelLabelText(visibleText(current)) : "",
      error: !current || pattern.test(normalizeModelLabelText(visibleText(current))) ? "" : "DOM_MODEL_NOT_SELECTED"
    };
  }

  async function applyVisibleComposerVideoSettings(task = {}) {
    const mode = String(task.mode || "");
    if (!mode || mode === "text-to-image") return { ok: true, skipped: true };
    const menu = await ensureComposerSettingsMenuOpen();
    if (!menu.ok) return { ok: false, error: menu.error || "COMPOSER_SETTINGS_MENU_NOT_OPEN" };
    const settings = [];
    const aspect = normalizeDomAspectRatio(task.aspectRatio);
    const repeat = Math.max(1, Math.min(4, Number.parseInt(task.repeatCount, 10) || 1));
    const duration = domVideoDurationForTask(task);
    settings.push(await clickVisibleTabBySuffix(`-trigger-${aspect}`));
    settings.push(await clickVisibleTabByText(repeat === 1 ? /^1x$/i : new RegExp(`^x${repeat}$`, "i"), `outputs:${repeat}`));
    settings.push(await clickVisibleTabByText(new RegExp(`^${duration}s$`, "i"), `duration:${duration}`));
    const bad = settings.find((item) => !item.ok);
    if (bad) return { ok: false, error: `DOM_VISIBLE_SETTING_NOT_SELECTED:${bad.suffix || bad.label || ""}`, settings };
    const model = await applyVisibleVideoModel(task);
    if (!model.ok) return { ok: false, error: model.error || "DOM_MODEL_NOT_SELECTED", settings, model };
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    await sleep(120);
    return { ok: true, settings, model, repeat, duration, aspect };
  }

  async function ensureDomTaskMode(task = {}) {
    const desired = desiredStoreModesForTask(task);
    if (!desired.target) return { ok: true, skipped: true, storeMode: "" };
    const store = resolvePromptStore();
    if (!store) return { ok: false, error: "PROMPT_STORE_NOT_FOUND", targetMode: desired.target };
    const beforeMode = String(store.getState?.()?.mode || "");
    let domTabClick = { attempted: false };
    try {
      domTabClick = await clickFlowModeTabForTarget(desired.target);
    } catch (error) {
      domTabClick = { attempted: false, error: String(error?.message || error || "dom_tab_click_threw") };
    }
    if (domTabClick.error) {
      return {
        ok: false,
        error: domTabClick.error,
        storeMode: String(store.getState?.()?.mode || ""),
        previousMode: beforeMode,
        targetMode: desired.target,
        acceptableModes: desired.acceptable,
        domTabClick
      };
    }
    for (let remain = 1800; remain > 0; remain -= 150) {
      await sleep(150);
      const currentMode = String(store.getState?.()?.mode || "");
      const keys = store.getState?.()?.currentModelKeys || {};
      const hasVideoApi = desired.target === "IMAGE" || Boolean(keys.videoApi);
      if (desired.acceptable.includes(currentMode) && hasVideoApi) {
        return { ok: true, skipped: false, storeMode: currentMode, previousMode: beforeMode, targetMode: desired.target, domTabClick };
      }
    }
    return {
      ok: false,
      error: "DOM_MODE_NOT_PERSISTED",
      storeMode: String(store.getState?.()?.mode || ""),
      previousMode: beforeMode,
      targetMode: desired.target,
      acceptableModes: desired.acceptable,
      domTabClick
    };
  }

  function normalizeDomVideoDuration(value = "8") {
    const raw = String(value || "").trim();
    return raw === "4" || raw === "6" || raw === "8" ? raw : "8";
  }

  function domVideoDurationForTask(task = {}) {
    if (String(task.mode || "") === "ingredients-to-video") return "8";
    return normalizeDomVideoDuration(task.videoLength || task.videoDurationSeconds || "8");
  }

  function normalizeDomAspectRatio(value = "landscape") {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "portrait" || raw === "portrait_3_4" || raw === "9:16") return "PORTRAIT";
    if (raw === "square" || raw === "1:1") return "SQUARE";
    return "LANDSCAPE";
  }

  function domVideoModelKeys(task = {}) {
    const mode = String(task.mode || "");
    const duration = domVideoDurationForTask(task);
    const rawModel = String(task.model || "default").trim().toLowerCase();
    const aspect = normalizeDomAspectRatio(task.aspectRatio);
    const isPortrait = aspect === "PORTRAIT";
    const hasEndImage = Boolean(task.endMediaId || task.endRefInput);
    const isFastLowerPriority = rawModel === "veo3_fast_low" || rawModel.includes("fast_low") || rawModel.includes("lower");
    const isFast = !isFastLowerPriority && (rawModel === "veo3_fast" || rawModel.includes("fast"));
    if (mode === "text-to-video") {
      if (rawModel === "veo3_quality" || rawModel.includes("quality")) {
        return {
          videoApi: "batchAsyncGenerateVideoText",
          videoModelKey: duration === "4"
            ? "veo_3_1_t2v_quality_4s"
            : (duration === "6" ? "veo_3_1_t2v_quality_6s" : (isPortrait ? "veo_3_1_t2v_portrait" : "veo_3_1_t2v"))
        };
      }
      if (isFastLowerPriority) {
        return {
          videoApi: "batchAsyncGenerateVideoText",
          videoModelKey: duration === "4"
            ? "veo_3_1_t2v_fast_4s_relaxed"
            : (duration === "6" ? "veo_3_1_t2v_fast_6s_relaxed" : (isPortrait ? "veo_3_1_t2v_fast_portrait_ultra_relaxed" : "veo_3_1_t2v_fast_ultra_relaxed"))
        };
      }
      if (isFast) {
        return {
          videoApi: "batchAsyncGenerateVideoText",
          videoModelKey: duration === "4"
            ? "veo_3_1_t2v_fast_4s"
            : (duration === "6" ? "veo_3_1_t2v_fast_6s" : (isPortrait ? "veo_3_1_t2v_fast_portrait_ultra" : "veo_3_1_t2v_fast_ultra"))
        };
      }
      return {
        videoApi: "batchAsyncGenerateVideoText",
        videoModelKey: duration === "4"
          ? "veo_3_1_t2v_lite_4s_low_priority"
          : (duration === "6" ? "veo_3_1_t2v_lite_6s_low_priority" : "veo_3_1_t2v_lite_low_priority")
      };
    }
    if (mode === "image-to-video" || mode === "start-end-image-to-video") {
      if (rawModel === "veo3_quality" || rawModel.includes("quality")) {
        return {
          videoApi: hasEndImage ? "batchAsyncGenerateVideoStartAndEndImage" : "batchAsyncGenerateVideoStartImage",
          videoModelKey: duration === "4"
            ? (hasEndImage ? "veo_3_1_i2v_s_quality_4s_fl" : "veo_3_1_i2v_s_quality_4s")
            : (duration === "6"
                ? (hasEndImage ? "veo_3_1_i2v_s_quality_6s_fl" : "veo_3_1_i2v_s_quality_6s")
                : (hasEndImage
                    ? (isPortrait ? "veo_3_1_i2v_s_portrait_fl" : "veo_3_1_i2v_s_fl")
                    : (isPortrait ? "veo_3_1_i2v_s_portrait" : "veo_3_1_i2v_s")))
        };
      }
      if (isFastLowerPriority) {
        return {
          videoApi: hasEndImage ? "batchAsyncGenerateVideoStartAndEndImage" : "batchAsyncGenerateVideoStartImage",
          videoModelKey: duration === "4"
            ? (hasEndImage ? "veo_3_1_i2v_s_fast_4s_fl_relaxed" : "veo_3_1_i2v_s_fast_4s_relaxed")
            : (duration === "6"
                ? (hasEndImage ? "veo_3_1_i2v_s_fast_6s_fl_relaxed" : "veo_3_1_i2v_s_fast_6s_relaxed")
                : (hasEndImage
                    ? (isPortrait ? "veo_3_1_i2v_s_fast_portrait_fl_ultra_relaxed" : "veo_3_1_i2v_s_fast_fl_ultra_relaxed")
                    : (isPortrait ? "veo_3_1_i2v_s_fast_portrait_ultra_relaxed" : "veo_3_1_i2v_s_fast_ultra_relaxed")))
        };
      }
      if (isFast) {
        return {
          videoApi: hasEndImage ? "batchAsyncGenerateVideoStartAndEndImage" : "batchAsyncGenerateVideoStartImage",
          videoModelKey: duration === "4"
            ? (hasEndImage ? "veo_3_1_i2v_s_fast_4s_fl" : "veo_3_1_i2v_s_fast_4s")
            : (duration === "6"
                ? (hasEndImage ? "veo_3_1_i2v_s_fast_6s_fl" : "veo_3_1_i2v_s_fast_6s")
                : (hasEndImage
                    ? (isPortrait ? "veo_3_1_i2v_s_fast_portrait_fl_ultra" : "veo_3_1_i2v_s_fast_fl_ultra")
                    : (isPortrait ? "veo_3_1_i2v_s_fast_portrait_ultra" : "veo_3_1_i2v_s_fast_ultra")))
        };
      }
      if (hasEndImage) {
        return {
          videoApi: "batchAsyncGenerateVideoStartAndEndImage",
          videoModelKey: duration === "4"
            ? "veo_3_1_interpolation_lite_4s_low_priority"
            : (duration === "6" ? "veo_3_1_interpolation_lite_6s_low_priority" : "veo_3_1_interpolation_lite_low_priority")
        };
      }
      return {
        videoApi: "batchAsyncGenerateVideoStartImage",
        videoModelKey: duration === "4"
          ? "veo_3_1_i2v_s_lite_4s_low_priority"
          : (duration === "6" ? "veo_3_1_i2v_s_lite_6s_low_priority" : "veo_3_1_i2v_lite_low_priority")
      };
    }
    if (mode === "ingredients-to-video") {
      const relaxed = !isFast;
      return {
        videoApi: "batchAsyncGenerateVideoReferenceImages",
        videoModelKey: aspect === "PORTRAIT"
          ? (relaxed ? "veo_3_1_r2v_fast_portrait_ultra_relaxed" : "veo_3_1_r2v_fast_portrait")
          : (relaxed ? "veo_3_1_r2v_fast_landscape_ultra_relaxed" : "veo_3_1_r2v_fast_landscape")
      };
    }
    return null;
  }

  function visibleModeForDomTask(task = {}) {
    const mode = String(task.mode || "");
    // Flow's visible top-level "Video" tab uses VIDEO_FRAMES in the prompt store.
    // Forcing VIDEO leaves T2V looking enabled but submit produces no request.
    if (mode === "text-to-video") return "VIDEO_FRAMES";
    if (mode === "image-to-video" || mode === "start-end-image-to-video") return "VIDEO_FRAMES";
    if (mode === "ingredients-to-video") return "VIDEO_REFERENCES";
    if (mode === "text-to-image") return "IMAGE";
    return "";
  }

  function syncPromptStoreToVisibleVideoSettings(store, task = {}, visibleSettings = {}) {
    if (!store?.setState || visibleSettings?.skipped === true) return { attempted: false };
    const mode = visibleModeForDomTask(task);
    const actions = store.getState?.()?.actions || {};
    const projectId = projectIdFromUrl();
    const modelKeys = domVideoModelKeys(task);
    const patch = {
      outputsPerPrompt: visibleSettings.repeat,
      selectedVideoDuration: Number(visibleSettings.duration || domVideoDurationForTask(task)),
      aspectRatio: visibleSettings.aspect || normalizeDomAspectRatio(task.aspectRatio)
    };
    if (mode) patch.mode = mode;
    if (modelKeys) {
      patch.currentModelKeys = {
        ...(store.getState?.()?.currentModelKeys || {}),
        ...modelKeys
      };
    }
    try {
      if (projectId && typeof actions.setCollectionOrWorkflowId === "function") {
        actions.setCollectionOrWorkflowId({ collectionId: projectId, workflowId: projectId });
      }
      if (mode && typeof actions.setMode === "function") actions.setMode(mode);
      else if (mode) store.setState({ mode });
      if (typeof actions.setAspectRatio === "function") actions.setAspectRatio(patch.aspectRatio);
      if (typeof actions.setOutputsPerPrompt === "function") actions.setOutputsPerPrompt(patch.outputsPerPrompt);
      if (typeof actions.setSelectedVideoDuration === "function") actions.setSelectedVideoDuration(patch.selectedVideoDuration);
      if (modelKeys && typeof actions.setCurrentModelKeys === "function") {
        actions.setCurrentModelKeys(modelKeys);
      }
      store.setState(patch);
      const after = store.getState?.() || {};
      return {
        attempted: true,
        ok: true,
        mode: String(after.mode || ""),
        collectionOrWorkflowId: after.inputs?.collectionOrWorkflowId || null,
        outputsPerPrompt: after.outputsPerPrompt,
        selectedVideoDuration: after.selectedVideoDuration,
        videoApi: String(after.currentModelKeys?.videoApi || ""),
        videoModelKey: String(after.currentModelKeys?.videoModelKey || "")
      };
    } catch (error) {
      return { attempted: true, ok: false, error: String(error?.message || error || "STORE_VISIBLE_SYNC_FAILED") };
    }
  }

  async function applyDomTaskSettings(task = {}) {
    const mode = String(task.mode || "");
    const store = resolvePromptStore();
    if (!store) return { ok: false, error: "PROMPT_STORE_NOT_FOUND" };
    const before = store.getState?.() || {};
    const actions = before.actions || {};
    try {
      if (typeof actions.clearIngredients === "function") {
        actions.clearIngredients();
      }
      if (typeof actions.setPrompt === "function") {
        actions.setPrompt("");
      }
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message || error || "DOM_SETTINGS_APPLY_FAILED"),
        beforeMode: String(before.mode || ""),
        beforeVideoApi: String(before.currentModelKeys?.videoApi || "")
      };
    }
    const visibleSettings = await applyVisibleComposerVideoSettings(task);
    if (!visibleSettings.ok) {
      return {
        ok: false,
        error: visibleSettings.error || "DOM_VISIBLE_SETTINGS_APPLY_FAILED",
        beforeMode: String(before.mode || ""),
        beforeVideoApi: String(before.currentModelKeys?.videoApi || ""),
        visibleSettings
      };
    }
    const storeSync = syncPromptStoreToVisibleVideoSettings(store, task, visibleSettings);
    await sleep(80);
    const after = store.getState?.() || {};
    const ingredientOk = !Array.isArray(after.ingredients) || after.ingredients.length === 0;
    return {
      ok: ingredientOk,
      mode,
      settingsApplied: visibleSettings.skipped !== true,
      settingsSkipped: visibleSettings.skipped === true,
      reason: visibleSettings.skipped === true ? "dom_visible_settings_skipped_for_mode" : "dom_visible_settings_applied",
      visibleSettings,
      storeSync,
      beforeMode: String(before.mode || ""),
      afterMode: String(after.mode || ""),
      beforeVideoApi: String(before.currentModelKeys?.videoApi || ""),
      afterVideoApi: String(after.currentModelKeys?.videoApi || ""),
      beforeVideoModelKey: String(before.currentModelKeys?.videoModelKey || ""),
      afterVideoModelKey: String(after.currentModelKeys?.videoModelKey || ""),
      ingredientCount: Array.isArray(after.ingredients) ? after.ingredients.length : 0,
      error: ingredientOk ? "" : "DOM_STALE_INGREDIENTS_NOT_CLEARED"
    };
  }

  function validateDomTaskSettingsState(task = {}) {
    const mode = String(task.mode || "");
    if (!mode) return { ok: true, skipped: true, problems: [] };
    const store = resolvePromptStore();
    const state = store?.getState?.() || null;
    if (!state) return { ok: false, problems: ["store_missing"] };
    const expectedMode = visibleModeForDomTask(task);
    const expectedRepeat = Math.max(1, Math.min(4, Number.parseInt(task.repeatCount, 10) || 1));
    const expectedDuration = Number(domVideoDurationForTask(task));
    const expectedAspect = normalizeDomAspectRatio(task.aspectRatio);
    const expectedKeys = domVideoModelKeys(task) || {};
    const actualKeys = state.currentModelKeys || {};
    const problems = [];
    if (expectedMode && String(state.mode || "") !== expectedMode) {
      problems.push(`mode:${String(state.mode || "") || "missing"}!=${expectedMode}`);
    }
    if (expectedAspect && String(state.aspectRatio || "") !== expectedAspect) {
      problems.push(`aspect:${String(state.aspectRatio || "") || "missing"}!=${expectedAspect}`);
    }
    if (Number(state.outputsPerPrompt || 0) !== expectedRepeat) {
      problems.push(`repeat:${state.outputsPerPrompt ?? "missing"}!=${expectedRepeat}`);
    }
    if (mode !== "text-to-image" && mode !== "ingredients-to-video" && Number(state.selectedVideoDuration || 0) !== expectedDuration) {
      problems.push(`duration:${state.selectedVideoDuration ?? "missing"}!=${expectedDuration}`);
    }
    if (shouldValidateDomVideoModelKeys(task)) {
      if (expectedKeys.videoApi && String(actualKeys.videoApi || "") !== expectedKeys.videoApi) {
        problems.push(`videoApi:${String(actualKeys.videoApi || "") || "missing"}!=${expectedKeys.videoApi}`);
      }
      if (expectedKeys.videoModelKey && String(actualKeys.videoModelKey || "") !== expectedKeys.videoModelKey) {
        problems.push(`videoModelKey:${String(actualKeys.videoModelKey || "") || "missing"}!=${expectedKeys.videoModelKey}`);
      }
    }
    return {
      ok: problems.length === 0,
      problems,
      expected: {
        mode: expectedMode,
        aspect: expectedAspect,
        repeat: expectedRepeat,
        duration: expectedDuration,
        currentModelKeys: expectedKeys
      },
      actual: {
        mode: String(state.mode || ""),
        aspect: String(state.aspectRatio || ""),
        repeat: state.outputsPerPrompt ?? null,
        duration: state.selectedVideoDuration ?? null,
        currentModelKeys: {
          videoApi: String(actualKeys.videoApi || ""),
          videoModelKey: String(actualKeys.videoModelKey || "")
        }
      }
    };
  }

  async function domSyncTaskSettingsForDebugger(task = {}, meta = {}) {
    const taskId = String(task.id || "");
    const mode = String(task.mode || "");
    const emitDomStage = (stage, extra = {}) => {
      emit({
        type: "dom_submit_stage",
        taskId,
        mode,
        stage,
        transport: "chrome_debugger",
        ...extra,
        domTrace: summarizeDomAutomationTrace(task)
      });
    };
    const store = resolvePromptStore();
    if (!store) {
      emitDomStage(meta.validateOnly === true ? "debugger_settings_state_validate" : "debugger_settings_state_sync", { ok: false, error: "PROMPT_STORE_NOT_FOUND", reason: meta.reason || "" });
      return { ok: false, action: "domSyncTaskSettingsForDebugger", error: "PROMPT_STORE_NOT_FOUND", failClosed: true };
    }
    const visibleSettings = {
      ok: true,
      repeat: Math.max(1, Math.min(4, Number.parseInt(task.repeatCount, 10) || 1)),
      duration: domVideoDurationForTask(task),
      aspect: normalizeDomAspectRatio(task.aspectRatio)
    };
    const before = validateDomTaskSettingsState(task);
    const storeSync = meta.validateOnly === true
      ? { ok: true, skipped: true, reason: "visible_settings_validate_only" }
      : syncPromptStoreToVisibleVideoSettings(store, task, visibleSettings);
    await sleep(120);
    const validation = validateDomTaskSettingsState(task);
    const trace = summarizeDomAutomationTrace(task);
    emitDomStage(meta.validateOnly === true ? "debugger_settings_state_validate" : "debugger_settings_state_sync", {
      ok: Boolean(validation.ok),
      error: validation.ok ? "" : "DOM_DEBUGGER_SETTINGS_STATE_INVALID",
      reason: meta.reason || "",
      validateOnly: meta.validateOnly === true,
      before,
      storeSync,
      validation
    });
    return {
      ok: Boolean(validation.ok),
      action: "domSyncTaskSettingsForDebugger",
      error: validation.ok ? "" : "DOM_DEBUGGER_SETTINGS_STATE_INVALID",
      reason: meta.reason || "",
      validateOnly: meta.validateOnly === true,
      before,
      storeSync,
      validation,
      expected: trace.expected || null,
      visible: trace.visible || null,
      store: trace.store || null,
      createButton: trace.createButton || null,
      failClosed: !validation.ok
    };
  }

  function pointerClick(element, options = {}) {
    if (!element) return false;
    try {
      const rect = element.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0
      };
      try {
        element.dispatchEvent(new PointerEvent("pointerover", { ...opts, pointerId: 1 }));
        element.dispatchEvent(new PointerEvent("pointermove", { ...opts, pointerId: 1 }));
      } catch {}
      const pointerDown = new PointerEvent("pointerdown", { ...opts, pointerId: 1 });
      element.dispatchEvent(pointerDown);
      element.dispatchEvent(new MouseEvent("mouseover", opts));
      element.dispatchEvent(new MouseEvent("mousemove", opts));
      element.dispatchEvent(new MouseEvent("mousedown", opts));
      try {
        element.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
      } catch {}
      element.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1 }));
      element.dispatchEvent(new MouseEvent("mouseup", opts));
      if (!pointerDown.defaultPrevented) {
        element.dispatchEvent(new MouseEvent("click", opts));
      }
      if (options.nativeClick) element.click?.();
      return true;
    } catch {
      try {
        element.click();
        return true;
      } catch {
        return false;
      }
    }
  }

  function findReactClick(element, depth = 6) {
    if (!element || depth < 0) return null;
    try {
      const reactKey = Object.keys(element).find((key) => key.startsWith("__reactProps"));
      if (reactKey && typeof element[reactKey]?.onClick === "function") {
        return { element, props: element[reactKey] };
      }
    } catch {}
    for (const child of Array.from(element.children || [])) {
      const found = findReactClick(child, depth - 1);
      if (found) return found;
    }
    return null;
  }

  function invokeReactClick(element) {
    const reactClick = findReactClick(element, 6);
    if (!reactClick) return false;
    try {
      reactClick.props.onClick({
        preventDefault: () => {},
        stopPropagation: () => {},
        nativeEvent: { stopImmediatePropagation: () => {} },
        target: reactClick.element,
        currentTarget: reactClick.element,
        type: "click"
      });
      return true;
    } catch {
      return false;
    }
  }

  function materialIconTokens(element) {
    const tokens = new Set();
    for (const node of Array.from(
      element?.querySelectorAll?.(
        "i,.material-symbols,.material-symbols-outlined,.material-symbols-rounded,.google-symbols,[class*='material-symbol']"
      ) || []
    )) {
      const token = compact(node.textContent || "").toLowerCase();
      if (!token) continue;
      tokens.add(token);
      // Some Flow icon glyphs render with their first character visually clipped
      // in the automation context. Keep critical selectors tolerant without
      // falling back to English labels.
      if (token === "wap_horiz" || token.endsWith("wap_horiz")) tokens.add("swap_horiz");
    }
    return tokens;
  }

  function isAssetBrowserRoot(root) {
    if (!root || !root.isConnected || !visibleElement(root)) return false;
    return Boolean(
      root.querySelector("input[type='file'],input[type='search'],input[type='text'],[data-virtuoso-scroller],img")
    );
  }

  function findAssetBrowserRoot() {
    const roots = [
      ...Array.from(document.querySelectorAll("[role='dialog']")),
      ...Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper]")),
      ...Array.from(document.querySelectorAll("[data-radix-portal]"))
    ];
    return roots.find((root) => isAssetBrowserRoot(root)) || null;
  }

  function findFrameSlot(ingredientType = "FIRST_FRAME") {
    const editor = findPromptEditor();
    if (!editor) return null;
    const rejectNavControl = (element) => {
      const icons = materialIconTokens(element);
      const text = visibleText(element);
      return icons.has("archive")
        || icons.has("delete")
        || icons.has("dashboard")
        || icons.has("search")
        || icons.has("filter_list")
        || icons.has("arrow_back")
        || /archive|delete|search|filter|normal view|go back/i.test(text);
    };
    const scopeNode = editor.closest?.("form,section,main,[data-type='composer']") || document;
    const swapButton = Array.from(scopeNode.querySelectorAll("button"))
      .find((button) => {
        if (!visibleElement(button) || rejectNavControl(button) || !materialIconTokens(button).has("swap_horiz")) return false;
        return true;
      });
    if (swapButton?.parentElement) {
      const siblings = Array.from(swapButton.parentElement.children)
        .filter((child) => child !== swapButton && child.isConnected && visibleElement(child))
        .filter((child) => {
          const rect = child.getBoundingClientRect();
          return !rejectNavControl(child)
            && rect.width >= 28 && rect.width <= 140 && rect.height >= 28 && rect.height <= 140;
        });
      if (siblings.length) return ingredientType === "LAST_FRAME" ? siblings[siblings.length - 1] : siblings[0];
    }
    const editorRect = editor.getBoundingClientRect();
    const fallbackSlots = Array.from(scopeNode.querySelectorAll('div[type="button"][data-state],button[data-state],[role="button"]'))
      .filter((element) => {
        if (!visibleElement(element)) return false;
        if (rejectNavControl(element)) return false;
        const rect = element.getBoundingClientRect();
        const nearComposer = rect.top >= editorRect.top - 140 && rect.bottom <= editorRect.bottom + 40;
        return nearComposer && rect.width >= 30 && rect.width <= 160 && rect.height >= 30 && rect.height <= 160;
      });
    return ingredientType === "LAST_FRAME" ? fallbackSlots[fallbackSlots.length - 1] || null : fallbackSlots[0] || null;
  }

  function frameSlotLooksFilled(ingredientType = "FIRST_FRAME") {
    const slot = findFrameSlot(ingredientType);
    if (!slot) return false;
    if (slot.querySelector?.("img,video,canvas,[data-testid],[role='img']")) return true;
    try {
      if (slot.style?.backgroundImage && slot.style.backgroundImage !== "none") return true;
      return Array.from(slot.querySelectorAll?.("[style*='background-image']") || [])
        .some((element) => element.style?.backgroundImage && element.style.backgroundImage !== "none");
    } catch {
      return false;
    }
  }

  async function clearVisibleFrameSlot(ingredientType = "FIRST_FRAME", onStage = null) {
    const emitStage = (stage, extra = {}) => {
      try {
        if (typeof onStage === "function") onStage(stage, extra);
      } catch {}
    };
    if (!frameSlotLooksFilled(ingredientType)) return { ok: true, cleared: false, reason: "already_empty" };
    const slot = findFrameSlot(ingredientType);
    if (!slot) return { ok: false, cleared: false, error: "FRAME_SLOT_NOT_FOUND" };
    const rect = slot.getBoundingClientRect?.() || {};
    const scope = slot.closest?.("form,section,main,[data-type='composer']") || document;
    const slotText = visibleText(slot);
    const slotIcons = materialIconTokens(slot);
    const slotLooksLikeClear = slotIcons.has("cancel")
      || slotIcons.has("close")
      || /cancel|close|remove/i.test(slotText);
    const scopedButtons = [
      ...(slotLooksLikeClear ? [slot] : []),
      ...Array.from(slot.querySelectorAll?.("button,[role='button']") || []),
      ...Array.from(scope.querySelectorAll("button,[role='button']"))
    ];
    const clearButtons = [...new Set(scopedButtons)]
      .filter(visibleElement)
      .map((node) => ({ node, rect: node.getBoundingClientRect(), text: visibleText(node), icons: materialIconTokens(node) }))
      .filter((item) => {
        const nearSlot = item.rect.left >= Number(rect.left || 0) - 20
          && item.rect.right <= Number(rect.right || 0) + 80
          && item.rect.top >= Number(rect.top || 0) - 20
          && item.rect.bottom <= Number(rect.bottom || 0) + 80;
        const tokenHit = item.icons.has("cancel") || item.icons.has("close") || /cancel|close|remove/i.test(item.text);
        return nearSlot && tokenHit;
      })
      .sort((a, b) => {
        const da = Math.abs((a.rect.left + a.rect.right) / 2 - ((rect.left || 0) + (rect.right || 0)) / 2);
        const db = Math.abs((b.rect.left + b.rect.right) / 2 - ((rect.left || 0) + (rect.right || 0)) / 2);
        return da - db;
      });
    const clearButton = clearButtons[0]?.node || null;
    emitStage("dom_frame_visible_slot_clear_start", {
      ingredientType,
      found: Boolean(clearButton),
      text: clearButton ? visibleText(clearButton).slice(0, 80) : ""
    });
    if (!clearButton) return { ok: false, cleared: false, error: "FRAME_SLOT_CLEAR_BUTTON_NOT_FOUND" };
    const reactClicked = invokeReactClick(clearButton);
    if (!reactClicked) pointerClick(clearButton);
    try {
      clearButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      clearButton.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
    } catch {}
    for (let remain = 2400; remain > 0; remain -= 160) {
      await sleep(160);
      if (!frameSlotLooksFilled(ingredientType)) {
        emitStage("dom_frame_visible_slot_clear_done", { ingredientType, ok: true });
        return { ok: true, cleared: true };
      }
    }
    emitStage("dom_frame_visible_slot_clear_done", { ingredientType, ok: false, error: "FRAME_SLOT_STILL_FILLED" });
    return { ok: false, cleared: false, error: "FRAME_SLOT_STILL_FILLED" };
  }

  async function clearFrameSlotForReplacement(store, ingredientType = "FIRST_FRAME", onStage = null, context = {}) {
    const emitStage = (stage, extra = {}) => {
      try {
        if (typeof onStage === "function") onStage(stage, extra);
      } catch {}
    };
    const fileName = context.fileName || "";
    const previousRoleImageId = roleImageId(store, ingredientType);
    const clearedRoleCount = previousRoleImageId ? clearRoleIngredient(store, ingredientType) : 0;
    emitStage("dom_frame_slot_replace_role_clear", {
      ingredientType,
      fileName,
      cleared: clearedRoleCount,
      previousRoleImageId,
      reason: context.reason || "replace_frame_slot"
    });
    if (clearedRoleCount > 0) {
      for (let remain = 2200; remain > 0; remain -= 160) {
        await sleep(160);
        if (!roleImageId(store, ingredientType)) break;
      }
    }
    if (!frameSlotLooksFilled(ingredientType)) {
      return { ok: true, clearedRoleCount, visibleCleared: false, previousRoleImageId };
    }
    const visibleClear = await clearVisibleFrameSlot(ingredientType, emitStage);
    emitStage("dom_frame_slot_replace_visible_clear", {
      ingredientType,
      fileName,
      ok: Boolean(visibleClear?.ok),
      cleared: Boolean(visibleClear?.cleared),
      error: visibleClear?.error || "",
      reason: visibleClear?.reason || "",
      replaceWillProceed: true
    });
    return {
      ok: true,
      clearedRoleCount,
      visibleCleared: Boolean(visibleClear?.cleared),
      visibleClearOk: Boolean(visibleClear?.ok),
      visibleClearError: visibleClear?.error || "",
      previousRoleImageId
    };
  }

  async function openAssetBrowserFromFrameSlot(ingredientType = "FIRST_FRAME") {
    const already = findAssetBrowserRoot();
    if (already) return already;
    let slot = findFrameSlot(ingredientType);
    if (!slot) return null;
    try { slot.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch {}
    const openAttempts = [
      () => pointerClick(slot),
      () => {
        try {
          slot.focus?.({ preventScroll: true });
          slot.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
          slot.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
          return true;
        } catch {
          return false;
        }
      },
      () => {
        try {
          slot.click?.();
          return true;
        } catch {
          return false;
        }
      }
    ];
    for (const attempt of openAttempts) {
      attempt();
      for (let remain = 2600; remain > 0; remain -= 180) {
        await sleep(180);
        const root = findAssetBrowserRoot();
        if (root) return root;
      }
      slot = findFrameSlot(ingredientType) || slot;
    }
    return null;
  }

  function findAssetSearchInput(root = null) {
    const scope = root || findAssetBrowserRoot() || document;
    return Array.from(scope.querySelectorAll("input[type='search'],input[type='text']"))
      .filter((input) => visibleElement(input) && !input.disabled && !input.readOnly)
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      })[0] || null;
  }

  function collectComposerAddButtons(composeRoot = null, editorEl = null) {
    const scope = composeRoot || document;
    const roots = composeRoot ? [scope, document] : [scope];
    const candidates = [];
    for (const root of roots) {
      Array.from(root.querySelectorAll("button,[role='button']")).forEach((element) => {
        if (!visibleElement(element) || element.disabled || element.closest("[data-autoflow-rebuild],#af-bot-panel")) return;
        const icons = materialIconTokens(element);
        if (!(icons.has("add_2") || icons.has("add") || icons.has("add_photo_alternate"))) return;
        if (icons.has("arrow_forward") || icons.has("send")) return;
        if (!candidates.includes(element)) candidates.push(element);
      });
    }
    const editorRect = editorEl?.getBoundingClientRect?.() || null;
    return candidates
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const icons = materialIconTokens(element);
        let score = 0;
        if (composeRoot && composeRoot.contains(element)) score += 70;
        if (icons.has("add_2")) score += 60;
        if (icons.has("add_photo_alternate")) score += 45;
        if (element.querySelector?.("[data-type='button-overlay']")) score += 30;
        if (editorRect) {
          const distance = Math.hypot(
            rect.left + rect.width / 2 - (editorRect.left + Math.min(64, editorRect.width / 4)),
            rect.top + rect.height / 2 - (editorRect.bottom - 12)
          );
          score -= distance * 0.18;
          if (distance > 420) score -= 220;
        }
        return { element, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.element);
  }

  async function openAssetBrowser() {
    const already = findAssetBrowserRoot();
    if (already) return already;
    const editor = findPromptEditor();
    const composeRoot = editor?.closest?.("form,section,main,[data-type='composer']") || null;
    for (const button of collectComposerAddButtons(composeRoot, editor)) {
      pointerClick(button);
      for (let remain = 3500; remain > 0; remain -= 200) {
        await sleep(200);
        const root = findAssetBrowserRoot();
        if (root) return root;
      }
    }
    return null;
  }

  async function ensureAssetImageTab(root = null) {
    const scope = root || findAssetBrowserRoot() || document;
    const tab = Array.from(scope.querySelectorAll("button[role='tab'],[role='tab'],button,[role='button']"))
      .filter((element) => visibleElement(element))
      .find((element) => {
        const icons = materialIconTokens(element);
        return (icons.has("image") || icons.has("add_photo_alternate")) && !icons.has("voice_selection");
      });
    if (!tab) return { ok: true, skipped: true };
    const wasActive = tab.getAttribute("aria-selected") === "true" || tab.getAttribute("data-state") === "active";
    if (!wasActive) {
      pointerClick(tab);
      await sleep(250);
    }
    return { ok: true, active: true, skipped: false };
  }

  function rowText(row) {
    if (!row) return "";
    const img = row.tagName === "IMG" ? row : row.querySelector("img");
    return compact(`${row.textContent || ""} ${img?.alt || ""} ${img?.title || ""}`);
  }

  const ASSET_SEARCH_ICON_WORDS = new Set([
    "image",
    "photo",
    "insert_photo",
    "add_photo_alternate",
    "videocam",
    "movie",
    "play_circle",
    "broken_image"
  ]);

  function cleanAssetSearchTerm(value = "") {
    let text = compact(String(value || "").replace(/\s+/g, " ")).trim();
    for (let index = 0; index < 3; index += 1) {
      const [first, ...rest] = text.split(/\s+/);
      if (!first || !ASSET_SEARCH_ICON_WORDS.has(first.toLowerCase())) break;
      text = rest.join(" ").trim();
    }
    return text;
  }

  function assetSearchTermWithoutExtension(value = "") {
    return cleanAssetSearchTerm(String(value || "").replace(/\.[a-z0-9]{2,6}$/i, ""));
  }

  function assetPickerSearchTermsForRef(ref = {}, extraTerms = []) {
    const textTerms = [];
    const pushText = (value = "") => {
      const cleaned = cleanAssetSearchTerm(value);
      if (cleaned) textTerms.push(cleaned);
      const base = assetSearchTermWithoutExtension(cleaned);
      if (base && base !== cleaned) textTerms.push(base);
    };
    [
      ...extraTerms,
      ref.fileName,
      ref.title
    ].forEach(pushText);
    const uniqueTextTerms = [...new Set(textTerms.map((term) => String(term || "").trim()).filter(Boolean))];
    if (uniqueTextTerms.length) return uniqueTextTerms;
    return [...new Set([
      ref.assetImageId,
      ref.mediaId
    ].map((term) => String(term || "").trim()).filter(Boolean))];
  }

  function extractMediaIdFromUrl(rawUrl = "") {
    const value = String(rawUrl || "");
    try {
      const parsed = new URL(value, location.href);
      const name = parsed.searchParams.get("name") || "";
      if (name) return name;
    } catch {}
    return value.match(/[?&]name=([^&#]+)/i)?.[1] || value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || "";
  }

  function collectFiberAssetIds(node, out = new Set()) {
    if (!node || typeof node !== "object") return out;
    const reactKeys = Object.keys(node).filter((key) => key.startsWith("__reactFiber") || key.startsWith("__reactProps"));
    for (const key of reactKeys) {
      let value = node[key];
      for (let depth = 0; value && depth < 30; depth += 1, value = value.return || null) {
        const candidates = [value.memoizedProps, value.memoizedState, value];
        for (const candidate of candidates) collectAssetLikeStrings(candidate, out);
      }
    }
    return out;
  }

  function collectAssetLikeStrings(value, out = new Set(), depth = 0) {
    if (!value || depth > 6) return out;
    if (typeof value === "string") {
      if (/^(fe_id_)?[0-9a-f-]{32,}$/i.test(value)) out.add(value);
      return out;
    }
    if (typeof value !== "object") return out;
    for (const [key, nested] of Object.entries(value)) {
      if (/imageId|assetImageId|selectedImageId|primaryMediaKey|workflowId|mediaId|name/i.test(key)) {
        collectAssetLikeStrings(nested, out, depth + 1);
      } else if (nested && typeof nested === "object" && depth < 2) {
        collectAssetLikeStrings(nested, out, depth + 1);
      }
    }
    return out;
  }

  function assetIdsFromRow(row) {
    const out = new Set();
    if (!row) return out;
    const nodes = [row, ...Array.from(row.querySelectorAll?.("img,[role='button'],button,[tabindex]") || [])];
    for (const node of nodes) {
      collectFiberAssetIds(node, out);
      if (node.tagName === "IMG") {
        const mediaId = extractMediaIdFromUrl(node.currentSrc || node.src || "");
        if (mediaId) {
          out.add(mediaId);
          out.add(`fe_id_${mediaId.replace(/^fe_id_/i, "")}`);
        }
      }
    }
    return out;
  }

  function describeAssetRows(rows = [], limit = 12) {
    return rows.slice(0, limit).map((row, index) => ({
      index,
      text: rowText(row).slice(0, 160),
      dataItemIndex: row?.getAttribute?.("data-item-index") || "",
      role: row?.getAttribute?.("role") || "",
      rect: domRectSummary(row),
      ids: [...assetIdsFromRow(row)].slice(0, 8),
      imageIds: Array.from(row?.querySelectorAll?.("img") || [])
        .map((img) => extractMediaIdFromUrl(img.currentSrc || img.src || ""))
        .filter(Boolean)
        .slice(0, 6)
    }));
  }

  async function resolveSelectableAssetRefForPicker(ref = {}, onStage = null, context = {}) {
    const emitStage = (stage, extra = {}) => {
      try {
        if (typeof onStage === "function") onStage(stage, extra);
      } catch {}
    };
    const fileName = safeUploadFileName(ref);
    const originalIds = frameStoreIdCandidates(ref);
    if (!fileName) return { ref, resolved: false, reason: "missing_file_name", originalIds };
    const uploadedAtMs = Date.parse(ref.uploadedAt || ref.uploadedAtIso || "") || 0;
    const projectMediaId = await Promise.race([
      latestProjectMediaIdForFile(fileName, uploadedAtMs),
      sleep(2600).then(() => "")
    ]);
    const tail = frameIdTail(projectMediaId || "");
    const resolvedRef = tail
      ? {
          ...ref,
          mediaId: tail,
          assetImageId: `fe_id_${tail}`
        }
      : ref;
    const result = {
      resolved: Boolean(tail),
      reason: tail ? "project_metadata_primary_media" : "project_metadata_missing",
      fileName,
      projectMediaId: tail,
      originalIds,
      resolvedIds: frameStoreIdCandidates(resolvedRef),
      uploadedAtMs,
      source: context.source || ""
    };
    emitStage("asset_ref_project_metadata", result);
    return { ...result, ref: resolvedRef };
  }

  function idsMatch(a = "", b = "") {
    const left = refSerializationVariants(a);
    const right = new Set(refSerializationVariants(b));
    return left.some((value) => right.has(value));
  }

  function listAssetRows(root = null) {
    const scope = root || findAssetBrowserRoot() || document;
    const isRow = (element) => {
      if (!visibleElement(element) || element.disabled || element.closest?.("[data-card-open]")) return false;
      if (!element.querySelector?.("img") && element.tagName !== "IMG") return false;
      const rect = element.getBoundingClientRect();
      return rect.width >= 50 && rect.width <= 800 && rect.height >= 28 && rect.height <= 420;
    };
    const rows = [
      ...Array.from(scope.querySelectorAll("[data-item-index]")).map((container) => {
        if (isRow(container)) return container;
        return Array.from(container.children || []).find((child) => isRow(child)) || null;
      }),
      ...Array.from(scope.querySelectorAll("[role='listitem'],[role='option'],[role='row'],[role='gridcell'],button,[role='button'],[tabindex],li,div")).filter(isRow)
    ].filter(Boolean);
    return rows
      .filter((row, index, all) => all.indexOf(row) === index)
      .filter((row) => !rows.some((other) => other !== row && row.contains(other)))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        if (Math.abs(ar.top - br.top) > 5) return ar.top - br.top;
        return ar.left - br.left;
      });
  }

  function pickAssetRow(rows = [], ref = {}, options = {}) {
    const targetIds = [
      ref.assetImageId,
      ref.mediaId,
      ref.mediaId ? `fe_id_${String(ref.mediaId).replace(/^fe_id_/i, "")}` : ""
    ].map((id) => String(id || "").trim()).filter(Boolean);
    if (targetIds.length) {
      for (const row of rows) {
        const rowIds = [...assetIdsFromRow(row)];
        if (rowIds.some((rowId) => targetIds.some((targetId) => idsMatch(rowId, targetId)))) return row;
      }
    }
    if (options.strictIds === true && targetIds.length) return null;
    const expectedName = normalizeAssetName(ref.fileName || ref.title);
    if (!expectedName) return null;
    return rows.find((row) => {
      const text = normalizeAssetName(rowText(row));
      return text === expectedName || text.includes(expectedName) || expectedName.includes(text);
    }) || null;
  }

  function setInputValue(input, value = "") {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function inlineImageUrlForRef(ref = {}) {
    return [ref.dataUrl, ref.imageUrl, ref.mediaUrl]
      .map((value) => String(value || "").trim())
      .find((value) => /^data:image\//i.test(value)) || "";
  }

  function inferFileExtension(mimeType = "", fallbackName = "") {
    const fromName = String(fallbackName || "").match(/\.([a-z0-9]{2,6})$/i)?.[1];
    if (fromName) return fromName.toLowerCase();
    const type = String(mimeType || "").toLowerCase();
    if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
    if (type.includes("webp")) return "webp";
    if (type.includes("gif")) return "gif";
    return "png";
  }

  function safeUploadFileName(ref = {}, blobType = "") {
    const existing = String(ref.fileName || ref.title || "").trim();
    if (/\.[a-z0-9]{2,6}$/i.test(existing)) return existing;
    const base = normalizeAssetName(existing || ref.mediaId || "autoflow-frame-ref").replace(/\s+/g, "-") || "autoflow-frame-ref";
    return `${base}.${inferFileExtension(blobType || ref.mimeType, existing)}`;
  }

  function frameUploadCacheKey(taskId = "", ref = {}, ingredientType = "") {
    return [
      String(taskId || "").trim() || "no-task",
      String(ingredientType || "").trim(),
      String(ref?.blobStoreId || ref?.id || "").trim(),
      safeUploadFileName(ref),
      String(inlineImageUrlForRef(ref).length || 0)
    ].join("|");
  }

  function frameUploadContentKey(ref = {}, ingredientType = "") {
    return [
      "content",
      String(ingredientType || "").trim(),
      String(ref?.blobStoreId || ref?.id || "").trim(),
      safeUploadFileName(ref),
      String(inlineImageUrlForRef(ref).length || 0)
    ].join("|");
  }

  function getFrameUploadCache(key = "") {
    try {
      const cache = window.__AF_DOM_FRAME_UPLOAD_CACHE || {};
      const entry = cache[String(key || "")] || null;
      if (!entry?.mediaId) return "";
      if (Date.now() - Number(entry.at || 0) > 10 * 60 * 1000) return "";
      return frameIdTail(entry.mediaId);
    } catch {
      return "";
    }
  }

  function setFrameUploadCache(key = "", mediaId = "", source = "") {
    const id = frameIdTail(mediaId);
    if (!key || !id) return "";
    try {
      const cache = window.__AF_DOM_FRAME_UPLOAD_CACHE || {};
      cache[String(key)] = { mediaId: id, source, at: Date.now() };
      window.__AF_DOM_FRAME_UPLOAD_CACHE = cache;
    } catch {}
    return id;
  }

  async function fileFromInlineImageUrl(dataUrl = "", ref = {}) {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const type = blob.type || String(ref.mimeType || "image/png");
    return new File([blob], safeUploadFileName(ref, type), { type });
  }

  function findAssetFileInput(root = null, options = {}) {
    const allowDocumentFallback = options.documentFallback !== false;
    const scopes = [root, findAssetBrowserRoot()].filter(Boolean);
    if (allowDocumentFallback) scopes.push(document);
    const inputs = [];
    for (const scope of scopes) {
      Array.from(scope.querySelectorAll?.("input[type='file']") || []).forEach((input) => {
        if (!inputs.includes(input) && !input.disabled) inputs.push(input);
      });
    }
    return inputs
      .map((input) => {
        const accept = String(input.getAttribute("accept") || "").toLowerCase();
        let score = 0;
        if (!accept || accept.includes("image")) score += 80;
        if (accept.includes("video")) score -= 40;
        if ((root || findAssetBrowserRoot())?.contains?.(input)) score += 30;
        if (!allowDocumentFallback && root && !root.contains(input)) score -= 1000;
        return { input, score };
      })
      .sort((a, b) => b.score - a.score)[0]?.input || null;
  }

  function findNewestFileInput() {
    const inputs = Array.from(document.querySelectorAll("input[type='file']"))
      .filter((input) => input?.isConnected && !input.disabled && !String(input.id || "").startsWith("af-"));
    return inputs[inputs.length - 1] || null;
  }

  function uploadSpinnerVisible() {
    return Array.from(document.querySelectorAll("i,span"))
      .some((element) => visibleElement(element) && /progress_activity/i.test(String(element.textContent || "")));
  }

  function findAssetUploadButton(root = null) {
    const scope = root || findAssetBrowserRoot() || document;
    return Array.from(scope.querySelectorAll("button,[role='button'],[tabindex],label,div"))
      .filter((element) => visibleElement(element) && !element.disabled && element !== scope)
      .map((element) => {
        const icons = materialIconTokens(element);
        const text = visibleText(element).toLowerCase();
        const rect = element.getBoundingClientRect();
        const area = rect.width * rect.height;
        let score = 0;
        if (icons.has("upload") || icons.has("file_upload") || icons.has("add_photo_alternate")) score += 120;
        if (text.includes("upload image")) score += 90;
        if (text.includes("upload")) score += 40;
        if (element.tagName === "BUTTON" || String(element.getAttribute("role") || "").toLowerCase() === "button") score += 35;
        if (element.tagName === "LABEL") score += 30;
        if (rect.height >= 36 && rect.height <= 90 && rect.width >= 80 && rect.width <= 360) score += 45;
        if (area > 0 && area < 40000) score += 20;
        if (area > 120000) score -= 90;
        if (icons.has("voice_selection")) score -= 120;
        return { button: element, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.button || null;
  }

  function collectVisibleFrameAssetIds(scope = null) {
    const ids = [];
    const push = (value = "") => {
      const id = canonicalFrameId(value);
      if (id && !ids.includes(id)) ids.push(id);
    };
    try {
      for (const row of listAssetRows(scope || findAssetBrowserRoot())) {
        for (const id of assetIdsFromRow(row)) push(id);
      }
    } catch {}
    try {
      for (const img of Array.from(document.querySelectorAll("img"))) {
        if (!visibleElement(img)) continue;
        push(extractMediaIdFromUrl(img.currentSrc || img.src || ""));
      }
    } catch {}
    return ids;
  }

  async function materializeRefInComposerAssetBrowser(ref, onStage = null, context = {}) {
    const emitStage = (stage, extra = {}) => {
      try {
        if (typeof onStage === "function") onStage(stage, extra);
      } catch {}
    };
    const inlineUrl = inlineImageUrlForRef(ref);
    const fileName = safeUploadFileName(ref);
    if (!inlineUrl) {
      return { ok: false, step: "dom_ref_materialize", error: "NO_INLINE_IMAGE_DATA" };
    }

    await closeAssetBrowser();
    const store = resolvePromptStore();
    const baselineIngredientIds = new Set(
      (store?.getState?.()?.ingredients || [])
        .map((ingredient) => String(ingredient?.imageId || "").trim())
        .filter(Boolean)
    );

    emitStage("dom_ref_materialize_browser_open_start", { fileName });
    let root = await openAssetBrowser();
    emitStage("dom_ref_materialize_browser_open_done", { fileName, ok: Boolean(root) });
    if (!root) return { ok: false, step: "dom_ref_materialize", error: "ASSET_BROWSER_NOT_OPEN" };
    await ensureAssetImageTab(root);
    root = findAssetBrowserRoot() || root;

    const preUploadIds = new Set(collectVisibleFrameAssetIds(root));
    installFrameUploadCapture();

    let fileInput = findAssetFileInput(root, { documentFallback: false }) || findAssetFileInput(root);
    if (!fileInput) {
      const uploadButton = findAssetUploadButton(root);
      if (uploadButton) {
        emitStage("dom_ref_materialize_upload_button_click", {
          fileName,
          text: visibleText(uploadButton).slice(0, 120)
        });
        pointerClick(uploadButton);
        for (let remain = 3600; remain > 0 && !fileInput; remain -= 160) {
          await sleep(160);
          root = findAssetBrowserRoot() || root;
          fileInput = findAssetFileInput(root, { documentFallback: false }) || findAssetFileInput(root);
        }
      }
    }
    emitStage("dom_ref_materialize_file_input_ready", {
      fileName,
      found: Boolean(fileInput),
      accept: fileInput?.getAttribute?.("accept") || ""
    });
    if (!fileInput) return { ok: false, step: "dom_ref_materialize", error: "ASSET_FILE_INPUT_NOT_FOUND" };

    let uploadStartedAt = Date.now();
    try {
      const file = await fileFromInlineImageUrl(inlineUrl, ref);
      const transfer = new DataTransfer();
      transfer.items.add(file);
      fileInput.files = transfer.files;
      uploadStartedAt = Date.now();
      emitStage("dom_ref_materialize_file_dispatch_start", {
        fileName,
        size: Number(file.size || 0),
        type: file.type || ""
      });
      fileInput.dispatchEvent(new Event("input", { bubbles: true }));
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      emitStage("dom_ref_materialize_file_dispatch_done", { fileName });
    } catch (error) {
      emitStage("dom_ref_materialize_file_dispatch_failed", {
        fileName,
        message: String(error?.message || error || "")
      });
      return {
        ok: false,
        step: "dom_ref_materialize",
        error: "DOM_REF_MATERIALIZE_DISPATCH_FAILED",
        message: String(error?.message || error || "")
      };
    }

    let uploadedMediaId = "";
    let materializedRow = null;
    let materializedRowId = "";
    let metadataPolls = 0;
    let lastMetadataPoll = 0;
    const rowRef = () => {
      const tail = frameIdTail(uploadedMediaId);
      return {
        ...ref,
        fileName,
        title: ref?.title || fileName,
        mediaId: tail,
        assetImageId: tail ? `fe_id_${tail}` : ""
      };
    };
    const searchTerms = () => assetPickerSearchTermsForRef(rowRef(), [fileName, ref?.title]);

    emitStage("dom_ref_materialize_confirm_loop_start", { fileName });
    for (let remain = 52000; remain > 0; remain -= 260) {
      const uploadError = String(window.__AF_LAST_FRAME_UPLOAD_ERROR || "").trim();
      if (uploadError) {
        return {
          ok: false,
          step: "dom_ref_materialize",
          error: "DOM_REF_MATERIALIZE_UPLOAD_FAILED",
          message: uploadError
        };
      }

      const capturedMediaId = frameIdTail(window.__AF_LAST_FRAME_UPLOAD_MEDIA_ID || "");
      if (capturedMediaId && !uploadedMediaId) {
        uploadedMediaId = capturedMediaId;
        emitStage("dom_ref_materialize_upload_response_seen", { fileName, uploadedMediaId });
      }

      const now = Date.now();
      if ((!uploadedMediaId || metadataPolls < 6) && (!lastMetadataPoll || now - lastMetadataPoll > 1300)) {
        metadataPolls += 1;
        lastMetadataPoll = now;
        const projectMediaId = await Promise.race([
          latestProjectMediaIdForFile(fileName, uploadStartedAt),
          sleep(2400).then(() => "")
        ]);
        const tail = frameIdTail(projectMediaId || "");
        emitStage("dom_ref_materialize_metadata_seen", { fileName, metadataPolls, projectMediaId: tail });
        if (tail && !uploadedMediaId) uploadedMediaId = tail;
      }

      root = findAssetBrowserRoot() || root;
      const rows = listAssetRows(root);
      materializedRow = uploadedMediaId
        ? pickAssetRow(rows, rowRef())
        : null;
      if (!materializedRow) {
        materializedRow = rows.find((row) => {
          const rowIds = [...assetIdsFromRow(row)].map(canonicalFrameId).filter(Boolean);
          return rowIds.some((id) => !preUploadIds.has(id));
        }) || pickAssetRow(rows, { ...ref, fileName, title: fileName });
      }
      if (!materializedRow && uploadedMediaId) {
        const searchInput = findAssetSearchInput(root);
        if (searchInput) {
          for (const term of searchTerms()) {
            setInputValue(searchInput, term);
            await sleep(320);
            root = findAssetBrowserRoot() || root;
            materializedRow = pickAssetRow(listAssetRows(root), rowRef());
            if (materializedRow) break;
          }
        }
      }
      if (materializedRow && !uploadSpinnerVisible()) {
        const rowIds = [...assetIdsFromRow(materializedRow)];
        materializedRowId = rowIds.find((id) => uploadedMediaId && idsMatch(id, `fe_id_${uploadedMediaId}`))
          || rowIds.find((id) => uploadedMediaId && idsMatch(id, uploadedMediaId))
          || rowIds.find((id) => /^fe_id_/i.test(id))
          || (uploadedMediaId ? `fe_id_${uploadedMediaId}` : rowIds[0] || "");
        if (materializedRowId) break;
      }

      await sleep(260);
    }

    const finalMediaId = frameIdTail(uploadedMediaId || materializedRowId);
    const finalAssetImageId = materializedRowId || (finalMediaId ? `fe_id_${finalMediaId}` : "");
    const newIngredientIds = (store?.getState?.()?.ingredients || [])
      .map((ingredient) => String(ingredient?.imageId || "").trim())
      .filter((id) => id && !baselineIngredientIds.has(id));
    if (newIngredientIds.length) {
      emitStage("dom_ref_materialize_clearing_auto_ingredient", { fileName, newIngredientIds });
      clearAllIngredients(store);
      await sleep(160);
    }
    await closeAssetBrowser();
    emitStage("dom_ref_materialize_done", {
      fileName,
      ok: Boolean(finalAssetImageId),
      uploadedMediaId: finalMediaId,
      assetImageId: finalAssetImageId
    });
    if (!finalAssetImageId) {
      return {
        ok: false,
        step: "dom_ref_materialize",
        error: "DOM_REF_MATERIALIZE_ROW_NOT_FOUND",
        uploadedMediaId: uploadedMediaId || ""
      };
    }
    return {
      ok: true,
      step: "dom_ref_materialize",
      fileName,
      mediaId: finalMediaId,
      assetImageId: finalAssetImageId,
      source: "composer_asset_materialized"
    };
  }

  async function materializeRefInFrameSlotAssetBrowser(ref, ingredientType = "FIRST_FRAME", onStage = null, context = {}) {
    const emitStage = (stage, extra = {}) => {
      try {
        if (typeof onStage === "function") onStage(stage, extra);
      } catch {}
    };
    const inlineUrl = inlineImageUrlForRef(ref);
    const fileName = safeUploadFileName(ref);
    if (!inlineUrl) {
      return { ok: false, step: "dom_ref_frame_picker_materialize", error: "NO_INLINE_IMAGE_DATA" };
    }
    const store = resolvePromptStore();
    const previousRoleImageId = roleImageId(store, ingredientType);
    const replacementClear = await clearFrameSlotForReplacement(store, ingredientType, emitStage, {
      fileName,
      reason: "frame_picker_materialize"
    });
    emitStage("dom_ref_frame_picker_materialize_slot_replace_ready", {
      ingredientType,
      fileName,
      ok: Boolean(replacementClear?.ok),
      clearedRoleCount: replacementClear?.clearedRoleCount || 0,
      visibleCleared: Boolean(replacementClear?.visibleCleared),
      visibleClearOk: Boolean(replacementClear?.visibleClearOk),
      visibleClearError: replacementClear?.visibleClearError || "",
      previousRoleImageId
    });
    await closeAssetBrowser();
    emitStage("dom_ref_frame_picker_materialize_open_start", { ingredientType, fileName });
    let root = await openAssetBrowserFromFrameSlot(ingredientType);
    emitStage("dom_ref_frame_picker_materialize_open_done", { ingredientType, fileName, ok: Boolean(root) });
    if (!root) return { ok: false, step: "dom_ref_frame_picker_materialize", error: "ASSET_BROWSER_NOT_OPEN" };
    await ensureAssetImageTab(root);
    root = findAssetBrowserRoot() || root;

    const preUploadIds = new Set(collectVisibleFrameAssetIds(root));
    installFrameUploadCapture();
    let fileInput = findAssetFileInput(root, { documentFallback: false }) || findAssetFileInput(root);
    if (!fileInput) {
      const uploadButton = findAssetUploadButton(root);
      if (uploadButton) {
        emitStage("dom_ref_frame_picker_materialize_upload_button_click", {
          ingredientType,
          fileName,
          text: visibleText(uploadButton).slice(0, 120)
        });
        pointerClick(uploadButton);
        for (let remain = 3600; remain > 0 && !fileInput; remain -= 160) {
          await sleep(160);
          root = findAssetBrowserRoot() || root;
          fileInput = findAssetFileInput(root, { documentFallback: false }) || findAssetFileInput(root);
        }
      }
    }
    emitStage("dom_ref_frame_picker_materialize_file_input_ready", {
      ingredientType,
      fileName,
      found: Boolean(fileInput),
      accept: fileInput?.getAttribute?.("accept") || ""
    });
    if (!fileInput) return { ok: false, step: "dom_ref_frame_picker_materialize", error: "ASSET_FILE_INPUT_NOT_FOUND" };

    let uploadStartedAt = Date.now();
    try {
      const file = await fileFromInlineImageUrl(inlineUrl, ref);
      const transfer = new DataTransfer();
      transfer.items.add(file);
      fileInput.files = transfer.files;
      uploadStartedAt = Date.now();
      emitStage("dom_ref_frame_picker_materialize_file_dispatch_start", {
        ingredientType,
        fileName,
        size: Number(file.size || 0),
        type: file.type || ""
      });
      fileInput.dispatchEvent(new Event("input", { bubbles: true }));
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      emitStage("dom_ref_frame_picker_materialize_file_dispatch_done", { ingredientType, fileName });
    } catch (error) {
      emitStage("dom_ref_frame_picker_materialize_file_dispatch_failed", {
        ingredientType,
        fileName,
        message: String(error?.message || error || "")
      });
      return {
        ok: false,
        step: "dom_ref_frame_picker_materialize",
        error: "DOM_REF_FRAME_PICKER_MATERIALIZE_DISPATCH_FAILED",
        message: String(error?.message || error || "")
      };
    }

    let uploadedMediaId = "";
    let materializedRow = null;
    let materializedRowId = "";
    let metadataPolls = 0;
    let lastMetadataPoll = 0;
    let waitingForSelectableRowLogged = false;
    const directAttachAttempts = new Set();
    const attachBaseline = {
      ingredientCount: (store.getState().ingredients || []).length,
      chipCount: attachedChipCount(),
      ingredientIds: (store.getState().ingredients || []).map((ingredient) => String(ingredient?.imageId || "").trim()).filter(Boolean)
    };
    emitStage("dom_ref_frame_picker_materialize_confirm_loop_start", { ingredientType, fileName });
    for (let remain = 52000; remain > 0; remain -= 260) {
      const uploadError = String(window.__AF_LAST_FRAME_UPLOAD_ERROR || "").trim();
      if (uploadError) {
        return {
          ok: false,
          step: "dom_ref_frame_picker_materialize",
          error: "DOM_REF_FRAME_PICKER_MATERIALIZE_UPLOAD_FAILED",
          message: uploadError
        };
      }

      const capturedMediaId = frameIdTail(window.__AF_LAST_FRAME_UPLOAD_MEDIA_ID || "");
      if (capturedMediaId && !uploadedMediaId) {
        uploadedMediaId = capturedMediaId;
        emitStage("dom_ref_frame_picker_materialize_upload_response_seen", { ingredientType, fileName, uploadedMediaId });
      }

      const currentRoleId = roleImageId(store, ingredientType);
      if (currentRoleId && !frameIdsMatch(currentRoleId, previousRoleImageId)) {
        const tail = frameIdTail(currentRoleId);
        if (tail && !uploadedMediaId && !preUploadIds.has(canonicalFrameId(currentRoleId))) {
          uploadedMediaId = tail;
          emitStage("dom_ref_frame_picker_materialize_auto_role_seen", { ingredientType, fileName, uploadedMediaId });
        }
        if (frameSlotLooksFilled(ingredientType) && !uploadSpinnerVisible()) break;
      }

      const now = Date.now();
      if ((!uploadedMediaId || metadataPolls < 6) && (!lastMetadataPoll || now - lastMetadataPoll > 1300)) {
        metadataPolls += 1;
        lastMetadataPoll = now;
        const projectMediaId = await Promise.race([
          latestProjectMediaIdForFile(fileName, uploadStartedAt),
          sleep(2400).then(() => "")
        ]);
        const tail = frameIdTail(projectMediaId || "");
        emitStage("dom_ref_frame_picker_materialize_metadata_seen", { ingredientType, fileName, metadataPolls, projectMediaId: tail });
        if (tail && !uploadedMediaId) uploadedMediaId = tail;
      }

      if (uploadedMediaId && !uploadSpinnerVisible() && !directAttachAttempts.has(uploadedMediaId)) {
        directAttachAttempts.add(uploadedMediaId);
        const attachId = `fe_id_${frameIdTail(uploadedMediaId) || uploadedMediaId}`;
        emitStage("dom_ref_frame_picker_materialize_direct_attach_start", {
          ingredientType,
          fileName,
          uploadedMediaId,
          attachId
        });
        const attached = await attachFrameImageId(store, attachId, ingredientType);
        const confirmed = attached
          ? await waitForAttachConfirmation(store, attachBaseline, attachId, 1800, ingredientType)
          : { ok: false };
        const slotVisible = frameSlotLooksFilled(ingredientType);
        emitStage("dom_ref_frame_picker_materialize_direct_attach_done", {
          ingredientType,
          fileName,
          uploadedMediaId,
          attachId,
          attached,
          confirmed: Boolean(confirmed?.ok),
          confirmedImageId: confirmed?.confirmedImageId || "",
          slotVisible
        });
        if (confirmed?.ok && slotVisible) {
          materializedRowId = confirmed.confirmedImageId || attachId;
          break;
        }
        root = findAssetBrowserRoot() || root;
      }

      root = findAssetBrowserRoot() || root;
      const rowRef = {
        ...ref,
        fileName,
        mediaId: uploadedMediaId,
        assetImageId: uploadedMediaId ? `fe_id_${uploadedMediaId}` : ""
      };
      let row = uploadedMediaId ? pickAssetRow(listAssetRows(root), rowRef) : null;
      if (!row) {
        row = listAssetRows(root).find((candidate) => {
          const rowIds = [...assetIdsFromRow(candidate)].map(canonicalFrameId).filter(Boolean);
          return rowIds.some((id) => !preUploadIds.has(id));
        }) || null;
      }
      if (row && !uploadSpinnerVisible()) {
        materializedRow = row;
        const rowIds = [...assetIdsFromRow(row)];
        materializedRowId = rowIds.find((id) => uploadedMediaId && idsMatch(id, `fe_id_${uploadedMediaId}`))
          || rowIds.find((id) => uploadedMediaId && idsMatch(id, uploadedMediaId))
          || rowIds.find((id) => /^fe_id_/i.test(id))
          || (uploadedMediaId ? `fe_id_${uploadedMediaId}` : rowIds[0] || "");
        if (materializedRowId) break;
      }
      if (uploadedMediaId && !uploadSpinnerVisible() && !materializedRow && !waitingForSelectableRowLogged) {
        waitingForSelectableRowLogged = true;
        emitStage("dom_ref_frame_picker_materialize_waiting_for_selectable_row", {
          ingredientType,
          fileName,
          uploadedMediaId
        });
      }
      await sleep(260);
    }

    const autoRoleId = roleImageId(store, ingredientType);
    const autoRoleIsNew = Boolean(autoRoleId && !frameIdsMatch(autoRoleId, previousRoleImageId));
    const finalMediaId = frameIdTail(uploadedMediaId || materializedRowId || autoRoleId);
    const finalAssetImageId = autoRoleIsNew
      ? autoRoleId
      : (materializedRowId || (finalMediaId ? `fe_id_${finalMediaId}` : ""));
    let rowConfirmedImageId = "";
    if (autoRoleIsNew) {
      emitStage("dom_ref_frame_picker_materialize_auto_role_preserved", {
        ingredientType,
        fileName,
        autoRoleId
      });
    } else if (materializedRow && finalAssetImageId) {
      const baseline = {
        ingredientCount: (store.getState().ingredients || []).length,
        chipCount: attachedChipCount(),
        ingredientIds: (store.getState().ingredients || []).map((ingredient) => String(ingredient?.imageId || "").trim()).filter(Boolean)
      };
      for (const candidate of clickableRowCandidates(materializedRow)) {
        emitStage("dom_ref_frame_picker_materialize_row_click", {
          ingredientType,
          fileName,
          rowImageId: finalAssetImageId
        });
        const reactClicked = invokeReactClick(candidate) || invokeReactClick(materializedRow);
        if (!reactClicked) pointerClick(candidate);
        try {
          candidate.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
          candidate.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
        } catch {}
        const confirmed = await waitForAttachConfirmation(store, baseline, finalAssetImageId, 3200, ingredientType);
        if (confirmed?.ok && frameSlotLooksFilled(ingredientType)) {
          rowConfirmedImageId = confirmed.confirmedImageId || finalAssetImageId;
          emitStage("dom_ref_frame_picker_materialize_row_confirmed", {
            ingredientType,
            fileName,
            rowImageId: finalAssetImageId,
            confirmedImageId: rowConfirmedImageId
          });
          break;
        }
        emitStage("dom_ref_frame_picker_materialize_row_not_confirmed", {
          ingredientType,
          fileName,
          rowImageId: finalAssetImageId,
          roleImageId: roleImageId(store, ingredientType),
          slotVisible: frameSlotLooksFilled(ingredientType)
        });
        await sleep(180);
      }
    }
    await closeAssetBrowser();
    emitStage("dom_ref_frame_picker_materialize_done", {
      ingredientType,
      fileName,
      ok: Boolean(finalAssetImageId || finalMediaId),
      uploadedMediaId: finalMediaId,
      assetImageId: finalAssetImageId
    });
    if (!finalAssetImageId && !finalMediaId) {
      return {
        ok: false,
        step: "dom_ref_frame_picker_materialize",
        error: "DOM_REF_FRAME_PICKER_MATERIALIZE_ROW_NOT_FOUND",
        uploadedMediaId
      };
    }
    return {
      ok: true,
      step: "dom_ref_frame_picker_materialize",
      fileName,
      mediaId: finalMediaId,
      assetImageId: finalAssetImageId || (finalMediaId ? `fe_id_${finalMediaId}` : ""),
      confirmedImageId: autoRoleIsNew ? autoRoleId : rowConfirmedImageId,
      attached: Boolean(autoRoleIsNew || rowConfirmedImageId),
      source: autoRoleIsNew
        ? "frame_picker_upload_auto_selected"
        : (rowConfirmedImageId ? "frame_picker_upload_row_selected" : "frame_picker_asset_materialized_only")
    };
  }

  async function selectFrameSlotAssetRow(ref, store, baseline = {}, ingredientType = "FIRST_FRAME", onStage = null, context = {}) {
    const emitStage = (stage, extra = {}) => {
      try {
        if (typeof onStage === "function") onStage(stage, extra);
      } catch {}
    };
    const fileName = safeUploadFileName(ref);
    const targetImageId = frameStoreIdCandidates(ref)[0] || "";
    if (!targetImageId) {
      return { ok: false, step: "frame_slot_asset_row_attach", error: "ASSET_ROW_ID_MISSING" };
    }
    const currentRoleId = roleImageId(store, ingredientType);
    const alreadySelected = Boolean(
      currentRoleId
      && frameSlotLooksFilled(ingredientType)
      && frameStoreIdCandidates(ref).some((id) => frameIdsMatch(currentRoleId, id))
    );
    if (!alreadySelected && context.replaceExisting !== false) {
      await clearFrameSlotForReplacement(store, ingredientType, emitStage, {
        fileName,
        reason: context.source || "select_frame_slot_asset_row"
      });
    }
    await closeAssetBrowser();
    emitStage("dom_frame_slot_picker_open_start", { ingredientType, fileName, targetImageId });
    let root = await openAssetBrowserFromFrameSlot(ingredientType);
    emitStage("dom_frame_slot_picker_open_done", { ingredientType, fileName, ok: Boolean(root) });
    if (!root) return { ok: false, step: "frame_slot_asset_row_attach", error: "ASSET_BROWSER_NOT_OPEN" };
    await ensureAssetImageTab(root);
    root = findAssetBrowserRoot() || root;

    const searchTerms = assetPickerSearchTermsForRef(ref, [fileName, ref.title]);
    let row = pickAssetRow(listAssetRows(root), ref);
    for (const term of searchTerms) {
      if (row) break;
      const searchInput = findAssetSearchInput(root);
      if (searchInput) {
        setInputValue(searchInput, term);
        emitStage("dom_frame_slot_row_search", { ingredientType, fileName, term: term.slice(0, 120) });
        await sleep(360);
      }
      for (let poll = 0; poll < 18 && !row; poll += 1) {
        root = findAssetBrowserRoot() || root;
        row = pickAssetRow(listAssetRows(root), ref);
        if (!row) await sleep(240);
      }
      if (row) break;
    }
    if (!row) {
      const searchInput = findAssetSearchInput(root);
      if (searchInput) {
        setInputValue(searchInput, "");
        await sleep(180);
      }
      for (let poll = 0; poll < 10 && !row; poll += 1) {
        root = findAssetBrowserRoot() || root;
        row = pickAssetRow(listAssetRows(root), ref);
        if (!row) await sleep(260);
      }
    }
    emitStage("dom_frame_slot_row_lookup", {
      ingredientType,
      fileName,
      targetImageId,
      found: Boolean(row),
      rowText: row ? rowText(row).slice(0, 140) : ""
    });
    if (!row) {
      await closeAssetBrowser();
      return { ok: false, step: "frame_slot_asset_row_attach", error: "ASSET_ROW_NOT_FOUND" };
    }

    const rowIds = [...assetIdsFromRow(row)];
    const rowImageId = rowIds.find((id) => idsMatch(id, ref.assetImageId))
      || rowIds.find((id) => idsMatch(id, ref.mediaId))
      || rowIds.find((id) => idsMatch(id, targetImageId))
      || rowIds.find((id) => /^fe_id_/i.test(id))
      || targetImageId;
    let confirmed = null;
    for (let clickRound = 0; clickRound < 2 && !confirmed?.ok; clickRound += 1) {
      for (const candidate of clickableRowCandidates(row)) {
        emitStage("dom_frame_slot_row_click", {
          ingredientType,
          fileName,
          rowImageId,
          clickRound
        });
        const reactClicked = invokeReactClick(candidate) || invokeReactClick(row);
        if (!reactClicked) pointerClick(candidate);
        try {
          candidate.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
          candidate.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
        } catch {}
        confirmed = await waitForAttachConfirmation(store, baseline, rowImageId, 2800, ingredientType);
        if (confirmed?.ok && frameSlotLooksFilled(ingredientType)) break;
        emitStage("dom_frame_slot_row_click_not_confirmed", {
          ingredientType,
          fileName,
          rowImageId,
          roleImageId: roleImageId(store, ingredientType),
          slotVisible: frameSlotLooksFilled(ingredientType)
        });
        root = findAssetBrowserRoot() || root;
        await sleep(260);
      }
    }
    if (!confirmed?.ok || !frameSlotLooksFilled(ingredientType)) {
      await closeAssetBrowser();
      return {
        ok: false,
        step: "frame_slot_asset_row_attach",
        error: "REF_ATTACH_NOT_PERSISTED",
        confirmedImageId: confirmed?.confirmedImageId || rowImageId
      };
    }
    await closeAssetBrowser();
    await sleep(220);
    emitStage("dom_frame_slot_row_confirmed", {
      ingredientType,
      fileName,
      rowImageId,
      confirmedImageId: confirmed.confirmedImageId || rowImageId
    });
    return {
      ok: true,
      step: "frame_slot_asset_row_attach",
      confirmedImageId: confirmed.confirmedImageId || rowImageId,
      uploadedMediaId: frameIdTail(ref.mediaId || rowImageId),
      source: context.source || "frame_slot_asset_row"
    };
  }

  async function uploadFreshFrameSlotThroughPicker(ref, store, ingredientType, onStage = null, context = {}) {
    const emitStage = (stage, extra = {}) => {
      try {
        if (typeof onStage === "function") onStage(stage, extra);
      } catch {}
    };
    const inlineUrl = inlineImageUrlForRef(ref);
    const fileName = safeUploadFileName(ref);
    if (!store?.getState) return { ok: false, step: "dom_fresh_frame_upload", error: "PROMPT_STORE_NOT_FOUND" };
    const cacheKey = frameUploadCacheKey(context.taskId || "", ref, ingredientType);
    const contentCacheKey = frameUploadContentKey(ref, ingredientType);
    const previousRoleImageId = roleImageId(store, ingredientType);
    const replacementClear = await clearFrameSlotForReplacement(store, ingredientType, emitStage, {
      fileName,
      reason: context.source || "fresh_frame_slot_upload"
    });
    emitStage("dom_fresh_frame_slot_replace_ready", {
      ingredientType,
      fileName,
      cleared: replacementClear?.clearedRoleCount || 0,
      previousRoleImageId,
      visibleCleared: Boolean(replacementClear?.visibleCleared),
      visibleClearOk: Boolean(replacementClear?.visibleClearOk),
      visibleClearError: replacementClear?.visibleClearError || ""
    });
    await closeAssetBrowser();

    emitStage("dom_fresh_frame_picker_open_start", { ingredientType, fileName });
    let root = await openAssetBrowserFromFrameSlot(ingredientType);
    emitStage("dom_fresh_frame_picker_opened", { ingredientType, fileName, ok: Boolean(root) });
    if (!root) return { ok: false, step: "dom_fresh_frame_upload", error: "ASSET_BROWSER_NOT_OPEN" };
    await ensureAssetImageTab(root);
    root = findAssetBrowserRoot() || root;

    const baseline = {
      ingredientCount: (store.getState().ingredients || []).length,
      chipCount: attachedChipCount(),
      ingredientIds: (store.getState().ingredients || []).map((ingredient) => String(ingredient?.imageId || "").trim()).filter(Boolean)
    };
    const preUploadIds = new Set(collectVisibleFrameAssetIds(root));
    const preExistingFileInputs = new Set(Array.from(document.querySelectorAll("input[type='file']")));
    const freshPickerFileInput = () => {
      root = findAssetBrowserRoot() || root;
      const scoped = findAssetFileInput(root, { documentFallback: false });
      if (scoped) return { input: scoped, source: "picker_scoped" };
      const created = Array.from(document.querySelectorAll("input[type='file']"))
        .filter((input) => input?.isConnected && !input.disabled && !String(input.id || "").startsWith("af-"))
        .filter((input) => !preExistingFileInputs.has(input))
        .filter((input) => {
          const accept = String(input.getAttribute("accept") || input.accept || "").toLowerCase();
          return !accept || accept.includes("image") || accept.includes("*");
        });
      if (created.length) return { input: created[created.length - 1], source: "created_by_picker_upload" };
      const currentRoot = root?.isConnected ? root : findAssetBrowserRoot();
      const hasOpenPickerUpload = Boolean(currentRoot && findAssetUploadButton(currentRoot));
      const globalImageInputs = Array.from(document.querySelectorAll("input[type='file']"))
        .filter((input) => input?.isConnected && !input.disabled && !String(input.id || "").startsWith("af-"))
        .filter((input) => {
          const accept = String(input.getAttribute("accept") || input.accept || "").toLowerCase();
          return !accept || accept.includes("image") || accept.includes("*");
        });
      if (hasOpenPickerUpload && globalImageInputs.length === 1) {
        return { input: globalImageInputs[0], source: "picker_global_file_input" };
      }
      return { input: null, source: "" };
    };

    let fileInput = null;
    let fileInputSource = "";
    const uploadButton = findAssetUploadButton(root);
    if (uploadButton) {
      emitStage("dom_fresh_frame_upload_button_click", {
        ingredientType,
        fileName,
        text: visibleText(uploadButton).slice(0, 120)
      });
      pointerClick(uploadButton);
      for (let remain = 3600; remain > 0 && !fileInput; remain -= 160) {
        await sleep(160);
        const resolved = freshPickerFileInput();
        fileInput = resolved.input;
        fileInputSource = resolved.source;
      }
    }
    if (!fileInput) {
      const resolved = freshPickerFileInput();
      fileInput = resolved.input;
      fileInputSource = resolved.source;
    }
    emitStage("dom_fresh_frame_file_input_ready", {
      ingredientType,
      fileName,
      found: Boolean(fileInput),
      source: fileInputSource,
      accept: fileInput?.getAttribute?.("accept") || ""
    });
    if (!fileInput) return { ok: false, step: "dom_fresh_frame_upload", error: "ASSET_FILE_INPUT_NOT_FOUND" };

    installFrameUploadCapture();
    let uploadStartedAt = Date.now();
    try {
      emitStage("dom_fresh_frame_file_dispatch_start", { ingredientType, fileName });
      const file = await fileFromInlineImageUrl(inlineUrl, ref);
      uploadStartedAt = Date.now();
      const transfer = new DataTransfer();
      transfer.items.add(file);
      fileInput.files = transfer.files;
      fileInput.dispatchEvent(new Event("input", { bubbles: true }));
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      emitStage("dom_fresh_frame_file_dispatch_done", {
        ingredientType,
        fileName,
        size: Number(file.size || 0),
        type: file.type || "",
        spinnerVisible: uploadSpinnerVisible()
      });
    } catch (error) {
      emitStage("dom_fresh_frame_file_dispatch_failed", {
        ingredientType,
        fileName,
        message: String(error?.message || error || "")
      });
      return {
        ok: false,
        step: "dom_fresh_frame_upload",
        error: "DOM_FRAME_UPLOAD_DISPATCH_FAILED",
        message: String(error?.message || error || "")
      };
    }

    const searchInput = () => findAssetSearchInput(findAssetBrowserRoot() || root);
    const setSearchTerm = async (term = "", stage = "dom_fresh_frame_row_search") => {
      const input = searchInput();
      if (!input) return false;
      setInputValue(input, term);
      emitStage(stage, { ingredientType, fileName, term: String(term || "").slice(0, 120) });
      await sleep(420);
      return true;
    };
    const rowRefForMedia = (mediaId = "") => {
      const tail = frameIdTail(mediaId);
      return {
        ...ref,
        fileName,
        mediaId: tail,
        assetImageId: tail ? `fe_id_${tail}` : ""
      };
    };
    const ensureFreshPickerRoot = async (reason = "row_lookup") => {
      let current = findAssetBrowserRoot();
      if (!current) {
        emitStage("dom_fresh_frame_picker_reopen_start", { ingredientType, fileName, reason });
        current = await openAssetBrowserFromFrameSlot(ingredientType);
        emitStage("dom_fresh_frame_picker_reopen_done", {
          ingredientType,
          fileName,
          reason,
          ok: Boolean(current)
        });
        if (current) await ensureAssetImageTab(current);
      }
      if (current?.isConnected) {
        root = current;
        return root;
      }
      return null;
    };
    const clickRowForMedia = async (mediaId = "", source = "unknown") => {
      const tail = frameIdTail(mediaId);
      if (!tail) return null;
      const rowRef = rowRefForMedia(tail);
      root = await ensureFreshPickerRoot(`lookup_${source}`) || root;
      let row = pickAssetRow(listAssetRows(root), rowRef);
      if (!row) {
        await setSearchTerm(rowRef.assetImageId || tail, "dom_fresh_frame_row_search_by_id");
        for (let poll = 0; poll < 14 && !row; poll += 1) {
          root = await ensureFreshPickerRoot(`search_id_${source}`) || root;
          row = pickAssetRow(listAssetRows(root), rowRef);
          if (!row) await sleep(240);
        }
      }
      if (!row) {
        await setSearchTerm(fileName, "dom_fresh_frame_row_search_by_name");
        for (let poll = 0; poll < 16 && !row; poll += 1) {
          root = await ensureFreshPickerRoot(`search_name_${source}`) || root;
          row = pickAssetRow(listAssetRows(root), rowRef);
          if (!row) await sleep(260);
        }
      }
      emitStage("dom_fresh_frame_row_lookup", {
        ingredientType,
        fileName,
        mediaId: tail,
        source,
        found: Boolean(row),
        rowText: row ? rowText(row).slice(0, 140) : ""
      });
      if (!row) return null;

      const rowIds = [...assetIdsFromRow(row)];
      const rowImageId = rowIds.find((id) => idsMatch(id, rowRef.assetImageId))
        || rowIds.find((id) => idsMatch(id, tail))
        || rowIds.find((id) => /^fe_id_/i.test(id))
        || rowRef.assetImageId;
      for (let clickRound = 0; clickRound < 2; clickRound += 1) {
        for (const candidate of clickableRowCandidates(row)) {
          emitStage("dom_fresh_frame_row_click", {
            ingredientType,
            fileName,
            mediaId: tail,
            source,
            clickRound,
            rowImageId
          });
          const reactClicked = invokeReactClick(candidate) || invokeReactClick(row);
          if (!reactClicked) pointerClick(candidate);
          try {
            candidate.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            candidate.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
          } catch {}
          const confirmed = await waitForAttachConfirmation(store, baseline, rowImageId, 2600, ingredientType);
          if (confirmed?.ok && frameSlotLooksFilled(ingredientType)) {
            await closeAssetBrowser();
            await sleep(260);
            const retained = frameIdsMatch(roleImageId(store, ingredientType), rowImageId)
              || frameIdsMatch(roleImageId(store, ingredientType), confirmed.confirmedImageId)
              || frameSlotLooksFilled(ingredientType);
            if (retained) {
              return {
                ok: true,
                source: `fresh_frame_${source}_row`,
                confirmedImageId: confirmed.confirmedImageId || rowImageId,
                uploadedMediaId: tail
              };
            }
          }
          emitStage("dom_fresh_frame_row_click_not_confirmed", {
            ingredientType,
            fileName,
            mediaId: tail,
            source,
            clickRound,
            rowImageId,
            reactClicked,
            roleImageId: roleImageId(store, ingredientType),
            slotVisible: frameSlotLooksFilled(ingredientType)
          });
          root = await ensureFreshPickerRoot(`not_confirmed_${source}`) || root;
          await sleep(320);
        }
      }
      return null;
    };

    let uploadedMediaId = "";
    let metadataPolls = 0;
    let lastMetadataPoll = 0;
    const autoStoreProof = new Set();
    const directAttachAttempts = new Set();
    let pendingAutoStoreRoleId = "";
    emitStage("dom_fresh_frame_confirm_loop_start", { ingredientType, fileName });
    for (let remain = 52000; remain > 0; remain -= 240) {
      const uploadError = String(window.__AF_LAST_FRAME_UPLOAD_ERROR || "").trim();
      if (uploadError) {
        return {
          ok: false,
          step: "dom_fresh_frame_upload",
          error: "DOM_FRAME_UPLOAD_FAILED",
          message: uploadError
        };
      }

      const roleId = roleImageId(store, ingredientType);
      if (roleId && !frameIdsMatch(roleId, previousRoleImageId) && !autoStoreProof.has(roleId)) {
        autoStoreProof.add(roleId);
        const stale = preUploadIds.has(canonicalFrameId(roleId));
        const slotVisible = frameSlotLooksFilled(ingredientType);
        if (!stale && slotVisible) {
          pendingAutoStoreRoleId = roleId;
        }
        emitStage("dom_fresh_frame_store_auto_populated", {
          ingredientType,
          fileName,
          roleImageId: roleId,
          stale,
          slotVisible,
          acceptedCandidate: Boolean(!stale && slotVisible)
        });
      }

      const capturedMediaId = frameIdTail(window.__AF_LAST_FRAME_UPLOAD_MEDIA_ID || "");
      if (capturedMediaId && !uploadedMediaId) {
        uploadedMediaId = capturedMediaId;
        setFrameUploadCache(cacheKey, capturedMediaId, "fresh_upload_response_seen");
        setFrameUploadCache(contentCacheKey, capturedMediaId, "fresh_upload_response_seen");
        emitStage("dom_fresh_frame_upload_response_seen", { ingredientType, fileName, uploadedMediaId });
      }

      const now = Date.now();
      if ((!uploadedMediaId || metadataPolls < 6) && (!lastMetadataPoll || now - lastMetadataPoll > 1300)) {
        metadataPolls += 1;
        lastMetadataPoll = now;
        const projectMediaId = await Promise.race([
          latestProjectMediaIdForFile(fileName, uploadStartedAt),
          sleep(2400).then(() => "")
        ]);
        const tail = frameIdTail(projectMediaId || "");
        emitStage("dom_fresh_frame_metadata_seen", { ingredientType, fileName, metadataPolls, projectMediaId: tail });
        if (tail && !uploadedMediaId) {
          uploadedMediaId = tail;
          setFrameUploadCache(cacheKey, tail, "fresh_project_metadata_seen");
          setFrameUploadCache(contentCacheKey, tail, "fresh_project_metadata_seen");
        }
      }

      if (pendingAutoStoreRoleId && uploadedMediaId && !uploadSpinnerVisible()) {
        await closeAssetBrowser();
        await sleep(260);
        const retained = frameIdsMatch(roleImageId(store, ingredientType), pendingAutoStoreRoleId)
          || frameSlotLooksFilled(ingredientType);
        emitStage("dom_fresh_frame_store_auto_populated_verify", {
          ingredientType,
          fileName,
          roleImageId: pendingAutoStoreRoleId,
          uploadedMediaId,
          retained
        });
        if (retained) {
          setFrameUploadCache(cacheKey, pendingAutoStoreRoleId, "fresh_frame_store_auto_populated");
          setFrameUploadCache(contentCacheKey, pendingAutoStoreRoleId, "fresh_frame_store_auto_populated");
          emitStage("dom_fresh_frame_upload_confirmed", {
            ingredientType,
            fileName,
            confirmedImageId: pendingAutoStoreRoleId,
            uploadedMediaId,
            source: "fresh_frame_store_auto_populated"
          });
          return {
            ok: true,
            step: "dom_fresh_frame_upload",
            ingredientType,
            confirmedImageId: pendingAutoStoreRoleId,
            uploadedMediaId,
            source: "fresh_frame_store_auto_populated"
          };
        }
      }

      if (uploadedMediaId && !uploadSpinnerVisible() && !directAttachAttempts.has(uploadedMediaId)) {
        directAttachAttempts.add(uploadedMediaId);
        const attachId = `fe_id_${frameIdTail(uploadedMediaId) || uploadedMediaId}`;
        const frameTask = context.task && typeof context.task === "object"
          ? context.task
          : { mode: ingredientType === "LAST_FRAME" ? "start-end-image-to-video" : "image-to-video" };
        const beforeMode = String(store.getState?.()?.mode || "");
        if ((ingredientType === "FIRST_FRAME" || ingredientType === "LAST_FRAME") && beforeMode !== "VIDEO_FRAMES") {
          const repairSettings = {
            ok: true,
            repeat: Math.max(1, Math.min(4, Number.parseInt(frameTask.repeatCount, 10) || 1)),
            duration: domVideoDurationForTask(frameTask),
            aspect: normalizeDomAspectRatio(frameTask.aspectRatio)
          };
          const repair = syncPromptStoreToVisibleVideoSettings(store, frameTask, repairSettings);
          await sleep(160);
          emitStage("dom_fresh_frame_mode_store_repair", {
            ingredientType,
            fileName,
            beforeMode,
            afterMode: String(store.getState?.()?.mode || ""),
            ok: Boolean(repair?.ok),
            error: repair?.error || ""
          });
        }
        emitStage("dom_fresh_frame_direct_attach_start", {
          ingredientType,
          fileName,
          uploadedMediaId,
          attachId
        });
        const attached = await attachFrameImageId(store, attachId, ingredientType);
        const confirmed = attached
          ? await waitForAttachConfirmation(store, baseline, attachId, 1800, ingredientType)
          : { ok: false };
        const slotVisible = frameSlotLooksFilled(ingredientType);
        emitStage("dom_fresh_frame_direct_attach_done", {
          ingredientType,
          fileName,
          uploadedMediaId,
          attachId,
          attached,
          confirmed: Boolean(confirmed?.ok),
          confirmedImageId: confirmed?.confirmedImageId || "",
          slotVisible
        });
        if (confirmed?.ok && slotVisible) {
          setFrameUploadCache(cacheKey, confirmed.confirmedImageId || attachId, "fresh_frame_direct_attach");
          setFrameUploadCache(contentCacheKey, confirmed.confirmedImageId || attachId, "fresh_frame_direct_attach");
          emitStage("dom_fresh_frame_upload_confirmed", {
            ingredientType,
            fileName,
            confirmedImageId: confirmed.confirmedImageId || attachId,
            uploadedMediaId,
            source: "fresh_frame_direct_attach"
          });
          return {
            ok: true,
            step: "dom_fresh_frame_upload",
            ingredientType,
            confirmedImageId: confirmed.confirmedImageId || attachId,
            uploadedMediaId,
            source: "fresh_frame_direct_attach"
          };
        }
      }

      if (uploadedMediaId && !uploadSpinnerVisible()) {
        const clicked = await clickRowForMedia(uploadedMediaId, window.__AF_LAST_FRAME_UPLOAD_MEDIA_ID ? "upload_response" : "project_metadata");
        if (clicked?.ok) {
          setFrameUploadCache(cacheKey, clicked.confirmedImageId || clicked.uploadedMediaId, clicked.source || "fresh_frame_row");
          setFrameUploadCache(contentCacheKey, clicked.confirmedImageId || clicked.uploadedMediaId, clicked.source || "fresh_frame_row");
          emitStage("dom_fresh_frame_upload_confirmed", {
            ingredientType,
            fileName,
            confirmedImageId: clicked.confirmedImageId || "",
            uploadedMediaId: clicked.uploadedMediaId || uploadedMediaId,
            source: clicked.source || ""
          });
          return {
            ok: true,
            step: "dom_fresh_frame_upload",
            ingredientType,
            confirmedImageId: clicked.confirmedImageId || "",
            uploadedMediaId: clicked.uploadedMediaId || uploadedMediaId,
            source: clicked.source || ""
          };
        }
      }

      await sleep(240);
    }

    emitStage("dom_fresh_frame_upload_timeout", {
      ingredientType,
      fileName,
      uploadedMediaId,
      roleImageId: roleImageId(store, ingredientType),
      slotVisible: frameSlotLooksFilled(ingredientType)
    });
    return {
      ok: false,
      step: "dom_fresh_frame_upload",
      error: "DOM_FRESH_FRAME_ROW_NOT_CONFIRMED",
      uploadedMediaId
    };
  }

  function findProjectAddMediaButton() {
    const editor = findPromptEditor();
    const editorRect = editor?.getBoundingClientRect?.() || null;
    return Array.from(document.querySelectorAll("button,[role='button']"))
      .filter((element) => visibleElement(element) && !element.disabled)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = visibleText(element);
        const icons = materialIconTokens(element);
        let score = 0;
        if (icons.has("add") || icons.has("add_photo_alternate") || icons.has("upload") || icons.has("file_upload")) score += 70;
        if (/add\s*media|upload/i.test(text)) score += 120;
        if (rect.top >= 0 && rect.top < 190) score += 60;
        if (rect.width >= 28 && rect.width <= 220 && rect.height >= 28 && rect.height <= 72) score += 30;
        if (rect.left > window.innerWidth - 360) score += 25;
        if (/create|generate|submit|send|arrow_forward|add_2/i.test(text)) score -= 140;
        if (editorRect && rect.top > editorRect.top - 90) score -= 180;
        return { element, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function findProjectMediaCardForFile(fileName = "") {
    const expected = String(fileName || "").trim();
    if (!expected) return null;
    const compact = (value = "") => String(value || "").replace(/\s+/g, " ").trim();
    const candidates = Array.from(document.querySelectorAll("[data-tile-id], [role='button'], div, span"))
      .filter((element) => visibleElement(element) && compact(element.innerText || element.textContent || "").includes(expected))
      .map((element) => {
        const tile = element.closest?.("[data-tile-id]") || element.querySelector?.("[data-tile-id]") || element;
        const rect = tile.getBoundingClientRect?.() || element.getBoundingClientRect();
        const text = compact(tile.innerText || tile.textContent || element.innerText || element.textContent || "");
        const img = tile.querySelector?.("img") || element.querySelector?.("img") || null;
        const tileId = String(tile.getAttribute?.("data-tile-id") || "").trim();
        let score = 0;
        if (tileId) score += 120;
        if (tile === element) score += 20;
        if (rect.width >= 100 && rect.height >= 80) score += 40;
        if (text === expected) score += 10;
        return {
          element: tile,
          text,
          tileId,
          mediaId: extractMediaIdFromUrl(img?.currentSrc || img?.src || ""),
          progress: text.match(/\b([1-9]\d?|100)%\b/)?.[1] || "",
          rect: domRectSummary(tile),
          score
        };
      })
      .filter((entry, index, all) => entry.element && all.findIndex((item) => item.element === entry.element) === index)
      .sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  function reactPropsForElement(element) {
    if (!element) return null;
    try {
      const key = Object.keys(element).find((entry) => entry.startsWith("__reactProps"));
      return key ? element[key] : null;
    } catch {
      return null;
    }
  }

  function invokeReactMouseEnter(element) {
    const props = reactPropsForElement(element);
    if (typeof props?.onMouseEnter !== "function") return false;
    try {
      const rect = element.getBoundingClientRect?.() || { left: 0, top: 0 };
      props.onMouseEnter({
        preventDefault: () => {},
        stopPropagation: () => {},
        nativeEvent: {},
        target: element,
        currentTarget: element,
        type: "mouseenter",
        clientX: rect.left + 8,
        clientY: rect.top + 8
      });
      return true;
    } catch {
      return false;
    }
  }

  async function revealProjectMediaCardActions(cardElement) {
    if (!cardElement) return false;
    let invoked = false;
    for (const element of [cardElement, ...Array.from(cardElement.querySelectorAll?.("*") || [])]) {
      if (invokeReactMouseEnter(element)) invoked = true;
    }
    const rect = cardElement.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.right - 18,
      clientY: rect.top + 18
    };
    for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
      try {
        cardElement.dispatchEvent(type.startsWith("pointer")
          ? new PointerEvent(type, { ...eventInit, pointerId: 1, pointerType: "mouse" })
          : new MouseEvent(type, eventInit));
      } catch {}
    }
    await sleep(220);
    return invoked;
  }

  function findProjectMediaCardOverflowButton(cardElement) {
    if (!cardElement) return null;
    const rect = cardElement.getBoundingClientRect();
    return Array.from(document.querySelectorAll("button,[role='button']"))
      .filter(visibleElement)
      .map((element) => {
        const buttonRect = element.getBoundingClientRect();
        const text = visibleText(element);
        const icons = materialIconTokens(element);
        let score = 0;
        if (icons.has("more_vert") || /^more_vert\b/i.test(text)) score += 160;
        if (buttonRect.left >= rect.left - 4 && buttonRect.right <= rect.right + 4 && buttonRect.top >= rect.top - 4 && buttonRect.bottom <= rect.bottom + 80) score += 100;
        if (buttonRect.width <= 44 && buttonRect.height <= 44) score += 25;
        if (icons.has("favorite") || icons.has("download") || icons.has("arrow_back") || icons.has("close")) score -= 120;
        return { element, score, text, rect: domRectSummary(element) };
      })
      .filter((entry) => entry.score > 120)
      .sort((a, b) => b.score - a.score)[0] || null;
  }

  function projectCardPromptAttachMenuCandidates() {
    const menuRoots = Array.from(document.querySelectorAll("[role='menu'],[role='listbox']"))
      .filter(visibleElement);
    const candidates = menuRoots.length
      ? menuRoots.flatMap((root) => Array.from(root.querySelectorAll("[role='menuitem'],button,[role='button']")))
      : Array.from(document.querySelectorAll("[role='menuitem']"));
    return candidates
      .filter(visibleElement)
      .map((element) => {
        const menuRoot = element.closest?.("[role='menu'],[role='listbox']");
        if (menuRoots.length && !menuRoots.some((root) => root === menuRoot || root.contains(element))) {
          return { element, score: -999, text: visibleText(element), icons: [], rect: domRectSummary(element) };
        }
        const text = visibleText(element);
        const icons = materialIconTokens(element);
        let score = 0;
        if (String(element.getAttribute("role") || "") === "menuitem") score += 40;
        if (icons.has("add_2")) score += 260;
        if (icons.has("add")) score += 160;
        if (icons.has("add_photo_alternate") || icons.has("image")) score += 80;
        if (/add\s*to\s*prompt/i.test(text)) score += 30;
        if (icons.has("content_paste")) score += 20;
        if (
          icons.has("folder")
          || icons.has("download")
          || icons.has("delete")
          || icons.has("content_copy")
          || icons.has("favorite")
        ) score -= 220;
        return { element, score, text, icons: [...icons].slice(0, 8), rect: domRectSummary(element) };
      })
      .filter((entry) => entry.score >= 120)
      .sort((a, b) => b.score - a.score);
  }

  async function openProjectCardPromptAttachMenu(cardElement) {
    const hoverTriggered = await revealProjectMediaCardActions(cardElement);
    const overflow = findProjectMediaCardOverflowButton(cardElement);
    if (overflow?.element) {
      invokeReactClick(overflow.element) || pointerClick(overflow.element, { nativeClick: true });
      await sleep(260);
      const candidates = projectCardPromptAttachMenuCandidates();
      if (candidates.length) {
        return {
          source: "card_overflow",
          hoverTriggered,
          overflowText: overflow.text || "",
          overflowRect: overflow.rect || null,
          candidates
        };
      }
    }

    await dismissFloatingMenus();
    return {
      source: "card_overflow_unavailable",
      hoverTriggered,
      overflowText: overflow?.text || "",
      overflowRect: overflow?.rect || null,
      candidates: []
    };
  }

  async function clickProjectCardAddToPrompt(fileName = "", store, baseline = {}, ingredientType = "INGREDIENT", onStage = null) {
    const emitStage = (stage, extra = {}) => {
      try {
        if (typeof onStage === "function") onStage(stage, extra);
      } catch {}
    };
    const card = findProjectMediaCardForFile(fileName);
    emitStage("project_card_lookup_for_prompt", {
      fileName,
      found: Boolean(card?.element),
      tileId: card?.tileId || "",
      mediaId: card?.mediaId || "",
      progress: card?.progress || "",
      rect: card?.rect || null
    });
    if (!card?.element) return { ok: false, step: "project_card_add_to_prompt", error: "PROJECT_CARD_NOT_FOUND" };
    if (card.progress) return { ok: false, step: "project_card_add_to_prompt", error: "PROJECT_CARD_UPLOAD_IN_PROGRESS", progress: card.progress };

    await dismissFloatingMenus();
    let menu = null;
    let addButton = null;
    for (let remain = 16000; remain > 0 && !addButton; remain -= 260) {
      menu = await openProjectCardPromptAttachMenu(card.element);
      addButton = menu.candidates[0]?.element || null;
      if (addButton) break;
      await sleep(260);
    }
    emitStage("project_card_add_to_prompt_menu", {
      fileName,
      found: Boolean(addButton),
      source: menu?.source || "",
      hoverTriggered: Boolean(menu?.hoverTriggered),
      overflowText: menu?.overflowText || "",
      overflowRect: menu?.overflowRect || null,
      text: addButton ? visibleText(addButton).slice(0, 120) : "",
      candidates: (menu?.candidates || []).slice(0, 6).map((candidate) => ({
        score: candidate.score,
        text: candidate.text.slice(0, 120),
        icons: candidate.icons,
        rect: candidate.rect
      }))
    });
    if (!addButton) return { ok: false, step: "project_card_add_to_prompt", error: "ADD_TO_PROMPT_MENUITEM_NOT_FOUND" };
    invokeReactClick(addButton) || pointerClick(addButton, { nativeClick: true });
    const confirm = await waitForAttachConfirmation(store, baseline, "", 3600, ingredientType);
    const state = store?.getState?.() || {};
    const ingredients = Array.isArray(state.ingredients) ? state.ingredients : [];
    const targetType = isReferenceLikeIngredientType(ingredientType) ? ingredientType : "REFERENCE";
    if (confirm.ok && targetType !== "REFERENCE") {
      try {
        store.setState({
          ingredients: ingredients.map((ingredient) => ({
            ...ingredient,
            preferredIngredientType: targetType
          }))
        });
        await sleep(180);
      } catch {}
    }
    const finalIngredients = (store?.getState?.()?.ingredients || []).map((ingredient) => ({
      imageId: String(ingredient?.imageId || "").trim(),
      preferredIngredientType: String(ingredient?.preferredIngredientType || "").trim()
    })).filter((ingredient) => ingredient.imageId);
    const added = finalIngredients.filter((ingredient) => !(baseline.ingredientIds || []).some((id) => idsMatch(id, ingredient.imageId)));
    return {
      ok: Boolean(confirm.ok && added.length),
      step: "project_card_add_to_prompt",
      confirmedImageId: added[0]?.imageId || confirm.confirmedImageId || "",
      finalIngredients,
      added,
      tileId: card.tileId || "",
      mediaId: card.mediaId || "",
      error: confirm.ok ? "" : "ADD_TO_PROMPT_NOT_CONFIRMED"
    };
  }

  async function uploadReferenceViaProjectAddMedia(ref, onStage = null) {
    const emitStage = (stage, extra = {}) => {
      try {
        if (typeof onStage === "function") onStage(stage, extra);
      } catch {}
    };
    const inlineUrl = inlineImageUrlForRef(ref);
    const fileName = safeUploadFileName(ref);
    if (!inlineUrl) return { ok: false, step: "project_add_media_upload", error: "NO_INLINE_IMAGE_DATA" };

    await closeAssetBrowser();
    const preUploadIds = new Set(collectVisibleFrameAssetIds(document));
    const addButton = findProjectAddMediaButton();
    emitStage("project_add_media_button_lookup", {
      fileName,
      found: Boolean(addButton),
      text: addButton ? visibleText(addButton).slice(0, 120) : ""
    });

    let fileInput = findNewestFileInput();
    if (addButton) {
      pointerClick(addButton);
      for (let remain = 2600; remain > 0 && !fileInput; remain -= 160) {
        await sleep(160);
        if (findAssetBrowserRoot()) {
          await closeAssetBrowser();
          emitStage("project_add_media_opened_asset_browser", { fileName });
          return {
            ok: false,
            step: "project_add_media_upload",
            error: "PROJECT_ADD_MEDIA_OPENED_ASSET_BROWSER"
          };
        }
        fileInput = findNewestFileInput() || findAssetFileInput(document);
      }
    }
    if (!fileInput) fileInput = findNewestFileInput() || findAssetFileInput(document);
    emitStage("project_add_media_file_input_ready", {
      fileName,
      found: Boolean(fileInput),
      accept: fileInput?.getAttribute?.("accept") || ""
    });
    if (!fileInput) {
      return {
        ok: false,
        step: "project_add_media_upload",
        error: "PROJECT_ADD_MEDIA_FILE_INPUT_NOT_FOUND"
      };
    }

    installFrameUploadCapture();
    try {
      window.__AF_LAST_FRAME_UPLOAD_MEDIA_ID = "";
      window.__AF_LAST_FRAME_UPLOAD_ERROR = "";
    } catch {}
    const uploadStartedAt = Date.now();
    try {
      const file = await fileFromInlineImageUrl(inlineUrl, ref);
      const transfer = new DataTransfer();
      transfer.items.add(file);
      fileInput.files = transfer.files;
      emitStage("project_add_media_file_dispatch_start", {
        fileName,
        size: Number(file.size || 0),
        type: file.type || ""
      });
      fileInput.dispatchEvent(new Event("input", { bubbles: true }));
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      emitStage("project_add_media_file_dispatch_done", {
        fileName,
        spinnerVisible: uploadSpinnerVisible()
      });
      await dismissFloatingMenus();
    } catch (error) {
      emitStage("project_add_media_file_dispatch_failed", {
        fileName,
        message: String(error?.message || error || "")
      });
      return {
        ok: false,
        step: "project_add_media_upload",
        error: "PROJECT_ADD_MEDIA_DISPATCH_FAILED",
        message: String(error?.message || error || "")
      };
    }

    let uploadedMediaId = "";
    let metadataPolls = 0;
    let lastMetadataPoll = 0;
    let lastProgress = "";
    let lastProgressEmit = 0;
    let completeCandidateKey = "";
    let completeCandidateSince = 0;
    let lastCompleteCandidateEmit = 0;
    for (let remain = 90000; remain > 0; remain -= 260) {
      const uploadError = String(window.__AF_LAST_FRAME_UPLOAD_ERROR || "").trim();
      if (uploadError) {
        return {
          ok: false,
          step: "project_add_media_upload",
          error: "PROJECT_ADD_MEDIA_UPLOAD_FAILED",
          message: uploadError
        };
      }
      const capturedId = frameIdTail(window.__AF_LAST_FRAME_UPLOAD_MEDIA_ID || "");
      if (capturedId && !uploadedMediaId) {
        uploadedMediaId = capturedId;
        emitStage("project_add_media_upload_response_seen", { fileName, uploadedMediaId });
      }

      const now = Date.now();
      if ((!uploadedMediaId || metadataPolls < 8) && (!lastMetadataPoll || now - lastMetadataPoll > 1000)) {
        metadataPolls += 1;
        lastMetadataPoll = now;
        const projectMediaId = await Promise.race([
          latestProjectMediaIdForFile(fileName, uploadStartedAt),
          sleep(2200).then(() => "")
        ]);
        const projectTail = frameIdTail(projectMediaId || "");
        emitStage("project_add_media_metadata_seen", {
          fileName,
          metadataPolls,
          projectMediaId: projectTail
        });
        if (projectTail) uploadedMediaId = projectTail;
      }

      const card = findProjectMediaCardForFile(fileName);
      if (card?.progress && (card.progress !== lastProgress || Date.now() - lastProgressEmit > 2200)) {
        lastProgress = card.progress;
        lastProgressEmit = Date.now();
        emitStage("project_add_media_upload_progress", {
          fileName,
          progress: card.progress,
          tileId: card.tileId || "",
          mediaId: card.mediaId || uploadedMediaId || ""
        });
      }
      if (card?.element && !card.progress && (card.tileId || card.mediaId || uploadedMediaId)) {
        const assetImageId = card.tileId || (uploadedMediaId ? `fe_id_${uploadedMediaId}` : "");
        const tail = frameIdTail(card.mediaId || uploadedMediaId || assetImageId);
        const candidateKey = `${assetImageId}|${tail || uploadedMediaId}`;
        const spinnerVisible = uploadSpinnerVisible();
        if (candidateKey !== completeCandidateKey || spinnerVisible) {
          completeCandidateKey = candidateKey;
          completeCandidateSince = spinnerVisible ? 0 : Date.now();
        } else if (!completeCandidateSince) {
          completeCandidateSince = Date.now();
        }
        if (!lastCompleteCandidateEmit || Date.now() - lastCompleteCandidateEmit > 2200) {
          lastCompleteCandidateEmit = Date.now();
          emitStage("project_add_media_visible_complete_candidate", {
            fileName,
            uploadedMediaId: tail || uploadedMediaId,
            assetImageId,
            spinnerVisible,
            stableMs: completeCandidateSince ? Math.max(0, Date.now() - completeCandidateSince) : 0
          });
        }
        if (spinnerVisible || !completeCandidateSince || Date.now() - completeCandidateSince < 1800) {
          await sleep(260);
          continue;
        }
        emitStage("project_add_media_visible_confirmed", {
          fileName,
          uploadedMediaId: tail || uploadedMediaId,
          assetImageId,
          source: card.tileId ? "visible_completed_project_tile" : "project_metadata"
        });
        return {
          ok: true,
          step: "project_add_media_upload",
          fileName,
          mediaId: tail || uploadedMediaId,
          assetImageId,
          confirmedImageId: assetImageId,
          source: card.tileId ? "visible_completed_project_tile" : "project_metadata"
        };
      }
      if (!card?.element || card.progress) {
        completeCandidateKey = "";
        completeCandidateSince = 0;
      }
      await sleep(260);
    }

    return {
      ok: false,
      step: "project_add_media_upload",
      error: "PROJECT_UPLOAD_NOT_COMPLETE",
      uploadedMediaId
    };
  }

  async function uploadFrameRefThroughDom(root, ref, store, baseline, ingredientType, onStage = null, context = {}) {
    const emitStage = (stage, extra = {}) => {
      try {
        const mappedStage = isReferenceType
          ? String(stage || "").replace(/^dom_frame_/, "dom_reference_").replace(/^frame_slot_/, "reference_")
          : stage;
        if (typeof onStage === "function") onStage(mappedStage, {
          ...extra,
          originalStage: mappedStage === stage ? undefined : stage
        });
      } catch {}
    };
    const isReferenceType = isReferenceLikeIngredientType(ingredientType);
    const isFrameSlotRef = ingredientType === "FIRST_FRAME" || ingredientType === "LAST_FRAME";
    const isFreshFrameSlotUpload = isFrameSlotRef && frameStoreIdCandidates(ref).length === 0;
    const inlineUrl = inlineImageUrlForRef(ref);
    const cacheKey = frameUploadCacheKey(context.taskId || "", ref, ingredientType);
    const contentCacheKey = frameUploadContentKey(ref, ingredientType);
    const cachedMediaId = getFrameUploadCache(cacheKey) || getFrameUploadCache(contentCacheKey);
    emitStage("dom_frame_upload_start", {
      ingredientType,
      fileName: safeUploadFileName(ref),
      hasInlineData: Boolean(inlineUrl),
      hasMediaId: Boolean(ref?.mediaId || ref?.assetImageId),
      hasCachedUpload: Boolean(cachedMediaId),
      freshFrameSlotUpload: Boolean(isFreshFrameSlotUpload)
    });
    if (!inlineUrl) return { ok: false, step: "dom_frame_upload", error: "NO_INLINE_IMAGE_DATA" };

    if (isFrameSlotRef && !isFreshFrameSlotUpload) {
      const rowRef = {
        ...ref,
        fileName: safeUploadFileName(ref),
        mediaId: frameIdTail(ref.mediaId || ref.assetImageId || frameStoreIdCandidates(ref)[0] || ""),
        assetImageId: ref.assetImageId || (frameIdTail(ref.mediaId || frameStoreIdCandidates(ref)[0] || "") ? `fe_id_${frameIdTail(ref.mediaId || frameStoreIdCandidates(ref)[0] || "")}` : frameStoreIdCandidates(ref)[0] || "")
      };
      const selected = await selectFrameSlotAssetRow(rowRef, store, baseline, ingredientType, emitStage, {
        taskId: context.taskId || "",
        source: context.source || "existing_frame_asset_row"
      });
      if (selected?.ok) {
        emitStage("dom_frame_existing_asset_row_hit", {
          ingredientType,
          fileName: safeUploadFileName(ref),
          confirmedImageId: selected.confirmedImageId || rowRef.assetImageId || "",
          uploadedMediaId: selected.uploadedMediaId || rowRef.mediaId || ""
        });
        return {
          ok: true,
          step: "frame_slot_asset_row_attach",
          confirmedImageId: selected.confirmedImageId || rowRef.assetImageId || "",
          uploadedMediaId: selected.uploadedMediaId || rowRef.mediaId || "",
          ingredientType,
          source: selected.source || "existing_frame_asset_row"
        };
      }
      return {
        ok: false,
        step: selected?.step || "frame_slot_asset_row_attach",
        error: selected?.error || "ASSET_ROW_NOT_FOUND",
        confirmedImageId: selected?.confirmedImageId || "",
        uploadedMediaId: rowRef.mediaId || ""
      };
    }

    if (cachedMediaId && isFreshFrameSlotUpload) {
      const selectedRoleId = roleImageId(store, ingredientType);
      if (selectedRoleId && frameIdsMatch(selectedRoleId, cachedMediaId) && frameSlotLooksFilled(ingredientType)) {
        emitStage("dom_frame_cache_role_hit", {
          ingredientType,
          fileName: safeUploadFileName(ref),
          confirmedImageId: selectedRoleId,
          cachedMediaId,
          cacheSource: getFrameUploadCache(cacheKey) ? "task" : "content"
        });
        return {
          ok: true,
          step: "frame_slot_asset_row_attach",
          confirmedImageId: selectedRoleId,
          uploadedMediaId: frameIdTail(cachedMediaId || selectedRoleId),
          ingredientType,
          source: "frame_slot_cached_role_already_selected"
        };
      }
      const cachedRef = {
        ...ref,
        fileName: safeUploadFileName(ref),
        mediaId: cachedMediaId,
        assetImageId: `fe_id_${frameIdTail(cachedMediaId) || String(cachedMediaId).replace(/^fe_id_/i, "")}`
      };
      const cachedBaseline = {
        ingredientCount: (store.getState().ingredients || []).length,
        chipCount: attachedChipCount(),
        ingredientIds: (store.getState().ingredients || []).map((ingredient) => String(ingredient?.imageId || "").trim()).filter(Boolean)
      };
      const selected = await selectFrameSlotAssetRow(cachedRef, store, cachedBaseline, ingredientType, emitStage, {
        taskId: context.taskId || "",
        source: "frame_slot_cached_row"
      });
      if (selected?.ok) {
        emitStage("dom_frame_cache_row_hit", {
          ingredientType,
          fileName: safeUploadFileName(ref),
          confirmedImageId: selected.confirmedImageId || cachedRef.assetImageId,
          cacheSource: getFrameUploadCache(cacheKey) ? "task" : "content"
        });
        return selected;
      }
      emitStage("dom_frame_cache_row_miss", {
        ingredientType,
        cachedMediaId,
        error: selected?.error || ""
      });
    }

    if (cachedMediaId && !isFreshFrameSlotUpload) {
      const baselineForCache = {
        ingredientCount: (store.getState().ingredients || []).length,
        chipCount: attachedChipCount(),
        ingredientIds: (store.getState().ingredients || []).map((ingredient) => String(ingredient?.imageId || "").trim()).filter(Boolean)
      };
      const attached = await attachFrameImageId(store, cachedMediaId, ingredientType);
      if (attached) {
        const confirm = await waitForAttachConfirmation(store, baselineForCache, cachedMediaId, 800, ingredientType);
        if (confirm.ok) {
          emitStage("dom_frame_cache_hit", {
            ingredientType,
            fileName: safeUploadFileName(ref),
            confirmedImageId: confirm.confirmedImageId || cachedMediaId,
            cacheSource: getFrameUploadCache(cacheKey) ? "task" : "content"
          });
          return {
            ok: true,
            step: "dom_frame_upload",
            confirmedImageId: confirm.confirmedImageId || cachedMediaId,
            uploadedMediaId: cachedMediaId,
            source: "cache_hit"
          };
        }
      }
      emitStage("dom_frame_cache_miss_after_attach", { ingredientType, cachedMediaId });
      // Fall through: cached id is stale; do a real upload.
    }

    if (isFreshFrameSlotUpload) {
      let materialized = await materializeRefInFrameSlotAssetBrowser(ref, ingredientType, emitStage, {
        ...context,
        source: context.source || "fresh_frame_slot_picker"
      });
      let materializedByFramePicker = true;
      if (!materialized?.ok && String(materialized?.error || "") === "ASSET_BROWSER_NOT_OPEN") {
        emitStage("dom_frame_fresh_upload_composer_fallback", {
          ingredientType,
          fileName: safeUploadFileName(ref),
          reason: "frame_slot_asset_browser_unavailable"
        });
        materialized = await materializeRefInComposerAssetBrowser(ref, emitStage, {
          ...context,
          source: "fresh_frame_composer_fallback"
        });
        materializedByFramePicker = false;
      }
      if (!materialized?.ok) {
        return {
          ok: false,
          step: materialized?.step || "dom_ref_frame_picker_materialize",
          error: materialized?.error || "DOM_REF_FRAME_PICKER_MATERIALIZE_FAILED",
          message: materialized?.message || "",
          uploadedMediaId: materialized?.uploadedMediaId || ""
        };
      }
      const cacheMediaId = frameIdTail(materialized.mediaId || materialized.uploadedMediaId || materialized.confirmedImageId || materialized.assetImageId || "");
      if (cacheMediaId) {
        setFrameUploadCache(cacheKey, cacheMediaId, materialized.source || "fresh_frame_slot_picker");
        setFrameUploadCache(contentCacheKey, cacheMediaId, materialized.source || "fresh_frame_slot_picker");
      }
      if (materializedByFramePicker && (materialized.attached === true || frameSlotLooksFilled(ingredientType))) {
        emitStage("dom_frame_upload_confirmed", {
          ingredientType,
          fileName: materialized.fileName || safeUploadFileName(ref),
          confirmedImageId: materialized.confirmedImageId || materialized.assetImageId || "",
          uploadedMediaId: cacheMediaId,
          source: materialized.source || "fresh_frame_slot_picker"
        });
        return {
          ok: true,
          step: "dom_frame_upload",
          confirmedImageId: materialized.confirmedImageId || materialized.assetImageId || "",
          uploadedMediaId: cacheMediaId,
          ingredientType,
          source: materialized.source || "fresh_frame_slot_picker"
        };
      }
      const materializedRef = {
        ...ref,
        fileName: materialized.fileName || safeUploadFileName(ref),
        mediaId: materialized.mediaId || frameIdTail(materialized.assetImageId || ""),
        assetImageId: materialized.assetImageId || ""
      };
      const materializedBaseline = {
        ingredientCount: (store.getState().ingredients || []).length,
        chipCount: attachedChipCount(),
        ingredientIds: (store.getState().ingredients || []).map((ingredient) => String(ingredient?.imageId || "").trim()).filter(Boolean)
      };
      const selected = await selectFrameSlotAssetRow(materializedRef, store, materializedBaseline, ingredientType, emitStage, {
        taskId: context.taskId || "",
        source: "fresh_frame_materialized_row"
      });
      if (selected?.ok) {
        const selectedCacheMediaId = frameIdTail(selected.uploadedMediaId || materializedRef.mediaId || selected.confirmedImageId || "");
        if (selectedCacheMediaId) {
          setFrameUploadCache(cacheKey, selectedCacheMediaId, selected.source || "fresh_frame_materialized_row");
          setFrameUploadCache(contentCacheKey, selectedCacheMediaId, selected.source || "fresh_frame_materialized_row");
        }
        emitStage("dom_frame_upload_confirmed", {
          ingredientType,
          fileName: materializedRef.fileName || "",
          confirmedImageId: selected.confirmedImageId || "",
          uploadedMediaId: selectedCacheMediaId,
          source: selected.source || "fresh_frame_materialized_row"
        });
        return {
          ok: true,
          step: "dom_frame_upload",
          confirmedImageId: selected.confirmedImageId || "",
          uploadedMediaId: selectedCacheMediaId,
          ingredientType,
          source: selected.source || "fresh_frame_materialized_row"
        };
      }
      return {
        ok: false,
        step: selected?.step || "frame_slot_asset_row_attach",
        error: selected?.error || "DOM_FRAME_MATERIALIZED_ROW_NOT_CONFIRMED",
        confirmedImageId: selected?.confirmedImageId || "",
        uploadedMediaId: materializedRef.mediaId || ""
      };
    }

    const previousRoleImageId = isReferenceType ? "" : roleImageId(store, ingredientType);
    const cleared = isReferenceType ? 0 : clearRoleIngredient(store, ingredientType);
    emitStage("dom_frame_role_cleared", { ingredientType, cleared, previousRoleImageId });
    if (cleared > 0) await sleep(120);
    const liveBaseline = {
      ingredientCount: (store.getState().ingredients || []).length,
      chipCount: attachedChipCount(),
      ingredientIds: (store.getState().ingredients || []).map((ingredient) => String(ingredient?.imageId || "").trim()).filter(Boolean)
    };
    const hadExistingRoot = Boolean(root || findAssetBrowserRoot());
    if (hadExistingRoot) await closeAssetBrowser();
    emitStage("dom_frame_browser_open_start", { ingredientType, hasExistingRoot: hadExistingRoot });
    root = isReferenceType
      ? await openAssetBrowser()
      : await openAssetBrowserFromFrameSlot(ingredientType);
    emitStage("dom_frame_browser_open_done", { ingredientType, ok: Boolean(root) });
    if (!root) return { ok: false, step: "dom_frame_upload", error: "ASSET_BROWSER_NOT_OPEN" };
    await ensureAssetImageTab(root);
    root = findAssetBrowserRoot() || root;
    let fileInput = null;
    const uploadButton = findAssetUploadButton(root);
    if (uploadButton) {
      emitStage("dom_frame_upload_button_click", {
        ingredientType,
        text: visibleText(uploadButton).slice(0, 120)
      });
      pointerClick(uploadButton);
      for (let remain = 3000; remain > 0 && !fileInput; remain -= 160) {
        await sleep(160);
        fileInput = findNewestFileInput() || findAssetFileInput(root);
      }
    }
    if (!fileInput) fileInput = findNewestFileInput() || findAssetFileInput(root);
    emitStage("dom_frame_file_input_lookup", {
      ingredientType,
      found: Boolean(fileInput),
      newest: fileInput === findNewestFileInput(),
      accept: fileInput?.getAttribute?.("accept") || ""
    });
    emitStage("dom_frame_file_input_ready", { ingredientType, found: Boolean(fileInput) });
    if (!fileInput) return { ok: false, step: "dom_frame_upload", error: "ASSET_FILE_INPUT_NOT_FOUND" };
    const fileName = safeUploadFileName(ref);
    const preUploadFrameIds = new Set(collectVisibleFrameAssetIds(root));
    installFrameUploadCapture();
    try {
      emitStage("dom_frame_file_dispatch_start", { ingredientType, fileName });
      const file = await fileFromInlineImageUrl(inlineUrl, ref);
      const transfer = new DataTransfer();
      transfer.items.add(file);
      fileInput.files = transfer.files;
      fileInput.dispatchEvent(new Event("input", { bubbles: true }));
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      emitStage("dom_frame_file_dispatch_done", {
        ingredientType,
        fileName,
        size: Number(file.size || 0),
        type: file.type || "",
        spinnerVisible: uploadSpinnerVisible()
      });
    } catch (error) {
      emitStage("dom_frame_file_dispatch_failed", {
        ingredientType,
        fileName,
        message: String(error?.message || error || "")
      });
      return {
        ok: false,
        step: "dom_frame_upload",
        error: "DOM_FRAME_UPLOAD_DISPATCH_FAILED",
        message: String(error?.message || error || "")
      };
    }

    const uploadStartedAt = Date.now();
    let metadataPolls = 0;
    let lastMetadataPoll = 0;
    let confirmed = null;
    let lastObservedRoleImageId = "";
    let lastObservedRoleLoading = null;
    let uploadedMediaId = "";
    emitStage("dom_frame_confirm_loop_start", { ingredientType, fileName });
    for (let remain = 45000; remain > 0; remain -= 220) {
      if (!isReferenceType) {
        const currentRole = roleIngredient(store, ingredientType);
        const currentRoleImageId = String(currentRole?.imageId || "").trim();
        if (currentRoleImageId && !frameIdsMatch(currentRoleImageId, previousRoleImageId)) {
          const roleLoading = currentRole?.isLoading === true;
          const currentRoleTail = canonicalFrameId(currentRoleImageId);
          if (
            !frameIdsMatch(currentRoleImageId, lastObservedRoleImageId) ||
            roleLoading !== lastObservedRoleLoading
          ) {
            lastObservedRoleImageId = currentRoleImageId;
            lastObservedRoleLoading = roleLoading;
            emitStage("dom_frame_role_observed", {
              ingredientType,
              currentRoleImageId,
              roleLoading
            });
          }
          if (!roleLoading) {
            const capturedOrMetadataId = uploadedMediaId || frameIdTail(window.__AF_LAST_FRAME_UPLOAD_MEDIA_ID || "");
            if (isFreshFrameSlotUpload && preUploadFrameIds.has(currentRoleTail) && !frameIdsMatch(currentRoleImageId, capturedOrMetadataId)) {
              emitStage("dom_frame_stale_role_rejected", {
                ingredientType,
                currentRoleImageId,
                uploadedMediaId: capturedOrMetadataId,
                reason: "pre_upload_visible_asset"
              });
            } else if (isFreshFrameSlotUpload && !frameSlotLooksFilled(ingredientType)) {
              emitStage("dom_frame_role_waiting_for_visible_slot", {
                ingredientType,
                currentRoleImageId,
                uploadedMediaId: capturedOrMetadataId
              });
            } else {
              const retained = await attachFrameImageId(store, currentRoleImageId, ingredientType);
              const retainedInRole = frameIdsMatch(roleImageId(store, ingredientType), currentRoleImageId);
              const visibleAfterRetain = !isFreshFrameSlotUpload || frameSlotLooksFilled(ingredientType);
              if (retained && retainedInRole && visibleAfterRetain) {
                const cacheMediaId = frameIdTail(capturedOrMetadataId || currentRoleImageId);
                if (cacheMediaId) {
                  setFrameUploadCache(cacheKey, cacheMediaId, "prompt_store_role_retained");
                  setFrameUploadCache(contentCacheKey, cacheMediaId, "prompt_store_role_retained");
                }
                confirmed = {
                  ok: true,
                  confirmedImageId: currentRoleImageId,
                  source: "prompt_store_role_retained"
                };
                break;
              }
              emitStage("dom_frame_role_not_retained", {
                ingredientType,
                currentRoleImageId,
                uploadedMediaId,
                visibleAfterRetain
              });
              root = findAssetBrowserRoot() || root;
            }
          } else if (frameIdTail(window.__AF_LAST_FRAME_UPLOAD_MEDIA_ID || "")) {
            await sleep(350);
          }
        }
      }

      const capturedMediaId = frameIdTail(window.__AF_LAST_FRAME_UPLOAD_MEDIA_ID || "");
      if (capturedMediaId) {
        uploadedMediaId = capturedMediaId;
        setFrameUploadCache(cacheKey, capturedMediaId, "upload_response");
        setFrameUploadCache(contentCacheKey, capturedMediaId, "upload_response");
      }

      const uploadError = String(window.__AF_LAST_FRAME_UPLOAD_ERROR || "").trim();
      if (uploadError) {
        return {
          ok: false,
          step: "dom_frame_upload",
          error: "DOM_FRAME_UPLOAD_FAILED",
          message: uploadError,
          ingredientIds: (store.getState().ingredients || []).map((ingredient) => String(ingredient?.imageId || "").trim()).filter(Boolean),
          newIds: []
        };
      }

      const now = Date.now();
      if ((!uploadedMediaId || metadataPolls < 8) && (!lastMetadataPoll || now - lastMetadataPoll > 1200)) {
        metadataPolls += 1;
        lastMetadataPoll = now;
        emitStage("dom_frame_metadata_poll", { ingredientType, fileName, metadataPolls });
        const projectMediaId = await Promise.race([
          latestProjectMediaIdForFile(fileName, uploadStartedAt),
          sleep(2400).then(() => "")
        ]);
        const tail = frameIdTail(projectMediaId || "");
        emitStage("dom_frame_metadata_seen", { ingredientType, fileName, projectMediaId: tail });
        if (tail) {
          uploadedMediaId = uploadedMediaId || tail;
          setFrameUploadCache(cacheKey, tail, "project_metadata");
          setFrameUploadCache(contentCacheKey, tail, "project_metadata");
        }
      }

      const fallbackTargetId = isReferenceType && uploadedMediaId ? uploadedMediaId : "";
      const fallbackConfirm = await waitForAttachConfirmation(
        store,
        liveBaseline,
        fallbackTargetId,
        isReferenceType ? 900 : 220,
        ingredientType
      );
      if (fallbackConfirm.ok) {
        confirmed = {
          ok: true,
          ingredientIds: fallbackConfirm.ingredientIds || [],
          newIds: fallbackConfirm.newIds || [],
          confirmedImageId: fallbackConfirm.confirmedImageId || fallbackTargetId || "",
          source: isReferenceType ? "reference_store_confirmation" : "attach_confirmation"
        };
        break;
      }

      if (uploadedMediaId && !uploadSpinnerVisible()) break;

      await sleep(220);
    }
    if (!confirmed?.ok && isReferenceType) {
      const fallbackTargetId = uploadedMediaId || frameIdTail(window.__AF_LAST_FRAME_UPLOAD_MEDIA_ID || "");
      const referenceConfirm = await waitForAttachConfirmation(store, liveBaseline, fallbackTargetId, 1200, ingredientType);
      if (referenceConfirm.ok) {
        confirmed = {
          ok: true,
          ingredientIds: referenceConfirm.ingredientIds || [],
          newIds: referenceConfirm.newIds || [],
          confirmedImageId: referenceConfirm.confirmedImageId || fallbackTargetId || "",
          source: "reference_store_confirmation"
        };
      }
    }
    if (!confirmed?.ok && isReferenceType && uploadedMediaId) {
      const tail = frameIdTail(uploadedMediaId) || String(uploadedMediaId || "").replace(/^fe_id_/i, "");
      const attachCandidates = [...new Set([
        tail ? `fe_id_${tail}` : "",
        uploadedMediaId
      ].map((id) => String(id || "").trim()).filter(Boolean))];
      for (const candidateId of attachCandidates) {
        const storeAttached = addReferenceIngredient(store, candidateId, ingredientType);
        const directConfirm = storeAttached
          ? await waitForAttachConfirmation(store, liveBaseline, candidateId, 1000, ingredientType)
          : { ok: false };
        emitStage("dom_reference_upload_store_repair", {
          ingredientType,
          fileName,
          uploadedMediaId,
          candidateId,
          storeAttached,
          ok: Boolean(directConfirm?.ok),
          confirmedImageId: directConfirm?.confirmedImageId || ""
        });
        if (directConfirm?.ok) {
          confirmed = {
            ok: true,
            ingredientIds: directConfirm.ingredientIds || [],
            newIds: directConfirm.newIds || [],
            confirmedImageId: directConfirm.confirmedImageId || candidateId,
            source: "reference_upload_store_repair"
          };
          break;
        }
      }
    }
    if (!confirmed?.ok && uploadedMediaId) {
      const uploadedRef = {
        ...ref,
        mediaId: uploadedMediaId,
        assetImageId: `fe_id_${frameIdTail(uploadedMediaId) || String(uploadedMediaId).replace(/^fe_id_/i, "")}`
      };
      const searchInput = findAssetSearchInput(root);
      const searchTerms = assetPickerSearchTermsForRef(uploadedRef, [fileName, uploadedRef.title]);
      let row = pickAssetRow(listAssetRows(root), uploadedRef);
      emitStage("dom_asset_row_search_start", { ingredientType, fileName, uploadedMediaId, searchTerms });
      for (const term of searchTerms) {
        if (row) break;
        root = findAssetBrowserRoot() || root;
        if (searchInput) {
          setInputValue(searchInput, term);
          await sleep(420);
        }
        for (let poll = 0; poll < 40 && !row; poll += 1) {
          root = findAssetBrowserRoot() || root;
          row = pickAssetRow(listAssetRows(root), uploadedRef);
          if (!row) await sleep(250);
        }
        if (row) break;
      }
      if (!row && searchInput) {
        setInputValue(searchInput, "");
        await sleep(250);
      }
      if (!row) {
        for (let poll = 0; poll < 18 && !row; poll += 1) {
          root = findAssetBrowserRoot() || root;
          row = pickAssetRow(listAssetRows(root), uploadedRef);
          if (!row) await sleep(300);
        }
      }
      emitStage("dom_asset_row_search_done", {
        ingredientType,
        ok: Boolean(row),
        uploadedMediaId,
        rowText: row ? rowText(row).slice(0, 140) : ""
      });
      if (row) {
        const rowIds = [...assetIdsFromRow(row)];
        const rowImageId = rowIds.find((id) => idsMatch(id, uploadedRef.assetImageId))
          || rowIds.find((id) => idsMatch(id, uploadedRef.mediaId))
          || rowIds.find((id) => /^fe_id_/i.test(id))
          || uploadedRef.assetImageId;
        for (const candidate of clickableRowCandidates(row)) {
          pointerClick(candidate);
          try {
            candidate.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            candidate.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
          } catch {}
          confirmed = await waitForAttachConfirmation(store, liveBaseline, rowImageId, 2600, ingredientType);
          if (isFreshFrameSlotUpload && confirmed?.ok && !frameSlotLooksFilled(ingredientType)) {
            emitStage("dom_frame_row_click_not_visible", {
              ingredientType,
              fileName,
              rowImageId,
              uploadedMediaId
            });
            confirmed = null;
            root = findAssetBrowserRoot() || root;
            await sleep(300);
            continue;
          }
          if (confirmed.ok) break;
        }
        if (!confirmed?.ok && rowImageId && !isFreshFrameSlotUpload) {
          const storeAttached = await attachFrameImageId(store, rowImageId, ingredientType);
          confirmed = storeAttached
            ? await waitForAttachConfirmation(store, liveBaseline, rowImageId, 1400, ingredientType)
            : confirmed;
          if (confirmed?.ok) confirmed.source = "asset_row_store_repair";
        }
        if (confirmed?.ok) {
          confirmed = {
            ...confirmed,
            confirmedImageId: confirmed.confirmedImageId || rowImageId,
            source: confirmed.source || "asset_row_click"
          };
        }
      }
    }
    if (confirmed?.ok) {
      if (isReferenceType && confirmed.confirmedImageId && ingredientType !== "REFERENCE") {
        const typeRepairIds = [
          confirmed.confirmedImageId,
          uploadedMediaId,
          uploadedMediaId ? `fe_id_${frameIdTail(uploadedMediaId) || String(uploadedMediaId).replace(/^fe_id_/i, "")}` : ""
        ].filter(Boolean);
        const typeRepairOk = coerceReferenceIngredientType(store, typeRepairIds, ingredientType);
        emitStage("dom_reference_upload_type_repair", {
          ingredientType,
          fileName,
          confirmedImageId: confirmed.confirmedImageId || "",
          uploadedMediaId: frameIdTail(uploadedMediaId || confirmed.confirmedImageId || ""),
          ok: Boolean(typeRepairOk)
        });
      }
      const cacheable = frameIdTail(confirmed.confirmedImageId || "") || String(confirmed.confirmedImageId || "").trim();
      if (cacheable) {
        setFrameUploadCache(cacheKey, confirmed.confirmedImageId, confirmed.source || "upload_response");
        setFrameUploadCache(contentCacheKey, confirmed.confirmedImageId, confirmed.source || "upload_response");
      }
      await closeAssetBrowser();
      await sleep(220);
      emitStage("dom_frame_upload_confirmed", {
        ingredientType,
        fileName,
        confirmedImageId: confirmed.confirmedImageId || "",
        uploadedMediaId: frameIdTail(uploadedMediaId || confirmed.confirmedImageId || ""),
        source: confirmed.source || "",
        cached: Boolean(cacheable)
      });
      return {
        ok: true,
        step: "dom_frame_upload",
        confirmedImageId: confirmed.confirmedImageId,
        uploadedMediaId: frameIdTail(uploadedMediaId || confirmed.confirmedImageId || ""),
        ingredientType,
        source: confirmed.source || ""
      };
    }
    emitStage("dom_frame_upload_timeout", {
      ingredientType,
      fileName,
      uploadedMediaId: uploadedMediaId || frameIdTail(window.__AF_LAST_FRAME_UPLOAD_MEDIA_ID || "")
    });
    return {
      ok: false,
      step: "dom_frame_upload",
      error: "DOM_FRAME_UPLOAD_NOT_CONFIRMED",
      uploadedMediaId: uploadedMediaId || frameIdTail(window.__AF_LAST_FRAME_UPLOAD_MEDIA_ID || ""),
      ingredientIds: confirmed?.ingredientIds || [],
      newIds: confirmed?.newIds || []
    };
  }

  function attachedChipCount() {
    return Array.from(document.querySelectorAll("[data-card-open],button[data-card-open]"))
      .filter((element) => element.querySelector?.("img"))
      .length;
  }

  function ingredientTypeForRef(ref = {}, index = 0) {
    const role = String(ref.role || "").trim();
    if (role === "startFrameRef") return "FIRST_FRAME";
    if (role === "endFrameRef") return "LAST_FRAME";
    if (role === "ingredientsRefs") return "INGREDIENT";
    if (role === "styleRefRefs") return "REFERENCE";
    if (role === "omniRefRefs") return "REFERENCE";
    if (role === "imagePromptRefs") return "REFERENCE";
    return index === 0 ? "FIRST_FRAME" : "REFERENCE";
  }

  function isReferenceLikeIngredientType(ingredientType = "") {
    return ingredientType === "REFERENCE" || ingredientType === "INGREDIENT";
  }

  function buildIngredient(imageId, type) {
    return {
      imageId,
      isLoading: false,
      addedTime: new Date().toISOString(),
      modifiedTime: new Date().toISOString(),
      cropCoordinates: { top: 0, left: 0, bottom: 1, right: 1 },
      preferredIngredientType: type
    };
  }

  function roleIngredient(store, ingredientType) {
    const ingredients = store?.getState?.()?.ingredients || [];
    return ingredients.find((ingredient) => ingredient?.preferredIngredientType === ingredientType) || null;
  }

  function roleImageId(store, ingredientType) {
    const entry = roleIngredient(store, ingredientType);
    return String(entry?.imageId || "").trim();
  }

  function frameIdTail(value = "") {
    const match = String(value || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? String(match[0] || "").trim() : "";
  }

  function canonicalFrameId(value = "") {
    return frameIdTail(value) || String(value || "").trim().replace(/^fe_id_/i, "");
  }

  function frameIdsMatch(left = "", right = "") {
    const a = canonicalFrameId(left);
    const b = canonicalFrameId(right);
    return Boolean(a && b && a === b);
  }

  function frameStoreIdCandidates(ref = {}) {
    const raw = [
      ref.assetImageId,
      ref.mediaId,
      frameIdTail(ref.assetImageId || ref.mediaId || "")
    ].map((value) => String(value || "").trim()).filter(Boolean);
    const out = [];
    for (const value of raw) {
      const tail = frameIdTail(value) || value.replace(/^fe_id_/i, "");
      for (const candidate of [value, tail, tail ? `fe_id_${tail}` : ""]) {
        if (candidate && !out.includes(candidate)) out.push(candidate);
      }
    }
    return out;
  }

  function referenceImageIdAttachCandidates(value = "") {
    const raw = String(value || "").trim();
    const tail = frameIdTail(raw) || raw.replace(/^fe_id_/i, "");
    return [...new Set([
      tail ? `fe_id_${tail}` : "",
      ...refSerializationVariants(raw),
      ...refSerializationVariants(tail)
    ].map((candidate) => String(candidate || "").trim()).filter(Boolean))];
  }

  function referenceStoreImageIdForRef(ref = {}) {
    const assetImageId = String(ref.assetImageId || "").trim();
    if (assetImageId) return assetImageId;
    const tail = frameIdTail(ref.mediaId || "");
    if (tail) return `fe_id_${tail}`;
    return String(ref.mediaId || "").trim();
  }

  function setRoleIngredient(store, imageId = "", ingredientType = "FIRST_FRAME") {
    const id = String(imageId || "").trim();
    const state = store?.getState?.();
    if (!id || !state) return false;
    if (frameIdsMatch(roleImageId(store, ingredientType), id)) return true;
    const current = Array.isArray(state.ingredients) ? state.ingredients : [];
    const next = [
      ...current.filter((ingredient) => ingredient?.preferredIngredientType !== ingredientType),
      buildIngredient(id, ingredientType)
    ];
    try {
      if (typeof state.actions?.addIngredient === "function") {
        state.actions.addIngredient(buildIngredient(id, ingredientType));
        if (frameIdsMatch(roleImageId(store, ingredientType), id)) return true;
      }
      if (typeof state.actions?.setIngredients === "function") {
        state.actions.setIngredients(next);
        if (frameIdsMatch(roleImageId(store, ingredientType), id)) return true;
      }
      if (typeof store.setState === "function") {
        store.setState({ ingredients: next });
        if (frameIdsMatch(roleImageId(store, ingredientType), id)) return true;
      }
    } catch {}
    return frameIdsMatch(roleImageId(store, ingredientType), id);
  }

  function hasIngredientImageId(store, imageId = "") {
    const id = String(imageId || "").trim();
    if (!id) return false;
    return (store?.getState?.()?.ingredients || []).some((ingredient) => frameIdsMatch(ingredient?.imageId, id));
  }

  function addReferenceIngredient(store, imageId = "", ingredientType = "REFERENCE") {
    const id = String(imageId || "").trim();
    const state = store?.getState?.();
    if (!id || !state) return false;
    if (hasIngredientImageId(store, id)) return true;
    const current = Array.isArray(state.ingredients) ? state.ingredients : [];
    const next = [...current, buildIngredient(id, ingredientType)];
    try {
      if (typeof state.actions?.addIngredient === "function") {
        state.actions.addIngredient(buildIngredient(id, ingredientType));
        if (hasIngredientImageId(store, id)) return true;
      }
      if (typeof state.actions?.setIngredients === "function") {
        state.actions.setIngredients(next);
        if (hasIngredientImageId(store, id)) return true;
      }
      if (typeof store.setState === "function") {
        store.setState({ ingredients: next });
        if (hasIngredientImageId(store, id)) return true;
      }
    } catch {}
    return hasIngredientImageId(store, id);
  }

  function clearAllIngredients(store) {
    const state = store?.getState?.();
    if (!state) return 0;
    const current = Array.isArray(state.ingredients) ? state.ingredients : [];
    try {
      if (typeof state.actions?.setIngredients === "function") {
        state.actions.setIngredients([]);
      } else if (typeof store.setState === "function") {
        store.setState({ ingredients: [] });
      }
    } catch {}
    return current.length;
  }

  async function clearStaleIngredientsForNoRefTask(task = {}, onStage = null, reason = "no_ref_task") {
    const mode = String(task.mode || "");
    if (!["text-to-video", "text-to-image"].includes(mode)) return { ok: true, skipped: true, reason: "mode_allows_refs" };
    if (domTaskRequiresAttach(task)) return { ok: true, skipped: true, reason: "task_has_refs" };
    const store = resolvePromptStore();
    if (!store) return { ok: false, error: "PROMPT_STORE_NOT_FOUND", reason };
    const before = Array.isArray(store.getState?.()?.ingredients) ? store.getState().ingredients : [];
    let after = before;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      clearAllIngredients(store);
      await sleep(attempt === 0 ? 120 : 220);
      after = Array.isArray(store.getState?.()?.ingredients) ? store.getState().ingredients : [];
      if (!after.length) break;
    }
    const result = {
      ok: after.length === 0,
      reason,
      cleared: before.length,
      ingredientCount: after.length,
      beforeIngredientIds: before.map((ingredient) => String(ingredient?.imageId || ingredient?.mediaId || "").trim()).filter(Boolean).slice(0, 12),
      afterIngredientIds: after.map((ingredient) => String(ingredient?.imageId || ingredient?.mediaId || "").trim()).filter(Boolean).slice(0, 12)
    };
    if (typeof onStage === "function") {
      onStage("no_ref_ingredients_clear", result);
    }
    return result;
  }

  function setReferenceIngredients(store, imageIds = [], ingredientType = "REFERENCE") {
    const ids = [...new Set(imageIds.map((id) => String(id || "").trim()).filter(Boolean))];
    const state = store?.getState?.();
    if (!ids.length || !state) return false;
    const type = isReferenceLikeIngredientType(ingredientType) ? ingredientType : "REFERENCE";
    const next = ids.map((id) => buildIngredient(id, type));
    const setDirect = () => {
      if (typeof store.setState !== "function") return false;
      store.setState({ ingredients: next });
      return ids.every((id) => hasIngredientImageId(store, id));
    };
    try {
      if (setDirect()) return true;
      if (typeof state.actions?.clearIngredients === "function") {
        state.actions.clearIngredients();
        if (setDirect()) return true;
      }
      if (typeof state.actions?.setIngredients === "function") {
        state.actions.setIngredients(next);
      } else if (typeof store.setState === "function") {
        store.setState({ ingredients: next });
      }
    } catch {}
    if (ids.every((id) => hasIngredientImageId(store, id))) return true;
    try {
      for (const ingredient of next) state.actions?.addIngredient?.(ingredient);
    } catch {}
    return ids.every((id) => hasIngredientImageId(store, id));
  }

  function coerceReferenceIngredientType(store, imageIds = [], ingredientType = "REFERENCE") {
    const ids = [...new Set(imageIds.map((id) => String(id || "").trim()).filter(Boolean))];
    const state = store?.getState?.();
    if (!ids.length || !state) return false;
    const type = isReferenceLikeIngredientType(ingredientType) ? ingredientType : "REFERENCE";
    const current = Array.isArray(state.ingredients) ? state.ingredients : [];
    let matched = false;
    const next = current.map((ingredient) => {
      const imageId = String(ingredient?.imageId || "").trim();
      if (!ids.some((id) => idsMatch(id, imageId))) return ingredient;
      matched = true;
      return {
        ...ingredient,
        preferredIngredientType: type
      };
    });
    if (!matched) return false;
    const apply = () => {
      if (typeof state.actions?.setIngredients === "function") {
        state.actions.setIngredients(next);
        return true;
      }
      if (typeof store.setState === "function") {
        store.setState({ ingredients: next });
        return true;
      }
      return false;
    };
    try {
      apply();
    } catch {}
    const final = Array.isArray(store.getState?.()?.ingredients) ? store.getState().ingredients : [];
    return ids.every((id) => final.some((ingredient) =>
      idsMatch(id, ingredient?.imageId) && String(ingredient?.preferredIngredientType || "") === type
    ));
  }

  async function setReferenceIngredientsWithRetry(store, imageIds = [], options = {}) {
    const ids = [...new Set(imageIds.map((id) => String(id || "").trim()).filter(Boolean))];
    const ingredientType = isReferenceLikeIngredientType(options.ingredientType) ? options.ingredientType : "REFERENCE";
    const timeoutMs = Math.max(400, Number(options.timeoutMs || 1800) || 1800);
    const intervalMs = Math.max(100, Number(options.intervalMs || 220) || 220);
    const endAt = Date.now() + timeoutMs;
    let finalIds = [];
    let finalIngredients = [];
    let missing = ids;
    let ok = false;
    do {
      ok = setReferenceIngredients(store, ids, ingredientType);
      await sleep(intervalMs);
      finalIngredients = (store?.getState?.()?.ingredients || []).map((ingredient) => ({
        imageId: String(ingredient?.imageId || "").trim(),
        preferredIngredientType: String(ingredient?.preferredIngredientType || "").trim()
      })).filter((ingredient) => ingredient.imageId);
      finalIds = finalIngredients.map((ingredient) => ingredient.imageId);
      missing = ids.filter((targetId) => !finalIds.some((actualId) => idsMatch(actualId, targetId)));
      if (ok && !missing.length) break;
    } while (Date.now() <= endAt);
    return {
      ok: Boolean(ok && !missing.length),
      ingredientType,
      finalIds,
      finalIngredients,
      missing
    };
  }

  function clearRoleIngredient(store, ingredientType = "FIRST_FRAME") {
    const state = store?.getState?.();
    const current = Array.isArray(state?.ingredients) ? state.ingredients : [];
    const next = current.filter((ingredient) => ingredient?.preferredIngredientType !== ingredientType);
    if (next.length === current.length) return 0;
    try {
      if (typeof state.actions?.setIngredients === "function") {
        state.actions.setIngredients(next);
      } else if (typeof store?.setState === "function") {
        store.setState({ ingredients: next });
      }
    } catch {}
    return current.length - next.length;
  }

  async function closeAssetBrowser() {
    const eventInit = { key: "Escape", keyCode: 27, bubbles: true, cancelable: true, composed: true };
    for (let attempt = 0; attempt < 8 && findAssetBrowserRoot(); attempt += 1) {
      for (const target of [document.activeElement, document.body, document].filter(Boolean)) {
        try {
          target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
          target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
        } catch {}
      }
      await sleep(180);
    }
    return !findAssetBrowserRoot();
  }

  async function dismissFloatingMenus() {
    const eventInit = { key: "Escape", keyCode: 27, bubbles: true, cancelable: true, composed: true };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const target of [document.activeElement, document.body, document].filter(Boolean)) {
        try {
          target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
          target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
        } catch {}
      }
      await sleep(90);
    }
  }

  function installFrameUploadCapture() {
    try {
      window.__AF_LAST_FRAME_UPLOAD_MEDIA_ID = "";
      window.__AF_LAST_FRAME_UPLOAD_ERROR = "";
      const captureVersion = "frame-upload-capture-v3";
      const baseFetch = window.__afRebuildSubmitCaptureFetch || window.fetch;
      if (
        window.__AF_FRAME_UPLOAD_CAPTURE_INSTALLED === captureVersion &&
        window.__AF_FRAME_UPLOAD_CAPTURE_BASE_FETCH === baseFetch
      ) {
        return true;
      }
      const originalFetch = baseFetch;
      window.__AF_FRAME_UPLOAD_CAPTURE_ORIGINAL_FETCH = originalFetch;
      window.fetch = async function afFrameUploadCaptureFetch(...args) {
        const response = await originalFetch.apply(this, args);
        try {
          const url = String(args?.[0]?.url || args?.[0] || "");
          if (url.includes("/flow/uploadImage")) {
            if (!response?.ok) {
              window.__AF_LAST_FRAME_UPLOAD_ERROR = `upload_http_${response?.status || 0}`;
            }
            const text = await response.text().catch(() => "");
            let data = null;
            try {
              data = text ? JSON.parse(text) : null;
            } catch {
              window.__AF_LAST_FRAME_UPLOAD_ERROR = "upload_response_parse_failed";
            }
            if (data) {
              if (!response?.ok) {
                window.__AF_LAST_FRAME_UPLOAD_ERROR = data?.error?.message || data?.error?.status || window.__AF_LAST_FRAME_UPLOAD_ERROR || "upload_failed";
              } else {
                const candidates = [
                  data?.media?.name,
                  data?.mediaGenerationId?.mediaGenerationId,
                  data?.workflows?.[0]?.metadata?.primaryMediaId,
                  data?.workflow?.metadata?.primaryMediaId,
                  data?.mediaId,
                  data?.name
                ];
                const queue = [data];
                let scanned = 0;
                while (queue.length && scanned < 300) {
                  const node = queue.shift();
                  scanned += 1;
                  if (!node || typeof node !== "object") continue;
                  if (Array.isArray(node)) {
                    queue.push(...node);
                    continue;
                  }
                  for (const [key, child] of Object.entries(node)) {
                    if (typeof child === "string" && /^(name|mediaid|primarymediaid)$/i.test(key)) {
                      candidates.push(child);
                    } else if (child && typeof child === "object") {
                      queue.push(child);
                    }
                  }
                }
                const picked = candidates.map(frameIdTail).find(Boolean) || "";
                if (picked) window.__AF_LAST_FRAME_UPLOAD_MEDIA_ID = picked;
              }
            }
            return rebuildTextResponse(response, text);
          }
        } catch {}
        return response;
      };
      window.fetch.__afFrameUploadCaptureVersion = captureVersion;
      window.__AF_FRAME_UPLOAD_CAPTURE_INSTALLED = captureVersion;
      window.__AF_FRAME_UPLOAD_CAPTURE_BASE_FETCH = originalFetch;
      return true;
    } catch {
      return false;
    }
  }

  async function latestProjectMediaIdForFile(fileName = "", uploadedAfterMs = 0) {
    const expected = String(fileName || "").trim().toLowerCase();
    const projectId = String(location.pathname || "").match(/\/project\/([^/?#]+)/i)?.[1] || "";
    if (!projectId || !expected) return "";
    try {
      const input = encodeURIComponent(JSON.stringify({ json: { projectId: decodeURIComponent(projectId) } }));
      const fetchImpl = window.__afRebuildNativeFetch || originalFetch || window.fetch;
      const abort = withAbortTimeout(2200);
      let response;
      try {
        response = await fetchImpl.call(window, `/fx/api/trpc/flow.projectInitialData?input=${input}`, {
          credentials: "include",
          signal: abort.signal
        });
      } finally {
        abort.cancel();
      }
      if (!response?.ok) return "";
      const data = await response.json();
      const workflows = data?.result?.data?.json?.projectContents?.workflows;
      if (!Array.isArray(workflows)) return "";
      const minCreateTime = Number(uploadedAfterMs || 0) - 15000;
      const matches = workflows
        .map((workflow) => {
          const metadata = workflow?.metadata || {};
          return {
            mediaId: frameIdTail(metadata.primaryMediaId || ""),
            displayName: String(metadata.displayName || "").trim().toLowerCase(),
            createMs: Date.parse(metadata.createTime || metadata.updateTime || "") || 0
          };
        })
        .filter((entry) =>
          entry.mediaId &&
          entry.displayName === expected &&
          (!minCreateTime || !entry.createMs || entry.createMs >= minCreateTime)
        )
        .sort((a, b) => (b.createMs || 0) - (a.createMs || 0));
      return matches[0]?.mediaId || "";
    } catch {
      return "";
    }
  }

  async function latestProjectMediaIdsForFiles(fileNames = [], uploadedAfterMs = 0) {
    const expectedNames = [...new Set((Array.isArray(fileNames) ? fileNames : [])
      .map((fileName) => String(fileName || "").trim().toLowerCase())
      .filter(Boolean))];
    const projectId = String(location.pathname || "").match(/\/project\/([^/?#]+)/i)?.[1] || "";
    if (!projectId || !expectedNames.length) return {};
    try {
      const input = encodeURIComponent(JSON.stringify({ json: { projectId: decodeURIComponent(projectId) } }));
      const fetchImpl = window.__afRebuildNativeFetch || originalFetch || window.fetch;
      const abort = withAbortTimeout(2600);
      let response;
      try {
        response = await fetchImpl.call(window, `/fx/api/trpc/flow.projectInitialData?input=${input}`, {
          credentials: "include",
          signal: abort.signal
        });
      } finally {
        abort.cancel();
      }
      if (!response?.ok) return {};
      const data = await response.json();
      const workflows = data?.result?.data?.json?.projectContents?.workflows;
      if (!Array.isArray(workflows)) return {};
      const wanted = new Set(expectedNames);
      const minCreateTime = Number(uploadedAfterMs || 0) - 15000;
      const matches = workflows
        .map((workflow) => {
          const metadata = workflow?.metadata || {};
          return {
            mediaId: frameIdTail(metadata.primaryMediaId || ""),
            displayName: String(metadata.displayName || "").trim().toLowerCase(),
            createMs: Date.parse(metadata.createTime || metadata.updateTime || "") || 0
          };
        })
        .filter((entry) =>
          entry.mediaId &&
          wanted.has(entry.displayName) &&
          (!minCreateTime || !entry.createMs || entry.createMs >= minCreateTime)
        )
        .sort((a, b) => (b.createMs || 0) - (a.createMs || 0));
      const out = {};
      for (const entry of matches) {
        if (!out[entry.displayName]) out[entry.displayName] = entry.mediaId;
      }
      return out;
    } catch {
      return {};
    }
  }

  async function uploadReferencesViaProjectAddMediaBatch(refs = [], onStage = null) {
    const emitStage = (stage, extra = {}) => {
      try {
        if (typeof onStage === "function") onStage(stage, extra);
      } catch {}
    };
    const entries = (Array.isArray(refs) ? refs : []).map((ref, index) => ({
      ref,
      index,
      inlineUrl: inlineImageUrlForRef(ref),
      fileName: safeUploadFileName(ref)
    }));
    const missing = entries.filter((entry) => !entry.inlineUrl || !entry.fileName);
    if (!entries.length) return { ok: true, step: "project_add_media_batch_upload", outcomes: [] };
    if (missing.length) {
      return {
        ok: false,
        step: "project_add_media_batch_upload",
        error: "NO_INLINE_IMAGE_DATA",
        missing: missing.map((entry) => ({ index: entry.index, fileName: entry.fileName }))
      };
    }

    await closeAssetBrowser();
    const addButton = findProjectAddMediaButton();
    emitStage("project_add_media_batch_button_lookup", {
      refCount: entries.length,
      fileNames: entries.map((entry) => entry.fileName),
      found: Boolean(addButton),
      text: addButton ? visibleText(addButton).slice(0, 120) : ""
    });

    let fileInput = findNewestFileInput();
    if (addButton) {
      pointerClick(addButton);
      for (let remain = 2600; remain > 0 && !fileInput; remain -= 160) {
        await sleep(160);
        if (findAssetBrowserRoot()) {
          await closeAssetBrowser();
          emitStage("project_add_media_batch_opened_asset_browser", { refCount: entries.length });
          return {
            ok: false,
            step: "project_add_media_batch_upload",
            error: "PROJECT_ADD_MEDIA_OPENED_ASSET_BROWSER"
          };
        }
        fileInput = findNewestFileInput() || findAssetFileInput(document);
      }
    }
    if (!fileInput) fileInput = findNewestFileInput() || findAssetFileInput(document);
    emitStage("project_add_media_batch_file_input_ready", {
      refCount: entries.length,
      found: Boolean(fileInput),
      accept: fileInput?.getAttribute?.("accept") || "",
      multiple: Boolean(fileInput?.multiple)
    });
    if (!fileInput) {
      return {
        ok: false,
        step: "project_add_media_batch_upload",
        error: "PROJECT_ADD_MEDIA_FILE_INPUT_NOT_FOUND"
      };
    }

    installFrameUploadCapture();
    try {
      window.__AF_LAST_FRAME_UPLOAD_MEDIA_ID = "";
      window.__AF_LAST_FRAME_UPLOAD_ERROR = "";
    } catch {}
    const uploadStartedAt = Date.now();
    try {
      const files = await Promise.all(entries.map((entry) => fileFromInlineImageUrl(entry.inlineUrl, entry.ref)));
      const transfer = new DataTransfer();
      files.forEach((file) => transfer.items.add(file));
      fileInput.files = transfer.files;
      emitStage("project_add_media_batch_file_dispatch_start", {
        refCount: entries.length,
        files: entries.map((entry, index) => ({
          index: entry.index,
          fileName: entry.fileName,
          size: Number(files[index]?.size || 0),
          type: files[index]?.type || ""
        }))
      });
      fileInput.dispatchEvent(new Event("input", { bubbles: true }));
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      emitStage("project_add_media_batch_file_dispatch_done", {
        refCount: entries.length,
        spinnerVisible: uploadSpinnerVisible()
      });
      await dismissFloatingMenus();
    } catch (error) {
      emitStage("project_add_media_batch_file_dispatch_failed", {
        refCount: entries.length,
        message: String(error?.message || error || "")
      });
      return {
        ok: false,
        step: "project_add_media_batch_upload",
        error: "PROJECT_ADD_MEDIA_DISPATCH_FAILED",
        message: String(error?.message || error || "")
      };
    }

    const states = entries.map((entry) => ({
      ...entry,
      uploadedMediaId: "",
      metadataPolls: 0,
      lastMetadataPoll: 0,
      lastProgress: "",
      lastProgressEmit: 0,
      completeCandidateKey: "",
      completeCandidateSince: 0,
      lastCompleteCandidateEmit: 0,
      outcome: null
    }));

    for (let remain = 90000; remain > 0; remain -= 260) {
      const uploadError = String(window.__AF_LAST_FRAME_UPLOAD_ERROR || "").trim();
      if (uploadError) {
        return {
          ok: false,
          step: "project_add_media_batch_upload",
          error: "PROJECT_ADD_MEDIA_UPLOAD_FAILED",
          message: uploadError,
          outcomes: states.map((state) => state.outcome).filter(Boolean)
        };
      }

      const pending = states.filter((state) => !state.outcome);
      if (!pending.length) {
        return {
          ok: true,
          step: "project_add_media_batch_upload",
          outcomes: states.map((state) => state.outcome)
        };
      }

      const now = Date.now();
      const needsMetadata = pending.filter((state) =>
        (!state.uploadedMediaId || state.metadataPolls < 8) &&
        (!state.lastMetadataPoll || now - state.lastMetadataPoll > 1000)
      );
      if (needsMetadata.length) {
        const metadata = await Promise.race([
          latestProjectMediaIdsForFiles(needsMetadata.map((state) => state.fileName), uploadStartedAt),
          sleep(2600).then(() => ({}))
        ]);
        for (const state of needsMetadata) {
          state.metadataPolls += 1;
          state.lastMetadataPoll = now;
          const projectTail = frameIdTail(metadata[String(state.fileName || "").trim().toLowerCase()] || "");
          emitStage("project_add_media_batch_metadata_seen", {
            index: state.index,
            fileName: state.fileName,
            metadataPolls: state.metadataPolls,
            projectMediaId: projectTail
          });
          if (projectTail) state.uploadedMediaId = projectTail;
        }
      }

      for (const state of pending) {
        const card = findProjectMediaCardForFile(state.fileName);
        if (card?.progress && (card.progress !== state.lastProgress || Date.now() - state.lastProgressEmit > 2200)) {
          state.lastProgress = card.progress;
          state.lastProgressEmit = Date.now();
          emitStage("project_add_media_batch_upload_progress", {
            index: state.index,
            fileName: state.fileName,
            progress: card.progress,
            tileId: card.tileId || "",
            mediaId: card.mediaId || state.uploadedMediaId || ""
          });
        }
        if (card?.element && !card.progress && (card.tileId || card.mediaId || state.uploadedMediaId)) {
          const assetImageId = card.tileId || (state.uploadedMediaId ? `fe_id_${state.uploadedMediaId}` : "");
          const tail = frameIdTail(card.mediaId || state.uploadedMediaId || assetImageId);
          const candidateKey = `${assetImageId}|${tail || state.uploadedMediaId}`;
          const spinnerVisible = uploadSpinnerVisible();
          if (candidateKey !== state.completeCandidateKey || spinnerVisible) {
            state.completeCandidateKey = candidateKey;
            state.completeCandidateSince = spinnerVisible ? 0 : Date.now();
          } else if (!state.completeCandidateSince) {
            state.completeCandidateSince = Date.now();
          }
          if (!state.lastCompleteCandidateEmit || Date.now() - state.lastCompleteCandidateEmit > 2200) {
            state.lastCompleteCandidateEmit = Date.now();
            emitStage("project_add_media_batch_visible_complete_candidate", {
              index: state.index,
              fileName: state.fileName,
              uploadedMediaId: tail || state.uploadedMediaId,
              assetImageId,
              spinnerVisible,
              stableMs: state.completeCandidateSince ? Math.max(0, Date.now() - state.completeCandidateSince) : 0
            });
          }
          if (spinnerVisible || !state.completeCandidateSince || Date.now() - state.completeCandidateSince < 1800) {
            continue;
          }
          state.outcome = {
            ok: true,
            step: "project_add_media_batch_upload",
            index: state.index,
            fileName: state.fileName,
            mediaId: tail || state.uploadedMediaId,
            assetImageId,
            confirmedImageId: assetImageId,
            source: card.tileId ? "visible_completed_project_tile" : "project_metadata"
          };
          emitStage("project_add_media_batch_visible_confirmed", {
            index: state.index,
            fileName: state.fileName,
            uploadedMediaId: state.outcome.mediaId,
            assetImageId,
            source: state.outcome.source
          });
        }
        if (!card?.element || card.progress) {
          state.completeCandidateKey = "";
          state.completeCandidateSince = 0;
        }
      }
      await sleep(260);
    }

    return {
      ok: false,
      step: "project_add_media_batch_upload",
      error: "PROJECT_UPLOAD_NOT_COMPLETE",
      outcomes: states.map((state) => state.outcome).filter(Boolean),
      pending: states
        .filter((state) => !state.outcome)
        .map((state) => ({ index: state.index, fileName: state.fileName, uploadedMediaId: state.uploadedMediaId }))
    };
  }

  async function attachFrameImageId(store, imageId = "", ingredientType = "FIRST_FRAME") {
    const id = String(imageId || "").trim();
    if (!id) return false;
    if (isReferenceLikeIngredientType(ingredientType)) {
      const candidateIds = referenceImageIdAttachCandidates(id);
      const addAnyReferenceCandidate = () => {
        for (const candidateId of candidateIds) {
          if (addReferenceIngredient(store, candidateId, ingredientType)) return true;
        }
        return false;
      };
      const hasAnyReferenceCandidate = () => candidateIds.some((candidateId) => hasIngredientImageId(store, candidateId));
      const beforeCloseOk = addAnyReferenceCandidate();
      await sleep(140);
      await closeAssetBrowser();
      const afterCloseOk = addAnyReferenceCandidate();
      await sleep(220);
      return Boolean((beforeCloseOk || afterCloseOk) && hasAnyReferenceCandidate());
    }
    const beforeCloseOk = setRoleIngredient(store, id, ingredientType);
    await sleep(140);
    await closeAssetBrowser();
    const afterCloseOk = setRoleIngredient(store, id, ingredientType);
    await sleep(220);
    return Boolean((beforeCloseOk || afterCloseOk) && frameIdsMatch(roleImageId(store, ingredientType), id));
  }

  async function waitForAttachConfirmation(store, baseline = {}, targetImageId = "", timeoutMs = 2800, ingredientType = "") {
    const beforeIds = new Set((baseline.ingredientIds || []).map((id) => String(id || "").trim()).filter(Boolean));
    for (let remain = timeoutMs; remain > 0; remain -= 180) {
      const ingredients = store.getState().ingredients || [];
      const ingredientIds = ingredients.map((ingredient) => String(ingredient?.imageId || "").trim()).filter(Boolean);
      const newIds = ingredientIds.filter((id) => !beforeIds.has(id));
      const targetPresent = !targetImageId || ingredientIds.some((id) => idsMatch(id, targetImageId));
      const targetInRoleSlot = Boolean(targetImageId && ingredientType && (
        isReferenceLikeIngredientType(ingredientType)
          ? hasIngredientImageId(store, targetImageId)
          : frameIdsMatch(roleImageId(store, ingredientType), targetImageId)
      ));
      const countIncreased = ingredients.length > Number(baseline.ingredientCount || 0);
      const chipIncreased = attachedChipCount() > Number(baseline.chipCount || 0);
      if (targetInRoleSlot || ((targetPresent || newIds.length > 0) && (countIncreased || chipIncreased || newIds.length > 0))) {
        return {
          ok: true,
          ingredientIds,
          newIds,
          confirmedImageId: ingredientIds.find((id) => idsMatch(id, targetImageId)) || newIds[0] || targetImageId || ""
        };
      }
      await sleep(180);
    }
    const ingredients = store.getState().ingredients || [];
    const ingredientIds = ingredients.map((ingredient) => String(ingredient?.imageId || "").trim()).filter(Boolean);
    return {
      ok: false,
      ingredientIds,
      newIds: ingredientIds.filter((id) => !beforeIds.has(id)),
      confirmedImageId: ""
    };
  }

  function clickableRowCandidates(row) {
    const candidates = [row, ...Array.from(row.querySelectorAll?.("button,[role='button'],[tabindex],img") || [])];
    return candidates
      .filter((element, index, all) => element && element.isConnected && all.indexOf(element) === index && visibleElement(element))
      .map((element) => {
        const role = String(element.getAttribute?.("role") || "").toLowerCase();
        let score = element === row ? 20 : 0;
        if (element.tagName === "BUTTON" || role === "button") score += 80;
        if (element.getAttribute?.("tabindex") != null) score += 20;
        if (element.tagName === "IMG") score += 10;
        return { element, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.element);
  }

  async function attachDomReferences(refDescriptors = [], task = {}) {
    const refs = Array.isArray(refDescriptors) ? refDescriptors : [];
    if (!refs.length) return { ok: true, attached: 0, attachedImageIds: [], serializedIds: [], steps: [] };
    const taskId = String(task.id || "");
    const mode = String(task.mode || "");
    const emitAttachStage = (stage, extra = {}) => {
      emit({
        type: "dom_submit_stage",
        taskId,
        mode,
        stage,
        transport: task.__debuggerTransport === true ? "chrome_debugger" : "dom",
        ...extra
      });
    };
    emitAttachStage("ref_attach_start", {
      refCount: refs.length,
      refSummary: refs.map((ref, index) => ({
        index,
        role: ref?.role || "",
        fileName: ref?.fileName || "",
        hasInlineData: Boolean(inlineImageUrlForRef(ref)),
        mediaId: ref?.mediaId || "",
        assetImageId: ref?.assetImageId || ""
      })).slice(0, 6)
    });
    const store = resolvePromptStore();
    if (!store) {
      emitAttachStage("ref_attach_no_store");
      return { ok: false, error: "PROMPT_STORE_NOT_FOUND", attached: 0, refs: refs.length, steps: [] };
    }

    const debuggerTransport = task.__debuggerTransport === true;
    if (["text-to-image", "image-to-video", "start-end-image-to-video", "ingredients-to-video"].includes(mode)) {
      clearAllIngredients(store);
      await sleep(180);
    }

    let root = null;

    const attachedImageIds = [];
    const requestSerializedIds = [];
    const rememberRequestSerializedId = (value = "") => {
      const id = frameIdTail(value) || String(value || "").replace(/^fe_id_/i, "").trim();
      if (id && !requestSerializedIds.includes(id)) requestSerializedIds.push(id);
    };
    const attachStartIds = (store.getState().ingredients || []).map((ingredient) => String(ingredient?.imageId || "").trim()).filter(Boolean);
    let attached = 0;
    const steps = [];
    const stepInfo = (step, ref, index, extra = {}) => ({
      step,
      index,
      role: ref?.role || "",
      fileName: ref?.fileName || "",
      mediaId: ref?.mediaId || "",
      hasDataUrl: Boolean(inlineImageUrlForRef(ref)),
      ...extra
    });

    const canBatchStoreReferenceRefs = !debuggerTransport && (mode === "ingredients-to-video" || mode === "text-to-image");
    if (canBatchStoreReferenceRefs) {
      const targets = refs.map((ref) => referenceStoreImageIdForRef(ref));
      if (targets.length === refs.length && targets.every(Boolean)) {
        const batchIngredientType = mode === "ingredients-to-video" ? "INGREDIENT" : "REFERENCE";
        const immediateOk = setReferenceIngredients(store, targets, batchIngredientType);
        const finalIngredients = (store.getState().ingredients || []).map((ingredient) => ({
          imageId: String(ingredient?.imageId || "").trim(),
          preferredIngredientType: String(ingredient?.preferredIngredientType || "").trim()
        })).filter((ingredient) => ingredient.imageId);
        const finalIds = finalIngredients.map((ingredient) => ingredient.imageId);
        const missing = targets.filter((targetId) => !finalIds.some((actualId) => idsMatch(actualId, targetId)));
        const batchOk = Boolean(immediateOk && !missing.length);
        const batchStep = {
          step: mode === "ingredients-to-video" ? "ingredients_batch_store_direct" : "image_refs_batch_store_direct",
          index: 0,
          role: mode === "ingredients-to-video" ? "ingredientsRefs" : "imagePromptRefs",
          fileName: refs.map((ref) => ref?.fileName || "").filter(Boolean).join(","),
          mediaId: refs.map((ref) => ref?.mediaId || "").filter(Boolean).join(","),
          hasDataUrl: refs.some((ref) => Boolean(inlineImageUrlForRef(ref))),
          ok: batchOk,
          ingredientType: batchIngredientType,
          targetImageIds: targets,
          finalIds,
          finalIngredients,
          missing
        };
        steps.push(batchStep);
        emitAttachStage("ref_attach_batch_store_direct", {
          ok: batchOk,
          immediate: true,
          refCount: refs.length,
          attached: finalIds.length,
          mediaIds: refs.map((ref) => ref?.mediaId || "").filter(Boolean),
          serializedIds: targets,
          ingredientType: batchIngredientType,
          finalIngredients,
          missing,
          step: batchStep.step
        });
        if (batchOk) {
          return {
            ok: true,
            attached: targets.length,
            refs: refs.length,
            attachedImageIds: targets,
            serializedIds: targets,
            immediateStoreAttach: true,
            steps
          };
        }
        if (debuggerTransport) {
          return {
            ok: false,
            error: "REF_ATTACH_NOT_PERSISTED",
            attached,
            refs: refs.length,
            attachedImageIds: [],
            serializedIds: targets,
            missing,
            steps
          };
        }
        clearAllIngredients(store);
        await sleep(120);
      }
    }

    const allowProjectCardPromptAttach = false;
    const canBatchUploadDebuggerReferenceRefs = allowProjectCardPromptAttach
      && debuggerTransport
      && (mode === "ingredients-to-video" || mode === "text-to-image")
      && refs.every((ref, index) => isReferenceLikeIngredientType(ingredientTypeForRef(ref, index)) && Boolean(inlineImageUrlForRef(ref)));
    if (canBatchUploadDebuggerReferenceRefs) {
      const batchIngredientType = mode === "ingredients-to-video" ? "INGREDIENT" : "REFERENCE";
      emitAttachStage("ref_attach_project_add_media_batch_start", {
        refCount: refs.length,
        ingredientType: batchIngredientType,
        fileNames: refs.map((ref) => safeUploadFileName(ref))
      });
      const batchUpload = await uploadReferencesViaProjectAddMediaBatch(refs, (stage, extra = {}) => {
        emitAttachStage(stage, { ingredientType: batchIngredientType, ...extra });
      });
      const uploadedOutcomes = Array.isArray(batchUpload.outcomes) ? batchUpload.outcomes : [];
      for (const outcome of uploadedOutcomes) {
        const ref = refs[Number(outcome?.index || 0)] || {};
        steps.push(stepInfo(outcome.step || "project_add_media_batch_upload", ref, Number(outcome?.index || 0), {
          ok: Boolean(outcome.ok),
          error: outcome.error || "",
          ingredientType: batchIngredientType,
          confirmedImageId: outcome.assetImageId || outcome.confirmedImageId || "",
          uploadedMediaId: outcome.mediaId || outcome.uploadedMediaId || "",
          source: outcome.source || "",
          batch: true
        }));
      }
      emitAttachStage("ref_attach_project_add_media_batch_upload_done", {
        ok: Boolean(batchUpload.ok),
        error: batchUpload.error || "",
        refCount: refs.length,
        uploaded: uploadedOutcomes.length,
        pending: batchUpload.pending || [],
        uploadedMediaIds: uploadedOutcomes.map((outcome) => outcome?.mediaId || outcome?.uploadedMediaId || "").filter(Boolean),
        assetImageIds: uploadedOutcomes.map((outcome) => outcome?.assetImageId || outcome?.confirmedImageId || "").filter(Boolean)
      });
      if (!batchUpload.ok || uploadedOutcomes.length !== refs.length) {
        return {
          ok: false,
          error: batchUpload.error || "PROJECT_UPLOAD_NOT_COMPLETE",
          attached,
          refs: refs.length,
          steps,
          batchUpload
        };
      }
      const uploadedImageIds = uploadedOutcomes
        .sort((a, b) => Number(a?.index || 0) - Number(b?.index || 0))
        .map((outcome) => outcome?.assetImageId || outcome?.confirmedImageId || (outcome?.mediaId ? `fe_id_${frameIdTail(outcome.mediaId) || outcome.mediaId}` : ""))
        .map((id) => String(id || "").trim())
        .filter(Boolean);
      emitAttachStage("ref_attach_project_add_media_batch_prompt_attach_start", {
        refCount: refs.length,
        uploadedMediaIds: uploadedOutcomes.map((outcome) => outcome?.mediaId || outcome?.uploadedMediaId || "").filter(Boolean),
        assetImageIds: uploadedImageIds,
        ingredientType: batchIngredientType
      });
      const uploadedRequestIds = uploadedOutcomes
        .sort((a, b) => Number(a?.index || 0) - Number(b?.index || 0))
        .map((outcome) => String(outcome?.mediaId || outcome?.uploadedMediaId || "").trim())
        .filter(Boolean);
      const directUploadedAttach = await setReferenceIngredientsWithRetry(store, uploadedImageIds, {
        ingredientType: batchIngredientType,
        timeoutMs: 2600,
        intervalMs: 180
      });
      emitAttachStage("ref_attach_project_add_media_batch_store_attach", {
        ok: Boolean(directUploadedAttach.ok),
        refCount: refs.length,
        attached: directUploadedAttach.finalIds?.length || 0,
        serializedIds: uploadedImageIds,
        requestSerializedIds: uploadedRequestIds,
        ingredientType: batchIngredientType,
        finalIngredients: directUploadedAttach.finalIngredients || [],
        missing: directUploadedAttach.missing || []
      });
      if (directUploadedAttach.ok) {
        return {
          ok: true,
          attached: uploadedImageIds.length,
          refs: refs.length,
          attachedImageIds: uploadedImageIds,
          serializedIds: uploadedImageIds,
          requestSerializedIds: uploadedRequestIds,
          projectBatchUpload: true,
          uploadedStoreAttach: true,
          steps
        };
      }
	      const sortedUploadedOutcomes = [...uploadedOutcomes].sort((a, b) => Number(a?.index || 0) - Number(b?.index || 0));
	      const promptAttachedIds = [];
	      const promptAttachedRequestIds = [];
	      let promptAttachError = "";
	      for (const outcome of sortedUploadedOutcomes) {
        const index = Number(outcome?.index || 0);
        const ref = refs[index] || {};
        const baseline = {
          ingredientCount: (store.getState().ingredients || []).length,
          chipCount: attachedChipCount(),
          ingredientIds: (store.getState().ingredients || []).map((ingredient) => String(ingredient?.imageId || "").trim()).filter(Boolean)
        };
        const fileName = outcome?.fileName || ref?.fileName || safeUploadFileName(ref);
        const cardAttach = await clickProjectCardAddToPrompt(
          fileName,
          store,
          baseline,
          batchIngredientType,
          (stage, extra = {}) => emitAttachStage(stage, {
            index,
            role: ref?.role || "",
            ingredientType: batchIngredientType,
            batch: true,
            ...extra
          })
        );
	        const confirmedImageId = String(cardAttach.confirmedImageId || outcome?.assetImageId || outcome?.confirmedImageId || uploadedImageIds[index] || "").trim();
	        const requestSerializedId = String(outcome?.mediaId || outcome?.uploadedMediaId || "").trim();
	        steps.push(stepInfo("project_add_media_batch_prompt_attach", ref, index, {
	          ok: Boolean(cardAttach.ok),
	          error: cardAttach.error || "",
	          ingredientType: batchIngredientType,
	          confirmedImageId,
	          uploadedMediaId: requestSerializedId,
	          fileName,
	          batch: true
	        }));
        emitAttachStage("ref_attach_project_add_media_batch_prompt_attach_one", {
          index,
          role: ref?.role || "",
          ok: Boolean(cardAttach.ok),
          error: cardAttach.error || "",
	          ingredientType: batchIngredientType,
	          fileName,
	          confirmedImageId,
	          uploadedMediaId: requestSerializedId
	        });
        if (!cardAttach.ok || !confirmedImageId) {
          promptAttachError = cardAttach.error || "REF_ATTACH_NOT_PERSISTED";
          break;
	        }
	        promptAttachedIds.push(confirmedImageId);
	        if (requestSerializedId) promptAttachedRequestIds.push(requestSerializedId);
	      }
      await dismissFloatingMenus();
      await closeAssetBrowser();
      await sleep(250);
      let finalIngredients = (store?.getState?.()?.ingredients || []).map((ingredient) => ({
        imageId: String(ingredient?.imageId || "").trim(),
        preferredIngredientType: String(ingredient?.preferredIngredientType || "").trim()
      })).filter((ingredient) => ingredient.imageId);
      if (batchIngredientType === "INGREDIENT" && promptAttachedIds.length) {
        const typeRepairOk = coerceReferenceIngredientType(store, promptAttachedIds, batchIngredientType);
        await sleep(160);
        finalIngredients = (store?.getState?.()?.ingredients || []).map((ingredient) => ({
          imageId: String(ingredient?.imageId || "").trim(),
          preferredIngredientType: String(ingredient?.preferredIngredientType || "").trim()
        })).filter((ingredient) => ingredient.imageId);
        emitAttachStage("ref_attach_project_add_media_batch_type_repair", {
          ok: Boolean(typeRepairOk),
          ingredientType: batchIngredientType,
          serializedIds: promptAttachedIds,
          finalIngredients
        });
      }
      const finalIds = finalIngredients.map((ingredient) => ingredient.imageId);
      const missing = promptAttachedIds.filter((targetId) => !finalIds.some((actualId) => idsMatch(actualId, targetId)));
      const wrongIngredientTypes = batchIngredientType === "INGREDIENT"
        ? promptAttachedIds.filter((targetId) => {
          const entry = finalIngredients.find((ingredient) => idsMatch(ingredient.imageId, targetId));
          return String(entry?.preferredIngredientType || "") !== "INGREDIENT";
        })
        : [];
      const promptAttachOk = !promptAttachError && promptAttachedIds.length === refs.length && !missing.length && !wrongIngredientTypes.length;
      emitAttachStage("ref_attach_project_add_media_batch_prompt_attach_done", {
        ok: promptAttachOk,
        error: promptAttachError || (wrongIngredientTypes.length ? "INGREDIENT_REF_TYPE_NOT_PERSISTED" : ""),
	        refCount: refs.length,
	        attached: promptAttachedIds.length,
	        serializedIds: promptAttachedIds,
	        requestSerializedIds: promptAttachedRequestIds,
	        ingredientType: batchIngredientType,
	        finalIngredients,
	        missing,
	        wrongIngredientTypes
      });
      if (promptAttachOk) {
        return {
          ok: true,
          attached: promptAttachedIds.length,
          refs: refs.length,
	          attachedImageIds: promptAttachedIds,
	          serializedIds: promptAttachedIds,
	          requestSerializedIds: promptAttachedRequestIds,
	          projectBatchUpload: true,
	          promptCardAttach: true,
	          steps
        };
      }
      return {
        ok: false,
        error: promptAttachError || (wrongIngredientTypes.length ? "INGREDIENT_REF_TYPE_NOT_PERSISTED" : "REF_ATTACH_NOT_PERSISTED"),
        attached: promptAttachedIds.length,
        refs: refs.length,
	        attachedImageIds: [],
	        serializedIds: promptAttachedIds.length ? promptAttachedIds : uploadedImageIds,
	        requestSerializedIds: promptAttachedRequestIds,
	        missing,
	        steps
      };
    }

    for (let index = 0; index < refs.length; index += 1) {
      let ref = refs[index];
      const ingredientType = ingredientTypeForRef(ref, index);
      let selectableAssetResolution = null;
      if (debuggerTransport && isReferenceLikeIngredientType(ingredientType) && (ref?.mediaId || ref?.assetImageId)) {
        selectableAssetResolution = await resolveSelectableAssetRefForPicker(ref, (stage, extra = {}) => {
          emitAttachStage(stage, { index, role: ref?.role || "", ingredientType, ...extra });
        }, { taskId, source: "debugger_reference_picker" });
        ref = selectableAssetResolution.ref || ref;
      }
      const idCandidates = frameStoreIdCandidates(ref);
      const targetImageId = idCandidates[0] || "";
      const requiresPickerAttach = isReferenceLikeIngredientType(ingredientType);
      const isFrameSlotRef = ingredientType === "FIRST_FRAME" || ingredientType === "LAST_FRAME";
      const hasInlineData = Boolean(inlineImageUrlForRef(ref));
      const baseline = {
        ingredientCount: (store.getState().ingredients || []).length,
        chipCount: attachedChipCount(),
        ingredientIds: (store.getState().ingredients || []).map((ingredient) => String(ingredient?.imageId || "").trim()).filter(Boolean)
      };
      emitAttachStage("ref_attach_ref_start", {
        index,
        role: ref?.role || "",
        ingredientType,
        requiresPickerAttach,
        isFrameSlotRef,
        hasInlineData,
        hasTargetImageId: Boolean(targetImageId),
        candidateIds: idCandidates,
        selectableAssetResolution: selectableAssetResolution
          ? {
              resolved: Boolean(selectableAssetResolution.resolved),
              reason: selectableAssetResolution.reason || "",
              projectMediaId: selectableAssetResolution.projectMediaId || "",
              originalIds: selectableAssetResolution.originalIds || [],
              resolvedIds: selectableAssetResolution.resolvedIds || []
            }
          : null
      });

      if (debuggerTransport && isReferenceLikeIngredientType(ingredientType) && hasInlineData && !allowProjectCardPromptAttach) {
        const uploadOutcome = await uploadFrameRefThroughDom(root, ref, store, baseline, ingredientType, (stage, extra = {}) => {
          emitAttachStage(stage, { index, role: ref?.role || "", ingredientType, ...extra });
        }, { taskId, source: "debugger_reference_asset_browser" });
        root = findAssetBrowserRoot() || root;
        const confirmedImageId = uploadOutcome.confirmedImageId
          || (uploadOutcome.uploadedMediaId ? `fe_id_${frameIdTail(uploadOutcome.uploadedMediaId) || uploadOutcome.uploadedMediaId}` : "");
        emitAttachStage("ref_attach_debugger_reference_asset_browser_done", {
          index,
          role: ref?.role || "",
          ingredientType,
          ok: Boolean(uploadOutcome.ok),
          error: uploadOutcome.error || "",
          confirmedImageId,
          uploadedMediaId: uploadOutcome.uploadedMediaId || "",
          source: uploadOutcome.source || ""
        });
        steps.push(stepInfo(uploadOutcome.step || "dom_reference_upload", ref, index, {
          ok: Boolean(uploadOutcome.ok),
          error: uploadOutcome.error || "",
          message: uploadOutcome.message || "",
          ingredientType,
          confirmedImageId,
          uploadedMediaId: uploadOutcome.uploadedMediaId || "",
          source: uploadOutcome.source || "debugger_reference_asset_browser"
        }));
        if (uploadOutcome.ok && confirmedImageId) {
          attached += 1;
          attachedImageIds.push(confirmedImageId);
          if (isReferenceLikeIngredientType(ingredientType)) rememberRequestSerializedId(uploadOutcome.uploadedMediaId || uploadOutcome.mediaId || confirmedImageId);
          continue;
        }
        return {
          ok: false,
          error: uploadOutcome.error || "DOM_REFERENCE_UPLOAD_NOT_CONFIRMED",
          attached,
          refs: refs.length,
          steps,
          ref
        };
      }

      if (debuggerTransport && isReferenceLikeIngredientType(ingredientType) && hasInlineData) {
        const uploadOutcome = await uploadReferenceViaProjectAddMedia(ref, (stage, extra = {}) => {
          emitAttachStage(stage, { index, role: ref?.role || "", ingredientType, ...extra });
        });
        const uploadedImageId = uploadOutcome.assetImageId
          || (uploadOutcome.mediaId ? `fe_id_${frameIdTail(uploadOutcome.mediaId) || uploadOutcome.mediaId}` : "");
        steps.push(stepInfo(uploadOutcome.step || "project_add_media_upload", ref, index, {
          ok: Boolean(uploadOutcome.ok),
          error: uploadOutcome.error || "",
          message: uploadOutcome.message || "",
          ingredientType,
          confirmedImageId: uploadedImageId,
          uploadedMediaId: uploadOutcome.mediaId || uploadOutcome.uploadedMediaId || "",
          source: uploadOutcome.source || ""
        }));
        if (!uploadOutcome.ok || !uploadedImageId) {
          return {
            ok: false,
            error: uploadOutcome.error || "PROJECT_UPLOAD_NOT_VISIBLE",
            attached,
            refs: refs.length,
            steps,
            ref
          };
        }

        const directConfirm = await clickProjectCardAddToPrompt(
          uploadOutcome.fileName || safeUploadFileName(ref),
          store,
          baseline,
          ingredientType,
          (stage, extra = {}) => emitAttachStage(stage, { index, role: ref?.role || "", ingredientType, ...extra })
        );
        emitAttachStage("ref_attach_project_add_media_store_direct", {
          index,
          role: ref?.role || "",
          ingredientType,
          ok: Boolean(directConfirm.ok),
          targetImageId: uploadedImageId,
          confirmedImageId: directConfirm.confirmedImageId || "",
          uploadedMediaId: uploadOutcome.mediaId || uploadOutcome.uploadedMediaId || ""
        });
        steps.push(stepInfo("project_add_media_store_direct", ref, index, {
          ok: Boolean(directConfirm.ok),
          ingredientType,
          targetImageId: uploadedImageId,
          confirmedImageId: directConfirm.confirmedImageId || uploadedImageId,
          uploadedMediaId: uploadOutcome.mediaId || uploadOutcome.uploadedMediaId || "",
          source: uploadOutcome.source || ""
        }));
        if (directConfirm.ok) {
          attached += 1;
          attachedImageIds.push(directConfirm.confirmedImageId || uploadedImageId);
          if (isReferenceLikeIngredientType(ingredientType)) rememberRequestSerializedId(uploadOutcome.mediaId || uploadOutcome.uploadedMediaId || uploadedImageId);
          continue;
        }
        return {
          ok: false,
          error: "REF_ATTACH_NOT_PERSISTED",
          attached,
          refs: refs.length,
          steps,
          ref
        };
      }

      if (!debuggerTransport && isReferenceLikeIngredientType(ingredientType) && idCandidates.length) {
        let directConfirm = { ok: false, confirmedImageId: "" };
        let usedTargetImageId = targetImageId;
        for (const candidateId of idCandidates) {
          const state = store.getState();
          const already = (state.ingredients || []).some((ingredient) => idsMatch(ingredient?.imageId, candidateId));
          if (!already) {
            await attachFrameImageId(store, candidateId, ingredientType);
          }
          directConfirm = (already || hasIngredientImageId(store, candidateId))
            ? { ok: true, confirmedImageId: candidateId }
            : await waitForAttachConfirmation(store, baseline, candidateId, 900, ingredientType);
          if (directConfirm.ok) {
            usedTargetImageId = directConfirm.confirmedImageId || candidateId;
            break;
          }
        }
        steps.push(stepInfo("reference_store_direct", ref, index, {
          ok: Boolean(directConfirm.ok),
          ingredientType,
          targetImageId: usedTargetImageId,
          candidateIds: idCandidates
        }));
        if (directConfirm.ok) {
          attached += 1;
          attachedImageIds.push(directConfirm.confirmedImageId || usedTargetImageId);
          if (isReferenceLikeIngredientType(ingredientType)) rememberRequestSerializedId(ref?.mediaId || ref?.assetImageId || directConfirm.confirmedImageId || usedTargetImageId);
          continue;
        }
      }

      if (hasInlineData && !(idCandidates.length && (ref?.mediaId || ref?.assetImageId))) {
        const uploadOutcome = await uploadFrameRefThroughDom(root, ref, store, baseline, ingredientType, (stage, extra = {}) => {
          emitAttachStage(stage, { index, role: ref?.role || "", ...extra });
        }, { taskId });
        root = findAssetBrowserRoot() || root;
        emitAttachStage(isReferenceLikeIngredientType(ingredientType) ? "ref_attach_dom_reference_upload_done" : "ref_attach_dom_frame_upload_done", {
          index,
          role: ref?.role || "",
          ok: Boolean(uploadOutcome.ok),
          error: uploadOutcome.error || "",
          confirmedImageId: uploadOutcome.confirmedImageId || "",
          uploadedMediaId: uploadOutcome.uploadedMediaId || "",
          source: uploadOutcome.source || ""
        });
        steps.push(stepInfo(uploadOutcome.step || "dom_frame_upload", ref, index, {
          ok: Boolean(uploadOutcome.ok),
          error: uploadOutcome.error || "",
          message: uploadOutcome.message || "",
          ingredientType,
          confirmedImageId: uploadOutcome.confirmedImageId || "",
          uploadedMediaId: uploadOutcome.uploadedMediaId || "",
          source: uploadOutcome.source || ""
        }));
        if (uploadOutcome.ok) {
          attached += 1;
          attachedImageIds.push(uploadOutcome.confirmedImageId || targetImageId || "");
          if (isReferenceLikeIngredientType(ingredientType)) rememberRequestSerializedId(uploadOutcome.uploadedMediaId || uploadOutcome.mediaId || uploadOutcome.confirmedImageId || targetImageId);
          continue;
        }
        return {
          ok: false,
          error: uploadOutcome.error || "DOM_FRAME_UPLOAD_NOT_CONFIRMED",
          attached,
          refs: refs.length,
          steps,
          ref
        };
      }

      if (idCandidates.length && !(debuggerTransport && isReferenceLikeIngredientType(ingredientType))) {
        if (debuggerTransport && isFrameSlotRef) {
          const pickerRef = {
            ...ref,
            mediaId: frameIdTail(ref.mediaId || targetImageId || ""),
            assetImageId: ref.assetImageId || (frameIdTail(targetImageId) ? `fe_id_${frameIdTail(targetImageId)}` : targetImageId)
          };
          const selected = await selectFrameSlotAssetRow(pickerRef, store, baseline, ingredientType, (stage, extra = {}) => {
            emitAttachStage(stage, { index, role: ref?.role || "", ...extra });
          }, { taskId, source: "debugger_existing_frame_asset_row" });
          steps.push(stepInfo(selected?.step || "frame_slot_asset_row_attach", ref, index, {
            ok: Boolean(selected?.ok),
            error: selected?.error || "",
            ingredientType,
            targetImageId,
            candidateIds: idCandidates,
            confirmedImageId: selected?.confirmedImageId || "",
            uploadedMediaId: selected?.uploadedMediaId || "",
            source: selected?.source || ""
          }));
          if (selected?.ok) {
            attached += 1;
            attachedImageIds.push(selected.confirmedImageId || targetImageId);
            continue;
          }
          return {
            ok: false,
            error: selected?.error || "ASSET_ROW_NOT_FOUND",
            attached,
            refs: refs.length,
            steps,
            ref
          };
        }
        let directConfirm = { ok: false, confirmedImageId: "" };
        let usedTargetImageId = targetImageId;
        for (const candidateId of idCandidates) {
          const state = store.getState();
          const already = (state.ingredients || []).some((ingredient) => idsMatch(ingredient?.imageId, candidateId));
          if (!already) {
            await attachFrameImageId(store, candidateId, ingredientType);
          }
          const directAttached = isReferenceLikeIngredientType(ingredientType)
            ? hasIngredientImageId(store, candidateId)
            : frameIdsMatch(roleImageId(store, ingredientType), candidateId);
          directConfirm = (already || directAttached)
            ? { ok: true, confirmedImageId: candidateId }
            : await waitForAttachConfirmation(store, baseline, candidateId, 900, ingredientType);
          if (directConfirm.ok) {
            usedTargetImageId = directConfirm.confirmedImageId || candidateId;
            break;
          }
        }
        steps.push(stepInfo("store_direct", ref, index, {
          ok: Boolean(directConfirm.ok),
          ingredientType,
          targetImageId: usedTargetImageId,
          candidateIds: idCandidates
        }));
        if (directConfirm.ok) {
          attached += 1;
          attachedImageIds.push(directConfirm.confirmedImageId || usedTargetImageId);
          if (isReferenceLikeIngredientType(ingredientType)) rememberRequestSerializedId(ref?.mediaId || ref?.assetImageId || directConfirm.confirmedImageId || usedTargetImageId);
          continue;
        }
      }

      if (debuggerTransport && isReferenceLikeIngredientType(ingredientType)) {
        steps.push(stepInfo("reference_asset_picker_disabled", ref, index, {
          ok: false,
          error: "REFERENCE_ASSET_PICKER_DISABLED",
          ingredientType,
          targetImageId,
          candidateIds: idCandidates
        }));
        return {
          ok: false,
          error: "REFERENCE_ASSET_PICKER_DISABLED",
          attached,
          refs: refs.length,
          steps,
          ref
        };
      }

      if (root && (!root.isConnected || !isAssetBrowserRoot(root))) {
        root = findAssetBrowserRoot() || null;
      }
      if (!root) {
        root = isFrameSlotRef
          ? await openAssetBrowserFromFrameSlot(ingredientType)
          : await openAssetBrowser();
        if (!root) {
          steps.push(stepInfo(isFrameSlotRef ? "frame_slot_asset_browser_open" : "asset_browser_open", ref, index, { ok: false, error: "ASSET_BROWSER_NOT_OPEN" }));
          return { ok: false, error: "ASSET_BROWSER_NOT_OPEN", attached, refs: refs.length, steps, ref };
        }
        await ensureAssetImageTab(root);
        root = findAssetBrowserRoot() || root;
      }

      const searchInput = findAssetSearchInput(root);
      let row = null;
      const strictAssetRowMatch = Boolean(ref.mediaId || ref.assetImageId);
      let lastRows = [];
      let lastTerm = "";
      const searchTerms = assetPickerSearchTermsForRef(ref, [ref.fileName, ref.title]);
      const initialRows = listAssetRows(root);
      lastRows = describeAssetRows(initialRows, 12);
      row = pickAssetRow(initialRows, ref, { strictIds: strictAssetRowMatch });
      for (const term of searchTerms) {
        if (row) break;
        lastTerm = term;
        if (searchInput) {
          setInputValue(searchInput, term);
          await sleep(350);
        }
        for (let poll = 0; poll < 8 && !row; poll += 1) {
          root = findAssetBrowserRoot() || root;
          const rows = listAssetRows(root);
          lastRows = describeAssetRows(rows, 12);
          row = pickAssetRow(rows, ref, { strictIds: strictAssetRowMatch });
          if (!row) await sleep(220);
        }
        if (row) break;
      }
      if (!row) {
        if (searchInput) {
          setInputValue(searchInput, "");
          await sleep(150);
        }
        for (let poll = 0; poll < 5 && !row; poll += 1) {
          root = findAssetBrowserRoot() || root;
          const rows = listAssetRows(root);
          lastRows = describeAssetRows(rows, 12);
          row = pickAssetRow(rows, ref, { strictIds: strictAssetRowMatch });
          if (!row) await sleep(220);
        }
      }
      if (!row) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        steps.push(stepInfo("asset_row_search", ref, index, {
          ok: false,
          error: "ASSET_ROW_NOT_FOUND",
          searchTerms,
          lastTerm,
          rowCount: lastRows.length,
          rowSample: lastRows,
          strictAssetRowMatch,
          targetImageId,
          candidateIds: idCandidates
        }));
        emitAttachStage("asset_row_search_failed", {
          index,
          role: ref?.role || "",
          ingredientType,
          ok: false,
          error: "ASSET_ROW_NOT_FOUND",
          searchTerms,
          lastTerm,
          rowCount: lastRows.length,
          rowSample: lastRows,
          strictAssetRowMatch,
          targetImageId,
          candidateIds: idCandidates
        });
        return { ok: false, error: "ASSET_ROW_NOT_FOUND", attached, refs: refs.length, ref, steps };
      }

      const rowIds = [...assetIdsFromRow(row)];
      const rowImageId = rowIds.find((id) => idsMatch(id, targetImageId)) || rowIds.find((id) => /^fe_id_/i.test(id)) || targetImageId || rowIds[0] || "";
      let confirmed = null;
        for (const candidate of clickableRowCandidates(row)) {
          const reactClicked = invokeReactClick(candidate) || invokeReactClick(row);
          if (!reactClicked) pointerClick(candidate);
          try {
            candidate.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            candidate.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
        } catch {}
        confirmed = await waitForAttachConfirmation(store, baseline, rowImageId, 2400, ingredientType);
        if (confirmed.ok) break;
      }

      if (!confirmed?.ok && rowImageId && !requiresPickerAttach) {
        const state = store.getState();
        const ingredient = buildIngredient(rowImageId, ingredientType);
        try {
          state.actions?.addIngredient?.(ingredient);
          if ((store.getState().ingredients || []).length <= baseline.ingredientCount && typeof store.setState === "function") {
            store.setState({ ingredients: [...(store.getState().ingredients || []), ingredient] });
          }
        } catch {}
        confirmed = await waitForAttachConfirmation(store, baseline, rowImageId, 1400, ingredientType);
      }

      if (!confirmed?.ok) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        const error = requiresPickerAttach ? "REF_ATTACH_NOT_PERSISTED" : "INGREDIENT_ATTACH_FAILED";
        steps.push(stepInfo("asset_row_attach", ref, index, {
          ok: false,
          error,
          ingredientType,
          rowImageId
        }));
        return {
          ok: false,
          error,
          attached,
          refs: refs.length,
          ref,
          steps
        };
      }

      attached += 1;
      attachedImageIds.push(confirmed.confirmedImageId || rowImageId || targetImageId);
      if (isReferenceLikeIngredientType(ingredientType)) rememberRequestSerializedId(ref?.mediaId || ref?.assetImageId || confirmed.confirmedImageId || rowImageId || targetImageId);
      steps.push(stepInfo("asset_row_attach", ref, index, {
        ok: true,
        ingredientType,
        rowImageId,
        confirmedImageId: confirmed.confirmedImageId || rowImageId || targetImageId
      }));
      root = findAssetBrowserRoot() || null;
      if (searchInput) {
        setInputValue(searchInput, "");
        await sleep(120);
      }
    }

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(250);

    let finalIngredients = ingredientStateEntries(store);
    if (mode === "ingredients-to-video") {
      const settleUntil = Date.now() + 4200;
      let settledIds = settledIngredientRefIds(finalIngredients);
      while (settledIds.length < refs.length && Date.now() < settleUntil) {
        await sleep(180);
        finalIngredients = ingredientStateEntries(store);
        settledIds = settledIngredientRefIds(finalIngredients);
      }
      emitAttachStage("ref_attach_ingredients_settle", {
        ok: settledIds.length >= refs.length,
        refCount: refs.length,
        settledIds,
        finalIngredients
      });
    } else if (mode === "text-to-image") {
      const settleUntil = Date.now() + 8000;
      let settledIds = settledReferenceRefIds(finalIngredients);
      while (settledIds.length < refs.length && Date.now() < settleUntil) {
        await sleep(180);
        finalIngredients = ingredientStateEntries(store);
        settledIds = settledReferenceRefIds(finalIngredients);
      }
      emitAttachStage("ref_attach_image_refs_settle", {
        ok: settledIds.length >= refs.length,
        refCount: refs.length,
        settledIds,
        finalIngredients
      });
    }
    const finalIds = finalIngredients.map((ingredient) => ingredient.imageId);
    const expectedIds = attachedImageIds.filter(Boolean);
    const missing = expectedIds.filter((expectedId) => !finalIds.some((actualId) => idsMatch(actualId, expectedId)));
    const fallbackNewIds = finalIds.filter((id) => !attachStartIds.some((beforeId) => idsMatch(beforeId, id)));
    if (mode === "ingredients-to-video") {
      if (attached < refs.length) {
        return {
          ok: false,
          error: "REF_ATTACH_NOT_PERSISTED",
          attached,
          refs: refs.length,
          finalIngredients,
          fallbackNewIds,
          steps
        };
      }
      const expectedSettledIngredientIds = settledIngredientRefIds(finalIngredients, expectedIds);
      const fallbackSettledIngredientIds = settledIngredientRefIds(finalIngredients, fallbackNewIds);
      const serializedIds = expectedSettledIngredientIds.length >= refs.length
        ? expectedSettledIngredientIds.slice(0, refs.length)
        : fallbackSettledIngredientIds.slice(0, refs.length);
      if (serializedIds.length < refs.length) {
        const wrongIngredientTypes = (expectedIds.length ? expectedIds : fallbackNewIds).filter((expectedId) => {
          const entry = finalIngredients.find((ingredient) => idsMatch(ingredient.imageId, expectedId));
          return String(entry?.preferredIngredientType || "") !== "INGREDIENT" || entry?.isLoading === true;
        });
        return {
          ok: false,
          error: "INGREDIENT_REF_TYPE_NOT_PERSISTED",
          attached,
          refs: refs.length,
          wrongIngredientTypes,
          finalIngredients,
          fallbackNewIds,
          steps
        };
      }
      return {
        ok: true,
        attached,
        refs: refs.length,
        attachedImageIds: expectedIds,
        serializedIds,
        requestSerializedIds,
        finalIngredients,
        fallbackNewIds,
        ingredientFallbackIds: expectedSettledIngredientIds.length >= refs.length ? [] : serializedIds,
        steps
      };
    }
    if (missing.length > 0 && fallbackNewIds.length < refs.length) {
      return {
        ok: false,
        error: "REF_ATTACH_NOT_PERSISTED",
        attached,
        refs: refs.length,
        missing,
        steps
      };
    }

    const serializedIds = (missing.length > 0 ? fallbackNewIds : expectedIds).filter(Boolean);
    if (mode === "text-to-image" && refs.length > 0) {
      const settledIds = settledReferenceRefIds(finalIngredients, serializedIds.length ? serializedIds : fallbackNewIds);
      if (settledIds.length < refs.length) {
        return {
          ok: false,
          error: "IMAGE_REF_NOT_SETTLED",
          attached,
          refs: refs.length,
          serializedIds,
          settledIds,
          finalIngredients,
          fallbackNewIds,
          steps
        };
      }
      return {
        ok: true,
        attached,
        refs: refs.length,
        attachedImageIds: expectedIds,
        serializedIds: settledIds.slice(0, refs.length),
        requestSerializedIds,
        finalIngredients,
        fallbackNewIds,
        steps
      };
    }
    return {
      ok: true,
      attached,
      refs: refs.length,
      attachedImageIds: expectedIds,
      serializedIds,
      requestSerializedIds,
      finalIngredients,
      steps
    };
	  }

  function ingredientStateEntries(store) {
    const state = store?.getState?.() || {};
    return (Array.isArray(state.ingredients) ? state.ingredients : []).map((ingredient) => ({
      imageId: String(ingredient?.imageId || ingredient?.mediaId || "").trim(),
      preferredIngredientType: String(ingredient?.preferredIngredientType || "").trim(),
      isLoading: Boolean(ingredient?.isLoading)
    })).filter((ingredient) => ingredient.imageId);
  }

  function settledIngredientRefIds(ingredients = [], ids = []) {
    const candidates = Array.isArray(ids) && ids.length
      ? ids
      : ingredients.map((ingredient) => ingredient?.imageId || "");
    return candidates.map((id) => String(id || "").trim()).filter((id) => {
      const entry = ingredients.find((ingredient) => idsMatch(ingredient?.imageId, id));
      return String(entry?.preferredIngredientType || "") === "INGREDIENT" && entry?.isLoading !== true;
    });
  }

  function settledReferenceRefIds(ingredients = [], ids = []) {
    const candidates = Array.isArray(ids) && ids.length
      ? ids
      : ingredients.map((ingredient) => ingredient?.imageId || "");
    return candidates.map((id) => String(id || "").trim()).filter((id) => {
      const entry = ingredients.find((ingredient) => idsMatch(ingredient?.imageId, id));
      return String(entry?.preferredIngredientType || "") === "REFERENCE" && entry?.isLoading !== true;
    });
  }

  function composerStateSnapshot(task = {}) {
    const store = resolvePromptStore();
    const state = store?.getState?.() || null;
    const editor = findPromptEditor();
    const editorText = String(editor?.innerText || editor?.value || editor?.textContent || "").trim();
    return {
      mode: String(task.mode || ""),
      storeMode: String(state?.mode || ""),
      aspectRatio: String(state?.aspectRatio || ""),
      outputsPerPrompt: state?.outputsPerPrompt ?? null,
      selectedVideoDuration: state?.selectedVideoDuration ?? null,
      currentModelKeys: state?.currentModelKeys || null,
      imageModelFamilyId: String(state?.imageModelFamilyId || ""),
      videoModelFamilyId: String(state?.videoModelFamilyId || ""),
      promptText: editorText || String(state?.inputs?.textEditor || "").trim(),
      ingredients: Array.isArray(state?.ingredients)
        ? state.ingredients.map((ingredient) => ({
          imageId: String(ingredient?.imageId || "").trim(),
          preferredIngredientType: String(ingredient?.preferredIngredientType || "").trim(),
          isLoading: Boolean(ingredient?.isLoading)
        })).filter((ingredient) => ingredient.imageId)
        : []
    };
  }

	  function verifyRefsBeforeSubmit(attachOutcome = null, task = {}) {
	    const composerSnapshot = composerStateSnapshot(task);
      const mode = String(task.mode || "");
      const expectedRefCount = Math.max(
        Number(attachOutcome?.refs || 0) || 0,
        Array.isArray(attachOutcome?.serializedIds) ? attachOutcome.serializedIds.length : 0
      );
	    if (!attachOutcome || !Array.isArray(attachOutcome.serializedIds) || !attachOutcome.serializedIds.length) {
        if (mode !== "ingredients-to-video" || expectedRefCount <= 0) return { ok: true, serializedIds: [], composerSnapshot };
	    }
	    const requestSerializedIds = Array.isArray(attachOutcome.requestSerializedIds)
	      ? attachOutcome.requestSerializedIds.map((id) => String(id || "").trim()).filter(Boolean)
	      : [];
	    const store = resolvePromptStore();
	    if (!store) return { ok: false, error: "PROMPT_STORE_NOT_FOUND", serializedIds: attachOutcome.serializedIds, requestSerializedIds, composerSnapshot };
	    const ingredients = ingredientStateEntries(store);
	    const ingredientIds = ingredients.map((ingredient) => String(ingredient?.imageId || "").trim()).filter(Boolean);
	    if (mode === "ingredients-to-video") {
        const attachedCount = Number(attachOutcome?.attached || 0) || 0;
        const serializedIds = Array.isArray(attachOutcome.serializedIds) ? attachOutcome.serializedIds : [];
        const matchedSerializedIds = settledIngredientRefIds(ingredients, serializedIds);
        const fallbackIngredientIds = settledIngredientRefIds(ingredients);
        const acceptedIds = matchedSerializedIds.length >= expectedRefCount
          ? matchedSerializedIds.slice(0, expectedRefCount)
          : fallbackIngredientIds.slice(0, expectedRefCount);
        if (attachedCount >= expectedRefCount && acceptedIds.length >= expectedRefCount) {
          return { ok: true, serializedIds: acceptedIds, requestSerializedIds, ingredientIds, composerSnapshot, ingredientFallbackIds: matchedSerializedIds.length >= expectedRefCount ? [] : acceptedIds };
        }
	      const wrongIngredientTypes = (serializedIds.length ? serializedIds : ingredientIds).filter((expectedId) => {
	        const entry = ingredients.find((ingredient) => idsMatch(ingredient?.imageId, expectedId));
	        return String(entry?.preferredIngredientType || "") !== "INGREDIENT" || entry?.isLoading === true;
	      });
	        return {
	          ok: false,
	          error: "INGREDIENT_REF_TYPE_NOT_PERSISTED",
	          wrongIngredientTypes,
	          serializedIds,
	          requestSerializedIds,
	          ingredientIds,
            expectedRefCount,
            attachedCount,
	          composerSnapshot
	        };
	    }
      if (mode === "text-to-image" && expectedRefCount > 0) {
        const serializedIds = Array.isArray(attachOutcome.serializedIds) ? attachOutcome.serializedIds : [];
        const settledIds = settledReferenceRefIds(ingredients, serializedIds);
        if (settledIds.length < expectedRefCount) {
          return {
            ok: false,
            error: "IMAGE_REF_NOT_SETTLED",
            serializedIds,
            requestSerializedIds,
            ingredientIds,
            settledIds,
            expectedRefCount,
            composerSnapshot
          };
        }
      }
	    const missing = attachOutcome.serializedIds.filter((expectedId) => !ingredientIds.some((actualId) => idsMatch(actualId, expectedId)));
	    if (missing.length) return { ok: false, error: "REF_ATTACH_NOT_PERSISTED", missing, serializedIds: attachOutcome.serializedIds, requestSerializedIds, ingredientIds, composerSnapshot };
	    return { ok: true, serializedIds: attachOutcome.serializedIds, requestSerializedIds, ingredientIds, composerSnapshot };
	  }

	  function taskMediaIds(task = {}) {
	    const ids = []
	      .concat(Array.isArray(task.mediaIds) ? task.mediaIds : [])
	      .concat(Array.isArray(task.refMediaIds) ? task.refMediaIds : [])
	      .concat(task.startMediaId ? [task.startMediaId] : [])
	      .concat(task.endMediaId ? [task.endMediaId] : []);
	    return [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
	  }

	  function domTaskRequiresAttach(task = {}) {
	    const mode = String(task.mode || "");
	    if (mode === "text-to-image") return taskRefDescriptors(task).length > 0 || taskMediaIds(task).length > 0;
	    return ["image-to-video", "start-end-image-to-video", "ingredients-to-video"].includes(mode)
        && (taskRefDescriptors(task).length > 0 || taskMediaIds(task).length > 0);
	  }

  function shouldPreMaterializeDebuggerFrameRef(ref = {}, ingredientType = "") {
    const isFrameSlotRef = ingredientType === "FIRST_FRAME" || ingredientType === "LAST_FRAME";
    if (!isFrameSlotRef) return false;
    if (!inlineImageUrlForRef(ref)) return false;
    return frameStoreIdCandidates(ref).length === 0;
  }

  function rememberDebuggerPreMaterializedFrameRef(taskId = "", ingredientType = "", step = {}) {
    const key = String(taskId || "").trim();
    if (!key || !["FIRST_FRAME", "LAST_FRAME"].includes(String(ingredientType || ""))) return;
    try {
      if (!window.__AF_DEBUGGER_PREMATERIALIZED_FRAME_REFS || typeof window.__AF_DEBUGGER_PREMATERIALIZED_FRAME_REFS !== "object") {
        window.__AF_DEBUGGER_PREMATERIALIZED_FRAME_REFS = {};
      }
      if (!window.__AF_DEBUGGER_PREMATERIALIZED_FRAME_REFS[key]) window.__AF_DEBUGGER_PREMATERIALIZED_FRAME_REFS[key] = {};
      window.__AF_DEBUGGER_PREMATERIALIZED_FRAME_REFS[key][ingredientType] = {
        at: Date.now(),
        ingredientType,
        mediaId: frameIdTail(step.mediaId || step.uploadedMediaId || step.confirmedImageId || step.assetImageId || ""),
        assetImageId: String(step.assetImageId || step.confirmedImageId || "").trim(),
        confirmedImageId: String(step.confirmedImageId || step.assetImageId || "").trim(),
        source: String(step.source || "")
      };
    } catch {}
  }

  function preMaterializedFrameAttachOutcome(task = {}, refs = []) {
    const taskId = String(task?.id || "").trim();
    const store = resolvePromptStore();
    const records = taskId && window.__AF_DEBUGGER_PREMATERIALIZED_FRAME_REFS
      ? window.__AF_DEBUGGER_PREMATERIALIZED_FRAME_REFS[taskId] || {}
      : {};
    if (!taskId || !store || !records || typeof records !== "object") return null;
    const serializedIds = [];
    const steps = [];
    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index];
      const ingredientType = ingredientTypeForRef(ref, index);
      if (!["FIRST_FRAME", "LAST_FRAME"].includes(ingredientType)) return null;
      const record = records[ingredientType] || {};
      const selectedRoleId = roleImageId(store, ingredientType);
      const expectedIds = [
        record.confirmedImageId,
        record.assetImageId,
        record.mediaId,
        ...frameStoreIdCandidates(ref)
      ].map((id) => String(id || "").trim()).filter(Boolean);
      const matched = Boolean(
        selectedRoleId
        && frameSlotLooksFilled(ingredientType)
        && expectedIds.some((id) => frameIdsMatch(selectedRoleId, id))
      );
      if (!matched) return null;
      serializedIds.push(selectedRoleId);
      steps.push({
        index,
        role: ref?.role || "",
        ingredientType,
        ok: true,
        source: "debugger_pre_materialized_frame_slot_already_selected",
        confirmedImageId: selectedRoleId,
        mediaId: frameIdTail(selectedRoleId)
      });
    }
    return {
      ok: true,
      attached: serializedIds.length,
      refs: refs.length,
      attachedImageIds: serializedIds,
      serializedIds,
      steps,
      source: "debugger_pre_materialized_frame_slot_already_selected"
    };
  }

  async function preMaterializeDebuggerFrameRefs(refs = [], task = {}, emitDomStage = null) {
    const taskId = String(task?.id || "");
    const mode = String(task?.mode || "");
    if (!["image-to-video", "start-end-image-to-video"].includes(mode)) {
      return { ok: true, skipped: true, reason: "mode_without_frame_slots", count: 0, assets: [] };
    }
    const emitStage = (stage, extra = {}) => {
      try {
        if (typeof emitDomStage === "function") emitDomStage(stage, extra);
      } catch {}
    };
    const assets = [];
    const steps = [];
    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index];
      const ingredientType = ingredientTypeForRef(ref, index);
      if (!shouldPreMaterializeDebuggerFrameRef(ref, ingredientType)) continue;
      const cacheKey = frameUploadCacheKey(taskId, ref, ingredientType);
      const contentCacheKey = frameUploadContentKey(ref, ingredientType);
      const cached = getFrameUploadCache(cacheKey) || getFrameUploadCache(contentCacheKey);
      if (cached) {
        const step = {
          index,
          role: ref?.role || "",
          ingredientType,
          fileName: safeUploadFileName(ref),
          ok: true,
          skipped: true,
          source: "pre_materialize_cache_hit",
          mediaId: cached
        };
        steps.push(step);
        assets.push(step);
        emitStage("debugger_pre_materialize_frame_ref_cached", step);
        continue;
      }

      emitStage("debugger_pre_materialize_frame_ref_start", {
        index,
        role: ref?.role || "",
        ingredientType,
        fileName: safeUploadFileName(ref)
      });
      let materialized = await uploadFreshFrameSlotThroughPicker(ref, resolvePromptStore(), ingredientType, (stage, extra = {}) => {
        emitStage(stage, {
          index,
          role: ref?.role || "",
          ingredientType,
          phase: "debugger_pre_materialize_fresh_frame_picker",
          ...extra
        });
      }, { task, taskId, source: "debugger_pre_materialize_fresh_frame_picker" });
      if (!materialized?.ok && String(materialized?.error || "") === "ASSET_BROWSER_NOT_OPEN") {
        emitStage("debugger_pre_materialize_frame_ref_composer_fallback", {
          index,
          role: ref?.role || "",
          ingredientType,
          fileName: safeUploadFileName(ref),
          reason: "frame_slot_asset_browser_unavailable"
        });
        materialized = await materializeRefInComposerAssetBrowser(ref, (stage, extra = {}) => {
          emitStage(stage, {
            index,
            role: ref?.role || "",
            ingredientType,
            phase: "debugger_pre_materialize_composer_fallback",
            ...extra
          });
        }, { taskId, source: "debugger_pre_materialize_composer_fallback" });
      }
      const confirmedImageId = String(materialized?.confirmedImageId || "").trim();
      const mediaId = frameIdTail(materialized?.mediaId || materialized?.uploadedMediaId || confirmedImageId || materialized?.assetImageId || "");
      const assetImageId = String(materialized?.assetImageId || confirmedImageId || (mediaId ? `fe_id_${mediaId}` : "")).trim();
      const step = {
        index,
        role: ref?.role || "",
        ingredientType,
        fileName: safeUploadFileName(ref),
        ok: Boolean(materialized?.ok && (mediaId || assetImageId)),
        error: materialized?.error || "",
        message: materialized?.message || "",
        mediaId,
        assetImageId,
        confirmedImageId,
        attached: materialized?.attached === true,
        source: materialized?.source || ""
      };
      steps.push(step);
      emitStage("debugger_pre_materialize_frame_ref_done", step);
      if (!step.ok) {
        return {
          ok: false,
          error: materialized?.error || "DOM_REF_MATERIALIZE_FAILED",
          message: materialized?.message || "",
          index,
          role: ref?.role || "",
          ingredientType,
          ref,
          steps,
          failClosed: true
        };
      }
      const cacheId = confirmedImageId || mediaId || assetImageId;
      setFrameUploadCache(cacheKey, cacheId, "debugger_pre_materialized_asset_row");
      setFrameUploadCache(contentCacheKey, cacheId, "debugger_pre_materialized_asset_row");
      rememberDebuggerPreMaterializedFrameRef(taskId, ingredientType, step);
      assets.push(step);
    }
    return { ok: true, count: assets.length, assets, steps };
  }

	  async function domSubmitTask(task = {}, meta = {}) {
	    const prompt = String(task.prompt || "").trim();
      const taskId = String(task.id || "");
      const mode = String(task.mode || "");
      const emitDomStage = (stage, extra = {}) => {
        const includeTrace = extra.trace === true || [
          "start",
          "mode",
          "settings",
          "prompt_commit",
          "prompt_recommit",
          "pre_click",
          "click",
          "capture_done"
        ].includes(stage);
        const cleanExtra = { ...extra };
        delete cleanExtra.trace;
        emit({
          type: "dom_submit_stage",
          taskId,
          mode,
          stage,
          ...cleanExtra,
          ...(includeTrace ? { domTrace: summarizeDomAutomationTrace(task) } : {})
        });
      };
	    if (!prompt) {
	      return { ok: false, action: "domSubmitTask", error: "DOM_PROMPT_EMPTY", failClosed: true };
	    }

      emitDomStage("start", { trace: true });
      const modeOutcome = await ensureDomTaskMode(task);
      emitDomStage("mode", { ok: Boolean(modeOutcome.ok), error: modeOutcome.error || "", modeOutcome, trace: true });
      if (!modeOutcome.ok) {
        return {
          ok: false,
          action: "domSubmitTask",
          error: modeOutcome.error || "DOM_MODE_SELECT_FAILED",
          mode: String(task.mode || ""),
          modeOutcome,
          failClosed: true
        };
      }

      const settingsOutcome = await applyDomTaskSettings(task);
      emitDomStage("settings", {
        ok: Boolean(settingsOutcome.ok),
        error: settingsOutcome.error || "",
        skipped: settingsOutcome.settingsSkipped === true,
        reason: settingsOutcome.reason || "",
        settingsOutcome,
        trace: true
      });
      if (!settingsOutcome.ok) {
        return {
          ok: false,
          action: "domSubmitTask",
          error: settingsOutcome.error || "DOM_SETTINGS_APPLY_FAILED",
          mode: String(task.mode || ""),
          modeOutcome,
          settingsOutcome,
          failClosed: true
        };
      }

	    const editor = findPromptEditor();
	    if (!editor) {
        emitDomStage("editor_missing");
	      return { ok: false, action: "domSubmitTask", error: "DOM_PROMPT_EDITOR_NOT_FOUND", failClosed: true };
	    }

	    const commit = await setPromptEditorText(editor, prompt);
      emitDomStage("prompt_commit", {
        ok: Boolean(commit.ok),
        persisted: commit.persisted || "",
        requestedPrompt: prompt.slice(0, 260),
        trace: true
      });
	    if (!commit.ok) {
	      return {
	        ok: false,
	        action: "domSubmitTask",
	        error: "DOM_PROMPT_NOT_PERSISTED",
	        persisted: commit.persisted,
	        failClosed: true
	      };
	    }

      let attachOutcome = { ok: true, attached: 0, attachedImageIds: [], serializedIds: [] };
	    if (domTaskRequiresAttach(task)) {
        const refs = taskRefDescriptors(task);
        emitDomStage("attach_start", { refCount: refs.length, mediaIds: taskMediaIds(task) });
        attachOutcome = await attachDomReferences(refs, task);
        emitDomStage("attach_done", {
          ok: Boolean(attachOutcome.ok),
          error: attachOutcome.error || "",
          attached: attachOutcome.attached || 0,
          serializedIds: Array.isArray(attachOutcome.serializedIds) ? attachOutcome.serializedIds : []
        });
        if (!attachOutcome.ok) {
          return {
            ok: false,
            action: "domSubmitTask",
            error: attachOutcome.error || "REF_ATTACH_NOT_PERSISTED",
            mode: String(task.mode || ""),
            mediaIds: taskMediaIds(task),
            attachOutcome,
            failClosed: true
          };
        }

        const recommit = await setPromptEditorText(editor, prompt);
        emitDomStage("prompt_recommit", {
          ok: Boolean(recommit.ok),
          persisted: recommit.persisted || "",
          requestedPrompt: prompt.slice(0, 260),
          trace: true
        });
      if (!recommit.ok) {
        return {
            ok: false,
            action: "domSubmitTask",
            error: "DOM_PROMPT_NOT_PERSISTED_AFTER_ATTACH",
            persisted: recommit.persisted,
            attachOutcome,
            failClosed: true
          };
        }

        const preSubmitRefs = verifyRefsBeforeSubmit(attachOutcome, task);
        emitDomStage("pre_submit_refs", {
          ok: Boolean(preSubmitRefs.ok),
          error: preSubmitRefs.error || "",
          serializedIds: Array.isArray(preSubmitRefs.serializedIds) ? preSubmitRefs.serializedIds : [],
          ingredientIds: Array.isArray(preSubmitRefs.ingredientIds) ? preSubmitRefs.ingredientIds : [],
          composerSnapshot: preSubmitRefs.composerSnapshot || null
        });
        if (!preSubmitRefs.ok) {
          return {
            ok: false,
            action: "domSubmitTask",
            error: preSubmitRefs.error || "REF_ATTACH_NOT_PERSISTED",
            attachOutcome,
            preSubmitRefs,
            failClosed: true
          };
        }
        attachOutcome = { ...attachOutcome, preSubmitRefs };
	    } else {
        const staleClear = await clearStaleIngredientsForNoRefTask(task, emitDomStage, "dom_submit_no_ref_pre_click");
        if (!staleClear.ok) {
          return {
            ok: false,
            action: "domSubmitTask",
            error: "DOM_NO_REF_STALE_INGREDIENTS_NOT_CLEARED",
            staleClear,
            failClosed: true
          };
        }
      }

	    const capture = createDomSubmitCapture(
        Number(meta.noRequestTimeoutMs || meta.timeoutMs || domSubmitNoRequestTimeoutMs(task)),
        attachOutcome.serializedIds || [],
        String(task.mode || ""),
        audioFailurePreferenceForTask(task),
        domSubmitExpectedMediaCount(task),
        Number(meta.responseTimeoutMs || domSubmitRequestTimeoutMs(task))
      );
      // Wait for Flow's React onChange to finish processing the prompt-commit
      // and enable the submit button. Trigger evidence: report 174542Z showed
      // only 37ms between prompt_commit and click — too tight for Flow's
      // submit-enable logic to run. Without this wait the click can land on
      // a still-disabled button (matchedCount:1, aria-disabled false at the
      // moment we read it but Flow's React still processing the state
      // change), no submit fetch fires, capture_done times out at ~46s with
      // DOM_SUBMIT_REQUEST_NOT_OBSERVED. 350ms gives Flow a render cycle.
      await sleep(350);
      emitDomStage("pre_click", { trace: true });
	    const click = await clickDomAction("composer", "create");
      emitDomStage("click", {
        ok: Boolean(click.ok),
        error: click.error || "",
        selector: click.selector || "",
        strategy: click.strategy || "",
        matchedCount: click.matchedCount || 0,
        trace: true
      });
	    if (!click.ok) {
	      capture.cancel();
	      return {
	        ok: false,
	        action: "domSubmitTask",
	        error: click.error || "DOM_CREATE_CLICK_FAILED",
	        click,
	        failClosed: true
	      };
	    }

	    const result = mode === "text-to-image"
        ? await Promise.race([
            capture.promise,
            sleep(2500).then(() => {
              capture.cancel();
              return {
                ok: true,
                status: 202,
                statusText: "DOM_SUBMIT_CLICK_ACCEPTED",
                mediaIds: [],
                expectedMediaIdCount: domSubmitExpectedMediaCount(task),
                capturedResponseCount: 0,
                pendingDomScan: true,
                responses: []
              };
            })
          ])
        : await capture.promise;
      emitDomStage("capture_done", {
        ok: Boolean(result.ok),
        error: result.error || "",
        mediaIds: Array.isArray(result.mediaIds) ? result.mediaIds : [],
        capturedResponseCount: result.capturedResponseCount || 0,
        pendingDomScan: Boolean(result.pendingDomScan),
        trace: true
      });
	    return {
	      action: "domSubmitTask",
	      promptCommitted: true,
        modeOutcome,
        settingsOutcome,
        attachOutcome,
	      click,
	      ...result
	    };
	  }

  async function domPrepareTaskForDebugger(task = {}, meta = {}) {
    const prompt = String(task.prompt || "").trim();
    const taskId = String(task.id || "");
    const mode = String(task.mode || "");
    const emitDomStage = (stage, extra = {}) => {
      emit({
        type: "dom_submit_stage",
        taskId,
        mode,
        stage,
        transport: "chrome_debugger",
        ...extra,
        domTrace: summarizeDomAutomationTrace(task)
      });
    };
    if (!prompt) return { ok: false, action: "domPrepareTaskForDebugger", error: "DOM_PROMPT_EMPTY", failClosed: true };

    emitDomStage("debugger_prepare_start");
    if (meta.debuggerTransport === true && meta.afterDebuggerSettings === true && (mode === "ingredients-to-video" || mode === "text-to-image")) {
      const settingsSync = await domSyncTaskSettingsForDebugger(task, {
        reason: mode === "ingredients-to-video" ? "ingredients_before_composer_ready" : "image_before_composer_ready",
        validateOnly: true
      });
      emitDomStage("debugger_settings_state_validate_before_ready", {
        ok: Boolean(settingsSync?.ok),
        error: settingsSync?.error || "",
        reason: settingsSync?.reason || "",
        validateOnly: true,
        validation: settingsSync?.validation || null,
        storeSync: settingsSync?.storeSync || null
      });
      if (!settingsSync?.ok) {
        return {
          ok: false,
          action: "domPrepareTaskForDebugger",
          error: settingsSync?.error || "DOM_DEBUGGER_SETTINGS_STATE_INVALID",
          settingsSync,
          failClosed: true
        };
      }
    }
    const ready = await waitForComposerReadyForDebugger(task, {
      timeoutMs: meta.afterDebuggerSettings || meta.afterPromptInsert ? 2500 : 7000,
      intervalMs: 180
    });
    emitDomStage("debugger_composer_ready", {
      ok: Boolean(ready.ok),
      error: ready.error || "",
      stableCount: ready.stableCount || 0,
      problems: ready.snapshot?.problems || [],
      snapshot: ready.snapshot || null
    });
    if (!ready.ok) {
      return {
        ok: false,
        action: "domPrepareTaskForDebugger",
        error: ready.error || "COMPOSER_NOT_READY",
        ready,
        failClosed: true
      };
    }
    // The debugger submit path must be locate-only here. CDP owns the user-like
    // interaction; page-script selector mutation before CDP has poisoned Flow.
    const skipMutation = true;
    const modeOutcome = skipMutation
      ? { ok: true, skipped: true, reason: "debugger_transport_locate_only" }
      : await ensureDomTaskMode(task);
    emitDomStage("debugger_mode", { ok: Boolean(modeOutcome.ok), error: modeOutcome.error || "", modeOutcome });
    if (!modeOutcome.ok) {
      return {
        ok: false,
        action: "domPrepareTaskForDebugger",
        error: modeOutcome.error || "DOM_MODE_APPLY_FAILED",
        modeOutcome,
        failClosed: true
      };
    }

    const settingsOutcome = skipMutation
      ? { ok: true, skipped: true, reason: "debugger_transport_locate_only" }
      : await applyDomTaskSettings(task);
    emitDomStage("debugger_settings", {
      ok: Boolean(settingsOutcome.ok),
      error: settingsOutcome.error || "",
      reason: settingsOutcome.reason || "",
      settingsOutcome
    });
    if (!settingsOutcome.ok) {
      return {
        ok: false,
        action: "domPrepareTaskForDebugger",
        error: settingsOutcome.error || "DOM_SETTINGS_APPLY_FAILED",
        modeOutcome,
        settingsOutcome,
        failClosed: true
      };
    }
    if (meta.debuggerTransport === true && meta.afterDebuggerSettings === true && (mode === "ingredients-to-video" || mode === "text-to-image")) {
      const settingsSync = await domSyncTaskSettingsForDebugger(task, {
        reason: mode === "ingredients-to-video" ? "ingredients_after_visible_settings" : "image_after_visible_settings",
        validateOnly: true
      });
      emitDomStage("debugger_settings_state_validate_after_visible", {
        ok: Boolean(settingsSync?.ok),
        error: settingsSync?.error || "",
        reason: settingsSync?.reason || "",
        validateOnly: true,
        validation: settingsSync?.validation || null,
        storeSync: settingsSync?.storeSync || null
      });
      if (!settingsSync?.ok) {
        return {
          ok: false,
          action: "domPrepareTaskForDebugger",
          error: settingsSync?.error || "DOM_DEBUGGER_SETTINGS_STATE_INVALID",
          settingsSync,
          failClosed: true
        };
      }
    }

    let attachOutcome = { ok: true, attached: 0, attachedImageIds: [], serializedIds: [] };
    const shouldAttachAfterPromptInsert = meta.debuggerTransport === true
      && meta.afterPromptInsert === true
      && (mode === "ingredients-to-video" || mode === "text-to-image");
    const shouldAttachForDebugger = meta.debuggerTransport === true
      ? (meta.afterDebuggerSettings === true || shouldAttachAfterPromptInsert) && meta.skipDebuggerAttach !== true
      : true;
    const attachRequired = domTaskRequiresAttach(task);
    const refs = attachRequired ? taskRefDescriptors(task) : [];
    emitDomStage("debugger_attach_gate", {
      attachRequired,
      shouldAttachForDebugger,
      refCount: refs.length,
      mediaIds: taskMediaIds(task),
      afterDebuggerSettings: meta.afterDebuggerSettings === true,
      afterPromptInsert: meta.afterPromptInsert === true,
      shouldAttachAfterPromptInsert
    });
    const shouldPreMaterializeFrameRefs = attachRequired
      && meta.debuggerTransport === true
      && meta.afterDebuggerSettings !== true
      && meta.afterPromptInsert !== true
      && refs.some((ref, index) => shouldPreMaterializeDebuggerFrameRef(ref, ingredientTypeForRef(ref, index)));
    if (shouldPreMaterializeFrameRefs) {
      emitDomStage("debugger_pre_materialize_frame_refs_start", {
        refCount: refs.length,
        reason: "materialize_before_frame_mode_settings"
      });
      const preMaterialize = await preMaterializeDebuggerFrameRefs(refs, task, emitDomStage);
      emitDomStage("debugger_pre_materialize_frame_refs_done", {
        ok: Boolean(preMaterialize.ok),
        error: preMaterialize.error || "",
        count: preMaterialize.count || 0,
        steps: Array.isArray(preMaterialize.steps) ? preMaterialize.steps : []
      });
      if (!preMaterialize.ok) {
        return {
          ok: false,
          action: "domPrepareTaskForDebugger",
          error: preMaterialize.error || "DOM_REF_MATERIALIZE_FAILED",
          preMaterialize,
          failClosed: true
        };
      }
    }
    if (attachRequired && shouldAttachForDebugger) {
      const preselectedFrameOutcome = preMaterializedFrameAttachOutcome(task, refs);
      if (preselectedFrameOutcome?.ok) {
        attachOutcome = preselectedFrameOutcome;
        emitDomStage("debugger_attach_pre_materialized_reused", {
          ok: true,
          refCount: refs.length,
          attached: attachOutcome.attached || 0,
          serializedIds: attachOutcome.serializedIds || [],
          reason: "frame_slot_already_selected_by_pre_materialize"
        });
      } else {
        // Project-grid uploads prove media reached Flow, but they do not prove
        // refs are attached to the front composer. Keep debugger refs on the
        // composer asset-picker path so submit is gated on prompt-store refs.
        const allowProjectCardPromptAttach = false;
        emitDomStage("debugger_attach_start", { refCount: refs.length, mediaIds: taskMediaIds(task), allowProjectCardPromptAttach });
        try {
          attachOutcome = await attachDomReferences(refs, {
            ...task,
            __debuggerTransport: true,
            __allowProjectCardPromptAttach: allowProjectCardPromptAttach
          });
        } catch (error) {
          attachOutcome = {
            ok: false,
            error: "DOM_REF_ATTACH_EXCEPTION",
            message: String(error?.message || error || ""),
            attached: 0,
            refs: refs.length,
            steps: []
          };
        }
        emitDomStage("debugger_attach_done", {
          ok: Boolean(attachOutcome.ok),
          error: attachOutcome.error || "",
          attached: attachOutcome.attached || 0,
          steps: Array.isArray(attachOutcome.steps) ? attachOutcome.steps : [],
          serializedIds: Array.isArray(attachOutcome.serializedIds) ? attachOutcome.serializedIds : []
        });
      }
      if (!attachOutcome.ok) {
        const attachError = ["image-to-video", "start-end-image-to-video"].includes(mode)
          && String(attachOutcome.error || "").toUpperCase() === "REF_ATTACH_NOT_PERSISTED"
          ? "DOM_FRAME_REF_ATTACH_NOT_PERSISTED"
          : (attachOutcome.error || "REF_ATTACH_NOT_PERSISTED");
        return {
          ok: false,
          action: "domPrepareTaskForDebugger",
          error: attachError,
          attachOutcome,
          failClosed: true
        };
      }
      const preSubmitRefs = verifyRefsBeforeSubmit(attachOutcome, task);
      emitDomStage("debugger_pre_submit_refs", {
        ok: Boolean(preSubmitRefs.ok),
        error: preSubmitRefs.error || "",
        serializedIds: preSubmitRefs.serializedIds || [],
        ingredientIds: Array.isArray(preSubmitRefs.ingredientIds) ? preSubmitRefs.ingredientIds : [],
        composerSnapshot: preSubmitRefs.composerSnapshot || null
      });
      if (!preSubmitRefs.ok) {
        const preSubmitError = ["image-to-video", "start-end-image-to-video"].includes(mode)
          && String(preSubmitRefs.error || "").toUpperCase() === "REF_ATTACH_NOT_PERSISTED"
          ? "DOM_FRAME_REF_ATTACH_NOT_PERSISTED"
          : (preSubmitRefs.error || "REF_ATTACH_NOT_PERSISTED");
        return {
          ok: false,
          action: "domPrepareTaskForDebugger",
          error: preSubmitError,
          attachOutcome,
          preSubmitRefs,
          failClosed: true
        };
      }
      attachOutcome = { ...attachOutcome, preSubmitRefs };
    } else if (attachRequired) {
      const afterPromptInsert = meta.afterPromptInsert === true;
      emitDomStage(afterPromptInsert ? "debugger_attach_skipped_after_prompt_insert" : "debugger_attach_deferred", {
        reason: afterPromptInsert ? "refs_already_attached_before_prompt_insert" : "wait_until_after_debugger_settings",
        refCount: refs.length,
        mediaIds: taskMediaIds(task)
      });
    }

    const shouldSettleUploadedRefs = attachRequired && meta.skipPostUploadSettle !== true && (
      shouldAttachForDebugger
      || meta.afterSettingsStateRepair === true
      || meta.afterPromptInsert === true
    );
    if (shouldSettleUploadedRefs) {
      const shouldCheckSettings = (meta.afterSettingsStateRepair === true || meta.afterPromptInsert === true)
        && meta.skipSettingsSettle !== true;
      const settle = await waitForComposerPostUploadSettle(task, {
        expectPrompt: meta.afterPromptInsert === true,
        checkSettings: shouldCheckSettings,
        timeoutMs: meta.afterPromptInsert === true ? 10000 : 9000,
        intervalMs: 240,
        stableNeeded: meta.afterPromptInsert === true ? 3 : 2
      });
      emitDomStage("debugger_post_upload_settle", {
        ok: Boolean(settle.ok),
        error: settle.error || "",
        stableCount: settle.stableCount || 0,
        problems: settle.snapshot?.problems || [],
        expectPrompt: meta.afterPromptInsert === true,
        checkSettings: shouldCheckSettings,
        refSettle: settle.snapshot?.refSettle || null
      });
      if (!settle.ok) {
        return {
          ok: false,
          action: "domPrepareTaskForDebugger",
          error: settle.error || "COMPOSER_UPLOAD_NOT_SETTLED",
          settle,
          failClosed: true
        };
      }
    }

    if (!attachRequired) {
      const staleClear = await clearStaleIngredientsForNoRefTask(task, emitDomStage, "debugger_no_ref_pre_ready");
      if (!staleClear.ok) {
        return {
          ok: false,
          action: "domPrepareTaskForDebugger",
          error: "DOM_NO_REF_STALE_INGREDIENTS_NOT_CLEARED",
          staleClear,
          failClosed: true
        };
      }
    }

    const editor = findPromptEditor();
    const create = resolveComposerCreateElement() || resolveDomActionElement("composer", "create");
    if (!editor) return { ok: false, action: "domPrepareTaskForDebugger", error: "DOM_PROMPT_EDITOR_NOT_FOUND", failClosed: true };
    if (!create?.element) return { ok: false, action: "domPrepareTaskForDebugger", error: "DOM_CREATE_BUTTON_NOT_FOUND", failClosed: true };
    const editorRect = domRectSummary(editor);
    const createRect = domRectSummary(create.element);
    const domTrace = summarizeDomAutomationTrace(task);
    emitDomStage("debugger_ready", {
      ok: true,
      selector: create.selector || "",
      strategy: create.strategy || "",
      editorRect,
      createRect,
      domTrace
    });
    return {
      ok: true,
      action: "domPrepareTaskForDebugger",
      status: 200,
      statusText: "DOM_DEBUGGER_READY",
      href: location.href,
      projectId: projectIdFromUrl(),
      prompt,
      editorRect,
      createRect,
      selector: create.selector || "",
      strategy: create.strategy || "",
      attachOutcome,
      expected: domTrace.expected || null,
      visible: domTrace.visible || null,
      store: domTrace.store || null,
      createButton: domTrace.createButton || null
    };
  }

  async function domCommitPromptForDebugger(task = {}) {
    const prompt = String(task.prompt || "").trim();
    if (!prompt) return { ok: false, action: "domCommitPromptForDebugger", error: "DOM_PROMPT_EMPTY" };
    const editor = findPromptEditor();
    if (!editor) return { ok: false, action: "domCommitPromptForDebugger", error: "DOM_PROMPT_EDITOR_NOT_FOUND" };
    const commit = await setPromptEditorText(editor, prompt);
    const create = resolveComposerCreateElement(editor) || resolveDomActionElement("composer", "create");
    const domTrace = summarizeDomAutomationTrace(task);
    return {
      ok: Boolean(commit.ok),
      action: "domCommitPromptForDebugger",
      error: commit.ok ? "" : "DOM_PROMPT_NOT_PERSISTED",
      commit,
      prompt,
      editorRect: domRectSummary(editor),
      createRect: domRectSummary(create?.element || null),
      selector: create?.selector || "",
      strategy: create?.strategy || "",
      expected: domTrace.expected || null,
      visible: domTrace.visible || null,
      store: domTrace.store || null,
      createButton: domTrace.createButton || null
    };
  }

  async function domClearPromptAfterDebuggerSubmit(task = {}) {
    const editor = findPromptEditor();
    if (!editor) return { ok: false, action: "domClearPromptAfterDebuggerSubmit", error: "DOM_PROMPT_EDITOR_NOT_FOUND" };
    const before = editorText(editor);
    const clear = await setPromptEditorText(editor, "");
    await sleep(120);
    const frameSlotClears = [];
    if (["image-to-video", "start-end-image-to-video"].includes(String(task.mode || ""))) {
      const store = resolvePromptStore();
      if (store) {
        for (const ingredientType of ["FIRST_FRAME", "LAST_FRAME"]) {
          const result = await clearFrameSlotForReplacement(store, ingredientType, null, {
            reason: "debugger_submit_confirmed_clear_composer"
          });
          frameSlotClears.push({ ingredientType, ...result });
        }
      }
    }
    const after = editorText(editor);
    const storeAfter = promptStoreText();
    return {
      ok: Boolean(clear.ok || (!compactPromptForCompare(after) && !compactPromptForCompare(storeAfter))),
      action: "domClearPromptAfterDebuggerSubmit",
      error: "",
      before: compactPromptForCompare(before).slice(0, 260),
      after: compactPromptForCompare(after).slice(0, 260),
      storeAfter: compactPromptForCompare(storeAfter).slice(0, 260),
      frameSlotClears,
      method: clear.method || ""
    };
  }

  async function guardedDomSubmitTask(task = {}, meta = {}) {
    const key = String(task.id || task.taskId || "").trim();
    if (!window.__AF_DOM_SUBMIT_INFLIGHT || !(window.__AF_DOM_SUBMIT_INFLIGHT instanceof Map)) {
      window.__AF_DOM_SUBMIT_INFLIGHT = new Map();
    }
    const inFlight = window.__AF_DOM_SUBMIT_INFLIGHT;
    if (key && inFlight.has(key)) {
      emit({
        type: "dom_submit_stage",
        taskId: key,
        mode: String(task.mode || ""),
        stage: "dedupe_inflight"
      });
      return inFlight.get(key);
    }
    const promise = domSubmitTask(task, meta);
    if (key) inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (key && inFlight.get(key) === promise) inFlight.delete(key);
    }
  }

  async function domMaterializeFrameRefOnly(payload = {}) {
    const ingredientType = String(payload.ingredientType || payload.role || "FIRST_FRAME").toUpperCase().includes("LAST")
      ? "LAST_FRAME"
      : "FIRST_FRAME";
    const ref = payload.ref && typeof payload.ref === "object" ? payload.ref : payload;
    const task = {
      id: String(payload.taskId || "manual-frame-ref-only"),
      mode: ingredientType === "LAST_FRAME" ? "start-end-image-to-video" : "image-to-video",
      refs: [ref]
    };
    const stages = [];
    const emitDomStage = (stage, extra = {}) => {
      const entry = {
        stage,
        ingredientType,
        fileName: safeUploadFileName(ref),
        ...extra
      };
      stages.push(entry);
      emit({
        type: "dom_submit_stage",
        taskId: task.id,
        mode: task.mode,
        stage,
        transport: "manual_frame_ref_only",
        ...extra,
        domTrace: summarizeDomAutomationTrace(task)
      });
    };
    emitDomStage("manual_frame_ref_only_start");
    const result = await materializeRefInFrameSlotAssetBrowser(ref, ingredientType, emitDomStage, {
      manualFrameRefOnly: true
    });
    emitDomStage("manual_frame_ref_only_done", {
      ok: Boolean(result?.ok),
      error: result?.error || "",
      mediaId: result?.mediaId || "",
      assetImageId: result?.assetImageId || "",
      confirmedImageId: result?.confirmedImageId || "",
      source: result?.source || ""
    });
    return {
      ok: Boolean(result?.ok),
      action: "domMaterializeFrameRefOnly",
      ingredientType,
      result,
      stages,
      domTrace: summarizeDomAutomationTrace(task)
    };
  }

  async function handleCommand(payload = {}) {
    const action = String(payload.action || "health");
    if (action === "health") {
	      return {
	        ok: true,
	        action,
        hookVersion: HOOK_VERSION,
	        hookInstalled: true,
	        href: location.href,
	        projectId: projectIdFromUrl(),
        hasNativeFetch: typeof window.__afRebuildNativeFetch === "function"
      };
    }
    if (action === "projectState") {
      return {
        ok: true,
        action,
        ...collectProjectState()
      };
    }
    if (action === "scanGallery") {
      return scanProjectGallery(payload.options || {});
    }
    if (action === "projectGeneratedMedia") {
      return projectGeneratedMediaFeed(payload || {});
    }
    if (action === "flowRecaptcha") {
      const token = await getRecaptchaToken(payload.recaptchaAction, {
        preferDirect: payload.preferDirect === true || payload.forceFresh === true
      });
      return token
        ? { ok: true, action, token }
        : { ok: false, action, error: "missing_recaptcha_token" };
    }
    if (action === "flowFetch") {
      return {
        action,
        ...(await flowFetch(payload.request || {}))
      };
    }
    if (action === "mediaDataUrl") {
      return {
        action,
        ...(await fetchMediaDataUrl(payload.url || payload.mediaUrl || "", payload.mimeType || "image/jpeg"))
      };
    }
    if (action === "resolveVideoRendition") {
      return {
        action,
        ...(await resolveVideoRendition(payload || {}))
      };
    }
    if (action === "resolveVideoDownloadReadiness") {
      return {
        action,
        ...(await resolveVideoDownloadReadiness(payload || {}))
      };
    }
    if (action === "upscaleImage") {
      return {
        action,
        ...(await upscaleImage(payload || {}))
      };
    }
    if (action === "upscaleVideo") {
      return {
        action,
        ...(await upscaleVideo(payload || {}))
      };
    }
	    if (action === "flowDomClick") {
	      return clickDomAction(payload.area, payload.name);
	    }
	    if (action === "domSubmitTask") {
	      return guardedDomSubmitTask(payload.task || {}, payload.meta || {});
	    }
    if (action === "domPrepareTaskForDebugger") {
      return domPrepareTaskForDebugger(payload.task || {}, payload.meta || {});
    }
    if (action === "domMaterializeFrameRefOnly") {
      return domMaterializeFrameRefOnly(payload || {});
    }
    if (action === "domSyncTaskSettingsForDebugger") {
      return domSyncTaskSettingsForDebugger(payload.task || {}, payload.meta || {});
    }
    if (action === "domCommitPromptForDebugger") {
      return domCommitPromptForDebugger(payload.task || {});
    }
    if (action === "domClearPromptAfterDebuggerSubmit") {
      return domClearPromptAfterDebuggerSubmit(payload.task || {});
    }
    if (action === "domArmDebuggerSubmitCapture") {
      return armDebuggerSubmitCapture(payload.task || {}, payload.meta || {});
    }
    if (action === "domAwaitDebuggerSubmitCapture") {
      return awaitDebuggerSubmitCapture(payload.task || {}, payload.meta || {});
    }
    if (action === "clear_flow_cache" || action === "clearFlowCache") {
      return {
        ok: true,
        action,
        ...(await clearFlowCache())
      };
    }
    if (action === "clear_flow_cookies" || action === "clearFlowCookies") {
      return {
        ok: true,
        action,
        ...clearFlowCookies()
      };
    }
    return {
      ok: false,
      action,
      error: "unknown_page_command"
    };
  }

  const pageMessageHandler = (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE || data.type !== "af.rebuild.page.command") return;
    Promise.resolve()
      .then(() => handleCommand(data.payload || {}))
      .then((result) => {
        window.postMessage(
          {
            source: SOURCE,
            type: "af.rebuild.page.command.result",
            requestId: data.requestId,
            payload: {
              hookVersion: HOOK_VERSION,
              ...result
            }
          },
          "*"
        );
      })
      .catch((error) => {
        window.postMessage(
          {
            source: SOURCE,
            type: "af.rebuild.page.command.result",
            requestId: data.requestId,
            payload: {
              ok: false,
              hookVersion: HOOK_VERSION,
              error: String(error?.message || error || "page_command_failed")
            }
          },
          "*"
        );
      });
  };
  window.__afRebuildPageMessageHandler = pageMessageHandler;
  window.addEventListener("message", pageMessageHandler);

	  const autoFlowRebuildFetch = async function autoFlowRebuildFetch(input, init) {
	    const startedAt = performance.now();
	    const url = typeof input === "string" ? input : input?.url || "";
	    const method = String(init?.method || input?.method || "GET").toUpperCase();
	    try {
      let nextInput = input;
      let nextInit = init;
      let requestBodyText = "";
      if (domSubmitWaiters.length && generationFetchCandidate(url, method)) {
        requestBodyText = await readFetchBodyText(input, init);
        const waiter = domSubmitWaiters[0];
        markDomSubmitRequestStarted(waiter, url);
        if (generationEndpointKind(url) === "video") {
          const rewrite = rewriteVideoGenerationBody(nextInput, nextInit, requestBodyText, waiter?.audioFailurePreference);
          nextInput = rewrite.input;
          nextInit = rewrite.init;
          requestBodyText = rewrite.requestBodyText;
        }
      }
	      const response = await originalFetch.call(this, nextInput, nextInit);
	      let capturedText = "";
	      if (domSubmitWaiters.length && generationFetchCandidate(url, method)) {
	        capturedText = await response.text().catch(() => "");
          emitFlowGenerationResponse({
            url,
            method,
            status: response.status,
            ok: response.ok,
            text: capturedText,
            requestBodyText,
            elapsedMs: performance.now() - startedAt
          });
	        resolveDomSubmitWaiterFromFetch({
	          url,
	          method,
	          status: response.status,
	          ok: response.ok,
	          text: capturedText,
            requestBodyText
          });
          return rebuildTextResponse(response, capturedText);
	      }
        if (generationStatusFetchCandidate(url, method)) {
          capturedText = await response.text().catch(() => "");
          emitFlowGenerationResponse({
            url,
            method,
            status: response.status,
            ok: response.ok,
            text: capturedText,
            requestBodyText: await readFetchBodyText(input, init),
            elapsedMs: performance.now() - startedAt
          });
          return rebuildTextResponse(response, capturedText);
        }
        if (flowWorkflowFetchCandidate(url, method)) {
          capturedText = await response.text().catch(() => "");
          emitFlowGenerationResponse({
            url,
            method,
            status: response.status,
            ok: response.ok,
            text: capturedText,
            requestBodyText: "",
            elapsedMs: performance.now() - startedAt
          });
          return rebuildTextResponse(response, capturedText);
        }
        if (mediaRedirectFetchCandidate(url, method)) {
          emitFlowGenerationResponse({
            url,
            method,
            status: response.status,
            ok: response.ok,
            text: "",
            requestBodyText: "",
            elapsedMs: performance.now() - startedAt
          });
        }
	      if (String(url).includes("aisandbox-pa.googleapis.com")) {
	        emit({
	          kind: "fetch",
	          url: String(url),
	          method,
          status: response.status,
          ok: response.ok,
          elapsedMs: Math.round(performance.now() - startedAt)
        });
      }
	      return response;
	    } catch (error) {
	      if (domSubmitWaiters.length && generationFetchCandidate(url, method)) {
	        const waiter = domSubmitWaiters[0];
	        finalizeDomSubmitWaiter(waiter, {
	          ok: false,
	          status: 0,
	          endpoint: String(url || ""),
	          mediaIds: [],
	          error: String(error?.message || error || "dom_submit_fetch_failed")
	        });
	      }
	      if (String(url).includes("aisandbox-pa.googleapis.com")) {
	        emit({
	          kind: "fetch-error",
          url: String(url),
          method,
          error: String(error?.message || error),
          elapsedMs: Math.round(performance.now() - startedAt)
        });
      }
      throw error;
    }
  };
  window.__afRebuildSubmitCaptureFetch = autoFlowRebuildFetch;
  window.fetch = autoFlowRebuildFetch;

  if (typeof OriginalXMLHttpRequest === "function") {
    window.XMLHttpRequest = function AutoFlowRebuildXMLHttpRequest() {
      const xhr = new OriginalXMLHttpRequest();
      let requestUrl = "";
      let requestMethod = "GET";
      let requestBodyText = "";
      const nativeOpen = xhr.open;
      const nativeSend = xhr.send;

      xhr.open = function open(method, url, ...rest) {
        requestMethod = String(method || "GET").toUpperCase();
        requestUrl = String(url || "");
        return nativeOpen.call(xhr, method, url, ...rest);
      };

      xhr.send = function send(body) {
        const shouldCapture = domSubmitWaiters.length && generationFetchCandidate(requestUrl, requestMethod);
        if (shouldCapture) {
          requestBodyText = typeof body === "string" ? body : "";
          markDomSubmitRequestStarted(domSubmitWaiters[0], requestUrl);
          xhr.addEventListener("loadend", () => {
            try {
              let text = "";
              try {
                if (!xhr.responseType || xhr.responseType === "text") {
                  text = String(xhr.responseText || "");
                } else if (xhr.response && typeof xhr.response === "object") {
                  text = JSON.stringify(xhr.response);
                }
              } catch {}
              resolveDomSubmitWaiterFromFetch({
                url: requestUrl,
                method: requestMethod,
                status: xhr.status,
                ok: xhr.status >= 200 && xhr.status < 300,
                text,
                requestBodyText
              });
            } catch (error) {
              finalizeDomSubmitWaiter(domSubmitWaiters[0], {
                ok: false,
                status: xhr.status || 0,
                endpoint: String(requestUrl || ""),
                mediaIds: [],
                error: String(error?.message || error || "dom_submit_xhr_capture_failed")
              });
            }
          }, { once: true });
        }
        return nativeSend.call(xhr, body);
      };

      return xhr;
    };
    window.XMLHttpRequest.prototype = OriginalXMLHttpRequest.prototype;
  }

  emit({
    kind: "page-hook-ready",
    href: location.href,
    projectId: projectIdFromUrl(),
    hookVersion: HOOK_VERSION,
    hookInstalled: true
  });
})();
