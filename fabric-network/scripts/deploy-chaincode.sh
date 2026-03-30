#!/bin/bash
set -euo pipefail

ROOT_DIR="/fabric-network"
CC_NAME="${CC_NAME:-xcall}"
CC_LABEL="${CC_LABEL:-xcall_1.0}"
CC_VERSION="${CC_VERSION:-1.0}"
CC_SEQUENCE="${CC_SEQUENCE:-1}"
CC_SRC_PATH="$ROOT_DIR/fabric-chaincode/xcall"
CC_PACKAGE_FILE="$ROOT_DIR/fabric-network/runtime/channel-artifacts/${CC_LABEL}.tar.gz"

if [ ! -f "$CC_PACKAGE_FILE" ]; then
  peer lifecycle chaincode package "$CC_PACKAGE_FILE" --path "$CC_SRC_PATH" --lang node --label "$CC_LABEL"
fi

peer lifecycle chaincode install "$CC_PACKAGE_FILE" || true

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
  --tlsRootCertFiles /fabric-network/fabric-network/runtime/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt

echo "Chaincode ${CC_NAME} committed with package ID ${PACKAGE_ID}"
