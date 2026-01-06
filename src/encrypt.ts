import { createAccBuilder } from "@lit-protocol/access-control-conditions";

export const encryptWithZkCondition = async (
	litClient: any,
	plaintext: string,
	zkGateAddress: string,
	vaultId: string,
	cidCommitment: string,
	litActionCid: string,
) => {
	const acc = createAccBuilder()
		.requireLitAction(
			litActionCid,
			"go",
			[zkGateAddress, vaultId, cidCommitment],
			"true",
		)
		.build();

	const encryptedData = await litClient.encrypt({
		dataToEncrypt: plaintext,
		unifiedAccessControlConditions: acc,
		chain: "baseSepolia",
	});

	return { encryptedData, acc };
};
