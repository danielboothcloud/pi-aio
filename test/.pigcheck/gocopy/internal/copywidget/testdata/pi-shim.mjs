// Stand-in for @earendil-works/pi-coding-agent in the copy-widget golden
// generator. getMarkdownTheme colors each Markdown role with one SGR code
// (MD_CODES, shared with the Go test) and highlights "ts" code with one
// 24-bit color per line; other languages get the mdCodeBlock color, as Pi
// does. copyToClipboard records the text, or fails for "FAIL".
export * from "@earendil-works/pi-coding-agent";

export const MD_CODES = {
	mdHeading: 33, mdLink: 34, mdLinkUrl: 94, mdCode: 36, mdCodeBlock: 32, mdCodeBlockBorder: 90,
	mdQuote: 35, mdQuoteBorder: 95, mdHr: 91, mdListBullet: 96,
};
const fg = (role) => (text) => `\x1b[${MD_CODES[role]}m${text}\x1b[39m`;

export function getMarkdownTheme() {
	return {
		heading: fg("mdHeading"),
		link: fg("mdLink"),
		linkUrl: fg("mdLinkUrl"),
		code: fg("mdCode"),
		codeBlock: fg("mdCodeBlock"),
		codeBlockBorder: fg("mdCodeBlockBorder"),
		quote: fg("mdQuote"),
		quoteBorder: fg("mdQuoteBorder"),
		hr: fg("mdHr"),
		listBullet: fg("mdListBullet"),
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
		italic: (text) => `\x1b[3m${text}\x1b[23m`,
		underline: (text) => `\x1b[4m${text}\x1b[24m`,
		strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
		highlightCode: (code, lang) =>
			code.split("\n").map((line) => (lang === "ts" ? `\x1b[38;2;200;120;50m${line}\x1b[39m` : fg("mdCodeBlock")(line))),
	};
}

export const clipboard = [];
export async function copyToClipboard(text) {
	if (text.includes("FAIL")) throw new Error("no clipboard tool");
	clipboard.push(text);
}
