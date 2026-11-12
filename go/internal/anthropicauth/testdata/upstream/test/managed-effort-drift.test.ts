import assert from "node:assert/strict";
import {
  type AssistantMessage,
  type Model,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { test } from "vitest";

import { BILLING_HEADER_MARKER } from "#src/billing-header";
import { createAnthropicOAuthStreamSimple } from "#src/oauth-transport";

// This suite drives the installed Pi's own Anthropic transport, the way
// `test/claude-code-version-drift.test.ts` does.  Depending on the internal
// *is* what it verifies; it is not a precedent for other suites.
//
// On models Pi flags `compat.supportsMidConvoEffort`, Pi pins the top-level
// `output_config.effort` to "high" and carries the requested effort in
// content-less `role: "system"` messages inside `messages[]`.  Our system
// message shaping once dropped every message it left empty, which removed all
// of them and silently ran every request at "high" (PR #79).

const OAUTH_TOKEN_STUB = "sk-ant-oat01-stub-token-for-drift-check";

type OutboundMessage = { role?: unknown; output_config?: unknown };
type OutboundBody = { system?: unknown; messages?: OutboundMessage[] };

// Every flagged model is driven, so a model a new Pi release adds is covered
// without a test edit (Issue #81).
const MANAGED_EFFORT_MODELS: Model<"anthropic-messages">[] = getBuiltinModels(
  "anthropic",
).filter((model) => model.compat?.supportsMidConvoEffort === true);

const MANAGED_EFFORT_CASES = MANAGED_EFFORT_MODELS.map(
  (model) => [model.id, model] as const,
);

/** A prior turn Pi recorded as answered at `"medium"` effort. */
function priorAssistantTurn(model: Model<"anthropic-messages">) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "First answer." }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    providerThinkingLevel: "medium",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } satisfies AssistantMessage;
}

/**
 * Captures the body Pi's transport would send, optionally through our OAuth
 * wrapper, for a follow-up turn requested at `"low"` effort.
 *
 * The request is aborted inside the injected `fetch`, so nothing leaves the
 * process.  The thrown error surfaces through the stream and is swallowed.
 */
async function captureOutboundBody(
  model: Model<"anthropic-messages">,
  { wrapped }: { wrapped: boolean },
): Promise<OutboundBody> {
  let body: OutboundBody = {};

  const capturingFetch = ((_input: unknown, init?: RequestInit) => {
    // Pi's transport serializes the payload itself, so the body is a string.
    body = JSON.parse(init?.body as string) as OutboundBody;
    return Promise.reject(new Error("drift check: aborted before network"));
  }) as typeof fetch;

  const piTransport = anthropicMessagesApi().streamSimple;
  const transport = wrapped
    ? createAnthropicOAuthStreamSimple(piTransport)
    : piTransport;

  const stream = transport(
    model,
    normalizeContext({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "First question." }],
          timestamp: Date.now(),
        },
        priorAssistantTurn(model),
        {
          role: "user",
          content: [{ type: "text", text: "Second question." }],
          timestamp: Date.now(),
        },
      ],
    }),
    {
      apiKey: OAUTH_TOKEN_STUB,
      fetch: capturingFetch,
      maxRetries: 0,
      reasoning: "low",
    },
  );

  try {
    await stream.result();
  } catch {
    // Expected: the capturing fetch rejects instead of reaching the network.
  }

  return body;
}

function effortMessages(body: OutboundBody): OutboundMessage[] {
  return (body.messages ?? []).filter(
    (message) =>
      message.role === "system" && message.output_config !== undefined,
  );
}

test("Pi's catalog still has a managed-effort Anthropic model", () => {
  // `test.each([])` runs no cases, so this is what fails if Pi drops the flag.
  assert.notDeepEqual(
    MANAGED_EFFORT_MODELS.map((model) => model.id),
    [],
    "No anthropic model sets compat.supportsMidConvoEffort; re-check how Pi carries per-message effort.",
  );
});

// If Pi moves effort back to the top level, the `output_config` keep rule in
// `shapeSystemRoleMessages` becomes dead code and should be removed.
test.each(MANAGED_EFFORT_CASES)(
  "Pi carries historical and active effort in content-less system messages (%s)",
  async (_id, model) => {
    const body = await captureOutboundBody(model, { wrapped: false });

    assert.deepEqual(effortMessages(body), [
      { role: "system", content: [], output_config: { effort: "medium" } },
      { role: "system", content: [], output_config: { effort: "low" } },
    ]);
  },
);

test.each(MANAGED_EFFORT_CASES)(
  "OAuth shaping keeps every effort message Pi sends (%s)",
  async (_id, model) => {
    const unshaped = await captureOutboundBody(model, { wrapped: false });
    const shaped = await captureOutboundBody(model, { wrapped: true });

    // Both guard against a vacuous pass: two empty lists compare equal, and an
    // unshaped "shaped" body would keep every message trivially.
    assert.notDeepEqual(effortMessages(unshaped), []);
    assert.match(
      JSON.stringify(shaped.system),
      new RegExp(BILLING_HEADER_MARKER),
    );

    assert.deepEqual(effortMessages(shaped), effortMessages(unshaped));
  },
);
