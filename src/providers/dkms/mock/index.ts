/**
 * MockKMS - A centralized KMS that mimics Lit Protocol's interface
 *
 * Use this for e2e tests when Lit is unavailable.
 * Swap back to real Lit by changing the import.
 *
 * Features:
 * - Same encrypt/decrypt interface as Lit
 * - Executes Lit Action code in a sandboxed environment
 * - Supports jsParams for passing proofs, conditions, etc.
 * - Can make real RPC calls to verify contracts (optional)
 *
 * Usage:
 *   // In your test file
 *   import { createMockLitClient } from './mock-kms';
 *   const litClient = createMockLitClient({ rpcUrl: 'http://localhost:8545' });
 *
 *   // Use exactly like real Lit
 *   await litClient.connect();
 *   const encrypted = await litClient.encrypt({ dataToEncrypt: 'secret' });
 *   const result = await litClient.executeJs({ code: '...', jsParams: { ... } });
 */

import * as crypto from "crypto";
import { EventEmitter } from "events";
import * as http from "http";
import * as https from "https";

// ============ Types ============

interface EncryptRequest {
	dataToEncrypt: string | Uint8Array;
	accessControlConditions?: AccessControlCondition[];
	unifiedAccessControlConditions?: AccessControlCondition[];
	chain?: string;
}

interface EncryptResponse {
	ciphertext: string;
	dataToEncryptHash: string;
}

interface ExecuteJsRequest {
	code?: string;
	ipfsId?: string;
	jsParams?: Record<string, unknown>;
	authContext?: AuthContext;
}

interface ExecuteJsResponse {
	success: boolean;
	response: string;
	logs?: string[];
	claims?: Record<string, unknown>;
	signatures?: Record<string, unknown>;
}

interface AccessControlCondition {
	conditionType?: string;
	contractAddress?: string;
	standardContractType?: string;
	chain?: string;
	method?: string;
	parameters?: unknown[];
	returnValueTest?: {
		comparator: string;
		value: string;
	};
}

interface AuthContext {
	authSig?: {
		sig: string;
		derivedVia: string;
		signedMessage: string;
		address: string;
	};
	address?: string;
}

interface StoredKey {
	key: Buffer;
	dataToEncryptHash: string;
	accessControlConditions: AccessControlCondition[];
	createdAt: Date;
}

interface MockKMSConfig {
	/** RPC URL for making real contract calls (optional) */
	rpcUrl?: string;
	/** Default chain for operations */
	defaultChain?: string;
	/** Mock contract responses: address -> method -> response */
	mockContractResponses?: Map<string, Map<string, string>>;
}

// ============ RPC Helper ============

async function makeRpcCall(
	rpcUrl: string,
	method: string,
	params: unknown[],
): Promise<unknown> {
	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: Date.now(),
		method,
		params,
	});

	return new Promise((resolve, reject) => {
		const url = new URL(rpcUrl);
		const client = url.protocol === "https:" ? https : http;

		const req = client.request(
			{
				hostname: url.hostname,
				port: url.port || (url.protocol === "https:" ? 443 : 80),
				path: url.pathname,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
				},
			},
			(res) => {
				let data = "";
				res.on("data", (chunk) => (data += chunk));
				res.on("end", () => {
					try {
						const json = JSON.parse(data);
						if (json.error) {
							reject(new Error(json.error.message));
						} else {
							resolve(json.result);
						}
					} catch (e) {
						reject(e);
					}
				});
			},
		);

		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

// ============ Mock Lit Actions Environment ============

/**
 * Creates a sandboxed environment that mimics Lit Actions globals
 */
function createLitActionsEnvironment(
	mockKms: MockKMS,
	jsParams: Record<string, unknown>,
	authContext?: AuthContext,
) {
	const logs: string[] = [];
	let response: string = "";
	const config = mockKms.getConfig();

	// Mock ethers with real RPC support
	const mockEthers = {
		providers: {
			JsonRpcProvider: class {
				private rpcUrl: string;

				constructor(rpcUrl?: string) {
					this.rpcUrl = rpcUrl || config.rpcUrl || "";
				}

				async call(tx: { to: string; data: string }): Promise<string> {
					if (this.rpcUrl) {
						// Make real RPC call
						try {
							const result = await makeRpcCall(this.rpcUrl, "eth_call", [
								tx,
								"latest",
							]);
							return result as string;
						} catch (e) {
							logs.push(`[RPC ERROR] ${e}`);
							throw e;
						}
					}

					// Check mock responses
					const mockResponses = config.mockContractResponses;
					if (mockResponses) {
						const contractMocks = mockResponses.get(tx.to.toLowerCase());
						if (contractMocks) {
							// Try to match by method signature (first 4 bytes of data)
							const methodSig = tx.data.slice(0, 10);
							const mockResponse = contractMocks.get(methodSig);
							if (mockResponse) {
								return mockResponse;
							}
						}
					}

					// Default: return true (0x01)
					logs.push(`[MockKMS] No RPC URL, returning mock true for ${tx.to}`);
					return "0x0000000000000000000000000000000000000000000000000000000000000001";
				}

				async getNetwork(): Promise<{ chainId: number; name: string }> {
					if (this.rpcUrl) {
						const chainId = await makeRpcCall(this.rpcUrl, "eth_chainId", []);
						return {
							chainId: parseInt(chainId as string, 16),
							name: "unknown",
						};
					}
					return { chainId: 1, name: "mock" };
				}
			},
		},

		Contract: class {
			address: string;
			abi: unknown[];
			provider: unknown;
			interface: {
				encodeFunctionData: (method: string, params: unknown[]) => string;
				decodeFunctionResult: (method: string, data: string) => unknown[];
			};

			constructor(address: string, abi: unknown[], provider: unknown) {
				this.address = address;
				this.abi = abi;
				this.provider = provider;

				// Create a basic interface encoder/decoder
				this.interface = {
					encodeFunctionData: (method: string, params: unknown[]) => {
						// Simple encoding - in real impl use proper ABI encoding
						const methodSig = crypto
							.createHash("sha256")
							.update(method)
							.digest("hex")
							.slice(0, 8);
						return "0x" + methodSig;
					},
					decodeFunctionResult: (method: string, data: string) => {
						// Simple decoding - check if it's a boolean
						if (data.endsWith("1")) return [true];
						if (data.endsWith("0")) return [false];
						return [data];
					},
				};

				// Create proxy to handle dynamic method calls
				return new Proxy(this, {
					get: (target, prop) => {
						if (prop in target) {
							return (target as Record<string | symbol, unknown>)[prop];
						}

						// Return async function for any contract method
						return async (...args: unknown[]) => {
							const prov = target.provider as {
								call: (tx: { to: string; data: string }) => Promise<string>;
							};
							const data = target.interface.encodeFunctionData(
								prop as string,
								args,
							);
							const result = await prov.call({ to: target.address, data });
							const decoded = target.interface.decodeFunctionResult(
								prop as string,
								result,
							);
							return decoded[0];
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
			arrayify: (hex: string) =>
				new Uint8Array(Buffer.from(hex.replace(/^0x/, ""), "hex")),
			defaultAbiCoder: {
				encode: (types: string[], values: unknown[]) => {
					// Simplified encoding
					return "0x" + values.map((v) => String(v).padStart(64, "0")).join("");
				},
				decode: (types: string[], data: string) => {
					// Simplified decoding
					return [data];
				},
			},
		},

		BigNumber: {
			from: (value: unknown) => ({
				toString: () => String(value),
				toNumber: () => Number(value),
				eq: (other: unknown) => String(value) === String(other),
				gt: (other: unknown) => Number(value) > Number(other),
				lt: (other: unknown) => Number(value) < Number(other),
			}),
		},
	};

	// Mock Lit global object
	const Lit = {
		Actions: {
			setResponse: (opts: { response: string }) => {
				response = opts.response;
			},

			// The key function - decrypts data if conditions are met
			decryptAndCombine: async (opts: {
				accessControlConditions?: AccessControlCondition[];
				unifiedAccessControlConditions?: AccessControlCondition[];
				ciphertext: string;
				dataToEncryptHash: string;
				authSig?: unknown;
				chain?: string;
			}): Promise<string> => {
				// Look up the stored key by hash
				const entry = mockKms.getKeyByHash(opts.dataToEncryptHash);
				if (!entry) {
					throw new Error("Key not found for dataToEncryptHash");
				}

				// Decrypt
				const decrypted = mockKms.decryptInternal(opts.ciphertext, entry.key);
				return decrypted;
			},

			call: async (opts: { url: string; method: string; body?: string }) => {
				// Mock HTTP calls - would need real implementation for contract calls
				console.log(`[MockKMS] HTTP call to ${opts.url}`);
				return { success: true };
			},

			signEcdsa: async (opts: {
				toSign: Uint8Array;
				publicKey: string;
				sigName: string;
			}) => {
				// Mock signing - return dummy signature
				return {
					signature: "0x" + crypto.randomBytes(65).toString("hex"),
					publicKey: opts.publicKey,
				};
			},
		},

		Auth: {
			authSigAddress:
				authContext?.address ||
				authContext?.authSig?.address ||
				"0x0000000000000000000000000000000000000000",
		},
	};

	return {
		globals: {
			Lit,
			ethers: mockEthers,
			jsParams,
			console: {
				log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
				error: (...args: unknown[]) =>
					logs.push("[ERROR] " + args.map(String).join(" ")),
			},
		},
		getResponse: () => response,
		getLogs: () => logs,
	};
}

// ============ Mock KMS Class ============

export class MockKMS extends EventEmitter {
	private keys: Map<string, StoredKey> = new Map();
	private ipfsStore: Map<string, string> = new Map(); // Mock IPFS: CID -> code
	private connected: boolean = false;
	private config: MockKMSConfig;

	constructor(config: MockKMSConfig = {}) {
		super();
		this.config = config;
	}

	getConfig(): MockKMSConfig {
		return this.config;
	}

	/**
	 * Set mock contract responses for testing
	 *
	 * @example
	 * kms.setMockContractResponse(
	 *   '0x1234...', // contract address
	 *   '0x12345678', // method signature (first 4 bytes)
	 *   '0x0000...0001' // return value (true)
	 * );
	 */
	setMockContractResponse(
		address: string,
		methodSig: string,
		response: string,
	): void {
		if (!this.config.mockContractResponses) {
			this.config.mockContractResponses = new Map();
		}
		const addrLower = address.toLowerCase();
		if (!this.config.mockContractResponses.has(addrLower)) {
			this.config.mockContractResponses.set(addrLower, new Map());
		}
		this.config.mockContractResponses.get(addrLower)!.set(methodSig, response);
	}

	// ============ Lifecycle ============

	async connect(): Promise<void> {
		this.connected = true;
		this.emit("connected");
	}

	async disconnect(): Promise<void> {
		this.connected = false;
		this.keys.clear();
		this.emit("disconnected");
	}

	isConnected(): boolean {
		return this.connected;
	}

	// ============ IPFS Mock ============

	/**
	 * Upload code to mock IPFS, returns a CID
	 */
	async uploadLitAction(code: string): Promise<string> {
		const cid = "Qm" + crypto.randomBytes(22).toString("hex");
		this.ipfsStore.set(cid, code);
		return cid;
	}

	/**
	 * Get code from mock IPFS
	 */
	getLitActionCode(ipfsId: string): string | undefined {
		return this.ipfsStore.get(ipfsId);
	}

	// ============ Encryption ============

	async encrypt(request: EncryptRequest): Promise<EncryptResponse> {
		const data =
			typeof request.dataToEncrypt === "string"
				? Buffer.from(request.dataToEncrypt, "utf8")
				: Buffer.from(request.dataToEncrypt);

		// Generate a random key for this encryption
		const key = crypto.randomBytes(32);
		const iv = crypto.randomBytes(16);

		// Encrypt with AES-256-GCM
		const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
		const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
		const authTag = cipher.getAuthTag();

		// Combine: iv (16) + authTag (16) + ciphertext
		const combined = Buffer.concat([iv, authTag, encrypted]);
		const ciphertext = combined.toString("base64");

		// Hash the original data
		const dataToEncryptHash = crypto
			.createHash("sha256")
			.update(data)
			.digest("hex");

		// Store the key indexed by hash
		const conditions =
			request.unifiedAccessControlConditions ||
			request.accessControlConditions ||
			[];
		this.keys.set(dataToEncryptHash, {
			key,
			dataToEncryptHash,
			accessControlConditions: conditions,
			createdAt: new Date(),
		});

		return {
			ciphertext,
			dataToEncryptHash,
		};
	}

	// ============ Decryption (direct) ============

	/**
	 * Direct decryption - bypasses Lit Action execution
	 * Use this for simple access control conditions
	 */
	async decrypt(request: {
		ciphertext: string;
		dataToEncryptHash: string;
		accessControlConditions?: AccessControlCondition[];
		unifiedAccessControlConditions?: AccessControlCondition[];
		authContext?: AuthContext;
		chain?: string;
	}): Promise<{ decryptedData: Uint8Array }> {
		const entry = this.keys.get(request.dataToEncryptHash);
		if (!entry) {
			throw new Error("Key not found");
		}

		// In real Lit, this would evaluate ACCs
		// For mock, we just decrypt
		const decrypted = this.decryptInternal(request.ciphertext, entry.key);
		return { decryptedData: new Uint8Array(Buffer.from(decrypted, "utf8")) };
	}

	// ============ Execute JS (Lit Action execution) ============

	/**
	 * Execute a Lit Action - this is where the magic happens
	 *
	 * The Lit Action code is executed in a sandboxed environment with:
	 * - `Lit` global (Actions.setResponse, Actions.decryptAndCombine, Auth.authSigAddress)
	 * - `ethers` global (providers, Contract, utils)
	 * - `jsParams` - parameters passed from the caller
	 * - `console` - for logging
	 */
	async executeJs(request: ExecuteJsRequest): Promise<ExecuteJsResponse> {
		let code: string;

		if (request.code) {
			code = request.code;
		} else if (request.ipfsId) {
			const storedCode = this.ipfsStore.get(request.ipfsId);
			if (!storedCode) {
				throw new Error(`Lit Action not found: ${request.ipfsId}`);
			}
			code = storedCode;
		} else {
			throw new Error("Must provide either code or ipfsId");
		}

		const jsParams = request.jsParams || {};
		const env = createLitActionsEnvironment(
			this,
			jsParams,
			request.authContext,
		);

		try {
			// Execute the Lit Action code in a sandboxed context
			const result = await this.executeSandboxed(code, env.globals);

			return {
				success: true,
				response: env.getResponse(),
				logs: env.getLogs(),
				claims: {},
				signatures: {},
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			return {
				success: false,
				response: JSON.stringify({ error: errorMessage }),
				logs: [...env.getLogs(), `[ERROR] ${errorMessage}`],
				claims: {},
				signatures: {},
			};
		}
	}

	// ============ Internal helpers ============

	/**
	 * Get a stored key by its hash
	 */
	getKeyByHash(hash: string): StoredKey | undefined {
		return this.keys.get(hash);
	}

	/**
	 * Internal decryption using stored key
	 */
	decryptInternal(ciphertext: string, key: Buffer): string {
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

	/**
	 * Execute code in a sandboxed environment
	 *
	 * This uses Function constructor to create an isolated scope.
	 * In production, you'd want a proper sandbox (vm2, isolated-vm, etc.)
	 */
	private async executeSandboxed(
		code: string,
		globals: Record<string, unknown>,
	): Promise<unknown> {
		// Build the function body with globals injected
		const globalNames = Object.keys(globals);
		const globalValues = Object.values(globals);

		// Modify the code to await the go() call if it exists at the end
		// Lit Actions typically define a `go` function and call it
		let modifiedCode = code;

		// Replace `go();` at the end with `await go();`
		modifiedCode = modifiedCode.replace(
			/\bgo\s*\(\s*\)\s*;?\s*$/,
			"await go();",
		);

		// Wrap the code to handle async execution
		const wrappedCode = `
      return (async () => {
        ${modifiedCode}
      })();
    `;

		// Create and execute the function
		const fn = new Function(...globalNames, wrappedCode);
		return await fn(...globalValues);
	}
}

// ============ Factory function ============

/**
 * Create a MockKMS instance that mimics LitNodeClient
 *
 * @param config Configuration options
 * @param config.rpcUrl RPC URL for real contract calls
 * @param config.defaultChain Default chain for operations
 * @param config.mockContractResponses Mock responses for contract calls
 */
export function createMockLitClient(config: MockKMSConfig = {}): MockKMS {
	return new MockKMS(config);
}

// ============ Example usage ============

async function example() {
	// Option 1: Use real RPC (for integration tests)
	// const kms = createMockLitClient({ rpcUrl: 'http://localhost:8545' });

	// Option 2: Use mock responses (for unit tests)
	const kms = createMockLitClient();

	// Mock the ZK verifier contract to return true
	const VERIFIER_ADDRESS = "0x1234567890123456789012345678901234567890";
	const VERIFY_METHOD_SIG = "0x12345678"; // First 4 bytes of verify(bytes,bytes32[])
	kms.setMockContractResponse(
		VERIFIER_ADDRESS,
		VERIFY_METHOD_SIG,
		"0x0000000000000000000000000000000000000000000000000000000000000001", // true
	);

	await kms.connect();

	// Example Lit Action code that verifies ZK proof and decrypts
	const litActionCode = `
    const go = async () => {
      const { 
        proof, 
        publicInputs, 
        verifierAddress,
        ciphertext, 
        dataToEncryptHash 
      } = jsParams;
      
      console.log('Starting ZK verification...');
      
      // Connect to RPC
      const provider = new ethers.providers.JsonRpcProvider();
      
      // Call the verifier contract
      const verifier = new ethers.Contract(
        verifierAddress,
        ['function verify(bytes proof, bytes32[] publicInputs) view returns (bool)'],
        provider
      );
      
      try {
        const isValid = await verifier.verify(proof, publicInputs);
        console.log('Verification result:', isValid);
        
        if (!isValid) {
          Lit.Actions.setResponse({ 
            response: JSON.stringify({ success: false, error: 'Invalid proof' }) 
          });
          return;
        }
        
        // Proof verified! Now decrypt
        const decrypted = await Lit.Actions.decryptAndCombine({
          ciphertext,
          dataToEncryptHash,
          chain: 'baseSepolia',
        });
        
        Lit.Actions.setResponse({ 
          response: JSON.stringify({ success: true, decrypted }) 
        });
        
      } catch (err) {
        console.log('Error:', err.message);
        Lit.Actions.setResponse({ 
          response: JSON.stringify({ success: false, error: err.message }) 
        });
      }
    };
    
    go();
  `;

	// Upload the Lit Action
	const ipfsCid = await kms.uploadLitAction(litActionCode);
	console.log("Uploaded Lit Action:", ipfsCid);

	// Encrypt some secret data
	const secretData = JSON.stringify({
		apiKey: "sk-secret-12345",
		privateNote: "This is protected by ZK proof",
	});

	const encrypted = await kms.encrypt({
		dataToEncrypt: secretData,
	});
	console.log("Encrypted:", {
		ciphertext: encrypted.ciphertext.slice(0, 50) + "...",
		dataToEncryptHash: encrypted.dataToEncryptHash,
	});

	// Execute the Lit Action to decrypt (simulating a user with valid proof)
	console.log("\n--- Attempting decryption with ZK proof ---");
	const result = await kms.executeJs({
		ipfsId: ipfsCid,
		jsParams: {
			proof: "0xdeadbeef...", // Would be real proof bytes
			publicInputs: ["0x1234..."], // Would be real public inputs
			verifierAddress: VERIFIER_ADDRESS,
			ciphertext: encrypted.ciphertext,
			dataToEncryptHash: encrypted.dataToEncryptHash,
		},
		authContext: {
			address: "0xUserAddress1234567890123456789012345678",
		},
	});

	console.log("Success:", result.success);
	console.log("Logs:", result.logs);

	if (result.response) {
		try {
			const parsed = JSON.parse(result.response);
			console.log("Parsed response:", parsed);
			if (parsed.decrypted) {
				console.log("Decrypted data:", JSON.parse(parsed.decrypted));
			}
		} catch {
			console.log("Raw response:", result.response);
		}
	} else {
		console.log("No response received");
	}

	await kms.disconnect();
}

// ============ Test helpers ============

/**
 * Helper to create a pre-configured mock for Fangorn tests
 */
export function createFangornTestKMS(
	options: {
		/** Mock all verifier calls to return true */
		alwaysVerify?: boolean;
		/** RPC URL for real contract calls */
		rpcUrl?: string;
	} = {},
): MockKMS {
	const kms = createMockLitClient({ rpcUrl: options.rpcUrl });

	if (options.alwaysVerify) {
		// This is a bit of a hack - we'll make all contract calls return true
		// In real tests, you'd set specific mock responses
		kms.setMockContractResponse(
			"0x0000000000000000000000000000000000000000", // Catch-all
			"0x00000000",
			"0x0000000000000000000000000000000000000000000000000000000000000001",
		);
	}

	return kms;
}

// Run example if this file is executed directly
if (require.main === module) {
	example().catch(console.error);
}
