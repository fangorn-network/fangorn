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

// describe("large data handling", () => {
//     // Helper to generate random data
//     const randomBytes = (size: number): Uint8Array => {
//         const data = new Uint8Array(size);
//         // crypto.getRandomValues has a 65536 byte limit per call
//         for (let i = 0; i < size; i += 65536) {
//             const chunk = Math.min(65536, size - i);
//             crypto.getRandomValues(data.subarray(i, i + chunk));
//         }
//         return data;
//     };

//     it("handles 1MB", async () => {
//         const plaintext = randomBytes(1024 * 1024);
//         const { encryptedData, keyMaterial } = await encryptData(plaintext);
//         const decrypted = await decryptData(encryptedData, keyMaterial);

//         expect(decrypted).toEqual(plaintext);
//     });

//     it("handles 10MB", async () => {
//         const plaintext = randomBytes(10 * 1024 * 1024);
//         const { encryptedData, keyMaterial } = await encryptData(plaintext);
//         const decrypted = await decryptData(encryptedData, keyMaterial);

//         expect(decrypted).toEqual(plaintext);
//     });

//     it("handles 50MB", async () => {
//         const plaintext = randomBytes(50 * 1024 * 1024);
//         const { encryptedData, keyMaterial } = await encryptData(plaintext);
//         const decrypted = await decryptData(encryptedData, keyMaterial);

//         expect(decrypted).toEqual(plaintext);
//     }, 30000); // Extended timeout

//     it("handles 100MB", async () => {
//         const plaintext = randomBytes(100 * 1024 * 1024);
//         const { encryptedData, keyMaterial } = await encryptData(plaintext);
//         const decrypted = await decryptData(encryptedData, keyMaterial);

//         expect(decrypted).toEqual(plaintext);
//     }, 60000);

//     // Performance benchmark (not a pass/fail test, just informational)
//     it("benchmarks encryption throughput", async () => {
//         const sizes = [
//             1 * 1024 * 1024,   // 1MB
//             10 * 1024 * 1024,  // 10MB
//             50 * 1024 * 1024,  // 50MB
//         ];

//         for (const size of sizes) {
//             const plaintext = randomBytes(size);

//             const encStart = performance.now();
//             const { encryptedData, keyMaterial } = await encryptData(plaintext);
//             const encTime = performance.now() - encStart;

//             const decStart = performance.now();
//             await decryptData(encryptedData, keyMaterial);
//             const decTime = performance.now() - decStart;

//             const sizeMB = size / (1024 * 1024);
//             console.log(`${sizeMB}MB: encrypt ${encTime.toFixed(1)}ms (${(sizeMB / (encTime / 1000)).toFixed(0)} MB/s), decrypt ${decTime.toFixed(1)}ms (${(sizeMB / (decTime / 1000)).toFixed(0)} MB/s)`);
//         }
//     }, 60000);
// });

// describe("integration simulation with key wrapping", () => {
//     // Simulates the Lit flow without actually calling Lit
//     it("simulates full encrypt -> wrap key -> unwrap key -> decrypt flow", async () => {
//         const plaintext = "sensitive data for threshold encryption";

//         // Step 1: Encrypt data with random key
//         const { encryptedData, keyMaterial } = await encryptData(plaintext);

//         // Step 2: Simulate Lit wrapping the key (in reality this goes to Lit)
//         const wrappedKey = simulateLitEncrypt(keyMaterial);

//         // At this point, encryptedData + wrappedKey would be stored/transmitted
//         // The original keyMaterial is discarded

//         // Step 3: Later, when conditions are met, Lit releases the key
//         const unwrappedKey = simulateLitDecrypt(wrappedKey);

//         // Step 4: Decrypt with recovered key
//         const decrypted = await decryptData(encryptedData, unwrappedKey);
//         const result = new TextDecoder().decode(decrypted);

//         expect(result).toBe(plaintext);
//     });

//     it("simulates flow with large data", async () => {
//         const plaintext = new Uint8Array(10 * 1024 * 1024); // 10MB
//         crypto.getRandomValues(plaintext);

//         const { encryptedData, keyMaterial } = await encryptData(plaintext);
//         const wrappedKey = simulateLitEncrypt(keyMaterial);
//         const unwrappedKey = simulateLitDecrypt(wrappedKey);
//         const decrypted = await decryptData(encryptedData, unwrappedKey);

//         expect(decrypted).toEqual(plaintext);
//     }, 30000);

//     // Mock functions - replace with actual Lit integration tests
//     function simulateLitEncrypt(key: Uint8Array): Uint8Array {
//         // In reality: await litNodeClient.encrypt({ ... })
//         return new Uint8Array(key); // Just pass through for simulation
//     }

//     function simulateLitDecrypt(wrappedKey: Uint8Array): Uint8Array {
//         // In reality: await litNodeClient.decrypt({ ... })
//         return new Uint8Array(wrappedKey);
//     }
// });
