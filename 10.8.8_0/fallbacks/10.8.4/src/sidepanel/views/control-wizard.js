// Auto Flow 10.8 Control tab wizard.
// Renders a 3-step wizard (Prompts / References / Run) inside the Control tab.
// Bound to state.control + state.queue + state.referenceLibrary.
//
// Public API:
//   renderControlWizard(root, state, ctx)
//     root  - HTMLElement (the <section id="view-control"> container)
//     state - full sidepanel state (see runtime-config.js createDefaultState)
//     ctx   - { dispatch, showConfirm } where dispatch is (patch) => void merging
//             into state.control / state.ui / etc, showConfirm is the dialog helper
//
// Wiring is intentionally light for v1: CTAs and navigation update local state,
// Run dispatches a QueueAddJob via ctx.dispatch when the integration is ready.

import { FLOW_MODES } from "../runtime-config.js";
import { translate } from "../i18n.js";
import { splitAutoFlowPromptLine } from "../../core/gallery/animate-prompts.js";

// ── DOM helpers ────────────────────────────────────────────
function el(tag, opts, ...kids) {
  const node = document.createElement(tag);
  if (opts) {
    if (opts.class) node.className = opts.class;
    if (opts.id) node.id = opts.id;
    if (opts.text != null) node.textContent = opts.text;
    if (opts.title) node.title = opts.title;
    if (opts.value != null) node.value = opts.value;
    if (opts.placeholder) node.placeholder = opts.placeholder;
    if (opts.attrs) {
      for (const [k, v] of Object.entries(opts.attrs)) {
        if (v == null || v === false) continue;
        node.setAttribute(k, v === true ? "" : String(v));
      }
    }
    if (opts.style) for (const [k, v] of Object.entries(opts.style)) node.style[k] = v;
    if (opts.data) for (const [k, v] of Object.entries(opts.data)) node.dataset[k] = v;
    if (opts.on) for (const [evt, fn] of Object.entries(opts.on)) node.addEventListener(evt, fn);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return node;
}

const icon = (name) => el("span", { class: "material-symbols-outlined", text: name });
const clear = (root) => { while (root.firstChild) root.removeChild(root.firstChild); };
const pad2 = (n) => String(n).padStart(2, "0");

// Compact "History" jump button for the step header. Click activates the
// History route (ui.activeRoute = "history"). Shows a count badge if there
// are saved runs.
// Compact "Guide" jump button for the step header. Opens the sample prompt
// formats reference in a new tab via the document-level delegated handler in
// app.js (data-action="format-guide"). Lives next to History so the wizard's
// nav cluster keeps both jumps together.
function buildGuideJump(state) {
  return el("button", {
    class: "afw-guide-jump",
    attrs: { type: "button", title: tr(state, "formatGuide") },
    data: { action: "format-guide" },
  },
    icon("article"),
    el("span", { class: "afw-guide-jump-label", text: tr(state, "formatGuide") }),
  );
}

function buildHistoryJump(state, dispatch) {
  const runs = Array.isArray(state.history?.runs) ? state.history.runs : [];
  return el("button", {
    class: "afw-history-jump",
    attrs: {
      type: "button",
      title: runs.length
        ? `${tr(state, "openHistory")} (${runs.length})`
        : tr(state, "openHistory"),
    },
    on: { click: (e) => { stopControlEvent(e); dispatch({ ui: { activeRoute: "history" } }); } },
  },
    icon("history"),
    el("span", { class: "afw-history-jump-label", text: tr(state, "history") }),
    runs.length ? el("span", { class: "afw-history-jump-count", text: String(runs.length) }) : null,
  );
}

const localeFor = (state) => state?.control?.presets?.language || "en";
const tr = (state, key, params = {}) => translate(key, params, localeFor(state));
const modeName = (state, mode) => tr(state, mode?.labelKey || "mode");

// ── Mode → workflow metadata ─────────────────────────────────
const MODES = [
  { key: FLOW_MODES.textToImage,         labelKey: "createImage",   iconName: "palette",   needsRefs: false, defaultModelKey: "imageModel",       defaultAspectKey: "imageAspectRatio", defaultCountKey: "imageRepeatCount",       defaultDownloadResKey: "imageAutoDownloadResolution" },
  { key: FLOW_MODES.textToVideo,         labelKey: "textToVideo",   iconName: "videocam",  needsRefs: false, defaultModelKey: "model",            defaultAspectKey: "aspectRatio",      defaultCountKey: "repeatCount",            defaultDownloadResKey: "videoDownloadResolution" },
  { key: FLOW_MODES.imageToVideo,        labelKey: "frameToVideo",  iconName: "image",     needsRefs: true,  defaultModelKey: "model",            defaultAspectKey: "aspectRatio",      defaultCountKey: "repeatCount",            defaultDownloadResKey: "videoDownloadResolution" },
  { key: FLOW_MODES.ingredientsToVideo,  labelKey: "ingredients",   iconName: "grid_view", needsRefs: true,  defaultModelKey: "ingredientsModel", defaultAspectKey: "aspectRatio",      defaultCountKey: "repeatCount",            defaultDownloadResKey: "videoDownloadResolution" },
];

const REF_LIMITS = Object.freeze({
  [FLOW_MODES.textToImage]: 10,
  [FLOW_MODES.textToVideo]: 0,
  [FLOW_MODES.imageToVideo]: 2,
  [FLOW_MODES.ingredientsToVideo]: 3,
});

const VIDEO_MODEL_OPTIONS = Object.freeze([
  ["default", "Default (Veo 3.1 Lite - Lower Priority)"],
  ["veo3_lite", "Veo 3.1 Lite"],
  ["veo3_lite_low", "Veo 3.1 Lite - Lower Priority"],
  ["veo3_fast", "Veo 3.1 Fast"],
  ["veo3_fast_low", "Veo 3.1 Fast - Lower Priority"],
  ["veo3_quality", "Veo 3.1 Quality"]
]);

const INGREDIENTS_VIDEO_MODEL_OPTIONS = Object.freeze([
  ["veo3_fast_low", "Veo 3.1 Fast - Lower Priority"],
  ["veo3_fast", "Veo 3.1 Fast"]
]);

// Predictable colour palette for ref thumbnails (when no preview URL is stored)
const REF_PALETTES = [
  "linear-gradient(135deg,#2b4a9a,#5fa9ff)",
  "linear-gradient(135deg,#1d2a4a,#7d3fff)",
  "linear-gradient(135deg,#1a1f33,#4f6cff)",
  "linear-gradient(135deg,#3a2c1a,#c98a2e)",
  "linear-gradient(135deg,#3a1422,#ff6f8e)",
  "linear-gradient(135deg,#0a3a3d,#7de5ff)",
];
function paletteFor(id) {
  let h = 0;
  const s = String(id || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return REF_PALETTES[h % REF_PALETTES.length];
}
function glyphFor(name = "") {
  const trimmed = String(name || "").trim();
  return trimmed ? trimmed[0].toUpperCase() : "?";
}

function stopControlEvent(event) {
  event?.preventDefault?.();
  event?.currentTarget?.blur?.();
}

function formatModelLabel(value = "") {
  const raw = String(value || "").trim();
  const labels = {
    default: "Default",
    nano_banana_pro: "Nano Banana Pro",
    nano_banana_2: "Nano Banana 2",
    imagen_4: "Imagen 4",
    veo3_lite: "Veo 3.1 Lite",
    veo3_lite_low: "Veo 3.1 Fast - Lower Priority",
    veo3_fast: "Veo 3.1 Fast",
    veo3_fast_low: "Veo 3.1 Fast - Lower Priority",
    veo3_quality: "Veo 3.1 Quality",
  };
  return labels[raw] || raw.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function clickFileInputWithoutScroll(input) {
  if (!input) return;
  const pageY = document.scrollingElement?.scrollTop || 0;
  const shell = document.querySelector(".shell");
  const shellY = shell?.scrollTop || 0;
  const view = document.querySelector(".view.active");
  const viewY = view?.scrollTop || 0;
  input.click();
  const restore = () => {
    if (document.scrollingElement) document.scrollingElement.scrollTop = pageY;
    if (shell) shell.scrollTop = shellY;
    if (view) view.scrollTop = viewY;
  };
  requestAnimationFrame(restore);
  window.setTimeout(restore, 80);
}

// Compute prompt list from state.control.livePrompt
function parsePrompts(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function promptsHaveAutopilotVideoPrompts(prompts = []) {
  return prompts.length > 0 && prompts.every((prompt) => {
    const split = splitAutoFlowPromptLine(prompt);
    return split.isAutoFlowFormat && String(split.videoPrompt || "").trim();
  });
}

// ── Public render ────────────────────────────────────────────
// Module-level cursor that tracks the LAST RENDERED wizardStep so we can detect
// whether a re-render is a step transition (and which direction) vs an in-step
// state change. Set as a side effect of renderControlWizard.
let lastRenderedStep = null;

export function renderControlWizard(root, state, ctx = {}) {
  if (!root) return;
  const dispatch = typeof ctx.dispatch === "function" ? ctx.dispatch : () => {};
  const showConfirm = typeof ctx.showConfirm === "function" ? ctx.showConfirm : null;
  const onRun = typeof ctx.onRun === "function" ? ctx.onRun : null;

  clear(root);

  // Wrap everything in a wizard root so styles are scoped via .afw-* prefix
  const wizardRoot = el("div", { class: "afw-root" });
  wizardRoot.append(
    el("input", { id: "fileInput", attrs: { type: "file", accept: ".txt,text/plain", hidden: true } }),
    el("input", { id: "refImageInput", attrs: { type: "file", accept: ".png,.jpg,.jpeg,.webp,.heic,.avif", multiple: true, hidden: true } }),
    el("input", { id: "imageInput", attrs: { type: "file", accept: ".png,.jpg,.jpeg,.webp,.heic,.avif", multiple: true, hidden: true } }),
  );

  const c = state.control || {};
  const prompts = parsePrompts(c.livePrompt);
  const promptCount = prompts.length;

  const refs = allReferenceItems(state);

  const wizardStep = clampStep(c.wizardStep);
  const account = state.account || {};
  const isPro = account.plan === "pro" || account.plan === "team";
  const usage = account.usage || {};

  const M = MODES.find((m) => m.key === c.mode) || MODES[1];

  // ── Brand / status strip ───────────────────────────────────
  wizardRoot.appendChild(buildBrand(state));
  const accountStrip = buildAccountStrip(state);
  if (accountStrip) wizardRoot.appendChild(accountStrip);
  // Pro tier identity is rendered by the existing #header-usage-pill in
  // index.html — no wizard-side chip injection needed.

  // ── Mode buttons ─────────────────────────────────────────────
  wizardRoot.appendChild(buildModeFrame(state, dispatch, showConfirm));

  // ── Stepper ──────────────────────────────────────────────────
  wizardRoot.appendChild(buildStepper(wizardStep, dispatch, state));

  // ── Step view (header + body) ───────────────────────────────
  // Direction is "forward" if step number increased since last render,
  // "back" if it decreased, or null when nothing about the step changed.
  // CSS uses [data-anim] to choose the slide-in keyframe.
  const stepDirection = lastRenderedStep == null
    ? "init"
    : wizardStep > lastRenderedStep
      ? "forward"
      : wizardStep < lastRenderedStep
        ? "back"
        : null;
  lastRenderedStep = wizardStep;

  const stepView = el("div", {
    class: "afw-step-view",
    attrs: stepDirection ? { "data-anim": stepDirection } : null,
  });
  if (wizardStep === 1) {
    stepView.append(
      buildStepHeaderNext(state, 1, "edit_note", "addPrompts", dispatch, M, prompts, refs, promptCount),
      buildStep1Body(state, c.livePrompt || "", prompts, dispatch),
    );
  } else if (wizardStep === 2) {
    stepView.append(
      buildStepHeaderNext(state, 2, "hub", "references", dispatch, M, prompts, refs, promptCount),
      buildStep2Body(state, dispatch),
    );
  } else {
    const lastRunError = String(c.lastRunError || "").trim();
    const errorBanner = lastRunError
      ? el("div", { class: "afw-run-error", attrs: { role: "alert" } },
          icon("error_outline"),
          el("span", { class: "afw-run-error-text", text: lastRunError }),
          el("button", {
            class: "afw-run-error-dismiss",
            attrs: { type: "button", title: tr(state, "close") },
            on: { click: (e) => {
              stopControlEvent(e);
              dispatch({ control: { lastRunError: "" } });
            } }
          }, icon("close"))
        )
      : null;
    stepView.append(
      buildStepHeaderRun(M, prompts, dispatch, state, onRun),
      ...(errorBanner ? [errorBanner] : []),
      buildStep3Body(state, prompts, refs, M),
    );
  }
  wizardRoot.appendChild(stepView);

  // ── Step nav (Back + summary) ───────────────────────────────
  wizardRoot.appendChild(buildStepNav(state, wizardStep, M, prompts.length, c.presets, dispatch));

  root.appendChild(wizardRoot);

  // After a step change (forward or back), smooth-scroll the panel so the
  // STEPPER (not the step-view) lands at the top of the viewport. The
  // stepper is the minimum navigation context the user needs visible
  // (so they know which step they're on); everything below it is the
  // active step's content + step nav, which gets the maximum vertical
  // room. Brand strip + tabs + mode buttons scroll past — they're
  // constant chrome that doesn't need to stay visible during step
  // navigation. User reported v237/v238 didn't show the bottom CTAs;
  // v239 (which DOES show them) has the stepper at viewport top.
  // Skip on init render so the panel doesn't fight the user's
  // natural starting scroll position.
  if (stepDirection === "forward" || stepDirection === "back") {
    requestAnimationFrame(() => {
      const stepper = wizardRoot.querySelector(".afw-stepper");
      if (stepper?.scrollIntoView) {
        stepper.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }
}

// ── Helpers / sub-renderers ──────────────────────────────────

function clampStep(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 1;
  if (v < 1) return 1;
  if (v > 3) return 3;
  return Math.round(v);
}

function bridgeStatus(state) {
  const runtime = state.runtime || {};
  if (runtime.connected !== true) {
    return {
      className: "is-offline",
      label: tr(state, "bridgeOffline"),
      title: tr(state, "bridgeOfflineHelp")
    };
  }
  if (runtime.bridgeHealthy === true) {
    return {
      className: "is-healthy",
      label: tr(state, "bridgeHealthy"),
      title: tr(state, "bridgeHealthyHelp")
    };
  }
  return {
    className: "is-checking",
    label: tr(state, "bridgeChecking"),
    title: runtime.bridgeError || tr(state, "bridgeCheckingHelp")
  };
}

function buildBrand(state) {
  const project = state.runtime?.projectId || state.control?.presets?.downloadFolder || tr(state, "appName");
  const promptCount = parsePrompts(state.control?.livePrompt).length;
  const bridge = bridgeStatus(state);
  return el("div", { class: "afw-top" },
    el("div", { class: "afw-mark", text: "AF" }),
    el("div", { class: "afw-title-stack" },
      el("div", { class: "afw-t1" }, tr(state, "appName"),
        el("span", { class: "afw-v", text: "v10.8" })),
      el("div", { class: "afw-t2" },
        el("span", { class: "afw-project-line" },
          el("span", {
            class: `afw-pdot ${state.runtime?.connected ? "is-connected" : "is-disconnected"}`,
            attrs: { title: state.runtime?.connected ? tr(state, "connected") : tr(state, "disconnected") }
          }),
          el("span", { class: "afw-project-text", text: tr(state, "projectPromptsReady", { project, count: promptCount }) }),
        ),
        el("span", {
          class: `afw-bridge-pill ${bridge.className}`,
          attrs: { title: bridge.title, "data-bridge-state": bridge.className.replace(/^is-/, "") }
        },
          el("span", { class: "afw-bridge-dot" }),
          el("span", { class: "afw-bridge-label", text: bridge.label }),
        ),
      ),
    ),
  );
}

function accountUsage(state) {
  const account = state.account || {};
  const usage = account.usage || {};
  const used = Number.isFinite(Number(usage.used)) ? Number(usage.used) : 0;
  const limit = Number.isFinite(Number(usage.limit)) ? Number(usage.limit) : 10;
  const remaining = Number.isFinite(Number(usage.remaining)) ? Number(usage.remaining) : Math.max(0, limit - used);
  const pro = usage.unlimited === true || ["pro", "team"].includes(String(account.plan || "").toLowerCase());
  return { account, usage, used, limit, remaining, pro, signedIn: account.status === "signed_in" };
}

function canRunFromAccount(state) {
  const info = accountUsage(state);
  return info.signedIn && (info.pro || info.remaining > 0);
}


function runBlockerLabel(state, promptCount = 0) {
  const info = accountUsage(state);
  if (!promptCount) return tr(state, "addPromptsToRun");
  if (!info.signedIn) return tr(state, "signInToRun");
  if (!info.pro && info.remaining <= 0) return tr(state, "dailyLimitReached");
  // Modes that require a reference image must have at least one attached
  // before Run is allowed. Without this guard the run handoff in app.js
  // mutates state.ui.activeRoute = "live" + renders preparing UI BEFORE
  // buildJobs() throws on the missing ref, causing a visible flash to
  // Live Queue and back to step 2 (the "Frame to Video glitches on Run
  // without an image" symptom).
  const mode = MODES.find((m) => m.key === state.control?.mode);
  if (mode?.needsRefs) {
    const refIds = activeReferenceIdsForMode(state);
    if (!refIds.length) return tr(state, "addRefToRun");
  }
  return "";
}

function buildAccountStrip(state) {
  const locale = state.control?.presets?.language || "en";
  const info = accountUsage(state);
  // Pro tier shows as the existing #header-usage-pill.is-pro chip in the
  // top header (rendered by index.html, toggled by app.js), not a full-width
  // strip in the wizard body.
  if (info.pro) return null;
  const pendingCheckout = Boolean(info.account?.pendingCheckout);
  const email = info.account?.email || "";
  const pct = info.pro ? 100 : Math.max(0, Math.min(100, (info.used / Math.max(1, info.limit)) * 100));
  const barClass = pct >= 100 ? "critical" : pct >= 70 ? "warning" : "";
  return el("div", { id: "freemiumBanner", class: "is-visible afw-account-strip" },
    el("div", { class: "banner-top" },
      el("span", { class: "banner-tier" }, icon("token"), translate("freePlan", {}, locale)),
      el("span", { id: "bannerUsageText", class: "banner-usage", text: translate("promptsToday", { used: Math.min(info.used, info.limit), limit: info.limit }, locale) }),
    ),
    el("p", { class: "auth-email-hint banner-email-hint", text: info.signedIn ? translate("signedInUsageVerified", {}, locale) : pendingCheckout ? translate("verifyEmailForCheckout", {}, locale) : translate("signInRequired", {}, locale) }),
    el("div", { class: "usage-bar" },
      el("div", { id: "bannerUsageBar", class: `usage-bar-fill ${barClass}`.trim(), style: { width: `${pct}%` } }),
    ),
    el("div", { id: "bannerResetTimer", style: { display: info.signedIn && info.remaining <= 0 ? "block" : "none", textAlign: "center", padding: "6px 0", fontSize: "11px", color: "#f44336", fontWeight: "600" } },
      icon("timer"),
      ` ${translate("resetsIn", {}, locale)} `,
      el("span", { id: "bannerResetCountdown", text: "--:--:--" }),
    ),
    el("div", { class: "banner-limits" },
      el("span", { class: "limit-item" }, icon("lock"), ` ${translate("limitHighResImages", {}, locale)}`),
      el("span", { class: "limit-item" }, icon("lock"), ` ${translate("limitHighResVideo", {}, locale)}`),
      el("span", { class: "limit-item" }, icon("lock"), ` ${translate("limitMultiOutput", {}, locale)}`),
      el("span", { class: "limit-item" }, icon("lock"), ` ${translate("limitAutoDownload", {}, locale)}`),
    ),
    el("button", { class: "banner-upgrade-btn", id: "bannerUpgradeBtn", attrs: { type: "button" } },
      icon("rocket_launch"),
      el("span", { text: info.signedIn ? translate("unlockPro", {}, locale) : pendingCheckout ? translate("continueProCheckout", {}, locale) : translate("signInUnlockPro", {}, locale) }),
    ),
    !info.signedIn ? el("div", { id: "bannerAuthFlow", class: "afw-account-auth" },
      el("div", { id: "bannerEmailStep" },
        el("input", { id: "bannerEmailInput", value: email, attrs: { type: "email", placeholder: "your@email.com", autocomplete: "email" } }),
        el("button", { id: "bannerSendCodeBtn", attrs: { type: "button" } }, el("span", { class: "auth-send-code-label", text: pendingCheckout ? translate("sendCheckoutCode", {}, locale) : translate("sendCode", {}, locale) })),
      ),
      el("div", { id: "bannerOtpStep", style: { display: state.account?.status === "pending_confirmation" ? "grid" : "none" } },
        el("input", { id: "bannerOtpInput", value: info.account?.otpCode || "", attrs: { type: "text", placeholder: translate("enterCode", {}, locale), maxlength: "10", autocomplete: "one-time-code", inputmode: "numeric" } }),
        el("button", { id: "bannerVerifyBtn", attrs: { type: "button" }, text: translate("verify", {}, locale) }),
      ),
    ) : null,
  );
}

function buildModeFrame(state, dispatch, showConfirm) {
  const grid = el("div", { class: "afw-mode-grid" });
  for (const m of MODES) {
    const active = state.control?.mode === m.key;
    const label = modeName(state, m);
    const btn = el("button", {
      class: "afw-mode-btn" + (active ? " active" : ""),
      attrs: { type: "button", title: label },
      on: { click: (e) => { stopControlEvent(e); handleModeChange(m.key, state, dispatch, showConfirm); } },
    }, icon(m.iconName), el("span", { text: label }));
    grid.appendChild(btn);
  }
  return el("div", { class: "afw-mode-frame" }, grid);
}

async function handleModeChange(newMode, state, dispatch, showConfirm) {
  if (state.control?.mode === newMode) {
    if (Number(state.control?.wizardStep || 1) !== 1) {
      dispatch({ control: { wizardStep: 1 } });
    }
    return;
  }
  const hasPrompts = parsePrompts(state.control?.livePrompt).length > 0;
  const hasRefs = Object.values(state.control?.references || {}).some((v) => String(v || "").trim().length > 0);
  if (!hasPrompts && !hasRefs) {
    dispatch({ control: { mode: newMode } });
    return;
  }
  if (!showConfirm) {
    dispatch({ control: { mode: newMode } });
    return;
  }
  const ok = await showConfirm({
    title: tr(state, "switchModeTitle"),
    body: tr(state, "switchModeBody"),
    confirmLabel: tr(state, "switchModeConfirm"),
  });
  if (ok) {
    dispatch({
      control: {
        mode: newMode,
        livePrompt: "",
        promptRefMap: {},
        oneToOneBatchRefIds: [],
        references: {
          imagePromptRefs: "",
          styleRefRefs: "",
          omniRefRefs: "",
          startFrameRef: "",
          endFrameRef: "",
          ingredientsRefs: "",
        },
        wizardStep: 1,
      },
    });
  }
}

function buildStepper(currentStep, dispatch, state) {
  const step = (n, lbl) => {
    const cls = "afw-step" + (n < currentStep ? " done" : n === currentStep ? " active" : "");
    return el("div", {
      class: cls,
      attrs: { role: "button", "data-step": String(n) },
      on: { click: (e) => { stopControlEvent(e); dispatch({ control: { wizardStep: n } }); } },
    },
      el("div", { class: "afw-num" }, el("span", { text: String(n) })),
      el("div", { class: "afw-lbl", text: lbl }),
    );
  };
  return el("div", { class: "afw-stepper" },
    el("div", { class: "afw-stepper-row" }, step(1, tr(state, "prompts")), step(2, tr(state, "references")), step(3, tr(state, "run"))),
  );
}

function buildStepHeaderNext(state, stepNum, iconName, labelKey, dispatch, mode, prompts, refs, promptCount) {
  const isStep3 = stepNum === 3;
  // Back button — only shown when there's a previous step to go to.
  const back = stepNum > 1 ? el("button", {
    class: "afw-back-inline",
    attrs: { type: "button", title: tr(state, "back") },
    // Same blur-before-dispatch trick used by Next: keeps focus from
    // bouncing to <body> when the button gets re-rendered out from under us.
    on: { click: (e) => { stopControlEvent(e); dispatch({ control: { wizardStep: stepNum - 1 } }); } },
  }, icon("arrow_back"), tr(state, "back")) : null;

  const next = el("button", {
    class: isStep3 ? "afw-run" : "afw-next",
    attrs: { type: "button" },
    // Blur BEFORE dispatch so the button is unfocused while still on screen.
    // If we let it stay focused while the re-render destroys it, the browser
    // restores focus to <body> with a small scroll jump — the "tad" the user
    // felt. Blurring first releases focus cleanly.
    on: { click: (e) => { stopControlEvent(e); dispatch({ control: { wizardStep: stepNum + 1 } }); } },
  });
  if (isStep3) {
    next.append(icon("play_arrow"), document.createTextNode(tr(state, "runPromptCount", { count: promptCount })));
  } else {
    next.append(document.createTextNode(tr(state, "next")), icon("arrow_forward"));
  }
  return el("div", { class: "afw-step-header" },
    el("h2", {}, icon(iconName), tr(state, labelKey)),
    el("div", { class: "afw-step-actions" }, back, buildGuideJump(state), buildHistoryJump(state, dispatch), next),
  );
}

function buildStepHeaderRun(mode, prompts, dispatch, state, onRun) {
  const isVideo = String(mode.key || "").endsWith("video");
  const count = prompts.length;
  const isAppending = Boolean(state.queue?.running);
  const canRun = canRunFromAccount(state);
  const blocker = runBlockerLabel(state, count);
  const disabled = Boolean(blocker) || !canRun || !count;
  const actionLabel = isAppending ? tr(state, "addToQueue") : tr(state, "runPromptCount", { count });
  const actionIcon = disabled ? "lock" : isAppending ? "playlist_add" : "play_arrow";
  const back = el("button", {
    class: "afw-back-inline",
    attrs: { type: "button", title: tr(state, "back") },
    on: { click: (e) => { stopControlEvent(e); dispatch({ control: { wizardStep: 2 } }); } },
  }, icon("arrow_back"), tr(state, "back"));
  const run = el("button", {
    id: "generate-btn",
    class: "afw-run",
    attrs: { type: "button", title: blocker || actionLabel, disabled: disabled ? "disabled" : null },
    on: { click: (e) => {
      e.stopPropagation();
      stopControlEvent(e);
      if (!disabled && onRun) onRun();
    } },
  }, icon(actionIcon), blocker || actionLabel);
  return el("div", { class: "afw-step-header" },
    el("h2", {}, icon("rocket_launch"), tr(state, "reviewAndRun")),
    el("div", { class: "afw-step-actions" },
      back,
      buildGuideJump(state),
      buildHistoryJump(state, dispatch),
      el("div", { class: "afw-run-wrap" }, run),
    ),
  );
}

// ── Step 1: Prompts ──────────────────────────────────────────
function buildStep1Body(state, text, prompts, dispatch) {
  let previewWrap;
  let countNode;
  const renderPreview = (nextText) => {
    const nextPrompts = parsePrompts(nextText);
    if (countNode) countNode.textContent = String(nextPrompts.length);
    if (!previewWrap) return;
    clear(previewWrap);
    appendPromptPreview(state, previewWrap, nextPrompts);
  };
  const ta = el("textarea", {
    placeholder: tr(state, "promptPastePlaceholder"),
    on: {
      input: (e) => {
        renderPreview(e.target.value);
        dispatch({ control: { livePrompt: e.target.value } });
      },
    },
  });
  ta.value = text;

  countNode = el("b", { text: String(prompts.length) });
  const ct = el("span", { class: "afw-paste-ct" },
    countNode,
    ` ${tr(state, "promptsDetected")}`,
  );

  previewWrap = el("div", { class: "afw-prompt-preview-scroll" });
  appendPromptPreview(state, previewWrap, prompts);

  return el("div", { class: "afw-step-body" },
    el("p", { class: "afw-lede", text: tr(state, "pasteBatchHelp") }),
    el("div", { class: "afw-paste" },
      ta,
      el("div", { class: "afw-paste-row" },
        el("button", { id: "uploadPromptButton", class: "afw-back", attrs: { type: "button", style: "padding:5px 10px;font-size:10.5px;" } }, icon("file_upload"), tr(state, "import")),
        el("button", { id: "pastePromptButton", class: "afw-back", attrs: { type: "button", style: "padding:5px 10px;font-size:10.5px;" } }, icon("content_paste"), tr(state, "paste")),
        ct,
      ),
    ),
    previewWrap,
  );
}

function appendPromptPreview(state, previewWrap, prompts) {
  if (prompts.length === 0) {
    previewWrap.appendChild(el("div", { class: "afw-prompt-mini", attrs: { style: "color:var(--afw-text-soft); font-style:italic;" } },
      el("span", { class: "afw-idx", text: "-" }),
      el("div", { class: "afw-body", text: tr(state, "noPromptsYet") }),
    ));
    return;
  }
  prompts.forEach((p, i) => {
    previewWrap.appendChild(el("div", { class: "afw-prompt-mini" },
      el("span", { class: "afw-idx", text: pad2(i + 1) }),
      el("div", { class: "afw-body", text: p }),
    ));
  });
}

// ── Step 2: References ──────────────────────────────────────
function buildStep2Body(state, dispatch) {
  const savedRefs = Array.isArray(state.referenceLibrary?.savedItems) ? state.referenceLibrary.savedItems : [];
  const refs = allReferenceItems(state);
  const lastSync = state.referenceLibrary?.lastSyncedAt || null;
  const totalSize = savedRefs.reduce((s, r) => s + (Number(r.bytes || r.size) || 0), 0);
  const mode = state.control?.mode || FLOW_MODES.textToVideo;
  const activeRefIds = activeReferenceIdsForMode(state);
  const limit = REF_LIMITS[mode] ?? 0;
  const activeCta = state.control?.activeApplyMode || "shared";
  const refCopy = mode === FLOW_MODES.textToVideo
    ? tr(state, "textToVideoNoRefs")
    : mode === FLOW_MODES.imageToVideo
      ? tr(state, "frameToVideoRefsHelp")
      : mode === FLOW_MODES.ingredientsToVideo
        ? tr(state, "ingredientsRefsHelp")
        : tr(state, "createImageRefsHelp");

  if (mode === FLOW_MODES.textToVideo) {
    return el("div", { class: "afw-step-body" },
      el("div", { class: "afw-no-refs-card" },
        el("div", { class: "afw-icn" }, icon("text_fields")),
        el("div", { class: "afw-meta" },
          el("span", { class: "afw-name", text: tr(state, "textToVideo") }),
          el("span", { class: "afw-sub", text: refCopy }),
        ),
      )
    );
  }

  const refLibRow = el("div", { class: "afw-reflib-row" },
    el("div", { class: "afw-reflib-main" },
      el("div", { class: "afw-icn" }, icon("collections_bookmark")),
      el("div", { class: "afw-meta" },
        el("span", { class: "afw-name", text: tr(state, "referenceLibrary") }),
        el("span", { class: "afw-sub", text: tr(state, "refsSavedActive", { saved: savedRefs.length, size: formatBytes(totalSize), active: activeRefIds.length, limit }) }),
      ),
    ),
    el("button", { id: "addRefsToLibraryButton", class: "afw-add-btn", attrs: { type: "button" } },
      icon("add_photo_alternate"),
      el("span", { text: tr(state, "addToLibrary") })
    ),
  );

  const refStrip = el("div", { class: "afw-ref-strip" });
  if (refs.length === 0) {
    refStrip.appendChild(el("div", { class: "afw-rt-empty", text: tr(state, "dropFirstReference") }));
  } else {
    for (const r of refs) {
      const id = r.id || "";
      const active = activeRefIds.includes(id);
      refStrip.appendChild(el("div", {
        class: `afw-rt${active ? " active" : ""}${r.temporary ? " temporary" : ""}`,
        data: { refLibraryId: id },
        attrs: { title: r.title || r.name || r.fileName || r.id || "", draggable: true },
      },
        imageForRef(r, "afw-face"),
        el("div", { class: "afw-rname", text: r.title || r.fileName || r.name || r.id || "" }),
        r.temporary ? el("span", { class: "afw-temp-badge", text: tr(state, "run") }) : null,
        active ? el("span", { class: "afw-ref-check" }, icon("check")) : null,
        el("button", {
          class: "afw-ref-remove",
          data: { refDeleteId: id },
          attrs: { type: "button", title: tr(state, "removeFromLibrary") },
        }, icon("close")),
      ));
    }
  }

  const cta = (key, name, sub, iconName, tip) => el("button", {
    class: "afw-cta" + (activeCta === key ? " active" : ""),
    attrs: { type: "button", "data-cta": key, title: tip },
    on: { click: (e) => {
      stopControlEvent(e);
      dispatch({ control: applyModePatch(state, key) });
    } },
  },
    el("div", { class: "afw-icn" }, icon(iconName)),
    el("div", { class: "afw-meta" },
      el("span", { class: "afw-name", text: name }),
      el("span", { class: "afw-sub", text: sub }),
    ),
  );

  const ctaGrid = el("div", { class: "afw-cta-grid" },
    cta("shared", tr(state, "sharedRefUpload"), tr(state, "sharedRefUploadSub"), "collections", tr(state, "sharedRefUploadTip")),
    cta("batch",  tr(state, "batchRefUpload"),  tr(state, "batchRefUploadSub"), "upload", tr(state, "batchRefUploadTip")),
    cta("repeat", tr(state, "repeatFirstPrompt"), tr(state, "repeatFirstPromptSub"), "replay", tr(state, "repeatFirstPromptTip")),
    cta("match",  tr(state, "autoMatch"),        tr(state, "autoMatchSub"), "auto_fix_high", tr(state, "autoMatchTip")),
  );

  return el("div", { class: "afw-step-body" },
    el("p", { class: "afw-lede", text: refCopy }),
    el("div", { class: "afw-eyebrow" }, icon("auto_fix_high"), tr(state, "applyReferences")),
    ctaGrid,
    el("button", { id: "referenceUploadButton", class: "afw-big-upload", attrs: { type: "button" } },
      icon("upload"),
      el("span", { class: "afw-big-upload-copy" },
        el("strong", { text: activeCta === "batch" ? tr(state, "uploadBatch") : tr(state, "uploadReferences") }),
        el("small", { text: activeCta === "batch" ? tr(state, "uploadBatchHelp") : tr(state, "uploadReferencesHelp") }),
      ),
    ),
    el("label", { class: "afw-save-library-toggle", attrs: { for: "saveUploadedRefsToLibraryToggle" } },
      el("input", {
        id: "saveUploadedRefsToLibraryToggle",
        checked: state.control?.saveUploadsToLibrary === true,
        attrs: { type: "checkbox" },
        on: { change: (event) => dispatch({ control: { saveUploadsToLibrary: event.target.checked } }) }
      }),
      el("span", { text: tr(state, "saveUploadsToLibrary") })
    ),
    refLibRow,
    refStrip,
    mode === FLOW_MODES.imageToVideo ? buildFrameReferenceSlots(state) : null,
    el("div", { class: "afw-ref-actions" },
      el("button", { id: "refSelectAllBtn", class: "afw-back", attrs: { type: "button", disabled: refs.length ? null : "disabled" } }, icon("select_all"), tr(state, "selectAll")),
      activeRefIds.length ? el("button", { id: "clearSelectedRef", class: "afw-back", attrs: { type: "button" } }, icon("backspace"), tr(state, "clearActiveReferences")) : null,
      el("button", { id: "clearRefImagesBtn", class: "afw-back", attrs: { type: "button", disabled: refs.length ? null : "disabled" } }, icon("delete"), tr(state, "clearReferenceLibrary"))
    ),
  );
}

function emptyReferencePatch(refs = {}) {
  return {
    imagePromptRefs: "",
    styleRefRefs: "",
    omniRefRefs: "",
    startFrameRef: "",
    endFrameRef: "",
    ingredientsRefs: "",
    ...Object.fromEntries(Object.keys(refs || {}).map((key) => [key, ""]))
  };
}

function referenceLimitForMode(mode = "") {
  if (mode === FLOW_MODES.textToImage) return 10;
  if (mode === FLOW_MODES.ingredientsToVideo) return 3;
  if (mode === FLOW_MODES.imageToVideo) return 2;
  return 0;
}

function referencesPatchForMode(mode = "", ids = [], refs = {}) {
  const next = emptyReferencePatch(refs);
  const cleanIds = ids.map((id) => String(id || "").trim()).filter(Boolean);
  if (mode === FLOW_MODES.imageToVideo) {
    next.startFrameRef = cleanIds[0] || "";
    next.endFrameRef = cleanIds[1] || "";
    return next;
  }
  if (mode === FLOW_MODES.ingredientsToVideo) {
    next.ingredientsRefs = cleanIds.slice(0, 3).join("\n");
    return next;
  }
  if (mode === FLOW_MODES.textToImage) {
    next.imagePromptRefs = cleanIds.slice(0, 10).join("\n");
  }
  return next;
}

function applyModePatch(state = {}, modeKey = "shared") {
  const control = state.control || {};
  const currentBatch = Array.isArray(control.oneToOneBatchRefIds)
    ? control.oneToOneBatchRefIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const ids = activeReferenceIdsForMode(state).slice(0, modeKey === "batch" ? 500 : referenceLimitForMode(control.mode));
  const base = {
    activeApplyMode: modeKey,
    promptRefMap: {}
  };
  if (modeKey === "batch") {
    return {
      ...base,
      oneToOneBatchRefIds: ids,
      references: emptyReferencePatch(control.references),
      presets: { mapLineRefs: true },
      promptMapOpen: true
    };
  }
  if (modeKey === "match") {
    return {
      ...base,
      oneToOneBatchRefIds: [],
      references: currentBatch.length ? referencesPatchForMode(control.mode, ids, control.references) : control.references,
      presets: { mapLineRefs: true },
      promptMapOpen: true
    };
  }
  return {
    ...base,
    oneToOneBatchRefIds: [],
    references: currentBatch.length ? referencesPatchForMode(control.mode, ids, control.references) : control.references
  };
}

function buildFrameReferenceSlots(state) {
  const refs = state.control?.references || {};
  const allRefs = allReferenceItems(state);
  const byId = (id) => allRefs.find((ref) => ref.id === id) || null;
  const slot = (role, titleKey, fallback, required) => {
    const id = idsFromValue(refs[role]).at(0) || "";
    const ref = byId(id);
    return el("div", { class: `afw-frame-slot${ref ? " filled" : ""}` },
      el("div", { class: "afw-frame-slot-preview" },
        ref ? imageForRef(ref, "afw-frame-slot-img") : icon(role === "startFrameRef" ? "first_page" : "last_page")
      ),
      el("div", { class: "afw-frame-slot-copy" },
        el("strong", { text: tr(state, titleKey) }),
        el("span", { text: ref ? (ref.title || ref.fileName || ref.name || ref.id || "") : fallback }),
      ),
      ref ? el("button", {
        class: "afw-frame-slot-clear",
        data: { refClear: role },
        attrs: { type: "button", title: tr(state, "clear") || "Clear" }
      }, icon("close")) : el("span", { class: `afw-frame-slot-badge${required ? " required" : ""}`, text: required ? "Required" : "Optional" })
    );
  };
  return el("div", { class: "afw-frame-slots" },
    slot("startFrameRef", "startFrame", "Select or upload the first frame.", true),
    slot("endFrameRef", "endFrame", "Optional final frame.", false)
  );
}

function imageForRef(ref, className) {
  const src = ref.imageUrl || ref.dataUrl || ref.mediaUrl || "";
  if (src) {
    return el("img", {
      class: className,
      attrs: { src, alt: ref.title || ref.fileName || ref.name || "", loading: "lazy" },
    });
  }
  return el("div", {
    class: className,
    attrs: { style: `background: ${paletteFor(ref.id || ref.name)};` },
    text: glyphFor(ref.name || ref.title || ref.fileName),
  });
}

function allReferenceItems(state) {
  const saved = Array.isArray(state.referenceLibrary?.savedItems) ? state.referenceLibrary.savedItems : [];
  const transient = Array.isArray(state.control?.transientReferenceItems) ? state.control.transientReferenceItems : [];
  const seen = new Set();
  return [...transient, ...saved].filter((item) => {
    const id = String(item?.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function idsFromValue(value) {
  return String(value || "").split(/\s+/).map((id) => id.trim()).filter(Boolean);
}

function activeReferenceIdsForMode(state) {
  const refs = state.control?.references || {};
  const batch = Array.isArray(state.control?.oneToOneBatchRefIds) ? state.control.oneToOneBatchRefIds : [];
  if (batch.length) return batch.map((id) => String(id || "").trim()).filter(Boolean);
  if (state.control?.mode === FLOW_MODES.textToImage) {
    return [...idsFromValue(refs.imagePromptRefs), ...idsFromValue(refs.styleRefRefs), ...idsFromValue(refs.omniRefRefs)];
  }
  if (state.control?.mode === FLOW_MODES.ingredientsToVideo) {
    return idsFromValue(refs.ingredientsRefs);
  }
  if (state.control?.mode === FLOW_MODES.imageToVideo) {
    return [...idsFromValue(refs.startFrameRef), ...idsFromValue(refs.endFrameRef)];
  }
  return [];
}

function formatBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── Step 3: Review & Run ──────────────────────────────────
function buildStep3Body(state, prompts, refs, mode) {
  const promptRefMap = state.control?.promptRefMap || {};

  const pairList = el("div", { class: "afw-pair-list" });
  if (prompts.length === 0) {
    pairList.appendChild(el("div", { class: "afw-pair-row" },
      el("div", { class: "afw-idx", text: "—" }),
      el("div", { class: "afw-text", text: tr(state, "noPromptsToRun") }),
      el("div", { class: "afw-refs" }),
    ));
  } else {
    prompts.forEach((p, i) => {
      const refIds = effectiveRefIdsForPrompt(state, p, i, prompts.length);
      const refsEl = el("div", { class: "afw-refs" });
      const shown = refIds.slice(0, 3);
      for (const rid of shown) {
        const r = refs.find((x) => x.id === rid);
        const thumb = r
          ? imageForRef(r, "afw-ref-mini-img")
          : el("div", { class: "afw-ref-mini-fallback", attrs: { style: `background: ${paletteFor(rid)};` }, text: glyphFor(rid) });
        refsEl.appendChild(el("div", {
          class: "afw-ref-mini",
          attrs: { title: r?.name || r?.title || r?.fileName || rid },
        }, thumb));
      }
      if (refIds.length > 3) {
        refsEl.appendChild(el("span", { class: "afw-no-ref", attrs: { style: "color:var(--afw-text-soft); background:transparent; border:0;" }, text: `+${refIds.length - 3}` }));
      }
      if (refIds.length === 0) {
        refsEl.appendChild(el("span", { class: "afw-no-ref", text: tr(state, "noRef") }));
      }
      pairList.appendChild(el("div", { class: "afw-pair-row", attrs: { title: p } },
        el("div", { class: "afw-idx", text: pad2(i + 1) }),
        el("div", { class: "afw-text", text: p }),
        refsEl,
      ));
    });
  }

  const presets = state.control?.presets || {};
  const modelKey = mode.defaultModelKey;
  const aspectKey = mode.defaultAspectKey;
  const countKey = mode.defaultCountKey;
  const dlResKey = mode.defaultDownloadResKey;
  const dl = presets[dlResKey] || (mode.key === FLOW_MODES.textToImage ? "1k" : "720p");
  const autoDownloadOn = mode.key === FLOW_MODES.textToImage ? presets.autoDownloadImages !== false : presets.autoDownload !== false;

  const valSelect = (settingKey, value, options, selectOptions = {}) => el("select", {
    class: "afw-val-btn",
    data: { settingKey },
    attrs: {
      disabled: Boolean(selectOptions.disabled),
      "aria-disabled": Boolean(selectOptions.disabled)
    }
  },
    options.map(([optionValue, label]) => el("option", {
      text: label,
      attrs: { value: optionValue, selected: String(value) === String(optionValue) }
    }))
  );
  const modelOptions = mode.key === FLOW_MODES.textToImage
    ? ["nano_banana_pro", "nano_banana_2", "imagen_4"].map((key) => [key, formatModelLabel(key)])
    : mode.key === FLOW_MODES.ingredientsToVideo
      ? INGREDIENTS_VIDEO_MODEL_OPTIONS
      : VIDEO_MODEL_OPTIONS;
  const aspectOptions = mode.key === FLOW_MODES.textToImage
    ? [["portrait", tr(state, "portrait")], ["square", tr(state, "square")], ["landscape", tr(state, "landscape")], ["portrait_3_4", "3:4"], ["landscape_4_3", "4:3"]]
    : [["portrait", tr(state, "portrait")], ["landscape", tr(state, "landscape")]];
  const countOptions = [["1", "x1"], ["2", "x2"], ["3", "x3"], ["4", "x4"]];
  const downloadOptions = mode.key === FLOW_MODES.textToImage
    ? [["1k", "1K"], ["2k", "2K"], ["4k", "4K"]]
    : [["720p", "720p"], ["1080p", "1080p"], ["4k", "4K"]];
  const routeOptions = [["api_first", "API"], ["dom_first", "DOM"]];
  const silentVideoOptions = [["true", tr(state, "on")], ["false", tr(state, "off")]];
  const durationOptions = mode.key === FLOW_MODES.ingredientsToVideo
    ? [["8", "8s"]]
    : [["4", "4s"], ["6", "6s"], ["8", "8s"]];
  const row = (iconName, label, sub, valNode, rowOptions = {}) => el("div", { class: `afw-gen-row${rowOptions.disabled ? " is-disabled" : ""}` },
    el("div", { class: "afw-icn-wrap" }, icon(iconName)),
    el("div", { class: "afw-label-stack" },
      el("div", { class: "afw-label" }, label, el("span", { class: "afw-default-tag", text: tr(state, "defaultLabel") })),
      el("div", { class: "afw-sub", text: sub }),
    ),
    valNode,
  );
  // Read directly from state.control.presets (already normalized by
  // normalizePresets, which preserves any valid stored value the user
  // saved). NO view-level "|| 'portrait'" fallbacks: those would override
  // the user's last-saved choice with a hardcoded preference. Per user
  // direction: 'shouldnt default to anything other than the settings the
  // user leaves it on.'
  const autopilotOptions = [
    ["off", tr(state, "autopilotOff")],
    ["all", tr(state, "autopilotAll")],
    ["one", tr(state, "autopilotOne")],
  ];
  const autopilotReady = mode.key === FLOW_MODES.textToImage && promptsHaveAutopilotVideoPrompts(prompts);
  const settingsCard = el("div", { class: "afw-gen-card" },
    row("tune", tr(state, "model"), tr(state, "modeModelList", { mode: modeName(state, mode) }), valSelect(modelKey, presets[modelKey], modelOptions)),
    row("aspect_ratio", tr(state, "aspectRatio"), tr(state, "outputFrame"), valSelect(aspectKey, presets[aspectKey], aspectOptions)),
    row("repeat", tr(state, "generationsPerPrompt"), tr(state, "moreOptionsToPick"), valSelect(countKey, presets[countKey], countOptions)),
    mode.key !== FLOW_MODES.textToImage && mode.key !== FLOW_MODES.ingredientsToVideo
      ? row("timer", tr(state, "videoLength"), tr(state, "videoLengthHelp"), valSelect("videoLength", presets.videoLength, durationOptions))
      : null,
    mode.key !== FLOW_MODES.textToImage
      ? row("volume_off", tr(state, "returnSilentVideos"), tr(state, "returnSilentVideosHelp"), valSelect("returnSilentVideos", presets.returnSilentVideos !== false ? "true" : "false", silentVideoOptions))
      : null,
    row("download", tr(state, "autoDownload"), autoDownloadOn ? tr(state, "savesToDownloads") : tr(state, "reviewInGalleryFirst"), valSelect(dlResKey, dl, downloadOptions)),
    row("verified_user", tr(state, "submitRoute"), tr(state, "submitRouteHelp"), valSelect("submitPath", presets.submitPath, routeOptions)),
    // T2I autopilot: animate generated images via Frame-to-Video after the
    // T2I run finishes. Only visible in textToImage mode — other modes
    // already produce video. See issue #208.
    mode.key === FLOW_MODES.textToImage
      ? row(
          "auto_awesome",
          tr(state, "autopilotLabel"),
          autopilotReady ? tr(state, "autopilotHelp") : tr(state, "autopilotDisabledHelp"),
          valSelect("autopilotT2IToF2V", autopilotReady ? (presets.autopilotT2IToF2V || "off") : "off", autopilotOptions, { disabled: !autopilotReady }),
          { disabled: !autopilotReady }
        )
      : null,
  );

  const isVideo = String(mode.key || "").endsWith("video");
  const count = Number(presets[countKey] || 4);
  const out = prompts.length * count;
  const min = Math.max(1, Math.round(prompts.length * (isVideo ? 1.4 : 0.5)));
  const estimate = el("div", { class: "afw-estimate" },
    el("div", { class: "afw-est-row" },
      el("span", { text: tr(state, "estimatedRuntime") }),
      el("b", { text: tr(state, "runtimeMinutes", { count: min }) }),
    ),
    el("div", { class: "afw-est-row" },
      el("span", { text: isVideo ? tr(state, "videosToGenerate") : tr(state, "imagesToGenerate") }),
      el("b", { text: String(out) }),
    ),
  );

  return el("div", { class: "afw-step-body" },
    el("p", { class: "afw-lede", text: tr(state, "reviewRunHelp") }),
    el("div", { class: "afw-eyebrow" }, icon("checklist"), tr(state, "promptsToReferences"),
      el("span", { class: "afw-right" }, el("b", { text: String(prompts.length) }), ` ${tr(state, "total")}`),
    ),
    pairList,
    el("div", { class: "afw-eyebrow", attrs: { style: "margin-top:6px;" } }, icon("settings"), tr(state, "generation"),
      el("span", { class: "afw-right", text: tr(state, "settingsOverrideHere") }),
    ),
    settingsCard,
    estimate,
  );
}

function promptMapKey(_prompt, index) {
  return `line:${index}`;
}

function effectiveRefIdsForPrompt(state, prompt, index, totalPrompts) {
  const sourceIds = activeReferenceIdsForMode(state);
  const map = state.control?.promptRefMap || {};
  const key = promptMapKey(prompt, index);
  if (Object.prototype.hasOwnProperty.call(map, key)) {
    return Array.isArray(map[key]) ? map[key].filter((id) => sourceIds.includes(id)) : [];
  }
  const batch = Array.isArray(state.control?.oneToOneBatchRefIds)
    ? state.control.oneToOneBatchRefIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  if (batch.length) {
    if (state.control?.mode === FLOW_MODES.imageToVideo && batch.length >= totalPrompts * 2) {
      return [batch[index] || "", batch[index + totalPrompts] || ""].filter(Boolean);
    }
    return batch[index] ? [batch[index]] : [];
  }
  return sourceIds;
}

function buildStepNav(state, currentStep, mode, promptCount, presets, dispatch) {
  // Bottom strip is now just a centered step summary. Back moved up to the
  // step header (afw-step-actions). History moved up next to Next via
  // buildHistoryJump. The bottom row exists only to remind the user where
  // they are in the flow.
  const isVideo = String(mode.key || "").endsWith("video");
  const count = Number(presets?.[mode.defaultCountKey] || 4);
  const summary = currentStep === 3
    ? tr(state, "summaryOutputs", { prompts: promptCount, outputs: promptCount * count, media: isVideo ? tr(state, "videos") : tr(state, "images") })
    : tr(state, "summaryStep", { step: currentStep, mode: modeName(state, mode) });
  return el("div", { class: "afw-step-nav" },
    el("div", { class: "afw-step-summary", text: summary }),
  );
}
