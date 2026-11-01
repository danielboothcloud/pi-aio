import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	approvalScopes,
	canonicalPath,
	findOutsideTargets,
	isWithin,
	mutationTargetPaths,
	resolveToolPath,
} from "./workspace-guard.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "aio-workspace-guard-")));
const root = join(tmp, "repo");
const sibling = join(tmp, "repo-sibling");
mkdirSync(join(root, "src", "deep"), { recursive: true });
mkdirSync(sibling, { recursive: true });
writeFileSync(join(sibling, "secret.txt"), "x");
symlinkSync(sibling, join(root, "link-out"));
symlinkSync(join(sibling, "secret.txt"), join(root, "file-link.txt"));
symlinkSync(join(root, "src"), join(root, "link-in"));

test.after(() => rmSync(tmp, { recursive: true, force: true }));

function outside(tool: string, input: Record<string, unknown>, allowed: string[] = []) {
	return findOutsideTargets(tool, input, root, allowed, root).map((target) => target.resolved);
}

test("paths inside the working directory and its subdirectories are allowed", () => {
	for (const path of [
		"a.ts",
		"./src/deep/new/file.ts",
		join(root, "src", "x.ts"),
		"@src/x.ts",
		"src/../b.ts",
		".",
		"link-in/inner.ts",
	]) {
		assert.deepEqual(outside("edit", { path }), [], path);
		assert.deepEqual(outside("write", { path, content: "" }), [], path);
	}
});

test("absolute paths, .., ~, and similarly-named siblings are outside", () => {
	assert.deepEqual(outside("write", { path: join(sibling, "a.ts") }), [join(sibling, "a.ts")]);
	assert.deepEqual(outside("edit", { path: "../repo-sibling/a.ts" }), [join(sibling, "a.ts")]);
	// `repo-sibling` shares the `repo` prefix but is not inside it.
	assert.equal(isWithin(root, sibling), false);
	assert.equal(outside("edit", { path: "~/x.txt" }).length, 1);
	assert.equal(outside("write", { file_path: "/etc/hosts" }).length, 1);
});

test("symlinks cannot smuggle a write out of the workspace", () => {
	assert.deepEqual(outside("write", { path: "link-out/new.ts" }), [join(sibling, "new.ts")]);
	assert.deepEqual(outside("edit", { path: "file-link.txt" }), [join(sibling, "secret.txt")]);
});

test("apply_patch checks every structured path, move destination, and unified diff file", () => {
	const changes = [
		{ path: "src/a.ts", action: "update", oldText: "a", newText: "b" },
		{ path: "src/b.ts", action: "move", movePath: join(sibling, "b.ts") },
	];
	assert.deepEqual(outside("apply_patch", { changes }), [join(sibling, "b.ts")]);
	assert.deepEqual(mutationTargetPaths("apply_patch", { changes }), [
		"src/a.ts",
		"src/b.ts",
		join(sibling, "b.ts"),
	]);
	const patch = `--- a/${join(sibling, "c.ts")}\n+++ b/${join(sibling, "c.ts")}\n@@ -1 +1 @@\n-a\n+b\n`;
	const paths = mutationTargetPaths("apply_patch", { patch });
	assert.ok(paths.length > 0, "unified diff targets are parsed");
	assert.ok(outside("apply_patch", { patch }).length > 0);
});

test("allowed roots and the process cwd base are honored", () => {
	assert.deepEqual(outside("write", { path: join(sibling, "a.ts") }, [sibling]), []);
	// A relative path is checked against both the session cwd and the base the
	// tools actually resolve against; outside either one is outside.
	const targets = findOutsideTargets("edit", { path: "a.ts" }, root, [], sibling);
	assert.deepEqual(targets.map((target) => target.resolved), [join(sibling, "a.ts")]);
});

test("non-file tools and empty paths are ignored", () => {
	assert.deepEqual(outside("bash", { command: "echo > /etc/hosts" }), []);
	assert.deepEqual(outside("edit", {}), []);
	assert.deepEqual(outside("edit", { path: "  " }), []);
});

test("resolution helpers mirror Pi's tool path handling", () => {
	assert.equal(resolveToolPath("~", "/x"), homedir());
	assert.equal(resolveToolPath("~/a", "/x"), join(homedir(), "a"));
	assert.equal(resolveToolPath("@a/b", "/x"), "/x/a/b");
	assert.equal(resolveToolPath("a\u00A0b", "/x"), "/x/a b");
	assert.equal(canonicalPath(join(root, "link-in", "nope", "x.ts")), join(root, "src", "nope", "x.ts"));
	assert.deepEqual(
		approvalScopes([
			{ raw: "a", resolved: join(sibling, "a.ts") },
			{ raw: "b", resolved: join(sibling, "b.ts") },
		]),
		[sibling],
	);
});
