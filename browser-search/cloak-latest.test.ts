import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { latestCloakEntry, resolveNpmCli, runNpm } from "./cloak-latest.mjs";

function npmFixture() {
	let version = "0.6.0";
	let offline = false;
	let installs = 0;
	const calls: string[][] = [];
	return {
		setVersion(value: string) { version = value; },
		setOffline() { offline = true; },
		get installs() { return installs; },
		calls,
		async run(args: string[], options: { cwd?: string } = {}) {
			calls.push(args);
			if (args[0] === "view") {
				if (offline) throw new Error("registry unreachable");
				return JSON.stringify(args[1] === "cloakbrowser" ? version : "1.64.0");
			}
			assert.equal(args[0], "install");
			assert.ok(args.includes(`cloakbrowser@${version}`));
			assert.ok(args.includes("playwright-core@1.64.0"));
			assert.ok(args.includes("--ignore-scripts"));
			assert.ok(options.cwd);
			installs++;
			for (const name of ["cloakbrowser", "playwright-core"]) {
				const dir = join(options.cwd, "node_modules", name);
				await mkdir(dir, { recursive: true });
				await writeFile(join(dir, "package.json"), JSON.stringify({
					name,
					version: name === "cloakbrowser" ? version : "1.64.0",
					main: "index.mjs",
					// Real CloakBrowser has no require export.
					exports: { ".": { import: "./index.mjs" } },
				}));
				await writeFile(join(dir, "index.mjs"), "export const mock = true;\n");
			}
			return "installed";
		},
	};
}

test("each worker revalidates latest, reuses only matching versions, and upgrades immediately", async () => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "aio-cloak-latest-"));
	const npm = npmFixture();
	try {
		const first = await latestCloakEntry({ cacheRoot, run: npm.run });
		assert.match(first, /0\.6\.0-1\.64\.0/);
		assert.equal(await latestCloakEntry({ cacheRoot, run: npm.run }), first);
		assert.equal(npm.installs, 1);
		npm.setVersion("0.7.0");
		assert.match(await latestCloakEntry({ cacheRoot, run: npm.run }), /0\.7\.0-1\.64\.0/);
		assert.equal(npm.installs, 2);
		const views = npm.calls.filter((args) => args[0] === "view");
		assert.equal(views.length, 6);
		for (const args of views) {
			assert.ok(args.includes("dist-tags.latest"));
			assert.ok(args.includes("--prefer-online"));
			assert.ok(args.includes("--offline=false"));
			assert.ok(args.includes("--prefer-offline=false"));
			assert.ok(args.includes("--cache"));
			assert.equal(args[args.indexOf("--registry") + 1], "https://registry.npmjs.org/");
		}
		npm.setOffline();
		await assert.rejects(latestCloakEntry({ cacheRoot, run: npm.run }), /no stale fallback.*registry unreachable/);
	} finally {
		await rm(cacheRoot, { recursive: true, force: true });
	}
});

test("concurrent installs publish a complete immutable version pair", async () => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "aio-cloak-concurrent-"));
	const npm = npmFixture();
	try {
		const entries = await Promise.all(Array.from({ length: 3 }, () => latestCloakEntry({ cacheRoot, run: npm.run })));
		assert.equal(new Set(entries).size, 1);
		const directories = await readdir(cacheRoot);
		assert.equal(directories.length, 1);
		assert.match(directories[0], /^[a-f0-9]{12}-0\.6\.0-1\.64\.0$/);
	} finally {
		await rm(cacheRoot, { recursive: true, force: true });
	}
});

test("a warmed npm cache cannot satisfy latest checks when the mock registry is offline", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "aio-cloak-offline-"));
	const metadataCache = join(root, "warm-metadata");
	const npm = npmFixture();
	const server = createServer((request, response) => {
		const name = request.url?.includes("playwright-core") ? "playwright-core" : "cloakbrowser";
		const version = name === "cloakbrowser" ? "0.6.0" : "1.64.0";
		response.setHeader("content-type", "application/json");
		response.setHeader("cache-control", "public, max-age=86400");
		response.end(JSON.stringify({ name, "dist-tags": { latest: version }, versions: { [version]: { name, version } } }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const registry = `http://127.0.0.1:${address.port}/`;
	const run = async (args: string[], options: any) => {
		if (args[0] === "install") return npm.run(args, options);
		return runNpm(args, { ...options, env: { ...process.env, NPM_CONFIG_CACHE: metadataCache } });
	};
	try {
		// Warm the default npm cache with both packages first.
		for (const name of ["cloakbrowser", "playwright-core"]) {
			await run(["view", name, "dist-tags.latest", "--json", "--registry", registry], {});
		}
		await latestCloakEntry({ cacheRoot: join(root, "packages"), registry, run });
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await assert.rejects(latestCloakEntry({ cacheRoot: join(root, "packages"), registry, run }), /no stale fallback/);
	} finally {
		if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
});

test("npm CLI resolution supports Node's Windows layout and missing npm fails clearly", async () => {
	const root = await mkdtemp(join(tmpdir(), "aio-cloak-npm-"));
	try {
		await assert.rejects(resolveNpmCli({ nodePath: join(root, "node.exe"), searchPath: "" }), /npm CLI not found/);
		const directory = join(root, "node_modules", "npm", "bin");
		await mkdir(directory, { recursive: true });
		const cli = join(directory, "npm-cli.js");
		await writeFile(cli, "// npm fixture\n");
		assert.equal(await resolveNpmCli({ nodePath: join(root, "node.exe"), searchPath: "" }), await realpath(cli));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("invalid registry versions and failed installs never select an older package", async () => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "aio-cloak-errors-"));
	const npm = npmFixture();
	try {
		npm.setVersion("../../unsafe");
		await assert.rejects(latestCloakEntry({ cacheRoot, run: npm.run }), /Invalid npm latest version/);
		assert.equal(npm.installs, 0);
		npm.setVersion("0.6.0");
		await assert.rejects(latestCloakEntry({ cacheRoot, run: async (args: string[], options: any) => {
			if (args[0] === "install") throw new Error("install failed");
			return npm.run(args, options);
		} }), /install failed/);
		assert.deepEqual(await readdir(cacheRoot), []);
	} finally {
		await rm(cacheRoot, { recursive: true, force: true });
	}
});
