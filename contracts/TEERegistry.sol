// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TEERegistry {
    bytes32 public constant CERTIFICATE_DOMAIN = keccak256("HXMSG_TEE_SUBNET_CERTIFICATE_V1");

    address public owner;

    struct ClusterConfig {
        bytes32 subnetIDHash;
        uint8 sourceChainType;
        uint64 epoch;
        uint256 activeTEECount;
        bool exists;
    }

    struct TEERegistration {
        bytes32 clusterID;
        bytes32 subnetIDHash;
        uint8 sourceChainType;
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

    struct ClusterCertificate {
        bytes32 clusterID;
        uint8 sourceChainType;
        bytes32 sourceChainID;
        uint64 epoch;
        uint16 threshold;
        uint16 participantCount;
        uint256 signerBitmap;
        bytes32 selectedSignerHash;
        bytes signatures;
        bytes32 signingDigest;
        bytes32 subjectDigest;
        uint64 committedTerm;
        uint64 committedIndex;
    }

    mapping(bytes32 => ClusterConfig) public clusters;
    mapping(bytes32 => mapping(address => TEEIdentity)) public teeIdentities;
    mapping(bytes32 => mapping(uint16 => address)) public teeBySignerIndex;
    mapping(bytes32 => mapping(uint16 => bytes32)) public enclavePubKeyHashByIndex;
    mapping(address => bytes32) public assignedCluster;

    event TEEClusterCreated(bytes32 indexed clusterID, bytes32 indexed subnetIDHash, uint8 indexed sourceChainType);
    event TEERegistered(bytes32 indexed clusterID, address indexed tee, uint16 indexed signerIndex, bytes32 measurement,
        bytes32 enclavePubKeyHash, bytes32 quoteHash, uint64 epoch, uint64 notAfter);
    event TEERemoved(bytes32 indexed clusterID, address indexed tee, uint16 indexed signerIndex);
    event TEEEpochAdvanced(bytes32 indexed clusterID, uint64 indexed epoch);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function registerTEE(TEERegistration calldata registration) external onlyOwner {
        require(registration.clusterID != bytes32(0), "bad cluster");
        require(registration.subnetIDHash != bytes32(0), "bad subnet");
        require(registration.sourceChainType != 0, "bad source type");
        require(registration.teeAddress != address(0), "bad tee");
        require(registration.enclavePubKeyHash != bytes32(0), "missing enclave key");
        require(registration.measurement != bytes32(0), "missing measurement");
        require(registration.quoteHash != bytes32(0), "missing quote");
        require(registration.notAfter == 0 || registration.notAfter > block.timestamp, "attestation expired");

        ClusterConfig storage cluster = clusters[registration.clusterID];
        if (!cluster.exists) {
            cluster.subnetIDHash = registration.subnetIDHash;
            cluster.sourceChainType = registration.sourceChainType;
            cluster.epoch = registration.epoch;
            cluster.exists = true;
            emit TEEClusterCreated(registration.clusterID, registration.subnetIDHash, registration.sourceChainType);
        } else {
            require(cluster.subnetIDHash == registration.subnetIDHash, "subnet mismatch");
            require(cluster.sourceChainType == registration.sourceChainType, "source type mismatch");
            require(cluster.epoch == registration.epoch, "bad tee epoch");
        }
        require(
            assignedCluster[registration.teeAddress] == bytes32(0)
                || assignedCluster[registration.teeAddress] == registration.clusterID,
            "TEE key already assigned to another subnet"
        );
        require(
            teeBySignerIndex[registration.clusterID][registration.signerIndex] == address(0)
                || teeBySignerIndex[registration.clusterID][registration.signerIndex] == registration.teeAddress,
            "signer index used"
        );

        bytes32 expectedQuoteHash = keccak256(abi.encode(
            "SIMULATED_TDX_QUOTE_V1", registration.clusterID, registration.subnetIDHash,
            registration.sourceChainType, registration.teeAddress, registration.signerIndex,
            registration.enclavePubKeyHash, registration.measurement, registration.initialSyncStateHash,
            registration.epoch, registration.notAfter
        ));
        require(registration.quoteHash == expectedQuoteHash, "bad simulated quote");
        require(_recover(registrationDigest(registration), registration.attestationSignature) == registration.teeAddress,
            "bad attestation sig");

        if (!teeIdentities[registration.clusterID][registration.teeAddress].active) cluster.activeTEECount += 1;
        assignedCluster[registration.teeAddress] = registration.clusterID;
        teeBySignerIndex[registration.clusterID][registration.signerIndex] = registration.teeAddress;
        enclavePubKeyHashByIndex[registration.clusterID][registration.signerIndex] = registration.enclavePubKeyHash;
        teeIdentities[registration.clusterID][registration.teeAddress] = TEEIdentity({
            enclavePubKeyHash: registration.enclavePubKeyHash,
            measurement: registration.measurement,
            quoteHash: registration.quoteHash,
            initialSyncStateHash: registration.initialSyncStateHash,
            epoch: registration.epoch,
            notAfter: registration.notAfter,
            signerIndex: registration.signerIndex,
            active: true
        });
        emit TEERegistered(registration.clusterID, registration.teeAddress, registration.signerIndex,
            registration.measurement, registration.enclavePubKeyHash, registration.quoteHash,
            registration.epoch, registration.notAfter);
    }

    function removeTEE(bytes32 clusterID, address tee) external onlyOwner {
        TEEIdentity storage identity = teeIdentities[clusterID][tee];
        if (identity.active) {
            identity.active = false;
            clusters[clusterID].activeTEECount -= 1;
            assignedCluster[tee] = bytes32(0);
            emit TEERemoved(clusterID, tee, identity.signerIndex);
        }
    }

    function isActiveTEE(bytes32 clusterID, address tee) public view returns (bool) {
        TEEIdentity memory identity = teeIdentities[clusterID][tee];
        ClusterConfig memory cluster = clusters[clusterID];
        return cluster.exists && identity.active && identity.epoch == cluster.epoch
            && (identity.notAfter == 0 || identity.notAfter > block.timestamp);
    }

    function quorumThreshold(bytes32 clusterID) public view returns (uint256) {
        uint256 count = clusters[clusterID].activeTEECount;
        require(count > 0, "empty tee cluster");
        return (count / 2) + 1;
    }

    function verifyClusterCertificate(bytes32 expectedSubjectDigest, ClusterCertificate calldata cert)
        external view returns (bool)
    {
        ClusterConfig memory cluster = clusters[cert.clusterID];
        require(cluster.exists, "unknown cluster");
        require(cert.sourceChainType == cluster.sourceChainType, "unauthorized source subnet");
        require(cert.sourceChainID != bytes32(0), "missing source chain");
        require(cert.epoch == cluster.epoch, "bad cert epoch");
        require(cert.subjectDigest == expectedSubjectDigest, "bad cert subject");
        bytes32 scopedDigest = certificateDigest(cert.clusterID, cert.epoch, cert.sourceChainType,
            cert.sourceChainID, expectedSubjectDigest);
        require(cert.signingDigest == scopedDigest, "bad scoped cert digest");
        require(cert.threshold == quorumThreshold(cert.clusterID), "bad threshold");
        require(cert.participantCount >= cert.threshold, "below threshold");

        bytes[] memory signatures = abi.decode(cert.signatures, (bytes[]));
        require(signatures.length == cert.participantCount, "bad signature count");
        uint16 counted = 0;
        uint16[] memory indexes = new uint16[](cert.participantCount);
        address[] memory signers = new address[](cert.participantCount);
        bytes32[] memory keyHashes = new bytes32[](cert.participantCount);
        uint256 remainingBitmap = cert.signerBitmap;
        for (uint16 i = 0; remainingBitmap != 0; i += 1) {
            if ((remainingBitmap & 1) != 0) {
                require(counted < cert.participantCount, "participant overflow");
                (address tee, bytes32 keyHash) = _verifySigner(
                    cert.clusterID, i, scopedDigest, signatures[counted]
                );
                indexes[counted] = i;
                signers[counted] = tee;
                keyHashes[counted] = keyHash;
                counted += 1;
            }
            remainingBitmap >>= 1;
        }
        require(counted == cert.participantCount, "bad participant count");
        require(keccak256(abi.encode(indexes, signers, keyHashes)) == cert.selectedSignerHash,
            "bad participant keys");
        return true;
    }

    function advanceEpoch(bytes32 clusterID) external onlyOwner {
        require(clusters[clusterID].exists, "unknown cluster");
        clusters[clusterID].epoch += 1;
        emit TEEEpochAdvanced(clusterID, clusters[clusterID].epoch);
    }

    function _verifySigner(bytes32 clusterID, uint16 signerIndex, bytes32 digest, bytes memory signature)
        private view returns (address tee, bytes32 keyHash)
    {
        tee = teeBySignerIndex[clusterID][signerIndex];
        require(tee != address(0) && isActiveTEE(clusterID, tee), "unknown or inactive signer");
        require(_recover(digest, signature) == tee, "bad tee signature");
        keyHash = enclavePubKeyHashByIndex[clusterID][signerIndex];
    }

    function certificateDigest(bytes32 clusterID, uint64 epoch, uint8 sourceChainType,
        bytes32 sourceChainID, bytes32 subjectDigest) public pure returns (bytes32)
    {
        return keccak256(abi.encode(CERTIFICATE_DOMAIN, clusterID, epoch, sourceChainType,
            sourceChainID, subjectDigest));
    }

    function registrationDigest(TEERegistration memory registration) public pure returns (bytes32) {
        return keccak256(abi.encode(
            "SIMULATED_TDX_QUOTE_V1", registration.clusterID, registration.subnetIDHash,
            registration.sourceChainType, registration.teeAddress, registration.signerIndex,
            registration.enclavePubKeyHash, registration.measurement, registration.quoteHash,
            registration.initialSyncStateHash, registration.epoch, registration.notAfter
        ));
    }

    function _recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        require(signature.length == 65, "bad sig length");
        bytes32 r; bytes32 s; uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "bad v");
        return ecrecover(digest, v, r, s);
    }
}
