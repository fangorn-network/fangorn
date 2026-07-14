import { describe, it, expect } from 'vitest'; // Swap 'vitest' for '@jest/globals' if using Jest
import {
    AES_KEY_LENGTH,
    GCM_NONCE_LENGTH,
    GCM_TAG_LENGTH,
    aesGcmEncrypt,
    aesGcmDecrypt
} from './aes.js';

describe('AES-256-GCM Primitives', () => {
    // Utility to generate random bytes for testing
    const randomBytes = (length: number) => {
        const arr = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
            arr[i] = Math.floor(Math.random() * 256);
        }
        return arr;
    };

    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();

    describe('Constants', () => {
        it('should export correct cryptographic lengths', () => {
            expect(AES_KEY_LENGTH).toBe(32);
            expect(GCM_NONCE_LENGTH).toBe(12);
            expect(GCM_TAG_LENGTH).toBe(16);
        });
    });

    describe('Encryption and Decryption', () => {
        it('should successfully round-trip encrypt and decrypt data', () => {
            const key = randomBytes(AES_KEY_LENGTH);
            const nonce = randomBytes(GCM_NONCE_LENGTH);
            const plaintext = textEncoder.encode('Super secret test message');

            const sealed = aesGcmEncrypt(key, plaintext, nonce);
            const decrypted = aesGcmDecrypt(key, sealed, nonce);

            expect(textDecoder.decode(decrypted)).toBe('Super secret test message');
        });

        it('should output ciphertext exactly GCM_TAG_LENGTH bytes longer than plaintext', () => {
            const key = randomBytes(AES_KEY_LENGTH);
            const nonce = randomBytes(GCM_NONCE_LENGTH);
            const plaintext = randomBytes(50);

            const sealed = aesGcmEncrypt(key, plaintext, nonce);

            // Ciphertext length = plaintext length + 16 bytes (Auth Tag)
            expect(sealed.length).toBe(plaintext.length + GCM_TAG_LENGTH);
        });

        it('should support empty plaintext payloads', () => {
            const key = randomBytes(AES_KEY_LENGTH);
            const nonce = randomBytes(GCM_NONCE_LENGTH);
            const plaintext = new Uint8Array(0);

            const sealed = aesGcmEncrypt(key, plaintext, nonce);
            expect(sealed.length).toBe(GCM_TAG_LENGTH); // Only the tag remains

            const decrypted = aesGcmDecrypt(key, sealed, nonce);
            expect(decrypted.length).toBe(0);
        });
    });

    describe('Authentication and Tampering', () => {
        it('should throw if the ciphertext is tampered with', () => {
            const key = randomBytes(AES_KEY_LENGTH);
            const nonce = randomBytes(GCM_NONCE_LENGTH);
            const plaintext = textEncoder.encode('Do not alter this message');

            const sealed = aesGcmEncrypt(key, plaintext, nonce);
            
            // Tamper with the ciphertext (flip a bit in the first byte)
            const tamperedSealed = new Uint8Array(sealed);
            tamperedSealed[0] ^= 1;

            expect(() => {
                aesGcmDecrypt(key, tamperedSealed, nonce);
            }).toThrow();
        });

        it('should throw if the authentication tag is tampered with', () => {
            const key = randomBytes(AES_KEY_LENGTH);
            const nonce = randomBytes(GCM_NONCE_LENGTH);
            const plaintext = textEncoder.encode('Tag protection check');

            const sealed = aesGcmEncrypt(key, plaintext, nonce);
            
            // Tamper with the tag (last 16 bytes)
            const tamperedSealed = new Uint8Array(sealed);
            tamperedSealed[tamperedSealed.length - 1] ^= 1;

            expect(() => {
                aesGcmDecrypt(key, tamperedSealed, nonce);
            }).toThrow();
        });

        it('should throw if decrypted with the wrong key', () => {
            const key1 = randomBytes(AES_KEY_LENGTH);
            const key2 = randomBytes(AES_KEY_LENGTH);
            const nonce = randomBytes(GCM_NONCE_LENGTH);
            const plaintext = textEncoder.encode('Wrong key check');

            const sealed = aesGcmEncrypt(key1, plaintext, nonce);

            expect(() => {
                aesGcmDecrypt(key2, sealed, nonce);
            }).toThrow();
        });

        it('should throw if decrypted with the wrong nonce', () => {
            const key = randomBytes(AES_KEY_LENGTH);
            const nonce1 = randomBytes(GCM_NONCE_LENGTH);
            const nonce2 = randomBytes(GCM_NONCE_LENGTH);
            const plaintext = textEncoder.encode('Wrong nonce check');

            const sealed = aesGcmEncrypt(key, plaintext, nonce1);

            expect(() => {
                aesGcmDecrypt(key, sealed, nonce2);
            }).toThrow();
        });
    });
});