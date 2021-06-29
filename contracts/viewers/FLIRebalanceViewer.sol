pragma solidity 0.6.10;

contract FLIRebalanceViewer {

    address public fliStrategyExtension;

    constructor(address _fliStrategyExtension) public {
        fliStrategyExtension = _fliStrategyExtension;
    }

}