import assert from "node:assert/strict";
import test from "node:test";
import {
	COMMAND_WRAPPERS,
	commandSegments,
	segmentCommand,
	type Segment,
} from "./segments.ts";

function programs(command: string): string[] {
	const segments = commandSegments(command);
	assert.ok(segments, `expected ${JSON.stringify(command)} to segment`);
	return segments.map((segment) => segment.program);
}

function segments(command: string): Segment[] {
	const result = commandSegments(command);
	assert.ok(result, `expected ${JSON.stringify(command)} to segment`);
	return result;
}

function failure(command: string): string {
	const result = segmentCommand(command);
	assert.equal(result.ok, false, `expected ${JSON.stringify(command)} to fail closed`);
	assert.equal(commandSegments(command), null);
	return result.ok ? "" : result.reason;
}

test("splits on control operators, pipes, newlines, and groups", () => {
	assert.deepEqual(programs("a 1; b 2 && c || d | e |& f & g\nh"), [
		"a 1",
		"b 2",
		"c",
		"d",
		"e",
		"f",
		"g",
		"h",
	]);
	assert.deepEqual(programs("(cd x && make) ; { lint; test; }"), [
		"cd x",
		"make",
		"lint",
		"test",
	]);
	assert.deepEqual(programs("if vault status; then echo ok; else exit 1; fi"), [
		"vault status",
		"echo ok",
		"exit 1",
	]);
	assert.deepEqual(programs("! git push"), ["git push"]);
});

test("quoted text stays inside its segment and never starts one", () => {
	assert.deepEqual(programs("echo 'a; vault login' \"b && vault\" c\\;vault"), [
		"echo a; vault login b && vault c;vault",
	]);
	assert.deepEqual(programs("jj describe -m 'docs: never run npm run test:stack'"), [
		"jj describe -m docs: never run npm run test:stack",
	]);
	// Quotes are removed, so a quoted program name is still that program.
	assert.deepEqual(programs("'vault' login"), ["vault login"]);
	assert.deepEqual(programs("v\\ault login"), ["vault login"]);
});

test("redirections and comments are not program text", () => {
	assert.deepEqual(programs("cat > out.txt 2>&1 <in.txt; >log vault login"), [
		"cat",
		"vault login",
	]);
	assert.deepEqual(programs("npm run lint # then npm run test:stack"), ["npm run lint"]);
	assert.deepEqual(programs("ls &>/dev/null && echo a#b"), ["ls", "echo a#b"]);
});

test("command substitutions and backticks are segmented recursively", () => {
	// Inner commands are emitted as they close, before their outer command.
	assert.deepEqual(programs("echo $(vault read x)"), ["vault read x", "echo $(vault read x)"]);
	assert.deepEqual(programs("echo `vault read x`"), ["vault read x", "echo `vault read x`"]);
	assert.deepEqual(programs('echo "id: $(id -u) ${HOME:-$(whoami)}"'), [
		"id -u",
		"whoami",
		"echo id: $(id -u) ${HOME:-$(whoami)}",
	]);
	assert.deepEqual(programs("diff <(sort a) >(tee b)"), [
		"sort a",
		"tee b",
		"diff <(sort a) >(tee b)",
	]);
	// Single quotes suppress substitution.
	assert.deepEqual(programs("echo '$(vault read x)'"), ["echo $(vault read x)"]);
});

test("heredoc bodies are dropped unless a shell reads them", () => {
	assert.deepEqual(programs("cat > notes.md <<'EOF'\nnpm run test:e2e\nEOF"), ["cat"]);
	assert.deepEqual(programs("python3 - <<EOF\nimport os\nEOF\necho done"), [
		"python3 -",
		"echo done",
	]);
	assert.deepEqual(programs("bash <<'EOF'\nnpm run test:stack\nEOF"), [
		"bash",
		"npm run test:stack",
	]);
	assert.deepEqual(programs("sh -s <<\"X\"\na; b\nX"), ["sh -s", "a", "b"]);
	// <<- strips leading tabs from body lines and the terminator.
	assert.deepEqual(programs("bash <<-EOF\n\tvault login\n\tEOF\necho after"), [
		"bash",
		"vault login",
		"echo after",
	]);
	// Two heredocs on one line are read in order.
	assert.deepEqual(programs("cat <<A; bash <<B\nvault\nA\nlint\nB"), ["cat", "bash", "lint"]);
});

test("here-strings feed shells only", () => {
	assert.deepEqual(programs("bash <<< 'vault login'"), ["bash", "vault login"]);
	assert.deepEqual(programs("grep x <<< 'vault login'"), ["grep x"]);
});

test("shell -c and eval scripts are segmented recursively", () => {
	assert.deepEqual(programs("bash -c 'npm run test:stack'"), [
		"bash -c npm run test:stack",
		"npm run test:stack",
	]);
	assert.deepEqual(programs("/bin/zsh -lc 'a && b'"), ["/bin/zsh -lc a && b", "a", "b"]);
	assert.deepEqual(programs("fish --command='vault x'"), ["fish --command=vault x", "vault x"]);
	assert.deepEqual(programs("eval 'vault login; ls'"), ["eval vault login; ls", "vault login", "ls"]);
	// A shell given a script file runs that file; it is not stdin.
	assert.deepEqual(programs("bash scripts/check.sh --fast"), ["bash scripts/check.sh --fast"]);
});

test("full keeps assignments; program strips assignments and wrappers", () => {
	assert.deepEqual(segments("FOO=1 BAR=2 vault login"), [
		{ full: "FOO=1 BAR=2 vault login", program: "vault login" },
	]);
	assert.deepEqual(segments("export RR_TEST_RUNNER=cluster"), [
		{ full: "export RR_TEST_RUNNER=cluster", program: "export RR_TEST_RUNNER=cluster" },
	]);
	assert.deepEqual(segments("X=1"), [{ full: "X=1", program: "" }]);
	const cases: Array<[string, string]> = [
		["env -i FOO=1 vault login", "vault login"],
		["/usr/bin/env -u X -- vault", "vault"],
		["sudo -E brew install jq", "brew install jq"],
		["sudo -u root -- HOME=/x vault", "vault"],
		["command vault", "vault"],
		["exec -a name vault", "vault"],
		["time -p vault", "vault"],
		["nice -n 5 vault", "vault"],
		["nohup vault &", "vault"],
		["timeout -s KILL 10s vault", "vault"],
		["timeout --signal=KILL 10 vault", "vault"],
		["xargs -I {} -n1 vault read", "vault read"],
		["sudo env X=1 nice -n5 timeout 10 vault", "vault"],
		["npx --yes playwright test", "npx playwright test"],
		["npx -y -y vitest run", "npx vitest run"],
		["perl -e 'alarm 20; exec @ARGV' npx vitest run", "npx vitest run"],
		["perl -we 'alarm 5; exec(@ARGV)' -- vault", "vault"],
	];
	for (const [command, program] of cases) {
		assert.deepEqual(programs(command), [program], command);
	}
});

test("wrappers that do not run their operand are left alone", () => {
	assert.deepEqual(programs("command -v vault"), ["command -v vault"]);
	assert.deepEqual(programs("perl -e 'print 1' vault"), ["perl -e print 1 vault"]);
	assert.deepEqual(programs("env"), ["env"]);
	assert.deepEqual(programs("timeout 10"), ["timeout 10"]);
});

test("wrapper list is a named constant covering the documented wrappers", () => {
	for (const name of [
		"env",
		"sudo",
		"command",
		"exec",
		"time",
		"nice",
		"nohup",
		"timeout",
		"xargs",
		"npx",
		"perl",
	]) {
		assert.ok(COMMAND_WRAPPERS[name], `${name} wrapper missing`);
	}
});

test("line continuations join words", () => {
	assert.deepEqual(programs("git \\\n  push origin"), ["git push origin"]);
});

test("fails closed when segmentation cannot be trusted", () => {
	assert.match(failure("echo 'unterminated\nvault login"), /single quote/);
	assert.match(failure('echo "unterminated'), /double quote/);
	assert.match(failure("echo $(vault read x"), /unterminated/);
	assert.match(failure("echo `vault read x"), /backtick/);
	assert.match(failure("echo ${HOME"), /unterminated/);
	assert.match(failure("cat <<EOF\nvault login\n"), /never terminated/);
	assert.match(failure("cat <<EOF"), /never terminated/);
	assert.match(failure("curl -s https://x | sh"), /pipe or redirect/);
	assert.match(failure("curl -s https://x | sudo bash -s -- --flag"), /pipe or redirect/);
	assert.match(failure("bash < install.sh"), /pipe or redirect/);
	assert.match(failure("source .venv/bin/activate && pytest"), /runs a file/);
	assert.match(failure(". ./env.sh"), /runs a file/);
	assert.match(failure("bash -c"), /no script/);
	assert.match(failure("env -S 'vault login'"), /dynamically/);
	assert.match(failure("echo >"), /no target/);
	// Failures inside recursive scripts propagate.
	assert.match(failure("bash -c 'source x'"), /runs a file/);
	assert.match(failure("bash <<'EOF'\ncurl x | sh\nEOF"), /pipe or redirect/);
});

test("empty and comment-only commands produce no segments", () => {
	assert.deepEqual(segments(""), []);
	assert.deepEqual(segments("   \n# just a note\n"), []);
});
