const { expect } = require('chai')
const { ethers, upgrades } = require('hardhat')

describe('VestingFactory Contract', function () {
  let VestingFactory, vestingFactory
  let CustomVestingWallet
  let implementation
  let owner, beneficiary, beneficiary1, beneficiary2, beneficiary3
  let token
  let start
  const amount = ethers.utils.parseEther('1000')

  describe('18mo vesting', function () {
    beforeEach(async function () {
      ;[owner, beneficiary, beneficiary1, beneficiary2, beneficiary3] = await ethers.getSigners()

      const Token = await ethers.getContractFactory('TRN')
      token = await Token.deploy(owner.address, 'TRN', 'TRN')
      await token.deployed()
      await token.mint(owner.address, ethers.utils.parseEther('100000000'))

      const latest = await ethers.provider.getBlock('latest')
      start = latest.timestamp

      VestingFactory = await ethers.getContractFactory('VestingFactory')
      vestingFactory = await upgrades.deployProxy(VestingFactory, [token.address, start, owner.address], {
        initializer: 'initialize',
      })
      await vestingFactory.deployed()

      CustomVestingWallet = await ethers.getContractFactory('CustomVestingWallet')
      implementation = await CustomVestingWallet.deploy()
      await implementation.deployed()

      await vestingFactory.setVestingWalletImplementation(implementation.address)
      await token.connect(owner).approve(vestingFactory.address, ethers.utils.parseEther('1000'))
    })

    it('should assign tokens for 18mo vesting', async function () {
      expect(await token.balanceOf(owner.address)).to.equal(ethers.utils.parseEther('100000000'))
      await token.connect(owner).transfer(vestingFactory.address, amount)
      await vestingFactory.connect(owner).createVestingWallet18Months(beneficiary.address, amount)
      expect(await token.balanceOf(vestingFactory.address)).to.equal(0)
    })

    it('should not override vesting wallet of the same beneficiary', async function () {
      await token.connect(owner).transfer(vestingFactory.address, amount)
      await vestingFactory.connect(owner).createVestingWallet18Months(beneficiary.address, amount)
      await expect(
        vestingFactory.connect(owner).createVestingWallet18Months(beneficiary.address, amount),
      ).to.be.revertedWith('Vesting wallet already exists')
    })

    it('should withdraw the correct amount after 1 month on 18mo vesting', async function () {
      await token.connect(owner).transfer(vestingFactory.address, amount)
      await vestingFactory.connect(owner).createVestingWallet18Months(beneficiary.address, amount)

      await ethers.provider.send('evm_increaseTime', [30 * 24 * 60 * 60])
      await ethers.provider.send('evm_mine')

      const expectedVestedAmount = amount.div(18)
      await vestingFactory.connect(beneficiary).release(token.address)

      const actualBalance = await token.balanceOf(beneficiary.address)
      expect(actualBalance).to.be.closeTo(expectedVestedAmount, ethers.utils.parseEther('0.1'))
    })
  })

  describe('24mo vesting', function () {
    beforeEach(async function () {
      ;[owner, beneficiary] = await ethers.getSigners()

      const Token = await ethers.getContractFactory('TRN')
      token = await Token.deploy(owner.address, 'TRN', 'TRN')
      await token.deployed()
      await token.mint(owner.address, ethers.utils.parseEther('100000000'))

      const latest = await ethers.provider.getBlock('latest')
      start = latest.timestamp

      VestingFactory = await ethers.getContractFactory('VestingFactory')
      vestingFactory = await upgrades.deployProxy(VestingFactory, [token.address, start, owner.address], {
        initializer: 'initialize',
      })
      await vestingFactory.deployed()

      CustomVestingWallet = await ethers.getContractFactory('CustomVestingWallet')
      implementation = await CustomVestingWallet.deploy()
      await implementation.deployed()

      await vestingFactory.setVestingWalletImplementation(implementation.address)
      await token.connect(owner).approve(vestingFactory.address, ethers.utils.parseEther('1000'))
    })

    it('should assign tokens for 24mo vesting', async function () {
      await token.connect(owner).transfer(vestingFactory.address, amount)
      await vestingFactory.connect(owner).createVestingWallet24Months(beneficiary.address, amount)
      expect(await token.balanceOf(vestingFactory.address)).to.equal(0)
    })

    it('should withdraw the correct amount after 1 month on 24mo vesting', async function () {
      await token.connect(owner).transfer(vestingFactory.address, amount)
      await vestingFactory.connect(owner).createVestingWallet24Months(beneficiary.address, amount)

      await ethers.provider.send('evm_increaseTime', [30 * 24 * 60 * 60])
      await ethers.provider.send('evm_mine')

      const expectedVestedAmount = amount.div(24)
      await vestingFactory.connect(beneficiary).release(token.address)

      const actualBalance = await token.balanceOf(beneficiary.address)
      expect(actualBalance).to.be.closeTo(expectedVestedAmount, ethers.utils.parseEther('0.1'))
    })
  })

  describe('VestingFactory internals', function () {
    beforeEach(async () => {
      ;[owner, beneficiary1, beneficiary2] = await ethers.getSigners()

      const Token = await ethers.getContractFactory('TRN')
      token = await Token.deploy(owner.address, 'TRN', 'TRN')
      await token.deployed()
      await token.mint(owner.address, ethers.utils.parseEther('100000000'))

      const latest = await ethers.provider.getBlock('latest')
      start = latest.timestamp

      VestingFactory = await ethers.getContractFactory('VestingFactory')
      vestingFactory = await upgrades.deployProxy(VestingFactory, [token.address, start, owner.address], {
        initializer: 'initialize',
      })
      await vestingFactory.deployed()

      CustomVestingWallet = await ethers.getContractFactory('CustomVestingWallet')
      implementation = await CustomVestingWallet.deploy()
      await implementation.deployed()
      await vestingFactory.setVestingWalletImplementation(implementation.address)

      await token.transfer(vestingFactory.address, amount.mul(2))
    })

    it('should reuse the same implementation for multiple vesting wallets', async () => {
      await vestingFactory.connect(owner).createVestingWallet18Months(beneficiary1.address, amount)
      await vestingFactory.connect(owner).createVestingWallet18Months(beneficiary2.address, amount)

      const impl = await vestingFactory.vestingWalletImplementation()
      const wallet1 = await vestingFactory.vestingWallets(beneficiary1.address)
      const wallet2 = await vestingFactory.vestingWallets(beneficiary2.address)

      expect(wallet1).to.not.equal(wallet2)
      expect(wallet1).to.not.equal(impl)
    })

    it('should revert if trying to set implementation again', async () => {
      const newImpl = await CustomVestingWallet.deploy()
      await newImpl.deployed()

      await expect(vestingFactory.setVestingWalletImplementation(newImpl.address)).to.be.revertedWith(
        'Implementation already set',
      )
    })

    it('should initialize clone with correct beneficiary, start, and duration', async () => {
      await vestingFactory.connect(owner).createVestingWallet18Months(beneficiary1.address, amount)
      const walletAddr = await vestingFactory.vestingWallets(beneficiary1.address)
      const vestingWallet = await ethers.getContractAt('CustomVestingWallet', walletAddr)

      expect(await vestingWallet.beneficiary()).to.equal(beneficiary1.address)
      expect(await vestingWallet.start()).to.equal(start)
      expect(await vestingWallet.duration()).to.equal(18 * 30 * 24 * 60 * 60)
    })
  })
})
