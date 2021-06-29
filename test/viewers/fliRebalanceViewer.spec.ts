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

    beforeEach(async () => {
      subjectFLIStrategyExtension = await getRandomAddress();
    });

    async function subject(): Promise<FLIRebalanceViewer> {
      return deployer.viewers.deployFLIRebalanceViewer(subjectFLIStrategyExtension);
    }

    it("should set the correct state variables", async () => {
      const viewer = await subject();
      const strategyExtension = await viewer.fliStrategyExtension();

      expect(strategyExtension).to.eq(subjectFLIStrategyExtension);
    });
  });
});