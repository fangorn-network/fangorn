// import { LitClient } from "@lit-protocol/lit-client";
// import { AccessCondition } from "../../../../types/types";
// import { createAccBuilder } from "@lit-protocol/access-control-conditions";

// class LitKeyProvider implements KeyProvider {
//   constructor(
//     private litClient: LitClient,
//     private chain: string,
//     private litActionCid?: string,  // for custom actions
//   ) {}

//   async wrapKey(key: Uint8Array, condition: AccessCondition) {
//     const acc = this.toACC(condition);
//     const encrypted = await this.litClient.encrypt({
//       dataToEncrypt: key,
//       unifiedAccessControlConditions: acc,
//       chain: this.chain,
//     });
//     return {
//       provider: 'lit',
//       ciphertext: encrypted.ciphertext,
//       dataToEncryptHash: encrypted.dataToEncryptHash,
//       acc,
//     };
//   }

//   async unwrapKey(wrapped: WrappedKey, authContext: unknown) {
//     const result = await this.litClient.decrypt({
//       ciphertext: wrapped.ciphertext as string,
//       dataToEncryptHash: wrapped.dataToEncryptHash as string,
//       unifiedAccessControlConditions: wrapped.acc,
//       authContext,
//       chain: this.chain,
//     });
//     return result.decryptedData as Uint8Array;
//   }

//   private toACC(condition: AccessCondition) {
//     // Translate generic condition to LIT ACC format
//     // ...
//     // 1. map the condition to a well defined lit action (template)
//     const { litActionCid, functionName, argumentsBuild } = { "", "", ....  };

//     createAccBuilder().requireLitAction(
//         litActionCid,
//         functionName,
//         [],
//         "true",
//     ).build();
//   }
// }

// // // Simple backend that holds keys and checks conditions server-side
// // class BackendKeyProvider implements KeyProvider {
// //   constructor(private apiUrl: string) {}

// //   async wrapKey(key: Uint8Array, condition: AccessCondition) {
// //     const response = await fetch(`${this.apiUrl}/keys`, {
// //       method: 'POST',
// //       headers: { 'Content-Type': 'application/json' },
// //       body: JSON.stringify({
// //         key: bytesToBase64(key),
// //         condition
// //       }),
// //     });
// //     const { keyId } = await response.json();
// //     return { provider: 'backend', keyId };
// //   }

// //   async unwrapKey(wrapped: WrappedKey, authContext?: { token: string }) {
// //     const response = await fetch(`${this.apiUrl}/keys/${wrapped.keyId}`, {
// //       headers: { Authorization: `Bearer ${authContext?.token}` },
// //     });
// //     if (!response.ok) throw new Error('Access denied');
// //     const { key } = await response.json();
// //     return base64ToBytes(key);
// //   }
// // }
