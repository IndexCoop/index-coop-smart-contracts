import "module-alias/register";
import { addSnapshotBeforeRestoreAfterEach, getAccounts, getWaffleExpect } from "@utils/index";
import { Account } from "@utils/types";
import { FliRebalanceKeeper } from "../../typechain/FliRebalanceKeeper";
import DeployHelper from "@utils/deploys";
import { ZERO_BYTES } from "@utils/constants";

const expect = getWaffleExpect();

describe("fliRebalanceKeeper", async () => {

    let owner: Account;
    let deployer: DeployHelper;

    before(async () => {
        [
            owner,
        ] = await getAccounts();

        deployer = new DeployHelper(owner.wallet);
    });

    addSnapshotBeforeRestoreAfterEach();

    describe("#checkUpkeep", async () => {
        let subjectKeeper: FliRebalanceKeeper;

        beforeEach(async () => {
            subjectKeeper = await deployer.keepers.deployFliRebalanceKeeper(owner.address);
        });

        async function subject(): Promise<any> {
            return subjectKeeper.checkUpkeep(ZERO_BYTES);
        }

        it("should revert", async () => {
            await expect(subject()).to.be.reverted;
        });
    });

    describe("#performUpkeep", async () => {
    });
});
