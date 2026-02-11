import * as crypto from "crypto";
import {
	DecryptParams,
	DecryptResult,
	EncryptParams,
	EncryptResult,
	KMSProvider,
	KMSProviderConfig,
} from "..";
import { AccessControlConditions } from "@lit-protocol/access-control-conditions";

interface StoredKey {
	key: Buffer;
	dataHash: string;
	conditions: AccessControlConditions;
	createdAt: Date;
}

export class MockKMSProvider implements KMSProvider {
	readonly name = "mock";
	private connected = false;
	private keys = new Map<string, StoredKey>();
	private actions = new Map<string, string>(); // id -> code
	private config: KMSProviderConfig;

	constructor(config: KMSProviderConfig) {
		this.config = config;
	}

	async connect(): Promise<void> {
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		this.connected = false;
		this.keys.clear();
		this.actions.clear();
	}

	isConnected(): boolean {
		return this.connected;
	}

	async encrypt(params: EncryptParams): Promise<EncryptResult> {
		const dataBytes =
			typeof params.data === "string"
				? Buffer.from(params.data, "utf8")
				: Buffer.from(params.data);

		// Generate random key
		const key = crypto.randomBytes(32);
		const iv = crypto.randomBytes(16);

		// Encrypt with AES-256-GCM
		const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
		const encrypted = Buffer.concat([cipher.update(dataBytes), cipher.final()]);
		const authTag = cipher.getAuthTag();

		// Combine: iv (16) + authTag (16) + ciphertext
		const combined = Buffer.concat([iv, authTag, encrypted]);
		const ciphertext = combined.toString("base64");

		// Hash the original data
		const dataHash = crypto
			.createHash("sha256")
			.update(dataBytes)
			.digest("hex");

		// Store the key
		this.keys.set(dataHash, {
			key,
			dataHash,
			conditions: params.accessControlConditions || [],
			createdAt: new Date(),
		});

		return { ciphertext, dataHash };
	}

	async decrypt(params: DecryptParams): Promise<DecryptResult> {
		const entry = this.keys.get(params.dataHash);
		if (!entry) {
			return { success: false, error: "Key not found" };
		}

		// Get the action code
		let code: string | undefined;
		if (params.litActionCode) {
			code = params.litActionCode;
		} else if (params.litActionIpfsCid) {
			code = this.actions.get(params.litActionIpfsCid);
			if (!code) {
				return {
					success: false,
					error: `Action not found: ${params.litActionIpfsCid}`,
				};
			}
		}

		// Execute the action (if provided)
		const logs: string[] = [];

		if (code) {
			try {
				const actionResult = await this.executeAction(
					code,
					{
						...params.jsParams,
						ciphertext: params.ciphertext,
						dataToEncryptHash: params.dataHash,
					},
					params.authContext,
					entry,
					logs,
				);

				if (!actionResult.success) {
					return { success: false, error: actionResult.error, logs };
				}

				// If action returned decrypted data directly, use it
				if (actionResult.data) {
					return { success: true, data: actionResult.data, logs };
				}
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : String(error),
					logs,
				};
			}
		}

		// Decrypt the data
		try {
			const decrypted = this.decryptInternal(params.ciphertext, entry.key);
			return {
				success: true,
				data: new Uint8Array(Buffer.from(decrypted, "utf8")),
				logs,
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
				logs,
			};
		}
	}

	async uploadAction(code: string): Promise<string> {
		const id = "Qm" + crypto.randomBytes(22).toString("hex");
		this.actions.set(id, code);
		return id;
	}

	// ============ Internal helpers ============

	private decryptInternal(ciphertext: string, key: Buffer): string {
		const combined = Buffer.from(ciphertext, "base64");
		const iv = combined.subarray(0, 16);
		const authTag = combined.subarray(16, 32);
		const encrypted = combined.subarray(32);

		const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAuthTag(authTag);

		const decrypted = Buffer.concat([
			decipher.update(encrypted),
			decipher.final(),
		]);
		return decrypted.toString("utf8");
	}

	private async executeAction(
		code: string,
		jsParams: Record<string, unknown>,
		authContext: AuthContext | undefined,
		keyEntry: StoredKey,
		logs: string[],
	): Promise<{ success: boolean; data?: Uint8Array; error?: string }> {
		const self = this;
		let response: string = "";

		// Create mock Lit environment
		const Lit = {
			Actions: {
				setResponse: (opts: { response: string }) => {
					response = opts.response;
				},
				decryptAndCombine: async (opts: {
					ciphertext: string;
					dataToEncryptHash: string;
				}): Promise<string> => {
					const entry = self.keys.get(opts.dataToEncryptHash);
					if (!entry) throw new Error("Key not found");
					return self.decryptInternal(opts.ciphertext, entry.key);
				},
			},
			Auth: {
				authSigAddress:
					authContext?.address || authContext?.authSig?.address || "0x0",
			},
		};

		// Create mock ethers
		const ethers = this.createMockEthers(logs);

		// Create console
		const mockConsole = {
			log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
			error: (...args: unknown[]) =>
				logs.push("[ERROR] " + args.map(String).join(" ")),
		};

		// Execute the code
		const modifiedCode = code.replace(/\bgo\s*\(\s*\)\s*;?\s*$/, "await go();");
		const wrappedCode = `
      return (async () => {
        ${modifiedCode}
      })();
    `;

		const fn = new Function(
			"Lit",
			"ethers",
			"jsParams",
			"console",
			wrappedCode,
		);
		await fn(Lit, ethers, jsParams, mockConsole);

		// Parse response
		if (response) {
			try {
				const parsed = JSON.parse(response);
				if (parsed.success === false) {
					return { success: false, error: parsed.error };
				}
				if (parsed.decrypted) {
					return {
						success: true,
						data: new TextEncoder().encode(parsed.decrypted),
					};
				}
			} catch {
				// Response is raw data
				return { success: true, data: new TextEncoder().encode(response) };
			}
		}

		return { success: true };
	}

	private createMockEthers(logs: string[]) {
		const config = this.config;

		return {
			providers: {
				JsonRpcProvider: class {
					private rpcUrl: string;
					constructor(rpcUrl?: string) {
						this.rpcUrl = rpcUrl || config.rpcUrl || "";
					}
					async call(tx: { to: string; data: string }): Promise<string> {
						if (config.alwaysVerify) {
							logs.push(`[Mock] Auto-verifying call to ${tx.to}`);
							return "0x0000000000000000000000000000000000000000000000000000000000000001";
						}
						if (this.rpcUrl) {
							// Make real RPC call
							logs.push(`[RPC] Calling ${tx.to}`);
							return (await makeRpcCall(this.rpcUrl, "eth_call", [
								tx,
								"latest",
							])) as string;
						}
						logs.push(`[Mock] No RPC URL, returning true for ${tx.to}`);
						return "0x0000000000000000000000000000000000000000000000000000000000000001";
					}
				},
			},
			Contract: class {
				constructor(
					public address: string,
					public abi: unknown[],
					public provider: unknown,
				) {
					return new Proxy(this, {
						get: (target, prop) => {
							if (prop in target) return (target as any)[prop];
							return async (...args: unknown[]) => {
								const prov = target.provider as any;
								const result = await prov.call({
									to: target.address,
									data: "0x",
								});
								return result.endsWith("1");
							};
						},
					});
				}
			},
			utils: {
				keccak256: (data: string | Uint8Array) => {
					const input =
						typeof data === "string"
							? Buffer.from(data.replace(/^0x/, ""), "hex")
							: data;
					return "0x" + crypto.createHash("sha256").update(input).digest("hex");
				},
				toUtf8Bytes: (str: string) => new Uint8Array(Buffer.from(str, "utf8")),
				hexlify: (data: Buffer | Uint8Array) =>
					"0x" + Buffer.from(data).toString("hex"),
			},
		};
	}
}

async function makeRpcCall(
	rpcUrl: string,
	method: string,
	params: unknown[],
): Promise<unknown> {
	const response = await fetch(rpcUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: Date.now(),
			method,
			params,
		}),
	});
	const json = await response.json();
	if (json.error) throw new Error(json.error.message);
	return json.result;
}
