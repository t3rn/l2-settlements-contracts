// contracts/ERC20Mock.sol
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "./TRNInflation.sol";

contract TRNInflationRewards is AccessControlUpgradeable, ReentrancyGuardUpgradeable {
    address public orderBook;
    address public biddingBook;
    TRNInflation public _TRNInflation;

    mapping(bytes4 => uint256) public perNetworkRewardMultiplier; // by networkId
    // Weekly counters for first FIFO amount of executors, users and attestors
    uint256 public weeklyExecutorRewards;
    uint256 public weeklyUsersCounter;
    uint256 public weeklyAttestersCounter;
    uint256 public weeklyMaxExecutorRewards;
    uint256 public weeklyMaxUsers;
    uint256 public weeklyMaxAttestors;
    uint256 public constant ONE = 1000000000000000000;
    mapping(bytes4 => bool) public testNetworks; // by networkId
    mapping(bytes4 => bool) public mainNetworks; // by networkId
    mapping(uint32 => uint256) public pointsPerAssetUnit;
    bool public isRewardsDistributionOn;
    uint256 public nextResetTime;

    bytes32 public version;

    event DistributionAttempt(address indexed to, uint256 amount, bool success, string reason);
    event WeeklyCountersReset(uint256 indexed timestamp);

    function initialize(address _owner) public initializer {
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _owner);

        weeklyExecutorRewards = 0;
        weeklyUsersCounter = 0;
        weeklyExecutorRewards = 0;
        weeklyMaxExecutorRewards = 10000;
        weeklyMaxUsers = 10000;
        weeklyMaxAttestors = 10000;
        // Set 10 blocks of l3rn for each network:
        //  opsp - optimism-sepolia - "0x6f707370"
        //  bsct - binance-testnet - "0x62736374"
        //  arbt - arbitrum-sepolia - "0x61726274"
        //  bssp - base-sepolia - "0x62737370"
        //  l0rn - l0rn - "0x6c30726e"
        //  sepl - sepolia - "0x7365706c"
        perNetworkRewardMultiplier[bytes4(0x6f707370)] = 1;
        perNetworkRewardMultiplier[bytes4(0x62736374)] = 1;
        perNetworkRewardMultiplier[bytes4(0x61726274)] = 1;
        perNetworkRewardMultiplier[bytes4(0x62737370)] = 1;
        perNetworkRewardMultiplier[bytes4(0x6c30726e)] = 1;
        perNetworkRewardMultiplier[bytes4(0x7365706c)] = 1;

        __ReentrancyGuard_init();
    }
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    modifier onlyOwner() {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "Only owner can call this function");
        _;
    }

    function setVersion(bytes32 _version) public onlyOwner {
        version = _version;
    }

    receive() external payable {}
    fallback() external payable {}
    function setMaxWeeklyExecutors(uint256 _weeklyMaxExecutors) public onlyOwner {
        weeklyMaxExecutorRewards = _weeklyMaxExecutors;
    }
    function setMaxWeeklyUsers(uint256 _weeklyMaxUsers) public onlyOwner {
        weeklyMaxUsers = _weeklyMaxUsers;
    }
    function setMaxWeeklyAttestors(uint256 _weeklyMaxAttestors) public onlyOwner {
        weeklyMaxAttestors = _weeklyMaxAttestors;
    }
    function setTRNInflationAddress(address payable __TRNInflation) public onlyOwner {
        _TRNInflation = TRNInflation(__TRNInflation);
    }

    modifier onlyTRNInflation() {
        require(msg.sender == address(_TRNInflation), "Only TRNInflation can call this function");
        _;
    }

    modifier onlyBiddingBook() {
        require(msg.sender == biddingBook, "Only bidding book can call this function");
        _;
    }
    modifier onlyOrderBook() {
        require(msg.sender == orderBook, "Only order book can call this function");
        _;
    }
    function setRewardsDistributionOn() public onlyOwner {
        isRewardsDistributionOn = true;
    }
    function setRewardsDistributionOff() public onlyOwner {
        isRewardsDistributionOn = false;
    }
    function setTestNetwork(bytes4 networkId) public onlyOwner {
        testNetworks[networkId] = true;
    }
    function setMainNetwork(bytes4 networkId) public onlyOwner {
        mainNetworks[networkId] = true;
    }
    function setPerNetworkRewardMultiplier(bytes4 networkId, uint256 multiplier) public onlyOwner {
        perNetworkRewardMultiplier[networkId] = multiplier;
    }
    function getPerNetworkRewardMultiplier(bytes4 networkId) public view returns (uint256) {
        return perNetworkRewardMultiplier[networkId];
    }
    function checkIsInflationOn() public view returns (bool) {
        return _TRNInflation.checkIsInflationOn();
    }
    function checkIsRewardsDistributionOn() public view returns (bool) {
        return checkIsInflationOn() && isRewardsDistributionOn;
    }
    function setBiddingBookAddress(address _orderBookAddress) public onlyOwner {
        biddingBook = _orderBookAddress;
    }
    function setOrderBookAddress(address _orderBookAddress) public onlyOwner {
        orderBook = _orderBookAddress;
    }
    function resetWeeklyCounters() public onlyTRNInflation {
        require(block.timestamp >= nextResetTime, "It is not time to reset yet");
        weeklyExecutorRewards = 0;
        weeklyUsersCounter = 0;
        weeklyAttestersCounter = 0;
        nextResetTime = block.timestamp + 1 weeks; // set the next reset time one week from now emit WeeklyCountersReset(block.timestamp);
        emit WeeklyCountersReset(block.timestamp);
    }
    function readPerNetworkMultiplier(bytes4 _networkId) public view returns (uint256) {
        uint256 multiplier = perNetworkRewardMultiplier[_networkId];
        if (multiplier == 0) {
            multiplier = 1;
        }
        return multiplier;
    }
    function setPointsPerAssetUnit(uint32 assetId, uint256 points) public onlyOwner {
        pointsPerAssetUnit[assetId] = points;
    }
    function getPointsPerAssetUnit(uint32 assetId) public view returns (uint256) {
        return pointsPerAssetUnit[assetId];
    }
    function calculateAssetAmountToPoints(uint32 assetId, uint256 amount) public view returns (uint256) {
        return amount * pointsPerAssetUnit[assetId];
    }
    function isTestNetwork(bytes4 networkId) public view returns (bool) {
        return testNetworks[networkId];
    }
    function isMainNetwork(bytes4 networkId) public view returns (bool) {
        return mainNetworks[networkId];
    }
    function calculateReward(bytes4 network, uint32 assetId, uint256 amount) public view returns (uint256) {
        uint256 reward = 0;
        if (isTestNetwork(network)) {
            reward = ONE;
        } else if (isMainNetwork(network)) {
            reward = calculateAssetAmountToPoints(assetId, amount);
        }
        return reward;
    }
    function distributeRewardAmountToFirstWeeklyExecutors(
        bytes4 network,
        uint32 _assetId,
        uint256 _amount,
        address _executorAddress
    ) public onlyBiddingBook returns (uint256) {
        if (!checkIsRewardsDistributionOn()) {
            return 0;
        }
        if (weeklyExecutorRewards >= weeklyMaxExecutorRewards) {
            return 0;
        }
        uint256 multiplier = readPerNetworkMultiplier(network);
        uint256 reward = calculateReward(network, _assetId, _amount);
        if (distribute(_executorAddress, reward * multiplier)) {
            weeklyExecutorRewards++;
            return reward;
        }
        return 0;
    }
    function distributeRewardAmountToFirstWeeklyUsers(
        bytes4 network,
        uint32 _assetId,
        uint256 _amount,
        address _userAddress
    ) public onlyBiddingBook returns (bool) {
        if (!checkIsRewardsDistributionOn()) {
            return false;
        }
        if (weeklyUsersCounter >= weeklyMaxUsers) {
            return false;
        }
        uint256 multiplier = readPerNetworkMultiplier(network);
        uint256 reward = calculateReward(network, _assetId, _amount);
        if (distribute(_userAddress, reward * multiplier)) {
            weeklyUsersCounter++;
            return true;
        }
        return false;
    }
    function distributeFixedAmountToFirstWeeklyAttestors(
        bytes4 network,
        address _attesterAddress
    ) public onlyOrderBook returns (bool) {
        if (!checkIsRewardsDistributionOn()) {
            return false;
        }
        uint256 multiplier = readPerNetworkMultiplier(network);
        if (weeklyAttestersCounter >= weeklyMaxAttestors) {
            return false;
        }
        uint256 perAttesterAmount = _TRNInflation.calculateWeeklyScheduledInflationForAttesters() / weeklyMaxAttestors;
        if (distribute(_attesterAddress, perAttesterAmount * multiplier)) {
            weeklyAttestersCounter++;
            return true;
        }
        return false;
    }

    function distribute(address to, uint256 amount) internal nonReentrant returns (bool) {
        if (to == address(0)) {
            emit DistributionAttempt(to, amount, false, "Invalid address: zero address");
            return false;
        }
        if (amount == 0) {
            emit DistributionAttempt(to, amount, false, "Invalid amount: must be greater than zero");
            return false;
        }
        if (address(this).balance < amount) {
            emit DistributionAttempt(to, amount, false, "Insufficient balance");
            return false;
        }
        (bool success, ) = to.call{value: amount}("");
        if (success) {
            emit DistributionAttempt(to, amount, true, "Success");
        } else {
            emit DistributionAttempt(to, amount, false, _getRevertMsg());
        }
        return success;
    }

    function _getRevertMsg() private pure returns (string memory) {
        return "Payment failed";
    }
}
