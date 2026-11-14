// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Forwarder} from "./Forwarder.sol";

contract ForwarderFactory {
    address public immutable sink;
    address public immutable implementation;

    constructor(address sink_) {
        require(sink_ != address(0), "zero sink");
        sink = sink_;
        implementation = address(new Forwarder(sink_));
    }

    function predict(bytes32 salt) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, salt, address(this));
    }

    /// Only the sink (the hot wallet) may sweep: a third party must never be able to empty a deposit
    /// address before the gateway has credited it.
    function deployAndFlush(bytes32[] calldata salts, address[] calldata tokens) external {
        require(msg.sender == sink, "only sink");
        for (uint256 i = 0; i < salts.length; i++) {
            address f = predict(salts[i]);
            if (f.code.length == 0) {
                Clones.cloneDeterministic(implementation, salts[i]);
            }
            Forwarder(payable(f)).flush(tokens);
        }
    }
}
