// Target picker for the tuicr review flow: ask what to review, translate
// the choice into tuicr arguments. Base-branch entries are hidden when no
// base branch can be detected. Ported from @joelazar/pi-tuicr 1.1.0.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { baseBranch, type Capture } from "./core.js";

/** tuicr arguments for the chosen target, or null when the user backed out. */
export type ReviewTarget = string[];

/** Ask what to review; returns tuicr args, or null if the user backed out. */
export async function pickTarget(ctx: ExtensionContext, capture: Capture): Promise<ReviewTarget | null> {
	const base = baseBranch(ctx.cwd, capture);
	const ask = async (
		prompt: string,
		hint: string,
		build: (answer: string) => ReviewTarget,
	): Promise<ReviewTarget | null> => {
		const answer = (await ctx.ui.input(prompt, hint))?.trim();
		return answer ? build(answer) : null;
	};

	const choices: Array<{ label: string; resolve: () => Promise<ReviewTarget | null> }> = [
		{ label: "Uncommitted changes", resolve: async () => ["-w"] },
		...(base
			? [
					{
						label: `Branch vs ${base} (+ uncommitted)`,
						resolve: async () => ["-r", `${base}..HEAD`, "-w"],
					},
					{
						label: `Branch vs ${base}`,
						resolve: async () => ["-r", `${base}..HEAD`],
					},
				]
			: []),
		{ label: "Last commit", resolve: async () => ["-r", "HEAD~1..HEAD"] },
		{ label: "Pick commits", resolve: async () => [] },
		{ label: "Every tracked file", resolve: async () => ["-A"] },
		{
			label: "Custom revset...",
			resolve: () => ask("Revset:", "e.g. HEAD~3..HEAD", (revset) => ["-r", revset]),
		},
		{
			label: "Pull request...",
			resolve: () => ask("PR:", "number, owner/repo#N, or URL", (target) => ["pr", target]),
		},
	];

	const label = await ctx.ui.select("What should I open in tuicr?", choices.map((choice) => choice.label));
	const choice = choices.find((candidate) => candidate.label === label);
	return choice ? await choice.resolve() : null;
}
