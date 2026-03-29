import { createAccBuilder, type UnifiedAccessControlCondition } from "@lit-protocol/access-control-conditions";
import { type Address, type Hex, zeroAddress } from "viem";
import { type Gadget, type GadgetDescriptor } from "./types.js";
import { AppConfig } from "../../config.js";

export interface SettledGadgetParams {
    /** keccak256(owner, schemaId, tag) — derived at upload time */
    resourceId: Hex;
    /** SettlementRegistry contract address */
    settlementRegistryAddress: Address;
    /** "arbitrumSepolia" | "baseSepolia" */
    chainName: string;
}

/**
 * Build a new default gadget from the given config
 * @param config : AppConfig
 * @returns the configured gadget
 */
export function makeSettledGadgetFactory(config: AppConfig) {
    return (resourceId: Hex): SettledGadget => new SettledGadget({
        resourceId,
        settlementRegistryAddress: config.settlementRegistryContractAddress,
        chainName: config.chainName,
    })
}

export class SettledGadget implements Gadget {
    readonly type = "settled";

    constructor(private readonly params: SettledGadgetParams) { }

    // No hook/params (SettlementRegistry writes isSettled directly after ZK proof verification)
    hookAddress(): Address { return zeroAddress; }
    hookParams(): Hex { return "0x"; }

    toAccessCondition(): UnifiedAccessControlCondition[] {
        return createAccBuilder()
            .custom({
                conditionType: "evmContract",
                contractAddress: this.params.settlementRegistryAddress,
                chain: "arbitrumSepolia",
                functionName: "isSettled",
                functionParams: [":userAddress", this.params.resourceId],
                functionAbi: {
                    name: "isSettled",
                    type: "function",
                    stateMutability: "view",
                    inputs: [
                        { name: "stealth_address", type: "address" },
                        { name: "resource_id", type: "bytes32" },
                    ],
                    outputs: [{ name: "", type: "bool" }],
                },
                returnValueTest: {
                    key: "",
                    comparator: "=",
                    value: "true",
                },
            })
            .build();
    }

    toDescriptor(): GadgetDescriptor {
        const acc = this.toAccessCondition();
        return {
            type: this.type,
            description: "Settlement-gated: SettlementRegistry.isSettled(resourceId, caller)",
            hookAddress: this.hookAddress(),
            acc,
            params: {
                resourceId: this.params.resourceId,
                settlementRegistryAddress: this.params.settlementRegistryAddress,
                chainName: this.params.chainName,
            },
        };
    }
}
