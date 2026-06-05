import { TaskStatus } from "./task-ledger.js";
import { classifyDomVerificationFailure, extractFlowErrorCode, isHardQuotaFailure } from "./recovery-policy.js";
import { base64FromDataUrl, getReferenceBlob, mimeTypeFromDataUrl } from "../storage/reference-blob-store.js";

export const FlowTaskMode = Object.freeze({
  textToImage: "text-to-image",
  textToVideo: "text-to-video",
  imageToVideo: "image-to-video",
  startEndImageToVideo: "start-end-image-to-video",
  ingredientsToVideo: "ingredients-to-video"
});

const VIDEO_MODES = new Set([
  FlowTaskMode.textToVideo,
  FlowTaskMode.imageToVideo,
  FlowTaskMode.startEndImageToVideo,
  FlowTaskMode.ingredientsToVideo
]);

export function normalizeFlowMediaStatus(status = "") {
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

export function extractVideoStatusRows(data) {
  const mediaRows = Array.isArray(data?.media) ? data.media : data?.media ? [data.media] : [];
  return mediaRows.map((media) => {
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
      id: String(media?.name || "").trim(),
      workflowId: String(media?.workflowId || "").trim(),
      rawStatus,
      status,
      ...(failureText ? { failureText } : {}),
      model: String(generated.model || ""),
      aspectRatio: String(generated.aspectRatio || video.aspectRatio || metaVideo.aspectRatio || ""),
      mediaUrl: String(generated.fifeUri || generated.uri || generated.url || video.fifeUri || video.uri || video.url || media?.mediaData?.url || ""),
      thumbnailUrl: String(generated.thumbnailUri || generated.thumbnailUrl || video.thumbnailUri || video.thumbnailUrl || media?.thumbnailUrl || "")
    };
  });
}

function resultErrorText(result = {}) {
  const parts = [];
  const collect = (value) => {
    if (value === null || value === undefined || value === "") return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
      return;
    }
    if (value instanceof Error) {
      parts.push(value.message || String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (typeof value === "object") {
      [
        value.error,
        value.code,
        value.reason,
        value.status,
        value.statusText,
        value.message,
        value.details
      ].forEach(collect);
      if (!parts.length) {
        try {
          parts.push(JSON.stringify(value));
        } catch {
          parts.push(String(value));
        }
      }
    }
  };
  [
    result.error,
    result.statusText,
    result.data?.error,
    result.data?.message,
    result.data?.status,
    result.data?.reason
  ].forEach(collect);
  return [...new Set(parts.map((part) => String(part || "").trim()).filter(Boolean))].join(" ");
}

function apiBackendErrorText(result = {}) {
  const payloadText = resultErrorText({ error: result?.data?.error || result?.error || "" });
  const text = payloadText || resultErrorText(result);
  const status = Number(result?.status || result?.data?.error?.code || result?.code || 0);
  if (status && text && !new RegExp(`\\b${status}\\b`).test(text)) {
    return `${status} ${text}`.trim();
  }
  return text || (status ? `HTTP_${status}` : "");
}

function isApiBackendFailure(result = {}) {
  const status = Number(result?.status || result?.data?.error?.code || result?.code || 0);
  const text = apiBackendErrorText(result);
  return status >= 500 || /flow_api_backend|api_backend|http_500|500 internal|internal server error|internal error encountered/i.test(text);
}

function canFallbackApiBackendToDom(task = {}, submitPath = "") {
  return submitPath === "api_first" && (
    task.mode === FlowTaskMode.textToImage ||
    VIDEO_MODES.has(String(task.mode || ""))
  );
}

function taskModeLabel(task = {}) {
  if (task.mode === FlowTaskMode.textToVideo) return "Text to Video";
  if (task.mode === FlowTaskMode.imageToVideo) return "Frame to Video";
  if (task.mode === FlowTaskMode.startEndImageToVideo) return "Start/End Frame to Video";
  if (task.mode === FlowTaskMode.ingredientsToVideo) return "Ingredients to Video";
  if (task.mode === FlowTaskMode.textToImage) return "Create Image";
  return String(task.mode || "task");
}

function combinedApiDomFailure(task = {}, apiResult = {}, domResult = {}) {
  const apiError = apiBackendErrorText(apiResult) || "API submit failed";
  const domError = resultErrorText(domResult) || domResult?.statusText || domResult?.error || "DOM fallback failed";
  const modeLabel = taskModeLabel(task);
  const message = `FLOW_API_BACKEND: API submit failed for ${modeLabel}: ${apiError}; DOM fallback failed: ${domError}`;
  return {
    ok: false,
    status: Number(apiResult?.status || 500),
    statusText: "FLOW_API_BACKEND_DOM_FALLBACK_FAILED",
    mediaIds: [],
    outputRows: [],
    error: message,
    data: {
      error: message,
      apiError,
      domError,
      apiStatus: Number(apiResult?.status || 0),
      domStatus: Number(domResult?.status || 0)
    },
    apiError,
    domError,
    fallbackFromApiBackend: true
  };
}

const T2I_SAVED_REFERENCE_ASSET_ROW_MISSING = "t2i_saved_reference_asset_row_missing";
const T2I_SAVED_REFERENCE_TITLE = "Reference image missing in Flow";
const T2I_SAVED_REFERENCE_BODY = "Auto Flow tried to recover from a Google Flow API error using browser mode, but Flow did not show the saved reference image needed for this prompt. Re-upload the reference or let Auto Flow re-upload it from local cache.";

function resultHasAssetRowMissing(result = {}) {
  return /ASSET_ROW_NOT_FOUND/i.test(resultErrorText(result) || result?.statusText || result?.error || "");
}

function userFacingSavedReferenceError(fileName = "") {
  return `${T2I_SAVED_REFERENCE_ASSET_ROW_MISSING}: ${T2I_SAVED_REFERENCE_TITLE}${fileName ? ` (${fileName})` : ""}`;
}

function compactIds(values = []) {
  return [...new Set((values || [])
    .map((id) => String(id || "").trim())
    .filter(Boolean))];
}

  function observedVideoIdsForTask(task = {}) {
    if (!VIDEO_MODES.has(String(task.mode || ""))) return [];
    return compactIds([
      ...(Array.isArray(task.mediaIds) ? task.mediaIds : []),
      ...(Array.isArray(task.outputMediaIds) ? task.outputMediaIds : []),
    ...(Array.isArray(task.statusRows) ? task.statusRows.map((row) => row?.id || row?.mediaId) : []),
      ...(Array.isArray(task.outputs) ? task.outputs.map((output) => output?.mediaId) : [])
    ]);
  }

  function observedSubmitResultForTask(task = {}) {
    if (!VIDEO_MODES.has(String(task.mode || ""))) return null;
    const mediaIds = observedVideoIdsForTask(task);
    if (!mediaIds.length) return null;
    const statusRows = Array.isArray(task.statusRows) ? task.statusRows : [];
    return {
      ok: true,
      status: 202,
      statusText: "DOM_DEBUGGER_OBSERVED_BY_STATUS_FEED",
      mediaIds,
      outputRows: statusRows,
      data: {
        outputRows: statusRows,
        observedByStatusFeed: true
      },
      observedByStatusFeed: true
    };
  }

	  function domSubmitAllowsStatusFeedEarlyResolve(task = {}) {
	    void task;
	    return false;
	  }

function isModelAccessDenied(result = {}) {
  return /public_error_model_access_denied|model_access_denied|model access denied/i.test(resultErrorText(result));
}

function isReloadable403Result(result = {}) {
  if (isModelAccessDenied(result)) return false;
  return /public_error_unusual_activity|recaptcha|permission_denied|403|unusual activity/i.test(resultErrorText(result));
}

function resultTextForRecovery(result = {}) {
  return [
    result.status,
    result.statusText,
    resultErrorText(result)
  ].map((part) => String(part || "").trim()).filter(Boolean).join(" ");
}

function isApiFirstHardQuotaResult(result = {}) {
  return isHardQuotaFailure(resultTextForRecovery(result));
}

function resultMediaIds(result = {}) {
  return compactIds([
    ...(Array.isArray(result.mediaIds) ? result.mediaIds : []),
    ...(Array.isArray(result.data?.mediaIds) ? result.data.mediaIds : []),
    ...(Array.isArray(result.outputRows) ? result.outputRows.map((row) => row?.id || row?.mediaId) : []),
    ...(Array.isArray(result.data?.outputRows) ? result.data.outputRows.map((row) => row?.id || row?.mediaId) : [])
  ]);
}

const VIDEO_MODEL_ACCESS_FALLBACK = "veo3_lite_low";

function fallbackVideoModelForTask(task = {}) {
  if (task.mode === FlowTaskMode.textToImage) return "";
  const current = String(task.model || "default").trim() || "default";
  if (current === VIDEO_MODEL_ACCESS_FALLBACK) return "";
  return VIDEO_MODEL_ACCESS_FALLBACK;
}

function canFallbackVideoModel(task = {}) {
  return Boolean(fallbackVideoModelForTask(task));
}

export function createQueueExecutor({
  ledger,
  scheduler,
  flowClient,
  domSubmitter = null,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = 5000,
  maxPolls = 96,
  logger = () => {},
  onTaskStateChange = async () => {}
} = {}) {
  if (!ledger) throw new Error("Queue executor requires a task ledger");
  if (!scheduler) throw new Error("Queue executor requires a scheduler");
  if (!flowClient) throw new Error("Queue executor requires a Flow client");

  function submitPathFor(task) {
    const raw = String(task.submitPathPreference || task.submitPath || "api_first").trim();
    if (raw === "dom_first") return raw;
    if (raw === "dom_fallback") return raw;
    return "api_first";
  }

  function taskLogFields(task = {}) {
    const refInputs = Array.isArray(task.refInputs) ? task.refInputs : [];
    const refMediaIds = Array.isArray(task.refMediaIds) ? task.refMediaIds : [];
    const inlineRefCount = refInputs.filter((ref) => Boolean(ref?.imageBytes || ref?.dataUrl || ref?.imageUrl || ref?.mediaUrl)).length;
    return {
      mode: task.mode || "",
      submitPath: submitPathFor(task),
      attempt: Number(task.attempts || 0),
      jobIndex: Number.isFinite(Number(task.jobIndex)) ? Number(task.jobIndex) : null,
      jobPromptCount: Number(task.jobPromptCount || 0),
      repeatCount: Number(task.repeatCount || 1) || 1,
      videoLength: String(task.videoLength || task.videoDurationSeconds || ""),
      model: task.model || "",
      aspectRatio: task.aspectRatio || "",
      refCount: Math.max(refMediaIds.length, refInputs.length),
      mediaRefCount: refMediaIds.length,
      inlineRefCount
    };
  }

  function taskRefCount(task = {}) {
    const refInputs = Array.isArray(task.refInputs) ? task.refInputs : [];
    const refMediaIds = Array.isArray(task.refMediaIds) ? task.refMediaIds : [];
    return Math.max(refInputs.length, refMediaIds.length);
  }

  function taskRefsHaveReusableMedia(task = {}) {
    const refs = Array.isArray(task.refInputs) ? task.refInputs : [];
    if (!refs.length) return true;
    return refs.every((ref) => Boolean(mediaIdFromRef(ref)));
  }

  function apiFirstDomSuccessExtra(result = {}, task = {}) {
    if (result.apiFirstQuotaVerification !== true) return {};
    return {
      apiFirstDomVerificationSucceeded: true,
      apiFirstQuotaSuspected: true,
      domVerificationAttempted: true,
      domVerificationResult: "success",
      domVerificationFailureClass: "",
      finalQuotaClassification: "api_first_blocked_dom_available",
      failureClass: "api_first_blocked_dom_available",
      recoveryPolicy: "browser_mode_available",
      recoveryAttempted: true,
      recoverySkippedBecauseHardQuota: false,
      recoveryStepsAttempted: ["dom_first_browser_verification"],
      recoveryFinalOutcome: "dom_available",
      recommendedNextAction: "Continue remaining prompts with browser/DOM mode, or pause and export the report.",
      sideEffectRetryBlocked: false,
      healAction: "user_confirm_browser_mode",
      failureScope: "global",
      refsReusedForDomVerification: result.refsReusedForDomVerification === true,
      pendingRowsPreserved: true,
      modelSubmittedByApi: result.modelSubmittedByApi || task.model || "",
      modelVisibleInFlow: result.modelVisibleInFlow || "",
      flowErrorCode: result.flowErrorCode || "PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED RESOURCE_EXHAUSTED"
    };
  }

  function freshBatchId() {
    try {
      if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch {}
    return `af-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function notifyTaskStateChange(taskId, reason = "") {
    try {
      await onTaskStateChange({
        taskId,
        reason,
        task: ledger.getTask(taskId) || null
      });
    } catch (error) {
      logger({
        type: "task_state_change_error",
        taskId,
        reason,
        error: String(error?.message || error || "task_state_change_failed")
      });
    }
  }

  async function submitViaApiRequest(task) {
    const inputMediaIds = Array.isArray(task.refMediaIds) && task.refMediaIds.length
      ? task.refMediaIds
      : Array.isArray(task.mediaIds)
        ? task.mediaIds
        : [];
    const common = {
      prompt: task.prompt,
      projectId: task.projectId,
      repeatCount: task.repeatCount || 1,
      model: task.model || "default",
      aspectRatio: task.aspectRatio || "landscape",
      videoLength: task.videoLength || task.videoDurationSeconds || "8",
      returnSilentVideos: task.returnSilentVideos !== false,
      batchId: task.batchId,
      forceFreshRecaptcha: task.forceFreshRecaptcha === true
    };

    if (task.mode === FlowTaskMode.textToImage) {
      return flowClient.submitTextToImage({
        ...common,
        model: task.model || "nano_banana_pro",
        mediaIds: inputMediaIds
      });
    }

    if (task.mode === FlowTaskMode.textToVideo) {
      return flowClient.submitTextToVideo(common);
    }

    if (task.mode === FlowTaskMode.imageToVideo) {
      return flowClient.submitVideoStartImage({
        ...common,
        startMediaId: task.startMediaId
      });
    }

    if (task.mode === FlowTaskMode.startEndImageToVideo) {
      return flowClient.submitVideoStartAndEndImage({
        ...common,
        startMediaId: task.startMediaId,
        endMediaId: task.endMediaId
      });
    }

    if (task.mode === FlowTaskMode.ingredientsToVideo) {
      return flowClient.submitVideoReferenceImages({
        ...common,
        mediaIds: inputMediaIds
      });
    }

    throw new Error(`Unsupported task mode: ${task.mode}`);
  }

  async function submitViaApi(task) {
    logger({
      type: "submit_path_start",
      taskId: task.id,
      path: "api",
      ...taskLogFields(task)
    });
    try {
      const result = await submitViaApiRequest(task);
      logger({
        type: "submit_path_result",
        taskId: task.id,
        path: "api",
        transport: "extension_api_submit",
        ok: result.ok === true,
        status: result.status || 0,
        statusText: result.statusText || "",
        mediaIdCount: Array.isArray(result.mediaIds) ? result.mediaIds.length : 0,
        endpoint: result.endpoint || "",
        error: isApiBackendFailure(result) ? apiBackendErrorText(result) : resultErrorText(result),
        ...taskLogFields(task)
      });
      return result;
    } catch (error) {
      logger({
        type: "submit_path_error",
        taskId: task.id,
        path: "api",
        transport: "extension_api_submit",
        error: String(error?.message || error || "api_submit_failed"),
        ...taskLogFields(task)
      });
      throw error;
    }
  }

  async function submitViaDom(task, meta = {}) {
    if (!domSubmitter || typeof domSubmitter.submitTask !== "function") {
      throw new Error("DOM_SUBMIT_ADAPTER_UNAVAILABLE");
    }
    logger({
      type: "submit_path_start",
      taskId: task.id,
      path: "dom",
      repairFromApi: Boolean(meta.apiResult),
      ...taskLogFields(task)
    });
    try {
      const domTask = await hydrateTaskForDomSubmit(task);
      const domSubmitPromise = domSubmitter.submitTask(domTask, {
        submitPath: submitPathFor(task),
        ...meta
      });
      const allowStatusFeedSubmitObservation = meta.allowStatusFeedSubmitObservation === true
        && meta.allowStatusFeedEarlyResolve === true
        && domSubmitAllowsStatusFeedEarlyResolve(task);
      let cancelStatusFeedObservation = false;
      const observedPromise = allowStatusFeedSubmitObservation && VIDEO_MODES.has(String(task.mode || ""))
        ? (async () => {
            const deadline = Date.now() + Math.max(10000, Number(meta.statusFeedSubmitTimeoutMs || 90000));
            while (!cancelStatusFeedObservation && Date.now() < deadline) {
              await wait(500);
              if (cancelStatusFeedObservation) return null;
              const observedTask = ledger.getTask(task.id);
              const observed = observedSubmitResultForTask(observedTask);
              if (observed) return observed;
            }
            return null;
          })()
        : Promise.resolve(null);
      const first = allowStatusFeedSubmitObservation
        ? await Promise.race([
            domSubmitPromise.then((result) => ({ type: "dom", result })),
            observedPromise.then((result) => result ? { type: "observed", result } : { type: "observed_timeout", result: null })
          ])
        : { type: "dom", result: await domSubmitPromise };
      let result;
      if (first?.type === "observed" && first.result) {
        result = first.result;
        cancelStatusFeedObservation = true;
        if (String(task.mode || "") === FlowTaskMode.textToVideo && typeof domSubmitter.repairStatusFeedOnlySubmitVisibility === "function") {
          const visibilityRepair = await domSubmitter.repairStatusFeedOnlySubmitVisibility(task, result)
            .catch((error) => ({ ok: false, error: String(error?.message || error || "status_feed_visible_repair_failed") }));
          logger({
            type: "submit_path_status_feed_visible_repair",
            taskId: task.id,
            path: "dom",
            ok: visibilityRepair?.ok === true,
            skipped: visibilityRepair?.skipped === true,
            skippedReload: visibilityRepair?.skippedReload === true,
            reason: visibilityRepair?.reason || "",
            error: visibilityRepair?.error || visibilityRepair?.reloadError || "",
            mediaIdCount: Array.isArray(visibilityRepair?.mediaIds) ? visibilityRepair.mediaIds.length : 0,
            ...taskLogFields(task)
          });
          result = {
            ...result,
            statusText: visibilityRepair?.ok === true
              ? "DOM_DEBUGGER_OBSERVED_BY_STATUS_FEED_VISIBLE_REPAIRED"
              : "DOM_DEBUGGER_OBSERVED_BY_STATUS_FEED_FRONTEND_REPAIR_FAILED",
            data: {
              ...(result.data || {}),
              frontendVisibilityRepair: visibilityRepair,
              frontendProofMissing: visibilityRepair?.ok !== true
            }
          };
        }
        domSubmitPromise
          .then((lateResult) => {
            logger({
              type: "submit_path_late_dom_result",
              taskId: task.id,
              path: "dom",
              ok: lateResult?.ok === true,
              status: lateResult?.status || 0,
              statusText: lateResult?.statusText || "",
              ignoredBecause: "status_feed_observed_submit",
              mediaIdCount: Array.isArray(lateResult?.mediaIds) ? lateResult.mediaIds.length : 0,
              ...taskLogFields(task)
            });
          })
          .catch((error) => {
            logger({
              type: "submit_path_late_dom_error",
              taskId: task.id,
              path: "dom",
              ignoredBecause: "status_feed_observed_submit",
              error: String(error?.message || error || "late_dom_submit_failed"),
              ...taskLogFields(task)
            });
          });
      } else {
        result = first?.type === "dom"
          ? first.result
          : await domSubmitPromise;
        cancelStatusFeedObservation = true;
      }
      logger({
        type: "submit_path_result",
        taskId: task.id,
        path: "dom",
        ok: result.ok === true,
        status: result.status || 0,
        statusText: result.statusText || "",
        mediaIdCount: Array.isArray(result.mediaIds) ? result.mediaIds.length : 0,
        error: resultErrorText(result),
        transport: result.data?.transport || result.transport || "dom_page_command",
        observedByStatusFeed: result.observedByStatusFeed === true,
        repairedFromApi: Boolean(meta.apiResult),
        attachOutcome: result.data?.attachOutcome || result.attachOutcome || null,
        ...taskLogFields(task)
      });
      return result;
    } catch (error) {
      logger({
        type: "submit_path_error",
        taskId: task.id,
        path: "dom",
        error: String(error?.message || error || "dom_submit_failed"),
        repairFromApi: Boolean(meta.apiResult),
        ...taskLogFields(task)
      });
      throw error;
    }
  }

  function domResultAllowsApiRepair(result = {}) {
    const error = String(result?.error || result?.data?.error || result?.statusText || "").trim();
    if (/^DOM_FRAME/i.test(error) || error === "STORE_DIRECT_FRAME_ATTACH_FAILED") return false;
    if (/^DOM_SUBMIT_REJECTED_\d+/i.test(error)) return false;
    if (result?.data?.transport === "chrome_debugger" || /^DOM_DEBUGGER_/i.test(error) || /^dom_debugger_/i.test(error)) return false;
    if (/^DOM_/.test(error)) return true;
    if (/^dom_/i.test(error)) return true;
    if (error === "PROMPT_STORE_NOT_FOUND") return true;
    if (/^page_command_timeout$/i.test(error)) return true;
    return [
      "DOM_SUBMIT_MEDIA_IDS_NOT_CAPTURED",
      "DOM_CREATE_CLICK_FAILED",
      "DOM_SUBMIT_WRONG_ENDPOINT_FOR_MODE",
      "ASSET_BROWSER_NOT_OPEN",
      "ASSET_ROW_NOT_FOUND",
      "REF_ATTACH_NOT_PERSISTED",
      "REF_NOT_SERIALIZED"
    ].includes(error);
  }

  function domTaskAllowsApiRepair(task = {}, result = {}) {
    return task?.allowDomApiRepair === true && domResultAllowsApiRepair(result);
  }

  function domFrontendProofFailure(result = {}) {
    return /DOM_DEBUGGER_FRONTEND_NOT_UPDATED|DOM_DEBUGGER_INCOMPLETE_MEDIA_IDS/i.test(resultErrorText(result));
  }

	  function clearFailedDomVideoObservation(taskId, result = {}) {
	    const reason = resultErrorText(result);
	    logger({
	      type: "failed_dom_video_observation_cleared",
	      taskId,
	      reason
	    });
	    ledger.updateTask(taskId, {
	      mediaIds: [],
	      outputMediaIds: [],
	      outputs: [],
	      statusRows: [],
	      submitOutputRows: [],
	      foundVideos: 0,
	      submitObservationRecovered: false,
	      submitObservationError: reason
	    });
	  }

  function mediaIdFromRef(ref = {}) {
    const raw = String(ref?.mediaId || ref?.assetImageId || "").trim();
    if (!raw || isLocalReferenceMediaId(raw, ref)) return "";
    const match = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0] : raw;
  }

  function trustedMediaId(value = "") {
    return String(value || "").trim();
  }

  function isLocalReferenceMediaId(value = "", ref = {}) {
    const mediaId = trustedMediaId(value);
    if (!mediaId || !ref || typeof ref !== "object") return false;
    const localIds = [
      ref.blobStoreId,
      ref.id
    ].map(trustedMediaId).filter(Boolean);
    return localIds.includes(mediaId);
  }

  function localReferenceIdsForTask(task = {}) {
    const refs = [
      task.startRefInput,
      task.endRefInput,
      ...(Array.isArray(task.refInputs) ? task.refInputs : [])
    ].filter((ref) => ref && typeof ref === "object");
    return new Set(refs.flatMap((ref) => [ref.blobStoreId, ref.id].map(trustedMediaId).filter(Boolean)));
  }

  function trustedTaskMediaId(value = "", task = {}) {
    const mediaId = trustedMediaId(value);
    if (!mediaId) return "";
    return localReferenceIdsForTask(task).has(mediaId) ? "" : mediaId;
  }

  function trustedTaskMediaIds(values = [], task = {}) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map((value) => trustedTaskMediaId(value, task))
      .filter(Boolean))];
  }

  function inlineImageBytesFromRef(ref = {}) {
    const direct = String(ref?.imageBytes || "").replace(/\s+/g, "");
    if (direct) return direct;
    const dataUrl = String(ref?.dataUrl || (!ref?.blobStoreId ? (ref?.imageUrl || ref?.mediaUrl || "") : "")).trim();
    if (!/^data:/i.test(dataUrl)) return "";
    return base64FromDataUrl(dataUrl).replace(/\s+/g, "");
  }

  async function storedReferenceBlobForRef(ref = {}) {
    const blobStoreId = String(ref?.blobStoreId || "").trim();
    if (!blobStoreId) return null;
    return await getReferenceBlob(blobStoreId).catch(() => null);
  }

  async function imageBytesFromRef(ref = {}) {
    const inline = inlineImageBytesFromRef(ref);
    if (inline) return inline;
    const stored = await storedReferenceBlobForRef(ref);
    const storedBytes = base64FromDataUrl(stored?.dataUrl || "").replace(/\s+/g, "");
    if (storedBytes) return storedBytes;
    const previewDataUrl = String(ref?.imageUrl || ref?.mediaUrl || "").trim();
    if (!/^data:/i.test(previewDataUrl)) return "";
    return base64FromDataUrl(previewDataUrl).replace(/\s+/g, "");
  }

  async function mimeTypeFromRef(ref = {}) {
    const explicit = String(ref?.mimeType || "").trim().toLowerCase();
    if (explicit) return explicit;
    const dataUrl = String(ref?.dataUrl || (!ref?.blobStoreId ? (ref?.imageUrl || ref?.mediaUrl || "") : "")).trim();
    const inlineMime = mimeTypeFromDataUrl(dataUrl);
    if (inlineMime) return inlineMime;
    const stored = await storedReferenceBlobForRef(ref);
    if (stored) {
      return String(stored?.mimeType || mimeTypeFromDataUrl(stored?.dataUrl || "") || "image/png").toLowerCase();
    }
    return "image/png";
  }

  async function hydrateRefForDomSubmit(ref = {}) {
    if (!ref || typeof ref !== "object") return ref;
    if (/^data:image\//i.test(String(ref?.dataUrl || ""))) return ref;
    const stored = await storedReferenceBlobForRef(ref);
    const dataUrl = String(stored?.dataUrl || "");
    if (!/^data:image\//i.test(dataUrl)) return ref;
    return {
      ...ref,
      dataUrl,
      mimeType: String(ref?.mimeType || stored?.mimeType || mimeTypeFromDataUrl(dataUrl) || "image/png"),
      fileName: String(ref?.fileName || stored?.fileName || ref?.title || "reference.png")
    };
  }

  async function hydrateTaskForDomSubmit(task = {}) {
    const refs = Array.isArray(task.refInputs)
      ? await Promise.all(task.refInputs.map((ref) => hydrateRefForDomSubmit(ref)))
      : task.refInputs;
    const hydrated = { ...task };
    if (Array.isArray(refs)) hydrated.refInputs = refs;
    if (task.startRefInput) hydrated.startRefInput = await hydrateRefForDomSubmit(task.startRefInput);
    if (task.endRefInput) hydrated.endRefInput = await hydrateRefForDomSubmit(task.endRefInput);
    return hydrated;
  }

  function fileNameFromRef(ref = {}, index = 0) {
    const raw = String(ref?.fileName || ref?.title || ref?.name || "").trim();
    return raw || `reference-${index + 1}.png`;
  }

  function savedReferenceRepairCandidates(task = {}) {
    return (Array.isArray(task.refInputs) ? task.refInputs : [])
      .map((ref, index) => ({ ref, index, mediaId: mediaIdFromRef(ref) }))
      .filter((entry) => entry.mediaId && (entry.ref?.blobStoreId || entry.ref?.dataUrl || entry.ref?.imageUrl || entry.ref?.mediaUrl || entry.ref?.imageBytes || entry.ref?.fileName));
  }

  function patchT2iReferenceMediaId(task = {}, originalMediaId = "", replacementMediaId = "") {
    const original = trustedMediaId(originalMediaId);
    const replacement = trustedMediaId(replacementMediaId);
    const replaceId = (value = "") => trustedMediaId(value) === original ? replacement : trustedMediaId(value);
    const refInputs = (Array.isArray(task.refInputs) ? task.refInputs : []).map((ref) => {
      if (mediaIdFromRef(ref) !== original) return { ...ref };
      return mergeRefMediaId(ref, replacement);
    });
    return {
      refInputs,
      refMediaIds: compactIds([
        ...(Array.isArray(task.refMediaIds) ? task.refMediaIds.map(replaceId) : []),
        ...refInputs.map(mediaIdFromRef),
        replacement
      ]),
      mediaIds: compactIds(Array.isArray(task.mediaIds) ? task.mediaIds.map(replaceId) : [])
    };
  }

  function t2iSavedReferenceMissingPatch(task = {}, candidate = {}, extras = {}) {
    const ref = candidate?.ref || {};
    const originalMediaId = trustedMediaId(candidate?.mediaId || mediaIdFromRef(ref));
    const blobStoreId = String(ref?.blobStoreId || "").trim();
    const fileName = fileNameFromRef(ref, Number(candidate?.index || 0));
    return {
      failureClass: T2I_SAVED_REFERENCE_ASSET_ROW_MISSING,
      failureScope: "global",
      healAction: "reupload_reference",
      userFacingFailureTitle: T2I_SAVED_REFERENCE_TITLE,
      userFacingFailureBody: T2I_SAVED_REFERENCE_BODY,
      originalRefMediaId: originalMediaId,
      originalBlobStoreId: blobStoreId,
      missingAssetRowMediaId: originalMediaId,
      userActionRequiredReferenceFileName: fileName,
      ...extras
    };
  }

  async function repairT2iSavedReferenceDomFallback(task = {}, apiResult = {}, domResult = {}, apiError = "", meta = {}) {
    if (task.mode !== FlowTaskMode.textToImage || submitPathFor(task) !== "api_first") return null;
    if (!isApiBackendFailure(apiResult) || !resultHasAssetRowMissing(domResult)) return null;
    const candidates = savedReferenceRepairCandidates(task);
    if (!candidates.length) return null;
    const candidate = candidates[0];
    const fileName = fileNameFromRef(candidate.ref, candidate.index);
    const basePatch = t2iSavedReferenceMissingPatch(task, candidate, {
      apiBackendError: apiError || apiBackendErrorText(apiResult),
      domFallbackError: resultErrorText(domResult) || "ASSET_ROW_NOT_FOUND"
    });

    if (task.refReuploadAttempted === true || task.t2iSavedReferenceReuploadAttempted === true) {
      const patch = {
        ...basePatch,
        refReuploadAttempted: true,
        refReuploadSucceeded: false,
        duplicateRefReuploadBlocked: true,
        finalFallbackOutcome: "duplicate_ref_reupload_blocked"
      };
      ledger.updateTask(task.id, patch);
      return {
        ok: false,
        status: 0,
        statusText: T2I_SAVED_REFERENCE_ASSET_ROW_MISSING,
        mediaIds: [],
        error: `${userFacingSavedReferenceError(fileName)}; duplicate re-upload blocked`,
        data: {
          error: `${userFacingSavedReferenceError(fileName)}; duplicate re-upload blocked`,
          apiError: apiError || "",
          domError: resultErrorText(domResult) || "ASSET_ROW_NOT_FOUND"
        },
        fallbackFromApiBackend: true
      };
    }

    const imageBytes = await imageBytesFromRef(candidate.ref);
    if (!imageBytes) {
      const patch = {
        ...basePatch,
        refReuploadAttempted: false,
        refReuploadSucceeded: false,
        finalFallbackOutcome: "user_action_required_reupload_reference"
      };
      ledger.updateTask(task.id, patch);
      return {
        ok: false,
        status: 0,
        statusText: T2I_SAVED_REFERENCE_ASSET_ROW_MISSING,
        mediaIds: [],
        error: `${userFacingSavedReferenceError(fileName)}; local reference data unavailable`,
        data: {
          error: `${userFacingSavedReferenceError(fileName)}; local reference data unavailable`,
          apiError: apiError || "",
          domError: resultErrorText(domResult) || "ASSET_ROW_NOT_FOUND"
        },
        fallbackFromApiBackend: true
      };
    }

    if (typeof flowClient.uploadImage !== "function") {
      ledger.updateTask(task.id, {
        ...basePatch,
        refReuploadAttempted: false,
        refReuploadSucceeded: false,
        finalFallbackOutcome: "reference_reupload_unavailable"
      });
      return {
        ok: false,
        status: 0,
        statusText: T2I_SAVED_REFERENCE_ASSET_ROW_MISSING,
        mediaIds: [],
        error: `${userFacingSavedReferenceError(fileName)}; reference re-upload unavailable`,
        data: { error: `${userFacingSavedReferenceError(fileName)}; reference re-upload unavailable` },
        fallbackFromApiBackend: true
      };
    }

    logger({
      type: "t2i_saved_reference_reupload_start",
      taskId: task.id,
      mode: task.mode || "",
      fileName,
      originalRefMediaId: basePatch.originalRefMediaId,
      originalBlobStoreId: basePatch.originalBlobStoreId
    });
    ledger.updateTask(task.id, {
      ...basePatch,
      refReuploadAttempted: true,
      t2iSavedReferenceReuploadAttempted: true,
      refReuploadSucceeded: false,
      finalFallbackOutcome: "reference_reupload_started"
    });

    const upload = await flowClient.uploadImage({
      projectId: task.projectId,
      imageBytes,
      mimeType: await mimeTypeFromRef(candidate.ref),
      fileName,
      isHidden: false
    }).catch((error) => ({
      ok: false,
      status: 0,
      statusText: String(error?.message || error || "REFERENCE_REUPLOAD_FAILED"),
      error
    }));
    const replacementRefMediaId = trustedMediaId(upload?.mediaIds?.[0]);
    if (!upload?.ok || !replacementRefMediaId) {
      const error = resultErrorText(upload) || upload?.statusText || "REFERENCE_REUPLOAD_FAILED";
      ledger.updateTask(task.id, {
        ...basePatch,
        refReuploadAttempted: true,
        t2iSavedReferenceReuploadAttempted: true,
        refReuploadSucceeded: false,
        finalFallbackOutcome: "reference_reupload_failed"
      });
      logger({
        type: "t2i_saved_reference_reupload_failed",
        taskId: task.id,
        fileName,
        originalRefMediaId: basePatch.originalRefMediaId,
        error
      });
      return {
        ok: false,
        status: Number(upload?.status || 0),
        statusText: T2I_SAVED_REFERENCE_ASSET_ROW_MISSING,
        mediaIds: [],
        error: `${userFacingSavedReferenceError(fileName)}; reference re-upload failed: ${error}`,
        data: { error: `${userFacingSavedReferenceError(fileName)}; reference re-upload failed: ${error}` },
        fallbackFromApiBackend: true
      };
    }

    const refPatch = patchT2iReferenceMediaId(task, basePatch.originalRefMediaId, replacementRefMediaId);
    const uploadedRefIds = compactIds([...(Array.isArray(task.uploadedRefIds) ? task.uploadedRefIds : []), replacementRefMediaId]);
    const patchedTask = ledger.updateTask(task.id, {
      ...basePatch,
      ...refPatch,
      refReuploadAttempted: true,
      t2iSavedReferenceReuploadAttempted: true,
      refReuploadSucceeded: true,
      replacementRefMediaId,
      uploadedRefIds,
      domFallbackAfterRefReupload: true,
      finalFallbackOutcome: "reference_reuploaded_retrying_dom"
    }) || { ...task, ...refPatch };
    await notifyTaskStateChange(task.id, "t2i_reference_reuploaded");
    logger({
      type: "t2i_saved_reference_reupload_ok",
      taskId: task.id,
      fileName,
      originalRefMediaId: basePatch.originalRefMediaId,
      replacementRefMediaId
    });

    let retryResult;
    try {
      retryResult = await submitViaDom(patchedTask, {
        ...meta,
        submitPath: "dom_fallback",
        apiResult,
        apiBackendFallback: true,
        apiError,
        refReuploadRepair: true,
        originalRefMediaId: basePatch.originalRefMediaId,
        replacementRefMediaId
      });
    } catch (error) {
      retryResult = {
        ok: false,
        status: 0,
        statusText: String(error?.message || error || "DOM_FALLBACK_AFTER_REF_REUPLOAD_FAILED"),
        error: String(error?.message || error || "DOM_FALLBACK_AFTER_REF_REUPLOAD_FAILED"),
        data: { error: String(error?.message || error || "DOM_FALLBACK_AFTER_REF_REUPLOAD_FAILED") }
      };
    }

    if (retryResult.ok) {
      ledger.updateTask(task.id, {
        finalFallbackOutcome: "dom_fallback_after_ref_reupload_ok",
        domFallbackAfterRefReupload: true,
        refReuploadSucceeded: true,
        replacementRefMediaId,
        uploadedRefIds
      });
      return {
        ...retryResult,
        fallbackFromApiBackend: true,
        apiError,
        t2iSavedReferenceRepair: true
      };
    }

    const retryError = resultErrorText(retryResult) || "DOM_FALLBACK_AFTER_REF_REUPLOAD_FAILED";
    ledger.updateTask(task.id, {
      ...basePatch,
      ...refPatch,
      refReuploadAttempted: true,
      t2iSavedReferenceReuploadAttempted: true,
      refReuploadSucceeded: true,
      replacementRefMediaId,
      uploadedRefIds,
      domFallbackAfterRefReupload: true,
      finalFallbackOutcome: "dom_fallback_after_ref_reupload_failed",
      lastError: `${userFacingSavedReferenceError(fileName)}; DOM retry after re-upload failed: ${retryError}`
    });
    return {
      ok: false,
      status: Number(retryResult.status || 0),
      statusText: T2I_SAVED_REFERENCE_ASSET_ROW_MISSING,
      mediaIds: [],
      error: `${userFacingSavedReferenceError(fileName)}; DOM retry after re-upload failed: ${retryError}`,
      data: {
        error: `${userFacingSavedReferenceError(fileName)}; DOM retry after re-upload failed: ${retryError}`,
        apiError: apiError || "",
        domError: retryError
      },
      fallbackFromApiBackend: true
    };
  }

  async function refNeedsUpload(ref = {}) {
    return !mediaIdFromRef(ref) && Boolean(await imageBytesFromRef(ref));
  }

  async function uploadInlineTaskRefs(task = {}, { isHidden = false, reason = "reference_prepare" } = {}) {
    const refs = Array.isArray(task.refInputs) ? task.refInputs.map((ref) => ({ ...ref })) : [];
    const missingRefs = [];
    for (const [index, ref] of refs.entries()) {
      if (await refNeedsUpload(ref)) missingRefs.push({ ref, index });
    }
    if (!missingRefs.length) return task;
    if (typeof flowClient.uploadImage !== "function") {
      throw new Error("REFERENCE_UPLOAD_UNAVAILABLE");
    }

    const uploadedIds = [];
    for (const { ref, index } of missingRefs) {
      logger({
        type: "reference_upload_start",
        taskId: task.id,
        mode: task.mode || "",
        role: ref.role || "",
        fileName: fileNameFromRef(ref, index),
        reason
      });
      const result = await flowClient.uploadImage({
        projectId: task.projectId,
        imageBytes: await imageBytesFromRef(ref),
        mimeType: await mimeTypeFromRef(ref),
        fileName: fileNameFromRef(ref, index),
        isHidden
      });
      const mediaId = trustedMediaId(result?.mediaIds?.[0]);
      if (!result?.ok || !mediaId) {
        logger({
          type: "reference_upload_failed",
          taskId: task.id,
          mode: task.mode || "",
          role: ref.role || "",
          fileName: fileNameFromRef(ref, index),
          reason,
          status: result?.status || 0,
          statusText: result?.statusText || "",
          error: result?.data?.error || result?.error || "REFERENCE_UPLOAD_MISSING_MEDIA_ID"
        });
        throw (result?.data?.error || result?.error || new Error(result?.statusText || "REFERENCE_UPLOAD_MISSING_MEDIA_ID"));
      }
      refs[index] = mergeRefMediaId(ref, mediaId);
      uploadedIds.push(mediaId);
      logger({
        type: "reference_upload_ok",
        taskId: task.id,
        mode: task.mode || "",
        role: ref.role || "",
        mediaId,
        reason
      });
    }

    const refMediaIds = [...new Set([
      ...(Array.isArray(task.refMediaIds) ? task.refMediaIds : []),
      ...refs.map(mediaIdFromRef).filter(Boolean),
      ...uploadedIds
    ].map((id) => trustedTaskMediaId(id, { ...task, refInputs: refs })).filter(Boolean))];
    const patch = { refInputs: refs, refMediaIds };
    if ((task.mode === FlowTaskMode.imageToVideo || task.mode === FlowTaskMode.startEndImageToVideo) && !trustedTaskMediaId(task.startMediaId, task)) {
      const start = refs.find((ref) => String(ref.role || "") === "startFrameRef") || refs[0];
      const startMediaId = mediaIdFromRef(start);
      if (startMediaId) {
        patch.startMediaId = startMediaId;
        patch.startRefInput = mergeRefMediaId(task.startRefInput || start || {}, startMediaId);
      }
    }
    if (task.mode === FlowTaskMode.startEndImageToVideo && !trustedTaskMediaId(task.endMediaId, task)) {
      const end = refs.find((ref) => String(ref.role || "") === "endFrameRef");
      const endMediaId = mediaIdFromRef(end);
      if (endMediaId) {
        patch.endMediaId = endMediaId;
        patch.endRefInput = mergeRefMediaId(task.endRefInput || end || {}, endMediaId);
      }
    }
    const updated = ledger.updateTask(task.id, patch);
    await notifyTaskStateChange(task.id, reason);
    return updated || { ...task, ...patch };
  }

  async function verifyApiFirstQuotaWithDom(task = {}, apiResult = {}, domVideoObservationMeta = {}) {
    const mediaIds = resultMediaIds(apiResult);
    const apiError = resultTextForRecovery(apiResult) || "API_FIRST_QUOTA_OR_RECAPTCHA_PATH_SUSPECTED";
    const flowErrorCode = extractFlowErrorCode(apiError);
    if (mediaIds.length) {
      const message = `backend accepted mediaId ${mediaIds.join(",")} but visible card missing; API_FIRST_QUOTA_MEDIA_IDS_RETURNED_RECONCILE_REQUIRED: ${apiError}`;
      return {
        ...apiResult,
        ok: false,
        error: message,
        statusText: "API_FIRST_QUOTA_MEDIA_IDS_RETURNED_RECONCILE_REQUIRED",
        mediaIds,
        data: {
          ...(apiResult.data || {}),
          error: message,
          apiFirstQuotaSuspected: true,
          domVerificationAttempted: false,
          mediaIdsReturnedByApi: mediaIds
        },
        apiFirstQuotaSuspected: true,
        domVerificationAttempted: false,
        domVerificationSkippedReason: "api_returned_media_ids",
        failureClass: "backend_accepted_but_visible_card_missing",
        modelSubmittedByApi: task.model || "",
        refCount: taskRefCount(task),
        pendingRowsPreserved: true
      };
    }
    if (task.domVerificationAttempted === true) {
      return {
        ...apiResult,
        ok: false,
        error: `DOM_VERIFICATION_ALREADY_ATTEMPTED: ${apiError}`,
        statusText: "DOM_VERIFICATION_ALREADY_ATTEMPTED",
        data: {
          ...(apiResult.data || {}),
          error: `DOM_VERIFICATION_ALREADY_ATTEMPTED: ${apiError}`,
          apiFirstQuotaSuspected: true,
          domVerificationAttempted: true
        }
      };
    }

    const refsReusedForDomVerification = taskRefsHaveReusableMedia(task);
    const verificationPatch = {
      submitPathPreference: "dom_first",
      submitPath: "dom_first",
      apiFirstQuotaSuspected: true,
      domVerificationAttempted: true,
      domVerificationStartedAt: new Date().toISOString(),
      domVerificationResult: "pending",
      domVerificationFailureClass: "",
      finalQuotaClassification: "",
      modelSubmittedByApi: task.model || "",
      refCount: taskRefCount(task),
      refsReusedForDomVerification,
      pendingRowsPreserved: true,
      failureClass: "api_first_quota_or_recaptcha_path_suspected",
      flowErrorCode,
      recoveryPolicy: "dom_verification",
      recoveryAttempted: true,
      recoverySkippedBecauseHardQuota: false,
      recoveryStepsAttempted: ["dom_first_browser_verification"],
      recoveryFinalOutcome: "dom_verification_running",
      recommendedNextAction: "Verify the same task once through browser/DOM mode before treating this as a final quota stop.",
      healAction: "verify_dom_path",
      failureScope: "task",
      lastError: apiError
    };
    const updatedTask = ledger.updateTask(task.id, verificationPatch) || { ...task, ...verificationPatch };
    await notifyTaskStateChange(task.id, "api_first_quota_dom_verification_start");
    logger({
      type: "api_first_quota_dom_verification_start",
      taskId: task.id,
      apiError,
      flowErrorCode,
      refsReusedForDomVerification,
      mediaIdsReturnedByApi: 0,
      ...taskLogFields(updatedTask)
    });

    if (!domSubmitter || typeof domSubmitter.submitTask !== "function") {
      const message = `dom_verification_request_not_observed: DOM_SUBMIT_ADAPTER_UNAVAILABLE after API quota response: ${apiError}`;
      return {
        ok: false,
        status: 0,
        statusText: "DOM_VERIFICATION_REQUEST_NOT_OBSERVED",
        error: message,
        data: { error: message, apiError },
        failureClass: "dom_verification_request_not_observed",
        apiFirstQuotaSuspected: true,
        domVerificationAttempted: true,
        domVerificationResult: "failed",
        domVerificationFailureClass: "dom_verification_request_not_observed",
        modelSubmittedByApi: task.model || "",
        refCount: taskRefCount(task),
        refsReusedForDomVerification,
        pendingRowsPreserved: true,
        finalQuotaClassification: "dom_verification_request_not_observed"
      };
    }

    let domResult;
    try {
      domResult = await submitViaDom(updatedTask, {
        ...domVideoObservationMeta,
        submitPath: "dom_first",
        apiResult,
        apiFirstQuotaVerification: true,
        apiError
      });
    } catch (error) {
      domResult = {
        ok: false,
        status: 0,
        statusText: String(error?.message || error || "DOM_VERIFICATION_FAILED"),
        error: String(error?.message || error || "DOM_VERIFICATION_FAILED"),
        data: { error: String(error?.message || error || "DOM_VERIFICATION_FAILED") }
      };
    }

    if (domResult.ok) {
      logger({
        type: "api_first_quota_dom_verification_ok",
        taskId: task.id,
        status: domResult.status || 0,
        mediaIdCount: resultMediaIds(domResult).length,
        refsReusedForDomVerification,
        ...taskLogFields(updatedTask)
      });
      return {
        ...domResult,
        apiFirstQuotaVerification: true,
        apiFirstQuotaSuspected: true,
        domVerificationAttempted: true,
        domVerificationResult: "success",
        finalQuotaClassification: "api_first_blocked_dom_available",
        refsReusedForDomVerification,
        pendingRowsPreserved: true,
        modelSubmittedByApi: task.model || "",
        modelVisibleInFlow: domResult.modelVisibleInFlow || domResult.data?.modelVisibleInFlow || "",
        flowErrorCode
      };
    }

    const domError = resultTextForRecovery(domResult);
    const failureClass = classifyDomVerificationFailure(domError || domResult) || "dom_verification_request_not_observed";
    const message = `${failureClass}: ${domError || "DOM_VERIFICATION_FAILED"}`;
    logger({
      type: "api_first_quota_dom_verification_failed",
      taskId: task.id,
      status: domResult.status || 0,
      statusText: domResult.statusText || "",
      failureClass,
      error: message,
      ...taskLogFields(updatedTask)
    });
    return {
      ...domResult,
      ok: false,
      error: message,
      statusText: failureClass.toUpperCase(),
      data: {
        ...(domResult.data || {}),
        error: message,
        apiError,
        domError,
        apiFirstQuotaSuspected: true,
        domVerificationAttempted: true,
        domVerificationResult: "failed",
        domVerificationFailureClass: failureClass
      },
      failureClass,
      apiFirstQuotaSuspected: true,
      domVerificationAttempted: true,
      domVerificationResult: "failed",
      domVerificationFailureClass: failureClass,
      finalQuotaClassification: failureClass === "flow_model_daily_quota_reached" ? "flow_model_daily_quota_reached" : failureClass,
      modelSubmittedByApi: task.model || "",
      refCount: taskRefCount(task),
      refsReusedForDomVerification,
      pendingRowsPreserved: true
    };
  }

	  async function prepareReferenceMediaForSubmit(task = {}) {
	    if (![FlowTaskMode.textToImage, FlowTaskMode.ingredientsToVideo, FlowTaskMode.imageToVideo, FlowTaskMode.startEndImageToVideo].includes(task.mode)) {
	      return task;
	    }
	    const submitPath = submitPathFor(task);
	    if (submitPath === "dom_first" && task.mode === FlowTaskMode.textToImage) {
	      return uploadInlineTaskRefs(task, { isHidden: false, reason: "dom_reference_prepare" });
	    }
	    if (submitPath === "dom_first") {
	      return task;
	    }
    if (submitPath === "api_first" || submitPath === "dom_fallback") {
      return uploadInlineTaskRefs(task, { isHidden: true, reason: "api_reference_prepare" });
    }
    return task;
  }

  function mergeRefMediaId(ref = {}, mediaId = "") {
    return {
      ...ref,
      mediaId: trustedMediaId(mediaId)
    };
  }

  function uploadedMediaIdsFromDomResult(result = {}) {
    const attachOutcome = result?.attachOutcome || result?.data?.attachOutcome || {};
    const steps = Array.isArray(attachOutcome?.steps) ? attachOutcome.steps : [];
    const ordered = [
      ...(Array.isArray(attachOutcome?.serializedIds) ? attachOutcome.serializedIds : []),
      ...(Array.isArray(attachOutcome?.attachedImageIds) ? attachOutcome.attachedImageIds : []),
      ...steps.flatMap((step) => [
        step?.confirmedImageId,
        step?.targetImageId,
        step?.rowImageId,
        step?.uploadedMediaId
      ])
    ];
    return [...new Set(ordered
      .map((mediaId) => mediaIdFromRef({ mediaId }))
      .filter(Boolean))];
  }

  function taskWithDomRepairMedia(task = {}, domResult = {}) {
    const uploadedIds = uploadedMediaIdsFromDomResult(domResult);
    const refIds = (Array.isArray(task.refInputs) ? task.refInputs : []).map(mediaIdFromRef).filter(Boolean);
    if (task.mode === FlowTaskMode.imageToVideo) {
      const startMediaId = uploadedIds[0] || refIds[0] || trustedTaskMediaId(task.startMediaId, task) || "";
      return {
        ...task,
        startMediaId,
        endMediaId: ""
      };
    }
    if (task.mode === FlowTaskMode.startEndImageToVideo) {
      const startMediaId = uploadedIds[0] || refIds[0] || trustedTaskMediaId(task.startMediaId, task) || "";
      const endMediaId = uploadedIds[1] || refIds[1] || trustedTaskMediaId(task.endMediaId, task) || "";
      return {
        ...task,
        startMediaId,
        endMediaId
      };
    }
    if (task.mode === FlowTaskMode.ingredientsToVideo) {
      const mediaIds = [...new Set([
        ...uploadedIds,
        ...refIds,
        ...trustedTaskMediaIds(task.mediaIds, task)
      ].filter(Boolean))];
      return mediaIds.length ? { ...task, mediaIds } : task;
    }
    return task;
  }

  async function firstInlineRef(task = {}, roles = []) {
    const refs = [
      task.startRefInput,
      task.endRefInput,
      ...(Array.isArray(task.refInputs) ? task.refInputs : [])
    ].filter((ref) => ref && typeof ref === "object");
    const wanted = new Set(roles.map((role) => String(role || "").trim()).filter(Boolean));
    for (const ref of refs) {
      if (wanted.size && !wanted.has(String(ref.role || "").trim())) continue;
      if (!mediaIdFromRef(ref) && await imageBytesFromRef(ref)) return ref;
    }
    return null;
  }

  async function uploadInlineRefForApiRepair(task, ref, index = 0) {
    if (!ref) return "";
    if (typeof flowClient.uploadImage !== "function") {
      throw new Error("API_REPAIR_UPLOAD_UNAVAILABLE");
    }
    const imageBytes = await imageBytesFromRef(ref);
    if (!imageBytes) return "";
    logger({
      type: "api_repair_media_upload_start",
      taskId: task.id,
      mode: task.mode || "",
      role: ref.role || "",
      fileName: fileNameFromRef(ref, index),
      hasDataUrl: Boolean(ref.dataUrl || ref.imageUrl || ref.mediaUrl)
    });
    const result = await flowClient.uploadImage({
      projectId: task.projectId,
      imageBytes,
      mimeType: await mimeTypeFromRef(ref),
      fileName: fileNameFromRef(ref, index),
      isHidden: true
    });
    const mediaId = trustedMediaId(result?.mediaIds?.[0]);
    if (!result?.ok || !mediaId) {
      throw new Error(result?.statusText || result?.data?.error || "API_REPAIR_UPLOAD_MISSING_MEDIA_ID");
    }
    logger({
      type: "api_repair_media_upload_ok",
      taskId: task.id,
      mode: task.mode || "",
      role: ref.role || "",
      mediaId
    });
    return mediaId;
  }

  function patchRefsWithUploadedIds(task = {}, mediaIdsByRole = {}) {
    const refInputs = Array.isArray(task.refInputs) ? task.refInputs.map((ref) => ({ ...ref })) : [];
    const patch = {};
    const patchRefListRole = (role, mediaId) => {
      if (!mediaId) return;
      const index = refInputs.findIndex((ref) => String(ref.role || "").trim() === role);
      if (index >= 0) refInputs[index] = mergeRefMediaId(refInputs[index], mediaId);
    };
    if (mediaIdsByRole.startFrameRef) {
      patch.startRefInput = mergeRefMediaId(task.startRefInput || {}, mediaIdsByRole.startFrameRef);
      patchRefListRole("startFrameRef", mediaIdsByRole.startFrameRef);
    }
    if (mediaIdsByRole.endFrameRef) {
      patch.endRefInput = mergeRefMediaId(task.endRefInput || {}, mediaIdsByRole.endFrameRef);
      patchRefListRole("endFrameRef", mediaIdsByRole.endFrameRef);
    }
    if (Array.isArray(mediaIdsByRole.ingredientsRefs) && mediaIdsByRole.ingredientsRefs.length) {
      let cursor = 0;
      for (let index = 0; index < refInputs.length; index += 1) {
        refInputs[index] = mergeRefMediaId(refInputs[index], mediaIdsByRole.ingredientsRefs[cursor] || "");
        cursor += 1;
        if (cursor >= mediaIdsByRole.ingredientsRefs.length) break;
      }
    }
    if (refInputs.length) patch.refInputs = refInputs;
    const refMediaIds = [...new Set([
      ...refInputs.map(mediaIdFromRef),
      mediaIdsByRole.startFrameRef,
      mediaIdsByRole.endFrameRef,
      ...(Array.isArray(mediaIdsByRole.ingredientsRefs) ? mediaIdsByRole.ingredientsRefs : [])
    ].map(trustedMediaId).filter(Boolean))];
    patch.refMediaIds = refMediaIds;
    return patch;
  }

  async function prepareApiRepairMedia(task = {}, domResult = {}) {
    let repaired = taskWithDomRepairMedia(task, domResult);
    const patch = {};
    const uploadedByRole = {};

    const repairedStartMediaId = trustedTaskMediaId(repaired.startMediaId, repaired);
    const repairedEndMediaId = trustedTaskMediaId(repaired.endMediaId, repaired);
    if ((repaired.mode === FlowTaskMode.imageToVideo || repaired.mode === FlowTaskMode.startEndImageToVideo) && repairedStartMediaId && repairedStartMediaId !== task.startMediaId) {
      patch.startMediaId = repairedStartMediaId;
      uploadedByRole.startFrameRef = repairedStartMediaId;
    }
    if (repaired.mode === FlowTaskMode.imageToVideo && trustedTaskMediaId(task.endMediaId, task)) {
      patch.endMediaId = "";
    }
    if ((repaired.mode === FlowTaskMode.startEndImageToVideo) && repairedEndMediaId && repairedEndMediaId !== task.endMediaId) {
      patch.endMediaId = repairedEndMediaId;
      uploadedByRole.endFrameRef = repairedEndMediaId;
    }
    if (repaired.mode === FlowTaskMode.ingredientsToVideo && Array.isArray(repaired.mediaIds) && repaired.mediaIds.length) {
      const prior = new Set(trustedTaskMediaIds(task.mediaIds, task));
      const nextIds = trustedTaskMediaIds(repaired.mediaIds, repaired);
      if (nextIds.some((id) => !prior.has(id))) {
        patch.mediaIds = nextIds;
        uploadedByRole.ingredientsRefs = nextIds.filter((id) => !prior.has(id));
      }
    }

    if ((repaired.mode === FlowTaskMode.imageToVideo || repaired.mode === FlowTaskMode.startEndImageToVideo) && !trustedTaskMediaId(repaired.startMediaId, repaired)) {
      const ref = await firstInlineRef(repaired, ["startFrameRef"]) || await firstInlineRef(repaired);
      const mediaId = await uploadInlineRefForApiRepair(repaired, ref, 0);
      if (mediaId) {
        uploadedByRole.startFrameRef = mediaId;
        patch.startMediaId = mediaId;
        repaired = { ...repaired, startMediaId: mediaId };
      }
    }

    if (repaired.mode === FlowTaskMode.startEndImageToVideo && !trustedTaskMediaId(repaired.endMediaId, repaired)) {
      const ref = await firstInlineRef({ ...repaired, startRefInput: null }, ["endFrameRef"]) || await firstInlineRef({ ...repaired, startRefInput: null });
      const mediaId = await uploadInlineRefForApiRepair(repaired, ref, 1);
      if (mediaId) {
        uploadedByRole.endFrameRef = mediaId;
        patch.endMediaId = mediaId;
        repaired = { ...repaired, endMediaId: mediaId };
      }
    }

    if (repaired.mode === FlowTaskMode.ingredientsToVideo) {
      const existing = [
        ...trustedTaskMediaIds(repaired.mediaIds, repaired),
        ...(Array.isArray(repaired.refInputs) ? repaired.refInputs.map(mediaIdFromRef).filter(Boolean) : [])
      ].filter(Boolean);
      if (!existing.length) {
        const refs = [];
        for (const ref of Array.isArray(repaired.refInputs) ? repaired.refInputs : []) {
          if (!mediaIdFromRef(ref) && await imageBytesFromRef(ref)) refs.push(ref);
        }
        const mediaIds = [];
        for (let index = 0; index < refs.length; index += 1) {
          mediaIds.push(await uploadInlineRefForApiRepair(repaired, refs[index], index));
        }
        const compactMediaIds = mediaIds.filter(Boolean);
        if (compactMediaIds.length) {
          uploadedByRole.ingredientsRefs = compactMediaIds;
        }
      }
    }

    Object.assign(patch, patchRefsWithUploadedIds(repaired, uploadedByRole));
    if (Object.keys(patch).length) {
      Object.assign(patch, {
        submitPathPreference: "api_first",
        domRepairMediaPreparedAt: new Date().toISOString()
      });
      repaired = { ...repaired, ...patch };
      ledger.updateTask(task.id, patch);
    }
    return repaired;
  }

  async function submit(task) {
    task = await prepareReferenceMediaForSubmit(task);
    const submitPath = submitPathFor(task);
    const domVideoObservationMeta = submitPath === "dom_first" && VIDEO_MODES.has(String(task.mode || ""))
      ? {
          allowStatusFeedSubmitObservation: true,
          allowStatusFeedEarlyResolve: true,
          statusFeedSubmitTimeoutMs: 120000
        }
      : {};
    if (submitPath === "dom_first") {
      let domResult;
      try {
        domResult = await submitViaDom(task, domVideoObservationMeta);
      } catch (error) {
        domResult = {
          ok: false,
          status: 0,
          error: String(error?.message || error || "DOM_SUBMIT_FAILED"),
          statusText: String(error?.message || error || "DOM_SUBMIT_FAILED"),
          data: { error: String(error?.message || error || "DOM_SUBMIT_FAILED") }
        };
      }
      if (domResult.ok || !domTaskAllowsApiRepair(task, domResult)) {
        return domResult;
      }
      logger({
        type: "dom_api_repair",
        taskId: task.id,
        mode: task.mode,
        reason: domResult.error || domResult.data?.error || "DOM_SUBMIT_FAILED"
      });
	      const apiResult = await submitViaApi(await prepareApiRepairMedia(task, domResult));
	      if (!apiResult.ok && isApiBackendFailure(apiResult)) {
	        const apiError = apiBackendErrorText(apiResult);
	        return {
	          ...apiResult,
	          error: `DOM_API_REPAIR_BACKEND_RETRYABLE: ${apiError}`,
	          data: {
	            ...(apiResult.data || {}),
	            error: `DOM_API_REPAIR_BACKEND_RETRYABLE: ${apiError}`,
	            originalError: apiResult.data?.error || apiResult.error || ""
	          },
	          repairedFromDom: true,
	          domError: domResult.error || domResult.data?.error || ""
	        };
	      }
	      return {
	        ...apiResult,
	        repairedFromDom: true,
        domError: domResult.error || domResult.data?.error || ""
      };
    }

    let apiResult = await submitViaApi(task);
    if (!apiResult.ok && isReloadable403Result(apiResult)) {
      logger({
        type: "api_403_fresh_token_retry",
        taskId: task.id,
        status: apiResult.status || 0,
        statusText: apiResult.statusText || "",
        error: resultErrorText(apiResult),
        ...taskLogFields(task)
      });
      await wait(1800);
      apiResult = await submitViaApi({
        ...task,
        batchId: freshBatchId(),
        forceFreshRecaptcha: true
      });
    }
    if (!apiResult.ok && submitPath === "api_first" && isApiFirstHardQuotaResult(apiResult)) {
      apiResult = await verifyApiFirstQuotaWithDom(task, apiResult, domVideoObservationMeta);
    }
    if (!apiResult.ok && canFallbackApiBackendToDom(task, submitPath) && isApiBackendFailure(apiResult)) {
      const apiError = apiBackendErrorText(apiResult);
      logger({
        type: "api_backend_dom_fallback",
        taskId: task.id,
        status: apiResult.status || 0,
        statusText: apiResult.statusText || "",
        error: apiError,
        ...taskLogFields(task)
      });
      if (!domSubmitter || typeof domSubmitter.submitTask !== "function") {
        const modeLabel = taskModeLabel(task);
        return {
          ...apiResult,
          error: `FLOW_API_BACKEND: API submit failed for ${modeLabel}: ${apiError}`,
          data: {
            ...(apiResult.data || {}),
            error: `FLOW_API_BACKEND: API submit failed for ${modeLabel}: ${apiError}`
          },
          fallbackFromApiBackend: false
        };
      }
      let domResult;
      try {
        domResult = await submitViaDom(task, {
          ...domVideoObservationMeta,
          submitPath: "dom_fallback",
          apiResult,
          apiBackendFallback: true,
          apiError
        });
      } catch (error) {
        domResult = {
          ok: false,
          status: 0,
          statusText: String(error?.message || error || "DOM_FALLBACK_FAILED"),
          error: String(error?.message || error || "DOM_FALLBACK_FAILED"),
          data: { error: String(error?.message || error || "DOM_FALLBACK_FAILED") }
        };
      }
      if (domResult.ok) {
        return {
          ...domResult,
          fallbackFromApiBackend: true,
          apiError
        };
      }
      const refRepairResult = await repairT2iSavedReferenceDomFallback(task, apiResult, domResult, apiError, {
        ...domVideoObservationMeta,
        apiResult
      });
      if (refRepairResult) {
        if (refRepairResult.ok) return refRepairResult;
        logger({
          type: "t2i_saved_reference_asset_row_missing",
          taskId: task.id,
          status: refRepairResult.status || 0,
          statusText: refRepairResult.statusText || "",
          error: resultErrorText(refRepairResult),
          ...taskLogFields(task)
        });
        return refRepairResult;
      }
      const combined = combinedApiDomFailure(task, apiResult, domResult);
      logger({
        type: "api_backend_dom_fallback_failed",
        taskId: task.id,
        status: combined.status,
        statusText: combined.statusText,
        apiError: combined.apiError,
        domError: combined.domError,
        error: combined.error,
        ...taskLogFields(task)
      });
      return combined;
    }
    if (apiResult.ok || submitPath !== "dom_fallback") {
      return apiResult;
    }
    if (!domSubmitter || typeof domSubmitter.submitTask !== "function") {
      return apiResult;
    }
    logger({
      type: "dom_fallback",
      taskId: task.id,
      status: apiResult.status || 0,
      statusText: apiResult.statusText || ""
    });
    return submitViaDom(task, { ...domVideoObservationMeta, apiResult });
  }

  async function pollVideoUntilTerminal(taskId, mediaIds, projectId) {
    let emptyRows = 0;
    const currentTask = ledger.getTask(taskId) || {};
    const durationSeconds = Number(currentTask.videoLength || currentTask.videoDurationSeconds || 0);
    const taskMaxPolls = Math.min(maxPolls, durationSeconds <= 4 ? 48 : durationSeconds <= 6 ? 60 : 72);
    for (let poll = 0; poll < taskMaxPolls; poll += 1) {
      await wait(pollIntervalMs);
      const beforePollTask = ledger.getTask(taskId) || {};
      if (beforePollTask.status === TaskStatus.complete || beforePollTask.status === TaskStatus.failed || beforePollTask.status === TaskStatus.blocked) {
        return beforePollTask;
      }
      const statusResult = await flowClient.pollVideoStatus({ projectId, mediaIds });
      const rows = extractVideoStatusRows(statusResult.data);
      logger({ type: "poll", taskId, poll, maxPolls: taskMaxPolls, rows });
      const beforeUpdateTask = ledger.getTask(taskId) || {};
      if (beforeUpdateTask.status === TaskStatus.complete || beforeUpdateTask.status === TaskStatus.failed || beforeUpdateTask.status === TaskStatus.blocked) {
        return beforeUpdateTask;
      }
      ledger.updateTask(taskId, {
        statusRows: rows,
        lastPollAt: new Date().toISOString()
      });
      await notifyTaskStateChange(taskId, "video_poll");
      const afterNotifyTask = ledger.getTask(taskId) || {};
      if (afterNotifyTask.status === TaskStatus.complete || afterNotifyTask.status === TaskStatus.failed || afterNotifyTask.status === TaskStatus.blocked) {
        return afterNotifyTask;
      }

      if (!rows.length) {
        emptyRows += 1;
        const current = ledger.getTask(taskId) || {};
        const domTextToVideo = String(current.mode || "") === FlowTaskMode.textToVideo
          && String(current.submitPath || current.submitPathPreference || "") === "dom_first";
        if (domTextToVideo && current.allowDomApiRepair === true && emptyRows >= 6 && current.domStatusRepairAttempted !== true) {
          logger({
            type: "dom_empty_status_api_repair",
            taskId,
            mediaIds,
            emptyRows
          });
          ledger.updateTask(taskId, {
            domStatusRepairAttempted: true,
            submitPathPreference: "api_first",
            lastError: "",
            failureClass: "",
            healAction: "",
            failureScope: ""
          });
          const repaired = await submitViaApi({ ...current, submitPathPreference: "api_first" });
          logger({ type: "submitted", taskId, result: repaired, domStatusRepair: true });
          if (!repaired.ok || !Array.isArray(repaired.mediaIds) || !repaired.mediaIds.length) {
            const failedTask = scheduler.markFailure(taskId, repaired.data?.error || repaired.statusText || repaired.error || "DOM_EMPTY_STATUS_API_REPAIR_FAILED");
            await notifyTaskStateChange(taskId, "dom_empty_status_api_repair_failed");
            return failedTask;
          }
          scheduler.markSubmitted(taskId, repaired.mediaIds);
          await notifyTaskStateChange(taskId, "dom_empty_status_api_repaired");
          return pollVideoUntilTerminal(taskId, repaired.mediaIds, projectId);
        }
        continue;
      }
      emptyRows = 0;
      const terminalRows = rows.filter((row) => row.status === "complete" || row.status === "failed");
      const completeRows = rows
        .map((row, rowIndex) => ({ row, rowIndex }))
        .filter((entry) => entry.row.status === "complete");
      const failedRows = rows.filter((row) => row.status === "failed");
      const taskSnapshot = ledger.getTask(taskId) || {};
      const expectedRows = Math.max(1, Number(taskSnapshot.repeatCount || taskSnapshot.expectedVideos || mediaIds.length || 1) || 1);
      const capturedMediaIds = [...new Set((Array.isArray(mediaIds) ? mediaIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean))];
      const capturedIdSet = new Set(capturedMediaIds);
      const capturedCompleteRows = capturedIdSet.size
        ? completeRows.filter((entry) => capturedIdSet.has(String(entry.row.id || "").trim()))
        : [];
      const allCapturedRowsTerminal = capturedIdSet.size > 0
        && rows.length >= capturedIdSet.size
        && rows
          .filter((row) => capturedIdSet.has(String(row.id || "").trim()))
          .every((row) => row.status === "complete" || row.status === "failed");
      if (terminalRows.length >= expectedRows) {
        if (!completeRows.length) {
          const failed = failedRows[0];
          const task = scheduler.markFailure(taskId, failed?.rawStatus || "MEDIA_GENERATION_FAILED");
          await notifyTaskStateChange(taskId, "video_failed");
          return task;
        }
        const outputs = completeRows.map(({ row, rowIndex }) => ({
          id: `${taskId}:${row.id || rowIndex}`,
          mediaId: row.id,
          mediaUrl: row.mediaUrl || "",
          thumbnailUrl: row.thumbnailUrl || "",
          prompt: taskSnapshot.prompt || "",
          kind: "videos",
          status: row.status,
          rawStatus: row.rawStatus,
          mediaIndex: rowIndex
        })).filter((output) => output.mediaId);
        const task = scheduler.markComplete(taskId, {
          statusRows: rows,
          outputs,
          outputMediaIds: outputs.map((output) => output.mediaId),
          foundVideos: outputs.length,
          expectedVideos: expectedRows,
          failedOutputCount: failedRows.length,
          failedOutputMediaIds: failedRows.map((row) => row.id).filter(Boolean),
          partialFailure: failedRows.length > 0
        });
        await notifyTaskStateChange(taskId, failedRows.length > 0 ? "video_partial_complete" : "video_complete");
        return task;
      }
      if (
        capturedMediaIds.length > 0 &&
        capturedMediaIds.length < expectedRows &&
        capturedCompleteRows.length > 0 &&
        allCapturedRowsTerminal
      ) {
        logger({
          type: "video_partial_captured_continue_wait",
          taskId,
          poll,
          captured: capturedMediaIds.length,
          expected: expectedRows,
          completeCaptured: capturedCompleteRows.length
        });
      }
    }
    const task = scheduler.markFailure(taskId, "VIDEO_STATUS_POLL_TIMEOUT");
    logger({ type: "poll_timeout", taskId, maxPolls: taskMaxPolls, pollIntervalMs, mediaIds });
    await notifyTaskStateChange(taskId, "video_timeout");
    return task;
  }

  return {
    async runNext() {
      const task = scheduler.nextPendingTask();
      if (!task) return null;
      return this.runTask(task.id);
    },

    async runTask(taskId, options = {}) {
      const task = ledger.getTask(taskId);
      if (!task) throw new Error(`Unknown task id: ${taskId}`);
      if (task.status !== TaskStatus.pending) return task;

      scheduler.markSubmitting(taskId);
      await notifyTaskStateChange(taskId, "submitting");
      const submittingTask = ledger.getTask(taskId) || task;
      logger({
        type: "task_start",
        taskId,
        ...taskLogFields(submittingTask)
      });
	      try {
	        const result = await submit(task);
	        logger({ type: "submitted", taskId, result });
	        const isDomFirstVideoTask = submitPathFor(task) === "dom_first" && VIDEO_MODES.has(String(task.mode || ""));
	        if (!result.ok && isModelAccessDenied(result) && canFallbackVideoModel(task)) {
          const preparedTask = ledger.getTask(taskId) || submittingTask || task;
          const fallbackModel = fallbackVideoModelForTask(preparedTask);
          const fallbackTask = { ...preparedTask, model: fallbackModel };
          logger({
            type: "model_fallback",
            taskId,
            fromModel: task.model || "",
            toModel: fallbackModel,
            reason: resultErrorText(result)
          });
          ledger.updateTask(taskId, {
            model: fallbackModel,
            modelFallbackFrom: task.model || "",
            lastError: "",
            failureClass: "",
            healAction: "",
            failureScope: ""
          });
          Object.assign(result, result.repairedFromDom
            ? {
                ...(await submitViaApi(fallbackTask)),
                repairedFromDom: true,
                domError: result.domError || ""
              }
            : await submit(fallbackTask));
          logger({ type: "submitted", taskId, result, modelFallback: true });
        }
        if (!result.ok) {
          const partialVideoMediaIds = VIDEO_MODES.has(task.mode) ? compactIds(result.mediaIds || []) : [];
          const expectedVideoCount = Math.max(1, Number(task.repeatCount || task.expectedVideos || partialVideoMediaIds.length || 1) || 1);
          const partialVideoSubmitError = resultErrorText(result);
	          const canAdoptPartialVideoSubmit = !isDomFirstVideoTask
	            && partialVideoMediaIds.length > 0
	            && partialVideoMediaIds.length < expectedVideoCount
	            && expectedVideoCount > 1
	            && /DOM_DEBUGGER_FRONTEND_NOT_UPDATED|DOM_DEBUGGER_INCOMPLETE_MEDIA_IDS/i.test(partialVideoSubmitError);
          if (canAdoptPartialVideoSubmit) {
            logger({
              type: "partial_video_submit_adopted_for_repair",
              taskId,
              reason: partialVideoSubmitError,
              mediaIds: partialVideoMediaIds,
              foundVideos: partialVideoMediaIds.length,
              expectedVideos: expectedVideoCount
            });
            scheduler.markSubmitted(taskId, partialVideoMediaIds, {
              submitOutputRows: Array.isArray(result.outputRows || result.data?.outputRows)
                ? (result.outputRows || result.data?.outputRows)
                : []
            });
            ledger.updateTask(taskId, {
              mediaIds: partialVideoMediaIds,
              expectedVideos: expectedVideoCount,
              foundVideos: partialVideoMediaIds.length,
              partialSubmitRecovered: true,
              submitObservationRecovered: true,
              submitObservationError: partialVideoSubmitError,
              lastError: "",
              failureClass: "",
              healAction: "",
              failureScope: ""
            });
            await notifyTaskStateChange(taskId, "video_partial_submit_observed");
            if (options.submitOnlyVideos === true) {
              return ledger.getTask(taskId);
            }
            return pollVideoUntilTerminal(taskId, partialVideoMediaIds, task.projectId);
          }
	          if (submitPathFor(task) === "dom_first" && result.repairedFromDom !== true && domTaskAllowsApiRepair(task, result)) {
            logger({
              type: "dom_api_repair",
              taskId: task.id,
              mode: task.mode,
              reason: result.error || result.data?.error || result.statusText || "DOM_SUBMIT_FAILED",
              stage: "runTask"
            });
            const repaired = await submitViaApi(await prepareApiRepairMedia(task, result));
            logger({ type: "submitted", taskId, result: repaired });
            if (repaired.ok) {
              result.mediaIds = repaired.mediaIds || [];
              result.ok = true;
              result.status = repaired.status || 200;
              result.data = repaired.data || {};
            } else {
              const failedTask = scheduler.markFailure(taskId, repaired.data?.error || repaired.error || repaired.statusText || `HTTP_${repaired.status}`);
              await notifyTaskStateChange(taskId, "api_repair_failed");
              return failedTask;
            }
          }
        }
        if (!result.ok) {
          const frontendProofFailed = isDomFirstVideoTask && domFrontendProofFailure(result);
          const observedTask = options.allowStatusFeedSubmitObservation === true && !isDomFirstVideoTask ? (ledger.getTask(taskId) || {}) : {};
          const observedVideoIds = observedVideoIdsForTask(observedTask);
          if (observedVideoIds.length) {
            logger({
              type: "submit_failure_adopted_from_status_feed",
              taskId,
              reason: result.data?.error || result.error || result.statusText || `HTTP_${result.status}`,
              observedMediaIds: observedVideoIds
            });
            const submitOutputRows = Array.isArray(observedTask.submitOutputRows)
              ? observedTask.submitOutputRows
              : [];
            scheduler.markSubmitted(taskId, observedVideoIds, { submitOutputRows });
            const videoTask = ledger.updateTask(taskId, {
              status: TaskStatus.generating,
              mediaIds: observedVideoIds,
              submitOutputRows,
              statusRows: Array.isArray(observedTask.statusRows) ? observedTask.statusRows : [],
              submittedAt: observedTask.submittedAt || new Date().toISOString(),
              expectedVideos: Number(task.repeatCount || observedTask.expectedVideos || observedVideoIds.length || 1) || 1,
              lastError: "",
              failureClass: "",
              healAction: "",
              failureScope: "",
              submitObservationRecovered: true,
              submitObservationError: result.data?.error || result.error || result.statusText || `HTTP_${result.status}`
            });
            await notifyTaskStateChange(taskId, "submit_observed_by_status_feed");
            return videoTask;
          }
          if (isDomFirstVideoTask) {
            clearFailedDomVideoObservation(taskId, result);
          }
          const failurePayload = result.failureClass
            ? {
                ...ledger.getTask(taskId),
                failureClass: result.failureClass,
                flowErrorCode: result.flowErrorCode || extractFlowErrorCode(resultErrorText(result)),
                apiFirstQuotaSuspected: result.apiFirstQuotaSuspected === true,
                domVerificationAttempted: result.domVerificationAttempted === true,
                domVerificationResult: result.domVerificationResult || "",
                domVerificationFailureClass: result.domVerificationFailureClass || "",
                finalQuotaClassification: result.finalQuotaClassification || "",
                refsReusedForDomVerification: result.refsReusedForDomVerification === true,
                pendingRowsPreserved: result.pendingRowsPreserved === true,
                modelSubmittedByApi: result.modelSubmittedByApi || "",
                modelVisibleInFlow: result.modelVisibleInFlow || "",
                refCount: Number(result.refCount ?? taskRefCount(ledger.getTask(taskId) || task)),
                message: result.data?.error || result.error || result.statusText || `HTTP_${result.status}`,
                error: result
              }
            : (result.data?.error || result.error || result.statusText || `HTTP_${result.status}`);
          const failedTask = scheduler.markFailure(taskId, failurePayload);
          await notifyTaskStateChange(taskId, "submit_failed");
          return failedTask;
        }

        const mediaIds = result.mediaIds || [];
        const submitOutputRows = Array.isArray(result.outputRows || result.data?.outputRows) ? (result.outputRows || result.data?.outputRows) : [];
        const verificationSuccessExtra = apiFirstDomSuccessExtra(result, task);
        scheduler.markSubmitted(taskId, mediaIds, { submitOutputRows, ...verificationSuccessExtra });
        await notifyTaskStateChange(taskId, "submitted");

        if (task.mode === FlowTaskMode.textToImage) {
          const imageTask = ledger.updateTask(taskId, {
            status: TaskStatus.generating,
            mediaIds,
            submittedAt: new Date().toISOString(),
            expectedImages: Number(task.repeatCount || 1) || 1,
            lastError: "",
            failureClass: "",
            healAction: "",
            ...verificationSuccessExtra
          });
          await notifyTaskStateChange(taskId, "image_generating");
          return imageTask;
        }

        if (!mediaIds.length && result.data?.frontSubmitObserved === true && task.mode !== FlowTaskMode.textToImage) {
          const videoTask = ledger.updateTask(taskId, {
            status: TaskStatus.generating,
            mediaIds: [],
            submitOutputRows,
            submittedAt: new Date().toISOString(),
            expectedVideos: Number(task.repeatCount || task.expectedVideos || 1) || 1,
            lastError: "",
            failureClass: "",
            healAction: "",
            submitObservationRecovered: true,
            submitObservationError: result.statusText || "DOM_DEBUGGER_FRONT_SUBMIT_OBSERVED",
            ...verificationSuccessExtra
          });
          await notifyTaskStateChange(taskId, "video_front_submit_observed");
          return videoTask;
        }

        if (!mediaIds.length) {
          const failedTask = scheduler.markFailure(taskId, "MISSING_GENERATION_IDS");
          await notifyTaskStateChange(taskId, "missing_generation_ids");
          return failedTask;
        }

        if (options.submitOnlyVideos === true) {
          const videoTask = ledger.updateTask(taskId, {
            status: TaskStatus.generating,
            mediaIds,
            submitOutputRows,
            submittedAt: new Date().toISOString(),
            expectedVideos: Number(task.repeatCount || mediaIds.length || 1) || 1,
            lastError: "",
            failureClass: "",
            healAction: "",
            ...verificationSuccessExtra
          });
          await notifyTaskStateChange(taskId, "video_generating_submit_only");
          return videoTask;
        }

        return pollVideoUntilTerminal(taskId, mediaIds, task.projectId);
      } catch (error) {
        const failedTask = scheduler.markFailure(taskId, error);
        await notifyTaskStateChange(taskId, "exception");
        return failedTask;
      }
    }
  };
}
