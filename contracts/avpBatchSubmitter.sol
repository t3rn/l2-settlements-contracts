// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "./escrowGMP.sol";
import "./remoteOrder.sol";

contract avpBatchSubmitter is AccessControlUpgradeable {
    bytes32 public version;
    mapping(uint256 => uint256) public highestIndexBackdoor;
    mapping(uint256 => uint256) public lowestIndexBackdoor;

    AttestationsVerifierProofs public avp;
    RemoteOrder public ro;
    EscrowGMP public escrowGMP;

    ClaimerGMPV2 public claimer;
    mapping(address => bool) public operators;

    event BatchConfirmation(address target, uint256 totalAmount, address asset, address sender, uint256 batchCount);
    event UnknownRefundable(
        address indexed beneficiary,
        uint32 indexed orderNonce,
        bytes32 orderIdNetwork,
        bytes32 orderIdZero
    );
    event Claimed(bytes32 indexed id, address indexed executor, uint256 indexed amount, address rewardAsset);
    event ClaimedRefund(bytes32 indexed id, address indexed orderer, uint256 indexed amount, address rewardAsset);

    event NonClaimable(bytes32 indexed id, bytes32 indexed gmpPayload, bytes32 batchPayloadHash);
    event NonRefundable(bytes32 indexed id, bytes32 indexed gmpPayload, bytes32 batchPayloadHash);
    event ClaimedBatch(bytes32 indexed batchPayloadHash, address indexed beneficiary);
    event ExecutedBatchGasConsumed(uint256 count, address asset, uint256 gasConsumed);
    event SetOperator(address indexed operator);
    event RemovedOperator(address indexed operator);
    event SetVersion(bytes32 indexed version);

    struct BatchData {
        address payable target;
        address asset;
        uint256 totalAmount;
        uint256 count;
    }

    /// @dev Constructor function for this upgradeable contract
    /// @param  _owner  The owner of the contract, as well as the proxy
    function initialize(address _owner) public initializer {
        require(_owner != address(0), "AVP#0");
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _owner);
    }

    // This function is triggered for plain ETH transfers (no calldata)
    receive() external payable {}

    // This function is triggered when calldata does not match any function signature
    fallback() external payable {
        revert("AVP#0");
    }
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function setVersion(bytes32 _version) public onlyOwner {
        version = _version;
        emit SetVersion(_version);
    }

    function setAVP(AttestationsVerifierProofs _avp) public onlyOwner {
        avp = _avp;
    }

    function setRO(RemoteOrder _ro) public onlyOwner {
        ro = _ro;
    }

    function setEscrowGMP(EscrowGMP _escrowGMP) public onlyOwner {
        escrowGMP = _escrowGMP;
    }

    function setClaimer(ClaimerGMPV2 _claimer) public onlyOwner {
        claimer = _claimer;
    }

    modifier onlyOwner() {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "AVP#0");
        _;
    }

    function setOperator(address _operator) external onlyOwner {
        operators[_operator] = true;
        emit SetOperator(_operator);
    }

    function removeOperator(address _operator) external onlyOwner {
        operators[_operator] = false;
        emit RemovedOperator(_operator);
    }

    modifier onlyOwnerOrOperator() {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender) || operators[msg.sender], "AVP#0");
        _;
    }

    // Receive attestations for orders with source on t3rn's Circuit
    function receiveAttestationBatchMulti(
        bytes[] calldata batchPayload,
        bytes[] calldata messageGMPPayload,
        bytes[][] calldata signatures,
        bytes32[][] calldata multiProofProof,
        bool[][] calldata multiProofMembershipFlags
    ) public {
        for (uint256 i = 0; i < batchPayload.length; ++i) {
            avp.receiveAttestationBatch(
                batchPayload[i],
                messageGMPPayload[i],
                signatures[i],
                multiProofProof[i],
                multiProofMembershipFlags[i]
            );
        }
    }

    function confirmBatchOrdersV3(RemoteOrder.ConfirmBatchOrderEntry calldata entries) public payable returns (bool) {
        uint256 gasStart = gasleft();
        // Iterate over ids
        for (uint256 i = 0; i < entries.ids.length; i++) {
            // Protect against overtime confirmations by re-constructing order ID out of timestamp-based nonce
            if (
                block.timestamp < entries.nonces[i] ||
                block.timestamp - entries.nonces[i] > ro.executionCutOff() ||
                entries.ids[i] != ro.generateIdFull(entries.sourceAccount[i], entries.nonces[i], entries.source[i])
            ) {
                revert("AVP#0");
            }
        }

        // Temporary storage for batch data
        BatchData[] memory batchData = new BatchData[](entries.ids.length);
        uint256 batchCount = 0;

        // First, accumulate orders by target and asset
        for (uint256 i = 0; i < entries.ids.length; i++) {
            bytes32 confirmationId = keccak256(
                abi.encode(entries.ids[i], entries.targets[i], entries.amounts[i], entries.assets[i], msg.sender)
            );

            // Check if the order is already confirmed
            if (ro.orderPayloads(confirmationId) != bytes32(0)) {
                continue;
            }

            ro.markOrderPayload(confirmationId, entries.ids[i]);

            // Try to find an existing batch entry with the same target and asset
            bool found = false;
            for (uint256 j = 0; j < batchCount; j++) {
                if (batchData[j].target == entries.targets[i] && batchData[j].asset == entries.assets[i]) {
                    // Accumulate the amount for the existing target and asset pair
                    batchData[j].totalAmount += entries.amounts[i];
                    batchData[j].count++;
                    found = true;
                    break;
                }
            }

            // If no entry exists, create a new one
            if (!found) {
                batchData[batchCount] = BatchData({
                    target: entries.targets[i],
                    asset: entries.assets[i],
                    totalAmount: entries.amounts[i],
                    count: 1
                });
                batchCount++;
            }

            // Emit an event for each order individually
            emit RemoteOrder.Confirmation(
                entries.ids[i],
                entries.targets[i],
                entries.amounts[i],
                entries.assets[i],
                msg.sender,
                confirmationId,
                block.timestamp
            );
        }

        uint256 totalNativeSent = 0;

        uint256 midGas = gasStart - gasleft();
        // Now issue the transfers for each target and asset pair
        for (uint256 i = 0; i < batchCount; i++) {
            uint256 gasStartBatch = gasleft();
            BatchData memory batch = batchData[i];
            ro.settlePayoutWithFeesCall{value: batch.totalAmount}(
                batch.totalAmount,
                batch.asset,
                batch.target,
                msg.sender,
                99, // Do not emit event another time
                bytes32(0)
            );
            if (batch.asset == address(0)) {
                totalNativeSent += batch.totalAmount;
            }
            emit BatchConfirmation(batch.target, batch.totalAmount, batch.asset, msg.sender, batch.count);
            emit ExecutedBatchGasConsumed(
                batch.count,
                batch.asset,
                (midGas / batchCount) + gasStartBatch - gasleft() + 30000 // 30k for the event emission & tx overhead
            );
        }

        require(batchCount > 0 && totalNativeSent == msg.value, "AVP#0");
    }

    function claimRefundV2OfBatch(
        address[] calldata _beneficiary,
        uint32[] calldata orderNonce,
        address[] calldata rewardAsset,
        uint256[] calldata maxReward,
        bytes32 _batchPayloadHash,
        bytes calldata _batchPayload
    ) public {
        for (uint256 i = 0; i < orderNonce.length; ++i) {
            claimRefundV2(
                _beneficiary[i],
                orderNonce[i],
                rewardAsset[i],
                maxReward[i],
                _batchPayloadHash,
                _batchPayload
            );
        }
    }

    function claimRefundV2(
        address _beneficiary,
        uint32 orderNonce,
        address rewardAsset,
        uint256 maxReward,
        bytes32 _batchPayloadHash,
        bytes memory _batchPayload
    ) internal {
        bytes32 orderId = ro.generateId(_beneficiary, orderNonce);
        if (claimer.isClaimable(_batchPayloadHash, _batchPayload, orderId, _beneficiary, maxReward, 1)) {
            escrowGMP.twoifyPayloadHash(orderId);
            ro.settlePayoutWithFeesCall(maxReward, rewardAsset, _beneficiary, address(ro), 1, orderId);
        } else {
            emit NonRefundable(orderId, escrowGMP.getRemotePaymentPayloadHash(orderId), _batchPayloadHash);
        }
    }

    function claimPayout(
        bytes32 orderId,
        address rewardAsset,
        uint256 maxReward,
        uint256 orderTimestamp,
        bytes32 _batchPayloadHash,
        bytes calldata _batchPayload,
        address _beneficiary
    ) internal {
        if (
            ro.checkIsClaimableV2(
                orderId,
                rewardAsset,
                maxReward,
                0,
                _beneficiary,
                orderTimestamp,
                _batchPayloadHash,
                _batchPayload
            )
        ) {
            escrowGMP.oneifyPayloadHash(orderId);
            ro.settlePayoutWithFeesCall(maxReward, rewardAsset, _beneficiary, address(ro), 0, orderId);
        } else {
            emit NonClaimable(orderId, escrowGMP.getRemotePaymentPayloadHash(orderId), _batchPayloadHash);
        }
    }

    function claimRefundV2Batches(
        uint32[][] calldata orderNonce,
        address[][] calldata rewardAsset,
        uint256[][] calldata maxReward,
        uint256[][] calldata orderTimestamp,
        address[] calldata _beneficiary
    ) public {
        for (uint256 i = 0; i < _beneficiary.length; ++i) {
            claimRefundV2Batch(orderNonce[i], rewardAsset[i], maxReward[i], orderTimestamp[i], _beneficiary[i]);
        }
    }

    function claimRefundV2Batch(
        uint32[] calldata orderNonce,
        address[] calldata rewardAsset,
        uint256[] calldata maxReward,
        uint256[] calldata orderTimestamp,
        address _beneficiary
    ) public {
        for (uint256 i = 0; i < orderNonce.length; ++i) {
            claimRefundV2(_beneficiary, orderNonce[i], rewardAsset[i], maxReward[i], bytes32(0), "");
        }
    }

    function claimPayoutBatches(
        bytes32[][] calldata orderId,
        address[][] calldata rewardAsset,
        uint256[][] calldata maxReward,
        uint256[][] calldata orderTimestamp,
        bytes32 _batchPayloadHash,
        bytes calldata _batchPayload
    ) public {
        for (uint256 i = 0; i < orderId.length; ++i) {
            claimPayoutBatch(
                orderId[i],
                rewardAsset[i],
                maxReward[i],
                orderTimestamp[i],
                _batchPayloadHash,
                _batchPayload
            );
        }
    }

    function claimPayoutBatch(
        bytes32[] calldata orderId,
        address[] calldata rewardAsset,
        uint256[] calldata maxReward,
        uint256[] calldata orderTimestamp,
        bytes32 _batchPayloadHash,
        bytes calldata _batchPayload
    ) public {
        address _beneficiary = msg.sender;
        if (rewardAsset.length == orderId.length + 1) {
            _beneficiary = rewardAsset[rewardAsset.length - 1];
        }
        if (_beneficiary == address(0)) {
            return;
        }
        for (uint256 i = 0; i < orderId.length; ++i) {
            claimPayout(
                orderId[i],
                rewardAsset[i],
                maxReward[i],
                orderTimestamp[i],
                _batchPayloadHash,
                _batchPayload,
                _beneficiary
            );
        }
        emit ClaimedBatch(_batchPayloadHash, _beneficiary);
    }
}
