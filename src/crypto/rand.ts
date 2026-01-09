let cachedNodeCrypto: any = null;

function getNodeCrypto() {
	if (!cachedNodeCrypto) {
		const requireFunc = new Function(
			"moduleName",
			"return require(moduleName)",
		);
		cachedNodeCrypto = requireFunc("node:crypto");
	}
	return cachedNodeCrypto;
}

export function getSubtleCrypto(): SubtleCrypto {
	if (typeof window !== "undefined" && window.crypto) {
		return window.crypto.subtle;
	} else {
		const { webcrypto } = getNodeCrypto();
		return webcrypto.subtle as SubtleCrypto;
	}
}

export function getRandomValues(array: Uint8Array): Uint8Array<ArrayBuffer> {
	if (typeof window !== "undefined" && window.crypto) {
		return window.crypto.getRandomValues(array) as Uint8Array<ArrayBuffer>;
	} else {
		const { webcrypto } = getNodeCrypto();
		return webcrypto.getRandomValues(array) as Uint8Array<ArrayBuffer>;
	}
}
