#!/usr/bin/env bash
# Regenerate src/contracts/*/abi.ts from the Solidity sources.
# CONTRACTS_DIR defaults to a sibling checkout of fangorn-network/contracts.
set -euo pipefail
dir="${CONTRACTS_DIR:-$(dirname "$0")/../../contracts/solidity}"
gen() { # contract, out dir, const name
	{
		echo "/**"
		echo " * Generated from \`forge inspect $1 abi\` in fangorn-network/contracts"
		echo " * (solidity/src/$1.sol). Regenerate with scripts/gen-abis.sh, do not edit."
		echo " */"
		printf 'export const %s = %s as const;\n' "$3" "$(cd "$dir" && forge inspect "$1" abi --json)"
	} >"src/contracts/$2/abi.ts"
}
gen AppRegistry app-registry APP_REGISTRY_ABI
gen DataRegistry data-registry DATA_REGISTRY_ABI
gen MembershipRegistry membership-registry MEMBERSHIP_REGISTRY_ABI
