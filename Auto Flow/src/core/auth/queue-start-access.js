import { deriveBillingAccountState } from "./billing-state.js";

export function queueStartAccessFromAuthSummary(auth = {}) {
  const license = auth?.license && typeof auth.license === "object" ? auth.license : {};
  const account = deriveBillingAccountState(auth);
  const tier = account.rawPlan || account.plan || "free";
  const signedIn = account.status === "signed_in";
  const usage = account.usage || {};

  if (!signedIn) {
    return {
      allowed: false,
      source: "auth_summary",
      reason: "not_signed_in",
      error: "not_signed_in",
      signedIn: false,
      tier,
      usage: { ...usage, unlimited: false }
    };
  }

  const unavailable = license.offline === true && license.source !== "cache" && !license.cached_at;
  if (unavailable) {
    return {
      allowed: false,
      source: "auth_summary",
      reason: "license_check_unavailable",
      error: "license_check_unavailable",
      signedIn: true,
      tier,
      usage: { ...usage, unlimited: false },
      billingHealth: account.billingHealth,
      subscriptionStatus: account.subscriptionStatus
    };
  }

  if (account.hasProAccess) {
    return {
      allowed: true,
      source: "auth_summary",
      reason: "pro_access",
      signedIn: true,
      tier,
      usage: { ...usage, unlimited: true },
      billingHealth: account.billingHealth,
      subscriptionStatus: account.subscriptionStatus,
      billingWarning: account.billingWarning || null
    };
  }

  if (usage.remaining > 0) {
    return {
      allowed: true,
      source: "auth_summary",
      reason: "free_quota_remaining",
      signedIn: true,
      tier,
      usage: { ...usage, unlimited: false },
      billingHealth: account.billingHealth,
      subscriptionStatus: account.subscriptionStatus
    };
  }

  return {
    allowed: false,
    source: "auth_summary",
    reason: "daily_limit_reached",
    error: "daily_limit_reached",
    signedIn: true,
    tier,
    usage: { ...usage, unlimited: false },
    billingHealth: account.billingHealth,
    subscriptionStatus: account.subscriptionStatus
  };
}

export function queueStartAccessNeedsFreshBackend(access = {}) {
  return ["daily_limit_reached", "license_check_unavailable"].includes(String(access.reason || access.error || ""));
}

export async function refreshQueueStartAccessBeforeBlock(blockedAccess = {}, refreshAuth) {
  if (!queueStartAccessNeedsFreshBackend(blockedAccess)) return blockedAccess;
  try {
    const auth = await refreshAuth();
    const refreshedAccess = queueStartAccessFromAuthSummary(auth);
    if (refreshedAccess.allowed) {
      return {
        ...refreshedAccess,
        source: "fresh_auth_summary",
        reason: refreshedAccess.usage?.unlimited
          ? "stale_cached_free_refreshed_to_pro"
          : refreshedAccess.reason,
        billingHealth: refreshedAccess.usage?.unlimited
          ? "stale_cached_free_refreshed_to_pro"
          : refreshedAccess.billingHealth
      };
    }
    if (refreshedAccess.reason === "license_check_unavailable") {
      return verifySubscriptionNeeded(blockedAccess, "stale_cached_free_refresh_failed");
    }
    return { ...refreshedAccess, source: "fresh_auth_summary" };
  } catch {
    return verifySubscriptionNeeded(blockedAccess, "stale_cached_free_refresh_failed");
  }
}

function verifySubscriptionNeeded(access = {}, billingHealth = "stale_cached_free_refresh_failed") {
  return {
    ...access,
    allowed: false,
    source: "fresh_auth_summary",
    reason: "verify_subscription_needed",
    error: "verify_subscription_needed",
    message: "Could not verify subscription",
    billingHealth
  };
}
