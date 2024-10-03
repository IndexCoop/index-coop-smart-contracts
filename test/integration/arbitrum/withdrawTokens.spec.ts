import { BigNumber, Signer, constants, utils } from "ethers";
import { expect } from "chai";
import { impersonateAccount, setBlockNumber } from "@utils/test/testingUtils";
import { WithdrawTokens__factory } from "../../../typechain";

if (process.env.INTEGRATIONTEST) {
  describe("WithdrawTokens", function () {
    const deployerAddress = "0x37e6365d4f6aE378467b0e24c9065Ce5f06D70bF";
    let deployerSigner: Signer;

    setBlockNumber(236525000);
    before(async function () {
      deployerSigner = await impersonateAccount(deployerAddress);
    });

    it("deploys to correct address", async function () {
      const nonce = 1556;
      const currentAccountNonce = await deployerSigner.getTransactionCount();

      // Unfortunately we will have to spam a bunch of no-op transactions to get to the desired nonce
      // Costs should be negligible though 21000 gas per tx. (at 0.01 gwei gas price on arbitrum -> 210 gwei)
      for (let i = currentAccountNonce; i < nonce; i++) {
        await deployerSigner.sendTransaction({
          to: deployerAddress,
          value: BigNumber.from(0),
          nonce: i,
        });
      }
      const expectedAddress = "0x940ecb16416fe52856e8653b2958bfd556aa6a7e";
      const factory = await new WithdrawTokens__factory(deployerSigner);
      const contract = await factory.deploy({ nonce });
      await contract.deployed();
      expect(contract.address.toLowerCase()).to.equal(expectedAddress);

      const contractEthBalance = await deployerSigner.provider.getBalance(contract.address);
      expect(contractEthBalance).to.gt(0);
      console.log(`Contract eth balance: ${utils.formatEther(contractEthBalance)}`);

      const deployerBalanceBefore = await deployerSigner.getBalance();
      const tx = await contract.withdraw(constants.AddressZero, contractEthBalance);
      const receipt = await tx.wait();
      const deployerBalanceAfter = await deployerSigner.getBalance();
      const txCost = tx.gasPrice.mul(receipt.gasUsed);
      expect(deployerBalanceAfter).to.eq(deployerBalanceBefore.add(contractEthBalance).sub(txCost));
    });
  });
}
