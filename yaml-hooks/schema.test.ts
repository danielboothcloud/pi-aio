// Loader + schema regression tests for yaml hooks. Mirrors the blocklist
// test pattern: an isolated agent dir per file (getAgentDir() honors
// PI_CODING_AGENT_DIR) and a temp project dir.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadHooksFile, resolveOverrides, setActiveHookPolicy } from "./composition.js";
import { createPiHookPolicy } from "./unsupported.js";
import { __resetSnapshotCacheForTests, loadDiscoveredHooks, summarizeHookSources } from "./discovery.js";
import { trustedProjectsFilePath, __resetTrustListCacheForTests } from "./paths.js";

const tmp = mkdtempSync(join(tmpdir(), "aio-yaml-hooks-"));
const agentDir = join(tmp, "agent");
const projectDir = join(tmp, "project");
process.env.PI_CODING_AGENT_DIR = agentDir;

test.after(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	__resetSnapshotCacheForTests();
	__resetTrustListCacheForTests();
	rmSync(tmp, { recursive: true, force: true });
});

test.beforeEach(() => {
	__resetSnapshotCacheForTests();
	__resetTrustListCacheForTests();
	setActiveHookPolicy(createPiHookPolicy());
});

function writeGlobal(yaml: string): void {
	mkdirSync(join(agentDir, "hook"), { recursive: true });
	writeFileSync(join(agentDir, "hook", "hooks.yaml"), yaml);
}

function writeProject(yaml: string): void {
	mkdirSync(join(projectDir, ".pi", "hook"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "hook", "hooks.yaml"), yaml);
}

function clearConfigs(): void {
	rmSync(join(agentDir, "hook"), { recursive: true, force: true });
	rmSync(join(agentDir, "hooks.yaml"), { force: true });
	rmSync(join(projectDir, ".pi"), { recursive: true, force: true });
}

// ---- parseHooksFile / schema ----

test("parseHooksFile: valid hooks load with ids, scopes, and sources", () => {
	const parsed = loadHooksFile("/tmp/hooks.yaml", () => `
hooks:
  - id: idle-notify
    event: session.idle
    actions:
      - notify: "Agent is idle"
  - id: guard-bash
    event: tool.before.bash
    action: stop
    actions:
      - bash: "./scripts/check.sh"
        timeout: 5000
`);
	assert.equal(parsed.errors.length, 0);
	const idleHooks = parsed.hooks.get("session.idle") ?? [];
	const guardHooks = parsed.hooks.get("tool.before.bash") ?? [];
	assert.equal(idleHooks.length, 1);
	assert.equal(idleHooks[0]?.id, "idle-notify");
	assert.equal(idleHooks[0]?.scope, "all");
	assert.equal(idleHooks[0]?.source.filePath, "/tmp/hooks.yaml");
	assert.equal(guardHooks.length, 1);
	assert.equal(guardHooks[0]?.action, "stop");
});

test("parseHooksFile: short action forms normalize", () => {
	const parsed = loadHooksFile("/tmp/short.yaml", () => `
hooks:
  - id: short
    event: tool.after.write
    actions:
      - bash: "echo hi"
      - notify: "done"
      - setStatus: "working"
`);
	assert.equal(parsed.errors.length, 0);
	const hooks = parsed.hooks.get("tool.after.write") ?? [];
	assert.equal(hooks.length, 1);
	assert.equal(hooks[0]?.actions[0]?.bash, "echo hi");
	// Short forms keep their string shape; the runtime normalizes at execution.
	assert.equal(hooks[0]?.actions[1]?.notify, "done");
	assert.equal(hooks[0]?.actions[2]?.setStatus, "working");
});

test("parseHooksFile: command actions are rejected by the Pi policy", () => {
	const parsed = loadHooksFile("/tmp/command.yaml", () => `
hooks:
  - id: command-hook
    event: tool.after.write
    actions:
      - command: "npm test"
`);
	const policyErrors = parsed.errors.filter((e) => e.code === "unsupported_on_pi");
	assert.equal(policyErrors.length, 1);
	assert.match(policyErrors[0]?.message ?? "", /command: actions/);
	assert.equal((parsed.hooks.get("tool.after.write") ?? []).length, 0);
});

test("parseHooksFile: malformed hooks produce actionable errors", () => {
	const cases = [
		["missing hooks key", "not_hooks: []", "missing_hooks"],
		["hooks not array", "hooks: 3", "invalid_hooks"],
		["hook not object", "hooks:\n  - 3", "invalid_hook"],
		["unknown event", "hooks:\n  - event: nope\n    actions:\n      - bash: x", "invalid_event"],
		["missing actions", "hooks:\n  - event: session.idle", "invalid_actions"],
		["empty actions", "hooks:\n  - event: session.idle\n    actions: []", "invalid_actions"],
		["two action keys", "hooks:\n  - event: session.idle\n    actions:\n      - bash: x\n        notify: y", "invalid_action"],
		["invalid scope", "hooks:\n  - event: session.idle\n    scope: nope\n    actions:\n      - bash: x", "invalid_scope"],
		["action stop on non-before", "hooks:\n  - event: session.idle\n    action: stop\n    actions:\n      - bash: x", "invalid_hook_action"],
		["prompt hooks are bash-only", "hooks:\n  - event: user.prompt.submit\n    actions:\n      - notify: x", "invalid_action"],
		["async on tool.before", "hooks:\n  - event: tool.before.bash\n    async: true\n    actions:\n      - bash: x", "invalid_async"],
		["async non-bash", "hooks:\n  - event: tool.after.write\n    async: true\n    actions:\n      - notify: x", "invalid_async"],
		["unknown condition", "hooks:\n  - event: file.changed\n    conditions:\n      - nope: x\n    actions:\n      - bash: x", "invalid_conditions"],
		["path condition on tool.before", "hooks:\n  - event: tool.before.bash\n    conditions:\n      - matchesAnyPath:\n          - src/**\n    actions:\n      - bash: x", "invalid_conditions"],
		["duplicate ids", "hooks:\n  - id: a\n    event: session.idle\n    actions:\n      - bash: x\n  - id: a\n    event: session.created\n    actions:\n      - bash: x", "duplicate_hook_id"],
	];

	for (const [name, yaml, expectedCode] of cases) {
		const parsed = loadHooksFile(`/tmp/${expectedCode}.yaml`, () => yaml);
		const codes = parsed.errors.map((e) => e.code);
		assert.ok(codes.includes(expectedCode as never), `${name}: expected ${expectedCode}, got ${codes.join(",")}`);
	}
});

// ---- conditions ----

test("parseHooksFile: path conditions accept string and array forms", () => {
	const parsed = loadHooksFile("/tmp/conditions.yaml", () => `
hooks:
  - id: cond
    event: file.changed
    conditions:
      - matchesCodeFiles
      - matchesAnyPath: "src/**/*.ts"
      - matchesAllPaths:
          - "src/**"
          - "**/*.ts"
    actions:
      - bash: "echo changed"
`);
	assert.equal(parsed.errors.length, 0);
	const hooks = parsed.hooks.get("file.changed") ?? [];
	assert.equal(hooks[0]?.conditions?.length, 3);
});

// ---- overrides ----

test("resolveOverrides: replacement and disable by id", () => {
	const base = loadHooksFile("/tmp/base.yaml", () => `
hooks:
  - id: idle
    event: session.idle
    actions:
      - notify: "Agent is idle"
  - id: other
    event: session.created
    actions:
      - bash: "echo ready"
`);
	const override = loadHooksFile("/tmp/override.yaml", () => `
hooks:
  - id: idle-replacement
    override: idle
    event: session.idle
    actions:
      - notify: "Project idle"
  - override: other
    disable: true
`);
	const resolved = resolveOverrides(base.hooks, override.overrides);
	assert.equal(resolved.errors.length, 0);

	const idleHooks = resolved.hooks.get("session.idle") ?? [];
	assert.equal(idleHooks.length, 1);
	assert.equal(idleHooks[0]?.actions[0]?.notify, "Project idle");
	assert.equal((resolved.hooks.get("session.created") ?? []).length, 0);
});

test("resolveOverrides: unknown targets fail validation", () => {
	const override = loadHooksFile("/tmp/bad-override.yaml", () => `
hooks:
  - override: nope
    disable: true
`);
	const resolved = resolveOverrides(new Map(), override.overrides);
	const codes = resolved.errors.map((e) => e.code);
	assert.ok(codes.includes("override_target_not_found"));
});

// ---- discovery + trust ----

test("loadDiscoveredHooks: global hooks load without trust", () => {
	clearConfigs();
	writeGlobal(`
hooks:
  - id: g1
    event: session.idle
    actions:
      - notify: "idle"
`);
	const result = loadDiscoveredHooks({ projectDir: projectDir });
	const idleHooks = result.hooks.get("session.idle") ?? [];
	assert.equal(idleHooks.length, 1);
	assert.equal(idleHooks[0]?.id, "g1");
	assert.deepEqual(summarizeHookSources(result.sources), { total: 1, global: 1, project: 0 });
});

test("loadDiscoveredHooks: project hooks are gated by trust", () => {
	clearConfigs();
	writeGlobal(`
hooks:
  - id: g1
    event: session.idle
    actions:
      - notify: "idle"
`);
	writeProject(`
hooks:
  - id: p1
    event: session.created
    actions:
      - bash: "echo ready"
`);

	// Untrusted: only global loads; trust is reported through sources.
	const untrusted = loadDiscoveredHooks({ projectDir: projectDir });
	assert.deepEqual(summarizeHookSources(untrusted.sources), { total: 1, global: 1, project: 0 });

	// Trusted via the trust store.
	mkdirSync(join(agentDir), { recursive: true });
	writeFileSync(trustedProjectsFilePath(), `${JSON.stringify([projectDir], null, 2)}\n`);
	__resetTrustListCacheForTests();
	__resetSnapshotCacheForTests();

	const trusted = loadDiscoveredHooks({ projectDir: projectDir });
	assert.deepEqual(summarizeHookSources(trusted.sources), { total: 2, global: 1, project: 1 });
	const createdHooks = trusted.hooks.get("session.created") ?? [];
	assert.equal(createdHooks.length, 1);
	assert.equal(createdHooks[0]?.id, "p1");
});

test("loadDiscoveredHooks: untrusted project hooks are skipped, not failed", () => {
	clearConfigs();
	// The trust store persists across tests; drop it so this case starts
	// from an untrusted project state.
	rmSync(trustedProjectsFilePath(), { force: true });
	__resetTrustListCacheForTests();
	writeProject(`
hooks:
  - id: p1
    event: session.created
    actions:
      - bash: "echo ready"
`);
	const result = loadDiscoveredHooks({ projectDir: projectDir });
	assert.equal(result.sources.length, 0);
	assert.ok(!result.hooks.has("session.created"));
});

test("loadDiscoveredHooks: invalid project hooks stay skipped even when trusted", () => {
	clearConfigs();
	writeProject(`
hooks:
  - id: broken
    event: nope
    actions:
      - bash: "echo ready"
`);
	mkdirSync(join(agentDir), { recursive: true });
	writeFileSync(trustedProjectsFilePath(), `${JSON.stringify([projectDir], null, 2)}\n`);
	__resetTrustListCacheForTests();

	const result = loadDiscoveredHooks({ projectDir: projectDir });
	assert.equal(result.sources.length, 0);
	assert.ok(result.errors.some((e) => e.code === "invalid_event"));
});

test("loadDiscoveredHooks: project overrides replace global hooks by id", () => {
	clearConfigs();
	writeGlobal(`
hooks:
  - id: idle
    event: session.idle
    actions:
      - notify: "global"
`);
	writeProject(`
hooks:
  - override: idle
    event: session.idle
    actions:
      - notify: "project"
`);
	mkdirSync(join(agentDir), { recursive: true });
	writeFileSync(trustedProjectsFilePath(), `${JSON.stringify([projectDir], null, 2)}\n`);
	__resetTrustListCacheForTests();

	const result = loadDiscoveredHooks({ projectDir: projectDir });
	const idleHooks = result.hooks.get("session.idle") ?? [];
	assert.equal(idleHooks.length, 1);
	assert.equal(idleHooks[0]?.actions[0]?.notify, "project");
});

test("loadDiscoveredHooks: invalid YAML parse errors are reported", () => {
	clearConfigs();
	writeGlobal("hooks: [ { broken");
	const result = loadDiscoveredHooks({ projectDir: projectDir });
	assert.ok(result.errors.some((e) => e.code === "invalid_frontmatter"));
	assert.equal(result.sources.length, 0);
});
