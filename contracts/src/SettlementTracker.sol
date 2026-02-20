// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IUSDC {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

contract SettlementTracker {
    address public usdcAddress;

    // map keccak256(commitment + user_address) => amount settled
    mapping(bytes32 => uint256) public settlementTracker;

    event SettlementRecorded(bytes32 indexed hash, uint256 amount);

    error AlreadyPaid();
    error TransferFailed();

    constructor(address _usdcAddress) {
        usdcAddress = _usdcAddress;
    }

    function pay(
        bytes32 commitment,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external payable {
        bytes32 hash = hashConcat(commitment, from);

        try IUSDC(usdcAddress).transferWithAuthorization(
            from, to, value, validAfter, validBefore, nonce, v, r, s
        ) {
            settlementTracker[hash] += value;
            emit SettlementRecorded(hash, value);
        } catch {
            revert TransferFailed();
        }
    }

    function checkSettlement(bytes32 commitment, address user) external view returns (uint256) {
        return settlementTracker[hashConcat(commitment, user)];
    }

    function hashConcat(bytes32 a, address b) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(a, b));
    }
}