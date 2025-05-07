const { expect } = require('chai')
const { ethers } = require('hardhat')

describe('VestingFactory Contract - 18mo vest', function () {
  let VestingFactory
  let vestingFactory
  let owner
  let beneficiary
  let beneficiary1
  let beneficiary2
  let beneficiary3
  let token
  let start
  const amount = ethers.utils.parseEther('1000') // 1000 tokens

  beforeEach(async function () {
    ;[owner, beneficiary, beneficiary1, beneficiary2, beneficiary3] = await ethers.getSigners()

    // Deploy your ERC20 token
    const Token = await ethers.getContractFactory('TRN')
    token = await Token.deploy(owner.address, 'TRN', 'TRN')
    await token.deployed()

    // Mint tokens to the VestingFactory
    await token.mint(owner.address, ethers.utils.parseEther('100000000'))

    // Record the start time
    const latest = await ethers.provider.getBlock('latest')
    const start = latest.timestamp

    // Deploy VestingFactory
    VestingFactory = await ethers.getContractFactory('VestingFactory')
    VestingFactory.connect(owner)
    // // Use proxy to deploy the contract
    vestingFactory = await upgrades.deployProxy(VestingFactory, [token.address, start, owner.address], {
      initializer: 'initialize',
    })
    await vestingFactory.deployed()

    // Approve the VestingFactory to spend tokens
    await token.connect(owner).approve(vestingFactory.address, ethers.utils.parseEther('1000'))
    // get current hre time
    const block = await ethers.provider.getBlock('latest')
    now = block.timestamp
  })

  it('should assign tokens for 18mo vesting', async function () {
    // Check owner's balance
    expect(await token.balanceOf(owner.address)).to.equal(ethers.utils.parseEther('100000000'))
    // Transfer amount of tokens to the VestingFactory
    await token.connect(owner).transfer(vestingFactory.address, amount)
    await vestingFactory.connect(owner).createVestingWallet18Months(beneficiary.address, amount)
    expect(await token.balanceOf(vestingFactory.address)).to.equal(0)
  })

  it('should not override vesting wallet of the same beneficiary', async function () {
    // Check owner's balance
    expect(await token.balanceOf(owner.address)).to.equal(ethers.utils.parseEther('100000000'))
    // Transfer amount of tokens to the VestingFactory
    await token.connect(owner).transfer(vestingFactory.address, amount)
    await vestingFactory.connect(owner).createVestingWallet18Months(beneficiary.address, amount)
    expect(await token.balanceOf(vestingFactory.address)).to.equal(0)
    expect(vestingFactory.connect(owner).createVestingWallet18Months(beneficiary.address, amount)).to.be.revertedWith(
      'Vesting wallet already exists for this beneficiary',
    )
  })

  it('should withdraw the correct amount after 1 month on 18mo vesting', async function () {
    const initialBalance = await token.balanceOf(beneficiary.address)
    // Check the beneficiary's balance - should be 0
    expect(await token.balanceOf(beneficiary.address)).to.be.eq(ethers.utils.parseEther('0'))

    // Transfer amount of tokens to the VestingFactory
    await token.connect(owner).transfer(vestingFactory.address, amount)
    await vestingFactory.connect(owner).createVestingWallet18Months(beneficiary.address, amount)
    expect(await token.balanceOf(vestingFactory.address)).to.equal(0)

    // Increase time by 1 month
    await ethers.provider.send('evm_increaseTime', [30 * 24 * 60 * 60]) // 30 days
    // await ethers.provider.send('evm_setNextBlockTimestamp', [now + 30 * 24 * 60 * 60])
    await ethers.provider.send('evm_mine')

    // Calculate expected vested amount (1/18th for 18 months vesting)
    const expectedVestedAmount = amount.div(18)

    // Get the vesting wallet address (assuming it's the first one created)
    const vestingWalletAddress = await vestingFactory.vestingWallets(beneficiary.address)

    // Check how many of tokens are releasable
    const releasableAmount = await vestingFactory.releasable(beneficiary.address, token.address)

    const _releaseTx = await vestingFactory.connect(beneficiary).release(token.address)

    // Check the beneficiary's balance
    expect(await token.balanceOf(beneficiary.address)).to.be.closeTo(
      expectedVestedAmount.sub(initialBalance),
      ethers.utils.parseEther('0.1'),
    )
  })
})

describe('VestingFactory Contract - 24mo vest', function () {
  let VestingFactory
  let vestingFactory
  let owner
  let beneficiary
  let token
  let start
  const amount = ethers.utils.parseEther('1000') // 1000 tokens

  beforeEach(async function () {
    ;[owner, beneficiary] = await ethers.getSigners()

    // Deploy your ERC20 token
    const Token = await ethers.getContractFactory('TRN')
    token = await Token.deploy(owner.address, 'TRN', 'TRN')
    await token.deployed()

    // Mint tokens to the VestingFactory
    await token.mint(owner.address, ethers.utils.parseEther('100000000'))
    // Record the start time
    const latest = await ethers.provider.getBlock('latest')
    const start = latest.timestamp

    // Deploy VestingFactory
    VestingFactory = await ethers.getContractFactory('VestingFactory')
    VestingFactory.connect(owner)
    // // Use proxy to deploy the contract
    vestingFactory = await upgrades.deployProxy(VestingFactory, [token.address, start, owner.address], {
      initializer: 'initialize',
    })
    await vestingFactory.deployed()

    // Approve the VestingFactory to spend tokens
    await token.connect(owner).approve(vestingFactory.address, ethers.utils.parseEther('1000'))
  })

  it('should assign tokens for 24mo vesting', async function () {
    // Check owner's balance
    expect(await token.balanceOf(owner.address)).to.equal(ethers.utils.parseEther('100000000'))
    // Transfer amount of tokens to the VestingFactory
    await token.connect(owner).transfer(vestingFactory.address, amount)
    await vestingFactory.connect(owner).createVestingWallet24Months(beneficiary.address, amount)
    expect(await token.balanceOf(vestingFactory.address)).to.equal(0)
  })

  it('should withdraw the correct amount after 1 month on 24mo vesting', async function () {
    // Check the beneficiary's balance - should be 0
    expect(await token.balanceOf(beneficiary.address)).to.be.eq(ethers.utils.parseEther('0'))

    // Transfer amount of tokens to the VestingFactory
    await token.connect(owner).transfer(vestingFactory.address, amount)
    await vestingFactory.connect(owner).createVestingWallet24Months(beneficiary.address, amount)
    expect(await token.balanceOf(vestingFactory.address)).to.equal(0)

    // Increase time by 1 month
    await ethers.provider.send('evm_increaseTime', [30 * 24 * 60 * 60]) // 30 days
    await ethers.provider.send('evm_mine')

    // Calculate expected vested amount (1/24th for 24 months vesting)
    const expectedVestedAmount = amount.div(24).mul(1) // 1 months passed
    // Get the vesting wallet address (assuming it's the first one created)
    const vestingWalletAddress = await vestingFactory.vestingWallets(beneficiary.address)

    // Check how many of tokens are releasable
    const releasableAmount = await vestingFactory.releasable(beneficiary.address, token.address)

    const _releaseTx = await vestingFactory.connect(beneficiary).release(token.address)

    // Check the beneficiary's balance
    expect(await token.balanceOf(beneficiary.address)).to.be.closeTo(
      expectedVestedAmount,
      ethers.utils.parseEther('0.1'),
    )
  })
})
