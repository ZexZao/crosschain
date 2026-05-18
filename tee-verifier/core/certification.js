const { ethers } = require('ethers');
const { ChainType, computeHXMsgDigest, computeHXMsgDeliveryDigest } = require('../../shared/hxmsg');

function buildCertification({ hxmsg, privateKey, verifiedAt }) {
  const wallet = new ethers.Wallet(privateKey);
  const hmsgDigest = hxmsg.hmsgDigest || computeHXMsgDigest(hxmsg);
  hxmsg.hmsgDigest = hmsgDigest;
  const signsDeliveryDigest = Number(hxmsg.target?.chainType) === ChainType.EVM;
  const signingDigest = signsDeliveryDigest ? computeHXMsgDeliveryDigest(hxmsg) : hmsgDigest;
  const signature = wallet.signingKey.sign(signingDigest).serialized;
  return {
    requestID: hxmsg.header.requestID,
    hmsgDigest,
    signingDigest,
    signatureDigestType: signsDeliveryDigest ? 'deliveryDigest' : 'hmsgDigest',
    teeAddress: wallet.address,
    verifiedAt: verifiedAt || Math.floor(Date.now() / 1000),
    signature,
  };
}

module.exports = { buildCertification };
