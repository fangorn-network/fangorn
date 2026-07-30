/**
 * Small, dependency-free helpers shared across the SDK. Nothing here knows
 * about storage, chains or graphs — keep it that way.
 */

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Anything thrown, as an `Error`. */
export function toError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}

/** A human-readable message for anything thrown. */
export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	// eslint-disable-next-line @typescript-eslint/no-base-to-string
	return String(err ?? "");
}

/** Concatenate byte arrays into one buffer. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
