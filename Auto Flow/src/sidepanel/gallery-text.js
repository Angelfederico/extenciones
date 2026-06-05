export function isGenericGeneratedTitle(value = "") {
  return /^generated\s+(image|video|media)$/i.test(String(value || "").trim());
}

export function cleanGalleryPromptText(value = "") {
  let text = String(value || "").trim();
  const promptMatch = text.match(/<prompt>([\s\S]*?)<\/prompt>/i);
  if (promptMatch) text = promptMatch[1];
  text = text
    .replace(/<\/?(root|context|instruction|prompt)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

export function galleryPromptLabel(item = {}) {
  const prompt = cleanGalleryPromptText(item.prompt || "");
  if (prompt && !isGenericGeneratedTitle(prompt)) return prompt;
  const title = cleanGalleryPromptText(item.title || "");
  if (title && !isGenericGeneratedTitle(title)) return title;
  return "";
}

export function galleryPromptPreview(text = "", wordLimit = 10) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "Generated media";
  const limit = Math.max(1, Number(wordLimit || 10) || 10);
  return words.length > limit ? `${words.slice(0, limit).join(" ")}...` : words.join(" ");
}
