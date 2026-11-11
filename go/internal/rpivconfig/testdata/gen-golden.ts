// Regenerate golden.json from the real @juicesharp/rpiv-config package (the
// reference for the Go port):
//   npx tsx go/internal/rpivconfig/testdata/gen-golden.ts [--check]
// It runs loadJsonConfigWithLegacyFallback over fixture HOME folders in
// testdata/.fixture-<pid> (removed afterwards) with several XDG_CONFIG_HOME
// values, and validateGuidanceFields over sample values. Fixture paths are
// written as @@ROOT@@; console.warn output is captured.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, `.fixture-${process.pid}`);
rmSync(root, { recursive: true, force: true });

const config = await import("@juicesharp/rpiv-config");

const NAME = "rpiv-ask-user-question";

type Files = Record<string, string>;
const homes: Record<string, Files> = {
	empty: {},
	legacy: { [`.config/${NAME}/config.json`]: '{"collapseKey":"alt+o","guidance":{"promptSnippet":"legacy"}}' },
	xdg: {
		[`xdg/${NAME}/config.json`]: '{"collapseKey":"ctrl+]","from":"xdg"}',
		[`.config/${NAME}/config.json`]: '{"from":"legacy"}',
	},
	xdgMalformed: {
		[`xdg/${NAME}/config.json`]: "{not json",
		[`.config/${NAME}/config.json`]: '{"from":"legacy"}',
	},
	legacyMalformed: { [`.config/${NAME}/config.json`]: "" },
	nonObjects: {
		[`.config/${NAME}/config.json`]: "42",
		[`.config/${NAME}/null.json`]: "null",
		[`.config/${NAME}/array.json`]: "[1,2]",
		[`.config/${NAME}/string.json`]: '"hello"',
		[`.config/${NAME}/nested.json`]: '{"a":{"b":[1,"two",null,true]},"n":1.5}',
	},
	tilde: { [`cfg/${NAME}/config.json`]: '{"from":"tilde"}' },
	dir: { [`.config/${NAME}/config.json/inner`]: "x" },
};

const xdgValues: Array<{ label: string; value: string | undefined }> = [
	{ label: "unset", value: undefined },
	{ label: "empty", value: "" },
	{ label: "blank", value: "   " },
	{ label: "relative", value: "relative/dir" },
	{ label: "absolute", value: "@@HOME@@/xdg" },
	{ label: "absolutePadded", value: "  @@HOME@@/xdg  " },
	{ label: "tildeSlash", value: "~/cfg" },
	{ label: "tilde", value: "~" },
	{ label: "tildeUser", value: "~user/cfg" },
];
const files = ["", "null.json", "array.json", "string.json", "nested.json"];

const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
	warnings.push(args.map(String).join(" "));
};

const loads: unknown[] = [];
for (const [home, tree] of Object.entries(homes)) {
	const homeDir = join(root, home);
	mkdirSync(homeDir, { recursive: true });
	for (const [rel, content] of Object.entries(tree)) {
		const full = join(homeDir, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
	for (const xdg of xdgValues) {
		for (const file of files) {
			if (file !== "" && home !== "nonObjects") continue;
			process.env.HOME = homeDir;
			if (xdg.value === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = xdg.value.replace("@@HOME@@", homeDir);
			warnings.length = 0;
			const value = file === "" ? config.loadJsonConfigWithLegacyFallback(NAME) : config.loadJsonConfigWithLegacyFallback(NAME, file);
			const path = file === "" ? config.configPath(NAME) : config.configPath(NAME, file);
			loads.push({
				home,
				xdg: xdg.label,
				xdgValue: xdg.value ?? null,
				file,
				path: path.split(homeDir).join("@@HOME@@"),
				value,
				// The JSON.parse error text after "—" is Node's; only the prefix is compared.
				warnings: warnings.map((w) => w.split(homeDir).join("@@HOME@@").replace(/ — .*$/s, " — ")),
			});
		}
	}
}
console.warn = originalWarn;
delete process.env.XDG_CONFIG_HOME;

const guidanceInputs: unknown[] = [
	null,
	undefined,
	0,
	"text",
	[],
	["x"],
	{},
	{ promptSnippet: "" },
	{ promptSnippet: "snippet" },
	{ promptSnippet: 3 },
	{ promptGuidelines: [] },
	{ promptGuidelines: ["one", "two"] },
	{ promptGuidelines: ["one", ""] },
	{ promptGuidelines: ["one", 2] },
	{ promptGuidelines: "one" },
	{ promptSnippet: "s", promptGuidelines: ["g"], extra: true },
];
const guidance = guidanceInputs.map((input) => ({
	input: input === undefined ? "@@UNDEFINED@@" : input,
	out: config.validateGuidanceFields(input),
}));

rmSync(root, { recursive: true, force: true });

const golden = { name: NAME, homes, loads, guidance };
const output = `${JSON.stringify(golden, null, 1)}\n`;
const goldenPath = join(here, "golden.json");
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(goldenPath, "utf8");
	} catch {
		current = "";
	}
	if (current !== output) {
		console.error("rpivconfig golden.json is stale: run npx tsx go/internal/rpivconfig/testdata/gen-golden.ts");
		process.exit(1);
	}
} else {
	writeFileSync(goldenPath, output);
	console.log(`wrote loads=${loads.length} guidance=${guidance.length}`);
}
