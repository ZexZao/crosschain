const { ethers } = require('ethers');
const { computeHXMsgDigest } = require('../../shared/hxmsg');

function buildCertification({ hxmsg, privateKey, verifiedAt }) {
  const wallet = new ethers.Wallet(privateKey);
  const hmsgDigest = hxmsg.hmsgDigest || computeHXMsgDigest(hxmsg);
  const signature = wallet.signingKey.sign(hmsgDigest).serialized;
  return {
    requestID: hxmsg.header.requestID,
    hmsgDigest,
    teeAddress: wallet.address,
    verifiedAt: verifiedAt || Math.floor(Date.now() / 1000),
    signature,
  };
}

module.exports = { buildCertification };
