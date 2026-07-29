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

export function withTimeoutSignal(
	signal: AbortSignal | undefined,
	timeoutMs: number,
): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function abortable<T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	throwIfAborted(signal);
	if (!signal) return promise;

	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));

	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
