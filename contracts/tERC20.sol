// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

/// @dev The T3rn Token Precompile contract's address.
address constant T3RN_TOKEN_PRECOMPILE_ADDRESS = 0x0909090909090909090909090909090900000000;

/// @dev The T3rn Token Precompile contract's instance.
tERC20 constant T3RN_TOKEN_CONTRACT = tERC20(T3RN_TOKEN_PRECOMPILE_ADDRESS);

/// @title The T3rn Token Precompile Interface
/// @dev The interface through which solidity contracts will interact with pallet-assets & pallet_balances.
/// @custom:address 0x0909090909090909090909090909090900000000
interface tERC20 {
    /// @dev Gets the total supply of a currency.
    /// @return An uint256 representing the total supply of a currency.
    function totalSupply() external view returns (uint256);

    /// @dev Gets balance of an address.
    /// @custom:selector 70a08231
    /// @param owner address The address that owns a currency.
    /// @return An uint256 representing the balance of the owner.
    function balanceOf(address owner) external view returns (uint256);

    /// @dev Gets the currency  allowance of an address.
    /// @custom:selector dd62ed3e
    /// @param owner address The address that owns a currency
    /// @param spender address The address that will spend the  currency
    /// @return An uint256 representing of the allowed currency of the owner for the spender.
    function allowance(address owner, address spender) external view returns (uint256);

    /// @dev Gets the name of a currency.
    /// @custom:selector 06fdde03
    /// @return A bytes32 array representing the name of a currency.
    function name() external view returns (bytes32);

    /// @dev Gets the symbol of a currency.
    /// @custom:selector 95d89b41
    /// @return A bytes32 array representing the symbol of a currency.
    function symbol() external view returns (bytes32);

    /// @dev Gets the decimals of a currency.
    /// @custom:selector 313ce567
    /// @return An uint256 representing the decimals of a currency.
    function decimals() external view returns (uint256);

    /// @dev Transfer currency to a specified address
    /// @custom:selector a9059cbb
    /// @param receiver address The address that will receive the currency.
    /// @param value uint256 The value that will be transferred.
    function transfer(address receiver, uint256 value) external payable;

    /// @dev Approve currency for transfer.
    /// @custom:selector 095ea7b3
    /// @param spender The currency spender address.
    /// @param value uint256 The value that will be approved.
    function approve(address spender, uint256 value) external payable;

    /// @dev Transfer currency from a specified address to another one.
    /// @custom:selector 23b872dd
    /// @param sender The currency sender address.
    /// @param receiver The currency receiver address.
    /// @param value uint256 The value that will be transferred.
    function transferFrom(address sender, address receiver, uint256 value) external payable;

    /// @dev Event emitted when a currency is transferred.
    /// @custom:selector ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
    /// @param sender address The address that transferred the currency.
    /// @param receiver address The address that received the currency.
    /// @param value uint256 The value that was transferred.
    event Transfer(address sender, address receiver, uint256 value);

    /// @dev Event emitted when a currency is approved.
    /// @custom:selector 8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925
    /// @param spender The currency spender address.
    /// @param value uint256 The value that was approved.
    event Approval(address indexed owner, address indexed spender, uint256 value);
}
