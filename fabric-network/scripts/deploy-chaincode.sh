#!/bin/bash
set -euo pipefail

ROOT_DIR="/fabric-network"
CC_NAME="${CC_NAME:-xcall}"
DEFAULT_SEQUENCE=1
CURRENT_SEQUENCE=$(
  peer lifecycle chaincode querycommitted --channelID mychannel --name "$CC_NAME" 2>/dev/null | \
  sed -n 's/^Version: .* Sequence: \([0-9][0-9]*\),.*/\1/p' | head -n 1
)
if [ -n "$CURRENT_SEQUENCE" ]; then
  DEFAULT_SEQUENCE=$((CURRENT_SEQUENCE + 1))
fi
CC_SEQUENCE="${CC_SEQUENCE:-$DEFAULT_SEQUENCE}"
CC_VERSION="${CC_VERSION:-${CC_SEQUENCE}.0}"
CC_LABEL="${CC_LABEL:-xcall_${CC_VERSION}}"
CC_SRC_PATH="$ROOT_DIR/fabric-chaincode/xcall"
CC_PACKAGE_FILE="$ROOT_DIR/fabric-network/runtime/channel-artifacts/${CC_LABEL}.tar.gz"

install_on_peer() {
  local peer_host="$1"
  local peer_port="$2"
  local tls_ca="$3"
  export CORE_PEER_ADDRESS="${peer_host}:${peer_port}"
  export CORE_PEER_TLS_ROOTCERT_FILE="$tls_ca"
  peer lifecycle chaincode install "$CC_PACKAGE_FILE" || true
}

rm -f "$CC_PACKAGE_FILE"
peer lifecycle chaincode package "$CC_PACKAGE_FILE" --path "$CC_SRC_PATH" --lang node --label "$CC_LABEL"

install_on_peer "peer0.org1.example.com" "7051" "/fabric-network/fabric-network/runtime/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
install_on_peer "peer1.org1.example.com" "8051" "/fabric-network/fabric-network/runtime/organizations/peerOrganizations/org1.example.com/peers/peer1.org1.example.com/tls/ca.crt"
install_on_peer "peer2.org1.example.com" "9051" "/fabric-network/fabric-network/runtime/organizations/peerOrganizations/org1.example.com/peers/peer2.org1.example.com/tls/ca.crt"
install_on_peer "peer3.org1.example.com" "10051" "/fabric-network/fabric-network/runtime/organizations/peerOrganizations/org1.example.com/peers/peer3.org1.example.com/tls/ca.crt"

export CORE_PEER_ADDRESS="peer0.org1.example.com:7051"
export CORE_PEER_TLS_ROOTCERT_FILE="/fabric-network/fabric-network/runtime/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"

PACKAGE_ID=$(
  peer lifecycle chaincode queryinstalled | \
  sed -n "s/^Package ID: \\(.*\\), Label: ${CC_LABEL}$/\\1/p" | head -n 1
)

if [ -z "$PACKAGE_ID" ]; then
  echo "Failed to resolve package ID for ${CC_LABEL}" >&2
  exit 1
fi

peer lifecycle chaincode approveformyorg \
  -o orderer.example.com:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  --tls \
  --cafile "$ORDERER_CA" \
  --channelID mychannel \
  --name "$CC_NAME" \
  --version "$CC_VERSION" \
  --package-id "$PACKAGE_ID" \
  --sequence "$CC_SEQUENCE"

peer lifecycle chaincode commit \
  -o orderer.example.com:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  --tls \
  --cafile "$ORDERER_CA" \
  --channelID mychannel \
  --name "$CC_NAME" \
  --version "$CC_VERSION" \
  --sequence "$CC_SEQUENCE" \
  --peerAddresses peer0.org1.example.com:7051 \
  --tlsRootCertFiles /fabric-network/fabric-network/runtime/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt \
  --peerAddresses peer1.org1.example.com:8051 \
  --tlsRootCertFiles /fabric-network/fabric-network/runtime/organizations/peerOrganizations/org1.example.com/peers/peer1.org1.example.com/tls/ca.crt \
  --peerAddresses peer2.org1.example.com:9051 \
  --tlsRootCertFiles /fabric-network/fabric-network/runtime/organizations/peerOrganizations/org1.example.com/peers/peer2.org1.example.com/tls/ca.crt \
  --peerAddresses peer3.org1.example.com:10051 \
  --tlsRootCertFiles /fabric-network/fabric-network/runtime/organizations/peerOrganizations/org1.example.com/peers/peer3.org1.example.com/tls/ca.crt

echo "Chaincode ${CC_NAME} committed with package ID ${PACKAGE_ID}"
