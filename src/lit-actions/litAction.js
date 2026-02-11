const go = async () => {
	Lit.Actions.setResponse({ response: "true" });
	return "true";
};

// go();

// const go = async (paywallAddress, commitment) => {
// const callerAddress = Lit.Auth.authSigAddress;
// const provider = new ethers.providers.JsonRpcProvider(
// 	"https://sepolia.base.org",
// );

// const paywallAbi = [
// 	"function checkSettlement(bytes32 commitment, address buyer) view returns (bool)",
// ];

// const paywall = new ethers.Contract(paywallAddress, paywallAbi, provider);

// const ok = await paywall.checkSettlement(commitment, callerAddress);
// if (!ok) throw new Error("x402: Payment Required");

// return ok.toString();
// 	return true;
// };
