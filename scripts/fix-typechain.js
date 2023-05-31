const replace = require("replace-in-file");
const fs = require('fs');

let changedFiles;

// Step 1: Replace all exports of classes to be declarations and to change to regular .ts files
const options1 = {
  //Glob(s)
  files: ["./typechain/*.d.ts"],

  //Replacement to make (string or regex)
  from: /export class/g,
  to: "export declare class",
};

try {
  changedFiles = replace.sync(options1);
  console.log(
    "Step 1. Typechain fixing modified files:",
    changedFiles.map((f) => f.file.toString()).join(", "),
  );
} catch (error) {
  console.error("Error occurred:", error);
}

// Step 2: Replace all ethers.utils.Interface with just Interface
const options2 = {
  //Glob(s)
  files: ["./typechain/*.ts"],

  //Replacement to make (string or regex)
  from: /ethers\.utils\.Interface/g,
  to: "Interface",
};

try {
  changedFiles = replace.sync(options2);
  console.log(
    "Step 2. Typechain fixing modified files:",
    changedFiles.map((f) => f.file.toString()).join(", "),
  );
} catch (error) {
  console.error("Error occurred:", error);
}

// Step 3: Fix import of Interface to come from @ethersproject/abi
const options3 = {
  //Glob(s)
  files: ["./typechain/*.ts"],

  //Replacement to make (string or regex)
  from: /import { FunctionFragment, EventFragment, Result } from \"@ethersproject\/abi\"/g,
  to: 'import { FunctionFragment, EventFragment, Result, Interface } from "@ethersproject/abi"',
};

try {
  changedFiles = replace.sync(options3);
  console.log(
    "Step 3. Typechain fixing modified files:",
    changedFiles.map((f) => f.file.toString()).join(", "),
  );
} catch (error) {
  console.error("Error occurred:", error);
}

// Step 4: Remove duplicate lines due to using multiple versions of openzeppelin contracts to avoid duplciate identifier error
// See: https://forum.openzeppelin.com/t/duplicate-identifier-initializable-with-typechain/34349
// NOTE: If a class is not longer duplicated it has to be removed from the list
// TODO: Refactor so that it automatically detects duplicates
//
//

function findDuplicateLines(filename) {
    let data = fs.readFileSync(filename, 'utf8')

    data = data.toString().split('\n')
    console.log("data", data)

    // this will remove duplicates from the array
    let duplicateLines = data.filter((item, pos) => data.indexOf(item) !== pos)
    console.log('duplicateLines', duplicateLines)
    // remove empty lines
    duplicateLines = duplicateLines.filter((item) => item.trim() !== '')
    return duplicateLines;
}

const duplicateLines = findDuplicateLines('./typechain/index.ts');
const options4 = duplicateLines.map((line) => {
  return {
      files: ["./typechain/index.ts"],
      // Delete first occurance to remove duplicate definition
      from: line,
      to: "",
    }
});

for (const options of options4) {
  try {
    changedFiles = replace.sync(options);
    console.log("Step 4. Removing duplicate line in typechain/index", options.from);
  } catch (error) {
    console.error("Error occurred:", error);
  }
}
