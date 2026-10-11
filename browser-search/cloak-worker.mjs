/** Browser failures terminate this Node process, never the Pi host. */
import { createJiti } from "jiti";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { latestCloakEntry } from "./cloak-latest.mjs";
import { trackChildProcesses } from "./cloak-ownership.mjs";

/** Seams exercise the real runtime/loader without npm or browser launches. */
export async function fetchInWorker(opts, {
	latestEntry = latestCloakEntry,
	loadCloak = (entry) => import(entry),
} = {}) {
	if (process.versions.bun) {
		throw new Error("CloakBrowser worker requires genuine Node.js, not Bun. Set BROWSER_SEARCH_NODE_BINARY.");
	}
	// Preserve the notice opt-out; version freshness is handled explicitly.
	process.env.CLOAKBROWSER_AUTO_UPDATE ??= "false";
	const cloak = await loadCloak(await latestEntry({ signal: opts.signal }));
	const jiti = createJiti(import.meta.url, { tryNative: false });
	const { cloakFetch } = await jiti.import("./cloak-runtime.ts");
	return cloakFetch(opts, cloak);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	trackChildProcesses();
	const controller = new AbortController();
	process.on("SIGTERM", () => controller.abort());
	process.on("SIGINT", () => controller.abort());
	const resultPrefix = "AIO_CLOAK_RESULT:";
	const finish = (message) => process.stdout.write(
		`\n${resultPrefix}${JSON.stringify(message)}\n`, () => process.exit(0),
	);
	try {
		let input = "";
		for await (const chunk of process.stdin) input += chunk;
		const opts = JSON.parse(input);
		const result = await fetchInWorker({ ...opts, signal: controller.signal });
		finish({ result });
	} catch (error) {
		finish({ error: error instanceof Error ? error.message : String(error) });
	}
}
