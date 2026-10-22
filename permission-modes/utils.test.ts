import assert from "node:assert/strict";
import test from "node:test";
import { isSafeCommand } from "./utils.ts";

const pythonEdit = "python3 -c 'from pathlib import Path; Path(\"example.ts\").write_text(\"changed\")'";

for (const command of [
	pythonEdit,
	"python3 <<'PY'\nfrom pathlib import Path\nPath('example.ts').write_text('changed')\nPY",
	`echo ready; ${pythonEdit}`,
	`cat README.md && ${pythonEdit}`,
	`pwd || ${pythonEdit}`,
	`ls\n${pythonEdit}`,
	`echo $(${pythonEdit})`,
	"echo `python3 edit.py`",
	"cat <(python3 edit.py)",
	"echo ready & python3 edit.py",
	`env ${pythonEdit}`,
	"find . -exec python3 edit.py {} ;",
	"awk 'BEGIN {system(\"python3 edit.py\")}'",
	"curl -o example.ts https://example.invalid/file",
	"wget -O example.ts https://example.invalid/file",
	"sort -o example.ts input.txt",
	"uniq input.txt example.ts",
	"file -C -m custom.magic",
	"git branch new-branch",
	"git remote add other https://example.invalid/repo",
	"git diff --output=example.ts",
	"git diff",
	"git diff --no-index /dev/null package.json",
	"git log -p",
	"git log --oneline -5",
	"git show HEAD:README.md",
	"git log --output example.ts",
	"rg --pre=python3 pattern .",
	"rg --hostname-bin=python3 pattern .",
	"rg --p''re=python3 pattern .",
	"git diff --out\"put\"=example.ts",
	"rg --{pre,hostname-bin}=python3 pattern .",
	"cat-editor example.ts",
	"git status-extra",
	"fd --exec python3 edit.py",
	"sed -n '1w example.ts' input.txt",
	"jq --run-tests tests.jq",
	"python --version; python3 edit.py",
	"node --version; node edit.js",
	"echo ready > example.ts",
]) {
	test(`isSafeCommand requires approval: ${JSON.stringify(command)}`, () => {
		assert.equal(isSafeCommand(command), false);
	});
}

for (const command of [
	"ls -la",
	"pwd",
	"cat README.md",
	"head -n 20 README.md",
	"tail -n 20 README.md",
	"wc -l README.md",
	"rg -n pattern src",
	"git status --short",
	"git branch --show-current",
	"git remote -v",
	"git ls-files",
	"node --version",
	"python --version",
	"python3 --version",
]) {
	test(`isSafeCommand permits a simple read: ${command}`, () => {
		assert.equal(isSafeCommand(command), true);
	});
}
