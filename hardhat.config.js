require('dotenv').config()
require('@nomicfoundation/hardhat-toolbox')
require('@openzeppelin/hardhat-upgrades')
require('@nomiclabs/hardhat-ethers')
require('solidity-coverage')

// ETHEREUM_PRIVATE_KEY default is just a random empty key
const ETHEREUM_PRIVATE_KEY =
  process.env['ETHEREUM_PRIVATE_KEY'] || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const ETHERSCAN_API_KEY = process.env['ETHERSCAN_API_KEY']

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: '0.8.24',
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
  settings: {
    optimizer: {
      enabled: true,
      runs: 200,
    },
    allowUnlimitedContractSize: true,
  },
  networks: {
    hardhat: {
      // accounts: accounts
    },
    local: {
      url: 'http://127.0.0.1:8545/',
    },
    // https://chainlist.org/chain/11155111
    sepolia: {
      url: 'https://ethereum-sepolia.publicnode.com',
      chainId: 11155111,
      accounts: [ETHEREUM_PRIVATE_KEY],
    },
    'blast-sepolia': {
      url: 'https://blast-sepolia.infura.io/v3/4cb7a3616b654db2b88e09e55c87700b',
      chainId: 168587773,
      accounts: [ETHEREUM_PRIVATE_KEY],
    },
    // https://chainlist.org/chain/84532
    'base-sepolia': {
      url: 'https://wiser-proud-resonance.base-sepolia.quiknode.pro/5e0b73ae49f0575e524db383c7f8b00aa574bcd4/',
      chainId: 84532,
      accounts: [ETHEREUM_PRIVATE_KEY],
      gasPrice: 20000000000,
    },
    // https://chainlist.org/chain/421614
    'arbitrum-sepolia': {
      url: 'https://sepolia-rollup.arbitrum.io/rpc',
      chainId: 421614,
      accounts: [ETHEREUM_PRIVATE_KEY],
    },
    // https://chainlist.org/chain/97
    'binance-testnet': {
      url: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
      chainId: 97,
      accounts: [ETHEREUM_PRIVATE_KEY],
      gasPrice: 20000000000,
    },
    // https://docs.optimism.io/op-networks
    'optimism-sepolia': {
      url: 'https://optimism-sepolia.infura.io/v3/4cb7a3616b654db2b88e09e55c87700b',
      chainId: 11155420,
      accounts: [ETHEREUM_PRIVATE_KEY],
      gasPrice: 20000000000,
    },
    // https://chainlist.org/chain/534351
    'scroll-sepolia': {
      url: 'https://scroll-sepolia.chainstacklabs.com',
      chainId: 534351,
      accounts: [ETHEREUM_PRIVATE_KEY],
    },
    'linea-goerli': {
      url: 'https://rpc.goerli.linea.build',
      chainId: 59140,
      accounts: [ETHEREUM_PRIVATE_KEY],
    },
    t0rn: {
      url: 'https://rpc.t0rn.io',
      chainId: 3333,
      accounts: [ETHEREUM_PRIVATE_KEY],
    },
    'filecoin-calibnet': {
      url: 'https://api.calibration.node.glif.io/rpc/v0',
      chainId: 314159,
      accounts: [ETHEREUM_PRIVATE_KEY],
    },
    l0rn: {
      url: 'http://l0rn.t3rn.io:8449',
      chainId: 70287492358,
      accounts: [ETHEREUM_PRIVATE_KEY],
    },
    l1rn: {
      url: 'https://brn.rpc.caldera.xyz/http',
      chainId: 6636130,
      accounts: [ETHEREUM_PRIVATE_KEY],
    },
  },
}
