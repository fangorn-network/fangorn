# Encryption and Decryption

Fangorn's encryption module is built to be replaceable by many different KMS systems. That is, it can theoretically function over centralized (e.g. a plain key server) or decentralized integration (e.g. LIT protocol). At present, we have only built support for Lit protocol, with more integrations to come in the future.

## Encryption

Encryption is a hybrid scheme, where we encrypt a large message locally under AES GCM using an ephemeral secret key. We then encryption *only the secret key* using Lit protocol.

Note that if the AES is generated with an HKDF or similar, it can be easily recovered by the original encryptor, acting as a free 'trapdoor' for whoever has the esk. 

1. Encrypt with aes gcm
2. encrypt the key with lit
3. set a price, tag, and other metadata
4. upload the two ciphertexts and acc to IPFS and get a cid
5. commit to the cid on chain by committing to a new data source root

$k \xleftarrow{R} \{0, 1\}^{256}$
$ct \xleftarrow{R} AesGcm.Enc(m, k)$
$\hat{ct} \xleftarrow{R} Lit.Enc(k, acc)$
$cid = IPFS.Add(\{ct, \hat{ct}, acc\})$

## Decryption

todo
