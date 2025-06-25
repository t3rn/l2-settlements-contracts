// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "./attestationsVerifierProofs.sol";
import "./escrowGMP.sol";
import "./openMarketPricer.sol";

//import "hardhat/console.sol";

contract ClaimerGMPV2 is AccessControlUpgradeable {
    AttestationsVerifierProofs public attesters;
    EscrowGMP public escrowGMP;

    bytes32 public version;

    bool public forceCheckV2;
    /// @dev Constructor function for this upgradeable contract
    /// @param  _owner  The owner of the contract, as well as the proxy
    function initialize(address _owner) public initializer {
        // Verify that the owner is not the zero address & msg.sender
        require(_owner != address(0), "Owner cannot be zero address");

        forceCheckV2 = true;

        _grantRole(DEFAULT_ADMIN_ROLE, _owner);
        // Transfer ownership to the owner
        __AccessControl_init();
    }
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function setVersion(bytes32 _version) external onlyOwner {
        version = _version;
    }

    function setForceCheckV2(bool _forceCheckV2) external onlyOwner {
        forceCheckV2 = _forceCheckV2;
    }

    function setEscrowGMP(EscrowGMP _escrowGMP) external onlyOwner {
        escrowGMP = _escrowGMP;
    }

    modifier onlyOwner() {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "Only owner can call this function");
        _;
    }

    function setAttester(address _attesters) external onlyOwner {
        attesters = AttestationsVerifierProofs(_attesters);
    }

    function verifyGMPPayloadInclusion(
        bytes calldata payload,
        bytes32 _id,
        address _beneficiary,
        uint256 _settledAmount,
        uint8 _actionType
    ) public pure returns (bool) {
        uint256 offset = 0;

        while (offset < payload.length) {
            uint8 actionType = uint8(payload[offset]);
            offset += 1;
            // If escrow commit action
            if (actionType == 0) {
                // Assume next 32 bytes to be order id
                bytes32 orderId = bytes32(payload[offset:offset + 32]);
                offset += 32;
                // Assume next 20 bytes to be beneficiary address
                address beneficiary = address(bytes20(payload[offset:offset + 20]));
                offset += 20;
                if (orderId == _id && beneficiary == _beneficiary) {
                    return _actionType == 0;
                }
            }
            // If escrow revert action
            else if (actionType == 1) {
                // Assume next 32 bytes to be order id
                bytes32 orderId = bytes32(payload[offset:offset + 32]);
                offset += 32;
                if (orderId == _id) {
                    return _actionType == 1;
                }
            }
            // If Open-Market commit action
            else if (actionType == 5) {
                // Assume next 32 bytes to be order id
                bytes32 orderId = bytes32(payload[offset:offset + 32]);
                offset += 32;
                // Assume next 20 bytes to be beneficiary address
                address beneficiary = address(bytes20(payload[offset:offset + 20]));
                offset += 20;
                // Assume next 32 bytes to be settled amount
                uint256 settledAmount = uint256(bytes32(payload[offset:offset + 32]));
                if (orderId == _id && beneficiary == _beneficiary && settledAmount == _settledAmount) {
                    return _actionType == 5;
                }
                // Ignore rest of the bytes
                offset += 148;
            }
        }

        return false;
    }

    function isClaimableNoPayloadStored(
        bytes32 _batchPayloadHash,
        bytes memory _batchPayload,
        bytes32 _id,
        address _beneficiary,
        uint256 _settledAmount,
        uint8 actionType
    ) public view returns (bool) {
        if (attesters == AttestationsVerifierProofs(address(0))) {
            require(false, "Attesters not set");
        }
        require(_batchPayload.length > 0, "Batch payload is empty");
        require(keccak256(_batchPayload) == _batchPayloadHash, "Batch payload hash does not match");

        if (escrowGMP == EscrowGMP(address(0))) {
            require(false, "EscrowGMP not set");
        }

        bytes32 paymentHash = escrowGMP.getRemotePaymentPayloadHash(_id);
        if (paymentHash == bytes32(0) || paymentHash == bytes32(uint256(1)) || paymentHash == bytes32(uint256(2))) {
            return false;
        }
        AttestationsVerifierProofs.Batch memory batch = abi.decode(_batchPayload, (AttestationsVerifierProofs.Batch));
        bytes32 batchMessageHash = keccak256(attesters.batchEncode(batch));
        require(batchMessageHash == _batchPayloadHash, "Batch payload hash does not match");
        return this.verifyGMPPayloadInclusion(batch.encodedGMPPayload, _id, _beneficiary, _settledAmount, actionType);
    }

    function isClaimable(
        bytes32 _batchPayloadHash,
        bytes memory _batchPayload,
        bytes32 _id,
        address _beneficiary,
        uint256 _settledAmount,
        uint8 actionType
    ) public view returns (bool) {
        if (attesters == AttestationsVerifierProofs(address(0))) {
            require(false, "Attesters not set");
        }
        require(attesters.committedGMPMessagesMap(_batchPayloadHash), "Batch payload hash not committed");
        require(_batchPayload.length > 0, "Batch payload is empty");
        require(keccak256(_batchPayload) == _batchPayloadHash, "Batch payload hash does not match");

        if (escrowGMP == EscrowGMP(address(0))) {
            require(false, "EscrowGMP not set");
        }

        bytes32 paymentHash = escrowGMP.getRemotePaymentPayloadHash(_id);
        if (paymentHash == bytes32(0) || paymentHash == bytes32(uint256(1)) || paymentHash == bytes32(uint256(2))) {
            return false;
        }
        AttestationsVerifierProofs.Batch memory batch = abi.decode(_batchPayload, (AttestationsVerifierProofs.Batch));
        bytes32 batchMessageHash = keccak256(attesters.batchEncode(batch));
        require(batchMessageHash == _batchPayloadHash, "Batch payload hash does not match");
        return this.verifyGMPPayloadInclusion(batch.encodedGMPPayload, _id, _beneficiary, _settledAmount, actionType);
    }

    function checkIsRefundableWithEscrow(
        bytes32 orderId,
        uint256 orderTimestamp,
        uint256 orderTimeout,
        address rewardAsset,
        uint256 maxReward,
        address beneficiary
    ) public view returns (bool) {
        if (block.timestamp < orderTimestamp + orderTimeout) {
            return false;
        }
        bytes32 paymentPayloadHash = keccak256(abi.encode(rewardAsset, maxReward, orderTimestamp));
        if (!attesters.skipEscrowWrites()) {
            // As per the escrowGMP revertRemoteOrderPayload, attesters would revert the order payload back to the sender by re-hashing with address(0)
            paymentPayloadHash = keccak256(abi.encode(paymentPayloadHash, address(0)));
        }
        return escrowGMP.getRemotePaymentPayloadHash(orderId) == paymentPayloadHash;
    }

    function checkIsRefundable(
        bytes32 orderId,
        uint256 orderTimestamp,
        uint256 orderTimeout,
        address rewardAsset,
        uint256 maxReward,
        address beneficiary,
        bytes32 _batchPayloadHash,
        bytes memory _batchPayload
    ) public view returns (bool) {
        bytes32 paymentHash = escrowGMP.getRemotePaymentPayloadHash(orderId);
        if (paymentHash == bytes32(0) || paymentHash == bytes32(uint256(1)) || paymentHash == bytes32(uint256(2))) {
            return false;
        }
        require(
            checkIsRefundableWithEscrow(orderId, orderTimestamp, orderTimeout, rewardAsset, maxReward, beneficiary),
            "RO#14"
        );
        if (forceCheckV2) {
            uint8 actionType = 1;
            return isClaimable(_batchPayloadHash, _batchPayload, orderId, beneficiary, maxReward, actionType);
        }
        return false;
    }

    function checkIsClaimableWithEscrow(
        bytes32 orderId,
        address rewardAsset,
        uint256 maxReward,
        uint256 settledAmount,
        address beneficiary,
        uint256 orderTimestamp
    ) public view returns (bool) {
        bytes32 paymentPayloadHash = keccak256(abi.encode(rewardAsset, maxReward, orderTimestamp));
        bytes32 calculatedWithdrawHash = paymentPayloadHash;
        if (!attesters.skipEscrowWrites()) {
            // As per the escrowGMP commitRemoteBeneficiaryPayload, attesters would commit the order payload with beneficiary address
            calculatedWithdrawHash = keccak256(abi.encode(paymentPayloadHash, beneficiary));
        } else if (settledAmount > 0 && !attesters.skipEscrowWrites()) {
            // As per the escrowGMP commitRemoteBeneficiaryPayload, attesters would commit the order payload with settled amount
            calculatedWithdrawHash = keccak256(abi.encode(rewardAsset, settledAmount, beneficiary));
        }
        return escrowGMP.getRemotePaymentPayloadHash(orderId) == calculatedWithdrawHash;
    }

    function checkIsClaimable(
        bytes32 orderId,
        address rewardAsset,
        uint256 maxReward,
        uint256 settledAmount,
        address beneficiary,
        uint256 orderTimestamp,
        bytes32 _batchPayloadHash,
        bytes memory _batchPayload
    ) public view returns (bool) {
        if (escrowGMP == EscrowGMP(address(0))) {
            require(false, "EscrowGMP not set");
        }
        bytes32 paymentHash = escrowGMP.getRemotePaymentPayloadHash(orderId);
        if (paymentHash == bytes32(0) || paymentHash == bytes32(uint256(1)) || paymentHash == bytes32(uint256(2))) {
            return false;
        }
        require(
            checkIsClaimableWithEscrow(orderId, rewardAsset, maxReward, settledAmount, beneficiary, orderTimestamp),
            "RO#14"
        );
        if (forceCheckV2) {
            uint8 actionType = 0;
            return isClaimable(_batchPayloadHash, _batchPayload, orderId, beneficiary, settledAmount, actionType);
        }
        return false;
    }

    function checkClaimPayoutBatch(
        RemoteOrder.Payout[] memory payouts,
        bytes32 _batchPayloadHash,
        bytes memory _batchPayload
    ) public returns (address[] memory, uint256[] memory, uint256) {
        address[] memory rewardAssets = new address[](payouts.length);
        uint256[] memory rewardAmounts = new uint256[](payouts.length);
        uint256 rewardAssetCount = 0;
        for (uint256 i = 0; i < payouts.length; ++i) {
            require(
                checkIsClaimable(
                    payouts[i].id,
                    payouts[i].rewardAsset,
                    payouts[i].maxReward,
                    payouts[i].settledAmount,
                    msg.sender,
                    payouts[i].orderTimestamp,
                    _batchPayloadHash,
                    _batchPayload
                ),
                "RO#15"
            );
            require(escrowGMP.getRemotePaymentPayloadHash(payouts[i].id) != bytes32(0), "RO#15");
            escrowGMP.oneifyPayloadHash(payouts[i].id);

            bool found = false;
            for (uint256 j = 0; j < rewardAssetCount; ++j) {
                if (rewardAssets[j] == payouts[i].rewardAsset) {
                    rewardAmounts[j] += payouts[i].settledAmount > 0 ? payouts[i].settledAmount : payouts[i].maxReward;
                    found = true;
                    break;
                }
            }
            if (!found) {
                rewardAssets[rewardAssetCount] = payouts[i].rewardAsset;
                rewardAmounts[rewardAssetCount] = payouts[i].settledAmount > 0
                    ? payouts[i].settledAmount
                    : payouts[i].maxReward;
                rewardAssetCount++;
            }
        }

        return (rewardAssets, rewardAmounts, rewardAssetCount);
    }
}
