/** Resolve npm latest on every invocation; reuse only that exact version pair. */
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

async function latestVersion(name, run, signal, registry, metadataCache) {
	const response = await run(
		[
			"view", name, "dist-tags.latest", "--json", ...ONLINE_FLAGS,
			"--registry", registry, "--cache", metadataCache,
		],
		{ signal },
	);
	let version;
	try {
		version = JSON.parse(response);
	} catch {
		throw new Error(`Invalid npm registry response for ${name}`);
	}
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
		throw new Error(`Invalid npm latest version for ${name}`);
	}
	return version;
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
	const metadataCache = await mkdtemp(join(tmpdir(), "aio-cloak-metadata-"));
	const lookupController = new AbortController();
	const lookupSignal = signal
		? AbortSignal.any([signal, lookupController.signal])
		: lookupController.signal;
	// prefer-online alone allows npm's stale-on-network-error fallback.
	// A fresh cache has no stale packument to fall back to.
	const lookups = [
		latestVersion("cloakbrowser", run, lookupSignal, registry, metadataCache),
		latestVersion("playwright-core", run, lookupSignal, registry, metadataCache),
	];
	try {
		[cloakVersion, playwrightVersion] = await Promise.all(lookups);
	} catch (error) {
		lookupController.abort();
		// Reap both npm children before deleting their temporary cache.
		await Promise.allSettled(lookups);
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
