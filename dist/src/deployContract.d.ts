import { type Account, type Address } from "viem";
/**
 * Deploys any contract by name from the local contracts directory.
 */
export declare function deployContract({ account, contractName, constructorArgs, }: {
    account: Account;
    contractName: string;
    constructorArgs?: any[];
}): Promise<{
    address: Address;
    abi: any;
}>;
