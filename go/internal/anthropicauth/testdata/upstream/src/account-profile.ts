import { isAnthropicOAuthToken } from "./oauth-transport";

/**
 * Claude Code's account profile endpoint.  It answers an OAuth bearer token
 * with the account and organization behind it; an API key gets a 401
 * (measured live, Issue #80).
 */
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const OAUTH_BETA = "oauth-2025-04-20";
const PROFILE_TIMEOUT_MS = 5000;

/**
 * The fields of the profile response the status report shows.  Every field is
 * `null` when the response omits it or gives it an unexpected type, because
 * the endpoint is undocumented.
 */
export interface AccountProfile {
  organizationType: string | null;
  rateLimitTier: string | null;
  seatTier: string | null;
  subscriptionStatus: string | null;
  hasExtraUsageEnabled: boolean | null;
  /** Identifying: shown only on request. */
  email: string | null;
  /** Identifying: a personal organization is named after the account email. */
  organizationName: string | null;
}

export type AccountLookup =
  | { kind: "not-oauth" }
  | { kind: "unavailable"; reason: string }
  | { kind: "profile"; profile: AccountProfile };

/**
 * The one `ModelRegistry` method the lookup reads.  Pi refreshes an OAuth
 * token that is about to expire before returning it.
 */
export interface ProviderCredentials {
  getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

/**
 * Looks up the Anthropic account behind a provider's stored OAuth login.
 * Never throws: a provider without an OAuth token is `not-oauth` (and no
 * request is made), and every request failure is `unavailable`.
 */
export async function lookupProviderAccount(
  provider: string,
  credentials: ProviderCredentials,
): Promise<AccountLookup> {
  const token = await credentials.getApiKeyForProvider(provider);
  if (!isAnthropicOAuthToken(token)) {
    return { kind: "not-oauth" };
  }
  try {
    const response = await fetch(PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
      },
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { kind: "unavailable", reason: `HTTP ${response.status}` };
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!isRecord(body)) {
      return { kind: "unavailable", reason: "unexpected response" };
    }
    return { kind: "profile", profile: parseProfile(body) };
  } catch (error) {
    return { kind: "unavailable", reason: describeFailure(error) };
  }
}

function parseProfile(body: Record<string, unknown>): AccountProfile {
  const account = recordAt(body, "account");
  const organization = recordAt(body, "organization");
  return {
    organizationType: stringAt(organization, "organization_type"),
    rateLimitTier: stringAt(organization, "rate_limit_tier"),
    seatTier: stringAt(organization, "seat_tier"),
    subscriptionStatus: stringAt(organization, "subscription_status"),
    hasExtraUsageEnabled: booleanAt(organization, "has_extra_usage_enabled"),
    email: stringAt(account, "email"),
    organizationName: stringAt(organization, "name"),
  };
}

function describeFailure(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = source[key];
  return isRecord(value) ? value : {};
}

function stringAt(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function booleanAt(
  source: Record<string, unknown>,
  key: string,
): boolean | null {
  const value = source[key];
  return typeof value === "boolean" ? value : null;
}
