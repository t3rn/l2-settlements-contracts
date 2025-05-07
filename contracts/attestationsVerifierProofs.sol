// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "./escrowGMP.sol";
import "./remoteOrder.sol";

contract AttestationsVerifierProofs is AccessControlUpgradeable {
    using SafeERC20 for IERC20;
    using MerkleProof for bytes[];

    bool public areCallCommitmentsEnabled;
    bool public arePayloadCommitmentsEnabled;
    bool public selfBatchIndex;
    uint256 public committeeSize;
    uint256 public quorum;
    uint256 public currentCommitteeTransitionCount;
    uint256 public currentBatchIndex;
    uint256 public totalAttesters; // added a counter to track total attestors.
    bytes32 public currentCommitteeHash;
    bytes32 public currentCommitteeStake; // staled (TRN | DOT) (uint64 | uint64) and 3-pool-liquid (TRN | DOT) (uint64 | uint64)
    bytes32 public nextCommitteeHash;

    mapping(bytes32 => bool) public committedGMPMessagesMap;

    bytes32 public version;

    EscrowGMP public escrowGMP;
    RemoteOrder public orderer;

    bool public skipEscrowWrites;

    bytes32 public hashHead;

    mapping(address => bool) public operators;

    struct Batch {
        bool is_halted;
        bytes32 currentCommitteeHash;
        bytes32 nextCommitteeHash;
        address[] maybeNextCommittee;
        address[] bannedCommittee;
        bytes encodedGMPPayload;
        uint32 index;
    }

    event SignerEmitted(address indexed signer);
    event TestEvent(bool, bool, bytes32[] leaves, address[] addressesRecovered, bytes32);
    event BatchApplied(bytes32 indexed batchHash, address indexed executor, bytes32 indexed attestingCommitteeHash);
    event BatchProcessingError(bytes32 indexed batchHash, address indexed executor, uint32 indexed batchIndex);
    event AlreadyApplied(bytes32 indexed committmentMessageHash);
    event CommitmentApplied(
        bytes32 indexed batchHash,
        address indexed executor,
        bytes32 indexed attestingCommitteeHash
    );
    event TransferCommitApplied(bytes32 indexed sfxId, address indexed executor);
    event TransferRevertApplied(bytes32 indexed sfxId);
    event EscrowCommitApplied(bytes32 indexed sfxId, address indexed executor);
    event CallCommitApplied(bytes32 indexed sfxId);
    event CallRevertApplied(bytes32 indexed sfxId);
    event SignerNotInCommittee(address indexed signer);

    /// @dev Constructor function for this upgradeable contract
    /// @param  _owner  The owner of the contract, as well as the proxy
    /// @param  initialCommittee  List of addresses of the members of the initial committee
    /// @param  nextCommittee  List of addresses of the members of the following committee
    /// @param  startingIndex  Start index of the attestations batch index
    function initialize(
        address _owner,
        address[] memory initialCommittee,
        address[] memory nextCommittee,
        uint256 startingIndex
    ) public initializer {
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _owner);
        currentCommitteeTransitionCount = 1;
        totalAttesters = initialCommittee.length;
        currentBatchIndex = startingIndex;
        committeeSize = initialCommittee.length;
        if (initialCommittee.length == 1) {
            quorum = 1;
        } else {
            quorum = (initialCommittee.length * 2) / 3;
        }
        if (initialCommittee.length > 0) {
            currentCommitteeHash = implyCommitteeRoot(initialCommittee);
        }
        if (nextCommittee.length > 0) {
            nextCommitteeHash = implyCommitteeRoot(nextCommittee);
        }
        areCallCommitmentsEnabled = false;
        arePayloadCommitmentsEnabled = true;
        selfBatchIndex = true;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function setVersion(bytes32 _version) public onlyOwner {
        version = _version;
    }

    function setSkipEscrowWrites(bool _skipEscrowWrites) public onlyOwner {
        skipEscrowWrites = _skipEscrowWrites;
    }

    modifier onlyOwner() {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "ONLY_OWNER");
        _;
    }

    modifier onlyOwnerOrOperator() {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender) || operators[msg.sender], "ONLY_OWNER_OR_OPERATOR");
        _;
    }

    function assignOrderer(address payable _orderer) external onlyOwner {
        orderer = RemoteOrder(_orderer);
    }

    function assignEscrowGMP(address payable _escrowGMP) external onlyOwner {
        escrowGMP = EscrowGMP(_escrowGMP);
    }

    function turnOnCallCommitments() external onlyOwner {
        areCallCommitmentsEnabled = true;
    }

    function turnOffCallCommitments() external onlyOwner {
        areCallCommitmentsEnabled = false;
    }

    function turnOnSelfBatchIndexing() external onlyOwner {
        selfBatchIndex = true;
    }

    function turnOffSelfBatchIndexing() external onlyOwner {
        selfBatchIndex = false;
    }

    function turnOnPayloadCommitments() external onlyOwner {
        arePayloadCommitmentsEnabled = true;
    }

    function turnOffPayloadCommitments() external onlyOwner {
        arePayloadCommitmentsEnabled = false;
    }

    function setBatchIndex(uint256 _batchIndex) external onlyOwner {
        currentBatchIndex = _batchIndex;
    }

    function setQuorum(uint256 _quorum) external onlyOwner {
        quorum = _quorum;
    }

    function setOperator(address _operator) external onlyOwner {
        operators[_operator] = true;
    }

    function batchEncode(Batch memory batch) public pure returns (bytes memory) {
        return
            abi.encode(
                batch.is_halted,
                batch.currentCommitteeHash,
                batch.nextCommitteeHash,
                batch.maybeNextCommittee,
                batch.bannedCommittee,
                batch.encodedGMPPayload,
                batch.index
            );
    }

    function messageHash(Batch memory batch) public pure returns (bytes32) {
        return keccak256(batchEncode(batch));
    }

    function singleAttestationHash(
        bytes calldata messageGMPPayload,
        bytes4 sourceGateway,
        uint32 sourceHeight
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(keccak256(messageGMPPayload), sourceGateway, sourceHeight));
    }

    function overrideCommitteeHash(bytes32 newCommitteeHash) public onlyOwner {
        currentCommitteeHash = newCommitteeHash;
    }

    function overrideNextCommitteeHash(bytes32 newCommitteeHash) public onlyOwner {
        nextCommitteeHash = newCommitteeHash;
    }

    function overrideCurrentBatchIndex(uint256 newBatchIndex) public onlyOwner {
        currentBatchIndex = newBatchIndex;
    }

    function implyCommitteeRoot(address[] memory committee) public pure returns (bytes32) {
        bytes32[] memory leaves = new bytes32[](committee.length);
        for (uint256 i = 0; i < committee.length; ++i) {
            leaves[i] = keccak256(bytes.concat(keccak256(abi.encode(committee[i]))));
        }
        bytes32[] memory multiProofProof = new bytes32[](0);
        bool[] memory multiProofMembershipFlags = new bool[](committee.length - 1);
        for (uint256 i = 0; i < committee.length - 1; ++i) {
            multiProofMembershipFlags[i] = true;
        }

        uint256 leavesLen = leaves.length;
        uint256 proofLen = multiProofProof.length;
        uint256 totalHashes = multiProofMembershipFlags.length;
        require(leavesLen + proofLen == totalHashes + 1, "PROOF_LENGTH");

        return MerkleProof.processMultiProof(multiProofProof, multiProofMembershipFlags, leaves);
    }

    function updateCommitteeSize(uint256 newCommitteeSize) public onlyOwner {
        committeeSize = newCommitteeSize;
        if (newCommitteeSize == 1) {
            quorum = 1;
        } else {
            quorum = (newCommitteeSize * 2) / 3;
        }
    }

    // Receive attestations for orders with source on t3rn's Circuit
    function receiveAttestationBatch(
        bytes calldata batchPayload,
        bytes calldata messageGMPPayload,
        bytes[] calldata signatures,
        bytes32[] calldata multiProofProof,
        bool[] calldata multiProofMembershipFlags
    ) public {
        Batch memory batch = abi.decode(batchPayload, (Batch));
        bytes32 batchMessageHash = keccak256(batchEncode(batch));
        // Check if batch of the message is the same and return Ok not to burn gas
        if (committedGMPMessagesMap[batchMessageHash]) {
            emit AlreadyApplied(batchMessageHash);
            return;
        }

        if (!selfBatchIndex) {
            require(batch.index == currentBatchIndex + 1, "BATCH_INDEX_MISMATCH");
        }

        bytes32[] memory attestersAsLeaves = recoverCurrentSigners(batchMessageHash, signatures, batch.bannedCommittee);

        require(attestersAsLeaves.length >= quorum, "INSUFFICIENT_QUORUM");

        // Check if maybeNextCommittee contains new members commitment
        // If so, use the currently store next committee hash to verify signatures
        // Otherwise, use the currently stored current committee hash to verify signatures
        if (batch.maybeNextCommittee.length > 0) {
            // Current committee has signed on the next committee - if the batch proposes committee rotation - verify the signatures against the next committee hash
            require(
                MerkleProof.multiProofVerifyCalldata(
                    multiProofProof,
                    multiProofMembershipFlags,
                    nextCommitteeHash,
                    attestersAsLeaves
                ),
                "PROOF_NEXT_VERIFICATION_FAILED"
            );
            // Update the current committee hash to the next committee hash, since the batch has been applied meaning new committee has been formed
            bytes32 impliedNextCommitteeHash = implyCommitteeRoot(batch.maybeNextCommittee);
            currentCommitteeHash = nextCommitteeHash;
            nextCommitteeHash = impliedNextCommitteeHash;
        } else {
            require(
                MerkleProof.multiProofVerifyCalldata(
                    multiProofProof,
                    multiProofMembershipFlags,
                    currentCommitteeHash,
                    attestersAsLeaves
                ),
                "PROOF_VERIFICATION_FAILED"
            );
        }
        require(keccak256(messageGMPPayload) == keccak256(batch.encodedGMPPayload), "GMP_PAYLOAD_MISMATCH");

        if (arePayloadCommitmentsEnabled == true) {
            committedGMPMessagesMap[batchMessageHash] = true;
            require(decodeAndProcessPayload(messageGMPPayload), "PAYLOAD_PROCESSING_FAILED");
            if (currentBatchIndex + 1 == batch.index) {
                currentBatchIndex = batch.index;
                hashHead = batchMessageHash;
            }
            emit BatchApplied(batchMessageHash, msg.sender, currentCommitteeHash);
            return;
        }
        emit BatchProcessingError(batchMessageHash, msg.sender, batch.index);
    }

    function backdoorBatchHash(bytes32 batchHash) public onlyOwnerOrOperator {
        committedGMPMessagesMap[batchHash] = true;
    }

    // Check if attestation is applied
    function isAttestationApplied(bytes32 id) public view returns (bool) {
        return committedGMPMessagesMap[id];
    }

    function recoverCurrentSigners(
        bytes32 expectedBatchHash,
        bytes[] calldata signatures,
        address[] memory bannedCommittee
    ) public pure returns (bytes32[] memory) {
        bytes32[] memory leaves = new bytes32[](signatures.length);
        for (uint256 i = 0; i < signatures.length; ++i) {
            address recoveredSigner = recoverSigner(expectedBatchHash, signatures[i]);
            require(recoveredSigner != address(0), "BAD_SIGNATURE");
            if (bannedCommittee.length > 0) {
                require(!addressArrayContains(bannedCommittee, recoveredSigner), "SIGNER_BANNED");
            }
            leaves[i] = keccak256(bytes.concat(keccak256(abi.encode(recoveredSigner))));
        }
        return leaves;
    }

    enum OperationType {
        TransferCommit,
        TransferRevert,
        EscrowCommitApplied,
        Mint,
        CallCommit,
        CircuitHeaderEncoded,
        TransferCommitOpenMarket
    }

    function decodeAndProcessPayload(bytes calldata payload) private returns (bool) {
        require(payload.length > 0, "EMPTY_PAYLOAD");

        uint256 offset = 0;
        while (offset < payload.length) {
            uint8 opType = uint8(payload[offset]);
            offset += 1; // To move past the operation type byte
            if (opType == uint8(OperationType.TransferCommit)) {
                if (payload.length >= offset + 52) {
                    bytes32 orderId = bytes32(payload[offset:offset + 32]);
                    if (orderId != bytes32(0)) {
                        address destination = address(bytes20(payload[offset + 32:offset + 52]));
                        if (destination != address(0)) {
                            if (skipEscrowWrites || escrowGMP.commitRemoteBeneficiaryPayload(orderId, destination)) {
                                emit TransferCommitApplied(orderId, destination);
                            }
                        } else {
                            escrowGMP.signalOrderGMPMismatch(orderId, address(0));
                        }
                    }
                }
                offset += 52;
            } else if (opType == uint8(OperationType.TransferRevert)) {
                if (payload.length >= offset + 32) {
                    bytes32 orderId = bytes32(payload[offset:offset + 32]);
                    if (orderId != bytes32(0)) {
                        emit TransferRevertApplied(orderId);
                    }
                }
                offset += 32;
            } else if (opType == uint8(OperationType.EscrowCommitApplied)) {
                if (payload.length >= offset + 32) {
                    bytes32 orderId = bytes32(payload[offset:offset + 32]);
                    if (orderId != bytes32(0)) {
                        address destination = address(bytes20(payload[offset + 32:offset + 52]));
                        if (destination != address(0)) {
                            if (skipEscrowWrites || escrowGMP.commitEscrowBeneficiaryPayload(orderId, destination)) {
                                emit EscrowCommitApplied(orderId, destination);
                            }
                        } else {
                            escrowGMP.signalOrderGMPMismatch(orderId, address(0));
                        }
                    }
                }
                offset += 32;
            } else {
                return false;
            }
        }
        return true;
    }

    function addressArrayContains(address[] memory array, address value) private pure returns (bool) {
        for (uint256 i = 0; i < array.length; ++i) {
            if (array[i] == value) {
                return true;
            }
        }
        return false;
    }

    function recoverSigner(bytes32 _messageHash, bytes memory signature) public pure returns (address) {
        bytes32 r;
        bytes32 s;
        uint8 v;

        if (signature.length != 65) {
            return address(0);
        }

        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }

        if (v < 27) {
            v += 27;
        }

        if (v != 27 && v != 28) {
            return address(0);
        } else {
            bytes32 prefixedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", _messageHash));
            return ecrecover(prefixedHash, v, r, s);
        }
    }
}
