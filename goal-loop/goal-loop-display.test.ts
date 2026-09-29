import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fitLine } from "../ui/chrome.ts";
import type { Goal, State } from "./goal-loop-core.ts";
import { buildStatusText, buildWidgetLines } from "./goal-loop-display.ts";

function goal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "Build a polished responsive interface across every custom surface",
		status: "active",
		policy: "goal",
		autoContinue: true,
		usage: { tokensUsed: 1_000, tokensLimit: 10_000 },
		createdAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
		taskList: {
			version: 1,
			tasks: [
				{ id: "1", title: "Audit", status: "complete" },
				{ id: "2", title: "Implement responsive chrome", status: "pending" },
			],
		},
		...overrides,
	};
}

const theme = { fg: (_role: string, text: string) => text };

test("goal widget uses branded hierarchy and task progress", () => {
	const state: State = { goal: goal() };
	const lines = buildWidgetLines(state, undefined, Date.parse("2025-01-01T00:01:00Z"), theme, 80);
	assert.ok(lines);
	assert.match(lines[0] ?? "", /▎ .*goal · active · 1\/2 tasks · 1m 00s/);
	assert.match(lines.join("\n"), /next · Implement responsive chrome/);
	assert.match(buildStatusText(state, undefined, Date.parse("2025-01-01T00:01:00Z"), theme) ?? "", /^goal · active/);
});

test("goal widget content respects narrow logical budgets", () => {
	const state: State = { goal: goal() };
	for (const width of [12, 20, 40]) {
		const lines = buildWidgetLines(state, undefined, Date.now(), theme, width) ?? [];
		for (const line of lines.map((value) => fitLine(value, width))) {
			assert.ok(visibleWidth(line) <= width);
		}
	}
});
