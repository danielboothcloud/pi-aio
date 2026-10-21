import { marked, type Token, type Tokens } from "marked";

type CopyableKind = "code" | "quote";

export interface CopyableBlock {
	kind: CopyableKind;
	/** Clipboard contents: code without fences, or quote text without `>` markers. */
	text: string;
	/** Fence info string (code blocks only). */
	info?: string;
	/** First info-string word (code blocks only). */
	language?: string;
	lineCount: number;
	ordinal: number;
}

const FENCED_CODE_START = /^ {0,3}(`{3,}|~{3,})/;
const HARD_BREAK = /( {2,}|\\)$/;

function isFencedCodeToken(token: Tokens.Code): boolean {
	return FENCED_CODE_START.test(token.raw);
}

function getLanguage(info: string | undefined): string | undefined {
	const language = info?.trim().split(/\s+/, 1)[0];
	return language || undefined;
}

function countLines(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

/**
 * Join a paragraph's soft-wrapped source lines with spaces, as Markdown renders
 * them, so pasted text reflows in its destination. Hard breaks (two trailing
 * spaces or a trailing backslash) stay as newlines without their markers.
 */
function unwrapParagraph(source: string): string {
	const [first = "", ...rest] = source.split("\n");
	let result = first;
	for (const line of rest) {
		result = HARD_BREAK.test(result)
			? `${result.replace(HARD_BREAK, "")}\n${line.trimStart()}`
			: `${result.trimEnd()} ${line.trimStart()}`;
	}
	return result;
}

/**
 * Quote contents with one level of `>` markers removed. marked lexes the
 * quote body as child tokens; concatenating their raw source keeps lists,
 * nested quotes, and code intact while paragraphs are unwrapped.
 */
function quoteText(tokens: readonly Token[]): string {
	let text = "";
	for (const token of tokens) {
		if (token.type !== "paragraph") {
			text += token.raw;
			continue;
		}
		const trailing = /\n*$/.exec(token.raw)?.[0] ?? "";
		text += unwrapParagraph(token.raw.slice(0, token.raw.length - trailing.length)) + trailing;
	}
	return text.trim();
}

function collectBlocks(
	tokens: readonly Token[],
	blocks: CopyableBlock[],
	includeQuotes: boolean,
	insideQuote: boolean,
): void {
	for (const token of tokens) {
		if (token.type === "code" && isFencedCodeToken(token)) {
			const info = token.lang?.trim() || undefined;
			blocks.push({
				kind: "code",
				text: token.text,
				info,
				language: getLanguage(info),
				lineCount: countLines(token.text),
				ordinal: blocks.length + 1,
			});
		}

		// Only outermost quotes become items; a nested quote is part of its parent.
		if (token.type === "blockquote" && includeQuotes && !insideQuote) {
			const text = quoteText(token.tokens);
			if (text) {
				blocks.push({
					kind: "quote",
					text,
					lineCount: countLines(text),
					ordinal: blocks.length + 1,
				});
			}
		}

		const nestedInQuote = insideQuote || token.type === "blockquote";
		if (token.type === "list") {
			for (const item of token.items) {
				collectBlocks(item.tokens, blocks, includeQuotes, nestedInQuote);
			}
			continue;
		}

		const childTokens = (token as Token & { tokens?: Token[] }).tokens;
		if (childTokens) {
			collectBlocks(childTokens, blocks, includeQuotes, nestedInQuote);
		}
	}
}

function extract(markdown: string, includeQuotes: boolean): CopyableBlock[] {
	if (markdown.trim().length === 0) return [];
	const blocks: CopyableBlock[] = [];
	collectBlocks(marked.lexer(markdown), blocks, includeQuotes, false);
	return blocks;
}

/** Extract fenced code blocks in source order, excluding their Markdown fences. */
export function extractFencedCodeBlocks(markdown: string): CopyableBlock[] {
	return extract(markdown, false);
}

/**
 * Extract fenced code blocks and top-level block quotes in source order.
 * Code inside a quote is listed both within the quote and on its own.
 */
export function extractCopyableBlocks(markdown: string): CopyableBlock[] {
	return extract(markdown, true);
}
