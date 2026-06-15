import { HandleFieldInput } from "./types";

export interface EncryptAndUploadParams {
    plaintext: Uint8Array;
    manifestId: string;       
    fieldName: string;        
    storage: {
        // R2 worker upload endpoint
        workerUrl: string;    
        // Privy JWT for the worker
        authToken: string;    
        contentType: string;
    };
    teeEndpoint: string;
    // defaults to "tee-aes-v1"
    gadget?: string;          
}

export async function encryptAndUpload(
    params: EncryptAndUploadParams
): Promise<HandleFieldInput> {
    const { plaintext, manifestId, fieldName, storage, teeEndpoint, gadget = "tee-aes-v1" } = params;
    
    // encrypt via TEE
    const encRes = await fetch(`${teeEndpoint}/encrypt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            manifest_id: manifestId,
            field_name: fieldName,
            plaintext_b64: plaintext.toBase64(),
        }),
    });

    if (!encRes.ok) throw new Error(`TEE encrypt failed: ${encRes.status}`);
    const { ciphertext_b64, ciphertext_hash } = await encRes.json();
    const ciphertext = Uint8Array.fromBase64(ciphertext_b64);
    
    // upload ciphertext to worker (which now writes opaque bytes to R2)
    const uploadRes = await fetch(`${storage.workerUrl}/upload`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${storage.authToken}`,
            "Content-Type": storage.contentType,
        },
        body: ciphertext,
    });
    if (!uploadRes.ok) throw new Error(`upload failed: ${uploadRes.status}`);
    const { objectKey } = await uploadRes.json();
    
    return {
        "@type": "handle",
        uri: objectKey,
        workerUrl: storage.workerUrl,
        encryption: { gadget, ciphertextHash: ciphertext_hash },
    };
}