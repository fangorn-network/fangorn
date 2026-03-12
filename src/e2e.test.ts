import { beforeAll, describe, it, expect } from "vitest";
import {
    Account,
    createPublicClient,
    createWalletClient,
    Hex,
    http,
    WalletClient,
    type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deployContract } from "./deployContract.js";
import { TestBed } from "./test/testbed.js";
import { arbitrumSepolia, baseSepolia } from "viem/chains";
import { DataSourceRegistry } from "./interface/datasource-registry/dataSourceRegistry.js";

const getEnv = (key: string) => {
    const value = process.env[key];
    if (!value) throw new Error(`Environment variable ${key} is not set`);
    return value;
};

describe("Fangorn basic encryption works", () => {
    let jwt: string;
    let gateway: string;

    let delegatorAccount: Account;
    let delegateeAccount: Account;
    let delegatorWalletClient: WalletClient;
    let delegateeWalletClient: WalletClient;

    let usdcContractAddress: Address;
    let dataSourceRegistryAddress: Address;
    let schemaRegistryAddress: Address;
    let settlementTrackerAddress: Address;

    let rpcUrl: string;
    let chainName: string;
    let usdcDomainName: string;
    let caip2: number;

    // schema registered once and shared across tests
    let testSchemaId: Hex;

    let testbed: TestBed;

    beforeAll(async () => {
        chainName = process.env.CHAIN_NAME!;
        if (!chainName) throw new Error("CHAIN_NAME required");

        usdcDomainName = chainName === "arbitrumSepolia" ? "USD Coin" : "USDC";
        const chain = usdcDomainName === "USDC" ? baseSepolia : arbitrumSepolia;

        rpcUrl = process.env.CHAIN_RPC_URL!;
        if (!rpcUrl) throw new Error("CHAIN_RPC_URL required");

        jwt = process.env.PINATA_JWT!;
        if (!jwt) throw new Error("PINATA_JWT required");

        gateway = process.env.PINATA_GATEWAY!;
        if (!gateway) throw new Error("PINATA_GATEWAY required");

        caip2 = parseInt(process.env.CAIP2!);
        if (!caip2) throw new Error("CAIP2 required");

        delegatorAccount = privateKeyToAccount(getEnv("DELEGATOR_ETH_PRIVATE_KEY") as Hex);
        delegatorWalletClient = createWalletClient({
            account: delegatorAccount,
            transport: http(rpcUrl),
            chain,
        });

        delegateeAccount = privateKeyToAccount(getEnv("DELEGATEE_ETH_PRIVATE_KEY") as Hex);
        delegateeWalletClient = createWalletClient({
            account: delegateeAccount,
            transport: http(rpcUrl),
            chain,
        });

        usdcContractAddress = process.env.USDC_CONTRACT_ADDRESS! as Address;

        // Deploy or reuse SchemaRegistry
        schemaRegistryAddress = process.env.SCHEMA_REGISTRY_ADDR! as Address;
        if (!schemaRegistryAddress) {
            console.log("Deploying SchemaRegistry...");
            const deployment = await deployContract({
                account: delegatorAccount,
                contractName: "SchemaRegistry",
                constructorArgs: [],
                chain,
            });
            schemaRegistryAddress = deployment.address;
            console.log("SchemaRegistry deployed at:", schemaRegistryAddress);
        }

        // Deploy or reuse DataSourceRegistry
        dataSourceRegistryAddress = process.env.DS_REGISTRY_ADDR! as Address;
        if (!dataSourceRegistryAddress) {
            console.log("Deploying DataSourceRegistry...");
            const deployment = await deployContract({
                account: delegatorAccount,
                contractName: "DSRegistry",
                constructorArgs: [],
                chain,
            });
            dataSourceRegistryAddress = deployment.address;
            console.log("DataSourceRegistry deployed at:", dataSourceRegistryAddress);

            console.log("Initializing DataSourceRegistry with SchemaRegistry...");
            const publicClient = createPublicClient({ transport: http(rpcUrl) });
            const dsRegistry = new DataSourceRegistry(
                dataSourceRegistryAddress,
                publicClient,
                delegatorWalletClient,
            );
            await dsRegistry.initialize(schemaRegistryAddress);
            console.log("DataSourceRegistry initialized");
        }

        // Deploy or reuse SettlementTracker
        settlementTrackerAddress = process.env.SETTLEMENT_TRACKER_ADDR! as Address;
        if (!settlementTrackerAddress) {
            console.log("Deploying SettlementTracker...");
            const deployment = await deployContract({
                account: delegatorAccount,
                contractName: "SettlementTracker",
                constructorArgs: [usdcContractAddress],
                chain,
            });
            settlementTrackerAddress = deployment.address;
            console.log("SettlementTracker deployed at:", settlementTrackerAddress);
        }

        console.log(`DataSourceRegistry: ${dataSourceRegistryAddress}`);
        console.log(`SchemaRegistry:     ${schemaRegistryAddress}`);
        console.log(`SettlementTracker:  ${settlementTrackerAddress}`);

        testbed = await TestBed.init(
            delegatorWalletClient,
            delegateeWalletClient,
            jwt,
            gateway,
            dataSourceRegistryAddress,
            schemaRegistryAddress,
            usdcContractAddress,
            rpcUrl,
            chainName,
            "arbitrumSepolia",
            caip2,
        );

        // Register a schema once
        console.log("Registering test schema...");
        testSchemaId = await testbed.registerSchema(
            `fangorn.test.v1.${getRandomIntInclusive(0, 999999)}`,
            "bafy...test-schema-spec",
            "test-agent-id",
        );
        console.log("Test schema registered:", testSchemaId);
    }, 120_000);

    it("should publish a manifest and succeed to decrypt when predicates are satisfied for basic acc", async () => {
        const tag = "test_" + getRandomIntInclusive(0, 101010101);
        const manifest = [
            {
                tag,
                data: "Hello, Fangorn!",
                extension: ".txt",
                fileType: "text/plain",
            },
        ];

        // Upload files
        await testbed.fileUploadEmptyWallet(manifest, testSchemaId);

        // Manifest and entry should now exist
        expect(await testbed.checkManifestExists(delegatorAccount.address)).toBe(true);
        expect(await testbed.checkEntryExists(delegatorAccount.address, tag)).toBe(true);

        // Wait for pinata propagation
        await new Promise((resolve) => setTimeout(resolve, 4_000));

        // Delegatee (empty wallet) should be able to decrypt
        const output = await testbed.tryDecrypt(delegatorAccount.address, tag);
        const outputAsString = new TextDecoder().decode(output);
        expect(outputAsString).toBe(manifest[0].data);
        console.log("Decryption succeeded!");

        // Delegator (has ETH balance) should fail
        let didFail = false;
        try {
            await testbed.tryDecryptDelegator(delegatorAccount.address, tag);
        } catch {
            didFail = true;
        }
        expect(didFail).toBe(true);
    }, 120_000);

    it("should publish a manifest and succeed to decrypt when payment is settled", async () => {
        const tag = "test_" + getRandomIntInclusive(101010101, 111111111);
        const filedata = {
            tag,
            data: "Hello, Fangorn!",
            extension: ".txt",
            fileType: "text/plain",
        };

        const price = "0";

        await testbed.fileUploadPaymentGadget(
            filedata,
            price,
            settlementTrackerAddress,
            jwt,
            testSchemaId,
        );

        expect(await testbed.checkEntryExists(delegatorAccount.address, tag)).toBe(true);
        console.log("Encrypted data under payment settlement condition");

        console.log("Submitting payment...");
        await testbed.payForFile(
            delegatorAccount.address,
            tag,
            price,
            usdcDomainName,
            settlementTrackerAddress,
            delegatorWalletClient,
            rpcUrl,
        );

        const output = await testbed.tryDecryptDelegator(delegatorAccount.address, tag);
        const outputAsString = new TextDecoder().decode(output);
        expect(outputAsString).toBe(filedata.data);
        console.log("Decryption succeeded!");
    }, 120_000);
});

function getRandomIntInclusive(min: number, max: number) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}