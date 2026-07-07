function getCrypto(): Crypto {
	if (typeof globalThis.crypto !== "undefined") {
		return globalThis.crypto;
	}

	// Node 19+ has globalThis.crypto, but for older versions:
	throw new Error("No crypto available - are you in Node < 19?");
}

export function getSubtleCrypto(): SubtleCrypto {
	if (typeof window !== "undefined") {
		return window.crypto.subtle;
	} else {
		const webcrypto = getCrypto();
		return webcrypto.subtle;
	}
}

export function getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    if (typeof window !== "undefined") {
        // We cast the parameter to satisfy the strict crypto signature
        return window.crypto.getRandomValues(array);
    } else {
        const webcrypto = getCrypto();
        return webcrypto.getRandomValues(array);
    }
}