# Encryption and Decryption

## Encryption

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
