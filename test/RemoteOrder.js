// Include the helper libraries
const { ethers, upgrades } = require('hardhat')
const {
  newEmptyBatch,
  constructMultiMerkleProof,
  batchEncodePacked,
  batchEncodePackedGMP,
} = require('./AttestationsVerifierProof')

const { expect } = require('chai')
const { BigNumber } = require('ethers')
const exp = require('constants')
const ethUtil = require('ethereumjs-util')

function generateId(addr, nonce) {
  const encodedEncodedNetworkId = encodeNetworkId('sept')
  let xtx_id = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(['address', 'uint32', 'bytes4'], [addr, nonce, encodedEncodedNetworkId]),
  )

  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32', 'bytes32'],
      [xtx_id, '0x0000000000000000000000000000000000000000000000000000000000000000'],
    ),
  )
}

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000'

async function generateRemotePaymentPayload(rewardAsset, rewardAmount) {
  // keccak256(abi.encode(rewardAsset, maxReward))
  const currentBlock = await ethers.provider.getBlock('latest')
  const currentTimestamp = currentBlock.timestamp
  const encodedPayload = ethers.utils.defaultAbiCoder.encode(
    ['uint256', 'uint256', 'uint256'],
    [rewardAsset, rewardAmount, currentTimestamp],
  )
  return ethers.utils.keccak256(encodedPayload)
}

function encodeNetworkId(decodedNetworkId) {
  return `0x${Buffer.from(decodedNetworkId, 'utf-8').toString('hex')}`
}
require('chai').use(require('chai-almost')(100))

describe('RemoteOrder', function () {
  let contract, USDCContract, owner, addr1, initialAddr1Balance, initialAddr1USDCBalance

  let RemoteOrder
  let escrowGMPContract
  let avpBatchSubmitterContract
  let attestersContract
  let claimerGMPContract
  let addr2

  beforeEach(async function () {
    ;[owner, addr1, addr2] = await ethers.getSigners()
    await require('hardhat').network.provider.request({
      method: 'hardhat_reset',
      params: [],
    })
    const ClaimerGMP = await ethers.getContractFactory('ClaimerGMPV2')
    claimerGMPContract = await upgrades.deployProxy(ClaimerGMP, [owner.address], {
      initializer: 'initialize',
    })
    await claimerGMPContract.deployed()

    const AvpBatchSubmitter = await ethers.getContractFactory('avpBatchSubmitter')
    avpBatchSubmitterContract = await upgrades.deployProxy(AvpBatchSubmitter, [owner.address], {
      initializer: 'initialize',
    })
    await avpBatchSubmitterContract.deployed()

    const Attesters = await ethers.getContractFactory('AttestationsVerifierProofs')
    attestersContract = await upgrades.deployProxy(Attesters, [owner.address, [owner.address], [owner.address], 0], {
      initializer: 'initialize',
    })
    await attestersContract.deployed()
    await attestersContract.setSkipEscrowWrites(true)
    await avpBatchSubmitterContract.setAVP(attestersContract.address)

    const EscrowGMP = await ethers.getContractFactory('EscrowGMP')
    escrowGMPContract = await upgrades.deployProxy(EscrowGMP, [owner.address], {
      initializer: 'initialize',
    })
    await escrowGMPContract.deployed()

    await avpBatchSubmitterContract.setEscrowGMP(escrowGMPContract.address)
    await attestersContract.assignEscrowGMP(escrowGMPContract.address)

    RemoteOrder = await ethers.getContractFactory('RemoteOrder')
    contract = await upgrades.deployProxy(RemoteOrder, [owner.address], {
      initializer: 'initialize',
    })
    await contract.deployed()

    // Assign orderer contract to remote order caller
    await escrowGMPContract.assignOrderer(contract.address)
    await attestersContract.assignOrderer(contract.address)
    await avpBatchSubmitterContract.setRO(contract.address)

    await contract.setExecutionCutOff(30 * 60)
    await contract.setEscrowGMP(escrowGMPContract.address)
    await contract.setOperator(avpBatchSubmitterContract.address)
    // await contract.assignAttesters(attestersContract.address)
    const encodedEncodedNetworkId = encodeNetworkId('sept')
    await contract.setSourceId(encodedEncodedNetworkId)

    await contract.assignClaimerGMP(claimerGMPContract.address)

    await claimerGMPContract.setAttester(attestersContract.address)
    await claimerGMPContract.setEscrowGMP(escrowGMPContract.address)
    //
    // // Set attesters as RemoteOrder contract address
    // await escrowGMPContract.assignAttesters(addr1.address)

    // deploy USDC mock contract
    const ERC20Mock = await ethers.getContractFactory('ERC20Mock')
    USDCContract = await ERC20Mock.deploy('USD Coin', 'USDC')
    await USDCContract.deployed()

    // mint some USDC for addr1
    initialAddr1USDCBalance = ethers.utils.parseEther('1000') // 1000 USDC
    await USDCContract.mint(addr1.address, initialAddr1USDCBalance)
    await USDCContract.mint(addr2.address, initialAddr1USDCBalance)

    // save initial balance of addr1
    initialAddr1Balance = await ethers.provider.getBalance(addr1.address)
  })

  it('Should generate ID correctly from nonce 0', async function () {
    const id = await contract.generateId(owner.address, 0)
    let expected_id_0 = generateId(owner.address, 0)
    expect(id).to.equal(expected_id_0)
  })

  it('Should generate ID correctly from nonce 0, 1 and 2', async function () {
    for (let i = 0; i < 3; i++) {
      const id = await contract.generateId(owner.address, i)
      let expected_id_i = generateId(owner.address, i)
      expect(id).to.equal(expected_id_i)
    }
  })

  describe('RemoteOrder::Rewards', function () {
    // Parameters for the order function
    const destination = '0x03030303' // arbitrary destination string
    const asset = 5555 // arbitrary asset string
    const amount = ethers.utils.parseEther('1') // arbitrary amount of 10 ETH
    const insurance = ethers.utils.parseEther('2') // arbitrary insurance of 2 ETH
    const maxRewardETH = ethers.utils.parseEther('10') // 1 ETH
    const settledAmountETH = ethers.utils.parseEther('0.5') // 0.5 ETH
    const maxRewardUSDC = ethers.utils.parseUnits('100', 6) // 100 USDC
    const rewardAssetETH = ethers.constants.AddressZero // For ETH

    async function getParams() {
      const [owner, addr1] = await ethers.getSigners()

      // Parameters for the order function
      return {
        destination, // arbitrary destination string
        asset, // arbitrary asset string
        targetAccount: '0x000000000000000000000000' + addr1.address.slice(2).toLocaleLowerCase(), // user's address
        amount, // arbitrary amount of 10 ETH
        insurance, // arbitrary insurance of 2 ETH
        maxRewardETH, // 1 ETH
        settledAmountETH, // 0.5 ETH
        maxRewardUSDC, // 100 USDC
        rewardAssetETH, // For ETH
        rewardAssetUSDC: USDCContract.address, // For USDC
      }
    }

    it('Should subtract maxReward correctly in ETH', async function () {
      // send order with ETH as rewardAsset
      let params = await getParams()
      const tx = await contract
        .connect(addr1)
        .order(
          params.destination,
          params.asset,
          params.targetAccount,
          params.amount,
          params.rewardAssetETH,
          params.insurance,
          params.maxRewardETH,
          { value: params.maxRewardETH },
        )

      const receipt = await tx.wait()

      // Log events
      const gasConsumedEvent = receipt.events.find((event) => event.event === 'OrderGasConsumed')
      const gasConsumedEmitted = gasConsumedEvent.args.gasConsumed

      expect(gasConsumedEmitted.toNumber()).to.be.almost(receipt.gasUsed.toNumber(), 2000)

      const submissionBlockTimestamp = (await hre.ethers.provider.getBlock('latest')).timestamp

      const payloadFinalKey = await escrowGMPContract.remotePaymentsPayloadHash(
        generateId(addr1.address, submissionBlockTimestamp),
      )
      // expect the payload to be stored in the escrow contract
      expect(payloadFinalKey).to.equal(await generateRemotePaymentPayload(params.rewardAssetETH, params.maxRewardETH))

      // check contract balance
      const vaultsBalance = await ethers.provider.getBalance(contract.address)
      expect(vaultsBalance).to.equal(maxRewardETH)
    })

    it('Should subtract maxReward correctly in USDC', async function () {
      // approve the contract to spend addr1's USDC
      await USDCContract.connect(addr1).approve(contract.address, maxRewardUSDC)
      // send order with ETH as rewardAsset
      let params = await getParams()

      // add to asset balance
      expect(await contract.addSupportedBridgeAsset(params.rewardAssetUSDC, 5555)).to.be.ok

      // send order with USDC as rewardAsset
      await contract
        .connect(addr1)
        .order(
          params.destination,
          params.asset,
          params.targetAccount,
          params.amount,
          params.rewardAssetUSDC,
          params.insurance,
          params.maxRewardUSDC,
        )

      // check USDC balance of contract
      const vaultsUSDCBalance = await USDCContract.balanceOf(contract.address)
      expect(vaultsUSDCBalance).to.equal(maxRewardUSDC)
    })

    const getNextBlockNumber = async () => {
      const latestBlock = await hre.ethers.provider.getBlock('latest')
      return latestBlock.number + 1
    }

    const getLatestBlockTimestamp = async () => {
      return (await hre.ethers.provider.getBlock('latest')).timestamp
    }

    it('Should emit event with correct arguments', async function () {
      // send order with ETH as rewardAsset
      let params = await getParams()
      let sender = await ethers.provider.getSigner(addr1.address)._address
      const submissionBlockNumber = (await hre.ethers.provider.getBlock('latest')).number + 1
      const submissionBlockTimestamp = (await hre.ethers.provider.getBlock('latest')).timestamp + 1
      const nextBlockNumber = await getNextBlockNumber()

      await expect(
        contract
          .connect(addr1)
          .order(
            params.destination,
            params.asset,
            params.targetAccount,
            params.amount,
            params.rewardAssetETH,
            params.insurance,
            params.maxRewardETH,
            {
              value: params.maxRewardETH,
            },
          ),
      )
        .to.emit(contract, 'OrderCreated')
        // event OrderCreated(bytes32 indexed id, bytes4 indexed destination, bytes4 asset, address targetAccount, uint256 amount, address rewardAsset, uint256 insurance, uint256 maxReward);
        .withArgs(
          generateId(sender, submissionBlockTimestamp),
          params.destination,
          params.asset,
          params.targetAccount,
          params.amount,
          params.rewardAssetETH,
          params.insurance,
          params.maxRewardETH,
          submissionBlockTimestamp,
          addr1.address,
          submissionBlockTimestamp,
        )

      // check against escrowGMP payload
      const payloadKey = await escrowGMPContract.remotePaymentsPayloadHash(generateId(sender, submissionBlockTimestamp))
      expect(payloadKey).to.equal(await generateRemotePaymentPayload(params.rewardAssetETH, params.maxRewardETH))
    })

    it('Should set order status to Committed after commit', async function () {
      // send order with ETH as rewardAsset
      let params = await getParams()

      const orderTimestamp = await getLatestBlockTimestamp()
      const id = generateId(addr1.address, orderTimestamp + 1)
      const executorsAddress = addr2.address

      await contract
        .connect(addr1)
        .order(
          params.destination,
          params.asset,
          params.targetAccount,
          params.amount,
          params.rewardAssetETH,
          params.insurance,
          params.maxRewardETH,
          { value: params.maxRewardETH },
        )

      // check gmp payload is set
      const payloadKey = await escrowGMPContract.remotePaymentsPayloadHash(id)
      const intermediatePayloadKey = await generateRemotePaymentPayload(params.rewardAssetETH, params.maxRewardETH)
      expect(payloadKey).to.equal(intermediatePayloadKey)

      // Generate ECDSA signature of Order ID
      const signatureOfOrderId = await addr1.signMessage(ethers.utils.arrayify(id))

      // Addr1 faking the attesters smart contract's authorization
      await escrowGMPContract.connect(owner).assignAttesters(addr1.address)
      await escrowGMPContract.connect(addr1).commitRemoteBeneficiaryPayload(id, executorsAddress)
      await escrowGMPContract.connect(owner).assignAttesters(attestersContract.address)

      // Check GMP Payload key is not set to executor's address
      const payloadKeyAfterCommit = await escrowGMPContract.remotePaymentsPayloadHash(id)
      // Should equal to keccak256(abi.encode(currentHash, beneficiary))
      const finalExpectedPayloadKey = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(['bytes32', 'address'], [intermediatePayloadKey, executorsAddress]),
      )

      expect(payloadKeyAfterCommit).to.equal(finalExpectedPayloadKey)
    })

    it.skip('Should reward order of executor in ETH', async function () {
      // send order with ETH as rewardAsset
      let params = await getParams()

      const submissionBlockNumber = (await hre.ethers.provider.getBlock('latest')).number + 1
      const id = generateId(addr1.address, submissionBlockNumber)

      await contract
        .connect(addr1)
        .order(
          params.destination,
          params.asset,
          params.targetAccount,
          params.amount,
          params.rewardAssetETH,
          params.insurance,
          params.maxRewardETH,
          { value: params.maxRewardETH },
        )

      // check gmp payload is set
      const payloadKey = await escrowGMPContract.remotePaymentsPayloadHash(id)
      const intermediatePayloadKey = await generateRemotePaymentPayload(params.rewardAssetETH, params.maxRewardETH)
      expect(payloadKey).to.equal(intermediatePayloadKey)
      // Check should not be possible to claim reward just yet - no attestation
      const isClaimableExpectFalseBeforeAttestation = await contract
        .connect(addr1)
        .checkIsClaimable(id, params.rewardAssetETH, params.maxRewardETH, params.settledAmountETH)
      expect(isClaimableExpectFalseBeforeAttestation).to.equal(false)

      await expect(
        contract.connect(addr1).claimPayout(id, params.rewardAssetETH, params.maxRewardETH, params.settledAmountETH),
      ).to.be.revertedWith('Payload for withdrawal not matching')
      // Check cannot withdraw random amount
      await expect(
        contract.connect(addr1).claimPayout(id, params.rewardAssetETH, params.maxRewardETH, params.settledAmountETH),
      ).to.be.revertedWith('Payload for withdrawal not matching')

      const isClaimableExpectFalse = await contract
        .connect(addr1)
        .checkIsClaimable(id, params.rewardAssetETH, params.maxRewardETH, params.settledAmountETH)
      expect(isClaimableExpectFalse).to.equal(false)

      // Addr1 faking the attesters smart contract's authorization
      await escrowGMPContract.connect(addr1).commitRemoteBeneficiaryPayload(id, addr2.address)
      // Check GMP Payload key is not set to executor's address but null address
      const payloadKeyAfterCommit = await escrowGMPContract.remotePaymentsPayloadHash(id)
      // Should equal to keccak256(abi.encode(currentHash, address(0)))
      const finalExpectedPayloadKey = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(['bytes32', 'address'], [intermediatePayloadKey, addr2.address]),
      )

      expect(payloadKeyAfterCommit).to.equal(finalExpectedPayloadKey)

      const balancePriorOrder = await ethers.provider.getBalance(addr2.address)

      // Mine 256 blocks
      await hre.network.provider.send('hardhat_mine', ['0x100'])
      // Check other address cannot claim reward
      const isClaimableByOthers = await contract
        .connect(addr1)
        .checkIsClaimable(id, params.rewardAssetETH, params.maxRewardETH, params.settledAmountETH)
      expect(isClaimableByOthers).to.equal(false)
      // Is not refundable anymore, even after 256 blocks
      const isRefundable = await contract
        .connect(addr1)
        .checkIsRefundable(id, submissionBlockNumber, params.rewardAssetETH, params.maxRewardETH)
      expect(isRefundable).to.equal(false)
      const isClaimable = await contract
        .connect(addr2)
        .checkIsClaimable(id, params.rewardAssetETH, params.maxRewardETH, params.settledAmountETH)
      expect(isClaimable).to.equal(false)
      const res = await contract
        .connect(addr2)
        .claimPayout(id, params.rewardAssetETH, params.maxRewardETH, params.settledAmountETH)
      const receipt = await res.wait()
      // extract amount in ETH that was paid for gas
      const gasUsed = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      let balancePostOrder = await ethers.provider.getBalance(addr2.address)

      expect(balancePostOrder.sub(balancePriorOrder)).to.equal(BigNumber.from(params.maxRewardETH).sub(gasUsed))

      // Check cannot withdraw again
      await expect(
        contract.connect(addr1).claimPayout(id, params.rewardAssetETH, params.maxRewardETH, params.settledAmountETH),
      ).to.be.revertedWith('Payload for withdrawal not matching')

      const isClaimableSecondTime = await contract
        .connect(addr1)
        .checkIsClaimable(id, params.rewardAssetETH, params.maxRewardETH, params.settledAmountETH)
      expect(isClaimableSecondTime).to.equal(false)
    })

    it.skip('Should revert order of user in ETH with only-after attestation refund flag off', async function () {
      // send order with ETH as rewardAsset
      let params = await getParams()

      const submissionBlockNumber = (await hre.ethers.provider.getBlock('latest')).number + 1
      const id = generateId(addr1.address, submissionBlockNumber)

      await contract
        .connect(addr1)
        .order(
          params.destination,
          params.asset,
          params.targetAccount,
          params.amount,
          params.rewardAssetETH,
          params.insurance,
          params.maxRewardETH,
          { value: params.maxRewardETH },
        )

      // check gmp payload is set
      const payloadKey = await escrowGMPContract.remotePaymentsPayloadHash(id)
      const intermediatePayloadKey = await generateRemotePaymentPayload(params.rewardAssetETH, params.maxRewardETH)
      expect(payloadKey).to.equal(intermediatePayloadKey)

      const _txTurnOff = await contract.connect(owner).turnOffRefundableOnlyAfterAttestation()

      const payloadKeyAfterRevert = await escrowGMPContract.remotePaymentsPayloadHash(id)
      // Should equal to keccak256(abi.encode(currentHash, address(0)))
      const finalExpectedPayloadKey = intermediatePayloadKey

      expect(payloadKeyAfterRevert).to.equal(finalExpectedPayloadKey)

      // Check cannot withdraw random amount
      await expect(
        contract.connect(addr1).claimPayout(id, params.rewardAssetETH, params.settledAmountETH),
      ).to.be.revertedWith('Payload for withdrawal not matching')

      let balancePriorOrder = await ethers.provider.getBalance(addr1.address)
      // Check executor cannot claim reward
      const isClaimable = await contract.connect(addr1).checkIsClaimable(id, params.rewardAssetETH, params.maxRewardETH)
      expect(isClaimable).to.equal(false)

      // Mine 256 blocks
      await hre.network.provider.send('hardhat_mine', ['0x100'])
      // Check executor cannot claim reward
      const isClaimablePost256 = await contract
        .connect(addr1)
        .checkIsClaimable(id, params.rewardAssetETH, params.maxRewardETH)
      expect(isClaimablePost256).to.equal(false)
      const isRefundable = await contract
        .connect(addr1)
        .checkIsRefundable(id, submissionBlockNumber, params.rewardAssetETH, params.maxRewardETH)
      expect(isRefundable).to.equal(true)
      const res = await contract
        .connect(addr1)
        .claimRefund(submissionBlockNumber, params.rewardAssetETH, params.maxRewardETH)
      const receipt = await res.wait()
      // extract amount in ETH that was paid for gas
      const gasUsed = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      let balancePostOrder = await ethers.provider.getBalance(addr1.address)

      expect(balancePostOrder.sub(balancePriorOrder)).to.equal(BigNumber.from(params.maxRewardETH).sub(gasUsed))

      // Check cannot withdraw again
      await expect(
        contract.connect(addr1).claimPayout(id, params.rewardAssetETH, params.maxRewardETH),
      ).to.be.revertedWith('Payload for withdrawal not matching')

      const isRefundableSecondTime = await contract
        .connect(addr1)
        .checkIsRefundable(id, submissionBlockNumber, params.rewardAssetETH, params.maxRewardETH)
      expect(isRefundableSecondTime).to.equal(false)
    })

    it.skip('Should revert order of user in ETH with only-after attestation refund flag on', async function () {
      this.timeout(1000000)
      // send order with ETH as rewardAsset
      let params = await getParams()

      const submissionBlockNumber = (await hre.ethers.provider.getBlock('latest')).number + 1
      const id = generateId(addr1.address, submissionBlockNumber)

      await contract
        .connect(addr1)
        .order(
          params.destination,
          params.asset,
          params.targetAccount,
          params.amount,
          params.rewardAssetETH,
          params.insurance,
          params.maxRewardETH,
          { value: params.maxRewardETH },
        )

      // check gmp payload is set
      const payloadKey = await escrowGMPContract.remotePaymentsPayloadHash(id)
      const intermediatePayloadKey = await generateRemotePaymentPayload(params.rewardAssetETH, params.maxRewardETH)
      expect(payloadKey).to.equal(intermediatePayloadKey)

      const _txTurnOn = await contract.connect(owner).turnOnRefundableOnlyAfterAttestation()

      // Check should not be possible to claim reward, refund just yet
      await expect(
        contract.connect(addr1).claimPayout(id, params.rewardAssetETH, params.maxRewardETH, params.settledAmountETH),
      ).to.be.revertedWith('Payload for withdrawal not matching')

      // Check cannot withdraw random amount
      await expect(
        contract
          .connect(addr1)
          .claimPayout(id, params.rewardAssetETH, params.settledAmountETH, params.settledAmountETH),
      ).to.be.revertedWith('Payload for withdrawal not matching')

      const isClaimableExpectFalse = await contract
        .connect(addr1)
        .checkIsClaimable(id, params.rewardAssetETH, params.maxRewardETH, params.settledAmountETH)
      expect(isClaimableExpectFalse).to.equal(false)

      // Check cannot withdraw random asset
      await expect(
        contract.connect(addr1).claimPayout(id, params.rewardAssetUSDC, params.maxRewardETH, params.settledAmountETH),
      ).to.be.revertedWith('Payload for withdrawal not matching')

      // Addr1 faking the attesters smart contract's authorization
      await escrowGMPContract.connect(addr1).revertRemoteOrderPayload(id)
      // Check GMP Payload key is not set to executor's address but null address
      const payloadKeyAfterRevert = await escrowGMPContract.remotePaymentsPayloadHash(id)
      // Should equal to keccak256(abi.encode(currentHash, address(0)))
      const finalExpectedPayloadKey = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ['bytes32', 'address'],
          [intermediatePayloadKey, ethers.constants.AddressZero],
        ),
      )

      expect(payloadKeyAfterRevert).to.equal(finalExpectedPayloadKey)

      // Check cannot withdraw random amount
      await expect(
        contract.connect(addr1).claimPayout(id, params.rewardAssetETH, params.maxRewardETH, params.settledAmountETH),
      ).to.be.revertedWith('Payload for withdrawal not matching')

      let balancePriorOrder = await ethers.provider.getBalance(addr1.address)
      // Check executor cannot claim reward
      const isClaimable = await contract
        .connect(addr1)
        .checkIsClaimable(id, params.rewardAssetETH, params.maxRewardETH, params.settledAmountETH)
      expect(isClaimable).to.equal(false)

      // Mine 256 blocks
      await hre.network.provider.send('hardhat_mine', ['0x100'])
      // Check executor cannot claim reward
      const isClaimablePost256 = await contract
        .connect(addr1)
        .checkIsClaimable(id, params.rewardAssetETH, params.maxRewardETH, params.settledAmountETH)
      expect(isClaimablePost256).to.equal(false)
      const isRefundable = await contract
        .connect(addr1)
        .checkIsRefundable(id, submissionBlockNumber, params.rewardAssetETH, params.maxRewardETH)
      expect(isRefundable).to.equal(true)
      const res = await contract
        .connect(addr1)
        .claimRefund(submissionBlockNumber, params.rewardAssetETH, params.maxRewardETH)
      const receipt = await res.wait()
      // extract amount in ETH that was paid for gas
      const gasUsed = receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice)
      let balancePostOrder = await ethers.provider.getBalance(addr1.address)

      expect(balancePostOrder.sub(balancePriorOrder)).to.equal(BigNumber.from(params.maxRewardETH).sub(gasUsed))

      // Check cannot withdraw again
      await expect(
        contract.connect(addr1).claimPayout(id, params.rewardAssetETH, params.maxRewardETH, params.maxRewardETH),
      ).to.be.revertedWith('Payload for withdrawal not matching')

      const isRefundableSecondTime = await contract
        .connect(addr1)
        .checkIsRefundable(id, submissionBlockNumber, params.rewardAssetETH, params.maxRewardETH)
      expect(isRefundableSecondTime).to.equal(false)
    })

    it('Should be able to confirm single Order with Native ETH', async function () {
      // Send from addr2 to addr1 amount of Native ETH
      let params = await getParams()
      const balanceExecutorPriorOrder = await ethers.provider.getBalance(addr2.address)
      const balanceTargetPriorOrder = await ethers.provider.getBalance(addr1.address)

      let id = generateId(addr1.address, await getLatestBlockTimestamp())
      const confirmTx = await contract
        .connect(addr2)
        .confirmOrderV3(
          id,
          addr1.address,
          params.amount,
          params.rewardAssetETH,
          await getLatestBlockTimestamp(),
          addr1.address,
          encodeNetworkId('sept'),
          {
            value: params.amount,
          },
        )

      const confirmTxReceipt = await confirmTx.wait()

      const txGasUsed = confirmTxReceipt.gasUsed

      // Find the ExecuteGasConsumed event
      const gasConsumedEvent = confirmTxReceipt.events.find((event) => event.event === 'ExecuteGasConsumed')

      expect(gasConsumedEvent.args.gasConsumed.toNumber()).to.be.almost(txGasUsed.toNumber(), 1000)

      // bytes32 confirmationId = keccak256(abi.encode(ids[i], targets[i], amounts[i], assets[i], msg.sender));
      //
      const confirmationIdSeed = ethers.utils.defaultAbiCoder.encode(
        ['bytes32', 'address', 'uint256', 'address', 'address'],
        [id, addr1.address, params.amount, params.rewardAssetETH, addr2.address],
      )

      const confirmationId = ethers.utils.keccak256(confirmationIdSeed)

      await expect(confirmTx)
        .to.emit(contract, 'Confirmation')
        .withArgs(
          id,
          addr1.address,
          params.amount,
          params.rewardAssetETH,
          addr2.address,
          confirmationId,
          await getLatestBlockTimestamp(),
        )

      // should revert double confirmation attempt with RO#7
      expect(
        contract
          .connect(addr2)
          .confirmOrderV3(
            id,
            addr1.address,
            params.amount,
            params.rewardAssetETH,
            await getLatestBlockTimestamp(),
            addr1.address,
            encodeNetworkId('sept'),
            {
              value: params.amount,
            },
          ),
      ).to.be.revertedWith('RO#7')

      const balanceExecutorPostOrder = await ethers.provider.getBalance(addr2.address)
      const balanceTargetPostOrder = await ethers.provider.getBalance(addr1.address)

      expect(balanceExecutorPostOrder).to.equal(
        balanceExecutorPriorOrder
          .sub(params.amount)
          .sub(confirmTxReceipt.cumulativeGasUsed * confirmTxReceipt.effectiveGasPrice),
      )
      expect(balanceTargetPostOrder).to.equal(balanceTargetPriorOrder.add(params.amount))

      const newOrderTimestamp = await getLatestBlockTimestamp()
      const newOrderId = generateId(addr1.address, newOrderTimestamp)
      // Check sending a different amount than attached in value reverts

      // Charge the contract with enought amount via sendTransfer
      await owner.sendTransaction({
        value: params.amount.mul(10),
        to: contract.address,
      })
      await expect(
        contract
          .connect(addr2)
          .confirmOrderV3(
            newOrderId,
            addr1.address,
            params.amount,
            params.rewardAssetETH,
            newOrderTimestamp,
            addr1.address,
            encodeNetworkId('sept'),
            {
              value: params.amount.sub(1),
            },
          ),
      ).to.be.revertedWith('RO#2')
    })

    it('Should be able to confirm single Order with ERC-20 USDC', async function () {
      // Send from addr2 to addr1 amount of USDC
      let params = await getParams()
      await USDCContract.connect(addr2).approve(contract.address, params.amount)
      const balanceExecutorPriorOrder = await USDCContract.balanceOf(addr2.address)
      const balanceTargetPriorOrder = await USDCContract.balanceOf(addr1.address)

      const orderTimestamp = await getLatestBlockTimestamp()

      let id = generateId(addr1.address, orderTimestamp)
      const confirmTx = await contract
        .connect(addr2)
        .confirmOrderV3(
          id,
          addr1.address,
          params.amount,
          params.rewardAssetUSDC,
          orderTimestamp,
          addr1.address,
          encodeNetworkId('sept'),
        )

      const confirmTxReceipt = await confirmTx.wait()

      const confirmationIdSeed = ethers.utils.defaultAbiCoder.encode(
        ['bytes32', 'address', 'uint256', 'address', 'address'],
        [id, addr1.address, params.amount, params.rewardAssetUSDC, addr2.address],
      )

      const confirmationId = ethers.utils.keccak256(confirmationIdSeed)

      await expect(confirmTx)
        .to.emit(contract, 'Confirmation')
        .withArgs(
          id,
          addr1.address,
          params.amount,
          params.rewardAssetUSDC,
          addr2.address,
          confirmationId,
          orderTimestamp + 1,
        )

      const balanceExecutorPostOrder = await USDCContract.balanceOf(addr2.address)
      const balanceTargetPostOrder = await USDCContract.balanceOf(addr1.address)

      expect(balanceExecutorPostOrder).to.equal(balanceExecutorPriorOrder.sub(params.amount))
      expect(balanceTargetPostOrder).to.equal(balanceTargetPriorOrder.add(params.amount))
    })

    it('Should should confirm two out of two Native ETH if enough value provided', async function () {
      // Send from addr2 to addr1 amount of USDC
      let params = await getParams()
      await USDCContract.connect(addr2).approve(contract.address, params.amount)
      const balanceExecutorPriorOrderETH = await ethers.provider.getBalance(addr2.address)
      const balanceTargetPriorOrderETH = await ethers.provider.getBalance(addr1.address)

      const orderTimestamp = await getLatestBlockTimestamp()
      let idA = generateId(addr1.address, orderTimestamp)
      let idB = generateId(addr1.address, orderTimestamp + 1)
      const confirmTx = await avpBatchSubmitterContract.connect(addr2).confirmBatchOrdersV3(
        [
          [idA, idB],
          [addr1.address, addr1.address],
          [params.amount.div(2), params.amount.div(2)],
          [params.rewardAssetETH, params.rewardAssetETH],
          [orderTimestamp, orderTimestamp + 1],
          [addr1.address, addr1.address],
          [encodeNetworkId('sept'), encodeNetworkId('sept')],
        ],
        {
          value: params.amount,
        },
      )

      const confirmTxReceipt = await confirmTx.wait()

      const balanceExecutorPostOrderETH = await ethers.provider.getBalance(addr2.address)
      const balanceTargetPostOrderETH = await ethers.provider.getBalance(addr1.address)

      expect(balanceExecutorPostOrderETH).to.equal(
        balanceExecutorPriorOrderETH
          .sub(params.amount)
          .sub(confirmTxReceipt.cumulativeGasUsed * confirmTxReceipt.effectiveGasPrice),
      )
      expect(balanceTargetPostOrderETH).to.equal(balanceTargetPriorOrderETH.add(params.amount))
    })

    it('Should not accept new orders when halted', async function () {
      // send order with ETH as rewardAsset
      let params = await getParams()

      await contract.connect(owner).turnOnHalt()

      const submissionBlockNumber = (await hre.ethers.provider.getBlock('latest')).number + 1

      // Expect revert with error message "Contract is halted"
      await expect(
        contract
          .connect(addr1)
          .order(
            params.destination,
            params.asset,
            params.targetAccount,
            params.amount,
            params.rewardAssetETH,
            params.insurance,
            params.maxRewardETH,
            { value: params.maxRewardETH.add(BigNumber.from('1000')) },
          ),
      ).to.be.revertedWith('RO#2')

      const payloadFinalKey = await escrowGMPContract.remotePaymentsPayloadHash(
        generateId(addr1.address, submissionBlockNumber),
      )
      // expect the payload to be stored in the escrow contract
      expect(payloadFinalKey).to.equal(ZERO_BYTES32)

      // check contract balance
      const vaultsBalance = await ethers.provider.getBalance(contract.address)
      expect(vaultsBalance).to.equal(ethers.utils.parseEther('0'))
    })

    it('Should subtract maxReward & protocol fees when set correctly in ETH', async function () {
      // send order with ETH as rewardAsset
      let params = await getParams()

      await contract
        .connect(owner)
        .setCurrentProtocolFee(BigNumber.from('1000'), BigNumber.from('0'), BigNumber.from('0'))

      const orderTimestamp = await getLatestBlockTimestamp()
      const protocolFeeAddOn = BigNumber.from('1000').mul(params.maxRewardETH).div('1000000')

      // Verify add-on equals to calcProtocolFee
      const calculateProtocolFee = await contract.calcProtocolFee(params.maxRewardETH, ethers.constants.AddressZero)

      expect(calculateProtocolFee).to.equal(protocolFeeAddOn)

      const orderTx = await contract
        .connect(addr1)
        .order(
          params.destination,
          params.asset,
          params.targetAccount,
          params.amount,
          params.rewardAssetETH,
          params.insurance,
          params.maxRewardETH,
          { value: params.maxRewardETH },
        )

      const receipt = await orderTx.wait()

      // Assume successful order
      expect(receipt.status).to.equal(1)

      const payloadFinalKey = await escrowGMPContract.remotePaymentsPayloadHash(
        generateId(addr1.address, orderTimestamp + 1),
      )
      // expect the payload to be stored in the escrow contract
      expect(payloadFinalKey).to.equal(await generateRemotePaymentPayload(params.rewardAssetETH, params.maxRewardETH))

      // check contract balance
      const vaultsBalance = await ethers.provider.getBalance(contract.address)
      expect(vaultsBalance).to.equal(maxRewardETH)
    })

    it('Should be able to confirm and claim order', async function () {
      // send order with ETH as rewardAsset
      let params = await getParams()

      await contract
        .connect(owner)
        .setCurrentProtocolFee(BigNumber.from('1000'), BigNumber.from('0'), BigNumber.from('0'))

      const submissionBlockNumber = (await hre.ethers.provider.getBlock('latest')).number + 1
      const nextOrderTimestamp = (await hre.ethers.provider.getBlock('latest')).timestamp + 1

      const protocolFeeAddOn = BigNumber.from('1000').mul(params.maxRewardETH).div('1000000')

      const orderTx = await contract
        .connect(addr1)
        .order(
          params.destination,
          params.asset,
          params.targetAccount,
          params.amount,
          params.rewardAssetETH,
          params.insurance,
          params.maxRewardETH,
          { value: params.maxRewardETH },
        )

      const receipt = await orderTx.wait()

      // Get the OrderID out of the event logs
      const event = receipt.events.find((event) => event.event === 'OrderCreated')
      const orderId = event.args.id
      const orderTimestamp = event.args.orderTimestamp

      // Assume successful order
      expect(receipt.status).to.equal(1)

      const payloadFinalKey = await escrowGMPContract.remotePaymentsPayloadHash(
        generateId(addr1.address, orderTimestamp),
      )
      // expect the payload to be stored in the escrow contract
      expect(payloadFinalKey).to.equal(await generateRemotePaymentPayload(params.rewardAssetETH, params.maxRewardETH))

      const newRandomAddressFeeCollector = ethers.Wallet.createRandom().address
      expect(await contract.setProtocolFeesCollector(newRandomAddressFeeCollector)).to.be.ok
      const bytes4Zero = ethers.utils.hexZeroPad('0x0', 4)

      // Confirm order
      const confirmTx = await contract
        .connect(addr2)
        .confirmOrderV3(
          orderId,
          addr1.address,
          params.amount,
          params.rewardAssetETH,
          orderTimestamp,
          addr1.address,
          encodeNetworkId('sept'),
          {
            value: params.amount,
          },
        )

      expect(confirmTx)
        .to.emit(contract, 'Confirmation')
        .withArgs(orderId, addr1.address, params.amount, params.rewardAssetETH, addr2.address)

      const confirmTxReceipt = await confirmTx.wait()
      expect(confirmTxReceipt.status).to.equal(1)

      // Feed attestation with the GMP Payload
      let batch = newEmptyBatch()

      batch.committedSfx = [orderId]
      batch.beneficiaries = [addr2.address]

      const messagePayloadEncoded = batchEncodePackedGMP(batch)
      const batchPayloadEncoded = batchEncodePacked(batch)
      const batchPayloadHash = ethers.utils.keccak256(ethUtil.toBuffer(batchPayloadEncoded))
      const signature = await owner.signMessage(ethers.utils.arrayify(batchPayloadHash))

      // Create multiProof
      const multiProof = constructMultiMerkleProof([owner.address])

      console.log('multiProof', multiProof)
      console.log('batchPayloadEncoded', batchPayloadEncoded)
      console.log('messagePayloadEncoded', messagePayloadEncoded)

      const commitmentCallResponse = await attestersContract.receiveAttestationBatch(
        batchPayloadEncoded,
        messagePayloadEncoded,
        [signature],
        multiProof.proof,
        multiProof.flags,
      )

      const commitReceipt = await commitmentCallResponse.wait()

      // gas used should be less than 1M
      console.log(commitReceipt.gasUsed)

      expect(commitmentCallResponse).to.be.ok

      // Move teh GMP Payload to the executor
      // await escrowGMPContract.connect(addr1).commitRemoteBeneficiaryPayload(orderId, addr2.address)
      // Ensure claimerGMP is set
      const remoteClaimerGMP = await contract.claimerGMP()
      expect(remoteClaimerGMP).to.equal(claimerGMPContract.address)

      // Check GMP Payload key is not set to executor's address
      const isClaimable2 = await contract.checkIsClaimableV2(
        orderId,
        params.rewardAssetETH,
        params.maxRewardETH,
        0,
        addr2.address,
        orderTimestamp,
        batchPayloadHash,
        batchPayloadEncoded,
      )

      expect(isClaimable2).to.equal(true)

      const balancePriorOrder = await ethers.provider.getBalance(addr2.address)
      const claimTx = await contract
        .connect(addr2)
        .claimPayoutV2(
          orderId,
          params.rewardAssetETH,
          params.maxRewardETH,
          0,
          orderTimestamp,
          batchPayloadHash,
          batchPayloadEncoded,
        )

      expect(claimTx).to.be.ok

      const receiptClaim = await claimTx.wait()
      expect(receiptClaim.gasUsed).to.be.lt(ethers.BigNumber.from('1000000'))
      const gasFeesUsed = receiptClaim.gasUsed.mul(receiptClaim.effectiveGasPrice)

      const ONE = ethers.utils.parseEther('1')

      // Charge newRandomAddressFeeCollector with money
      await owner.sendTransaction({
        to: newRandomAddressFeeCollector,
        value: ONE,
      })

      // Emergency withdraw as protocol fee collector
      await contract
        .connect(owner)
        .emergencyWithdraw(params.rewardAssetETH, protocolFeeAddOn, newRandomAddressFeeCollector)

      // check contract balance
      const collectorBalance = await ethers.provider.getBalance(newRandomAddressFeeCollector)
      expect(collectorBalance).to.equal(protocolFeeAddOn.add(ONE))
      const balancePostOrder = await ethers.provider.getBalance(addr2.address)
      expect(balancePostOrder).equal(balancePriorOrder.add(params.maxRewardETH).sub(gasFeesUsed).sub(protocolFeeAddOn))
    })

    it('Should revert when attempt to confirm one out of two Native ETH if not enough value provided', async function () {
      // Send from addr2 to addr1 amount of USDC
      let params = await getParams()
      const balanceExecutorPriorOrderETH = await ethers.provider.getBalance(addr2.address)
      const balanceTargetPriorOrderETH = await ethers.provider.getBalance(addr1.address)

      const orderTimestamp = await getLatestBlockTimestamp()
      let idA = generateId(addr1.address, orderTimestamp)
      let idB = generateId(addr2.address, orderTimestamp)
      const confirmTx = avpBatchSubmitterContract.connect(addr2).confirmBatchOrdersV3(
        [
          [idA, idB],
          [addr1.address, addr2.address],
          [params.amount, params.amount],
          [params.rewardAssetETH, params.rewardAssetETH],
          [orderTimestamp, orderTimestamp],
          [addr1.address, addr2.address],
          [encodeNetworkId('sept'), encodeNetworkId('sept')],
        ],
        {
          value: params.amount,
        },
      )

      await expect(confirmTx).to.be.reverted
    })

    it('Should be able to confirm batch Order with ERC-20 USDC + Native ETH', async function () {
      // Send from addr2 to addr1 amount of USDC
      let params = await getParams()
      await USDCContract.connect(addr2).approve(contract.address, params.amount)
      const balanceExecutorPriorOrderETH = await ethers.provider.getBalance(addr2.address)
      const balanceTargetPriorOrderETH = await ethers.provider.getBalance(addr1.address)

      const orderTimestamp = await getLatestBlockTimestamp()
      let idA = generateId(addr1.address, orderTimestamp)
      let idB = generateId(addr2.address, orderTimestamp)

      const confirmTx = await avpBatchSubmitterContract.connect(addr2).confirmBatchOrdersV3(
        [
          [idA, idB],
          [addr1.address, addr2.address],
          [params.amount, params.amount],
          [params.rewardAssetETH, params.rewardAssetETH],
          [orderTimestamp, orderTimestamp],
          [addr1.address, addr2.address],
          [encodeNetworkId('sept'), encodeNetworkId('sept')],
        ],
        {
          value: params.amount.mul(2),
        },
      )

      const confirmTxReceipt = await confirmTx.wait()

      const confirmationIdASeed = ethers.utils.defaultAbiCoder.encode(
        ['bytes32', 'address', 'uint256', 'address', 'address'],
        [idA, addr1.address, params.amount, params.rewardAssetETH, addr2.address],
      )

      const confirmationIdA = ethers.utils.keccak256(confirmationIdASeed)

      const confirmationIdBSeed = ethers.utils.defaultAbiCoder.encode(
        ['bytes32', 'address', 'uint256', 'address', 'address'],
        [idB, addr2.address, params.amount, params.rewardAssetETH, addr2.address],
      )

      const confirmationIdB = ethers.utils.keccak256(confirmationIdBSeed)

      const confirmationEventA = confirmTxReceipt.events[0]
      const confirmationEventB = confirmTxReceipt.events[1]

      expect(confirmationEventA.event).to.equal('Confirmation')
      expect(confirmationEventB.event).to.equal('Confirmation')
      expect(confirmationEventA.args.toString()).to.equal(
        [
          idA,
          addr1.address,
          params.amount,
          params.rewardAssetETH,
          addr2.address,
          confirmationIdA,
          BigNumber.from(orderTimestamp + 1),
        ].toString(),
      )

      expect(confirmationEventB.args.toString()).to.equal(
        [
          idB,
          addr2.address,
          params.amount,
          params.rewardAssetETH,
          addr2.address,
          confirmationIdB,
          BigNumber.from(orderTimestamp + 1),
        ].toString(),
      )

      const balanceExecutorPostOrderETH = await ethers.provider.getBalance(addr2.address)
      const balanceTargetPostOrderETH = await ethers.provider.getBalance(addr1.address)

      expect(balanceExecutorPostOrderETH).to.equal(
        balanceExecutorPriorOrderETH
          .sub(params.amount)
          .sub(confirmTxReceipt.cumulativeGasUsed * confirmTxReceipt.effectiveGasPrice),
      )
      expect(balanceTargetPostOrderETH).to.equal(balanceTargetPriorOrderETH.add(params.amount))
    })

    it.skip('Should revert order and refund user in USDC', async function () {
      let params = await getParams()
      await USDCContract.connect(addr1).approve(contract.address, params.maxRewardUSDC)
      let balancePriorOrder = await USDCContract.balanceOf(addr1.address)
      let id = generateId(addr1.address, await getNextBlockNumber())
      await contract
        .connect(addr1)
        .order(
          params.destination,
          params.asset,
          params.targetAccount,
          params.amount,
          params.rewardAssetUSDC,
          params.insurance,
          params.maxRewardUSDC,
        )
      await expect(contract.connect(addr1).revertOrder(id))
        .to.emit(contract, 'OrderRefundedInERC20')
        .withArgs(id, addr1.address, params.maxRewardUSDC)

      let status = await contract.orders(id)
      expect(status.toString()).to.equal(
        'true,0x03030303,0x05050505,0x70997970C51812dc3A010C7d01b50e0d17dc79C8,0x70997970C51812dc3A010C7d01b50e0d17dc79C8,10000000000000000000,0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512,2000000000000000000,100000000,2',
      ) // 2 corresponds to "Reverted"
      let balancePost = await USDCContract.balanceOf(addr1.address)
      expect(balancePriorOrder).to.equal('900000000') // Ensure the USDC was refunded
      expect(balancePost).to.equal(balancePriorOrder) // Ensure the USDC was refunded
    })

    it("Should return false when ID doesn't exist", async function () {
      let id = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'uint32'], [addr1.address, 100])) // Non-existent ID
      let exists = await contract.isKnownId(id)
      expect(exists).to.equal(false)
    })

    it('Should return true when ID exists', async function () {
      let params = await getParams()
      const orderTimestamp = await getLatestBlockTimestamp()
      const id = generateId(addr1.address, orderTimestamp + 1)
      const tx = await contract
        .connect(addr1)
        .order(
          params.destination,
          params.asset,
          params.targetAccount,
          params.amount,
          params.rewardAssetETH,
          params.insurance,
          params.maxRewardETH,
          { value: params.maxRewardETH },
        )
      const txReceipt = await tx.wait()

      let exists = await contract.isKnownId(id)
      expect(exists).to.equal(true)
    })
  })
})
