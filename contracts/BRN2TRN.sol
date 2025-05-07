// contracts/ERC20Mock.sol
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

import "./BRN.sol";

contract BRN2TRN is AccessControlUpgradeable, ReentrancyGuardUpgradeable {
    BRN private BRNToken;

    uint256 public lastInflationTime;
    uint256 public BRN2TRNRatio;
    uint256 public BRN2TRNWhitelistedRatio;

    mapping(address => bool) public whitelistedAddresses;

    address public burntAddress;

    bool public isOn;

    bytes32 public version;

    event DistributionAttempt(address indexed to, uint256 amount, bool success, string reason);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _owner, BRN _BRNToken) public initializer {
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _owner);
        isOn = false;
        BRNToken = _BRNToken;
        BRN2TRNRatio = 10;

        __ReentrancyGuard_init();
    }

    receive() external payable {}

    fallback() external payable {}

    modifier onlyOwner() {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "Only owner can call this function");
        _;
    }

    function setVersion(bytes32 _version) public onlyOwner {
        version = _version;
    }

    function setBRNTokenAddress(address _BRNTokenAddress) public onlyOwner {
        BRNToken = BRN(_BRNTokenAddress);
    }

    function setOn() public onlyOwner {
        isOn = true;
    }

    function setRatio(uint256 _ratio) public onlyOwner {
        BRN2TRNRatio = _ratio;
    }

    function setOff() public onlyOwner {
        isOn = false;
    }

    function setBurntAddress(address _burntAddress) public onlyOwner {
        burntAddress = _burntAddress;
    }

    function checkIsOn() public view returns (bool) {
        return isOn;
    }

    function brn2trn() public {
        // Check if inflation is on
        require(isOn, "Inflation is off");
        uint256 balance = BRNToken.balanceOf(msg.sender);
        uint256 ratio = BRN2TRNRatio;
        if (whitelistedAddresses[msg.sender]) {
            ratio = BRN2TRNWhitelistedRatio;
        }
        uint256 trnAmount = balance / ratio;
        // Burn BRN
        BRNToken.transferFrom(msg.sender, burntAddress, balance);
        // Distribute TRN via
        distribute(msg.sender, trnAmount);
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
