#!/bin/bash
set -euo pipefail

CHANNEL_BLOCK="/fabric-network/fabric-network/runtime/channel-artifacts/mychannel.block"

join_peer() {
  local peer_host="$1"
  local peer_port="$2"
  local tls_ca="$3"
  export CORE_PEER_ADDRESS="${peer_host}:${peer_port}"
  export CORE_PEER_TLS_ROOTCERT_FILE="$tls_ca"
  peer channel join -b "$CHANNEL_BLOCK"
}

peer channel create \
  -o orderer.example.com:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  -c mychannel \
  -f /fabric-network/fabric-network/runtime/channel-artifacts/mychannel.tx \
  --outputBlock "$CHANNEL_BLOCK" \
  --tls \
  --cafile "$ORDERER_CA"

join_peer "peer0.org1.example.com" "7051" "/fabric-network/fabric-network/runtime/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
join_peer "peer1.org1.example.com" "8051" "/fabric-network/fabric-network/runtime/organizations/peerOrganizations/org1.example.com/peers/peer1.org1.example.com/tls/ca.crt"
join_peer "peer2.org1.example.com" "9051" "/fabric-network/fabric-network/runtime/organizations/peerOrganizations/org1.example.com/peers/peer2.org1.example.com/tls/ca.crt"
join_peer "peer3.org1.example.com" "10051" "/fabric-network/fabric-network/runtime/organizations/peerOrganizations/org1.example.com/peers/peer3.org1.example.com/tls/ca.crt"

echo "Channel mychannel created and peer0-peer3.org1.example.com joined."
