// Shiki stub for the diff-tools golden generator. The Go port takes its
// highlighter as an injected function; the Go test installs the same stub.
// TypeScript code gets one 24-bit color per line (a darker one, which the
// renderer's contrast fix replaces, for comment lines). Python throws, so the
// renderer's plain fallback runs. Other languages come back unchanged.
export async function codeToANSI(code, lang) {
	if (lang === "python") throw new Error("stub: no python grammar");
	if (lang !== "typescript") return `${code}\n`;
	return `${code
		.split("\n")
		.map((line) => (line ? `\x1b[38;2;${line.includes("//") ? "30;30;30" : "200;120;50"}m${line}\x1b[39m` : line))
		.join("\n")}\n`;
}
