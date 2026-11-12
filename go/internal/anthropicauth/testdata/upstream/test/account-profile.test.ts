import assert from "node:assert/strict";
import { describe, onTestFinished, test, vi } from "vitest";
import {
  type AccountProfile,
  lookupProviderAccount,
  type ProviderCredentials,
} from "#src/account-profile";

const OAUTH_TOKEN = "sk-ant-oat01-example-access-token";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

/** The shape `GET /api/oauth/profile` returned live (Issue #80), trimmed. */
const PROFILE_BODY = {
  account: {
    uuid: "account-uuid",
    full_name: "Example Person",
    email: "person@example.com",
    has_claude_max: true,
    has_claude_pro: false,
  },
  organization: {
    uuid: "org-uuid",
    name: "person@example.com's Organization",
    organization_type: "claude_max",
    billing_type: "stripe_subscription",
    rate_limit_tier: "default_claude_max_20x",
    seat_tier: null,
    has_extra_usage_enabled: false,
    subscription_status: "active",
  },
  application: { uuid: "app-uuid", name: "Claude Code", slug: "claude-code" },
};

const PARSED_PROFILE: AccountProfile = {
  organizationType: "claude_max",
  rateLimitTier: "default_claude_max_20x",
  seatTier: null,
  subscriptionStatus: "active",
  hasExtraUsageEnabled: false,
  email: "person@example.com",
  organizationName: "person@example.com's Organization",
};

function credentials(apiKey: string | undefined) {
  const getApiKeyForProvider = vi.fn(
    (_provider: string): Promise<string | undefined> => Promise.resolve(apiKey),
  );
  return { getApiKeyForProvider } satisfies ProviderCredentials;
}

function stubFetch(
  implementation: (input: string, init?: RequestInit) => Promise<Response>,
) {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal("fetch", fetchMock);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return fetchMock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("lookupProviderAccount", () => {
  describe("credential gate", () => {
    test("reports no OAuth login when the provider has no credential", async () => {
      const fetchMock = stubFetch(() => Promise.resolve(jsonResponse({})));
      const result = await lookupProviderAccount(
        "anthropic",
        credentials(undefined),
      );
      assert.deepEqual(result, { kind: "not-oauth" });
      assert.equal(fetchMock.mock.calls.length, 0);
    });

    test("reports no OAuth login for an API key, without a request", async () => {
      const fetchMock = stubFetch(() => Promise.resolve(jsonResponse({})));
      const result = await lookupProviderAccount(
        "anthropic",
        credentials("sk-ant-api03-example"),
      );
      assert.deepEqual(result, { kind: "not-oauth" });
      assert.equal(fetchMock.mock.calls.length, 0);
    });

    test("reads the credential of the provider it was asked about", async () => {
      stubFetch(() => Promise.resolve(jsonResponse(PROFILE_BODY)));
      const creds = credentials(OAUTH_TOKEN);
      await lookupProviderAccount("anthropic-2", creds);
      assert.deepEqual(creds.getApiKeyForProvider.mock.calls, [
        ["anthropic-2"],
      ]);
    });
  });

  describe("profile request", () => {
    test("sends the OAuth token and beta header to the profile endpoint, with a timeout signal", async () => {
      const fetchMock = stubFetch(() =>
        Promise.resolve(jsonResponse(PROFILE_BODY)),
      );
      await lookupProviderAccount("anthropic", credentials(OAUTH_TOKEN));

      assert.equal(fetchMock.mock.calls.length, 1);
      const [url, init] = fetchMock.mock.calls[0];
      assert.equal(url, PROFILE_URL);
      assert.ok(init, "the request must carry init options");
      assert.deepEqual(init.headers, {
        Authorization: `Bearer ${OAUTH_TOKEN}`,
        "anthropic-beta": "oauth-2025-04-20",
      });
      assert.ok(init.signal instanceof AbortSignal);
    });
  });

  describe("successful profile", () => {
    test("parses the plan and identity fields", async () => {
      stubFetch(() => Promise.resolve(jsonResponse(PROFILE_BODY)));
      const result = await lookupProviderAccount(
        "anthropic",
        credentials(OAUTH_TOKEN),
      );
      assert.deepEqual(result, { kind: "profile", profile: PARSED_PROFILE });
    });

    test("nulls each field that is missing or has the wrong type", async () => {
      stubFetch(() =>
        Promise.resolve(
          jsonResponse({
            account: { email: 42 },
            organization: {
              organization_type: "claude_team",
              has_extra_usage_enabled: "yes",
            },
          }),
        ),
      );
      const result = await lookupProviderAccount(
        "anthropic",
        credentials(OAUTH_TOKEN),
      );
      assert.deepEqual(result, {
        kind: "profile",
        profile: {
          organizationType: "claude_team",
          rateLimitTier: null,
          seatTier: null,
          subscriptionStatus: null,
          hasExtraUsageEnabled: null,
          email: null,
          organizationName: null,
        },
      });
    });
  });

  describe("unavailable profile", () => {
    test("reports the HTTP status of a non-2xx response", async () => {
      stubFetch(() =>
        Promise.resolve(
          jsonResponse({ type: "error", error: { type: "x" } }, 401),
        ),
      );
      const result = await lookupProviderAccount(
        "anthropic",
        credentials(OAUTH_TOKEN),
      );
      assert.deepEqual(result, { kind: "unavailable", reason: "HTTP 401" });
    });

    test("reports a timeout when the request is aborted by its deadline", async () => {
      stubFetch(() =>
        Promise.reject(
          new DOMException("The operation timed out.", "TimeoutError"),
        ),
      );
      const result = await lookupProviderAccount(
        "anthropic",
        credentials(OAUTH_TOKEN),
      );
      assert.deepEqual(result, { kind: "unavailable", reason: "timeout" });
    });

    test("reports the error message when the request fails", async () => {
      stubFetch(() => Promise.reject(new TypeError("fetch failed")));
      const result = await lookupProviderAccount(
        "anthropic",
        credentials(OAUTH_TOKEN),
      );
      assert.deepEqual(result, {
        kind: "unavailable",
        reason: "fetch failed",
      });
    });

    test("reports an unexpected response when the body is not a JSON object", async () => {
      stubFetch(() => Promise.resolve(new Response("<html>", { status: 200 })));
      const result = await lookupProviderAccount(
        "anthropic",
        credentials(OAUTH_TOKEN),
      );
      assert.deepEqual(result, {
        kind: "unavailable",
        reason: "unexpected response",
      });
    });

    test("reports an unexpected response when the body is a JSON array", async () => {
      stubFetch(() => Promise.resolve(jsonResponse([])));
      const result = await lookupProviderAccount(
        "anthropic",
        credentials(OAUTH_TOKEN),
      );
      assert.deepEqual(result, {
        kind: "unavailable",
        reason: "unexpected response",
      });
    });
  });
});
