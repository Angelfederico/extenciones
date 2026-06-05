import { TaskStatus } from "./task-ledger.js";
import { buildRecoveryReportFields, classifyRecoveryPolicy } from "./recovery-policy.js";

export function queueErrorText(error) {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (typeof error === "number") return String(error);
  if (error instanceof Error) return error.message || String(error);
  const detailReasons = Array.isArray(error?.details)
    ? error.details.map((detail) => detail?.reason || detail?.status || detail?.message || "").join(" ")
    : "";
  const parts = [
    error?.failureClass,
    error?.flowErrorCode,
    error?.code,
    error?.reason,
    error?.status,
    error?.statusText,
    error?.message,
    detailReasons,
    error?.error?.code,
    error?.error?.reason,
    error?.error?.status,
    error?.error?.message,
    error?.lastError,
    error?.blockerReason
  ].map((value) => String(value || "").trim()).filter(Boolean);
  if (parts.length) return parts.join(" ");
  try {
    return JSON.stringify(error);
  } catch {
    return String(error || "");
  }
}

function isFlowSessionHeatError(raw = "") {
  const text = String(raw || "").toLowerCase();
  return text.includes("public_error_unusual_activity") ||
    text.includes("recaptcha evaluation failed") ||
    text.includes("recaptcha") ||
    (text.includes("permission_denied") && text.includes("403")) ||
    (text.includes("resource_exhausted") && text.includes("429")) ||
    (text.includes("429") && text.includes("resource_exhausted"));
}

export function isFlowRendererCrashText(raw = "") {
  const text = queueErrorText(raw).toLowerCase();
  if ((text.includes("number of requests sent exceeds the quota limit") || text.includes("quota limit")) && /error code:?\s*253/.test(text)) {
    return false;
  }
  return text.includes("flow_renderer_crashed") ||
    /aw,\s*snap!?/.test(text) ||
    text.includes("something went wrong while displaying this webpage") ||
    /error code:\s*[a-z0-9_-]+/.test(text);
}

export function flowRendererCrashErrorCode(raw = "") {
  return String(queueErrorText(raw) || "").match(/error code:\s*([a-z0-9_-]+)/i)?.[1] || "";
}

export function isFlowProjectLikeUrl(url = "") {
  try {
    const parsed = new URL(String(url || ""));
    return /(^|\.)labs\.google(?:\.com)?$/i.test(parsed.hostname)
      && /^\/fx\/(?:[^/?#]+\/)?tools\/flow\/project\/[0-9a-f-]{36}(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return /https:\/\/labs\.google(?:\.com)?\/fx\/(?:[^/?#]+\/)?tools\/flow\/project\/[0-9a-f-]{36}(?:\/|$|\?)/i.test(String(url || ""));
  }
}

export function detectFlowRendererCrashSnapshot(snapshot = {}) {
  const url = String(snapshot.url || snapshot.href || "");
  const title = String(snapshot.title || "");
  const bodyText = String(snapshot.text || snapshot.bodyText || snapshot.body || "");
  const error = String(snapshot.error || snapshot.cdpError || "");
  const combined = [title, bodyText, error].filter(Boolean).join(" ");
  const flowProjectUrl = isFlowProjectLikeUrl(url);
  const crashed = flowProjectUrl && isFlowRendererCrashText(combined);
  return {
    crashed,
    flowProjectUrl,
    class: crashed ? "flow_renderer_crashed" : "",
    retryable: crashed,
    healAction: crashed ? "recover_flow_page" : "",
    scope: crashed ? "global" : "",
    errorCode: crashed ? flowRendererCrashErrorCode(combined) : "",
    textPreview: combined.replace(/\s+/g, " ").trim().slice(0, 240)
  };
}

export function classifyQueueError(error) {
  const raw = queueErrorText(error).toLowerCase();
  const recoveryPolicy = classifyRecoveryPolicy(error);
  if (recoveryPolicy.failureClass === "api_first_quota_or_recaptcha_path_suspected") {
    return {
      class: recoveryPolicy.failureClass,
      retryable: true,
      healAction: "verify_dom_path",
      scope: "task",
      recoveryPolicy: recoveryPolicy.recoveryPolicy
    };
  }
  if (recoveryPolicy.failureClass === "flow_model_daily_quota_reached") {
    return {
      class: recoveryPolicy.failureClass,
      retryable: false,
      healAction: "user_action_required",
      scope: "global",
      recoveryPolicy: "hard_stop"
    };
  }
  if ([
    "flow_account_quota_reached",
    "flow_model_access_denied",
    "flow_model_unavailable",
    "flow_access_or_subscription_missing",
    "unsafe_generation_policy_block"
  ].includes(recoveryPolicy.failureClass)) {
    return {
      class: recoveryPolicy.failureClass,
      retryable: false,
      healAction: recoveryPolicy.healAction || "user_action_required",
      scope: recoveryPolicy.scope || "global",
      recoveryPolicy: recoveryPolicy.recoveryPolicy || "hard_stop"
    };
  }
  if (recoveryPolicy.failureClass === "api_first_missing_recaptcha_token") {
    return {
      class: recoveryPolicy.failureClass,
      retryable: true,
      healAction: recoveryPolicy.healAction || "refresh_recaptcha_or_switch_to_dom",
      scope: recoveryPolicy.scope || "task",
      recoveryPolicy: recoveryPolicy.recoveryPolicy
    };
  }
  if (recoveryPolicy.sideEffectRetryBlocked === true || ["reconcile_existing_media", "side_effect_retry_blocked"].includes(recoveryPolicy.recoveryPolicy)) {
    return {
      class: recoveryPolicy.failureClass,
      retryable: false,
      healAction: recoveryPolicy.healAction || "upload_retry_blocked_after_side_effect",
      scope: recoveryPolicy.scope || "task"
    };
  }
  if (isFlowRendererCrashText(raw)) {
    return { class: "flow_renderer_crashed", retryable: true, healAction: "recover_flow_page", scope: "global" };
  }
  if (
    recoveryPolicy.failureClass &&
    String(recoveryPolicy.failureClass).startsWith("dom_verification_")
  ) {
    return {
      class: recoveryPolicy.failureClass,
      retryable: true,
      healAction: recoveryPolicy.healAction || "recover_flow_session",
      scope: "global",
      recoveryPolicy: recoveryPolicy.recoveryPolicy
    };
  }
  if (
    raw.includes("store_direct_frame_attach_failed") ||
    raw.includes("dom_frame_ref_attach_not_persisted") ||
    raw.includes("dom_frame_upload") ||
    raw.includes("asset_file_input_not_found") ||
    raw.includes("verifyattachedrefspersisted")
  ) {
    return { class: "dom_frame_attach", retryable: false, healAction: "debugger_path_needs_attention", scope: "task" };
  }
  if (raw.includes("dom_prompt_not_persisted") || raw.includes("dom_prompt_editor_not_found")) {
    return { class: "dom_debugger", retryable: false, healAction: "debugger_path_needs_attention", scope: "task" };
  }
  if (
    raw.includes("flow_page_loading") ||
    raw.includes("dom_frontend_not_ready") ||
    raw.includes("composer_ready_state_failed") ||
    (raw.includes("composer_not_ready") && raw.includes("flow_loading")) ||
    raw.includes("message channel closed before a response was received")
  ) {
    return { class: "flow_connection", retryable: true, healAction: "reconnect_flow", scope: "global" };
  }
  if (
    raw.includes("composer_not_ready") &&
    /editor_missing|editor_unstable|create_missing|create_unstable|settings_trigger_missing|settings_trigger_unstable/.test(raw)
  ) {
    return { class: "flow_connection", retryable: true, healAction: "reconnect_flow", scope: "global" };
  }
  if (raw.includes("add_to_prompt_menuitem_not_found")) {
    return { class: "dom_ref_attach", retryable: false, healAction: "debugger_path_needs_attention", scope: "task" };
  }
  if (raw.includes("public_error_model_access_denied") || raw.includes("model_access_denied") || raw.includes("model access denied")) {
    return { class: "model_access", retryable: false, healAction: "choose_supported_model", scope: "task" };
  }
  if (isFlowSessionHeatError(raw)) {
    return { class: "flow_session_heat", retryable: true, healAction: "recover_flow_session", scope: "global" };
  }
  if (raw.includes("dom_debugger_") || raw.includes("chrome_debugger")) {
    return { class: "dom_debugger", retryable: false, healAction: "debugger_path_needs_attention", scope: "task" };
  }
  if (raw.includes("429") || raw.includes("too many requests")) {
    return { class: "rate_limit", retryable: true, healAction: "backoff", scope: "global" };
  }
  if (raw.includes("error code 253") || raw.includes("number of requests sent exceeds the quota limit")) {
    return { class: "rate_limit", retryable: true, healAction: "backoff", scope: "global" };
  }
  if (
    raw.includes("not_signed_in") ||
    raw.includes("license_required") ||
    raw.includes("usage_recording") ||
    raw.includes("daily_limit_reached") ||
    raw.includes("subscription") ||
    raw.includes("quota") ||
    raw.includes("credits")
  ) {
    return { class: "account_block", retryable: false, healAction: "account_action_required", scope: "global" };
  }
  if (
    raw.includes("high demand") ||
    raw.includes("capacity") ||
    raw.includes("temporarily unavailable") ||
    raw.includes("too busy") ||
    raw.includes("server busy") ||
    raw.includes("try again later") ||
    raw.includes("wait and try again") ||
    raw.includes("public_error_video_generation_timed_out") ||
    raw.includes("video_generation_timed_out") ||
    raw.includes("generation might be taking longer") ||
    raw.includes("resource_exhausted")
  ) {
    return { class: "flow_capacity", retryable: true, healAction: "wait_for_capacity", scope: "global" };
  }
  if (
    raw.includes("dom_api_repair_backend_retryable")
  ) {
    return { class: "flow_api_backend", retryable: true, healAction: "retry_api_repair", scope: "task" };
  }
  if (
    raw.includes("t2i_saved_reference_asset_row_missing") ||
    raw.includes("reference image missing in flow")
  ) {
    return { class: "t2i_saved_reference_asset_row_missing", retryable: false, healAction: "reupload_reference", scope: "global" };
  }
	  if (
	    raw.includes("flow_api_backend") ||
	    raw.includes("api_backend") ||
    raw.includes("http_500") ||
    raw.includes("500 internal") ||
    raw.includes("internal server error") ||
    raw.includes("internal error encountered")
  ) {
    return { class: "flow_api_backend", retryable: false, healAction: "fallback_to_dom_or_report", scope: "task" };
  }
  if (raw.includes("flow_tab_not_found") || raw.includes("missing_project_id") || raw.includes("flow_bridge_not_ready") || raw.includes("page_bridge")) {
    return { class: "flow_connection", retryable: true, healAction: "reconnect_flow", scope: "global" };
  }
  if (raw.includes("unusual") || raw.includes("permission_denied") || raw.includes("403") || raw.includes("recaptcha")) {
    return { class: "flow_session_heat", retryable: true, healAction: "recover_flow_session", scope: "global" };
  }
  if (raw.includes("public_error_unsafe_generation") || raw.includes("finish_reason_input_other")) {
    return { class: "generation_rejected_by_flow_safety", retryable: false, healAction: "needs_prompt_edit", scope: "task" };
  }
  if (raw.includes("sexual") || raw.includes("safety") || raw.includes("policy") || raw.includes("inappropriate") || raw.includes("prohibited") || raw.includes("nudity")) {
    return { class: "prompt_safety", retryable: false, healAction: "needs_prompt_edit", scope: "task" };
  }
  if (raw.includes("media_generation_status_failed") || raw.includes("generation_failed") || raw.includes("generated media failed")) {
    return { class: "generation_failed", retryable: true, healAction: "retry_generation", scope: "task" };
  }
  if (raw.includes("duplicate_upload_detected")) {
    return { class: "duplicate_upload_detected", retryable: false, healAction: "upload_retry_blocked_after_side_effect", scope: "task" };
  }
  if (raw.includes("composer_upload_not_settled")) {
    return { class: "upload_not_settled_after_side_effect", retryable: false, healAction: "upload_retry_blocked_after_side_effect", scope: "task" };
  }
  if (raw.includes("upload") || raw.includes("missing_media_id") || raw.includes("missing_generation_ids")) {
    return { class: "media_input", retryable: true, healAction: "retry_media_prepare", scope: "task" };
  }
  if (raw.includes("ref_attach") || raw.includes("asset_browser") || raw.includes("asset_row") || raw.includes("ref_not_serialized")) {
    return { class: "ref_attach", retryable: true, healAction: "api_repair_or_retry_attach", scope: "task" };
  }
  if (raw.includes("queue") && raw.includes("full")) {
    return { class: "flow_queue_full", retryable: true, healAction: "wait_for_capacity", scope: "global" };
  }
  if (raw.includes("429") || raw.includes("too many requests") || raw.includes("rate")) {
    return { class: "rate_limit", retryable: true, healAction: "backoff", scope: "global" };
  }
  return { class: "unknown", retryable: true, healAction: "bounded_retry", scope: "task" };
}

export function createScheduler({ ledger, maxAttempts = 3 } = {}) {
  if (!ledger) throw new Error("Scheduler requires a task ledger");

  return {
    nextPendingTask() {
      return ledger.listTasks().find((task) => task.status === TaskStatus.pending) || null;
    },

    markSubmitting(taskId) {
      const task = ledger.getTask(taskId);
      return ledger.updateTask(taskId, {
        status: TaskStatus.submitting,
        attempts: Number(task?.attempts || 0) + 1,
        submitAttemptStartedAt: new Date().toISOString()
      });
    },

    markSubmitted(taskId, mediaIds = [], extra = {}) {
      const task = ledger.getTask(taskId) || {};
      const mode = String(task.mode || "");
      const expected = Math.max(1, Number(task.repeatCount || mediaIds.length || 1) || 1);
      const mediaPatch = mode === "text-to-image"
        ? { foundImages: 0, expectedImages: expected }
        : (["text-to-video", "image-to-video", "start-end-image-to-video", "ingredients-to-video"].includes(mode)
            ? { foundVideos: 0, expectedVideos: expected }
            : {});
      const recoveryPatch = extra.apiFirstDomVerificationSucceeded === true
        ? {
            apiFirstQuotaSuspected: true,
            domVerificationAttempted: true,
            domVerificationResult: "success",
            domVerificationFailureClass: "",
            finalQuotaClassification: "api_first_blocked_dom_available",
            failureClass: "api_first_blocked_dom_available",
            flowErrorCode: extra.flowErrorCode || task.flowErrorCode || "PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED RESOURCE_EXHAUSTED",
            recoveryPolicy: "browser_mode_available",
            recoveryAttempted: true,
            recoverySkippedBecauseHardQuota: false,
            recoveryStepsAttempted: ["dom_first_browser_verification"],
            recoveryFinalOutcome: "dom_available",
            recommendedNextAction: "Continue remaining prompts with browser/DOM mode, or pause and export the report.",
            sideEffectRetryBlocked: false,
            healAction: "user_confirm_browser_mode",
            failureScope: "global",
            refsReusedForDomVerification: extra.refsReusedForDomVerification === true,
            pendingRowsPreserved: true,
            modelSubmittedByApi: extra.modelSubmittedByApi || task.modelSubmittedByApi || task.model || "",
            modelVisibleInFlow: extra.modelVisibleInFlow || task.modelVisibleInFlow || ""
          }
        : {};
      return ledger.updateTask(taskId, {
        status: TaskStatus.generating,
        mediaIds,
        outputMediaIds: [],
        outputs: [],
        statusRows: [],
        submitOutputRows: Array.isArray(extra.submitOutputRows) ? extra.submitOutputRows : [],
        downloadedMediaIds: [],
        skippedDownloadMediaIds: [],
        downloadErrorMediaIds: [],
        downloadedCount: 0,
        completedAt: "",
        partialFailure: false,
        failedOutputCount: 0,
        failedOutputMediaIds: [],
        ...mediaPatch,
        submittedAt: new Date().toISOString(),
        lastError: "",
        failureClass: "",
        flowErrorCode: "",
        recoveryPolicy: "",
        recoveryAttempted: false,
        recoverySkippedBecauseHardQuota: false,
        recoveryStepsAttempted: [],
        recoveryFinalOutcome: "",
        recommendedNextAction: "",
        sideEffectRetryBlocked: false,
        healAction: "",
        failureScope: "",
        ...recoveryPatch
      });
    },

    markDownloading(taskId) {
      return ledger.updateTask(taskId, {
        status: TaskStatus.downloading
      });
    },

    markComplete(taskId, patch = {}) {
      return ledger.updateTask(taskId, {
        ...patch,
        status: TaskStatus.complete,
        lastError: "",
        failureClass: "",
        flowErrorCode: "",
        recoveryPolicy: "",
        recoveryAttempted: false,
        recoverySkippedBecauseHardQuota: false,
        recoveryStepsAttempted: [],
        recoveryFinalOutcome: "",
        recommendedNextAction: "",
        sideEffectRetryBlocked: false,
        healAction: "",
        failureScope: "",
        completedAt: new Date().toISOString()
      });
    },

    markFailure(taskId, error) {
      const task = ledger.getTask(taskId);
      const errorContext = error && typeof error === "object" && !(error instanceof Error) ? error : {};
      const failureInput = { ...(task || {}), ...errorContext, message: queueErrorText(error), error };
      const failure = classifyQueueError(failureInput);
      const exhausted = Number(task?.attempts || 0) >= maxAttempts;
      const nextStatus = failure.recoveryPolicy === "hard_stop"
        ? TaskStatus.blocked
        : (failure.retryable && !exhausted ? TaskStatus.pending : TaskStatus.failed);
      const basePatch = {
        status: nextStatus,
        lastError: queueErrorText(error),
        failureClass: failure.class,
        healAction: failure.healAction,
        failureScope: failure.scope,
        recoveryPolicy: failure.recoveryPolicy || "",
        ...(failureInput.apiFirstQuotaSuspected === true ? { apiFirstQuotaSuspected: true } : {}),
        ...(failureInput.recoverySkippedBecauseModelAccess === true ? { recoverySkippedBecauseModelAccess: true } : {}),
        ...(failureInput.mediaIdResubmitBlocked === true ? { mediaIdResubmitBlocked: true } : {}),
        ...(failureInput.domVerificationAttempted === true ? { domVerificationAttempted: true } : {}),
        ...(failureInput.domVerificationResult ? { domVerificationResult: failureInput.domVerificationResult } : {}),
        ...(failureInput.domVerificationFailureClass ? { domVerificationFailureClass: failureInput.domVerificationFailureClass } : {}),
        ...(failureInput.finalQuotaClassification ? { finalQuotaClassification: failureInput.finalQuotaClassification } : {}),
        ...(failureInput.refsReusedForDomVerification === true ? { refsReusedForDomVerification: true } : {}),
        ...(failureInput.pendingRowsPreserved === true ? { pendingRowsPreserved: true } : {}),
        ...(failureInput.modelSubmittedByApi ? { modelSubmittedByApi: failureInput.modelSubmittedByApi } : {}),
        ...(failureInput.modelVisibleInFlow ? { modelVisibleInFlow: failureInput.modelVisibleInFlow } : {}),
        ...(Number.isFinite(Number(failureInput.refCount)) ? { refCount: Number(failureInput.refCount) } : {})
      };
      const reportFields = buildRecoveryReportFields({ ...(task || {}), ...basePatch }, {
        tasks: ledger.listTasks().map((item) => item.id === taskId ? { ...item, ...basePatch } : item)
      });
      return ledger.updateTask(taskId, {
        ...basePatch,
        ...reportFields
      });
    },

    markBlocked(taskId, reason) {
      const task = ledger.getTask(taskId) || {};
      const reasonContext = reason && typeof reason === "object" && !(reason instanceof Error) ? reason : {};
      const failure = classifyQueueError({ ...task, ...reasonContext, message: queueErrorText(reason), error: reason });
      const basePatch = {
        status: TaskStatus.blocked,
        lastError: queueErrorText(reason),
        failureClass: failure.class === "unknown" ? "blocked" : failure.class,
        healAction: failure.healAction || "user_action_required",
        failureScope: failure.scope || "global"
      };
      const reportFields = buildRecoveryReportFields({ ...task, ...basePatch }, {
        tasks: ledger.listTasks().map((item) => item.id === taskId ? { ...item, ...basePatch } : item)
      });
      return ledger.updateTask(taskId, {
        ...basePatch,
        ...reportFields
      });
    }
  };
}
