// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts-upgradeable/finance/VestingWalletUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

contract CustomVestingWallet is Initializable, VestingWalletUpgradeable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address beneficiary, uint64 startTimestamp, uint64 durationSeconds) public initializer {
        VestingWalletUpgradeable.__VestingWallet_init(beneficiary, startTimestamp, durationSeconds);
    }

    function release(address _token) public override {
        VestingWalletUpgradeable.release(_token);
    }

    function releasable(address token) public view override returns (uint256) {
        return VestingWalletUpgradeable.releasable(token);
    }
}

contract VestingFactory is AccessControlUpgradeable {
    ERC20 private token;
    uint64 public startDate;
    mapping(address => address) public vestingWallets;

    uint64 public constant VESTING_DURATION_18_MONTHS = 18 * 30 days; // 18 months
    uint64 public constant VESTING_DURATION_24_MONTHS = 24 * 30 days; // 24 months

    bytes32 public version;

    modifier onlyOwner() {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "VestingFactory: Only owner can call this function");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(ERC20 _token, uint64 _startDate, address _owner) public initializer {
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _owner);
        startDate = _startDate;
        token = _token;
    }

    function setVersion(bytes32 _version) public onlyOwner {
        version = _version;
    }

    function createVestingWallet18Months(address beneficiary, uint256 amount) public onlyOwner {
        require(amount > 0, "Amount must be greater than 0");
        require(vestingWallets[beneficiary] == address(0), "Vesting wallet already exists for this beneficiary");

        address clone = Clones.clone(address(new CustomVestingWallet()));
        CustomVestingWallet(payable(clone)).initialize(beneficiary, startDate, VESTING_DURATION_18_MONTHS);
        vestingWallets[beneficiary] = clone;
        require(token.transfer(clone, amount), "Token transfer failed");
    }

    function createVestingWallet24Months(address beneficiary, uint256 amount) public onlyOwner {
        require(amount > 0, "Amount must be greater than 0");
        require(vestingWallets[beneficiary] == address(0), "Vesting wallet already exists for this beneficiary");

        address clone = Clones.clone(address(new CustomVestingWallet()));
        CustomVestingWallet(payable(clone)).initialize(beneficiary, startDate, VESTING_DURATION_24_MONTHS);
        vestingWallets[beneficiary] = clone;
        require(token.transfer(clone, amount), "Token transfer failed");
    }

    function releasable(address beneficiary, address _token) public view returns (uint256) {
        return CustomVestingWallet(payable(vestingWallets[beneficiary])).releasable(_token);
    }

    function release(address _token) public {
        CustomVestingWallet(payable(vestingWallets[msg.sender])).release(_token);
    }
}
