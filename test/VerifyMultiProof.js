const { expect } = require('chai')
const { ethers, upgrades } = require('hardhat')
const { StandardMerkleTree } = require('@openzeppelin/merkle-tree')

function constructMultiMerkleProofVerified(signers, impliedRoot, allParticipants) {
  // Wrap each signer in an array
  const signersArrays = allParticipants.map((signer) => [signer])
  const activeSigners = signers.map((signer) => [signer])
  const tree = StandardMerkleTree.of(signersArrays, ['address'])

  // Create a Merkle tree from the leaves.
  const proofs = []
  const leafHashes = []
  for (const [i, v] of tree.entries()) {
    const proof = tree.getProof(i)
    leafHashes.push(tree.leafHash(v))
    proofs.push(proof)
  }

  // Create a multi proof from the leaves.
  const multiProof = tree.getMultiProof(activeSigners)

  const verified = StandardMerkleTree.verifyMultiProof(impliedRoot, ['address'], multiProof)

  if (!verified) {
    console.warn(
      {
        uniqueSigners: activeSigners.map((signer) => signer[0]),
        allParticipants,
        impliedRoot,
      },
      '🤮 Multi proof is not verified',
    )
    throw new Error('Multi proof is not verified')
  }

  return {
    root: tree.root,
    proof: multiProof.proof,
    flags: multiProof.proofFlags,
    leaves: leafHashes,
  }
}

function calculateRootOfCommittee(committee) {
  const tree = StandardMerkleTree.of(
    committee.map((signer) => [signer]),
    ['address'],
    { sortLeaves: false },
  )
  return tree.root
}

describe('VerifyMultiProof', function () {
  let signer
  let initialCommittee
  let impliedCommitteeRoot

  beforeEach(async () => {
    const [owner, addr1, addr2] = await ethers.getSigners()
    signer = owner

    initialCommittee = [owner.address, addr1.address, addr2.address]

    const EscrowGMP = await ethers.getContractFactory('EscrowGMP')
    escrowGMPContract = await upgrades.deployProxy(EscrowGMP, [signer.address], {
      initializer: 'initialize',
    })

    await escrowGMPContract.deployed()

    const AttestationsVerifierProofs = await ethers.getContractFactory('AttestationsVerifierProofs')
    attestersContract = await upgrades.deployProxy(
      AttestationsVerifierProofs,
      [signer.address, initialCommittee, initialCommittee, 0],
      {
        initializer: 'initialize',
      },
    )

    await attestersContract.deployed()

    impliedCommitteeRoot = await attestersContract.implyCommitteeRoot(initialCommittee)
  })

  it('should match contract-implied with re-created root', async () => {
    const root = calculateRootOfCommittee(initialCommittee)
    expect(root).to.equal(impliedCommitteeRoot)
  })
})
