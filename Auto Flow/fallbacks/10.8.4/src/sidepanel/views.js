import { FLOW_MODES, STORAGE_KEY } from "./runtime-config.js";
import { LANGUAGE_OPTIONS, translate } from "./i18n.js";
import { renderControlWizard } from "./views/control-wizard.js";
import { showConfirm } from "./dialog.js";
import { buildMediaRedirectUrl, buildMediaThumbnailUrl, normalizeMediaRedirectUrl, normalizeMediaThumbnailUrl } from "../core/contracts/api.js";
import { buildGalleryItemsFromTasks, canonicalGalleryItems, deriveTaskOutputLedger, filterGalleryItemsForProject, filterUsableGalleryItems, referenceMediaIdsFromTasks } from "../core/gallery/media-ledger.js";
import { matchedReferenceIdsForPrompt } from "../core/gallery/animate-prompts.js";
import { totalSceneDuration } from "../core/gallery/scene-builder.js";

const PRO_PLANS = new Set(["pro", "team"]);
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

function el(tag, opts, ...kids) {
  const node = document.createElement(tag);
  if (opts) {
    if (opts.class) node.className = opts.class;
    if (opts.id) node.id = opts.id;
    if (opts.text != null) node.textContent = opts.text;
    if (opts.value != null) node.value = opts.value;
    if (opts.checked != null) node.checked = Boolean(opts.checked);
    if (opts.data) {
      for (const [key, value] of Object.entries(opts.data)) node.dataset[key] = value;
    }
    if (opts.style) {
      for (const [key, value] of Object.entries(opts.style)) node.style[key] = value;
    }
    if (opts.attrs) {
      for (const [key, value] of Object.entries(opts.attrs)) {
        if (value == null || value === false) continue;
        node.setAttribute(key, value === true ? "" : value);
      }
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return node;
}

const icon = (name) => el("span", { class: "material-symbols-outlined", text: name });
const clear = (root) => { while (root.firstChild) root.removeChild(root.firstChild); };

const IMAGE_REFERENCE_SLOTS = [
  ["imagePromptRefs", "Image Reference", "image"],
  ["styleRefRefs", "Style Reference", "palette"],
  ["omniRefRefs", "Character Reference", "face"]
];

const VIDEO_REFERENCE_SLOTS = [
  ["startFrameRef", "Start Frame", "first_page"],
  ["endFrameRef", "End Frame", "last_page"],
  ["ingredientsRefs", "Ingredient Refs", "deployed_code"]
];

const INGREDIENT_REFERENCE_SLOTS = [
  ["ingredientsRefs", "Ingredients", "deployed_code"]
];

const VIDEO_MODEL_OPTIONS = [
  ["veo3_lite", "Veo 3.1 - Lite"],
  ["default", "Default (Veo 3.1 - Lite [Lower Priority])"],
  ["veo3_lite_low", "Veo 3.1 - Lite [Lower Priority]"],
  ["veo3_fast", "Veo 3.1 - Fast"],
  ["veo3_fast_low", "Veo 3.1 - Fast [Lower Priority]"],
  ["veo3_quality", "Veo 3.1 - Quality"],
  ["veo2_fast", "Veo 2 - Fast"],
  ["veo2_quality", "Veo 2 - Quality"]
];

function idsFromRefs(value = "") {
  return String(value || "").split(/\s+/).map((entry) => entry.trim()).filter(Boolean);
}

function allActiveRefIds(state) {
  return Object.values(state.control.references || {}).flatMap(idsFromRefs);
}

function oneToOneBatchRefIds(state) {
  return Array.isArray(state.control.oneToOneBatchRefIds)
    ? state.control.oneToOneBatchRefIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
}

function savedReference(state, id) {
  return [
    ...(state.control?.transientReferenceItems || []),
    ...(state.referenceLibrary.savedItems || [])
  ].find((item) => item.id === id) || null;
}

function referenceRolesForMode(state) {
  if (state.control.mode === FLOW_MODES.textToImage) return ["imagePromptRefs", "styleRefRefs", "omniRefRefs"];
  if (state.control.mode === FLOW_MODES.ingredientsToVideo) return ["ingredientsRefs"];
  if (state.control.mode === FLOW_MODES.imageToVideo) return ["startFrameRef", "endFrameRef"];
  return [];
}

function mappingSourceRefIds(state) {
  const batchIds = oneToOneBatchRefIds(state);
  if (batchIds.length) return batchIds;
  return referenceRolesForMode(state).flatMap((role) => idsFromRefs(state.control.references?.[role]));
}

function mappingSourceRefs(state) {
  return mappingSourceRefIds(state)
    .map((id) => savedReference(state, id))
    .filter(Boolean);
}

function promptMapKey(_prompt, index) {
  return `line:${index}`;
}

function promptMapRows(state, prompts) {
  const promptRefMap = state.control.promptRefMap || {};
  const sourceIds = mappingSourceRefIds(state);
  const oneToOneIds = oneToOneBatchRefIds(state);
  const hasOneToOne = oneToOneIds.length > 0;
  const frameMode = state.control.mode === FLOW_MODES.imageToVideo;
  return prompts.map((prompt, index) => {
    const key = promptMapKey(prompt, index);
    const hasExplicitMap = Object.prototype.hasOwnProperty.call(promptRefMap, key);
    let effectiveIds = [];
    if (hasExplicitMap) {
      effectiveIds = Array.isArray(promptRefMap[key]) ? promptRefMap[key].filter((id) => sourceIds.includes(id)) : [];
    } else if (state.control.activeApplyMode === "match") {
      effectiveIds = matchedReferenceIdsForPrompt(prompt, sourceIds.map((id) => savedReference(state, id)).filter(Boolean), {
        limit: frameMode ? 2 : state.control.mode === FLOW_MODES.ingredientsToVideo ? 3 : 10
      });
    } else if (hasOneToOne) {
      if (frameMode && oneToOneIds.length >= prompts.length * 2) {
        effectiveIds = [oneToOneIds[index] || "", oneToOneIds[index + prompts.length] || ""].filter(Boolean);
      } else {
        effectiveIds = oneToOneIds[index] ? [oneToOneIds[index]] : [];
      }
    } else {
      effectiveIds = sourceIds;
    }
    return { key, prompt, index, effectiveIds };
  });
}

function referenceSlot(role, label, iconName, state) {
  const values = idsFromRefs(state.control.references[role]);
  const first = values.length ? savedReference(state, values[0]) : null;
  const active = Boolean(first);
  const media = active
    ? el("img", { attrs: { src: first.imageUrl || first.dataUrl || first.mediaUrl, alt: label, loading: "lazy" } })
    : icon(iconName);

  return el("div", { class: `reference-slot${active ? " has-image" : ""}` },
    el("button", {
      class: "reference-pick",
      data: { refRole: role },
      attrs: { type: "button", title: active ? `Change ${label}` : `Add ${label}` }
    },
      el("span", { class: "reference-media" }, media),
      el("span", { class: "reference-copy" },
        el("span", { class: "reference-title", text: label }),
        el("span", { class: "reference-meta", text: active ? `${values.length} image${values.length === 1 ? "" : "s"}` : "Add image" })
      )
    ),
    active ? el("button", {
      class: "reference-clear",
      data: { refClear: role },
      attrs: { type: "button", title: `Clear ${label}` }
    }, icon("close")) : null
  );
}

function modeBtn(active, mode, label, iconName) {
  return el("button", {
    class: `mode-btn${active ? " active" : ""}`,
    data: { mode },
    attrs: { type: "button" }
  }, icon(iconName), el("span", { text: label }));
}

function routeBtn(active, dataVal, label) {
  return el("button", {
    class: `route-btn${active ? " active" : ""}`,
    data: { submitPath: dataVal },
    attrs: { type: "button" }
  }, el("span", { text: label }));
}

function chip(active, dataKey, dataVal, label) {
  return el("button", {
    class: `chip${active ? " active" : ""}`,
    data: { [dataKey]: dataVal },
    attrs: { type: "button" },
    text: label
  });
}

function durationBtn(active, seconds) {
  return el("button", {
    class: `duration-btn${active ? " active" : ""}`,
    data: { videoLength: seconds },
    attrs: { type: "button" },
    text: `${seconds}s`
  });
}

// Suppress stale checkout-flow messages once the account is verified Pro.
// Messages set during sign-in/checkout (sendAccountCode, verifyAccountCode,
// openCheckout) shouldn't linger after the subscription activates — the
// PRO badge speaks for itself.
function visibleAccountMessage(state) {
  const message = state?.account?.message || "";
  if (!message) return "";
  if (hasProAccess(state) && /checkout|sign in once|signed in/i.test(message)) return "";
  return message;
}

function hasProAccess(state) {
  const account = state.account || {};
  if (account.status !== "signed_in") return false;
  if (!PRO_PLANS.has(account.plan)) return false;
  return ACTIVE_SUBSCRIPTION_STATUSES.has(account.subscriptionStatus) || account.plan === "team";
}

function hasGenerationAccess(state) {
  const account = state.account || {};
  if (hasProAccess(state)) return true;
  const usage = account.usage || {};
  return usage.allowed !== false && Number(usage.remaining || 0) > 0;
}

function formatUsageLine(account) {
  const usage = account.usage || {};
  if (usage.unlimited) return "Unlimited prompts";
  const used = Number.isFinite(Number(usage.used)) ? Number(usage.used) : 0;
  const limit = Number.isFinite(Number(usage.limit)) ? Number(usage.limit) : 10;
  return `${Math.min(used, limit)}/${limit} prompts today`;
}

function isAccountReadyForGeneration(state) {
  return state.account?.status === "signed_in" && hasGenerationAccess(state);
}

function formatResetLine(account) {
  const resetAt = account?.usage?.resetAt;
  if (!resetAt) return "Resets daily";
  const resetDate = new Date(resetAt);
  if (Number.isNaN(resetDate.getTime())) return "Resets daily";
  return `Resets ${resetDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function renderAccountGate(state) {
  const account = state.account || {};
  const locale = state.control?.presets?.language || "en";
  const hasPro = hasProAccess(state);
  const signedIn = account.status === "signed_in";
  const pendingCode = account.status === "pending_confirmation";
  const pendingCheckout = Boolean(account.pendingCheckout);
  const usage = account.usage || {};
  const used = Number.isFinite(Number(usage.used)) ? Number(usage.used) : 0;
  const limit = Number.isFinite(Number(usage.limit)) ? Number(usage.limit) : 10;
  const pct = usage.unlimited ? 100 : Math.max(0, Math.min(100, (used / limit) * 100));
  const barClass = pct >= 100 ? "critical" : pct >= 70 ? "warning" : "";

  return el("div", { id: "freemiumBanner", class: hasPro ? "" : "is-visible" },
    el("div", { class: "banner-top" },
      el("span", { class: "banner-tier" }, icon("token"), translate(hasPro ? "proPlan" : "freePlan", {}, locale)),
      el("span", { class: "banner-usage", id: "bannerUsageText", text: formatUsageLine(account) })
    ),
    el("p", { class: "auth-email-hint banner-email-hint", text: signedIn ? translate("signedInUsageVerified", {}, locale) : translate("signInRequired", {}, locale) }),
    el("div", { class: "usage-bar" },
      el("div", { class: `usage-bar-fill ${barClass}`.trim(), id: "bannerUsageBar", style: { width: `${pct}%` } })
    ),
    el("div", { id: "bannerResetTimer", style: { display: signedIn && !usage.unlimited && Number(usage.remaining || 0) <= 0 ? "block" : "none" } },
      icon("timer"),
      " Resets in ",
      el("span", { id: "bannerResetCountdown", text: formatResetLine(account).replace(/^Resets /, "") })
    ),
    el("div", { class: "banner-limits" },
      el("span", { class: "limit-item" }, icon("lock"), " 2K/4K downloads"),
      el("span", { class: "limit-item" }, icon("lock"), " 1080p/4K video"),
      el("span", { class: "limit-item" }, icon("lock"), " Multi-output (2-4)"),
      el("span", { class: "limit-item" }, icon("lock"), " Auto-download")
    ),
    el("button", { class: "banner-upgrade-btn", id: "bannerUpgradeBtn", attrs: { type: "button" } },
      icon("rocket_launch"),
      el("span", { text: translate("unlockPro", {}, locale) })
    ),
    !signedIn ? el("div", { id: "bannerAuthFlow", style: { display: "block", marginTop: "8px" } },
      el("div", { id: "bannerEmailStep", style: { display: pendingCode ? "none" : "flex", gap: "6px" } },
        el("input", { id: "bannerEmailInput", attrs: { type: "email", placeholder: "your@email.com", autocomplete: "email" } }),
        el("button", { id: "bannerSendCodeBtn", attrs: { type: "button" } }, el("span", { class: "auth-send-code-label", text: translate("sendCode", {}, locale) }))
      ),
      el("div", { id: "bannerOtpStep", style: { display: pendingCode ? "block" : "none", marginTop: "6px" } },
        el("p", { class: "auth-email-hint", text: translate("checkEmail", {}, locale) }),
        el("div", { style: { display: "flex", gap: "6px" } },
          el("input", { id: "bannerOtpInput", attrs: { type: "text", placeholder: translate("enterCode", {}, locale), maxlength: "10", autocomplete: "one-time-code", inputmode: "numeric" } }),
          el("button", { id: "bannerVerifyBtn", attrs: { type: "button" }, text: translate("verify", {}, locale) })
        )
      )
    ) : null
  );
}

function referenceSlotsForMode(state) {
  if (state.control.mode === FLOW_MODES.ingredientsToVideo) return INGREDIENT_REFERENCE_SLOTS;
  if (state.control.mode === FLOW_MODES.imageToVideo) return VIDEO_REFERENCE_SLOTS;
  if (state.control.mode === FLOW_MODES.textToImage) return IMAGE_REFERENCE_SLOTS;
  return [];
}

function buildStatusText(state, pending, submitted) {
  if (state.runtime.error) return state.runtime.error;
  if (state.queue.running) return `Running ${submitted || pending} job${submitted + pending === 1 ? "" : "s"}`;
  if (state.runtime.connected) return state.runtime.projectId ? `Connected to ${state.runtime.projectId}` : "Connected to Flow";
  return "Capture a Flow project tab to run the queue.";
}

export function renderControl(root, state, actions = {}) {
  // 10.8 wizard surface — Phase C. Replaces the legacy single-page Control layout.
  // Lifted from design-preview/variant-e.html via /plan-design-review and locked in /plan-eng-review.
  // Legacy renderControl logic preserved below the early-return for reference / rollback.
  renderControlWizard(root, state, {
    dispatch: makeWizardDispatch(state),
    showConfirm,
    onRun: actions.onRun,
    onAddToQueue: actions.onAddToQueue,
    onStartQueue: actions.onStartQueue,
  });
  return;

  // ── Legacy single-page Control rendering (unreachable while wizard is active) ── @i18n-skip
  clear(root);
  const pending = state.queue.items.filter((item) => item.status === "pending" || item.status === "waiting").length;
  const submitted = state.queue.items.filter((item) => item.status === "submitted" || item.status === "submitting" || item.status === "generating").length;
  const accountLocked = !isAccountReadyForGeneration(state);
  const refs = referenceSlotsForMode(state);
  const prompts = promptLines(state);
  const activeRefs = mappingSourceRefIds(state).length;
  const promptMapEnabled = Boolean(state.control.presets.mapLineRefs);
  const queueGroupCount = queueGroups(state.queue.items).length;
  const mappedRows = promptMapRows(state, prompts).filter((row) => row.effectiveIds.length > 0).length;
  const openInlineHelp = String(state.ui.openInlineHelpPanel || "");

  const modeSection = el("div", { id: "modeSelectionContainer", class: "mode-selection-container" },
    el("div", { id: "modeButtonGrid", class: "mode-button-grid" },
      modeBtn(state.control.mode === FLOW_MODES.textToImage, FLOW_MODES.textToImage, "Create Image", "palette"),
      modeBtn(state.control.mode === FLOW_MODES.textToVideo, FLOW_MODES.textToVideo, "Text to Video", "videocam"),
      modeBtn(state.control.mode === FLOW_MODES.imageToVideo, FLOW_MODES.imageToVideo, "Frame to Video", "image"),
      modeBtn(state.control.mode === FLOW_MODES.ingredientsToVideo, FLOW_MODES.ingredientsToVideo, "Ingredients", "grid_view")
    ),
    el("select", { id: "modeSelector", style: { display: "none" } },
      [
        [FLOW_MODES.textToVideo, "Text-to-Video"],
        [FLOW_MODES.imageToVideo, "Frame-to-Video"],
        [FLOW_MODES.ingredientsToVideo, "Ingredients to Video"],
        [FLOW_MODES.textToImage, "Create Image"]
      ].map(([value, label]) => el("option", { value, attrs: { value, selected: state.control.mode === value ? "selected" : null }, text: label }))
    )
  );

  const activeVideoLength = state.control.mode === FLOW_MODES.ingredientsToVideo ? "8" : (state.control.presets.videoLength || "6");
  const durationChoices = state.control.mode === FLOW_MODES.ingredientsToVideo ? ["8"] : ["4", "6", "8"];
  const videoDurationSection = state.control.mode !== FLOW_MODES.textToImage ? el("div", { id: "videoDurationSettingsRow", class: "video-duration-settings" },
    el("span", { class: "video-duration-label", text: "Video Length" }),
    el("div", { id: "videoDurationButtonRow", class: "duration-button-row" },
      durationChoices.map((seconds) => durationBtn(activeVideoLength === seconds, seconds))
    ),
    el("input", { id: "videoDurationSecondsInput", value: activeVideoLength, attrs: { type: "hidden" } })
  ) : null;

  const routeSection = el("div", { id: "submitRouteSettingsRow", class: "video-duration-settings submit-route-settings" },
    el("span", { class: "video-duration-label", text: "Submit Route" }),
    el("div", { id: "submitRouteButtonRow", class: "route-button-row" },
      routeBtn(state.control.presets.submitPath === "dom_first", "dom_first", "DOM"),
      routeBtn(state.control.presets.submitPath === "api_first", "api_first", "API")
    )
  );

  const hiddenCaptureButton = el("button", {
    id: "captureButton",
    class: "hidden-flow-capture",
    attrs: { type: "button", "aria-hidden": "true", tabindex: "-1" }
  }, "Capture Flow Project");

  const referenceSection = el("div", { id: "referenceImagesSection", class: "reference-library-section" },
    el("div", { class: "section-header collapsible-header" },
      el("span", { class: "section-title", text: "Reference Library" }),
      el("span", { id: "refImageCount", class: "sample-link", text: `(${(state.referenceLibrary.savedItems || []).length} saved)` }),
      el("button", { id: "uploadRefImageBtn", attrs: { type: "button" } }, icon("add_photo_alternate"), el("span", { text: "Add to library" })),
      icon("expand_more")
    ),
    el("input", { id: "refImageInput", attrs: { type: "file", accept: ".png,.jpg,.jpeg,.webp,.heic,.avif", multiple: true, hidden: true } }),
    el("input", { id: "imageInput", attrs: { type: "file", accept: ".png,.jpg,.jpeg,.webp,.heic,.avif", multiple: true, hidden: true } }),
    state.control.mode === FLOW_MODES.imageToVideo ? el("p", { id: "frameHint", class: "setting-hint compact-ref-hint", text: "1st image = First Frame, 2nd image = Last Frame (optional)" }) : null,
    refs.length ? el("div", { class: "active-reference-summary" },
      icon("checklist"),
      el("span", { text: activeRefs ? `${activeRefs} active reference${activeRefs === 1 ? "" : "s"}` : "Click library images to activate references for this mode." })
    ) : null,
    renderReferenceLibraryGrid(state)
  );

  const inputSection = el("div", { id: "promptContainer", class: "control-section input-container" },
    el("div", { class: "section-label", text: "Input" }),
    el("div", { class: "prompt-input-toolbar" },
      el("div", { class: "prompt-input-title" },
        el("span", { text: "Prompt List" }),
        el("a", { class: "sample-link", attrs: { href: "/sample_prompt_formats.txt", target: "_blank", rel: "noopener noreferrer", id: "samplePromptLink" }, text: "(Sample .txt file)" })
      ),
      el("button", { id: "uploadPromptButton", class: "small-btn", attrs: { type: "button" } }, icon("upload_file"), el("span", { text: "Import file (.txt)" })),
      el("input", { id: "fileInput", attrs: { type: "file", accept: ".txt,text/plain", hidden: true } })
    ),
    el("div", { id: "imageModeContainer", class: "queue-image-upload-row" },
      el("div", { class: "queue-image-upload-copy" },
        el("span", { class: "queue-image-upload-title", text: "Queue Images" })
      ),
      el("div", { class: "image-upload-row" },
        el("button", { id: "uploadImageButton", class: "image-upload-option", attrs: { type: "button" } }, icon("upload_file"), el("span", { text: "Shared Ref Upload" })),
        el("button", { id: "imageMultiPromptHelpBtn", class: "image-inline-help", attrs: { type: "button", title: "How Shared Ref Upload works" }, text: "?" }),
        el("button", { id: "uploadImageOneTimeButton", class: "image-upload-option one-to-one", attrs: { type: "button" } }, icon("bolt"), el("span", { text: "1:1 Batch Upload" })),
        el("button", { id: "imageOneTimeHelpBtn", class: "image-inline-help", attrs: { type: "button", title: "How 1:1 Batch Upload works" }, text: "?" })
      ),
      el("div", { class: "summary-wrapper", style: { display: oneToOneBatchRefIds(state).length ? "flex" : "none" } },
        el("p", { id: "imageFileSummary" }, "Selected: ", el("span", { id: "imageCount", text: String(oneToOneBatchRefIds(state).length) }))
      ),
      el("div", { id: "imageMultiPromptHelpPanel", class: `image-help-panel${openInlineHelp === "imageMultiPromptHelpPanel" ? " open" : ""}`, text: "Same image(s) used as reference for all prompts. Upload once, every prompt gets the same ref. Great for a consistent style or subject across a batch." }),
      el("div", { class: "image-bulk-controls" },
        el("span", { class: "image-bulk-toggle-text", text: "Bulk mode: 1 image per prompt (line order)" }),
        el("label", { class: "image-bulk-switch", attrs: { for: "imageToVideoBulkToggle" } },
          el("input", { id: "imageToVideoBulkToggle", checked: oneToOneBatchRefIds(state).length > 0, attrs: { type: "checkbox" } }),
          el("span", { class: "image-bulk-switch-slider" })
        ),
        el("button", { id: "imageBulkHelpBtn", class: "image-inline-help", attrs: { type: "button", title: "How bulk mode works" }, text: "?" })
      ),
      el("div", { class: "image-bulk-controls" },
        el("span", { class: "image-bulk-toggle-text", text: "Repeat first prompt for all uploaded images" }),
        el("label", { class: "image-bulk-switch", attrs: { for: "imageSamePromptToggle" } },
          el("input", { id: "imageSamePromptToggle", attrs: { type: "checkbox" } }),
          el("span", { class: "image-bulk-switch-slider" })
        ),
        el("button", { id: "imageSamePromptHelpBtn", class: "image-inline-help", attrs: { type: "button", title: "How same-prompt mode works" }, text: "?" })
      ),
      el("div", { id: "imageBulkHelpPanel", class: `image-help-panel${openInlineHelp === "imageBulkHelpPanel" ? " open" : ""}`, text: "Bulk mode maps prompt line 1 to image 1, line 2 to image 2, and so on." }),
      el("div", { id: "imageOneTimeHelpPanel", class: `image-help-panel${openInlineHelp === "imageOneTimeHelpPanel" ? " open" : ""}`, text: "Each image maps to one prompt in order: image 1 -> prompt 1, image 2 -> prompt 2. Images are also tracked as a 1:1 batch." }),
      el("div", { id: "imageSamePromptHelpPanel", class: `image-help-panel${openInlineHelp === "imageSamePromptHelpPanel" ? " open" : ""}`, text: "When enabled, the first prompt is repeated for every uploaded image." })
    ),
    referenceSection,
    renderWorkflowHint(),
    el("textarea", {
      id: "prompts",
      class: "prompt-textarea",
      value: state.control.livePrompt,
      attrs: { rows: "5", placeholder: "One prompt per line." }
    }),
    el("div", { class: "prompt-map-controls" },
      el("label", { class: "prompt-map-toggle", attrs: { for: "promptMapToggle" } },
        el("input", { id: "promptMapToggle", checked: promptMapEnabled, attrs: { type: "checkbox" } }),
        el("span", { text: "Map references by prompt" })
      ),
      el("button", { id: "promptMapHelpBtn", class: "prompt-map-help-btn", attrs: { type: "button", title: "How mapping works" }, text: "?" }),
      el("span", { id: "promptInlineSummary", text: `${prompts.length} prompts \u2022 ${activeRefs} refs active \u2022 ${mappedRows} mapped` })
    ),
    el("div", { id: "promptMapHelpPanel", class: "prompt-map-help-panel", style: { display: state.control.promptMapOpen ? "block" : "none" }, text: "Activate one or more reference images, paste your prompts, then use mapped rows to control which refs attach to each prompt." }),
    renderPromptAssignList(state, prompts),
    el("div", { class: "prompt-queue-actions" },
      el("button", {
        id: "addToQueueButton",
        class: "button-primary",
        attrs: { type: "button", disabled: accountLocked ? "disabled" : null }
      }, icon("add_to_queue"), el("span", { text: "Add to Queue" })),
      el("button", { id: "openQueueButton", attrs: { type: "button" } },
        icon("list_alt"),
        el("span", { text: "Manage" }),
        el("span", { class: "queue-count-pill" }, "(", el("span", { id: "queueTaskCount", text: String(queueGroupCount) }), ")")
      )
    )
  );

  const queueSection = el("div", { class: "control-section" },
    el("div", { class: "section-label", text: "Queue" }),
    el("div", { class: "queue-controls" },
      el("button", { id: "clearQueueButton", attrs: { type: "button", title: "Clear queue", disabled: state.queue.running ? "disabled" : null } }, icon("delete_sweep"))
    ),
    renderQueueList(state.queue.items),
    el("div", { class: "auto-toggles-row" },
      el("label", { class: "auto-toggle-pill", attrs: { for: "autoStartNextJob" } },
        el("input", { id: "autoStartNextJob", checked: state.control.presets.autoStartNextJob, attrs: { type: "checkbox" } }),
        el("span", { text: "Auto-start next job in queue" })
      ),
      el("label", { class: "auto-toggle-pill", attrs: { for: "autoRetryFailedToggle" } },
        el("input", { id: "autoRetryFailedToggle", checked: state.control.presets.autoRetryFailedUntilZero, attrs: { type: "checkbox" } }),
        el("span", { text: "Auto retry failed until 0 (max 12 rounds)" })
      )
    )
  );

  const actionControls = el("div", { class: "action-controls" },
    el("div", { id: "startControlContainer" },
      el("button", {
        id: "mainActionButton",
        class: "button-primary",
        attrs: { type: "button", disabled: state.queue.running || accountLocked ? "disabled" : null, title: "Start Queue" }
      }, icon("play_arrow"), el("span", { text: state.queue.running ? "Running" : "Start Queue" })),
      el("button", { id: "startNewProjectButton", style: { display: "none" }, attrs: { type: "button" }, text: "Start New Project" }),
      el("button", { id: "startCurrentProjectButton", style: { display: "none" }, attrs: { type: "button" }, text: "Start Current Project" })
    ),
    el("button", { id: "skipJobButton", attrs: { type: "button", title: "Skip to next job", disabled: state.queue.running ? null : "disabled" } }, icon("skip_next"), el("span", { text: "Skip" })),
    el("button", { id: "stopButton", attrs: { type: "button", disabled: state.queue.running ? null : "disabled" } }, icon("stop"), el("span", { text: "Stop" }))
  );

  root.append(hiddenCaptureButton, modeSection, videoDurationSection, routeSection, renderAccountGate(state), inputSection, queueSection, actionControls);
}

export function renderHistory(root, state) {
  clear(root);
  const locale = state.control?.presets?.language || "en";
  const runs = Array.isArray(state.history?.runs) ? state.history.runs : [];
  root.append(
    el("div", { class: "history-view" },
      el("div", { class: "history-head" },
        el("div", null,
          el("div", { class: "section-label", text: "History" }),
          el("h2", { text: translate("pastPromptRuns", {}, locale) }),
          el("p", { text: translate("restoreRunHelp", {}, locale) })
        ),
        el("button", {
          id: "history-clear-btn",
          attrs: { type: "button", disabled: runs.length ? null : "disabled" }
        }, icon("delete_sweep"), el("span", { text: "Clear" }))
      ),
      runs.length
        ? el("div", { class: "history-list" }, runs.map((run) => renderHistoryCard(run, locale)))
        : el("div", { class: "history-empty" },
          icon("history"),
          el("strong", { text: translate("noPromptHistoryYet", {}, locale) }),
          el("span", { text: translate("autoFlowSaveHint", {}, locale) })
        )
    )
  );
}

function renderHistoryCard(run = {}, locale = "en") {
  // 3-row layout for scannability:
  //   1. Mode icon + label · count   |   time + route pill
  //   2. Prompt preview (prominent, not italic)
  //   3. Refs pill / thumbs   |   actions (Edit, Run again, Delete)
  //
  // Mode-specific accent colors via modeAccentClass help the eye pick out
  // entry types at a glance — gold for images, blue for video, purple
  // for ingredients.
  const refs = Array.isArray(run.refs) ? run.refs : [];
  const prompts = String(run.promptsText || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const promptCount = run.promptCount || prompts.length;
  const route = String(run.control?.presets?.submitPath || "").includes("dom") ? "DOM" : "API";
  const firstPrompt = prompts[0] || "";
  const mode = run.mode || "";

  const refsNode = refs.length
    ? el("div", { class: "history-refs-pill has-refs", attrs: { title: `${refs.length} reference${refs.length === 1 ? "" : "s"}` } },
        ...refs.slice(0, 4).map((ref) => el("span", {
          class: "history-ref-thumb",
          attrs: { title: ref.title || ref.fileName || "Reference" },
        }, ref.imageUrl
          ? el("img", { attrs: { src: ref.imageUrl, alt: ref.title || "Reference", loading: "lazy" } })
          : icon("image"))),
        refs.length > 4 ? el("span", { class: "history-more-refs", text: `+${refs.length - 4}` }) : null,
      )
    : el("div", { class: "history-refs-pill no-refs" }, icon("link_off"), el("span", { text: translate("noRefs", {}, locale) }));

  return el("article", { class: `history-card ${modeAccentClass(mode)}`, data: { historyId: run.id } },
    // Row 1 — mode identity + meta
    el("div", { class: "history-row history-row-head" },
      el("div", { class: "history-mode-chip" }, icon(modeIconName(mode))),
      el("strong", { class: "history-title", text: `${modeLabel(mode, locale)} · ${promptCount} prompt${promptCount === 1 ? "" : "s"}` }),
      el("span", { class: "history-meta", text: formatHistoryTime(run.createdAt) }),
      el("span", { class: "history-route-pill", text: route }),
    ),
    // Row 2 — prompt text (prominent)
    el("div", { class: "history-row history-row-prompt" },
      el("span", { class: "history-prompt-preview", text: firstPrompt || "(no prompt text)" }),
    ),
    // Row 3 — refs visibility + actions
    el("div", { class: "history-row history-row-foot" },
      refsNode,
      el("div", { class: "history-actions" },
        el("button", { data: { historyRestore: run.id }, attrs: { type: "button", title: translate("editPromptsAndRefs", {}, locale) } }, icon("edit"), el("span", { text: translate("edit", {}, locale) })),
        el("button", { data: { historyRun: run.id }, attrs: { type: "button", title: translate("runThisBatchAgain", {}, locale) } }, icon("replay"), el("span", { text: translate("runAgain", {}, locale) })),
        el("button", { data: { historyDelete: run.id }, class: "history-action-icon", attrs: { type: "button", title: translate("deleteHistoryEntry", {}, locale) } }, icon("close")),
      ),
    ),
  );
}

function formatHistoryTime(iso = "") {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "saved";
  return date.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderWorkflowHint() {
  return el("details", { id: "videoPromptHint", class: "workflow-hint" },
    el("summary", null,
      icon("movie_filter"),
      el("span", { text: "Image -> Video Workflow" }),
      el("span", { class: "workflow-click-expand", text: "click to expand" })
    ),
    el("div", { class: "workflow-hint-body" },
      el("div", null,
        "Use ",
        el("strong", { text: "Create Image" }),
        " first, then select your best images in ",
        el("strong", { text: "Gallery" }),
        " and click ",
        el("strong", { text: "Animate Images" }),
        ". Use this scene-tag format:"
      ),
      el("div", { class: "workflow-example" },
        el("span", { class: "scene-token", text: "[V99-S1]" }),
        " blue cat standing on grey background ",
        el("span", { class: "scene-separator", text: "|||" }),
        " ",
        el("span", { class: "scene-token", text: "[V99-S1]" }),
        " animate blue cat jumping"
      )
    )
  );
}

function renderReferenceLibraryGrid(state) {
  const items = state.referenceLibrary.savedItems || [];
  const active = new Set(allActiveRefIds(state));
  const oneToOne = new Set(oneToOneBatchRefIds(state));
  const previewIds = active.size ? [...active] : [...oneToOne];
  const hasAnyActiveSource = active.size > 0 || oneToOne.size > 0;
  const grid = el("div", { id: "refImagesGrid", class: "ref-images-grid" });
  if (!items.length) {
    grid.appendChild(el("p", { class: "ref-empty-message", text: "No library images yet. Click Add to library to upload." }));
  } else {
    for (const item of items.slice(0, 100)) {
      grid.appendChild(el("button", {
        class: `ref-library-thumb${active.has(item.id) ? " active" : ""}${oneToOne.has(item.id) ? " batch-active" : ""}`,
        data: { refLibraryId: item.id },
        attrs: { type: "button", title: item.title || item.fileName || "Reference image" }
      },
        el("img", { attrs: { src: item.imageUrl || item.dataUrl || item.mediaUrl, alt: item.title || "Reference image", loading: "lazy" } }),
        oneToOne.has(item.id) ? el("span", { class: "ref-batch-badge", text: "1:1" }) : null
      ));
    }
  }
  return el("div", { id: "refImagesContent", class: "ref-images-content" },
    el("div", { class: "ref-library-summary" },
      el("span", { text: oneToOne.size ? `${oneToOne.size} queued 1:1` : active.size ? `${active.size} active` : "No active references" }),
      el("span", { text: oneToOne.size ? "1:1 batch overrides selected library refs." : "Use selected refs for the next queue items." })
    ),
    grid,
    el("div", { class: "ref-library-actions" },
      el("button", { id: "refSelectAllBtn", attrs: { type: "button" }, text: "Select all" }),
      el("button", { id: "refClearMarkedBtn", attrs: { type: "button" }, text: "Deselect all" }),
      el("button", { id: "deleteSelectedRefsBtn", attrs: { type: "button", disabled: true }, text: "Delete Selected" }),
      el("button", { id: "clearRefImagesBtn", class: "ref-clear-all-btn", attrs: { type: "button" }, text: "Clear All" })
    ),
    el("div", { id: "noRefWarning", class: "no-ref-warning", style: { display: items.length && !hasAnyActiveSource ? "block" : "none" } },
      icon("warning"),
      el("span", { text: "No reference active - click image(s) above to activate" })
    ),
    el("div", { id: "selectedRefImage", class: "selected-ref-image", style: { display: hasAnyActiveSource ? "block" : "none" } },
      el("div", { class: "selected-ref-row" },
        el("div", { id: "selectedRefPreviews", class: "selected-ref-previews" },
          previewIds.slice(0, 6).map((id) => {
            const item = savedReference(state, id);
            return item ? el("img", { attrs: { src: item.imageUrl || item.dataUrl || item.mediaUrl, alt: item.title || "Selected reference" } }) : null;
          })
        ),
        el("div", { class: "selected-ref-copy" },
          el("div", { class: "selected-ref-title" }, icon("check_circle"), el("span", { id: "refActiveCount", text: String(previewIds.length) }), el("span", { text: oneToOne.size ? " 1:1 Batch Active" : " Reference Active" })),
          el("div", { id: "refAssignHint", text: oneToOne.size ? "Mapped by prompt row. Library selections are temporarily unchecked." : "Will be used for all prompts" })
        ),
        el("button", { id: "clearSelectedRef", attrs: { type: "button" } }, icon("close"), el("span", { text: "Clear" }))
      )
    )
  );
}

function renderPromptAssignList(state, prompts) {
  const open = state.control.promptMapOpen === true;
  const fullscreen = state.control.promptMapFullscreen === true;
  const frameMode = state.control.mode === FLOW_MODES.imageToVideo;
  const rows = promptMapRows(state, prompts);
  const mappedCount = rows.filter((row) => row.effectiveIds.length > 0).length;
  const sourceRefs = mappingSourceRefs(state);
  const sourceCount = sourceRefs.length;
  const classes = [
    fullscreen ? "assign-fullscreen" : "",
    frameMode ? "map-mode-frame" : "",
    oneToOneBatchRefIds(state).length ? "map-mode-one-to-one" : ""
  ].filter(Boolean).join(" ");

  const panel = el("div", { id: "promptAssignList", class: classes, style: { display: open ? "block" : "none" } });
  if (!prompts.length || (!sourceCount && state.control.mode !== FLOW_MODES.textToVideo)) {
    panel.append(
      el("p", {
        class: "prompt-map-empty",
        text: !prompts.length
          ? "Paste prompts first to map references."
          : "Activate reference images or upload a 1:1 batch to map prompt-by-prompt."
      }),
      promptAssignFooter(mappedCount, true)
    );
    return panel;
  }

  const toolbar = el("div", { class: "map-toolbar" },
      el("div", { class: "map-toolbar-actions" },
        el("button", { data: { mapAction: "map-all" }, attrs: { type: "button" }, text: frameMode ? "Map start/end" : "Map all refs" }),
        el("button", { data: { mapAction: "clear-selected" }, attrs: { type: "button" }, text: "Unmap all refs" }),
        el("button", { data: { mapAction: "clear-active-refs" }, attrs: { type: "button" }, text: "Clear active refs" }),
        el("button", { data: { mapAction: "map-one-to-one" }, attrs: { type: "button", disabled: sourceCount ? null : "disabled" }, text: "Map 1:1 by row" }),
        el("button", { id: "taskKeyManagerBtn", attrs: { type: "button", title: "Task Key Manager parity hook" }, text: "Task Key Manager" }),
        frameMode ? el("label", { class: "map-end-toggle" },
          el("input", { id: "mapEndFrameToggle", checked: true, attrs: { type: "checkbox" } }),
          el("span", { text: "End Frame" })
        ) : null
      ),
      el("div", { class: "map-toolbar-right" },
        el("span", { class: "map-source-summary", text: oneToOneBatchRefIds(state).length ? `${sourceCount} 1:1 batch ref${sourceCount === 1 ? "" : "s"}` : `${sourceCount} active ref${sourceCount === 1 ? "" : "s"}` }),
        el("button", { id: "assignFullscreenBtn", attrs: { type: "button" }, text: fullscreen ? "Exit fullscreen" : "Fullscreen" }),
        el("button", { id: "assignDoneBtn", attrs: { type: "button" }, text: "Hide" })
      )
    );
  const stats = renderMapStatsBar(rows.length, mappedCount);
  const grid = el("div", { class: "map-grid-wrap" },
      el("div", { class: `map-grid-head${frameMode ? " frame-mode" : ""}` },
        el("span", { text: "Sel" }),
        el("span", { text: "#" }),
        el("span", { text: "Prompt" }),
        el("span", { text: "Status" }),
        frameMode ? el("span", { text: "Start Frame" }) : el("span", { text: "Image" }),
        frameMode ? el("span", { text: "End Frame" }) : null
      ),
      el("div", { class: "map-grid-scroll" },
        rows.slice(0, 120).map((row) => renderPromptMapRow(row, sourceRefs, frameMode))
      )
    );

  if (fullscreen) {
    panel.append(
      el("div", { class: "map-split" },
        renderMapRefPool(sourceRefs, rows),
        el("div", { class: "map-split-content" },
          toolbar,
          stats,
          grid,
          promptAssignFooter(mappedCount, false)
        )
      )
    );
  } else {
    panel.append(toolbar, stats, grid, promptAssignFooter(mappedCount, false));
  }
  return panel;
}

function renderMapStatsBar(totalRows, mappedCount) {
  const total = Math.max(0, Number(totalRows || 0));
  const mapped = Math.max(0, Number(mappedCount || 0));
  const pct = total ? Math.round((mapped / total) * 100) : 0;
  return el("div", { class: "map-stats-bar-wrap" },
    el("div", { class: "map-stats-track" },
      el("div", { class: "map-stats-fill", style: { width: `${pct}%` } })
    ),
    el("span", { class: "map-stats-text", text: `${mapped}/${total} mapped` })
  );
}

function renderMapRefPool(sourceRefs, rows) {
  const usedIds = new Set(rows.flatMap((row) => row.effectiveIds || []));
  return el("aside", { class: "map-ref-pool" },
    el("div", { class: "map-pool-header", text: "Reference Pool" }),
    sourceRefs.length
      ? el("div", { class: "map-ref-pool-grid" }, sourceRefs.map((ref) => renderMapPoolItem(ref, usedIds.has(ref.id))))
      : el("div", { class: "map-pool-empty", text: "No active refs" }),
    el("div", { class: "map-pool-actions" },
      el("button", { data: { mapAction: "map-all" }, attrs: { type: "button" }, text: "Map all refs" }),
      el("button", { data: { mapAction: "map-one-to-one" }, attrs: { type: "button" }, text: "Map 1:1 by row" })
    ),
    el("div", { class: "map-pool-count", text: `${sourceRefs.length} available` })
  );
}

function renderMapPoolItem(ref, used) {
  const title = ref.title || ref.fileName || "Reference";
  return el("button", {
    class: "map-pool-item",
    data: { mapPoolRefId: ref.id },
    attrs: { type: "button", title }
  },
    el("img", {
      class: `map-pool-thumb${used ? " used" : ""}`,
      attrs: { src: ref.imageUrl || ref.dataUrl || ref.mediaUrl, alt: title, loading: "lazy" }
    }),
    el("span", { class: "map-pool-name", text: title })
  );
}

function promptAssignFooter(mappedCount, includeHide) {
  return el("div", { class: "assign-footer" },
    el("span", { id: "assignStatus", text: `${mappedCount} mapped` }),
    includeHide ? el("button", { id: "assignDoneBtn", attrs: { type: "button" }, text: "Hide" }) : null
  );
}

function renderPromptMapRow(row, sourceRefs, frameMode) {
  const status = row.effectiveIds.length ? "mapped" : "unmapped";
  const statusText = row.effectiveIds.length ? "Mapped" : "No Image";
  const promptPreview = row.prompt.length > 90 ? `${row.prompt.slice(0, 90)}...` : row.prompt;
  return el("div", {
    class: `map-grid-row${frameMode ? " frame-mode" : ""}`,
    data: { promptKey: row.key, promptIndex: String(row.index) }
  },
    el("input", { class: "map-row-check", data: { promptKey: row.key }, attrs: { type: "checkbox" } }),
    el("span", { class: "prompt-idx", text: String(row.index + 1).padStart(2, "0") }),
    el("span", { class: "prompt-text", attrs: { title: row.prompt }, text: promptPreview }),
    el("span", { class: `map-status-pill ${status}`, text: statusText }),
    frameMode
      ? renderFrameRefCell(row, sourceRefs, "start")
      : renderImageRefCell(row, sourceRefs),
    frameMode ? renderFrameRefCell(row, sourceRefs, "end") : null
  );
}

function renderImageRefCell(row, sourceRefs) {
  if (!sourceRefs.length) return el("span", { class: "map-ref-empty", text: "-" });
  return el("div", { class: "map-ref-cell" }, sourceRefs.map((ref) => renderMapRefThumb(ref, row, row.effectiveIds.includes(ref.id))));
}

function renderFrameRefCell(row, sourceRefs, slot) {
  if (!sourceRefs.length) return el("span", { class: "map-ref-empty", text: "-" });
  const slotIndex = slot === "end" ? 1 : 0;
  return el("div", { class: "map-ref-cell" }, sourceRefs.map((ref) => renderMapRefThumb(ref, row, row.effectiveIds[slotIndex] === ref.id, slot)));
}

function renderMapRefThumb(ref, row, assigned, frameSlot = "") {
  return el("button", {
    class: `map-ref-thumb-btn${assigned ? " assigned" : " unassigned"}`,
    data: { mapRefId: ref.id, mapPromptKey: row.key, mapFrameSlot: frameSlot },
    attrs: { type: "button", title: ref.title || ref.fileName || "Reference image" }
  },
    el("img", { class: "map-ref-thumb", attrs: { src: ref.imageUrl || ref.dataUrl || ref.mediaUrl, alt: ref.title || "Reference image", loading: "lazy" } })
  );
}

// @i18n-resume
export function renderGallery(root, state) {
  clear(root);
  const deletedIds = state.gallery.deletedIds || [];
  const activeProjectId = String(state.runtime?.projectId || "").trim();
  const referenceMediaIds = knownGalleryReferenceMediaIds(state);
  const projectItems = filterGalleryItemsForProject([
    ...(state.gallery.items || []),
    ...buildGalleryItemsFromTasks(state.queue.items || [])
  ], activeProjectId);
  const items = canonicalGalleryItems(projectItems, { projectId: activeProjectId, referenceMediaIds }).filter((item) => !deletedIds.includes(item.id));
  const selected = new Set(state.ui.selectedGalleryIds || []);
  const groups = {
    images: items.filter((item) => (item.kind || "images") === "images"),
    videos: items.filter((item) => item.kind === "videos")
  };
  const rawViewMode = state.ui.galleryViewMode || "grid";
  const viewMode = rawViewMode === "live" ? "grid" : rawViewMode;
  const sizeMode = state.ui.gallerySize || "small";
  const active = resolveActiveGalleryTab(state, groups, viewMode);
  const locale = state.control?.presets?.language || "en";
  const selectedVideos = groups.videos.filter((item) => selected.has(item.id)).length;
  const activeSelectedCount = groups[active].filter((item) => selected.has(item.id)).length;
  const activeItems = groups[active];
  const sortedActiveItems = sortGalleryItems(activeItems, state.ui.gallerySortOrder || "num-asc");
  const activeCount = activeItems.length;
  const refsById = new Map([
    ...(state.control?.transientReferenceItems || []),
    ...(state.referenceLibrary?.savedItems || [])
  ].map((ref) => [String(ref?.id || ""), ref]).filter(([id]) => id));
  const defaultRefId = refsById.size === 1 ? [...refsById.keys()][0] : "";

  root.classList.toggle("gallery-layout-large", sizeMode === "medium");
  root.appendChild(el("div", { class: `gallery-shell gallery-view-${viewMode} gallery-size-${sizeMode}` },
    el("div", { class: "gallery-subtabs" },
      galleryTab("images", translate("images", {}, locale), active, groups.images.length, "image"),
      galleryTab("videos", translate("videos", {}, locale), active, groups.videos.length, "movie")
    ),
    el("div", { class: "gallery-layout-controls" },
      el("span", { class: "gallery-layout-label", text: translate("viewLabel", {}, locale) }),
      el("div", { class: "gallery-layout-buttons" },
        galleryLayoutButton("grid", viewMode, "grid_view", translate("gridView", {}, locale)),
        galleryLayoutButton("table", viewMode, "table_rows", translate("tableView", {}, locale))
      ),
      el("span", { class: "gallery-layout-label gallery-size-label", text: translate("sizeLabel", {}, locale) }),
      el("div", { class: "gallery-layout-buttons" },
        gallerySizeButton("small", sizeMode, "S"),
        gallerySizeButton("medium", sizeMode, "M")
      )
    ),
    viewMode === "live"
      ? el("div", { class: "gallery-pane active" },
        renderGalleryHeader(active, state, activeCount, activeSelectedCount, selectedVideos, locale),
        renderLiveQueueGallery(state, selected)
      )
      : el("div", { class: "gallery-pane active" },
        renderGalleryHeader(active, state, activeCount, activeSelectedCount, selectedVideos, locale),
        renderGalleryHowTo(active, locale),
        galleryGrid(sortedActiveItems, selected, `gallery-${active}`, active === "images"
          ? translate("noImagesLoaded", {}, locale)
          : translate("noVideosLoaded", {}, locale), viewMode, refsById, defaultRefId)
      ),
    state.gallery.meta?.fetchedAt ? el("div", { class: "setting-hint gallery-last-scan", text: `Last scan ${formatTime(state.gallery.meta.fetchedAt)} - ${state.gallery.meta.source || "gallery"}` }) : null
  ));
}

function knownGalleryReferenceMediaIds(state = {}) {
  const referenceItems = [
    ...(state.control?.transientReferenceItems || []),
    ...(state.referenceLibrary?.savedItems || [])
  ];
  return [...new Set([
    ...referenceMediaIdsFromTasks(state.queue?.items || []),
    ...referenceItems.flatMap((item) => [item?.mediaId, item?.assetImageId])
  ].map((id) => String(id || "").trim()).filter(Boolean))];
}

export function renderLiveQueue(root, state) {
  const locale = state.control?.presets?.language || "en";
  const mediaCache = collectLiveQueuePreviewMedia(root);
  const shell = el("div", { class: "gallery-shell gallery-view-live" },
    el("div", { class: "live-queue-page-head" },
      el("div", null,
        el("div", { class: "section-label", text: translate("liveQueue", {}, locale) }),
        el("h2", { text: translate("liveQueueSubtitle", {}, locale) }),
        el("p", { text: translate("liveQueueDesc", {}, locale) })
      )
    ),
    renderLiveQueueGallery(state, new Set(state.ui.selectedGalleryIds || []), { showAllGroups: true })
  );
  reuseLiveQueuePreviewMedia(shell, mediaCache);
  clear(root);
  root.appendChild(shell);
}

function collectLiveQueuePreviewMedia(root) {
  const cache = new Map();
  root?.querySelectorAll?.(".live-preview-media[data-live-media-key]")?.forEach((node) => {
    const key = String(node.dataset.liveMediaKey || "");
    const src = String(node.getAttribute("src") || "");
    if (!key || !src || cache.has(key)) return;
    cache.set(key, { node, src, tagName: node.tagName });
  });
  return cache;
}

function reuseLiveQueuePreviewMedia(root, cache) {
  if (!cache?.size) return;
  root.querySelectorAll(".live-preview-media[data-live-media-key]").forEach((node) => {
    const key = String(node.dataset.liveMediaKey || "");
    const cached = cache.get(key);
    if (!cached || cached.tagName !== node.tagName || cached.src !== String(node.getAttribute("src") || "")) return;
    for (const attr of Array.from(node.attributes)) {
      cached.node.setAttribute(attr.name, attr.value);
    }
    for (const attr of Array.from(cached.node.attributes)) {
      if (!node.hasAttribute(attr.name)) cached.node.removeAttribute(attr.name);
    }
    node.replaceWith(cached.node);
    cache.delete(key);
  });
}

function resolveActiveGalleryTab(state, groups, viewMode) {
  if (viewMode === "live") {
    const liveKind = liveQueueMediaKind(state.queue?.items || []);
    if (liveKind) return liveKind;
  }
  return ["images", "videos"].includes(state.ui.galleryTab) ? state.ui.galleryTab : "images";
}

function liveQueueMediaKind(items = []) {
  const groups = queueGroups(items);
  const activeGroups = groups.filter((group) => group.statusClass !== "done");
  const group = (activeGroups.length ? activeGroups : groups.slice(-1)).at(-1);
  if (!group?.items?.length) return "";
  return group.items.some((item) => liveQueueIsVideoItem(item)) ? "videos" : "images";
}

export function renderSettings(root, state) {
  clear(root);
  const locale = state.control?.presets?.language || "en";
  const presets = state.control.presets;
  const hasAccess = hasProAccess(state);
  const signedIn = state.account?.status === "signed_in";
  const grid = el("div", { class: "settings-grid" },
    subheader("account_circle", "Account"),
    renderAccountSettings(state),

    subheader("tune", "General Settings"),
    el("div", { id: "videoModeSettings", class: "mode-settings" },
      field("Videos per task:", select("repeatCountInput", presets.repeatCount, [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]], "repeatCount")),
      field("Model (optional):", select("modelSelector", presets.model, VIDEO_MODEL_OPTIONS, "model")),
      field("Ingredients Video Model:", select("ingredientsModelSelector", presets.ingredientsModel, [["veo3_fast_low", "Veo 3.1 - Fast [Lower Priority]"], ["veo3_fast", "Veo 3.1 - Fast"]], "ingredientsModel")),
      field("Video Ratio:", select("aspectRatioSelector", presets.aspectRatio, [["landscape", "Landscape (16:9)"], ["portrait", "Portrait (9:16)"]], "aspectRatio")),
      field(translate("returnSilentVideos", {}, locale) + ":", controlGroup(checkInput("returnSilentVideosCheckbox", presets.returnSilentVideos !== false, "returnSilentVideos")))
    ),
    el("div", { id: "imageModeSettings", class: "mode-settings" },
      field("Images per task:", select("imageRepeatCountInput", presets.imageRepeatCount, [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]], "imageRepeatCount")),
      field("Model:", select("imageModelSelector", presets.imageModel, [["nano_banana_pro", "Nano Banana Pro (Default)"], ["nano_banana_2", "Nano Banana 2"], ["imagen_4", "Imagen 4"]], "imageModel")),
      field("Image Ratio:", select("imageAspectRatioSelector", presets.imageAspectRatio, [["landscape", "Landscape (16:9)"], ["landscape_4_3", "Landscape (4:3)"], ["square", "Square (1:1)"], ["portrait_3_4", "Portrait (3:4)"], ["portrait", "Portrait (9:16)"]], "imageAspectRatio"))
    ),
    field("Start from (Prompt/Image):", controlGroup(numberInput("startFromInput", presets.startFrom, "startFrom", { min: "1" }), el("span", { class: "unit", text: "number" }))),

    subheader("timer", "Timing"),
    el("div", { class: "control-label-with-tip wide" },
      el("label", { id: "waitTimeLabel", text: "Generation wait time (sec):" }),
      el("button", { class: "inline-help-tip", attrs: { type: "button", title: translate("waitTimeTip", {}, locale) }, text: "?" })
    ),
    el("div", { class: "control-group wide" },
      numberInput("minInitialWaitTime", presets.minInitialWaitTime, "minInitialWaitTime", { min: "1" }),
      el("span", { text: "to" }),
      numberInput("maxInitialWaitTime", presets.maxInitialWaitTime, "maxInitialWaitTime", { min: "1" })
    ),

    subheader("download", "Download Settings"),
    field("Auto-download videos:", controlGroup(checkInput("autoDownloadCheckbox", presets.autoDownload, "autoDownload"))),
    field("Video Resolution:", select("videoDownloadResolution", presets.videoDownloadResolution, [["720p", "Original (720p)"], ["1080p", "Upscaled (1080p)"], ["4k", "Upscaled (4K - 50 credits)"]], "videoDownloadResolution")),
    field("Auto-download images:", controlGroup(checkInput("autoDownloadImagesCheckbox", presets.autoDownloadImages, "autoDownloadImages"), select("imageAutoDownloadResolution", presets.imageAutoDownloadResolution, [["1k", "1K"], ["2k", "2K"], ["4k", "4K"]], "imageAutoDownloadResolution"))),
    field("Download Folder:", controlGroup(textInput("jobDownloadFolderInput", presets.downloadFolder, "downloadFolder"), el("label", { class: "auto-number-toggle", attrs: { for: "autoNumberFolderCheckbox" } }, checkInput("autoNumberFolderCheckbox", presets.autoNumberFolder, "autoNumberFolder"), el("span", { text: "Auto-number" })))),
    el("div", { class: "hint-text wide", text: translate("autoNumberFolderHint", {}, locale) }),
    field("Filename style:", select("filenameStyleSelect", presets.filenameStyle, [["detailed", "Scene token + prompt slug (default)"], ["prompt_prefix", "Prompt Prefix"], ["auto_flow", "Autoflow Format"], ["custom_template", "Custom Template"]], "filenameStyle")),
    renderFilenameTemplateControls(presets, locale),
    el("div", { class: "filename-preview-line wide" },
      el("span", { id: "filenamePreviewLabel", class: "filename-preview-label", text: translate("exampleLabel", {}, locale) }),
      el("span", { id: "filenameStylePreviewValue", class: "filename-preview-value", text: filenamePreview(presets) })
    ),
    el("div", { class: "hint-text wide", text: translate("disableAskWhereSave", {}, locale) }),

    subheader("language", "Interface"),
    field("Language:", select("languageSelector", presets.language, LANGUAGE_OPTIONS, "language")),

    subheader("credit_card", "Subscription"),
    el("div", { id: "manageSubSection", class: "wide", style: { display: signedIn ? "block" : "none" } },
      el("button", { id: "manageSubBtn", data: { billingAction: "manage" }, attrs: { type: "button" } }, icon("settings"), el("span", { text: translate("manageSubscription", {}, locale) })),
      el("p", { class: "hint-text", text: signedIn ? translate("openStripeBilling", {}, locale) : translate("signInToManageBilling", {}, locale) })
    ),
    el("div", { id: "noSubSection", class: "wide", style: { display: hasAccess || signedIn ? "none" : "block" } },
      el("p", { class: "hint-text", text: translate("noActiveSubscription", {}, locale) })
    ),

    subheader("build", "Maintenance"),
    maintenanceButton("clearFlowCacheBtn", "delete_sweep", "Clear Flow Cache", "danger"),
    el("p", { class: "hint-text wide", text: translate("clearFlowCacheHint", {}, locale) }),
    maintenanceButton("clearFlowCookiesBtn", "cookie", "Clear Flow Cookies", "warning"),
    el("p", { class: "hint-text wide", text: translate("clearFlowCookiesHint", {}, locale) }),
    maintenanceButton("clearAllFlowDataBtn", "mop", translate("clearAllFlowData", {}, locale), "danger"),
    el("p", { class: "hint-text wide", text: translate("clearAllFlowDataHint", {}, locale) })
  );
  root.appendChild(grid);
}

export function renderLogs(root, state) {
  clear(root);
  const locale = state.control?.presets?.language || "en";
  const lines = state.logs.items.slice(-200).map((entry) => {
    const time = formatTime(entry.createdAt);
    return `[${time}] [${entry.level}] [${entry.scope}] ${entry.message}`;
  });

  root.appendChild(el("div", { class: "logs-shell" },
    el("div", { class: "section-header log-main-header" },
      el("span", { class: "section-title", text: "Detailed Log" }),
      el("div", { class: "log-toolbar" },
        el("button", { id: "copyDebugReportBtn", class: "small-btn", attrs: { type: "button", title: translate("exportDebugReportTitle", {}, locale) } }, icon("download"), el("span", { class: "export-report-label", text: "Export Report" }))
      )
    ),
    el("div", { id: "logDisplay", class: "log-display" },
      lines.length ? lines.map((line) => el("div", { class: "log-line", text: line })) : el("div", { class: "log-line muted", text: translate("noLogsYet", {}, locale) })
    ),
    el("pre", { id: "logOutput", class: "log-pre hidden-log-output", text: lines.join("\n") })
  ));
}

export function renderScenes(root, state) {
  clear(root);
  const locale = state.control?.presets?.language || "en";
  const clips = [...(state.scenes?.clips || [])].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  const selected = new Set(state.scenes?.selectedClipIds || []);
  const selectedClips = clips.filter((clip) => selected.has(clip.id));
  const selectedGalleryBacked = selectedClips.filter((clip) => clip.sourceGalleryId).length;
  const totalDuration = totalSceneDuration(clips);
  root.appendChild(el("div", { class: "control-section scenes-shell" },
    el("div", { class: "section-header" },
      el("strong", { class: "section-title", text: translate("sceneBuilder", {}, locale) }),
      el("span", { class: "sample-link", text: `${selectedClips.length}/${clips.length}` })
    ),
    el("div", { class: "scene-builder-toolbar" },
      el("button", { id: "sceneBuilderSelectAllBtn", attrs: { type: "button", disabled: clips.length ? null : "disabled", title: translate("selectAll", {}, locale) } }, icon("select_all"), el("span", { text: translate("selectAll", {}, locale) })),
      el("button", { id: "sceneBuilderDeselectAllBtn", attrs: { type: "button", disabled: selectedClips.length ? null : "disabled", title: translate("deselectAll", {}, locale) } }, icon("deselect"), el("span", { text: translate("deselectAll", {}, locale) })),
      el("button", { id: "sceneBuilderSelectGalleryBtn", attrs: { type: "button", disabled: selectedGalleryBacked ? null : "disabled", title: translate("gallery", {}, locale) } }, icon("photo_library"), el("span", { text: translate("gallery", {}, locale) }), el("span", { text: `(${selectedGalleryBacked})` })),
      el("button", { id: "sceneBuilderClearBtn", attrs: { type: "button", disabled: clips.length ? null : "disabled" } }, icon("delete_sweep"), el("span", { text: translate("clearScenes", {}, locale) })),
      el("span", { class: "scene-builder-total", text: translate("totalDurationDisplay", { duration: totalDuration }, locale) })
    ),
    el("p", { class: "setting-hint", text: translate("addFromGalleryHint", {}, locale) }),
    el("div", { class: "scene-builder-section-title" }, icon("movie"), el("span", { text: translate("clipList", {}, locale) })),
    clips.length
      ? el("div", { id: "sceneBuilderClipList", class: "scene-clip-list" }, clips.map((clip, index) => renderSceneClip(clip, index, clips.length, selected.has(clip.id), locale)))
      : el("div", { id: "sceneBuilderClipList", class: "gallery-empty", text: translate("sceneBuilderEmpty", {}, locale) }),
    el("div", { class: "scene-builder-section-title" }, icon("graphic_eq"), el("span", { text: translate("audioSection", {}, locale) })),
    el("div", { class: "scene-builder-audio-row" },
      icon("music_note"),
      el("span", { id: "sceneBuilderAudioName", class: "scene-builder-audio-name", text: state.scenes?.audioName || translate("noAudio", {}, locale) })
    )
  ));
}

function renderSceneClip(clip, index, total, selected = false, locale = "en") {
  const media = renderSceneClipMedia(clip, locale);
  const kindLabel = translate("videos", {}, locale);
  return el("div", { class: `scene-clip${selected ? " selected" : ""} is-${clip.kind || "videos"}`, data: { sceneClipId: clip.id } },
    el("label", { class: "scene-clip-select" },
      el("input", { data: { sceneSelectId: clip.id }, checked: selected, attrs: { type: "checkbox", "aria-label": translate("selectAll", {}, locale) } }),
      el("span", { class: "assign-index", text: String(index + 1).padStart(2, "0") })
    ),
    el("span", { class: "scene-clip-media" }, media),
    el("span", { class: "scene-clip-copy" },
      el("span", { class: "scene-clip-title", text: clip.title || translate("clipN", { n: index + 1 }, locale) }),
      el("span", { class: "scene-clip-kind", text: kindLabel }),
      el("span", { class: "scene-clip-prompt", text: clip.prompt || clip.mediaId || "" })
    ),
    el("span", { class: "scene-clip-actions" },
      el("button", { class: "scene-clip-btn", data: { sceneAction: "up", sceneClipId: clip.id }, attrs: { type: "button", title: translate("moveUp", {}, locale), disabled: index === 0 ? "disabled" : null } }, icon("keyboard_arrow_up")),
      el("button", { class: "scene-clip-btn", data: { sceneAction: "down", sceneClipId: clip.id }, attrs: { type: "button", title: translate("moveDown", {}, locale), disabled: index === total - 1 ? "disabled" : null } }, icon("keyboard_arrow_down")),
      el("button", { class: "scene-clip-btn", data: { sceneAction: "remove", sceneClipId: clip.id }, attrs: { type: "button", title: translate("remove", {}, locale) } }, icon("close"))
    )
  );
}

function renderSceneClipMedia(clip, locale = "en") {
  const mediaUrl = String(clip.mediaUrl || "").trim();
  const thumbnailUrl = String(clip.thumbnailUrl || "").trim();
  const title = clip.title || translate("sceneBuilder", {}, locale);
  if (clip.kind === "videos" && mediaUrl) {
    return el("video", { attrs: { src: mediaUrl, muted: true, playsinline: true, preload: "metadata" } });
  }
  if (thumbnailUrl) {
    return el("img", { attrs: { src: thumbnailUrl, alt: title, loading: "eager", decoding: "async", draggable: "false" } });
  }
  return icon("movie");
}

function renderAccountSettings(state) {
  const account = state.account || {};
  const locale = state.control?.presets?.language || "en";
  const signedIn = account.status === "signed_in";
  const pendingCode = account.status === "pending_confirmation";
  const hasAccess = hasProAccess(state);
  const email = account.email || "";
  return el("div", { id: "accountSection", class: "account-settings-form wide" },
    account.error ? el("div", { class: "setting-hint account-error", text: account.error }) : null,
    visibleAccountMessage(state) ? el("div", { class: "setting-hint account-message", text: visibleAccountMessage(state) }) : null,
    el("div", { id: "authSignedOut", style: { display: signedIn ? "none" : "block" } },
      el("p", { class: "setting-hint", text: translate("signInToRestore", {}, locale) }),
      el("div", { style: { display: pendingCode ? "none" : "flex", gap: "8px", alignItems: "center" } },
        el("input", { id: "authEmailInput", value: email, attrs: { type: "email", placeholder: "your@email.com", autocomplete: "email" } }),
        el("button", { id: "authSendLinkBtn", class: "btn-secondary", attrs: { type: "button" } }, icon("mail"), el("span", { class: "auth-send-code-label", text: translate("sendCode", {}, locale) }))
      ),
      el("p", { class: "auth-email-hint", text: translate("useAnyEmail", {}, locale) }),
      el("div", { id: "authOtpSection", style: { display: pendingCode ? "block" : "none", marginTop: "8px" } },
        el("p", { class: "auth-email-hint", text: translate("checkEmailAddress", { email: email || "your email" }, locale) }),
        el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
          el("input", { id: "authOtpInput", value: account.otpCode || "", attrs: { type: "text", placeholder: translate("enterCode", {}, locale), maxlength: "10", autocomplete: "one-time-code", inputmode: "numeric" } }),
          el("button", { id: "authVerifyBtn", class: "btn-secondary", attrs: { type: "button" }, text: translate("verify", {}, locale) })
        )
      )
    ),
    el("div", { id: "authSignedIn", style: { display: signedIn ? "block" : "none" } },
      el("div", { class: "signed-in-card" },
        el("div", null,
          el("div", { class: "user-email", id: "userEmail", text: account.email || "" }),
          el("div", { class: "usage-line" },
            el("span", { id: "userTierBadge", class: `tier-badge ${hasAccess ? "pro" : "free"}`, text: hasAccess ? translate("proBadge", {}, locale) : translate("freeBadge", {}, locale) }),
            el("span", { id: "usageCounter", text: hasAccess ? translate("unlimitedPrompts", {}, locale) : formatUsageLine(account) })
          )
        ),
        el("div", { class: "button-row" },
          el("button", { id: "refreshLicenseBtn", attrs: { type: "button", title: translate("refreshSubscriptionStatus", {}, locale) } }, icon("refresh")),
          el("button", { id: "authSignOutBtn", class: "btn-secondary", attrs: { type: "button" }, text: translate("signOut", {}, locale) })
        )
      )
    )
  );
}

function renderFilenameTemplateControls(presets, locale = "en") {
  return el("div", { id: "filenameTemplateControls", class: "filename-template-controls wide" },
    el("p", { id: "filenameTemplateHelpText", class: "filename-template-help", text: translate("defaultNamingHint", {}, locale) }),
    filenameRow("Template prefix:", textInput("filenameTemplatePrefix", presets.filenameTemplatePrefix, "filenameTemplatePrefix", "Optional prefix")),
    filenameRow("Template index:", select("filenameTemplateIndex", presets.filenameTemplateIndex, [["none", "none"], ["n", "n"], ["nn", "nn"], ["nnn", "nnn"]], "filenameTemplateIndex")),
    filenameRow("Template prompt part:", select("filenameTemplatePromptPart", presets.filenameTemplatePromptPart, [["none", "none"], ["first_word", "first_word"], ["first_3_words", "first_3_words"], ["slug_8", "slug_8"]], "filenameTemplatePromptPart")),
    filenameRow("Template date:", select("filenameTemplateDate", presets.filenameTemplateDate, [["none", "none"], ["yyyymmdd", "yyyymmdd"], ["yymmdd_hhmm", "yymmdd_hhmm"]], "filenameTemplateDate")),
    filenameRow("Template suffix:", select("filenameTemplateSuffix", presets.filenameTemplateSuffix, [["none", "none"], ["rand4", "rand4"], ["rand8", "rand8"]], "filenameTemplateSuffix")),
    filenameRow("Template separator:", select("filenameTemplateSeparator", presets.filenameTemplateSeparator, [["_", "_"], ["-", "-"]], "filenameTemplateSeparator"))
  );
}

function filenamePreview(presets) {
  const style = String(presets.filenameStyle || "detailed");
  if (style === "detailed") return "01_A_white-cat-standing-on.png";
  if (style === "prompt_prefix") return "white-cat-standing-on_01_A.png";
  if (style === "auto_flow") return "V99-S4_A_grey-cat-upside-down.jpeg";
  const sep = presets.filenameTemplateSeparator || "_";
  const pieces = [];
  if (presets.filenameTemplatePrefix) pieces.push(presets.filenameTemplatePrefix);
  if (presets.filenameTemplateIndex !== "none") pieces.push(presets.filenameTemplateIndex === "n" ? "1" : presets.filenameTemplateIndex === "nnn" ? "001" : "01");
  if (presets.filenameTemplatePromptPart !== "none") pieces.push("white-cat-standing-on");
  if (presets.filenameTemplateDate === "yyyymmdd") pieces.push("20260427");
  if (presets.filenameTemplateDate === "yymmdd_hhmm") pieces.push("260427_1430");
  if (presets.filenameTemplateSuffix === "rand4") pieces.push("a7f2");
  if (presets.filenameTemplateSuffix === "rand8") pieces.push("a7f2c91b");
  const body = pieces.length ? pieces.join(sep) : "V99-S1_white-cat-standing-on";
  return `${body}.png`;
}

function field(labelText, control) {
  return [el("label", { text: labelText }), control];
}

function subheader(iconName, text) {
  return el("div", { class: "settings-subheader wide" }, icon(iconName), el("span", { text }));
}

function select(id, value, options, settingKey) {
  return el("select", { id, data: { settingKey } },
    options.map(([optionValue, label]) => el("option", {
      value: String(optionValue),
      attrs: { value: String(optionValue), selected: String(value) === String(optionValue) }
    }, label))
  );
}

function numberInput(id, value, settingKey, attrs = {}) {
  return el("input", { id, value: String(value ?? ""), class: "input-short", data: { settingKey }, attrs: { type: "number", ...attrs } });
}

function textInput(id, value, settingKey, placeholder = "") {
  return el("input", { id, value: String(value ?? ""), data: { settingKey }, attrs: { type: "text", placeholder } });
}

function checkInput(id, checked, settingKey) {
  return el("input", { id, checked, data: { settingKey }, attrs: { type: "checkbox" } });
}

function controlGroup(...kids) {
  return el("div", { class: "control-group" }, kids);
}

function filenameRow(labelText, control) {
  return el("div", { class: "filename-template-row" }, el("label", { text: labelText }), control);
}

function maintenanceButton(id, iconName, text, tone) {
  return el(
    "button",
    { id, class: `maintenance-btn ${tone}`, attrs: { type: "button" } },
    icon(iconName),
    el("span", { class: "maintenance-btn-label", text })
  );
}

function diagGroup(title, group, labels, hint = "") {
  return el("div", { class: "diag-suite-button-group", data: { suiteGroup: group } },
    el("div", { class: "diag-suite-button-group-title", text: title }),
    el("div", { class: "diag-suite-button-list" }, labels.map((label) => el("button", { class: "small-btn", attrs: { type: "button" }, text: label }))),
    hint ? el("div", { class: "diag-suite-hint", text: hint }) : null
  );
}

function diagDetails(title, group, labels) {
  return el("details", { class: "diag-suite-button-group", data: { suiteGroup: group } },
    el("summary", { class: "diag-suite-button-group-title", text: title }),
    el("div", { class: "diag-suite-button-list" }, labels.map((label) => el("button", { class: "small-btn", attrs: { type: "button" }, text: label })))
  );
}

function renderQueueList(items) {
  const queueList = el("div", { class: "queue-list", id: "queueList" });
  const groups = queueGroups(visibleQueueItems(items));
  if (!groups.length) {
    queueList.appendChild(el("div", { class: "gallery-empty", text: "No prompts queued." }));
    return queueList;
  }

  for (const group of groups.slice(0, 80)) {
    const first = group.items[0] || {};
    queueList.appendChild(el("div", { class: `queue-row is-${group.statusClass}` },
      icon(first.mode === FLOW_MODES.textToImage ? "image" : "movie"),
      el("span", { class: "q-copy" },
        el("span", { class: "q-title", text: group.title }),
        el("span", { class: "q-prompt", text: group.preview })
      ),
      el("span", { class: "q-status", text: group.statusLabel, attrs: { title: group.statusTitle } }),
      el("button", { class: "queue-row-btn", data: { queueAction: "remove", queueId: group.id }, attrs: { type: "button" } }, icon("close"))
    ));
  }
  return queueList;
}

function queueGroups(items = [], options = {}) {
  const grouped = new Map();
  const locale = options.locale || "en";
  for (const item of visibleQueueItems(items || [])) {
    const id = String(item.jobId || item.batchId || item.groupId || item.id || "").trim();
    if (!id) continue;
    if (!grouped.has(id)) grouped.set(id, { id, items: [] });
    grouped.get(id).items.push(item);
  }
  return [...grouped.values()].map((group) => {
    const first = group.items[0] || {};
    const queueRunning = options.queueRunning === true;
    return {
      ...group,
      queueRunning,
      title: first.jobTitle || `${modeLabel(first.mode, locale)} - ${group.items.length} prompt${group.items.length === 1 ? "" : "s"}`,
      preview: first.prompt || first.id || "Untitled job",
      statusClass: groupStatusClass(group.items, { queueRunning }),
      statusLabel: groupStatusLabel(group.items, { queueRunning }),
      statusTitle: group.items.map((item) => `${item.status || "pending"}: ${item.prompt || item.id || ""}`).join("\n")
    };
  });
}

function visibleQueueItems(items = []) {
  return (items || []).filter((item) => item?.hiddenFromLiveQueue !== true && item?.generationRepair !== true);
}

function modeLabel(mode = "", locale = "en") {
  const keyMap = {
    [FLOW_MODES.textToImage]: "createImage",
    [FLOW_MODES.imageToVideo]: "frameToVideo",
    [FLOW_MODES.textToVideo]: "textToVideo",
    [FLOW_MODES.ingredientsToVideo]: "ingredients",
  };
  const key = keyMap[mode];
  return key ? translate(key, {}, locale) : translate("appName", {}, locale);
}

function modeIconName(mode = "") {
  if (mode === FLOW_MODES.textToImage) return "palette";
  if (mode === FLOW_MODES.imageToVideo) return "image";
  if (mode === FLOW_MODES.textToVideo) return "videocam";
  if (mode === FLOW_MODES.ingredientsToVideo) return "grid_view";
  return "auto_awesome";
}

function modeAccentClass(mode = "") {
  if (mode === FLOW_MODES.textToImage) return "is-create-image";
  if (mode === FLOW_MODES.imageToVideo) return "is-frame-to-video";
  if (mode === FLOW_MODES.textToVideo) return "is-text-to-video";
  if (mode === FLOW_MODES.ingredientsToVideo) return "is-ingredients";
  return "is-default-mode";
}

function groupStatusClass(items = [], options = {}) {
  if (items.some((item) => ["failed", "blocked", "download_failed"].includes(liveQueueEffectiveStatus(item, options)))) return "error";
  if (items.some((item) => ["starting", "submitting", "generating", "downloading", "retrying"].includes(liveQueueEffectiveStatus(item, options)))) return "running";
  if (items.some((item) => ["download_incomplete", "partial"].includes(liveQueueEffectiveStatus(item, options)))) return "warning";
  if (items.length && items.every((item) => ["complete", "done"].includes(liveQueueEffectiveStatus(item, options)))) return "done";
  return "pending";
}

function groupStatusLabel(items = [], options = {}) {
  const total = items.length;
  const statuses = items.map((item) => liveQueueEffectiveStatus(item, options));
  const failed = statuses.filter((status) => ["failed", "blocked", "download_failed"].includes(status)).length;
  const incomplete = statuses.filter((status) => status === "download_incomplete").length;
  const partial = statuses.filter((status) => status === "partial").length;
  const retrying = statuses.filter((status) => status === "retrying").length;
  const done = statuses.filter((status) => ["complete", "done"].includes(status)).length;
  const running = statuses.filter((status) => ["starting", "submitting", "generating", "downloading", "retrying"].includes(status)).length;
  if (failed) return `${failed} failed`;
  if (retrying) return `${retrying} retrying`;
  if (running) return `${running} running`;
  if (incomplete) return `${incomplete} missing download`;
  if (partial) return `${partial} partial`;
  if (done && done === total) return "done";
  if (done) return `${done}/${total} done`;
  return `${total} prompt${total === 1 ? "" : "s"}`;
}

function galleryTab(tab, label, active, count, iconName) {
  return el("button", {
    class: `gallery-subtab${active === tab ? " active" : ""}`,
    data: { gallery: tab },
    attrs: { type: "button" }
  }, icon(iconName), el("span", { text: label }), el("span", { class: "gallery-tab-count", text: String(count) }));
}

function galleryLayoutButton(mode, active, iconName, title) {
  return el("button", {
    class: `gallery-layout-btn${active === mode ? " active" : ""}`,
    data: { galleryView: mode },
    attrs: { type: "button", title, "aria-pressed": active === mode ? "true" : "false" }
  }, icon(iconName));
}

function gallerySizeButton(size, active, label) {
  return el("button", {
    class: `gallery-layout-btn${active === size ? " active" : ""}`,
    data: { gallerySize: size },
    attrs: { type: "button", "aria-pressed": active === size ? "true" : "false" },
    text: label
  });
}

function renderGalleryHeader(active, state, activeCount, activeSelectedCount, selectedVideos, locale) {
  const isVideos = active === "videos";
  return el("div", { class: "gallery-header" },
    el("div", { class: "gallery-controls" },
      isVideos
        ? select("videoDownloadRes", state.control.presets.videoDownloadResolution, [["720p", "720p"], ["1080p", "1080p"], ["4k", "4K (50 credits)"]], "videoDownloadResolution")
        : select("downloadResolution", state.control.presets.imageAutoDownloadResolution, [["1k", "1K"], ["2k", "2K"], ["4k", "4K"]], "imageAutoDownloadResolution"),
      el("button", { id: "gallery-sync-btn", class: "scan-btn-gold", attrs: { type: "button", title: isVideos ? "Scroll Flow and scan generated videos" : "Scroll Flow and scan generated images" } }, icon("manage_search"), el("span", { text: translate("scanAll", {}, locale) })),
      !isVideos ? el("button", { id: "importGalleryImagesBtn", attrs: { type: "button", title: "Import local images into Gallery" } }, icon("upload"), el("span", { text: translate("importImages", {}, locale) })) : null,
      !isVideos ? el("input", { id: "galleryImportInput", attrs: { type: "file", accept: "image/*", multiple: true, hidden: true } }) : null,
      !isVideos ? el("button", { class: "inline-help-tip", data: { galleryHelp: "import" }, attrs: { type: "button", title: translate("galleryImportTip", {}, locale) }, text: "?" }) : null,
      select(isVideos ? "videoSortOrder" : "imageSortOrder", state.ui.gallerySortOrder || "num-asc", [["default", "Newest First"], ["num-asc", "1 -> 99"], ["num-desc", "99 -> 1"], ["az", "A -> Z"], ["za", "Z -> A"]], "gallerySortOrder"),
      el("span", { id: isVideos ? "videoGalleryCount" : "galleryCount", text: `${activeCount} ${translate(isVideos ? "videos" : "images", {}, locale)}` })
    ),
    isVideos ? renderVideoPlaybackToolbar(selectedVideos, state, locale) : null,
    el("div", { class: "gallery-actions gallery-selection-actions" },
      el("button", { id: isVideos ? "gallery-random-videos-btn" : "gallery-random-pick-btn", attrs: { type: "button", disabled: activeCount ? null : "disabled", title: "Randomly select one media item per prompt group" } }, icon("casino"), el("span", { text: translate("randomPick", {}, locale) })),
      !isVideos ? el("button", { id: "gallery-pick-matched-btn", attrs: { type: "button", disabled: activeCount ? null : "disabled", title: "Select items with matching prompt groups" } }, icon("auto_fix_high"), el("span", { text: translate("pickMatched", {}, locale) })) : null,
      !isVideos ? el("button", { class: "inline-help-tip", data: { galleryHelp: "matched" }, attrs: { type: "button", title: translate("galleryMatchedTip", {}, locale) }, text: "?" }) : null,
      el("button", { id: "gallery-select-all-btn", attrs: { type: "button", disabled: activeCount ? null : "disabled", title: `Select all visible ${isVideos ? "videos" : "images"}` } }, icon("select_all"), el("span", { text: translate("selectAll", {}, locale) })),
      el("button", { id: "gallery-deselect-all-btn", attrs: { type: "button", disabled: activeSelectedCount ? null : "disabled", title: "Clear selected media" } }, icon("deselect"), el("span", { text: translate("deselectAll", {}, locale) })),
      el("button", { class: "inline-help-tip", data: { galleryHelp: "selection" }, attrs: { type: "button", title: translate("gallerySelectionTip", {}, locale) }, text: "?" })
    ),
    renderGalleryInlineHelp(state, locale),
    el("div", { class: "gallery-actions" },
      el("button", { id: "gallery-download-btn", attrs: { type: "button", disabled: activeSelectedCount ? null : "disabled" } }, icon("download"), el("span", { text: translate("download", {}, locale) }), el("span", { id: "gallery-download-count", text: `(${activeSelectedCount})` })),
      isVideos
        ? el("button", { id: "gallery-send-scenes-btn", attrs: { type: "button", disabled: selectedVideos ? null : "disabled" } }, icon("architecture"), el("span", { text: translate("sceneBuilder", {}, locale) }), el("span", { data: { scenesCount: "1" }, text: `(${selectedVideos})` }))
        : el("button", { id: "gallery-animate-images-btn", attrs: { type: "button", disabled: activeCount ? null : "disabled" } }, icon("video_library"), el("span", { text: translate("animateImages", {}, locale) }))
    )
  );
}

function renderGalleryInlineHelp(state, locale = "en") {
  const key = String(state.ui.galleryHelpKey || "");
  const copy = {
    import: translate("galleryImportHelp", {}, locale),
    matched: translate("galleryMatchedHelp", {}, locale),
    selection: translate("gallerySelectionHelp", {}, locale),
  }[key];
  if (!copy) return null;
  return el("div", { id: "galleryInlineHelpPanel", class: "gallery-inline-help-panel" },
    el("span", { text: copy }),
    el("button", { id: "galleryHelpCloseBtn", attrs: { type: "button", title: translate("close", {}, locale) }, text: translate("close", {}, locale) })
  );
}

function renderVideoPlaybackToolbar(selectedVideos, state, locale = "en") {
  const speed = String(state.ui.videoSpeed || "1");
  const volume = String(state.ui.videoVolume || "0.05");
  return el("div", { class: "gallery-toolbar-row" },
    el("div", { class: "video-playback-group" },
      el("label", { text: translate("speedLabel", {}, locale) }),
      el("input", { id: "videoSpeedSlider", attrs: { type: "range", min: "0.25", max: "6", step: "0.05", value: speed } }),
      el("input", { id: "videoSpeedInput", class: "video-speed-input", value: speed, attrs: { type: "text", inputmode: "decimal", "aria-label": "Video speed" } }),
      el("label", { text: translate("volLabel", {}, locale) }),
      el("input", { id: "videoVolumeSlider", attrs: { type: "range", min: "0", max: "1", step: "0.05", value: volume } })
    ),
    el("div", { class: "gallery-toolbar-spacer" }),
    el("button", { id: "gallery-send-scenes-top-btn", class: "video-toolbar-action", attrs: { type: "button", disabled: selectedVideos ? null : "disabled" } }, icon("architecture"), el("span", { text: translate("sceneBuilder", {}, locale) }), el("span", { data: { scenesCount: "1" }, text: `(${selectedVideos})` }))
  );
}

function renderGalleryHowTo(active, locale = "en") {
  if (active !== "images") return null;
  return el("details", { id: "galleryHowTo", class: "gallery-how-to" },
    el("summary", null,
      icon("help_outline"),
      el("span", { text: translate("howToUse", {}, locale) }),
      el("span", { class: "workflow-click-expand", text: translate("clickToExpand", {}, locale) })
    ),
    el("div", { class: "gallery-how-to-body" },
      el("strong", { text: translate("i2vWorkflowLabel", {}, locale) }),
      el("br"),
      el("span", { text: translate("galleryWorkflowStep1", {}, locale) }),
      el("br"),
      el("span", { text: translate("galleryWorkflowStep2", {}, locale) }),
      el("br"),
      el("span", { text: translate("galleryWorkflowStep3", {}, locale) })
    )
  );
}

function renderLiveQueueGallery(state, selected = new Set(), options = {}) {
  const locale = state.control?.presets?.language || "en";
  const allGroups = queueGroups(state.queue.items, { queueRunning: state.queue?.running === true, locale });
  const activeGroups = allGroups.filter((group) => group.statusClass !== "done");
  const groups = options.showAllGroups
    ? (activeGroups.length ? activeGroups : allGroups)
    : (activeGroups.length ? activeGroups : allGroups.slice(-1)).slice(-1);
  return el("div", { id: "liveQueueContainer", class: "live-queue-wrap" },
    renderLiveQueueManager(state, locale),
    groups.length
      ? groups.map((group) => el("div", { class: `live-queue-group is-${group.statusClass}` },
        renderLiveQueueStage(group, locale),
        el("div", { class: "live-queue-row live-queue-group-head" },
          icon(group.items[0]?.mode === FLOW_MODES.textToImage ? "image" : "movie"),
          el("span", { class: "q-copy" },
            el("span", { class: "q-title", text: group.title }),
            el("span", { class: "q-prompt", text: group.preview })
          ),
          el("span", { class: "q-status", text: group.statusLabel })
        ),
        el("div", { class: "live-queue-task-list" },
          group.items.map((item, index) => renderLiveQueueTaskRow(item, index, selected, { queueRunning: group.queueRunning }, locale))
        )
      ))
      : el("div", { class: "gallery-empty", text: translate("noLiveQueueItems", {}, locale) })
  );
}

function renderLiveQueueManager(state, locale = "en") {
  const items = visibleQueueItems(state.queue.items || []);
  const doneCount = items.filter((item) => ["complete", "done", "failed", "blocked", "download_failed", "download_incomplete"].includes(liveQueueEffectiveStatus(item))).length;
  const blockedCount = items.filter((item) => ["failed", "blocked", "download_failed"].includes(liveQueueEffectiveStatus(item))).length;
  const incompleteDownloadCount = items.filter((item) => liveQueueEffectiveStatus(item) === "download_incomplete").length;
  const openCount = Math.max(0, items.length - doneCount);
  return el("div", { class: "live-queue-manager" },
    el("div", { class: "live-queue-manager-copy" },
      el("strong", { text: translate("queueManager", {}, locale) }),
      el("span", { text: `${items.length} total - ${openCount} active - ${doneCount} finished${blockedCount ? ` - ${blockedCount} need attention` : ""}${incompleteDownloadCount ? ` - ${incompleteDownloadCount} missing download` : ""}` })
    ),
    el("div", { class: "live-queue-manager-actions" },
      el("button", { id: "liveQueueResumeBtn", attrs: { type: "button", disabled: blockedCount ? null : "disabled", title: "Resume blocked or failed tasks" } }, icon("play_arrow"), el("span", { text: translate("resume", {}, locale) })),
      el("button", { id: "liveQueueStopBtn", attrs: { type: "button", disabled: state.queue.running ? null : "disabled", title: "Stop the running queue" } }, icon("stop"), el("span", { text: translate("stop", {}, locale) })),
      el("button", { id: "liveQueueClearDoneBtn", attrs: { type: "button", disabled: doneCount ? null : "disabled", title: "Clear completed, failed, and blocked tasks" } }, icon("playlist_remove"), el("span", { text: translate("clearFinished", {}, locale) })),
      el("button", { id: "liveQueueClearAllBtn", class: "danger-soft", attrs: { type: "button", disabled: items.length ? null : "disabled", title: "Stop and clear the full queue" } }, icon("delete_sweep"), el("span", { text: translate("clearQueue", {}, locale) }))
    )
  );
}

function renderLiveQueueStage(group = {}, locale = "en") {
  const first = group.items?.[0] || {};
  const activeStatus = dominantLiveQueueStatus(group.items || [], { queueRunning: group.queueRunning === true });
  const requestedSubmitPath = String(first.submitPath || first.submitPathPreference || "api_first");
  const effectiveSubmitPath = String(first.submitPathPreference || requestedSubmitPath);
  const isApi = requestedSubmitPath !== "dom_first";
  const repairActive = requestedSubmitPath === "dom_first" && effectiveSubmitPath !== requestedSubmitPath;
  const progress = liveQueueGroupProgress(group.items || []);
  const stage = liveQueueStageMeta(activeStatus, isApi, progress, locale);
  const percent = progress.expectedCount ? Math.min(100, Math.round((progress.resultCount / progress.expectedCount) * 100)) : 0;
  return el("div", { class: `live-queue-stage is-${activeStatus}` },
    el("div", { class: "live-stage-orb" },
      el("span", { class: `live-stage-icon ${["submitting", "generating", "downloading", "retrying"].includes(activeStatus) ? "is-active" : ""}` }, icon(stage.icon))
    ),
    el("div", { class: "live-stage-copy" },
      el("strong", { class: "live-stage-title", text: stage.title }),
      el("span", { class: "live-stage-desc", text: stage.detail }),
      el("span", { class: `live-stage-mode-pill ${isApi ? "is-api" : "is-dom"}` },
        icon(isApi ? "cloud_sync" : "ads_click"),
        el("b", { text: isApi ? translate("apiPath", {}, locale) : translate("domPath", {}, locale) }),
        el("em", { text: repairActive ? translate("browserRunWithRepair", {}, locale) : (isApi ? translate("backendRun", {}, locale) : translate("browserRun", {}, locale)) })
      ),
      el("div", { class: "live-stage-progress", attrs: { "aria-label": `${progress.resultCount}/${progress.expectedCount}` } },
        el("span", { style: { width: `${percent}%` } })
      ),
      el("small", { text: `${progress.resultCount}/${progress.expectedCount} outputs${progress.savedCount ? ` - ${progress.savedCount} saved` : ""}` })
    ),
    el("div", { class: "live-stage-steps" },
      liveQueueStep("keyboard", translate("submitting", {}, locale), ["starting", "submitting"].includes(activeStatus)),
      liveQueueStep("auto_awesome_motion", translate("generating", {}, locale), ["generating"].includes(activeStatus)),
      liveQueueStep("restart_alt", "Retry", ["retrying"].includes(activeStatus)),
      liveQueueStep("download", translate("saving", {}, locale), ["downloading"].includes(activeStatus)),
      liveQueueStep("check_circle", translate("done", {}, locale), ["complete", "done"].includes(activeStatus))
    )
  );
}

function liveQueueGroupProgress(items = []) {
  return items.reduce((total, item) => {
    const progress = liveQueueProgress(item);
    return {
      resultCount: total.resultCount + progress.resultCount,
      expectedCount: total.expectedCount + progress.expectedCount,
      savedCount: total.savedCount + liveQueueSavedCount(item)
    };
  }, { resultCount: 0, expectedCount: 0, savedCount: 0 });
}

function dominantLiveQueueStatus(items = [], options = {}) {
  const statuses = items.map((item) => liveQueueEffectiveStatus(item, options));
  if (statuses.some((status) => ["failed", "blocked", "download_failed"].includes(status))) return "blocked";
  if (statuses.includes("downloading")) return "downloading";
  if (statuses.includes("retrying")) return "retrying";
  if (statuses.includes("partial")) return "partial";
  if (statuses.includes("generating")) return "generating";
  if (statuses.includes("submitting")) return "submitting";
  if (statuses.includes("starting")) return "starting";
  if (statuses.includes("download_incomplete")) return "download_incomplete";
  if (statuses.length && statuses.every((status) => ["complete", "done"].includes(status))) return "complete";
  return "pending";
}

function liveQueueStageMeta(status, isApi, progress = {}, locale = "en") {
  const t = (key) => translate(key, {}, locale);
  if (status === "starting") {
    return {
      icon: "hourglass_top",
      title: isApi ? t("stageStartingApi") : t("stageStartingBrowser"),
      detail: isApi ? t("stageStartingApiDetail") : t("stageStartingBrowserDetail"),
    };
  }
  if (status === "submitting") {
    return { icon: "keyboard", title: t("stageSubmittingTitle"), detail: t("stageSubmittingDetail") };
  }
  if (status === "generating") {
    if (progress.resultCount >= progress.expectedCount && progress.expectedCount > 0) {
      return { icon: "download", title: t("stagePreparingDownload"), detail: t("stagePreparingDownloadDetail") };
    }
    return {
      icon: "auto_awesome_motion",
      title: isApi ? t("stageGeneratingApi") : t("stageGeneratingDom"),
      detail: isApi ? t("stageGeneratingApiDetail") : t("stageGeneratingDomDetail"),
    };
  }
  if (status === "downloading") {
    return { icon: "download", title: t("stageSavingOutputs"), detail: t("stageSavingDetail") };
  }
  if (status === "retrying") {
    return { icon: "restart_alt", title: t("stageRetryingMissingOutputs"), detail: t("stageRetryingMissingOutputsDetail") };
  }
  if (status === "partial") {
    return { icon: "rule", title: t("stagePartialOutputs"), detail: t("stagePartialOutputsDetail") };
  }
  if (status === "download_failed") {
    return { icon: "error", title: t("stageDownloadFailed"), detail: t("stageDownloadFailedDetail") };
  }
  if (status === "download_incomplete") {
    return { icon: "download_for_offline", title: t("stageDownloadIncomplete"), detail: t("stageDownloadIncompleteDetail") };
  }
  if (status === "complete" || status === "done") {
    return { icon: "check_circle", title: t("stageRunComplete"), detail: t("stageRunCompleteDetail") };
  }
  if (status === "failed" || status === "blocked") {
    return { icon: "error", title: t("queueNeedsAttention"), detail: t("stageBlockedDetail") };
  }
  return { icon: "schedule", title: t("stageQueued"), detail: t("stageQueuedDetail") };
}

function liveQueueStep(iconName, label, active) {
  return el("span", { class: `live-stage-step${active ? " active" : ""}` },
    el("span", { class: "live-stage-step-icon" }, icon(iconName)),
    el("small", { text: label })
  );
}

function renderLiveQueueTaskRow(item = {}, index = 0, selected = new Set(), options = {}, locale = "en") {
  const status = liveQueueEffectiveStatus(item, options);
  const label = liveQueueStatusLabel(item, options);
  const prompt = String(item.prompt || item.id || "Untitled task");
  const { resultCount, expectedCount } = liveQueueProgress(item);
  const thumb = liveQueueTaskThumb(item, locale);
  // For failed/blocked rows surface the FULL error message as a tooltip so
  // users can hover the compact label ("403 error") to see the verbose
  // backend payload that drove the truncation.
  const isErrorState = status === "failed" || status === "blocked";
  const activityTitle = isErrorState ? (liveQueueErrorTooltip(item) || label) : label;
  return el("div", { class: `live-queue-task is-${groupStatusClass([item], options)}` },
    el("span", { class: "live-task-index", text: String(index + 1).padStart(2, "0") }),
    el("span", { class: "live-task-main" },
      thumb,
      el("span", { class: "live-task-prompt", attrs: { title: prompt }, text: prompt })
    ),
    renderLiveQueueOutputStrip(item, selected, locale),
    el("span", { class: `live-task-activity${isErrorState ? " is-error" : ""}`, attrs: { title: activityTitle }, text: label }),
    el("span", { class: "live-task-progress", text: `${Math.min(resultCount, expectedCount)}/${expectedCount}` }),
    el("span", { class: `live-task-dot status-${status}` })
  );
}

function liveQueueTaskThumb(item = {}, locale = "en") {
  const refPreviews = liveQueueInputReferencePreviews(item);
  if (refPreviews.length > 1) {
    const visibleRefs = refPreviews.slice(0, 3);
    return el("span", { class: "live-task-ref-strip", attrs: { title: `${refPreviews.length} input reference${refPreviews.length === 1 ? "" : "s"}` } },
      visibleRefs.map((preview, index) => el("button", {
        class: "live-task-ref-thumb",
        data: { livePreviewUrl: preview.src, livePreviewKind: preview.kind, livePreviewTitle: `${preview.title} ${index + 1}` },
        attrs: { type: "button", title: translate("doubleClickToPreview", {}, locale) }
      }, liveQueuePreviewMedia(preview, "thumb"))),
      refPreviews.length > visibleRefs.length ? el("span", { class: "live-task-ref-more", text: `+${refPreviews.length - visibleRefs.length}` }) : null
    );
  }
  if (item.mode === FLOW_MODES.textToImage && !refPreviews.length) return null;
  const preview = liveQueuePrimaryPreview(item);
  if (preview.src) {
    return el("button", {
      class: "live-task-thumb",
      data: { livePreviewUrl: preview.src, livePreviewKind: preview.kind, livePreviewTitle: preview.title },
      attrs: { type: "button", title: translate("doubleClickToPreview", {}, locale) }
    },
      liveQueuePreviewMedia(preview, "thumb")
    );
  }
  return el("span", { class: "live-task-thumb empty" }, icon(item.mode === FLOW_MODES.textToImage ? "image" : "movie"));
}

function liveQueuePrimaryPreview(item = {}) {
  return liveQueueInputPreview(item);
}

function liveQueueInputReferencePreviews(item = {}) {
  const refs = []
    .concat(Array.isArray(item.refInputs) ? item.refInputs : [])
    .concat(item.startRefInput ? [item.startRefInput] : [])
    .concat(item.endRefInput ? [item.endRefInput] : []);
  const seen = new Set();
  return refs
    .map((ref, index) => {
      const src = ref?.imageUrl || ref?.dataUrl || ref?.mediaUrl || "";
      const id = String(ref?.mediaId || ref?.assetImageId || ref?.id || ref?.blobStoreId || src || `${index}`).trim();
      if (!src || seen.has(id)) return null;
      seen.add(id);
      return {
        src,
        kind: "images",
        mediaId: id,
        galleryId: id,
        title: String(ref?.title || ref?.fileName || item.prompt || item.id || "Input reference")
      };
    })
    .filter(Boolean);
}

function liveQueueInputPreview(item = {}) {
  const refPreview = liveQueueInputReferencePreviews(item).find((preview) => preview.src);
  const refSrc = refPreview?.src || "";
  const src = refSrc || item.imageUrl || item.thumbnailUrl || "";
  return {
    src,
    kind: "images",
    mediaId: refPreview?.mediaId || item.mediaId || "",
    galleryId: refPreview?.galleryId || item.galleryId || "",
    title: String(item.prompt || item.id || "Input reference")
  };
}

function renderLiveQueueOutputStrip(item = {}, selected = new Set(), locale = "en") {
  const { expectedCount } = liveQueueProgress(item);
  const slots = liveQueueOutputSlots(item);
  if (!slots.some(Boolean)) {
    return el("span", { class: `live-output-strip is-empty${expectedCount > 1 ? " is-multi" : ""}` },
      Array.from({ length: Math.min(expectedCount, 4) }, (_, index) => (
        el("span", { class: "live-output-slot empty", attrs: { "aria-label": `Waiting for output ${index + 1}` } }, icon("hourglass_empty"))
      ))
    );
  }
  return el("span", { class: `live-output-strip${slots.length > 1 ? " is-multi" : ""}` },
    slots.slice(0, 6).map((preview, index) => preview
      ? el("button", {
          class: `live-output-slot${selected.has(preview.galleryId) ? " selected" : ""}`,
          data: {
            galleryId: preview.galleryId,
            livePreviewUrl: preview.previewUrl || preview.src,
            livePreviewKind: preview.kind,
            livePreviewTitle: `${preview.title} ${index + 1}`
          },
          attrs: { type: "button", title: translate("doubleClickToPreview", {}, locale) }
        }, liveQueuePreviewMedia(preview, "output"))
      : el("span", { class: "live-output-slot empty", attrs: { "aria-label": `Waiting for output ${index + 1}` } }, icon("hourglass_empty"))
    ),
    slots.length > 6 ? el("span", { class: "live-output-more", text: `+${slots.length - 6}` }) : null
  );
}

function liveQueueOutputSlots(item = {}) {
  const { expectedCount } = liveQueueProgress(item);
  const slotCount = Math.max(1, expectedCount);
  const slots = Array.from({ length: slotCount }, () => null);
  for (const preview of liveQueueOutputPreviews(item)) {
    const preferred = Number.isFinite(Number(preview.mediaIndex)) ? Number(preview.mediaIndex) : -1;
    const target = preferred >= 0 && preferred < slotCount && !slots[preferred]
      ? preferred
      : slots.findIndex((slot) => !slot);
    if (target < 0) break;
    slots[target] = preview;
  }
  return slots;
}

function liveQueueOutputPreviews(item = {}) {
  const kind = liveQueueIsVideoItem(item) ? "videos" : "images";
  const title = String(item.prompt || item.id || "Generated media");
  const isVideo = kind === "videos";
  const outputs = (Array.isArray(item.outputs) ? item.outputs : [])
    .filter((output) => !isVideo || liveQueueVideoOutputReady(output, item))
    .map((output) => ({
      src: liveQueueOutputThumbSrc(output, item, kind),
      previewUrl: isVideo ? liveQueueOutputMediaUrl(output, item) : "",
      thumbnailOnly: isVideo,
      kind,
      title,
      mediaId: output?.mediaId || "",
      mediaIndex: Number.isFinite(Number(output?.mediaIndex)) ? Number(output.mediaIndex) : -1,
      galleryId: output?.id || `${item.id}:${output?.mediaId || ""}`
    }))
    .filter((preview) => preview.src);
  if (outputs.length) return outputs;
  const statusRowPreviews = (Array.isArray(item.statusRows) ? item.statusRows : [])
    .filter((row) => !isVideo || liveQueueVideoOutputReady(row, item))
    .filter((row) => isVideo || ["complete", "pending"].includes(String(row?.status || "").toLowerCase()))
    .map((row, index) => {
      const mediaId = String(row?.id || row?.mediaId || "").trim();
      const src = liveQueueOutputThumbSrc(row, item, kind);
      return {
        src,
        previewUrl: isVideo ? liveQueueOutputMediaUrl(row, item) : "",
        thumbnailOnly: isVideo,
        kind,
        title,
        mediaId,
        mediaIndex: Number.isFinite(Number(row?.mediaIndex)) ? Number(row.mediaIndex) : index,
        galleryId: `${item.id}:${mediaId || index}`
      };
    })
    .filter((preview) => preview.src);
  if (statusRowPreviews.length) return statusRowPreviews;
  if (isVideo && !liveQueueVideoOutputReady({}, item)) return [];
  const referenceIds = new Set([
    ...(Array.isArray(item.refMediaIds) ? item.refMediaIds : []),
    item.startMediaId,
    item.endMediaId
  ].map((id) => String(id || "").trim()).filter(Boolean));
  return [...new Set((item.mediaIds || []).map((id) => String(id || "").trim()).filter((id) => id && !referenceIds.has(id)))]
    .slice(0, liveQueueProgress(item).expectedCount)
    .map((mediaId, index) => ({
      src: isVideo ? buildMediaThumbnailUrl({ mediaId }) : buildMediaRedirectUrl({ mediaId }),
      previewUrl: isVideo ? buildMediaRedirectUrl({ mediaId }) : "",
      thumbnailOnly: isVideo,
      kind,
      title,
      mediaId,
      mediaIndex: index,
      galleryId: `${item.id}:${mediaId}`
    }));
}

function liveQueueVideoOutputReady(source = {}, item = {}) {
  const status = String(source?.status || item?.status || "").toLowerCase();
  const rawStatus = String(source?.rawStatus || "").toUpperCase();
  const downloadStatus = String(source?.downloadStatus || "").toLowerCase();
  return Boolean(
    ["complete", "done", "download_incomplete"].includes(status) ||
    rawStatus === "MEDIA_GENERATION_STATUS_SUCCESSFUL" ||
    ["downloaded", "download_failed"].includes(downloadStatus) ||
    source?.downloadedAt
  );
}

function liveQueueOutputThumbSrc(source = {}, item = {}, kind = "images") {
  const mediaId = String(source?.mediaId || source?.id || item?.mediaId || "").trim();
  if (kind === "videos") {
    return normalizeMediaThumbnailUrl(source?.thumbnailUrl || "", mediaId)
      || (mediaId ? buildMediaThumbnailUrl({ mediaId }) : "");
  }
  return normalizeMediaRedirectUrl(source?.thumbnailUrl || source?.mediaUrl || "", mediaId)
    || (mediaId ? buildMediaRedirectUrl({ mediaId }) : "");
}

function liveQueueOutputMediaUrl(source = {}, item = {}) {
  const mediaId = String(source?.mediaId || source?.id || item?.mediaId || "").trim();
  return normalizeMediaRedirectUrl(source?.mediaUrl || "", mediaId)
    || (mediaId ? buildMediaRedirectUrl({ mediaId }) : "");
}

function liveQueuePreview(item = {}) {
  const outputSrc = (Array.isArray(item.outputs) ? item.outputs : [])
    .map((output) => normalizeMediaRedirectUrl(output?.thumbnailUrl || output?.mediaUrl || "", output?.mediaId || ""))
    .find(Boolean);
  const refs = []
    .concat(Array.isArray(item.refInputs) ? item.refInputs : [])
    .concat(item.startRefInput ? [item.startRefInput] : [])
    .concat(item.endRefInput ? [item.endRefInput] : []);
  const src = outputSrc
    || refs.map((ref) => ref?.imageUrl || ref?.dataUrl || ref?.mediaUrl || "").find(Boolean)
    || item.thumbnailUrl
    || item.imageUrl
    || normalizeMediaRedirectUrl(item.mediaUrl || "", item.mediaId || "")
    || (item.mediaIds?.[0] ? buildMediaRedirectUrl({ mediaId: item.mediaIds[0] }) : "");
  return {
    src,
    kind: liveQueueIsVideoItem(item) ? "videos" : "images",
    title: String(item.prompt || item.id || "Generated media")
  };
}

function liveQueuePreviewMedia(preview = {}, size = "thumb") {
  const mediaKey = liveQueuePreviewMediaKey(preview, size);
  if (preview.kind === "videos" && preview.thumbnailOnly) {
    return el("img", {
      class: `live-preview-media live-preview-${size}`,
      data: { liveMediaKey: mediaKey },
      attrs: { src: preview.src, alt: preview.title || "Generated video", loading: "eager", decoding: "async", draggable: "false" }
    });
  }
  if (preview.kind === "videos") {
    return el("video", {
      class: `live-preview-media live-preview-${size}`,
      data: { liveMediaKey: mediaKey },
      attrs: { src: preview.src, muted: true, playsinline: true, preload: size === "thumb" ? "metadata" : "none" }
    });
  }
  return el("img", {
    class: `live-preview-media live-preview-${size}`,
    data: { liveMediaKey: mediaKey },
    attrs: { src: preview.src, alt: preview.title || "Preview", loading: "eager", decoding: "async", draggable: "false" }
  });
}

function liveQueuePreviewMediaKey(preview = {}, size = "thumb") {
  return [
    size,
    preview.kind || "",
    preview.thumbnailOnly ? "thumbnail" : "media",
    preview.galleryId || "",
    preview.mediaId || "",
    preview.src || "",
    preview.previewUrl || ""
  ].join("|");
}

function liveQueueIsVideoItem(item = {}) {
  return item.mode !== FLOW_MODES.textToImage || String(item.kind || "").includes("video");
}

function liveQueueProgress(item = {}) {
  const ledger = deriveTaskOutputLedger(item);
  if (liveQueueIsVideoItem(item)) return { resultCount: ledger.resultCount, expectedCount: ledger.expectedCount };
  const resultCount = Number(item.outputs?.length || item.foundImages || item.mediaIds?.length || 0);
  return { resultCount, expectedCount: ledger.expectedCount };
}

function liveQueueSavedCount(item = {}) {
  return deriveTaskOutputLedger(item).savedCount;
}

function liveQueueEffectiveStatus(item = {}, options = {}) {
  const status = String(item.status || "pending");
  const outputLedger = deriveTaskOutputLedger(item);
  const { resultCount, expectedCount } = liveQueueProgress(item);
  const shouldAutoDownload = item?.download?.enabled === true;
  const savedCount = liveQueueSavedCount(item);
  const failedOutputCount = Math.max(outputLedger.failedIds.length, Number(item.failedOutputCount || item.missingOutputCount || 0) || 0);
  const expectedDownloads = outputLedger.expectedDownloadCount || Math.max(0, expectedCount - failedOutputCount);
  const retryStatus = String(item.retryStatus || "").toLowerCase();
  const failedDownloadCount = outputLedger.hasDownloadErrors ? 1 : 0;
  if (status === "pending" && options.queueRunning === true) return "starting";
  if ((status === "complete" || status === "done") && shouldAutoDownload && failedDownloadCount > 0) return "download_failed";
  if ((status === "complete" || status === "done") && resultCount < expectedCount) {
    if (retryStatus === "queued" || retryStatus.includes("repair")) return "retrying";
    return "partial";
  }
  if ((status === "complete" || status === "done") && shouldAutoDownload && savedCount < expectedDownloads) return "downloading";
  return status;
}

function liveQueueStatusLabel(item = {}, options = {}) {
  const status = liveQueueEffectiveStatus(item, options);
  if (status === "starting") return "Starting run";
  if (status === "submitting") return "Typing prompt into Flow";
  if (status === "generating") return "Generating in Flow";
  if (status === "downloading") return "Saving outputs";
  if (status === "retrying") {
    const { resultCount, expectedCount } = liveQueueProgress(item);
    return `Retrying missing outputs (${Math.min(resultCount, expectedCount)}/${expectedCount})`;
  }
  if (status === "partial") {
    const { resultCount, expectedCount } = liveQueueProgress(item);
    return `${Math.min(resultCount, expectedCount)}/${expectedCount} generated - missing output`;
  }
  if (status === "download_failed") return "Download failed";
  if (status === "download_incomplete") return "Download incomplete";
  if (status === "complete" || status === "done") return "Complete";
  if (status === "failed") {
    if (item.failureClass === "prompt_safety") return "Needs prompt edit - skipped";
    if (item.failureClass === "generation_failed") return "Generation failed after retries";
    if (item.failureClass === "media_input") return "Reference/upload failed";
    return compactErrorLabel(item.lastError || item.error || item.reason || "Failed");
  }
  if (status === "blocked") return compactErrorLabel(item.lastError || item.blockerReason || item.error || item.reason || "Needs attention");
  if (status === "waiting") return "Waiting for next prompt";
  return "Queued";
}

// Collapse a verbose API/runtime error into a short label that fits on one
// line in the live queue row. Full message is preserved for the tooltip.
//   "403 PERMISSION_DENIED The caller does not have..." -> "403 error"
//   "Network request failed" -> "Network error"
//   undefined / "" -> "Error"
function compactErrorLabel(message = "") {
  const text = String(message || "").trim();
  if (!text) return "Error";
  // HTTP-like status code at the start of the message?
  const httpMatch = text.match(/\b([1-5]\d{2})\b/);
  if (httpMatch) return `${httpMatch[1]} error`;
  // Common error families — map to a single-word category
  const lower = text.toLowerCase();
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("offline")) return "Network error";
  if (lower.includes("timeout") || lower.includes("timed out")) return "Timeout";
  if (lower.includes("auth") || lower.includes("unauthorized") || lower.includes("unauthenticated")) return "Auth error";
  if (lower.includes("rate") && lower.includes("limit")) return "Rate limited";
  if (lower.includes("quota")) return "Quota error";
  if (lower.includes("safety") || lower.includes("policy")) return "Policy error";
  return "Error";
}

// Full untruncated message for tooltips. Falls through the same property
// preference as liveQueueStatusLabel but without compaction.
function liveQueueErrorTooltip(item = {}) {
  return String(item.lastError || item.error || item.blockerReason || item.reason || "").trim();
}

function galleryGrid(items, selected, gridId, emptyText, viewMode = "grid", refsById = new Map(), defaultRefId = "") {
  const grid = el("div", { id: gridId, class: viewMode === "table" ? "gallery-table-view active" : "gallery-grid gallery-grid-view active" });
  if (!items.length) {
    grid.appendChild(el("div", { class: "gallery-empty", text: emptyText }));
    return grid;
  }
  if (viewMode === "table") {
    const grouped = groupGalleryItems(items);
    for (const [index, group] of grouped.entries()) {
      grid.appendChild(renderGalleryTableGroup(group, selected, index, refsById, defaultRefId));
    }
    return grid;
  }

  const grouped = groupGalleryItems(items);
  for (const group of grouped) {
    grid.appendChild(el("div", { class: `gallery-prompt-group ${group.aspect || ""}` },
      el("div", { class: "gallery-prompt-text" },
        el("span", { text: group.index }),
        el("span", { attrs: { title: group.fullPrompt || group.prompt }, text: group.prompt }),
        el("span", { class: "gallery-group-count", text: String(group.items.length) })
      ),
      el("div", { class: group.kind === "videos" ? "gallery-videos" : "gallery-images" },
        group.items.map((item) => renderGalleryMediaItem(item, selected, refsById, defaultRefId))
      )
    ));
  }
  return grid;
}

export function sortGalleryItems(items = [], order = "num-asc") {
  const indexed = items.map((item, index) => ({ item, index }));
  const title = (item) => String(item.prompt || item.title || item.fileName || item.mediaId || "").trim();
  const firstNumber = (item) => {
    const text = `${item.taskNumber || ""} ${item.jobIndex || ""} ${item.fileName || ""} ${item.title || ""} ${item.prompt || ""}`;
    const match = String(text).match(/\b(\d{1,4})\b/);
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
  };
  const created = (item) => {
    const time = new Date(item.createdAt || item.downloadedAt || item.updatedAt || 0).getTime();
    return Number.isFinite(time) ? time : 0;
  };
  indexed.sort((a, b) => {
    if (order === "az" || order === "za") {
      const value = title(a.item).localeCompare(title(b.item), undefined, { numeric: true, sensitivity: "base" });
      return order === "za" ? -value : value;
    }
    if (order === "num-desc") {
      return (firstNumber(b.item) - firstNumber(a.item)) || (a.index - b.index);
    }
    if (order === "default") {
      return (created(b.item) - created(a.item)) || (b.index - a.index);
    }
    return (firstNumber(a.item) - firstNumber(b.item)) || (a.index - b.index);
  });
  return indexed.map((entry) => entry.item);
}

function isGenericGeneratedTitle(value = "") {
  return /^generated\s+(image|video|media)$/i.test(String(value || "").trim());
}

function galleryPromptLabel(item = {}) {
  const prompt = String(item.prompt || "").trim();
  if (prompt && !isGenericGeneratedTitle(prompt)) return prompt;
  const title = String(item.title || "").trim();
  if (title && !isGenericGeneratedTitle(title)) return title;
  return "";
}

function galleryPromptPreview(text = "", wordLimit = 10) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "Generated media";
  const limit = Math.max(1, Number(wordLimit || 10) || 10);
  return words.length > limit ? `${words.slice(0, limit).join(" ")}...` : words.join(" ");
}

function galleryGroupKey(item = {}) {
  const prompt = galleryPromptLabel(item);
  if (prompt) return `prompt:${prompt.slice(0, 240)}`;
  const taskId = String(item.taskId || "").trim();
  if (taskId) return `task:${taskId}`;
  return `media:${item.kind || "media"}:${item.mediaId || item.id || "unknown"}`;
}

export function groupGalleryItems(items = []) {
  const groups = new Map();
  for (const item of items) {
    const key = galleryGroupKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].map((groupItems, index) => {
    const fullPrompt = galleryPromptLabel(groupItems[0]) || String(groupItems[0]?.mediaId || groupItems[0]?.id || "Generated media");
    return {
      prompt: galleryPromptPreview(fullPrompt, 10),
      fullPrompt,
      index: String(index + 1),
      kind: groupItems.some((item) => item.kind === "videos") ? "videos" : "images",
      aspect: groupItems.some((item) => /portrait|9:16/i.test(String(item.aspectRatio || ""))) ? "portrait" : "",
      items: groupItems
    };
  });
}

function renderGalleryMediaItem(item, selected, refsById = new Map(), defaultRefId = "") {
  const isVideo = item.kind === "videos";
  const isSelected = selected?.has?.(item.id);
  const aspectClass = galleryAspectClass(item);
  const hasPreview = galleryItemHasPreview(item, refsById, defaultRefId);
  const classes = [
    isVideo ? "gallery-video-item" : "gallery-image-item",
    aspectClass,
    isSelected ? "selected" : "",
    hasPreview ? "thumb-ready" : "thumb-unavailable"
  ].filter(Boolean).join(" ");
  const data = { galleryId: item.id };
  if (isVideo && item.mediaUrl) data.videoPreviewUrl = item.mediaUrl;
  return el("button", { class: classes, data, attrs: { type: "button", tabindex: "-1", title: item.title || item.prompt || "Generated media" } },
    renderGalleryMediaPreview(item, refsById, defaultRefId)
  );
}

function galleryItemHasPreview(item = {}, refsById = new Map(), defaultRefId = "") {
  if (item.kind === "videos") return Boolean(distinctGalleryThumbnailUrl(item) || galleryFallbackRefImage(item, refsById, defaultRefId));
  return Boolean(item.mediaUrl || item.thumbnailUrl);
}

function distinctGalleryThumbnailUrl(item = {}) {
  const thumbnailUrl = String(item.thumbnailUrl || "").trim();
  const mediaUrl = String(item.mediaUrl || "").trim();
  const mediaId = String(item.mediaId || "").trim();
  if (!thumbnailUrl) return item.kind === "videos" && mediaId ? buildMediaThumbnailUrl({ mediaId }) : "";
  if (thumbnailUrl === mediaUrl) return item.kind === "videos" && mediaId ? buildMediaThumbnailUrl({ mediaId }) : "";
  return thumbnailUrl;
}

function galleryFallbackRefImage(item = {}, refsById = new Map(), defaultRefId = "") {
  const ids = [
    item.fallbackThumbnailRefId,
    ...(Array.isArray(item.referenceIds) ? item.referenceIds : []),
    defaultRefId
  ].map((id) => String(id || "").trim()).filter(Boolean);
  for (const id of ids) {
    const ref = refsById.get(id);
    const src = ref?.imageUrl || ref?.dataUrl || ref?.mediaUrl || "";
    if (src) return src;
  }
  return "";
}

function renderGalleryMediaPreview(item = {}, refsById = new Map(), defaultRefId = "") {
  const isVideo = item.kind === "videos";
  if (!isVideo) {
    const src = item.mediaUrl || item.thumbnailUrl || "";
    return src
      ? el("img", { attrs: { src, alt: item.title || "Generated media", loading: "lazy", decoding: "async", draggable: "false" } })
      : icon("image");
  }
  const thumbnailUrl = distinctGalleryThumbnailUrl(item);
  if (thumbnailUrl) {
    return el("span", { class: "gallery-video-preview" },
      el("img", { attrs: { src: thumbnailUrl, alt: item.title || "Generated video", loading: "lazy", decoding: "async", draggable: "false" } })
    );
  }
  const refImage = galleryFallbackRefImage(item, refsById, defaultRefId);
  if (refImage) {
    return el("span", { class: "gallery-video-preview gallery-video-preview-ref" },
      el("img", { attrs: { src: refImage, alt: item.title || "Generated video", loading: "lazy", decoding: "async", draggable: "false" } })
    );
  }
  return el("span", { class: "gallery-video-placeholder", attrs: { "aria-label": item.title || "Generated video" } });
}

function galleryAspectClass(item = {}) {
  const raw = `${item.aspectRatio || item.aspect || item.orientation || ""}`.toLowerCase();
  if (/portrait|9:16|3:4|vertical/.test(raw)) return "aspect-portrait";
  if (/square|1:1/.test(raw)) return "aspect-square";
  if (/landscape|16:9|4:3|horizontal/.test(raw)) return "aspect-landscape";
  return "aspect-auto";
}

function renderGalleryTableRow(item, selected, index, refsById = new Map(), defaultRefId = "") {
  const isVideo = item.kind === "videos";
  return el("button", { class: `gallery-table-row${selected?.has?.(item.id) ? " selected" : ""}`, data: { galleryId: item.id }, attrs: { type: "button", tabindex: "-1" } },
    el("span", { class: "gallery-table-index", text: String(index + 1).padStart(2, "0") }),
    el("span", { class: "gallery-table-thumb" },
      renderGalleryMediaPreview(item, refsById, defaultRefId)
    ),
    el("span", { class: "gallery-table-copy" },
      el("span", { class: "gallery-table-title", text: item.title || "Generated media" }),
      el("span", { class: "gallery-table-prompt", text: item.prompt || item.mediaId || "" })
    ),
    el("span", { class: "gallery-table-kind", text: isVideo ? "Video" : "Image" })
  );
}

function renderGalleryTableGroup(group, selected, index, refsById = new Map(), defaultRefId = "") {
  return el("div", { class: "gallery-table-group-row" },
    el("span", { class: "gallery-table-index", text: String(index + 1) }),
    el("span", { class: "gallery-table-group-prompt", attrs: { title: group.prompt }, text: group.prompt }),
    el("span", { class: "gallery-table-thumb-strip" },
      group.items.map((item) => renderGalleryMediaItem(item, selected, refsById, defaultRefId))
    ),
    el("span", { class: "gallery-table-kind", text: String(group.items.length) })
  );
}

function statusClass(status = "") {
  if (["complete", "done"].includes(status)) return "done";
  if (["failed", "blocked"].includes(status)) return "error";
  if (["submitting", "generating"].includes(status)) return "running";
  return "pending";
}

function statusLabel(q) {
  if (q.status === "complete") return "done";
  return q.status || "pending";
}

function promptLines(state) {
  return String(state.control.livePrompt || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Wizard dispatch ────────────────────────────────────────────
// Builds a dispatch(patch) callback for the 10.8 wizard.
// Deep-merges patch into the current state and writes to chrome.storage.local.
// The sidepanel's chrome.storage.onChanged listener (app.js) picks it up and re-renders.
function makeWizardDispatch(currentState) {
  return (patch) => {
    if (!patch || typeof patch !== "object") return;
    const next = deepMergeState(currentState, patch);
    for (const key of Object.keys(currentState)) delete currentState[key];
    Object.assign(currentState, next);
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({ [STORAGE_KEY]: next });
    }
  };
}

function deepMergeState(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    const out = { ...(base && typeof base === "object" ? base : {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = deepMergeState(out[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return patch;
}
