import { MessageType } from "../core/contracts/messages.js";
import { FLOW_MODES } from "./runtime-config.js";
import { buildMediaRedirectUrl, normalizeMediaRedirectUrl, normalizeMediaThumbnailUrl } from "../core/contracts/api.js";
import { buildGalleryItemsFromTasks, canonicalGalleryItems, filterGalleryItemsForProject, referenceMediaIdsFromTasks } from "../core/gallery/media-ledger.js";
import { mergeSceneGalleryItems } from "../core/gallery/scene-builder.js";
import { cleanGalleryPromptText, galleryPromptLabel, galleryPromptPreview } from "./gallery-text.js";
import {
  buildAnimatePromptAssignments,
  parseAutoFlowPromptDocument,
  promptForImageFromAutoFlowEntry,
  sceneTag
} from "../core/gallery/animate-prompts.js";
import {
  showManualVideoPromptModal,
  legacyItemFromGalleryItem
} from "./animate-modal-legacy.js";

function node(tag, opts, ...kids) {
  const element = document.createElement(tag);
  opts = opts || {};
  // The original builder silently dropped opts.id, which left every
  // modal button without its id and broke every modal.querySelector
  // wiring inside Animate Images. Honor it as a first-class field so
  // existing call sites (`{ id: "animateCancel", ... }`) work.
  if (opts.id) element.id = opts.id;
  if (opts.class) element.className = opts.class;
  if (opts.text !== undefined) element.textContent = opts.text;
  if (opts.data) {
    for (const [key, value] of Object.entries(opts.data)) {
      element.dataset[key] = value;
    }
  }
  if (opts.attrs) {
    for (const [key, value] of Object.entries(opts.attrs)) {
      if (value !== null && value !== undefined) element.setAttribute(key, value);
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined) continue;
    element.append(kid);
  }
  return element;
}

function iconEl(name) {
  return node("span", { class: "material-symbols-outlined", attrs: { "aria-hidden": "true" }, text: name });
}

function readFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

export function createGalleryController(deps) {
  const {
    getState,
    send,
    appendLog,
    persistState,
    hydrateStateFromStorage,
    render,
    updatePreset,
    applyRuntimePayload,
    openExternal,
    captureUiSnapshot,
    restoreUiSnapshot,
    ensureFlowProject,
    ensureMediaIds,
    taskSettingsForMode,
    queueBatchTitle
  } = deps;

  const state = () => getState();
  function bindAfterGallery(root) {
    hydrateGalleryPreviewImages(root);
    hydrateVisibleGalleryImages(root);
    bindAspectAwareMedia(root);
    root.querySelectorAll(".gallery-subtab").forEach((tab) => {
      tab.addEventListener("click", async () => {
        state().ui.galleryTab = tab.dataset.gallery;
        await persistState();
        render();
      });
    });
    root.querySelectorAll("[data-gallery-view]").forEach((button) => {
      button.addEventListener("click", async () => {
        state().ui.galleryViewMode = button.dataset.galleryView || "grid";
        await persistState();
        render();
      });
    });
    root.querySelectorAll("[data-gallery-size]").forEach((button) => {
      button.addEventListener("click", async () => {
        state().ui.gallerySize = button.dataset.gallerySize || "small";
        await persistState();
        render();
      });
    });
    root.querySelectorAll("#downloadResolution, #videoDownloadRes").forEach((select) => {
      select.addEventListener("change", () => {
        const key = select.id === "videoDownloadRes" ? "videoDownloadResolution" : "imageAutoDownloadResolution";
        updatePreset(key, select.value);
      });
    });
    root.querySelectorAll("#imageSortOrder, #videoSortOrder").forEach((select) => {
      select.addEventListener("change", async () => {
        state().ui.gallerySortOrder = select.value || "num-asc";
        await persistState();
        render();
      });
    });
    root.querySelector("#videoSpeedSlider")?.addEventListener("input", async (event) => {
      state().ui.videoSpeed = String(event.target.value || "1");
      const input = root.querySelector("#videoSpeedInput");
      if (input) input.value = state().ui.videoSpeed;
      applyVideoPlaybackSettings(root);
      await persistState({ suppressStorageRender: true });
    });
    root.querySelector("#videoSpeedInput")?.addEventListener("change", async (event) => {
      const value = Math.max(0.25, Math.min(6, Number.parseFloat(event.target.value || "1") || 1));
      state().ui.videoSpeed = String(value);
      event.target.value = state().ui.videoSpeed;
      const slider = root.querySelector("#videoSpeedSlider");
      if (slider) slider.value = state().ui.videoSpeed;
      applyVideoPlaybackSettings(root);
      await persistState({ suppressStorageRender: true });
    });
    root.querySelector("#videoVolumeSlider")?.addEventListener("input", async (event) => {
      const value = Math.max(0, Math.min(1, Number.parseFloat(event.target.value || "0.05") || 0));
      state().ui.videoVolume = String(value);
      applyVideoPlaybackSettings(root);
      await persistState({ suppressStorageRender: true });
    });
    applyVideoPlaybackSettings(root);
    bindVideoGalleryHoverPreviews(root);
    const galleryScrollRoot = root.querySelector(".gallery-grid, .gallery-table-view") || root;
    if (galleryScrollRoot && galleryScrollRoot.dataset.galleryThumbnailHydrationBound !== "1") {
      galleryScrollRoot.dataset.galleryThumbnailHydrationBound = "1";
      let thumbnailHydrationTimer = 0;
      galleryScrollRoot.addEventListener("scroll", () => {
        clearTimeout(thumbnailHydrationTimer);
        thumbnailHydrationTimer = window.setTimeout(() => {
          hydrateVisibleGalleryImages(root);
        }, 200);
      }, { passive: true });
    }
    root.querySelectorAll("[data-gallery-help]").forEach((button) => {
      button.addEventListener("click", async () => {
        const key = String(button.dataset.galleryHelp || "");
        state().ui.galleryHelpKey = state().ui.galleryHelpKey === key ? "" : key;
        await persistState();
        render();
      });
    });
    root.querySelector("#galleryHelpCloseBtn")?.addEventListener("click", async () => {
      state().ui.galleryHelpKey = "";
      await persistState();
      render();
    });
    root.querySelector("#gallery-sync-btn")?.addEventListener("click", async () => {
      await syncGallery();
    });
    root.querySelector("#importGalleryImagesBtn")?.addEventListener("click", () => {
      root.querySelector("#galleryImportInput")?.click();
    });
    root.querySelector("#galleryImportInput")?.addEventListener("change", async (event) => {
      await importGalleryImageFiles([...(event.target.files || [])]);
      event.target.value = "";
    });
    root.querySelector("#gallery-download-btn")?.addEventListener("click", async () => {
      await downloadSelectedGalleryItems();
    });
    root.querySelector("#gallery-send-scenes-btn")?.addEventListener("click", async () => {
      await sendSelectedVideosToScenes();
    });
    root.querySelector("#gallery-send-scenes-top-btn")?.addEventListener("click", async () => {
      await sendSelectedVideosToScenes();
    });
    root.querySelector("#gallery-animate-images-btn")?.addEventListener("click", async (event) => {
      // Layered diagnostics: log immediately so the user can confirm the
      // click registered, pulse the button for instant visual feedback,
      // and surface any thrown error from the modal opener instead of
      // letting the async-handler swallow it silently.
      const button = event.currentTarget;
      appendLog("info", "gallery", "Animate Images: button clicked.");
      button?.classList.add("is-pulsing");
      window.setTimeout(() => button?.classList.remove("is-pulsing"), 320);
      try {
        await openAnimateImagesModal();
      } catch (error) {
        appendLog("error", "gallery",
          `Animate Images crashed: ${error?.message || String(error) || "unknown"}.`);
        console.error("[AutoFlow] Animate Images handler error", error);
      }
    });
    root.querySelector("#liveQueueResumeBtn")?.addEventListener("click", async () => {
      await deps.resumeQueue();
    });
    root.querySelector("#liveQueueStopBtn")?.addEventListener("click", async () => {
      await deps.stopQueue();
      render();
    });
    root.querySelector("#liveQueueClearDoneBtn")?.addEventListener("click", async () => {
      await deps.pruneFinishedQueueItems();
    });
    root.querySelector("#liveQueueClearAllBtn")?.addEventListener("click", async () => {
      await deps.clearQueue({ force: true });
    });
    root.querySelector("#gallery-select-all-btn")?.addEventListener("click", async () => {
      const activeItems = activeGalleryItems();
      state().ui.selectedGalleryIds = [...new Set([
        ...(state().ui.selectedGalleryIds || []),
        ...activeItems.map((item) => item.id)
      ])];
      appendLog("info", "gallery", `Selected ${activeItems.length} ${activeGalleryTabForActions()}.`);
      updateGallerySelectionSurface();
      await persistState({ suppressStorageRender: true });
    });
    root.querySelector("#gallery-deselect-all-btn")?.addEventListener("click", async () => {
      const activeIds = new Set(activeGalleryItems().map((item) => item.id));
      state().ui.selectedGalleryIds = (state().ui.selectedGalleryIds || []).filter((id) => !activeIds.has(id));
      appendLog("info", "gallery", "Cleared selected gallery items.");
      updateGallerySelectionSurface();
      await persistState({ suppressStorageRender: true });
    });
    root.querySelector("#gallery-random-pick-btn")?.addEventListener("click", async () => {
      randomPickActiveGalleryItems();
      updateGallerySelectionSurface();
      await persistState({ suppressStorageRender: true });
    });
    root.querySelector("#gallery-random-videos-btn")?.addEventListener("click", async () => {
      randomPickActiveGalleryItems();
      updateGallerySelectionSurface();
      await persistState({ suppressStorageRender: true });
    });
    root.querySelector("#gallery-pick-matched-btn")?.addEventListener("click", async () => {
      pickMatchedGalleryItems();
      updateGallerySelectionSurface();
      await persistState({ suppressStorageRender: true });
    });
    root.querySelectorAll("[data-gallery-id]").forEach((button) => {
      button.addEventListener("pointerdown", (event) => {
        if (event.button === 0) event.preventDefault();
      });
      button.addEventListener("dblclick", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await openGalleryItemPreview(button.dataset.galleryId);
      });
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const snapshot = captureUiSnapshot();
        const id = button.dataset.galleryId;
        const selected = new Set(state().ui.selectedGalleryIds || []);
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        state().ui.selectedGalleryIds = [...selected];
        updateGallerySelectionSurface();
        await persistState({ suppressStorageRender: true });
        restoreUiSnapshot(snapshot);
      });
    });
    root.querySelectorAll("[data-live-preview-url]").forEach((button) => {
      button.addEventListener("dblclick", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        openMediaPreview({
          items: liveQueuePreviewItems(),
          index: liveQueuePreviewItems().findIndex((item) => item.url === button.dataset.livePreviewUrl),
          url: button.dataset.livePreviewUrl,
          kind: button.dataset.livePreviewKind,
          title: button.dataset.livePreviewTitle || "Live queue preview"
        });
      });
    });
    bindLiveQueueHoverPreviews(root);
    hydrateVisibleLiveQueueVideoThumbnails(root);
  }

  function isFlowRedirectPreviewUrl(url = "") {
    return /\/media\.getMediaUrlRedirect\b/i.test(String(url || ""));
  }

  function applyMediaAspectClass(media) {
    const holder = media.closest(".gallery-image-item, .gallery-video-item, .live-output-slot");
    if (!holder) return;
    const width = Number(media.naturalWidth || media.videoWidth || 0);
    const height = Number(media.naturalHeight || media.videoHeight || 0);
    if (!width || !height) return;
    holder.classList.remove("aspect-auto", "aspect-landscape", "aspect-portrait", "aspect-square");
    const ratio = width / height;
    if (ratio > 1.12) holder.classList.add("aspect-landscape");
    else if (ratio < 0.88) holder.classList.add("aspect-portrait");
    else holder.classList.add("aspect-square");
  }

  function bindAspectAwareMedia(root) {
    root.querySelectorAll(".gallery-image-item img, .gallery-video-item img, .gallery-video-item video, .gallery-table-thumb-strip img, .gallery-table-thumb-strip video").forEach((media) => {
      if (media.dataset.aspectBound === "1") return;
      media.dataset.aspectBound = "1";
      if ((media.naturalWidth || media.videoWidth) && (media.naturalHeight || media.videoHeight)) {
        applyMediaAspectClass(media);
        return;
      }
      media.addEventListener("load", () => applyMediaAspectClass(media), { once: true });
      media.addEventListener("loadedmetadata", () => applyMediaAspectClass(media), { once: true });
    });
  }

  function bindVideoGalleryHoverPreviews(root) {
    root.querySelectorAll(".gallery-video-item[data-video-preview-url]").forEach((tile) => {
      if (tile.dataset.videoHoverBound === "1") return;
      tile.dataset.videoHoverBound = "1";
      let hoverTimer = 0;
      tile.addEventListener("mouseenter", () => {
        clearTimeout(hoverTimer);
        hoverTimer = window.setTimeout(() => startVideoGalleryHoverPreview(root, tile), 60);
      });
      tile.addEventListener("mouseleave", () => {
        clearTimeout(hoverTimer);
        stopVideoGalleryHoverPreview(tile);
      });
    });
  }

  function bindLiveQueueHoverPreviews(root) {
    root.querySelectorAll("[data-live-preview-url][data-live-preview-kind='videos']").forEach((button) => {
      if (button.dataset.liveHoverBound === "1") return;
      button.dataset.liveHoverBound = "1";
      button.addEventListener("mouseenter", () => {
        const video = button.querySelector("video");
        if (!video) return;
        video.preload = "auto";
        video.loop = true;
        applyPreviewVideoPlaybackSettings(video);
        video.play().catch(() => {
          video.muted = true;
          video.setAttribute("muted", "");
          video.play().catch(() => {});
        });
      });
      button.addEventListener("mouseleave", () => {
        const video = button.querySelector("video");
        if (!video) return;
        try {
          video.pause();
          video.currentTime = 0;
        } catch (_error) {}
      });
    });
  }

  function hydrateVisibleLiveQueueVideoThumbnails(root) {
    const buttons = [...root.querySelectorAll(".live-output-slot[data-live-preview-url][data-live-preview-kind='videos']")]
      .filter((button) => !button.dataset.liveThumbnailRequested)
      .filter((button) => isElementNearViewport(button))
      .slice(0, 10);
    buttons.forEach((button, index) => {
      button.dataset.liveThumbnailRequested = "1";
      setTimeout(() => warmLiveQueueVideoStillFrame(button), index * 120);
    });
  }

  function warmLiveQueueVideoStillFrame(button) {
    const url = String(button?.dataset?.livePreviewUrl || "").trim();
    const video = button?.querySelector?.("video");
    if (!url || !video || button.matches(":hover")) return;
    button.classList.add("preview-warming");
    const markReady = () => {
      if (video.readyState < 2) return;
      button.classList.add("preview-frame-ready");
      button.classList.remove("preview-warming");
    };
    const markUnavailable = () => {
      button.classList.remove("preview-frame-ready");
      button.classList.remove("preview-warming");
    };
    video.addEventListener("loadeddata", markReady, { once: true });
    video.addEventListener("canplay", markReady, { once: true });
    video.addEventListener("error", markUnavailable, { once: true });
    video.preload = "auto";
    video.muted = true;
    video.setAttribute("muted", "");
    video.playsInline = true;
    if (video.getAttribute("src") !== url) {
      video.setAttribute("src", url);
    }
    try {
      video.load();
    } catch (_error) {}
    const seekFirstFrame = () => {
      if (button.matches(":hover")) return;
      try {
        if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < 0.001) {
          video.currentTime = Math.min(0.08, video.duration / 20);
        }
      } catch (_error) {}
    };
    if (video.readyState >= 1) seekFirstFrame();
    else video.addEventListener("loadedmetadata", seekFirstFrame, { once: true });
    if (video.readyState >= 2) markReady();
  }

  function isElementNearViewport(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const height = window.innerHeight || document.documentElement.clientHeight || 800;
    const width = window.innerWidth || document.documentElement.clientWidth || 360;
    return rect.bottom >= -220 && rect.top <= height + 360 && rect.right >= -80 && rect.left <= width + 80;
  }

  function ensureVideoGalleryHoverElement(tile) {
    let video = tile.querySelector("video.gallery-video-hover-preview");
    if (video) return video;
    video = document.createElement("video");
    video.className = "gallery-video-hover-preview";
    video.loop = true;
    video.playsInline = true;
    video.preload = "none";
    video.setAttribute("muted", "");
    const markReady = () => {
      if (video.readyState < 2) return;
      const parent = video.closest(".gallery-video-item");
      parent?.classList.add("preview-frame-ready");
      parent?.classList.remove("preview-warming");
    };
    const markUnavailable = () => {
      const parent = video.closest(".gallery-video-item");
      parent?.classList.remove("preview-frame-ready");
      parent?.classList.remove("preview-warming");
    };
    video.addEventListener("loadeddata", markReady);
    video.addEventListener("canplay", markReady);
    video.addEventListener("error", markUnavailable);
    video.addEventListener("emptied", markUnavailable);
    tile.appendChild(video);
    return video;
  }

  function startVideoGalleryHoverPreview(root, tile) {
    const url = String(tile?.dataset?.videoPreviewUrl || "").trim();
    if (!url) return;
    const video = ensureVideoGalleryHoverElement(tile);
    const speed = Math.max(0.25, Math.min(6, Number.parseFloat(state().ui.videoSpeed || "1") || 1));
    const volume = Math.max(0, Math.min(1, Number.parseFloat(state().ui.videoVolume || "0.05") || 0.05));
    tile.classList.remove("preview-idle");
    tile.classList.add("preview-playing");
    if (video.readyState < 2) tile.classList.add("preview-warming");
    video.playbackRate = speed;
    video.volume = volume;
    video.muted = volume === 0;
    if (volume > 0) video.removeAttribute("muted");
    if (video.src !== url) {
      tile.classList.remove("preview-frame-ready");
      video.src = url;
      video.preload = "auto";
      video.dataset.previewHydratedAt = String(Date.now());
      try {
        video.load();
      } catch (_error) {}
    }
    if (video.readyState >= 2) {
      tile.classList.add("preview-frame-ready");
      tile.classList.remove("preview-warming");
    }
    video.play().catch(() => {
      video.muted = true;
      video.setAttribute("muted", "");
      video.play().catch(() => {});
    });
    trimVideoGalleryHoverPreviews(root, 8);
  }

  function stopVideoGalleryHoverPreview(tile) {
    const video = tile?.querySelector?.("video.gallery-video-hover-preview");
    tile?.classList.remove("preview-warming", "preview-frame-ready", "preview-playing");
    if (!video) return;
    try {
      video.pause();
      video.currentTime = 0;
    } catch (_error) {}
    video.muted = true;
    video.setAttribute("muted", "");
  }

  function trimVideoGalleryHoverPreviews(root, maxHydrated = 8) {
    const videos = [...root.querySelectorAll("video.gallery-video-hover-preview[src]")]
      .filter((video) => video.src)
      .sort((a, b) => Number(a.dataset.previewHydratedAt || 0) - Number(b.dataset.previewHydratedAt || 0));
    if (videos.length <= maxHydrated) return;
    for (const video of videos.slice(0, videos.length - maxHydrated)) {
      const parent = video.closest(".gallery-video-item");
      if (parent?.matches(":hover")) continue;
      try {
        video.pause();
        video.removeAttribute("src");
        video.preload = "none";
        video.load();
      } catch (_error) {}
      parent?.classList.remove("preview-frame-ready", "preview-warming");
    }
  }

  function hydrateGalleryPreviewImages(root) {
    const images = [...root.querySelectorAll("img[src*='media.getMediaUrlRedirect']")]
      .filter((img) => isFlowRedirectPreviewUrl(img.getAttribute("src") || ""));
    if (!images.length) return;
    for (const img of images) {
      const url = img.getAttribute("src") || "";
      const normalized = /mediaUrlType=MEDIA_URL_TYPE_THUMBNAIL/.test(url)
        ? normalizeMediaThumbnailUrl(url)
        : normalizeMediaRedirectUrl(url);
      if (normalized && normalized !== url) img.src = normalized;
    }
  }

  function hydrateVisibleGalleryImages(root) {
    const images = [...root.querySelectorAll(".gallery-image-item img, .gallery-table-thumb img")]
      .filter((img) => !img.dataset.galleryImageHydrated)
      .filter((img) => isElementNearViewport(img))
      .slice(0, 36);
    images.forEach((img, index) => {
      img.dataset.galleryImageHydrated = "1";
      setTimeout(() => {
        const url = img.getAttribute("src") || "";
        const normalized = isFlowRedirectPreviewUrl(url)
          ? (/mediaUrlType=MEDIA_URL_TYPE_THUMBNAIL/.test(url) ? normalizeMediaThumbnailUrl(url) : normalizeMediaRedirectUrl(url))
          : url;
        if (normalized && normalized !== url) img.setAttribute("src", normalized);
        img.setAttribute("loading", "eager");
        img.setAttribute("decoding", "async");
        img.setAttribute("fetchpriority", "low");
      }, index * 20);
    });
  }

  async function openGalleryItemPreview(itemId) {
    const item = activeGalleryItems().find((entry) => entry.id === itemId)
      || (state().gallery.items || []).find((entry) => entry.id === itemId);
    const url = galleryPlayablePreviewUrl(item);
    if (!url) {
      appendLog("warn", "gallery", "No preview URL for that gallery item.");
      await persistState();
      return;
    }
    const previewItems = activePreviewItems();
    const index = previewItems.findIndex((entry) => entry.id === itemId);
    try {
      openMediaPreview({
        items: previewItems.length ? previewItems : [{ id: itemId, url, kind: item?.kind || "images", title: galleryPreviewTitle(item) }],
        index,
        url,
        kind: item.kind || "images",
        title: galleryPreviewTitle(item)
      });
      appendLog("info", "gallery", "Opened gallery preview.");
    } catch (error) {
      appendLog("warn", "gallery", `Could not open preview: ${error.message}`);
    }
    await persistState();
  }

  function activePreviewItems() {
    return activeGalleryItems()
      .map((item) => ({
        id: item.id,
        url: galleryPlayablePreviewUrl(item),
        kind: item.kind || "images",
        title: galleryPreviewTitle(item)
      }))
      .filter((item) => item.url);
  }

  function galleryPlayablePreviewUrl(item = {}) {
    const kind = String(item?.kind || "");
    const mediaUrl = String(item?.mediaUrl || "").trim();
    const thumbnailUrl = String(item?.thumbnailUrl || "").trim();
    const mediaId = String(item?.mediaId || "").trim();
    if (kind.includes("video")) {
      if (mediaUrl && !/mediaUrlType=MEDIA_URL_TYPE_THUMBNAIL/i.test(mediaUrl)) return mediaUrl;
      return mediaId ? buildMediaRedirectUrl({ mediaId }) : "";
    }
    return mediaUrl || thumbnailUrl || (mediaId ? buildMediaRedirectUrl({ mediaId }) : "");
  }

  function galleryPreviewTitle(item = {}) {
    const full = galleryPromptLabel(item)
      || cleanGalleryPromptText(item?.title || "")
      || cleanGalleryPromptText(item?.fileName || "")
      || "Gallery preview";
    return galleryPromptPreview(full, 14);
  }

  function liveQueuePreviewItems() {
    return [...document.querySelectorAll(".live-output-slot[data-live-preview-url]")]
      .map((button, index) => ({
        id: `${button.dataset.livePreviewUrl || ""}:${index}`,
        url: button.dataset.livePreviewUrl || "",
        kind: button.dataset.livePreviewKind || "images",
        title: button.dataset.livePreviewTitle || `Output ${index + 1}`
      }))
      .filter((item) => item.url);
  }

  function openMediaPreview({ items = [], index = 0, url, kind = "images", title = "Preview" } = {}) {
    const previewItems = Array.isArray(items) && items.length
      ? items
      : [{ url, kind, title }].filter((item) => item.url);
    if (!previewItems.length) return;
    let activeIndex = Number.isFinite(Number(index)) ? Number(index) : -1;
    if (url && activeIndex < 0) activeIndex = previewItems.findIndex((item) => item.url === url);
    activeIndex = Math.max(0, Math.min(previewItems.length - 1, activeIndex));
    document.getElementById("galleryPreviewModal")?.remove();
    document.body.classList.add("preview-open");
    const mediaWrap = node("div", { class: "gallery-preview-media-wrap" });
    const caption = node("div", { class: "gallery-preview-caption" });
    const position = node("span", { class: "gallery-preview-position" });
    const renderPreview = () => {
      const item = previewItems[activeIndex] || previewItems[0];
      const isVideo = String(item.kind || "").includes("video");
      const media = isVideo
        ? node("video", { class: "gallery-preview-media", attrs: { src: item.url, controls: true, preload: "auto", playsinline: true } })
        : node("img", { class: "gallery-preview-media", attrs: { src: item.url, alt: item.title || "Preview", decoding: "async" } });
      mediaWrap.replaceChildren(isVideo
        ? applyPreviewVideoPlaybackSettings(media)
        : media
      );
      caption.textContent = item.title || "Preview";
      position.textContent = `${activeIndex + 1} / ${previewItems.length}`;
    };
    const move = (delta) => {
      activeIndex = (activeIndex + delta + previewItems.length) % previewItems.length;
      renderPreview();
    };
    const modal = node("div", { id: "galleryPreviewModal", class: "gallery-preview", attrs: { role: "dialog", "aria-modal": "true" } },
      node("div", { class: "gallery-preview-frame" },
        node("button", { class: "gallery-preview-close", attrs: { type: "button", title: "Close" } }, iconEl("close")),
        node("button", { class: "gallery-preview-nav gallery-preview-prev", attrs: { type: "button", title: "Previous", disabled: previewItems.length > 1 ? null : "disabled" } }, iconEl("chevron_left")),
        node("button", { class: "gallery-preview-nav gallery-preview-next", attrs: { type: "button", title: "Next", disabled: previewItems.length > 1 ? null : "disabled" } }, iconEl("chevron_right")),
        mediaWrap,
        node("div", { class: "gallery-preview-controls" },
          node("button", { class: "gallery-preview-step", attrs: { type: "button", disabled: previewItems.length > 1 ? null : "disabled" } }, iconEl("arrow_back"), node("span", { text: "Prev" })),
          position,
          node("button", { class: "gallery-preview-step", attrs: { type: "button", disabled: previewItems.length > 1 ? null : "disabled" } }, node("span", { text: "Next" }), iconEl("arrow_forward"))
        ),
        caption
      )
    );
    const close = () => {
      modal.remove();
      document.body.classList.remove("preview-open");
      window.removeEventListener("keydown", onKey);
    };
    renderPreview();
    modal.querySelector(".gallery-preview-close")?.addEventListener("click", close);
    modal.querySelector(".gallery-preview-prev")?.addEventListener("click", () => move(-1));
    modal.querySelector(".gallery-preview-next")?.addEventListener("click", () => move(1));
    modal.querySelector(".gallery-preview-step:first-child")?.addEventListener("click", () => move(-1));
    modal.querySelector(".gallery-preview-step:last-child")?.addEventListener("click", () => move(1));
    modal.addEventListener("click", (event) => {
      if (event.target === modal) close();
    });
    const onKey = (event) => {
      if (event.key === "Escape") close();
      if (event.key === "ArrowLeft") move(-1);
      if (event.key === "ArrowRight") move(1);
    };
    window.addEventListener("keydown", onKey);
    document.body.appendChild(modal);
  }

  function applyPreviewVideoPlaybackSettings(video) {
    if (!video) return video;
    const speed = Math.max(0.25, Math.min(6, Number.parseFloat(state().ui.videoSpeed || "1") || 1));
    const volume = Math.max(0, Math.min(1, Number.parseFloat(state().ui.videoVolume || "0.05") || 0.05));
    video.playbackRate = speed;
    video.defaultPlaybackRate = speed;
    video.volume = volume;
    video.muted = volume === 0;
    if (volume === 0) video.setAttribute("muted", "");
    else video.removeAttribute("muted");
    video.addEventListener("loadedmetadata", () => {
      video.playbackRate = speed;
      video.defaultPlaybackRate = speed;
      video.volume = volume;
      video.muted = volume === 0;
    }, { once: true });
    return video;
  }

  function applyVideoPlaybackSettings(root = document) {
    const speed = Math.max(0.25, Math.min(6, Number.parseFloat(state().ui.videoSpeed || "1") || 1));
    const volume = Math.max(0, Math.min(1, Number.parseFloat(state().ui.videoVolume || "0.05") || 0.05));
    root.querySelectorAll("video").forEach((video) => {
      video.playbackRate = speed;
      video.volume = volume;
      video.muted = volume === 0;
    });
  }

  function activeGalleryItems() {
    const current = state();
    const tab = activeGalleryTabForActions();
    const liveItems = buildGalleryItemsFromTasks(current.queue.items || []);
    const projectId = String(current.runtime?.projectId || "").trim();
    const referenceMediaIds = knownReferenceMediaIds(current);
    const projectItems = filterGalleryItemsForProject([
      ...(current.gallery.items || []),
      ...liveItems
    ], projectId);
    return canonicalGalleryItems(projectItems, { projectId, referenceMediaIds })
      .filter((item) => !(current.gallery.deletedIds || []).includes(item.id))
      .filter((item) => (item.kind || "images") === tab);
  }

  function knownReferenceMediaIds(current = state()) {
    const referenceItems = [
      ...(current.control?.transientReferenceItems || []),
      ...(current.referenceLibrary?.savedItems || [])
    ];
    return [...new Set([
      ...referenceMediaIdsFromTasks(current.queue?.items || []),
      ...referenceItems.flatMap((item) => [item?.mediaId, item?.assetImageId])
    ].map((id) => String(id || "").trim()).filter(Boolean))];
  }

  function activeGalleryTabForActions() {
    const current = state();
    if (current.ui.galleryViewMode === "live") {
      const queueItems = current.queue.items || [];
      const openItems = queueItems.filter((item) => !["complete", "done", "failed", "blocked"].includes(String(item.status || "")));
      const scopedItems = openItems.length ? openItems : queueItems;
      if (scopedItems.some((item) => item.mode !== FLOW_MODES.textToImage || String(item.kind || "").includes("video"))) return "videos";
      if (scopedItems.some((item) => item.mode === FLOW_MODES.textToImage || String(item.kind || "").includes("image"))) return "images";
    }
    return current.ui.galleryTab === "videos" ? "videos" : "images";
  }

  function selectedActiveGalleryItems() {
    const selected = new Set(state().ui.selectedGalleryIds || []);
    return activeGalleryItems().filter((item) => selected.has(item.id));
  }

  function updateGallerySelectionSurface(root = document) {
    const selected = new Set(state().ui.selectedGalleryIds || []);
    const activeItems = activeGalleryItems();
    const activeIds = new Set(activeItems.map((item) => item.id));
    const activeSelectedCount = activeItems.filter((item) => selected.has(item.id)).length;
    root.querySelectorAll("[data-gallery-id]").forEach((button) => {
      button.classList.toggle("selected", selected.has(button.dataset.galleryId));
    });
    const countText = `(${activeSelectedCount})`;
    const downloadCount = root.querySelector("#gallery-download-count");
    if (downloadCount) downloadCount.textContent = countText;
    const downloadButton = root.querySelector("#gallery-download-btn");
    if (downloadButton) downloadButton.disabled = activeSelectedCount === 0;
    const animateButton = root.querySelector("#gallery-animate-images-btn");
    if (animateButton) animateButton.disabled = activeItems.filter((item) => (item.kind || "images") === "images").length === 0;
    root.querySelectorAll("#gallery-send-scenes-btn, #gallery-send-scenes-top-btn").forEach((sceneButton) => {
      sceneButton.disabled = activeSelectedCount === 0;
      const count = sceneButton.querySelector("[data-scenes-count]");
      if (count) count.textContent = `(${activeSelectedCount})`;
    });
    const deselectButton = root.querySelector("#gallery-deselect-all-btn");
    if (deselectButton) deselectButton.disabled = activeSelectedCount === 0;
    const selectButton = root.querySelector("#gallery-select-all-btn");
    if (selectButton) selectButton.disabled = activeIds.size === 0;
  }

  function randomPickActiveGalleryItems({ matchedOnly = false } = {}) {
    const items = activeGalleryItems();
    const groups = new Map();
    for (const item of items) {
      if (matchedOnly && !String(item.prompt || item.title || "").trim()) continue;
      const key = String(item.prompt || item.title || item.taskId || "media").slice(0, 120);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const picked = [];
    for (const groupItems of groups.values()) {
      if (!groupItems.length) continue;
      picked.push(groupItems[Math.floor(Math.random() * groupItems.length)].id);
    }
    const activeIds = new Set(items.map((item) => item.id));
    state().ui.selectedGalleryIds = [
      ...(state().ui.selectedGalleryIds || []).filter((id) => !activeIds.has(id)),
      ...picked
    ];
    appendLog("info", "gallery", `Random picked ${picked.length} ${activeGalleryTabForActions()}.`);
  }

  function pickMatchedGalleryItems() {
    const items = activeGalleryItems();
    const { map: videoPromptMap, isAutoFlowFormat } = extractVideoPromptMapFromControl();
    const hasStoredVideoPrompts = items.some((item) => String(item.videoPrompt || "").trim());
    if (!isAutoFlowFormat && !hasStoredVideoPrompts) {
      appendLog("warn", "gallery", "Pick Matched needs Auto Flow format: [tag] image prompt ||| [tag] video prompt.");
      const activeIds = new Set(items.map((item) => item.id));
      state().ui.selectedGalleryIds = (state().ui.selectedGalleryIds || [])
        .filter((id) => !activeIds.has(id));
      return;
    }
    const pickedByGroup = new Map();
    for (const item of items) {
      const tag = itemSceneTag(item);
      const mappedPrompt = String(item.videoPrompt || "").trim() || (tag ? videoPromptMap.get(tag) : "");
      const hasMatch = Boolean(mappedPrompt);
      if (!hasMatch) continue;
      item.videoPrompt = mappedPrompt;
      const groupKey = tag || String(item.prompt || item.title || item.taskId || item.id || "media").slice(0, 120);
      if (!pickedByGroup.has(groupKey)) pickedByGroup.set(groupKey, item.id);
    }
    const picked = [...pickedByGroup.values()];
    const activeIds = new Set(items.map((item) => item.id));
    state().ui.selectedGalleryIds = [
      ...(state().ui.selectedGalleryIds || []).filter((id) => !activeIds.has(id)),
      ...picked
    ];
    appendLog(picked.length ? "info" : "warn", "gallery", picked.length
      ? `Picked ${picked.length} matched image${picked.length === 1 ? "" : "s"}.`
      : "No matched image/video prompt pairs found. Use Animate Images to paste prompts manually.");
  }

  function extractVideoPromptMapFromControl() {
    const map = new Map();
    let isAutoFlowFormat = false;
    for (const text of autoFlowPromptDocumentsForMatching()) {
      const parsed = parseAutoFlowPromptDocument(text);
      if (!parsed.isAutoFlowFormat) continue;
      isAutoFlowFormat = true;
      for (const entry of parsed.entries) {
        if (map.has(entry.tag)) continue;
        const prompt = promptForImageFromAutoFlowEntry(entry, {});
        if (entry.tag && prompt) map.set(entry.tag, prompt);
      }
    }
    return { map, isAutoFlowFormat };
  }

  function autoFlowPromptDocumentsForMatching() {
    const documents = [
      state().control.livePrompt,
      ...(state().history?.runs || []).map((run) => run?.control?.livePrompt || run?.promptsText || "")
    ];
    const seen = new Set();
    return documents
      .map((text) => String(text || "").trim())
      .filter((text) => {
        if (!text || seen.has(text)) return false;
        seen.add(text);
        return true;
      });
  }

  function itemSceneTag(item = {}) {
    const explicit = String(item.sceneTag || "").trim();
    if (explicit) return explicit.toLowerCase();
    return sceneTag(`${item.prompt || ""} ${item.title || ""} ${item.fileName || ""} ${item.sourcePrompt || ""}`);
  }

  async function syncGallery(options = {}) {
    // Toggle the spinning .scanning class on the Scan All button so users see
    // visual feedback while the request is in flight. Cleared in finally below.
    const scanButton = document.querySelector("#gallery-sync-btn");
    if (scanButton && !options.auto) scanButton.classList.add("scanning");
    try {
      const response = await send(MessageType.GalleryRefresh, {
        auto: Boolean(options.auto),
        lightweight: Boolean(options.auto),
        fullScroll: options.fullScroll
      });
      const payload = response?.payload || {};
      const incomingCount = Number(payload?.gallery?.items?.length || 0);
      const priorCount = Number((state().gallery.items || []).length);
      applyRuntimePayload(payload, { render: false, preserveGalleryOnEmpty: true });
      const preserved = Boolean(state().gallery.meta?.preservedExistingItems);
      appendLog("info", "gallery", preserved
        ? `${options.auto ? "Auto-scan" : "Scan"} found 0 new output(s); kept ${priorCount} existing gallery item${priorCount === 1 ? "" : "s"}.`
        : `${options.auto ? "Auto-synced" : "Synced"} ${incomingCount} output(s) from ${payload?.gallery?.meta?.source || "gallery"}.`);
      if (preserved) {
        await persistState();
        return;
      }
    } catch (error) {
      appendLog("warn", "gallery", `Gallery sync failed: ${error.message}`);
    } finally {
      if (scanButton) scanButton.classList.remove("scanning");
    }
    await persistState();
    await hydrateStateFromStorage();
    render({ autoSyncGallery: false });
  }

  async function downloadSelectedGalleryItems() {
    const selectedIds = selectedActiveGalleryItems().map((item) => item.id);
    if (!selectedIds.length) return;
    try {
      const response = await send(MessageType.MediaDownload, {
        selectedIds,
        projectId: String(state().runtime?.projectId || ""),
        folder: state().control.presets.downloadFolder,
        imageResolution: state().control.presets.imageAutoDownloadResolution,
        videoResolution: state().control.presets.videoDownloadResolution,
        filenameStyle: state().control.presets.filenameStyle,
        filenameTemplatePrefix: state().control.presets.filenameTemplatePrefix,
        filenameTemplateIndex: state().control.presets.filenameTemplateIndex,
        filenameTemplatePromptPart: state().control.presets.filenameTemplatePromptPart,
        filenameTemplateDate: state().control.presets.filenameTemplateDate,
        filenameTemplateSuffix: state().control.presets.filenameTemplateSuffix,
        filenameTemplateSeparator: state().control.presets.filenameTemplateSeparator
      });
      applyRuntimePayload(response?.payload || {});
      const downloads = response?.payload?.downloads || [];
      const skipped = downloads.filter((download) => download.skipped);
      const failed = downloads.filter((download) => !download.ok && !download.skipped);
      const completed = downloads.filter((download) => download.ok).length;
      appendLog(
        failed.length ? "warn" : "info",
        "download",
        failed.length
          ? `Downloaded ${completed}/${downloads.length}; ${failed.length} failed; ${skipped.length} duplicate skipped.`
          : `Queued ${completed} download${completed === 1 ? "" : "s"}${skipped.length ? `; ${skipped.length} duplicate skipped` : ""}.`
      );
    } catch (error) {
      appendLog("error", "download", error.message);
    }
    await persistState();
    render();
  }

  async function importGalleryImageFiles(files = []) {
    const images = files.filter((file) => /^image\//i.test(String(file.type || "")));
    if (!images.length) {
      appendLog("warn", "gallery", "Choose one or more image files to import.");
      await persistState();
      render();
      return;
    }
    const imported = [];
    for (const [index, file] of images.entries()) {
      const dataUrl = await readFileDataUrl(file);
      const id = `local:${crypto.randomUUID()}`;
      const title = file.name || `Imported image ${index + 1}`;
      imported.push({
        id,
        taskId: "",
        jobId: "local-import",
        jobIndex: (state().gallery.items || []).length + index,
        taskNumber: (state().gallery.items || []).length + index + 1,
        mediaId: "",
        kind: "images",
        prompt: title,
        title,
        fileName: title,
        mimeType: file.type || "image/png",
        source: "local-import",
        mediaIndex: 0,
        mediaUrl: dataUrl,
        thumbnailUrl: dataUrl,
        imageUrl: dataUrl,
        dataUrl,
        createdAt: new Date().toISOString()
      });
    }
    state().gallery.items = [...imported, ...(state().gallery.items || [])];
    state().gallery.meta = {
      ...(state().gallery.meta || {}),
      source: "local-import+queue-ledger",
      fetchedAt: new Date().toISOString()
    };
    state().ui.selectedGalleryIds = [...new Set([...(state().ui.selectedGalleryIds || []), ...imported.map((item) => item.id)])];
    appendLog("info", "gallery", `Imported ${imported.length} image${imported.length === 1 ? "" : "s"} into Gallery.`);
    await persistState();
    render();
  }

  async function openAnimateImagesModal() {
    const allSelected = selectedActiveGalleryItems();
    const selectedImages = allSelected.filter((item) => (item.kind || "images") === "images");
    appendLog("info", "gallery",
      `Animate Images clicked: ${allSelected.length} selected, ${selectedImages.length} are images.`);
    if (!selectedImages.length) {
      appendLog("warn", "gallery",
        allSelected.length
          ? "Animate Images: selected items are not images (kind != images). Switch to the Images tab and select image outputs."
          : "Animate Images: no items selected. Select image outputs first.");
      await openAnimateImagesSelectionNotice();
      return;
    }

    // Legacy parity: auto-pair video prompts from any pasted Auto Flow document
    // ([V1-S1] image ||| [V1-S1] video). If every selected image already has a
    // matching video prompt, skip the modal and queue directly — that's how
    // the old version "just worked" when the user pasted a complete batch.
    const { map: videoPromptMap, isAutoFlowFormat } = extractVideoPromptMapFromControl();
    if (isAutoFlowFormat) {
      for (const item of selectedImages) {
        const tag = itemSceneTag(item);
        const mappedPrompt = String(item.videoPrompt || "").trim() || (tag ? videoPromptMap.get(tag) : "");
        if (mappedPrompt) item.videoPrompt = mappedPrompt;
      }
    }
    const allPaired = selectedImages.every((item) => Boolean(String(item.videoPrompt || "").trim()));
    appendLog("info", "gallery",
      `Animate Images: autoFlowFormat=${isAutoFlowFormat}, paired=${selectedImages.filter((it) => it.videoPrompt).length}/${selectedImages.length}, fastPath=${allPaired}.`);
    if (allPaired) {
      const promptText = selectedImages.map((item) => String(item.videoPrompt || "").trim()).join("\n");
      try {
        await enqueueSelectedImagesForVideo({
          selectedImages,
          promptMode: "ordered",
          promptText
        });
        appendLog("info", "gallery", `Animate Images: auto-paired ${selectedImages.length} prompt${selectedImages.length === 1 ? "" : "s"} from your Auto Flow batch and queued the videos.`);
        return;
      } catch (error) {
        appendLog("warn", "gallery", `Animate Images auto-pair failed (${error.message || "unknown"}). Opening manual prompt modal.`);
      }
    }

    // Fall back to the 1:1 legacy modal — four-mode prompt entry (document /
    // ordered / shared / individual), help tooltip, "Queue matched only"
    // button, and Import Prompts file picker.
    const fallbackProjectId = String(state().runtime?.projectId || "").trim();
    const legacyItems = selectedImages.map((item, index) => legacyItemFromGalleryItem(item, index, fallbackProjectId));
    const results = await showManualVideoPromptModal(legacyItems, { appendLog });
    if (!results || !results.length) {
      appendLog("info", "gallery", "Animate Images: prompt entry cancelled.");
      return;
    }
    // Modal results may be a subset (Queue matched only). Pull the original
    // gallery items they reference and join their resolved prompts in
    // matching order so enqueueSelectedImagesForVideo's ordered mode aligns.
    const orderedGalleryItems = results
      .map((entry) => entry?.galleryItem || selectedImages.find((img) => String(img.id || "") === String(entry?.galleryAssetId || "")))
      .filter(Boolean);
    const orderedPrompts = results.map((entry) => String(entry?.videoPrompt || "").trim());
    if (!orderedGalleryItems.length) {
      appendLog("warn", "gallery", "Animate Images: prompt entry returned no usable images.");
      return;
    }
    try {
      await enqueueSelectedImagesForVideo({
        selectedImages: orderedGalleryItems,
        promptMode: "ordered",
        promptText: orderedPrompts.join("\n")
      });
      appendLog("info", "gallery", `Animate Images: queued ${orderedGalleryItems.length} image-to-video task${orderedGalleryItems.length === 1 ? "" : "s"} from manual prompt modal.`);
    } catch (error) {
      appendLog("error", "gallery", `Animate Images: queue add failed: ${error?.message || error || "unknown"}.`);
    }
  }

  async function openAnimateImagesSelectionNotice() {
    const availableImages = activeGalleryItems().filter((item) => (item.kind || "images") === "images");
    appendLog("warn", "gallery", "Select image outputs before using Animate Images.");
    document.getElementById("animateImagesModal")?.remove();
    const modal = node("div", { id: "animateImagesModal", class: "animate-modal-backdrop", attrs: { role: "dialog", "aria-modal": "true" } },
      node("section", { class: "animate-modal animate-modal-compact" },
        node("div", { class: "animate-modal-head" },
          node("span", { class: "animate-modal-icon" }, iconEl("video_library")),
          node("span", null,
            node("h2", { text: "Select images to animate" }),
            node("p", { text: availableImages.length ? "Choose one or more image outputs, then Animate Images will map video prompts to them." : "No image outputs are available in the current Gallery tab." })
          ),
          node("button", { id: "animateModalClose", class: "gallery-preview-close", attrs: { type: "button", title: "Close" } }, iconEl("close"))
        ),
        node("div", { class: "animate-prompt-status", text: "Auto Flow format is supported in either order: image prompt ||| video prompt, or video prompt ||| image prompt." }),
        node("div", { class: "animate-modal-actions" },
          node("button", { id: "animateCancel", attrs: { type: "button" } }, node("span", { text: "Cancel" })),
          availableImages.length ? node("button", { id: "animateSelectAll", class: "button-primary", attrs: { type: "button" } }, iconEl("select_all"), node("span", { text: `Select all ${availableImages.length}` })) : null
        )
      )
    );
    const close = () => modal.remove();
    modal.querySelector("#animateModalClose")?.addEventListener("click", close);
    modal.querySelector("#animateCancel")?.addEventListener("click", close);
    modal.querySelector("#animateSelectAll")?.addEventListener("click", async () => {
      state().ui.selectedGalleryIds = [...new Set([
        ...(state().ui.selectedGalleryIds || []),
        ...availableImages.map((item) => item.id)
      ])];
      await persistState({ suppressStorageRender: true });
      close();
      updateGallerySelectionSurface();
      await openAnimateImagesModal();
    });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) close();
    });
    document.body.appendChild(modal);
    await persistState();
  }

  function animatePromptStatus(mode, text, selectedImages = []) {
    const assignments = buildAnimatePromptAssignments(selectedImages, mode, text);
    const matched = assignments.filter((entry) => entry.prompt).length;
    if (mode === "document") return `Matched ${matched}/${selectedImages.length} by scene tags from ||| document format.`;
    if (mode === "shared") return text.trim() ? `One prompt will be used for ${selectedImages.length} image(s).` : "Enter one shared video prompt.";
    return `Detected ${matched}/${selectedImages.length} ordered prompt line(s).`;
  }

  async function enqueueSelectedImagesForVideo({ selectedImages, promptMode = "ordered", promptText = "" } = {}) {
    // Gallery -> Wizard handoff. Instead of queuing tasks directly, stage the
    // control wizard at step 3 (Run) with everything pre-filled: mode set to
    // Frame-to-Video, prompts populated in livePrompt (one per line), the
    // selected gallery images dropped into transientReferenceItems, and the
    // I2V batch ref-id list pointing at those new refs. The user confirms
    // and hits Run on the wizard. Same handoff happens regardless of which
    // mode the user was in before.
    selectedImages = selectedImages || selectedActiveGalleryItems().filter((item) => (item.kind || "images") === "images");
    if (!selectedImages.length) throw new Error("Select image outputs before using Animate Images.");
    const assignments = buildAnimatePromptAssignments(selectedImages, promptMode, promptText);
    const missing = assignments.filter((entry) => !String(entry.prompt || "").trim());
    if (missing.length) {
      throw new Error(`Add video prompts for ${missing.length} selected image${missing.length === 1 ? "" : "s"} before queueing.`);
    }

    // Build new transient reference items, one per selected image. Re-use
    // the gallery item's id so duplicate clicks don't multiply refs (the
    // wizard's allReferenceItems() de-dupes by id).
    const nowIso = new Date().toISOString();
    const newRefs = selectedImages.map((item, index) => ({
      id: String(item.id || item.mediaId || `gallery-ref-${nowIso}-${index}`),
      blobStoreId: "",
      title: String(item.title || item.prompt || `Gallery image ${index + 1}`),
      fileName: String(item.fileName || item.title || `gallery-${index + 1}.jpg`),
      mimeType: String(item.mimeType || "image/jpeg"),
      size: Number(item.size || 0),
      imageUrl: String(item.thumbnailUrl || item.imageUrl || item.mediaUrl || item.dataUrl || ""),
      dataUrl: String(item.dataUrl || ""),
      mediaUrl: String(item.mediaUrl || item.imageUrl || ""),
      mediaId: String(item.mediaId || "").trim(),
      createdAt: nowIso,
      temporary: true,
      sourceTaskId: String(item.taskId || "")
    }));
    const refIds = newRefs.map((r) => r.id);

    const cur = state();
    const existingTransient = Array.isArray(cur.control?.transientReferenceItems) ? cur.control.transientReferenceItems : [];
    const existingIds = new Set(existingTransient.map((r) => String(r?.id || "")));
    const mergedTransient = [
      ...newRefs.filter((r) => !existingIds.has(r.id)),
      ...existingTransient
    ].slice(0, 100);

    const orderedPromptText = assignments.map(({ prompt }) => String(prompt || "").trim()).join("\n");

    cur.control = {
      ...(cur.control || {}),
      mode: FLOW_MODES.imageToVideo,
      livePrompt: orderedPromptText,
      wizardStep: 3,
      transientReferenceItems: mergedTransient,
      oneToOneBatchRefIds: refIds,
      references: {
        ...(cur.control?.references || {}),
        startFrameRef: refIds.join(" "),
        endFrameRef: ""
      }
    };
    cur.ui = { ...(cur.ui || {}), activeRoute: "control" };

    appendLog("info", "gallery", `Animate Images: staged ${refIds.length} image${refIds.length === 1 ? "" : "s"} on the Run step. Review and click Run.`);
    await persistState();
    render();
  }

  async function sendSelectedVideosToScenes() {
    const selected = selectedActiveGalleryItems().filter((item) => (item.kind || "images") === "videos");
    if (!selected.length) return;

    const result = mergeSceneGalleryItems(state().scenes.clips || [], selected, {
      projectId: String(state().runtime?.projectId || "")
    });
    if (!result.added.length) {
      appendLog("info", "scenes", "Selected videos are already in Scene Builder.");
      await persistState();
      render();
      return;
    }
    state().scenes.clips = result.clips;
    state().scenes.totalDuration = result.totalDuration;
    state().scenes.updatedAt = new Date().toISOString();
    state().ui.activeRoute = "scenes";
    appendLog("info", "scenes", `Scene Builder: added ${result.added.length} video${result.added.length === 1 ? "" : "s"}.`);
    await persistState();
    render();
  }

  return {
    bindAfterGallery,
    syncGallery,
    activeGalleryItems,
    selectedActiveGalleryItems
  };
}
