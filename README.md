[![CircleCI](https://dl.circleci.com/status-badge/img/gh/IndexCoop/index-coop-smart-contracts/tree/master.svg?style=svg)](https://dl.circleci.com/status-badge/redirect/gh/IndexCoop/index-coop-smart-contracts/tree/master)

[![Coverage Status](https://coveralls.io/repos/github/IndexCoop/index-coop-smart-contracts/badge.svg)](https://coveralls.io/github/IndexCoop/index-coop-smart-contracts)

# Index Cooperative Smart Contracts

This repo houses the [index-coop][22]'s Solidity smart contracts which are built on [Set Protocol V2][29]. There is a separate repository for [Index Protocol](https://github.com/IndexCoop/index-protocol), a good-fath fork of Set V2 that Index Coop will continue to develop. Head over to that repo to find our newer smart contracts.

[22]: https://www.indexcoop.com/
[29]: https://github.com/SetProtocol/set-protocol-v2

## Install (for development)

```
yarn
```

### Run Hardhat EVM

`yarn chain`

### Build Contracts

`yarn compile`

### Generate TypeChain Typings

`yarn build`

### Run Contract Tests

`yarn test` to run compiled contracts (executes on network localhost, you need to have `yarn chain` running)

OR `yarn test:clean` if contract typings need to be updated

### Run Integration Tests

`yarn chain:fork:ethereum` in one terminal to run chain fork. replace ethereum with polygon if needed, see package.json

`yarn test:integration:ethereum` in another terminal, replace chain again as needed

To run an individual test on e.g. a later block, use (replace path):
`LATESTBLOCK=15508111 INTEGRATIONTEST=true VERBOSE=true npx hardhat test ./test/integration/ethereum/flashMintWrappedIntegration.spec.ts --network localhost`

### Run Coverage Report for Tests

`yarn coverage`

## Installing from `npm`

`index-coop` publishes its contracts as well as [hardhat][22] and [typechain][23] compilation
artifacts to npm.

The distribution comes with fixtures for mocking and testing interactions with other protocols
including Uniswap and Compound. To use these you'll need to install the peer dependencies listed in `package.json`.

```
npm install @indexcoop/index-coop-smart-contracts
```

[22]: https://www.npmjs.com/package/hardhat
[23]: https://www.npmjs.com/package/typechain

## Contributing
We highly encourage participation from the community to help shape the development of Index-Coop. If you are interested in developing on `index-coop` or have any questions, please ping us on [Discord](https://discord.com/invite/RKZ4S3b).

## Security Audits

Set Protocol V2 has undergone multiple audits. For more information see https://index-coop.gitbook.io/index-coop-community-handbook/protocols/security-and-audits

## Vulnerability Reporting ##

If you believe you’ve found a security vulnerability in one of our contracts or platforms, we encourage you to submit it through our [ImmuneFi Bug Bounty][32] program.

[32]: https://immunefi.com/bounty/indexcoop/