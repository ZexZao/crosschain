#!/bin/bash
set -euo pipefail

ROOT_DIR="/fabric-network"
RUNTIME_DIR="$ROOT_DIR/fabric-network/runtime"
mkdir -p "$RUNTIME_DIR/organizations" "$RUNTIME_DIR/system-genesis-block" "$RUNTIME_DIR/channel-artifacts" "$RUNTIME_DIR/ca/org1"

if [ ! -f "$RUNTIME_DIR/organizations/peerOrganizations/org1.example.com/msp/config.yaml" ]; then
  cryptogen generate \
    --config="$ROOT_DIR/fabric-network/crypto-config.yaml" \
    --output="$RUNTIME_DIR/organizations"
fi

if [ ! -f "$RUNTIME_DIR/system-genesis-block/genesis.block" ]; then
  configtxgen \
    -profile OneOrgOrdererGenesis \
    -channelID system-channel \
    -configPath "$ROOT_DIR/fabric-network" \
    -outputBlock "$RUNTIME_DIR/system-genesis-block/genesis.block"
fi

if [ ! -f "$RUNTIME_DIR/channel-artifacts/mychannel.tx" ]; then
  configtxgen \
    -profile OneOrgChannel \
    -channelID mychannel \
    -configPath "$ROOT_DIR/fabric-network" \
    -outputCreateChannelTx "$RUNTIME_DIR/channel-artifacts/mychannel.tx"
fi

echo "Fabric crypto material and channel artifacts are ready under $RUNTIME_DIR"
