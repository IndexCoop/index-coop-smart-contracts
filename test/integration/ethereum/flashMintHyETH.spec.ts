import "module-alias/register";
import { Account } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/index";
import { setBlockNumber } from "@utils/test/testingUtils";
import { ProtocolUtils } from "@utils/common";
import { ethers } from "hardhat";
import { utils } from "ethers";
import {
  IDebtIssuanceModule,
  IDebtIssuanceModule__factory,
  SetToken,
  SetToken__factory,
  SetTokenCreator,
  SetTokenCreator__factory,
  FlashMintHyETH,
  IPendlePrincipalToken__factory,
} from "../../../typechain";
import { PRODUCTION_ADDRESSES } from "./addresses";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { ether } from "@utils/index";

const expect = getWaffleExpect();

if (process.env.INTEGRATIONTEST) {
  describe("FlashMintHyETH - Integration Test", async () => {
    const addresses = PRODUCTION_ADDRESSES;
    let owner: Account;
    let deployer: DeployHelper;

    let setTokenCreator: SetTokenCreator;
    let debtIssuanceModule: IDebtIssuanceModule;

    // const collateralTokenAddress = addresses.tokens.stEth;
    setBlockNumber(19740000, true);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);
      setTokenCreator = SetTokenCreator__factory.connect(
        addresses.setFork.setTokenCreator,
        owner.wallet,
      );
      debtIssuanceModule = IDebtIssuanceModule__factory.connect(
        addresses.setFork.debtIssuanceModuleV2,
        owner.wallet,
      );
    });

    context("When exchange issuance is deployed", () => {
      let flashMintHyETH: FlashMintHyETH;
      before(async () => {
        flashMintHyETH = await deployer.extensions.deployFlashMintHyETH(
          addresses.tokens.weth,
          addresses.dexes.uniV2.router,
          addresses.dexes.sushiswap.router,
          addresses.dexes.uniV3.router,
          addresses.dexes.uniV3.quoter,
          addresses.dexes.curve.calculator,
          addresses.dexes.curve.addressProvider,
          addresses.setFork.controller,
          addresses.setFork.debtIssuanceModuleV2,
          addresses.tokens.stEth,
          addresses.dexes.curve.pools.stEthEth,
        );
      });

      it("weth address is set correctly", async () => {
        const returnedAddresses = await flashMintHyETH.dexAdapter();
        expect(returnedAddresses.weth).to.eq(utils.getAddress(addresses.tokens.weth));
      });

      it("sushi router address is set correctly", async () => {
        const returnedAddresses = await flashMintHyETH.dexAdapter();
        expect(returnedAddresses.sushiRouter).to.eq(
          utils.getAddress(addresses.dexes.sushiswap.router),
        );
      });

      it("uniV2 router address is set correctly", async () => {
        const returnedAddresses = await flashMintHyETH.dexAdapter();
        expect(returnedAddresses.quickRouter).to.eq(utils.getAddress(addresses.dexes.uniV2.router));
      });

      it("uniV3 router address is set correctly", async () => {
        const returnedAddresses = await flashMintHyETH.dexAdapter();
        expect(returnedAddresses.uniV3Router).to.eq(utils.getAddress(addresses.dexes.uniV3.router));
      });

      it("controller address is set correctly", async () => {
        expect(await flashMintHyETH.setController()).to.eq(
          utils.getAddress(addresses.setFork.controller),
        );
      });

      it("debt issuance module address is set correctly", async () => {
        expect(await flashMintHyETH.issuanceModule()).to.eq(
          utils.getAddress(addresses.setFork.debtIssuanceModuleV2),
        );
      });

      context("when setToken with hyETH launch composition is deployed", () => {
        const setToken: SetToken;
        const components = [
          addresses.tokens.instadappEthV2,
          addresses.tokens.pendleEEth0624,
          addresses.tokens.pendleRsEth0624,
        ];
        console.log("components", components);
        const positions = [
          ethers.utils.parseEther("0.25"),
          ethers.utils.parseEther("0.25"),
          ethers.utils.parseEther("0.25"),
        ];
        const modules = [addresses.setFork.debtIssuanceModuleV2];
        const tokenName = "IndexCoop High Yield ETH";
        const tokenSymbol = "HyETH";

        before(async () => {
          const tx = await setTokenCreator.create(
            components,
            positions,
            modules,
            owner.address,
            tokenName,
            tokenSymbol,
          );
          const retrievedSetAddress = await new ProtocolUtils(
            ethers.provider,
          ).getCreatedSetTokenAddress(tx.hash);
          setToken = SetToken__factory.connect(retrievedSetAddress, owner.wallet);

          await debtIssuanceModule.initialize(
            setToken.address,
            ether(0.5),
            ether(0),
            ether(0),
            owner.address,
            ADDRESS_ZERO,
          );

          await flashMintHyETH.approveToken(
            addresses.tokens.stEth,
            addresses.tokens.instadappEthV2,
            MAX_UINT_256,
          );

          const eEthPendleToken = IPendlePrincipalToken__factory.connect(
            addresses.tokens.pendleEEth0624,
            owner.wallet,
          );
          await flashMintHyETH.approveSetToken(setToken.address);
          const eEthSyToken = await eEthPendleToken.SY();
          await flashMintHyETH.approveToken(
            eEthSyToken,
            addresses.dexes.pendle.markets.eEth0624,
            MAX_UINT_256,
          );
          await flashMintHyETH.setPendleMarket(
            addresses.tokens.pendleEEth0624,
            eEthSyToken,
            addresses.tokens.weEth,
            addresses.dexes.pendle.markets.eEth0624,
          );
          // weETH -> weth pool: https://etherscan.io/address/0x7a415b19932c0105c82fdb6b720bb01b0cc2cae3
          await flashMintHyETH.setSwapData(addresses.tokens.weEth, ADDRESS_ZERO, {
            path: [addresses.tokens.weEth, addresses.tokens.weth],
            fees: [500],
            pool: ADDRESS_ZERO,
            exchange: 3,
          });

          const rsEthPendleToken = IPendlePrincipalToken__factory.connect(
            addresses.tokens.pendleRsEth0624,
            owner.wallet,
          );
          await flashMintHyETH.approveSetToken(setToken.address);
          const rsEthSyToken = await rsEthPendleToken.SY();
          await flashMintHyETH.approveToken(
            rsEthSyToken,
            addresses.dexes.pendle.markets.rsEth0624,
            MAX_UINT_256,
          );
          await flashMintHyETH.setPendleMarket(
            addresses.tokens.pendleRsEth0624,
            rsEthSyToken,
            addresses.tokens.rsEth,
            addresses.dexes.pendle.markets.rsEth0624,
          );
          // rsEth -> weth pool: https://etherscan.io/address/0x059615ebf32c946aaab3d44491f78e4f8e97e1d3
          await flashMintHyETH.setSwapData(addresses.tokens.rsEth, ADDRESS_ZERO, {
            path: [addresses.tokens.rsEth, addresses.tokens.weth],
            fees: [500],
            pool: ADDRESS_ZERO,
            exchange: 3,
          });
        });
        it("setToken is deployed correctly", async () => {
          expect(await setToken.symbol()).to.eq(tokenSymbol);
        });

        it("Can issue set token from eth", async () => {
          const setTokenAmount = ether(1);
          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const ethBalanceBefore = await owner.wallet.getBalance();
          const maxEthIn = ether(1);
          await flashMintHyETH.issueExactSetFromETH(setToken.address, setTokenAmount, {
            value: maxEthIn,
          });
          const ethSpent = ethBalanceBefore.sub(await owner.wallet.getBalance());
          console.log("ethSpent", ethSpent.toString());
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
        });

        it("Can redeem set token for eth", async () => {
          const setTokenAmount = ether(1);
          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          await flashMintHyETH.issueExactSetFromETH(setToken.address, setTokenAmount, {
            value: ether(10),
          });
          const setTokenBalanceAfterIssuance = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfterIssuance).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          await setToken.approve(flashMintHyETH.address, setTokenAmount);
          const minETHOut = ether(0.45);
          await flashMintHyETH.redeemExactSetForETH(setToken.address, setTokenAmount, minETHOut);
          const setTokenBalanceAfterRedemption = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfterRedemption).to.eq(setTokenBalanceBefore);
        });
      });
    });
  });
}
