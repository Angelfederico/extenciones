const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);
const NON_ACCESS_SUBSCRIPTION_STATUSES = new Set([
  "canceled",
  "cancelled",
  "incomplete",
  "incomplete_expired",
  "paused",
  "unpaid"
]);
const BILLING_HEALTH_VALUES = new Set([
  "ok",
  "billing_ok",
  "billing_grace_past_due",
  "stripe_active_supabase_inactive",
  "supabase_active_extension_free",
  "missing_customer_mapping",
  "webhook_failed",
  "stale_cached_free_refresh_required",
  "stale_cached_free_refreshed_to_pro",
  "stale_cached_free_refresh_failed",
  "stale_cached_pro_rejected",
  "unknown_no_backend_proof",
  "unknown"
]);

function firstString(values = []) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function normalizeStatus(value = "") {
  return String(value || "").trim().toLowerCase();
}

function currentTimeMs() {
  return Date.now();
}

function timestampMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 100000000000 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function numericValue(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function firstNumeric(values = [], fallback = null) {
  for (const value of values) {
    const number = numericValue(value, null);
    if (number !== null) return number;
  }
  return fallback;
}

function usageFromLicense(license = {}) {
  const usage = license.usage && typeof license.usage === "object" ? license.usage : {};
  const limit = Math.max(0, firstNumeric([
    license.prompt_limit,
    license.promptLimit,
    usage.limit
  ], 10));
  const used = Math.max(0, firstNumeric([
    license.prompts_today,
    license.promptsToday,
    usage.used
  ], 0));
  const explicitRemaining = firstNumeric([
    license.remaining,
    license.prompts_remaining,
    license.promptsRemaining,
    license.promptRemaining,
    usage.remaining
  ], null);
  const remaining = Math.max(0, explicitRemaining === null ? limit - used : explicitRemaining);
  return { limit, used, remaining };
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function truthyFlag(value) {
  if (value === true) return true;
  const text = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "revoked", "inactive"].includes(text);
}

function hasRevokedOrInactiveGrant(license = {}) {
  if ([
    license.revoked,
    license.inactive,
    license.access_revoked,
    license.accessRevoked,
    license.entitlement_revoked,
    license.entitlementRevoked,
    license.grant_revoked,
    license.grantRevoked
  ].some(truthyFlag)) {
    return true;
  }
  return ["revoked", "inactive", "disabled"].includes(normalizeStatus(firstString([
    license.grant_status,
    license.grantStatus,
    license.entitlement_status,
    license.entitlementStatus
  ])));
}

function manualGrantKind(rawPlan, license = {}) {
  const grantType = normalizeStatus(firstString([
    license.grant_type,
    license.grantType,
    license.entitlement_type,
    license.entitlementType,
    license.plan_type,
    license.planType
  ]));
  if (["manual", "lifetime", "admin", "team", "enterprise"].includes(rawPlan)) return rawPlan;
  if (["manual", "lifetime", "admin", "team", "enterprise"].includes(grantType)) return grantType;
  if (license.lifetime === true || license.lifetimePro === true) return "lifetime";
  if (license.manual === true || license.manualPro === true) return "manual";
  if (license.admin === true || license.adminPro === true) return "admin";
  if (license.unlimited === true) return "manual";
  return "";
}

function currentPeriodEndFromLicense(license = {}) {
  return license.current_period_end || license.currentPeriodEnd || null;
}

function currentPeriodEndIsFuture(license = {}, nowMs = currentTimeMs()) {
  const endMs = timestampMs(currentPeriodEndFromLicense(license));
  return endMs !== null && endMs > nowMs;
}

export function subscriptionStatusFromLicense(license = {}) {
  return normalizeStatus(firstString([
    license.subscription_status,
    license.subscriptionStatus,
    license.stripe_subscription_status,
    license.stripeSubscriptionStatus
  ]));
}

export function isActiveSubscriptionStatus(status = "") {
  return ACTIVE_SUBSCRIPTION_STATUSES.has(normalizeStatus(status));
}

export function isNonAccessSubscriptionStatus(status = "") {
  return NON_ACCESS_SUBSCRIPTION_STATUSES.has(normalizeStatus(status));
}

export function deriveBillingAccountState(auth = {}) {
  const license = auth?.license && typeof auth.license === "object" ? auth.license : {};
  const signedIn = auth?.signedIn === true || Boolean(auth?.email || license.email || license.user_id || license.userId);
  const rawPlan = String(auth?.tier || license.tier || license.plan || "free").trim().toLowerCase() || "free";
  const nowMs = Number.isFinite(Number(auth?.nowMs)) ? Number(auth.nowMs) : currentTimeMs();
  const subscriptionStatus = subscriptionStatusFromLicense(license);
  const hasSubscriptionStatus = Boolean(subscriptionStatus);
  const activeSubscription = isActiveSubscriptionStatus(subscriptionStatus);
  const pastDueGrace = subscriptionStatus === "past_due" && currentPeriodEndIsFuture(license, nowMs);
  const nonAccessSubscription = isNonAccessSubscriptionStatus(subscriptionStatus);
  const revokedGrant = hasRevokedOrInactiveGrant(license);
  const manualGrant = manualGrantKind(rawPlan, license);
  const teamAccess = ["team", "enterprise", "admin"].includes(rawPlan) || ["team", "enterprise", "admin"].includes(manualGrant);
  const proWithoutStatus = rawPlan === "pro" && !hasSubscriptionStatus;
  const manualOrLifetimeAccess = Boolean(manualGrant) && !revokedGrant;
  const paidSubscriptionAccess = activeSubscription || pastDueGrace;
  const hasProAccess = signedIn && !revokedGrant && (
    paidSubscriptionAccess ||
      manualOrLifetimeAccess ||
      proWithoutStatus
  );
  const usage = usageFromLicense(license);
  const plan = hasProAccess ? (teamAccess ? "team" : "pro") : "free";
  const usageAllowed = signedIn && (hasProAccess || usage.remaining > 0);
  const stripeStatus = normalizeStatus(firstString([
    license.stripe_subscription_status,
    license.stripeSubscriptionStatus
  ]));
  const supabaseStatus = normalizeStatus(firstString([
    license.subscription_status,
    license.subscriptionStatus
  ]));
  const accountState = {
    status: signedIn ? "signed_in" : "signed_out",
    email: auth.email || license.email || null,
    userId: license.user_id || license.userId || null,
    plan,
    rawPlan,
    subscriptionStatus: subscriptionStatus || (hasProAccess ? "active" : "inactive"),
    stripeSubscriptionStatus: stripeStatus || null,
    supabaseSubscriptionStatus: supabaseStatus || null,
    currentPeriodEnd: license.current_period_end || license.currentPeriodEnd || null,
    cancelAtPeriodEnd: license.cancel_at_period_end ?? license.cancelAtPeriodEnd ?? null,
    usage: {
      allowed: usageAllowed,
      unlimited: hasProAccess,
      ...usage,
      resetAt: license.reset_at || license.resetAt || null
    },
    hasProAccess,
    hasActiveSubscription: paidSubscriptionAccess || proWithoutStatus || teamAccess || manualOrLifetimeAccess,
    billingWarning: pastDueGrace ? "past_due_grace" : null,
    billingHealth: "unknown",
    billing: {
      health: "unknown",
      lastWebhookEventAt: license.last_webhook_event_at || license.lastWebhookEventAt || null,
      lastBillingSyncAt: license.last_billing_sync_at || license.lastBillingSyncAt || null,
      stripeCustomerMapped: hasCustomerMapping(license),
      mismatchReason: null
    }
  };
  accountState.billingHealth = deriveBillingHealth(accountState, license, signedIn);
  accountState.billing = {
    ...accountState.billing,
    health: accountState.billingHealth,
    mismatchReason: accountState.billingHealth === "billing_ok" ? null : accountState.billingHealth
  };
  return accountState;
}

function hasCustomerMapping(license = {}) {
  const customerId = firstString([
    license.stripe_customer_id,
    license.stripeCustomerId,
    license.customer_id,
    license.customerId
  ]);
  if (customerId) return true;
  const hasExplicitCustomerField = [
    "stripe_customer_id",
    "stripeCustomerId",
    "customer_id",
    "customerId"
  ].some((key) => hasOwn(license, key));
  return hasExplicitCustomerField ? false : null;
}

function deriveBillingHealth(accountState, license = {}, signedIn = false) {
  const serverHealth = normalizeStatus(firstString([license.billingHealth, license.billing_health]));
  if (serverHealth === "ok") return "billing_ok";
  if (BILLING_HEALTH_VALUES.has(serverHealth)) return serverHealth;
  if (!signedIn) return "unknown_no_backend_proof";
  if (
    license.source === "cache" &&
    accountState.rawPlan === "free" &&
    !accountState.usage.unlimited &&
    Number(accountState.usage.remaining || 0) <= 0
  ) {
    return "stale_cached_free_refresh_required";
  }
  if (
    license.source === "cache" &&
    !accountState.usage.unlimited &&
    (accountState.rawPlan === "pro" || license.unlimited === true)
  ) {
    return "stale_cached_pro_rejected";
  }
  if (license.webhook_failed === true || license.webhookFailed === true || firstString([
    license.last_webhook_error,
    license.lastWebhookError
  ])) {
    return "webhook_failed";
  }
  const stripeStatus = accountState.stripeSubscriptionStatus || "";
  const supabaseStatus = accountState.supabaseSubscriptionStatus || "";
  if (
    accountState.billingWarning === "past_due_grace"
  ) {
    return "billing_grace_past_due";
  }
  if (isActiveSubscriptionStatus(stripeStatus) && supabaseStatus && !isActiveSubscriptionStatus(supabaseStatus)) {
    return "stripe_active_supabase_inactive";
  }
  if (isActiveSubscriptionStatus(supabaseStatus) && accountState.billing.stripeCustomerMapped === false) {
    return "missing_customer_mapping";
  }
  if (isActiveSubscriptionStatus(supabaseStatus) && (!accountState.usage.allowed || !accountState.usage.unlimited)) {
    return "supabase_active_extension_free";
  }
  const hasBackendBillingProof = Boolean(
    stripeStatus ||
      supabaseStatus ||
      accountState.rawPlan !== "free" ||
      license.unlimited === true ||
      accountState.billing.stripeCustomerMapped !== null ||
      accountState.billing.lastWebhookEventAt ||
      accountState.billing.lastBillingSyncAt
  );
  return hasBackendBillingProof ? "billing_ok" : "unknown_no_backend_proof";
}
