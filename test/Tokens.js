const { expect } = require('chai')
const { ethers } = require('hardhat')

describe('t3SOL Contract', function () {
  let t3SOL
  let owner, addr1, addr2
  let ownerSigner, addr1Signer, addr2Signer

  beforeEach(async function () {
    // Get signers
    ;[ownerSigner, addr1Signer, addr2Signer] = await ethers.getSigners()
    owner = ownerSigner.address
    addr1 = addr1Signer.address
    addr2 = addr2Signer.address

    // Deploy the contract
    const t3SOLContract = await ethers.getContractFactory('t3SOL')
    t3SOL = await t3SOLContract.deploy(owner, 'Test Token', 'TTK')
  })

  it('Should allow the owner to mint tokens', async function () {
    const mintAmount = ethers.utils.parseUnits('1000', 18)
    await t3SOL.mint(owner, mintAmount)

    expect(await t3SOL.balanceOf(owner)).to.equal(mintAmount)
  })

  it('Should prevent non-owners from minting tokens', async function () {
    const mintAmount = ethers.utils.parseUnits('1000', 18)

    expect(t3SOL.connect(addr1Signer).mint(addr1, mintAmount)).to.be.revertedWith('Only owner can call this function')
  })
})

describe('t3USD Contract', function () {
  let t3SOL
  let owner, addr1, addr2
  let ownerSigner, addr1Signer, addr2Signer

  beforeEach(async function () {
    // Get signers
    ;[ownerSigner, addr1Signer, addr2Signer] = await ethers.getSigners()
    owner = ownerSigner.address
    addr1 = addr1Signer.address
    addr2 = addr2Signer.address

    // Deploy the contract
    const t3SOLContract = await ethers.getContractFactory('t3USD')
    t3SOL = await t3SOLContract.deploy(owner, 'Test Token', 'TTK')
  })

  it('Should allow the owner to mint tokens', async function () {
    const mintAmount = ethers.utils.parseUnits('1000', 18)
    await t3SOL.mint(owner, mintAmount)

    expect(await t3SOL.balanceOf(owner)).to.equal(mintAmount)
  })

  it('Should prevent non-owners from minting tokens', async function () {
    const mintAmount = ethers.utils.parseUnits('1000', 18)

    expect(t3SOL.connect(addr1Signer).mint(addr1, mintAmount)).to.be.revertedWith('Only owner can call this function')
  })
})

describe('TRN Contract', function () {
  let t3SOL
  let owner, addr1, addr2
  let ownerSigner, addr1Signer, addr2Signer

  beforeEach(async function () {
    // Get signers
    ;[ownerSigner, addr1Signer, addr2Signer] = await ethers.getSigners()
    owner = ownerSigner.address
    addr1 = addr1Signer.address
    addr2 = addr2Signer.address

    // Deploy the contract
    const t3SOLContract = await ethers.getContractFactory('TRN')
    t3SOL = await t3SOLContract.deploy(owner, 'Test Token', 'TTK')
  })

  it('Should allow the owner to mint tokens', async function () {
    const mintAmount = ethers.utils.parseUnits('1000', 18)
    await t3SOL.mint(owner, mintAmount)

    expect(await t3SOL.balanceOf(owner)).to.equal(mintAmount)
  })

  it('Should prevent non-owners from minting tokens', async function () {
    const mintAmount = ethers.utils.parseUnits('1000', 18)

    expect(t3SOL.connect(addr1Signer).mint(addr1, mintAmount)).to.be.revertedWith('Only owner can call this function')
  })
})

describe('t3BTC Contract', function () {
  let t3SOL
  let owner, addr1, addr2
  let ownerSigner, addr1Signer, addr2Signer

  beforeEach(async function () {
    // Get signers
    ;[ownerSigner, addr1Signer, addr2Signer] = await ethers.getSigners()
    owner = ownerSigner.address
    addr1 = addr1Signer.address
    addr2 = addr2Signer.address

    // Deploy the contract
    const t3SOLContract = await ethers.getContractFactory('t3BTC')
    t3SOL = await t3SOLContract.deploy(owner, 'Test Token', 'TTK')
  })

  it('Should allow the owner to mint tokens', async function () {
    const mintAmount = ethers.utils.parseUnits('1000', 18)
    await t3SOL.mint(owner, mintAmount)

    expect(await t3SOL.balanceOf(owner)).to.equal(mintAmount)
  })

  it('Should prevent non-owners from minting tokens', async function () {
    const mintAmount = ethers.utils.parseUnits('1000', 18)

    expect(t3SOL.connect(addr1Signer).mint(addr1, mintAmount)).to.be.revertedWith('Only owner can call this function')
  })
})

describe('t3DOT Contract', function () {
  let t3SOL
  let owner, addr1, addr2
  let ownerSigner, addr1Signer, addr2Signer

  beforeEach(async function () {
    // Get signers
    ;[ownerSigner, addr1Signer, addr2Signer] = await ethers.getSigners()
    owner = ownerSigner.address
    addr1 = addr1Signer.address
    addr2 = addr2Signer.address

    // Deploy the contract
    const t3SOLContract = await ethers.getContractFactory('t3DOT')
    t3SOL = await t3SOLContract.deploy(owner, 'Test Token', 'TTK')
  })

  it('Should allow the owner to mint tokens', async function () {
    const mintAmount = ethers.utils.parseUnits('1000', 18)
    await t3SOL.mint(owner, mintAmount)

    expect(await t3SOL.balanceOf(owner)).to.equal(mintAmount)
  })

  it('Should prevent non-owners from minting tokens', async function () {
    const mintAmount = ethers.utils.parseUnits('1000', 18)

    expect(t3SOL.connect(addr1Signer).mint(addr1, mintAmount)).to.be.revertedWith('Only owner can call this function')
  })
})

describe('BRN Contract', function () {
  let BRN
  let owner, addr1, addr2
  let ownerSigner, addr1Signer, addr2Signer

  beforeEach(async function () {
    // Get signers
    ;[ownerSigner, addr1Signer, addr2Signer] = await ethers.getSigners()
    owner = ownerSigner.address
    addr1 = addr1Signer.address
    addr2 = addr2Signer.address

    // Deploy the contract
    const BRNContract = await ethers.getContractFactory('BRN')
    BRN = await BRNContract.deploy(owner, 'Test BRN', 'BRN')
  })

  it('Should allow the owner to mint tokens', async function () {
    const mintAmount = ethers.utils.parseUnits('1000', 18)
    await BRN.mint(owner, mintAmount)

    expect(await BRN.balanceOf(owner)).to.equal(mintAmount)
  })

  it('Should prevent non-owners from minting tokens', async function () {
    const mintAmount = ethers.utils.parseUnits('1000', 18)

    expect(BRN.connect(addr1Signer).mint(addr1, mintAmount)).to.be.revertedWith('Only owner can call this function')
  })
})
