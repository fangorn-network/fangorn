const arbitrumSepolia = "https://sepolia-rollup.arbitrum.io/rpc";
const baseSepolia = "https://sepolia.base.org";

const go = async (supportedNetwork, paywallAddress, commitment) => {
	let rpcUrl = baseSepolia;
	if (supportedNetwork == "arbitrumSepolia") rpcUrl = arbitrumSepolia;
	else if (supportedNetwork == "baseSepolia") rpcUrl = baseSepolia;
	else {
		throw new Error(
			`Unsupported network ${supportedNetwork}.\n
			Choose a supported network in the list ["arbitrumSepolia", "baseSepolia"].`,
		);
	}

	const callerAddress = Lit.Auth.authSigAddress;
	const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

	const paywallAbi = [
		"function checkSettlement(bytes32 commitment, address buyer) view returns (bool)",
	];

	const paywall = new ethers.Contract(paywallAddress, paywallAbi, provider);

	const ok = await paywall.checkSettlement(commitment, callerAddress);

	if (!ok) {
		Lit.Actions.setResponse({ success: false, response: "goodbye" });
		throw new Error("x402: Payment Required");
	}

	// todo: decrypt and return result
	Lit.Actions.setResponse({ response: ok.toString() });

	return ok.toString();
};
