# data registry contract

## Build

validity check

```sh
cargo stylus check
```

build the lib

```sh
cargo build --release --target wasm32-unknown-unknown
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
