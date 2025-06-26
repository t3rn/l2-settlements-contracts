// contracts/ERC20Mock.sol
// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract BRN is ERC20, Ownable {

    constructor(address _owner, string memory name, string memory symbol) ERC20(name, symbol) {
        // Prevent fat fingers
        require(_owner != address(0), "Owner address cannot be zero");
        // Transfer ownership to the provided _owner address
        _transferOwnership(_owner);
    }

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) public onlyOwner {
        _burn(from, amount);
    }
}
