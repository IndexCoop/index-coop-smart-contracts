<p align="center">
  <a href="https://circleci.com/gh/SetProtocol/index-coop-contracts/tree/master">
    <img src="https://img.shields.io/circleci/project/github/SetProtocol/index-coop-smart-contracts/master.svg" />
  </a>
  <a href='https://coveralls.io/github/SetProtocol/index-coop-contracts?branch=master'><img src='https://coveralls.io/repos/github/SetProtocol/index-coop-smart-contracts/badge.svg?branch=master&amp;t=4pzROZ' alt='Coverage Status' /></a>
</p>

# Index Coop Smart Contracts
Repo housing contracts, deploys, and js library for the Index Coop

# Setup
Make a copy of the prod env file

`cp .env.default .env`

Get a token from [Alchemy](https://www.alchemy.com/)

In `.env` replace `ALCHEMY_TOKEN` with your token

Then install all the dependencies and build with

`yarn`

## Unit Testing Your Contract

In one terminal window, run

`yarn && yarn chain`

Once the local server is up, in a new terminal window run

`yarn test`
# License
Index Coop Smart Contracts are [Apache](./LICENSE) licensed.
