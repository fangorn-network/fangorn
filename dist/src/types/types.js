export const buildManifest = (options) => {
	const {
		root,
		entries,
		tree,
		name,
		description,
		vaultId,
		resourceServerEndpoint = "http://localhost:4021/resource",
		metadata,
	} = options;
	return {
		// Fangorn internals
		version: 1,
		poseidon_root: root,
		entries,
		...(tree && { tree }),
		// ERC-8004 discovery fields
		type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
		name,
		description,
		endpoints: [
			{
				name: "fangorn",
				endpoint: resourceServerEndpoint,
				vaultId,
			},
		],
		...(metadata && { metadata }),
	};
};
