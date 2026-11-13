/**
 * Resolve the latest CloakBrowser and the newest playwright-core it accepts on
 * every invocation; reuse only that exact version pair.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const NPM_REGISTRY = "https://registry.npmjs.org/";
const ONLINE_FLAGS = [
	"--offline=false", "--prefer-offline=false", "--prefer-online",
	"--fetch-retries=0", "--fetch-timeout=20000",
];

/** Run npm's JavaScript CLI under the worker's Node, also on Windows. */
export async function resolveNpmCli({
	nodePath = process.execPath,
	searchPath = process.env.PATH ?? "",
} = {}) {
	for (const directory of new Set([dirname(nodePath), ...searchPath.split(delimiter)])) {
		if (!directory) continue;
		for (const candidate of [
			join(directory, "npm"),
			join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
			join(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
		]) {
			try {
				const cli = await realpath(candidate);
				if (basename(cli) === "npm-cli.js") return cli;
			} catch {
				// Try the next standard npm installation location.
			}
		}
	}
	throw new Error("npm CLI not found. Install Node.js with npm to enable CloakBrowser.");
}

export async function runNpm(args, { cwd, timeout = 30_000, signal, env = process.env } = {}) {
	const cli = await resolveNpmCli();
	const { stdout } = await execFileAsync(process.execPath, [cli, ...args], {
		cwd,
		timeout,
		signal,
		maxBuffer: 1_048_576,
		windowsHide: true,
		env: {
			...env,
			// npm's env-node shebang must use this genuine Node, not Pi's Bun.
			PATH: `${dirname(process.execPath)}${delimiter}${env.PATH ?? ""}`,
		},
	});
	return stdout;
}

const PLAYWRIGHT_PEER = "peerDependencies.playwright-core";
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const PEER_RANGE = /^[\w.<>=~^|* -]+$/;

function checkedVersion(name, version) {
	if (typeof version !== "string" || !VERSION.test(version)) {
		throw new Error(`Invalid npm latest version for ${name}`);
	}
	return version;
}

/** Latest CloakBrowser and the playwright-core range it declares as a peer, if any. */
async function latestCloak(view) {
	const response = await view("cloakbrowser", "cloakbrowser", "dist-tags.latest", PLAYWRIGHT_PEER);
	// npm prints a bare value when only one of the requested fields exists.
	if (response === null || typeof response !== "object") {
		return { version: checkedVersion("cloakbrowser", response) };
	}
	const range = response[PLAYWRIGHT_PEER];
	if (range !== undefined && (typeof range !== "string" || !PEER_RANGE.test(range))) {
		throw new Error("Invalid playwright-core peer range for cloakbrowser");
	}
	return { version: checkedVersion("cloakbrowser", response["dist-tags.latest"]), range };
}

/**
 * Newest stable playwright-core that CloakBrowser accepts. Taking npm latest
 * regardless of the peer range makes the install fail with ERESOLVE whenever
 * playwright-core releases ahead of CloakBrowser's supported range.
 */
async function compatiblePlaywright(view, range) {
	if (!range) {
		return checkedVersion("playwright-core", await view("playwright-core", "playwright-core", "dist-tags.latest"));
	}
	// npm prints one matching version as a string and several as an array.
	const matches = [await view("playwright-core", `playwright-core@${range}`, "version")].flat();
	let newest;
	for (const version of matches) {
		const parts = typeof version === "string" ? STABLE_VERSION.exec(version)?.slice(1).map(Number) : undefined;
		if (!parts) continue;
		const order = newest ? parts.findIndex((part, index) => part !== newest.parts[index]) : 0;
		if (!newest || (order >= 0 && parts[order] > newest.parts[order])) newest = { version, parts };
	}
	if (!newest) throw new Error(`No stable playwright-core release satisfies cloakbrowser's peer range ${range}`);
	return newest.version;
}

async function installedEntry(directory, cloakVersion, playwrightVersion) {
	let entry;
	for (const [name, expected] of [["cloakbrowser", cloakVersion], ["playwright-core", playwrightVersion]]) {
		let pkg;
		try {
			pkg = JSON.parse(await readFile(join(directory, "node_modules", name, "package.json"), "utf8"));
		} catch {
			throw new Error(`Missing or invalid cached ${name} manifest`);
		}
		if (pkg.version !== expected) throw new Error(`Unexpected cached ${name} version`);
		if (name === "cloakbrowser") entry = pkg.exports?.["."]?.import ?? pkg.main;
	}
	if (typeof entry !== "string") throw new Error("CloakBrowser has no ESM entry point");
	// Resolving the package name with require would reject its import-only
	// exports map. Resolve the actual ESM entry's absolute path instead.
	return createRequire(join(directory, "package.json")).resolve(
		join(directory, "node_modules", "cloakbrowser", entry),
	);
}

/** Injectable npm seam; tests never use the registry or a real browser. */
export async function latestCloakEntry({
	run = runNpm,
	cacheRoot = join(homedir(), ".cache", "aio", "cloakbrowser"),
	// Same public registry for lookup AND installation, independent of cwd's
	// .npmrc. Overridable only through this injected test seam.
	registry = NPM_REGISTRY,
	signal,
} = {}) {
	let cloakVersion;
	let playwrightVersion;
	// prefer-online alone allows npm's stale-on-network-error fallback.
	// A fresh cache has no stale packument to fall back to.
	const metadataCache = await mkdtemp(join(tmpdir(), "aio-cloak-metadata-"));
	const view = async (name, spec, ...fields) => {
		const response = await run(
			["view", spec, ...fields, "--json", ...ONLINE_FLAGS, "--registry", registry, "--cache", metadataCache],
			{ signal },
		);
		try {
			return JSON.parse(response);
		} catch {
			throw new Error(`Invalid npm registry response for ${name}`);
		}
	};
	try {
		// Sequential: the playwright-core lookup depends on CloakBrowser's
		// peer range, and no npm child outlives the temporary cache.
		const cloak = await latestCloak(view);
		cloakVersion = cloak.version;
		playwrightVersion = await compatiblePlaywright(view, cloak.range);
	} catch (error) {
		throw new Error(`Cannot verify latest CloakBrowser from npm (no stale fallback): ${error.message}`);
	} finally {
		await rm(metadataCache, { recursive: true, force: true });
	}
	const registryKey = createHash("sha256").update(registry).digest("hex").slice(0, 12);
	const directory = join(cacheRoot, `${registryKey}-${cloakVersion}-${playwrightVersion}`);
	try {
		return pathToFileURL(await installedEntry(directory, cloakVersion, playwrightVersion)).href;
	} catch {
		// Install into a unique staging directory; concurrent workers cannot see
		// a half-installed package or mutate an installation already in use.
	}
	await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
	const staging = await mkdtemp(join(cacheRoot, ".install-"));
	try {
		await writeFile(join(staging, "package.json"), JSON.stringify({ private: true, type: "module" }));
		await run([
			"install", "--prefix", staging, "--no-save", "--package-lock=false",
			"--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev",
			...ONLINE_FLAGS, "--registry", registry,
			`cloakbrowser@${cloakVersion}`, `playwright-core@${playwrightVersion}`,
		], { cwd: staging, timeout: 120_000, signal });
		await installedEntry(staging, cloakVersion, playwrightVersion);
		try {
			await rename(staging, directory);
		} catch (error) {
			if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
			// Another worker published this exact version pair first.
		}
		return pathToFileURL(await installedEntry(directory, cloakVersion, playwrightVersion)).href;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
