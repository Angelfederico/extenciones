export const MessageType = Object.freeze({
  BridgeHealth: "af.rebuild.bridge.health",
  BridgeHealthV2: "af.rebuild.bridge.health.v2",
  BridgeHealthV3: "af.rebuild.bridge.health.v3",
  BridgeHealthV4: "af.rebuild.bridge.health.v4",
  PageEvent: "af.rebuild.page.event",
  PageCommand: "af.rebuild.page.command",
  PageCommandV2: "af.rebuild.page.command.v2",
  PageCommandV3: "af.rebuild.page.command.v3",
  PageCommandV4: "af.rebuild.page.command.v4",
  PageCommandResult: "af.rebuild.page.command.result",
  QueueAddJob: "af.rebuild.queue.addJob",
  QueueStart: "af.rebuild.queue.start",
  QueueResume: "af.rebuild.queue.resume",
  QueueStop: "af.rebuild.queue.stop",
  QueueClear: "af.rebuild.queue.clear",
  QueueRemove: "af.rebuild.queue.remove",
  QueuePrune: "af.rebuild.queue.prune",
  MediaUpload: "af.rebuild.media.upload",
  MediaDownload: "af.rebuild.media.download",
  AuthCommand: "af.rebuild.auth.command",
  AuthState: "af.rebuild.auth.state",
  SettingsRead: "af.rebuild.settings.read",
  SettingsWrite: "af.rebuild.settings.write",
  GalleryRefresh: "af.rebuild.gallery.refresh"
});

export function createMessage(type, payload = {}, meta = {}) {
  if (!Object.values(MessageType).includes(type)) {
    throw new Error(`Unknown message type: ${type}`);
  }
  return {
    type,
    payload,
    meta: {
      createdAt: new Date().toISOString(),
      source: "autoflow-10767-rebuild",
      ...meta
    }
  };
}

export function isAutoFlowRebuildMessage(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      Object.values(MessageType).includes(value.type)
  );
}
