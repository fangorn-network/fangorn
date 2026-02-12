/**
 * Uploads any data to IPFS via Pinata
 */
export declare function uploadToPinata(name: string, data: any, pinataJwt?: string): Promise<string>;
