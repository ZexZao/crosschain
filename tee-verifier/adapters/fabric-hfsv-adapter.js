const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { Gateway, Wallets } = require('fabric-network');
const { msp, protos } = require('fabric-protos');
const {
  ChainType,
  VerificationMethod,
  RefType,
  PolicyType,
  decodeJsonRef,
  hashBytes,
  hashJson,
  buildDefaultFabricHFsvPolicy,
  normalizePem,
} = require('../../shared/hxmsg');
const { buildFabricSourceRecordHash } = require('../../hxmsg-builder/fabric-to-evm');
const { verifyFabricBlockContainsTx } = require('./fabric-block');

function getTransactionResponsePayload(proposalResponse) {
  const proposalResponsePayload = protos.ProposalResponsePayload.decode(proposalResponse.payload);
  const chaincodeAction = protos.ChaincodeAction.decode(proposalResponsePayload.extension);
  if (!chaincodeAction.response) {
    throw new Error('Fabric peer response missing chaincode action response');
  }
  return Buffer.from(chaincodeAction.response.payload || []);
}

function normalizeCertMaybe(value) {
  if (!value) return '';
  if (typeof value === 'object' && value.pem) return normalizePem(value.pem);
  let text = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value).toString('utf8')
    : String(value);
  text = text.trim();
  if (!text.includes('BEGIN CERTIFICATE') && /^[0-9a-fA-F]+$/.test(text)) {
    text = Buffer.from(text, 'hex').toString('utf8');
  }
  return normalizePem(text);
}

function certificateIsIssuedByAnyRoot(certPem, mspConfig) {
  const cert = new crypto.X509Certificate(certPem);
  const now = Date.now();
  if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) < now) {
    throw new Error(`endorser certificate expired or not yet valid: ${cert.subject}`);
  }

  const roots = [
    ...(mspConfig?.rootCerts || []),
    ...(mspConfig?.intermediateCerts || []),
  ].map(normalizeCertMaybe).filter(Boolean);

  if (roots.length === 0) {
    throw new Error(`MSP ${mspConfig?.id || '<unknown>'} has no root certificates loaded`);
  }

  return roots.some((rootPem) => {
    try {
      const root = new crypto.X509Certificate(rootPem);
      return cert.verify(root.publicKey) || normalizePem(certPem) === normalizePem(rootPem);
    } catch (_error) {
      return false;
    }
  });
}

function fallbackMspConfig(mspid) {
  const projectRoot = process.env.PROJECT_ROOT || '/app';
  const configuredPath = process.env.FABRIC_MSP_ROOT_CERT_PATH;
  const defaultPath = path.join(projectRoot, 'fabric-network', 'runtime', 'organizations',
    'peerOrganizations', 'org1.example.com', 'msp', 'cacerts',
    'ca.org1.example.com-cert.pem');
  const certPath = configuredPath || defaultPath;
  if (mspid !== 'Org1MSP' || !fs.existsSync(certPath)) return null;
  return {
    id: mspid,
    rootCerts: [fs.readFileSync(certPath, 'utf8')],
    intermediateCerts: [],
  };
}

function verifyProposalEndorsement({ proposalResponse, channel }) {
  if (!proposalResponse?.endorsement) {
    throw new Error('Fabric proposal response has no endorsement');
  }

  const endorsement = proposalResponse.endorsement;
  const serializedIdentity = msp.SerializedIdentity.decode(endorsement.endorser);
  const endorserMSPID = serializedIdentity.mspid;
  const endorserCert = normalizePem(Buffer.from(serializedIdentity.id_bytes).toString('utf8'));
  const mspConfig = channel.getMsp(endorserMSPID) || fallbackMspConfig(endorserMSPID);
  if (!mspConfig) {
    throw new Error(`endorser MSP not found in channel config: ${endorserMSPID}`);
  }
  if (!certificateIsIssuedByAnyRoot(endorserCert, mspConfig)) {
    throw new Error(`endorser certificate is not trusted by MSP ${endorserMSPID}`);
  }

  const signedBytes = Buffer.concat([
    Buffer.from(proposalResponse.payload || []),
    Buffer.from(endorsement.endorser || []),
  ]);
  const verifier = crypto.createVerify('sha256');
  verifier.update(signedBytes);
  verifier.end();
  const signatureOk = verifier.verify(endorserCert, Buffer.from(endorsement.signature || []));
  if (!signatureOk) {
    throw new Error(`invalid Fabric endorsement signature from ${endorserMSPID}`);
  }

  return {
    endorserMSPID,
    endorserCert,
    signature: Buffer.from(endorsement.signature).toString('hex'),
  };
}

function buildHFsvBindingHash({ viewAddress, requestID, nonce, payloadHash }) {
  return hashJson({
    viewAddress,
    requestID,
    nonce: Number(nonce),
    payloadHash,
  });
}

function evaluatePolicy({ policy, endorsedMSPIDs }) {
  const uniqueMSPIDs = [...new Set(endorsedMSPIDs)];
  const required = policy.requiredOrgs || [];
  if (policy.rule === 'AND') {
    return required.every((org) => uniqueMSPIDs.includes(org));
  }
  if (policy.rule === 'OR') {
    return required.some((org) => uniqueMSPIDs.includes(org));
  }
  if (policy.rule === 'THRESHOLD') {
    const matched = required.filter((org) => uniqueMSPIDs.includes(org)).length;
    return matched >= Number(policy.threshold || required.length);
  }
  throw new Error(`unsupported Fabric h-FSV policy rule: ${policy.rule}`);
}

async function withFabricGateway(fn) {
  const projectRoot = process.env.PROJECT_ROOT || '/app';
  const profilePath = process.env.FABRIC_CONNECTION_PROFILE ||
    path.join(projectRoot, 'fabric-network', 'connection-org1.docker.json');
  const walletPath = process.env.FABRIC_WALLET_PATH ||
    path.join(projectRoot, 'fabric-network', 'wallet');
  const identity = process.env.FABRIC_IDENTITY || 'appUser';

  const ccp = fs.readJsonSync(profilePath);
  const wallet = await Wallets.newFileSystemWallet(walletPath);
  const gateway = new Gateway();
  await gateway.connect(ccp, {
    wallet,
    identity,
    discovery: { enabled: false, asLocalhost: process.env.FABRIC_AS_LOCALHOST === 'true' },
  });
  try {
    return await fn(gateway);
  } finally {
    gateway.disconnect();
  }
}

async function queryFabricBlockByTxID(txId, channelID) {
  return withFabricGateway(async (gateway) => {
    const network = await gateway.getNetwork(channelID);
    const qscc = network.getContract('qscc');
    const blockBytes = await qscc.evaluateTransaction('GetBlockByTxID', channelID, txId);
    return Buffer.from(blockBytes);
  });
}

async function fetchEndorsedHFsv({ gateway, ref, policy, requestID, nonce }) {
  const network = await gateway.getNetwork(ref.channelID);
  const channel = network.getChannel();
  const contract = network.getContract(ref.chaincodeName);
  const transaction = contract.createTransaction(ref.queryFunction);
  const targets = channel.getEndorsers();
  if (targets.length === 0) {
    throw new Error(`no Fabric endorsing peers available on channel ${ref.channelID}`);
  }

  const queryProposal = channel.newQuery(ref.chaincodeName);
  queryProposal.build(transaction.identityContext, {
    fcn: ref.queryFunction,
    args: ref.queryArgs || [requestID],
    generateTransactionId: false,
  });
  queryProposal.sign(transaction.identityContext);
  const proposalResponse = await queryProposal.send({
    targets,
    requestTimeout: Number(process.env.HFSV_QUERY_TIMEOUT_MS || 30000),
  });
  if (proposalResponse.errors?.length) {
    const errors = proposalResponse.errors.map((e) => `${e.connection?.name || '<peer>'}: ${e.message}`).join('; ');
    throw new Error(`h-FSV query failed on Fabric peers: ${errors}`);
  }

  const successfulResponses = (proposalResponse.responses || [])
    .filter((response) => response.endorsement && Number(response.response?.status) === 200);
  if (successfulResponses.length === 0) {
    throw new Error('h-FSV query returned no endorsed peer responses');
  }

  const firstPayloadBytes = getTransactionResponsePayload(successfulResponses[0]);
  const payloadText = firstPayloadBytes.toString('utf8');
  const payload = JSON.parse(payloadText);
  const payloadHash = buildFabricSourceRecordHash(payload);
  const signedPayloadHash = buildHFsvBindingHash({
    viewAddress: ref.viewAddress,
    requestID,
    nonce,
    payloadHash,
  });

  const endorsements = [];
  for (const response of successfulResponses) {
    const peerPayload = getTransactionResponsePayload(response);
    if (!peerPayload.equals(firstPayloadBytes)) {
      throw new Error(`Fabric peer ${response.connection?.name || '<peer>'} returned a divergent h-FSV payload`);
    }
    const verified = verifyProposalEndorsement({ proposalResponse: response, channel });
    endorsements.push({
      peer: response.connection?.name || '',
      endorserMSPID: verified.endorserMSPID,
      endorserCert: verified.endorserCert,
      signature: verified.signature,
      signedPayloadHash,
    });
  }

  const allowedQuery = policy.allowedQueryFunctions || [];
  if (!allowedQuery.includes(ref.queryFunction)) {
    throw new Error(`query function not allowed by h-FSV policy: ${ref.queryFunction}`);
  }
  if (!evaluatePolicy({ policy, endorsedMSPIDs: endorsements.map((e) => e.endorserMSPID) })) {
    throw new Error(`h-FSV endorsements do not satisfy policy ${policy.policyID}`);
  }

  return {
    viewMeta: {
      viewAddress: ref.viewAddress,
      channelID: ref.channelID,
      chaincodeName: ref.chaincodeName,
      queryFunction: ref.queryFunction,
      queryArgs: ref.queryArgs || [requestID],
      requestID,
      nonce: Number(nonce),
    },
    payload,
    payloadHash,
    endorsements,
  };
}

function validateHXMsgEnvelope({ hxmsg, ref, policy }) {
  if (hxmsg.source.chainType !== ChainType.FABRIC) {
    throw new Error('h-FSV adapter requires source.chainType = Fabric');
  }
  if (hxmsg.sourceRef.refType !== RefType.FABRIC_VIEW) {
    throw new Error('h-FSV adapter requires sourceRef.refType = FABRIC_VIEW');
  }
  if (hxmsg.verification.verificationMethod !== VerificationMethod.H_FSV) {
    throw new Error('h-FSV adapter requires verificationMethod = H_FSV');
  }
  if (hxmsg.verification.policyRef.policyType !== PolicyType.FABRIC_ENDORSEMENT) {
    throw new Error('h-FSV adapter requires policyType = FABRIC_ENDORSEMENT');
  }
  if (hashJson(policy).toLowerCase() !== hxmsg.verification.policyRef.policyHash.toLowerCase()) {
    throw new Error('h-FSV policyHash mismatch');
  }
  if (ref.channelID !== policy.channelID || ref.chaincodeName !== policy.chaincodeName) {
    throw new Error('sourceRef does not match h-FSV policy channel/chaincode');
  }
}

function validatePayloadBinding({ hxmsg, ref, hfsv }) {
  const record = hfsv.payload;
  const requestID = hxmsg.header.requestID;
  if (hfsv.viewMeta.viewAddress !== ref.viewAddress) throw new Error('h-FSV viewAddress mismatch');
  if (hfsv.viewMeta.requestID !== requestID) throw new Error('h-FSV requestID mismatch');
  if (Number(hfsv.viewMeta.nonce) !== Number(hxmsg.header.nonce)) throw new Error('h-FSV nonce mismatch');
  if (record.requestID !== requestID) throw new Error('Fabric state requestID mismatch');
  if (record.sourceTxID !== hxmsg.txId) throw new Error('Fabric state sourceTxID mismatch');
  if (Number(record.nonce) !== Number(hxmsg.header.nonce)) throw new Error('Fabric state nonce mismatch');
  if (Number(record.expireAt) !== Number(hxmsg.header.expireAt)) throw new Error('Fabric state expireAt mismatch');
  if (record.status !== 'COMMITTED') throw new Error(`Fabric state status is not COMMITTED: ${record.status}`);
  if (hfsv.payloadHash.toLowerCase() !== hxmsg.payloadBinding.sourcePayloadHash.toLowerCase()) {
    throw new Error('sourcePayloadHash mismatch');
  }
  if (String(record.callDataHash).toLowerCase() !== hxmsg.targetAction.callDataHash.toLowerCase()) {
    throw new Error('callDataHash mismatch');
  }
  if (String(record.targetObject).toLowerCase() !== hxmsg.targetAction.targetObject.toLowerCase()) {
    throw new Error('targetObject mismatch');
  }
  if (String(record.functionSelector).toLowerCase() !== hxmsg.targetAction.functionSelector.toLowerCase()) {
    throw new Error('functionSelector mismatch');
  }
  if (String(record.receiver).toLowerCase() !== hxmsg.targetAction.receiver.toLowerCase()) {
    throw new Error('receiver mismatch');
  }
  if (String(record.businessPayloadHash).toLowerCase() !== hxmsg.payloadBinding.businessPayloadHash.toLowerCase()) {
    throw new Error('businessPayloadHash mismatch');
  }
  if (record.businessPayload && hxmsg.feedback) {
    const expectedAck = Boolean(record.businessPayload.requireAck);
    if (Boolean(hxmsg.feedback.required) !== expectedAck) {
      throw new Error('feedback.required mismatch');
    }
  }
}

async function verifyHFsv({ hxmsg, helperData = {} }) {
  const ref = decodeJsonRef(hxmsg.sourceRef.encodedRef);
  const computedRefHash = hashBytes(hxmsg.sourceRef.encodedRef);
  if (computedRefHash.toLowerCase() !== hxmsg.sourceRef.refHash.toLowerCase()) {
    throw new Error('sourceRef.refHash mismatch');
  }
  if (ref.queryFunction !== 'QueryCrosschainEvent') {
    throw new Error(`unsupported Fabric queryFunction: ${ref.queryFunction}`);
  }
  const requestID = hxmsg.header.requestID;
  if (ref.queryArgs?.[0] !== requestID) {
    throw new Error('Fabric sourceRef requestID mismatch');
  }

  const policy = buildDefaultFabricHFsvPolicy({
    channelID: ref.channelID,
    chaincodeName: ref.chaincodeName,
  });
  validateHXMsgEnvelope({ hxmsg, ref, policy });

  const hfsv = await withFabricGateway((gateway) => fetchEndorsedHFsv({
    gateway,
    ref,
    policy,
    requestID,
    nonce: hxmsg.header.nonce,
  }));
  validatePayloadBinding({ hxmsg, ref, hfsv });

  const expectedWriteKey = ref.expectedStateKey;
  const blockBytes = await queryFabricBlockByTxID(hfsv.payload.sourceTxID, ref.channelID);
  const txVerification = verifyFabricBlockContainsTx({
    blockBytes,
    expectedTxId: hfsv.payload.sourceTxID,
    expectedBlockNumber: hxmsg.srcHeight,
    expectedWriteKey,
  });

  return {
    ok: true,
    adapter: 'fabric-hfsv',
    requestID,
    sourceTxID: hfsv.payload.sourceTxID,
    sourcePayloadHash: hfsv.payloadHash,
    blockNumber: Number(hxmsg.srcHeight),
    blockHash: txVerification.blockHash,
    txIndex: txVerification.index,
    validatedWriteKey: expectedWriteKey,
    policyID: hxmsg.verification.policyRef.policyID,
    policyRule: policy.rule,
    endorsedMSPIDs: [...new Set(hfsv.endorsements.map((e) => e.endorserMSPID))],
    endorsementCount: hfsv.endorsements.length,
    endorsedPeers: hfsv.endorsements.map((e) => e.peer),
    hFSV: {
      viewMeta: hfsv.viewMeta,
      payloadHash: hfsv.payloadHash,
      endorsementSummaries: hfsv.endorsements.map((e) => ({
        peer: e.peer,
        endorserMSPID: e.endorserMSPID,
        signedPayloadHash: e.signedPayloadHash,
      })),
    },
  };
}

module.exports = {
  adapterID: 'tee-adapter-fabric-hfsv-v1',
  sourceChainType: ChainType.FABRIC,
  verificationMethod: VerificationMethod.H_FSV,
  verifySourceFact: verifyHFsv,
  verifyHFsv,
};
