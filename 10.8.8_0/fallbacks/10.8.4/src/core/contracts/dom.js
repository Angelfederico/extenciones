export const FlowDomArea = Object.freeze({
  shell: "shell",
  composer: "composer",
  upload: "upload",
  gallery: "gallery",
  refPanel: "refPanel",
  failureDialog: "failureDialog"
});

export const flowSelectors = Object.freeze({
  shell: {
    projectIdFromUrl: /\/project\/([0-9a-f-]{36})/i
  },
  composer: {},
  upload: {},
  gallery: {},
  refPanel: {},
  failureDialog: {}
});

export const DomSelectorStrategy = Object.freeze({
  css: "css",
  generatedClass: "generated-class",
  materialIconLigature: "material-icon-ligature",
  sidepanelId: "sidepanel-id",
  sidepanelDataRoute: "sidepanel-data-route"
});

const latestFlowSnapshot = "reference/captures/playwright/2026-04-27T05-51-35-316Z/1777270545942-1A43FB7DAD618CD4C7ACA557B6568D3B.json";
const latestSidepanelSnapshot = "reference/captures/playwright/2026-04-27T05-51-35-316Z/1777270190044-B716C455757656AEA3997A6614CAF183.json";

export const flowTextEvidence = Object.freeze({
  shell: {
    goBack: "Go Back",
    search: "Search",
    sortFilter: "Sort & Filter",
    addMedia: "Add Media",
    sceneBuilder: "Scenebuilder",
    viewSettings: "View Tile Grid Settings"
  },
  gallery: {
    viewImages: "View images",
    viewVideos: "View videos",
    viewArchive: "View Archive"
  },
  composer: {
    startFrame: "Start",
    endFrame: "End",
    create: "Create",
    clearPrompt: "Clear prompt"
  }
});

export const flowActionContracts = Object.freeze({
  shell: {
    addMedia: {
      action: "click",
      candidates: [
        {
          strategy: DomSelectorStrategy.generatedClass,
          selector: "button.sc-5a7bdc3e-1",
          expectedCount: 1,
          proof: latestFlowSnapshot,
          textEvidence: "add Add Media"
        }
      ]
    },
    viewSettings: {
      action: "click",
      candidates: [
        {
          strategy: DomSelectorStrategy.generatedClass,
          selector: "button.sc-507a0d81-6",
          expectedCount: 1,
          proof: latestFlowSnapshot,
          textEvidence: "settings_2 View Tile Grid Settings"
        }
      ]
    }
  },
  composer: {
    create: {
      action: "click",
      candidates: [
        {
          strategy: DomSelectorStrategy.generatedClass,
          selector: "button.sc-522e4d41-4",
          materialIcon: "arrow_forward",
          expectedCount: 1,
          proof: latestFlowSnapshot,
          textEvidence: "arrow_forward Create"
        },
        {
          strategy: DomSelectorStrategy.generatedClass,
          selector: "button.sc-2951028b-4",
          materialIcon: "arrow_forward",
          expectedCount: 1,
          proof: "reference/captures/playwright/2026-04-29T21-13-live-dom-create/flow-dom-create-button.json",
          textEvidence: "arrow_forward Create"
        }
      ]
    },
    clearPrompt: {
      action: "click",
      candidates: [
        {
          strategy: DomSelectorStrategy.generatedClass,
          selector: "button.sc-522e4d41-7",
          materialIcon: "close",
          expectedCount: 1,
          proof: latestFlowSnapshot,
          textEvidence: "close Clear prompt"
        }
      ]
    }
  },
  gallery: {
    viewImages: {
      action: "click",
      candidates: [
        {
          strategy: DomSelectorStrategy.materialIconLigature,
          selector: "button.sc-e503ddc8-0",
          materialIcon: "image",
          proof: latestFlowSnapshot,
          textEvidence: "image View images"
        }
      ]
    },
    viewVideos: {
      action: "click",
      candidates: [
        {
          strategy: DomSelectorStrategy.materialIconLigature,
          selector: "button.sc-e503ddc8-0",
          materialIcon: "videocam",
          proof: latestFlowSnapshot,
          textEvidence: "videocam View videos"
        }
      ]
    },
    viewArchive: {
      action: "click",
      candidates: [
        {
          strategy: DomSelectorStrategy.materialIconLigature,
          selector: "button.sc-e503ddc8-0",
          materialIcon: "archive",
          proof: latestFlowSnapshot,
          textEvidence: "archive View Archive"
        }
      ]
    }
  }
});

export const sidepanelSelectors = Object.freeze({
  header: {
    launcher: "#captureButton",
    settings: "#header-language-btn",
    help: "#help-button",
    login: "#login-button"
  },
  tabs: {
    tabButton: ".tab-button",
    activeTabButton: ".tab-button.active"
  },
  gallery: {
    runCollapse: "#galleryRunCollapseBtn",
    runDismiss: "#galleryRunDismissBtn"
  }
});

export const sidepanelActionContracts = Object.freeze({
  header: {
    launcher: {
      action: "click",
      candidates: [{ strategy: DomSelectorStrategy.sidepanelId, selector: "#captureButton", proof: latestSidepanelSnapshot }]
    },
    settings: {
      action: "click",
      candidates: [{ strategy: DomSelectorStrategy.sidepanelId, selector: "#header-language-btn", proof: latestSidepanelSnapshot }]
    },
    help: {
      action: "click",
      candidates: [{ strategy: DomSelectorStrategy.sidepanelId, selector: "#help-button", proof: latestSidepanelSnapshot }]
    },
    login: {
      action: "click",
      candidates: [{ strategy: DomSelectorStrategy.sidepanelId, selector: "#login-button", proof: latestSidepanelSnapshot }]
    }
  },
  tabs: {
    control: {
      action: "click",
      candidates: [{ strategy: DomSelectorStrategy.sidepanelDataRoute, selector: "[data-route='control']", proof: latestSidepanelSnapshot }]
    },
    gallery: {
      action: "click",
      candidates: [{ strategy: DomSelectorStrategy.sidepanelDataRoute, selector: "[data-route='gallery']", proof: latestSidepanelSnapshot }]
    },
    settings: {
      action: "click",
      candidates: [{ strategy: DomSelectorStrategy.sidepanelDataRoute, selector: "[data-route='settings']", proof: latestSidepanelSnapshot }]
    },
    logs: {
      action: "click",
      candidates: [{ strategy: DomSelectorStrategy.sidepanelDataRoute, selector: "[data-route='logs']", proof: latestSidepanelSnapshot }]
    },
    scenes: {
      action: "click",
      candidates: [{ strategy: DomSelectorStrategy.sidepanelDataRoute, selector: "[data-route='scenes']", proof: latestSidepanelSnapshot }]
    }
  },
  gallery: {
    runCollapse: {
      action: "click",
      candidates: [{ strategy: DomSelectorStrategy.sidepanelId, selector: "#galleryRunCollapseBtn", proof: latestSidepanelSnapshot }]
    },
    runDismiss: {
      action: "click",
      candidates: [{ strategy: DomSelectorStrategy.sidepanelId, selector: "#galleryRunDismissBtn", proof: latestSidepanelSnapshot }]
    }
  }
});

const forbiddenActionStrategies = new Set(["text", "role-text", "aria-label", "visible-text"]);
const forbiddenCandidateKeys = new Set(["text", "visibleText", "label", "ariaLabel", "name", "roleName", "hasText"]);

export function assertLocaleSafeDomActionContract(contract, path = "contract") {
  if (!contract || typeof contract !== "object") {
    throw new Error(`Invalid DOM action contract: ${path}`);
  }
  const candidates = Array.isArray(contract.candidates) ? contract.candidates : [];
  if (!candidates.length) throw new Error(`DOM action contract has no candidates: ${path}`);

  for (const [index, candidate] of candidates.entries()) {
    const candidatePath = `${path}.candidates[${index}]`;
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`Invalid DOM selector candidate: ${candidatePath}`);
    }
    if (forbiddenActionStrategies.has(candidate.strategy)) {
      throw new Error(`Locale-bound DOM selector strategy is forbidden: ${candidatePath}.${candidate.strategy}`);
    }
    for (const key of Object.keys(candidate)) {
      if (forbiddenCandidateKeys.has(key)) {
        throw new Error(`Locale-bound DOM selector key is forbidden: ${candidatePath}.${key}`);
      }
    }
    if (!candidate.selector) throw new Error(`DOM selector candidate missing selector: ${candidatePath}`);
    if (/:text\(|text=|has-text|aria-label/i.test(String(candidate.selector))) {
      throw new Error(`Locale-bound DOM selector expression is forbidden: ${candidatePath}`);
    }
    if (!candidate.proof) throw new Error(`DOM selector candidate missing proof: ${candidatePath}`);
  }
  return contract;
}

export function requireDomActionContract(surface, area, name) {
  const root = surface === "sidepanel" ? sidepanelActionContracts : flowActionContracts;
  const contract = root?.[area]?.[name];
  if (!contract) {
    throw new Error(`Missing ${surface || "flow"} DOM action contract: ${area}.${name}`);
  }
  return assertLocaleSafeDomActionContract(contract, `${surface || "flow"}.${area}.${name}`);
}

export function extractProjectIdFromUrl(url = "") {
  return flowSelectors.shell.projectIdFromUrl.exec(String(url || ""))?.[1] || "";
}

export function requireSelector(area, name) {
  const selector = flowSelectors[area]?.[name];
  if (!selector) {
    throw new Error(`Missing Flow selector: ${area}.${name}`);
  }
  return selector;
}

export function requireTextEvidence(area, name) {
  const anchor = flowTextEvidence[area]?.[name];
  if (!anchor) {
    throw new Error(`Missing Flow text evidence: ${area}.${name}`);
  }
  return anchor;
}
