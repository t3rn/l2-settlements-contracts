// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "./remoteOrder.sol";

contract OpenMarketPricer is AccessControlUpgradeable {
    RemoteOrder public remoteOrder;

    struct PriceData {
        uint256 price; // stored as a fixed point number with a certain number of decimals
        uint256 volume;
        uint256 lastUpdateTime;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    mapping(bytes32 => PriceData) public perPairPrices;
    mapping(uint32 => uint256) public pointsPerAssetUnit;

    uint32[] public supportedAssets;

    bytes32 public version;

    uint256 public tickInterval; // in seconds
    uint256 public alpha; // weighting factor for EWMA
    uint256 public volumeConfidenceThreshold;

    bool public isOnFlag;
    bool public usePointsFallback;

    event QuoteStored(uint32 indexed assetA, uint256 indexed amountA, uint32 assetB, uint256 amountB);

    modifier isOn() {
        require(isOnFlag, "Contract is turned off");
        _;
    }

    /// *** Modifiers ***

    modifier onlyOwner() {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "Only owner can call this function");
        _;
    }

    modifier onlyRemoteOrder() {
        require(msg.sender == address(remoteOrder), "Only remote order contract can call this function");
        _;
    }

    /// *** Contract logic ***

    /// @dev Constructor function for this upgradeable contract
    /// @param  _owner  The owner of the contract, as well as the proxy
    function initialize(address _owner) public initializer {
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _owner);
        tickInterval = 60; // 1 minute
        alpha = 1;
        isOnFlag = true;
    }

    function turnOff() public onlyOwner {
        isOnFlag = false;
    }

    function turnOn() public onlyOwner {
        isOnFlag = true;
    }

    function setUsePointsFallback(bool _usePointsFallback) public onlyOwner {
        usePointsFallback = _usePointsFallback;
    }

    function setVolumeConfidenceThreshold(uint256 _volumeConfidenceThreshold) public onlyOwner {
        volumeConfidenceThreshold = _volumeConfidenceThreshold;
    }

    function setVersion(bytes32 _version) public onlyOwner {
        version = _version;
    }

    function setRemoteOrder(address payable _remoteOrder) public onlyOwner {
        remoteOrder = RemoteOrder(_remoteOrder);
    }

    function setTickInterval(uint256 _tickInterval) public onlyOwner {
        tickInterval = _tickInterval;
    }

    function setAlpha(uint256 _alpha) public onlyOwner {
        alpha = _alpha;
    }

    function addSupportedAsset(uint32 assetId) public onlyOwner {
        if (!isSupportedAsset(assetId)) {
            supportedAssets.push(assetId);
        }
    }

    function removeSupportedAsset(uint32 assetId) public onlyOwner {
        for (uint i = 0; i < supportedAssets.length; ++i) {
            if (supportedAssets[i] == assetId) {
                supportedAssets[i] = supportedAssets[supportedAssets.length - 1];
                supportedAssets.pop();
                break;
            }
        }
    }

    function getSupportedAssets() public view returns (uint32[] memory) {
        return supportedAssets;
    }

    function isSupportedAsset(uint32 assetId) public view returns (bool) {
        for (uint i = 0; i < supportedAssets.length; ++i) {
            if (supportedAssets[i] == assetId) {
                return true;
            }
        }
        return false;
    }

    function calcPriceId(uint32 assetIdA, uint32 assetIdB) public pure returns (bytes32) {
        return keccak256(abi.encode(assetIdA, assetIdB));
    }

    function storeQuote(uint32 assetA, uint256 amountA, uint32 assetB, uint256 amountB) public onlyRemoteOrder {
        if (!isSupportedAsset(assetA) || !isSupportedAsset(assetB)) {
            return;
        }
        bytes32 priceAinBId = calcPriceId(assetA, assetB);
        bytes32 priceBinAId = calcPriceId(assetB, assetA);

        uint256 currentTime = block.timestamp;

        updatePrice(priceAinBId, amountA, amountB, currentTime);
        updatePrice(priceBinAId, amountB, amountA, currentTime);

        emit QuoteStored(assetA, amountA, assetB, amountB);
    }

    function updatePrice(bytes32 priceId, uint256 amountA, uint256 amountB, uint256 currentTime) internal {
        PriceData storage priceData = perPairPrices[priceId];

        if (priceData.lastUpdateTime == 0) {
            // Initial price
            priceData.price = (amountA * 1e18) / amountB; // store price with 18 decimals
            priceData.volume = amountA;
        } else {
            uint256 timeDelta = currentTime - priceData.lastUpdateTime;

            if (timeDelta >= tickInterval) {
                // Calculate EWMA
                uint256 newPrice = (amountA * 1e18) / amountB;
                priceData.price = ((priceData.price * (1e18 - alpha)) + (newPrice * alpha)) / 1e18;
                priceData.volume = ((priceData.volume * (1e18 - alpha)) + (amountA * alpha)) / 1e18;
            } else {
                // Simply update the volume within the same tick interval
                priceData.volume += amountA;
            }
        }

        priceData.lastUpdateTime = currentTime;
    }

    function getVolume(uint32 assetA, uint32 assetB) public view isOn returns (uint256) {
        bytes32 priceId = calcPriceId(assetA, assetB);
        return perPairPrices[priceId].volume;
    }

    function getPrice(uint32 assetA, uint32 assetB) public view isOn returns (uint256) {
        // For same-same assets return 1
        if (assetA == assetB) {
            return 1e18;
        }
        bytes32 priceId = calcPriceId(assetA, assetB);
        uint256 price = perPairPrices[priceId].price;
        uint volume = perPairPrices[priceId].volume;
        if (volume < volumeConfidenceThreshold) {
            if (usePointsFallback) {
                return getPointsPrice(assetA, assetB);
            } else {
                return 0;
            }
        }
        return perPairPrices[priceId].price;
    }

    function getOpenMarketPrice(uint32 assetA, uint32 assetB) public view isOn returns (uint256) {
        // For same-same assets return 1
        if (assetA == assetB) {
            return 1e18;
        }
        bytes32 priceId = calcPriceId(assetA, assetB);
        uint256 price = perPairPrices[priceId].price;
        uint volume = perPairPrices[priceId].volume;
        return perPairPrices[priceId].price;
    }

    function getPointsPrice(uint32 assetA, uint32 assetB) public view returns (uint256) {
        uint256 priceA = pointsPerAssetUnit[assetA];
        uint256 priceB = pointsPerAssetUnit[assetB];
        return (priceA * 1e18) / priceB;
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
}
