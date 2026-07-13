// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../MercuryVault.sol";

contract MockTEERegistry is IMercuryTEERegistry {
    function verifyClusterCertificate(bytes32 expectedDigest, ClusterCertificate calldata cert)
        external
        pure
        returns (bool)
    {
        return cert.signingDigest == expectedDigest && cert.participantCount >= cert.threshold && cert.threshold > 0;
    }
}
