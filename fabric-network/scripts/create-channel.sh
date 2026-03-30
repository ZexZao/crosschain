#!/bin/bash
set -euo pipefail

CHANNEL_BLOCK="/fabric-network/fabric-network/runtime/channel-artifacts/mychannel.block"

peer channel create \
  -o orderer.example.com:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  -c mychannel \
  -f /fabric-network/fabric-network/runtime/channel-artifacts/mychannel.tx \
  --outputBlock "$CHANNEL_BLOCK" \
  --tls \
  --cafile "$ORDERER_CA"

peer channel join -b "$CHANNEL_BLOCK"

echo "Channel mychannel created and peer0.org1.example.com joined."
