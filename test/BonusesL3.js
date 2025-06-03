const { ethers, upgrades } = require('hardhat')
const { expect } = require('chai')
const { BigNumber } = require('ethers')

async function deployContract(name, initArgs) {
  const contractFactory = await ethers.getContractFactory(name)

  const contract = await upgrades.deployProxy(contractFactory, [...initArgs], {
    initializer: 'initialize',
    unsafeAllowDeployContract: true,
    allowUnlimitedContractSize: true,
  })
  await contract.deployed()
  return contract
}

describe('BonusesL3', () => {
  let BonusesL3
  let owner
  describe('BonusesL3', () => {
    const ASSET_ZERO_CODE = 0
    const AMOUNT_ZERO = BigNumber.from(0)
    const RANDOM_BENEFICIARY = '0x2F42bebF8224edF5F0be764871eA82abb61cE648'

    beforeEach(async () => {
      ;[owner, addr1, addr2, addr3] = await ethers.getSigners()
      BonusesL3 = await deployContract('BonusesL3', [owner.address])
      expect(await BonusesL3.halt()).to.be.ok
      // Set default sender as authorized contracts
      await BonusesL3.addAuthorizedContract(owner.address)
      await BonusesL3.unhalt()
    })

    afterEach(async () => {
      await BonusesL3.halt()
    })

    it('should read base common sense bonus even if ranges unset', async () => {
      const _distributedResult = await BonusesL3.applyBonusFromBid(ASSET_ZERO_CODE, AMOUNT_ZERO, RANDOM_BENEFICIARY)
      const initialRewardPerCurrentRate = await BonusesL3.readCurrentBaseReward()
      expect(initialRewardPerCurrentRate.toString()).to.equal(
        ethers.utils.parseEther('0.070714185704081632').toString(),
      )
    })

    it('should increase Bonus for larger asset amount by 50%', async () => {
      const _distributedResult1 = await BonusesL3.applyBonusFromBid(ASSET_ZERO_CODE, AMOUNT_ZERO, RANDOM_BENEFICIARY)
      const initialRewardPerCurrentRate = await BonusesL3.readCurrentBaseReward()
      expect(initialRewardPerCurrentRate.toString()).to.equal(
        ethers.utils.parseEther('0.070714185704081632').toString(),
      )
      const amount100 = ethers.utils.parseEther('100')
      const _distributedResult2 = await BonusesL3.applyBonusFromBid(ASSET_ZERO_CODE, amount100, RANDOM_BENEFICIARY)
      const higherRewardPerCurrentRate = await BonusesL3.readCurrentBaseReward()
      expect(higherRewardPerCurrentRate.toString()).to.equal(ethers.utils.parseEther('0.070714085694018993').toString())
    })

    it('should increase next bonuses based on 1 TPS vs 700k weekly target', async () => {
      let previousReward = ethers.utils.parseEther('1')
      for (let index = 0; index < 100; index++) {
        const _distributedResult = await BonusesL3.applyBonusFromBid(ASSET_ZERO_CODE, AMOUNT_ZERO, RANDOM_BENEFICIARY)
        const nextRewardPerCurrentRate = await BonusesL3.readCurrentBaseReward()
        expect(nextRewardPerCurrentRate).to.be.lessThanOrEqual(previousReward)
        previousReward = nextRewardPerCurrentRate
      }
    })
  })
})
