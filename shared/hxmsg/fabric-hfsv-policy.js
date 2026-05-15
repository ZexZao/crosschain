const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('ethers');
const { hashJson } = require('./hash');

function normalizePem(pem) {
  const text = Buffer.isBuffer(pem) || pem instanceof Uint8Array
    ? Buffer.from(pem).toString('utf8')
    : String(pem || '');
  return text.replace(/\r\n/g, '\n').trim();
}

function sha256Text(value) {
  return ethers.sha256(ethers.toUtf8Bytes(value));
}

function defaultProjectRoot() {
  return process.env.PROJECT_ROOT || path.resolve(__dirname, '..', '..');
}

function defaultMspRootCertPath(projectRoot = defaultProjectRoot()) {
  return process.env.FABRIC_MSP_ROOT_CERT_PATH ||
    path.join(projectRoot, 'fabric-network', 'runtime', 'organizations',
      'peerOrganizations', 'org1.example.com', 'msp', 'cacerts',
      'ca.org1.example.com-cert.pem');
}

function readMspRootHashes(requiredOrgs, projectRoot = defaultProjectRoot()) {
  const configured = process.env.FABRIC_MSP_ROOT_HASHES_JSON;
  if (configured) return JSON.parse(configured);

  const certPath = defaultMspRootCertPath(projectRoot);
  const rootHashes = {};
  for (const org of requiredOrgs) {
    if (fs.existsSync(certPath)) {
      rootHashes[org] = [sha256Text(normalizePem(fs.readFileSync(certPath)))];
    } else {
      rootHashes[org] = ['UNAVAILABLE_LOCAL_MSP_ROOT'];
    }
  }
  return rootHashes;
}

function buildFabricHFsvPolicy({
  securityDomain = 'fabric-local-domain',
  channelID,
  chaincodeName,
  requiredOrgs = ['Org1MSP'],
  rule = 'AND',
  threshold,
  allowedQueryFunctions = ['QueryCrosschainEvent'],
  projectRoot,
}) {
  if (!channelID) throw new Error('channelID is required for h-FSV policy');
  if (!chaincodeName) throw new Error('chaincodeName is required for h-FSV policy');
  const policyID = `fabric-${channelID}-hfsv-v1`;
  const policy = {
    policyType: 'FabricEndorsementPolicy',
    policyID,
    securityDomain,
    channelID,
    chaincodeName,
    requiredOrgs,
    rule,
    mspRootHash: hashJson(readMspRootHashes(requiredOrgs, projectRoot)),
    allowedQueryFunctions,
  };
  if (rule === 'THRESHOLD') {
    policy.threshold = Number(threshold || requiredOrgs.length);
  }
  return policy;
}

function parseCsvEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function buildDefaultFabricHFsvPolicy({ channelID, chaincodeName, projectRoot }) {
  const requiredOrgs = parseCsvEnv('HFSV_REQUIRED_ORGS', ['Org1MSP']);
  const rule = process.env.HFSV_POLICY_RULE || 'AND';
  return buildFabricHFsvPolicy({
    securityDomain: process.env.HFSV_SECURITY_DOMAIN || 'fabric-local-domain',
    channelID,
    chaincodeName,
    requiredOrgs,
    rule,
    threshold: process.env.HFSV_POLICY_THRESHOLD,
    allowedQueryFunctions: parseCsvEnv('HFSV_ALLOWED_QUERY_FUNCTIONS', ['QueryCrosschainEvent']),
    projectRoot,
  });
}

function buildFabricHFsvPolicyHash(policyArgs) {
  return hashJson(buildFabricHFsvPolicy(policyArgs));
}

module.exports = {
  buildFabricHFsvPolicy,
  buildDefaultFabricHFsvPolicy,
  buildFabricHFsvPolicyHash,
  normalizePem,
  sha256Text,
};
