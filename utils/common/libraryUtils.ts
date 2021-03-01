import { utils } from "ethers";
import { artifacts } from "hardhat";
import { Artifact } from "hardhat/types";
import path from "path";
import globby from "globby";

// If libraryName corresponds to more than one artifact (e.g there are
// duplicate contract names in the project), `readArtifactSync`
// will throw. In such cases it"s necessary to pass this method the fully qualified
// contract name. ex: `contracts/mocks/LibraryMock.sol:LibraryMock`
export function convertLibraryNameToLinkId(libraryName: string): string {
  let artifact;
  let fullyQualifiedName;

  if (libraryName.includes(path.sep) && libraryName.includes(":")) {
    fullyQualifiedName = libraryName;
  } else {
    artifact = getArtifact(libraryName);
    fullyQualifiedName = `${artifact.sourceName}:${artifact.contractName}`;
  }

  const hashedName = utils.keccak256(utils.toUtf8Bytes(fullyQualifiedName));
  return `__$${hashedName.slice(2).slice(0, 34)}$__`;
}

// Tries to resolve via hardhat artifacts helpers, then by searching for appropriately
// named jsons in the root `external` folder
function getArtifact(libraryName: string): Artifact {
  try {
    return artifacts.readArtifactSync(libraryName);
  } catch (e) {
    /* ignore */
  }

  const files = globby.sync("external", {
    expandDirectories: { extensions: ["json"], },
  });

  const matches = files.filter(f => f.includes(`/${libraryName}.json`));

  if (!matches.length) {
    throw new Error(`Unable to find artifact for '${libraryName}' while linking.`);
  }

  if (matches.length > 1) {
    throw new Error(
      `Unable to resolve '${libraryName}' while linking. ` +
      `(More than one file name matches in 'external/')`
    );
  }

  const pathToArtifact = path.join(process.cwd(), matches[0]);
  return require(pathToArtifact);
}
