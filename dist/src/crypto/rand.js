function getCrypto() {
	if (typeof globalThis.crypto !== "undefined") {
		return globalThis.crypto;
	}
	// Node 19+ has globalThis.crypto, but for older versions:
	throw new Error("No crypto available - are you in Node < 19?");
}
// For Node 15-18, you might need top-level await or lazy init:
let cryptoModule = null;
export function getSubtleCrypto() {
	if (typeof window !== "undefined" && window.crypto) {
		return window.crypto.subtle;
	} else {
		const webcrypto = getCrypto();
		return webcrypto.subtle;
	}
}
export function getRandomValues(array) {
	if (typeof window !== "undefined" && window.crypto) {
		return window.crypto.getRandomValues(array);
	} else {
		const webcrypto = getCrypto();
		return webcrypto.getRandomValues(array);
	}
}
