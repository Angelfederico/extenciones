import { translate } from "./i18n.js";

const OVERLAY_ID = "ref-overlay";
const CLOSE_ID = "ref-close";
const ROLE_LABELS = {
  imagePromptRefs: "Image Reference",
  styleRefRefs: "Style Reference",
  omniRefRefs: "Character Reference",
  startFrameRef: "Start Frame",
  endFrameRef: "End Frame",
  ingredientsRefs: "Ingredients"
};

const ROLE_I18N_KEYS = {
  imagePromptRefs: "imageReference",
  styleRefRefs: "styleReference",
  omniRefRefs: "characterReference",
  startFrameRef: "startFrame",
  endFrameRef: "endFrame",
  ingredientsRefs: "ingredientsRefs",
};

export function openRefPanel(targetRole = "", locale = "en") {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  overlay.dataset.targetRole = targetRole;
  const title = overlay.querySelector(".ref-overlay-header strong");
  if (title) {
    const roleKey = ROLE_I18N_KEYS[targetRole];
    title.textContent = targetRole && roleKey
      ? translate("chooseReferenceImage", {}, locale).replace("Reference Image", translate(roleKey, {}, locale))
      : translate("chooseReferenceImage", {}, locale);
  }
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
}

export function closeRefPanel() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  overlay.hidden = true;
  document.body.style.overflow = "";
}

export function bindRefPanel(controlRoot, options = {}) {
  const locale = options.state?.control?.presets?.language || "en";
  renderRefLibrary(options.state, options.onAssign, "", options.onSave, locale);

  controlRoot.querySelectorAll("[data-ref-role]").forEach((button) => {
    button.addEventListener("click", () => {
      const role = button.dataset.refRole || "";
      const currentLocale = options.state?.control?.presets?.language || "en";
      renderRefLibrary(options.state, options.onAssign, role, options.onSave, currentLocale);
      openRefPanel(role, currentLocale);
    });
  });

  const close = document.getElementById(CLOSE_ID);
  if (close && !close.dataset.bound) {
    close.addEventListener("click", closeRefPanel);
    close.dataset.bound = "1";
  }

  const importButton = document.getElementById("ref-import-btn");
  const importInput = document.getElementById("ref-import-input");
  if (importButton && importInput && !importButton.dataset.bound) {
    importButton.addEventListener("click", () => importInput.click());
    importButton.dataset.bound = "1";
  }
  if (importInput && !importInput.dataset.bound) {
    importInput.addEventListener("change", async () => {
      await options.onImport?.(importInput.files);
      importInput.value = "";
      const currentLocale = options.state?.control?.presets?.language || "en";
      renderRefLibrary(options.state, options.onAssign, "", options.onSave, currentLocale);
    });
    importInput.dataset.bound = "1";
  }
}

function renderRefLibrary(state, onAssign, targetRole = "", onSave, locale = "en") {
  const body = document.querySelector(".ref-overlay-body");
  if (!body) return;
  body.textContent = "";

  const saved = (state?.referenceLibrary?.savedItems || []).map((item) => ({
    ...item,
    sourceLabel: item.mediaId ? translate("flowMedia", {}, locale) : translate("savedLabel", {}, locale)
  }));
  if (!saved.length) {
    const empty = document.createElement("div");
    empty.className = "ref-overlay-empty";
    empty.textContent = translate("refOverlayEmpty", {}, locale);
    body.appendChild(empty);
    return;
  }

  const section = document.createElement("section");
  section.className = "ref-library-section";
  const heading = document.createElement("div");
  heading.className = "ref-library-section-title";
  heading.textContent = `${translate("savedReferences", {}, locale)} ${saved.length}`;
  section.appendChild(heading);

  const grid = document.createElement("div");
  grid.className = "ref-library-grid";
  for (const item of saved) {
    grid.appendChild(buildRefTile(item, onAssign, targetRole, locale));
  }
  section.appendChild(grid);
  body.appendChild(section);
}

function buildRefTile(item, onAssign, targetRole = "", locale = "en") {
  const tile = document.createElement("div");
  tile.className = "ref-library-tile";

  const img = document.createElement("img");
  img.src = item.imageUrl || item.dataUrl || item.mediaUrl;
  img.alt = item.title || translate("referenceImageAlt", {}, locale);
  img.loading = "lazy";
  tile.appendChild(img);

  const title = document.createElement("div");
  title.className = "ref-library-title";
  title.textContent = item.title || item.fileName || translate("referenceImageAlt", {}, locale);
  tile.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "ref-library-meta";
  meta.textContent = item.sourceLabel || translate("referenceLabel", {}, locale);
  tile.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "ref-library-actions";
  const actionMap = targetRole
    ? [[targetRole, translate("useImage", {}, locale)]]
    : Object.entries(ROLE_I18N_KEYS).map(([k, v]) => [k, translate(v, {}, locale)]);
  if (targetRole) actions.classList.add("single-action");
  for (const [role, label] of actionMap) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", async () => {
      await onAssign?.(role, item.id);
      closeRefPanel();
    });
    actions.appendChild(button);
  }
  tile.appendChild(actions);

  return tile;
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeRefPanel();
});
