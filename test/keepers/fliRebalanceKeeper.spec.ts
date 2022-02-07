import { FliRebalanceKeeper__factory } from "../../typechain/factories/FliRebalanceKeeper__factory";
import { addSnapshotBeforeRestoreAfterEach, getAccounts } from "@utils/test";
import { Account } from "@utils/types";
import { FliRebalanceKeeper } from "../../typechain/FliRebalanceKeeper";
import { expect } from "chai";

describe("fliRebalanceKeeper", async () => {

    let owner: Account;

    before(async () => {
        [
            owner,
        ] = await getAccounts();
    });

    addSnapshotBeforeRestoreAfterEach();

    describe("#constructor", async () => {
        async function subject(): Promise<FliRebalanceKeeper> {
            return new FliRebalanceKeeper__factory(owner.wallet).deploy(owner.address);
        }

        it("should have the correct fliExtension address", async () => {
            const keeper = await subject();
            expect(keeper.fliExtension()).to.eq(owner.address);
        });
    });

    describe("#checkUpkeep", async () => {

    });

    describe("#performUpkeep", async () => {
    });
});
