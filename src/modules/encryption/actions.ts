// Lit action for decryption
// Note: if we want to enable 'computation over private data' using Lit,
// then we need to rethink how encryption works, since as-is anybody can just write a
// Lit action for decryption that would give them full access anyway
export const createDecryptAction = (chainName: string) => `(async () => {
  try {
    const decryptedContent = await Lit.Actions.decryptAndCombine({
      accessControlConditions: jsParams.accessControlConditions,
      ciphertext: jsParams.ciphertext,
      dataToEncryptHash: jsParams.dataToEncryptHash,
      authSig: jsParams.authSig,
      chain: "${chainName}",
    });
    Lit.Actions.setResponse({ response: decryptedContent, success: true });
  } catch (error) {
    Lit.Actions.setResponse({ response: error.message, success: false });
  }
})();`;
