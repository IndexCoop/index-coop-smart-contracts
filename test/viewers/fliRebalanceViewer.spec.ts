import "module-alias/register";

import { FLIRebalanceViewer } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import { getAccounts, getRandomAddress, getWaffleExpect } from "@utils/test";
import { Account, Address } from "@utils/types";

const expect = getWaffleExpect();

describe("FLIRebalanceViewer", async () => {

  let owner: Account;
  let deployer: DeployHelper;

  before(async () => {
    [ owner ] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);
  });

  describe("#constructor", async () => {

    let subjectFLIStrategyExtension: Address;
    let subjectUniV3Quoter: Address;
    let subjectUniV2Router: Address;
    let subjectUniV3Name: string;
    let subjectUniV2Name: string;

    beforeEach(async () => {
      subjectFLIStrategyExtension = await getRandomAddress();
      subjectUniV3Quoter = await getRandomAddress();
      subjectUniV2Router =  await getRandomAddress();
      subjectUniV3Name = "UniswapV3ExchangeAdapter";
      subjectUniV2Name = "SushiswapExchangeAdapter";
    });

    async function subject(): Promise<FLIRebalanceViewer> {
      return deployer.viewers.deployFLIRebalanceViewer(
        subjectFLIStrategyExtension,
        subjectUniV3Quoter,
        subjectUniV2Router,
        subjectUniV3Name,
        subjectUniV2Name
      );
    }

    it("should set the correct state variables", async () => {
      const viewer = await subject();

      expect(await viewer.fliStrategyExtension()).to.eq(subjectFLIStrategyExtension);
      expect(await viewer.uniswapV3Quoter()).to.eq(subjectUniV3Quoter);
      expect(await viewer.uniswapV2Router()).to.eq(subjectUniV2Router);
      expect(await viewer.uniswapV3ExchangeName()).to.eq(subjectUniV3Name);
      expect(await viewer.uniswapV2ExchangeName()).to.eq(subjectUniV2Name);
    });
  });
});