/**
 * aio-ast-grep — structural code search via the `ast-grep` CLI.
 *
 * Integrated natively into aio, mirroring the `pi-ast-grep` extension's
 * behavior. Registers one read-only Pi tool, `ast_grep`, that wraps the bundled
 * `@ast-grep/cli` binary for syntax-aware search (`run`) and rule scanning
 * (`scan`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildAstGrepArgs,
	formatCommand,
	resolveAstGrepBinary,
	runProcess,
} from "./cli.js";
import {
	buildAstGrepToolResult,
	buildCliFailureMessage,
	parseAstGrepJson,
	shouldTreatExitCodeAsSuccess,
} from "./output.js";
import { AstGrepToolParameters, normalizeAstGrepInput } from "./schema.js";

export function registerAstGrep(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ast_grep",
		label: "ast-grep",
		description:
			"Run ast-grep structural search or rule scans. This read-only tool wraps the bundled @ast-grep/cli binary, returns a compact summary, truncates output to Pi defaults, and saves full output to a temp file when needed.",
		promptSnippet:
			"Search code structurally with ast-grep patterns or ast-grep YAML rules.",
		promptGuidelines: [
			"Use ast_grep for syntax-aware code searches when text grep is likely to produce false positives.",
			"Use ast_grep with command=run and pattern for ad-hoc structural queries; pass language when ast-grep cannot infer it from files.",
			"Use ast_grep with command=scan for ast-grep YAML rule files or project sgconfig.yml scanning.",
			"ast_grep is read-only; use read/edit/write only after inspecting matches and deciding on concrete file changes.",
		],
		parameters: AstGrepToolParameters,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const input = normalizeAstGrepInput(params);
			const binary = await resolveAstGrepBinary();
			const args = buildAstGrepArgs(input);

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Running ${formatCommand(binary, args)}`,
					},
				],
				details: { command: input.command, argv: args },
			});

			const processResult = await runProcess(binary, args, {
				cwd: ctx.cwd,
				timeoutMs: input.timeoutMs,
				signal,
			});

			let matches;
			try {
				matches = parseAstGrepJson(processResult.stdout, input.json);
			} catch (error) {
				if (!shouldTreatExitCodeAsSuccess(processResult, [])) {
					throw new Error(buildCliFailureMessage(processResult));
				}
				throw new Error(
					`Failed to parse ast-grep JSON output: ${error instanceof Error ? error.message : String(error)}`,
				);
			}

			if (!shouldTreatExitCodeAsSuccess(processResult, matches)) {
				throw new Error(buildCliFailureMessage(processResult));
			}

			return await buildAstGrepToolResult(input, args, processResult, matches);
		},
	});
}

export { AstGrepToolParameters, normalizeAstGrepInput } from "./schema.js";
export { buildAstGrepArgs, resolveAstGrepBinary } from "./cli.js";
export { formatMatchSummary, parseAstGrepJson } from "./output.js";
