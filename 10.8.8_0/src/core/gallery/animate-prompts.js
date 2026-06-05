const VIDEO_HINT_RE = /\b(video|animate|animation|motion|camera|shot|scene|pan|tilt|dolly|push|pull|zoom|rack focus|tracking|handheld|cinematic|duration|seconds|veo)\b/i;
const IMAGE_HINT_RE = /\b(image|still|photo|photograph|portrait|poster|reference|thumbnail|render|illustration|product shot)\b/i;
const REFERENCE_MATCH_STOPWORDS = new Set([
  "image", "img", "photo", "picture", "reference", "ref", "product", "shot",
  "still", "frame", "start", "end", "match", "test", "proof", "verify",
  "matrix", "sample", "upload", "prompt"
]);

export function sceneTag(value = "") {
  const match = String(value || "").match(/\[([^\]]+)\]/);
  return match ? normalizeTag(match[1]) : "";
}

export function normalizeTag(value = "") {
  return String(value || "").trim().toLowerCase();
}

export function stripSceneTag(value = "") {
  return String(value || "").replace(/^\s*\[[^\]]+\]\s*/, "").trim();
}

export function normalizePromptText(value = "") {
  return stripSceneTag(value)
    .replace(/^\s*(image|still|reference|video|motion|animation)\s*prompt\s*:\s*/i, "")
    .replace(/^\s*(image|still|reference|video|motion|animation)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function parseAutoFlowPromptDocument(text = "") {
  const lines = String(text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const entries = [];
  const byTag = new Map();

  for (const line of lines) {
    if (!line.includes("|||")) continue;
    const parts = line.split("|||").map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const tag = sceneTag(line);
    if (!tag) continue;
    const entry = {
      tag,
      line,
      sides: parts,
      left: parts[0] || "",
      right: parts.slice(1).join(" ||| ")
    };
    entries.push(entry);
    if (!byTag.has(tag)) byTag.set(tag, entry);
  }

  return {
    entries,
    byTag,
    isAutoFlowFormat: entries.length > 0
  };
}

function scoreAutoFlowSides(entry, item = {}) {
  if (!entry) return "";
  const itemText = [
    item.prompt,
    item.title,
    item.fileName
  ].map((value) => normalizePromptText(value)).filter(Boolean).join(" ");

  const sides = entry.sides || [];
  if (sides.length < 2) return [];

  return sides.map((side, index) => {
    const normalized = normalizePromptText(side);
    const directItemMatch = normalized && itemText && (itemText.includes(normalized) || normalized.includes(itemText));
    const videoHints = VIDEO_HINT_RE.test(side) ? 2 : 0;
    const imageHints = IMAGE_HINT_RE.test(side) ? 1 : 0;
    return {
      index,
      side,
      normalized,
      directItemMatch,
      score: videoHints - imageHints + (index > 0 ? 0.25 : 0)
    };
  });
}

function likelyVideoSide(entry, item = {}) {
  const sideScores = scoreAutoFlowSides(entry, item);
  if (!sideScores.length) return null;
  const matchedImageSide = sideScores.find((candidate) => candidate.directItemMatch);
  if (matchedImageSide && sideScores.length > 1) {
    const opposite = sideScores
      .filter((candidate) => candidate.index !== matchedImageSide.index)
      .sort((a, b) => b.score - a.score)[0];
    if (opposite?.side) return opposite;
  }
  return [...sideScores].sort((a, b) => b.score - a.score)[0] || null;
}

export function promptForImageFromAutoFlowEntry(entry, item = {}) {
  if (!entry) return "";
  const sides = entry.sides || [];
  if (sides.length < 2) return stripSceneTag(entry.right || entry.left || "");
  const likelyVideo = likelyVideoSide(entry, item);
  return stripSceneTag(likelyVideo?.side || entry.right || entry.left || "");
}

export function imagePromptFromAutoFlowEntry(entry, item = {}) {
  if (!entry) return "";
  const sides = entry.sides || [];
  if (sides.length < 2) return stripSceneTag(entry.left || entry.right || "");
  const videoSide = likelyVideoSide(entry, item);
  const imageSide = scoreAutoFlowSides(entry, item)
    .filter((candidate) => candidate.index !== videoSide?.index)
    .sort((a, b) => a.score - b.score)[0];
  return stripSceneTag(imageSide?.side || entry.left || entry.right || "");
}

export function splitAutoFlowPromptLine(line = "") {
  const sourcePrompt = String(line || "").trim();
  const parsed = parseAutoFlowPromptDocument(sourcePrompt);
  const entry = parsed.entries[0] || null;
  if (!entry) {
    return {
      isAutoFlowFormat: false,
      tag: "",
      sourcePrompt,
      imagePrompt: sourcePrompt,
      videoPrompt: ""
    };
  }
  return {
    isAutoFlowFormat: true,
    tag: entry.tag || "",
    sourcePrompt,
    imagePrompt: imagePromptFromAutoFlowEntry(entry),
    videoPrompt: promptForImageFromAutoFlowEntry(entry)
  };
}

function normalizeReferenceMatchText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9.@ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function referenceMatchTerms(item = {}) {
  return referenceMatchBuckets(item).allTerms;
}

function referenceMatchBuckets(item = {}) {
  const raw = [
    item.fileName,
    item.title,
    item.name,
    item.id,
    String(item.fileName || "").replace(/\.[^.]+$/, ""),
    String(item.title || "").replace(/\.[^.]+$/, "")
  ].map((value) => String(value || "").trim()).filter(Boolean);
  const exactTerms = new Set();
  const tokenTerms = new Set();
  for (const value of raw) {
    const normalized = normalizeReferenceMatchText(value);
    if (normalized.length >= 3) exactTerms.add(normalized);
    const basename = normalizeReferenceMatchText(value.replace(/\.[^.]+$/, ""));
    if (basename.length >= 3) exactTerms.add(basename);
    for (const token of basename.split(/\s+/)) {
      if (REFERENCE_MATCH_STOPWORDS.has(token)) continue;
      if (/^\d+$/.test(token)) continue;
      if (token.length >= 4) tokenTerms.add(token);
    }
  }
  const exact = [...exactTerms].sort((a, b) => b.length - a.length);
  const tokens = [...tokenTerms].sort((a, b) => b.length - a.length);
  return {
    exact,
    tokens,
    allTerms: [...new Set([...exact, ...tokens])]
  };
}

function normalizedPromptContains(normalizedPrompt = "", term = "") {
  const normalizedTerm = normalizeReferenceMatchText(term);
  if (!normalizedPrompt || !normalizedTerm) return false;
  const promptText = ` ${normalizedPrompt.replace(/@/g, " ")} `;
  const termText = ` ${normalizedTerm} `;
  return promptText.includes(termText);
}

export function promptMatchesReferenceItem(prompt = "", item = {}) {
  const normalizedPrompt = normalizeReferenceMatchText(prompt);
  if (!normalizedPrompt) return false;
  return referenceMatchTerms(item).some((term) => normalizedPromptContains(normalizedPrompt, term));
}

export function matchedReferenceIdsForPrompt(prompt = "", refs = [], options = {}) {
  const limit = Math.max(0, Number(options.limit || refs.length || 0) || refs.length || 0);
  const normalizedPrompt = normalizeReferenceMatchText(prompt);
  const candidates = (refs || []).map((ref) => ({
    ref,
    id: String(ref?.id || "").trim(),
    buckets: referenceMatchBuckets(ref)
  })).filter((entry) => entry.id);
  const tokenCounts = candidates.reduce((map, entry) => {
    for (const token of entry.buckets.tokens) map.set(token, (map.get(token) || 0) + 1);
    return map;
  }, new Map());
  const matches = [];
  for (const candidate of candidates) {
    const exactMatch = candidate.buckets.exact.some((term) => normalizedPromptContains(normalizedPrompt, term));
    const uniqueTokenMatch = candidate.buckets.tokens.some((token) =>
      tokenCounts.get(token) === 1 && normalizedPromptContains(normalizedPrompt, token)
    );
    if (!exactMatch && !uniqueTokenMatch) continue;
    matches.push(candidate.id);
    if (limit && matches.length >= limit) break;
  }
  return matches;
}

export function buildAnimatePromptAssignments(selectedImages, mode, text) {
  const raw = String(text || "").trim();
  const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (mode === "shared") {
    return selectedImages.map((item) => ({ item, prompt: raw }));
  }
  if (mode === "document") {
    const document = parseAutoFlowPromptDocument(raw);
    return selectedImages.map((item) => {
      const tag = sceneTag(item.prompt) || sceneTag(item.title) || sceneTag(item.fileName);
      const entry = tag ? document.byTag.get(tag) : null;
      return { item, prompt: promptForImageFromAutoFlowEntry(entry, item) };
    });
  }
  return selectedImages.map((item, index) => ({ item, prompt: lines[index] || "" }));
}
