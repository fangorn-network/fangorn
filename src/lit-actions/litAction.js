const go = async (zkGateAddress, vaultId, cidCommitment) => {
	const rpcUrl = "https://sepolia.base.org";
	const callerAddress = Lit.Auth.authSigAddress;

	const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
	const zkGate = new ethers.Contract(
		zkGateAddress,
		[
			"function checkCIDAccess(bytes32 vaultId, bytes32 cidCommitment, address user) view returns (bool)",
		],
		provider,
	);

	const hasAccess = await zkGate.checkCIDAccess(
		vaultId,
		cidCommitment,
		callerAddress,
	);

	return hasAccess.toString();
};
