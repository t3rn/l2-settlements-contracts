/**
 * This function crafts the calldata to be passed for escrow calls
 * @param {uint8} orderType - The type of order
 * @param {bytes} data - The details of the order encoded
 * @returns {string}
 */
function createOrderDetails(orderType, data) {
  return ethers.utils.defaultAbiCoder.encode(['tuple(uint8 orderType, bytes data)'], [[orderType, data]])
}

function encodeERC20Order(tokenToReceive, minAmount, destinationAccount) {
  return ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint256', 'bytes32'],
    [tokenToReceive, minAmount, destinationAccount],
  )
}

function encodeERC721MintOrder(nftAddress, mintQuantity, destinationAccount) {
  return ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint256', 'bytes32'],
    [nftAddress, mintQuantity, destinationAccount],
  )
}

module.exports = {
  createOrderDetails,
  encodeERC20Order,
  encodeERC721MintOrder,
}
