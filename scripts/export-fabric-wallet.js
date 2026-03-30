const fs = require('fs-extra');
const path = require('path');

async function main() {
  let Wallets;
  try {
    ({ Wallets } = require('fabric-network'));
  } catch (error) {
    throw new Error('fabric-network package is not installed. Run npm install first.');
  }

  const projectRoot = path.join(__dirname, '..');
  const walletPath = path.join(projectRoot, 'fabric-network', 'wallet');
  const certPath = path.join(
    projectRoot,
    'fabric-network',
    'runtime',
    'organizations',
    'peerOrganizations',
    'org1.example.com',
    'users',
    'Admin@org1.example.com',
    'msp',
    'signcerts',
    'Admin@org1.example.com-cert.pem'
  );
  const keyDir = path.join(
    projectRoot,
    'fabric-network',
    'runtime',
    'organizations',
    'peerOrganizations',
    'org1.example.com',
    'users',
    'Admin@org1.example.com',
    'msp',
    'keystore'
  );

  if (!fs.existsSync(certPath) || !fs.existsSync(keyDir)) {
    throw new Error('Fabric MSP material not found. Run the bootstrap step first.');
  }

  const keyFiles = fs.readdirSync(keyDir);
  if (keyFiles.length === 0) {
    throw new Error('No private key found in Fabric keystore');
  }

  const certificate = fs.readFileSync(certPath, 'utf8');
  const privateKey = fs.readFileSync(path.join(keyDir, keyFiles[0]), 'utf8');

  const wallet = await Wallets.newFileSystemWallet(walletPath);
  await wallet.put('appUser', {
    credentials: { certificate, privateKey },
    mspId: 'Org1MSP',
    type: 'X.509'
  });

  console.log(JSON.stringify({
    ok: true,
    walletPath,
    identity: 'appUser'
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
