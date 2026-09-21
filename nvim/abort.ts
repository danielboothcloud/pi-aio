// Abort helpers for the nvim feature (house mirror of browser-search/abort.ts).

export function abortError(signal?: AbortSignal): Error {
	const reason = signal?.reason;
	if (reason instanceof Error) return reason;
	return new DOMException(
		typeof reason === "string" && reason ? reason : "Operation aborted",
		"AbortError",
	);
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal);
}
