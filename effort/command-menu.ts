import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./parse.js";

const CANONICAL_EFFORT_OPTIONS: {
	value: ThinkingLevel | "ultracode" | "status";
	description: string;
	selectLabel?: string;
}[] = [
	{
		value: "off",
		description: "Disable model thinking effort",
		selectLabel: "off — disable thinking",
	},
	{ value: "minimal", description: "Minimal effort", selectLabel: "minimal — minimal effort" },
	{ value: "low", description: "Low effort", selectLabel: "low — low effort" },
	{ value: "medium", description: "Medium effort", selectLabel: "medium — medium effort" },
	{ value: "high", description: "High effort", selectLabel: "high — high effort" },
	{ value: "xhigh", description: "Extra high effort", selectLabel: "xhigh — extra high effort" },
	{ value: "max", description: "Maximum native effort", selectLabel: "max — maximum native effort" },
	{
		value: "ultracode",
		description: "Extra high effort + dynamic_workflow router",
		selectLabel: "ultracode — xhigh + dynamic_workflow router",
	},
	{ value: "status", description: "Show current effort" },
];

const ALIAS_COMPLETIONS: { value: string; description: string }[] = [
	{ value: "none", description: "Alias for off" },
	{ value: "ultra-code", description: "Alias for ultracode" },
];

const toCompletionItem = ({ value, description }: { value: string; description: string }) => ({
	value,
	label: value,
	description,
});

const COMPLETION_ITEMS: { value: string; label: string; description: string }[] = [
	...CANONICAL_EFFORT_OPTIONS.map(toCompletionItem),
	...ALIAS_COMPLETIONS.map(toCompletionItem),
];

const SELECT_ITEMS = CANONICAL_EFFORT_OPTIONS.flatMap((item) => (item.selectLabel ? [item.selectLabel] : []));

export function getEffortArgumentCompletions(prefix: string):
	| {
			value: string;
			label: string;
			description: string;
	  }[]
	| null {
	const normalizedPrefix = prefix.trim().toLowerCase();
	const items = COMPLETION_ITEMS.filter((item) => item.value.toLowerCase().startsWith(normalizedPrefix));
	return items.length > 0 ? items : null;
}

export async function resolveEffortCommandValue(args: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = args.trim();
	if (trimmed || !ctx.hasUI) return trimmed;

	const choice = await ctx.ui.select("Select thinking effort", SELECT_ITEMS);
	return choice?.split(/\s+/)[0] ?? "status";
}
