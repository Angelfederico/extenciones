import {
  CharacterFailureClass,
  displayNameFromHandle,
  normalizeCharacterHandle
} from "./character-prompts.js";

export const CHARACTER_SETUP_STATES = Object.freeze([
  CharacterFailureClass.characterSetupRequired,
  CharacterFailureClass.characterCreationNotStarted,
  CharacterFailureClass.characterCreationInProgress,
  CharacterFailureClass.characterAssetCreatedButNotNativeCharacter,
  CharacterFailureClass.characterCharacterRowPending,
  CharacterFailureClass.characterPickerImageRowOnly,
  CharacterFailureClass.characterPickerCharacterRowNotFound,
  CharacterFailureClass.characterChipMissingCharacterServerId,
  CharacterFailureClass.characterMappingStaleProject,
  CharacterFailureClass.characterCreationNotProductized,
  CharacterFailureClass.characterMappingReady,
  CharacterFailureClass.characterCreationFailed
]);

const READY = CharacterFailureClass.characterMappingReady;

export function normalizeCharacterSetupState(value = "") {
  const status = String(value || "").trim();
  return CHARACTER_SETUP_STATES.includes(status) ? status : CharacterFailureClass.characterCreationNotStarted;
}

export function buildCharacterSetupPlan(intents = [], options = {}) {
  const activeProjectId = normalizeProjectId(options.activeProjectId || options.projectId || options.flowProjectId || "");
  const sourceMap = normalizeSourceMap(options.sources || {});
  const nativeRows = normalizeRows(options.nativeRows || options.characterRows || [], "character", { activeProjectId });
  const imageRows = normalizeRows(options.imageRows || [], "image", { activeProjectId });
  const savedRows = normalizeRows(options.savedMappings || [], "saved");
  const creationAttempts = normalizeRows(options.creationAttempts || [], "creation_attempt", { activeProjectId });
  const items = (intents || [])
    .map((intent) => setupItemForIntent(intent, { activeProjectId, sourceMap, nativeRows, imageRows, savedRows, creationAttempts }))
    .filter(Boolean);
  const blockers = items.filter((item) => item.status !== READY);
  const activeProjectPreflight = items.map((item) => item.activeProjectPreflight).filter(Boolean);
  return {
    ok: blockers.length === 0,
    ready: blockers.length === 0,
    status: blockers.length ? CharacterFailureClass.characterSetupRequired : READY,
    counts: {
      total: items.length,
      ready: items.filter((item) => item.status === READY).length,
      blocked: blockers.length
    },
    items,
    mappings: nativeCharacterHandleMapFromSetup(items),
    blockers,
    activeProjectId,
    traceEventName: "character_setup_active_project_preflight",
    activeProjectPreflight
  };
}

export function applyCharacterSetupPlanToSources(sources = {}, plan = {}) {
  const next = { ...(sources || {}) };
  const proofTimestamp = String(plan.proofTimestamp || new Date().toISOString());
  for (const item of plan.items || []) {
    const handle = normalizeCharacterHandle(item.handle);
    if (!handle) continue;
    const existing = next[handle] || {};
    const ready = item.status === READY && item.characterServerId;
    const proofHash = item.characterServerIdHash || redactedStableHash(item.characterServerId);
    next[handle] = {
      ...existing,
      sourceMode: ready ? "saved_flow_character" : existing.sourceMode || "generate_from_description",
      flowCharacterId: ready ? item.characterServerId : "",
      characterServerId: ready ? item.characterServerId : "",
      flowDisplayName: ready ? item.displayName : String(existing.flowDisplayName || ""),
      projectId: ready ? String(item.projectId || item.activeProjectId || "") : "",
      activeProjectId: String(item.activeProjectId || item.projectId || ""),
      storedMappingProjectId: String(item.storedMappingProjectId || existing.storedMappingProjectId || ""),
      mappingProjectMatchesActiveProject: Boolean(item.mappingProjectMatchesActiveProject),
      status: item.status,
      setupStatus: item.status,
      characterServerIdHash: ready ? proofHash : String(existing.characterServerIdHash || ""),
      storedCharacterServerIdHash: !ready ? String(item.storedCharacterServerIdHash || existing.storedCharacterServerIdHash || "") : "",
      proofTimestamp: ready ? proofTimestamp : String(existing.proofTimestamp || ""),
      proofIds: mergeProofIds(existing.proofIds, item.proofId)
    };
  }
  return next;
}

export function mergeNativeCharacterSavedMappings(existing = [], mappings = [], options = {}) {
  const merged = new Map();
  for (const mapping of Array.isArray(existing) ? existing : []) {
    const handle = normalizeCharacterHandle(mapping?.handle || mapping?.mention || mapping?.displayName || "");
    if (!handle) continue;
    merged.set(handle, { ...mapping, handle });
  }
  for (const mapping of Array.isArray(mappings) ? mappings : []) {
    const handle = normalizeCharacterHandle(mapping?.handle || mapping?.mention || mapping?.displayName || "");
    const characterServerId = String(mapping?.characterServerId || mapping?.flowCharacterId || mapping?.entityId || "").trim();
    if (!handle || !characterServerId) continue;
    const current = merged.get(handle) || {};
    const proofTimestamp = String(mapping?.proofTimestamp || options.proofTimestamp || new Date().toISOString());
    const projectId = normalizeProjectId(mapping?.projectId || mapping?.activeProjectId || options.activeProjectId || options.projectId || "");
    merged.set(handle, {
      ...current,
      ...mapping,
      handle,
      sourceMode: "saved_flow_character",
      flowCharacterId: characterServerId,
      characterServerId,
      projectId,
      activeProjectId: projectId,
      mappingProjectMatchesActiveProject: Boolean(projectId),
      characterServerIdHash: String(mapping?.characterServerIdHash || current.characterServerIdHash || redactedStableHash(characterServerId)),
      proofTimestamp,
      status: READY,
      state: READY,
      proofIds: mergeProofIds(current.proofIds, mapping.proofId || options.proofId)
    });
  }
  return [...merged.values()];
}

export function markStaleNativeCharacterSavedMappings(existing = [], setupItems = []) {
  const staleByHandle = new Map((Array.isArray(setupItems) ? setupItems : [])
    .filter((item) => item && item.status && item.status !== READY)
    .map((item) => [normalizeCharacterHandle(item.handle || item.mention || item.displayName || ""), item])
    .filter(([handle]) => handle));
  if (!staleByHandle.size) return Array.isArray(existing) ? existing : [];
  return (Array.isArray(existing) ? existing : []).map((mapping) => {
    const handle = normalizeCharacterHandle(mapping?.handle || mapping?.mention || mapping?.displayName || "");
    const item = staleByHandle.get(handle);
    if (!item) return mapping;
    return {
      ...mapping,
      handle,
      flowCharacterId: "",
      characterServerId: "",
      storedCharacterServerIdHash: String(item.storedCharacterServerIdHash || mapping?.storedCharacterServerIdHash || ""),
      storedMappingProjectId: String(item.storedMappingProjectId || mapping?.projectId || mapping?.storedMappingProjectId || ""),
      projectId: "",
      activeProjectId: String(item.activeProjectId || mapping?.activeProjectId || ""),
      mappingProjectMatchesActiveProject: false,
      status: item.status,
      state: item.status,
      setupStatus: item.status,
      staleReason: String(item.reason || mapping?.staleReason || "")
    };
  });
}

export function nativeCharacterHandleMapFromSetup(planOrItems = {}) {
  const sourceItems = Array.isArray(planOrItems) ? planOrItems : (planOrItems.items || planOrItems.assets || []);
  return sourceItems
    .map((item) => {
      const handle = normalizeCharacterHandle(item?.handle || item?.mention || item?.displayName || "");
      const characterServerId = String(item?.characterServerId || item?.flowCharacterId || item?.entityId || "").trim();
      const status = String(item?.status || item?.state || item?.setupStatus || "");
      if (!handle || !characterServerId || (status && status !== READY)) return null;
      return {
        handle,
        mention: `@${handle}`,
        displayName: String(item?.displayName || item?.flowDisplayName || displayNameFromHandle(handle)).trim(),
        characterServerId,
        flowCharacterId: characterServerId,
        projectId: String(item?.projectId || item?.activeProjectId || ""),
        activeProjectId: String(item?.activeProjectId || item?.projectId || ""),
        characterServerIdHash: String(item?.characterServerIdHash || redactedStableHash(characterServerId)),
        proofTimestamp: String(item?.proofTimestamp || new Date().toISOString()),
        source: "native_character_setup_runner",
        status: READY
      };
    })
    .filter(Boolean);
}

export function projectIdFromFlowRoute(url = "") {
  return normalizeProjectId(String(url || "").match(/\/fx\/(?:[^/?#]+\/)?tools\/flow\/project\/([0-9a-f-]{36})/i)?.[1] || "");
}

export function readyNativeCharacterMappingsForProject(options = {}) {
  const activeProjectId = normalizeProjectId(options.activeProjectId || options.projectId || "");
  const setupRunner = options.setupRunner || {};
  const runnerProjectId = normalizeProjectId(setupRunner.projectId || setupRunner.activeProjectId || projectIdFromFlowRoute(setupRunner.proof?.route || ""));
  const effectiveProjectId = activeProjectId || runnerProjectId;
  const runnerReady = Boolean(String(setupRunner.status || "") === READY
    && (!effectiveProjectId || (runnerProjectId && runnerProjectId === effectiveProjectId)));
  const merged = new Map();
  const diagnostics = {
    activeProjectId,
    runnerProjectId,
    effectiveProjectId,
    runnerReady,
    savedNativeMappingCount: 0,
    readyNativeMappingCount: 0,
    rejectedNativeMappingCount: 0,
    rejectionReasons: []
  };
  const reject = (reason = "") => {
    diagnostics.rejectedNativeMappingCount += 1;
    if (reason) diagnostics.rejectionReasons.push(reason);
  };
  const addMapping = (mapping = {}, fallbackHandle = "", source = "") => {
    const handle = normalizeCharacterHandle(mapping?.handle || mapping?.mention || fallbackHandle || mapping?.displayName || mapping?.flowDisplayName || "");
    const characterServerId = String(mapping?.characterServerId || mapping?.flowCharacterId || mapping?.entityId || "").trim();
    if (!handle || !characterServerId) {
      reject("missing_handle_or_characterServerId");
      return;
    }
    const status = String(mapping?.status || mapping?.state || mapping?.setupStatus || READY);
    if (status && status !== READY) {
      reject(`status:${status}`);
      return;
    }
    const mappingProjectId = normalizeProjectId(mapping?.projectId || mapping?.activeProjectId || mapping?.storedMappingProjectId || mapping?.flowProjectId || "");
    if (effectiveProjectId && mappingProjectId && mappingProjectId !== effectiveProjectId) {
      reject("project_mismatch");
      return;
    }
    if (effectiveProjectId && !mappingProjectId && !runnerReady) {
      reject("missing_project_without_ready_runner");
      return;
    }
    merged.set(handle, {
      ...mapping,
      handle,
      mention: `@${handle}`,
      displayName: String(mapping?.displayName || mapping?.flowDisplayName || displayNameFromHandle(handle)).trim(),
      flowCharacterId: characterServerId,
      characterServerId,
      projectId: mappingProjectId || effectiveProjectId,
      activeProjectId: effectiveProjectId || mappingProjectId,
      mappingProjectMatchesActiveProject: Boolean(effectiveProjectId && (mappingProjectId || effectiveProjectId) === effectiveProjectId),
      sourceMode: "saved_flow_character",
      source,
      status: READY,
      state: READY,
      setupStatus: READY,
      nativeCharacterReady: true,
      characterServerIdHash: String(mapping?.characterServerIdHash || redactedStableHash(characterServerId))
    });
  };

  const savedMappings = Array.isArray(options.savedMappings) ? options.savedMappings : [];
  const assets = Array.isArray(options.assets) ? options.assets : [];
  diagnostics.savedNativeMappingCount += savedMappings.length + assets.length;
  savedMappings.forEach((mapping) => addMapping(mapping, "", "saved_mapping"));
  assets.forEach((mapping) => addMapping(mapping, "", "character_asset"));
  Object.entries(options.characterSources || {}).forEach(([handle, source]) => addMapping(source, handle, "character_source"));
  const mappings = [...merged.values()];
  diagnostics.readyNativeMappingCount = mappings.length;
  return options.includeDiagnostics ? { mappings, diagnostics } : mappings;
}

export function assertCharacterSetupReadyForPathC(preflight = {}) {
  const activeProjectId = normalizeProjectId(preflight.activeProjectId || preflight.projectId || "");
  const usedHandles = new Set((preflight.usedHandles || [])
    .map((handle) => normalizeCharacterHandle(handle))
    .filter(Boolean));
  if (!usedHandles.size) return preflight;
  const byHandle = new Map((preflight.assets || [])
    .map((asset) => [normalizeCharacterHandle(asset?.handle), asset])
    .filter(([handle]) => handle));
  const blockers = [...usedHandles]
    .map((handle) => byHandle.get(handle) || { handle, status: CharacterFailureClass.characterSetupRequired })
    .filter((asset) => {
      const characterServerId = String(asset.characterServerId || asset.flowCharacterId || "").trim();
      const status = String(asset.status || asset.state || "");
      const mappingProjectId = normalizeProjectId(asset.projectId || asset.activeProjectId || "");
      return status !== READY
        || !characterServerId
        || (activeProjectId && (!mappingProjectId || mappingProjectId !== activeProjectId));
    });
  if (!blockers.length) return preflight;
  const handles = blockers.map((asset) => `@${normalizeCharacterHandle(asset.handle)}`).join(", ");
  const error = new Error(`Native Character setup required before Path C: ${handles}.`);
  error.code = CharacterFailureClass.characterSetupRequired;
  error.blockers = blockers.map((asset) => ({
    handle: normalizeCharacterHandle(asset.handle),
    status: String(asset.status || asset.state || CharacterFailureClass.characterSetupRequired),
    reason: String(asset.reason || asset.setupStatus || ""),
    projectId: String(asset.projectId || asset.activeProjectId || ""),
    mappingProjectMatchesActiveProject: activeProjectId
      ? String(asset.projectId || asset.activeProjectId || "") === activeProjectId
      : null
  }));
  throw error;
}

function setupItemForIntent(intent = {}, context = {}) {
  const handle = normalizeCharacterHandle(intent.handle || intent.mention || "");
  if (!handle) return null;
  const displayName = String(intent.displayName || displayNameFromHandle(handle)).trim();
  const activeProjectId = normalizeProjectId(context.activeProjectId || "");
  const source = context.sourceMap.get(handle) || {};
  const nativeRow = findMatchingRow(context.nativeRows.filter(isTrueNativeCharacterRow), handle, displayName);
  const savedRow = findMatchingRow(context.savedRows, handle, displayName);
  const imageRow = findMatchingRow(context.imageRows, handle, displayName);
  const creationAttempt = findMatchingRow(context.creationAttempts || [], handle, displayName);
  const sourceCharacterId = String(source.characterServerId || source.flowCharacterId || "").trim();
  const storedCharacterServerId = String(savedRow?.characterServerId || sourceCharacterId || "").trim();
  const storedMappingProjectId = normalizeProjectId(savedRow?.projectId || savedRow?.activeProjectId || source.projectId || source.activeProjectId || "");
  const mappingProjectMatchesActiveProject = storedCharacterServerId
    ? Boolean(activeProjectId && storedMappingProjectId && storedMappingProjectId === activeProjectId)
    : false;
  const nativeCharacterId = String(nativeRow?.characterServerId || "").trim();
  let status = CharacterFailureClass.characterCreationNotStarted;
  let reason = "no_native_character_mapping";
  if (nativeCharacterId) {
    status = READY;
    reason = "native_character_row_with_characterServerId";
  } else if (storedCharacterServerId) {
    status = CharacterFailureClass.characterMappingStaleProject;
    reason = mappingProjectMatchesActiveProject
      ? "stored_mapping_not_found_in_active_project_picker"
      : "stored_mapping_project_mismatch_or_missing";
  } else if (String(source.status || source.setupStatus || "") === CharacterFailureClass.characterCreationInProgress) {
    status = CharacterFailureClass.characterCreationInProgress;
    reason = "creation_in_progress";
  } else if (String(source.status || source.setupStatus || "") === CharacterFailureClass.characterPickerImageRowOnly) {
    status = CharacterFailureClass.characterPickerImageRowOnly;
    reason = "picker_returned_image_row";
  } else if (String(source.status || source.setupStatus || "") === CharacterFailureClass.characterChipMissingCharacterServerId) {
    status = CharacterFailureClass.characterChipMissingCharacterServerId;
    reason = "chip_missing_characterServerId";
  } else if (String(source.status || source.setupStatus || "") === CharacterFailureClass.characterMappingStaleProject) {
    status = CharacterFailureClass.characterMappingStaleProject;
    reason = "stored_mapping_project_mismatch_or_missing";
  } else if (imageRow || source.sourceRefId || source.sourceMediaId) {
    status = CharacterFailureClass.characterAssetCreatedButNotNativeCharacter;
    reason = "source_image_or_project_asset_is_not_native_character";
  } else if (String(source.status || source.setupStatus || "") === CharacterFailureClass.characterCreationFailed) {
    status = CharacterFailureClass.characterCreationFailed;
    reason = "character_creation_failed";
  } else if (String(source.status || source.setupStatus || "") === CharacterFailureClass.characterCreationNotProductized) {
    status = CharacterFailureClass.characterCreationNotProductized;
    reason = "character_creation_not_productized";
  }
  const mappingStored = status === READY && Boolean(nativeCharacterId && activeProjectId);
  const activeProjectPreflight = {
    activeProjectId,
    handle,
    displayName,
    storedCharacterServerIdRedacted: redactCharacterServerId(storedCharacterServerId),
    storedMappingProjectId,
    mappingProjectMatchesActiveProject,
    pickerCharacterRowFound: Boolean(nativeRow?.characterServerId),
    pickerImageRowFound: Boolean(imageRow),
    characterRowCount: Array.isArray(context.nativeRows) ? context.nativeRows.length : 0,
    imageRowCount: Array.isArray(context.imageRows) ? context.imageRows.length : 0,
    setupStatus: status,
    creationAttempted: Boolean(creationAttempt),
    creationResult: creationAttempt ? {
      status: String(creationAttempt.status || ""),
      ok: creationAttempt.ok === true,
      error: String(creationAttempt.error || ""),
      characterServerIdProof: Boolean(creationAttempt.characterServerId || creationAttempt.characterServerIdHash)
    } : null,
    characterServerIdProof: Boolean(nativeRow?.characterServerId),
    mappingStored
  };
  return {
    handle,
    mention: `@${handle}`,
    displayName,
    activeProjectId,
    projectId: status === READY ? activeProjectId : "",
    status,
    ready: status === READY,
    reason,
    characterServerId: nativeCharacterId,
    flowCharacterId: nativeCharacterId,
    storedCharacterServerId,
    storedCharacterServerIdHash: redactedStableHash(storedCharacterServerId),
    storedMappingProjectId,
    mappingProjectMatchesActiveProject,
    nativeRow: nativeRow || null,
    imageRow: imageRow || null,
    creationAttempt: creationAttempt || null,
    activeProjectPreflight,
    sourceMode: String(source.sourceMode || intent.source?.mode || "generate_from_description"),
    proofId: String(nativeRow?.proofId || savedRow?.proofId || source.proofId || ""),
    characterServerIdHash: String(nativeRow?.characterServerIdHash || redactedStableHash(nativeCharacterId)),
    proofTimestamp: String(nativeRow?.proofTimestamp || savedRow?.proofTimestamp || source.proofTimestamp || "")
  };
}

function normalizeSourceMap(sources = {}) {
  return new Map(Object.entries(sources || {})
    .map(([handle, source]) => [normalizeCharacterHandle(handle), source || {}])
    .filter(([handle]) => handle));
}

function normalizeRows(rows = [], defaultKind = "", options = {}) {
  const activeProjectId = normalizeProjectId(options.activeProjectId || "");
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const handle = normalizeCharacterHandle(row?.handle || row?.mention || "");
      const displayName = String(row?.displayName || row?.flowDisplayName || row?.name || "").trim();
      const characterServerId = String(row?.characterServerId || row?.flowCharacterId || row?.entityId || row?.serverId || "").trim();
      const rowKind = String(row?.rowKind || row?.entityType || row?.type || defaultKind || "").toLowerCase();
      const projectId = normalizeProjectId(row?.projectId || row?.activeProjectId || row?.flowProjectId || (defaultKind === "character" || defaultKind === "image" ? activeProjectId : ""));
      return {
        ...row,
        handle,
        displayName,
        normalizedDisplayName: normalizeDisplayName(displayName),
        characterServerId,
        projectId,
        activeProjectId: projectId || activeProjectId,
        characterServerIdHash: String(row?.characterServerIdHash || redactedStableHash(characterServerId)),
        proofTimestamp: String(row?.proofTimestamp || ""),
        rowKind
      };
    })
    .filter((row) => row.handle || row.displayName || row.characterServerId);
}

function findMatchingRow(rows = [], handle = "", displayName = "") {
  const normalizedHandle = normalizeDisplayName(handle);
  const normalizedName = normalizeDisplayName(displayName);
  return rows.find((row) => {
    const rowHandle = normalizeDisplayName(row.handle || "");
    const rowName = normalizeDisplayName(row.displayName || "");
    return (normalizedHandle && rowHandle === normalizedHandle)
      || (normalizedName && rowName === normalizedName)
      || (normalizedName && rowName && (rowName.includes(normalizedName) || normalizedName.includes(rowName)));
  }) || null;
}

function isTrueNativeCharacterRow(row = {}) {
  return String(row.rowKind || row.entityType || row.type || "").toLowerCase() === "character";
}

function normalizeDisplayName(value = "") {
  return String(value || "").trim().toLowerCase().replace(/^@+/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function mergeProofIds(existing = [], id = "") {
  return [...new Set([...(Array.isArray(existing) ? existing : []), String(id || "").trim()].filter(Boolean))].slice(0, 10);
}

function redactedStableHash(value = "") {
  const input = String(value || "").trim();
  if (!input) return "";
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeProjectId(value = "") {
  return String(value || "").trim();
}

function redactCharacterServerId(value = "") {
  const input = String(value || "").trim();
  if (!input) return "";
  return input.length > 10 ? `${input.slice(0, 4)}...${input.slice(-4)}` : input;
}
