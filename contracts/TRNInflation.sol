// contracts/ERC20Mock.sol
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "./TRNInflationRewards.sol";

contract TRNInflation is AccessControlUpgradeable {
    TRNInflationRewards public TRNInflationRewardsAddress;
    uint256 public constant WEEKLY_INFLATION_INTERVAL = 1 weeks;
    uint256 public lastInflationTime;

    // Set total supply as constant on 100MLN
    uint256 public constant TOTAL_SUPPLY = 100000000 * 10 ** 18;
    uint256 public constant MICRO_WEEKS_IN_YEAR = 52177500; // 52.1775 micro ( 10 ** -6 ) weeks in a year

    // Inflation rates in micro years
    uint256 public constant EXECUTOR_INFLATION = 12000; // 1.2% per micro year (10 ** -6)
    uint256 public constant USER_INFLATION = 12000; // 1.2% per micro year (10 ** -6)
    uint256 public constant ATTESTER_INFLATION = 8000; // 0.8% per micro year (10 ** -6)

    bool public isInflationOn;

    bytes32 public version;

    function initialize(address _owner, address payable _TRNInflationRewardsAddress) public initializer {
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _owner);
        lastInflationTime = 0;
        isInflationOn = true;
        lastInflationTime = block.timestamp;
        TRNInflationRewardsAddress = TRNInflationRewards(_TRNInflationRewardsAddress);
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function setVersion(bytes32 _version) public onlyOwner {
        version = _version;
    }

    modifier onlyOwner() {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "Only owner can call this function");
        _;
    }

    receive() external payable {}

    fallback() external payable {}

    function setInflationOn() public onlyOwner {
        isInflationOn = true;
        lastInflationTime = block.timestamp;
    }

    function setInflationOff() public onlyOwner {
        isInflationOn = false;
    }

    function checkIsInflationOn() public view returns (bool) {
        return isInflationOn;
    }

    function setTRNInflationRewardsAddress(address payable _TRNInflationRewardsAddress) public onlyOwner {
        TRNInflationRewardsAddress = TRNInflationRewards(_TRNInflationRewardsAddress);
    }

    function calculateWeeklyScheduledInflation() public pure returns (uint256 weeklyInflationTotal) {
        uint256 executorInflation = (TOTAL_SUPPLY * EXECUTOR_INFLATION) / MICRO_WEEKS_IN_YEAR;
        uint256 userInflation = (TOTAL_SUPPLY * USER_INFLATION) / MICRO_WEEKS_IN_YEAR;
        uint256 attesterInflation = (TOTAL_SUPPLY * ATTESTER_INFLATION) / MICRO_WEEKS_IN_YEAR;

        return executorInflation + userInflation + attesterInflation;
    }

    function calculateWeeklyScheduledInflationForExecutors() public pure returns (uint256) {
        return (TOTAL_SUPPLY * EXECUTOR_INFLATION) / MICRO_WEEKS_IN_YEAR;
    }

    function calculateWeeklyScheduledInflationForUsers() public pure returns (uint256) {
        return (TOTAL_SUPPLY * USER_INFLATION) / MICRO_WEEKS_IN_YEAR;
    }

    function calculateWeeklyScheduledInflationForAttesters() public pure returns (uint256) {
        return (TOTAL_SUPPLY * ATTESTER_INFLATION) / MICRO_WEEKS_IN_YEAR;
    }

    function distributeInflation() public {
        require(isInflationOn, "Inflation is off");

        // Calculate weekly inflation accumulated for each recipient
        uint256 totalInflationThisWeek = calculateWeeklyScheduledInflation();

        // Duration passed since the last update in weeks
        uint256 weeksPassed = (block.timestamp - lastInflationTime) / WEEKLY_INFLATION_INTERVAL;

        require(weeksPassed > 1, "Disallow repeated distributions");

        // Calculate inflation for each recipient
        uint256 inflationToDistribute = totalInflationThisWeek * weeksPassed;

        lastInflationTime = block.timestamp;

        // Withdraw native currency (TRN Tokens) of TRNGenesisInflationRewardsHolder to TRNInflationRewardsAddress
        // Check balance of TRNGenesisInflationRewardsHolder in native currency (TRN Tokens)
        uint256 balance = address(this).balance;

        // Verify balance is greater than totalInflationThisWeek
        require(balance >= inflationToDistribute, "Insufficient balance in TRNGenesisInflationRewardsHolder");
        payable(TRNInflationRewardsAddress).transfer(inflationToDistribute);

        TRNInflationRewardsAddress.resetWeeklyCounters();
    }
}
