import { getSubtleCrypto, getRandomValues } from "./rand.js";
export async function encryptData(data) {
    const subtle = getSubtleCrypto();
    const salt = getRandomValues(new Uint8Array(16));
    const iv = getRandomValues(new Uint8Array(12));
    const keyMaterial = getRandomValues(new Uint8Array(32));
    const key = await subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["encrypt"]);
    const encodedData = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const encryptedContent = await subtle.encrypt({
        name: "AES-GCM",
        iv,
        tagLength: 128,
    }, key, encodedData);
    const ciphertext = encryptedContent.slice(0, encryptedContent.byteLength - 16);
    const authTag = encryptedContent.slice(encryptedContent.byteLength - 16);
    return {
        encryptedData: {
            ciphertext: new Uint8Array(ciphertext),
            iv,
            authTag: new Uint8Array(authTag),
            salt,
        },
        keyMaterial,
    };
}
export async function decryptData(encryptedData, keyMaterial) {
    const subtle = getSubtleCrypto();
    // Ensure these are proper Uint8Arrays (may have been serialized to JSON)
    const ciphertext = toUint8Array(encryptedData.ciphertext);
    const iv = toUint8Array(encryptedData.iv);
    const authTag = toUint8Array(encryptedData.authTag);
    const key = await subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["decrypt"]);
    const dataWithAuthTag = new Uint8Array(ciphertext.length + authTag.length);
    dataWithAuthTag.set(ciphertext, 0);
    dataWithAuthTag.set(authTag, ciphertext.length);
    const decryptedContent = await subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, dataWithAuthTag);
    return new Uint8Array(decryptedContent);
}
function toUint8Array(data) {
    if (data instanceof Uint8Array) {
        return data;
    }
    if (Array.isArray(data)) {
        return new Uint8Array(data);
    }
    return new Uint8Array(Object.values(data));
}
