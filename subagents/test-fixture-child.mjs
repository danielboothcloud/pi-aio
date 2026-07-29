#!/usr/bin/env node

const args = process.argv.slice(2);
const valueAfter = (flag) => {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
};
const task = args.at(-1) ?? "";
const model = valueAfter("--model") ?? "default-model";
if (task.includes("ignore-term")) process.on("SIGTERM", () => {});
const delay = task.includes("ignore-term")
	? 5_000
	: task.includes("slow")
		? 80
		: 5;

setTimeout(() => {
	if (task.includes("fail")) {
		process.stderr.write("fixture failure\n");
		process.exit(2);
	}
	process.stdout.write(
		`${JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `completed:${task}` }],
				model,
				stopReason: "stop",
				usage: {
					input: 10,
					output: 2,
					cacheRead: 1,
					cacheWrite: 0,
					cost: { total: 0.01 },
				},
			},
		})}\n`,
	);
}, delay);
