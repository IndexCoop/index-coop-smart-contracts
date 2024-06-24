import "module-alias/register";

import { Account } from "@utils/types";
import { Prt } from "@utils/contracts/index";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
} from "@utils/index";
import { StandardTokenMock } from "@typechain/StandardTokenMock";

const expect = getWaffleExpect();

describe("Prt", async () => {
  const prtName = "High Yield ETH Index PRT Token";
  const prtSymbol = "prtHyETH";
  const prtSupply = ether(10_000);

  let owner: Account;
  let deployer: DeployHelper;
  let setToken: StandardTokenMock;

  before(async () => {
    [ owner ] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);
    setToken = await deployer.mocks.deployStandardTokenMock(owner.address, 18);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    async function subject(): Promise<Prt> {
      return deployer.token.deployPrt(
        prtName,
        prtSymbol,
        setToken.address,
        owner.address,
        prtSupply
      );
    }

    it("should set the state variables correctly", async () => {
      const prt = await subject();
      expect(await prt.decimals()).to.eq(18);
      expect(await prt.totalSupply()).to.eq(prtSupply);
      expect(await prt.name()).to.eq(prtName);
      expect(await prt.symbol()).to.eq(prtSymbol);
    });

    it("should distribute the PRT to the owner", async () => {
      const prt = await subject();
      expect(await prt.balanceOf(owner.address)).to.eq(prtSupply);
    });
  });
});
