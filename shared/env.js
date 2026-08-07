const fs = require('fs');
const path = require('path');

const DEFAULT_ENV_PATH = path.join(__dirname, '..', '.env');

function parseDotEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) values[key] = value;
  }
  return values;
}

function readDotEnvValue(key, filePath = DEFAULT_ENV_PATH) {
  if (!fs.existsSync(filePath)) return undefined;
  return parseDotEnv(fs.readFileSync(filePath, 'utf8'))[key];
}

function loadDotEnv(filePath = DEFAULT_ENV_PATH) {
  if (!fs.existsSync(filePath)) return;
  const values = parseDotEnv(fs.readFileSync(filePath, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

module.exports = { loadDotEnv, parseDotEnv, readDotEnvValue };
