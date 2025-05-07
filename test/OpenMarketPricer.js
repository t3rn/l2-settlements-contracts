const { expect } = require('chai')
const { ethers, upgrades } = require('hardhat')

describe('OpenMarketPricer', function () {
  let owner, user1, user2, openMarketPricer

  before(async () => {
    ;[owner, user1, user2] = await ethers.getSigners()

    const OpenMarketPricer = await ethers.getContractFactory('OpenMarketPricer')
    openMarketPricer = await upgrades.deployProxy(OpenMarketPricer, [owner.address], {
      initializer: 'initialize',
    })
    await openMarketPricer.deployed()
    await openMarketPricer.connect(owner).setRemoteOrder(owner.address)
    await openMarketPricer.connect(owner).addSupportedAsset(1)
    await openMarketPricer.connect(owner).addSupportedAsset(2)
  })

  it('should initialize correctly', async () => {
    expect(await openMarketPricer.tickInterval()).to.equal(60)
    expect(await openMarketPricer.alpha()).to.equal(1)
    expect(await openMarketPricer.isOnFlag()).to.equal(true)
  })

  it('should turn off and on the contract', async () => {
    await openMarketPricer.connect(owner).turnOff()
    expect(await openMarketPricer.isOnFlag()).to.equal(false)
    await openMarketPricer.connect(owner).turnOn()
    expect(await openMarketPricer.isOnFlag()).to.equal(true)
  })

  it('should set and get the version', async () => {
    const version = '1.0.0'
    const versionBytes = ethers.utils.formatBytes32String(version)
    await openMarketPricer.connect(owner).setVersion(versionBytes)
    expect(await openMarketPricer.version()).to.equal(versionBytes)
  })

  it('should set and get the tick interval', async () => {
    const tickInterval = 120
    await openMarketPricer.connect(owner).setTickInterval(tickInterval)
    expect(await openMarketPricer.tickInterval()).to.equal(tickInterval)
  })

  it('should set and get the alpha', async () => {
    const alpha = 10
    await openMarketPricer.connect(owner).setAlpha(alpha)
    expect(await openMarketPricer.alpha()).to.equal(alpha)
  })

  it('should calculate price id correctly', async () => {
    const assetA = 1
    const assetB = 2
    const priceId = await openMarketPricer.calcPriceId(assetA, assetB)
    expect(priceId).to.equal(
      ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['uint32', 'uint32'], [assetA, assetB])),
    )
  })

  it('should store and get quotes', async () => {
    const assetA = 1
    const assetB = 2
    const amountA = ethers.utils.parseEther('1')
    const amountB = ethers.utils.parseEther('2')

    await openMarketPricer.connect(owner).storeQuote(assetA, amountA, assetB, amountB)

    const priceId = await openMarketPricer.calcPriceId(assetA, assetB)
    const priceData = await openMarketPricer.perPairPrices(priceId)

    expect(priceData.price).to.equal(amountA.mul(ethers.utils.parseEther('1')).div(amountB))
    expect(priceData.volume).to.equal(amountA)
  })

  it('should update prices using EWMA', async () => {
    const assetA = 1
    const assetB = 2
    const amountA = ethers.utils.parseEther('3')
    const amountB = ethers.utils.parseEther('6')

    await openMarketPricer.connect(owner).storeQuote(assetA, amountA, assetB, amountB)

    const priceId = await openMarketPricer.calcPriceId(assetA, assetB)
    const priceData = await openMarketPricer.perPairPrices(priceId)

    const expectedPrice = amountA.mul(ethers.utils.parseEther('1')).div(amountB)
    const expectedVolume = amountA.add(ethers.utils.parseEther('1'))

    expect(priceData.price).to.equal(expectedPrice)
    expect(priceData.volume).to.equal(expectedVolume)
  })

  it('should get volume correctly', async () => {
    const assetA = 1
    const assetB = 2
    const volume = await openMarketPricer.getVolume(assetA, assetB)
    expect(volume).to.equal(ethers.utils.parseEther('4'))
  })

  it('should get price correctly', async () => {
    const assetA = 1
    const assetB = 2
    const price = await openMarketPricer.getPrice(assetA, assetB)
    const expectedPrice = ethers.utils.parseEther('1').div(2)
    expect(price).to.equal(expectedPrice)
  })

  it('should handle same asset pairs in getPrice', async () => {
    const asset = 1
    const price = await openMarketPricer.getPrice(asset, asset)
    expect(price).to.equal(ethers.utils.parseEther('1'))
  })

  it('should set and get points per asset unit', async () => {
    const assetId = 1
    const points = ethers.utils.parseEther('100')
    await openMarketPricer.connect(owner).setPointsPerAssetUnit(assetId, points)
    expect(await openMarketPricer.getPointsPerAssetUnit(assetId)).to.equal(points)
  })

  it('should calculate asset amount to points correctly', async () => {
    const assetId = 1
    const amount = ethers.utils.parseEther('2')
    const points = ethers.utils.parseEther('100')
    await openMarketPricer.connect(owner).setPointsPerAssetUnit(assetId, points)
    const calculatedPoints = await openMarketPricer.calculateAssetAmountToPoints(assetId, amount)
    expect(calculatedPoints).to.equal(amount.mul(points))
  })

  it('should get points price correctly', async () => {
    const assetA = 1
    const assetB = 2
    const pointsA = ethers.utils.parseEther('100')
    const pointsB = ethers.utils.parseEther('200')
    await openMarketPricer.connect(owner).setPointsPerAssetUnit(assetA, pointsA)
    await openMarketPricer.connect(owner).setPointsPerAssetUnit(assetB, pointsB)
    const pointsPrice = await openMarketPricer.getPointsPrice(assetA, assetB)
    expect(pointsPrice).to.equal(pointsA.mul(ethers.utils.parseEther('1')).div(pointsB))
  })

  it('should use points price if volume is below the threshold and usePointsFallback is true', async () => {
    const assetA = 1
    const assetB = 2
    const amountA = ethers.utils.parseEther('1')
    const amountB = ethers.utils.parseEther('2')
    const pointsA = ethers.utils.parseEther('100')
    const pointsB = ethers.utils.parseEther('200')

    await openMarketPricer.connect(owner).setPointsPerAssetUnit(assetA, pointsA)
    await openMarketPricer.connect(owner).setPointsPerAssetUnit(assetB, pointsB)
    await openMarketPricer.connect(owner).setVolumeConfidenceThreshold(ethers.utils.parseEther('10'))
    await openMarketPricer.connect(owner).setUsePointsFallback(true)

    await openMarketPricer.connect(owner).storeQuote(assetA, amountA, assetB, amountB)

    const price = await openMarketPricer.getPrice(assetA, assetB)
    const expectedPointsPrice = pointsA.mul(ethers.utils.parseEther('1')).div(pointsB)
    expect(price).to.equal(expectedPointsPrice)
  })

  it('should return 0 if volume is below the threshold and usePointsFallback is false', async () => {
    const assetA = 1
    const assetB = 2
    const amountA = ethers.utils.parseEther('1')
    const amountB = ethers.utils.parseEther('2')

    await openMarketPricer.connect(owner).setVolumeConfidenceThreshold(ethers.utils.parseEther('10'))
    await openMarketPricer.connect(owner).setUsePointsFallback(false)

    await openMarketPricer.connect(owner).storeQuote(assetA, amountA, assetB, amountB)

    const price = await openMarketPricer.getPrice(assetA, assetB)
    expect(price).to.equal(0)
  })

  it('should return the open market price if volume meets the threshold', async () => {
    const assetA = 1
    const assetB = 2
    const amountA = ethers.utils.parseEther('20')
    const amountB = ethers.utils.parseEther('40')

    await openMarketPricer.connect(owner).setVolumeConfidenceThreshold(ethers.utils.parseEther('10'))

    await openMarketPricer.connect(owner).storeQuote(assetA, amountA, assetB, amountB)

    const price = await openMarketPricer.getPrice(assetA, assetB)
    const expectedOpenMarketPrice = amountA.mul(ethers.utils.parseEther('1')).div(amountB)
    expect(price).to.equal(expectedOpenMarketPrice)
  })

  it('should set and get points per asset unit', async () => {
    const assetId = 1
    const points = ethers.utils.parseEther('100')
    await openMarketPricer.connect(owner).setPointsPerAssetUnit(assetId, points)
    expect(await openMarketPricer.getPointsPerAssetUnit(assetId)).to.equal(points)
  })

  it('should calculate asset amount to points correctly', async () => {
    const assetId = 1
    const amount = ethers.utils.parseEther('2')
    const points = ethers.utils.parseEther('100')
    await openMarketPricer.connect(owner).setPointsPerAssetUnit(assetId, points)
    const calculatedPoints = await openMarketPricer.calculateAssetAmountToPoints(assetId, amount)
    expect(calculatedPoints).to.equal(amount.mul(points))
  })

  it('should get points price correctly', async () => {
    const assetA = 1
    const assetB = 2
    const pointsA = ethers.utils.parseEther('100')
    const pointsB = ethers.utils.parseEther('200')
    await openMarketPricer.connect(owner).setPointsPerAssetUnit(assetA, pointsA)
    await openMarketPricer.connect(owner).setPointsPerAssetUnit(assetB, pointsB)
    const pointsPrice = await openMarketPricer.getPointsPrice(assetA, assetB)
    expect(pointsPrice).to.equal(pointsA.mul(ethers.utils.parseEther('1')).div(pointsB))
  })
})
