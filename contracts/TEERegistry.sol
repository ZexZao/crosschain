// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TEERegistry {
    address public owner;
    uint64 public teeEpoch = 1;
    bytes32 public clusterID = keccak256("HXMSG_TEE_CLUSTER_LOCAL_V1");
    uint256 public activeTEECount;

    mapping(address => TEEIdentity) public teeIdentities;
    mapping(uint16 => address) public teeBySignerIndex;
    mapping(uint16 => bytes32) public blsPublicKeyHashByIndex;

    struct TEERegistration {
        address teeAddress;
        uint16 signerIndex;
        bytes32 enclavePubKeyHash;
        bytes32 blsPublicKeyHash;
        bytes32 measurement;
        bytes32 quoteHash;
        bytes32 initialSyncStateHash;
        uint64 epoch;
        uint64 notAfter;
        bytes attestationSignature;
    }

    struct TEEIdentity {
        bytes32 enclavePubKeyHash;
        bytes32 blsPublicKeyHash;
        bytes32 measurement;
        bytes32 quoteHash;
        bytes32 initialSyncStateHash;
        uint64 epoch;
        uint64 notAfter;
        uint16 signerIndex;
        bool active;
    }

    struct ClusterCertificate {
        bytes32 clusterID;
        uint64 epoch;
        uint16 threshold;
        uint16 participantCount;
        uint256 signerBitmap;
        bytes32 selectedPublicKeyHash;
        bytes32 aggregatePublicKeyHash;
        bytes aggregateSignature;
        bytes32 signingDigest;
        uint64 committedTerm;
        uint64 committedIndex;
    }

    event TEERegistered(
        address indexed tee,
        uint16 indexed signerIndex,
        bytes32 indexed measurement,
        bytes32 enclavePubKeyHash,
        bytes32 blsPublicKeyHash,
        bytes32 quoteHash,
        uint64 epoch,
        uint64 notAfter
    );
    event TEERemoved(address indexed tee, uint16 indexed signerIndex);
    event TEEEpochAdvanced(uint64 indexed epoch);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function registerTEE(TEERegistration calldata registration) external onlyOwner {
        require(registration.teeAddress != address(0), "bad tee");
        require(registration.epoch == teeEpoch, "bad tee epoch");
        require(registration.enclavePubKeyHash != bytes32(0), "missing enclave key");
        require(registration.blsPublicKeyHash != bytes32(0), "missing bls key");
        require(registration.measurement != bytes32(0), "missing measurement");
        require(registration.quoteHash != bytes32(0), "missing quote");
        require(registration.notAfter == 0 || registration.notAfter > block.timestamp, "attestation expired");
        require(
            teeBySignerIndex[registration.signerIndex] == address(0)
                || teeBySignerIndex[registration.signerIndex] == registration.teeAddress,
            "signer index used"
        );

        bytes32 expectedQuoteHash = keccak256(
            abi.encode(
                "SIMULATED_TDX_QUOTE_V1",
                registration.teeAddress,
                registration.signerIndex,
                registration.enclavePubKeyHash,
                registration.blsPublicKeyHash,
                registration.measurement,
                registration.initialSyncStateHash,
                registration.epoch,
                registration.notAfter
            )
        );
        require(registration.quoteHash == expectedQuoteHash, "bad simulated quote");
        require(_recover(registrationDigest(registration), registration.attestationSignature) == registration.teeAddress, "bad attestation sig");

        if (!teeIdentities[registration.teeAddress].active) {
            activeTEECount += 1;
        }
        teeBySignerIndex[registration.signerIndex] = registration.teeAddress;
        blsPublicKeyHashByIndex[registration.signerIndex] = registration.blsPublicKeyHash;
        teeIdentities[registration.teeAddress] = TEEIdentity({
            enclavePubKeyHash: registration.enclavePubKeyHash,
            blsPublicKeyHash: registration.blsPublicKeyHash,
            measurement: registration.measurement,
            quoteHash: registration.quoteHash,
            initialSyncStateHash: registration.initialSyncStateHash,
            epoch: registration.epoch,
            notAfter: registration.notAfter,
            signerIndex: registration.signerIndex,
            active: true
        });

        emit TEERegistered(
            registration.teeAddress,
            registration.signerIndex,
            registration.measurement,
            registration.enclavePubKeyHash,
            registration.blsPublicKeyHash,
            registration.quoteHash,
            registration.epoch,
            registration.notAfter
        );
    }

    function removeTEE(address tee) external onlyOwner {
        TEEIdentity memory identity = teeIdentities[tee];
        if (identity.active) {
            activeTEECount -= 1;
            teeIdentities[tee].active = false;
            emit TEERemoved(tee, identity.signerIndex);
        }
    }

    function isActiveTEE(address tee) public view returns (bool) {
        TEEIdentity memory identity = teeIdentities[tee];
        return identity.active
            && identity.epoch == teeEpoch
            && (identity.notAfter == 0 || identity.notAfter > block.timestamp);
    }

    function quorumThreshold() public view returns (uint256) {
        require(activeTEECount > 0, "empty tee cluster");
        return (activeTEECount / 2) + 1;
    }

    function verifyClusterCertificate(bytes32 expectedDigest, ClusterCertificate calldata cert) external view returns (bool) {
        require(cert.clusterID == clusterID, "bad cluster");
        require(cert.epoch == teeEpoch, "bad cert epoch");
        require(cert.signingDigest == expectedDigest, "bad cert digest");
        require(cert.threshold == quorumThreshold(), "bad threshold");
        require(cert.participantCount >= cert.threshold, "below threshold");
        require(cert.aggregateSignature.length == 96, "bad bls signature length");
        require(cert.aggregatePublicKeyHash != bytes32(0), "missing aggregate key");

        uint16 counted = 0;
        uint16[] memory indexes = new uint16[](cert.participantCount);
        bytes32[] memory keyHashes = new bytes32[](cert.participantCount);
        for (uint16 i = 0; i < 256; i += 1) {
            if ((cert.signerBitmap & (uint256(1) << i)) != 0) {
                require(counted < cert.participantCount, "participant overflow");
                address tee = teeBySignerIndex[i];
                require(tee != address(0), "unknown signer");
                require(isActiveTEE(tee), "inactive tee");
                indexes[counted] = i;
                keyHashes[counted] = blsPublicKeyHashByIndex[i];
                counted += 1;
            }
        }
        require(counted == cert.participantCount, "bad participant count");
        require(keccak256(abi.encode(indexes, keyHashes)) == cert.selectedPublicKeyHash, "bad participant keys");
        return true;
    }

    function advanceEpoch() external onlyOwner {
        teeEpoch += 1;
        emit TEEEpochAdvanced(teeEpoch);
    }

    function registrationDigest(TEERegistration memory registration) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                "SIMULATED_TDX_QUOTE_V1",
                registration.teeAddress,
                registration.signerIndex,
                registration.enclavePubKeyHash,
                registration.blsPublicKeyHash,
                registration.measurement,
                registration.quoteHash,
                registration.initialSyncStateHash,
                registration.epoch,
                registration.notAfter
            )
        );
    }

    function _recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        require(signature.length == 65, "bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "bad v");
        return ecrecover(digest, v, r, s);
    }
}
