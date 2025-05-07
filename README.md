

# Contracts Overview

| Name                       | Environment | Feature                 | Description                                                                                                              |
|----------------------------|----|-------------------------|--------------------------------------------------------------------------------------------------------------------------|
| attestationsVerifierProofs.sol | L2 | Settlement              | Verifies proofs of attestations and commits the cross-chain traffic back to source networks.                             |
| BRN.sol                    | L2 | Settlement              | Represents the BRN token.                                                                                                |
| BRN2TRN.sol                | L3 | Settlement              | Facilitates conversion between BRN and TRN tokens.                                                                       |
| BRNRewards.sol             | L3 | Settlement              | Manages BRN token rewards.                                                                                               |
| ERC20Mock.sol              | L2/L3 | Test                    | A mock implementation of the ERC20 token standard.                                                                       |
| escrowGMP.sol              | L2 | Settlement              | Manages escrow for GMP (Generic Message Passing).                                                                        |
| openMarketPricer.sol       | L2/L3 | Settlement              | Determines open market prices for assets.                                                                                |
| remoteOrder.sol            | L2 | Settlement              | Handles remote orders for assets.                                                                                        |
| t3BTC.sol                  | L2/L3 | Token                   | Represents the t3BTC token.                                                                                              |
| t3DOT.sol                  | L2/L3 | Token                   | Represents the t3DOT token.                                                                                              |
| t3SOL.sol                  | L2/L3 | Token                   | Represents the t3SOL token.                                                                                              |
| t3USD.sol                  | L2/L3 | Token                   | Represents the t3USD token.                                                                                              |
| tERC20.sol                 | L2/L3 | Token                   | Represents a general tERC20 token.                                                                                       |
| TRN.sol                    | L2/L3 | Token                   | Represents the TRN token.                                                                                                |
| TRNInflation.sol           | L2/L3 | Settlement               | Manages TRN token inflation.                                                                                             |
| TRNInflationRewards.sol    | L2/L3 | Settlement                 | Manages TRN token inflation rewards.                                                                                     |
| vestingFactory.sol         | L2/L3 | Settlement                 | Manages vesting schedules and factories.                                                                                 |
| bonusesL3.sol              | L3 | Settlement                 | Applies [TRN bonuses distribution V2](https://docs.google.com/document/d/1g2zfb5IvO1gUoqxpXW6twGps8ffMLhn-c9ZxDVAOjVo/edit?usp=sharing)  |


# GMP
The General Message Passing (GMP) system in t3rn is a robust mechanism that enables cross-chain communication through attested messages. By leveraging committees, quorum, and Merkle proofs, it ensures secure and reliable message processing. The outlined operations provide a comprehensive framework for various cross-chain interactions.    


Operations

Transfer Commit
Handles the transfer of assets to a specified destination.

Payload Structure:

```solidity
struct TransferCommit {
    bytes32 orderId;
    address executor;
}
```

Transfer Commit Open Market
Manages open market asset transfers with additional reward settlement.

Payload Structure:

```solidity
struct TransferCommitOpenMarket {
    bytes32 orderId;
    address destination;
    uint256 rewardSettled;
    address sender;
    address rewardAsset;
    uint256 maxReward;
    uint256 amount;
    uint32 assetId;
    uint32 rewardAssetId;
    uint32 nonce;
}
```

Escrow Commit
Commits escrow-related calls with specified order ID and destination.

Payload Structure:

```solidity
struct EscrowCommit {
    bytes32 orderId;
    address destination;
}
```
Call Commit
Executes a committed call if call commitments are enabled.

Payload Structure:

```solidity
struct CallCommit {
    bytes32 orderId;
    uint256 reward;
    address rewardAsset;
    address beneficiary;
}
```

Circuit Header Encoded
Processes encoded circuit headers for light client integration.

Payload Structure:
```solidity
struct CircuitHeaderEncoded {
    bytes32 headerHash;
    bytes32 prevHeaderHash;
    bytes32 stateRoot;
    bytes32 txRoot;
    bytes32 receiptsRoot;
    bytes32 epochAppRoot;
    bytes32 appRoot;
}
```

### Events

- BatchApplied: Emitted when a batch of attested messages is successfully applied.
- CommitmentApplied: Emitted when a specific commitment is successfully processed.
- TransferCommitApplied: Emitted when a transfer commit operation is executed.
- EscrowCommitApplied: Emitted when an escrow commit operation is executed.
- CallCommitApplied: Emitted when a call commit operation is executed.


# Escrow Orders: Lifecycle and Mechanics

The `EscrowOrder` contract is designed to manage escrow-based transactions, ensuring that funds are securely held until specific conditions are met, facilitating decentralized order creation, fund locking, and eventual settlement or refund.

## Key Components

- **EscrowGMP**: A separate contract that handles the storage and state management of escrow orders.
- **Supported Assets**: A mapping to track and validate supported assets and their constraints.
- **Order Parameters**: Various parameters and mappings to manage order-specific details such as timeouts, fees, and allowed amounts.

## Key Events

- **Claimed**: Emitted when an order is successfully claimed or refunded.
- **EscrowOrderCreated**: Emitted when a new escrow order is created.
- **OrderCreated**: Emitted when a new order is created.
- **Confirmation**: Emitted upon successful order confirmation.
- **ConfirmedBatch**: Emitted when a batch of orders is confirmed.
- **EscrowFundsLocked**: Emitted when funds are locked into an escrow.

## Lifecycle of an Escrow Order

### 1. Initialization

- **Contract Deployment**: The `EscrowOrder` contract is deployed, and the `initialize` function sets up the contract owner and default parameters, such as order timeouts.

### 2. Creating an Escrow Order

- **Order Creation**: Users can create escrow orders by providing order details, such as the target account, asset type, amount, and desired timeout duration. The contract ensures the provided details are valid, calculates any necessary fees, and emits an `EscrowOrderCreated` event.

### 3. Locking Funds

- **Locking Funds**: After creating an order, users must lock the specified funds into escrow. The contract verifies the asset's validity and ensures the required protocol fees are paid before locking the funds. An `EscrowFundsLocked` event is emitted to confirm the action.

### 4. Claiming and Refunding Orders

- **Claiming an Order**: When the conditions for all atomic orders in a multi-order are met (e.g., the target account confirms receipt), the executors can claim the rewards for their contributions. The contract checks the validity of the claim for all atomic orders, transfers the rewards to the executors, and emits a `Claimed` event.

- **Refunding an Order**: If the conditions for any atomic order in a multi-order are unmet within the specified timeout, users can request a refund. The contract verifies the refund eligibility, reverts the funds and side effects committed to the escrows, and returns the funds to the sender. A `Claimed` event is emitted to indicate the refund, ensuring both the user can reclaim the totality of the funds and each executor can reclaim their respective atomic order executions.

### 5. Managing Orders

- **Multi Escrow Orders**: The contract supports the creation of multiple orders in a single transaction, optimizing for batch processing and reducing gas costs. This feature ensures efficient handling of large numbers of orders.

## Summary

The `EscrowOrder` contract provides a robust and secure mechanism for managing escrow-based transactions in a decentralized environment. By supporting order creation, fund locking, claim processing, and refunds, it ensures that funds are securely held and transferred only when specific conditions are met, fostering trust and reliability in decentralized finance applications.

