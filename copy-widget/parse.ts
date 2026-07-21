import { marked, type Token, type Tokens } from "marked";

export interface CopyableCodeBlock {
	code: string;
	info?: string;
	language?: string;
	lineCount: number;
	ordinal: number;
}

const FENCED_CODE_START = /^ {0,3}(`{3,}|~{3,})/;

function isFencedCodeToken(token: Tokens.Code): boolean {
	return FENCED_CODE_START.test(token.raw);
}

function getLanguage(info: string | undefined): string | undefined {
	const language = info?.trim().split(/\s+/, 1)[0];
	return language || undefined;
}

function collectFencedCodeBlocks(tokens: readonly Token[], blocks: CopyableCodeBlock[]): void {
	for (const token of tokens) {
		if (token.type === "code" && isFencedCodeToken(token)) {
			const info = token.lang?.trim() || undefined;
			blocks.push({
				code: token.text,
				info,
				language: getLanguage(info),
				lineCount: token.text.length === 0 ? 0 : token.text.split("\n").length,
				ordinal: blocks.length + 1,
			});
		}

		if (token.type === "list") {
			for (const item of token.items) {
				collectFencedCodeBlocks(item.tokens, blocks);
			}
			continue;
		}

		const childTokens = (token as Token & { tokens?: Token[] }).tokens;
		if (childTokens) {
			collectFencedCodeBlocks(childTokens, blocks);
		}
	}
}

/** Extract fenced code blocks in source order, excluding their Markdown fences. */
export function extractFencedCodeBlocks(markdown: string): CopyableCodeBlock[] {
	if (markdown.trim().length === 0) return [];

	const blocks: CopyableCodeBlock[] = [];
	collectFencedCodeBlocks(marked.lexer(markdown), blocks);
	return blocks;
}
