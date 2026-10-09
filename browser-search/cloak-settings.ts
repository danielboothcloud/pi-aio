/** Browser-only settings: safe to load without Pi's extension loader/SDK. */
export const BROWSER_SEARCH_DEBUG = /^(1|true|yes)$/i.test(
	process.env.BROWSER_SEARCH_DEBUG ?? "",
);

const configuredMaxChars = Number(process.env.BROWSER_SEARCH_CLOAK_MAX_CHARS);
export const CLOAK_MAX_CHARS =
	Number.isSafeInteger(configuredMaxChars) && configuredMaxChars > 0
		? configuredMaxChars
		: 100_000;
