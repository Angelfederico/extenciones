const CURRENT_RUNTIME_KEY = "af_runtime_choice";
const CURRENT_RUNTIME_VERSION_KEY = "af_runtime_version";
const SHOW_LAUNCHER_KEY = "af_show_runtime_launcher";

const RUNTIMES = Object.freeze({
  current: {
    version: "10.8.8",
    path: "../sidepanel/index.html"
  },
  fallback1084: {
    version: "10.8.4",
    path: "../../fallbacks/10.8.4/src/sidepanel/index.html"
  }
});

async function launchRuntime(runtime) {
  await chrome.storage.local.set({
    [CURRENT_RUNTIME_KEY]: runtime.version === "10.8.8" ? "current" : runtime.version,
    [CURRENT_RUNTIME_VERSION_KEY]: runtime.version,
    [SHOW_LAUNCHER_KEY]: false
  }).catch(() => {});
  window.location.href = runtime.path;
}

async function redirectToPreferredRuntime() {
  const stored = await chrome.storage.local.get([
    CURRENT_RUNTIME_KEY,
    SHOW_LAUNCHER_KEY
  ]).catch(() => ({}));
  if (stored[SHOW_LAUNCHER_KEY] === true) return;
  const runtimeChoice = String(stored[CURRENT_RUNTIME_KEY] || "current");
  const runtime = runtimeChoice === "10.8.4" ? RUNTIMES.fallback1084 : RUNTIMES.current;
  window.location.replace(runtime.path);
}

document.getElementById("launch-current")?.addEventListener("click", () => {
  launchRuntime(RUNTIMES.current);
});

document.getElementById("launch-1084")?.addEventListener("click", () => {
  launchRuntime(RUNTIMES.fallback1084);
});

redirectToPreferredRuntime();
