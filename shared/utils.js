const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('ethers');

const runtimeDir = path.join(__dirname, '..', 'runtime');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function keccakHex(data) {
  return ethers.keccak256(data);
}

function ensureRuntime() {
  fs.ensureDirSync(runtimeDir);
}

function readJSON(relPath, defaultValue = null) {
  const p = path.join(runtimeDir, relPath);
  if (!fs.existsSync(p)) return defaultValue;
  return fs.readJsonSync(p);
}

function writeJSON(relPath, value) {
  ensureRuntime();
  const p = path.join(runtimeDir, relPath);
  fs.writeJsonSync(p, value, { spaces: 2 });
  return p;
}

function nowMs() {
  return Date.now();
}

function bytes32FromText(text) {
  return ethers.keccak256(ethers.toUtf8Bytes(text));
}

module.exports = {
  runtimeDir,
  sha256Hex,
  keccakHex,
  ensureRuntime,
  readJSON,
  writeJSON,
  nowMs,
  bytes32FromText,
};
