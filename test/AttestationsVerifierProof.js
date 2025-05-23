/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-undef */
const { expect } = require('chai')
const { ethers, upgrades } = require('hardhat')
const ethUtil = require('ethereumjs-util')
const { keccak256 } = require('ethereumjs-util')
const { MerkleTree } = require('merkletreejs')
const { StandardMerkleTree } = require('@openzeppelin/merkle-tree')
const { formatBytes32String, hexlify } = require('ethers/lib/utils')
const { utils, Wallet, BigNumber } = require('ethers')
const { address } = require('hardhat/internal/core/config/config-validation')
const { concatBytes } = require('ethereum-cryptography/utils')
const { ecdsaSign } = require('secp256k1/lib/elliptic')
const { toCompactSig, toRpcSig } = require('ethereumjs-util/dist/signature')
const encodedEmptyBatch = '0x00000000'
const { ecsign, toBuffer, privateToPublic, keccak } = 'ethereumjs-util'
// Standardized prefix for Ethereum signed messages that has message of 32 bytes
const prefix = '\x19Ethereum Signed Message:\n32'
const prefixBuffer = Buffer.from(prefix)

async function callContractSetFn(contract, fnName, args) {
  let tx
  if (args) {
    tx = await contract[fnName](...args)
  } else {
    tx = await contract[fnName]()
  }
  const txReceipt = await tx.wait()
}

async function generateSignatures(wallets, messageHash, attestationsVerifier) {
  let signatures = []
  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i]
    const signerAddress = wallet.address
    const flatSig = await wallet.signMessage(ethers.utils.arrayify(messageHash))
    const signatureBytes = ethers.utils.arrayify(flatSig)

    // Recover the signer's address
    const recovered = await attestationsVerifier.recoverSigner(messageHash, signatureBytes)
    expect(recovered).to.equal(signerAddress)

    signatures.push(signatureBytes)
  }
  return signatures
}

function constructMerkleRoot(signers) {
  // Convert each signer to a hashed leaf.
  const leaves = signers.map((signer) => keccak256(ethUtil.toBuffer(signer)))

  // Construct the Merkle tree.
  const tree = new MerkleTree(leaves, keccak256, { sort: true })

  return tree.getRoot()
}

function constructMerkleProofs(signers) {
  // Wrap each signer in an array
  const signersArrays = signers.map((signer) => [signer])

  const tree = StandardMerkleTree.of(signersArrays, ['address'])
  // const tree = StandardMerkleTree.of(signers, Array(signers.length).fill('address'));

  // Create a Merkle tree from the leaves.
  const proofs = []

  for (const [i, v] of tree.entries()) {
    const proof = tree.getProof(i)
    proofs.push(proof)
  }

  // Create a multi proof from the leaves.
  const multiProof = tree.getMultiProof(signersArrays)

  // const verified = tree.verifyMultiProof(multiProof);

  return proofs
}

function calculateExpectedCommitteeHash(committee) {
  // Eqivalent of leaves[i] = keccak256(bytes.concat(keccak256(abi.encode(committee[i]))));
  const leaveHashes = []

  for (let i = 0; i < committee.length; i++) {
    const committeLeafString = ethers.utils.defaultAbiCoder.encode(Array(1).fill('address'), [committee[i]])

    // bytes.concat on the solidityPack result
    const committeeAsLeafBytes = concatBytes(
      // to Uint8Array
      ethers.utils.arrayify(ethers.utils.keccak256(ethUtil.toBuffer(committeLeafString))),
    )

    leaveHashes.push('0x' + keccak256(ethUtil.toBuffer(committeeAsLeafBytes)).toString('hex'))
  }

  return leaveHashes[0]
}

function constructMultiMerkleProof(signers) {
  // Wrap each signer in an array
  const signersArrays = signers.map((signer) => [signer])

  const tree = StandardMerkleTree.of(signersArrays, ['address'])
  // const tree = StandardMerkleTree.of(signers, Array(signers.length).fill('address'));

  // Create a Merkle tree from the leaves.

  const proofs = []
  const leafHashes = []
  for (const [i, v] of tree.entries()) {
    const proof = tree.getProof(i)
    leafHashes.push(tree.leafHash(v))
    proofs.push(proof)
  }

  // Create a multi proof from the leaves.
  const multiProof = tree.getMultiProof(signersArrays)

  const verified = tree.verifyMultiProof(multiProof)

  return {
    root: tree.root,
    proof: multiProof.proof,
    flags: multiProof.proofFlags,
    leaves: leafHashes,
  }
}

function getMessageHash(batch) {
  const encodedBatch = batchEncodePacked(batch)
  const messageHash = ethers.utils.keccak256(encodedBatch)
  return messageHash
}

async function parseAllEvents(receipt, contract) {
  const iface = new ethers.utils.Interface(contract.interface.format())

  const logsByTopic = {}

  for (let log of receipt.logs) {
    const parsedLog = iface.parseLog(log)

    // Ignoring event if it's not from the target contract
    if (parsedLog == null) continue

    if (logsByTopic[parsedLog.name] == null) {
      logsByTopic[parsedLog.name] = [parsedLog.valueOf().args]
    } else {
      logsByTopic[parsedLog.name].push(parsedLog.valueOf().args)
    }
  }

  return logsByTopic
}

function newEmptyBatch() {
  const batch = {
    isHalted: false,
    currentCommitteeHash: ethers.utils.id('currentCommitteeHash'),
    nextCommitteeHash: ethers.utils.id('nextCommitteeHash'),
    maybeNextCommittee: [],
    bannedCommittee: [],
    bannedStake: ethers.utils.id('bannedStake'),
    newCommitteeStake: ethers.utils.id('newCommitteeStake'),
    priceUpdates: ethers.utils.id('priceUpdates'),
    committedSfx: [],
    beneficiaries: [],
    revertedSfx: [],
    mintSfx: [],
    committedEscrowCalls: [],
    revertedEscrowCalls: [],
    index: 0,
  }
  return batch
}

function batchEncodePackedWithRawGMPMessage(batch) {
  // Encode as non-packed
  return ethers.utils.defaultAbiCoder.encode(
    ['bool', 'bytes32', 'bytes32', 'address[]', 'address[]', 'bytes', 'uint256'],
    [
      batch.isHalted,
      batch.currentCommitteeHash,
      batch.nextCommitteeHash,
      batch.maybeNextCommittee,
      batch.bannedCommittee,
      batch.encodedGMPPayload,
      batch.index,
    ],
  )
}

function batchEncodePacked(batch) {
  const encodedGMPPayload = batchEncodePackedGMP(batch)
  return ethers.utils.defaultAbiCoder.encode(
    ['bool', 'bytes32', 'bytes32', 'address[]', 'address[]', 'bytes', 'uint32'],
    [
      batch.isHalted,
      batch.currentCommitteeHash,
      batch.nextCommitteeHash,
      batch.maybeNextCommittee,
      batch.bannedCommittee,
      encodedGMPPayload,
      batch.index,
    ],
  )
}

// enum OperationType { TransferCommit, TransferRevert, CallCommit, CallRevert }

function batchEncodePackedGMP(batch) {
  let gmpBytes = '0x'
  const mockedAddressBytes = ethers.utils.solidityPack(['address'], ['0x3333333333333333333333333333333333333333'])

  batch.committedSfx.forEach((sfx, index) => {
    // encode without packed
    const nextBeneficiary = batch.beneficiaries[index] || mockedAddressBytes
    const encodedSfxTransferCommitment = ethers.utils.solidityPack(
      ['uint8', 'bytes32', 'address'],
      [0, sfx, nextBeneficiary],
    )
    gmpBytes += encodedSfxTransferCommitment.slice(2) // remove 0x
  })

  batch.revertedSfx.forEach((sfx) => {
    const encodedSfxTransferRevert = ethers.utils.solidityPack(['uint8', 'bytes32'], [1, sfx])
    gmpBytes += encodedSfxTransferRevert.slice(2) // remove 0x;
  })

  batch.committedEscrowCalls.forEach((sfx) => {
    const encodedSfxEscrowCallCommit = ethers.utils.solidityPack(['byte', 'bytes32'], [3, sfx])
    gmpBytes += encodedSfxEscrowCallCommit
  })

  batch.revertedEscrowCalls.forEach((sfx) => {
    const encodedSfxEscrowCallCRevert = ethers.utils.solidityPack(['byte', 'bytes32'], [4, sfx])
    gmpBytes += encodedSfxEscrowCallCRevert
  })

  return gmpBytes
}

function batchDecodePacked(packedBatch) {
  return ethers.utils.defaultAbiCoder.decode(
    ['uint32', 'uint32', 'uint32', 'uint32', 'address[]', 'address[]', 'bytes32[]', 'bytes32[]'],

    packedBatch,
  )
}

let escrowGMPContract

describe('AttestationsVerifierProofs', function () {
  let defaultSigner
  beforeEach(async function () {
    // get default singer
    const [signer] = await ethers.getSigners()
    defaultSigner = signer

    const EscrowGMP = await ethers.getContractFactory('EscrowGMP')
    escrowGMPContract = await upgrades.deployProxy(EscrowGMP, [signer.address], {
      initializer: 'initialize',
    })
    // Assign orderer contract to remote order caller
    await escrowGMPContract.assignOrderer(signer.address)

    await escrowGMPContract.deployed()
  })

  it('Should recover the correct signer from the signature with ethers.signMessage', async () => {
    let messageHash32b = '0x58cd0ea9f78f115b381b29bc7edaab46f214968c05ff24b6b14474e4e47cfcdd'
    // Private Key of the signer
    const privateKey = '0x0123456789012345678901234567890123456789012345678901234567890123'
    const wallet = new ethers.Wallet(privateKey)
    expect(wallet.address).to.equal('0x14791697260E4c9A71f18484C9f997B308e59325')
    const flatSig = await wallet.signMessage(ethers.utils.arrayify(messageHash32b))
    const signatureBytes = ethers.utils.arrayify(flatSig)

    expect(signatureBytes.length).to.equal(65)
    expect(flatSig).to.equal(
      '0x534dd0cbadf9a92af5d32533231af6769b3a1e479e5dde49ea4e431028a66e0a2611b13e55034973e1c5f4edcab425af4f164c5a50025204db06f439ad5e977c1c',
    )
    // Recover the signer's address
    const recovered = ethers.utils.recoverAddress(
      ethers.utils.hashMessage(ethers.utils.arrayify(messageHash32b)),
      flatSig,
    )

    expect(recovered).to.equal(wallet.address)
  })

  it('Should recover the correct signer from the signature created with signMessage', async () => {
    let messageHash32b = '0x58cd0ea9f78f115b381b29bc7edaab46f214968c05ff24b6b14474e4e47cfcdd'
    const messageWithPrefix = ethers.utils.arrayify(
      ethers.utils.keccak256(
        Buffer.concat([ethers.utils.arrayify(prefixBuffer), ethers.utils.arrayify(messageHash32b)]),
      ),
    )
    const privateKey = '0x115db6b0c74bef87e28879199e3ab3dda09ed0e7f0c3e1ff6cb92e228b221384'
    const privateKeyBuffer = Buffer.from(ethers.utils.arrayify(privateKey))
    const wallet = new ethers.Wallet(privateKey)
    expect(wallet.address).to.equal('0x3a68c6b6f010017C9b330a7C86D4B19c46ab677a')

    const flatSig = await wallet.signMessage(ethers.utils.arrayify(messageHash32b))
    expect(flatSig).to.equal(
      '0x3c20151678cbbf6c3547c5f911c613e630b0e1be11b24b6b815582db0e47801175421540c660de2a93b46e48f9ff503e5858279ba157fa9b13fbee0a8cf6806e1c',
    )

    const sigObj = ethUtil.ecsign(messageWithPrefix, privateKeyBuffer)

    const signature = ethUtil.toRpcSig(sigObj.v, sigObj.r, sigObj.s)
    expect(signature).to.equal(
      '0x3c20151678cbbf6c3547c5f911c613e630b0e1be11b24b6b815582db0e47801175421540c660de2a93b46e48f9ff503e5858279ba157fa9b13fbee0a8cf6806e1c',
    )

    // Recover the signer's address with ethers
    const recovered = ethers.utils.recoverAddress(messageWithPrefix, signature)
    expect(recovered).to.equal(wallet.address)

    // Recover the signer's address with solidity contract
    const AttestationsVerifierProofs = await ethers.getContractFactory('AttestationsVerifierProofs')
    // address[] memory initialCommittee, address[] memory nextCommittee, uint256 startingIndex, address _escrowGMP
    const attestationsVerifier = await upgrades.deployProxy(
      AttestationsVerifierProofs,
      [defaultSigner.address, [], [], 0],
      {
        initializer: 'initialize',
      },
    )
    await attestationsVerifier.deployed()

    await callContractSetFn(attestationsVerifier, 'assignEscrowGMP', [escrowGMPContract.address])

    // Contract adds prefix, so we call it without it
    const recoveredByContract = await attestationsVerifier.recoverSigner(
      ethers.utils.arrayify(messageHash32b),
      ethers.utils.arrayify(signature),
    )
    expect(recoveredByContract).to.equal(wallet.address)
  })

  it('Should recover the correct signer from the signature', async () => {
    // Replace these values with the ones used in your test case
    const privateKey = '0x0123456789012345678901234567890123456789012345678901234567890123'
    const message = 'Hello, world!'
    const messageHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(message))

    const wallet = new ethers.Wallet(privateKey)

    const AttestationsVerifierProofs = await ethers.getContractFactory('AttestationsVerifierProofs')
    const attestationsVerifier = await upgrades.deployProxy(
      AttestationsVerifierProofs,
      [defaultSigner.address, [], [], 0],
      {
        initializer: 'initialize',
      },
    )
    await attestationsVerifier.deployed()
    await callContractSetFn(attestationsVerifier, 'assignEscrowGMP', [escrowGMPContract.address])

    // Create the signature
    const flatSig = await wallet.signMessage(ethers.utils.arrayify(messageHash))
    const signatureBytes = ethers.utils.arrayify(flatSig)

    // Recover the signer's address
    const recovered = await attestationsVerifier.recoverSigner(messageHash, signatureBytes)
    const expected = ethers.utils.computeAddress(privateKey)

    expect(recovered).to.equal(expected)
  })

  it('Should recover the correct signer from the signature of initialized committee', async () => {
    const message = 'Hello, world!'
    const messageHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(message))

    const wallets = Array.from(
      {
        length: 32,
      },
      () => ethers.Wallet.createRandom(),
    )
    const [defaultSigner] = await ethers.getSigners()

    for (let i = 0; i < wallets.length; i++) {
      const tx = await defaultSigner.sendTransaction({
        to: wallets[i].address,
        value: ethers.utils.parseEther('1'),
      })
      await tx.wait()
    }

    // Create an array of addresses
    const initialCommittee = wallets.map((wallet) => wallet.address)

    const AttestationsVerifierProofs = await ethers.getContractFactory('AttestationsVerifierProofs')
    const attestationsVerifier = await upgrades.deployProxy(
      AttestationsVerifierProofs,
      [defaultSigner.address, initialCommittee, initialCommittee, 0],
      {
        initializer: 'initialize',
      },
    )
    await attestationsVerifier.deployed()
    await callContractSetFn(attestationsVerifier, 'assignEscrowGMP', [escrowGMPContract.address])

    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i]
      const signerAddress = wallet.address
      const flatSig = await wallet.signMessage(ethers.utils.arrayify(messageHash))
      const signatureBytes = ethers.utils.arrayify(flatSig)
      // Recover the signer's address
      const recovered = await attestationsVerifier.recoverSigner(messageHash, signatureBytes)
      expect(recovered).to.equal(signerAddress)
    }
  })

  it.skip('Should set the correct next committee and current committee hash', async function () {
    const currentCommittee = [
      '0x2b7A372d58541c3053793f022Cf28ef971F94EFA',
      '0x60eA580734420A9C23E51C7FdF455b5e0237E07C',
      '0x98DF91EF04A5C0695f8050B7Da4facC0E7d9444e',
      '0x3Cfbc429d7435fD5707390362c210bD272baE8eA',
      '0x66ed579D14Cbad8dFC352a3cEaeeE9711ea65e41',
      '0x786402fa462909785A55Ced48aa5682D99902C57',
      '0x401b7Cb06493eFDB82818F14f9Cd345C01463a81',
      '0xA2E7607A23B5A744A10a096c936AB033866D3bEe',
    ]

    const nextCommittee = [
      '0xac9c643B32916EA52e0fA0c3a3bBdbE120E5CA9e',
      '0xD53d6Af58A2bD8c0f86b25B1309c91f61700144F',
      '0x2feF1f5268d9732CAc331785987d45Fad487fcd6',
      '0xdebc7A55486DbaCB06985ba2415b784e05a35baE',
      '0xd7b33a07Ee05B604138f94335405b55e2b6bbFdD',
      '0x1831c8F78C8b59c1300B79E308BfBf9e4fDd13B0',
      '0x361134E27Af99A288714E428C290d48F82a4895C',
      '0x5897B47E1357eD81B2D85d8f287759502E33f588',
    ]

    const AttestationsVerifierProofs = await ethers.getContractFactory('AttestationsVerifierProofs')

    const attestationsVerifier = await AttestationsVerifierProofs.deploy(
      currentCommittee,
      nextCommittee,
      0,
      escrowGMPContract.address,
    )
    await attestationsVerifier.deployed()

    // Check that the attester is in the initial committee
    const initialCommitteeHash = await attestationsVerifier.currentCommitteeHash()

    const expectedCurrentCommitteeHash = calculateExpectedCommitteeHash(currentCommittee)
    expect(initialCommitteeHash).to.equal(expectedCurrentCommitteeHash)

    const nextCommitteeHash = await attestationsVerifier.nextCommitteeHash()
    const expectedNextCommitteeHash = calculateExpectedCommitteeHash(nextCommittee)
    expect(nextCommitteeHash).to.equal(expectedNextCommitteeHash)
  })

  function sign(message, privateKey) {
    const prefix = '\x19Ethereum Signed Message:\n32'
    const prefixBuffer = Buffer.from(prefix)
    const messageBuffer = ethUtil.toBuffer(message)
    const privateKeyUint8Array = new Uint8Array(Buffer.from(privateKey.slice(2), 'hex'))
    // Recover the signer's address
    const sigObj = ethUtil.ecsign(
      ethUtil.keccak(Buffer.concat([prefixBuffer, messageBuffer])),
      // keccak(Buffer.concat([prefixBuffer, messageBuffer])),
      privateKeyUint8Array,
    )

    // Verify
    const recovered = ethUtil.ecrecover(
      ethUtil.keccak(Buffer.concat([prefixBuffer, messageBuffer])),
      sigObj.v,
      sigObj.r,
      sigObj.s,
    )
    const recoveredAddress = ethUtil.pubToAddress(recovered).toString('hex')
    // address from wallet
    const walletAddress = ethUtil.privateToAddress(ethUtil.toBuffer(privateKey)).toString('hex')
    expect(recoveredAddress).to.equal(walletAddress)
    return toRpcSig(sigObj.v, sigObj.r, sigObj.s)
  }

  it.skip('Should process single attestation with REVERT', async function () {
    // Assign random wallet
    const signer = new Wallet('0x0123456789012345678901234567890123456789012345678901234567890123')
    const firstSigner = signer.address

    const AttestationsVerifierProofs = await ethers.getContractFactory('AttestationsVerifierProofs')

    const attestationsVerifier = await upgrades.deployProxy(
      AttestationsVerifierProofs,
      [defaultSigner.address, [firstSigner], [firstSigner], 0],
      {
        initializer: 'initialize',
      },
    )
    await attestationsVerifier.deployed()
    await callContractSetFn(attestationsVerifier, 'assignEscrowGMP', [escrowGMPContract.address])

    const _assignAttestersAddressToGMP = await escrowGMPContract.assignAttesters(attestationsVerifier.address)
    await _assignAttestersAddressToGMP.wait()
    // Check that the attester is in the initial committee
    const initialCommitteeHash = await attestationsVerifier.currentCommitteeHash()

    // Eqivalent of leaves[i] = keccak256(bytes.concat(keccak256(abi.encode(committee[i]))));
    const initialCommitteeAsLeafString = ethers.utils.defaultAbiCoder.encode(Array(1).fill('address'), [firstSigner])

    expect(initialCommitteeAsLeafString).to.equal(
      '0x000000000000000000000000' + firstSigner.slice(2).toLocaleLowerCase(),
    )

    // bytes.concat on the solidityPack result
    const initialCommitteeAsLeafBytes = concatBytes(
      // to Uint8Array
      ethers.utils.arrayify(ethers.utils.keccak256(ethUtil.toBuffer(initialCommitteeAsLeafString))),
    )

    expect(initialCommitteeHash).to.equal(
      '0x' + keccak256(ethUtil.toBuffer(initialCommitteeAsLeafBytes)).toString('hex'),
    )

    // Construct Single Attestation message
    const asSfxId = ethers.utils.id('sfx#1')
    const asRevertGMPByte = '0x01'
    const messagePayload = asRevertGMPByte + asSfxId.slice(2)
    const messagePayloadBytes = ethers.utils.solidityPack(['bytes'], [messagePayload])
    const messagePayloadHash = ethers.utils.keccak256(ethUtil.toBuffer(messagePayloadBytes))
    const source4Bytes = '0x03030303'
    const sourceHeight = 1000
    let messageHash = ethers.utils.keccak256(
      ethers.utils.solidityPack(['bytes32', 'bytes4', 'uint32'], [messagePayloadHash, source4Bytes, sourceHeight]),
    )

    let recoveredMsgHash = await attestationsVerifier.singleAttestationHash(
      messagePayloadBytes,
      source4Bytes,
      sourceHeight,
    )
    expect(recoveredMsgHash).to.equal(messageHash)

    // Store EscrowGMP initial Payload
    const storeCall = await escrowGMPContract.storeRemoteOrderPayload(asSfxId, messageHash)
    await storeCall.wait()
    const flatSigEthers = sign(messageHash, signer.privateKey)
    const flatSig = await signer.signMessage(ethUtil.toBuffer(messageHash))

    expect(flatSig).to.equal(flatSigEthers)

    // const signatureBytes = ethers.utils.arrayify(flatSig);
    const signatureBytes = ethers.utils.arrayify(flatSig)
    // Verify that the signature is correct with JS
    // Quick check if the signature is correct and signer correctly recovered
    const recovered = await attestationsVerifier.recoverSigner(messageHash, flatSig)
    expect(recovered).to.equal(firstSigner)

    const recoveredLeaves = await attestationsVerifier.recoverCurrentSigners(messageHash, [signatureBytes], [])
    expect(recoveredLeaves[0]).to.equal('0x' + keccak256(ethUtil.toBuffer(initialCommitteeAsLeafBytes)).toString('hex'))

    // Check if isAttestationApplied returns false
    const isAttestationApplied = await attestationsVerifier.isAttestationApplied(messageHash)
    expect(isAttestationApplied).to.equal(false)
    // Create multiProof
    const multiProof = constructMultiMerkleProof([firstSigner])
    await attestationsVerifier.receiveSingleAttestation(
      messagePayload, // actually reading valid singer's address works for messagePayloadHash
      source4Bytes,
      sourceHeight,
      [flatSigEthers],
      multiProof.proof,
      multiProof.flags,
    )
    const isAttestationApplied2 = await attestationsVerifier.isAttestationApplied(messageHash)
    expect(isAttestationApplied2).to.equal(true)

    const attestationPayload = await escrowGMPContract.remotePaymentsPayloadHash(asSfxId)
    expect(attestationPayload).to.equal('0x821f3c9b42b118c627d4d4c92541905311ba3c93f526ec8f9bc6404ef6cbcea4')
  })

  it.skip('Should process single attestation with COMMIT', async function () {
    // Assign random wallet
    const signer = new Wallet('0x0123456789012345678901234567890123456789012345678901234567890123')
    const firstSigner = signer.address

    const AttestationsVerifierProofs = await ethers.getContractFactory('AttestationsVerifierProofs')

    const attestationsVerifier = await upgrades.deployProxy(
      AttestationsVerifierProofs,
      [defaultSigner.address, [firstSigner], [firstSigner], 0],
      {
        initializer: 'initialize',
      },
    )
    await attestationsVerifier.deployed()
    await callContractSetFn(attestationsVerifier, 'assignEscrowGMP', [escrowGMPContract.address])

    const _assignAttestersAddressToGMP = await escrowGMPContract.assignAttesters(attestationsVerifier.address)
    await _assignAttestersAddressToGMP.wait()
    // Check that the attester is in the initial committee
    const initialCommitteeHash = await attestationsVerifier.currentCommitteeHash()

    // Eqivalent of leaves[i] = keccak256(bytes.concat(keccak256(abi.encode(committee[i]))));
    const initialCommitteeAsLeafString = ethers.utils.defaultAbiCoder.encode(Array(1).fill('address'), [firstSigner])

    expect(initialCommitteeAsLeafString).to.equal(
      '0x000000000000000000000000' + firstSigner.slice(2).toLocaleLowerCase(),
    )

    // bytes.concat on the solidityPack result
    const initialCommitteeAsLeafBytes = concatBytes(
      // to Uint8Array
      ethers.utils.arrayify(ethers.utils.keccak256(ethUtil.toBuffer(initialCommitteeAsLeafString))),
    )

    expect(initialCommitteeHash).to.equal(
      '0x' + keccak256(ethUtil.toBuffer(initialCommitteeAsLeafBytes)).toString('hex'),
    )

    // Construct Single Attestation message
    const asSfxId = ethers.utils.id('sfx#1')
    const asCommitExecutor = '0x2b7a372d58541c3053793f022cf28ef971f94efa'
    const asCommitGMPByte = '0x00'
    const messagePayload = asCommitGMPByte + asSfxId.slice(2) + asCommitExecutor.slice(2)
    const messagePayloadBytes = ethers.utils.solidityPack(['bytes'], [messagePayload])
    const messagePayloadHash = ethers.utils.keccak256(ethUtil.toBuffer(messagePayloadBytes))
    const source4Bytes = '0x03030303'
    const sourceHeight = 1000
    let messageHash = ethers.utils.keccak256(
      ethers.utils.solidityPack(['bytes32', 'bytes4', 'uint32'], [messagePayloadHash, source4Bytes, sourceHeight]),
    )

    let recoveredMsgHash = await attestationsVerifier.singleAttestationHash(
      messagePayloadBytes,
      source4Bytes,
      sourceHeight,
    )
    expect(recoveredMsgHash).to.equal(messageHash)

    // Store EscrowGMP initial Payload
    const storeCall = await escrowGMPContract.storeRemoteOrderPayload(asSfxId, messageHash)
    await storeCall.wait()
    const flatSigEthers = sign(messageHash, signer.privateKey)
    const flatSig = await signer.signMessage(ethUtil.toBuffer(messageHash))

    expect(flatSig).to.equal(flatSigEthers)

    // const signatureBytes = ethers.utils.arrayify(flatSig);
    const signatureBytes = ethers.utils.arrayify(flatSig)
    // Verify that the signature is correct with JS
    // Quick check if the signature is correct and signer correctly recovered
    const recovered = await attestationsVerifier.recoverSigner(messageHash, flatSig)
    expect(recovered).to.equal(firstSigner)

    const recoveredLeaves = await attestationsVerifier.recoverCurrentSigners(messageHash, [signatureBytes], [])
    expect(recoveredLeaves[0]).to.equal('0x' + keccak256(ethUtil.toBuffer(initialCommitteeAsLeafBytes)).toString('hex'))

    const isAttestationAppliedPrior = await attestationsVerifier.isAttestationApplied(messageHash)
    expect(isAttestationAppliedPrior).to.equal(false)

    // Create multiProof
    const multiProof = constructMultiMerkleProof([firstSigner])
    const commitmentCallResponse = await attestationsVerifier.receiveSingleAttestation(
      messagePayload, // actually reading valid singer's address works for messagePayloadHash
      source4Bytes,
      sourceHeight,
      [flatSigEthers],
      multiProof.proof,
      multiProof.flags,
    )

    const isAttestationAppliedPost = await attestationsVerifier.isAttestationApplied(messageHash)
    expect(isAttestationAppliedPost).to.equal(true)

    // Collect the receipt and check paid Gas price
    const commitmentCallReceipt = await commitmentCallResponse.wait()
    const commitmentCallGasUsed = commitmentCallReceipt.gasUsed

    const attestationPayload = await escrowGMPContract.remotePaymentsPayloadHash(asSfxId)
    expect(attestationPayload).to.equal('0xddfe659e8833b162e37f2df57f3e50847f3d94f1ac27faedca7aca0d0a4329f3')

    // Scan receipt to get the events of TransferCommitApplied and CommitmentApplied
    const logsByTopic = await parseAllEvents(commitmentCallReceipt, attestationsVerifier)

    expect(logsByTopic.TransferCommitApplied[0][0]).not.to.be.undefined
    expect(logsByTopic.CommitmentApplied[0][0]).not.to.be.undefined

    expect(logsByTopic.TransferCommitApplied[0][0]).to.equal(asSfxId)
    expect(logsByTopic.TransferCommitApplied[0][1].toLocaleLowerCase()).to.equal(asCommitExecutor)
    expect(logsByTopic.CommitmentApplied[0][0]).to.equal(messageHash)
    expect(logsByTopic.CommitmentApplied[0][1].toLocaleLowerCase()).to.equal(
      '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    ) // sender's account

    // Multiple commitments are possible but do not modify the state
    const commitmentCallResponse2 = await attestationsVerifier.receiveSingleAttestation(
      messagePayload, // actually reading valid singer's address works for messagePayloadHash
      source4Bytes,
      sourceHeight,
      [flatSigEthers],
      multiProof.proof,
      multiProof.flags,
    )
    const commitmentCallReceipt2 = await commitmentCallResponse2.wait()
    const commitmentCallGasUsed2 = commitmentCallReceipt2.gasUsed

    const isAttestationAppliedPost2 = await attestationsVerifier.isAttestationApplied(messageHash)
    expect(isAttestationAppliedPost2).to.equal(true)

    const attestationPayload2 = await escrowGMPContract.remotePaymentsPayloadHash(asSfxId)
    expect(attestationPayload2).to.equal('0xddfe659e8833b162e37f2df57f3e50847f3d94f1ac27faedca7aca0d0a4329f3')
  })

  it('Should process batch attestation message from decoded form of 240 attestations', async function () {
    // Assign random wallet
    const signer = new Wallet('0x0123456789012345678901234567890123456789012345678901234567890123')
    const firstSigner = signer.address

    const AttestationsVerifierProofs = await ethers.getContractFactory('AttestationsVerifierProofs')

    const attestationsVerifier = await upgrades.deployProxy(
      AttestationsVerifierProofs,
      [defaultSigner.address, [firstSigner], [firstSigner], 0],
      {
        initializer: 'initialize',
      },
    )

    const initialCommittee = [firstSigner]
    const nextCommittee = [firstSigner]
    await attestationsVerifier.deployed()
    await callContractSetFn(attestationsVerifier, 'assignEscrowGMP', [escrowGMPContract.address])

    const _assignAttestersAddressToGMP = await escrowGMPContract.assignAttesters(attestationsVerifier.address)
    await _assignAttestersAddressToGMP.wait()
    // Check that the attester is in the initial committee
    const initialCommitteeHash = await attestationsVerifier.currentCommitteeHash()

    // Eqivalent of leaves[i] = keccak256(bytes.concat(keccak256(abi.encode(committee[i]))));
    const initialCommitteeAsLeafString = ethers.utils.defaultAbiCoder.encode(Array(1).fill('address'), [firstSigner])

    expect(initialCommitteeAsLeafString).to.equal(
      '0x000000000000000000000000' + firstSigner.slice(2).toLocaleLowerCase(),
    )

    // bytes.concat on the solidityPack result
    const initialCommitteeAsLeafBytes = concatBytes(
      // to Uint8Array
      ethers.utils.arrayify(ethers.utils.keccak256(ethUtil.toBuffer(initialCommitteeAsLeafString))),
    )

    expect(initialCommitteeHash).to.equal(
      '0x' + keccak256(ethUtil.toBuffer(initialCommitteeAsLeafBytes)).toString('hex'),
    )

    const emptyMessageHash = ethers.utils.keccak256(ethUtil.toBuffer('0x'))
    // Store payload for 8 order ids

    let batchOf120Orders = []
    let batchOf120Beneficiaries = []

    // Generate random orders and beneficiaries
    for (let i = 0; i < 120; i++) {
      batchOf120Orders.push(ethers.utils.id('sfx#' + i))
      batchOf120Beneficiaries.push(ethers.Wallet.createRandom().address)
    }

    // Store EscrowGMP initial Payload
    for (let i = 0; i < batchOf120Orders.length; i++) {
      const storeCall = await escrowGMPContract.storeRemoteOrderPayload(batchOf120Orders[i], emptyMessageHash)
      await storeCall.wait()
    }

    let batch = newEmptyBatch()

    batch.currentCommitteeHash = keccak256(
      ethUtil.toBuffer(ethers.utils.solidityPack(Array(initialCommittee.length).fill('address'), initialCommittee)),
    )
    batch.nextCommitteeHash = keccak256(
      ethUtil.toBuffer(ethers.utils.solidityPack(Array(nextCommittee.length).fill('address'), nextCommittee)),
    )
    batch.committedSfx = batchOf120Orders
    batch.beneficiaries = batchOf120Beneficiaries

    // Construct Batch Attestation message
    const messagePayloadEncoded = batchEncodePackedGMP(batch)
    const batchPayloadEncoded = batchEncodePacked(batch)
    const batchPayloadHash = ethers.utils.keccak256(ethUtil.toBuffer(batchPayloadEncoded))

    const flatSigEthers = sign(batchPayloadHash, signer.privateKey)
    const flatSig = await signer.signMessage(ethUtil.toBuffer(batchPayloadHash))

    expect(flatSig).to.equal(flatSigEthers)

    // const signatureBytes = ethers.utils.arrayify(flatSig);
    const signatureBytes = ethers.utils.arrayify(flatSig)
    // Verify that the signature is correct with JS
    // Quick check if the signature is correct and signer correctly recovered
    const recovered = await attestationsVerifier.recoverSigner(batchPayloadHash, flatSig)
    expect(recovered).to.equal(firstSigner)

    const recoveredLeaves = await attestationsVerifier.recoverCurrentSigners(batchPayloadHash, [signatureBytes], [])
    expect(recoveredLeaves[0]).to.equal('0x' + keccak256(ethUtil.toBuffer(initialCommitteeAsLeafBytes)).toString('hex'))

    // Create multiProof
    const multiProof = constructMultiMerkleProof([firstSigner])

    const isAttestationAppliedPrior = await attestationsVerifier.isAttestationApplied(batchPayloadHash)
    expect(isAttestationAppliedPrior).to.equal(false)

    const commitmentCallResponse = await attestationsVerifier.receiveAttestationBatch(
      batchPayloadEncoded,
      messagePayloadEncoded,
      [flatSigEthers],
      multiProof.proof,
      multiProof.flags,
    )

    const isAttestationAppliedPost = await attestationsVerifier.isAttestationApplied(batchPayloadHash)
    expect(isAttestationAppliedPost).to.equal(true)

    // Collect the receipt and check paid Gas price
    const commitmentCallReceipt = await commitmentCallResponse.wait()
    const commitmentCallGasUsed = commitmentCallReceipt.gasUsed

    console.log('commitmentCallGasUsed', commitmentCallGasUsed)

    // Scan receipt to get the events of TransferCommitApplied and CommitmentApplied
    const logsByTopic = await parseAllEvents(commitmentCallReceipt, attestationsVerifier)

    expect(logsByTopic.TransferCommitApplied[0][0]).not.to.be.undefined
    expect(logsByTopic.BatchApplied[0][0]).not.to.be.undefined

    expect(logsByTopic.TransferCommitApplied[0][0]).to.equal(batchOf120Orders[0])
    expect(logsByTopic.TransferCommitApplied[0][1].toLocaleLowerCase()).to.equal(
      batchOf120Beneficiaries[0].toLocaleLowerCase(),
    )
    expect(logsByTopic.BatchApplied[0][0]).to.equal(batchPayloadHash)
    expect(logsByTopic.BatchApplied[0][1].toLocaleLowerCase()).to.equal('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266') // sender's account
  })

  it('Should process batch attestation message from decoded form of 8 attestations', async function () {
    // Assign random wallet
    const signer = new Wallet('0x0123456789012345678901234567890123456789012345678901234567890123')
    const firstSigner = signer.address

    const AttestationsVerifierProofs = await ethers.getContractFactory('AttestationsVerifierProofs')

    const attestationsVerifier = await upgrades.deployProxy(
      AttestationsVerifierProofs,
      [defaultSigner.address, [firstSigner], [firstSigner], 0],
      {
        initializer: 'initialize',
      },
    )
    await attestationsVerifier.deployed()
    await callContractSetFn(attestationsVerifier, 'assignEscrowGMP', [escrowGMPContract.address])

    const _assignAttestersAddressToGMP = await escrowGMPContract.assignAttesters(attestationsVerifier.address)
    await _assignAttestersAddressToGMP.wait()
    // Check that the attester is in the initial committee
    const initialCommitteeHash = await attestationsVerifier.currentCommitteeHash()

    // Eqivalent of leaves[i] = keccak256(bytes.concat(keccak256(abi.encode(committee[i]))));
    const initialCommitteeAsLeafString = ethers.utils.defaultAbiCoder.encode(Array(1).fill('address'), [firstSigner])

    expect(initialCommitteeAsLeafString).to.equal(
      '0x000000000000000000000000' + firstSigner.slice(2).toLocaleLowerCase(),
    )

    // bytes.concat on the solidityPack result
    const initialCommitteeAsLeafBytes = concatBytes(
      // to Uint8Array
      ethers.utils.arrayify(ethers.utils.keccak256(ethUtil.toBuffer(initialCommitteeAsLeafString))),
    )

    expect(initialCommitteeHash).to.equal(
      '0x' + keccak256(ethUtil.toBuffer(initialCommitteeAsLeafBytes)).toString('hex'),
    )

    const emptyMessageHash = ethers.utils.keccak256(ethUtil.toBuffer('0x'))
    // Store payload for 8 order ids

    const orders = [
      '0xea39875cb22b25ba782b3d2b8d5090b6ab3aeab65ce18485b8707bbcccb3f52d',
      '0x56acb91c306e23fcb6777c2d32b1526518b270679ef245cbf77a0c72c1272e50',
      '0xfb9d5b6df17043752176d11ccdc2bcfd2431656bc0e718bda67521cb38fb77fc',
      '0xed4d0a271657f01ceeea5a05d64d0d4811a3767a0efc2c686e307491bda9a75e',
      '0x9c2bf5ee9b61c50a402955efe3507a641c2532bbdaabd1641ebe460f00ee9312',
      '0x8d4e97033c364ab8b9432f57b8733e834deb0767997098c007fd6602827502da',
      '0x17d3eeb6006c52088fc298cdb4672836f26e338be443ed0f257c070d765ffc07',
      '0x31357c6f3ef5cada5252ebf2e1de7957ce19b475aaf52bb713945d2c1425241e',
    ]
    const beneficiaries = [
      '0xfA99D3ab33ED6E7cEEBb051De33dd24ec72839c4',
      '0xfA99D3ab33ED6E7cEEBb051De33dd24ec72839c4',
      '0xfA99D3ab33ED6E7cEEBb051De33dd24ec72839c4',
      '0xfA99D3ab33ED6E7cEEBb051De33dd24ec72839c4',
      '0xfA99D3ab33ED6E7cEEBb051De33dd24ec72839c4',
      '0xfA99D3ab33ED6E7cEEBb051De33dd24ec72839c4',
      '0xfA99D3ab33ED6E7cEEBb051De33dd24ec72839c4',
      '0xfA99D3ab33ED6E7cEEBb051De33dd24ec72839c4',
    ]

    // Store EscrowGMP initial Payload

    for (let i = 0; i < orders.length; i++) {
      const storeCall = await escrowGMPContract.storeRemoteOrderPayload(orders[i], emptyMessageHash)
      await storeCall.wait()
    }

    const batchPayloadEncoded =
      '0x000000000000000000000000000000000000000000000000000000000000000036e8b9292b9874e482bd09c1fe35e55e80d3cc6426303a018e50ffbead39012336e8b9292b9874e482bd09c1fe35e55e80d3cc6426303a018e50ffbead39012300000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000004060000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001a800ea39875cb22b25ba782b3d2b8d5090b6ab3aeab65ce18485b8707bbcccb3f52d00000000000000000000000000000000000000010056acb91c306e23fcb6777c2d32b1526518b270679ef245cbf77a0c72c1272e50000000000000000000000000000000000000000100fb9d5b6df17043752176d11ccdc2bcfd2431656bc0e718bda67521cb38fb77fc000000000000000000000000000000000000000100ed4d0a271657f01ceeea5a05d64d0d4811a3767a0efc2c686e307491bda9a75e0000000000000000000000000000000000000001009c2bf5ee9b61c50a402955efe3507a641c2532bbdaabd1641ebe460f00ee93120000000000000000000000000000000000000001008d4e97033c364ab8b9432f57b8733e834deb0767997098c007fd6602827502da00000000000000000000000000000000000000010017d3eeb6006c52088fc298cdb4672836f26e338be443ed0f257c070d765ffc0700000000000000000000000000000000000000010031357c6f3ef5cada5252ebf2e1de7957ce19b475aaf52bb713945d2c1425241e0000000000000000000000000000000000000001000000000000000000000000000000000000000000000000'

    const messagePayloadEncoded =
      '0x00ea39875cb22b25ba782b3d2b8d5090b6ab3aeab65ce18485b8707bbcccb3f52d00000000000000000000000000000000000000010056acb91c306e23fcb6777c2d32b1526518b270679ef245cbf77a0c72c1272e50000000000000000000000000000000000000000100fb9d5b6df17043752176d11ccdc2bcfd2431656bc0e718bda67521cb38fb77fc000000000000000000000000000000000000000100ed4d0a271657f01ceeea5a05d64d0d4811a3767a0efc2c686e307491bda9a75e0000000000000000000000000000000000000001009c2bf5ee9b61c50a402955efe3507a641c2532bbdaabd1641ebe460f00ee93120000000000000000000000000000000000000001008d4e97033c364ab8b9432f57b8733e834deb0767997098c007fd6602827502da00000000000000000000000000000000000000010017d3eeb6006c52088fc298cdb4672836f26e338be443ed0f257c070d765ffc0700000000000000000000000000000000000000010031357c6f3ef5cada5252ebf2e1de7957ce19b475aaf52bb713945d2c1425241e0000000000000000000000000000000000000001'
    const batchPayloadHash = ethers.utils.keccak256(ethUtil.toBuffer(batchPayloadEncoded))

    const flatSigEthers = sign(batchPayloadHash, signer.privateKey)
    const flatSig = await signer.signMessage(ethUtil.toBuffer(batchPayloadHash))

    expect(flatSig).to.equal(flatSigEthers)

    // const signatureBytes = ethers.utils.arrayify(flatSig);
    const signatureBytes = ethers.utils.arrayify(flatSig)
    // Verify that the signature is correct with JS
    // Quick check if the signature is correct and signer correctly recovered
    const recovered = await attestationsVerifier.recoverSigner(batchPayloadHash, flatSig)
    expect(recovered).to.equal(firstSigner)

    const recoveredLeaves = await attestationsVerifier.recoverCurrentSigners(batchPayloadHash, [signatureBytes], [])
    expect(recoveredLeaves[0]).to.equal('0x' + keccak256(ethUtil.toBuffer(initialCommitteeAsLeafBytes)).toString('hex'))

    // Create multiProof
    const multiProof = constructMultiMerkleProof([firstSigner])

    const isAttestationAppliedPrior = await attestationsVerifier.isAttestationApplied(batchPayloadHash)
    expect(isAttestationAppliedPrior).to.equal(false)

    const commitmentCallResponse = await attestationsVerifier.receiveAttestationBatch(
      batchPayloadEncoded,
      messagePayloadEncoded,
      [flatSigEthers],
      multiProof.proof,
      multiProof.flags,
    )

    const isAttestationAppliedPost = await attestationsVerifier.isAttestationApplied(batchPayloadHash)
    expect(isAttestationAppliedPost).to.equal(true)

    // Collect the receipt and check paid Gas price
    const commitmentCallReceipt = await commitmentCallResponse.wait()
    const commitmentCallGasUsed = commitmentCallReceipt.gasUsed

    // Scan receipt to get the events of TransferCommitApplied and CommitmentApplied
    const logsByTopic = await parseAllEvents(commitmentCallReceipt, attestationsVerifier)

    expect(logsByTopic.TransferCommitApplied[0][0]).not.to.be.undefined
    expect(logsByTopic.BatchApplied[0][0]).not.to.be.undefined

    expect(logsByTopic.TransferCommitApplied[0][0]).to.equal(orders[0])
    expect(logsByTopic.TransferCommitApplied[0][1].toLocaleLowerCase()).to.equal(
      '0x0000000000000000000000000000000000000001',
    )
    expect(logsByTopic.BatchApplied[0][0]).to.equal(batchPayloadHash)
    expect(logsByTopic.BatchApplied[0][1].toLocaleLowerCase()).to.equal('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266') // sender's account
  })

  it('Should fail batch attestation if one order is invalid', async function () {
    // Assign random wallet
    const signer = new Wallet('0x0123456789012345678901234567890123456789012345678901234567890123')
    const firstSigner = signer.address

    const AttestationsVerifierProofs = await ethers.getContractFactory('AttestationsVerifierProofs')

    const attestationsVerifier = await upgrades.deployProxy(
      AttestationsVerifierProofs,
      [defaultSigner.address, [firstSigner], [firstSigner], 0],
      {
        initializer: 'initialize',
      },
    )
    await attestationsVerifier.deployed()
    await callContractSetFn(attestationsVerifier, 'assignEscrowGMP', [escrowGMPContract.address])

    const _assignAttestersAddressToGMP = await escrowGMPContract.assignAttesters(attestationsVerifier.address)
    await _assignAttestersAddressToGMP.wait()
    // Check that the attester is in the initial committee
    const initialCommitteeHash = await attestationsVerifier.currentCommitteeHash()

    // Eqivalent of leaves[i] = keccak256(bytes.concat(keccak256(abi.encode(committee[i]))));
    const initialCommitteeAsLeafString = ethers.utils.defaultAbiCoder.encode(Array(1).fill('address'), [firstSigner])

    expect(initialCommitteeAsLeafString).to.equal(
      '0x000000000000000000000000' + firstSigner.slice(2).toLocaleLowerCase(),
    )

    // bytes.concat on the solidityPack result
    const initialCommitteeAsLeafBytes = concatBytes(
      // to Uint8Array
      ethers.utils.arrayify(ethers.utils.keccak256(ethUtil.toBuffer(initialCommitteeAsLeafString))),
    )

    expect(initialCommitteeHash).to.equal(
      '0x' + keccak256(ethUtil.toBuffer(initialCommitteeAsLeafBytes)).toString('hex'),
    )

    const emptyMessageHash = ethers.utils.keccak256(ethUtil.toBuffer('0x'))
    const attestations = [
      { orderId: ethers.utils.id('sfx#1'), executor: '0xfA99D3ab33ED6E7cEEBb051De33dd24ec72839c4' },
      { orderId: ethers.utils.id('sfx#2'), executor: '0x2C7A1CaAC34549ef4D6718ECCF3120AC2f74Df5C' },
      {
        orderId: '0xed4d0a271657f01ceeea5d',
        executor: '0x2C7A1CaAC34549ef4D6718ECCF3120AC2f74Df5C',
      }, // invalid order
      { orderId: ethers.utils.id('sfx#3'), executor: '0x2C7A1CaAC34549ef4D6718ECCF3120AC2f74Df5C' },
      { orderId: ethers.utils.id('sfx#4'), executor: '0x2C7A1CaAC34549ef4D6718ECCF3120AC2f74Df5C' },
    ]

    // Store EscrowGMP initial Payload
    for (let i = 0; i < attestations.length; i++) {
      if (attestations[i].orderId.length !== 66) {
        try {
          await escrowGMPContract.storeRemoteOrderPayload(attestations[i].orderId, emptyMessageHash)
          expect.fail('Expected an error but did not get one')
        } catch (error) {
          expect(error.message).to.include('incorrect data length')
        }
      } else {
        const storeCall = await escrowGMPContract.storeRemoteOrderPayload(attestations[i].orderId, emptyMessageHash)
        await storeCall.wait()
      }
    }

    let batchedMsgPayload = '0x'
    for (const attestation of attestations) {
      // all commit
      batchedMsgPayload += '00' + attestation.orderId.slice(2) + attestation.executor.slice(2)
    }

    const batchObject = {
      isHalted: false,
      currentCommitteeHash: initialCommitteeHash,
      nextCommitteeHash: initialCommitteeHash,
      maybeNextCommittee: [],
      bannedCommittee: [],
      encodedGMPPayload: batchedMsgPayload,
      index: 1,
    }

    const batchPayload = batchEncodePackedWithRawGMPMessage(batchObject)

    const batchPayloadHash = ethers.utils.keccak256(ethUtil.toBuffer(batchPayload))

    const flatSigEthers = sign(batchPayloadHash, signer.privateKey)
    const flatSig = await signer.signMessage(ethUtil.toBuffer(batchPayloadHash))

    expect(flatSig).to.equal(flatSigEthers)

    // const signatureBytes = ethers.utils.arrayify(flatSig);
    const signatureBytes = ethers.utils.arrayify(flatSig)
    // Verify that the signature is correct with JS
    // Quick check if the signature is correct and signer correctly recovered
    const recovered = await attestationsVerifier.recoverSigner(batchPayloadHash, flatSig)
    expect(recovered).to.equal(firstSigner)

    const recoveredLeaves = await attestationsVerifier.recoverCurrentSigners(batchPayloadHash, [signatureBytes], [])
    expect(recoveredLeaves[0]).to.equal('0x' + keccak256(ethUtil.toBuffer(initialCommitteeAsLeafBytes)).toString('hex'))

    // Create multiProof
    const multiProof = constructMultiMerkleProof([firstSigner])

    const isAttestationAppliedPrior = await attestationsVerifier.isAttestationApplied(batchPayloadHash)
    expect(isAttestationAppliedPrior).to.equal(false)

    try {
      await attestationsVerifier.receiveAttestationBatch(
        batchPayload,
        batchedMsgPayload,
        [flatSigEthers],
        multiProof.proof,
        multiProof.flags,
        {
          gasLimit: BigNumber.from(2000000),
          maxFeePerGas: BigNumber.from(321857938),
          maxPriorityFeePerGas: BigNumber.from(321857938),
          nonce: 11,
          type: 0,
          value: null,
        },
      )
      expect.fail('Expected an error but did not get one')
    } catch (error) {
      // getting VM Exception while processing transaction: reverted with panic code 0x21 (Tried to convert a value into an enum, but the value was too big or negative)
      // this is because of value: null
      // but if we assign any BigNumber value to it, we get non-payable method cannot override value
      expect(error.message).not.to.be.undefined
    }
  })

  it('Should process batch attestation message with COMMIT', async function () {
    // Assign random wallet
    const signer = new Wallet('0x0123456789012345678901234567890123456789012345678901234567890123')
    const firstSigner = signer.address

    const AttestationsVerifierProofs = await ethers.getContractFactory('AttestationsVerifierProofs')

    const attestationsVerifier = await upgrades.deployProxy(
      AttestationsVerifierProofs,
      [defaultSigner.address, [firstSigner], [firstSigner], 0],
      {
        initializer: 'initialize',
      },
    )
    await attestationsVerifier.deployed()
    await callContractSetFn(attestationsVerifier, 'assignEscrowGMP', [escrowGMPContract.address])

    const _assignAttestersAddressToGMP = await escrowGMPContract.assignAttesters(attestationsVerifier.address)
    await _assignAttestersAddressToGMP.wait()
    // Check that the attester is in the initial committee
    const initialCommitteeHash = await attestationsVerifier.currentCommitteeHash()

    // Eqivalent of leaves[i] = keccak256(bytes.concat(keccak256(abi.encode(committee[i]))));
    const initialCommitteeAsLeafString = ethers.utils.defaultAbiCoder.encode(Array(1).fill('address'), [firstSigner])

    expect(initialCommitteeAsLeafString).to.equal(
      '0x000000000000000000000000' + firstSigner.slice(2).toLocaleLowerCase(),
    )

    // bytes.concat on the solidityPack result
    const initialCommitteeAsLeafBytes = concatBytes(
      // to Uint8Array
      ethers.utils.arrayify(ethers.utils.keccak256(ethUtil.toBuffer(initialCommitteeAsLeafString))),
    )

    expect(initialCommitteeHash).to.equal(
      '0x' + keccak256(ethUtil.toBuffer(initialCommitteeAsLeafBytes)).toString('hex'),
    )

    // Construct Single Attestation message
    const asSfxId = ethers.utils.id('sfx#1')
    const asCommitExecutor = '0x2b7a372d58541c3053793f022cf28ef971f94efa'
    const asCommitGMPByte = '0x00'
    const messagePayload = asCommitGMPByte + asSfxId.slice(2) + asCommitExecutor.slice(2)
    const messagePayloadBytes = ethers.utils.solidityPack(['bytes'], [messagePayload])
    const messagePayloadHash = ethers.utils.keccak256(ethUtil.toBuffer(messagePayloadBytes))
    const source4Bytes = '0x03030303'
    const sourceHeight = 1000
    let messageHash = ethers.utils.keccak256(
      ethers.utils.solidityPack(['bytes32', 'bytes4', 'uint32'], [messagePayloadHash, source4Bytes, sourceHeight]),
    )

    let recoveredMsgHash = await attestationsVerifier.singleAttestationHash(
      messagePayloadBytes,
      source4Bytes,
      sourceHeight,
    )
    expect(recoveredMsgHash).to.equal(messageHash)

    // Store EscrowGMP initial Payload
    const storeCall = await escrowGMPContract.storeRemoteOrderPayload(asSfxId, messageHash)
    await storeCall.wait()

    // Constructing the Batch struct
    let batch = {
      is_halted: false,
      currentCommitteeHash: initialCommitteeHash,
      nextCommitteeHash: initialCommitteeHash,
      maybeNextCommittee: [],
      bannedCommittee: [],
      encodedGMPPayload: messagePayload,
      index: 1,
    }
    const batchPayload = batchEncodePackedWithRawGMPMessage(batch)
    const batchPayloadHash = ethers.utils.keccak256(ethUtil.toBuffer(batchPayload))

    const flatSigEthers = sign(batchPayloadHash, signer.privateKey)
    const flatSig = await signer.signMessage(ethUtil.toBuffer(batchPayloadHash))

    expect(flatSig).to.equal(flatSigEthers)

    // const signatureBytes = ethers.utils.arrayify(flatSig);
    const signatureBytes = ethers.utils.arrayify(flatSig)
    // Verify that the signature is correct with JS
    // Quick check if the signature is correct and signer correctly recovered
    const recovered = await attestationsVerifier.recoverSigner(batchPayloadHash, flatSig)
    expect(recovered).to.equal(firstSigner)

    const recoveredLeaves = await attestationsVerifier.recoverCurrentSigners(batchPayloadHash, [signatureBytes], [])
    expect(recoveredLeaves[0]).to.equal('0x' + keccak256(ethUtil.toBuffer(initialCommitteeAsLeafBytes)).toString('hex'))

    // Create multiProof
    const multiProof = constructMultiMerkleProof([firstSigner])

    const isAttestationAppliedPrior = await attestationsVerifier.isAttestationApplied(batchPayloadHash)
    expect(isAttestationAppliedPrior).to.equal(false)

    const attestationPayloadPrior = await escrowGMPContract.remotePaymentsPayloadHash(asSfxId)

    const commitmentCallResponse = await attestationsVerifier.receiveAttestationBatch(
      batchPayload,
      messagePayload,
      [flatSigEthers],
      multiProof.proof,
      multiProof.flags,
    )

    const isAttestationAppliedPost = await attestationsVerifier.isAttestationApplied(batchPayloadHash)
    expect(isAttestationAppliedPost).to.equal(true)

    // Collect the receipt and check paid Gas price
    const commitmentCallReceipt = await commitmentCallResponse.wait()
    const commitmentCallGasUsed = commitmentCallReceipt.gasUsed

    const attestationPayload = await escrowGMPContract.remotePaymentsPayloadHash(asSfxId)
    expect(attestationPayloadPrior).to.not.equal(attestationPayload)
    expect(attestationPayload).to.equal('0x03c09cf0e8ccf068c88bd729f9a9acee327d7de5032b8f9b12d1f7d07a584b14')

    // Scan receipt to get the events of TransferCommitApplied and CommitmentApplied
    const logsByTopic = await parseAllEvents(commitmentCallReceipt, attestationsVerifier)

    expect(logsByTopic.TransferCommitApplied[0][0]).not.to.be.undefined
    expect(logsByTopic.BatchApplied[0][0]).not.to.be.undefined

    expect(logsByTopic.TransferCommitApplied[0][0]).to.equal(asSfxId)
    expect(logsByTopic.TransferCommitApplied[0][1].toLocaleLowerCase()).to.equal(asCommitExecutor)
    expect(logsByTopic.BatchApplied[0][0]).to.equal(batchPayloadHash)
    expect(logsByTopic.BatchApplied[0][1].toLocaleLowerCase()).to.equal('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266') // sender's account

    // Multiple commitments are possible but do not modify the state
    const commitmentCallResponse2 = await attestationsVerifier.receiveAttestationBatch(
      batchPayload,
      messagePayload,
      [flatSigEthers],
      multiProof.proof,
      multiProof.flags,
    )
    const commitmentCallReceipt2 = await commitmentCallResponse2.wait()
    const commitmentCallGasUsed2 = commitmentCallReceipt2.gasUsed

    const isAttestationAppliedPost2 = await attestationsVerifier.isAttestationApplied(batchPayloadHash)
    expect(isAttestationAppliedPost2).to.equal(true)

    const attestationPayload2 = await escrowGMPContract.remotePaymentsPayloadHash(asSfxId)
    expect(attestationPayload2).to.equal('0x03c09cf0e8ccf068c88bd729f9a9acee327d7de5032b8f9b12d1f7d07a584b14')
  })

  it.skip('Should produces the correct message hash for filled batch', async function () {
    const nextCommittee = [
      '0x2b7A372d58541c3053793f022Cf28ef971F94EFA',
      '0x60eA580734420A9C23E51C7FdF455b5e0237E07C',
      '0x98DF91EF04A5C0695f8050B7Da4facC0E7d9444e',
      '0x3Cfbc429d7435fD5707390362c210bD272baE8eA',
      '0x66ed579D14Cbad8dFC352a3cEaeeE9711ea65e41',
      '0x786402fa462909785A55Ced48aa5682D99902C57',
      '0x401b7Cb06493eFDB82818F14f9Cd345C01463a81',
      '0xA2E7607A23B5A744A10a096c936AB033866D3bEe',
      '0xac9c643B32916EA52e0fA0c3a3bBdbE120E5CA9e',
      '0xD53d6Af58A2bD8c0f86b25B1309c91f61700144F',
      '0x2feF1f5268d9732CAc331785987d45Fad487fcd6',
      '0xdebc7A55486DbaCB06985ba2415b784e05a35baE',
      '0xd7b33a07Ee05B604138f94335405b55e2b6bbFdD',
      '0x1831c8F78C8b59c1300B79E308BfBf9e4fDd13B0',
      '0x361134E27Af99A288714E428C290d48F82a4895C',
      '0x5897B47E1357eD81B2D85d8f287759502E33f588',
      '0xa880bf7e031ed87d422D31BEBcC9D0339c7b95b4',
      '0xedaB03983D839E6A3a887c3Ee711a724391F8eE1',
      '0x80D80649e13268382ceA3b0a56a57078c2076fE1',
      '0xb0DE4907432a9A4aC92F4988dAa6024CD57D1b27',
      '0x5449D051328dA4cfE8d1eFe7481Ff3B690cF8696',
      '0x4705522d19458a90F06a15d9836A64e45c182c9f',
      '0xB6dE743a22A7A43Edda8b5E21E2f0Aeb70354f5B',
      '0x970c0720316BC03Cd055C5Ec74208Fe0BA3d3c44',
      '0x7905754a5B6A28D1EDf338d9Be06a49aD60D74b6',
      '0x93054A6f5eb0E1978D1e3e27AE758F17480E5988',
      '0xa185b4f947A09286FC028B034f01bAbe53d98301',
      '0x14C74Ce14e833d76dC0190651C0EbA64f3E67c79',
      '0x861fa47e5229C9079d087D6354C1Ede95D233F43',
      '0x6f9925AceFfbe67742257abFf393B123010c4A10',
      '0xA1Ea906c54379032c9857139C6f796Acf88dDb79',
      '0x6219f12779268F8A7ddf0f1E44Fd75253219d639',
    ]

    const committedSfx = [ethers.utils.id('sfx#1'), ethers.utils.id('sfx#2'), ethers.utils.id('sfx#3')]
    const revertedSfx = [ethers.utils.id('sfx#4'), ethers.utils.id('sfx#5')]

    // Constructing the Batch struct
    let batch = {
      currentCommitteeHash: keccak256(
        ethUtil.toBuffer(ethers.utils.solidityPack(Array(nextCommittee.length).fill('address'), nextCommittee)),
      ),
      nextCommitteeHash: keccak256(
        ethUtil.toBuffer(ethers.utils.solidityPack(Array(nextCommittee.length).fill('address'), nextCommittee)),
      ),
      bannedCommittee: [nextCommittee[0], nextCommittee[1], nextCommittee[2]],
      bannedStake: committedSfx,
      revertedSfx,
      index: 1,
    }

    // Encoding the Batch struct
    const encodedBatchMessage = batchEncodePacked(batch)

    // Hashing the encoded Batch struct
    const batchMessageHash = ethers.utils.keccak256(encodedBatchMessage)

    let expectedMessage =
      '0x0000000000000000000000002b7a372d58541c3053793f022cf28ef971f94efa00000000000000000000000060ea580734420a9c23e51c7fdf455b5e0237e07c00000000000000000000000098df91ef04a5c0695f8050b7da4facc0e7d9444e0000000000000000000000003cfbc429d7435fd5707390362c210bd272bae8ea00000000000000000000000066ed579d14cbad8dfc352a3ceaeee9711ea65e41000000000000000000000000786402fa462909785a55ced48aa5682d99902c57000000000000000000000000401b7cb06493efdb82818f14f9cd345c01463a81000000000000000000000000a2e7607a23b5a744a10a096c936ab033866d3bee000000000000000000000000ac9c643b32916ea52e0fa0c3a3bbdbe120e5ca9e000000000000000000000000d53d6af58a2bd8c0f86b25b1309c91f61700144f0000000000000000000000002fef1f5268d9732cac331785987d45fad487fcd6000000000000000000000000debc7a55486dbacb06985ba2415b784e05a35bae000000000000000000000000d7b33a07ee05b604138f94335405b55e2b6bbfdd0000000000000000000000001831c8f78c8b59c1300b79e308bfbf9e4fdd13b0000000000000000000000000361134e27af99a288714e428c290d48f82a4895c0000000000000000000000005897b47e1357ed81b2d85d8f287759502e33f588000000000000000000000000a880bf7e031ed87d422d31bebcc9d0339c7b95b4000000000000000000000000edab03983d839e6a3a887c3ee711a724391f8ee100000000000000000000000080d80649e13268382cea3b0a56a57078c2076fe1000000000000000000000000b0de4907432a9a4ac92f4988daa6024cd57d1b270000000000000000000000005449d051328da4cfe8d1efe7481ff3b690cf86960000000000000000000000004705522d19458a90f06a15d9836a64e45c182c9f000000000000000000000000b6de743a22a7a43edda8b5e21e2f0aeb70354f5b000000000000000000000000970c0720316bc03cd055c5ec74208fe0ba3d3c440000000000000000000000007905754a5b6a28d1edf338d9be06a49ad60d74b600000000000000000000000093054a6f5eb0e1978d1e3e27ae758f17480e5988000000000000000000000000a185b4f947a09286fc028b034f01babe53d9830100000000000000000000000014c74ce14e833d76dc0190651c0eba64f3e67c79000000000000000000000000861fa47e5229c9079d087d6354c1ede95d233f430000000000000000000000006f9925aceffbe67742257abff393b123010c4a10000000000000000000000000a1ea906c54379032c9857139c6f796acf88ddb790000000000000000000000006219f12779268f8a7ddf0f1e44fd75253219d6390000000000000000000000002b7a372d58541c3053793f022cf28ef971f94efa00000000000000000000000060ea580734420a9c23e51c7fdf455b5e0237e07c00000000000000000000000098df91ef04a5c0695f8050b7da4facc0e7d9444e6e906f8388de8faea67a770476ade4b76654545002126aa3ea17890fd8acdd7e580032f247eebb5c75889ab42c43dd88a1071c3950f9bbab1f901c47d5331dfae23ab05c5ca561870b6f55d3fcb94ead2b14d8ce49ccf159b8e3449cbd5050c6ff17743a6b48933b94f38f423b15b2fc9ebcd34aab19bd81c2a69d3d052f467f21e5cd2c2f3e32ac4a52543a386821b079711432c2fefd4be3836ed36d129b1100000001'

    expect(encodedBatchMessage).to.equal(expectedMessage)
    expect(batchMessageHash).to.equal('0x92689b8b6360ba49e99b694643ba4c7fedb658496665252ab6de5aed79520a8c')

    const AttestationsVerifierProofs = await ethers.getContractFactory('AttestationsVerifierProofs')
    const attestationsVerifier = await AttestationsVerifierProofs.deploy([], [], 0, escrowGMPContract.address)
    await attestationsVerifier.deployed()

    let txEncodedBatchOutput = await attestationsVerifier.batchEncodePacked(batch)
    expect(txEncodedBatchOutput).to.equal(encodedBatchMessage)
  })

  it.skip('test_index_and_next_committee_only_message_produces_expected_hash', async function () {
    const nextCommittee = [
      '0x2b7A372d58541c3053793f022Cf28ef971F94EFA',
      '0x60eA580734420A9C23E51C7FdF455b5e0237E07C',
      '0x98DF91EF04A5C0695f8050B7Da4facC0E7d9444e',
      '0x3Cfbc429d7435fD5707390362c210bD272baE8eA',
      '0x66ed579D14Cbad8dFC352a3cEaeeE9711ea65e41',
      '0x786402fa462909785A55Ced48aa5682D99902C57',
      '0x401b7Cb06493eFDB82818F14f9Cd345C01463a81',
      '0xA2E7607A23B5A744A10a096c936AB033866D3bEe',
      '0xac9c643B32916EA52e0fA0c3a3bBdbE120E5CA9e',
      '0xD53d6Af58A2bD8c0f86b25B1309c91f61700144F',
      '0x2feF1f5268d9732CAc331785987d45Fad487fcd6',
      '0xdebc7A55486DbaCB06985ba2415b784e05a35baE',
      '0xd7b33a07Ee05B604138f94335405b55e2b6bbFdD',
      '0x1831c8F78C8b59c1300B79E308BfBf9e4fDd13B0',
      '0x361134E27Af99A288714E428C290d48F82a4895C',
      '0x5897B47E1357eD81B2D85d8f287759502E33f588',
      '0xa880bf7e031ed87d422D31BEBcC9D0339c7b95b4',
      '0xedaB03983D839E6A3a887c3Ee711a724391F8eE1',
      '0x80D80649e13268382ceA3b0a56a57078c2076fE1',
      '0xb0DE4907432a9A4aC92F4988dAa6024CD57D1b27',
      '0x5449D051328dA4cfE8d1eFe7481Ff3B690cF8696',
      '0x4705522d19458a90F06a15d9836A64e45c182c9f',
      '0xB6dE743a22A7A43Edda8b5E21E2f0Aeb70354f5B',
      '0x970c0720316BC03Cd055C5Ec74208Fe0BA3d3c44',
      '0x7905754a5B6A28D1EDf338d9Be06a49aD60D74b6',
      '0x93054A6f5eb0E1978D1e3e27AE758F17480E5988',
      '0xa185b4f947A09286FC028B034f01bAbe53d98301',
      '0x14C74Ce14e833d76dC0190651C0EbA64f3E67c79',
      '0x861fa47e5229C9079d087D6354C1Ede95D233F43',
      '0x6f9925AceFfbe67742257abFf393B123010c4A10',
      '0xA1Ea906c54379032c9857139C6f796Acf88dDb79',
      '0x6219f12779268F8A7ddf0f1E44Fd75253219d639',
    ]

    let batch = newEmptyBatch()
    // Constructing the Batch struct
    batch.currentCommitteeHash = keccak256(
      ethUtil.toBuffer(ethers.utils.solidityPack(Array(nextCommittee.length).fill('address'), nextCommittee)),
    )
    batch.nextCommitteeHash = keccak256(
      ethUtil.toBuffer(ethers.utils.solidityPack(Array(nextCommittee.length).fill('address'), nextCommittee)),
    )
    batch.index = 1

    // Encoding the Batch struct
    const encodedBatchMessage = batchEncodePacked(batch)

    // Hashing the encoded Batch struct
    const batchMessageHash = ethers.utils.keccak256(encodedBatchMessage)

    let expectedMessage =
      '0x0000000000000000000000002b7a372d58541c3053793f022cf28ef971f94efa00000000000000000000000060ea580734420a9c23e51c7fdf455b5e0237e07c00000000000000000000000098df91ef04a5c0695f8050b7da4facc0e7d9444e0000000000000000000000003cfbc429d7435fd5707390362c210bd272bae8ea00000000000000000000000066ed579d14cbad8dfc352a3ceaeee9711ea65e41000000000000000000000000786402fa462909785a55ced48aa5682d99902c57000000000000000000000000401b7cb06493efdb82818f14f9cd345c01463a81000000000000000000000000a2e7607a23b5a744a10a096c936ab033866d3bee000000000000000000000000ac9c643b32916ea52e0fa0c3a3bbdbe120e5ca9e000000000000000000000000d53d6af58a2bd8c0f86b25b1309c91f61700144f0000000000000000000000002fef1f5268d9732cac331785987d45fad487fcd6000000000000000000000000debc7a55486dbacb06985ba2415b784e05a35bae000000000000000000000000d7b33a07ee05b604138f94335405b55e2b6bbfdd0000000000000000000000001831c8f78c8b59c1300b79e308bfbf9e4fdd13b0000000000000000000000000361134e27af99a288714e428c290d48f82a4895c0000000000000000000000005897b47e1357ed81b2d85d8f287759502e33f588000000000000000000000000a880bf7e031ed87d422d31bebcc9d0339c7b95b4000000000000000000000000edab03983d839e6a3a887c3ee711a724391f8ee100000000000000000000000080d80649e13268382cea3b0a56a57078c2076fe1000000000000000000000000b0de4907432a9a4ac92f4988daa6024cd57d1b270000000000000000000000005449d051328da4cfe8d1efe7481ff3b690cf86960000000000000000000000004705522d19458a90f06a15d9836a64e45c182c9f000000000000000000000000b6de743a22a7a43edda8b5e21e2f0aeb70354f5b000000000000000000000000970c0720316bc03cd055c5ec74208fe0ba3d3c440000000000000000000000007905754a5b6a28d1edf338d9be06a49ad60d74b600000000000000000000000093054a6f5eb0e1978d1e3e27ae758f17480e5988000000000000000000000000a185b4f947a09286fc028b034f01babe53d9830100000000000000000000000014c74ce14e833d76dc0190651c0eba64f3e67c79000000000000000000000000861fa47e5229c9079d087d6354c1ede95d233f430000000000000000000000006f9925aceffbe67742257abff393b123010c4a10000000000000000000000000a1ea906c54379032c9857139c6f796acf88ddb790000000000000000000000006219f12779268f8a7ddf0f1e44fd75253219d63900000001'

    expect(encodedBatchMessage).to.equal(expectedMessage)
    expect(batchMessageHash).to.equal('0x571e2e5fc34e6563ebadfc86189cc1b665cefe590fd8015e7d5f3759aaf39ff5')

    const AttestationsVerifierProofs = await ethers.getContractFactory('AttestationsVerifierProofs')
    const attestationsVerifier = await AttestationsVerifierProofs.deploy([], [], 0, escrowGMPContract.address)
    await attestationsVerifier.deployed()

    let txEncodedBatchOutput = await attestationsVerifier.batchEncodePacked(batch)
    expect(txEncodedBatchOutput).to.equal(encodedBatchMessage)
  })

  it.skip('Should initialize committee and verify signatures for empty batch', async function () {
    const wallets = Array.from(
      {
        length: 32,
      },
      () => ethers.Wallet.createRandom(),
    )
    const [defaultSigner] = await ethers.getSigners()

    for (let i = 0; i < wallets.length; i++) {
      const tx = await defaultSigner.sendTransaction({
        to: wallets[i].address,
        value: ethers.utils.parseEther('1'),
      })
      await tx.wait()
    }

    // Create an array of addresses
    const initialCommittee = wallets.map((wallet) => wallet.address)

    const AttestationsVerifierProofs = await ethers.getContractFactory('AttestationsVerifierProofs')
    const attestationsVerifier = await AttestationsVerifierProofs.deploy(
      initialCommittee,
      initialCommittee,
      0,
      escrowGMPContract.address,
    )
    await attestationsVerifier.deployed()

    // Constructing the Batch struct with empty arrays
    let batch = newEmptyBatch()

    // Encoding the Batch struct
    const encodedBatchMessage = batchEncodePacked(batch)
    // Hashing the encoded Batch struct
    const batchMessageHash = ethers.utils.keccak256(encodedBatchMessage)

    const signatures = []

    // Pre-check for the validity of signature before sending the batch message
    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i]
      const signerAddress = wallet.address
      const flatSig = await wallet.signMessage(ethers.utils.arrayify(batchMessageHash))
      const signatureBytes = ethers.utils.arrayify(flatSig)
      // Recover the signer's address
      const recovered = await attestationsVerifier.recoverSigner(batchMessageHash, signatureBytes)
      expect(recovered).to.equal(signerAddress)
      signatures.push(signatureBytes)
    }

    // Send the batch message
    let tx = await attestationsVerifier.receiveAttestationBatch(
      batch.currentCommitteeHash,
      batch.nextCommitteeHash,
      batch.bannedCommittee,
      batch.committedSfx,
      batch.revertedSfx,
      batch.index,
      batchMessageHash,
      signatures,
      constructMerkleProofs([]),
    )

    // Wait for the transaction to be mined and get the logs
    const receipt = await tx.wait()

    let allEvents = await parseAllEvents(receipt, attestationsVerifier)
    // Get the SignerEmitted events from the logs

    // Check that the correct addresses and indexes were emitted
    const parsedBatchAppliedEvents = allEvents['BatchApplied']
    expect(parsedBatchAppliedEvents.length).to.equal(1)
  })

  it.skip('Should initialize committee and verify signatures for full batch', async function () {
    const wallets = Array.from(
      {
        length: 8,
      },
      () => ethers.Wallet.createRandom(),
    )
    const wallets_next_committee = Array.from(
      {
        length: 8,
      },
      () => ethers.Wallet.createRandom(),
    )

    const [defaultSigner] = await ethers.getSigners()

    for (let i = 0; i < wallets.length; i++) {
      const tx = await defaultSigner.sendTransaction({
        to: wallets[i].address,
        value: ethers.utils.parseEther('1'),
      })
      await tx.wait()
    }
    // Create an array of addresses
    const initialCommittee = wallets.map((wallet) => wallet.address)
    const nextCommittee = wallets_next_committee.map((wallet) => wallet.address)

    const bannedCommittee = [nextCommittee[0], nextCommittee[1], nextCommittee[2]]

    const committedSfx = [ethers.utils.id('sfx#1'), ethers.utils.id('sfx#2'), ethers.utils.id('sfx#3')]

    const AttestationsVerifierProofs = await ethers.getContractFactory('AttestationsVerifierProofs')

    const attestationsVerifier = await AttestationsVerifierProofs.deploy(
      initialCommittee,
      initialCommittee,
      0,
      escrowGMPContract.address,
    )
    await attestationsVerifier.deployed()

    const _assignAttestersAddressToGMP = await escrowGMPContract.assignAttesters(attestationsVerifier.address)

    let batch = newEmptyBatch()

    batch.currentCommitteeHash = keccak256(
      ethUtil.toBuffer(ethers.utils.solidityPack(Array(initialCommittee.length).fill('address'), initialCommittee)),
    )
    batch.nextCommitteeHash = keccak256(
      ethUtil.toBuffer(ethers.utils.solidityPack(Array(nextCommittee.length).fill('address'), nextCommittee)),
    )
    batch.bannedCommittee = bannedCommittee
    batch.committedSfx = committedSfx

    // Encoding the Batch struct
    const encodedBatchMessage = batchEncodePacked(batch)
    const encodedBatchMessageGMP = batchEncodePackedGMP(batch)

    for (let sfxId in batch.committedSfx) {
      await escrowGMPContract.storeRemoteOrderPayload(formatBytes32String(sfxId), formatBytes32String('payload'))
    }
    for (let sfxId in batch.revertedSfx) {
      await escrowGMPContract.storeRemoteOrderPayload(formatBytes32String(sfxId), formatBytes32String('payload'))
    }

    // Verify that the batch message decodes correctly
    let txDecode = await attestationsVerifier.decodeAndProcessPayload(encodedBatchMessageGMP)
    let out = txDecode

    // Hashing the encoded Batch struct
    const messageHash = ethers.utils.keccak256(encodedBatchMessage)
    const signatures = await generateSignatures(wallets, messageHash, attestationsVerifier)

    signatures.forEach((sig) => console.log('"' + ethers.utils.hexlify(sig) + '",'))
    // Send the batch message
    let tx = await attestationsVerifier.receiveAttestationBatch(
      constructMerkleRoot(initialCommittee),
      batch.nextCommitteeHash,
      batch.bannedCommittee,
      batch.committedSfx,
      batch.revertedSfx,
      batch.index,
      messageHash,
      signatures,
      constructMerkleProofs(initialCommittee),
    )

    let multiProofData = constructMultiMerkleProof(initialCommittee)

    let txTest = await attestationsVerifier.verifySignaturesTest(
      messageHash,
      signatures,
      multiProofData.proof,
      multiProofData.flags,
    )
    // let tx = await attestationsVerifier.receiveAttestationBatch(multiProofData.root, batch.nextCommitteeHash, batch.index, batchPayload, signatures, multiProofData.proof, multiProofData.flags);

    // Wait for the transaction to be mined and get the logs
    const receipt = await txTest.wait()
    const output = receipt.logs[0].topics

    // let allEvents = await parseAllEvents(receipt, attestationsVerifier);
    //
    // Get the SignerEmitted events from the logs

    // Check that the correct addresses and indexes were emitted
    const parsedBatchAppliedEvents = allEvents['BatchApplied']
    expect(parsedBatchAppliedEvents.length).to.equal(1)
  })

  describe.skip('AttestationsCommittee', function () {
    beforeEach(async () => {
      this.timeout(10000)
      // generate wallets for committees
      committeeSize = 32
      committees = {
        0: generateWallets(committeeSize),
        1: generateWallets(committeeSize),
        2: generateWallets(committeeSize),
        3: generateWallets(committeeSize),
      }

      index = 0

      // initialize contract
      const AttestationsVerifierProofs = await ethers.getContractFactory('AttestationsVerifierProofs')
      attestationsVerifier = await AttestationsVerifierProofs.deploy(
        committees[index].map((wallet) => wallet.address),
        committees[index].map((wallet) => wallet.address),
        index,
        escrowGMPContract.address,
      )
      await attestationsVerifier.deployed()

      // default asserts
      const initialCommitteeSize = await attestationsVerifier.committeeSize()
      expect(initialCommitteeSize).to.equal(32)

      expect(await attestationsVerifier.currentCommitteeTransitionCount()).to.equal(1)
    })

    it('should correctly calculate committeeSize', async function () {
      index++
      await sendBatch(attestationsVerifier, index, committees[index - 1], committees[index])

      let nextCommitteeSize = await attestationsVerifier.committeeSize()
      expect(nextCommitteeSize.toNumber()).to.equal(32)
    })

    it('should only keep the current committee without old members', async function () {
      index++
      await sendBatch(attestationsVerifier, index, committees[index - 1], committees[index])

      let nextCommitteeSize = await attestationsVerifier.committeeSize()
      expect(nextCommitteeSize.toNumber()).to.equal(32)
      expect(await attestationsVerifier.currentCommitteeTransitionCount()).to.equal(2)

      for (let i = 0; i < nextCommitteeSize; i++) {
        let currentCommitteeMemberIndex = await attestationsVerifier.attestersIndices(committees[index][i].address)
        expect(currentCommitteeMemberIndex).to.equal(2)
      }
      expect(await attestationsVerifier.totalAttesters()).to.equal(64)
    })

    it('should correctly process consecutive batches', async function () {
      // first batch
      index = 1
      await sendBatch(attestationsVerifier, index, committees[index - 1], committees[index])

      for (let i = 0; i < committeeSize; i++) {
        let currentCommitteeMemberIndex = await attestationsVerifier.attestersIndices(committees[index][i].address)
        expect(currentCommitteeMemberIndex).to.equal(index + 1)
      }
      expect(await attestationsVerifier.currentCommitteeTransitionCount()).to.equal(index + 1)
      expect(await attestationsVerifier.totalAttesters()).to.equal((index + 1) * committeeSize)

      // second batch
      index = 2
      await sendBatch(attestationsVerifier, index, committees[index - 1], committees[index])

      for (let i = 0; i < committeeSize; i++) {
        let currentCommitteeMemberIndex = await attestationsVerifier.attestersIndices(committees[index][i].address)
        expect(currentCommitteeMemberIndex).to.equal(index + 1)
      }
      expect(await attestationsVerifier.currentCommitteeTransitionCount()).to.equal(index + 1)
      expect(await attestationsVerifier.totalAttesters()).to.equal((index + 1) * committeeSize)

      // third batch
      index = 3
      await sendBatch(attestationsVerifier, index, committees[index - 1], committees[index])

      for (let i = 0; i < committeeSize; i++) {
        let currentCommitteeMemberIndex = await attestationsVerifier.attestersIndices(committees[index][i].address)
        expect(currentCommitteeMemberIndex).to.equal(index + 1)
      }
      expect(await attestationsVerifier.currentCommitteeTransitionCount()).to.equal(index + 1)
      expect(await attestationsVerifier.totalAttesters()).to.equal((index + 1) * committeeSize)
    })

    it('should increment current committee transition counter for the same set of members', async function () {
      // Generate and send batch
      await sendBatch(attestationsVerifier, index + 1, committees[index], committees[index])

      // Asserts
      let nextCommitteeSize = await attestationsVerifier.committeeSize()
      expect(nextCommitteeSize.toNumber()).to.equal(32)
      expect(await attestationsVerifier.currentCommitteeTransitionCount()).to.equal(2)
      expect(await attestationsVerifier.totalAttesters()).to.equal(32)

      for (let i = 0; i < nextCommitteeSize; i++) {
        let currentCommitteeMemberIndex = await attestationsVerifier.attestersIndices(
          committees[index].map((wallet) => wallet.address)[i],
        )
        expect(currentCommitteeMemberIndex).to.equal(2)
      }
    })

    it('should mark banned members among the known attester set', async function () {
      await sendBatch(attestationsVerifier, index + 1, committees[index], [], committees[index])

      let nextCommitteeSize = await attestationsVerifier.committeeSize()
      expect(nextCommitteeSize.toNumber()).to.equal(32)
      expect(await attestationsVerifier.currentCommitteeTransitionCount()).to.equal(1)

      const MAX_UINT256 = ethers.constants.MaxUint256
      for (let i = 0; i < nextCommitteeSize; i++) {
        let currentCommitteeMemberIndex = await attestationsVerifier.attestersIndices(
          committees[index].map((wallet) => wallet.address)[i],
        )
        expect(currentCommitteeMemberIndex).to.equal(MAX_UINT256)
      }
      expect(await attestationsVerifier.totalAttesters()).to.equal(32)
    })

    it('should discard attestations from banned committee set', async function () {
      await sendBatch(attestationsVerifier, index + 1, committees[index], [], committees[index])

      let nextCommitteeSize = await attestationsVerifier.committeeSize()
      expect(nextCommitteeSize.toNumber()).to.equal(32)
      expect(await attestationsVerifier.currentCommitteeTransitionCount()).to.equal(1)

      const MAX_UINT256 = ethers.constants.MaxUint256
      for (let i = 0; i < nextCommitteeSize; i++) {
        let currentCommitteeMemberIndex = await attestationsVerifier.attestersIndices(
          committees[index].map((wallet) => wallet.address)[i],
        )
        expect(currentCommitteeMemberIndex).to.equal(MAX_UINT256)
      }

      await expect(
        sendBatch(attestationsVerifier, index + 2, committees[index], committees[index], []),
      ).to.be.revertedWith('Signatures verification failed')
    })
  })
})

// args to REMIX constructor example
// ["0x5cb78Ec7701bD8d0f7cd4fEd625599E735252268",     "0x7247215D1A891790eaD0C79fd42dAe94a47825Bb",     "0x241A2d40191933E4c3E137cf84739E8f95C5a86E",     "0x6C35bf635D772B92f8cF93e5Aa1c418f86158cDe",     "0x33820541866667ec507e17a16B232659F4e96bC6",     "0xec8bb4585fA3Cd40e05fc8D3CC9CB0401E64979e",     "0xBc8D8d4862420Fd297C06f4447D6E35E64bbBbfE",     "0x4D61779D64482238Acc3D2E8396bAaC8772824b2",     "0x7D9e08f0e4C5850f8D1D03f2C6cccE40bDed6146",     "0x35Fd9a2cD48A2C81cF1fdeD82C0C84a0661ac44b",     "0x2c9EF2c5a32BD2e0Fc646bcA54761ef135d1E4A5",     "0xB8c7910F90D3ebb03b3DD7ae7527f8E04831688b",     "0xbD66dA643591e3a5c25289C1d6Cb2C5AD7Efa0AE",     "0x1D005a07eDdAC64D26F9899c8142eF0d33e7af0D",     "0xB6c08D61975dC1314aa8C14D112842a0FF229B16",     "0xc8B0aD7514c90B01223E82d33fA303682a10b8E5",     "0x838378a481a9d6505d46479Ad4041a1815705224",     "0x096E5Ff9169938b02d4f06007390fCA65CFCd712",     "0x5dd2761ccdEbF19d0Aca18e98Bb83df5dA66Dc9C",     "0xC2C692eCaCC73aA1b03A68F59CC16D39Ea2e1590",     "0x03459788Cccf4f983e42b23Db55363e74C8CD438",     "0x518BefcBd221542F7F3665a5F218b99B0acE5DF6",     "0xE20835Cb30FDbFf43d2A807264a3677B7fC7db5D",     "0x20b95DE757374093AD99580601E069780b35eC03",     "0x2143E9D2f1c52226c726ad7eb2BF06db36985efc",     "0xc0eBd12be6d147fbd91404DC8DFEBfb09f4b2e34",     "0xCA54b7B6709E12ac3A132b85f4145Bb812fbDdF0",     "0x33C1A6D5348e1b654C1d1c931C4ac2c290110Fa2",     "0x4b4747a40891d7467277922062bEfB1f54AFDBBC",     "0x72aC370671A935C7Aa178368c76D2f30715B573c",     "0xA801890766C46717e2F9fbAE2781e879860d5cC1",     "0x6Cc6bFdFcEA8CA19aBc8D3A47ba340bA9460abEc"]
async function sendBatch(
  attestationsVerifier,
  index,
  prevCommittee = [],
  nextCommittee = [],
  bannedCommittee = [],
  committedSfx = [],
  revertedSfx = [],
) {
  let batch = {
    currentCommitteeHash: keccak256(
      ethUtil.toBuffer(
        ethers.utils.solidityPack(
          Array(prevCommittee.length).fill('address'),
          prevCommittee.map((wallet) => wallet.address),
        ),
      ),
    ),
    nextCommitteeHash: keccak256(
      ethUtil.toBuffer(
        ethers.utils.solidityPack(
          Array(nextCommittee.length).fill('address'),
          nextCommittee.map((wallet) => wallet.address),
        ),
      ),
    ),
    bannedCommittee: bannedCommittee.map((wallet) => wallet.address),
    committedSfx: committedSfx,
    revertedSfx: revertedSfx,
    index: index,
  }
  const messageHash = getMessageHash(batch)
  const signatures = await generateSignatures(prevCommittee, messageHash, attestationsVerifier)

  let result = await attestationsVerifier.receiveAttestationBatch(
    ...Object.values(batch),
    ethers.utils.arrayify(messageHash),
    signatures,
    constructMerkleProofs(prevCommittee),
  )

  const receipt = await result.wait()

  return result
}

function generateWallets(size = 32) {
  const wallets = Array.from(
    {
      length: size,
    },
    () => ethers.Wallet.createRandom(),
  )

  return wallets
}

module.exports = {
  newEmptyBatch,
  constructMultiMerkleProof,
  batchEncodePacked,
  batchEncodePackedGMP,
}
