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

describe('AvpBatchSubmitter', function () {
  let contract, USDCContract, owner, addr1, initialAddr1Balance, initialAddr1USDCBalance

  let RemoteOrder
  let escrowGMPContract
  let attestersContract
  let claimerGMPContract
  let avpBatchSubmitterContract
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

    const Attesters = await ethers.getContractFactory('AttestationsVerifierProofs')
    attestersContract = await upgrades.deployProxy(Attesters, [owner.address, [owner.address], [owner.address], 0], {
      initializer: 'initialize',
    })
    await attestersContract.deployed()
    await attestersContract.setSkipEscrowWrites(true)

    const EscrowGMP = await ethers.getContractFactory('EscrowGMP')
    escrowGMPContract = await upgrades.deployProxy(EscrowGMP, [owner.address], {
      initializer: 'initialize',
    })
    await escrowGMPContract.deployed()

    const AvpBatchSubmitter = await ethers.getContractFactory('avpBatchSubmitter')
    avpBatchSubmitterContract = await upgrades.deployProxy(AvpBatchSubmitter, [owner.address], {
      initializer: 'initialize',
    })
    await avpBatchSubmitterContract.deployed()

    await avpBatchSubmitterContract.setEscrowGMP(escrowGMPContract.address)
    await avpBatchSubmitterContract.setAVP(attestersContract.address)

    await attestersContract.assignEscrowGMP(escrowGMPContract.address)

    RemoteOrder = await ethers.getContractFactory('RemoteOrder')
    contract = await upgrades.deployProxy(RemoteOrder, [owner.address], {
      initializer: 'initialize',
    })
    await contract.deployed()
    await avpBatchSubmitterContract.setRO(contract.address)

    // Assign orderer contract to remote order caller
    await escrowGMPContract.assignOrderer(contract.address)
    await escrowGMPContract.assignAVPBatchSubmitter(avpBatchSubmitterContract.address)
    await attestersContract.assignOrderer(contract.address)

    await contract.setEscrowGMP(escrowGMPContract.address)
    await contract.setExecutionCutOff(30 * 60) // 30 minutes
    // await contract.assignAttesters(attestersContract.address)
    await contract.setOperator(avpBatchSubmitterContract.address)
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

  it.skip('Should confirm batch orders successfully', async function () {
    const ids = [
      ethers.utils.keccak256(ethers.utils.toUtf8Bytes('id1')),
      ethers.utils.keccak256(ethers.utils.toUtf8Bytes('id2')),
    ]
    const targets = [addr1.address, addr2.address]
    const amounts = [ethers.utils.parseEther('10'), ethers.utils.parseEther('20')]
    const assets = [USDCContract.address, USDCContract.address] // Using USDC as asset

    // Approve the transfer of tokens from addr1 and addr2 to the contract
    await USDCContract.connect(addr1).approve(avpBatchSubmitterContract.address, amounts[0])
    await USDCContract.connect(addr2).approve(avpBatchSubmitterContract.address, amounts[1])

    // Confirm the batch orders
    await expect(avpBatchSubmitterContract.connect(owner).confirmBatchOrders(ids, targets, amounts, assets)).to.emit(
      contract,
      'Confirmation',
    ) // Check if Confirmation event is emitted

    // Add additional checks for events or state changes (e.g., check balances)
    const balance1 = await USDCContract.balanceOf(addr1.address)
    const balance2 = await USDCContract.balanceOf(addr2.address)

    // Validate the balances after confirmation
    expect(balance1).to.equal(ethers.utils.parseEther('990')) // 1000 - 10 USDC
    expect(balance2).to.equal(ethers.utils.parseEther('980')) // 1000 - 20 USDC
  })

  it('Should confirm batch orders with native currency (ETH) for single order', async function () {
    const targets = [addr1.address]
    const amounts = [ethers.utils.parseEther('1')] // 1 ETH and 2 ETH respectively
    const assets = [ethers.constants.AddressZero] // Using ETH as asset

    const balancesPrior = {
      addr1: await ethers.provider.getBalance(addr1.address),
      addr2: await ethers.provider.getBalance(addr2.address),
    }

    const blockTimestamp = (await ethers.provider.getBlock('latest')).timestamp

    const nonces = [blockTimestamp]
    const ids = [generateId(addr1.address, blockTimestamp)]

    const tx = await avpBatchSubmitterContract
      .connect(owner)
      .confirmBatchOrdersV3([ids, targets, amounts, assets, nonces, [addr1.address], [encodeNetworkId('sept')]], {
        value: ethers.utils.parseEther('1'),
      }) // sending 1 ETH

    const receipt = await tx.wait()
    // Find the ExecutedBatchGasConsumed event
    const executedBatchGasConsumedEvent = receipt.events.find((event) => event.event === 'ExecutedBatchGasConsumed')
    expect(executedBatchGasConsumedEvent.args.gasConsumed.toNumber()).to.be.almost(receipt.gasUsed.toNumber(), 10_000)

    // Add additional checks for events or state changes (e.g., check balances)
    const balance1 = await ethers.provider.getBalance(addr1.address)

    // Validate the balances after confirmation
    // Normally, you would fetch the balance before and subtract the difference
    expect(balance1).to.be.eq(balancesPrior.addr1.add(ethers.utils.parseEther('1'))) // addr1 receives 1 ETH
  })

  it('Should claim of V2 batch', async function () {
    const batchPayload =
      '0x00000000000000000000000000000000000000000000000000000000000000004311ef44023db844202164ea94b74b7165374f7b2d2c4e6154f0d49d3a9248fa4311ef44023db844202164ea94b74b7165374f7b2d2c4e6154f0d49d3a9248fa00000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000008e09b00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000013e00a239f726c8b6e97ea7e4bb4282f799dd11cffd3a3d3d328ce91aaa8aaeec03c18f78dae1cdef0ea7eb9f38901859f3076413b435005c09c3f363360e9b0c92d7e1501b60a751c00a5f146215356a486cae0a0d1a6ddce169e6c107e3a7e0ed1109bbba5729205e905200a88cae4dbbae7aeb5418127ef4bca59d7d64c9e5a5bd506552d89be5697a2ba82cdfb1162e123e78f35ad4491084fbc894fbe7140073b8d6aafe1798607361b3810893c594ddd5bf9461a8e505a68c0d209daf54462cdfb1162e123e78f35ad4491084fbc894fbe71400e62d01e717a4325fce356188b5dd0d744a1cb2cda3b257e5c599c83fef71fde840baee97ecfbe84913bd47d69b933e2bc08905a100da4941f6a6e1ac93512aaa5fcf5c3a95963f3701d244b326685f39d441ba0c62587c901b8016ac848b42c85ae476109f56bcedb50000'
    const orderId = '0x5c09c3f363360e9b0c92d7e1501b60a751c00a5f146215356a486cae0a0d1a6d'
    const batchPayloadHash = ethers.utils.keccak256(batchPayload)

    const beneficiary = '0xDce169e6c107E3a7e0ed1109Bbba5729205E9052'

    // Append coupld of IDs to escrowGMP

    // add escrowGMP order id
    await escrowGMPContract.assignOrderer(owner.address)
    await escrowGMPContract.storeRemoteOrderPayload(orderId, batchPayloadHash)

    const tx = await claimerGMPContract.isClaimableNoPayloadStored(
      batchPayloadHash,
      batchPayload,
      orderId,
      beneficiary,
      BigNumber.from(0),
      0,
    )

    expect(tx).to.be.true
  })

  it('Should refund of V2 batch', async function () {
    /*
      account: "0x750791eA7092EfDF257D4711Ee811bf89eAbE2c1"
      id: "0x42823274db8845bb9e5db4c12a5e91b1f800bebb6806ee5124a7bceaa1653b13"
      batchPayload: "0x00000000000000000000000000000000000000000000000000000000000000002be66e78af1254d653bf7fc39d024c1362bd4a3e9b52a7a4dcc9640f88d34f47c3495c9425379f7f2436ef32ea808336df89c732b7757b99ad63d02844471d7900000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000020bac0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007bc01d2464a5333cef2001c6ce4d8fa8b035742c34891c7223b9a06fea7acd2fbd5f201d2464a5333cef2001c6ce4d8fa8b035742c34891c7223b9a06fea7acd2fbd5f2012fa7f5c3f96f476bf0a80278526456e916377f9615f03a84e00968437c3397d301ef97f7f3b090c93a826f9670c1604f9fa9b8032cd2923f2da218aa45e8499a18018ce40d14a59f8a25d85318ade96935796cfcdc5c8d0bcb94534a1c98b61f1af301bd06b1837ac7f11547359fdae2c1ca36b7d4ad9cb0d6cd537dcbfdda6e011fa7017db99fbdf1735ce571ab6c544eeb3195b6dccbe9feda6c036450f0bdc7748f73013338c4e98a4a67e21b4383be996ea85d85cce98c69e8508492ce8f77624efeae0187f4f642ce6e342d6867cdc8d3b571c83fa906d07e21ef7c555ac96883beb8c301dbc5025f25d943f6eb2bd5ad8f0c25a8e4bb2b44eb6893a50090bc46cfc6ab1601c43601712c20daf32f901f0a6a79fc6ed8ef691d0b51fc9f2d1c8c47f47f368b019f612c7e4e22ab104df220d908dd29dfaf6f038a53e29cc3ab52bd7bff6864e9019e11eb6986d44cddad01e433105031d84e4c8d983fe2dd5f62357a2d65ab11bd016fd05eb09ed5303c2fd95022e1dfa6921c64980246f45f85395a25052aa07a5c01723f4cd1815a0fe4f5ab35813918d1d0d78a65d4cecbffda1ff3b3514520b996019961edcec6584872a3ed3baab18405ed2d3b62a35544f2fe5e0215cac0a393bc0142823274db8845bb9e5db4c12a5e91b1f800bebb6806ee5124a7bceaa1653b130190d4ba338394bac438f9a7c4f9f2ba22db4c887dd00f7dbe28277a9fb55d078f0196d2f76f508b0f566ca3261c858d162dab981216a590f94804924fc20c7cc61301e1c538aa921894a846efa89f227547d47cd31644bb7a34ad792ffb6fb794153b01d419a7e64dd137c58a6db1aa2e5aa78d0c42d7d3e7d9ef29bbe014342a68bc31019839527794d7b0f6d4211e5f6e3f80c8f9fc4b6bc4b33c32731e9ff5d631c2160121cd526f7a8d5c348aaf0acd739283beea81e1e1687b21f6a10a7a8a32c0fd9701a617e4143a135f71123dded4723de78dafdf8e3e4caa3c5eb6a24df896373a3301d130b19a9c35ad8a541a7e64af714fff2f9a760722c202d995745f78137f0fde0142498cc3b9d55e5b0c698b26f70d744d595afc5cec1cf67957a9b4cc881771ae01ee2b4c75cb3d3c3bde8581ae3d5918f990bbd8834f0b022df276ced53ade4e290118d4d39f763ffbb2905baad5106edcd1b57654e7b1d4013b31d8ca309d127c0a01c8c9cfcf1efc3bb26d600dcd395cfdac17d55b529bd43d70199294e151d2f0ff01b3f24df4095402919d09e0eb47e38d40a778f11e10805db3ac41a5307aa0d31a016db00dff18a5e1d4f79fd118ee8eb7875714a4a5ca70a3688954c25d26b3daf60162385e88e6e10b6bbc07f70b45cf6a698c7785ec2c381b47747844985946e198013e411cc5b00846169900cfbd1eeab4500d13044911664dab03639149140e4099018e4a5ef0bd3d8dffb15f360e4ff0089d3c8abacc448090d90b36bf886a5cf50f01c5add4210fc036d0caf4ec9f2df35a3dad4ea953d8b8c1d9feb01ee36acecf680115cb6d1ecab233fc5bd09db3f6ee9214a9fb0d5d2767c65d6444356c47ab81ea01a1a60e90b23b0b09ba73755c6b431d3a7aeac017e0613f3ad8dcb81d7ae248b3014600a3d42460a0fde646aa4ee87235fa472834adf724eee85ab28cfc32880e43014430c7dfe5268a82f85522c726c3087fad97827179d181580813753c03cada2b01c824bc2a7a6fe1ee87e8a60e3c55767e85e6f13185e2636065c03c2acd936ab8011e8fbe3dddebbaa29531ce4bc96d86b3d6eb25f96bc4c2ce7a5a6b8a9ee603df0167190c86c7a534d9e186b91bc29054a8c025c3639f7a958b6e915e1620bba34b01a62149511e4785188e4137d45e0594e74b719110f8f0f1ec1292666d746d711201d79cd83f849df553c5b046026068caaf84f743bad2642bc6ffb474a796981e25010f6dea5fff72cb6bee9c6dab6946247cdf2cffbb64dee14648d99ca78b294954012078f7579d4ef1c336f23e1370018986fe6491d9c7ed55209fc146f5fce1fff501ac048cac2c154671504aeeae301ffa5c3011ea5b4d4b6bc3211966f6f0608dfc014cec80c7609349c06e9b9d7c62dbeae316670e1df3775582b8ebe7f08cc0093801c5c24a6a6b2aea4b83fd65e50e431db65792f90ab1c7ea50f6f9c5bd3878605d010bb9f262813215af39b7307edec537b473d8e8ac500ca0cb639bc5ff42a73892015a25edcd30a010402994cb4ba1f14ecc6364f650dfbc475d8c7da15be7faf2a701979c11521bdfd7a0b165ce363e84e5c86df0c7bfdb11559dad74e86d9ee3667301bc7c8f680460cba362aaa347de30631a7be4309d096e40fe543eebd4cbdbab5801801ebbfe6878a66e1b8e5f81d6d2d5e377295e35f5247a64db52aea897d7764c01cd0da6738e519b6224d1645b41751001bce3717b3f62dbebc8cf3b1623f77cfb0193f1e5d33e63f628f19afdd3345825e001686ea31480ea344f93ed07432d919b0150c91ce6341cc0fe3bc02cad8f0b0b8684f1d05467b2504efbe1df74c8dfaa48012fa21560668d441c834b239b3a487c433982a1058cc1e6f867e21cd1dadf3eff0101a928d76fb568355eb5bfd553ca2563f98bd4968d7ef2dbef96d5f7987c4d3b011725f879d0727686a6f5055a2ce0bd0ddbe611df261544fd74a3b9ede33dfef000000000"
      batchPayloadHash: "0x75b3f877bc2d2eb931ce77e1166651f37555f8f301aa937758b50dfb0394b82c"
     */

    const batchPayload =
      '0x00000000000000000000000000000000000000000000000000000000000000002be66e78af1254d653bf7fc39d024c1362bd4a3e9b52a7a4dcc9640f88d34f47c3495c9425379f7f2436ef32ea808336df89c732b7757b99ad63d02844471d7900000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000020bac0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007bc01d2464a5333cef2001c6ce4d8fa8b035742c34891c7223b9a06fea7acd2fbd5f201d2464a5333cef2001c6ce4d8fa8b035742c34891c7223b9a06fea7acd2fbd5f2012fa7f5c3f96f476bf0a80278526456e916377f9615f03a84e00968437c3397d301ef97f7f3b090c93a826f9670c1604f9fa9b8032cd2923f2da218aa45e8499a18018ce40d14a59f8a25d85318ade96935796cfcdc5c8d0bcb94534a1c98b61f1af301bd06b1837ac7f11547359fdae2c1ca36b7d4ad9cb0d6cd537dcbfdda6e011fa7017db99fbdf1735ce571ab6c544eeb3195b6dccbe9feda6c036450f0bdc7748f73013338c4e98a4a67e21b4383be996ea85d85cce98c69e8508492ce8f77624efeae0187f4f642ce6e342d6867cdc8d3b571c83fa906d07e21ef7c555ac96883beb8c301dbc5025f25d943f6eb2bd5ad8f0c25a8e4bb2b44eb6893a50090bc46cfc6ab1601c43601712c20daf32f901f0a6a79fc6ed8ef691d0b51fc9f2d1c8c47f47f368b019f612c7e4e22ab104df220d908dd29dfaf6f038a53e29cc3ab52bd7bff6864e9019e11eb6986d44cddad01e433105031d84e4c8d983fe2dd5f62357a2d65ab11bd016fd05eb09ed5303c2fd95022e1dfa6921c64980246f45f85395a25052aa07a5c01723f4cd1815a0fe4f5ab35813918d1d0d78a65d4cecbffda1ff3b3514520b996019961edcec6584872a3ed3baab18405ed2d3b62a35544f2fe5e0215cac0a393bc0142823274db8845bb9e5db4c12a5e91b1f800bebb6806ee5124a7bceaa1653b130190d4ba338394bac438f9a7c4f9f2ba22db4c887dd00f7dbe28277a9fb55d078f0196d2f76f508b0f566ca3261c858d162dab981216a590f94804924fc20c7cc61301e1c538aa921894a846efa89f227547d47cd31644bb7a34ad792ffb6fb794153b01d419a7e64dd137c58a6db1aa2e5aa78d0c42d7d3e7d9ef29bbe014342a68bc31019839527794d7b0f6d4211e5f6e3f80c8f9fc4b6bc4b33c32731e9ff5d631c2160121cd526f7a8d5c348aaf0acd739283beea81e1e1687b21f6a10a7a8a32c0fd9701a617e4143a135f71123dded4723de78dafdf8e3e4caa3c5eb6a24df896373a3301d130b19a9c35ad8a541a7e64af714fff2f9a760722c202d995745f78137f0fde0142498cc3b9d55e5b0c698b26f70d744d595afc5cec1cf67957a9b4cc881771ae01ee2b4c75cb3d3c3bde8581ae3d5918f990bbd8834f0b022df276ced53ade4e290118d4d39f763ffbb2905baad5106edcd1b57654e7b1d4013b31d8ca309d127c0a01c8c9cfcf1efc3bb26d600dcd395cfdac17d55b529bd43d70199294e151d2f0ff01b3f24df4095402919d09e0eb47e38d40a778f11e10805db3ac41a5307aa0d31a016db00dff18a5e1d4f79fd118ee8eb7875714a4a5ca70a3688954c25d26b3daf60162385e88e6e10b6bbc07f70b45cf6a698c7785ec2c381b47747844985946e198013e411cc5b00846169900cfbd1eeab4500d13044911664dab03639149140e4099018e4a5ef0bd3d8dffb15f360e4ff0089d3c8abacc448090d90b36bf886a5cf50f01c5add4210fc036d0caf4ec9f2df35a3dad4ea953d8b8c1d9feb01ee36acecf680115cb6d1ecab233fc5bd09db3f6ee9214a9fb0d5d2767c65d6444356c47ab81ea01a1a60e90b23b0b09ba73755c6b431d3a7aeac017e0613f3ad8dcb81d7ae248b3014600a3d42460a0fde646aa4ee87235fa472834adf724eee85ab28cfc32880e43014430c7dfe5268a82f85522c726c3087fad97827179d181580813753c03cada2b01c824bc2a7a6fe1ee87e8a60e3c55767e85e6f13185e2636065c03c2acd936ab8011e8fbe3dddebbaa29531ce4bc96d86b3d6eb25f96bc4c2ce7a5a6b8a9ee603df0167190c86c7a534d9e186b91bc29054a8c025c3639f7a958b6e915e1620bba34b01a62149511e4785188e4137d45e0594e74b719110f8f0f1ec1292666d746d711201d79cd83f849df553c5b046026068caaf84f743bad2642bc6ffb474a796981e25010f6dea5fff72cb6bee9c6dab6946247cdf2cffbb64dee14648d99ca78b294954012078f7579d4ef1c336f23e1370018986fe6491d9c7ed55209fc146f5fce1fff501ac048cac2c154671504aeeae301ffa5c3011ea5b4d4b6bc3211966f6f0608dfc014cec80c7609349c06e9b9d7c62dbeae316670e1df3775582b8ebe7f08cc0093801c5c24a6a6b2aea4b83fd65e50e431db65792f90ab1c7ea50f6f9c5bd3878605d010bb9f262813215af39b7307edec537b473d8e8ac500ca0cb639bc5ff42a73892015a25edcd30a010402994cb4ba1f14ecc6364f650dfbc475d8c7da15be7faf2a701979c11521bdfd7a0b165ce363e84e5c86df0c7bfdb11559dad74e86d9ee3667301bc7c8f680460cba362aaa347de30631a7be4309d096e40fe543eebd4cbdbab5801801ebbfe6878a66e1b8e5f81d6d2d5e377295e35f5247a64db52aea897d7764c01cd0da6738e519b6224d1645b41751001bce3717b3f62dbebc8cf3b1623f77cfb0193f1e5d33e63f628f19afdd3345825e001686ea31480ea344f93ed07432d919b0150c91ce6341cc0fe3bc02cad8f0b0b8684f1d05467b2504efbe1df74c8dfaa48012fa21560668d441c834b239b3a487c433982a1058cc1e6f867e21cd1dadf3eff0101a928d76fb568355eb5bfd553ca2563f98bd4968d7ef2dbef96d5f7987c4d3b011725f879d0727686a6f5055a2ce0bd0ddbe611df261544fd74a3b9ede33dfef000000000'
    const orderId = '0x42823274db8845bb9e5db4c12a5e91b1f800bebb6806ee5124a7bceaa1653b13'
    const batchPayloadHash = '0x75b3f877bc2d2eb931ce77e1166651f37555f8f301aa937758b50dfb0394b82c'
    const beneficiary = '0x750791eA7092EfDF257D4711Ee811bf89eAbE2c1'

    // Append coupld of IDs to escrowGMP

    // add escrowGMP order id
    await escrowGMPContract.assignOrderer(owner.address)
    await escrowGMPContract.storeRemoteOrderPayload(orderId, batchPayloadHash)

    const tx = await claimerGMPContract.isClaimableNoPayloadStored(
      batchPayloadHash,
      batchPayload,
      orderId,
      beneficiary,
      BigNumber.from(0),
      1,
    )

    expect(tx).to.be.true
  })

  it('Should not claim of V2 batch if reverted', async function () {
    const batchPayload =
      '0x00000000000000000000000000000000000000000000000000000000000000004311ef44023db844202164ea94b74b7165374f7b2d2c4e6154f0d49d3a9248fa4311ef44023db844202164ea94b74b7165374f7b2d2c4e6154f0d49d3a9248fa00000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000008e09b00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000013e00a239f726c8b6e97ea7e4bb4282f799dd11cffd3a3d3d328ce91aaa8aaeec03c18f78dae1cdef0ea7eb9f38901859f3076413b435005c09c3f363360e9b0c92d7e1501b60a751c00a5f146215356a486cae0a0d1a6ddce169e6c107e3a7e0ed1109bbba5729205e905200a88cae4dbbae7aeb5418127ef4bca59d7d64c9e5a5bd506552d89be5697a2ba82cdfb1162e123e78f35ad4491084fbc894fbe7140073b8d6aafe1798607361b3810893c594ddd5bf9461a8e505a68c0d209daf54462cdfb1162e123e78f35ad4491084fbc894fbe71400e62d01e717a4325fce356188b5dd0d744a1cb2cda3b257e5c599c83fef71fde840baee97ecfbe84913bd47d69b933e2bc08905a100da4941f6a6e1ac93512aaa5fcf5c3a95963f3701d244b326685f39d441ba0c62587c901b8016ac848b42c85ae476109f56bcedb50000'

    const orderId = '0x5c09c3f363360e9b0c92d7e1501b60a751c00a5f146215356a486cae0a0d1a6d'
    const batchPayloadHash = ethers.utils.keccak256(batchPayload)

    const beneficiary = '0xDce169e6c107E3a7e0ed1109Bbba5729205E9052'

    // Append coupld of IDs to escrowGMP

    // add escrowGMP order id
    await escrowGMPContract.assignOrderer(owner.address)
    await escrowGMPContract.storeRemoteOrderPayload(orderId, batchPayloadHash)

    const tx = await claimerGMPContract.isClaimableNoPayloadStored(
      batchPayloadHash,
      batchPayload,
      orderId,
      beneficiary,
      BigNumber.from(0),
      1,
    )

    expect(tx).to.be.false
  })

  it('Should not claim of V2 batch if already claimed', async function () {
    const batchPayload =
      '0x00000000000000000000000000000000000000000000000000000000000000004311ef44023db844202164ea94b74b7165374f7b2d2c4e6154f0d49d3a9248fa4311ef44023db844202164ea94b74b7165374f7b2d2c4e6154f0d49d3a9248fa00000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000008e09b00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000013e00a239f726c8b6e97ea7e4bb4282f799dd11cffd3a3d3d328ce91aaa8aaeec03c18f78dae1cdef0ea7eb9f38901859f3076413b435005c09c3f363360e9b0c92d7e1501b60a751c00a5f146215356a486cae0a0d1a6ddce169e6c107e3a7e0ed1109bbba5729205e905200a88cae4dbbae7aeb5418127ef4bca59d7d64c9e5a5bd506552d89be5697a2ba82cdfb1162e123e78f35ad4491084fbc894fbe7140073b8d6aafe1798607361b3810893c594ddd5bf9461a8e505a68c0d209daf54462cdfb1162e123e78f35ad4491084fbc894fbe71400e62d01e717a4325fce356188b5dd0d744a1cb2cda3b257e5c599c83fef71fde840baee97ecfbe84913bd47d69b933e2bc08905a100da4941f6a6e1ac93512aaa5fcf5c3a95963f3701d244b326685f39d441ba0c62587c901b8016ac848b42c85ae476109f56bcedb50000'

    const orderId = '0x5c09c3f363360e9b0c92d7e1501b60a751c00a5f146215356a486cae0a0d1a6d'
    const batchPayloadHash = ethers.utils.keccak256(batchPayload)

    const beneficiary = '0xDce169e6c107E3a7e0ed1109Bbba5729205E9052'

    // Append coupld of IDs to escrowGMP

    // add escrowGMP order id
    await escrowGMPContract.assignOrderer(owner.address)
    await escrowGMPContract.storeRemoteOrderPayload(
      orderId,
      '0x0000000000000000000000000000000000000000000000000000000000000001',
    )

    const tx = await claimerGMPContract.isClaimableNoPayloadStored(
      batchPayloadHash,
      batchPayload,
      orderId,
      beneficiary,
      BigNumber.from(0),
      0,
    )

    expect(tx).to.be.false
  })

  it('Should confirm batch orders with native currency (ETH)', async function () {
    const targets = [addr1.address, addr2.address]
    const amounts = [ethers.utils.parseEther('1'), ethers.utils.parseEther('2')] // 1 ETH and 2 ETH respectively
    const assets = [ethers.constants.AddressZero, ethers.constants.AddressZero] // Using ETH as asset

    const balancesPrior = {
      addr1: await ethers.provider.getBalance(addr1.address),
      addr2: await ethers.provider.getBalance(addr2.address),
    }

    const blockTimestamp = (await ethers.provider.getBlock('latest')).timestamp
    const ids = [generateId(addr1.address, blockTimestamp), generateId(addr2.address, blockTimestamp)]

    const nonces = [blockTimestamp, blockTimestamp]
    const sourceAccounts = [addr1.address, addr2.address]
    const sources = [encodeNetworkId('sept'), encodeNetworkId('sept')]

    // Confirm the batch orders with ETH (no approval needed, just pass value with the transaction)
    await expect(
      avpBatchSubmitterContract
        .connect(owner)
        .confirmBatchOrdersV3([ids, targets, amounts, assets, nonces, sourceAccounts, sources], {
          value: ethers.utils.parseEther('3'),
        }), // sending 3 ETH (1+2 ETH)
    ).to.emit(avpBatchSubmitterContract, 'Confirmation') // Check if Confirmation event is emitted

    // Add additional checks for events or state changes (e.g., check balances)
    const balance1 = await ethers.provider.getBalance(addr1.address)
    const balance2 = await ethers.provider.getBalance(addr2.address)

    // Validate the balances after confirmation
    // Normally, you would fetch the balance before and subtract the difference
    expect(balance1).to.be.eq(balancesPrior.addr1.add(ethers.utils.parseEther('1'))) // addr1 receives 1 ETH
    expect(balance2).to.be.eq(balancesPrior.addr2.add(ethers.utils.parseEther('2'))) // addr2 receives 2 ETH
  })

  it('Should confirm batch orders with native currency (ETH) for 100 orders at once', async function () {
    const ids = []
    const targets = []
    const amounts = [] // 1 ETH and 2 ETH respectively
    const assets = [] // Using ETH as asset'
    const nonces = [] // Generated block.timestamp array
    const sources = [] // Source network bytes array

    const blockTimestamp = (await ethers.provider.getBlock('latest')).timestamp
    for (let i = 0; i < 100; i++) {
      const id = generateId(addr1.address, blockTimestamp - i)
      ids.push(id)
      targets.push(addr1.address)
      amounts.push(ethers.utils.parseEther('1'))
      assets.push(ethers.constants.AddressZero)
      nonces.push(blockTimestamp - i)
      sources.push(encodeNetworkId('sept'))
    }

    const balancesPrior = {
      addr1: await ethers.provider.getBalance(addr1.address),
    }

    const tx = await avpBatchSubmitterContract
      .connect(owner)
      .confirmBatchOrdersV3([ids, targets, amounts, assets, nonces, targets, sources], {
        value: ethers.utils.parseEther('100'),
      }) // sending 3 ETH (1+2 ETH)

    // Confirm the batch orders with ETH (no approval needed, just pass value with the transaction)
    // expect(tx).to.emit(contract, 'Confirmation') // Check if Confirmation event is emitted

    const receipt = await tx.wait()
    // Log gas used
    console.log(`Gas used: ${receipt.gasUsed.toNumber()}`)

    // Find the ExecutedBatchGasConsumed event
    const executedBatchGasConsumedEvent = receipt.events.find((event) => event.event === 'ExecutedBatchGasConsumed')
    expect(executedBatchGasConsumedEvent.args.gasConsumed.toNumber()).to.be.almost(receipt.gasUsed.toNumber(), 200_000)

    // Log the BatchConfirmation event
    const batchConfirmationEvent = receipt.events.find((e) => e.event === 'BatchConfirmation')
    console.log(`BatchConfirmation: ${batchConfirmationEvent.args}`)

    // Add additional checks for events or state changes (e.g., check balances)
    const balance1 = await ethers.provider.getBalance(addr1.address)

    // Validate the balances after confirmation
    // Normally, you would fetch the balance before and subtract the difference
    expect(balance1).to.be.eq(balancesPrior.addr1.add(ethers.utils.parseEther('100'))) // addr1 receives 1 ETH
  })
})
