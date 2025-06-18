// SPDX-License-Identifier: Apache 2.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

contract BonusesL3 is AccessControlUpgradeable, ReentrancyGuardUpgradeable {
    mapping(uint32 => uint256) public assetAverageAmount;
    uint256 public txCount;
    uint256 public maxSingleReward;
    uint256 public weeklyTarget;
    uint256 public weeklySupply;
    uint256 public currentWeekStartDate;

    mapping(address => bool) public authorizedContracts; // Whitelist of contracts that can apply bonuses

    bool public isHalted;

    uint256 public leftThisWeek;

    event DistributionAttempt(address indexed to, uint256 amount, bool success, string reason);
    event BonusApplied(
        address indexed beneficiary,
        uint32 assetId,
        uint256 baseReward,
        uint256 bonus,
        uint256 finalReward
    );
    event AuthorizedContractAdded(address indexed contractAddress);
    event AuthorizedContractRemoved(address indexed contractAddress);

    modifier onlyOwner() {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "BNS#0: Unauthorized");
        _;
    }

    modifier onlyAuthorizedContract() {
        require(authorizedContracts[msg.sender], "BNS#1: Caller not authorized");
        _;
    }

    receive() external payable {}

    fallback() external payable {
        revert("BNS#99");
    }

    // For testing purposes
    function _setTxCount(uint256 _txCount) external onlyOwner {
        txCount = _txCount;
    }

    function _setLeftThisWeek(uint256 _leftThisWeek) external onlyOwner {
        leftThisWeek = _leftThisWeek;
    }

    function resetLeftThisWeek() external onlyOwner {
        leftThisWeek = address(this).balance;
    }

    function _setCurrentWeekStartDate(uint256 _currentWeekStartDate) external onlyOwner {
        currentWeekStartDate = _currentWeekStartDate;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function halt() external onlyOwner {
        isHalted = true;
    }

    function unhalt() external onlyOwner {
        isHalted = false;
    }

    function isOn() public view returns (bool) {
        return isHalted == false;
    }

    function setTargetRateAndSupply(
        uint256 _maxSingleReward,
        uint256 _weeklyTarget,
        uint256 _weeklySupply
    ) external onlyOwner {
        maxSingleReward = _maxSingleReward;
        weeklyTarget = _weeklyTarget;
        weeklySupply = _weeklySupply;
    }

    function checkResetCurrentPeriod() internal {
        if (currentWeekStartDate == 0 || currentWeekStartDate + 1 weeks < block.timestamp) {
            currentWeekStartDate = block.timestamp - 1;
            leftThisWeek = address(this).balance > readWeeklySupply() ? address(this).balance : readWeeklySupply();
            txCount = 0;
        }
    }

    function readCurrentBaseRewardWithBonus(uint32 assetId, uint256 amount) public view returns (uint256) {
        uint256 reward = readCurrentBaseReward();
        uint256 bonus = _applyBonus(assetId, reward, amount);
        return reward + bonus;
    }

    function readMaxSingleReward() public view returns (uint256) {
        return maxSingleReward == 0 ? 10 ** 18 : maxSingleReward;
    }

    function readWeeklyTarget() public view returns (uint256) {
        return weeklyTarget == 0 ? 700_000 : weeklyTarget;
    }

    function readWeeklySupply() public view returns (uint256) {
        return weeklySupply == 0 ? 50_000 * 10 ** 18 : weeklySupply;
    }

    /**
    - If transactions are low, rewards will be higher to encourage execution.
    - If transactions are close to the weekly target, rewards gradually lower rather than dropping instantly.
    - If the weekly supply is nearly used up, rewards will be adjusted down but never reach zero.
    **/
    function readCurrentBaseReward() public view returns (uint256) {
        if (leftThisWeek < readMaxSingleReward()) {
            return readMaxSingleReward() / 20; // Minimum threshold
        }

        uint256 currentWeeklyTarget = readWeeklyTarget();
        uint256 currentWeeklySupply = leftThisWeek;
        uint256 weekElapsed = (currentWeekStartDate + 1 weeks) - block.timestamp;

        // Ensure at least some time remains

        // Adjust reward scale based on how much time has passed
        uint256 timeFactor = (weekElapsed * 100) / 1 weeks; // Percentage of the week elapsed (0-100%)
        if (timeFactor == 0) {
            timeFactor = 1;
        }
        if (timeFactor > 100) {
            timeFactor = 100;
        }

        // Dynamic slowdown factor based on how close we are to reaching the weekly target
        uint256 slowdownFactor = (txCount * 100) / currentWeeklyTarget;

        // Ensure it never exceeds 100% scaling to prevent division issues
        if (slowdownFactor > 100) {
            slowdownFactor = 100;
        }

        // Adjust the base reward based on transaction count and supply remaining
        uint256 baseReward = ((currentWeeklySupply / readWeeklyTarget()) * (100 - slowdownFactor) * timeFactor) /
            (100 * 100);

        // Ensure we don't return a zero or excessively low reward
        uint256 minReward = readMaxSingleReward() / 20;
        if (baseReward < minReward) {
            return minReward;
        }

        // Ensure we don't exceed the max single reward
        if (baseReward > readMaxSingleReward()) {
            return readMaxSingleReward();
        }

        return baseReward;
    }

    function initialize(address _owner) public initializer {
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _owner);
        __ReentrancyGuard_init();
    }

    // Apply bonus AND distribute reward
    function applyBonusFromBid(
        uint32 assetId,
        uint256 amount,
        address beneficiary
    ) external onlyAuthorizedContract returns (bool) {
        checkResetCurrentPeriod();
        uint256 reward = readCurrentBaseReward();
        uint256 bonus = _applyBonus(assetId, reward, amount);
        uint256 finalReward = reward + bonus;
        if (finalReward < leftThisWeek) {
            leftThisWeek -= finalReward;
        } else {
            return false; // Not enough balance left for this reward
        }
        _updateAssetAverage(assetId, amount);

        // Distribute the reward
        bool distributed = distribute(beneficiary, finalReward);
        if (!distributed) {
            return false;
        }
        emit BonusApplied(beneficiary, assetId, reward, bonus, finalReward);

        return distributed;
    }

    function _applyBonus(uint32 assetId, uint256 reward, uint256 amount) internal view returns (uint256) {
        uint256 avgAmount = assetAverageAmount[assetId];
        if (avgAmount == 0 || amount <= avgAmount) {
            return 0;
        }

        uint256 excessPercentage = ((amount - avgAmount) * 100) / avgAmount;
        uint256 bonusPercentage = excessPercentage / 2;
        if (bonusPercentage > 50) {
            bonusPercentage = 50;
        }

        return (reward * (bonusPercentage)) / 100;
    }

    function _updateAssetAverage(uint32 assetId, uint256 amount) internal {
        uint256 currentAvg = assetAverageAmount[assetId];
        assetAverageAmount[assetId] = (currentAvg * txCount + amount) / (txCount + 1);
        txCount += 1;
    }

    function distribute(address to, uint256 amount) internal nonReentrant returns (bool) {
        if (to == address(0)) {
            emit DistributionAttempt(to, amount, false, "Invalid address");
            return false;
        }
        if (amount == 0) {
            emit DistributionAttempt(to, amount, false, "Invalid amount");
            return false;
        }
        if (address(this).balance < amount) {
            emit DistributionAttempt(to, amount, false, "Insufficient balance");
            return false;
        }
        (bool success, ) = to.call{value: amount}("");
        emit DistributionAttempt(to, amount, success, success ? "Success" : "Payment failed");
        return success;
    }

    // Manage authorized contracts that can apply bonuses
    function addAuthorizedContract(address contractAddress) external onlyOwner {
        require(contractAddress != address(0), "Invalid contract address");
        authorizedContracts[contractAddress] = true;
        emit AuthorizedContractAdded(contractAddress);
    }

    function removeAuthorizedContract(address contractAddress) external onlyOwner {
        require(authorizedContracts[contractAddress], "BNS#0");
        delete authorizedContracts[contractAddress];
        emit AuthorizedContractRemoved(contractAddress);
    }

    function emergencyWithdraw() external onlyOwner {
        payable(msg.sender).transfer(address(this).balance);
    }
}
