#!/bin/bash
set -euo pipefail

PAYLOAD_JSON='{"op":"asset_lock","assetId":"FABRIC-DEMO-001","owner":"org1.userA","amount":"88.00"}'

if [ "${1:-}" = "--payload-file" ]; then
  if [ -z "${2:-}" ]; then
    echo "Missing payload file after --payload-file" >&2
    exit 1
  fi
  PAYLOAD_JSON="$(cat "$2")"
elif [ -n "${1:-}" ]; then
  PAYLOAD_JSON="$1"
fi

ESCAPED_PAYLOAD=${PAYLOAD_JSON//\\/\\\\}
ESCAPED_PAYLOAD=${ESCAPED_PAYLOAD//\"/\\\"}

peer chaincode invoke \
  -o orderer.example.com:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  --tls \
  --cafile "$ORDERER_CA" \
  -C mychannel \
  -n xcall \
  --peerAddresses peer0.org1.example.com:7051 \
  --tlsRootCertFiles /fabric-network/fabric-network/runtime/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt \
  -c "{\"function\":\"EmitXCall\",\"Args\":[\"${ESCAPED_PAYLOAD}\"]}"
