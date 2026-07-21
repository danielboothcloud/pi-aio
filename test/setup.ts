import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testHome = mkdtempSync(join(tmpdir(), "aio-questionnaire-tests-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.XDG_CONFIG_HOME;

process.on("exit", () => {
	rmSync(testHome, { recursive: true, force: true });
});
