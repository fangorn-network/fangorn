/**
 * Uploads any data to IPFS via Pinata
 */
export async function uploadToPinata(name, data, pinataJwt) {
	const jwt = pinataJwt || process.env.PINATA_JWT;
	if (!jwt) throw new Error("PINATA_JWT is required");
	// If data is an object, stringify it
	const content =
		typeof data === "object" && !(data instanceof Blob)
			? JSON.stringify(data)
			: data;
	const contentType =
		typeof data === "object" ? "application/json" : "text/plain";
	const form = new FormData();
	form.append("file", new Blob([content], { type: contentType }), name);
	const response = await fetch(
		"https://api.pinata.cloud/pinning/pinFileToIPFS",
		{
			method: "POST",
			headers: { Authorization: `Bearer ${jwt}` },
			body: form,
		},
	);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Upload failed: ${response.status} - ${text}`);
	}
	const resData = await response.json();
	return resData.IpfsHash;
}
