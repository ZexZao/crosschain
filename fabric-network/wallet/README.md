# Fabric Wallet

This directory stores local Fabric SDK identities, such as `appUser.id`.

Wallet files may contain private keys and must not be committed to GitHub.
Generate them locally on each machine after bootstrapping the Fabric network.

Recommended setup flow:

```bash
npm install

docker compose -f docker-compose.fabric.yml run --rm fabric-tools \
  bash /fabric-network/fabric-network/scripts/bootstrap.sh

docker compose -f docker-compose.fabric.yml up -d \
  fabric-ca.org1.example.com \
  orderer.example.com \
  peer0.org1.example.com \
  peer1.org1.example.com \
  peer2.org1.example.com \
  peer3.org1.example.com \
  fabric-tools

docker exec fabric-tools bash /fabric-network/fabric-network/scripts/create-channel.sh

node scripts/export-fabric-wallet.js
```

After the export step, the local machine should have:

```text
fabric-network/wallet/appUser.id
```

If the file was created by a Docker container and cannot be read by the host
user, fix ownership from the project root:

```bash
docker run --rm -v "$PWD":/work -w /work alpine sh -c \
  'chown -R 1000:1000 fabric-network/runtime fabric-network/wallet runtime'
```

