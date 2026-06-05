export const CharacterFailureClass = Object.freeze({
  parseError: "CHARACTER_PARSE_ERROR",
  duplicateHandle: "CHARACTER_DUPLICATE_HANDLE",
  undefinedMention: "CHARACTER_UNDEFINED_MENTION",
  unusedWarning: "CHARACTER_UNUSED_WARNING",
  voiceUnresolved: "CHARACTER_VOICE_UNRESOLVED",
  sourceMissing: "CHARACTER_SOURCE_MISSING",
  creationFailed: "CHARACTER_CREATION_FAILED",
  uploadFailed: "CHARACTER_UPLOAD_FAILED",
  voiceSelectionFailed: "CHARACTER_VOICE_SELECTION_FAILED",
  infoSaveFailed: "CHARACTER_INFO_SAVE_FAILED",
  cardNotRendered: "CHARACTER_CARD_NOT_RENDERED",
  nativeChipNotInserted: "CHARACTER_NATIVE_CHIP_NOT_INSERTED",
  nativeChipMismatch: "CHARACTER_NATIVE_CHIP_MISMATCH",
  fallbackMatchUsed: "CHARACTER_FALLBACK_MATCH_USED",
  flowNativeMatchUnavailable: "FLOW_NATIVE_MATCH_UNAVAILABLE",
  autoFlowMatchUsed: "AUTO_FLOW_MATCH_USED",
  characterSetupRequired: "character_setup_required",
  characterCreationNotStarted: "character_creation_not_started",
  characterCreationInProgress: "character_creation_in_progress",
  characterCreationFailed: "character_creation_failed",
  characterAssetCreatedButNotNativeCharacter: "character_asset_created_but_not_native_character",
  characterNotAvailableInPicker: "character_not_available_in_picker",
  characterPickerImageRowOnly: "character_picker_image_row_only",
  characterCharacterRowPending: "character_character_row_pending",
  characterPickerCharacterRowNotFound: "character_picker_character_row_not_found",
  characterChipMissingCharacterServerId: "character_chip_missing_characterServerId",
  characterMappingStaleProject: "character_mapping_stale_project",
  characterCreationNotProductized: "character_creation_not_productized",
  characterMappingReady: "character_mapping_ready"
});

const HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MENTION_RE = /(^|[^A-Za-z0-9_@-])@([A-Za-z0-9][A-Za-z0-9_-]{0,63})\b/g;
const PACKET_SECTION_RE = /^\s*#\s*(CHARACTER\s+PROMPTS|VIDEO\s+PROMPTS|NOTES)\s*$/i;

export function normalizeCharacterHandle(value = "") {
  return String(value || "").trim().replace(/^@+/, "").toLowerCase();
}

export function isValidCharacterHandle(value = "") {
  return HANDLE_RE.test(String(value || "").trim());
}

export function normalizeVoiceName(value = "") {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function displayNameFromHandle(handle = "") {
  return String(handle || "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

export function inferCharacterDisplayName(handle = "", description = "") {
  const fallback = displayNameFromHandle(handle);
  const text = String(description || "").trim().replace(/\s+/g, " ");
  const match = text.match(/^(.{1,80}?)\s+(?:is|are|has|wears|with|:|-)\b/i);
  if (!match) return fallback;
  const candidate = String(match[1] || "").trim().replace(/[.,:;-]+$/g, "").trim();
  if (!candidate || candidate.length > 60) return fallback;
  if (/^(a|an|the|this|that|fictional|young|adult|realistic|cinematic)\b/i.test(candidate)) return fallback;
  return candidate;
}

export function normalizeVoiceCatalog(catalog = {}) {
  const sourceVoices = Array.isArray(catalog?.voices)
    ? catalog.voices
    : Array.isArray(catalog)
      ? catalog
      : [];
  const voices = sourceVoices
    .map((voice) => {
      const displayName = String(typeof voice === "string" ? voice : voice?.displayName || voice?.name || "").trim();
      if (!displayName) return null;
      return {
        displayName,
        normalizedName: normalizeVoiceName(voice?.normalizedName || displayName),
        description: String(voice?.description || ""),
        flowVoiceId: String(voice?.flowVoiceId || voice?.id || ""),
        previewAvailable: Boolean(voice?.previewAvailable),
        selector: String(voice?.selector || "")
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName));
  return {
    capturedAt: String(catalog?.capturedAt || ""),
    accountTier: String(catalog?.accountTier || ""),
    voiceCount: voices.length,
    voices,
    catalogHash: catalogHash(voices)
  };
}

export function catalogHash(catalogOrVoices = []) {
  const voices = Array.isArray(catalogOrVoices?.voices)
    ? catalogOrVoices.voices
    : Array.isArray(catalogOrVoices)
      ? catalogOrVoices
      : [];
  const input = voices
    .map((voice) => [
      String(typeof voice === "string" ? voice : voice?.displayName || voice?.name || "").trim(),
      String(voice?.flowVoiceId || voice?.id || "").trim(),
      String(voice?.description || "").trim()
    ].join("|"))
    .join("\n");
  return stableHash(input || "empty-voice-catalog");
}

export function resolveFlowVoice(requestedName = "", catalog = {}) {
  const requested = String(requestedName || "").trim();
  if (!requested) {
    return { mode: "none", requestedName: "", matchConfidence: "missing" };
  }
  if (normalizeVoiceName(requested) === "none") {
    return { mode: "none", requestedName: requested, matchConfidence: "exact" };
  }
  const normalizedCatalog = normalizeVoiceCatalog(catalog);
  const exact = normalizedCatalog.voices.find((voice) => voice.displayName === requested);
  if (exact) {
    return {
      mode: "selected_flow_voice",
      requestedName: requested,
      flowVoiceId: exact.flowVoiceId,
      flowVoiceName: exact.displayName,
      matchConfidence: "exact",
      catalogHash: normalizedCatalog.catalogHash
    };
  }
  const requestedKey = normalizeVoiceName(requested);
  const caseMatch = normalizedCatalog.voices.find((voice) => voice.normalizedName === requestedKey);
  if (caseMatch) {
    return {
      mode: "selected_flow_voice",
      requestedName: requested,
      flowVoiceId: caseMatch.flowVoiceId,
      flowVoiceName: caseMatch.displayName,
      matchConfidence: "case_insensitive",
      catalogHash: normalizedCatalog.catalogHash
    };
  }
  return {
    mode: "unresolved",
    requestedName: requested,
    matchConfidence: "missing",
    catalogHash: normalizedCatalog.catalogHash,
    suggestions: voiceSuggestions(requested, normalizedCatalog.voices)
  };
}

export function parseCharacterPrompts(text = "", options = {}) {
  const catalog = normalizeVoiceCatalog(options.voiceCatalog || {});
  const errors = [];
  const warnings = [];
  const intents = [];
  const seen = new Map();
  const lines = String(text || "").split(/\r?\n/);
  lines.forEach((rawLine, rawIndex) => {
    const lineNumber = rawIndex + 1;
    const line = String(rawLine || "").trim();
    if (!line) return;
    const match = line.match(/^@([^\s]+)\s+(.+)$/);
    if (!match) {
      errors.push({
        code: CharacterFailureClass.parseError,
        lineNumber,
        message: `Line ${lineNumber} must start with @handle followed by a description.`,
        rawLine
      });
      return;
    }
    const rawHandle = String(match[1] || "").trim();
    const handle = normalizeCharacterHandle(rawHandle);
    if (!isValidCharacterHandle(rawHandle)) {
      errors.push({
        code: CharacterFailureClass.parseError,
        handle: rawHandle,
        lineNumber,
        message: `Character handle @${rawHandle} is invalid. Use letters, numbers, underscores, or hyphens with no spaces.`,
        rawLine
      });
      return;
    }
    if (seen.has(handle)) {
      errors.push({
        code: CharacterFailureClass.duplicateHandle,
        handle,
        lineNumber,
        firstLineNumber: seen.get(handle),
        message: `Duplicate character handle @${handle}.`,
        rawLine
      });
      return;
    }
    seen.set(handle, lineNumber);
    const parts = String(match[2] || "").split("|||").map((part) => part.trim());
    const description = parts.shift() || "";
    if (!description) {
      errors.push({
        code: CharacterFailureClass.parseError,
        handle,
        lineNumber,
        message: `@${handle} needs a character description.`,
        rawLine
      });
      return;
    }
    let requestedVoice = "";
    let additionalInfo = "";
    const unknownParts = [];
    for (const part of parts) {
      if (!part) continue;
      const named = part.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
      if (!named) {
        unknownParts.push(part);
        continue;
      }
      const key = named[1].toLowerCase();
      const value = String(named[2] || "").trim();
      if (key === "voice") {
        if (requestedVoice) unknownParts.push(part);
        else requestedVoice = value;
      } else if (key === "info") {
        if (additionalInfo) additionalInfo = `${additionalInfo}\n${value}`.trim();
        else additionalInfo = value;
      } else {
        unknownParts.push(part);
      }
    }
    if (unknownParts.length) {
      errors.push({
        code: CharacterFailureClass.parseError,
        handle,
        lineNumber,
        message: `@${handle} has unsupported character section${unknownParts.length === 1 ? "" : "s"}: ${unknownParts.join(" | ")}`,
        rawLine
      });
      return;
    }
    const voice = resolveFlowVoice(requestedVoice, catalog);
    if (voice.mode === "unresolved") {
      errors.push({
        code: CharacterFailureClass.voiceUnresolved,
        handle,
        lineNumber,
        requestedName: voice.requestedName,
        suggestions: voice.suggestions || [],
        message: `Voice not found. Choose one from Flow's voice list: ${voice.requestedName}.`,
        rawLine
      });
    }
    const characterId = `character:${handle}:${stableHash(`${handle}|${description}|${requestedVoice}|${additionalInfo}`).slice(0, 12)}`;
    const displayName = inferCharacterDisplayName(handle, description);
    intents.push({
      characterId,
      runId: String(options.runId || ""),
      handle,
      mention: `@${handle}`,
      displayName,
      description,
      additionalInfo,
      voice,
      source: {
        mode: "generate_from_description",
        sourceMediaId: "",
        sourceHash: "",
        flowCharacterId: ""
      },
      storage: {
        storeInFlow: options.storeInFlow === true,
        estimatedBytes: 0,
        saved: false
      },
      status: voice.mode === "unresolved" ? "voice_unresolved" : "parsed",
      rawLine,
      lineNumber,
      characterHash: stableHash(`${handle}|${normalizePrompt(description)}|${voice.flowVoiceName || voice.requestedName || ""}|${normalizePrompt(additionalInfo)}`)
    });
  });
  return {
    intents,
    errors,
    warnings,
    voiceCatalog: catalog,
    catalogHash: catalog.catalogHash,
    rawText: String(text || "")
  };
}

export function scanCharacterMentions(promptText = "") {
  const mentions = [];
  const seen = new Set();
  let match;
  while ((match = MENTION_RE.exec(String(promptText || "")))) {
    const handle = normalizeCharacterHandle(match[2]);
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    mentions.push({
      handle,
      mention: `@${handle}`,
      index: match.index + String(match[1] || "").length
    });
  }
  return mentions;
}

export function validateCharacterRun(scenePromptText = "", characterPromptText = "", options = {}) {
  const promptLines = Array.isArray(scenePromptText)
    ? scenePromptText.map((line) => String(line || ""))
    : String(scenePromptText || "").split(/\r?\n/);
  const parsed = parseCharacterPrompts(characterPromptText, options);
  const byHandle = new Map(parsed.intents.map((intent) => [intent.handle, intent]));
  const used = new Map();
  const errors = [...parsed.errors];
  const warnings = [...parsed.warnings];
  const scenes = promptLines.map((prompt, index) => {
    const mentions = scanCharacterMentions(prompt);
    const defined = [];
    const undefined = [];
    for (const mention of mentions) {
      if (byHandle.has(mention.handle)) {
        defined.push(mention.handle);
        used.set(mention.handle, (used.get(mention.handle) || 0) + 1);
      } else {
        undefined.push(mention.handle);
      }
    }
    if (undefined.length && options.allowUndefinedMentions !== true) {
      undefined.forEach((handle) => errors.push({
        code: CharacterFailureClass.undefinedMention,
        handle,
        promptIndex: index,
        message: `@${handle} is used in prompts but not defined in Character Prompts.`
      }));
    }
    return {
      promptIndex: index,
      requiredCharacters: [...new Set(defined)],
      undefinedCharacters: [...new Set(undefined)]
    };
  });
  parsed.intents.forEach((intent) => {
    if (!used.has(intent.handle)) {
      warnings.push({
        code: CharacterFailureClass.unusedWarning,
        handle: intent.handle,
        message: `@${intent.handle} is defined but not used in prompts.`
      });
    }
  });
  return {
    ...parsed,
    scenes,
    usedHandles: [...used.keys()],
    undefinedHandles: [...new Set(errors.filter((error) => error.code === CharacterFailureClass.undefinedMention).map((error) => error.handle))],
    errors,
    warnings,
    ok: errors.length === 0
  };
}

export function parseAutoFlowPacket(text = "", options = {}) {
  const rawText = String(text || "");
  const sections = {
    characters: [],
    videos: [],
    notes: []
  };
  const sectionAliases = {
    "CHARACTER PROMPTS": "characters",
    "VIDEO PROMPTS": "videos",
    "NOTES": "notes"
  };
  const sectionOrder = [];
  const warnings = [];
  const errors = [];
  let activeSection = "";
  rawText.split(/\r?\n/).forEach((rawLine, index) => {
    const heading = String(rawLine || "").match(PACKET_SECTION_RE);
    if (heading) {
      const key = sectionAliases[String(heading[1] || "").toUpperCase().replace(/\s+/g, " ")];
      activeSection = key || "";
      if (activeSection && !sectionOrder.includes(activeSection)) sectionOrder.push(activeSection);
      return;
    }
    if (!activeSection) {
      if (String(rawLine || "").trim()) {
        warnings.push({
          code: "AUTO_FLOW_PACKET_IGNORED_LINE",
          lineNumber: index + 1,
          message: "Line ignored because it appears before an Auto Flow Packet section.",
          rawLine
        });
      }
      return;
    }
    if (activeSection === "notes") {
      sections.notes.push(rawLine);
    } else if (String(rawLine || "").trim()) {
      sections[activeSection].push(rawLine);
    }
  });

  const characterPromptText = sections.characters.map((line) => String(line || "").trim()).filter(Boolean).join("\n");
  const videoPromptText = sections.videos.map((line) => String(line || "").trim()).filter(Boolean).join("\n");
  const notesText = sections.notes.join("\n").trim();
  const characterParse = parseCharacterPrompts(characterPromptText, options);
  const definedHandles = new Set(characterParse.intents.map((intent) => intent.handle));
  const sceneRecords = sections.videos.map((rawLine, rawIndex) => parsePacketVideoPromptLine(rawLine, rawIndex));
  const used = new Map();
  const undefinedMentions = [];
  for (const scene of sceneRecords) {
    for (const mention of scene.mentions) {
      if (definedHandles.has(mention.handle)) {
        used.set(mention.handle, (used.get(mention.handle) || 0) + 1);
      } else if (!undefinedMentions.some((entry) => entry.handle === mention.handle)) {
        undefinedMentions.push({
          code: CharacterFailureClass.undefinedMention,
          handle: mention.handle,
          mention: mention.mention,
          promptIndex: scene.promptIndex,
          lineNumber: scene.lineNumber,
          message: `@${mention.handle} is used in video prompts but not defined in Character Prompts.`
        });
      }
    }
  }
  const unusedCharacters = characterParse.intents
    .filter((intent) => !used.has(intent.handle))
    .map((intent) => ({
      code: CharacterFailureClass.unusedWarning,
      handle: intent.handle,
      message: `@${intent.handle} is defined but not used in video prompts.`
    }));
  const duplicateHandles = characterParse.errors
    .filter((error) => error.code === CharacterFailureClass.duplicateHandle)
    .map((error) => error.handle)
    .filter(Boolean);
  const invalidHandles = characterParse.errors
    .filter((error) => error.code === CharacterFailureClass.parseError && error.handle)
    .map((error) => error.handle)
    .filter(Boolean);
  const missingSections = ["characters", "videos"]
    .filter((section) => !sections[section].some((line) => String(line || "").trim()));
  missingSections.forEach((section) => errors.push({
    code: "AUTO_FLOW_PACKET_MISSING_SECTION",
    section,
    message: `Auto Flow Packet is missing # ${section === "characters" ? "CHARACTER PROMPTS" : "VIDEO PROMPTS"}.`
  }));
  errors.push(...characterParse.errors, ...undefinedMentions);
  warnings.push(...(characterParse.warnings || []), ...unusedCharacters);
  const nativeCharacterSetup = characterParse.intents.map((intent) => ({
    handle: intent.handle,
    mention: `@${intent.handle}`,
    displayName: intent.displayName,
    status: CharacterFailureClass.characterSetupRequired,
    ready: false,
    blockingStates: [
      CharacterFailureClass.characterCreationNotStarted,
      CharacterFailureClass.characterAssetCreatedButNotNativeCharacter,
      CharacterFailureClass.characterCharacterRowPending,
      CharacterFailureClass.characterPickerImageRowOnly,
      CharacterFailureClass.characterChipMissingCharacterServerId
    ],
    requires: [
      "native_flow_character_row",
      "not_image_row",
      "AT_TAG_TYPE",
      "characterServerId"
    ]
  }));
  return {
    ok: errors.length === 0,
    rawText,
    sectionOrder,
    characterPromptText,
    videoPromptText,
    notesText,
    characters: characterParse.intents,
    characterParse,
    scenes: sceneRecords,
    notes: notesText,
    counts: {
      characters: characterParse.intents.length,
      scenes: sceneRecords.length,
      notes: notesText ? 1 : 0,
      warnings: warnings.length,
      errors: errors.length
    },
    duplicateHandles: [...new Set(duplicateHandles)],
    invalidHandles: [...new Set(invalidHandles)],
    undefinedMentions,
    unusedCharacters,
    nativeCharacterSetup,
    nativeCharacterSetupStatus: CharacterFailureClass.characterSetupRequired,
    omniReadiness: {
      ready: false,
      status: CharacterFailureClass.characterSetupRequired,
      message: "Create or map native Flow character before Omni."
    },
    mappingsPreserved: true,
    errors,
    warnings
  };
}

export function buildCharacterAssetLedger(intents = [], options = {}) {
  const runId = String(options.runId || `run:${Date.now()}`);
  const explicitMappings = new Map((options.explicitMappings || []).map((mapping) => [normalizeCharacterHandle(mapping.handle), mapping]));
  const assets = [];
  const errors = [];
  const seen = new Set();
  for (const intent of intents) {
    const handle = normalizeCharacterHandle(intent?.handle);
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    const explicit = explicitMappings.get(handle);
    if (explicit && String(explicit.state || "") === "quarantined") {
      errors.push({
        code: CharacterFailureClass.sourceMissing,
        handle,
        message: `@${handle} has a quarantined saved character mapping and cannot be reused.`
      });
    }
    const explicitSourceMode = String(explicit?.sourceMode || "").trim();
    const mappedNativeCharacterId = explicit?.flowCharacterId || explicit?.characterServerId || intent?.source?.flowCharacterId || intent?.source?.characterServerId;
    const sourceMode = mappedNativeCharacterId
      ? explicitSourceMode || "saved_flow_character"
      : explicitSourceMode || intent?.source?.mode || "generate_from_description";
    const sourceRefId = String(intent?.source?.sourceRefId || explicit?.sourceRefId || "");
    const sourceMediaId = String(intent?.source?.sourceMediaId || explicit?.sourceMediaId || "");
    const flowCharacterId = String(mappedNativeCharacterId || "");
    const projectId = String(explicit?.projectId || explicit?.activeProjectId || intent?.source?.projectId || intent?.source?.activeProjectId || options.activeProjectId || options.projectId || "");
    const hasNativeCharacterProof = Boolean(flowCharacterId);
    const hasSourceImageProof = Boolean(sourceRefId || sourceMediaId);
    const setupStatus = hasNativeCharacterProof
      ? CharacterFailureClass.characterMappingReady
      : hasSourceImageProof
        ? CharacterFailureClass.characterAssetCreatedButNotNativeCharacter
        : CharacterFailureClass.characterCreationNotStarted;
    assets.push({
      runId,
      characterId: String(intent?.characterId || `character:${handle}`),
      handle,
      displayName: String(intent?.displayName || displayNameFromHandle(handle)),
      descriptionHash: stableHash(intent?.description || ""),
      additionalInfoHash: stableHash(intent?.additionalInfo || ""),
      requestedVoice: String(intent?.voice?.requestedName || ""),
      resolvedVoiceName: String(intent?.voice?.flowVoiceName || ""),
      flowVoiceId: String(intent?.voice?.flowVoiceId || ""),
      sourceMode,
      sourceRefId,
      sourceMediaId,
      sourceHash: String(intent?.source?.sourceHash || explicit?.sourceHash || ""),
      flowCharacterId,
      characterServerId: flowCharacterId,
      projectId,
      activeProjectId: String(explicit?.activeProjectId || explicit?.projectId || intent?.source?.activeProjectId || intent?.source?.projectId || options.activeProjectId || options.projectId || ""),
      mappingProjectMatchesActiveProject: Boolean((options.activeProjectId || options.projectId) && projectId && projectId === String(options.activeProjectId || options.projectId)),
      characterServerIdHash: String(explicit?.characterServerIdHash || ""),
      creationPath: flowCharacterId
        ? "explicit_saved_mapping"
        : sourceRefId || sourceMediaId
          ? "source_image_to_character"
          : "description_to_character",
      storageMode: options.storeInFlow === true || intent?.storage?.storeInFlow === true ? "store_in_flow" : "run_only_no_auto_reuse",
      estimatedBytes: Number(intent?.storage?.estimatedBytes || explicit?.estimatedBytes || 0),
      state: setupStatus,
      setupStatus,
      classicMatchReady: hasSourceImageProof,
      nativeCharacterReady: hasNativeCharacterProof,
      proofIds: Array.isArray(explicit?.proofIds) ? explicit.proofIds.slice(0, 10) : [],
      createdAt: String(options.createdAt || new Date().toISOString()),
      updatedAt: String(options.createdAt || new Date().toISOString())
    });
  }
  return { runId, assets, errors };
}

export function characterQuotaTelemetry(event = {}, options = {}) {
  return {
    quotaCommitType: "character_creation",
    quotaDelta: 0,
    acceptedProofId: String(options.acceptedProofId || event.acceptedProofId || ""),
    characterId: String(event.characterId || ""),
    handle: String(event.handle || ""),
    status: String(event.status || "")
  };
}

export function sceneQuotaTelemetry(task = {}, options = {}) {
  const acceptedProofId = String(options.acceptedProofId || task.acceptedProofId || task.submitId || "").trim();
  return {
    quotaCommitType: "scene_generation",
    quotaDelta: acceptedProofId ? 1 : 0,
    acceptedProofId,
    taskId: String(task.id || ""),
    prompt: String(task.prompt || "")
  };
}

function voiceSuggestions(requested = "", voices = []) {
  const key = normalizeVoiceName(requested);
  if (!key) return [];
  const chunks = key.split(/\s+/).filter(Boolean);
  return voices
    .filter((voice) => chunks.some((chunk) => voice.normalizedName.includes(chunk) || chunk.includes(voice.normalizedName)))
    .slice(0, 5)
    .map((voice) => voice.displayName);
}

function parsePacketVideoPromptLine(rawLine = "", rawIndex = 0) {
  const raw = String(rawLine || "").trim();
  const parts = raw.split("|||").map((part) => part.trim());
  const firstPart = parts[0] || "";
  const secondPart = parts.slice(1).join(" ||| ").trim();
  const sceneTag = (raw.match(/^\s*(\[[^\]]+\])/) || [])[1] || "";
  const stripSceneTag = (value = "") => String(value || "").replace(/^\s*\[[^\]]+\]\s*/, "").trim();
  return {
    promptIndex: rawIndex,
    lineNumber: rawIndex + 1,
    rawLine,
    sceneTag,
    isSplit: raw.includes("|||"),
    imagePrompt: stripSceneTag(firstPart),
    videoPrompt: secondPart ? stripSceneTag(secondPart) : "",
    prompt: raw,
    mentions: scanCharacterMentions(raw)
  };
}

function normalizePrompt(value = "") {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function stableHash(value = "") {
  let hash = 0x811c9dc5;
  const input = String(value || "");
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
