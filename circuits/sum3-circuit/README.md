# noir guide

examples
https://github.com/vlayer-xyz/monorepo/tree/main/ethereum/circuits

setup

```sh
curl -L https://raw.githubusercontent.com/noir-lang/noirup/refs/heads/main/install | bash
noirup
```

```sh
# create hello_world/src/main.nr
nargo new hello_world
cd hello_world
# creates prover.toml
nargo check
```

Generate witness, compile, execute

```sh
nargo execute
```

## Backend

Noir is a high-level programming language for zero-knowledge proofs, which compiles your code into ACIR and generates witnesses for further proof generations and verifications. In order to prove and verify your Noir programs, you'll need a proving backend.

-> Barratenburg guide here

We use barretenburg to verify proofs

install

```sh
curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/refs/heads/next/barretenberg/bbup/install | bash
bbup
```

generate the proof

```sh
bb prove -b ./target/circuit.json -w ./target/circuit.gz --write_vk -o target
```

generate the proof with a vk

```sh
bb prove -b ./target/circuit.json -w ./target/circuit.gz -k ./target/vk -o target
```

verify a proof

```sh
bb verify -p ./target/proof -k ./target/vk
```

### Generate a solidity verifier

```sh
# Generate the verification key. You need to pass the `--oracle_hash keccak` flag when generating vkey and proving
# to instruct bb to use keccak as the hash function, which is more optimal in Solidity
bb write_vk -b ./target/circuit.json -o ./target --oracle_hash keccak
# Generate the Solidity verifier from the vkey
bb write_solidity_verifier -k ./target/vk -o ./target/Verifier.sol --optimized
```

the contract is pretty huge

```sh
#  bash Install foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Compile with optimization
forge build --optimize --optimizer-runs 1
```

### writing a webapp with noir + bb

https://noir-lang.org/docs/tutorials/noirjs_app

```sh
pnpm add @noir-lang/noir_js@1.0.0-beta.15 @aztec/bb.js@3.0.0-rc.2 buffer vite vite-plugin-node-polyfills@0.17.0 @noir-lang/noir_wasm @noir-lang/acvm_js @noir-lang/noirc_abi
```
