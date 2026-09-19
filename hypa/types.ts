/**
 * aio-hypa config/status types — vendored from @hypabolic/pi-hypa 0.1.15
 * (FSL-1.1-ALv2 — see LICENSE-FSL and UPSTREAM.md).
 */
export type HypaPiMode = "additive" | "replace";
export type AskNonInteractivePolicy = "deny" | "allow";

export type RewriteOutcome =
	| "Rewritten"
	| "GenericWrapper"
	| "Passthrough"
	| "Deny"
	| "Ask";

export interface RewriteResultV1 {
	schemaVersion?: 1;
	input: string;
	outcome: RewriteOutcome;
	command: string;
}

export type RewriteStatus =
	| { kind: "rewritten"; outcome: "Rewritten" | "GenericWrapper"; input: string; command: string }
	| { kind: "passthrough"; outcome: "Passthrough"; input: string; command: string }
	| { kind: "deny"; input: string; command: string; reason: string }
	| { kind: "ask"; input: string; command: string; reason: string }
	| { kind: "skipped"; input: string; reason: string }
	| { kind: "error"; input: string; error: string };

export interface HypaPiConfig {
	mode: HypaPiMode;
	binary: string;
	rewriteTimeoutMs: number;
	askNonInteractive: AskNonInteractivePolicy;
	mcpProxyEnabled: boolean;
	mcpProxyTimeoutMs: number;
	piMcpConfigPath?: string;
}

export interface HypaDiagnostics {
	mode: HypaPiMode;
	configFilePath?: string;
	binary: string;
	resolvedBinary: string;
	lastRewrite?: RewriteStatus;
}
