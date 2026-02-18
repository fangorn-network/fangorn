# data registry contract

## Build

validity check

```sh
cargo stylus check
```

build the lib

```sh
cargo build
```

## Export abi

```sh
cargo stylus export-abi --output abi
```

## Test

### Manual Testing

Install Nitro (blockchain)

```sh
git clone -b release --recurse-submodules https://github.com/OffchainLabs/nitro-testnode.git
cd nitro-testnode
# initialize (first run)
./test-node.bash --init
# on subsequent startups, run without init
./test-node.bash
```

```
./test-node.bash script
```

deploy the contract

> note: the private key is a the private key of a default, funded acct in the Abitrum nitro deployment

```sh
cargo stylus deploy \
  --private-key 0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659  \
  --endpoint http://localhost:8547
```

cargo stylus deploy --private-key-path <KEY_PATH> \
 --endpoint <RPC_ENDPOINT> \
 --args <HEX_ENCODED_ARGS>

cargo stylus deploy --private-key 0xde0e6c1c331fcd8692463d6ffcf20f9f2e1847264f7a3f578cf54f62f05196cb \
 --endpoint https://sepolia-rollup.arbitrum.io/rpc \
 --constructor-args 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
