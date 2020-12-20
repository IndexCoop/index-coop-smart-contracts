const shell = require('shelljs'); // This module is already a solidity-coverage dep

module.exports = {
  skipFiles: [
    'mocks',
    'interfaces'
  ],
  providerOptions: {
    default_balance_ether: 1000000,
    gasLimit: 30000000,
  },
  onCompileComplete: async function(config){
    await run('typechain');
  },
  onIstanbulComplete: async function(config){
    shell.rm('-rf', './typechain'); // Clean up at the end
  }
}