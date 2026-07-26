import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	extractVerificationContract,
	goalArgsNeedDrafting,
	routeGoalArgs,
	validateTaskProposal,
	buildTaskList,
	normalizeDraftContract,
	draftContractItemCount,
	countTrailingDisapprovals,
	type AuditVerdict,
} from "./goal-loop-core.js";
import {
	checkRegressionShield,
	parseAuditorVerdict,
	contractItems,
} from "./goal-loop-shield.js";
import {
	backoffMs,
	shouldPauseAfterBackoff,
	accountTurnForNudges,
} from "./goal-loop-backoff.js";
import { isQuotaError, parseQuotaError } from "./quota-retry.js";

describe("goal-loop entry", () => {
	it("exports a registration function", async () => {
		const mod = await import("./index.js");
		assert.equal(typeof mod.default, "function");
	});
});

describe("extractVerificationContract", () => {
	it("splits a 'Done when:' clause from the objective", () => {
		const { objective, verificationContract } = extractVerificationContract(
			"Create x.txt. Done when: grep -q ok x.txt",
		);
		assert.equal(objective, "Create x.txt");
		assert.equal(verificationContract, "grep -q ok x.txt");
	});

	it("handles a multi-line contract block", () => {
		const { objective, verificationContract } = extractVerificationContract(
			"Build the feature\nDone when:\n- tests pass\n- docs exist",
		);
		assert.equal(objective, "Build the feature");
		assert.match(verificationContract, /tests pass/);
		assert.match(verificationContract, /docs exist/);
	});

	it("returns an empty contract when no marker is present", () => {
		const { objective, verificationContract } =
			extractVerificationContract("Just do the thing");
		assert.equal(objective, "Just do the thing");
		assert.equal(verificationContract, "");
	});
});

describe("goalArgsNeedDrafting", () => {
	it("drafts when there is no 'Done when' phrase", () => {
		assert.equal(goalArgsNeedDrafting("make it faster"), true);
	});

	it("activates directly when a 'Done when' phrase is present", () => {
		assert.equal(
			goalArgsNeedDrafting("make it faster. Done when: benchmark < 100ms"),
			false,
		);
	});

	it("no-args is not drafting (handled by the draft path)", () => {
		assert.equal(goalArgsNeedDrafting(""), false);
	});
});

describe("routeGoalArgs", () => {
	it("routes bare subcommands", () => {
		assert.deepEqual(routeGoalArgs("status"), {
			kind: "sub",
			name: "status",
			rest: "",
		});
		assert.deepEqual(routeGoalArgs("pause"), {
			kind: "sub",
			name: "pause",
			rest: "",
		});
	});

	it("routes arg subcommands", () => {
		assert.deepEqual(routeGoalArgs("tweak new objective"), {
			kind: "sub",
			name: "tweak",
			rest: "new objective",
		});
		assert.deepEqual(routeGoalArgs("start do the thing"), {
			kind: "sub",
			name: "start",
			rest: "do the thing",
		});
	});

	it("does not treat an objective starting with a subcommand word as a subcommand", () => {
		assert.deepEqual(routeGoalArgs("pause the pipeline and fix it"), {
			kind: "set",
			text: "pause the pipeline and fix it",
		});
	});

	it("empty args draft", () => {
		assert.deepEqual(routeGoalArgs(""), { kind: "draft" });
	});
});

describe("task proposal validation", () => {
	it("rejects an empty list", () => {
		assert.ok(validateTaskProposal([]));
	});

	it("rejects too many top-level tasks", () => {
		const tasks = Array.from({ length: 21 }, (_, i) => ({ title: `t${i}` }));
		assert.ok(validateTaskProposal(tasks));
	});

	it("accepts a valid proposal and assigns hierarchical ids", () => {
		const tasks = [{ title: "a", subtasks: ["a1", "a2"] }, { title: "b" }];
		assert.equal(validateTaskProposal(tasks), null);
		const tl = buildTaskList(tasks);
		assert.equal(tl.tasks[0]?.id, "1");
		assert.equal(tl.tasks[0]?.subtasks?.[1]?.id, "1.2");
		assert.equal(tl.tasks[1]?.id, "2");
	});
});

describe("normalizeDraftContract", () => {
	it("drops bare 'Done when:' introducers and renumbers bullets", () => {
		const out = normalizeDraftContract(
			"Done when:\n- tests pass\n- docs exist",
		);
		assert.doesNotMatch(out, /^Done when:/m);
		assert.match(out, /1\. tests pass/);
		assert.match(out, /2\. docs exist/);
		assert.equal(draftContractItemCount(out), 2);
	});
});

describe("countTrailingDisapprovals", () => {
	it("counts only the trailing disapproval streak", () => {
		const history: AuditVerdict[] = [
			{ at: "t1", approved: false, disapproved: true, model: "m" },
			{ at: "t2", approved: true, disapproved: false, model: "m" },
			{ at: "t3", approved: false, disapproved: true, model: "m" },
			{ at: "t4", approved: false, disapproved: true, model: "m" },
		];
		assert.equal(countTrailingDisapprovals(history), 2);
	});

	it("infra errors are transparent (do not break the streak)", () => {
		const history: AuditVerdict[] = [
			{ at: "t1", approved: false, disapproved: true, model: "m" },
			{
				at: "t2",
				approved: false,
				disapproved: false,
				model: "m",
				error: "boom",
			},
			{ at: "t3", approved: false, disapproved: true, model: "m" },
		];
		assert.equal(countTrailingDisapprovals(history), 2);
	});
});

describe("regression shield", () => {
	it("requires an <evidence> block for an approval", () => {
		const contract = "tests pass\ndocs exist";
		const res = checkRegressionShield("no evidence here", contract);
		assert.equal(res.passed, false);
		assert.equal(res.hasEvidenceBlock, false);
	});

	it("passes when every contract item is referenced in the evidence block", () => {
		const contract = "tests pass\ndocs exist";
		const report = `<evidence>
Item: tests pass
Output: $ npm test — 0 failing
Item: docs exist
Output: $ ls docs/ — guide.md
</evidence>`;
		const res = checkRegressionShield(report, contract);
		assert.equal(res.passed, true);
		assert.equal(res.missingItems.length, 0);
	});

	it("contractItems drops 'Out of scope' and preamble lines", () => {
		const items = contractItems(
			"Done when ALL of the following are true:\n- a\nOut of scope: b\n- c",
		);
		assert.deepEqual(items, ["a", "c"]);
	});

	it("parseAuditorVerdict reads the final verdict tag", () => {
		assert.deepEqual(parseAuditorVerdict("blah\n\n<approved/>"), {
			approved: true,
			disapproved: false,
			impossible: false,
			impossibleReason: undefined,
		});
		assert.deepEqual(
			parseAuditorVerdict("<impossible>contradiction</impossible>"),
			{
				approved: false,
				disapproved: false,
				impossible: true,
				impossibleReason: "contradiction",
			},
		);
	});
});

describe("backoff", () => {
	it("caps at the 5-minute hard ceiling", () => {
		assert.ok(backoffMs(100) <= 5 * 60 * 1000);
	});

	it("pauses after the hard cap or 3 idle iterations", () => {
		assert.equal(shouldPauseAfterBackoff(5 * 60 * 1000, 0), true);
		assert.equal(shouldPauseAfterBackoff(0, 3), true);
		assert.equal(shouldPauseAfterBackoff(0, 1), false);
	});

	it("a turn with tool calls resets the nudge counter", () => {
		assert.equal(accountTurnForNudges(3, 2), 0);
		assert.equal(accountTurnForNudges(0, 2), 3);
	});
});

describe("quota-retry", () => {
	it("detects quota-shaped errors", () => {
		assert.equal(isQuotaError("429 Too Many Requests"), true);
		assert.equal(isQuotaError("quota exhausted"), true);
		assert.equal(isQuotaError("auditor aborted"), false);
	});

	it("parses an upstream Retry-After hint", () => {
		const q = parseQuotaError("Retry-After: 120", 3600);
		assert.equal(q.retryAfterSec, 120);
		assert.equal(q.fromUpstream, true);
	});

	it("falls back to the default window", () => {
		const q = parseQuotaError("rate limit exceeded", 3600);
		assert.equal(q.retryAfterSec, 3600);
		assert.equal(q.fromUpstream, false);
	});
});
