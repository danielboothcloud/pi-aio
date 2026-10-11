import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	BLOCKLIST_FILE_NAME,
	checkBlocklist,
	globalBlocklistPath,
	loadBlocklist,
	projectBlocklistPath,
	readBlocklistFile,
} from "./config.ts";

// Isolated agent dir + project cwd per test file. getAgentDir() honors
// PI_CODING_AGENT_DIR, so point it at a temp dir instead of the real ~/.pi.
const tmp = mkdtempSync(join(tmpdir(), "aio-blocklist-config-"));
const agentDir = join(tmp, "agent");
const projectDir = join(tmp, "project");
process.env.PI_CODING_AGENT_DIR = agentDir;

test.after(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(tmp, { recursive: true, force: true });
});

function writeGlobal(config: unknown): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, BLOCKLIST_FILE_NAME), JSON.stringify(config));
}

function writeProject(cwd: string, config: unknown): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", BLOCKLIST_FILE_NAME), JSON.stringify(config));
}

function clearConfigs(): void {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
}

test("paths: global under agent dir, project under cwd/.pi", () => {
	assert.equal(globalBlocklistPath(), join(agentDir, BLOCKLIST_FILE_NAME));
	assert.equal(
		projectBlocklistPath(projectDir),
		join(projectDir, ".pi", BLOCKLIST_FILE_NAME),
	);
});

test("no config files -> no rules, no hits", () => {
	clearConfigs();
	assert.deepEqual(loadBlocklist(projectDir), []);
	assert.equal(checkBlocklist("rm -rf /", projectDir), undefined);
});

test("string entries match case-insensitively as substrings", () => {
	clearConfigs();
	writeGlobal({ enabled: true, entries: ["rm -rf /"] });
	const hit = checkBlocklist("sudo rm -RF /tmp/data", projectDir);
	assert.ok(hit, "expected a hit");
	assert.equal(hit.pattern, "rm -rf /");
	assert.equal(hit.source, "global");
	assert.match(hit.reason, /Blocked by aio blocklist/);
	// Non-matching commands pass through
	assert.equal(checkBlocklist("ls -la", projectDir), undefined);
	assert.equal(checkBlocklist("rm -rf", projectDir), undefined);
});

test("regex entries match with the regex flag", () => {
	clearConfigs();
	writeGlobal({
		enabled: true,
		entries: [
			{
				pattern: "\\bgit push --force\\b",
				regex: true,
				reason: "no force push",
			},
		],
	});
	const hit = checkBlocklist("git push --force origin main", projectDir);
	assert.ok(hit);
	assert.equal(hit.source, "global");
	assert.match(hit.reason, /no force push/);
	// \b guards: a plain force push without --force is not blocked
	assert.equal(checkBlocklist("git push origin main", projectDir), undefined);
	assert.equal(
		checkBlocklist("git push -f origin main", projectDir),
		undefined,
	);
	assert.equal(
		checkBlocklist("git push --forcibly origin main", projectDir),
		undefined,
	);
});

test("object entries without regex fall back to substring matching", () => {
	clearConfigs();
	writeGlobal({ enabled: true, entries: [{ pattern: "kubectl delete" }] });
	assert.ok(checkBlocklist("kubectl delete ns staging", projectDir));
	assert.equal(checkBlocklist("kubectl get ns", projectDir), undefined);
});

test("custom reason overrides the default; default reason names the pattern", () => {
	clearConfigs();
	writeGlobal({
		enabled: true,
		entries: [
			{ pattern: "kubectl delete", reason: "no cluster deletions" },
			"shutdown",
		],
	});
	const custom = checkBlocklist("kubectl delete ns", projectDir);
	assert.match(custom!.reason, /no cluster deletions/);
	const plain = checkBlocklist("sudo shutdown now", projectDir);
	assert.match(plain!.reason, /matches blocked pattern "shutdown"/);
});

test("global and project entries union — both apply", () => {
	clearConfigs();
	writeGlobal({ enabled: true, entries: ["rm -rf /"] });
	writeProject(projectDir, {
		enabled: true,
		entries: [{ pattern: "kubectl delete", reason: "no cluster deletions" }],
	});
	const rules = loadBlocklist(projectDir);
	assert.equal(rules.length, 2);
	assert.equal(rules[0].source, "global");
	assert.equal(rules[1].source, "project");

	assert.ok(checkBlocklist("rm -rf /", projectDir), "global rule applies");
	const hit = checkBlocklist("kubectl delete ns", projectDir);
	assert.ok(hit, "project rule applies");
	assert.equal(hit.source, "project");
});

test("enabled:false in one file gates only that file's entries", () => {
	clearConfigs();
	writeGlobal({ enabled: false, entries: ["rm -rf /"] });
	writeProject(projectDir, { enabled: true, entries: ["kubectl delete"] });

	assert.equal(checkBlocklist("rm -rf /", projectDir), undefined);
	assert.ok(
		checkBlocklist("kubectl delete ns", projectDir),
		"project rule still applies",
	);

	writeProject(projectDir, { enabled: false, entries: ["kubectl delete"] });
	writeGlobal({ enabled: true, entries: ["rm -rf /"] });
	assert.ok(
		checkBlocklist("rm -rf /", projectDir),
		"global rule still applies",
	);
	assert.equal(checkBlocklist("kubectl delete ns", projectDir), undefined);
});

test("enabled defaults to true when omitted", () => {
	clearConfigs();
	writeGlobal({ entries: ["rm -rf /"] });
	assert.ok(checkBlocklist("rm -rf /", projectDir));
});

test("invalid JSON yields an empty blocklist", () => {
	clearConfigs();
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, BLOCKLIST_FILE_NAME), "{not json");
	assert.deepEqual(loadBlocklist(projectDir), []);
});

test("malformed entries are skipped, not fatal", () => {
	clearConfigs();
	writeGlobal({
		enabled: true,
		entries: [
			42,
			null,
			{},
			{ pattern: 7 },
			{ pattern: "  " },
			{ pattern: "kubectl delete" },
		],
	});
	const rules = loadBlocklist(projectDir);
	assert.equal(rules.length, 1);
	assert.equal(rules[0].pattern, "kubectl delete");
});

test("malformed regex entries are skipped", () => {
	clearConfigs();
	writeGlobal({
		enabled: true,
		entries: [{ pattern: "([unclosed", regex: true }, { pattern: "rm -rf" }],
	});
	assert.equal(loadBlocklist(projectDir).length, 1);
	assert.ok(checkBlocklist("rm -rf /", projectDir));
});

test("readBlocklistFile tolerates missing file and non-object JSON", () => {
	clearConfigs();
	assert.deepEqual(readBlocklistFile(join(agentDir, BLOCKLIST_FILE_NAME)), {
		enabled: true,
		entries: [],
	});
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, BLOCKLIST_FILE_NAME), "[1,2,3]");
	assert.deepEqual(readBlocklistFile(join(agentDir, BLOCKLIST_FILE_NAME)), {
		enabled: true,
		entries: [],
	});
});

test("empty or whitespace-only commands never hit", () => {
	clearConfigs();
	writeGlobal({ enabled: true, entries: ["rm"] });
	assert.equal(checkBlocklist("", projectDir), undefined);
	assert.equal(checkBlocklist("   ", projectDir), undefined);
});
