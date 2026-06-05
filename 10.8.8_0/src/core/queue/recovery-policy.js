export const RECOVERABLE_RECOVERY_STEPS = Object.freeze([
  "soft_reload",
  "cache_clear_reload",
  "service_worker_bypass_reload"
]);

export const HARD_STOP_FAILURE_CLASSES = Object.freeze([
  "flow_model_daily_quota_reached",
  "flow_account_quota_reached",
  "flow_model_access_denied",
  "flow_model_unavailable",
  "flow_access_or_subscription_missing",
  "unsafe_generation_policy_block"
]);

export const SIDE_EFFECT_FAILURE_CLASSES = Object.freeze([
  "upload_not_settled_after_side_effect",
  "duplicate_upload_detected",
  "backend_accepted_but_visible_card_missing",
  "download_identity_mismatch",
  "media_id_exists_reconcile_instead_of_resubmit"
]);

export const DOM_VERIFICATION_FAILURE_CLASSES = Object.freeze([
  "api_first_quota_or_recaptcha_path_suspected",
  "api_first_blocked_dom_available",
  "api_first_blocked_dom_unavailable",
  "api_first_missing_recaptcha_token",
  "api_first_model_access_denied",
  "dom_verification_composer_not_ready",
  "dom_verification_request_not_observed",
  "dom_verification_settings_failed",
  "dom_verification_flow_stale"
]);

function taxonomyEntry({
  title,
  body,
  category,
  recoverability,
  recoveryPolicy,
  surface = "card",
  queuePauses = false,
  pendingRowsPreserved = false,
  fallbackAllowed = false,
  sideEffectRetryBlocked = false,
  recommendedNextAction = "",
  supportSummaryText = ""
}) {
  return Object.freeze({
    title,
    body,
    category,
    recoverability,
    recoveryPolicy,
    surface,
    showModal: surface === "modal",
    showBanner: surface === "banner",
    showCard: surface === "card",
    queuePauses,
    pendingRowsPreserved,
    fallbackAllowed,
    sideEffectRetryBlocked,
    recommendedNextAction,
    supportSummaryText: supportSummaryText || body
  });
}

const USER_ACTION = "user_action_required";
const SAFE_RECOVERY = "safe_recovery_ladder";

export const FAILURE_TAXONOMY_REGISTRY = Object.freeze({
  flow_model_daily_quota_reached: taxonomyEntry({
    title: "Google Flow quota reached",
    body: "Google Flow says your daily quota for this model has been reached. Auto Flow generated some outputs successfully, but Google blocked more generations for this model. This is a Google Flow limit, not an Auto Flow subscription issue.",
    category: "hard_google_account_model_stop",
    recoverability: "hard_stop",
    recoveryPolicy: "hard_stop",
    surface: "modal",
    queuePauses: true,
    pendingRowsPreserved: true,
    recommendedNextAction: "Wait for quota reset, switch model, reduce repeat count, then resume later."
  }),
  flow_account_quota_reached: taxonomyEntry({
    title: "Google Flow account quota reached",
    body: "Google Flow says this account is out of available Flow credits or quota. Auto Flow cannot bypass that limit.",
    category: "hard_google_account_model_stop",
    recoverability: "hard_stop",
    recoveryPolicy: "hard_stop",
    surface: "modal",
    queuePauses: true,
    pendingRowsPreserved: true,
    recommendedNextAction: "Wait for quota reset or use a Flow account/model with available quota."
  }),
  flow_model_access_denied: taxonomyEntry({
    title: "Google Flow model access denied",
    body: "Google Flow says your account does not have permission to use this model. This is a Google Flow model/tier/API access issue, not an Auto Flow subscription issue.",
    category: "hard_google_account_model_stop",
    recoverability: "user_action_required",
    recoveryPolicy: "hard_stop",
    surface: "modal",
    queuePauses: true,
    pendingRowsPreserved: true,
    recommendedNextAction: "Choose a supported model, then switch or resume pending rows."
  }),
  flow_model_unavailable: taxonomyEntry({
    title: "Google Flow model unavailable",
    body: "Google Flow did not expose this model for the selected mode/account. Pick a currently available model before resuming.",
    category: "hard_google_account_model_stop",
    recoverability: "user_action_required",
    recoveryPolicy: "hard_stop",
    surface: "modal",
    queuePauses: true,
    pendingRowsPreserved: true,
    recommendedNextAction: "Choose a supported model for this mode."
  }),
  flow_access_or_subscription_missing: taxonomyEntry({
    title: "Google Flow access required",
    body: "Google Flow requires account access, a valid Flow session, or a Google-side subscription/tier change before this run can continue.",
    category: "hard_google_account_model_stop",
    recoverability: "user_action_required",
    recoveryPolicy: "hard_stop",
    surface: "modal",
    queuePauses: true,
    pendingRowsPreserved: true,
    recommendedNextAction: "Sign in to Flow or fix the Google Flow account access, then resume."
  }),
  unsafe_generation_policy_block: taxonomyEntry({
    title: "Google Flow safety policy blocked the prompt",
    body: "Google Flow rejected this prompt for safety/policy reasons. Auto Flow preserves the remaining rows so you can edit the prompt.",
    category: "hard_google_account_model_stop",
    recoverability: "user_edit_required",
    recoveryPolicy: "hard_stop",
    surface: "modal",
    queuePauses: true,
    pendingRowsPreserved: true,
    recommendedNextAction: "Edit the blocked prompt, then resume remaining rows."
  }),
  api_first_quota_or_recaptcha_path_suspected: taxonomyEntry({
    title: "API path quota or recaptcha suspected",
    body: "Google Flow rejected the API submit path. Auto Flow will verify the same task once through browser/DOM mode before treating it as a final quota stop.",
    category: "api_path_specific_problem",
    recoverability: "verification_required",
    recoveryPolicy: "dom_verification",
    surface: "card",
    fallbackAllowed: true,
    recommendedNextAction: "Verify once through browser/DOM mode without reuploading refs."
  }),
  api_first_blocked_dom_available: taxonomyEntry({
    title: "API path blocked, browser mode may work",
    body: "Google Flow rejected the API submit path for this model, but the browser Flow path may still work. Auto Flow can continue using browser/DOM mode.",
    category: "api_path_specific_problem",
    recoverability: "user_confirmation_required",
    recoveryPolicy: "browser_mode_available",
    surface: "modal",
    queuePauses: true,
    pendingRowsPreserved: true,
    fallbackAllowed: true,
    recommendedNextAction: "Continue remaining prompts with browser/DOM mode, or pause and export the report."
  }),
  api_first_blocked_dom_unavailable: taxonomyEntry({
    title: "API path blocked and browser verification unavailable",
    body: "Google Flow rejected the API path and Auto Flow could not safely verify the browser path. Pending rows were preserved.",
    category: "api_path_specific_problem",
    recoverability: "recoverable_browser_issue",
    recoveryPolicy: "dom_verification_recoverable",
    surface: "card",
    queuePauses: true,
    pendingRowsPreserved: true,
    recommendedNextAction: "Repair the Flow browser path, then retry browser/DOM mode once."
  }),
  api_first_missing_recaptcha_token: taxonomyEntry({
    title: "API path recaptcha token missing",
    body: "Auto Flow could not get a fresh Google Flow recaptcha token for the API path. The browser path may still work after Flow is repaired.",
    category: "api_path_specific_problem",
    recoverability: "recoverable",
    recoveryPolicy: SAFE_RECOVERY,
    surface: "card",
    fallbackAllowed: true,
    recommendedNextAction: "Repair the Flow session or switch this run to browser/DOM mode."
  }),
  api_first_model_access_denied: taxonomyEntry({
    title: "API path model access denied",
    body: "Google Flow rejected this model on the API path. If the browser Flow UI exposes a supported model, switch pending rows to that model.",
    category: "api_path_specific_problem",
    recoverability: "user_action_required",
    recoveryPolicy: "hard_stop",
    surface: "modal",
    queuePauses: true,
    pendingRowsPreserved: true,
    recommendedNextAction: "Choose a supported model."
  }),
  flow_session_heat: taxonomyEntry({
    title: "Google Flow session is hot",
    body: "Google Flow reported unusual activity, recaptcha pressure, or temporary session heat. Auto Flow is using safe repair steps.",
    category: "recoverable_flow_session_browser_issue",
    recoverability: "recoverable",
    recoveryPolicy: SAFE_RECOVERY,
    surface: "card",
    fallbackAllowed: true,
    recommendedNextAction: "Let Auto Flow repair the Flow session. If repair fails, refresh Flow and resume."
  }),
  flow_rate_limited_429: taxonomyEntry({
    title: "Google Flow rate limited the run",
    body: "Google Flow returned a generic 429. This is treated as recoverable unless Google names a hard model quota.",
    category: "recoverable_flow_session_browser_issue",
    recoverability: "recoverable",
    recoveryPolicy: SAFE_RECOVERY,
    surface: "card",
    fallbackAllowed: true,
    recommendedNextAction: "Back off briefly and retry through the recovery ladder."
  }),
  flow_unusual_activity_403: taxonomyEntry({
    title: "Google Flow unusual activity",
    body: "Google Flow reported unusual activity or recaptcha pressure. Auto Flow is not treating this as a final quota stop.",
    category: "recoverable_flow_session_browser_issue",
    recoverability: "recoverable",
    recoveryPolicy: SAFE_RECOVERY,
    surface: "card",
    fallbackAllowed: true,
    recommendedNextAction: "Let Auto Flow repair the Flow session, then retry."
  }),
  flow_recaptcha_rejected: taxonomyEntry({
    title: "Google Flow recaptcha rejected",
    body: "Google Flow rejected or could not mint a recaptcha token. Auto Flow can retry after safe browser/session repair.",
    category: "recoverable_flow_session_browser_issue",
    recoverability: "recoverable",
    recoveryPolicy: SAFE_RECOVERY,
    surface: "card",
    fallbackAllowed: true,
    recommendedNextAction: "Repair the browser Flow session and retry."
  }),
  flow_backend_500: taxonomyEntry({
    title: "Google Flow backend error",
    body: "Google Flow returned a backend 500. Auto Flow can recover or try the alternate path without hiding the original failure.",
    category: "recoverable_flow_session_browser_issue",
    recoverability: "recoverable",
    recoveryPolicy: SAFE_RECOVERY,
    surface: "card",
    fallbackAllowed: true,
    recommendedNextAction: "Use the recovery ladder or alternate submit path."
  }),
  flow_frontend_stale: taxonomyEntry({
    title: "Google Flow page is stale",
    body: "The Flow page looked stale or out of sync with the current run. Auto Flow is repairing the page before retrying.",
    category: "recoverable_flow_session_browser_issue",
    recoverability: "recoverable",
    recoveryPolicy: SAFE_RECOVERY,
    surface: "card",
    fallbackAllowed: true,
    recommendedNextAction: "Reload Flow and revalidate the bridge."
  }),
  bridge_or_pagehook_stale: taxonomyEntry({
    title: "Auto Flow page bridge is stale",
    body: "The mounted extension bridge or page hook does not match the current build. Auto Flow needs a safe reload before retrying.",
    category: "recoverable_flow_session_browser_issue",
    recoverability: "recoverable",
    recoveryPolicy: SAFE_RECOVERY,
    surface: "card",
    fallbackAllowed: true,
    recommendedNextAction: "Reload the extension and Flow tab, then retry."
  }),
  renderer_crashed: taxonomyEntry({
    title: "Google Flow tab crashed",
    body: "The Flow renderer crashed. Auto Flow can reload the project tab and retry without changing pending rows.",
    category: "recoverable_flow_session_browser_issue",
    recoverability: "recoverable",
    recoveryPolicy: SAFE_RECOVERY,
    surface: "card",
    fallbackAllowed: true,
    recommendedNextAction: "Reload the Flow project tab and retry."
  }),
  composer_not_ready: taxonomyEntry({
    title: "Google Flow composer not ready",
    body: "The Flow prompt composer was missing, unstable, or still loading. Auto Flow will repair the browser path before retrying.",
    category: "recoverable_flow_session_browser_issue",
    recoverability: "recoverable",
    recoveryPolicy: SAFE_RECOVERY,
    surface: "card",
    fallbackAllowed: true,
    recommendedNextAction: "Repair the Flow composer and retry."
  }),
  settings_not_selected: taxonomyEntry({
    title: "Google Flow settings were not selected",
    body: "Flow did not visibly accept the required model, mode, ratio, or duration settings before submit.",
    category: "recoverable_flow_session_browser_issue",
    recoverability: "recoverable",
    recoveryPolicy: SAFE_RECOVERY,
    surface: "card",
    fallbackAllowed: true,
    recommendedNextAction: "Repair settings selection and retry."
  }),
  dom_request_not_observed: taxonomyEntry({
    title: "Browser submit request not observed",
    body: "Auto Flow clicked the browser path but did not observe the expected Flow submit request. This remains recoverable, not a green DOM submit.",
    category: "recoverable_flow_session_browser_issue",
    recoverability: "recoverable",
    recoveryPolicy: SAFE_RECOVERY,
    surface: "card",
    fallbackAllowed: true,
    recommendedNextAction: "Repair the browser path and retry once."
  }),
  flow_session_heat_unresolved: taxonomyEntry({
    title: "Auto Flow could not repair this Flow issue",
    body: "Auto Flow tried safe recovery steps but Google Flow or the page still rejected the run. Pending rows were preserved.",
    category: "recoverable_flow_session_browser_issue",
    recoverability: "repair_failed",
    recoveryPolicy: SAFE_RECOVERY,
    surface: "modal",
    queuePauses: true,
    pendingRowsPreserved: true,
    recommendedNextAction: "Export the report, refresh Flow manually, then resume later."
  }),
  dom_verification_composer_not_ready: taxonomyEntry({
    title: "Browser verification composer not ready",
    body: "API-path verification could not complete because the Flow composer was not ready.",
    category: "recoverable_flow_session_browser_issue",
    recoverability: "recoverable",
    recoveryPolicy: "dom_verification_recoverable",
    surface: "card",
    fallbackAllowed: true,
    recommendedNextAction: "Repair the browser path, then retry DOM verification once."
  }),
  dom_verification_request_not_observed: taxonomyEntry({
    title: "Browser verification request not observed",
    body: "API-path verification clicked the browser path but did not observe the expected Flow submit request.",
    category: "recoverable_flow_session_browser_issue",
    recoverability: "recoverable",
    recoveryPolicy: "dom_verification_recoverable",
    surface: "card",
    fallbackAllowed: true,
    recommendedNextAction: "Repair the browser path, then retry DOM verification once."
  }),
  dom_verification_settings_failed: taxonomyEntry({
    title: "Browser verification settings failed",
    body: "API-path verification could not confirm Flow settings before submit.",
    category: "recoverable_flow_session_browser_issue",
    recoverability: "recoverable",
    recoveryPolicy: "dom_verification_recoverable",
    surface: "card",
    fallbackAllowed: true,
    recommendedNextAction: "Repair Flow settings selection, then retry DOM verification once."
  }),
  dom_verification_flow_stale: taxonomyEntry({
    title: "Browser verification Flow page stale",
    body: "API-path verification found the Flow page or bridge stale.",
    category: "recoverable_flow_session_browser_issue",
    recoverability: "recoverable",
    recoveryPolicy: "dom_verification_recoverable",
    surface: "card",
    fallbackAllowed: true,
    recommendedNextAction: "Reload Flow and revalidate the bridge before retrying."
  }),
  upload_not_settled_after_side_effect: taxonomyEntry({
    title: "Upload did not settle after side effect",
    body: "A reference upload already happened, but Flow did not visibly settle it. Auto Flow will not blindly upload it again.",
    category: "side_effect_sensitive_failure",
    recoverability: "fail_closed_or_reuse",
    recoveryPolicy: "side_effect_retry_blocked",
    surface: "card",
    sideEffectRetryBlocked: true,
    recommendedNextAction: "Reuse the existing uploaded asset or fail closed before retrying."
  }),
  duplicate_upload_detected: taxonomyEntry({
    title: "Duplicate upload risk detected",
    body: "Auto Flow detected a duplicate upload risk and blocked a blind retry.",
    category: "side_effect_sensitive_failure",
    recoverability: "fail_closed_or_reuse",
    recoveryPolicy: "side_effect_retry_blocked",
    surface: "card",
    sideEffectRetryBlocked: true,
    recommendedNextAction: "Reuse the existing uploaded asset or inspect the upload proof."
  }),
  backend_accepted_but_visible_card_missing: taxonomyEntry({
    title: "Backend accepted media but visible card is missing",
    body: "Google Flow accepted the backend request, but the current visible card was not proven. Auto Flow must reconcile/download existing media instead of resubmitting.",
    category: "side_effect_sensitive_failure",
    recoverability: "reconcile_required",
    recoveryPolicy: "reconcile_existing_media",
    surface: "card",
    sideEffectRetryBlocked: true,
    recommendedNextAction: "Reconcile by task media id or download the existing output before retrying."
  }),
  download_identity_mismatch: taxonomyEntry({
    title: "Download identity mismatch",
    body: "The media selected for download did not match the current task identity. Auto Flow blocks the wrong download.",
    category: "side_effect_sensitive_failure",
    recoverability: "reconcile_required",
    recoveryPolicy: "side_effect_retry_blocked",
    surface: "card",
    sideEffectRetryBlocked: true,
    recommendedNextAction: "Reconcile the task-owned media identity, then retry download."
  }),
  media_id_exists_reconcile_instead_of_resubmit: taxonomyEntry({
    title: "Media ID exists; reconcile instead of resubmit",
    body: "A Flow media ID already exists for this attempt. Auto Flow should reconcile or download it instead of submitting again.",
    category: "side_effect_sensitive_failure",
    recoverability: "reconcile_required",
    recoveryPolicy: "reconcile_existing_media",
    surface: "card",
    sideEffectRetryBlocked: true,
    recommendedNextAction: "Reconcile or download the existing media ID."
  }),
  character_picker_character_row_not_found: taxonomyEntry({
    title: "Flow character row not found",
    body: "The native Flow character picker did not expose a matching Character row for this handle.",
    category: "user_setup_issue",
    recoverability: USER_ACTION,
    recoveryPolicy: USER_ACTION,
    surface: "card",
    queuePauses: true,
    pendingRowsPreserved: true,
    recommendedNextAction: "Create or map the native Flow character row, then retry."
  }),
  character_picker_image_row_only: taxonomyEntry({
    title: "Only image rows found for character handle",
    body: "Flow showed image rows, not native Character rows. Auto Flow needs a real character mapping for Path C.",
    category: "user_setup_issue",
    recoverability: USER_ACTION,
    recoveryPolicy: USER_ACTION,
    surface: "card",
    queuePauses: true,
    pendingRowsPreserved: true,
    recommendedNextAction: "Use a native Flow Character row, not an image-only row."
  }),
  character_mapping_stale_project: taxonomyEntry({
    title: "Character mapping belongs to another project",
    body: "The saved Flow character mapping does not match the active Flow project.",
    category: "user_setup_issue",
    recoverability: USER_ACTION,
    recoveryPolicy: USER_ACTION,
    surface: "card",
    queuePauses: true,
    pendingRowsPreserved: true,
    recommendedNextAction: "Refresh or recreate character mappings in the active project."
  }),
  character_setup_required: taxonomyEntry({
    title: "Character setup required",
    body: "This prompt uses native character references, but the required Flow character mappings are not ready.",
    category: "user_setup_issue",
    recoverability: USER_ACTION,
    recoveryPolicy: USER_ACTION,
    surface: "card",
    queuePauses: true,
    pendingRowsPreserved: true,
    recommendedNextAction: "Complete Character setup before running this queue."
  }),
  unsupported_model_for_mode: taxonomyEntry({
    title: "Unsupported model for mode",
    body: "The selected model is not supported for this Auto Flow mode.",
    category: "user_setup_issue",
    recoverability: USER_ACTION,
    recoveryPolicy: USER_ACTION,
    surface: "card",
    queuePauses: true,
    pendingRowsPreserved: true,
    recommendedNextAction: "Choose a model supported by the selected mode."
  }),
  unknown: taxonomyEntry({
    title: "Auto Flow needs more detail",
    body: "Auto Flow could not classify this failure yet. Export the report so the raw Flow error and queue state can be inspected.",
    category: "unknown",
    recoverability: "bounded_retry",
    recoveryPolicy: "bounded_retry",
    surface: "card",
    recommendedNextAction: "Retry once. If it repeats, export the support report."
  })
});

export function failureTaxonomyForClass(failureClass = "") {
  return FAILURE_TAXONOMY_REGISTRY[String(failureClass || "").trim()] || FAILURE_TAXONOMY_REGISTRY.unknown;
}

export function failureTaxonomyForTask(task = {}) {
  return failureTaxonomyForClass(task.failureClass || task.finalQuotaClassification || "unknown");
}

export function recoveryErrorText(error) {
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

export function extractFlowErrorCode(text = "") {
  const raw = recoveryErrorText(text);
  const codes = raw.match(/PUBLIC_ERROR_[A-Z0-9_]+|PERMISSION_DENIED|RESOURCE_EXHAUSTED|COMPOSER_NOT_READY|DOM_SUBMIT_REJECTED_403|FLOW_CREDITS_BLOCK_F2V|HTTP_500/gi) || [];
  if (/recaptcha evaluation failed/i.test(raw)) codes.push("RECAPTCHA_EVALUATION_FAILED");
  if (/\b500\b/i.test(raw) && !codes.some((code) => String(code).toUpperCase() === "HTTP_500")) codes.push("HTTP_500");
  return [...new Set(codes.map((code) => String(code || "").toUpperCase()))]
    .sort((a, b) => {
      const aPublic = a.startsWith("PUBLIC_ERROR_");
      const bPublic = b.startsWith("PUBLIC_ERROR_");
      if (aPublic !== bPublic) return aPublic ? -1 : 1;
      return 0;
    })
    .join(" ");
}

export function isHardQuotaFailure(error = "") {
  const raw = recoveryErrorText(error);
  return /\b429\b/i.test(raw) &&
    /RESOURCE_EXHAUSTED/i.test(raw) &&
    /PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED/i.test(raw);
}

export function isHardStopFailureClass(failureClass = "") {
  return HARD_STOP_FAILURE_CLASSES.includes(String(failureClass || ""));
}

export function isApiFirstSubmitPath(task = {}) {
  return String(task?.submitPathPreference || task?.submitPath || "").trim() === "api_first";
}

export function isDomFirstSubmitPath(task = {}) {
  return String(task?.submitPathPreference || task?.submitPath || "").trim() === "dom_first";
}

export function hasApiFirstQuotaContext(task = {}) {
  return task?.apiFirstQuotaSuspected === true ||
    String(task?.failureClass || "") === "api_first_quota_or_recaptcha_path_suspected";
}

function knownClassPolicy(failureClass = "", context = {}) {
  const normalized = String(failureClass || "").trim();
  if (!normalized) return null;
  if (normalized === "flow_model_daily_quota_reached") return hardStopPolicy(normalized, "PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED");
  if (normalized === "flow_account_quota_reached") return hardStopPolicy(normalized, "RESOURCE_EXHAUSTED");
  if (normalized === "flow_model_access_denied") return modelAccessPolicy(normalized, "PUBLIC_ERROR_MODEL_ACCESS_DENIED");
  if (normalized === "api_first_model_access_denied") return modelAccessPolicy(normalized, "PUBLIC_ERROR_MODEL_ACCESS_DENIED");
  if (normalized === "flow_model_unavailable") return hardStopPolicy(normalized, "PUBLIC_ERROR_MODEL_ACCESS_DENIED");
  if (normalized === "flow_access_or_subscription_missing") return hardStopPolicy(normalized, "");
  if (normalized === "unsafe_generation_policy_block") return hardStopPolicy(normalized, "");
  if (SIDE_EFFECT_FAILURE_CLASSES.includes(normalized)) return sideEffectPolicy(normalized);
  if (DOM_VERIFICATION_FAILURE_CLASSES.includes(normalized)) return domVerificationPolicy(normalized, "", context);
  return null;
}

function hardStopPolicy(failureClass, flowErrorCode = "") {
  const taxonomy = failureTaxonomyForClass(failureClass);
  return {
    failureClass,
    flowErrorCode: String(flowErrorCode || "").trim(),
    recoveryPolicy: "hard_stop",
    retryable: false,
    healAction: "user_action_required",
    scope: taxonomy.category === "user_setup_issue" ? "task" : "global",
    recoveryAttempted: false,
    recoverySkippedBecauseHardQuota: failureClass === "flow_model_daily_quota_reached" || failureClass === "flow_account_quota_reached",
    recoverySkippedBecauseModelAccess: false,
    recoveryStepsAttempted: [],
    recoveryFinalOutcome: failureClass === "flow_model_daily_quota_reached" || failureClass === "flow_account_quota_reached"
      ? "blocked_hard_quota"
      : "blocked_user_action_required",
    recommendedNextAction: taxonomy.recommendedNextAction || (
      failureClass === "flow_model_daily_quota_reached" || failureClass === "flow_account_quota_reached"
        ? "Wait for quota reset, switch model, reduce repeat count, then resume later."
        : "Adjust the account, model, or prompt, then resume later."
    ),
    sideEffectRetryBlocked: false,
    mediaIdResubmitBlocked: false
  };
}

function modelAccessPolicy(failureClass = "flow_model_access_denied", flowErrorCode = "") {
  const taxonomy = failureTaxonomyForClass(failureClass);
  return {
    failureClass,
    flowErrorCode: String(flowErrorCode || "").trim(),
    recoveryPolicy: "hard_stop",
    retryable: false,
    healAction: "choose_supported_model",
    scope: "task",
    recoveryAttempted: false,
    recoverySkippedBecauseHardQuota: false,
    recoverySkippedBecauseModelAccess: true,
    recoveryStepsAttempted: [],
    recoveryFinalOutcome: "blocked_model_access",
    recommendedNextAction: taxonomy.recommendedNextAction || "Choose a supported model, then resume pending rows.",
    sideEffectRetryBlocked: false,
    mediaIdResubmitBlocked: false
  };
}

function recoverablePolicy(failureClass, flowErrorCode = "", healAction = "recover_flow_session") {
  const taxonomy = failureTaxonomyForClass(failureClass);
  return {
    failureClass,
    flowErrorCode: String(flowErrorCode || "").trim(),
    recoveryPolicy: "safe_recovery_ladder",
    retryable: true,
    healAction,
    scope: "global",
    recoveryAttempted: true,
    recoverySkippedBecauseHardQuota: false,
    recoverySkippedBecauseModelAccess: false,
    recoveryStepsAttempted: [...RECOVERABLE_RECOVERY_STEPS],
    recoveryFinalOutcome: "recovery_pending",
    recommendedNextAction: taxonomy.recommendedNextAction || "Let Auto Flow repair the Flow session. If repair fails, refresh Flow and resume.",
    sideEffectRetryBlocked: false,
    mediaIdResubmitBlocked: false
  };
}

function sideEffectPolicy(failureClass, flowErrorCode = "") {
  const taxonomy = failureTaxonomyForClass(failureClass);
  const reconcile = failureClass === "backend_accepted_but_visible_card_missing" || failureClass === "media_id_exists_reconcile_instead_of_resubmit";
  return {
    failureClass,
    flowErrorCode: String(flowErrorCode || "").trim(),
    recoveryPolicy: reconcile ? "reconcile_existing_media" : "side_effect_retry_blocked",
    retryable: false,
    healAction: reconcile ? "reconcile_or_download_existing_media" : "upload_retry_blocked_after_side_effect",
    scope: "task",
    recoveryAttempted: false,
    recoverySkippedBecauseHardQuota: false,
    recoverySkippedBecauseModelAccess: false,
    recoveryStepsAttempted: [],
    recoveryFinalOutcome: reconcile ? "reconcile_required" : "blocked_side_effect_retry",
    recommendedNextAction: taxonomy.recommendedNextAction || (reconcile
      ? "Reconcile the accepted media id or download the existing output before retrying."
      : "Do not retry blindly. Reuse the existing upload or fail closed."),
    sideEffectRetryBlocked: true,
    mediaIdResubmitBlocked: reconcile
  };
}

function domVerificationPolicy(failureClass, flowErrorCode = "", task = {}) {
  if (failureClass === "api_first_model_access_denied") return modelAccessPolicy(failureClass, flowErrorCode);
  if (failureClass === "api_first_missing_recaptcha_token") {
    const policy = recoverablePolicy(failureClass, flowErrorCode, "refresh_recaptcha_or_switch_to_dom");
    return {
      ...policy,
      recoveryPolicy: "api_first_recaptcha_recovery",
      scope: "task",
      recoveryStepsAttempted: ["fresh_recaptcha", ...RECOVERABLE_RECOVERY_STEPS],
      recoveryFinalOutcome: "api_recaptcha_recovery_pending"
    };
  }
  if (failureClass === "api_first_blocked_dom_available") {
    return {
      failureClass,
      flowErrorCode: String(flowErrorCode || "").trim(),
      recoveryPolicy: "browser_mode_available",
      retryable: false,
      healAction: "user_confirm_browser_mode",
      scope: "global",
      recoveryAttempted: true,
      recoverySkippedBecauseHardQuota: false,
      recoverySkippedBecauseModelAccess: false,
      recoveryStepsAttempted: ["dom_first_browser_verification"],
      recoveryFinalOutcome: "dom_available",
      recommendedNextAction: "Continue remaining prompts with browser/DOM mode, or pause and export the report.",
      sideEffectRetryBlocked: false,
      mediaIdResubmitBlocked: false
    };
  }

  if (failureClass === "api_first_quota_or_recaptcha_path_suspected") {
    return {
      failureClass,
      flowErrorCode: String(flowErrorCode || "").trim(),
      recoveryPolicy: "dom_verification",
      retryable: true,
      healAction: "verify_dom_path",
      scope: "task",
      recoveryAttempted: false,
      recoverySkippedBecauseHardQuota: false,
      recoverySkippedBecauseModelAccess: false,
      recoveryStepsAttempted: ["dom_first_browser_verification"],
      recoveryFinalOutcome: "dom_verification_required",
      recommendedNextAction: "Verify the same task once through browser/DOM mode before treating this as a final quota stop.",
      sideEffectRetryBlocked: false,
      mediaIdResubmitBlocked: false
    };
  }

  if (failureClass === "api_first_blocked_dom_unavailable") {
    return {
      failureClass,
      flowErrorCode: String(flowErrorCode || "").trim(),
      recoveryPolicy: "dom_verification_recoverable",
      retryable: true,
      healAction: "recover_flow_session",
      scope: "global",
      recoveryAttempted: true,
      recoverySkippedBecauseHardQuota: false,
      recoverySkippedBecauseModelAccess: false,
      recoveryStepsAttempted: ["dom_first_browser_verification", ...RECOVERABLE_RECOVERY_STEPS],
      recoveryFinalOutcome: "dom_verification_unavailable",
      recommendedNextAction: "Repair the Flow browser path, then retry browser/DOM mode once.",
      sideEffectRetryBlocked: false,
      mediaIdResubmitBlocked: false
    };
  }

  const recoverable = {
    dom_verification_composer_not_ready: ["composer_not_ready", "recover_flow_session"],
    dom_verification_request_not_observed: ["dom_request_not_observed", "recover_flow_session"],
    dom_verification_settings_failed: ["settings_not_selected", "recover_flow_session"],
    dom_verification_flow_stale: ["flow_frontend_stale", "recover_flow_session"]
  }[failureClass];
  if (recoverable) {
    const policy = recoverablePolicy(failureClass, flowErrorCode, recoverable[1]);
    return {
      ...policy,
      recoveryPolicy: "dom_verification_recoverable",
      recoveryStepsAttempted: ["dom_first_browser_verification", ...RECOVERABLE_RECOVERY_STEPS],
      recoveryFinalOutcome: "dom_verification_failed_recoverable",
      recommendedNextAction: "Repair the Flow browser path, then retry browser/DOM mode once."
    };
  }

  return domVerificationPolicy("api_first_quota_or_recaptcha_path_suspected", flowErrorCode, task);
}

export function classifyDomVerificationFailure(error = "") {
  const text = recoveryErrorText(error);
  if (isHardQuotaFailure(text)) return "flow_model_daily_quota_reached";
  if (/dom_verification_request_not_observed|dom_debugger_request_not_observed|request_not_observed/i.test(text)) {
    return "dom_verification_request_not_observed";
  }
  if (/dom_verification_composer_not_ready|composer_not_ready|composer_ready_state_failed|dom_frontend_not_ready|flow_page_loading|editor_missing|editor_unstable|create_missing|create_unstable/i.test(text)) {
    return "dom_verification_composer_not_ready";
  }
  if (/dom_verification_settings_failed|settings_not_selected|settings_state_invalid|settings_failed|settings_invalid/i.test(text)) {
    return "dom_verification_settings_failed";
  }
  if (/dom_verification_flow_stale|bridge_or_pagehook_stale|stale_bridge|stale_rejected|wrong_dist_or_version|flow_frontend_stale|frontend_not_updated|page_bridge/i.test(text)) {
    return "dom_verification_flow_stale";
  }
  return "";
}

export function classifyRecoveryPolicy(error = "") {
  const known = knownClassPolicy(error?.failureClass || error?.class || "", error || {});
  if (known) {
    const flowErrorCode = error?.flowErrorCode || extractFlowErrorCode(error);
    return { ...known, flowErrorCode: flowErrorCode || known.flowErrorCode };
  }

  const text = recoveryErrorText(error);
  const raw = text.toLowerCase();
  const flowErrorCode = extractFlowErrorCode(text);
  const explicitSubmitPath = String(error?.submitPathPreference || error?.submitPath || "").trim();
  const apiFirstQuotaSuspected = hasApiFirstQuotaContext(error);
  const domVerificationAttempted = error?.domVerificationAttempted === true;

  if (isHardQuotaFailure(text)) {
    if ((apiFirstQuotaSuspected && domVerificationAttempted) || explicitSubmitPath === "dom_first") {
      return hardStopPolicy("flow_model_daily_quota_reached", flowErrorCode);
    }
    if (explicitSubmitPath === "api_first") {
      return domVerificationPolicy("api_first_quota_or_recaptcha_path_suspected", flowErrorCode, error);
    }
    return hardStopPolicy("flow_model_daily_quota_reached", flowErrorCode);
  }
  if (/public_error_model_access_denied|model_access_denied|model access denied/i.test(text)) {
    return modelAccessPolicy("flow_model_access_denied", flowErrorCode || "PUBLIC_ERROR_MODEL_ACCESS_DENIED");
  }
  if (/missing_recaptcha_token|recaptcha token missing|missing recaptcha/i.test(text)) {
    if (explicitSubmitPath === "api_first") {
      return domVerificationPolicy("api_first_missing_recaptcha_token", flowErrorCode || "RECAPTCHA_EVALUATION_FAILED", error);
    }
    return recoverablePolicy("flow_recaptcha_rejected", flowErrorCode || "RECAPTCHA_EVALUATION_FAILED", "recover_flow_session");
  }
  const domVerificationClass = classifyDomVerificationFailure(text);
  if (apiFirstQuotaSuspected && domVerificationAttempted && domVerificationClass) {
    if (domVerificationClass === "flow_model_daily_quota_reached") {
      return hardStopPolicy("flow_model_daily_quota_reached", flowErrorCode);
    }
    return domVerificationPolicy(domVerificationClass, flowErrorCode, error);
  }
  if (/account_quota|flow_account_quota_reached|daily_limit_reached|quota reached|no credits|flow_credits_block_f2v|generating will use\s*-{2,}\s*credits/i.test(text)) {
    return hardStopPolicy("flow_account_quota_reached", flowErrorCode);
  }
  if (/model_unavailable|unsupported model|model unavailable|model not available/i.test(text)) {
    return hardStopPolicy("flow_model_unavailable", flowErrorCode);
  }
  if (/subscription|license_required|not_signed_in|access denied/i.test(text)) {
    return hardStopPolicy("flow_access_or_subscription_missing", flowErrorCode);
  }
  if (/public_error_unsafe_generation|finish_reason_input_other|unsafe_generation|safety|policy|inappropriate|prohibited|nudity|sexual/i.test(text)) {
    return hardStopPolicy("unsafe_generation_policy_block", flowErrorCode);
  }

  if (/duplicate_upload_detected/i.test(text)) return sideEffectPolicy("duplicate_upload_detected", flowErrorCode);
  if (/composer_upload_not_settled|upload_not_settled_after_side_effect|refs_uploaded_not_attached/i.test(text)) {
    return sideEffectPolicy("upload_not_settled_after_side_effect", flowErrorCode);
  }
  if (/backend accepted.*mediaid|mediaid.*visible card missing|visible card missing|request_seen_without_visible/i.test(text)) {
    return sideEffectPolicy("backend_accepted_but_visible_card_missing", flowErrorCode);
  }
  if (/media_id_exists_reconcile_instead_of_resubmit|media id exists|existing media id|mediaid.*reconcile.*resubmit/i.test(text)) {
    return sideEffectPolicy("media_id_exists_reconcile_instead_of_resubmit", flowErrorCode);
  }
  if (/download.*identity.*mismatch|downloaded_asset_not_current_row|download.*current_row|download.*mismatch/i.test(text)) {
    return sideEffectPolicy("download_identity_mismatch", flowErrorCode);
  }

  if (/flow_renderer_crashed|aw,\s*snap|something went wrong while displaying this webpage/i.test(text)) {
    return recoverablePolicy("renderer_crashed", flowErrorCode, "recover_flow_page");
  }
  if (/bridge_or_pagehook_stale|stale_bridge|stale_rejected|wrong_dist_or_version/i.test(text)) {
    return recoverablePolicy("bridge_or_pagehook_stale", flowErrorCode, "reconnect_flow");
  }
  if (/flow_frontend_stale|frontend_not_updated|gallery.*stale/i.test(text)) {
    return recoverablePolicy("flow_frontend_stale", flowErrorCode, "recover_flow_session");
  }
  if (/dom_request_not_observed|dom_debugger_request_not_observed/i.test(text)) {
    return recoverablePolicy("dom_request_not_observed", flowErrorCode, "recover_flow_session");
  }
  if (/composer_not_ready|composer_ready_state_failed|dom_frontend_not_ready|flow_page_loading/i.test(text)) {
    return recoverablePolicy("composer_not_ready", flowErrorCode, "recover_flow_session");
  }
  if (/settings_not_selected|settings_state_invalid|settings_failed|settings_invalid/i.test(text)) {
    return recoverablePolicy("settings_not_selected", flowErrorCode, "recover_flow_session");
  }
  if (/recaptcha evaluation failed|recaptcha/i.test(text)) {
    return recoverablePolicy("flow_recaptcha_rejected", flowErrorCode, "recover_flow_session");
  }
  if (/public_error_unusual_activity/i.test(text) || (/permission_denied/i.test(text) && /\b403\b/.test(text)) || /\b403\b/.test(text)) {
    return recoverablePolicy("flow_unusual_activity_403", flowErrorCode, "recover_flow_session");
  }
  if (/\b429\b/.test(text) || /too many requests/i.test(text)) {
    return recoverablePolicy("flow_rate_limited_429", flowErrorCode, "backoff");
  }
  if (/http_500|\b500\b|internal server error|internal error encountered|backend_500/i.test(text)) {
    return recoverablePolicy("flow_backend_500", flowErrorCode, "recover_flow_session");
  }
  if (/flow_session_heat|high demand|capacity|temporarily unavailable|too busy|server busy|try again later|wait and try again|resource_exhausted/i.test(raw)) {
    return recoverablePolicy("flow_session_heat", flowErrorCode, "recover_flow_session");
  }

  return {
    failureClass: "unknown",
    flowErrorCode,
    recoveryPolicy: "bounded_retry",
    retryable: true,
    healAction: "bounded_retry",
    scope: "task",
    recoveryAttempted: false,
    recoverySkippedBecauseHardQuota: false,
    recoveryStepsAttempted: [],
    recoveryFinalOutcome: "unclassified",
    recommendedNextAction: "Retry the task once. If it repeats, export the support summary.",
    sideEffectRetryBlocked: false
  };
}

function countDownloadedTasks(tasks = []) {
  const ids = new Set();
  for (const task of tasks) {
    for (const id of Array.isArray(task?.downloadedMediaIds) ? task.downloadedMediaIds : []) {
      const value = String(id || "").trim();
      if (value) ids.add(value);
    }
    for (const output of Array.isArray(task?.outputs) ? task.outputs : []) {
      if (String(output?.downloadStatus || "") !== "downloaded") continue;
      const value = String(output?.mediaId || output?.fileName || output?.filename || "").trim();
      if (value) ids.add(value);
    }
  }
  return ids.size;
}

export function buildRecoveryReportFields(task = {}, context = {}) {
  const tasks = Array.isArray(context.tasks) ? context.tasks : [];
  const hasRecoverySignal = Boolean(
    task.failureClass ||
    task.flowErrorCode ||
    task.lastError ||
    task.error ||
    task.recoveryPolicy ||
    task.recoveryAttempted === true ||
    task.recoverySkippedBecauseHardQuota === true ||
    task.recoverySkippedBecauseModelAccess === true ||
    task.sideEffectRetryBlocked === true ||
    task.mediaIdResubmitBlocked === true ||
    task.apiFirstQuotaSuspected === true ||
    task.domVerificationAttempted === true ||
    task.domVerificationResult ||
    task.finalQuotaClassification ||
    task.userFacingFailureTitle ||
    task.userFacingFailureBody
  );
  const policy = classifyRecoveryPolicy(task);
  const taxonomy = failureTaxonomyForClass(task.failureClass || policy.failureClass || "unknown");
  const completed = tasks.filter((item) => ["complete", "done"].includes(String(item?.status || ""))).length;
  const pending = tasks.filter((item) => String(item?.status || "") === "pending").length;
  const downloaded = countDownloadedTasks(tasks);
  if (!hasRecoverySignal) {
    return {
      failureClass: "",
      flowErrorCode: "",
      userFacingFailureTitle: "",
      userFacingFailureBody: "",
      recoveryPolicy: "",
      recoveryAttempted: false,
      recoverySkippedBecauseHardQuota: false,
      recoverySkippedBecauseModelAccess: false,
      recoveryStepsAttempted: [],
      recoveryFinalOutcome: "",
      completedTaskCountBeforeStop: Number(task.completedTaskCountBeforeStop ?? completed),
      downloadedCountBeforeStop: Number(task.downloadedCountBeforeStop ?? downloaded),
      pendingTaskCountAfterStop: Number(task.pendingTaskCountAfterStop ?? pending),
      recommendedNextAction: "",
      sideEffectRetryBlocked: false,
      mediaIdResubmitBlocked: false,
      autoFlowSubscriptionIssue: false,
      googleFlowAccountModelIssue: false,
      apiFirstQuotaSuspected: task.apiFirstQuotaSuspected === true,
      domVerificationAttempted: task.domVerificationAttempted === true,
      domVerificationResult: task.domVerificationResult || "",
      domVerificationFailureClass: task.domVerificationFailureClass || "",
      finalQuotaClassification: task.finalQuotaClassification || "",
      modelSubmittedByApi: task.modelSubmittedByApi || "",
      modelVisibleInFlow: task.modelVisibleInFlow || "",
      refCount: Number(task.refCount ?? Math.max(Array.isArray(task.refInputs) ? task.refInputs.length : 0, Array.isArray(task.refMediaIds) ? task.refMediaIds.length : 0)),
      refsReusedForDomVerification: task.refsReusedForDomVerification === true,
      pendingRowsPreserved: task.pendingRowsPreserved === true,
      switchedPendingRowsToDom: task.switchedPendingRowsToDom === true,
      userConfirmedSwitchToDom: task.userConfirmedSwitchToDom === true
    };
  }
  return {
    failureClass: task.failureClass || policy.failureClass,
    flowErrorCode: task.flowErrorCode || policy.flowErrorCode,
    userFacingFailureTitle: task.userFacingFailureTitle || taxonomy.title || "",
    userFacingFailureBody: task.userFacingFailureBody || taxonomy.body || "",
    recoveryPolicy: task.recoveryPolicy || policy.recoveryPolicy,
    recoveryAttempted: task.recoveryAttempted === true || policy.recoveryAttempted === true,
    recoverySkippedBecauseHardQuota: task.recoverySkippedBecauseHardQuota === true || policy.recoverySkippedBecauseHardQuota === true,
    recoverySkippedBecauseModelAccess: task.recoverySkippedBecauseModelAccess === true || policy.recoverySkippedBecauseModelAccess === true,
    recoveryStepsAttempted: Array.isArray(task.recoveryStepsAttempted) ? task.recoveryStepsAttempted : policy.recoveryStepsAttempted,
    recoveryFinalOutcome: task.recoveryFinalOutcome || policy.recoveryFinalOutcome,
    completedTaskCountBeforeStop: Number(task.completedTaskCountBeforeStop ?? completed),
    downloadedCountBeforeStop: Number(task.downloadedCountBeforeStop ?? downloaded),
    pendingTaskCountAfterStop: Number(task.pendingTaskCountAfterStop ?? pending),
    recommendedNextAction: task.recommendedNextAction || policy.recommendedNextAction,
    sideEffectRetryBlocked: task.sideEffectRetryBlocked === true || policy.sideEffectRetryBlocked === true,
    mediaIdResubmitBlocked: task.mediaIdResubmitBlocked === true || policy.mediaIdResubmitBlocked === true,
    autoFlowSubscriptionIssue: task.autoFlowSubscriptionIssue === true,
    googleFlowAccountModelIssue: ["hard_google_account_model_stop", "api_path_specific_problem"].includes(taxonomy.category),
    apiFirstQuotaSuspected: task.apiFirstQuotaSuspected === true || policy.failureClass === "api_first_quota_or_recaptcha_path_suspected",
    domVerificationAttempted: task.domVerificationAttempted === true,
    domVerificationResult: task.domVerificationResult || "",
    domVerificationFailureClass: task.domVerificationFailureClass || "",
    finalQuotaClassification: task.finalQuotaClassification || (
      policy.failureClass === "flow_model_daily_quota_reached" ? "flow_model_daily_quota_reached" : ""
    ),
    modelSubmittedByApi: task.modelSubmittedByApi || (isApiFirstSubmitPath(task) ? (task.model || "") : ""),
    modelVisibleInFlow: task.modelVisibleInFlow || "",
    refCount: Number(task.refCount ?? Math.max(Array.isArray(task.refInputs) ? task.refInputs.length : 0, Array.isArray(task.refMediaIds) ? task.refMediaIds.length : 0)),
    refsReusedForDomVerification: task.refsReusedForDomVerification === true,
    pendingRowsPreserved: task.pendingRowsPreserved === true,
    switchedPendingRowsToDom: task.switchedPendingRowsToDom === true,
    userConfirmedSwitchToDom: task.userConfirmedSwitchToDom === true
  };
}

export function buildTaskSupportSummary(task = {}, context = {}) {
  const fields = buildRecoveryReportFields(task, context);
  const rawError = task.lastError || task.error || task.reason || task.statusText || task.flowErrorCode || "";
  const version = context.version || task.version || task.appVersion || "";
  const subscriptionText = context.subscriptionStatus || context.autoFlowSubscription || (fields.autoFlowSubscriptionIssue ? "action required" : "not indicated");
  return [
    "Auto Flow Support Summary",
    `Version: ${version}`,
    `Task ID: ${task.id || ""}`,
    `Status: ${task.status || ""}`,
    `Mode: ${task.mode || ""}`,
    `Model: ${task.model || ""}`,
    `Submit path: ${task.submitPath || task.submitPathPreference || ""}`,
    `Failure: ${fields.userFacingFailureTitle || fields.failureClass || ""}`,
    `Failure class: ${fields.failureClass || ""}`,
    `User-facing reason: ${fields.userFacingFailureBody || ""}`,
    `Raw error: ${rawError}`,
    `Flow error code: ${fields.flowErrorCode || ""}`,
    `Recovery policy: ${fields.recoveryPolicy || ""}`,
    `Recovery attempted: ${fields.recoveryAttempted ? "yes" : "no"}`,
    `Recovery skipped hard quota: ${fields.recoverySkippedBecauseHardQuota ? "yes" : "no"}`,
    `Recovery skipped model access: ${fields.recoverySkippedBecauseModelAccess ? "yes" : "no"}`,
    `Recovery final outcome: ${fields.recoveryFinalOutcome || ""}`,
    `API-first quota suspected: ${fields.apiFirstQuotaSuspected ? "yes" : "no"}`,
    `DOM verification attempted: ${fields.domVerificationAttempted ? "yes" : "no"}`,
    `DOM verification result: ${fields.domVerificationResult || ""}`,
    `DOM verification failure class: ${fields.domVerificationFailureClass || ""}`,
    `Final quota classification: ${fields.finalQuotaClassification || ""}`,
    `Model submitted by API: ${fields.modelSubmittedByApi || ""}`,
    `Model visible in Flow: ${fields.modelVisibleInFlow || ""}`,
    `Reference count: ${fields.refCount}`,
    `Refs reused for DOM verification: ${fields.refsReusedForDomVerification ? "yes" : "no"}`,
    `Pending rows preserved: ${fields.pendingRowsPreserved ? "yes" : "no"}`,
    `Switched pending rows to DOM: ${fields.switchedPendingRowsToDom ? "yes" : "no"}`,
    `User confirmed switch to DOM: ${fields.userConfirmedSwitchToDom ? "yes" : "no"}`,
    `Completed before stop: ${fields.completedTaskCountBeforeStop}`,
    `Downloaded before stop: ${fields.downloadedCountBeforeStop}`,
    `Pending after stop: ${fields.pendingTaskCountAfterStop}`,
    `Recommended next action: ${fields.recommendedNextAction || ""}`,
    `Side-effect retry blocked: ${fields.sideEffectRetryBlocked ? "yes" : "no"}`,
    `Media ID resubmit blocked: ${fields.mediaIdResubmitBlocked ? "yes" : "no"}`,
    `Auto Flow subscription issue: ${fields.autoFlowSubscriptionIssue ? "yes" : "no"}`,
    `Auto Flow subscription: ${subscriptionText}`,
    `Google Flow/account/model issue: ${fields.googleFlowAccountModelIssue ? "yes" : "no"}`,
    `Last error: ${rawError}`
  ].join("\n");
}

export const RECOVERY_SIMULATION_CASES = Object.freeze([
  {
    id: "api_first_429_daily_quota",
    task: { id: "sim-api-quota", mode: "text-to-image", model: "nano_banana_pro", submitPath: "api_first", refCount: 2 },
    error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED" },
    expectedFailureClass: "api_first_quota_or_recaptcha_path_suspected"
  },
  {
    id: "api_first_429_daily_quota_dom_success",
    task: { id: "sim-api-dom-success", mode: "text-to-image", model: "nano_banana_pro", submitPath: "dom_first", failureClass: "api_first_blocked_dom_available", apiFirstQuotaSuspected: true, domVerificationAttempted: true, domVerificationResult: "success", refsReusedForDomVerification: true, pendingRowsPreserved: true },
    expectedFailureClass: "api_first_blocked_dom_available"
  },
  {
    id: "api_first_429_daily_quota_dom_same_quota",
    task: { id: "sim-api-dom-quota", mode: "text-to-image", model: "nano_banana_pro", submitPath: "dom_first", apiFirstQuotaSuspected: true, domVerificationAttempted: true },
    error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED" },
    expectedFailureClass: "flow_model_daily_quota_reached"
  },
  {
    id: "dom_first_429_daily_quota",
    task: { id: "sim-dom-quota", mode: "text-to-image", model: "nano_banana_pro", submitPath: "dom_first" },
    error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED" },
    expectedFailureClass: "flow_model_daily_quota_reached"
  },
  {
    id: "generic_429_recoverable",
    task: { id: "sim-generic-429", mode: "text-to-image", model: "nano_banana_pro", submitPath: "dom_first" },
    error: "429 too many requests",
    expectedFailureClass: "flow_rate_limited_429"
  },
  {
    id: "generic_403_recoverable",
    task: { id: "sim-generic-403", mode: "text-to-video", model: "veo3_lite_low", submitPath: "dom_first" },
    error: "403 PERMISSION_DENIED PUBLIC_ERROR_UNUSUAL_ACTIVITY",
    expectedFailureClass: "flow_unusual_activity_403"
  },
  {
    id: "model_access_denied",
    task: { id: "sim-model-access", mode: "image-to-video", model: "veo3_lite_low", submitPath: "api_first" },
    error: { code: 403, status: "PERMISSION_DENIED", message: "PUBLIC_ERROR_MODEL_ACCESS_DENIED" },
    expectedFailureClass: "flow_model_access_denied"
  },
  {
    id: "backend_500",
    task: { id: "sim-backend-500", mode: "text-to-video", model: "veo3_lite_low", submitPath: "api_first" },
    error: "HTTP_500 INTERNAL server error",
    expectedFailureClass: "flow_backend_500"
  },
  {
    id: "missing_recaptcha_token",
    task: { id: "sim-recaptcha", mode: "text-to-image", model: "nano_banana_pro", submitPath: "api_first" },
    error: "missing_recaptcha_token",
    expectedFailureClass: "api_first_missing_recaptcha_token"
  },
  {
    id: "dom_request_not_observed",
    task: { id: "sim-dom-request", mode: "text-to-image", model: "nano_banana_pro", submitPath: "dom_first" },
    error: "DOM_DEBUGGER_REQUEST_NOT_OBSERVED",
    expectedFailureClass: "dom_request_not_observed"
  },
  {
    id: "composer_not_ready",
    task: { id: "sim-composer", mode: "text-to-video", model: "veo3_lite_low", submitPath: "dom_first" },
    error: "COMPOSER_NOT_READY:create_missing,create_unstable",
    expectedFailureClass: "composer_not_ready"
  },
  {
    id: "upload_not_settled_after_side_effect",
    task: { id: "sim-upload-side-effect", mode: "image-to-video", model: "veo3_lite_low", submitPath: "dom_first" },
    error: "upload_not_settled_after_side_effect refs_uploaded_not_attached",
    expectedFailureClass: "upload_not_settled_after_side_effect"
  },
  {
    id: "backend_accepted_visible_card_missing",
    task: { id: "sim-backend-accepted", mode: "text-to-image", model: "nano_banana_pro", submitPath: "api_first", mediaIds: ["media-existing"] },
    error: "backend accepted mediaId media-existing but visible card missing",
    expectedFailureClass: "backend_accepted_but_visible_card_missing"
  },
  {
    id: "download_identity_mismatch",
    task: { id: "sim-download-mismatch", mode: "text-to-image", model: "nano_banana_pro", submitPath: "api_first" },
    error: "download identity mismatch downloaded_asset_not_current_row",
    expectedFailureClass: "download_identity_mismatch"
  },
  {
    id: "renderer_crashed",
    task: { id: "sim-renderer", mode: "text-to-video", model: "veo3_lite_low", submitPath: "dom_first" },
    error: "FLOW_RENDERER_CRASHED Aw, Snap! Something went wrong while displaying this webpage",
    expectedFailureClass: "renderer_crashed"
  },
  {
    id: "unsafe_generation_policy_block",
    task: { id: "sim-safety", mode: "text-to-image", model: "nano_banana_pro", submitPath: "api_first" },
    error: "PUBLIC_ERROR_UNSAFE_GENERATION safety policy prohibited",
    expectedFailureClass: "unsafe_generation_policy_block"
  }
]);

export function simulateRecoveryCase(caseIdOrCase, context = {}) {
  const simulation = typeof caseIdOrCase === "string"
    ? RECOVERY_SIMULATION_CASES.find((entry) => entry.id === caseIdOrCase)
    : caseIdOrCase;
  if (!simulation) throw new Error(`Unknown recovery simulation case: ${caseIdOrCase}`);
  const task = { ...(simulation.task || {}) };
  const policyInput = {
    ...task,
    ...(simulation.error && typeof simulation.error === "object" && !(simulation.error instanceof Error) ? simulation.error : {}),
    message: recoveryErrorText(simulation.error || task)
  };
  const policy = classifyRecoveryPolicy(policyInput);
  const patchedTask = {
    status: policy.recoveryPolicy === "hard_stop" ? "blocked" : (policy.retryable ? "pending" : "failed"),
    ...task,
    ...policy,
    lastError: recoveryErrorText(simulation.error || task),
    rawError: recoveryErrorText(simulation.error || task),
    ...(task.domVerificationResult ? { domVerificationResult: task.domVerificationResult } : {})
  };
  const tasks = Array.isArray(context.tasks) ? context.tasks : [
    { id: "sim-complete", status: "complete", downloadedMediaIds: ["downloaded-1"] },
    patchedTask,
    { id: "sim-pending", status: "pending" }
  ];
  const fields = buildRecoveryReportFields(patchedTask, { tasks });
  const taxonomy = failureTaxonomyForClass(fields.failureClass);
  return {
    id: simulation.id,
    failureClass: fields.failureClass,
    expectedFailureClass: simulation.expectedFailureClass || "",
    classificationMatches: !simulation.expectedFailureClass || fields.failureClass === simulation.expectedFailureClass,
    recoveryPolicy: fields.recoveryPolicy,
    healAction: patchedTask.healAction || policy.healAction || "",
    uiSurface: taxonomy.showModal ? "modal" : (taxonomy.showBanner ? "banner" : "card"),
    queuePauses: taxonomy.queuePauses || fields.recoveryPolicy === "hard_stop",
    pendingRowsPreserved: taxonomy.pendingRowsPreserved || fields.pendingRowsPreserved === true || fields.recoveryPolicy === "hard_stop",
    sideEffectRetryBlocked: fields.sideEffectRetryBlocked,
    mediaIdResubmitBlocked: fields.mediaIdResubmitBlocked,
    noUnsafeSideEffectRetry: fields.sideEffectRetryBlocked || !["upload_not_settled_after_side_effect", "duplicate_upload_detected", "backend_accepted_but_visible_card_missing", "media_id_exists_reconcile_instead_of_resubmit"].includes(fields.failureClass),
    userFacingFailureTitle: fields.userFacingFailureTitle,
    userFacingFailureBody: fields.userFacingFailureBody,
    recommendedNextAction: fields.recommendedNextAction,
    supportSummary: buildTaskSupportSummary(patchedTask, { tasks, version: context.version || "10.8.8" }),
    reportFields: fields
  };
}

export function runRecoverySimulationMatrix(context = {}) {
  return RECOVERY_SIMULATION_CASES.map((entry) => simulateRecoveryCase(entry, context));
}
