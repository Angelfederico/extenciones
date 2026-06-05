// 1:1 port of the legacy showManualVideoPromptModal from gallery.js (10.7.x).
// Same DOM IDs (mvp-*), same inline styles, same four-mode contract, same
// "Queue matched only" / Import Prompts / help tooltip behavior. Adapted for
// the rebuild's gallery item shape (item.prompt/title/fileName/mediaId/...)
// and for appendLog instead of logMessage.

const ZERO_WIDTH_CHAR_REGEX = /[​-‍﻿]/g;
const GENERIC_SCENE_TAG_REGEX = /\[([A-Z0-9]+-[A-Z0-9]+)\]/i;

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizePromptText(text) {
  return String(text || "")
    .replace(ZERO_WIDTH_CHAR_REGEX, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePromptMatchKey(text) {
  return normalizePromptText(text).toLowerCase();
}

function extractSceneTag(text) {
  const match = String(text || "").match(GENERIC_SCENE_TAG_REGEX);
  return match ? `[${String(match[1] || "").toUpperCase()}]` : "";
}

function stripLeadingSceneTag(text) {
  return normalizePromptText(
    String(text || "").replace(/^\s*\[[A-Z0-9]+-[A-Z0-9]+\]\s*/i, "")
  );
}

function normalizePromptSceneMatchKey(text) {
  return normalizePromptMatchKey(stripLeadingSceneTag(text));
}

function extractMediaIdFromGalleryUrl(url = "") {
  const text = String(url || "");
  const match = text.match(/\/media\/([^/?#]+)/);
  return match ? match[1] : "";
}

function parsePromptDocumentMappings(rawText) {
  const text = (rawText || "").replace(/\r\n/g, "\n").trim();
  const byTag = new Map();
  const byImagePrompt = new Map();
  const imagePrompts = [];
  if (!text || !text.includes("|||")) return { byTag, byImagePrompt, imagePrompts };
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const sepIdx = line.indexOf("|||");
      if (sepIdx < 0) return;
      const left = normalizePromptText(line.slice(0, sepIdx));
      const right = normalizePromptText(line.slice(sepIdx + 3));
      if (!left || !right) return;
      const imageTag = extractSceneTag(left);
      const videoTag = extractSceneTag(right);
      const sceneTag = imageTag || videoTag;
      const imagePrompt = imageTag
        ? `${imageTag} ${stripLeadingSceneTag(left)}`
        : stripLeadingSceneTag(left);
      const videoPrompt = right;
      if (!imagePrompt || !videoPrompt) return;
      if (sceneTag) byTag.set(sceneTag, videoPrompt);
      const rawKey = normalizePromptMatchKey(left);
      const cleanKey = normalizePromptSceneMatchKey(left);
      if (rawKey) byImagePrompt.set(rawKey, videoPrompt);
      if (cleanKey) byImagePrompt.set(cleanKey, videoPrompt);
      imagePrompts.push({ imagePrompt, videoPrompt, sceneTag });
    });
  return { byTag, byImagePrompt, imagePrompts };
}

function resolveVideoPromptFromDocument(imagePrompt, parsedMappings) {
  if (!imagePrompt || !parsedMappings) return "";
  const byTag = parsedMappings.byTag || new Map();
  const byImagePrompt = parsedMappings.byImagePrompt || new Map();
  const tag = extractSceneTag(imagePrompt);
  if (tag && byTag.has(tag)) return byTag.get(tag);
  const normalized = normalizePromptMatchKey(imagePrompt);
  if (normalized && byImagePrompt.has(normalized)) return byImagePrompt.get(normalized);
  const normalizedScene = normalizePromptSceneMatchKey(imagePrompt);
  if (normalizedScene && byImagePrompt.has(normalizedScene)) return byImagePrompt.get(normalizedScene);
  return "";
}

// Build the per-image item shape the legacy modal expects from a rebuild
// gallery item. Preserves selection order so caller can map results back.
export function legacyItemFromGalleryItem(item, displayIndex, fallbackProjectId = "") {
  const imagePrompt = String(item?.prompt || item?.title || item?.fileName || "").trim();
  return {
    imageId: String(item?.id || item?.mediaId || `image-${displayIndex + 1}`),
    galleryAssetId: String(item?.id || ""),
    url: String(item?.imageUrl || item?.thumbnailUrl || item?.mediaUrl || ""),
    sourceUrl: String(item?.imageUrl || item?.mediaUrl || ""),
    originalUrl: String(item?.imageUrl || item?.mediaUrl || ""),
    mediaId: String(item?.mediaId || extractMediaIdFromGalleryUrl(item?.mediaUrl || item?.imageUrl || "") || "").trim(),
    projectId: String(item?.projectId || fallbackProjectId || ""),
    imagePrompt,
    videoPrompt: String(item?.videoPrompt || ""),
    selectionOrder: displayIndex,
    selectionLabel: displayIndex + 1,
    containerIndex: null,
    imageIndex: null,
    width: 0,
    height: 0,
    galleryItem: item
  };
}

// Translation strings — extracted from legacy i18n.js EN entries.
const T = {
  mvp_title_single: "Add Video Prompt",
  mvp_title_multi: "Add Video Prompts",
  mvp_desc: (count) => `${count} image(s) missing video prompt(s). Enter the video prompt to use for Animate Images.`,
  mvp_single_placeholder: "Enter video prompt...",
  mvp_mode_document: "Paste full prompt document (auto-match by scene tags)",
  mvp_mode_ordered: "Map prompt lines by image order (line 1 -> first selected image)",
  mvp_mode_shared: (count) => `Use one prompt for all ${count} images`,
  mvp_mode_individual: "Enter prompts one by one",
  mvp_help_button_title: "How this works",
  mvp_help_box_html: 'Paste your full script with <b>|||</b> separators. Auto Flow matches selected images to video prompts by scene tags (for example <b>[V1-S1]</b>, <b>[B1-D1]</b>).',
  mvp_document_placeholder: "Paste full prompt document with ||| separators...",
  mvp_ordered_placeholder: (count) => `Paste one video prompt per line (${count} lines required)...`,
  mvp_ordered_hint: "Line 1 maps to the first selected image in current gallery order.",
  mvp_shared_placeholder: "Enter video prompt for all images...",
  mvp_individual_placeholder: "Video prompt for this image...",
  mvp_button_cancel: "Cancel",
  mvp_button_confirm: "Add to Video Queue",
  mvp_doc_status_none: "No scene-tag mappings found yet. Paste the full document with ||| separators.",
  mvp_ordered_status_empty: "Paste one video prompt per line.",
  mvp_ordered_status_missing: ({ lineCount, expected, remaining }) => `Detected ${lineCount}/${expected} lines. Add ${remaining} more.`,
  mvp_ordered_status_extra: ({ lineCount, expected, extra }) => `Detected ${lineCount} lines for ${expected} images. Remove ${extra} line(s).`,
  mvp_ordered_status_ok: ({ lineCount, expected }) => `Detected ${lineCount}/${expected} lines. Mapping will follow gallery order.`,
  mvp_doc_status_paste_first: "Paste your prompt document first.",
  mvp_ordered_status_expected: ({ expected, lineCount }) => `Expected ${expected} lines, got ${lineCount}.`,
  mvp_unknown: "Unknown",
  mvp_unknown_prompt: "Unknown prompt"
};

export function showManualVideoPromptModal(missingItems, ctx = {}) {
  const log = typeof ctx.appendLog === "function"
    ? ctx.appendLog
    : (level, scope, msg) => console.log(`[${level}] ${scope}: ${msg}`);
  return new Promise((resolve) => {
    const existing = document.getElementById("manualVideoPromptModal");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "manualVideoPromptModal";
    overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;";

    const modal = document.createElement("div");
    modal.style.cssText = "background:#1e1e2e;border-radius:12px;padding:20px;max-width:480px;width:90%;max-height:80vh;overflow-y:auto;color:#fff;font-family:system-ui;";

    const resolvedPromptCount = missingItems.filter((item) => String(item?.videoPrompt || "").trim()).length;
    const hasResolvedPrompts = resolvedPromptCount > 0;
    const allPromptsResolved = missingItems.length > 0 && resolvedPromptCount === missingItems.length;
    const isSingleItem = missingItems.length === 1;
    const defaultPromptMode = !isSingleItem && allPromptsResolved ? "ordered" : "document";

    let modalTitle = isSingleItem ? T.mvp_title_single : T.mvp_title_multi;
    let modalDescription = T.mvp_desc(missingItems.length);
    if (isSingleItem && allPromptsResolved) {
      modalTitle = "Review video prompt";
      modalDescription = "Prompt already resolved for this image. Edit it if needed before queuing.";
    } else if (isSingleItem) {
      modalTitle = "Add video prompt";
      modalDescription = "Add the video prompt for this selected image.";
    } else if (allPromptsResolved) {
      modalTitle = "Review selected video prompts";
      modalDescription = "Prompts are already resolved in selected click order. Review or edit before queuing.";
    } else if (hasResolvedPrompts) {
      modalTitle = "Finish selected video prompts";
      modalDescription = `${resolvedPromptCount}/${missingItems.length} prompts are already resolved. Review them and fill in the rest.`;
    }

    let html = `<div style="font-size:16px;font-weight:600;margin-bottom:8px;">${escapeHtml(modalTitle)}</div>`;
    html += `<div style="font-size:12px;color:#aaa;margin-bottom:16px;">${escapeHtml(modalDescription)}</div>`;

    if (isSingleItem) {
      const shortPrompt = (missingItems[0].imagePrompt || T.mvp_unknown).substring(0, 80);
      const existingSinglePrompt = String(missingItems[0].videoPrompt || "");
      html += `<div style="font-size:11px;color:#888;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(missingItems[0].imagePrompt || "")}">${escapeHtml(shortPrompt)}</div>`;
      html += `<textarea id="mvp-single-prompt" placeholder="${escapeHtml(T.mvp_single_placeholder)}" style="width:100%;height:80px;background:#2a2a3e;border:1px solid #444;border-radius:8px;color:#fff;padding:10px;font-size:13px;resize:vertical;box-sizing:border-box;">${escapeHtml(existingSinglePrompt)}</textarea>`;
    } else {
      html += `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
          <input type="radio" name="mvp-mode" value="document" ${defaultPromptMode === "document" ? "checked" : ""} style="accent-color:#7c3aed;">
          ${T.mvp_mode_document}
          <button id="mvp-help-btn" type="button" title="${escapeHtml(T.mvp_help_button_title)}" style="width:20px;height:20px;min-width:20px;padding:0;border-radius:50%;border:1px solid #5b73b8;background:#1f2a4a;color:#b9ceff;font-size:12px;line-height:1;cursor:pointer;">?</button>
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
          <input type="radio" name="mvp-mode" value="ordered" ${defaultPromptMode === "ordered" ? "checked" : ""} style="accent-color:#7c3aed;">
          ${T.mvp_mode_ordered}
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
          <input type="radio" name="mvp-mode" value="shared" style="accent-color:#7c3aed;">
          ${T.mvp_mode_shared(missingItems.length)}
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
          <input type="radio" name="mvp-mode" value="individual" style="accent-color:#7c3aed;">
          ${T.mvp_mode_individual}
        </label>
      </div>`;

      html += `<div id="mvp-help-box" style="display:none;margin-bottom:10px;padding:8px;border-radius:8px;background:#182342;border:1px solid #304577;font-size:11px;line-height:1.45;color:#c8daff;">${T.mvp_help_box_html}</div>`;

      html += `<div id="mvp-document-section">
        <textarea id="mvp-document-input" placeholder="${escapeHtml(T.mvp_document_placeholder)}" style="width:100%;height:150px;background:#2a2a3e;border:1px solid #444;border-radius:8px;color:#fff;padding:10px;font-size:12px;resize:vertical;box-sizing:border-box;line-height:1.4;"></textarea>
        <div id="mvp-document-status" style="margin-top:6px;font-size:11px;color:#9ca3af;"></div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:8px;">
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:#cbd5e1;cursor:pointer;">
            <input id="mvp-require-all" type="checkbox" checked style="accent-color:#7c3aed;">
            Require all prompts
          </label>
        </div>
        <div id="mvp-document-unmatched" style="display:none;margin-top:8px;max-height:120px;overflow:auto;padding:8px;border-radius:8px;background:#2a1f2a;border:1px solid #5b2f3a;font-size:11px;color:#fecaca;line-height:1.35;"></div>
      </div>`;

      html += `<div id="mvp-ordered-section" style="display:none;">
        <textarea id="mvp-ordered-input" placeholder="${escapeHtml(T.mvp_ordered_placeholder(missingItems.length))}" style="width:100%;height:150px;background:#2a2a3e;border:1px solid #444;border-radius:8px;color:#fff;padding:10px;font-size:12px;resize:vertical;box-sizing:border-box;line-height:1.4;"></textarea>
        <div id="mvp-ordered-status" style="margin-top:6px;font-size:11px;color:#9ca3af;">${escapeHtml(allPromptsResolved ? `Ready: ${resolvedPromptCount}/${missingItems.length} prompts resolved in selected click order.` : T.mvp_ordered_hint)}</div>
      </div>`;

      html += `<div id="mvp-shared-section" style="display:none;">
        <textarea id="mvp-shared-prompt" placeholder="${escapeHtml(T.mvp_shared_placeholder)}" style="width:100%;height:80px;background:#2a2a3e;border:1px solid #444;border-radius:8px;color:#fff;padding:10px;font-size:13px;resize:vertical;box-sizing:border-box;"></textarea>
      </div>`;

      html += `<div id="mvp-individual-section" style="display:none;">`;
      missingItems.forEach((item, i) => {
        const shortPrompt = (item.imagePrompt || T.mvp_unknown).substring(0, 60);
        const existingPrompt = String(item.videoPrompt || "");
        html += `<div style="margin-bottom:12px;">
          <div style="font-size:11px;color:#888;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(item.imagePrompt || "")}">${i + 1}. ${escapeHtml(shortPrompt)}</div>
          <textarea class="mvp-individual-prompt" data-index="${i}" placeholder="${escapeHtml(T.mvp_individual_placeholder)}" style="width:100%;height:60px;background:#2a2a3e;border:1px solid #444;border-radius:8px;color:#fff;padding:8px;font-size:12px;resize:vertical;box-sizing:border-box;">${escapeHtml(existingPrompt)}</textarea>
        </div>`;
      });
      html += `</div>`;
    }

    html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:16px;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <input id="mvp-import-prompts-file" type="file" accept=".txt,text/plain" style="display:none;">
        <button id="mvp-import-prompts" type="button" style="padding:8px 16px;background:#22304f;color:#dbeafe;border:1px solid #3b4e77;border-radius:8px;cursor:pointer;font-size:13px;">Import Prompts</button>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
        <button id="mvp-cancel" style="padding:8px 16px;background:#333;color:#ccc;border:none;border-radius:8px;cursor:pointer;font-size:13px;">${T.mvp_button_cancel}</button>
        <button id="mvp-queue-matched" style="display:none;padding:8px 16px;background:#334155;color:#e2e8f0;border:1px solid #475569;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;">Queue matched only (0)</button>
        <button id="mvp-confirm" style="padding:8px 16px;background:#7c3aed;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;">${T.mvp_button_confirm}</button>
      </div>
    </div>`;

    modal.innerHTML = html;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Pre-populate document and ordered textareas with existing video prompts
    const itemsWithPrompts = missingItems.filter((item) => item.videoPrompt);
    if (itemsWithPrompts.length > 0 && missingItems.length > 1) {
      const docPrefill = missingItems
        .filter((item) => item.videoPrompt)
        .map((item) => String(item.videoPrompt || ""))
        .join("\n");
      const docEl = modal.querySelector("#mvp-document-input");
      if (docEl && docPrefill) docEl.value = docPrefill;

      const orderedPrefill = missingItems
        .map((item) => String(item.videoPrompt || ""))
        .join("\n");
      const orderedEl = modal.querySelector("#mvp-ordered-input");
      if (orderedEl && orderedPrefill.trim()) orderedEl.value = orderedPrefill;
    }

    const modeRadios = modal.querySelectorAll('input[name="mvp-mode"]');
    const docSection = modal.querySelector("#mvp-document-section");
    const orderedSection = modal.querySelector("#mvp-ordered-section");
    const sharedSection = modal.querySelector("#mvp-shared-section");
    const individualSection = modal.querySelector("#mvp-individual-section");
    const docStatus = modal.querySelector("#mvp-document-status");
    const docInput = modal.querySelector("#mvp-document-input");
    const orderedStatus = modal.querySelector("#mvp-ordered-status");
    const orderedInput = modal.querySelector("#mvp-ordered-input");
    const helpBtn = modal.querySelector("#mvp-help-btn");
    const helpBox = modal.querySelector("#mvp-help-box");
    const requireAllCheckbox = modal.querySelector("#mvp-require-all");
    const queueMatchedBtn = modal.querySelector("#mvp-queue-matched");
    const docUnmatched = modal.querySelector("#mvp-document-unmatched");
    const confirmBtn = modal.querySelector("#mvp-confirm");
    const importPromptsBtn = modal.querySelector("#mvp-import-prompts");
    const importPromptsFileInput = modal.querySelector("#mvp-import-prompts-file");
    const promptModeDrafts = { document: "", ordered: "", shared: "", individual: [] };
    const promptModeTouched = { document: false, ordered: false, shared: false, individual: false };
    let activePromptMode = "document";

    function getSelectedMode() {
      const selected = modal.querySelector('input[name="mvp-mode"]:checked');
      return selected?.value || "document";
    }
    function getIndividualPromptInputs() {
      return Array.from(modal.querySelectorAll(".mvp-individual-prompt"));
    }
    function normalizePromptDraftText(value) {
      return String(value || "").replace(/\r\n/g, "\n");
    }
    function normalizePromptDraftLines(lines) {
      return Array.isArray(lines) ? lines.map((line) => normalizePromptDraftText(line)) : [];
    }
    function readPromptModeDraft(mode) {
      if (mode === "document") return normalizePromptDraftText(docInput?.value || "");
      if (mode === "ordered") return normalizePromptDraftText(orderedInput?.value || "");
      if (mode === "shared") return normalizePromptDraftText(modal.querySelector("#mvp-shared-prompt")?.value || "");
      if (mode === "individual") return getIndividualPromptInputs().map((input) => normalizePromptDraftText(input.value || ""));
      return "";
    }
    function hasPromptDraftContent(mode, draft) {
      if (mode === "individual") return normalizePromptDraftLines(draft).some((line) => line.trim());
      return normalizePromptDraftText(draft).trim().length > 0;
    }
    function buildTaggedPromptDocument(promptLines = []) {
      return missingItems
        .map((item, index) => {
          const promptText = normalizePromptDraftText(promptLines[index] || "").trim();
          if (!promptText) return "";
          const tag = extractSceneTag(item?.imagePrompt || "");
          return tag ? `${tag} ${promptText}` : promptText;
        })
        .filter(Boolean)
        .join("\n");
    }
    function derivePromptLinesFromDraft(mode, draft) {
      if (mode === "document") {
        const parsed = parsePromptDocumentMappings(normalizePromptDraftText(draft));
        return missingItems.map((item) => resolveVideoPromptFromDocument(item?.imagePrompt, parsed) || "");
      }
      if (mode === "ordered") {
        const orderedLines = normalizePromptDraftText(draft).split(/\r?\n/).map((line) => line.trim());
        return missingItems.map((_, index) => orderedLines[index] || "");
      }
      if (mode === "shared") {
        const sharedText = normalizePromptDraftText(draft).trim();
        return missingItems.map(() => sharedText);
      }
      return normalizePromptDraftLines(draft).map((line) => line.trim());
    }
    function derivePromptModeDraft(targetMode, sourceMode, sourceDraft) {
      if (targetMode === sourceMode) return sourceDraft;
      if (targetMode === "document") return buildTaggedPromptDocument(derivePromptLinesFromDraft(sourceMode, sourceDraft));
      if (targetMode === "ordered") return derivePromptLinesFromDraft(sourceMode, sourceDraft).join("\n");
      if (targetMode === "individual") return missingItems.map((_, index) => derivePromptLinesFromDraft(sourceMode, sourceDraft)[index] || "");
      if (targetMode === "shared") {
        const promptLines = derivePromptLinesFromDraft(sourceMode, sourceDraft).map((line) => normalizePromptDraftText(line).trim()).filter(Boolean);
        if (promptLines.length === 0) return "";
        const uniquePromptLines = Array.from(new Set(promptLines));
        return uniquePromptLines.length === 1 ? uniquePromptLines[0] : "";
      }
      return "";
    }
    function writePromptModeDraft(mode, draft, options = {}) {
      const { markTouched = false, dispatchInput = false } = options;
      if (mode === "document") {
        if (docInput) {
          docInput.value = normalizePromptDraftText(draft);
          if (dispatchInput) docInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } else if (mode === "ordered") {
        if (orderedInput) {
          orderedInput.value = normalizePromptDraftText(draft);
          if (dispatchInput) orderedInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } else if (mode === "shared") {
        const sharedInput = modal.querySelector("#mvp-shared-prompt");
        if (sharedInput) {
          sharedInput.value = normalizePromptDraftText(draft);
          if (dispatchInput) sharedInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } else if (mode === "individual") {
        const individualInputs = getIndividualPromptInputs();
        const nextDraft = normalizePromptDraftLines(draft);
        individualInputs.forEach((input, index) => {
          input.value = nextDraft[index] || "";
          if (dispatchInput) input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }
      promptModeDrafts[mode] = mode === "individual" ? normalizePromptDraftLines(draft) : normalizePromptDraftText(draft);
      if (markTouched) promptModeTouched[mode] = hasPromptDraftContent(mode, draft);
    }
    function syncPromptModeDraft(mode, options = {}) {
      const draft = readPromptModeDraft(mode);
      promptModeDrafts[mode] = mode === "individual" ? normalizePromptDraftLines(draft) : normalizePromptDraftText(draft);
      if (options.markTouched) promptModeTouched[mode] = hasPromptDraftContent(mode, draft);
      return promptModeDrafts[mode];
    }
    function maybeSeedPromptModeDraft(targetMode, sourceMode) {
      if (targetMode === sourceMode) return;
      const existingDraft = promptModeDrafts[targetMode];
      if (promptModeTouched[targetMode] || hasPromptDraftContent(targetMode, existingDraft)) return;
      const sourceDraft = promptModeDrafts[sourceMode];
      if (!hasPromptDraftContent(sourceMode, sourceDraft)) return;
      const derivedDraft = derivePromptModeDraft(targetMode, sourceMode, sourceDraft);
      if (!hasPromptDraftContent(targetMode, derivedDraft)) return;
      writePromptModeDraft(targetMode, derivedDraft, { dispatchInput: targetMode !== "document" });
      if (targetMode === "document") updateDocumentFeedback();
    }

    function getActivePromptImportTarget() {
      if (missingItems.length === 1) return modal.querySelector("#mvp-single-prompt");
      const mode = getSelectedMode();
      if (mode === "document") return modal.querySelector("#mvp-document-input");
      if (mode === "ordered") return modal.querySelector("#mvp-ordered-input");
      if (mode === "shared") return modal.querySelector("#mvp-shared-prompt");
      const focusedIndividual = document.activeElement?.classList?.contains("mvp-individual-prompt") ? document.activeElement : null;
      return focusedIndividual || modal.querySelector(".mvp-individual-prompt");
    }
    function applyImportedPromptText(text) {
      const target = getActivePromptImportTarget();
      if (!target) return false;
      target.value = String(text || "");
      target.style.borderColor = "#444";
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.focus();
      return true;
    }

    function truncatePrompt(value, maxLength = 62) {
      const text = String(value || "");
      if (text.length <= maxLength) return text;
      return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
    }
    function buildUnmatchedDescriptor(item, index) {
      const normalizedPrompt = normalizePromptText(item?.imagePrompt || "");
      const normalizedKey = normalizePromptMatchKey(normalizedPrompt);
      const selectionIndex = Number.isFinite(Number(item?.selectionOrder)) ? Number(item.selectionOrder) + 1 : index + 1;
      const tag = extractSceneTag(normalizedPrompt);
      const promptSnippet = truncatePrompt(normalizedPrompt || T.mvp_unknown_prompt);
      const displayText = `${selectionIndex}. ${tag ? `${tag} ` : ""}${promptSnippet}`.trim();
      return { index: selectionIndex, normalizedKey: normalizedKey || "unknown", displayText };
    }
    function logDocumentMatchState(results, unresolved) {
      log("info", "gallery", `mvp_match_summary matched=${results.length} missing=${unresolved.length}`);
      unresolved.forEach((entry) => {
        log("warn", "gallery", `mvp_unmatched_item index=${entry.index} key=${entry.normalizedKey}`);
      });
    }
    function collectDocumentMatches(buildPromptResult) {
      const rawDocument = String(docInput?.value || "").trim();
      const parsed = parsePromptDocumentMappings(rawDocument);
      const results = [];
      const unresolved = [];
      missingItems.forEach((item, idx) => {
        const videoPrompt = resolveVideoPromptFromDocument(item.imagePrompt, parsed);
        if (videoPrompt) results.push(buildPromptResult(item, videoPrompt));
        else unresolved.push(buildUnmatchedDescriptor(item, idx));
      });
      return { rawDocument, parsed, results, unresolved };
    }
    function updateDocumentFeedback(matchData = null) {
      const data = matchData || collectDocumentMatches((item, videoPrompt, extra = {}) => ({
        ...item, videoPrompt: String(videoPrompt || "").trim(), ...extra
      }));
      const hasInput = Boolean(data.rawDocument);
      const hasTagMappings = data.parsed?.byTag?.size > 0;
      const hasUnmatched = data.unresolved.length > 0;
      const hasMatched = data.results.length > 0;
      const documentModeActive = getSelectedMode() === "document";
      if (docStatus) {
        if (!hasInput) {
          docStatus.textContent = "";
          docStatus.style.color = "#9ca3af";
        } else if (!hasTagMappings) {
          docStatus.textContent = T.mvp_doc_status_none;
          docStatus.style.color = "#fbbf24";
        } else if (hasUnmatched) {
          docStatus.textContent = `Matched ${data.results.length}/${missingItems.length}. Missing ${data.unresolved.length}.`;
          docStatus.style.color = "#fca5a5";
        } else {
          docStatus.textContent = `Matched ${data.results.length}/${missingItems.length}.`;
          docStatus.style.color = "#86efac";
        }
      }
      if (docUnmatched) {
        if (documentModeActive && hasInput && hasUnmatched) {
          const rows = data.unresolved.map((entry) => `<div>${escapeHtml(entry.displayText)}</div>`).join("");
          docUnmatched.innerHTML = `<div style="font-weight:600;margin-bottom:5px;">Unmatched items</div>${rows}`;
          docUnmatched.style.display = "";
        } else {
          docUnmatched.innerHTML = "";
          docUnmatched.style.display = "none";
        }
      }
      const queueMatchedLabel = `Queue matched only (${data.results.length})`;
      if (queueMatchedBtn) {
        queueMatchedBtn.textContent = queueMatchedLabel;
        queueMatchedBtn.style.display = documentModeActive && hasUnmatched && hasMatched ? "" : "none";
        queueMatchedBtn.disabled = !(documentModeActive && hasUnmatched && hasMatched);
      }
      if (confirmBtn) {
        if (documentModeActive && hasUnmatched && (requireAllCheckbox?.checked !== false)) {
          confirmBtn.textContent = "Require all prompts";
        } else {
          confirmBtn.textContent = T.mvp_button_confirm;
        }
      }
      return data;
    }
    function updateModeUi() {
      const mode = getSelectedMode();
      syncPromptModeDraft(activePromptMode);
      maybeSeedPromptModeDraft(mode, activePromptMode);
      activePromptMode = mode;
      if (docSection) docSection.style.display = mode === "document" ? "" : "none";
      if (orderedSection) orderedSection.style.display = mode === "ordered" ? "" : "none";
      if (sharedSection) sharedSection.style.display = mode === "shared" ? "" : "none";
      if (individualSection) individualSection.style.display = mode === "individual" ? "" : "none";
      if (mode === "document") {
        updateDocumentFeedback();
      } else {
        if (queueMatchedBtn) queueMatchedBtn.style.display = "none";
        if (docUnmatched) {
          docUnmatched.innerHTML = "";
          docUnmatched.style.display = "none";
        }
        if (confirmBtn) confirmBtn.textContent = T.mvp_button_confirm;
      }
    }

    modeRadios.forEach((radio) => radio.addEventListener("change", updateModeUi));
    updateModeUi();

    if (helpBtn && helpBox) {
      helpBtn.addEventListener("click", () => {
        helpBox.style.display = helpBox.style.display === "none" ? "block" : "none";
      });
    }

    if (docInput) {
      docInput.addEventListener("input", () => {
        docInput.style.borderColor = "#444";
        syncPromptModeDraft("document", { markTouched: true });
        updateDocumentFeedback();
      });
    }
    if (requireAllCheckbox) {
      requireAllCheckbox.addEventListener("change", () => updateDocumentFeedback());
    }

    function queueMatchedOnlyFromDocument() {
      const buildPromptResult = (item, videoPrompt, extra = {}) => ({ ...item, videoPrompt: String(videoPrompt || "").trim(), ...extra });
      const matchData = collectDocumentMatches(buildPromptResult);
      updateDocumentFeedback(matchData);
      if (!matchData.rawDocument) {
        if (docInput) docInput.style.borderColor = "#ef4444";
        if (docStatus) {
          docStatus.textContent = T.mvp_doc_status_paste_first;
          docStatus.style.color = "#fca5a5";
        }
        return;
      }
      logDocumentMatchState(matchData.results, matchData.unresolved);
      log("info", "gallery", "mvp_queue_mode mode=matched_only");
      log("warn", "gallery", `mvp_queue_matched_only queued=${matchData.results.length} skipped=${matchData.unresolved.length}`);
      if (matchData.results.length === 0) {
        if (docStatus) {
          docStatus.textContent = "No matched prompts found. Add at least one matching prompt to queue.";
          docStatus.style.color = "#fca5a5";
        }
        return;
      }
      overlay.remove();
      resolve(matchData.results);
    }

    if (queueMatchedBtn) queueMatchedBtn.addEventListener("click", queueMatchedOnlyFromDocument);

    if (orderedInput && orderedStatus) {
      orderedInput.addEventListener("input", () => {
        orderedInput.style.borderColor = "#444";
        syncPromptModeDraft("ordered", { markTouched: true });
        const lineCount = orderedInput.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
        if (lineCount === 0) {
          orderedStatus.textContent = T.mvp_ordered_status_empty;
          orderedStatus.style.color = "#9ca3af";
          return;
        }
        if (lineCount < missingItems.length) {
          orderedStatus.textContent = T.mvp_ordered_status_missing({ lineCount, expected: missingItems.length, remaining: missingItems.length - lineCount });
          orderedStatus.style.color = "#fbbf24";
          return;
        }
        if (lineCount > missingItems.length) {
          orderedStatus.textContent = T.mvp_ordered_status_extra({ lineCount, expected: missingItems.length, extra: lineCount - missingItems.length });
          orderedStatus.style.color = "#fca5a5";
          return;
        }
        orderedStatus.textContent = T.mvp_ordered_status_ok({ lineCount, expected: missingItems.length });
        orderedStatus.style.color = "#86efac";
      });
    }

    modal.querySelector("#mvp-shared-prompt")?.addEventListener("input", (event) => {
      event.target.style.borderColor = "#444";
      syncPromptModeDraft("shared", { markTouched: true });
    });

    getIndividualPromptInputs().forEach((input) => {
      input.addEventListener("input", (event) => {
        event.target.style.borderColor = "#444";
        syncPromptModeDraft("individual", { markTouched: true });
      });
    });

    if (importPromptsBtn && importPromptsFileInput) {
      importPromptsBtn.addEventListener("click", () => {
        importPromptsFileInput.value = "";
        importPromptsFileInput.click();
      });
      importPromptsFileInput.addEventListener("change", () => {
        const file = importPromptsFileInput.files?.[0] || null;
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const text = String(reader.result || "");
          const applied = applyImportedPromptText(text);
          log(applied ? "info" : "warn", "gallery", `mvp_import_prompts target=${applied ? (getActivePromptImportTarget()?.id || getSelectedMode() || "individual") : "missing"} bytes=${text.length}`);
        };
        reader.onerror = () => log("warn", "gallery", `mvp_import_prompts_failed reason=${reader.error?.message || "read_failed"}`);
        reader.readAsText(file);
      });
    }

    if (orderedInput && orderedInput.value) orderedInput.dispatchEvent(new Event("input"));
    if (docInput && docInput.value && getSelectedMode() === "document") docInput.dispatchEvent(new Event("input"));
    syncPromptModeDraft("document");
    syncPromptModeDraft("ordered");
    syncPromptModeDraft("shared");
    syncPromptModeDraft("individual");

    modal.querySelector("#mvp-cancel").addEventListener("click", () => {
      overlay.remove();
      resolve(null);
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) { overlay.remove(); resolve(null); }
    });

    modal.querySelector("#mvp-confirm").addEventListener("click", () => {
      const results = [];
      const buildPromptResult = (item, videoPrompt, extra = {}) => ({ ...item, videoPrompt: String(videoPrompt || "").trim(), ...extra });

      if (isSingleItem) {
        const prompt = (modal.querySelector("#mvp-single-prompt")?.value || "").trim();
        if (!prompt) {
          modal.querySelector("#mvp-single-prompt").style.borderColor = "#ef4444";
          return;
        }
        results.push(buildPromptResult(missingItems[0], prompt));
      } else {
        const mode = getSelectedMode();
        if (mode === "document") {
          const matchData = collectDocumentMatches(buildPromptResult);
          if (!matchData.rawDocument) {
            if (docInput) docInput.style.borderColor = "#ef4444";
            if (docStatus) {
              docStatus.textContent = T.mvp_doc_status_paste_first;
              docStatus.style.color = "#fca5a5";
            }
            return;
          }
          updateDocumentFeedback(matchData);
          logDocumentMatchState(matchData.results, matchData.unresolved);
          const requireAllPrompts = requireAllCheckbox?.checked !== false;
          if (matchData.unresolved.length > 0 && requireAllPrompts) {
            log("info", "gallery", "mvp_queue_mode mode=require_all");
            return;
          }
          if (matchData.unresolved.length > 0) {
            log("info", "gallery", "mvp_queue_mode mode=matched_only");
            log("warn", "gallery", `mvp_queue_matched_only queued=${matchData.results.length} skipped=${matchData.unresolved.length}`);
          } else {
            log("info", "gallery", "mvp_queue_mode mode=require_all");
          }
          if (matchData.results.length === 0) {
            if (docStatus) {
              docStatus.textContent = "No matched prompts found. Add at least one matching prompt to queue.";
              docStatus.style.color = "#fca5a5";
            }
            return;
          }
          results.push(...matchData.results);
        } else if (mode === "ordered") {
          const orderedLines = (orderedInput?.value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          if (orderedLines.length !== missingItems.length) {
            if (orderedInput) orderedInput.style.borderColor = "#ef4444";
            if (orderedStatus) {
              orderedStatus.textContent = T.mvp_ordered_status_expected({ expected: missingItems.length, lineCount: orderedLines.length });
              orderedStatus.style.color = "#fca5a5";
            }
            return;
          }
          missingItems.forEach((item, idx) => {
            results.push(buildPromptResult(item, orderedLines[idx], { mappingMode: "order_lines" }));
          });
        } else if (mode === "shared") {
          const sharedPrompt = (modal.querySelector("#mvp-shared-prompt")?.value || "").trim();
          if (!sharedPrompt) {
            modal.querySelector("#mvp-shared-prompt").style.borderColor = "#ef4444";
            return;
          }
          missingItems.forEach((item) => results.push(buildPromptResult(item, sharedPrompt)));
        } else {
          const textareas = modal.querySelectorAll(".mvp-individual-prompt");
          let hasEmpty = false;
          textareas.forEach((ta) => {
            const val = ta.value.trim();
            if (!val) { ta.style.borderColor = "#ef4444"; hasEmpty = true; }
            else { ta.style.borderColor = "#444"; }
          });
          if (hasEmpty) return;
          textareas.forEach((ta, i) => results.push(buildPromptResult(missingItems[i], ta.value.trim())));
        }
      }
      overlay.remove();
      resolve(results);
    });

    setTimeout(() => {
      const first = modal.querySelector("#mvp-single-prompt")
        || modal.querySelector("#mvp-document-input")
        || modal.querySelector("#mvp-ordered-input")
        || modal.querySelector("#mvp-shared-prompt")
        || modal.querySelector(".mvp-individual-prompt");
      if (first) first.focus();
    }, 100);
  });
}
