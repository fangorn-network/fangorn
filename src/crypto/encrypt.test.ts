// encryption.test.ts
import { describe, it, expect } from "vitest"; // or jest
import { encryptData, decryptData } from "./encryption";
import { getSubtleCrypto } from "./rand";

describe("encryptData / decryptData", () => {
	it("round-trips string data", async () => {
		const plaintext = "hello world";
		const { encryptedData, keyMaterial } = await encryptData(plaintext);

		const decrypted = await decryptData(encryptedData, keyMaterial);
		const result = new TextDecoder().decode(decrypted);

		expect(result).toBe(plaintext);
	});

	it("round-trips Uint8Array data", async () => {
		const plaintext = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);
		const { encryptedData, keyMaterial } = await encryptData(plaintext);

		const decrypted = await decryptData(encryptedData, keyMaterial);

		expect(decrypted).toEqual(plaintext);
	});

	it("handles empty string", async () => {
		const { encryptedData, keyMaterial } = await encryptData("");
		const decrypted = await decryptData(encryptedData, keyMaterial);

		expect(decrypted.length).toBe(0);
	});

	it("handles empty Uint8Array", async () => {
		const { encryptedData, keyMaterial } = await encryptData(new Uint8Array(0));
		const decrypted = await decryptData(encryptedData, keyMaterial);

		expect(decrypted.length).toBe(0);
	});

	it("handles 1MB", async () => {
		const size = 1024 * 1024;
		const data = new Uint8Array(size);
		for (let i = 0; i < size; i += 65536) {
			crypto.getRandomValues(data.subarray(i, i + Math.min(65536, size - i)));
		}

		const { encryptedData, keyMaterial } = await encryptData(data);
		const decrypted = await decryptData(encryptedData, keyMaterial);

		expect(decrypted).toEqual(data);
	});

	it("profile encryption", async () => {
		const plaintext = new Uint8Array(1024 * 1024); // 1MB zeros

		const subtle = getSubtleCrypto();

		let start = performance.now();
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const keyMaterial = crypto.getRandomValues(new Uint8Array(32));
		console.log(`Random gen: ${performance.now() - start}ms`);

		start = performance.now();
		const key = await subtle.importKey(
			"raw",
			keyMaterial,
			{ name: "AES-GCM" },
			false,
			["encrypt"],
		);
		console.log(`Key import: ${performance.now() - start}ms`);

		start = performance.now();
		const encrypted = await subtle.encrypt(
			{ name: "AES-GCM", iv },
			key,
			plaintext,
		);
		console.log(`Encrypt: ${performance.now() - start}ms`);
	});

	it("handles 10MB", async () => {
		const plaintext = new Uint8Array(10 * 1024 * 1024);

		const { encryptedData, keyMaterial } = await encryptData(plaintext);
		const decrypted = await decryptData(encryptedData, keyMaterial);

		// Fast comparison instead of toEqual
		expect(decrypted.length).toBe(plaintext.length);
		expect(Buffer.compare(Buffer.from(decrypted), Buffer.from(plaintext))).toBe(
			0,
		);
	});

	it("handles unicode strings", async () => {
		const plaintext = "こんにちは世界 🔐 émojis & spëcial çhars";
		const { encryptedData, keyMaterial } = await encryptData(plaintext);

		const decrypted = await decryptData(encryptedData, keyMaterial);
		const result = new TextDecoder().decode(decrypted);

		expect(result).toBe(plaintext);
	});

	it("produces different ciphertext for same plaintext (random IV)", async () => {
		const plaintext = "test data";
		const result1 = await encryptData(plaintext);
		const result2 = await encryptData(plaintext);

		expect(result1.encryptedData.ciphertext).not.toEqual(
			result2.encryptedData.ciphertext,
		);
		expect(result1.encryptedData.iv).not.toEqual(result2.encryptedData.iv);
	});

	it("fails decryption with wrong key", async () => {
		const { encryptedData } = await encryptData("secret");
		const wrongKey = new Uint8Array(32);
		crypto.getRandomValues(wrongKey);

		await expect(decryptData(encryptedData, wrongKey)).rejects.toThrow();
	});

	it("fails decryption with tampered ciphertext", async () => {
		const { encryptedData, keyMaterial } = await encryptData("secret");

		// Tamper with ciphertext
		encryptedData.ciphertext[0] ^= 0xff;

		await expect(decryptData(encryptedData, keyMaterial)).rejects.toThrow();
	});

	it("fails decryption with tampered IV", async () => {
		const { encryptedData, keyMaterial } = await encryptData("secret");

		encryptedData.iv[0] ^= 0xff;

		await expect(decryptData(encryptedData, keyMaterial)).rejects.toThrow();
	});

	it("handles JSON-serialized data (object format)", async () => {
		const { encryptedData, keyMaterial } = await encryptData("test");

		// Simulate JSON round-trip (Uint8Array becomes object)
		const serialized = JSON.parse(JSON.stringify(encryptedData));

		const decrypted = await decryptData(serialized, keyMaterial);
		expect(new TextDecoder().decode(decrypted)).toBe("test");
	});

	it("generates correct key and IV sizes", async () => {
		const { encryptedData, keyMaterial } = await encryptData("test");

		expect(keyMaterial.length).toBe(32); // AES-256
		expect(encryptedData.iv.length).toBe(12); // GCM standard
	});
});
