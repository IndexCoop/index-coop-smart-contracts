/*
    Copyright 2021 Set Labs Inc.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

    SPDX-License-Identifier: Apache License, Version 2.0
*/

pragma solidity 0.6.10;

/**
 * @title StringArrayUtils
 * @author Set Protocol
 *
 * Utility functions to handle String Arrays
 */
library StringArrayUtils {

    /**
     * Finds the index of the first occurrence of the given element.
     * @param A The input string to search
     * @param a The value to find
     * @return Returns (index and isIn) for the first occurrence starting from index 0
     */
    function indexOf(string[] memory A, string memory a) internal pure returns (uint256, bool) {
        uint256 length = A.length;
        for (uint256 i = 0; i < length; i++) {
            if (keccak256(bytes(A[i])) == keccak256(bytes(a))) {
                return (i, true);
            }
        }
        return (uint256(-1), false);
    }

    /**
    * Returns true if the value is present in the list. Uses indexOf internally.
    * @param A The input array to search
    * @param a The value to find
    * @return Returns isIn for the first occurrence starting from index 0
    */
    function contains(string[] memory A, string memory a) internal pure returns (bool) {
        (, bool isIn) = indexOf(A, a);
        return isIn;
    }

    /**
     * @param A The input array to search
     * @param a The string to remove
     * @return Returns the array with the object removed.
     */
    function remove(string[] memory A, string memory a)
        internal
        pure
        returns (string[] memory)
    {
        (uint256 index, bool isIn) = indexOf(A, a);
        if (!isIn) {
            revert("String not in array.");
        } else {
            (string[] memory _A,) = pop(A, index);
            return _A;
        }
    }

    /**
     * @param A The input array to search
     * @param a The string to remove
     */
    function removeStorage(string[] storage A, string memory a)
        internal
    {
        (uint256 index, bool isIn) = indexOf(A, a);
        if (!isIn) {
            revert("String not in array.");
        } else {
            uint256 lastIndex = A.length - 1; // If the array would be empty, the previous line would throw, so no underflow here
            if (index != lastIndex) { A[index] = A[lastIndex]; }
            A.pop();
        }
    }

    /**
    * Removes specified index from array
    * @param A The input array to search
    * @param index The index to remove
    * @return Returns the new array and the removed entry
    */
    function pop(string[] memory A, uint256 index)
        internal
        pure
        returns (string[] memory, string memory)
    {
        uint256 length = A.length;
        require(index < A.length, "Index must be < A length");
        string[] memory newStrings = new string[](length - 1);
        for (uint256 i = 0; i < index; i++) {
            newStrings[i] = A[i];
        }
        for (uint256 j = index + 1; j < length; j++) {
            newStrings[j - 1] = A[j];
        }
        return (newStrings, A[index]);
    }
}
