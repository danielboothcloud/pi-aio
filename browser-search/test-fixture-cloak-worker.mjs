import { spawn } from "node:child_process";
import { trackChildProcesses } from "./cloak-ownership.mjs";

trackChildProcesses();
let input = "";
for await (const chunk of process.stdin) input += chunk;
let opts;
let scenario;
try {
	opts = JSON.parse(input);
	scenario = new URL(opts.url).pathname;
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
const emit = (message) => console.log(`AIO_CLOAK_RESULT:${JSON.stringify(message)}`);
if (scenario === "/crash") {
	setImmediate(() => { throw new Error("Failed to connect ENOENT fixture crash"); });
} else if (scenario === "/hang") {
	process.on("SIGTERM", () => {});
	console.log("ready");
	setInterval(() => {}, 1000);
} else if (scenario === "/descendant" || scenario === "/detached-descendant") {
	const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
		stdio: ["ignore", "inherit", "inherit"],
		detached: scenario === "/detached-descendant",
	});
	console.log(`descendant=${descendant.pid}`);
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 1000);
} else if (scenario === "/exited-descendant" || scenario === "/exited-detached-descendant") {
	const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
		stdio: ["ignore", "inherit", "inherit"],
		detached: scenario === "/exited-detached-descendant",
	});
	console.log(`descendant=${descendant.pid}`);
	process.exit(0);
} else if (scenario === "/oversize") {
	console.log("x".repeat(200_000));
} else if (scenario === "/malformed") {
	console.log("AIO_CLOAK_RESULT:not-json");
} else if (scenario === "/shape") {
	emit({ result: {} });
} else if (scenario === "/error") {
	emit({ error: "Cannot verify latest CloakBrowser (no stale fallback)" });
} else {
	console.log("optional browser startup chatter");
	emit({ result: {
		url: opts.url, format: opts.format ?? "text", tier: "cloak",
		content: `Node ${process.versions.node}; Bun ${process.versions.bun ?? "none"}`,
		chars: 30, truncated: false,
	} });
}
