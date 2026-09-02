import { Hex, WalletClient } from "viem";
import { AppConfig } from "../config.js";
import { AppRegistryClient } from "../contracts/app-registry/index.js";
import { DataRegistryClient } from "../contracts/data-registry/index.js";
import { SettlementRegistryClient } from "../contracts/settlement-registry/index.js";
import { SubscriptionRegistryClient } from "../contracts/subscription-registry/index.js";
import { MetadataStorage } from "../providers/storage/types.js";

export interface FangornContext {
    config: AppConfig;
    walletClient: WalletClient;
    metadataStorage: MetadataStorage | undefined;
    // workerUrl: string | undefined;
    domain: string;
    dataRegistry: DataRegistryClient;
    appRegistry: AppRegistryClient;
    subscriptionRegistry: SubscriptionRegistryClient;
    settlementRegistry: SettlementRegistryClient;
    // The app the caller explicitly chose using`create({ appId })` or `setAppId()`.
    // Undefined when the app id is only the DEFAULT_APP fallback, which is why this
    // is not just `dataRegistry.getAppId()`. The signed-url uploads bill an app owner's
    // storage subscription, and defaulting to `fangorn` would spend the default
    // app owner's quota on behalf of a caller who didn't choose an app.
    appScope: Hex | undefined;
}

export type StorageConfig =
    // Bring your own Pinata JWT + gateway.
    | { pinata: { jwt: string; gateway: string } }
    // No JWT: prove wallet ownership to the presigned-URL worker and upload via
    // the short-lived URLs it issues; read from a public IPFS gateway. Both
    // fields optional — workerUrl defaults to the hosted pinata-url-provider,
    // gateway to config.ipfsGateway.
    | { signedUrl: { workerUrl?: string; gateway?: string } };

export interface FangornCreateOptions {
    storage?: StorageConfig;
    // workerUrl?: string;
    config?: AppConfig;
    // The app (global namespace) every commit this client makes or watches is
    // scoped under a human-readable name or a 32-byte app id. Defaults to
    // `DEFAULT_APP`. This can be switched later with `fangorn.setAppId()`. Naming one also
    // bills signed-url uploads to that app owner's storage subscription. The default
    // does not (see FangornContext.appScope).
    appId?: string;
    domain?: string;
    privateKey?: Hex;
    walletClient?: WalletClient;
}