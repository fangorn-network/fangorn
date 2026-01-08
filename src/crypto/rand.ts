export function getSubtleCrypto(): SubtleCrypto {
	if (typeof window !== "undefined" && window.crypto) {
		return window.crypto.subtle;
	} else {
		const { webcrypto } = require("node:crypto");
		return webcrypto.subtle as SubtleCrypto;
	}
}

export function getRandomValues(array: Uint8Array): Uint8Array<ArrayBuffer> {
	if (typeof window !== "undefined" && window.crypto) {
		return window.crypto.getRandomValues(array) as Uint8Array<ArrayBuffer>;
	} else {
		const { webcrypto } = require("node:crypto");
		return webcrypto.getRandomValues(array) as Uint8Array<ArrayBuffer>;
	}
}
