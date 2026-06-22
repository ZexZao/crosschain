const { ethers } = require('ethers');
const { FeedbackType, AtomicityMode, CommitmentType } = require('./constants');
const { normalizeFeedback, normalizeAtomicity } = require('./hash');

function assertFeedbackInvariant(feedback = {}) {
  const normalized = normalizeFeedback(feedback);
  if (!normalized.required) {
    if (normalized.expectedMsgType !== FeedbackType.NONE) throw new Error('feedback expectedMsgType must be NONE when feedback is disabled');
    if (normalized.timeout !== 0) throw new Error('feedback timeout must be zero when feedback is disabled');
    if (normalized.callbackRefHash !== ethers.ZeroHash) throw new Error('feedback callbackRefHash must be zero when feedback is disabled');
  }
  return normalized;
}

function assertAtomicityInvariant(atomicity = {}, feedback = {}) {
  const normalized = normalizeAtomicity(atomicity);
  const normalizedFeedback = normalizeFeedback(feedback);
  if (normalized.required) {
    if (!normalizedFeedback.required || normalizedFeedback.expectedMsgType !== FeedbackType.RESPONSE) {
      throw new Error('atomic h-xmsg requires RESPONSE feedback');
    }
    if (normalized.failureActionHash === ethers.ZeroHash) throw new Error('atomicity failureActionHash is required');
    if (normalized.challengeWindow <= 0) throw new Error('atomicity challengeWindow must be positive');
  } else {
    if (normalized.mode !== AtomicityMode.NONE) throw new Error('atomicity mode must be NONE when disabled');
    if (normalized.commitmentType !== CommitmentType.NONE) throw new Error('atomicity commitmentType must be NONE when disabled');
    if (normalized.commitmentRefHash !== ethers.ZeroHash) throw new Error('atomicity commitmentRefHash must be zero when disabled');
    if (normalized.successActionHash !== ethers.ZeroHash) throw new Error('atomicity successActionHash must be zero when disabled');
    if (normalized.failureActionHash !== ethers.ZeroHash) throw new Error('atomicity failureActionHash must be zero when disabled');
    if (normalized.challengeWindow !== 0) throw new Error('atomicity challengeWindow must be zero when disabled');
  }
  return normalized;
}

function assertHXMsgInvariants(hxmsg) {
  assertFeedbackInvariant(hxmsg.feedback);
  assertAtomicityInvariant(hxmsg.atomicity, hxmsg.feedback);
}

module.exports = {
  assertFeedbackInvariant,
  assertAtomicityInvariant,
  assertHXMsgInvariants,
};
