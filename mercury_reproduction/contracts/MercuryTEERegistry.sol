// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MercuryVault.sol";

/// @notice Experiment registry kept separate from the h-xmsg TEE cluster so
/// the ablation cannot accidentally accept certificates from the main system.
contract MercuryTEERegistry is IMercuryTEERegistry {
    address public owner;
    uint64 public teeEpoch = 1;
    bytes32 public immutable clusterID;
    uint256 public activeTEECount;

    struct TEERegistration {
        address teeAddress;
        uint16 signerIndex;
        bytes32 enclavePubKeyHash;
        bytes32 measurement;
        bytes32 quoteHash;
        bytes32 initialSyncStateHash;
        uint64 epoch;
        uint64 notAfter;
        bytes attestationSignature;
    }
    struct TEEIdentity {
        bytes32 enclavePubKeyHash;
        bytes32 measurement;
        bytes32 quoteHash;
        bytes32 initialSyncStateHash;
        uint64 epoch;
        uint64 notAfter;
        uint16 signerIndex;
        bool active;
    }

    mapping(address => TEEIdentity) public teeIdentities;
    mapping(uint16 => address) public teeBySignerIndex;
    mapping(uint16 => bytes32) public enclavePubKeyHashByIndex;

    event TEERegistered(address indexed tee, uint16 indexed signerIndex, bytes32 indexed measurement);
    event TEERemoved(address indexed tee, uint16 indexed signerIndex);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(bytes32 clusterID_) {
        require(clusterID_ != bytes32(0), "bad cluster");
        owner = msg.sender;
        clusterID = clusterID_;
    }

    function registerTEE(TEERegistration calldata registration) external onlyOwner {
        require(registration.teeAddress != address(0), "bad tee");
        require(registration.epoch == teeEpoch, "bad tee epoch");
        require(registration.enclavePubKeyHash != bytes32(0), "missing enclave key");
        require(registration.measurement != bytes32(0), "missing measurement");
        require(registration.notAfter == 0 || registration.notAfter > block.timestamp, "attestation expired");
        require(teeBySignerIndex[registration.signerIndex] == address(0), "signer index used");
        bytes32 expectedQuoteHash = keccak256(abi.encode(
            "SIMULATED_TDX_QUOTE_V1", registration.teeAddress, registration.signerIndex,
            registration.enclavePubKeyHash, registration.measurement, registration.initialSyncStateHash,
            registration.epoch, registration.notAfter
        ));
        require(registration.quoteHash == expectedQuoteHash, "bad simulated quote");
        require(_recover(registrationDigest(registration), registration.attestationSignature) == registration.teeAddress,
            "bad attestation sig");
        teeBySignerIndex[registration.signerIndex] = registration.teeAddress;
        enclavePubKeyHashByIndex[registration.signerIndex] = registration.enclavePubKeyHash;
        teeIdentities[registration.teeAddress] = TEEIdentity({
            enclavePubKeyHash: registration.enclavePubKeyHash,
            measurement: registration.measurement,
            quoteHash: registration.quoteHash,
            initialSyncStateHash: registration.initialSyncStateHash,
            epoch: registration.epoch,
            notAfter: registration.notAfter,
            signerIndex: registration.signerIndex,
            active: true
        });
        activeTEECount += 1;
        emit TEERegistered(registration.teeAddress, registration.signerIndex, registration.measurement);
    }

    function removeTEE(address tee) external onlyOwner {
        TEEIdentity storage item = teeIdentities[tee];
        if (item.active) {
            item.active = false;
            activeTEECount -= 1;
            emit TEERemoved(tee, item.signerIndex);
        }
    }

    function isActiveTEE(address tee) public view returns (bool) {
        TEEIdentity memory item = teeIdentities[tee];
        return item.active && item.epoch == teeEpoch && (item.notAfter == 0 || item.notAfter > block.timestamp);
    }

    function quorumThreshold() public view returns (uint256) {
        require(activeTEECount > 0 && activeTEECount % 2 == 1, "cluster must be n=2f+1");
        return activeTEECount / 2 + 1;
    }

    function verifyClusterCertificate(bytes32 expectedDigest, ClusterCertificate calldata cert)
        external view returns (bool)
    {
        require(cert.clusterID == clusterID, "bad cluster");
        require(cert.epoch == teeEpoch, "bad cert epoch");
        require(cert.signingDigest == expectedDigest, "bad cert digest");
        require(cert.threshold == quorumThreshold(), "bad threshold");
        require(cert.participantCount >= cert.threshold, "below threshold");
        bytes[] memory signatures = abi.decode(cert.signatures, (bytes[]));
        require(signatures.length == cert.participantCount, "bad signature count");
        uint16 counted;
        uint16[] memory indexes = new uint16[](cert.participantCount);
        address[] memory signers = new address[](cert.participantCount);
        bytes32[] memory keyHashes = new bytes32[](cert.participantCount);
        for (uint16 i = 0; i < 256; i += 1) {
            if ((cert.signerBitmap & (uint256(1) << i)) == 0) continue;
            require(counted < cert.participantCount, "participant overflow");
            address tee = teeBySignerIndex[i];
            require(isActiveTEE(tee), "inactive tee");
            require(_recover(expectedDigest, signatures[counted]) == tee, "bad tee signature");
            indexes[counted] = i;
            signers[counted] = tee;
            keyHashes[counted] = enclavePubKeyHashByIndex[i];
            counted += 1;
        }
        require(counted == cert.participantCount, "bad participant count");
        require(keccak256(abi.encode(indexes, signers, keyHashes)) == cert.selectedSignerHash, "bad signer set");
        return true;
    }

    function registrationDigest(TEERegistration memory registration) public pure returns (bytes32) {
        return keccak256(abi.encode(
            "SIMULATED_TDX_QUOTE_V1", registration.teeAddress, registration.signerIndex,
            registration.enclavePubKeyHash, registration.measurement, registration.quoteHash,
            registration.initialSyncStateHash, registration.epoch, registration.notAfter
        ));
    }

    function _recover(bytes32 digest, bytes memory signature) private pure returns (address) {
        require(signature.length == 65, "bad signature");
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := mload(add(signature, 32)) s := mload(add(signature, 64)) v := byte(0, mload(add(signature, 96))) }
        if (v < 27) v += 27;
        return ecrecover(digest, v, r, s);
    }
}
