// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "./escrowGMP.sol";
import "./claimerGMPV2.sol";

contract RemoteOrder is AccessControlUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    uint256 public orderTimeout;
    address public protocolFeesCollector;

    mapping(bytes32 => bytes32) public orderPayloads;
    mapping(bytes32 => address) public orderWinners;
    mapping(address => uint32) public supportedAssets;
    mapping(address => uint256) public maxAllowedAmounts;
    mapping(address => uint256) public minAllowedAmounts;
    uint256 public currentProtocolFee;
    bool public isHalted;

    bytes4 public sourceId;
    bytes32 public version;

    EscrowGMP public escrowGMP;
    ClaimerGMPV2 public claimerGMP;

    address public operator;
    uint256 public executionCutOff;

    uint256 public currentProtocolFeeFlatHigh;
    uint256 public currentProtocolFeeFlatLow;

    mapping(address => uint256) public protocolFeesAccrued;
    mapping(uint32 => bool) public supportedDestAssets;
    mapping(bytes4 => bool) public supportedNetworks;

    bool public isIngressHalted;
    bool public isEgressHalted;

    uint256 rpsCount;
    uint256 rpsTimestamp;
    uint256 rpsMax;

    uint256 public constant PROTOCOL_FEE_BP = 1e8; // 100 percent = 1e6 basis points

    event Claimed(bytes32 indexed id, address indexed executor, uint256 amount, address rewardAsset);
    event ClaimedRefund(bytes32 indexed id, address indexed orderer, uint256 amount, address rewardAsset);
    event OrderCreated(
        bytes32 indexed id,
        bytes4 indexed destination,
        uint32 asset,
        bytes32 targetAccount,
        uint256 amount,
        address rewardAsset,
        uint256 insurance,
        uint256 maxReward,
        uint32 nonce,
        address sourceAccount,
        uint256 orderTimestamp
    );
    event Confirmation(
        bytes32 indexed id,
        address indexed target,
        uint256 amount,
        address asset,
        address indexed sender,
        bytes32 confirmationId,
        uint256 timestamp
    );
    event RemoteOrderCreated(bytes32 indexed id, uint32 indexed nonce, address indexed sender, uint256 orderTimestamp);
    event OrderGasConsumed(
        bytes32 indexed id,
        address rewardAsset,
        uint256 gasConsumed,
        uint256 maxReward,
        uint256 amount
    );
    event ExecuteGasConsumed(bytes32 indexed id, address rewardAsset, uint256 gasConsumed);

    /// @dev Constructor function for this upgradeable contract
    /// @param  _owner  The owner of the contract, as well as the proxy
    function initialize(address _owner) public initializer {
        require(_owner != address(0), "RO#0");
        _grantRole(DEFAULT_ADMIN_ROLE, _owner);
        __AccessControl_init();
        __ReentrancyGuard_init();
    }
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function setVersion(bytes32 _version) external onlyOwner {
        version = _version;
    }

    function setSourceId(bytes4 _sourceId) external onlyOwner {
        sourceId = _sourceId;
    }

    function setProtocolFeesCollector(address _protocolFeesCollector) external onlyOwner {
        protocolFeesCollector = _protocolFeesCollector;
    }

    function setRPSMax(uint256 _rpsMax) external onlyOwner {
        rpsMax = _rpsMax;
    }

    function setAmountRange(address asset, uint256 minAmount, uint256 maxAmount) external onlyOwner {
        require(minAmount <= maxAmount, "RO#0");
        minAllowedAmounts[asset] = minAmount;
        maxAllowedAmounts[asset] = maxAmount;
    }

    modifier onlyOwnerOrFeeCollector() {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender) || msg.sender == protocolFeesCollector, "RO#0");
        _;
    }

    modifier onlyOwner() {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "RO#0");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "RO#0");
        _;
    }

    modifier onlyOwnerOrOperator() {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender) || msg.sender == operator, "RO#0");
        _;
    }

    modifier isIngressOn() {
        require(!isIngressHalted, "RO#2");
        _;
    }

    modifier isEgressOn() {
        require(!isEgressHalted, "RO#2");
        _;
    }

    modifier isOn() {
        require(!isIngressHalted && !isEgressHalted, "RO#2");
        _;
    }

    function assignClaimerGMP(address payable _claimerGMP) external onlyOwner {
        claimerGMP = ClaimerGMPV2(_claimerGMP);
    }

    function setOperator(address _operator) external onlyOwner {
        operator = _operator;
    }

    function setEscrowGMP(EscrowGMP _escrowGMP) external onlyOwner {
        escrowGMP = _escrowGMP;
    }

    function setHalted(bool _haltIngress, bool _haltEgress) external onlyOwnerOrOperator {
        isIngressHalted = _haltIngress;
        isEgressHalted = _haltEgress;
    }

    function setCurrentProtocolFee(
        uint256 _protocolFee,
        uint256 _protocolFeeFlatLow,
        uint256 _protocolFeeFlatHigh
    ) external onlyOwner {
        require(_protocolFee <= PROTOCOL_FEE_BP, "R0#0");
        require(_protocolFeeFlatHigh <= PROTOCOL_FEE_BP, "R0#0");
        currentProtocolFee = _protocolFee;
        currentProtocolFeeFlatLow = _protocolFeeFlatLow;
        currentProtocolFeeFlatHigh = _protocolFeeFlatHigh;
    }

    function ensureAmountWithinAcceptedRange(address asset, uint256 amount) public view returns (bool) {
        uint256 minAmount = minAllowedAmounts[asset];
        uint256 maxAmount = maxAllowedAmounts[asset];
        if (minAmount == 0 && maxAmount == 0) return true;
        return amount >= minAmount && amount <= maxAmount;
    }

    function ensureRPSInTact() public returns (bool) {
        uint256 _rpsMax = rpsMax == 0 ? 60 : rpsMax;
        // Max 1 RPS (60 per 1m)
        if (block.timestamp - rpsTimestamp > 60) {
            rpsCount = 0;
            rpsTimestamp = block.timestamp;
        }
        return rpsCount <= _rpsMax;
    }

    function ensureDestAssetIsSupported(uint32 assetThere, bytes4 network) public view returns (bool) {
        return (assetThere == 0 || supportedDestAssets[assetThere]) && supportedNetworks[network];
    }

    function generateId(address requester, uint32 nonce) public view returns (bytes32) {
        return generateIdFull(requester, nonce, sourceId);
    }

    function generateIdFull(address requester, uint32 nonce, bytes4 networkId) public pure returns (bytes32) {
        return keccak256(abi.encode(keccak256(abi.encode(requester, nonce, networkId)), bytes32(0)));
    }

    // This function is triggered for plain ETH transfers (no calldata)
    receive() external payable {}

    // This function is triggered when calldata does not match any function signature
    fallback() external payable {
        revert("RO#0");
    }

    // Assume Protocol fee is set in micro-percent
    function calcProtocolFee(uint256 amount, address asset) public view returns (uint256) {
        uint256 flatFee = asset == address(0) ? currentProtocolFeeFlatLow : 0;
        uint256 percentageFee = asset == address(0) ? currentProtocolFee : currentProtocolFeeFlatHigh;
        if (percentageFee == 0) {
            return flatFee;
        }
        return ((amount * percentageFee + PROTOCOL_FEE_BP - 1) / PROTOCOL_FEE_BP) + flatFee;
    }

    function addSupportedNetwork(bytes4 _network, bool _supported) public onlyOwner {
        supportedNetworks[_network] = _supported;
    }

    function addSupportedBridgeAsset(address assetHere, uint32 assetThere, bool _supported) public onlyOwnerOrOperator {
        supportedAssets[assetHere] = assetThere;
        supportedDestAssets[assetThere] = _supported;
    }

    /*
     * Before making the order, the function checks that the user has enough balance (of either Ether or the ERC20 token).
     * If everything is okay, it increases the nonce for the user, creates a unique id for the order, saves the order in the mapping,
     * and emits the OrderCreated event.
     */
    function order(
        bytes4 destination,
        uint32 asset,
        bytes32 targetAccount,
        uint256 amount,
        address rewardAsset,
        uint256 insurance,
        uint256 maxReward
    ) public payable isEgressOn {
        uint256 startGasConsumed = gasleft();
        uint32 nonce = uint32(block.timestamp);
        bytes32 id = generateId(msg.sender, nonce);
        if (rpsMax > 0) {
            rpsCount++;
        }
        require(ensureRPSInTact(), "RO#7");
        require(ensureDestAssetIsSupported(asset, destination), "RO#1");
        require(destination != sourceId);
        require(ensureAmountWithinAcceptedRange(rewardAsset, maxReward), "RO#2");
        if (rewardAsset == address(0)) {
            require(msg.value == maxReward, "RO#7");
        } else {
            require(supportedAssets[rewardAsset] != 0, "RO#1");
            // Verify msg.value is 0 for non-native orders
            require(msg.value == 0, "RO#7");
            IERC20(rewardAsset).safeTransferFrom(msg.sender, address(this), maxReward);
        }
        require(
            escrowGMP.storeRemoteOrderPayload(id, keccak256(abi.encode(rewardAsset, maxReward, block.timestamp))),
            "RO#0"
        );
        emit OrderCreated(
            id,
            destination,
            asset,
            targetAccount,
            amount,
            rewardAsset,
            insurance,
            maxReward,
            uint32(block.timestamp),
            msg.sender,
            block.timestamp
        );
        emit OrderGasConsumed(id, rewardAsset, startGasConsumed - gasleft() + 36000, maxReward, amount);
    }

    function markOrderPayload(bytes32 confirmationId, bytes32 id) external onlyOperator {
        orderPayloads[confirmationId] = id;
    }

    function setExecutionCutOff(uint256 _executionCutOff) external onlyOwner {
        executionCutOff = _executionCutOff;
    }

    function confirmOrderV3(
        bytes32 id,
        address payable target,
        uint256 amount,
        address asset,
        uint32 nonce,
        address sourceAccount,
        bytes4 source
    ) public payable isOn returns (bool) {
        uint256 startGasConsumed = gasleft();
        if (nonce > block.timestamp) {
            revert("RO#2");
        }
        // Protect against overtime confirmations by re-constructing order ID out of timestamp-based nonce
        if (block.timestamp - nonce > executionCutOff) {
            revert("RO#2");
        }

        if (asset == address(0)) {
            require(msg.value == amount, "RO#2");
        }

        if (id != generateIdFull(sourceAccount, nonce, source)) {
            revert("RO#7");
        }

        bytes32 confirmationId = keccak256(abi.encode(id, target, amount, asset, msg.sender));
        bytes32 orderConfirmationId = keccak256(abi.encode(id, target, amount, asset));

        // First, check if the order is already confirmed
        if (orderPayloads[confirmationId] != bytes32(0)) {
            revert("RO#7"); // RO#7: The operation was already confirmed
        }

        // Check if the order was delivered by another executor, preventing double executions by 2 accounts
        if (orderPayloads[orderConfirmationId] != bytes32(0)) {
            revert("RO#2"); // RO#2: The operation was already confirmed
        }

        // Store the confirmationId before proceeding
        orderPayloads[confirmationId] = id;
        orderPayloads[orderConfirmationId] = id;

        if (asset == address(0)) {
            require(msg.value == amount, "RO#2");
        }

        require(settleNativeOrToken(amount, asset, target, msg.sender), "RO#2");

        emit Confirmation(id, target, amount, asset, msg.sender, confirmationId, block.timestamp);
        emit ExecuteGasConsumed(id, asset, startGasConsumed - gasleft() + 34000);
        return true;
    }

    /*
     * Checks if the id exists in the contract.
     * The function will return true if the order has been Accepted, Committed, or Reverted.
     */
    function isKnownId(bytes32 id) public view returns (bool) {
        return escrowGMP.remotePaymentsPayloadHash(id) != bytes32(0);
    }

    function checkIsClaimableV2(
        bytes32 orderId,
        address rewardAsset,
        uint256 maxReward,
        uint256 settledAmount,
        address beneficiary,
        uint256 orderTimestamp,
        bytes32 _batchPayloadHash,
        bytes memory _batchPayload
    ) public view returns (bool) {
        if (isEgressHalted) return false;
        if (address(claimerGMP) == address(0)) return false;
        return
            claimerGMP.checkIsClaimable(
                orderId,
                rewardAsset,
                maxReward,
                settledAmount,
                beneficiary,
                orderTimestamp,
                _batchPayloadHash,
                _batchPayload
            );
    }

    function claimRefundV2(
        uint32 orderNonce,
        address rewardAsset,
        uint256 maxReward,
        uint256 orderTimestamp,
        bytes32 _batchPayloadHash,
        bytes memory _batchPayload
    ) public isEgressOn {
        bytes32 orderId = generateId(msg.sender, orderNonce);
        require(
            claimerGMP.checkIsRefundable(
                orderId,
                orderTimestamp,
                executionCutOff,
                rewardAsset,
                maxReward,
                msg.sender,
                _batchPayloadHash,
                _batchPayload
            ),
            "RO#1"
        );
        escrowGMP.twoifyPayloadHash(orderId);
        require(settleNativeOrToken(maxReward, rewardAsset, msg.sender, address(this)), "RO#2");
        emit ClaimedRefund(orderId, msg.sender, maxReward, rewardAsset);
    }

    function claimPayout(
        bytes32 orderId,
        address rewardAsset,
        uint256 maxReward,
        uint256 settledAmount,
        uint256 orderTimestamp
    ) public payable isEgressOn {
        claimPayoutV2(orderId, rewardAsset, maxReward, settledAmount, orderTimestamp, bytes32(0), "");
    }

    function claimPayoutV2(
        bytes32 orderId,
        address rewardAsset,
        uint256 maxReward,
        uint256 settledAmount,
        uint256 orderTimestamp,
        bytes32 _batchPayloadHash,
        bytes memory _batchPayload
    ) public payable isEgressOn {
        // Withdraw the reward as payout
        require(
            checkIsClaimableV2(
                orderId,
                rewardAsset,
                maxReward,
                settledAmount,
                msg.sender,
                orderTimestamp,
                _batchPayloadHash,
                _batchPayload
            ),
            "RO#1"
        );
        escrowGMP.oneifyPayloadHash(orderId);
        if (settledAmount == 0) {
            settledAmount = maxReward;
        }
        settlePayoutWithFees(settledAmount, rewardAsset, msg.sender, address(this));
        emit Claimed(orderId, msg.sender, settledAmount, rewardAsset);
    }

    struct Payout {
        bytes32 id;
        address rewardAsset;
        uint256 maxReward;
        uint256 settledAmount;
        uint256 orderTimestamp;
    }

    struct ConfirmBatchOrderEntry {
        bytes32[] ids;
        address payable[] targets;
        uint256[] amounts;
        address[] assets;
        uint32[] nonces;
        address[] sourceAccount;
        bytes4[] source;
    }

    function settlePayoutWithFees(uint256 amount, address asset, address beneficiary, address sender) internal {
        uint256 fees = calcProtocolFee(amount, asset);
        if (fees > amount) {
            fees = amount;
        }
        protocolFeesAccrued[asset] += fees;
        require(settleNativeOrToken(amount - fees, asset, beneficiary, sender), "RO#7");
    }

    function settlePayoutWithFeesCall(
        uint256 amount,
        address asset,
        address beneficiary,
        address sender,
        uint8 GMPAction,
        bytes32 orderId
    ) public payable onlyOperator {
        if (GMPAction == 0) {
            settlePayoutWithFees(amount, asset, beneficiary, sender);
            emit Claimed(orderId, beneficiary, 0, asset);
        }
        if (GMPAction == 1) {
            settlePayoutWithFees(amount, asset, beneficiary, sender);
            emit ClaimedRefund(orderId, beneficiary, amount, asset);
        }
        if (GMPAction == 6) {
            require(settleNativeOrToken(amount, asset, beneficiary, sender), "RO#2"); // Settle the full amount without fees
        }
    }

    function settleNativeOrToken(
        uint256 amount,
        address asset,
        address beneficiary,
        address sender
    ) internal nonReentrant returns (bool) {
        if (amount == 0) return true;
        if (beneficiary == address(0)) return false;
        if (asset == address(0)) {
            bool success = false;
            assembly {
                success := call(21000, beneficiary, amount, 0, 0, 0, 0)
            }
            return success;
        }
        // Assume both below to revert on failure
        if (sender == address(this)) {
            IERC20(asset).safeTransfer(beneficiary, amount);
        } else {
            IERC20(asset).safeTransferFrom(sender, beneficiary, amount);
        }
        return true;
    }

    function emergencyWithdraw(
        address asset,
        uint256 amount,
        address beneficiary
    ) external onlyOwnerOrFeeCollector isEgressOn {
        if (msg.sender == protocolFeesCollector) {
            protocolFeesAccrued[asset] -= amount;
        }
        require(settleNativeOrToken(amount, asset, beneficiary, address(this)), "RO#2");
    }
}
