const fs = require('fs-extra');
const path = require('path');

const runtimeDir = path.join(__dirname, '..', 'runtime');

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

module.exports = {
  runtimeDir,
  ensureRuntime,
  readJSON,
  writeJSON,
};
