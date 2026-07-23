/**
 * Readability + Markdown helpers.
 *
 * Recreates the extraction strategy pi-web-access uses in `extract.ts` —
 * `@mozilla/readability` fed by `linkedom` for parsing, `turndown` for
 * HTML→Markdown — but applies it to HTML pulled from the self-hosted Camofox /
 * CloakBrowser tiers instead of a raw HTTP fetch. This lets the module extract
 * clean article text (~70% token savings vs raw HTML) without shelling out to
 * the upstream scripts or their vendored `Readability.js` browser build.
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { ReadabilityArticle } from "./types.js";

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});

const NO_CONTENT =
	"Article could not be extracted — the page may be JS-rendered or paywalled. Try the snapshot/evaluate tiers.";

/**
 * Run Mozilla Readability over an HTML string in Node (using linkedom's DOM).
 * Mirrors Readability's `{ title, textContent, excerpt, length }` output but
 * additionally exposes `htmlLength` for truncation decisions.
 */
function runReadability(html: string): ReadabilityArticle {
	const { document } = parseHTML(html);
	// linkedom nodes are structurally compatible with Readability's expectations.
	const reader = new Readability(document as unknown as Document);
	const article = reader.parse();

	return {
		title: article?.title ?? null,
		text: article?.textContent ?? null,
		excerpt: article?.excerpt ?? null,
		length: article?.length ?? 0,
		htmlLength: html.length,
	};
}

/** HTML → Markdown via turndown. Falls back to plain text on failure. */
function htmlToMarkdown(html: string): string {
	try {
		return turndown.turndown(html);
	} catch {
		return textFromHtml(html);
	}
}

/** Best-effort plain-text extraction (equivalent to `document.body.innerText`). */
export function textFromHtml(html: string): string {
	const { document } = parseHTML(html);
	const body = document.body;
	return body?.textContent?.trim() || NO_CONTENT;
}

/**
 * Produce markdown from a page: prefer a readability-cleaned article, fall back
 * to turndown on the raw HTML. Returns `{ content, format, title }`.
 */
export function extractMarkdownFromHtml(html: string): {
	content: string;
	format: "markdown";
	title: string | null;
} {
	const article = runReadability(html);
	if (article.text && article.length > 0) {
		// Readability gives article *content* HTML when available; here we only
		// have text, so emit markdown from the readable text directly.
		return {
			content: article.text,
			format: "markdown",
			title: article.title,
		};
	}
	return {
		content: htmlToMarkdown(html),
		format: "markdown",
		title: article.title,
	};
}
