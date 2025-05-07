// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

contract EscrowGMP is AccessControlUpgradeable {
    address private attesters;
    address private orderer;
    address private escrowOrderer;

    mapping(bytes32 => bytes) public escrowOrders;
    mapping(bytes32 => bool) public remotePayments;
    mapping(bytes32 => bytes32) public remotePaymentsPayloadHash;
    mapping(bytes32 => bytes32) public escrowOrdersPayloadHash;

    bytes32 public version;
    mapping(address => bool) public orderers;
    address private avpBatchSubmitter;

    struct RemotePayment {
        address payable executor;
        bytes32 payloadHash;
    }

    event GMPExpectedPayloadNotMatched(
        bytes32 indexed sfxId,
        address indexed beneficiary,
        bytes32 indexed actualPayloadHash
    );

    bytes32 public constant EMPTY_PAYLOAD = bytes32(0);
    bytes32 public constant CLAIMED_PAYLOAD = bytes32(uint256(1));
    bytes32 public constant REFUNDED_PAYLOAD = bytes32(uint256(2));

    event PresumablyLateExecution(bytes32 indexed sfxId, address indexed beneficiary);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @dev Constructor function for this upgradeable contract
    /// @param  _owner  The owner of the contract, as well as the proxy
    function initialize(address _owner) public initializer {
        // Verify that the owner is not the zero address & msg.sender
        require(_owner != address(0), "Owner cannot be zero address");
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _owner);
    }

    function setVersion(bytes32 _version) external onlyOwner {
        version = _version;
    }

    modifier onlyOwner() {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "Only owner can call this function");
        _;
    }

    modifier onlyOrderer() {
        require(msg.sender == orderer, "Only order contract can call this function");
        _;
    }

    modifier onlyOneOfOrderers() {
        require(orderers[msg.sender], "Only an orderer contract can call this function");
        _;
    }

    modifier onlyEscrowOrderer() {
        require(msg.sender == escrowOrderer, "Only escrow orderer can call this function");
        _;
    }

    modifier onlyAttesters() {
        require(msg.sender == attesters, "Only Attesters can call this function");
        _;
    }

    function assignAttesters(address _attesters) external onlyOwner {
        attesters = _attesters;
    }

    function assignOrderer(address _orderer) external onlyOwner {
        _addOrderer(_orderer);
        orderer = _orderer;
    }

    function assignAVPBatchSubmitter(address _avpBatchSubmitter) external onlyOwner {
        _addOrderer(_avpBatchSubmitter);
        avpBatchSubmitter = _avpBatchSubmitter;
    }

    function assignEscrowOrderer(address _escrowOrderer) external onlyOwner {
        _addOrderer(_escrowOrderer);
        escrowOrderer = _escrowOrderer;
    }

    function addOrderer(address _orderer) external onlyOwner {
        _addOrderer(_orderer);
    }

    function removeOrderer(address _orderer) external onlyOwner {
        _removeOrderer(_orderer);
    }

    function _addOrderer(address _orderer) internal {
        orderers[_orderer] = true;
    }

    function _removeOrderer(address _orderer) internal {
        orderers[_orderer] = false;
    }

    function getAttesters() external view returns (address) {
        return attesters;
    }

    function getOrderer() external view returns (address) {
        return orderer;
    }

    function getEscrowOrderer() external view returns (address) {
        return escrowOrderer;
    }

    function getAVPBatchSubmitter() external view returns (address) {
        return avpBatchSubmitter;
    }

    function storeEscrowOrderPayload(
        bytes32 sfxId,
        bytes32 payloadHash,
        bytes calldata orderData
    ) external onlyEscrowOrderer returns (bool) {
        // Check if the payload is already stored and return false if it is
        if (escrowOrdersPayloadHash[sfxId] != 0) {
            return (false);
        }

        // Store the payment payload (hash of the payload)
        escrowOrdersPayloadHash[sfxId] = payloadHash;

        // Store the encoded order data (see EscrowOrder.OrderDetails in escrowOrder.sol)
        escrowOrders[sfxId] = orderData;

        return (true);
    }

    function storeRemoteOrderPayload(bytes32 orderId, bytes32 payloadHash) external onlyOrderer returns (bool) {
        // Check if the payload is already stored and return false if it is
        if (remotePaymentsPayloadHash[orderId] != 0) {
            return (false);
        }
        // Store the payment payload (hash of the payload)
        remotePaymentsPayloadHash[orderId] = payloadHash;
        return (true);
    }

    function signalEscrowGMPMismatch(bytes32 sfxId, address beneficiary) external onlyAttesters {
        bytes32 actualPayloadHash = escrowOrdersPayloadHash[sfxId];
        emit GMPExpectedPayloadNotMatched(sfxId, beneficiary, actualPayloadHash);
    }

    function signalOrderGMPMismatch(bytes32 orderId, address beneficiary) external onlyAttesters {
        bytes32 actualPayloadHash = remotePaymentsPayloadHash[orderId];
        emit GMPExpectedPayloadNotMatched(orderId, beneficiary, actualPayloadHash);
    }

    function commitEscrowBeneficiaryPayload(bytes32 sfxId, address beneficiary) external onlyAttesters returns (bool) {
        // Update the payment payload (hash of the payload)
        bytes32 currentHash = escrowOrdersPayloadHash[sfxId];
        if (currentHash == EMPTY_PAYLOAD) {
            emit GMPExpectedPayloadNotMatched(sfxId, beneficiary, currentHash);
            return (false);
        }

        // If the payload is two, then it's presumably late execution
        if (currentHash == bytes32(uint256(2))) {
            emit PresumablyLateExecution(sfxId, beneficiary);
            return (false);
        }

        // Update the payment payload (hash of the payload)
        bytes32 newHash = keccak256(abi.encode(currentHash, beneficiary));
        escrowOrdersPayloadHash[sfxId] = newHash;
        return (true);
    }

    function commitRemoteBeneficiaryPayload(
        bytes32 orderId,
        address beneficiary
    ) external onlyAttesters returns (bool) {
        // Update the payment payload (hash of the payload)
        bytes32 currentHash = remotePaymentsPayloadHash[orderId];
        if (currentHash == EMPTY_PAYLOAD) {
            emit GMPExpectedPayloadNotMatched(orderId, beneficiary, currentHash);
            return (false);
        }
        if (currentHash == bytes32(uint256(2))) {
            emit PresumablyLateExecution(orderId, beneficiary);
            return (false);
        }
        bytes32 newHash = keccak256(abi.encode(currentHash, beneficiary));
        remotePaymentsPayloadHash[orderId] = newHash;
        return (true);
    }

    function commitRemoteBeneficiaryPayloadOpenMarket(
        bytes32 orderId,
        address beneficiary,
        uint256 rewardSettled
    ) external onlyAttesters returns (bool) {
        // Update the payment payload (hash of the payload)
        bytes32 currentHash = remotePaymentsPayloadHash[orderId];
        if (currentHash == EMPTY_PAYLOAD) {
            emit GMPExpectedPayloadNotMatched(orderId, beneficiary, currentHash);
            return (false);
        }
        if (currentHash == bytes32(uint256(2))) {
            emit PresumablyLateExecution(orderId, beneficiary);
            return (false);
        }
        bytes32 newHash = keccak256(abi.encode(currentHash, beneficiary, rewardSettled));
        remotePaymentsPayloadHash[orderId] = newHash;
        return (true);
    }

    function revertRemoteOrderPayload(bytes32 orderId) external onlyAttesters returns (bool) {
        // Update the payment payload (hash of the payload)
        bytes32 currentHash = remotePaymentsPayloadHash[orderId];
        if (currentHash == EMPTY_PAYLOAD) {
            emit GMPExpectedPayloadNotMatched(orderId, address(0), currentHash);
            return (false);
        }
        bytes32 newHash = keccak256(abi.encode(currentHash, address(0)));
        remotePaymentsPayloadHash[orderId] = newHash;
        return (true);
    }

    // Payload getter
    function getRemotePaymentPayloadHash(bytes32 orderId) external view returns (bytes32) {
        return remotePaymentsPayloadHash[orderId];
    }

    // Nullify payload
    function nullifyPayloadHash(bytes32 orderId) external onlyOneOfOrderers {
        if (escrowOrderer == msg.sender) {
            escrowOrdersPayloadHash[orderId] = EMPTY_PAYLOAD;
        } else {
            remotePaymentsPayloadHash[orderId] = EMPTY_PAYLOAD;
        }
    }

    // Nullify Payload with One - One to be assumed it's claimed by executor
    function oneifyPayloadHash(bytes32 orderId) external onlyOneOfOrderers {
        if (escrowOrderer == msg.sender) {
            escrowOrdersPayloadHash[orderId] = CLAIMED_PAYLOAD;
        } else {
            remotePaymentsPayloadHash[orderId] = CLAIMED_PAYLOAD;
        }
    }

    // Nullify Payload with Two - Two to be assumed it's refunded by user
    function twoifyPayloadHash(bytes32 orderId) external onlyOneOfOrderers {
        if (escrowOrderer == msg.sender) {
            escrowOrdersPayloadHash[orderId] = REFUNDED_PAYLOAD;
        } else {
            remotePaymentsPayloadHash[orderId] = REFUNDED_PAYLOAD;
        }
    }
}
