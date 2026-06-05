export const SUPABASE_URL = "https://yhcobtwwwhidignoifbg.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InloY29idHd3d2hpZGlnbm9pZmJnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzNjcyNTQsImV4cCI6MjA4NTk0MzI1NH0.d757ILAt7f3MAKxLZ0tm8CNKapItd3AUAFOPDzBR4O8";
export const CHECK_LICENSE_URL = `${SUPABASE_URL}/functions/v1/check-license`;
export const LICENSE_CACHE_KEY = "autoflow_license_cache";
export const AUTH_TOKEN_KEY = "autoflow_auth_token";
export const RATE_LIMIT_KEY = "autoflow_rate_limits";
export const CHECKOUT_LOCK_KEY = "autoflow_checkout_lock";
export const CHECKOUT_LAST_KEY = "autoflow_checkout_last";

const CACHE_TTL_MS = 5 * 60 * 1000;
const FEATURE_CACHE_TTL_MS = 60 * 1000;
const MAGIC_LINK_MAX_PER_WINDOW = 3;
const MAGIC_LINK_WINDOW_MS = 90 * 1000;
const CHECKOUT_LOCK_TTL_MS = 20 * 1000;
const CHECKOUT_REUSE_TTL_MS = 3 * 60 * 1000;
const ACTIVE_PRO_GRACE_MS = 60 * 60 * 1000;
const HMAC_SALT = "af_cache_integrity_v1";

export function createChromeStorageAdapter() {
  return {
    get(keys) {
      return chrome.storage.local.get(keys);
    },
    set(values) {
      return chrome.storage.local.set(values);
    },
    remove(keys) {
      return chrome.storage.local.remove(keys);
    }
  };
}

export function defaultLicenseData(extra = {}) {
  return {
    tier: "free",
    prompts_today: 0,
    prompt_limit: 10,
    max_resolution: "1k",
    ...extra
  };
}

function normalizeEmail(email = "") {
  return String(email || "").trim().toLowerCase();
}

function normalizeStorageKeys(keys) {
  return Array.isArray(keys) ? keys : [keys];
}

function randomRequestId(now) {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return `chk_${now}_${Math.random().toString(36).slice(2, 10)}`;
}

function decodeJwtDiagnostics(token = "") {
  const raw = String(token || "").trim();
  if (!raw) {
    return {
      tokenProjectRef: "",
      userIdPrefix: "",
      issuer: "",
      audience: "",
      emailHint: ""
    };
  }
  try {
    const [, payload] = raw.split(".");
    if (!payload) throw new Error("missing_payload");
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    const json = JSON.parse(atob(padded));
    const issuer = String(json.iss || "").trim();
    const issuerMatch = issuer.match(/https:\/\/([^.]+)\.supabase\.co/i);
    const userId = String(json.sub || "").trim();
    const email = normalizeEmail(json.email);
    return {
      tokenProjectRef: String(issuerMatch?.[1] || "").trim(),
      userIdPrefix: userId ? userId.slice(0, 8) : "",
      issuer,
      audience: String(json.aud || "").trim(),
      emailHint: email ? email.replace(/^(.{2}).*(@.*)$/, "$1***$2") : ""
    };
  } catch {
    return {
      tokenProjectRef: "",
      userIdPrefix: "",
      issuer: "",
      audience: "",
      emailHint: ""
    };
  }
}

function normalizeRuntimeCapabilities(data = {}) {
  const raw = data && typeof data === "object" ? data : null;
  if (!raw) return null;
  const normalized = {};
  const containers = [
    raw.capabilities,
    raw.runtime_capabilities,
    raw.runtimeCapabilities,
    raw.feature_flags,
    raw.featureFlags
  ];
  for (const container of containers) {
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    for (const [key, value] of Object.entries(container)) {
      normalized[String(key)] = value === true;
    }
  }
  return Object.keys(normalized).length ? normalized : null;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeCachePayload(value = {}) {
  return JSON.parse(stableJson(value && typeof value === "object" ? value : {}));
}

export function createLicenseClient({
  fetchImpl = fetch,
  storage = createChromeStorageAdapter(),
  now = () => Date.now(),
  cryptoImpl = globalThis.crypto,
  runtimeIdProvider = () => chrome.runtime.id,
  buildInfoProvider = () => {
    const manifest = chrome.runtime.getManifest?.() || {};
    const version = String(manifest.version || "unknown").trim() || "unknown";
    const versionName = String(manifest.version_name || "").trim();
    return {
      buildId: versionName || version,
      version,
      versionName,
      extensionId: String(chrome.runtime.id || "").trim()
    };
  },
  environmentProvider = () => ({
    userAgent: globalThis.navigator?.userAgent || "",
    screen: {
      width: globalThis.screen?.width || 0,
      height: globalThis.screen?.height || 0
    }
  }),
  openTab = async (url) => chrome.tabs.create({ url }),
  featureRetryDelayMs = 2000
} = {}) {
  const featureValidationCache = new Map();
  let runtimeCapabilityCache = { value: null, at: 0 };
  let checkoutRequestPromise = null;

  async function getStoredAuth() {
    const stored = await storage.get(AUTH_TOKEN_KEY);
    return stored?.[AUTH_TOKEN_KEY] || null;
  }

  async function clearLicenseCache() {
    await storage.remove(LICENSE_CACHE_KEY);
    runtimeCapabilityCache = { value: null, at: 0 };
  }

  async function digestHex(text) {
    const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function hmacHex(payload) {
    try {
      const runtimeId = String(runtimeIdProvider() || "");
      const keyData = new TextEncoder().encode(runtimeId + HMAC_SALT);
      const key = await cryptoImpl.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const signature = await cryptoImpl.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(stableJson(payload))
      );
      return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      return null;
    }
  }

  async function writeLicenseCache(data) {
    const payload = normalizeCachePayload({ ...data, cached_at: now() });
    const hmac = await hmacHex(payload);
    await storage.set({ [LICENSE_CACHE_KEY]: { payload, hmac } });
  }

  async function getCachedLicense(ignoreExpiry = false) {
    const stored = await storage.get(LICENSE_CACHE_KEY);
    const cached = stored?.[LICENSE_CACHE_KEY];
    if (!cached) return null;
    if (!cached.payload) {
      await storage.remove(LICENSE_CACHE_KEY);
      return null;
    }
    const normalizedPayload = normalizeCachePayload(cached.payload);
    const hmac = await hmacHex(normalizedPayload);
    if (!hmac || hmac !== cached.hmac) {
      await storage.remove(LICENSE_CACHE_KEY);
      return null;
    }
    if (!ignoreExpiry && now() - Number(normalizedPayload.cached_at || 0) > CACHE_TTL_MS) return null;
    return normalizedPayload;
  }

  async function getCachedActiveProLicense(options = {}) {
    const maxAgeMs = Number(options.maxAgeMs || ACTIVE_PRO_GRACE_MS);
    const cached = await getCachedLicense(true);
    if (!cached) return { ok: false, reason: "missing_verified_license_cache" };
    const ageMs = Math.max(0, now() - Number(cached.cached_at || 0));
    if (ageMs > maxAgeMs) return { ok: false, reason: "verified_license_cache_expired", ageMs };
    const tier = String(cached.tier || "").toLowerCase();
    const subscriptionStatus = String(
      cached.subscription_status ||
        cached.subscriptionStatus ||
        cached.stripe_subscription_status ||
        cached.stripeSubscriptionStatus ||
        ""
    ).toLowerCase();
    const active = tier === "pro" || ["active", "trialing"].includes(subscriptionStatus);
    if (!active) return { ok: false, reason: "cached_license_not_active_pro", ageMs, tier, subscriptionStatus };
    return {
      ok: true,
      source: "verified_license_cache",
      ageMs,
      tier: tier || "pro",
      subscriptionStatus,
      email: normalizeEmail(cached.email || "")
    };
  }

  async function checkRateLimit(action, maxPerWindow, windowMs, scope = "global") {
    const stored = await storage.get(RATE_LIMIT_KEY);
    const limits = stored?.[RATE_LIMIT_KEY] || {};
    const key = `${action}:${scope}`;
    const current = now();
    const history = (limits[key] || []).filter((timestamp) => current - timestamp < windowMs);
    if (history.length >= maxPerWindow) {
      const waitSec = Math.ceil((history[0] + windowMs - current) / 1000);
      throw new Error(`Too many attempts. Try again in ${waitSec}s.`);
    }
    history.push(current);
    limits[key] = history;
    await storage.set({ [RATE_LIMIT_KEY]: limits });
  }

  async function getDeviceFingerprint() {
    const env = environmentProvider() || {};
    const screenInfo = env.screen || {};
    const raw = `${runtimeIdProvider()}-${env.userAgent || ""}-${screenInfo.width || 0}x${screenInfo.height || 0}`;
    return digestHex(raw);
  }

  async function signInWithMagicLink(email) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) throw new Error("Enter your email first.");
    await checkRateLimit(
      "magic_link",
      MAGIC_LINK_MAX_PER_WINDOW,
      MAGIC_LINK_WINDOW_MS,
      normalizedEmail
    );
    const response = await fetchImpl(`${SUPABASE_URL}/auth/v1/otp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ email: normalizedEmail })
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const retryAfter = Number.parseInt(response.headers?.get?.("retry-after") || "", 10);
      const msg = String(error.msg || error.error_description || error.error || "").trim();
      if (response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
        throw new Error(`Too many attempts. Try again in ${retryAfter}s.`);
      }
      throw new Error(msg || "Failed to send magic link");
    }
    return true;
  }

  async function verifyOtpToken(email, token) {
    const response = await fetchImpl(`${SUPABASE_URL}/auth/v1/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        email: normalizeEmail(email),
        token: String(token || "").trim(),
        type: "email",
        gotrue_meta_security: {}
      })
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.msg || error.error_description || "Invalid or expired code");
    }
    const data = await response.json();
    await clearLicenseCache();
    await storage.set({
      [AUTH_TOKEN_KEY]: {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: now() + Number(data.expires_in || 0) * 1000,
        email: normalizeEmail(email)
      }
    });
    return data;
  }

  async function resolveAccessToken(options = {}) {
    const forceRefresh = options?.forceRefresh === true;
    const auth = await getStoredAuth();
    if (!auth) {
      return {
        token: null,
        authState: "missing_auth",
        refreshAttempted: false,
        refreshSucceeded: false,
        expiresInMs: 0
      };
    }

    const expiresInMs = Math.max(0, Number(auth.expires_at || 0) - now());
    if (!forceRefresh && Number(auth.expires_at || 0) > now() + 60000) {
      return {
        token: auth.access_token,
        authState: "cached_access_token",
        refreshAttempted: false,
        refreshSucceeded: false,
        expiresInMs,
        email: normalizeEmail(auth.email),
        ...decodeJwtDiagnostics(auth.access_token)
      };
    }

    try {
      const response = await fetchImpl(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ refresh_token: auth.refresh_token })
      });
      if (!response.ok) throw new Error("Refresh failed");
      const data = await response.json();
      const nextAuth = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: now() + Number(data.expires_in || 0) * 1000,
        email: normalizeEmail(auth.email)
      };
      await storage.set({ [AUTH_TOKEN_KEY]: nextAuth });
      return {
        token: data.access_token,
        authState: forceRefresh ? "forced_refresh_token" : "refreshed_access_token",
        refreshAttempted: true,
        refreshSucceeded: true,
        expiresInMs: Math.max(0, Number(nextAuth.expires_at || 0) - now()),
        email: normalizeEmail(auth.email),
        ...decodeJwtDiagnostics(data.access_token)
      };
    } catch {
      await storage.remove(AUTH_TOKEN_KEY);
      return {
        token: null,
        authState: "refresh_failed",
        refreshAttempted: true,
        refreshSucceeded: false,
        expiresInMs: 0
      };
    }
  }

  async function signOut() {
    await storage.remove([AUTH_TOKEN_KEY, LICENSE_CACHE_KEY]);
    runtimeCapabilityCache = { value: null, at: 0 };
  }

  async function checkLicense(action = "check", extraBody = {}) {
    let authMeta = await resolveAccessToken();
    let token = authMeta.token;

    if (!token) {
      if (action !== "check") {
        return {
          action,
          error: "not_signed_in",
          offline: true,
          authState: authMeta.authState
        };
      }
      return defaultLicenseData();
    }

    if (action === "check") {
      const cached = await getCachedLicense();
      if (cached) return { ...cached, source: "cache" };
    }

    if (action === "validate_feature" && extraBody?.feature_key) {
      const cached = featureValidationCache.get(extraBody.feature_key);
      if (cached && now() - cached.at < FEATURE_CACHE_TTL_MS) return cached.data;
    }

    const deviceHash = await getDeviceFingerprint();
    const requestBody = { action, device_hash: deviceHash, ...extraBody };
    const makeRequest = (bearerToken) => fetchImpl(CHECK_LICENSE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
        apikey: SUPABASE_ANON_KEY
      },
      body: JSON.stringify(requestBody)
    });

    try {
      let response = await makeRequest(token);
      if (!response.ok && response.status === 401) {
        authMeta = await resolveAccessToken({ forceRefresh: true });
        token = authMeta.token;
        if (token) response = await makeRequest(token);
      }

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 429) return data;
        throw new Error(data.error || "License check failed");
      }

      const payload = { ...data, authState: authMeta.authState };
      if (action === "check") await writeLicenseCache(payload);
      if (action === "validate_feature" && extraBody?.feature_key) {
        featureValidationCache.set(extraBody.feature_key, { data: payload, at: now() });
      }
      return payload;
    } catch (error) {
      if (action !== "check") {
        return {
          action,
          error: error?.message || "license_action_failed",
          offline: true,
          authState: authMeta?.authState
        };
      }
      const cached = await getCachedLicense(true);
      if (cached && now() - Number(cached.cached_at || 0) < 24 * 60 * 60 * 1000) {
        return { ...cached, offline: true };
      }
      return defaultLicenseData({ offline: true, error: String(error?.message || "license_check_failed") });
    }
  }

  async function validateFeatureAccess(featureKey, resourceContext = {}) {
    let serverResponded = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const data = await checkLicense("validate_feature", {
        feature_key: featureKey,
        resource_context: resourceContext
      });
      if (data?.error === "not_signed_in") {
        return { allowed: false, source: "auth", reason: "not_signed_in", authState: data.authState || "missing_auth" };
      }
      if (typeof data?.allowed === "boolean") return { ...data, source: "server" };
      if (!data?.offline) serverResponded = true;
      if (attempt === 0 && !serverResponded && featureRetryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, featureRetryDelayMs));
      }
    }
    if (serverResponded) {
      return {
        allowed: false,
        source: "server",
        reason: "missing_feature_decision"
      };
    }
    return {
      allowed: false,
      source: "fallback",
      reason: "server_unavailable"
    };
  }

  async function fetchRuntimeCapabilities(options = {}) {
    const force = options?.force === true;
    const requestedCapabilities = Array.isArray(options?.requestedCapabilities)
      ? [...new Set(options.requestedCapabilities.map((item) => String(item || "").trim()).filter(Boolean))]
      : [];
    const build = buildInfoProvider();
    if (!force && runtimeCapabilityCache.value && now() - runtimeCapabilityCache.at < FEATURE_CACHE_TTL_MS) {
      return {
        ok: true,
        source: "server_cache",
        build,
        capabilities: { ...runtimeCapabilityCache.value }
      };
    }
    const data = await checkLicense("runtime_capabilities", {
      build_id: build.buildId,
      version: build.version,
      version_name: build.versionName,
      extension_id: build.extensionId,
      requested_capabilities: requestedCapabilities
    });
    const capabilities = normalizeRuntimeCapabilities(data);
    if (!capabilities) {
      return {
        ok: false,
        source: data?.offline ? "fallback" : "server",
        reason: data?.error || "invalid_capability_response",
        build,
        capabilities: {}
      };
    }
    runtimeCapabilityCache = { value: capabilities, at: now() };
    return { ok: true, source: "server", build, capabilities: { ...capabilities } };
  }

  async function refreshLicense() {
    const token = await resolveAccessToken({ forceRefresh: false });
    if (!token.token) return defaultLicenseData();
    await storage.remove(LICENSE_CACHE_KEY);
    const data = await checkLicense("check");
    return data?.tier ? data : defaultLicenseData(data || {});
  }

  async function initLicense(options = {}) {
    const auth = await getStoredAuth();
    if (!auth?.email) return defaultLicenseData();
    const data = options?.forceFresh === true
      ? await refreshLicense()
      : await checkLicense("check");
    if (data.email === undefined) data.email = normalizeEmail(auth.email);
    return data;
  }

  async function createCheckout(options = {}) {
    const current = now();
    const requestId = String(options.clientRequestId || options.idempotencyKey || randomRequestId(current));
    const stored = await storage.get([CHECKOUT_LOCK_KEY, CHECKOUT_LAST_KEY]);
    const lock = stored?.[CHECKOUT_LOCK_KEY];
    const last = stored?.[CHECKOUT_LAST_KEY];
    if (lock?.at && current - Number(lock.at || 0) < CHECKOUT_LOCK_TTL_MS) {
      return { ok: false, error: "checkout_in_progress" };
    }
    if (last?.checkout_url && last?.at && current - Number(last.at || 0) < CHECKOUT_REUSE_TTL_MS) {
      return { ok: true, checkout_url: last.checkout_url, reused: true };
    }
    await storage.set({
      [CHECKOUT_LOCK_KEY]: {
        at: current,
        request_id: requestId,
        source: String(options.source || "sidepanel")
      }
    });
    try {
      const data = await checkLicense("create_checkout", {
        client_request_id: requestId,
        idempotency_key: requestId,
        request_source: String(options.source || "sidepanel")
      });
      if (data.checkout_url) {
        await storage.set({
          [CHECKOUT_LAST_KEY]: {
            checkout_url: data.checkout_url,
            at: now(),
            request_id: requestId,
            source: String(options.source || "sidepanel")
          }
        });
        return { ok: true, checkout_url: data.checkout_url };
      }
      return { ok: false, error: data.error || "missing_checkout_url" };
    } finally {
      await storage.remove(CHECKOUT_LOCK_KEY);
    }
  }

  async function startUpgradeFlow(options = {}) {
    if (checkoutRequestPromise) return checkoutRequestPromise;
    checkoutRequestPromise = (async () => {
      const result = await createCheckout(options);
      if (result.checkout_url) await openTab(result.checkout_url);
      return result;
    })();
    try {
      return await checkoutRequestPromise;
    } finally {
      checkoutRequestPromise = null;
    }
  }

  async function openManageSubscription() {
    const data = await checkLicense("create_portal");
    if (data.portal_url) {
      await openTab(data.portal_url);
      return { ok: true, portal_url: data.portal_url };
    }
    return { ok: false, error: data.error || "missing_portal_url" };
  }

  async function authSummary(data = null) {
    const auth = await getStoredAuth();
    const license = data || await initLicense();
    const tier = String(license?.tier || "free").toLowerCase();
    const subStatus = String(
      license?.subscription_status ||
        license?.subscriptionStatus ||
        license?.stripe_subscription_status ||
        license?.stripeSubscriptionStatus ||
        ""
    ).toLowerCase();
    return {
      signedIn: Boolean(auth?.email || license?.email),
      email: normalizeEmail(license?.email || auth?.email || ""),
      tier,
      license,
      hasActiveSubscription:
        tier === "pro" ||
        ["active", "trialing", "past_due", "incomplete", "unpaid"].includes(subStatus)
    };
  }

  return {
    getDeviceFingerprint,
    signInWithMagicLink,
    verifyOtpToken,
    resolveAccessToken,
    signOut,
    checkLicense,
    validateFeatureAccess,
    getCachedActiveProLicense,
    fetchRuntimeCapabilities,
    refreshLicense,
    initLicense,
    createCheckout,
    startUpgradeFlow,
    openManageSubscription,
    authSummary
  };
}
