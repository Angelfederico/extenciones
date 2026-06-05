const DB_NAME = "autoflow-reference-blob-store";
const STORE_NAME = "reference_blobs";
const DB_VERSION = 1;

function hasIndexedDb() {
  return typeof indexedDB !== "undefined" && indexedDB?.open;
}

function openDatabase() {
  if (!hasIndexedDb()) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("reference_blob_store_open_failed"));
  });
}

function transaction(storeMode = "readonly") {
  return openDatabase().then((db) => {
    if (!db) return null;
    return db.transaction(STORE_NAME, storeMode).objectStore(STORE_NAME);
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("reference_blob_store_request_failed"));
  });
}

export async function putReferenceBlob(record = {}) {
  const store = await transaction("readwrite");
  if (!store) return "";
  const id = String(record.id || crypto.randomUUID()).trim();
  if (!id) return "";
  await requestToPromise(store.put({
    id,
    dataUrl: String(record.dataUrl || ""),
    mimeType: String(record.mimeType || "image/png"),
    fileName: String(record.fileName || "reference.png"),
    size: Number(record.size || 0),
    createdAt: String(record.createdAt || new Date().toISOString())
  }));
  return id;
}

export async function getReferenceBlob(id = "") {
  const key = String(id || "").trim();
  if (!key) return null;
  const store = await transaction("readonly");
  if (!store) return null;
  return await requestToPromise(store.get(key)) || null;
}

export async function deleteReferenceBlob(id = "") {
  const key = String(id || "").trim();
  if (!key) return false;
  const store = await transaction("readwrite");
  if (!store) return false;
  await requestToPromise(store.delete(key));
  return true;
}

export function base64FromDataUrl(value = "") {
  const text = String(value || "");
  return text.includes(",") ? text.split(",").pop() : text;
}

export function mimeTypeFromDataUrl(value = "") {
  const match = String(value || "").match(/^data:([^;,]+)/i);
  return match?.[1] ? String(match[1]).toLowerCase() : "";
}
